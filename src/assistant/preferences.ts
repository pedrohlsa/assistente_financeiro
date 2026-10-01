import type { AppState, AssistantPreference } from '../models/types'
import { normalizeName } from '../utils/text'
import { NUMBER_WORD_RE } from './numbers'

export type PreferenceMutation =
  | { type: 'upsert'; preference: AssistantPreference }
  | { type: 'remove'; id: string }

const clean = (s: string) => s.trim().replace(/\s+/g, ' ')
const GRAMMAR = /\b(?:vou|vai|irei|amanha|ontem|hoje|futuro|passado|nao|nunca|sim|gastei|gastar|paguei|pagar|recebi|receber|ganhei|ganhar|guardei|guardar|renda|despesa|receita|valor|reais?)\b/
const PROTECTED = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|dia|dias|semana|semanas|mes|meses|ano|anos|mensal|semanal|diario|anual|quinzenal|bimestral|trimestral|recorrente|parcela|parcelas|vezes|porcento|percentual|porcentagem|metade|dobro|triplo|futuro|amanha|ontem|hoje|nao|nunca|talvez|pretendo|quero|vou|confirm[a-z]*|pendente|cancel[a-z]*|registr[a-z]*|anot[a-z]*|estorn[a-z]*|devol[a-z]*|transfer[a-z]*|deposit[a-z]*|receb[a-z]*|pag[a-z]*|gast[a-z]*|ganh[a-z]*|envi[a-z]*|mand[a-z]*|ped[a-z]*|solicit[a-z]*|entrada|saida|receita|despesa|renda|saldo|reais?|centavos?|pix|km|quilometros?)\b/
const PROTECTED_GLOBAL = new RegExp(`${NUMBER_WORD_RE.source}|${PROTECTED.source}|\\d+(?:[.,]\\d+)*\\s*%?`, 'g')
const protectedSignature = (text: string): string =>
  (normalizeName(text).match(PROTECTED_GLOBAL) || []).join('|')
const changesFinancialMeaning = (trigger: string, value: string): boolean =>
  !!protectedSignature(trigger) || !!protectedSignature(value)
const safeVocabulary = (trigger: string, value: string, kind: AssistantPreference['kind']) => {
  const a = normalizeName(trigger)
  const b = normalizeName(value)
  return a.length >= 2 && b.length >= 2 && a.length <= 60 && b.length <= 60
    && /[a-z]/.test(a) && /[a-z]/.test(b)
    && !/[\r\n\u0000-\u001f$]/.test(trigger + value)
    && !GRAMMAR.test(a) && !GRAMMAR.test(b)
    && !changesFinancialMeaning(trigger, kind === 'entity-alias' && /^casa\s+\d{1,2}$/i.test(value) ? 'casa' : value)
    && (kind !== 'entity-alias' || !/\d/.test(trigger))
    && (kind === 'category-mapping' ? !/\d/.test(a)
      : kind === 'entity-alias' ? !/\d{3,}/.test(a + b)
        : !/\d/.test(a + b))
}

export const isSafePreference = (p: unknown): p is AssistantPreference =>
  !!p && typeof p === 'object'
  && typeof (p as AssistantPreference).id === 'string'
  && typeof (p as AssistantPreference).trigger === 'string'
  && typeof (p as AssistantPreference).value === 'string'
  && (p as AssistantPreference).source === 'user-explicit'
  && ['alias', 'category-mapping', 'entity-alias', 'terminology'].includes((p as AssistantPreference).kind)
  && safeVocabulary((p as AssistantPreference).trigger, (p as AssistantPreference).value, (p as AssistantPreference).kind)

/** Um trigger normalizado tem uma identidade só, inclusive após backup/merge. */
export function mergePreferenceLists(current: AssistantPreference[], incoming: unknown): AssistantPreference[] {
  const merged = new Map<string, AssistantPreference>()
  for (const p of [...current, ...(Array.isArray(incoming) ? incoming : [])]) {
    if (isSafePreference(p)) merged.set(normalizeName(p.trigger), p)
  }
  return [...merged.values()]
}

export function upsertPreference(
  list: AssistantPreference[], input: Omit<AssistantPreference, 'id' | 'createdAt' | 'updatedAt' | 'source'>,
  now = new Date().toISOString(), id = `pref-${Math.random().toString(36).slice(2, 10)}`,
): AssistantPreference[] {
  if (!safeVocabulary(input.trigger, input.value, input.kind)) return list
  const trigger = clean(input.trigger)
  const value = clean(input.value)
  const existing = list.find(p => normalizeName(p.trigger) === normalizeName(trigger))
  const preference: AssistantPreference = existing
    ? { ...existing, kind: input.kind, value, updatedAt: now }
    : { id, kind: input.kind, trigger, value, source: 'user-explicit', createdAt: now, updatedAt: now }
  return mergePreferenceLists(list.filter(p => normalizeName(p.trigger) !== normalizeName(trigger)), [preference])
}

export const removePreference = (list: AssistantPreference[], id: string): AssistantPreference[] =>
  list.filter(p => p.id !== id)

export function updatePreference(
  list: AssistantPreference[], id: string, patch: Partial<Pick<AssistantPreference, 'trigger' | 'value' | 'kind'>>,
  now = new Date().toISOString(),
): AssistantPreference[] {
  return mergePreferenceLists([], list.map(p => {
    if (p.id !== id) return p
    const next = { ...p, ...patch, updatedAt: now }
    return safeVocabulary(next.trigger, next.value, next.kind) ? next : p
  }))
}

export function parsePreferenceCommand(state: AppState, text: string, now = new Date().toISOString()):
  { mutation?: PreferenceMutation; reply: string } | undefined {
  const raw = clean(text)
  const norm = normalizeName(raw)
  const prefs = mergePreferenceLists([], state.assistantPreferences)

  if (/^(?:lista|mostra|quais)(?:r)?\s+(?:as\s+)?(?:minhas\s+)?preferencias/.test(norm)) {
    const reply = prefs.length
      ? `Preferências que você me ensinou:\n${prefs.map(p => `• ${p.trigger} → ${p.value}`).join('\n')}`
      : 'Você ainda não me ensinou nenhuma preferência.'
    return { reply }
  }
  const namedRemoval = norm.match(/^(?:esquece|apaga|remove)\s+(?:a\s+)?preferencia\s+(.+)$/)
  if (namedRemoval) {
    const target = prefs.find(p => normalizeName(p.trigger) === namedRemoval[1])
    return target
      ? { mutation: { type: 'remove', id: target.id }, reply: `Posso esquecer “${target.trigger} → ${target.value}”. Confirma?` }
      : { reply: 'Não encontrei essa preferência. Peça “lista minhas preferências” para ver os nomes salvos.' }
  }
  if (/^(?:esquece|apaga|remove)(?:r)?\s+(?:essa|a\s+ultima|minha)?\s*preferencia/.test(norm)) {
    if (prefs.length > 1) return { reply: `Qual delas você quer esquecer? ${prefs.map(p => p.trigger).join(', ')}. Diga “esquece preferência [nome]”.` }
    const only = prefs[0]
    return only
      ? { mutation: { type: 'remove', id: only.id }, reply: `Posso esquecer “${only.trigger} → ${only.value}”. Confirma?` }
      : { reply: 'Você não tem nenhuma preferência salva para eu esquecer.' }
  }

  let kind: AssistantPreference['kind'] = 'alias'
  let trigger = ''
  let value = ''
  let m = raw.match(/^quando eu falar\s+(.+?)\s+(quero dizer|significa|considera|considere|[ée])\s+(.+?)\s*[.!?]?$/i)
  if (m) { kind = /^(?:considera|considere)$/i.test(m[2]) ? 'terminology' : 'alias'; trigger = m[1]; value = m[3] }
  if (!m) {
    m = raw.match(/^(.+?)\s+[ée]\s+minha\s+(casa\s+\d+)\s*[.!?]?$/i)
    if (m) { kind = 'entity-alias'; trigger = m[1]; value = m[2] }
  }
  if (!m) {
    m = raw.match(/^(.+?)\s+(?:coloca|coloque|considera|considere)\s+em\s+(.+?)\s*[.!?]?$/i)
    if (m) { kind = 'category-mapping'; trigger = m[1]; value = categoryId(state, m[2]) || '' }
  }
  if (!m) return undefined
  if (!safeVocabulary(trigger, value, kind)) {
    return { reply: 'Não salvei isso. Preferências podem ensinar nomes e categorias, mas nunca trocar valores, datas ou regras financeiras.' }
  }
  const existing = prefs.find(p => normalizeName(p.trigger) === normalizeName(trigger))
  const id = existing?.id || `pref-${Math.random().toString(36).slice(2, 10)}`
  const preference: AssistantPreference = {
    id, kind, trigger: clean(trigger), value: clean(value), source: 'user-explicit',
    createdAt: existing?.createdAt || now, updatedAt: now,
  }
  const shownValue = kind === 'category-mapping'
    ? state.categories.find(c => c.id === value)?.name || value
    : value
  return {
    mutation: { type: 'upsert', preference },
    reply: `Posso guardar a preferência “${clean(trigger)} → ${shownValue}” para as próximas mensagens. Seus lançamentos antigos não mudam. Confirma?`,
  }
}

function categoryId(state: AppState, text: string): string | undefined {
  const n = normalizeName(text)
  return state.categories.find(c => normalizeName(c.name) === n || normalizeName(c.id) === n)?.id
}

/** Substitui somente aliases textuais; números e modalidade nunca entram aqui. */
export function applyPreferenceAliases(state: AppState, text: string): string {
  return mergePreferenceLists([], state.assistantPreferences)
    .filter(p => isSafePreference(p) && (p.kind === 'alias' || p.kind === 'entity-alias' || p.kind === 'terminology'))
    .sort((a, b) => b.trigger.length - a.trigger.length)
    .reduce((out, p) => {
      const folded = normalizeName(p.trigger)
      const accented: Record<string, string> = {
        a: '[aáàâãä]', c: '[cç]', e: '[eéèêë]', i: '[iíìîï]',
        n: '[nñ]', o: '[oóòôõö]', u: '[uúùûü]',
      }
      const pattern = [...folded].map(char => char === ' ' ? '\\s+'
        : accented[char] || char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
      const changed = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu'), p.value)
      return protectedSignature(out) === protectedSignature(changed) ? changed : out
    }, text)
}

export function preferenceCategoryFor(state: AppState, text: string, type: 'income' | 'expense'): string | undefined {
  const n = normalizeName(text)
  return mergePreferenceLists([], state.assistantPreferences).find(p =>
    isSafePreference(p) && p.kind === 'category-mapping' && normalizeName(p.trigger) === n
    && state.categories.some(c => c.id === p.value && c.type === type && c.archived !== true))?.value
}
