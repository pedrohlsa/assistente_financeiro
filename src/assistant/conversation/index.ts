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
import { fmtBRL, todayISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import { planQuery, runPlannedQuery } from '../query'
import { leadSimNao } from '../query/answer'
import { normalizeQuery } from '../query/parse'
import { parsePeriod, previousPeriod } from '../query/period'
import type { QueryAnswer } from '../query'
import { answerScenario, rerunScenario } from '../scenario'
import type { ScenarioAnswer } from '../scenario'
import { looksLikeScenario } from '../scenario/parse'
import { analyzeChanges, answerChangeQuestion, changeScopeClarification, composeChangeExplanation, expenseCategoryInQuestion } from '../drivers'
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
  const out = respondeConversa(state, message, opts)
  // Pergunta de sim ou não começa por sim ou não (regra 57), em qualquer
  // caminho que tenha terminado numa comparação: consulta nova ou refino.
  const plan = out?.kind === 'query' ? out.focus?.lastQueryPlan : undefined
  const q = out?.kind === 'query' ? out.focus?.lastQuery : undefined
  if (out && plan && q) {
    const lead = leadSimNao(normalizeQuery(message), plan, q.total, q.compareTotal, q.groups?.[0]?.delta)
    if (lead && !/^(?:sim|n[ãa]o)\b/i.test(out.reply)) return { ...out, reply: `${lead}${out.reply}` }
  }
  const cenario = out?.kind === 'scenario' ? out.focus?.lastScenario : undefined
  if (out && cenario) return { ...out, reply: releCenario(normalizeQuery(message), out.reply, cenario) }
  return out
}

/**
 * "Dá ruim?" e "qual mês fica pior?" repetiam a simulação inteira, igual à
 * anterior — o comentário prometia destacar a resposta e nada destacava. O
 * veredito e o mês mais apertado já vêm do motor; aqui só vão para a frente.
 */
function releCenario(t: string, reply: string, c: NonNullable<ConversationFocus['lastScenario']>): string {
  // Só a pergunta SOLTA, depois da simulação. Dentro da frase que monta o
  // cenário, a resposta completa já diz o mês mais apertado.
  if (/^(?:e\s+|entao\s+)?qual\s+mes\b.*\b(?:pior|mais\s+apertado)\b/.test(t)) {
    const m = c.tightest || [...c.months].sort((a, b) => a.after - b.after)[0]
    if (!m) return reply
    const sem = m.before !== m.after ? ` (seriam ${fmtBRL(m.before)} sem a hipótese)` : ''
    return `${sentenceCase(m.label)}: saldo estimado de ${fmtBRL(m.after)}${sem}. É o mês mais apertado da simulação.\n\nSimulação — nada foi registrado.`
  }
  // A resposta usa a palavra da pergunta: "cabe?" pede "cabe", "consigo?" pede
  // sim ou não. "Não dá ruim" para quem perguntou se cabe não responde nada.
  const pergunta = /\b(?:da|de)\s+ruim\b|\b(?:esta|fica|ficou|e)\s+ruim\b|\bvale\s+a\s+pena\b|\bcompensa\b|\baguento\b/.test(t) ? 'ruim'
    : /\bcabe\b/.test(t) ? 'cabe'
      : /\b(?:consigo|conseguiria|da\s+para|posso|e\s+possivel)\b/.test(t) ? 'sim' : null
  if (!pergunta || c.feasible === undefined) return reply
  if (/^(?:sim|n[ãa]o|d[áa]\s+ruim|d[áa],|aperta|cabe|o\s+saldo\s+aguenta)\b/i.test(reply)) return reply
  const mesNegativo = c.facts.some(f => /sobra do m[eê]s/i.test(f.label) && f.value < 0)
  const respostas = {
    ruim: ['Dá ruim.', 'O saldo aguenta, mas aperta: o mês fecha no vermelho.', 'Não dá ruim.'],
    cabe: ['Não cabe.', 'Cabe no saldo, mas aperta: o mês fecha no vermelho.', 'Cabe.'],
    sim: ['Não.', 'Dá, mas aperta: o mês fecha no vermelho.', 'Sim.'],
  }[pergunta]
  const lead = c.feasible === false ? respostas[0] : mesNegativo ? respostas[1] : respostas[2]
  return `${lead} ${reply}`
}

function respondeConversa(
  state: AppState,
  message: string,
  opts: ConversationOptions = {},
): ConversationAnswer | null {
  const hoje = opts.today || todayISO()
  const agora = opts.now ?? Date.now()
  const focus = opts.focus

  const driverPending = isFocusFresh(focus, agora) ? focus?.pendingDriverClarification : undefined
  if (driverPending) {
    const choice = normalizeName(message).replace(/[.!?]+$/, '').trim()
    if (/^(?:sim|comparar|compare|periodo anterior|com o anterior)$/.test(choice)) {
      const analysis = analyzeChanges(state, hoje, driverPending)
      const category = (state.categories || []).find(c => c.id === driverPending.expenseCategory)?.name
      const explanation = composeChangeExplanation(analysis, 'gastei mais')
      const reply = category ? `Para ${category}:\n\n${explanation}` : explanation
      return { reply, kind: 'explain', focus: rememberDriver(focus, analysis, reply, agora), confidence: 'high' }
    }
    if (/^(?:nao|não)$/.test(choice)) {
      const question = 'Quais dois períodos você quer comparar para essa categoria?'
      return { reply: question, kind: 'clarify', clarification: { question, options: [] },
        focus: { ...focus, pendingDriverClarification: undefined, updatedAt: agora }, confidence: 'high' }
    }
  }

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
  const scopeQuestion = changeScopeClarification(message, hoje)
  if (scopeQuestion) return {
    reply: scopeQuestion, kind: 'clarify',
    clarification: { question: scopeQuestion, options: [
      { label: 'Sim, comparar', value: 'sim' },
      { label: 'Não', value: 'não' },
    ] },
    focus: {
      ...focus, updatedAt: agora,
      pendingDriverClarification: (() => {
        const current = parsePeriod(message, hoje)?.period
        return current ? { current, previous: previousPeriod(current),
          expenseCategory: expenseCategoryInQuestion(state, message) } : undefined
      })(),
    }, confidence: 'high',
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
