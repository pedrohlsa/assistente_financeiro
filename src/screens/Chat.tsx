// Chat financeiro com IA + entrada por voz (seções 8, 9, 10)
import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { applyParsedAction, findGoalByExactName, useStore } from '../store/store'
import { askAssistant, askAssistantRemote } from '../services/ai'
import { describeAction, describeActionDetailed } from '../services/nlp'
import { ChatMessage, ParsedAction } from '../models/types'
import { nowTime, uid, fmtBRL } from '../utils/format'
import { Icon, useToast } from '../components/ui'
import { findPossibleDuplicate, isDriver, shouldAsk99Fee } from '../services/profile'
import { catById } from '../data/categories'

const SUGGESTIONS_BY_PROFILE: Record<string, string[]> = {
  driver: [
    'Quanto posso gastar hoje?',
    'Como está minha meta?',
    'Quanto preciso ganhar amanhã?',
    'Quanto gastei com gasolina esse mês?',
    'Quando preciso trocar meu óleo?',
    'Quanto meu carro custa por km?',
    'Quanto tenho de parcela no mês que vem?',
    'ganhei 250 hoje',
    'gastei 40 de gasolina',
  ],
  autonomo: [
    'Como está meu mês?',
    'Quanto recebi de aluguéis este mês?',
    'Tenho saldo para as próximas contas?',
    'Quanto posso guardar este mês?',
    'Qual foi minha maior despesa?',
    'Quanto posso gastar sem comprometer minhas contas?',
    'Quanto tenho de parcela no mês que vem?',
    'recebi 1800 de aluguel',
  ],
  clt: [
    'Meu salário cobre minhas contas?',
    'Quanto tenho de parcela no mês que vem?',
    'Quanto posso guardar este mês?',
    'Quanto posso gastar até o próximo pagamento?',
    'Como está meu orçamento?',
    'Qual foi minha maior despesa?',
    'Como está minha meta mensal?',
    'recebi meu salário de 3000',
  ],
  other: [
    'Como está meu mês?',
    'Quanto posso guardar este mês?',
    'Tenho saldo para as próximas contas?',
    'Qual foi minha maior despesa?',
    'Como está minha meta mensal?',
    'recebi 500 hoje',
    'gastei 80 no mercado',
  ],
}

const suggestionsFor = (profile: string) =>
  SUGGESTIONS_BY_PROFILE[profile] || SUGGESTIONS_BY_PROFILE.other

export default function Chat() {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const location = useLocation() as any
  const [input, setInput] = useState('')
  const [recording, setRecording] = useState(false)
  const [thinking, setThinking] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const recRef = useRef<any>(null)
  const askHandled = useRef(false)
  const driverMode = isDriver(state.settings)

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || thinking) return
    const userMsg: ChatMessage = { id: uid(), role: 'user', text: t, time: nowTime() }
    dispatch({ type: 'chat', msg: userMsg })
    setInput('')
    setThinking(true)
    // Registros de dinheiro usam o parser local (determinístico e offline).
    // Perguntas/análises vão ao backend de IA (DeepSeek — chave só no servidor),
    // com o motor local como fallback se estiver offline ou o serviço falhar.
    const local = askAssistant(state, t)
    let reply: typeof local
    if (local.actions?.length || local.handled) {
      // Registro OU pergunta que o cálculo local responde com certeza → usa local
      // (determinístico, instantâneo, sempre com o número atual — sem depender da IA).
      reply = { ...local, engine: 'local' }
    } else if (state.settings.remoteAi === false) {
      // IA remota desligada (14.11): responde só com o motor local/offline.
      reply = { ...local, engine: 'local' }
    } else {
      const history = state.chat.slice(-6).map(m => ({ role: m.role, text: m.text }))
      reply = (await askAssistantRemote(state, t, history)) || { ...local, engine: 'local' }
    }
    setThinking(false)
    // Pergunta de desambiguação: só as opções, nenhuma ação pendente ainda.
    if (reply.choices?.length) {
      dispatch({
        type: 'chat',
        msg: { id: uid(), role: 'assistant', text: reply.text, time: nowTime(), choices: reply.choices },
      })
      return
    }
    dispatch({
      type: 'chat',
      msg: {
        id: uid(), role: 'assistant', text: reply.text, time: nowTime(),
        pending: reply.actions?.map(a => ({ label: describeAction(a), action: a })),
        detail: reply.actions?.length
          ? reply.actions.map(a => describeActionDetailed(a, {
              fee: state.settings.platform99Fee,
              categoryName: id => catById(state.categories, id).name,
            }).join('\n')).join('\n\n')
          : undefined,
        duplicateWarning: reply.actions?.map(a => {
          // Meta com nome já existente: a ação 'goal' CRIA outra meta, nunca
          // altera a atual em silêncio — por isso o aviso é obrigatório aqui.
          if (a.kind === 'goal') {
            const g = findGoalByExactName(state, a.name)
            return g
              ? `⚠️ Já existe uma meta chamada “${g.name}” (${fmtBRL(g.saved)} de ${fmtBRL(g.target)}). Confirmar vai criar uma SEGUNDA meta com o mesmo nome — a atual não será alterada. Para mudar a existente, peça "muda a meta ${g.name} para X".`
              : null
          }
          const dup = findPossibleDuplicate(state, a)
          if (!dup) return null
          return `⚠️ Já existe ${dup.type === 'income' ? 'uma receita' : 'uma despesa'} parecida de ${fmtBRL(dup.amount)} registrada ${dup.date === new Date().toISOString().slice(0, 10) ? 'hoje' : 'ontem'}. Deseja registrar novamente?`
        }).filter(Boolean).join('\n') || undefined,
      },
    })
  }

  // pergunta vinda da Home
  useEffect(() => {
    const ask = location.state?.ask
    if (ask && !askHandled.current) {
      askHandled.current = true
      window.history.replaceState({}, '')
      send(ask)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999 })
    window.scrollTo({ top: document.body.scrollHeight })
  }, [state.chat.length])

  const confirmActions = (msgId: string, actions: ParsedAction[]) => {
    dispatch({ type: 'chatResolve', id: msgId }) // remove os botões do popup
    const ok: ParsedAction[] = []
    const failed: ParsedAction[] = []
    actions.forEach(a => (applyParsedAction(dispatch, state, a, 'ai') ? ok : failed).push(a))
    let text = ok.length ? `Registrado! ✅\n\n${ok.map(a => '• ' + describeAction(a)).join('\n')}` : ''
    if (failed.length) text += `${text ? '\n\n' : ''}⚠️ Não encontrei a meta correspondente:\n${failed.map(a => '• ' + describeAction(a)).join('\n')}\nConfira o nome na aba Metas e tente de novo.`
    dispatch({ type: 'chat', msg: { id: uid(), role: 'assistant', text, time: nowTime() } })
    if (ok.length) toast({ text: ok.length > 1 ? `${ok.length} registros salvos.` : 'Registro salvo.' })

    // Regra da 99: só no perfil motorista, só para receita de corridas ainda
    // não marcada como saque. Aluguel, salário, venda e freelance nunca perguntam.
    const fee = state.settings.platform99Fee
    const hasRideIncome = ok.some(a => shouldAsk99Fee(state, a))
    if (hasRideIncome) {
      dispatch({
        type: 'chat',
        msg: {
          id: uid(), role: 'assistant', time: nowTime(),
          text: `Esse faturamento foi um saque da 99? Se sim, eu registro a taxa de ${fmtBRL(fee)}.`,
          pending: [{ label: `Sim — taxa de saque 99 (−${fmtBRL(fee)})`, action: { kind: 'expense', amount: fee, category: 'outros-out', description: 'Taxa de saque 99' } }],
        },
      })
    }
  }

  /**
   * Usuário escolheu uma opção de desambiguação. Isso NÃO registra nada: só
   * transforma a escolha na confirmação normal, com o detalhamento completo.
   */
  const chooseOption = (msgId: string, actions: ParsedAction[]) => {
    dispatch({ type: 'chatResolve', id: msgId })
    dispatch({
      type: 'chat',
      msg: {
        id: uid(), role: 'assistant', time: nowTime(),
        text: 'Entendi isso:\n\n' + actions.map(a => '• ' + describeAction(a)).join('\n') + '\n\nConfirmar?',
        pending: actions.map(a => ({ label: describeAction(a), action: a })),
        detail: actions.map(a => describeActionDetailed(a, {
          fee: state.settings.platform99Fee,
          categoryName: id => catById(state.categories, id).name,
        }).join('\n')).join('\n\n'),
      },
    })
  }

  const cancelActions = (msgId: string) => {
    dispatch({ type: 'chatResolve', id: msgId })
    dispatch({ type: 'chat', msg: { id: uid(), role: 'assistant', text: 'Ok, descartei. Pode reformular se quiser.', time: nowTime() } })
  }

  const startVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { toast({ text: 'Reconhecimento de voz não disponível neste navegador.' }); return }
    if (recording) { recRef.current?.stop(); return }
    const rec = new SR()
    recRef.current = rec
    rec.lang = 'pt-BR'
    rec.interimResults = false
    rec.onresult = (e: any) => {
      const text = e.results[0][0].transcript
      setRecording(false)
      send(text)
    }
    rec.onend = () => setRecording(false)
    rec.onerror = () => { setRecording(false); toast({ text: 'Não consegui te ouvir. Tente de novo.' }) }
    setRecording(true)
    rec.start()
  }

  return (
    <div className="chat-screen fade-slide">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h1>Assistente</h1>
        <div className="row" style={{ gap: 12 }}>
          <button className="link" onClick={() => window.location.reload()} title="Recarregar dados">↻ Atualizar</button>
          {state.chat.length > 0 && <button className="link" onClick={() => dispatch({ type: 'chatClear' })}>Limpar</button>}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {state.chat.length === 0 && (
          <div className="card" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}>
            <h3 style={{ marginBottom: 6 }}>Eu cuido dos seus números enquanto você cuida da sua rotina. ✦</h3>
            <p className="small muted">
              {driverMode
                ? 'Escreva ou fale naturalmente: registre ganhos, gastos, km, abastecimentos e manutenções — ou me faça perguntas sobre seu dinheiro.'
                : 'Escreva ou fale naturalmente: registre o que entrou e o que saiu, suas contas e metas — ou me faça perguntas sobre seu dinheiro.'}
            </p>
          </div>
        )}
        {state.chat.map(m => (
          <div key={m.id} className={`bubble ${m.role === 'user' ? 'user' : 'ai'}`}>
            {m.text}
            {m.detail && (
              <div className="stack tiny" style={{ marginTop: 8, gap: 2, opacity: 0.9, whiteSpace: 'pre-line' }}>{m.detail}</div>
            )}
            {m.duplicateWarning && (
              <div className="tiny" style={{ marginTop: 8, color: 'var(--warning)', whiteSpace: 'pre-line' }}>{m.duplicateWarning}</div>
            )}
            {m.choices && m.choices.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {m.choices.map(c => (
                  <button key={c.label} className="btn btn-soft btn-sm" onClick={() => chooseOption(m.id, c.actions)}>{c.label}</button>
                ))}
                <button className="btn btn-danger-soft btn-sm" onClick={() => cancelActions(m.id)}>Cancelar</button>
              </div>
            )}
            {m.pending && m.pending.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => confirmActions(m.id, m.pending!.map(p => p.action))}>Confirmar</button>
                <button className="btn btn-danger-soft btn-sm" onClick={() => cancelActions(m.id)}>Cancelar</button>
              </div>
            )}
          </div>
        ))}
        {thinking && (
          <div className="bubble ai" style={{ opacity: 0.7 }}>
            <span className="thinking-dots"><span>●</span><span>●</span><span>●</span></span>
          </div>
        )}
        {state.chat.length === 0 && (
          <div className="suggestion-row">
            {suggestionsFor(state.settings.profile).map(s => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
      </div>

      <div className="chat-input-bar">
        <input
          placeholder={recording ? 'Ouvindo...' : 'ganhei 250 hoje...'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send(input)}
        />
        <button className={`icon-btn secondary ${recording ? 'recording' : ''}`} aria-label="Falar" onClick={startVoice}>{Icon.mic}</button>
        <button className="icon-btn" aria-label="Enviar" onClick={() => send(input)}>{Icon.send}</button>
      </div>
    </div>
  )
}
