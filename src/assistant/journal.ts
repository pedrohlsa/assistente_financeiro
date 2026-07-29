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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Só os campos que mudaram, com o valor ANTERIOR — o journal fica pequeno. */
function changedFields(before: any, after: any): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (!same(before?.[k], after?.[k])) out[k] = before?.[k]
  }
  return Object.keys(out).length ? out : null
}

/** O que o lote fez, comparando o estado antes e depois. */
export function diffForJournal(before: AppState, after: AppState): AssistantJournalOp[] {
  const ops: AssistantJournalOp[] = []

  for (const col of COLLECTIONS) {
    const antes = byId((before as any)[col])
    const depois = byId((after as any)[col])
    for (const [id, novo] of depois) {
      const velho = antes.get(id)
      if (!velho) { ops.push({ op: 'create', entity: col, id }); continue }
      const mudou = changedFields(velho, novo)
      if (mudou) ops.push({ op: 'update', entity: col, id, before: mudou })
    }
    // Sim, um lote pode APAGAR: registrar manutenção substitui a peça anterior
    // de mesmo nome. Sem o retrato, desfazer perderia o registro antigo.
    for (const [id, velho] of antes) {
      if (!depois.has(id)) ops.push({ op: 'delete', entity: col, id, snapshot: velho })
    }
  }

  const settingsBefore: Record<string, unknown> = {}
  for (const k of SETTINGS_KEYS) {
    if (!same((before.settings as any)?.[k], (after.settings as any)?.[k])) {
      settingsBefore[k] = (before.settings as any)?.[k]
    }
  }
  if (Object.keys(settingsBefore).length) ops.push({ op: 'patch', entity: 'settings', before: settingsBefore })

  if (!same(before.vehicle, after.vehicle)) {
    ops.push({ op: 'patch', entity: 'vehicle', before: before.vehicle ?? null })
  }

  return ops
}

export type RevertFailureCode = 'batch-not-found' | 'batch-not-reversible' | 'already-undone'

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

  let next = state
  // Ordem INVERSA: a última coisa que o lote fez é a primeira a ser desfeita.
  for (const op of [...entry.ops].reverse()) {
    if (op.op === 'patch') {
      next = op.entity === 'settings'
        ? { ...next, settings: { ...next.settings, ...(op.before as any) } }
        : { ...next, vehicle: op.before }
      continue
    }
    const atual: any[] = Array.isArray((next as any)[op.entity]) ? (next as any)[op.entity] : []
    if (op.op === 'create') {
      next = { ...next, [op.entity]: atual.filter(x => x.id !== op.id) } as AppState
    } else if (op.op === 'update') {
      next = { ...next, [op.entity]: atual.map(x => (x.id === op.id ? { ...x, ...op.before } : x)) } as AppState
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
