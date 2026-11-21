// Assistente IA local (seções 8, 37).
// Este módulo responde perguntas usando SOMENTE dados reais do estado — nunca inventa valores.
// Ele diferencia dados reais de estimativas/projeções no texto das respostas.
//
// A integração remota NÃO é pendente: `POST /api/ai/chat` existe nos dois
// backends (dev e Vercel), recebe SÓ contexto agregado (`buildAiContext`, nunca
// a base bruta) e a chave vive apenas no servidor. O que este módulo faz é o
// outro lado: responder localmente tudo que o app sabe com certeza, para que a
// pergunta factual nunca dependa de rede nem de modelo.

import { AppState, ParsedAction, RecurringExpense } from '../models/types'
import { validateAction, isValidationFailure } from '../assistant/contracts'
import type { AssistantErrorCode } from '../assistant/contracts'
import { buildCapabilities } from '../assistant/capabilities'
import type { OrchestratorInput } from '../assistant/orchestrator'
import type { RemoteConversationContext } from '../assistant/conversation/remoteContext'
import {
  addDays, dueLabel, fmtBRL, fmtNum, fromISO, monthKey, todayISO, toISO, daysInMonth, parseMoney, daysBetween } from '../utils/format'
import { normalizeName, promptSafe, sentenceCase } from '../utils/text'
import { MAX_COMPOSE_FACTS } from '../assistant/grounding'
import { MARGEM_EMPATE } from '../assistant/query/answer'
import {
  analyzeRide, avgDailyProfit, balanceOutlook, balanceOutlookText, cashObligationsUntil, dailySeries, currentBalance, dailyGoal, fuelEfficiency, kmCost, monthlySavingGoal, upcomingIncomes,
  monthStats, periodStats, prevMonthStats, todayStats, upcomingBills, weekStats, monthlyProjections, budgetUsage,
  describeRecurrence, occurrencesBetween, recurrenceStep, recurringActiveOn, recurringOccurrenceState, savedThisMonth, monthForecast,
} from './calc'
import type { CashObligation } from './calc'
import {
  alvoDaReserva, diaDaSemanaPedido, mesesAtePrazo, pedeFimDoMes, guardarEsteMes, pedeDividaTotal, pedeFimDoParcelamento, pedeListaDeParcelamentos, pedeQuantoPossoGastar, pedeLimite, pedeMaiorParcela, pedeContaQueAperta, pedeContasAPagar, pedeContasFixas, pedeReservaDeCaixa, pedeResumoDoDia, pedeSobraSemCombustivel, pedeTotalGuardado, perguntaDeConta,
  pedeAntecipacaoDeFatura, perguntaDeFatura, perguntaDeManutencao,
  planoDeGuardar, prazoDasContas, retiraDaReserva,
} from '../assistant/cashQuestions'
import type { PerguntaDeConta, PerguntaDeFatura, PlanoDeGuardar } from '../assistant/cashQuestions'
import { describeAction, parseNaturalFull, SAQUE } from './nlp'
import { driverInsight } from '../assistant/driverInsights'
import { answerVehicleCost } from '../assistant/vehicleCost'
import { avaliacaoDoDia } from '../assistant/dayReview'
import { respostaDeChegada, respostaDeProximaEntrada } from '../assistant/arrival'
import { readInvoiceReference } from '../assistant/invoicePayment'
import { findAllDates } from '../assistant/dates'
import { currentMonthToDate, parsePeriod } from '../assistant/query/period'
import { adaptiveEnabled, buildPersonalModel } from '../assistant/personalModel'
import { catById } from '../data/categories'
import { isDriver } from './profile'
import {
  activeCards, cardInvoice, cardOutstanding, cardsOverview, currentInvoice, monthlyCommitments, activePlans,
  planProgress, overdueInstallments, upcomingInvoices, installmentsThisMonth, hasAmbiguousLegacyCardBalance, invoiceOpenAmount, validPaymentDate,
} from './cards'
import type { CardInvoice } from './cards'

const AMBIGUOUS_BALANCE_REPLY = 'Não consigo confirmar seu saldo com segurança: há um pagamento antigo de fatura sem vínculo com as parcelas e os valores pagos excedem a fatura. Confira se os registros representam pagamentos diferentes ou o mesmo pagamento duplicado antes de usar esse saldo.'

const round2 = (v: number) => Math.round(v * 100) / 100
/** 'DD/MM' montado à mão: a forma da string do ICU muda com o aparelho. */
const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const nomeDaObrigacao = (o: CashObligation) => sentenceCase(o.name)
const somaDe = (itens: CashObligation[]) => round2(itens.reduce((a, o) => a + o.amount, 0))
const listaDeNomes = (nomes: string[]) => nomes.length < 2 ? nomes.join('')
  : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
/**
 * Conta fixa vencida sem confirmação pode ter sido paga e não marcada. Somar
 * como dívida inflava a reserva; esconder escondia um atraso real. Fica à parte.
 */
function semConfirmacao(itens: CashObligation[]): string {
  const sem = itens.filter(o => o.unconfirmed)
  if (!sem.length) return ''
  const nomes = listaDeNomes([...new Set(sem.map(nomeDaObrigacao))])
  return `${sem.length === 1 ? 'Há 1 vencimento de conta fixa' : `Há ${sem.length} vencimentos de contas fixas`} sem confirmação — ${nomes}, somando ${fmtBRL(somaDe(sem))}. Se ainda não pagou, some esse valor; se já pagou, confirme na tela inicial.`
}
const linhasDeObrigacao = (itens: CashObligation[]) => itens
  .map(o => `• ${nomeDaObrigacao(o)}: ${fmtBRL(o.amount)} — ${dueLabel(o.inDays).toLowerCase()}`)
  .join('\n')

export interface AiReply {
  text: string
  actions?: ParsedAction[] // ações que precisam de confirmação
  /** Opções de desambiguação — nada é registrado até o usuário escolher e confirmar. */
  choices?: { label: string; actions: ParsedAction[] }[]
  engine?: 'remote' | 'local'
  handled?: boolean // true = o motor local respondeu com certeza (não precisa da IA remota)
}

// ---------- Contexto enviado ao chat remoto ----------
//
// O MÍNIMO para o trabalho que sobrou para o modelo, e nada do histórico. Duas
// camadas:
//
//   · SEMPRE: perfil, categorias (é delas que o servidor monta o prompt e valida
//     a categoria devolvida), nomes de cartão e de meta (para a ação proposta
//     ser válida) e, com o aprendizado ligado, os IDs das categorias mais usadas
//     (regra 44);
//   · SÓ QUANDO O TRECHO É PERGUNTA OU PEDIDO ABERTO (`aggregates`): somas do
//     dia, da semana e dos meses, metas, orçamentos, faturas, parcelas e
//     projeção — tudo AGREGADO.
//
// Fora, sempre: nome do usuário, saldo em conta e o que deriva dele, lista de
// parcelamentos com a descrição de cada compra, nome e valor de cada conta ou
// entrada prevista, veículo e manutenções. Pergunta sobre saldo ou sobre um
// lançamento é respondida no aparelho. O servidor aplica a MESMA lista
// (`sanitizeChatContext`), então um APK antigo que ainda mande o formato velho
// não vaza por lá.
export function buildAiContext(s: AppState, opts: { aggregates?: boolean } = {}) {
  const t = todayISO()
  const r2 = (v: number) => Math.round(v * 100) / 100
  const driverMode = isDriver(s.settings)

  const base: Record<string, any> = {
    perfil: s.settings.profile,
    // Categorias REAIS deste usuário (inclusive personalizadas). É a partir
    // desta lista que o prompt remoto é montado e que a categoria devolvida pelo
    // modelo é validada — nunca de uma lista escrita à mão no prompt.
    categorias: s.categories
      .filter(c => !c.archived)
      .map(c => ({ id: c.id, name: c.name, type: c.type })),
    cartoes: activeCards(s).map(c => ({ nome: c.name })),
    metasDeCompra: s.goals.filter(g => !g.done).map(g => ({ nome: g.name })),
  }

  // Preferência aprendida, no MÍNIMO agregado possível: só os IDs de categoria
  // que ele mais usa, para o modelo remoto propor a categoria certa em vez da
  // que a lista genérica sugeriria. Nada além disso sai daqui — nem
  // estabelecimento, nem cliente, nem descrição, nem grafia, nem journal, nem
  // um único valor de lançamento. E não sai nada se ele desligou o aprendizado.
  if (adaptiveEnabled(s)) {
    const model = buildPersonalModel(s, t)
    if (model.sample.total) {
      base.categoriasQueMaisUso = {
        despesas: model.topCategories('expense', 4).map(c => c.id),
        receitas: model.topCategories('income', 3).map(c => c.id),
      }
    }
  }

  if (!opts.aggregates) return base

  const stats = (x: ReturnType<typeof todayStats>) => (driverMode
    ? {
        receitas: r2(x.income), despesas: r2(x.expense), lucro: r2(x.profit),
        km: r2(x.km), viagens: x.trips, horas: r2(x.hours),
        lucroPorKm: r2(x.netPerKm), lucroPorHora: r2(x.profitPerHour), mediaPorViagem: r2(x.perTrip),
      }
    : { receitas: r2(x.income), despesas: r2(x.expense), lucro: r2(x.profit) })
  const soma = (xs: { amount: number }[]) => r2(xs.reduce((a, b) => a + b.amount, 0))
  const contas = upcomingBills(s, 15)
  const entradas = upcomingIncomes(s, 31)

  Object.assign(base, {
    hoje: stats(todayStats(s)),
    ultimos7dias: stats(weekStats(s)),
    esteMes: stats(monthStats(s)),
    mesAnterior: stats(prevMonthStats(s)),
    metasDeCompra: s.goals.filter(g => !g.done).map(g => ({ nome: g.name, alvo: g.target, guardado: g.saved, prazo: g.deadline || undefined })),
    orcamentos: s.budgets.map(b => ({ categoria: b.category, limiteMensal: b.limit })),
    // Quantas e quanto, nunca QUAIS: o nome de cada conta ("Aluguel Casa 1") é
    // texto do usuário, e o valor de cada uma é um lançamento previsto.
    contasPrevistas: { quantidade: contas.length, total: soma(contas), emDias: 15 },
    entradasPrevistas: { quantidade: entradas.length, total: soma(entradas), emDias: 31 },
  })

  // Cartões e parcelamentos — só entra no contexto se o usuário usa a área.
  const ov = cardsOverview(s)
  if (ov.hasData) {
    base.cartoes = activeCards(s).map(c => {
      const inv = currentInvoice(s, c)
      return {
        nome: c.name,
        faturaAtual: { total: r2(inv.total), pago: r2(inv.paid), pendente: r2(inv.pending), vencimento: inv.dueDate, situacao: inv.status },
        limiteTotal: r2(c.limit || 0),
        proximasFaturas: upcomingInvoices(s, c, 4).slice(1).map(f => ({ mes: f.monthKey, total: r2(f.total) })),
      }
    })
    // Sem a lista: a descrição de cada compra parcelada é texto do usuário.
    base.parcelamentos = {
      ativos: ov.activePlanCount,
      dividaRestante: r2(ov.totalDebt),
      parcelasDesteMes: r2(ov.installmentsThisMonth),
      parcelasProximoMes: r2(ov.installmentsNextMonth),
      atrasadas: { quantidade: ov.overdueCount, valor: r2(ov.overdueAmount) },
      limiteDisponivel: r2(ov.availableLimit),
    }
    // Sem `saldoEstimado`: é o saldo em conta projetado, e saldo não sai.
    base.projecaoProximosMeses = monthlyProjections(s, 6).map(m => ({
      mes: m.monthKey,
      entradasPrevistas: r2(m.incomes),
      contasPrevistas: r2(m.bills),
      parcelasPrevistas: r2(m.installments),
      comprometimentoPct: m.commitmentPct,
    }))
  }

  if (driverMode) {
    // Só motorista recebe km, combustível, meta diária e taxa da 99.
    const meta = dailyGoal(s)
    const custoKm = kmCost(s)
    return {
      ...base,
      taxaSaque99: s.settings.ask99Fee ? r2(s.settings.platform99Fee) : 0,
      mediaDiariaLucro30d: r2(avgDailyProfit(s)),
      metaDiaria: {
        total: r2(meta.total), base: r2(meta.base), metasPessoais: r2(meta.personal),
        deficits: r2(meta.deficit), margemSeguranca: r2(meta.margin),
      },
      custoPorKm: {
        combustivel: r2(custoKm.fuelPerKm), manutencao: r2(custoKm.maintenancePerKm),
        fixos: r2(custoKm.fixedPerKm), total: r2(custoKm.total),
        minimoRecomendado: r2(custoKm.minRecommended), confortavel: r2(custoKm.comfort),
      },
      consumoKmPorLitro: fuelEfficiency(s) ? r2(fuelEfficiency(s)!) : null,
      mediaKmDia: s.vehicle?.averageDailyKm || null,
    }
  }

  // Autônomo / CLT / outro: foco no mês e na meta de guardar.
  const mensal = monthlySavingGoal(s)
  return {
    ...base,
    metaMensalParaGuardar: {
      meta: r2(mensal.target),
      entradasDoMes: r2(mensal.income),
      despesasDoMes: r2(mensal.expense),
      resultadoLiquidoDoMes: r2(mensal.net),
      faltaParaMeta: r2(mensal.missing),
      percentualAtingido: mensal.pct,
      guardadoDeVerdade: r2(mensal.saved),
      metaAlcancada: mensal.reached,
      temSobraSuficienteParaGuardar: mensal.canReach,
    },
  }
}

// ---------- Chamada ao backend de IA (contrato v1) ----------
// A validação NÃO mora mais aqui: quem valida é `validateAction()` em
// src/assistant/contracts.ts, o MESMO código que o servidor usa. Havia antes um
// `sanitizeActions` local que não conhecia `saving` nem `origin` e descartava
// ação em silêncio — os dois problemas sumiram junto com ele.

// Em dev, o Vite serve /api/ai/chat (middleware em vite.config.ts) na mesma origem.
// Em produção (APK/PWA) aponte VITE_AI_API_URL para o backend publicado.
const AI_API_URL = import.meta.env?.VITE_AI_API_URL || '/api/ai/chat'

export interface RemoteAssistantResult {
  reply: string
  mode: string
  actions: ParsedAction[]
  clarification?: { question: string; field?: string; options?: { label: string; value: string }[] }
  rejected: { kind: string; code: AssistantErrorCode; detail?: string }[]
  contractFallback: boolean
}

/**
 * Chama o backend de IA (DeepSeek — a chave fica só no servidor) e revalida
 * TUDO no cliente antes de deixar qualquer ação chegar perto do estado.
 * Devolve null em qualquer falha, para o chamador cair no motor local.
 */
export async function askAssistantRemote(
  s: AppState, input: string,
  opts: { conversation?: RemoteConversationContext; aggregates?: boolean } = {},
): Promise<RemoteAssistantResult | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 35000)
    const res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Sem `history`: a conversa vai como ESTRUTURA (`conversation`), nunca como
      // transcrição — as respostas locais anteriores carregam descrição, valor e
      // saldo de lançamento (regra 44).
      body: JSON.stringify({
        message: input,
        context: buildAiContext(s, { aggregates: opts.aggregates }),
        conversation: opts.conversation,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = await res.json()
    const reply = String(data?.reply || '').trim()
    if (!reply) return null

    // Defesa em profundidade: o servidor já validou, mas o cliente valida de
    // novo com as capacidades REAIS deste dispositivo (categorias personalizadas,
    // cartões, perfil). Uma ação de motorista jamais passa em perfil CLT.
    const caps = buildCapabilities(s)
    const today = todayISO()
    const actions: ParsedAction[] = []
    const rejected: RemoteAssistantResult['rejected'] = Array.isArray(data?.rejected) ? data.rejected.slice(0, 12) : []
    for (const raw of Array.isArray(data?.actions) ? data.actions.slice(0, 12) : []) {
      const out = validateAction(raw, caps, today, { allowRemoteOnly: true })
      if (isValidationFailure(out)) rejected.push({ kind: String(raw?.kind || '?'), code: out.code, detail: out.detail })
      else actions.push(out.action)
    }

    return {
      reply,
      mode: typeof data?.mode === 'string' ? data.mode : 'answer',
      actions,
      clarification: data?.clarification,
      rejected,
      contractFallback: data?.contractFallback === true,
    }
  } catch {
    return null
  }
}

/**
 * A ligação do orquestrador com os dois caminhos remotos, num lugar só.
 *
 * A tela usa isto, e as invariantes de privacidade também: o que elas medem é o
 * corpo que sai DE VERDADE do aparelho, não uma reimplementação para o teste.
 */
export function remoteBridge(): Required<Pick<OrchestratorInput, 'askRemote' | 'planRemoteQuery'>> {
  return {
    askRemote: async ({ state, message, conversation, aggregates }) => {
      const r = await askAssistantRemote(state, message, { conversation, aggregates })
      return r ? { ...r, rejected: r.rejected || [] } : null
    },
    // O modelo remoto PLANEJA a consulta que o local não entendeu — e não vê
    // lançamento nenhum para isso. Quem executa o plano é o app.
    planRemoteQuery: async ({ state, message }) => askRemoteQueryPlan(state, message),
  }
}

// ---------- IA remota como PLANEJADORA e REDATORA ----------
//
// Dois usos do modelo que NAO envolvem dado nenhum do historico:
//
//   plan-query  ele traduz a pergunta num plano da Query DSL. Nao ve
//               lancamento; ve o vocabulario da DSL, as categorias e a
//               PERGUNTA. Quem procura "Ze da esquina" no historico e o
//               executor local.
//   compose     ele redige sobre FATOS ja calculados aqui. A garantia nao e o
//               prompt: e `checkGrounding()`, que confere numero a numero e
//               descarta a composicao inteira quando algo nao se sustenta.
//
// Os dois devolvem `null` em qualquer falha — a resposta local ja esta pronta e
// e ela que vai para a tela.

/** Contexto MINIMO para planejar: nada de agregado, nada de historico. */
export function planningContext(s: AppState) {
  return {
    perfil: s.settings.profile,
    categorias: s.categories.filter(c => !c.archived).map(c => ({ id: c.id, name: c.name, type: c.type })),
    cartoes: (s.cards || []).filter(c => !c.archived).map(c => ({ nome: c.name })),
    metasDeCompra: (s.goals || []).filter(g => !g.done).map(g => ({ nome: g.name })),
  }
}

async function postAi(body: unknown, timeoutMs = 20000): Promise<any | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Plano de consulta CRU vindo do modelo. Quem valida e `validateQueryPlan`. */
export async function askRemoteQueryPlan(s: AppState, input: string): Promise<any | null> {
  const data = await postAi({ task: 'plan-query', message: input, context: planningContext(s) })
  const plano = data?.queryPlan
  return plano && typeof plano === 'object' ? plano : null
}

/**
 * Agrupamentos cujo rotulo E TEXTO ESCRITO PELO USUARIO.
 *
 * "Ze da esquina", "Casa 1", "Cliente Joao" sao estabelecimento, imovel e
 * cliente — exatamente o que a regra 44 diz que nunca sai do aparelho. Nome de
 * categoria, cartao e meta ja viajam no contexto de planejamento e continuam
 * podendo viajar; descricao e origem, nao.
 */
const GRUPO_PESSOAL = new Set(['description', 'origin'])

/**
 * Redacao sobre fatos JA CALCULADOS. O chamador ainda precisa passar pelo
 * grounding — esta funcao cuida do outro lado, o que SAI do aparelho.
 *
 * A filtragem mora aqui, e nao no chamador, de proposito: um caminho futuro
 * que esqueca de filtrar nao pode virar um vazamento. Sem fato que sobreviva,
 * a funcao NAO chama o modelo — mandar so a pergunta convidaria a inventar o
 * numero, que e a unica coisa que esta camada existe para impedir.
 */
export async function askRemoteCompose(
  input: string,
  facts: { label: string; value: number; unit: string; estimated?: boolean }[],
  group?: string,
): Promise<string | null> {
  if (group && GRUPO_PESSOAL.has(group)) return null
  const seguros = facts.map(f => ({
    label: promptSafe(f.label), value: f.value, unit: f.unit, estimated: f.estimated,
  }))
  // O teto NAO e de tamanho de prompt: e o ponto onde a barreira de grounding
  // deixa de proteger. Ver `MAX_COMPOSE_FACTS`, onde a medicao esta escrita.
  if (!seguros.length || seguros.length > MAX_COMPOSE_FACTS) return null
  const data = await postAi({ task: 'compose', message: input, facts: seguros })
  const reply = typeof data?.reply === 'string' ? data.reply.trim() : ''
  return reply || null
}

const NUM = String.raw`(\d+(?:[.,]\d+)*)`
const n = (s: string) => parseMoney(s)

function periodFromText(t: string): { from: string; to: string; label: string } | null {
  // Este leitor conhece SEIS frases e caía em "últimos 7 dias" para o resto.
  // Período dito que ele não expressa devolve null, e quem chama NÃO responde:
  // "maior gasto em 90 dias" saía com os últimos 7 dias, com cara de dado real,
  // e a pergunta nunca chegava a quem sabe lê-la.
  if (/\b\d{1,4}\s*(?:dias|semanas|meses|mes|anos)\b|\bdesde\b|\bquinzena\b/.test(t)) return null
  const today = todayISO()
  if (/semana passada/.test(t)) return { from: addDays(today, -13), to: addDays(today, -7), label: 'na semana passada' }
  if (/(essa|esta|nesta|nessa)\s+semana|semana/.test(t)) return { from: addDays(today, -6), to: today, label: 'nos últimos 7 dias' }
  if (/m[eê]s passado/.test(t)) {
    const d = fromISO(today)
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1)
    const last = new Date(d.getFullYear(), d.getMonth(), 0)
    return { from: `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`, to: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`, label: 'no mês passado' }
  }
  if (/(esse|este|neste|nesse)\s+m[eê]s|m[eê]s/.test(t)) return { from: today.slice(0, 8) + '01', to: today, label: 'este mês' }
  if (/ontem/.test(t)) return { from: addDays(today, -1), to: addDays(today, -1), label: 'ontem' }
  if (/hoje/.test(t)) return { from: today, to: today, label: 'hoje' }
  // Sem período dito, o mês corrente — a mesma janela da consulta. Os últimos
  // 7 dias faziam "quanto recebi de aluguel" responder R$ 0,00 para quem
  // recebeu R$ 3.000,00 no mês, e a pergunta mudava de resposta conforme quem
  // a lia.
  return { from: today.slice(0, 8) + '01', to: today, label: 'este mês' }
}

// Motor local determinístico. Retorna handled:false SÓ no fallback genérico
// (aí sim vale tentar a IA remota). Todo o resto é resposta confiável e local.
/**
 * Abreviações de conversa que o usuário REAL digita. Sem isto, "como ta meu
 * mes" não casava nada e caía no texto genérico de ajuda — a pergunta ia parar
 * na IA remota, contra a regra de que pergunta factual é sempre local.
 */
const ABREVIACOES: [RegExp, string][] = [
  [/\bta\b/g, 'esta'], [/\btah\b/g, 'esta'], [/\bto\b/g, 'estou'], [/\btou\b/g, 'estou'],
  [/\bpra\b/g, 'para'], [/\bpro\b/g, 'para'], [/\bpq\b/g, 'porque'],
  [/\bvc\b/g, 'voce'], [/\bq\b/g, 'que'], [/\bcm\b/g, 'com'], [/\bhj\b/g, 'hoje'], [/\bhje\b/g, 'hoje'],
  [/\bontm\b/g, 'ontem'], [/\btb\b/g, 'tambem'], [/\btbm\b/g, 'tambem'],
  [/\bqnt\b/g, 'quanto'], [/\bqto\b/g, 'quanto'], [/\bqnd\b/g, 'quando'],
  [/\bmsm\b/g, 'mesmo'], [/\bdps\b/g, 'depois'], [/\bmt\b/g, 'muito'],
  [/\bgrana\b/g, 'dinheiro'], [/\bconto\b/g, 'reais'],
]

/**
 * Texto usado SÓ para reconhecer a intenção da pergunta: minúsculas, sem
 * acento e com abreviação expandida. O registro continua lendo o texto
 * ORIGINAL — aqui não se perde nada, só se ganha tolerância.
 *
 * Tirar o acento é seguro porque todo padrão do roteador já usa classe com as
 * duas formas (`m[eê]s`, `est[aá]`, `cart[ãa]o`).
 */
export function normalizeQuestion(input: string): string {
  let t = input.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '')
  for (const [re, sub] of ABREVIACOES) t = t.replace(re, sub)
  return t
}

function resolveLocal(s: AppState, input: string): AiReply {
  const t = normalizeQuestion(input)
  const driverMode = isDriver(s.settings)
  // Meta de COMPRA citada pelo NOME ganha da meta diária e da mensal. O usuário
  // tem as duas, e a palavra "meta" serve às duas — mas quem batizou a meta de
  // "Moto" e pergunta por ela espera ouvir sobre ela.
  const metaCitadaPeloNome = s.goals.some(g => !g.done && g.name?.trim()
    && t.includes(normalizeQuestion(g.name).split(' ')[0]))

  // "Quanto preciso deixar parado até dia 10": o que está CADASTRADO para sair
  // até a data, inclusive o que já venceu. Antes a frase virava o gasto do mês
  // ou uma pergunta de "qual mês?" — o próximo dia 10 é o que todo mundo entende.
  if (pedeReservaDeCaixa(t)) {
    const alvo = alvoDaReserva(t, todayISO())
    if (alvo.kind === 'missing') {
      return { text: 'Até quando você quer deixar o dinheiro separado? Me diga o dia — por exemplo, “até dia 10” — que eu somo as contas, faturas e parcelas cadastradas até lá.' }
    }
    if (alvo.kind === 'invalid') {
      return { text: `Não existe dia ${alvo.dia} no calendário. Me diga outro dia — por exemplo, “até dia 10”.` }
    }
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const todas = cashObligationsUntil(s, alvo.date)
    const certas = todas.filter(o => !o.unconfirmed)
    const ate = diaMes(alvo.date)
    const partes: string[] = []
    if (certas.length) {
      partes.push(`Até ${ate}, deixe pelo menos ${fmtBRL(somaDe(certas))} para o que está cadastrado:\n\n${linhasDeObrigacao(certas)}`)
    } else {
      partes.push(`Nada cadastrado tem vencimento certo até ${ate}.`)
    }
    const pendentes = semConfirmacao(todas)
    if (pendentes) partes.push(pendentes)
    partes.push('Gastos do dia a dia, como mercado e combustível, não estão cadastrados e ficam fora dessa conta.')
    if (certas.length) {
      const saldo = currentBalance(s)
      const total = somaDe(certas)
      partes.push(saldo >= total - 0.009
        ? `Seu saldo de ${fmtBRL(saldo)} cobre esse valor e sobram ${fmtBRL(round2(saldo - total))}.`
        : `Seu saldo é ${fmtBRL(saldo)} — faltam ${fmtBRL(round2(total - saldo))} para cobrir.`)
    }
    return { text: partes.join('\n\n') }
  }

  // "Quanto eu tenho guardado": o saldo em conta respondia no lugar (a palavra
  // "tenho" puxava o handler de saldo) e "minha reserva tá em quanto" procurava
  // DESPESA na categoria reserva. Guardado é reserva (`saving`) + metas.
  if (pedeTotalGuardado(t)) {
    const depositos = s.transactions.filter(x => x.type === 'saving')
    const reserva = round2(depositos.reduce((a, x) => a + x.amount, 0))
    const metas = s.goals.filter(g => g.saved > 0)
    const emMetas = round2(metas.reduce((a, g) => a + g.saved, 0))
    if (!reserva && !emMetas) {
      return { text: 'Você ainda não registrou nada guardado. Diga, por exemplo, "guardei 200 na reserva" que eu lanço.' }
    }
    const linhaReserva = `${fmtBRL(reserva)} (${depositos.length} ${depositos.length === 1 ? 'depósito' : 'depósitos'})`
    const linhaMetas = `${fmtBRL(emMetas)} — ${metas.map(g => `${sentenceCase(g.name)} ${fmtBRL(g.saved)}`).join(', ')}`
    const separado = 'O saldo em conta é separado: o que vai para a reserva não sai dele.'
    // Quem pergunta pela RESERVA quer o número dela primeiro; metas vêm à parte.
    if (/\breserva\b|\bpoupanca\b/.test(t)) {
      return { text: [`Sua reserva tem ${fmtBRL(reserva)}, em ${depositos.length} ${depositos.length === 1 ? 'depósito' : 'depósitos'} (dado real).`, emMetas ? `Nas metas, à parte: ${linhaMetas}.` : '', separado].filter(Boolean).join('\n\n') }
    }
    const partes: string[] = []
    if (reserva) partes.push(`Na reserva: ${linhaReserva}.`)
    if (emMetas) partes.push(`Nas metas: ${linhaMetas}.`)
    const total = reserva && emMetas ? `Guardado ao todo: ${fmtBRL(round2(reserva + emMetas))} (dado real).\n\n` : ''
    return { text: `${total}${partes.join('\n')}\n\n${separado}` }
  }

  // "Tirei 300 da reserva": não existe lançamento de retirada. O texto genérico
  // de ajuda deixava parecer que a frase não foi entendida.
  if (retiraDaReserva(t)) {
    return { text: 'Ainda não registro retirada da reserva: ela é a soma do que você guardou, e retirar não tem um lançamento próprio no app. Se o depósito foi lançado errado, corrija ou apague em Movimentações.' }
  }
  // "Tirei 100 da viagem": retirar de META também não tem ação no chat, mas a
  // tela tem ("Já guardado" no Editar). Caía na ajuda genérica.
  const retiradaDeMeta = t.match(new RegExp(String.raw`\b(?:tirei|retirei|saquei|resgatei|usei|peguei)\s+(?:r\$)?\s*${NUM}`))
  const metaDaRetirada = retiradaDeMeta ? metaCitada(s, t) : undefined
  if (retiradaDeMeta && metaDaRetirada) {
    const valor = n(retiradaDeMeta[1])
    const fica = round2(Math.max(metaDaRetirada.saved - valor, 0))
    return { text: `Retirar dinheiro de uma meta pelo chat ainda não dá. Na tela: Metas → ${metaDaRetirada.name} → Editar, e mude "Já guardado" de ${fmtBRL(metaDaRetirada.saved)} para ${fmtBRL(fica)}.` }
  }

  // "Qual conta está me apertando?" pede uma comparação, não uma lista crua.
  // Fatura ou parcela vencida aperta mais que qualquer conta futura; depois vêm
  // valor e prazo, que são critérios diferentes e por isso aparecem os dois.
  if (pedeContaQueAperta(t)) {
    const todas = cashObligationsUntil(s, addDays(todayISO(), 30))
    const pendentes = semConfirmacao(todas)
    const atrasadas = todas.filter(o => o.inDays < 0 && !o.unconfirmed)
    const futuras = todas.filter(o => o.inDays >= 0)
    if (!atrasadas.length && !futuras.length) {
      return { text: ['Nenhuma conta, fatura ou parcela cadastrada vence nos próximos 30 dias, e nada está atrasado.', pendentes].filter(Boolean).join('\n\n') }
    }
    const partes: string[] = []
    if (atrasadas.length === 1) {
      partes.push(`O que mais aperta é o que já venceu: ${nomeDaObrigacao(atrasadas[0])}, ${fmtBRL(atrasadas[0].amount)} (${dueLabel(atrasadas[0].inDays).toLowerCase()}).`)
    } else if (atrasadas.length > 1) {
      partes.push(`O que mais aperta é o que já venceu: ${atrasadas.length} itens atrasados somando ${fmtBRL(somaDe(atrasadas))}.\n\n${linhasDeObrigacao(atrasadas)}`)
    }
    if (futuras.length) {
      const maior = Math.max(...futuras.map(o => o.amount))
      const topo = futuras.filter(o => Math.abs(o.amount - maior) < 0.005)
      const proxima = futuras[0]
      const quando = (o: CashObligation) => dueLabel(o.inDays).toLowerCase()
      const abre = atrasadas.length ? 'Nos próximos 30 dias, ' : ''
      if (topo.length > 1) {
        partes.push(`${abre}${topo.length === futuras.length ? 'as contas empatam' : `${topo.length} empatam como as maiores`} em ${fmtBRL(maior)}: ${topo.map(o => `${nomeDaObrigacao(o)} (${quando(o)})`).join(', ')}.`)
      } else {
        partes.push(`${abre}${abre ? 'a' : 'A'} maior é ${nomeDaObrigacao(topo[0])}: ${fmtBRL(topo[0].amount)} (${quando(topo[0])}).`)
      }
      if (!topo.includes(proxima)) {
        partes.push(`A próxima a vencer é ${nomeDaObrigacao(proxima)}: ${fmtBRL(proxima.amount)} (${quando(proxima)}).`)
      } else if (topo.length === 1 && futuras.length > 1) {
        partes.push('Ela também é a próxima a vencer.')
      }
    }
    if (pendentes) partes.push(pendentes)
    if (hasAmbiguousLegacyCardBalance(s)) {
      partes.push(AMBIGUOUS_BALANCE_REPLY)
    } else {
      const saldo = currentBalance(s)
      const total = somaDe([...atrasadas, ...futuras])
      const alcance = atrasadas.length ? 'em atraso e a vencer nos próximos 30 dias' : 'a vencer nos próximos 30 dias'
      partes.push(saldo >= total - 0.009
        ? `Seu saldo de ${fmtBRL(saldo)} cobre os ${fmtBRL(total)} ${alcance}.`
        : `Seu saldo de ${fmtBRL(saldo)} não cobre os ${fmtBRL(total)} ${alcance} — faltam ${fmtBRL(round2(total - saldo))}.`)
    }
    return { text: partes.join('\n\n') }
  }

  // "Já paguei a luz?", "quando vence a água", "quanto é a internet": UMA
  // conta fixa, pelo nome. Caíam na ajuda genérica, na lista de tudo que
  // vence, ou em "não tenho lançamento" — a conta está cadastrada.
  const sobreConta = perguntaDeConta(t)
  const conta = sobreConta ? contaCitada(s, t) : undefined
  if (sobreConta && conta) return respostaDaConta(s, conta, sobreConta)

  // "Vale a pena rodar domingo?": o histórico daquele dia da semana.
  const diaPedido = diaDaSemanaPedido(t)
  if (diaPedido !== null) return respostaDoDiaDaSemana(s, diaPedido)

  // "Como foi hoje?", "foi bom?": o dia contra a média dos outros dias.
  if (pedeResumoDoDia(t)) return respostaDoDia(s, t, driverMode)

  // "Quanto fico por dia tirando a gasolina": entradas MENOS combustível.
  if (pedeSobraSemCombustivel(t)) return respostaSobraSemCombustivel(s, t)

  // Intenção de conversar/avisar o que virá não é um pedido de resumo.
  if (/\b(?:vou|posso|quero)\s+(?:te\s+)?(?:passar|falar|dizer|mandar)\b/.test(t) && !/\b\d+(?:[.,]\d+)*\b/.test(t)) {
    return {
      text: driverMode
        ? 'Claro. Pode mandar na mesma mensagem quanto ganhou, quanto gastou, os km, as horas e, se souber, as viagens. Eu vou ler tudo antes de propor os registros.'
        : 'Claro. Pode mandar na mesma mensagem tudo que entrou, tudo que saiu e qualquer detalhe importante. Eu vou ler a mensagem inteira antes de propor os registros.',
    }
  }

  // ---------- 1) Comandos de registro ----------
  const parsed = parseNaturalFull(input, { driver: driverMode })
  const actions = parsed.actions
  const isQuestion = /\?|quanto|quando|qual|como|vale a pena|posso|preciso|devo|t[oô] gastando|melhor|pior|m[ií]nimo|lucrando|aceitar/.test(t)
  if (actions.length && !isQuestion) {
    // Ambiguidade real ("gás") interrompe o fluxo: pergunta primeiro, registra
    // depois. Nenhuma ação vira botão de confirmação enquanto isso.
    if (parsed.ambiguity) {
      return { text: parsed.ambiguity.question, choices: parsed.ambiguity.options }
    }
    return {
      text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a, id => s.categories?.find(c => c.id === id)?.name)).join('\n') + '\n\nConfirmar?',
      actions,
    }
  }

  // ---------- 2) Perguntas ----------

  // Registro + pergunta sobre orçamento na mesma mensagem. A resposta usa o
  // valor projetado após as ações, mas nada é salvo antes da confirmação.
  if (actions.length && /(?:quanto|qual).*(?:limite|dispon[ií]vel|resta|sobrou)|ainda\s+tenho.*limite/.test(t)) {
    const expenseActions = actions.filter(a => a.kind === 'expense') as Extract<ParsedAction, { kind: 'expense' }>[]
    const categoryId = expenseActions.find(a => a.category)?.category
      || s.budgets.find(b => t.includes(normalizeQuestion(catById(s.categories, b.category).name)))?.category
    const budget = categoryId ? s.budgets.find(b => b.category === categoryId) : undefined
    if (budget) {
      const used = budgetUsage(s, budget.category)
      const pending = expenseActions.filter(a => a.category === budget.category).reduce((sum, a) => sum + a.amount, 0)
      const after = Math.max(budget.limit - used - pending, 0)
      const cat = catById(s.categories, budget.category)
      return {
        text: `Entendi o gasto e também a sua pergunta. Se você confirmar, o orçamento de ${cat.name} ficará com ${fmtBRL(after)} disponíveis neste mês (${fmtBRL(used + pending)} de ${fmtBRL(budget.limit)} usados).\n\nConfirmar o registro?`,
        actions,
      }
    }
    return {
      text: `Entendi o registro, mas essa categoria ainda não tem orçamento cadastrado. Você pode criar em Mais → Planejamento → Novo orçamento.\n\nConfirmar o registro mesmo assim?`,
      actions,
    }
  }

  // ===== Cartões, parcelas e faturas (todos os perfis) =====
  const ov = cardsOverview(s)
  // "Limite no Nubank" é pergunta de cartão mesmo sem a palavra "cartão"; e
  // "quando acaba a geladeira" é do parcelamento, citado pelo nome.
  if (/parcela|fatura|cart[ãa]o|parcelamento|d[ií]vida/.test(t) || (pedeLimite(t) && s.cards?.length > 0) || pedeDividaTotal(t)
    || pedeListaDeParcelamentos(t)
    || (planoCitado(s, t) && (FIM_DO_PLANO.test(t) || COMPRA_DO_PLANO.test(t) || /\b(?:antecip|adiantei\b|adiantar\b)/.test(t)))) {
    const sobreFatura = perguntaDeFatura(t)
    if ((sobreFatura === 'pagamentos' || sobreFatura === 'valor-pago') && s.cards?.length) return respostaDaFatura(s, t, sobreFatura)
    if (!ov.hasData) {
      return { text: 'Você ainda não cadastrou cartões nem parcelamentos. Você pode adicionar em Mais → Cartões e parcelamentos.' }
    }
    if (pedeAntecipacaoDeFatura(t)) return { text: 'Para preparar uma antecipação no chat, diga qual cartão você já pagou, o valor e o mês de vencimento da fatura. Em Mais → Cartões e parcelamentos, você pode conferir a fatura desse mês.' }
    if (sobreFatura && s.cards?.length) return respostaDaFatura(s, t, sobreFatura)
    // Antecipar parcela não tem ação no chat; a tela tem ("Antecipar 1/2").
    // Antes: o resumo dos cartões, como se a pessoa tivesse perguntado outra coisa.
    const p = planoCitado(s, t)
    if (/\bantecip|\badiantei\b|\badiantar\b/.test(t) && (p || /\bparcela/.test(t))) {
      return { text: `Antecipar parcela pelo chat ainda não dá. Na tela: Mais → Cartões e parcelamentos, abra ${p ? `o parcelamento ${p.description}` : 'o parcelamento'} e use "Antecipar".` }
    }
    const resposta = respostaDoParcelamento(s, t)
    if (resposta) return resposta
    // "quanto tenho de parcela no mês que vem?"
    if (/(m[eê]s que vem|pr[oó]ximo m[eê]s)/.test(t) && /parcela|fatura|cart[ãa]o/.test(t)) {
      return {
        text: `No próximo mês vencem ${fmtBRL(ov.installmentsNextMonth)} em parcelas e assinaturas (dado real, com base no que você cadastrou).` +
          (ov.installmentsThisMonth > 0 ? `\n\nNeste mês são ${fmtBRL(ov.installmentsThisMonth)}.` : ''),
      }
    }

    // "qual será minha maior fatura?"
    if (/maior fatura/.test(t)) {
      const all = (s.cards || []).flatMap(c => upcomingInvoices(s, c, 6).map(inv => ({ card: c.name, inv })))
        .filter(x => x.inv.total > 0)
        .sort((a, b) => b.inv.total - a.inv.total)
      if (!all.length) return { text: 'Não há faturas previstas com valor nos próximos meses.' }
      const top = all[0]
      return { text: `Sua maior fatura prevista é a do ${top.card}, com ${fmtBRL(top.inv.total)}, vencendo em ${fromISO(top.inv.dueDate).toLocaleDateString('pt-BR')}.` }
    }

    // "quanto vou pagar de cartão nos próximos três meses?"
    const nextM = t.match(/pr[oó]ximos?\s*(\d+|tr[eê]s|dois|quatro|cinco|seis)\s*(?:meses|m[eê]s)/)
    if (nextM && /cart[ãa]o|parcela|fatura/.test(t)) {
      const word = new Map<string, number>(Object.entries({ dois: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6 }))
      const n = Math.min(parseInt(nextM[1], 10) || word.get(nextM[1]) || 3, 12)
      const proj = monthlyProjections(s, n)
      const total = proj.reduce((a, m) => a + m.installments, 0)
      return {
        text: `Nos próximos ${n} meses estão previstos ${fmtBRL(total)} em parcelas e faturas:\n\n` +
          proj.map(m => `• ${m.label}: ${fmtBRL(m.installments)}`).join('\n') +
          `\n\nSão valores já contratados — podem mudar se você fizer novas compras.`,
      }
    }

    // "quanto devo de cartão / minha dívida"
    if (pedeDividaTotal(t) || /(quanto.*(devo|dívida|divida))|d[ií]vida total/.test(t)) {
      return {
        text: (/\bmuito\b/.test(t) ? 'Não dá para classificar como muito ou pouco só com os dados cadastrados. ' : '')
          + `Sua dívida parcelada restante é ${fmtBRL(ov.totalDebt)} em ${ov.activePlanCount} ${ov.activePlanCount === 1 ? 'parcelamento' : 'parcelamentos'}.\n\n` +
          `• Faturas em aberto agora: ${fmtBRL(ov.openInvoicesTotal)}\n` +
          `• Parcelas deste mês: ${fmtBRL(ov.installmentsThisMonth)}\n` +
          `• Próximo mês: ${fmtBRL(ov.installmentsNextMonth)}` +
          (ov.overdueCount > 0 ? `\n• Atrasadas: ${ov.overdueCount} (${fmtBRL(ov.overdueAmount)})` : ''),
      }
    }

    // "quanto tenho de limite"
    if (/limite/.test(t)) {
      // "…de limite NO NUBANK": o cartão citado, não a soma de todos.
      const doCartao = cartoesDaPergunta(s, t, s.cards || [])
      if (doCartao.length === 1) {
        const c = doCartao[0]
        if (c.archived) return { text: `O cartão ${c.name} está arquivado. O limite dele fica fora do seu crédito disponível. As faturas continuam no histórico.` }
        if (!(c.limit > 0)) return { text: `Você não informou o limite do ${c.name}. Dá pra cadastrar em Mais → Cartões e parcelamentos.` }
        const usado = round2(cardOutstanding(s, c.id))
        return { text: `O ${c.name} tem limite de ${fmtBRL(c.limit)}. Comprometido em parcelas e compras: ${fmtBRL(usado)}. Disponível: ${fmtBRL(round2(Math.max(c.limit - usado, 0)))}. (dados reais)` }
      }
      if (ov.totalLimit <= 0) return { text: 'Você ainda não informou o limite dos seus cartões. Dá pra cadastrar em Mais → Cartões e parcelamentos.' }
      return { text: `Seus cartões somam ${fmtBRL(ov.totalLimit)} de limite. Comprometido: ${fmtBRL(ov.usedLimit)}. Disponível: ${fmtBRL(ov.availableLimit)}. (dados reais)` }
    }

    // resumo geral de fatura/parcelas
    const cardsList = s.cards || []
    if (cardsList.length) {
      return {
        text: `Situação dos seus cartões (dados reais):\n\n` +
          cardsList.map(c => {
            const inv = currentInvoice(s, c)
            return `• ${c.name}${c.archived ? ' (arquivado)' : ''}: fatura de ${fmtBRL(inv.total)}${inv.paid > 0 ? ` (pago ${fmtBRL(inv.paid)}, pendente ${fmtBRL(inv.pending)})` : ''} — vence ${fromISO(inv.dueDate).toLocaleDateString('pt-BR')} · ${inv.status}`
          }).join('\n') +
          `\n\nParcelas deste mês: ${fmtBRL(ov.installmentsThisMonth)}. Dívida parcelada restante: ${fmtBRL(ov.totalDebt)}.`,
      }
    }
    return {
      text: `Você tem ${ov.activePlanCount} parcelamento(s) ativo(s), somando ${fmtBRL(ov.totalDebt)} a pagar.\n` +
        `Parcelas deste mês: ${fmtBRL(ov.installmentsThisMonth)} · próximo mês: ${fmtBRL(ov.installmentsNextMonth)}.`,
    }
  }

  // "quanto vai sobrar em outubro?" — projeção por mês citado
  const monthNames = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
  const monthAsked = monthNames.findIndex(m => t.includes(m))
  if (monthAsked >= 0 && /(sobrar|sobra|saldo|vou ter|estimad)/.test(t)) {
    const proj = monthlyProjections(s, 14)
    const target = proj.find(m => Number(m.monthKey.slice(5, 7)) === monthAsked + 1)
    if (!target) return { text: `Não tenho projeção para ${monthNames[monthAsked]} — ela cobre os próximos meses a partir de hoje.` }
    return {
      text: `Projeção para ${target.label}:\n\n` +
        `• Entradas previstas: ${fmtBRL(target.incomes)}\n` +
        `• Contas previstas: ${fmtBRL(target.bills)}\n` +
        `• Parcelas e faturas: ${fmtBRL(target.installments)}\n` +
        `• Saldo estimado acumulado: ${fmtBRL(target.runningBalance)}\n\n` +
        `Considerando suas entradas e obrigações cadastradas, o saldo estimado é ${fmtBRL(target.runningBalance)}. Essa é uma projeção e pode mudar com novos lançamentos.`,
    }
  }

  // ===== Perguntas dos perfis NÃO motoristas (mês, guardar, entradas) =====
  if (!driverMode) {
    const mg = monthlySavingGoal(s)

    // "quanto posso guardar este mês?" / "como está minha meta mensal?"
    // Meta de COMPRA citada pelo nome ("minha meta do notebook") não é a meta
    // mensal: o "minha meta" capturava a frase e respondia a meta de guardar.
    // "Consigo bater a meta?" e "bati a meta do mês?" pedem sim ou não.
    const bater = /\bbat(?:er|i|eu|endo)\s+(?:a\s+)?(?:minha\s+)?meta\b|\bmeta\s+(?:do|deste|desse|neste|nesse)\s+mes\b/.test(t)
    if (!metaCitadaPeloNome && (bater || /quanto\s+(?:eu\s+)?posso\s+guardar|meta\s+mensal|quanto\s+consigo\s+guardar|guardar\s+este\s+m[eê]s|minha\s+meta|qual\s+(?:é\s+)?a?\s*minha\s+meta|como\s+est[aá]\s+minha\s+meta/.test(t))) {
      const simNao = bater && mg.target > 0 && !mg.negative
        ? mg.reached ? `Sim, já bateu: guardou ${fmtBRL(mg.saved)} de ${fmtBRL(mg.target)}.\n\n`
          : /\b(?:consigo|consegue|da\s+para|dá\s+para|vou\s+conseguir)\b/.test(t)
            ? mg.projectedAvailable >= mg.missing - 0.009
              ? `Dá: faltam ${fmtBRL(mg.missing)} e ainda sobram ${fmtBRL(mg.projectedAvailable)} livres neste mês${mg.installmentsDue > 0 ? ', já descontadas as parcelas' : ''}.\n\n`
              : `Do jeito que está, não: faltam ${fmtBRL(mg.missing)} e sobram ${fmtBRL(mg.projectedAvailable)} livres neste mês${mg.installmentsDue > 0 ? ', já descontadas as parcelas' : ''}.\n\n`
            : `Ainda não: guardou ${fmtBRL(mg.saved)} de ${fmtBRL(mg.target)} (faltam ${fmtBRL(mg.missing)}).\n\n`
        : ''
      if (mg.target <= 0) {
        return {
          text: `Neste mês entraram ${fmtBRL(mg.income)} e saíram ${fmtBRL(mg.expense)} — resultado líquido de ${fmtBRL(mg.net)}.\n\n` +
            `Você ainda não definiu quanto quer guardar por mês. Configure em Mais → Configurações → Planejamento mensal.`,
        }
      }
      if (mg.negative) {
        return {
          text: `Sua meta é guardar ${fmtBRL(mg.target)} por mês.\n\n` +
            `Neste mês, suas despesas estão ${fmtBRL(-mg.net)} acima das suas entradas (entrou ${fmtBRL(mg.income)}, saiu ${fmtBRL(mg.expense)}). ` +
            `Antes de guardar, será necessário equilibrar esse valor.`,
        }
      }
      return {
        text: `${simNao}Sua meta é guardar ${fmtBRL(mg.target)} por mês.\n\n` +
          `• Entradas recebidas: ${fmtBRL(mg.income)}\n• Despesas realizadas: ${fmtBRL(mg.expense)}\n` +
          `• ${mg.net >= 0 ? 'Sobra do mês' : 'Déficit do mês'}: ${fmtBRL(Math.abs(mg.net))}\n` +
          `• Guardado de verdade: ${fmtBRL(mg.saved)} (${mg.pct}% da meta)\n\n` +
          (mg.reached
            ? 'Meta mensal alcançada! Você já transferiu para a reserva o valor que pretendia guardar. 🎉'
            : mg.canReach
              ? `Há sobra suficiente para cumprir a meta — ${mg.availablePct}% do valor necessário está disponível. Faltam ${fmtBRL(mg.missing)} para guardar de verdade.`
              : `Faltam ${fmtBRL(mg.missing)} para alcançar sua meta mensal.`),
      }
    }

    // "como está meu mês?"
    if (/como\s+(?:est[aá]|foi)\s+(?:o\s+)?meu\s+m[eê]s|meu m[eê]s|resultado do m[eê]s|fechamento do m[eê]s/.test(t)) {
      const ambiguousBalance = hasAmbiguousLegacyCardBalance(s)
      const bo = ambiguousBalance ? null : balanceOutlook(s, 7)
      return {
        text: `Seu mês até agora (dados reais):\n\n` +
          `• Entrou: ${fmtBRL(mg.income)}\n• Saiu: ${fmtBRL(mg.expense)}\n• ${mg.net >= 0 ? 'Sobra do mês' : 'Déficit do mês'}: ${fmtBRL(Math.abs(mg.net))}\n` +
          (mg.target > 0 ? `• Meta para guardar: ${fmtBRL(mg.target)} (${mg.pct}% atingido)\n` : '') +
          (ambiguousBalance ? `\n${AMBIGUOUS_BALANCE_REPLY}` : bo && (bo.bills.length || bo.unconfirmed.length)
            ? `\n${balanceOutlookText(bo)}`
            : ''),
      }
    }

    // "quanto recebi de aluguéis este mês?" / salário
    // "Freela" e "bico" são como se fala; sem eles, "quanto ganhei de freela"
    // caía no lucro do período inteiro, sem filtro nenhum.
    const fonteM = t.match(/(alugu[eé]|alugueis|alugu[eé]is|sal[aá]rio|freelance|freela|bico|vendas?)/)
    if (fonteM && /quanto\s+(?:eu\s+)?(?:recebi|ganhei|entrou)/.test(t)) {
      const map: Record<string, string> = {
        alugue: 'aluguel', alugueis: 'aluguel', 'aluguéis': 'aluguel', 'alugué': 'aluguel',
        salario: 'salario', 'salário': 'salario', freelance: 'freelance', freela: 'freelance', bico: 'freelance',
        venda: 'vendas', vendas: 'vendas',
      }
      const catId = map[fonteM[1]] || 'aluguel'
      const p = periodFromText(t)
      if (!p) return ajudaGenerica(driverMode)
      const txs = s.transactions.filter(x => x.type === 'income' && x.category === catId && x.date >= p.from && x.date <= p.to)
      const total = txs.reduce((a, x) => a + x.amount, 0)
      const cat = catById(s.categories, catId)
      return { text: `Você recebeu ${fmtBRL(total)} em ${cat.name} ${p.label} (${txs.length} registro${txs.length === 1 ? '' : 's'} — dado real).` }
    }
  }

  // ===== Perguntas exclusivas de MOTORISTA =====

  // "essa corrida de 18 reais por 12 km vale a pena?"
  const rideM = driverMode ? t.match(new RegExp(String.raw`corrida\s*(?:de)?\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?|pila)?\s*(?:por|de|em|pra|para|com|e|,)?\s*${NUM}\s*km`)) : null
  if (rideM && /vale|compensa|aceit|\bpego\b|\bpegar\b|d[aá]\s+pra/.test(t)) {
    const r = analyzeRide(s, n(rideM[1]), 0, n(rideM[2]), (n(rideM[2]) / 30) * 60)
    return {
      text: `Análise da corrida (estimativa com base nos seus custos):\n\n` +
        `• ${fmtBRL(r.grossPerKm)}/km bruto\n• ${fmtBRL(r.netPerKm)}/km líquido\n• Lucro estimado: ${fmtBRL(r.profit)}\n\nClassificação: ${r.rating}.` +
        (r.tone === 'negative' ? ' Eu recusaria essa.' : r.tone === 'positive' ? ' Pode aceitar!' : ' No limite do aceitável.'),
    }
  }

  // "vale a pena corrida de 8 reais" — o VALOR sem a distância.
  // É assim que a pergunta aparece na rua: o app mostra o valor antes do km.
  // Sem esta resposta a pergunta caía no parser e virava tentativa de
  // REGISTRO, que é o pior desfecho: perguntar não é gastar nem ganhar.
  const rideValorM = driverMode && !rideM && /vale\s*(?:a\s*)?pena|aceito|pego|compensa/.test(t)
    ? t.match(new RegExp(String.raw`(?:corrida|viagem|chamada|corrid[ao])[^\d]{0,12}(?:r\$)?\s*${NUM}|(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?|pila)`))
    : null
  if (rideValorM) {
    const valor = n(rideValorM[1] || rideValorM[2])
    const kc = kmCost(s)
    const custoKm = kc.fuelPerKm + kc.maintenancePerKm + kc.fixedPerKm
    if (!(valor > 0)) return { text: 'Me diga o valor da corrida que eu comparo com o seu custo por km.' }
    if (custoKm <= 0) {
      return {
        text: `Para dizer se ${fmtBRL(valor)} compensa eu preciso saber quanto seu carro custa por km.\n\n`
          + 'Registre um abastecimento com o km do hodômetro ("botei 100 de gasolina, hodômetro 220007") que eu calculo com o consumo real do seu carro.',
      }
    }
    const minKm = Math.max(custoKm * 2, custoKm + 0.5)
    const kmQueCompensa = valor / minKm
    return {
      text: `Seu custo é cerca de ${fmtBRL(custoKm)}/km, e o mínimo para lucrar é ${fmtBRL(minKm)}/km.\n\n`
        + `Então ${fmtBRL(valor)} compensa até cerca de ${fmtNum(kmQueCompensa)} km. Mais que isso e você está pagando para trabalhar.\n\n`
        + 'Se me disser a distância ("corrida de 8 reais por 3 km") eu faço a conta exata.',
    }
  }

  // "vale a pena trabalhar mais 3 horas hoje?"
  const hoursM = driverMode ? t.match(new RegExp(String.raw`trabalhar\s*(?:mais)?\s*${NUM}\s*horas?`)) : null
  if (hoursM) {
    const w = weekStats(s)
    if (w.hours < 3) return { text: 'Ainda não tenho horas de trabalho registradas suficientes para estimar seu lucro por hora. Registre suas horas (ex.: "trabalhei 8 horas") e eu te respondo com precisão.' }
    const extra = n(hoursM[1]) * w.profitPerHour
    const goal = dailyGoal(s)
    const ts = todayStats(s)
    const missing = Math.max(goal.total - ts.profit, 0)
    return {
      text: `Com base na sua média real de ${fmtBRL(w.profitPerHour)}/hora (últimos 7 dias), mais ${hoursM[1]}h renderiam aproximadamente ${fmtBRL(extra)} (estimativa).\n\n` +
        (missing > 0
          ? `Faltam ${fmtBRL(missing)} para sua meta de hoje — ${extra >= missing ? 'essas horas devem cobrir a meta. Vale a pena!' : 'mesmo assim ficaria faltando ' + fmtBRL(missing - extra) + '.'}`
          : 'Você já bateu sua meta de hoje. Horas extras agora são lucro puro, mas descanso também importa. 😉'),
    }
  }

  // "quanto posso gastar hoje" — usa o saldo (modo banco) quando informado
  if (pedeQuantoPossoGastar(t)) {
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const ts = todayStats(s)
    const goal = dailyGoal(s)
    if (currentBalance(s) !== 0) {
      // Saldo menos o que vence (fatura e o que já venceu: as mesmas fontes de
      // "o que vence") e o que falta da meta de guardar do mês, dividido pelo
      // prazo. Antes: 70% do saldo menos só as contas fixas de 7 dias, como
      // gasto de HOJE — "R$ 9.586,50 hoje" com duas faturas na frente e a
      // pergunta sendo "por dia". "Esse mês" vai até o último dia; o resto,
      // 30 dias, sem contar o que ainda vai entrar.
      const hoje = todayISO()
      const d = fromISO(hoje)
      const doMes = /\b(?:esse|este|nesse|neste|no)\s+mes\b|\bate\s+o\s+fim\s+do\s+mes\b/.test(t)
      const fimDoMes = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      const ate = doMes ? toISO(fimDoMes) : addDays(hoje, 29)
      const dias = doMes ? fimDoMes.getDate() - d.getDate() + 1 : 30
      const todas = cashObligationsUntil(s, ate)
      const certas = todas.filter(o => !o.unconfirmed)
      const contas = somaDe(certas)
      const guardar = round2(monthlySavingGoal(s).missing)
      const saldo = currentBalance(s)
      const livre = round2(saldo - contas - guardar)
      const tirando = [
        certas.length ? `${fmtBRL(contas)} que vencem até ${diaMes(ate)} (${certas.length === 1 ? '1 item' : `${certas.length} itens`})` : '',
        guardar > 0 ? `${fmtBRL(guardar)} que faltam da meta de guardar do mês` : '',
      ].filter(Boolean)
      if (livre <= 0) {
        return { text: [`Nada além do essencial: seu saldo de ${fmtBRL(saldo)} não cobre ${listaDeNomes(tirando)} — faltam ${fmtBRL(-livre)}.`,
          linhasDeObrigacao(certas), semConfirmacao(todas)].filter(Boolean).join('\n\n') }
      }
      const porDia = round2(livre / dias)
      const abre = doMes
        ? `Até ${diaMes(ate)} dá para gastar até ${fmtBRL(livre)}, uns ${fmtBRL(porDia)} por dia.`
        : `Dá uns ${fmtBRL(porDia)} por dia nos próximos 30 dias.`
      const conta = `Seu saldo é ${fmtBRL(saldo)}${tirando.length ? `; tirando ${listaDeNomes(tirando)}, sobram ${fmtBRL(livre)}` : ''}, sem contar o que ainda vai entrar. (estimativa)`
      // Fim de mês perto: o que vence logo depois também é desse saldo.
      const depois = doMes ? round2(somaDe(cashObligationsUntil(s, addDays(hoje, 29)).filter(o => !o.unconfirmed)) - contas) : 0
      const aviso = depois > 0.009 ? `Logo depois, até ${diaMes(addDays(hoje, 29))}, vencem mais ${fmtBRL(depois)}.` : ''
      return { text: [abre, conta, aviso, linhasDeObrigacao(certas), semConfirmacao(todas)].filter(Boolean).join('\n\n') }
    }
    // Sem saldo informado: motorista usa a meta diária; os outros perfis usam o mês.
    if (!driverMode) {
      const mg = monthlySavingGoal(s)
      const livreMes = Math.max(mg.net - mg.target, 0)
      return {
        text: `Neste mês entraram ${fmtBRL(mg.income)} e saíram ${fmtBRL(mg.expense)} — resultado líquido de ${fmtBRL(mg.net)}.\n\n` +
          (mg.target > 0
            ? (livreMes > 0
              ? `Já cobrindo sua meta de guardar ${fmtBRL(mg.target)}, você tem cerca de ${fmtBRL(livreMes)} de folga para gastar este mês. (estimativa)`
              : `Sua meta é guardar ${fmtBRL(mg.target)} e ainda faltam ${fmtBRL(mg.missing)} — o ideal é segurar gastos extras.`)
            : 'Defina em Configurações quanto pretende guardar por mês para eu calcular sua folga.') +
          `\n\nDica: informe seu saldo em conta na tela inicial que eu passo a considerar as contas a vencer.`,
      }
    }
    const free = ts.profit - goal.total
    if (free > 0) return { text: `Hoje você lucrou ${fmtBRL(ts.profit)} (dado real) e sua meta é ${fmtBRL(goal.total)}. Você pode gastar até ${fmtBRL(free)} sem comprometer suas contas e metas.` }
    const avg = avgDailyProfit(s)
    return {
      text: `Hoje seu lucro está em ${fmtBRL(ts.profit)} e sua meta é ${fmtBRL(goal.total)} — ainda faltam ${fmtBRL(goal.total - ts.profit)}.\n\nO ideal é segurar gastos extras até bater a meta.` +
        (avg > 0 ? ` Sua média diária é ${fmtBRL(avg)}, então é bem possível chegar lá.` : '') +
        `\n\nDica: informe seu saldo em conta na tela inicial que eu passo a te avisar sobre as contas a vencer.`,
    }
  }

  // "Quanto VOU ter na conta dia 30" é saldo FUTURO: fica com a resposta
  // datada, mais abaixo, e não com o saldo de hoje contra sete dias.
  const saldoFuturo = /\bquanto\s+(?:eu\s+)?(?:vou|vai|irei|devo)\s+ter\b/.test(t) && /\bdia\s+\d{1,2}\b|\b(?:fim|final)\s+do\s+mes\b/.test(t)
  // "qual meu saldo" / "quanto tenho no banco"
  if (!saldoFuturo && /(qual|quanto).*(saldo|no banco|na conta)|meu saldo|quanto\s+(?:eu\s+)?tenho(?:\s+(?:de\s+)?(?:dinheiro|guardado|sobrando))?\s*\??$|quanto\s+sobrou\s+(?:de\s+)?dinheiro/.test(t)) {
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const saldo = currentBalance(s)
    if (saldo === 0) return { text: 'Seu saldo em conta está zerado. Toque em "Saldo em conta" na tela inicial, ou me diga "meu saldo é 1500".' }
    // As mesmas fontes de "o que vence" e "qual conta aperta": com só as contas
    // fixas, o saldo "cobria R$ 300" com uma fatura vencendo amanhã.
    const ate = addDays(todayISO(), 7)
    const certas = cashObligationsUntil(s, ate).filter(o => !o.unconfirmed)
    const total = somaDe(certas)
    const itens = certas.length === 1 ? '1 item' : `${certas.length} itens`
    return {
      text: `Seu saldo em conta é ${fmtBRL(saldo)}.` +
        (certas.length
          ? saldo >= total - 0.009
            ? ` Cobre os ${fmtBRL(total)} que vencem até ${diaMes(ate)} (${itens}) e ainda sobram ${fmtBRL(round2(saldo - total))}.`
            : ` Mas ${fmtBRL(total)} vencem até ${diaMes(ate)} (${itens}) — faltam ${fmtBRL(round2(total - saldo))}.`
          : ` Nada cadastrado vence até ${diaMes(ate)}.`),
    }
  }


  // PROGRESSO da meta do dia: "bati a meta?", "quanto falta pra meta de hoje".
  // Vinha depois da composição, que capturava qualquer "meta" e respondia a
  // conta da meta sem dizer se foi batida.
  // "Tô bem na meta?" despejava a composição da meta sem dizer se ia bem.
  const pedeQuantoFalta = /\bquanto\s+(?:ainda\s+)?falta\b.*\bmeta\b|\bmeta\b.*\bquanto\s+(?:ainda\s+)?falta\b|\bfalta\s+quanto\b.*\bmeta\b|\bmeta\b.*\bfalta\s+quanto\b/.test(t)
  if (driverMode && !metaCitadaPeloNome
    && (/\bbat(?:i|eu|er)\s+(?:a\s+)?(?:minha\s+)?meta\b/.test(t)
      || pedeQuantoFalta
      || /\b(?:to|tou|estou|ta|esta|t[oa]\s+indo|estou\s+indo|vou)\s+(?:bem|mal|perto|longe)\s+(?:d?[ao]\s+|n[ao]\s+)?(?:minha\s+)?meta\b/.test(t)
      || /\bcomo\s+(?:eu\s+)?(?:to|tou|estou|ta|esta)\s+(?:n[ao]\s+|com\s+a\s+)?(?:minha\s+)?meta\b/.test(t))) {
    const ts = todayStats(s)
    const g = dailyGoal(s)
    const falta = round2(g.total - ts.profit)
    const conta = `lucro de ${fmtBRL(ts.profit)} hoje contra a meta de ${fmtBRL(g.total)} (dado real)`
    // "Quanto falta?" não é pergunta de sim ou não: a resposta é o valor.
    if (pedeQuantoFalta) {
      return {
        text: falta <= 0.009
          ? `Nada — você já bateu a meta de hoje: ${conta}. O que vier agora é lucro.`
          : `Faltam ${fmtBRL(falta)}: ${conta}.`,
      }
    }
    return {
      text: falta <= 0.009
        ? `Sim, bateu: ${conta}. O que vier agora é lucro.`
        : `Ainda não: ${conta} — faltam ${fmtBRL(falta)}.`,
    }
  }

  // "quanto preciso ganhar amanhã?" / "qual minha meta"
  if (driverMode && !metaCitadaPeloNome
    && /(preciso ganhar|meta)\s*(de)?\s*(amanh[aã]|hoje)?/.test(t) && /(preciso|meta)/.test(t) && !/como est/.test(t)) {
    const g = dailyGoal(s)
    return {
      text: `Sua meta diária atual é ${fmtBRL(g.total)}. Composição:\n\n` +
        `• Meta base (contas + objetivo de lucro): ${fmtBRL(g.base)}\n` +
        `• Metas pessoais: ${fmtBRL(g.personal)}\n` +
        `• Déficits acumulados: ${fmtBRL(g.deficit)}\n` +
        `• Margem de segurança: ${fmtBRL(g.margin)}\n\n` +
        `Restam ${g.workDaysLeft} dias de trabalho neste mês.`,
    }
  }

  // Conversa social: "obrigado" e "valeu" recebiam a lista de exemplos.
  const social = t.replace(/[!?.,]+/g, ' ').trim()
  if (/^(?:muito\s+)?(?:obrigad[oa]|obg|brigad[oa]|valeu|vlw|thanks|agradec\w*)(?:\s+(?:mesmo|demais|ai|viu|cara|mano))*$/.test(social)) {
    return { text: 'De nada! Quando quiser, é só me contar um gasto, um ganho ou perguntar como está o mês.' }
  }
  if (/^(?:oi+|ola|opa|e\s*ai|eai|fala|salve|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|tudo\s+bom)(?:\s+(?:tudo\s+bem|tudo\s+bom|assistente|amigo))?$/.test(social)) {
    const exemplo = driverMode ? '"fiz 300 hoje na uber"' : '"gastei 50 no mercado"'
    return { text: `Oi! Me conte o que entrou ou saiu — por exemplo, ${exemplo} — ou pergunte "como está meu mês?".` }
  }

  // "O salário já caiu?", "a Casa 2 já pagou?": o que está REGISTRADO.
  const chegada = respostaDeChegada(s, input) || respostaDeProximaEntrada(s, input)
  if (chegada) return { text: chegada }

  // Saque: o dinheiro só mudou de lugar. Para o motorista "tirei 200 do
  // banco" virava R$ 200 de corrida; "saquei 200" perguntava se foi ganho.
  if (SAQUE.test(input) && !/\b(?:paguei|gastei|comprei|recebi|ganhei|faturei)\b/.test(t)) {
    return { text: 'Saque não é ganho nem gasto: o dinheiro continua seu, só saiu da conta para a mão. Não registrei nada.\n\n'
      + 'Quando gastar esse dinheiro, me diga o gasto — por exemplo, "paguei 50 em dinheiro no mercado" — que eu lanço.' }
  }

  // "Minha conta de água veio 95": a conta CHEGOU. Paga ou não, quem diz é o
  // usuário — registrar como despesa era tirar do saldo um dinheiro que pode
  // ainda estar na conta.
  // "Minha LUZ veio 230" é a mesma conta sem a palavra "conta".
  const contaChegou = t.match(/\bconta\s+d[aeo]\s+([a-z\u00e0-\u00fa]+(?:\s+[a-z\u00e0-\u00fa]+)?)\s+(?:veio|chegou)\s+(?:de\s+|em\s+)?(?:r\$\s*)?(\d+(?:[.,]\d+)*)/)
    || t.match(/(?:^|\b(?:a|o|minha|meu)\s+)(luz|agua|energia|internet|net|gas|telefone|celular|condominio|iptu|ipva|fatura\s+d[ao]\s+celular)\s+(?:veio|chegou)\s+(?:de\s+|em\s+)?(?:r\$\s*)?(\d+(?:[.,]\d+)*)/)
  if (contaChegou && !/\b(?:paguei|pago|paga|quitei|gastei)\b/.test(t)) {
    const valor = parseMoney(contaChegou[2])
    if (valor > 0) {
      const nome = contaChegou[1].trim()
      // Já cadastrada: mandar cadastrar de novo criaria a conta em dobro.
      const cadastrada = (s.recurring || []).find(r => r.kind !== 'income' && r.active !== false && normalizeName(r.name) === normalizeName(nome))
      return { text: `Entendi: a conta de ${nome} veio ${fmtBRL(valor)}. Não registrei nada, porque ela ainda pode não estar paga.\n\n`
        + `Quando pagar, diga "paguei ${fmtNum(valor, valor % 1 ? 2 : 0)} de ${nome}" que eu lanço.`
        + (cadastrada
          ? ` Ela já está no seu Planejamento (${fmtBRL(cadastrada.amount)} cadastrados), então eu confirmo o vencimento em aberto com o valor que você disser.`
          : ' Se ela vem todo mês, cadastre em Planejamento para eu avisar o vencimento.') }
    }
  }

  // Orçamento ou preço com valor, sem verbo de pagar: não é lançamento, e a
  // ajuda genérica fazia parecer que o app não entendeu nada.
  if (/\d/.test(t) && !/\b(?:paguei|gastei|comprei|torrei|quitei|acertei|fechei|fechamos)\b/.test(t)
    && (/or[çc]amento|cota[çc][ãa]o/.test(t) || /(?<![\wÀ-ÿ])(?:t[aá]|est[aá]|custa|custam|cobra|cobram)\s+(?:r\$\s*)?\d/.test(t))) {
    return { text: 'Isso parece um orçamento ou um preço, não um pagamento — não registrei nada. Quando você pagar, me diga, por exemplo, "paguei 500 no mecânico", que eu lanço.' }
  }

  // "Desisti da meta do notebook": encerrar uma meta é na tela de Metas, e o
  // que já foi guardado continua guardado. A ajuda genérica não dizia nada.
  if (/\b(?:desisti|desistir|cancela(?:r)?|apaga(?:r)?|exclui(?:r)?|encerra(?:r)?|remove(?:r)?|tira(?:r)?)\b[^?\d]*\bmeta\b/.test(t) && !/\b(?:quanto|qual|quando|como)\b/.test(t)) {
    const alvo = s.goals.find(g => !g.done && g.name?.trim() && t.includes(normalizeQuestion(g.name)))
    return { text: alvo
      ? `Para encerrar ou apagar a meta ${alvo.name}, abra Metas → ${alvo.name}. Pelo chat eu não apago meta. O que já foi guardado (${fmtBRL(alvo.saved || 0)}) continua guardado.`
      : 'Para encerrar ou apagar uma meta, abra a tela de Metas e escolha a meta. Pelo chat eu não apago meta, e o que já foi guardado continua guardado.' }
  }

  // "Emprestei 100 pro João": o dinheiro saiu, mas deve voltar — não é gasto,
  // e o app não acompanha quem deve ao usuário. Dizer isso é melhor que a
  // ajuda genérica, e melhor que gravar uma despesa que ele não fez.
  const emprestimo = t.match(/\bemprestei\s+(?:r\$\s*)?(\d+(?:[.,]\d+)*)/)
  if (emprestimo && !/\b(?:quanto|quem|qual|quando)\b|\?/.test(t)) {
    const valor = parseMoney(emprestimo[1])
    if (valor > 0) {
      return { text: `Empréstimo não é gasto: os ${fmtBRL(valor)} devem voltar, e eu ainda não acompanho quem te deve. Nada foi registrado.\n\n`
        + `Se o dinheiro saiu da sua conta e você quer o saldo certo, diga "paguei ${fmtNum(valor, valor % 1 ? 2 : 0)} de empréstimo" que eu registro como saída. Quando devolverem, "me devolveram ${fmtNum(valor, valor % 1 ? 2 : 0)}" registra a volta.` }
    }
  }

  // "Como foi ontem?", "ontem rendeu bem?": avaliação de UM dia.
  const avaliacao = avaliacaoDoDia(s, input)
  if (avaliacao) return { text: avaliacao }

  // "como está minha meta" / "minha semana foi boa?"
  if (driverMode && /como est[aá] minha meta|meta de hoje/.test(t)) {
    const ts = todayStats(s)
    const g = dailyGoal(s)
    const pct = g.total > 0 ? Math.round((ts.profit / g.total) * 100) : 0
    return { text: `Hoje: lucro de ${fmtBRL(ts.profit)} (real) contra meta de ${fmtBRL(g.total)} — ${pct}% concluída.${pct >= 100 ? ' 🎉 Meta batida!' : ` Faltam ${fmtBRL(g.total - ts.profit)}.`}` }
  }
  if (/semana foi boa|como foi (?:a |minha |essa |esta )?semana|como (?:ta|t[aá]|esta|est[aá]|anda) (?:a |minha |essa |esta )?semana|semana (?:foi|t[aá]|esta|est[aá]) (?:boa|ruim|fraca|forte)|t[oô] melhor|estou melhor/.test(t)) {
    if (/m[eê]s/.test(t)) {
      const cur = monthStats(s), prev = prevMonthStats(s)
      const diff = cur.profit - prev.profit
      return { text: `Este mês: lucro de ${fmtBRL(cur.profit)} até agora.\nMês passado (completo): ${fmtBRL(prev.profit)}.\n\n${diff >= 0 ? `Você está ${fmtBRL(diff)} à frente — bom sinal!` : `Diferença de ${fmtBRL(-diff)}, mas o mês ainda não acabou.`}` }
    }
    const cur = weekStats(s)
    const prev = periodStats(s, addDays(todayISO(), -13), addDays(todayISO(), -7))
    const diff = cur.profit - prev.profit
    return {
      text: `Últimos 7 dias: ${fmtBRL(cur.income)} de receitas, ${fmtBRL(cur.expense)} de despesas, lucro de ${fmtBRL(cur.profit)} (dados reais).\n\n` +
        (prev.profit !== 0 ? (diff >= 0 ? `Isso é ${fmtBRL(diff)} a mais que na semana anterior. Semana boa! 💪` : `Ficou ${fmtBRL(-diff)} abaixo da semana anterior.`) : 'Ainda não tenho a semana anterior completa para comparar.'),
    }
  }

  // "quando vou conseguir comprar meu X" — metas
  // "quanto falta pra minha moto" também cai aqui: o usuário pergunta pelo
  // NOME da meta, não pela palavra "meta".
  // "Quanto já juntei da moto" é a mesma pergunta pelo outro lado — o usuário
  // quer o progresso, e tanto faz se pediu o que falta ou o que já tem.
  // "Quanto preciso guardar por mês pra viagem até dezembro", "consigo juntar
  // o notebook até março?": plano com prazo, dito com os meses contados.
  const plano = planoDeGuardar(t)
  if (plano) {
    const resposta = respostaDePlano(s, t, plano, driverMode)
    if (resposta) return resposta
  }

  const metaPeloNome = /quanto\s+(?:falta|(?:eu\s+)?(?:j[áa]\s+)?(?:juntei|guardei|tenho|consegui|separei))/.test(t)
    && s.goals.some(g => !g.done && t.includes(normalizeQuestion(g.name).split(' ')[0]))
  if (metaPeloNome || /quando\s+(vou|consigo|vou conseguir|poderei)\s+(comprar|atingir|juntar)/.test(t) || /quando.*meta/.test(t) || /quanto\s+falta\s+(?:para|pra)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?meta/.test(t)) {
    // O nome passa pela MESMA normalização da pergunta: "Câmera" com acento
    // nunca aparecia em "quanto falta pra camera", e a resposta era a primeira meta.
    const goal = s.goals.find(g => !g.done && t.includes(normalizeQuestion(g.name).split(' ')[0])) || s.goals.filter(g => !g.done)[0]
    if (!goal) return { text: 'Você ainda não tem metas de compra cadastradas. Diga algo como "quero comprar um celular de 5000 em 6 meses" que eu crio para você.' }
    const remaining = goal.target - goal.saved
    const avg = avgDailyProfit(s)
    if (avg <= 0) {
      return {
        text: `Meta "${goal.name}": você já juntou ${fmtBRL(goal.saved)} de ${fmtBRL(goal.target)} — faltam ${fmtBRL(remaining)} (dado real).\n\n`
          + 'Ainda não tenho histórico de ganhos para projetar uma data. Registre seus dias que eu te digo quando chega lá.',
      }
    }
    const savePerDay = avg * 0.3
    const days = Math.ceil(remaining / savePerDay)
    const when = fromISO(addDays(todayISO(), days)).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })
    return { text: `Meta "${goal.name}": você já juntou ${fmtBRL(goal.saved)} e faltam ${fmtBRL(remaining)} de ${fmtBRL(goal.target)}.\n\nProjeção: guardando 30% da sua média diária de lucro (${fmtBRL(savePerDay)}/dia), você chegaria lá por volta de ${when} (~${days} dias). Isso é uma estimativa com base na sua média dos últimos 30 dias.` }
  }

  // "quanto eu gastei essa semana / ontem / esse mês" — SEM categoria.
  // O caminho de categoria existe há tempo, mas exigia "com/de/em <coisa>", e
  // a pergunta mais comum não tem categoria nenhuma.
  // "Por dia" e "em média" são outra conta, que a consulta faz: aqui saía o
  // total de 7 dias para quem perguntou quanto gasta por dia.
  // A categoria pode vir DEPOIS do período: "quanto gastei essa semana COM
  // LAZER" recebia o total da semana inteira. Tirado o período, sobrar "com
  // X" é filtro — e quem responde é a consulta.
  const semPeriodo = t.replace(/\b(?:ess[ae]|est[ae]|ness[ae]|nest[ae]|n[ao]|d[ao])\s+(?:semana|mes|m[eê]s|ano|quinzena)(?:\s+passad[ao])?\b|\b(?:hoje|ontem|anteontem)\b|\bultim[ao]s\s+\d+\s+(?:dias|semanas|meses)\b/g, ' ')
  if (/quanto\s+(?:eu\s+)?(?:j[áa]\s+)?(?:gastei|gastou|torrei|saiu|foi)\b(?!\s*(?:com|de|em)\s+[a-zà-ú])/.test(t)
    && !/\b(?:com|de|em|no|na|nos|nas)\s+(?!r\$)[a-zà-ú]{3,}/.test(semPeriodo.slice(semPeriodo.search(/gastei|gastou|torrei|saiu|foi/)))
    && !/quanto\s+(?:eu\s+)?(?:posso|da\s+para|consigo)/.test(t)
    && !/\bpor\s+(?:dia|semana|mes)\b|\bao\s+dia\b|\bdiari[oa]\b|\bmedia\b/.test(t)) {
    const p = periodFromText(t)
    if (!p) return ajudaGenerica(driverMode)
    const st = periodStats(s, p.from, p.to)
    return {
      text: st.expense > 0
        ? `Você gastou ${fmtBRL(st.expense)} ${p.label} (dado real). Nesse mesmo período entraram ${fmtBRL(st.income)}.`
        : `Não tenho nenhuma despesa registrada ${p.label}.`,
    }
  }

  // "quanto eu preciso fazer hoje ainda" — o que falta para a meta do dia.
  if (driverMode && /quanto\s+(?:eu\s+)?(?:ainda\s+)?(?:preciso|falta|falto|tenho\s+que|tenho\s+de)\s*(?:fazer|ganhar|rodar|tirar|faturar|trabalhar)?/.test(t)
    && !perguntaDeManutencao(t)) {
    const goal = dailyGoal(s)
    const ts = todayStats(s)
    const falta = goal.total - ts.profit
    const w = weekStats(s)
    return {
      text: falta > 0
        ? `Sua meta de hoje é ${fmtBRL(goal.total)} e você já fez ${fmtBRL(ts.profit)} — faltam ${fmtBRL(falta)} (dado real).`
          + (w.profitPerHour > 0 ? `\n\nNo seu ritmo de ${fmtBRL(w.profitPerHour)}/hora, isso dá cerca de ${fmtNum(falta / w.profitPerHour)}h de trabalho.` : '')
        : `Você já bateu a meta de hoje: fez ${fmtBRL(ts.profit)} contra a meta de ${fmtBRL(goal.total)}. O que vier agora é lucro.`,
    }
  }

  // "quanto to gastando de gasolina por dia"
  if (driverMode && /(?:gastando|gasto|gastei|sai)\s*(?:de|com|em)?\s*(?:gasolina|combust[íi]vel|etanol|[áa]lcool|gnv)\s*(?:por|ao|no)\s*(?:dia|m[eê]s|semana)/.test(t)) {
    const dias = /m[eê]s/.test(t) ? 30 : /semana/.test(t) ? 7 : 1
    const p = { from: addDays(todayISO(), -29), to: todayISO() }
    const st = periodStats(s, p.from, p.to)
    const gasto = s.transactions
      .filter(x => x.date >= p.from && x.date <= p.to && x.type === 'expense' && x.category === 'combustivel')
      .reduce((a, x) => a + x.amount, 0)
    const abastecido = (s.fuelRecords || [])
      .filter(x => x.date >= p.from && x.date <= p.to)
      .reduce((a, x) => a + (x.amount || 0), 0)
    const total = gasto + abastecido
    if (total <= 0) return { text: 'Ainda não tenho abastecimento registrado nos últimos 30 dias. Registre um ("botei 100 de gasolina") e eu te digo a média.' }
    const unidade = dias === 1 ? 'por dia' : dias === 7 ? 'por semana' : 'por mês'
    return {
      text: `Nos últimos 30 dias você gastou ${fmtBRL(total)} com combustível — cerca de ${fmtBRL(total / 30 * dias)} ${unidade} (dado real).`
        + (st.income > 0 ? `\n\nIsso é ${fmtNum(total / st.income * 100)}% de tudo que você faturou no período.` : ''),
    }
  }

  // Como o mês vai FECHAR. Previsão, dita como previsão: o que já entrou e
  // saiu, mais o que está cadastrado para entrar e vencer até o fim do mês.
  // Gasto do dia a dia não cadastrado fica de fora, e isso é dito.
  // "Consigo guardar 500 esse mês?": a mesma previsão, contra o valor pedido.
  // O que já foi guardado no mês não volta para o saldo (regra 20), então a
  // folga é a sobra prevista.
  const querGuardar = guardarEsteMes(t)
  if (querGuardar !== null) {
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const f = monthForecast(s)
    if (!f.hasData) return { text: 'Ainda não tenho dados para dizer. Registre o que entrou e saiu este mês, ou cadastre as contas e entradas fixas.' }
    const sobra = round2(f.received + f.incomingLeft - f.paid - f.billsLeft - f.installmentsLeft)
    const ja = round2(savedThisMonth(s, todayISO()))
    const ressalva = 'É uma previsão com o que está registrado e cadastrado; gastos do dia a dia que ainda não aconteceram não entram.'
    const jaTxt = ja > 0 ? ` Você já guardou ${fmtBRL(ja)} este mês.` : ''
    return { text: sobra >= querGuardar
      ? `Dá: a sobra prevista do mês é ${fmtBRL(sobra)}, e guardar ${fmtBRL(querGuardar)} ainda deixa ${fmtBRL(round2(sobra - querGuardar))}.${jaTxt} (previsão)\n\n${ressalva}`
      : `Pela previsão, não: a sobra prevista do mês é ${fmtBRL(sobra)}, e guardar ${fmtBRL(querGuardar)} deixaria ${fmtBRL(round2(querGuardar - sobra))} a descoberto.${jaTxt} (previsão)\n\n${ressalva}` }
  }

  // "Quanto vou ter na conta dia 30": saldo de hoje, mais o que está
  // cadastrado para entrar, menos o que vence até lá. Respondia o saldo de
  // hoje contra os próximos SETE dias, ignorando o dia pedido.
  if (/\bquanto\s+(?:eu\s+)?(?:vou|vai|irei|devo)\s+ter\b/.test(t) && /\bdia\s+\d{1,2}\b|\b(?:fim|final)\s+do\s+mes\b/.test(t)) {
    const alvo = alvoDaReserva(t, todayISO())
    if (alvo.kind === 'invalid') return { text: `Não existe dia ${alvo.dia} no calendário. Me diga outro dia.` }
    if (alvo.kind === 'date') {
      if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
      const hoje = todayISO()
      const dias = Math.max(Math.round((fromISO(alvo.date).getTime() - fromISO(hoje).getTime()) / 86400000), 0)
      const saldo = currentBalance(s)
      const entradas = round2(upcomingIncomes(s, dias).filter(b => b.date <= alvo.date).reduce((a, b) => a + b.amount, 0))
      const todas = cashObligationsUntil(s, alvo.date)
      const certas = somaDe(todas.filter(o => !o.unconfirmed))
      const previsto = round2(saldo + entradas - certas)
      const partes = [
        `Até ${diaMes(alvo.date)}, seu saldo deve ficar em torno de ${fmtBRL(previsto)} (previsão).`,
        `• Saldo hoje: ${fmtBRL(saldo)}` + (entradas ? `\n• Entradas cadastradas até lá: ${fmtBRL(entradas)}` : '') + (certas ? `\n• O que vence até lá: ${fmtBRL(certas)}` : ''),
        semConfirmacao(todas),
        'Gastos do dia a dia que ainda não aconteceram, como mercado e combustível, não entram nessa conta.',
      ].filter(Boolean)
      return { text: partes.join('\n\n') }
    }
  }

  const fim = pedeFimDoMes(t)
  if (fim) {
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const f = monthForecast(s)
    if (!f.hasData) return { text: 'Ainda não tenho dados para prever o fim do mês. Registre o que entrou e saiu, ou cadastre as contas e entradas fixas em Planejamento.' }
    const resultado = round2(f.received + f.incomingLeft - f.paid - f.billsLeft - f.installmentsLeft)
    const saldoFim = round2(f.estimatedEnd)
    const conta = [
      `• Já entrou: ${fmtBRL(f.received)}`,
      f.incomingLeft ? `• Ainda vai entrar (cadastrado): ${fmtBRL(f.incomingLeft)}` : '',
      `• Já saiu: ${fmtBRL(f.paid)}`,
      f.billsLeft ? `• Contas fixas até o fim do mês: ${fmtBRL(f.billsLeft)}` : '',
      f.installmentsLeft ? `• Parcelas que ainda vencem: ${fmtBRL(f.installmentsLeft)}` : '',
    ].filter(Boolean).join('\n')
    const ressalva = 'É uma previsão: gastos do dia a dia que ainda não aconteceram, como mercado e combustível, não entram.'
    const veredito = resultado > 0 ? `deve fechar no azul, com sobra de ${fmtBRL(resultado)}`
      : resultado < 0 ? `deve fechar no vermelho, com déficit de ${fmtBRL(-resultado)}` : 'deve fechar zerado'
    const azul = /\b(?:azul|positivo|lucro|sobra)\b/.test(t)
    const lead = fim.simNao
      ? `${resultado === 0 ? 'Fica no zero' : (resultado > 0) === azul ? 'Sim' : 'Não'}: pelo que está registrado e cadastrado, o mês ${veredito}.`
      : `Pelo que está registrado e cadastrado, o mês ${veredito}. Seu saldo em conta deve ficar em torno de ${fmtBRL(saldoFim)} no fim do mês.`
    return { text: `${lead} (previsão)\n\n${conta}\n\n${ressalva}` }
  }

  // "to no lucro esse mes?" / "quanto sobrou"
  // "Tô gastando mais do que ganho?" é a pergunta mais direta sobre a saúde do
  // mês, e é a mesma conta do "tô no lucro" com o sinal invertido.
  // "Tô ferrado esse mês?" é a mesma pergunta de "tô no vermelho?", dita como
  // se diz; caía no menu de ajuda. O aperto também mostra o que vence.
  const aperto = /(?:t[oô]|estou|to|tou)\s+(?:ferrad[oa]|fudid[oa]|lascad[oa]|quebrad[oa]|apertad[oa]|enrolad[oa]|no\s+sufoco|no\s+aperto|mal\s+de\s+grana|zerad[oa])\b/.test(t)
  if (aperto || /(?:t[oô]|estou|to)\s+(?:tendo|dando|com|ficando\s+(?:no|com))\s+(?:lucro|preju[ií]zo)|(?:t[oô]|estou|to)\s+no\s+lucro|(?:t[oô]|estou)\s+no\s+(?:azul|vermelho)|quanto\s+sobrou\s*\??$|sobrou\s+quanto/.test(t)
    || /(?:gastando|gasto|gastei)\s+mais\s+(?:do\s+)?que\s+(?:eu\s+)?(?:ganho|ganhei|recebo|recebi|entra|faturo)/.test(t)) {
    const p = /semana/.test(t) ? periodFromText(t) : { from: todayISO().slice(0, 8) + '01', to: todayISO(), label: 'este mês' }
    if (!p) return ajudaGenerica(driverMode)
    const st = periodStats(s, p.from, p.to)
    const saldo = st.income - st.expense
    // Sem movimento nenhum não existe "sim": zero não é lucro, é ausência de
    // dado. Responder "Sim, sobrando R$ 0,00" seria mentir com número certo.
    if (st.income === 0 && st.expense === 0) {
      return { text: `Não tenho nada registrado ${p.label} para dizer se você está no lucro. Me conte o que entrou e o que saiu que eu faço a conta.` }
    }
    // Duas coisas diferentes na mesma pergunta:
    // - "quanto sobrou" pede um VALOR: começar com "Sim" responderia outra coisa.
    // - "tô no lucro?" e "tô no vermelho?" pedem sim/não com polaridade
    //   OPOSTA. Um "Sim" fixo respondia "sim, você está no vermelho" para quem
    //   tinha sobra — a resposta certa com o número certo, e ainda assim errada.
    const perguntaNegativa = aperto || /vermelho|preju|no\s+negativo|gastando\s+mais|gasto\s+mais|gastei\s+mais/.test(t)
    const perguntaSimNao = perguntaNegativa || /lucro|azul/.test(t)
    const positivo = saldo > 0
    const prefixo = !perguntaSimNao || saldo === 0
      ? ''
      : (positivo !== perguntaNegativa ? 'Sim — ' : 'Não — ')

    const detalhe = `${p.label} entraram ${fmtBRL(st.income)} e saíram ${fmtBRL(st.expense)}`
    const corpo = prefixo ? detalhe : detalhe[0].toUpperCase() + detalhe.slice(1)
    const fecho = positivo
      ? `, sobrando ${fmtBRL(saldo)} (dado real).`
      : saldo === 0
        ? `: não sobrou nada (dado real).`
        : `, um déficit de ${fmtBRL(-saldo)} (dado real).`
    // Quem pergunta se está ferrado quer saber do que ainda vem: o saldo
    // contra os vencimentos próximos, pela mesma conta da Home.
    const proximos = aperto && !hasAmbiguousLegacyCardBalance(s) ? `\n\n${balanceOutlookText(balanceOutlook(s, 7))}` : ''
    return { text: prefixo + corpo + fecho + proximos }
  }

  // "qual foi meu maior gasto"
  if (/maior gasto|maior despesa/.test(t) && !pedeContasFixas(t)) {
    const p = periodFromText(t)
    if (!p) return ajudaGenerica(driverMode)
    const txs = s.transactions.filter(x => x.type === 'expense' && x.date >= p.from && x.date <= p.to)
    if (!txs.length) return { text: `Não encontrei despesas ${p.label}.` }
    const top = [...txs].sort((a, b) => b.amount - a.amount)[0]
    const cat = catById(s.categories, top.category)
    return { text: `Seu maior gasto ${p.label} foi ${fmtBRL(top.amount)} em ${cat.name}${top.description ? ` (${top.description})` : ''}, no dia ${fromISO(top.date).toLocaleDateString('pt-BR')}.` }
  }

  // "qual foi meu melhor dia"
  if (/melhor dia|pior dia|(?:qual|que)\s+dia\s+(?:eu\s+)?(?:fiz|ganhei|faturei|rendeu)\s+mais|dia\s+que\s+(?:eu\s+)?mais\s+(?:fiz|ganhei)/.test(t)) {
    // O período DITO manda: "melhor dia esse mês" respondia com 29/08, de
    // outro mês, porque a janela era sempre os últimos 30 dias.
    const hoje = todayISO()
    const inicioMes = `${hoje.slice(0, 8)}01`
    const janela = /\bmes\s+passado\b/.test(t)
      ? { de: addDays(inicioMes, -1).slice(0, 8) + '01', ate: addDays(inicioMes, -1), rotulo: 'no mês passado' }
      : /\b(?:ess[ea]|est[ea]|nesse|neste|do)\s+mes\b/.test(t)
        ? { de: inicioMes, ate: hoje, rotulo: 'este mês' }
        : /\bsemana\b/.test(t)
          ? { de: addDays(hoje, -6), ate: hoje, rotulo: 'nos últimos 7 dias' }
          : { de: addDays(hoje, -29), ate: hoje, rotulo: 'nos últimos 30 dias' }
    const dias = Math.round((fromISO(hoje).getTime() - fromISO(janela.de).getTime()) / 86400000) + 1
    const serie = dailySeries(s, dias).filter(d => d.date >= janela.de && d.date <= janela.ate && (d.income > 0 || d.expense > 0))
    if (!serie.length) return { text: `Não tenho movimentação registrada ${janela.rotulo} para apontar um dia.` }
    const ordenada = [...serie].sort((a, b) => b.profit - a.profit)
    const best = ordenada[0], worst = ordenada[ordenada.length - 1]
    if (/pior/.test(t)) return { text: `Seu pior dia ${janela.rotulo} foi ${fromISO(worst.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(worst.profit)}.` }
    return { text: `Seu melhor dia ${janela.rotulo} foi ${fromISO(best.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(best.profit)} (${fmtBRL(best.income)} de receitas).` }
  }

  // "quanto eu COSTUMO gastar de suco por dia?" — a pergunta é sobre o hábito,
  // não sobre o total do período, e o nome da coisa é o DELE: o motorista que
  // chama combustível de "suco" não é atendido por uma lista de palavras do
  // app. Quem sabe o que é "suco" é o histórico dele.
  const habitualM = t.match(
    /quanto\s+(?:eu\s+)?(?:costumo|costuma|normalmente|geralmente|em m[ée]dia)\s*(?:gast\w+|pag\w+|torr\w+)?\s*(?:de|com|em|n[oa]s?)\s+([\wçãõáéíóú\s]+?)\s*(?:por\s+(dia|semana|m[eê]s)|\?|$)/,
  )
  if (habitualM) {
    const alvo = habitualM[1].trim()
    const escala = habitualM[2] || 'mes'
    const resposta = habitualSpending(s, alvo, escala)
    if (resposta) return { text: resposta }
  }

  // "quanto gastei com gasolina esse mês" / "quanto perco por mês com gasolina"
  const spentM = t.match(/quanto\s+(?:eu\s+)?(?:ja\s+)?(?:gastei|gasto|perco|perdi|torrei)\s*(?:por m[eê]s)?\s*(?:com|de|em)\s+([\wçãõáéíóú\s]+?)(?:\s+(?:esse|este|nesse|neste)?\s*(m[eê]s|semana|hoje|ano)|\?|$)/)
  if (spentM) {
    // "Com O bar": o artigo não é parte do nome, e "o bar" não achava "Bar".
    const what = spentM[1].trim().replace(/^(?:o|a|os|as|no|na|nos|nas|meu|minha|meus|minhas)\s+/, '')
    const p = periodFromText(t)
    if (!p) return ajudaGenerica(driverMode)
    // Pergunta sem acento contra nome com acento: "alimentacao" nunca achava
    // "Alimentação" e a resposta era R$ 0,00 com cara de dado real.
    const catGuess = s.categories.find(c => normalizeQuestion(c.name).includes(what)) ||
      (/(gasolina|combust|etanol|alcool)/.test(what) ? catById(s.categories, 'combustivel') : undefined)
    const txs = s.transactions.filter(x => x.type === 'expense' && x.date >= p.from && x.date <= p.to &&
      (catGuess ? x.category === catGuess.id : normalizeQuestion(x.description || '').includes(what)))
    // Palavra que não é categoria nem aparece em lançamento nenhum: "R$ 0,00 —
    // dado real" afirmava um zero para quem chama Alimentação de "comida". A
    // consulta conhece mais nomes e, sem base, diz que não tem.
    if (!catGuess && !txs.length) return ajudaGenerica(driverMode)
    const total = txs.reduce((a, x) => a + x.amount, 0)
    return { text: `Você gastou ${fmtBRL(total)} com ${catGuess ? catGuess.name : what} ${p.label} (${txs.length} registro${txs.length === 1 ? '' : 's'} — dado real).` }
  }

  // "quanto ganhei" / "quanto lucrei" / "quanto faturei"
  if (/quanto\s+(?:eu\s+)?(ganhei|faturei|lucrei|recebi|fiz)/.test(t)) {
    const p = periodFromText(t)
    if (!p) return ajudaGenerica(driverMode)
    const st = periodStats(s, p.from, p.to)
    const isLucro = /lucrei/.test(t)
    return {
      text: isLucro
        ? `Seu lucro ${p.label} foi ${fmtBRL(st.profit)} (${fmtBRL(st.income)} de receitas − ${fmtBRL(st.expense)} de despesas). Dados reais.`
        : `Você faturou ${fmtBRL(st.income)} ${p.label}. Descontando ${fmtBRL(st.expense)} de despesas, o lucro foi ${fmtBRL(st.profit)}.`,
    }
  }

  const custoVeiculo = answerVehicleCost(s, t)
  if (custoVeiculo) return { text: custoVeiculo.text }

  // "quanto tô fazendo por hora" / "quanto por viagem" — as duas métricas que
  // o motorista mais olha, e as duas caíam no texto genérico de ajuda.
  if (driverMode && /(?:quanto|qual).*(?:por\s+hora|a\s+hora|hora\b)|ganho\s+por\s+hora|lucro\s+por\s+hora/.test(t)
    && !/vale a pena|trabalhar/.test(t)) {
    const w = weekStats(s)
    if (w.hours <= 0) return { text: 'Ainda não tenho horas registradas. Diga "trabalhei 8 horas" (ou mande junto com o ganho do dia) que eu calculo seu lucro por hora real.' }
    return {
      text: `Nos últimos 7 dias você trabalhou ${fmtNum(w.hours)}h e lucrou ${fmtBRL(w.profit)} — ${fmtBRL(w.profitPerHour)}/hora (dado real).`,
    }
  }
  if (driverMode && /(?:quanto|qual).*(?:por\s+viagem|por\s+corrida|a\s+viagem|cada\s+viagem|m[ée]dia\s+(?:por|da)\s+(?:viagem|corrida))/.test(t)) {
    const w = weekStats(s)
    if (w.trips <= 0) return { text: 'Ainda não tenho viagens registradas nos últimos 7 dias. Diga "fiz 14 viagens" que eu calculo sua média por viagem.' }
    return {
      text: `Nos últimos 7 dias foram ${w.trips} viagens e ${fmtBRL(w.incomeWithTrips)} de receita nos dias em que elas foram informadas — ${fmtBRL(w.perTrip)} por viagem (dado real).`
        + (w.income - w.incomeWithTrips > 0.009
          ? `\n\n${fmtBRL(w.income - w.incomeWithTrips)} entraram em dias sem a quantidade de viagens e ficaram fora dessa média. Diga "fiz 14 viagens" junto com o ganho do dia que eu incluo.`
          : ''),
    }
  }

  // "quando preciso trocar meu óleo"
  // "Falta muito pra TROCA de óleo?" é o mesmo pedido com o substantivo.
  if (driverMode && (/trocar.*(óleo|oleo|pneu|pastilha|filtro)/.test(t) || /quando.*troca/.test(t) || perguntaDeManutencao(t))) {
    if (!s.maintenance.length) return { text: 'Você ainda não registrou manutenções. Diga por exemplo: "troquei o óleo por 280 com 84 mil km".' }
    const odo = s.vehicle?.odometer || 0
    // Sem o intervalo (`lifeKm`), NÃO existe "próxima troca": a conta virava
    // kmInstalado + 0 e o app anunciava que uma troca recém-feita já estava
    // vencida. E `lifeKm: 0` é o caso comum — a frase que o próprio app
    // sugere ("troquei o óleo por 280 com 84 mil km") não pede o intervalo.
    const semIntervalo = s.maintenance.filter(mi => !(mi.lifeKm > 0))
    const comIntervalo = s.maintenance.filter(mi => mi.lifeKm > 0)

    const lines = comIntervalo.map(mi => {
      const next = mi.kmInstalled + mi.lifeKm
      const left = next - odo
      return `• ${mi.name}: próxima troca aos ${fmtNum(next, 0)} km ${left > 0 ? `(faltam ${fmtNum(left, 0)} km)` : '— JÁ VENCIDA'}`
    })
    for (const mi of semIntervalo) {
      lines.push(`• ${mi.name}: trocado aos ${fmtNum(mi.kmInstalled, 0)} km. Não sei o intervalo dessa peça —`
        + ' me diga de quantos em quantos km você troca que eu passo a avisar.')
    }
    // "Quando troco OS PNEUS?" com só o óleo cadastrado: dizer que a peça
    // pedida não está cadastrada, em vez de responder sobre outra.
    const PECAS: [RegExp, string][] = [[/\bpneus?\b/, 'pneu'], [/\bpastilhas?\b|\bfreios?\b/, 'pastilha'], [/\bfiltros?\b/, 'filtro'], [/\bcorreia\b/, 'correia'], [/\boleo\b|\bóleo\b/, 'óleo']]
    const pedida = PECAS.find(([re]) => re.test(t))
    if (pedida && !s.maintenance.some(mi => normalizeName(mi.name).includes(normalizeName(pedida[1]).slice(0, 4)))) {
      return { text: `Não tenho ${pedida[1]} cadastrado em Manutenção, então não sei quando é a próxima troca. `
        + `Quando trocar, diga por exemplo "troquei ${pedida[1] === 'pneu' ? 'os pneus' : `o ${pedida[1]}`} por 800 com ${fmtNum(odo || 100000, 0)} km" que eu passo a acompanhar.\n\n`
        + `O que está cadastrado (hodômetro em ${fmtNum(odo, 0)} km):\n\n${lines.join('\n')}` }
    }
    return { text: `Com o hodômetro em ${fmtNum(odo, 0)} km:\n\n${lines.join('\n')}` }
  }

  // "tô gastando demais esse mês?"
  if (/gastando demais|gastei demais|(?:estou|to)\s+(?:ganhando|faturando|indo)\s+(?:mais|melhor|pior|menos)|(?:ganhei|fiz|faturei)\s+mais\s+que\s+(?:o\s+)?m[eê]s\s+passado|comparado\s+(?:ao|com)\s+(?:o\s+)?m[eê]s\s+passado/.test(t)) {
    const cur = monthStats(s), prev = prevMonthStats(s)
    const day = fromISO(todayISO()).getDate()
    const prevPace = prev.expense > 0 ? (prev.expense / daysInMonth(addDays(todayISO(), -day))) * day : 0
    if (prevPace === 0) return { text: `Este mês você gastou ${fmtBRL(cur.expense)}. Ainda não tenho o mês anterior completo para comparar o ritmo.` }
    const diff = cur.expense - prevPace
    return {
      text: `Este mês: ${fmtBRL(cur.expense)} em despesas.\nNo mesmo ponto do mês passado: ~${fmtBRL(prevPace)} (estimativa proporcional).\n\n` +
        (diff > 0 ? `Você está gastando ${fmtBRL(diff)} a mais que o ritmo do mês passado. Vale olhar as categorias na aba Análises.` : `Está ${fmtBRL(-diff)} abaixo do ritmo do mês passado. 👏`),
    }
  }

  // "Qual meu gasto fixo", "quais minhas contas fixas": o que se repete, por
  // mês. Listava TODOS os gastos, ou a lista do que vence com as faturas.
  if (pedeContasFixas(t)) return respostaDasContasFixas(s, driverMode, /\b(?:maior|mais\s+car[ao]|mais\s+pesad[ao])\b/.test(t))

  // "meu salário cobre minhas contas?" — pergunta de SIM OU NÃO, e a resposta
  // era a lista de contas. O app sabia responder (`balanceOutlook` calcula
  // exatamente isso) e devolvia dado em vez de resposta; quem lê no celular
  // ainda tinha que somar de cabeça. Vem ANTES da lista porque a frase contém
  // "contas" e a lista a capturava primeiro.
  if (/\b(?:cobre|cobrem|cobrir|d[áa]\s+(?:pra|para)\s+pagar|consigo\s+pagar|vou\s+conseguir\s+pagar|tenho\s+(?:saldo|dinheiro)\s+(?:pra|para))\b/.test(t)
    && /\bcontas?\b|\bvencer\b|\bvencimento\b|\bfatura\b/.test(t)) {
    // Fatura e o que já venceu entram, e o prazo dito ("até dia 10") manda:
    // com só as contas fixas e 15 dias fixos, esta resposta contradizia
    // "qual conta tá me apertando" no mesmo aparelho.
    if (hasAmbiguousLegacyCardBalance(s)) return { text: AMBIGUOUS_BALANCE_REPLY }
    const ate = prazoDasContas(t, todayISO(), 15)
    const todas = cashObligationsUntil(s, ate)
    const certas = todas.filter(o => !o.unconfirmed)
    const pendentes = semConfirmacao(todas)
    if (!certas.length) {
      return { text: [`Nada cadastrado vence até ${diaMes(ate)}, então não há o que cobrir.`, pendentes].filter(Boolean).join('\n\n') }
    }
    const saldo = currentBalance(s)
    const total = somaDe(certas)
    const itens = certas.length === 1 ? '1 item' : `${certas.length} itens`
    return {
      text: [saldo >= total - 0.009
        ? `Sim. Seu saldo de ${fmtBRL(saldo)} cobre os ${fmtBRL(total)} que vencem até ${diaMes(ate)} (${itens}) e ainda sobram ${fmtBRL(round2(saldo - total))}.`
        : `Não. Até ${diaMes(ate)} vencem ${fmtBRL(total)} (${itens}) e seu saldo é ${fmtBRL(saldo)} — faltam ${fmtBRL(round2(total - saldo))}.`,
      linhasDeObrigacao(certas), pendentes].filter(Boolean).join('\n\n'),
    }
  }

  // contas próximas — mesmas fontes da cobertura, com o prazo que foi dito.
  // "Quanto falta pagar esse mês" é a mesma pergunta sem a palavra "conta".
  if (/contas?( fixas)?|vencimento|vence/.test(t) || pedeContasAPagar(t)) {
    const ate = prazoDasContas(t, todayISO(), 15)
    const todas = cashObligationsUntil(s, ate)
    const certas = todas.filter(o => !o.unconfirmed)
    const pendentes = semConfirmacao(todas)
    // "Tem conta vencendo?" é de sim ou não (regra 57).
    const simNao = /^\s*(?:e\s+)?(?:eu\s+)?tem\b/.test(t)
    if (!certas.length) {
      return { text: [`${simNao ? 'Não. ' : ''}Nada cadastrado vence até ${diaMes(ate)}.`, pendentes].filter(Boolean).join('\n\n') }
    }
    const abre = pedeContasAPagar(t)
      ? `Até ${diaMes(ate)} falta pagar ${fmtBRL(somaDe(certas))}.`
      : `${simNao ? 'Sim. ' : ''}Vence até ${diaMes(ate)}: ${fmtBRL(somaDe(certas))}.`
    return {
      text: [abre, linhasDeObrigacao(certas), pendentes].filter(Boolean).join('\n\n'),
    }
  }

  // consumo
  if (driverMode && /consumo|km\/l|quantos km por litro/.test(t)) {
    const eff = fuelEfficiency(s)
    if (!eff) return { text: 'Registre pelo menos 2 abastecimentos com o KM do hodômetro para eu calcular seu consumo real.' }
    return { text: `Seu carro está fazendo ${fmtNum(eff)} km/L, calculado com base nos seus abastecimentos (dado real).` }
  }

  // resumo geral — o formato muda por perfil: meta diária/km só existem no motorista.
  // "como está meu mês" tinha resposta SÓ no ramo não-motorista; no perfil
  // motorista caía no texto genérico de ajuda.
  if (/resumo|como estou|(?:t[oô]|tou|estou)\s+indo\s+(?:bem|mal)|situa[çc][aã]o|como\s+(?:esta|foi|vai|anda)\s+(?:o\s+)?meu\s+m[eê]s|meu m[eê]s(?:\s|\?|$)|como\s+(?:esta|foi)\s+(?:o\s+)?m[eê]s/.test(t)) {
    // "Resumo da semana" pedia a semana e recebia o mês.
    if (!driverMode && /\bsemana\b/.test(t)) {
      const hoje = todayISO()
      const sem = periodStats(s, addDays(hoje, -6), hoje)
      const guardado = round2(s.transactions.filter(x => x.type === 'saving' && x.date >= addDays(hoje, -6) && x.date <= hoje)
        .reduce((a, x) => a + x.amount, 0))
      return {
        text: `Sua semana — últimos 7 dias (dados reais):\n\n`
          + `• Entradas: ${fmtBRL(sem.income)}\n`
          + `• Despesas: ${fmtBRL(sem.expense)}\n`
          + `• ${sem.profit >= 0 ? 'Sobra' : 'Déficit'}: ${fmtBRL(Math.abs(sem.profit))}\n`
          + `• Guardado: ${fmtBRL(guardado)}`,
      }
    }
    if (!driverMode) {
      const mg = monthlySavingGoal(s)
      const ambiguousBalance = hasAmbiguousLegacyCardBalance(s)
      const bo = ambiguousBalance ? null : balanceOutlook(s, 7)
      const inst = installmentsThisMonth(s)
      return {
        text: `Sua situação neste mês (dados reais):\n\n` +
          `• Entradas: ${fmtBRL(mg.income)}\n` +
          `• Despesas: ${fmtBRL(mg.expense)}\n` +
          `• ${mg.net >= 0 ? 'Sobra do mês' : 'Déficit do mês'}: ${fmtBRL(Math.abs(mg.net))}\n` +
          `• Já guardado de verdade: ${fmtBRL(mg.saved)}\n` +
          (mg.target > 0 ? `• Meta mensal para guardar: ${fmtBRL(mg.target)} (${mg.pct}% atingido)\n` : '') +
          (inst > 0 ? `• Parcelas e faturas que vencem neste mês: ${fmtBRL(inst)}\n` : '') +
          (ambiguousBalance ? `\n${AMBIGUOUS_BALANCE_REPLY}` : bo && (bo.bills.length || bo.unconfirmed.length)
            ? `\n${balanceOutlookText(bo)}`
            : '\nNenhum compromisso cadastrado vencido ou nos próximos 7 dias.'),
      }
    }
    const ts = todayStats(s); const w = weekStats(s); const m2 = monthStats(s); const g = dailyGoal(s)
    return {
      text: `Resumo rápido:\n\n• Hoje: lucro de ${fmtBRL(ts.profit)} (meta ${fmtBRL(g.total)})\n• 7 dias: lucro de ${fmtBRL(w.profit)}\n• Mês: receitas ${fmtBRL(m2.income)}, despesas ${fmtBRL(m2.expense)}, lucro ${fmtBRL(m2.profit)}` +
        (m2.km > 0 ? `\n• ${fmtNum(m2.km, 0)} km rodados, ${fmtBRL(m2.netPerKm)}/km líquido` : ''),
    }
  }

  // "qual o valor mínimo de corrida / pra sair lucrando / quanto cobrar por km"
  if (driverMode && /valor m[ií]nimo|m[ií]nimo (?:de|da|pra|para|por)|sair lucrando|quanto cobrar|devo aceitar|vale a pena aceitar/.test(t)) {
    const kc = kmCost(s)
    // usa consumo e preço informados na própria frase, se houver
    const consM = t.match(/(\d+(?:[.,]\d+)?)(?:\s*\/\s*\d+)?\s*km\s*(?:por\s*)?(?:l\b|litro)/)
    const priceM = t.match(/(?:r\$\s*)?(\d+(?:[.,]\d+)?)\s*(?:reais\s*)?(?:o|por|cada|\/)\s*(?:o\s*)?litro/)
    let fuelPerKm = kc.fuelPerKm, usouInformado = false
    if (consM && priceM) {
      const kml = n(consM[1]), price = n(priceM[1])
      if (kml > 0 && price > 0) { fuelPerKm = price / kml; usouInformado = true }
    }
    const totalPerKm = fuelPerKm + kc.maintenancePerKm + kc.fixedPerKm
    const min = Math.max(totalPerKm * 2, totalPerKm + 0.5)
    const confort = Math.max(totalPerKm * 2.6, totalPerKm + 1)
    return {
      text: (usouInformado ? `Com o consumo e preço que você passou, ` : ``) +
        `seu custo por km é de cerca de ${fmtBRL(totalPerKm)} (combustível ${fmtBRL(fuelPerKm)} + manutenção ${fmtBRL(kc.maintenancePerKm)} + fixos ${fmtBRL(kc.fixedPerKm)}).\n\n` +
        `Para sair lucrando, aceite no mínimo ${fmtBRL(min)}/km — o ideal é ${fmtBRL(confort)}/km.\n\n` +
        `Na prática: corrida de 5 km vale a partir de ${fmtBRL(min * 5)}; de 10 km, ${fmtBRL(min * 10)}.` +
        (usouInformado ? '' : `\n\nDica: registre um abastecimento com o km do hodômetro que eu calculo isso com o consumo real do seu carro.`),
    }
  }

  // O ritmo DELE: ganho típico por dia, dias mais fortes, de onde vem o
  // dinheiro, tendência contra o próprio normal. Fica por último entre as
  // respostas de motorista porque as perguntas acima são mais específicas —
  // "quanto gastei com gasolina esse mês" pede um total, não um padrão.
  if (driverMode) {
    const insight = driverInsight(s, input)
    if (insight) return { text: insight }
  }

  // Se o parser achou ações mas parecia pergunta, ofereça registro
  if (actions.length) {
    if (parsed.ambiguity) return { text: parsed.ambiguity.question, choices: parsed.ambiguity.options }
    return { text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a, id => s.categories?.find(c => c.id === id)?.name)).join('\n') + '\n\nConfirmar?', actions }
  }

  return ajudaGenerica(driverMode)
}

/** 'DD/MM/AAAA' montado à mão, pelo mesmo motivo de `diaMes`. */
const dataCompleta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

interface SituacaoDaFatura {
  nome: string
  closingDay: number
  dueDay: number
  /** Venceram e seguem com valor a pagar, pelo mesmo cálculo do caixa. */
  atrasadas: CashObligation[]
  /** A primeira fatura que vence de hoje em diante. */
  proxima: CardInvoice
  /** Quanto falta dela, pelo mesmo cálculo do caixa. */
  aPagar: number
  /** Já fechou: o valor não cresce mais. */
  fechou: boolean
  /** A última que já venceu — a de "já paguei a fatura?" quando nada mais fechou. */
  ultima: CardInvoice
  /** Fechamento da fatura seguinte à `proxima`. */
  fechaDepois: string
}

/** Cartões citados pelo nome; nome curto como "C6" também vale. */
function cartoesDaPergunta(s: AppState, t: string, cards = activeCards(s)) {
  return cards.filter(c => {
    const n = normalizeQuestion(c.name)
    return n.length >= 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)
  })
}

function pagamentosDeFatura(
  s: AppState, t: string, tipo: 'pagamentos' | 'valor-pago', cartoes: ReturnType<typeof activeCards>, alvo: string,
): AiReply {
  const hoje = todayISO()
  const reference = readInvoiceReference(t, hoje, true)
  if (reference.referenceQuestion) return { text: reference.referenceQuestion }
  const mk = reference.referenceMonth
  const periodText = reference.paymentText
  const saidDates = findAllDates(periodText, hoje)
  const invalid = saidDates.find(d => d.kind === 'ambiguous' || d.kind === 'invalid')
  if (invalid?.kind === 'ambiguous' || invalid?.kind === 'invalid') return { text: invalid.question }
  const explicit = parsePeriod(periodText, hoje)?.period
  const dated = saidDates.flatMap(d => d.kind === 'date' || (d.kind === 'future' && !d.imprecise) ? [d] : [])
  if (dated.length > 1 && explicit?.grain !== 'range') {
    return { text: 'Qual é o período dos pagamentos que você quer consultar? Informe a data inicial e a final.' }
  }
  const day = dated[0]
  const period = day && explicit?.grain !== 'range' ? { from: day.date, to: day.date, label: day.label }
    : explicit || (tipo === 'valor-pago' && !mk ? currentMonthToDate(hoje) : undefined)
  const competencia = mk ? ` com vencimento em ${mk.slice(5)}/${mk.slice(0, 4)}` : ''
  const janela = period ? ` (${period.label})` : ''
  const nomes = new Map(cartoes.map(c => [c.id, c.name]))
  const pagamentos = (s.cardPayments || []).filter(p => nomes.has(p.cardId) && (!mk || p.referenceMonth === mk)
    && validPaymentDate(p.paymentDate, hoje) && Number.isFinite(p.amount) && p.amount > 0
    && (!period || (p.paymentDate >= period.from && p.paymentDate <= period.to)))
    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || (b.paymentTime || '').localeCompare(a.paymentTime || ''))

  if (tipo === 'valor-pago' && pagamentos.length) {
    const total = round2(pagamentos.reduce((sum, p) => sum + p.amount, 0))
    return { text: `Total de pagamentos de fatura registrados${alvo}${competencia}${janela} pela data do pagamento: ${fmtBRL(total)}.` }
  }
  if (!pagamentos.length) {
    if (tipo === 'valor-pago' && mk && !period) {
      const quitado = cartoes.reduce((sum, card) => {
        const invoice = cardInvoice(s, card, mk, hoje)
        return sum + invoice.total - invoiceOpenAmount(s, invoice, hoje)
      }, 0)
      if (quitado > 0.009) return {
        text: `Constam ${fmtBRL(quitado)} quitados nas faturas${alvo}${competencia}. Para essa quitação, não há pagamento de fatura com data registrada.`,
      }
    }
    return { text: `Não tenho pagamento de fatura${alvo}${competencia} com data registrada${janela}. Uma parcela marcada como paga, sozinha, não informa quando a fatura foi paga.` }
  }
  const linhas = pagamentos.slice(0, 5).map(p => {
    const vencimento = /^\d{4}-\d{2}$/.test(p.referenceMonth)
      ? ` · fatura de ${p.referenceMonth.slice(5)}/${p.referenceMonth.slice(0, 4)}` : ''
    return `• ${nomes.get(p.cardId)}: ${fmtBRL(p.amount)} em ${dataCompleta(p.paymentDate)}${vencimento}.`
  })
  const mais = pagamentos.length > 5 ? ` Mostrei os 5 mais recentes de ${pagamentos.length}.` : ''
  return { text: `Últimos pagamentos de fatura registrados${alvo}${competencia}${janela}:\n${linhas.join('\n')}\n\nO valor de cada pagamento pode ser parcial.${mais}` }
}

function situacaoDasFaturas(s: AppState, cartoes: ReturnType<typeof activeCards>): SituacaoDaFatura[] {
  const hoje = todayISO()
  const h = fromISO(hoje)
  const mes = (n: number) => monthKey(toISO(new Date(h.getFullYear(), h.getMonth() + n, 1)))
  const base = cartoes.map(card => {
    const desteMes = cardInvoice(s, card, mes(0))
    const proxima = desteMes.dueDate >= hoje ? desteMes : cardInvoice(s, card, mes(1))
    const ultima = desteMes.dueDate < hoje ? desteMes : cardInvoice(s, card, mes(-1))
    const [y, m] = proxima.monthKey.split('-').map(Number)
    const seguinte = cardInvoice(s, card, monthKey(toISO(new Date(y, m, 1))))
    return { card, proxima, ultima, fechaDepois: seguinte.closingDate }
  })
  const ate = base.reduce((max, b) => b.proxima.dueDate > max ? b.proxima.dueDate : max, hoje)
  const faturas = cashObligationsUntil(s, ate).filter(o => o.kind === 'invoice')
  return base.map(({ card, proxima, ultima, fechaDepois }) => ({
    nome: card.name, closingDay: card.closingDay, dueDay: card.dueDay,
    atrasadas: faturas.filter(o => o.cardId === card.id && o.date < hoje),
    proxima, ultima, fechaDepois,
    aPagar: faturas.find(o => o.cardId === card.id && o.date === proxima.dueDate)?.amount || 0,
    fechou: proxima.closingDate < hoje,
  }))
}

const venceEm = (iso: string) => iso === todayISO() ? `hoje (${dataCompleta(iso)})` : `em ${dataCompleta(iso)}`

/** A fatura atual ainda aberta, que pode crescer até fechar. */
function notaDaAberta(f: SituacaoDaFatura, prefixo = 'A próxima'): string {
  if (f.fechou || f.aPagar <= 0) return ''
  return `${prefixo}, ainda aberta, está em ${fmtBRL(f.aPagar)}: fecha em ${dataCompleta(f.proxima.closingDate)} e vence em ${dataCompleta(f.proxima.dueDate)}.`
}

/** O que já venceu ou fechou e falta pagar, uma linha por fatura. */
function devidasDa(f: SituacaoDaFatura): { valor: number; data: string; linha: string; atrasada: boolean }[] {
  const out = f.atrasadas.map(o => ({ valor: o.amount, data: o.date, linha: `${fmtBRL(o.amount)} — venceu em ${dataCompleta(o.date)}, atrasada`, atrasada: true }))
  if (f.fechou && f.aPagar > 0) {
    out.push({ valor: f.aPagar, data: f.proxima.dueDate, linha: `${fmtBRL(f.aPagar)} — fechada, vence ${venceEm(f.proxima.dueDate)}`, atrasada: false })
  }
  return out
}

/**
 * "Quanto falta pagar da fatura do Inter", "já paguei a do Nubank?", "tenho
 * fatura atrasada?", "quando vence", "quando fecha". O pendente vem do mesmo
 * cálculo do caixa (`cashObligationsUntil`), para a fatura não ter um valor
 * aqui e outro em "quanto preciso deixar até dia 10".
 */
function respostaDaFatura(s: AppState, t: string, tipo: PerguntaDeFatura): AiReply {
  const historico = tipo === 'pagamentos' || tipo === 'valor-pago'
  const disponiveis = s.cards || []
  const citados = cartoesDaPergunta(s, t, disponiveis)
  if (!citados.length) {
    const dito = t.match(/\bfaturas?\s+d[oa]s?\s+(?:meu\s+|minha\s+)?(?:cartao\s+(?:d[oa]\s+)?)?([a-z][a-z0-9]*)/)
    if (dito && !/^(?:cartao|cartoes|credito|mes|meses|ano|semana|dia|atual|agora|passad[oa]|anterior|ultim[oa]|proxim[oa]|hoje)$/.test(dito[1])) {
      return { text: `Não encontrei um cartão chamado ${sentenceCase(dito[1])}. Seus cartões: ${listaDeNomes(disponiveis.map(c => c.name))}.` }
    }
  }
  const cartoes = citados.length ? citados : disponiveis
  if (historico) {
    const alvo = citados.length === 1 ? ` do ${citados[0].name}` : ''
    return pagamentosDeFatura(s, t, tipo, cartoes, alvo)
  }
  const faturas = situacaoDasFaturas(s, cartoes)
  if (faturas.length === 1) {
    const f = faturas[0]
    const devidas = devidasDa(f)
    const atrasadas = devidas.filter(d => d.atrasada)
    const somaAtrasada = round2(atrasadas.reduce((a, d) => a + d.valor, 0))
    const listaAtrasadas = atrasadas.length === 1
      ? `A fatura do ${f.nome} de ${fmtBRL(somaAtrasada)} venceu em ${dataCompleta(f.atrasadas[0].date)}`
      : `${atrasadas.length} faturas do ${f.nome} venceram sem pagamento, somando ${fmtBRL(somaAtrasada)}:\n${atrasadas.map(d => `• ${d.linha}`).join('\n')}\n\n`
    const fechadaPaga = f.fechou && f.proxima.total > 0 && f.aPagar <= 0
    const ultimaPaga = f.ultima.total > 0 && f.ultima.pending <= 0.009
    switch (tipo) {
      case 'falta': {
        const total = round2(devidas.reduce((a, d) => a + d.valor, 0))
        const aberta = notaDaAberta(f)
        if (!devidas.length) {
          if (aberta && citados.length === 1 && !/\b(?:vencid[ao]s?|fechad[ao]s?)\b/.test(t)) {
            return { text: `Falta pagar ${fmtBRL(f.aPagar)} da fatura do ${f.nome}, que ainda está aberta. O valor pode mudar até ${dataCompleta(f.proxima.closingDate)}, quando ela fecha.` }
          }
          const paga = fechadaPaga ? `a fatura do ${f.nome} que vence ${venceEm(f.proxima.dueDate)} já está paga.`
            : ultimaPaga ? `a fatura do ${f.nome} que venceu em ${dataCompleta(f.ultima.dueDate)} está paga.`
              : `não há fatura vencida ou fechada para pagar no ${f.nome}.`
          return { text: [`Não falta nada: ${paga}`, aberta].filter(Boolean).join(' ') }
        }
        const corpo = devidas.length === 1
          ? atrasadas.length
            ? `Falta pagar ${fmtBRL(total)} da fatura do ${f.nome}. Ela venceu em ${dataCompleta(f.atrasadas[0].date)} e está atrasada.`
            : `Falta pagar ${fmtBRL(total)} da fatura do ${f.nome}, que já fechou e vence ${venceEm(f.proxima.dueDate)}.`
          : `Falta pagar ${fmtBRL(total)} em faturas do ${f.nome}:\n${devidas.map(d => `• ${d.linha}`).join('\n')}`
        return { text: [corpo, aberta].filter(Boolean).join('\n\n') }
      }
      case 'paga': {
        if (atrasadas.length) {
          return { text: atrasadas.length === 1 ? `Não. ${listaAtrasadas} e ainda não foi paga.` : `Não. ${listaAtrasadas.trim()}` }
        }
        if (f.fechou && f.aPagar > 0) {
          return { text: f.proxima.paid > 0.009
            ? `Não toda. Você já pagou ${fmtBRL(f.proxima.paid)} da fatura do ${f.nome} e falta ${fmtBRL(f.aPagar)} até ${dataCompleta(f.proxima.dueDate)}.`
            : `Não. A fatura do ${f.nome} já fechou e falta pagar ${fmtBRL(f.aPagar)} até ${dataCompleta(f.proxima.dueDate)}.` }
        }
        if (fechadaPaga) return { text: `Sim. A fatura do ${f.nome} de ${fmtBRL(f.proxima.total)}, que vence ${venceEm(f.proxima.dueDate)}, está paga.` }
        if (ultimaPaga) {
          return { text: [`Sim. A fatura do ${f.nome} de ${fmtBRL(f.ultima.total)}, que venceu em ${dataCompleta(f.ultima.dueDate)}, está paga.`, notaDaAberta(f)].filter(Boolean).join(' ') }
        }
        const aberta = notaDaAberta(f, 'A atual')
        return { text: aberta ? `Ainda não há fatura fechada para pagar no ${f.nome}. ${aberta}` : `O ${f.nome} não tem fatura com valor para pagar agora.` }
      }
      case 'atrasada': {
        if (atrasadas.length) return { text: atrasadas.length === 1 ? `Sim. ${listaAtrasadas} e não foi paga.` : `Sim. ${listaAtrasadas.trim()}` }
        const proxima = f.aPagar > 0 ? ` Ela vence ${venceEm(f.proxima.dueDate)}, com ${fmtBRL(f.aPagar)} a pagar${f.fechou ? '' : ' até agora'}.` : ''
        return { text: `Não, a fatura do ${f.nome} não está atrasada.${proxima}` }
      }
      case 'vence': {
        const valor = fechadaPaga ? ' e já está paga'
          : f.aPagar > 0 ? `, com ${fmtBRL(f.aPagar)} ${f.fechou ? 'a pagar' : 'até agora (ainda aberta)'}` : ''
        if (atrasadas.length) {
          return { text: `A fatura do ${f.nome} venceu em ${dataCompleta(f.atrasadas[0].date)} e está atrasada: falta ${fmtBRL(somaAtrasada)}. A próxima vence ${venceEm(f.proxima.dueDate)}${valor}.` }
        }
        return { text: `A fatura do ${f.nome} vence ${venceEm(f.proxima.dueDate)}${valor}.` }
      }
      case 'fecha': {
        const regra = `A fatura do ${f.nome} fecha todo dia ${f.closingDay} e vence todo dia ${f.dueDay}.`
        const atual = f.fechou
          ? `A atual fechou em ${dataCompleta(f.proxima.closingDate)} e vence ${venceEm(f.proxima.dueDate)}; a próxima fecha em ${dataCompleta(f.fechaDepois)}.`
          : `A atual fecha em ${dataCompleta(f.proxima.closingDate)} e vence em ${dataCompleta(f.proxima.dueDate)}.`
        const atraso = atrasadas.length
          ? `\n\nAtenção: ${atrasadas.length === 1 ? `a de ${dataCompleta(f.atrasadas[0].date)} venceu sem pagamento` : `${atrasadas.length} faturas venceram sem pagamento`} — falta ${fmtBRL(somaAtrasada)}.`
          : ''
        // "Já fechou?" é sim/não; a regra do cartão não precisa vir junto.
        if (/\bfechou\b/.test(t)) {
          return { text: (f.fechou
            ? `Sim. A fatura do ${f.nome} fechou em ${dataCompleta(f.proxima.closingDate)} e vence ${venceEm(f.proxima.dueDate)}; a próxima fecha em ${dataCompleta(f.fechaDepois)}.`
            : `Ainda não. A fatura do ${f.nome} fecha em ${dataCompleta(f.proxima.closingDate)} e vence em ${dataCompleta(f.proxima.dueDate)}.`) + atraso }
        }
        return { text: `${regra} ${atual}${atraso}` }
      }
      case 'valor': {
        if (atrasadas.length) {
          return { text: [`${listaAtrasadas.trim()}${atrasadas.length === 1 ? ' e está atrasada.' : ''}`, notaDaAberta(f)].filter(Boolean).join('\n\n') }
        }
        if (f.fechou && f.proxima.total > 0) {
          const fechou = `A fatura do ${f.nome} fechou em ${fmtBRL(f.proxima.total)}`
          if (fechadaPaga) return { text: `${fechou} e já está paga (vence ${venceEm(f.proxima.dueDate)}).` }
          return { text: `${fechou} e vence ${venceEm(f.proxima.dueDate)}.${f.proxima.paid > 0.009
            ? ` Você já pagou ${fmtBRL(f.proxima.paid)}; falta ${fmtBRL(f.aPagar)}.` : ''}` }
        }
        const aberta = notaDaAberta(f, `A fatura atual do ${f.nome}`)
        return { text: aberta || `A fatura atual do ${f.nome} ainda está sem valor: fecha em ${dataCompleta(f.proxima.closingDate)} e vence em ${dataCompleta(f.proxima.dueDate)}.` }
      }
    }
  }

  // A atrasada vem primeiro: a ordem dos cartões cadastrados não diz nada.
  const devidas = faturas.flatMap(f => devidasDa(f).map(d => ({ ...d, nome: f.nome })))
    .sort((a, b) => a.data.localeCompare(b.data))
  const total = round2(devidas.reduce((a, d) => a + d.valor, 0))
  const linhas = (itens: typeof devidas) => itens.map(d => `• ${d.nome}: ${d.linha}`).join('\n')
  const abertas = faturas.filter(f => !f.fechou && f.aPagar > 0)
    .map(f => `• ${f.nome}: ${fmtBRL(f.aPagar)} — fecha em ${dataCompleta(f.proxima.closingDate)}, vence em ${dataCompleta(f.proxima.dueDate)}`)
  const notaAbertas = abertas.length ? `Ainda ${abertas.length === 1 ? 'aberta' : 'abertas'}, o valor pode crescer até fechar:\n${abertas.join('\n')}` : ''
  switch (tipo) {
    case 'falta':
    case 'paga':
    case 'valor': {
      const corpo = devidas.length
        ? `${tipo === 'paga' ? 'Não. ' : ''}Falta pagar ${fmtBRL(total)} em faturas:\n${linhas(devidas)}`
        : `${tipo === 'paga' ? 'Sim. ' : ''}Nenhuma fatura vencida ou fechada está esperando pagamento.`
      return { text: [corpo, notaAbertas].filter(Boolean).join('\n\n') }
    }
    case 'atrasada': {
      const atrasadas = devidas.filter(d => d.atrasada)
      if (atrasadas.length) {
        const soma = round2(atrasadas.reduce((a, d) => a + d.valor, 0))
        return { text: `Sim. ${atrasadas.length === 1 ? 'Uma fatura está atrasada' : `${atrasadas.length} faturas estão atrasadas, somando ${fmtBRL(soma)}`}:\n${linhas(atrasadas)}` }
      }
      const proxima = faturas.filter(f => f.aPagar > 0).sort((a, b) => a.proxima.dueDate.localeCompare(b.proxima.dueDate))[0]
      return { text: `Não, nenhuma fatura está atrasada.${proxima ? ` A próxima a vencer é a do ${proxima.nome}, ${venceEm(proxima.proxima.dueDate)}, com ${fmtBRL(proxima.aPagar)}${proxima.fechou ? '' : ' até agora'}.` : ''}` }
    }
    case 'vence':
      return { text: `Vencimento das faturas:\n${faturas.map(f => {
        const atrasada = devidasDa(f).filter(d => d.atrasada)
        const valor = f.aPagar > 0 ? ` — ${fmtBRL(f.aPagar)}${f.fechou ? '' : ' até agora'}` : ''
        return `• ${f.nome}: ${atrasada.length ? `venceu em ${dataCompleta(f.atrasadas[0].date)}, atrasada; a próxima vence ${venceEm(f.proxima.dueDate)}` : `vence ${venceEm(f.proxima.dueDate)}`}${valor}`
      }).join('\n')}` }
    case 'fecha':
      return { text: `Fechamento das faturas:\n${faturas.map(f => `• ${f.nome}: fecha todo dia ${f.closingDay} e vence todo dia ${f.dueDay}`).join('\n')}` }
  }
}

const NOMES_DOS_MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const nomeDoMes = (mk: string) => NOMES_DOS_MESES[Number(mk.slice(5, 7)) - 1]
/** Arredonda PARA CIMA no centavo: a soma das parcelas nunca fica abaixo do total. */
const porMesAcima = (valor: number, meses: number) => Math.ceil((valor / meses) * 100) / 100
const depositosAte = (meses: string[]) => `${meses.length === 1 ? 'É 1 depósito' : `São ${meses.length} depósitos`} até ${nomeDoMes(meses[meses.length - 1])} (${listaDeNomes(meses.map(nomeDoMes))})`

/** A meta de compra ativa citada pelo nome; o nome mais longo ganha. */
function metaCitada(s: AppState, t: string) {
  return (s.goals || []).filter(g => !g.done && g.name?.trim())
    .map(g => ({ g, n: normalizeQuestion(g.name) }))
    .filter(({ n }) => n.length >= 2 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))
    .sort((a, b) => b.n.length - a.n.length)[0]?.g
}

/** Média de entradas menos saídas nos últimos meses COMPLETOS que têm lançamento. */
function sobraMedia(s: AppState, meses = 3): { media: number; meses: number } | null {
  const h = fromISO(todayISO())
  const sobras: number[] = []
  for (let n = 1; n <= meses; n++) {
    const ini = toISO(new Date(h.getFullYear(), h.getMonth() - n, 1))
    const fim = toISO(new Date(h.getFullYear(), h.getMonth() - n + 1, 0))
    if (!s.transactions.some(x => x.date >= ini && x.date <= fim && (x.type === 'income' || x.type === 'expense'))) continue
    sobras.push(periodStats(s, ini, fim).profit)
  }
  return sobras.length ? { media: round2(sobras.reduce((a, v) => a + v, 0) / sobras.length), meses: sobras.length } : null
}

/**
 * Quanto guardar por mês para uma meta, para um valor ou para a meta mensal —
 * e se dá, comparado com o que costuma sobrar. Os meses de depósito são
 * NOMEADOS: "até dezembro" no fim de outubro são novembro e dezembro, e quem
 * lê confere a conta. Sem prazo, mostra dois exemplos e pergunta.
 */
function respostaDePlano(s: AppState, t: string, plano: PlanoDeGuardar, driverMode: boolean): AiReply | null {
  const hoje = todayISO()
  if (plano.kind === 'mensal') {
    const alvo = Math.max(s.settings.monthlyProfitTarget || 0, 0)
    if (driverMode) {
      return { text: alvo > 0
        ? `Você não tem uma meta de guardar por mês; o objetivo cadastrado é de lucro: ${fmtBRL(alvo)} por mês.`
        : 'Você ainda não cadastrou objetivo mensal. Dá para definir em Mais → Configurações.' }
    }
    if (alvo <= 0) return { text: 'Você ainda não definiu quanto quer guardar por mês. Dá para definir em Mais → Configurações, em "Quanto deseja guardar por mês".' }
    const guardado = savedThisMonth(s, hoje)
    return { text: `Sua meta é guardar ${fmtBRL(alvo)} por mês. Este mês você já guardou ${fmtBRL(guardado)}${guardado >= alvo - 0.009 ? ' — meta batida.' : `; faltam ${fmtBRL(round2(alvo - guardado))}.`}` }
  }
  if (plano.kind === 'valor') {
    const meses = mesesAtePrazo(t, hoje)
    if (!meses) {
      return { text: `Para juntar ${fmtBRL(plano.valor)}: em 6 meses são ${fmtBRL(porMesAcima(plano.valor, 6))} por mês; em 12, ${fmtBRL(porMesAcima(plano.valor, 12))}. Até quando você quer juntar?` }
    }
    // "Quanto preciso separar POR SEMANA": a conta é em semanas até o fim do
    // último mês dito, não em meses — e responder em meses ignorava a pergunta.
    if (/\bpor\s+semana\b|\bsemanal(?:mente)?\b|\bcada\s+semana\b|\btoda\s+semana\b/.test(t)) {
      const ultimo = meses[meses.length - 1]
      const [ay, am] = ultimo.split('-').map(Number)
      const fim = toISO(new Date(ay, am, 0))
      const semanas = Math.max(1, Math.ceil(daysBetween(hoje, fim) / 7))
      return { text: `Para juntar ${fmtBRL(plano.valor)} até ${diaMes(fim)}, contando de agora e sem o que você já tem guardado: são ${semanas} semanas, de ${fmtBRL(porMesAcima(plano.valor, semanas))} por semana (${fmtBRL(porMesAcima(plano.valor, meses.length))} por mês).` }
    }
    return { text: `Para juntar ${fmtBRL(plano.valor)}, contando de agora e sem o que você já tem guardado: ${depositosAte(meses).replace(/^É|^São/, m => m.toLowerCase())}, de ${fmtBRL(porMesAcima(plano.valor, meses.length))} por mês.` }
  }
  const meta = metaCitada(s, t)
  if (!meta) {
    const ativas = (s.goals || []).filter(g => !g.done)
    if (!ativas.length) return null
    return { text: `Não encontrei essa meta. Suas metas: ${listaDeNomes(ativas.map(g => g.name))}. Para criar outra, diga algo como "quero comprar um celular de 5000 em 6 meses".` }
  }
  const falta = round2(meta.target - meta.saved)
  if (falta <= 0.009) return { text: `A meta ${meta.name} já está completa: ${fmtBRL(meta.saved)} de ${fmtBRL(meta.target)}.` }
  const meses = mesesAtePrazo(t, hoje, meta.deadline)
  if (!meses) {
    return { text: `Faltam ${fmtBRL(falta)} para a meta ${meta.name}, e ela não tem prazo. Em 6 meses seriam ${fmtBRL(porMesAcima(falta, 6))} por mês; em 12, ${fmtBRL(porMesAcima(falta, 12))}. Até quando você quer completar?` }
  }
  const mensal = porMesAcima(falta, meses.length)
  const conta = `${depositosAte(meses)}: ${fmtBRL(mensal)} por mês`
  if (!plano.viavel) return { text: `Faltam ${fmtBRL(falta)} para a meta ${meta.name}. ${conta}.` }
  const sobra = sobraMedia(s)
  if (!sobra) return { text: `Faltam ${fmtBRL(falta)} para a meta ${meta.name}. ${conta}. Ainda não tenho um mês completo para comparar com o que costuma sobrar.` }
  const ritmo = sobra.meses === 1 ? 'do último mês completo' : `dos últimos ${sobra.meses} meses completos`
  const aviso = 'É uma estimativa: o que sobrou antes não garante o que vai sobrar.'
  const qualMeta = `Faltam ${fmtBRL(falta)} para a meta ${meta.name}.`
  if (mensal <= sobra.media + 0.009) {
    return { text: `Sim, no ritmo ${ritmo}. ${qualMeta} ${conta}, e sobraram em média ${fmtBRL(sobra.media)} por mês. ${aviso}` }
  }
  return { text: `Não no ritmo ${ritmo}. ${qualMeta} ${conta}, e sobraram em média ${fmtBRL(sobra.media)} por mês — faltariam ${fmtBRL(round2(mensal - Math.max(sobra.media, 0)))} por mês. ${aviso}` }
}

const NOMES_DA_SEMANA: { um: string; varios: string; feminino: boolean }[] = [
  { um: 'domingo', varios: 'domingos', feminino: false }, { um: 'segunda', varios: 'segundas', feminino: true },
  { um: 'terça', varios: 'terças', feminino: true }, { um: 'quarta', varios: 'quartas', feminino: true },
  { um: 'quinta', varios: 'quintas', feminino: true }, { um: 'sexta', varios: 'sextas', feminino: true },
  { um: 'sábado', varios: 'sábados', feminino: false },
]

/**
 * Lucro médio do dia da semana perguntado contra o dos outros dias, nos dias
 * com lançamento dos últimos 90 (hoje fora, porque ainda não acabou). Sem
 * nenhum daquele dia, o app diz que não tem base — e o que tem.
 */
function respostaDoDiaDaSemana(s: AppState, alvo: number): AiReply {
  const hoje = todayISO()
  const ini = addDays(hoje, -90)
  // Dia TRABALHADO é dia com entrada ou com registro de trabalho. Um domingo
  // em que só houve a troca de óleo não é "domingo rendendo -R$ 280": o custo
  // é real, o dia de trabalho não existiu.
  const trabalhados = new Set<string>()
  for (const x of s.transactions) if (x.type === 'income' && x.date >= ini && x.date < hoje) trabalhados.add(x.date)
  for (const w of s.workSessions || []) if (w.date >= ini && w.date < hoje && ((w.km || 0) > 0 || (w.hours || 0) > 0 || (w.trips || 0) > 0)) trabalhados.add(w.date)
  const porDia = new Map<string, number>()
  for (const x of s.transactions) {
    if (x.date < ini || x.date >= hoje || (x.type !== 'income' && x.type !== 'expense')) continue
    if (!trabalhados.has(x.date)) continue
    porDia.set(x.date, (porDia.get(x.date) || 0) + (x.type === 'income' ? x.amount : -x.amount))
  }
  const media = (xs: number[]) => xs.length ? round2(xs.reduce((a, v) => a + v, 0) / xs.length) : 0
  const doAlvo = [...porDia].filter(([d]) => fromISO(d).getDay() === alvo).map(([, v]) => v)
  const outros = [...porDia].filter(([d]) => fromISO(d).getDay() !== alvo).map(([, v]) => v)
  const nome = NOMES_DA_SEMANA[alvo]
  if (!doAlvo.length) {
    const porSemana = NOMES_DA_SEMANA.map((_, wd) => ({ wd, m: media([...porDia].filter(([d]) => fromISO(d).getDay() === wd).map(([, v]) => v)) }))
      .filter(x => x.wd !== alvo && x.m !== 0).sort((a, b) => b.m - a.m)
    const [melhor, segundo] = porSemana
    // Empate é dito, não desempatado (regra 56), com a mesma margem da consulta.
    const empate = melhor && segundo && Math.abs(melhor.m - segundo.m) / Math.max(Math.abs(melhor.m), 1) <= MARGEM_EMPATE
      ? `, praticamente empatado com ${NOMES_DA_SEMANA[segundo.wd].um} (${fmtBRL(segundo.m)})` : ''
    return { text: `Você não tem ${nome.feminino ? 'nenhuma' : 'nenhum'} ${nome.um} registrad${nome.feminino ? 'a' : 'o'} nos últimos 90 dias, então não sei dizer pelo seu histórico.`
      + (outros.length ? ` Nos dias em que você trabalha, o lucro médio é de ${fmtBRL(media(outros))} por dia${melhor ? `; o melhor dia tem sido ${NOMES_DA_SEMANA[melhor.wd].um} (${fmtBRL(melhor.m)})${empate}` : ''}.` : '') }
  }
  const m = media(doAlvo)
  const mo = media(outros)
  const base = doAlvo.length < 4 ? ` É uma estimativa com pouca base: ${doAlvo.length} ${doAlvo.length === 1 ? nome.um : nome.varios}.` : ' É uma estimativa pelo seu histórico.'
  return { text: `Pelo seu histórico, ${nome.um} rende ${m >= mo ? 'mais' : 'menos'} que os outros dias: lucro médio de ${fmtBRL(m)} contra ${fmtBRL(mo)} nos outros dias.${base}` }
}

/**
 * Hoje contra o lucro médio dos dias com registro nos 30 dias anteriores; para
 * o motorista, a meta do dia também. "Foi bom?"/"foi fraco?" abre com sim ou
 * não (regra 57) — na direção da palavra que a pessoa usou.
 */
function respostaDoDia(s: AppState, t: string, driverMode: boolean): AiReply {
  const dia = todayStats(s)
  if (!(dia.income > 0) && !(dia.expense > 0)) {
    return { text: 'Hoje ainda não tem nada registrado. Me conta como foi — "fiz 300 hoje" ou "gastei 50 de gasolina" — que eu lanço e comparo com seus outros dias.' }
  }
  const lucro = round2(dia.profit)
  const media = round2(avgDailyProfit(s))
  const temMedia = Math.abs(media) > 0.005
  const acima = lucro >= media
  const pedeBom = /\b(?:bom|boa|bem|legal|forte|razoavel)\b/.test(t)
  const pedeFraco = /\b(?:fraco|ruim)\b/.test(t)
  const lead = !temMedia ? ''
    : pedeBom ? (acima ? 'Sim, acima da sua média. ' : 'Não, ficou abaixo da sua média. ')
      : pedeFraco ? (acima ? 'Não, ficou acima da sua média. ' : 'Sim, abaixo da sua média. ') : ''
  const nome = driverMode ? 'lucro' : 'sobra'
  const partes = [`${lead}Hoje: ${fmtBRL(dia.income)} de entradas e ${fmtBRL(dia.expense)} de saídas — ${nome} de ${fmtBRL(lucro)} (dado real).`]
  if (temMedia) {
    const diff = round2(Math.abs(lucro - media))
    // A média é de dias INTEIROS; hoje pode não ter acabado.
    partes.push(`Nos dias com registro dos últimos 30, a média foi de ${fmtBRL(media)}: hoje ficou ${diff < 0.005 ? 'igual' : `${fmtBRL(diff)} ${acima ? 'acima' : 'abaixo'}`}`
      + `${acima ? '' : ' — se o dia ainda não acabou, essa conta muda'}.`)
  }
  if (driverMode) {
    const meta = round2(dailyGoal(s).total)
    if (meta > 0) partes.push(lucro >= meta ? `A meta de hoje (${fmtBRL(meta)}) foi batida.` : `A meta de hoje é ${fmtBRL(meta)}: faltam ${fmtBRL(round2(meta - lucro))}.`)
  }
  return { text: partes.join('\n\n') }
}

/**
 * Entradas menos combustível no período (este mês, se nada for dito), e por
 * dia corrido quando pedido. As outras despesas vêm à parte: quem pergunta
 * "tirando a gasolina" quer esse desconto primeiro, mas não pode achar que
 * sobrou o que a troca de óleo já levou.
 */
function respostaSobraSemCombustivel(s: AppState, t: string): AiReply {
  const hoje = todayISO()
  const dito = /\bhoje\b|\bontem\b|\bsemana\b|\bmes\s+passado\b/.test(t) ? periodFromText(t) : null
  const p = dito || { from: `${hoje.slice(0, 8)}01`, to: hoje, label: 'este mês' }
  const txs = s.transactions.filter(x => x.date >= p.from && x.date <= p.to)
  const soma = (f: (x: typeof txs[number]) => boolean) => round2(txs.filter(f).reduce((a, x) => a + x.amount, 0))
  const entradas = soma(x => x.type === 'income')
  const combustivel = soma(x => x.type === 'expense' && x.category === 'combustivel')
  const outras = soma(x => x.type === 'expense' && x.category !== 'combustivel')
  if (!entradas && !combustivel) return { text: `Não tenho entradas nem combustível registrados ${p.label}.` }
  const dias = Math.round((fromISO(p.to).getTime() - fromISO(p.from).getTime()) / 86400000) + 1
  const porDia = /\bpor\s+dia\b|\bao\s+dia\b|\bdiari[oa]\b/.test(t) && dias > 1
  const sobra = round2(entradas - combustivel)
  const conta = `${fmtBRL(entradas)} de entradas menos ${fmtBRL(combustivel)} de combustível`
  const primeira = porDia
    ? `Tirando o combustível, sobram ${fmtBRL(round2(sobra / dias))} por dia ${p.label} (dado real): ${conta}, em ${dias} dias corridos.`
    : `Tirando o combustível, sobram ${fmtBRL(sobra)} ${p.label} (dado real): ${conta}.`
  const resto = outras > 0.009
    ? `Com as outras despesas (${fmtBRL(outras)}), sobram ${porDia ? `${fmtBRL(round2((sobra - outras) / dias))} por dia` : fmtBRL(round2(sobra - outras))}.`
    : ''
  return { text: [primeira, resto].filter(Boolean).join(' ') }
}

/**
 * A resposta da META citada pelo nome, para frase que o turno leu como hipótese:
 * "consigo comprar o notebook até março?" (plano com prazo) e "quando consigo
 * comprar o notebook" (projeção). Sem meta com esse nome, `null`: a frase segue
 * como hipótese de compra.
 */
export function respostaDeMetaCitada(s: AppState, input: string): string | null {
  const t = normalizeQuestion(input)
  if (!metaCitada(s, t)) return null
  const plano = planoDeGuardar(t)
  if (plano?.kind !== 'meta' && !/\bquando\b/.test(t)) return null
  const r = resolveLocal(s, input)
  return r.handled === false || r.actions?.length ? null : r.text
}

/**
 * "Quando acaba a geladeira", "quando quito o computador": a data, nunca "vale
 * a pena quitar", que é decisão e vai para quem raciocina.
 */
const FIM_DO_PLANO = /\b(?:quando|que\s+mes|que\s+dia)\b[^?]*\b(?:acaba|acabo|termina|termino|quita|quito)\b|\bultimas?\s+parcelas?\b/

/** "Quando comprei a geladeira": a data da compra parcelada. */
const COMPRA_DO_PLANO = /\bquando\b[^?]*\b(?:comprei|compramos|parcelei|foi\s+a\s+compra)\b|\bque\s+dia\s+(?:eu\s+)?comprei\b/

/** O parcelamento ativo citado pelo nome da compra ("a geladeira"). */
function planoCitado(s: AppState, t: string) {
  return activePlans(s).filter(p => p.description?.trim())
    .map(p => ({ p, n: normalizeQuestion(p.description) }))
    .filter(({ n }) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))
    .sort((a, b) => b.n.length - a.n.length)[0]?.p
}

/**
 * "Quando acaba a geladeira" (a última parcela) e "qual minha maior parcela"
 * (a próxima parcela de cada parcelamento, com empate dito — regra 56). O
 * resumo dos cartões respondia as duas como se fossem a mesma pergunta.
 */
function respostaDoParcelamento(s: AppState, t: string): AiReply | null {
  const pendentes = (planId: string) => (s.installments || [])
    .filter(i => i.planId === planId && i.status === 'pending')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const nome = (p: { description?: string }) => sentenceCase(p.description || 'Parcelamento')
  const fim = (p: { id: string, description?: string }) => {
    const resto = pendentes(p.id)
    const ultima = resto[resto.length - 1]
    const soma = round2(resto.reduce((a, i) => a + i.amount - Math.min(Math.max(i.paidAmount || 0, 0), i.amount), 0))
    const iguais = resto.every(i => Math.abs(i.amount - resto[0].amount) < 0.005)
    return { ultima, frase: `termina em ${dataCompleta(ultima.dueDate)} (parcela ${ultima.number}/${ultima.total}): faltam ${resto.length} ${resto.length === 1 ? 'parcela' : 'parcelas'}`
      + `${iguais ? ` de ${fmtBRL(resto[0].amount)}` : ''}, ${fmtBRL(soma)} ao todo` }
  }
  const plano = planoCitado(s, t)
  const cartaoDo = (p: { cardId?: string }) => (s.cards || []).find(c => c.id === p.cardId)?.name
  if (plano && COMPRA_DO_PLANO.test(t)) {
    const onde = cartaoDo(plano)
    return { text: `${nome(plano)}: compra em ${dataCompleta(plano.purchaseDate)}, ${fmtBRL(plano.totalAmount)} em ${plano.installmentCount}x`
      + `${onde ? ` no ${onde}` : ''}. ${fim(plano).frase.replace(/^termina/, 'Termina')}.` }
  }
  if (pedeListaDeParcelamentos(t)) {
    const cartoes = cartoesDaPergunta(s, t)
    const planos = activePlans(s).filter(p => !cartoes.length || cartoes.some(c => c.id === p.cardId))
      .filter(p => pendentes(p.id).length)
    const onde = cartoes.length ? `No ${listaDeNomes(cartoes.map(c => c.name))},` : 'Você tem'
    if (!planos.length) return { text: `${cartoes.length ? `${onde} nenhum` : 'Você não tem'} parcelamento com parcela a pagar.` }
    const parcelas = planos.reduce((a, p) => a + pendentes(p.id).length, 0)
    const resta = round2(planos.reduce((a, p) => a + pendentes(p.id).reduce((b, i) => b + i.amount - Math.min(Math.max(i.paidAmount || 0, 0), i.amount), 0), 0))
    const linhas = planos.map(p => {
      const r = pendentes(p.id)
      const c = cartaoDo(p)
      return `• ${nome(p)}${c ? ` (${c})` : ''}: ${fmtBRL(p.totalAmount)} em ${p.installmentCount}x — faltam ${r.length} `
        + `${r.length === 1 ? 'parcela' : 'parcelas'}, ${fmtBRL(round2(r.reduce((a, i) => a + i.amount - Math.min(Math.max(i.paidAmount || 0, 0), i.amount), 0)))}, até ${dataCompleta(r[r.length - 1].dueDate)}`
    })
    return { text: `${onde} ${planos.length} ${planos.length === 1 ? 'parcelamento' : 'parcelamentos'} com parcela a pagar: `
      + `${parcelas} ${parcelas === 1 ? 'parcela' : 'parcelas'}, ${fmtBRL(resta)} ao todo.\n\n${linhas.join('\n')}` }
  }
  if (plano && (pedeFimDoParcelamento(t) || FIM_DO_PLANO.test(t))) {
    if (!pendentes(plano.id).length) return { text: `O parcelamento ${plano.description} não tem parcela pendente.` }
    return { text: `${nome(plano)} ${fim(plano).frase}.` }
  }
  // Sem o nome: os parcelamentos do cartão citado, ou todos; o último primeiro.
  if (pedeFimDoParcelamento(t)) {
    const cartoes = cartoesDaPergunta(s, t)
    const dito = t.match(/\bparcelas?\s+d[oa]s?\s+(?:meu\s+|minha\s+)?(?:cartao\s+(?:d[oa]\s+)?)?([a-z][a-z0-9]*)/)
    if (!cartoes.length && dito && !/^(?:cartao|cartoes|credito|mes|meses|ano|semana|dia|atual|agora|parcelamento|parcelamentos|compra|compras)$/.test(dito[1])) {
      return { text: `Não encontrei cartão nem parcelamento chamado ${sentenceCase(dito[1])}. Seus parcelamentos: ${listaDeNomes(activePlans(s).map(nome))}.` }
    }
    const doCartao = cartoes.length ? activePlans(s).filter(p => cartoes.some(c => c.id === p.cardId)) : activePlans(s)
    const vivos = doCartao.filter(p => pendentes(p.id).length).map(p => ({ p, ...fim(p) }))
      .sort((a, b) => b.ultima.dueDate.localeCompare(a.ultima.dueDate))
    const onde = cartoes.length ? ` no ${listaDeNomes(cartoes.map(c => c.name))}` : ''
    if (!vivos.length) return { text: `Você não tem parcela pendente${onde}.` }
    if (vivos.length === 1) return { text: `${nome(vivos[0].p)}${onde} ${vivos[0].frase}.` }
    return { text: `A última parcela${onde} é a do parcelamento ${nome(vivos[0].p)}, em ${dataCompleta(vivos[0].ultima.dueDate)}.\n\n`
      + vivos.map(x => `• ${nome(x.p)}: ${x.frase}`).join('\n') }
  }
  if (pedeMaiorParcela(t)) {
    const proximas = activePlans(s).map(p => ({ p, prox: pendentes(p.id)[0], restam: pendentes(p.id).length })).filter(x => x.prox)
    if (!proximas.length) return { text: 'Você não tem parcela pendente.' }
    const maior = Math.max(...proximas.map(x => x.prox!.amount))
    const topo = proximas.filter(x => Math.abs(x.prox!.amount - maior) < 0.005)
    const linhas = proximas.sort((a, b) => b.prox!.amount - a.prox!.amount)
      .map(x => `• ${nome(x.p)}: ${fmtBRL(x.prox!.amount)} (${x.restam} ${x.restam === 1 ? 'restante' : 'restantes'})`)
    const abre = topo.length > 1
      ? `A maior parcela é de ${fmtBRL(maior)}, e é empate: ${listaDeNomes(topo.map(x => nome(x.p)))}.`
      : `A maior parcela é a do parcelamento ${nome(topo[0].p)}: ${fmtBRL(maior)}.`
    return { text: `${abre}\n\n${linhas.join('\n')}` }
  }
  return null
}

/** Quanto uma conta fixa pesa por mês, seja qual for a repetição dela. */
function equivalenteMensal(r: RecurringExpense): number {
  const { interval, unit } = recurrenceStep(r)
  const n = Math.max(interval || 1, 1)
  const porMes = unit === 'year' ? r.amount / (12 * n)
    : unit === 'week' ? (r.amount * 52) / (12 * n)
      : unit === 'day' ? (r.amount * 365) / (12 * n)
        : r.amount / n
  return round2(porMes)
}

/**
 * As contas fixas ativas, cada uma com a regra dela e o peso mensal; o
 * motorista soma o custo fixo do carro que cadastrou em Configurações.
 */
function respostaDasContasFixas(s: AppState, driverMode: boolean, pedeMaior = false): AiReply {
  const hoje = todayISO()
  const contas = (s.recurring || []).filter(r => r.kind !== 'income' && r.active !== false && (!r.endDate || r.endDate >= hoje))
  const carro = driverMode ? Math.max(s.settings.fixedMonthlyCosts || 0, 0) : 0
  if (!contas.length && !carro) {
    return { text: 'Você não tem conta fixa cadastrada. Cadastre em Planejamento que eu passo a acompanhar e avisar os vencimentos.' }
  }
  const linhas = contas.map(r => {
    const mensal = equivalenteMensal(r)
    const regra = describeRecurrence(r)
    const peso = Math.abs(mensal - r.amount) > 0.009 ? ` (≈ ${fmtBRL(mensal)} por mês)` : ''
    return { mensal, linha: `• ${r.name.trim()}: ${fmtBRL(r.amount)} — ${regra.charAt(0).toLowerCase()}${regra.slice(1)}${peso}` }
  })
  const somaContas = round2(linhas.reduce((a, l) => a + l.mensal, 0))
  const partes: string[] = []
  // "Qual a MAIOR": a resposta vem primeiro, a lista depois.
  if (pedeMaior && contas.length) {
    const topo = [...linhas].sort((a, b) => b.mensal - a.mensal)
    const empate = topo.length > 1 && Math.abs(topo[0].mensal - topo[1].mensal) < 0.005
    partes.push(empate
      ? `Há empate: as duas maiores pesam ${fmtBRL(topo[0].mensal)} por mês.`
      : `A maior é ${contas[linhas.indexOf(topo[0])].name.trim()}: ${fmtBRL(topo[0].mensal)} por mês.`)
  }
  if (contas.length) {
    partes.push(`Suas contas fixas somam ${fmtBRL(somaContas)} por mês:\n${linhas.map(l => l.linha).join('\n')}`)
  }
  if (carro) {
    partes.push(contas.length
      ? `Além disso, o custo fixo mensal cadastrado em Configurações é ${fmtBRL(carro)} — ao todo, ${fmtBRL(round2(somaContas + carro))} por mês.`
      : `Seu custo fixo mensal cadastrado em Configurações é ${fmtBRL(carro)} (seguro, IPVA, financiamento e o que mais você somou ali).`)
  }
  return { text: partes.join('\n\n') }
}

/** A conta fixa (saída) citada pelo nome; o nome mais longo ganha ("Luz casa 2" antes de "Luz"). */
function contaCitada(s: AppState, t: string): RecurringExpense | undefined {
  return (s.recurring || [])
    .filter(r => r.kind !== 'income' && r.active !== false)
    .map(r => ({ r, n: normalizeQuestion(r.name) }))
    .filter(({ n }) => n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))
    .sort((a, b) => b.n.length - a.n.length)[0]?.r
}

/**
 * Paga, vencimento e valor de uma conta fixa, pelas ocorrências DELA. Sem
 * artigo antes do nome ("a conta Luz"): o gênero do nome que o usuário deu não
 * é inferido (regra 45).
 */
function respostaDaConta(s: AppState, r: RecurringExpense, tipo: PerguntaDeConta): AiReply {
  const hoje = todayISO()
  const nome = r.name.trim()
  const vencidas = occurrencesBetween(r, addDays(hoje, -62), hoje).filter(d => recurringActiveOn(r, d))
  const ultima = vencidas[vencidas.length - 1]
  const status = (d: string) => recurringOccurrenceState(s, r, d, hoje)
  const proxima = occurrencesBetween(r, addDays(hoje, 1), addDays(hoje, 400))
    .find(d => recurringActiveOn(r, d) && !status(d).resolved)
  const paga = (d: string) => status(d).resolved && status(d).record?.status !== 'skipped'
  const pulada = (d: string) => status(d).record?.status === 'skipped'
  const valorDe = (d: string) => {
    const occurrence = status(d)
    return occurrence.futurePaymentDate ? r.amount : occurrence.transaction?.amount ?? occurrence.record?.amount ?? r.amount
  }
  const emAberto = vencidas.filter(d => !status(d).resolved)
  const regra = describeRecurrence(r)
  const quando = regra.charAt(0).toLowerCase() + regra.slice(1)
  const amanha = (d: string) => d === addDays(hoje, 1) ? ' (amanhã)' : ''
  const prox = proxima ? `A próxima vence em ${dataCompleta(proxima)}${amanha(proxima)}.` : ''
  const aberto = emAberto.length
    ? emAberto.length === 1
      ? `A de ${dataCompleta(emAberto[0])} ainda não foi confirmada.`
      : `${emAberto.length} vencimentos dela ainda não foram confirmados, somando ${fmtBRL(round2(emAberto.reduce((a, d) => a + valorDe(d), 0)))}.`
    : ''
  switch (tipo) {
    case 'paga': {
      if (!ultima) {
        return { text: proxima
          ? `Ainda não venceu nenhuma conta ${nome}: a primeira vence em ${dataCompleta(proxima)}${amanha(proxima)}, de ${fmtBRL(r.amount)}.`
          : `Não há vencimento da conta ${nome} nos últimos dois meses.` }
      }
      if (emAberto.length) {
        const ult = emAberto[emAberto.length - 1]
        const futura = status(ult).futurePaymentDate
        if (futura) return { text: `A conta ${nome} de ${dataCompleta(ult)} ainda está em aberto. O lançamento vinculado tem data futura (${dataCompleta(futura)}). Confira a data em Movimentações.` }
        return { text: [`Não está marcada como paga: a conta ${nome} de ${fmtBRL(valorDe(ult))} venceu em ${dataCompleta(ult)} e não foi confirmada.`,
          emAberto.length > 1 ? aberto : '', 'Se já pagou, confirme na tela inicial.'].filter(Boolean).join(' ') }
      }
      if (pulada(ultima)) return { text: [`A conta ${nome} de ${dataCompleta(ultima)} foi marcada como não paga.`, prox].filter(Boolean).join(' ') }
      return { text: [`Sim. A conta ${nome} de ${dataCompleta(ultima)} está paga (${fmtBRL(valorDe(ultima))}).`, prox].filter(Boolean).join(' ') }
    }
    case 'vence':
      if (!proxima) return { text: [`A conta ${nome} não tem próximo vencimento${r.endDate ? `: ela terminou em ${dataCompleta(r.endDate)}` : ''}.`, aberto].filter(Boolean).join(' ') }
      return { text: [`A conta ${nome} vence ${quando}. A próxima é em ${dataCompleta(proxima)}${amanha(proxima)}, de ${fmtBRL(r.amount)}.`, aberto].filter(Boolean).join(' ') }
    case 'valor': {
      const ultimaPaga = ultima && paga(ultima) && Math.abs(valorDe(ultima) - r.amount) > 0.009
        ? `A de ${dataCompleta(ultima)} foi paga com ${fmtBRL(valorDe(ultima))}.` : ''
      return { text: [`A conta ${nome} é de ${fmtBRL(r.amount)}, ${quando}.`, prox, ultimaPaga, aberto].filter(Boolean).join(' ') }
    }
  }
}

/**
 * O texto de ajuda, com `handled: false`: é essa marca que deixa a pergunta
 * seguir para a consulta local ou para o remoto em vez de morrer aqui.
 */
function ajudaGenerica(driverMode: boolean): AiReply {
  return {
    text: driverMode
      ? 'Posso te ajudar com coisas como:\n\n• "ganhei 250 hoje"\n• "gastei 40 de gasolina"\n• "rodei 120 km e fiz 14 viagens"\n• "quanto posso gastar hoje?"\n• "qual o valor mínimo de corrida que vale a pena?"\n• "quanto gastei com gasolina esse mês?"\n• "quando preciso trocar meu óleo?"\n\nOu me faça outra pergunta que eu tento responder.'
      : 'Posso te ajudar com coisas como:\n\n• "recebi 1800 de aluguel"\n• "gastei 250 no mercado"\n• "meu saldo é 3200"\n• "como está meu mês?"\n• "quanto posso guardar este mês?"\n• "tenho saldo para as próximas contas?"\n• "qual foi minha maior despesa?"\n\nOu me faça outra pergunta que eu tento responder.',
    handled: false,
  }
}

/**
 * "Quanto eu costumo gastar em X?" respondido com o vocabulário do usuário.
 *
 * O alvo é resolvido em duas tentativas, nesta ordem: o nome de uma categoria
 * que ele tem, e depois o que o HISTÓRICO dele diz que aquela palavra é. É a
 * segunda que atende quem chama combustível de "suco" ou a padaria de "padoca
 * da Rita" — nenhuma lista de palavras do app conhece esses nomes.
 *
 * Devolve `undefined` quando não há base: somar zero e chamar de hábito seria
 * inventar um número com cara de dado real.
 */
function habitualSpending(s: AppState, alvo: string, escala: string): string | undefined {
  if (alvo.length < 3 || !adaptiveEnabled(s)) return undefined
  const hoje = todayISO()
  const from = addDays(hoje, -29)
  const alvoNorm = normalizeQuestion(alvo)

  const porNome = s.categories.find(c => !c.archived && c.type === 'expense'
    && normalizeQuestion(c.name) === alvoNorm)
  const aprendida = buildPersonalModel(s, hoje).categoryFor(alvo, 'expense')
  // A pergunta é específica demais para cair no texto genérico de ajuda: se
  // não há base, o certo é dizer isso, não somar zero e chamar de hábito.
  const semBase = `Ainda não tenho lançamentos com esse nome nos últimos 30 dias, então não sei dizer quanto você costuma gastar com ${sentenceCase(alvo)}.\n\n`
    + 'Registre algumas vezes ("gastei 40 na padoca da Rita") que eu passo a responder com os seus números.'

  const cat = porNome?.id || aprendida?.value
  if (!cat) return semBase

  // O recorte por DESCRIÇÃO é mais fiel quando o alvo é um lugar: quem pergunta
  // pela padoca não quer o total de alimentação. Só cai na categoria inteira
  // quando o nome citado É o nome de uma categoria.
  const porDescricao = !porNome
  const txs = s.transactions.filter(x => x.type === 'expense' && x.date >= from
    && (porDescricao
      ? normalizeQuestion(x.description || '').includes(alvoNorm)
        || normalizeQuestion(alvo).includes(normalizeQuestion(x.description || '')) && !!x.description
      : x.category === cat))
  if (!txs.length) return semBase

  const total = txs.reduce((a, x) => a + x.amount, 0)
  const diasComGasto = new Set(txs.map(x => x.date)).size
  const nome = catById(s.categories, cat).name
  const rotulo = porNome ? nome : `${sentenceCase(alvo)} (${nome})`
  const divisor = escala === 'dia' ? 30 : escala === 'semana' ? 30 / 7 : 1
  const unidade = escala === 'dia' ? 'por dia' : escala === 'semana' ? 'por semana' : 'por mês'

  return `${rotulo}: você gastou ${fmtBRL(total)} nos últimos 30 dias, em ${txs.length} lançamentos `
    + `espalhados por ${diasComGasto} ${diasComGasto === 1 ? 'dia' : 'dias'} (dado real).\n\n`
    + `• Média: ${fmtBRL(total / divisor)} ${unidade}\n`
    + `• Por vez que você lança: ${fmtBRL(total / txs.length)}\n\n`
    + 'São os seus lançamentos do período, não uma média genérica.'
}

/** Motor de resposta local com marcação de confiança (handled). */
export function askAssistant(s: AppState, input: string): AiReply {
  const r = resolveLocal(s, input)
  return { ...r, engine: 'local', handled: r.handled !== false }
}
