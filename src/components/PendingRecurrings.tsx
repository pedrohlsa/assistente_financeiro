// Confirmação de entradas/contas recorrentes (14.2).
// Nada é lançado automaticamente: o app pergunta e só registra após confirmação.
import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'
import { pendingRecurrings } from '../services/calc'
import { addDays, dueLabel, fmtBRL, fromISO, nowPaymentTime, parseMoney, todayISO, uid } from '../utils/format'
import { sentenceCase } from '../utils/text'
import { MoneyInput, useToast } from './ui'

const longDate = (iso: string) =>
  fromISO(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })

export default function PendingRecurrings() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [valueInput, setValueInput] = useState('')

  const pendings = useMemo(() => pendingRecurrings(state), [state])
  if (!pendings.length) return null

  /**
   * Confirmar cria a movimentação REALIZADA (que é o que move o saldo) e marca a
   * ocorrência daquela data exata como resolvida — a chave recurringId+date é o
   * que impede confirmar duas vezes o mesmo período.
   */
  const confirmar = (recId: string, occurrenceDate: string, kind: 'income' | 'expense', amount: number) => {
    const rec = state.recurring.find(r => r.id === recId)
    if (!rec) return
    const txId = uid()
    dispatch({
      type: 'addTx',
      tx: {
        id: txId, type: kind, amount, category: rec.category,
        description: rec.name, origin: rec.origin,
        date: todayISO(), time: nowPaymentTime(), source: 'recurring',
        recurringId: rec.id, occurrenceDate, profileAtCreation: state.settings.profile,
      },
    })
    dispatch({ type: 'resolveOccurrence', recurringId: recId, occurrence: { date: occurrenceDate, status: 'confirmed', txId, amount } })
    setEditingId(null)
    toast({ text: kind === 'income' ? `${fmtBRL(amount)} recebidos.` : `${fmtBRL(amount)} pagos.` })
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
        const editing = editingId === p.rec.id + p.dueDate
        return (
          <div key={p.rec.id + p.dueDate} className="card" style={{ borderColor: 'var(--warning)', borderWidth: 1.5 }}>
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

            {editing ? (
              <div className="stack">
                <div className="field">
                  <label>Valor real (R$)</label>
                  <MoneyInput
                    autoFocus value={valueInput} onChange={setValueInput}
                    onKeyDown={e => e.key === 'Enter' && confirmar(p.rec.id, p.dueDate, p.kind, parseMoney(valueInput) || p.rec.amount)}
                  />
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => confirmar(p.rec.id, p.dueDate, p.kind, parseMoney(valueInput) || p.rec.amount)}>Salvar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancelar</button>
                </div>
              </div>
            ) : (
              <div className="suggestion-row">
                <button className="chip active" onClick={() => confirmar(p.rec.id, p.dueDate, p.kind, p.rec.amount)}>
                  {isIncome ? 'Confirmar recebimento' : 'Confirmar pagamento'}
                </button>
                <button className="chip" onClick={() => { setEditingId(p.rec.id + p.dueDate); setValueInput(String(p.rec.amount)) }}>Alterar valor</button>
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
