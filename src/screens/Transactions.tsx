// Histórico com timeline, filtros e busca global (seções 13 e 30)
import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'
import { isDriver } from '../services/profile'
import { catById } from '../data/categories'
import { addDays, fmtBRL, fmtDateLong, parseMoney, todayISO } from '../utils/format'
import { EmptyState, Money, useToast } from '../components/ui'
import { useNavigate } from 'react-router-dom'

const PERIODS = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'month', label: 'Este mês' },
  { id: 'prev', label: 'Mês anterior' },
  { id: 'custom', label: 'Personalizado' },
]

export default function Transactions() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const navigate = useNavigate()
  const [period, setPeriod] = useState('7d')
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState(addDays(todayISO(), -7))
  const [to, setTo] = useState(todayISO())

  const range = useMemo((): [string, string] => {
    const t = todayISO()
    switch (period) {
      case 'today': return [t, t]
      case '7d': return [addDays(t, -6), t]
      case '30d': return [addDays(t, -29), t]
      case 'month': return [t.slice(0, 8) + '01', t]
      case 'prev': {
        const d = new Date(); const f = new Date(d.getFullYear(), d.getMonth() - 1, 1); const l = new Date(d.getFullYear(), d.getMonth(), 0)
        const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
        return [iso(f), iso(l)]
      }
      default: return [from, to]
    }
  }, [period, from, to])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const minMatch = q.match(/mais de (?:r\$)?\s*(\d+)/)
    return state.transactions
      .filter(t => t.date >= range[0] && t.date <= range[1])
      .filter(t => !category || t.category === category)
      .filter(t => {
        if (!q) return true
        if (minMatch) return t.amount > parseFloat(minMatch[1])
        const cat = catById(state.categories, t.category)
        return (t.description || '').toLowerCase().includes(q) ||
          cat.name.toLowerCase().includes(q) ||
          t.amount.toFixed(2).includes(q.replace(',', '.')) ||
          new Date(t.date + 'T12:00').toLocaleDateString('pt-BR', { month: 'long' }).includes(q)
      })
      .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')))
  }, [state.transactions, range, category, query, state.categories])

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>()
    filtered.forEach(t => {
      const g = map.get(t.date) || []
      g.push(t); map.set(t.date, g)
    })
    return [...map.entries()]
  }, [filtered])

  const totalIn = filtered.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0)
  const totalOut = filtered.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0)

  return (
    <div className="fade-slide">
      <h1 style={{ marginBottom: 14 }}>Movimentações</h1>

      <input className="input" placeholder={isDriver(state.settings) ? 'Buscar: "gasolina", "junho", "mais de R$ 100"...' : 'Buscar: "aluguel", "junho", "mais de R$ 100"...'} value={query} onChange={e => setQuery(e.target.value)} style={{ marginBottom: 10 }} />

      <div className="chips" style={{ marginBottom: 8 }}>
        {PERIODS.map(p => <button key={p.id} className={`chip ${period === p.id ? 'active' : ''}`} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
      </div>
      {period === 'custom' && (
        <div className="form-grid" style={{ marginBottom: 10 }}>
          <div className="field"><label>De</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div className="field"><label>Até</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
        </div>
      )}
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={`chip ${!category ? 'active' : ''}`} onClick={() => setCategory('')}>Todas</button>
        {state.categories.map(c => (
          <button key={c.id + c.type} className={`chip ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>{c.icon} {c.name}</button>
        ))}
      </div>

      <div className="card" style={{ padding: '13px 16px', marginBottom: 14 }}>
        <div className="grid-3">
          <div><div className="tiny">Receitas</div><div className="amount-pos" style={{ fontWeight: 700 }}>{fmtBRL(totalIn)}</div></div>
          <div><div className="tiny">Despesas</div><div className="amount-neg" style={{ fontWeight: 700 }}>{fmtBRL(totalOut)}</div></div>
          <div><div className="tiny">Resultado</div><div style={{ fontWeight: 700 }}><Money v={totalIn - totalOut} /></div></div>
        </div>
      </div>

      {groups.length === 0 && (
        <div className="card">
          <EmptyState emoji="🍃" text="Nenhuma movimentação neste filtro." cta="Falar com o assistente" onCta={() => navigate('/assistente')} />
        </div>
      )}

      {groups.map(([date, txs]) => (
        <div key={date} style={{ marginBottom: 16 }}>
          <h3 className="muted" style={{ margin: '14px 0 6px', textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.06em' }}>{fmtDateLong(date)}</h3>
          <div className="card" style={{ padding: '4px 16px' }}>
            {txs.map(t => {
              const cat = catById(state.categories, t.category)
              return (
                <div key={t.id} className="row list-item">
                  <div className="tx-icon">{cat.icon}</div>
                  <div className="grow">
                    <div style={{ fontWeight: 650, fontSize: '0.92rem' }}>{t.description || cat.name}</div>
                    <div className="tiny">
                      {t.type === 'financed-cash-inflow' ? 'entrada financiada (não é receita)' : cat.name}
                      {t.time ? ` · ${t.time}` : ''}{t.paymentMethod ? ` · ${t.paymentMethod}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {/* 'financed-cash-inflow' entra no caixa mas NÃO é receita:
                        aparece sem sinal e sem cor de ganho. */}
                    {t.type === 'financed-cash-inflow'
                      ? <span className="mono-num" style={{ fontWeight: 650 }}>{fmtBRL(t.amount)}</span>
                      : <Money v={t.type === 'income' ? t.amount : -t.amount} signed />}
                    <button className="tiny" style={{ display: 'block', background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', marginLeft: 'auto' }}
                      onClick={() => { dispatch({ type: 'removeTx', id: t.id }); toast({ text: 'Movimentação removida.', undo: () => dispatch({ type: 'addTx', tx: t }) }) }}>
                      remover
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
