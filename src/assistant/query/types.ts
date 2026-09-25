// QUERY DSL — o vocabulário fechado das consultas financeiras.
//
// POR QUE ISTO EXISTE: até esta versão, cada pergunta nova que o usuário
// inventava custava uma regex nova em `resolveLocal()` (src/services/ai.ts),
// na posição certa de uma cadeia de ~25 `if`. Pior: `periodFromText()` conhecia
// seis frases de período e caía em "últimos 7 dias" para todo o resto — então
// "quanto gastei em obra nos últimos 3 meses?" respondia o total de SETE DIAS,
// com cara de dado real. Número errado apresentado como certo é o pior desfecho
// possível num app de dinheiro.
//
// A saída é separar INTERPRETAR de EXECUTAR. A IA (local ou remota) interpreta a
// pergunta e devolve um PLANO. O código local executa o plano.
//
// REGRAS DE CONSTRUÇÃO, todas verificáveis lendo este arquivo:
//   1. O plano é DADO, nunca código. Sem SQL, sem `eval`, sem função, sem
//      expressão, sem nome de campo dinâmico vindo do modelo.
//   2. Todo vocabulário é FECHADO: fonte, campo, métrica, agrupamento e ordem
//      são uniões literais. Qualquer coisa fora delas é recusada com código.
//   3. A DSL é SOMENTE LEITURA. Não existe nenhuma operação de escrita aqui, e
//      o executor recebe o estado como valor — nunca `dispatch`.
//   4. Texto de filtro é sempre LITERAL vindo da pergunta do usuário, comparado
//      por conteúdo. Nunca vira regex, nunca vira chave de objeto.

import type { TxType } from '../../models/types'

/**
 * Versão da DSL, independente de `ASSISTANT_CONTRACT_VERSION`. O envelope da
 * resposta continua v1 (ver docs/AI_SEMANTIC_COPILOT_DESIGN.md §6); um plano
 * com versão desconhecida é recusado sem ser interpretado "na sorte".
 */
export const QUERY_DSL_VERSION = 2 as const

// ---------------------------------------------------------------------------
// Fonte
// ---------------------------------------------------------------------------

export type QuerySource =
  | 'transactions'   // o que realmente entrou e saiu
  | 'recurring'      // ocorrências PREVISTAS de contas e entradas fixas
  | 'installments'   // parcelas de parcelamentos
  | 'invoices'       // faturas por cartão e mês
  | 'plans'          // parcelamentos (visão do plano inteiro)
  | 'goals'          // metas de compra
  | 'work'           // turnos — só motorista
  | 'fuel'           // abastecimentos — só motorista
  | 'maintenance'    // manutenções — só motorista
  | 'projections'    // projeção mês a mês (estimativa, nunca realizado)

export const QUERY_SOURCES: QuerySource[] = [
  'transactions', 'recurring', 'installments', 'invoices', 'plans',
  'goals', 'work', 'fuel', 'maintenance', 'projections',
]

/** Fontes que só existem no perfil motorista (regra 3 do CLAUDE.md). */
export const DRIVER_ONLY_SOURCES: QuerySource[] = ['work', 'fuel', 'maintenance']

// ---------------------------------------------------------------------------
// Campo numérico
// ---------------------------------------------------------------------------

/**
 * Qual número da linha a métrica usa. Existe para a mesma DSL responder "quanto
 * gastei" (amount) e "qual semana eu rodei mais" (km) sem duplicar métrica.
 *
 * O allowlist é POR FONTE: pedir `km` em `transactions` é plano malformado, não
 * um zero silencioso.
 */
export type QueryField =
  | 'amount' | 'km' | 'hours' | 'trips' | 'liters'
  | 'target' | 'saved' | 'remaining' | 'pct' | 'remainingCount'
  | 'incomes' | 'bills' | 'installments' | 'net' | 'balance'
  | 'total' | 'paid'

export const FIELDS_BY_SOURCE: Record<QuerySource, QueryField[]> = {
  transactions: ['amount'],
  recurring: ['amount'],
  installments: ['amount'],
  invoices: ['amount', 'paid', 'total'],
  plans: ['amount', 'remaining', 'total', 'paid', 'remainingCount'],
  goals: ['amount', 'target', 'saved', 'remaining', 'pct'],
  work: ['km', 'hours', 'trips'],
  fuel: ['amount', 'liters'],
  maintenance: ['amount'],
  projections: ['incomes', 'bills', 'installments', 'net', 'balance'],
}

// ---------------------------------------------------------------------------
// Período
// ---------------------------------------------------------------------------

export type PeriodGrain = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'range'

export interface QueryPeriod {
  from: string   // ISO YYYY-MM-DD, inclusivo
  to: string     // ISO YYYY-MM-DD, inclusivo
  /** Como o usuário chamou: "este mês", "nos últimos 3 meses". */
  label: string
  grain: PeriodGrain
  /** O período inteiro está no futuro — resultado é PREVISÃO, nunca realizado. */
  future?: boolean
}

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

export interface QueryFilter {
  txType?: TxType[]
  categories?: string[]
  excludeCategories?: string[]
  /** Literal da mensagem, casado por conteúdo em descrição + origem. */
  text?: string
  excludeText?: string
  /** Vários nomes/lugares excluídos na mesma pergunta. */
  excludeTexts?: string[]
  origin?: string
  cardNames?: string[]
  excludeCardNames?: string[]
  goalName?: string
  /** Uber, 99, inDrive — casado no texto, só faz sentido no perfil motorista. */
  platform?: string
  status?: ('pending' | 'paid' | 'cancelled' | 'active' | 'settled' | 'done' | 'open')[]
  /** Só o que já aconteceu de verdade. */
  realizedOnly?: boolean
  /** Só previsão/projeção. */
  plannedOnly?: boolean
  /** 0=domingo … 6=sábado. */
  weekdays?: number[]
  /** Primeira ou segunda metade do mês. */
  monthHalf?: 'first' | 'second'
  minAmount?: number
  maxAmount?: number
  /** Perfil ativo quando o lançamento foi criado (histórico é somente leitura). */
  profileAtCreation?: string
}

// ---------------------------------------------------------------------------
// Métrica, agrupamento e ordem
// ---------------------------------------------------------------------------

/**
 * `net` = entradas − saídas dentro do recorte (só faz sentido em `transactions`
 * e `recurring`). `share` = quanto o recorte representa do total do mesmo
 * período SEM os filtros de conteúdo — é o que responde "quanto a Casa 1
 * representa da minha renda".
 *
 * "Tendência" e "comparação entre períodos" não são métricas: são
 * `comparePeriod`, que funciona com QUALQUER métrica. Uma métrica dedicada
 * daria duas formas de dizer a mesma coisa e uma delas envelheceria.
 */
export type QueryMetric =
  | 'sum' | 'count' | 'avg' | 'median' | 'min' | 'max'
  | 'net' | 'share' | 'per-day' | 'per-km' | 'per-hour' | 'per-trip'

export const QUERY_METRICS: QueryMetric[] = [
  'sum', 'count', 'avg', 'median', 'min', 'max',
  'net', 'share', 'per-day', 'per-km', 'per-hour', 'per-trip',
]

export type QueryGroup =
  | 'none' | 'category' | 'origin' | 'card' | 'month' | 'week' | 'day'
  | 'weekday' | 'month-half' | 'description' | 'goal' | 'plan' | 'platform'

export const QUERY_GROUPS: QueryGroup[] = [
  'none', 'category', 'origin', 'card', 'month', 'week', 'day',
  'weekday', 'month-half', 'description', 'goal', 'plan', 'platform',
]

/**
 * `delta-*` só existe quando há `comparePeriod`: é o que responde "qual
 * categoria AUMENTOU mais" (delta-desc) e "qual CAIU mais" (delta-asc). Sem
 * comparação a ordem cai em `value-desc`, porque não existe diferença nenhuma
 * para ordenar — e ordenar por um campo vazio devolveria a lista na ordem do
 * acaso com cara de ranking.
 */
export type QueryOrder =
  | 'value-desc' | 'value-asc' | 'date-desc' | 'date-asc' | 'count-desc'
  | 'delta-desc' | 'delta-asc'

export const QUERY_ORDERS: QueryOrder[] = [
  'value-desc', 'value-asc', 'date-desc', 'date-asc', 'count-desc',
  'delta-desc', 'delta-asc',
]

// ---------------------------------------------------------------------------
// Plano
// ---------------------------------------------------------------------------

export interface AssistantQueryPlan {
  version: typeof QUERY_DSL_VERSION
  source: QuerySource
  field?: QueryField
  period: QueryPeriod
  /** Segundo período, para comparar. É isto que responde "e mês passado?". */
  comparePeriod?: QueryPeriod
  filter: QueryFilter
  metric: QueryMetric
  group: QueryGroup
  order?: QueryOrder
  limit?: number
  /**
   * Denominador de `share`. "quanto das minhas ENTRADAS eu consegui guardar"
   * compara transferências para a reserva com a RECEITA do período — usar o
   * mesmo tipo daria sempre 100%, que é o pior tipo de resposta: certa na
   * aritmética e sem sentido nenhum.
   */
  shareBase?: 'income' | 'expense' | 'same'
  /** Rótulo humano do que se está medindo ("Gasto com obra"). */
  label?: string
}

// ---------------------------------------------------------------------------
// Linha normalizada — toda fonte produz isto
// ---------------------------------------------------------------------------

export interface QueryRow {
  id: string
  date: string
  /** Valor principal em BRL (ou o principal da fonte). */
  value: number
  label: string
  category?: string
  origin?: string
  cardId?: string
  cardName?: string
  planId?: string
  goalId?: string
  txType?: TxType
  platform?: string
  status?: string
  /** Estimativa/previsão, nunca realizado. */
  estimated?: boolean
  /** Outros números da linha, acessíveis por `field`. */
  extra?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export interface QueryGroupResult {
  key: string
  label: string
  value: number
  count: number
  /** Preenchidos quando há `comparePeriod`. */
  compareValue?: number
  delta?: number
  deltaPct?: number
}

export type FactUnit = 'BRL' | 'count' | 'km' | 'hours' | 'liters' | 'pct' | 'per-km' | 'per-hour' | 'per-trip' | 'per-day'

/**
 * Um número pronto, com tudo que é preciso para justificá-lo. É o átomo da
 * resposta: o compositor (local ou remoto) só pode falar sobre isto.
 */
export interface AssistantFact {
  id: string
  label: string
  value: number
  unit: FactUnit
  period?: { from: string; to: string; label: string }
  /** De onde saiu — matéria-prima de "como você chegou nisso?". */
  provenance: { source: string; rows: number; detail?: string }
  /** Projeção/estimativa. Nunca pode ser apresentado como realizado. */
  estimated?: boolean
}

export interface AssistantQueryResult {
  plan: AssistantQueryPlan
  total: number
  count: number
  groups: QueryGroupResult[]
  compareTotal?: number
  delta?: number
  deltaPct?: number
  unit: FactUnit
  /** Tudo que sustenta o número é previsão. Nunca apresentar como realizado. */
  estimated: boolean
  sample: { rows: number; from: string; to: string }
  /** Sem base para responder. O app CALA e diz o que falta (regra 43). */
  empty: boolean
  /** O que estes dados NÃO permitem afirmar. Vai para a resposta. */
  caveats: string[]
  facts: AssistantFact[]
  /** Linhas de exemplo, já filtradas — para "quais dados você usou?". */
  samples: QueryRow[]
}
