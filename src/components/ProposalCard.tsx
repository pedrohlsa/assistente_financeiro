// Revisão da proposta ANTES de registrar — um card por ação.
//
// Substitui o botão único "Confirmar" que era tudo-ou-nada: agora dá para
// confirmar tudo, confirmar/editar/remover uma ação isolada ou cancelar.
// Os campos usam a MESMA validação dos formulários manuais (`<MoneyInput>` +
// `parseMoney`), porque uma regra diferente para a IA seria uma segunda fonte
// de verdade.

import React, { useState } from 'react'
import type { Category, ParsedAction, ProposedAction } from '../models/types'
import { MoneyInput, Sheet } from './ui'
import { fmtBRL, parseMoney, todayISO } from '../utils/format'
import { sentenceCase } from '../utils/text'
import { dateLabel } from '../assistant/dates'
import { actionSpec } from '../assistant/contracts'

const KIND_LABEL: Record<string, string> = {
  income: 'Receita', expense: 'Despesa', saving: 'Guardar na reserva',
  work: 'Trabalho', fuel: 'Abastecimento', odometer: 'Hodômetro',
  maintenance: 'Manutenção', goal: 'Nova meta', 'goal-update': 'Alterar meta',
  'goal-deposit': 'Guardar na meta', balance: 'Saldo em conta',
  'card-purchase': 'Compra parcelada', 'financed-cash-inflow': 'Entrada financiada',
  'card-payment': 'Pagamento de fatura', 'card-charge': 'Assinatura',
  reset: 'Apagar todos os dados',
}

const primaryValue = (a: ParsedAction): number | undefined =>
  (a as any).amount ?? (a as any).total ?? (a as any).cost ?? (a as any).target ?? (a as any).value

/** Linhas de detalhe — só o que existe na ação, sem campo vazio poluindo. */
function detailRows(a: any, catName: (id: string) => string): [string, string][] {
  const rows: [string, string][] = []
  if (a.category) rows.push(['Categoria', sentenceCase(catName(a.category))])
  if (a.description) rows.push(['Descrição', sentenceCase(a.description)])
  if (a.origin) rows.push(['Origem', sentenceCase(a.origin)])
  if (a.cardName) rows.push(['Cartão', a.cardName])
  if (a.installments) rows.push(['Parcelas', `${a.installments}x de ${fmtBRL((a.total || 0) / a.installments)}`])
  if (a.netReceived !== undefined) rows.push(['Recebido agora', fmtBRL(a.netReceived)])
  if (a.total !== undefined && a.netReceived !== undefined) rows.push(['Custo da operação', fmtBRL(Math.max(a.total - a.netReceived, 0))])
  if (a.km) rows.push(['Km rodados', String(a.km)])
  if (a.trips) rows.push(['Viagens', String(a.trips)])
  if (a.hours) rows.push(['Horas', String(a.hours)])
  if (a.liters) rows.push(['Litros', String(a.liters)])
  if (a.odometer) rows.push(['Hodômetro', a.odometer.toLocaleString('pt-BR') + ' km'])
  if (a.item) rows.push(['Item', sentenceCase(a.item)])
  if (a.name) rows.push(['Meta', sentenceCase(a.name)])
  if (a.months) rows.push(['Prazo', `${Math.round(a.months)} meses`])
  if (a.firstDueDate) rows.push(['1º vencimento', a.firstDueDate.split('-').reverse().join('/')])
  rows.push(['Data', a.date ? sentenceCase(dateLabel(a.date)) : 'Hoje'])
  return rows
}

interface EditState { id: string; action: any }

export function ProposalCard({
  proposal, categories, cardNames, onConfirmAll, onConfirmOne, onEdit, onRemove, onCancel,
}: {
  proposal: ProposedAction[]
  categories: Category[]
  cardNames: string[]
  onConfirmAll: () => void
  onConfirmOne: (id: string) => void
  onEdit: (id: string, action: ParsedAction) => void
  onRemove: (id: string) => void
  onCancel: () => void
}) {
  const [editing, setEditing] = useState<EditState | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const catName = (id: string) => categories.find(c => c.id === id)?.name || id

  const spec = editing ? actionSpec(editing.action.kind) : undefined
  const editableCats = editing
    ? categories.filter(c => !c.archived && c.type === (spec?.fields.find(f => f.name === 'category')?.categoryOf || 'expense'))
    : []

  const save = () => {
    if (!editing) return
    onEdit(editing.id, editing.action as ParsedAction)
    setEditing(null)
  }

  return (
    <div className="stack" style={{ gap: 8, marginTop: 10 }}>
      {proposal.map((p, i) => {
        const a: any = p.action
        const v = primaryValue(p.action)
        const rows = detailRows(a, catName)
        const isOpen = !!open[p.id]
        return (
          <div key={p.id} className="card" style={{ padding: 10, borderColor: p.outcome && !p.outcome.ok ? 'var(--danger)' : undefined }}>
            <div className="spread">
              <div>
                <div className="small" style={{ fontWeight: 600 }}>
                  {i + 1}. {KIND_LABEL[p.action.kind] || p.action.kind}
                </div>
                {v !== undefined && <div className="mono-num">{fmtBRL(v)}</div>}
              </div>
              {!p.outcome && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-soft btn-sm" onClick={() => setEditing({ id: p.id, action: { ...a } })}>Editar</button>
                  <button className="btn btn-danger-soft btn-sm" onClick={() => onRemove(p.id)} aria-label="Remover">✕</button>
                </div>
              )}
            </div>

            <button className="link tiny" style={{ marginTop: 4 }} onClick={() => setOpen(o => ({ ...o, [p.id]: !isOpen }))}>
              {isOpen ? 'Ocultar detalhes' : 'Ver detalhes'}
            </button>
            {isOpen && (
              <div className="stack tiny" style={{ gap: 2, marginTop: 6, opacity: 0.9 }}>
                {rows.map(([k, val]) => (
                  <div key={k} className="spread"><span className="muted">{k}</span><span>{val}</span></div>
                ))}
              </div>
            )}

            {p.duplicateWarning && (
              <div className="tiny" style={{ marginTop: 6, color: 'var(--warning)' }}>⚠️ {p.duplicateWarning}</div>
            )}
            {p.outcome && (
              <div className="tiny" style={{ marginTop: 6, color: p.outcome.ok ? 'var(--success)' : 'var(--danger)' }}>
                {p.outcome.ok ? '✓ Registrado' : `✕ ${p.outcome.message}`}
              </div>
            )}
            {!p.outcome && proposal.length > 1 && (
              <button className="link tiny" style={{ marginTop: 6 }} onClick={() => onConfirmOne(p.id)}>
                Confirmar só este
              </button>
            )}
          </div>
        )
      })}

      {proposal.some(p => !p.outcome) && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={onConfirmAll}>
            {proposal.length > 1 ? `Confirmar ${proposal.length}` : 'Confirmar'}
          </button>
          <button className="btn btn-danger-soft btn-sm" onClick={onCancel}>Cancelar</button>
        </div>
      )}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title="Editar lançamento">
        {editing && (
          <div className="stack" style={{ gap: 12 }}>
            {['amount', 'total', 'cost', 'target', 'netReceived'].filter(f => editing.action[f] !== undefined).map(f => (
              <label key={f} className="field">
                <span>{f === 'netReceived' ? 'Recebido agora' : 'Valor'}</span>
                <MoneyInput
                  value={String(editing.action[f] ?? '')}
                  onChange={val => setEditing(e => e && ({ ...e, action: { ...e.action, [f]: parseMoney(val) } }))}
                />
              </label>
            ))}
            {editing.action.description !== undefined && (
              <label className="field"><span>Descrição</span>
                <input value={editing.action.description || ''}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, description: e.target.value } }))} />
              </label>
            )}
            {editing.action.origin !== undefined && (
              <label className="field"><span>Origem</span>
                <input value={editing.action.origin || ''}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, origin: e.target.value } }))} />
              </label>
            )}
            {editing.action.category !== undefined && (
              <label className="field"><span>Categoria</span>
                <select value={editing.action.category || ''}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, category: e.target.value } }))}>
                  {editableCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            {cardNames.length > 0 && editing.action.cardName !== undefined && (
              <label className="field"><span>Cartão</span>
                <select value={editing.action.cardName || ''}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, cardName: e.target.value } }))}>
                  {cardNames.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            {editing.action.installments !== undefined && (
              <label className="field"><span>Parcelas</span>
                <input type="number" min={1} max={120} value={editing.action.installments || 1}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, installments: Math.max(1, Number(e.target.value) || 1) } }))} />
              </label>
            )}
            {['km', 'trips', 'hours', 'liters', 'odometer'].filter(f => editing.action[f] !== undefined).map(f => (
              <label key={f} className="field">
                <span>{f === 'km' ? 'Km rodados' : f === 'trips' ? 'Viagens' : f === 'hours' ? 'Horas' : f === 'liters' ? 'Litros' : 'Hodômetro'}</span>
                <input type="number" value={editing.action[f] ?? ''}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, [f]: Number(e.target.value) } }))} />
              </label>
            ))}
            {actionSpec(editing.action.kind)?.fields.some(f => f.name === 'date') && (
              <label className="field"><span>Data</span>
                <input type="date" value={editing.action.date || todayISO()}
                  onChange={e => setEditing(s => s && ({ ...s, action: { ...s.action, date: e.target.value } }))} />
              </label>
            )}
            <button className="btn btn-primary" onClick={save}>Salvar alteração</button>
          </div>
        )}
      </Sheet>
    </div>
  )
}
