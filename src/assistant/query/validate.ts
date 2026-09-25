// VALIDAÇÃO DO PLANO DE CONSULTA — o `validateAction` das perguntas.
//
// Um plano pode vir de duas fontes: do planner local (`query/parse.ts`) ou da IA
// remota. As duas passam por aqui, pelo mesmo motivo de sempre: o cliente valida
// com as capacidades REAIS do aparelho, e o que o modelo devolveu é dado não
// confiável até provar o contrário.
//
// Recusa SEMPRE devolve código. Descartar em silêncio é proibido — foi assim que
// o `sanitizeActions` antigo comia ação sem ninguém saber.

import type { AppState, TxType } from '../../models/types'
import { usableCategories } from '../../data/categories'
import { isDriver } from '../../services/profile'
import { normalizeName } from '../../utils/text'
import { semNulosOpcionais } from '../contracts'
import {
  DRIVER_ONLY_SOURCES, FIELDS_BY_SOURCE, QUERY_DSL_VERSION, QUERY_GROUPS,
  QUERY_METRICS, QUERY_ORDERS, QUERY_SOURCES,
} from './types'
import type {
  AssistantQueryPlan, QueryFilter, QueryGroup, QueryMetric, QueryOrder,
  QueryPeriod, QuerySource, QueryField,
} from './types'

export type QueryErrorCode =
  | 'bad-version' | 'not-object' | 'unknown-source' | 'unknown-field'
  | 'field-not-in-source' | 'unknown-metric' | 'unknown-group' | 'unknown-order'
  | 'bad-period' | 'period-too-long' | 'bad-filter' | 'category-not-found'
  | 'card-not-found' | 'goal-not-found' | 'profile-forbidden' | 'metric-not-applicable'
  | 'dangerous-key'

export const QUERY_ERROR_MESSAGES: Record<QueryErrorCode, string> = {
  'bad-version': 'Não reconheço o formato dessa consulta.',
  'not-object': 'A consulta não veio no formato esperado.',
  'unknown-source': 'Não sei consultar esse tipo de dado.',
  'unknown-field': 'Não reconheço esse número.',
  'field-not-in-source': 'Esse número não existe nesse tipo de dado.',
  'unknown-metric': 'Não sei calcular isso.',
  'unknown-group': 'Não sei agrupar por isso.',
  'unknown-order': 'Não sei ordenar assim.',
  'bad-period': 'Não consegui entender o período.',
  'period-too-long': 'Esse período é longo demais para eu responder de uma vez.',
  'bad-filter': 'Um dos filtros não é válido.',
  'category-not-found': 'Essa categoria não existe no seu app.',
  'card-not-found': 'Não encontrei esse cartão.',
  'goal-not-found': 'Não encontrei essa meta.',
  'profile-forbidden': 'Esse tipo de dado não existe no seu perfil.',
  'metric-not-applicable': 'Essa conta não faz sentido para esse tipo de dado.',
  'dangerous-key': 'A consulta trouxe um campo que eu não aceito.',
}

export type QueryValidation =
  | { ok: true; plan: AssistantQueryPlan }
  | { ok: false; code: QueryErrorCode; detail?: string }

/** Predicado explícito — obrigatório sob `strict: false` (CLAUDE.md, regra 24). */
export function isQueryFailure(v: QueryValidation): v is { ok: false; code: QueryErrorCode; detail?: string } {
  return v.ok === false
}

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------

/** Nenhuma consulta olha mais que isto. Dez anos já é "a vida inteira" do app. */
export const MAX_PERIOD_DAYS = 3660
/** Grupos devolvidos. Uma lista de 200 categorias não é resposta, é despejo. */
export const MAX_GROUPS = 24
export const DEFAULT_GROUP_LIMIT = 8

const ISO = /^\d{4}-\d{2}-\d{2}$/

/**
 * Chaves que nunca podem chegar a um objeto construído a partir de dado externo.
 * Um plano vindo do modelo é JSON: `{"__proto__": {...}}` num `Object.assign`
 * ou num spread de bibliotecas antigas envenena o protótipo do processo inteiro.
 * Aqui a construção é campo a campo (nada de spread do bruto), mas a checagem
 * fica como barreira explícita — e como teste.
 */
const PERIGOSAS = new Set(['__proto__', 'constructor', 'prototype'])

const temChavePerigosa = (o: any, depth = 0): boolean => {
  if (!o || typeof o !== 'object' || depth > 4) return false
  if (Object.prototype.hasOwnProperty.call(o, '__proto__')) return true
  for (const k of Object.keys(o)) {
    if (PERIGOSAS.has(k)) return true
    if (temChavePerigosa(o[k], depth + 1)) return true
  }
  return false
}

const TX_TYPES: TxType[] = ['income', 'expense', 'saving', 'financed-cash-inflow']
const STATUSES = ['pending', 'paid', 'cancelled', 'active', 'settled', 'done', 'open']

const strOf = (v: any, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

const numOf = (v: any): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const daysBetweenIso = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86400000)

function validatePeriod(raw: any, todayIso: string): QueryPeriod | QueryErrorCode {
  if (!raw || typeof raw !== 'object') return 'bad-period'
  const from = strOf(raw.from, 10)
  const to = strOf(raw.to, 10)
  if (!from || !to || !ISO.test(from) || !ISO.test(to)) return 'bad-period'
  // Datas fora de qualquer plausibilidade: ano 1000, ano 9999. O app existe
  // desde 2024 e projeta no máximo alguns anos à frente.
  const maxYear = Number(todayIso.slice(0, 4)) + 5
  const y1 = Number(from.slice(0, 4))
  const y2 = Number(to.slice(0, 4))
  if (!(y1 >= 2000 && y1 <= maxYear && y2 >= 2000 && y2 <= maxYear)) return 'bad-period'
  if (from > to) return 'bad-period'
  if (daysBetweenIso(from, to) > MAX_PERIOD_DAYS) return 'period-too-long'
  const grain = ['day', 'week', 'month', 'quarter', 'year', 'range'].includes(raw.grain) ? raw.grain : 'range'
  return {
    from, to, grain,
    label: strOf(raw.label, 60) || `${from} a ${to}`,
    future: from > todayIso,
  }
}

/**
 * Campos OPCIONAIS do plano em que `null` só quer dizer "não especificado"
 * (ver `semNulosOpcionais`). `source` e `period` são obrigatórios e ficam de
 * fora: `null` neles continua recusado. Nenhum campo deste contrato dá a `null`
 * um sentido próprio — "não há plano" é `source: 'none'`, uma string.
 */
const PLANO_OPCIONAIS = ['version', 'field', 'metric', 'group', 'order', 'comparePeriod', 'filter', 'limit', 'shareBase', 'label'] as const
/** Todo filtro é opcional: `null` é "sem essa restrição". */
const FILTRO_OPCIONAIS = [
  'categories', 'excludeCategories', 'txType', 'cardNames', 'excludeCardNames', 'goalName', 'text', 'excludeText', 'excludeTexts',
  'origin', 'platform', 'profileAtCreation', 'status', 'realizedOnly', 'plannedOnly', 'weekdays', 'monthHalf',
  'minAmount', 'maxAmount',
] as const

function validateFilter(bruto: any, state: AppState): QueryFilter | QueryErrorCode {
  const out: QueryFilter = {}
  if (bruto === undefined || bruto === null) return out
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return 'bad-filter'
  const raw = semNulosOpcionais(bruto, FILTRO_OPCIONAIS)

  const cats = new Map(usableCategories(state.categories || []).map(c => [c.id, c]))
  // O histórico pode usar categoria ARQUIVADA — e consultar o passado tem que
  // continuar funcionando (regra: arquivar some do seletor, não do histórico).
  const todasCats = new Set((state.categories || []).map(c => c.id))

  const listaCat = (v: any, campo: string): string[] | QueryErrorCode | undefined => {
    if (v === undefined || v === null) return undefined
    const arr = Array.isArray(v) ? v : [v]
    const out2: string[] = []
    for (const x of arr.slice(0, 30)) {
      const id = strOf(x, 40)
      if (!id) continue
      if (!todasCats.has(id)) return 'category-not-found'
      out2.push(id)
    }
    return out2.length ? out2 : undefined
  }

  const c1 = listaCat(raw.categories, 'categories')
  if (typeof c1 === 'string') return c1
  if (c1) out.categories = c1
  const c2 = listaCat(raw.excludeCategories, 'excludeCategories')
  if (typeof c2 === 'string') return c2
  if (c2) out.excludeCategories = c2
  void cats

  if (raw.txType !== undefined) {
    const arr = (Array.isArray(raw.txType) ? raw.txType : [raw.txType]).slice(0, 4)
    const ok = arr.filter((t: any) => TX_TYPES.includes(t))
    if (!ok.length) return 'bad-filter'
    out.txType = ok
  }

  const nomesCartao = (state.cards || []).map(c => normalizeName(c.name))
  const listaCartao = (v: any): string[] | QueryErrorCode | undefined => {
    if (v === undefined || v === null) return undefined
    const arr = (Array.isArray(v) ? v : [v]).slice(0, 10)
    const out2: string[] = []
    for (const x of arr) {
      const n = strOf(x, 60)
      if (!n) continue
      const alvo = normalizeName(n)
      if (!nomesCartao.some(c => c === alvo || c.includes(alvo) || alvo.includes(c))) return 'card-not-found'
      out2.push(n)
    }
    return out2.length ? out2 : undefined
  }
  const k1 = listaCartao(raw.cardNames)
  if (typeof k1 === 'string') return k1
  if (k1) out.cardNames = k1
  const k2 = listaCartao(raw.excludeCardNames)
  if (typeof k2 === 'string') return k2
  if (k2) out.excludeCardNames = k2

  const goal = strOf(raw.goalName, 60)
  if (goal) {
    const alvo = normalizeName(goal)
    if (!(state.goals || []).some(g => normalizeName(g.name) === alvo || normalizeName(g.name).includes(alvo))) {
      return 'goal-not-found'
    }
    out.goalName = goal
  }

  const texto = strOf(raw.text, 60)
  if (texto) out.text = texto
  const excText = strOf(raw.excludeText, 60)
  if (excText) out.excludeText = excText
  if (raw.excludeTexts !== undefined) {
    const lista: string[] = []
    for (const v of (Array.isArray(raw.excludeTexts) ? raw.excludeTexts : [raw.excludeTexts]).slice(0, 10)) {
      const texto = strOf(v, 60)
      if (texto) lista.push(texto)
    }
    if (!lista.length) return 'bad-filter'
    out.excludeTexts = [...new Set<string>(lista)]
  }
  const origin = strOf(raw.origin, 60)
  if (origin) out.origin = origin
  const platform = strOf(raw.platform, 30)
  if (platform) out.platform = platform
  const perfil = strOf(raw.profileAtCreation, 20)
  if (perfil) out.profileAtCreation = perfil

  if (raw.status !== undefined) {
    const arr = (Array.isArray(raw.status) ? raw.status : [raw.status]).slice(0, 7)
    const ok = arr.filter((s: any) => STATUSES.includes(s))
    if (!ok.length) return 'bad-filter'
    out.status = ok as QueryFilter['status']
  }

  if (raw.realizedOnly === true) out.realizedOnly = true
  if (raw.plannedOnly === true) out.plannedOnly = true
  if (out.realizedOnly && out.plannedOnly) return 'bad-filter'

  if (raw.weekdays !== undefined) {
    // Só número (ou algarismo escrito): `Number(null)`, `Number('')` e
    // `Number(false)` são 0 — um filtro de DOMINGO que ninguém pediu.
    const arr = (Array.isArray(raw.weekdays) ? raw.weekdays : [raw.weekdays])
      .filter((d: any) => typeof d === 'number' || (typeof d === 'string' && /^\s*\d+\s*$/.test(d)))
      .map((d: any) => Math.round(Number(d)))
      .filter((d: number) => Number.isFinite(d) && d >= 0 && d <= 6)
    if (!arr.length) return 'bad-filter'
    out.weekdays = [...new Set<number>(arr)]
  }
  if (raw.monthHalf === 'first' || raw.monthHalf === 'second') out.monthHalf = raw.monthHalf

  const min = numOf(raw.minAmount)
  const max = numOf(raw.maxAmount)
  if (min !== undefined) out.minAmount = Math.max(min, 0)
  if (max !== undefined) out.maxAmount = Math.max(max, 0)
  if (out.minAmount !== undefined && out.maxAmount !== undefined && out.minAmount > out.maxAmount) return 'bad-filter'

  return out
}

/** Métricas que só fazem sentido em algumas fontes. */
const METRIC_RESTRICTIONS: Partial<Record<QueryMetric, QuerySource[]>> = {
  net: ['transactions', 'recurring', 'projections'],
  'per-km': ['transactions', 'fuel'],
  'per-hour': ['transactions'],
  'per-trip': ['transactions'],
  share: ['transactions', 'recurring', 'installments', 'invoices', 'plans'],
}

/**
 * Valida o plano contra o vocabulário e contra as capacidades REAIS do usuário.
 * Devolve um objeto NOVO, montado campo a campo — nada do bruto é repassado.
 */
export function validateQueryPlan(
  bruto: any,
  state: AppState,
  todayIso: string,
): QueryValidation {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, code: 'not-object' }
  if (temChavePerigosa(bruto)) return { ok: false, code: 'dangerous-key' }
  const raw = semNulosOpcionais(bruto, PLANO_OPCIONAIS)
  if (raw.version !== undefined && raw.version !== QUERY_DSL_VERSION) {
    return { ok: false, code: 'bad-version', detail: String(raw.version).slice(0, 20) }
  }

  const source = raw.source as QuerySource
  if (!QUERY_SOURCES.includes(source)) {
    return { ok: false, code: 'unknown-source', detail: String(raw.source || '').slice(0, 30) }
  }
  if (DRIVER_ONLY_SOURCES.includes(source) && !isDriver(state.settings)) {
    return { ok: false, code: 'profile-forbidden', detail: source }
  }

  const permitidos = FIELDS_BY_SOURCE[source]
  const field: QueryField = raw.field === undefined ? permitidos[0] : raw.field
  if (typeof field !== 'string') return { ok: false, code: 'unknown-field' }
  if (!permitidos.includes(field)) {
    return { ok: false, code: 'field-not-in-source', detail: `${field} em ${source}` }
  }

  const metric = raw.metric === undefined ? 'sum' : raw.metric
  if (!QUERY_METRICS.includes(metric)) {
    return { ok: false, code: 'unknown-metric', detail: String(raw.metric || '').slice(0, 30) }
  }
  const restrito = METRIC_RESTRICTIONS[metric as QueryMetric]
  if (restrito && !restrito.includes(source)) {
    return { ok: false, code: 'metric-not-applicable', detail: `${metric} em ${source}` }
  }

  const group: QueryGroup = raw.group === undefined ? 'none' : raw.group
  if (!QUERY_GROUPS.includes(group)) {
    return { ok: false, code: 'unknown-group', detail: String(raw.group || '').slice(0, 30) }
  }
  // Agrupar corridas por plataforma só existe no perfil motorista.
  if (group === 'platform' && !isDriver(state.settings)) {
    return { ok: false, code: 'profile-forbidden', detail: 'platform' }
  }

  let order: QueryOrder | undefined
  if (raw.order !== undefined) {
    if (!QUERY_ORDERS.includes(raw.order)) {
      return { ok: false, code: 'unknown-order', detail: String(raw.order).slice(0, 30) }
    }
    order = raw.order
  }

  const period = validatePeriod(raw.period, todayIso)
  if (typeof period === 'string') return { ok: false, code: period }

  let comparePeriod: QueryPeriod | undefined
  if (raw.comparePeriod !== undefined && raw.comparePeriod !== null) {
    const cp = validatePeriod(raw.comparePeriod, todayIso)
    if (typeof cp === 'string') return { ok: false, code: cp, detail: 'comparação' }
    comparePeriod = cp
  }

  const filter = validateFilter(raw.filter, state)
  if (typeof filter === 'string') return { ok: false, code: filter }

  const limitRaw = numOf(raw.limit)
  const limit = limitRaw === undefined
    ? DEFAULT_GROUP_LIMIT
    : Math.min(Math.max(Math.round(limitRaw), 1), MAX_GROUPS)

  const shareBase = raw.shareBase === 'income' || raw.shareBase === 'expense' || raw.shareBase === 'same'
    ? raw.shareBase : undefined

  return {
    ok: true,
    plan: {
      version: QUERY_DSL_VERSION,
      source, field, period, comparePeriod, filter,
      metric: metric as QueryMetric,
      group, order, limit, shareBase,
      label: strOf(raw.label, 80),
    },
  }
}
