// Formulários de registro — curtos, mobile-first (seções 11, 21, 22, 17, 24, 31, 32)
import React, { useMemo, useState } from 'react'
import { findGoalByExactName, useStore } from '../store/store'
import { ConfirmDialog, MoneyInput, useToast } from './ui'
import { Budget, CategoryType, FinancialGoal, FuelRecord, IntervalUnit, MaintenanceItem, RecurringExpense, Transaction } from '../models/types'
import { addDays, fromISO, nowPaymentTime, parseMoney, todayISO, uid, fmtBRL } from '../utils/format'
import { describeRecurrence, occurrencesBetween } from '../services/calc'
import { sentenceCase } from '../utils/text'
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
      date, time: nowPaymentTime(), paymentMethod: payment, note: note || undefined, source: 'manual',
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
        <MoneyInput autoFocus value={amount} onChange={setAmount} style={{ fontSize: '1.4rem', fontWeight: 700 }} />
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
    if (v > 0) dispatch({ type: 'addTx', tx: { id: uid(), type: 'income', amount: v, category: 'corridas', description: 'Corridas do dia', date: todayISO(), time: nowPaymentTime(), source: 'manual' } })
    toast({ text: 'Trabalho registrado.' })
    onDone()
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field"><label>KM rodados</label><input className="input" inputMode="decimal" value={km} onChange={e => setKm(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Viagens</label><input className="input" inputMode="numeric" value={trips} onChange={e => setTrips(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Horas trabalhadas</label><input className="input" inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} placeholder="0" /></div>
        <div className="field"><label>Faturamento (opcional)</label><MoneyInput value={earned} onChange={setEarned} /></div>
      </div>
      <button className="btn btn-primary btn-block" onClick={save}>Salvar</button>
    </div>
  )
}

export function FuelForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [price, setPrice] = useState('')
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
    if ((!a || a <= 0) && (!l || l <= 0)) return
    const f: FuelRecord = { id: uid(), date: todayISO(), amount: a, liters: l || 0, pricePerLiter: ppl || state.settings.fuelPricePerLiter, odometer: odo || undefined, station: station || undefined, fuelType }
    dispatch({ type: 'addFuel', f })
    dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: a, category: 'combustivel', description: `Abastecimento${station ? ' ' + station : ''}`, date: todayISO(), time: nowPaymentTime(), source: 'manual' } })
    // guarda o preço/L como referência para o próximo
    if (ppl > 0) dispatch({ type: 'settings', patch: { fuelPricePerLiter: Math.round(ppl * 100) / 100 } })
    toast({ text: kmSince > 0 ? `Abastecido. Você rodou ${Math.round(kmSince)} km (${consumo.toFixed(1)} km/L).` : `Abastecimento de ${fmtBRL(a)} registrado.` })
    onDone()
  }

  return (
    <div className="stack">
      <div className="form-grid">
        <div className="field"><label>Preço por litro (R$)</label><MoneyInput autoFocus value={price} onChange={setPrice} placeholder="4,99" /></div>
        <div className="field"><label>Valor pago (R$)</label><MoneyInput value={amount} onChange={setAmount} placeholder="200,00" /></div>
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
      <p className="tiny">
        Com valor e litros, o preço por litro é calculado sozinho. A partir do segundo
        abastecimento com hodômetro, o consumo em km/L aparece como estimativa.
      </p>
      <button className="btn btn-primary btn-block" disabled={(!a || a <= 0) && (!l || l <= 0)} onClick={save}>Salvar</button>
    </div>
  )
}

const MAINT_OPTIONS = ['Óleo', 'Pneus', 'Pastilhas', 'Freios', 'Correia', 'Filtros', 'Velas', 'Amortecedores', 'Outros']

export function MaintenanceForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [name, setName] = useState('Óleo')
  const [cost, setCost] = useState('')
  const [km, setKm] = useState(state.vehicle ? String(state.vehicle.odometer) : '')
  const [life, setLife] = useState('')

  const save = () => {
    const c = parseMoney(cost)
    if (!c) return
    const m: MaintenanceItem = { id: uid(), name, cost: c, kmInstalled: parseMoney(km) || 0, lifeKm: parseMoney(life) || 0, date: todayISO() }
    dispatch({ type: 'addMaintenance', m })
    dispatch({ type: 'addTx', tx: { id: uid(), type: 'expense', amount: c, category: 'manutencao', description: `Troca: ${name}`, date: todayISO(), time: nowPaymentTime(), source: 'manual' } })
    toast({ text: `${name} registrado.` })
    onDone()
  }

  return (
    <div className="stack">
      <div className="field"><label>Item</label>
        <div className="chips">{MAINT_OPTIONS.map(o => (
          <button key={o} className={`chip ${name === o ? 'active' : ''}`} onClick={() => setName(o)}>{o}</button>
        ))}</div>
      </div>
      <div className="form-grid">
        <div className="field"><label>Custo (R$)</label><MoneyInput autoFocus value={cost} onChange={setCost} /></div>
        <div className="field"><label>KM da instalação</label><input className="input" inputMode="numeric" value={km} onChange={e => setKm(e.target.value)} /></div>
        <div className="field full"><label>Vida útil (km, opcional)</label><input className="input" inputMode="numeric" value={life} onChange={e => setLife(e.target.value)} placeholder="Consulte o fabricante ou seu mecânico" /></div>
      </div>
      <p className="tiny">Se deixar a vida útil em branco, a manutenção será salva no histórico, mas o app não projetará a próxima troca nem quanto reservar.</p>
      <button className="btn btn-primary btn-block" disabled={!parseMoney(cost)} onClick={save}>Salvar</button>
    </div>
  )
}

export function GoalForm({ onDone, goal }: { onDone: () => void; goal?: FinancialGoal }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [name, setName] = useState(goal?.name || '')
  const [target, setTarget] = useState(goal ? String(goal.target) : '')
  const [saved, setSaved] = useState(goal ? String(goal.saved) : '')
  const [deadline, setDeadline] = useState(goal?.deadline || '')
  const [askDuplicate, setAskDuplicate] = useState(false)

  // Nome equivalente ignorando acento, caixa e espaços — "Casa" e "  cása" são a mesma coisa.
  const duplicate = findGoalByExactName(state, name, goal?.id)

  const commit = (mode: 'new' | 'existing') => {
    const t = parseMoney(target)
    const patch = { target: t, saved: parseMoney(saved) || 0, deadline: deadline || undefined }
    if (mode === 'existing' && duplicate) {
      dispatch({ type: 'updateGoal', id: duplicate.id, patch })
      toast({ text: `Meta "${duplicate.name}" atualizada.` })
    } else if (goal) {
      dispatch({ type: 'updateGoal', id: goal.id, patch: { ...patch, name: name.trim() } })
      toast({ text: 'Meta salva. 🎯' })
    } else {
      dispatch({ type: 'addGoal', g: { id: uid(), name: name.trim(), ...patch, createdAt: todayISO() } })
      toast({ text: 'Meta salva. 🎯' })
    }
    setAskDuplicate(false)
    onDone()
  }

  const save = () => {
    if (!name.trim() || !parseMoney(target)) return
    // Duplicidade não bloqueia: o usuário pode querer duas metas com o mesmo nome.
    if (duplicate) { setAskDuplicate(true); return }
    commit('new')
  }

  return (
    <div className="stack">
      <div className="field"><label>O que você quer?</label><input className="input" autoFocus placeholder="ex.: iPhone, viagem, reserva" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="form-grid">
        <div className="field"><label>Valor total (R$)</label><MoneyInput value={target} onChange={setTarget} /></div>
        <div className="field"><label>Já guardado (R$)</label><MoneyInput value={saved} onChange={setSaved} /></div>
        <div className="field full"><label>Prazo desejado (opcional)</label><input type="date" className="input" value={deadline} onChange={e => setDeadline(e.target.value)} /></div>
      </div>
      {duplicate && !askDuplicate && (
        <p className="tiny" style={{ color: 'var(--warning)' }}>
          Já existe uma meta chamada “{duplicate.name}”. Vou confirmar com você antes de salvar.
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={!name.trim() || !parseMoney(target)} onClick={save}>Salvar meta</button>

      <ConfirmDialog
        open={askDuplicate}
        onClose={() => setAskDuplicate(false)}
        title={`Já existe uma meta chamada “${duplicate?.name || name}”.`}
        text="Deseja criar outra meta com o mesmo nome?"
        actions={[
          { label: 'Criar mesmo assim', onClick: () => commit('new'), tone: 'primary' },
          { label: 'Editar a existente', onClick: () => commit('existing') },
        ]}
      />
    </div>
  )
}

/**
 * Frequências rápidas. Cada uma é só um par intervalo+unidade — não existe
 * aproximação do tipo "quinzenal = 2x por mês": 15 dias são 15 dias corridos
 * contados a partir da data inicial.
 */
const QUICK_FREQUENCIES: { id: string; label: string; interval: number; unit: IntervalUnit }[] = [
  { id: 'daily', label: 'Diário', interval: 1, unit: 'day' },
  { id: 'weekly', label: 'Semanal', interval: 1, unit: 'week' },
  { id: 'monthly', label: 'Mensal', interval: 1, unit: 'month' },
  { id: 'yearly', label: 'Anual', interval: 1, unit: 'year' },
]

const UNIT_LABEL: Record<IntervalUnit, string> = { day: 'dias', week: 'semanas', month: 'meses', year: 'anos' }

/** `frequency` legado equivalente, para não quebrar dados/telas antigas. */
const legacyFrequency = (unit: IntervalUnit): RecurringExpense['frequency'] =>
  unit === 'week' || unit === 'day' ? 'weekly' : unit === 'year' ? 'yearly' : 'monthly'

export function RecurringForm({ onDone, defaultKind, lockKind = false }: { onDone: () => void; defaultKind?: 'income' | 'expense'; lockKind?: boolean }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [kind, setKind] = useState<'income' | 'expense'>(defaultKind || 'expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [freqId, setFreqId] = useState('monthly')
  const [customInterval, setCustomInterval] = useState('15')
  const [customUnit, setCustomUnit] = useState<IntervalUnit>('day')
  const [startDate, setStartDate] = useState(todayISO())
  const [endDate, setEndDate] = useState('')
  const [noEnd, setNoEnd] = useState(true)
  const [category, setCategory] = useState(defaultKind === 'income' ? 'salario' : 'casa')
  const [askReceived, setAskReceived] = useState(false)

  const catList = state.categories.filter(c => c.type === kind && !c.archived)
  const switchKind = (k: 'income' | 'expense') => {
    setKind(k)
    setCategory(k === 'income' ? 'salario' : 'casa')
  }

  const isCustom = freqId === 'custom'
  const quick = QUICK_FREQUENCIES.find(f => f.id === freqId)
  const interval = isCustom ? Math.max(parseInt(customInterval, 10) || 0, 0) : quick!.interval
  const unit: IntervalUnit = isCustom ? customUnit : quick!.unit
  const intervalOk = !isCustom || (interval >= 1 && interval <= 999)

  const today = todayISO()
  const anchor = fromISO(startDate)
  // Prévia real das próximas datas — calculada pelo mesmo motor que o app usa.
  const preview = useMemo(() => {
    if (!startDate || !intervalOk) return []
    const fake: RecurringExpense = {
      id: 'preview', name: 'preview', amount: 0, category, kind,
      frequency: legacyFrequency(unit), dueDay: anchor.getDate(),
      interval, intervalUnit: unit, startDate,
      endDate: !noEnd && endDate ? endDate : undefined,
    }
    return occurrencesBetween(fake, startDate, addDays(startDate, 400)).slice(0, 4)
  }, [startDate, interval, unit, intervalOk, endDate, noEnd, category, kind])

  const description = useMemo(() => {
    if (!startDate || !intervalOk) return ''
    return describeRecurrence({
      id: 'p', name: 'p', amount: 0, category, kind,
      frequency: legacyFrequency(unit), dueDay: anchor.getDate(),
      interval, intervalUnit: unit, startDate,
    })
  }, [startDate, interval, unit, intervalOk, category, kind])

  const valid = !!name.trim() && !!parseMoney(amount) && !!startDate && intervalOk
  // A primeira ocorrência já chegou? Aí faz sentido perguntar se já foi recebida.
  const firstAlreadyDue = startDate <= today

  const build = (): RecurringExpense => ({
    id: uid(), name: name.trim(), amount: parseMoney(amount), category, kind,
    frequency: legacyFrequency(unit),
    // `dueDay` é o campo LEGADO: em semanal/diário ele significa dia da SEMANA,
    // nos demais, dia do mês. Manter a semântica certa evita que um leitor
    // antigo interprete a data errada.
    dueDay: unit === 'week' || unit === 'day' ? anchor.getDay() : anchor.getDate(),
    dueMonth: unit === 'year' ? anchor.getMonth() + 1 : undefined,
    interval, intervalUnit: unit,
    startDate,
    endDate: !noEnd && endDate ? endDate : undefined,
  })

  /** Só cadastra a previsão: nada de movimentação, nada de saldo. */
  const saveOnly = (rec?: RecurringExpense) => {
    const r = rec || build()
    dispatch({ type: 'addRecurring', r })
    setAskReceived(false)
    toast({ text: kind === 'income' ? 'Entrada recorrente adicionada como prevista.' : 'Conta a pagar adicionada.' })
    onDone()
  }

  /** Cadastra E registra a primeira ocorrência como realizada — uma só vez. */
  const saveAndRegister = () => {
    const r = build()
    const txId = uid()
    dispatch({ type: 'addRecurring', r })
    dispatch({
      type: 'addTx',
      tx: {
        id: txId, type: kind, amount: r.amount, category: r.category,
        description: r.name, origin: r.origin, date: startDate, time: nowPaymentTime(),
        source: 'recurring', recurringId: r.id, occurrenceDate: startDate,
        profileAtCreation: state.settings.profile,
      },
    })
    // Marca a ocorrência como resolvida: ela não volta a ser perguntada nem
    // aparece como entrada prevista. As próximas seguem previstas.
    dispatch({ type: 'resolveOccurrence', recurringId: r.id, occurrence: { date: startDate, status: 'confirmed', txId, amount: r.amount } })
    setAskReceived(false)
    toast({ text: kind === 'income' ? `${fmtBRL(r.amount)} registrados como recebidos.` : `${fmtBRL(r.amount)} registrados como pagos.` })
    onDone()
  }

  const save = () => {
    if (!valid) return
    // Data futura não pergunta nada: é previsão, por definição.
    if (firstAlreadyDue) { setAskReceived(true); return }
    saveOnly()
  }

  return (
    <div className="stack">
      {!lockKind && (
        <div className="chips">
          <button className={`chip ${kind === 'expense' ? 'active' : ''}`} onClick={() => switchKind('expense')}>Conta a pagar</button>
          <button className={`chip ${kind === 'income' ? 'active' : ''}`} onClick={() => switchKind('income')}>Entrada recorrente</button>
        </div>
      )}
      <p className="tiny">
        {kind === 'income'
          ? 'Entrada recorrente é um dinheiro que costuma entrar de novo, como salário ou aluguel recebido. Aqui ele fica previsto; o saldo só muda quando você confirmar o recebimento.'
          : 'Conta a pagar é uma despesa que se repete, como aluguel, internet ou assinatura. Cadastrar não desconta o saldo até você confirmar o pagamento.'}
      </p>
      <div className="form-grid">
        <div className="field full"><label>Nome</label><input className="input" autoFocus placeholder={kind === 'income' ? 'ex.: Salário, Aluguel casa 1' : 'ex.: Aluguel, Internet, Netflix'} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label>Valor (R$)</label><MoneyInput value={amount} onChange={setAmount} /></div>
        <div className="field"><label>Categoria</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            {catList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field full"><label>Com que frequência se repete?</label>
          <select className="input" value={freqId} onChange={e => setFreqId(e.target.value)}>
            {QUICK_FREQUENCIES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            <option value="custom">Personalizada…</option>
          </select>
        </div>
        {isCustom && (
          <div className="field full">
            <label>Repetir a cada</label>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" inputMode="numeric" style={{ maxWidth: 90 }} value={customInterval}
                onChange={e => setCustomInterval(e.target.value.replace(/\D/g, ''))} />
              <select className="input" value={customUnit} onChange={e => setCustomUnit(e.target.value as IntervalUnit)}>
                <option value="day">Dias</option><option value="week">Semanas</option>
                <option value="month">Meses</option><option value="year">Anos</option>
              </select>
            </div>
            {!intervalOk && <span className="tiny" style={{ color: 'var(--danger)' }}>Informe um número entre 1 e 999.</span>}
          </div>
        )}
        <div className="field full">
          <label>{kind === 'income' ? 'Data do primeiro recebimento' : 'Data do primeiro vencimento'}</label>
          <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <span className="tiny">Todas as próximas datas são contadas a partir daqui.</span>
        </div>
        <div className="field full">
          <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={noEnd} onChange={e => setNoEnd(e.target.checked)} />
            <span className="tiny">Sem data final (repete indefinidamente)</span>
          </label>
          {!noEnd && (
            <input type="date" className="input" style={{ marginTop: 8 }} value={endDate} onChange={e => setEndDate(e.target.value)} />
          )}
        </div>
      </div>

      {preview.length > 0 && (
        <div className="card" style={{ padding: '10px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
          <p className="tiny" style={{ margin: 0, fontWeight: 650 }}>{description}</p>
          <p className="tiny" style={{ margin: '4px 0 0' }}>
            Próximas: {preview.map(d => fromISO(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })).join(' · ')}
          </p>
          <p className="tiny" style={{ margin: '4px 0 0' }}>
            {kind === 'income'
              ? 'Cadastrar aqui é só uma previsão — o saldo só muda quando você confirmar o recebimento.'
              : 'Cadastrar aqui é só uma previsão — o saldo só muda quando você confirmar o pagamento.'}
          </p>
        </div>
      )}

      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>Salvar</button>

      <ConfirmDialog
        open={askReceived}
        onClose={() => setAskReceived(false)}
        title={kind === 'income' ? 'Você já recebeu esta entrada neste período?' : 'Esta conta já foi paga neste período?'}
        text={`${sentenceCase(name)} de ${fmtBRL(parseMoney(amount) || 0)} com ${kind === 'income' ? 'recebimento' : 'vencimento'} em ${fromISO(startDate).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}. Registrar agora cria uma única movimentação e atualiza o saldo; as próximas ocorrências continuam apenas previstas.`}
        actions={[
          { label: kind === 'income' ? 'Cadastrar e registrar recebimento' : 'Cadastrar e registrar pagamento', onClick: saveAndRegister, tone: 'primary' },
          { label: 'Cadastrar apenas como previsto', onClick: () => saveOnly() },
        ]}
      />
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
      <div className="field"><label>Limite mensal (R$)</label><MoneyInput autoFocus value={limit} onChange={setLimit} /></div>
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
        description: description || 'Guardado', date: todayISO(), time: nowPaymentTime(),
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
        <MoneyInput autoFocus value={amount} onChange={setAmount} style={{ fontSize: '1.4rem', fontWeight: 700 }} />
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
      const tx: Transaction = { id: uid(), type: mode, amount: v, category: mode === 'income' ? defaultIncomeCategory(state.settings) : 'outros-out', date: todayISO(), time: nowPaymentTime(), source: 'quick' }
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
