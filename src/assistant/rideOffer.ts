import type { AppState } from '../models/types'
import { analyzeRide, kmCost } from '../services/calc'
import { RIDE_OFFER_NOTICE } from '../services/nlp'
import { isDriver } from '../services/profile'
import { fmtBRL, fmtNum, parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { looksPast } from './clauses'
import { PARE_PARA_DESCANSAR, perceivesDrivingFatigue } from './driverAdvice'
import { normalizeNumberWords } from './numbers'

const PEDIDO = /\b(?:vale(?:\s+a\s+pena)?|compensa|aceito|pego|(?:devo|posso|vale)\s+(?:aceitar|pegar)|(?:da|serve)\s+(?:pra|para)\s+(?:aceitar|pegar))\b/
const COMPARAR = /\b(?:compara|compare|comparar|comparando|qual\s+(?:dessas?\s+)?(?:corrida|oferta)s?\s+(?:paga|rende)\s+mais)\b/
const NOME = /\b(?:corridas?|viagem|chamada)\b/
const NUMBER = String.raw`(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)`
const AMOUNT_WITH_CURRENCY = new RegExp(String.raw`(?<!-)r\$\s*${NUMBER}|(?<![\w.,-])${NUMBER}\s*(?:reais?|contos?|pila)\b`, 'g')
const AMOUNT_AFTER_NOUN = new RegExp(String.raw`\b(?:corridas?|viagem|chamada)\s+(?:(?:da|do|na|no|pela|pelo|via)\s+(?:uber|99|indrive[r]?)\s+)?(?:(?:de|por|no\s+valor\s+de)\s+)?${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?|segundos?)\b)`)
const AMOUNT_BEFORE_DISTANCE = new RegExp(String.raw`(?<![\w.,-])${NUMBER}\s+(?:por|em|pra|para|com)\s+\d+(?:[.,]\d+)*\s*(?:kms?|quilometros?|metros?)\b`, 'g')
const OFFER_SEPARATOR = /\s+(?:ou|contra|e(?=\s+(?:a\s+)?outra\b))\s+/
const PICKUP = String.raw`(?:ate\s+(?:(?:o|a)\s+)?(?:passageir[oa]|embarque)|(?:pra|para)\s+(?:(?:o|a)\s+)?(?:buscar|embarcar|embarque)|(?:de|do|pro|para\s+o)\s+embarque|(?:de\s+)?aproximacao)`
const TRIP = String.raw`(?:(?:d[aeo]\s+)?(?:corrida|viagem|trajeto)|ate\s+(?:o\s+)?destino)`
const TOTAL = String.raw`(?:no\s+total|ao\s+todo|total)`
const SUFFIX = new RegExp(String.raw`^\s+(${PICKUP}|${TRIP}|${TOTAL})\b`)
const PREFIX = new RegExp(String.raw`\b(embarque|buscar|passageiro|distancia\s+${PICKUP}|tempo\s+${PICKUP}|distancia\s+${TRIP}|tempo\s+${TRIP}|trajeto|viagem|${TOTAL})(?:[\s:]+(?:de|e))?[\s:]+$`)
const IS_PICKUP = /\b(?:embarq\w*|buscar|passageir[oa]|aproximacao)\b/
const IS_TOTAL = new RegExp(String.raw`\b${TOTAL}\b`)
const DISTANCE = new RegExp(String.raw`(?<![\d.,-])${NUMBER}\s*(kms?|quilometros?|m|metros?)\b`, 'g')
const TIME = new RegExp(String.raw`(?<![\d.,-])${NUMBER}\s*(min|minutos?|h|horas?)\b`, 'g')
type Part = 'pickup' | 'trip' | 'total' | 'unmarked'

function measured(t: string, units: RegExp): Partial<Record<Part, number>> | undefined {
  const result: Partial<Record<Part, number>> = {}
  for (const match of t.matchAll(units)) {
    const before = t.slice(0, match.index)
    const after = t.slice(match.index + match[0].length)
    const role = after.match(SUFFIX)?.[1] || before.match(PREFIX)?.[1]
    const part = !role ? 'unmarked' : IS_PICKUP.test(role) ? 'pickup' : IS_TOTAL.test(role) ? 'total' : 'trip'
    const unitScale = /^h/.test(match[2]) ? 60 : units === DISTANCE && /^m/.test(match[2]) ? 0.001 : 1
    const value = parseMoney(match[1]) * unitScale
    if (!Number.isFinite(value) || value < 0 || result[part] !== undefined) return undefined
    result[part] = value
  }
  return result
}

function routeTotal(parts: Partial<Record<Part, number>>): number | undefined {
  const { pickup, trip, total, unmarked } = parts
  const split = pickup !== undefined && trip !== undefined ? pickup + trip : undefined
  if (total !== undefined && total < Math.max(pickup ?? 0, trip ?? 0)) return undefined
  if (total !== undefined && split !== undefined && Math.abs(total - split) > 0.05) return undefined
  if (unmarked !== undefined && Object.keys(parts).length > 1) return undefined
  return total ?? split ?? unmarked
}

function amountForOffer(text: string, elliptical = false): number | undefined {
  const explicit = new Set([...text.matchAll(AMOUNT_WITH_CURRENCY)].map(m => parseMoney(m[1] || m[2])))
  if (explicit.size) return explicit.size === 1 ? explicit.values().next().value : undefined
  const afterNoun = text.match(AMOUNT_AFTER_NOUN)?.[1]
  if (afterNoun) return parseMoney(afterNoun)
  if (!elliptical) return undefined
  const prices = [...text.matchAll(AMOUNT_BEFORE_DISTANCE)].filter(m =>
    !(m[1] === '99' && /\b(?:na|da|pela|via|app)\s*$/.test(text.slice(0, m.index))))
  return prices.length === 1 ? parseMoney(prices[0][1]) : undefined
}

function offerDistance(text: string) {
  const parts = measured(text, DISTANCE)
  const km = parts && routeTotal(parts)
  const complete = !!parts && (parts.total !== undefined || (parts.pickup !== undefined && parts.trip !== undefined))
  return { parts, km, complete }
}

function offerMinutes(text: string): number | undefined {
  const times = measured(text, TIME)
  return times && routeTotal(times)
}

const ROTA = 'Diga os km totais ou os km até o passageiro e os km da viagem.'
const DUAS_OFERTAS = 'Diga o valor e a distância de cada oferta. Inclua a ida até o passageiro e o tempo total se souber.'

function compareOffers(state: AppState, parts: string[], question: string): string {
  if (parts.length !== 2) return DUAS_OFERTAS
  const quotes = parts.map(text => ({ value: amountForOffer(text, true), ...offerDistance(text), minutes: offerMinutes(text) }))
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
    return `• ${labels[i]}. ${fmtBRL(quote.value)} em ${fmtNum(quote.km)} km${quote.minutes ? ` e ${fmtNum(quote.minutes)} min` : ''}. ${fmtBRL(r.grossPerKm)}/km bruto.`
      + (fullCost ? ` Lucro estimado de ${fmtBRL(r.profit)}${quote.minutes ? ` ou ${fmtBRL(r.profitPerHour)}/h` : ''}.`
        : quote.minutes ? ` ${fmtBRL(quote.value * 60 / quote.minutes)}/h bruto.` : '')
  })
  const basis = preciseRoute ? undefined : 'A comparação usa os km informados. Se a ida até o passageiro estiver fora desses km, inclua essa distância.'
  return [lead, details.join('\n'), basis].filter(Boolean).join('\n\n')
}

export function answerRideOffer(state: AppState, input: string, context = input): string | undefined {
  const notice = input.match(RIDE_OFFER_NOTICE)
  if (!isDriver(state.settings) || looksPast(notice ? input.replace(RIDE_OFFER_NOTICE, ' ') : input)) return undefined
  const t = normalizeNumberWords(normalizeName(input)).text
  const compare = COMPARAR.test(t)
  if ((!PEDIDO.test(t) && !compare) || (!notice && !NOME.test(t))) return undefined
  if (perceivesDrivingFatigue(context)) return PARE_PARA_DESCANSAR
  if (!/\d/.test(t)) return undefined
  const alternatives = t.split(OFFER_SEPARATOR)
  if (compare || alternatives.length > 1) return compareOffers(state, alternatives, t)
  const value = amountForOffer(t)
  if (!(value > 0)) return 'Qual é o valor que a corrida paga?'
  const { parts: km, km: totalKm, complete: knownRoute } = offerDistance(t)
  const cost = kmCost(state)
  if (!km || totalKm === undefined || !(totalKm > 0)) {
    if (!km || Object.keys(km).length) return ROTA
    const reference = cost.minRecommended > 0
      ? ` Pelo seu mínimo de referência de ${fmtBRL(cost.minRecommended)}/km, ${fmtBRL(value)} cobrem até ${fmtNum(value / cost.minRecommended)} km.`
      : ' Também preciso do custo por km para estimar se compensa.'
    return ROTA + reference
  }
  const minutes = offerMinutes(t)
  const head = `Análise da corrida (${fmtNum(totalKm)} km ${knownRoute ? 'no total' : 'informados'})`
  const gross = `• ${fmtBRL(value / totalKm)}/km bruto`
  const incomplete = knownRoute ? '' : '\n\nSe a distância até o passageiro estiver fora desses km, diga quanto falta para recalcular.'
  if (!(cost.total > 0)) {
    return `${head}\n\n${gross}\n\nCadastre o custo por km do veículo para estimar o lucro.${incomplete}`
  }
  const result = analyzeRide(state, value, 0, totalKm, minutes ?? 0)
  const rows = [
    gross,
    `• ${fmtBRL(result.netPerKm)}/km líquido estimado`,
    `• Lucro estimado de ${fmtBRL(result.profit)} com os custos cadastrados`,
    minutes && minutes > 0 ? `• ${fmtBRL(result.profitPerHour)}/hora líquida nos ${fmtNum(minutes)} min informados` : undefined,
  ]
  const classifica = knownRoute && cost.fuelPerKm > 0 ? `\n\nPela distância e pelos custos cadastrados, classificação ${result.rating.toLowerCase()}.` : ''
  return `${head}\n\n${rows.filter(Boolean).join('\n')}${classifica}${incomplete}`
}
