// Análises, relatórios, comparativos e exportação (seções 14, 28, 29)
import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import {
  bestWorstDay, categoryBreakdown, dailySeries, monthStats, periodStats, prevMonthStats,
  todayStats, weekStats, dailyGoal,
} from '../services/calc'
import { addDays, fmtBRL, fmtNum, todayISO, fromISO } from '../utils/format'
import { catById } from '../data/categories'
import { Money } from '../components/ui'

type Tab = 'day' | 'week' | 'month' | 'year'

export default function Analytics() {
  const { state } = useStore()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('week')
  const t = todayISO()

  const range = useMemo((): [string, string, string, string] => {
    switch (tab) {
      case 'day': return [t, t, addDays(t, -1), addDays(t, -1)]
      case 'week': return [addDays(t, -6), t, addDays(t, -13), addDays(t, -7)]
      case 'month': {
        const d = fromISO(t)
        const pf = new Date(d.getFullYear(), d.getMonth() - 1, 1), pl = new Date(d.getFullYear(), d.getMonth(), 0)
        const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
        return [t.slice(0, 8) + '01', t, iso(pf), iso(pl)]
      }
      case 'year': return [t.slice(0, 5) + '01-01', t, String(Number(t.slice(0, 4)) - 1) + '-01-01', String(Number(t.slice(0, 4)) - 1) + '-12-31']
    }
  }, [tab, t])

  const cur = useMemo(() => periodStats(state, range[0], range[1]), [state, range])
  const prev = useMemo(() => periodStats(state, range[2], range[3]), [state, range])
  const series = useMemo(() => dailySeries(state, tab === 'day' ? 7 : tab === 'week' ? 7 : 30), [state, tab])
  const cats = useMemo(() => categoryBreakdown(state, range[0], range[1]), [state, range])
  const { best, worst } = useMemo(() => bestWorstDay(state), [state])
  const goal = useMemo(() => dailyGoal(state), [state])
  const ts = useMemo(() => todayStats(state), [state])

  const maxBar = Math.max(...series.map(d => Math.max(d.income, d.expense)), 1)
  const catTotal = cats.reduce((a, c) => a + c.total, 0)
  const compLabel = tab === 'day' ? 'ontem' : tab === 'week' ? 'semana passada' : tab === 'month' ? 'mês passado' : 'ano passado'

  const exportCSV = () => {
    const rows = [['data', 'hora', 'tipo', 'categoria', 'descricao', 'valor', 'pagamento']]
    state.transactions
      .filter(x => x.date >= range[0] && x.date <= range[1])
      .forEach(x => rows.push([x.date, x.time || '', x.type === 'income' ? 'receita' : x.type === 'saving' ? 'guardado' : x.type === 'financed-cash-inflow' ? 'entrada financiada' : 'despesa', catById(state.categories, x.category).name, x.description || '', x.amount.toFixed(2).replace('.', ','), x.paymentMethod || '']))
    const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `assistfin-${tab}-${t}.csv`
    a.click()
  }

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Análises</h1>
      </div>

      <div className="chips" style={{ marginBottom: 14 }}>
        {(['day', 'week', 'month', 'year'] as Tab[]).map(x => (
          <button key={x} className={`chip ${tab === x ? 'active' : ''}`} onClick={() => setTab(x)}>
            {x === 'day' ? 'Diário' : x === 'week' ? 'Semanal' : x === 'month' ? 'Mensal' : 'Anual'}
          </button>
        ))}
      </div>

      {/* RELATÓRIO DIÁRIO (seção 28) */}
      {tab === 'day' && (
        <div className="card">
          <h3>Hoje você...</h3>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="mini-card"><div className="mini-value amount-pos">{fmtBRL(ts.income)}</div><div className="mini-label">Faturou</div></div>
            <div className="mini-card"><div className="mini-value amount-neg">{fmtBRL(ts.expense)}</div><div className="mini-label">Gastou</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(ts.profit)}</div><div className="mini-label">Lucrou</div></div>
            <div className="mini-card"><div className="mini-value">{fmtNum(ts.km, 0)} km · {ts.trips} viagens</div><div className="mini-label">Rodou</div></div>
            {ts.km > 0 && <div className="mini-card"><div className="mini-value">{fmtBRL(ts.netPerKm)}</div><div className="mini-label">Líquido/km</div></div>}
            {ts.hours > 0 && <div className="mini-card"><div className="mini-value">{fmtBRL(ts.profitPerHour)}</div><div className="mini-label">Líquido/hora</div></div>}
          </div>
          <p className="small" style={{ marginTop: 12 }}>
            Meta: {fmtBRL(goal.total)} — {ts.profit >= goal.total
              ? <>você superou sua meta em <b>{fmtBRL(ts.profit - goal.total)}</b>. Bom trabalho! 💪</>
              : <>faltam <b>{fmtBRL(goal.total - ts.profit)}</b>.</>}
          </p>
        </div>
      )}

      {/* COMPARATIVO */}
      <div className="card">
        <h3 className="muted">Receitas × Despesas</h3>
        <div className="grid-3" style={{ margin: '12px 0' }}>
          <div><div className="tiny">Receitas</div><div className="amount-pos" style={{ fontWeight: 750 }}>{fmtBRL(cur.income)}</div></div>
          <div><div className="tiny">Despesas</div><div className="amount-neg" style={{ fontWeight: 750 }}>{fmtBRL(cur.expense)}</div></div>
          <div><div className="tiny">Lucro líquido</div><div style={{ fontWeight: 750 }}><Money v={cur.profit} /></div></div>
        </div>
        <div className="divider" />
        <div className="spread small">
          <span className="muted">vs {compLabel}</span>
          <span style={{ fontWeight: 650 }}>
            {prev.profit !== 0 || prev.income !== 0
              ? <>{cur.profit >= prev.profit ? '▲' : '▼'} {fmtBRL(Math.abs(cur.profit - prev.profit))} ({prev.profit !== 0 ? Math.abs(Math.round(((cur.profit - prev.profit) / Math.abs(prev.profit)) * 100)) + '%' : '—'})</>
              : 'sem dados anteriores'}
          </span>
        </div>
      </div>

      {/* EVOLUÇÃO */}
      <div className="card">
        <h3 className="muted" style={{ marginBottom: 12 }}>Evolução {tab === 'month' || tab === 'year' ? '(30 dias)' : '(7 dias)'}</h3>
        <div className="bars">
          {series.map(d => (
            <div key={d.date} className="bar-col" title={`${d.label}: +${fmtBRL(d.income)} / -${fmtBRL(d.expense)}`}>
              <div className="bar" style={{ height: `${(d.income / maxBar) * 90}%` }} />
              {series.length <= 7 && <div className="bar neg" style={{ height: `${(d.expense / maxBar) * 90}%` }} />}
              <div className="bar-label">{d.label}</div>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 16 }}>
          <span className="tiny"><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--accent)', borderRadius: 3, marginRight: 4 }} />receitas</span>
          {series.length <= 7 && <span className="tiny"><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--negative)', borderRadius: 3, marginRight: 4 }} />despesas</span>}
        </div>
      </div>

      {/* GASTOS POR CATEGORIA */}
      <div className="card">
        <h3 className="muted" style={{ marginBottom: 12 }}>Gastos por categoria</h3>
        {cats.length === 0 && <p className="small muted">Sem despesas no período.</p>}
        <div className="stack">
          {cats.map(c => {
            const cat = catById(state.categories, c.category)
            const pct = catTotal > 0 ? Math.round((c.total / catTotal) * 100) : 0
            return (
              <div key={c.category}>
                <div className="spread small" style={{ marginBottom: 4 }}>
                  <span>{cat.icon} {cat.name}</span>
                  <span className="mono-num" style={{ fontWeight: 650 }}>{fmtBRL(c.total)} · {pct}%</span>
                </div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--negative)', opacity: 0.75 }} /></div>
              </div>
            )
          })}
        </div>
      </div>

      {/* INDICADORES */}
      <div className="grid-2">
        <div className="mini-card"><div className="mini-value">{fmtBRL(cur.days > 0 ? cur.profit / cur.days : 0)}</div><div className="mini-label">Média diária (lucro)</div></div>
        <div className="mini-card"><div className="mini-value">{cur.trips > 0 ? fmtBRL(cur.perTrip) : '—'}</div><div className="mini-label">Ticket médio/viagem</div></div>
        <div className="mini-card"><div className="mini-value">{fmtBRL(cur.costPerKm)}</div><div className="mini-label">Custo por km</div></div>
        <div className="mini-card"><div className="mini-value">{fmtBRL(cur.netPerKm)}</div><div className="mini-label">Lucro por km</div></div>
        <div className="mini-card"><div className="mini-value">{fmtBRL(cur.profitPerHour)}</div><div className="mini-label">Lucro por hora</div></div>
        <div className="mini-card"><div className="mini-value">{fmtNum(cur.km, 0)} km</div><div className="mini-label">KM no período</div></div>
        {best && <div className="mini-card"><div className="mini-value amount-pos">{fmtBRL(best.profit)}</div><div className="mini-label">Melhor dia ({fromISO(best.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })})</div></div>}
        {worst && <div className="mini-card"><div className="mini-value amount-neg">{fmtBRL(worst.profit)}</div><div className="mini-label">Pior dia ({fromISO(worst.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })})</div></div>}
      </div>

      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn btn-soft" style={{ flex: 1 }} onClick={exportCSV}>Exportar CSV</button>
        <button className="btn btn-soft" style={{ flex: 1 }} onClick={() => window.print()}>Exportar PDF</button>
      </div>
    </div>
  )
}
