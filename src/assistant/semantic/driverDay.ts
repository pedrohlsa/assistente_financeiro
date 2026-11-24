// O DIA DO MOTORISTA escrito como ele escreve de verdade.
//
//     hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h
//
// Sem verbo, sem vírgula, sem conector: valor, plataforma, valor, plataforma,
// valor de combustível, litros, km, horas. É a mensagem que ele manda no fim do
// turno, com o celular numa mão e o cinto na outra.
//
// O parser de frases não dá conta disso, e não é por descuido: ele foi feito
// para ORAÇÕES ("ganhei 430 na uber E coloquei 163 de gasolina"), e essa forma
// não tem oração nenhuma. Na prática, ele lia o primeiro valor e as horas —
// R$ 399 da 99, R$ 163 de combustível, 24 litros e 161 km sumiam em silêncio.
// Perder metade do dia de trabalho de alguém é o pior tipo de defeito: o
// usuário confirma o que vê e nunca descobre o que faltou.
//
// TRÊS TRAVAS para isto não vazar para outras frases:
//   1. só no perfil MOTORISTA;
//   2. só quando a frase tem a FORMA telegráfica — ao menos três pares
//      número+unidade e nenhum verbo de comando estruturando orações;
//   3. só quando reconhece MAIS coisas do que o parser normal já tinha achado.
// Falhando qualquer uma delas, este módulo devolve `null` e nada muda.

import type { ParsedAction } from '../../models/types'
import { parseMoney } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { normalizeNumberWords } from '../numbers'
import { findAllDates } from '../dates'
import { COMPOUND_DURATION, elapsedMinutes } from './clock'

const REPORTED_MONEY = String.raw`(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?`
const PLATFORM_INCOME = String.raw`(?:na|no|da|do|de|pela|pelo)\s+(?:uber|99|in\s*driver?)\b`
const RIDE_INCOME = String.raw`(?<income>${REPORTED_MONEY}\s+(?:de\s+corridas?(?:\s+${PLATFORM_INCOME})?|${PLATFORM_INCOME}))`
const FUEL_WORD = 'combust[íi]vel|gasolina|gasosa|etanol|[áa]lcool|diesel|gnv'
const FUEL_EXPENSE = String.raw`(?<fuel>${REPORTED_MONEY}\s+de\s+(?:${FUEL_WORD}))`
const FUEL_RESULT = new RegExp(
  String.raw`(^|(?:[,;.]\s*|\s+e\s+))deu\s+(${REPORTED_MONEY})\s+(?:de\s+)?(${FUEL_WORD})(?=\s*(?:[.!]|$))`,
  'i',
)
const FUEL_SPEND = String.raw`(?:\s+e\s+${FUEL_EXPENSE})?`
const REPORTED_DURATION = String.raw`(?:${COMPOUND_DURATION}|\d+(?:[.,]\d+)?\s*(?:h|hrs?|horas?))`
const CLOSED_SHIFT = new RegExp(
  String.raw`^fechei\s+(?<duration>${REPORTED_DURATION})\s+(?:no\s+volante|de\s+trabalho|dirigindo)(?:(?:,\s*(?:(?:com|e)\s+)?|\s+(?:com|e)\s+)${RIDE_INCOME}${FUEL_SPEND})?[.!]*$`,
  'i',
)
const CLOSED_DAY_AFTER_WORK = new RegExp(
  String.raw`^fechei\s+(?:meu|o)\s+(?:dia|turno)\s+com\s+${RIDE_INCOME}(?:\s+e\s+(?:gastei|paguei|abasteci)\s+${FUEL_EXPENSE})?\s+depois\s+de\s+(?:trabalhar|rodar|dirigir)\s+(?<duration>${REPORTED_DURATION})[.!]*$`,
  'i',
)
const RIDE_RESULT_WITH_DURATION = new RegExp(
  String.raw`^(?:ganhei|faturei)\s+${RIDE_INCOME}${FUEL_SPEND}\s+(?:em|durante)\s+(?<duration>${REPORTED_DURATION})[.!]*$`,
  'i',
)
const RIDE_RESULT = new RegExp(String.raw`^(?:deu|deram)\s+${RIDE_INCOME}${FUEL_SPEND}[.!]*$`, 'i')
const HOURS_AFTER_PLATFORM = new RegExp(
  String.raw`(${REPORTED_MONEY}\s+${PLATFORM_INCOME}\s*,\s*)(${REPORTED_DURATION})(?=\s*(?:[,;.!]|e\s+(?:gastei|paguei|abasteci|rodei)\b|$))`,
  'i',
)

/** Dá verbos próprios aos valores e medidas em um relato compacto de uma só jornada. */
export function expandDriverReport(message: string, today: string): string {
  if (!/\b(?:fechei|deu|deram|fiz|faturei|ganhei)\b/i.test(message) || /[?]|\b(?:n[aã]o|nem|nunca|se|talvez|ou)\b/i.test(message)) return message
  const normalized = normalizeNumberWords(message).text.trim()
  const text = normalized.replace(FUEL_RESULT, '$1gastei $2 de $3')
  const withFuel = text === normalized ? message : text
  const dates = findAllDates(text, today)
  const [date] = dates
  if (dates.length > 1) return withFuel
  const withoutDate = (date ? text.slice(0, date.start) + text.slice(date.end) : text).trim().replace(/^,\s*|[,;]$/g, '').trim()
  const parts = (withoutDate.match(CLOSED_SHIFT) || withoutDate.match(CLOSED_DAY_AFTER_WORK)
    || withoutDate.match(RIDE_RESULT_WITH_DURATION) || withoutDate.match(RIDE_RESULT))?.groups
  if (!parts) {
    if (!/^(?:eu\s+)?(?:fiz|faturei|ganhei)\s/i.test(withoutDate)) return withFuel
    const repaired = text.replace(HOURS_AFTER_PLATFORM, '$1trabalhei $2')
    return repaired === text ? withFuel : repaired
  }
  const { duration, income, fuel } = parts
  const when = date ? text.slice(date.start, date.end) : ''
  return [when, duration && 'trabalhei ' + duration, income && (duration ? 'e ganhei ' : 'ganhei ') + income,
    fuel && 'e gastei ' + fuel].filter(Boolean).join(' ')
}

const SHIFT_WITH_APP_HOURS = new RegExp([
  String.raw`^(?:eu\s+)?(?:fiquei|passei|trabalhei|dirigi|fechei)\s+(?:por\s+)?(?<duration>${REPORTED_DURATION})`,
  String.raw`(?:\s+(?:no\s+volante|dirigindo|de\s+trabalho))?`,
  String.raw`(?:\s*[,;:]\s*(?:sendo\s+)?|\s+(?:sendo|dividid[oa]s?\s+em)\s+)(?<rest>.+)$`,
].join(''), 'i')
const APP_NAMES = String.raw`(?:uber|99|in\s*driver?|ifood|rappi)\b`
const APP_DURATION = String.raw`(?:${REPORTED_DURATION}|\d{1,2}\s+e\s+meia)`
const HOURS_THEN_APP = new RegExp(String.raw`^(?<duration>${APP_DURATION})\s+(?:(?:na|no|pela|pelo|de)\s+)?(?<platform>${APP_NAMES})`, 'i')
const APP_THEN_HOURS = new RegExp(String.raw`^(?:(?:na|no|pela|pelo)\s+)?(?<platform>${APP_NAMES})\s+(?:por\s+)?(?<duration>${APP_DURATION})`, 'i')
const SHIFT_CLAUSE_START = /^(?:ganhei|faturei|recebi|fiz|gastei|paguei|abasteci|rodei|dirigi)\b/i

/** Lê uma duração de jornada em minutos, inclusive decimal e meia hora elíptica. */
export function reportedWorkMinutes(text: string): number | undefined {
  const said = normalizeNumberWords(text).text.trim().replace(/[.!]+$/, '').replace(/^(?:foram|foi|deu|trabalhei(?:\s+por)?)\s+/i, '')
  const duration = said.replace(/^(\d{1,2})\s+e\s+meia$/i, '$1 horas e meia')
  const simple = duration.match(/^(\d+(?:[.,]\d+)?)\s*(?:h|hrs?|horas?)$/i)
  const minutes = simple ? Math.round(Number(simple[1].replace(',', '.')) * 60) : elapsedMinutes(duration)
  return minutes > 0 && minutes <= 1440 ? minutes : undefined
}

export function readShiftWithAppHours(message: string, today: string) {
  if (!/\b(?:uber|99|noventa|in\s*drive[r]?|ifood|rappi)\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const dates = findAllDates(text, today)
  const [day] = dates
  if (dates.length > 1 || (day && (day.kind !== 'date' || text.slice(0, day.start).trim()))) return undefined
  const body = day ? text.slice(day.end).replace(/^[\s,]+/, '') : text
  const head = body.match(SHIFT_WITH_APP_HOURS)?.groups
  if (!head) return undefined
  const minutes = reportedWorkMinutes(head.duration)
  if (!minutes) return undefined

  let rest = head.rest
  let sum = 0
  const apps = new Set<string>()
  while (rest) {
    const part = rest.match(HOURS_THEN_APP) || rest.match(APP_THEN_HOURS)
    if (!part) return undefined
    const portion = reportedWorkMinutes(part.groups.duration)
    const app = normalizeName(part.groups.platform).replace(/\s+/g, '').replace(/^indriver$/, 'indrive')
    if (!portion || apps.has(app)) return undefined
    apps.add(app)
    sum += portion
    const after = rest.slice(part[0].length).trim()
    if (!after || /^[.!]+$/.test(after)) {
      rest = ''
      break
    }
    const separator = after.match(/^(?:[,;.]\s*(?:e\s+)?|e\s+)/i)?.[0]
    if (!separator) return undefined
    rest = after.slice(separator.length)
    if (SHIFT_CLAUSE_START.test(rest)) break
  }
  if (apps.size < 2) return undefined
  return { minutes, sum, rest, date: day?.kind === 'date' ? day.date : undefined, when: day?.text }
}

/** Plataformas de onde o dinheiro vem. O nome vira a descrição do lançamento. */
const PLATAFORMAS: [RegExp, string][] = [
  [/^uber$/i, 'Uber'],
  [/^99$|^noventa\s*e\s*nove$/i, '99'],
  [/^in\s*driver?$/i, 'inDrive'],
  [/^ifood$/i, 'iFood'],
  [/^rappi$/i, 'Rappi'],
  [/^particular(?:es)?$/i, 'Particular'],
  [/^app$/i, 'App'],
]

/** Palavras que significam combustível na boca dele, gíria incluída. */
const COMBUSTIVEL = /^(?:gasolina|gasosa|alcool|etanol|gnv|diesel|combustivel|suco)$/i
const LIQUIDO = /^(?:liquid[oa]s?|limp[oa]s?)$/

const plataformaDe = (token: string): string | null => {
  for (const [re, nome] of PLATAFORMAS) if (re.test(token)) return nome
  return null
}

export interface DriverDay {
  actions: ParsedAction[]
  /** Quantos tokens da frase foram efetivamente entendidos. */
  reconhecidos: number
  unclassifiedAmounts: number[]
  invalidWork: boolean
}

/** Verbo que estrutura oração: com ele, quem lê a frase é o parser normal. */
const TEM_ORACAO = /\b(?:ganhei|recebi|faturei|coloquei|botei|abasteci|rodei|andei|trabalhei|gastei|paguei|comprei|guardei|troquei)\b/i
const NAO_E_RELATO = /\?|\b(?:nao|nem|nunca|se|talvez|ou|quanto|qual|compara|compensa|vale|somando|total|vou|pretendo)\b/
const DURACAO = new RegExp(String.raw`(?<![\d.,])${COMPOUND_DURATION}(?![\p{L}\p{M}\d]|[.,]\d)`, 'gu')

/**
 * Lê o dia telegráfico. `null` quando a frase não tem essa forma — e "não tem
 * essa forma" é a resposta certa para quase tudo.
 */
export function parseDriverDay(message: string, opts: { driver: boolean }): DriverDay | null {
  if (!opts.driver) return null
  const raw = normalizeNumberWords(normalizeName(message)).text
  if (TEM_ORACAO.test(raw) || NAO_E_RELATO.test(raw)) return null

  // Normaliza só o suficiente para tokenizar: separa número de unidade colada
  // ("161km" → "161 km", "24l" → "24 l", "8h" → "8 h").
  const texto = raw
    .replace(/(\d)\s+reais?\s+(?=(?:de|da|do|na|no|pela|pelo)\s)/g, '$1 ')
    .replace(DURACAO, duration => ` ${elapsedMinutes(duration) ?? 0} min-jornada `)
    .replace(/(\d)\s*(km|l|h|hrs?|horas?|litros?)\b/gi, '$1 $2')
    .replace(/(?<!\d)[.,]|[.,](?!\d)|[;!?:]/g, ' ')
  const tokens = texto.split(/\s+/).filter(Boolean)

  const actions: ParsedAction[] = []
  let reconhecidos = 0
  const work: { km?: number; hours?: number; trips?: number } = {}
  const fuel: { amount?: number; liters?: number } = {}
  const fuels = new Set<string>()
  const unclassifiedAmounts: number[] = []
  let invalidWork = false
  let rendaSemPlataforma = 0
  const saidLiters = /\d\s+(?:l|litros?)\b/.test(texto)
  const isFuel = (t: string) => COMBUSTIVEL.test(t) || t === 'gas' && saidLiters

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!/^\d[\d.,]*$/.test(t)) continue
    const valor = parseMoney(t)
    const seguinte = tokens[i + 1] || ''
    const depois = tokens[i + 2] || ''
    if (seguinte === 'min-jornada') {
      if (valor > 0) work.hours = (work.hours || 0) + valor / 60
      else invalidWork = true
      reconhecidos += 2; i++; continue
    }
    if (!Number.isFinite(valor) || valor <= 0) continue

    // --- quantidade com unidade -----------------------------------------
    if (/^km$/i.test(seguinte)) { work.km = (work.km || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:h|hrs?|horas?)$/i.test(seguinte)) { work.hours = (work.hours || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:l|litros?)$/i.test(seguinte)) { fuel.liters = (fuel.liters || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:corridas?|viagens?|chamadas?)$/i.test(seguinte)) {
      if (Number.isInteger(valor)) work.trips = (work.trips || 0) + valor
      else invalidWork = true
      reconhecidos += 2; i++; continue
    }

    // --- combustível: "163 de gasosa" ou "163 gasolina" ------------------
    if (isFuel(seguinte) || (seguinte === 'de' && isFuel(depois))) {
      fuels.add((seguinte === 'de' ? depois : seguinte).replace(/^alcool$/, 'etanol'))
      fuel.amount = (fuel.amount || 0) + valor
      reconhecidos += /^de$/i.test(seguinte) ? 3 : 2
      i += /^de$/i.test(seguinte) ? 2 : 1
      continue
    }

    // --- receita por plataforma: "430 uber" ------------------------------
    const directApp = plataformaDe(seguinte)
    const depoisDoApp = tokens[i + 3] || ''
    const countInsteadOfApp = seguinte === 'de' && depois === '99' && /^(?:corridas?|viagens?|reais?|km|horas?)$/.test(depoisDoApp)
    const plat = directApp || (!countInsteadOfApp && /^(?:na|no|de|da|do|pela|pelo)$/.test(seguinte) ? plataformaDe(depois) : null)
    if (plat) {
      const used = directApp ? 1 : 2
      const reportedNet = LIQUIDO.test(tokens[i + used + 1] || '')
      actions.push({ kind: 'income', amount: valor, category: 'corridas', description: plat, ...(reportedNet ? { reportedNet } : {}) })
      reconhecidos += 1 + used + Number(reportedNet)
      i += used + Number(reportedNet)
      continue
    }

    // --- valor solto logo depois do verbo de resultado --------------------
    // "hj DEU 430 ..." — o primeiro número da frase é o faturamento quando
    // nenhuma plataforma o acompanha. Um número solto no MEIO da frase não
    // vira nada: adivinhar ali seria inventar dinheiro.
    const anterior = tokens[i - 1] || ''
    if (/^(?:deu|foi|fiz|saiu|deram)$/i.test(anterior)) {
      rendaSemPlataforma += valor
      reconhecidos += 2
      continue
    }
    unclassifiedAmounts.push(valor)
  }

  if (rendaSemPlataforma > 0) {
    actions.unshift({ kind: 'income', amount: rendaSemPlataforma, category: 'corridas' })
  }
  if (fuel.amount !== undefined || fuel.liters !== undefined) {
    const [type] = fuels
    const fuelType = fuels.size === 1 ? { etanol: 'Etanol', diesel: 'Diesel', gnv: 'GNV' }[type] : undefined
    actions.push({ kind: 'fuel', ...fuel, ...(fuelType ? { fuelType } : {}) })
  }
  if (work.km !== undefined || work.hours !== undefined || work.trips !== undefined) {
    actions.push({ kind: 'work', ...work } as ParsedAction)
  }

  // A forma telegráfica precisa estar ali de verdade: três coisas entendidas e
  // pelo menos metade da frase consumida. Abaixo disso é uma frase comum com um
  // número dentro, e quem lê é o parser normal.
  const partes = actions.length
  if (partes < 3) return null
  if (reconhecidos < tokens.length * 0.5) return null

  return { actions, reconhecidos, unclassifiedAmounts, invalidWork }
}
