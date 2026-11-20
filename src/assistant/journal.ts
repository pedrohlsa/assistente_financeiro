// Auditoria reversível dos lotes do assistente.
//
// POR QUE UM JOURNAL, e não só `assistantBatchId` dentro da entidade: o campo
// marca o que NASCEU no lote, e várias ações alteram objetos que já existiam —
// depósito em meta, pagamento de fatura (que quita parcelas), abastecimento que
// atualiza o hodômetro, manutenção que substitui a peça anterior. Sem guardar o
// valor ANTERIOR desses objetos, desfazer o lote seria adivinhação.
//
// A auditoria é derivada por DIFERENÇA entre o estado antes e depois do lote.
// É de propósito: assim ela cobre qualquer ação do catálogo, inclusive as que
// vierem depois, sem depender de cada `case` do executor lembrar de se
// registrar. Uma ação nova entra auditada por construção.

import type {
  AppState, AssistantJournalEntry, AssistantJournalOp, JournalCollection,
} from '../models/types'
import { hasRecordedInstallmentPayment, invoicePaymentsForInstallments, planInstallments } from '../services/cards'
import { ERROR_MESSAGES } from './contracts'

/** Coleções varridas pela diferença. Todas são listas com `id`. */
const COLLECTIONS: JournalCollection[] = [
  'transactions', 'goals', 'cards', 'installmentPlans', 'installments',
  'cardPayments', 'cardCharges', 'fuelRecords', 'workSessions',
  'maintenance', 'recurring', 'budgets', 'deficits',
]

/** Campos de `settings` que uma ação do assistente pode alterar. */
const SETTINGS_KEYS = ['balance', 'balanceAsOf'] as const

/** Quantos lotes ficam guardados. Além disso o undo recusa, em vez de chutar. */
export const JOURNAL_LIMIT = 20

const byId = (list: any): Map<string, any> => {
  const m = new Map<string, any>()
  for (const x of Array.isArray(list) ? list : []) if (x && x.id) m.set(x.id, x)
  return m
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => same(value, b[i]))
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = Object.entries(a).filter(([, value]) => value !== undefined)
  const right = Object.keys(b).filter(key => b[key] !== undefined)
  return left.length === right.length && left.every(([key, value]) => same(value, b[key]))
}

/** JSON omite undefined, então campos antes ausentes precisam de registro próprio. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>,
  keys: Iterable<string> = new Set([...Object.keys(before), ...Object.keys(after)]),
): { before: Record<string, unknown>; absent?: string[]; after: Record<string, unknown> } | null {
  const changed = [...keys].filter(k => !same(before[k], after[k]))
  if (!changed.length) return null
  const absent = changed.filter(k => before[k] === undefined)
  return {
    before: Object.fromEntries(changed.filter(k => before[k] !== undefined).map(k => [k, before[k]])),
    after: Object.fromEntries(changed.filter(k => after[k] !== undefined).map(k => [k, after[k]])),
    ...(absent.length ? { absent } : {}),
  }
}

function restoreFields<T extends object>(current: T, before: Record<string, unknown>, absent?: string[]): T {
  const restored = { ...current, ...before }
  if (Array.isArray(absent)) {
    for (const key of absent) delete restored[key]
  }
  return restored
}

/** O que o lote fez, comparando o estado antes e depois. */
export function diffForJournal(before: AppState, after: AppState): AssistantJournalOp[] {
  const ops: AssistantJournalOp[] = []

  for (const col of COLLECTIONS) {
    const antes = byId((before as any)[col])
    const depois = byId((after as any)[col])
    for (const [id, novo] of depois) {
      const velho = antes.get(id)
      if (!velho) {
        const priorInvoicePaymentIds = col === 'installmentPlans'
          ? invoicePaymentsForInstallments(before.cardPayments, novo.cardId, planInstallments(after, id)).map(p => p.id)
          : []
        ops.push({ op: 'create', entity: col, id, after: novo, ...(priorInvoicePaymentIds.length ? { priorInvoicePaymentIds } : {}) })
        continue
      }
      const mudou = changedFields(velho, novo)
      if (mudou) ops.push({ op: 'update', entity: col, id, ...mudou })
    }
    // Sim, um lote pode APAGAR: registrar manutenção substitui a peça anterior
    // de mesmo nome. Sem o retrato, desfazer perderia o registro antigo.
    for (const [id, velho] of antes) {
      if (!depois.has(id)) ops.push({ op: 'delete', entity: col, id, snapshot: velho })
    }
  }

  const settings = changedFields({ ...before.settings }, { ...after.settings }, SETTINGS_KEYS)
  if (settings) ops.push({ op: 'patch', entity: 'settings', ...settings })

  if (!same(before.vehicle, after.vehicle)) {
    ops.push({ op: 'patch', entity: 'vehicle', before: before.vehicle ?? null, after: after.vehicle ?? null })
  }

  return ops
}

export type RevertFailureCode = 'batch-not-found' | 'batch-not-reversible' | 'already-undone' | 'batch-changed'

export type RevertOutcome =
  | { ok: true; state: AppState; entry: AssistantJournalEntry }
  | { ok: false; code: RevertFailureCode; message: string }

/** Predicado explícito — obrigatório sob `strict: false` (CLAUDE.md, regra 24). */
export function isRevertFailure(o: RevertOutcome): o is { ok: false; code: RevertFailureCode; message: string } {
  return o.ok === false
}

export const findJournalEntry = (state: AppState, batchId: string): AssistantJournalEntry | undefined =>
  (state.assistantJournal || []).find(e => e.batchId === batchId)

/** Último lote que ainda pode ser desfeito. `undefined` quando não há nenhum. */
export const lastReversibleBatch = (state: AppState): AssistantJournalEntry | undefined =>
  (state.assistantJournal || []).find(e => !e.undoneAt && e.ops?.length > 0)

function fieldsChangedSince(current: object, before: Record<string, unknown>, absent: string[] | undefined,
  after: Record<string, unknown> | undefined): boolean {
  return !!after && [...Object.keys(before), ...(Array.isArray(absent) ? absent : [])].some(key => !same(current[key], after[key]))
}

function hasUndoConflict(state: AppState, entry: AssistantJournalEntry): boolean {
  const created = (entity: JournalCollection) => new Set(entry.ops.flatMap(op => op.op === 'create' && op.entity === entity ? [op.id] : []))
  const planIds = created('installmentPlans')
  const installmentIds = created('installments')
  const paymentIds = created('cardPayments')
  const cardIds = created('cards')
  const chargeIds = created('cardCharges')
  const transactionIds = created('transactions')
  const otherPayments = state.cardPayments.filter(p => !paymentIds.has(p.id))

  for (const op of entry.ops) {
    if (op.op === 'patch') {
      if (op.entity === 'settings') {
        if (fieldsChangedSince(state.settings, op.before, op.absent, op.after)) return true
        if (!op.after && state.settings.balanceAsOf?.slice(0, 16) > entry.createdAt?.slice(0, 16)) return true
      } else if (op.after !== undefined && !same(state.vehicle, op.after)) return true
      continue
    }
    const current = state[op.entity]?.find(item => item.id === op.id)
    if (op.op === 'delete') {
      if (current && !same(current, op.snapshot)) return true
    } else if (!current) return true
    else if (op.op === 'create') {
      if (op.after && !same(current, op.after)) return true
    } else if (fieldsChangedSince(current, op.before, op.absent, op.after)) return true
  }

  for (const op of entry.ops) {
    if (op.op !== 'create' || op.entity !== 'installmentPlans') continue
    const plan = state.installmentPlans.find(p => p.id === op.id)
    const installments = planInstallments(state, plan.id)
    if (installments.some(i => !installmentIds.has(i.id))
      || invoicePaymentsForInstallments(otherPayments, plan.cardId, installments).some(p => !op.priorInvoicePaymentIds?.includes(p.id))) return true
    if (state.transactions.some(t => t.financedPlanId === plan.id && !transactionIds.has(t.id))) return true
  }
  const legacyInstallments = new Set(entry.ops.flatMap(op => op.op === 'create' && op.entity === 'installments' && !op.after ? [op.id] : []))
  if (state.installments.some(i => legacyInstallments.has(i.id) && hasRecordedInstallmentPayment(i)
    && !state.cardPayments.some(p => paymentIds.has(p.id) && p.settledInstallmentIds?.includes(i.id)))) return true

  if (state.installmentPlans.some(p => cardIds.has(p.cardId) && !planIds.has(p.id))
    || otherPayments.some(p => cardIds.has(p.cardId))
    || state.cardCharges.some(c => cardIds.has(c.cardId) && !chargeIds.has(c.id))) return true

  // Um lançamento antigo criado pelo chat pode ter sido vinculado pela Home.
  const touchedRecurring = new Set(entry.ops.flatMap(op => (op.op === 'create' || op.op === 'update') && op.entity === 'recurring' ? [op.id] : []))
  return state.transactions.some(t => transactionIds.has(t.id) && !!t.recurringId && !touchedRecurring.has(t.recurringId))
    || state.recurring.some(r => !touchedRecurring.has(r.id) && r.occurrences?.some(o => transactionIds.has(o.txId)))
}

/**
 * Desfaz um lote inteiro a partir do journal. Puro e atômico: ou devolve o
 * estado revertido por completo, ou devolve o motivo — nunca meia reversão.
 *
 * Lote sem entrada no journal (anterior a esta versão, ou já fora do limite)
 * é RECUSADO com explicação. Reconstruir o passado procurando ids parecidos
 * seria exatamente o tipo de chute que esta estrutura existe para impedir.
 */
export function revertBatchPure(state: AppState, batchId: string, stamp: string): RevertOutcome {
  const diario = state.assistantJournal || []
  const entry = diario.find(e => e.batchId === batchId)
  if (!entry) {
    return {
      ok: false, code: 'batch-not-found',
      message: 'Não tenho o registro detalhado desse lançamento, então não sei desfazer com segurança. Você pode remover pela tela de Movimentações.',
    }
  }
  if (entry.undoneAt) {
    return { ok: false, code: 'already-undone', message: 'Esse lote já foi desfeito.' }
  }
  if (!entry.ops?.length) {
    return {
      ok: false, code: 'batch-not-reversible',
      message: 'Esse lote não tem detalhe suficiente para ser desfeito com segurança.',
    }
  }
  if (hasUndoConflict(state, entry)) {
    return { ok: false, code: 'batch-changed', message: ERROR_MESSAGES['batch-changed'] }
  }

  let next = state
  // Ordem INVERSA: a última coisa que o lote fez é a primeira a ser desfeita.
  for (const op of [...entry.ops].reverse()) {
    if (op.op === 'patch') {
      next = op.entity === 'settings'
        ? { ...next, settings: restoreFields(next.settings, op.before, op.absent) }
        : { ...next, vehicle: op.before }
      continue
    }
    const atual: any[] = Array.isArray((next as any)[op.entity]) ? (next as any)[op.entity] : []
    if (op.op === 'create') {
      next = { ...next, [op.entity]: atual.filter(x => x.id !== op.id) } as AppState
    } else if (op.op === 'update') {
      next = { ...next, [op.entity]: atual.map(x => (x.id === op.id ? restoreFields(x, op.before, op.absent) : x)) } as AppState
    } else {
      // Recriar só se ainda não existir — reversão idempotente por item.
      next = atual.some(x => x.id === op.id)
        ? next
        : { ...next, [op.entity]: [op.snapshot, ...atual] } as AppState
    }
  }

  return {
    ok: true,
    entry,
    state: {
      ...next,
      assistantJournal: diario.map(e => (e.batchId === batchId ? { ...e, undoneAt: stamp } : e)),
    },
  }
}
