import { isCashClock } from '../contracts'
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
export const COMPOUND_DURATION = String.raw`(?:meia\s+hora|\d{1,2}\s*h\s*\d{1,2}|${HOUR}\s*(?:horas?|h)\s+e\s+(?:meia|${MINUTE}(?:\s+min(?:utos?)?\b|(?=\s*[,.;!?]|$))))`
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

export function elapsedMinutes(token: string): number | undefined {
  const t = token.toLowerCase().replace(/\s+/g, ' ').trim()
  if (/^meia hora$/.test(t)) return 30
  const compound = t.match(/^(\d{1,2})\s*h\s*(\d{1,2})$/)
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
