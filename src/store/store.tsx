// Estado global + persistência local (localStorage) — funciona offline.
// Preparado para sincronização futura: cada mutação passa por dispatch,
// bastando acoplar uma fila de sync (INTEGRAÇÃO PENDENTE: backend/Supabase).
import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react'
import {
  AppState, Transaction, WorkSession, FuelRecord, MaintenanceItem, FinancialGoal,
  Deficit, RecurringExpense, RecurrenceOccurrence, Budget, ChatMessage, Settings, Vehicle, ParsedAction, Category,
  CreditCard, InstallmentPlan, Installment, CardPayment, RecurringCardCharge,
} from '../models/types'
import { DEFAULT_CATEGORIES, mergeDefaultCategories } from '../data/categories'
import { buildDemoData } from '../data/demo'
import { addDays, monthKey, nowStamp, nowTime, todayISO, uid } from '../utils/format'
import { normalizeName, sameName } from '../utils/text'
import { can99FeeApply, defaultIncomeCategory } from '../services/profile'
import { buildInstallments, cardInvoice, suggestedFirstDueDate } from '../services/cards'

const STORAGE_KEY = 'assistfin-state-v1'

const defaultSettings: Settings = {
  name: '', currency: 'BRL', theme: 'light', profile: 'driver', priority: '',
  onboarded: false, demo: false,
  monthlyProfitTarget: 4500, safetyMarginPct: 10,
  workDays: [1, 2, 3, 4, 5, 6],
  homeCards: ['km', 'trips', 'netkm', 'perhour'],
  fuelPricePerLiter: 6.1, kmPerLiter: 11, minPerKm: 1.55, comfortPerKm: 2,
  fixedMonthlyCosts: 450, notifications: true,
  balance: 0, ask99Fee: true, platform99Fee: 1, remoteAi: true,
}

const initialState: AppState = {
  settings: defaultSettings,
  transactions: [], categories: DEFAULT_CATEGORIES,
  workSessions: [], fuelRecords: [], vehicle: null, maintenance: [],
  goals: [], deficits: [], recurring: [], budgets: [], chat: [],
  dismissedDeficitDates: [],
  cards: [], installmentPlans: [], installments: [], cardPayments: [], cardCharges: [],
}

/**
 * Garante que todo array esperado existe, mesmo em estados salvos antes de uma
 * funcionalidade existir. Vale tanto para o localStorage quanto para um backup
 * antigo restaurado — sem isso, `state.cards.map(...)` quebraria o app inteiro.
 */
function normalizeState(raw: any): AppState {
  const arr = <T,>(v: any, fallback: T[] = []): T[] => (Array.isArray(v) ? v : fallback)
  return {
    ...initialState,
    ...raw,
    settings: { ...defaultSettings, ...(raw?.settings || {}) },
    transactions: arr(raw?.transactions),
    // Fusão, não substituição: quem já usava o app recebe as categorias padrão
    // novas sem perder as personalizadas nem o estado "arquivada".
    categories: mergeDefaultCategories(raw?.categories),
    workSessions: arr(raw?.workSessions),
    fuelRecords: arr(raw?.fuelRecords),
    maintenance: arr(raw?.maintenance),
    goals: arr(raw?.goals),
    deficits: arr(raw?.deficits),
    recurring: arr(raw?.recurring),
    budgets: arr(raw?.budgets),
    chat: arr(raw?.chat),
    dismissedDeficitDates: arr(raw?.dismissedDeficitDates),
    vehicle: raw?.vehicle ?? null,
    cards: arr(raw?.cards),
    installmentPlans: arr(raw?.installmentPlans),
    installments: arr(raw?.installments),
    cardPayments: arr(raw?.cardPayments),
    cardCharges: arr(raw?.cardCharges),
  }
}

type Action =
  | { type: 'hydrate'; state: AppState }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'addTx'; tx: Transaction }
  | { type: 'removeTx'; id: string }
  | { type: 'addWork'; w: Partial<WorkSession> }
  | { type: 'addFuel'; f: FuelRecord }
  | { type: 'setVehicle'; v: Vehicle }
  | { type: 'addMaintenance'; m: MaintenanceItem }
  | { type: 'removeMaintenance'; id: string }
  | { type: 'addGoal'; g: FinancialGoal }
  | { type: 'updateGoal'; id: string; patch: Partial<FinancialGoal> }
  | { type: 'removeGoal'; id: string }
  | { type: 'addDeficit'; d: Deficit }
  | { type: 'dismissDeficit'; date: string }
  | { type: 'payDeficits'; amount: number }
  | { type: 'addRecurring'; r: RecurringExpense }
  | { type: 'removeRecurring'; id: string }
  | { type: 'addBudget'; b: Budget }
  | { type: 'removeBudget'; id: string }
  | { type: 'addCategory'; c: Category }
  | { type: 'archiveCategory'; id: string; archived: boolean }
  | { type: 'updateRecurring'; id: string; patch: Partial<RecurringExpense> }
  | { type: 'resolveOccurrence'; recurringId: string; occurrence: RecurrenceOccurrence }
  | { type: 'mergeState'; state: Partial<AppState> }
  // --- cartões e parcelamentos ---
  | { type: 'addCard'; card: CreditCard }
  | { type: 'updateCard'; id: string; patch: Partial<CreditCard> }
  | { type: 'removeCard'; id: string }
  | { type: 'addPlan'; plan: InstallmentPlan; installments: Installment[] }
  | { type: 'updatePlan'; id: string; patch: Partial<InstallmentPlan> }
  /** Remove o plano e TODAS as suas parcelas (histórico incluído). */
  | { type: 'removePlan'; id: string }
  /** Cancela apenas as parcelas ainda não pagas — preserva o histórico. */
  | { type: 'cancelFutureInstallments'; planId: string }
  | { type: 'payInstallment'; id: string; paidAt: string; paidAmount?: number }
  | { type: 'unpayInstallment'; id: string }
  | { type: 'updateInstallment'; id: string; patch: Partial<Installment> }
  | { type: 'addCardPayment'; payment: CardPayment; settleInstallmentIds: string[] }
  | { type: 'removeCardPayment'; id: string }
  | { type: 'addCardCharge'; charge: RecurringCardCharge }
  | { type: 'updateCardCharge'; id: string; patch: Partial<RecurringCardCharge> }
  | { type: 'removeCardCharge'; id: string }
  | { type: 'chat'; msg: ChatMessage }
  | { type: 'chatResolve'; id: string }
  | { type: 'chatClear' }
  | { type: 'loadDemo' }
  | { type: 'reset' }

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    // Backup antigo (sem cartões/parcelas) precisa ser normalizado, senão o app quebra.
    case 'hydrate': return normalizeState(a.state)
    case 'settings': return { ...s, settings: { ...s.settings, ...a.patch } }
    case 'addTx': return { ...s, transactions: [a.tx, ...s.transactions] }
    case 'removeTx': return { ...s, transactions: s.transactions.filter(t => t.id !== a.id) }
    case 'addWork': {
      const date = a.w.date || todayISO()
      const existing = s.workSessions.find(w => w.date === date)
      if (existing) {
        return {
          ...s,
          workSessions: s.workSessions.map(w => w.date === date
            ? { ...w, km: w.km + (a.w.km || 0), trips: w.trips + (a.w.trips || 0), hours: w.hours + (a.w.hours || 0) }
            : w),
          vehicle: s.vehicle && a.w.km ? { ...s.vehicle, odometer: s.vehicle.odometer + (a.w.km || 0) } : s.vehicle,
        }
      }
      return {
        ...s,
        workSessions: [{ id: uid(), date, km: a.w.km || 0, trips: a.w.trips || 0, hours: a.w.hours || 0 }, ...s.workSessions],
        vehicle: s.vehicle && a.w.km ? { ...s.vehicle, odometer: s.vehicle.odometer + (a.w.km || 0) } : s.vehicle,
      }
    }
    case 'addFuel': {
      const v = s.vehicle && a.f.odometer && a.f.odometer > (s.vehicle.odometer || 0)
        ? { ...s.vehicle, odometer: a.f.odometer } : s.vehicle
      return { ...s, fuelRecords: [a.f, ...s.fuelRecords], vehicle: v }
    }
    case 'setVehicle': return { ...s, vehicle: a.v }
    case 'addMaintenance': return { ...s, maintenance: [a.m, ...s.maintenance.filter(m => m.name !== a.m.name)] }
    case 'removeMaintenance': return { ...s, maintenance: s.maintenance.filter(m => m.id !== a.id) }
    case 'addGoal': return { ...s, goals: [a.g, ...s.goals] }
    case 'updateGoal': return { ...s, goals: s.goals.map(g => g.id === a.id ? { ...g, ...a.patch } : g) }
    case 'removeGoal': return { ...s, goals: s.goals.filter(g => g.id !== a.id) }
    case 'addDeficit': return { ...s, deficits: [a.d, ...s.deficits], dismissedDeficitDates: [...s.dismissedDeficitDates, a.d.date] }
    case 'dismissDeficit': return { ...s, dismissedDeficitDates: [...s.dismissedDeficitDates, a.date] }
    case 'payDeficits': {
      let left = a.amount
      const deficits = s.deficits.map(d => {
        if (d.ignored || d.remaining <= 0 || left <= 0) return d
        const pay = Math.min(d.remaining, left); left -= pay
        const remaining = d.remaining - pay
        return { ...d, remaining, perDay: d.daysLeft > 0 ? remaining / d.daysLeft : remaining }
      })
      return { ...s, deficits }
    }
    case 'addRecurring': return { ...s, recurring: [a.r, ...s.recurring] }
    case 'removeRecurring': return { ...s, recurring: s.recurring.filter(r => r.id !== a.id) }
    case 'addBudget': return { ...s, budgets: [a.b, ...s.budgets.filter(b => b.category !== a.b.category)] }
    case 'removeBudget': return { ...s, budgets: s.budgets.filter(b => b.id !== a.id) }
    case 'addCategory': return { ...s, categories: [...s.categories, a.c] }
    case 'archiveCategory':
      return { ...s, categories: s.categories.map(c => c.id === a.id ? { ...c, archived: a.archived } : c) }
    case 'updateRecurring':
      return { ...s, recurring: s.recurring.map(r => r.id === a.id ? { ...r, ...a.patch } : r) }
    case 'resolveOccurrence':
      // Chave única recurringId + date: reconfirmar a mesma ocorrência substitui
      // o registro em vez de criar um segundo.
      return {
        ...s,
        recurring: s.recurring.map(r => r.id !== a.recurringId ? r : {
          ...r,
          snoozeUntil: undefined,
          occurrences: [...(r.occurrences || []).filter(o => o.date !== a.occurrence.date), a.occurrence],
        }),
      }
    case 'mergeState': {
      // Importação "Mesclar": junta sem apagar, deduplicando por id (14.10).
      const byId = <T extends { id: string }>(cur: T[], inc?: T[]) => {
        if (!inc?.length) return cur
        const seen = new Set(cur.map(x => x.id))
        return [...cur, ...inc.filter(x => !seen.has(x.id))]
      }
      return {
        ...s,
        settings: { ...s.settings, ...(a.state.settings || {}) },
        transactions: byId(s.transactions, a.state.transactions),
        categories: byId(s.categories, a.state.categories),
        workSessions: byId(s.workSessions, a.state.workSessions),
        fuelRecords: byId(s.fuelRecords, a.state.fuelRecords),
        maintenance: byId(s.maintenance, a.state.maintenance),
        goals: byId(s.goals, a.state.goals),
        deficits: byId(s.deficits, a.state.deficits),
        recurring: byId(s.recurring, a.state.recurring),
        budgets: byId(s.budgets, a.state.budgets),
        vehicle: s.vehicle || a.state.vehicle || null,
        cards: byId(s.cards, a.state.cards),
        installmentPlans: byId(s.installmentPlans, a.state.installmentPlans),
        installments: byId(s.installments, a.state.installments),
        cardPayments: byId(s.cardPayments, a.state.cardPayments),
        cardCharges: byId(s.cardCharges, a.state.cardCharges),
      }
    }
    // ---------- cartões e parcelamentos ----------
    case 'addCard': return { ...s, cards: [...s.cards, a.card] }
    case 'updateCard': return { ...s, cards: s.cards.map(c => c.id === a.id ? { ...c, ...a.patch } : c) }
    case 'removeCard': {
      // O cartão some, mas os parcelamentos continuam existindo (viram "sem cartão")
      // para não apagar dívida real do usuário sem que ele peça.
      return {
        ...s,
        cards: s.cards.filter(c => c.id !== a.id),
        installmentPlans: s.installmentPlans.map(p => p.cardId === a.id ? { ...p, cardId: undefined } : p),
        cardCharges: s.cardCharges.filter(c => c.cardId !== a.id),
        cardPayments: s.cardPayments.filter(p => p.cardId !== a.id),
      }
    }
    case 'addPlan':
      return { ...s, installmentPlans: [a.plan, ...s.installmentPlans], installments: [...s.installments, ...a.installments] }
    case 'updatePlan':
      return { ...s, installmentPlans: s.installmentPlans.map(p => p.id === a.id ? { ...p, ...a.patch } : p) }
    case 'removePlan':
      return {
        ...s,
        installmentPlans: s.installmentPlans.filter(p => p.id !== a.id),
        installments: s.installments.filter(i => i.planId !== a.id),
      }
    case 'cancelFutureInstallments':
      return {
        ...s,
        installments: s.installments.map(i =>
          i.planId === a.planId && i.status === 'pending' ? { ...i, status: 'cancelled' as const } : i),
      }
    case 'payInstallment':
      return {
        ...s,
        installments: s.installments.map(i =>
          i.id === a.id ? { ...i, status: 'paid' as const, paidAt: a.paidAt, paidAmount: a.paidAmount ?? i.amount } : i),
      }
    case 'unpayInstallment':
      return {
        ...s,
        installments: s.installments.map(i =>
          i.id === a.id ? { ...i, status: 'pending' as const, paidAt: undefined, paidAmount: undefined } : i),
      }
    case 'updateInstallment':
      return { ...s, installments: s.installments.map(i => i.id === a.id ? { ...i, ...a.patch } : i) }
    case 'addCardPayment': {
      // Quitar a fatura marca as parcelas dela como pagas — a despesa já foi
      // contada como parcela, o pagamento NÃO cria despesa nova.
      const settle = new Set(a.settleInstallmentIds)
      return {
        ...s,
        cardPayments: [a.payment, ...s.cardPayments],
        installments: settle.size
          ? s.installments.map(i => settle.has(i.id) ? { ...i, status: 'paid' as const, paidAt: a.payment.paymentDate, paidAmount: i.amount } : i)
          : s.installments,
        // O saldo NÃO é alterado aqui: ele é derivado em currentBalance(), que já
        // desconta os pagamentos com `fromBalance`. Mexer nos dois lugares contaria duas vezes.
      }
    }
    case 'removeCardPayment': return { ...s, cardPayments: s.cardPayments.filter(p => p.id !== a.id) }
    case 'addCardCharge': return { ...s, cardCharges: [a.charge, ...s.cardCharges] }
    case 'updateCardCharge':
      return { ...s, cardCharges: s.cardCharges.map(c => c.id === a.id ? { ...c, ...a.patch } : c) }
    case 'removeCardCharge': return { ...s, cardCharges: s.cardCharges.filter(c => c.id !== a.id) }
    case 'chat': return { ...s, chat: [...s.chat, a.msg].slice(-200) }
    case 'chatResolve': return { ...s, chat: s.chat.map(m => m.id === a.id ? { ...m, pending: undefined, choices: undefined } : m) }
    case 'chatClear': return { ...s, chat: [] }
    case 'loadDemo': {
      const demo = buildDemoData()
      return { ...s, ...demo, settings: { ...s.settings, demo: true } } as AppState
    }
    case 'reset': return { ...initialState, settings: { ...defaultSettings, onboarded: false } }
    default: return s
  }
}

const StoreCtx = createContext<{ state: AppState; dispatch: React.Dispatch<Action> }>({ state: initialState, dispatch: () => {} })

/**
 * Handle da gravação debounced. Precisa ser visível fora do provider porque o
 * reset tem que CANCELAR a gravação pendente do estado antigo — senão ela roda
 * 150ms depois e ressuscita tudo que acabou de ser apagado.
 */
let pendingSave: any = null

/**
 * ÚNICA operação de apagar tudo do app (item 38). Usada pelo botão das
 * Configurações e pelo comando confirmado da IA — os dois caminhos precisam ser
 * exatamente o mesmo, senão um apaga e o outro não.
 *
 * Ordem importa:
 * 1. cancela a gravação pendente do estado ANTIGO;
 * 2. remove imediatamente SÓ a chave do AssistFin (nunca `localStorage.clear()`,
 *    que apagaria dados de outros apps do mesmo domínio);
 * 3. restaura o estado inicial completo, o que devolve o usuário ao onboarding.
 * Com a chave já removida, um reload em qualquer instante encontra o app limpo.
 */
export function resetAllData(dispatch: React.Dispatch<Action>) {
  if (pendingSave) { clearTimeout(pendingSave); pendingSave = null }
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage indisponível */ }
  dispatch({ type: 'reset' })
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        // confirmações e perguntas pendentes não sobrevivem entre sessões
        // (evita aplicar ações velhas em cima de um estado que já mudou)
        const chat = Array.isArray(parsed.chat)
          ? parsed.chat.map((m: ChatMessage) => (m.pending || m.choices ? { ...m, pending: undefined, choices: undefined } : m))
          : []
        return normalizeState({ ...parsed, chat })
      }
    } catch { /* estado corrompido → começa limpo */ }
    return init
  })

  useEffect(() => {
    clearTimeout(pendingSave)
    pendingSave = setTimeout(() => {
      pendingSave = null
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }, 150)
    return () => clearTimeout(pendingSave)
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export const useStore = () => useContext(StoreCtx)

// ---------- Helpers de alto nível ----------

const norm = (x: string) => (x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

/** Encontra um cartão pelo nome/instituição (aproximado). Sem nome: usa o único ativo. */
export function findCardByName(state: AppState, name?: string) {
  const active = (state.cards || []).filter(c => !c.archived)
  const n = norm(name || '')
  if (!n) return active.length === 1 ? active[0] : undefined
  return (
    active.find(c => norm(c.name) === n) ||
    active.find(c => norm(c.name).includes(n) || n.includes(norm(c.name))) ||
    active.find(c => norm(c.institution || '').includes(n))
  )
}

/**
 * Meta com nome EQUIVALENTE (ignora caixa, acento e espaços) — usada para o
 * aviso de duplicidade no onboarding, no GoalForm, no FAB e nas ações da IA.
 * Diferente de `findGoalByName`, que é aproximada e serve para "guardar dinheiro
 * na meta do iphone": esta aqui só casa quando o nome é realmente o mesmo.
 */
export function findGoalByExactName(state: AppState, name?: string, exceptId?: string) {
  if (!normalizeName(name)) return undefined
  return state.goals.find(g => g.id !== exceptId && sameName(g.name, name))
}

/** Encontra uma meta existente pelo nome (aproximado). Sem nome: usa a única ativa. */
export function findGoalByName(state: AppState, name?: string) {
  const active = state.goals.filter(g => !g.done)
  const n = norm(name || '')
  if (!n) return active.length === 1 ? active[0] : undefined
  return (
    active.find(g => norm(g.name) === n) ||
    active.find(g => norm(g.name).includes(n) || n.includes(norm(g.name))) ||
    active.find(g => n.split(/\s+/).some(w => w.length > 2 && norm(g.name).includes(w)))
  )
}

/** Aplica uma ação confirmada. Retorna false quando não foi possível (ex.: meta não encontrada). */
export function applyParsedAction(dispatch: React.Dispatch<Action>, state: AppState, a: ParsedAction, source: Transaction['source'] = 'ai'): boolean {
  const date = todayISO(); const time = nowTime()
  switch (a.kind) {
    case 'income':
      dispatch({ type: 'addTx', tx: { id: uid(), type: 'income', amount: a.amount, category: a.category || defaultIncomeCategory(state.settings), description: a.description, origin: a.origin, date, time, source, profileAtCreation: state.settings.profile } })
      // Taxa de saque da 99 — SOMENTE no perfil motorista. Em autônomo/CLT/outro
      // um is99 vindo da IA é ignorado (aluguel/salário nunca geram taxa).
      if (a.is99 && can99FeeApply(state.settings)) {
        dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: state.settings.platform99Fee, category: 'outros-out', description: 'Taxa de saque 99', date, time, source } })
      }
      break
    case 'expense':
      dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: a.amount, category: a.category || 'outros-out', description: a.description, origin: a.origin, date, time, source, profileAtCreation: state.settings.profile } })
      break
    case 'saving':
      // Transferência para reserva: não é despesa, só marca quanto foi guardado (14.3).
      dispatch({ type: 'addTx', tx: { id: uid(), type: 'saving', amount: a.amount, category: 'reserva', description: a.description || 'Guardado', date, time, source, profileAtCreation: state.settings.profile } })
      break
    case 'work':
      dispatch({ type: 'addWork', w: { date, km: a.km, trips: a.trips, hours: a.hours } })
      break
    case 'fuel': {
      const liters = a.liters || (a.amount && state.settings.fuelPricePerLiter ? a.amount / state.settings.fuelPricePerLiter : 0)
      const price = a.pricePerLiter || (a.amount && liters ? a.amount / liters : state.settings.fuelPricePerLiter)
      dispatch({ type: 'addFuel', f: { id: uid(), date, amount: a.amount || 0, liters: Math.round(liters * 100) / 100, pricePerLiter: Math.round(price * 100) / 100, odometer: a.odometer } })
      if (a.amount) dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: a.amount, category: 'combustivel', description: 'Abastecimento', date, time, source } })
      break
    }
    case 'maintenance': {
      const name = a.item.charAt(0).toUpperCase() + a.item.slice(1)
      dispatch({ type: 'addMaintenance', m: { id: uid(), name, cost: a.cost, kmInstalled: a.km ?? (state.vehicle?.odometer || 0), lifeKm: a.lifeKm || 10000, date } })
      dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: a.cost, category: 'manutencao', description: `Troca de ${a.item}`, date, time, source } })
      if (a.km && state.vehicle && a.km > state.vehicle.odometer) dispatch({ type: 'setVehicle', v: { ...state.vehicle, odometer: a.km } })
      break
    }
    case 'goal':
      // 'goal' significa SEMPRE criar meta nova. Alterar uma meta existente é
      // 'goal-update' — nenhuma meta pode ser modificada sem o usuário saber.
      // O aviso de duplicidade é mostrado no chat antes da confirmação.
      dispatch({ type: 'addGoal', g: { id: uid(), name: a.name, target: a.target, saved: 0, deadline: a.months ? addDays(date, Math.round(a.months * 30)) : undefined, createdAt: date } })
      break
    case 'goal-update': {
      const g = findGoalByName(state, a.name)
      if (!g) return false
      dispatch({
        type: 'updateGoal', id: g.id,
        patch: {
          ...(a.target ? { target: a.target, done: g.saved >= a.target } : {}),
          ...(a.months ? { deadline: addDays(date, Math.round(a.months * 30)) } : {}),
        },
      })
      break
    }
    case 'goal-deposit': {
      const g = findGoalByName(state, a.name)
      if (!g) return false
      const saved = g.saved + a.amount
      dispatch({ type: 'updateGoal', id: g.id, patch: { saved, done: saved >= g.target } })
      break
    }
    case 'balance':
      // Informar o saldo redefine a ÂNCORA a partir de agora: as movimentações
      // anteriores já estão embutidas no número que o usuário acabou de dizer.
      dispatch({ type: 'settings', patch: { balance: a.amount, balanceAsOf: nowStamp() } })
      break

    // ---------- Cartões e parcelamentos ----------
    // Nenhum destes cria Transaction de despesa: a compra vira dívida parcelada
    // e só as PARCELAS entram no fluxo mensal (ver services/cards.ts).
    case 'card-purchase': {
      const card = findCardByName(state, a.cardName)
      if (a.cardName && !card) return false // cartão citado não existe — não inventa
      const count = Math.max(Math.round(a.installments || 1), 1)
      const firstDue = a.firstDueDate || suggestedFirstDueDate(card, date)
      const plan: InstallmentPlan = {
        id: uid(),
        description: a.description || 'Compra no cartão',
        cardId: card?.id,
        categoryId: a.category || 'compras',
        totalAmount: a.total,
        installmentCount: count,
        firstDueDate: firstDue,
        purchaseDate: date,
        status: 'active',
        operationType: card ? 'card-purchase' : 'standalone',
        profileAtCreation: state.settings.profile,
        createdAt: date,
      }
      dispatch({ type: 'addPlan', plan, installments: buildInstallments(plan, uid) })
      break
    }
    case 'financed-cash-inflow': {
      const card = findCardByName(state, a.cardName)
      if (a.cardName && !card) return false
      const count = Math.max(Math.round(a.installments || 1), 1)
      const plan: InstallmentPlan = {
        id: uid(),
        description: 'Entrada financiada pelo cartão',
        cardId: card?.id,
        categoryId: 'outros-out',
        totalAmount: a.total,
        installmentCount: count,
        firstDueDate: suggestedFirstDueDate(card, date),
        purchaseDate: date,
        feeAmount: Math.max(a.total - a.netReceived, 0),
        source: a.source,
        status: 'active',
        operationType: 'financed-cash-inflow',
        netReceived: a.netReceived,
        profileAtCreation: state.settings.profile,
        createdAt: date,
      }
      dispatch({ type: 'addPlan', plan, installments: buildInstallments(plan, uid) })
      // O dinheiro recebido entra no caixa, mas NUNCA como receita/lucro:
      // type próprio, fora de todos os somatórios de income.
      dispatch({
        type: 'addTx',
        tx: {
          id: uid(), type: 'financed-cash-inflow', amount: a.netReceived, category: 'outros-in',
          description: 'Entrada financiada pelo cartão', date, time, source,
          profileAtCreation: state.settings.profile,
        },
      })
      // O saldo sobe sozinho: a Transaction 'financed-cash-inflow' acima já é
      // contada por currentBalance(). Somar aqui também dobraria o valor.
      break
    }
    case 'card-payment': {
      const card = findCardByName(state, a.cardName)
      if (!card) return false
      const mk = monthKey(date)
      const invoice = cardInvoice(state, card, mk)
      const amount = a.amount ?? invoice.pending
      if (!(amount > 0)) return false
      const fullyPaid = amount >= invoice.pending - 0.009
      dispatch({
        type: 'addCardPayment',
        payment: { id: uid(), cardId: card.id, amount, paymentDate: date, referenceMonth: mk, fromBalance: true },
        // só quita as parcelas quando a fatura foi paga por inteiro
        settleInstallmentIds: fullyPaid
          ? invoice.items.filter(i => i.kind === 'installment' && i.planId)
              .map(i => (state.installments || []).find(x => x.planId === i.planId && x.number === i.installmentNumber)?.id)
              .filter((x): x is string => !!x)
          : [],
      })
      break
    }
    case 'card-charge': {
      const card = findCardByName(state, a.cardName)
      if (!card) return false
      dispatch({
        type: 'addCardCharge',
        charge: {
          id: uid(), cardId: card.id, description: a.description || 'Assinatura',
          amount: a.amount, categoryId: a.category || 'assinaturas',
          frequency: 'monthly', nextDate: date, active: true, createdAt: date,
        },
      })
      break
    }

    case 'reset':
      // Mesmo caminho do botão das Configurações — ver resetAllData().
      resetAllData(dispatch)
      break
  }
  return true
}
