// Metas: meta diária inteligente, metas de compra, déficits (seções 16, 17, 18)
import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'
import { avgDailyProfit, dailyGoal, monthlySavingGoal } from '../services/calc'
import { isDriver } from '../services/profile'
import { addDays, fmtBRL, fromISO, parseMoney, todayISO } from '../utils/format'
import { EmptyState, Progress, Sheet, useToast } from '../components/ui'
import { GoalForm } from '../components/forms'
import { FinancialGoal } from '../models/types'

function GoalCard({ g }: { g: FinancialGoal }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [depositing, setDepositing] = useState(false)
  const [deposit, setDeposit] = useState('')

  const pct = g.target > 0 ? Math.round((g.saved / g.target) * 100) : 0
  const remaining = Math.max(g.target - g.saved, 0)
  const avg = avgDailyProfit(state)

  // previsão e viabilidade (seção 17)
  const forecast = useMemo(() => {
    if (remaining <= 0) return { text: 'Concluída! 🎉', ok: true }
    if (!g.deadline) {
      if (avg > 0) {
        const days = Math.ceil(remaining / (avg * 0.3))
        return { text: `Previsão: ${fromISO(addDays(todayISO(), days)).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })} (guardando 30% do lucro médio)`, ok: true }
      }
      return { text: 'Defina um prazo ou registre ganhos para eu projetar.', ok: true }
    }
    const days = Math.max(Math.round((fromISO(g.deadline).getTime() - fromISO(todayISO()).getTime()) / 86400000), 1)
    const perDay = remaining / days
    const pctOfAvg = avg > 0 ? Math.round((perDay / avg) * 100) : 0
    if (avg > 0 && perDay > avg * 0.45) {
      const comfortableDays = Math.ceil(remaining / (avg * 0.3))
      return {
        text: `Para o prazo atual, você precisaria separar ${fmtBRL(perDay)} por dia — ${pctOfAvg}% da sua média de lucro diário. Talvez ${comfortableDays} dias seja mais confortável.`,
        ok: false,
        suggestion: addDays(todayISO(), comfortableDays),
      }
    }
    return { text: `Guardando ${fmtBRL(perDay)}/dia (${fmtBRL(perDay * 7)}/semana · ${fmtBRL(perDay * 30)}/mês) você chega lá em ${fromISO(g.deadline).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}.${pctOfAvg > 0 ? ` Isso é ${pctOfAvg}% do seu lucro médio.` : ''}`, ok: true }
  }, [g, remaining, avg])

  const doDeposit = () => {
    const v = parseMoney(deposit)
    if (!v) return
    const saved = g.saved + v
    dispatch({ type: 'updateGoal', id: g.id, patch: { saved, done: saved >= g.target } })
    toast({ text: saved >= g.target ? `Meta "${g.name}" concluída! 🎉` : `${fmtBRL(v)} guardados para ${g.name}.` })
    setDeposit(''); setDepositing(false)
  }

  return (
    <div className={`card ${g.done ? 'celebrate' : ''}`}>
      <div className="spread">
        <h3>{g.name}</h3>
        <span className="badge neutral">{pct}%</span>
      </div>
      <div style={{ margin: '10px 0 6px' }}>
        <span style={{ fontWeight: 750, fontSize: '1.25rem' }} className="mono-num">{fmtBRL(g.saved)}</span>
        <span className="muted small"> de {fmtBRL(g.target)}</span>
      </div>
      <Progress pct={pct} />
      <p className="small muted" style={{ marginTop: 10 }}>{forecast.text}</p>
      {!forecast.ok && (forecast as any).suggestion && (
        <button className="btn btn-soft btn-sm" style={{ marginTop: 8 }}
          onClick={() => { dispatch({ type: 'updateGoal', id: g.id, patch: { deadline: (forecast as any).suggestion } }); toast({ text: 'Prazo ajustado. 👍' }) }}>
          Aceitar sugestão
        </button>
      )}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        {!g.done && <button className="btn btn-primary btn-sm" onClick={() => setDepositing(true)}>Guardar dinheiro</button>}
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Editar</button>
        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--negative)' }} onClick={() => dispatch({ type: 'removeGoal', id: g.id })}>Excluir</button>
      </div>

      <Sheet open={depositing} onClose={() => setDepositing(false)} title={`Guardar para ${g.name}`}>
        <div className="stack">
          <input className="input" inputMode="decimal" autoFocus placeholder="0,00" value={deposit} onChange={e => setDeposit(e.target.value)} style={{ fontSize: '1.4rem', fontWeight: 700, textAlign: 'center' }} onKeyDown={e => e.key === 'Enter' && doDeposit()} />
          <button className="btn btn-primary btn-block" disabled={!parseMoney(deposit)} onClick={doDeposit}>Guardar</button>
        </div>
      </Sheet>
      <Sheet open={editing} onClose={() => setEditing(false)} title="Editar meta">
        <GoalForm goal={g} onDone={() => setEditing(false)} />
      </Sheet>
    </div>
  )
}

export default function Goals() {
  const { state, dispatch } = useStore()
  const [creating, setCreating] = useState(false)
  const goal = useMemo(() => dailyGoal(state), [state])
  const msg = useMemo(() => monthlySavingGoal(state), [state])
  const driverMode = isDriver(state.settings)
  const activeDeficits = state.deficits.filter(d => !d.ignored && d.remaining > 0.01)

  return (
    <div className="fade-slide">
      <div className="spread" style={{ marginBottom: 14 }}>
        <h1>Metas</h1>
        <button className="btn btn-soft btn-sm" onClick={() => setCreating(true)}>+ Nova meta</button>
      </div>

      {/* META DIÁRIA (seção 16) — só motorista */}
      {driverMode && (
        <div className="card">
          <h3 className="muted">Sua meta diária</h3>
          <div className="big-number" style={{ margin: '4px 0 10px' }}>{fmtBRL(goal.total)}</div>
          <div className="stack" style={{ fontSize: '0.9rem' }}>
            <div className="spread"><span className="muted">Meta base (contas + objetivo)</span><span className="mono-num">{fmtBRL(goal.base)}</span></div>
            <div className="spread"><span className="muted">Metas pessoais</span><span className="mono-num">+ {fmtBRL(goal.personal)}</span></div>
            <div className="spread"><span className="muted">Déficits</span><span className="mono-num">+ {fmtBRL(goal.deficit)}</span></div>
            {goal.installments > 0 && (
              <div className="spread"><span className="muted">Parcelas e faturas do mês</span><span className="mono-num">+ {fmtBRL(goal.installments)}</span></div>
            )}
            <div className="spread"><span className="muted">Margem de segurança ({state.settings.safetyMarginPct}%)</span><span className="mono-num">+ {fmtBRL(goal.margin)}</span></div>
            <div className="divider" />
            <div className="spread" style={{ fontWeight: 750 }}><span>Meta final</span><span className="mono-num">{fmtBRL(goal.total)}</span></div>
          </div>
          <p className="tiny" style={{ marginTop: 10 }}>Calculada com base nas suas contas fixas, metas, déficits e {goal.workDaysLeft} dias de trabalho restantes. Ajuste em Mais → Configurações.</p>
        </div>
      )}

      {/* META MENSAL PARA GUARDAR — perfis não motoristas */}
      {!driverMode && (
        <div className={`card ${msg.reached ? 'celebrate' : ''}`}>
          <h3 className="muted">Meta mensal para guardar</h3>
          <div className="big-number" style={{ margin: '4px 0 10px' }}>{fmtBRL(msg.target)}</div>
          <div className="stack" style={{ fontSize: '0.9rem' }}>
            <div className="spread"><span className="muted">Entradas do mês</span><span className="mono-num amount-pos">{fmtBRL(msg.income)}</span></div>
            <div className="spread"><span className="muted">Despesas do mês</span><span className="mono-num amount-neg">− {fmtBRL(msg.expense)}</span></div>
            <div className="divider" />
            <div className="spread" style={{ fontWeight: 750 }}>
              <span>Resultado líquido do mês</span>
              <span className={`mono-num ${msg.net >= 0 ? 'amount-pos' : 'amount-neg'}`}>{fmtBRL(msg.net)}</span>
            </div>
          </div>
          {msg.target > 0 && (
            <div style={{ marginTop: 12 }}>
              <Progress pct={Math.min(msg.pct, 100)} tone={msg.negative ? 'danger' : msg.pct < 40 ? 'warn' : undefined} />
              <div className="spread" style={{ marginTop: 8 }}>
                <span className="small muted">{msg.pct}% da meta</span>
                <span className="small" style={{ fontWeight: 650 }}>{msg.reached ? '🎉 Meta alcançada!' : `Faltam ${fmtBRL(msg.missing)}`}</span>
              </div>
            </div>
          )}
          <p className="tiny" style={{ marginTop: 10 }}>
            {msg.target <= 0
              ? 'Defina em Mais → Configurações quanto pretende guardar por mês.'
              : msg.negative
                ? `Neste mês, suas despesas estão ${fmtBRL(-msg.net)} acima das suas entradas. Antes de guardar, será necessário equilibrar esse valor.`
                : msg.reached
                  ? 'Meta mensal alcançada! Seu resultado líquido passou do valor que você pretendia guardar.'
                  : `Faltam ${fmtBRL(msg.missing)} para alcançar sua meta mensal. Ajuste em Mais → Configurações.`}
          </p>
        </div>
      )}

      {/* DÉFICITS ATIVOS — conceito diário, só motorista */}
      {driverMode && activeDeficits.length > 0 && (
        <>
          <div className="section-title"><h2>Déficits em diluição</h2></div>
          {activeDeficits.map(d => (
            <div key={d.id} className="card" style={{ padding: '13px 16px' }}>
              <div className="spread">
                <div>
                  <div style={{ fontWeight: 650, fontSize: '0.9rem' }}>Déficit de {fromISO(d.date).toLocaleDateString('pt-BR')}</div>
                  <div className="tiny">Restam {fmtBRL(d.remaining)} · {fmtBRL(d.perDay)}/dia somados à sua meta</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => dispatch({ type: 'dismissDeficit', date: d.date })}>ignorar</button>
              </div>
            </div>
          ))}
        </>
      )}

      {/* METAS DE COMPRA */}
      <div className="section-title"><h2>Objetivos de compra</h2></div>
      {state.goals.length === 0 ? (
        <div className="card">
          <EmptyState emoji="🎯" text="Tem algum plano em mente?" cta="Criar minha primeira meta" onCta={() => setCreating(true)} />
        </div>
      ) : (
        <div className="stack">
          {state.goals.map(g => <GoalCard key={g.id} g={g} />)}
        </div>
      )}

      <Sheet open={creating} onClose={() => setCreating(false)} title="Nova meta">
        <GoalForm onDone={() => setCreating(false)} />
      </Sheet>
    </div>
  )
}
