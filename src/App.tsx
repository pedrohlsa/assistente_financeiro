import React, { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { StoreProvider, useStore } from './store/store'
import { isDriver } from './services/profile'
import { syncNotifications } from './services/notifications'
import { ToastProvider } from './components/ui'
import { BottomNav, Fab } from './components/nav'
import Home from './screens/Home'
import Transactions from './screens/Transactions'
import Chat from './screens/Chat'
import Goals from './screens/Goals'
import More from './screens/More'
import Analytics from './screens/Analytics'
import VehicleScreen from './screens/Vehicle'
import RideAnalyzer from './screens/RideAnalyzer'
import Planning from './screens/Planning'
import Cards from './screens/Cards'
import SettingsScreen from './screens/Settings'
import Onboarding from './screens/Onboarding'

function Shell() {
  const { state } = useStore()

  useEffect(() => {
    document.documentElement.dataset.theme = state.settings.theme === 'dark' ? 'dark' : 'light'
  }, [state.settings.theme])

  // Reagenda as notificações de contas/entradas quando algo relevante muda.
  useEffect(() => {
    if (state.settings.onboarded) syncNotifications(state)
  }, [state.recurring, state.settings.notifications, state.settings.onboarded])

  if (!state.settings.onboarded) return <Onboarding />

  // Rotas exclusivas de motorista: acesso direto por outro perfil volta pra Home.
  const driverMode = isDriver(state.settings)

  return (
    <>
      <div className="app-shell">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/movimentacoes" element={<Transactions />} />
          <Route path="/assistente" element={<Chat />} />
          <Route path="/metas" element={<Goals />} />
          <Route path="/mais" element={<More />} />
          <Route path="/analises" element={<Analytics />} />
          <Route path="/veiculo" element={driverMode ? <VehicleScreen /> : <Navigate to="/" replace />} />
          <Route path="/corrida" element={driverMode ? <RideAnalyzer /> : <Navigate to="/" replace />} />
          <Route path="/planejamento" element={<Planning />} />
          <Route path="/cartoes" element={<Cards />} />
          <Route path="/config" element={<SettingsScreen />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </div>
      <Fab />
      <BottomNav />
    </>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <ToastProvider>
        <HashRouter>
          <Shell />
        </HashRouter>
      </ToastProvider>
    </StoreProvider>
  )
}
