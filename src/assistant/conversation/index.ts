// A CONVERSA sobre dinheiro: consulta, cenário e continuação, num lugar só.
//
// O orquestrador chama `answerConversation` e recebe texto + o foco atualizado.
// Quem decide o que a mensagem é fica aqui, e a ordem importa:
//
//   1. CONTINUAÇÃO ("e mês passado?", "e em 12x?", "por quê?") — só quando há
//      foco fresco e a frase é curta e começa por um marcador de continuação.
//   2. CENÁRIO ("se eu…") — antes da consulta, porque uma hipótese com número
//      respondida como consulta viraria um dado real sobre um mundo que não
//      existe.
//   3. CONSULTA — o resto.
//
// Nada daqui produz ação. Consulta e cenário são sempre RESPOSTA.

import type { AppState } from '../../models/types'
import { todayISO } from '../../utils/format'
import { answerQuery, runPlannedQuery } from '../query'
import type { QueryAnswer } from '../query'
import { answerScenario, rerunScenario } from '../scenario'
import type { ScenarioAnswer } from '../scenario'
import { looksLikeScenario } from '../scenario/parse'
import {
  isFocusFresh, rememberQuery, rememberScenario, resolveFollowUp, looksLikeFollowUp,
} from './focus'
import type { ConversationFocus, FollowUp } from './focus'

export interface ConversationAnswer {
  reply: string
  /** Como a mensagem foi tratada — auditoria e diagnóstico, não decoração. */
  kind: 'query' | 'scenario' | 'explain' | 'clarify'
  /** Foco atualizado. O chamador guarda; nada é persistido em disco. */
  focus: ConversationFocus
  /** Pergunta de desambiguação, quando a referência tem dois candidatos. */
  clarification?: { question: string; options: { label: string; value: string }[] }
  /** Confiança do plano — decide se a consulta assume a pergunta (ver orchestrator). */
  confidence?: 'high' | 'medium'
  /**
   * O plano usa algo que `resolveLocal()` nao expressa. E o unico caso em que
   * uma CONSULTA toma a frente do roteador antigo — ver `alemDoAntigo` em
   * query/parse.ts e o passo 2d do orquestrador.
   */
  beyondLegacy?: boolean
}

export interface ConversationOptions {
  today?: string
  focus?: ConversationFocus
  now?: number
}

export function answerConversation(
  state: AppState,
  message: string,
  opts: ConversationOptions = {},
): ConversationAnswer | null {
  const hoje = opts.today || todayISO()
  const agora = opts.now ?? Date.now()
  const focus = opts.focus

  // ---- 1) continuação ----------------------------------------------------
  if (isFocusFresh(focus, agora) && looksLikeFollowUp(message)) {
    const fu = resolveFollowUp(state, focus, message, hoje)
    if (fu) return aplicaFollowUp(state, focus!, fu, hoje, agora)
  }

  // ---- 2) cenário --------------------------------------------------------
  if (looksLikeScenario(message)) {
    const cen = answerScenario(state, message, { today: hoje })
    if (cen) return doCenario(focus, cen, agora)
    // Hipótese reconhecida mas sem plano: NÃO cair na consulta. Responder com
    // número real a uma frase começada por "se eu" é transformar hipótese em
    // fato — exatamente o que este módulo existe para impedir.
    return null
  }

  // ---- 3) consulta -------------------------------------------------------
  const q = answerQuery(state, message, { today: hoje })
  if (q) return daConsulta(focus, q, agora)

  return null
}

function aplicaFollowUp(
  state: AppState, focus: ConversationFocus, fu: FollowUp, hoje: string, agora: number,
): ConversationAnswer | null {
  switch (fu.kind) {
    case 'explain':
      return { reply: fu.text, kind: 'explain', focus: { ...focus, updatedAt: agora }, confidence: 'high' }
    case 'ambiguous':
      return {
        reply: fu.question, kind: 'clarify', focus: { ...focus, updatedAt: agora },
        clarification: { question: fu.question, options: fu.options }, confidence: 'high',
      }
    case 'query': {
      const out = runPlannedQuery(state, fu.planned, { today: hoje })
      return out ? daConsulta(focus, out, agora) : null
    }
    case 'scenario': {
      const out = rerunScenario(state, fu.plan, { today: hoje })
      return doCenario(focus, out, agora)
    }
  }
  return null
}

const daConsulta = (
  focus: ConversationFocus | undefined, q: QueryAnswer, agora: number,
): ConversationAnswer => ({
  reply: q.reply,
  kind: 'query',
  focus: rememberQuery(focus, q.plan, q.result, q.explain, agora),
  confidence: q.confidence,
  beyondLegacy: q.beyondLegacy,
})

const doCenario = (
  focus: ConversationFocus | undefined, s: ScenarioAnswer, agora: number,
): ConversationAnswer => ({
  reply: s.reply,
  kind: 'scenario',
  focus: rememberScenario(focus, s.plan, s.result, s.explain, agora),
  confidence: 'high',
})

export { isFocusFresh, looksLikeFollowUp, resolveFollowUp, rememberQuery, rememberScenario }
export type { ConversationFocus, FollowUp }
