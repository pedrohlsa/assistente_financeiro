// Harness do corpus de regressão do assistente.
//
// Roda o orquestrador REAL, offline e determinístico: nenhuma chamada de rede,
// nenhum localStorage, nenhuma dependência de horário além da data injetada.
// É o mesmo código que a tela usa — não uma reimplementação para o teste.

import type { AppState, AssistantJournalEntry, ParsedAction, ProfileId } from '../../src/models/types'
import { DEFAULT_CATEGORIES } from '../../src/data/categories'
import { orchestrate } from '../../src/assistant/orchestrator'
import type { AssistantCandidateAction, AssistantResponse } from '../../src/assistant/contracts'
import type { AssistantDraft } from '../../src/assistant/drafts'
import { applyBatchPure } from '../../src/assistant/execute'
import type { ConversationFocus } from '../../src/assistant/conversation'

export const TODAY = '2026-07-15' // quarta-feira

export interface CaseState {
  profile?: ProfileId
  balance?: number
  cards?: { name: string; limit?: number; closingDay?: number; dueDay?: number }[]
  goals?: { name: string; target: number; saved?: number }[]
  /** `id` explícito quando o caso precisa referenciá-lo (journal do undo). */
  transactions?: Partial<ParsedAction & { id: string; type: string; amount: number; category: string; date: string }>[]
  monthlyProfitTarget?: number
  remoteAi?: boolean
  /** Lotes já confirmados pelo assistente — base do "desfaz o último". */
  journal?: AssistantJournalEntry[]
  /** Veículo e manutenções — perguntas de motorista dependem dos dois. */
  vehicle?: { name?: string; odometer?: number } | null
  maintenance?: { id?: string; name: string; cost?: number; kmInstalled?: number; lifeKm?: number; date?: string }[]
  /**
   * Categorias que o usuário arquivou DEPOIS de já ter usado no histórico. É o
   * cenário que fazia o aprendizado propor uma categoria que a validação
   * recusava — e o lançamento inteiro sumia.
   */
  archivedCategories?: string[]
  /** Aprendizado pessoal ligado/desligado (ausente = ligado). */
  adaptiveAssistant?: boolean
  workSessions?: { id?: string; date: string; km?: number; hours?: number; trips?: number }[]
  fuelRecords?: { id?: string; date: string; amount?: number; liters?: number; odometer?: number }[]
}

export function buildState(cs: CaseState = {}): AppState {
  return {
    settings: {
      name: 'Teste', currency: 'BRL', theme: 'light',
      profile: cs.profile || 'other', priority: '', onboarded: true, demo: false,
      monthlyProfitTarget: cs.monthlyProfitTarget ?? 0, safetyMarginPct: 10,
      workDays: [1, 2, 3, 4, 5, 6], homeCards: ['km'],
      fuelPricePerLiter: 0, kmPerLiter: 0, minPerKm: 0, comfortPerKm: 0,
      fixedMonthlyCosts: 0, notifications: true,
      balance: cs.balance ?? 0, ask99Fee: true, platform99Fee: 1,
      remoteAi: cs.remoteAi ?? false,
      adaptiveAssistant: cs.adaptiveAssistant,
    },
    transactions: (cs.transactions || []).map((t: any, i) => ({
      // Id explícito é preservado: o journal do "desfaz o último" aponta para
      // ele, e sobrescrever aqui fazia a reversão não achar o lançamento.
      // O espalhamento preserva campos extras do cenário (`recurringId`,
      // `occurrenceDate`) que a edição de ocorrência materializada precisa.
      ...t,
      id: t.id || `tx${i}`, type: t.type || 'expense', amount: t.amount, category: t.category || 'outros-out',
      description: t.description, date: t.date || TODAY, time: t.time || '10:00',
    })) as any,
    categories: cs.archivedCategories?.length
      ? DEFAULT_CATEGORIES.map(c => (cs.archivedCategories!.includes(c.id) ? { ...c, archived: true } : c))
      : DEFAULT_CATEGORIES,
    workSessions: (cs.workSessions || []).map((w, i) => ({
      id: w.id || `ws${i}`, date: w.date, km: w.km ?? 0, hours: w.hours ?? 0, trips: w.trips ?? 0,
    })) as any,
    fuelRecords: (cs.fuelRecords || []).map((f, i) => ({
      id: f.id || `fr${i}`, date: f.date, amount: f.amount ?? 0, liters: f.liters ?? 0, odometer: f.odometer ?? 0,
    })) as any,
    vehicle: cs.vehicle ? { name: cs.vehicle.name || 'Carro', odometer: cs.vehicle.odometer ?? 0 } as any : null,
    maintenance: (cs.maintenance || []).map((m, i) => ({
      id: m.id || `mt${i}`, name: m.name, cost: m.cost ?? 0,
      kmInstalled: m.kmInstalled ?? 0, lifeKm: m.lifeKm ?? 0, date: m.date || TODAY,
    })),
    goals: (cs.goals || []).map((g, i) => ({
      id: `g${i}`, name: g.name, target: g.target, saved: g.saved ?? 0, createdAt: TODAY,
    })),
    deficits: [], recurring: [], budgets: [], chat: [], dismissedDeficitDates: [],
    cards: (cs.cards || []).map((c, i) => ({
      id: `card${i}`, name: c.name, limit: c.limit ?? 5000,
      closingDay: c.closingDay ?? 1, dueDay: c.dueDay ?? 10, createdAt: TODAY,
    })),
    installmentPlans: [], installments: [], cardPayments: [], cardCharges: [],
    assistantJournal: cs.journal || [],
  }
}

export interface ExpectedAction {
  kind: ParsedAction['kind']
  [field: string]: any
}

export interface AssistantCase {
  id: string
  group: string
  profile?: ProfileId
  /** Uma ou mais mensagens, na ordem — cobre o fluxo multiturno. */
  messages: string[]
  state?: CaseState
  /** Modo esperado da ÚLTIMA resposta. */
  expectMode?: AssistantResponse['mode']
  /** Ações esperadas na última resposta (subconjunto de campos). */
  expectActions?: ExpectedAction[]
  /** Nenhuma ação deve ser proposta. */
  expectNoActions?: boolean
  /** Trechos que a resposta precisa conter. */
  expectReply?: (string | RegExp)[]
  /** Trechos proibidos na resposta. */
  forbidReply?: (string | RegExp)[]
  /**
   * Aviso mostrado no card da proposta. Não sai no texto da resposta — mora no
   * candidato —, então precisa de asserção própria.
   */
  expectWarning?: string | RegExp
  /** Nenhum item da proposta pode trazer aviso. */
  expectNoWarning?: boolean
  /** A pergunta de esclarecimento precisa casar. */
  expectClarification?: string | RegExp
  /** Confirmar o lote e conferir o estado resultante. */
  thenConfirm?: (state: AppState) => string | null
}

export interface CaseResult {
  id: string
  group: string
  ok: boolean
  errors: string[]
}

const matches = (text: string, m: string | RegExp) =>
  typeof m === 'string' ? text.toLowerCase().includes(m.toLowerCase()) : m.test(text)

function checkAction(actual: ParsedAction, expected: ExpectedAction): string | null {
  if (actual.kind !== expected.kind) return `kind ${actual.kind} ≠ ${expected.kind}`
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'kind') continue
    const got = (actual as any)[k]
    if (typeof v === 'number') {
      if (typeof got !== 'number' || Math.abs(got - v) > 0.005) return `${k}=${got} ≠ ${v}`
    } else if (v instanceof RegExp) {
      if (!v.test(String(got ?? ''))) return `${k}="${got}" não casa ${v}`
    } else if (v === null) {
      if (got !== undefined && got !== null) return `${k} deveria estar ausente, veio "${got}"`
    } else if (String(got ?? '').toLowerCase() !== String(v).toLowerCase()) {
      return `${k}="${got}" ≠ "${v}"`
    }
  }
  return null
}

export async function runCase(c: AssistantCase): Promise<CaseResult> {
  const errors: string[] = []
  const state = buildState({ ...c.state, profile: c.profile || c.state?.profile })
  let draft: AssistantDraft | null = null
  let pending: AssistantCandidateAction[] | undefined
  let clarification: any
  let last: AssistantResponse | null = null
  // Foco conversacional entre as mensagens do MESMO caso — e o que faz
  // "e mes passado?" refinar a consulta anterior no corpus, exatamente como na
  // tela. Sem isso o multiturno de continuidade nao teria como ser testado.
  let focus: ConversationFocus | undefined

  for (const msg of c.messages) {
    const out = await orchestrate({
      state, message: msg,
      draft: draft || undefined, pending, pendingClarification: clarification,
      focus,
      remoteEnabled: false, today: TODAY,
    })
    last = out.response
    if (out.focus) focus = out.focus
    draft = out.draft
    pending = out.correctedPending
      ? out.correctedPending
      : out.response.actions.length
        ? out.response.actions
        : out.keepPending ? pending : undefined
    clarification = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
  }

  if (!last) return { id: c.id, group: c.group, ok: false, errors: ['sem resposta'] }

  if (c.expectMode && last.mode !== c.expectMode) {
    errors.push(`mode "${last.mode}" ≠ "${c.expectMode}"`)
  }
  if (c.expectNoActions && last.actions.length) {
    errors.push(`esperava 0 ações, veio ${last.actions.length} (${last.actions.map(a => a.action.kind).join(', ')})`)
  }
  if (c.expectActions) {
    if (last.actions.length !== c.expectActions.length) {
      errors.push(`esperava ${c.expectActions.length} ações, veio ${last.actions.length} (${last.actions.map(a => a.action.kind).join(', ')})`)
    } else {
      for (let i = 0; i < c.expectActions.length; i++) {
        const err = checkAction(last.actions[i].action, c.expectActions[i])
        if (err) errors.push(`ação ${i + 1}: ${err}`)
      }
    }
  }
  for (const m of c.expectReply || []) {
    if (!matches(last.reply, m)) errors.push(`resposta não contém ${m}`)
  }
  for (const m of c.forbidReply || []) {
    if (matches(last.reply, m)) errors.push(`resposta contém proibido ${m}`)
  }
  const avisos = last.actions.map(a => a.patternWarning || a.duplicateWarning || '').filter(Boolean)
  if (c.expectWarning && !avisos.some(a => matches(a, c.expectWarning!))) {
    errors.push(`nenhum aviso casa ${c.expectWarning} (avisos: ${JSON.stringify(avisos)})`)
  }
  if (c.expectNoWarning && avisos.length) {
    errors.push(`esperava nenhum aviso, veio ${JSON.stringify(avisos)}`)
  }
  if (c.expectClarification) {
    const q = last.mode === 'clarify' ? (last as any).clarification?.question || '' : ''
    if (!matches(q || last.reply, c.expectClarification)) {
      errors.push(`esclarecimento "${q || last.reply}" não casa ${c.expectClarification}`)
    }
  }
  if (c.thenConfirm) {
    const out = applyBatchPure(state, last.actions.map(a => ({ id: a.id, action: a.action })), { source: 'ai' })
    const err = c.thenConfirm(out.state)
    if (err) errors.push(`após confirmar: ${err}`)
  }

  return { id: c.id, group: c.group, ok: errors.length === 0, errors }
}
