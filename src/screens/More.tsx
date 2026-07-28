// Aba "Mais" — hub de navegação (seção 4)
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store/store'
import { kmCost } from '../services/calc'
import { RideOverlayStatus, rideOverlay, rideOverlayAvailable } from '../services/rideOverlay'
import { useToast } from '../components/ui'

const ALL_ITEMS = [
  { to: '/analises', icon: '📊', label: 'Análises e relatórios', desc: 'Evolução, categorias, comparativos, exportação' },
  { to: '/veiculo', icon: '⛽', label: 'Meu veículo', desc: 'Combustível, consumo (km/L), manutenção', driverOnly: true },
  { to: '/planejamento', icon: '📅', label: 'Planejamento', desc: 'Contas, entradas recorrentes, previsão 30 dias' },
  { to: '/cartoes', icon: '💳', label: 'Cartões e parcelamentos', desc: 'Faturas, parcelas, limites e projeções futuras' },
  { to: '/config', icon: '⚙️', label: 'Configurações', desc: 'Perfil, tema, metas, custos, backup' },
]

export default function More() {
  const { state } = useStore()
  const toast = useToast()
  const isDriver = state.settings.profile === 'driver'
  const items = ALL_ITEMS.filter(i => !i.driverOnly || isDriver)
  const [overlayStatus, setOverlayStatus] = useState<RideOverlayStatus | null>(null)
  const overlayAvailable = rideOverlayAvailable() && isDriver
  const costs = useMemo(() => kmCost(state), [state])
  const refreshOverlay = useCallback(async () => {
    if (!overlayAvailable) return
    try { setOverlayStatus(await rideOverlay.getStatus()) } catch { setOverlayStatus(null) }
  }, [overlayAvailable])

  useEffect(() => {
    refreshOverlay()
    window.addEventListener('focus', refreshOverlay)
    return () => window.removeEventListener('focus', refreshOverlay)
  }, [refreshOverlay])

  const startOverlay = async () => {
    if (!overlayStatus?.overlayPermission) {
      await rideOverlay.openOverlaySettings()
      toast({ text: 'Permita que o AssistFin apareça sobre outros apps e volte aqui.' })
      return
    }
    if (!overlayStatus.notificationAccess) {
      await rideOverlay.openNotificationSettings()
      toast({ text: 'Ative “Ofertas de corrida no AssistFin” e volte aqui.' })
      return
    }
    try {
      await rideOverlay.start({ costPerKm: costs.total, minPerKm: costs.minRecommended })
      await refreshOverlay()
      toast({ text: 'Analisador flutuante ativado.' })
    } catch {
      toast({ text: 'Não foi possível ativar. Confira as duas permissões.' })
    }
  }

  const stopOverlay = async () => {
    await rideOverlay.stop()
    await refreshOverlay()
    toast({ text: 'Analisador flutuante desativado.' })
  }

  return (
    <div className="fade-slide">
      <h1 style={{ marginBottom: 14 }}>Mais</h1>
      {overlayAvailable && (
        <div className="card" style={{ marginBottom: 14, borderColor: overlayStatus?.running ? 'var(--accent)' : undefined }}>
          <div className="spread">
            <div>
              <h3>Analisador flutuante de corridas</h3>
              <p className="tiny" style={{ marginTop: 4 }}>{overlayStatus?.running ? 'Ativo sobre os outros apps' : 'Desativado'}</p>
            </div>
            <span className={`badge ${overlayStatus?.running ? 'pos' : 'neutral'}`}>{overlayStatus?.running ? 'Ativo' : 'Inativo'}</span>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Mostra um painel sobre Uber, 99 e inDrive. Quando a oferta chega por
            notificação com valor e distância, calcula R$/km e desconta o custo
            do veículo configurado neste aparelho.
          </p>
          <p className="tiny" style={{ marginTop: 8 }}>
            O recurso é local e opcional: não envia notificações para servidor e não
            lê senhas nem a tela inteira. Se a plataforma não incluir os dados na
            notificação, toque no painel e use o analisador manual.
          </p>
          <div className="suggestion-row" style={{ marginTop: 12 }}>
            {!overlayStatus?.overlayPermission && <button className="btn btn-soft btn-sm" onClick={() => rideOverlay.openOverlaySettings()}>1. Permitir sobreposição</button>}
            {!overlayStatus?.notificationAccess && <button className="btn btn-soft btn-sm" onClick={() => rideOverlay.openNotificationSettings()}>2. Permitir notificações</button>}
            {overlayStatus?.running
              ? <button className="btn btn-danger-soft btn-sm" onClick={stopOverlay}>Desativar painel</button>
              : <button className="btn btn-primary btn-sm" onClick={startOverlay}>Ativar painel</button>}
          </div>
        </div>
      )}
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
