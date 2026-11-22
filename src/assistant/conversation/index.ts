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
import type { AssistantClarification } from '../contracts'
import { fmtBRL, fmtNum, todayISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import { looksLikeQuestion } from '../clauses'
import { brDate, findAllDates } from '../dates'
import { pedeReservaDeCaixa } from '../cashQuestions'
import { planQuery, runPlannedQuery } from '../query'
import { leadSimNao } from '../query/answer'
import { normalizeQuery } from '../query/parse'
import { parseCalendarRange, parsePeriod, previousPeriod } from '../query/period'
import type { QueryAnswer } from '../query'
import type { AssistantQueryPlan } from '../query/types'
import { answerScenario, rerunScenario } from '../scenario'
import type { ScenarioAnswer } from '../scenario'
import { looksLikeScenario, parsePurchaseDelay, readScenarioBalanceReply, SCENARIO_BALANCE_QUESTION } from '../scenario/parse'
import { describeMissingRentalInput, mentionedRentals, readIncomeLossTiming } from '../scenario/incomeWindow'
import { normalizeNumberWords } from '../numbers'
import { analyzeChanges, answerChangeQuestion, changeScopeClarification, composeChangeExplanation, expenseCategoryInQuestion } from '../drivers'
import { answerVehicleCost } from '../vehicleCost'
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
  clarification?: AssistantClarification
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
  const queryText = normalizeQuery(message)
  if (looksLikeQuestion(message) && !pedeReservaDeCaixa(queryText)) {
    const today = opts.today || todayISO()
    const invalid = findAllDates(message, today).find(d => d.kind === 'invalid')
    const interval = parseCalendarRange(queryText, today)
    const realized = /\b(?:gastei|paguei|recebi|ganhei|guardei|faturei|entrou|saiu)\b/.test(queryText)
    const futureEnd = interval?.period && interval.period.to > today && realized && !/\b(?:vou|vai|sera|previsto)\b/.test(queryText)
    const question = invalid?.kind === 'invalid' ? invalid.question : interval?.question
      || (futureEnd && interval.period.from <= today
        ? `O intervalo termina em ${brDate(interval.period.to)}, uma data que ainda não chegou. Até qual data você quer consultar os lançamentos realizados?`
        : futureEnd ? 'Esse intervalo ainda não começou. Quais datas já ocorridas você quer consultar?' : undefined)
    if (question) return {
      kind: 'clarify', reply: question, clarification: { question, options: [],
        ...(futureEnd && interval.period.from <= today ? {
          field: 'query-range-end',
          dateWindow: { from: interval.period.from, to: today },
          queryTemplate: queryText.replace(interval.matched, `de ${interval.period.from} a %DATE%`),
        } : {}),
      },
      focus: opts.focus || { updatedAt: Date.now() },
    }
  }
  const out = respondeConversa(state, message, opts)
  // Pergunta de sim ou não começa por sim ou não (regra 57), em qualquer
  // caminho que tenha terminado numa comparação: consulta nova ou refino.
  const plan = out?.kind === 'query' ? out.focus?.lastQueryPlan : undefined
  const q = out?.kind === 'query' ? out.focus?.lastQuery : undefined
  if (out && plan && q && !q.empty) {
    const anterior = q.compareCount === 0 ? undefined : q.compareTotal
    const lead = leadSimNao(queryText, plan, q.total, anterior, q.groups?.[0]?.delta)
    if (lead && !/^(?:sim|n[ãa]o)\b/i.test(out.reply)) return { ...out, reply: `${lead}${out.reply}` }
  }
  const cenario = out?.kind === 'scenario' ? out.focus?.lastScenario : undefined
  if (out && cenario) return { ...out, reply: releCenario(queryText, out.reply, cenario) }
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
  const activeScenario = isFocusFresh(focus, agora) && focus?.last === 'scenario' ? focus.lastScenarioPlan : undefined
  if (activeScenario) {
    const awaitingBalance = activeScenario.planningIssue === SCENARIO_BALANCE_QUESTION
    const balance = awaitingBalance || /\bsaldo\b/i.test(message) ? readScenarioBalanceReply(message, awaitingBalance) : undefined
    if (balance !== undefined) {
      return aplicaFollowUp(state, focus, { kind: 'scenario',
        plan: { ...activeScenario, declaredBalance: balance,
          planningIssue: awaitingBalance ? undefined : activeScenario.planningIssue } }, hoje, agora)
    }
  }
  const awaitingRental = activeScenario
  if (awaitingRental?.kind === 'income-missing' && awaitingRental.incomeLossForRent && awaitingRental.planningIssue) {
    const said = normalizeName(normalizeNumberWords(message).text).replace(/[.!?]+$/, '').trim()
    const { duration, window, start, remaining, issue } = readIncomeLossTiming(said, hoje, awaitingRental.incomeLossStart)
    const rest = remaining.trim().replace(/^(?:(?:e|foi|seria)\s+)?(?:a\s+)?/, '')
      .replace(/^\s*(?:e|agora)\s*$/, '').trim()
    const [property, otherProperty] = mentionedRentals(state, rest, hoje).filter(source => source.said === rest)
    const name = otherProperty ? undefined : property?.origin
    if (name || (!rest && (duration || window || start || issue))) {
      const origin = name || awaitingRental.origin
      const changePeriod = !!(duration || window || start)
      const incomeLossDuration = changePeriod ? duration : awaitingRental.incomeLossDuration
      const incomeLossWindow = changePeriod ? window : awaitingRental.incomeLossWindow
      const planningIssue = issue
        || describeMissingRentalInput(origin, !!(incomeLossDuration || incomeLossWindow))
      return aplicaFollowUp(state, focus, { kind: 'scenario',
        plan: { ...awaitingRental, origin, incomeLossDuration, incomeLossWindow,
          incomeLossStart: changePeriod ? start : awaitingRental.incomeLossStart, planningIssue } }, hoje, agora)
    }
  }

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

  if (isFocusFresh(focus, agora) && focus?.last === 'query' && focus.lastQueryPlan && focus.lastQuery
    && !focus.lastAnswerExplanation) {
    const reply = proporcaoSobreResultado(state, message, focus.lastQueryPlan, focus.lastQuery, hoje)
    if (reply) return { reply, kind: 'explain', focus: { ...focus, updatedAt: agora }, confidence: 'high' }
  }

  // ---- 1) continuação ----------------------------------------------------
  if (isFocusFresh(focus, agora) && looksLikeFollowUp(message)) {
    const fu = resolveFollowUp(state, focus, message, hoje)
    // Uma hipótese completa pode iniciar outro cenário depois de uma simulação.
    // Referências parciais continuam usando o refinador e seus esclarecimentos.
    if (fu?.kind === 'ambiguous' && looksLikeScenario(message)) {
      const fresh = answerScenario(state, message, { today: hoje })
      if (fresh) return doCenario(focus, fresh, agora)
    }
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
    if (parsePurchaseDelay(message)) {
      const question = 'Qual compra você quer adiar? Me diga o valor, a entrada se houver e em quantas parcelas.'
      return { reply: question, kind: 'clarify', clarification: { question, options: [] },
        focus: { ...focus, updatedAt: agora }, confidence: 'high' }
    }
    // Hipótese reconhecida mas sem plano: NÃO cair na consulta. Responder com
    // número real a uma frase começada por "se eu" é transformar hipótese em
    // fato — exatamente o que este módulo existe para impedir.
    return null
  }

  const custoVeiculo = answerVehicleCost(state, normalizeQuery(message), hoje)
  if (custoVeiculo) {
    return { reply: custoVeiculo.text, kind: 'explain', confidence: 'high',
      focus: { last: 'vehicle', lastAnswerExplanation: custoVeiculo.explanation, updatedAt: agora,
        lastScenario: focus?.lastScenario, lastScenarioPlan: focus?.lastScenarioPlan, scenarioHistory: focus?.scenarioHistory } }
  }

  // A segunda pergunta pode usar o resultado conferido da primeira. Só o
  // denominador precisa virar outro plano.
  const duas = duasPerguntas(message)
  const planned = planQuery(state, duas ? duas.primeira : message, { today: hoje })
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
  if (q) {
    const resposta = daConsulta(focus, q, agora)
    if (duas) {
      const proporcao = proporcaoSobreResultado(state, duas.segunda, q.plan, q.result, hoje)
      resposta.reply += `\n\n${proporcao || `Para responder “${duas.segunda}”, preciso saber qual total você quer usar como comparação.`}`
      resposta.beyondLegacy = true
    }
    return resposta
  }

  return null
}

/**
 * Proporção entre dois recortes que podem ter tipos e filtros diferentes.
 * O numerador é o total que já foi mostrado. O denominador é outra soma
 * validada pela DSL, sem reaproveitar o filtro de gasto do numerador.
 */
function proporcaoSobreResultado(
  state: AppState, message: string, numerador: AssistantQueryPlan,
  total: Pick<QueryAnswer['result'], 'total' | 'unit' | 'empty'>, hoje: string,
): string | null {
  const t = normalizeName(message).replace(/[?.!]+$/, '').trim()
  const m = t.match(/^(?:e\s+)?(?:quanto|quantos\s+por\s+cento|qual\s+percentual)\s+(?:isso|esse\s+(?:valor|total)|aquilo)\s+(?:representa|corresponde)\s+(?:d[oa]s?)\s+(?:(?:meu|minha|meus|minhas|seu|sua|seus|suas)\s+)?(faturamento|renda|receitas?|entradas?|ganhos?|despesas?|gastos?)\b(.*)$/)
  if (!m) return null

  const resto = m[2].trim()
  const periodoInformado = parsePeriod(resto, hoje)
  const periodo = periodoInformado?.period || numerador.period
  const recorte = periodoInformado ? resto.replace(periodoInformado.span || periodoInformado.matched, ' ').trim() : resto
  if (recorte && !/^(?:na|no|da|do|pela|pelo|via)\s+(?:uber|99|indrive|indriver)$/.test(recorte)) {
    return 'Qual total você quer usar como comparação? Posso usar as entradas, os gastos ou o faturamento de uma plataforma.'
  }
  if (total.unit !== 'BRL' || total.empty || !Number.isFinite(total.total) || total.total < 0
    || numerador.metric !== 'sum' || numerador.group !== 'none' || numerador.comparePeriod
    || numerador.period.to > hoje || numerador.filter.plannedOnly || numerador.source !== 'transactions') {
    return 'Preciso de um total em reais de lançamentos realizados para calcular essa proporção.'
  }
  if (periodo.to > hoje) return 'Para calcular essa proporção, informe um período que já tenha ocorrido.'
  const despesa = /^(?:despesa|gasto)/.test(m[1])
  const planned = planQuery(state, `quanto ${despesa ? 'gastei' : 'recebi'} ${recorte}`.trim(), { today: hoje })
  const base = planned && !planned.incompleto && (!recorte || planned.plan.filter.platform)
    ? runPlannedQuery(state, { ...planned, plan: { ...planned.plan, period: { ...periodo, implicit: false } } }, { today: hoje })
    : null
  if (!base || base.result.empty || !(base.result.total > 0)) {
    return `Não encontrei um total disponível ${periodo.label} para usar como base da proporção.`
  }
  const pct = total.total / base.result.total * 100
  const rotulo = (base.plan.label || 'total de referência').toLowerCase().replace(/\b(uber|indrive)\b/g, w => w === 'uber' ? 'Uber' : 'inDrive')
  return `${fmtBRL(total.total)} representam ${fmtNum(pct, 2)}% de ${fmtBRL(base.result.total)} (${rotulo} ${periodo.label}).`
}

/**
 * Frase com DUAS perguntas em que a segunda aponta para o resultado da
 * primeira ("…, e quanto isso representa…"). Só esse caso: duas perguntas
 * independentes continuam indo inteiras ao planejador.
 */
function duasPerguntas(message: string): { primeira: string; segunda: string } | null {
  const m = message.match(/^(.*?\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como)\b.+?)[,;]?\s+e\s+((?:quanto|quantos|quantas|qual|quais|quando|onde|como|por\s+que|pq)\b.+)$/i)
  if (!m) return null
  const segunda = m[2].trim()
  if (!/\b(?:isso|disso|aquilo|esse\s+valor|desse\s+valor|esse\s+total|desse\s+total)\b/i.test(segunda)) return null
  return { primeira: m[1].trim().replace(/[,;]$/, ''), segunda: segunda.replace(/[?.!]+$/, '') }
}

function aplicaFollowUp(
  state: AppState, focus: ConversationFocus, fu: FollowUp, hoje: string, agora: number,
): ConversationAnswer | null {
  switch (fu.kind) {
    case 'explain':
      return { reply: fu.text, kind: 'explain',
        focus: { ...focus, updatedAt: agora, lastAnswerExplanation: fu.followUpExplanation }, confidence: 'high' }
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
