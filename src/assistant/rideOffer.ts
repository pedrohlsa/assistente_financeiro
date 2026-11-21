import type { AppState } from '../models/types'
import { analyzeRide, kmCost } from '../services/calc'
import { RIDE_COMPARISON_REQUEST, RIDE_EVALUATION_REQUEST, RIDE_OFFER_NOTICE } from '../services/nlp'
import { isDriver } from '../services/profile'
import { fmtBRL, fmtNum, parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { looksPast } from './clauses'
import type { PendingRideOffer, RideOfferMeasures as Measures } from './contracts'
import { PARE_PARA_DESCANSAR, perceivesDrivingFatigue } from './driverAdvice'
import { normalizeNumberWords } from './numbers'
import { COMPOUND_DURATION, elapsedMinutes } from './semantic/clock'

const NOME = /\b(?:corridas?|viagem|chamada)\b/
const NUMBER = String.raw`(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)`
const AMOUNT_WITH_CURRENCY = new RegExp(String.raw`(?<!-)r\$\s*${NUMBER}|(?<![\w.,-])${NUMBER}\s*(?:reais?|contos?|pila)\b`, 'g')
const AMOUNT_AFTER_NOUN = new RegExp(String.raw`\b(?:corridas?|viagem|chamada)\s+(?:(?:da|do|na|no|pela|pelo|via)\s+(?:uber|99|indrive[r]?)\s+)?(?:(?:de|por|no\s+valor\s+de)\s+)?${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?|segundos?)\b)`)
const AMOUNT_PROSPECTIVE = new RegExp(String.raw`\b(?:tiraria|ganharia|receberia|renderia|pagaria)\s+${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?)\b)`)
const AMOUNT_BEFORE_DISTANCE = new RegExp(String.raw`(?<![\w.,-])${NUMBER}\s+(?:por|em|pra|para|com)\s+\d+(?:[.,]\d+)*\s*(?:kms?|quilometros?|metros?)\b`, 'g')
const OFFER_SEPARATOR = /\s+(?:ou|contra|e(?=\s+(?:a\s+)?outra\b))\s+/
const PICKUP = String.raw`(?:ate\s+(?:(?:o|a)\s+)?(?:passageir[oa]|embarque)|(?:pra|para)\s+(?:(?:o|a)\s+)?(?:buscar|embarcar|embarque)|(?:de|do|pro|para\s+o)\s+embarque|(?:de\s+)?aproximacao)`
const TRIP = String.raw`(?:(?:d[aeo]\s+)?(?:corrida|viagem|trajeto)|ate\s+(?:o\s+)?destino)`
const RETURN = String.raw`(?:(?:d[aeo]\s+|na\s+)?(?:retorno|volta)(?:\s+(?:vazi[oa]|sem\s+passageiro))?|(?:pra|para)\s+voltar(?:\s+(?:vazi[oa]|sem\s+passageiro))?|voltando(?:\s+(?:vazi[oa]|sem\s+passageiro))?)`
const OUTBOUND = String.raw`(?:(?:d[aeo]|na)\s+)?ida`
const TOTAL = String.raw`(?:no\s+total|ao\s+todo|total)`
const SUFFIX = new RegExp(String.raw`^\s+(${PICKUP}|${TRIP}|${RETURN}|${OUTBOUND}|${TOTAL})\b`)
const PREFIX = new RegExp(String.raw`\b(embarque|buscar|passageiro|distancia\s+${PICKUP}|tempo\s+${PICKUP}|distancia\s+${TRIP}|tempo\s+${TRIP}|trajeto|viagem|volto|(?:distancia\s+|tempo\s+)?${RETURN}|${OUTBOUND}|${TOTAL})(?:[\s:]+(?:de|e))?[\s:]+$`)
const IS_PICKUP = /\b(?:embarq\w*|buscar|passageir[oa]|aproximacao)\b/
const IS_RETURN = /\b(?:retorno|volta|volto|voltar|voltando)\b/
const IS_OUTBOUND = /\bida\b/
const IS_TOTAL = new RegExp(String.raw`\b${TOTAL}\b`)
const DISTANCE = new RegExp(String.raw`(?<![\d.,-])${NUMBER}\s*(kms?|quilometros?|m|metros?)\b`, 'g')
const TIME = new RegExp(String.raw`(?<![\d.,-])(?:${COMPOUND_DURATION}|${NUMBER}\s*(min|minutos?|h|horas?))\b`, 'gi')
type Part = keyof Measures
type Quote = Omit<PendingRideOffer, 'missing'>

type RideOfferAnswer = { reply: string; pending?: PendingRideOffer }

function measured(t: string, units: RegExp, readValue: (match: RegExpMatchArray) => number | undefined): Measures | undefined {
  const result: Measures = {}
  for (const match of t.matchAll(units)) {
    const before = t.slice(0, match.index)
    const after = t.slice(match.index + match[0].length)
    const role = after.match(SUFFIX)?.[1] || before.match(PREFIX)?.[1]
    let part: Part = 'unmarked'
    if (role) {
      if (IS_RETURN.test(role)) part = /\b(?:mais|outros)\s*$/i.test(before) ? 'extraReturn' : 'return'
      else if (IS_OUTBOUND.test(role)) part = 'outbound'
      else if (IS_PICKUP.test(role)) part = 'pickup'
      else part = IS_TOTAL.test(role) ? 'total' : 'trip'
    }
    const value = readValue(match)
    if (!Number.isFinite(value) || value < 0 || result[part] !== undefined) return undefined
    result[part] = value
  }
  return result
}

function routeTotal(parts: Measures): number | undefined {
  const { pickup, trip, outbound, return: returning, extraReturn, total, unmarked } = parts
  const pickupAndTrip = pickup !== undefined && trip !== undefined ? pickup + trip : undefined
  const outward = outbound ?? pickupAndTrip
  if (outbound !== undefined && (outbound < Math.max(pickup ?? 0, trip ?? 0)
    || (pickupAndTrip !== undefined && Math.abs(outbound - pickupAndTrip) > 0.05))) return undefined
  if (returning !== undefined && extraReturn !== undefined) return undefined
  if (unmarked !== undefined && Object.keys(parts).length > 1) return undefined
  if (total === undefined) return outward === undefined ? unmarked : outward + (returning ?? extraReturn ?? 0)
  const included = outward === undefined ? undefined : outward + (returning ?? 0)
  if (total < Math.max(pickup ?? 0, trip ?? 0, returning ?? 0, outbound ?? 0)) return undefined
  if (included !== undefined && Math.abs(total - included) > 0.05) return undefined
  if (returning > 0 && outward === undefined) return undefined
  return total + (extraReturn ?? 0)
}

function returnDistance(parts?: Measures): number {
  return parts?.return ?? parts?.extraReturn ?? 0
}

function minutesIncludingReturn(duration: Measures | undefined, distance?: Measures): number | undefined {
  if (returnDistance(distance) > 0 && duration?.total === undefined && duration?.return === undefined && duration?.extraReturn === undefined) return undefined
  return routeTotal(duration || {})
}

function amountForOffer(text: string, elliptical = false): number | undefined {
  const explicit = new Set([...text.matchAll(AMOUNT_WITH_CURRENCY)].map(m => parseMoney(m[1] || m[2])))
  if (explicit.size) return explicit.size === 1 ? explicit.values().next().value : undefined
  const afterNoun = text.match(AMOUNT_AFTER_NOUN)?.[1] || text.match(AMOUNT_PROSPECTIVE)?.[1]
  if (afterNoun) return parseMoney(afterNoun)
  if (!elliptical) return undefined
  const prices = [...text.matchAll(AMOUNT_BEFORE_DISTANCE)].filter(m =>
    !(m[1] === '99' && /\b(?:na|da|pela|via|app)\s*$/.test(text.slice(0, m.index))))
  return prices.length === 1 ? parseMoney(prices[0][1]) : undefined
}

function readDistance(text: string): Measures | undefined {
  return measured(text, DISTANCE, m => parseMoney(m[1]) * (m[2].startsWith('m') ? 0.001 : 1))
}

function offerDistance(parts?: Measures) {
  const km = parts && routeTotal(parts)
  const complete = !!parts && (parts.total !== undefined || (parts.pickup !== undefined && parts.trip !== undefined))
  return { parts, km, complete }
}

function readDuration(text: string): Measures | undefined {
  return measured(text, TIME, m => m[2]
    ? parseMoney(m[1]) * (m[2].startsWith('h') ? 60 : 1)
    : elapsedMinutes(m[0]))
}

const ROTA = 'Diga os km totais ou os km até o passageiro e os km da viagem.'
const DUAS_OFERTAS = 'Diga o valor e a distância de cada oferta. Inclua a ida até o passageiro e o tempo total se souber.'

function compareOffers(state: AppState, parts: string[], question: string): string {
  if (parts.length !== 2) return DUAS_OFERTAS
  const quotes = parts.map(text => {
    const distance = readDistance(text)
    return { value: amountForOffer(text, true), ...offerDistance(distance),
      minutes: minutesIncludingReturn(readDuration(text), distance) }
  })
  if (quotes.some(q => !(q.value > 0) || !(q.km > 0))) return DUAS_OFERTAS

  const cost = kmCost(state)
  const preciseRoute = quotes.every(q => q.complete)
  const hasTime = quotes.every(q => q.minutes > 0)
  const inferHourly = preciseRoute && hasTime && !/\bpor\s+(?:km|quilometro)\b/.test(question)
  const asksHourly = /\bpor\s+hora\b/.test(question)
  const asksProfit = /\blucro\s+total\b/.test(question)
  const fullCost = cost.fuelPerKm > 0
  const labels = ['Primeira', 'Segunda']
  const results = quotes.map(q => analyzeRide(state, q.value, 0, q.km, q.minutes || 0))
  const rates = results.map((r, i) => asksProfit && fullCost ? r.profit
    : inferHourly ? (fullCost ? r.profitPerHour : quotes[i].value * 60 / quotes[i].minutes)
      : r.grossPerKm)
  const criterion = asksProfit && fullCost ? 'lucro estimado'
    : inferHourly ? (fullCost ? 'lucro por hora estimado' : 'receita por hora') : 'valor por km'
  const [a, b] = rates.map(v => Math.round(v * 100))
  const best = `A ${labels[a > b ? 0 : 1].toLowerCase()}`
  const lead = asksHourly && !inferHourly ? 'Para comparar por hora, preciso dos km totais e do tempo total de cada uma.'
    : asksProfit && !fullCost ? 'Para comparar o lucro total, preciso do custo de combustível do veículo.'
      : a === b ? `As duas têm o mesmo ${criterion}.`
        : criterion === 'valor por km' ? `${best} paga mais por km.` : `${best} tem maior ${criterion}.`
  const details = quotes.map((quote, i) => {
    const r = results[i]
    const returning = returnDistance(quote.parts)
    const returnNote = returning ? ` com ${fmtNum(returning)} km de retorno` : ''
    return `• ${labels[i]}. ${fmtBRL(quote.value)} em ${fmtNum(quote.km)} km${returnNote}${quote.minutes ? ` e ${fmtNum(quote.minutes)} min` : ''}. ${fmtBRL(r.grossPerKm)}/km bruto.`
      + (fullCost ? ` Lucro estimado de ${fmtBRL(r.profit)}${quote.minutes ? ` ou ${fmtBRL(r.profitPerHour)}/h` : ''}.`
        : quote.minutes ? ` ${fmtBRL(quote.value * 60 / quote.minutes)}/h bruto.` : '')
  })
  const basis = preciseRoute ? undefined : 'A comparação usa os km informados. Se a ida até o passageiro estiver fora desses km, inclua essa distância.'
  return [lead, details.join('\n'), basis].filter(Boolean).join('\n\n')
}

export function interpretRideOffer(state: AppState, input: string, context = input): RideOfferAnswer | undefined {
  const notice = input.match(RIDE_OFFER_NOTICE)
  if (!isDriver(state.settings) || looksPast(notice ? input.replace(RIDE_OFFER_NOTICE, ' ') : input)) return undefined
  const text = normalizeNumberWords(normalizeName(input)).text
  const compare = RIDE_COMPARISON_REQUEST.test(text)
  if ((!RIDE_EVALUATION_REQUEST.test(text) && !compare) || (!notice && !NOME.test(text))) return undefined
  if (perceivesDrivingFatigue(context)) return { reply: PARE_PARA_DESCANSAR }
  if (!/\d/.test(text) && !notice) return undefined
  const alternatives = text.split(OFFER_SEPARATOR)
  if (compare || alternatives.length > 1) return { reply: compareOffers(state, alternatives, text) }
  return renderOffer(state, { value: amountForOffer(text), distance: readDistance(text), duration: readDuration(text) })
}

export function answerRideOffer(state: AppState, input: string, context = input): string | undefined {
  return interpretRideOffer(state, input, context)?.reply
}

const SPOKEN_AMOUNT = new RegExp(String.raw`^(?:(?:paga|o\s+valor\s+e)\s+)?(?:r\$\s*)?${NUMBER}(?:\s+(?:reais?|contos?|pila))?$`)
const MEASURE_WORDS = new RegExp(String.raw`\b(?:${PICKUP}|${TRIP}|${RETURN}|${OUTBOUND}|${TOTAL}|mais|volto|sao|da|deu|pagam?|e|embarque|buscar|tempo|distancia|aproximacao|de|no|na|em|pra|para|ida)\b`, 'g')
const UNCERTAIN_DETAILS = /\bou\b|\b(?:cerca\s+de|mais\s+ou\s+menos|acho\s+que|talvez)\b/

function combineMeasures(previous?: Measures, next?: Measures, missing?: 'pickup' | 'trip'): Measures | undefined {
  if (!next || !Object.keys(next).length) return previous
  if (next.unmarked !== undefined && missing) return { ...previous, [missing]: next.unmarked }
  if (next.total !== undefined || next.unmarked !== undefined || previous?.unmarked !== undefined) return next
  return { ...previous, ...next }
}

function asksAboutReturn(distance?: Measures): boolean {
  return distance?.total !== undefined && distance.return > 0
    && distance.outbound === undefined && (distance.trip === undefined || distance.pickup === undefined)
}

/** Um dado curto responde apenas à pergunta sobre a oferta em aberto. */
export function continueRideOffer(state: AppState, pending: PendingRideOffer, input: string): RideOfferAnswer | undefined {
  if (!isDriver(state.settings) || looksPast(input)) return undefined
  if (perceivesDrivingFatigue(input)) return { reply: PARE_PARA_DESCANSAR }
  const text = normalizeNumberWords(normalizeName(input)).text.replace(/[.!?]+$/, '').trim()
  if (asksAboutReturn(pending.distance) && /^(?:sim|nao|inclui|incluem|nao\s+inclui|nao\s+incluem)$/.test(text)) {
    const { return: returning, ...distance } = pending.distance
    const includesReturn = !text.startsWith('nao')
    if (includesReturn && distance.total < returning) return renderOffer(state, pending)
    return renderOffer(state, { ...pending, distance: includesReturn
      ? { ...distance, return: returning, outbound: distance.total - returning }
      : { ...distance, extraReturn: returning } })
  }
  const distance = readDistance(text)
  const duration = readDuration(text)
  const saysDistance = !!text.match(DISTANCE)
  const saysDuration = !!text.match(TIME)
  const mentionsMeasure = saysDistance || saysDuration
  const mentionsMoney = /\d/.test(text) && pending.missing === 'value' && !/\b(?:gasto|saldo|recebi|ganhei)\b/.test(text)
  if ((mentionsMeasure || mentionsMoney) && UNCERTAIN_DETAILS.test(text)) return renderOffer(state, pending)
  const bareAmount = pending.missing === 'value' ? text.match(SPOKEN_AMOUNT)?.[1] : undefined
  if (bareAmount) return renderOffer(state, { ...pending, value: parseMoney(bareAmount) })
  if (saysDistance && !distance) return renderOffer(state, pending)
  const remains = text.replace(DISTANCE, ' ').replace(TIME, ' ').replace(AMOUNT_WITH_CURRENCY, ' ')
    .replace(MEASURE_WORDS, ' ').replace(/[\s,;:.]+/g, '')
  if (!mentionsMeasure || remains) return undefined
  const currentPrice = pending.missing === 'value' ? amountForOffer(text) : undefined
  return renderOffer(state, {
    value: currentPrice ?? pending.value,
    distance: combineMeasures(pending.distance, distance, pending.missing === 'pickup' || pending.missing === 'trip' ? pending.missing : undefined),
    duration: combineMeasures(pending.duration, duration),
  })
}

function renderOffer(state: AppState, quote: Quote): RideOfferAnswer {
  const { value } = quote
  if (!(value > 0)) return { reply: 'Qual é o valor que a corrida paga?', pending: { ...quote, missing: 'value' } }
  const { parts: km, km: totalKm, complete: knownRoute } = offerDistance(quote.distance)
  const cost = kmCost(state)
  if (!(totalKm > 0)) {
    if (asksAboutReturn(km)) {
      return { reply: `Os ${fmtNum(km.total)} km no total já incluem os ${fmtNum(km.return)} km de retorno?`,
        pending: { ...quote, missing: 'distance' } }
    }
    if (km?.pickup !== undefined && km.trip === undefined && km.total === undefined) {
      return { reply: 'Quantos km tem a viagem depois do embarque?', pending: { ...quote, missing: 'trip' } }
    }
    if (km?.trip !== undefined && km.pickup === undefined && km.total === undefined) {
      return { reply: 'Quantos km faltam até o passageiro?', pending: { ...quote, missing: 'pickup' } }
    }
    const reference = km && !Object.keys(km).length
      ? cost.minRecommended > 0
        ? ` Pelo seu mínimo de referência de ${fmtBRL(cost.minRecommended)}/km, ${fmtBRL(value)} cobrem até ${fmtNum(value / cost.minRecommended)} km.`
        : ' Também preciso do custo por km para estimar se compensa.'
      : ''
    return { reply: ROTA + reference, pending: { ...quote, missing: 'distance' } }
  }
  const minutes = minutesIncludingReturn(quote.duration, km)
  const returning = returnDistance(km)
  const routeNote = returning ? `\n\nInclui ${fmtNum(returning)} km de retorno.` : ''
  const durationNote = returning && !minutes && Object.keys(quote.duration || {}).length
    ? '\n\nPara calcular por hora, informe o tempo total incluindo o retorno.' : ''
  const head = `Análise da corrida (${fmtNum(totalKm)} km ${knownRoute ? 'no total' : 'informados'})`
  const gross = `• ${fmtBRL(value / totalKm)}/km bruto`
  const incomplete = knownRoute ? '' : '\n\nSe a distância até o passageiro estiver fora desses km, diga quanto falta para recalcular.'
  if (!(cost.total > 0)) {
    return { reply: `${head}\n\n${gross}${routeNote}\n\nCadastre o custo por km do veículo para estimar o lucro.${incomplete}` }
  }
  const result = analyzeRide(state, value, 0, totalKm, minutes ?? 0)
  const rows = [
    gross,
    `• ${fmtBRL(result.netPerKm)}/km líquido estimado`,
    `• Lucro estimado de ${fmtBRL(result.profit)} com os custos cadastrados`,
    minutes && minutes > 0 ? `• ${fmtBRL(result.profitPerHour)}/hora líquida nos ${fmtNum(minutes)} min informados` : undefined,
  ]
  const classifica = knownRoute && cost.fuelPerKm > 0 ? `\n\nPela distância e pelos custos cadastrados, classificação ${result.rating.toLowerCase()}.` : ''
  return { reply: `${head}\n\n${rows.filter(Boolean).join('\n')}${routeNote}${durationNote}${classifica}${incomplete}` }
}
