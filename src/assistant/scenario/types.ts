// CENÁRIOS — "e se?" sem tocar em nada.
//
// A regra que sustenta o módulo inteiro: uma HIPÓTESE NUNCA VIRA FATO. Nenhum
// caminho daqui produz `ParsedAction`, chama `dispatch`, escreve em
// `localStorage`, grava journal, resolve ocorrência recorrente ou paga fatura.
// O motor recebe o estado como VALOR, monta uma cópia PROJETADA e roda sobre
// ela as MESMAS funções de cálculo que a tela usa — simulação e realidade não
// podem divergir porque são o mesmo código.
//
// Toda saída é marcada como simulação/estimativa. O usuário precisa saber, sem
// ambiguidade, que aquele número descreve um mundo que ainda não existe.

import type { AssistantFact } from '../query/types'
import type { PayoffQuote } from './payoff'

export const SCENARIO_DSL_VERSION = 2 as const

export type ScenarioKind =
  | 'compound'        // várias transformações na mesma hipótese
  | 'spend'           // "se eu gastar 500 agora, quanto sobra?"
  | 'purchase'        // "se eu comprar um pc de 4000 em 10x no nubank"
  | 'save'            // "se eu guardar 500 por mês, quando bato a meta?"
  | 'payoff'          // "e se eu quitar o computador por 950?"
  | 'pay-invoice'     // "se eu pagar a fatura inteira hoje"
  | 'income-missing'  // "se a Casa 1 não pagar este mês"
  | 'extra-work'      // motorista: "se eu fizer mais 3 horas por dia"
  | 'cut'             // "e se eu parar a obra", "se eu não gastar mais com lazer"
  | 'reduce'          // "reduzir alimentação em 300 por mês"
  | 'save-share'      // "guardar metade do que sobrar"

export interface DrivingScenario {
  metric: 'profit' | 'fuel-cost' | 'fuel-volume' | 'maintenance'
  /** Variações relativas: 0,20 significa 20% a mais. */
  distanceChange?: number
  fuelPriceChange?: number
  fuelPricePerLiter?: number
  extraDaysPerWeek?: number
}

export interface IncomeLossDuration {
  value: number
  unit: 'days' | 'weeks' | 'months'
}

export interface AssistantScenarioPlan {
  version: typeof SCENARIO_DSL_VERSION
  kind: ScenarioKind
  /** Valor central: gasto, preço da compra, quanto guardar por mês, receita que falta. */
  amount?: number
  installments?: number
  /** Entrada dada na compra — sai do bolso hoje e reduz o financiado. */
  downPayment?: number
  /** Meses entre hoje e a data da compra simulada. */
  purchaseDelayMonths?: number
  cardName?: string
  payoffQuote?: PayoffQuote
  /** Horizonte em meses para projetar. */
  months?: number
  /** Primeiro mês em que uma reserva começa (inclusive). */
  startMonth?: string
  /** Impede resultado numérico quando a data pedida está fora do limite. */
  planningIssue?: string
  /** Partes materiais que não entraram na conta, nunca descartadas em silêncio. */
  unsupportedFragments?: string[]
  goalName?: string
  /** Acumulado da meta informado para a simulação. */
  declaredGoalSaved?: number
  /** Fonte que deixaria de pagar ("Casa 1"). */
  origin?: string
  /** Duração dita para uma entrada ausente, independente dos outros passos. */
  incomeLossDuration?: IncomeLossDuration
  /** Vacância retira somente aluguel da origem, mesmo se houver outras entradas. */
  incomeLossForRent?: boolean
  category?: string
  description?: string
  /** Conta fixa citada pelo nome ("parar de pagar a internet"): o corte é só dela. */
  recurringId?: string
  /** Quando o gasto acontece, como o usuário disse ("este mês"). Ausente = hoje. */
  when?: string
  hoursPerDay?: number
  extraKm?: number
  driving?: DrivingScenario
  /** "Quanto devo gastar de combustível": o custo dos km a mais, não o ganho. */
  fuelOnly?: boolean
  /** Quantos dias a mais de trabalho a hipótese cobre. */
  days?: number
  /** Fração de um resultado anterior: 0,5 = metade. */
  ratio?: number
  /** Passos ordenados de uma hipótese composta. */
  steps?: AssistantScenarioPlan[]
  label: string
}

export interface ScenarioMonth {
  monthKey: string
  label: string
  /** Saldo estimado SEM a hipótese. */
  before: number
  /** Saldo estimado COM a hipótese. */
  after: number
  delta: number
  /** Parcela/valor que a hipótese acrescenta neste mês. */
  added: number
  /** Excedente deste mês depois das transformações e antes da reserva. */
  surplus?: number
  /** Valor reservado somente neste mês. Nunca negativo. */
  saved?: number
  /** Reserva simulada acumulada até este mês. */
  accumulated?: number
}

export interface AssistantScenarioResult {
  plan: AssistantScenarioPlan
  facts: AssistantFact[]
  months: ScenarioMonth[]
  /** Mês em que o saldo estimado fica mais baixo depois da hipótese. */
  tightest?: ScenarioMonth
  /** A hipótese cabe? `undefined` quando não há base para afirmar. */
  feasible?: boolean
  /** O que estes dados NÃO permitem afirmar. */
  caveats: string[]
  /** Falta base para simular. O app DIZ isso em vez de inventar. */
  empty: boolean
}
