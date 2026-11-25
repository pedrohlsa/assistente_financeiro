import type { ParsedAction } from '../../models/types'
import { parseMoney } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { findAllDates } from '../dates'
import { normalizeNumberWords } from '../numbers'
import { readRidePayoutApp } from '../platformPayout'

const ROAD = String.raw`(?:pedagio|estacionamento|sem\s+parar)`
const APP = String.raw`(?:uber|99|in\s*drive[r]?)`
const MONEY = String.raw`(?:r\$\s*)?(?<amount>\d+(?:[.,]\d+)*)(?:\s+(?:reais?|contos?))?`
const ROAD_KIND = String.raw`(?<road>${ROAD})`
const PAID = String.raw`(?:eu\s+)?(?:paguei|gastei)`
const RECEIVED = String.raw`(?:ganhei|faturei|recebi|fiz|entrou|caiu|deu|pagou)`
const ROAD_BEFORE = new RegExp(String.raw`^${PAID}\s+(?:o\s+)?${ROAD_KIND}\s+(?:de\s+)?${MONEY}$`)
const ROAD_AFTER = new RegExp(String.raw`^${PAID}\s+${MONEY}\s+(?:de|em|no|com)\s+${ROAD_KIND}$`)
const ROAD_REPORTED = new RegExp(String.raw`^(?:o\s+)?${ROAD_KIND}\s+(?:saiu(?:\s+por)?|deu|custou|ficou\s+em)\s+${MONEY}$`)
const ROAD_DEBITED = new RegExp(String.raw`^saiu\s+${MONEY}\s+(?:de|em|no)\s+${ROAD_KIND}$`)
const ROAD_PAID_BY_DRIVER = new RegExp(String.raw`^${MONEY}\s+de\s+${ROAD_KIND}\s+pag[oa]\s+por\s+mim$`)
const ROAD_PASS = new RegExp(String.raw`^passei\s+(?:por\s+(?:um\s+)?|num\s+|no\s+)${ROAD_KIND}\s+(?:de\s+)?${MONEY}$`)
const ROAD_AUTOMATIC = new RegExp(String.raw`^passei\s+(?:no|pelo)\s+(?<road>sem\s+parar)\s+(?:saiu|debitou|cobrou)\s+${MONEY}$`)
const ROAD_FUTURE = new RegExp(String.raw`^(?:eu\s+)?(?:vou\s+(?:ter\s+de\s+)?pagar|pago)\s+${MONEY}\s+(?:de|no|em)\s+${ROAD_KIND}$`)
const ROAD_PASSENGER_PAID = /^(?:(?:o|a)\s+)?passageir[oa]\s+(?:que\s+)?pagou$/
const ROAD_OTHER_PAYER = new RegExp(String.raw`^(?:teve|tinha)\s+${ROAD_KIND}\s+de\s+${MONEY}$`)
const ROAD_ALTERNATIVES = new RegExp(String.raw`^(?:${PAID}\s+)?${MONEY}\s+de\s+${ROAD_KIND}\s+ou\s+(?:foi\s+)?(?<other>\d+(?:[.,]\d+)*)(?:\s+reais?)?$`)
const APP_AFTER = String.raw`(?:(?:n[ao]|d[ao]|pel[ao]|via)\s+(?<app>${APP}))`
const RIDE_SUBJECT = new RegExp(String.raw`^(?:a\s+|nessa\s+)?corrida(?:\s+${APP_AFTER})?\s+(?:que\s+)?(?:rendeu|pagou|deu)\s+${MONEY}$`)
const RIDE_PAID = new RegExp(String.raw`^(?:(?:eu\s+)?(?<verb>${RECEIVED})\s+)?${MONEY}\s+(?:de|na|em)\s+corridas?(?:\s+${APP_AFTER})?$`)
const RIDE_PLATFORM_PAY = new RegExp(String.raw`^(?:eu\s+)?${RECEIVED}\s+${MONEY}\s+${APP_AFTER}$`)
const ROAD_KEYWORD = /\b(?:ped[aá]gio|estacionamento|sem\s+parar)\b/i

type Income = Extract<ParsedAction, { kind: 'income' }>
type Cost = Extract<ParsedAction, { kind: 'expense' }>

type RoadReport = {
  income?: Income
  cost: Cost
  alternative?: Cost
  payer: 'driver' | 'passenger' | 'future' | 'unknown'
  futureLabel?: string
}

function dateAndBody(text: string, today: string) {
  const dates = findAllDates(text, today)
  const [found] = dates
  const date = found?.kind === 'date' || found?.kind === 'future' ? found : undefined
  if (dates.length > 1 || (found && !date)) return undefined
  const rest = date ? `${text.slice(0, date.start)} ${text.slice(date.end)}`.trim().replace(/\s+/g, ' ')
    .replace(/\s+(?:de|pela|a|na|no\s+curso\s+d[ae])\s+(?:manha|tarde|noite|madrugada)$/, '') : text.trim()
  return { date, text: rest }
}

function receipt(text: string) {
  const subject = text.match(RIDE_SUBJECT)
  const listed = text.match(RIDE_PAID)
  const match = subject || listed || text.match(RIDE_PLATFORM_PAY)
  if (!match) return undefined
  const amount = parseMoney(match.groups.amount)
  if (!(amount > 0)) return undefined
  const platform = match.groups.app ? readRidePayoutApp(match.groups.app) : undefined
  return { amount, platform, explicit: !listed || !!listed.groups.verb,
    needsOwnReading: !!subject || !!listed && (!listed.groups.verb || /^(?:deu|pagou)$/.test(listed.groups.verb)) }
}

function charge(text: string, passenger: boolean) {
  const paid = text.match(ROAD_BEFORE) || text.match(ROAD_AFTER)
  const future = text.match(ROAD_FUTURE)
  const unknown = text.match(ROAD_PASS)
  const alternatives = text.match(ROAD_ALTERNATIVES)
  if (passenger && (paid || future || alternatives)) return undefined
  const match = paid || future || unknown || alternatives || (passenger && text.match(ROAD_OTHER_PAYER))
    || text.match(ROAD_REPORTED) || text.match(ROAD_DEBITED) || text.match(ROAD_AUTOMATIC) || text.match(ROAD_PAID_BY_DRIVER)
  if (!match) return undefined
  const amount = parseMoney(match.groups.amount)
  const second = alternatives && parseMoney(alternatives.groups.other)
  if (!(amount > 0) || (alternatives && (!(second > 0) || second === amount))) return undefined
  const category = match.groups.road === 'estacionamento' ? 'estacionamento' : 'pedagio'
  const description = category === 'pedagio' ? 'Pedágio' : 'Estacionamento'
  const payer: RoadReport['payer'] = passenger ? 'passenger' : future ? 'future' : unknown ? 'unknown' : 'driver'
  return { amount, second, category, description, payer, explicit: !!paid }
}

export function readRoadReport(message: string, today: string): RoadReport | undefined {
  if (!ROAD_KEYWORD.test(message) || message.includes('?')) return undefined
  const text = normalizeName(normalizeNumberWords(message).text).replace(/[.!]+$/, '').trim()
  const passed = text.match(/^(.+?)\s+(nessa\s+corrida\s+que\s+.+)$/)
  const parts = passed ? passed.slice(1) : text.split(/,\s+(?:e\s+)?|;\s*(?:e\s+)?|\s+e\s+/)
  const passenger = parts.length === 3 && ROAD_PASSENGER_PAID.test(parts[1])
  if (passenger) parts.splice(1, 1)
  if (parts.length === 3 && /^(?:nao\s+lembro|nao\s+sei)$/.test(parts[2])) parts.pop()
  if (parts.length === 1) {
    const part = dateAndBody(parts[0], today)
    const fee = part && charge(part.text, false)
    if (!fee || fee.explicit || fee.second || fee.payer !== 'driver' || part.date?.kind === 'future') return undefined
    return { payer: 'driver', cost: { kind: 'expense', amount: fee.amount, category: fee.category, description: fee.description, date: part.date?.date } }
  }
  if (parts.length !== 2) return undefined
  const [first, second] = parts.map(part => dateAndBody(part, today))
  if (!first || !second) return undefined
  const left = receipt(first.text)
  const right = receipt(second.text)
  if (!!left === !!right) return undefined
  const [ride, road] = left ? [first, second] : [second, first]
  const money = left || right
  const fee = charge(road.text, passenger)
  if (!fee || (fee.explicit && !money.needsOwnReading && !passenger)) return undefined
  if (!money.explicit && fee.payer === 'unknown') return undefined
  if (ride.date?.kind === 'future' || (road.date?.kind === 'future' && fee.payer !== 'future')) return undefined
  const rideDate = ride.date?.date ?? (fee.payer !== 'future' ? road.date?.date : undefined)
  const date = road.date?.kind === 'date' ? road.date.date : ride.date?.date
  const income: Income = { kind: 'income', amount: money.amount, category: 'corridas', description: money.platform, date: rideDate }
  const cost: Cost = { kind: 'expense', amount: fee.amount, category: fee.category, description: fee.description, date }
  return { income, cost, alternative: fee.second ? { ...cost, amount: fee.second } : undefined,
    payer: fee.payer, futureLabel: road.date?.kind === 'future' ? road.date.label : undefined }
}
