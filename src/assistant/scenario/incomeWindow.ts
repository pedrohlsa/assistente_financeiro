import type { AppState } from '../../models/types'
import { occurrencesBetween, recurringOccurrenceState } from '../../services/calc'
import { addDays, dateForDayOfMonth, fromISO, MESES_PT_BR, parseMoney, toISO } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { findDate } from '../dates'
import { parseFutureMonth } from '../query/period'
import type { IncomeLossDuration } from './types'

const DURATION = /(?<![\d.,])(?:(?:por|durante)\s+)?([-−]?\d+(?:[.,]\d+)?|um|uma)\s+(dias?|semanas?|mes(?:es)?)\b(?!\s+d[eo]\s+aluguel)/g
export const INCOME_LOSS_WINDOW_LIMIT = 'Informe um prazo inteiro de até 12 meses, 52 semanas ou 365 dias.'
export const MISSING_RENTAL_SOURCE = 'Qual imóvel ficaria sem aluguel? Diga a origem, como Casa 2.'
export const MISSING_RENTAL_PERIOD = 'Por quanto tempo o imóvel ficaria sem aluguel?'

export function describeMissingRentalInput(origin?: string, hasPeriod = false): string | undefined {
  if (!origin) return MISSING_RENTAL_SOURCE
  if (!hasPeriod) return MISSING_RENTAL_PERIOD
  return undefined
}

export function validIncomeLossDuration(d: IncomeLossDuration): boolean {
  const limit = { days: 365, weeks: 52, months: 12 }[d.unit]
  return Number.isInteger(d.value) && d.value >= 1 && d.value <= limit
}

export function readIncomeLossDuration(text: string) {
  const matches = [...text.matchAll(DURATION)]
  const [first] = matches
  const remaining = text.replace(DURATION, ' ')
  if (matches.length > 1) return { remaining, issue: 'Informe uma única duração para esta simulação de entrada ausente.' }
  if (!first) return { remaining }
  const before = text.slice(0, first.index)
  const approximate = before.match(/\b(?:uns|umas|aproximadamente|cerca\s+de|mais\s+ou\s+menos|entre\s+\d+\s+e|\d+\s+ou)\s*$/i)
  if (approximate) {
    return { remaining: before.slice(0, approximate.index) + ' ' + text.slice(first.index + first[0].length),
      issue: 'Qual duração devo usar? Diga um prazo único em dias, semanas ou meses.' }
  }
  const duration: IncomeLossDuration = {
    value: /^uma?$/.test(first[1]) ? 1 : parseMoney(first[1].replace('−', '-')), unit: /^dia/.test(first[2]) ? 'days' : /^semana/.test(first[2]) ? 'weeks' : 'months',
  }
  return validIncomeLossDuration(duration) ? { remaining, duration } : { remaining, issue: INCOME_LOSS_WINDOW_LIMIT }
}

export const isRentalIncome = (category: string, description?: string): boolean =>
  category === 'aluguel' || /\baluguel\b/.test(normalizeName(description))

export function rentalSources(state: AppState, today: string): string[] {
  const names = new Set((state.recurring || [])
    .filter(r => r.active !== false && r.kind === 'income' && isRentalIncome(r.category, r.name))
    .map(r => normalizeName(r.origin || r.name)))
  for (const tx of state.transactions || []) {
    const name = normalizeName(tx.origin)
    if (tx.type === 'income' && tx.date <= today && name && isRentalIncome(tx.category, tx.description)
      && ![...names].some(candidate => matchesIncomeSource(name, undefined, candidate))) names.add(name)
  }
  return [...names].filter(Boolean)
}

/** Fim inclusivo. Ex.: de 21/11 por 3 meses cobre até 20/02. */
export function incomeLossEnd(today: string, duration: IncomeLossDuration): string {
  if (duration.unit !== 'months') return addDays(today, duration.value * (duration.unit === 'weeks' ? 7 : 1) - 1)
  const start = fromISO(today)
  return addDays(toISO(dateForDayOfMonth(start.getFullYear(), start.getMonth() + duration.value, start.getDate())), -1)
}

export function incomeLossLabel(duration: IncomeLossDuration): string {
  const units = { days: ['dia', 'dias'], weeks: ['semana', 'semanas'], months: ['mês', 'meses'] }
  return `${duration.value} ${units[duration.unit][duration.value === 1 ? 0 : 1]}`
}

type IncomeLossWindow = { from: string; to: string }
const END_MONTH = new RegExp(String.raw`\bate\s+(?:(?:o\s+)?(?:fim|final)\s+de\s+)?(${MESES_PT_BR.map(normalizeName).join('|')})(?:\s+de\s+(\d{4}))?\b`)
const END_DATE = /\bate\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)(?![\d/-])/
const NAMED_WINDOW = /\b(?:(?:a\s+partir\s+d[eo]|comecando(?:\s+n[eo])?|a\s+contar\s+d[eo]|ate(?:\s+o)?)\s+)?(?:(?:o\s+)?(?:fim|final)\s+d(?:o|este|esse)\s+mes|(?:d?este|d?esse|neste|nesse|o)\s+mes(?!(?:\s+que\s+vem))|mes\s+que\s+vem|proximo\s+mes)\b/

function readNamedIncomeLossWindow(text: string, today: string): {
  remaining: string
  window?: IncomeLossWindow
  startsAtMonth?: boolean
  issue?: string
} | undefined {
  const deadline = text.match(END_DATE) || text.match(END_MONTH)
  if (deadline) {
    const remaining = text.slice(0, deadline.index) + ' ' + text.slice(deadline.index! + deadline[0].length)
    const date = findDate(deadline[1], today)
    const to = date?.kind === 'date' || date?.kind === 'future' ? date.date
      : parseFutureMonth(deadline[2] ? `${deadline[1]} de ${deadline[2]}` : deadline[1], today)?.to
    if (!to || to < today || (deadline[2] && !to.startsWith(deadline[2]))) {
      return { remaining, issue: 'Até que dia ou mês futuro a entrada ficaria ausente?' }
    }
    if (to > incomeLossEnd(today, { value: 12, unit: 'months' })) return { remaining, issue: INCOME_LOSS_WINDOW_LIMIT }
    return { remaining, window: { from: today, to } }
  }
  const named = text.match(NAMED_WINDOW)
  if (!named) return undefined
  const next = /\b(?:vem|proximo)\b/.test(named[0])
  const startsAtMonth = /^(?:a\s+partir|comecando|a\s+contar)/.test(named[0])
  const date = fromISO(today)
  const month = date.getMonth() + (next ? 1 : 0)
  return {
    remaining: text.slice(0, named.index) + ' ' + text.slice(named.index + named[0].length),
    startsAtMonth,
    window: {
      from: next && !named[0].startsWith('ate ') ? toISO(new Date(date.getFullYear(), month, 1, 12)) : today,
      to: toISO(new Date(date.getFullYear(), month + 1, 0, 12)),
    },
  }
}

export function readIncomeLossTiming(text: string, today: string, pendingStart?: string) {
  const { duration, remaining, issue } = readIncomeLossDuration(text)
  const calendar = readNamedIncomeLossWindow(remaining, today)
  const rest = calendar?.remaining ?? remaining
  if (issue || calendar?.issue) return { remaining: rest, issue: issue || calendar?.issue }
  const from = calendar ? (calendar.startsAtMonth ? calendar.window?.from : undefined) : pendingStart
  if (from) {
    if (!duration) return { remaining: rest, start: from }
    return { remaining: rest, window: { from, to: incomeLossEnd(from, duration) } }
  }
  if (duration && calendar?.window) {
    return { remaining: rest, issue: 'Quer usar o mês do calendário ou a duração que você informou?' }
  }
  return { remaining: rest, duration, window: calendar?.window }
}

export function matchesIncomeSource(name: string, origin?: string, description?: string): boolean {
  const target = normalizeName(name)
  return origin ? normalizeName(origin) === target
    : ` ${normalizeName(description).replace(/[^\p{L}\p{N} -]+/gu, ' ')} `.includes(` ${target} `)
}

export function pendingIncomeInWindow(state: AppState, today: string, until: string) {
  return state.recurring.filter(r => r.kind === 'income').flatMap(r =>
    occurrencesBetween(r, today, until, today)
      .filter(date => !recurringOccurrenceState(state, r, date, today).resolved)
      .map(date => ({ id: `${r.id}:${date}`, date, amount: r.amount, origin: r.origin, name: r.name, category: r.category })),
  )
}
