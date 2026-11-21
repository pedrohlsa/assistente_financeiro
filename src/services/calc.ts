// Motor de cálculos financeiros — todos os números do app saem daqui.
import { AppState, Insight, IntervalUnit, ParsedAction, RecurrenceOccurrence, RecurringExpense, Transaction } from '../models/types'
import { addDays, dateForDayOfMonth, daysInMonth, dueLabel, fmtBRL, fmtNum, fromISO, isCalendarDate, MESES_PT_BR, monthKey, monthShortLabel, stampOf, todayISO, toISO } from '../utils/format'
import { normalizeName, sentenceCase, weekdayName } from '../utils/text'
import { installmentsThisMonth, monthlyCommitments, installmentsInMonth, chargesInMonth, cardInvoice, directInstallmentPaidAmount, installmentRemaining, invoiceOpenAmount, hasAmbiguousLegacyCardBalance, validPaymentDate } from './cards'

export interface PeriodStats {
  income: number
  expense: number
  profit: number
  km: number
  trips: number
  hours: number
  days: number
  grossPerKm: number
  netPerKm: number
  costPerKm: number
  /** Receita só dos dias com viagens informadas — o numerador de `perTrip`. */
  incomeWithTrips: number
  perTrip: number
  profitPerHour: number
}

const inRange = (date: string, from: string, to: string) => date >= from && validPaymentDate(date, to)

export function periodStats(s: AppState, from: string, to: string, today = todayISO()): PeriodStats {
  const until = to < today ? to : today
  const txs = s.transactions.filter(t => inRange(t.date, from, until))
  const income = txs.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0)
  const expense = txs.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0)
  const ws = s.workSessions.filter(w => inRange(w.date, from, until))
  const km = ws.reduce((a, w) => a + w.km, 0)
  const trips = ws.reduce((a, w) => a + w.trips, 0)
  const hours = ws.reduce((a, w) => a + w.hours, 0)
  const profit = income - expense
  const daysSet = new Set(txs.map(t => t.date).concat(ws.map(w => w.date)))
  // Ganho por viagem divide só o que entrou nos dias em que as viagens foram
  // DITAS. Um dia registrado sem quantidade (regra 34) não tem viagem, e
  // somar a receita dele inflaria a média.
  const viagensPorDia = new Map<string, number>()
  for (const w of ws) viagensPorDia.set(w.date, (viagensPorDia.get(w.date) || 0) + w.trips)
  const incomeWithTrips = txs.filter(t => t.type === 'income' && (viagensPorDia.get(t.date) || 0) > 0)
    .reduce((a, t) => a + t.amount, 0)
  return {
    income, expense, profit, km, trips, hours,
    days: daysSet.size,
    grossPerKm: km > 0 ? income / km : 0,
    netPerKm: km > 0 ? profit / km : 0,
    costPerKm: km > 0 ? expense / km : 0,
    incomeWithTrips,
    perTrip: trips > 0 ? incomeWithTrips / trips : 0,
    profitPerHour: hours > 0 ? profit / hours : 0,
  }
}

export const todayStats = (s: AppState) => periodStats(s, todayISO(), todayISO())
export const weekStats = (s: AppState) => periodStats(s, addDays(todayISO(), -6), todayISO())
export const monthStats = (s: AppState) => {
  const t = todayISO()
  return periodStats(s, t.slice(0, 8) + '01', t)
}
export const prevMonthStats = (s: AppState) => {
  const t = fromISO(todayISO())
  const first = new Date(t.getFullYear(), t.getMonth() - 1, 1)
  const last = new Date(t.getFullYear(), t.getMonth(), 0)
  return periodStats(s, toISO(first), toISO(last))
}

// ---------- SALDO EM CONTA: FONTE ÚNICA ----------
/** Desempata eventos de caixa gravados no mesmo milissegundo. A sequência vem
 * do estado, não de um contador global: funciona após reload e em lotes
 * separados. Horários legados com precisão menor permanecem intocados.
 */
export function nextCashEventTime(s: AppState, date: string, time: string, forceOrdinal = false): string {
  if (!/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(time)) return time
  const prefix = `${date}T${time}`
  const stamps = [s.settings.balanceAsOf,
    ...s.transactions.map(t => stampOf(t.date, t.time)),
    ...(s.cardPayments || []).map(p => stampOf(p.paymentDate, p.paymentTime)),
    ...(s.installments || []).flatMap(i => (i.directPayments || []).map(p => stampOf(p.date, p.time))),
  ]
  let max = -1
  for (const stamp of stamps) {
    if (stamp === prefix) max = Math.max(max, 0)
    else if (stamp?.startsWith(prefix) && /^\d{6}$/.test(stamp.slice(prefix.length))) {
      max = Math.max(max, Number(stamp.slice(prefix.length)))
    }
  }
  return max < 0 && !forceOrdinal ? time : `${time}${String(max + 1).padStart(6, '0')}`
}

/**
 * Saldo atual = âncora informada pelo usuário + tudo que REALMENTE mexeu no caixa
 * depois dela. Nenhuma tela pode calcular saldo por conta própria.
 *
 * Entra: receitas e despesas confirmadas, entrada financiada (dinheiro que caiu
 * de verdade) e pagamento de fatura descontado do saldo.
 * NÃO entra: salário previsto, aluguel ainda não recebido, conta futura, parcela
 * futura, assinatura ainda não cobrada, projeção — nada disso é caixa.
 *
 * `type: 'saving'` continua fora por decisão do projeto: a "reserva" do AssistFin
 * não é necessariamente outra conta bancária (pode ser cofrinho/envelope), e a
 * regra 5 já separa "guardado" de "líquido". Mudar isso alteraria o significado
 * de dados já salvos.
 *
 * Compatibilidade: estado antigo não tem `balanceAsOf`. Nesse caso a âncora vale
 * a partir do INÍCIO DE HOJE — movimentações de dias anteriores já estavam
 * embutidas no valor que o usuário digitou, e as de hoje passam a somar.
 */
export function currentBalance(s: AppState, today = todayISO()): number {
  const anchor = s.settings.balance || 0
  const since = s.settings.balanceAsOf || `${today}T00:00`
  let total = anchor
  for (const t of s.transactions) {
    if (!validPaymentDate(t.date, today) || stampOf(t.date, t.time) <= since) continue
    if (t.type === 'income' || t.type === 'financed-cash-inflow') total += t.amount
    else if (t.type === 'expense') total -= t.amount
  }
  for (const p of s.cardPayments || []) {
    if (!p.fromBalance || !validPaymentDate(p.paymentDate, today)) continue
    if (stampOf(p.paymentDate, p.paymentTime) <= since) continue
    total -= p.amount
  }
  // O botão "marcar parcela como paga" não cria CardPayment. Sem este evento
  // no caixa, saldo e projeção afirmavam que os R$ 200 ainda estavam na conta.
  for (const i of s.installments || []) {
    if (i.directPayments?.length) {
      // Cada parcela parcial mantém sua própria hora; o total acumulado não
      // pode ser todo movido para o instante do pagamento mais recente.
      total -= i.directPayments.filter(p => validPaymentDate(p.date, today) && stampOf(p.date, p.time) > since)
        .reduce((sum, p) => sum + p.amount, 0)
    } else if (i.paidAt && validPaymentDate(i.paidAt, today) && stampOf(i.paidAt) > since) {
      total -= directInstallmentPaidAmount(s, i, today)
    }
  }
  return Math.round(total * 100) / 100
}

/** Média diária de lucro nos últimos N dias com atividade */
export function avgDailyProfit(s: AppState, lookback = 30): number {
  const from = addDays(todayISO(), -lookback)
  const st = periodStats(s, from, addDays(todayISO(), -1))
  return st.days > 0 ? st.profit / st.days : 0
}

// ---------- META DIÁRIA INTELIGENTE (seção 16) ----------
export interface DailyGoalBreakdown {
  base: number      // contas fixas + custos / dias de trabalho
  personal: number  // metas de compra
  deficit: number   // déficits diluídos
  installments: number // parcelas de cartão/parcelamentos do mês, diluídas
  margin: number    // margem de segurança
  total: number
  workDaysLeft: number
}

export function dailyGoal(s: AppState): DailyGoalBreakdown {
  const today = todayISO()
  const dim = daysInMonth(today)
  const dayOfMonth = fromISO(today).getDate()
  const daysLeft = dim - dayOfMonth + 1

  // dias de trabalho restantes no mês
  let workDaysLeft = 0
  for (let i = 0; i < daysLeft; i++) {
    const d = fromISO(addDays(today, i))
    if (s.settings.workDays.includes(d.getDay())) workDaysLeft++
  }
  workDaysLeft = Math.max(workDaysLeft, 1)

  // contas fixas mensais (só saídas — entradas recorrentes não são "conta a cobrir")
  const monthlyRecurring = s.recurring.filter(r => r.kind !== 'income').reduce((a, r) => {
    if (r.frequency === 'monthly') return a + r.amount
    if (r.frequency === 'weekly') return a + r.amount * 4.33
    return a + r.amount / 12
  }, 0)

  const workDaysPerMonth = Math.max(s.settings.workDays.length * 4.33, 1)
  const base = (monthlyRecurring + s.settings.monthlyProfitTarget) / workDaysPerMonth

  // metas pessoais por dia
  const personal = s.goals.filter(g => !g.done).reduce((a, g) => {
    const remaining = Math.max(g.target - g.saved, 0)
    if (remaining <= 0) return a
    const deadline = g.deadline || addDays(today, 90)
    const days = Math.max(Math.round((fromISO(deadline).getTime() - fromISO(today).getTime()) / 86400000), 1)
    return a + remaining / days
  }, 0)

  const deficit = s.deficits.filter(d => !d.ignored && d.remaining > 0.01).reduce((a, d) => a + d.perDay, 0)

  // Parcelas e assinaturas do cartão são obrigação mensal real: entram diluídas
  // pelos dias de trabalho, igual às contas fixas. Sem parcelas cadastradas o
  // valor é 0 e a meta diária fica idêntica ao que já era.
  const installments = monthlyCommitments(s, monthKey(today)) / workDaysPerMonth

  const subtotal = base + personal + deficit + installments
  const margin = subtotal * (s.settings.safetyMarginPct / 100)

  return { base, personal, deficit, installments, margin, total: subtotal + margin, workDaysLeft }
}

// ---------- META MENSAL PARA GUARDAR (perfis não motoristas) ----------
// Reaproveita settings.monthlyProfitTarget: no motorista é "objetivo de lucro
// mensal"; nos outros perfis é "quanto pretendo guardar por mês".
export interface MonthlySavingGoal {
  target: number     // quanto quer guardar no mês
  income: number     // entradas registradas no mês
  expense: number    // despesas registradas no mês
  net: number        // resultado líquido (entradas − despesas)
  missing: number    // quanto falta GUARDAR para a meta (0 se já guardou tudo)
  /**
   * Percentual da meta com base no que foi REALMENTE guardado. É este o
   * progresso principal da meta — sobra disponível não é dinheiro guardado.
   */
  pct: number
  /**
   * Percentual da meta que a sobra do mês COBRE. Pode passar de 100% sem que
   * nada tenha sido guardado — por isso nunca deve ser rotulado "% da meta".
   */
  availablePct: number
  /** Já guardou pelo menos a meta? Único critério de "Meta alcançada". */
  reached: boolean
  /** Existe sobra suficiente para cobrir a meta, mesmo que nada tenha sido guardado. */
  canReach: boolean
  negative: boolean  // mês fechando no vermelho
  saved: number          // quanto foi REALMENTE guardado (transferências type:'saving')
  savedPct: number       // percentual da meta efetivamente guardado
  savedReached: boolean  // guardou pelo menos a meta
  stillAvailable: number // resultado líquido que ainda não foi guardado
  /**
   * Parcelas e assinaturas que vencem neste mês. É PROJEÇÃO — não altera `net`
   * nem `saved`, que continuam sendo só o que foi realmente movimentado.
   */
  installmentsDue: number
  /** Quanto sobraria para guardar já descontando as parcelas do mês (projeção). */
  projectedAvailable: number
}

/**
 * IMPORTANTE: este card trabalha SÓ com valores realizados. `income` e `expense`
 * vêm de `monthStats`, que soma apenas transações confirmadas — salário previsto
 * e conta futura não entram aqui de jeito nenhum.
 *
 * "Meta alcançada" depende de `saved` (transferências `type:'saving'`), nunca da
 * sobra: dizer que a meta foi batida porque sobrou dinheiro seria afirmar que o
 * usuário guardou algo que continua disponível para gastar.
 */
export function monthlySavingGoal(s: AppState, today = todayISO()): MonthlySavingGoal {
  const m = monthStats(s)
  const target = Math.max(s.settings.monthlyProfitTarget || 0, 0)
  const net = m.income - m.expense
  const saved = savedThisMonth(s, today)
  const installmentsDue = installmentsThisMonth(s)
  return {
    target, income: m.income, expense: m.expense, net,
    missing: Math.max(target - saved, 0),
    pct: target > 0 ? Math.max(Math.round((saved / target) * 100), 0) : 0,
    availablePct: target > 0 ? Math.max(Math.round((net / target) * 100), 0) : 0,
    reached: target > 0 && saved >= target,
    canReach: target > 0 && net >= target,
    negative: net < 0,
    saved,
    savedPct: target > 0 ? Math.max(Math.round((saved / target) * 100), 0) : 0,
    savedReached: target > 0 && saved >= target,
    stillAvailable: Math.max(net - saved, 0),
    installmentsDue,
    projectedAvailable: Math.max(net - saved - installmentsDue, 0),
  }
}

/** Quanto o usuário REALMENTE transferiu para reserva neste mês (14.3). */
export function savedThisMonth(s: AppState, today = todayISO()): number {
  // Depósito com data futura ainda não aconteceu: "guardado de verdade" é o
  // que já saiu da conta até hoje (regra 21), a mesma leitura de
  // `currentBalance`, que também ignora movimento datado para a frente.
  return s.transactions
    .filter(x => x.type === 'saving' && validPaymentDate(x.date, today) && monthKey(x.date) === monthKey(today))
    .reduce((a, x) => a + x.amount, 0)
}

// ---------- PREVISÃO ATÉ O FIM DO MÊS (14.4) ----------
export interface MonthForecast {
  balance: number           // saldo informado hoje
  received: number          // entradas já recebidas no mês
  incomingLeft: number      // entradas fixas ainda previstas até o fim do mês
  paid: number              // despesas já pagas no mês
  billsLeft: number         // contas ainda pendentes até o fim do mês
  installmentsLeft: number  // parcelas/assinaturas que ainda vencem neste mês
  estimatedEnd: number      // saldo estimado no fim do mês
  estimatedSavable: number  // quanto dá pra guardar, estimado
  hasData: boolean          // há base suficiente para prever
  daysLeft: number
}

export function monthForecast(s: AppState): MonthForecast {
  const t = todayISO()
  const dim = daysInMonth(t)
  const day = fromISO(t).getDate()
  const daysLeft = Math.max(dim - day, 0)
  const m = monthStats(s)
  const balance = currentBalance(s)

  // recorrentes que ainda caem/vencem dentro deste mês
  const untilEnd = (list: UpcomingBill[]) => list.filter(b => fromISO(b.date) <= fromISO(t.slice(0, 8) + String(dim).padStart(2, '0')))
  const incomingLeft = untilEnd(upcomingIncomes(s, daysLeft)).reduce((a, b) => a + b.amount, 0)
  const billsLeft = untilEnd(upcomingBills(s, daysLeft)).reduce((a, b) => a + b.amount, 0)

  // Parcelas que ainda vencem neste mês também comprometem o saldo.
  const installmentsLeft = installmentsInMonth(s, monthKey(t))
    .filter(i => i.status === 'pending' && i.dueDate >= t)
    .reduce((a, i) => a + i.amount, 0)

  const estimatedEnd = balance + incomingLeft - billsLeft - installmentsLeft
  const target = Math.max(s.settings.monthlyProfitTarget || 0, 0)
  return {
    balance, received: m.income, incomingLeft, paid: m.expense, billsLeft, installmentsLeft,
    estimatedEnd,
    estimatedSavable: Math.max(Math.min(estimatedEnd, target || estimatedEnd), 0),
    hasData: balance !== 0 || m.income > 0 || s.recurring.length > 0 || (s.installmentPlans?.length || 0) > 0,
    daysLeft,
  }
}

// ---------- PROJEÇÃO MÊS A MÊS (cartões, parcelas e recorrentes) ----------
export interface MonthProjection {
  monthKey: string        // 'YYYY-MM'
  label: string           // "set/2026"
  isCurrent: boolean
  incomes: number         // entradas recorrentes previstas
  bills: number           // contas recorrentes previstas
  installments: number    // parcelas + assinaturas de cartão do mês
  outflow: number         // bills + installments
  net: number             // incomes − outflow
  runningBalance: number  // saldo estimado acumulado a partir do saldo atual
  savable: number         // quanto sobraria para guardar
  commitmentPct: number   // % da renda prevista comprometida
  tight: boolean          // mês apertado (comprometimento alto ou saldo negativo)
}

/** Só ocorrências ainda futuras e não resolvidas entram no saldo projetado. */
function projectedRecurringAmount(s: AppState, r: RecurringExpense, from: string, to: string, today: string): number {
  return occurrencesBetween(r, from, to, today)
    .filter(date => !recurringOccurrenceState(s, r, date, today).resolved)
    .reduce(sum => sum + r.amount, 0)
}

/**
 * Despesa da categoria que a própria projeção representaria em cada mês. Com
 * `recurringId`, só a daquela conta fixa ("parar de pagar a internet" não
 * tira a Luz, que também é Casa).
 */
export function representedRecurringExpenseMonths(
  s: AppState, category: string, months: number, today = todayISO(), recurringId?: string,
): number[] {
  const start = fromISO(today)
  return Array.from({ length: months }, (_, i) => {
    const first = toISO(new Date(start.getFullYear(), start.getMonth() + i, 1))
    const last = toISO(new Date(start.getFullYear(), start.getMonth() + i + 1, 0))
    const from = i === 0 ? today : first
    return s.recurring.filter(r => r.kind !== 'income' && r.category === category && (!recurringId || r.id === recurringId))
      .reduce((sum, r) => sum + projectedRecurringAmount(s, r, from, last, today), 0)
  })
}

function projectedInstallments(s: AppState, mk: string, from: string, today: string): number {
  const cards = s.cards || []
  const cardIds = new Set(cards.map(c => c.id))
  const plans = new Map((s.installmentPlans || []).map(p => [p.id, p]))
  // A fatura reconcilia parcelas, assinaturas e pagamentos no mesmo lugar.
  // Somar assinatura bruta depois de quitar a fatura cobrava-a uma segunda vez.
  const invoiced = cards.reduce((sum, card) => {
    const invoice = cardInvoice(s, card, mk, today)
    if (invoice.dueDate < from) return sum
    return sum + invoiceOpenAmount(s, invoice, today)
  }, 0)
  // Dados legados podem conter parcela sem plano/cartão; mantemos a projeção
  // desses itens, que não aparecem em nenhuma fatura.
  const orphanInstallments = installmentsInMonth(s, mk)
    .filter(i => i.dueDate >= from && !cardIds.has(plans.get(i.planId)?.cardId || ''))
    .reduce((sum, i) => sum + installmentRemaining(s, i, today), 0)
  const orphanCharges = chargesInMonth(s, mk).filter(c => !cardIds.has(c.cardId)).reduce((sum, c) => {
    const due = c.nextDate.slice(0, 7) === mk ? c.nextDate
      : toISO(dateForDayOfMonth(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, Number(c.nextDate.slice(8, 10))))
    return due >= from && (!c.endDate || due <= c.endDate) ? sum + c.amount : sum
  }, 0)
  return Math.round((invoiced + orphanInstallments + orphanCharges) * 100) / 100
}

/**
 * Projeção dos próximos N meses (seção 9). Só usa obrigações CADASTRADAS —
 * nunca extrapola média de gasto variável, para não apresentar estimativa como
 * se fosse compromisso real. As parcelas entram pelo valor que vence no mês;
 * o valor total da compra nunca é somado junto (ver services/cards.ts).
 */
export function monthlyProjections(s: AppState, months = 12, today = todayISO()): MonthProjection[] {
  const t = today
  const start = fromISO(t)
  const out: MonthProjection[] = []
  let running = currentBalance(s, today)

  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const mk = monthKey(toISO(d))
    const first = toISO(d)
    const last = toISO(new Date(start.getFullYear(), start.getMonth() + i + 1, 0))
    const from = i === 0 ? today : first
    const incomes = s.recurring.filter(r => r.kind === 'income')
      .reduce((a, r) => a + projectedRecurringAmount(s, r, from, last, today), 0)
    const bills = s.recurring.filter(r => r.kind !== 'income')
      .reduce((a, r) => a + projectedRecurringAmount(s, r, from, last, today), 0)
    const installments = projectedInstallments(s, mk, from, today)
    const outflow = bills + installments
    const net = incomes - outflow
    running += net
    const target = Math.max(s.settings.monthlyProfitTarget || 0, 0)
    out.push({
      monthKey: mk,
      label: monthShortLabel(d),
      isCurrent: i === 0,
      incomes, bills, installments, outflow, net,
      runningBalance: running,
      savable: Math.max(Math.min(net, target || net), 0),
      commitmentPct: incomes > 0 ? Math.round((outflow / incomes) * 100) : 0,
      tight: running < 0 || (incomes > 0 && outflow > incomes),
    })
  }
  return out
}

/** Há base suficiente para projetar? Sem isso, a tela mostra estado vazio honesto. */
export function hasProjectionData(s: AppState): boolean {
  return s.recurring.length > 0 || (s.installmentPlans?.length || 0) > 0 || (s.cardCharges?.length || 0) > 0
    || (s.cards || []).some(card => card.initialInvoiceBalance > 0)
}

// ---------- RECORRENTES PENDENTES DE CONFIRMAÇÃO (14.2) ----------
export interface PendingRecurring {
  rec: RecurringExpense
  monthKey: string   // 'YYYY-MM' de referência
  dueDate: string    // data exata da ocorrência pendente
  kind: 'income' | 'expense'
  /** Dias desde/até o vencimento REAL: 0 = hoje, negativo = já venceu. */
  inDays: number
  futurePaymentDate?: string
}

/** Quanto tempo para trás o app ainda pergunta sobre uma ocorrência não resolvida. */
const PENDING_LOOKBACK_DAYS = 60

/**
 * Ocorrências cuja data já chegou e que ainda não foram resolvidas — em QUALQUER
 * frequência, não só mensal. Nada é lançado automaticamente: só vira pergunta.
 */
export function pendingRecurrings(s: AppState, t = todayISO(), includeSnoozed = false): PendingRecurring[] {
  const today = fromISO(t)
  const from = addDays(t, -PENDING_LOOKBACK_DAYS)
  const out: PendingRecurring[] = []
  for (const r of s.recurring) {
    if (!includeSnoozed && r.snoozeUntil && t < r.snoozeUntil) continue
    for (const dueIso of occurrencesBetween(r, from, t, t)) {
      // Uma recorrente cadastrada hoje NÃO nasce atrasada: a âncora define a
      // primeira ocorrência e nada antes dela vira pendência.
      if (!recurringActiveOn(r, dueIso)) continue
      const occurrence = recurringOccurrenceState(s, r, dueIso, t)
      if (occurrence.resolved) continue
      out.push({
        rec: r, monthKey: monthKey(dueIso), dueDate: dueIso,
        kind: r.kind === 'income' ? 'income' : 'expense',
        inDays: Math.round((fromISO(dueIso).getTime() - today.getTime()) / 86400000),
        futurePaymentDate: occurrence.futurePaymentDate,
      })
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

const mesesPorNome = MESES_PT_BR.map(normalizeName)
const nomeDaCompetencia = new RegExp(String.raw`\s+(?:de|referente\s+(?:a|ao|a\s+mes\s+de))\s+(${mesesPorNome.join('|')})(?:\s+de\s+(\d{4}))?$`)

function matchesRecurringName(r: RecurringExpense, description: string, origin: string): boolean {
  const registeredOrigin = normalizeName(r.origin)
  if (origin && registeredOrigin && origin !== registeredOrigin) return false
  const name = normalizeName(r.name)
  return !!name && (description === name || (!!registeredOrigin && ['da', 'do', 'de', 'na', 'no']
    .some(link => description === `${name} ${link} ${registeredOrigin}`)))
}

/** Sugestões de vínculo em volta do vencimento. O usuário escolhe o lançamento. */
export function possibleRecurringTransactions(
  s: AppState, rec: RecurringExpense, due: string, today: string, payment: { date?: string; amount?: number } = {},
): Transaction[] {
  const from = addDays(due, -PENDING_LOOKBACK_DAYS)
  const to = addDays(due, PENDING_LOOKBACK_DAYS)
  const list = occurrencesBetween(rec, from, to, today)
  const index = list.indexOf(due)
  if (index < 0) return []
  const previous = list[index - 1]
  const next = list[index + 1]
  const linked = new Set(s.recurring.flatMap(r => (r.occurrences || []).map(o => o.txId).filter(Boolean)))
  return s.transactions.filter(t =>
    t.type === (rec.kind ?? 'expense') && !t.recurringId && !t.occurrenceDate && !linked.has(t.id)
    && t.date >= from && t.date <= to && (!previous || t.date > previous) && (!next || t.date < next)
    && (!payment.date || t.date === payment.date)
    && (payment.amount === undefined || Math.abs(t.amount - payment.amount) < 0.005)
    && Number.isFinite(t.amount) && t.amount >= 0.01 && t.amount <= 99_999_999
    && matchesRecurringName(rec, normalizeName(t.description), normalizeName(t.origin)))
    .filter(t => validPaymentDate(t.date, today))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''))
}

export function recurringLinkAction(rec: RecurringExpense, due: string, transaction: Transaction): Extract<ParsedAction, { kind: 'recurring-confirm' }> {
  return { kind: 'recurring-confirm', recurringId: rec.id, occurrenceDate: due, description: rec.name,
    transactionId: transaction.id, amount: transaction.amount, date: transaction.date }
}

export interface TransactionOccurrence {
  recurringId: string
  date: string
  record?: RecurrenceOccurrence
}

export function transactionOccurrence(s: AppState, t: Transaction): TransactionOccurrence | undefined {
  for (const rec of s.recurring) {
    const record = rec.occurrences?.find(o => o.status === 'confirmed' && o.txId === t.id)
    if (record) return { recurringId: rec.id, date: record.date, record }
  }
  if (!t.recurringId || !t.occurrenceDate) return undefined
  const rec = s.recurring.find(r => r.id === t.recurringId)
  const record = rec?.occurrences?.find(o => o.date === t.occurrenceDate && o.status === 'confirmed' && !o.txId)
  return { recurringId: t.recurringId, date: t.occurrenceDate, record }
}

/**
 * Consulta a recorrência citada numa movimentação. Uma data de pagamento não
 * escolhe o vencimento. Uma referência explícita, como "luz deste mês", escolhe
 * o mês da ocorrência, inclusive quando ela já foi resolvida.
 */
export function matchRecurringPayment(
  s: AppState,
  payment: { description?: string; kind: 'income' | 'expense'; amount?: number; origin?: string; date?: string },
  today: string,
  dueDate?: string,
): { pending: PendingRecurring[]; alreadyPaid: boolean; conflictingReference?: boolean } | null {
  const name = normalizeName(payment.description)
  if (!name) return null
  const origin = normalizeName(payment.origin)
  const matches = (description: string) => s.recurring.filter(r =>
    (r.kind || 'expense') === payment.kind && matchesRecurringName(r, description, origin))
  let accounts = matches(name)
  let reference: string | undefined
  if (!accounts.length) {
    const month = name.match(/\s+(?:deste|desse|neste|nesse)\s+mes$|\s+(?:do\s+mes\s+(?:passado|anterior)|d[eo]\s+mes\s+atual)$/)
    if (month) {
      accounts = matches(name.slice(0, month.index))
      reference = /passado|anterior/.test(month[0]) ? monthKey(addDays(`${monthKey(today)}-01`, -1)) : monthKey(today)
    } else {
      const named = name.match(nomeDaCompetencia)
      if (named) {
        accounts = matches(name.slice(0, named.index))
        const [ano, mes] = today.split('-').map(Number)
        const escolhido = mesesPorNome.indexOf(named[1]) + 1
        const anoEscolhido = named[2] || String(escolhido <= mes ? ano : ano - 1)
        reference = `${anoEscolhido}-${String(escolhido).padStart(2, '0')}`
      }
    }
  }
  if (!accounts.length) return null
  if (dueDate && reference && monthKey(dueDate) !== reference) {
    return { pending: [], alreadyPaid: false, conflictingReference: true }
  }

  const fromOrigin = origin ? accounts.filter(r => normalizeName(r.origin) === origin) : []
  if (fromOrigin.length) accounts = fromOrigin
  const ids = new Set(accounts.map(r => r.id))
  const references = (occ: string) => dueDate ? occ === dueDate : !reference || monthKey(occ) === reference
  const explicit = !!(dueDate || reference)
  const pending = pendingRecurrings(s, today, true).filter(p => ids.has(p.rec.id) && references(p.dueDate))
  const earliestRepeat = addDays(today, pending.length ? -1 : -PENDING_LOOKBACK_DAYS)
  const alreadyPaid = s.transactions.some(t => {
    if (t.type !== payment.kind || !t.recurringId || !ids.has(t.recurringId) || !t.occurrenceDate
      || !references(t.occurrenceDate) || t.date > today) return false
    if (explicit) return true
    const matchesAmount = payment.amount === undefined || Math.abs(payment.amount - t.amount) < 0.005
    // O desembolso pode ter sido neste mês para uma conta antiga. Para um
    // relato sem data, a proximidade é medida pelo pagamento registrado.
    const samePayment = payment.date ? t.date === payment.date : t.date >= earliestRepeat
    return matchesAmount && samePayment
  }) || (explicit && accounts.some(r => {
    if (dueDate) {
      const occurrence = recurringOccurrenceState(s, r, dueDate, today)
      return dueDate <= today && occurrence.resolved && occurrence.record?.status === 'confirmed'
    }
    return !!(reference && legacyMonthResolved(r, reference)
      && !pending.some(p => p.rec.id === r.id && p.futurePaymentDate))
      || (r.occurrences || []).some(o => o.status === 'confirmed' && o.date <= today && references(o.date)
        && recurringOccurrenceState(s, r, o.date, today).resolved)
  }))
  return pending.length || alreadyPaid || explicit ? { pending, alreadyPaid } : null
}

// ---------- CUSTO REAL POR KM (seção 23) ----------
export interface KmCost {
  fuelPerKm: number
  maintenancePerKm: number
  fixedPerKm: number
  operational: number // combustível + manutenção
  total: number       // + custos fixos
  minRecommended: number
  comfort: number
}

export function fuelCostBasis(s: AppState, asOf?: string): { kmPerLiter: number; pricePerLiter: number } {
  const recorded = asOf ? { ...s, fuelRecords: s.fuelRecords.filter(f => f.date <= asOf) } : s
  return {
    kmPerLiter: fuelEfficiency(recorded) || s.settings.kmPerLiter || 0,
    pricePerLiter: lastFuelPrice(recorded) || s.settings.fuelPricePerLiter || 0,
  }
}

/**
 * Km de um mês inteiro, para ratear o custo fixo MENSAL. Dividir pelos km
 * rodados até hoje no mês corrente fazia o custo fixo valer o dobro no dia 15
 * e seis vezes mais no dia 1º — e o mínimo recomendado e o "vale a pena?"
 * herdavam a distorção. Mede os últimos 30 dias (escalados quando o histórico
 * é mais curto, a partir de uma semana); sem isso, usa a média informada.
 */
export function projectedMonthlyKm(s: AppState, today = todayISO()): number {
  const inicio = addDays(today, -29)
  const janela = s.workSessions.filter(w => w.date >= inicio && w.date <= today && w.km > 0)
  const km = janela.reduce((a, w) => a + w.km, 0)
  const primeiro = s.workSessions.filter(w => w.km > 0 && w.date <= today).reduce((m, w) => (w.date < m ? w.date : m), today)
  const cobertos = Math.min(30, Math.round((fromISO(today).getTime() - fromISO(primeiro).getTime()) / 86400000) + 1)
  const informado = (s.vehicle?.averageDailyKm || 0) * 30
  if (km > 0 && cobertos >= 7) return km / cobertos * 30
  if (informado > 0) return informado
  return km > 0 ? km / Math.max(cobertos, 1) * 30 : 0
}

export function kmCost(s: AppState): KmCost {
  // Sem dados do usuário, permanece zero: nunca inventa consumo ou preço.
  const { kmPerLiter, pricePerLiter } = fuelCostBasis(s)
  const fuelPerKm = kmPerLiter > 0 && pricePerLiter > 0 ? pricePerLiter / kmPerLiter : 0

  const maintenancePerKm = s.maintenance.reduce((a, m) => a + (m.lifeKm > 0 ? m.cost / m.lifeKm : 0), 0)

  const kmMonth = projectedMonthlyKm(s)
  const fixedPerKm = kmMonth > 0 ? (s.settings.fixedMonthlyCosts || 0) / kmMonth : 0

  const operational = fuelPerKm + maintenancePerKm
  return {
    fuelPerKm, maintenancePerKm, fixedPerKm,
    operational,
    total: operational + fixedPerKm,
    minRecommended: s.settings.minPerKm || (operational + fixedPerKm > 0 ? (operational + fixedPerKm) * 2 : 0),
    comfort: s.settings.comfortPerKm || (operational + fixedPerKm > 0 ? (operational + fixedPerKm) * 2.6 : 0),
  }
}

// ---------- COMBUSTÍVEL (seção 21) ----------
export function fuelEfficiency(s: AppState): number | null {
  const recs = [...s.fuelRecords].filter(f => f.odometer && f.liters > 0).sort((a, b) => (a.odometer! - b.odometer!))
  if (recs.length < 2) return null
  let km = 0, liters = 0
  for (let i = 1; i < recs.length; i++) {
    km += recs[i].odometer! - recs[i - 1].odometer!
    liters += recs[i].liters
  }
  return liters > 0 ? km / liters : null
}

export function lastFuelPrice(s: AppState): number | null {
  const recs = [...s.fuelRecords].filter(r => r.pricePerLiter > 0).sort((a, b) => b.date.localeCompare(a.date))
  return recs.length ? recs[0].pricePerLiter : null
}

// ---------- ANALISADOR DE CORRIDA (seção 20) ----------
export interface RideAnalysis {
  totalKm: number
  grossPerKm: number
  cost: number
  profit: number
  netPerKm: number
  profitPerHour: number
  rating: 'Excelente' | 'Boa' | 'Aceitável' | 'Ruim' | 'Muito ruim'
  tone: 'positive' | 'warning' | 'negative'
}

export function analyzeRide(s: AppState, value: number, kmPickup: number, kmRide: number, minutes: number): RideAnalysis {
  const kc = kmCost(s)
  const totalKm = kmPickup + kmRide
  const cost = totalKm * kc.total
  const profit = value - cost
  const grossPerKm = totalKm > 0 ? value / totalKm : 0
  const netPerKm = totalKm > 0 ? profit / totalKm : 0
  const profitPerHour = minutes > 0 ? (profit / minutes) * 60 : 0

  let rating: RideAnalysis['rating']
  if (grossPerKm >= kc.comfort * 1.15) rating = 'Excelente'
  else if (grossPerKm >= kc.comfort * 0.92) rating = 'Boa'
  else if (grossPerKm >= kc.minRecommended) rating = 'Aceitável'
  else if (grossPerKm >= kc.total) rating = 'Ruim'
  else rating = 'Muito ruim'

  const tone = rating === 'Excelente' || rating === 'Boa' ? 'positive' : rating === 'Aceitável' ? 'warning' : 'negative'
  return { totalKm, grossPerKm, cost, profit, netPerKm, profitPerHour, rating, tone }
}

// ---------- PREVISÃO 30 DIAS (seção 25) ----------
export interface Forecast {
  balance: number
  expectedIncome: number
  expectedExpense: number
  recurringTotal: number
  goalsSavings: number
  projected: number
}

export function forecast30(s: AppState): Forecast {
  const st = periodStats(s, '2000-01-01', todayISO())
  const balance = st.profit
  const avg = avgDailyProfit(s)
  const st30 = periodStats(s, addDays(todayISO(), -30), todayISO())
  const activeDays = Math.max(st30.days, 1)
  const dailyIncome = st30.income / activeDays
  const dailyVarExpense = st30.expense / activeDays
  // dias ativos projetados (mesmo ritmo)
  const monthly = (list: typeof s.recurring) => list.reduce((a, r) => {
    if (r.frequency === 'monthly') return a + r.amount
    if (r.frequency === 'weekly') return a + r.amount * 4.33
    return a + r.amount / 12
  }, 0)
  const recurringTotal = monthly(s.recurring.filter(r => r.kind !== 'income'))   // saídas fixas
  const recurringIncome = monthly(s.recurring.filter(r => r.kind === 'income'))  // entradas fixas (salário/aluguel)
  const expectedIncome = dailyIncome * activeDays + recurringIncome
  const expectedExpense = dailyVarExpense * activeDays + recurringTotal
  const goalsSavings = 0
  return { balance, expectedIncome, expectedExpense, recurringTotal, goalsSavings, projected: balance + expectedIncome - expectedExpense }
}

// ---------- RECORRENTES: próximos vencimentos/entradas (seção 24) ----------
export interface UpcomingBill { name: string; amount: number; inDays: number; date: string; kind: 'income' | 'expense' }

/**
 * Data real da ocorrência de um recorrente mensal/anual dentro de um mês.
 * Dia 31 em fevereiro vira o último dia do mês (nunca o dia 28 fixo).
 */
export function occurrenceInMonth(r: RecurringExpense, mk: string): string {
  const [y, m] = mk.split('-').map(Number)
  return toISO(dateForDayOfMonth(y, m - 1, r.dueDay))
}

// ---------- MOTOR DE RECORRÊNCIA ----------
/**
 * Passo de repetição. Recorrências antigas só têm `frequency`; as novas trazem
 * `interval` + `intervalUnit`. Esta função é o único ponto que traduz um no outro.
 */
export function recurrenceStep(r: RecurringExpense): { interval: number; unit: IntervalUnit } {
  if (r.interval && r.intervalUnit) return { interval: Math.max(Math.round(r.interval), 1), unit: r.intervalUnit }
  if (r.frequency === 'weekly') return { interval: 1, unit: 'week' }
  if (r.frequency === 'yearly') return { interval: 1, unit: 'year' }
  return { interval: 1, unit: 'month' }
}

/**
 * Data da primeira ocorrência. Com `startDate` é ele, ponto.
 * FALLBACK DOCUMENTADO para recorrências criadas antes deste campo existir:
 * - mensal: o dia `dueDay` do mês corrente;
 * - anual: `dueDay`/`dueMonth` do ano corrente;
 * - semanal: o próximo dia da semana `dueDay % 7` a partir de hoje.
 * O fallback nunca inventa passado: a sequência é reconstruída a partir dele.
 */
export function recurrenceAnchor(r: RecurringExpense, asOf = todayISO()): string {
  if (r.startDate) return r.startDate
  const t = fromISO(asOf)
  const { unit } = recurrenceStep(r)
  if (unit === 'week' || unit === 'day') {
    const target = ((r.dueDay % 7) + 7) % 7
    const d = new Date(t)
    while (d.getDay() !== target) d.setDate(d.getDate() + 1)
    return toISO(d)
  }
  if (unit === 'year') {
    const month = (r.dueMonth || t.getMonth() + 1) - 1
    return toISO(dateForDayOfMonth(t.getFullYear(), month, r.dueDay))
  }
  return toISO(dateForDayOfMonth(t.getFullYear(), t.getMonth(), r.dueDay))
}

/**
 * n-ésima ocorrência (0 = a primeira) a partir da âncora.
 *
 * POLÍTICA DE MESES CURTOS (unidades `month`/`year`): o DIA ORIGINAL da âncora é
 * sempre preservado e só é reduzido ao último dia do mês quando aquele mês não
 * tem o dia. Início em 31/01 com passo de 2 meses → 31/03, 31/05, 31/07…
 * (março tem 31); se caísse em um mês de 30 dias, seria o dia 30 SÓ naquele mês.
 * O dia nunca "gruda" no 28 nem degrada permanentemente.
 */
function occurrenceAt(r: RecurringExpense, anchor: string, n: number): string {
  const { interval, unit } = recurrenceStep(r)
  const a = fromISO(anchor)
  if (unit === 'day') return addDays(anchor, interval * n)
  if (unit === 'week') return addDays(anchor, interval * 7 * n)
  const months = unit === 'year' ? interval * 12 * n : interval * n
  return toISO(dateForDayOfMonth(a.getFullYear(), a.getMonth() + months, a.getDate()))
}

/** Limite de segurança: nenhuma janela consultada gera mais que isto. */
const MAX_OCCURRENCES = 400

/**
 * Todas as ocorrências de uma recorrência dentro de [from, to].
 * FONTE ÚNICA de datas: Home, Planejamento, alertas e o card de confirmação
 * consomem daqui, senão cada tela mostra um dia diferente para a mesma conta.
 */
export function occurrencesBetween(r: RecurringExpense, from: string, to: string, asOf = todayISO()): string[] {
  if (r.active === false) return []
  const anchor = recurrenceAnchor(r, asOf)
  if (to < anchor || to < from) return []
  const { interval, unit } = recurrenceStep(r)
  const a = fromISO(anchor)
  const f = fromISO(from)
  const calendarDays = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
  const elapsed = unit === 'day' || unit === 'week'
    ? Math.floor((calendarDays(f) - calendarDays(a)) / (interval * (unit === 'week' ? 7 : 1)))
    : Math.floor(((f.getFullYear() - a.getFullYear()) * 12 + f.getMonth() - a.getMonth())
      / (interval * (unit === 'year' ? 12 : 1)))
  // O limite protege a JANELA, não toda a vida da recorrência. Uma diária de
  // 2025 ainda precisa aparecer numa projeção feita em 2026.
  const first = Math.max(0, elapsed - 1)
  const out: string[] = []
  for (let n = first; n < first + MAX_OCCURRENCES; n++) {
    const d = occurrenceAt(r, anchor, n)
    if (d > to) break
    if (r.endDate && d > r.endDate) break
    if (d >= from) out.push(d)
  }
  return out
}

/**
 * Descrição legível da repetição — nunca expõe número de dia da semana.
 * "Toda segunda-feira", "A cada 2 semanas, às segundas-feiras", "Todo dia 5",
 * "A cada 3 meses, no dia 10", "A cada 15 dias".
 */
export function describeRecurrence(r: RecurringExpense): string {
  const { interval, unit } = recurrenceStep(r)
  const anchor = fromISO(recurrenceAnchor(r))
  const day = anchor.getDate()
  const weekday = weekdayName(anchor.getDay()).toLowerCase()
  // "segunda-feira" pluraliza NOS DOIS termos: "segundas-feiras". Pluralizar
  // só o primeiro devolvia "às segundas-feira".
  const plural = weekday.replace(/^([a-zà-ú]+)-feira$/i, '$1s-feiras').replace(/^(domingo|sábado)$/, '$1s')

  if (unit === 'day') return interval === 1 ? 'Todo dia' : `A cada ${interval} dias`
  if (unit === 'week') {
    // Sábado e domingo são masculinos: "Toda sábado" e "às domingos" é o app
    // errando português na tela de Planejamento, que é onde o usuário confere
    // o que vai vencer. Os outros cinco dias são "-feira", femininos.
    const masculino = /^(domingo|s[áa]bado)/.test(weekday)
    return interval === 1
      ? `${masculino ? 'Todo' : 'Toda'} ${weekday}`
      : `A cada ${interval} semanas, ${masculino ? 'aos' : 'às'} ${plural}`
  }
  if (unit === 'year') {
    const month = anchor.toLocaleDateString('pt-BR', { month: 'long' })
    return interval === 1 ? `Todo ano, em ${day} de ${month}` : `A cada ${interval} anos, em ${day} de ${month}`
  }
  if (interval === 1) return `Todo dia ${day}`
  if (interval === 12) return `Todo ano, no dia ${day}`
  return `A cada ${interval} meses, no dia ${day}`
}

/** Situação registrada de uma ocorrência específica (undefined = ainda em aberto). */
export function occurrenceRecord(r: RecurringExpense, date: string): RecurrenceOccurrence | undefined {
  const exact = r.occurrences?.find(o => o.date === date)
  if (exact) return exact
  if (legacyMonthResolved(r, monthKey(date))) {
    return { date, status: 'confirmed' }
  }
  return undefined
}

function legacyMonthResolved(r: RecurringExpense, month: string): boolean {
  // Meses já quitados continuam resolvidos depois do primeiro registro novo.
  // Em uma cadência diária ou semanal, um registro antigo do mês não quita
  // todas as datas depois que o calendário exato já está em uso.
  return !!r.handledMonths?.includes(month) && (!r.occurrences?.length || recurrenceStep(r).unit === 'month')
}

/** Uma baixa importada com data futura continua registrada, mas ainda não foi realizada. */
export function recurringOccurrenceState(s: AppState, r: RecurringExpense, date: string, today: string) {
  const record = occurrenceRecord(r, date)
  const transaction = (record?.txId ? s.transactions.find(t => t.id === record.txId) : undefined)
    ?? s.transactions.find(t => t.recurringId === r.id && t.occurrenceDate === date)
  const futurePaymentDate = record?.status !== 'skipped' && transaction && transaction.date > today ? transaction.date : undefined
  return { record, transaction, futurePaymentDate, resolved: !futurePaymentDate && !!(record || transaction) }
}

/** O recorrente está valendo nesta data? (desativado, ainda não começou, já terminou) */
export function recurringActiveOn(r: RecurringExpense, iso: string): boolean {
  if (r.active === false) return false
  if (r.startDate && iso < r.startDate) return false
  if (r.endDate && iso > r.endDate) return false
  return true
}

/**
 * Próximas ocorrências ainda PREVISTAS (não realizadas) dentro do horizonte.
 * Ocorrência já confirmada sai daqui: senão o mesmo salário apareceria ao mesmo
 * tempo como saldo realizado e como entrada prevista (item 11).
 */
function upcomingFrom(s: AppState, kind: 'expense' | 'income', horizon: number, t: string): UpcomingBill[] {
  const today = fromISO(t)
  const to = addDays(t, horizon)
  const out: UpcomingBill[] = []
  for (const r of s.recurring) {
    if ((r.kind ?? 'expense') !== kind) continue
    for (const iso of occurrencesBetween(r, t, to, t)) {
      if (recurringOccurrenceState(s, r, iso, t).resolved) continue
      out.push({
        name: r.name, amount: r.amount, date: iso, kind,
        inDays: Math.round((fromISO(iso).getTime() - today.getTime()) / 86400000),
      })
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays)
}

/** Contas a PAGAR nos próximos dias (só saídas). */
export function upcomingBills(s: AppState, horizon = 30, today = todayISO()): UpcomingBill[] {
  return upcomingFrom(s, 'expense', horizon, today)
}

/** Entradas fixas a RECEBER nos próximos dias (salário/aluguel). */
export function upcomingIncomes(s: AppState, horizon = 30): UpcomingBill[] {
  return upcomingFrom(s, 'income', horizon, todayISO())
}

// ---------- MODO BANCO: saúde do saldo (auto-adaptativo) ----------
export interface BalanceOutlook {
  balance: number            // saldo atual em conta
  billsSoon: number          // compromissos certos, vencidos e dentro do horizonte
  horizon: number            // dias considerados
  bills: CashObligation[]    // contas, faturas e parcelas sem duplicação
  unconfirmed: CashObligation[] // contas vencidas sem confirmação
  ambiguousBalance: boolean  // legado sem informação suficiente para atestar cobertura
  shortfall: number          // quanto falta cobrir (0 se sobra)
  leftover: number           // quanto sobra após as contas (0 se falta)
  needPerDay: number         // ritmo diário para cobrir o buraco até o vencimento
  ok?: boolean               // undefined quando não se pode afirmar cobertura
}

export function balanceOutlook(s: AppState, horizon = 7, today = todayISO()): BalanceOutlook {
  const balance = currentBalance(s, today)
  const all = cashObligationsUntil(s, addDays(today, horizon), today)
  const bills = all.filter(b => !b.unconfirmed)
  const unconfirmed = all.filter(b => b.unconfirmed)
  const ambiguousBalance = hasAmbiguousLegacyCardBalance(s)
  const billsSoon = Math.round(bills.reduce((a, b) => a + b.amount, 0) * 100) / 100
  const diff = balance - billsSoon
  const shortfall = diff < 0 ? -diff : 0
  const leftover = diff > 0 ? diff : 0
  // prazo mais curto entre as contas que faltam pagar (para calcular o ritmo)
  const daysToCover = bills.length ? Math.max(Math.min(...bills.map(b => b.inDays)), 1) : horizon
  const needPerDay = shortfall > 0 ? shortfall / daysToCover : 0
  const uncertainTotal = unconfirmed.reduce((sum, b) => sum + b.amount, 0)
  const ok = ambiguousBalance ? undefined : diff < -0.009 ? false : diff - uncertainTotal < -0.009 ? undefined : true
  return { balance, billsSoon, horizon, bills, shortfall, leftover, needPerDay, ok, unconfirmed, ambiguousBalance }
}

/** A mesma cobertura na Home, nos avisos e no resumo do chat. */
export function balanceOutlookText(o: BalanceOutlook): string {
  if (o.ambiguousBalance) return 'Não consigo confirmar a cobertura: há saldo legado de cartão com pagamentos sem conciliação. Confira o saldo e reconcilie esses pagamentos.'
  const scope = `Compromissos vencidos e dos próximos ${o.horizon} dias: ${fmtBRL(o.billsSoon)}.`
  const verdict = o.ok === true ? ` O saldo cobre esse total; sobra ${fmtBRL(o.leftover)}.`
    : o.ok === false ? ` Faltam ${fmtBRL(o.shortfall)}.`
      : ' Ainda não dá para confirmar se o saldo cobre tudo.'
  const uncertain = o.unconfirmed.length ? ' Há contas vencidas sem confirmação; confira essas pendências antes de usar a folga.' : ''
  return `${scope}${verdict}${uncertain}`
}

export interface CashObligation {
  name: string
  amount: number
  date: string
  /** Negativo: já venceu e continua em aberto. */
  inDays: number
  kind: 'bill' | 'invoice' | 'installment'
  /**
   * Conta fixa que venceu sem confirmação. Pode ter sido paga e não marcada —
   * por isso nunca é somada como dívida certa (regra 7: recorrente só pergunta).
   */
  unconfirmed?: boolean
  /** Cartão da fatura, para quem pergunta por uma fatura só. */
  cardId?: string
}

/** Meses para trás em que uma fatura ainda em aberto conta como atrasada. */
const OBLIGATION_LOOKBACK_MONTHS = 12

/**
 * Tudo que está CADASTRADO para sair do caixa até `until` (inclusive), junto
 * com o que já venceu e segue em aberto: conta fixa não resolvida, o pendente
 * de cada fatura e parcela fora de cartão. É também a fonte de compromissos
 * para `balanceOutlook`, evitando divergência entre Home e chat.
 *
 * Parcela de cartão entra pela FATURA, nunca sozinha (regra 10). Gasto
 * variável não entra: não existe cadastro dele, e uma média aqui seria
 * previsão com cara de compromisso.
 */
export function cashObligationsUntil(s: AppState, until: string, t = todayISO()): CashObligation[] {
  const today = fromISO(t)
  const inDays = (iso: string) => Math.round((fromISO(iso).getTime() - today.getTime()) / 86400000)
  const out: CashObligation[] = []

  // Adiar o aviso na Home não retira o vencimento dos cálculos de cobertura.
  for (const p of pendingRecurrings(s, t, true)) {
    if (p.kind !== 'expense' || p.dueDate > until) continue
    out.push({ name: p.rec.name, amount: p.rec.amount, date: p.dueDate, inDays: p.inDays, kind: 'bill',
      ...(p.inDays < 0 ? { unconfirmed: true } : {}) })
  }
  if (until > t) {
    for (const b of upcomingBills(s, inDays(until), t)) {
      if (b.inDays > 0) out.push({ name: b.name, amount: b.amount, date: b.date, inDays: b.inDays, kind: 'bill' })
    }
  }

  const last = fromISO(until)
  const plans = new Map((s.installmentPlans || []).map(p => [p.id, p]))
  const cards = s.cards || []
  for (const card of cards) {
    for (let back = OBLIGATION_LOOKBACK_MONTHS; ; back--) {
      const d = new Date(today.getFullYear(), today.getMonth() - back, 1)
      if (d > last) break
      const inv = cardInvoice(s, card, monthKey(toISO(d)), t)
      if (inv.pending <= 0.009 || inv.dueDate > until) continue
      const amount = invoiceOpenAmount(s, inv, t)
      if (amount > 0.009) {
        out.push({ name: `Fatura ${card.name}`, amount, date: inv.dueDate, inDays: inDays(inv.dueDate), kind: 'invoice', cardId: card.id })
      }
    }
  }

  const cardIds = new Set(cards.map(c => c.id))
  for (const i of s.installments || []) {
    const plan = plans.get(i.planId)
    if (!plan || plan.status === 'cancelled' || i.dueDate > until || !isCalendarDate(i.dueDate)) continue
    if (plan.cardId && cardIds.has(plan.cardId)) continue
    const left = installmentRemaining(s, i, t)
    if (left > 0.009) {
      out.push({ name: `${plan.description} (${i.number}/${i.total})`, amount: left, date: i.dueDate, inDays: inDays(i.dueDate), kind: 'installment' })
    }
  }

  return out.sort((a, b) => a.inDays - b.inDays || b.amount - a.amount)
}

// ---------- ORÇAMENTOS (seção 26) ----------
export function budgetUsage(s: AppState, category: string, today = todayISO()): number {
  return s.transactions
    .filter(tx => tx.type === 'expense' && tx.category === category && validPaymentDate(tx.date, today) && monthKey(tx.date) === monthKey(today))
    .reduce((a, tx) => a + tx.amount, 0)
}

// ---------- SÉRIES PARA GRÁFICOS ----------
export function dailySeries(s: AppState, days: number) {
  const out: { date: string; label: string; income: number; expense: number; profit: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(todayISO(), -i)
    const st = periodStats(s, d, d)
    const wd = fromISO(d).toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0, 3)
    out.push({ date: d, label: days <= 7 ? wd : fromISO(d).getDate().toString(), income: st.income, expense: st.expense, profit: st.profit })
  }
  return out
}

export function categoryBreakdown(s: AppState, from: string, to: string, today = todayISO()) {
  const map = new Map<string, number>()
  s.transactions.filter(t => t.type === 'expense' && inRange(t.date, from, to < today ? to : today))
    .forEach(t => map.set(t.category, (map.get(t.category) || 0) + t.amount))
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total)
}

export function bestWorstDay(s: AppState, lookback = 30) {
  const series = dailySeries(s, lookback).filter(d => d.income > 0 || d.expense > 0)
  if (!series.length) return { best: null, worst: null }
  const sorted = [...series].sort((a, b) => b.profit - a.profit)
  return { best: sorted[0], worst: sorted[sorted.length - 1] }
}

// ---------- INSIGHTS AUTOMÁTICOS (seção 15) ----------
export function generateInsights(s: AppState): Insight[] {
  const out: Insight[] = []
  const t = todayISO()
  const thisWeek = periodStats(s, addDays(t, -6), t)
  const prevWeek = periodStats(s, addDays(t, -13), addDays(t, -7))

  // combustível semana x semana
  const fuelThis = s.transactions.filter(x => x.category === 'combustivel' && inRange(x.date, addDays(t, -6), t)).reduce((a, x) => a + x.amount, 0)
  const fuelPrev = s.transactions.filter(x => x.category === 'combustivel' && inRange(x.date, addDays(t, -13), addDays(t, -7))).reduce((a, x) => a + x.amount, 0)
  if (fuelPrev > 20 && fuelThis > 0) {
    const pct = Math.round(((fuelThis - fuelPrev) / fuelPrev) * 100)
    if (Math.abs(pct) >= 10)
      out.push({
        id: 'fuel-week', icon: '⛽',
        title: pct > 0 ? 'Combustível subiu' : 'Combustível caiu',
        text: `Seu gasto com combustível ${pct > 0 ? 'aumentou' : 'diminuiu'} ${Math.abs(pct)}% esta semana (${fmtBRL(fuelThis)} vs ${fmtBRL(fuelPrev)}).`,
        tone: pct > 0 ? 'warning' : 'positive',
      })
  }

  // melhor dia da semana
  const byWeekday = new Map<number, { total: number; n: number }>()
  dailySeries(s, 60).forEach(d => {
    if (d.income <= 0) return
    const wd = fromISO(d.date).getDay()
    const cur = byWeekday.get(wd) || { total: 0, n: 0 }
    byWeekday.set(wd, { total: cur.total + d.profit, n: cur.n + 1 })
  })
  if (byWeekday.size >= 3) {
    const best = [...byWeekday.entries()].map(([wd, v]) => ({ wd, avg: v.total / v.n })).sort((a, b) => b.avg - a.avg)[0]
    const names = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado']
    out.push({ id: 'best-weekday', icon: '📅', title: 'Seu melhor dia', text: `${names[best.wd]} costuma ser seu dia mais lucrativo (média de ${fmtBRL(best.avg)}).`, tone: 'neutral' })
  }

  // lucro por km líquido
  const m = monthStats(s)
  if (m.km > 50)
    out.push({ id: 'net-km', icon: '🛣️', title: 'Ganho por km', text: `Você ganha em média ${fmtBRL(m.netPerKm)} líquido por km rodado este mês.`, tone: 'neutral' })

  // lucro/hora tendência
  if (thisWeek.hours > 5 && prevWeek.hours > 5) {
    const pct = Math.round(((thisWeek.profitPerHour - prevWeek.profitPerHour) / prevWeek.profitPerHour) * 100)
    if (Math.abs(pct) >= 5)
      out.push({
        id: 'per-hour', icon: '⏱️',
        title: pct >= 0 ? 'Lucro por hora subiu' : 'Lucro por hora caiu',
        text: `Seu lucro por hora ${pct >= 0 ? 'subiu' : 'caiu'} ${Math.abs(pct)}% nos últimos 7 dias (${fmtBRL(thisWeek.profitPerHour)}/h).`,
        tone: pct >= 0 ? 'positive' : 'warning',
      })
  }

  // projeção do mês vs meta
  const avg = avgDailyProfit(s)
  if (avg > 0 && s.settings.monthlyProfitTarget > 0) {
    const dim = daysInMonth(t)
    const day = fromISO(t).getDate()
    const projected = m.profit + avg * (dim - day)
    const diff = projected - s.settings.monthlyProfitTarget
    out.push({
      id: 'month-proj', icon: '📈',
      title: 'Projeção do mês',
      text: diff >= 0
        ? `Se continuar nesse ritmo, terminará o mês ${fmtBRL(diff)} acima do seu objetivo de lucro.`
        : `Nesse ritmo, você terminaria o mês ${fmtBRL(-diff)} abaixo do objetivo. Sua meta diária já considera isso.`,
      tone: diff >= 0 ? 'positive' : 'warning',
    })
  }

  // consumo do carro
  const eff = fuelEfficiency(s)
  if (eff) out.push({ id: 'fuel-eff', icon: '🚗', title: 'Consumo do veículo', text: `Seu carro está fazendo ${fmtNum(eff)} km/L com base nos últimos abastecimentos.`, tone: 'neutral' })

  // manutenção próxima
  const odo = s.vehicle?.odometer || 0
  for (const mi of s.maintenance) {
    const used = odo - mi.kmInstalled
    const pct = mi.lifeKm > 0 ? used / mi.lifeKm : 0
    if (pct >= 0.8 && pct < 1.5)
      out.push({ id: 'maint-' + mi.id, icon: '🔧', title: `${mi.name}: troca próxima`, text: `${mi.name} está com ${Math.min(Math.round(pct * 100), 100)}% da vida útil (${fmtNum(used, 0)} / ${fmtNum(mi.lifeKm, 0)} km).`, tone: 'warning' })
  }

  // orçamentos
  for (const b of s.budgets) {
    const used = budgetUsage(s, b.category)
    const pct = b.limit > 0 ? used / b.limit : 0
    const daysRest = daysInMonth(t) - fromISO(t).getDate()
    if (pct >= 0.7)
      out.push({ id: 'budget-' + b.id, icon: '🎯', title: 'Orçamento quase no limite', text: `Você já utilizou ${Math.round(pct * 100)}% do orçamento de ${b.category} e ainda faltam ${daysRest} dias para terminar o mês.`, tone: pct >= 1 ? 'negative' : 'warning' })
  }

  return out.slice(0, 6)
}

// ---------- ALERTAS (seção 27) ----------
export function notifications(s: AppState): Insight[] {
  const out: Insight[] = []
  const t = todayISO()
  const ts = todayStats(s)
  const goal = dailyGoal(s)

  if (ts.income === 0 && ts.expense === 0 && new Date().getHours() >= 12)
    out.push({ id: 'no-activity', icon: '👋', title: 'Sem registros hoje', text: 'Você ainda não registrou nenhuma atividade hoje.', tone: 'neutral' })

  if (goal.total > 0 && ts.profit > 0 && ts.profit < goal.total) {
    const pct = Math.round((ts.profit / goal.total) * 100)
    out.push({ id: 'goal-progress', icon: '🎯', title: `Meta ${pct}% concluída`, text: `Faltam ${fmtBRL(goal.total - ts.profit)} para sua meta de hoje.`, tone: 'neutral' })
  }

  for (const b of upcomingBills(s, 2))
    out.push({ id: 'bill-' + b.name, icon: '📄', title: `${sentenceCase(b.name)}: ${dueLabel(b.inDays).toLowerCase()}`, text: `${fmtBRL(b.amount)} — programe-se para o pagamento.`, tone: 'warning' })

  // MODO BANCO: saldo não cobre as contas próximas → aviso auto-adaptativo
  if (currentBalance(s) > 0 || s.recurring.length > 0 || s.cards?.length || s.installments?.length) {
    const bo = balanceOutlook(s, 7)
    if (bo.bills.length && bo.shortfall > 1 && !bo.ambiguousBalance) {
      out.push({
        id: 'balance-short', icon: '🏦',
        title: 'Saldo não cobre os compromissos próximos',
        text: balanceOutlookText(bo),
        tone: 'negative',
      })
    }
  }

  return out
}
