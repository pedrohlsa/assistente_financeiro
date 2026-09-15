// Assistente IA local (seções 8, 37).
// Este módulo responde perguntas usando SOMENTE dados reais do estado — nunca inventa valores.
// Ele diferencia dados reais de estimativas/projeções no texto das respostas.
//
// A integração remota NÃO é pendente: `POST /api/ai/chat` existe nos dois
// backends (dev e Vercel), recebe SÓ contexto agregado (`buildAiContext`, nunca
// a base bruta) e a chave vive apenas no servidor. O que este módulo faz é o
// outro lado: responder localmente tudo que o app sabe com certeza, para que a
// pergunta factual nunca dependa de rede nem de modelo.

import { AppState, ParsedAction } from '../models/types'
import { validateAction, isValidationFailure } from '../assistant/contracts'
import type { AssistantErrorCode } from '../assistant/contracts'
import { buildCapabilities } from '../assistant/capabilities'
import {
  addDays, dueLabel, fmtBRL, fmtNum, fromISO, todayISO, daysInMonth, parseMoney,
} from '../utils/format'
import { promptSafe, sentenceCase } from '../utils/text'
import { MAX_COMPOSE_FACTS } from '../assistant/grounding'
import {
  analyzeRide, avgDailyProfit, balanceOutlook, bestWorstDay, currentBalance, dailyGoal, fuelEfficiency, kmCost, monthlySavingGoal, upcomingIncomes,
  monthStats, periodStats, prevMonthStats, todayStats, upcomingBills, weekStats, monthlyProjections, budgetUsage,
} from './calc'
import { describeAction, parseNaturalFull } from './nlp'
import { driverInsight } from '../assistant/driverInsights'
import { adaptiveEnabled, buildPersonalModel } from '../assistant/personalModel'
import { catById } from '../data/categories'
import { isDriver } from './profile'
import {
  activeCards, cardsOverview, currentInvoice, monthlyCommitments, activePlans,
  planProgress, overdueInstallments, upcomingInvoices, installmentsThisMonth,
} from './cards'

export interface AiReply {
  text: string
  actions?: ParsedAction[] // ações que precisam de confirmação
  /** Opções de desambiguação — nada é registrado até o usuário escolher e confirmar. */
  choices?: { label: string; actions: ParsedAction[] }[]
  engine?: 'remote' | 'local'
  handled?: boolean // true = o motor local respondeu com certeza (não precisa da IA remota)
}

// ---------- Contexto estruturado enviado à IA (seção 37) ----------
// Nunca envia a base bruta: apenas agregados e itens relevantes.
export function buildAiContext(s: AppState) {
  const t = todayISO()
  const hoje = todayStats(s)
  const semana = weekStats(s)
  const mes = monthStats(s)
  const mesAnterior = prevMonthStats(s)
  const meta = dailyGoal(s)
  const custoKm = kmCost(s)
  const r2 = (v: number) => Math.round(v * 100) / 100
  const stats = (x: ReturnType<typeof todayStats>) => ({
    receitas: r2(x.income), despesas: r2(x.expense), lucro: r2(x.profit),
    km: r2(x.km), viagens: x.trips, horas: r2(x.hours),
    lucroPorKm: r2(x.netPerKm), lucroPorHora: r2(x.profitPerHour), mediaPorViagem: r2(x.perTrip),
  })
  const banco = balanceOutlook(s, 7)
  const driverMode = isDriver(s.settings)
  const mensal = monthlySavingGoal(s)

  // Base comum a todos os perfis (financeiro puro).
  const base: Record<string, any> = {
    perfil: s.settings.profile,
    nome: s.settings.name || undefined,
    saldoEmConta: r2(currentBalance(s)),
    saldoVsContas7dias: {
      contasAVencer: r2(banco.billsSoon),
      cobreAsContas: banco.ok,
      faltaParaContas: r2(banco.shortfall),
      sobra: r2(banco.leftover),
    },
    hoje: stats(hoje),
    ultimos7dias: stats(semana),
    esteMes: stats(mes),
    mesAnterior: stats(mesAnterior),
    metasDeCompra: s.goals.filter(g => !g.done).map(g => ({ nome: g.name, alvo: g.target, guardado: g.saved, prazo: g.deadline || null })),
    proximasContas: upcomingBills(s, 15).map(b => ({ nome: b.name, valor: b.amount, emDias: b.inDays })),
    proximasEntradas: upcomingIncomes(s, 31).map(b => ({ nome: b.name, valor: b.amount, emDias: b.inDays })),
    orcamentos: s.budgets.map(b => ({ categoria: b.category, limiteMensal: b.limit })),
    // Categorias REAIS deste usuário (inclusive personalizadas). É a partir
    // desta lista que o prompt remoto é montado e que a categoria devolvida pelo
    // modelo é validada — nunca de uma lista escrita à mão no prompt.
    categorias: s.categories
      .filter(c => !c.archived)
      .map(c => ({ id: c.id, name: c.name, type: c.type })),
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
    base.parcelamentos = {
      ativos: ov.activePlanCount,
      dividaRestante: r2(ov.totalDebt),
      parcelasDesteMes: r2(ov.installmentsThisMonth),
      parcelasProximoMes: r2(ov.installmentsNextMonth),
      atrasadas: { quantidade: ov.overdueCount, valor: r2(ov.overdueAmount) },
      limiteDisponivel: r2(ov.availableLimit),
      lista: activePlans(s).slice(0, 12).map(p => {
        const pp = planProgress(s, p)
        return {
          descricao: p.description,
          valorTotal: r2(p.totalAmount),
          parcelaAtual: r2(pp.currentAmount),
          pagas: pp.paidCount,
          restantes: pp.remainingCount,
          saldoRestante: r2(pp.remainingAmount),
          proximoVencimento: pp.nextDueDate || null,
          cartao: pp.card?.name || null,
          tipo: p.operationType,
        }
      }),
    }
    base.projecaoProximosMeses = monthlyProjections(s, 6).map(m => ({
      mes: m.monthKey,
      entradasPrevistas: r2(m.incomes),
      contasPrevistas: r2(m.bills),
      parcelasPrevistas: r2(m.installments),
      saldoEstimado: r2(m.runningBalance),
      comprometimentoPct: m.commitmentPct,
    }))
  }

  if (driverMode) {
    // Só motorista recebe km, veículo, combustível, meta diária e taxa da 99.
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
      veiculo: s.vehicle ? { modelo: `${s.vehicle.brand} ${s.vehicle.model}`.trim(), hodometro: s.vehicle.odometer, mediaKmDia: s.vehicle.averageDailyKm || null } : null,
      manutencoes: s.maintenance.map(m => ({
        item: m.name, instaladoKm: m.kmInstalled, vidaUtilKm: m.lifeKm || null,
        proximaTrocaKm: m.lifeKm > 0 ? m.kmInstalled + m.lifeKm : null,
      })),
    }
  }

  // Autônomo / CLT / outro: foco no mês, entradas fixas e meta de guardar.
  // Sem NENHUM dado de veículo, km ou taxa da 99.
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
  history: { role: string; text: string }[],
): Promise<RemoteAssistantResult | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 35000)
    const res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: input, context: buildAiContext(s), history }),
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
  return { from: addDays(today, -6), to: today, label: 'nos últimos 7 dias' }
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
  [/\bvc\b/g, 'voce'], [/\bq\b/g, 'que'], [/\bhj\b/g, 'hoje'], [/\bhje\b/g, 'hoje'],
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
      text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a)).join('\n') + '\n\nConfirmar?',
      actions,
    }
  }

  // ---------- 2) Perguntas ----------

  // Registro + pergunta sobre orçamento na mesma mensagem. A resposta usa o
  // valor projetado após as ações, mas nada é salvo antes da confirmação.
  if (actions.length && /(?:quanto|qual).*(?:limite|dispon[ií]vel|resta|sobrou)|ainda\s+tenho.*limite/.test(t)) {
    const expenseActions = actions.filter(a => a.kind === 'expense') as Extract<ParsedAction, { kind: 'expense' }>[]
    const categoryId = expenseActions.find(a => a.category)?.category
      || s.budgets.find(b => t.includes(catById(s.categories, b.category).name.toLowerCase()))?.category
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
  if (/parcela|fatura|cart[ãa]o|parcelamento|d[ií]vida/.test(t)) {
    if (!ov.hasData) {
      return { text: 'Você ainda não cadastrou cartões nem parcelamentos. Você pode adicionar em Mais → Cartões e parcelamentos.' }
    }
    // "quanto tenho de parcela no mês que vem?"
    if (/(m[eê]s que vem|pr[oó]ximo m[eê]s)/.test(t) && /parcela|fatura|cart[ãa]o/.test(t)) {
      return {
        text: `No próximo mês vencem ${fmtBRL(ov.installmentsNextMonth)} em parcelas e assinaturas (dado real, com base no que você cadastrou).` +
          (ov.installmentsThisMonth > 0 ? `\n\nNeste mês são ${fmtBRL(ov.installmentsThisMonth)}.` : ''),
      }
    }

    // "qual será minha maior fatura?"
    if (/maior fatura/.test(t)) {
      const all = activeCards(s).flatMap(c => upcomingInvoices(s, c, 6).map(inv => ({ card: c.name, inv })))
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
    if (/(quanto.*(devo|dívida|divida))|d[ií]vida total/.test(t)) {
      return {
        text: `Sua dívida parcelada restante é ${fmtBRL(ov.totalDebt)} em ${ov.activePlanCount} parcelamento(s).\n\n` +
          `• Faturas em aberto agora: ${fmtBRL(ov.openInvoicesTotal)}\n` +
          `• Parcelas deste mês: ${fmtBRL(ov.installmentsThisMonth)}\n` +
          `• Próximo mês: ${fmtBRL(ov.installmentsNextMonth)}` +
          (ov.overdueCount > 0 ? `\n• Atrasadas: ${ov.overdueCount} (${fmtBRL(ov.overdueAmount)})` : ''),
      }
    }

    // "quanto tenho de limite"
    if (/limite/.test(t)) {
      if (ov.totalLimit <= 0) return { text: 'Você ainda não informou o limite dos seus cartões. Dá pra cadastrar em Mais → Cartões e parcelamentos.' }
      return { text: `Seus cartões somam ${fmtBRL(ov.totalLimit)} de limite. Comprometido: ${fmtBRL(ov.usedLimit)}. Disponível: ${fmtBRL(ov.availableLimit)}. (dados reais)` }
    }

    // resumo geral de fatura/parcelas
    const cardsList = activeCards(s)
    if (cardsList.length) {
      return {
        text: `Situação dos seus cartões (dados reais):\n\n` +
          cardsList.map(c => {
            const inv = currentInvoice(s, c)
            return `• ${c.name}: fatura de ${fmtBRL(inv.total)}${inv.paid > 0 ? ` (pago ${fmtBRL(inv.paid)}, pendente ${fmtBRL(inv.pending)})` : ''} — vence ${fromISO(inv.dueDate).toLocaleDateString('pt-BR')} · ${inv.status}`
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
    if (/quanto\s+(?:eu\s+)?posso\s+guardar|meta\s+mensal|quanto\s+consigo\s+guardar|guardar\s+este\s+m[eê]s|minha\s+meta|qual\s+(?:é\s+)?a?\s*minha\s+meta|como\s+est[aá]\s+minha\s+meta/.test(t)) {
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
        text: `Sua meta é guardar ${fmtBRL(mg.target)} por mês.\n\n` +
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
      const bo = balanceOutlook(s, 7)
      return {
        text: `Seu mês até agora (dados reais):\n\n` +
          `• Entrou: ${fmtBRL(mg.income)}\n• Saiu: ${fmtBRL(mg.expense)}\n• ${mg.net >= 0 ? 'Sobra do mês' : 'Déficit do mês'}: ${fmtBRL(Math.abs(mg.net))}\n` +
          (mg.target > 0 ? `• Meta para guardar: ${fmtBRL(mg.target)} (${mg.pct}% atingido)\n` : '') +
          (bo.bills.length
            ? `\nContas nos próximos 7 dias: ${fmtBRL(bo.billsSoon)} — ${bo.ok ? `seu saldo cobre e sobra ${fmtBRL(bo.leftover)}.` : `faltam ${fmtBRL(bo.shortfall)}.`}`
            : ''),
      }
    }

    // "quanto recebi de aluguéis este mês?" / salário
    const fonteM = t.match(/(alugu[eé]|alugueis|alugu[eé]is|sal[aá]rio|freelance|vendas?)/)
    if (fonteM && /quanto\s+(?:eu\s+)?(?:recebi|ganhei|entrou)/.test(t)) {
      const map: Record<string, string> = {
        alugue: 'aluguel', alugueis: 'aluguel', 'aluguéis': 'aluguel', 'alugué': 'aluguel',
        salario: 'salario', 'salário': 'salario', freelance: 'freelance', venda: 'vendas', vendas: 'vendas',
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
  const rideM = driverMode ? t.match(new RegExp(String.raw`corrida\s*(?:de)?\s*(?:r\$)?\s*${NUM}\s*(?:reais)?\s*(?:por|de|em)?\s*${NUM}\s*km`)) : null
  if (rideM && /vale/.test(t)) {
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
  if (/quanto\s+(?:eu\s+)?(?:posso|da\s+para|consigo|poderia)\s+gastar|da\s+para\s+gastar\s+quanto/.test(t)) {
    const ts = todayStats(s)
    const goal = dailyGoal(s)
    const bo = balanceOutlook(s, 7)
    if (currentBalance(s) !== 0) {
      const livre = Math.max(bo.leftover, 0)
      if (bo.ok) {
        return {
          text: `Você tem ${fmtBRL(bo.balance)} em conta.` +
            (bo.bills.length ? ` Descontando ${fmtBRL(bo.billsSoon)} das contas dos próximos ${bo.horizon} dias, sobram ${fmtBRL(livre)}.` : '') +
            ` Dá pra gastar até uns ${fmtBRL(livre * 0.7)} hoje mantendo uma folga de segurança. (estimativa)`,
        }
      }
      return {
        text: `Cuidado: você tem ${fmtBRL(bo.balance)} em conta, mas ${fmtBRL(bo.billsSoon)} em contas nos próximos ${bo.horizon} dias — faltam ${fmtBRL(bo.shortfall)}.\n\nO ideal é não gastar nada extra hoje e priorizar fazer ~${fmtBRL(bo.needPerDay)} por dia até quitar.`,
      }
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

  // "qual meu saldo" / "quanto tenho no banco"
  if (/(qual|quanto).*(saldo|no banco|na conta)|meu saldo|quanto\s+(?:eu\s+)?tenho(?:\s+(?:de\s+)?(?:dinheiro|guardado|sobrando))?\s*\??$|quanto\s+sobrou\s+(?:de\s+)?dinheiro/.test(t)) {
    const bo = balanceOutlook(s, 7)
    if (currentBalance(s) === 0) return { text: 'Seu saldo em conta está zerado. Toque em "Saldo em conta" na tela inicial, ou me diga "meu saldo é 1500".' }
    return {
      text: `Seu saldo em conta é ${fmtBRL(bo.balance)}.` +
        (bo.bills.length
          ? bo.ok
            ? ` Cobre ${bo.bills.length === 1 ? 'a' : 'as'} ${bo.bills.length} ${bo.bills.length === 1 ? 'conta' : 'contas'} dos próximos ${bo.horizon} dias (${fmtBRL(bo.billsSoon)}) e ainda sobram ${fmtBRL(bo.leftover)}.`
            : ` Mas ${fmtBRL(bo.billsSoon)} em contas vencem nos próximos ${bo.horizon} dias — faltam ${fmtBRL(bo.shortfall)} (${fmtBRL(bo.needPerDay)}/dia até quitar).`
          : ' Nenhuma conta fixa cadastrada para os próximos dias.'),
    }
  }

  // Meta de COMPRA citada pelo NOME ganha da meta diária. O motorista tem as
  // duas, e a palavra "meta" serve às duas — mas quem batizou a meta de "Moto"
  // e pergunta por ela espera ouvir sobre ela, não a composição da meta do dia.
  const metaCitadaPeloNome = s.goals.some(g => !g.done && g.name?.trim()
    && t.includes(normalizeQuestion(g.name).split(' ')[0]))

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

  // "como está minha meta" / "minha semana foi boa?"
  if (driverMode && /como est[aá] minha meta|meta de hoje/.test(t)) {
    const ts = todayStats(s)
    const g = dailyGoal(s)
    const pct = g.total > 0 ? Math.round((ts.profit / g.total) * 100) : 0
    return { text: `Hoje: lucro de ${fmtBRL(ts.profit)} (real) contra meta de ${fmtBRL(g.total)} — ${pct}% concluída.${pct >= 100 ? ' 🎉 Meta batida!' : ` Faltam ${fmtBRL(g.total - ts.profit)}.`}` }
  }
  if (/semana foi boa|como foi minha semana|t[oô] melhor|estou melhor/.test(t)) {
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
  const metaPeloNome = /quanto\s+(?:falta|(?:eu\s+)?(?:j[áa]\s+)?(?:juntei|guardei|tenho|consegui|separei))/.test(t)
    && s.goals.some(g => !g.done && t.includes(g.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(' ')[0]))
  if (metaPeloNome || /quando\s+(vou|consigo|vou conseguir|poderei)\s+(comprar|atingir|juntar)/.test(t) || /quando.*meta/.test(t) || /quanto\s+falta\s+(?:para|pra)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?meta/.test(t)) {
    const goal = s.goals.find(g => !g.done && t.includes(g.name.toLowerCase().split(' ')[0])) || s.goals.filter(g => !g.done)[0]
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
  if (/quanto\s+(?:eu\s+)?(?:j[áa]\s+)?(?:gastei|gastou|torrei|saiu|foi)\b(?!\s*(?:com|de|em)\s+[a-zà-ú])/.test(t)
    && !/quanto\s+(?:eu\s+)?(?:posso|da\s+para|consigo)/.test(t)) {
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
  if (driverMode && /quanto\s+(?:eu\s+)?(?:ainda\s+)?(?:preciso|falta|falto|tenho\s+que|tenho\s+de)\s*(?:fazer|ganhar|rodar|tirar|faturar|trabalhar)?/.test(t)) {
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

  // "to no lucro esse mes?" / "quanto sobrou"
  // "Tô gastando mais do que ganho?" é a pergunta mais direta sobre a saúde do
  // mês, e é a mesma conta do "tô no lucro" com o sinal invertido.
  if (/(?:t[oô]|estou|to)\s+no\s+lucro|(?:t[oô]|estou)\s+no\s+(?:azul|vermelho)|quanto\s+sobrou\s*\??$|sobrou\s+quanto/.test(t)
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
    const perguntaNegativa = /vermelho|preju|no\s+negativo|gastando\s+mais|gasto\s+mais|gastei\s+mais/.test(t)
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
    return { text: prefixo + corpo + fecho }
  }

  // "qual foi meu maior gasto"
  if (/maior gasto|maior despesa/.test(t)) {
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
    const { best, worst } = bestWorstDay(s)
    if (!best) return { text: 'Ainda não há dados suficientes nos últimos 30 dias.' }
    if (/pior/.test(t)) return { text: `Seu pior dia nos últimos 30 dias foi ${fromISO(worst!.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(worst!.profit)}.` }
    return { text: `Seu melhor dia nos últimos 30 dias foi ${fromISO(best.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(best.profit)} (${fmtBRL(best.income)} de receitas).` }
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
    const what = spentM[1].trim()
    const p = periodFromText(t)
    if (!p) return ajudaGenerica(driverMode)
    const catGuess = s.categories.find(c => c.name.toLowerCase().includes(what)) ||
      (/(gasolina|combust|etanol|alcool)/.test(what) ? catById(s.categories, 'combustivel') : undefined)
    const txs = s.transactions.filter(x => x.type === 'expense' && x.date >= p.from && x.date <= p.to &&
      (catGuess ? x.category === catGuess.id : (x.description || '').toLowerCase().includes(what)))
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

  // "quanto meu carro custa por km"
  if (driverMode && /custa por km|custo por km|custo.*km|por km.*custo|sai o km|km sai|quanto.*km.*(?:carro|veiculo|moto)|(?:carro|veiculo|moto).*por km/.test(t)) {
    const kc = kmCost(s)
    if (kc.total <= 0) {
      return { text: 'Os custos do veículo ainda estão zerados. Registre abastecimentos com valor, litros e hodômetro; informe manutenções e custos fixos quando souber. Aí eu calculo sem inventar médias.' }
    }
    return {
      text: `Custo real do seu veículo (estimativa com base nos seus registros):\n\n` +
        `• Combustível: ${fmtBRL(kc.fuelPerKm)}/km\n• Manutenção: ${fmtBRL(kc.maintenancePerKm)}/km\n• Custos fixos: ${fmtBRL(kc.fixedPerKm)}/km\n\n` +
        `Custo operacional: ${fmtBRL(kc.operational)}/km\nCusto total: ${fmtBRL(kc.total)}/km\n\nValor mínimo recomendado: ${fmtBRL(kc.minRecommended)}/km\nMeta confortável: ${fmtBRL(kc.comfort)}/km`,
    }
  }

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
      text: `Nos últimos 7 dias foram ${w.trips} viagens e ${fmtBRL(w.income)} de receita — ${fmtBRL(w.perTrip)} por viagem (dado real).`,
    }
  }

  // "quando preciso trocar meu óleo"
  if (driverMode && (/trocar.*(óleo|oleo|pneu|pastilha|filtro)/.test(t) || /quando.*troca/.test(t))) {
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

  // "meu salário cobre minhas contas?" — pergunta de SIM OU NÃO, e a resposta
  // era a lista de contas. O app sabia responder (`balanceOutlook` calcula
  // exatamente isso) e devolvia dado em vez de resposta; quem lê no celular
  // ainda tinha que somar de cabeça. Vem ANTES da lista porque a frase contém
  // "contas" e a lista a capturava primeiro.
  if (/\b(?:cobre|cobrem|cobrir|d[áa]\s+(?:pra|para)\s+pagar|consigo\s+pagar|vou\s+conseguir\s+pagar|tenho\s+(?:saldo|dinheiro)\s+(?:pra|para))\b/.test(t)
    && /\bcontas?\b|\bvencer\b|\bvencimento\b|\bfatura\b/.test(t)) {
    const bo = balanceOutlook(s, 15)
    if (!bo.bills.length) return { text: 'Você não tem conta fixa cadastrada vencendo nos próximos 15 dias, então não há o que cobrir.' }
    const lista = bo.bills.map(b => `• ${sentenceCase(b.name)}: ${fmtBRL(b.amount)} — ${dueLabel(b.inDays).toLowerCase()}`).join('\n')
    return {
      text: (bo.ok
        ? `Sim. Seu saldo de ${fmtBRL(bo.balance)} cobre ${bo.bills.length === 1 ? 'a' : 'as'} ${bo.bills.length} ${bo.bills.length === 1 ? 'conta' : 'contas'} dos próximos ${bo.horizon} dias (${fmtBRL(bo.billsSoon)}) e ainda sobram ${fmtBRL(bo.leftover)}.`
        : `Não. As contas dos próximos ${bo.horizon} dias somam ${fmtBRL(bo.billsSoon)} e seu saldo é ${fmtBRL(bo.balance)} — faltam ${fmtBRL(bo.shortfall)}.`)
        + `\n\n${lista}`,
    }
  }

  // contas próximas
  if (/contas?( fixas)?|vencimento|vence/.test(t)) {
    const bills = upcomingBills(s, 15)
    if (!bills.length) return { text: 'Nenhuma conta fixa vence nos próximos 15 dias.' }
    return { text: 'Próximas contas:\n\n' + bills.map(b => `• ${sentenceCase(b.name)}: ${fmtBRL(b.amount)} — ${dueLabel(b.inDays).toLowerCase()}`).join('\n') }
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
  if (/resumo|como estou|situa[çc][aã]o|como\s+(?:esta|foi|vai|anda)\s+(?:o\s+)?meu\s+m[eê]s|meu m[eê]s(?:\s|\?|$)|como\s+(?:esta|foi)\s+(?:o\s+)?m[eê]s/.test(t)) {
    if (!driverMode) {
      const mg = monthlySavingGoal(s)
      const bo = balanceOutlook(s, 7)
      const bills = upcomingBills(s, 7)
      const inst = installmentsThisMonth(s)
      return {
        text: `Sua situação neste mês (dados reais):\n\n` +
          `• Entradas: ${fmtBRL(mg.income)}\n` +
          `• Despesas: ${fmtBRL(mg.expense)}\n` +
          `• ${mg.net >= 0 ? 'Sobra do mês' : 'Déficit do mês'}: ${fmtBRL(Math.abs(mg.net))}\n` +
          `• Já guardado de verdade: ${fmtBRL(mg.saved)}\n` +
          (mg.target > 0 ? `• Meta mensal para guardar: ${fmtBRL(mg.target)} (${mg.pct}% atingido)\n` : '') +
          (inst > 0 ? `• Parcelas e faturas que vencem neste mês: ${fmtBRL(inst)}\n` : '') +
          (bills.length
            ? `\nContas nos próximos 7 dias: ${fmtBRL(bo.billsSoon)} — ${bo.ok ? `seu saldo cobre e sobra ${fmtBRL(bo.leftover)}.` : `faltam ${fmtBRL(bo.shortfall)}.`}`
            : '\nNenhuma conta cadastrada vence nos próximos 7 dias.'),
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
    return { text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a)).join('\n') + '\n\nConfirmar?', actions }
  }

  return ajudaGenerica(driverMode)
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
