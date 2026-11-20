// Confirmação de entradas/contas recorrentes (14.2).
// Nada é lançado automaticamente: o app pergunta e só registra após confirmação.
import React, { useMemo, useState } from 'react'
import { confirmRecurringPayment, useStore } from '../store/store'
import { pendingRecurrings, possibleRecurringTransactions, recurringLinkAction } from '../services/calc'
import { addDays, dueLabel, fmtBRL, fmtDateShort, fromISO, parseMoney, todayISO } from '../utils/format'
import type { ParsedAction } from '../models/types'
import { sentenceCase } from '../utils/text'
import { MoneyInput, useToast } from './ui'

const longDate = (iso: string) =>
  fromISO(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })

export default function PendingRecurrings() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [expanded, setExpanded] = useState<{ key: string; field: 'amount' | 'links' } | null>(null)
  const [valueInput, setValueInput] = useState('')

  const today = todayISO()
  const pendings = useMemo(() => pendingRecurrings(state, today).map(p => ({
    ...p, matches: possibleRecurringTransactions(state, p.rec, p.dueDate, today),
  })), [state, today])
  if (!pendings.length) return null

  const confirmar = (action: Extract<ParsedAction, { kind: 'recurring-confirm' }>, kind: 'income' | 'expense') => {
    const result = confirmRecurringPayment(dispatch, state, action)
    if (result.ok === false) { toast({ text: result.message }); return }
    setExpanded(null)
    const confirmation = kind === 'income' ? 'Recebimento confirmado.' : 'Pagamento confirmado.'
    toast({ text: action.transactionId ? 'Lançamento vinculado à conta fixa.'
      : action.amount === undefined ? confirmation : `${fmtBRL(action.amount)} ${kind === 'income' ? 'recebidos' : 'pagos'}.` })
  }

  const adiar = (recId: string) => {
    dispatch({ type: 'updateRecurring', id: recId, patch: { snoozeUntil: addDays(todayISO(), 1) } })
    toast({ text: 'Ok, pergunto de novo amanhã.' })
  }

  const naoRecebi = (recId: string, occurrenceDate: string, kind: 'income' | 'expense') => {
    dispatch({ type: 'resolveOccurrence', recurringId: recId, occurrence: { date: occurrenceDate, status: 'skipped' } })
    toast({ text: kind === 'income' ? 'Marcado como não recebido nesta ocorrência.' : 'Marcado como não pago nesta ocorrência.' })
  }

  return (
    <>
      {pendings.map(p => {
        const isIncome = p.kind === 'income'
        const key = p.rec.id + p.dueDate
        const open = expanded?.key === key ? expanded.field : undefined
        const alreadyEntered = p.matches.length > 0
        const registrar = (amount: number) => confirmar({ kind: 'recurring-confirm', recurringId: p.rec.id,
          occurrenceDate: p.dueDate, amount, ...(alreadyEntered ? { newPaymentConfirmed: true } : {}) }, p.kind)
        return (
          <div key={key} className="card" style={{ borderColor: 'var(--warning)', borderWidth: 1.5 }}>
            <h3>
              {isIncome ? 'Entrada prevista' : 'Conta prevista'}: {p.rec.name}
              {p.rec.origin ? ` — ${p.rec.origin}` : ''}
            </h3>
            <p className="small muted" style={{ margin: '6px 0 12px' }}>
              {/* Nunca escrever "vence hoje" para uma data passada: o texto sai
                  da data REAL da ocorrência (item 32). */}
              {isIncome
                ? p.inDays === 0
                  ? `${sentenceCase(p.rec.name)} de ${fmtBRL(p.rec.amount)}, previsto para hoje, foi recebido?`
                  : `${sentenceCase(p.rec.name)} de ${fmtBRL(p.rec.amount)} era previsto para ${longDate(p.dueDate)}. Já foi recebido?`
                : p.inDays === 0
                  ? `A conta ${sentenceCase(p.rec.name)}, de ${fmtBRL(p.rec.amount)}, vence hoje. Ela foi paga?`
                  : `A conta ${sentenceCase(p.rec.name)}, de ${fmtBRL(p.rec.amount)}, venceu em ${longDate(p.dueDate)}. Ela foi paga?`}
            </p>
            <p className="tiny" style={{ margin: '-6px 0 12px' }}>{dueLabel(p.inDays, p.kind)}</p>

            {p.futurePaymentDate ? (
              <p className="small">O lançamento vinculado tem data futura ({fmtDateShort(p.futurePaymentDate)}). Confira a data em Movimentações.</p>
            ) : open === 'links' ? (
              <div className="stack">
                <p className="small">Qual lançamento já registrado corresponde a este vencimento?</p>
                {p.matches.map(t => (
                  <div key={t.id} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <span className="small">
                      {sentenceCase(t.description)}{t.origin ? ` · ${t.origin}` : ''} · {fmtDateShort(t.date)}
                      {t.time ? ` às ${t.time.slice(0, 5)}` : ''} · {fmtBRL(t.amount)}
                    </span>
                    <button className="btn btn-primary btn-sm" onClick={() => confirmar(recurringLinkAction(p.rec, p.dueDate, t), p.kind)}>Vincular</button>
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(null)}>Voltar</button>
              </div>
            ) : open === 'amount' ? (
              <div className="stack">
                <div className="field">
                  <label>{alreadyEntered ? 'Valor do novo lançamento (R$)' : 'Valor real (R$)'}</label>
                  <MoneyInput
                    autoFocus value={valueInput} onChange={setValueInput}
                    onKeyDown={e => e.key === 'Enter' && registrar(parseMoney(valueInput) || p.rec.amount)}
                  />
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => registrar(parseMoney(valueInput) || p.rec.amount)}>Salvar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(null)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <div className="suggestion-row">
                {alreadyEntered && <button className="chip active" onClick={() => setExpanded({ key, field: 'links' })}>Vincular lançamento existente</button>}
                <button className={alreadyEntered ? 'chip' : 'chip active'} onClick={() => registrar(p.rec.amount)}>
                  {alreadyEntered ? (isIncome ? 'Registrar outro recebimento' : 'Registrar outro pagamento')
                    : (isIncome ? 'Confirmar recebimento' : 'Confirmar pagamento')}
                </button>
                <button className="chip" onClick={() => { setExpanded({ key, field: 'amount' }); setValueInput(String(p.rec.amount)) }}>Alterar valor</button>
                <button className="chip" onClick={() => adiar(p.rec.id)}>Adiar</button>
                <button className="chip" onClick={() => naoRecebi(p.rec.id, p.dueDate, p.kind)}>{isIncome ? 'Não recebi' : 'Não paguei'}</button>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
