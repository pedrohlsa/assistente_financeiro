// Aba "Mais" — hub de navegação (seção 4)
import React from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store/store'

const ALL_ITEMS = [
  { to: '/analises', icon: '📊', label: 'Análises e relatórios', desc: 'Evolução, categorias, comparativos, exportação' },
  { to: '/veiculo', icon: '⛽', label: 'Meu veículo', desc: 'Combustível, consumo (km/L), manutenção', driverOnly: true },
  { to: '/planejamento', icon: '📅', label: 'Planejamento', desc: 'Contas, entradas fixas, previsão 30 dias' },
  { to: '/config', icon: '⚙️', label: 'Configurações', desc: 'Perfil, tema, metas, custos, backup' },
]

export default function More() {
  const { state } = useStore()
  const isDriver = state.settings.profile === 'driver'
  const items = ALL_ITEMS.filter(i => !i.driverOnly || isDriver)
  return (
    <div className="fade-slide">
      <h1 style={{ marginBottom: 14 }}>Mais</h1>
      <div className="stack">
        {items.map(i => (
          <Link key={i.to} to={i.to} className="card tappable row" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="tx-icon">{i.icon}</div>
            <div className="grow">
              <div style={{ fontWeight: 700 }}>{i.label}</div>
              <div className="tiny">{i.desc}</div>
            </div>
            <span className="muted">›</span>
          </Link>
        ))}
      </div>
      <p className="tiny" style={{ textAlign: 'center', marginTop: 24 }}>
        AssistFin — seus dados ficam no seu aparelho{state.settings.demo ? ' · modo demonstração ativo' : ''}.
      </p>
    </div>
  )
}
