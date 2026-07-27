// Onboarding em 4 telas (seção 33)
import React, { useState } from 'react'
import { useStore } from '../store/store'
import { parseMoney, todayISO, uid } from '../utils/format'
import { MoneyInput } from '../components/ui'

const PROFILES = [
  { id: 'driver', label: '🚗 Motorista de aplicativo', hint: 'Corridas, km, combustível e meta diária.' },
  { id: 'autonomo', label: '🧰 Autônomo / renda própria', hint: 'Aluguéis, serviços, vendas ou outras rendas próprias.' },
  { id: 'clt', label: '💼 CLT / salário fixo', hint: 'Salário, contas do mês e quanto dá para guardar.' },
  { id: 'other', label: '✨ Outro tipo de renda', hint: 'Controle financeiro pessoal, do seu jeito.' },
] as const

const PRIORITIES = [
  'Controlar gastos', 'Ganhar mais', 'Sair das dívidas', 'Comprar algo', 'Entender meu dinheiro',
]

export default function Onboarding() {
  const { dispatch } = useStore()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [profile, setProfile] = useState<typeof PROFILES[number]['id']>('driver')
  const [priority, setPriority] = useState('')
  const [goalName, setGoalName] = useState('')
  const [goalValue, setGoalValue] = useState('')
  const [goalDeadline, setGoalDeadline] = useState('')

  const hasName = !!goalName.trim()
  const hasValue = parseMoney(goalValue) > 0
  // Vazio dos dois lados = pular. Só um preenchido = incompleto, não conclui em silêncio.
  const goalState: 'empty' | 'complete' | 'partial' =
    !hasName && !hasValue ? 'empty' : hasName && hasValue ? 'complete' : 'partial'

  const finish = () => {
    if (goalState === 'partial') return
    const isDriver = profile === 'driver'
    dispatch({
      type: 'settings',
      patch: {
        name: name.trim(), profile, priority, onboarded: true,
        homeCards: isDriver ? ['km', 'trips', 'netkm', 'perhour'] : [],
        workDays: profile === 'clt' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6],
        // Motorista pensa por dia; os outros perfis, por mês (item 36).
        goalCadence: isDriver ? 'daily' : 'monthly',
      },
    })
    if (goalState === 'complete') {
      dispatch({
        type: 'addGoal',
        g: {
          id: uid(), name: goalName.trim(), target: parseMoney(goalValue), saved: 0,
          // Sem prazo informado = sem prazo. Nunca inventamos 90 dias.
          deadline: goalDeadline || undefined,
          createdAt: todayISO(),
        },
      })
    }
  }

  return (
    <div className="app-shell" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh', paddingBottom: 24 }}>
      <div className="card" style={{ padding: 26 }}>
        {step === 0 && (
          <div className="stack fade-slide">
            <div style={{ fontSize: '2.6rem' }}>✦</div>
            <h1>Vamos organizar sua vida financeira.</h1>
            <p className="muted">Eu cuido dos seus números enquanto você cuida da sua rotina. Sem planilhas, sem complicação — é só me contar o que aconteceu.</p>
            <div className="field">
              <label>Como posso te chamar?</label>
              <input className="input" autoFocus placeholder="Seu nome" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-block" onClick={() => setStep(1)}>Começar</button>
          </div>
        )}

        {step === 1 && (
          <div className="stack fade-slide">
            <h1>Como você ganha dinheiro?</h1>
            {PROFILES.map(p => (
              <button key={p.id} className={`btn btn-block ${profile === p.id ? 'btn-primary' : 'btn-soft'}`}
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'left', height: 'auto', paddingTop: 12, paddingBottom: 12 }}
                onClick={() => { setProfile(p.id); setStep(2) }}>
                <span>{p.label}</span>
                <span style={{ fontSize: '0.74rem', opacity: 0.75, fontWeight: 500 }}>{p.hint}</span>
              </button>
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="stack fade-slide">
            <h1>Qual é sua principal prioridade?</h1>
            {PRIORITIES.map(p => (
              <button key={p} className={`btn btn-block ${priority === p ? 'btn-primary' : 'btn-soft'}`} onClick={() => { setPriority(p); setStep(3) }}>
                {p}
              </button>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="stack fade-slide">
            <h1>Tem alguma meta em mente?</h1>
            <p className="muted small">Opcional — dá para criar depois com um simples "quero comprar um celular de 5000 em 6 meses".</p>
            <div className="form-grid">
              <div className="field"><label>O que?</label><input className="input" placeholder="ex.: iPhone" value={goalName} onChange={e => setGoalName(e.target.value)} /></div>
              <div className="field"><label>Valor (R$)</label><MoneyInput value={goalValue} onChange={setGoalValue} /></div>
              <div className="field full"><label>Prazo desejado (opcional)</label>
                <input type="date" className="input" value={goalDeadline} onChange={e => setGoalDeadline(e.target.value)} />
              </div>
            </div>
            {goalState === 'partial' && (
              <p className="tiny" style={{ color: 'var(--warning)' }}>
                Informe o nome e o valor da meta ou deixe os dois campos vazios para pular.
              </p>
            )}
            <button className="btn btn-primary btn-block" disabled={goalState === 'partial'} onClick={finish}>
              {goalState === 'complete' ? 'Concluir' : 'Pular por agora'}
            </button>
          </div>
        )}

        {step > 0 && (
          <button className="link" style={{ marginTop: 16 }} onClick={() => setStep(s => s - 1)}>‹ Voltar</button>
        )}
      </div>
    </div>
  )
}
