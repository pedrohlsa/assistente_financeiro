// Meu veículo: cadastro, manutenção, combustível, custo real por km (seções 19, 21, 22, 23)
import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import { fuelEfficiency, kmCost, lastFuelPrice, monthStats } from '../services/calc'
import { fmtBRL, fmtNum, fromISO, parseMoney } from '../utils/format'
import { EmptyState, Progress, Sheet, useToast } from '../components/ui'
import { FuelForm, MaintenanceForm } from '../components/forms'

export default function VehicleScreen() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const navigate = useNavigate()
  const [editingVehicle, setEditingVehicle] = useState(!state.vehicle)
  const [fuelOpen, setFuelOpen] = useState(false)
  const [maintOpen, setMaintOpen] = useState(false)
  const [brand, setBrand] = useState(state.vehicle?.brand || '')
  const [model, setModel] = useState(state.vehicle?.model || '')
  const [year, setYear] = useState(state.vehicle?.year || '')
  const [odo, setOdo] = useState(state.vehicle ? String(state.vehicle.odometer) : '')
  const [averageDailyKm, setAverageDailyKm] = useState(state.vehicle?.averageDailyKm ? String(state.vehicle.averageDailyKm) : '')

  const kc = useMemo(() => kmCost(state), [state])
  const eff = useMemo(() => fuelEfficiency(state), [state])
  const price = lastFuelPrice(state)
  const m = monthStats(state)
  const odometer = state.vehicle?.odometer || 0

  const saveVehicle = () => {
    dispatch({ type: 'setVehicle', v: { brand, model, year, odometer: parseMoney(odo) || 0, averageDailyKm: parseMoney(averageDailyKm) || undefined } })
    setEditingVehicle(false)
    toast({ text: 'Veículo salvo.' })
  }

  // consumo em queda? (seção 21)
  const consumptionAlert = useMemo(() => {
    const recs = [...state.fuelRecords].filter(f => f.odometer && f.liters > 0).sort((a, b) => a.odometer! - b.odometer!)
    if (recs.length < 4) return null
    const half = Math.floor(recs.length / 2)
    const calc = (list: typeof recs) => {
      let km = 0, l = 0
      for (let i = 1; i < list.length; i++) { km += list[i].odometer! - list[i - 1].odometer!; l += list[i].liters }
      return l > 0 ? km / l : 0
    }
    const before = calc(recs.slice(0, half + 1)), after = calc(recs.slice(half))
    if (before > 0 && after > 0 && after < before * 0.93)
      return `Seu consumo caiu de ${fmtNum(before)} km/L para ${fmtNum(after)} km/L. Vale checar calibragem e filtros.`
    return null
  }, [state.fuelRecords])

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Meu veículo</h1>
      </div>

      {/* CADASTRO */}
      {editingVehicle ? (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{state.vehicle ? 'Editar veículo' : 'Cadastrar veículo'}</h3>
          <div className="form-grid">
            <div className="field"><label>Marca</label><input className="input" value={brand} onChange={e => setBrand(e.target.value)} placeholder="Chevrolet" /></div>
            <div className="field"><label>Modelo</label><input className="input" value={model} onChange={e => setModel(e.target.value)} placeholder="Onix" /></div>
            <div className="field"><label>Ano</label><input className="input" inputMode="numeric" value={year} onChange={e => setYear(e.target.value)} placeholder="2021" /></div>
            <div className="field"><label>Hodômetro atual</label><input className="input" inputMode="numeric" value={odo} onChange={e => setOdo(e.target.value)} placeholder="80000" /></div>
            <div className="field full"><label>Média de km por dia (opcional)</label><input className="input" inputMode="decimal" value={averageDailyKm} onChange={e => setAverageDailyKm(e.target.value)} placeholder="ex.: 180" /></div>
          </div>
          <p className="tiny" style={{ marginTop: 10 }}>O hodômetro fica no cadastro do carro e nunca entra como “km trabalhados”. A média diária serve apenas para estimar quando uma manutenção pode chegar.</p>
          <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={saveVehicle} disabled={!model}>Salvar</button>
        </div>
      ) : (
        <div className="card tappable" onClick={() => setEditingVehicle(true)}>
          <div className="row">
            <div className="tx-icon">🚗</div>
            <div className="grow">
              <h3>{state.vehicle!.brand} {state.vehicle!.model} {state.vehicle!.year}</h3>
              <p className="tiny">Hodômetro: {fmtNum(odometer, 0)} km · toque para editar</p>
            </div>
          </div>
        </div>
      )}

      {/* CUSTO REAL POR KM (seção 23) */}
      <div className="card">
        <h3 className="muted" style={{ marginBottom: 10 }}>Custo real por km</h3>
        <div className="stack small">
          <div className="spread"><span className="muted">Combustível</span><span className="mono-num">{fmtBRL(kc.fuelPerKm)}/km</span></div>
          <div className="spread"><span className="muted">Manutenção e desgaste</span><span className="mono-num">{fmtBRL(kc.maintenancePerKm)}/km</span></div>
          <div className="spread"><span className="muted">Custos fixos (seguro, IPVA...)</span><span className="mono-num">{fmtBRL(kc.fixedPerKm)}/km</span></div>
          <div className="divider" />
          <div className="spread" style={{ fontWeight: 700 }}><span>Custo operacional</span><span className="mono-num">{fmtBRL(kc.operational)}/km</span></div>
          <div className="spread" style={{ fontWeight: 700 }}><span>Custo total</span><span className="mono-num">{fmtBRL(kc.total)}/km</span></div>
        </div>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="mini-card" style={{ background: 'var(--warning-soft)', border: 'none' }}>
            <div className="mini-value">{fmtBRL(kc.minRecommended)}</div><div className="mini-label">Mínimo recomendado/km</div>
          </div>
          <div className="mini-card" style={{ background: 'var(--positive-soft)', border: 'none' }}>
            <div className="mini-value">{fmtBRL(kc.comfort)}</div><div className="mini-label">Meta confortável/km</div>
          </div>
        </div>
        <p className="tiny" style={{ marginTop: 10 }}>
          {kc.total > 0
            ? 'Estimativa com base somente nos seus abastecimentos, manutenções, km registrados e custos configurados.'
            : 'Ainda não há dados suficientes. Os custos ficam zerados até você registrar abastecimentos, km, manutenções ou valores manuais.'}
        </p>
      </div>

      {/* COMBUSTÍVEL (seção 21) */}
      <div className="section-title">
        <h2>Combustível</h2>
        <button className="link" onClick={() => setFuelOpen(true)}>+ Abastecimento</button>
      </div>
      <div className="grid-3">
        <div className="mini-card"><div className="mini-value">{eff ? fmtNum(eff) : '—'}</div><div className="mini-label">km/L real</div></div>
        <div className="mini-card"><div className="mini-value">{price ? fmtBRL(price) : '—'}</div><div className="mini-label">Último preço/L</div></div>
        <div className="mini-card"><div className="mini-value">{fmtBRL(kc.fuelPerKm)}</div><div className="mini-label">Custo/km</div></div>
      </div>
      {consumptionAlert && (
        <div className="card" style={{ marginTop: 12, borderColor: 'var(--warning)' }}>
          <div className="row"><span style={{ fontSize: '1.2rem' }}>⚠️</span><p className="small">{consumptionAlert}</p></div>
        </div>
      )}
      {state.fuelRecords.length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: '4px 16px' }}>
          {[...state.fuelRecords].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6).map(f => (
            <div key={f.id} className="row list-item">
              <div className="tx-icon">⛽</div>
              <div className="grow">
                <div style={{ fontWeight: 650, fontSize: '0.9rem' }}>{fmtBRL(f.amount)} · {fmtNum(f.liters)} L</div>
                <div className="tiny">{fromISO(f.date).toLocaleDateString('pt-BR')} · {fmtBRL(f.pricePerLiter)}/L{f.station ? ` · ${f.station}` : ''}{f.odometer ? ` · ${fmtNum(f.odometer, 0)} km` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MANUTENÇÃO (seção 22) */}
      <div className="section-title">
        <h2>Manutenção</h2>
        <button className="link" onClick={() => setMaintOpen(true)}>+ Registrar</button>
      </div>
      {state.maintenance.length === 0 ? (
        <div className="card">
          <EmptyState emoji="🔧" text='Nenhuma manutenção registrada. Diga ao assistente: "troquei o óleo por 280 com 84 mil km".' cta="Registrar manutenção" onCta={() => setMaintOpen(true)} />
        </div>
      ) : (
        <div className="stack">
          {state.maintenance.map(mi => {
            const used = Math.max(odometer - mi.kmInstalled, 0)
            const hasLife = mi.lifeKm > 0
            const pct = hasLife ? Math.min((used / mi.lifeKm) * 100, 100) : 0
            const next = mi.kmInstalled + mi.lifeKm
            const status = !hasLife ? 'Sem projeção' : pct >= 100 ? 'Troca vencida!' : pct >= 80 ? 'Troca próxima' : 'Em dia'
            const kmLeft = Math.max(next - odometer, 0)
            const daysLeft = hasLife && (state.vehicle?.averageDailyKm || 0) > 0 ? Math.ceil(kmLeft / state.vehicle!.averageDailyKm!) : 0
            const reservePerDay = hasLife && (state.vehicle?.averageDailyKm || 0) > 0 ? (mi.cost / mi.lifeKm) * state.vehicle!.averageDailyKm! : 0
            return (
              <div key={mi.id} className="card" style={{ padding: '14px 16px' }}>
                <div className="spread">
                  <h3>{mi.name}</h3>
                  <span className={`badge ${!hasLife ? 'neutral' : pct >= 100 ? 'neg' : pct >= 80 ? 'warn' : 'pos'}`}>{status}</span>
                </div>
                {hasLife ? (
                  <>
                    <p className="tiny" style={{ margin: '4px 0 8px' }}>
                      {fmtNum(used, 0)} / {fmtNum(mi.lifeKm, 0)} km · próxima troca aos {fmtNum(next, 0)} km · custo diluído {fmtBRL(mi.cost / mi.lifeKm)}/km
                    </p>
                    <Progress pct={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : undefined} />
                    {daysLeft > 0 && <p className="tiny" style={{ marginTop: 7 }}>Pela sua média diária: cerca de {daysLeft} dias · reserve aproximadamente {fmtBRL(reservePerDay)}/dia.</p>}
                  </>
                ) : (
                  <p className="tiny" style={{ margin: '4px 0 8px' }}>Vida útil não informada. O registro fica salvo, mas não há projeção de troca nem valor sugerido para reservar.</p>
                )}
                <div className="spread" style={{ marginTop: 8 }}>
                  <span className="tiny">Instalado aos {fmtNum(mi.kmInstalled, 0)} km por {fmtBRL(mi.cost)}</span>
                  <button className="link tiny" onClick={() => dispatch({ type: 'removeMaintenance', id: mi.id })}>Remover</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* MODO MOTORISTA — resumo mês (seção 19) */}
      {m.km > 0 && (
        <>
          <div className="section-title"><h2>Este mês na direção</h2></div>
          <div className="grid-3">
            <div className="mini-card"><div className="mini-value">{fmtNum(m.km, 0)}</div><div className="mini-label">km rodados</div></div>
            <div className="mini-card"><div className="mini-value">{fmtNum(m.trips, 0)}</div><div className="mini-label">viagens</div></div>
            <div className="mini-card"><div className="mini-value">{fmtNum(m.hours, 0)}h</div><div className="mini-label">horas trabalhadas</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(m.grossPerKm)}</div><div className="mini-label">R$/km bruto</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(m.netPerKm)}</div><div className="mini-label">R$/km líquido</div></div>
            <div className="mini-card"><div className="mini-value">{m.tripsWithIncome > 0 ? fmtBRL(m.perTrip) : '—'}</div><div className="mini-label">média/viagem</div></div>
          </div>
        </>
      )}

      <Sheet open={fuelOpen} onClose={() => setFuelOpen(false)} title="Abastecimento"><FuelForm onDone={() => setFuelOpen(false)} /></Sheet>
      <Sheet open={maintOpen} onClose={() => setMaintOpen(false)} title="Manutenção"><MaintenanceForm onDone={() => setMaintOpen(false)} /></Sheet>
    </div>
  )
}
