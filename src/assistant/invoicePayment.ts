import type { AppState, CreditCard, ParsedAction } from '../models/types'
import { cardInvoice, currentInvoice, futureInvoicePaymentDate, invoiceOpenAmount, unpaidPriorInvoiceMonths } from '../services/cards'
import type { CardInvoice } from '../services/cards'
import { fmtBRL, fmtDateShort, fromISO, MESES_PT_BR, monthKey, toISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { isPlausibleDate } from './contracts'
import type { AssistantCandidateAction, AssistantClarification, AssistantClarificationOption, AssistantErrorCode } from './contracts'

type InvoicePayment = Extract<ParsedAction, { kind: 'card-payment' }>

const NOMES_DOS_MESES = MESES_PT_BR.map(m => m === 'março' ? 'mar[cç]o' : m).join('|')
const REFERENCIA = new RegExp(String.raw`\b(?:de|referente\s+(?:a(?:o\s+m[eê]s\s+de)?))\s+(?:(?<nome>${NOMES_DOS_MESES})(?:\s+de\s+(?<ano>\d{4}))?|(?<numerico>\d{1,2}[/-]\d{4}|\d{4}-\d{2}))(?![\wÀ-ú/-])|\b(?<relativo>(?:deste|desse)\s+m[eê]s|do\s+(?:pr[oó]ximo\s+m[eê]s|m[eê]s\s+(?:passado|anterior|retrasado|atual|que\s+vem)))\b`, 'gi')
const RELATO_DE_FATURA = /\b(?:paguei|pagamos|quitei|quitamos|antecipei|adiantei)\b/i
export const isInvoicePaymentStatement = (text: string): boolean => /\bfaturas?\b/i.test(text) && RELATO_DE_FATURA.test(text)

/** Retira só o mês de vencimento. O leitor de datas recebe a data do dinheiro à parte. */
export function readInvoiceReference(text: string, today: string, paymentHistory = false): {
  paymentText: string; referenceMonth?: string; referenceQuestion?: string
} {
  if (!paymentHistory && !isInvoicePaymentStatement(text)) return { paymentText: text }
  const d = fromISO(today)
  const matches = [...text.matchAll(REFERENCIA)].filter(m => {
    // "dia 10 do mês passado" é um dia do pagamento, mesmo se houver fatura.
    const before = text.slice(0, m.index)
    return !/\b(?:dia\s+)?\d{1,2}\s*$/i.test(before)
  })
  if (!matches.length) return { paymentText: text }

  const months = new Set(matches.map(m => {
    const { nome, ano, numerico, relativo } = m.groups!
    if (relativo) {
      const rel = normalizeName(relativo)
      const offset = /retrasado/.test(rel) ? -2 : /passado|anterior/.test(rel) ? -1 : /proximo|que vem/.test(rel) ? 1 : 0
      return monthKey(toISO(new Date(d.getFullYear(), d.getMonth() + offset, 1)))
    }
    if (numerico) {
      const [a, b] = numerico.split(/[/-]/)
      return a.length === 4 ? `${a}-${b}` : `${b}-${a.padStart(2, '0')}`
    }
    const mes = MESES_PT_BR.findIndex(x => normalizeName(x) === normalizeName(nome))
    const antecipou = /\b(?:antecipei|adiantei)\b/i.test(text)
    const year = ano ? Number(ano) : d.getFullYear() + (antecipou ? Number(mes < d.getMonth()) : -Number(mes > d.getMonth()))
    return `${year}-${String(mes + 1).padStart(2, '0')}`
  }))
  const [reference] = months
  let paymentText = text
  for (const m of matches.reverse()) paymentText = `${paymentText.slice(0, m.index)} ${paymentText.slice((m.index ?? 0) + m[0].length)}`
  if (months.size > 1 || !isPlausibleDate(`${reference}-01`, today)) {
    return { paymentText, referenceQuestion: 'Qual foi o mês e o ano de vencimento da fatura que você pagou?' }
  }
  return { paymentText, referenceMonth: reference }
}

/** A folha de pagamento manual tem confirmação específica para pagar acima do pendente. */
export function invoicePaymentIssue(
  state: AppState, invoice: CardInvoice, date: string, today: string, { amount, expectedPending }: InvoicePayment,
): { code: AssistantErrorCode; detail: string } | undefined {
  if (amount === undefined) {
    if (expectedPending !== undefined && Math.abs(invoice.pending - expectedPending) > 0.009) return {
      code: 'invoice-conflict',
      detail: `O pendente da fatura do ${invoice.card.name} mudou de ${fmtBRL(expectedPending)} para ${fmtBRL(invoice.pending)}. Informe o valor que você pagou.`,
    }
    if (date < today && (date <= invoice.closingDate || invoice.paid !== cardInvoice(state, invoice.card, invoice.monthKey, date).paid)) {
      return { code: 'missing-field', detail: `Qual foi o valor pago em ${fmtDateShort(date)} pela fatura do ${invoice.card.name}?` }
    }
    return undefined
  }
  if (!(Number.isFinite(amount) && amount > 0)) return { code: 'invalid-amount', detail: invoice.card.name }
  const repeated = (state.cardPayments || []).some(p => p.cardId === invoice.card.id
    && p.referenceMonth === invoice.monthKey && p.paymentDate === date && Math.abs(p.amount - amount) < 0.005)
  if (repeated) return { code: 'duplicate',
    detail: `Já existe um pagamento de ${fmtBRL(amount)} em ${fmtDateShort(date)} para a mesma fatura do ${invoice.card.name}. Confira os pagamentos do cartão se forem transferências separadas.` }
  if (invoice.pending > 0.009 && amount > invoice.pending + 0.009) {
    return { code: 'invoice-conflict',
      detail: `O valor informado de ${fmtBRL(amount)} supera os ${fmtBRL(invoice.pending)} pendentes no ${invoice.card.name}. Confira o valor na tela de Cartões e parcelamentos.` }
  }
  return undefined
}

export function findInvoicePaymentCards(state: AppState, action: InvoicePayment): CreditCard[] {
  const cards = (state.cards || []).filter(card => !card.archived)
  const name = normalizeName(action.cardName)
  if (action.cardId) return cards.filter(card => card.id === action.cardId && (!name || normalizeName(card.name) === name))
  if (!name) return cards
  const exact = cards.filter(card => normalizeName(card.name) === name)
  if (exact.length) return exact
  return cards.filter(card => {
    const cardName = normalizeName(card.name)
    return cardName.includes(name) || (cardName && name.includes(cardName)) || normalizeName(card.institution).includes(name)
  })
}

function invoiceChoice(cards: CreditCard[], invoices: CardInvoice[], action: InvoicePayment, date: string): AssistantClarification {
  const question = cards.length === 1
    ? `Qual foi o mês de vencimento da fatura do ${cards[0].name}?`
    : 'Em qual cartão e mês de vencimento foi o pagamento?'
  const options = invoices.map(({ card, monthKey: month, pending }) => {
    const name = card.lastFourDigits ? `${card.name} (final ${card.lastFourDigits})`
      : cards.some(other => other.id !== card.id && normalizeName(other.name) === normalizeName(card.name))
        ? `${card.name} (vence dia ${card.dueDay})` : card.name
    const label = `${name} · ${month.slice(5)}/${month.slice(0, 4)} · ${fmtBRL(pending)} pendentes`
    return {
      label, value: `fatura:${card.id}:${month}`,
      actions: [{ ...action, cardId: card.id, cardName: card.name, referenceMonth: month, date, expectedPending: pending }],
    }
  })
  // Extratos de cartões com nomes, vencimentos e saldos iguais precisam de um
  // identificador visível para que a pessoa consiga distingui-los.
  const labels = options.map(o => o.label)
  const identifiable = options.filter(o => labels.indexOf(o.label) === labels.lastIndexOf(o.label))
  return {
    field: 'invoice-reference', options: identifiable,
    question: identifiable.length < options.length
      ? `${question} Diferencie os cartões com o mesmo nome na tela de Cartões e parcelamentos.` : question,
  }
}

/** Só seleciona uma opção única. Uma correção de valor ou data exige uma frase completa. */
export function matchInvoiceChoice(options: AssistantClarificationOption[], message: string): AssistantClarificationOption | undefined {
  const answer = normalizeName(message).replace(/[.!?]+$/g, '').trim()
  const exact = options.find(o => o.value === message.trim() || normalizeName(o.label) === answer)
  if (exact) return exact
  const matches = options.filter(o => {
    const action = o.actions?.[0]
    if (action?.kind !== 'card-payment' || !action.referenceMonth) return false
    const [year, month] = action.referenceMonth.split('-')
    const monthName = normalizeName(MESES_PT_BR[Number(month) - 1])
    const said = answer.replace(/^(?:a\s+)?(?:fatura\s+)?(?:d[eo]\s+)?(?:mes\s+de\s+)?/, '')
    return [action.referenceMonth, `${month}/${year}`, `${Number(month)}/${year}`, monthName,
      `${monthName} de ${year}`, normalizeName(action.cardName)].includes(said)
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function prepareInvoicePayments(state: AppState, candidates: AssistantCandidateAction[], today: string) {
  const notes = new Set<string>()
  const choices: AssistantClarification[] = []
  const seen = new Set<string>()
  const current = monthKey(today)
  const actions = candidates.flatMap(candidate => {
    const { action } = candidate
    if (action.kind !== 'card-payment') return [candidate]
    const cards = findInvoicePaymentCards(state, action)
    if (!cards.length) {
      notes.add(action.cardId
        ? 'O cartão escolhido foi alterado ou arquivado. Informe novamente o cartão e o mês de vencimento.'
        : action.cardName ? `Não encontrei um cartão chamado "${action.cardName}". Confira o nome em Cartões e parcelamentos.`
          : 'Cadastre um cartão em Cartões e parcelamentos antes de registrar o pagamento.')
      return []
    }

    const paidOn = action.date || today
    const target = action.referenceMonth || current
    const earlier = action.referenceMonth ? [] : unpaidPriorInvoiceMonths(state, cards[0], current, today)
    const displayed = currentInvoice(state, cards[0], today)
    const nextShown = displayed.monthKey !== current && invoiceOpenAmount(state, displayed, today) > 0.009
    const needsChoice = cards.length > 1 || (!action.referenceMonth && (monthKey(paidOn) !== current || earlier.length > 0 || nextShown))
    if (needsChoice) {
      const invoices = cards.flatMap(card => {
        const upcoming = card === cards[0] ? displayed : currentInvoice(state, card, today)
        const older = card === cards[0] ? earlier : unpaidPriorInvoiceMonths(state, card, current, today)
        const months = action.referenceMonth ? [target] : [...new Set([current, ...older, upcoming.monthKey])]
        return months.map(month => month === upcoming.monthKey ? upcoming : cardInvoice(state, card, month, today))
          .filter(invoice => invoiceOpenAmount(state, invoice, today) > 0.009)
      })
      const choice = invoiceChoice(cards, invoices, action, paidOn)
      if (choice.options?.length) choices.push(choice)
      else notes.add(`${choice.question} Informe o cartão, o mês e o ano para eu preparar o pagamento.`)
      return []
    }

    const card = cards[0]
    const invoice = cardInvoice(state, card, target, today)
    if (futureInvoicePaymentDate(state, card, target, today)) {
      notes.add(`Já existe um pagamento com data futura para essa fatura do ${card.name}. Confira o registro na tela de Cartões e parcelamentos.`)
      return []
    }
    const issue = invoicePaymentIssue(state, invoice, paidOn, today, action)
    if (issue) {
      notes.add(issue.detail)
      return []
    }
    const open = invoiceOpenAmount(state, invoice, today)
    if (open <= 0.009) {
      notes.add(`Não há valor pendente na fatura do ${card.name} com vencimento em ${target.slice(5)}/${target.slice(0, 4)}. Confira o mês em Cartões e parcelamentos.`)
      return []
    }
    if (open < invoice.pending - 0.009) {
      notes.add(`A fatura do ${card.name} tem parcelas antigas sem comprovação de pagamento. Confira os registros em Cartões e parcelamentos.`)
      return []
    }
    const key = JSON.stringify([card.id, target, paidOn, action.amount ?? invoice.pending])
    if (seen.has(key)) {
      notes.add(`O mesmo pagamento da fatura do ${card.name} aparece duas vezes. Compare com o extrato se foram transferências separadas.`)
      return []
    }
    seen.add(key)
    return [{ ...candidate, action: { ...action, cardId: card.id, cardName: card.name, date: paidOn,
      referenceMonth: target, expectedPending: invoice.pending,
    } }]
  })
  const unique = [...new Map(choices.map(c => [JSON.stringify(c.options), c])).values()]
  if (unique.length > 1) {
    notes.add('Você citou mais de um pagamento de fatura. Informe cada pagamento com o cartão e o mês de vencimento.')
  }
  return { actions, notes: [...notes], clarification: unique.length === 1 ? unique[0] : undefined }
}
