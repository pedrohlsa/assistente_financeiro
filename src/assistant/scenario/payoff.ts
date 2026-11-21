import type { AppState } from '../../models/types'
import { hasAmbiguousLegacyCardBalance, installmentRemaining, planProgress } from '../../services/cards'
import { fmtBRL, isCalendarDate, parseMoney, todayISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'

export interface PayoffQuote {
  amount: number
  kind: 'price' | 'discount' | 'percent'
}

const NUMBER = String.raw`(?:\d+(?:[.,]\d+)*)`
const PRICE = new RegExp(String.raw`\b(?:por|fica\s+em|saldo\s+de\s+quitacao\s+de)\s+(?:r\$\s*)?(${NUMBER})(?:\s+reais?)?(?!\d|[.,]\d)(?!\s*%)`, 'i')
const DISCOUNT = new RegExp(String.raw`\b(?:(?:com\s+)?desconto\s+de)\s+(?:r\$\s*)?(${NUMBER})\s*(%|reais?)?`, 'i')

export function readPayoffQuote(text: string): { quote?: PayoffQuote; name: string; conflict?: true } {
  const price = text.match(PRICE)
  const discount = text.match(DISCOUNT)
  if (price && discount) return { name: text, conflict: true }
  const match = price || discount
  const quote: PayoffQuote | undefined = match ? {
    amount: parseMoney(match[1]),
    kind: price ? 'price' : match[2] === '%' ? 'percent' : 'discount',
  } : undefined
  const name = (match ? text.slice(0, match.index) : text)
    .replace(/(?:[,;\s]+(?:antes|hoje|agora|ja|logo|de\s+uma\s+vez|adiantado|antecipado|todo|toda|inteiro|inteira))+\s*[.!?]*$/g, '')
    .replace(/[?!.;,\s]+$/, '').trim()
  return { name, quote }
}

const words = (text?: string) => normalizeName(text).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

export function findPayoffPlan(state: AppState, description: string, today = todayISO(), cardName?: string) {
  const target = words(description)
  if (!target) return { question: 'Qual parcelamento você quer simular quitar? Diga o nome que aparece em Cartões e parcelamentos.' } as const
  if (hasAmbiguousLegacyCardBalance(state)) {
    return { question: 'Confira os pagamentos antigos da fatura antes de usar o valor da quitação.' } as const
  }
  const candidates = (state.installmentPlans || []).filter(plan => plan.status !== 'cancelled'
    && (!cardName || state.cards.some(c => c.id === plan.cardId && words(c.name) === words(cardName))))
  const open = candidates.filter(p => p.status === 'active')
  const exact = open.filter(p => words(p.description) === target)
  const named = exact.length ? exact : open.filter(p => ` ${words(p.description)} `.includes(` ${target} `))
  if (named.length > 1) {
    const options = named.slice(0, 4).map(p => {
      const card = state.cards.find(c => c.id === p.cardId)
      return `${sentenceCase(p.description)}${card ? ` no ${card.name}` : ''} (${fmtBRL(planProgress(state, p, today).remainingAmount)} em aberto)`
    })
    return { question: `Encontrei mais de um parcelamento. Qual você quer quitar? ${options.join('; ')}.` } as const
  }
  if (!named.length) {
    if (candidates.some(p => p.status === 'settled' && words(p.description) === target)) {
      return { question: `O parcelamento ${sentenceCase(description)} já está quitado.` } as const
    }
    return { question: `Não encontrei um parcelamento em aberto chamado “${sentenceCase(description)}”. Confira o nome em Cartões e parcelamentos.` } as const
  }
  const [plan] = named
  const progress = planProgress(state, plan, today)
  if (!(progress.remainingAmount > 0)) return { question: `O parcelamento ${sentenceCase(plan.description)} não tem parcelas em aberto.` } as const
  const lastDue = progress.installments.reduce<string | undefined>((last, i) =>
    isCalendarDate(i.dueDate) && installmentRemaining(state, i, today) > 0 && (!last || i.dueDate > last) ? i.dueDate : last, undefined)
  return { progress, lastDue } as const
}
