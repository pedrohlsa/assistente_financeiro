// Bottom navigation + FAB + Bottom sheet de ações rápidas (seções 4 e 31)
import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import { activeTab } from '../services/navigation'
import { Icon, Sheet } from './ui'
import { TransactionForm, WorkForm, FuelForm, MaintenanceForm, GoalForm, RecurringForm, QuickAdd, SavingForm, BudgetForm } from './forms'
import { CardChargeForm, CardForm, FinancedInflowForm, PurchaseForm, StandalonePlanForm } from './cardForms'

const tabs = [
  { to: '/', label: 'Início', icon: Icon.home },
  { to: '/movimentacoes', label: 'Movim.', icon: Icon.list },
  { to: '/assistente', label: '', icon: Icon.spark, ai: true },
  { to: '/metas', label: 'Metas', icon: Icon.target },
  { to: '/mais', label: 'Mais', icon: Icon.more },
]

export function BottomNav() {
  const location = useLocation()
  // Uma decisão só, tomada em `services/navigation.ts`. `NavLink` foi trocado
  // por `Link` de propósito: o `isActive` dele é uma SEGUNDA fonte de verdade,
  // e as telas abertas pela aba "Mais" não têm rota própria na barra.
  const current = activeTab(location.pathname)
  return (
    <nav className="bottom-nav">
      {tabs.map(t => {
        const isActive = current === t.to
        return (
          <Link
            key={t.to} to={t.to}
            className={t.ai ? 'nav-ai' : 'nav-item' + (isActive ? ' active' : '')}
            aria-current={isActive ? 'page' : undefined}
            aria-label={t.ai ? 'Assistente IA' : t.label}
          >
            {t.icon}
            {t.label && <span>{t.label}</span>}
          </Link>
        )
      })}
    </nav>
  )
}

type SheetKind =
  | null | 'menu' | 'quick' | 'income' | 'expense' | 'work' | 'fuel' | 'maintenance'
  | 'goal' | 'recurring' | 'income-fixed' | 'saving' | 'budget'
  | 'card' | 'purchase' | 'plan' | 'financed' | 'charge'

interface FabAction { label: string; icon: string; kind: Exclude<SheetKind, null | 'menu'> }

/**
 * O + é a ação principal DO CONTEXTO, não um menu global repetido em toda tela.
 * `null` = esconder o botão; um único item = abre direto, sem menu intermediário.
 */
function actionsForRoute(path: string, isDriver: boolean): FabAction[] | null {
  const money: FabAction[] = [
    { label: 'Registro rápido', icon: '⚡', kind: 'quick' },
    { label: 'Adicionar receita', icon: '💵', kind: 'income' },
    { label: 'Adicionar despesa', icon: '🧾', kind: 'expense' },
  ]

  if (path === '/') {
    return [
      ...money,
      ...(isDriver
        ? [
            { label: 'Registrar trabalho', icon: '🚗', kind: 'work' as const },
            { label: 'Abastecimento', icon: '⛽', kind: 'fuel' as const },
            { label: 'Manutenção', icon: '🔧', kind: 'maintenance' as const },
          ]
        : [
      { label: 'Entrada recorrente (salário, aluguel…)', icon: '🔑', kind: 'income-fixed' as const },
            { label: 'Guardar dinheiro', icon: '🏦', kind: 'saving' as const },
          ]),
      { label: 'Conta a pagar', icon: '📄', kind: 'recurring' },
      { label: 'Nova meta', icon: '🎯', kind: 'goal' },
    ]
  }
  if (path.startsWith('/movimentacoes')) {
    return [
      { label: 'Receita', icon: '💵', kind: 'income' },
      { label: 'Despesa', icon: '🧾', kind: 'expense' },
      { label: 'Registro rápido', icon: '⚡', kind: 'quick' },
    ]
  }
  // Uma ação só: o + abre o formulário direto, sem menu intermediário.
  if (path.startsWith('/metas')) return [{ label: 'Nova meta', icon: '🎯', kind: 'goal' }]
  if (path.startsWith('/cartoes')) {
    return [
      { label: 'Nova compra', icon: '🛍️', kind: 'purchase' },
      { label: 'Novo cartão', icon: '💳', kind: 'card' },
      { label: 'Novo parcelamento', icon: '🧾', kind: 'plan' },
      { label: 'Entrada financiada', icon: '💸', kind: 'financed' },
      { label: 'Nova assinatura', icon: '📱', kind: 'charge' },
    ]
  }
  if (path.startsWith('/planejamento')) {
    return [
      { label: 'Conta a pagar', icon: '📄', kind: 'recurring' },
      { label: 'Entrada recorrente', icon: '🔑', kind: 'income-fixed' },
      { label: 'Novo orçamento', icon: '🎯', kind: 'budget' },
    ]
  }
  // Assistente (o + atrapalha o campo de texto), configurações, análises,
  // veículo e corrida: sem ação principal evidente aqui — o FAB some em vez de
  // competir com os botões que a própria tela já oferece.
  return null
}

export function Fab() {
  const { state } = useStore()
  const [sheet, setSheet] = useState<SheetKind>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const close = () => setSheet(null)
  const holdTimer = React.useRef<any>(null)
  const isDriver = state.settings.profile === 'driver'

  const actions = actionsForRoute(location.pathname, isDriver)
  if (!actions) return null
  const single = actions.length === 1 ? actions[0] : null

  return (
    <>
      <button
        className="fab" aria-label={single ? single.label : 'Adicionar'}
        onClick={() => setSheet(s => (s ? null : single ? single.kind : 'menu'))}
        onPointerDown={() => { if (!single) holdTimer.current = setTimeout(() => setSheet('quick'), 450) }}
        onPointerUp={() => clearTimeout(holdTimer.current)}
        onPointerLeave={() => clearTimeout(holdTimer.current)}
      >
        {Icon.plus}
      </button>

      <Sheet open={sheet === 'menu'} onClose={close} title="O que vamos registrar?">
        <div className="grid-2">
          {actions.map(a => (
            <button key={a.label} className="mini-card tappable" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', display: 'flex', alignItems: 'center', gap: 10 }}
              onClick={() => setSheet(a.kind)}>
              <span style={{ fontSize: '1.3rem' }}>{a.icon}</span>
              <span style={{ fontWeight: 650, fontSize: '0.86rem' }}>{a.label}</span>
            </button>
          ))}
        </div>
        {actions.some(a => a.kind === 'quick') && (
          <p className="tiny" style={{ marginTop: 14, textAlign: 'center' }}>Dica: segure o botão + para abrir o registro rápido.</p>
        )}
      </Sheet>

      <Sheet open={sheet === 'quick'} onClose={close} title="Registro rápido"><QuickAdd onDone={close} /></Sheet>
      <Sheet open={sheet === 'income'} onClose={close} title="Nova receita"><TransactionForm type="income" onDone={close} /></Sheet>
      <Sheet open={sheet === 'expense'} onClose={close} title="Nova despesa"><TransactionForm type="expense" onDone={close} /></Sheet>
      <Sheet open={sheet === 'work'} onClose={close} title="Registrar trabalho"><WorkForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'fuel'} onClose={close} title="Abastecimento"><FuelForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'maintenance'} onClose={close} title="Manutenção"><MaintenanceForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'goal'} onClose={close} title="Nova meta"><GoalForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'recurring'} onClose={close} title="Conta a pagar"><RecurringForm onDone={close} defaultKind="expense" lockKind /></Sheet>
      <Sheet open={sheet === 'income-fixed'} onClose={close} title="Entrada recorrente"><RecurringForm onDone={close} defaultKind="income" lockKind /></Sheet>
      <Sheet open={sheet === 'saving'} onClose={close} title="Guardar dinheiro"><SavingForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'budget'} onClose={close} title="Novo orçamento"><BudgetForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'card'} onClose={close} title="Novo cartão"><CardForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'purchase'} onClose={close} title="Compra no crédito"><PurchaseForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'plan'} onClose={close} title="Parcelamento sem cartão"><StandalonePlanForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'financed'} onClose={close} title="Entrada financiada pelo cartão"><FinancedInflowForm onDone={close} /></Sheet>
      <Sheet open={sheet === 'charge'} onClose={close} title="Assinatura no cartão"><CardChargeForm onDone={close} /></Sheet>
    </>
  )
}
