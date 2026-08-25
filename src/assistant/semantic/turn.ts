// REPRESENTAÇÃO SEMÂNTICA DO TURNO.
//
// O que existia: `AnalyzedClause.intent` com seis valores, e `question` cobrindo
// tudo que não era registro. Duas coisas muito diferentes cabiam ali dentro:
//
//   "quanto gastei em obra?"          → CONSULTA sobre dados reais
//   "e se eu gastar 500 em obra?"     → CENÁRIO sobre um mundo que não existe
//
// Tratá-las como a mesma coisa era o que fazia a segunda cair no texto genérico
// de ajuda — ou, pior, ser respondida com número real, transformando hipótese em
// fato.
//
// COMPATIBILIDADE: isto é estrutura INTERNA do cliente. O envelope da resposta
// (`AssistantResponse`) não muda, e `ASSISTANT_CONTRACT_VERSION` continua 1 —
// consulta e cenário são `mode: 'answer'` com zero ações, que qualquer cliente
// v1 já entende. Ver docs/AI_SEMANTIC_COPILOT_DESIGN.md §6.

import type { AppState, ParsedAction } from '../../models/types'
import type { AssistantConfidence, AssistantIntent } from '../contracts'
import { analyzeMessage } from '../clauses'
import type { AnalyzedClause, MessageAnalysis } from '../clauses'
import { looksLikeDataQuestion } from '../query/parse'
import { looksLikeScenario } from '../scenario/parse'
import { todayISO } from '../../utils/format'
import { isDriver } from '../../services/profile'

/** Versão da estrutura de turno — independente da versão do envelope. */
export const TURN_PLAN_VERSION = 2 as const

export type TurnBlockType =
  | 'record'        // relata um fato a registrar
  | 'query'         // pergunta sobre os dados
  | 'scenario'      // hipótese, "e se?"
  | 'correction'    // corrige ou nega algo
  | 'clarification' // responde a uma pergunta do assistente
  | 'conversation'  // conversa, saudação, aviso
  | 'unknown'       // não compreendido

export interface TurnBlock {
  id: string
  type: TurnBlockType
  /** Trecho literal, como o usuário escreveu. */
  text: string
  start: number
  end: number
  confidence: AssistantConfidence
  /** Só em `record`: o que o parser entendeu. */
  actions: ParsedAction[]
  /** A cláusula que originou o bloco — liga o turno à análise existente. */
  clause: AnalyzedClause
}

export interface AssistantTurnPlan {
  version: typeof TURN_PLAN_VERSION
  originalText: string
  blocks: TurnBlock[]
  /** 0..1 — fração do texto útil que o motor local compreendeu. */
  coverage: number
  /** A análise por cláusula, preservada: nada aqui a substitui. */
  analysis: MessageAnalysis
}

/**
 * Mapeia o bloco para a intenção do contrato v1. É o ADAPTADOR que mantém o
 * resto do app funcionando sem saber que `query` e `scenario` existem.
 */
export function toLegacyIntent(type: TurnBlockType): AssistantIntent {
  switch (type) {
    case 'record': return 'record'
    case 'query': return 'question'
    case 'scenario': return 'question'
    case 'correction': return 'correction'
    case 'clarification': return 'clarification'
    case 'conversation': return 'conversation'
    default: return 'unknown'
  }
}

/**
 * Classifica UMA cláusula.
 *
 * A ordem importa e não é arbitrária: cenário vem antes de consulta porque uma
 * hipótese com número respondida como consulta vira um dado real sobre um mundo
 * que não existe; e registro só ganha de consulta quando o parser realmente
 * achou ação, porque "quanto gastei" não é um gasto.
 */
function classifica(c: AnalyzedClause, state: AppState): TurnBlockType {
  if (c.intent === 'conversation') return 'conversation'
  if (c.intent === 'clarification') return 'clarification'
  if (looksLikeScenario(c.text)) return 'scenario'
  if (c.intent === 'record' && c.actions.length) return 'record'
  // Sinal temporal segurando ações (data futura, período sem dia) continua
  // sendo registro: o que falta é a decisão do usuário, não a compreensão.
  if (c.temporal?.actions?.length) return 'record'
  if (c.intent === 'correction') return 'correction'
  if (c.intent === 'question') return looksLikeDataQuestion(c.text) ? 'query' : 'query'
  if (looksLikeDataQuestion(c.text)) return 'query'
  return 'unknown'
}

export function buildTurnPlan(
  state: AppState,
  message: string,
  opts: { today?: string } = {},
): AssistantTurnPlan {
  const today = opts.today || todayISO()
  const analysis = analyzeMessage(message, { driver: isDriver(state.settings), today })

  const blocks: TurnBlock[] = analysis.clauses.map(c => ({
    id: c.id,
    type: classifica(c, state),
    text: c.text,
    start: c.start,
    end: c.end,
    confidence: c.confidence,
    actions: c.actions,
    clause: c,
  }))

  return {
    version: TURN_PLAN_VERSION,
    originalText: analysis.originalText,
    blocks,
    coverage: analysis.coverage,
    analysis,
  }
}

/** Atalhos de leitura — o resto do código não deve filtrar por string solta. */
export const blocksOf = (plan: AssistantTurnPlan, type: TurnBlockType): TurnBlock[] =>
  plan.blocks.filter(b => b.type === type)

export const hasBlock = (plan: AssistantTurnPlan, type: TurnBlockType): boolean =>
  plan.blocks.some(b => b.type === type)
