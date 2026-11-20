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
import { actionSpec, errorMessage, isValidationFailure, validateAction } from '../assistant/contracts'
import type { AssistantCapabilities } from '../assistant/contracts'
import { editableFieldsFor } from '../assistant/proposalEdit'

// O rótulo vem do CATÁLOGO. Havia um mapa paralelo aqui e ele ficou para trás
// assim que uma ação nova entrou: o card mostrava "undo-batch" cru.
const kindLabel = (kind: string) => actionSpec(kind)?.label || kind

/** Ações sem campo que faça sentido editar à mão. */
const NAO_EDITAVEL = new Set(['undo-batch', 'reset'])

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
  proposal, categories, caps, onConfirmAll, onConfirmOne, onEdit, onRemove, onCancel,
}: {
  proposal: ProposedAction[]
  categories: Category[]
  caps: AssistantCapabilities
  onConfirmAll: () => void
  onConfirmOne: (id: string) => void
  onEdit: (id: string, action: ParsedAction) => void
  onRemove: (id: string) => void
  onCancel: () => void
}) {
  const [editing, setEditing] = useState<EditState | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const catName = (id: string) => categories.find(c => c.id === id)?.name || id

  const campos = editing ? editableFieldsFor(editing.action, caps) : []
  const setCampo = (name: string, value: unknown) => {
    setErro(null)
    setEditing(e => e && ({ ...e, action: { ...e.action, [name]: value } }))
  }

  const save = () => {
    if (!editing) return
    // MESMA validação do servidor e do motor local — nunca uma segunda regra
    // para o que o usuário digita à mão (regra 26). É isto que mantém a
    // barreira `future-date` valendo também depois de uma edição.
    const res = validateAction(editing.action, caps, todayISO())
    if (isValidationFailure(res)) {
      setErro(errorMessage(res.code, res.detail))
      return
    }
    onEdit(editing.id, res.action)
    setEditing(null)
    setErro(null)
  }

  const remainingCount = proposal.filter(p => !p.outcome?.ok).length
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
                  {i + 1}. {kindLabel(p.action.kind)}
                </div>
                {v !== undefined && <div className="mono-num">{fmtBRL(v)}</div>}
              </div>
              {/* Só some quando o item foi REALMENTE gravado. Com erro, o
                  usuário precisa poder corrigir e tentar de novo. */}
              {!p.outcome?.ok && (
                <div className="row" style={{ gap: 6 }}>
                  {!NAO_EDITAVEL.has(p.action.kind) && (
                    <button className="btn btn-soft btn-sm" onClick={() => setEditing({ id: p.id, action: { ...a } })}>Editar</button>
                  )}
                  <button className="btn btn-danger-soft btn-sm" onClick={() => onRemove(p.id)} aria-label="Remover">✕</button>
                </div>
              )}
            </div>

            <button className="link tiny" style={{ display: 'block', marginTop: 6 }} onClick={() => setOpen(o => ({ ...o, [p.id]: !isOpen }))}>
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
            {p.patternWarning && (
              <div className="tiny" style={{ marginTop: 6, color: 'var(--warning)' }}>⚠️ {p.patternWarning}</div>
            )}
            {p.outcome && (
              <div className="tiny" style={{ marginTop: 6, color: p.outcome.ok ? 'var(--success)' : 'var(--danger)' }}>
                {p.outcome.ok ? '✓ Registrado' : `✕ ${p.outcome.message}`}
              </div>
            )}
            {!p.outcome?.ok && remainingCount > 1 && (
              <button className="link tiny" style={{ display: 'block', marginTop: 6 }} onClick={() => onConfirmOne(p.id)}>
                Confirmar só este
              </button>
            )}
          </div>
        )
      })}

      {remainingCount > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={onConfirmAll}>
            {remainingCount > 1 ? `Confirmar ${remainingCount}` : 'Confirmar'}
          </button>
          <button className="btn btn-danger-soft btn-sm" onClick={onCancel}>Cancelar</button>
        </div>
      )}

      <Sheet open={!!editing} onClose={() => { setEditing(null); setErro(null) }} title="Editar lançamento">
        {editing && (
          <div className="stack" style={{ gap: 12 }}>
            {/* Os campos vêm do CATÁLOGO, na ordem dele. Campo ainda vazio
                também aparece: é assim que o usuário acrescenta a origem ou o
                prazo que o parser não pegou. */}
            {campos.map(f => {
              const v = (editing.action as any)[f.name]
              if (f.control === 'money') {
                return (
                  <label key={f.name} className="field"><span>{f.label}</span>
                    <MoneyInput value={v === undefined || v === null ? '' : String(v)}
                      onChange={val => setCampo(f.name, val === '' ? undefined : parseMoney(val))} />
                  </label>
                )
              }
              if (f.control === 'number') {
                return (
                  <label key={f.name} className="field"><span>{f.label}</span>
                    <input className="input" type="number" min={f.min} max={f.max} value={v ?? ''}
                      onChange={e => setCampo(f.name, e.target.value === '' ? undefined : Number(e.target.value))} />
                  </label>
                )
              }
              if (f.control === 'select') {
                return (
                  <label key={f.name} className="field"><span>{f.label}</span>
                    <select className="input" value={v ?? ''} onChange={e => setCampo(f.name, e.target.value || undefined)}>
                      <option value="">— não informado —</option>
                      {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                )
              }
              if (f.control === 'date') {
                return (
                  <label key={f.name} className="field">
                    <span>{f.label}{f.allowsFuture ? '' : ' (só o que já aconteceu)'}</span>
                    <input className="input" type="date" value={v || ''} max={f.allowsFuture ? undefined : todayISO()}
                      onChange={e => setCampo(f.name, e.target.value || undefined)} />
                  </label>
                )
              }
              if (f.control === 'flag') {
                return (
                  <label key={f.name} className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={!!v} onChange={e => setCampo(f.name, e.target.checked)} />
                    <span>{f.label}</span>
                  </label>
                )
              }
              return (
                <label key={f.name} className="field"><span>{f.label}</span>
                  <input className="input" maxLength={f.maxLength} value={v ?? ''}
                    onChange={e => setCampo(f.name, e.target.value || undefined)} />
                </label>
              )
            })}
            {erro && (
              <div className="tiny" role="alert" style={{ color: 'var(--danger)' }}>✕ {erro}</div>
            )}
            <button className="btn btn-primary" onClick={save}>Salvar alteração</button>
          </div>
        )}
      </Sheet>
    </div>
  )
}
