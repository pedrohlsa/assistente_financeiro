import type { AppState } from '../models/types'
import { kmCost } from '../services/calc'
import { isDriver, RIDE_INCOME_CATEGORIES } from '../services/profile'
import { addDays, fmtBRL, fromISO, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'

export const PARE_PARA_DESCANSAR = 'Pare em um local seguro e descanse antes de voltar a dirigir.'

export function perceivesDrivingFatigue(text: string): boolean {
  const t = normalizeName(text)
  const reports = t.matchAll(/\b(?:(nao|nem)\s+)?(?:to|tou|estou|fiquei|acordei)\s+(?:(?:muito|bem|meio|tao|ja)\s+)?(?:cansad[oa]|com\s+sono|sonolent[oa]|(?:morrendo|caindo)\s+de\s+sono)\b/g)
  return [...reports].some(([, negated]) => !negated)
}

const VALE_RODAR = /\b(?:vale(?:\s+a\s+pena)?|compensa|devo)\s+(?:(?:eu|sair\s+(?:pra|para))\s+)?(?:rodar|dirigir|trabalhar)\b|\b(?:rodar|dirigir|trabalhar)\b[^?]*\b(?:vale(?:\s+a\s+pena)?|compensa)\b/

/** Referência por dia da semana, só em dias com horas e receita de corridas. */
function sameWeekdayRate(state: AppState, today: string) {
  const from = addDays(today, -56)
  const weekday = fromISO(today).getDay()
  const hours = new Map<string, number>()
  for (const work of state.workSessions || []) {
    if (work.date < from || work.date >= today || !Number.isFinite(work.hours) || !(work.hours > 0)
      || fromISO(work.date).getDay() !== weekday) continue
    hours.set(work.date, (hours.get(work.date) || 0) + work.hours)
  }
  const income = new Map<string, number>()
  for (const tx of state.transactions || []) {
    if (!hours.has(tx.date) || tx.type !== 'income' || !RIDE_INCOME_CATEGORIES.includes(tx.category)
      || !Number.isFinite(tx.amount) || !(tx.amount > 0)) continue
    income.set(tx.date, (income.get(tx.date) || 0) + tx.amount)
  }
  if (income.size < 3) return undefined
  const total = [...income.values()].reduce((sum, value) => sum + value, 0)
  const totalHours = [...income.keys()].reduce((sum, date) => sum + hours.get(date)!, 0)
  return { average: total / totalHours, days: income.size,
    label: fromISO(today).toLocaleDateString('pt-BR', { weekday: 'long' }) }
}

export function answerDrivingShift(state: AppState, input: string, today = todayISO(), context = input): string | undefined {
  if (!isDriver(state.settings)) return undefined
  const t = normalizeName(input)
  const holiday = /\bferiados?\b/.test(t)
  if (!VALE_RODAR.test(t) || /\d|\b(?:amanha|ontem|anteontem|mes\s+que\s+vem|noite|madrugada)\b/.test(t)
    || (!holiday && !/\bhoje\b/.test(t))) return undefined
  if (perceivesDrivingFatigue(context)) return PARE_PARA_DESCANSAR
  const historic = sameWeekdayRate(state, today)
  const costs = kmCost(state)
  const lines = [
    holiday ? 'Seu histórico ainda não separa feriados. Dá para comparar os valores das ofertas de hoje com seus custos.'
      : 'Para decidir se vale sair hoje, compare as ofertas que aparecerem com seus custos.',
    historic ? `A média bruta foi ${fmtBRL(historic.average)} por hora trabalhada, com base em ${historic.days} registros de ${historic.label} nas últimas oito semanas.`
      : 'Preciso de pelo menos três dias com corridas e horas registradas nesse dia da semana para calcular a média.',
    costs.minRecommended > 0 ? `Seu mínimo de referência é ${fmtBRL(costs.minRecommended)}/km bruto, contando o caminho até o passageiro.` : undefined,
    'Se quiser avaliar uma oferta, diga quanto paga, os km até o passageiro, os km da viagem e o tempo total.',
  ]
  return lines.filter(Boolean).join('\n\n')
}
