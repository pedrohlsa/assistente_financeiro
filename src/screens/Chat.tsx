// Assistente — a tela é fina de propósito.
//
// Toda a interpretação (segmentação, cobertura, roteamento local×remoto,
// rascunhos, correções) vive em `src/assistant/orchestrator.ts`. Antes ela
// estava espalhada aqui em dois `if`, e era por isso que metade da mensagem se
// perdia. Aqui só há: enviar, renderizar e confirmar.

import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { applyAssistantBatch, useStore } from '../store/store'
import { askAssistantRemote } from '../services/ai'
import { orchestrate, buildCapabilities } from '../assistant/orchestrator'
import type { AssistantDraft } from '../assistant/drafts'
import { isActionFailure } from '../assistant/contracts'
import type { ActionFailure, AssistantClarification } from '../assistant/contracts'
import { ChatMessage, ProposedAction } from '../models/types'
import { nowTime, uid } from '../utils/format'
import { Icon, useToast } from '../components/ui'
import { ProposalCard } from '../components/ProposalCard'
import { isDriver, shouldAsk99Fee } from '../services/profile'
import { plainChatText } from '../utils/text'
import { fmtBRL } from '../utils/format'
import { listenOnce, SPEECH_MESSAGES, SpeechError, speechAvailable, stopListening } from '../services/speech'

const SUGGESTIONS_BY_PROFILE: Record<string, string[]> = {
  driver: [
    'Quanto posso gastar hoje?',
    'Como está minha meta?',
    'Quanto gastei com gasolina esse mês?',
    'Quando preciso trocar meu óleo?',
    'Quanto meu carro custa por km?',
    'ganhei 250 hoje',
    'ganhei 430 na Uber e 399 na 99, rodei 161 km',
  ],
  autonomo: [
    'Como está meu mês?',
    'Quanto recebi de aluguéis este mês?',
    'Tenho saldo para as próximas contas?',
    'Quanto posso guardar este mês?',
    'recebi 1800 de aluguel da Casa 1',
    'ontem gastei 150 de areia',
  ],
  clt: [
    'Meu salário cobre minhas contas?',
    'Quanto tenho de parcela no mês que vem?',
    'Quanto posso guardar este mês?',
    'Como está minha meta mensal?',
    'recebi meu salário de 3000 e guardei 150',
  ],
  other: [
    'Como está meu mês?',
    'Quanto posso guardar este mês?',
    'Tenho saldo para as próximas contas?',
    'Qual foi minha maior despesa?',
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
  // Botão de microfone que não faz nada é pior do que botão nenhum: some quando
  // o aparelho não tem ditado.
  const [micOk, setMicOk] = useState(true)
  const [thinking, setThinking] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const askHandled = useRef(false)
  const driverMode = isDriver(state.settings)

  /**
   * Rascunho da conversa em andamento. Fica em memória de propósito: uma
   * pergunta pendente NÃO deve ressuscitar depois de recarregar o app.
   */
  const draftRef = useRef<AssistantDraft | null>(null)
  /** Proposta ainda na tela — alvo das correções ("não foi 100, foi 80"). */
  const pendingRef = useRef<{ msgId: string; actions: ProposedAction[] } | null>(null)
  /**
   * Pergunta de esclarecimento ainda aberta. Sem ela o orquestrador não sabe
   * que a próxima mensagem é a RESPOSTA de uma pergunta, e o efeito embutido em
   * cada opção nunca era aplicado: clicar num botão mandava o rótulo como texto
   * solto e o usuário recebia a mensagem genérica de ajuda.
   */
  const clarificationRef = useRef<AssistantClarification | null>(null)

  const caps = buildCapabilities(state)

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || thinking) return
    dispatch({ type: 'chat', msg: { id: uid(), role: 'user', text: t, time: nowTime() } })
    setInput('')
    setThinking(true)

    const out = await orchestrate({
      state,
      message: t,
      history: state.chat.slice(-8).map(m => ({ role: m.role, text: m.text })),
      draft: draftRef.current || undefined,
      pending: pendingRef.current?.actions.map(p => ({
        id: p.id, action: p.action, engine: p.engine || 'local', confidence: p.confidence || 'high',
      })),
      pendingClarification: clarificationRef.current || undefined,
      remoteEnabled: state.settings.remoteAi !== false,
      askRemote: async ({ state: s, message, history }) => {
        const r = await askAssistantRemote(s, message, history)
        return r ? { ...r, rejected: r.rejected || [] } : null
      },
      devDiagnostics: import.meta.env?.DEV === true,
    })
    setThinking(false)

    if (out.response.diagnostics) {
      // Só em desenvolvimento; nunca aparece para o usuário final e nunca
      // registra valores financeiros completos.
      // eslint-disable-next-line no-console
      console.debug('[assistant]', {
        engine: out.response.diagnostics.engine,
        coverage: out.response.diagnostics.coverage,
        clauses: out.response.diagnostics.clauses.map(c => `${c.intent}${c.handled ? '' : '?'}`),
        rejected: out.response.diagnostics.rejected,
        ms: out.response.diagnostics.elapsedMs,
      })
    }

    draftRef.current = out.draft
    // Correção aplicada: a proposta antiga some da mensagem anterior.
    if (out.correctedPending) {
      const old = pendingRef.current
      if (old) dispatch({ type: 'chatResolve', id: old.msgId })
      pendingRef.current = null
    }

    const msgId = uid()
    const proposal: ProposedAction[] | undefined = out.response.actions.length
      ? out.response.actions.map(a => ({
          id: a.id, action: a.action, engine: a.engine,
          confidence: a.confidence, duplicateWarning: a.duplicateWarning,
        }))
      : undefined

    dispatch({
      type: 'chat',
      msg: {
        id: msgId, role: 'assistant', text: out.response.reply, time: nowTime(),
        proposal,
        clarification: out.response.mode === 'clarify' ? (out.response as any).clarification : undefined,
        engine: out.response.engine,
        contractVersion: out.response.version,
      },
    })

    pendingRef.current = proposal ? { msgId, actions: proposal } : null
    clarificationRef.current = out.response.mode === 'clarify' ? out.response.clarification : null
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

  useEffect(() => {
    let vivo = true
    speechAvailable().then(ok => { if (vivo) setMicOk(ok) })
    return () => { vivo = false }
  }, [])

  // ---------- Confirmação ----------

  const updateProposal = (msgId: string, next: ProposedAction[]) => {
    dispatch({ type: 'chatUpdateProposal', id: msgId, proposal: next })
    if (pendingRef.current?.msgId === msgId) {
      pendingRef.current = next.length ? { msgId, actions: next } : null
    }
  }

  const commit = (msgId: string, items: ProposedAction[], all: ProposedAction[]) => {
    const origem = state.chat.find(m => m.id === msgId)
    const { results, applied } = applyAssistantBatch(
      dispatch, state, items.map(p => ({ id: p.id, action: p.action })), 'ai',
      // Auditoria: o motor que produziu a proposta e o ID da mensagem que a
      // originou. O texto da conversa NÃO vai junto — ele já está em `chat`.
      { engine: origem?.engine as any, messageId: msgId },
    )
    const byId = new Map(results.map(r => [r.actionId, r]))

    // Cada card recebe o SEU resultado. Nada de "não encontrei a meta" para
    // cartão inexistente ou fatura sem pendência.
    const next = all.map(p => {
      const r = byId.get(p.id)
      if (!r) return p
      if (isActionFailure(r)) return { ...p, outcome: { ok: false, message: r.message } }
      // Lote atômico que falhou: NADA foi gravado, então marcar os outros itens
      // como "registrado" seria mentira — e travava a interface, porque só quem
      // não tem `outcome` pode ser editado ou removido para tentar de novo.
      if (!applied) return p
      return { ...p, outcome: { ok: true } }
    })
    updateProposal(msgId, next)

    const okCount = results.filter(r => r.ok).length
    // `filter(predicado)` não estreita o tipo do array sob `strict: false`;
    // o laço com o predicado estreita sempre (ver regra 24).
    const failures: ActionFailure[] = []
    for (const r of results) if (isActionFailure(r)) failures.push(r)

    let text: string
    if (applied) {
      text = okCount > 1 ? `Registrado! ✅ ${okCount} lançamentos salvos.` : 'Registrado! ✅'
    } else {
      // Atômico: nada foi salvo. A mensagem diz exatamente o que travou.
      text = `Não registrei nada ainda — o lote inteiro depende de todos os itens.\n\n` +
        failures.map(f => `• ${f.message}`).join('\n') +
        `\n\nCorrija ou remova esse item e confirme de novo.`
    }
    dispatch({ type: 'chat', msg: { id: uid(), role: 'assistant', text, time: nowTime(), batchId: undefined } })
    if (applied) toast({ text: okCount > 1 ? `${okCount} registros salvos.` : 'Registro salvo.' })
    if (pendingRef.current?.msgId === msgId && applied) pendingRef.current = null

    // Regra da 99: pergunta separada, só no perfil motorista e só para receita
    // de corridas. Citar a 99 nunca desconta sozinho.
    if (applied) {
      const fee = state.settings.platform99Fee
      if (items.some(p => shouldAsk99Fee(state, p.action))) {
        const feeId = uid()
        dispatch({
          type: 'chat',
          msg: {
            id: feeId, role: 'assistant', time: nowTime(),
            text: 'Você quer registrar a taxa da 99 agora? Ela só deve entrar quando o saque realmente acontecer.',
            proposal: [{
              id: uid(),
              action: { kind: 'expense', amount: fee, category: 'outros-out', description: 'Taxa 99' },
              engine: 'local', confidence: 'high',
            }],
          },
        })
      }
    }
  }

  const cancel = (msgId: string) => {
    dispatch({ type: 'chatResolve', id: msgId })
    if (pendingRef.current?.msgId === msgId) pendingRef.current = null
    clarificationRef.current = null
    dispatch({ type: 'chat', msg: { id: uid(), role: 'assistant', text: 'Ok, descartei. Pode reformular se quiser.', time: nowTime() } })
  }

  const chooseClarification = (msgId: string, value: string, label: string) => {
    dispatch({ type: 'chatResolve', id: msgId })
    send(label || value)
  }

  // ---------- Voz ----------

  const startVoice = async () => {
    // No APK quem ouve é o app de voz do Android; no navegador, a Web Speech
    // API. `listenOnce` esconde essa diferença — a tela só pede uma fala.
    if (recording) { stopListening(); setRecording(false); return }
    setRecording(true)
    try {
      const { text, cancelled } = await listenOnce('Fale o que você quer registrar')
      setRecording(false)
      // Desistir de falar não é erro: nada de mensagem de falha.
      if (!cancelled && text.trim()) send(text)
    } catch (e) {
      setRecording(false)
      const motivo = e instanceof SpeechError ? e.reason : 'error'
      toast({ text: SPEECH_MESSAGES[motivo] })
    }
  }

  return (
    <div className="chat-screen fade-slide">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h1>Assistente</h1>
        <div className="row" style={{ gap: 12 }}>
          <button className="link" onClick={() => window.location.reload()} title="Recarregar dados">↻ Atualizar</button>
          {state.chat.length > 0 && <button className="link" onClick={() => { pendingRef.current = null; draftRef.current = null; clarificationRef.current = null; dispatch({ type: 'chatClear' }) }}>Limpar</button>}
        </div>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {state.chat.length === 0 && (
          <div className="card" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}>
            <h3 style={{ marginBottom: 6 }}>Eu cuido dos seus números enquanto você cuida da sua rotina. ✦</h3>
            <p className="small muted">
              {driverMode
                ? 'Escreva ou fale naturalmente: ganhos, gastos, km, abastecimentos e manutenções — ou pergunte sobre seu dinheiro. Pode mandar tudo numa mensagem só.'
                : 'Escreva ou fale naturalmente: o que entrou, o que saiu, contas e metas — ou pergunte sobre seu dinheiro. Pode mandar tudo numa mensagem só.'}
            </p>
          </div>
        )}

        {state.chat.map(m => (
          <div key={m.id} className={`bubble ${m.role === 'user' ? 'user' : 'ai'}`}>
            {plainChatText(m.text)}

            {/* LEGADO: mensagens salvas antes do contrato v1 */}
            {m.pending && m.pending.length > 0 && (
              <div style={{ marginTop: 10 }} className="tiny muted">
                Esta proposta é de uma versão anterior do assistente e não pode mais ser confirmada. Mande de novo, por favor.
              </div>
            )}

            {m.clarification?.options && m.clarification.options.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {m.clarification.options.map(o => (
                  <button key={o.value} className="btn btn-soft btn-sm"
                    onClick={() => chooseClarification(m.id, o.value, o.label)}>{o.label}</button>
                ))}
                <button className="btn btn-danger-soft btn-sm" onClick={() => cancel(m.id)}>Cancelar</button>
              </div>
            )}

            {m.proposal && m.proposal.length > 0 && (
              <ProposalCard
                proposal={m.proposal}
                categories={state.categories}
                caps={caps}
                onConfirmAll={() => commit(m.id, m.proposal!.filter(p => !p.outcome), m.proposal!)}
                onConfirmOne={id => commit(m.id, m.proposal!.filter(p => p.id === id), m.proposal!)}
                onEdit={(id, action) => updateProposal(m.id, m.proposal!.map(p => (p.id === id ? { ...p, action } : p)))}
                onRemove={id => {
                  const next = m.proposal!.filter(p => p.id !== id)
                  updateProposal(m.id, next)
                  if (!next.length) cancel(m.id)
                }}
                onCancel={() => cancel(m.id)}
              />
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
        <textarea
          rows={1}
          placeholder={recording ? 'Ouvindo...' : 'ganhei 250 hoje...'}
          value={input}
          onChange={e => {
            setInput(e.target.value)
            // Cresce com o conteúdo até o teto de CSS (max-height), aí rola.
            e.target.style.height = 'auto'
            e.target.style.height = `${e.target.scrollHeight}px`
          }}
          onKeyDown={e => {
            // Enter envia; Shift+Enter quebra linha, como em qualquer chat.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
              ;(e.target as HTMLTextAreaElement).style.height = 'auto'
            }
          }}
        />
        {micOk && (
          <button className={`icon-btn secondary ${recording ? 'recording' : ''}`}
            aria-label={recording ? 'Parar de ouvir' : 'Falar'} onClick={startVoice}>{Icon.mic}</button>
        )}
        <button className="icon-btn" aria-label="Enviar" onClick={() => send(input)}>{Icon.send}</button>
      </div>
    </div>
  )
}
