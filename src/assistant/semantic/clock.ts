import { isCashClock } from '../contracts'
import { normalizeNumberWords } from '../numbers'

const UNIT = 'um[a]?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove'
const SMALL = `${UNIT}|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove`
const HOUR = String.raw`(?:\d{1,2}|vinte(?:\s+e\s+(?:${UNIT}))?|${SMALL})`
const MINUTE = String.raw`(?:\d{1,2}|meia|(?:vinte|trinta|quarenta|cinquenta)(?:\s+e\s+(?:${UNIT}))?|${SMALL})`
const PART_OF_DAY = 'manh[ãa]|tarde|noite|madrugada'
const CLOCK = String.raw`${HOUR}(?:\s*(?::|h)\s*\d{1,2}|\s*h\b|\s+e\s+${MINUTE}|\s+horas?\b)?(?:\s+da\s+(?:${PART_OF_DAY}))?(?:\s+em\s+ponto)?`
const EDGE = String.raw`(?![\p{L}\p{M}\d]|[.,]\d|\s+(?:parcelas?|itens?|reais?|contos?|pessoas?|compras?|vezes|km|litros?|centavos?|corridas?)\b)`
const RANGE = new RegExp(String.raw`\b(?:das\s+${CLOCK}\s+(?:[àa]s|at[ée])|entre\s+${CLOCK}\s+e)\s+${CLOCK}${EDGE}`, 'giu')
const RANGE_UNIT = new RegExp(String.raw`\bhoras?\b|\d\s*(?:h\b|h\d|:\d)|\bda\s+(?:${PART_OF_DAY})\b`, 'i')
const ALTERNATIVE = new RegExp(String.raw`(?<![\p{L}\p{M}])[àa]s\s+${CLOCK}${EDGE}\s+ou\s+(?:[àa]s\s+)?${CLOCK}${EDGE}`, 'giu')
const APPROXIMATE = new RegExp(String.raw`\bpor\s+volta\s+das\s+${CLOCK}${EDGE}`, 'giu')
const POINT = new RegExp(String.raw`(?<![\p{L}\p{M}])[àa]s\s+(${CLOCK})${EDGE}`, 'giu')
const POINT_FIELDS = new RegExp(String.raw`^(${HOUR})(?:\s*(?::|h)\s*(\d{1,2})|\s*h\b|\s+e\s+(${MINUTE})|\s+horas?\b)?(?:\s+da\s+(${PART_OF_DAY}))?(?:\s+em\s+ponto)?$`, 'i')

const numeric = (text: string): number => {
  if (/^uma?$/i.test(text)) return 1
  if (/^duas$/i.test(text)) return 2
  const literal = normalizeNumberWords(text).text.trim()
  return /^\d+$/.test(literal) ? Number(literal) : NaN
}

function readPoint(token: string): string | undefined {
  const point = token.match(POINT_FIELDS)
  if (!point) return undefined
  const [, rawHours, digitMinutes, spokenMinutes, partOfDay] = point
  let hour = numeric(rawHours)
  const minute = spokenMinutes?.toLowerCase() === 'meia' ? 30 : numeric(digitMinutes || spokenMinutes || '0')
  if (partOfDay) {
    if (!(hour >= 1 && hour <= 12)) return undefined
    if (hour < 12 && /^(?:tarde|noite)$/i.test(partOfDay)) hour += 12
    if (hour === 12 && /^(?:noite|madrugada)$/i.test(partOfDay)) hour = 0
  }
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  return isCashClock(clock) ? clock : undefined
}

export function spokenClock(text: string): { remaining: string; time?: string; invalid?: boolean; range?: boolean } {
  let range = false
  const withoutRange = text.replace(RANGE, match => {
    if (/^entre\b/i.test(match) && !RANGE_UNIT.test(match)) return match
    range = true
    return ' '
  })
  const times: string[] = []
  let invalid = false
  const stripUncertain = () => { invalid = true; return ' ' }
  const remaining = withoutRange.replace(ALTERNATIVE, stripUncertain).replace(APPROXIMATE, stripUncertain).replace(POINT, (_full, point: string) => {
    const time = readPoint(point)
    if (time) times.push(time)
    else invalid = true
    return ' '
  })
  if (!range && !invalid && !times.length) return { remaining: text }
  const unique = [...new Set(times)]
  return { remaining: remaining.replace(/\s{2,}/g, ' ').trim(), time: !range && unique.length === 1 ? unique[0] : undefined,
    invalid: invalid || unique.length > 1 || undefined, range: range || undefined }
}
