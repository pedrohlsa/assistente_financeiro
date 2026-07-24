// Estado global + persistência local (localStorage) — funciona offline.
// Preparado para sincronização futura: cada mutação passa por dispatch,
// bastando acoplar uma fila de sync (INTEGRAÇÃO PENDENTE: backend/Supabase).
import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react'
import {
  AppState, Transaction, WorkSession, FuelRecord, MaintenanceItem, FinancialGoal,
  Deficit, RecurringExpense, Budget, ChatMessage, Settings, Vehicle, ParsedAction, Category,
} from '../models/types'
import { DEFAULT_CATEGORIES } from '../data/categories'
import { buildDemoData } from '../data/demo'
import { addDays, nowTime, todayISO, uid } from '../utils/format'
import { can99FeeApply, defaultIncomeCategory } from '../services/profile'

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
  | { type: 'mergeState'; state: Partial<AppState> }
  | { type: 'chat'; msg: ChatMessage }
  | { type: 'chatResolve'; id: string }
  | { type: 'chatClear' }
  | { type: 'loadDemo' }
  | { type: 'reset' }

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'hydrate': return a.state
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
      }
    }
    case 'chat': return { ...s, chat: [...s.chat, a.msg].slice(-200) }
    case 'chatResolve': return { ...s, chat: s.chat.map(m => m.id === a.id ? { ...m, pending: undefined } : m) }
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

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        // confirmações pendentes não sobrevivem entre sessões (evita aplicar ações velhas)
        const chat = Array.isArray(parsed.chat) ? parsed.chat.map((m: ChatMessage) => (m.pending ? { ...m, pending: undefined } : m)) : []
        return { ...init, ...parsed, chat, settings: { ...defaultSettings, ...parsed.settings }, categories: parsed.categories?.length ? parsed.categories : DEFAULT_CATEGORIES }
      }
    } catch { /* estado corrompido → começa limpo */ }
    return init
  })

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)), 150)
    return () => clearTimeout(t)
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export const useStore = () => useContext(StoreCtx)

// ---------- Helpers de alto nível ----------

const norm = (x: string) => (x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

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
    case 'goal': {
      // se já existe meta com nome parecido, atualiza em vez de duplicar
      const existing = a.name ? findGoalByName(state, a.name) : undefined
      if (existing) {
        dispatch({ type: 'updateGoal', id: existing.id, patch: { target: a.target, deadline: a.months ? addDays(date, Math.round(a.months * 30)) : existing.deadline } })
      } else {
        dispatch({ type: 'addGoal', g: { id: uid(), name: a.name, target: a.target, saved: 0, deadline: a.months ? addDays(date, Math.round(a.months * 30)) : undefined, createdAt: date } })
      }
      break
    }
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
      dispatch({ type: 'settings', patch: { balance: a.amount } })
      break
    case 'reset':
      dispatch({ type: 'reset' })
      break
  }
  return true
}
