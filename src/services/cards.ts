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
  AppState, CardPayment, CreditCard, Installment, InstallmentPlan, RecurringCardCharge, Transaction,
} from '../models/types'
import { addDays, dateForDayOfMonth, fromISO, isCalendarDate, monthKey, todayISO, toISO } from '../utils/format'
import { normalizeName, sameName } from '../utils/text'

/** Data do dinheiro já pago; vencimento futuro pode ser quitado hoje. */
export function validPaymentDate(date: string, today = todayISO()): boolean {
  return isCalendarDate(date) && date <= today
}

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
  const cents = Math.round(total * 100)
  const base = Math.floor(cents / n)
  const out = Array<number>(n).fill(base / 100)
  out[n - 1] = (cents - base * (n - 1)) / 100
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
export function buildInstallments(plan: InstallmentPlan, idGen: () => string, alreadyPaid = 0): Installment[] {
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
    status: i < alreadyPaid ? 'paid' as const : 'pending' as const,
    ...(i < alreadyPaid ? { paidAmount: amount } : {}),
  }))
}

// ---------- CONSULTAS ----------

export const activeCards = (s: AppState): CreditCard[] => (s.cards || []).filter(c => !c.archived)
export const cardById = (s: AppState, id?: string) => (s.cards || []).find(c => c.id === id)

export const planInstallments = (s: AppState, planId: string): Installment[] =>
  (s.installments || []).filter(i => i.planId === planId).sort((a, b) => a.number - b.number)

export const planById = (s: AppState, id: string) => (s.installmentPlans || []).find(p => p.id === id)

function matchesLegacyFinancing(plan: InstallmentPlan, tx: Transaction): boolean {
  return plan.operationType === 'financed-cash-inflow' && tx.type === 'financed-cash-inflow' && !tx.financedPlanId
    && tx.date === plan.purchaseDate && Math.abs(tx.amount - (plan.netReceived ?? NaN)) < 0.005
    && (!plan.assistantBatchId || tx.assistantBatchId === plan.assistantBatchId)
}

export function financingForTransaction(s: AppState, tx: Transaction): InstallmentPlan | undefined {
  if (tx.type !== 'financed-cash-inflow') return undefined
  if (tx.financedPlanId) {
    const plan = planById(s, tx.financedPlanId)
    return plan?.operationType === 'financed-cash-inflow' ? plan : undefined
  }
  return s.installmentPlans.find(plan => matchesLegacyFinancing(plan, tx))
}

type PlanRemoval =
  | { allowed: true; receipt?: Transaction }
  | { allowed: false; message: string; legacyOptions?: Transaction[] }

export function invoicePaymentsForInstallments(payments: CardPayment[], cardId: string | undefined, installments: Installment[]): CardPayment[] {
  if (!cardId || !installments.length) return []
  const ids = new Set(installments.map(i => i.id))
  const months = new Set(installments.filter(i => isCalendarDate(i.dueDate)).map(i => monthKey(i.dueDate)))
  return payments.filter(p => p.cardId === cardId
    && (months.has(p.referenceMonth) || p.settledInstallmentIds?.some(id => ids.has(id))))
}

export function hasRecordedInstallmentPayment(i: Installment): boolean {
  return i.status === 'paid' || !!i.paidAt || (i.paidAmount || 0) > 0 || !!i.directPayments?.length || i.paidVia === 'invoice'
}

export function futureInstallmentsToCancel(s: AppState, plan: InstallmentPlan, today = todayISO()): Installment[] {
  return planInstallments(s, plan.id).filter(i => i.status === 'pending' && i.dueDate > today && isCalendarDate(i.dueDate)
    && !hasRecordedInstallmentPayment(i) && !invoicePaymentsForInstallments(s.cardPayments, plan.cardId, [i]).length)
}

export function checkPlanRemoval(s: AppState, plan: InstallmentPlan, legacyReceiptId?: string): PlanRemoval {
  const installments = planInstallments(s, plan.id)
  if (invoicePaymentsForInstallments(s.cardPayments, plan.cardId, installments).length) {
    return { allowed: false, message: 'Há pagamentos nas faturas deste parcelamento. Confira esses pagamentos antes de excluir o plano.' }
  }
  if (plan.operationType !== 'financed-cash-inflow') return { allowed: true }
  if (installments.some(hasRecordedInstallmentPayment)) {
    return { allowed: false, message: 'Há pagamentos registrados neste financiamento. Confira as parcelas antes de excluir a operação.' }
  }
  const linked = s.transactions.filter(t => t.financedPlanId === plan.id)
  if (linked.length) {
    const [receipt] = linked
    return linked.length === 1 && receipt.type === 'financed-cash-inflow' && receipt.date === plan.purchaseDate
      && Math.abs(receipt.amount - (plan.netReceived ?? NaN)) < 0.005
      && s.transactions.filter(t => t.id === receipt.id).length === 1
      ? { allowed: true, receipt }
      : { allowed: false, message: 'O lançamento vinculado não confere com o financiamento. Revise o valor e a data nos registros.' }
  }
  const legacyOptions = s.transactions.filter(t => matchesLegacyFinancing(plan, t))
  if (legacyReceiptId) {
    const receipt = legacyOptions.find(t => t.id === legacyReceiptId)
    return receipt && s.transactions.filter(t => t.id === receipt.id).length === 1 ? { allowed: true, receipt }
      : { allowed: false, message: 'A entrada escolhida mudou. Abra o parcelamento e confira o lançamento novamente.' }
  }
  return legacyOptions.length
    ? { allowed: false, message: 'Qual entrada do extrato pertence a este financiamento?', legacyOptions }
    : { allowed: true }
}

/** Parcelamentos que ainda geram obrigação (não quitados nem cancelados). */
/**
 * Planos que ainda representam dívida.
 *
 * O teste explícito era `status === 'active'`, e `installmentsInMonth` usa o
 * oposto (`!== 'cancelled'`). Um plano vindo de dado antigo ou de backup
 * editado, sem `status`, caía nos dois lados: as parcelas dele entravam no
 * compromisso do mês e no limite usado, mas a dívida total dava R$ 0. O
 * usuário via "parcelas deste mês: R$ 277,78" ao lado de "dívida parcelada
 * restante: R$ 0,00" — dois números da mesma coisa se contradizendo.
 *
 * Backups marcados como quitados podem ainda conter saldo devedor, como num
 * pagamento parcial ou futuro. Nesses casos prevalece o saldo das parcelas.
 */
export function activePlans(s: AppState): InstallmentPlan[] {
  const owing = new Set((s.installments || []).filter(i => installmentRemaining(s, i) > 0).map(i => i.planId))
  return (s.installmentPlans || []).filter(p => p.status !== 'cancelled' && owing.has(p.id))
}

/** Parcelas que vencem no mês de referência ('YYYY-MM'), ignorando canceladas. */
export function installmentsInMonth(s: AppState, mk: string): Installment[] {
  const cancelledPlans = new Set((s.installmentPlans || []).filter(p => p.status === 'cancelled').map(p => p.id))
  return (s.installments || [])
    .filter(i => i.status !== 'cancelled' && (!cancelledPlans.has(i.planId) || i.status === 'paid')
      && isCalendarDate(i.dueDate) && monthKey(i.dueDate) === mk)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

/** Parte paga diretamente na parcela, fora de um pagamento de fatura.
 * `paidVia` distingue os registros novos; backups antigos usam data/cartão
 * apenas como fallback para não deduzir duas vezes uma quitação de fatura.
 */
export function directInstallmentPaidAmount(s: AppState, i: Installment, asOf = todayISO()): number {
  if (i.status === 'cancelled' || i.paidVia === 'invoice'
    || (!i.paidAt && !i.directPayments?.length)) return 0
  const plan = planById(s, i.planId)
  if (i.paidVia !== 'direct' && plan?.cardId && isCalendarDate(i.dueDate) && (s.cardPayments || []).some(p =>
    p.cardId === plan.cardId && p.referenceMonth === monthKey(i.dueDate) && p.paymentDate === i.paidAt
    && validPaymentDate(p.paymentDate, asOf))) return 0
  const amount = i.directPayments?.length
    ? i.directPayments.filter(p => validPaymentDate(p.date, asOf)).reduce((sum, p) => sum + p.amount, 0)
    : i.paidAt && validPaymentDate(i.paidAt, asOf)
      ? i.status === 'paid' ? (i.paidAmount ?? i.amount) : (i.paidAmount ?? 0)
      : 0
  return round2(Math.min(Math.max(amount, 0), i.amount))
}

/** Data futura preservada em backup antigo; não representa quitação hoje. */
export function futureInstallmentPaymentDate(s: AppState, i: Installment, asOf = todayISO()): string | undefined {
  if (i.status === 'cancelled') return undefined
  const dates = [i.paidAt, ...(i.directPayments || []).map(p => p.date)]
    .filter((date): date is string => isCalendarDate(date) && date > asOf)
  const cardId = planById(s, i.planId)?.cardId
  const mk = isCalendarDate(i.dueDate) ? monthKey(i.dueDate) : undefined
  if (cardId) for (const p of s.cardPayments || []) {
    if (p.cardId === cardId && (!mk || p.referenceMonth === mk)
      && p.paymentDate > asOf && isCalendarDate(p.paymentDate) && (p.settledInstallmentIds?.includes(i.id)
        || (mk && p.settledInstallmentIds === undefined && i.paidVia === 'invoice'))) dates.push(p.paymentDate)
  }
  return dates.sort()[0]
}

/** Impede uma segunda quitação enquanto um backup conserva pagamento futuro. */
export function futureInvoicePaymentDate(s: AppState, card: CreditCard, mk: string, asOf = todayISO()): string | undefined {
  const dates = (s.cardPayments || [])
    .filter(p => p.cardId === card.id && p.referenceMonth === mk && p.paymentDate > asOf && isCalendarDate(p.paymentDate))
    .map(p => p.paymentDate)
  for (const i of installmentsInMonth(s, mk)) {
    if (planById(s, i.planId)?.cardId !== card.id) continue
    const future = futureInstallmentPaymentDate(s, i, asOf)
    if (future) dates.push(future)
  }
  return dates.sort()[0]
}

export function unpaidPriorInvoiceMonths(s: AppState, card: CreditCard, mk: string, asOf = todayISO()): string[] {
  const [year, month] = mk.split('-').map(Number)
  const months = new Set<string>()
  for (let back = 1; back <= 24; back++) months.add(monthKey(toISO(new Date(year, month - 1 - back, 1))))
  for (const i of s.installments || []) {
    if (planById(s, i.planId)?.cardId === card.id && isCalendarDate(i.dueDate) && monthKey(i.dueDate) < mk) months.add(monthKey(i.dueDate))
  }
  if (card.initialInvoiceBalance && isCalendarDate(card.createdAt)) months.add(monthKey(nextInvoiceDueDate(card, card.createdAt)))
  return [...months].filter(m => m < mk).sort().reverse().filter(m =>
    invoiceOpenAmount(s, cardInvoice(s, card, m, asOf), asOf) > 0.009)
}

/** Parte realmente quitada até a data, inclusive em backups com pagamento futuro. */
function installmentPaidAsOf(s: AppState, i: Installment, asOf = todayISO()): number {
  if (i.status === 'cancelled') return 0
  const direct = directInstallmentPaidAmount(s, i, asOf)
  if (futureInstallmentPaymentDate(s, i, asOf)) return direct
  // A quitação pela fatura pode ter coberto só o saldo após um parcial direto.
  if (i.status === 'paid' && installmentLinkedToCardPayment(s, i, asOf, true)) return i.amount
  if ((i.paidAt && !isCalendarDate(i.paidAt)) || i.directPayments?.some(p => !isCalendarDate(p.date))) return direct
  const reported = Number.isFinite(i.paidAmount) ? i.paidAmount! : i.status === 'paid' ? i.amount : 0
  return round2(Math.min(Math.max(direct, reported, 0), i.amount))
}

export function installmentRemaining(s: AppState, i: Installment, asOf = todayISO()): number {
  return i.status === 'cancelled' ? 0 : round2(Math.max(i.amount - installmentPaidAsOf(s, i, asOf), 0))
}

export function canPayInstallment(s: AppState, i: Installment, today = todayISO()): boolean {
  const plan = planById(s, i.planId)
  return !!plan && plan.status !== 'cancelled' && i.paidVia !== 'invoice'
    && !futureInstallmentPaymentDate(s, i, today) && !installmentLinkedToCardPayment(s, i, today)
    && installmentRemaining(s, i, today) > 0
}

/** Só bloqueia o desfazer individual quando uma fatura ainda representa esta parcela.
 * Pagamentos novos guardam os IDs exatos. Em backups sem essa proveniência,
 * uma fatura anterior ao pagamento direto não pode ser a quitação dele.
 */
export function installmentLinkedToCardPayment(s: AppState, i: Installment, asOf?: string, exactOnly = false): boolean {
  const cardId = planById(s, i.planId)?.cardId
  if (!cardId) return false
  const mk = isCalendarDate(i.dueDate) ? monthKey(i.dueDate) : undefined
  return (s.cardPayments || []).some(p => {
    if (p.cardId !== cardId || (mk && p.referenceMonth !== mk)) return false
    if (!validPaymentDate(p.paymentDate, asOf ?? p.paymentDate)) return false
    if (p.settledInstallmentIds !== undefined) return p.settledInstallmentIds.includes(i.id)
    if (exactOnly || !mk) return false
    if (i.paidVia === 'invoice') return true
    return !!i.paidAt && p.paymentDate >= i.paidAt
  })
}

/** Assinaturas ativas que caem no mês de referência. */
export function chargesInMonth(s: AppState, mk: string): RecurringCardCharge[] {
  return (s.cardCharges || []).filter(c => {
    if (c.active === false || !isCalendarDate(c.nextDate)) return false
    if (monthKey(c.nextDate) > mk) return false          // ainda não começou
    const [year, month] = mk.split('-').map(Number)
    const occurrence = c.frequency === 'monthly'
      ? toISO(dateForDayOfMonth(year, month - 1, Number(c.nextDate.slice(8, 10))))
      : c.nextDate
    if (c.endDate && occurrence > c.endDate) return false // encerrada antes da cobrança
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
    .filter(i => i.status !== 'cancelled' && !cancelled.has(i.planId) && i.dueDate < t && isCalendarDate(i.dueDate)
      && installmentPaidAsOf(s, i, t) < i.amount - 0.009)
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

/** Só vincula ao pagamento da fatura parcelas com saldo ainda devido nela.
 * Uma parcela já quitada diretamente não pode impedir o desfazer desse
 * pagamento por causa de outra obrigação paga na mesma fatura.
 */
export function settleableInstallmentIds(s: AppState, invoice: CardInvoice, asOf = todayISO()): string[] {
  return invoice.items.filter(item => item.kind === 'installment' && item.planId)
    .map(item => (s.installments || []).find(i => i.planId === item.planId
      && i.number === item.installmentNumber))
    .filter((i): i is Installment => !!i && directInstallmentPaidAmount(s, i, asOf) < i.amount - 0.009)
    .map(i => i.id)
}

/**
 * Quanto da fatura segue de fato em aberto. Parcela marcada como paga sem data
 * (backup antigo) não entra no "pago" da fatura, e ela aparecia atrasada com
 * tudo quitado. O que o usuário marcou como pago não é compromisso: o limite é
 * o que segue pendente pelo STATUS de cada item. Caixa, resposta de fatura e
 * consulta usam este mesmo número.
 */
export function invoiceOpenAmount(s: AppState, inv: CardInvoice, asOf = todayISO()): number {
  const byNumber = new Map((s.installments || []).map(i => [`${i.planId}#${i.number}`, i]))
  const porStatus = inv.items.reduce((sum, it) => {
    if (it.kind !== 'installment') return sum + it.amount
    const inst = byNumber.get(`${it.planId}#${it.installmentNumber}`)
    if (!inst) return sum
    return sum + it.amount - installmentPaidAsOf(s, inst, asOf)
  }, 0)
  return Math.round(Math.max(Math.min(inv.pending, porStatus), 0) * 100) / 100
}

/** Fatura de um cartão no mês de referência ('YYYY-MM' do vencimento). */
export function cardInvoice(s: AppState, card: CreditCard, mk: string, asOf = todayISO()): CardInvoice {
  const [y, m] = mk.split('-').map(Number)
  const due = clampDay(y, m - 1, card.dueDay)
  // o fechamento acontece antes do vencimento (mesmo mês se o dia for menor)
  const closing = card.closingDay <= card.dueDay
    ? clampDay(y, m - 1, card.closingDay)
    : clampDay(y, m - 2, card.closingDay)

  const items: InvoiceItem[] = []
  let directPaid = 0
  for (const i of installmentsInMonth(s, mk)) {
    const plan = planById(s, i.planId)
    if (!plan || plan.cardId !== card.id) continue
    directPaid += directInstallmentPaidAmount(s, i, asOf)
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
  if (card.initialInvoiceBalance && isCalendarDate(card.createdAt) && mk === monthKey(nextInvoiceDueDate(card, card.createdAt))) {
    items.push({ label: 'Saldo anterior da fatura', amount: card.initialInvoiceBalance, kind: 'initial', dueDate: toISO(due) })
  }

  const total = round2(items.reduce((a, i) => a + i.amount, 0))
  const paid = round2(directPaid + (s.cardPayments || [])
    .filter(p => p.cardId === card.id && p.referenceMonth === mk && validPaymentDate(p.paymentDate, asOf))
    .reduce((a, p) => a + p.amount, 0))
  const pending = round2(Math.max(total - paid, 0))

  const t = asOf
  let status: InvoiceStatus
  if (total > 0 && pending <= 0.009) status = 'paga'
  else if (paid > 0.009) status = pending > 0 && t > toISO(due) ? 'atrasada' : 'parcial'
  else if (t > toISO(due) && total > 0) status = 'atrasada'
  else if (t > toISO(closing)) status = 'fechada'
  else status = 'aberta'

  return { card, monthKey: mk, closingDate: toISO(closing), dueDate: toISO(due), items, total, paid, pending, status }
}

/** Fatura corrente: a próxima a vencer (ou a de hoje, se ainda não venceu). */
export function currentInvoice(s: AppState, card: CreditCard, asOf = todayISO()): CardInvoice {
  const t = fromISO(asOf)
  const thisMk = monthKey(asOf)
  const inv = cardInvoice(s, card, thisMk, asOf)
  if (fromISO(inv.dueDate) >= t || inv.pending > 0) return inv
  const nxt = new Date(t.getFullYear(), t.getMonth() + 1, 1)
  return cardInvoice(s, card, monthKey(toISO(nxt)), asOf)
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
function unallocatedInstallmentPayments(s: AppState, cardId: string): number {
  const card = cardById(s, cardId)
  const today = todayISO()
  // Pagamento parcial da fatura não quita uma parcela específica. Só é seguro
  // abater do total do cartão quando a fatura contém exclusivamente parcelas;
  // com assinatura/saldo anterior não sabemos a qual obrigação atribuí-lo.
  return (s.cardPayments || [])
    .filter(p => p.cardId === cardId && validPaymentDate(p.paymentDate, today) && p.settledInstallmentIds?.length === 0)
    .reduce((sum, p) => {
      if (!card || !isCalendarDate(`${p.referenceMonth}-01`)) return sum
      const invoice = cardInvoice(s, card, p.referenceMonth)
      return invoice.items.length && invoice.items.every(item => item.kind === 'installment')
        ? sum + p.amount : sum
    }, 0)
}

export function cardOutstanding(s: AppState, cardId: string): number {
  const planIds = new Set((s.installmentPlans || [])
    .filter(p => p.cardId === cardId && p.status !== 'cancelled').map(p => p.id))
  const pending = (s.installments || [])
    .filter(i => planIds.has(i.planId) && i.status !== 'cancelled')
    .reduce((a, i) => a + (i.amount - installmentPaidAsOf(s, i)), 0)

  // O saldo anterior entra na primeira fatura: só continua devido enquanto
  // essa fatura não foi quitada.
  const card = cardById(s, cardId)
  let initialLeft = 0
  if (card?.initialInvoiceBalance && isCalendarDate(card.createdAt)) {
    const firstInvoice = cardInvoice(s, card, monthKey(nextInvoiceDueDate(card, card.createdAt)))
    initialLeft = Math.min(card.initialInvoiceBalance, firstInvoice.pending)
  }
  return round2(Math.max(pending + initialLeft - unallocatedInstallmentPayments(s, cardId), 0))
}

/** Backups antigos podem contar o mesmo pagamento na parcela e na fatura. */
export function hasAmbiguousLegacyCardBalance(s: AppState): boolean {
  return (s.cardPayments || []).some(p => {
    if (p.settledInstallmentIds !== undefined || !/^\d{4}-\d{2}$/.test(p.referenceMonth || '')) return false
    const card = cardById(s, p.cardId)
    if (!card) return false
    const invoice = cardInvoice(s, card, p.referenceMonth)
    return invoice.paid > invoice.total + 0.009
  })
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

export function planProgress(s: AppState, plan: InstallmentPlan, t = todayISO()): PlanProgress {
  const list = planInstallments(s, plan.id)
  const active = list.filter(i => i.status !== 'cancelled').map(i => ({ i, remaining: installmentRemaining(s, i, t) }))
  const pending = active.filter(row => row.remaining > 0).map(row => row.i)
  const dated = pending.filter(i => isCalendarDate(i.dueDate)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const remainingAmount = round2(active.reduce((a, row) => a + row.remaining, 0))
  const totalActive = round2(active.reduce((a, row) => a + row.i.amount, 0))
  const paidAmount = round2(Math.max(totalActive - remainingAmount, 0))
  return {
    plan,
    installments: list,
    paidCount: active.length - pending.length,
    remainingCount: pending.length,
    paidAmount,
    remainingAmount,
    currentAmount: dated[0]?.amount ?? pending[0]?.amount ?? active[active.length - 1]?.i.amount ?? 0,
    nextDueDate: dated[0]?.dueDate,
    overdueCount: dated.filter(i => i.dueDate < t).length,
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
  const cards = s.cards || []

  const openInvoicesTotal = round2(cards.reduce((a, c) => a + currentInvoice(s, c).pending, 0))
  const nextInvoicesTotal = round2(cards.reduce((a, c) => a + cardInvoice(s, c, nextMk).pending, 0))
  const plans = activePlans(s)
  const knownCardIds = new Set((s.cards || []).map(c => c.id))
  const noCardDebt = plans.filter(p => !p.cardId || !knownCardIds.has(p.cardId))
    .reduce((a, p) => a + planProgress(s, p).remainingAmount, 0)
  const cardPlanDebt = (s.cards || []).reduce((sum, c) => {
    const pending = plans.filter(p => p.cardId === c.id)
      .reduce((a, p) => a + planProgress(s, p).remainingAmount, 0)
    return sum + Math.max(pending - unallocatedInstallmentPayments(s, c.id), 0)
  }, 0)
  const totalDebt = round2(noCardDebt + cardPlanDebt)
  const usableCards = activeCards(s)
  const totalLimit = round2(usableCards.reduce((a, c) => a + (c.limit || 0), 0))
  const usedLimit = round2(usableCards.reduce((a, c) => a + cardOutstanding(s, c.id), 0))
  const overdue = overdueInstallments(s)

  return {
    openInvoicesTotal, nextInvoicesTotal, totalDebt,
    installmentsThisMonth: monthlyCommitments(s, thisMk),
    installmentsNextMonth: monthlyCommitments(s, nextMk),
    totalLimit, usedLimit,
    availableLimit: round2(Math.max(totalLimit - usedLimit, 0)),
    activePlanCount: plans.length,
    overdueCount: overdue.length,
    overdueAmount: round2(overdue.reduce((a, i) => a + installmentRemaining(s, i, t), 0)),
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
  for (const card of s.cards || []) {
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
      if (i.status === 'cancelled' || !isCalendarDate(i.dueDate) || i.dueDate < fromDate || i.dueDate > toDate) continue
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
