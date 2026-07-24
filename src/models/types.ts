// Modelos de dados centrais (seção 39 do CONTEXTO.md)

export type ProfileId = 'driver' | 'autonomo' | 'clt' | 'business' | 'other'

/** Categorias só existem para entrada e saída. */
export type CategoryType = 'income' | 'expense'

/**
 * 'saving' = transferência para reserva/investimento (14.3).
 * NÃO entra em receitas nem despesas: apenas marca quanto do resultado
 * líquido o usuário efetivamente guardou.
 */
export type TxType = 'income' | 'expense' | 'saving'

export interface Transaction {
  id: string
  type: TxType
  amount: number
  category: string
  description?: string
  date: string // YYYY-MM-DD
  time?: string // HH:mm
  paymentMethod?: string
  note?: string
  recurringId?: string
  source?: 'manual' | 'ai' | 'voice' | 'quick' | 'demo' | 'recurring'
  /** Origem/fonte informada pelo usuário: "Casa 1", "Cliente João" (14.6). */
  origin?: string
  /** Perfil ativo quando o lançamento foi criado — histórico nunca é reinterpretado (14.1). */
  profileAtCreation?: ProfileId
}

export interface Category {
  id: string
  name: string
  type: CategoryType
  icon: string
  custom?: boolean
  /** Arquivada: some dos seletores, mas o histórico continua intacto (14.5). */
  archived?: boolean
}

export interface WorkSession {
  id: string
  date: string
  km: number
  trips: number
  hours: number
  source?: string
}

export interface FuelRecord {
  id: string
  date: string
  amount: number
  liters: number
  pricePerLiter: number
  odometer?: number
  station?: string
  fuelType?: string
}

export interface Vehicle {
  brand: string
  model: string
  year?: string
  odometer: number
}

export interface MaintenanceItem {
  id: string
  name: string // Óleo, Pneus...
  cost: number
  kmInstalled: number
  lifeKm: number
  date: string
}

export interface FinancialGoal {
  id: string
  name: string
  target: number
  saved: number
  deadline?: string // YYYY-MM-DD
  createdAt: string
  done?: boolean
}

export interface Deficit {
  id: string
  date: string
  amount: number
  remaining: number
  perDay: number
  daysLeft: number
  ignored?: boolean
}

export type Recurrence = 'weekly' | 'monthly' | 'yearly'

export interface RecurringExpense {
  id: string
  name: string
  amount: number
  frequency: Recurrence
  dueDay: number // dia do mês (monthly/yearly) ou dia da semana (weekly)
  dueMonth?: number // para anual
  category: string
  kind?: 'income' | 'expense' // entrada (salário/aluguel) ou saída (conta). Ausente = expense.
  origin?: string        // fonte: "Casa 1", "Empresa X" (14.6)
  startDate?: string     // a partir de quando vale (YYYY-MM-DD)
  endDate?: string       // até quando vale (opcional)
  active?: boolean       // desativada não gera pendência. Ausente = true.
  /**
   * Meses já resolvidos ('YYYY-MM'), seja por confirmação ou por "não recebi".
   * É o que impede lançamento duplicado do mesmo mês (14.2).
   */
  handledMonths?: string[]
  /** "Adiar": não perguntar de novo antes desta data. */
  snoozeUntil?: string
}

export interface Budget {
  id: string
  category: string
  limit: number // mensal
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  time: string
  pending?: PendingAction[]
  kind?: 'text' | 'confirm' | 'report'
  /** Resumo detalhado do que será registrado (14.7). */
  detail?: string
  /** Aviso de possível lançamento duplicado (14.8). */
  duplicateWarning?: string
}

export interface PendingAction {
  label: string
  action: ParsedAction
}

export type ParsedAction =
  | { kind: 'income'; amount: number; category?: string; description?: string; is99?: boolean; origin?: string }
  | { kind: 'expense'; amount: number; category?: string; description?: string; origin?: string }
  | { kind: 'saving'; amount: number; description?: string }
  | { kind: 'work'; km?: number; trips?: number; hours?: number }
  | { kind: 'fuel'; amount?: number; liters?: number; pricePerLiter?: number; odometer?: number }
  | { kind: 'maintenance'; item: string; cost: number; km?: number; lifeKm?: number }
  | { kind: 'goal'; name: string; target: number; months?: number }
  | { kind: 'goal-update'; name: string; target?: number; months?: number }
  | { kind: 'goal-deposit'; name: string; amount: number }
  | { kind: 'balance'; amount: number }        // define o saldo atual em conta ("meu saldo é 1500")
  | { kind: 'reset' }                           // apaga todos os dados (confirmação obrigatória)

export interface Insight {
  id: string
  icon: string
  title: string
  text: string
  tone: 'positive' | 'negative' | 'warning' | 'neutral'
}

export interface Settings {
  name: string
  currency: string
  theme: 'light' | 'dark' | 'auto'
  profile: ProfileId
  priority: string
  onboarded: boolean
  demo: boolean
  monthlyProfitTarget: number // objetivo de lucro mensal
  safetyMarginPct: number
  workDays: number[] // 0-6 (dom-sáb)
  homeCards: string[]
  fuelPricePerLiter: number
  kmPerLiter: number
  minPerKm: number // valor mínimo recomendado configurável
  comfortPerKm: number
  fixedMonthlyCosts: number // seguro, IPVA, financiamento etc (soma mensal p/ custo por km)
  notifications: boolean
  balance: number           // saldo atual em conta (modo banco) — atualizado pelo usuário
  ask99Fee: boolean         // ao registrar faturamento, perguntar se foi saque da 99 (−R$1)
  platform99Fee: number     // valor da taxa de saque da 99
  /** IA remota (DeepSeek). Desligada = só o motor local/offline responde (14.11). */
  remoteAi?: boolean
}

export interface AppState {
  settings: Settings
  transactions: Transaction[]
  categories: Category[]
  workSessions: WorkSession[]
  fuelRecords: FuelRecord[]
  vehicle: Vehicle | null
  maintenance: MaintenanceItem[]
  goals: FinancialGoal[]
  deficits: Deficit[]
  recurring: RecurringExpense[]
  budgets: Budget[]
  chat: ChatMessage[]
  dismissedDeficitDates: string[]
}
