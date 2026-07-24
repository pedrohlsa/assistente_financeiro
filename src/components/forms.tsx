// Formulários de registro — curtos, mobile-first (seções 11, 21, 22, 17, 24, 31, 32)
import React, { useState } from 'react'
import { useStore } from '../store/store'
import { useToast } from './ui'
import { Budget, CategoryType, FinancialGoal, FuelRecord, MaintenanceItem, RecurringExpense, Transaction } from '../models/types'
import { nowTime, parseMoney, todayISO, uid, fmtBRL } from '../utils/format'
import { guessCategory } from '../data/categories'
import { defaultIncomeCategory, isDriver } from '../services/profile'

const PAYMENTS = ['Dinheiro', 'Pix', 'Débito', 'Crédito', 'Outro']

export function TransactionForm({ type: initialType, onDone }: { type?: CategoryType; onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const driverMode = isDriver(state.settings)
  const [type, setType] = useState<CategoryType>(initialType || 'expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [origin, setOrigin] = useState('')
  const [date, setDate] = useState(todayISO())
  const [payment, setPayment] = useState('Pix')
  const [note, setNote] = useState('')
  const [showMore, setShowMore] = useState(false)

  const cats = state.categories.filter(c => c.type === type && !c.archived)
  const suggested = description ? guessCategory(description, type) : undefined

  const save = () => {
    const v = parseMoney(amount)
    if (!v || v <= 0) return
    const tx: Transaction = {
      id: uid(), type, amount: v,
      category: category || suggested || (type === 'income' ? 'outros-in' : 'outros-out'),
      description: description || undefined, origin: origin || undefined,
      date, time: nowTime(), paymentMethod: payment, note: note || undefined, source: 'manual',
      profileAtCreation: state.settings.profile,
    }
    dispatch({ type: 'addTx', tx })
    toast({ text: `${fmtBRL(v)} ${type === 'income' ? 'adicionados' : 'registrados'}.`, undo: () => dispatch({ type: 'removeTx', id: tx.id }) })
    onDone()
  }

  return (
    <div className="stack">
      <div className="chips">
        <button className={`chip ${type === 'income' ? 'active' : ''}`} onClick={() => { setType('income'); setCategory('') }}>Receita</button>
        <button className={`chip ${type === 'expense' ? 'active' : ''}`} onClick={() => { setType('expense'); setCategory('') }}>Despesa</button>
      </div>
      <div className="field">
        <label>Valor (R$)</label>
        <input className="input" inputMode="decimal" placeholder="0,00" autoFocus value={amount} onChange={e => setAmount(e.target.value)} style={{ fontSize: '1.4rem', fontWeight: 700 }} />
      </div>
      <div className="field">
        <label>Descrição {suggested && !category && <span className="tiny">→ sugestão: {state.categories.find(c => c.id === suggested)?.name}</span>}</label>
        <input className="input" placeholder={type === 'income'
          ? (driverMode ? 'ex.: corridas da tarde' : 'ex.: aluguel casa 1, salário')
          : (driverMode ? 'ex.: gasolina posto Shell' : 'ex.: mercado, farmácia')} value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label>Categoria</label>
        <div className="chips">
          {cats.map(c => (
            <button key={c.id} className={`chip ${(category || suggested) === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>
              {c.icon} {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Origem / fonte (opcional)</label>
        <input className="input" placeholder={type === 'income' ? 'ex.: Casa 1, Cliente João, Empresa X' : 'ex.: Casa 1'} value={origin} onChange={e => setOrigin(e.target.value)} />
      </div>
      {!showMore && <button className="link" onClick={() => setShowMore(true)}>+ data, pagamento e observação</button>}
      {showMore && (
        <div className="form-grid">
          <div className="field"><label>Data</label><input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div className="field"><label>Pagamento</label>
            <select className="input" value={payment} onChange={e => setPayment(e.target.value)}>{PAYMENTS.map(p => <option key={p}>{p}</option>)}</select>
          </div>
          <div className="field full"><label>Observação</label><input className="input" value={note} onChange={e => setNote(e.target.value)} /></div>
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={!parseMoney(amount)} onClick={save}>Salvar</button>
    </div>
  )
}

export function WorkForm({ onDone }: { onDone: () => void }) {
  const { dispatch } = useStore()
  const toast = useToast()
  const [km, setKm] = useState('')
  const [trips, setTrips] = useState('')
  const [hours, setHours] = useState('')
  const [earned, setEarned] = useState('')

  const save = () => {
    dispatch({ type: 'addWork', w: { date: todayISO(), km: parseMoney(km) || 0, trips: parseMoney(trips) || 0, hours: parseMoney(hours) || 0 } })
    const v = parseMoney(earned)
    if (v > 0) dispatch({ type: 'addTx', tx: { id: uid(), type: 'income', amount: v, category: 'corridas', description: 'Corridas do dia', date: todayISO(), time: nowTime(), source: 'manual' } })
    toast({ text: 'Trabalho registrado.' })
    onDone()
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field"><label>KM rodados</label><input className="input" inputMode="decimal" value={km} onChange={e => setKm(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Viagens</label><input className="input" inputMode="numeric" value={trips} onChange={e => setTrips(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Horas online</label><input className="input" inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Faturamento (R$)</label><input className="input" inputMode="decimal" value={earned} onChange={e => setEarned(e.target.value)} placeholder="opcional" /></div>
      </div>
      <button className="btn btn-primary btn-block" onClick={save}>Salvar</button>
    </div>
  )
}

export function FuelForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [price, setPrice] = useState(state.settings.fuelPricePerLiter ? String(state.settings.fuelPricePerLiter).replace('.', ',') : '')
  const [amount, setAmount] = useState('')
  const [liters, setLiters] = useState('')
  const [odometer, setOdometer] = useState(state.vehicle ? String(state.vehicle.odometer) : '')
  const [station, setStation] = useState('')
  const [fuelType, setFuelType] = useState('Gasolina')

  // Interderivação: com dois dos três (preço/L, valor, litros) o app calcula o terceiro.
  const p = parseMoney(price) || 0
  const aIn = parseMoney(amount) || 0
  const lIn = parseMoney(liters) || 0
  let a = aIn, l = lIn, ppl = p
  if (aIn && p && !lIn) l = aIn / p
  else if (aIn && lIn && !p) ppl = aIn / lIn
  else if (lIn && p && !aIn) a = lIn * p
  else if (aIn && lIn) ppl = aIn / lIn // ambos → recomputa preço

  // KM rodados e consumo desde o último abastecimento com hodômetro
  const odo = parseMoney(odometer) || 0
  const lastWithOdo = [...state.fuelRecords].filter(f => f.odometer).sort((x, y) => y.odometer! - x.odometer!)[0]
  const kmSince = lastWithOdo && odo > lastWithOdo.odometer! ? odo - lastWithOdo.odometer! : 0
  const consumo = kmSince > 0 && l > 0 ? kmSince / l : 0

  const save = () => {
    if (!a || a <= 0) return
    const f: FuelRecord = { id: uid(), date: todayISO(), amount: a, liters: l || 0, pricePerLiter: ppl || state.settings.fuelPricePerLiter, odometer: odo || undefined, station: station || undefined, fuelType }
    dispatch({ type: 'addFuel', f })
    dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: a, category: 'combustivel', description: `Abastecimento${station ? ' ' + station : ''}`, date: todayISO(), time: nowTime(), source: 'manual' } })
    // guarda o preço/L como referência para o próximo
    if (ppl > 0) dispatch({ type: 'settings', patch: { fuelPricePerLiter: Math.round(ppl * 100) / 100 } })
    toast({ text: kmSince > 0 ? `Abastecido. Você rodou ${Math.round(kmSince)} km (${consumo.toFixed(1)} km/L).` : `Abastecimento de ${fmtBRL(a)} registrado.` })
    onDone()
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field"><label>Preço por litro (R$)</label><input className="input" inputMode="decimal" autoFocus value={price} onChange={e => setPrice(e.target.value)} placeholder="4,99" /></div>
        <div className="field"><label>Valor pago (R$)</label><input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="200" /></div>
        <div className="field"><label>Litros</label><input className="input" inputMode="decimal" value={liters} onChange={e => setLiters(e.target.value)} placeholder="41" /></div>
        <div className="field"><label>KM atual (hodômetro)</label><input className="input" inputMode="numeric" value={odometer} onChange={e => setOdometer(e.target.value)} placeholder="222000" /></div>
        <div className="field"><label>Combustível</label>
          <select className="input" value={fuelType} onChange={e => setFuelType(e.target.value)}>
            <option>Gasolina</option><option>Etanol</option><option>Diesel</option><option>GNV</option>
          </select>
        </div>
        <div className="field full"><label>Posto</label><input className="input" value={station} onChange={e => setStation(e.target.value)} placeholder="ex.: BR (opcional)" /></div>
      </div>
      {(a > 0 || l > 0 || ppl > 0) && (
        <div className="card" style={{ padding: '10px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
          <p className="small" style={{ margin: 0 }}>
            {ppl > 0 && `${fmtBRL(ppl)}/L · `}{a > 0 && `${fmtBRL(a)} · `}{l > 0 && `${l.toFixed(1)} L`}
          </p>
          {kmSince > 0 && (
            <p className="tiny" style={{ margin: '4px 0 0' }}>
              Desde o último abastecimento: {Math.round(kmSince)} km{consumo > 0 ? ` → ${consumo.toFixed(1)} km/L` : ''}
            </p>
          )}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={!a || a <= 0} onClick={save}>Salvar</button>
    </div>
  )
}

const MAINT_OPTIONS = [
  { name: 'Óleo', life: 10000 }, { name: 'Pneus', life: 40000 }, { name: 'Pastilhas', life: 30000 },
  { name: 'Freios', life: 30000 }, { name: 'Correia', life: 60000 }, { name: 'Filtros', life: 10000 },
  { name: 'Velas', life: 30000 }, { name: 'Amortecedores', life: 60000 }, { name: 'Outros', life: 20000 },
]

export function MaintenanceForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [name, setName] = useState('Óleo')
  const [cost, setCost] = useState('')
  const [km, setKm] = useState(state.vehicle ? String(state.vehicle.odometer) : '')
  const [life, setLife] = useState('10000')

  const save = () => {
    const c = parseMoney(cost)
    if (!c) return
    const m: MaintenanceItem = { id: uid(), name, cost: c, kmInstalled: parseMoney(km) || 0, lifeKm: parseMoney(life) || 10000, date: todayISO() }
    dispatch({ type: 'addMaintenance', m })
    dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: c, category: 'manutencao', description: `Troca: ${name}`, date: todayISO(), time: nowTime(), source: 'manual' } })
    toast({ text: `${name} registrado.` })
    onDone()
  }

  return (
    <div className="stack">
      <div className="field"><label>Item</label>
        <div className="chips">{MAINT_OPTIONS.map(o => (
          <button key={o.name} className={`chip ${name === o.name ? 'active' : ''}`} onClick={() => { setName(o.name); setLife(String(o.life)) }}>{o.name}</button>
        ))}</div>
      </div>
      <div className="form-grid">
        <div className="field"><label>Custo (R$)</label><input className="input" inputMode="decimal" autoFocus value={cost} onChange={e => setCost(e.target.value)} /></div>
        <div className="field"><label>KM da instalação</label><input className="input" inputMode="numeric" value={km} onChange={e => setKm(e.target.value)} /></div>
        <div className="field full"><label>Vida útil (km)</label><input className="input" inputMode="numeric" value={life} onChange={e => setLife(e.target.value)} /></div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!parseMoney(cost)} onClick={save}>Salvar</button>
    </div>
  )
}

export function GoalForm({ onDone, goal }: { onDone: () => void; goal?: FinancialGoal }) {
  const { dispatch } = useStore()
  const toast = useToast()
  const [name, setName] = useState(goal?.name || '')
  const [target, setTarget] = useState(goal ? String(goal.target) : '')
  const [saved, setSaved] = useState(goal ? String(goal.saved) : '')
  const [deadline, setDeadline] = useState(goal?.deadline || '')

  const save = () => {
    const t = parseMoney(target)
    if (!name || !t) return
    if (goal) {
      dispatch({ type: 'updateGoal', id: goal.id, patch: { name, target: t, saved: parseMoney(saved) || 0, deadline: deadline || undefined } })
    } else {
      dispatch({ type: 'addGoal', g: { id: uid(), name, target: t, saved: parseMoney(saved) || 0, deadline: deadline || undefined, createdAt: todayISO() } })
    }
    toast({ text: 'Meta salva. 🎯' })
    onDone()
  }

  return (
    <div className="stack">
      <div className="field"><label>O que você quer?</label><input className="input" autoFocus placeholder="ex.: iPhone, viagem, reserva" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="form-grid">
        <div className="field"><label>Valor total (R$)</label><input className="input" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} /></div>
        <div className="field"><label>Já guardado (R$)</label><input className="input" inputMode="decimal" value={saved} onChange={e => setSaved(e.target.value)} /></div>
        <div className="field full"><label>Prazo desejado</label><input type="date" className="input" value={deadline} onChange={e => setDeadline(e.target.value)} /></div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!name || !parseMoney(target)} onClick={save}>Salvar meta</button>
    </div>
  )
}

export function RecurringForm({ onDone, defaultKind }: { onDone: () => void; defaultKind?: 'income' | 'expense' }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [kind, setKind] = useState<'income' | 'expense'>(defaultKind || 'expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<RecurringExpense['frequency']>('monthly')
  const [dueDay, setDueDay] = useState('5')
  const [category, setCategory] = useState(defaultKind === 'income' ? 'salario' : 'casa')

  const catList = state.categories.filter(c => c.type === kind && !c.archived)
  const switchKind = (k: 'income' | 'expense') => {
    setKind(k)
    setCategory(k === 'income' ? 'salario' : 'casa')
  }

  const save = () => {
    const v = parseMoney(amount)
    if (!name || !v) return
    dispatch({ type: 'addRecurring', r: { id: uid(), name, amount: v, frequency, dueDay: parseInt(dueDay) || 1, category, kind } })
    toast({ text: kind === 'income' ? 'Entrada fixa adicionada.' : 'Conta fixa adicionada.' })
    onDone()
  }

  return (
    <div className="stack">
      <div className="chips">
        <button className={`chip ${kind === 'expense' ? 'active' : ''}`} onClick={() => switchKind('expense')}>Conta a pagar</button>
        <button className={`chip ${kind === 'income' ? 'active' : ''}`} onClick={() => switchKind('income')}>Entrada fixa</button>
      </div>
      <div className="form-grid">
        <div className="field full"><label>Nome</label><input className="input" autoFocus placeholder={kind === 'income' ? 'ex.: Salário, Aluguel casa 1' : 'ex.: Aluguel, Internet, Netflix'} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label>Valor (R$)</label><input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></div>
        <div className="field"><label>Frequência</label>
          <select className="input" value={frequency} onChange={e => setFrequency(e.target.value as any)}>
            <option value="monthly">Mensal</option><option value="weekly">Semanal</option><option value="yearly">Anual</option>
          </select>
        </div>
        <div className="field"><label>{frequency === 'weekly' ? 'Dia da semana (0=dom)' : kind === 'income' ? 'Dia que recebe' : 'Dia do vencimento'}</label><input className="input" inputMode="numeric" value={dueDay} onChange={e => setDueDay(e.target.value)} /></div>
        <div className="field"><label>Categoria</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            {catList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!name || !parseMoney(amount)} onClick={save}>Salvar</button>
    </div>
  )
}

export function BudgetForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [category, setCategory] = useState('alimentacao')
  const [limit, setLimit] = useState('')
  const save = () => {
    const v = parseMoney(limit)
    if (!v) return
    dispatch({ type: 'addBudget', b: { id: uid(), category, limit: v } as Budget })
    toast({ text: 'Orçamento criado.' })
    onDone()
  }
  return (
    <div className="stack">
      <div className="field"><label>Categoria</label>
        <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
          {state.categories.filter(c => c.type === 'expense' && !c.archived).map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
      </div>
      <div className="field"><label>Limite mensal (R$)</label><input className="input" inputMode="decimal" autoFocus value={limit} onChange={e => setLimit(e.target.value)} /></div>
      <button className="btn btn-primary btn-block" disabled={!parseMoney(limit)} onClick={save}>Salvar</button>
    </div>
  )
}

/** Registrar transferência para reserva/investimento (14.3). Não é despesa. */
export function SavingForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')

  const save = () => {
    const v = parseMoney(amount)
    if (!v || v <= 0) return
    dispatch({
      type: 'addTx',
      tx: {
        id: uid(), type: 'saving', amount: v, category: 'reserva',
        description: description || 'Guardado', date: todayISO(), time: nowTime(),
        source: 'manual', profileAtCreation: state.settings.profile,
      },
    })
    toast({ text: `${fmtBRL(v)} guardados. 🏦` })
    onDone()
  }

  return (
    <div className="stack">
      <p className="small muted">
        Isso registra que você transferiu dinheiro para uma reserva ou investimento.
        Não conta como despesa — só mostra quanto do seu resultado você realmente guardou.
      </p>
      <div className="field">
        <label>Valor guardado (R$)</label>
        <input className="input" inputMode="decimal" autoFocus placeholder="0,00" value={amount}
          onChange={e => setAmount(e.target.value)} style={{ fontSize: '1.4rem', fontWeight: 700 }} />
      </div>
      <div className="field">
        <label>Onde guardou (opcional)</label>
        <input className="input" placeholder="ex.: poupança, CDB, cofrinho" value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-block" disabled={!parseMoney(amount)} onClick={save}>Registrar</button>
    </div>
  )
}

// Modo de registro rápido (seção 32)
export function QuickAdd({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const driverMode = isDriver(state.settings)
  const [mode, setMode] = useState<'income' | 'expense' | 'km' | 'trips'>('income')
  const [value, setValue] = useState('')

  const save = () => {
    const v = parseMoney(value)
    if (!v) return
    if (mode === 'income' || mode === 'expense') {
      const tx: Transaction = { id: uid(), type: mode, amount: v, category: mode === 'income' ? defaultIncomeCategory(state.settings) : 'outros-out', date: todayISO(), time: nowTime(), source: 'quick' }
      dispatch({ type: 'addTx', tx })
      toast({ text: `${fmtBRL(v)} ${mode === 'income' ? 'adicionados' : 'registrados como despesa'}.`, undo: () => dispatch({ type: 'removeTx', id: tx.id }) })
    } else if (mode === 'km') {
      dispatch({ type: 'addWork', w: { date: todayISO(), km: v } })
      toast({ text: `${v} km adicionados.` })
    } else {
      dispatch({ type: 'addWork', w: { date: todayISO(), trips: v } })
      toast({ text: `${v} viagens adicionadas.` })
    }
    onDone()
  }

  return (
    <div className="stack">
      <div className="chips">
        <button className={`chip ${mode === 'income' ? 'active' : ''}`} onClick={() => setMode('income')}>+ R$</button>
        <button className={`chip ${mode === 'expense' ? 'active' : ''}`} onClick={() => setMode('expense')}>− R$</button>
        {driverMode && <button className={`chip ${mode === 'km' ? 'active' : ''}`} onClick={() => setMode('km')}>KM</button>}
        {driverMode && <button className={`chip ${mode === 'trips' ? 'active' : ''}`} onClick={() => setMode('trips')}>Viagens</button>}
      </div>
      <input className="input" inputMode="decimal" autoFocus placeholder={mode === 'km' ? 'quilômetros' : mode === 'trips' ? 'nº de viagens' : '0,00'} value={value} onChange={e => setValue(e.target.value)} style={{ fontSize: '1.6rem', fontWeight: 750, textAlign: 'center' }} onKeyDown={e => e.key === 'Enter' && save()} />
      <button className="btn btn-primary btn-block" disabled={!parseMoney(value)} onClick={save}>Registrar</button>
    </div>
  )
}
