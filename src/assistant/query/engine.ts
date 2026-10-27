// EXECUTOR da Query DSL — SOMENTE LEITURA, determinístico, offline.
//
// Recebe um plano já validado e o estado como VALOR. Não existe `dispatch`, não
// existe `localStorage`, não existe escrita: por construção, uma consulta não
// consegue alterar nada.
//
// Todo número que sai daqui carrega a amostra que o sustenta. É o que separa
// "você gastou R$ 1.430,00" de "você gastou R$ 0,00": quando não há linha
// nenhuma, o resultado é `empty` e quem compõe a resposta DIZ que não há base —
// somar zero e apresentar como dado real é mentir com número certo (regra 43).

import type { AppState, TxType } from '../../models/types'
import { catById } from '../../data/categories'
import { fromISO, monthKey, monthShortLabel, toISO } from '../../utils/format'
import { normalizeName, sentenceCase, weekdayName } from '../../utils/text'
import {
  activeCards, cardById, cardInvoice, cardOutstanding, invoiceOpenAmount, planProgress,
} from '../../services/cards'
import { monthlyProjections, occurrencesBetween, recurringActiveOn } from '../../services/calc'
import type {
  AssistantFact, AssistantQueryPlan, AssistantQueryResult, FactUnit,
  QueryGroupResult, QueryRow,
} from './types'

/** Teto de linhas varridas. Estado de app pessoal não chega perto disso. */
const MAX_ROWS = 20000

const r2 = (v: number) => Math.round(v * 100) / 100

const inRange = (d: string, from: string, to: string) => !!d && d >= from && d <= to

// ---------------------------------------------------------------------------
// Extração — cada fonte vira `QueryRow[]`
// ---------------------------------------------------------------------------

/** Plataforma citada na descrição. Só serve ao perfil motorista. */
const PLATAFORMAS: [RegExp, string][] = [
  [/\buber\b/i, 'Uber'],
  [/\b99\b|\bnoventa\s*e\s*nove\b/i, '99'],
  [/\bin\s*driv/i, 'inDrive'],
  [/\bifood\b/i, 'iFood'],
  [/\brappi\b/i, 'Rappi'],
]

const plataformaDe = (texto?: string): string | undefined => {
  if (!texto) return undefined
  for (const [re, nome] of PLATAFORMAS) if (re.test(texto)) return nome
  return undefined
}

function rowsOf(state: AppState, plan: AssistantQueryPlan): QueryRow[] {
  const { from, to } = plan.period
  const out: QueryRow[] = []

  switch (plan.source) {
    case 'transactions': {
      for (const t of state.transactions || []) {
        if (!t || !inRange(t.date, from, to)) continue
        out.push({
          id: t.id, date: t.date, value: Number(t.amount) || 0,
          label: t.description || catById(state.categories, t.category).name,
          category: t.category, origin: t.origin, txType: t.type,
          platform: plataformaDe(t.description),
        })
        if (out.length >= MAX_ROWS) break
      }
      return out
    }

    case 'recurring': {
      // Ocorrências PREVISTAS: nunca somadas a realizado (regra 18).
      for (const rec of state.recurring || []) {
        if (!rec || rec.active === false) continue
        for (const dia of occurrencesBetween(rec, from, to)) {
          if (!recurringActiveOn(rec, dia)) continue
          out.push({
            id: `${rec.id}@${dia}`, date: dia, value: Number(rec.amount) || 0,
            label: rec.name, category: rec.category, origin: rec.origin,
            txType: rec.kind === 'income' ? 'income' : 'expense',
            estimated: true,
          })
          if (out.length >= MAX_ROWS) return out
        }
      }
      return out
    }

    case 'installments': {
      const planos = new Map((state.installmentPlans || []).map(p => [p.id, p]))
      for (const i of state.installments || []) {
        if (!i || !inRange(i.dueDate, from, to)) continue
        const p = planos.get(i.planId)
        if (p?.status === 'cancelled') continue
        const card = cardById(state, p?.cardId)
        out.push({
          id: i.id, date: i.dueDate, value: Number(i.amount) || 0,
          label: p?.description || 'Parcelamento',
          category: p?.categoryId, cardId: p?.cardId, cardName: card?.name,
          planId: i.planId, status: i.status, txType: 'expense',
          estimated: i.status === 'pending',
          extra: { number: i.number, total: i.total, paid: Number(i.paidAmount) || 0 },
        })
        if (out.length >= MAX_ROWS) break
      }
      return out
    }

    case 'invoices': {
      const mesesVistos = new Set<string>()
      let cursor = fromISO(from)
      const fim = fromISO(to)
      while (cursor <= fim && mesesVistos.size < 60) {
        const mk = monthKey(toISO(cursor))
        if (!mesesVistos.has(mk)) {
          mesesVistos.add(mk)
          for (const c of activeCards(state)) {
            const inv = cardInvoice(state, c, mk)
            // O pendente é o do caixa: parcela marcada como paga (mesmo sem
            // data) não deixa a fatura "atrasada" aqui e quitada na resposta
            // de fatura.
            const aberto = invoiceOpenAmount(state, inv)
            const status = inv.total > 0 && aberto <= 0.009 && inv.status !== 'aberta' ? 'paga' : inv.status
            out.push({
              id: `${c.id}@${mk}`, date: inv.dueDate, value: r2(inv.total),
              label: `${c.name} · ${mk}`, cardId: c.id, cardName: c.name,
              // Só a fatura ABERTA ainda pode mudar de valor. Fechada, atrasada
              // ou paga tem valor conhecido; se foi paga, quem diz é a situação
              // na resposta, não o selo.
              status, txType: 'expense',
              estimated: inv.status === 'aberta',
              extra: { paid: r2(inv.paid), total: r2(inv.total), pending: aberto },
            })
          }
        }
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      }
      return out
    }

    case 'plans': {
      for (const p of state.installmentPlans || []) {
        if (!p) continue
        // O plano é uma dívida VIVA: o recorte por data usa a compra, mas um
        // plano ainda em aberto continua interessando mesmo que a compra tenha
        // sido antes da janela — senão "quanto falta pagar do computador"
        // dependeria de o usuário ter comprado dentro do período perguntado.
        const pp = planProgress(state, p)
        const vivo = p.status !== 'settled' && p.status !== 'cancelled' && pp.remainingCount > 0
        if (!vivo && !inRange(p.purchaseDate, from, to)) continue
        const card = cardById(state, p.cardId)
        out.push({
          id: p.id, date: p.purchaseDate, value: r2(pp.remainingAmount),
          label: p.description || 'Parcelamento',
          category: p.categoryId, cardId: p.cardId, cardName: card?.name,
          // O que já foi pago aconteceu; o que falta e o total incluem o futuro.
          planId: p.id, status: p.status, txType: 'expense', estimated: plan.field !== 'paid',
          extra: {
            remaining: r2(pp.remainingAmount), total: r2(p.totalAmount), paid: r2(pp.paidAmount),
            remainingCount: pp.remainingCount, paidCount: pp.paidCount,
            installmentCount: p.installmentCount, installmentAmount: r2(pp.currentAmount),
          },
        })
      }
      return out
    }

    case 'goals': {
      for (const g of state.goals || []) {
        if (!g) continue
        const falta = Math.max((Number(g.target) || 0) - (Number(g.saved) || 0), 0)
        out.push({
          id: g.id, date: g.createdAt || from, value: r2(falta), label: g.name,
          goalId: g.id, status: g.done ? 'done' : 'open',
          extra: {
            target: r2(Number(g.target) || 0), saved: r2(Number(g.saved) || 0),
            remaining: r2(falta),
            pct: Number(g.target) > 0 ? Math.round(((Number(g.saved) || 0) / Number(g.target)) * 100) : 0,
          },
        })
      }
      return out
    }

    case 'work': {
      for (const w of state.workSessions || []) {
        if (!w || !inRange(w.date, from, to)) continue
        out.push({
          id: w.id, date: w.date, value: Number(w.km) || 0, label: 'Turno',
          extra: { km: Number(w.km) || 0, hours: Number(w.hours) || 0, trips: Number(w.trips) || 0 },
        })
      }
      return out
    }

    case 'fuel': {
      for (const f of state.fuelRecords || []) {
        if (!f || !inRange(f.date, from, to)) continue
        out.push({
          id: f.id, date: f.date, value: Number(f.amount) || 0, label: f.station || 'Abastecimento',
          category: 'combustivel', txType: 'expense',
          extra: { liters: Number(f.liters) || 0, odometer: Number(f.odometer) || 0, amount: Number(f.amount) || 0 },
        })
      }
      return out
    }

    case 'maintenance': {
      for (const m of state.maintenance || []) {
        if (!m || !inRange(m.date, from, to)) continue
        out.push({
          id: m.id, date: m.date, value: Number(m.cost) || 0, label: m.name,
          category: 'manutencao', txType: 'expense',
          extra: { km: Number(m.kmInstalled) || 0, lifeKm: Number(m.lifeKm) || 0 },
        })
      }
      return out
    }

    case 'projections': {
      // 14 meses cobre "e em outubro?" a partir de qualquer mês do ano.
      for (const m of monthlyProjections(state, 14)) {
        const dia = `${m.monthKey}-01`
        if (!inRange(dia, from.slice(0, 8) + '01', to)) continue
        out.push({
          id: m.monthKey, date: dia, value: r2(m.installments), label: m.label,
          estimated: true,
          extra: {
            incomes: r2(m.incomes), bills: r2(m.bills), installments: r2(m.installments),
            net: r2(m.net), balance: r2(m.runningBalance), commitmentPct: m.commitmentPct,
          },
        })
      }
      return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

/**
 * O termo aparece no alvo?
 *
 * Casa por SUBSTRING e, se não bater, por TODAS as palavras presentes. A
 * segunda forma existe porque a pergunta e o histórico raramente têm as mesmas
 * palavras funcionais: quem lançou "Zé da esquina" e pergunta "quanto gastei no
 * Zé da esquina" chega aqui com o termo "ze esquina" (o "da" some no caminho),
 * e a busca por substring devolvia ZERO para um lugar com três lançamentos.
 *
 * NÃO é fuzzy: as palavras têm que estar lá, iguais (ignorando acento e caixa).
 * Aproximação de grafia continua proibida — trocar um lugar por outro parecido
 * é exatamente o que a regra 41 do CLAUDE.md impede.
 */
const contem = (alvo: string | undefined, termo: string): boolean => {
  if (!alvo) return false
  const a = normalizeName(alvo)
  const t = normalizeName(termo)
  if (!t) return false
  if (a.includes(t)) return true
  const palavras = t.split(/\s+/).filter(Boolean)
  return palavras.length > 1 && palavras.every(p => new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(a))
}

function passa(row: QueryRow, plan: AssistantQueryPlan, state: AppState): boolean {
  const f = plan.filter
  if (f.txType?.length && (!row.txType || !f.txType.includes(row.txType))) return false
  if (f.categories?.length && (!row.category || !f.categories.includes(row.category))) return false
  if (f.excludeCategories?.length && row.category && f.excludeCategories.includes(row.category)) return false

  if (f.text) {
    // O literal veio da PERGUNTA do usuário; a busca é local, por conteúdo, em
    // descrição e origem. Nunca vira regex e nunca vira chave de objeto.
    if (!(contem(row.label, f.text) || contem(row.origin, f.text) || contem(row.cardName, f.text))) return false
  }
  if (f.excludeText && (contem(row.label, f.excludeText) || contem(row.origin, f.excludeText))) return false
  if (f.excludeTexts?.some(x => contem(row.label, x) || contem(row.origin, x)
    || contem(row.cardName, x) || contem(row.platform, x))) return false
  if (f.origin && !contem(row.origin, f.origin)) return false
  if (f.origins?.length && !f.origins.some(origin => normalizeName(row.origin) === normalizeName(origin))) return false
  if (f.platform && normalizeName(row.platform || '') !== normalizeName(f.platform)
    && !contem(row.label, f.platform)) return false

  if (f.cardNames?.length && !f.cardNames.some(n => contem(row.cardName, n))) return false
  if (f.excludeCardNames?.length && f.excludeCardNames.some(n => contem(row.cardName, n))) return false

  if (f.goalName) {
    const g = (state.goals || []).find(x => x.id === row.goalId)
    if (!g || !contem(g.name, f.goalName)) return false
  }

  if (f.status?.length && (!row.status || !f.status.includes(row.status as any))) return false
  if (f.realizedOnly && row.estimated) return false
  if (f.plannedOnly && !row.estimated) return false

  if (f.weekdays?.length && !f.weekdays.includes(fromISO(row.date).getDay())) return false
  if (f.monthHalf) {
    const dia = fromISO(row.date).getDate()
    if (f.monthHalf === 'first' && dia > 15) return false
    if (f.monthHalf === 'second' && dia <= 15) return false
  }

  const v = Math.abs(row.value)
  if (f.minAmount !== undefined && v < f.minAmount) return false
  if (f.maxAmount !== undefined && v > f.maxAmount) return false

  if (f.profileAtCreation) {
    const t = (state.transactions || []).find(x => x.id === row.id)
    if (t && t.profileAtCreation && t.profileAtCreation !== f.profileAtCreation) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Agrupamento e métrica
// ---------------------------------------------------------------------------

const valorDe = (row: QueryRow, plan: AssistantQueryPlan): number => {
  const campo = plan.field || 'amount'
  if (campo === 'amount') return row.value
  const v = row.extra?.[campo]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const semanaDe = (iso: string): string => {
  const d = fromISO(iso)
  d.setDate(d.getDate() - d.getDay())
  return toISO(d)
}

function chaveDe(row: QueryRow, plan: AssistantQueryPlan, state: AppState): { key: string; label: string } | null {
  switch (plan.group) {
    case 'none': return { key: 'total', label: plan.label || 'Total' }
    case 'category': {
      if (!row.category) return { key: '—', label: 'Sem categoria' }
      return { key: row.category, label: catById(state.categories, row.category).name }
    }
    case 'origin':
      if (!row.origin) return null
      return { key: normalizeName(row.origin), label: sentenceCase(row.origin) }
    case 'card':
      if (!row.cardName) return null
      return { key: row.cardName, label: row.cardName }
    case 'month': {
      const mk = monthKey(row.date)
      return { key: mk, label: monthShortLabel(fromISO(`${mk}-01`)) }
    }
    case 'week': {
      const ini = semanaDe(row.date)
      return { key: ini, label: `semana de ${fromISO(ini).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` }
    }
    case 'day':
      return { key: row.date, label: fromISO(row.date).toLocaleDateString('pt-BR') }
    case 'weekday': {
      const d = fromISO(row.date).getDay()
      return { key: String(d), label: weekdayName(d) }
    }
    case 'month-half': {
      const dia = fromISO(row.date).getDate()
      return dia <= 15
        ? { key: '1', label: 'começo do mês (dias 1 a 15)' }
        : { key: '2', label: 'fim do mês (dia 16 em diante)' }
    }
    case 'description':
      if (!row.label) return null
      return { key: normalizeName(row.label), label: sentenceCase(row.label) }
    case 'goal':
      if (!row.goalId) return null
      return { key: row.goalId, label: row.label }
    case 'plan':
      if (!row.planId) return null
      return { key: row.planId, label: row.label }
    case 'platform':
      if (!row.platform) return null
      return { key: row.platform, label: row.platform }
  }
  return null
}

const mediana = (v: number[]): number => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  const meio = Math.floor(s.length / 2)
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2
}

/** Quantidade de motorista no período — denominador de per-km/hora/viagem. */
function quantidadeTrabalho(state: AppState, from: string, to: string) {
  let km = 0, hours = 0, trips = 0
  for (const w of state.workSessions || []) {
    if (!w || !inRange(w.date, from, to)) continue
    km += Number(w.km) || 0
    hours += Number(w.hours) || 0
    trips += Number(w.trips) || 0
  }
  return { km, hours, trips }
}

/**
 * Numerador das métricas "por unidade". Quando o recorte tem entradas E saídas,
 * "lucro por km" é (entrou − saiu) / km — somar os dois juntos daria receita
 * mais despesa, um número que não significa nada.
 */
function numerador(soma: number, rows: QueryRow[], plan: AssistantQueryPlan): number {
  const tipos = plan.filter.txType
  if (!tipos || tipos.length < 2) return soma
  let entrada = 0, saida = 0
  for (const row of rows) {
    const v = valorDe(row, plan)
    if (row.txType === 'income') entrada += v
    else if (row.txType === 'expense') saida += v
  }
  return entrada - saida
}

function aplicaMetrica(
  valores: number[], rows: QueryRow[], plan: AssistantQueryPlan, state: AppState,
  periodo: { from: string; to: string },
): number {
  const soma = valores.reduce((a, b) => a + b, 0)
  switch (plan.metric) {
    case 'sum': return soma
    case 'count': return valores.length
    case 'avg': return valores.length ? soma / valores.length : 0
    case 'median': return mediana(valores)
    case 'min': return valores.length ? Math.min(...valores) : 0
    case 'max': return valores.length ? Math.max(...valores) : 0
    case 'net': {
      let entrada = 0, saida = 0
      for (const row of rows) {
        const v = valorDe(row, plan)
        if (row.txType === 'income') entrada += v
        else if (row.txType === 'expense') saida += v
      }
      return entrada - saida
    }
    case 'per-day': {
      const dias = Math.max(Math.round((fromISO(periodo.to).getTime() - fromISO(periodo.from).getTime()) / 86400000) + 1, 1)
      return numerador(soma, rows, plan) / dias
    }
    case 'per-km': {
      const q = quantidadeTrabalho(state, periodo.from, periodo.to)
      return q.km > 0 ? numerador(soma, rows, plan) / q.km : 0
    }
    case 'per-hour': {
      const q = quantidadeTrabalho(state, periodo.from, periodo.to)
      return q.hours > 0 ? numerador(soma, rows, plan) / q.hours : 0
    }
    case 'per-trip': {
      const q = quantidadeTrabalho(state, periodo.from, periodo.to)
      return q.trips > 0 ? numerador(soma, rows, plan) / q.trips : 0
    }
    // `share` é calculado fora: ele precisa da consulta SEM os filtros de
    // conteúdo, e isso não cabe numa função que só enxerga as linhas filtradas.
    case 'share': return soma
  }
  return soma
}

const UNIDADE: Record<string, FactUnit> = {
  km: 'km', hours: 'hours', trips: 'count', liters: 'liters',
  pct: 'pct', remainingCount: 'count',
}

function unidadeDe(plan: AssistantQueryPlan): FactUnit {
  if (plan.metric === 'count') return 'count'
  if (plan.metric === 'share') return 'pct'
  if (plan.metric === 'per-km') return 'per-km'
  if (plan.metric === 'per-hour') return 'per-hour'
  if (plan.metric === 'per-trip') return 'per-trip'
  if (plan.metric === 'per-day') return 'per-day'
  return UNIDADE[plan.field || 'amount'] || 'BRL'
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

interface Agregado { total: number; count: number; groups: Map<string, { label: string; valores: number[]; rows: QueryRow[] }> }

function agrega(state: AppState, plan: AssistantQueryPlan, periodo: { from: string; to: string }): { ag: Agregado; rows: QueryRow[] } {
  const planoNoPeriodo: AssistantQueryPlan = { ...plan, period: { ...plan.period, ...periodo } }
  const brutas = rowsOf(state, planoNoPeriodo)
  const rows = brutas.filter(row => passa(row, planoNoPeriodo, state))

  const groups = new Map<string, { label: string; valores: number[]; rows: QueryRow[] }>()
  for (const row of rows) {
    const k = chaveDe(row, planoNoPeriodo, state)
    if (!k) continue
    const g = groups.get(k.key) || { label: k.label, valores: [], rows: [] }
    g.valores.push(valorDe(row, planoNoPeriodo))
    g.rows.push(row)
    groups.set(k.key, g)
  }

  const todosValores = rows.map(row => valorDe(row, planoNoPeriodo))
  return {
    ag: {
      total: aplicaMetrica(todosValores, rows, planoNoPeriodo, state, periodo),
      count: rows.length,
      groups,
    },
    rows,
  }
}

/**
 * Denominador de `share`: mesmo período, SEM os filtros de conteúdo.
 *
 * O tipo do denominador é escolhido por `shareBase`, e é aí que mora a
 * diferença entre uma resposta útil e um 100% inútil: "quanto das minhas
 * ENTRADAS eu consegui guardar" compara `saving` com `income`. Usar o mesmo
 * tipo dos dois lados devolveria sempre 100%.
 */
function baseParaShare(state: AppState, plan: AssistantQueryPlan): number {
  const tipoBase = plan.shareBase === 'income' ? (['income'] as any)
    : plan.shareBase === 'expense' ? (['expense'] as any)
      : plan.filter.txType
  const limpo: AssistantQueryPlan = {
    ...plan,
    group: 'none',
    metric: 'sum',
    filter: {
      txType: tipoBase,
      realizedOnly: plan.filter.realizedOnly,
      plannedOnly: plan.filter.plannedOnly,
    },
  }
  return agrega(state, limpo, plan.period).ag.total
}

const factId = (() => {
  let n = 0
  return () => `f${++n}`
})()

/**
 * Executa o plano. Nunca lança: entrada estranha vira resultado vazio com
 * `caveats`, porque um erro não tratado no meio de uma pergunta é pior para o
 * usuário do que um "não consegui responder isso".
 */
export function runQuery(state: AppState, plan: AssistantQueryPlan): AssistantQueryResult {
  const unit = unidadeDe(plan)
  const { ag, rows } = agrega(state, plan, plan.period)
  const caveats: string[] = []

  let total = ag.total
  // Pagamento parcial de fatura reduz a dívida do CARTÃO, mas não tem vínculo
  // com um plano específico. Só substituímos a soma na pergunta pelo cartão;
  // atribuir o crédito a um plano individual inventaria uma alocação.
  const cardDebt = plan.source === 'plans' && plan.field === 'remaining'
    && plan.metric === 'sum' && plan.group === 'none' && !plan.comparePeriod
    && plan.filter.cardNames?.length === 1 && !plan.filter.text
    && !plan.filter.categories?.length && !plan.filter.status?.length
    ? activeCards(state).find(c => c.name === plan.filter.cardNames![0]) : undefined
  if (cardDebt) total = cardOutstanding(state, cardDebt.id)
  let base = 0
  // "Por dia" divide pelos dias CORRIDOS. Para quem não trabalha todo dia, o
  // número muda muito conforme o divisor — a resposta diz qual foi.
  if (plan.metric === 'per-day') {
    const dias = Math.round((fromISO(plan.period.to).getTime() - fromISO(plan.period.from).getTime()) / 86400000) + 1
    if (dias > 1) caveats.push(`Dividido pelos ${dias} dias corridos do período, com ou sem lançamento.`)
  }
  if (plan.metric === 'share') {
    base = baseParaShare(state, plan)
    total = base > 0 ? (ag.total / base) * 100 : 0
    if (base <= 0) caveats.push('Não tenho o total do período para calcular a proporção.')
  }

  let compareTotal: number | undefined
  let compareGroups: Map<string, number> | undefined
  let compareCount: number | undefined
  if (plan.comparePeriod) {
    const c = agrega(state, plan, plan.comparePeriod)
    compareCount = c.rows.length
    compareTotal = plan.metric === 'share'
      ? (base > 0 ? (c.ag.total / base) * 100 : 0)
      : c.ag.total
    compareGroups = new Map([...c.ag.groups.entries()].map(([k, g]) =>
      [k, aplicaMetrica(g.valores, g.rows, plan, state, plan.comparePeriod!)]))
  }

  const groups: QueryGroupResult[] = [...ag.groups.entries()].map(([key, g]) => {
    const valor = plan.metric === 'share'
      ? (base > 0 ? (g.valores.reduce((a, b) => a + b, 0) / base) * 100 : 0)
      : aplicaMetrica(g.valores, g.rows, plan, state, plan.period)
    // Grupo que NÃO existia no período de comparação vale ZERO lá, não
    // "sem diferença": uma categoria que apareceu do nada é a maior alta
    // possível, e deixá-la sem delta a tirava do ranking de "o que aumentou".
    const anterior = compareGroups ? (compareGroups.get(key) ?? 0) : undefined
    const delta = anterior === undefined ? undefined : r2(valor - anterior)
    return {
      key, label: g.label, value: r2(cardDebt ? total : valor), count: g.valores.length,
      compareValue: anterior === undefined ? undefined : r2(anterior),
      delta,
      deltaPct: anterior !== undefined && anterior !== 0 ? Math.round(((valor - anterior) / Math.abs(anterior)) * 100) : undefined,
    }
  })

  // Grupos que existem SÓ no período de comparação (categoria que sumiu). Sem
  // isto, "o que caiu mais" nunca acharia o que zerou — que é justamente a
  // maior queda possível.
  if (compareGroups) {
    for (const [key, valorAnterior] of compareGroups) {
      if (ag.groups.has(key)) continue
      const c = agrega(state, plan, plan.comparePeriod!)
      const g = c.ag.groups.get(key)
      groups.push({
        key, label: g?.label || key, value: 0, count: 0,
        compareValue: r2(valorAnterior), delta: r2(-valorAnterior),
        deltaPct: valorAnterior !== 0 ? -100 : undefined,
      })
    }
  }

  // "Quanto eu ganho POR MÊS em média": a média dos TOTAIS mensais. Lida como
  // média por lançamento agrupada por mês, a resposta era "R$ 1.396" para quem
  // recebe R$ 3.000 todo mês (dois aluguéis de R$ 1.500). Cada mês vale o que
  // somou; a média usa os meses COMPLETOS desde o primeiro com dado — o mês
  // corrente ainda não fechou, e os meses antes do primeiro registro não são
  // zero, são falta de histórico.
  if (plan.metric === 'avg' && plan.group === 'month' && !plan.comparePeriod) {
    // O mês que o período corta no meio (termina antes do último dia) não fechou.
    const fim = fromISO(plan.period.to)
    const mesAtual = new Date(fim.getFullYear(), fim.getMonth() + 1, 0).getDate() === fim.getDate()
      ? '9999-99' : monthKey(plan.period.to)
    for (const g of groups) {
      const soma = ag.groups.get(g.key)?.valores.reduce((a, b) => a + b, 0) ?? 0
      g.value = r2(soma)
    }
    const comDado = [...ag.groups.keys()].sort()
    const fechados = comDado.filter(k => k < mesAtual)
    const usados = (fechados.length ? fechados : comDado)
    if (usados.length) {
      const meses: string[] = []
      for (let k = usados[0]; k <= usados[usados.length - 1]; k = monthKey(toISO(new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 1)))) meses.push(k)
      const soma = meses.reduce((a, k) => a + (ag.groups.get(k)?.valores.reduce((x, y) => x + y, 0) ?? 0), 0)
      total = soma / meses.length
      const nome = (k: string) => monthShortLabel(fromISO(`${k}-01`))
      caveats.push(meses.length === 1
        ? `Média de 1 mês completo (${nome(meses[0])}).`
        : `Média de ${meses.length} meses completos (${nome(meses[0])} a ${nome(meses[meses.length - 1])})${fechados.length && comDado.includes(mesAtual) ? '; o mês atual ainda não fechou e fica fora' : ''}.`)
    }
  }

  // Ordenar por diferença sem ter comparação devolveria a lista na ordem do
  // acaso com cara de ranking. Sem `comparePeriod`, cai no valor.
  const pedida = plan.order
  const ordem = (pedida === 'delta-desc' || pedida === 'delta-asc') && !plan.comparePeriod
    ? 'value-desc'
    : pedida || (plan.group === 'none' ? 'value-desc'
      : (plan.group === 'month' || plan.group === 'day' || plan.group === 'week') ? 'date-asc' : 'value-desc')
  // "Qual foi meu pior mês": o mês que o período corta no meio ainda não
  // fechou e perdia (ou ganhava) por estar pela metade. Fica fora do
  // ranking, e a resposta diz isso.
  if (plan.group === 'month' && (ordem === 'value-asc' || ordem === 'value-desc') && !plan.comparePeriod) {
    const fimDoPeriodo = fromISO(plan.period.to)
    const corta = new Date(fimDoPeriodo.getFullYear(), fimDoPeriodo.getMonth() + 1, 0).getDate() !== fimDoPeriodo.getDate()
    const incompleto = corta ? groups.findIndex(g => g.key === monthKey(plan.period.to)) : -1
    if (incompleto >= 0 && groups.length > 1) {
      groups.splice(incompleto, 1)
      caveats.push(`${sentenceCase(monthShortLabel(fimDoPeriodo))}, ainda incompleto, ficou fora da comparação.`)
    }
  }
  groups.sort((a, b) => {
    switch (ordem) {
      case 'value-asc': return a.value - b.value
      case 'date-asc': return a.key.localeCompare(b.key)
      case 'date-desc': return b.key.localeCompare(a.key)
      case 'count-desc': return b.count - a.count
      case 'delta-desc': return (b.delta ?? 0) - (a.delta ?? 0)
      case 'delta-asc': return (a.delta ?? 0) - (b.delta ?? 0)
      default: return b.value - a.value
    }
  })
  const limitados = groups.slice(0, plan.limit || 8)

  // ---- Ressalvas honestas ------------------------------------------------
  // "Qual cliente me pagou mais" sem cliente registrado em NENHUM lançamento:
  // sem esta frase a resposta era só o total, e parecia que ninguém tinha
  // entendido a pergunta. O app não adivinha origem (regra do CLAUDE.md).
  if (plan.group === 'origin' && rows.length > 0 && !groups.length) {
    caveats.push('Nenhum desses lançamentos tem origem registrada (cliente, imóvel, empresa), então não dá para dizer de quem veio mais.')
  }
  if (plan.period.future || rows.every(row => row.estimated) && rows.length > 0) {
    caveats.push('São valores previstos, não realizados.')
  }
  if ((plan.metric === 'avg' || plan.metric === 'median') && rows.length < 3) {
    caveats.push(`Só ${rows.length} ${rows.length === 1 ? 'lançamento' : 'lançamentos'} no período — a média ainda diz pouco.`)
  }
  if (plan.filter.origin && plan.source === 'transactions') {
    // O caso do imóvel: dá para somar o que ENTROU da Casa 1, mas afirmar lucro
    // líquido exige despesas vinculadas à mesma origem — e quase nunca existem.
    const temDespesaDaOrigem = rows.some(row => row.txType === 'expense')
    if (!temDespesaDaOrigem && (plan.metric === 'net' || plan.filter.txType?.includes('expense'))) {
      caveats.push('Nenhuma despesa está vinculada a essa origem, então não dá para afirmar o resultado líquido dela.')
    }
  }
  if (plan.metric === 'per-km' || plan.metric === 'per-hour' || plan.metric === 'per-trip') {
    const q = quantidadeTrabalho(state, plan.period.from, plan.period.to)
    const alvo = plan.metric === 'per-km' ? q.km : plan.metric === 'per-hour' ? q.hours : q.trips
    if (alvo <= 0) caveats.push('Não tenho km, horas ou viagens registrados no período para essa conta.')
  }

  const datas = rows.map(row => row.date).filter(Boolean).sort()
  const facts = montaFatos(plan, total, limitados, compareTotal, rows.length, unit, state)

  return {
    plan,
    total: r2(total),
    count: rows.length,
    groups: limitados,
    compareTotal: compareTotal === undefined ? undefined : r2(compareTotal),
    compareCount,
    delta: compareTotal === undefined ? undefined : r2(total - compareTotal),
    deltaPct: compareTotal !== undefined && compareTotal !== 0
      ? Math.round(((total - compareTotal) / Math.abs(compareTotal)) * 100)
      : undefined,
    unit,
    // Parcela que ainda não venceu é previsão, mesmo com data no passado do
    // recorte. Sem esta flag a resposta dizia "(dado real)" para o que o
    // usuário ainda vai pagar.
    estimated: plan.period.future || plan.source === 'projections' || plan.source === 'recurring'
      || (plan.source === 'plans' && plan.field !== 'paid') || (rows.length > 0 && rows.every(row => !!row.estimated)),
    sample: { rows: rows.length, from: datas[0] || plan.period.from, to: datas[datas.length - 1] || plan.period.to },
    empty: rows.length === 0,
    caveats,
    facts,
    samples: rows.slice(0, 6),
  }
}

function montaFatos(
  plan: AssistantQueryPlan, total: number, groups: QueryGroupResult[],
  compareTotal: number | undefined, rows: number, unit: FactUnit, state: AppState,
): AssistantFact[] {
  const estimado = plan.period.future || plan.source === 'projections' || plan.source === 'recurring'
  const periodo = { from: plan.period.from, to: plan.period.to, label: plan.period.label }
  const facts: AssistantFact[] = [{
    id: factId(),
    label: plan.label || 'Total',
    value: r2(total),
    unit,
    period: periodo,
    provenance: { source: plan.source, rows, detail: plan.metric },
    estimated: estimado || undefined,
  }]
  if (compareTotal !== undefined && plan.comparePeriod) {
    facts.push({
      id: factId(),
      label: `${plan.label || 'Total'} — ${plan.comparePeriod.label}`,
      value: r2(compareTotal), unit,
      period: { from: plan.comparePeriod.from, to: plan.comparePeriod.to, label: plan.comparePeriod.label },
      provenance: { source: plan.source, rows, detail: `${plan.metric} (comparação)` },
      estimated: estimado || undefined,
    })
    facts.push({
      id: factId(),
      label: 'Diferença entre os períodos',
      value: r2(total - compareTotal), unit,
      provenance: { source: plan.source, rows, detail: 'diferença' },
      estimated: estimado || undefined,
    })
  }
  if (plan.group !== 'none') {
    for (const g of groups) {
      facts.push({
        id: factId(), label: g.label, value: g.value, unit, period: periodo,
        provenance: { source: plan.source, rows: g.count, detail: plan.group },
        estimated: estimado || undefined,
      })
      if (g.delta !== undefined) {
        facts.push({
          id: factId(), label: `${g.label} — diferença`, value: g.delta, unit,
          provenance: { source: plan.source, rows: g.count, detail: 'diferença' },
          estimated: estimado || undefined,
        })
      }
    }
  }
  void state
  return facts
}
