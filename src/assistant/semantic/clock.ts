import { isCashClock } from '../contracts'
import { addDays } from '../../utils/format'
import { findAllDates, readNightShiftRange } from '../dates'
import { normalizeNumberWords } from '../numbers'

const UNIT = 'um[a]?|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove'
const SMALL = `${UNIT}|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove`
const HOUR = String.raw`(?:\d{1,2}|vinte(?:\s+e\s+(?:${UNIT}))?|${SMALL})`
const MINUTE = String.raw`(?:\d{1,2}|meia|(?:vinte|trinta|quarenta|cinquenta)(?:\s+e\s+(?:${UNIT}))?|${SMALL})`
const PART_OF_DAY = 'manh[ãa]|tarde|noite|madrugada'
const SPOKEN_MINUTE = String.raw`\s+(?:horas?\s+)?e\s+(${MINUTE})(?:\s+minutos?\b)?`
const CLOCK = String.raw`${HOUR}(?:\s*(?::|h)\s*\d{1,2}|\s*h\b|${SPOKEN_MINUTE}|\s+horas?\b)?(?:\s+da\s+(?:${PART_OF_DAY}))?(?:\s+em\s+ponto)?`
const EDGE = String.raw`(?![\p{L}\p{M}\d]|[.,]\d|\s+(?:parcelas?|itens?|reais?|contos?|pessoas?|compras?|vezes|km|litros?|centavos?|corridas?)\b)`
const RANGE = new RegExp(String.raw`\b(?:das\s+${CLOCK}\s+(?:[àa]s|at[ée])|entre\s+${CLOCK}\s+e)\s+${CLOCK}${EDGE}`, 'giu')
const RANGE_UNIT = new RegExp(String.raw`\bhoras?\b|\d\s*(?:h\b|h\d|:\d)|\bda\s+(?:${PART_OF_DAY})\b`, 'i')
const ALTERNATIVE = new RegExp(String.raw`(?<![\p{L}\p{M}])[àa]s\s+${CLOCK}${EDGE}\s+ou\s+(?:[àa]s\s+)?${CLOCK}${EDGE}`, 'giu')
const APPROXIMATE = new RegExp(String.raw`\bpor\s+volta\s+das\s+${CLOCK}${EDGE}`, 'giu')
const POINT = new RegExp(String.raw`(?<![\p{L}\p{M}])[àa]s\s+(${CLOCK})${EDGE}`, 'giu')
// "Ao meio-dia" e "à meia-noite" exigem a preposição: "trabalhei meio dia"
// é METADE de um dia, não 12h.
const NOON = /(?<![\p{L}\p{M}])(?:ao|à|a|ah)\s+(meio[\s-]?dia|meia[\s-]?noite)(?:\s+e\s+(meia|\d{1,2}|quinze|vinte|trinta|quarenta|quarenta\s+e\s+cinco))?(?:\s+minutos?)?(?![\p{L}\p{M}\d])/giu
// "Faz meia hora", "há 20 minutos", "tem uma hora": hora RELATIVA à fala.
const APPROX_DURATION = String.raw`(?:uns|umas|mais\s+ou\s+menos|cerca\s+de)\s+`
export const COMPOUND_DURATION = String.raw`(?:meia\s+hora|\d{1,2}\s*h\s*\d{1,2}(?:\s*min(?:utos?)?)?|${HOUR}\s*(?:horas?|h)\s+e\s+(?:meia|${MINUTE}(?:\s+min(?:utos?)?\b|(?=\s*[,.;!?]|$))))`
const ELAPSED = String.raw`(?:${COMPOUND_DURATION}|(?:\d{1,3}|${MINUTE})\s*(?:min(?:utos?)?|h(?:oras?)?))`
const AGO_PREFIX = new RegExp(String.raw`(?<![\p{L}\p{M}])(?:faz|h[áa]|tem)\s+(${APPROX_DURATION})?(${ELAPSED})(\s+e\s+(?:pouco|poucos|minutinhos))?(?:\s+atr[aá]s)?(?![\p{L}\p{M}\d])`, 'giu')
const AGO_SUFFIX = new RegExp(String.raw`(?<![\p{L}\p{M}\d])(?:\b(${APPROX_DURATION}))?(${ELAPSED})(\s+e\s+(?:pouco|poucos|minutinhos))?\s+atr[aá]s\b`, 'giu')
const POINT_FIELDS = new RegExp(String.raw`^(${HOUR})(?:\s*(?::|h)\s*(\d{1,2})|\s*h\b|${SPOKEN_MINUTE}|\s+horas?\b)?(?:\s+da\s+(${PART_OF_DAY}))?(?:\s+em\s+ponto)?$`, 'i')

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

const CLOCKED_SHIFT_START = /(?<![\p{L}\p{M}])(?:comecei|iniciei|sa[ií]|trabalhei|rodei|fiz\s+das)(?![\p{L}\p{M}])/iu
const CLOCKED_SHIFT_END = /\s+(?:e\s+)?(?:(vou)\s+)?(?:terminei|terminar|parei|parar|encerrei|encerrar|at[eé])\s+/i
const END_OF_SHIFT_CLOCK = /[,;]\s*|\s+e\s+(?=(?:eu\s+)?(?:ganhei|fiz|recebi|faturei|paguei|abasteci|rodei|foram|deu)\b)/i
const SHIFT_SCOPE_AFTER_CLOCK = /\s+(?=de\s+[^,;.?!]{1,52}?\s+(?:pra|para)\s+)/i
const SPLIT_AT_MIDNIGHT = /^\s*(?:(ontem|anteontem)\s+)?(?:rodei|trabalhei)\s+(.+?)\s+antes\s+da\s+meia[-\s]noite\s+e\s+(.+?)\s+depois(?:\s+da\s+meia[-\s]noite)?(?:\s*,\s*(.+))?[.!]*$/i

type DatedShiftWork =
  | { kind: 'invalid' | 'future' }
  | { kind: 'work'; window: { from: string; to: string }; minutes: { date: string; total: number }[]; rest: string; endTime?: string }

function datedClockPoint(text: string, today: string) {
  const dates = findAllDates(text, today)
  const [d] = dates
  if (dates.length !== 1 || (d.kind !== 'date' && d.kind !== 'future')) return undefined
  const withoutDate = `${text.slice(0, d.start).trimEnd().replace(/\s+(?:de|em|no|na)\s*$/i, '')} ${text.slice(d.end)}`.trim().replace(/\s+/g, ' ')
  const clock = withoutDate.replace(/^(?:ness[ae]\s+jornada\s+)?(?:(?:comecei|iniciei|sa[ií]|trabalhei|rodei)\s+)?(?:(?:a\s+partir\s+das|das|[àa]s?)\s+)?/i, '')
  const time = readPoint(clock)
  return time ? { date: d.date, time, future: d.kind === 'future' } : undefined
}

function datedWorkMinutes(window: { from: string; to: string }, start: string, end: string, rest: string): DatedShiftWork {
  const clockMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const begin = clockMinutes(start), finish = clockMinutes(end)
  const spansMidnight = window.from !== window.to
  if ((spansMidnight && addDays(window.from, 1) !== window.to) || (!spansMidnight && finish <= begin)) return { kind: 'invalid' }
  const first = (spansMidnight ? 1440 : finish) - begin
  const second = spansMidnight ? finish : 0
  if (first + second > 20 * 60) return { kind: 'invalid' }
  const minutes = [{ date: window.from, total: first }, { date: window.to, total: second }].filter(item => item.total > 0)
  return { kind: 'work', window, minutes, rest, endTime: end }
}

/** Jornadas com data em cada ponta e relatos que já dizem as horas de cada lado da meia-noite. */
export function readDatedShiftWork(text: string, today: string): DatedShiftWork | undefined {
  if (!CLOCKED_SHIFT_START.test(text)) return undefined
  const message = text.trim().replace(/[.!]+$/, '')
  const scopeAtStart = readNightShiftRange(message, today)
  const split = (scopeAtStart?.rest || message).match(SPLIT_AT_MIDNIGHT)
  if (split && (scopeAtStart?.window || split[1])) {
    const from = scopeAtStart?.window?.from || addDays(today, /^anteontem$/i.test(split[1]) ? -2 : -1)
    const to = scopeAtStart?.window?.to || addDays(from, 1)
    const early = elapsedMinutes(split[2]), late = elapsedMinutes(split[3])
    if (!(early > 0 && late > 0 && early + late <= 20 * 60)) return { kind: 'invalid' }
    return { kind: 'work', window: { from, to }, minutes: [{ date: from, total: early }, { date: to, total: late }], rest: split[4] || '' }
  }
  if (/^(?:fiz|trabalhei|rodei)\s+das\b/i.test(message)) {
    const location = message.search(SHIFT_SCOPE_AFTER_CLOCK)
    if (location < 0) return undefined
    const scope = readNightShiftRange(message.slice(location), today)
    const { span } = spokenClock(message.slice(0, location))
    if (scope && span) return scope.window ? datedWorkMinutes(scope.window, span.start, span.end, scope.rest.replace(/^e\s+/i, '')) : { kind: 'invalid' }
  }
  const end = message.match(CLOCKED_SHIFT_END)
  if (!end) return undefined
  const startText = message.slice(0, end.index)
  if (!CLOCKED_SHIFT_START.test(startText) || findAllDates(message, today).length < 2) return undefined
  const after = message.slice(end.index + end[0].length)
  const separator = after.match(END_OF_SHIFT_CLOCK)
  const endText = separator ? after.slice(0, separator.index) : after
  const rest = separator ? after.slice(separator.index + separator[0].length).trim() : ''
  const started = datedClockPoint(startText, today), ended = datedClockPoint(endText, today)
  if (!started || !ended) return undefined
  if (end[1] || started.future || ended.future) return { kind: 'future' }
  return datedWorkMinutes({ from: started.date, to: ended.date }, started.time, ended.time, rest)
}

export function elapsedMinutes(token: string): number | undefined {
  const t = token.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^meia hora$/.test(t)) return 30
  const compound = t.match(/^(\d{1,2})\s*h\s*(\d{1,2})(?:\s*min(?:utos?)?)?$/)
    || t.match(/^(.+?)\s*(?:horas?|h)\s+e\s+(.+?)(?:\s+min(?:utos?)?)?$/)
  if (compound) {
    const hours = numeric(compound[1])
    const extra = compound[2] === 'meia' ? 30 : numeric(compound[2])
    const total = hours * 60 + extra
    return extra >= 0 && extra < 60 && total > 0 && total <= 1440 ? total : undefined
  }
  const m = t.match(/^(\d{1,3}|\S+)\s*(min(?:utos?)?|h(?:oras?)?)$/)
  if (!m) return undefined
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : numeric(m[1])
  if (!(n > 0)) return undefined
  const minutos = m[2].startsWith('h') ? n * 60 : n
  return minutos <= 24 * 60 ? minutos : undefined
}

const WORK_DURATION = new RegExp(
  String.raw`(?:\b(?:trabalhei|fiquei|rodei|andei|dirigi|percorri)(?:\s+(?:por|durante))?|(?<=[\d\s])(?:km|quil[oô]metros?|viagem|viagens|corridas?)\s+(?:em|durante|e)|\b(?:fiz|ganhei|faturei|tirei)\s+(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?\s+(?:em|durante))\s+(${COMPOUND_DURATION}|(?:\d{1,3}|${MINUTE})\s*min(?:utos?)?)(?![\p{L}\p{M}\d]|[.,]\d)`,
  'iu',
)

/** Duração de trabalho ligada a um verbo ou a uma medida da jornada. */
export function workDuration(text: string): { remaining: string; minutes?: number; invalid?: boolean } {
  const span = text.match(WORK_DURATION)
  if (!span) return { remaining: text }
  const end = span.index + span[0].length
  const start = end - span[1].length
  const worked = /\b(?:trabalhei|fiquei|rodei|andei|dirigi|percorri|fiz|realizei|completei|ganhei|faturei|tirei)\b/i.test(text.slice(0, start))
  const minutes = worked ? elapsedMinutes(span[1]) : undefined
  return { remaining: text.slice(0, start) + ' ' + text.slice(end), minutes, invalid: worked && minutes === undefined }
}

export function spokenClock(text: string): {
  remaining: string; time?: string; invalid?: boolean; range?: boolean
  /** Hora relativa à fala ("faz meia hora"): quem chama resolve com o relógio. */
  minutesAgo?: number
  /** "Das 9h às 13h": início e fim legíveis de UMA faixa — um turno, não um horário. */
  span?: { start: string; end: string }
} {
  let range = false
  const spans: { start: string; end: string }[] = []
  const withoutRange = text.replace(RANGE, match => {
    if (/^entre\b/i.test(match) && !RANGE_UNIT.test(match)) return match
    range = true
    const partes = match.replace(/^das\s+/i, '').split(/\s+(?:[àa]s|at[ée])\s+/i)
    if (/^das\s/i.test(match) && partes.length === 2) {
      const start = readPoint(partes[0].trim())
      const end = readPoint(partes[1].trim())
      if (start && end) spans.push({ start, end })
    }
    return ' '
  })
  const times: string[] = []
  let invalid = false
  const agos: number[] = []
  const stripUncertain = () => { invalid = true; return ' ' }
  const stripElapsed = (_full: string, approx: string | undefined, quanto: string, uncertain: string | undefined) => {
    const minutes = elapsedMinutes(quanto)
    if (approx || uncertain || minutes === undefined) invalid = true
    else agos.push(minutes)
    return ' '
  }
  const remaining = withoutRange.replace(ALTERNATIVE, stripUncertain).replace(APPROXIMATE, stripUncertain)
    .replace(NOON, (_full, quando: string, mais?: string) => {
      const base = /^meio/i.test(quando) ? 12 : 0
      const minuto = !mais ? 0 : /^meia$/i.test(mais) ? 30 : /^\d+$/.test(mais) ? Number(mais) : numeric(mais.replace(/\s+e\s+/g, ' e '))
      if (!(minuto >= 0 && minuto < 60)) { invalid = true; return ' ' }
      times.push(`${String(base).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`)
      return ' '
    })
    .replace(AGO_PREFIX, stripElapsed).replace(AGO_SUFFIX, stripElapsed)
    .replace(POINT, (_full, point: string) => {
      const time = readPoint(point)
      if (time) times.push(time)
      else invalid = true
      return ' '
    })
  if (!range && !invalid && !times.length && !agos.length) return { remaining: text }
  const unique = [...new Set(times)]
  // Hora dita E hora relativa na mesma frase: não há como escolher.
  const conflito = unique.length > 0 && agos.length > 0
  const minutesAgo = !conflito && !range && !unique.length && new Set(agos).size === 1 ? agos[0] : undefined
  return { remaining: remaining.replace(/\s{2,}/g, ' ').trim(), time: !range && !conflito && unique.length === 1 ? unique[0] : undefined,
    invalid: invalid || unique.length > 1 || conflito || new Set(agos).size > 1 || undefined, range: range || undefined,
    ...(minutesAgo !== undefined ? { minutesAgo } : {}),
    ...(spans.length === 1 ? { span: spans[0] } : {}) }
}
