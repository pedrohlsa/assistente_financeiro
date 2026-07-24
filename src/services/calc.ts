// Motor de cálculos financeiros — todos os números do app saem daqui.
import { AppState, Insight, RecurringExpense, Transaction } from '../models/types'
import { addDays, daysInMonth, fmtBRL, fmtNum, fromISO, monthKey, todayISO, toISO } from '../utils/format'

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
  perTrip: number
  profitPerHour: number
}

const inRange = (date: string, from: string, to: string) => date >= from && date <= to

export function periodStats(s: AppState, from: string, to: string): PeriodStats {
  const txs = s.transactions.filter(t => inRange(t.date, from, to))
  const income = txs.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0)
  const expense = txs.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0)
  const ws = s.workSessions.filter(w => inRange(w.date, from, to))
  const km = ws.reduce((a, w) => a + w.km, 0)
  const trips = ws.reduce((a, w) => a + w.trips, 0)
  const hours = ws.reduce((a, w) => a + w.hours, 0)
  const profit = income - expense
  const daysSet = new Set(txs.map(t => t.date).concat(ws.map(w => w.date)))
  return {
    income, expense, profit, km, trips, hours,
    days: daysSet.size,
    grossPerKm: km > 0 ? income / km : 0,
    netPerKm: km > 0 ? profit / km : 0,
    costPerKm: km > 0 ? expense / km : 0,
    perTrip: trips > 0 ? income / trips : 0,
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
  const subtotal = base + personal + deficit
  const margin = subtotal * (s.settings.safetyMarginPct / 100)

  return { base, personal, deficit, margin, total: subtotal + margin, workDaysLeft }
}

// ---------- META MENSAL PARA GUARDAR (perfis não motoristas) ----------
// Reaproveita settings.monthlyProfitTarget: no motorista é "objetivo de lucro
// mensal"; nos outros perfis é "quanto pretendo guardar por mês".
export interface MonthlySavingGoal {
  target: number     // quanto quer guardar no mês
  income: number     // entradas registradas no mês
  expense: number    // despesas registradas no mês
  net: number        // resultado líquido (entradas − despesas)
  missing: number    // quanto falta para a meta (0 se alcançou)
  pct: number        // percentual da meta atingido (0-100+)
  reached: boolean   // resultado líquido cobriu a meta
  negative: boolean  // mês fechando no vermelho
  saved: number          // quanto foi REALMENTE guardado (transferências type:'saving')
  savedPct: number       // percentual da meta efetivamente guardado
  savedReached: boolean  // guardou pelo menos a meta
  stillAvailable: number // resultado líquido que ainda não foi guardado
}

export function monthlySavingGoal(s: AppState): MonthlySavingGoal {
  const m = monthStats(s)
  const target = Math.max(s.settings.monthlyProfitTarget || 0, 0)
  const net = m.income - m.expense
  const missing = Math.max(target - net, 0)
  const pct = target > 0 ? Math.round((net / target) * 100) : 0
  const saved = savedThisMonth(s)
  return {
    target, income: m.income, expense: m.expense, net, missing,
    pct: Math.max(pct, 0),
    reached: target > 0 && net >= target,
    negative: net < 0,
    saved,
    savedPct: target > 0 ? Math.max(Math.round((saved / target) * 100), 0) : 0,
    savedReached: target > 0 && saved >= target,
    stillAvailable: Math.max(net - saved, 0),
  }
}

/** Quanto o usuário REALMENTE transferiu para reserva neste mês (14.3). */
export function savedThisMonth(s: AppState): number {
  const t = todayISO()
  return s.transactions
    .filter(x => x.type === 'saving' && monthKey(x.date) === monthKey(t))
    .reduce((a, x) => a + x.amount, 0)
}

// ---------- PREVISÃO ATÉ O FIM DO MÊS (14.4) ----------
export interface MonthForecast {
  balance: number           // saldo informado hoje
  received: number          // entradas já recebidas no mês
  incomingLeft: number      // entradas fixas ainda previstas até o fim do mês
  paid: number              // despesas já pagas no mês
  billsLeft: number         // contas ainda pendentes até o fim do mês
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
  const balance = s.settings.balance || 0

  // recorrentes que ainda caem/vencem dentro deste mês
  const untilEnd = (list: UpcomingBill[]) => list.filter(b => fromISO(b.date) <= fromISO(t.slice(0, 8) + String(dim).padStart(2, '0')))
  const incomingLeft = untilEnd(upcomingIncomes(s, daysLeft)).reduce((a, b) => a + b.amount, 0)
  const billsLeft = untilEnd(upcomingBills(s, daysLeft)).reduce((a, b) => a + b.amount, 0)

  const estimatedEnd = balance + incomingLeft - billsLeft
  const target = Math.max(s.settings.monthlyProfitTarget || 0, 0)
  return {
    balance, received: m.income, incomingLeft, paid: m.expense, billsLeft,
    estimatedEnd,
    estimatedSavable: Math.max(Math.min(estimatedEnd, target || estimatedEnd), 0),
    hasData: balance > 0 || m.income > 0 || s.recurring.length > 0,
    daysLeft,
  }
}

// ---------- RECORRENTES PENDENTES DE CONFIRMAÇÃO (14.2) ----------
export interface PendingRecurring {
  rec: RecurringExpense
  monthKey: string   // 'YYYY-MM' de referência
  dueDate: string    // data prevista neste mês
  kind: 'income' | 'expense'
}

/**
 * Recorrentes cujo dia previsto já chegou neste mês e que ainda não foram
 * resolvidos. Nada é lançado automaticamente — só vira pergunta ao usuário.
 */
export function pendingRecurrings(s: AppState): PendingRecurring[] {
  const t = todayISO()
  const mk = monthKey(t)
  const today = fromISO(t)
  const out: PendingRecurring[] = []
  for (const r of s.recurring) {
    if (r.active === false) continue
    if (r.frequency !== 'monthly') continue // mensal é o caso do salário/aluguel
    if (r.handledMonths?.includes(mk)) continue
    if (r.snoozeUntil && t < r.snoozeUntil) continue
    if (r.startDate && t < r.startDate) continue
    if (r.endDate && t > r.endDate) continue
    const dueDay = Math.min(r.dueDay, daysInMonth(t))
    const due = new Date(today.getFullYear(), today.getMonth(), dueDay)
    if (due > today) continue // ainda não chegou o dia
    // já existe lançamento deste recorrente neste mês? então não pergunta
    const already = s.transactions.some(x => x.recurringId === r.id && monthKey(x.date) === mk)
    if (already) continue
    out.push({ rec: r, monthKey: mk, dueDate: toISO(due), kind: r.kind === 'income' ? 'income' : 'expense' })
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
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

export function kmCost(s: AppState): KmCost {
  // consumo real a partir dos abastecimentos, senão configuração
  const kml = fuelEfficiency(s) || s.settings.kmPerLiter || 10
  const price = lastFuelPrice(s) || s.settings.fuelPricePerLiter || 6
  const fuelPerKm = price / kml

  const maintenancePerKm = s.maintenance.reduce((a, m) => a + (m.lifeKm > 0 ? m.cost / m.lifeKm : 0), 0)

  const st = monthStats(s)
  const kmMonth = st.km > 300 ? st.km : 2000 // estimativa se pouco histórico
  const fixedPerKm = (s.settings.fixedMonthlyCosts || 0) / kmMonth

  const operational = fuelPerKm + maintenancePerKm
  return {
    fuelPerKm, maintenancePerKm, fixedPerKm,
    operational,
    total: operational + fixedPerKm,
    minRecommended: s.settings.minPerKm || Math.max((operational + fixedPerKm) * 2, 1.2),
    comfort: s.settings.comfortPerKm || Math.max((operational + fixedPerKm) * 2.6, 1.8),
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
  const recs = [...s.fuelRecords].sort((a, b) => b.date.localeCompare(a.date))
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

function upcomingFrom(list: RecurringExpense[], horizon: number): UpcomingBill[] {
  const today = fromISO(todayISO())
  const out: UpcomingBill[] = []
  for (const r of list) {
    const kind = r.kind === 'income' ? 'income' : 'expense'
    if (r.frequency === 'monthly' || r.frequency === 'yearly') {
      for (let m = 0; m < 2; m++) {
        const d = new Date(today.getFullYear(), today.getMonth() + m, Math.min(r.dueDay, 28))
        if (r.frequency === 'yearly' && r.dueMonth && d.getMonth() !== r.dueMonth - 1) continue
        const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
        if (diff >= 0 && diff <= horizon) out.push({ name: r.name, amount: r.amount, inDays: diff, date: toISO(d), kind })
      }
    } else {
      for (let i = 0; i <= horizon; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i)
        if (d.getDay() === r.dueDay % 7) { out.push({ name: r.name, amount: r.amount, inDays: i, date: toISO(d), kind }); break }
      }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays)
}

/** Contas a PAGAR nos próximos dias (só saídas). */
export function upcomingBills(s: AppState, horizon = 30): UpcomingBill[] {
  return upcomingFrom(s.recurring.filter(r => r.kind !== 'income'), horizon)
}

/** Entradas fixas a RECEBER nos próximos dias (salário/aluguel). */
export function upcomingIncomes(s: AppState, horizon = 30): UpcomingBill[] {
  return upcomingFrom(s.recurring.filter(r => r.kind === 'income'), horizon)
}

// ---------- MODO BANCO: saúde do saldo (auto-adaptativo) ----------
export interface BalanceOutlook {
  balance: number            // saldo atual em conta
  billsSoon: number          // contas a vencer no horizonte
  horizon: number            // dias considerados
  bills: UpcomingBill[]      // contas dentro do horizonte
  shortfall: number          // quanto falta cobrir (0 se sobra)
  leftover: number           // quanto sobra após as contas (0 se falta)
  needPerDay: number         // ritmo diário para cobrir o buraco até o vencimento
  ok: boolean                // saldo cobre as contas do horizonte
}

export function balanceOutlook(s: AppState, horizon = 7): BalanceOutlook {
  const balance = s.settings.balance || 0
  const bills = upcomingBills(s, horizon)
  const billsSoon = bills.reduce((a, b) => a + b.amount, 0)
  const diff = balance - billsSoon
  const shortfall = diff < 0 ? -diff : 0
  const leftover = diff > 0 ? diff : 0
  // prazo mais curto entre as contas que faltam pagar (para calcular o ritmo)
  const daysToCover = bills.length ? Math.max(Math.min(...bills.map(b => b.inDays)), 1) : horizon
  const needPerDay = shortfall > 0 ? shortfall / daysToCover : 0
  return { balance, billsSoon, horizon, bills, shortfall, leftover, needPerDay, ok: shortfall <= 0.01 }
}

// ---------- ORÇAMENTOS (seção 26) ----------
export function budgetUsage(s: AppState, category: string): number {
  const t = todayISO()
  return s.transactions
    .filter(tx => tx.type === 'expense' && tx.category === category && monthKey(tx.date) === monthKey(t))
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

export function categoryBreakdown(s: AppState, from: string, to: string) {
  const map = new Map<string, number>()
  s.transactions.filter(t => t.type === 'expense' && inRange(t.date, from, to))
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
    out.push({ id: 'bill-' + b.name, icon: '📄', title: `${b.name} vence ${b.inDays === 0 ? 'hoje' : b.inDays === 1 ? 'amanhã' : `em ${b.inDays} dias`}`, text: `${fmtBRL(b.amount)} — programe-se para o pagamento.`, tone: 'warning' })

  // MODO BANCO: saldo não cobre as contas próximas → aviso auto-adaptativo
  if (s.settings.balance > 0 || s.recurring.length > 0) {
    const bo = balanceOutlook(s, 7)
    if (bo.bills.length && bo.shortfall > 1) {
      out.push({
        id: 'balance-short', icon: '🏦',
        title: 'Saldo não cobre as contas da semana',
        text: `Você tem ${fmtBRL(bo.balance)} e ${fmtBRL(bo.billsSoon)} em contas nos próximos ${bo.horizon} dias. Faltam ${fmtBRL(bo.shortfall)} — precisa fazer cerca de ${fmtBRL(bo.needPerDay)} por dia até lá.`,
        tone: 'negative',
      })
    }
  }

  return out
}
