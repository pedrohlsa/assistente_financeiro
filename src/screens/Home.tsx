// Tela inicial / "Hoje" (seções 5, 6, 7, 15, 18, 40, 41)
import React, { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../store/store'
import { dailyGoal, generateInsights, notifications, todayStats, weekStats, avgDailyProfit, kmCost, periodStats, balanceOutlook, monthStats, forecast30, upcomingIncomes, monthlySavingGoal, upcomingBills, monthForecast } from '../services/calc'
import { fmtBRL, fmtNum, greeting, todayISO, addDays, dueLabel, parseMoney } from '../utils/format'
import { sentenceCase } from '../utils/text'
import { MoneyInput, Progress, EmptyState } from '../components/ui'
import PendingRecurrings from '../components/PendingRecurrings'
import { uid } from '../utils/format'

const ALL_CARDS: { id: string; label: string; value: (s: any, ts: any, kc: any) => string }[] = [
  { id: 'km', label: 'KM rodados', value: (_s, ts) => fmtNum(ts.km, 0) + ' km' },
  { id: 'trips', label: 'Viagens', value: (_s, ts) => fmtNum(ts.trips, 0) },
  { id: 'grosskm', label: 'R$/KM bruto', value: (_s, ts) => fmtBRL(ts.grossPerKm) },
  { id: 'netkm', label: 'R$/KM líquido', value: (_s, ts) => fmtBRL(ts.netPerKm) },
  { id: 'costkm', label: 'Custo por KM', value: (_s, _ts, kc) => fmtBRL(kc.total) },
  { id: 'minkm', label: 'Mínimo por KM', value: (_s, _ts, kc) => fmtBRL(kc.minRecommended) },
  { id: 'pertrip', label: 'Média por viagem', value: (_s, ts) => fmtBRL(ts.perTrip) },
  { id: 'perhour', label: 'Lucro por hora', value: (_s, ts) => fmtBRL(ts.profitPerHour) },
  { id: 'hours', label: 'Horas trabalhadas', value: (_s, ts) => fmtNum(ts.hours) + 'h' },
]

export default function Home() {
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const [metric, setMetric] = useState<'profit' | 'balance' | 'gross'>('profit')
  const [customizing, setCustomizing] = useState(false)
  const [editingBalance, setEditingBalance] = useState(false)
  const [balanceInput, setBalanceInput] = useState('')
  const [showMath, setShowMath] = useState(false)
  const [showForecastMath, setShowForecastMath] = useState(false)

  const isDriver = state.settings.profile === 'driver'
  const ts = useMemo(() => todayStats(state), [state])
  const goal = useMemo(() => dailyGoal(state), [state])
  const insights = useMemo(() => generateInsights(state), [state])
  const alerts = useMemo(() => notifications(state), [state])
  const kc = useMemo(() => kmCost(state), [state])
  const week = useMemo(() => weekStats(state), [state])
  const month = useMemo(() => monthStats(state), [state])
  const fc = useMemo(() => forecast30(state), [state])
  const incomes = useMemo(() => upcomingIncomes(state, 30), [state])
  const bills30 = useMemo(() => upcomingBills(state, 30), [state])
  const msg = useMemo(() => monthlySavingGoal(state), [state])
  const mfc = useMemo(() => monthForecast(state), [state])

  const pct = goal.total > 0 ? Math.round((ts.profit / goal.total) * 100) : 0
  const avg = avgDailyProfit(state)

  const headline = useMemo(() => {
    if (!isDriver) {
      const sobra = month.income - month.expense
      if (month.income === 0 && month.expense === 0) return 'Vamos organizar suas contas do mês?'
      return sobra >= 0
        ? `Este mês você está no azul: sobrou ${fmtBRL(sobra)} até agora.`
        : `Atenção: este mês você já gastou ${fmtBRL(-sobra)} a mais do que entrou.`
    }
    if (ts.income === 0 && ts.expense === 0) return 'Pronto para começar o dia?'
    if (ts.profit >= goal.total && goal.total > 0) return `Meta batida! Você superou sua meta em ${fmtBRL(ts.profit - goal.total)}. 🎉`
    if (ts.hours > 1 && ts.profit > 0) {
      const pace = ts.profit / ts.hours
      const projected = ts.profit + pace * 3
      if (projected >= goal.total) return `Se mantiver seu ritmo atual, você deve superar sua meta em ${fmtBRL(Math.max(projected - goal.total, 0))}.`
    }
    if (goal.total > 0 && ts.profit < goal.total) return `Você está ${fmtBRL(goal.total - ts.profit)} abaixo da sua meta de hoje.`
    return 'Seu dia está indo bem.'
  }, [ts, goal, isDriver, month])

  const mainValue = metric === 'profit' ? ts.profit : metric === 'gross' ? ts.income : ts.income - ts.expense
  const mainLabel = metric === 'profit' ? 'Lucro estimado hoje' : metric === 'gross' ? 'Faturamento de hoje' : 'Saldo de hoje'

  // Déficit de ontem ainda não tratado? (seção 18)
  const yesterday = addDays(todayISO(), -1)
  const yDeficit = useMemo(() => {
    if (state.dismissedDeficitDates.includes(yesterday)) return 0
    const ys = periodStats(state, yesterday, yesterday)
    if (ys.income === 0 && ys.expense === 0) return 0 // dia sem atividade não gera déficit
    const g = dailyGoal(state)
    return Math.max(g.total - ys.profit, 0)
  }, [state, yesterday])

  const resolveDeficit = (days: number | null) => {
    if (days === null) {
      dispatch({ type: 'dismissDeficit', date: yesterday })
    } else {
      dispatch({ type: 'addDeficit', d: { id: uid(), date: yesterday, amount: yDeficit, remaining: yDeficit, perDay: yDeficit / days, daysLeft: days } })
    }
  }

  const hasData = state.transactions.length > 0 || state.workSessions.length > 0 || state.recurring.length > 0
  const cards = ALL_CARDS.filter(c => state.settings.homeCards.includes(c.id))
  const sobra = month.income - month.expense

  const outlook = useMemo(() => balanceOutlook(state, 7), [state])
  const saveBalance = () => {
    dispatch({ type: 'settings', patch: { balance: parseMoney(balanceInput) || 0 } })
    setEditingBalance(false)
  }

  return (
    <div className="fade-slide">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h1>{greeting()}{state.settings.name ? `, ${state.settings.name}` : ''}</h1>
        {state.settings.demo && <span className="badge warn">demo</span>}
      </div>
      <p className="muted small" style={{ marginBottom: 16 }}>{headline}</p>

      {/* MODO BANCO — saldo em conta */}
      <div className="card" style={{ padding: '13px 16px' }}>
        <div className="spread">
          <div>
            <div className="tiny">Saldo em conta</div>
            {editingBalance ? (
              <MoneyInput
                autoFocus
                style={{ fontSize: '1.4rem', fontWeight: 750, padding: '4px 8px', maxWidth: 180 }}
                value={balanceInput}
                onChange={setBalanceInput}
                onKeyDown={e => e.key === 'Enter' && saveBalance()}
                onBlur={saveBalance}
              />
            ) : (
              <button
                onClick={() => { setBalanceInput(state.settings.balance ? String(state.settings.balance) : ''); setEditingBalance(true) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, font: 'inherit', color: 'inherit' }}>
                <div className="big-number" style={{ fontSize: '1.6rem' }}>{fmtBRL(state.settings.balance || 0)}</div>
              </button>
            )}
          </div>
          <button className="link" onClick={() => { setBalanceInput(state.settings.balance ? String(state.settings.balance) : ''); setEditingBalance(true) }}>
            {state.settings.balance ? 'Editar' : 'Informar'}
          </button>
        </div>
        {outlook.bills.length > 0 && (
          <p className="tiny" style={{ marginTop: 8, color: outlook.ok ? 'var(--positive)' : 'var(--danger)' }}>
            {outlook.ok
              ? `✓ Cobre as contas dos próximos ${outlook.horizon} dias (${fmtBRL(outlook.billsSoon)}). Sobra ${fmtBRL(outlook.leftover)}.`
              : `⚠ ${fmtBRL(outlook.billsSoon)} em contas nos próximos ${outlook.horizon} dias — faltam ${fmtBRL(outlook.shortfall)} (${fmtBRL(outlook.needPerDay)}/dia).`}
          </p>
        )}
      </div>

      {/* CONFIRMAÇÃO DE RECORRENTES — nada é lançado sozinho (14.2) */}
      <PendingRecurrings />

      {!hasData && (
        <div className="card">
          <EmptyState emoji="🍃" text="Seu financeiro está quietinho por aqui." cta="Adicionar primeira movimentação" onCta={() => navigate('/assistente')} />
          {/* Dados de demonstração são ferramenta de desenvolvimento — nunca
              aparecem na experiência normal do usuário final. */}
          {import.meta.env.DEV && (
            <button className="btn btn-soft btn-block" onClick={() => dispatch({ type: 'loadDemo' })}>Ver com dados de demonstração (dev)</button>
          )}
        </div>
      )}

      {hasData && !isDriver && (
        <>
          {/* META MENSAL PARA GUARDAR (perfis não-motorista) */}
          <div className={`card ${msg.reached ? 'celebrate' : ''}`}>
            <div className="spread">
              <h3 className="muted">Meta mensal para guardar</h3>
              <Link to="/analises" className="tiny">Ver análises</Link>
            </div>
            <div className={`big-number ${msg.net >= 0 ? 'amount-pos' : 'amount-neg'}`}>{fmtBRL(msg.net)}</div>
            <div className="tiny">{msg.net >= 0 ? 'disponível para guardar neste mês' : 'resultado líquido do mês'}</div>

            <div className="grid-3" style={{ margin: '16px 0 14px' }}>
              <div><div className="tiny">Entradas</div><div className="mono-num amount-pos" style={{ fontWeight: 700 }}>{fmtBRL(msg.income)}</div></div>
              <div><div className="tiny">Despesas</div><div className="mono-num amount-neg" style={{ fontWeight: 700 }}>{fmtBRL(msg.expense)}</div></div>
              <div><div className="tiny">Meta</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(msg.target)}</div></div>
            </div>

            {msg.target > 0 && (
              <>
                <Progress pct={Math.min(msg.pct, 100)} tone={msg.negative ? 'danger' : msg.pct < 40 ? 'warn' : undefined} />
                <div className="spread" style={{ marginTop: 8 }}>
                  <span className="small muted">{msg.pct}% da meta</span>
                  <span className="small" style={{ fontWeight: 650 }}>
                    {msg.reached ? '🎉 Meta alcançada!' : `Faltam ${fmtBRL(msg.missing)}`}
                  </span>
                </div>
              </>
            )}

            {/* Guardado REAL x apenas disponível (14.3) */}
            <div className="stack small" style={{ marginTop: 12, gap: 4 }}>
              <div className="spread"><span className="muted">Resultado líquido</span><span className="mono-num">{fmtBRL(msg.net)}</span></div>
              <div className="spread"><span className="muted">Já guardado de verdade</span><span className="mono-num amount-pos">{fmtBRL(msg.saved)}</span></div>
              <div className="spread"><span className="muted">Ainda disponível para guardar</span><span className="mono-num">{fmtBRL(msg.stillAvailable)}</span></div>
              {/* Parcelas do mês: projeção, não altera o valor realmente guardado (13) */}
              {msg.installmentsDue > 0 && (
                <>
                  <div className="spread"><span className="muted">− Parcelas que vencem neste mês</span><span className="mono-num amount-neg">{fmtBRL(msg.installmentsDue)}</span></div>
                  <div className="spread" style={{ fontWeight: 650 }}>
                    <span>Projeção após as parcelas</span>
                    <span className="mono-num">{fmtBRL(msg.projectedAvailable)}</span>
                  </div>
                </>
              )}
            </div>
            {msg.target > 0 && msg.saved > 0 && (
              <div style={{ marginTop: 10 }}>
                <Progress pct={Math.min(msg.savedPct, 100)} tone={msg.savedReached ? undefined : 'warn'} />
                <div className="spread" style={{ marginTop: 6 }}>
                  <span className="tiny">{msg.savedPct}% da meta efetivamente guardado</span>
                </div>
              </div>
            )}

            <p className="tiny" style={{ marginTop: 10 }}>
              {msg.target <= 0
                ? 'Defina em Configurações quanto pretende guardar por mês.'
                : msg.negative
                  ? `Neste mês, suas despesas estão ${fmtBRL(-msg.net)} acima das suas entradas. Antes de guardar, será necessário equilibrar esse valor.`
                  : msg.reached
                    ? 'Meta mensal alcançada! Seu resultado líquido passou do valor que você pretendia guardar.'
                    : `Sua meta é guardar ${fmtBRL(msg.target)} por mês. Seu resultado líquido neste mês é ${fmtBRL(msg.net)} — faltam ${fmtBRL(msg.missing)}.`}
            </p>
            <button className="link tiny" style={{ marginTop: 6 }} onClick={() => setShowMath(m => !m)}>
              {showMath ? 'Ocultar cálculo' : 'Como foi calculado?'}
            </button>
            {showMath && (
              <div className="stack tiny" style={{ marginTop: 8, gap: 3 }}>
                <div className="spread"><span>Entradas recebidas no mês</span><span className="mono-num">{fmtBRL(msg.income)}</span></div>
                <div className="spread"><span>− Despesas pagas no mês</span><span className="mono-num">{fmtBRL(msg.expense)}</span></div>
                <div className="spread" style={{ fontWeight: 700 }}><span>= Resultado líquido</span><span className="mono-num">{fmtBRL(msg.net)}</span></div>
                <div className="spread"><span>− Já transferido para reserva</span><span className="mono-num">{fmtBRL(msg.saved)}</span></div>
                <div className="spread" style={{ fontWeight: 700 }}><span>= Ainda disponível</span><span className="mono-num">{fmtBRL(msg.stillAvailable)}</span></div>
                <p style={{ marginTop: 4 }}>Transferências para reserva não são despesas — elas só indicam quanto do resultado já foi guardado.</p>
              </div>
            )}
          </div>

          {/* PRÓXIMAS ENTRADAS (salário/aluguel) */}
          {incomes.length > 0 && (
            <div className="card" style={{ padding: '4px 16px' }}>
              <p className="tiny" style={{ padding: '10px 0 2px', fontWeight: 650 }}>Próximas entradas</p>
              {incomes.slice(0, 4).map((b, i) => (
                <div key={b.name + i} className="row list-item">
                  <div className="tx-icon">🔑</div>
                  <div className="grow">
                    <div style={{ fontWeight: 650, fontSize: '0.9rem' }}>{sentenceCase(b.name)}</div>
                    <div className="tiny">{dueLabel(b.inDays, 'income')}</div>
                  </div>
                  <span className="mono-num amount-pos" style={{ fontWeight: 700 }}>+ {fmtBRL(b.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {/* PRÓXIMAS CONTAS */}
          {bills30.length > 0 && (
            <div className="card" style={{ padding: '4px 16px' }}>
              <p className="tiny" style={{ padding: '10px 0 2px', fontWeight: 650 }}>Próximas contas</p>
              {bills30.slice(0, 5).map((b, i) => (
                <div key={b.name + i} className="row list-item">
                  <div className="tx-icon">📄</div>
                  <div className="grow">
                    <div style={{ fontWeight: 650, fontSize: '0.9rem' }}>{sentenceCase(b.name)}</div>
                    <div className="tiny" style={{ color: b.inDays <= 2 ? 'var(--danger)' : undefined }}>
                      {dueLabel(b.inDays, 'expense')}
                    </div>
                  </div>
                  <span className="mono-num amount-neg" style={{ fontWeight: 700 }}>− {fmtBRL(b.amount)}</span>
                </div>
              ))}
              <Link to="/planejamento" className="link tiny" style={{ display: 'inline-block', padding: '6px 0' }}>Gerenciar contas e entradas →</Link>
            </div>
          )}
          {/* PREVISÃO ATÉ O FIM DO MÊS (14.4) — sempre marcada como estimativa */}
          {mfc.hasData && (
            <div className="card">
              <h3 className="muted">Previsão até o fim do mês</h3>
              <div className={`big-number ${mfc.estimatedEnd >= 0 ? 'amount-pos' : 'amount-neg'}`} style={{ fontSize: '1.7rem' }}>{fmtBRL(mfc.estimatedEnd)}</div>
              <div className="tiny">saldo estimado no fim do mês</div>
              <p className="small muted" style={{ marginTop: 10 }}>
                Considerando as entradas e contas cadastradas, você deve terminar o mês com aproximadamente {fmtBRL(mfc.estimatedEnd)}.
                Esse valor pode mudar se houver novas despesas. (estimativa)
              </p>
              <button className="link tiny" style={{ marginTop: 6 }} onClick={() => setShowForecastMath(m => !m)}>
                {showForecastMath ? 'Ocultar cálculo' : 'Como foi calculado?'}
              </button>
              {showForecastMath && (
                <div className="stack tiny" style={{ marginTop: 8, gap: 3 }}>
                  <div className="spread"><span>Saldo atual informado</span><span className="mono-num">{fmtBRL(mfc.balance)}</span></div>
                  <div className="spread"><span>+ Entradas ainda previstas</span><span className="mono-num amount-pos">{fmtBRL(mfc.incomingLeft)}</span></div>
                  <div className="spread"><span>− Contas ainda pendentes</span><span className="mono-num amount-neg">{fmtBRL(mfc.billsLeft)}</span></div>
                  {mfc.installmentsLeft > 0 && (
                    <div className="spread"><span>− Parcelas ainda a vencer</span><span className="mono-num amount-neg">{fmtBRL(mfc.installmentsLeft)}</span></div>
                  )}
                  <div className="spread" style={{ fontWeight: 700 }}><span>= Saldo estimado no fim do mês</span><span className="mono-num">{fmtBRL(mfc.estimatedEnd)}</span></div>
                  <div className="divider" style={{ margin: '6px 0' }} />
                  <div className="spread"><span>Já recebido neste mês (realizado)</span><span className="mono-num">{fmtBRL(mfc.received)}</span></div>
                  <div className="spread"><span>Já pago neste mês (realizado)</span><span className="mono-num">{fmtBRL(mfc.paid)}</span></div>
                  <p style={{ marginTop: 4 }}>Valores previstos e realizados são contados separadamente. Faltam {mfc.daysLeft} dia(s) para o fim do mês.</p>
                </div>
              )}
            </div>
          )}

          {bills30.length === 0 && incomes.length === 0 && (
            <div className="card">
              <p className="small muted">Cadastre suas contas e entradas fixas pra eu te avisar dos vencimentos e prever seu mês.</p>
              <button className="btn btn-soft btn-block" onClick={() => navigate('/planejamento')} style={{ marginTop: 10 }}>Cadastrar contas e entradas</button>
            </div>
          )}
        </>
      )}

      {hasData && isDriver && (
        <>
          {/* CARD PRINCIPAL */}
          <div className={`card ${pct >= 100 ? 'celebrate' : ''}`}>
            <div className="spread">
              <h3 className="muted">Resultado de hoje</h3>
              <span className="tiny">toque no valor para alternar</span>
            </div>
            <button onClick={() => setMetric(m => m === 'profit' ? 'balance' : m === 'balance' ? 'gross' : 'profit')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, font: 'inherit', color: 'inherit' }}>
              <div className={`big-number ${mainValue >= 0 ? 'amount-pos' : 'amount-neg'}`}>{fmtBRL(mainValue)}</div>
              <div className="tiny">{mainLabel}</div>
            </button>

            <div className="grid-3" style={{ margin: '16px 0 14px' }}>
              <div><div className="tiny">Receitas</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(ts.income)}</div></div>
              <div><div className="tiny">Despesas</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(ts.expense)}</div></div>
              <div><div className="tiny">Meta</div><div className="mono-num" style={{ fontWeight: 700 }}>{fmtBRL(goal.total)}</div></div>
            </div>

            <Progress pct={pct} tone={pct < 40 ? 'warn' : undefined} />
            <div className="spread" style={{ marginTop: 8 }}>
              <span className="small muted">{Math.min(pct, 999)}% da meta atingida</span>
              <span className="small" style={{ fontWeight: 650 }}>
                {pct >= 100 ? '🎉 Meta batida!' : `Faltam ${fmtBRL(goal.total - ts.profit)}`}
              </span>
            </div>
            {pct < 100 && ts.hours > 0.5 && ts.profit > 0 && (
              <p className="tiny" style={{ marginTop: 8 }}>
                No seu ritmo atual ({fmtBRL(ts.profit / ts.hours)}/h), faltam aproximadamente {fmtNum((goal.total - ts.profit) / (ts.profit / ts.hours))}h de trabalho.
              </p>
            )}
            <Link to="/metas" className="link">Por que essa meta? →</Link>
          </div>

          {/* DÉFICIT DE ONTEM (seção 18) */}
          {yDeficit > 1 && (
            <div className="card" style={{ borderColor: 'var(--warning)', borderWidth: 1.5 }}>
              <h3>Ontem faltaram {fmtBRL(yDeficit)} para a meta</h3>
              <p className="small muted" style={{ margin: '6px 0 12px' }}>O que você quer fazer com esse valor?</p>
              <div className="suggestion-row">
                <button className="chip" onClick={() => resolveDeficit(7)}>Diluir em 7 dias</button>
                <button className="chip" onClick={() => resolveDeficit(15)}>Diluir em 15 dias</button>
                <button className="chip" onClick={() => resolveDeficit(30)}>Diluir em 30 dias</button>
                <button className="chip" onClick={() => resolveDeficit(null)}>Ignorar</button>
              </div>
            </div>
          )}
        </>
      )}

      {hasData && (
        <>
          {/* CARD DO ASSISTENTE (seção 7) */}
          <div className="card" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}>
            <div className="row">
              <div className="tx-icon" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>✦</div>
              <div className="grow">
                <h3>{insights.length ? 'Tenho um insight para você' : 'Seu assistente financeiro'}</h3>
                <p className="small muted" style={{ marginTop: 2 }}>
                  {insights.length ? insights[0].text : 'Me pergunte qualquer coisa sobre seu dinheiro.'}
                </p>
              </div>
            </div>
            <div className="suggestion-row" style={{ marginTop: 12 }}>
              {(isDriver
                ? ['Quanto posso gastar hoje?', 'Como está minha meta?', 'Minha semana foi boa?']
                : ['Como está meu mês?', 'Quanto posso guardar este mês?', 'Tenho saldo para as próximas contas?']
              ).map(q => (
                <button key={q} className="chip" onClick={() => navigate('/assistente', { state: { ask: q } })}>{q}</button>
              ))}
            </div>
          </div>

          {/* ALERTAS */}
          {state.settings.notifications && alerts.map(a => (
            <div key={a.id} className="card" style={{ padding: '13px 16px' }}>
              <div className="row">
                <span style={{ fontSize: '1.2rem' }}>{a.icon}</span>
                <div className="grow">
                  <div style={{ fontWeight: 650, fontSize: '0.9rem' }}>{a.title}</div>
                  <div className="tiny">{a.text}</div>
                </div>
              </div>
            </div>
          ))}

          {/* RESUMO RÁPIDO (seção 6) — só motorista */}
          {isDriver && (
            <>
              <div className="section-title">
                <h2>Resumo rápido</h2>
                <button className="link" onClick={() => setCustomizing(c => !c)}>{customizing ? 'Concluir' : 'Personalizar'}</button>
              </div>
              {customizing && (
                <div className="chips" style={{ marginBottom: 10 }}>
                  {ALL_CARDS.map(c => (
                    <button key={c.id} className={`chip ${state.settings.homeCards.includes(c.id) ? 'active' : ''}`}
                      onClick={() => {
                        const cur = state.settings.homeCards
                        dispatch({ type: 'settings', patch: { homeCards: cur.includes(c.id) ? cur.filter(x => x !== c.id) : [...cur, c.id] } })
                      }}>{c.label}</button>
                  ))}
                </div>
              )}
              <div className="grid-2">
                {cards.map(c => (
                  <div key={c.id} className="mini-card">
                    <div className="mini-value">{c.value(state, ts.km > 0 || ts.trips > 0 ? ts : week, kc)}</div>
                    <div className="mini-label">{c.label}{ts.km === 0 && ts.trips === 0 ? ' (7 dias)' : ''}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* INSIGHTS (seção 15) */}
          {insights.length > 1 && (
            <>
              <div className="section-title"><h2>Insights</h2><Link to="/analises">Ver análises</Link></div>
              <div className="stack">
                {insights.slice(1).map(i => (
                  <div key={i.id} className="card" style={{ padding: '14px 16px' }}>
                    <div className="row">
                      <span style={{ fontSize: '1.25rem' }}>{i.icon}</span>
                      <div className="grow">
                        <div className="spread">
                          <span style={{ fontWeight: 650, fontSize: '0.9rem' }}>{i.title}</span>
                          <span className={`badge ${i.tone === 'positive' ? 'pos' : i.tone === 'negative' ? 'neg' : i.tone === 'warning' ? 'warn' : 'neutral'}`}>
                            {i.tone === 'positive' ? 'bom' : i.tone === 'negative' ? 'atenção' : i.tone === 'warning' ? 'alerta' : 'info'}
                          </span>
                        </div>
                        <p className="small muted" style={{ marginTop: 3 }}>{i.text}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {isDriver && avg > 0 && (
            <p className="tiny" style={{ textAlign: 'center', marginTop: 20 }}>
              Média diária de lucro (30 dias): {fmtBRL(avg)}
            </p>
          )}
        </>
      )}
    </div>
  )
}
