import type { ParsedAction } from '../models/types'
import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { analyzeMessage, looksLikeQuestion, looksPast } from './clauses'
import { normalizeNumberWords } from './numbers'
import { readDraftPurchaseDate, type IncompleteIntent } from './drafts'

const MONEY = String.raw`(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(?:\s+(?:reais?|contos?|pila))?`
const INCLUDED_ITEM = String.raw`${MONEY}\s+(?:d[eo]\s+(?:frete|entrega|taxas?|juros|servi[cç]o|gorjetas?)|(?:no|via|por)\s+pix|em\s+dinheiro)\b`
const INCLUDED = new RegExp(String.raw`(?:\s*,\s*|\s+)(?:e\s+)?(?:incluindo|contando(?:\s+com)?|dos\s+quais|dest[ea]s|dess[ea]s|j[áa]\s+com)\s+(?:[oa]s?\s+)?(${INCLUDED_ITEM}(?:(?:\s+e\s+|,\s*)${INCLUDED_ITEM})*)`, 'i')
const ITEMS = new RegExp(INCLUDED_ITEM, 'gi')
const TRAILING_TOTAL = new RegExp(String.raw`(?:,(?!\d)|(?<!\d),|;)\s*(?:(?:e\s+)?(?:tudo\s+deu|somando\s+d[aá]|total(?:\s+de|\s+foi)?|ao\s+todo|no\s+total)\s+${MONEY}|${MONEY}\s+(?:no\s+total|ao\s+todo))[.!]*$`, 'i')

const PAYMENT_HEAD = new RegExp(String.raw`^(\s*(?:(?:eu|hoje|ontem|anteontem)\s+){0,3}(?:gastei|paguei|comprei)\s+)${MONEY}((?:\s+(?!r\$|\d)[^,;!?]*)?)$`, 'i')
const PAYMENT_SHARE = new RegExp(String.raw`^${MONEY}\s+(?:(?:foi|paguei|passei)\s+)?(.+?)$`, 'i')
const CASH_METHOD = /^(?:(?:via|no|por|pelo)\s+pix|em\s+(?:dinheiro|especie)|(?:no|por|em)\s+debito|no\s+cartao\s+de\s+debito)$/
const CREDIT_PREFIX = /^(?:no|na|pelo|pela|em)\s+(?:(?:cartao\s+)(?:d[oa]\s+)?)?/
const CREDIT_GENERIC = /^(?:no|pelo)\s+(?:cartao(?:\s+de\s+credito)?|credito)$/
const SHARE_INSTALLMENTS = /\s+(?:em\s+)?\d+\s*(?:x|vezes|parcelas?)$/i

type ReconciledTotal = { text?: string; issue?: string; dateQuestion?: IncompleteIntent['purchaseDateQuestion'] }

type PaymentShare = { amount: number; card?: string; installments?: string }

function paymentShare(text: string, cardNames: string[]): PaymentShare | undefined {
  const part = text.trim().replace(/[.!]+$/, '').match(PAYMENT_SHARE)
  if (!part) return undefined
  const amount = parseMoney(part[1])
  if (!(amount > 0)) return undefined
  const installments = part[2].match(SHARE_INSTALLMENTS)
  const method = normalizeName(installments ? part[2].slice(0, installments.index) : part[2])
  if (!installments && CASH_METHOD.test(method)) return { amount }
  const known = cardNames.find(name => normalizeName(name) === method.replace(CREDIT_PREFIX, ''))
  const credit = known ? `no ${known}` : CREDIT_GENERIC.test(method) ? method : undefined
  return credit ? { amount, card: credit, installments: installments?.[0].trim() } : undefined
}

function splitSpokenPayment(text: string, today: string, cardNames: string[]): ReconciledTotal | undefined {
  const separator = text.match(/(?:,(?!\d)|(?<!\d),|;)\s*(?=(?:r\$\s*)?\d)/i)
  if (!separator) return undefined
  const initial = text.slice(0, separator.index)
  const date = readDraftPurchaseDate(initial, today)
  const head = date.remaining.match(PAYMENT_HEAD)
  if (!head || looksLikeQuestion(head[0])) return undefined
  const tail = text.slice(separator.index + separator[0].length)
  const parts = tail.split(/(?:\s+e\s+|[,;]\s+)(?=(?:r\$\s*)?\d)/i)
  const totalSaid = /\b(?:no\s+total|ao\s+todo)\b/i.test(head[3])
  if (parts.length > 4 || (parts.length === 1 && !totalSaid)) return undefined
  const shares = parts.map(part => paymentShare(part, cardNames))
  if (!shares.every((part): part is PaymentShare => !!part)) return undefined
  const total = parseMoney(head[2])
  const sum = shares.reduce((amount, share) => amount + cents(share.amount), 0)
  if (cents(total) !== sum) {
    return { issue: `As partes do pagamento somam ${fmtBRL(sum / 100)}, e você disse ${fmtBRL(total)} no total. Quanto foi em cada meio de pagamento?` }
  }
  const cards = shares.filter(share => share.card)
  const label = head[3].replace(/\b(?:no\s+total|ao\s+todo)\b/gi, '').trim()
  const amountText = (amount: number) => String(amount).replace('.', ',')
  const statement = (amount: number) => [head[1].trim(), amountText(amount), label].filter(Boolean).join(' ')
  const dated = (body: string): ReconciledTotal => ({ text: date.date ? `em ${date.date} ${body}` : body, dateQuestion: date.question })
  if (!cards.length) return dated(statement(total))
  if (cards.length > 1 || /\b(?:fatura|presta[çc][ãa]o|parcelas?)\b/i.test(label)) {
    return { issue: 'Diga separadamente quanto saiu da conta e quanto foi cobrado em cada cartão.' }
  }
  const cash = shares.filter(share => !share.card).reduce((amount, share) => amount + cents(share.amount), 0)
  const [credit] = cards
  const hasInstallments = !!credit.installments
  const creditPrefix = hasInstallments ? head[1].replace(/(?:gastei|paguei|comprei)\s*$/i, 'comprei') : head[1].trim()
  const item = label.replace(/^(?:no|na|em|de|do|da)\s+/i, '')
  const cardStatement = hasInstallments
    ? [creditPrefix, item ? `um ${item}` : '', `por R$ ${amountText(credit.amount)}`, credit.installments, credit.card]
    : [creditPrefix, amountText(credit.amount), label, credit.card]
  const purchase = cardStatement.filter(Boolean).join(' ')
  return dated([cash > 0 ? statement(cash / 100) : '', purchase].filter(Boolean).join(' e '))
}

type Movement = { kind: 'in' | 'out'; amount: number }

function movement(a: ParsedAction): Movement | undefined {
  if (a.kind === 'income') return { kind: 'in', amount: a.amount }
  if (a.kind === 'expense' || a.kind === 'card-payment' || a.kind === 'fuel') {
    return a.amount > 0 ? { kind: 'out', amount: a.amount } : undefined
  }
  if (a.kind === 'card-purchase') return { kind: 'out', amount: a.total }
  return undefined
}

function movements(text: string, today: string, driver: boolean): Movement[] {
  const analysis = analyzeMessage(text, { today, driver })
  if (analysis.clauses.some(c => c.ambiguity || c.intention || c.approximateAmount || c.temporal?.plan)) return []
  // Data pendente segura o lançamento. Os valores ditos ainda podem ser conferidos.
  const stated = analysis.clauses.flatMap(c => c.temporal?.actions?.length ? c.temporal.actions : c.actions)
    .filter(a => a.kind !== 'work')
  const mapped = stated.map(movement)
  return mapped.every((m): m is Movement => !!m) ? mapped : []
}

const cents = (amount: number): number => Math.round(amount * 100)

/** Totais declarados e parcelas inclusas explicam os itens de um relato. */
export function reconcileSpokenTotals(message: string, today: string, driver: boolean, cardNames: string[]): ReconciledTotal | undefined {
  if (!looksPast(message)) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const split = splitSpokenPayment(text, today, cardNames)
  if (split) return split
  const included = text.match(INCLUDED)
  if (included) {
    const before = text.slice(0, included.index)
    const parent = looksLikeQuestion(before) ? undefined : movements(before, today, driver).at(-1)
    if (parent) {
      const components = [...included[1].matchAll(ITEMS)].reduce((sum, item) => sum + cents(parseMoney(item[1])), 0)
      if (components > cents(parent.amount)) {
        return { issue: `Os valores incluídos somam ${fmtBRL(components / 100)}, acima do valor informado de ${fmtBRL(parent.amount)}. Qual foi o valor total?` }
      }
      const after = text.slice(included.index + included[0].length)
      const command = before + after
      // Um relato pode explicar inclusões e concluir com o total dos itens.
      return reconcileSpokenTotals(command, today, driver, cardNames) || { text: command }
    }
  }
  const total = text.match(TRAILING_TOTAL)
  if (!total) return undefined
  const body = text.slice(0, total.index).trim()
  if (looksLikeQuestion(body)) return undefined
  const items = movements(body, today, driver)
  if (items.length < 2 || items.some(item => item.kind !== items[0].kind)) return undefined
  const declared = parseMoney(total[1] || total[2])
  const sum = items.reduce((amount, item) => amount + cents(item.amount), 0)
  if (cents(declared) !== sum) {
    return { issue: `Os itens somam ${fmtBRL(sum / 100)}, e você disse ${fmtBRL(declared)} no total. Quais foram os valores corretos?` }
  }
  return { text: body }
}
