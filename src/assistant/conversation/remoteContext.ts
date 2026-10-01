// CONTEXTO CONVERSACIONAL REMOTO — a SEMÂNTICA da conversa, nunca a transcrição.
//
// Até 15/09/2026 `Chat.tsx` mandava ao chat remoto as últimas 8 mensagens, e
// entre elas iam as respostas LOCAIS: "Seu maior gasto foi R$ 460,00 em Obra e
// construção (Areia)", "Seu saldo em conta é R$ 3.100,00". Descrição, valor e
// saldo saíam do aparelho sem o usuário ter pedido nada disso — o contrário do
// que a regra 44 promete.
//
// O que vai agora é a ESTRUTURA do que estava em foco: que tipo de pedido foi o
// último, o rótulo do período que o próprio app gerou, filtros por categoria,
// cartão e meta (nomes que já estão no prompt de sistema), os campos que o
// assistente perguntou. Nenhum número de dinheiro, nenhuma frase anterior,
// nenhum texto livre vindo do histórico. Filtro por texto ou por origem vai só
// como "existia" — o nome em si fica no aparelho.
//
// SEM IMPORT EM RUNTIME: a função serverless importa `normalizeRemoteConversation`,
// e ela precisa rodar sem arrastar nada do cliente junto.

import type { ConversationFocus } from './focus'

export const REMOTE_CONVERSATION_VERSION = 1 as const

export type RemoteTopic = 'query' | 'scenario' | 'record' | 'clarification'
export type RemoteTurnRelation = 'continuation' | 'correction' | 'comparison' | 'refinement'
export type RemotePreviousIntent =
  | 'query-answered' | 'scenario-simulated' | 'record-proposed' | 'record-incomplete' | 'clarification-asked'

export interface RemoteConversationContext {
  version: typeof REMOTE_CONVERSATION_VERSION
  topic?: RemoteTopic
  previousIntent?: RemotePreviousIntent
  turnRelation?: RemoteTurnRelation
  /** Rótulo gerado pelo APP ("nos últimos 3 meses"), nunca o texto do usuário. */
  activePeriod?: { label: string; grain?: string }
  activeQuery?: { source?: string; metric?: string; group?: string }
  activeFilters?: {
    txType?: string[]
    categories?: string[]
    excludedCategories?: string[]
    cardNames?: string[]
    goalName?: string
    /** Havia filtro por texto livre — o texto não vai. */
    freeTextFilter?: boolean
    /** Havia filtro por origem — a origem não vai. */
    originFilter?: boolean
  }
  scenarioKind?: string
  /** Tipos das ações na proposta que está na tela, sem valor nenhum. */
  pendingKinds?: string[]
  /** Campos que o assistente perguntou e ainda faltam. */
  missingFields?: string[]
  /** Tipos já resolvidos no aparelho NESTE turno: o remoto não deve repeti-los. */
  resolvedLocally?: string[]
}

export interface RemoteConversationInput {
  focus?: ConversationFocus
  focusFresh: boolean
  draftMissing?: string[]
  pendingKinds?: string[]
  clarificationField?: string
  turnRelation?: RemoteTurnRelation
  resolvedKinds?: string[]
}

const unicos = (xs: (string | undefined)[] | undefined, max: number): string[] | undefined => {
  const out = [...new Set((xs || []).filter((x): x is string => typeof x === 'string' && !!x))].slice(0, max)
  return out.length ? out : undefined
}

/** Monta o contexto no CLIENTE, a partir do que o orquestrador já tem em memória. */
export function buildRemoteConversation(i: RemoteConversationInput): RemoteConversationContext | undefined {
  const out: RemoteConversationContext = { version: REMOTE_CONVERSATION_VERSION }
  const f = i.focusFresh ? i.focus : undefined

  if (i.clarificationField) {
    out.topic = 'clarification'
    out.previousIntent = 'clarification-asked'
    out.missingFields = unicos([i.clarificationField], 4)
  } else if (i.draftMissing?.length) {
    out.topic = 'record'
    out.previousIntent = 'record-incomplete'
    out.missingFields = unicos(i.draftMissing, 4)
  } else if (i.pendingKinds?.length) {
    out.topic = 'record'
    out.previousIntent = 'record-proposed'
  } else if (f?.last === 'scenario' && f.lastScenarioPlan) {
    out.topic = 'scenario'
    out.previousIntent = 'scenario-simulated'
  } else if (f?.last === 'query' && f.lastQueryPlan) {
    out.topic = 'query'
    out.previousIntent = 'query-answered'
  }

  out.pendingKinds = unicos(i.pendingKinds, 6)

  if (f?.last === 'scenario' && f.lastScenarioPlan) {
    out.scenarioKind = f.lastScenarioPlan.kind
  } else if (f?.lastQueryPlan) {
    const p = f.lastQueryPlan
    out.activePeriod = { label: p.period.label, grain: p.period.grain }
    out.activeQuery = { source: p.source, metric: p.metric, group: p.group }
    const filtros: NonNullable<RemoteConversationContext['activeFilters']> = {
      txType: unicos(p.filter.txType, 4),
      categories: unicos(p.filter.categories, 6),
      excludedCategories: unicos(p.filter.excludeCategories, 6),
      cardNames: unicos(p.filter.cardNames, 4),
      goalName: p.filter.goalName || undefined,
      freeTextFilter: p.filter.text || p.filter.excludeText ? true : undefined,
      originFilter: p.filter.origin || p.filter.origins?.length ? true : undefined,
    }
    if (Object.values(filtros).some(v => v !== undefined)) out.activeFilters = filtros
  }

  if (i.turnRelation) out.turnRelation = i.turnRelation
  out.resolvedLocally = unicos(i.resolvedKinds, 6)

  const temAlgo = Object.entries(out).some(([k, v]) => k !== 'version' && v !== undefined)
  return temAlgo ? out : undefined
}

// ---------------------------------------------------------------------------
// Servidor — dado NÃO confiável
// ---------------------------------------------------------------------------

const TOPICOS = new Set<string>(['query', 'scenario', 'record', 'clarification'])
const RELACOES = new Set<string>(['continuation', 'correction', 'comparison', 'refinement'])
const INTENCOES = new Set<string>(['query-answered', 'scenario-simulated', 'record-proposed', 'record-incomplete', 'clarification-asked'])

/** Palavra de vocabulário do app: minúscula, sem espaço, sem número. */
const TOKEN = /^[a-z][a-z-]{1,23}$/
const CAMPO = /^[a-zA-Z]{2,24}$/

const tokens = (xs: unknown, max: number, re: RegExp): string[] | undefined => {
  if (!Array.isArray(xs)) return undefined
  const out = [...new Set(xs.filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(0, max)
  return out.length ? out : undefined
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Só aceita nome que JÁ está nas capacidades do usuário, e devolve a grafia de lá. */
const doVocabulario = (xs: unknown, lista: string[], max: number): string[] | undefined => {
  if (!Array.isArray(xs)) return undefined
  const mapa = new Map(lista.map(n => [semAcento(n), n]))
  const out = [...new Set(xs.map(x => (typeof x === 'string' ? mapa.get(semAcento(x)) : undefined)).filter((x): x is string => !!x))].slice(0, max)
  return out.length ? out : undefined
}

/**
 * Rótulo de período: é texto gerado pelo app, mas chega pelo corpo da requisição.
 * Tem que PARECER rótulo — curto, sem cifrão, sem centavos, sem quebra de linha —
 * senão não vai. É o que impede um cliente defeituoso (ou hostil) de contrabandear
 * uma resposta financeira por este campo.
 */
const rotuloDePeriodo = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined
  const t = s.trim()
  if (!t || t.length > 40) return undefined
  if (/[\r\n\u0000-\u001F]|r\$|\d+,\d{2}\b/i.test(t)) return undefined
  return /^[\p{L}\d\s/.-]+$/u.test(t) ? t : undefined
}

export interface RemoteConversationVocabulary {
  categoryIds: string[]
  cardNames: string[]
  goalNames: string[]
}

/**
 * Normaliza o que o cliente mandou. Campo fora da lista some; valor fora do
 * vocabulário some; número de dinheiro não tem campo onde caber. `undefined`
 * quando não sobra nada.
 */
export function normalizeRemoteConversation(
  raw: unknown,
  vocab: RemoteConversationVocabulary,
): RemoteConversationContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, any>
  const out: RemoteConversationContext = { version: REMOTE_CONVERSATION_VERSION }

  if (TOPICOS.has(r.topic)) out.topic = r.topic
  if (INTENCOES.has(r.previousIntent)) out.previousIntent = r.previousIntent
  if (RELACOES.has(r.turnRelation)) out.turnRelation = r.turnRelation

  const label = rotuloDePeriodo(r.activePeriod?.label)
  if (label) {
    out.activePeriod = { label }
    if (typeof r.activePeriod?.grain === 'string' && TOKEN.test(r.activePeriod.grain)) out.activePeriod.grain = r.activePeriod.grain
  }

  if (r.activeQuery && typeof r.activeQuery === 'object') {
    const q: NonNullable<RemoteConversationContext['activeQuery']> = {}
    for (const k of ['source', 'metric', 'group'] as const) {
      if (typeof r.activeQuery[k] === 'string' && TOKEN.test(r.activeQuery[k])) q[k] = r.activeQuery[k]
    }
    if (Object.keys(q).length) out.activeQuery = q
  }

  const f = r.activeFilters
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const filtros: NonNullable<RemoteConversationContext['activeFilters']> = {
      txType: tokens(f.txType, 4, TOKEN),
      categories: doVocabulario(f.categories, vocab.categoryIds, 6),
      excludedCategories: doVocabulario(f.excludedCategories, vocab.categoryIds, 6),
      cardNames: doVocabulario(f.cardNames, vocab.cardNames, 4),
      goalName: doVocabulario([f.goalName], vocab.goalNames, 1)?.[0],
      freeTextFilter: f.freeTextFilter === true ? true : undefined,
      originFilter: f.originFilter === true ? true : undefined,
    }
    if (Object.values(filtros).some(v => v !== undefined)) out.activeFilters = filtros
  }

  if (typeof r.scenarioKind === 'string' && TOKEN.test(r.scenarioKind)) out.scenarioKind = r.scenarioKind
  out.pendingKinds = tokens(r.pendingKinds, 6, TOKEN)
  out.missingFields = tokens(r.missingFields, 4, CAMPO)
  out.resolvedLocally = tokens(r.resolvedLocally, 6, TOKEN)

  const temAlgo = Object.entries(out).some(([k, v]) => k !== 'version' && v !== undefined)
  return temAlgo ? out : undefined
}
