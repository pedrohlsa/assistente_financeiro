// Assistente IA local (seções 8, 37).
// Este módulo responde perguntas usando SOMENTE dados reais do estado — nunca inventa valores.
// Ele diferencia dados reais de estimativas/projeções no texto das respostas.
//
// INTEGRAÇÃO PENDENTE: para linguagem 100% livre, conectar um backend seguro
// (ex.: POST /api/ai/chat) que recebe contexto estruturado (nunca a base bruta)
// e as API keys ficam apenas no servidor. A interface abaixo está pronta:
// `askAssistant` pode ser trocado por uma chamada remota mantendo o mesmo contrato.

import { AppState, ParsedAction } from '../models/types'
import {
  addDays, dueLabel, fmtBRL, fmtNum, fromISO, todayISO, daysInMonth,
} from '../utils/format'
import { sentenceCase } from '../utils/text'
import {
  analyzeRide, avgDailyProfit, balanceOutlook, bestWorstDay, currentBalance, dailyGoal, fuelEfficiency, kmCost, monthlySavingGoal, upcomingIncomes,
  monthStats, periodStats, prevMonthStats, todayStats, upcomingBills, weekStats, monthlyProjections, budgetUsage,
} from './calc'
import { describeAction, parseNaturalFull } from './nlp'
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

// ---------- Validação das ações vindas da IA remota ----------
const isNum = (v: any) => typeof v === 'number' && isFinite(v) && v > 0
const optNum = (v: any) => (isNum(v) ? v : undefined)
const optStr = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined)

function sanitizeActions(raw: any[]): ParsedAction[] {
  const out: ParsedAction[] = []
  for (const a of raw || []) {
    if (!a || typeof a !== 'object') continue
    switch (a.kind) {
      case 'income':
        if (isNum(a.amount)) out.push({ kind: 'income', amount: a.amount, category: optStr(a.category), description: optStr(a.description) })
        break
      case 'expense':
        if (isNum(a.amount)) out.push({ kind: 'expense', amount: a.amount, category: optStr(a.category), description: optStr(a.description) })
        break
      case 'work':
        if (isNum(a.km) || isNum(a.trips) || isNum(a.hours)) out.push({ kind: 'work', km: optNum(a.km), trips: optNum(a.trips), hours: optNum(a.hours) })
        break
      case 'fuel':
        if (isNum(a.amount) || isNum(a.liters)) out.push({ kind: 'fuel', amount: optNum(a.amount), liters: optNum(a.liters), pricePerLiter: optNum(a.pricePerLiter), odometer: optNum(a.odometer) })
        break
      case 'odometer':
        if (isNum(a.value)) out.push({ kind: 'odometer', value: a.value })
        break
      case 'maintenance':
        if (optStr(a.item) && isNum(a.cost)) out.push({ kind: 'maintenance', item: optStr(a.item)!, cost: a.cost, km: optNum(a.km), lifeKm: optNum(a.lifeKm) })
        break
      case 'goal':
        if (optStr(a.name) && isNum(a.target)) out.push({ kind: 'goal', name: optStr(a.name)!, target: a.target, months: optNum(a.months) })
        break
      case 'goal-update':
        if (optStr(a.name) && (isNum(a.target) || isNum(a.months))) out.push({ kind: 'goal-update', name: optStr(a.name)!, target: optNum(a.target), months: optNum(a.months) })
        break
      case 'goal-deposit':
        if (isNum(a.amount)) out.push({ kind: 'goal-deposit', name: optStr(a.name) || '', amount: a.amount })
        break
      case 'balance':
        if (isNum(a.amount)) out.push({ kind: 'balance', amount: a.amount })
        break
      // Cartões: só aceita quando os dados obrigatórios vieram completos e
      // coerentes. Nada é preenchido por conta própria.
      case 'card-purchase': {
        const n = Math.round(a.installments)
        if (isNum(a.total) && Number.isFinite(n) && n >= 1 && n <= 120) {
          out.push({
            kind: 'card-purchase', total: a.total, installments: n,
            description: optStr(a.description), cardName: optStr(a.cardName),
            category: optStr(a.category),
            firstDueDate: /^\d{4}-\d{2}-\d{2}$/.test(a.firstDueDate) ? a.firstDueDate : undefined,
          })
        }
        break
      }
      case 'financed-cash-inflow': {
        const n = Math.round(a.installments)
        // recebido nunca pode superar o valor cobrado no cartão
        if (isNum(a.total) && isNum(a.netReceived) && a.netReceived <= a.total && Number.isFinite(n) && n >= 1 && n <= 120) {
          out.push({
            kind: 'financed-cash-inflow', total: a.total, netReceived: a.netReceived,
            installments: n, cardName: optStr(a.cardName), source: optStr(a.source),
          })
        }
        break
      }
      case 'card-payment':
        // valor ausente = pagar o pendente da fatura; valor presente precisa ser válido
        if (a.amount === undefined || a.amount === null || isNum(a.amount)) {
          out.push({ kind: 'card-payment', cardName: optStr(a.cardName), amount: optNum(a.amount) })
        }
        break
      case 'card-charge':
        if (isNum(a.amount)) {
          out.push({ kind: 'card-charge', amount: a.amount, description: optStr(a.description), cardName: optStr(a.cardName), category: optStr(a.category) })
        }
        break
      // 'reset' NÃO é aceito da IA remota — só via parser local ("reseta tudo"),
      // para evitar que um mal-entendido apague os dados do usuário.
    }
  }
  return out.slice(0, 8)
}

// Em dev, o Vite serve /api/ai/chat (middleware em vite.config.ts) na mesma origem.
// Em produção (build empacotado num APK/PWA), não existe dev server: aponte
// VITE_AI_API_URL para o backend publicado (ex.: https://seu-projeto.vercel.app/api/ai/chat).
const AI_API_URL = import.meta.env?.VITE_AI_API_URL || '/api/ai/chat'

/**
 * Chama o backend de IA (DeepSeek — a chave fica só no servidor).
 * Retorna null em qualquer falha para o chamador cair no motor local.
 */
export async function askAssistantRemote(
  s: AppState, input: string,
  history: { role: string; text: string }[],
): Promise<AiReply | null> {
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
    const text = String(data.reply || '').trim()
    if (!text) return null
    let actions = sanitizeActions(data.actions)
    // Defesa extra para respostas de versões antigas do backend.
    if (!isDriver(s.settings)) {
      actions = actions.map(a => (a.kind === 'income' && a.is99 ? { ...a, is99: undefined } : a))
    }
    return { text, actions: actions.length ? actions : undefined, engine: 'remote' }
  } catch {
    return null
  }
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`
const n = (s: string) => parseFloat(s.replace(',', '.'))

function periodFromText(t: string): { from: string; to: string; label: string } {
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
function resolveLocal(s: AppState, input: string): AiReply {
  const t = input.toLowerCase().trim()
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
      const word: Record<string, number> = { dois: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6 }
      const n = Math.min(parseInt(nextM[1], 10) || word[nextM[1]] || 3, 12)
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
  if (/quanto\s+(?:eu\s+)?posso\s+gastar/.test(t)) {
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
  if (/(qual|quanto).*(saldo|no banco|na conta)|meu saldo/.test(t)) {
    const bo = balanceOutlook(s, 7)
    if (currentBalance(s) === 0) return { text: 'Seu saldo em conta está zerado. Toque em "Saldo em conta" na tela inicial, ou me diga "meu saldo é 1500".' }
    return {
      text: `Seu saldo em conta é ${fmtBRL(bo.balance)}.` +
        (bo.bills.length
          ? bo.ok
            ? ` Cobre as ${bo.bills.length} conta(s) dos próximos ${bo.horizon} dias (${fmtBRL(bo.billsSoon)}) e ainda sobram ${fmtBRL(bo.leftover)}.`
            : ` Mas ${fmtBRL(bo.billsSoon)} em contas vencem nos próximos ${bo.horizon} dias — faltam ${fmtBRL(bo.shortfall)} (${fmtBRL(bo.needPerDay)}/dia até quitar).`
          : ' Nenhuma conta fixa cadastrada para os próximos dias.'),
    }
  }

  // "quanto preciso ganhar amanhã?" / "qual minha meta"
  if (driverMode && /(preciso ganhar|meta)\s*(de)?\s*(amanh[aã]|hoje)?/.test(t) && /(preciso|meta)/.test(t) && !/como est/.test(t)) {
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
  if (/quando\s+(vou|consigo|vou conseguir|poderei)\s+(comprar|atingir|juntar)/.test(t) || /quando.*meta/.test(t)) {
    const goal = s.goals.find(g => !g.done && t.includes(g.name.toLowerCase().split(' ')[0])) || s.goals.filter(g => !g.done)[0]
    if (!goal) return { text: 'Você ainda não tem metas de compra cadastradas. Diga algo como "quero comprar um celular de 5000 em 6 meses" que eu crio para você.' }
    const remaining = goal.target - goal.saved
    const avg = avgDailyProfit(s)
    if (avg <= 0) return { text: `Para "${goal.name}" faltam ${fmtBRL(remaining)}. Ainda não tenho histórico suficiente para projetar uma data — registre seus ganhos diários.` }
    const savePerDay = avg * 0.3
    const days = Math.ceil(remaining / savePerDay)
    const when = fromISO(addDays(todayISO(), days)).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })
    return { text: `Meta "${goal.name}": faltam ${fmtBRL(remaining)} de ${fmtBRL(goal.target)}.\n\nProjeção: guardando 30% da sua média diária de lucro (${fmtBRL(savePerDay)}/dia), você chegaria lá por volta de ${when} (~${days} dias). Isso é uma estimativa com base na sua média dos últimos 30 dias.` }
  }

  // "qual foi meu maior gasto"
  if (/maior gasto|maior despesa/.test(t)) {
    const p = periodFromText(t)
    const txs = s.transactions.filter(x => x.type === 'expense' && x.date >= p.from && x.date <= p.to)
    if (!txs.length) return { text: `Não encontrei despesas ${p.label}.` }
    const top = [...txs].sort((a, b) => b.amount - a.amount)[0]
    const cat = catById(s.categories, top.category)
    return { text: `Seu maior gasto ${p.label} foi ${fmtBRL(top.amount)} em ${cat.name}${top.description ? ` (${top.description})` : ''}, no dia ${fromISO(top.date).toLocaleDateString('pt-BR')}.` }
  }

  // "qual foi meu melhor dia"
  if (/melhor dia|pior dia/.test(t)) {
    const { best, worst } = bestWorstDay(s)
    if (!best) return { text: 'Ainda não há dados suficientes nos últimos 30 dias.' }
    if (/pior/.test(t)) return { text: `Seu pior dia nos últimos 30 dias foi ${fromISO(worst!.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(worst!.profit)}.` }
    return { text: `Seu melhor dia nos últimos 30 dias foi ${fromISO(best.date).toLocaleDateString('pt-BR')}, com lucro de ${fmtBRL(best.profit)} (${fmtBRL(best.income)} de receitas).` }
  }

  // "quanto gastei com gasolina esse mês" / "quanto perco por mês com gasolina"
  const spentM = t.match(/quanto\s+(?:eu\s+)?(?:gastei|gasto|perco|perdi)\s*(?:por m[eê]s)?\s*(?:com|de|em)\s+([\wçãõáéíóú\s]+?)(?:\s+(?:esse|este|nesse|neste)?\s*(m[eê]s|semana|hoje|ano)|\?|$)/)
  if (spentM) {
    const what = spentM[1].trim()
    const p = periodFromText(t)
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
    const st = periodStats(s, p.from, p.to)
    const isLucro = /lucrei/.test(t)
    return {
      text: isLucro
        ? `Seu lucro ${p.label} foi ${fmtBRL(st.profit)} (${fmtBRL(st.income)} de receitas − ${fmtBRL(st.expense)} de despesas). Dados reais.`
        : `Você faturou ${fmtBRL(st.income)} ${p.label}. Descontando ${fmtBRL(st.expense)} de despesas, o lucro foi ${fmtBRL(st.profit)}.`,
    }
  }

  // "quanto meu carro custa por km"
  if (driverMode && /custa por km|custo por km|custo.*km|por km.*custo/.test(t)) {
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

  // "quando preciso trocar meu óleo"
  if (driverMode && (/trocar.*(óleo|oleo|pneu|pastilha|filtro)/.test(t) || /quando.*troca/.test(t))) {
    if (!s.maintenance.length) return { text: 'Você ainda não registrou manutenções. Diga por exemplo: "troquei o óleo por 280 com 84 mil km".' }
    const odo = s.vehicle?.odometer || 0
    const lines = s.maintenance.map(mi => {
      const next = mi.kmInstalled + mi.lifeKm
      const left = next - odo
      return `• ${mi.name}: próxima troca aos ${fmtNum(next, 0)} km ${left > 0 ? `(faltam ${fmtNum(left, 0)} km)` : '— JÁ VENCIDA'}`
    })
    return { text: `Com o hodômetro em ${fmtNum(odo, 0)} km:\n\n${lines.join('\n')}` }
  }

  // "tô gastando demais esse mês?"
  if (/gastando demais|gastei demais/.test(t)) {
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

  // resumo geral — o formato muda por perfil: meta diária/km só existem no motorista
  if (/resumo|como estou|situa[çc][aã]o/.test(t)) {
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

  // Se o parser achou ações mas parecia pergunta, ofereça registro
  if (actions.length) {
    if (parsed.ambiguity) return { text: parsed.ambiguity.question, choices: parsed.ambiguity.options }
    return { text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a)).join('\n') + '\n\nConfirmar?', actions }
  }

  return {
    text: driverMode
      ? 'Posso te ajudar com coisas como:\n\n• "ganhei 250 hoje"\n• "gastei 40 de gasolina"\n• "rodei 120 km e fiz 14 viagens"\n• "quanto posso gastar hoje?"\n• "qual o valor mínimo de corrida que vale a pena?"\n• "quanto gastei com gasolina esse mês?"\n• "quando preciso trocar meu óleo?"\n\nOu me faça outra pergunta que eu tento responder.'
      : 'Posso te ajudar com coisas como:\n\n• "recebi 1800 de aluguel"\n• "gastei 250 no mercado"\n• "meu saldo é 3200"\n• "como está meu mês?"\n• "quanto posso guardar este mês?"\n• "tenho saldo para as próximas contas?"\n• "qual foi minha maior despesa?"\n\nOu me faça outra pergunta que eu tento responder.',
    handled: false,
  }
}

/** Motor de resposta local com marcação de confiança (handled). */
export function askAssistant(s: AppState, input: string): AiReply {
  const r = resolveLocal(s, input)
  return { ...r, engine: 'local', handled: r.handled !== false }
}
