import type { ParsedAction } from '../models/types'
import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeName } from '../utils/text'
import { analyzeMessage, looksLikeQuestion, looksPast, segment } from './clauses'
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
const PAYMENT_PREFIX = String.raw`(?<prefix>(?:(?:eu|hoje|hj|ontem|anteontem|agora|j[áa])\s+){0,4})(?<verb>paguei|recebi|me\s+pag(?:ou|aram))\s+(?:(?:s[óo]|apenas|somente)\s+)?`
const PARTIAL_FROM_TOTAL = new RegExp(String.raw`^${PAYMENT_PREFIX}(?<paid>${MONEY})\s+(?:dos|das|de\s+um\s+total\s+de)\s+(?<total>${MONEY})(?=$|[.,;!?]|\s+(?:d[aeo]s?|n[ao]|em|pel[ao]|hoje|ontem|e)\b)(?<tail>[\s\S]*)$`, 'i')
const HALF_FROM_TOTAL = new RegExp(String.raw`^${PAYMENT_PREFIX}(?:a\s+)?(?:metade|1\s*/\s*2)\s+(?:dos|das|de\s+um\s+total\s+de)\s+(?<total>${MONEY})(?<label>\s+d[aeo]s?\s+[^,;!?]+?)?(?:\s*[,;]\s*(?:deu|foram|ficou\s+em)\s+(?<paid>${MONEY}))?\s*[.!]*$`, 'i')
const NET_VALUE = String.raw`${MONEY}\s+(?:limp[oa]s?|l[íi]quid[oa]s?)(?![\wÀ-ÿ])`
const DRIVER_RESULT_START = String.raw`(?:(?:eu|hoje|hj|ontem|anteontem|agora|j[áa])\s+){0,4}(?:fiz|fechei|ganhei|faturei|tirei|recebi|deu|ficou|sobrou)\s+`
const OPERATING_COST = String.raw`(?:gastos?|custos?|despesas?|combust[íi]vel|gasolina|etanol|diesel|ped[áa]gio|aluguel\s+d[eo]\s+carro)(?![\wÀ-ÿ])`
const NET_WITH_COST = new RegExp(String.raw`(?:(?:^|[,;]\s*|\s+e\s+)${DRIVER_RESULT_START}|\b(?:sobrou|sobraram|ficou)\s+|[,;]\s*)${NET_VALUE}\s+(?:j[áa]\s+)?(?:com|depois\s+d[aeo]s?|descontando|tirando|abatendo)\s+(?:[ao]s?\s+)?(?:${MONEY}\s+(?:d[aeo]|em)\s+)?${OPERATING_COST}`, 'i')
const BOTH_NET_AND_GROSS = new RegExp(String.raw`^${DRIVER_RESULT_START}${MONEY}\s+brut[oa]s?(?:\s+(?:na|no|pela|pelo|da|do)\s+(?:uber|99|in\s*drive[r]?))?(?:\s+e\s+|,\s*)(?:(?:ficou|sobrou|deu|recebi)\s+)?${NET_VALUE}[.!]*$`, 'i')
const NET_AFTER_PAYMENTS = new RegExp(String.raw`(?:[,;]\s*|\s+e\s+)(?:sobrou|sobraram|ficou)\s+${NET_VALUE}[.!]*$`, 'i')
const CARD_PURCHASE_SAID = /^(?:(?:eu|hoje|hj|ontem|anteontem|j[áa])\s+){0,4}(?:comprei|parcelei|passei|paguei|financiei)\b/i
const CARD_INSTALLMENT_QUOTE = new RegExp(String.raw`(?<![\d.,])(\d+)\s*(?:x|vez(?:es)?|parcelas?)\s+(?:de|com|no\s+valor\s+de)\s+${MONEY}`, 'i')
const CARD_TOTAL_SAID = new RegExp(String.raw`\b(?:por|de|custou|total(?:\s+de|\s+foi)?|comprei|parcelei|passei|paguei|financiei)\s+${MONEY}(?=\s*(?:$|no\s|na\s|pelo\s|pela\s))`, 'i')
const AT_ONCE = /(?<![\wÀ-ÿ])[àa]\s+vista(?![\wÀ-ÿ])/i
const CASH_PURCHASE_TENDER = /(?<![\wÀ-ÿ])(?:(?:via|por|no|pelo)\s+pix|em\s+(?:dinheiro|esp[ée]cie)|(?:no|por|em)\s+(?:cart[ãa]o\s+de\s+)?d[ée]bito)(?![\wÀ-ÿ])/i
const INVOICE_LIST_HEAD = /^(?<lead>(?:(?:eu|hoje|hj|ontem|anteontem|j[áa])\s+){0,4})(?:paguei|quitei)\s+/i
const INVOICE_LIST_ITEM = new RegExp(String.raw`^(?:mais\s+)?(?:paguei\s+|quitei\s+)?${MONEY}\s+(?:(da\s+fatura|d[aeo]\s+faturas?)\s+)?d[ao]\s+(.+?)$`, 'i')

type ReconciledTotal = { text?: string; issue?: string; dateQuestion?: IncompleteIntent['purchaseDateQuestion'] }

type PaymentShare = { amount: number; card?: string; installments?: string }

function linkedInvoicePayments(text: string, cardNames: string[]): ReconciledTotal | undefined {
  const lead = text.match(INVOICE_LIST_HEAD)
  if (!lead || !/\bfatura\b/i.test(text) || cardNames.length < 2) return undefined
  const parts = text.slice(lead[0].length).replace(/[.!]+$/, '').split(/\s+e\s+|[,;]\s+(?:e\s+)?/)
  if (parts.length < 2 || parts.length > 4) return undefined
  const bills = parts.map(part => part.trim().match(INVOICE_LIST_ITEM))
  if (!bills.every(Boolean) || !bills.some(item => item[2])) return undefined
  const known = bills.map(item => cardNames.find(name => normalizeName(name) === normalizeName(item[3])))
  if (!known.every(Boolean)) return undefined
  return { text: lead.groups.lead + bills.map((item, i) => `paguei R$ ${item[1]} da fatura do ${known[i]}`).join(' e ') }
}

function creditPurchaseTerms(text: string, today: string, cardNames: string[]): ReconciledTotal | undefined {
  if (!AT_ONCE.test(text) && !CARD_INSTALLMENT_QUOTE.test(text) && !CASH_PURCHASE_TENDER.test(text)) return undefined
  let rewritten = text
  for (const part of segment(text, today).reverse()) {
    const phrase = part.text
    if (!CARD_PURCHASE_SAID.test(phrase) || looksLikeQuestion(phrase)) continue
    const perInstallment = phrase.match(CARD_INSTALLMENT_QUOTE)
    if (perInstallment) {
      const before = phrase.slice(0, perInstallment.index).replace(/\s+em\s*$/i, '').trimEnd()
      const price = before.match(CARD_TOTAL_SAID)
      const itemized = Number(perInstallment[1]) * cents(parseMoney(perInstallment[2]))
      if (price && cents(parseMoney(price[1])) !== itemized) {
        return { issue: `As parcelas somam ${fmtBRL(itemized / 100)}, e você informou ${fmtBRL(parseMoney(price[1]))} no total. Qual foi o total cobrado no cartão?` }
      }
      continue
    }
    if (/\b(?:faturas?|parcelas?)\b|\d+\s*(?:x|vezes)\b/i.test(phrase)) continue
    const tender = phrase.match(CASH_PURCHASE_TENDER)
    const target = normalizeName(tender ? phrase.replace(tender[0], ' ') : phrase)
    const credit = /\b(?:no|pelo)\s+(?:cartao|credito)\b/.test(target)
      || cardNames.some(name => {
        const card = normalizeName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(String.raw`(?<![\wÀ-ÿ])(?:n[ao]|pel[ao])\s+${card}(?![\wÀ-ÿ])`).test(target)
      })
    if (tender && !credit && /\bcomprei\b/i.test(phrase)
      && !/\b(?:mas|por[ée]m|s[óo]\s+que)\b/i.test(phrase)) {
      const replacement = phrase.replace(tender[0], ' ').replace(AT_ONCE, ' ')
      rewritten = rewritten.slice(0, part.start) + replacement + rewritten.slice(part.start + phrase.length)
    } else if (!tender && credit && AT_ONCE.test(phrase)) {
      const at = part.start + phrase.search(AT_ONCE)
      rewritten = rewritten.slice(0, at) + 'em 1x' + rewritten.slice(at + phrase.match(AT_ONCE)[0].length)
    }
  }
  return rewritten !== text ? { text: rewritten } : undefined
}

function partialSpokenPayment(text: string): ReconciledTotal | undefined {
  const half = text.match(HALF_FROM_TOTAL)?.groups
  const part = half || text.match(PARTIAL_FROM_TOTAL)?.groups
  if (!part) return undefined
  const total = cents(parseMoney(part.total))
  const paid = part.paid ? cents(parseMoney(part.paid)) : total / 2
  if (half && part.paid && Math.abs(paid - total / 2) > 0.5) {
    return { issue: `Você disse metade de ${fmtBRL(total / 100)} e informou ${fmtBRL(paid / 100)}. Qual valor realmente foi pago?` }
  }
  if (!(paid > 0) || paid > total || !Number.isInteger(paid)) {
    return { issue: 'Qual foi o valor pago, em reais e centavos? Use o valor que entrou ou saiu da conta.' }
  }
  const verb = /^me\s+/i.test(part.verb) ? 'recebi' : part.verb
  const label = part.tail ?? part.label ?? ''
  const partialBill = /^paguei$/i.test(verb) && paid < total && /^\s+d[aeo]s?\s+(?!fatura\b)/i.test(label)
  return { text: `${part.prefix}${verb} ${String(paid / 100).replace('.', ',')}${partialBill ? ' de parte' : ''}${label}` }
}

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

function reconcileDriverResult(text: string, today: string): ReconciledTotal | undefined {
  if (text.includes('?')) return undefined
  const costsIncluded = text.match(NET_WITH_COST)
  if (costsIncluded && !looksLikeQuestion(text.slice(0, costsIncluded.index))) {
    return { issue: `Os ${fmtBRL(parseMoney(costsIncluded[1]))} são o valor que entrou ou quanto sobrou depois dos gastos? Diga quanto entrou e quais custos você pagou à parte.` }
  }
  const grossAndNet = text.match(BOTH_NET_AND_GROSS)
  if (grossAndNet) {
    return { issue: `Você informou ${fmtBRL(parseMoney(grossAndNet[1]))} brutos e ${fmtBRL(parseMoney(grossAndNet[2]))} líquidos. Qual valor entrou? Se você pagou algo à parte, diga quanto saiu e com o quê.` }
  }
  const summary = text.match(NET_AFTER_PAYMENTS)
  if (!summary) return undefined
  const body = text.slice(0, summary.index)
  if (looksLikeQuestion(body) || (!/\bbrut[oa]s?\b/i.test(body) && !new RegExp(OPERATING_COST, 'i').test(body))) return undefined
  const items = movements(body, today, true)
  if (!items.some(item => item.kind === 'in') || !items.some(item => item.kind === 'out')) return undefined
  const net = items.reduce((sum, { kind, amount }) => sum + (kind === 'in' ? 1 : -1) * cents(amount), 0)
  const reported = cents(parseMoney(summary[1]))
  return net === reported ? { text: body } : {
    issue: `As entradas menos os gastos informados dão ${fmtBRL(net / 100)}, e você disse que sobraram ${fmtBRL(reported / 100)}. Quais valores realmente entraram e saíram?`,
  }
}

/** Totais declarados e parcelas inclusas explicam os itens de um relato. */
export function reconcileSpokenTotals(message: string, today: string, driver: boolean, cardNames: string[]): ReconciledTotal | undefined {
  const text = normalizeNumberWords(message).text.trim()
  if (driver) {
    const result = reconcileDriverResult(text, today)
    if (result) return result
  }
  if (/\b(?:dos|das|de\s+um\s+total\s+de)\s+(?:r\$\s*)?\d/i.test(text)) {
    const parts = looksLikeQuestion(text) ? segment(text, today) : []
    const first = parts.length > 1 && !looksLikeQuestion(parts[0].text) ? parts[0] : undefined
    const partial = first ? partialSpokenPayment(first.text) : !parts.length ? partialSpokenPayment(text) : undefined
    if (partial?.text && first) return { text: `${partial.text.trimEnd()} ${text.slice(first.end).trimStart()}` }
    if (partial) return partial
  }
  if (!looksPast(message)) return undefined
  if (!looksLikeQuestion(text)) {
    const bills = linkedInvoicePayments(text, cardNames)
    if (bills) return bills
  }
  const credit = creditPurchaseTerms(text, today, cardNames)
  if (credit) return credit
  const split = splitSpokenPayment(text, today, cardNames)
  if (split) return split
  const included = text.match(INCLUDED)
  if (included) {
    const before = text.slice(0, included.index)
    const parent = looksLikeQuestion(before) ? undefined : movements(before, today, driver).slice(-1)[0]
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
