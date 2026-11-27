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
const REQUEST = new RegExp(
  String.raw`^${REQUEST_VERB}\s+(?:(?:as\s+)?(?:(?<previous>\d+(?:[.,]\d+)?)\s+)?horas|(?:o\s+)?tempo\s+(?:de\s+trabalho|trabalhado))(?<target>.*?)\s+(?:para|pra)\s+(?<hours>.+)$`,
)
const JOURNEY_REQUEST = new RegExp(String.raw`^${REQUEST_VERB}\s+(?:(?:a|minha)\s+)?(?:jornada|turno)(?<target>.*?),\s*(?:trabalhei|foram)\s+(?<hours>.+)$`)
const CONTRAST = /^(?:as\s+)?horas(?<target>.*?)\s+(?:foram|eram)\s+(?<hours>.+?)(?:,\s*|\s+(?:e\s+)?)nao\s+(?<previous>.+)$/
// "As horas de ontem FORAM 10": a correção sem o valor antigo.
const PLAIN = /^(?:as\s+)?horas(?<target>.*?)\s+(?:foram|eram)\s+(?<hours>\d+(?:[.,]\d+)?(?:\s*(?:horas?|h))?)$/
// "Ontem trabalhei 9 horas E NÃO 8": o dia antes do verbo, e o valor antigo negado.
const VERB_CONTRAST = /^(?<target>(?:ontem|anteontem|hoje|dia\s+\d{1,2}(?:\/\d{1,2})?)?)\s*(?:eu\s+)?(?:trabalhei|rodei|fiquei|fiz)\s+(?<hours>\d+(?:[.,]\d+)?\s*(?:horas?|h))\s*,?\s*(?:e\s+)?nao\s+(?<previous>\d+(?:[.,]\d+)?(?:\s*(?:horas?|h))?)$/
const ALREADY_SAVED = /^ja\s+(?:tenho|registrei|salvei)\s+(?:uma?\s+)?(?:jornada|turno)\s+[^.!?]+[.!]\s*/
const DATE_REMAINDER = /^(?:de\s+trabalho\s*)?(?:d[aeo]s?|em|n[ao]|no\s+dia)?$/

function hoursIn(text: string): number {
  const simple = text.match(/^(\d+(?:[.,]\d{1,3})?)\s*(?:horas?|h)?$/)
  if (simple) return parseMoney(simple[1])
  if (/^zero(?:\s+horas?)?$/.test(text)) return 0
  return (elapsedMinutes(text) ?? NaN) / 60
}

export function readWorkHoursEdit(message: string, today: string): { edit: WorkHoursEdit; dates: DateResolution[]; invalidDate: boolean } | undefined {
  if (!/\b(?:horas|jornada|turno|tempo)\b/i.test(message)) return undefined
  const text = normalizeName(normalizeNumberWords(message).text).replace(/[.!?]+$/, '').replace(/,?\s+por favor$/, '').trim()
  const header = text.match(ALREADY_SAVED)
  const body = header ? text.slice(header[0].length) : text
  const request = body.match(REQUEST) || body.match(JOURNEY_REQUEST)
  const parts = (request || (!message.includes('?') ? body.match(CONTRAST) || body.match(VERB_CONTRAST) || body.match(PLAIN) : undefined))?.groups
  if (!parts) return undefined

  const target = parts.target.trim()
  const targetDates = findAllDates(target, today)
  const rest = targetDates.reduceRight((remaining, date) => remaining.slice(0, date.start) + remaining.slice(date.end), target)
  const hasUnexpectedText = !DATE_REMAINDER.test(rest.trim())
  const invalidDate = hasUnexpectedText && /\d+[/.-]\d+|\bdia\s+\d+\b/.test(target)
  if (hasUnexpectedText && !invalidDate) return undefined

  const hours = hoursIn(parts.hours)
  const previousHours = parts.previous === undefined ? undefined : hoursIn(parts.previous)
  const dates = invalidDate ? [] : targetDates.length ? targetDates : findAllDates(header?.[0] || '', today)
  return { edit: { hours, previousHours }, dates, invalidDate }
}
