// FOCO CONVERSACIONAL — o mínimo que precisa sobreviver de uma pergunta para a
// próxima, e nada além disso.
//
// O que NÃO se faz aqui: despejar as últimas mensagens num prompt e torcer para
// o modelo descobrir do que se está falando. "E mês passado?" tem uma resposta
// exata — é a MESMA consulta com outro período — e adivinhar isso com um modelo
// seria trocar uma certeza barata por uma probabilidade cara.
//
// Três decisões:
//
// 1. ESTRUTURA, NÃO TEXTO. Guardamos o PLANO da última consulta e do último
//    cenário. O follow-up REFINA o plano; ele não reinterpreta a conversa.
// 2. EM MEMÓRIA, COMO O RASCUNHO. Não sobrevive a reload, de propósito: uma
//    referência pendente que ressuscita depois de o app fechar aponta para uma
//    conversa que o usuário já esqueceu.
// 3. DOIS CANDIDATOS PERGUNTAM. Referência ambígua sobre dinheiro nunca é
//    resolvida por probabilidade — a saída é a mesma do resto do app.

import type { AppState } from '../../models/types'
import { addDays, fmtBRL, fromISO, todayISO, toISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import { activeCards } from '../../services/cards'
import { usableCategories } from '../../data/categories'
import { normalizeNumberWords } from '../numbers'
import { parsePeriod, previousPeriod } from '../query/period'
import { ehResiduo, planQuery } from '../query/parse'
import type { PlannedQuery } from '../query/parse'
import type { AssistantQueryPlan, AssistantQueryResult, FactUnit, QueryPeriod } from '../query/types'
import type { AssistantScenarioPlan, AssistantScenarioResult } from '../scenario/types'
import type { ChangeAnalysis } from '../drivers'
import type { ChangeScope } from '../drivers/engine'

/** Mesmo tempo do rascunho: uma conversa parada 20 minutos acabou. */
export const FOCUS_TTL_MINUTES = 20

export interface QuerySummary {
  label: string
  total: number
  /** Segundo número mostrado na última resposta, quando ela comparou períodos. */
  compareTotal?: number
  unit: FactUnit
  period: QueryPeriod
  groups: { key: string; label: string; value: number; delta?: number }[]
  empty: boolean
  /** Frase pronta da explicação — evita reexecutar a consulta para o "por quê?". */
  explain: string
}

export interface ScenarioSummary {
  label: string
  facts: { label: string; value: number; unit: FactUnit }[]
  months: AssistantScenarioResult['months']
  explain: string
}

export interface DriverSummary {
  analysis: ChangeAnalysis
  explain: string
}

export interface ConversationFocus {
  /** Plano local aguardando resposta curta à pergunta de desambiguação. */
  pendingQueryClarification?: { kind: 'categories' | 'period'; plan: AssistantQueryPlan; question: string }
  pendingDriverClarification?: ChangeScope
  lastQueryPlan?: AssistantQueryPlan
  lastQuery?: QuerySummary
  /**
   * Plano da consulta ANTERIOR. É ele que "qual a diferença?" e "compara os
   * dois" precisam: os dois períodos que o usuário acabou de ver, não o
   * período atual contra o imediatamente anterior a ele. Sem isto, depois de
   * "este mês" → "e mês passado?" → "qual a diferença?", o app comparava julho
   * com junho e o usuário lia sobre um mês que ninguém citou.
   */
  previousQueryPlan?: AssistantQueryPlan
  /** Resultado que o usuário viu antes do último período, para comparar sem inverter os lados. */
  previousQuery?: QuerySummary
  lastScenarioPlan?: AssistantScenarioPlan
  lastScenario?: ScenarioSummary
  /** Pilha curta para "volta pro cenário anterior". */
  scenarioHistory?: AssistantScenarioPlan[]
  lastDriver?: DriverSummary
  /** O último assunto foi consulta ou cenário? Decide quem o follow-up refina. */
  last?: 'query' | 'scenario' | 'driver'
  /** Entidades citadas — matéria-prima da elipse ("e o outro?"). */
  entities?: { cards?: string[]; categories?: string[]; goals?: string[]; origins?: string[] }
  updatedAt: number
}

export function rememberDriver(
  prev: ConversationFocus | undefined, analysis: ChangeAnalysis, explain: string, now = Date.now(),
): ConversationFocus {
  return { ...prev, pendingQueryClarification: undefined, pendingDriverClarification: undefined,
    lastDriver: { analysis, explain }, last: 'driver', updatedAt: now }
}

export const isFocusFresh = (f?: ConversationFocus, now = Date.now()): boolean =>
  !!f && now - f.updatedAt < FOCUS_TTL_MINUTES * 60_000

export function rememberQuery(
  prev: ConversationFocus | undefined,
  plan: AssistantQueryPlan,
  result: AssistantQueryResult,
  explain: string,
  now = Date.now(),
): ConversationFocus {
  return {
    ...prev,
    pendingQueryClarification: undefined,
    pendingDriverClarification: undefined,
    lastQueryPlan: plan,
    // Só guarda como "anterior" quando o período mudou de verdade: refinar um
    // filtro sobre o mesmo mês não cria um segundo período para comparar.
    previousQueryPlan: prev?.lastQueryPlan && prev.lastQueryPlan.period.from !== plan.period.from
      ? prev.lastQueryPlan
      : prev?.previousQueryPlan,
    previousQuery: prev?.lastQueryPlan && prev.lastQueryPlan.period.from !== plan.period.from
      ? prev.lastQuery
      : prev?.previousQuery,
    lastQuery: {
      label: plan.label || 'Total',
      total: result.total,
      compareTotal: result.compareTotal,
      unit: result.unit,
      period: plan.period,
      groups: result.groups.slice(0, 8).map(g => ({ key: g.key, label: g.label, value: g.value, delta: g.delta })),
      empty: result.empty,
      explain,
    },
    last: 'query',
    entities: {
      ...prev?.entities,
      cards: plan.filter.cardNames || prev?.entities?.cards,
      categories: plan.filter.categories || prev?.entities?.categories,
      origins: plan.filter.origins || (plan.filter.origin ? [plan.filter.origin] : prev?.entities?.origins),
    },
    updatedAt: now,
  }
}

export function rememberScenario(
  prev: ConversationFocus | undefined,
  plan: AssistantScenarioPlan,
  result: AssistantScenarioResult,
  explain: string,
  now = Date.now(),
): ConversationFocus {
  const pilha = [...(prev?.scenarioHistory || [])]
  // Plano IDÊNTICO não vira histórico: reler o mesmo cenário ("qual mês fica
  // pior?") empilhava uma cópia, e "volta pro anterior" devolvia exatamente o
  // que já estava na tela.
  const anterior = prev?.lastScenarioPlan
  if (anterior && JSON.stringify(anterior) !== JSON.stringify(plan)) pilha.unshift(anterior)
  return {
    ...prev,
    pendingQueryClarification: undefined,
    pendingDriverClarification: undefined,
    lastScenarioPlan: plan,
    lastScenario: {
      label: plan.label,
      facts: result.facts.map(f => ({ label: f.label, value: f.value, unit: f.unit })),
      months: result.months,
      explain,
    },
    scenarioHistory: pilha.slice(0, 5),
    last: 'scenario',
    entities: {
      ...prev?.entities,
      cards: plan.cardName ? [plan.cardName] : prev?.entities?.cards,
      goals: plan.goalName ? [plan.goalName] : prev?.entities?.goals,
    },
    updatedAt: now,
  }
}

// ---------------------------------------------------------------------------
// A mensagem é um follow-up?
// ---------------------------------------------------------------------------

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * Marcadores de continuação. Um follow-up REAL é curto e começa por um destes —
 * uma pergunta inteira e nova segue o caminho normal, mesmo que fale do mesmo
 * assunto. Reaproveitar o plano anterior numa frase completa arriscaria
 * carregar filtros que o usuário não repetiu.
 */
const CONTINUACAO = [
  /^e\b/, /^agora\b/, /^entao\b/, /^tirando\b/, /^sem\b/, /^so\b/, /^somente\b/,
  /^apenas\b/, /^qual\s+(?:a\s+)?diferenca/, /^compara/, /^por\s*que/, /^pq\b/,
  /^como\s+(?:voce\s+)?(?:chegou|calculou|fez)/, /^quais\s+dados/,
  // "De onde SAIU isso" pergunta pela conta anterior; "de onde VEM meu
  // dinheiro" e uma pergunta nova. So a primeira e continuacao.
  /^de\s+onde\s+(?:voce\s+)?(?:tirou|saiu|veio\s+(?:esse|essa|isso))/,
  /^volta\b/, /^e\s+se\b/, /^mesma\s+coisa\b/,
  /^ate\b/,
  /^e\s+(?:qual\s+foi\s+)?o\s+segundo\b/, /^isso\b/,
  // "Onde?" SOZINHO, logo depois de um total: onde foi parar aquele dinheiro.
  // Só a forma curta — "onde gastei esse mês" é pergunta nova e segue o
  // caminho normal, com o próprio período.
  /^(?:e\s+)?(?:pra\s+|para\s+)?a?onde\s*\??$/,
  // "qual mês fica pior?" logo depois de uma simulação fala DA SIMULAÇÃO, não
  // do histórico. Mandar essa frase para o planner comum respondia com o pior
  // mês REAL do passado — um número correto sobre a pergunta errada.
  /^qual\s+mes\s+(?:fica|seria|vai\s+ficar|e)\s+(?:o\s+)?(?:pior|mais\s+apertado)/,
  // "Qual foi pior?" logo depois de ver dois períodos compara OS DOIS. Sem
  // isto a frase virava pergunta nova e o filtro do assunto se perdia — quem
  // acabou de falar de obra recebia o total do mês inteiro.
  /^qual\s+(?:foi\s+)?(?:o\s+)?(?:pior|melhor)\s*\??$/,
  /^qual\s+d[oa]s\s+(?:duas|dois)\b/,
  // "Dá ruim?" depois de uma simulação pergunta pela simulação.
  /^(?:d[áa]\s+ruim|ficou\s+ruim|t[áa]\s+ruim|[ée]\s+ruim|vale\s+a\s+pena)\s*\??$/,
]

/** Frase curta o bastante para ser continuação, e não uma pergunta nova. */
const MAX_FOLLOWUP_CHARS = 70

export const looksLikeFollowUp = (message: string): boolean => {
  const t = semAcento(message)
  if (t.length > MAX_FOLLOWUP_CHARS) return false
  return CONTINUACAO.some(re => re.test(t))
}

// ---------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------

export type FollowUp =
  | { kind: 'query'; planned: PlannedQuery }
  | { kind: 'scenario'; plan: AssistantScenarioPlan }
  | { kind: 'explain'; text: string }
  | { kind: 'ambiguous'; question: string; options: { label: string; value: string }[] }
  /** O refino acrescentaria um filtro feito de pedaço de pergunta não entendido. */
  | { kind: 'incomplete'; residuo: string }

const PEDE_EXPLICACAO = /^(?:por\s*que|pq|como\s+(?:voce\s+)?(?:chegou|calculou|fez)|de\s+onde|quais\s+dados)/

/**
 * Interpreta a continuação sobre o foco. `null` quando não dá para resolver com
 * segurança — e aí a mensagem segue o caminho normal, que é sempre melhor do
 * que refinar o plano errado.
 */
export function resolveFollowUp(
  state: AppState,
  focus: ConversationFocus | undefined,
  message: string,
  today = todayISO(),
): FollowUp | null {
  if (!isFocusFresh(focus) || !focus) return null
  if (!looksLikeFollowUp(message)) return null
  // "E dando MIL de entrada?" — o número por extenso vira algarismo aqui, pelo
  // mesmo conversor que o parser de registro usa. Sem isso o refino não achava
  // valor nenhum e a continuação caía como pergunta nova.
  const t = semAcento(normalizeNumberWords(message).text)

  if (focus.last === 'driver' && /^e\s+(?:qual\s+foi\s+)?o\s+segundo\b/.test(t)) {
    const d = focus.lastDriver?.analysis.drivers[1]
    if (d) {
      const movimento = d.delta >= 0 ? 'subiu' : 'caiu'
      return { kind: 'explain', text: `O segundo maior fator foi ${d.label}: ${movimento} ${fmtBRL(Math.abs(d.delta))} e teve efeito de ${d.contribution >= 0 ? '+' : '−'}${fmtBRL(Math.abs(d.contribution))} no resultado.` }
    }
  }

  // ---- "por quê?" / "como chegou nisso?" --------------------------------
  if (PEDE_EXPLICACAO.test(t)) {
    const texto = focus.last === 'scenario' ? focus.lastScenario?.explain
      : focus.last === 'driver' ? focus.lastDriver?.explain
        : focus.lastQuery?.explain
    return texto ? { kind: 'explain', text: texto } : null
  }

  // ---- cenário ----------------------------------------------------------
  if (focus.last === 'scenario' && focus.lastScenarioPlan) {
    const refinado = refinaCenario(focus, t, today)
    if (refinado) return { kind: 'scenario', plan: refinado }
    const gasto = t.match(/^(?:e\s+)?(?:tirando|sem)\s+(.+?)\s*\??$/)?.[1]?.replace(/\?$/, '').trim()
    if (gasto) return {
      kind: 'ambiguous',
      question: `Você quer tirar ${gasto} da simulação atual? Só posso retirar despesas futuras cadastradas. Confirme o gasto ou diga qual outro devo usar.`,
      options: [],
    }
    // Uma continuação não compreendida pertence ao cenário ativo. Não se
    // pode ressuscitar uma consulta antiga só porque ela ainda está no foco.
    return {
      kind: 'ambiguous',
      question: 'Você quer mudar a simulação atual? Diga qual gasto futuro cadastrado devo tirar ou reduzir.',
      options: [
        { label: 'Mudar simulação', value: 'scenario' },
        { label: 'Nova consulta real', value: 'query' },
      ],
    }
  }

  // ---- consulta ---------------------------------------------------------
  if (focus.lastQueryPlan) {
    const r = refinaConsulta(state, focus, focus.lastQueryPlan, t, today)
    if (r) return r.kind === 'query' ? semSobra(r, focus.lastQueryPlan) : r
  }

  // Cenário como segunda tentativa: o usuário pode ter feito uma consulta no
  // meio e voltado à hipótese.
  if (focus.lastScenarioPlan) {
    const refinado = refinaCenario(focus, t, today)
    if (refinado) return { kind: 'scenario', plan: refinado }
  }
  return null
}

/**
 * A mesma trava do planejador, no refino: "e na 99" depois de "quanto fiz na
 * uber" mantinha a Uber E buscava o texto "99" — e o app afirmava que não havia
 * lançamento. Um filtro de texto NOVO feito de pedaço de pergunta deixa o
 * refino incompleto, e a frase vai para quem sabe lê-la.
 */
function semSobra(r: Extract<FollowUp, { kind: 'query' }>, base: AssistantQueryPlan): FollowUp {
  const f = r.planned.plan.filter
  for (const campo of ['text', 'excludeText'] as const) {
    const novo = f[campo]
    if (campo === 'excludeText' && novo && ehNomeDeOrigem(novo)) continue
    if (novo && novo !== base.filter[campo] && ehResiduo(novo)) return { kind: 'incomplete', residuo: novo }
  }
  return r
}

// ---------------------------------------------------------------------------
// Refino do cenário
// ---------------------------------------------------------------------------

const NUM = String.raw`(\d+(?:[.,]\d+)*)`

function refinaCenario(focus: ConversationFocus, t: string, today: string): AssistantScenarioPlan | null {
  const base = focus.lastScenarioPlan!

  // Horizonte é um refinamento do cenário já calculado. Propaga para todos os
  // passos para não deixar um subcenário preso no padrão de seis meses.
  const ateMes = t.match(/^(?:e\s+)?ate\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*\??$/)
  if (ateMes) {
    const nomes = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const alvo = nomes.indexOf(ateMes[1])
    const atual = Number(today.slice(5, 7)) - 1
    const months = Math.min((alvo >= atual ? alvo - atual : alvo + 12 - atual) + 1, 12)
    return { ...base, months, steps: base.steps?.map(step => ({ ...step, months })) }
  }

  // "Qual mês fica pior?" é a MESMA simulação, relida pelo mês mais apertado —
  // o motor já calcula isso e a resposta o destaca.
  if (/^qual\s+mes\s+(?:fica|seria|vai\s+ficar|e)\s+(?:o\s+)?(?:pior|mais\s+apertado)/.test(t)) {
    return { ...base }
  }

  // "Dá ruim?" e "vale a pena?" perguntam pela MESMA simulação — o motor já
  // calcula a viabilidade e a resposta a destaca.
  if (/^(?:d[áa]\s+ruim|ficou\s+ruim|t[áa]\s+ruim|[ée]\s+ruim|vale\s+a\s+pena)\s*\??$/.test(t)) {
    return { ...base }
  }
  if (/^isso\s+(?:ainda\s+)?cabe\s+(?:n[oa]\s+)?mes/.test(t)) return { ...base }

  const shareFollowup = t.match(/^e\s+(?:se\s+)?(?:eu\s+)?guardar\s+(?:(?:a\s+)?metade\s+(?:disso|do\s+que\s+sobrar)|tudo\s+(?:o\s+)?que\s+sobrar|(\d{1,3})\s*%\s+d(?:a|o)\s+sobra)/)
  if (shareFollowup) {
    const ratio = /\btudo\b/.test(t) ? 1 : shareFollowup[1] ? Math.min(Number(shareFollowup[1]) / 100, 1) : 0.5
    const share: AssistantScenarioPlan = {
      version: base.version, kind: 'save-share', ratio,
      months: base.months, label: `guardar ${Math.round(ratio * 100)}% do que sobrar`,
    }
    return base.kind === 'compound'
      ? { ...base, steps: [...(base.steps || []), share], label: `cenário com ${(base.steps?.length || 0) + 1} mudanças` }
      : { version: base.version, kind: 'compound', steps: [base, share], months: base.months, label: 'cenário com 2 mudanças' }
  }

  if (/^volta\b/.test(t)) {
    // Sem cenário anterior, devolver o ATUAL é melhor que o texto genérico de
    // ajuda: o usuário continua vendo aquilo de que estava falando.
    return { ...(focus.scenarioHistory?.[0] || base) }
  }

  // "e em 12?" / "agora em 6x" / "e em 10 vezes"
  const parcelas = t.match(new RegExp(String.raw`^(?:e|agora|entao)?\s*(?:em|com)?\s*${NUM}\s*(?:x|vezes|parcelas)?\s*\??$`))
    || t.match(new RegExp(String.raw`\b(?:em|para)\s+${NUM}\s*(?:x|vezes|parcelas)\b`))
  if (parcelas && base.kind === 'purchase') {
    const n = Math.round(Number(parcelas[1].replace(/[.,]/g, '')))
    if (n >= 1 && n <= 120) return { ...base, installments: n, downPayment: base.downPayment, label: `comprar ${base.amount} em ${n}x` }
  }

  // "e dando mil de entrada?" / "e com 1000 de entrada"
  const entrada = t.match(new RegExp(String.raw`\b(?:dando|com|de)\s+${NUM}\s*(?:reais\s*)?de\s+entrada\b`))
    || t.match(new RegExp(String.raw`\bentrada\s+de\s+(?:r\$\s*)?${NUM}`))
    || t.match(new RegExp(String.raw`^e\s+(?:dando|com)\s+${NUM}\s*(?:de\s+entrada)?\s*\??$`))
  if (entrada && base.kind === 'purchase') {
    const v = Number(entrada[1].replace(/\./g, '').replace(',', '.'))
    if (v > 0) return { ...base, downPayment: v, label: `${base.label} com ${v} de entrada` }
  }
  // "e sem entrada?"
  if (/\bsem\s+entrada\b/.test(t) && base.kind === 'purchase') {
    return { ...base, downPayment: undefined, label: `${base.label} sem entrada` }
  }

  // "e se for 3500?" — troca o VALOR, mantendo o resto do cenário.
  const valor = t.match(new RegExp(String.raw`\bse\s+(?:for|fosse|custar|custasse)\s+(?:r\$\s*)?${NUM}`))
    || t.match(new RegExp(String.raw`^e\s+(?:r\$\s*)?${NUM}\s*(?:reais)?\s*\??$`))
  if (valor) {
    const v = Number(valor[1].replace(/\./g, '').replace(',', '.'))
    if (v > 0) return { ...base, amount: v, label: base.label.replace(/\d[\d.,]*/, String(v)) }
  }

  // "e mais 3 horas?" / "e mais 80 km?"
  const horas = t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*(?:h|horas?)\b`))
  if (horas && base.kind === 'extra-work') {
    return { ...base, hoursPerDay: Number(horas[1].replace(',', '.')), extraKm: undefined, label: `mais ${horas[1]}h` }
  }
  const km = t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*km\b`))
  if (km && base.kind === 'extra-work') {
    return { ...base, extraKm: Number(km[1].replace(',', '.')), hoursPerDay: undefined, label: `mais ${km[1]} km` }
  }

  return null
}

// ---------------------------------------------------------------------------
// Refino da consulta
// ---------------------------------------------------------------------------

function refinaConsulta(
  state: AppState,
  focus: ConversationFocus,
  base: AssistantQueryPlan,
  t: string,
  today: string,
): FollowUp | null {
  const planned = (plan: AssistantQueryPlan, motivo: string): FollowUp =>
    ({ kind: 'query', planned: { plan, confidence: 'high', recognized: [motivo] } })

  // ---- "qual foi pior?" — os DOIS períodos que ele acabou de ver -------
  if (/^qual\s+(?:foi\s+)?(?:o\s+)?(?:pior|melhor)\s*\??$/.test(t)) {
    const anterior = focus.previousQuery
    const atual = focus.lastQuery
    const outroPlano = focus.previousQueryPlan
    const mesmoRecorte = outroPlano && outroPlano.source === base.source
      && outroPlano.metric === base.metric && outroPlano.field === base.field
      && JSON.stringify(outroPlano.filter) === JSON.stringify(base.filter)
    const tipo = base.filter.txType
    // A última resposta pode já ter mostrado DOIS períodos. Nesse caso o
    // comparativo visível vence uma consulta ainda mais antiga da conversa.
    const comparado = atual?.compareTotal !== undefined && base.comparePeriod
      ? { ...atual, total: atual.compareTotal, period: base.comparePeriod }
      : mesmoRecorte ? anterior : undefined
    if (comparado && atual && base.metric === 'sum'
      && tipo?.length === 1 && (tipo[0] === 'expense' || tipo[0] === 'income')) {
      const maiorPior = tipo[0] === 'expense'
      const querPior = /pior/.test(t)
      const aVence = querPior
        ? (maiorPior ? atual.total > comparado.total : atual.total < comparado.total)
        : (maiorPior ? atual.total < comparado.total : atual.total > comparado.total)
      const vencedor = aVence ? atual : comparado
      const perdedor = aVence ? comparado : atual
      const nome = (q: QuerySummary) => q.period.grain === 'month'
        ? fromISO(q.period.from).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
        : q.period.label
      const medida = maiorPior ? 'gastos' : 'receitas'
      if (atual.total === comparado.total) return { kind: 'explain', text:
        `Empataram em ${medida}: ${nome(atual)} e ${nome(comparado)} tiveram ${fmtBRL(atual.total)}.` }
      return { kind: 'explain', text:
        `${nome(vencedor)} foi ${querPior ? 'pior' : 'melhor'} em ${medida}: ${fmtBRL(vencedor.total)}, contra ${fmtBRL(perdedor.total)} em ${nome(perdedor)}.` }
    }
    const cmp = focus.previousQueryPlan?.period || base.comparePeriod || previousPeriod(base.period)
    return planned({ ...base, comparePeriod: cmp }, `comparação com ${cmp.label}`)
  }

  // ---- "qual das duas rende mais?" — agrupa pela entidade em foco ------
  if (/^qual\s+d[oa]s\s+(?:duas|dois)\b/.test(t)) {
    const porOrigem = !!base.filter.origin || !!focus.entities?.origins?.length
    const grupo = porOrigem ? 'origin' : base.filter.cardNames?.length ? 'card' : 'category'
    // A origem que estava filtrando SAI: comparar duas exige ver as duas.
    const filtro = { ...base.filter }
    delete filtro.origin
    delete filtro.cardNames
    return planned({ ...base, group: grupo, filter: filtro, order: 'value-desc', limit: 6 }, `por ${grupo}`)
  }

  // ---- "qual a diferença?" / "compara os dois" --------------------------
  if (/^(?:qual\s+(?:a\s+)?diferenca|compara)/.test(t)) {
    // Dois meses citados nesta pergunta vencem o foco anterior. Sem isso,
    // "quanto gastei em julho" → "compara julho com junho" comparava julho
    // com o mês que estava no foco antes da conversa.
    if (/^compar[ao]\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b.*\bcom\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(t)) {
      const novo = planQuery(state, t, { today })
      if (novo) {
        const explicitCategory = !!novo.plan.filter.categories?.length
        const allCategories = /\b(?:todas?\s+as\s+categorias|no\s+total|total\s+geral|em\s+geral|de\s+tudo)\b/.test(t)
        const explicitOrigin = !!novo.plan.filter.origin || !!novo.plan.filter.origins?.length
        const explicitType = /\b(?:gastos?|despesas?|receitas?|entradas?|renda|ganhos?|recebid[oa]s?|receb(?:i|o|er)|ganh(?:ei|o|ar)|gast(?:ei|o|ar)|pagu(?:ei|e)|pagar)\b/.test(t)
        // O plano novo serve para identificar um recorte explicitamente pedido.
        // Seus defaults (como txType=expense) e texto residual não podem trocar
        // a medida da consulta anterior nem contaminar os próximos turnos.
        const filter = { ...base.filter }
        if (explicitCategory) filter.categories = novo.plan.filter.categories
        if (explicitOrigin) {
          filter.origin = novo.plan.filter.origin
          filter.origins = novo.plan.filter.origins
        }
        if (explicitType) filter.txType = novo.plan.filter.txType
        if (allCategories) {
          delete filter.categories
          delete filter.text
          if (!explicitOrigin) {
            delete filter.origin
            delete filter.origins
          }
        }
        const basePrefix = base.label.split(' - ')[0]
        const sumPrefix = filter.txType?.length === 1
          ? filter.txType[0] === 'income' ? 'Total recebido'
            : filter.txType[0] === 'saving' ? 'Total guardado' : 'Total gasto'
          : basePrefix
        const prefix = base.source === 'transactions' && base.metric === 'sum' ? sumPrefix : basePrefix
        const scopes = [
          ...(filter.categories || []).map(id => state.categories.find(c => c.id === id)?.name || id),
          ...(filter.origins || (filter.origin ? [filter.origin] : [])).map(sentenceCase),
          ...(filter.text ? [sentenceCase(filter.text)] : []),
        ]
        const label = scopes.length ? `${prefix} - ${scopes.join(' - ')}` : prefix
        return { kind: 'query', planned: { ...novo, plan: { ...novo.plan,
          source: base.source, metric: base.metric, field: base.field, filter,
          label } } }
      }
    }
    // "Os dois" são os DOIS PERÍODOS que o usuário acabou de ver. Só na falta
    // de um segundo período é que cai no imediatamente anterior.
    const cmp = focus.previousQueryPlan?.period || base.comparePeriod || previousPeriod(base.period)
    return planned({ ...base, comparePeriod: cmp }, `comparação com ${cmp.label}`)
  }

  // ---- elipse: "e o outro?" --------------------------------------------
  // ANTES da restrição: "e o outro" casava com o padrão de restrição e
  // "outro" virava a categoria "Outros" — a pergunta sobre o segundo cartão
  // devolvia o total da categoria Outros, com cara de resposta.
  if (/^e\s+(?:o\s+|a\s+)?outr[oa]\b/.test(t)) {
    const cartoes = activeCards(state).map(c => c.name)
    const citado = base.filter.cardNames?.[0] || focus.lastQuery?.groups[0]?.label || focus.entities?.cards?.[0]
    const restantes = cartoes.filter(c => normalizeName(c) !== normalizeName(citado || ''))
    if (citado && restantes.length === 1) {
      return planned({ ...base, group: 'none', filter: { ...base.filter, cardNames: restantes } }, `cartão ${restantes[0]}`)
    }
    if (restantes.length > 1) {
      // Dois candidatos possíveis: perguntar. Chute probabilístico sobre
      // dinheiro é proibido (regra da fase 11).
      return { kind: 'ambiguous', question: 'Qual deles?', options: restantes.map(c => ({ label: c, value: c })) }
    }
    return null
  }

  // ---- aprofundar, ANTES do período -------------------------------------
  // "E por dia da semana?" contém "da semana", que o leitor de período casa
  // como "esta semana": a pergunta sobre AGRUPAMENTO virava uma troca de
  // período e a resposta vinha sem nenhum agrupamento.
  // ---- "onde?" — o destino, dentro do assunto que está na tela ----------
  // Depois de "quanto gastei com obra", "onde?" pergunta EM QUE dentro da obra
  // (cimento, pedreiro, loja); sem assunto filtrado, em que categoria. Somar de
  // novo o mesmo total respondia "quanto" a quem perguntou "onde".
  if (/^(?:e\s+)?(?:pra\s+|para\s+)?a?onde\s*\??$/.test(t)) {
    const dentroDoAssunto = !!base.filter.categories?.length
    return planned({ ...base, group: dentroDoAssunto ? 'description' : 'category', order: 'value-desc', limit: 6 },
      dentroDoAssunto ? 'onde, dentro do assunto' : 'por categoria')
  }

  const agrupamento = grupoPedido(t)
  if (agrupamento) {
    const cmp = agrupamento.exigeComparacao ? (base.comparePeriod || previousPeriod(base.period)) : base.comparePeriod
    return planned({
      ...base, group: agrupamento.group, comparePeriod: cmp,
      order: agrupamento.order, limit: 6,
      period: agrupamento.janela ? agrupamento.janela(today) : base.period,
    }, agrupamento.rotulo)
  }

  // ---- outro período: "e mês passado?", "e em outubro?" -----------------
  const p = parsePeriod(t, today)
  if (p) {
    // Quando já havia comparação, trocar o período principal mantém o
    // comparativo relativo — "e mês passado?" depois de "e mês retrasado?"
    // continua comparando com o anterior imediato.
    const cmp = base.comparePeriod ? previousPeriod(p.period) : undefined
    // `plans` é uma foto da dívida ATUAL: mudar o período não muda nada, e a
    // resposta saía idêntica à anterior como se o app tivesse ignorado a
    // pergunta. O que cabe num mês é a PARCELA.
    if (base.source === 'plans') {
      return planned({
        ...base, source: 'installments', field: 'amount', period: p.period,
        comparePeriod: cmp, filter: { ...base.filter, status: undefined },
        label: 'Parcelas',
      }, p.matched)
    }
    return planned({ ...base, period: p.period, comparePeriod: cmp }, p.matched)
  }

  // ---- exclusão: "e tirando obra?", "e sem cimento?" --------------------
  const excluir = t.match(/\b(?:tirando|sem|fora|exceto|desconsiderando)\s+(?:contar\s+|considerar\s+|incluir\s+)?(?:o\s+|a\s+|os\s+|as\s+)?([a-z0-9çãõáéíóúâê][a-z0-9\s\-çãõáéíóúâê]{1,30}?)\s*\??$/)
  if (excluir) {
    // "tirando cimento da conta" tem uma cauda que não faz parte do nome:
    // procurar por "cimento da conta" não acha nada e a exclusão vira letra
    // morta — a resposta sai idêntica e parece que o app ignorou o pedido.
    const alvo = excluir[1].trim().replace(/\s+d[aeo]s?\s+\S+$/, '').trim()
    const cartao = achaCartao(state, alvo)
    const origem = ehNomeDeOrigem(alvo)
    const cat = cartao || origem ? undefined : achaCategoria(state, alvo)
    const filtro = { ...base.filter }
    if (cartao) filtro.excludeCardNames = [...(filtro.excludeCardNames || []), cartao]
    else if (origem) filtro.excludeText = alvo
    else if (cat) filtro.excludeCategories = [...(filtro.excludeCategories || []), cat]
    else filtro.excludeText = alvo
    // Excluir o que estava incluído seria pedir um conjunto vazio: o usuário
    // quer trocar o recorte, não zerá-lo.
    if (cat && filtro.categories?.includes(cat)) delete filtro.categories
    return planned({ ...base, filter: filtro }, `sem ${alvo}`)
  }

  // ---- restrição: "e só aluguel?", "e no Nubank?" -----------------------
  const restringir = t.match(/^(?:e\s+)?(?:so|somente|apenas)\s+(?:o\s+|a\s+)?([a-z0-9çãõáéíóúâê][a-z0-9\s\-çãõáéíóúâê]{1,30}?)\s*\??$/)
    || t.match(/^e\s+(?:n?[oa]s?|d[oa]s?)\s+([a-z0-9çãõáéíóúâê][a-z0-9\s\-çãõáéíóúâê]{1,30}?)\s*\??$/)
  if (restringir) {
    const alvo = restringir[1].trim()
    const cartao = achaCartao(state, alvo)
    const cat = cartao ? undefined : achaCategoria(state, alvo)
    const filtro = { ...base.filter }
    if (cartao) { filtro.cardNames = [cartao]; delete filtro.excludeCardNames }
    else if (cat) { filtro.categories = [cat]; delete filtro.excludeCategories }
    else if (base.filter.origin && ehNomeDeOrigem(alvo)) {
      // "quanto a Casa 1 rendeu?" → "e a Casa 2": o usuário TROCOU de imóvel.
      // Somar um filtro de texto por cima da origem antiga procurava as duas
      // ao mesmo tempo e não achava nada.
      filtro.origin = alvo
    } else filtro.text = alvo
    // O filtro e o cabeçalho precisam mudar juntos: antes a Casa 2 tinha o
    // valor certo, mas a resposta dizia "Casa 1" por herdar o rótulo antigo.
    const label = (cat || (base.filter.origin && ehNomeDeOrigem(alvo))) && base.label
      ? `${base.label.split(' - ')[0]} - ${cat
        ? state.categories.find(c => c.id === cat)?.name || sentenceCase(alvo)
        : sentenceCase(alvo)}`
      : base.label
    return planned({ ...base, filter: filtro, label, group: cartao || cat ? 'none' : base.group }, `só ${alvo}`)
  }

  // ---- "e <pergunta nova curta>?": tenta o planner completo -------------
  // Cobre "e o maior gasto?" e afins sem inventar refino nenhum: o planner
  // normal responde, e o único empréstimo do foco é o PERÍODO.
  const semE = t.replace(/^e\s+/, '')
  if (semE !== t && semE.length > 6) {
    const novo = planQuery(state, semE, { today })
    if (novo) {
      const herdaPeriodo = !parsePeriod(semE, today)
      return {
        kind: 'query',
        planned: herdaPeriodo
          ? { ...novo, plan: { ...novo.plan, period: base.period }, confidence: 'high' }
          : novo,
      }
    }
  }

  return null
}

/**
 * Pedido de AGRUPAMENTO numa continuação. Fica junto porque a mesma frase
 * precisa ser reconhecida antes do leitor de período — ver o comentário no
 * ponto onde é usada.
 */
function grupoPedido(t: string): {
  group: AssistantQueryPlan['group']
  rotulo: string
  order?: AssistantQueryPlan['order']
  exigeComparacao?: boolean
  janela?: (hoje: string) => QueryPeriod
} | null {
  if (/\bdia\s+da\s+semana\b/.test(t)) {
    return { group: 'weekday', rotulo: 'por dia da semana', order: 'value-desc', janela: janelaSessentaDias }
  }
  if (/\bo\s+que\s+mais\s+(?:aumentou|subiu|cresceu|pesou)\b/.test(t)) {
    return { group: 'category', rotulo: 'o que mais aumentou', order: 'delta-desc', exigeComparacao: true }
  }
  if (/\bo\s+que\s+mais\s+(?:caiu|diminuiu|desceu)\b/.test(t)) {
    return { group: 'category', rotulo: 'o que mais caiu', order: 'delta-asc', exigeComparacao: true }
  }
  if (/\bpor\s+categoria\b|\bcategorias?\b/.test(t)) {
    return { group: 'category', rotulo: 'por categoria', order: 'value-desc' }
  }
  if (/\bpor\s+mes\b|\bmes\s+a\s+mes\b/.test(t)) {
    return { group: 'month', rotulo: 'por mês', janela: janelaSeisMeses }
  }
  if (/\bpor\s+cartao\b/.test(t)) return { group: 'card', rotulo: 'por cartão', order: 'value-desc' }
  if (/\bpor\s+origem\b/.test(t)) return { group: 'origin', rotulo: 'por origem', order: 'value-desc' }
  return null
}

const janelaSessentaDias = (hoje: string): QueryPeriod =>
  ({ from: addDays(hoje, -59), to: hoje, label: 'nos últimos 60 dias', grain: 'day' })

const janelaSeisMeses = (hoje: string): QueryPeriod => {
  const d = fromISO(hoje)
  return {
    from: toISO(new Date(d.getFullYear(), d.getMonth() - 5, 1)),
    to: hoje, label: 'nos últimos 6 meses', grain: 'month',
  }
}

/** "casa 2", "cliente joão": substantivo de fonte seguido de identificador. */
const ehNomeDeOrigem = (s: string): boolean =>
  /^(?:casa|cliente|empresa|loja|apart\w*|kitnet|sala|ponto|unidade|inquilin\w+|contrato)\s+\S+/i.test(s.trim())

const achaCartao = (state: AppState, nome: string): string | undefined =>
  activeCards(state).find(c => normalizeName(c.name) === normalizeName(nome)
    || normalizeName(nome).includes(normalizeName(c.name)))?.name

const achaCategoria = (state: AppState, nome: string): string | undefined => {
  const alvo = normalizeName(nome)
  if (alvo.length < 3) return undefined
  return usableCategories(state.categories || [])
    .find(c => normalizeName(c.name) === alvo
      || (alvo.length >= 4 && normalizeName(c.name).includes(alvo)))?.id
}

export { addDays }
