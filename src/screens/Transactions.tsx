// Histórico com timeline, filtros e busca global (seções 13 e 30)
import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'
import { isDriver } from '../services/profile'
import { transactionOccurrence } from '../services/calc'
import { catById } from '../data/categories'
import { addDays, fmtBRL, fmtDateLong, fromISO, todayISO } from '../utils/format'
import { sentenceCase } from '../utils/text'
import { ConfirmDialog, EmptyState, Money, Sheet, useToast } from '../components/ui'
import { Transaction } from '../models/types'
import { useNavigate } from 'react-router-dom'

const PERIODS = [
  { id: 'today', label: 'Hoje' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'month', label: 'Este mês' },
  { id: 'prev', label: 'Mês anterior' },
  { id: 'custom', label: 'Personalizado' },
]

/**
 * Categorias muito específicas do motorista. Elas NUNCA são removidas — o
 * histórico continua intacto e um autônomo pode ter feito uma corrida. Elas só
 * saem dos filtros principais dos outros perfis, aparecendo em "Mais categorias"
 * ou automaticamente quando existe movimentação delas no período.
 */
const DRIVER_CATEGORIES = ['corridas', 'combustivel', 'manutencao', 'estacionamento', 'pedagio']

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Formulário', ai: 'Assistente', voice: 'Voz', quick: 'Registro rápido',
  demo: 'Demonstração', recurring: 'Conta recorrente',
}

const TYPE_LABEL: Record<string, string> = {
  income: 'Receita', expense: 'Despesa', saving: 'Guardado na reserva',
  'financed-cash-inflow': 'Entrada financiada (não é receita)',
}

const PROFILE_LABEL: Record<string, string> = {
  driver: 'Motorista de aplicativo', autonomo: 'Autônomo', clt: 'CLT', business: 'Outro', other: 'Outro',
}

export default function Transactions() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const navigate = useNavigate()
  const driverMode = isDriver(state.settings)
  const [period, setPeriod] = useState('7d')
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState(addDays(todayISO(), -7))
  const [to, setTo] = useState(todayISO())
  const [showAllCats, setShowAllCats] = useState(false)
  const [detail, setDetail] = useState<Transaction | null>(null)

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

  const inPeriod = useMemo(
    () => state.transactions.filter(t => t.date >= range[0] && t.date <= range[1]),
    [state.transactions, range])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    const minMatch = q.match(/mais de (?:r\$)?\s*(\d+)/)
    return inPeriod
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
  }, [inPeriod, category, query, state.categories])

  // Filtros principais x "Mais categorias" (item 22). Uma categoria de motorista
  // entra nos principais se o perfil for motorista, se estiver selecionada, ou
  // se houver movimentação dela no período — dado nunca fica escondido.
  const { primaryCats, extraCats } = useMemo(() => {
    const used = new Set(inPeriod.map(t => t.category))
    const primary = state.categories.filter(c =>
      driverMode || !DRIVER_CATEGORIES.includes(c.id) || used.has(c.id) || category === c.id)
    return { primaryCats: primary, extraCats: state.categories.filter(c => !primary.includes(c)) }
  }, [state.categories, inPeriod, driverMode, category])

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>()
    filtered.forEach(t => {
      const g = map.get(t.date) || []
      g.push(t); map.set(t.date, g)
    })
    return [...map.entries()]
  }, [filtered])

  const today = todayISO()
  const realized = filtered.filter(t => t.date <= today)
  const totalIn = realized.filter(t => t.type === 'income').reduce((a, t) => a + t.amount, 0)
  const totalOut = realized.filter(t => t.type === 'expense').reduce((a, t) => a + t.amount, 0)

  const visibleCats = showAllCats ? [...primaryCats, ...extraCats] : primaryCats

  return (
    <div className="fade-slide">
      <h1 style={{ marginBottom: 14 }}>Movimentações</h1>

      <input className="input" placeholder={driverMode ? 'Buscar: "gasolina", "junho", "mais de R$ 100"...' : 'Buscar: "aluguel", "junho", "mais de R$ 100"...'} value={query} onChange={e => setQuery(e.target.value)} style={{ marginBottom: 10 }} />

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
        {visibleCats.map(c => (
          <button key={c.id + c.type} className={`chip ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>{c.icon} {c.name}</button>
        ))}
        {extraCats.length > 0 && (
          <button className="chip" onClick={() => setShowAllCats(v => !v)}>
            {showAllCats ? 'Menos categorias' : `Mais categorias (${extraCats.length})`}
          </button>
        )}
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
                /* Card enxuto: descrição, categoria, horário e valor. Os detalhes
                   completos e a remoção ficam na folha de detalhes, ao toque. */
                <button key={t.id} className="row list-item tappable"
                  onClick={() => setDetail(t)}
                  style={{ width: '100%', background: 'none', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                  <div className="tx-icon">{cat.icon}</div>
                  <div className="grow">
                    <div style={{ fontWeight: 650, fontSize: '0.92rem' }}>{sentenceCase(t.description) || cat.name}</div>
                    <div className="tiny">
                      {t.type === 'financed-cash-inflow' ? 'Entrada financiada (não é receita)' : cat.name}
                      {t.date > today ? ' · Data futura' : ''}
                      {t.time ? ` · ${t.time.slice(0, 5)}` : ''}
                    </div>
                  </div>
                  {/* 'financed-cash-inflow' entra no caixa mas NÃO é receita:
                      aparece sem sinal e sem cor de ganho. */}
                  {t.type === 'financed-cash-inflow'
                    ? <span className="mono-num" style={{ fontWeight: 650 }}>{fmtBRL(t.amount)}</span>
                    : <Money v={t.type === 'income' ? t.amount : -t.amount} signed />}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      <TransactionDetail
        tx={detail}
        onClose={() => setDetail(null)}
        onRemove={tx => {
          const occurrence = transactionOccurrence(state, tx)
          dispatch({ type: 'removeTx', id: tx.id })
          setDetail(null)
          toast({ text: 'Movimentação removida.', undo: () => dispatch({ type: 'restoreTx', tx, occurrence }) })
        }}
      />
    </div>
  )
}

/** Detalhes completos da movimentação — inclusive a remoção, com confirmação. */
function TransactionDetail({ tx, onClose, onRemove }: {
  tx: Transaction | null
  onClose: () => void
  onRemove: (tx: Transaction) => void
}) {
  const { state } = useStore()
  const [confirming, setConfirming] = useState(false)
  if (!tx) return null
  const cat = catById(state.categories, tx.category)
  const occurrence = transactionOccurrence(state, tx)
  const conta = occurrence && state.recurring.find(r => r.id === occurrence.recurringId)
  const aviso = conta && occurrence ? ` O vencimento de ${fmtDateLong(occurrence.date)} da conta ${conta.name} pode voltar para as pendências.` : ''
  const rows: [string, string | undefined][] = [
    ['Valor', fmtBRL(tx.amount)],
    ['Tipo', TYPE_LABEL[tx.type] || tx.type],
    ['Categoria', `${cat.icon} ${cat.name}`],
    ['Data', fromISO(tx.date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })],
    ['Horário', tx.time?.slice(0, 8)],
    ['Origem / fonte', sentenceCase(tx.origin) || undefined],
    ['Forma de pagamento', tx.paymentMethod],
    ['Observação', tx.note],
    ['Registrado por', tx.source ? SOURCE_LABEL[tx.source] || tx.source : undefined],
    ['Perfil na criação', tx.profileAtCreation ? PROFILE_LABEL[tx.profileAtCreation] : undefined],
  ]
  return (
    <>
      <Sheet open onClose={onClose} title={sentenceCase(tx.description) || cat.name}>
        <div className="stack small" style={{ gap: 6 }}>
          {rows.filter(([, v]) => !!v).map(([label, value]) => (
            <div key={label} className="spread">
              <span className="muted">{label}</span>
              <span style={{ textAlign: 'right' }}>{value}</span>
            </div>
          ))}
        </div>
        <button className="btn btn-danger-soft btn-block" style={{ marginTop: 18 }} onClick={() => setConfirming(true)}>
          Remover movimentação
        </button>
      </Sheet>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Remover esta movimentação?"
        text={`${TYPE_LABEL[tx.type] || tx.type} de ${fmtBRL(tx.amount)} em ${cat.name}.${aviso} Você poderá desfazer pelo aviso que aparece em seguida.`}
        actions={[{ label: 'Remover', onClick: () => { setConfirming(false); onRemove(tx) }, tone: 'danger' }]}
      />
    </>
  )
}
