import type { AppState } from '../models/types'
import { cardInvoice } from '../services/cards'
import type { CardInvoice } from '../services/cards'
import { fmtBRL, fmtDateShort, fromISO, MESES_PT_BR, monthKey, toISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { isPlausibleDate } from './contracts'
import type { AssistantErrorCode } from './contracts'

const NOMES_DOS_MESES = MESES_PT_BR.map(m => m === 'março' ? 'mar[cç]o' : m).join('|')
const REFERENCIA = new RegExp(String.raw`\b(?:de|referente\s+(?:a(?:o\s+m[eê]s\s+de)?))\s+(?:(?<nome>${NOMES_DOS_MESES})(?:\s+de\s+(?<ano>\d{4}))?|(?<numerico>\d{1,2}[/-]\d{4}|\d{4}-\d{2}))(?![\wÀ-ú/-])|\b(?<relativo>(?:deste|desse)\s+m[eê]s|do\s+(?:pr[oó]ximo\s+m[eê]s|m[eê]s\s+(?:passado|anterior|retrasado|atual|que\s+vem)))\b`, 'gi')
const RELATO_DE_FATURA = /\b(?:paguei|pagamos|quitei|quitamos|antecipei|adiantei)\b/i
export const isInvoicePaymentStatement = (text: string): boolean => /\bfaturas?\b/i.test(text) && RELATO_DE_FATURA.test(text)

/** Retira só o mês de vencimento. O leitor de datas recebe a data do dinheiro à parte. */
export function readInvoiceReference(text: string, today: string): {
  paymentText: string; referenceMonth?: string; referenceQuestion?: string
} {
  if (!isInvoicePaymentStatement(text)) return { paymentText: text }
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
  state: AppState, invoice: CardInvoice, date: string, today: string, amount?: number,
): { code: AssistantErrorCode; detail: string } | undefined {
  if (amount === undefined) {
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
