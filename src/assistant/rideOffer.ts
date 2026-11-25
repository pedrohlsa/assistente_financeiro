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
/**
 * "Uma de 40 pra 30 km, vale?": a corrida fica implícita no "uma de", com valor
 * e distância ditos. Sem "corrida" nem "tocou", a pergunta caía na ajuda.
 */
const UMA_DE_COM_DISTANCIA = /^(?:e\s+)?(?:(?:e\s+)?(?:essa|esta|uma|a)\s+)de\s+(?:r\$\s*)?\d+(?:[.,]\d+)?\s*(?:reais?|contos?|pila)?(?:\s+(?:pra|para|por|em|com|de)\s+|,\s*)\d+(?:[.,]\d+)?\s*(?:kms?|quilometros?)\b/
const NUMBER = String.raw`(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)`
const AMOUNT_WITH_CURRENCY = new RegExp(String.raw`(?<!-)r\$\s*${NUMBER}|(?<![\w.,-])${NUMBER}\s*(?:reais?|contos?|pila)\b`, 'g')
const AMOUNT_AFTER_NOUN = new RegExp(String.raw`\b(?:corridas?|viagem|chamada|proposta|oferta)\s+(?:(?:da|do|na|no|pela|pelo|via)\s+(?:uber|99|indrive[r]?)\s+)?(?:(?:e\s+de|de|por|no\s+valor\s+de|que\s+(?:paga|rende|da|oferece))\s+)?${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?|segundos?)\b)`)
const OFFER_PRICE_HEADING = /^\s*(?:a\s+)?(?:oferta|proposta)\s+(?:e\s+de|de)\s+(?:r\$\s*)?\d/
const TIP_MONEY = String.raw`(?:r\$\s*)?\d+(?:[.,]\d+)*(?!\d|[.,]\d)(?:\s+reais?)?`
const CONDITIONAL_TIP = String.raw`(?:talvez|possivelmente|se\s+(?:tiver|vier|der))`
const ADDITIONAL_TIP = new RegExp(String.raw`(?:(?:\s*\+\s*|\s+(?:e\s+)?mais\s+)(?:(?<maybeAfter>${CONDITIONAL_TIP})\s+)?|\s+(?:e\s+)?(?<maybeBefore>${CONDITIONAL_TIP})\s+)(?:gorjeta\s+de\s+(?<after>${TIP_MONEY})|(?<before>${TIP_MONEY})\s+de\s+gorjeta)\b`)
const AMOUNT_BEFORE_NOUN = new RegExp(String.raw`(?<![\w.,-])${NUMBER}\s+(?:de|da)\s+(?:corridas?|viagem|chamada)\b`)
const AMOUNT_PROSPECTIVE = new RegExp(String.raw`\b(?:tiraria|ganharia|receberia|renderia|pagaria|pagasse|paga|pagando)\s+${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?)\b)`)
const AMOUNT_BEFORE_DISTANCE = new RegExp(String.raw`(?<![\w.,-])${NUMBER}\s+(?:por|em|pra|para|com|e)\s+\d+(?:[.,]\d+)*\s*(?:kms?|quilometros?|metros?)\b`, 'g')
const ONE_OFFER_SHORT = new RegExp(String.raw`\b(?:tocou|apareceu|chegou)\s+uma\s+de\s+${NUMBER}(?!\s*(?:km|quilometros?|metros?|min|minutos?|horas?)\b)`)
const OFFER_SEPARATOR = /\s+(?:ou|contra|versus|vs\.?|e(?=\s+(?:a\s+)?outra\b))\s+/
const ENUMERATED_OFFERS = /\b(?:(?:2|duas)\s+(?:corridas|ofertas)|primeir[ao]\s+(?:corrida|oferta))\b/
const SECOND_OFFER = /[\s.,;]+(?=(?:a\s+)?segund[ao]\s+(?:corrida|oferta)\b)/
const FIRST_OFFER_WITH_AMOUNT = /^(?:a\s+)?primeira\s+(?:(?:e|paga|oferece|de)\s+)?(?:r\$\s*)?\d/
const SECOND_OFFER_WITH_AMOUNT = /(?:[,.;]\s*|\s+e\s+)(?=(?:a\s+)?segunda\s+(?:(?:e|paga|oferece|de)\s+)?(?:r\$\s*)?\d)/
const JOINED_OFFERS = new RegExp(String.raw`\s+e\s+(?=(?:(?:a\s+)?(?:corrida|oferta)\b|r\$\s*\d|\d+(?:[.,]\d+)*\s+reais?\b))`)
const JOINED_ROUTE_QUOTES = /\s+e\s+(?=(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?\s+(?:por|em|pra|para|com)\s+\d+(?:[.,]\d+)*\s*(?:kms?|quilometros?)\b)/
const COMPARA_DOIS = /\bqual\s+(?:(?:das?\s+)?(?:corridas?|ofertas?)\s+)?(?:(?:da|tem)\s+(?:mais\s+lucro|maior\s+lucro)|(?:paga|rende|da)\s+mais|e\s+(?:a\s+)?(?:melhor|mais\s+lucrativ[ao])|(?:tem\s+)?[oa]\s+(?:(?:melhor|maior)\s+)?(?:ganho|lucro|rendimento|receita)\s+(?:(?:brut[oa]|liquid[oa])\s+)?por\s+(?:hora|minuto|km|quilometro))\b|\bqual\s+compensa\b|\bvale\s+mais\b|^vale\s+a\s+pena\s+a\s+de\b/
const RIDER_ON_BOARD = String.raw`(?:(?:n[oa]\s+trecho\s+)?com\s+(?:[ao]\s+)?passageir[oa](?:\s+a\s+bordo)?|levando\s+(?:[ao]\s+)?passageir[oa])`
const PICKUP = String.raw`(?:ate\s+(?:(?:o|a)\s+)?(?:passageir[oa]|embarque)|ate\s+(?:buscar|pegar|embarcar)(?:\s+(?:[ao]\s+)?passageir[oa])?|(?:(?:pra|para)\s+(?:(?:o|a)\s+)?(?:buscar|embarcar|embarque|passageir[oa])|(?:pro|pra)\s+passageir[oa])|(?:de|do|pro|para\s+o)\s+embarque|(?:de\s+)?aproximacao|passageir[oa])`
const TRIP = String.raw`(?:(?:d[aeo]\s+)?(?:corrida|viagem|trajeto)|${RIDER_ON_BOARD}|ate\s+(?:o\s+)?destino)`
const RETURN = String.raw`(?:(?:d[aeo]\s+|na\s+)?(?:retorno|volta)(?:\s+(?:vazi[oa]|sem\s+passageiro))?|(?:pra|para)\s+voltar(?:\s+(?:vazi[oa]|sem\s+passageiro))?|voltando(?:\s+(?:vazi[oa]|sem\s+passageiro))?|vazi[oa]s?\s+na\s+volta|(?:vou\s+)?voltar(?:\s+(?:uns|umas|aproximadamente|cerca\s+de))?)`
const OUTBOUND_WITH_PICKUP = String.raw`ate\s+(?:o\s+)?destino\s*,?\s+(?:com|contando|incluindo)\s+(?:o\s+)?embarque`
const INCLUDES_PICKUP = new RegExp(String.raw`^${OUTBOUND_WITH_PICKUP}$`)
const OUTBOUND = String.raw`(?:(?:d[aeo]|na)\s+)?ida`
const TOTAL = String.raw`(?:no\s+total|ao\s+todo|tota(?:l|is)|contando\s+(?:a\s+)?ida\s+${PICKUP}|(?:(?:contando|de)\s+)?(?:a\s+)?ida\s+e\s+(?:a\s+)?volta)`
const SUFFIX = new RegExp(String.raw`^\s+(?:(?:so|somente|apenas)\s+)?(${TOTAL}|${OUTBOUND_WITH_PICKUP}|${PICKUP}|${TRIP}|${RETURN}|${OUTBOUND})\b`)
const PREFIX = new RegExp(String.raw`\b(embarque|buscar|passageiro|distancia\s+${PICKUP}|tempo\s+${PICKUP}|distancia\s+${TRIP}|tempo\s+${TRIP}|trajeto|viagem|volto|(?:distancia\s+|tempo\s+)?${RETURN}|${OUTBOUND}|${TOTAL})(?:[\s:]+(?:de|e))?[\s:]+$`)
const IS_PICKUP = /\b(?:emba(?:rq|rc)\w*|buscar|pegar|passageir[oa]|aproximacao)\b/
const IS_RETURN = /\b(?:retorno|volta|volto|voltar|voltando)\b/
const WITH_PASSENGER = new RegExp(String.raw`^${RIDER_ON_BOARD}$`)
const IS_OUTBOUND = /\bida\b/
const IS_TOTAL = new RegExp(String.raw`\b${TOTAL}\b`)
const DISTANCE = new RegExp(String.raw`(?<![\d.,-])${NUMBER}\s*(kms?|quilometros?|m|metros?)\b`, 'g')
const TIME = new RegExp(String.raw`(?<![\d.,-])(?:${COMPOUND_DURATION}|${NUMBER}\s*(min|minutos?|h|horas?))\b`, 'gi')
const SHARED_ROUTE_ROLE = String.raw`(?:${PICKUP}|d[aeo]\s+(?:viagem|trajeto)|${RIDER_ON_BOARD}|${RETURN})\b`
const ROUTE_LIST_SEPARATOR = String.raw`(?:,\s*(?:e\s+)?|\s+e\s+)`
const ROUTE_LIST_VALUE = String.raw`${ROUTE_LIST_SEPARATOR}${NUMBER}\s+${SHARED_ROUTE_ROLE}`
const ROUTE_UNIT_LIST = new RegExp(String.raw`\b\d+(?:[.,]\d+)*\s*(?<unit>kms?|quilometros?|min|minutos?)\s+${SHARED_ROUTE_ROLE}(?<items>(?:${ROUTE_LIST_VALUE})+)`, 'g')
const UNITLESS_ROUTE_MEASURE = new RegExp(String.raw`(${ROUTE_LIST_SEPARATOR})${NUMBER}(?=\s+${SHARED_ROUTE_ROLE})`, 'g')
type Part = keyof Measures
type Quote = Omit<PendingRideOffer, 'missing'>

type RideOfferAnswer = { reply: string; pending?: PendingRideOffer; done?: Quote }

function expandSharedRouteUnits(text: string): string {
  return text.replace(ROUTE_UNIT_LIST, (whole, ...captures) => {
    const { unit, items } = captures[captures.length - 1] as { unit: string; items: string }
    return whole.slice(0, -items.length) + items.replace(UNITLESS_ROUTE_MEASURE, `$1$2 ${unit}`)
  })
}

function normalizeRideOfferText(input: string): string {
  // O ditado pode separar o preço e a distância com vírgula. Dígitos grudados
  // na vírgula continuam sendo decimais, e “vírgula” por extenso também.
  const text = normalizeName(input).replace(/\bcompenca\b/g, 'compensa').replace(/\bvali\s+a\s+pena\b/g, 'vale a pena')
    .replace(/\bcoriida\b/g, 'corrida').replace(/\bgorgeta\b/g, 'gorjeta')
  const chunks = text.split(/,\s+/).map(part => normalizeNumberWords(part).text)
  return expandSharedRouteUnits(chunks.join(', '))
}

function measured(t: string, units: RegExp, readValue: (match: RegExpMatchArray) => number | undefined): Measures | undefined {
  const result: Measures = {}
  for (const match of t.matchAll(units)) {
    const before = t.slice(0, match.index)
    const after = t.slice(match.index + match[0].length)
    const suffix = after.match(SUFFIX)
    const role = suffix?.[1] || before.match(PREFIX)?.[1]
    let part: Part = 'unmarked'
    if (role) {
      if (IS_TOTAL.test(role)) part = 'total'
      else if (INCLUDES_PICKUP.test(role)) part = 'outboundWithPickup'
      else if (IS_RETURN.test(role)) {
        const apart = suffix && /^\s+(?:a\s+parte|por\s+fora)\b/.test(after.slice(suffix[0].length))
        part = apart || /\b(?:mais|outros)\s*$/i.test(before) ? 'extraReturn' : 'return'
      }
      else if (IS_OUTBOUND.test(role)) part = 'outbound'
      else if (IS_PICKUP.test(role) && !WITH_PASSENGER.test(role)) part = 'pickup'
      else part = 'trip'
    }
    const value = readValue(match)
    if (!Number.isFinite(value) || value < 0 || result[part] !== undefined) return undefined
    result[part] = value
  }
  return result
}

function routeTotal(parts: Measures): number | undefined {
  const { pickup, trip, outbound: reportedOutbound, outboundWithPickup, return: returning, extraReturn, total, unmarked } = parts
  if (reportedOutbound !== undefined && outboundWithPickup !== undefined && Math.abs(reportedOutbound - outboundWithPickup) > 0.05) return undefined
  const outbound = outboundWithPickup ?? reportedOutbound
  const pickupAndTrip = pickup !== undefined && trip !== undefined ? pickup + trip : undefined
  const outward = outbound ?? pickupAndTrip
  if (outbound !== undefined && (outbound < Math.max(pickup ?? 0, trip ?? 0)
    || (pickupAndTrip !== undefined && Math.abs(outbound - pickupAndTrip) > 0.05))) return undefined
  if (returning !== undefined && extraReturn !== undefined) return undefined
  if (unmarked !== undefined && Object.keys(parts).length > 1) {
    return extraReturn !== undefined && Object.keys(parts).length === 2 ? unmarked + extraReturn : undefined
  }
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
  const onlyOutbound = duration?.outbound !== undefined && distance?.outbound === undefined && distance?.outboundWithPickup === undefined
  const noReturnTime = duration?.total === undefined && duration?.return === undefined && duration?.extraReturn === undefined
  if (noReturnTime && (returnDistance(distance) > 0 || onlyOutbound)) return undefined
  return routeTotal(duration || {})
}

function amountForOffer(text: string, elliptical = false): number | undefined {
  const explicit = new Set([...text.matchAll(AMOUNT_WITH_CURRENCY)].map(m => parseMoney(m[1] || m[2])))
  if (explicit.size) return explicit.size === 1 ? explicit.values().next().value : undefined
  const afterNoun = text.match(AMOUNT_AFTER_NOUN)?.[1] || text.match(AMOUNT_BEFORE_NOUN)?.[1] || text.match(AMOUNT_PROSPECTIVE)?.[1] || text.match(ONE_OFFER_SHORT)?.[1]
    || (UMA_DE_COM_DISTANCIA.test(text) ? text.match(/\bde\s+(?:r\$\s*)?(\d+(?:[.,]\d+)?)/)?.[1] : undefined)
  if (afterNoun) return parseMoney(afterNoun)
  if (!elliptical) return undefined
  const prices = [...text.matchAll(AMOUNT_BEFORE_DISTANCE)].filter(m =>
    !(m[1] === '99' && /\b(?:na|da|pela|via|app)\s*$/.test(text.slice(0, m.index))))
  return prices.length === 1 ? parseMoney(prices[0][1]) : undefined
}

type OfferPrice = Pick<Quote, 'value' | 'tip'>

function readOfferPrice(text: string, elliptical = false): OfferPrice {
  const extra = text.match(ADDITIONAL_TIP)
  if (!extra) return { value: amountForOffer(text, elliptical), tip: undefined }
  const { before, after, maybeBefore, maybeAfter } = extra.groups
  const amount = parseMoney((before || after).match(NUMBER)?.[1])
  const fareText = text.slice(0, extra.index) + text.slice(extra.index + extra[0].length)
  return { value: amountForOffer(fareText, elliptical), tip: { amount, conditional: !!(maybeBefore || maybeAfter) } }
}

function totalOfferValue({ value, tip }: OfferPrice): number | undefined {
  return tip && !tip.conditional && value !== undefined ? (Math.round(value * 100) + Math.round(tip.amount * 100)) / 100 : value
}

function offerTipNote(price: OfferPrice): string {
  if (!price.tip || price.value === undefined) return ''
  const { amount, conditional } = price.tip
  return conditional ? `A estimativa usa a tarifa de ${fmtBRL(price.value)}. A gorjeta possível é de ${fmtBRL(amount)}.`
    : `Tarifa de ${fmtBRL(price.value)} mais ${fmtBRL(amount)} de gorjeta, total de ${fmtBRL(totalOfferValue(price))}.`
}

function readDistance(text: string): Measures | undefined {
  return measured(text, DISTANCE, m => parseMoney(m[1]) * (m[2].startsWith('m') ? 0.001 : 1))
}

function offerDistance(parts?: Measures) {
  const km = parts && routeTotal(parts)
  const complete = !!parts && (parts.total !== undefined || parts.outboundWithPickup !== undefined || (parts.pickup !== undefined && parts.trip !== undefined))
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
    const price = readOfferPrice(text, true)
    return { value: totalOfferValue(price), tipNote: offerTipNote(price), ...offerDistance(distance),
      minutes: minutesIncludingReturn(readDuration(text), distance) }
  })
  if (quotes.some(q => !(q.value > 0) || !(q.km > 0))) return DUAS_OFERTAS

  const cost = kmCost(state)
  const preciseRoute = quotes.every(q => q.complete)
  const hasTime = quotes.every(q => q.minutes > 0)
  const asksKm = /\bpor\s+(?:km|quilometro)\b/.test(question)
  const mentionsProfit = /\b(?:lucro|lucrativ[ao]|liquid[oa])\b/.test(question)
  const asksNetKm = asksKm && mentionsProfit
  const canCompareTime = preciseRoute && hasTime && !asksKm
  const asksTime = question.match(/\bpor\s+(hora|minuto)\b/)?.[1]
  const perMinute = asksTime === 'minuto'
  const timeUnit = perMinute ? 'minuto' : 'hora'
  const timeSuffix = perMinute ? 'min' : 'h'
  const minutesPerUnit = perMinute ? 1 : 60
  const asksGross = /\b(?:receita|faturamento|brut[oa])\b/.test(question)
  const asksProfit = !asksKm && !asksTime && /\b(?:lucro\s+total|mais\s+lucrativ[ao]|(?:mais|maior)\s+lucro)\b/.test(question)
  const fullCost = cost.fuelPerKm > 0
  const profitByTime = fullCost && !asksGross
  const labels = ['Primeira', 'Segunda']
  const results = quotes.map(q => analyzeRide(state, q.value, 0, q.km, q.minutes || 0))
  const rates = results.map((r, i) => asksProfit && fullCost ? r.profit
    : asksNetKm && fullCost ? r.netPerKm
      : canCompareTime ? (profitByTime ? r.profit : quotes[i].value) * minutesPerUnit / quotes[i].minutes
        : r.grossPerKm)
  const criterion = asksProfit && fullCost ? 'lucro estimado'
    : asksNetKm && fullCost ? 'lucro por km estimado'
      : canCompareTime ? (profitByTime ? `lucro por ${timeUnit} estimado` : `receita por ${timeUnit}`) : 'valor por km'
  const [a, b] = rates.map(v => Math.round(v * 100))
  const best = `A ${labels[a > b ? 0 : 1].toLowerCase()}`
  const lead = asksTime && !canCompareTime ? `Para comparar por ${timeUnit}, preciso dos km totais e do tempo total de cada uma.`
    : (asksProfit || asksNetKm) && !fullCost ? 'Para comparar o lucro, preciso do custo de combustível do veículo.'
      : a === b ? `As duas têm o mesmo ${criterion}.`
        : criterion === 'valor por km' ? `${best} paga mais por km.` : `${best} tem maior ${criterion}.`
  const details = quotes.map((quote, i) => {
    const r = results[i]
    const returning = returnDistance(quote.parts)
    const returnNote = returning ? ` com ${fmtNum(returning)} km de retorno` : ''
    return `• ${labels[i]}. ${fmtBRL(quote.value)} em ${fmtNum(quote.km)} km${returnNote}${quote.minutes ? ` e ${fmtNum(quote.minutes)} min` : ''}. ${fmtBRL(r.grossPerKm)}/km bruto.`
      + (asksNetKm && fullCost ? ` ${fmtBRL(r.netPerKm)}/km líquido.` : '')
      + (fullCost ? ` Lucro estimado de ${fmtBRL(r.profit)}${quote.minutes && profitByTime ? ` ou ${fmtBRL(r.profit * minutesPerUnit / quote.minutes)}/${timeSuffix}` : ''}.` : '')
      + (quote.minutes && !profitByTime ? ` ${fmtBRL(quote.value * minutesPerUnit / quote.minutes)}/${timeSuffix} bruto.` : '')
      + (quote.tipNote ? ` ${quote.tipNote}` : '')
  })
  const basis = preciseRoute ? undefined : 'A comparação usa os km informados. Se a ida até o passageiro estiver fora desses km, inclua essa distância.'
  return [lead, details.join('\n'), basis].filter(Boolean).join('\n\n')
}

function splitOffers(text: string): string[] {
  const alternatives = text.split(OFFER_SEPARATOR)
  if (alternatives.length > 1) return alternatives
  if (FIRST_OFFER_WITH_AMOUNT.test(text)) {
    const numbered = text.split(SECOND_OFFER_WITH_AMOUNT)
    if (numbered.length > 1) return numbered
  }
  if (ENUMERATED_OFFERS.test(text)) {
    const numbered = text.split(SECOND_OFFER)
    if (numbered.length > 1) return numbered
    const joined = text.split(JOINED_OFFERS)
    if (joined.length > 1) return joined
  }
  return COMPARA_DOIS.test(text) ? text.split(JOINED_ROUTE_QUOTES) : alternatives
}

export function interpretRideOffer(state: AppState, input: string, context = input): RideOfferAnswer | undefined {
  const notice = input.match(RIDE_OFFER_NOTICE)
  if (!isDriver(state.settings) || looksPast(notice ? input.replace(RIDE_OFFER_NOTICE, ' ') : input)) return undefined
  const text = normalizeRideOfferText(input)
  const compare = RIDE_COMPARISON_REQUEST.test(text)
  const alternatives = splitOffers(text)
  const enumerated = ENUMERATED_OFFERS.test(text) && COMPARA_DOIS.test(text)
  const comparesTwo = alternatives.length === 2 && (compare || COMPARA_DOIS.test(text))
    && alternatives.every(part => readOfferPrice(part, true).value !== undefined && !!part.match(DISTANCE))
  const price = readOfferPrice(text)
  const quotedRoute = price.value !== undefined && !!text.match(DISTANCE)
    && (price.tip || OFFER_PRICE_HEADING.test(text) || /\b(?:ida|volta|voltando|voltar|retorno|embarque|passageiro|destino|aproximacao)\b/.test(text))
  if ((!RIDE_EVALUATION_REQUEST.test(text) && !compare && !comparesTwo && !enumerated)
    || (!notice && !NOME.test(text) && !comparesTwo && !enumerated && !UMA_DE_COM_DISTANCIA.test(text) && !quotedRoute)) return undefined
  if (perceivesDrivingFatigue(context)) return { reply: PARE_PARA_DESCANSAR }
  if (!/\d/.test(text) && !notice) return undefined
  if (compare || enumerated || alternatives.length > 1) return { reply: compareOffers(state, alternatives, text) }
  return renderOffer(state, { ...price, distance: readDistance(text), duration: readDuration(text) })
}

export function answerRideOffer(state: AppState, input: string, context = input): string | undefined {
  return interpretRideOffer(state, input, context)?.reply
}

const SPOKEN_AMOUNT = new RegExp(String.raw`^(?:(?:paga|o\s+valor\s+e)\s+)?(?:r\$\s*)?${NUMBER}(?:\s+(?:reais?|contos?|pila))?$`)
const MEASURE_WORDS = new RegExp(String.raw`\b(?:${OUTBOUND_WITH_PICKUP}|${PICKUP}|${TRIP}|${RETURN}|${OUTBOUND}|${TOTAL}|mais|volto|sao|da|deu|pagam?|e|embarque|buscar|tempo|distancia|aproximacao|de|no|na|em|pra|para|ida|[ao])\b`, 'g')
const UNCERTAIN_DETAILS = /\bou\b|\b(?:cerca\s+de|mais\s+ou\s+menos|acho\s+que|talvez)\b/

function onlyRideMeasures(text: string): boolean {
  return !text.replace(DISTANCE, ' ').replace(TIME, ' ').replace(MEASURE_WORDS, ' ').replace(/[\s,;:.]+/g, '')
}

function combineMeasures(previous?: Measures, next?: Measures, missing?: 'pickup' | 'trip'): Measures | undefined {
  if (!next || !Object.keys(next).length) return previous
  if (next.unmarked !== undefined && missing) return { ...previous, [missing]: next.unmarked }
  if (next.total !== undefined || next.unmarked !== undefined || previous?.unmarked !== undefined) return next
  return { ...previous, ...next }
}

function asksAboutReturn(distance?: Measures): boolean {
  return distance?.total !== undefined && distance.return > 0
    && distance.outbound === undefined && distance.outboundWithPickup === undefined && (distance.trip === undefined || distance.pickup === undefined)
}

/** Um dado curto responde apenas à pergunta sobre a oferta em aberto. */
export function continueRideOffer(state: AppState, pending: PendingRideOffer, input: string): RideOfferAnswer | undefined {
  if (!isDriver(state.settings) || looksPast(input)) return undefined
  if (perceivesDrivingFatigue(input)) return { reply: PARE_PARA_DESCANSAR }
  const text = normalizeRideOfferText(input).replace(/[.!?]+$/, '').trim()
  const saidIncluded = /^(?:sim|(?:ja\s+)?inclu(?:i|em)(?:\s+(?:a\s+)?volta|\s+(?:o\s+)?retorno)?)$/.test(text)
  const saidExcluded = /^(?:nao(?:\s+inclu(?:i|em)(?:\s+(?:a\s+)?volta|\s+(?:o\s+)?retorno)?)?|(?:so|somente)\s+(?:a\s+|de\s+)?ida)$/.test(text)
  const saidOutward = text.match(/^(?:os\s+)?(\d+(?:[.,]\d+)*)(?:\s*km)?\s+(?:sao|e)\s+(?:so|somente)\s+(?:a\s+|de\s+)?ida$/)
  if (asksAboutReturn(pending.distance) && (saidIncluded || saidExcluded || (saidOutward && parseMoney(saidOutward[1]) === pending.distance.total))) {
    const { return: returning, ...distance } = pending.distance
    const includesReturn = saidIncluded
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
  const currentPrice = pending.missing === 'value' ? readOfferPrice(text) : undefined
  return renderOffer(state, {
    value: currentPrice?.value ?? pending.value,
    tip: currentPrice?.tip ?? pending.tip,
    distance: combineMeasures(pending.distance, distance, pending.missing === 'pickup' || pending.missing === 'trip' ? pending.missing : undefined),
    duration: combineMeasures(pending.duration, duration),
  })
}

function renderOffer(state: AppState, quote: Quote): RideOfferAnswer {
  const value = totalOfferValue(quote)
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
  const durationNote = !minutes && (returning || (quote.duration && Object.keys(quote.duration).length))
    ? `\n\nPara calcular por hora, informe o tempo total${returning ? ' incluindo o retorno' : ' do trajeto'}.` : ''
  const tipNote = offerTipNote(quote)
  const head = `Análise da corrida (${fmtNum(totalKm)} km ${knownRoute ? 'no total' : 'informados'})${tipNote ? `\n\n${tipNote}` : ''}`
  const gross = `• ${fmtBRL(value / totalKm)}/km bruto`
  const incomplete = knownRoute ? '' : '\n\nSe a distância até o passageiro estiver fora desses km, diga quanto falta para recalcular.'
  if (!(cost.total > 0)) {
    return { reply: `${head}\n\n${gross}${routeNote}${durationNote}\n\nCadastre o custo por km do veículo para estimar o lucro.${incomplete}`, done: quote }
  }
  const result = analyzeRide(state, value, 0, totalKm, minutes ?? 0)
  const rows = [
    gross,
    `• ${fmtBRL(result.netPerKm)}/km líquido estimado`,
    `• Lucro estimado de ${fmtBRL(result.profit)} com os custos cadastrados`,
    minutes && minutes > 0 ? `• ${fmtBRL(result.profitPerHour)}/hora líquida nos ${fmtNum(minutes)} min informados` : undefined,
  ]
  const classifica = knownRoute && cost.fuelPerKm > 0 ? `\n\nPela distância e pelos custos cadastrados, classificação ${result.rating.toLowerCase()}.` : ''
  return { reply: `${head}\n\n${rows.filter(Boolean).join('\n')}${routeNote}${durationNote}${classifica}${incomplete}`, done: quote }
}

const REVISAO = /^(?:na\s+verdade|alias|corrigindo|errei|me\s+enganei|ops|e\s+se|e\s+com|e\s+(?:o|a)|mas)\b/
const PARTE_DA_ROTA = /\b(?:retorno|volta|voltando|embarque|passageiro|buscar|viagem|corrida|tempo|minutos?|min|horas?|km|quilometros?|paga|pagasse|pagando|valor|reais|r\$)\b/

/**
 * "Na verdade o retorno era 7 km", "e se pagasse 30?": a análise JÁ DADA é
 * refeita com o dado trocado. Antes, a correção sem nada na tela era lida
 * como "não tenho proposta para corrigir", e o motorista ficava com a conta
 * velha.
 */
export function reviseRideOffer(state: AppState, last: Quote, input: string): RideOfferAnswer | undefined {
  if (!isDriver(state.settings) || looksPast(input)) return undefined
  const text = normalizeRideOfferText(input).replace(/[.!?]+$/, '').trim()
  const addMeasures = (/\d/.test(text) && onlyRideMeasures(text))
  if ((!addMeasures && (!REVISAO.test(text) || !PARTE_DA_ROTA.test(text))) || !/\d/.test(text)) return undefined
  if (/\b(?:paguei|gastei|recebi|ganhei|rodei|fiz|abasteci)\b/.test(text)) return undefined
  let distance = readDistance(text)
  // "O retorno ERA 7 km": o verbo no meio esconde o trecho do leitor de
  // distâncias, e o 7 sem rótulo trocava a rota inteira por 7 km.
  if (distance && distance.unmarked !== undefined && Object.keys(distance).length === 1) {
    const trecho = /\b(?:retorno|volta|voltando)\b/.test(text) ? 'return'
      : /\b(?:passageiro|embarque|buscar)\b/.test(text) ? 'pickup'
        : /\bviagem\b/.test(text) ? 'trip' : undefined
    if (trecho) distance = { [trecho]: distance.unmarked } as Measures
  }
  let duration = readDuration(text)
  if (addMeasures && duration?.unmarked !== undefined && returnDistance(last.distance) > 0
    && minutesIncludingReturn(last.duration, last.distance) === undefined) duration = { total: duration.unmarked }
  const precoNovo = /\b(?:paga|pagasse|pagando|valor|reais|r\$)\b/.test(text) ? readOfferPrice(text) : undefined
  if (!distance && !duration && !(precoNovo?.value > 0)) return undefined
  return renderOffer(state, {
    ...last,
    ...(precoNovo?.value > 0 ? precoNovo : {}),
    distance: combineMeasures(last.distance, distance),
    duration: combineMeasures(last.duration, duration),
  })
}
