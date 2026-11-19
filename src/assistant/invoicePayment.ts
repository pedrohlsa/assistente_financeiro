import type { AppState } from '../models/types'
import type { CardInvoice } from '../services/cards'
import { fmtBRL, fmtDateShort } from '../utils/format'
import type { AssistantErrorCode } from './contracts'

/** A folha de pagamento manual tem confirmação específica para pagar acima do pendente. */
export function explicitInvoicePaymentIssue(
  state: AppState, invoice: CardInvoice, date: string, amount?: number,
): { code: AssistantErrorCode; detail: string } | undefined {
  if (amount === undefined) return undefined
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
