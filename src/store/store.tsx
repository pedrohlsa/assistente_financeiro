// Estado global + persistência local (localStorage) — funciona offline.
// Preparado para sincronização futura: cada mutação passa por dispatch,
// bastando acoplar uma fila de sync (INTEGRAÇÃO PENDENTE: backend/Supabase).
import React, { createContext, useContext, useLayoutEffect, useMemo, useReducer, useState } from 'react'
import { createDeferredSave } from './persistence'
import {
  AppState, Transaction, WorkSession, FuelRecord, MaintenanceItem, FinancialGoal,
  Deficit, RecurringExpense, RecurrenceOccurrence, Budget, ChatMessage, ProposedAction, Settings, Vehicle, ParsedAction, Category,
  CreditCard, InstallmentPlan, Installment, CardPayment, RecurringCardCharge,
  AssistantJournalEntry, AssistantPreference,
} from '../models/types'
import { DEFAULT_CATEGORIES, mergeDefaultCategories } from '../data/categories'
import { buildDemoData } from '../data/demo'
import { addDays, monthKey, nowPaymentTime, nowStamp, nowTime, todayISO, uid } from '../utils/format'
import { normalizeName, sameName } from '../utils/text'
import { defaultIncomeCategory } from '../services/profile'
import { nextCashEventTime } from '../services/calc'
import { cardInvoice, currentInvoice, directInstallmentPaidAmount, futureInvoicePaymentDate,
  installmentLinkedToCardPayment, validPaymentDate } from '../services/cards'
import { applyBatchPure } from '../assistant/execute'
import type { BatchItem } from '../assistant/execute'
import type { ActionExecutionResult } from '../assistant/contracts'
import { isSafePreference, mergePreferenceLists } from '../assistant/preferences'

const STORAGE_KEY = 'assistfin-state-v1'

const defaultSettings: Settings = {
  name: '', currency: 'BRL', theme: 'light', profile: 'driver', priority: '',
  onboarded: false, demo: false,
  monthlyProfitTarget: 4500, safetyMarginPct: 10,
  workDays: [1, 2, 3, 4, 5, 6],
  homeCards: ['km', 'trips', 'netkm', 'perhour'],
  fuelPricePerLiter: 0, kmPerLiter: 0, minPerKm: 0, comfortPerKm: 0,
  fixedMonthlyCosts: 0, notifications: true,
  balance: 0, ask99Fee: true, platform99Fee: 1, remoteAi: true,
}

const initialState: AppState = {
  settings: defaultSettings,
  transactions: [], categories: DEFAULT_CATEGORIES,
  workSessions: [], fuelRecords: [], vehicle: null, maintenance: [],
  goals: [], deficits: [], recurring: [], budgets: [], chat: [],
  dismissedDeficitDates: [],
  cards: [], installmentPlans: [], installments: [], cardPayments: [], cardCharges: [],
  assistantPreferences: [],
}

/** Mantém a primeira ocorrência de cada ID na ordem em que veio do disco. */
function savedObjects<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const id = item.id
    // Estados antigos podem ter objetos sem ID. Só deduplicar quando a
    // identidade é conhecida evita apagar linhas legadas por engano.
    if (typeof id !== 'string' || !id.trim()) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Garante que todo array esperado existe, mesmo em estados salvos antes de uma
 * funcionalidade existir. Vale tanto para o localStorage quanto para um backup
 * antigo restaurado — sem isso, `state.cards.map(...)` quebraria o app inteiro.
 */
function normalizeState(raw: any): AppState {
  // Não basta "é array": um backup editado à mão, truncado ou vindo de outra
  // ferramenta pode trazer `null` no meio da lista, e daí em diante qualquer
  // `t.type` do app quebra a tela inteira em branco. O item que não é objeto é
  // descartado aqui, na fronteira — depois deste ponto o resto do código pode
  // confiar no que recebe. `dismissedDeficitDates` é lista de strings e usa o
  // filtro solto.
  const arr = <T,>(v: any, fallback: T[] = []): T[] =>
    (Array.isArray(v) ? v.filter(x => x !== null && x !== undefined) : fallback)
  return {
    ...initialState,
    ...raw,
    settings: { ...defaultSettings, ...(raw?.settings || {}) },
    transactions: savedObjects(raw?.transactions),
    // Fusão, não substituição: quem já usava o app recebe as categorias padrão
    // novas sem perder as personalizadas nem o estado "arquivada".
    categories: mergeDefaultCategories(raw?.categories),
    workSessions: savedObjects(raw?.workSessions),
    fuelRecords: savedObjects(raw?.fuelRecords),
    maintenance: savedObjects(raw?.maintenance),
    goals: savedObjects(raw?.goals),
    deficits: savedObjects(raw?.deficits),
    recurring: savedObjects(raw?.recurring),
    budgets: savedObjects(raw?.budgets),
    chat: savedObjects(raw?.chat),
    dismissedDeficitDates: arr(raw?.dismissedDeficitDates),
    // Backup anterior a esta versão não tem journal: o array nasce vazio e os
    // lotes antigos ficam sem entrada — o undo recusa em vez de adivinhar.
    assistantJournal: savedObjects(raw?.assistantJournal),
    assistantPreferences: mergePreferenceLists([], raw?.assistantPreferences),
    vehicle: raw?.vehicle ?? null,
    cards: savedObjects(raw?.cards),
    installmentPlans: savedObjects(raw?.installmentPlans),
    installments: savedObjects(raw?.installments),
    cardPayments: savedObjects(raw?.cardPayments),
    cardCharges: savedObjects(raw?.cardCharges),
  }
}

/**
 * Reidrata o estado salvo, APAGANDO toda proposta/pergunta pendente.
 *
 * Uma proposta é uma intenção da sessão anterior, calculada sobre um estado que
 * já mudou. Se ela sobreviver ao reload, o usuário reencontra um botão
 * "Confirmar" órfão — foi exatamente o que aconteceu no QA: a despesa de R$
 * 120,00 continuava clicável depois de recarregar. As mensagens antigas
 * continuam visíveis; só o que é acionável some.
 *
 * Exportada para o teste conseguir provar isso sem abrir o navegador.
 */
export function hydrateForTest(parsed: any): AppState {
  const state = normalizeState(parsed)
  const chat = state.chat.map(m =>
    (m.pending || m.choices || m.proposal || m.clarification || m.preferenceProposal)
      ? { ...m, pending: undefined, choices: undefined, proposal: undefined, clarification: undefined, preferenceProposal: undefined }
      : m)
  return { ...state, chat }
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
  | { type: 'assistantPreferenceUpsert'; preference: AssistantPreference }
  | { type: 'assistantPreferenceRemove'; id: string }
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
  | { type: 'payInstallment'; id: string; paidAt: string; paidTime?: string; paidAmount?: number }
  | { type: 'partialPayInstallment'; id: string; amount: number; paidAt: string; paidTime?: string }
  | { type: 'unpayInstallment'; id: string }
  | { type: 'updateInstallment'; id: string; patch: Partial<Installment> }
  | { type: 'addCardPayment'; payment: CardPayment; settleInstallmentIds: string[] }
  | { type: 'removeCardPayment'; id: string }
  | { type: 'addCardCharge'; charge: RecurringCardCharge }
  | { type: 'updateCardCharge'; id: string; patch: Partial<RecurringCardCharge> }
  | { type: 'removeCardCharge'; id: string }
  /**
   * Lote confirmado do assistente. É UMA action só de propósito: aplicar as
   * ações em dispatches separados devolveria o mesmo estado antigo para todas.
   */
  | { type: 'assistantBatch'; items: BatchItem[]; source: Transaction['source']; batchId: string;
      engine?: AssistantJournalEntry['engine']; messageId?: string; stamp?: string }
  | { type: 'chat'; msg: ChatMessage }
  | { type: 'chatUpdateProposal'; id: string; proposal: ProposedAction[] }
  | { type: 'chatClearClarification'; id: string }
  | { type: 'chatResolve'; id: string }
  | { type: 'chatClear' }
  | { type: 'clearActivity' }
  | { type: 'loadDemo' }
  | { type: 'reset' }

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    // Backup antigo (sem cartões/parcelas) precisa ser normalizado, senão o app quebra.
    case 'hydrate': return hydrateForTest(a.state)
    case 'settings': {
      const stamp = a.patch.balanceAsOf
      const balanceAsOf = stamp?.includes('T')
        ? `${stamp.slice(0, 11)}${nextCashEventTime(s, stamp.slice(0, 10), stamp.slice(11))}`
        : stamp
      return { ...s, settings: { ...s.settings, ...a.patch,
        ...(stamp ? { balanceAsOf } : {}) } }
    }
    case 'assistantPreferenceUpsert': {
      if (!isSafePreference(a.preference)) return s
      return { ...s, assistantPreferences: mergePreferenceLists(s.assistantPreferences || [], [a.preference]) }
    }
    case 'assistantPreferenceRemove': return { ...s, assistantPreferences: (s.assistantPreferences || []).filter(p => p.id !== a.id) }
    case 'addTx': return { ...s, transactions: [{ ...a.tx,
      time: a.tx.time ? nextCashEventTime(s, a.tx.date, a.tx.time) : a.tx.time }, ...s.transactions] }
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
        }
      }
      return {
        ...s,
        workSessions: [{ id: uid(), date, km: a.w.km || 0, trips: a.w.trips || 0, hours: a.w.hours || 0 }, ...s.workSessions],
      }
    }
    case 'addFuel': {
      const v = a.f.odometer && a.f.odometer > (s.vehicle?.odometer || 0)
        ? { ...(s.vehicle || { brand: '', model: 'Meu veículo', odometer: 0 }), odometer: a.f.odometer }
        : s.vehicle
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
        const seen = new Set(cur.map(x => x.id))
        const added = savedObjects<T>(inc).filter(x => typeof x.id === 'string' && x.id.trim() && !seen.has(x.id))
        return added.length ? [...cur, ...added] : cur
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
        assistantPreferences: mergePreferenceLists(s.assistantPreferences || [], a.state.assistantPreferences),
        // O journal do backup NÃO é mesclado de propósito: as operações dele
        // descrevem um estado que não é este. Desfazer um lote apoiado em
        // retratos de outra base seria exatamente o chute que o journal existe
        // para impedir. Fica só o desta base.
        assistantJournal: s.assistantJournal || [],
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
    case 'payInstallment': {
      if (!validPaymentDate(a.paidAt)) return s
      const paidTime = nextCashEventTime(s, a.paidAt, a.paidTime || nowPaymentTime())
      return {
        ...s,
        installments: s.installments.map(i => {
          if (i.id !== a.id || i.status === 'cancelled' || i.paidVia === 'invoice') return i
          // Backups podem marcar "paid" com paidAmount menor que a parcela.
          // Completar o restante é permitido só sem quitação de fatura ligada.
          if (i.status === 'paid' && ((i.paidAmount ?? i.amount) >= i.amount - 0.009
            || installmentLinkedToCardPayment(s, i))) return i
          const previous = Math.min(Math.max(i.paidAmount || 0, 0), i.amount)
          const remainder = Math.max((a.paidAmount ?? i.amount) - previous, 0)
          const history = i.directPayments?.length ? i.directPayments
            : i.paidAt && previous > 0
              ? [{ amount: previous, date: i.paidAt }] : []
          return { ...i, status: 'paid' as const, paidAt: a.paidAt,
            paidAmount: a.paidAmount ?? i.amount, paidVia: 'direct' as const,
            directPayments: remainder > 0 ? [...history,
              { amount: remainder, date: a.paidAt, time: paidTime }] : history }
        }),
      }
    }
    case 'partialPayInstallment': {
      if (!validPaymentDate(a.paidAt)) return s
      const paidTime = nextCashEventTime(s, a.paidAt, a.paidTime || nowPaymentTime())
      return { ...s, installments: s.installments.map(i => {
        if (i.id !== a.id || i.status !== 'pending' || !(a.amount > 0)) return i
        const paid = Math.min(i.amount, (i.paidAmount || 0) + a.amount)
        if (paid >= i.amount - 0.009) return i
        const history = i.directPayments?.length ? i.directPayments
          : i.paidAt && (i.paidAmount || 0) > 0 && i.paidVia !== 'invoice'
            ? [{ amount: i.paidAmount!, date: i.paidAt }] : []
        return { ...i, paidAmount: paid, paidAt: a.paidAt, paidVia: 'direct' as const,
          directPayments: [...history,
            { amount: a.amount, date: a.paidAt, time: paidTime }] }
      }) }
    }
    case 'unpayInstallment': {
      // Uma fatura paga é um registro separado. Reabrir apenas a parcela
      // removeria o crédito direto mas deixaria o pagamento da fatura intacto.
      const installment = s.installments.find(i => i.id === a.id)
      if (installment && installmentLinkedToCardPayment(s, installment)) return s
      return {
        ...s,
        installments: s.installments.map(i =>
          i.id === a.id ? { ...i, status: 'pending' as const, paidAt: undefined, paidAmount: undefined,
            paidVia: undefined, directPayments: undefined } : i),
      }
    }
    case 'updateInstallment':
      return { ...s, installments: s.installments.map(i => i.id === a.id ? { ...i, ...a.patch } : i) }
    case 'addCardPayment': {
      if (!validPaymentDate(a.payment.paymentDate)) return s
      const card = s.cards.find(c => c.id === a.payment.cardId)
      if (card && futureInvoicePaymentDate(s, card, a.payment.referenceMonth)) return s
      // Quitar a fatura marca as parcelas dela como pagas — a despesa já foi
      // contada como parcela, o pagamento NÃO cria despesa nova.
      const settle = new Set(a.settleInstallmentIds.filter(id => {
        const installment = s.installments.find(i => i.id === id)
        return !!installment && directInstallmentPaidAmount(s, installment) < installment.amount - 0.009
      }))
      return {
        ...s,
        cardPayments: [{ ...a.payment,
          paymentTime: a.payment.paymentTime
            ? nextCashEventTime(s, a.payment.paymentDate, a.payment.paymentTime)
            : undefined,
          settledInstallmentIds: [...settle] }, ...s.cardPayments],
        installments: settle.size
          ? s.installments.map(i => settle.has(i.id)
            ? directInstallmentPaidAmount(s, i) > 0
              ? { ...i, status: 'paid' as const, paidVia: 'direct' as const }
              : { ...i, status: 'paid' as const,
                paidAt: a.payment.paymentDate, paidAmount: i.amount, paidVia: 'invoice' as const }
            : i)
          : s.installments,
        // O saldo NÃO é alterado aqui: ele é derivado em currentBalance(), que já
        // desconta os pagamentos com `fromBalance`. Mexer nos dois lugares contaria duas vezes.
      }
    }
    case 'removeCardPayment': {
      const payment = s.cardPayments.find(p => p.id === a.id)
      if (!payment) return s
      // Sem os IDs quitados não é possível reabrir a parcela certa. Não
      // removemos só o dinheiro e deixamos a dívida falsamente como paga.
      if (payment.settledInstallmentIds === undefined) return s
      const cardPayments = s.cardPayments.filter(p => p.id !== a.id)
      const card = s.cards.find(c => c.id === payment.cardId)
      // Um parcial antigo pode ter permitido que a fatura posterior quitasse
      // parcelas sem registrar qual parte daquele parcial cabia a cada uma.
      // Removê-lo deixaria parcelas "paid" com saldo pendente. Sem proveniência
      // para redistribuir o restante, exigir reconciliação em vez de inventar.
      if (card && cardPayments.some(p => p.cardId === payment.cardId
        && p.referenceMonth === payment.referenceMonth && p.settledInstallmentIds?.length)
        && cardInvoice({ ...s, cardPayments }, card, payment.referenceMonth).pending > 0.009) return s
      const reopened = new Set<string>()
      const installments = s.installments.map(i => {
        if (!payment.settledInstallmentIds!.includes(i.id)
          || cardPayments.some(p => p.settledInstallmentIds?.includes(i.id))) return i
        const direct = directInstallmentPaidAmount(s, i)
        if (direct >= i.amount - 0.009) return i
        reopened.add(i.planId)
        if (direct > 0) return { ...i, status: 'pending' as const, paidVia: 'direct' as const }
        return { ...i, status: 'pending' as const, paidAt: undefined,
          paidAmount: undefined, paidVia: undefined, directPayments: undefined }
      })
      return { ...s, cardPayments, installments,
        installmentPlans: reopened.size ? s.installmentPlans.map(p => reopened.has(p.id) && p.status === 'settled'
          ? { ...p, status: 'active' as const } : p) : s.installmentPlans }
    }
    case 'addCardCharge': return { ...s, cardCharges: [a.charge, ...s.cardCharges] }
    case 'updateCardCharge':
      return { ...s, cardCharges: s.cardCharges.map(c => c.id === a.id ? { ...c, ...a.patch } : c) }
    case 'removeCardCharge': {
      const removedAt = todayISO()
      const charge = s.cardCharges.find(c => c.id === a.id)
      const card = charge ? s.cards.find(c => c.id === charge.cardId) : undefined
      // A cobrança feita antes do fechamento pertence à fatura cujo vencimento
      // pode cair no mês seguinte. Encerrar no dia da remoção apagaria justamente
      // essa fatura corrente; por isso preservamos até o vencimento calculado dela.
      const archiveThrough = card ? currentInvoice(s, card).dueDate : removedAt
      return {
        ...s,
        // Remoção lógica: a recorrência para hoje, some da lista ativa e continua
        // disponível para reconstruir faturas anteriores. O campo opcional mantém
        // compatibilidade com backups que já existiam.
        cardCharges: s.cardCharges.map(c => c.id === a.id
          ? {
              ...c,
              active: true,
              endDate: c.endDate && c.endDate < archiveThrough ? c.endDate : archiveThrough,
              removedAt,
            }
          : c),
      }
    }
    case 'assistantBatch': {
      // Atômico: `applyBatchPure` devolve o estado original quando qualquer
      // ação falha, então nunca sobra meio lote gravado.
      const out = applyBatchPure(s, a.items, {
        source: a.source, batchId: a.batchId, engine: a.engine, messageId: a.messageId, stamp: a.stamp,
      })
      return out.applied ? out.state : s
    }
    case 'chat': return { ...s, chat: [...s.chat, a.msg].slice(-200) }
    case 'chatUpdateProposal':
      return { ...s, chat: s.chat.map(m => (m.id === a.id ? { ...m, proposal: a.proposal } : m)) }
    case 'chatClearClarification':
      return { ...s, chat: s.chat.map(m => (m.id === a.id ? { ...m, clarification: undefined } : m)) }
    case 'chatResolve':
      return { ...s, chat: s.chat.map(m => m.id === a.id ? { ...m, pending: undefined, choices: undefined, proposal: undefined, clarification: undefined, preferenceProposal: undefined } : m) }
    case 'chatClear': return { ...s, chat: [] }
    case 'clearActivity':
      return {
        ...s,
        transactions: [],
        workSessions: [],
        fuelRecords: [],
        maintenance: [],
        deficits: [],
        chat: [],
        dismissedDeficitDates: [],
      }
    case 'loadDemo': {
      const demo = buildDemoData()
      return { ...s, ...demo, settings: { ...s.settings, demo: true } } as AppState
    }
    case 'reset': return { ...initialState, settings: { ...defaultSettings, onboarded: false } }
    default: return s
  }
}

interface StoreValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  /**
   * Mensagem de falha ao GRAVAR no aparelho, ou `null`. Existe para que a tela
   * possa avisar: um app offline-first que para de salvar em silencio faz o
   * usuario registrar o dia inteiro achando que esta guardado.
   */
  storageError: string | null
}

const StoreCtx = createContext<StoreValue>({ state: initialState, dispatch: () => {}, storageError: null })

/**
 * Controle da gravação debounced. Precisa ser visível fora do provider porque o
 * reset tem que CANCELAR a gravação pendente do estado antigo — senão ela roda
 * 150ms depois e ressuscita tudo que acabou de ser apagado.
 */
let activeSave: ReturnType<typeof createDeferredSave<AppState>> | null = null

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
  activeSave?.cancel()
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage indisponível */ }
  dispatch({ type: 'reset' })
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return hydrateForTest(JSON.parse(raw))
    } catch { /* estado corrompido → começa limpo */ }
    return init
  })

  /**
   * Falha ao GRAVAR. O `getItem` sempre teve `try`; o `setItem` não tinha, e
   * ele roda dentro de um `setTimeout` — a exceção não passa por nenhum limite
   * de erro do React. Quando o armazenamento enche (cota do WebView), está
   * bloqueado (navegação privada, política do aparelho) ou o disco acabou, o
   * app continuava respondendo normalmente enquanto NADA era salvo. Num app
   * offline-first de dinheiro esse é o pior desfecho possível: o usuário
   * registra o dia inteiro achando que está guardado.
   */
  const [storageError, setStorageError] = useState<string | null>(null)

  const save = useMemo(() => createDeferredSave<AppState>((snapshot) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
      setStorageError(prev => (prev ? null : prev))
    } catch (e: any) {
      const cheio = e?.name === 'QuotaExceededError' || e?.code === 22 || e?.code === 1014
      setStorageError(cheio
        ? 'O armazenamento do aparelho está cheio: os últimos registros NÃO foram salvos. Exporte um backup e apague o que não precisar mais.'
        : 'Não estou conseguindo salvar neste aparelho: os últimos registros podem se perder ao fechar o app. Exporte um backup por segurança.')
    }
  }), [])

  // O snapshot já está atualizado antes de o browser poder recarregar. O
  // debounce permanece durante o uso, mas sair/ocultar a página descarrega a
  // gravação imediatamente; reset cancela a fila antes de remover a chave.
  useLayoutEffect(() => { save.queue(state) }, [state, save])
  useLayoutEffect(() => {
    activeSave = save
    const onHidden = () => { if (document.visibilityState === 'hidden') save.flush() }
    window.addEventListener('pagehide', save.flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', save.flush)
      document.removeEventListener('visibilitychange', onHidden)
      save.flush()
      if (activeSave === save) activeSave = null
    }
  }, [save])

  const value = useMemo(() => ({ state, dispatch, storageError }), [state, storageError])
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>
}

export const useStore = () => useContext(StoreCtx)

// ---------- Helpers de alto nível ----------

// Os resolvedores de referência e a aplicação das ações vivem em
// `src/assistant/execute.ts`, em forma PURA. O store apenas os expõe para quem
// já os importava daqui — nenhuma tela precisou mudar de import.
export { findCardByName, findGoalByName, findGoalByExactName } from '../assistant/execute'

/**
 * Aplica um LOTE de ações confirmadas do assistente, de forma atômica.
 *
 * Substitui o antigo `applyParsedAction` chamado em `forEach`: aquele passava o
 * MESMO estado para todas as ações (o React só reprocessa depois), então dois
 * depósitos na mesma meta se sobrescreviam e uma falha no meio deixava o lote
 * pela metade. Aqui o reducer aplica tudo em sequência, sobre o estado que a
 * ação anterior produziu, e só grava se o lote inteiro passar.
 *
 * Devolve o resultado POR AÇÃO — a interface consegue dizer exatamente o que
 * falhou e por quê, em vez de uma mensagem genérica para tudo.
 */
export function applyAssistantBatch(
  dispatch: React.Dispatch<Action>,
  state: AppState,
  items: BatchItem[],
  source: Transaction['source'] = 'ai',
  /** Auditoria: motor que produziu o lote e ID (nunca o texto) da mensagem. */
  meta: { engine?: AssistantJournalEntry['engine']; messageId?: string } = {},
): { results: ActionExecutionResult[]; applied: boolean; batchId: string } {
  const batchId = uid()
  const stamp = nowStamp()
  // Simulação antes de despachar: o resultado por ação vem daqui, e o reducer
  // repete exatamente o mesmo cálculo de forma determinística.
  const dry = applyBatchPure(state, items, { source, batchId, stamp, ...meta })
  if (dry.applied) dispatch({ type: 'assistantBatch', items, source, batchId, stamp, ...meta })
  return { results: dry.results, applied: dry.applied, batchId }
}

/**
 * Compatibilidade: aplica UMA ação. Mantida porque o reset tem caminho próprio
 * e alguns fluxos antigos ainda registram uma coisa de cada vez.
 */
export function applyParsedAction(
  dispatch: React.Dispatch<Action>,
  state: AppState,
  a: ParsedAction,
  source: Transaction['source'] = 'ai',
): boolean {
  if (a.kind === 'reset') {
    // Mesmo caminho do botão das Configurações — destrutivo, nunca em lote.
    resetAllData(dispatch)
    return true
  }
  return applyAssistantBatch(dispatch, state, [{ id: uid(), action: a }], source).applied
}
