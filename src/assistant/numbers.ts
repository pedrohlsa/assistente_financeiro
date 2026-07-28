// Números por extenso em pt-BR ("mil e seiscentos e vinte e cinco" → 1625).
//
// REGRA 12 DO CLAUDE.MD: este módulo NÃO converte dígito nenhum por conta
// própria. Ele traduz PALAVRAS em número; qualquer coisa escrita com algarismo
// continua indo para `parseMoney()`. Nunca existe um segundo parser monetário.

const UNITS: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16,
  dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19,
}

const TENS: Record<string, number> = {
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60,
  setenta: 70, oitenta: 80, noventa: 90,
}

const HUNDREDS: Record<string, number> = {
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500,
  seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700,
  oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
}

/** Multiplicadores de escala, do maior para o menor. */
const SCALES: { word: RegExp; value: number }[] = [
  { word: /^(?:bilh(?:ao|oes))$/, value: 1_000_000_000 },
  { word: /^(?:milh(?:ao|oes))$/, value: 1_000_000 },
  { word: /^mil$/, value: 1_000 },
]

const FILLER = new Set(['e', 'de'])

export const NUMBER_WORD_RE = /\b(?:zero|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|c?atorze|quinze|dez[ae]sseis|dez[ae]ssete|dezoito|dez[ae]nove|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|cem|cento|duzent[oa]s|trezent[oa]s|quatrocent[oa]s|quinhent[oa]s|seiscent[oa]s|setecent[oa]s|oitocent[oa]s|novecent[oa]s|mil|milh[ãa]o|milh[õo]es|bilh[ãa]o|bilh[õo]es)\b/i

const strip = (w: string) =>
  w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const isNumberWord = (w: string): boolean => {
  const s = strip(w)
  return s in UNITS || s in TENS || s in HUNDREDS || SCALES.some(sc => sc.word.test(s))
}

/**
 * Converte uma sequência já isolada de palavras numéricas.
 * Devolve `null` quando a sequência não forma um número (ex.: só "e").
 */
export function wordsToNumber(words: string[]): number | null {
  let total = 0
  let current = 0
  let sawDigit = false

  for (const raw of words) {
    const w = strip(raw)
    if (FILLER.has(w)) continue

    if (w in UNITS) { current += UNITS[w]; sawDigit = true; continue }
    if (w in TENS) { current += TENS[w]; sawDigit = true; continue }
    if (w in HUNDREDS) { current += HUNDREDS[w]; sawDigit = true; continue }

    const scale = SCALES.find(s => s.word.test(w))
    if (scale) {
      // "mil" sozinho vale 1000; "dois mil" vale 2000.
      const factor = current === 0 ? 1 : current
      total += factor * scale.value
      current = 0
      sawDigit = true
      continue
    }
    return null
  }
  const value = total + current
  return sawDigit ? value : null
}

export interface NumberWordMatch {
  /** Valor final, já somando reais e centavos quando houver. */
  value: number
  /** Índice inicial no texto original. */
  start: number
  /** Índice final (exclusivo). */
  end: number
  /** Trecho literal casado. */
  text: string
  /** O trecho terminava em "reais"/"conto(s)"? Indica dinheiro com certeza. */
  explicitMoney: boolean
  /** Unidade citada logo depois ("km", "litros", "horas", "viagens"...). */
  unit?: string
}

const UNIT_AFTER = /^\s*(quil[oô]metros?|km|litros?|l|horas?|h|viagens?|corridas?|parcelas?|vezes|x|meses|m[eê]s|dias?|semanas?|anos?|reais|real|conto?s?|centavos?)\b/i

const canonicalUnit = (u?: string): string | undefined => {
  if (!u) return undefined
  const s = strip(u)
  if (/^(quilometros?|quilômetros?|km)$/.test(s)) return 'km'
  if (/^(litros?|l)$/.test(s)) return 'liters'
  if (/^(horas?|h)$/.test(s)) return 'hours'
  if (/^(viagens?|corridas?)$/.test(s)) return 'trips'
  if (/^(parcelas?|vezes|x)$/.test(s)) return 'installments'
  if (/^(meses|mes)$/.test(s)) return 'months'
  if (/^(dias?)$/.test(s)) return 'days'
  if (/^(semanas?)$/.test(s)) return 'weeks'
  if (/^(anos?)$/.test(s)) return 'years'
  if (/^(reais|real|conto|contos)$/.test(s)) return 'money'
  if (/^(centavos?)$/.test(s)) return 'cents'
  return undefined
}

/**
 * Encontra TODAS as sequências de números por extenso no texto, com posição.
 *
 * Cuidado deliberado: "um", "uma", "dois" e "duas" também são artigos e
 * pronomes ("comprei UMA cadeira"). Uma sequência de UMA única palavra dessas,
 * sem unidade nem "reais" logo depois, é descartada — senão "uma cadeira"
 * viraria o número 1.
 */
export function findNumberWords(text: string): NumberWordMatch[] {
  const tokens: { w: string; start: number; end: number }[] = []
  const re = /[\wçãõáéíóúâêôàü]+/gi
  for (const m of text.matchAll(re)) {
    tokens.push({ w: m[0], start: m.index || 0, end: (m.index || 0) + m[0].length })
  }

  const out: NumberWordMatch[] = []
  let i = 0
  while (i < tokens.length) {
    if (!isNumberWord(tokens[i].w)) { i++; continue }
    let j = i
    const seq: string[] = []
    // Consome palavras numéricas e os conectores "e"/"de" entre elas.
    while (j < tokens.length) {
      const t = tokens[j]
      if (isNumberWord(t.w)) { seq.push(t.w); j++; continue }
      if (FILLER.has(strip(t.w)) && j + 1 < tokens.length && isNumberWord(tokens[j + 1].w)) {
        seq.push(t.w); j++; continue
      }
      break
    }
    const start = tokens[i].start
    const end = tokens[j - 1].end

    // "84 mil km" já é um número escrito com algarismo: converter o "mil"
    // sozinho produziria "84 1000 km". Multiplicador colado a um dígito é
    // trabalho do `parseKmValue`/`parseMoney`, não deste módulo.
    const before = text.slice(Math.max(0, start - 12), start)
    if (/\d\s*$/.test(before)) { i = j; continue }

    const literal = text.slice(start, end)
    const after = text.slice(end)
    const unitM = after.match(UNIT_AFTER)
    const unit = canonicalUnit(unitM?.[1])

    let value = wordsToNumber(seq)
    if (value !== null) {
      const meaningful = seq.filter(w => !FILLER.has(strip(w)))
      const single = meaningful.length === 1 ? strip(meaningful[0]) : ''
      // "um"/"uma" sozinhos são artigo, não quantidade: "uma corrida de 37" não
      // é o número 1, e convertê-lo criava uma receita fantasma de R$ 1,00.
      // "dois"/"duas" só valem como número quando vêm com unidade.
      if (single === 'um' || single === 'uma') { i = j; continue }
      if ((single === 'dois' || single === 'duas') && !unit) { i = j; continue }

      let explicitMoney = unit === 'money'
      let consumedEnd = end + (unit === 'money' ? (unitM?.[0].length || 0) : 0)

      // "cento e cinquenta reais e cinquenta centavos"
      if (explicitMoney) {
        const rest = text.slice(consumedEnd)
        const centsM = rest.match(/^\s*e\s+([\wçãõáéíóúâêô\s]+?)\s+centavos?\b/i)
        if (centsM) {
          const centWords = centsM[1].split(/\s+/).filter(Boolean)
          const cents = wordsToNumber(centWords)
          if (cents !== null && cents > 0 && cents < 100) {
            value += cents / 100
            consumedEnd += centsM[0].length
          }
        }
      }

      out.push({
        value,
        start,
        end: consumedEnd,
        text: text.slice(start, consumedEnd) || literal,
        explicitMoney,
        unit: unit && unit !== 'money' ? unit : undefined,
      })
    }
    i = j
  }
  return out
}

/**
 * Reescreve o texto trocando números por extenso por algarismos, devolvendo
 * também o mapa do que foi trocado.
 *
 * Por que reescrever em vez de interpretar direto: todo o parser existente já é
 * baseado em regex sobre dígitos e está coberto por testes. Normalizar a
 * entrada aproveita esse parser inteiro em vez de duplicá-lo — e o texto
 * ORIGINAL continua preservado para exibição e diagnóstico.
 */
export function normalizeNumberWords(text: string): { text: string; replacements: NumberWordMatch[] } {
  const found = findNumberWords(text)
  if (!found.length) return { text, replacements: [] }
  let out = ''
  let cursor = 0
  for (const m of found) {
    out += text.slice(cursor, m.start)
    const digits = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(2).replace('.', ',')
    out += digits + (m.explicitMoney ? ' reais' : '')
    cursor = m.end
  }
  out += text.slice(cursor)
  return { text: out, replacements: found }
}
