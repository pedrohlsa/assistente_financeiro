// Execução de um LOTE de ações confirmadas — pura, sequencial e atômica.
//
// O que estava errado antes: `actions.forEach(a => applyParsedAction(dispatch,
// state, a))` passava o MESMO `state` para todas as ações do lote, porque o
// React só reprocessa depois. Dois depósitos na mesma meta se sobrescreviam, e
// se a terceira ação de quatro falhava, as duas primeiras já tinham sido salvas.
//
// Aqui cada ação enxerga o estado produzido pela anterior, e o lote inteiro é
// validado antes de qualquer gravação: ou tudo entra, ou nada entra.

import type {
  AppState, AssistantJournalEntry, ParsedAction, Transaction, InstallmentPlan,
  FinancialGoal, CreditCard,
} from '../models/types'
import type { ActionExecutionResult, AssistantErrorCode } from './contracts'
import { ASSISTANT_CONTRACT_VERSION, errorMessage, isPlausibleDate } from './contracts'
import { JOURNAL_LIMIT, diffForJournal, isRevertFailure, revertBatchPure } from './journal'
import { addDays, monthKey, nowPaymentTime, nowStamp, todayISO, uid } from '../utils/format'
import { normalizeName, sameName } from '../utils/text'
import { defaultIncomeCategory } from '../services/profile'
import { isOccurrenceResolved, matchRecurringPayment, nextCashEventTime, occurrencesBetween } from '../services/calc'
import { buildInstallments, cardInvoice, directInstallmentPaidAmount, futureInvoicePaymentDate,
  settleableInstallmentIds, suggestedFirstDueDate, unpaidPriorInvoiceMonth } from '../services/cards'

// ---------------------------------------------------------------------------
// Resolvedores de referência (moram aqui para o store poder ser puro)
// ---------------------------------------------------------------------------

const norm = (x?: string) => normalizeName(x)

/** Cartão pelo nome/instituição. Sem nome: só resolve se houver exatamente um. */
export function findCardByName(state: AppState, name?: string): CreditCard | undefined {
  const active = (state.cards || []).filter(c => !c.archived)
  const n = norm(name)
  if (!n) return active.length === 1 ? active[0] : undefined
  return (
    active.find(c => norm(c.name) === n) ||
    active.find(c => norm(c.name).includes(n) || n.includes(norm(c.name))) ||
    active.find(c => norm(c.institution).includes(n))
  )
}

/** Meta pelo nome (aproximado). Sem nome: só resolve se houver exatamente uma ativa. */
export function findGoalByName(state: AppState, name?: string): FinancialGoal | undefined {
  const active = state.goals.filter(g => !g.done)
  const n = norm(name)
  if (!n) return active.length === 1 ? active[0] : undefined
  return (
    active.find(g => norm(g.name) === n) ||
    active.find(g => norm(g.name).includes(n) || n.includes(norm(g.name))) ||
    active.find(g => n.split(/\s+/).some(w => w.length > 2 && norm(g.name).includes(w)))
  )
}

/** Meta com nome EQUIVALENTE (caixa/acento/espaço) — usada no aviso de duplicidade. */
export function findGoalByExactName(state: AppState, name?: string, exceptId?: string): FinancialGoal | undefined {
  if (!normalizeName(name)) return undefined
  return state.goals.find(g => g.id !== exceptId && sameName(g.name, name))
}

// ---------------------------------------------------------------------------
// Aplicação de UMA ação sobre o estado
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  source?: Transaction['source']
  /** Identificador do lote — auditoria de quais lançamentos vieram juntos. */
  batchId?: string
  /** Gerador de id injetável, para os testes serem determinísticos. */
  newId?: () => string
  now?: { date: string; time: string }
  /** Motor que produziu o lote — vai para o journal. */
  engine?: AssistantJournalEntry['engine']
  /** ID da mensagem do chat que originou o lote. NUNCA o texto dela. */
  messageId?: string
  /** Carimbo completo injetável, para os testes serem determinísticos. */
  stamp?: string
}

/**
 * Por que este lançamento NÃO pode ser corrigido isoladamente, ou `null`.
 *
 * Uma `Transaction` às vezes é só a ponta visível de outra estrutura: a entrada
 * financiada tem um plano de parcelas atrás, o abastecimento tem o registro do
 * veículo, a manutenção tem a peça. Mexer só no dinheiro deixaria as duas
 * metades divergentes — melhor recusar e dizer onde se corrige de verdade.
 */
export function editBlockReason(state: AppState, t: Transaction): string | null {
  if (t.type === 'financed-cash-inflow') {
    return 'ele faz parte de um parcelamento — corrija pela tela de Cartões e parcelamentos.'
  }
  const mesmoDiaEValor = (list: any[]) =>
    (list || []).some(x => x.date === t.date && Math.abs((x.amount ?? x.cost ?? 0) - t.amount) < 0.005)
  if (t.category === 'combustivel' && mesmoDiaEValor(state.fuelRecords)) {
    return 'ele acompanha um abastecimento — corrija pela tela do Veículo.'
  }
  if (t.category === 'manutencao' && mesmoDiaEValor(state.maintenance)) {
    return 'ele acompanha uma manutenção — corrija pela tela do Veículo.'
  }
  return null
}

const fail = (actionId: string, code: AssistantErrorCode, detail?: string, recoverable = true): ActionExecutionResult =>
  ({ ok: false, actionId, code, message: errorMessage(code, detail), recoverable })

/**
 * Aplica uma ação e devolve o PRÓXIMO estado. Nunca muta o estado recebido.
 * O `actionId` acompanha o resultado para a interface saber exatamente qual
 * card falhou — nada de erro genérico para o lote inteiro.
 */
export function applyActionPure(
  state: AppState,
  action: ParsedAction,
  actionId: string,
  opts: ApplyOptions = {},
): { state: AppState; result: ActionExecutionResult } {
  const gen = opts.newId || uid
  const date = opts.now?.date || todayISO()
  const time = opts.now?.time || nowPaymentTime()
  const source = opts.source || 'ai'
  const profileAtCreation = state.settings.profile
  const batch = opts.batchId

  const tx = (t: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'category'>): Transaction => ({
    id: gen(),
    date: (action as any).date || date,
    time,
    source,
    profileAtCreation,
    assistantBatchId: batch,
    ...t,
  } as Transaction)

  const withTx = (t: Transaction) => ({ ...state, transactions: [t, ...state.transactions] })

  switch (action.kind) {
    case 'income': {
      const t = tx({
        type: 'income', amount: action.amount,
        category: action.category || defaultIncomeCategory(state.settings),
        description: action.description, origin: action.origin,
      })
      return { state: withTx(t), result: { ok: true, actionId, entityId: t.id } }
    }
    case 'expense': {
      const fixed = matchRecurringPayment(state, action, date)
      if (fixed) return { state, result: fail(actionId,
        fixed.alreadyPaid && !fixed.pending.length ? 'occurrence-resolved' : 'recurring-conflict', action.description, false) }
      const t = tx({
        type: 'expense', amount: action.amount,
        category: action.category || 'outros-out',
        description: action.description, origin: action.origin,
      })
      return { state: withTx(t), result: { ok: true, actionId, entityId: t.id } }
    }
    case 'saving': {
      // Transferência para reserva. Continua FORA de receita e de despesa e fora
      // do saldo — a contabilização de `saving` não mudou nesta versão.
      const t = tx({
        type: 'saving', amount: action.amount, category: 'reserva',
        description: action.description || 'Guardado',
      })
      return { state: withTx(t), result: { ok: true, actionId, entityId: t.id } }
    }
    case 'work': {
      const d = (action as any).date || date
      const existing = state.workSessions.find(w => w.date === d)
      const workSessions = existing
        ? state.workSessions.map(w => w.date === d
          ? { ...w, km: w.km + (action.km || 0), trips: w.trips + (action.trips || 0), hours: w.hours + (action.hours || 0) }
          : w)
        : [{ id: gen(), date: d, km: action.km || 0, trips: action.trips || 0, hours: action.hours || 0 }, ...state.workSessions]
      return { state: { ...state, workSessions }, result: { ok: true, actionId } }
    }
    case 'fuel': {
      const liters = action.liters
        || (action.amount && state.settings.fuelPricePerLiter ? action.amount / state.settings.fuelPricePerLiter : 0)
      const price = action.pricePerLiter
        || (action.amount && liters ? action.amount / liters : state.settings.fuelPricePerLiter)
      const d = (action as any).date || date
      const record = {
        id: gen(), date: d, amount: action.amount || 0,
        liters: Math.round(liters * 100) / 100,
        pricePerLiter: Math.round(price * 100) / 100,
        odometer: action.odometer,
      }
      let next: AppState = {
        ...state,
        fuelRecords: [record, ...state.fuelRecords],
        vehicle: action.odometer && action.odometer > (state.vehicle?.odometer || 0)
          ? { ...(state.vehicle || { brand: '', model: 'Meu veículo', odometer: 0 }), odometer: action.odometer }
          : state.vehicle,
      }
      if (action.amount) {
        next = {
          ...next,
          transactions: [
            { id: gen(), type: 'expense', amount: action.amount, category: 'combustivel', description: 'Abastecimento', date: d, time, source, profileAtCreation, assistantBatchId: batch } as Transaction,
            ...next.transactions,
          ],
        }
      }
      return { state: next, result: { ok: true, actionId, entityId: record.id } }
    }
    case 'odometer': {
      const vehicle = state.vehicle || { brand: '', model: 'Meu veículo', odometer: 0 }
      return { state: { ...state, vehicle: { ...vehicle, odometer: action.value } }, result: { ok: true, actionId } }
    }
    case 'maintenance': {
      const name = action.item.charAt(0).toUpperCase() + action.item.slice(1)
      const d = (action as any).date || date
      const item = {
        id: gen(), name, cost: action.cost,
        kmInstalled: action.km ?? (state.vehicle?.odometer || 0),
        lifeKm: action.lifeKm || 0, date: d,
      }
      let next: AppState = {
        ...state,
        maintenance: [item, ...state.maintenance.filter(m => m.name !== name)],
        transactions: [
          { id: gen(), type: 'expense', amount: action.cost, category: 'manutencao', description: `Troca de ${action.item}`, date: d, time, source, profileAtCreation, assistantBatchId: batch } as Transaction,
          ...state.transactions,
        ],
      }
      if (action.km && next.vehicle && action.km > next.vehicle.odometer) {
        next = { ...next, vehicle: { ...next.vehicle, odometer: action.km } }
      }
      return { state: next, result: { ok: true, actionId, entityId: item.id } }
    }
    case 'goal': {
      // 'goal' SEMPRE cria — alterar uma existente é 'goal-update' (regra 14).
      const g: FinancialGoal = {
        id: gen(), name: action.name, target: action.target, saved: 0,
        deadline: action.months ? addDays(date, Math.round(action.months * 30)) : undefined,
        createdAt: date,
      }
      return { state: { ...state, goals: [g, ...state.goals] }, result: { ok: true, actionId, entityId: g.id } }
    }
    case 'goal-update': {
      const g = findGoalByName(state, action.name)
      if (!g) return { state, result: fail(actionId, 'goal-not-found', action.name ? `"${action.name}"` : undefined) }
      const patch: Partial<FinancialGoal> = {
        ...(action.target ? { target: action.target, done: g.saved >= action.target } : {}),
        ...(action.months ? { deadline: addDays(date, Math.round(action.months * 30)) } : {}),
      }
      return {
        state: { ...state, goals: state.goals.map(x => (x.id === g.id ? { ...x, ...patch } : x)) },
        result: { ok: true, actionId, entityId: g.id },
      }
    }
    case 'goal-deposit': {
      const g = findGoalByName(state, action.name)
      if (!g) return { state, result: fail(actionId, 'goal-not-found', action.name ? `"${action.name}"` : undefined) }
      const saved = g.saved + action.amount
      return {
        state: { ...state, goals: state.goals.map(x => (x.id === g.id ? { ...x, saved, done: saved >= x.target } : x)) },
        result: { ok: true, actionId, entityId: g.id },
      }
    }
    case 'balance': {
      return {
        state: { ...state, settings: { ...state.settings, balance: action.amount,
          balanceAsOf: opts.now ? `${date}T${opts.now.time}` : opts.stamp || `${date}T${nowPaymentTime()}` } },
        result: { ok: true, actionId },
      }
    }
    case 'card-purchase': {
      const card = findCardByName(state, action.cardName)
      if (action.cardName && !card) return { state, result: fail(actionId, 'card-not-found', `"${action.cardName}"`) }
      const count = Math.max(Math.round(action.installments || 1), 1)
      const plan: InstallmentPlan = {
        id: gen(),
        description: action.description || 'Compra no cartão',
        cardId: card?.id,
        categoryId: action.category || 'compras',
        totalAmount: action.total,
        installmentCount: count,
        firstDueDate: action.firstDueDate || suggestedFirstDueDate(card, date),
        purchaseDate: date,
        status: 'active',
        operationType: card ? 'card-purchase' : 'standalone',
        profileAtCreation,
        assistantBatchId: batch,
        createdAt: date,
      }
      return {
        state: {
          ...state,
          installmentPlans: [plan, ...state.installmentPlans],
          installments: [...state.installments, ...buildInstallments(plan, gen)],
        },
        result: { ok: true, actionId, entityId: plan.id },
      }
    }
    case 'financed-cash-inflow': {
      const card = findCardByName(state, action.cardName)
      if (action.cardName && !card) return { state, result: fail(actionId, 'card-not-found', `"${action.cardName}"`) }
      const count = Math.max(Math.round(action.installments || 1), 1)
      const plan: InstallmentPlan = {
        id: gen(),
        description: 'Entrada financiada pelo cartão',
        cardId: card?.id,
        categoryId: 'outros-out',
        totalAmount: action.total,
        installmentCount: count,
        firstDueDate: suggestedFirstDueDate(card, date),
        purchaseDate: date,
        feeAmount: Math.max(action.total - action.netReceived, 0),
        source: action.source,
        status: 'active',
        operationType: 'financed-cash-inflow',
        netReceived: action.netReceived,
        profileAtCreation,
        assistantBatchId: batch,
        createdAt: date,
      }
      // Dinheiro entra no caixa, mas NUNCA como receita: tipo próprio, fora de
      // todos os somatórios de income.
      const t = tx({
        type: 'financed-cash-inflow', amount: action.netReceived, category: 'outros-in',
        description: 'Entrada financiada pelo cartão',
      })
      return {
        state: {
          ...state,
          installmentPlans: [plan, ...state.installmentPlans],
          installments: [...state.installments, ...buildInstallments(plan, gen)],
          transactions: [t, ...state.transactions],
        },
        result: { ok: true, actionId, entityId: plan.id },
      }
    }
    case 'card-payment': {
      const active = (state.cards || []).filter(c => !c.archived)
      const card = findCardByName(state, action.cardName)
      if (!card) {
        if (!active.length) return { state, result: fail(actionId, 'card-not-found', 'Você ainda não cadastrou cartões.') }
        if (action.cardName) return { state, result: fail(actionId, 'card-not-found', `"${action.cardName}"`) }
        return { state, result: fail(actionId, 'card-ambiguous') }
      }
      const mk = monthKey(date)
      if (futureInvoicePaymentDate(state, card, mk)) return {
        state, result: fail(actionId, 'invoice-conflict', `${card.name}: há pagamento com data futura.`, false),
      }
      if (unpaidPriorInvoiceMonth(state, card, mk)) return {
        state, result: fail(actionId, 'invoice-conflict', `${card.name}: há fatura anterior pendente.`, false),
      }
      const invoice = cardInvoice(state, card, mk)
      if (invoice.paid > invoice.total + 0.009) return {
        state, result: fail(actionId, 'invoice-conflict', `${card.name}.`, false),
      }
      if (invoice.pending <= 0.009) return { state, result: fail(actionId, 'invoice-empty', `${card.name}.`, false) }
      const amount = action.amount ?? invoice.pending
      if (!(amount > 0)) return { state, result: fail(actionId, 'invoice-empty', `${card.name}.`, false) }
      const fullyPaid = amount >= invoice.pending - 0.009
      const settle = new Set(fullyPaid ? settleableInstallmentIds(state, invoice) : [])
      const payment = {
        id: gen(), cardId: card.id, amount, paymentDate: date,
        paymentTime: opts.now?.time || opts.stamp?.slice(11) || nowPaymentTime(),
        referenceMonth: mk, fromBalance: true, settledInstallmentIds: [...settle],
      }
      return {
        state: {
          ...state,
          cardPayments: [payment, ...state.cardPayments],
          installments: settle.size
            ? state.installments.map(i => (settle.has(i.id)
              ? directInstallmentPaidAmount(state, i) > 0
                ? { ...i, status: 'paid' as const, paidVia: 'direct' as const } // mantém a parte paga fora da fatura
                : { ...i, status: 'paid' as const, paidAt: date, paidAmount: i.amount, paidVia: 'invoice' as const }
              : i))
            : state.installments,
        },
        result: { ok: true, actionId, entityId: payment.id },
      }
    }
    case 'card-charge': {
      const card = findCardByName(state, action.cardName)
      if (!card) {
        const active = (state.cards || []).filter(c => !c.archived)
        if (!active.length) return { state, result: fail(actionId, 'card-not-found', 'Você ainda não cadastrou cartões.') }
        return { state, result: fail(actionId, action.cardName ? 'card-not-found' : 'card-ambiguous', action.cardName ? `"${action.cardName}"` : undefined) }
      }
      const charge = {
        id: gen(), cardId: card.id, description: action.description || 'Assinatura',
        amount: action.amount, categoryId: action.category || 'assinaturas',
        frequency: 'monthly' as const, nextDate: date, active: true, createdAt: date,
      }
      return { state: { ...state, cardCharges: [charge, ...state.cardCharges] }, result: { ok: true, actionId, entityId: charge.id } }
    }
    case 'recurring-confirm': {
      const rec = (state.recurring || []).find(r => r.id === action.recurringId)
      if (!rec) return { state, result: fail(actionId, 'recurring-not-found', action.description, false) }
      const occ = action.occurrenceDate
      // A chave recurringId + data é a mesma da Home: confirmar duas vezes o
      // mesmo vencimento é recusado, nunca duplicado.
      if (isOccurrenceResolved(rec, occ) || state.transactions.some(x => x.recurringId === rec.id && x.occurrenceDate === occ)) {
        return { state, result: fail(actionId, 'occurrence-resolved', rec.name, false) }
      }
      if (!isPlausibleDate(occ, date) || occ > date || !occurrencesBetween(rec, occ, occ, date).length) {
        return { state, result: fail(actionId, 'occurrence-invalid', rec.name, false) }
      }
      if (action.date && (!isPlausibleDate(action.date, date) || action.date > date)) {
        return { state, result: fail(actionId, action.date > date ? 'future-date' : 'invalid-date', action.date) }
      }
      const amount = action.amount ?? rec.amount
      if (!Number.isFinite(amount) || amount < 0.01 || amount > 99_999_999) {
        return { state, result: fail(actionId, 'invalid-amount', rec.name) }
      }
      const t = tx({
        type: rec.kind === 'income' ? 'income' : 'expense', amount, category: rec.category,
        description: rec.name, origin: rec.origin, recurringId: rec.id, occurrenceDate: occ,
      })
      const recurring = state.recurring.map(r => r.id !== rec.id ? r : {
        ...r, snoozeUntil: undefined,
        occurrences: [...(r.occurrences || []).filter(o => o.date !== occ), { date: occ, status: 'confirmed' as const, txId: t.id, amount }],
      })
      return { state: { ...withTx(t), recurring }, result: { ok: true, actionId, entityId: t.id } }
    }
    case 'edit-transaction': {
      const alvo = state.transactions.find(t => t.id === action.transactionId)
      if (!alvo) return { state, result: fail(actionId, 'transaction-not-found', undefined, false) }
      const bloqueio = editBlockReason(state, alvo)
      if (bloqueio) return { state, result: fail(actionId, 'edit-not-allowed', bloqueio, false) }

      const patch: any = {}
      if (action.amount !== undefined) patch.amount = action.amount
      if (action.description !== undefined) patch.description = action.description
      if (action.origin !== undefined) patch.origin = action.origin
      if (action.date !== undefined) patch.date = action.date
      if (action.category !== undefined) {
        const cat = state.categories.find(c => c.id === action.category)
        if (!cat) return { state, result: fail(actionId, 'category-not-found', action.category, false) }
        // O TIPO do lançamento nunca muda; a categoria tem que ser compatível
        // com ele. `saving` usa a categoria própria de reserva.
        const esperado = alvo.type === 'income' ? 'income' : 'expense'
        if (alvo.type !== 'saving' && cat.type !== esperado) {
          return { state, result: fail(actionId, 'category-wrong-type', cat.name, false) }
        }
        patch.category = cat.id
      }
      return {
        state: { ...state, transactions: state.transactions.map(t => (t.id === alvo.id ? { ...t, ...patch } : t)) },
        result: { ok: true, actionId, entityId: alvo.id },
      }
    }
    case 'undo-batch': {
      const rev = revertBatchPure(state, action.batchId, opts.stamp || nowStamp())
      if (isRevertFailure(rev)) return { state, result: fail(actionId, rev.code, undefined, false) }
      return { state: rev.state, result: { ok: true, actionId, entityId: action.batchId } }
    }
    case 'reset':
      // Reset NUNCA passa por aqui: é destrutivo e tem caminho próprio
      // (`resetAllData`), fora do lote, com diálogo de confirmação reforçado.
      return { state, result: fail(actionId, 'unsupported-action', 'Apagar tudo tem confirmação própria.', false) }
  }
  return { state, result: fail(actionId, 'unsupported-action') }
}

// ---------------------------------------------------------------------------
// Lote
// ---------------------------------------------------------------------------

export interface BatchItem { id: string; action: ParsedAction }

export interface BatchOutcome {
  /** Estado final. Em modo atômico com falha, é o estado ORIGINAL, intacto. */
  state: AppState
  results: ActionExecutionResult[]
  applied: boolean
}

/**
 * Aplica o lote inteiro em sequência — cada ação enxerga o resultado da anterior.
 *
 * `atomic: true` (padrão) só devolve o novo estado quando TODAS as ações deram
 * certo. Nunca acontece de três lançamentos entrarem e o quarto falhar calado.
 */
export function applyBatchPure(
  state: AppState,
  items: BatchItem[],
  opts: ApplyOptions & { atomic?: boolean } = {},
): BatchOutcome {
  const atomic = opts.atomic !== false
  let cur = state
  const results: ActionExecutionResult[] = []
  // O lote tem ordem conhecida mesmo quando todas as ações caem no mesmo
  // milissegundo: o sufixo ordinal coloca pagamentos/lançamentos antes ou
  // depois de uma âncora conforme a posição real na frase confirmada.
  const batchDate = opts.now?.date || opts.stamp?.slice(0, 10) || todayISO()
  const batchTime = opts.now?.time || opts.stamp?.slice(11) || nowPaymentTime()
  const normalizedTime = /^\d{2}:\d{2}$/.test(batchTime) ? `${batchTime}:00.000`
    : /^\d{2}:\d{2}:\d{2}$/.test(batchTime) ? `${batchTime}.000` : batchTime
  for (const item of items) {
    const time = nextCashEventTime(cur, batchDate, normalizedTime, true)
    const step = applyActionPure(cur, item.action, item.id,
      { ...opts, now: { date: batchDate, time } })
    results.push(step.result)
    if (step.result.ok) cur = step.state
    else if (atomic) return { state, results, applied: false }
  }

  // O journal entra no MESMO estado do lote: ou os dois gravam, ou nenhum.
  // Sem `batchId` não há o que auditar — é o caso da simulação, que descarta
  // o estado inteiro e não pode deixar rastro.
  // Desfazer FECHA o lote anterior; ele mesmo não vira um lote auditável,
  // senão "desfaz o último" logo depois refaria tudo — um "refazer" que
  // ninguém pediu e que confundiria o histórico.
  const ehUndo = items.some(i => i.action.kind === 'undo-batch')
  if (opts.batchId && !ehUndo) {
    const ops = diffForJournal(state, cur)
    if (ops.length) {
      const entry: AssistantJournalEntry = {
        batchId: opts.batchId,
        contractVersion: ASSISTANT_CONTRACT_VERSION,
        source: opts.source || 'ai',
        engine: opts.engine,
        createdAt: opts.stamp || nowStamp(),
        profileAtCreation: state.settings.profile,
        messageId: opts.messageId,
        ops,
      }
      cur = { ...cur, assistantJournal: [entry, ...(cur.assistantJournal || [])].slice(0, JOURNAL_LIMIT) }
    }
  }

  return { state: cur, results, applied: true }
}

/**
 * Simulação: roda o lote e descarta o estado. Usada para (a) validar antes de
 * mostrar o botão Confirmar e (b) responder perguntas hipotéticas ("se você
 * confirmar, sobra quanto?") sem gravar nada.
 */
export function planAssistantActions(state: AppState, items: BatchItem[]): {
  results: ActionExecutionResult[]
  projected: AppState
  ok: boolean
} {
  const out = applyBatchPure(state, items, { atomic: false })
  return { results: out.results, projected: out.state, ok: out.results.every(r => r.ok) }
}
