// Porta única do cenário: hipótese em pt-BR entra, simulação sai.
//
// Nenhum caminho daqui produz `ParsedAction`. Uma hipótese NUNCA vira fato —
// é a invariante que o teste de cenário verifica byte a byte, comparando o
// estado antes e depois.

import type { AppState } from '../../models/types'
import { todayISO } from '../../utils/format'
import { planScenario, looksLikeScenario } from './parse'
import { runScenario } from './engine'
import { composeScenario, explainScenario } from './answer'
import type { AssistantScenarioPlan, AssistantScenarioResult } from './types'

export interface ScenarioAnswer {
  reply: string
  plan: AssistantScenarioPlan
  result: AssistantScenarioResult
  explain: string
}

export function answerScenario(
  state: AppState, message: string, opts: { today?: string } = {},
): ScenarioAnswer | null {
  const hoje = opts.today || todayISO()
  const plan = planScenario(state, message, { today: hoje })
  if (!plan) return null
  const result = runScenario(state, plan, hoje)
  return { reply: composeScenario(result), plan, result, explain: explainScenario(result) }
}

/** Reexecuta um cenário JÁ construído — é o que o follow-up refina. */
export function rerunScenario(
  state: AppState, plan: AssistantScenarioPlan, opts: { today?: string } = {},
): ScenarioAnswer {
  const hoje = opts.today || todayISO()
  const result = runScenario(state, plan, hoje)
  return { reply: composeScenario(result), plan, result, explain: explainScenario(result) }
}

export { planScenario, looksLikeScenario, runScenario, composeScenario, explainScenario }
export type { AssistantScenarioPlan, AssistantScenarioResult }
