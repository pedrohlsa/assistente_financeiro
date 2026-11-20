// Cartões e Parcelamentos — visão geral, cartões, parcelamentos e projeções.
// Regra central: a compra vira dívida parcelada (InstallmentPlan) e só as
// PARCELAS entram no fluxo mensal. Pagar a fatura quita a dívida sem gerar
// despesa nova — ver services/cards.ts.
import React, { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reducer, useStore } from '../store/store'
import { CreditCard, Installment, InstallmentPlan } from '../models/types'
import { fmtBRL, fmtDateShort, isCalendarDate, nowPaymentTime, todayISO, toISO, fromISO, parseMoney, uid } from '../utils/format'
import { ConfirmDialog, EmptyState, Progress, Sheet, useToast } from '../components/ui'
import {
  CardChargeForm, CardForm, CardPaymentForm, FinancedInflowForm, PurchaseForm, StandalonePlanForm,
} from '../components/cardForms'
import {
  canPayInstallment, cardInvoice, cardLimits, cardsOverview, checkPlanRemoval, commitmentTimeline, currentInvoice,
  planProgress, upcomingInvoices, planInstallments, splitInstallmentAmounts, installmentLinkedToCardPayment, installmentRemaining,
  futureInstallmentPaymentDate, futureInstallmentsToCancel, validPaymentDate,
} from '../services/cards'
import { monthlyProjections, hasProjectionData } from '../services/calc'
import { catById } from '../data/categories'
import { isDriver } from '../services/profile'

type Tab = 'overview' | 'cards' | 'plans' | 'projections'

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'cards', label: 'Cartões' },
  { id: 'plans', label: 'Parcelamentos' },
  { id: 'projections', label: 'Projeções' },
]

const INVOICE_BADGE: Record<string, { label: string; cls: string }> = {
  aberta: { label: 'Aberta', cls: 'neutral' },
  fechada: { label: 'Fechada', cls: 'warn' },
  paga: { label: 'Paga', cls: 'pos' },
  parcial: { label: 'Parcialmente paga', cls: 'warn' },
  atrasada: { label: 'Atrasada', cls: 'neg' },
}

export default function Cards() {
  const { state } = useStore()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [cardOpen, setCardOpen] = useState(false)
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [financedOpen, setFinancedOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [chargeOpen, setChargeOpen] = useState(false)

  const ov = useMemo(() => cardsOverview(state), [state])

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Cartões e parcelamentos</h1>
      </div>

      <div className="chips" style={{ marginBottom: 14 }}>
        {TABS.map(t => (
          <button key={t.id} className={`chip ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview ov={ov} onAddCard={() => setCardOpen(true)} onAddPurchase={() => setPurchaseOpen(true)} onAddFinanced={() => setFinancedOpen(true)} onAddPlan={() => setPlanOpen(true)} onSeePlans={() => setTab('plans')} />}
      {tab === 'cards' && <CardsTab onAddCard={() => setCardOpen(true)} onAddPurchase={() => setPurchaseOpen(true)} onAddCharge={() => setChargeOpen(true)} />}
      {tab === 'plans' && <PlansTab ov={ov} onAddPurchase={() => setPurchaseOpen(true)} onAddPlan={() => setPlanOpen(true)} />}
      {tab === 'projections' && <ProjectionsTab />}

      <Sheet open={cardOpen} onClose={() => setCardOpen(false)} title="Novo cartão"><CardForm onDone={() => setCardOpen(false)} /></Sheet>
      <Sheet open={purchaseOpen} onClose={() => setPurchaseOpen(false)} title="Compra no crédito"><PurchaseForm onDone={() => setPurchaseOpen(false)} /></Sheet>
      <Sheet open={financedOpen} onClose={() => setFinancedOpen(false)} title="Entrada financiada pelo cartão"><FinancedInflowForm onDone={() => setFinancedOpen(false)} /></Sheet>
      <Sheet open={planOpen} onClose={() => setPlanOpen(false)} title="Parcelamento sem cartão"><StandalonePlanForm onDone={() => setPlanOpen(false)} /></Sheet>
      <Sheet open={chargeOpen} onClose={() => setChargeOpen(false)} title="Assinatura no cartão"><CardChargeForm onDone={() => setChargeOpen(false)} /></Sheet>
    </div>
  )
}

// ---------------- VISÃO GERAL ----------------

function Overview({ ov, onAddCard, onAddPurchase, onAddFinanced, onAddPlan, onSeePlans }: {
  ov: ReturnType<typeof cardsOverview>
  onAddCard: () => void; onAddPurchase: () => void; onAddFinanced: () => void; onAddPlan: () => void; onSeePlans: () => void
}) {
  const { state } = useStore()
  const [showMath, setShowMath] = useState(false)
  const proj = useMemo(() => monthlyProjections(state, 2), [state])
  const thisMonth = proj[0]
  const driverMode = isDriver(state.settings)

  if (!ov.hasData) {
    return (
      <div className="card">
        <EmptyState
          emoji="💳"
          text="Cadastre seu primeiro cartão para acompanhar faturas e parcelas futuras."
          cta="Cadastrar cartão"
          onCta={onAddCard}
        />
        <button className="btn btn-soft btn-block" onClick={onAddPlan}>Registrar parcelamento sem cartão</button>
      </div>
    )
  }

  return (
    <>
      <div className="card">
        <h3 className="muted">Faturas em aberto</h3>
        <div className="big-number" style={{ fontSize: '1.9rem' }}>{fmtBRL(ov.openInvoicesTotal)}</div>
        <div className="tiny">a pagar agora · próximas faturas somam {fmtBRL(ov.nextInvoicesTotal)}</div>
        <div className="grid-3" style={{ margin: '16px 0 4px' }}>
          <div><div className="tiny">Parcelas deste mês</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(ov.installmentsThisMonth)}</div></div>
          <div><div className="tiny">Próximo mês</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(ov.installmentsNextMonth)}</div></div>
          <div><div className="tiny">Dívida parcelada</div><div className="mono-num amount-neg" style={{ fontWeight: 700 }}>{fmtBRL(ov.totalDebt)}</div></div>
        </div>
      </div>

      {/* PARCELAMENTOS ATIVOS — resumo rápido (seção 8.1) */}
      <div className="card tappable" onClick={onSeePlans}>
        <div className="spread">
          <h3>Parcelamentos ativos</h3>
          <span className="muted">›</span>
        </div>
        {ov.activePlanCount === 0 ? (
          <p className="small muted" style={{ marginTop: 6 }}>Você ainda não possui parcelamentos ativos.</p>
        ) : (
          <div className="stack small" style={{ marginTop: 8, gap: 4 }}>
            <div className="spread"><span className="muted">{ov.activePlanCount} parcelamento(s) ativo(s)</span></div>
            <div className="spread"><span className="muted">Ainda a pagar</span><span className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(ov.totalDebt)}</span></div>
            <div className="spread"><span className="muted">Vence neste mês</span><span className="mono-num">{fmtBRL(ov.installmentsThisMonth)}</span></div>
            {ov.overdueCount > 0 && (
              <div className="spread"><span style={{ color: 'var(--danger)' }}>{ov.overdueCount} parcela(s) atrasada(s)</span><span className="mono-num amount-neg">{fmtBRL(ov.overdueAmount)}</span></div>
            )}
          </div>
        )}
      </div>

      {/* LIMITES */}
      {ov.totalLimit > 0 && (
        <div className="card">
          <h3 className="muted">Limite dos cartões</h3>
          <div className="stack small" style={{ marginTop: 8, gap: 4 }}>
            <div className="spread"><span className="muted">Limite total</span><span className="mono-num">{fmtBRL(ov.totalLimit)}</span></div>
            <div className="spread"><span className="muted">Comprometido</span><span className="mono-num amount-neg">{fmtBRL(ov.usedLimit)}</span></div>
            <div className="spread" style={{ fontWeight: 700 }}><span>Disponível</span><span className="mono-num amount-pos">{fmtBRL(ov.availableLimit)}</span></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Progress pct={ov.totalLimit > 0 ? (ov.usedLimit / ov.totalLimit) * 100 : 0} tone={ov.usedLimit / ov.totalLimit >= 0.8 ? 'danger' : ov.usedLimit / ov.totalLimit >= 0.5 ? 'warn' : undefined} />
          </div>
        </div>
      )}

      {/* COMPROMETIMENTO DA RENDA (seção 14) */}
      {thisMonth && thisMonth.incomes > 0 && (
        <div className="card">
          <h3 className="muted">Comprometimento previsto do mês</h3>
          <div className="big-number" style={{ fontSize: '1.7rem' }}>{thisMonth.commitmentPct}%</div>
          <div className="tiny">das entradas previstas deste mês</div>
          <button className="link tiny" style={{ marginTop: 8 }} onClick={() => setShowMath(m => !m)}>
            {showMath ? 'Ocultar cálculo' : 'Como foi calculado?'}
          </button>
          {showMath && (
            <div className="stack tiny" style={{ marginTop: 8, gap: 3 }}>
              <div className="spread"><span>Contas recorrentes previstas</span><span className="mono-num">{fmtBRL(thisMonth.bills)}</span></div>
              <div className="spread"><span>+ Parcelas e assinaturas do mês</span><span className="mono-num">{fmtBRL(thisMonth.installments)}</span></div>
              <div className="spread" style={{ fontWeight: 700 }}><span>= Obrigações previstas</span><span className="mono-num">{fmtBRL(thisMonth.outflow)}</span></div>
              <div className="spread"><span>÷ Entradas previstas</span><span className="mono-num">{fmtBRL(thisMonth.incomes)}</span></div>
              <div className="spread" style={{ fontWeight: 700 }}><span>= Comprometimento</span><span className="mono-num">{thisMonth.commitmentPct}%</span></div>
              <p style={{ marginTop: 4 }}>
                Este percentual é uma projeção com base no que você cadastrou. Ele não é bom nem ruim
                por si só — depende dos seus planos e do seu momento.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="section-title"><h2>Registrar</h2></div>
      <div className="stack">
        <button className="btn btn-soft btn-block" onClick={onAddPurchase}>Compra no crédito</button>
        <button className="btn btn-soft btn-block" onClick={onAddPlan}>Parcelamento sem cartão</button>
        <button className="btn btn-soft btn-block" onClick={onAddCard}>Novo cartão</button>
        <button className="btn btn-soft btn-block" onClick={onAddFinanced}>Entrada financiada pelo cartão</button>
      </div>
      <p className="tiny" style={{ marginTop: 12 }}>
        {driverMode
          ? 'As parcelas entram nas suas obrigações mensais e já são consideradas na sua meta diária.'
          : 'As parcelas entram na projeção de quanto você poderá guardar nos próximos meses.'}
      </p>
    </>
  )
}

// ---------------- CARTÕES ----------------

function CardsTab({ onAddCard, onAddPurchase, onAddCharge }: { onAddCard: () => void; onAddPurchase: () => void; onAddCharge: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [editing, setEditing] = useState<CreditCard | null>(null)
  const [paying, setPaying] = useState<{ card: CreditCard; mk: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const cards = (state.cards || []).filter(c => showArchived || !c.archived)

  if ((state.cards || []).length === 0) {
    return (
      <div className="card">
        <EmptyState emoji="💳" text="Cadastre seu primeiro cartão para acompanhar faturas e parcelas futuras." cta="Cadastrar cartão" onCta={onAddCard} />
      </div>
    )
  }

  return (
    <>
      <div className="spread" style={{ marginBottom: 10 }}>
        <button className="link" onClick={onAddCard}>+ Novo cartão</button>
        <button className="link" onClick={() => setShowArchived(v => !v)}>
          {showArchived ? 'Ocultar arquivados' : 'Mostrar arquivados'}
        </button>
      </div>

      <div className="stack">
        {cards.map(card => {
          const inv = currentInvoice(state, card)
          const lim = cardLimits(state, card)
          const badge = INVOICE_BADGE[inv.status]
          const isOpen = expanded === card.id
          const future = isOpen ? upcomingInvoices(state, card, 6) : []
          return (
            <div key={card.id} className="card" style={{ borderLeft: `4px solid ${card.color || 'var(--accent)'}` }}>
              <div className="spread">
                <div>
                  <h3>{card.name}{card.lastFourDigits ? <span className="tiny"> ····{card.lastFourDigits}</span> : null}</h3>
                  <div className="tiny">
                    {card.institution ? `${card.institution} · ` : ''}fecha dia {card.closingDay} · vence dia {card.dueDay}
                    {card.archived ? ' · arquivado' : ''}
                  </div>
                </div>
                <span className={`badge ${badge.cls}`}>{badge.label}</span>
              </div>

              <div className="stack small" style={{ marginTop: 12, gap: 4 }}>
                <div className="spread"><span className="muted">Total previsto da fatura</span><span className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(inv.total)}</span></div>
                {inv.paid > 0 && <div className="spread"><span className="muted">Valor pago</span><span className="mono-num amount-pos">{fmtBRL(inv.paid)}</span></div>}
                <div className="spread"><span className="muted">Valor pendente</span><span className="mono-num amount-neg" style={{ fontWeight: 700 }}>{fmtBRL(inv.pending)}</span></div>
                <div className="spread"><span className="muted">Fechamento / vencimento</span><span className="tiny">{fmtDateShort(inv.closingDate)} · {fmtDateShort(inv.dueDate)}</span></div>
              </div>

              {lim.limit > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Progress pct={lim.pct} tone={lim.pct >= 80 ? 'danger' : lim.pct >= 50 ? 'warn' : undefined} />
                  <div className="spread" style={{ marginTop: 6 }}>
                    <span className="tiny">{fmtBRL(lim.used)} de {fmtBRL(lim.limit)} comprometido</span>
                    <span className="tiny" style={{ fontWeight: 650 }}>{fmtBRL(lim.available)} disponível</span>
                  </div>
                </div>
              )}

              <button className="link tiny" style={{ marginTop: 10 }} onClick={() => setExpanded(isOpen ? null : card.id)}>
                {isOpen ? 'Ocultar detalhes' : 'Ver compras e próximas faturas'}
              </button>

              {isOpen && (
                <>
                  <div className="divider" />
                  <p className="tiny" style={{ fontWeight: 650, marginBottom: 4 }}>Nesta fatura ({fmtDateShort(inv.dueDate)})</p>
                  {inv.items.length === 0 ? (
                    <p className="tiny">Nenhuma compra ou parcela nesta fatura.</p>
                  ) : inv.items.map((it, i) => (
                    <div key={i} className="row list-item">
                      <div className="grow">
                        <div className="small" style={{ fontWeight: 650 }}>{it.label}</div>
                        <div className="tiny">
                          {it.kind === 'installment' ? `parcela ${it.installmentNumber} de ${it.installmentTotal}` : it.kind === 'charge' ? 'assinatura' : 'saldo anterior'}
                        </div>
                      </div>
                      <span className="mono-num small">{fmtBRL(it.amount)}</span>
                    </div>
                  ))}

                  <p className="tiny" style={{ fontWeight: 650, margin: '12px 0 4px' }}>Próximas faturas</p>
                  {future.slice(1).map(f => (
                    <div key={f.monthKey} className="row list-item">
                      <div className="grow">
                        <div className="small">{fmtDateShort(f.dueDate)}</div>
                        <div className="tiny">{f.items.length} item(ns) · {INVOICE_BADGE[f.status].label.toLowerCase()}</div>
                      </div>
                      <span className="mono-num small">{fmtBRL(f.total)}</span>
                    </div>
                  ))}
                  {future.slice(1).every(f => f.total === 0) && <p className="tiny">Nenhuma parcela prevista para os próximos meses.</p>}
                </>
              )}

              <div className="suggestion-row" style={{ marginTop: 12 }}>
                {inv.pending > 0 && (
                  <button className="btn btn-primary btn-sm" onClick={() => setPaying({ card, mk: inv.monthKey })}>Pagar fatura</button>
                )}
                {!card.archived && <button className="btn btn-soft btn-sm" onClick={onAddPurchase}>Nova compra</button>}
                {!card.archived && <button className="btn btn-soft btn-sm" onClick={onAddCharge}>Assinatura</button>}
                <button className="btn btn-soft btn-sm" onClick={() => setEditing(card)}>Editar</button>
                <button className="btn btn-soft btn-sm" onClick={() => {
                  dispatch({ type: 'updateCard', id: card.id, patch: { archived: !card.archived } })
                  toast({ text: card.archived ? 'Cartão reativado.' : 'Cartão arquivado. O histórico e as parcelas futuras foram preservados.' })
                }}>{card.archived ? 'Reativar' : 'Arquivar'}</button>
              </div>
            </div>
          )
        })}
      </div>

      <ChargesList />

      <Sheet open={!!editing} onClose={() => setEditing(null)} title="Editar cartão">
        {editing && <CardForm card={editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet open={!!paying} onClose={() => setPaying(null)} title="Pagar fatura">
        {paying && <CardPaymentForm card={paying.card} referenceMonth={paying.mk} onDone={() => setPaying(null)} />}
      </Sheet>
    </>
  )
}

/** Assinaturas recorrentes — não são parcelamentos (não têm fim definido). */
function ChargesList() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const charges = (state.cardCharges || []).filter(c => !c.removedAt)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const removing = charges.find(c => c.id === removingId)
  if (!charges.length) return null
  return (
    <>
      <div className="section-title"><h2>Assinaturas no cartão</h2></div>
      <div className="card" style={{ padding: '4px 16px' }}>
        {charges.map(c => {
          const card = (state.cards || []).find(x => x.id === c.cardId)
          return (
            <div key={c.id} className="row list-item">
              <div className="grow">
                <div className="small" style={{ fontWeight: 650 }}>{c.description}</div>
                <div className="tiny">
                  {card?.name || 'cartão removido'} · {c.frequency === 'monthly' ? 'Mensal' : 'Anual'}
                  {c.active === false ? ' · pausada' : ''}
                  {c.endDate ? ` · até ${fmtDateShort(c.endDate)}` : ''}
                </div>
              </div>
              <span className="mono-num small">{fmtBRL(c.amount)}</span>
              <button className="link tiny" onClick={() => {
                dispatch({ type: 'updateCardCharge', id: c.id, patch: { active: c.active === false } })
                toast({ text: c.active === false ? 'Assinatura retomada.' : 'Assinatura pausada. As cobranças anteriores foram preservadas.' })
              }}>{c.active === false ? 'Retomar' : 'Pausar'}</button>
              <button className="link tiny" onClick={() => setRemovingId(c.id)}>Remover</button>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemovingId(null)}
        title={`Remover "${removing?.description || 'assinatura'}"?`}
        text="As cobranças já lançadas nas faturas anteriores continuarão no histórico."
        actions={[{
          label: 'Remover assinatura',
          tone: 'danger',
          onClick: () => {
            if (!removing) return
            dispatch({ type: 'removeCardCharge', id: removing.id })
            setRemovingId(null)
            toast({ text: 'Assinatura removida.' })
          },
        }]}
      />
    </>
  )
}

// ---------------- PARCELAMENTOS ----------------

type PlanFilter = 'all' | 'active' | 'settled' | 'overdue' | 'with-card' | 'without-card'
type PlanSort = 'next-due' | 'biggest' | 'smallest' | 'most-left' | 'recent'

const FILTERS: { id: PlanFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'active', label: 'Ativos' },
  { id: 'settled', label: 'Quitados' },
  { id: 'overdue', label: 'Atrasados' },
  { id: 'with-card', label: 'Com cartão' },
  { id: 'without-card', label: 'Sem cartão' },
]

const SORTS: { id: PlanSort; label: string }[] = [
  { id: 'next-due', label: 'Próximo vencimento' },
  { id: 'biggest', label: 'Maior saldo' },
  { id: 'smallest', label: 'Menor saldo' },
  { id: 'most-left', label: 'Mais parcelas faltando' },
  { id: 'recent', label: 'Mais recente' },
]

function PlansTab({ ov, onAddPurchase, onAddPlan }: { ov: ReturnType<typeof cardsOverview>; onAddPurchase: () => void; onAddPlan: () => void }) {
  const { state } = useStore()
  const [filter, setFilter] = useState<PlanFilter>('active')
  const [sort, setSort] = useState<PlanSort>('next-due')
  const [openPlan, setOpenPlan] = useState<string | null>(null)

  const plans = useMemo(() => {
    const all = (state.installmentPlans || []).map(p => planProgress(state, p))
    const filtered = all.filter(pp => {
      switch (filter) {
        case 'active': return pp.plan.status !== 'cancelled' && pp.remainingCount > 0
        case 'settled': return pp.plan.status !== 'cancelled' && pp.remainingCount === 0
        case 'overdue': return pp.plan.status !== 'cancelled' && pp.overdueCount > 0
        case 'with-card': return !!pp.plan.cardId
        case 'without-card': return !pp.plan.cardId
        default: return true
      }
    })
    return filtered.sort((a, b) => {
      switch (sort) {
        case 'biggest': return b.remainingAmount - a.remainingAmount
        case 'smallest': return a.remainingAmount - b.remainingAmount
        case 'most-left': return b.remainingCount - a.remainingCount
        case 'recent': return b.plan.createdAt.localeCompare(a.plan.createdAt)
        default: return (a.nextDueDate || '9999').localeCompare(b.nextDueDate || '9999')
      }
    })
  }, [state, filter, sort])

  if ((state.installmentPlans || []).length === 0) {
    return (
      <div className="card">
        <EmptyState emoji="🧾" text="Você ainda não possui parcelamentos ativos." cta="Registrar compra parcelada" onCta={onAddPurchase} />
        <button className="btn btn-soft btn-block" onClick={onAddPlan}>Parcelamento sem cartão</button>
      </div>
    )
  }

  return (
    <>
      {/* RESUMO DO TOPO (seção 8.1) */}
      <div className="card">
        <div className="stack small" style={{ gap: 4 }}>
          <div className="spread"><span className="muted">Parcelamentos ativos</span><span style={{ fontWeight: 700 }}>{ov.activePlanCount}</span></div>
          <div className="spread"><span className="muted">Dívida parcelada restante</span><span className="mono-num amount-neg" style={{ fontWeight: 700 }}>{fmtBRL(ov.totalDebt)}</span></div>
          <div className="spread"><span className="muted">Parcelas deste mês</span><span className="mono-num">{fmtBRL(ov.installmentsThisMonth)}</span></div>
          <div className="spread"><span className="muted">Previsto para o próximo mês</span><span className="mono-num">{fmtBRL(ov.installmentsNextMonth)}</span></div>
          {ov.overdueCount > 0 && (
            <div className="spread"><span style={{ color: 'var(--danger)' }}>Parcelas atrasadas</span><span className="mono-num amount-neg" style={{ fontWeight: 700 }}>{ov.overdueCount} · {fmtBRL(ov.overdueAmount)}</span></div>
          )}
        </div>
      </div>

      <div className="chips" style={{ margin: '12px 0 8px' }}>
        {FILTERS.map(f => <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>)}
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>Ordenar por</label>
        <select className="input" value={sort} onChange={e => setSort(e.target.value as PlanSort)}>
          {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {plans.length === 0 ? (
        <div className="card"><p className="small muted" style={{ margin: 0 }}>Nenhum parcelamento neste filtro.</p></div>
      ) : (
        <div className="stack">
          {plans.map(pp => (
            <PlanCard key={pp.plan.id} pp={pp} open={openPlan === pp.plan.id} onToggle={() => setOpenPlan(openPlan === pp.plan.id ? null : pp.plan.id)} />
          ))}
        </div>
      )}
    </>
  )
}

function PlanCard({ pp, open, onToggle }: { pp: ReturnType<typeof planProgress>; open: boolean; onToggle: () => void }) {
  const { state, dispatch } = useStore()
  const stateRef = useRef(state)
  stateRef.current = state
  const toast = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [legacyReceiptId, setLegacyReceiptId] = useState('')
  const [confirmAction, setConfirmAction] = useState<'settle' | 'cancel-future' | null>(null)
  const [partialId, setPartialId] = useState<string>()
  const plan = pp.plan
  const cat = plan.categoryId ? catById(state.categories, plan.categoryId) : undefined
  const t = todayISO()
  const futurePaid = pp.installments.some(i => !!futureInstallmentPaymentDate(state, i, t))
  const remaining = open ? pp.installments.filter(i => installmentRemaining(state, i, t) > 0) : []
  const payable = remaining.filter(i => canPayInstallment(state, i, t))
  const advanceable = payable.filter(i => i.dueDate > t && isCalendarDate(i.dueDate)).sort((a, b) => b.dueDate.localeCompare(a.dueDate))
  const partial = payable.find(i => i.id === partialId)
  const cancellable = open ? futureInstallmentsToCancel(state, plan, t).length : 0
  const removalStart = confirmDelete ? checkPlanRemoval(state, plan) : undefined
  const removal = confirmDelete && legacyReceiptId ? checkPlanRemoval(state, plan, legacyReceiptId) : removalStart
  const receipts = removalStart?.allowed === false ? removalStart.legacyOptions?.map(tx => ({
    id: tx.id, label: [fmtDateShort(tx.date), tx.time?.slice(0, 8), fmtBRL(tx.amount),
      tx.source === 'manual' ? 'Formulário' : tx.source === 'ai' ? 'Assistente' : undefined, tx.origin, tx.note].filter(Boolean).join(' · '),
  })) : undefined
  const identifiableReceipts = receipts?.filter(option => receipts.filter(other => other.label === option.label).length === 1)

  const statusLabel = plan.status === 'cancelled' ? 'Cancelado'
    : futurePaid ? 'Pagamento futuro'
    : pp.remainingCount === 0
      ? (pp.installments.some(i => i.status === 'cancelled') ? 'Encerrado' : 'Quitado')
    : pp.overdueCount > 0 ? 'Atrasado' : 'Ativo'
  const statusCls = statusLabel === 'Quitado' ? 'pos' : statusLabel === 'Atrasado' ? 'neg'
    : statusLabel === 'Cancelado' || statusLabel === 'Encerrado' ? 'neutral' : 'warn'

  const markPaid = (i: Installment) => {
    const paidAt = todayISO()
    const current = stateRef.current.installments.find(x => x.id === i.id)
    if (!current || !canPayInstallment(stateRef.current, current, paidAt)) return
    const firstPayment = installmentRemaining(stateRef.current, current, paidAt) === current.amount
    dispatch({ type: 'payInstallment', id: i.id, paidAt })
    const undo = firstPayment ? () => {
      const current = stateRef.current.installments.find(x => x.id === i.id)
      const event = current?.directPayments?.[0]
      if (!current || current.directPayments?.length !== 1 || event?.date !== paidAt
        || event.amount !== i.amount || installmentLinkedToCardPayment(stateRef.current, current)) {
        toast({ text: 'Confira o histórico da parcela antes de reabrir. O registro mudou.' })
        return
      }
      dispatch({ type: 'unpayInstallment', id: i.id })
    } : undefined
    toast({ text: `Parcela ${i.number} marcada como paga.`, undo })
  }

  const paySelection = (installments: Installment[], completePlan?: boolean) => {
    const action = { type: 'payInstallments' as const, planId: plan.id, ids: installments.map(i => i.id),
      paidAt: todayISO(), completePlan }
    const current = stateRef.current
    if (reducer(current, action) === current) {
      toast({ text: 'Confira o saldo e os pagamentos já registrados antes de continuar.' })
      return false
    }
    dispatch(action)
    return true
  }

  const anticipate = (n: number) => {
    const selection = advanceable.slice(0, n)
    if (paySelection(selection)) toast({ text: `${selection.length} parcela(s) antecipada(s).` })
  }

  const settleAll = () => {
    setConfirmAction(null)
    if (paySelection(remaining, true)) toast({ text: 'Parcelamento quitado. 🎉' })
  }

  const cancelFuture = () => {
    const current = stateRef.current.installmentPlans.find(p => p.id === plan.id)
    if (!current || !futureInstallmentsToCancel(stateRef.current, current).length) {
      setConfirmAction(null)
      toast({ text: 'Confira as parcelas antes de cancelar. Os vencimentos elegíveis mudaram.' })
      return
    }
    dispatch({ type: 'cancelFutureInstallments', planId: plan.id })
    setConfirmAction(null)
    setConfirmDelete(false)
    toast({ text: 'Parcelas futuras em aberto e sem pagamento canceladas.' })
  }

  return (
    <div className="card">
      <button onClick={onToggle} style={{ background: 'none', border: 'none', padding: 0, width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
        <div className="spread">
          <h3>{plan.description}</h3>
          <span className={`badge ${statusCls}`}>{statusLabel}</span>
        </div>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          {fmtBRL(plan.totalAmount)} em {plan.installmentCount}x de {fmtBRL(pp.currentAmount)}
        </p>
        <p className="tiny" style={{ margin: '2px 0 0' }}>
          {pp.paidCount} de {plan.installmentCount} parcelas pagas
          {pp.remainingCount > 0 ? ` · faltam ${pp.remainingCount}` : ''}
          {pp.card ? ` · ${pp.card.name}` : ' · sem cartão'}
          {cat ? ` · ${cat.name}` : ''}
        </p>

        {/* parcela atual E saldo total lado a lado — nunca só a parcela (8.1) */}
        <div className="grid-2" style={{ margin: '12px 0 10px' }}>
          <div className="mini-card">
            <div className="mini-value">{fmtBRL(pp.currentAmount)}</div>
            <div className="mini-label">Parcela atual</div>
          </div>
          <div className="mini-card">
            <div className="mini-value amount-neg">{fmtBRL(pp.remainingAmount)}</div>
            <div className="mini-label">Ainda falta pagar</div>
          </div>
        </div>

        <Progress pct={pp.pct} tone={pp.overdueCount > 0 ? 'danger' : undefined} />
        <div className="spread" style={{ marginTop: 6 }}>
          <span className="tiny">{pp.pct}% pago</span>
          <span className="tiny">{pp.nextDueDate ? `Próximo vencimento: ${fmtDateShort(pp.nextDueDate)}`
            : pp.remainingCount > 0 ? 'Vencimento a conferir' : 'Sem parcelas pendentes'}</span>
        </div>
      </button>

      {open && (
        <>
          <div className="divider" />
          {plan.operationType === 'financed-cash-inflow' && (
            <div className="card" style={{ padding: '10px 14px', background: 'var(--accent-soft)', borderColor: 'transparent', marginBottom: 10 }}>
              <p className="tiny" style={{ margin: 0 }}>
                Entrada financiada: você recebeu {fmtBRL(plan.netReceived || 0)} e assumiu dívida de {fmtBRL(plan.totalAmount)}
                {plan.feeAmount ? ` — custo de ${fmtBRL(plan.feeAmount)}` : ''}. Isso não é receita nem lucro.
              </p>
            </div>
          )}
          {plan.source && <p className="tiny" style={{ marginBottom: 4 }}>Origem: {plan.source}</p>}
          {plan.note && <p className="tiny" style={{ marginBottom: 4 }}>Obs.: {plan.note}</p>}
          {/* Planos antigos não têm principalAmount: neles totalAmount já é o valor
              final e não existe decomposição a mostrar. */}
          {!!plan.interestAmount && (
            <div className="stack tiny" style={{ gap: 2, marginBottom: 6 }}>
              {!!plan.principalAmount && (
                <div className="spread"><span>Valor da compra</span><span className="mono-num">{fmtBRL(plan.principalAmount)}</span></div>
              )}
              <div className="spread"><span>+ Juros ou acréscimo</span><span className="mono-num">{fmtBRL(plan.interestAmount)}</span></div>
              <div className="spread" style={{ fontWeight: 700 }}><span>= Total financiado</span><span className="mono-num">{fmtBRL(plan.totalAmount)}</span></div>
            </div>
          )}

          <p className="tiny" style={{ fontWeight: 650, margin: '10px 0 2px' }}>Todas as parcelas</p>
          {pp.installments.map(i => {
            const futureDate = futureInstallmentPaymentDate(state, i, t)
            const left = installmentRemaining(state, i, t)
            const due = isCalendarDate(i.dueDate) ? i.dueDate : undefined
            const overdue = left > 0 && due && due < t
            const invoicePayment = installmentLinkedToCardPayment(state, i)
            const incompleteLegacy = i.status === 'paid' && left > 0
            const canPay = payable.includes(i)
            const paidAt = i.paidAt && validPaymentDate(i.paidAt, t) ? i.paidAt : undefined
            const early = paidAt && due && paidAt < due
            const invalidPaymentDate = i.paidAt && !isCalendarDate(i.paidAt)
              || i.directPayments?.some(p => !isCalendarDate(p.date))
            const color = i.status === 'cancelled' ? 'var(--text-3)' : futureDate ? 'var(--text-3)'
              : overdue ? 'var(--danger)' : left === 0 ? 'var(--positive)' : undefined
            return (
              <div key={i.id} className="row list-item">
                <div className="grow">
                  <div className="small" style={{ fontWeight: 650, textDecoration: i.status === 'cancelled' ? 'line-through' : undefined }}>
                    Parcela {i.number} de {i.total}
                  </div>
                  <div className="tiny" style={{ color }}>
                    {i.status === 'cancelled' ? 'cancelada'
                      : futureDate ? `pagamento com data futura (${fmtDateShort(futureDate)}); ainda não quitada hoje`
                      : invalidPaymentDate ? 'data de pagamento a conferir'
                      : incompleteLegacy ? `pagamento parcial ${fmtBRL(i.amount - left)} — falta completar`
                      : left === 0 ? (paidAt ? `paga em ${fmtDateShort(paidAt)}${early ? ' (antecipada)' : ''}`
                        : 'paga · data de pagamento não informada')
                      : !due ? 'vencimento a conferir'
                      : overdue ? `venceu em ${fmtDateShort(due)}` : `vence em ${fmtDateShort(due)}`}
                    {left > 0 && left < i.amount && i.status === 'pending' ? ` · pago parcial ${fmtBRL(i.amount - left)}` : ''}
                  </div>
                </div>
                <span className="mono-num small" style={{ color }}>{fmtBRL(i.amount)}</span>
                {canPay && (
                  <>
                    <button className="link tiny" onClick={() => markPaid(i)}>{incompleteLegacy ? 'Completar' : 'Pagar'}</button>
                    <button className="link tiny" onClick={() => setPartialId(i.id)}>Parcial</button>
                  </>
                )}
                {i.status === 'paid' && (invoicePayment
                  ? <span className="tiny muted" title="O pagamento da fatura precisa ser reconciliado antes de reabrir esta parcela.">
                      {futureDate ? 'Vinculada ao pagamento da fatura' : 'Vinculada à fatura paga'}
                    </span>
                  : i.paidVia !== 'invoice' && plan.status !== 'cancelled' && <button className="link tiny" onClick={() => {
                    dispatch({ type: 'unpayInstallment', id: i.id })
                    toast({ text: 'Parcela reaberta.' })
                  }}>Desfazer</button>)}
              </div>
            )
          })}

          {partial && <PartialPaymentBox installment={partial} left={installmentRemaining(state, partial, t)} onDone={() => setPartialId(undefined)} />}

          <div className="suggestion-row" style={{ marginTop: 12 }}>
            {pp.remainingCount > 1 && advanceable.length > 0 && !futurePaid && <button className="btn btn-soft btn-sm" onClick={() => anticipate(1)}>Antecipar 1</button>}
            {pp.remainingCount > 2 && advanceable.length > 1 && !futurePaid && <button className="btn btn-soft btn-sm" onClick={() => anticipate(2)}>Antecipar 2</button>}
            {remaining.length > 0 && remaining.length === payable.length && !futurePaid && <button className="btn btn-soft btn-sm" onClick={() => setConfirmAction('settle')}>Quitar tudo</button>}
            {futurePaid && <span className="tiny muted">Confira o pagamento com data futura antes de quitar o parcelamento.</span>}
            {cancellable > 0 && (
              <button className="btn btn-soft btn-sm" onClick={() => setConfirmAction('cancel-future')}>Cancelar futuras</button>
            )}
            <button className="btn btn-danger-soft btn-sm" onClick={() => { setLegacyReceiptId(''); setConfirmDelete(true) }}>Excluir</button>
          </div>

          {confirmDelete && (
            <div className="card" style={{ borderColor: 'var(--danger)', borderWidth: 1.5, marginTop: 10 }}>
              <h3>Excluir "{plan.description}"?</h3>
              {identifiableReceipts?.length ? (
                <div className="field" style={{ margin: '6px 0 10px' }}>
                  <label>Qual entrada do extrato pertence a este financiamento?</label>
                  <select className="input" value={legacyReceiptId} onChange={e => setLegacyReceiptId(e.target.value)}>
                    <option value="">Selecione o lançamento</option>
                    {identifiableReceipts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                  <span className="tiny">Se a entrada já estava incluída no saldo informado, confira o saldo depois da exclusão.</span>
                </div>
              ) : null}
              <p className="tiny" style={{ margin: '6px 0 10px' }}>
                {removal?.allowed === true ? (
                  <>Isso exclui o parcelamento e todas as {plan.installmentCount} parcelas
                    {removal.receipt ? ` junto da entrada de ${fmtBRL(removal.receipt.amount)} no extrato` : ''}.
                    A exclusão é permanente.</>
                ) : receipts?.length && !identifiableReceipts?.length
                  ? 'Os lançamentos do extrato têm os mesmos dados e não podem ser distinguidos aqui.'
                  : removal?.allowed === false && removal.message}
              </p>
              <div className="suggestion-row">
                <button className="btn btn-danger-soft btn-sm" disabled={removal?.allowed !== true} onClick={() => {
                  if (checkPlanRemoval(stateRef.current, plan, legacyReceiptId).allowed === false) return
                  dispatch({ type: 'removePlan', id: plan.id, legacyReceiptId: legacyReceiptId || undefined })
                  toast({ text: 'Parcelamento excluído.' })
                }}>Excluir tudo</button>
                {cancellable > 0 && <button className="btn btn-soft btn-sm" onClick={cancelFuture}>Só cancelar futuras</button>}
                <button className="chip" onClick={() => setConfirmDelete(false)}>Voltar</button>
              </div>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmAction === 'settle'}
        onClose={() => setConfirmAction(null)}
        title={`Quitar "${plan.description}"?`}
        text={`Isso registrará hoje ${fmtBRL(pp.remainingAmount)} em ${pp.remainingCount} parcela(s).`}
        actions={[{ label: 'Quitar parcelamento', tone: 'primary', onClick: settleAll }]}
      />
      <ConfirmDialog
        open={confirmAction === 'cancel-future'}
        onClose={() => setConfirmAction(null)}
        title="Cancelar as parcelas futuras?"
        text={`Serão canceladas ${cancellable} parcela(s) com vencimento após hoje e sem pagamento registrado. As demais permanecem no parcelamento.`}
        actions={[{ label: 'Cancelar parcelas futuras', tone: 'danger', onClick: cancelFuture }]}
      />
    </div>
  )
}

function PartialPaymentBox({ installment, left, onDone }: { installment: Installment; left: number; onDone: () => void }) {
  const { dispatch } = useStore()
  const toast = useToast()
  const [value, setValue] = useState('')
  const v = parseMoney(value) || 0

  return (
    <div className="card" style={{ padding: '12px 14px', marginTop: 10, borderColor: 'var(--warning)', borderWidth: 1.5 }}>
      <p className="tiny" style={{ marginBottom: 8 }}>
        Pagamento parcial da parcela {installment.number} — restam {fmtBRL(left)}.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input className="input" inputMode="decimal" autoFocus placeholder="0,00" value={value} onChange={e => setValue(e.target.value)} />
        <button className="btn btn-primary btn-sm" disabled={!(v > 0 && v <= left + 0.009)} onClick={() => {
          if (left - v < 0.009) {
            dispatch({ type: 'payInstallment', id: installment.id, paidAt: todayISO(), paidTime: nowPaymentTime() })
            toast({ text: 'Parcela quitada.' })
          } else {
            dispatch({ type: 'partialPayInstallment', id: installment.id, amount: v, paidAt: todayISO(), paidTime: nowPaymentTime() })
            toast({ text: `Pagamento parcial registrado. Restam ${fmtBRL(left - v)}.` })
          }
          onDone()
        }}>Registrar</button>
        <button className="chip" onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}

// ---------------- PROJEÇÕES ----------------

function ProjectionsTab() {
  const { state } = useStore()
  const [months, setMonths] = useState(12)
  const [view, setView] = useState<'months' | 'timeline'>('months')
  const proj = useMemo(() => monthlyProjections(state, months), [state, months])
  const hasData = hasProjectionData(state)

  const timeline = useMemo(() => {
    const t = todayISO()
    const end = new Date(fromISO(t).getFullYear(), fromISO(t).getMonth() + 3, 0)
    return commitmentTimeline(state, t, toISO(end))
  }, [state])

  if (!hasData) {
    return (
      <div className="card">
        <EmptyState emoji="📅" text="Adicione entradas, contas ou parcelas para visualizar uma projeção futura." />
      </div>
    )
  }

  return (
    <>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={`chip ${view === 'months' ? 'active' : ''}`} onClick={() => setView('months')}>Mês a mês</button>
        <button className={`chip ${view === 'timeline' ? 'active' : ''}`} onClick={() => setView('timeline')}>Linha do tempo</button>
      </div>

      {view === 'months' && (
        <>
          <p className="tiny" style={{ marginBottom: 10 }}>
            Projeção com base nas entradas, contas e parcelas que você cadastrou. Pode mudar com novos lançamentos.
          </p>
          <div className="stack">
            {proj.map(m => (
              <div key={m.monthKey} className="card" style={m.tight ? { borderColor: 'var(--warning)', borderWidth: 1.5 } : undefined}>
                <div className="spread">
                  <h3 style={{ textTransform: 'capitalize' }}>{m.label}{m.isCurrent ? ' (mês atual)' : ''}</h3>
                  <span className={`badge ${m.runningBalance >= 0 ? 'pos' : 'neg'}`}>{fmtBRL(m.runningBalance)}</span>
                </div>
                <div className="stack small" style={{ marginTop: 10, gap: 4 }}>
                  <div className="spread"><span className="muted">Entradas previstas</span><span className="mono-num amount-pos">+ {fmtBRL(m.incomes)}</span></div>
                  <div className="spread"><span className="muted">Contas previstas</span><span className="mono-num amount-neg">− {fmtBRL(m.bills)}</span></div>
                  <div className="spread"><span className="muted">Parcelas e faturas previstas</span><span className="mono-num amount-neg">− {fmtBRL(m.installments)}</span></div>
                  <div className="divider" style={{ margin: '6px 0' }} />
                  <div className="spread" style={{ fontWeight: 700 }}>
                    <span>Resultado previsto do mês</span>
                    <span className={m.net >= 0 ? 'amount-pos mono-num' : 'amount-neg mono-num'}>{fmtBRL(m.net)}</span>
                  </div>
                  <div className="spread"><span className="muted">Saldo estimado acumulado</span><span className="mono-num">{fmtBRL(m.runningBalance)}</span></div>
                  <div className="spread"><span className="muted">Estimado disponível para guardar</span><span className="mono-num">{fmtBRL(m.savable)}</span></div>
                  {m.incomes > 0 && (
                    <div className="spread"><span className="muted">Comprometimento da renda</span><span className="mono-num">{m.commitmentPct}%</span></div>
                  )}
                </div>
                {(m.installments > 0 || m.bills > 0) && (
                  <p className="tiny" style={{ marginTop: 8 }}>
                    Em {m.label}, estão previstos {fmtBRL(m.installments + m.bills)} em parcelas e contas.
                    {m.incomes > 0 ? ` Considerando suas entradas cadastradas, o saldo estimado é ${fmtBRL(m.runningBalance)}.` : ''}
                  </p>
                )}
                {m.tight && (
                  <p className="tiny" style={{ marginTop: 6, color: 'var(--warning)' }}>
                    ⚠ Mês mais apertado: as obrigações previstas passam das entradas previstas.
                  </p>
                )}
              </div>
            ))}
          </div>
          <button className="btn btn-soft btn-block" style={{ marginTop: 14 }} onClick={() => setMonths(m => m + 12)}>
            Ver mais 12 meses
          </button>
          <p className="tiny" style={{ textAlign: 'center', marginTop: 10 }}>
            Essa é uma projeção e pode mudar com novos lançamentos.
          </p>
        </>
      )}

      {view === 'timeline' && (
        <>
          <p className="tiny" style={{ marginBottom: 10 }}>
            Vencimentos dos próximos 3 meses. A fatura do cartão aparece uma única vez, já somando
            suas parcelas — elas não são contadas duas vezes.
          </p>
          {timeline.length === 0 ? (
            <div className="card"><p className="small muted" style={{ margin: 0 }}>Nenhum vencimento nos próximos 3 meses.</p></div>
          ) : (
            <div className="card" style={{ padding: '4px 16px' }}>
              {timeline.map((e, i) => (
                <div key={i} className="row list-item">
                  <div className="tiny mono-num" style={{ width: 46, flex: '0 0 auto' }}>{fmtDateShort(e.date)}</div>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 650 }}>{e.label}</div>
                    <div className="tiny">{e.detail}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono-num small amount-neg">− {fmtBRL(e.amount)}</div>
                    <div className="tiny" style={{ color: e.status === 'vencido' ? 'var(--danger)' : e.status === 'pago' ? 'var(--positive)' : undefined }}>
                      {e.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
