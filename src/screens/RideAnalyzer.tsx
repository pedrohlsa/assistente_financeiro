// Analisador de corrida "Vale a pena?" (seção 20)
import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import { analyzeRide, kmCost } from '../services/calc'
import { fmtBRL, fmtNum, parseMoney } from '../utils/format'

export default function RideAnalyzer() {
  const { state } = useStore()
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [pickup, setPickup] = useState('')
  const [ride, setRide] = useState('')
  const [minutes, setMinutes] = useState('')

  const v = parseMoney(value), p = parseMoney(pickup) || 0, r = parseMoney(ride), min = parseMoney(minutes) || 0
  const result = useMemo(() => (v > 0 && r > 0 ? analyzeRide(state, v, p, r, min || ((p + r) / 28) * 60) : null), [state, v, p, r, min])
  const kc = kmCost(state)

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Vale a pena?</h1>
      </div>
      <p className="muted small" style={{ marginBottom: 14 }}>Analise uma corrida antes de aceitar, usando os custos reais do seu carro ({fmtBRL(kc.total)}/km).</p>

      <div className="card">
        <div className="form-grid">
          <div className="field"><label>Valor da corrida (R$)</label><input className="input" inputMode="decimal" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="28,00" /></div>
          <div className="field"><label>KM até o passageiro</label><input className="input" inputMode="decimal" value={pickup} onChange={e => setPickup(e.target.value)} placeholder="2" /></div>
          <div className="field"><label>KM da corrida</label><input className="input" inputMode="decimal" value={ride} onChange={e => setRide(e.target.value)} placeholder="12,4" /></div>
          <div className="field"><label>Tempo estimado (min)</label><input className="input" inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="opcional" /></div>
        </div>
      </div>

      {result && (
        <div className="card celebrate" style={{
          borderColor: result.tone === 'positive' ? 'var(--positive)' : result.tone === 'warning' ? 'var(--warning)' : 'var(--negative)',
          borderWidth: 1.5,
        }}>
          <div className="spread">
            <h2>{result.rating === 'Excelente' ? '🤩' : result.rating === 'Boa' ? '😀' : result.rating === 'Aceitável' ? '😐' : result.rating === 'Ruim' ? '😕' : '😫'} {result.rating === 'Boa' ? 'Boa corrida' : result.rating}</h2>
            <span className={`badge ${result.tone === 'positive' ? 'pos' : result.tone === 'warning' ? 'warn' : 'neg'}`}>{fmtNum(result.totalKm)} km total</span>
          </div>
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="mini-card"><div className="mini-value">{fmtBRL(result.grossPerKm)}</div><div className="mini-label">R$/km bruto</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(result.netPerKm)}</div><div className="mini-label">R$/km líquido</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(result.profit)}</div><div className="mini-label">Lucro estimado</div></div>
            <div className="mini-card"><div className="mini-value">{fmtBRL(result.profitPerHour)}</div><div className="mini-label">Lucro por hora</div></div>
          </div>
          <p className="tiny" style={{ marginTop: 12 }}>
            Referências suas: mínimo {fmtBRL(kc.minRecommended)}/km · confortável {fmtBRL(kc.comfort)}/km. Configure em Mais → Configurações.
          </p>
        </div>
      )}
    </div>
  )
}
