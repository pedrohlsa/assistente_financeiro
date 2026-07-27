// Contas fixas, previsão 30 dias e orçamentos (seções 24, 25, 26)
import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import { budgetUsage, currentBalance, describeRecurrence, forecast30, upcomingBills, upcomingIncomes } from '../services/calc'
import { dueLabel, fmtBRL } from '../utils/format'
import { sentenceCase } from '../utils/text'
import { ConfirmDialog, EmptyState, Progress, Sheet, useToast } from '../components/ui'
import { BudgetForm, RecurringForm } from '../components/forms'
import { RecurringExpense } from '../models/types'
import { catById } from '../data/categories'

export default function Planning() {
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const toast = useToast()
  const [billOpen, setBillOpen] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [removing, setRemoving] = useState<RecurringExpense | null>(null)

  const bills = useMemo(() => upcomingBills(state, 30), [state])
  const incomes = useMemo(() => upcomingIncomes(state, 30), [state])
  // Realizado x previsto: nunca somados na mesma linha (item 11).
  const saldoAtual = useMemo(() => currentBalance(state), [state])
  const entradasPrevistas = incomes.reduce((a, b) => a + b.amount, 0)
  const saidasPrevistas = bills.reduce((a, b) => a + b.amount, 0)
  const saldoEstimado = saldoAtual + entradasPrevistas - saidasPrevistas

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Planejamento</h1>
      </div>

      {/* PREVISÃO 30 DIAS (seção 25 + item 11) — realizado e previsto sempre
          em linhas separadas. Uma entrada já confirmada sai de "previstas"
          automaticamente (upcomingIncomes ignora ocorrências resolvidas). */}
      <div className="card">
        <h3 className="muted">Próximos 30 dias (estimativa)</h3>
        <div className="stack small" style={{ marginTop: 10 }}>
          <div className="spread"><span className="muted">Saldo atual (já realizado)</span><span className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(saldoAtual)}</span></div>
          <div className="spread"><span className="muted">Entradas previstas</span><span className="amount-pos mono-num">+ {fmtBRL(entradasPrevistas)}</span></div>
          <div className="spread"><span className="muted">Saídas previstas</span><span className="amount-neg mono-num">− {fmtBRL(saidasPrevistas)}</span></div>
          <div className="divider" />
          {/* "Estimado", não "projetado": o valor não é realizado (item 35). */}
          <div className="spread" style={{ fontWeight: 750, fontSize: '1.05rem' }}><span>Saldo estimado</span><span className={saldoEstimado >= 0 ? 'amount-pos' : 'amount-neg'}>{fmtBRL(saldoEstimado)}</span></div>
        </div>
        <p className="tiny" style={{ marginTop: 10 }}>
          Saldo atual é só o que já entrou e saiu de verdade. As linhas previstas são contas e
          entradas cadastradas que ainda não foram confirmadas — é uma estimativa, não uma garantia.
        </p>
      </div>

      {/* CONTAS FIXAS (seção 24) */}
      <div className="section-title">
        <h2>Próximas contas</h2>
        <button className="link" onClick={() => setBillOpen(true)}>+ Conta fixa</button>
      </div>
      {bills.length === 0 ? (
        <div className="card"><EmptyState emoji="📄" text="Nenhuma conta fixa cadastrada." cta="Adicionar conta" onCta={() => setBillOpen(true)} /></div>
      ) : (
        <div className="card" style={{ padding: '4px 16px' }}>
          {bills.map((b, i) => (
            <div key={b.name + i} className="row list-item">
              <div className="tx-icon">📄</div>
              <div className="grow">
                <div style={{ fontWeight: 650, fontSize: '0.92rem' }}>{sentenceCase(b.name)}</div>
                {/* Forma única em todo o app: "Vence em 10 dias" (item 34). */}
                <div className="tiny">{dueLabel(b.inDays, b.kind)}</div>
              </div>
              <span className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(b.amount)}</span>
            </div>
          ))}
        </div>
      )}
      {state.recurring.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: '4px 16px' }}>
          <p className="tiny" style={{ padding: '10px 0 2px' }}>Cadastradas ({state.recurring.length}):</p>
          {state.recurring.map(r => (
            <div key={r.id} className="row list-item">
              <div className="grow">
                <span className="small" style={{ fontWeight: 650 }}>{sentenceCase(r.name)}</span>
                {/* Descrição legível — nunca "dia 0", "dia 1" (item 2). */}
                <span className="tiny"> · {describeRecurrence(r)}</span>
              </div>
              <span className="small mono-num">{fmtBRL(r.amount)}</span>
              <button className="link tiny" onClick={() => setRemoving(r)}>Remover</button>
            </div>
          ))}
        </div>
      )}

      {/* ORÇAMENTOS (seção 26) */}
      <div className="section-title">
        <h2>Orçamentos por categoria</h2>
        <button className="link" onClick={() => setBudgetOpen(true)}>+ Limite</button>
      </div>
      {state.budgets.length === 0 ? (
        <div className="card"><EmptyState emoji="🎯" text="Crie limites mensais por categoria para controlar gastos." cta="Criar orçamento" onCta={() => setBudgetOpen(true)} /></div>
      ) : (
        <div className="stack">
          {state.budgets.map(b => {
            const used = budgetUsage(state, b.category)
            const pct = b.limit > 0 ? Math.round((used / b.limit) * 100) : 0
            const cat = catById(state.categories, b.category)
            return (
              <div key={b.id} className="card" style={{ padding: '14px 16px' }}>
                <div className="spread">
                  <h3>{cat.icon} {cat.name}</h3>
                  <span className={`badge ${pct >= 100 ? 'neg' : pct >= 70 ? 'warn' : 'pos'}`}>{pct}%</span>
                </div>
                <p className="tiny" style={{ margin: '4px 0 8px' }}>{fmtBRL(used)} de {fmtBRL(b.limit)} por mês</p>
                <Progress pct={pct} tone={pct >= 100 ? 'danger' : pct >= 70 ? 'warn' : undefined} />
                <button className="link tiny" style={{ marginTop: 8 }} onClick={() => dispatch({ type: 'removeBudget', id: b.id })}>Remover</button>
              </div>
            )
          })}
        </div>
      )}

      <Sheet open={billOpen} onClose={() => setBillOpen(false)} title="Conta fixa"><RecurringForm onDone={() => setBillOpen(false)} /></Sheet>
      <Sheet open={budgetOpen} onClose={() => setBudgetOpen(false)} title="Novo orçamento"><BudgetForm onDone={() => setBudgetOpen(false)} /></Sheet>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remover “${sentenceCase(removing?.name)}”?`}
        text="A conta deixa de ser prevista e de gerar lembretes. As movimentações já registradas continuam no histórico."
        actions={[{
          label: 'Remover',
          tone: 'danger',
          onClick: () => {
            const r = removing!
            dispatch({ type: 'removeRecurring', id: r.id })
            setRemoving(null)
            toast({ text: 'Conta removida.', undo: () => dispatch({ type: 'addRecurring', r }) })
          },
        }]}
      />
    </div>
  )
}
