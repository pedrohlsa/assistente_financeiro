// Modelos de dados centrais (seção 39 do CONTEXTO.md)

export type ProfileId = 'driver' | 'autonomo' | 'clt' | 'business' | 'other'

/** Categorias só existem para entrada e saída. */
export type CategoryType = 'income' | 'expense'

/**
 * 'saving' = transferência para reserva/investimento (14.3).
 * NÃO entra em receitas nem despesas: apenas marca quanto do resultado
 * líquido o usuário efetivamente guardou.
 *
 * 'financed-cash-inflow' = dinheiro que entrou no caixa AGORA em troca de uma
 * dívida parcelada no cartão. NÃO é receita, lucro nem faturamento — o
 * patrimônio líquido não aumenta. Fica fora de todo somatório de receita
 * (todos os cálculos filtram 'income'/'expense' explicitamente); a dívida
 * correspondente vive em InstallmentPlan.
 */
export type TxType = 'income' | 'expense' | 'saving' | 'financed-cash-inflow'

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
  /**
   * Data da ocorrência que originou este lançamento. Junto com `recurringId`
   * forma a chave única que impede confirmar duas vezes o mesmo período.
   */
  occurrenceDate?: string
  source?: 'manual' | 'ai' | 'voice' | 'quick' | 'demo' | 'recurring'
  /** Origem/fonte informada pelo usuário: "Casa 1", "Cliente João" (14.6). */
  origin?: string
  /** Perfil ativo quando o lançamento foi criado — histórico nunca é reinterpretado (14.1). */
  profileAtCreation?: ProfileId
  /**
   * Lote do assistente que criou este lançamento. Opcional e retrocompatível:
   * serve para auditar o que entrou junto e para "desfazer o último" saber
   * exatamente o que remover. Ausente em tudo que foi criado à mão.
   */
  assistantBatchId?: string
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
  /** Média informada pelo usuário para estimar datas de manutenção. */
  averageDailyKm?: number
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

/** Unidade do intervalo de repetição. */
export type IntervalUnit = 'day' | 'week' | 'month' | 'year'

/** Situação de UMA ocorrência específica de uma recorrência. */
export type OccurrenceStatus = 'confirmed' | 'skipped'

/**
 * Ocorrência já resolvida. A chave única é `recurringId` (dono) + `date` — é o
 * que impede registrar duas vezes o mesmo salário do mesmo período.
 */
export interface RecurrenceOccurrence {
  date: string   // YYYY-MM-DD da ocorrência prevista
  status: OccurrenceStatus
  /** Transação criada ao confirmar (ausente em 'skipped'). */
  txId?: string
  /** Valor realmente confirmado, quando diferente do previsto. */
  amount?: number
}

export interface RecurringExpense {
  id: string
  name: string
  amount: number
  /** Legado, mantido para dados antigos. A repetição real é interval+intervalUnit. */
  frequency: Recurrence
  dueDay: number // dia do mês (monthly/yearly) ou dia da semana (weekly)
  dueMonth?: number // para anual
  category: string
  kind?: 'income' | 'expense' // entrada (salário/aluguel) ou saída (conta). Ausente = expense.
  origin?: string        // fonte: "Casa 1", "Empresa X" (14.6)
  /**
   * Data da PRIMEIRA ocorrência. É a âncora de toda a sequência futura: com
   * intervalo em dias ou semanas as próximas datas saem daqui por soma, nunca
   * do dia do mês. Ausente (dados antigos) = fallback em `recurrenceAnchor()`.
   */
  startDate?: string
  endDate?: string       // até quando vale (opcional)
  active?: boolean       // desativada não gera pendência. Ausente = true.
  /** Repetir a cada N unidades. Ausente = derivado de `frequency`. */
  interval?: number
  intervalUnit?: IntervalUnit
  /**
   * Meses já resolvidos ('YYYY-MM'). LEGADO: só é consultado para recorrências
   * mensais antigas. O controle novo é `occurrences`, por data exata.
   */
  handledMonths?: string[]
  /** Ocorrências resolvidas por data — evita duplicidade em qualquer frequência. */
  occurrences?: RecurrenceOccurrence[]
  /** "Adiar": não perguntar de novo antes desta data. */
  snoozeUntil?: string
}

export interface Budget {
  id: string
  category: string
  limit: number // mensal
}

// ---------- CARTÕES E PARCELAMENTOS ----------
// REGRA DE CONTABILIZAÇÃO (crítica, ver PROGRESS.md):
// Compras no cartão e parcelamentos NÃO criam Transaction. O histórico da compra
// pelo valor total vive no InstallmentPlan; o fluxo de caixa mensal considera
// SOMENTE as parcelas que vencem no mês (Installment.dueDate). Pagar a fatura
// não gera despesa nova — só quita a dívida e reduz o saldo em conta.
// Assim é impossível somar o total e as parcelas como se fossem despesas diferentes.

export interface CreditCard {
  id: string
  name: string
  institution?: string
  /** Só os 4 últimos dígitos, para identificar o cartão. Nunca o número completo. */
  lastFourDigits?: string
  limit: number
  closingDay: number // dia do fechamento da fatura
  dueDay: number     // dia do vencimento
  /** Fatura já existente quando o cartão foi cadastrado (dívida anterior ao app). */
  initialInvoiceBalance?: number
  color?: string
  archived?: boolean
  notes?: string
  createdAt: string
}

export type InstallmentPlanStatus = 'active' | 'settled' | 'cancelled'

/**
 * 'card-purchase'         — compra no crédito (à vista no crédito = 1 parcela)
 * 'standalone'            — parcelamento sem cartão (empréstimo, boleto, acordo, crediário)
 * 'financed-cash-inflow'  — recebeu dinheiro agora e ficou com dívida parcelada (seção 7)
 */
export type PlanOperationType = 'card-purchase' | 'standalone' | 'financed-cash-inflow'

export interface InstallmentPlan {
  id: string
  description: string
  cardId?: string
  categoryId?: string
  /**
   * TOTAL FINANCIADO — é o que as parcelas somam e o que entra em faturas e
   * projeções. Quando há juros/acréscimo: totalAmount = principalAmount + interestAmount.
   * No financed-cash-inflow: o valor COBRADO no cartão.
   */
  totalAmount: number
  installmentCount: number
  firstDueDate: string
  purchaseDate: string
  /**
   * Preço da compra sem os juros. Opcional e retrocompatível: planos criados
   * antes deste campo não o têm, e nesses casos totalAmount já é o valor final —
   * nunca reinterprete um plano antigo como se tivesse juros embutidos.
   */
  principalAmount?: number
  /** Juros/acréscimo cobrado além do preço da compra. Já incluído em totalAmount. */
  interestAmount?: number
  feeAmount?: number
  /** Credor, estabelecimento ou intermediário — sempre informado pelo usuário. */
  source?: string
  status: InstallmentPlanStatus
  operationType: PlanOperationType
  /** Só em 'financed-cash-inflow': quanto o usuário recebeu líquido. */
  netReceived?: number
  note?: string
  profileAtCreation?: ProfileId
  /** Lote do assistente que criou o plano (opcional, retrocompatível). */
  assistantBatchId?: string
  createdAt: string
}

export type InstallmentStatus = 'pending' | 'paid' | 'cancelled'

export interface Installment {
  id: string
  planId: string
  number: number
  total: number
  amount: number
  dueDate: string
  paidAt?: string
  /** Pagamento parcial desta parcela (quando aplicável). */
  paidAmount?: number
  status: InstallmentStatus
}

export interface CardPayment {
  id: string
  cardId: string
  amount: number
  paymentDate: string
  /** Fatura quitada por este pagamento ('YYYY-MM' do vencimento). */
  referenceMonth: string
  note?: string
  /** Se o valor foi descontado do saldo em conta informado pelo usuário. */
  fromBalance?: boolean
}

/** Assinatura/cobrança recorrente no cartão — não é parcelamento (não tem fim definido). */
export interface RecurringCardCharge {
  id: string
  cardId: string
  description: string
  amount: number
  categoryId?: string
  frequency: Recurrence
  nextDate: string
  endDate?: string
  active?: boolean
  /** Remoção lógica: some da lista ativa sem apagar cobranças de faturas anteriores. */
  removedAt?: string
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  time: string
  /** LEGADO: proposta tudo-ou-nada. Mensagens antigas continuam renderizando. */
  pending?: PendingAction[]
  /**
   * Proposta do contrato v1: cada ação tem id próprio e pode ser confirmada,
   * editada ou removida sozinha. Todos os campos são opcionais para que uma
   * conversa salva antes desta versão carregue sem erro.
   */
  proposal?: ProposedAction[]
  /** Pergunta de esclarecimento (um campo por vez). */
  clarification?: { question: string; field?: string; options?: { label: string; value: string }[] }
  /** Motor que produziu a resposta — auditoria, não decoração. */
  engine?: 'local' | 'remote' | 'hybrid'
  contractVersion?: number
  /** Lote gravado a partir desta mensagem, quando confirmada. */
  batchId?: string
  kind?: 'text' | 'confirm' | 'report'
  /** Resumo detalhado do que será registrado (14.7). */
  detail?: string
  /** Aviso de possível lançamento duplicado (14.8). */
  duplicateWarning?: string
  /**
   * Pergunta de desambiguação (ex.: "gás de cozinha ou GNV?"). Cada opção já
   * traz a lista completa de ações; escolher NÃO registra nada — só gera a
   * confirmação normal com Confirmar/Cancelar.
   */
  choices?: { label: string; actions: ParsedAction[] }[]
}

export interface PendingAction {
  label: string
  action: ParsedAction
}

/**
 * Ação proposta e ainda não confirmada. O `id` é o que permite revisão por item
 * — confirmar uma, editar outra e remover a terceira sem mexer nas demais.
 */
export interface ProposedAction {
  id: string
  action: ParsedAction
  engine?: 'local' | 'remote' | 'hybrid'
  confidence?: 'high' | 'medium' | 'low'
  duplicateWarning?: string
  /** Preenchido depois da confirmação: o que aconteceu com esta ação. */
  outcome?: { ok: boolean; message?: string }
}

// `date?: string` (YYYY-MM-DD) é OPCIONAL em toda ação datável: ausente = hoje,
// que é exatamente o comportamento de antes desta versão. Uma proposta com data
// sempre mostra a data interpretada antes de o usuário confirmar.
export type ParsedAction =
  | { kind: 'income'; amount: number; category?: string; description?: string; is99?: boolean; origin?: string; date?: string }
  | { kind: 'expense'; amount: number; category?: string; description?: string; origin?: string; date?: string }
  | { kind: 'saving'; amount: number; description?: string; date?: string }
  | { kind: 'work'; km?: number; trips?: number; hours?: number; date?: string }
  | { kind: 'fuel'; amount?: number; liters?: number; pricePerLiter?: number; odometer?: number; date?: string }
  | { kind: 'odometer'; value: number }
  | { kind: 'maintenance'; item: string; cost: number; km?: number; lifeKm?: number; date?: string }
  | { kind: 'goal'; name: string; target: number; months?: number }
  | { kind: 'goal-update'; name: string; target?: number; months?: number }
  | { kind: 'goal-deposit'; name: string; amount: number }
  | { kind: 'balance'; amount: number }        // define o saldo atual em conta ("meu saldo é 1500")
  // Compra parcelada (ou à vista no crédito, com installments: 1). A IA nunca
  // inventa cartão, valor, nº de parcelas ou data — pergunta o que faltar.
  | { kind: 'card-purchase'; description?: string; total: number; installments: number; cardName?: string; category?: string; firstDueDate?: string }
  // Recebeu dinheiro agora e ficou com dívida parcelada (seção 7). NUNCA é receita.
  | { kind: 'financed-cash-inflow'; total: number; netReceived: number; installments: number; cardName?: string; source?: string }
  | { kind: 'card-payment'; cardName?: string; amount?: number }  // amount ausente = fatura toda
  | { kind: 'card-charge'; description?: string; amount: number; cardName?: string; category?: string } // assinatura
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
  /** Referências manuais. Começam em zero e são substituídas por dados reais. */
  fuelPricePerLiter: number
  kmPerLiter: number
  minPerKm: number // valor mínimo recomendado configurável
  comfortPerKm: number
  fixedMonthlyCosts: number // seguro, IPVA, financiamento etc (soma mensal p/ custo por km)
  notifications: boolean
  /**
   * ÂNCORA do saldo, não o saldo atual: é o valor que o usuário informou na data
   * `balanceAsOf`. O saldo de hoje é sempre `currentBalance(state)` — âncora mais
   * as movimentações REALIZADAS depois dela. Nunca ler este campo direto na UI.
   */
  balance: number
  /**
   * Data/hora ('YYYY-MM-DDTHH:mm') em que o saldo âncora foi informado.
   * Ausente (dados antigos) = início do dia de hoje, ver currentBalance().
   */
  balanceAsOf?: string
  ask99Fee: boolean         // ao registrar faturamento, perguntar se foi saque da 99 (−R$1)
  platform99Fee: number     // valor da taxa de saque da 99
  /** IA remota (DeepSeek). Desligada = só o motor local/offline responde (14.11). */
  remoteAi?: boolean
  /**
   * Como o ritmo dos objetivos de compra é exibido. É preferência VISUAL: não
   * altera a regra financeira da meta diária do motorista nem a frequência das
   * contas recorrentes. Ausente = fallback por perfil (motorista: 'daily';
   * autônomo/CLT/outro: 'monthly') — ver goalCadenceOf() em services/profile.ts.
   */
  goalCadence?: 'daily' | 'weekly' | 'monthly'
}

// ---------------------------------------------------------------------------
// Auditoria dos lotes do assistente
// ---------------------------------------------------------------------------

/** Coleções do estado que um lote do assistente pode tocar. */
export type JournalCollection =
  | 'transactions' | 'goals' | 'cards' | 'installmentPlans' | 'installments'
  | 'cardPayments' | 'cardCharges' | 'fuelRecords' | 'workSessions'
  | 'maintenance' | 'recurring' | 'budgets' | 'deficits'

/**
 * O que o lote fez, no nível de entidade. `update` e `delete` guardam o estado
 * ANTERIOR porque `assistantBatchId` dentro da entidade só marca o que nasceu
 * no lote — um depósito em meta ou um pagamento de fatura alteram objetos que
 * já existiam, e sem o valor anterior a reversão seria adivinhação.
 */
export type AssistantJournalOp =
  | { op: 'create'; entity: JournalCollection; id: string }
  | { op: 'update'; entity: JournalCollection; id: string; before: Record<string, unknown> }
  | { op: 'delete'; entity: JournalCollection; id: string; snapshot: Record<string, unknown> }
  | { op: 'patch'; entity: 'settings'; before: Record<string, unknown> }
  | { op: 'patch'; entity: 'vehicle'; before: Vehicle | null }

export interface AssistantJournalEntry {
  batchId: string
  contractVersion: number
  source: Transaction['source']
  /** Motor que produziu o lote. */
  engine?: 'local' | 'remote' | 'hybrid'
  /** Carimbo completo (`YYYY-MM-DDTHH:mm`). */
  createdAt: string
  profileAtCreation?: ProfileId
  /**
   * Mensagem do chat que originou o lote — **só o ID**. O texto da conversa
   * nunca entra aqui: ele já vive em `chat` e duplicá-lo aumentaria a
   * superfície de dado sensível guardado no aparelho sem necessidade.
   */
  messageId?: string
  ops: AssistantJournalOp[]
  /** Carimbo da reversão. Preenchido = lote já desfeito, não desfaz de novo. */
  undoneAt?: string
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
  // Cartões e parcelamentos. Estados salvos antes desta versão não têm estes
  // campos — normalizeState() em store.tsx garante array vazio ao hidratar,
  // inclusive ao restaurar um backup antigo.
  cards: CreditCard[]
  installmentPlans: InstallmentPlan[]
  installments: Installment[]
  cardPayments: CardPayment[]
  cardCharges: RecurringCardCharge[]
  /**
   * Auditoria dos lotes do assistente. Opcional e retrocompatível: estados e
   * backups salvos antes desta versão simplesmente não têm o campo, e um lote
   * sem entrada aqui **nunca** é revertido por adivinhação.
   */
  assistantJournal?: AssistantJournalEntry[]
}
