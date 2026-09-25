import type { AppState } from '../../models/types'
import { fmtBRL } from '../../utils/format'
import { analyzeChanges } from './engine'
import type { ChangeAnalysis, ChangeDriver } from './types'

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export const looksLikeChangeQuestion = (message: string): boolean => {
  const t = semAcento(message)
  return /\bpor\s*que\b[^?]*(?:sobrou|sobra|gastei|gasto|saldo|resultado)/.test(t)
    || /\bo\s+que\s+mudou\b|\bonde\s+aumentou\b|\bo\s+que\s+mais\s+pesou\b[^?]*\borcamento\b/.test(t)
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
    `Comparando ${a.current.label} com ${a.previous.label}, no mesmo número de dias:`,
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
  const analysis = analyzeChanges(state, today)
  const reply = composeChangeExplanation(analysis, message)
  return { analysis, reply, explain: reply }
}

export { analyzeChanges }
export type { ChangeAnalysis, ChangeDriver, StructuralChange } from './types'
