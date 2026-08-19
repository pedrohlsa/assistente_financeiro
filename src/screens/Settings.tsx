// Configurações (seções 34, 35, 36 — backup/exportação/privacidade)
import React, { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { resetAllData, useStore } from '../store/store'
import { monthKey, parseMoney, todayISO, uid } from '../utils/format'
import { catById } from '../data/categories'
import { monthStats, monthlySavingGoal } from '../services/calc'
import { ConfirmDialog, useToast } from '../components/ui'
import { GOAL_CADENCE_LABEL, GoalCadence, goalCadenceOf, isDriver } from '../services/profile'
import { canShareFile, saveTextFile, shareTextFile } from '../services/exportFile'
import { csvCell } from '../utils/text'

const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export default function SettingsScreen() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const navigate = useNavigate()
  const s = state.settings
  const driverMode = isDriver(s)
  const fileRef = useRef<HTMLInputElement>(null)
  const [newCat, setNewCat] = useState('')
  const [newCatType, setNewCatType] = useState<'income' | 'expense'>('expense')
  const [pendingImport, setPendingImport] = useState<any>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmClearActivity, setConfirmClearActivity] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  // Último arquivo exportado, para o botão de enviar aparecer só depois de
  // existir arquivo — oferecer "compartilhar" antes disso é oferecer nada.
  const [lastExport, setLastExport] = useState<{ filename: string; mime: string; content: string } | null>(null)

  const num = (v: string, fallback: number) => { const n = parseMoney(v); return isNaN(n) ? fallback : n }

  /**
   * Exportar de verdade. O caminho antigo (`<a download>` com Blob) não fazia
   * nada dentro do APK — o WebView do Capacitor não tem DownloadListener — e o
   * app dizia "exportado" para um arquivo que nunca existiu. Agora a mensagem
   * só aparece quando o arquivo foi realmente escrito, e diz onde ele ficou.
   */
  const download = async (content: string, filename: string, mime: string, rotulo: string) => {
    const out = await saveTextFile(filename, mime, content)
    if (!out.ok) {
      toast({ text: `Não consegui salvar o arquivo. ${out.error || ''}`.trim() })
      return
    }
    setLastExport(canShareFile() ? { filename, mime, content } : null)
    toast({ text: out.where ? `${rotulo} salvo em ${out.where}.` : `${rotulo} exportado.` })
  }

  const exportBackup = () =>
    download(
      JSON.stringify(state, null, 2),
      `assistfin-backup-${todayISO()}.json`,
      'application/json',
      'Backup',
    )

  /** CSV de todas as movimentações (14.10). */
  const exportCsv = () => {
    const rows = [
      ['data', 'tipo', 'valor', 'categoria', 'descricao', 'origem', 'pagamento', 'origem_registro'].join(','),
      ...state.transactions
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(t => [t.date, t.type, t.amount.toFixed(2), catById(state.categories, t.category).name,
          t.description, t.origin, t.paymentMethod, t.source].map(csvCell).join(',')),
    ].join('\n')
    download('﻿' + rows, `assistfin-movimentacoes-${todayISO()}.csv`, 'text/csv;charset=utf-8', 'CSV')
  }

  /** Resumo do mês em CSV (14.10). */
  const exportMonthlySummary = () => {
    const m = monthStats(state)
    const sg = monthlySavingGoal(state)
    const lines = [
      ['indicador', 'valor'].join(','),
      ...[
        ['Mês', monthKey(todayISO())],
        ['Entradas', m.income.toFixed(2)],
        ['Despesas', m.expense.toFixed(2)],
        ['Resultado líquido', (m.income - m.expense).toFixed(2)],
        ['Guardado de verdade', sg.saved.toFixed(2)],
        ['Ainda disponível', sg.stillAvailable.toFixed(2)],
        ['Meta mensal', sg.target.toFixed(2)],
      ].map(r => r.map(csvCell).join(',')),
      ...(driverMode ? [['KM', String(m.km)], ['Viagens', String(m.trips)]].map(r => r.map(csvCell).join(',')) : []),
    ].join('\n')
    download('﻿' + lines, `assistfin-resumo-${monthKey(todayISO())}.csv`, 'text/csv;charset=utf-8', 'Resumo mensal')
  }

  /** Importa validando e perguntando antes de substituir (14.10). */
  const importBackup = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      let parsed: any
      try {
        parsed = JSON.parse(String(reader.result))
        if (!parsed.settings || !Array.isArray(parsed.transactions)) throw new Error('formato')
      } catch {
        toast({ text: 'Arquivo inválido — nada foi alterado.' })
        return
      }
      setPendingImport(parsed)
    }
    reader.readAsText(file)
  }

  return (
    <div className="fade-slide">
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>Configurações</h1>
      </div>

      <div className="card stack">
        <h3>Perfil</h3>
        <div className="field"><label>Seu nome</label>
          <input className="input" value={s.name} onChange={e => dispatch({ type: 'settings', patch: { name: e.target.value } })} /></div>
        <div className="field"><label>Tema</label>
          <div className="chips">
            {(['light', 'dark'] as const).map(t => (
              <button key={t} className={`chip ${s.theme === t ? 'active' : ''}`} onClick={() => dispatch({ type: 'settings', patch: { theme: t } })}>
                {t === 'light' ? '☀️ Claro' : '🌙 Escuro'}
              </button>
            ))}
          </div>
        </div>
        <div className="field"><label>Moeda</label>
          <select className="input" value={s.currency} onChange={e => dispatch({ type: 'settings', patch: { currency: e.target.value } })}>
            <option value="BRL">Real (R$)</option>
          </select>
        </div>
      </div>

      {driverMode ? (
        <div className="card stack">
          <h3>Meta e trabalho</h3>
          <div className="field"><label>Objetivo de lucro mensal (R$)</label>
            <input className="input" inputMode="decimal" defaultValue={String(s.monthlyProfitTarget)} onBlur={e => dispatch({ type: 'settings', patch: { monthlyProfitTarget: num(e.target.value, s.monthlyProfitTarget) } })} /></div>
          <div className="field"><label>Margem de segurança (%)</label>
            <input className="input" inputMode="numeric" defaultValue={String(s.safetyMarginPct)} onBlur={e => dispatch({ type: 'settings', patch: { safetyMarginPct: num(e.target.value, s.safetyMarginPct) } })} /></div>
          <div className="field"><label>Dias em que você trabalha</label>
            <div className="chips">
              {WD.map((d, i) => (
                <button key={d} className={`chip ${s.workDays.includes(i) ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'settings', patch: { workDays: s.workDays.includes(i) ? s.workDays.filter(x => x !== i) : [...s.workDays, i] } })}>{d}</button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <h3>Planejamento mensal</h3>
          <div className="field"><label>Quanto deseja guardar por mês (R$)</label>
            <input className="input" inputMode="decimal" defaultValue={String(s.monthlyProfitTarget)} onBlur={e => dispatch({ type: 'settings', patch: { monthlyProfitTarget: num(e.target.value, s.monthlyProfitTarget) } })} /></div>
          <div className="field"><label>Margem de segurança (%)</label>
            <input className="input" inputMode="numeric" defaultValue={String(s.safetyMarginPct)} onBlur={e => dispatch({ type: 'settings', patch: { safetyMarginPct: num(e.target.value, s.safetyMarginPct) } })} /></div>
          <p className="tiny">Usado na previsão do mês e no card "Meta mensal para guardar" da tela inicial.</p>
        </div>
      )}

      {driverMode && (
        <div className="card stack">
          <h3>Motorista de app</h3>
          <div className="spread">
            <div>
              <div className="small" style={{ fontWeight: 650 }}>Taxa 99</div>
              <div className="tiny">Ao registrar uma receita de corridas, pergunto se foi saque da 99 e desconto a taxa.</div>
            </div>
            <button className={`chip ${s.ask99Fee ? 'active' : ''}`} onClick={() => dispatch({ type: 'settings', patch: { ask99Fee: !s.ask99Fee } })}>
              {s.ask99Fee ? 'Ativada' : 'Desativada'}
            </button>
          </div>
          {s.ask99Fee && (
            <div className="field"><label>Valor da taxa de saque (R$)</label>
              <input className="input" inputMode="decimal" defaultValue={String(s.platform99Fee)} onBlur={e => dispatch({ type: 'settings', patch: { platform99Fee: num(e.target.value, s.platform99Fee) } })} /></div>
          )}
        </div>
      )}

      {driverMode && (
        <div className="card stack">
          <h3>Custos do veículo</h3>
          <div className="form-grid">
            <div className="field"><label>Preço combustível manual (R$/L)</label>
              <input className="input" inputMode="decimal" defaultValue={s.fuelPricePerLiter || ''} placeholder="0,00" onBlur={e => dispatch({ type: 'settings', patch: { fuelPricePerLiter: num(e.target.value, 0) } })} /></div>
            <div className="field"><label>Consumo manual (km/L)</label>
              <input className="input" inputMode="decimal" defaultValue={s.kmPerLiter || ''} placeholder="0" onBlur={e => dispatch({ type: 'settings', patch: { kmPerLiter: num(e.target.value, 0) } })} /></div>
            <div className="field"><label>Custos fixos mensais (R$)</label>
              <input className="input" inputMode="decimal" defaultValue={s.fixedMonthlyCosts || ''} placeholder="0,00" onBlur={e => dispatch({ type: 'settings', patch: { fixedMonthlyCosts: num(e.target.value, 0) } })} /></div>
            <div className="field"><label>Mínimo por km (R$)</label>
              <input className="input" inputMode="decimal" defaultValue={s.minPerKm || ''} placeholder="0,00" onBlur={e => dispatch({ type: 'settings', patch: { minPerKm: num(e.target.value, 0) } })} /></div>
            <div className="field"><label>Confortável por km (R$)</label>
              <input className="input" inputMode="decimal" defaultValue={s.comfortPerKm || ''} placeholder="0,00" onBlur={e => dispatch({ type: 'settings', patch: { comfortPerKm: num(e.target.value, 0) } })} /></div>
          </div>
          <p className="tiny">Tudo começa zerado. Abastecimentos com valor, litros e hodômetro formam as médias reais; os campos manuais servem apenas como referência quando ainda não há histórico.</p>
        </div>
      )}

      <div className="card stack">
        <h3>Categorias personalizadas</h3>
        <p className="tiny">
          Crie fontes de renda e despesas do seu jeito — "Aluguel Casa 1", "Cliente João", "IPTU do imóvel".
          Arquivar uma categoria só a esconde dos seletores: os lançamentos antigos continuam intactos.
        </p>
        <div className="row">
          <input className="input" placeholder="Nome da categoria" value={newCat} onChange={e => setNewCat(e.target.value)} />
          <select className="input" style={{ width: 130 }} value={newCatType} onChange={e => setNewCatType(e.target.value as any)}>
            <option value="expense">Despesa</option><option value="income">Receita</option>
          </select>
        </div>
        <button className="btn btn-soft btn-sm" disabled={!newCat.trim()} onClick={() => {
          dispatch({ type: 'addCategory', c: { id: uid(), name: newCat.trim(), type: newCatType, icon: '🏷️', custom: true } })
          setNewCat(''); toast({ text: 'Categoria criada.' })
        }}>Adicionar categoria</button>

        {state.categories.filter(c => c.custom).length > 0 && (
          <div className="stack" style={{ marginTop: 6, gap: 2 }}>
            {state.categories.filter(c => c.custom).map(c => (
              <div key={c.id} className="spread" style={{ padding: '4px 0' }}>
                <span className="small" style={{ opacity: c.archived ? 0.5 : 1 }}>
                  {c.icon} {c.name} <span className="tiny">({c.type === 'income' ? 'entrada' : 'despesa'}{c.archived ? ' · arquivada' : ''})</span>
                </span>
                <button className="link tiny" onClick={() => dispatch({ type: 'archiveCategory', id: c.id, archived: !c.archived })}>
                  {c.archived ? 'Reativar' : 'Arquivar'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RITMO EXIBIDO NAS METAS (itens 36 e 37) — preferência visual dos
          objetivos de compra. Não muda a meta diária do motorista nem a
          frequência das contas recorrentes. */}
      <div className="card stack">
        <h3>Ritmo exibido no app</h3>
        <p className="tiny">
          A opção escolhida aqui será refletida na tela inicial e nas metas. Ela muda
          o período exibido, não transforma previsões em movimentações realizadas.
        </p>
        <div className="chips">
          {(['daily', 'weekly', 'monthly'] as GoalCadence[]).map(c => (
            <button key={c} className={`chip ${goalCadenceOf(s) === c ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'settings', patch: { goalCadence: c } })}>
              {GOAL_CADENCE_LABEL[c]}
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h3>Notificações</h3>
        <div className="spread">
          <span className="small">Alertas inteligentes na Home</span>
          <button className={`chip ${s.notifications ? 'active' : ''}`} onClick={() => dispatch({ type: 'settings', patch: { notifications: !s.notifications } })}>
            {s.notifications ? 'Ativados' : 'Desativados'}
          </button>
        </div>
      </div>

      {/* PRIVACIDADE E IA (14.11) */}
      <div className="card stack">
        <h3>Privacidade e uso da IA</h3>
        <p className="tiny">
          <strong>Fica só no seu aparelho:</strong> todas as movimentações, contas, metas, categorias,
          saldo e configurações. O app funciona 100% offline e nada é enviado sem você perguntar algo.
        </p>
        <p className="tiny">
          <strong>Quando você faz uma pergunta ao assistente:</strong> a maioria é respondida
          localmente, sem sair do aparelho. Se a pergunta for aberta e a IA remota estiver ligada,
          enviamos apenas um <em>resumo agregado</em> (totais do mês, saldo, contas próximas e metas)
          — nunca a lista completa de lançamentos{driverMode ? '' : '. Dados de veículo não são enviados no seu perfil'}.
        </p>
        <p className="tiny">
          As chaves de acesso à IA ficam apenas no servidor, nunca dentro do aplicativo.
        </p>
        <div className="spread">
          <div>
            <div className="small" style={{ fontWeight: 650 }}>IA remota</div>
            <div className="tiny">Desligada, o assistente continua respondendo com o cálculo local (offline).</div>
          </div>
          <button className={`chip ${s.remoteAi !== false ? 'active' : ''}`} onClick={() => dispatch({ type: 'settings', patch: { remoteAi: s.remoteAi === false } })}>
            {s.remoteAi !== false ? 'Ativada' : 'Desativada'}
          </button>
        </div>
      </div>

      <div className="card stack">
        <h3>Assistente adaptativo</h3>
        <p className="tiny">
          O assistente aprende com os lançamentos que <strong>você confirma</strong> neste aparelho.
          Com isso ele sugere a categoria que você costuma usar, mantém a grafia que você já escreveu
          (para "Zé da esquina" não virar dois lugares) e avisa quando um valor foge do seu normal.
        </p>
        <p className="tiny">
          Esse aprendizado <strong>fica no seu aparelho</strong> e não é compartilhado com outras pessoas
          nem com outros clientes do app. Ele é calculado a partir do seu próprio histórico, então
          apagar ou corrigir uma movimentação muda o aprendizado junto. E ele nunca registra nada
          sozinho: toda proposta continua precisando do seu Confirmar.
        </p>
        <div className="spread">
          <div>
            <div className="small" style={{ fontWeight: 650 }}>Aprender com meu histórico</div>
            <div className="tiny">
              Desligado, o assistente continua entendendo suas mensagens e fazendo todas as contas —
              só para de usar o seu passado para sugerir categoria e atalhos. Nada já registrado muda.
            </div>
          </div>
          <button
            className={`chip ${s.adaptiveAssistant !== false ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'settings', patch: { adaptiveAssistant: s.adaptiveAssistant === false } })}
          >
            {s.adaptiveAssistant !== false ? 'Ativado' : 'Desativado'}
          </button>
        </div>
      </div>

      <div className="card stack">
        <h3>Dados, backup e exportação</h3>
        <p className="tiny">Seus dados ficam armazenados localmente no seu aparelho e funcionam offline.</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-soft btn-sm" onClick={exportBackup}>Backup completo (JSON)</button>
          <button className="btn btn-soft btn-sm" onClick={exportCsv}>Movimentações (CSV)</button>
          <button className="btn btn-soft btn-sm" onClick={exportMonthlySummary}>Resumo do mês (CSV)</button>
          <button className="btn btn-soft btn-sm" onClick={() => fileRef.current?.click()}>Importar backup</button>
          {lastExport && (
            <button className="btn btn-soft btn-sm"
              onClick={() => shareTextFile(lastExport.filename, lastExport.mime, lastExport.content)}>
              Enviar {lastExport.filename.endsWith('.json') ? 'backup' : 'planilha'}
            </button>
          )}
          <input ref={fileRef} type="file" accept=".json" hidden onChange={e => { if (e.target.files?.[0]) importBackup(e.target.files[0]); e.target.value = '' }} />
        </div>

        {pendingImport && (
          <div className="card" style={{ borderColor: 'var(--warning)', borderWidth: 1.5, marginTop: 4 }}>
            <h3>Como importar?</h3>
            <p className="tiny" style={{ margin: '6px 0 10px' }}>
              O arquivo tem {pendingImport.transactions?.length || 0} movimentação(ões).
              Seus dados atuais só serão apagados se você escolher "Substituir tudo".
            </p>
            <div className="suggestion-row">
              <button className="chip active" onClick={() => {
                dispatch({ type: 'mergeState', state: pendingImport })
                setPendingImport(null); toast({ text: 'Backup mesclado. ✅' })
              }}>Mesclar</button>
              <button className="chip" onClick={() => setConfirmReplace(true)}>Substituir tudo</button>
              <button className="chip" onClick={() => setPendingImport(null)}>Cancelar</button>
            </div>
          </div>
        )}
        <div className="divider" />
        {/* Só em desenvolvimento: dados fictícios não são oferecidos ao usuário final. */}
        {import.meta.env.DEV && !state.settings.demo && state.transactions.length === 0 && (
          <button className="btn btn-soft btn-sm" onClick={() => { dispatch({ type: 'loadDemo' }); toast({ text: 'Dados de demonstração carregados.' }) }}>Carregar dados de demonstração (dev)</button>
        )}
        <button className="btn btn-danger-soft btn-sm" onClick={() => setConfirmClearActivity(true)}>Limpar lançamentos e trabalho</button>
        <button className="btn btn-danger-soft btn-sm" onClick={() => setConfirmReset(true)}>Apagar tudo e refazer cadastro</button>
      </div>

      {/* Confirmação própria da interface: window.confirm é bloqueado ou ignorado
          em parte dos WebViews do Android, e era por isso que o botão parecia
          não funcionar enquanto o comando pela IA funcionava (item 39). */}
      <ConfirmDialog
        open={confirmReplace}
        onClose={() => setConfirmReplace(false)}
        title="Substituir todos os dados?"
        text="Os dados atuais deste aparelho serão substituídos pelos dados do backup. Essa ação não pode ser desfeita."
        actions={[{
          label: 'Substituir pelos dados do backup',
          tone: 'danger',
          onClick: () => {
            if (!pendingImport) return
            dispatch({ type: 'hydrate', state: pendingImport })
            setPendingImport(null)
            setConfirmReplace(false)
            toast({ text: 'Backup restaurado. ✅' })
          },
        }]}
      />
      <ConfirmDialog
        open={confirmClearActivity}
        onClose={() => setConfirmClearActivity(false)}
        title="Limpar lançamentos e trabalho?"
        text="Isso apaga movimentações, abastecimentos, manutenções, km, viagens, horas e conversa. Seu perfil, veículo, contas, orçamentos, metas e cartões continuam cadastrados."
        actions={[{
          label: 'Limpar registros',
          tone: 'danger',
          onClick: () => {
            dispatch({ type: 'clearActivity' })
            setConfirmClearActivity(false)
            toast({ text: 'Registros limpos. Você pode recomeçar.' })
          },
        }]}
      />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Apagar todos os dados?"
        text="Isso apagará permanentemente movimentações, metas, contas, cartões, parcelas e configurações deste aparelho. Essa ação não pode ser desfeita."
        actions={[{
          label: 'Apagar definitivamente',
          tone: 'danger',
          onClick: () => { setConfirmReset(false); resetAllData(dispatch) },
        }]}
      />
    </div>
  )
}
