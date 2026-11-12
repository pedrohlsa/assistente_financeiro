// PORTA ÚNICA da consulta financeira: pergunta em pt-BR entra, resposta com
// números REAIS sai — ou `null`, quando a frase não é uma consulta.
//
// Junta as quatro etapas, e é ela que o orquestrador chama:
//
//   planQuery()          interpreta (local; o remoto entra pelo mesmo lugar)
//   validateQueryPlan()  valida contra o vocabulário e as capacidades REAIS
//   runQuery()           executa, somente leitura
//   composeAnswer()      redige em cima dos fatos
//
// Nenhum atalho: um plano que não passa na validação NUNCA é executado, venha
// ele do planner local ou da IA remota.

import type { AppState } from '../../models/types'
import { todayISO } from '../../utils/format'
import { planQuery } from './parse'
import type { PlannedQuery } from './parse'
import { isQueryFailure, validateQueryPlan } from './validate'
import type { QueryErrorCode } from './validate'
import { runQuery } from './engine'
import { composeAnswer, explainQueryResult } from './answer'
import type { AssistantQueryPlan, AssistantQueryResult } from './types'

export interface QueryAnswer {
  reply: string
  plan: AssistantQueryPlan
  result: AssistantQueryResult
  confidence: 'high' | 'medium'
  recognized: string[]
  /** O plano usa algo que `resolveLocal()` nao expressa (ver `alemDoAntigo`). */
  beyondLegacy?: boolean
  /** Metodologia real, para "como você chegou nisso?". */
  explain: string
}

export interface QueryFailureInfo {
  code: QueryErrorCode
  detail?: string
}

export interface AnswerOptions {
  today?: string
  /** Recusas vão para cá em vez de sumirem — descartar em silêncio é proibido. */
  onReject?: (info: QueryFailureInfo) => void
}

/**
 * Executa um plano JÁ construído (local ou remoto) e devolve a resposta.
 *
 * O `fallbackCategory` é a segunda tentativa: quando a busca literal por um
 * nome não acha nada, o histórico do usuário pode saber que aquele nome é uma
 * categoria ("suco" = combustível). Primeiro o literal, depois o aprendido —
 * nunca o contrário, senão perguntar por um LUGAR devolvia o total da
 * categoria inteira.
 */
export function runPlannedQuery(
  state: AppState,
  planned: PlannedQuery,
  opts: AnswerOptions = {},
): QueryAnswer | null {
  const hoje = opts.today || todayISO()
  const v = validateQueryPlan(planned.plan, state, hoje)
  if (isQueryFailure(v)) {
    opts.onReject?.({ code: v.code, detail: v.detail })
    return null
  }

  let result = runQuery(state, v.plan, hoje)
  let plan = v.plan

  if (result.empty && planned.fallbackCategory && plan.filter.text) {
    const alternativo: AssistantQueryPlan = {
      ...plan,
      filter: { ...plan.filter, text: undefined, categories: [planned.fallbackCategory] },
    }
    const v2 = validateQueryPlan(alternativo, state, hoje)
    if (!isQueryFailure(v2)) {
      const r2 = runQuery(state, v2.plan, hoje)
      if (!r2.empty) { result = r2; plan = v2.plan }
    }
  }

  return {
    reply: composeAnswer(result),
    plan, result,
    confidence: planned.confidence,
    recognized: planned.recognized,
    beyondLegacy: planned.beyondLegacy,
    explain: explainQueryResult(result),
  }
}

/**
 * Interpreta e responde. `null` quando a frase não é uma consulta de dados —
 * nunca uma resposta "por garantia".
 */
export function answerQuery(
  state: AppState,
  message: string,
  opts: AnswerOptions = {},
): QueryAnswer | null {
  const hoje = opts.today || todayISO()
  const planned = planQuery(state, message, { today: hoje })
  if (!planned) return null
  return runPlannedQuery(state, planned, opts)
}

export { planQuery, validateQueryPlan, isQueryFailure, runQuery, composeAnswer, explainQueryResult }
export type { AssistantQueryPlan, AssistantQueryResult, PlannedQuery }
