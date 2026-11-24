import { parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { findAllDates } from './dates'
import type { DateResolution } from './dates'
import { normalizeNumberWords } from './numbers'
import { elapsedMinutes } from './semantic/clock'

export interface WorkHoursEdit {
  hours: number
  previousHours?: number
}

const REQUEST_VERB = String.raw`(?:por favor,?\s+)?(?:pode\s+)?(?:corrige|corrigir|corrija|ajusta|ajustar|ajuste|muda|mudar|altera|alterar)`
const REQUEST = new RegExp(String.raw`^${REQUEST_VERB}\s+(?:as\s+)?horas(?<target>.*?)\s+(?:para|pra)\s+(?<hours>.+)$`)
const JOURNEY_REQUEST = new RegExp(String.raw`^${REQUEST_VERB}\s+(?:(?:a|minha)\s+)?(?:jornada|turno)(?<target>.*?),\s*(?:trabalhei|foram)\s+(?<hours>.+)$`)
const CONTRAST = /^(?:as\s+)?horas(?<target>.*?)\s+(?:foram|eram)\s+(?<hours>.+?)(?:,\s*|\s+(?:e\s+)?)nao\s+(?<previous>.+)$/
const ALREADY_SAVED = /^ja\s+(?:tenho|registrei|salvei)\s+(?:uma?\s+)?(?:jornada|turno)\s+[^.!?]+[.!]\s*/
const DATE_REMAINDER = /^(?:de\s+trabalho\s*)?(?:d[aeo]s?|em|n[ao]|no\s+dia)?$/

function hoursIn(text: string): number {
  const simple = text.match(/^(\d+(?:[.,]\d{1,3})?)\s*(?:horas?|h)?$/)
  if (simple) return parseMoney(simple[1])
  if (/^zero(?:\s+horas?)?$/.test(text)) return 0
  return (elapsedMinutes(text) ?? NaN) / 60
}

export function readWorkHoursEdit(message: string, today: string): { edit: WorkHoursEdit; dates: DateResolution[] } | undefined {
  if (!/\b(?:horas|jornada|turno)\b/i.test(message)) return undefined
  const text = normalizeName(normalizeNumberWords(message).text).replace(/[.!?]+$/, '').replace(/,?\s+por favor$/, '').trim()
  const header = text.match(ALREADY_SAVED)
  const body = header ? text.slice(header[0].length) : text
  const request = body.match(REQUEST) || body.match(JOURNEY_REQUEST)
  const parts = (request || (!message.includes('?') ? body.match(CONTRAST) : undefined))?.groups
  if (!parts) return undefined

  const target = parts.target.trim()
  const targetDates = findAllDates(target, today)
  const rest = targetDates.reduceRight((remaining, date) => remaining.slice(0, date.start) + remaining.slice(date.end), target)
  if (!DATE_REMAINDER.test(rest.trim())) return undefined

  const hours = hoursIn(parts.hours)
  const previousHours = parts.previous === undefined ? undefined : hoursIn(parts.previous)
  const dates = targetDates.length ? targetDates : findAllDates(header?.[0] || '', today)
  return { edit: { hours, previousHours }, dates }
}
