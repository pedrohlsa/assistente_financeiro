// ORQUESTRADOR — o cérebro do assistente.
//
// Antes, `Chat.tsx` decidia tudo com dois `if`: "achou ação? usa local; senão
// manda pro remoto". Uma mensagem que registrava E perguntava perdia a pergunta;
// uma mensagem meio entendida ia inteira pro modelo e voltava duplicada.
//
// Aqui a decisão é por COBERTURA: o que o motor local resolveu com certeza fica
// resolvido, e só o que sobrou justifica chamar a IA remota — que reconcilia,
// nunca duplica.

import type { AppState, ParsedAction } from '../models/types'
import type {
  AssistantCandidateAction, AssistantCapabilities, AssistantClarification,
  AssistantDiagnostics, AssistantErrorCode, AssistantResponse, AssistantUnresolvedClause,
} from './contracts'
import { ASSISTANT_CONTRACT_VERSION, MAX_ACTIONS_PER_BATCH, isValidationFailure, validateAction } from './contracts'
import { analyzeMessage } from './clauses'
import type { AnalyzedClause, MessageAnalysis } from './clauses'
import { detectIncomplete, isDraftFresh, newDraft, resolveDraftAnswer } from './drafts'
import type { AssistantDraft } from './drafts'
import { applyCorrection, parseCorrection } from './corrections'
import type { CorrectionPlan } from './corrections'
import { findGoalByName, planAssistantActions } from './execute'
import { askAssistant } from '../services/ai'
import { describeAction } from '../services/nlp'
import { isDriver, findPossibleDuplicate } from '../services/profile'
import { catById } from '../data/categories'
import { fmtBRL, todayISO, uid } from '../utils/format'
import { dateLabel } from './dates'

// ---------------------------------------------------------------------------
// Capacidades reais do usuário
// ---------------------------------------------------------------------------

export function buildCapabilities(state: AppState): AssistantCapabilities {
  const driver = isDriver(state.settings)
  return {
    profile: state.settings.profile,
    isDriver: driver,
    kinds: [],
    categories: state.categories
      .filter(c => !c.archived || c.id === 'reserva')
      .map(c => ({ id: c.id, name: c.name, type: c.type })),
    cardNames: (state.cards || []).filter(c => !c.archived).map(c => c.name),
    goalNames: state.goals.filter(g => !g.done).map(g => g.name),
  }
}

// ---------------------------------------------------------------------------
// Entrada e saída
// ---------------------------------------------------------------------------

export interface RemoteResult {
  reply: string
  mode: string
  actions: ParsedAction[]
  clarification?: AssistantClarification
  rejected: { kind: string; code: AssistantErrorCode; detail?: string }[]
  contractFallback?: boolean
}

export interface OrchestratorInput {
  state: AppState
  message: string
  history: { role: string; text: string }[]
  draft?: AssistantDraft
  /** Proposta ainda na tela — alvo de correções. */
  pending?: AssistantCandidateAction[]
  remoteEnabled: boolean
  /** Injetável: os testes rodam sem rede. */
  askRemote?: (args: { state: AppState; message: string; history: { role: string; text: string }[] }) => Promise<RemoteResult | null>
  today?: string
  devDiagnostics?: boolean
}

export interface OrchestratorOutput {
  response: AssistantResponse
  /** Rascunho atualizado. `null` = apagar o rascunho atual. */
  draft: AssistantDraft | null
  /** Proposta corrigida, quando a mensagem era uma correção. */
  correctedPending?: AssistantCandidateAction[]
}

const candidate = (
  action: ParsedAction,
  engine: AssistantCandidateAction['engine'],
  clauseId?: string,
  confidence: AssistantCandidateAction['confidence'] = 'high',
): AssistantCandidateAction => ({ id: uid(), action, engine, clauseId, confidence })

const unresolvedOf = (c: AnalyzedClause, reason: AssistantUnresolvedClause['reason']): AssistantUnresolvedClause =>
  ({ clauseId: c.id, text: c.text, reason })

// ---------------------------------------------------------------------------
// Etapa local
// ---------------------------------------------------------------------------

interface LocalPass {
  analysis: MessageAnalysis
  candidates: AssistantCandidateAction[]
  rejected: { kind: string; code: AssistantErrorCode; detail?: string }[]
  clarification?: AssistantClarification
  /** Ainda precisa da IA remota? */
  needsRemote: boolean
  unresolved: AssistantUnresolvedClause[]
}

/**
 * `goal-deposit` sem meta correspondente não pode virar meta nova nem sumir:
 * o dinheiro provavelmente foi para a reserva. Perguntamos.
 */
function reconcileGoalDeposits(
  state: AppState,
  actions: ParsedAction[],
): { actions: ParsedAction[]; clarification?: AssistantClarification } {
  let clarification: AssistantClarification | undefined
  const out = actions.map(a => {
    if (a.kind !== 'goal-deposit') return a
    const g = findGoalByName(state, a.name)
    if (g) return a
    if (!clarification) {
      clarification = {
        question: `Não encontrei uma meta chamada "${a.name}". Você quer guardar esse valor na reserva?`,
        options: [
          { label: 'Guardar na reserva', value: 'saving' },
          { label: 'Escolher outra meta', value: 'pick-goal' },
        ],
      }
    }
    return a
  })
  return { actions: out, clarification }
}

function runLocal(input: OrchestratorInput, caps: AssistantCapabilities): LocalPass {
  const today = input.today || todayISO()
  const analysis = analyzeMessage(input.message, { driver: caps.isDriver, today })

  const rejected: LocalPass['rejected'] = []
  const candidates: AssistantCandidateAction[] = []
  let clarification: AssistantClarification | undefined

  // Ambiguidade real (gás) interrompe: pergunta primeiro, registra depois.
  const ambiguous = analysis.clauses.find(c => c.ambiguity)
  const dateAmbiguous = analysis.clauses.find(c => c.dateAmbiguity)

  const { actions: reconciled, clarification: goalClar } = reconcileGoalDeposits(input.state, analysis.actions)
  if (goalClar) clarification = goalClar

  for (const clause of analysis.clauses) {
    for (const raw of clause.actions) {
      const idx = analysis.actions.indexOf(raw)
      const action = idx >= 0 ? reconciled[idx] : raw
      const res = validateAction(action, caps, today)
      if (isValidationFailure(res)) {
        rejected.push({ kind: action.kind, code: res.code, detail: res.detail })
        continue
      }
      candidates.push(candidate(res.action, 'local', clause.id, clause.confidence))
    }
  }

  const unresolved = analysis.unresolvedClauses
    .filter(c => c.intent !== 'conversation')
    .map(c => unresolvedOf(c, c.intent === 'question' ? 'question-unanswered' : 'not-understood'))

  if (!clarification && ambiguous?.ambiguity) {
    clarification = {
      question: ambiguous.ambiguity.question,
      options: ambiguous.ambiguity.options.map(o => ({ label: o.label, value: o.label })),
      field: 'ambiguity',
    }
  }
  if (!clarification && dateAmbiguous?.dateAmbiguity) {
    clarification = {
      question: dateAmbiguous.dateAmbiguity.question,
      options: dateAmbiguous.dateAmbiguity.options,
      field: 'date',
    }
  }

  // Regra central: ACHAR AÇÃO NÃO É COMPREENDER A MENSAGEM.
  const needsRemote = analysis.clauses.some(c =>
    !c.handled && c.intent !== 'conversation' && !(c.intent === 'question' && false))
    || analysis.coverage < 0.999

  return { analysis, candidates, rejected, clarification, needsRemote, unresolved }
}

// ---------------------------------------------------------------------------
// Respostas locais
// ---------------------------------------------------------------------------

/**
 * Responde perguntas usando o estado PROJETADO (estado atual + ações propostas),
 * deixando explícito que o número depende da confirmação. Reaproveita o motor de
 * respostas local inteiro em vez de duplicar regra de cálculo.
 */
function answerQuestions(
  state: AppState,
  questions: AnalyzedClause[],
  candidates: AssistantCandidateAction[],
): { text: string; answered: AnalyzedClause[] } {
  if (!questions.length) return { text: '', answered: [] }
  const projected = candidates.length
    ? planAssistantActions(state, candidates.map(c => ({ id: c.id, action: c.action }))).projected
    : state

  const parts: string[] = []
  const answered: AnalyzedClause[] = []
  for (const q of questions) {
    const r = askAssistant(projected, q.text)
    if (r.handled === false) continue
    parts.push(r.text)
    answered.push(q)
  }
  return { text: parts.join('\n\n'), answered }
}

/** Resumo hipotético de um lote — usado quando a pergunta é sobre "quanto sobrou". */
function hypotheticalSummary(candidates: AssistantCandidateAction[]): string | null {
  const inc = candidates.filter(c => c.action.kind === 'income').reduce((a, c) => a + (c.action as any).amount, 0)
  const exp = candidates.filter(c => c.action.kind === 'expense').reduce((a, c) => a + (c.action as any).amount, 0)
  if (!inc && !exp) return null
  const diff = inc - exp
  if (inc && exp) {
    return `Se você confirmar, entram ${fmtBRL(inc)} e saem ${fmtBRL(exp)} — diferença de ${fmtBRL(Math.abs(diff))}${diff < 0 ? ' negativa' : ''}.`
  }
  return null
}

function proposalText(candidates: AssistantCandidateAction[]): string {
  const lines = candidates.map(c => {
    const d = (c.action as any).date
    const suffix = d ? ` · ${dateLabel(d)}` : ''
    return `• ${describeAction(c.action)}${suffix}`
  })
  return `Entendi isso:\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

const rejectionNote = (rejected: LocalPass['rejected']): string => {
  if (!rejected.length) return ''
  const first = rejected[0]
  const what = first.detail ? `${first.kind} (${first.detail})` : first.kind
  return `\n\nUma parte não pôde ser registrada — ${what}. Se quiser, reformule só esse pedaço.`
}

export async function orchestrate(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const started = Date.now()
  const caps = buildCapabilities(input.state)
  const today = input.today || todayISO()

  // ---- 1) A mensagem responde a uma pergunta pendente? -------------------
  if (isDraftFresh(input.draft)) {
    const res = resolveDraftAnswer(input.draft!, input.message, caps, today)
    if (!res.unmatched) {
      if (res.draft.status === 'ready') {
        const v = validateAction(res.draft.partial, caps, today)
        if (isValidationFailure(v)) {
          return {
            draft: null,
            response: {
              version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [],
              unresolved: [],
              reply: `Não consegui completar esse registro: ${v.detail || v.code}. Pode mandar de novo com os dados completos?`,
            },
          }
        }
        const cand = [candidate(v.action, 'local')]
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cand, unresolved: [],
            reply: `${proposalText(cand)}\n\nConfirmar?`,
          },
        }
      }
      const nextQ = res.draft.missingFields[0]
      return {
        draft: res.draft,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [],
          clarification: { question: nextQ.question, field: nextQ.field, options: nextQ.options },
          reply: nextQ.question,
        },
      }
    }
    // Não encaixou: o usuário mudou de assunto. O rascunho é descartado em vez
    // de contaminar a próxima mensagem.
  }

  // ---- 2) A mensagem corrige a proposta na tela? -------------------------
  if (input.pending?.length) {
    const plan: CorrectionPlan | null = parseCorrection(input.message, input.pending, caps, today)
    if (plan) {
      if (plan.ambiguous) {
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
            actions: input.pending, unresolved: [],
            clarification: plan.ambiguous,
            reply: plan.ambiguous.question,
          },
        }
      }
      const next = applyCorrection(input.pending, plan)
      if (!next.length) {
        return {
          draft: null, correctedPending: [],
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [],
            unresolved: [], reply: plan.summary.join(' ') || 'Ok, descartei a proposta.',
          },
        }
      }
      return {
        draft: null, correctedPending: next,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: next, unresolved: [],
          reply: `${plan.summary.join(' ')}\n\n${proposalText(next)}\n\nConfirmar?`,
        },
      }
    }
  }

  // ---- 3) Análise local por cláusula -------------------------------------
  const local = runLocal(input, caps)
  const { analysis } = local
  let candidates = local.candidates.slice(0, MAX_ACTIONS_PER_BATCH)
  let engine: AssistantCandidateAction['engine'] = 'local'
  let unresolved = local.unresolved
  let clarification = local.clarification
  let remoteReply = ''
  let remoteRejected: LocalPass['rejected'] = []

  // ---- 4) Intenção incompleta vira rascunho ------------------------------
  if (!candidates.length && !clarification) {
    const incomplete = detectIncomplete(input.message, caps)
    if (incomplete) {
      const d = newDraft(incomplete, input.message, caps)
      const q = d.missingFields[0]
      return {
        draft: d,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [],
          clarification: { question: q.question, field: q.field, options: q.options },
          reply: q.question,
        },
      }
    }
  }

  // ---- 5) Perguntas respondidas localmente -------------------------------
  const questions = analysis.clauses.filter(c => c.intent === 'question')
  const local_answers = answerQuestions(input.state, questions, candidates)
  const answeredIds = new Set(local_answers.answered.map(c => c.id))
  unresolved = unresolved.filter(u => !answeredIds.has(u.clauseId))

  // ---- 6) IA remota só para o que sobrou ---------------------------------
  const stillOpen = unresolved.length > 0
  if (stillOpen && input.remoteEnabled && input.askRemote && !clarification) {
    const remote = await input.askRemote({ state: input.state, message: input.message, history: input.history })
    if (remote) {
      remoteReply = remote.reply
      remoteRejected = remote.rejected || []
      engine = candidates.length ? 'hybrid' : 'remote'
      if (!remote.contractFallback) {
        // Reconciliação: o remoto não repete o que o local já entendeu.
        const seen = new Set(candidates.map(c => JSON.stringify(c.action)))
        for (const a of remote.actions) {
          const key = JSON.stringify(a)
          if (seen.has(key)) continue
          const dup = candidates.some(c =>
            c.action.kind === a.kind &&
            (c.action as any).amount === (a as any).amount &&
            (c.action as any).total === (a as any).total)
          if (dup) continue
          seen.add(key)
          candidates.push(candidate(a, 'remote'))
        }
        if (remote.clarification && !clarification) clarification = remote.clarification
      }
      unresolved = []
    } else {
      unresolved = unresolved.map(u => ({ ...u, reason: 'remote-unavailable' as const }))
    }
  }

  candidates = candidates.slice(0, MAX_ACTIONS_PER_BATCH)

  // ---- 7) Avisos de duplicidade (contra o estado E dentro do lote) -------
  const batchSeen = new Map<string, number>()
  candidates = candidates.map(c => {
    const a: any = c.action
    const dupState = findPossibleDuplicate(input.state, c.action)
    const key = `${c.action.kind}:${a.amount ?? a.total ?? ''}:${(a.description || '').toLowerCase()}`
    const n = (batchSeen.get(key) || 0) + 1
    batchSeen.set(key, n)
    let warn: string | undefined
    if (n > 1) warn = 'Esta é a segunda vez que esse mesmo valor aparece nesta mensagem. Pode ser proposital — confira antes de confirmar.'
    else if (dupState) {
      warn = `Já existe ${dupState.type === 'income' ? 'uma receita' : 'uma despesa'} parecida de ${fmtBRL(dupState.amount)} registrada recentemente.`
    }
    return warn ? { ...c, duplicateWarning: warn } : c
  })

  // ---- 8) Texto final ----------------------------------------------------
  const hypo = questions.length && candidates.length && !local_answers.text ? hypotheticalSummary(candidates) : null
  const answerPart = [local_answers.text, remoteReply, hypo].filter(Boolean).join('\n\n')
  const rejectedAll = [...local.rejected, ...remoteRejected]

  let reply: string
  let mode: AssistantResponse['mode']

  if (clarification) {
    mode = 'clarify'
    reply = candidates.length
      ? `${proposalText(candidates)}\n\n${clarification.question}`
      : clarification.question
  } else if (candidates.length && answerPart) {
    mode = 'answer_and_actions'
    reply = `${proposalText(candidates)}\n\n${answerPart}\n\nConfirmar os registros?`
  } else if (candidates.length) {
    mode = 'propose_actions'
    reply = `${proposalText(candidates)}\n\nConfirmar?`
  } else if (answerPart) {
    mode = 'answer'
    reply = answerPart
  } else {
    mode = 'answer'
    const notUnderstood = unresolved.filter(u => u.reason !== 'question-unanswered')
    if (notUnderstood.length && (candidates.length || analysis.clauses.some(c => c.handled))) {
      reply = `Não consegui interpretar esta parte: "${notUnderstood[0].text}". Pode reformular só esse pedaço?`
    } else {
      reply = askAssistant(input.state, input.message).text
    }
  }
  reply += rejectionNote(rejectedAll)

  const diagnostics: AssistantDiagnostics | undefined = input.devDiagnostics
    ? {
        engine, coverage: analysis.coverage,
        clauses: analysis.clauses.map(c => ({ id: c.id, text: c.text, intent: c.intent, handled: c.handled, confidence: c.confidence })),
        localActions: local.candidates.length,
        remoteActions: candidates.length - local.candidates.length,
        rejected: rejectedAll,
        elapsedMs: Date.now() - started,
      }
    : undefined

  const base = { version: ASSISTANT_CONTRACT_VERSION, engine, unresolved, diagnostics, reply }
  const response: AssistantResponse =
    mode === 'clarify'
      ? { ...base, mode, actions: candidates, clarification: clarification! }
      : mode === 'answer'
        ? { ...base, mode, actions: [] }
        : { ...base, mode, actions: candidates }

  return { draft: null, response }
}

/**
 * Versão determinística e OFFLINE — é o que o corpus de regressão exercita.
 * Continua sendo `async` de propósito: fingir uma API síncrona exigiria um
 * truque com microtask que devolve `undefined` na prática.
 */
export function orchestrateLocal(
  input: Omit<OrchestratorInput, 'askRemote' | 'remoteEnabled'>,
): Promise<OrchestratorOutput> {
  return orchestrate({ ...input, remoteEnabled: false })
}

export { catById }
