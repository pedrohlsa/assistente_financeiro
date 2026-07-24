// Regras de perfil — fonte única de verdade sobre o que cada tipo de usuário vê.
// profile: 'driver' (motorista de app) | 'autonomo' | 'clt' | 'business' (legado) | 'other'
import { AppState, ParsedAction, Settings } from '../models/types'

export type ProfileId = Settings['profile']

/** Único perfil que enxerga corridas, km, veículo, combustível e taxa da 99. */
export const isDriver = (s: Settings): boolean => s.profile === 'driver'

/** Categorias de receita ligadas a transporte por aplicativo. */
export const RIDE_INCOME_CATEGORIES = ['corridas']

/** Categoria padrão de receita quando o texto não deixa claro a origem. */
export function defaultIncomeCategory(s: Settings): string {
  return isDriver(s) ? 'corridas' : 'outros-in'
}

/**
 * A taxa de saque da 99 só existe para motorista, e só quando a receita
 * é de corridas OU o usuário citou a plataforma explicitamente.
 * Nunca vale para aluguel, salário, venda ou freelance.
 */
export function shouldAsk99Fee(state: AppState, action: ParsedAction): boolean {
  const s = state.settings
  if (!isDriver(s)) return false
  if (!s.ask99Fee || !(s.platform99Fee > 0)) return false
  if (action.kind !== 'income') return false
  if ((action as any).is99) return false // já marcado, taxa aplicada direto
  return RIDE_INCOME_CATEGORIES.includes(action.category || defaultIncomeCategory(s))
}

/** A taxa só pode ser efetivamente aplicada no perfil motorista. */
export const can99FeeApply = (s: Settings): boolean => isDriver(s) && s.platform99Fee > 0

/**
 * Menção EXPLÍCITA à plataforma 99 ("saque da 99", "pela 99", "caiu da 99").
 * Não casa com o número 99 usado como valor ("recebi 99 reais").
 */
export const MENTIONS_99 = /\b(?:d[ao]|pel[ao]|n[ao]|via|app|aplicativo|plataforma)\s*99\b|\b99\s*(?:app|pay|pop)\b|saque\s*(?:d[ao]\s*)?99\b|\bnoventa e nove\b(?!\s*(?:reais|conto))/i

/**
 * Procura um lançamento muito parecido já registrado (14.8): mesmo tipo,
 * mesmo valor, data igual ou próxima e descrição/origem semelhante.
 * Não bloqueia — serve para pedir confirmação extra.
 */
export function findPossibleDuplicate(state: AppState, action: ParsedAction) {
  if (action.kind !== 'income' && action.kind !== 'expense') return undefined
  const today = new Date()
  const norm = (x?: string) => (x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
  const a = action as any
  return state.transactions.find(t => {
    if (t.type !== action.kind) return false
    if (Math.abs(t.amount - action.amount) > 0.009) return false
    const diffDays = Math.abs((today.getTime() - new Date(t.date + 'T12:00:00').getTime()) / 86400000)
    if (diffDays > 1.5) return false
    // Origem/descrição só DESCARTAM o alerta quando ambas existem e divergem.
    // Ausentes = não discriminam (valor + tipo + data já bastam para avisar).
    const o1 = norm(t.origin), o2 = norm(a.origin)
    if (o1 && o2 && o1 !== o2) return false
    const d1 = norm(t.description), d2 = norm(a.description)
    if (d1 && d2 && !(d1 === d2 || d1.includes(d2) || d2.includes(d1))) return false
    return true
  })
}

/** Rótulo do objetivo mensal conforme o perfil. */
export function monthlyTargetLabel(s: Settings): string {
  return isDriver(s) ? 'Objetivo de lucro mensal' : 'Quanto deseja guardar por mês'
}
