// ORQUESTRADOR — o cérebro do assistente.
//
// Antes, `Chat.tsx` decidia tudo com dois `if`: "achou ação? usa local; senão
// manda pro remoto". Uma mensagem que registrava E perguntava perdia a pergunta;
// uma mensagem meio entendida ia inteira pro modelo e voltava duplicada.
//
// Aqui a decisão é por COBERTURA: o que o motor local resolveu com certeza fica
// resolvido, e só o que sobrou justifica chamar a IA remota — que reconcilia,
// nunca duplica.

import type { AppState, AssistantJournalEntry, ParsedAction, Transaction } from '../models/types'
import { isRevertFailure, lastReversibleBatch, revertBatchPure } from './journal'
import { editActionFor, findEditCandidates, parseEditRequest, parseSpokenCorrection } from './editSaved'
import type { EditableTxField } from './editSaved'
import { readWorkHoursEdit } from './editWorkHours'
import { editBlockReason, findGoalByExactName } from './execute'
import { matchInvoiceChoice, prepareInvoicePayments } from './invoicePayment'
import type {
  AssistantCandidateAction, AssistantCapabilities, AssistantClarification,
  AssistantDiagnostics, AssistantErrorCode, AssistantResponse, AssistantUnresolvedClause, PendingRideOffer,
} from './contracts'
import { ASSISTANT_CONTRACT_VERSION, MAX_ACTIONS_PER_BATCH, actionSpec, errorMessage, isValidationFailure, validateAction } from './contracts'
import { PEDE_APAGAR, analyzeMessage, contestsProposal, datesMentioned, declaresIntention, financialEventActions, isRefundInflow, looksLikeQuestion, looksLikeRetraction, looksNegated, looksPast, looksRecurring, segment, speechForCommands, weekdayChoiceWord } from './clauses'
import { categoryDilemma, outOfPatternWarning, withLearnedCategory, withLearnedSpelling } from './learning'
import { explainRequest } from './explain'
import { answerConversation, isFocusFresh, looksLikeFollowUp } from './conversation'
import { compareRideApps, PEDE_MINIMO_POR_KM, rideAppFollowUp } from './driverInsights'
import { buildRemoteConversation } from './conversation/remoteContext'
import type { RemoteConversationContext, RemoteTurnRelation } from './conversation/remoteContext'
import { buildTurnPlan, hasBlock } from './semantic/turn'
import { parseDriverDay, readShiftWithAppHours, reportedWorkMinutes } from './semantic/driverDay'
import { readRoadReport } from './semantic/roadReport'
import { formatValue } from './query/answer'
import type { FactUnit } from './query/types'
import { parseTypedPairs } from './semantic/pairs'
import { clampMessage, describeRepairs, normalizeDriverShorthand, repairStructuralTypos, stripFillers } from './semantic/normalize'
import { elapsedMinutes, readDatedShiftWork, spokenClock } from './semantic/clock'
import { continueRideOffer, interpretRideOffer, reviseRideOffer } from './rideOffer'
import { reconcileSpokenTotals } from './spokenTotals'
import { hasRideSettlementVerb, partialRidePayoutChoice, readPartialRidePayout, readPayoutDatePart, readPlatformPayout, readRideDebt, readRideDebtAfterActivity, readRidePayoutApp, readRideReportThenReceipt, readRideSettlement, readRideWallet, readShiftWithUnpaidPayout, ridePayoutPlatformName } from './platformPayout'
import { readCardPurchaseDue, resolveCardPurchaseDue } from './cardPurchaseDue'
import { conflictQuestion, evidenceFor, mergeByField, sameFact } from './semantic/evidence'
import { classifyLocalDecision } from './semantic/confidence'
import { modalidadeExplicita, planoContradizModalidade } from './semantic/modality'
import { semAlegacaoDeExecucao } from './claims'
import { composeAnswer, explainQueryResult, isQueryFailure, runQuery, validateQueryPlan } from './query'
import { looksLikeDataQuestion, normalizeQuery, PAYER_PRONOUN_QUERY, planQuery } from './query/parse'
import { namedCalendarWeek, parsePeriod, weekdayInCalendarWeek } from './query/period'
import { rememberQuery } from './conversation'
import type { RepairedText } from './semantic/normalize'
import type { ConversationFocus } from './conversation'
import type { AnalyzedClause, MessageAnalysis, TemporalSignal } from './clauses'
import { detectIncomplete, isDraftFresh, newDraft, questionFor, readDraftPurchaseDate, resolveDraftAnswer } from './drafts'
import type { AssistantDraft } from './drafts'
import { applyCorrection, parseCorrection } from './corrections'
import type { CorrectionPlan } from './corrections'
import { findGoalByName, planAssistantActions } from './execute'
import { askAssistant, listaDeLancamentos, normalizeQuestion, respostaDeCorridasAMais, respostaDeMetaCitada } from '../services/ai'
import { contaDeclarada, perguntaDeFatura, perguntaNominal } from './cashQuestions'
import { buildCapabilities } from './capabilities'
import { describeAction, META_OUTRA, NEXT_RIDE_DISTANCE, SAQUE, partesDoDia, totalComDoisPontos } from '../services/nlp'
import { isDriver, findPossibleDuplicate, defaultIncomeCategory } from '../services/profile'
import { catById, guessCategory, usableCategories } from '../data/categories'
import { addDays, fmtBRL, fmtHours, fmtNum, MESES_PT_BR, nowPaymentTime, nowTime, parseMoney, todayISO, uid } from '../utils/format'
import { matchRecurringPayment, occurrencesBetween, possibleRecurringTransactions, recurringActiveOn, recurringLinkAction } from '../services/calc'
import { normalizeName, sentenceCase } from '../utils/text'
import { normalizeNumberWords } from './numbers'
import { brDate, dateInAnswer, dateLabel, findAllDates, findDate, normalizeSpokenCalendarDays, previousYearOf, readNightShiftRange, resolveDayInWindow } from './dates'
import { applyPreferenceAliases, parsePreferenceCommand } from './preferences'
import type { PreferenceMutation } from './preferences'

// ---------------------------------------------------------------------------
// Capacidades reais do usuário
// ---------------------------------------------------------------------------


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
  draft?: AssistantDraft
  /** Proposta ainda na tela — alvo de correções. */
  pending?: AssistantCandidateAction[]
  /** Pergunta de esclarecimento aberta, para casar a resposta do usuário. */
  pendingClarification?: AssistantClarification
  remoteEnabled: boolean
  /**
   * Injetável: os testes rodam sem rede. NÃO recebe transcrição: a conversa vai
   * como estrutura (`conversation`), e os números do aparelho só vão quando o
   * trecho em aberto é pergunta ou pedido (`aggregates`). Ver
   * conversation/remoteContext.ts e `remoteNeedsAggregates`.
   */
  askRemote?: (args: {
    state: AppState
    message: string
    conversation?: RemoteConversationContext
    aggregates: boolean
  }) => Promise<RemoteResult | null>
  /**
   * Pede um PLANO de consulta ao modelo remoto. Injetavel e opcional: os testes
   * rodam sem rede, e um servidor que nao conhece a Query DSL simplesmente nao
   * devolve plano — o app cai na resposta local, que ja esta pronta.
   */
  planRemoteQuery?: (args: { state: AppState; message: string }) => Promise<any | null>
  today?: string
  devDiagnostics?: boolean
  /**
   * Foco conversacional. Em memoria, como o rascunho: e o que faz
   * "e mes passado?" refinar a consulta anterior em vez de virar uma pergunta
   * solta sem contexto.
   */
  focus?: ConversationFocus
}

export interface OrchestratorOutput {
  response: AssistantResponse
  /** Rascunho atualizado. `null` = apagar o rascunho atual. */
  draft: AssistantDraft | null
  /** Proposta corrigida, quando a mensagem era uma correção. */
  correctedPending?: AssistantCandidateAction[]
  /** Escrita local de vocabulário, separada das ações financeiras. */
  preferenceMutation?: PreferenceMutation
  /**
   * A resposta não consome a proposta que está na tela.
   *
   * Toda resposta sem ação zerava a proposta pendente. Isso está certo para
   * uma pergunta qualquer, e errado para "por que você colocou essa
   * categoria?": perguntar não é cancelar, e a próxima frase ("quantas vezes
   * eu fiz isso?", "não, foi 80") ainda fala do mesmo lançamento.
   */
  keepPending?: boolean
  /** Foco atualizado. O chamador guarda; nada e persistido em disco. */
  focus?: ConversationFocus
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
  /** Intenção futura declarada: explicar, nunca registrar. */
  temporalPlan?: TemporalSignal
  /** Conta que se repete: é previsão, e o cadastro dela não é por conversa. */
  recorrenteDeclarada?: boolean
  /** Intencao declarada ("vou gastar 80 no mercado"): explicar, nunca registrar. */
  intencaoDeclarada?: boolean
}

// ---------------------------------------------------------------------------
// Tempo — nada do que o usuário disse sobre QUANDO pode sumir
// ---------------------------------------------------------------------------

/** Copia as ações com uma data explícita, respeitando o catálogo. */
const withDate = (actions: ParsedAction[], iso?: string): ParsedAction[] =>
  actions.map(a => {
    const next: any = { ...a }
    if (!actionSpec(a.kind)?.fields.some(f => f.name === 'date')) return next as ParsedAction
    if (iso) next.date = iso
    else delete next.date
    return next as ParsedAction
  })

// ---------------------------------------------------------------------------
// Corrigir um lançamento já salvo
// ---------------------------------------------------------------------------

const CAMPO_LABEL: Record<EditableTxField, string> = {
  amount: 'Valor', category: 'Categoria', description: 'Descrição',
  origin: 'Origem', date: 'Data',
}

/** Uma linha curta que identifica o lançamento sem ambiguidade. */
const labelOfTx = (t: Transaction): string =>
  `${t.description ? sentenceCase(t.description) : 'Sem descrição'} — ${fmtBRL(t.amount)} (${brDate(t.date)})`

/** Mostra o ANTES e o DEPOIS. Corrigir dinheiro salvo às cegas não é opção. */
function describeEdit(state: AppState, t: Transaction, req: { field: EditableTxField; value: string | number }): string {
  const nomeCat = (id?: string) => state.categories.find(c => c.id === id)?.name || id || '—'
  const antes = req.field === 'amount' ? fmtBRL(t.amount)
    : req.field === 'category' ? nomeCat(t.category)
      : req.field === 'date' ? brDate(t.date)
        : String((t as any)[req.field] || '—')
  const depois = req.field === 'amount' ? fmtBRL(Number(req.value))
    : req.field === 'category' ? nomeCat(String(req.value))
      : req.field === 'date' ? brDate(String(req.value))
        : String(req.value)
  return `Vou corrigir este lançamento:\n\n• ${labelOfTx(t)}\n• ${CAMPO_LABEL[req.field]}: ${antes} → ${depois}`
}

// ---------------------------------------------------------------------------
// Desfazer o último lote
// ---------------------------------------------------------------------------

/**
 * Pedido de desfazer. Exige o VERBO abrindo a frase e um alvo referencial
 * ("o último", "isso") — sem as duas coisas, "gastei 30 no último posto" viraria
 * uma reversão, e "apaga tudo" continuaria sendo o reset destrutivo de sempre.
 */
// `\b` antes de "último" NÃO funciona: em JS o "ú" não é caractere de palavra,
// então a borda nunca casa — a mesma armadilha que já tinha escondido "amanhã".
const UNDO_REQUEST =
  /^\s*(?:pode\s+|por\s+favor\s+)?(?:desfaz|desfazer|desfa[çc]a|cancela|cancelar|remove|remover|apaga|apagar|exclui|excluir)(?![a-zà-ú])[^.?!]{0,40}?\s(?:[úu]ltim[oa]|isso|isto)(?![\wà-úÀ-Ú])/i

// Como se pede para desfazer sem usar a palavra "último": "volta atrás",
// "desfaz aí". Não têm complemento nenhum, então não casam no padrão acima.
const UNDO_SHORT =
  /^\s*(?:pode\s+)?(?:volta(?:r)?\s+atr[áa]s|voltar\s+atr[áa]s|desfaz(?:er)?\s*(?:a[íi])?|desfa[çc]a\s*(?:a[íi])?)\s*[.!]?\s*$/i

const dinheiro = (v: number) => fmtBRL(v)

/** Uma linha legível por entidade que a reversão vai remover ou restaurar. */
function describeUndoTarget(state: AppState, entity: string, alvo: any): string | null {
  switch (entity) {
    case 'transactions': {
      const rotulo = alvo.type === 'income' ? 'Receita' : alvo.type === 'saving' ? 'Reserva' : alvo.type === 'financed-cash-inflow' ? 'Entrada financiada' : 'Despesa'
      return `${rotulo} de ${dinheiro(alvo.amount)}${alvo.description ? ` — ${alvo.description}` : ''}`
    }
    case 'goals': return `Meta "${alvo.name}"`
    case 'installmentPlans': return `${alvo.description || 'Parcelamento'} de ${dinheiro(alvo.totalAmount)} em ${alvo.installmentCount}x`
    case 'cardPayments': return `Pagamento de fatura de ${dinheiro(alvo.amount)}`
    case 'cardCharges': return `Assinatura ${alvo.description} de ${dinheiro(alvo.amount)}/mês`
    case 'fuelRecords': return `Abastecimento de ${dinheiro(alvo.amount)}`
    case 'workSessions': return `Registro de trabalho de ${alvo.date}`
    case 'maintenance': return `Manutenção "${alvo.name}"`
    case 'cards': return `Cartão ${alvo.name}`
    // Parcelas são detalhe do plano: listá-las uma a uma só faria ruído.
    default: return null
  }
}

/**
 * O que o usuário vai perder ao confirmar. Mostrar isso ANTES de reverter é
 * requisito, não cortesia: desfazer é destrutivo e silencioso por natureza.
 */
export function describeUndo(state: AppState, entry: AssistantJournalEntry): string[] {
  const linhas: string[] = []
  for (const op of entry.ops) {
    if (op.op !== 'create') continue
    const lista: any[] = (state as any)[op.entity] || []
    const alvo = lista.find(x => x.id === op.id)
    if (!alvo) continue
    const linha = describeUndoTarget(state, op.entity, alvo)
    if (linha) linhas.push(linha)
  }
  for (const op of entry.ops) {
    if (op.op !== 'update') continue
    if (op.entity === 'goals') {
      const g: any = (state.goals || []).find(x => x.id === op.id)
      const antes = (op.before as any).saved
      if (g && typeof antes === 'number') linhas.push(`Depósito de ${dinheiro(g.saved - antes)} na meta "${g.name}"`)
    } else if (op.entity === 'recurring') {
      linhas.push('Confirmação de uma conta recorrente (volta a ficar pendente)')
    } else if (op.entity === 'transactions') {
      // Lote de CORREÇÃO: sem esta linha o card só dizia "vou desfazer o
      // último registro" e o usuário confirmava sem saber o que voltava.
      const t: any = (state.transactions || []).find(x => x.id === op.id)
      if (!t) continue
      const volta = Object.entries(op.before as Record<string, unknown>)
        .map(([campo, valor]) => `${CAMPO_LABEL[campo as EditableTxField] || campo} volta para ${campo === 'amount' ? dinheiro(Number(valor)) : String(valor ?? '—')}`)
      linhas.push(`Correção em "${t.description ? sentenceCase(t.description) : 'lançamento'}" — ${volta.join(', ')}`)
    }
  }
  for (const op of entry.ops) {
    if (op.op === 'patch' && op.entity === 'settings' && 'balance' in (op.before as any)) {
      linhas.push('Saldo em conta informado')
    }
  }
  return linhas
}

/**
 * Explicação honesta para uma intenção futura. O app não agenda lançamentos —
 * dizer isso com todas as letras é melhor do que registrar na data errada ou
 * responder com o texto genérico de ajuda, que foi o que motivou esta correção.
 */
function futurePlanReply(t: TemporalSignal): string {
  const quando = t.date && !t.imprecise ? ` (${brDate(t.date)})` : ''
  // Com outra parte da frase virando proposta, "isso" não diz O QUÊ ficou de
  // fora. O valor segurado precisa aparecer: é ele que o usuário confere.
  const valores = t.actions
    .map(a => (a as any).amount)
    .filter((v: any) => typeof v === 'number' && v > 0)
    .map((v: number) => fmtBRL(v))
  if (valores.length) {
    return `${valores.join(' e ')} ainda não ${valores.length > 1 ? 'aconteceram' : 'aconteceu'} — você falou de "${t.text}"${quando}. `
      + 'Eu ainda não sei agendar lançamentos futuros, então essa parte ficou de fora. '
      + 'Quando acontecer, é só me avisar que eu registro na hora.'
  }
  return `Isso ainda não aconteceu — você falou de "${t.text}"${quando}. `
    + 'Eu ainda não sei agendar lançamentos futuros, então não registrei nada. '
    + 'Quando acontecer, é só me avisar que eu registro na hora.'
}

/**
 * Pergunta para uma expressão temporal que não pode datar um fato. Cada opção
 * carrega o efeito COMPLETO: escolher não obriga o usuário a repetir o valor.
 */
function temporalClarification(t: TemporalSignal): AssistantClarification {
  if (t.kind === 'invalid' || t.kind === 'unknown') {
    return {
      question: t.question || `A data "${t.text}" é inválida. Qual foi a data correta?`,
      field: 'date',
      pendingActions: t.actions,
    }
  }
  if (t.kind === 'period') {
    return {
      question: `Você disse "${t.text}", mas não disse o dia. Que dia foi?`,
      field: 'date',
      dateWindow: { from: t.from!, to: t.to! },
      pendingActions: t.actions,
    }
  }

  const plano = { label: 'É um plano', value: 'plano', reply: futurePlanReply(t) }
  // Data dita por extenso ("dia 10/08"): a leitura mais provável é o mesmo dia
  // do ano passado. Mostramos as duas datas para o usuário escolher de olho.
  if (!t.relative && t.date) {
    const yearWasSaid = /\b\d{4}\b|(?:\d{1,2}[/-]){2}\d{2}\b/.test(t.text)
    const anterior = yearWasSaid ? undefined : previousYearOf(t.date)
    return {
      question: anterior ? `A data ${brDate(t.date)} ainda não chegou. Foi ${brDate(anterior)} ou você quer planejar para ${brDate(t.date)}?`
        : `A data ${brDate(t.date)} ainda não chegou. Qual foi a data correta?`,
      field: 'date', pendingActions: t.actions,
      options: [
        ...(anterior ? [{ label: brDate(anterior), value: anterior, actions: withDate(t.actions, anterior) }] : []),
        plano,
      ],
    }
  }
  const quando = t.date && !t.imprecise ? ` (${brDate(t.date)})` : ''
  return {
    question: `"${t.text}"${quando} ainda não chegou. Isso já aconteceu ou é um plano que você quer registrar quando acontecer?`,
    field: 'date', pendingActions: t.actions,
    options: [
      { label: 'Já aconteceu', value: 'ja-aconteceu', actions: withDate(t.actions) },
      plano,
    ],
  }
}

function actionForProfile(action: ParsedAction, caps: AssistantCapabilities, mensagem = ''): ParsedAction {
  if (caps.isDriver) return action
  if (action.kind === 'fuel' && action.amount > 0) {
    // O combustível DITO fica na descrição: "abasteci 150 de GNV" gravava
    // "Combustível", e "quanto gastei de GNV" nunca achava o lançamento.
    const tipo = normalizeName(mensagem).match(/(?<![\wÀ-ÿ])(gnv|etanol|alcool|diesel|gasolina)(?![\wÀ-ÿ])/)?.[1]
    const nome = tipo === 'gnv' ? 'GNV' : tipo === 'alcool' ? 'Álcool' : tipo ? tipo[0].toUpperCase() + tipo.slice(1) : 'Combustível'
    return { kind: 'expense', amount: action.amount, category: 'combustivel', description: nome, date: action.date }
  }
  if (action.kind === 'maintenance') {
    return { kind: 'expense', amount: action.cost, category: 'manutencao', description: `Troca de ${action.item}`, date: action.date }
  }
  return action
}

interface DepositoSemMeta { amount: number; name?: string }

/**
 * `goal-deposit` precisa de UMA meta real antes de virar proposta.
 *
 * Uma só meta ativa, ou o nome que casa com uma delas: a ação sai com o nome DE
 * VERDADE ("moto" vira "Moto"). Sem meta que case — nome desconhecido, várias
 * metas e nenhum nome, ou nenhuma meta — a ação NÃO fica na tela: antes ela
 * ficava confirmável ao lado da pergunta e só falhava depois do Confirmar. Ela
 * é segurada (`null` na mesma posição) e vira pergunta com as saídas prontas.
 */
function reconcileGoalDeposits(
  state: AppState,
  actions: ParsedAction[],
): { actions: (ParsedAction | null)[]; semMeta: DepositoSemMeta[]; alteracaoSemMeta: { target: number; name?: string }[] } {
  const semMeta: DepositoSemMeta[] = []
  // "Aumenta a meta pra 6000" sem dizer qual: com uma meta ativa é ela; com
  // várias, vira pergunta. Antes a validação respondia "Falta uma informação
  // obrigatória". Nome que não existe também pergunta, como no depósito: a
  // proposta só falharia depois do Confirmar.
  const alteracaoSemMeta: { target: number; name?: string }[] = []
  const ativasAgora = (state.goals || []).filter(g => !g.done)
  // "A outra" só quer dizer alguma coisa em relação às metas já citadas na
  // mesma frase. Com exatamente uma sobrando, é ela; com mais de uma, quem
  // pergunta é o fluxo de sempre — e o valor vai junto na pergunta.
  const citadas = new Set(
    actions.filter(a => a.kind === 'goal-deposit' && a.name && a.name !== META_OUTRA)
      .map(a => findGoalByName(state, (a as any).name)?.name)
      .filter(Boolean) as string[],
  )
  const out = actions.map(a => {
    if (a.kind === 'goal-update') {
      const g = a.name ? findGoalByName(state, a.name) : undefined
      if (g) return { ...a, name: g.name } as ParsedAction
      if (!a.name && ativasAgora.length === 1) return { ...a, name: ativasAgora[0].name } as ParsedAction
      if (a.target) { alteracaoSemMeta.push({ target: a.target, name: a.name || undefined }); return null }
      return a
    }
    if (a.kind !== 'goal-deposit') return a
    if (a.name === META_OUTRA && !findGoalByName(state, META_OUTRA)) {
      const sobrando = (state.goals || []).filter(g => !g.done && !citadas.has(g.name))
      if (sobrando.length === 1) return { ...a, name: sobrando[0].name } as ParsedAction
      semMeta.push({ amount: a.amount })
      return null
    }
    const g = findGoalByName(state, a.name)
    if (g) return { ...a, name: g.name } as ParsedAction
    semMeta.push({ amount: a.amount, name: a.name || undefined })
    return null
  })
  return { actions: out, semMeta, alteracaoSemMeta }
}

/** "Qual meta você quer alterar para R$ 6.000,00?", com uma opção por meta ativa. */
function goalUpdateClarification(state: AppState, pedido: { target: number; name?: string }, candidates: AssistantCandidateAction[]): AssistantClarification {
  const ativas = (state.goals || []).filter(g => !g.done)
  const resto = candidates.map(c => c.action)
  const alvo = pedido.target
  const naoAchei = pedido.name ? `Não encontrei a meta "${sentenceCase(pedido.name)}". ` : ''
  if (!ativas.length) {
    return { question: `${naoAchei}Você ainda não tem meta para alterar. Para criar uma, diga algo como "quero juntar 5000 pra uma moto".`, field: 'goalName' }
  }
  return {
    question: `${naoAchei}Qual meta você quer alterar para ${fmtBRL(alvo)}?`,
    field: 'goalName',
    options: ativas.map(g => ({
      label: g.name, value: g.name,
      actions: [...resto, { kind: 'goal-update', name: g.name, target: alvo } as ParsedAction],
    })),
  }
}

/**
 * A pergunta do depósito sem meta. Cada opção carrega o lote INTEIRO — o que já
 * foi entendido na mensagem mais o depósito naquela meta —, e a reserva é sempre
 * uma saída: o dinheiro foi guardado de verdade, só não se sabe onde.
 */
function goalDepositClarification(
  state: AppState,
  semMeta: DepositoSemMeta[],
  candidates: AssistantCandidateAction[],
): AssistantClarification {
  const ativas = (state.goals || []).filter(g => !g.done)
  const resto = candidates.map(c => c.action)
  if (semMeta.length > 1) {
    // Uma pergunta não cobre dois depósitos, e escolher por um deles jogaria o
    // outro fora em silêncio (mesma lógica da regra 49).
    return {
      question: `Não consegui ligar ${semMeta.length} valores às suas metas. Me diga um de cada vez — por exemplo, "coloquei ${fmtBRL(semMeta[0].amount)} na meta ${ativas[0]?.name || 'Viagem'}".`,
      field: 'goalName',
    }
  }
  const { amount, name } = semMeta[0]
  const valor = fmtBRL(amount)
  const reserva = { label: 'Guardar na reserva', value: 'reserva', actions: [...resto, { kind: 'saving', amount } as ParsedAction] }
  if (!ativas.length) {
    return {
      question: `${name ? `Você não tem uma meta chamada "${sentenceCase(name)}" — nem outra meta cadastrada.` : 'Você ainda não tem meta cadastrada.'} `
        + `Quer guardar ${valor} na reserva? Para criar uma meta, diga algo como "quero juntar 5000 pra uma moto".`,
      field: 'goalName',
      options: [reserva],
    }
  }
  return {
    question: name
      ? `Não encontrei a meta "${sentenceCase(name)}". Em qual meta você guardou ${valor}?`
      : `Em qual meta você guardou ${valor}?`,
    field: 'goalName',
    options: [
      ...ativas.map(g => ({
        label: g.name, value: g.name,
        actions: [...resto, { kind: 'goal-deposit', amount, name: g.name } as ParsedAction],
      })),
      reserva,
    ],
  }
}

/**
 * A meta ativa que recebe o dinheiro em "coloquei/botei 300 na <meta>". O valor
 * vai DIRETO para o nome (sem "de gasolina" no meio) e a descrição que o parser
 * leu é o próprio nome da meta — os dois juntos, nunca um só.
 */
function metaDoDeposito(state: AppState, text: string, action: Extract<ParsedAction, { kind: 'expense' }>) {
  const t = normalizeName(text)
  const m = t.match(/\b(?:coloquei|botei|pus|joguei|mandei|transferi)\s+(?:mais\s+)?(?:r\$\s*)?\d[\d.,]*\s*(?:reais|real|conto|contos|pila)?\s+(?:na|no|pra|pro|para)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?(.+)$/)
  if (!m) return undefined
  const desc = normalizeName(action.description)
  return (state.goals || []).filter(g => !g.done).find(g => {
    const nome = normalizeName(g.name)
    return !!nome && (m[1] === nome || m[1].startsWith(`${nome} `)) && desc === nome
  })
}

function runLocal(
  input: OrchestratorInput,
  caps: AssistantCapabilities,
  /** Análise já feita pelo plano de turno — evita segmentar a mesma frase duas vezes. */
  precomputada?: MessageAnalysis,
): LocalPass {
  const today = input.today || todayISO()
  const analysis = precomputada || analyzeMessage(input.message, { driver: caps.isDriver, today })

  const rejected: LocalPass['rejected'] = []
  const candidates: AssistantCandidateAction[] = []
  let clarification: AssistantClarification | undefined

  // Ambiguidade real (gás) interrompe: pergunta primeiro, registra depois.
  const ambiguities = analysis.clauses.filter(c => c.ambiguity)
  const ambiguous = ambiguities[0]
  const waitingForDate = new Map<AnalyzedClause, ParsedAction[]>()

  // A informação temporal tem PRIORIDADE sobre as outras perguntas: ela decide
  // se o lançamento existe. Perguntar o cartão antes de saber se a despesa
  // aconteceu seria conversar sobre um fato que talvez nem exista.
  const temporalAsk = analysis.clauses.find(c => c.temporal && !c.temporal.plan)?.temporal
  const temporalPlan = analysis.clauses.find(c => c.temporal?.plan)?.temporal
  if (temporalAsk) clarification = temporalClarification(temporalAsk)

  const { actions: reconciled, semMeta, alteracaoSemMeta } = reconcileGoalDeposits(input.state, analysis.actions)

  // Corrigir exige algo para corrigir. Sem proposta na tela, "na verdade foi
  // 200" é um conserto sem alvo — e como `foi` é verbo de despesa no parser,
  // deixar passar criava um gasto de R$ 200 que ninguém pediu. A correção COM
  // proposta na tela é tratada antes daqui, no passo de correções.
  const semAlvo = !input.pending?.length

  // Conta que se repete é PREVISÃO, não movimentação de hoje (regra 18).
  // "Pago 90 de internet todo mês" virava despesa avulsa de 90 e inflava o mês
  // com dinheiro que ainda não saiu. Vale só para movimento de dinheiro: "rodei
  // todo dia" continua sendo registro de trabalho.
  const MOVIMENTO = new Set(['income', 'expense', 'saving'])
  let recorrenteDeclarada = false
  let intencaoDeclarada = false
  /** Frase que o usuário classifica de dois jeitos, com evidência dos dois. */
  const dilemas: { actionId: string; entity: string; options: string[] }[] = []

  for (const clause of analysis.clauses) {
    if (clause.intention) intencaoDeclarada = true
    if (semAlvo && looksLikeRetraction(clause.text)) continue
    // O valor precisa estar na frase: "todo mês" sozinho não descreve conta
    // nenhuma. Com valor, tanto faz o parser ter achado a despesa ("pago 90 de
    // internet todo mês") ou não ("minha internet é 90 por mês") — nos dois
    // casos a resposta certa é a mesma, e nos dois é errado registrar hoje.
    if (looksRecurring(clause.text) && /\d/.test(clause.text)
      && !clause.actions.some(a => !MOVIMENTO.has(a.kind))) {
      recorrenteDeclarada = true
      continue
    }
    for (const raw of clause.actions) {
      const idx = analysis.actions.indexOf(raw)
      let action = idx >= 0 ? reconciled[idx] : raw
      // Depósito segurado até o usuário dizer em qual meta — ver abaixo.
      if (!action) continue
      // "Coloquei 300 na viagem" com a meta Viagem: o parser não conhece as
      // metas e lia despesa de R$ 300 (Outros). Pôr dinheiro direto NA meta
      // ativa é depósito; "coloquei 50 de gasolina na moto" continua gasto.
      if (action.kind === 'expense') {
        const meta = metaDoDeposito(input.state, clause.text, action)
        if (meta) action = { kind: 'goal-deposit', amount: action.amount, name: meta.name }
      }
      // "Vou guardar 200 na meta do notebook": a meta existe, o depósito ainda
      // não aconteceu. Sem meta com esse nome, a pergunta (criar ou reservar?)
      // continua — ela é o caminho para criar o objetivo.
      if (action.kind === 'goal-deposit' && action.name && !looksPast(clause.text) && declaresIntention(clause.text)
        && findGoalByName(input.state, action.name)) {
        intencaoDeclarada = true
        continue
      }

      // Quem não é motorista também abastece e faz manutenção — só não tem a
      // estrutura de veículo do app. Em vez de descartar o lançamento (o
      // usuário gastou o dinheiro de verdade), ele vira despesa da categoria
      // correspondente. `work` e `odometer` não têm equivalente e são recusados.
      action = actionForProfile(action, caps, clause.text)

      // O vocabulário do usuário entra ANTES da validação: a categoria que ele
      // mesmo usa precisa passar pelas mesmas regras de qualquer outra.
      if (!isRefundInflow(action)) action = withLearnedCategory(input.state, action, today, input.message)

      const res = validateAction(action, caps, today)
      if (isValidationFailure(res)) {
        rejected.push({ kind: action.kind, code: res.code, detail: res.detail })
        continue
      }
      // Duas categorias fortes disputando a mesma frase: o usuário lança no
      // Quiosque tanto em Lazer quanto em Compras. Escolher seria sortear;
      // ignorar as duas jogaria fora o que ele já disse. A saída é a mesma do
      // resto do app — perguntar, com as opções carregando a proposta pronta.
      const dilema = isRefundInflow(res.action) ? undefined : categoryDilemma(input.state, res.action, today)
      if (dilema) dilemas.push({ actionId: '', ...dilema })

      // A proposta mostra a categoria que SERÁ gravada, não um campo vazio que
      // o usuário só descobre depois de confirmar.
      const withDefaults: any = { ...res.action }
      if (withDefaults.kind === 'income' && !withDefaults.category) withDefaults.category = defaultIncomeCategory(input.state.settings)
      // "Fui no mercado E gastei 80", "parei pra almoçar, gastei 25": o assunto
      // ficou na cláusula anterior, sem valor. Com um único lançamento de
      // dinheiro na mensagem, ele é desse gasto — com dois, poderia ser de
      // qualquer um, e o app não escolhe.
      if (withDefaults.kind === 'expense' && !withDefaults.category && !withDefaults.description
        && analysis.actions.filter(a => a.kind === 'expense' || a.kind === 'income' || a.kind === 'fuel').length === 1) {
        const assunto = guessCategory(input.message, 'expense')
        if (assunto && assunto !== 'outros-out' && caps.categories.some(c => c.id === assunto && c.type === 'expense')) withDefaults.category = assunto
      }
      if (withDefaults.kind === 'expense' && !withDefaults.category) withDefaults.category = 'outros-out'
      if (clause.dateAmbiguity) {
        const held = waitingForDate.get(clause) || []
        held.push(withDefaults)
        waitingForDate.set(clause, held)
        continue
      }
      candidates.push(candidate(withDefaults, 'local', clause.id, clause.confidence))
    }
  }

  const unresolved = analysis.unresolvedClauses
    .filter(c => c.intent !== 'conversation')
    .map(c => unresolvedOf(c, c.intent === 'question' ? 'question-unanswered' : 'not-understood'))

  if (!clarification && waitingForDate.size > 0) {
    const [[clause, actions]] = waitingForDate
    const canDate = actions.every(a => actionSpec(a.kind)?.fields.some(f => f.name === 'date'))
    if (waitingForDate.size === 1 && canDate && clause.dateAmbiguity) {
      clarification = { ...clause.dateAmbiguity, field: 'date-choice', pendingActions: actions }
    } else {
      const waiting = [...waitingForDate.values()].flat()
        .map(action => describeAction(action, id => input.state.categories.find(c => c.id === id)?.name))
      clarification = { field: 'date-choice', question: canDate
        ? `Mais de um registro ficou com data indefinida. Informe a data completa de cada um:\n${waiting.map(text => `• ${text}`).join('\n')}`
        : 'A data desse registro ficou indefinida. Confira a data correta na tela do registro antes de salvar.' }
    }
  }

  if (semMeta.length && !clarification) clarification = goalDepositClarification(input.state, semMeta, candidates)
  if (alteracaoSemMeta.length && !clarification) clarification = goalUpdateClarification(input.state, alteracaoSemMeta[0], candidates)

  if (!clarification && ambiguous?.ambiguity) {
    // Cada opção carrega a lista COMPLETA de ações já resolvidas: escolher
    // "GNV" não obriga o usuário a repetir o valor nem a descrição.
    clarification = {
      question: ambiguities.length > 1
        ? ambiguities.map(c => c.ambiguity!.question).join('\n\n')
        : ambiguous.ambiguity.question,
      options: ambiguities.length > 1 ? [] : ambiguous.ambiguity.options.map(o => ({ label: o.label, value: o.value || o.label, actions: o.actions, reply: o.reply })),
      field: ambiguities.length > 1 ? 'financial-events' : ambiguous.ambiguity.field || 'ambiguity',
      pendingActions: ambiguities.length === 1 ? ambiguous.ambiguity.pendingActions : undefined,
      queryTemplate: ambiguities.length === 1 ? ambiguous.ambiguity.queryTemplate : undefined,
      dateWindow: ambiguities.length === 1 ? ambiguous.ambiguity.dateWindow : undefined,
      financialEvent: ambiguities.length === 1 ? ambiguous.ambiguity.financialEvent : undefined,
    }
  }

  // Cartão citado que não existe, ou fatura sem cartão com vários cadastrados:
  // não vira ação executável — vira pergunta específica.
  for (const c of candidates) {
    const a: any = c.action
    if (c.action.kind === 'card-payment') continue
    // `'cardName' in a` não serve: a validação remove campos ausentes, então a
    // chave simplesmente não existe. Quem sabe se a ação ACEITA cartão é o
    // catálogo.
    if (!actionSpec(a.kind)?.fields.some(f => f.name === 'cardName')) continue
    if (a.cardName) {
      // "no nubank" aparecia em minúsculas na proposta: o cartão cadastrado
      // tem grafia, e é ela que a confirmação mostra.
      const grafia = caps.cardNames.find(n => normalizeName(n) === normalizeName(a.cardName))
      if (grafia) a.cardName = grafia
      let known = caps.cardNames.some(n => normalizeName(n) === normalizeName(a.cardName)
        || normalizeName(n).includes(normalizeName(a.cardName)))
      // "Paguei 2400 NO SEGURO em 12x NO NUBANK": o primeiro "no X" era o item.
      // Um cartão cadastrado citado pelo nome na frase é o cartão.
      if (!known && a.kind === 'card-purchase') {
        const frase = normalizeName(input.message)
        const citado = caps.cardNames.find(n => new RegExp(`(?<![\\wÀ-ÿ])${escaparRegex(normalizeName(n))}(?![\\wÀ-ÿ])`).test(frase))
        if (citado) { a.cardName = citado; known = true }
      }
      if (!known) {
        clarification = clarification || {
          question: caps.cardNames.length
            ? `Não encontrei um cartão chamado "${a.cardName}". Qual dos seus cartões é?`
            : `Não encontrei um cartão chamado "${a.cardName}". Você quer cadastrar esse cartão antes?`,
          field: 'cardName',
          options: caps.cardNames.map(n => ({ label: n, value: n })),
        }
      }
    } else if (caps.cardNames.length > 1) {
      // Com vários cartões, escolher sozinho seria adivinhar. Cada opção já
      // carrega a proposta COMPLETA com aquele cartão — o usuário só escolhe.
      clarification = clarification || {
        question: 'Em qual cartão?',
        field: 'cardName',
        options: caps.cardNames.map(n => ({
          label: n,
          value: n,
          actions: candidates.map(x => (x.id === c.id ? { ...(x.action as any), cardName: n } : x.action)),
        })),
      }
    }
  }
  // Última na fila de propósito: cartão inexistente e data ambígua são dúvidas
  // sobre O QUE ACONTECEU; esta é só sobre como ARQUIVAR. Cada opção carrega o
  // lote inteiro já com aquela categoria, então responder não repete nada.
  // Só com UM item ambíguo: uma pergunta não cobre dois, e responder
  // resolveria um enquanto o outro ficasse em Outros sem o usuário entender por
  // quê. Com dois, os dois vão genéricos — visíveis e editáveis no mesmo card.
  if (!clarification && dilemas.length === 1 && candidates.length) {
    const d = dilemas[0]
    const alvo = candidates.find(c => {
      const a: any = c.action
      return String(a.description || a.origin || '').trim() === d.entity
    })
    if (alvo) {
      const nome = (id: string) => catById(input.state.categories, id).name
      clarification = {
        question: `Você lança ${d.entity} tanto em ${nome(d.options[0])} quanto em ${nome(d.options[1])}. Qual é desta vez?`,
        field: 'category',
        actionId: alvo.id,
        options: d.options.map(id => ({
          label: nome(id),
          value: id,
          actions: candidates.map(x => (x.id === alvo.id ? { ...(x.action as any), category: id } : x.action)),
        })),
        // A resposta pode não ser nenhuma das opções ("sei lá"). Guardar as
        // ações como estão é o que permite propor a versão genérica em vez de
        // perder o lançamento por causa de uma pergunta opcional.
        pendingActions: candidates.map(x => x.action),
      }
    }
  }

  // Regra central: ACHAR AÇÃO NÃO É COMPREENDER A MENSAGEM.
  const needsRemote = analysis.clauses.some(c =>
    !c.handled && c.intent !== 'conversation' && !(c.intent === 'question' && false))
    || analysis.coverage < 0.999

  return { analysis, candidates, rejected, clarification, needsRemote, unresolved, temporalPlan, recorrenteDeclarada, intencaoDeclarada }
}

// ---------------------------------------------------------------------------
// Respostas locais
// ---------------------------------------------------------------------------

/**
 * Responde perguntas usando o estado PROJETADO (estado atual + ações propostas),
 * deixando explícito que o número depende da confirmação. Reaproveita o motor de
 * respostas local inteiro em vez de duplicar regra de cálculo.
 */
function rideOfferClarification(reply: string, rideOffer: PendingRideOffer): AssistantClarification {
  return { field: 'ride-offer', question: reply, rideOffer }
}

function rideOfferReply(input: OrchestratorInput, offer: { reply: string; pending?: PendingRideOffer; done?: Omit<PendingRideOffer, 'missing'> }): OrchestratorOutput {
  const response = { version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const, actions: [] as [], unresolved: [], reply: offer.reply }
  // A análise completa fica no foco para a revisão seguinte ("na verdade o
  // retorno era 7 km").
  const focus = offer.done
    ? { ...(input.focus || {}), lastRideOffer: { ...offer.done } as PendingRideOffer, updatedAt: Date.now() }
    : input.focus
  return { draft: null, keepPending: true, focus,
    response: offer.pending
      ? { ...response, mode: 'clarify', clarification: rideOfferClarification(offer.reply, offer.pending) }
      : { ...response, mode: 'answer' },
  }
}

function answerQuestions(
  state: AppState,
  questions: AnalyzedClause[],
  candidates: AssistantCandidateAction[],
  today: string,
  message: string,
): { text: string; answered: AnalyzedClause[]; focus?: ConversationFocus; rideClarification?: AssistantClarification } {
  if (!questions.length) return { text: '', answered: [] }
  const projected = candidates.length
    ? planAssistantActions(state, candidates.map(c => ({ id: c.id, action: c.action })), { date: today, time: nowPaymentTime() }).projected
    : state

  const parts: string[] = []
  const answered: AnalyzedClause[] = []
  let focus: ConversationFocus | undefined
  let rideClarification: AssistantClarification | undefined
  for (const q of questions) {
    const nextRide = candidates.some(c => c.action.kind === 'income' && c.action.description === 'Corrida')
      ? q.text.replace(NEXT_RIDE_DISTANCE, 'outra corrida') : q.text
    const offer = interpretRideOffer(state, nextRide, message)
    if (offer) {
      parts.push(offer.reply)
      if (offer.pending && questions.length === 1) rideClarification = rideOfferClarification(offer.reply, offer.pending)
      answered.push(q)
      continue
    }
    const pergunta = perguntaComAssunto(caudaDaPergunta(q.text, candidates), candidates)
    // A consulta só entra ao lado de um registro e com pergunta inteira. Sem
    // registro, quem responde é o turno normal, que lê a mensagem toda; e um
    // fragmento ("minha reserva tá em | quanto") virava "Total gasto este mês".
    const usaConsulta = candidates.length > 0 && pergunta.trim().split(/\s+/).length >= 3
    const real = respostaLocal(state, pergunta, today, usaConsulta, message)
    const comRegistro = candidates.length ? respostaLocal(projected, pergunta, today, usaConsulta, message) : real
    if (!comRegistro) continue
    // Regra 27: o número que conta com o registro ainda não confirmado é
    // hipotético. "Qual meu saldo" mostrava o saldo já descontado como se fosse
    // o de hoje, e a resposta dizia "dado real".
    const depende = candidates.length > 0 && real?.text !== comRegistro.text
    parts.push(depende
      ? `Se você confirmar ${candidates.length === 1 ? 'o registro acima' : 'os registros acima'}:\n${semDadoReal(comRegistro.text)}`
      : comRegistro.text)
    // O foco vem do estado REAL: um "pq?" seguinte não pode explicar números
    // de um registro que talvez nunca seja confirmado.
    focus = real?.focus || focus
    answered.push(q)
  }
  return { text: parts.join('\n\n'), answered, focus, rideClarification }
}

function answerListedDays(state: AppState, question: string, today: string): string | undefined {
  if (!looksLikeQuestion(question) || !looksLikeDataQuestion(question)) return undefined
  const daysByNumber = /\b(?:nos|dos|os)\s+dias\s+(\d{1,2})\s+e\s+(\d{1,2})(?![\d/]|[.,]\d)(?:\s+de\s+([\p{L}]+)(?:\s+de\s+(20\d{2}))?)?/iu
  const list = question.match(daysByNumber)
  if (list && (!list[3] || MESES_PT_BR.some(month => normalizeName(month) === normalizeName(list[3])))) {
    const month = list[3] ? ` de ${list[3]}${list[4] ? ` de ${list[4]}` : ''}` : ''
    question = question.replace(list[0], month ? `${list[1]}${month} e ${list[2]}${month}` : `dia ${list[1]} e dia ${list[2]}`)
  }
  const mentioned = datesMentioned(question, today, true)
  const dates = mentioned.filter(date => date.kind !== 'period').sort((a, b) => a.start - b.start)
  if (dates.length < 2) return undefined
  const [first] = dates
  const prefix = question.slice(0, first.start).trimEnd()
  if (/\bentre\s*$/i.test(prefix)) return undefined
  const joiner = /^(?:\s*,\s*(?:e\s+)?|\s+e\s+)(?:(?:no|na|em|de)\s*)?$/i
  if (!dates.slice(1).every((d, i) => joiner.test(question.slice(dates[i].end, d.start)))) return undefined
  const last = dates[dates.length - 1]
  const rawTail = question.slice(last.end)
  const tail = rawTail.trimStart()
  const week = namedCalendarWeek(tail, today)
  const monthPattern = /^(?:d[oe]\s+m[eê]s\s+passado|d(?:esse|este)\s+m[eê]s)\b/i
  const monthInTail = tail.match(monthPattern)?.[0]
  const month = monthInTail || last.text.replace(/^dia\s+\d{1,2}\s+/i, '').match(monthPattern)?.[0]
  const qualifierEnd = last.end + rawTail.length - tail.length + (week?.matched.length || monthInTail?.length || 0)
  if (mentioned.some(date => date.kind === 'period' && (date.start < last.end || date.end > qualifierEnd))) return undefined
  const resolved = dates.map(date => {
    if (week) return weekdayInCalendarWeek(date.text, week.anchor)
    const full = month && /^dia\s+\d{1,2}$/i.test(date.text) ? findDate(`${date.text} ${month}`, today) : date
    return full?.kind === 'date' ? full.date : undefined
  })
  if (resolved.some(day => !day || day > today)) {
    return 'Quais datas já ocorridas você quer consultar? Informe dia e mês de cada uma.'
  }
  const days = [...new Set(resolved)]
  const suffix = (week ? tail.slice(week.matched.length) : tail.replace(monthPattern, '')).replace(/\b(?:separadamente|em\s+cada\s+dia)\b/i, '')
  const queryPrefix = prefix.replace(/\b(?:no|na|em|de)\s*$/i, '').trimEnd()
  const readings = days.map(date => answerConversation(state, `${queryPrefix} em ${date} ${suffix}`.trim(), { today }))
  if (readings.some((r, i) => r?.kind !== 'query' || r.focus.lastQueryPlan?.period.from !== days[i]
    || r.focus.lastQueryPlan?.period.to !== days[i])) return 'O que você quer consultar nesses dias? Diga o tipo de gasto ou receita e as datas.'
  const summaries = readings.map(r => r.focus.lastQuery)
  const separate = /\b(?:separadamente|em\s+cada\s+dia)\b/i.test(question)
  const metric = readings[0]?.focus.lastQueryPlan?.metric
  // Km, horas e viagens também somam: "quanto rodei ontem e hoje" ficava sem
  // o total, que só existia para dinheiro.
  const unit = metric === 'sum' || metric === 'net' ? summaries[0]?.unit : metric === 'count' ? 'count' : undefined
  const additive = days.length > 1 && !separate && unit && ['BRL', 'km', 'hours', 'liters', 'count'].includes(unit)
    && readings.every(r => r.focus.lastQueryPlan?.metric === metric && r.focus.lastQueryPlan?.group === 'none')
    && summaries.every(s => s?.unit === unit)
  const total = additive ? summaries.reduce((sum, s) => sum + s.total, 0) : undefined
  const viagens = readings[0]?.focus.lastQueryPlan?.field === 'trips'
  const totalTexto = total === undefined ? '' : metric === 'count' ? `${total} ${total === 1 ? 'lançamento' : 'lançamentos'}`
    : viagens ? `${total} ${total === 1 ? 'viagem' : 'viagens'}` : formatValue(total, unit as FactUnit)
  const summary = total === undefined ? '' : `\n\nTotal dos ${days.length === 2 ? 'dois' : days.length} dias: ${totalTexto}.`
  return readings.map(r => r.reply).join('\n\n') + summary
}

const PAIRED_PAYMENT = /^quanto\s+(?:eu\s+)?(entrou|caiu|recebi|ganhei|faturei|saiu|paguei|gastei)\b/
const PAIRED_WORK = /^quant(?:o\s+(?:eu\s+)?rodei|[ao]s\s+(?:corridas?|viagens?|km|horas?))\b/
const PAIRED_PROFIT = /^qual\s+(?:foi\s+)?(?:o\s+)?(?:meu\s+)?lucro\b/
const RIDE_APP_NAME = String.raw`(?:uber|99|in\s*drive[r]?)`
const PAIRED_APP_SCOPE = String.raw`(?:n[ao]|d[ao]|pel[ao]|via)\s+${RIDE_APP_NAME}`
const PAIRED_APP_RECEIPT = new RegExp(String.raw`^quanto\s+(?:(?:o|a)\s+)?${RIDE_APP_NAME}\s+(?:me\s+)?(?:pagou|repassou|entrou|rendeu)\b`)
const PAIRED_APP_PART = new RegExp(String.raw`^${PAIRED_APP_SCOPE}\b`)
const PAIRED_APP_IN_TEXT = new RegExp(String.raw`\b(?:n[ao]|d[ao]|pel[ao]|via)\s+(${RIDE_APP_NAME})\b`)
const PAIRED_DAY = String.raw`(?:hoje|ontem|anteontem)`
const PAIRED_START = String.raw`(?:quant[oa]s?|qual|(?:(?:o|a|os|as)\s+)?(?:receitas?|despesas?|gastos?|lucro|corridas?|viagens?|km|horas?)|${PAIRED_DAY}\s+quanto|${PAIRED_APP_SCOPE})\b`
const PAIRED_SEPARATOR = new RegExp(String.raw`(?:[;,?]\s*(?:e\s+)?|\s+e\s+)(?=${PAIRED_START})|\s+(?=quanto\s+(?:entrou|saiu|caiu|recebi|ganhei|faturei|gastei|paguei)\b)`)
const PAIRED_DAY_ONLY = new RegExp(String.raw`^(${PAIRED_DAY})\s+quanto$`)
const PAIRED_QUESTION_INVERTED = new RegExp(String.raw`^(${PAIRED_DAY})\s+(entrou|caiu|recebi|ganhei|faturei|saiu|gastei|paguei)\s+quanto$`)
const PAIRED_PAYMENT_DATE_ONLY = new RegExp(String.raw`^quanto\s+(?:(?:eu)\s+)?(?:entrou|caiu|recebi|ganhei|faturei)\s+${PAIRED_DAY}$`)
const PAIRED_STATEMENT = /(?:[,;.]|\be\b|\bmas\b)\s*(?:eu\s+)?(?:recebi|ganhei|gastei|paguei|entrou|saiu|rodei|trabalhei|abasteci|fiz)\s+(?:r\$\s*)?\d/

function historySubquestion(part: string): string {
  const inverted = part.match(PAIRED_QUESTION_INVERTED)
  if (inverted) return `quanto ${inverted[2]} ${inverted[1]}`
  const noun = part.match(/^(?:(?:o|a|os|as)\s+)?(lucro|corridas?|viagens?|km|horas?)\s+de\s+(.+)$/)
  if (noun) {
    const [, metric, date] = noun
    return `${metric === 'lucro' ? 'qual foi o lucro' : metric === 'km' ? 'quantos km' : `quantas ${metric}`} ${date}`
  }
  return (perguntaNominal(part) || part).replace(/\?+$/, '')
}

function partWithPeriod(text: string, today: string) {
  let period = parsePeriod(text, today)?.period
  // "Dia 20" sem mês só resolve aqui quando designa um dia passado inequívoco.
  if (!period && /\bdia\s+\d{1,2}\b/.test(text)) {
    const dates = findAllDates(text, today)
    const [day] = dates
    if (dates.length !== 1 || day.kind !== 'date' || day.date > today) return { text, period, uncertain: true }
    text = `${text.slice(0, day.start).replace(/\b(?:no|em)\s*$/, '').trim()} em ${day.date} ${text.slice(day.end)}`.trim()
    period = parsePeriod(text, today)?.period
  }
  return { text, period, uncertain: period?.future === true }
}

function answerPairedHistory(state: AppState, question: string, today: string): { reply: string; focus?: ConversationFocus } | undefined {
  const clean = normalizeQuery(question).replace(/[.!?]+$/, '')
  if (/\bproposta\b/.test(clean)) return undefined
  const parts = clean.split(PAIRED_SEPARATOR)
  if (parts.length !== 2) return undefined
  const [first, second] = parts.map(p => historySubquestion(p.trim()))
  const payment = first.match(PAIRED_PAYMENT)?.[1]
  const dayOnly = second.match(PAIRED_DAY_ONLY)?.[1]
  const app = first.match(PAIRED_APP_IN_TEXT)?.[1]
  const followApp = app && payment && /^(?:ganhei|recebi|entrou|caiu|faturei)$/.test(payment) && PAIRED_APP_PART.test(second)
    && parsePeriod(first, today) && parsePeriod(second, today)
  const repeated = payment && (dayOnly || (payment === second.match(PAIRED_PAYMENT)?.[1] && PAIRED_PAYMENT_DATE_ONLY.test(second)))
  const secondQuestion = followApp ? `quanto ${payment} ${second}`
    : dayOnly && payment ? `quanto ${payment} ${dayOnly}` : second
  const completed = repeated && app && !PAIRED_APP_IN_TEXT.test(secondQuestion) ? `${secondQuestion} da ${app}` : secondQuestion
  const queries = [first, completed]
  if (!queries.every(text => PAIRED_PAYMENT.test(text) || PAIRED_WORK.test(text) || PAIRED_PROFIT.test(text) || PAIRED_APP_RECEIPT.test(text))) return undefined
  if (PAIRED_STATEMENT.test(normalizeNumberWords(clean).text)) return undefined
  const subjects = queries.map(text => partWithPeriod(text, today))
  const shared = subjects.find(part => part.period)?.period
  if (!shared || subjects.some(part => part.uncertain)) return undefined
  const readings = subjects.map(({ text, period }) => {
    const date = period || shared
    const subquestion = `${period ? text : `${text} ${date.label}`}?`
    const appReply = compareRideApps(state, subquestion, today)
    if (appReply) return { reply: appReply, focus: undefined }
    const answer = answerConversation(state, subquestion, { today })
    const plan = answer?.kind === 'query' ? answer.focus.lastQueryPlan : undefined
    if (plan?.period.from !== date.from || plan.period.to !== date.to) return undefined
    const verb = text.match(PAIRED_PAYMENT)?.[1]
    if (verb || PAIRED_APP_RECEIPT.test(text)) {
      const direction = /^(?:saiu|paguei|gastei)$/.test(verb ?? '') ? 'expense' : 'income'
      if (plan.source !== 'transactions' || plan.filter.txType?.length !== 1 || plan.filter.txType[0] !== direction) return undefined
    }
    if (PAIRED_WORK.test(text) && plan.source !== 'work') return undefined
    if (PAIRED_PROFIT.test(text) && plan.metric !== 'net') return undefined
    return answer
  })
  if (readings.some(r => !r)) return undefined
  return { reply: readings.map(r => r.reply).join('\n\n'), focus: readings[1].focus || readings[0].focus }
}

/**
 * A resposta local de uma pergunta solta, como no turno sem registro: a
 * consulta toma a frente só no que o roteador antigo não expressa, e responde
 * quando ele não sabe. Antes, sem resposta do roteador, "gastei 50, quanto
 * sobrou esse mês?" respondia só "se você confirmar, saem R$ 50".
 */
function respostaLocal(
  state: AppState, pergunta: string, today: string, usaConsulta: boolean, message = pergunta,
): { text: string; focus?: ConversationFocus } | null {
  const groupedDays = answerListedDays(state, pergunta, today)
  if (groupedDays) return { text: groupedDays }
  const conv = usaConsulta ? answerConversation(state, pergunta, { today }) : null
  if (conv?.kind === 'clarify') return { text: conv.reply, focus: conv.focus }
  if (conv?.kind === 'explain' && conv.focus.last === 'vehicle') return { text: conv.reply, focus: conv.focus }
  const consulta = conv?.kind === 'query' ? conv : null
  if (consulta?.beyondLegacy) return { text: consulta.reply, focus: consulta.focus }
  const r = askAssistant(state, pergunta, { today, message })
  // CUIDADO: `askAssistant` tem parser próprio e, quando acha uma ação, monta
  // "Entendi isso… / Confirmar?". Isso é uma PROPOSTA, não a resposta de uma
  // pergunta — usá-la aqui mostrava a proposta na tela sem nenhum botão para
  // confirmar. A pergunta segue em aberto e vai para quem sabe respondê-la.
  if (r.handled !== false && !r.actions?.length && !/entendi isso/i.test(r.text)) return { text: r.text, focus: consulta?.focus }
  return consulta ? { text: consulta.reply, focus: consulta.focus } : null
}

function withPendingAnswer(
  input: OrchestratorInput, output: OrchestratorOutput, today: string,
  read: (state: AppState) => string | undefined,
): OrchestratorOutput {
  if (output.response.mode !== 'answer' || !input.pending?.length) return output
  const copy = planAssistantActions(input.state, input.pending, { date: today, time: nowPaymentTime() }).projected
  const preview = read(copy)
  const reply = preview && preview !== read(input.state)
    ? `${output.response.reply}\n\nA proposta anterior aguarda confirmação e ficou fora desta consulta.`
    : output.response.reply
  return { ...output, keepPending: true, response: { ...output.response, reply } }
}

function pendingWorkAnswer(message: string, pending: OrchestratorInput['pending']): string | undefined {
  const text = normalizeName(message).replace(/[?!.]+$/, '').trim()
  const match = text.match(/^(?:e\s+)?(?:quantos?|quantas?)\s+(kms?|quilometros?|h|hrs?|horas?|viagens?|corridas?)\s+(?:(?:d[ao]|n[ao]|pel[ao])\s+(uber|99|noventa\s+e\s+nove|in\s*driver?)\s+)?(?:(?:deu|da|tem|ficou|ficaram|constam|estao|colocou|entram)\s+)?(?:na|da|nessa|nesta|a|essa|esta)\s+proposta$/)
  if (!match) return undefined
  if (!pending?.length) return 'Você não tem uma proposta aguardando confirmação.'
  const [, measure, platform] = match
  const field = /^h/.test(measure) ? 'hours' : /^(?:km|quil)/.test(measure) ? 'km' : 'trips'
  if (platform) {
    const label = field === 'km' ? 'a distância' : field === 'hours' ? 'a duração' : 'a quantidade de viagens'
    return `A proposta guarda ${label} da jornada inteira. Para detalhar por app, preciso dessa medida separada por plataforma.`
  }
  const values = pending.flatMap(({ action }) => action.kind === 'work' ? [action[field]]
    : field === 'hours' && action.kind === 'edit-work-hours' ? [action.hours] : []).filter(Number.isFinite)
  const total = values.reduce((sum, value) => sum + value, 0)
  const detail = field === 'km' ? `${fmtNum(total)} km` : field === 'hours' ? fmtHours(total) : `${fmtNum(total)} ${total === 1 ? 'viagem' : 'viagens'}`
  const missing = field === 'km' ? 'Nenhuma distância foi informada' : field === 'hours' ? 'Nenhuma duração foi informada' : 'Nenhuma quantidade de viagens foi informada'
  return values.length ? `Na proposta, você informou ${detail}.` : `${missing} na proposta.`
}

async function previewPendingQuery(input: OrchestratorInput, today: string): Promise<OrchestratorOutput | undefined> {
  if (input.pendingClarification || input.draft) return undefined
  const answer = (reply: string, focus = input.focus): OrchestratorOutput => ({ draft: null, keepPending: true, focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply } })
  if (isDriver(input.state.settings) && /\bproposta\b/i.test(input.message)) {
    const direct = pendingWorkAnswer(input.message, input.pending)
    if (direct) return answer(direct)
    const parts = input.message.trim().split(/(?:[?;,.]\s*(?:e\s+)?|\s+e\s+)(?=(?:quant[oa]s?|qual|quais)\b)/i)
    if (parts.length === 2) {
      const answers = parts.map(part => pendingWorkAnswer(part, input.pending))
      if (answers.every(Boolean)) return answer(answers.join('\n\n'))
      const workIndex = answers.findIndex(Boolean)
      if (workIndex >= 0) {
        const historyIndex = 1 - workIndex
        const history = parts[historyIndex]
        if (looksLikeDataQuestion(history) && !/\bproposta\b/i.test(history)) {
          const turn = await orchestrate({ ...input, message: history, remoteEnabled: false })
          if (turn.response.mode === 'answer' && !turn.response.actions.length) {
            answers[historyIndex] = turn.response.reply
            return answer(answers.join('\n\n'), turn.focus)
          }
        }
      }
    }
  }
  if (!input.pending?.length) return undefined
  const text = normalizeName(input.message).replace(/[?!.]+$/, '').trim()
  const now = { date: today, time: nowPaymentTime() }
  if (/^(?:(?:e\s+)?isso\s+(?:deu|da|ficou|sobra)\s+quanto\s+liquid[oa]|quanto\s+(?:sobrou|sobra)\s+so\s+(?:nessa|nesta|na)\s+proposta)$/.test(text)) {
    if (!input.pending.every(({ action }) => ['income', 'expense', 'fuel', 'maintenance', 'work', 'odometer'].includes(action.kind))) {
      return answer('Para calcular o resultado da proposta, diga quais receitas e despesas quer considerar.')
    }
    const projection = planAssistantActions(input.state, input.pending, now)
    if (!projection.ok) return answer('Revise os dados da proposta para eu calcular o resultado.')
    const existing = new Set(input.state.transactions.map(tx => tx.id))
    const additions = projection.projected.transactions.filter(tx => !existing.has(tx.id) && (tx.type === 'income' || tx.type === 'expense'))
    if (!additions.length) return answer('Essa proposta ainda não tem receitas nem despesas para calcular o resultado.')
    const cents = additions.reduce((sum, tx) => sum + (tx.type === 'income' ? 1 : -1) * Math.round(tx.amount * 100), 0)
    return answer(`Resultado só da proposta: ${fmtBRL(cents / 100)}. Ela segue aguardando confirmação.`)
  }
  const confirm = String.raw`se\s+(?:eu\s+)?confirmar(?:\s+(?:isso|essa\s+proposta|o\s+registro|os\s+registros))?`
  const includesProposal = String.raw`(?:${confirm}|(?:contando|incluindo|considerando)\s+(?:ess[ea]\s+(?:proposta|despesa|receita|registro)|o\s+pendente|a\s+proposta|ess[ea])(?:\s+tambem)?|com\s+a\s+proposta)`
  const before = text.match(new RegExp(String.raw`^${includesProposal},?\s+(.+)$`))
  const after = text.match(new RegExp(String.raw`^(.+?),?\s+${includesProposal}$`))
  const selectedAmount = text.match(/^(.+?),?\s+(?:contando|incluindo|considerando)\s+(?:os?\s+)?(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?:\s+reais?)?\s+da\s+proposta$/)
  const queryPlan = isFocusFresh(input.focus) && input.focus?.last === 'query' ? input.focus.lastQueryPlan : undefined
  const reuse = !!queryPlan && new RegExp(String.raw`^(?:e\s+)?${confirm}$`).test(text)
  const explicit = reuse ? undefined : before?.[1] || after?.[1] || selectedAmount?.[1]
  if (!explicit && !reuse) return undefined
  const question = explicit?.replace(/^(e\s+)?(?:qto|qnto|qt)\s+/, '$1quanto ')
    .replace(/^como\s+(?:fica|ficaria)\s+o\s+(lucro|resultado|saldo)\b/, 'qual o $1')
    .replace(/^((?:e\s+)?quantas)\s+h(?:rs?)?\b/, '$1 horas')
    .replace(/\bgastaria\b/g, 'gastei').replace(/\breceberia\b/g, 'recebi').replace(/\bganharia\b/g, 'ganhei')
  if (!reuse && (!question || !/^(?:e\s+)?(?:quant[oa]s?|qual|quais)\b/.test(question) || !looksLikeDataQuestion(question))) return undefined
  const scopedQuestion = question && /\b(?:gastei|ganhei|recebi)\b/.test(question) && !parsePeriod(question, today)
    ? `${question} hoje` : question
  const read = (state: AppState) => reuse ? composeAnswer(runQuery(state, queryPlan!, today))
    : compareRideApps(state, scopedQuestion!, today) || respostaLocal(state, scopedQuestion!, today, true)?.text
  const real = read(input.state)
  if (!real) return undefined
  const amount = selectedAmount ? parseMoney(selectedAmount[2]) : undefined
  const pending = amount === undefined ? input.pending : input.pending.filter(({ action }) =>
    ('amount' in action && action.amount === amount) || ('cost' in action && action.cost === amount))
  if (amount !== undefined && pending.length !== 1) {
    if (!pending.length) return answer(`Não encontrei um item de ${fmtBRL(amount)} na proposta. Diga qual item quer incluir.`)
    return answer(`Há mais de um item de ${fmtBRL(amount)} na proposta. Diga qual deles quer incluir.`)
  }
  const { projected, ok } = planAssistantActions(input.state, pending, now)
  const preview = ok ? read(projected) : undefined
  const scope = amount === undefined ? 'a proposta da tela' : `só o item de ${fmtBRL(amount)} da proposta`
  const reply = preview
    ? `Se você confirmar ${scope}:\n${semDadoReal(preview)}\n\nA proposta segue aguardando confirmação.`
    : 'A proposta mudou ou tem um dado pendente. Revise o que está na tela para eu conseguir simular a confirmação.'
  return answer(reply)
}

/**
 * "Fiz 280 hoje, foi bom?" chega como uma cláusula só, com registro e pergunta:
 * perguntada inteira ao roteador, a frase virava proposta e a pergunta sumia. Ao
 * lado de um registro, a pergunta é o último pedaço curto depois da vírgula.
 */
function caudaDaPergunta(texto: string, candidates: AssistantCandidateAction[]): string {
  if (!candidates.length) return texto
  const pedacos = texto.split(/[,;.!]\s+/).map(p => p.trim()).filter(Boolean)
  const cauda = pedacos[pedacos.length - 1]
  if (pedacos.length < 2 || !cauda || /\d/.test(cauda) || cauda.split(/\s+/).length > 6) return texto
  return cauda
}

/**
 * "Quanto falta?" logo depois de um depósito ou de um pagamento de fatura não
 * diz de quê: o assunto é o registro ao lado. Sem ele, a pergunta sumia.
 */
function perguntaComAssunto(pergunta: string, candidates: AssistantCandidateAction[]): string {
  const pagador = pergunta.match(PAYER_PRONOUN_QUERY)
  if (pagador && !/\b(?:eles|elas)\b/i.test(pergunta)) {
    const origins = [...new Set(candidates.flatMap(({ action }) => action.kind === 'income' && action.origin ? [action.origin] : []))]
    if (origins.length === 1) return `${pagador[1]}${origins[0]}${pagador[2]}`
  }
  if (!/^\s*(?:e\s+)?quanto\s+(?:ainda\s+)?(?:falta|faltam|resta|restam)\s*\??\s*$/i.test(pergunta)) return pergunta
  const alvos = candidates.map(c => c.action as any).filter(a => a.kind === 'goal-deposit' || a.kind === 'card-payment')
  if (alvos.length !== 1) return pergunta
  const [a] = alvos
  if (a.kind === 'goal-deposit' && a.name) return `quanto falta para a meta ${a.name}`
  if (a.kind === 'card-payment' && a.cardName) {
    const referencia = a.referenceMonth ? ` de ${MESES_PT_BR[Number(a.referenceMonth.slice(5)) - 1]} de ${a.referenceMonth.slice(0, 4)}` : ''
    return `quanto falta pagar da fatura do ${a.cardName}${referencia}`
  }
  return pergunta
}

/** Número que depende de confirmação não leva o selo de dado real. */
const semDadoReal = (texto: string) => texto
  .replace(/\s*\((?:dados?\s+reais?|dado\s+real)\b[^)]*\)/gi, '')
  .replace(/\s*[—-]\s*(?:dados?\s+reais?|dado\s+real)\b/gi, '')

/**
 * Resposta HIPOTÉTICA para uma pergunta que o motor local não sabe responder
 * sozinho, mas que depende do que está sendo proposto.
 *
 * Sempre deixa explícito que o número depende da confirmação — nada foi gravado.
 */
function hypotheticalSummary(candidates: AssistantCandidateAction[]): string | null {
  const sum = (kind: string, field = 'amount') =>
    candidates.filter(c => c.action.kind === kind).reduce((a, c) => a + ((c.action as any)[field] || 0), 0)
  const inc = sum('income')
  const exp = sum('expense')
  const sav = sum('saving')
  if (!inc && !exp && !sav) return null

  const parts: string[] = []
  if (inc) parts.push(`entram ${fmtBRL(inc)}`)
  if (exp) parts.push(`saem ${fmtBRL(exp)}`)
  if (sav) parts.push(`${fmtBRL(sav)} vão para a reserva`)

  const diff = inc - exp
  const tail = inc && exp
    ? ` — diferença de ${fmtBRL(Math.abs(diff))}${diff < 0 ? ', negativa' : ''}.`
    : '.'
  return `Se você confirmar, ${parts.join(', ')}${tail} Nada foi registrado ainda.`
}

const escapaRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * "E mais 20 de pão", "mais 15 no café", "e 30 de uber" com a proposta na
 * tela: a frase com o verbo dos itens pendentes ("gastei 20 de pão"), para o
 * fluxo normal ler e a resposta juntar à proposta. Só quando todos os itens de
 * dinheiro pendentes são do mesmo tipo e a frase não tem verbo.
 */
/**
 * "Fiz 300 hj, 250 na uber e 50 na 99", "gastei 100 hj, 60 de gasolina e 40
 * de almoço": o valor genérico É a soma das partes, e o dia contava em dobro.
 * Só quando a soma fecha no centavo, no mesmo dia, com pelo menos duas partes
 * nomeadas — qualquer diferença é outra conversa, e o app não escolhe.
 */
function semSomaDasPartes(candidates: AssistantCandidateAction[], today: string): { candidates: AssistantCandidateAction[]; nota?: string } {
  const dia = (a: any) => a.date || today
  const valor = (a: any) => typeof a.amount === 'number' ? a.amount : NaN
  const sentido = (a: ParsedAction) => a.kind === 'income' ? 'in' : a.kind === 'expense' || a.kind === 'fuel' ? 'out' : undefined
  const generico = (a: any) => (a.kind === 'income' || a.kind === 'expense') && !a.origin && (!a.description || /^total$/i.test(a.description))
  let out = candidates
  const notas: string[] = []
  for (const total of candidates.filter(c => generico(c.action))) {
    const lado = sentido(total.action)
    const partes = out.filter(c => c !== total && sentido(c.action) === lado && !generico(c.action) && dia(c.action) === dia(total.action))
    const soma = Math.round(partes.reduce((a, c) => a + valor(c.action), 0) * 100) / 100
    if (partes.length >= 2 && Math.abs(soma - valor(total.action)) < 0.005) {
      out = out.filter(c => c !== total)
      notas.push(`Os ${fmtBRL(valor(total.action))} são a soma das partes, então registrei só as partes.`)
    }
  }
  return { candidates: out, ...(notas.length ? { nota: notas.join(' ') } : {}) }
}

function acrescimoAProposta(pending: AssistantCandidateAction[], mensagem: string): string | null {
  const relato = mensagem.trim().match(/^(?:e\s+(?:tamb[ée]m\s+)?|tamb[ée]m\s+)(.+)$/i)?.[1]
  if (relato && looksPast(relato) && !looksLikeQuestion(relato)) return relato
  // "Foram 14 corridas" com a receita do dia na tela e sem jornada: a medida
  // completa o dia. Substituía a proposta e a receita sumia.
  const medida = mensagem.trim().match(/^(?:(?:e|foram|foi|s[ãa]o)\s+)?(\d+(?:[.,]\d+)?)\s*(km|quil[oô]metros?|h|hrs?|horas?|corridas?|viagens?)\s*[.!]*$/i)
  if (medida && !pending.some(p => p.action.kind === 'work') && pending.some(p => p.action.kind === 'income' && (p.action as any).category === 'corridas')) {
    const u = medida[2].toLowerCase()
    return /^(?:km|quil)/.test(u) ? `rodei ${medida[1]} km` : /^(?:corrida|viage)/.test(u) ? `fiz ${medida[1]} corridas` : `trabalhei ${medida[1]} horas`
  }
  const tipos = new Set(pending.map(p => p.action.kind).filter(k => k === 'expense' || k === 'income'))
  if (tipos.size !== 1) return null
  // "Ontem fiz 280" → "E HOJE 320" (ou "e 320 ontem"): outro dia, mesmo tipo
  // de dinheiro. Substituía a proposta e perguntava se era ganho ou gasto.
  const dia = mensagem.trim().match(/^(?:e\s+)(?:(hoje|hj|ontem|anteontem)\s+(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)|(?:mais\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais|real)?\s+(hoje|hj|ontem|anteontem))\s*(?:reais|real)?\s*[?.!]*$/i)
  if (dia) {
    const corrida = pending.some(p => p.action.kind === 'income' && (p.action as any).category === 'corridas')
    const verbo = tipos.has('income') ? (corrida ? 'fiz' : 'recebi') : 'gastei'
    return `${dia[1] || dia[4]} ${verbo} ${dia[2] || dia[3]}`
  }
  const m = mensagem.trim().match(/^(?:e\s+)?(?:mais\s+|tamb[ée]m\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais|real|conto|contos|pila)?\s+(de|do|da|dos|das|no|na|nos|nas|em|com|pro|pra|para)\s+([a-zà-úç][a-zà-úç0-9\s]{1,40}?)\s*[?.!]*$/i)
  if (!m) return null
  // "E 15 de ÁGUA" com uma receita na tela: o item diz que foi gasto. Herdar o
  // verbo da proposta fazia a água virar corrida. O inverso vale para "e 50 de
  // gorjeta" depois de um gasto.
  const item = m[3].trim()
  const deGasto = (() => { const c = guessCategory(item, 'expense'); return !!c && c !== 'outros-out' && !guessCategory(item, 'income') })()
  const deGanho = /^(?:gorjeta|b[oô]nus|promo[cç][aã]o|corridas?|uber|99|sal[aá]rio|aluguel|freela)\b/i.test(item)
  const verbo = tipos.has('income') ? (deGasto ? 'gastei' : 'recebi') : (deGanho ? 'recebi' : 'gastei')
  return `${verbo} ${m[1]} ${m[2]} ${m[3]}`
}

/**
 * "E a internet?", "e a viagem?": a elipse nomeia algo CADASTRADO — uma conta
 * fixa ou uma meta ativa. Devolve a pergunta que o roteador responde sobre ela;
 * `null` quando o nome não é de nada cadastrado (aí é a elipse de compra).
 */
function elipseDeCadastro(state: AppState, mensagem: string): string | null {
  const m = normalizeName(mensagem).match(/^e\s+(?:o|a|os|as|do|da|no|na)?\s*([a-z][a-z0-9\s]{2,30}?)\s*\??$/)
  if (!m) return null
  const nome = m[1].trim()
  if ((state.recurring || []).some(r => r.kind !== 'income' && r.active !== false && normalizeName(r.name) === nome)) return `quanto e a ${nome}`
  if ((state.goals || []).some(g => !g.done && normalizeName(g.name) === nome)) return `quanto falta para a meta ${nome}`
  return null
}

/** Cartões ativos citados pelo nome num texto já normalizado. */
function cartoesNaFrase(state: AppState, t: string): string[] {
  return (state.cards || []).filter(c => !c.archived).map(c => c.name)
    .filter(n => { const k = normalizeName(n); return k.length >= 2 && new RegExp(`\\b${escapaRegex(k)}\\b`).test(t) })
}

/**
 * "E o Inter?" logo depois de uma pergunta de fatura de outro cartão: a mesma
 * pergunta com o cartão trocado. Só quando a elipse é EXATAMENTE um cartão.
 */
function faturaComOutroCartao(state: AppState, focus: ConversationFocus | undefined, mensagem: string): string | null {
  if (!isFocusFresh(focus) || !focus?.lastInvoiceQuestion) return null
  const m = normalizeName(mensagem).match(/^e\s+(?:o|a|no|na|do|da)?\s*(?:cartao\s+(?:d[oa]\s+)?)?(.+?)\s*\??$/)
  if (!m) return null
  const novo = cartoesNaFrase(state, m[1])
  if (novo.length !== 1 || normalizeName(novo[0]) !== m[1].trim()) return null
  const anterior = normalizeName(focus.lastInvoiceQuestion)
  const velho = cartoesNaFrase(state, anterior)
  if (velho.length !== 1 || normalizeName(velho[0]) === normalizeName(novo[0])) return null
  return anterior.replace(new RegExp(`\\b${escapaRegex(normalizeName(velho[0]))}\\b`), normalizeName(novo[0]))
}

function proposalText(candidates: AssistantCandidateAction[], state: AppState): string {
  const lines = candidates.map(c => {
    const d = (c.action as any).date
    const at = 'time' in c.action ? c.action.time : undefined
    const due = c.action.kind === 'card-purchase' ? c.action.firstDueDate : undefined
    const suffix = (d ? ` · ${dateLabel(d)}` : '') + (at ? ` às ${at}` : '') + (due ? ` · 1º vencimento: ${brDate(due)}` : '')
    return `• ${describeAction(c.action, id => state.categories?.find(x => x.id === id)?.name)}${suffix}`
  })
  return `Entendi isso:\n\n${lines.join('\n')}`
}

function proposeClarifiedActions(
  state: AppState, actions: ParsedAction[], today: string, previous: AssistantCandidateAction[] = [],
): OrchestratorOutput {
  return preparedActionResponse(state, prepareInvoicePayments(state, actions.map(a => candidate(a, 'local')), today), previous)
}

function exactMoneyAnswer(message: string, signed = false): number | undefined {
  const normalized = normalizeName(normalizeNumberWords(message).text).replace(/[.!?]+$/g, '').trim()
  const match = normalized.match(/^(?:(?:foi|e|deu)\s+)?(?:r\$\s*)?([-−]\s*|menos\s+)?(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?:\s+(?:reais?|contos?))?(?:\s+(?:exat[oa]s?|certinh[oa]s?))?$/i)
  if (!match || (match[1] && !signed)) return undefined
  return (match[1] ? -1 : 1) * parseMoney(match[2])
}

const MONEY_NOTATION = /(?<![\p{L}\p{N}.,])(?:\d+(?:[.,]\d+)*e[+−-]?\d+|\d+(?:\.\d{3})*,\d{3,})(?![\p{L}\p{N}]|[.,]\d)/giu
const MONEY_NOTATION_CONTEXT = /(?:\br\$\s*|\b(?:recebi|recebeu|ganhei|ganhou|gastei|pagou|paguei|comprei|abasteci|fiz|faturei|caiu|entrou|saiu|deu|depositei|depositou|repassou|custou|valor|foi|era|saldo)\s+(?:(?:[ée]|de|tipo|uns|umas|cerca\s+de)\s+)?[−+-]?\s*)$/i
const MONEY_NOTATION_TAIL = /^\s*(?:reais?|contos?|pila|d[aeo]\s+(?:corridas?|combust[íi]vel|gasolina|etanol|diesel|aluguel|sal[áa]rio|ped[áa]gio|estacionamento|repasse))\b/i
const MEASURE_AFTER_VALUE = /^\s*(?:%|(?:km|quil[oô]metros?|metros?|litros?|ml|horas?|h|min|minutos?|corridas?|viagens?)\b)/i
const EXTRA_SIGNED_CASH = /\b(?:saiu|sa[ií]ram|pagou|depositou|repassou|transferiu)\s+(?:r\$\s*)?[−-]\s*\d/i
const SIGNED_RIDE_APP = new RegExp(String.raw`\b${RIDE_APP_NAME}\s+(?:r\$\s*)?[−-]\s*\d`, 'i')
const MONEY_NEXT_RIDE_FACT = new RegExp(String.raw`\s+e\s+(?=(?:(?:a|o)\s+)?${RIDE_APP_NAME}\s+(?:me\s+)?(?:pagou|depositou|repassou)\b|(?:r\$\s*)?\d[\d.,]*\s+de\s+(?:gasolina|etanol|diesel|gnv|combust[íi]vel)\b)`, 'i')
const MONEY_RIDE_PAYMENT = new RegExp(String.raw`^(?:(?:a|o)\s+)?(${RIDE_APP_NAME})\s+(?:me\s+)?(?:pagou|depositou|repassou)\s+((?:r\$\s*)?\d[\d.,]*(?:\s+reais?)?)$`, 'i')

function inspectMoneyNotation(text: string, driver: boolean, expectsAmount = false) {
  const notes: string[] = []
  const tokens: string[] = []
  for (const token of text.matchAll(MONEY_NOTATION)) {
    const after = text.slice(token.index + token[0].length)
    if (MEASURE_AFTER_VALUE.test(after) && !/e/i.test(token[0])) continue
    if (!expectsAmount && !MONEY_NOTATION_CONTEXT.test(text.slice(0, token.index).slice(-80)) && !MONEY_NOTATION_TAIL.test(after)) continue
    tokens.push(token[0])
    notes.push(`Qual foi o valor de “${token[0]}” em reais e centavos?`)
  }
  if (EXTRA_SIGNED_CASH.test(text) || (driver && SIGNED_RIDE_APP.test(text))) {
    notes.push('O valor informado é negativo. Diga se foi taxa, devolução ou outro débito e qual foi o valor.')
  }
  return { notes, tokens }
}

async function readAfterMoneyClarification(input: OrchestratorInput, message: string, today: string): Promise<OrchestratorOutput> {
  const result = await orchestrate({ ...input, message, pending: undefined, pendingClarification: undefined, remoteEnabled: false })
  if (!input.pending?.length) return result
  if (result.response.mode === 'propose_actions') {
    return proposeDatedActions({ ...input, message, pendingClarification: undefined }, result.response.actions.map(c => c.action), buildCapabilities(input.state), today)
  }
  return { ...result, keepPending: true }
}

async function prepareUnsafeMoney(input: OrchestratorInput, today: string): Promise<OrchestratorOutput | undefined> {
  const driver = isDriver(input.state.settings)
  const awaiting = input.pendingClarification?.field === 'money-notation' ? input.pendingClarification : undefined
  const { notes } = inspectMoneyNotation(input.message, driver, !!awaiting)
  if (!notes.length) {
    if (!awaiting) return undefined
    const amount = exactMoneyAnswer(input.message, true)
    if (!Number.isFinite(amount)) return undefined
    if (awaiting.moneyNotation && amount >= 0) {
      const { statement, token } = awaiting.moneyNotation
      return readAfterMoneyClarification(input, statement.replace(token, fmtNum(amount, 2)), today)
    }
    const question = 'Diga o que aconteceu com esse valor em uma frase completa, com o valor e a origem.'
    return keepPendingClarification(input, { ...awaiting, question })
  }
  const parts = segment(input.message, today).flatMap(part => driver ? part.text.split(MONEY_NEXT_RIDE_FACT) : [part.text])
  const dates = findAllDates(input.message, today)
  const [sharedDate] = dates
  const remaining: string[] = []
  let inheritedDate: string | undefined
  let moneyNotation: AssistantClarification['moneyNotation']
  for (const part of parts) {
    const text = part.trim().replace(/[,;]+$/, '').replace(/\s+(?:e|mas)$/i, '').trim()
    const ownDay = sharedDate?.kind === 'date' && dates.length === 1 ? findDate(part, today) : undefined
    const temporalText = inheritedDate && !ownDay ? `em ${inheritedDate} ` : ''
    if (ownDay?.kind === 'date') inheritedDate = ownDay.date
    const inspection = inspectMoneyNotation(text, driver, !!awaiting)
    if (inspection.notes.length) {
      if (notes.length === 1 && inspection.tokens.length === 1) moneyNotation = { statement: temporalText + text, token: inspection.tokens[0] }
      continue
    }
    if (!text) continue
    const payment = driver ? text.match(MONEY_RIDE_PAYMENT) : undefined
    const statement = payment ? `recebi ${payment[2]} da ${readRidePayoutApp(payment[1])}` : text
    remaining.push(temporalText + statement)
  }
  const question = [...new Set(notes)].join('\n\n')
  const clarification = input.pendingClarification || { field: 'money-notation', question, moneyNotation }
  if (remaining.length < parts.length && remaining.length) {
    const result = await readAfterMoneyClarification(input, remaining.join('; '), today)
    const reply = `${question}\n\n${result.response.reply}`
    if (result.response.mode === 'clarify') return { ...result, response: { ...result.response, reply } }
    return { ...result, keepPending: true, response: { ...result.response, mode: 'clarify', reply, clarification } }
  }
  return { draft: input.draft || null, focus: input.focus, keepPending: true,
    response: { version: ASSISTANT_CONTRACT_VERSION, engine: 'local', mode: 'clarify', actions: [], unresolved: [],
      reply: input.pendingClarification ? `${question}\n\n${clarification.question}` : question, clarification } }
}

async function preparePaymentWithRemainder(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  if (!/\b(?:falt(?:a|am|ando)|restante|resto|outr[oa]s)\b/i.test(input.message) || looksLikeQuestion(input.message)) return undefined
  for (const join of input.message.matchAll(/[,;]\s*(?:e\s+)?|\s+(?:e|mas)\s+/gi)) {
    const paidText = input.message.slice(0, join.index).trim()
    if (looksNegated(paidText) || (!looksPast(paidText) && !/\b(?:me\s+deu|pagou)\b/i.test(paidText))) continue
    const rest = normalizeName(normalizeNumberWords(input.message.slice(join.index + join[0].length)).text).trim().replace(/[.!]+$/, '')
    const stillDue = rest.match(/^(?:so\s+)?(?:ainda\s+)?(?:faltam?|ficou\s+faltando)\s+(?:(?:(?:ele|ela)\s+)?(?:completar|pagar|receber)\s+(?:mais\s+)?)?((?:r\$\s*)?\d[\d.,]*(?:\s+(?:reais?|contos?))?)(?:\s+(?:de|para|pra)\s+([\p{L} ]{1,60}))?$/u)
    const dueLater = rest.match(/^(?:os\s+outros\s+((?:r\$\s*)?\d[\d.,]*(?:\s+(?:reais?|contos?))?)|o\s+(?:restante|resto))\s+(?:so\s+)?(.+)$/)
    if (stillDue?.[2] && looksPast(stillDue[2])) continue
    if (!stillDue && (!dueLater || !/^(?:amanha|depois\s+de\s+amanha|no\s+mes\s+que\s+vem|na\s+semana\s+que\s+vem|em\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))$/.test(dueLater[2]))) continue
    const outstanding = exactMoneyAnswer(stillDue?.[1] || dueLater?.[1] || '')
    const paid = await orchestrate({ ...input, message: paidText, pending: undefined, remoteEnabled: false })
    if (paid.response.mode !== 'propose_actions' || paid.response.actions.length !== 1 || paid.response.unresolved.length) continue
    const action = paid.response.actions[0].action
    if (action.kind !== 'income' && action.kind !== 'expense') continue
    const result = input.pending?.length ? proposeDatedActions(input, [action], caps, today) : paid
    const remaining = outstanding === undefined ? 'O restante segue pendente.' : `O valor de ${fmtBRL(outstanding)} segue pendente.`
    return { ...result, response: { ...result.response, reply: `${remaining}\n\n${result.response.reply}` } }
  }
  return undefined
}

function answerFinancialEvent(input: OrchestratorInput, question: AssistantClarification, caps: AssistantCapabilities, today: string): OrchestratorOutput | null {
  const event = question.financialEvent
  const said = normalizeName(normalizeNumberWords(input.message).text).replace(/[.!]+$/, '').trim()
  const answer = { version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const, actions: [] as [], unresolved: [] }
  const denied: OrchestratorOutput = {
    draft: null, keepPending: true,
    response: { ...answer, mode: 'answer', reply: 'Certo, não vou registrar esse valor como realizado.' },
  }
  const prompt = (clarification: AssistantClarification): OrchestratorOutput => ({
    draft: null, keepPending: true,
    response: { ...answer, mode: 'clarify', clarification, reply: clarification.question },
  })
  const verbs = event === 'pix' ? 'mandei|enviei|transferi|paguei' : event === 'ride'
    ? 'recebi|me\\s+pagaram|foi\\s+paga|(?:terminei|conclui)\\s+e\\s+recebi' : 'devolvi|estornei'
  const eventVerb = new RegExp(String.raw`^(?:(?:eu|ja)\s+){0,2}(?:${verbs})\b`)
  const correction = said.match(/^(?:nao|n)(?:\s+(?:foi|era)\s+(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?)?\s*,\s*(?:(?:na verdade|na real)\s*,?\s+)?(.+)$/)
  const deniesAmount = /^(?:nao|n)\s+(?:foi|era)\s+(?:r\$\s*)?\d/.test(said)
  if (/^(?:nao|nem|n)\b/.test(said) && !eventVerb.test(correction?.[1] || '')) return deniesAmount ? prompt(question) : denied

  const statement = correction && eventVerb.test(correction[1]) ? correction[1] : said
  const yes = statement.match(/^(?:sim|isso mesmo)(?:\s*,\s*|\s+|$)/)
  const head = yes ? statement.slice(yes[0].length).replace(/^mas\s+/, '') : statement
  if (yes && new RegExp(String.raw`^(?:(?:ainda|eu)\s+)?(?:nao|n|nem)\s+(?:${verbs})\b`).test(head)) return denied
  const verb = head.match(eventVerb)
  if (!yes && !verb) {
    // Um FATO novo não é resposta: "gastei 50 no mercado" depois de "você
    // devolveu os R$ 100?" repetia a pergunta e a despesa se perdia. A
    // pergunta antiga cai e a mensagem segue o caminho normal.
    if (!input.message.trimEnd().endsWith('?')
      && analyzeMessage(input.message, { driver: caps.isDriver, today }).clauses.some(c => c.actions.length > 0)) return null
    const query = looksLikeDataQuestion(input.message) ? respostaLocal(input.state, input.message, today, true) : null
    return query ? { draft: null, keepPending: true, focus: query.focus || input.focus,
      response: { ...answer, mode: 'clarify', clarification: question, reply: `${query.text}\n\n${question.question}` } }
      : prompt(question)
  }
  if (input.message.trimEnd().endsWith('?')) return prompt(question)
  const detail = head.slice(verb?.[0].length ?? 0).trim().replace(event === 'pix' ? /^(?:o\s+)?pix\b\s*/ : /^a\s+corrida\b\s*/, '')
  const dates = findAllDates(detail, today)
  const [date] = dates
  if (dates.length > 1) return prompt({ ...question, question: 'Qual foi a data exata em que aconteceu? Diga também o valor.' })
  const magnitude = (date ? `${detail.slice(0, date.start)} ${detail.slice(date.end)}` : detail)
    .trim().replace(/^(?:de|por|so|apenas)\s+/, '').replace(/[,\s]+$/, '').trim()
  const original = question.options?.find(o => normalizeName(o.label) === 'sim')?.actions?.find(a => a.kind === 'expense' || a.kind === 'income')
  const amount = magnitude ? exactMoneyAnswer(magnitude) : original?.amount
  if (!(amount > 0)) return prompt({ ...question, question: `Qual foi o valor exato? ${question.question}` })

  const actions = financialEventActions(event, amount, caps.isDriver)
  if (date && date.kind !== 'date') return prompt({
    field: date.kind === 'ambiguous' ? 'date-choice' : 'date',
    question: date.kind === 'future' ? `A data ${date.label} ainda não chegou. Em que dia aconteceu?`
      : 'question' in date ? date.question : 'Em qual dia desse período aconteceu?',
    options: date.kind === 'ambiguous' ? date.options : undefined,
    dateWindow: date.kind === 'period' ? { from: date.from, to: date.to } : undefined,
    pendingActions: actions,
  })
  const validated: ParsedAction[] = []
  for (const action of date?.kind === 'date' ? withDate(actions, date.date) : actions) {
    const check = validateAction(action, caps, today)
    if (isValidationFailure(check)) return prompt({ ...question, question: `Confira o valor informado. ${question.question}` })
    validated.push(check.action)
  }
  return proposeClarifiedActions(input.state, validated, today, input.pending)
}

function prepareWorkHoursEdit(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const request = readWorkHoursEdit(input.message, today)
  const pending = input.pendingClarification?.workHoursEdit
  if (!request && !pending) return undefined

  const edit = request?.edit || pending
  const dates = request?.dates
  const date = dates?.length === 1 ? dates[0] : request ? undefined : dateInAnswer(input.message, today)
  const response = { version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const, actions: [] as [], unresolved: [] }
  const context = { draft: null, keepPending: true, focus: input.focus }
  const answer = (reply: string): OrchestratorOutput => ({ ...context, response: { ...response, mode: 'answer', reply } })

  if (!request && !date) {
    const text = normalizeName(input.message).replace(/[.!]+$/, '')
    if (/^(?:cancela|cancelar|esquece|deixa pra la)$/.test(text)) return answer('Descartei o pedido de correção das horas.')
    if (looksLikeQuestion(input.message) || looksPast(input.message)) return undefined
  }
  if (!Number.isFinite(edit.hours) || edit.hours < 0 || edit.hours > 24
    || (edit.previousHours !== undefined && !Number.isFinite(edit.previousHours))) {
    return answer('Informe o total correto de horas do dia, de 0 a 24.')
  }

  const askForDate = (question: string): OrchestratorOutput => ({
    ...context, response: { ...response, mode: 'clarify', reply: question,
      clarification: { field: 'work-hours-date', question, workHoursEdit: edit } },
  })
  if (!input.state.workSessions.length) return answer('Você ainda não tem uma jornada salva para corrigir.')
  if (request?.invalidDate) return askForDate('Não consegui ler essa data. Informe uma data válida para a jornada que quer corrigir.')
  if (date?.kind !== 'date') {
    return askForDate(date?.kind === 'future'
      ? 'Essa data ainda não chegou. De que dia é a jornada que você quer corrigir?'
      : 'De que dia é a jornada que você quer corrigir?')
  }

  const sessions = input.state.workSessions.filter(w => w.date === date.date)
  const [session] = sessions
  const day = brDate(date.date)
  if (!session) return askForDate(`Não encontrei uma jornada salva em ${day}. De que dia é o registro que quer corrigir?`)
  if (sessions.length !== 1 || !session.id || !Number.isFinite(session.hours)
    || input.state.workSessions.filter(w => w.id === session.id).length !== 1) {
    return answer(`Encontrei registros de jornada que precisam ser conferidos em ${day}. Preciso de uma única jornada para corrigir as horas do dia.`)
  }

  const storedHours = Math.round(session.hours * 1000) / 1000
  if (edit.previousHours !== undefined && edit.previousHours !== storedHours) {
    return answer(`Em ${day} tenho ${fmtNum(storedHours, 3)}h salvas. Confira o dia e o valor que quer corrigir.`)
  }
  if (edit.hours === storedHours) return answer(`A jornada de ${day} já está com ${fmtNum(storedHours, 3)}h.`)

  const previous = input.pending || []
  if (previous.some(p => p.action.kind === 'work' && (p.action.date || today) === date.date)) {
    return answer(`Há um registro de trabalho de ${day} aguardando confirmação. Resolva esse registro antes de corrigir as horas salvas.`)
  }
  const others = previous.filter(p => p.action.kind !== 'edit-work-hours' || p.action.workId !== session.id)
  if (others.length >= MAX_ACTIONS_PER_BATCH) return answer('Confirme ou retire algum item da proposta antes de acrescentar a correção das horas.')

  const action: ParsedAction = { kind: 'edit-work-hours', workId: session.id, date: date.date, hours: edit.hours, expectedHours: storedHours }
  const result = proposeDatedActions({ ...input, pending: others }, [action], caps, today)
  return others.length !== previous.length ? { ...result, correctedPending: result.response.actions } : result
}

async function prepareShiftWithAppHours(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  const shift = readShiftWithAppHours(input.message, today)
  if (!shift) return undefined

  const { minutes, sum, rest, date, when } = shift
  if (!shift.confirmHours) {
    const duration = `${Math.floor(minutes / 60)}h${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}`
    if (rest) {
      const payoutMessage = [when, rest.replace(/[.!]+$/, '') + `, trabalhei ${minutes / 60} horas`].filter(Boolean).join(' ')
      const payout = preparePartialRidePayout({ ...input, message: payoutMessage }, caps, today)
      if (payout) return payout
    }
    return orchestrate({ ...input, message: [when, `trabalhei ${duration}`, rest && `e ${rest}`].filter(Boolean).join(' '), remoteEnabled: false })
  }

  const question = `Você informou ${fmtNum(minutes / 60)}h de jornada. As horas por app somam ${fmtNum(sum / 60)}h. Quantas horas você trabalhou no total?`
  const work = (hours: number): ParsedAction => ({ kind: 'work', hours, date })
  const options: AssistantClarification['options'] = [
    { label: `${fmtNum(minutes / 60)}h no total`, value: String(minutes), actions: [work(minutes / 60)] },
    ...(sum <= 1440 ? [{ label: `${fmtNum(sum / 60)}h somando os apps`, value: String(sum), actions: [work(sum / 60)] }] : []),
  ]
  const clarification = { field: 'shift-app-hours', question, options, pendingActions: [work(minutes / 60)] }
  if (!rest) return keepPendingClarification(input, clarification)
  const result = await orchestrate({ ...input, message: [when, rest].filter(Boolean).join(' '), remoteEnabled: false })
  if (result.response.mode !== 'propose_actions') return { ...result, response: { ...result.response,
    reply: [result.response.reply, question].filter(Boolean).join('\n\n') } }
  const reply = result.response.reply.replace(/\n\nConfirmar\?$/, '') + '\n\n' + question
  return { ...result, keepPending: true, response: { ...result.response, mode: 'clarify', reply, clarification } }
}

function readDriverShiftActions(text: string): ParsedAction[] | undefined {
  const shift = parseDriverDay(text, { driver: true })
  if (shift) return shift.invalidWork || shift.unclassifiedAmounts.length ? undefined : shift.actions
  const pairs = normalizeName(normalizeNumberWords(text).text).trim().replace(/^nos\s+apps\s+/, '')
    .replace(/^foram\s+/, 'deu ').replace(/^(?:fechei|faturei)\s+/, '')
  return parseTypedPairs(pairs, { driver: true }) || undefined
}

function payoutLinkChoice(prior: Extract<ParsedAction, { kind: 'income' }>, receipt: Extract<ParsedAction, { kind: 'income' }>,
  referencedAmount?: number): AssistantClarification {
  const lead = referencedAmount !== undefined
    ? `Na jornada anterior você informou ${fmtBRL(prior.amount)} da ${prior.description}. No repasse você citou ${fmtBRL(referencedAmount)} como referência.`
    : `Você citou ${fmtBRL(prior.amount)} da ${prior.description} na jornada anterior e um repasse de ${fmtBRL(receipt.amount)} da ${receipt.description}.`
  return {
    field: 'ride-settlement-match',
    question: `${lead} Foi o mesmo repasse ou um repasse separado?`,
    options: [
      { label: 'É o mesmo', value: 'same', actions: [receipt] },
      { label: 'Era outro repasse', value: 'separate', actions: [prior, receipt] },
    ],
  }
}

function prepareRideSettlement(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (!hasRideSettlementVerb(input.message) || input.message.includes('?')) return undefined
  const dates = findAllDates(input.message, today)
  if (dates.length > 2 || dates.some(date => date.kind !== 'date')) return undefined
  const [day, paidOn] = dates.filter(date => date.kind === 'date')
  const separator = /(?:[,;.]?\s+e|[,;.])\s*$/
  let paymentDay = day
  let payoutText = day ? input.message.slice(0, day.start) + ' ' + input.message.slice(day.end) : input.message
  let shiftText: string | undefined
  let shiftDay = day
  if (day && paidOn) {
    const head = input.message.slice(0, day.start)
    const between = input.message.slice(day.end, paidOn.start)
    const tail = input.message.slice(paidOn.end)
    const serviceDate = /\s+de\s*$/i
    if (!head.trim() && day.date !== paidOn.date && separator.test(between)) {
      const firstClause = between.replace(separator, '').trim()
      if (readRideSettlement(firstClause)) {
        payoutText = firstClause
        shiftText = tail
        shiftDay = paidOn
      } else {
        shiftText = firstClause
        paymentDay = paidOn
        payoutText = tail
      }
    } else if (serviceDate.test(head) && !between.trim() && /^[.!\s]*$/.test(tail)) {
      paymentDay = paidOn
      payoutText = head.replace(serviceDate, '')
    } else if (!head.trim() && serviceDate.test(between) && /^[.!\s]*$/.test(tail)) {
      payoutText = between.replace(serviceDate, '')
    } else if (!head.trim() && /^[.!\s]*$/.test(tail)) {
      const split = [...between.matchAll(/(?:[.;,]\s+(?:e\s+)?|\s+e\s+)/gi)]
        .find(part => readRideSettlement(between.slice(part.index + part[0].length).trim()))
      if (!split) return undefined
      shiftText = between.slice(0, split.index)
      payoutText = between.slice(split.index + split[0].length)
      paymentDay = paidOn
    } else return undefined
  }
  const payout = readRideSettlement(payoutText.trim().replace(/^[,;]\s*/, ''))
  if (!payout) return undefined
  const { amount, payer, origin, reference, coveredTotal, pendingRest, explicitPayment } = payout
  const conflict = origin && payer !== origin
  const definiteReference = coveredTotal !== undefined || pendingRest || reference === 'os' || reference === 'o'
  const explicitlySeparate = reference === 'mais' && coveredTotal === undefined && !pendingRest
  if (!paidOn && !conflict && !definiteReference && !explicitPayment) return undefined

  const todayReceipt = (description: string): Extract<ParsedAction, { kind: 'income' }> => ({
    kind: 'income', category: 'corridas', description, amount, date: paymentDay?.date,
  })
  if (isValidationFailure(validateAction(todayReceipt(payer), caps, today))) return undefined

  let shiftActions: ParsedAction[] = []
  let matchingAction: Extract<ParsedAction, { kind: 'income' }> | undefined
  let mismatchedReference: number | undefined
  if (shiftText) {
    const shift = readDriverShiftActions(shiftText)
    if (!shift) return undefined
    const datedShift = withDate(shift, shiftDay.date)
    const shiftWithoutTotal = semSomaDasPartes(datedShift.map(action => candidate(action, 'local')), today).candidates.map(item => item.action)
    const reportedOnApp = shiftWithoutTotal.filter((action): action is Extract<ParsedAction, { kind: 'income' }> =>
      action.kind === 'income' && action.description === (origin || payer))
    const referenceAmount = coveredTotal ?? amount
    const matching = reportedOnApp.filter(action =>
      pendingRest && coveredTotal === undefined ? action.amount > amount : action.amount === referenceAmount)
    if (!explicitlySeparate && matching.length > 1) return undefined
    matchingAction = !explicitlySeparate && matching.length === 1 ? matching[0] : undefined
    if (definiteReference && !matching.length && reportedOnApp.length) {
      if (reportedOnApp.length !== 1) return undefined
      matchingAction = reportedOnApp[0]
      mismatchedReference = referenceAmount
    }
    shiftActions = shiftWithoutTotal.filter(action => action !== matchingAction)
    if (shiftActions.some(action => isValidationFailure(validateAction(action, caps, today)))) return undefined
  }

  if (coveredTotal !== undefined && amount > coveredTotal) {
    const question = `Você informou que caíram ${fmtBRL(amount)} de um total de ${fmtBRL(coveredTotal)}. Quanto realmente entrou pela ${payer}?`
    const result = proposeDatedActions(input, shiftActions, caps, today)
    return { ...result, keepPending: true, response: { ...result.response, mode: 'clarify',
      reply: [result.response.actions.length ? proposalText(result.response.actions, input.state) : '', question].filter(Boolean).join('\n\n'),
      clarification: { field: 'ride-payout-inclusion', question, pendingActions: [{ ...todayReceipt(payer), amount: coveredTotal }] },
    } }
  }
  const priorToResolve = (mismatchedReference !== undefined || (!definiteReference && !explicitlySeparate)) ? matchingAction : undefined
  if ((input.pending?.length || 0) + shiftActions.length + 1 + (priorToResolve ? 1 : 0) > MAX_ACTIONS_PER_BATCH) {
    return { draft: null, keepPending: true, focus: input.focus, response: {
      version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
      reply: 'Confirme ou retire alguns itens da proposta antes de acrescentar a jornada e o repasse.',
    } }
  }
  const receipt = todayReceipt(payer)
  if (!conflict && !priorToResolve) return proposeDatedActions(input, [...shiftActions, receipt], caps, today)

  const result = proposeDatedActions(input, shiftActions, caps, today)
  const actions = result.response.actions
  const clarification: AssistantClarification = conflict ? {
    field: 'ride-settlement-app',
    question: `Você citou ${payer} e ${origin} para o repasse de ${fmtBRL(amount)}. Qual plataforma pagou esse valor?`,
    options: [payer, origin].map(app => ({ label: app, value: normalizeName(app), actions: [todayReceipt(app)] })),
    pendingActions: priorToResolve ? [priorToResolve] : undefined,
  } : payoutLinkChoice(priorToResolve, receipt, mismatchedReference)
  return { ...result, keepPending: true, focus: input.focus,
    response: { ...result.response, mode: 'clarify',
      reply: actions.length ? `${proposalText(actions, input.state)}\n\n${clarification.question}` : clarification.question,
      clarification,
    } }
}

function keepActionsAwaitingClarification(input: OrchestratorInput, result: OrchestratorOutput,
  clarification: AssistantClarification): OrchestratorOutput {
  const reply = [result.response.actions.length ? proposalText(result.response.actions, input.state) : '', clarification.question].filter(Boolean).join('\n\n')
  return { ...result, keepPending: true, focus: input.focus,
    response: { ...result.response, mode: 'clarify', reply, clarification } }
}

function prepareRoadReport(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const report = readRoadReport(input.message, today)
  if (!report) return undefined
  const { income, cost, alternative, payer, futureLabel } = report
  if (!income) return proposeDatedActions(input, [cost], caps, today)
  if (payer === 'driver' && !alternative) return proposeDatedActions(input, [income, cost], caps, today)

  const result = proposeDatedActions(input, [income], caps, today)
  const label = cost.category === 'pedagio' ? 'pedágio' : 'estacionamento'
  if (alternative) {
    return keepActionsAwaitingClarification(input, result, {
      field: 'amount-choice',
      question: `Qual foi o valor do ${label}: ${fmtBRL(cost.amount)} ou ${fmtBRL(alternative.amount)}?`,
      options: [cost, alternative].map(action => ({ label: fmtBRL(action.amount), value: String(action.amount), actions: [action] })),
    })
  }
  if (payer === 'unknown') {
    return keepActionsAwaitingClarification(input, result, {
      field: 'financial-event', question: `Você pagou os ${fmtBRL(cost.amount)} de ${label} ou outra pessoa pagou?`,
      options: [{ label: 'Eu paguei', value: 'paguei', actions: [cost] },
        { label: 'Outra pessoa pagou', value: 'passageiro pagou', reply: 'Mantive só a receita. A proposta aguarda confirmação.' }],
    })
  }
  const note = payer === 'passenger' ? `O passageiro pagou o ${label}.`
    : `O ${label} de ${fmtBRL(cost.amount)} ainda está para ser pago${futureLabel ? ` ${futureLabel}` : ''}.`
  return { ...result, response: { ...result.response, reply: `${note}\n\n${result.response.reply}` } }
}

function nightShiftClarification(actions: ParsedAction[], window: { from: string; to: string }, options: AssistantClarification['options']): AssistantClarification {
  const item = describeAction(actions[0])
  return { field: 'night-shift-date', dateWindow: window, pendingActions: actions, options,
    question: `${item}. Em qual dia aconteceu? A jornada passou por ${brDate(window.from)} e ${brDate(window.to)}.` }
}

function proposeNightShiftItems(input: OrchestratorInput, caps: AssistantCapabilities, today: string, actions: ParsedAction[],
  window: { from: string; to: string }, labels = [brDate(window.from), brDate(window.to)]): OrchestratorOutput {
  const ready = actions.filter(a => 'date' in a && a.date)
  const awaiting = actions.filter(a => !('date' in a) || !a.date)
  if (!awaiting.length) return proposeDatedActions(input, ready, caps, today)
  const dates = [window.from, window.to]
  const options = labels.map((label, i) => ({ label, value: dates[i] }))
  const clarification = nightShiftClarification(awaiting, window, options)
  return ready.length ? keepActionsAwaitingClarification(input, proposeDatedActions(input, ready, caps, today), clarification)
    : keepPendingClarification(input, clarification)
}

async function prepareDatedShiftWork(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  if (looksLikeQuestion(input.message) || looksNegated(input.message)) return undefined
  const shift = readDatedShiftWork(input.message, today)
  if (!shift) return undefined
  if (shift.kind === 'future') return { draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, engine: 'local', mode: 'answer', actions: [], unresolved: [],
      reply: 'Quando a jornada terminar, me diga o horário real de saída para eu preparar as horas trabalhadas.' } }
  if (shift.kind !== 'work' || (shift.window.to === today && today === todayISO() && shift.endTime && shift.endTime > nowTime())) {
    return keepPendingClarification(input, { field: 'shift-hours', question: 'Confira os dias e os horários de início e fim da jornada.' })
  }
  const work: ParsedAction[] = shift.minutes.map(({ total, date }) => ({ kind: 'work', hours: total / 60, date }))
  if (!shift.rest) return proposeDatedActions(input, work, caps, today)
  const message = shift.rest.replace(/^(\d+(?:[.,]\d+)?)\s*km\s+no\s+turno$/i, 'rodei $1 km')
  const extra = await orchestrate({ ...input, message, pending: undefined, remoteEnabled: false })
  if (extra.response.mode !== 'propose_actions' || !extra.response.actions.length || extra.response.unresolved.length) {
    return keepActionsAwaitingClarification(input, proposeDatedActions(input, work, caps, today), {
      field: 'shift-companion', question: 'Qual foi o valor ou a medida adicional e em que dia aconteceu?',
    })
  }
  const companions = extra.response.actions.map(c => c.action)
  if (shift.window.from === shift.window.to) {
    const dated = companions.map(action => 'date' in action && action.date ? action : withDate([action], shift.window.from)[0])
    return proposeDatedActions(input, [...work, ...dated], caps, today)
  }
  return proposeNightShiftItems(input, caps, today, [...work, ...companions], shift.window)
}

const PAST_NIGHT_RECEIPT = /\s+(?:mas|e)\s+(?:o\s+)?pix\s+caiu\s+(hoje|ontem|anteontem)[.!]*$/i

async function prepareNightShift(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  if (looksLikeQuestion(input.message) || looksNegated(input.message)) return undefined
  const shift = readNightShiftRange(input.message, today)
  if (!shift) return undefined
  if (!shift.window) return keepPendingClarification(input, { field: 'night-shift-range', question: 'Quais foram as duas datas da jornada? Diga dia e mês e o que aconteceu em cada dia.' })
  const receipt = shift.rest.match(PAST_NIGHT_RECEIPT)
  const report = receipt ? shift.rest.slice(0, receipt.index).trimEnd() : shift.rest
  const parsed = await orchestrate({ ...input, message: report, pending: undefined, remoteEnabled: false })
  if (parsed.response.mode !== 'propose_actions' || parsed.response.unresolved.length || !parsed.response.actions.length) {
    return keepPendingClarification(input, { field: 'night-shift-details', question: 'Quais valores ou medidas aconteceram na jornada? Informe o dia de cada item.' })
  }
  const actions = parsed.response.actions.map(c => c.action)
  const exactReceipt = receipt && actions.filter(a => a.kind === 'income').length === 1 ? findDate(receipt[1], today) : undefined
  const addressed = actions.map(action => {
    if (action.kind === 'income' && exactReceipt?.kind === 'date') {
      const statedReceipt = /\b(?:recebi|entrou|caiu|depositou|repassou)\b/i.test(report)
      const conflicting = statedReceipt && action.date && action.date !== exactReceipt.date
      return { ...action, date: conflicting ? undefined : exactReceipt.date }
    }
    return shift.afterMidnight && (!('date' in action) || !action.date) ? { ...action, date: shift.window.to } : action
  })
  return proposeNightShiftItems(input, caps, today, addressed, shift.window, shift.labels)
}

function continueNightShift(input: OrchestratorInput, caps: AssistantCapabilities, today: string, clarification: AssistantClarification): OrchestratorOutput | undefined {
  const said = normalizeName(input.message).replace(/[.!?]+$/, '').trim().replace(/^(?:foi|caiu|entrou|paguei)\s+/, '')
  if (/^(?:cancela(?:r)?|esquece|deixa\s+pra\s+la)$/.test(said)) return undefined
  const window = clarification.dateWindow
  const iso = clarification.options?.find(option => normalizeName(option.label) === normalizeName(weekdayChoiceWord(said)))?.value
    ?? resolveDayInWindow(said, window, today)
  if (!iso) return keepPendingClarification(input, clarification)
  const [item, ...remaining] = clarification.pendingActions
  const result = proposeDatedActions(input, withDate([item], iso), caps, today)
  return remaining.length ? keepActionsAwaitingClarification(input, result, nightShiftClarification(remaining, window, clarification.options)) : result
}

function readDatedPayoutActivities(text: string, today: string): ParsedAction[] | undefined {
  if (!/\b(?:abasteci|paguei|gastei|rodei|trabalhei)\b/i.test(text)) return undefined
  const { actions, clauses } = analyzeMessage(text, { driver: true, today })
  if (!clauses.every(clause => clause.handled && !clause.ambiguity && !clause.dateAmbiguity && !clause.approximateAmount && !clause.temporal)) return undefined
  if (actions.length && actions.every(action => (action.kind === 'fuel' || action.kind === 'expense' || action.kind === 'work') && action.date)) return actions
}

function readDatedPayoutCompanion(text: string, today: string): ParsedAction | undefined {
  const { value, platform, dates, receiptDay } = readPayoutReceiptAnswer(text, today)
  if (dates.length !== 1 || receiptDay?.kind !== 'date') return undefined
  if (value > 0 && platform) return { kind: 'income', amount: value, category: 'corridas', description: platform, date: receiptDay.date }
  const actions = readDatedPayoutActivities(text, today)
  if (actions?.length === 1) return actions[0]
}

function prepareRideReceiptAcrossDates(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (!/\b(?:pagou|pagaram|repassou|depositou|transferiu|recebi|caiu|ca[ií]ram|entrou|entraram|veio|vieram)\b/i.test(input.message)
    || input.message.includes('?')) return undefined
  const dates = findAllDates(input.message, today)
  if (dates.length > 2) {
    for (const split of input.message.matchAll(/[,.;]\s+(?:e\s+)?/gi)) {
      const extra = readDatedPayoutCompanion(input.message.slice(split.index + split[0].length), today)
      if (!extra) continue
      const baseMessage = input.message.slice(0, split.index)
      if (findAllDates(baseMessage, today).length !== 2) continue
      const base = prepareRideReceiptAcrossDates({ ...input, message: baseMessage, pending: undefined }, caps, today)?.response
      if (base?.mode !== 'propose_actions' && base?.mode !== 'clarify') continue
      const actions = base.actions.map(item => item.action)
      const clarification = base.mode === 'clarify' ? base.clarification : undefined
      const linked = [...actions, ...(clarification?.pendingActions || [])]
      if (extra.kind === 'income' && linked.some(action => action.kind === 'income' && action.description === extra.description)) continue
      const result = proposeDatedActions(input, [...actions, extra], caps, today)
      return clarification ? keepActionsAwaitingClarification(input, result, clarification) : result
    }
    return undefined
  }
  const [earnedOn, paidOn] = dates
  if (dates.length !== 2 || earnedOn.kind !== 'date' || paidOn.kind !== 'date' || earnedOn.date >= paidOn.date) return undefined
  const head = input.message.slice(0, earnedOn.start).trim()
  const between = input.message.slice(earnedOn.end, paidOn.start)
  const tail = input.message.slice(paidOn.end).trim()
  const income = (platform: string, amount: number, date: string): Extract<ParsedAction, { kind: 'income' }> =>
    ({ kind: 'income', amount, description: platform, category: 'corridas', date })

  if (head && /^[.!]*$/.test(tail)) {
    const original = readRideSettlement(head)
    const portion = readPayoutDatePart(between)
    if (original && !original.origin && !original.coveredTotal && portion) {
      const paid = income(original.payer, original.amount, earnedOn.date)
      const other = income(original.payer, portion, paidOn.date)
      const options: AssistantClarification['options'] = [
        ...(portion <= original.amount ? [{ label: 'Já estão incluídos', value: 'included', actions: [paid] }] : []),
        { label: 'Recebi em outro repasse', value: 'separate', actions: [paid, other] },
        { label: 'Ainda não recebi essa parte', value: 'unpaid', actions: [paid] },
      ]
      const question = `Os ${fmtBRL(portion)} são parte dos ${fmtBRL(original.amount)} que caíram em ${brDate(earnedOn.date)}, entraram em outro repasse ou ainda não caíram?`
      return keepPendingClarification(input, { field: 'ride-payout-date-part', question, options, pendingActions: [paid, other] })
    }
  }

  // A segunda data pertence ao recebimento quando vem junto de seu verbo.
  const receiptStarts = /^(?:(?:s[oó]|apenas|somente)\s+)?(?:recebi|caiu|ca[ií]ram|entrou|entraram|veio|vieram|(?:me\s+)?pagaram)\b/i.test(tail)
  const explicitSeparator = /(?:[,;.]\s*(?:e\s*)?|\s+e)\s*$/i.test(between)
  const receiptBeforeDate = /(?:[,;.]\s*|\s+e\s+)(?:e\s+)?(?:(?:s[oó]|apenas|somente)\s+)?(?:recebi|caiu|ca[ií]ram|entrou|entraram|veio|vieram|(?:me\s+)?pagaram)\b/i.test(between)
  if (!receiptStarts && !receiptBeforeDate && !explicitSeparator) return undefined
  const bridge = receiptStarts && !explicitSeparator ? ', ' : ' '
  const facts = readRideReportThenReceipt([head, between.trim()].filter(Boolean).join(' ') + bridge + tail)
  if (!facts) return undefined
  if (!facts.platform && facts.amount) {
    if (!/^(?:(?:foram|deu|deram|fiz|ganhei|faturei)\s+)?(?:r\$\s*)?\d/.test(facts.report)) return undefined
    const dayActions = readDriverShiftActions(facts.report)
    if (!dayActions) return undefined
    const dated = semSomaDasPartes(withDate(dayActions, earnedOn.date).map(action => candidate(action, 'local')), today)
      .candidates.map(item => item.action)
    if ((input.pending?.length || 0) + dated.length + 1 > MAX_ACTIONS_PER_BATCH) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Confirme ou retire alguns itens da proposta antes de acrescentar o fechamento e o repasse.' },
    }
    const prior = dated.filter((action): action is Extract<ParsedAction, { kind: 'income' }> => action.kind === 'income')
    if (prior.length < 2 || prior.some(action => !action.description || action.category !== 'corridas')
      || new Set(prior.map(action => action.description)).size !== prior.length
      || dated.some(action => isValidationFailure(validateAction(action, caps, today)))) return undefined
    const result = proposeDatedActions(input, dated.filter(action => action.kind !== 'income'), caps, today)
    const clarification: AssistantClarification = {
      field: 'ride-multi-source',
      question: `O repasse de ${fmtBRL(facts.amount)} veio de qual plataforma?`,
      pendingActions: prior,
      rideSettlementRelation: facts.relation,
      options: prior.map(action => ({ label: action.description, value: normalizeName(action.description),
        actions: [income(action.description, facts.amount, paidOn.date)] })),
    }
    return keepActionsAwaitingClarification(input, result, clarification)
  }
  if (!facts.platform || !(facts.total > 0)) return undefined
  const reported = income(facts.platform, facts.total, earnedOn.date)
  const received = income(facts.platform, facts.amount ?? facts.total, paidOn.date)
  if (facts.amount === undefined) {
    const question = `Dos ${fmtBRL(facts.total)} na ${facts.platform}, quanto você recebeu em ${brDate(paidOn.date)}?`
    return keepPendingClarification(input, { field: 'ride-payout-inclusion', question, pendingActions: [received],
      options: [{ label: 'Recebi tudo', value: 'all', actions: [received] }] })
  }
  if (facts.unpaid !== undefined && Math.round(facts.total * 100) !== Math.round(facts.amount * 100) + Math.round(facts.unpaid * 100)) {
    const question = `Você informou ${fmtBRL(facts.total)} de corridas, ${fmtBRL(facts.amount)} recebidos e ${fmtBRL(facts.unpaid)} em aberto. Quanto realmente caiu?`
    return keepPendingClarification(input, { field: 'ride-payout-inclusion', question, pendingActions: [{ ...received, amount: Math.max(facts.total, facts.amount) }] })
  }
  if (facts.relation === 'separate') return proposeDatedActions(input, [reported, received], caps, today)
  if (facts.relation === 'same' && facts.amount <= facts.total) return proposeDatedActions(input, [received], caps, today)
  return keepPendingClarification(input, payoutLinkChoice(reported, received))
}

function prepareShiftWithUnpaidPayout(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const payout = readShiftWithUnpaidPayout(input.message) || readShiftWithWalletBalance(input.message, today)
    || readShiftWithWalletWithdrawal(input.message, today) || readShiftWithDelayedPayout(input.message)
  if (!payout) return undefined
  const dates = findAllDates(payout.text, today)
  const [day] = dates
  if (dates.length > 1 || (day && day.kind !== 'date')) return undefined
  const text = day ? payout.text.slice(0, day.start) + ' ' + payout.text.slice(day.end) : payout.text
  const shift = readDriverShiftActions(text)
  if (!shift) return undefined
  const datedShift = day?.kind === 'date' ? withDate(shift, day.date) : shift
  const actions = semSomaDasPartes(datedShift.map(action => candidate(action, 'local')), today).candidates.map(item => item.action)
  const income = actions.filter((action): action is Extract<ParsedAction, { kind: 'income' }> => action.kind === 'income')
  if (income.length < 2 || income.some(action => !action.description)
    || new Set(income.map(action => action.description)).size !== income.length) return undefined
  if (actions.some(action => isValidationFailure(validateAction(action, caps, today)))) return undefined
  if ((input.pending?.length || 0) + actions.length > MAX_ACTIONS_PER_BATCH) return {
    draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
      reply: 'Confirme ou retire alguns itens da proposta antes de acrescentar o fechamento e o repasse.' },
  }

  const affected = payout.platform ? income.filter(action => action.description === payout.platform) : income
  const independent = actions.filter(action => !affected.some(item => item === action))
  const result = proposeDatedActions(input, independent, caps, today)
  if ('withdrawal' in payout) {
    return keepActionsAwaitingClarification(input, result, walletWithdrawalClarification(payout))
  }
  if ('allUnpaid' in payout && payout.allUnpaid) {
    const [item] = affected
    const note = item ? rideDebtNote({ platform: item.description, amount: item.amount }) : `Você informou que o repasse da ${payout.platform} ainda não caiu.`
    return { ...result, response: { ...result.response, reply: `${note}\n\n${result.response.reply}` } }
  }
  if (!affected.length) return { ...result, response: { ...result.response,
    reply: `${payout.platform} ainda deve ${fmtBRL(payout.amount)}.\n\n${result.response.reply}` } }

  const platforms = affected.map(action => action.description).join(' ou ')
  const question = `Os ${fmtBRL(payout.amount)} que ainda não caíram fazem parte dos valores informados (${platforms})? Informe em qual plataforma o valor está incluído ou diga “foi por fora”.`
  const options: AssistantClarification['options'] = affected.flatMap(item => {
    const remaining = (Math.round(item.amount * 100) - Math.round(payout.amount * 100)) / 100
    if (remaining < 0) return []
    return [{ label: `Incluído na ${item.description}`, value: normalizeName(item.description),
      actions: affected.flatMap(action => action !== item ? [action] : remaining > 0 ? [{ ...action, amount: remaining }] : []) }]
  })
  options.push({ label: 'Foi por fora', value: 'excluded', actions: affected })
  return { ...result, keepPending: true, focus: input.focus,
    response: { ...result.response, mode: 'clarify',
      reply: [result.response.actions.length ? proposalText(result.response.actions, input.state) : '', question].filter(Boolean).join('\n\n'),
      clarification: { field: 'ride-shift-payout', question, options, pendingActions: affected, rideShiftUnpaid: payout.amount } },
  }
}

function preparePartialRidePayout(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const payout = readPartialRidePayout(input.message)
  if (!payout) return undefined
  const { total, unpaid, inclusion, platform, companions, date } = payout
  const parsedDate = date && findDate(date, today)
  const previous = input.pending || []
  const actionsFromMessage = companions.flatMap(fact => {
    const text = fact.kind === 'fuel' && !/^(?:gastei|paguei|abasteci|botei|coloquei)\b/.test(fact.text) ? 'gastei ' + fact.text : fact.text
    const parsed = analyzeMessage(text, { driver: true, today })
    const day = fact.date && findDate(fact.date, today)
    if (fact.date && day?.kind !== 'date') return []
    return parsed.actions.filter(a => a.kind === fact.kind).map(a => day?.kind === 'date' ? { ...a, date: day.date } : a)
  })
  const validated = actionsFromMessage.map(a => validateAction(a, caps, today))
    .flatMap(check => check.ok ? [candidate(check.action, 'local')] : [])
  const additions = input.pendingClarification?.field === 'ride-payout-inclusion'
    ? validated.filter(next => !previous.some(old => JSON.stringify(next.action) === JSON.stringify(old.action))) : validated
  const received = (included: boolean): ParsedAction[] => {
    const amount = included ? (Math.round(total * 100) - Math.round(unpaid * 100)) / 100 : total
    return amount > 0 ? [{ kind: 'income', amount, category: 'corridas', description: platform,
      ...(parsedDate?.kind === 'date' ? { date: parsedDate.date } : {}) }] : []
  }
  const needsDate = !!date && parsedDate?.kind !== 'date'
  const issue = needsDate || validated.length !== companions.length
    ? 'Diga o dia exato e o valor das corridas que já recebeu. Se houve gasto com combustível, diga também o valor e a data desse gasto.'
    : payout.inconsistent || !(total > 0) || (unpaid !== undefined && !(payout.received === undefined ? unpaid > 0 : unpaid >= 0)) || (inclusion === true && unpaid > total)
      ? 'Os valores informados não fecham. Quanto das corridas já caiu na conta?'
      : undefined
  if (previous.length + additions.length + 1 > MAX_ACTIONS_PER_BATCH) return {
    draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
      reply: `Cada confirmação pode incluir até ${MAX_ACTIONS_PER_BATCH} itens. Confirme ou retire alguns da proposta e mande o relato do repasse de novo.` },
  }
  if (!issue && inclusion !== undefined) {
    const income = received(inclusion)
    if (income.length) return proposeDatedActions(input, [...income, ...additions.map(item => item.action)], caps, today)
    return preparedActionResponse(input.state, { actions: additions, clarification: undefined, notes: ['A receita fica fora da proposta até o pagamento cair.'] }, previous)
  }
  const question = issue || (unpaid === undefined ? `Dos ${fmtBRL(total)} de corridas, quanto já caiu na conta?`
    : `Os ${fmtBRL(unpaid)} que ainda não caíram estão incluídos nos ${fmtBRL(total)} das corridas?`)
  const options = issue || unpaid === undefined ? undefined : [
    ...(unpaid <= total ? [{ label: 'Sim, estão incluídos', value: 'included', actions: received(true),
      reply: unpaid === total ? 'A receita fica fora da proposta até o pagamento cair.' : undefined }] : []),
    { label: 'Não, são por fora', value: 'excluded', actions: received(false) },
  ]
  const actions = [...previous, ...proposalWarnings(input.state, additions, today, previous)]
  return {
    draft: null, keepPending: true, focus: input.focus, correctedPending: previous.length && additions.length ? actions : undefined,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions, unresolved: [],
      reply: actions.length ? `${proposalText(actions, input.state)}\n\n${question}` : question,
      clarification: { field: 'ride-payout-inclusion', question, options,
        pendingActions: !needsDate && total > 0 && (unpaid === undefined || !!issue) ? received(false) : undefined } },
  }
}

function statedAccountBalance(said: string): number | undefined {
  const statedBalance = said.match(/^(?:eu\s+)?(?:tenho|tinha|(?:estou|to|estava|tava|fiquei)\s+com)\s+(?:(?:so|apenas|somente)\s+)?(.+?)\s+na\s+(?:minha\s+)?conta$/)
    || said.match(/^(?:o\s+|meu\s+)?saldo(?:\s+d[ae]\s+conta)?\s+(?:e|era|foi|ficou\s+em)\s+(?:de\s+)?(.+?)(?:\s+na\s+(?:minha\s+)?conta)?$/)
  return exactMoneyAnswer(statedBalance?.[1] || '', true)
}

function prepareDriverBankReport(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (!/\bconta\b/i.test(input.message) || input.message.includes('?')) return undefined
  const text = normalizeName(normalizeNumberWords(input.message).text).trim().replace(/[.!]+$/, '')
  const pieces = text.split(/;\s*|,\s+(?=\S)|,(?=[\p{L}])|\s+e\s+(?=(?:veio|caiu|cairam|entrou|entraram|recebi)\b|(?:r\$\s*)?\d)/u)
  if (pieces.length !== 2) return undefined
  const [account, activity] = pieces
  const balance = /^(?:eu\s+)?(?:tenho|(?:estou|to)\s+com|(?:o\s+|meu\s+)?saldo(?:\s+d[ae]\s+conta)?\s+e)\b/.test(account)
    ? statedAccountBalance(account) : undefined
  if (balance !== undefined) {
    const { value, platform, receiptDay, dates } = readPayoutReceiptAnswer(activity, today)
    if (value > 0 && platform && dates.length === 1 && receiptDay.kind === 'date') {
      return proposeDatedActions(input, [
        { kind: 'income', amount: value, category: 'corridas', description: platform, date: receiptDay.date },
        { kind: 'balance', amount: balance },
      ], caps, today)
    }
    return undefined
  }

  const pix = exactMoneyAnswer(account.match(/^pix\s+na\s+(?:minha\s+)?conta\s+(?:deu|foi|ficou\s+em)\s+(.+)$/)?.[1] || '')
  const due = pix > 0 ? readRideDebt(activity) : undefined
  if (!due || due.tail) return undefined
  const question = `${due.platform} ainda deve ${fmtBRL(due.amount)}. Os ${fmtBRL(pix)} no Pix entraram de fato ou eram o saldo da conta? Se entraram, diga o valor e a origem do pagamento.`
  return keepPendingClarification(input, { field: 'driver-bank-pix', question, pendingActions: [{ kind: 'income', amount: pix }] })
}

const RECEIPT_ACTION = String.raw`(?:recebi|veio|caiu|cairam|entrou|entraram|(?:me\s+)?(?:pagou|repassou|depositou))`
const RECEIPT_APP_SUBJECT = new RegExp(String.raw`^(?:[ao]\s+)?(uber|99|in\s*drive[r]?)\s+(?=${RECEIPT_ACTION}\s+(?:(?:so|apenas|somente)\s+)?(?:r\$\s*)?\d)`)
const RECEIPT_VALUE_AFTER_VERB = new RegExp(String.raw`^(?:nao(?:\s+(?:e|era)\s+(?:o\s+)?saldo)?\s*,\s*)?(?:eu\s+)?${RECEIPT_ACTION}\s+(?:so\s+|apenas\s+|somente\s+)?(.+?)(?:\s+na\s+(?:minha\s+)?conta)?$`)

function readPayoutReceiptAnswer(message: string, today: string) {
  const receiptText = normalizeName(normalizeNumberWords(message).text).replace(/[.!?]+$/, '')
  const dates = findAllDates(receiptText, today)
  const receiptDay = dates[0]
  const undated = dates.reduceRight((text, date) => text.slice(0, date.start) + ' ' + text.slice(date.end), receiptText)
    .trim().replace(/^[, ]+|[, ]+$/g, '').replace(/\s+/g, ' ')
  const trailingApp = undated.match(/(?:^|\s+)(?:d[ao]|n[ao]|pel[ao])\s+(uber|99|in\s*drive[r]?)$/)
  const leadingApp = undated.match(/^(?:d[ao]|n[ao]|pel[ao])\s+(uber|99|in\s*drive[r]?)\s+/) || undated.match(RECEIPT_APP_SUBJECT)
  const middleApp = !trailingApp && !leadingApp && undated.match(/^(.+?)\s+(?:(?:d[ao]|n[ao]|pel[ao])\s+)?(uber|99|in\s*drive[r]?)\s+((?:caiu|cairam|entrou|entraram)(?:\s+na\s+(?:minha\s+)?conta)?)$/)
  const namedApp = trailingApp?.[1] || leadingApp?.[1] || middleApp?.[2]
  const platform = namedApp && ridePayoutPlatformName(namedApp)
  const receipt = trailingApp ? undated.slice(0, trailingApp.index) : leadingApp ? undated.slice(leadingApp[0].length)
    : middleApp ? `${middleApp[1]} ${middleApp[3]}` : undated
  const afterVerb = receipt.match(RECEIPT_VALUE_AFTER_VERB)
  const beforeVerb = receipt.match(/^(.+?)\s+(?:caiu|cairam|entrou|entraram)(?:\s+na\s+(?:minha\s+)?conta)?$/)
  const value = exactMoneyAnswer(afterVerb?.[1] || beforeVerb?.[1] || '')
  const noPayment = /^(?:eu\s+)?(?:ainda\s+)?nao\s+(?:recebi|caiu|entrou)\s+(?:nada|nem\s+um\s+centavo)(?:\s+ainda)?$/.test(receipt)
  return { dates, receiptDay, undated, platform, receipt, value, noPayment }
}

const EARNINGS_PERIOD = String.raw`(?:da\s+semana\s+passada|do\s+mes\s+passado|d(?:essa|esta)\s+semana|d(?:esse|este)\s+mes)`
const EARNINGS_PERIOD_ORIGIN = new RegExp(String.raw`\s+(?:de\s+corridas?\s+)?${EARNINGS_PERIOD}(?![\p{L}\p{M}\d])`, 'gu')
const EARNINGS_PERIOD_COMPONENT = new RegExp(String.raw`^(.+?)\s+${EARNINGS_PERIOD}$`)

function prepareRideReceiptForEarningsPeriod(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (input.message.includes('?') || !/\b(?:semana|m[eê]s)\b/i.test(input.message)) return undefined
  const text = normalizeName(normalizeNumberWords(input.message).text)
  const receiptsOnly = text.replace(EARNINGS_PERIOD_ORIGIN, '')
  if (receiptsOnly === text) return undefined
  const clauses = receiptsOnly.split(/[,;]\s+(?:e\s+)?|\s+e\s+/)
  const actions: ParsedAction[] = []
  for (const clause of clauses) {
    const { value, platform, dates, receiptDay } = readPayoutReceiptAnswer(clause, today)
    if (!(value > 0) || !platform || dates.length > 1 || (receiptDay && receiptDay.kind !== 'date')) return undefined
    const date = receiptDay?.kind === 'date' ? receiptDay.date : undefined
    actions.push({ kind: 'income', amount: value, category: 'corridas', description: platform, ...(date ? { date } : {}) })
  }
  return proposeDatedActions(input, actions, caps, today)
}

function prepareRideReceiptBreakdown(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (input.message.includes('?')) return undefined
  const breakdown = input.message.match(/^(.+?)(?:(?:[,;]\s*|\s+)(?:eram|foram|sendo)\s+|,\s+|;\s*)(.+)$/i)
  if (!breakdown) return undefined
  const { value, platform, dates, receiptDay } = readPayoutReceiptAnswer(breakdown[1], today)
  if (!(value > 0) || !platform || dates.length > 1 || (receiptDay && receiptDay.kind !== 'date')) return undefined
  const paymentDate = receiptDay?.kind === 'date' ? receiptDay.date : undefined
  let breakdownText = breakdown[2]
  let companions: ParsedAction[] = []
  for (const split of breakdownText.matchAll(/[,;]\s+(?:e\s+)?|\s+e\s+/gi)) {
    const part = breakdownText.slice(split.index + split[0].length)
    if (!/^(?:(?:hoje|hj|ontem|anteontem|eu)\s+)*(?:abasteci|gastei|paguei|rodei|trabalhei)\b/i.test(part)) continue
    const actions = readDatedPayoutActivities(part, today)
    if (!actions) continue
    breakdownText = breakdownText.slice(0, split.index)
    companions = actions
    break
  }
  const text = normalizeName(normalizeNumberWords(breakdownText).text).replace(/[.!]+$/, '')
  const entries = text.split(/(?:,\s+|\s+e\s+)(?=(?:r\$\s*)?\d)/)
  if (entries.length < 2) return undefined
  const amounts = entries.map(part => {
    const period = part.match(EARNINGS_PERIOD_COMPONENT)
    if (period) return exactMoneyAnswer(period[1])
    const day = findDate(part, today)
    if (day?.kind !== 'date' || day.end !== part.length || day.date > (paymentDate || today)) return undefined
    const amount = part.slice(0, day.start).match(/^(.+?)\s+d[eo]\s*$/)?.[1]
    return amount ? exactMoneyAnswer(amount) : undefined
  })
  if (amounts.some(amount => !(amount > 0))) return undefined
  const cents = amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0)
  const receipt: ParsedAction = { kind: 'income', amount: value, description: platform, category: 'corridas',
    ...(paymentDate ? { date: paymentDate } : {}) }
  if (cents === Math.round(value * 100)) return proposeDatedActions(input, [receipt, ...companions], caps, today)
  const question = `Você informou ${fmtBRL(value)} recebidos da ${platform}, e as partes somam ${fmtBRL(cents / 100)}. Quanto realmente caiu?`
  const clarification: AssistantClarification = { field: 'ride-payout-inclusion', question,
    pendingActions: [{ ...receipt, amount: Math.max(value, cents / 100) }] }
  return companions.length ? keepActionsAwaitingClarification(input, proposeDatedActions(input, companions, caps, today), clarification)
    : keepPendingClarification(input, clarification)
}

function prepareRideReceiptAndDatedFuel(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  if (input.message.includes('?') || !/\b(?:gasosa|gasolina|etanol|diesel|gnv|combust[íi]vel)\b/i.test(input.message)) return undefined
  const text = normalizeNumberWords(input.message).text
  const dates = findAllDates(text, today)
  const [paid, fueled] = dates
  if (dates.length !== 2 || paid.kind !== 'date' || fueled.kind !== 'date' || paid.date === fueled.date) return undefined
  const separator = /(?:[,;]\s+(?:e\s+)?|\s+e\s+)(?=(?:r\$\s*)?\d[\d.,]*\s+(?:reais?\s+)?de\s+(?:gasosa|gasolina|etanol|diesel|gnv|combust[íi]vel)\b)/gi
  for (const split of text.matchAll(separator)) {
    if (split.index < paid.end || split.index >= fueled.start) continue
    const receipt = readPayoutReceiptAnswer(text.slice(0, split.index), today)
    if (!(receipt.value > 0) || !receipt.platform || receipt.receiptDay?.kind !== 'date') continue
    const fuel = readDatedPayoutCompanion('gastei ' + text.slice(split.index + split[0].length), today)
    if (fuel?.kind !== 'fuel') continue
    return proposeDatedActions(input, [{ kind: 'income', amount: receipt.value, category: 'corridas', description: receipt.platform,
      date: receipt.receiptDay.date }, fuel], caps, today)
  }
}

const HELD_WALLET = String.raw`(?:na\s+carteira|no\s+saldo\s+da\s+carteira)(?:\s+d[ao]\s+(?<app>app|uber|99|in\s*driver?))?`
const WALLET_STATE = String.raw`(?:ja\s+)?(?:estavam?|ficou|ficaram|continuou|continuaram)`
const VALUE_THEN_WALLET = new RegExp(String.raw`^(?<amount>.+?)\s+${WALLET_STATE}\s+${HELD_WALLET}$`)
const WALLET_THEN_VALUE = new RegExp(String.raw`^${HELD_WALLET}\s+${WALLET_STATE}\s+(?<amount>.+)$`)

function readHeldWalletBalance(text: string, today: string) {
  const said = text.replace(/[.!]+$/, '')
  const day = findDate(said, today)
  const content = day?.end === said.length ? said.slice(0, day.start).trimEnd() : said
  const balance = (content.match(VALUE_THEN_WALLET) || content.match(WALLET_THEN_VALUE))?.groups
  if (!balance) return undefined
  const amount = exactMoneyAnswer(balance.amount)
  const platform = balance.app && readRidePayoutApp(balance.app)
  if (amount >= 0) return { amount, platform }
}

function readShiftWithWalletBalance(message: string, today: string) {
  if (!/\bcarteira\b/i.test(message) || message.includes('?')) return undefined
  const contrast = message.match(/^(.+?)(?:[,.;]\s*|\s+)(?:mas|por[ée]m|s[oó]\s+que)\s+(.+)$/i)
  const wallet = contrast && readHeldWalletBalance(normalizeName(normalizeNumberWords(contrast[2]).text), today)
  if (wallet && wallet.amount > 0) return { text: contrast[1], ...wallet }
}

function readWalletWithdrawal(message: string, today: string) {
  if (!/\bcarteira\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeName(message)
  const dates = findAllDates(text, today)
  const [date] = dates
  if (dates.length > 1 || (date && date.kind !== 'date')) return undefined
  const undated = date ? (text.slice(0, date.start) + ' ' + text.slice(date.end)).replace(/\s+/g, ' ').trim() : text
  const parts = undated.match(/^(?:(?:so|apenas)\s+)?(?:saiu|sairam)\s+(.+?)\s+da\s+carteira\s+d[ao]\s+(.+?)[.!]*$/)
  if (!parts) return undefined
  const amount = exactMoneyAnswer(parts[1])
  const platform = readRidePayoutApp(normalizeNumberWords(parts[2]).text)
  if (amount > 0 && platform) return { amount, platform }
}

function walletWithdrawalClarification({ amount, platform }: { amount: number; platform: string }): AssistantClarification {
  const question = `Os ${fmtBRL(amount)} que saíram da carteira da ${platform} caíram na sua conta? Se sim, diga o valor e o dia do recebimento.`
  return { field: 'ride-payout-inclusion', question,
    pendingActions: [{ kind: 'income', amount, category: 'corridas', description: platform }] }
}

function readShiftWithWalletWithdrawal(message: string, today: string) {
  if (!/\bcarteira\b/i.test(message)) return undefined
  for (const separator of message.matchAll(/[,.;]\s+|\s+(?:e|mas)\s+/gi)) {
    const withdrawal = readWalletWithdrawal(message.slice(separator.index + separator[0].length), today)
    if (withdrawal) return { text: message.slice(0, separator.index), ...withdrawal, withdrawal: true }
  }
}

function readShiftWithDelayedPayout(message: string) {
  if (!/\b(?:atrasou|liberou|segurando)\b/i.test(message) || message.includes('?')) return undefined
  for (const separator of message.matchAll(/(?:[,.]\s+|;\s*)(?:(?:mas|e)\s+)?|\s+(?:mas|e)\s+/gi)) {
    const debt = readRideDebt(message.slice(separator.index + separator[0].length))
    if (debt && !debt.tail) return { text: message.slice(0, separator.index), ...debt }
  }
}

function rideDebtNote(debt: { platform: string; amount: number }) {
  return `${debt.platform} ainda deve ${fmtBRL(debt.amount)} pelas corridas. Quando receber, diga quanto caiu e em que dia.`
}

function readHeldCashNote(raw: string, receiptPlatform: string, today: string) {
  const text = normalizeName(raw)
  const related = text.replace(/^((?:hoje|hj|ontem|anteontem)\s+)?(?:ele|ela)\s+/, `$1${receiptPlatform.toLowerCase()} `)
  const debt = readRideDebt(related)
  if (debt && !debt.tail) return rideDebtNote(debt)
  const wallet = readHeldWalletBalance(normalizeNumberWords(text).text, today)
  if (wallet) return `Você informou ${fmtBRL(wallet.amount)} de saldo na carteira${wallet.platform ? ` da ${wallet.platform}` : ''}.`
}

async function prepareReceiptWithHeldCash(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  if (!/\b(?:carteira|deve|devendo|pagou|pagar|repassou|depositou|cair|caiu|ca[ií]ram|caem|entrar|entrou|entraram|entram|pendente|amanh[ãa]|daqui|semana|atrasou|liberou|segurando)(?![\p{L}\p{M}\d])/iu.test(input.message)) return undefined
  const question = input.message.match(/(?:[,;]\s*|\s+(?:e\s+)?)(?:quanto\s+(?:caiu|entrou|recebi)(?:\s+(?:na\s+(?:minha\s+)?conta|de\s+fato|mesmo))?)\s*[?.!]*$/i)
  const statement = question ? input.message.slice(0, question.index) : input.message
  const separators = /(?:,\s+|;\s*|,(?=mas\b))(?:(?:e|mas)\s+)?|\s+(?:e|mas)\s+/gi
  for (const split of statement.matchAll(separators)) {
    let head = statement.slice(0, split.index)
    let tail = statement.slice(split.index + split[0].length)
    if (statement.includes('?')) {
      const debt = readRideDebt(head)
      if (debt && !debt.tail && /^\s*quanto\s+(?:caiu|entrou|recebi)\s+(?:d[ao]|n[ao]|pel[ao])\s+(?:uber|99|in\s*drive[r]?)\b/i.test(tail)) {
        const lookup = await orchestrate({ ...input, message: tail, remoteEnabled: false })
        if (lookup.response.mode === 'answer' && !lookup.response.actions.length) {
          return { ...lookup, keepPending: true, response: { ...lookup.response, reply: `${rideDebtNote(debt)}\n\n${lookup.response.reply}` } }
        }
      }
      continue
    }
    // A ordem das orações não decide qual dinheiro entrou. Só inverta quando
    // a primeira parte descreve um repasse pendente completo.
    let reading = readPayoutReceiptAnswer(head, today)
    if (!(reading.value > 0) || !reading.platform) {
      const debt = !question && readRideDebt(head)
      if (!debt || debt.tail) continue
      reading = readPayoutReceiptAnswer(tail, today)
      const receiptText = tail
      tail = head
      head = receiptText
    }
    const { value, platform, dates, receiptDay } = reading
    if (!(value > 0) || !platform || dates.length > 1) continue
    let note = readHeldCashNote(tail, platform, today)
    if (!note && !question) {
      for (const extra of tail.matchAll(separators)) {
        const activity = tail.slice(extra.index + extra[0].length).replace(/^depois(?:\s+disso)?\s*,?\s+(?=(?:(?:hoje|hj|ontem|anteontem|eu)\s+)*(?:abasteci|gastei|paguei|rodei|trabalhei|recebi)\b)/i, '')
        if (!/^(?:(?:hoje|hj|ontem|anteontem|eu)\s+)*(?:abasteci|gastei|paguei|rodei|trabalhei|recebi)\b/i.test(activity)) continue
        note = readHeldCashNote(tail.slice(0, extra.index), platform, today)
        if (!note) continue
        const rest = await orchestrate({ ...input, message: `${head}; ${activity}` })
        return { ...rest, response: { ...rest.response, reply: `${note}\n\n${rest.response.reply}` } }
      }
    }
    if (!note) continue
    if (question) {
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
          reply: `Pelo seu relato, caiu ${fmtBRL(value)} da ${platform}.\n\n${note}` } }
    }
    const receipt: ParsedAction = { kind: 'income', amount: value, category: 'corridas', description: platform,
      ...(receiptDay?.kind === 'date' ? { date: receiptDay.date } : {}) }
    const result = receiptDay && receiptDay.kind !== 'date'
      ? keepPendingClarification(input, { field: 'date', question: payoutReceiptDateQuestion(value), pendingActions: [receipt] })
      : proposeDatedActions(input, [receipt], caps, today)
    return { ...result, response: { ...result.response, reply: `${note}\n\n${result.response.reply}` } }
  }
}

function noRidePayment(input: OrchestratorInput): OrchestratorOutput {
  return { draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
      reply: 'Você ainda não recebeu por essas corridas. Quando o repasse cair, diga o valor e o dia do recebimento.' } }
}

function payoutReceiptDateQuestion(amount: number): string {
  return `Em que dia os ${fmtBRL(amount)} entraram? Informe uma data até hoje.`
}

function keepPendingClarification(input: OrchestratorInput, clarification: AssistantClarification, reply = clarification.question): OrchestratorOutput {
  return { draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], reply, clarification } }
}

function listedHomes(text: string): string[] {
  const names = text.trim().replace(/^casas\s+/i, '').split(/,\s*(?:e\s+)?|\s+e\s+/)
    .map(item => item.match(/^(?:a\s+)?(?:casa\s+)?(\d{1,4})$/)?.[1])
  if (names.some(name => !name) || new Set(names).size !== names.length) return []
  return names.map(name => `Casa ${name}`)
}

/** Um valor por imóvel precisa de uma lista explícita, mesmo com imóveis no histórico. */
function prepareRepeatedRent(input: OrchestratorInput, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const clarification = input.pendingClarification
  const waiting = clarification?.field === 'rent-origins' || clarification?.field === 'rent-origins-date'
  if (!waiting && (clarification || !/\bcada\b/i.test(input.message))) return undefined
  if (looksLikeQuestion(input.message) || looksNegated(input.message)) return undefined
  const text = normalizeName(normalizeNumberWords(input.message).text).replace(/[.!]+$/, '')
  const dates = findAllDates(text, today)
  const [when] = dates
  const date = dates.length === 1 && when.kind === 'date' ? when.date : undefined
  const undated = dates.reduceRight((s, d) => s.slice(0, d.start) + ' ' + s.slice(d.end), text).trim().replace(/\s+/g, ' ')
  const receipt = !waiting && undated.match(/^(?:eu\s+)?(?:ja\s+)?recebi\s+(.+?)\s+(de\s+aluguel\s+)?de\s+cada\s+(?:uma\s+das\s+)?casas?(?:\s+(.+))?$/)
  const rents = !waiting && undated.match(/^(?:os\s+)?(?:(\d+)\s+)?alugueis\s+das\s+(casas\s+.+?)\s+(?:foram|cairam|entraram)\s+(.+?)\s+cada$/)
  if (!waiting && !receipt && !rents) return undefined
  const template = waiting ? clarification.pendingActions?.[0] : undefined
  const amount = template?.kind === 'income' ? template.amount : exactMoneyAnswer(receipt?.[1] || rents?.[3] || '')
  if (!(amount > 0)) return undefined
  const base: Extract<ParsedAction, { kind: 'income' }> = { kind: 'income', amount,
    ...(rents || receipt?.[2] || (template?.kind === 'income' && template.category === 'aluguel') ? { category: 'aluguel' } : {}),
    date: date || (template?.kind === 'income' ? template.date : undefined),
  }
  const origins = listedHomes(waiting ? undated : receipt?.[3] || rents?.[2] || '')
  if (rents?.[1] && origins.length !== Number(rents[1])) {
    const question = 'A quantidade de aluguéis não bate com a lista de casas. Diga quais casas pagaram e o valor de cada uma.'
    return keepPendingClarification(input, { question })
  }
  const needsDate = (dates.length > 0 && !date) || (clarification?.field === 'rent-origins-date' && !base.date)
  if (!origins.length) {
    if (waiting && looksPast(input.message)) return undefined
    const question = `Quais casas pagaram ${fmtBRL(amount)} cada? Informe os números das casas, como “Casa 1 e Casa 2”${needsDate ? ', e a data em que recebeu' : ''}.`
    return keepPendingClarification(input, { field: needsDate ? 'rent-origins-date' : 'rent-origins', question, pendingActions: [base] })
  }
  if (origins.length + (input.pending?.length || 0) > MAX_ACTIONS_PER_BATCH) {
    return keepPendingClarification(input, { question: `A proposta aceita até ${MAX_ACTIONS_PER_BATCH} itens. Informe as casas em grupos menores.` })
  }
  const actions = origins.map(origin => ({ ...base, origin }))
  if (needsDate) {
    return keepPendingClarification(input, { field: 'date', question: 'Em que dia esses aluguéis entraram? Informe uma data até hoje.', pendingActions: actions })
  }
  return proposeDatedActions(input, actions, caps, today)
}

async function correctPendingKeepingClarification(input: OrchestratorInput, command: string, pc: AssistantClarification, caps: AssistantCapabilities, today: string) {
  if (!input.pending?.length || !parseCorrection(command, input.pending, caps, today)) return undefined
  const corrected = await orchestrate({ ...input, pendingClarification: undefined })
  if (corrected.response.mode !== 'propose_actions' || !corrected.correctedPending) return undefined
  return { ...corrected, response: { ...corrected.response, mode: 'clarify' as const, clarification: pc,
    reply: corrected.response.reply.replace(/\n\nConfirmar\?$/, '') + '\n\n' + pc.question } }
}

function allocateUnpaidShift(input: OrchestratorInput, pc: AssistantClarification, said: string, caps: AssistantCapabilities, today: string): OrchestratorOutput | undefined {
  const income = (pc.pendingActions || []).filter((a): a is Extract<ParsedAction, { kind: 'income' }> => a.kind === 'income')
  if (income.length < 2 || pc.rideShiftUnpaid === undefined || input.message.includes('?')) return undefined
  const breakdownQuestion = `Diga quanto ainda não caiu de cada plataforma (${income.map(a => a.description).join(' e ')}).`
  if (/^(?:n[oa]s?\s+(?:dois|duas|amb[oa]s)|nas duas plataformas|em ambas)$/.test(said)) {
    return keepPendingClarification(input, pc, breakdownQuestion)
  }
  if (findAllDates(said, today).length) return undefined
  const pairs = parseTypedPairs(said, { driver: true })
  if (!pairs) return undefined
  const unpaidByApp = new Map<string, number>()
  for (const pair of pairs) {
    if (pair.kind !== 'income' || !pair.description || unpaidByApp.has(pair.description)
      || !income.some(item => item.description === pair.description)) return keepPendingClarification(input, pc, breakdownQuestion)
    unpaidByApp.set(pair.description, Math.round(pair.amount * 100))
  }
  const totalUnpaid = [...unpaidByApp.values()].reduce((a, b) => a + b, 0)
  if (totalUnpaid !== Math.round(pc.rideShiftUnpaid * 100)) {
    return keepPendingClarification(input, pc, `As partes somam ${fmtBRL(totalUnpaid / 100)}. O valor em aberto informado foi ${fmtBRL(pc.rideShiftUnpaid)}. ${breakdownQuestion}`)
  }
  const received = income.map(item => ({ ...item,
    amount: (Math.round(item.amount * 100) - (unpaidByApp.get(item.description) || 0)) / 100 }))
  if (received.some(item => item.amount < 0)) {
    return keepPendingClarification(input, pc, `Uma parte em aberto é maior que o valor informado para esse app. ${breakdownQuestion}`)
  }
  return proposeDatedActions(input, received.filter(item => item.amount > 0), caps, today, true)
}

function pendingCorrectionAnswer(choice: AssistantClarification, message: string, today: string): string | undefined {
  if (choice.field === 'pending-correction-amount') {
    const amount = exactMoneyAnswer(message)
    return amount === undefined ? undefined : String(amount)
  }
  if (choice.field === 'pending-correction-date') return dateInAnswer(weekdayChoiceWord(message), today)?.date
  const said = normalizeName(message).replace(/[.!?]+$/, '').trim()
  if (choice.field === 'pending-correction-origin') return said.replace(/^(?:(?:foi|era|veio)\s+)?(?:d[ao]s?\s+)?/, '')
  const reference = said.replace(/^(?:foi\s+)?(?:[ao]\s+)?(?:d[aeo]\s+)?/, '')
  const matches = choice.options?.filter(({ label }) => normalizeName(label.split(' · ')[1]) === reference)
  return matches?.length === 1 ? matches[0].value : undefined
}

function proposalWarnings(state: AppState, candidates: AssistantCandidateAction[], today: string,
  previous: AssistantCandidateAction[] = []): AssistantCandidateAction[] {
  // A origem e o dia distinguem repasses no mesmo valor.
  const key = ({ action }: AssistantCandidateAction) => {
    const amount = 'amount' in action ? action.amount : 'total' in action ? action.total : ''
    const description = 'description' in action ? action.description : ''
    const date = 'date' in action ? action.date : undefined
    return `${action.kind}:${amount ?? ''}:${normalizeName(description)}:${date || today}`
  }
  const seen = new Set(previous.map(key))
  return candidates.map(c => {
    const action = c.action
    const exactDate = isDriver(state.settings) && action.kind === 'income' && action.category === 'corridas' ? action.date : undefined
    const duplicate = findPossibleDuplicate(state, action, exactDate)
    const token = key(c)
    const warn = seen.has(token) ? 'Esse valor aparece mais de uma vez nesta proposta. Confira os itens antes de confirmar.'
      : duplicate ? `Já existe ${duplicate.type === 'income' ? 'uma receita' : 'uma despesa'} parecida de ${fmtBRL(duplicate.amount)} registrada ${exactDate ? `em ${brDate(exactDate)}` : 'recentemente'}.` : undefined
    seen.add(token)
    const currentOdometer = state.vehicle?.odometer || 0
    const odometer = action.kind === 'odometer' ? action.value : action.kind === 'fuel' ? action.odometer : undefined
    const pattern = typeof odometer === 'number' && currentOdometer > 0 && odometer < currentOdometer
      ? `O hodômetro registrado é ${currentOdometer.toLocaleString('pt-BR')} km, e ${odometer.toLocaleString('pt-BR')} km é menor. Confira o número — se trocou de veículo, atualize na tela Veículo.`
      : outOfPatternWarning(state, action, today)
    return { ...c, ...(warn ? { duplicateWarning: warn } : {}), ...(pattern ? { patternWarning: pattern } : {}) }
  })
}

function proposeDatedActions(input: OrchestratorInput, actions: ParsedAction[], caps: AssistantCapabilities, today: string, newFirst = false): OrchestratorOutput {
  const notes: string[] = []
  const choices: AssistantClarification[] = []
  const dueText = input.pendingClarification?.purchaseDueText
  let dueDraft: AssistantDraft | undefined
  const candidates = actions.flatMap(raw => {
    const validated = validateAction(actionForProfile(raw, caps, input.message), caps, today)
    if (isValidationFailure(validated)) {
      notes.push(errorMessage(validated.code, validated.detail))
      return []
    }
    const action = validated.action
    if (action.kind === 'card-purchase' && dueText !== undefined) {
      const firstDueDate = resolveCardPurchaseDue(dueText, action.date || today, today)
      if (firstDueDate) return [candidate({ ...action, firstDueDate }, 'local')]
      dueDraft = newDraft({ partial: action, missing: ['firstDueDate'] }, input.message, caps)
      return []
    }
    if ((action.kind === 'expense' || action.kind === 'income') && action.time
      && (!action.date || action.date === today) && today === todayISO() && action.time > nowTime()) {
      choices.push({ field: 'date', question: `O horário ${action.time} ainda não chegou hoje. Em que dia aconteceu?`, pendingActions: [action] })
      return []
    }
    const fixed = action.kind === 'expense' ? resolveRecurringStatement(input.state, action, '', caps, today) : null
    if (!fixed) return [candidate(action, 'local')]
    if ('clarification' in fixed) choices.push(fixed.clarification)
    else notes.push(fixed.note)
    return 'action' in fixed ? [candidate(fixed.action, 'local')] : []
  })
  const prepared = prepareInvoicePayments(input.state, candidates, today)
  prepared.actions = proposalWarnings(input.state, prepared.actions, today, input.pending)
  if (dueDraft) {
    const [field] = dueDraft.missingFields
    dueDraft.companion = { before: [...(input.pending || []), ...prepared.actions].map(c => c.id), after: [] }
    prepared.clarification = { field: field.field, question: field.question }
    return { ...preparedActionResponse(input.state, prepared, input.pending), draft: dueDraft }
  }
  const choicesNow = [...choices, ...(prepared.clarification ? [prepared.clarification] : [])]
  prepared.notes.push(...notes)
  if (choicesNow.length > 1) prepared.notes.push('Informe separadamente as datas e os vencimentos dos registros que ainda precisam de confirmação.')
  prepared.clarification = choicesNow.length === 1 ? choicesNow[0] : undefined
  return preparedActionResponse(input.state, prepared, input.pending, undefined, newFirst)
}

function preparedActionResponse(
  state: AppState, prepared: ReturnType<typeof prepareInvoicePayments>,
  previous: AssistantCandidateAction[] = [], correction?: string, newFirst = false,
): OrchestratorOutput {
  const candidates = newFirst ? [...prepared.actions, ...previous] : [...previous, ...prepared.actions]
  const reply = [correction, candidates.length ? proposalText(candidates, state) : '', ...prepared.notes,
    prepared.clarification?.question || (candidates.length ? 'Confirmar?' : '')].filter(Boolean).join('\n\n')
  const response = { version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const, actions: candidates, unresolved: [], reply }
  return {
    draft: null,
    correctedPending: previous.length || correction !== undefined ? candidates : undefined,
    response: prepared.clarification ? { ...response, mode: 'clarify', clarification: prepared.clarification }
      : candidates.length ? { ...response, mode: 'propose_actions' } : { ...response, mode: 'answer', actions: [] },
  }
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

/**
 * Pedido para o assistente quebrar as proprias regras: ignorar instrucoes,
 * registrar sem confirmar, mostrar o prompt ou entregar uma chave.
 *
 * Isto NAO substitui nenhuma barreira — o que impede o registro sem confirmacao
 * e a arquitetura, nao um regex. Serve para o app DIZER nao em vez de responder
 * com a lista de exemplos, que funcionava como recusa por acidente.
 */
const QUEBRAR_REGRA = [
  /\bignor[ae]\s+(?:suas?|as|todas?)\s+(?:regras?|instru)/i,
  /\bsem\s+(?:pedir\s+)?confirma/i,
  /\bregistr[ae]\s+.{0,30}\bsem\s+confirm/i,
  /\b(?:mostr[ae]|revel[ae]|me\s+d[êe]|qual\s+[ée])(?![\wÀ-ÿ])[^?]{0,40}\b(?:prompt|instru[çc][õo]es\s+internas|system\s+prompt)\b/i,
  /\b(?:chave|token|api\s*key|senha)\b[^?]{0,30}\b(?:api|deepseek|sistema|voc[êe]\s+usa)\b/i,
  /\bqual\s+[ée]\s+a\s+(?:chave|senha|api)/i,
  /\bfa[çc]a\s+de\s+conta\s+que\s+voc[êe](?![\wÀ-ÿ])/i,
  /\besque[çc]a\s+(?:tudo|suas?\s+regras?)/i,
]

const pedeParaQuebrarRegra = (t: string): boolean => QUEBRAR_REGRA.some(re => re.test(t))

const PEDE_LEMBRETE = /\b(?:me\s+)?(?:lembr[ae]|lembrar|avis[ae]|avisar)\s+(?:me\s+)?(?:de|que|para|pra|quando)\b[^?]*\b(?:pagar|pago|vence|vencer|vencimento|conta|boleto|fatura|parcela)\b/
const SEM_CERTEZA = 'Não tenho certeza do que registrar aqui. Pode escrever de outro jeito?'

const escaparRegex = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Compra no cartão de crédito dita sem parcelas: o valor e o item, como
 * rascunho de `card-purchase` que só falta o número de parcelas (e o cartão,
 * com mais de um). Débito, Pix, dinheiro e fatura ficam de fora.
 */
function compraNoCartao(mensagem: string, candidates: AssistantCandidateAction[], caps: AssistantCapabilities, today: string): import('./drafts').IncompleteIntent | null {
  const t = normalizeName(mensagem)
  if (/\bd[eé]bito\b|\bpix\b|\bdinheiro\b|\bespecie\b|\bfatura\b|\bassinatura\b|\?|\b(?:quanto|qual|quais|quando|posso|consigo)\b|\b(?:vezes|parcelas?|\d+\s*x)\b/.test(t)) return null
  const cartao = caps.cardNames.find(c => new RegExp(String.raw`\b(?:no|na|pelo|pela)\s+${escaparRegex(normalizeName(c))}\b`).test(t))
  const marca = /\b(?:no|pelo)\s+cartao\b|\bno\s+credito\b|\bcartao\s+de\s+credito\b/.test(t) || !!cartao
  if (!marca) return null
  const limpar = (desc?: string) => {
    const nomes = caps.cardNames.map(c => escaparRegex(normalizeName(c))).join('|')
    const out = (desc || '').replace(new RegExp(String.raw`\s*\b(?:no|na|pelo|pela)\s+(?:cart[ãa]o(?:\s+de\s+cr[ée]dito)?|cr[ée]dito${nomes ? `|${nomes}` : ''})\b`, 'gi'), ' ').replace(/\s+/g, ' ').trim()
    return out && !/^(?:cart[ãa]o|cr[ée]dito)$/i.test(out) ? sentenceCase(out) : undefined
  }
  let total: number | undefined
  let descricao: string | undefined
  let categoria: string | undefined
  let purchaseDate: string | undefined
  const said = readDraftPurchaseDate(t, today)
  if (candidates.length === 1 && candidates[0].action.kind === 'expense') {
    const a: any = candidates[0].action
    total = a.amount
    purchaseDate = a.date
    descricao = limpar(a.description)
    categoria = descricao ? (a.category === 'outros-out' ? undefined : a.category) : undefined
  } else if (!candidates.length) {
    const m = said.remaining.match(/^(?:eu\s+)?(?:passei|gastei|paguei|comprei|torrei)\s+(?:r\$\s*)?(\d+(?:[.,]\d+)*)/)
    if (m) total = parseMoney(m[1])
  } else return null
  if (!(total && total > 0)) return null
  purchaseDate = said.question ? undefined : purchaseDate || said.date
  const partial: any = { kind: 'card-purchase', total, ...(purchaseDate ? { date: purchaseDate } : {}), ...(descricao ? { description: descricao } : {}), ...(categoria ? { category: categoria } : {}), ...(cartao ? { cardName: cartao } : {}) }
  const missing = [...(said.question ? ['date'] : []), 'installments', ...(caps.cardNames.length > 1 && !cartao ? ['cardName'] : [])]
  return { partial, missing, purchaseDateQuestion: said.question }
}

/** Um vencimento explicitamente dito pertence ao parcelamento, não ao registro de caixa. */
async function purchaseWithFirstDue(input: OrchestratorInput, caps: AssistantCapabilities, today: string): Promise<OrchestratorOutput | undefined> {
  const mention = readCardPurchaseDue(input.message, today)
  if (!mention) return undefined
  const prev = segment(mention.before, today).slice(-1)[0]?.text || ''
  const normalized = normalizeName(prev)
  const context = normalizeName(prev + ' ' + mention.after)
  const activeDraft = isDraftFresh(input.draft) && input.draft?.partial.kind === 'card-purchase' ? input.draft : undefined
  const pureDue = !mention.message || /^[.!]*$/.test(mention.message)
  const newPurchase = /\b(?:comprei|passei|parcelei|paguei|gastei|financiei|torrei)\b/.test(normalized)
    && !looksLikeQuestion(prev) && !declaresIntention(prev) && !/\bfatura\b/.test(normalized)
    && (/\b(?:cartao|credito|parcelad[oa]|(?:\d+\s*)(?:x|vezes|parcelas))\b/.test(context)
      || caps.cardNames.some(name => new RegExp(`\\b(?:n[oa]|pel[oa])\\s+${escaparRegex(normalizeName(name))}\\b`).test(context)))
  const pendingPurchase = pureDue && !activeDraft && input.pending?.some(c => c.action.kind === 'card-purchase')
  if (!newPurchase && !activeDraft && !pendingPurchase) return undefined
  if (!pureDue && activeDraft && !newPurchase && looksPast(mention.message)) return undefined

  const result = pureDue
    ? preparedActionResponse(input.state, { actions: pendingPurchase ? input.pending || [] : [], notes: [], clarification: undefined })
    : await orchestrate({ ...input, message: mention.message })
  if (newPurchase && looksNegated(prev)) return result
  const openDraft = pureDue ? activeDraft : result.draft
  if (openDraft?.partial.kind === 'card-purchase') {
    const datePending = openDraft.missingFields.some(f => f.field === 'date')
    const firstDueDate = datePending ? undefined : resolveCardPurchaseDue(mention.answer, openDraft.partial.date || today, today)
    const fields = openDraft.missingFields.filter(f => f.field !== 'firstDueDate')
    const dueField = questionFor('card-purchase', 'firstDueDate', caps)
    const draft = { ...openDraft, partial: { ...openDraft.partial, firstDueDate },
      purchaseDueText: datePending ? mention.answer : undefined,
      missingFields: datePending || firstDueDate ? fields : [...fields, dueField] }
    const [field] = draft.missingFields
    if (field) {
      if (!pureDue && result.response.mode === 'clarify' && field.field === result.response.clarification.field) return { ...result, draft }
      return { ...preparedActionResponse(input.state, { actions: result.response.actions, notes: [],
        clarification: { field: field.field, question: field.question, options: field.options } }), draft, keepPending: pureDue || result.keepPending }
    }
    const checked = validateAction(draft.partial, caps, today)
    if (!isValidationFailure(checked)) {
      const other = input.pending || []
      const before = other.filter(c => openDraft.companion?.before.includes(c.id))
      const after = other.filter(c => openDraft.companion?.after.includes(c.id))
      const actions = [...before, candidate(checked.action, 'local'), ...after]
      return { ...preparedActionResponse(input.state, { actions, notes: [], clarification: undefined }), correctedPending: actions }
    }
  }

  const candidates: AssistantCandidateAction[] = result.response.actions
  const purchases = candidates.filter(c => c.action.kind === 'card-purchase')
  const clarification = result.response.mode === 'clarify' ? result.response.clarification : undefined
  const held = clarification && (clarification.field === 'date' || clarification.field === 'date-choice')
    ? clarification.pendingActions?.filter(a => a.kind === 'card-purchase').length || 0 : 0
  if (held === 1 && !purchases.length && result.response.mode === 'clarify') {
    return { ...result, response: { ...result.response,
      clarification: { ...result.response.clarification, purchaseDueText: mention.answer } } }
  }
  const [target] = purchases
  const ambiguous = purchases.length + held > 1
  if (target?.action.kind === 'card-purchase' && !ambiguous) {
    const firstDueDate = resolveCardPurchaseDue(mention.answer, target.action.date || today, today)
    const updated = firstDueDate && validateAction({ ...target.action, firstDueDate }, caps, today)
    if (updated && !isValidationFailure(updated) && result.response.mode !== 'answer') {
      const actions = candidates.map(c => c.id === target.id ? { ...c, action: updated.action } : c)
      if (result.response.mode === 'answer_and_actions') {
        // A resposta composta precisa usar a fatura com o vencimento informado.
        const analysis = analyzeMessage(mention.message, { today, driver: caps.isDriver })
        const questions = analysis.clauses.filter(c => c.intent === 'question' && !c.ambiguity)
        const corrected = answerQuestions(input.state, questions, actions, today, mention.message)
        const reply = [proposalText(actions, input.state), corrected.text, 'Confirmar?'].filter(Boolean).join('\n\n')
        return { ...result, focus: corrected.focus || result.focus, response: { ...result.response, actions, reply } }
      }
      const reply = result.response.reply
      const label = `1º vencimento: ${brDate(firstDueDate)}`
      const previous = proposalText(candidates, input.state)
      return { ...result, correctedPending: pureDue ? actions : result.correctedPending,
        response: { ...result.response, actions, reply: reply.includes(previous)
          ? reply.replace(previous, proposalText(actions, input.state)) : `${reply}\n\n${label}` } }
    }
    const draft = newDraft({ partial: target.action, missing: ['firstDueDate'] }, input.message, caps)
    const at = candidates.indexOf(target)
    const before = candidates.slice(0, at)
    const after = candidates.slice(at + 1)
    draft.companion = { before: before.map(c => c.id), after: after.map(c => c.id) }
    const [field] = draft.missingFields
    const others = [...before, ...after]
    return { ...preparedActionResponse(input.state, { actions: others, notes: [],
      clarification: { field: field.field, question: field.question, options: field.options } }),
      correctedPending: pureDue ? others : undefined, draft }
  }
  const question = ambiguous
    ? 'Qual compra tem esse primeiro vencimento? Diga uma compra de cada vez, com o valor e a data do primeiro vencimento.'
    : 'Qual foi a compra, o valor total e em quantas parcelas? Diga também o dia e o mês do primeiro vencimento.'
  const actions = ambiguous ? candidates.filter(c => c.action.kind !== 'card-purchase') : []
  return { ...preparedActionResponse(input.state, { actions, notes: [],
    clarification: { field: 'firstDueDate', question } }), correctedPending: pureDue ? actions : undefined }
}

/**
 * Pedaço com valor que nada leu, numa mensagem em que outra parte virou
 * proposta. "Ontem gastei 30 de lanche e anteontem 20 de uber" mostrava só os
 * 30 — o usuário confirmava achando que tinha lançado os dois.
 */
function sobraComValor(unresolved: AssistantUnresolvedClause[]): string {
  // Saque é entendido: não é ganho nem gasto, e dizer "não registrei, me diga
  // o que foi" pedia um lançamento que não deve existir (regra 69).
  const saques = unresolved.filter(u => u.reason === 'not-understood' && SAQUE.test(u.text))
  // Número que é DURAÇÃO não é valor (regra 62): "mas atrasou 3 dias" pedia
  // "me diga o que foi que eu lanço" para um prazo.
  const soDuracao = (txt: string) => !/\d/.test(txt.replace(/\d+(?:[.,]\d+)?\s*(?:dias?|semanas?|m[eê]s(?:es)?|horas?|h(?![\wÀ-ÿ])|min(?:utos)?|anos?|vezes)(?![\wÀ-ÿ])/gi, ' '))
  const sobra = unresolved.filter(u => u.reason === 'not-understood' && /\d/.test(u.text) && !saques.includes(u) && !soDuracao(u.text))
  // Relato SEM valor ("gastei 30 no mercado e PAGUEI A LUZ"): a segunda metade
  // sumia sem aviso, e o usuário confirmava achando que tinha lançado as duas.
  const semValor = unresolved.filter(u => u.reason === 'not-understood' && !/\d/.test(u.text)
    && /^\s*(?:e\s+)?(?:j[áa]\s+)?(?:paguei|gastei|comprei|torrei|recebi|ganhei|abasteci|guardei)(?![\wÀ-ÿ])/i.test(u.text))
  const limpa = (u: AssistantUnresolvedClause) => `“${u.text.trim().replace(/[\s,;]+$/, '')}”`
  let out = ''
  if (sobra.length) out += `\n\nNão registrei ${sobra.length === 1 ? 'esta parte' : 'estas partes'}: ${sobra.map(limpa).join(', ')}. Me diga o que foi que eu lanço.`
  if (semValor.length) out += `\n\nFaltou o valor de ${semValor.map(limpa).join(', ')} — me diga quanto foi que eu lanço também.`
  if (saques.length) out += `\n\n${saques.map(limpa).join(', ')} é saque: não é ganho nem gasto, então não registrei.`
  return out
}

/**
 * Por que a ação entendida não virou proposta, em palavras do usuário. O
 * texto antigo mostrava o código interno ("work (Trabalho)", "expense
 * (amount)") — nome de campo não explica nada a quem digitou a frase.
 */
function motivoDaRecusa(rejected: LocalPass['rejected']): string {
  if (!rejected.length) return ''
  const first = rejected[0]
  const nome = actionSpec(first.kind)?.label || 'Esse registro'
  switch (first.code) {
    case 'profile-forbidden':
      return `${nome} é um registro do perfil de motorista. Se você dirige por aplicativo, troque o perfil em Configurações.`
    case 'invalid-amount':
    case 'invalid-number':
      return `${nome}: esse número está fora do que eu consigo registrar. Confere o valor?`
    // Nestes o detalhe é algo que o usuário escreveu (categoria, data).
    case 'category-not-found':
    case 'category-wrong-type':
    case 'invalid-date':
    case 'future-date':
      return `${nome}: ${errorMessage(first.code, first.detail ? `(${first.detail})` : undefined)}`
    default:
      return `${nome}: ${errorMessage(first.code)}`
  }
}

/**
 * O chat remoto precisa dos AGREGADOS do aparelho?
 *
 * Só quando o trecho em aberto é pergunta ou pedido ("tô guardando o suficiente?",
 * "me ajuda a organizar"). Quando é um REGISTRO que o parser não entendeu ("caiu
 * o vale alimentação 800"), o trabalho do modelo é interpretar a frase: somas do
 * mês não ajudam em nada, e o que não ajuda não sai do aparelho.
 */
export function remoteNeedsAggregates(texto: string): boolean {
  const registro = /\d/.test(texto) && looksPast(texto) && !looksLikeQuestion(texto)
  return !registro
}

type RecurringStatement = {
  kind: 'expense' | 'income'
  description?: string
  amount?: number
  date?: string
  time?: string
  origin?: string
}

type RecurringResolution =
  | { action: ParsedAction; note: string }
  | { clarification: AssistantClarification }
  | { note: string }

function recurringLinkChoice(
  state: AppState, action: Extract<ParsedAction, { kind: 'recurring-confirm' }>, today: string,
  actual: { amount?: number; date?: string } = action,
): AssistantClarification | undefined {
  const rec = state.recurring.find(r => r.id === action.recurringId)
  if (!rec || action.transactionId || action.newPaymentConfirmed) return undefined
  const matches = possibleRecurringTransactions(state, rec, action.occurrenceDate, today, actual)
  if (!matches.length) return undefined
  const kind = rec.kind === 'income' ? 'recebimento' : 'pagamento'
  return {
    field: 'recurring-link',
    question: `Encontrei ${matches.length === 1 ? 'um lançamento parecido' : 'lançamentos parecidos'} para "${sentenceCase(rec.name)}", vencimento ${brDate(action.occurrenceDate)}. Qual deles corresponde a esse ${kind}?`,
    options: [
      ...matches.map((t, i) => ({
        value: String(i + 1),
        label: `${i + 1}. Vincular ${fmtBRL(t.amount)} de ${brDate(t.date)}${t.time ? ` às ${t.time.slice(0, 5)}` : ''}${t.origin ? ` · ${t.origin}` : ''}`,
        actions: [recurringLinkAction(rec, action.occurrenceDate, t)],
      })),
      { value: 'novo-lancamento', label: `Registrar outro ${kind}`, actions: [{ ...action, newPaymentConfirmed: true }] },
    ],
  }
}

function resolveRecurringStatement(
  state: AppState, payment: RecurringStatement, text: string, caps: AssistantCapabilities, today: string,
): RecurringResolution | null {
  // Uma parte paga pode entrar como despesa avulsa. Confirmar a ocorrência
  // daria baixa no vencimento inteiro, inclusive no saldo ainda a pagar.
  if (/^parte\s+d[aeo]s?\b/i.test(payment.description || '')) return null
  const reference = text.match(/(?:[,;]\s*|\s+(?:com\s+)?)vencimento\s+(?:d[eo]\s+)?(.+)$/i)
  const due = reference && findDate(reference[1], today)
  const occurrenceDate = due && (due.kind === 'date' || due.kind === 'future') ? due.date : undefined
  const description = reference ? payment.description?.replace(/\s+(?:com\s+)?vencimento.*$/i, '') : payment.description
  const matches = matchRecurringPayment(state, { ...payment, description }, today, occurrenceDate)
  if (!matches) return null
  if (payment.time || spokenClock(text).remaining !== text) {
    return { note: `Esse pagamento corresponde a uma conta fixa. Confira o vencimento em Planejamento. O assistente só grava horário informado em entradas e despesas avulsas.` }
  }
  if (reference && !occurrenceDate) return { note: 'Qual é a data de vencimento dessa conta fixa? Informe dia, mês e ano.' }
  if (matches.conflictingReference) return { note: 'O mês informado é diferente do mês do vencimento. Qual ocorrência você pagou?' }
  const future = matches.pending.find(p => p.futurePaymentDate)
  if (future?.futurePaymentDate) {
    return { note: `Já existe um lançamento com data futura (${brDate(future.futurePaymentDate)}) para "${sentenceCase(future.rec.name)}", vencimento ${brDate(future.dueDate)}. Confira a data em Movimentações.` }
  }
  if (matches.alreadyPaid) {
    return { note: 'Já encontrei um registro para essa conta fixa. Se você pagou outra ocorrência, diga o vencimento ou a origem dessa conta.' }
  }
  if (!matches.pending.length) return { note: 'Não encontrei vencimento em aberto para essa conta fixa no período informado.' }

  const paid = reference ? findDate(text.slice(0, reference.index), today) : null
  const date = reference ? (paid?.kind === 'date' ? paid.date : undefined) : payment.date
  const actions = matches.pending.flatMap(p => {
    const validation = validateAction({
      kind: 'recurring-confirm', recurringId: p.rec.id, occurrenceDate: p.dueDate,
      amount: payment.amount ?? p.rec.amount, description: p.rec.name, ...(date ? { date } : {}),
    }, caps, today)
    return isValidationFailure(validation) ? [] : [{ action: validation.action, pending: p }]
  })
  if (actions.length !== matches.pending.length) {
    return { note: 'Uma conta fixa encontrada tem dados inválidos. Confira o cadastro no Planejamento antes de confirmar.' }
  }
  if (actions.length > 1) return {
    clarification: {
      question: `Encontrei mais de um vencimento para "${sentenceCase(description)}". Qual ocorrência foi ${payment.kind === 'income' ? 'recebida' : 'paga'}?`,
      field: 'recurring-occurrence',
      options: actions.map(({ action, pending: p }, i) => ({
        value: String(i + 1),
        label: `${i + 1}. ${sentenceCase(p.rec.name)}${p.rec.origin ? ` · ${p.rec.origin}` : ''} · ${brDate(p.dueDate)} · ${fmtBRL(p.rec.amount)}`,
        actions: [action],
      })),
    },
  }
  const [{ action, pending: p }] = actions
  const link = action.kind === 'recurring-confirm' && recurringLinkChoice(state, action, today, { amount: payment.amount, date })
  if (link) return { clarification: link }
  const valueNote = payment.amount === undefined ? ` com o valor cadastrado (${fmtBRL(p.rec.amount)})`
    : Math.abs(payment.amount - p.rec.amount) > 0.009
      ? ` com ${fmtBRL(payment.amount)} (cadastrado: ${fmtBRL(p.rec.amount)})`
      : ''
  return {
    action,
    note: `${sentenceCase(p.rec.name)} é conta fixa com vencimento de ${brDate(p.dueDate)} em aberto. A proposta confirma ${payment.kind === 'income' ? 'esse recebimento' : 'esse pagamento'}${valueNote}.`,
  }
}

function recurringStatementWithoutAmount(message: string, today: string): RecurringStatement | null {
  if (looksLikeQuestion(message)) return null
  const m = normalizeName(message).match(/^(?:ja\s+|hoje\s+|ontem\s+|anteontem\s+)?(paguei|quitei|recebi)\s+(?:[ao]s?\s+)?(?:(?:conta|boleto)\s+d[aeo]\s+)?([a-z0-9][a-z0-9 ]*?)(?:\s+(?:hoje|ontem|anteontem|agora|ja))?[.!]*$/)
  if (!m || !/[a-z]/.test(m[2])) return null
  const date = findDate(message, today)
  return {
    kind: m[1] === 'recebi' ? 'income' : 'expense',
    description: m[2],
    ...(date?.kind === 'date' && date.date !== today ? { date: date.date } : {}),
  }
}

const INTENCAO_DE_REDUZIR = /\b(?:quero|queria|preciso|pretendo|vou\s+tentar|tenho\s+que|t[oô]\s+tentando|estou\s+tentando)\s+(?:diminuir|reduzir|cortar|baixar|economizar|gastar\s+menos)\b/i

function respostaDeIntencaoDeReduzir(state: AppState, mensagem: string, today: string): string {
  const base = 'Entendi a intenção — não registrei nada.'
  const alvo = mensagem.match(/\b(?:diminuir|reduzir|cortar|baixar|economizar|gastar\s+menos)\s+(?:os\s+|meus\s+|minhas\s+|as\s+|o\s+|a\s+|em\s+|com\s+|de\s+)?(?:gastos?\s+(?:com|de|em)\s+|despesas?\s+(?:com|de|em)\s+|custos?\s+(?:com|de)\s+)?([a-zà-ú][\wà-ú ]{2,30}?)(?=[,.!?]|\s+(?:mas|por[ée]m|sem|e)\b|$)/i)
  const nome = alvo?.[1]?.trim()
  if (!nome) return `${base} Me diga com o quê você quer gastar menos que eu mostro quanto tem saído.`
  const plano = planQuery(state, `quanto gastei com ${nome} nos ultimos 30 dias`, { today })
  const v = plano && !plano.incompleto ? validateQueryPlan(plano.plan, state, today) : null
  if (!v || isQueryFailure(v)) {
    return `${base} Não reconheci "${nome}" como categoria ou nome de lançamento; diga o nome como aparece nos seus registros que eu mostro quanto tem saído.`
  }
  const r = runQuery(state, v.plan, today)
  const historico = r.empty
    ? `Nos últimos 30 dias não encontrei lançamentos de ${nome}.`
    : `Nos últimos 30 dias, ${sentenceCase(nome)} somou ${fmtBRL(r.total)} (${r.count} ${r.count === 1 ? 'lançamento' : 'lançamentos'}, dado real).`
  return `${base} ${historico} Para ver o efeito de um corte, pergunte por exemplo "e se eu reduzir ${nome} em 100 por mês?".`
}

function periodViewFocus(focus: ConversationFocus | undefined, kind: NonNullable<ConversationFocus['lastPeriodView']>['kind'],
  question: string, today: string): ConversationFocus {
  const clean = normalizeQuestion(question).replace(/[.!?]+$/, '').trim()
  const parsed = parsePeriod(clean, today)
  const span = parsed?.span ?? parsed?.matched
  const base = span ? clean.replace(span, ' ').replace(/\s+/g, ' ').trim() : clean
  return { ...focus, last: 'period-view', lastPeriodView: { kind, question: base, ...(span ? { periodText: span } : {}) },
    lastQuery: undefined, lastQueryPlan: undefined, lastAnswerExplanation: undefined, updatedAt: Date.now() }
}

export async function orchestrate(entradaBruta: OrchestratorInput): Promise<OrchestratorOutput> {
  const started = Date.now()
  // FRONTEIRA (regra 46): caractere invisível e de controle saem AQUI, antes de
  // qualquer interpretação. Sem isso o `\b` que o usuário colou sem perceber
  // sobrevivia até a DESCRIÇÃO do lançamento, voltava na resposta e ia parar no
  // histórico; e um `U+202E` no meio de um nome inverte visualmente a linha
  // inteira na tela. Depois desta linha, o resto do código pode confiar.
  const limpa = clampMessage(entradaBruta.message)
  let input: OrchestratorInput = limpa.text === entradaBruta.message
    ? entradaBruta
    : { ...entradaBruta, message: limpa.text }
  const preferenceCommand = parsePreferenceCommand(input.state, input.message)
  if (preferenceCommand) {
    return {
      draft: null, focus: input.focus, preferenceMutation: preferenceCommand.mutation,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
        actions: [], unresolved: [], reply: preferenceCommand.reply,
      },
    }
  }
  const preferredMessage = applyPreferenceAliases(input.state, input.message)
  if (preferredMessage !== input.message) input = { ...input, message: preferredMessage }
  if (isDriver(input.state.settings)) {
    const shorthand = normalizeDriverShorthand(input.message)
    if (shorthand !== input.message) input = { ...input, message: shorthand }
  }
  const today = input.today || todayISO()
  const speech = speechForCommands(input.message, today)
  if (speech.context.length) {
    if (speech.command) {
      const out = await orchestrate({ ...input, message: speech.command })
      return { ...out, response: { ...out.response, reply: [...speech.context, out.response.reply].join('\n\n') } }
    }
    const clarification = input.pendingClarification
    const response = { version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const, actions: [] as [], unresolved: [],
      reply: [...speech.context, ...(clarification ? [clarification.question] : [])].join('\n\n') }
    return { draft: input.draft || null, keepPending: true, focus: input.focus,
      response: clarification ? { ...response, mode: 'clarify', clarification } : { ...response, mode: 'answer' } }
  }
  const withCalendarDays = normalizeSpokenCalendarDays(input.message)
  if (withCalendarDays !== input.message) input = { ...input, message: withCalendarDays }
  const numericClarification = await prepareUnsafeMoney(input, today)
  if (numericClarification) return numericClarification
  if (!input.pendingClarification && !input.draft && isFocusFresh(input.focus) && input.focus?.last === 'query') {
    const previous = input.focus.lastQueryPlan
    if (previous?.source === 'transactions' && previous.filter.platform && previous.filter.txType?.[0] === 'income') {
      const allApps = normalizeQuery(input.message).match(/^e\s+(hoje|ontem|anteontem|(?:n[ao]|ness[ea]|nest[ea]|ess[ea]|est[ea])\s+(?:semana|mes)(?:\s+passad[oa])?)\s+somando\s+todos\s+os\s+(?:apps|aplicativos)\s*[?.!]*$/)
      if (allApps) input = { ...input, message: `quanto entrou ${allApps[1]} somando todos os apps?` }
    }
  }
  // "Rodei 30 mil km ESSE ANO?", "gastei 500 esse mês?": conferência de um
  // total, não lançamento de um dia (regra 33a). Virava 30.000 km de trabalho
  // hoje, com "Esse mês" de descrição. Vira a consulta do período.
  const conferencia = !input.pendingClarification && !input.pending?.length
    ? input.message.match(/^\s*(?:(?:eu|sera\s+que|será\s+que)\s+)?(gastei|recebi|ganhei|rodei|faturei|fiz|lucrei|paguei)\s+(?:mais\s+de\s+|uns\s+|umas\s+|quase\s+)?(?:r\$\s*)?\d[\d.,]*(?:\s*mil)?\s*(?:reais|km|quil[ôo]metros|corridas|viagens)?\s+((?:n?ess[ea]|n?est[ea])\s+(?:m[eê]s|ano|semana)|no\s+m[eê]s\s+passado|na\s+semana\s+passada|no\s+ano\s+passado)\s*\?\s*$/i) : null
  if (conferencia) {
    const verbo = conferencia[1].toLowerCase() === 'fiz' && /corridas|viagens/i.test(input.message) ? 'quantas corridas eu fiz'
      : conferencia[1].toLowerCase() === 'rodei' ? 'quantos km eu rodei' : `quanto eu ${conferencia[1].toLowerCase()}`
    const out = await orchestrate({ ...entradaBruta, message: `${verbo} ${conferencia[2]}?` })
    if (out.response.mode === 'answer' && !out.response.actions.length) {
      out.response = { ...out.response, reply: `Li como pergunta — nada foi registrado. ${out.response.reply}` }
      return out
    }
  }
  // "Quanto ganhei ontem À TARDE", "quanto ganhei DE MANHÃ": o app guarda a
  // hora em que o valor foi REGISTRADO, não a hora em que aconteceu. "De
  // manhã" virava busca por texto e "à tarde" sumia sem aviso. A pergunta é
  // respondida para o dia inteiro, e a resposta diz isso.
  const parteDoDia = /^\s*(?:e\s+)?(?:quanto|quanta|quantos|quantas|qual|quais)\b/i.test(input.message) && !input.pendingClarification
    ? input.message.match(/\s*,?\s*(?:de|pela|na|à|a|nessa|nesta|essa|esta|hoje\s+(?:de|à|a))\s+(?:manh[ãa]|tarde|noite|madrugada)(?![\wÀ-ÿ])/i) : null
  if (parteDoDia) {
    const semParte = `${input.message.slice(0, parteDoDia.index)} ${input.message.slice((parteDoDia.index || 0) + parteDoDia[0].length)}`.replace(/\s+/g, ' ').trim()
    // Sem dia dito, "de manhã" é de hoje — não do mês inteiro.
    const hojeQ = input.today || todayISO()
    const comDia = findAllDates(semParte, hojeQ).length || parsePeriod(semParte, hojeQ) ? semParte : `${semParte.replace(/[?!.]+$/, '')} hoje`
    const out = await orchestrate({ ...entradaBruta, message: comDia, pendingClarification: undefined })
    if (out.response.mode === 'answer') {
      out.response = { ...out.response, reply: 'Não separo por período do dia: guardo a hora em que cada valor foi registrado, não a hora em que aconteceu. Considerei o dia inteiro.\n\n' + out.response.reply }
    }
    return out
  }
  if (!input.pendingClarification && !input.draft) {
    const history = answerPairedHistory(input.state, input.message, today)
    if (history) return withPendingAnswer(input, { draft: null, focus: history.focus || input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: history.reply },
    }, today, state => answerPairedHistory(state, input.message, today)?.reply)
  }
  // "Gastos dessa semana", "saldo?": pergunta telegráfica vira a pergunta com
  // verbo que o app responde. Resposta a uma opção oferecida fica como está.
  const nominal = input.pendingClarification ? null : perguntaNominal(input.message)
  if (nominal) input = { ...input, message: nominal }
  // "Entrou 500: 300 uber, 200 99": o total com a lista que o soma. Os leitores
  // que rodam antes das cláusulas (dia telegráfico) também precisam da lista.
  const semTotalDito = input.pendingClarification ? input.message : partesDoDia(totalComDoisPontos(input.message))
  if (semTotalDito !== input.message) input = { ...input, message: semTotalDito }
  const caps = buildCapabilities(input.state)
  if (!caps.isDriver && !input.draft && !input.pendingClarification) {
    const partialPayment = await preparePaymentWithRemainder(input, caps, today)
    if (partialPayment) return partialPayment
  }
  if (!input.draft) {
    const rents = prepareRepeatedRent(input, caps, today)
    if (rents) return rents
  }
  if (caps.isDriver && !input.pendingClarification && !input.draft) {
    const rideRevenue = input.message.replace(/^\s*(?:e\s+)?quanto\s+(?:deu|deram)\s+de\s+corridas?\b/i, 'qual foi a receita de corridas')
    if (rideRevenue !== input.message) input = { ...input, message: rideRevenue }
  }
  // "Meu carro faz 10 km por litro e a gasolina tá 6 reais, quanto cobrar por
  // km?": o consumo e o preço ditos são os DADOS da pergunta. Cortada em
  // cláusulas, a pergunta chegava sozinha e a resposta ignorava os dois — ou a
  // frase virava "isso parece um orçamento".
  if (!input.pendingClarification && !input.draft && caps.isDriver) {
    const q = normalizeQuestion(input.message)
    if (PEDE_MINIMO_POR_KM.test(q) && /\d\s*km\s*(?:por\s*)?(?:l\b|litro)/.test(q) && /\d\s*(?:reais\s*)?(?:o|por|cada|\/)\s*(?:o\s*)?litro/.test(q)) {
      const reply = askAssistant(input.state, input.message, { today, message: input.message }).text
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply } }
    }
  }
  const pendingPreview = await previewPendingQuery(input, today)
  if (pendingPreview) return pendingPreview
  if (!input.pendingClarification && !input.draft) {
    const offer = interpretRideOffer(input.state, input.message)
    if (offer) return rideOfferReply(input, offer)
    const view = isFocusFresh(input.focus) && input.focus?.last === 'period-view' ? input.focus.lastPeriodView : undefined
    const said = view ? normalizeQuestion(input.message).replace(/[.!?]+$/, '').trim().match(/^e\s+(.+)$/)?.[1] : undefined
    const period = said ? parsePeriod(said, today) : undefined
    const followUp = view && said && (period?.span ?? period?.matched) === said ? view : undefined
    const appFollowUp = view?.kind === 'ride-apps' && said ? rideAppFollowUp(view.question, said) : undefined
    const question = followUp ? `${followUp.question} ${said}`
      : appFollowUp ? [appFollowUp, view?.periodText].filter(Boolean).join(' ') : input.message
    const kind = followUp?.kind ?? 'ride-apps'
    const readView = (state: AppState) => kind === 'movements' ? listaDeLancamentos(state, question, today) : compareRideApps(state, question, today)
    const reply = readView(input.state)
    if (reply) return withPendingAnswer(input, {
      draft: null, focus: periodViewFocus(input.focus, kind, question, today),
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply },
    }, today, readView)
  }
  if (caps.isDriver) {
    const settlement = prepareRideSettlement(input, caps, today)
    if (settlement) return settlement
    if (!input.draft && !input.pendingClarification) {
      const breakdown = prepareRideReceiptBreakdown(input, caps, today)
      if (breakdown) return breakdown
      const datedShiftWork = await prepareDatedShiftWork(input, caps, today)
      if (datedShiftWork) return datedShiftWork
      const nightShift = await prepareNightShift(input, caps, today)
      if (nightShift) return nightShift
      const roadReport = prepareRoadReport(input, caps, today)
      if (roadReport) return roadReport
      const datedFuel = prepareRideReceiptAndDatedFuel(input, caps, today)
      if (datedFuel) return datedFuel
      const receiptForPeriod = prepareRideReceiptForEarningsPeriod(input, caps, today)
      if (receiptForPeriod) return receiptForPeriod
      const receiptWithHeldCash = await prepareReceiptWithHeldCash(input, caps, today)
      if (receiptWithHeldCash) return receiptWithHeldCash
      const withdrawal = readWalletWithdrawal(input.message, today)
      if (withdrawal) return keepPendingClarification(input, walletWithdrawalClarification(withdrawal))
    }
    const shiftPayout = prepareShiftWithUnpaidPayout(input, caps, today)
    if (shiftPayout) return shiftPayout
    const partialPayout = preparePartialRidePayout(input, caps, today)
    if (partialPayout) return partialPayout
    const datedReceipt = prepareRideReceiptAcrossDates(input, caps, today)
    if (datedReceipt) return datedReceipt
    const wallet = readRideWallet(input.message)
    const heldCash = wallet || readRideDebt(input.message) || readRideDebtAfterActivity(input.message)
    if (heldCash) {
      const note = wallet ? `Você informou ${fmtBRL(wallet.amount)} de saldo na carteira da ${wallet.platform}.` + (wallet.tail ? '' : ' Quando receber, diga quanto caiu na conta e em que dia.')
        : rideDebtNote(heldCash)
      if (heldCash.tail) {
        const rest = await orchestrate({ ...input, message: heldCash.tail, draft: undefined, pendingClarification: undefined })
        return { ...rest, response: { ...rest.response, reply: `${note}\n\n${rest.response.reply}` } }
      }
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: note } }
    }
    const workHours = prepareWorkHoursEdit(input, caps, today)
    if (workHours) return workHours
    if (!input.draft && !input.pendingClarification) {
      const bankReport = prepareDriverBankReport(input, caps, today)
      if (bankReport) return bankReport
      const platformHours = await prepareShiftWithAppHours(input, caps, today)
      if (platformHours) return platformHours
    }
  }
  if (caps.isDriver && /^(?:(?:eu|hoje|ontem|anteontem)\s+)*reservei\b[^?;.!]*\bmas\s+(?:ainda\s+)?n[aã]o\s+paguei[.!]*$/i.test(input.message)
    && guessCategory(input.message, 'expense') === 'aluguel-veiculo') {
    return { draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Quando o pagamento do aluguel do veículo acontecer, diga o valor pago e o dia para preparar o lançamento.' } }
  }
  if (!input.draft && (!input.pendingClarification || input.pendingClarification.field === 'reported-total')) {
    const payout = readPlatformPayout(input.message)
    const reconciled = payout || reconcileSpokenTotals(input.message, today, isDriver(input.state.settings), caps.cardNames)
    const issue = reconciled && 'issue' in reconciled ? reconciled.issue : undefined
    if (issue) {
      const platform = payout && 'description' in payout ? payout.description : undefined
      const workText = reconciled && 'workText' in reconciled ? reconciled.workText : undefined
      const workPlatform = reconciled && 'workPlatform' in reconciled ? reconciled.workPlatform : undefined
      const receiptPlatform = reconciled && 'receiptPlatform' in reconciled ? reconciled.receiptPlatform : undefined
      const dates = platform || workText || receiptPlatform ? findAllDates(input.message, today) : []
      const [date] = dates
      const pendingActions: ParsedAction[] | undefined = (platform || workText || receiptPlatform) && caps.isDriver
        && (!dates.length || (date.kind === 'date' && dates.every(d => d.kind === 'date' && d.date === date.date)))
        ? [{ kind: 'income', amount: 0, category: 'corridas', description: platform || receiptPlatform || workPlatform,
          ...(platform ? { reportedNet: true, feeAlreadyWithheld: true } : {}),
          ...(date?.kind === 'date' ? { date: date.date } : {}) }] : undefined
      const work = workText && pendingActions
        ? await orchestrate({ ...input, message: workText, pending: undefined, pendingClarification: undefined, remoteEnabled: false }) : undefined
      const companions: AssistantCandidateAction[] = work?.response.mode === 'propose_actions' ? work.response.actions : []
      const keepWork = companions.length > 0 && companions.every(item => item.action.kind === 'work')
      const previous = input.pending || []
      const actions = keepWork ? [...previous, ...companions] : []
      return {
        draft: null, keepPending: true, focus: input.focus, correctedPending: keepWork && previous.length ? actions : undefined,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions, unresolved: [],
          reply: actions.length ? `${proposalText(actions, input.state)}\n\n${issue}` : issue,
          clarification: { field: pendingActions ? 'exact-amount' : 'reported-total', question: issue, options: [], pendingActions } },
      }
    }
    if (payout && 'amount' in payout) {
      const result = await orchestrate({ ...input, message: payout.text, remoteEnabled: false })
      const actions: AssistantCandidateAction[] = result.response.actions
      const first = actions.findIndex(({ action }) => action.kind === 'income' && action.amount === payout.amount)
      const initial = actions[first]
      if (initial?.action.kind === 'income') {
        actions[first] = { ...initial, action: { ...initial.action, feeAlreadyWithheld: true } }
      }
      return result
    }
    if (reconciled && 'dateQuestion' in reconciled && reconciled.dateQuestion && reconciled.text) {
      const { question, options, window } = reconciled.dateQuestion
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], reply: question,
          clarification: { field: options?.length ? 'date-choice' : 'date', question, options,
            dateWindow: window, pendingPaymentText: reconciled.text } } }
    }
    if (reconciled && 'text' in reconciled && reconciled.text) input = { ...input, message: reconciled.text }
  }
  const command = input.message
  const due = await purchaseWithFirstDue(input, caps, today)
  if (due) return due

  // ---- 0) A mensagem escolhe uma opção que o assistente ofereceu? --------
  // "GNV" logo depois de "gás de cozinha ou GNV?" precisa recuperar o valor e
  // a descrição da mensagem anterior — o usuário não repete nada.
  const pc = input.pendingClarification
  if (pc?.field === 'night-shift-date' && pc.dateWindow && pc.pendingActions?.length) {
    const nightShift = continueNightShift(input, caps, today, pc)
    if (nightShift) return nightShift
  }
  if (pc?.pendingPaymentText) {
    const said = normalizeName(input.message).replace(/[.!?]+$/, '').trim()
    if (/^(?:cancela(?:r)?|esquece|deixa pra la)$/.test(said)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Certo, descartei esse pagamento.' },
    }
    const choice = pc.options?.find(o => normalizeName(o.label) === said || o.value === said)
    const date = dateInAnswer(choice?.value || input.message, today)
    const resolved = pc.dateWindow ? resolveDayInWindow(input.message, pc.dateWindow, today) : date?.kind === 'date' ? date.date : undefined
    if (resolved) return orchestrate({ ...input, pendingClarification: undefined, message: `em ${resolved} ${pc.pendingPaymentText}` })
    if (!looksPast(input.message) && !looksLikeDataQuestion(input.message)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
        reply: pc.question, clarification: pc },
    }
  }
  if (pc?.field === 'ride-offer' && pc.rideOffer) {
    const offer = continueRideOffer(input.state, pc.rideOffer, input.message)
    if (offer) return rideOfferReply(input, offer)
  }
  if (!pc && !input.pending?.length && input.focus?.lastRideOffer && isFocusFresh(input.focus)) {
    const revista = reviseRideOffer(input.state, input.focus.lastRideOffer, input.message)
    if (revista) return rideOfferReply(input, revista)
  }
  if (pc?.field === 'work-duration' && pc.pendingActions?.length) {
    const said = normalizeNumberWords(input.message).text.trim()
      .replace(/^(?:foram|foi|era|deu|trabalhei)\s+/i, '').replace(/[.!]+$/, '')
    const minutes = elapsedMinutes(said)
    if (minutes) {
      return proposeDatedActions(input, pc.pendingActions.map(a => a.kind === 'work' ? { ...a, hours: minutes / 60 } : a), caps, today)
    }
    if (!looksPast(input.message) && !looksLikeQuestion(input.message)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], clarification: pc, reply: pc.question },
    }
  }
  if (pc?.field === 'clock-time' && pc.pendingActions?.length) {
    const withoutPrefix = input.message.trim().replace(/^(?:foi|era)\s+/i, '')
    const explicit = spokenClock(withoutPrefix)
    const reply = explicit.remaining !== withoutPrefix ? explicit : spokenClock(`às ${withoutPrefix}`)
    const rest = reply.remaining.replace(/^[\s,]+|[\s,.!]+$/g, '')
    const said = rest ? dateInAnswer(rest, today) : undefined
    if (reply.time && !reply.invalid && (!rest || said?.kind === 'date')) {
      const dated = pc.pendingActions.map(a => a.kind === 'expense' || a.kind === 'income'
        ? { ...a, ...(said?.kind === 'date' ? { date: said.date } : {}), time: reply.time } : a)
      if (today !== todayISO() || reply.time <= nowTime() || dated.every(a => !('time' in a) || ('date' in a && a.date && a.date < today))) {
        return proposeDatedActions(input, dated, caps, today)
      }
    }
    if (!looksPast(input.message) && !looksLikeQuestion(input.message)) return {
      draft: null, keepPending: true,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], clarification: pc, reply: pc.question },
    }
  }
  if (pc?.field?.startsWith('pending-correction') && /^(?:cancela(?:r)?|esquece|deixa pra la)[.!]*$/.test(normalizeName(input.message))) {
    return { draft: null,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: 'Descartei a proposta.' },
    }
  }
  if (pc?.field === 'shift-app-hours') {
    const said = normalizeName(input.message).replace(/[.!]+$/, '').trim()
    const option = pc.options?.find(item => normalizeName(item.label) === said)
    const minutes = input.message.includes('?') ? undefined : reportedWorkMinutes(said.replace(/\s+no\s+total$/, ''))
    const work = pc.pendingActions?.find(action => action.kind === 'work')
    const actions = option?.actions || (work && minutes ? [{ ...work, hours: minutes / 60 }] : undefined)
    if (actions?.length && (input.pending?.length || 0) + actions.length <= MAX_ACTIONS_PER_BATCH) {
      return proposeDatedActions(input, actions, caps, today, true)
    }
    if (/^(?:cancela(?:r)?|esquece|deixa pra la)$/.test(said)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Deixei as horas da jornada em aberto.' },
    }
    const query = looksLikeQuestion(input.message) && looksLikeDataQuestion(input.message) ? respostaLocal(input.state, input.message, today, true) : undefined
    if (query) return { ...keepPendingClarification(input, pc, query.text + '\n\n' + pc.question), focus: query.focus || input.focus }
    const corrected = await correctPendingKeepingClarification(input, command, pc, caps, today)
    return corrected || keepPendingClarification(input, pc)
  }
  if ((pc?.field === 'ride-payout-date-part' || pc?.field === 'driver-bank-pix')
    && /^(?:cancela(?:r)?|esquece|deixa pra la)[.!]*$/.test(normalizeName(input.message))) {
    return { draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Deixei esse repasse em aberto.' },
    }
  }
  if (pc?.field === 'ride-payout-date-part') {
    const [paid, part] = (pc.pendingActions || []).filter(action => action.kind === 'income')
    if (!paid || !part) return keepPendingClarification(input, pc)
    const said = normalizeName(input.message).replace(/[.!]+$/, '').trim()
    const inclusion = partialRidePayoutChoice(input.message, paid.amount, part.amount)
    const choice = inclusion === 'included' ? 'included'
      : /^(?:foram dois (?:pagamentos|repasses)|foi outro repasse)$/.test(said) ? 'separate' : undefined
    const picked = pc.options?.find(option => option.value === choice || normalizeName(option.label) === said)
    if (picked?.actions?.length) return proposeDatedActions(input, picked.actions, caps, today, true)
    return keepPendingClarification(input, pc)
  }
  if (pc?.field === 'driver-bank-pix') {
    const account = pc.pendingActions?.find(action => action.kind === 'income')
    const said = normalizeName(input.message).replace(/[.!]+$/, '').trim()
    if (/^(?:(?:foi|era)(?:\s+so)?\s+|so\s+)?(?:o\s+)?saldo(?:\s+da\s+conta)?$/.test(said)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Entendi que o valor informado era o saldo da conta.' },
    }
    if (account && !input.message.includes('?')) {
      const { platform, receipt, value, dates, receiptDay } = readPayoutReceiptAnswer(input.message, today)
      const identifiesPix = /^(?:(?:sim,?\s+)?(?:foi\s+)?(?:um\s+|o\s+)?pix)?$/.test(receipt)
      if (platform && (value > 0 || identifiesPix)) {
        const amount = value > 0 ? value : account.amount
        const action: ParsedAction = { kind: 'income', amount, description: platform, category: 'corridas' }
        if (dates.length === 1 && receiptDay.kind === 'date') {
          return proposeDatedActions(input, [{ ...action, date: receiptDay.date }], caps, today, true)
        }
        return keepPendingClarification(input, { field: 'ride-payout-date', question: payoutReceiptDateQuestion(amount), pendingActions: [action] })
      }
    }
    if (looksLikeDataQuestion(input.message)) {
      const query = respostaLocal(input.state, input.message, today, true)
      if (query) return { ...keepPendingClarification(input, pc, query.text + '\n\n' + pc.question), focus: query.focus || input.focus }
    }
    return keepPendingClarification(input, pc)
  }
  if (pc?.field === 'ride-payout-date') {
    const said = normalizeName(input.message).replace(/[.!]+$/, '').trim()
    const date = input.message.includes('?') ? undefined : dateInAnswer(weekdayChoiceWord(input.message), today)
    if (date?.kind === 'date' && pc.pendingActions?.length) {
      return proposeDatedActions(input, withDate(pc.pendingActions, date.date), caps, today, true)
    }
    if (/^(?:cancela(?:r)?|esquece|deixa pra la)[.!]*$/.test(normalizeName(input.message))) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Deixei esse repasse em aberto.' },
    }
    if (date?.kind === 'future') return keepPendingClarification(input, pc)
    const payout = pc.pendingActions?.find(action => action.kind === 'income')
    if (payout && !input.message.includes('?')) {
      const receipt = readPayoutReceiptAnswer(input.message, today)
      const amount = receipt.value ?? exactMoneyAnswer(said.replace(/^(?:nao,?\s+)?(?:(?:o\s+)?valor\s+(?:e|foi)\s+)?/, ''))
      if (amount !== undefined || receipt.noPayment) {
        if (receipt.platform && payout.description && receipt.platform !== payout.description) {
          return keepPendingClarification(input, pc, `O repasse em aberto foi informado como ${payout.description}. ${pc.question}`)
        }
        if (amount === 0 || receipt.noPayment) return noRidePayment(input)
        const limit = pc.rideReceiptLimit
        if (!(amount > 0) || (limit !== undefined && amount > limit)) {
          const reason = limit !== undefined ? `Informe um valor recebido de até ${fmtBRL(limit)}.` : 'Informe quanto você recebeu.'
          return keepPendingClarification(input, pc, reason + ' ' + pc.question)
        }
        const next = { ...payout, amount, description: receipt.platform || payout.description }
        if (receipt.dates.length === 1 && receipt.receiptDay.kind === 'date') {
          return proposeDatedActions(input, [{ ...next, date: receipt.receiptDay.date }], caps, today, true)
        }
        return keepPendingClarification(input, { ...pc, question: payoutReceiptDateQuestion(amount), pendingActions: [next] })
      }
    }
    const corrected = await correctPendingKeepingClarification(input, command, pc, caps, today)
    if (corrected) return corrected
    return keepPendingClarification(input, pc)
  }
  if (pc?.field === 'ride-settlement-app' || pc?.field === 'ride-settlement-match' || pc?.field === 'ride-shift-payout' || pc?.field === 'ride-multi-source') {
    const said = normalizeName(normalizeNumberWords(input.message).text).replace(/[.!]+$/, '').trim()
    const app = said.match(/^(?:foi\s+)?(?:(?:[ao]|d[ao]|n[ao]|pel[ao])\s+)?(.+)$/)?.[1]
    let choice: string | undefined
    if (pc.field === 'ride-settlement-app' || pc.field === 'ride-multi-source') choice = app
    if (pc.field === 'ride-shift-payout') {
      const includedApp = said.match(/^(?:(?:ja\s+)?(?:esta|estao|ta|e|foi)\s+)?(?:incluid[oa]s?|dentro)\s+(?:n[ao]|d[ao])\s+(.+)$/)?.[1]
      const amountOutside = /\d/.test(said) && partialRidePayoutChoice(said, undefined, pc.rideShiftUnpaid) === 'excluded'
      choice = amountOutside || /^(?:(?:e|sao|foi|foram)\s+)?(?:por\s+fora|a\s+parte|a\s+mais)$/.test(said) ? 'excluded' : includedApp || app
    }
    if (pc.field === 'ride-settlement-match') {
      if (/^(?:(?:e|foi|era)\s+)?(?:o\s+)?mesmo(?:\s+(?:valor|repasse))?$/.test(said)) choice = 'same'
      if (/^(?:(?:e|foi|era)\s+)?(?:um\s+)?(?:outro(?:\s+repasse)?|repasse\s+separado|separados?)$/.test(said)) choice = 'separate'
    }
    if (choice && /^in\s*drive[r]?$/.test(choice)) choice = 'indrive'
    const picked = pc.options?.find(option => option.value === choice || normalizeName(option.label) === said)
    if (!picked && pc.field === 'ride-multi-source' && choice) {
      const platform = readRidePayoutApp(choice)
      const receipt = pc.options?.[0]?.actions?.find(action => action.kind === 'income')
      if (platform && receipt) return proposeDatedActions(input, [
        ...(pc.pendingActions || []), { ...receipt, description: platform },
      ], caps, today)
    }
    if (picked?.actions) {
      if (pc.field === 'ride-multi-source') {
        const receipt = picked.actions.find(action => action.kind === 'income')
        const before = pc.pendingActions || []
        const linked = before.find(action => action.kind === 'income' && action.description === receipt?.description)
        if (receipt && linked?.kind === 'income') {
          const others = before.filter(action => action !== linked)
          if (pc.rideSettlementRelation === 'separate') return proposeDatedActions(input, [...before, receipt], caps, today)
          if (pc.rideSettlementRelation === 'same' && receipt.amount <= linked.amount) {
            return proposeDatedActions(input, [...others, receipt], caps, today)
          }
          return keepActionsAwaitingClarification(input, proposeDatedActions(input, others, caps, today), payoutLinkChoice(linked, receipt))
        }
      }
      if (pc.field === 'ride-settlement-app') {
        const prior = pc.pendingActions?.find(action => action.kind === 'income')
        const receipt = picked.actions.find(action => action.kind === 'income')
        if (prior && receipt) return keepPendingClarification(input, payoutLinkChoice(prior, receipt))
      }
      return proposeDatedActions(input, picked.actions, caps, today, true)
    }
    if (/^(?:cancela(?:r)?|esquece|deixa pra la)$/.test(said)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'Deixei esse repasse em aberto.' },
    }
    if (pc.field === 'ride-shift-payout') {
      const split = allocateUnpaidShift(input, pc, said, caps, today)
      if (split) return split
    }
    const corrected = await correctPendingKeepingClarification(input, command, pc, caps, today)
    if (corrected) return corrected
    if (looksPast(input.message) && !looksLikeQuestion(input.message)) return orchestrate({ ...input, pendingClarification: undefined })
    return { draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
        clarification: pc, reply: pc.question },
    }
  }
  if (pc?.field === 'ride-payout-inclusion') {
    const said = normalizeName(input.message).replace(/[.!]+$/, '').trim()
    if (/^(?:cancela(?:r)?|esquece|deixa pra la)$/.test(said)) return {
      draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: input.pending?.length ? 'Deixei a receita em aberto. Os itens da proposta ainda precisam de confirmação.' : 'Deixei a receita em aberto.' },
    }
    const receiptCheck = pc.rideReceiptCheck
    const inclusionOptions = receiptCheck ? receiptCheck.previousOptions : pc.options
    if (receiptCheck && /^(?:sim(?:,?\s+caiu)?|isso(?: mesmo)?|foi o repasse)$/.test(said)) {
      return proposeDatedActions(input, [receiptCheck.action], caps, today, true)
    }
    if (receiptCheck && /^(?:nao(?:,?\s+era (?:o )?saldo)?|(?:era|foi) (?:o )?saldo|so o saldo)$/.test(said)) {
      const question = receiptCheck.previousQuestion
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
          reply: question, clarification: { ...pc, question, options: inclusionOptions, rideReceiptCheck: undefined } },
      }
    }
    const income = (inclusionOptions?.find(o => o.value === 'excluded')?.actions || pc.pendingActions)?.find(a => a.kind === 'income')
    const total = income?.amount
    const { dates, receiptDay, undated, platform, receipt, value, noPayment } = readPayoutReceiptAnswer(input.message, today)
    const clarify = (reply: string, clarification = pc) => keepPendingClarification(input, clarification, reply)
    if (input.message.includes('?') && (value !== undefined || noPayment)) {
      return clarify(`Para propor esse repasse, diga o valor que realmente entrou e o dia. ${pc.question}`)
    }
    if ((value !== undefined || noPayment) && platform && income?.description && platform !== income.description) {
      return clarify(`O repasse em aberto foi informado como ${income.description}. ${pc.question}`)
    }
    if (value === 0 || noPayment) return noRidePayment(input)

    const dateIsUsable = !dates.length || (dates.length === 1 && receiptDay.kind === 'date')
    const date = receiptDay?.kind === 'date' ? receiptDay.date : income?.date
    if (income && value !== undefined && value > 0) {
      if (value > income.amount) return clarify(`Esse valor passa dos ${fmtBRL(income.amount)} que você informou para essas corridas. ${pc.question}`)
      const action = { ...income, amount: value, date, description: platform || income.description }
      if (!dateIsUsable) {
        return keepPendingClarification(input, { field: 'ride-payout-date', question: payoutReceiptDateQuestion(value),
          pendingActions: [action], rideReceiptLimit: income.amount })
      }
      return proposeDatedActions(input, [action], caps, today, true)
    }
    const balance = statedAccountBalance(undated)
    if (balance !== undefined && !input.message.includes('?')) {
      const question = receiptCheck?.previousQuestion || pc.question
      const when = dateIsUsable && receiptDay?.kind === 'date' ? ` em ${brDate(receiptDay.date)}` : ''
      return clarify(`Você informou ${fmtBRL(balance)} de saldo na conta${when}.\n\n${question}`,
        { ...pc, question, options: inclusionOptions, rideReceiptCheck: undefined })
    }
    const accountAmount = exactMoneyAnswer(receipt.match(/^(.+?)\s+na\s+(?:minha\s+)?conta$/)?.[1] || '')
    if (income && accountAmount !== undefined && accountAmount > 0 && accountAmount <= income.amount && !platform && dateIsUsable && !input.message.includes('?')) {
      const question = `Esses ${fmtBRL(accountAmount)}${date ? ` de ${brDate(date)}` : ''} foram recebidos nesse repasse? Se era o saldo da conta, diga “era o saldo”.`
      const action = { ...income, amount: accountAmount, date }
      return clarify(question, { ...pc, question, options: [{ label: 'Sim, caiu', value: 'sim' }, { label: 'Era o saldo', value: 'era o saldo' }],
        rideReceiptCheck: { action, previousQuestion: receiptCheck?.previousQuestion || pc.question, previousOptions: inclusionOptions } })
    }
    const included = inclusionOptions?.find(o => o.value === 'included')
    const received = included?.actions?.find(a => a.kind === 'income')?.amount || 0
    const unpaid = included && total !== undefined ? (Math.round(total * 100) - Math.round(received * 100)) / 100 : undefined
    const choice = partialRidePayoutChoice(input.message, total, unpaid)
    const option = inclusionOptions?.find(o => o.value === choice || normalizeName(o.label) === said)
    if (option) {
      if (option.actions?.length) return proposeDatedActions(input, option.actions, caps, today, true)
      return { draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
          reply: option.reply },
      }
    }
    const corrected = await correctPendingKeepingClarification(input, command, pc, caps, today)
    if (corrected) return corrected
    if (value == null && looksPast(input.message) && !looksLikeQuestion(input.message)) return orchestrate({ ...input, pendingClarification: undefined })
    const query = looksLikeQuestion(input.message) && looksLikeDataQuestion(input.message) ? respostaLocal(input.state, input.message, today, true) : undefined
    return { draft: null, keepPending: true, focus: query?.focus || input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
        clarification: pc, reply: query ? query.text + '\n\n' + pc.question : pc.question },
    }
  }
  if (pc?.field === 'financial-event' && pc.financialEvent) {
    const respondida = answerFinancialEvent(input, pc, caps, today)
    if (respondida) return respondida
    // Fato novo: a pergunta antiga sai e a mensagem é lida do zero.
    return orchestrate({ ...input, pendingClarification: undefined })
  }
  if (pc?.field === 'query-range-end' && pc.dateWindow && pc.queryTemplate) {
    const said = input.message.replace(/^\s*at[ée]\s+/i, '')
    const date = dateInAnswer(weekdayChoiceWord(said), today)
    if (date?.kind === 'date' && date.date >= pc.dateWindow.from && date.date <= pc.dateWindow.to) {
      const lookup = respostaLocal(input.state, pc.queryTemplate.replace('%DATE%', date.date), today, true)
      if (lookup) return {
        draft: null, keepPending: true, focus: lookup.focus || input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: lookup.text },
      }
    }
    if (!looksLikeDataQuestion(input.message) && !looksPast(input.message)) return {
      draft: null, keepPending: true,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], clarification: pc, reply: pc.question },
    }
  }
  if (pc?.field === 'query-date' && pc.queryTemplate && pc.options?.length) {
    const said = normalizeName(input.message).replace(/[.!?]+$/g, '').trim()
    const date = dateInAnswer(weekdayChoiceWord(input.message), today)
    const choice = pc.options.find(o => normalizeName(o.label) === said || o.value === said
      || ((date?.kind === 'date' || date?.kind === 'future') && date.date === o.value))
    if (choice) {
      const query = pc.queryTemplate.replace('%DATE%', choice.value)
      const response = respostaLocal(input.state, query, today, true)
      return {
        draft: null, keepPending: true, focus: response?.focus || input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
          reply: response?.text || 'O dia foi selecionado. Reformule a pergunta com esse dia para eu consultar.' },
      }
    }
    if (!looksLikeQuestion(input.message) && !looksPast(input.message)) return {
      draft: null, keepPending: true,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
        clarification: pc, reply: pc.question },
    }
  }
  if (pc?.field === 'exact-amount' && pc.pendingActions?.length) {
    const amount = exactMoneyAnswer(input.message)
    if (amount > 0) {
      return proposeDatedActions(input, pc.pendingActions.map(a => a.kind === 'income' || a.kind === 'expense' || a.kind === 'saving'
        ? { ...a, amount } : a), caps, today)
    }
    if (!looksPast(input.message) && !looksLikeQuestion(input.message)) return {
      draft: null, keepPending: true,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
        actions: [], unresolved: [], clarification: pc, reply: pc.question },
    }
  }
  if (pc?.options?.length) {
    const said = normalizeName(input.message)
    const financialEvent = pc.field === 'financial-event'
    const fixedBillChoice = pc.field === 'recurring-occurrence'
    const fixedBillLink = pc.field === 'recurring-link'
    const invoiceChoice = pc.field === 'invoice-reference'
    const dateChoice = pc.field === 'date' || pc.field === 'date-choice'
    const amountChoice = pc.field === 'amount-choice'
    const directionChoice = pc.field === 'money-direction'
    const gasChoice = pc.field === 'gas-kind' || pc.field === 'gas-kind-needs-date'
    const pendingCorrection = pc.field?.startsWith('pending-correction')
    // Para dinheiro, só uma resposta inequívoca aceita a ação antiga. "assim"
    // contém "sim", e "sim, mandei só 10" altera o valor da proposta.
    const simpleAnswer = said.replace(/[.!?]+$/g, '').trim()
    const negativeAnswer = financialEvent && /^(?:nao|nem)(?:\b|$)/.test(simpleAnswer)
    const amount = amountChoice ? exactMoneyAnswer(input.message, pc.options.some(o => o.actions?.some(a => a.kind === 'balance'))) : undefined
    const correctionChoice = pendingCorrection ? pendingCorrectionAnswer(pc, input.message, today) : undefined
    const direction = directionChoice && /^(?:foi\s+)?(?:gasto|despesa|saiu|gastei)$/.test(simpleAnswer) ? 'saida'
      : directionChoice && /^(?:foi\s+)?(?:receita|recebi|entrou|recebimento)$/.test(simpleAnswer) ? 'entrada' : undefined
    const kitchenGas = gasChoice && /\b(?:cozinha|botijao|glp)\b/.test(simpleAnswer)
    const vehicleGas = gasChoice && /\b(?:gnv|gas\s+veicular|gas\s+do\s+carro)\b/.test(simpleAnswer)
    const gasLabel = kitchenGas !== vehicleGas && !/\b(?:nao|nem)\b/.test(simpleAnswer)
      ? kitchenGas ? 'gas de cozinha' : 'gnv' : undefined
    // "Horário ou mais um gasto?": a resposta raramente repete o rótulo.
    // "Foi o horário", "1", "era hora" escolhem a primeira; "mais 30 na
    // padaria", "outro gasto", "2" escolhem a segunda. Sem casar, NÃO cai no
    // parser: "mais 30 na padaria" sozinho virava uma despesa solta de R$ 30.
    if (pc.field === 'minute-or-amount' && pc.options?.length === 2) {
      const r = simpleAnswer
      const horario = /^(?:1|primeira|a\s+primeira|opcao\s+1)$|\b(?:horario|hora|minutos?|era\s+(?:a\s+)?hora|foi\s+(?:a\s+|o\s+)?hora)\b/.test(r)
      const lugar = normalizeName(pc.options[1].label).split(' ').filter(w => w.length > 3).slice(-1)[0]
      const valor = /^(?:2|segunda|a\s+segunda|opcao\s+2)$|\b(?:mais|outro|outra|separad[oa]s?|tambem|valor|reais|gasto|gastei|paguei|despesa|compra)\b/.test(r)
        || (!!lugar && new RegExp(`\\b${lugar}\\b`).test(r))
      if (horario !== valor) {
        const escolhida = pc.options[horario ? 0 : 1]
        const lote: ParsedAction[] = []
        for (const action of escolhida.actions || []) {
          const checked = validateAction(action, caps, today)
          if (isValidationFailure(checked)) {
            return {
              draft: null,
              response: {
                version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
                reply: `Não consegui preparar esse registro: ${checked.detail || checked.code}. Conte o valor e o que aconteceu de novo.`,
              },
            }
          }
          lote.push(checked.action)
        }
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: lote.map(a => candidate(a, 'local')), unresolved: [],
            reply: `Entendi isso:\n\n${lote.map(a => `• ${describeAction(a)}${(a as any).time ? ` · ${(a as any).time}` : ''}`).join('\n')}\n\nConfirmar?`,
          },
        }
      }
      return {
        draft: null, keepPending: true,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [], clarification: pc, reply: `${pc.question}\n\nResponda "horário" ou "mais um gasto".`,
        },
      }
    }
    const hit = invoiceChoice ? matchInvoiceChoice(pc.options, input.message) : pc.options.find(o => amountChoice
      ? (normalizeName(o.label) === simpleAnswer || (amount !== undefined && amount === parseMoney(o.label)))
      : gasChoice ? normalizeName(o.label) === gasLabel && !looksPast(input.message) && !looksLikeQuestion(input.message)
      : financialEvent || fixedBillChoice || fixedBillLink || dateChoice || pendingCorrection || directionChoice
      ? (normalizeName(o.label) === simpleAnswer || normalizeName(o.value) === simpleAnswer
        || (correctionChoice !== undefined && normalizeName(o.value) === correctionChoice)
        || (direction !== undefined && normalizeName(o.label) === direction)
        || (negativeAnswer && normalizeName(o.label) === 'nao'))
      : (normalizeName(o.label) === said || normalizeName(o.value) === said ||
        (said.length > 2 && (normalizeName(o.label).includes(said) || said.includes(normalizeName(o.label))))))
    if (hit) {
      if (dateChoice && hit.actions?.length) return proposeDatedActions(input, hit.actions, caps, today)
      if (gasChoice && hit.actions?.length) {
        if (pc.field === 'gas-kind') return proposeDatedActions(input, hit.actions, caps, today, true)
        const date = dateInAnswer(input.message, today)
        if (date?.kind === 'date' && (!pc.dateWindow || (date.date >= pc.dateWindow.from && date.date <= pc.dateWindow.to))) {
          return proposeDatedActions(input, withDate(hit.actions, date.date), caps, today, true)
        }
        const question = 'Em que dia foi esse gasto?'
        return { draft: null, keepPending: true, focus: input.focus, response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [], reply: question,
          clarification: { field: 'date', question, pendingActions: hit.actions, dateWindow: pc.dateWindow },
        } }
      }
      if (hit.actions?.length) {
        const validated: ParsedAction[] = []
        for (const action of hit.actions) {
          const checked = validateAction(action, caps, today)
          if (isValidationFailure(checked)) {
            return {
              draft: null,
              keepPending: pc.field === 'financial-event',
              response: {
                version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
                actions: [], unresolved: [],
                reply: `Não consegui preparar esse registro: ${checked.detail || checked.code}. Conte o valor e o que aconteceu de novo.`,
              },
            }
          }
          validated.push(checked.action)
        }
        const previous = financialEvent || fixedBillChoice || fixedBillLink || invoiceChoice || amountChoice || directionChoice ? input.pending || [] : []
        if (fixedBillChoice && validated.length === 1 && validated[0].kind === 'recurring-confirm') {
          const link = recurringLinkChoice(input.state, validated[0], today)
          if (link) return {
            draft: null, keepPending: true,
            response: {
              version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
              actions: [], unresolved: [], clarification: link, reply: link.question,
            },
          }
        }
        return proposeClarifiedActions(input.state, validated, today, previous)
      }
      // Escolha que significa NÃO REGISTRAR ("é um plano"): a explicação já vem
      // pronta na opção, para o usuário não ficar sem saber por que nada foi
      // lançado.
      if (hit.reply) {
        return {
          draft: null,
          keepPending: financialEvent || dateChoice,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
            actions: [], unresolved: [], reply: hit.reply,
          },
        }
      }
      // Opção sem efeito pré-calculado (ex.: escolha de cartão): a resposta
      // segue o fluxo normal já com o valor escolhido embutido na frase.
    }
    if (financialEvent) {
      return {
        draft: null, keepPending: true,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
          actions: [], unresolved: [],
          reply: 'Entendi que você acrescentou ou corrigiu algo. Para não registrar valor ou data errados, diga em uma frase completa o que realmente aconteceu, com valor e data.',
        },
      }
    }
    if ((invoiceChoice || fixedBillLink || amountChoice || pendingCorrection || directionChoice || gasChoice) && !looksPast(input.message) && !looksLikeQuestion(input.message)) {
      return {
        draft: null, keepPending: true,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [], clarification: pc,
          reply: `Escolha uma das opções abaixo. Se o valor ou a data mudou, descreva o que aconteceu em uma frase completa. ${pc.question}`,
        },
      }
    }
  }

  // ---- 1) A mensagem responde "que dia foi?" dentro de um período? ------
  // "mês passado" + "dia 10" só pode virar 10 do mês passado. Fora da janela a
  // pergunta continua aberta — nada é aproximado e nada cai em hoje.
  if (pc?.field === 'date' && pc.dateWindow && pc.pendingActions?.length) {
    const iso = resolveDayInWindow(input.message, pc.dateWindow, today)
    if (iso) {
      return proposeDatedActions(input, withDate(pc.pendingActions, iso), caps, today)
    }
    // Resposta inválida ou fora da janela: a pergunta continua aberta. Cair no
    // fluxo comum descartava `pendingClarification`; pior, uma data completa de
    // outro mês podia ser reduzida ao número do dia e reinterpretada.
    const from = brDate(pc.dateWindow.from)
    const to = brDate(pc.dateWindow.to)
    return {
      draft: null, keepPending: true,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
        actions: [], unresolved: [],
        clarification: pc,
        reply: `Essa data é inválida ou fica fora do período que você informou (${from} a ${to}). ${pc.question}`,
      },
    }
  }

  // ---- 2) A mensagem corrige uma data inválida? ------------------------
  // A ação original fica guardada, mas só volta a ser proposta quando a nova
  // data for válida e já tiver acontecido. Futuro volta ao esclarecimento de
  // plano; entrada ainda inválida mantém a mesma pergunta aberta.
  if ((pc?.field === 'date' || pc?.field === 'date-choice') && !pc.dateWindow && pc.pendingActions?.length) {
    const said = normalizeName(input.message).replace(/[.!?]+$/g, '').trim()
    const option = pc.options?.find(o => normalizeName(o.label) === said || normalizeName(o.value) === said)
    const corrected = dateInAnswer(option?.value || input.message, today)
    if (corrected?.kind === 'date') {
      return proposeDatedActions(input, withDate(pc.pendingActions, corrected.date), caps, today)
    }
    if (corrected?.kind === 'future') {
      const clarification = temporalClarification({
        kind: 'future', text: corrected.text, label: corrected.label,
        date: corrected.date, relative: corrected.relative,
        imprecise: corrected.imprecise, actions: pc.pendingActions,
        conflict: true,
      })
      clarification.purchaseDueText = pc.purchaseDueText
      return {
        draft: null, keepPending: true,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [], clarification, reply: clarification.question,
        },
      }
    }
    // Sem data na resposta e com um RELATO novo ("recebi 200 do João"), a
    // pergunta de data cai: repeti-la engolia o lançamento seguinte.
    if (!corrected && /^\s*(?:(?:eu|hoje|ontem|ja)\s+)?(?:gastei|paguei|recebi|ganhei|comprei|abasteci|vendi|transferi|guardei|fiz|rodei|tirei|entrou|caiu)\b/i.test(input.message)
      && analyzeMessage(input.message, { driver: caps.isDriver, today }).clauses.some(c => c.actions.length > 0)) {
      return orchestrate({ ...input, pendingClarification: undefined })
    }
    return {
      draft: null, keepPending: true,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
        actions: [], unresolved: [], clarification: pc,
        reply: `Ainda não consegui entender uma data válida. ${pc.question}`,
      },
    }
  }

  // ---- 3) Resposta que não é opção da pergunta de CATEGORIA ------------
  // A pergunta de categoria é um refinamento opcional: o usuário já disse que
  // gastou. Se ele responde "sei lá", a resposta certa é registrar com a
  // categoria genérica — não perder o lançamento porque uma pergunta que o
  // próprio app fez ficou sem resposta.
  if (pc?.field === "category" && pc.pendingActions?.length) {
    const cands = pc.pendingActions.map(a => candidate(a, "local"))
    return {
      draft: null,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: "propose_actions", engine: "local",
        actions: cands, unresolved: [],
        reply: `Sem problema — deixei em Outros, e você pode trocar a categoria no card.

${proposalText(cands, input.state)}

Confirmar?`,
      },
    }
  }

  // ---- 4) A mensagem responde a uma pergunta pendente? -------------------
  // Um RELATO novo, com verbo e valor próprios, não é a resposta do rascunho:
  // depois de "recebi meu salário" → "qual foi o valor?", "gastei com uber 25
  // e ifood 40" virava R$ 25 de salário, e as duas despesas sumiam.
  const relatoNovo = isDraftFresh(input.draft)
    && /^\s*(?:(?:eu|hoje|ontem|ja|já)\s+)?(?:gastei|paguei|recebi|ganhei|comprei|abasteci|vendi|transferi|guardei|rodei|tirei)\b/i.test(input.message)
    && (() => {
      // Uma única ação do MESMO tipo ("recebi 3500" depois de "recebi meu
      // salário") ainda é a resposta do rascunho.
      const novas = analyzeMessage(input.message, { driver: caps.isDriver, today }).clauses.flatMap(c => c.actions)
      return novas.length > 1 || (novas.length === 1 && novas[0].kind !== input.draft!.partial.kind)
    })()
  if (isDraftFresh(input.draft) && !relatoNovo) {
    const placement = input.draft?.companion
    const before = input.pending?.filter(p => placement?.before.includes(p.id)) ?? []
    const after = input.pending?.filter(p => placement?.after.includes(p.id)) ?? []
    const companion = [...before, ...after]
    const res = resolveDraftAnswer(input.draft!, input.message, caps, today)
    if (!res.unmatched) {
      if (res.draft.status === 'ready') {
        // O rascunho também passa pelo vocabulário do usuário: "gastei no zé da
        // esquina" → "35" tem que sair com a MESMA categoria e a MESMA grafia
        // que os outros lançamentos daquele lugar, senão o histórico se divide
        // e o próprio aprendizado enfraquece.
        const v = validateAction(withLearnedCategory(input.state, res.draft.partial as ParsedAction, today), caps, today)
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
        if (companion.length) {
          if (companion.length >= MAX_ACTIONS_PER_BATCH) return preparedActionResponse(input.state, {
            actions: [], clarification: undefined, notes: ['Confirme alguns itens antes de acrescentar esta compra.'],
          }, companion)
          const actions = [...before, candidate(v.action, 'local'), ...after]
          const output = preparedActionResponse(input.state, { actions, notes: [], clarification: undefined })
          return { ...output, correctedPending: actions }
        }
        const cand = [candidate(v.action, 'local')]
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cand, unresolved: [],
            reply: `${proposalText(cand, input.state)}\n\nConfirmar?`,
          },
        }
      }
      const nextQ = res.draft.missingFields[0]
      return {
        draft: res.draft, keepPending: companion.length > 0,
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

  // ---- 4b) "Não, foi no cartão" sobre a despesa na tela -----------------
  // A compra no crédito nunca é despesa avulsa (regra 10): a proposta vira o
  // rascunho de compra no cartão, como se a frase tivesse dito isso de início.
  if (input.pending?.length === 1 && input.pending[0].action.kind === 'expense'
    && /^\s*(?:n[ãa]o\s*[,.]?\s*)?(?:foi\s+|era\s+|paguei\s+|passei\s+)?(?:no|na|pelo|pela)\s+[\p{L}\s]{3,40}[.!]*\s*$/iu.test(command)) {
    const compra = compraNoCartao(command, input.pending, caps, today)
    if (compra) {
      const d = newDraft(compra, input.message, caps)
      d.fallbackExpense = { ...input.pending[0].action }
      const q = { ...d.missingFields[0] }
      if (q.field === 'installments') q.question = 'Em quantas parcelas? Se foi à vista, diga "à vista"; se foi no débito, diga "débito".'
      return {
        draft: d,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
          clarification: { question: q.question, field: q.field, options: q.options },
          reply: q.question,
        },
      }
    }
  }

  // ---- 4c) "Em 10x" sobre a despesa na tela ------------------------------
  // "Comprei um celular" → "1200" → "em 10x": o parcelamento dito DEPOIS da
  // proposta caía na ajuda, e a compra ficava como despesa avulsa (regra 10).
  if (input.pending?.length === 1 && input.pending[0].action.kind === 'expense') {
    const cmd = normalizeName(command).replace(/[.!]+$/, '').trim()
    const m = cmd.match(/^(?:foi\s+|era\s+|paguei\s+|parcelei\s+|passei\s+|dividi\s+|na\s+verdade\s+)?(?:parcelad[oa]\s+)?(?:em\s+)?(\d{1,3})\s*(?:x|vezes|parcelas)(?:\s+(?:no|na|pelo|pela)\s+(?:cartao\s+)?([a-z0-9 ]{2,30}?))?$/)
    const n = m ? Number(m[1]) : 0
    if (m && n >= 2 && n <= 120) {
      const a: any = input.pending[0].action
      const dito = m[2]?.trim()
      const cartao = dito ? caps.cardNames.find(c => normalizeName(c) === dito || normalizeName(c).includes(dito)) : undefined
      const partial: any = { kind: 'card-purchase', total: a.amount, installments: n,
        ...(a.date ? { date: a.date } : {}),
        ...(a.description ? { description: a.description } : {}),
        ...(a.category && a.category !== 'outros-out' ? { category: a.category === 'assinaturas' ? 'compras' : a.category } : {}),
        ...(cartao ? { cardName: cartao } : {}) }
      if (cartao || caps.cardNames.length <= 1) {
        return proposeClarifiedActions(input.state, [partial], today)
      }
      const d = newDraft({ partial, missing: ['cardName'] }, input.message, caps)
      d.fallbackExpense = { ...a }
      const q = d.missingFields[0]
      return {
        draft: d,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
          clarification: { question: q.question, field: q.field, options: q.options },
          reply: q.question,
        },
      }
    }
  }

  // ---- 5) A mensagem corrige a proposta na tela? -------------------------
  // "Pode confirmar", "sim", "isso": o registro só acontece no BOTÃO (regra 8).
  // Antes a frase caía na ajuda genérica, e parecia que o app tinha perdido a
  // proposta. Ela continua na tela.
  const shortDriverAck = caps.isDriver && /^\s*(?:s{1,2}(?:\s+manda)?|pode|sim,?\s+valeu)\s*[.!]*\s*$/i.test(command)
  const typedConfirmation = /^\s*(?:pode\s+)?(?:confirm[ao]r?|confirma\s+(?:a[íi]|isso|tudo)|sim|isso(?:\s+mesmo)?|ok|beleza|blz|certo|correto|t[áa]\s+certo|pode\s+(?:salvar|registrar|lan[çc]ar|mandar)|salva|registra|lan[çc]a)\s*[.!]*\s*$/i.test(command)
  if (input.pending?.length && (shortDriverAck || typedConfirmation)) {
    return {
      draft: null, keepPending: true, focus: input.focus,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'É só tocar em Confirmar na proposta acima — eu só registro pelo botão, para nada entrar sem você ver.',
      },
    }
  }
  if (input.pending?.length && caps.isDriver && /^(?:n|nao)(?:\s+cancela(?:r)?(?:\s+a\s+proposta)?)?[.!]*$/.test(normalizeName(command))) {
    return { draft: null, keepPending: true, focus: input.focus,
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
        reply: 'A proposta continua na tela. Para corrigir, diga qual item muda. Para remover tudo, diga “cancela a proposta”.' } }
  }
  if (input.pending?.length) {
    const plan: CorrectionPlan | null = parseCorrection(command, input.pending, caps, today)
    if (plan) {
      if (plan.independentStatement) {
        const separate = await orchestrate({ ...input, message: plan.independentStatement, draft: undefined, pending: undefined, pendingClarification: undefined })
        if (separate.response.mode === 'answer' || !separate.response.actions.length) return { ...separate, keepPending: true }
        const additions = separate.response.actions.filter(({ action }) => {
          if (action.kind !== 'expense' && action.kind !== 'income') return true
          return !input.pending?.some(({ action: old }) => old.kind === action.kind && old.amount === action.amount
            && (old.date || today) === (action.date || today) && old.time === action.time
            && normalizeName(old.description) === normalizeName(action.description) && normalizeName(old.origin) === normalizeName(action.origin))
        })
        if (!additions.length && separate.response.mode === 'propose_actions') return preparedActionResponse(input.state, {
          actions: [], clarification: undefined, notes: ['Esse relato já está na proposta. Se foi outra movimentação com os mesmos dados, diga que aconteceu de novo.'],
        }, input.pending)
        const actions = [...input.pending, ...additions]
        if (actions.length > MAX_ACTIONS_PER_BATCH) return preparedActionResponse(input.state, {
          actions: [], clarification: undefined, notes: [`Cada confirmação pode incluir até ${MAX_ACTIONS_PER_BATCH} itens. Confirme ou retire alguns da proposta e mande o novo relato depois.`],
        }, input.pending)
        return { ...separate, correctedPending: actions, response: {
          ...separate.response, actions, reply: `Mantive a proposta anterior.\n\n${separate.response.reply}`,
        } }
      }
      if (plan.ambiguous) {
        const choosingCorrection = plan.ambiguous.field?.startsWith('pending-correction')
        return {
          draft: null,
          correctedPending: choosingCorrection ? [] : undefined,
          keepPending: !choosingCorrection,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
            actions: [], unresolved: [],
            clarification: plan.ambiguous,
            reply: plan.ambiguous.question,
          },
        }
      }
      const linked = new Set(input.pending.filter(({ id, action }) => action.kind === 'recurring-confirm' && action.transactionId
        && plan.edits.some(edit => edit.id === id)).map(c => c.id))
      const editados = new Set(plan.edits.map(edit => edit.id))
      const next = applyCorrection(input.pending, plan).filter(c => !linked.has(c.id))
        .map(c => editados.has(c.id) ? { ...c, action: withLearnedSpelling(input.state, c.action, today) } : c)
      if (linked.size) {
        return preparedActionResponse(input.state, prepareInvoicePayments(input.state, next, today), [],
          'Confira o valor e a data do lançamento existente no Extrato. Depois diga qual conta fixa quer vincular.')
      }
      if (!next.length) {
        return {
          draft: null, correctedPending: [],
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [],
            unresolved: [], reply: plan.summary.join(' ') || 'Ok, descartei a proposta.',
          },
        }
      }
      if (next.some(c => c.action.kind === 'card-payment')) {
        return preparedActionResponse(input.state, prepareInvoicePayments(input.state, next, today), [], plan.summary.join(' '))
      }
      return {
        draft: null, correctedPending: next,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: next, unresolved: [],
          reply: `${plan.summary.join(' ')}\n\n${proposalText(next, input.state)}\n\nConfirmar?`,
        },
      }
    }
  }

  // ---- 6) Negação COM proposta na tela: fala do que está lá -------------
  // "não cara, tá errado isso aí" com um card aberto é conserto, não registro
  // novo. Quando `parseCorrection` não consegue entender O QUE mudar, a saída
  // é PERGUNTAR — deixar a frase seguir para o parser normal criava um segundo
  // lançamento enquanto o primeiro continuava confirmável logo acima, e o
  // usuário ficava com duas propostas para a mesma compra.
  if (input.pending?.length && (contestsProposal(command) || looksNegated(command))
    && !UNDO_REQUEST.test(command) && !UNDO_SHORT.test(command)) {
    return {
      draft: null,
      keepPending: true,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
        actions: [], unresolved: [],
        reply: 'Entendi que tem algo errado aí, mas não peguei o quê. '
          + 'Me diga o que mudar ("foi 80", "era no Inter", "a categoria é lazer") — '
          + 'ou toque em Cancelar se preferir descartar.',
      },
    }
  }

  // Reconhecer o valor/aviso não é tocar em Confirmar. Preserva o card aberto
  // e explica o passo final, sem repetir a advertência nem alegar registro.
  if (input.pending?.length
    && /^(?:(?:esta|ta|isso esta|isso ta)\s+)?(?:correto|certo)$/.test(normalizeName(input.message).replace(/[.!?]+$/, ''))) {
    return {
      draft: null,
      keepPending: true,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
        actions: [], unresolved: [],
        reply: 'Entendi. A proposta continua pendente e nada foi registrado ainda. Se os dados estão certos, toque em Confirmar no card acima.',
      },
    }
  }

  // ---- 6b) "E mais 20 de pão" com a proposta na tela: ACRESCENTA --------
  // Sem verbo, o "mais 20" era lido como RECEITA, e a resposta trazia só ele:
  // a proposta da tela (almoço, café) era substituída e sumia.
  const acrescimo = input.pending?.length ? acrescimoAProposta(input.pending, input.message) : null
  if (acrescimo) {
    const novo = await orchestrate({ ...input, message: acrescimo, pending: undefined })
    if (novo.response.mode === 'propose_actions' && novo.response.actions.length) {
      // "Rodei 150 km" → "e fiz 10 corridas": o mesmo dia de trabalho. Dois
      // registros separados dividiam km e viagens em sessões diferentes.
      const todos = [...input.pending!]
      for (const c of novo.response.actions) {
        const a: any = c.action
        const mesmoDia = a.kind === 'work' ? todos.find(x => x.action.kind === 'work' && ((x.action as any).date || '') === (a.date || '')) : undefined
        if (mesmoDia) {
          const b: any = mesmoDia.action
          const soma = (k: string) => ((b[k] || 0) + (a[k] || 0)) || undefined
          todos[todos.indexOf(mesmoDia)] = { ...mesmoDia, action: { ...b, km: soma('km'), trips: soma('trips'), hours: soma('hours') } as any }
        } else todos.push(c)
      }
      if (todos.length > MAX_ACTIONS_PER_BATCH) return {
        draft: null, keepPending: true,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
          reply: `Cada confirmação pode incluir até ${MAX_ACTIONS_PER_BATCH} itens. Confirme ou retire alguns da proposta e mande o novo relato depois.` },
      }
      return {
        draft: null, focus: input.focus, correctedPending: todos,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: todos, unresolved: [], reply: `${proposalText(todos, input.state)}\n\nConfirmar?`,
        },
      }
    }
    if (!novo.response.actions.length) return { ...novo, keepPending: true }
  }

  // Uma compra em aberto vence um foco antigo de simulação. A frase elíptica
  // "e uma geladeira" não informa valor nem se a compra aconteceu; perguntar
  // sem criar ação e sem cancelar a TV que ainda aguarda confirmação.
  const outroItem = normalizeName(input.message).match(/^e\s+(um|uma)\s+([a-z][a-z\s-]{1,40})\??$/)
  const compraPendente = input.pending?.find(p => p.action.kind === 'card-purchase')
  if (outroItem && compraPendente) {
    const nomePendente = 'description' in compraPendente.action
      ? compraPendente.action.description || 'compra anterior' : 'compra anterior'
    return {
      draft: null,
      keepPending: true,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
        actions: [], unresolved: [],
        reply: `Você também comprou ${outroItem[1]} ${outroItem[2]}? Se sim, diga quanto custou e se foi à vista ou em parcelas. ${sentenceCase(nomePendente)} continua aguardando confirmação.`,
      },
    }
  }

  // ---- 7) A mensagem pergunta POR QUE, ou pede para eu parar? ----------
  // Depois das correções de propósito: "não foi lazer" corrige a proposta;
  // "por que lazer?" pede explicação. E antes da análise por cláusula, porque
  // "por que você colocou essa categoria" não é um pedido de registro e não
  // pode virar cláusula sem intenção, nem sair do aparelho: uma explicação
  // inventada sobre o raciocínio do app é pior que nenhuma explicação.
  {
    const explicacao = explainRequest({
      state: input.state, message: input.message, pending: input.pending, today,
    })
    if (explicacao) {
      return {
        // A proposta na tela CONTINUA na tela: perguntar por que não é
        // cancelar, e a próxima frase ainda fala do mesmo lançamento.
        draft: null,
        keepPending: true,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
          actions: [], unresolved: [], reply: explicacao,
        },
      }
    }
  }

  // ---- 8) A mensagem pede para desfazer o último lote? ------------------
  // Depois das correções de propósito: com uma proposta na tela, "cancela
  // isso" descarta a proposta, não mexe no que já foi gravado.
  if (UNDO_REQUEST.test(command) || UNDO_SHORT.test(command)) {
    const alvo = lastReversibleBatch(input.state)
    if (alvo) {
      const preview = revertBatchPure(input.state, alvo.batchId, alvo.createdAt)
      if (isRevertFailure(preview)) return {
        draft: null,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
          actions: [], unresolved: [], reply: preview.message },
      }
      const itens = describeUndo(input.state, alvo)
      const cand = [candidate({ kind: 'undo-batch', batchId: alvo.batchId }, 'local')]
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: cand, unresolved: [],
          reply: itens.length
            ? `Isto é o que vou desfazer:\n\n${itens.map(l => `• ${l}`).join('\n')}\n\nConfirmar?`
            : 'Vou desfazer o último registro do assistente.\n\nConfirmar?',
        },
      }
    }
    // Sem journal não se reverte por adivinhação — e o usuário precisa saber
    // por quê, além de para onde ir.
    const temHistorico = (input.state.transactions?.length || 0) > 0
      || (input.state.installmentPlans?.length || 0) > 0
    return {
      draft: null,
      response: {
        version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
        actions: [], unresolved: [],
        reply: temHistorico
          ? 'Não tenho o registro detalhado desses lançamentos, então não sei desfazer com segurança. Dá para apagar pela tela de Movimentações.'
          : 'Não tenho nenhum registro recente do assistente para desfazer.',
      },
    }
  }

  // ---- 9) A mensagem corrige um lançamento JÁ SALVO? -------------------
  // Depois do undo e das correções da proposta: com algo na tela, a frase se
  // refere ao que está na tela, não ao histórico.
  if (!input.pending?.length) {
    // A forma declarativa ("aquele foi 90 e não 80") é a mesma correção dita do
    // jeito que se fala. Sem ela a frase caía no parser de registro e virava um
    // lançamento NOVO ao lado do errado.
    const pedido = parseEditRequest(command, caps, today)
      ?? parseSpokenCorrection(command, caps, today)
    const candidatos = pedido ? findEditCandidates(input.state, pedido, today) : []
    // Pedido reconhecido só pelo verbo e sem nenhum lançamento que combine:
    // com um apelido citado ("muda o CINEMA para 80") vale dizer que não achou
    // aquele lançamento; sem apelido nenhum não dá para afirmar que era
    // correção, e a frase segue o caminho normal.
    if (pedido && (candidatos.length || !pedido.loose || pedido.hints.text)) {
      const resposta = (reply: string): OrchestratorOutput => ({
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
          actions: [], unresolved: [], reply,
        },
      })
      if (!candidatos.length) {
        return resposta(pedido.hints.text
          ? `Não achei nenhum lançamento de "${sentenceCase(pedido.hints.text)}" nos últimos meses. Confira o nome, ou me diga o dia e o valor atual.`
          : 'Não encontrei nenhum lançamento que combine com isso. Me diga o dia e o valor atual que eu procuro de novo.')
      }
      if (candidatos.length === 1 && !pedido.ask) {
        const bloqueio = editBlockReason(input.state, candidatos[0])
        if (bloqueio) return resposta(`Esse lançamento não dá para corrigir por aqui: ${bloqueio}`)
        const cand = [candidate(editActionFor(candidatos[0], pedido) as ParsedAction, 'local')]
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cand, unresolved: [],
            reply: `${describeEdit(input.state, candidatos[0], pedido)}\n\nConfirmar?`,
          },
        }
      }
      // Mais de um: PERGUNTAR. Escolher o mais provável seria adivinhar sobre
      // dinheiro que já está gravado.
      const opcoes = candidatos.slice(0, 6)
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [],
          clarification: {
            question: `Qual lançamento você quer corrigir?\n\n${opcoes.map(t => `• ${labelOfTx(t)}`).join('\n')}`,
            field: 'transactionId',
            options: opcoes.map(t => ({
              label: labelOfTx(t),
              value: t.id,
              actions: editBlockReason(input.state, t) ? undefined : [editActionFor(t, pedido) as ParsedAction],
            })),
          },
          reply: `Qual lançamento você quer corrigir?\n\n${opcoes.map(t => `• ${labelOfTx(t)}`).join('\n')}`,
        },
      }
    }
  }

  // ---- 10) Normalizar a mensagem, e só então conversar ------------------
  //
  // Aqui entram as três coisas que a arquitetura antiga não sabia fazer: uma
  // consulta arbitrária ("quanto gastei em obra nos últimos 3 meses"), uma
  // hipótese ("se eu comprar um pc de 4000 em 10x") e uma continuação
  // ("e mês passado?").
  //
  // A PRIMEIRA GUARDA É A MAIS IMPORTANTE: se a mensagem tem um FATO a
  // registrar, nada aqui fala. "Meu salário caiu hoje 3200" contém "caiu", que
  // é palavra de pergunta ("caiu quanto?"), e "recebi 1800 da Casa 1, mais 1750
  // da Casa 2" contém "mais" — as duas viravam consulta e o LANÇAMENTO
  // DESAPARECIA. Perder dinheiro do usuário para responder uma pergunta que ele
  // não fez é o pior desfecho possível desta camada.
  //
  // QUEM RESPONDE O QUÊ, quando não há fato: `resolveLocal()` continua dono das
  // perguntas que já respondia — são elas que o corpus assegura, frase por
  // frase. A consulta só toma a frente quando o plano usa algo que ele
  // COMPROVADAMENTE não expressa (`beyondLegacy`). Fora disso ela fica de
  // reserva e entra no passo 18, onde hoje sai o texto genérico de ajuda.
  const sentidosNaTela = [...new Set((input.pending || []).map(p => p.action.kind).filter(k => k === 'income' || k === 'expense'))] as ('income' | 'expense')[]
  const herdado = sentidosNaTela.length === 1 ? sentidosNaTela[0] : undefined
  let turno = buildTurnPlan(input.state, input.message, { today, inheritedKind: herdado })
  let mensagem = input.message
  let reparo: RepairedText | null = null

  const declarada = contaDeclarada(mensagem)
  if (declarada) {
    const { reply } = declarada
    if (!declarada.restante) {
      return {
        draft: null, focus: input.focus, keepPending: true,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply },
      }
    }
    // A aritmética cobre apenas o trecho que traz o saldo, as contas e a pergunta.
    const outro = await orchestrate({ ...input, message: declarada.restante })
    const response = outro.response
    return {
      ...outro,
      response: {
        ...response,
        ...(response.mode === 'propose_actions' ? { mode: 'answer_and_actions' as const } : {}),
        reply: `${reply}

${response.reply}`,
      },
    }
  }

  // ---- 10a) Erro de digitação no vocabulário ESTRUTURAL ------------------
  // "gsatei 190 de cimento ontem" não casava verbo nenhum, e o resto da frase —
  // que estava perfeito — se perdia junto. O reparo é conservador (dicionário
  // fechado, nunca nome do usuário, nunca perto de dígito) e só é ACEITO quando
  // destrava alguma coisa: se a frase reparada continua sem fato e sem
  // pergunta, ela é descartada e o original segue. Falha fechada.
  {
    // Muleta de conversa ("gastei TIPO 190 de cimento", "guardei 200 SEI LÁ na
    // reserva") não quer dizer nada e fica exatamente onde mais atrapalha.
    // Antes: o parser não achava lançamento NENHUM com a muleta antes do valor,
    // e trocava o TIPO do lançamento com ela depois — "guardei 200 sei lá na
    // reserva" virava depósito em meta, com o valor certo e a natureza errada.
    //
    // A remoção é INCONDICIONAL porque a regex já é estreita (a muleta precisa
    // estar colada num número ou entre o número e um conector) e porque uma
    // muleta nunca é parte do sentido: tirá-la não pode piorar a leitura.
    const semMuleta = stripFillers(input.message)
    if (semMuleta.changed) {
      const outro = buildTurnPlan(input.state, semMuleta.text, { today, inheritedKind: herdado })
      turno = outro
      mensagem = semMuleta.text
    }

    const tentativa = repairStructuralTypos(mensagem, input.state)
    if (tentativa.changed) {
      // Duas situações justificam trocar o texto:
      //   (a) o original não produz fato nenhum — o verbo errado engoliu a
      //       frase inteira ("gsatei 190 de cimento" não casava verbo);
      //   (b) o original produz um fato DEGRADADO, com o erro de digitação
      //       preso na descrição ("Gsatei de cimento", "Pagueu de luz"). O
      //       lançamento existe, mas nasce com um nome que o usuário nunca
      //       vai reconhecer no histórico.
      // Só correção de VERBO ou de TEMPO justifica refazer a leitura de uma
      // frase que já produziu fato. "Paguei 355 nas CONTAS" tem "contas" a uma
      // letra de "contos" (gíria de reais): tratar isso como degradação
      // reescrevia a frase e o lançamento de 150 desaparecia.
      const degradado = tentativa.corrections.some(c => c.estrutural)
        && turno.blocks.some(b => b.actions.some(a => {
          const texto = normalizeName(`${(a as any).description || ''} ${(a as any).origin || ''}`)
          return tentativa.corrections.some(c => c.estrutural && texto.includes(normalizeName(c.from)))
        }))
      // (c) a mensagem tem MAIS DE UMA parte e uma delas ficou de fora:
      // "rceebi 1800 e gastei 150 de areia" registrava só a despesa e a receita
      // sumia em silêncio. Coberta parcial é sinal de que o reparo tem o que
      // destravar, mesmo com um fato já reconhecido.
      const parcial = tentativa.corrections.some(c => c.estrutural)
        && (turno.coverage < 0.999 || turno.blocks.some(b => b.clause.ambiguity && b.actions.length > 0))
      const podeRecuperarNegacao = tentativa.corrections.some(c => c.estrutural)
        && /\b(?:n|n[ãa]o|nem|nunca|jamais)\b|(?<![\p{L}\p{M}])ñ(?=\s)/iu.test(mensagem)
      if (!hasBlock(turno, 'record') || degradado || parcial || podeRecuperarNegacao) {
        const outro = buildTurnPlan(input.state, tentativa.text, { today, inheritedKind: herdado })
        const recuperouNegacao = podeRecuperarNegacao
          && outro.blocks.filter(b => looksNegated(b.clause.text)).length > turno.blocks.filter(b => looksNegated(b.clause.text)).length
        const melhorou = outro.coverage > turno.coverage + 1e-6
          || outro.blocks.reduce((n, b) => n + b.actions.length, 0)
            > turno.blocks.reduce((n, b) => n + b.actions.length, 0)
        const preservaContexto = turno.analysis.clauses.every(c => !c.localExplanation
          || outro.analysis.clauses.some(other => other.localExplanation === c.localExplanation))
        if (preservaContexto && (recuperouNegacao || ((hasBlock(outro, 'record') || hasBlock(outro, 'scenario'))
          && (!hasBlock(turno, 'record') || degradado || melhorou)))) {
          turno = outro
          mensagem = tentativa.text
          reparo = tentativa
        }
      }
    }
  }
  const entrada: OrchestratorInput = mensagem === input.message ? input : { ...input, message: mensagem }

  // ---- 10b) O DIA TELEGRÁFICO do motorista ------------------------------
  // "hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h" não tem oração
  // nenhuma, e o parser de frases lia só o primeiro valor e as horas: os
  // R$ 399 da 99, os R$ 163 de combustível, os 24 litros e os 161 km sumiam em
  // silêncio. Perder metade do dia de trabalho de alguém é o pior tipo de
  // defeito — ele confirma o que vê e nunca descobre o que faltou.
  //
  // Só assume quando reconhece MAIS coisas que o parser normal já tinha achado.
  const datasDoDia = caps.isDriver ? findAllDates(mensagem, today) : []
  const diasDitos = new Set(datasDoDia.flatMap(date => date.kind === 'date' ? [date.date] : []))
  const semDatasDoDia = datasDoDia.reduceRight((text, date) => `${text.slice(0, date.start)} ${text.slice(date.end)}`, mensagem)
  const asksSummary = semDatasDoDia.match(/^\s*quanto\s+(?:sobra|sobrou|sobraria|fica\s+liquido)\s+(?:de|com)\s+(.+?)[.!?]*\s*$/i)?.[1]
  const quotedSummary = asksSummary ? parseDriverDay(asksSummary, { driver: caps.isDriver }) : undefined
  if (quotedSummary) {
    const received = quotedSummary.actions.reduce((sum, action) => sum + (action.kind === 'income' ? Math.round(action.amount * 100) : 0), 0)
    const fuel = quotedSummary.actions.find(action => action.kind === 'fuel')?.amount
    const reply = quotedSummary.unclassifiedAmounts.length || !(fuel > 0)
      ? 'Para calcular a sobra dessa jornada, confirme quanto recebeu e quais valores foram gastos.'
      : `Pelos valores informados, você recebeu ${fmtBRL(received / 100)} e gastou ${fmtBRL(fuel)} em combustível. Depois desse gasto, sobraram ${fmtBRL((received - Math.round(fuel * 100)) / 100)}. Nada foi registrado.`
    return { draft: null, keepPending: true, focus: input.focus, response: {
      version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply,
    } }
  }
  const openingNegation = semDatasDoDia.match(/^\s*(?:nao|não|nem|nunca)\s*[,;:]?\s*/i)
  if (openingNegation && parseDriverDay(semDatasDoDia.slice(openingNegation[0].length), { driver: caps.isDriver })) {
    return { draft: null, keepPending: true, focus: input.focus, response: {
      version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [],
      reply: 'Entendi que esse resumo não aconteceu. Nada foi registrado.',
    } }
  }
  const diaTelegrafico = parseDriverDay(semDatasDoDia, { driver: caps.isDriver })
  if (diaTelegrafico) {
    const jaAchou = turno.blocks.reduce((n, b) => n + b.actions.length, 0)
    if (diaTelegrafico.actions.length >= jaAchou) {
      const dataIncerta = datasDoDia.some(d => d.kind !== 'date') || diasDitos.size > 1
      const dataDoDia = [...diasDitos][0]
      const cands: AssistantCandidateAction[] = []
      for (const bruta of dataIncerta ? [] : diaTelegrafico.actions) {
        const comData: any = { ...bruta }
        if (dataDoDia && actionSpec(bruta.kind)?.fields.some(f => f.name === 'date')) comData.date = dataDoDia
        const v = validateAction(withLearnedCategory(input.state, comData, today, mensagem), caps, today)
        if (!isValidationFailure(v)) cands.push(candidate(v.action, 'local'))
      }
      const valores = [...new Set(diaTelegrafico.unclassifiedAmounts)].slice(0, 4).map(value => fmtBRL(value)).join(', ')
      const question = dataIncerta ? 'Em que dia aconteceu essa jornada? Se houve mais de um dia, diga o resumo de cada dia separadamente.'
        : cands.length !== diaTelegrafico.actions.length ? 'Algum número está fora dos limites do registro. Confira os valores, a quilometragem e a duração da jornada.'
          : diaTelegrafico.invalidWork ? 'Qual foi a duração ou a quantidade inteira de viagens dessa jornada?'
            : valores ? `O que aconteceu com ${valores}? Diga se foi receita, taxa ou outro gasto.` : undefined
      if (question) {
        return { draft: null, keepPending: !cands.length, focus: input.focus, response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', unresolved: [], actions: cands,
          reply: [cands.length ? proposalText(cands, input.state) : '', question].filter(Boolean).join('\n\n'),
          clarification: { question, options: [] },
        } }
      }
      if (cands.length === diaTelegrafico.actions.length) {
        const semTotal = semSomaDasPartes(cands, today)
        return {
          draft: null,
          focus: input.focus,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: semTotal.candidates, unresolved: [],
            reply: `${proposalText(semTotal.candidates, input.state)}${semTotal.nota ? `\n\n${semTotal.nota}` : ''}\n\nConfirmar?`,
          },
        }
      }
    }
  }

  // ---- 10c) PARES TELEGRÁFICOS, em qualquer perfil ------------------------
  // "uber deu 210 e a 99 uns 130", "uber 210 99 130", "salario 3200 aluguel
  // pago 1100": cada valor colado a quem diz o que ele é. Nenhuma oração, e
  // nem a forma do dia do motorista (valor antes, três partes, só motorista).
  // As duas receitas sumiam. O leitor tem vocabulário fechado e desiste diante
  // de qualquer palavra que não conhece — data, negação, pergunta, hipótese
  // passam direto para quem sabe delas. Mesma regra do dia telegráfico: só
  // assume quando reconhece MAIS que o parser de frases.
  const pares = parseTypedPairs(mensagem, { driver: caps.isDriver })
  if (pares) {
    // Conta só DINHEIRO: a "1 viagem" que o parser deduz de uma receita de
    // corrida não é um valor que o usuário disse, e contá-la fazia uma receita
    // perdida empatar com a viagem inventada.
    const DINHEIRO = new Set(['income', 'expense', 'fuel', 'saving'])
    const jaAchou = turno.blocks.reduce((n, b) => n + b.actions.filter(a => DINHEIRO.has(a.kind)).length, 0)
    const dates = caps.isDriver ? datasDoDia : findAllDates(mensagem, today)
    const [firstDate] = dates
    const sameDay = !firstDate || (firstDate.kind === 'date' && dates.every(date => date.kind === 'date' && date.date === firstDate.date))
    if (sameDay && pares.length > jaAchou) {
      const dataDoDia = turno.blocks.find(b => b.clause.date)?.clause.date
      const cands: AssistantCandidateAction[] = []
      for (const bruta of pares) {
        const comData: any = { ...bruta }
        if (dataDoDia && actionSpec(bruta.kind)?.fields.some(f => f.name === 'date')) comData.date = dataDoDia
        const v = validateAction(withLearnedCategory(input.state, comData, today, mensagem), caps, today)
        if (!isValidationFailure(v)) cands.push(candidate(v.action, 'local'))
      }
      // Tudo ou nada: um par recusado na validação não pode sumir em silêncio
      // enquanto o outro é confirmado.
      if (cands.length === pares.length) {
        return {
          draft: null,
          focus: input.focus,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cands, unresolved: [],
            reply: `${proposalText(cands, input.state)}

Confirmar?`,
          },
        }
      }
    }
  }

  // ---- 10d) "E o Inter?" depois de uma pergunta de fatura ---------------
  // A fatura de um cartão é respondida pelo roteador, sem plano no foco: a
  // elipse caía em "O inter de quanto?", como se fosse compra.
  const faturaDeNovo = faturaComOutroCartao(input.state, input.focus, mensagem)
  if (faturaDeNovo) {
    const r = askAssistant(input.state, faturaDeNovo)
    return {
      draft: null, keepPending: true,
      focus: { ...input.focus!, lastInvoiceQuestion: faturaDeNovo, updatedAt: Date.now() },
      response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: r.text },
    }
  }

  // ---- 11) Consulta, cenário e continuação ------------------------------
  const localNotes = [...new Set(turno.analysis.clauses.flatMap(c => c.localExplanation ? [c.localExplanation] : []))].join('\n\n')
  const onlyLocalContext = !!localNotes && turno.analysis.clauses.every(c => c.intent === 'conversation')
  const temFato = hasBlock(turno, 'record')
  // Uma oferta com quilômetros e tempo pode parecer consulta financeira ou
  // lançamento para os leitores gerais. Esta pergunta tem um cálculo próprio.
  const oferta = localNotes ? undefined : interpretRideOffer(input.state, mensagem)
  if (oferta) return rideOfferReply(input, oferta)
  const consultaPedeDia = turno.analysis.clauses.some(c => c.ambiguity?.field === 'query-date')
  const groupedDays = !temFato && !consultaPedeDia && hasBlock(turno, 'query') && !hasBlock(turno, 'scenario')
    ? answerListedDays(input.state, mensagem, today) : undefined
  if (groupedDays) return withPendingAnswer(input, {
    draft: null, keepPending: true, focus: input.focus,
    response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: groupedDays },
  }, today, state => answerListedDays(state, mensagem, today))

  // Registrar E simular na mesma frase (regra 27). "Meu salário entrou 1625,
  // paguei 355, guardei 150 e quero saber se consigo comprar um celular de 3000
  // em 10x" tem as duas metades, e a guarda de fato calava a segunda inteira:
  // a simulação sumia E o cenário nunca entrava no foco, então o "e em 12x"
  // seguinte não tinha em que se apoiar.
  //
  // Só o CENÁRIO ganha esta exceção. A consulta não ganha, e por um motivo
  // medido: "recebi 1800 da Casa 1, MAIS 1750 da Casa 2" e "meu salário CAIU
  // hoje 3200" viram consulta por acidente de vocabulário, e o lançamento
  // desaparecia. `looksLikeScenario` exige marcador explícito de hipótese, que
  // ninguém escreve sem querer.
  const cenarioJunto = temFato && hasBlock(turno, 'scenario')
    ? answerConversation(input.state, mensagem, { today, focus: input.focus })
    : null
  const conversa = temFato || consultaPedeDia || onlyLocalContext ? null : answerConversation(input.state, mensagem, {
    today, focus: input.focus,
  })
  // Consulta INCOMPLETA nunca é assumida aqui, nem como continuação: não há
  // resposta local para ela (ver 11b).
  const assumeAgora = !!conversa && conversa.kind !== 'incomplete' && (
    conversa.kind === 'scenario' || conversa.kind === 'explain' || conversa.kind === 'clarify'
    // Continuacao SO existe com foco fresco. Sem esta guarda, "de onde vem mais
    // dinheiro, uber ou 99?" era tratada como follow-up (comeca com "de onde")
    // numa conversa que nem tinha comecado.
    || (isFocusFresh(input.focus) && looksLikeFollowUp(input.message))
    || conversa.beyondLegacy === true
  )
  if (conversa && assumeAgora) {
    const base = {
      version: ASSISTANT_CONTRACT_VERSION, engine: 'local' as const,
      unresolved: [], reply: localNotes ? `${localNotes}\n\n${conversa.reply}` : conversa.reply,
    }
    const output: OrchestratorOutput = {
      draft: null,
      // Perguntar não é cancelar: a proposta na tela continua confirmável.
      keepPending: true,
      focus: conversa.focus,
      response: conversa.kind === 'clarify' && conversa.clarification
        ? { ...base, mode: 'clarify', actions: [], clarification: conversa.clarification }
        : { ...base, mode: 'answer', actions: [] },
    }
    return conversa.kind === 'query'
      ? withPendingAnswer(input, output, today, state => answerConversation(state, mensagem, { today, focus: input.focus })?.reply)
      : output
  }

  // ---- 11b) O local SABE que não sabe --------------------------------------
  //
  // Dois casos em que a resposta certa do aparelho é NENHUMA, e em que o
  // roteador antigo respondia mesmo assim, com número real:
  //
  //   · HIPÓTESE sem plano: "e se eu parar a obra, quanto sobra até dezembro"
  //     não tem simulação local, e a metade "quanto sobra até dezembro" era
  //     respondida como PROJEÇÃO FACTUAL — a hipótese inteira desaparecia;
  //   · consulta INCOMPLETA: o planejador reconheceu a pergunta mas não
  //     entendeu um pedaço dela ("acima de 200 reais", "desde abril").
  //
  // Nos dois, a frase segue para quem sabe lê-la (o remoto) e, sem remoto, o
  // app DIZ que não sabe. Resposta local errada com cara de certa é pior que
  // chamar o modelo.
  const hipoteseSemPlano = hasBlock(turno, 'scenario') && conversa?.kind !== 'scenario' && !cenarioJunto
  // "Consigo comprar o notebook até março?", "quando consigo comprar o
  // notebook": a META existe e o plano dela responde. Lida como hipótese, a
  // frase ganhava "esse tipo de cenário eu ainda não sei simular".
  if (hipoteseSemPlano && !temFato) {
    const daMeta = respostaDeMetaCitada(input.state, mensagem) || respostaDeCorridasAMais(input.state, mensagem)
    if (daMeta) {
      return {
        draft: null, keepPending: true, focus: input.focus,
        response: { version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local', actions: [], unresolved: [], reply: daMeta },
      }
    }
  }
  const consultaIncompleta = conversa?.kind === 'incomplete'
  /** A pergunta pertence à hipótese: vem depois dela, na MESMA frase. */
  const semRespostaLocal = (q: AnalyzedClause): boolean => consultaIncompleta
    || (hipoteseSemPlano && turno.blocks.some(b => b.type === 'scenario' && b.start <= q.start
      && !/[?.!]/.test(mensagem.slice(b.start, q.start))))

  // ---- 12) Análise local por cláusula -------------------------------------
  const local = runLocal(entrada, caps, turno.analysis)
  const { analysis } = local
  let candidates = local.candidates.slice(0, MAX_ACTIONS_PER_BATCH)
  let engine: AssistantCandidateAction['engine'] = 'local'
  let unresolved = local.unresolved
  let clarification = local.clarification
  let remoteReply = ''
  let remoteRejected: LocalPass['rejected'] = []

  // Uma recorrência ambígua precisa de uma escolha antes de virar proposta.
  type RecurringConfirmation = Extract<ParsedAction, { kind: 'recurring-confirm' }>
  const recurringKey = (action: RecurringConfirmation) => JSON.stringify([action.recurringId, action.occurrenceDate])
  let notasDeContaFixa: { text: string; paymentKey?: string }[] = []
  const escolhasDeContaFixa: AssistantClarification[] = []
  const notasDeFatura = new Set<string>()
  const resolveInvoicePayments = (proposals: AssistantCandidateAction[]) => {
    const resolved = prepareInvoicePayments(input.state, proposals, today)
    for (const note of resolved.notes) notasDeFatura.add(note)
    if (resolved.clarification) {
      if (!clarification) clarification = resolved.clarification
      else notasDeFatura.add(resolved.clarification.question)
    }
    return resolved.actions
  }
  const addFixedBillResolution = (resolution: RecurringResolution) => {
    if ('clarification' in resolution) {
      const options = JSON.stringify(resolution.clarification.options)
      if (!escolhasDeContaFixa.some(c => JSON.stringify(c.options) === options)) escolhasDeContaFixa.push(resolution.clarification)
    } else {
      const action = 'action' in resolution ? resolution.action : undefined
      notasDeContaFixa.push({ text: resolution.note, paymentKey: action?.kind === 'recurring-confirm' ? recurringKey(action) : undefined })
    }
  }

  const resolveFixedBills = (proposals: AssistantCandidateAction[]) => {
    const resolved = proposals.flatMap(c => {
      if (c.action.kind !== 'expense') return [c]
      const clause = analysis.clauses.find(part => part.id === c.clauseId)
      const fixed = resolveRecurringStatement(input.state, c.action, clause?.text || '', caps, today)
      if (!fixed) return [c]
      if (c.clauseId) unresolved = unresolved.filter(u => u.clauseId !== c.clauseId)
      addFixedBillResolution(fixed)
      return 'action' in fixed ? [{ ...c, action: fixed.action }] : []
    })
    if (escolhasDeContaFixa.length === 1 && !clarification) clarification = escolhasDeContaFixa[0]
    // Uma repetição idêntica vira uma só proposta. Se valor ou data divergem,
    // pergunte antes de usar qualquer uma na projeção ou na confirmação.
    const recurringByKey = new Map<string, RecurringConfirmation>()
    const differingPayments = new Set<string>()
    const unique = resolved.filter(({ action }) => {
      if (action.kind !== 'recurring-confirm') return true
      const key = recurringKey(action)
      const first = recurringByKey.get(key)
      if (first) {
        if (first.amount !== action.amount || (first.date || today) !== (action.date || today)) differingPayments.add(key)
        return false
      }
      recurringByKey.set(key, action)
      return true
    })
    if (!differingPayments.size) return unique
    notasDeContaFixa = notasDeContaFixa.filter(nota => !nota.paymentKey || !differingPayments.has(nota.paymentKey))
    notasDeContaFixa.push({ text: 'Você informou pagamentos diferentes para o mesmo vencimento. Qual foi o valor e a data do pagamento?' })
    return unique.filter(({ action }) => action.kind !== 'recurring-confirm' || !differingPayments.has(recurringKey(action)))
  }

  // "Do mês passado" qualifica a conta, enquanto "paguei mês passado"
  // continua sendo uma data de pagamento que precisa do dia exato.
  if (clarification?.field === 'date' && clarification.dateWindow) {
    const periods = analysis.clauses.filter(c => c.temporal && !c.temporal.plan)
    const part = periods.length === 1 ? periods[0] : undefined
    const [payment] = part?.temporal?.actions || []
    if (payment?.kind === 'expense' && part?.temporal?.actions?.length === 1
      && /\b(?:do|referente\s+ao)\s+mes\s+passado\b/i.test(normalizeName(part.text))) {
      const dataPaga = findAllDates(part.text, today).find(d => d.kind === 'date')
      const fixed = resolveRecurringStatement(input.state, {
        ...payment, description: `${payment.description || ''} do mês passado`,
        ...(dataPaga?.kind === 'date' ? { date: dataPaga.date } : {}),
      }, part.text, caps, today)
      if (fixed) {
        clarification = 'clarification' in fixed ? fixed.clarification : undefined
        addFixedBillResolution(fixed)
        if ('action' in fixed) candidates.push(candidate(fixed.action, 'local', part.id))
        unresolved = unresolved.filter(u => u.clauseId !== part.id)
      }
    }
  }
  candidates = resolveInvoicePayments(resolveFixedBills(candidates))

  if (!candidates.length && !clarification) {
    const payment = recurringStatementWithoutAmount(mensagem, today)
    const fixed = payment && resolveRecurringStatement(input.state, payment, mensagem, caps, today)
    if (fixed) {
      addFixedBillResolution(fixed)
      if ('action' in fixed) candidates.push(candidate(fixed.action, 'local'))
      if ('clarification' in fixed) clarification = fixed.clarification
      unresolved = []
    }
  }

  // ---- 12a) Meta com nome que já existe PERGUNTA (regra 14) --------------
  // "Quero juntar 5000 pra viagem" com uma meta Viagem já guardando dinheiro
  // propunha uma SEGUNDA meta Viagem, sem aviso. As três saídas da regra:
  // atualizar a existente, criar outra mesmo assim, cancelar.
  if (!clarification) {
    const nova = candidates.find(c => c.action.kind === 'goal' && findGoalByExactName(input.state, (c.action as any).name))
    if (nova) {
      const a = nova.action as Extract<ParsedAction, { kind: 'goal' }>
      const existente = findGoalByExactName(input.state, a.name)!
      const outras = candidates.filter(c => c !== nova).map(c => c.action)
      const question = `Você já tem a meta ${existente.name}, com ${fmtBRL(existente.saved || 0)} guardados de ${fmtBRL(existente.target || 0)}. O que eu faço?`
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local', actions: [], unresolved: [],
          clarification: {
            question, field: 'goal-duplicate',
            options: [
              { label: 'Atualizar a existente', value: 'atualizar', actions: [...outras, { kind: 'goal-update', name: existente.name, target: a.target, ...(a.months ? { months: a.months } : {}) }] },
              { label: 'Criar outra mesmo assim', value: 'criar', actions: [...outras, a] },
              outras.length
                ? { label: 'Só o resto', value: 'cancelar', actions: outras }
                : { label: 'Cancelar', value: 'cancelar', reply: 'Ok, não criei nem mudei nenhuma meta.' },
            ],
          },
          reply: question,
        },
      }
    }
  }

  // ---- 12b) Compra no CARTÃO sem parcelas vira rascunho de parcelamento ---
  // "Gastei 80 no cartão", "passei 80 no Nubank", "paguei 120 no crédito no
  // mercado": viravam despesa avulsa — e quando a fatura fosse paga, os mesmos
  // R$ 80 saíam do saldo de novo (regra 10). É o fluxo de "comprei uma
  // geladeira de 3000 no cartão": pergunta as parcelas ("à vista" é 1x).
  const datePending = (clarification?.field === 'date-choice' || clarification?.field === 'date')
    && clarification.pendingActions?.length === 1 && clarification.pendingActions[0].kind === 'expense'
    ? clarification.pendingActions[0] : undefined
  if ((!clarification || datePending) && !notasDeFatura.size) {
    const purchases = analysis.clauses.flatMap(clause => {
      const heldExpense = datePending && (clause.dateAmbiguity ? clause.actions : clause.temporal && clause.temporal.kind !== 'future' ? clause.temporal.actions : [])
        .some(a => a.kind === 'expense' && a.amount === datePending.amount && a.description === datePending.description)
      if (clause.localExplanation || clause.unrealized || clause.intention || (clause.temporal && !heldExpense) || clause.ambiguity
        || clause.intent === 'conversation' || clause.intent === 'correction' || looksNegated(clause.text)) return []
      if (datePending && !heldExpense) return []
      const scoped = heldExpense ? [candidate(datePending, 'local', clause.id)] : candidates.filter(c => c.clauseId === clause.id)
      const compra = compraNoCartao(clause.text, scoped, caps, today)
      return compra ? [{ clause, scoped, compra }] : []
    })
    if (purchases.length) {
      const ids = new Set(purchases.map(p => p.clause.id))
      const other = candidates.filter(c => !ids.has(c.clauseId))
      if (purchases.length > 1) {
        const question = 'Você descreveu mais de uma compra no cartão. Diga uma de cada vez, com o valor e o número de parcelas.'
        return preparedActionResponse(input.state, { actions: other, notes: [], clarification: { question, field: 'installments' } })
      }
      const [{ clause, scoped, compra }] = purchases
      if (compra.partial.kind === 'card-purchase' && !compra.partial.date && !compra.missing.includes('date') && clause.date) compra.partial.date = clause.date
      const d = newDraft(compra, input.message, caps)
      const [source] = scoped
      if (compra.partial.kind === 'card-purchase' && compra.partial.total) {
        const { total, date, category, description } = compra.partial
        d.fallbackExpense = { kind: 'expense', amount: total, date,
          category: category ?? (source?.action.kind === 'expense' ? source.action.category : undefined),
          description, time: source?.action.kind === 'expense' ? source.action.time : undefined }
      }
      const earlier = new Set(analysis.clauses.filter(part => part.start < clause.start).map(part => part.id))
      d.companion = {
        before: other.filter(c => earlier.has(c.clauseId)).map(c => c.id),
        after: other.filter(c => !earlier.has(c.clauseId)).map(c => c.id),
      }
      const q = d.missingFields[0]
      const question = q.field === 'installments'
        ? `${other.length && compra.partial.kind === 'card-purchase' ? `Em quantas parcelas foi a compra de ${fmtBRL(compra.partial.total)}?` : 'Em quantas parcelas?'} Se foi à vista, diga "à vista"; se foi no débito, diga "débito".`
        : q.question
      const result = preparedActionResponse(input.state, { actions: other, notes: [],
        clarification: { question, field: q.field, options: q.options } })
      return { ...result, draft: d }
    }
  }


  // ---- 13) Intenção incompleta vira rascunho ------------------------------
  if (!candidates.length && !clarification && !notasDeContaFixa.length && !notasDeFatura.size) {
    const incomplete = detectIncomplete(mensagem, caps, today)
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

  // ---- 14) Perguntas respondidas localmente -------------------------------
  const questions = analysis.clauses.filter(c => c.intent === 'question' && !semRespostaLocal(c))
  const local_answers = answerQuestions(input.state, questions, candidates, today, mensagem)
  clarification ||= local_answers.rideClarification
  const answeredIds = new Set(local_answers.answered.map(c => c.id))
  unresolved = unresolved.filter(u => !answeredIds.has(u.clauseId))

  // ---- 15) IA remota PLANEJA a consulta que o local não entendeu ---------
  //
  // Este é o uso mais valioso do modelo, e o mais seguro: ele não recebe
  // lançamento nenhum — só o vocabulário da DSL, as categorias e a pergunta.
  // O plano volta, passa por `validateQueryPlan()` com as capacidades REAIS
  // deste aparelho, e é executado AQUI. Os números nunca saem do dispositivo.
  //
  // Só entra quando a pergunta sobrou de tudo: sem ação, sem resposta local e
  // sem esclarecimento pendente.
  // Hipótese não é consulta: mandá-la ao planejador de CONSULTA pediria um
  // plano factual para um mundo que não existe. Ela vai ao chat, no passo 16.
  if (!candidates.length && !clarification && !local_answers.text && !hipoteseSemPlano
    && !notasDeContaFixa.length && !notasDeFatura.size && unresolved.length && input.remoteEnabled && input.planRemoteQuery) {
    const bruto = await input.planRemoteQuery({ state: input.state, message: mensagem })
    if (bruto) {
      const v = validateQueryPlan(bruto, input.state, today)
      // O plano válido ainda tem que respeitar o que a FRASE declarou. "Vou
      // receber 1800 da casa 1 dia 5" virava "Total setembro: R$ 1.800,00 (dado
      // real)": o modelo leu uma consulta, o usuário disse um futuro. Plano que
      // contradiz a modalidade explícita não é executado — a frase segue para o
      // chat, como qualquer plano recusado.
      const modalidade = modalidadeExplicita(mensagem, today)
      if (!isQueryFailure(v) && !(modalidade && planoContradizModalidade(v.plan, modalidade))) {
        const r = runQuery(input.state, v.plan, today)
        return withPendingAnswer(input, {
          draft: null,
          focus: rememberQuery(input.focus, v.plan, r, explainQueryResult(r)),
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'hybrid',
            actions: [], unresolved: [], reply: composeAnswer(r),
          },
        }, today, state => composeAnswer(runQuery(state, v.plan, today)))
      }
    }
  }

  // ---- 16) IA remota só para o que sobrou ---------------------------------
  const stillOpen = unresolved.length > 0
  if (stillOpen && input.remoteEnabled && input.askRemote && !clarification) {
    // Com parte da mensagem já resolvida no aparelho, vai só o que ficou em
    // aberto. Reenviar a frase inteira convidava o modelo a propor de novo o que
    // já está na tela — a reconciliação por campo segurava a duplicata, mas o
    // modelo nem precisa ver o trecho resolvido.
    const textoRemoto = candidates.length || notasDeContaFixa.length || notasDeFatura.size
      ? unresolved.map(u => u.text).join('\n') : input.message
    // A conversa vai como ESTRUTURA: o que estava em foco, o que está na tela e o
    // que já foi resolvido neste turno — nunca as mensagens anteriores.
    const relacao: RemoteTurnRelation | undefined =
      input.pending?.length && contestsProposal(input.message) ? 'correction'
        : isFocusFresh(input.focus) && looksLikeFollowUp(input.message)
          ? (/^\s*(?:e\s+)?(?:qual\s+(?:foi\s+)?(?:o\s+)?(?:pior|melhor)|compar|qual\s+(?:a\s+)?diferen)/i.test(input.message) ? 'comparison' : 'continuation')
          : undefined
    const conversation = buildRemoteConversation({
      focus: input.focus,
      focusFresh: isFocusFresh(input.focus),
      pendingKinds: input.pending?.map(p => p.action.kind),
      clarificationField: input.pendingClarification?.field,
      turnRelation: relacao,
      resolvedKinds: candidates.map(c => c.action.kind),
    })
    const remote = await input.askRemote({
      state: input.state, message: textoRemoto, conversation, aggregates: remoteNeedsAggregates(textoRemoto),
    })
    if (remote) {
      remoteReply = remote.reply
      remoteRejected = remote.rejected || []
      engine = candidates.length ? 'hybrid' : 'remote'
      if (!remote.contractFallback) {
        // ---- Reconciliação POR CAMPO (fase 13) ----------------------------
        //
        // Antes: dedupe por `JSON.stringify` ou por `(kind, amount)`. Sem saber
        // a PROCEDÊNCIA de cada campo, a reconciliação só sabia fazer duas
        // coisas — descartar a ação remota inteira (perdendo a descrição boa) ou
        // aceitá-la inteira (arriscando trocar 1800 por 180).
        //
        // Agora cada ação carrega a evidência de campo a campo, e a fusão segue
        // a hierarquia fixa: o valor que o usuário escreveu NUNCA é sobrescrito
        // pelo modelo, e o que só o modelo trouxe entra onde estava vazio.
        for (const a of remote.actions) {
          const alvo = candidates.find(c => sameFact(c.action, a))
          if (!alvo) {
            const preferred = withLearnedCategory(input.state, a, today, mensagem)
            candidates.push(candidate(preferred, 'remote', undefined, 'medium'))
            continue
          }
          const base = evidenceFor(alvo.action, { text: mensagem, clauseId: alvo.clauseId })
          const extra = evidenceFor(a, { text: mensagem, remote: true })
          const out = mergeByField(base, extra)
          if (out.conflicts.length && !clarification) {
            // Duas evidências FORTES discordando não se resolvem por votação.
            clarification = { question: conflictQuestion(out.conflicts[0]), field: out.conflicts[0].field }
          }
          if (out.filled.length) {
            const i = candidates.indexOf(alvo)
            const v = validateAction(out.merged.action, caps, today)
            // A fusão passa pela MESMA validação de sempre: campo vindo do
            // modelo não tem passe livre por ter entrado por outra porta.
            if (!isValidationFailure(v)) {
              candidates[i] = { ...alvo, action: v.action, engine: 'hybrid' }
            }
          }
        }
        if (remote.clarification && !clarification) clarification = remote.clarification
      }
      unresolved = []
    } else {
      unresolved = unresolved.map(u => ({ ...u, reason: 'remote-unavailable' as const }))
    }
  }

  candidates = candidates.slice(0, MAX_ACTIONS_PER_BATCH)

  if (engine !== 'local') candidates = resolveInvoicePayments(resolveFixedBills(candidates))
  if (escolhasDeContaFixa.length > 1) {
    if (clarification === escolhasDeContaFixa[0]) clarification = undefined
    notasDeContaFixa.push({ text: 'Há pagamentos com mais de uma ocorrência possível. Informe separadamente a origem ou o vencimento de cada conta fixa.' })
  } else if (escolhasDeContaFixa.length && clarification !== escolhasDeContaFixa[0]) {
    notasDeContaFixa.push({ text: escolhasDeContaFixa[0].question })
  }

  // ---- 16b) Total dito junto das partes --------------------------------
  // "Fiz 300 hj, 250 na uber e 50 na 99", "gastei 100 hj, 60 de gasolina e 40
  // de almoço": o primeiro valor É a soma das partes, e o dia contava em dobro.
  // Só quando a soma fecha no centavo, no mesmo dia, com pelo menos duas partes
  // nomeadas — qualquer diferença é outra conversa, e o app não escolhe.
  {
    const semTotal = semSomaDasPartes(candidates, today)
    candidates = semTotal.candidates
    if (semTotal.nota) notasDeContaFixa.push({ text: semTotal.nota })
  }

  // ---- 17) Avisos de duplicidade (contra o estado E dentro do lote) -------
  candidates = proposalWarnings(input.state, candidates, today)

  // ---- 18) Texto final ----------------------------------------------------
  const hypo = questions.length && candidates.length && !local_answers.text ? hypotheticalSummary(candidates) : null
  // A intenção futura vira TEXTO, nunca lançamento — e continua aparecendo
  // mesmo quando o resto da mensagem gerou registros.
  const planNote = local.temporalPlan ? futurePlanReply(local.temporalPlan) : null
  const intentionNote = candidates.length
    ? analysis.clauses.filter(c => c.intention && /\d/.test(c.text))
      .map(c => {
        const trecho = c.text.replace(/\s+(?:mas|por[ée]m|s[óo]\s+que)\s*$/i, '').replace(/[.,;]\s*$/, '')
        return c.unrealized ? `“${trecho}” ficou como contexto da conversa.`
          : `“${trecho}” descreve intenção futura; não registrei essa parte como realizada.`
      })
      .join('\n')
    : ''
  // A IA remota caiu (vazia, 502, timeout, rede). O usuário precisa saber que a
  // pergunta ficou sem resposta POR ISSO — antes ele recebia o texto genérico
  // de ajuda e não tinha como distinguir "não entendi" de "estou fora do ar".
  const remoteNote = !remoteReply && unresolved.some(u => u.reason === 'remote-unavailable')
    ? 'Não consegui falar com o assistente por IA agora, então essa pergunta ficou sem resposta. Tente de novo em instantes — registrar e consultar seus números continua funcionando normalmente.'
    : null
  // Neste turno NADA foi executado: a execução só acontece no Confirmar. O texto
  // do modelo não pode dizer "anotei/registrei" com a ação ainda na tela.
  const remotoSemAlegacao = remoteReply ? semAlegacaoDeExecucao(remoteReply, candidates.length ? 'pendente' : 'nada-proposto') : ''
  const answerPart = [local_answers.text, remotoSemAlegacao, cenarioJunto?.reply, hypo, planNote, intentionNote, remoteNote,
    ...new Set(notasDeContaFixa.map(nota => nota.text)), ...notasDeFatura]
    .filter(Boolean).join('\n\n')
  const rejectedAll = [...local.rejected, ...remoteRejected]

  let reply: string
  let mode: AssistantResponse['mode']
  /** Foco devolvido ao chamador. So muda quando a consulta de fato respondeu. */
  // Pergunta respondida pelo roteador antigo no passo 14: o PLANO fica no foco
  // mesmo assim — a mesma regra do fallback lá embaixo. Sem isto, depois de
  // "quanto gastei com obra" o "onde?" seguinte não tinha assunto nenhum e
  // devolvia o total do mês inteiro.
  let focoFinal: ConversationFocus | undefined = cenarioJunto?.focus
    || (local_answers.text && conversa?.kind === 'query' ? conversa.focus : undefined)
    || local_answers.focus
    || input.focus

  if (clarification) {
    mode = 'clarify'
    reply = [
      candidates.length ? proposalText(candidates, input.state) : '',
      ...new Set(notasDeContaFixa.map(nota => nota.text)),
      ...notasDeFatura,
      clarification.question,
    ].filter(Boolean).join('\n\n')
  } else if (candidates.length && answerPart) {
    mode = 'answer_and_actions'
    reply = `${proposalText(candidates, input.state)}${sobraComValor(unresolved)}\n\n${answerPart}\n\nConfirmar os registros?`
  } else if (candidates.length) {
    mode = 'propose_actions'
    reply = `${proposalText(candidates, input.state)}${sobraComValor(unresolved)}\n\nConfirmar?`
  } else if (answerPart) {
    mode = 'answer'
    reply = answerPart
  } else if (pedeParaQuebrarRegra(mensagem)) {
    // O texto genérico de ajuda funcionava como recusa por acidente: ele não
    // registrava nada, mas também não dizia NÃO. Quem tenta isso merece uma
    // resposta clara, e quem lê o log do app também.
    mode = 'answer'
    reply = 'Isso eu não faço. Só registro o que você me pedir, e sempre com você '
      + 'confirmando na tela antes de qualquer coisa entrar. Também não mostro '
      + 'instruções internas nem chave de acesso.\n\n'
      + 'Se quiser registrar alguma coisa de verdade, é só me contar o que aconteceu.'
  } else if (/^\s*-\s*\d/.test(mensagem) || /\b(?:gastei|paguei|recebi|ganhei)\s+-\s*\d/.test(mensagem)) {
    mode = 'answer'
    reply = 'Valor negativo eu não sei registrar. Me diga o que aconteceu — '
      + '"gastei 50 no mercado" ou "recebi 50 de volta" — que eu lanço no lado certo.'
  } else if (elipseDeCadastro(input.state, mensagem)) {
    // "E a internet?" é a conta fixa cadastrada; "e a viagem?", a meta. A
    // elipse de compra abaixo perguntava "A internet de quanto?".
    mode = 'answer'
    reply = askAssistant(input.state, elipseDeCadastro(input.state, mensagem)!).text
  } else if (/^\s*e\s+(?:um|uma|o|a)\s+([a-zà-ú]{3,20})\s*\??\s*$/i.test(mensagem)) {
    // "E uma geladeira?" logo depois de uma compra parcelada. A elipse é clara
    // no assunto e muda a COISA, mas não traz valor nenhum — e sem valor não há
    // simulação possível. Perguntar o preço mantém a conversa; a lista de
    // exemplos a encerrava.
    // O artigo sai da frase do usuário, nunca de palpite: "esse geladeira" e
    // "essa notebook" são o mesmo erro de inferir gênero que a regra 45 proíbe.
    const coisa = (mensagem.match(/^\s*e\s+((?:um|uma|o|a)\s+[a-zà-ú]{3,20})/i) || [])[1] || 'isso'
    mode = 'answer'
    reply = `${sentenceCase(coisa)} de quanto? Me diga o valor e em quantas vezes `
      + `que eu simulo — por exemplo "2000 em 10x".`
  } else if (/^\s*(?:r\$\s*)?[\d.,]+\s*$/.test(mensagem)) {
    // Um número solto: o usuário começou e parou. Perguntar é mais útil que a
    // lista de exemplos.
    mode = 'answer'
    reply = `Só o valor eu não consigo lançar. Foi entrada ou saída, e com o quê? `
      + `Por exemplo: "gastei ${mensagem.trim()} no mercado".`
  } else {
    mode = 'answer'
    const negadas = analysis.clauses.filter(c => c.intent === 'correction' && !c.actions.length)
    const notUnderstood = unresolved.filter(u => u.reason !== 'question-unanswered')
    if (hipoteseSemPlano) {
      reply = 'Isso é uma hipótese, e esse tipo de cenário eu ainda não sei simular aqui — '
        + 'por isso não vou te dar um número como se fosse o resultado. Nada foi registrado.\n\n'
        + 'Consigo simular, por exemplo: uma compra parcelada ("e se eu comprar um pc de 4000 em 10x"), '
        + 'guardar um valor por mês, uma entrada que não vem, ou parar um tipo de gasto ("e se eu parar a obra").'
    } else if (consultaIncompleta) {
      reply = `Entendi que é uma pergunta sobre os seus lançamentos, mas não consegui ler esta parte: "${conversa?.residuo}". `
        + 'Sem ela o número sairia errado, então prefiro não responder. Pode dizer de outro jeito?'
    } else if (local.intencaoDeclarada && !candidates.length) {
      // Intencao declarada nao e fato: "vou gastar 80 no mercado" e "posso
      // guardar 200?" viravam lancamento, porque o verbo esta no INFINITIVO e
      // nenhuma lista de verbo conjugado os barrava. O app diz o que fez e o
      // que fara — nunca inventa a movimentacao.
      reply = analysis.clauses.some(c => c.unrealized) ? 'Isso não chegou a acontecer. Nenhum lançamento foi preparado.'
        : ['Isso ainda não aconteceu, então não registrei nada. '
        + 'Quando acontecer de verdade, me avise que eu lanço na hora.',
      'Se quiser saber como isso ficaria antes de decidir, pergunte com "e se" — '
        + 'por exemplo, "e se eu gastar 200 esse mês?".'].join('\n\n')
    } else if (local.recorrenteDeclarada) {
      // Conta que se repete é previsão: registrar como gasto de hoje somaria ao
      // mês um dinheiro que ainda não saiu (regra 18). O cadastro de recorrência
      // não é por conversa — a tela certa faz isso com data e frequência.
      // Entrada não "vence": o aviso de salário é de quando ele deve cair.
      const entrada = /\b(?:salario|recebo|ganho|ganha|faturo|renda|pensao|aluguel\s+que\s+recebo|cai|caem|entra|entram)\b/.test(normalizeName(mensagem))
        && !/\b(?:pago|pagamos|gasto|vence|vencem)\b/.test(normalizeName(mensagem))
      reply = 'Isso se repete todo período, então não registrei como movimentação de hoje — '
        + 'é uma previsão, não algo que já entrou ou saiu.\n\n'
        + (entrada
          ? 'Cadastre em Planejamento, com o valor e o dia, para eu acompanhar todo mês e te avisar quando ela deve cair.'
          : 'Cadastre em Planejamento para eu acompanhar todo mês e te avisar do vencimento.')
    } else if (PEDE_LEMBRETE.test(normalizeName(mensagem))) {
      // "Me lembra de pagar a luz dia 10" caía em "não tenho certeza do que
      // registrar". Não é lançamento: é aviso de vencimento, e quem avisa é a
      // conta cadastrada no Planejamento.
      reply = 'Não registrei nada: isso é um lembrete, não um pagamento. '
        + 'Cadastre a conta em Planejamento, com o valor e o dia do vencimento — o app avisa antes de vencer. '
        + 'Quando pagar, me diga "paguei a conta" que eu registro.'
    } else if (PEDE_APAGAR.test(mensagem)) {
      // "Não registrei nada" respondia um pedido de APAGAR como se fosse negação.
      reply = 'Por aqui eu não apago lançamentos salvos. Para remover, abra Movimentações e apague o lançamento. '
        + 'Se foi o último registro feito por mim, diga "desfaz o último".'
    } else if (INTENCAO_DE_REDUZIR.test(mensagem)) {
      // "Quero diminuir meus gastos com gasolina, mas sem mudar minha meta":
      // intenção, não negação. Lida como "isso não aconteceu" soava como se o
      // app tivesse desentendido. O útil é mostrar quanto tem saído.
      reply = respostaDeIntencaoDeReduzir(input.state, mensagem, today)
    } else if (localNotes && !notUnderstood.length) {
      reply = localNotes
    } else if (negadas.length) {
      // O usuário disse que NÃO fez o lançamento. Confirmar isso em voz alta é
      // parte da correção — e nada pode sugerir registro.
      // "Na verdade foi ontem", "muda pra alimentação" sem nada na tela: é
      // CORREÇÃO sem alvo, não negação. "Isso não aconteceu" era falso.
      reply = negadas.every(c => looksNegated(c.text))
        ? 'Entendi que isso não aconteceu — não registrei nada. Se quiser lançar outra coisa, é só me dizer.'
        // Com proposta na tela, dizer que não há proposta é falso: o conserto
        // não foi entendido, e a proposta continua lá.
        : input.pending?.length
          ? 'Entendi que tem algo errado na proposta, mas não peguei o quê. Me diga o que mudar ("foi 80", "foi na 99", "a categoria é manutenção") — ou toque em Cancelar se preferir descartar.'
          : 'Não tenho nenhuma proposta na tela para corrigir, então não mudei nada. '
            + 'Se for um lançamento já salvo, me diga qual e o que mudar — por exemplo, "o mercado de hoje foi 45 e não 54".'
    } else if (notUnderstood.length && (candidates.length || analysis.clauses.some(c => c.handled))) {
      reply = SAQUE.test(notUnderstood[0].text)
        ? `“${notUnderstood[0].text.trim().replace(/[\s,;]+$/, '')}” é saque: não é ganho nem gasto, então não registrei.`
        : `Não consegui interpretar esta parte: "${notUnderstood[0].text}". Pode reformular só esse pedaço?`
    } else {
      // CUIDADO: `askAssistant` tem o próprio parser e monta "Entendi isso… /
      // Confirmar?" a partir dele. Se o orquestrador decidiu que NÃO há ação
      // (negação, hipótese, perfil), esse texto seria uma promessa falsa: a tela
      // mostraria a proposta sem nenhum botão. Só aproveitamos a RESPOSTA.
      const local = askAssistant(input.state, mensagem, { today, message: mensagem })
      // AQUI a consulta entra: este é exatamente o ponto onde antes saía o texto
      // genérico de ajuda. Só quando o roteador antigo não soube responder
      // (`handled: false`) — quando ele soube, a resposta dele manda, e é ela que
      // o corpus assegura.
      if (local.handled === false && conversa && conversa.kind === 'query') {
        reply = conversa.reply
        focoFinal = conversa.focus
      } else {
        // Mesmo quando o roteador antigo responde, o PLANO fica guardado no
        // foco. Sem isso, "meu nubank ta pesando?" era respondida por ele e a
        // frase seguinte ("e o inter") nao tinha a que se referir — caia no
        // texto generico de ajuda no meio da conversa.
        if (conversa && conversa.kind === 'query') focoFinal = conversa.focus
        reply = local.actions?.length
          ? SEM_CERTEZA
          : local.text
      }
    }
  }
  // O usuário precisa saber que a frase foi lida de outro jeito: sem isso, ele
  // vê o valor certo com uma palavra que não escreveu e não sabe se o app
  // entendeu ou adivinhou.
  const notaReparo = reparo ? describeRepairs(reparo) : null
  if (localNotes && reply !== localNotes) reply = `${localNotes}\n\n${reply}`
  if (candidates.some(candidate => analysis.clauses.some(c => c.id === candidate.clauseId && c.approximateAmount))) {
    const note = 'Você informou um valor aproximado. Confira o valor na proposta antes de confirmar.'
    reply = reply.endsWith('Confirmar?') ? `${reply.slice(0, -'Confirmar?'.length)}${note}\n\nConfirmar?` : `${reply}\n\n${note}`
  }
  if (notaReparo && (mode === 'propose_actions' || mode === 'answer_and_actions')) {
    reply = `${notaReparo}

${reply}`
  }
  // Mensagem cortada: o usuario precisa saber. Ler so o comeco e responder como
  // se tivesse lido tudo e pior do que dizer que cortou.
  if (limpa.truncated) {
    reply += ['', '', 'Sua mensagem era muito longa e eu li só o começo. '
      + 'Se faltou alguma coisa, me mande em partes.'].join('\n')
  }
  // Se nada virou proposta e a resposta era só a dúvida genérica, o motivo da
  // recusa É a resposta: "não tenho certeza" mentia — a frase foi entendida.
  const recusa = motivoDaRecusa(rejectedAll)
  if (recusa && !candidates.length && reply.includes(SEM_CERTEZA)) reply = reply.replace(SEM_CERTEZA, recusa)
  else if (recusa) reply += `\n\nUma parte não pôde ser registrada. ${recusa}`

  const diagnostics: AssistantDiagnostics | undefined = input.devDiagnostics
    ? {
        engine, coverage: analysis.coverage,
        clauses: analysis.clauses.map(c => ({ id: c.id, text: c.text, intent: c.intent, handled: c.handled, confidence: c.confidence })),
        localActions: local.candidates.length,
        remoteActions: candidates.length - local.candidates.length,
        rejected: rejectedAll,
        elapsedMs: Date.now() - started,
        decision: classifyLocalDecision(analysis),
        suspicious: analysis.clauses.flatMap(c => c.suspicious || []),
      }
    : undefined

  const base = { version: ASSISTANT_CONTRACT_VERSION, engine, unresolved, diagnostics, reply }
  const response: AssistantResponse =
    mode === 'clarify'
      ? { ...base, mode, actions: candidates, clarification: clarification! }
      : mode === 'answer'
        ? { ...base, mode, actions: [] }
        : { ...base, mode, actions: candidates }

  // Pergunta de fatura de UM cartão respondida: fica no foco para "e o Inter?".
  if (mode === 'answer' && perguntaDeFatura(normalizeQuestion(mensagem)) && cartoesNaFrase(input.state, normalizeName(mensagem)).length === 1) {
    focoFinal = { ...(focoFinal || {}), lastInvoiceQuestion: mensagem, updatedAt: Date.now() }
  }
  const normalizedQuestion = normalizeQuestion(mensagem)
  if (mode === 'answer' && listaDeLancamentos(input.state, normalizedQuestion, today) === reply) {
    const output = { draft: null, response, focus: periodViewFocus(focoFinal || input.focus, 'movements', normalizedQuestion, today) }
    return withPendingAnswer(input, output, today, state => listaDeLancamentos(state, normalizedQuestion, today))
  }
  const noLongerInView = mode === 'answer' && !focoFinal && input.focus?.last === 'period-view'
    ? { ...input.focus, last: undefined, lastPeriodView: undefined } : undefined
  const output = { draft: null, response, focus: focoFinal || noLongerInView,
    keepPending: mode === 'answer' && (!!localNotes || (caps.isDriver && !!input.pending?.length)) }
  if (local_answers.answered.length && local_answers.text && !localNotes) {
    return withPendingAnswer(input, output, today, state => answerQuestions(state, questions, [], today, mensagem).text)
  }
  return conversa?.kind === 'query' && !temFato && !consultaIncompleta
    ? withPendingAnswer(input, output, today, state => respostaLocal(state, mensagem, today, true)?.text)
    : output
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
