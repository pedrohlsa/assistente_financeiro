// Datas e períodos ditos em pt-BR.
//
// PRINCÍPIO: nunca deslocar a data de um lançamento por suposição. Quando a
// frase admite mais de uma leitura ("dia 5" no dia 3 pode ser deste mês ou do
// mês passado), o resultado é marcado como AMBÍGUO e o assistente pergunta.
// A data interpretada é sempre exibida antes da confirmação.

import { addDays, fromISO, toISO, todayISO, dateForDayOfMonth } from '../utils/format'
import { normalizeName, weekdayName } from '../utils/text'
import { isPlausibleDate } from './contracts'

export type DateResolution =
  /** Data única e sem dúvida. */
  | { kind: 'date'; date: string; label: string; text: string; start: number; end: number }
  /** Precisa de escolha do usuário antes de virar lançamento. */
  | { kind: 'ambiguous'; question: string; options: { label: string; value: string }[]; text: string; start: number; end: number }
  /** Intervalo — serve para pergunta/relatório, nunca para datar um lançamento. */
  | { kind: 'period'; from: string; to: string; label: string; text: string; start: number; end: number }
  /** A expressão parece uma data, mas o calendário prova que ela não existe. */
  | { kind: 'invalid'; question: string; label: string; text: string; start: number; end: number }
  /**
   * Data no futuro: válida para previsão, inválida para um fato já ocorrido.
   * `relative` marca as formas contadas a partir de hoje ("daqui a 3 dias",
   * "em 2 semanas") — só elas podem colidir com um PRAZO ("em 6 meses" de uma
   * meta), e quem desempata é `clauses.ts`.
   */
  | { kind: 'future'; date: string; label: string; relative?: boolean; imprecise?: boolean; text: string; start: number; end: number }

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

/** Próxima ocorrência estritamente futura de um dia da semana. */
function nextWeekday(target: number, today: string): string {
  const d = fromISO(today)
  let fwd = (target - d.getDay() + 7) % 7
  if (fwd === 0) fwd = 7
  return addDays(today, fwd)
}

interface Rule {
  re: RegExp
  build: (m: RegExpMatchArray, today: string) => Omit<DateResolution, 'text' | 'start' | 'end'> | null
}

/** Quantidades escritas por extenso que aparecem em prazo falado. */
// MAPA, nao objeto: a leitura por colchete anda pela cadeia de prototipo, e
// uma palavra como "constructor" devolveria uma FUNCAO no lugar de um numero.
const SMALL_WORDS = new Map<string, number>(Object.entries({
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15,
  vinte: 20, trinta: 30,
}))
const COUNT_RE = `\\d{1,3}|tr[êe]s|${[...SMALL_WORDS.keys()].join('|')}`
const UNIT_RE = String.raw`dias?|semanas?|m[eê]s(?:es)?|anos?`

const countOf = (raw: string): number => {
  const n = Number(raw)
  if (Number.isFinite(n)) return n
  return SMALL_WORDS.get(raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()) ?? NaN
}

/** Soma `n` unidades a partir de `today`, preservando o dia em meses curtos. */
function addUnits(today: string, n: number, unit: string): string {
  const u = unit.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const d = fromISO(today)
  if (u.startsWith('dia')) return addDays(today, n)
  if (u.startsWith('semana')) return addDays(today, n * 7)
  if (u.startsWith('ano')) return toISO(dateForDayOfMonth(d.getFullYear() + n, d.getMonth(), d.getDate()))
  return toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() + n, d.getDate()))
}

const invalidDate = (raw: string): Omit<Extract<DateResolution, { kind: 'invalid' }>, 'text' | 'start' | 'end'> => ({
  kind: 'invalid',
  label: 'data inválida',
  question: `A data "${raw.trim()}" não existe. Qual foi a data correta?`,
})

function startOfNextWeek(today: string): string {
  const d = fromISO(today)
  const days = d.getDay() === 0 ? 1 : 8 - d.getDay()
  return addDays(today, days)
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
    // `\b` NÃO funciona depois de letra acentuada: em JS o "ã" não é caractere
    // de palavra, então `/amanh[ãa]\b/` casava só a grafia sem til e "amanhã"
    // escrito certo era ignorado em silêncio. O lookahead resolve.
    re: /\bamanh[ãa](?![\wà-úÀ-Ú])/i,
    build: (_m, t) => ({ kind: 'future', date: addDays(t, 1), label: 'amanhã', relative: true }),
  },
  {
    re: /\bdepois\s+de\s+amanh[ãa](?![\wà-úÀ-Ú])/i,
    build: (_m, t) => ({ kind: 'future', date: addDays(t, 2), label: 'depois de amanhã', relative: true }),
  },
  {
    // "HÁ dois dias", "faz 3 dias", "3 dias atrás": um dia EXATO, dito contando
    // para trás. Perguntava "qual foi a data correta?". Semanas, meses, anos e
    // o aproximado ("uns 5 dias") não apontam um dia só e continuam na barreira
    // de `findUnresolvedTemporalHint`.
    re: new RegExp(String.raw`(?<![\wÀ-ÿ])(?<!(?:uns|umas|uns\s+)\s)(?:h[áa]|faz)\s+(${COUNT_RE})\s+(dias?)(?![\wÀ-ÿ])(?!\s+atr[áa]s)|(?<![\wÀ-ÿ])(?<!(?:uns|umas)\s)(${COUNT_RE})\s+(dias?)\s+atr[áa]s(?![\wÀ-ÿ])`, 'i'),
    build: (m, t) => {
      const n = countOf(m[1] || m[3])
      if (!Number.isFinite(n) || n <= 0 || n > 600) return null
      const iso = addUnits(t, -n, m[2] || m[4])
      return iso > t ? null : { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "daqui a 3 dias", "daqui há duas semanas". Exige UNIDADE DE TEMPO: sem
    // isso "daqui a pouco" (aviso, não data) viraria lançamento datado.
    re: new RegExp(String.raw`\bdaqui\s+(?:a|h[áa])\s+(${COUNT_RE})\s+(${UNIT_RE})\b`, 'i'),
    build: (m, t) => {
      const n = countOf(m[1])
      if (!Number.isFinite(n) || n <= 0 || n > 600) return null
      const iso = addUnits(t, n, m[2])
      return { kind: 'future', date: iso, label: brDate(iso), relative: true }
    },
  },
  {
    // "em 3 dias", "em 2 semanas", "em 3 meses". A unidade de tempo é o que
    // separa isto de "em 4 vezes"/"em 3x", que são PARCELAS e nunca uma data.
    re: new RegExp(String.raw`\bem\s+(${COUNT_RE})\s+(${UNIT_RE})\b`, 'i'),
    build: (m, t) => {
      const n = countOf(m[1])
      if (!Number.isFinite(n) || n <= 0 || n > 600) return null
      const iso = addUnits(t, n, m[2])
      return { kind: 'future', date: iso, label: brDate(iso), relative: true }
    },
  },
  {
    re: /\b(?:na\s+)?(?:pr[óo]xima\s+semana|semana\s+que\s+vem)\b/i,
    build: (m, t) => ({
      kind: 'future', date: startOfNextWeek(t), label: m[0].trim(),
      relative: true, imprecise: true,
    }),
  },
  {
    re: /\b(?:no\s+)?(?:pr[óo]ximo\s+m[eê]s|m[eê]s\s+que\s+vem)\b/i,
    build: (m, t) => {
      const d = fromISO(t)
      return {
        kind: 'future',
        date: toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() + 1, 1)),
        label: m[0].trim(), relative: true, imprecise: true,
      }
    },
  },
  {
    re: /\b(?:no\s+)?(?:pr[óo]ximo\s+ano|ano\s+que\s+vem)\b/i,
    build: (m, t) => {
      const d = fromISO(t)
      return {
        kind: 'future',
        date: toISO(dateForDayOfMonth(d.getFullYear() + 1, 0, 1)),
        label: m[0].trim(), relative: true, imprecise: true,
      }
    },
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
    // ISO inteiro vem antes de DD-MM; interpretar só "11-10" de
    // "2026-11-10" trocava o dia e o mês.
    re: /\b(?:dia\s+)?(\d{4}-\d{2}-\d{2})\b/,
    build: (m, t) => {
      const iso = m[1]
      if (!isPlausibleDate(iso, t)) return invalidDate(m[0])
      return iso > t ? { kind: 'future', date: iso, label: brDate(iso) } : { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "10/08", "dia 10/08", "10/08/2026", "10-08". O "dia" entra na expressão
    // para ser retirado junto: sem isso a palavra sobrava e o lançamento
    // nascia descrito como "Mercado dia".
    re: /\b(?:dia\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/,
    build: (m, t) => {
      const day = Number(m[1]); const mon = Number(m[2])
      // "Paguei 1/3 DO aluguel", "1/2 da conta": fração de alguma coisa, não
      // data — virava 01/03, seis meses atrás. Com "dia" antes ou com o ano,
      // continua sendo data.
      const depois = (m.input || '').slice((m.index || 0) + m[0].length)
      if (!/^dia\b/i.test(m[0]) && !m[3] && /^\s+d[oa]s?\s/i.test(depois)) return null
      if (day < 1 || day > 31 || mon < 1 || mon > 12) return invalidDate(m[0])
      let year = m[3] ? Number(m[3]) : fromISO(t).getFullYear()
      if (year < 100) year += 2000
      const iso = toISO(dateForDayOfMonth(year, mon - 1, day))
      if (fromISO(iso).getDate() !== day) return invalidDate(m[0])
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
      if (mon < 0 || day < 1 || day > 31) return invalidDate(m[0])
      const year = m[3] ? Number(m[3]) : fromISO(t).getFullYear()
      const iso = toISO(dateForDayOfMonth(year, mon, day))
      if (fromISO(iso).getDate() !== day) return invalidDate(m[0])
      // Sem ano explícito e no futuro: quase sempre o usuário fala do ano passado.
      if (!m[3] && iso > t) {
        const prev = toISO(dateForDayOfMonth(year - 1, mon, day))
        return {
          kind: 'ambiguous',
          question: `${day} de ${MONTHS[mon]} de qual ano?`,
          options: [
            ...(fromISO(prev).getDate() === day ? [{ label: brDate(prev), value: prev }] : []),
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
      if (day < 1 || day > 31) return invalidDate(m[0])
      const d = fromISO(t)
      const iso = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() - 1, day))
      if (fromISO(iso).getDate() !== day) return invalidDate(m[0])
      return { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "dia 5 deste mês"
    re: /\bdia\s+(\d{1,2})\s+d(?:este|esse)\s+m[eê]s\b/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return invalidDate(m[0])
      const d = fromISO(t)
      const iso = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth(), day))
      if (fromISO(iso).getDate() !== day) return invalidDate(m[0])
      return iso > t ? { kind: 'future', date: iso, label: brDate(iso) } : { kind: 'date', date: iso, label: brDate(iso) }
    },
  },
  {
    // "Sábado RETRASADO": o da semana anterior à passada. Lido como o sábado
    // mais recente, o gasto entrava uma semana depois — e "Retrasado" ficava
    // na descrição.
    re: new RegExp(String.raw`\b(?:n[ao]\s+)?(${WEEKDAY_RE})(?:-feira)?\s+retrasad[ao](?![\wÀ-ÿ])`, 'i'),
    build: (m, t) => {
      const iso = addDays(lastWeekday(weekdayIndex(m[1]), t), -7)
      return { kind: 'date', date: iso, label: `${weekdayName(fromISO(iso).getDay()).toLowerCase()}, ${brDate(iso)}` }
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
        return { kind: 'future', date: iso, label: `${weekdayName(idx).toLowerCase()}, ${brDate(iso)}`, relative: true }
      }
      const iso = lastWeekday(idx, t)
      return { kind: 'date', date: iso, label: `${weekdayName(idx).toLowerCase()}, ${brDate(iso)}` }
    },
  },
  {
    // "até dia 22", "pro dia 10", "para o dia 5", "antes do dia 20": um PRAZO,
    // nunca um fato. É o próximo dia N — hoje mesmo, se for hoje; este mês, se
    // ainda não passou; senão o mês que vem. A regra do "dia N" seco, logo
    // abaixo, perguntava "o dia 22 deste mês ainda não chegou?" para quem
    // queria saber quanto deixar na conta até lá, e a pergunta só funcionava
    // nos dias do mês em que o dia já tinha passado.
    re: /\b(?:at[ée]|pr[ao]|para|antes\s+d[oe])\s+(?:o\s+)?dia\s+(\d{1,2})\b(?!\s*(?:de\s|d[oe]\s|\/))/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return invalidDate(m[0])
      const d = fromISO(t)
      const thisMonth = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth(), day))
      const iso = thisMonth >= t ? thisMonth : toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() + 1, day))
      return iso === t
        ? { kind: 'date', date: iso, label: brDate(iso) }
        : { kind: 'future', date: iso, label: brDate(iso) }
    },
  },
  {
    // "dia 5" seco — a leitura depende de onde estamos no mês.
    re: /\bdia\s+(\d{1,2})\b(?!\s*(?:de\s|d[oe]\s|\/))/i,
    build: (m, t) => {
      const day = Number(m[1])
      if (day < 1 || day > 31) return invalidDate(m[0])
      const d = fromISO(t)
      const thisMonth = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth(), day))
      if (fromISO(thisMonth).getDate() !== day) return invalidDate(m[0])
      if (thisMonth <= t) return { kind: 'date', date: thisMonth, label: brDate(thisMonth) }
      // Ainda não chegou neste mês: pode ser o mês passado ou uma previsão.
      const lastMonth = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() - 1, day))
      return {
        kind: 'ambiguous',
        question: `O dia ${day} deste mês ainda não chegou. Você quis dizer qual data?`,
        options: [
          ...(fromISO(lastMonth).getDate() === day ? [{ label: `Dia ${day} do mês passado (${brDate(lastMonth)})`, value: lastMonth }] : []),
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

export interface UnresolvedTemporalHint {
  text: string
  start: number
  end: number
}

/**
 * Barreira de segurança para expressões que claramente falam de tempo, mas não
 * identificam um único dia. Elas não servem para datar um fato e também não
 * podem sobrar como mera descrição enquanto o lançamento cai em hoje.
 */
export function findUnresolvedTemporalHint(text: string): UnresolvedTemporalHint | null {
  const rules = [
    new RegExp(String.raw`\b(?:em|durante|n[oe]\s+m[eê]s\s+de)\s+(?:${MONTH_RE})\b`, 'i'),
    /\b(?:h[áa]|faz)\s+(?:\d{1,3}|[a-zà-ú]+(?:\s+e\s+[a-zà-ú]+)*)\s+(?:dias?|semanas?|m[eê]s(?:es)?|anos?)\b/i,
    /\b(?:\d{1,3}|[a-zà-ú]+(?:\s+e\s+[a-zà-ú]+)*)\s+(?:dias?|semanas?|m[eê]s(?:es)?|anos?)\s+atr[áa]s\b/i,
    /\b(?:semana|m[eê]s|ano)\s+(?:retrasad[oa]|anterior)\b/i,
    /\b(?:no|na)?\s*(?:fim|final|in[íi]cio|come[çc]o|metade)\s+(?:d[oa]\s+)?(?:semana|m[eê]s|ano)\b/i,
    /\b(?:no|na)?\s*pr[óo]xim[oa]\s+(?:fim\s+de\s+semana|feriado)\b/i,
    /\b(?:semana|m[eê]s|ano)\s+seguinte\b/i,
    /\bano\s+passado\b/i,
    /\bdaqui\s+(?:a|h[áa])\s+pouco\b/i,
    /\bmais\s+tarde\b/i,
  ]
  let best: UnresolvedTemporalHint | null = null
  for (const rule of rules) {
    const match = text.match(rule)
    if (!match || match.index === undefined) continue
    const found = { text: match[0], start: match.index, end: match.index + match[0].length }
    if (!best || found.start < best.start) best = found
  }
  return best
}

/** Mesmo dia do ano anterior, quando esse dia existiu. */
export function previousYearOf(iso: string): string | undefined {
  const d = fromISO(iso)
  const previous = dateForDayOfMonth(d.getFullYear() - 1, d.getMonth(), d.getDate())
  return previous.getDate() === d.getDate() ? toISO(previous) : undefined
}

function isDateAnswerPart(text: string, date: DateResolution): boolean {
  const context = normalizeName(text.slice(0, date.start)).replace(/[,.:]+$/g, '').trim()
  return /^(?:na verdade[,]?\s*)?(?:(?:a data|o pagamento)\s+)?(?:(?:foi|era|e)\s*)?(?:em|no dia|na data|no|na)?$/.test(context)
    && /^[.!?]*$/.test(text.slice(date.end).trim())
}

function isRejectedDate(text: string, today: string): boolean {
  return text.split(/\s+(?:nem|ou)\s+/i).every(part => {
    if (/^\s*(?:(?:foi|era)\s+)?(?:dia\s+)?\d{1,2}[.!?]*\s*$/i.test(part)) return true
    const date = findDate(part, today)
    return !!date && isDateAnswerPart(part, date)
  })
}

/**
 * Isola a data afirmada em uma resposta curta. Uma recusa sem substituto fica
 * vazia, para que a data que o usuário rejeitou não complete um rascunho.
 */
export function dateAnswerCorrection(answer: string, today: string): { text: string; start: number } | undefined {
  const negation = answer.match(/^\s*n[ãa]o\b\s*/i)
  if (negation) {
    const tail = answer.slice(negation[0].length)
    const lead = tail.match(/^[,;—–]\s*(?=(?:foi|era)\s+)/i)
    if (lead) {
      const start = negation[0].length + lead[0].length
      return { text: answer.slice(start), start }
    }
    const separator = tail.match(/[,;—–]\s*|\s+(?=(?:foi|era)\s+)/i)
    const rejected = separator ? tail.slice(0, separator.index) : tail
    if (!isRejectedDate(rejected, today)) return undefined
    if (separator) {
      const start = negation[0].length + separator.index + separator[0].length
      return { text: answer.slice(start), start }
    }
    return { text: '', start: answer.length }
  }
  const rejected = answer.match(/(?:[,;—–]\s*|\s+)n[ãa]o\s+(?:(?:foi|era)\s+)?/i)
  return rejected && isRejectedDate(answer.slice(rejected.index + rejected[0].length), today)
    ? { text: answer.slice(0, rejected.index), start: 0 } : undefined
}

/** Aceita uma data afirmada em resposta à pergunta, sem outros valores. */
export function dateInAnswer(answer: string, today: string): Extract<DateResolution, { kind: 'date' | 'future' }> | null {
  const correction = dateAnswerCorrection(answer, today)
  const said = correction?.text ?? answer
  const date = findDate(said, today)
  if ((date?.kind !== 'date' && date?.kind !== 'future') || !isDateAnswerPart(said, date)) return null
  const offset = correction?.start || 0
  return { ...date, start: date.start + offset, end: date.end + offset }
}

/**
 * O usuário disse "mês passado" e nós perguntamos QUE DIA. Esta função lê a
 * resposta curta ("dia 10", "10", "10/06") e a coloca dentro da janela que a
 * pergunta abriu. Fora da janela devolve `null` — nunca aproxima, nunca cai em
 * hoje: a pergunta simplesmente continua aberta.
 */
export function resolveDayInWindow(
  answer: string,
  window: { from: string; to: string },
  today = todayISO(),
): string | null {
  const within = (iso: string) => (iso >= window.from && iso <= window.to && iso <= today ? iso : null)

  const affirmed = dateAnswerCorrection(answer, today)?.text ?? answer
  const m = affirmed.trim().match(/^(?:(?:foi|era)\s+)?(?:dia\s+)?(\d{1,2})[.!?]*$/i)
  if (!m) {
    // A data completa fora da janela continua sendo o dia e o mês que a pessoa
    // disse. Uma resposta com valor em dinheiro também não vira um dia.
    const said = dateInAnswer(answer, today)
    return said && said.kind === 'date' ? within(said.date) : null
  }

  const day = Number(m[1])
  if (day < 1 || day > 31) return null
  const first = fromISO(window.from)
  const last = fromISO(window.to)
  const months = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth()
  let found: string | null = null
  for (let i = 0; i <= months; i++) {
    const date = dateForDayOfMonth(first.getFullYear(), first.getMonth() + i, day)
    const iso = toISO(date)
    if (date.getDate() !== day || !within(iso)) continue
    if (found) return null
    found = iso
  }
  return found
}

/**
 * TODAS as expressões de data do texto, da esquerda para a direita.
 *
 * Varre com `findDate` e continua a partir do fim de cada achado, de modo que a
 * segunda expressão de uma frase composta ("ontem gastei 50 E DAQUI A 3 DIAS
 * pago mais 100") não se perca. Perdê-la não era só perder a data: o "3" ficava
 * solto no texto e virava uma despesa fantasma de R$ 3,00.
 *
 * A varredura reaproveita a regra "a mais à esquerda vence" de `findDate`, em
 * vez de resolver sobreposição por ordem de regra — que fazia "dia 5 do mês
 * passado" perder para o "mês passado" contido nele.
 */
export function findAllDates(text: string, today = todayISO()): DateResolution[] {
  const out: DateResolution[] = []
  let offset = 0
  let rest = text
  while (rest) {
    const found = findDate(rest, today)
    if (!found) break
    out.push({ ...found, start: found.start + offset, end: found.end + offset })
    offset += found.end
    rest = rest.slice(found.end)
  }
  return out
}
