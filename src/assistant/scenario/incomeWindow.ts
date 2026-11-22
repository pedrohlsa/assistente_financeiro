import type { AppState } from '../../models/types'
import { occurrencesBetween, recurringOccurrenceState } from '../../services/calc'
import { addDays, dateForDayOfMonth, fromISO, MESES_PT_BR, parseMoney, toISO } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { findDate } from '../dates'
import { parseCalendarRange, parseFutureMonth } from '../query/period'
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

export function mentionedRentals(state: AppState, text: string, today: string): { origin: string; said: string }[] {
  const names = rentalSources(state, today).flatMap(origin => {
    const short = origin.replace(/^aluguel\s+(?:(?:d[aeo]|d[ao]s)\s+)?/, '')
    return [...new Set([origin, short])].filter(Boolean).map(said => ({ origin, said }))
  }).sort((a, b) => b.said.length - a.said.length)
  let remaining = ` ${normalizeName(text).replace(/[^\p{L}\p{N} -]+/gu, ' ')} `
  const found = new Map<string, { origin: string; said: string }>()
  for (const name of names) {
    const token = ` ${name.said} `
    if (!remaining.includes(token)) continue
    for (const match of names.filter(candidate => candidate.said === name.said)) found.set(match.origin, match)
    remaining = remaining.split(token).join(' ')
  }
  return [...found.values()]
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
const MONTH = String.raw`(?:${MESES_PT_BR.map(normalizeName).join('|')})(?:\s+de\s+\d{4})?\b`
const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)(?![\d/-])`
const END_MONTH = new RegExp(String.raw`\bate\s+(?:(?:o\s+)?(?:fim|final)\s+de\s+)?(${MONTH})`)
const END_DATE = new RegExp(String.raw`\bate\s+(${DATE})`)
const DATE_RANGE = new RegExp(String.raw`\bde\s+(${DATE})\s+(?:a|ate)\s+(${DATE})`)
const MONTH_RANGE = new RegExp(String.raw`\bde\s+(${MONTH})\s+(?:a|ate)\s+(${MONTH})`)
const START = new RegExp(String.raw`\b(?:a\s+partir\s+d[eo]|comecando(?:\s+(?:em|n[eo]))?|a\s+contar\s+d[eo])\s+(${DATE}|(?:dia\s+)?\d{1,2}\s+de\s+${MONTH}|${MONTH})`)
const IN_MONTH = new RegExp(String.raw`\bem\s+(${MONTH})`)
const NAMED_WINDOW = /\b(?:(?:a\s+partir\s+d[eo]|comecando(?:\s+n[eo])?|a\s+contar\s+d[eo]|ate(?:\s+o)?)\s+)?(?:(?:o\s+)?(?:fim|final)\s+d(?:o|este|esse)\s+mes|(?:d?este|d?esse|neste|nesse|o)\s+mes(?!(?:\s+que\s+vem))|mes\s+que\s+vem|proximo\s+mes)\b/

type WindowReading = {
  remaining: string
  window?: IncomeLossWindow
  start?: string
  issue?: string
}

function projectedWindow(remaining: string, today: string, from?: string, to?: string): WindowReading {
  if (!from || !to || from < today || to < from) {
    return { remaining, issue: 'Informe as datas inicial e final da simulação, a partir de hoje.' }
  }
  if (to > incomeLossEnd(today, { value: 12, unit: 'months' })) return { remaining, issue: INCOME_LOSS_WINDOW_LIMIT }
  return { remaining, window: { from, to } }
}

function futureNamedMonth(text: string, from: string) {
  const month = parseFutureMonth(text, from)
  const year = text.match(/\b\d{4}$/)?.[0]
  return month && (!year || month.from.startsWith(year)) ? month : undefined
}

function futureCalendarDay(text: string, from: string): string | undefined {
  const value = findDate(text, from)
  if ((value?.kind === 'date' || value?.kind === 'future') && value.date >= from) return value.date
  // "31/01", dito em dezembro numa hipótese futura, é janeiro do ano seguinte.
  if (!/^\d{1,2}[/-]\d{1,2}$/.test(text)) return undefined
  const next = findDate(`${text}/${Number(from.slice(0, 4)) + 1}`, from)
  return next?.kind === 'future' || next?.kind === 'date' ? next.date : undefined
}

function readNamedIncomeLossWindow(text: string, today: string): WindowReading | undefined {
  const exactRange = text.match(DATE_RANGE)
  if (exactRange) {
    const from = futureCalendarDay(exactRange[1], today)
    const to = from && futureCalendarDay(exactRange[2], from)
    return projectedWindow(text.replace(exactRange[0], ' '), today, from, to)
  }
  const dayRange = parseCalendarRange(text, today)
  if (dayRange) return projectedWindow(text.replace(dayRange.matched, ' '), today, dayRange.period?.from, dayRange.period?.to)
  const months = text.match(MONTH_RANGE)
  if (months) {
    const first = futureNamedMonth(months[1], today)
    const last = first && futureNamedMonth(months[2], first.from)
    return projectedWindow(text.replace(months[0], ' '), today,
      first && first.to >= today ? (first.from < today ? today : first.from) : undefined, last?.to)
  }
  const anchor = text.match(START)
  const remainingFromAnchor = anchor ? text.replace(anchor[0], ' ') : text
  let from = today
  if (anchor) {
    const month = /^\d|^dia\b/.test(anchor[1]) ? undefined : futureNamedMonth(anchor[1], today)
    const start = month && month.to >= today ? (month.from < today ? today : month.from) : futureCalendarDay(anchor[1], today)
    if (!start || start < today) return { remaining: remainingFromAnchor, issue: 'Em que data futura a entrada deixaria de cair?' }
    if (start > incomeLossEnd(today, { value: 12, unit: 'months' })) return { remaining: remainingFromAnchor, issue: INCOME_LOSS_WINDOW_LIMIT }
    from = start
  }
  const endDay = remainingFromAnchor.match(END_DATE)
  const deadline = endDay || remainingFromAnchor.match(END_MONTH)
  if (deadline) {
    const remaining = remainingFromAnchor.replace(deadline[0], ' ')
    const to = endDay ? futureCalendarDay(deadline[1], from) : futureNamedMonth(deadline[1], from)?.to
    if (!to || to < from) {
      return { remaining, issue: 'Até que dia ou mês futuro a entrada ficaria ausente?' }
    }
    return projectedWindow(remaining, today, from, to)
  }
  if (anchor) return { remaining: remainingFromAnchor, start: from }
  const during = text.match(IN_MONTH)
  if (during) {
    const month = futureNamedMonth(during[1], today)
    return projectedWindow(text.replace(during[0], ' '), today,
      month && month.to >= today ? (month.from < today ? today : month.from) : undefined, month?.to)
  }
  const named = text.match(NAMED_WINDOW)
  if (!named) return undefined
  const next = /\b(?:vem|proximo)\b/.test(named[0])
  const startsAtMonth = /^(?:a\s+partir|comecando|a\s+contar)/.test(named[0])
  const date = fromISO(today)
  const month = date.getMonth() + (next ? 1 : 0)
  from = next && !named[0].startsWith('ate ') ? toISO(new Date(date.getFullYear(), month, 1, 12)) : today
  return {
    remaining: text.slice(0, named.index) + ' ' + text.slice(named.index + named[0].length),
    ...(startsAtMonth ? { start: from } : { window: { from, to: toISO(new Date(date.getFullYear(), month + 1, 0, 12)) } }),
  }
}

export function readIncomeLossTiming(text: string, today: string, pendingStart?: string): WindowReading & { duration?: IncomeLossDuration } {
  const { duration, remaining, issue } = readIncomeLossDuration(text)
  const calendar = readNamedIncomeLossWindow(remaining, today)
  const rest = calendar?.remaining ?? remaining
  if (issue || calendar?.issue) return { remaining: rest, issue: issue || calendar?.issue }
  const from = calendar ? calendar.start : pendingStart
  if (from) {
    if (!duration) return { remaining: rest, start: from }
    return projectedWindow(rest, today, from, incomeLossEnd(from, duration))
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
