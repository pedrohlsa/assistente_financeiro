// Cartões, parcelamentos e faturas — toda a matemática desta área sai daqui.
//
// REGRA DE CONTABILIZAÇÃO (não pode ser quebrada):
// 1. Compra no cartão / parcelamento NÃO cria Transaction. O histórico da compra
//    pelo valor total é o InstallmentPlan; o fluxo de caixa mensal é a soma das
//    PARCELAS que vencem no mês. Nunca os dois somados.
// 2. Pagar a fatura não gera despesa nova — quita a dívida e (se o usuário
//    escolher) reduz o saldo em conta. A despesa já foi contada como parcela.
// 3. Por isso nenhum cálculo daqui entra em periodStats/monthStats: os números
//    de receita e despesa do app continuam exatamente como eram.
import {
  AppState, CreditCard, Installment, InstallmentPlan, RecurringCardCharge,
} from '../models/types'
import { addDays, dateForDayOfMonth, fromISO, monthKey, todayISO, toISO } from '../utils/format'
import { normalizeName, sameName } from '../utils/text'

const round2 = (v: number) => Math.round(v * 100) / 100

/** Dia válido dentro do mês (dia 31 em fevereiro vira o último dia). */
const clampDay = dateForDayOfMonth

/**
 * Vencimento sugerido quando o usuário não informa: 7 dias corridos depois do
 * fechamento, com cálculo real de calendário (fechamento dia 25 em julho cai no
 * dia 1º de agosto). Nunca um dia 5 fixo.
 */
export function suggestedDueDay(closingDay: number, reference = todayISO()): number {
  const ref = fromISO(reference)
  const closing = clampDay(ref.getFullYear(), ref.getMonth(), closingDay)
  return new Date(closing.getFullYear(), closing.getMonth(), closing.getDate() + 7).getDate()
}

/**
 * Cartão já cadastrado com nome equivalente (ignora caixa, acento e espaços).
 * Não bloqueia o cadastro — serve para pedir confirmação (item 12).
 */
export function findCardByExactName(s: AppState, name?: string, exceptId?: string): CreditCard | undefined {
  if (!normalizeName(name)) return undefined
  return (s.cards || []).find(c => c.id !== exceptId && sameName(c.name, name))
}

/**
 * Divide o total em N parcelas sem perder centavos: as primeiras ficam com o
 * valor arredondado para baixo e a ÚLTIMA absorve a diferença.
 * 1000/3 → 333,33 · 333,33 · 333,34
 */
export function splitInstallmentAmounts(total: number, count: number): number[] {
  const n = Math.max(Math.floor(count), 1)
  const base = Math.floor((total * 100) / n) / 100
  const out = Array(n).fill(base)
  out[n - 1] = round2(total - base * (n - 1))
  return out
}

/**
 * Vencimento da primeira fatura em que a compra cai: se a compra aconteceu
 * depois do fechamento, entra na fatura seguinte.
 */
export function nextInvoiceDueDate(card: CreditCard, purchaseDate: string): string {
  const p = fromISO(purchaseDate)
  const closed = p.getDate() > card.closingDay
  const d = clampDay(p.getFullYear(), p.getMonth() + (closed ? 1 : 0), card.dueDay)
  // vencimento nunca pode cair antes da compra
  return toISO(d < p ? clampDay(p.getFullYear(), p.getMonth() + (closed ? 2 : 1), card.dueDay) : d)
}

/** Gera as parcelas de um plano — mensais, a partir de firstDueDate. */
export function buildInstallments(plan: InstallmentPlan, idGen: () => string): Installment[] {
  const amounts = splitInstallmentAmounts(plan.totalAmount, plan.installmentCount)
  const first = fromISO(plan.firstDueDate)
  const day = first.getDate()
  return amounts.map((amount, i) => ({
    id: idGen(),
    planId: plan.id,
    number: i + 1,
    total: amounts.length,
    amount,
    dueDate: toISO(clampDay(first.getFullYear(), first.getMonth() + i, day)),
    status: 'pending' as const,
  }))
}

// ---------- CONSULTAS ----------

export const activeCards = (s: AppState): CreditCard[] => (s.cards || []).filter(c => !c.archived)
export const cardById = (s: AppState, id?: string) => (s.cards || []).find(c => c.id === id)

export const planInstallments = (s: AppState, planId: string): Installment[] =>
  (s.installments || []).filter(i => i.planId === planId).sort((a, b) => a.number - b.number)

export const planById = (s: AppState, id: string) => (s.installmentPlans || []).find(p => p.id === id)

/** Parcelamentos que ainda geram obrigação (não quitados nem cancelados). */
export const activePlans = (s: AppState): InstallmentPlan[] =>
  (s.installmentPlans || []).filter(p => p.status === 'active')

/** Parcelas que vencem no mês de referência ('YYYY-MM'), ignorando canceladas. */
export function installmentsInMonth(s: AppState, mk: string): Installment[] {
  const cancelledPlans = new Set((s.installmentPlans || []).filter(p => p.status === 'cancelled').map(p => p.id))
  return (s.installments || [])
    .filter(i => i.status !== 'cancelled' && !cancelledPlans.has(i.planId) && monthKey(i.dueDate) === mk)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

/** Assinaturas ativas que caem no mês de referência. */
export function chargesInMonth(s: AppState, mk: string): RecurringCardCharge[] {
  return (s.cardCharges || []).filter(c => {
    if (c.active === false) return false
    if (monthKey(c.nextDate) > mk) return false          // ainda não começou
    if (c.endDate && monthKey(c.endDate) < mk) return false // já terminou
    return c.frequency === 'monthly' || monthKey(c.nextDate) === mk
  })
}

/**
 * Compromisso total do mês: parcelas + assinaturas. É ESTE número que entra nas
 * projeções e no impacto sobre a meta — nunca o valor total das compras.
 */
export function monthlyCommitments(s: AppState, mk: string): number {
  const inst = installmentsInMonth(s, mk).reduce((a, i) => a + i.amount, 0)
  const charges = chargesInMonth(s, mk).reduce((a, c) => a + c.amount, 0)
  return round2(inst + charges)
}

/** Parcelas deste mês (atalho usado pela Home, meta e IA). */
export const installmentsThisMonth = (s: AppState): number => monthlyCommitments(s, monthKey(todayISO()))

/** Parcelas vencidas e ainda não pagas. */
export function overdueInstallments(s: AppState): Installment[] {
  const t = todayISO()
  const cancelled = new Set((s.installmentPlans || []).filter(p => p.status === 'cancelled').map(p => p.id))
  return (s.installments || [])
    .filter(i => i.status === 'pending' && !cancelled.has(i.planId) && i.dueDate < t)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

// ---------- FATURAS ----------

export type InvoiceStatus = 'aberta' | 'fechada' | 'paga' | 'parcial' | 'atrasada'

export interface InvoiceItem {
  label: string
  amount: number
  kind: 'installment' | 'charge' | 'initial'
  planId?: string
  installmentNumber?: number
  installmentTotal?: number
  dueDate: string
}

export interface CardInvoice {
  card: CreditCard
  monthKey: string      // 'YYYY-MM' do vencimento
  closingDate: string
  dueDate: string
  items: InvoiceItem[]
  total: number
  paid: number
  pending: number
  status: InvoiceStatus
}

/** Fatura de um cartão no mês de referência ('YYYY-MM' do vencimento). */
export function cardInvoice(s: AppState, card: CreditCard, mk: string): CardInvoice {
  const [y, m] = mk.split('-').map(Number)
  const due = clampDay(y, m - 1, card.dueDay)
  // o fechamento acontece antes do vencimento (mesmo mês se o dia for menor)
  const closing = card.closingDay <= card.dueDay
    ? clampDay(y, m - 1, card.closingDay)
    : clampDay(y, m - 2, card.closingDay)

  const items: InvoiceItem[] = []
  for (const i of installmentsInMonth(s, mk)) {
    const plan = planById(s, i.planId)
    if (!plan || plan.cardId !== card.id) continue
    items.push({
      label: plan.description, amount: i.amount, kind: 'installment',
      planId: plan.id, installmentNumber: i.number, installmentTotal: i.total, dueDate: i.dueDate,
    })
  }
  for (const c of chargesInMonth(s, mk)) {
    if (c.cardId !== card.id) continue
    // Uma assinatura nunca entra numa fatura que já venceu antes dela existir:
    // cadastrada hoje, ela cai na próxima fatura, não na anterior.
    if (c.nextDate > toISO(due)) continue
    items.push({ label: c.description, amount: c.amount, kind: 'charge', dueDate: toISO(due) })
  }
  // saldo que já existia quando o cartão foi cadastrado entra na primeira fatura
  const firstMk = monthKey(nextInvoiceDueDate(card, card.createdAt))
  if (card.initialInvoiceBalance && mk === firstMk) {
    items.push({ label: 'Saldo anterior da fatura', amount: card.initialInvoiceBalance, kind: 'initial', dueDate: toISO(due) })
  }

  const total = round2(items.reduce((a, i) => a + i.amount, 0))
  const paid = round2((s.cardPayments || [])
    .filter(p => p.cardId === card.id && p.referenceMonth === mk)
    .reduce((a, p) => a + p.amount, 0))
  const pending = round2(Math.max(total - paid, 0))

  const t = todayISO()
  let status: InvoiceStatus
  if (total > 0 && pending <= 0.009) status = 'paga'
  else if (paid > 0.009) status = pending > 0 && t > toISO(due) ? 'atrasada' : 'parcial'
  else if (t > toISO(due) && total > 0) status = 'atrasada'
  else if (t > toISO(closing)) status = 'fechada'
  else status = 'aberta'

  return { card, monthKey: mk, closingDate: toISO(closing), dueDate: toISO(due), items, total, paid, pending, status }
}

/** Fatura corrente: a próxima a vencer (ou a de hoje, se ainda não venceu). */
export function currentInvoice(s: AppState, card: CreditCard): CardInvoice {
  const t = fromISO(todayISO())
  const thisMk = monthKey(todayISO())
  const inv = cardInvoice(s, card, thisMk)
  if (fromISO(inv.dueDate) >= t || inv.pending > 0) return inv
  const nxt = new Date(t.getFullYear(), t.getMonth() + 1, 1)
  return cardInvoice(s, card, monthKey(toISO(nxt)))
}

/** Próximas N faturas do cartão a partir do mês atual. */
export function upcomingInvoices(s: AppState, card: CreditCard, months = 6): CardInvoice[] {
  const t = fromISO(todayISO())
  const out: CardInvoice[] = []
  for (let i = 0; i < months; i++) {
    const d = new Date(t.getFullYear(), t.getMonth() + i, 1)
    out.push(cardInvoice(s, card, monthKey(toISO(d))))
  }
  return out
}

/**
 * Dívida em aberto do cartão = tudo que ainda será cobrado (parcelas pendentes)
 * menos o que já foi pago em faturas. É o limite comprometido.
 */
export function cardOutstanding(s: AppState, cardId: string): number {
  const planIds = new Set((s.installmentPlans || [])
    .filter(p => p.cardId === cardId && p.status !== 'cancelled').map(p => p.id))
  const pending = (s.installments || [])
    .filter(i => planIds.has(i.planId) && i.status === 'pending')
    .reduce((a, i) => a + (i.amount - (i.paidAmount || 0)), 0)

  // O saldo anterior entra na primeira fatura: só continua devido enquanto
  // essa fatura não foi quitada.
  const card = cardById(s, cardId)
  let initialLeft = 0
  if (card?.initialInvoiceBalance) {
    const firstInvoice = cardInvoice(s, card, monthKey(nextInvoiceDueDate(card, card.createdAt)))
    initialLeft = Math.min(card.initialInvoiceBalance, firstInvoice.pending)
  }
  return round2(Math.max(pending + initialLeft, 0))
}

export interface CardLimits {
  limit: number
  used: number       // limite comprometido
  available: number
  pct: number        // % do limite usado
}

export function cardLimits(s: AppState, card: CreditCard): CardLimits {
  const used = cardOutstanding(s, card.id)
  const limit = card.limit || 0
  return {
    limit, used,
    available: round2(Math.max(limit - used, 0)),
    pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
  }
}

// ---------- PROGRESSO DO PARCELAMENTO ----------

export interface PlanProgress {
  plan: InstallmentPlan
  installments: Installment[]
  paidCount: number
  remainingCount: number
  paidAmount: number
  remainingAmount: number   // saldo que ainda falta pagar
  currentAmount: number     // valor da parcela atual/próxima
  nextDueDate?: string
  overdueCount: number
  pct: number
  card?: CreditCard
}

export function planProgress(s: AppState, plan: InstallmentPlan): PlanProgress {
  const list = planInstallments(s, plan.id)
  const active = list.filter(i => i.status !== 'cancelled')
  const paid = active.filter(i => i.status === 'paid')
  const pending = active.filter(i => i.status === 'pending').sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const t = todayISO()
  const paidAmount = round2(paid.reduce((a, i) => a + i.amount, 0) + active.filter(i => i.status === 'pending').reduce((a, i) => a + (i.paidAmount || 0), 0))
  const totalActive = round2(active.reduce((a, i) => a + i.amount, 0))
  return {
    plan,
    installments: list,
    paidCount: paid.length,
    remainingCount: pending.length,
    paidAmount,
    remainingAmount: round2(Math.max(totalActive - paidAmount, 0)),
    currentAmount: pending[0]?.amount ?? active[active.length - 1]?.amount ?? 0,
    nextDueDate: pending[0]?.dueDate,
    overdueCount: pending.filter(i => i.dueDate < t).length,
    pct: totalActive > 0 ? Math.round((paidAmount / totalActive) * 100) : 0,
    card: cardById(s, plan.cardId),
  }
}

// ---------- RESUMO GERAL ----------

export interface CardsOverview {
  openInvoicesTotal: number     // faturas em aberto (a pagar agora)
  nextInvoicesTotal: number     // próximas faturas (mês seguinte)
  totalDebt: number             // dívida parcelada restante (todos os planos)
  installmentsThisMonth: number // parcelas + assinaturas que vencem neste mês
  installmentsNextMonth: number
  totalLimit: number
  usedLimit: number
  availableLimit: number
  activePlanCount: number
  overdueCount: number
  overdueAmount: number
  hasData: boolean
}

export function cardsOverview(s: AppState): CardsOverview {
  const t = todayISO()
  const thisMk = monthKey(t)
  const d = fromISO(t)
  const nextMk = monthKey(toISO(new Date(d.getFullYear(), d.getMonth() + 1, 1)))
  const cards = activeCards(s)

  const openInvoicesTotal = round2(cards.reduce((a, c) => a + currentInvoice(s, c).pending, 0))
  const nextInvoicesTotal = round2(cards.reduce((a, c) => a + cardInvoice(s, c, nextMk).pending, 0))
  const totalDebt = round2(activePlans(s).reduce((a, p) => a + planProgress(s, p).remainingAmount, 0))
  const totalLimit = round2(cards.reduce((a, c) => a + (c.limit || 0), 0))
  const usedLimit = round2(cards.reduce((a, c) => a + cardOutstanding(s, c.id), 0))
  const overdue = overdueInstallments(s)

  return {
    openInvoicesTotal, nextInvoicesTotal, totalDebt,
    installmentsThisMonth: monthlyCommitments(s, thisMk),
    installmentsNextMonth: monthlyCommitments(s, nextMk),
    totalLimit, usedLimit,
    availableLimit: round2(Math.max(totalLimit - usedLimit, 0)),
    activePlanCount: activePlans(s).length,
    overdueCount: overdue.length,
    overdueAmount: round2(overdue.reduce((a, i) => a + i.amount, 0)),
    hasData: (s.cards?.length || 0) > 0 || (s.installmentPlans?.length || 0) > 0,
  }
}

// ---------- LINHA DO TEMPO ----------

export interface TimelineEntry {
  date: string
  label: string
  detail?: string
  amount: number
  direction: 'in' | 'out'
  kind: 'installment' | 'invoice' | 'income' | 'bill' | 'charge'
  status?: 'pago' | 'pendente' | 'vencido'
}

/**
 * Vencimentos em ordem cronológica. A fatura do cartão aparece como UM item
 * agregando suas parcelas — as parcelas do cartão não são listadas de novo,
 * para não contar a mesma obrigação duas vezes (seção 10).
 */
export function commitmentTimeline(s: AppState, fromDate: string, toDate: string): TimelineEntry[] {
  const out: TimelineEntry[] = []
  const t = todayISO()

  // faturas de cartão (agregam as parcelas do próprio cartão)
  const seenInvoice = new Set<string>()
  for (const card of activeCards(s)) {
    let cursor = fromISO(fromDate)
    const end = fromISO(toDate)
    while (cursor <= end) {
      const mk = monthKey(toISO(cursor))
      const key = card.id + mk
      if (!seenInvoice.has(key)) {
        seenInvoice.add(key)
        const inv = cardInvoice(s, card, mk)
        if (inv.total > 0.009 && inv.dueDate >= fromDate && inv.dueDate <= toDate) {
          out.push({
            date: inv.dueDate,
            label: `${card.name} — vencimento da fatura`,
            detail: `${inv.items.length} item(ns)`,
            amount: inv.total,
            direction: 'out',
            kind: 'invoice',
            status: inv.status === 'paga' ? 'pago' : inv.status === 'atrasada' ? 'vencido' : 'pendente',
          })
        }
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
  }

  // parcelamentos SEM cartão (não estão em nenhuma fatura)
  for (const plan of (s.installmentPlans || [])) {
    if (plan.status === 'cancelled' || plan.cardId) continue
    for (const i of planInstallments(s, plan.id)) {
      if (i.status === 'cancelled' || i.dueDate < fromDate || i.dueDate > toDate) continue
      out.push({
        date: i.dueDate,
        label: plan.description,
        detail: `parcela ${i.number} de ${i.total}`,
        amount: i.amount,
        direction: 'out',
        kind: 'installment',
        status: i.status === 'paid' ? 'pago' : i.dueDate < t ? 'vencido' : 'pendente',
      })
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------- IMPACTO DE UMA NOVA COMPRA ----------

export interface PurchaseImpact {
  installmentAmount: number
  months: number
  firstDueDate: string
  lastDueDate: string
  totalAmount: number
}

/** Simula o impacto de uma compra antes de confirmar (seção 13 e 15). */
export function simulatePurchase(total: number, count: number, firstDueDate: string): PurchaseImpact {
  const amounts = splitInstallmentAmounts(total, count)
  const first = fromISO(firstDueDate)
  const last = clampDay(first.getFullYear(), first.getMonth() + amounts.length - 1, first.getDate())
  return {
    installmentAmount: amounts[0],
    months: amounts.length,
    firstDueDate,
    lastDueDate: toISO(last),
    totalAmount: round2(total),
  }
}

/** Data sugerida para a 1ª parcela: pelo cartão, ou daqui a ~30 dias. */
export function suggestedFirstDueDate(card: CreditCard | undefined, purchaseDate: string): string {
  return card ? nextInvoiceDueDate(card, purchaseDate) : addDays(purchaseDate, 30)
}

export { round2 }
