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

export const SCENARIO_DSL_VERSION = 2 as const

export type ScenarioKind =
  | 'compound'        // várias transformações na mesma hipótese
  | 'spend'           // "se eu gastar 500 agora, quanto sobra?"
  | 'purchase'        // "se eu comprar um pc de 4000 em 10x no nubank"
  | 'save'            // "se eu guardar 500 por mês, quando bato a meta?"
  | 'pay-invoice'     // "se eu pagar a fatura inteira hoje"
  | 'income-missing'  // "se a Casa 1 não pagar este mês"
  | 'extra-work'      // motorista: "se eu fizer mais 3 horas por dia"
  | 'cut'             // "e se eu parar a obra", "se eu não gastar mais com lazer"
  | 'reduce'          // "reduzir alimentação em 300 por mês"
  | 'save-share'      // "guardar metade do que sobrar"

export interface AssistantScenarioPlan {
  version: typeof SCENARIO_DSL_VERSION
  kind: ScenarioKind
  /** Valor central: gasto, preço da compra, quanto guardar por mês, receita que falta. */
  amount?: number
  installments?: number
  /** Entrada dada na compra — sai do bolso hoje e reduz o financiado. */
  downPayment?: number
  cardName?: string
  /** Horizonte em meses para projetar. */
  months?: number
  goalName?: string
  /** Fonte que deixaria de pagar ("Casa 1"). */
  origin?: string
  category?: string
  description?: string
  hoursPerDay?: number
  extraKm?: number
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
