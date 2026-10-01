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
import { normalizeName } from '../../utils/text'
import { planQuery, runPlannedQuery } from '../query'
import { parsePeriod } from '../query/period'
import type { QueryAnswer } from '../query'
import { answerScenario, rerunScenario } from '../scenario'
import type { ScenarioAnswer } from '../scenario'
import { looksLikeScenario } from '../scenario/parse'
import { answerChangeQuestion, changeScopeClarification } from '../drivers'
import {
  isFocusFresh, rememberDriver, rememberQuery, rememberScenario, resolveFollowUp, looksLikeFollowUp,
} from './focus'
import type { ConversationFocus, FollowUp } from './focus'

export interface ConversationAnswer {
  reply: string
  /** Como a mensagem foi tratada — auditoria e diagnóstico, não decoração. */
  /**
   * `incomplete`: consulta reconhecida, mas com um pedaço que o planejador não
   * entendeu (`residuo`). Não há resposta local — nem desta camada, nem do
   * roteador antigo. Ver o portão no orquestrador.
   */
  kind: 'query' | 'scenario' | 'explain' | 'clarify' | 'incomplete'
  /** O pedaço não entendido, quando `kind` é `incomplete`. */
  residuo?: string
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

  // A resposta curta completa o plano já montado, sem reabrir o texto bruto
  // nem trocar o assunto por uma consulta nova.
  const pending = isFocusFresh(focus, agora) ? focus?.pendingQueryClarification : undefined
  if (pending) {
    const reply = normalizeName(message).replace(/[.!?]+$/, '').trim()
    let plan = pending.plan
    if (pending.kind === 'categories' && /^(?:juntas?|somadas?|total|separadas?|cada\s+uma)$/.test(reply)) {
      const separate = /^(?:separadas?|cada\s+uma)$/.test(reply)
      plan = { ...plan, group: separate ? 'category' : 'none',
        limit: separate ? Math.max(plan.filter.categories?.length || 0, 8) : 1,
        label: pending.plan.label?.replace(/ - .+$/, '') }
    } else if (pending.kind === 'period' && /^(?:\d{1,2}\s+meses?|desde\s+\w+|ultimos\s+\d{1,2}\s+meses?)$/.test(reply)) {
      const period = parsePeriod(reply, hoje)?.period || parsePeriod(`últimos ${reply}`, hoje)?.period
      if (period) plan = { ...plan, period }
    }
    if (plan !== pending.plan) {
      const answered = runPlannedQuery(state, { plan, confidence: 'high', recognized: ['resposta ao esclarecimento'] }, { today: hoje })
      if (answered) return daConsulta({ ...focus, pendingQueryClarification: undefined }, answered, agora)
    }
  }

  // ---- 1) continuação ----------------------------------------------------
  if (isFocusFresh(focus, agora) && looksLikeFollowUp(message)) {
    const fu = resolveFollowUp(state, focus, message, hoje)
    // Hipótese nunca é refino de CONSULTA. Depois de "onde vazou meu dinheiro",
    // "e se eu parar a obra, quanto sobra até dezembro" era lida como a consulta
    // anterior com outro período — número real para um mundo que não existe. O
    // "e se" sai do modo consulta e entra no de cenário, logo abaixo.
    if (fu && !(fu.kind === 'query' && looksLikeScenario(message))) return aplicaFollowUp(state, focus!, fu, hoje, agora)
  }

  // ---- 2) cenário --------------------------------------------------------
  if (looksLikeScenario(message)) {
    // A categoria da conversa em curso é o assunto de "e se parar?" — só com
    // foco fresco, e só quando a frase não traz a própria.
    const focusCategory = isFocusFresh(focus, agora) ? focus?.lastQueryPlan?.filter?.categories?.[0] : undefined
    const cen = answerScenario(state, message, { today: hoje, focusCategory })
    if (cen) return doCenario(focus, cen, agora)
    // Hipótese reconhecida mas sem plano: NÃO cair na consulta. Responder com
    // número real a uma frase começada por "se eu" é transformar hipótese em
    // fato — exatamente o que este módulo existe para impedir.
    return null
  }

  // ---- 3) consulta -------------------------------------------------------
  const planned = planQuery(state, message, { today: hoje })
  if (planned?.clarification) {
    return {
      reply: planned.clarification.question,
      kind: 'clarify',
      clarification: planned.clarification,
      focus: {
        ...focus, updatedAt: agora,
        pendingQueryClarification: {
          kind: /categorias/i.test(planned.clarification.question) ? 'categories' : 'period',
          plan: planned.plan, question: planned.clarification.question,
        },
      },
      confidence: 'high',
    }
  }

  // ---- 2b) explicação causal --------------------------------------------
  // Não é uma soma/ranking comum: a resposta precisa decompor a mudança e
  // reconciliar todas as contribuições com o resultado observado.
  const scopeQuestion = changeScopeClarification(message)
  if (scopeQuestion) return {
    reply: scopeQuestion, kind: 'clarify',
    clarification: { question: scopeQuestion, options: [
      { label: 'Comparar períodos', value: 'compare' },
      { label: 'Evolução mês a mês', value: 'trend' },
    ] },
    focus: focus || { updatedAt: agora }, confidence: 'high',
  }
  const drivers = answerChangeQuestion(state, message, hoje)
  if (drivers) {
    return {
      reply: drivers.reply, kind: 'explain',
      focus: rememberDriver(focus, drivers.analysis, drivers.explain, agora),
      confidence: 'high',
    }
  }
  // Plano INCOMPLETO não é executado: o número que sairia dele responderia uma
  // pergunta que o usuário não fez. O foco não muda.
  if (planned?.incompleto) {
    return { reply: '', kind: 'incomplete', residuo: planned.incompleto, focus: focus || { updatedAt: agora } }
  }
  const q = planned ? runPlannedQuery(state, planned, { today: hoje }) : null
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
    case 'incomplete':
      // O foco NÃO muda: o próximo refino continua sobre o que o usuário viu.
      return { reply: '', kind: 'incomplete', residuo: fu.residuo, focus }
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

export { isFocusFresh, looksLikeFollowUp, resolveFollowUp, rememberDriver, rememberQuery, rememberScenario }
export type { ConversationFocus, FollowUp }
