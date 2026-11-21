import type { AppState } from '../models/types'
import { analyzeRide, kmCost } from '../services/calc'
import { isDriver } from '../services/profile'
import { fmtBRL, fmtNum, parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { looksPast } from './clauses'
import { PARE_PARA_DESCANSAR, perceivesDrivingFatigue } from './driverAdvice'
import { normalizeNumberWords } from './numbers'

const PEDIDO = /\b(?:vale(?:\s+a\s+pena)?|compensa|aceito|pego|(?:devo|posso|vale)\s+(?:aceitar|pegar)|(?:da|serve)\s+(?:pra|para)\s+(?:aceitar|pegar))\b/
const NOME = /\b(?:corridas?|viagem|chamada)\b/
const NUMBER = String.raw`(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)`
const AMOUNT_WITH_CURRENCY = new RegExp(String.raw`(?<!-)r\$\s*${NUMBER}|(?<![\w.,-])${NUMBER}\s*(?:reais?|contos?|pila)\b`, 'g')
const AMOUNT_AFTER_NOUN = new RegExp(String.raw`\b(?:corridas?|viagem|chamada)\s+(?:(?:da|do|na|no|pela|pelo|via)\s+(?:uber|99|indrive[r]?)\s+)?(?:(?:de|por|no\s+valor\s+de)\s+)?${NUMBER}(?!\s*(?:kms?|quilometros?|m|metros?|h|horas?|min|minutos?|segundos?)\b)`)
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

const ROTA = 'Diga os km totais ou os km até o passageiro e os km da viagem.'

export function answerRideOffer(state: AppState, input: string, context = input): string | undefined {
  if (!isDriver(state.settings) || looksPast(input)) return undefined
  const t = normalizeNumberWords(normalizeName(input)).text
  if (!PEDIDO.test(t) || !NOME.test(t)) return undefined
  if (perceivesDrivingFatigue(context)) return PARE_PARA_DESCANSAR
  if (!/\d/.test(t)) return undefined
  const alternativas = /\d[^?]*\bou\b[^?]*\d/.test(t)
  const valores = [...new Set([...t.matchAll(AMOUNT_WITH_CURRENCY)].map(m => parseMoney(m[1] || m[2])))]
  if (alternativas || valores.length > 1) {
    return 'Diga uma oferta por vez com valor, km até o passageiro, km da viagem e tempo total.'
  }
  const value = valores[0] ?? parseMoney(t.match(AMOUNT_AFTER_NOUN)?.[1] || '')
  if (!(value > 0)) return 'Qual é o valor que a corrida paga?'
  const km = measured(t, DISTANCE)
  const totalKm = km && routeTotal(km)
  const cost = kmCost(state)
  if (!km || totalKm === undefined || !(totalKm > 0)) {
    if (!km || Object.keys(km).length) return ROTA
    const reference = cost.minRecommended > 0
      ? ` Pelo seu mínimo de referência de ${fmtBRL(cost.minRecommended)}/km, ${fmtBRL(value)} cobrem até ${fmtNum(value / cost.minRecommended)} km.`
      : ' Também preciso do custo por km para estimar se compensa.'
    return ROTA + reference
  }
  const times = measured(t, TIME)
  const minutes = times && routeTotal(times)
  const knownRoute = km.total !== undefined || (km.pickup !== undefined && km.trip !== undefined)
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
