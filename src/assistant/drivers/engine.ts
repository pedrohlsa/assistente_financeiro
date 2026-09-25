// Explicação determinística de mudança financeira.
//
// A conta sempre fecha: variação do resultado = variação das receitas menos
// variação das despesas. Transferências para reserva ficam de fora porque não
// são receita nem despesa, conforme a regra financeira do app.

import type { AppState, Transaction } from '../../models/types'
import { currentMonthToDate, previousPeriod } from '../query/period'
import type { AssistantFact } from '../query/types'
import type { ChangeAnalysis, ChangeDriver, StructuralChange } from './types'

const r2 = (v: number) => Math.round(v * 100) / 100
let seq = 0

const rows = (state: AppState, from: string, to: string) => (state.transactions || [])
  .filter(t => t && (t.type === 'income' || t.type === 'expense') && t.date >= from && t.date <= to)

const soma = (txs: Transaction[], type: 'income' | 'expense') =>
  r2(txs.filter(t => t.type === type).reduce((a, t) => a + t.amount, 0))

const porCategoria = (txs: Transaction[], type: 'income' | 'expense') => {
  const out = new Map<string, number>()
  for (const t of txs) if (t.type === type) out.set(t.category || 'sem-categoria', r2((out.get(t.category || 'sem-categoria') || 0) + t.amount))
  return out
}

const fact = (label: string, value: number, detail: string, rowsCount: number): AssistantFact => ({
  id: `driver-${++seq}`, label, value: r2(value), unit: 'BRL',
  provenance: { source: 'transactions', rows: rowsCount, detail },
})

export function analyzeChanges(state: AppState, today: string): ChangeAnalysis {
  const current = currentMonthToDate(today)
  const previous = previousPeriod(current)
  const now = rows(state, current.from, current.to)
  const before = rows(state, previous.from, previous.to)
  const incomeAfter = soma(now, 'income'), incomeBefore = soma(before, 'income')
  const expenseAfter = soma(now, 'expense'), expenseBefore = soma(before, 'expense')
  const totals = {
    incomeBefore, incomeAfter, incomeDelta: r2(incomeAfter - incomeBefore),
    expenseBefore, expenseAfter, expenseDelta: r2(expenseAfter - expenseBefore),
    netBefore: r2(incomeBefore - expenseBefore), netAfter: r2(incomeAfter - expenseAfter),
    netDelta: r2((incomeAfter - expenseAfter) - (incomeBefore - expenseBefore)),
  }

  const nomes = new Map((state.categories || []).map(c => [c.id, c.name]))
  const drivers: ChangeDriver[] = []
  for (const type of ['income', 'expense'] as const) {
    const a = porCategoria(before, type), b = porCategoria(now, type)
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const v0 = r2(a.get(key) || 0), v1 = r2(b.get(key) || 0), delta = r2(v1 - v0)
      if (Math.abs(delta) < 0.005) continue
      drivers.push({
        kind: type === 'income' ? 'income-category' : 'expense-category',
        key, label: nomes.get(key) || key, before: v0, after: v1, delta,
        contribution: r2(type === 'income' ? delta : -delta),
      })
    }
  }
  drivers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || a.label.localeCompare(b.label))
  const reconciledDelta = r2(drivers.reduce((a, d) => a + d.contribution, 0))

  const structural: StructuralChange[] = []
  for (const rec of state.recurring || []) {
    if (rec.startDate && rec.startDate >= current.from && rec.startDate <= current.to) {
      structural.push({ kind: 'recurring-start', label: rec.name, amount: rec.amount, date: rec.startDate })
    }
    if (rec.endDate && rec.endDate >= previous.from && rec.endDate <= current.to) {
      structural.push({ kind: 'recurring-end', label: rec.name, amount: rec.amount, date: rec.endDate })
    }
  }
  for (const plan of state.installmentPlans || []) {
    if (plan.firstDueDate >= current.from && plan.firstDueDate <= current.to) {
      structural.push({ kind: 'installment-start', label: plan.description, amount: plan.totalAmount / Math.max(plan.installmentCount, 1), date: plan.firstDueDate })
    }
    const parcelas = (state.installments || []).filter(i => i.planId === plan.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const ultima = parcelas[parcelas.length - 1]
    if (ultima && ultima.dueDate >= previous.from && ultima.dueDate <= current.to) {
      structural.push({ kind: 'installment-end', label: plan.description, amount: ultima.amount, date: ultima.dueDate })
    }
  }
  const despesas = now.filter(t => t.type === 'expense').map(t => t.amount).sort((a, b) => a - b)
  const mediana = despesas.length ? despesas[Math.floor(despesas.length / 2)] : 0
  for (const t of now.filter(t => t.type === 'expense' && t.amount >= Math.max(500, mediana * 2.5)).sort((a, b) => b.amount - a.amount).slice(0, 3)) {
    structural.push({ kind: 'extraordinary', label: t.description || nomes.get(t.category) || 'Gasto extraordinário', amount: t.amount, date: t.date })
  }

  const facts = [
    fact('Receitas no período anterior', incomeBefore, 'soma de receitas', before.filter(t => t.type === 'income').length),
    fact('Receitas no período atual', incomeAfter, 'soma de receitas', now.filter(t => t.type === 'income').length),
    fact('Gastos no período anterior', expenseBefore, 'soma de despesas', before.filter(t => t.type === 'expense').length),
    fact('Gastos no período atual', expenseAfter, 'soma de despesas', now.filter(t => t.type === 'expense').length),
    fact('Mudança no resultado', totals.netDelta, 'receitas menos despesas', now.length + before.length),
  ]
  return {
    current, previous, totals, drivers, structural, facts,
    reconciledDelta, reconciled: Math.abs(reconciledDelta - totals.netDelta) < 0.005,
    caveats: ['A comparação usa o mesmo número de dias dos dois meses e só lançamentos realizados.',
      '“Saldo” aqui significa o efeito dos lançamentos no período, não um extrato bancário externo.'],
  }
}
