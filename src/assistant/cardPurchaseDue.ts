import { dateForDayOfMonth, fromISO, toISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { dateAnswerCorrection, dateInAnswer, findDate } from './dates'
import { findNumberWords, normalizeNumberWords } from './numbers'

const MARKER = /(?<![\p{L}\p{M}])(?:com\s+)?(?:(?:o\s+)?(?:primeiro|1[ºo°])\s+vencimento|(?:a\s+)?(?:primeira|1[ªa°])\s*(?:parcela\s+(?:(?:vai\s+)?vence[r]?|(?:tem|com)\s+vencimento)|parcela\s+fica\s+para))(?![\p{L}\p{M}])\s*(?:[:=]\s*|(?:[ée]|ser[áa]|para)\s+)?/iu
const PREP_DATE = /^(?:(?:foi|era|e|para)(?:\s+|$))?(?:em|no|na)?$/i

/** Separa o vencimento expresso da data em que a compra aconteceu. */
export function readCardPurchaseDue(text: string, today: string) {
  const marker = text.match(MARKER)
  if (!marker) return undefined
  const tail = text.slice(marker.index + marker[0].length)
  const date = findDate(tail, today)
  const saidDay = findNumberWords(tail).find(n => !n.explicitMoney && /^dia\s+$/i.test(tail.slice(0, n.start)))
  const hasDate = date && PREP_DATE.test(normalizeName(tail.slice(0, date.start)))
  const knownEnd = hasDate ? date.end : saidDay?.end
  const choice = knownEnd === undefined ? undefined : tail.slice(knownEnd).match(/^\s+ou\s+(?:talvez\s+)?(?:dia\s+)?\d+(?:[/-]\d+){0,2}\b/i)
  const end = knownEnd === undefined
    ? tail.match(/^[^,;.!?]*?(?=\s+e\s+(?:paguei|gastei|recebi|comprei|passei)\b|[,;.!?]|$)/i)?.[0].length ?? 0
    : knownEnd + (choice?.[0].length || 0)
  const before = text.slice(0, marker.index).replace(/(?:[\s,;.!]+|\s+e)\s*$/i, '').trim()
  const after = tail.slice(end).replace(/^[,\s]+/, '').trim()
  return { before, after, message: [before, after].filter(Boolean).join(' '), answer: tail.slice(0, end).trim() }
}

export function resolveCardPurchaseDue(answer: string, purchaseDate: string, today: string): string | undefined {
  const affirmed = dateAnswerCorrection(answer, today)?.text ?? answer
  const normalized = normalizeName(normalizeNumberWords(affirmed).text)
  const bare = normalized.match(/^(?:(?:foi|era|e|para)\s+)?(?:no\s+)?(?:dia\s+)?(\d{1,2})[.!]*$/)
  if (bare) {
    const day = Number(bare[1])
    if (day < 1 || day > 31) return undefined
    const from = fromISO(purchaseDate)
    for (let i = 0; i < 3; i++) {
      const candidate = dateForDayOfMonth(from.getFullYear(), from.getMonth() + i, day)
      const iso = toISO(candidate)
      if (candidate.getDate() === day && iso >= purchaseDate) return iso
    }
    return undefined
  }
  const date = dateInAnswer(answer, today) || dateInAnswer(normalized, today)
  if (date && !(date.kind === 'future' && date.imprecise) && date.date >= purchaseDate) return date.date
  const ambiguous = findDate(normalized, today)
  if (ambiguous?.kind !== 'ambiguous' || !PREP_DATE.test(normalized.slice(0, ambiguous.start).trim())
    || !/^[.!]*$/.test(normalized.slice(ambiguous.end).trim())) return undefined
  const plausible = ambiguous.options.filter(option => option.value >= purchaseDate)
  return plausible.length === 1 ? plausible[0].value : undefined
}
