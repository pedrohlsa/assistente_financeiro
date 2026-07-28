// Datas e períodos ditos em pt-BR.
//
// PRINCÍPIO: nunca deslocar a data de um lançamento por suposição. Quando a
// frase admite mais de uma leitura ("dia 5" no dia 3 pode ser deste mês ou do
// mês passado), o resultado é marcado como AMBÍGUO e o assistente pergunta.
// A data interpretada é sempre exibida antes da confirmação.

import { addDays, fromISO, toISO, todayISO, dateForDayOfMonth } from '../utils/format'
import { weekdayName } from '../utils/text'

export type DateResolution =
  /** Data única e sem dúvida. */
  | { kind: 'date'; date: string; label: string; text: string; start: number; end: number }
  /** Precisa de escolha do usuário antes de virar lançamento. */
  | { kind: 'ambiguous'; question: string; options: { label: string; value: string }[]; text: string; start: number; end: number }
  /** Intervalo — serve para pergunta/relatório, nunca para datar um lançamento. */
  | { kind: 'period'; from: string; to: string; label: string; text: string; start: number; end: number }
  /** Data no futuro: válida para previsão, inválida para um fato já ocorrido. */
  | { kind: 'future'; date: string; label: string; text: string; start: number; end: number }

const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]
const MONTH_RE = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'

const WEEKDAY_RE = 'domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|sabado'

const weekdayIndex = (w: string): number => {
  const s = w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (s.startsWith('dom')) return 0
  if (s.startsWith('seg')) return 1
  if (s.startsWith('ter')) return 2
  if (s.startsWith('quar')) return 3
  if (s.startsWith('quin')) return 4
  if (s.startsWith('sex')) return 5
  return 6
}

const monthIndex = (m: string): number => {
  const s = m.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return MONTHS.findIndex(x => x.normalize('NFD').replace(/[̀-ͯ]/g, '') === s)
}

/** "24/07/2026" a partir de um ISO, para mostrar a data interpretada. */
export const brDate = (iso: string): string => fromISO(iso).toLocaleDateString('pt-BR')

/** Rótulo amigável: "hoje", "ontem" ou "sexta-feira, 24/07/2026". */
export function dateLabel(iso: string, today = todayISO()): string {
  if (iso === today) return 'hoje'
  if (iso === addDays(today, -1)) return 'ontem'
  if (iso === addDays(today, -2)) return 'anteontem'
  if (iso === addDays(today, 1)) return 'amanhã'
  return `${weekdayName(fromISO(iso).getDay()).toLowerCase()}, ${brDate(iso)}`
}

/** Ocorrência mais recente (no passado, incluindo hoje) de um dia da semana. */
function lastWeekday(target: number, today: string): string {
  const d = fromISO(today)
  let back = (d.getDay() - target + 7) % 7
  if (back === 0) back = 7 // "na segunda" dito numa segunda = a segunda anterior
  return addDays(today, -back)
}

/** Próxima ocorrência (no futuro, incluindo hoje) de um dia da semana. */
function nextWeekday(target: number, today: string): string {
  const d = fromISO(today)
  const fwd = (target - d.getDay() + 7) % 7
  return addDays(today, fwd)
}

interface Rule {
  re: RegExp
  build: (m: RegExpMatchArray, today: string) => Omit<DateResolution, 'text' | 'start' | 'end'> | null
}

// A ORDEM importa: expressões mais específicas primeiro, senão "segunda-feira
// passada" seria consumida por "segunda-feira".
const RULES: Rule[] = [
  {
    re: /\banteontem\b/i,
    build: (_m, t) => ({ kind: 'date', date: addDays(t, -2), label: 'anteontem' }),
  },
  {
    re: /\b(?:ontem|ontm)\b/i,
    build: (_m, t) => ({ kind: 'date', date: addDays(t, -1), label: 'ontem' }),
  },
  {
    // "hj" é como se escreve "hoje" no celular. Sem isto a abreviação sobrava
    // dentro da descrição do lançamento ("Cimento hj").
    re: /\b(?:hoje|hj|hje)\b/i,
    build: (_m, t) => ({ kind: 'date', date: t, label: 'hoje' }),
  },
  {
    re: /\bamanh[ãa]\b/i,
    build: (_m, t) => ({ kind: 'future', date: addDays(t, 1), label: 'amanhã' }),
  },
  {
    re: /\bdepois\s+de\s+amanh[ãa]\b/i,
    build: (_m, t) => ({ kind: 'future', date: addDays(t, 2), label: 'depois de amanhã' }),
  },
  {
    // "semana passada", "na semana passada"
    re: /\b(?:na\s+)?semana\s+passada\b/i,
    build: (_m, t) => ({ kind: 'period', from: addDays(t, -13), to: addDays(t, -7), label: 'semana passada' }),
  },
  {
    re: /\b(?:no\s+)?m[eê]s\s+passado\b/i,
    build: (_m, t) => {
      const d = fromISO(t)
      const first = new Date(d.getFullYear(), d.getMonth() - 1, 1)
      const last = new Date(d.getFullYear(), d.getMonth(), 0)
      return { kind: 'period', from: toISO(first), to: toISO(last), label: 'mês passado' }
    },
  },
  {
    // "10/08", "10/08/2026", "10-08"
    re: /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/,
    build: (m, t) => {
      const day = Number(m[1]); const mon = Number(m[2])
      if (day < 1 || day > 31 || mon < 1 || mon > 12) return null
      let year = m[3] ? Number(m[3]) : fromISO(t).getFullYear()
      if (year < 100) year += 2000
      const iso = toISO(dateForDayOfMonth(year, mon - 1, day))
      if (fromISO(iso).getDate() !== day) return null
      return iso > t
        ? { kind: 'future', date: iso, label: brDate(iso) }
        : { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "10 de agosto", "10 de agosto de 2026"
    re: new RegExp(String.raw`\b(\d{1,2})\s+de\s+(${MONTH_RE})(?:\s+de\s+(\d{4}))?\b`, 'i'),
    build: (m, t) => {
      const day = Number(m[1])
      const mon = monthIndex(m[2])
      if (mon < 0 || day < 1 || day > 31) return null
      const year = m[3] ? Number(m[3]) : fromISO(t).getFullYear()
      const iso = toISO(dateForDayOfMonth(year, mon, day))
      // Sem ano explícito e no futuro: quase sempre o usuário fala do ano passado.
      if (!m[3] && iso > t) {
        const prev = toISO(dateForDayOfMonth(year - 1, mon, day))
        return {
          kind: 'ambiguous',
          question: `${day} de ${MONTHS[mon]} de qual ano?`,
          options: [
            { label: `${brDate(prev)}`, value: prev },
            { label: `${brDate(iso)} (futuro)`, value: iso },
          ],
        }
      }
      return { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "dia 5 do mês passado"
    re: /\bdia\s+(\d{1,2})\s+d[oe]\s+m[eê]s\s+passado\b/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return null
      const d = fromISO(t)
      const iso = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() - 1, day))
      return { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "dia 5 deste mês"
    re: /\bdia\s+(\d{1,2})\s+d(?:este|esse)\s+m[eê]s\b/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return null
      const d = fromISO(t)
      const iso = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth(), day))
      return iso > t ? { kind: 'future', date: iso, label: brDate(iso) } : { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "na segunda passada", "sexta-feira passada"
    re: new RegExp(String.raw`\b(?:n[ao]\s+)?(${WEEKDAY_RE})(?:-feira)?\s+passad[ao]\b`, 'i'),
    build: (m, t) => {
      const iso = lastWeekday(weekdayIndex(m[1]), t)
      return { kind: 'date', date: iso, label: `${weekdayName(fromISO(iso).getDay()).toLowerCase()}, ${brDate(iso)}` }
    },
  },
  {
    // "na sexta", "sexta-feira", "segunda que vem"
    re: new RegExp(String.raw`\b(?:n[ao]\s+)?(${WEEKDAY_RE})(?:-feira)?(\s+que\s+vem)?\b`, 'i'),
    build: (m, t) => {
      const idx = weekdayIndex(m[1])
      if (m[2]) {
        const iso = nextWeekday(idx, t)
        return { kind: 'future', date: iso, label: `${weekdayName(idx).toLowerCase()}, ${brDate(iso)}` }
      }
      const iso = lastWeekday(idx, t)
      return { kind: 'date', date: iso, label: `${weekdayName(idx).toLowerCase()}, ${brDate(iso)}` }
    },
  },
  {
    // "dia 5" seco — a leitura depende de onde estamos no mês.
    re: /\bdia\s+(\d{1,2})\b(?!\s*(?:de\s|d[oe]\s|\/))/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return null
      const d = fromISO(t)
      const thisMonth = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth(), day))
      if (thisMonth <= t) return { kind: 'date', date: thisMonth, label: brDate(thisMonth) }
      // Ainda não chegou neste mês: pode ser o mês passado ou uma previsão.
      const lastMonth = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() - 1, day))
      return {
        kind: 'ambiguous',
        question: `O dia ${day} deste mês ainda não chegou. Você quis dizer qual data?`,
        options: [
          { label: `Dia ${day} do mês passado (${brDate(lastMonth)})`, value: lastMonth },
          { label: `Dia ${day} deste mês (${brDate(thisMonth)})`, value: thisMonth },
        ],
      }
    },
  },
]

/**
 * Primeira expressão de data encontrada no texto. Devolve `null` quando a frase
 * não fala de data nenhuma — nesse caso o chamador usa "hoje", como sempre foi.
 */
export function findDate(text: string, today = todayISO()): DateResolution | null {
  let best: DateResolution | null = null
  for (const rule of RULES) {
    const m = text.match(rule.re)
    if (!m || m.index === undefined) continue
    const built = rule.build(m, today)
    if (!built) continue
    const res = { ...built, text: m[0], start: m.index, end: m.index + m[0].length } as DateResolution
    // A expressão mais à ESQUERDA vence: é a que o usuário disse primeiro.
    if (!best || res.start < best.start) best = res
  }
  return best
}

/** Todas as expressões de data do texto, sem sobreposição, da esquerda pra direita. */
export function findAllDates(text: string, today = todayISO()): DateResolution[] {
  const out: DateResolution[] = []
  const taken: [number, number][] = []
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g'))) {
      if (m.index === undefined) continue
      const start = m.index; const end = start + m[0].length
      if (taken.some(([a, b]) => start < b && end > a)) continue
      const built = rule.build(m, today)
      if (!built) continue
      taken.push([start, end])
      out.push({ ...built, text: m[0], start, end } as DateResolution)
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
