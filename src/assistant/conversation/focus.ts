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
import { addDays, fromISO, todayISO, toISO } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { activeCards } from '../../services/cards'
import { usableCategories } from '../../data/categories'
import { normalizeNumberWords } from '../numbers'
import { parsePeriod, previousPeriod } from '../query/period'
import { planQuery } from '../query/parse'
import type { PlannedQuery } from '../query/parse'
import type { AssistantQueryPlan, AssistantQueryResult, FactUnit, QueryPeriod } from '../query/types'
import type { AssistantScenarioPlan, AssistantScenarioResult } from '../scenario/types'

/** Mesmo tempo do rascunho: uma conversa parada 20 minutos acabou. */
export const FOCUS_TTL_MINUTES = 20

export interface QuerySummary {
  label: string
  total: number
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
  explain: string
}

export interface ConversationFocus {
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
  lastScenarioPlan?: AssistantScenarioPlan
  lastScenario?: ScenarioSummary
  /** Pilha curta para "volta pro cenário anterior". */
  scenarioHistory?: AssistantScenarioPlan[]
  /** O último assunto foi consulta ou cenário? Decide quem o follow-up refina. */
  last?: 'query' | 'scenario'
  /** Entidades citadas — matéria-prima da elipse ("e o outro?"). */
  entities?: { cards?: string[]; categories?: string[]; goals?: string[]; origins?: string[] }
  updatedAt: number
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
    lastQueryPlan: plan,
    // Só guarda como "anterior" quando o período mudou de verdade: refinar um
    // filtro sobre o mesmo mês não cria um segundo período para comparar.
    previousQueryPlan: prev?.lastQueryPlan && prev.lastQueryPlan.period.from !== plan.period.from
      ? prev.lastQueryPlan
      : prev?.previousQueryPlan,
    lastQuery: {
      label: plan.label || 'Total',
      total: result.total,
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
      origins: plan.filter.origin ? [plan.filter.origin] : prev?.entities?.origins,
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
    lastScenarioPlan: plan,
    lastScenario: {
      label: plan.label,
      facts: result.facts.map(f => ({ label: f.label, value: f.value, unit: f.unit })),
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
  // "qual mês fica pior?" logo depois de uma simulação fala DA SIMULAÇÃO, não
  // do histórico. Mandar essa frase para o planner comum respondia com o pior
  // mês REAL do passado — um número correto sobre a pergunta errada.
  /^qual\s+mes\s+(?:fica|seria|vai\s+ficar|e)\s+(?:o\s+)?(?:pior|mais\s+apertado)/,
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

  // ---- "por quê?" / "como chegou nisso?" --------------------------------
  if (PEDE_EXPLICACAO.test(t)) {
    const texto = focus.last === 'scenario' ? focus.lastScenario?.explain : focus.lastQuery?.explain
    return texto ? { kind: 'explain', text: texto } : null
  }

  // ---- cenário ----------------------------------------------------------
  if (focus.last === 'scenario' && focus.lastScenarioPlan) {
    const refinado = refinaCenario(focus, t)
    if (refinado) return { kind: 'scenario', plan: refinado }
  }

  // ---- consulta ---------------------------------------------------------
  if (focus.lastQueryPlan) {
    const r = refinaConsulta(state, focus, focus.lastQueryPlan, t, today)
    if (r) return r
  }

  // Cenário como segunda tentativa: o usuário pode ter feito uma consulta no
  // meio e voltado à hipótese.
  if (focus.lastScenarioPlan) {
    const refinado = refinaCenario(focus, t)
    if (refinado) return { kind: 'scenario', plan: refinado }
  }
  return null
}

// ---------------------------------------------------------------------------
// Refino do cenário
// ---------------------------------------------------------------------------

const NUM = String.raw`(\d+(?:[.,]\d+)*)`

function refinaCenario(focus: ConversationFocus, t: string): AssistantScenarioPlan | null {
  const base = focus.lastScenarioPlan!

  // "Qual mês fica pior?" é a MESMA simulação, relida pelo mês mais apertado —
  // o motor já calcula isso e a resposta o destaca.
  if (/^qual\s+mes\s+(?:fica|seria|vai\s+ficar|e)\s+(?:o\s+)?(?:pior|mais\s+apertado)/.test(t)) {
    return { ...base }
  }

  if (/^volta\b/.test(t)) {
    const anterior = focus.scenarioHistory?.[0]
    return anterior ? { ...anterior } : null
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

  // ---- "qual a diferença?" / "compara os dois" --------------------------
  if (/^(?:qual\s+(?:a\s+)?diferenca|compara)/.test(t)) {
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
  const excluir = t.match(/\b(?:tirando|sem|fora|exceto|desconsiderando)\s+(?:o\s+|a\s+|os\s+|as\s+)?([a-z0-9çãõáéíóúâê][a-z0-9\s\-çãõáéíóúâê]{1,30}?)\s*\??$/)
  if (excluir) {
    const alvo = excluir[1].trim()
    const cartao = achaCartao(state, alvo)
    const cat = cartao ? undefined : achaCategoria(state, alvo)
    const filtro = { ...base.filter }
    if (cartao) filtro.excludeCardNames = [...(filtro.excludeCardNames || []), cartao]
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
    else filtro.text = alvo
    return planned({ ...base, filter: filtro, group: cartao || cat ? 'none' : base.group }, `só ${alvo}`)
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
