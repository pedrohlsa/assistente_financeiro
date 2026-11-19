import type { AppState } from '../models/types'
import { kmCost, periodStats } from '../services/calc'
import { isDriver } from '../services/profile'
import { fmtBRL, fmtNum, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { parsePeriod } from './query/period'

const VEICULO = String.raw`(?:(?:o|a|meu|minha|seu|sua)\s+)?(?:carro|veiculo|moto)`
const POR_KM = String.raw`por\s+(?:km|quilometro)`
const CUSTO_VEICULO = [
  new RegExp(String.raw`^quanto\s+(?:${VEICULO}\s+)?(?:custa|custou)(?:\s+${VEICULO})?\s+${POR_KM}$`),
  new RegExp(String.raw`^(?:qual\s+(?:e\s+)?o\s+)?custo\s+(?:d[oa]\s+${VEICULO}\s+)?${POR_KM}(?:\s+d[oa]\s+${VEICULO})?$`),
  new RegExp(String.raw`^quanto\s+(?:sai\s+o\s+km|o\s+km\s+sai)(?:\s+d[oa]\s+${VEICULO})?$`),
]
const DESPESAS_VEICULO = new Set(['combustivel', 'manutencao', 'estacionamento', 'pedagio'])

export function answerVehicleCost(s: AppState, input: string, hoje = todayISO()): { text: string; explanation: string } | null {
  if (!isDriver(s.settings)) return null
  const t = normalizeName(input).replace(/[.!?]+$/, '')
  const leitura = parsePeriod(t, hoje)
  const trecho = leitura && normalizeName(leitura.span || leitura.matched)
  const inicio = trecho ? t.indexOf(trecho) : -1
  const pergunta = trecho && inicio >= 0
    ? `${t.slice(0, inicio).replace(/\b(?:em|no|na)\s*$/, '')} ${t.slice(inicio + trecho.length)}`.trim().replace(/\s+/g, ' ')
    : t
  if (!CUSTO_VEICULO.some(re => re.test(pergunta))) return null

  if (leitura) {
    const { from, to, label } = leitura.period
    const explanation = 'A conta divide as despesas registradas de combustível, manutenção, pedágio e estacionamento pelos km de trabalho do mesmo período. Os custos fixos configurados hoje entram só na estimativa atual.'
    if (from > hoje) return { text: `Ainda não há despesas realizadas ${label}. Você pode pedir o custo atual estimado do veículo.`, explanation }
    const ate = to < hoje ? to : hoje
    const expenses = s.transactions.filter(tx => tx.type === 'expense' && DESPESAS_VEICULO.has(tx.category)
      && tx.date >= from && tx.date <= ate)
    const dados = periodStats({ ...s, transactions: expenses }, from, ate)
    if (!dados.km || !expenses.length) {
      const falta = !dados.km ? 'quilometragem de trabalho' : 'despesa do veículo'
      return { text: `Não tenho ${falta} registrada ${label} para calcular o gasto por km.`, explanation }
    }
    return { text: `Gasto registrado do veículo ${label}: ${fmtBRL(dados.costPerKm)}/km (${fmtBRL(dados.expense)} em ${expenses.length} ${expenses.length === 1 ? 'despesa' : 'despesas'} ÷ ${fmtNum(dados.km)} km).`, explanation }
  }

  if (/\bcustou\b/.test(pergunta)) {
    const text = 'Qual período você quer consultar para calcular o gasto registrado do veículo por km?'
    return { text, explanation: text }
  }
  const kc = kmCost(s)
  if (kc.total <= 0) {
    const text = 'Ainda não tenho dados suficientes para calcular o custo por km. Registre abastecimentos, manutenções e km de trabalho ou informe os valores em Veículo.'
    return { text, explanation: text }
  }
  return {
    text: `O custo estimado do veículo é ${fmtBRL(kc.total)}/km.\n\n`
      + `• Combustível: ${fmtBRL(kc.fuelPerKm)}/km\n• Manutenção: ${fmtBRL(kc.maintenancePerKm)}/km\n• Custos fixos: ${fmtBRL(kc.fixedPerKm)}/km\n\n`
      + `Custo operacional: ${fmtBRL(kc.operational)}/km\nValor mínimo recomendado: ${fmtBRL(kc.minRecommended)}/km\nMeta confortável: ${fmtBRL(kc.comfort)}/km`,
    explanation: 'É o cálculo da tela Veículo: preço por litro ÷ km por litro, somado ao desgaste das peças por km e aos custos fixos mensais divididos pela quilometragem. Cada parcela depende dos dados cadastrados.',
  }
}
