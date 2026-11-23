// Números por extenso em pt-BR ("mil e seiscentos e vinte e cinco" → 1625).
//
// REGRA 12 DO CLAUDE.MD: este módulo NÃO converte dígito nenhum por conta
// própria. Ele traduz PALAVRAS em número; qualquer coisa escrita com algarismo
// continua indo para `parseMoney()`. Nunca existe um segundo parser monetário.

/**
 * MAPAS, nao objetos literais. O operador `in` e o acesso por colchete andam
 * pela CADEIA DE PROTOTIPO: com um objeto comum, `'__proto__' in UNITS` e
 * `'constructor' in UNITS` sao `true`, e a leitura devolve `Object.prototype` /
 * a funcao construtora. O fuzzer achou isso como um CRASH real — a mensagem
 * "__proto__" derrubava o assistente com "m.value.toFixed is not a function",
 * porque o acumulador virava uma string.
 *
 * `Map` nao tem esse problema: a chave e a chave, e nada mais existe ali.
 */
const UNITS = new Map<string, number>(Object.entries({
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16,
  dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19,
}))

const TENS = new Map<string, number>(Object.entries({
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60,
  setenta: 70, oitenta: 80, noventa: 90,
}))

const HUNDREDS = new Map<string, number>(Object.entries({
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500,
  seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700,
  oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
}))

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
  return UNITS.has(s) || TENS.has(s) || HUNDREDS.has(s) || SCALES.some(sc => sc.word.test(s))
}

/**
 * Converte uma sequência já isolada de palavras numéricas.
 * Devolve `null` quando a sequência não forma um número (ex.: só "e").
 */
export function wordsToNumber(words: string[]): number | null {
  const r = wordsToNumberParts(words)
  return r ? r.value : null
}

/**
 * Além do valor, devolve onde a sequência deixou de ser UM número só.
 *
 * Em pt-BR não existe número com duas dezenas seguidas: "quarenta e nove e
 * noventa" não é 139 — é R$ 49,90 dito em voz alta. Somar tudo produzia um
 * VALOR ERRADO, que é o pior defeito possível aqui.
 */
export function wordsToNumberParts(words: string[]): { value: number; cents?: number } | null {
  let total = 0
  let current = 0
  let sawDigit = false
  let tensUsed = false
  let cents: number | undefined

  for (let i = 0; i < words.length; i++) {
    const raw = words[i]
    const w = strip(raw)
    if (FILLER.has(w)) continue

    if (TENS.has(w) && tensUsed && total === 0) {
      // Segunda dezena sem escala no meio: o resto são os centavos.
      const rest = wordsToNumberParts(words.slice(i))
      if (rest && rest.value > 0 && rest.value < 100) cents = rest.value
      break
    }

    if (UNITS.has(w)) { current += UNITS.get(w)!; sawDigit = true; continue }
    if (TENS.has(w)) { current += TENS.get(w)!; sawDigit = true; tensUsed = true; continue }
    if (HUNDREDS.has(w)) { current += HUNDREDS.get(w)!; sawDigit = true; continue }

    const scale = SCALES.find(s => s.word.test(w))
    if (scale) {
      // "mil" sozinho vale 1000; "dois mil" vale 2000.
      const factor = current === 0 ? 1 : current
      total += factor * scale.value
      current = 0
      sawDigit = true
      tensUsed = false // "mil e vinte e cinco" reabre a contagem
      continue
    }
    return null
  }
  const value = total + current + (cents ? cents / 100 : 0)
  return sawDigit ? { value, cents } : null
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
    const platform = /\b(?:na|no|da|do|pela|pelo|via|app)\s*$/i.test(text.slice(Math.max(0, tokens[i].start - 12), tokens[i].start))
      && /^noventa\s+e\s+nove\s+e\s+/i.test(text.slice(tokens[i].start))
    const limit = platform ? Math.min(i + 3, tokens.length) : tokens.length
    // Consome palavras numéricas e os conectores "e"/"de" entre elas.
    while (j < limit) {
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
    // "UM e cinquenta", "dois e noventa": unidade ANTES da dezena não existe
    // como número inteiro — é como se fala real e centavos. Somado, "um e
    // cinquenta no pão" virava R$ 51,00.
    {
      const sig = seq.filter(w => !FILLER.has(strip(w)))
      const primeira = sig.length >= 2 ? wordsToNumber([sig[0]]) : null
      const resto = sig.length >= 2 ? wordsToNumber(sig.slice(1)) : null
      if (primeira !== null && resto !== null && primeira >= 1 && primeira <= 9 && resto >= 10 && resto <= 99
        && strip(seq[1] || '') === 'e') {
        value = primeira + resto / 100
      }
    }
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
export function normalizeNumberWords(entrada: string): { text: string; replacements: NumberWordMatch[] } {
  // O multiplicador colado a um DÍGITO vem antes das palavras: "2 mil e
  // quinhentos" precisa virar 2500 inteiro, e não "2 mil e 500" — que o parser
  // lia como R$ 2,00 e mais uma despesa de R$ 500. As posições em
  // `replacements` são relativas a este texto já expandido.
  const text = expandMilComDigito(entrada)
  const found = findNumberWords(text)
  // Sem número por extenso ainda pode haver centavo em dígito ("50 centavos"),
  // então a saída antecipada também passa pelo mesmo tratamento.
  if (!found.length) return { text: withCents(withSpokenDecimal(text)), replacements: [] }
  let out = ''
  let cursor = 0
  for (const m of found) {
    out += text.slice(cursor, m.start)
    const digits = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(2).replace('.', ',')
    out += digits + (m.explicitMoney ? ' reais' : '')
    cursor = m.end
  }
  out += text.slice(cursor)
  return { text: withCents(withSpokenDecimal(out)), replacements: found }
}

/**
 * "3 mil", "2,5 mil", "4 mil e quinhentos", "2 mil e 500" → 3000, 2500, 4500, 2500.
 *
 * O parser inteiro lê dígitos, e "mil" depois de um dígito ficava de fora:
 * "tv de 3 mil" era simulada como R$ 3,00 e "moto de 12 mil em 24 vezes" como
 * R$ 4,00 em 2x. A magnitude se perdia sem aviso — o pior tipo de erro, porque o
 * número parece certo.
 *
 * Três travas:
 *   1. o número tem até TRÊS dígitos e no máximo dois decimais, sem outro dígito
 *      ou separador colado antes: "220.800 mil km" é como se fala o hodômetro e
 *      já vale 220800 (quem cuida disso é `parseKmValue`);
 *   2. o resto depois de "e" só entra quando é MENOR que mil e não carrega
 *      unidade de outra coisa ("3 mil e 2 parcelas" continua sendo duas coisas);
 *   3. nada aqui interpreta dinheiro com separador — isso é `parseMoney` (regra 12).
 */
const RE_MIL_COM_DIGITO = /(?<!\d|\d[.,])(\d{1,3})(?:[.,](\d{1,2}))?\s*mil\b/gi
const UNIDADE_DE_OUTRA_COISA = /^\s*(?:mil\b|%|km\b|quil[oô]metros?|x\b|vezes\b|parcelas?\b|meses\b|m[eê]s\b|dias?\b|anos?\b|semanas?\b|horas?\b|h\b|litros?\b|viagens?\b|corridas?\b)/i

export function expandMilComDigito(text: string): string {
  let out = ''
  let cursor = 0
  for (const m of text.matchAll(RE_MIL_COM_DIGITO)) {
    const start = m.index ?? 0
    if (start < cursor) continue
    let valor = Math.round((Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0)) * 1000)
    let fim = start + m[0].length

    const conector = m[2] ? null : text.slice(fim).match(/^\s+e\s+/)
    if (conector) {
      const depois = text.slice(fim + conector[0].length)
      const digitos = depois.match(/^(\d{1,3})(?!\d|[.,]\d)/)
      if (digitos && !UNIDADE_DE_OUTRA_COISA.test(depois.slice(digitos[0].length))) {
        valor += Number(digitos[1])
        fim += conector[0].length + digitos[0].length
      } else if (!digitos) {
        const palavras = findNumberWords(depois)[0]
        if (palavras && palavras.start === 0 && Number.isInteger(palavras.value)
          && palavras.value > 0 && palavras.value < 1000 && !palavras.unit) {
          // "reais" depois do número é da frase, não do número: fica no texto.
          const literal = depois.slice(0, palavras.end)
          const semMoeda = literal.match(/^(.*?)\s*(?:reais|real|contos?)\b.*$/i)
          valor += palavras.value
          fim += conector[0].length + (semMoeda ? semMoeda[1].length : literal.length)
        }
      }
    }
    out += text.slice(cursor, start) + String(valor)
    cursor = fim
  }
  return cursor ? out + text.slice(cursor) : text
}

/**
 * "50 centavos" é meio real, não cinquenta reais.
 *
 * Este passo roda DEPOIS da conversão por extenso de propósito: assim uma regra
 * só atende as três formas em que o usuário fala centavos — "50 centavos",
 * "cinquenta centavos" (que já virou "50 centavos" acima) e "20 reais e 30
 * centavos". Antes, nenhuma delas funcionava: a primeira registrava CEM VEZES o
 * valor, e as outras duas jogavam os centavos fora em silêncio.
 *
 * O caso todo por extenso ("cento e cinquenta reais e cinquenta centavos") já
 * chega aqui somado — o `\d+,\d{2}` na primeira alternativa é justamente para
 * não somar duas vezes, só limpar o resto da frase.
 */
/**
 * DECIMAL FALADO: "sessenta vírgula cinquenta" → "60,50".
 *
 * A conversão por extenso resolve cada metade sozinha e devolvia "60 vírgula
 * 50": o parser lia o 60, e os cinquenta centavos iam para a DESCRIÇÃO do
 * lançamento ("Vírgula 50 de farmácia"). Perder centavo é perder dinheiro.
 *
 * A REGRA, escrita: o que vem depois da vírgula é a parte decimal como foi
 * dita, dígito a dígito do número falado — "dez vírgula cinco" é 10,5, que em
 * dinheiro é R$ 10,50, e "sessenta vírgula cinquenta" é 60,50. Não há
 * padding para dois dígitos: isso transformaria 10,5 em 10,05 e mudaria o
 * valor. Quem quer cinco centavos diz "dez e cinco centavos", que tem regra
 * própria logo abaixo.
 *
 * Só "vírgula" — "ponto" é ditado de pontuação na fala transcrita ("de
 * farmácia PONTO") e nunca separador decimal aqui.
 */
function withSpokenDecimal(t: string): string {
  return t.replace(/(?<![\d,.])(\d+)\s+v[íi]rgula\s+(\d{1,2})(?![\d.,])/gi, '$1,$2')
}

function withCents(t: string): string {
  const pad = (c: string) => c.padStart(2, '0').slice(0, 2)
  return t
    // "20 reais e 30 centavos" → "20,30". Com o valor já em centavos, só limpa.
    .replace(
      /(\d+)(,\d{2})?\s*(?:reais|real|conto|contos|pila|mango)\s*(?:e\s*)?(\d{1,2})\s*centavos?\b/gi,
      (_m, reais: string, jaTemCentavos: string | undefined, cents: string) =>
        `${reais}${jaTemCentavos || ','}${jaTemCentavos ? '' : pad(cents)} reais`,
    )
    // "50 e 5 centavos" explicita uma parte inteira e uma fração.
    .replace(/(?<![\d,.])(\d{1,3}(?:\.\d{3})+|\d+)\s+e\s+(\d{1,2})\s*centavos?\b/gi,
      (_m, reais: string, cents: string) => `${reais},${pad(cents)} reais`)
    // "50 centavos" sozinho — sem reais na frente.
    .replace(/(?<![\d,.])(\d{1,2})\s*centavos?\b/gi, (_m, cents: string) => `0,${pad(cents)} reais`)
}
