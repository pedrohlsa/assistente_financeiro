import type { AssistantFact, QueryPeriod } from '../query/types'

export type ChangeDriverKind = 'income-category' | 'expense-category'

export interface ChangeDriver {
  kind: ChangeDriverKind
  key: string
  label: string
  before: number
  after: number
  delta: number
  /** Efeito no resultado: receita sobe = positivo; despesa sobe = negativo. */
  contribution: number
}

export interface StructuralChange {
  kind: 'recurring-start' | 'recurring-end' | 'installment-start' | 'installment-end' | 'extraordinary'
  label: string
  amount?: number
  date?: string
}

export interface ChangeAnalysis {
  current: QueryPeriod
  previous: QueryPeriod
  totals: {
    incomeBefore: number; incomeAfter: number; incomeDelta: number
    expenseBefore: number; expenseAfter: number; expenseDelta: number
    netBefore: number; netAfter: number; netDelta: number
  }
  drivers: ChangeDriver[]
  structural: StructuralChange[]
  facts: AssistantFact[]
  /** Soma das contribuições; deve ser igual a `netDelta`. */
  reconciledDelta: number
  reconciled: boolean
  caveats: string[]
}
