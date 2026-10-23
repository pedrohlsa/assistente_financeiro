import type { AppState } from '../../models/types'
import { fmtBRL } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { currentMonthToDate, previousPeriod } from '../query/period'
import { parsePeriod } from '../query/period'
import { analyzeChanges } from './engine'
import type { ChangeAnalysis, ChangeDriver } from './types'

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export const looksLikeChangeQuestion = (message: string): boolean => {
  const t = semAcento(message)
  return /\b(?:por\s*que|pq)\b[^?]*(?:sobrou|sobra|gastei|gasto|saldo|resultado)/.test(t)
    || /\b(?:o\s+que|oq)\s+mudou\b|\bonde\s+aumentou\b|\bo\s+que\s+(?:mais\s+)?pesou\b[^?]*\borcamento\b/.test(t)
    || /\b(?:saldo|resultado)\s+(?:caiu|diminuiu|piorou)\b/.test(t)
}

const fraseDriver = (d: ChangeDriver): string => {
  const movimento = d.delta > 0 ? 'subiu' : 'caiu'
  const efeito = d.contribution >= 0 ? 'melhorou' : 'reduziu'
  return `${d.label}: ${movimento} ${fmtBRL(Math.abs(d.delta))} e ${efeito} o resultado em ${fmtBRL(Math.abs(d.contribution))}`
}

export function composeChangeExplanation(a: ChangeAnalysis, message = ''): string {
  const t = semAcento(message)
  const soGastos = /gastei\s+mais|gasto\s+subiu|onde\s+aumentou|mais\s+pesou/.test(t)
  const candidatos = soGastos
    ? a.drivers.filter(d => d.kind === 'expense-category' && d.delta > 0)
    : a.drivers
  const top = (candidatos.length ? candidatos : a.drivers).slice(0, 4)
  const linhas = [
    `Comparação — ${a.current.label} × ${a.previous.label}:`,
    `• Receitas: ${fmtBRL(a.totals.incomeBefore)} → ${fmtBRL(a.totals.incomeAfter)} (${sinal(a.totals.incomeDelta)})`,
    `• Gastos: ${fmtBRL(a.totals.expenseBefore)} → ${fmtBRL(a.totals.expenseAfter)} (${sinal(a.totals.expenseDelta)})`,
    `• Resultado: ${fmtBRL(a.totals.netBefore)} → ${fmtBRL(a.totals.netAfter)} (${sinal(a.totals.netDelta)})`,
  ]
  if (top.length) linhas.push('', 'O que mais explicou a mudança:', ...top.map(d => `• ${fraseDriver(d)}`))
  const estruturais = a.structural.slice(0, 3)
  if (estruturais.length) linhas.push('', 'Mudanças estruturais detectadas:', ...estruturais.map(s => `• ${s.label}${s.amount ? ` — ${fmtBRL(s.amount)}` : ''}`))
  linhas.push('', a.reconciled
    ? `A conta fecha: os fatores somam ${sinal(a.reconciledDelta)}, igual à mudança do resultado.`
    : 'Os fatores não reconciliaram com o total; não vou atribuir uma causa incompleta.')
  linhas.push(a.caveats[0])
  return linhas.join('\n')
}

const sinal = (v: number) => `${v >= 0 ? '+' : '−'}${fmtBRL(Math.abs(v))}`

export function answerChangeQuestion(state: AppState, message: string, today: string) {
  if (!looksLikeChangeQuestion(message)) return null
  const category = expenseCategoryInQuestion(state, message)
  const current = parsePeriod(message, today)?.period || currentMonthToDate(today)
  const scope = { current, previous: previousPeriod(current), expenseCategory: category }
  const analysis = analyzeChanges(state, today, scope)
  const reply = composeChangeExplanation(analysis, message)
  return { analysis, reply, explain: reply }
}

export function expenseCategoryInQuestion(state: AppState, message: string): string | undefined {
  const normalized = normalizeName(message)
  return (state.categories || []).find(c => c.type === 'expense'
    && normalizeName(c.name).length >= 4
    && new RegExp(`(?<![a-z])${normalizeName(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(normalized))?.id
}

/** "Desde junho" não define uma base de comparação causal por si só. */
export function changeScopeClarification(message: string, today: string): string | undefined {
  if (!looksLikeChangeQuestion(message)) return undefined
  const t = semAcento(message)
  if (/\bdesde\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(t)) {
    const period = parsePeriod(message, today)?.period
    return `Você quer comparar ${period?.label || 'esse período'} até hoje com o período anterior de mesma duração?`
  }
  return undefined
}

export { analyzeChanges }
export type { ChangeAnalysis, ChangeDriver, StructuralChange } from './types'
