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
import { lastReversibleBatch } from './journal'
import { editActionFor, findEditCandidates, parseEditRequest, parseSpokenCorrection } from './editSaved'
import type { EditableTxField } from './editSaved'
import { editBlockReason } from './execute'
import type {
  AssistantCandidateAction, AssistantCapabilities, AssistantClarification,
  AssistantDiagnostics, AssistantErrorCode, AssistantResponse, AssistantUnresolvedClause,
} from './contracts'
import { ASSISTANT_CONTRACT_VERSION, MAX_ACTIONS_PER_BATCH, actionSpec, errorMessage, isValidationFailure, validateAction } from './contracts'
import { PEDE_APAGAR, analyzeMessage, contestsProposal, declaresIntention, looksLikeQuestion, looksLikeRetraction, looksPast, looksRecurring } from './clauses'
import { categoryDilemma, outOfPatternWarning, withLearnedCategory } from './learning'
import { explainRequest } from './explain'
import { answerConversation, isFocusFresh, looksLikeFollowUp } from './conversation'
import { buildRemoteConversation } from './conversation/remoteContext'
import type { RemoteConversationContext, RemoteTurnRelation } from './conversation/remoteContext'
import { buildTurnPlan, hasBlock } from './semantic/turn'
import { parseDriverDay } from './semantic/driverDay'
import { parseTypedPairs } from './semantic/pairs'
import { clampMessage, describeRepairs, repairStructuralTypos, stripFillers } from './semantic/normalize'
import { conflictQuestion, evidenceFor, mergeByField, sameFact } from './semantic/evidence'
import { classifyLocalDecision } from './semantic/confidence'
import { modalidadeExplicita, planoContradizModalidade } from './semantic/modality'
import { semAlegacaoDeExecucao } from './claims'
import { composeAnswer, explainQueryResult, isQueryFailure, runQuery, validateQueryPlan } from './query'
import { rememberQuery } from './conversation'
import type { RepairedText } from './semantic/normalize'
import type { ConversationFocus } from './conversation'
import type { AnalyzedClause, MessageAnalysis, TemporalSignal } from './clauses'
import { detectIncomplete, isDraftFresh, newDraft, resolveDraftAnswer } from './drafts'
import type { AssistantDraft } from './drafts'
import { applyCorrection, parseCorrection } from './corrections'
import type { CorrectionPlan } from './corrections'
import { findGoalByName, planAssistantActions } from './execute'
import { askAssistant, normalizeQuestion, respostaDeMetaCitada } from '../services/ai'
import { perguntaDeFatura, perguntaNominal } from './cashQuestions'
import { buildCapabilities } from './capabilities'
import { describeAction, META_OUTRA } from '../services/nlp'
import { isDriver, findPossibleDuplicate, defaultIncomeCategory } from '../services/profile'
import { catById, usableCategories } from '../data/categories'
import { addDays, fmtBRL, todayISO, uid } from '../utils/format'
import { occurrenceRecord, occurrencesBetween, recurringActiveOn } from '../services/calc'
import { normalizeName, sentenceCase } from '../utils/text'
import { brDate, dateLabel, findDate, previousYearOf, resolveDayInWindow } from './dates'
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
    const anterior = previousYearOf(t.date)
    return {
      question: `A data ${brDate(t.date)} ainda não chegou. Foi ${brDate(anterior)} ou você quer planejar para ${brDate(t.date)}?`,
      field: 'date',
      options: [
        { label: brDate(anterior), value: anterior, actions: withDate(t.actions, anterior) },
        plano,
      ],
    }
  }
  const quando = t.date && !t.imprecise ? ` (${brDate(t.date)})` : ''
  return {
    question: `"${t.text}"${quando} ainda não chegou. Isso já aconteceu ou é um plano que você quer registrar quando acontecer?`,
    field: 'date',
    options: [
      { label: 'Já aconteceu', value: 'ja-aconteceu', actions: withDate(t.actions) },
      plano,
    ],
  }
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
  const dateAmbiguous = analysis.clauses.find(c => c.dateAmbiguity)

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
      if (!caps.isDriver) {
        const a: any = action
        if (a.kind === 'fuel' && a.amount > 0) {
          action = { kind: 'expense', amount: a.amount, category: 'combustivel', description: 'Combustível', date: a.date }
        } else if (a.kind === 'maintenance') {
          action = { kind: 'expense', amount: a.cost, category: 'manutencao', description: `Troca de ${a.item}`, date: a.date }
        }
      }

      // O vocabulário do usuário entra ANTES da validação: a categoria que ele
      // mesmo usa precisa passar pelas mesmas regras de qualquer outra.
      action = withLearnedCategory(input.state, action, today, input.message)

      const res = validateAction(action, caps, today)
      if (isValidationFailure(res)) {
        rejected.push({ kind: action.kind, code: res.code, detail: res.detail })
        continue
      }
      // Duas categorias fortes disputando a mesma frase: o usuário lança no
      // Quiosque tanto em Lazer quanto em Compras. Escolher seria sortear;
      // ignorar as duas jogaria fora o que ele já disse. A saída é a mesma do
      // resto do app — perguntar, com as opções carregando a proposta pronta.
      const dilema = categoryDilemma(input.state, res.action, today)
      if (dilema) dilemas.push({ actionId: '', ...dilema })

      // A proposta mostra a categoria que SERÁ gravada, não um campo vazio que
      // o usuário só descobre depois de confirmar.
      const withDefaults: any = { ...res.action }
      if (withDefaults.kind === 'income' && !withDefaults.category) withDefaults.category = defaultIncomeCategory(input.state.settings)
      if (withDefaults.kind === 'expense' && !withDefaults.category) withDefaults.category = 'outros-out'
      candidates.push(candidate(withDefaults, 'local', clause.id, clause.confidence))
    }
  }

  const unresolved = analysis.unresolvedClauses
    .filter(c => c.intent !== 'conversation')
    .map(c => unresolvedOf(c, c.intent === 'question' ? 'question-unanswered' : 'not-understood'))

  if (semMeta.length && !clarification) clarification = goalDepositClarification(input.state, semMeta, candidates)
  if (alteracaoSemMeta.length && !clarification) clarification = goalUpdateClarification(input.state, alteracaoSemMeta[0], candidates)

  if (!clarification && ambiguous?.ambiguity) {
    // Cada opção carrega a lista COMPLETA de ações já resolvidas: escolher
    // "GNV" não obriga o usuário a repetir o valor nem a descrição.
    clarification = {
      question: ambiguities.length > 1
        ? ambiguities.map(c => c.ambiguity!.question).join('\n\n')
        : ambiguous.ambiguity.question,
      options: ambiguities.length > 1 ? [] : ambiguous.ambiguity.options.map(o => ({ label: o.label, value: o.label, actions: o.actions, reply: o.reply })),
      field: ambiguities.length > 1 ? 'financial-events' : ambiguous.ambiguity.field || 'ambiguity',
    }
  }

  // Cartão citado que não existe, ou fatura sem cartão com vários cadastrados:
  // não vira ação executável — vira pergunta específica.
  for (const c of candidates) {
    const a: any = c.action
    // `'cardName' in a` não serve: a validação remove campos ausentes, então a
    // chave simplesmente não existe. Quem sabe se a ação ACEITA cartão é o
    // catálogo.
    if (!actionSpec(a.kind)?.fields.some(f => f.name === 'cardName')) continue
    if (a.cardName) {
      const known = caps.cardNames.some(n => normalizeName(n) === normalizeName(a.cardName)
        || normalizeName(n).includes(normalizeName(a.cardName)))
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
  if (!clarification && dateAmbiguous?.dateAmbiguity) {
    clarification = {
      question: dateAmbiguous.dateAmbiguity.question,
      options: dateAmbiguous.dateAmbiguity.options,
      field: 'date',
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
function answerQuestions(
  state: AppState,
  questions: AnalyzedClause[],
  candidates: AssistantCandidateAction[],
  today: string,
): { text: string; answered: AnalyzedClause[]; focus?: ConversationFocus } {
  if (!questions.length) return { text: '', answered: [] }
  const projected = candidates.length
    ? planAssistantActions(state, candidates.map(c => ({ id: c.id, action: c.action }))).projected
    : state

  const parts: string[] = []
  const answered: AnalyzedClause[] = []
  let focus: ConversationFocus | undefined
  for (const q of questions) {
    const pergunta = perguntaComAssunto(caudaDaPergunta(q.text, candidates), candidates)
    // A consulta só entra ao lado de um registro e com pergunta inteira. Sem
    // registro, quem responde é o turno normal, que lê a mensagem toda; e um
    // fragmento ("minha reserva tá em | quanto") virava "Total gasto este mês".
    const usaConsulta = candidates.length > 0 && pergunta.trim().split(/\s+/).length >= 3
    const real = respostaLocal(state, pergunta, today, usaConsulta)
    const comRegistro = candidates.length ? respostaLocal(projected, pergunta, today, usaConsulta) : real
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
  return { text: parts.join('\n\n'), answered, focus }
}

/**
 * A resposta local de uma pergunta solta, como no turno sem registro: a
 * consulta toma a frente só no que o roteador antigo não expressa, e responde
 * quando ele não sabe. Antes, sem resposta do roteador, "gastei 50, quanto
 * sobrou esse mês?" respondia só "se você confirmar, saem R$ 50".
 */
function respostaLocal(
  state: AppState, pergunta: string, today: string, usaConsulta: boolean,
): { text: string; focus?: ConversationFocus } | null {
  const conv = usaConsulta ? answerConversation(state, pergunta, { today }) : null
  const consulta = conv?.kind === 'query' ? conv : null
  if (consulta?.beyondLegacy) return { text: consulta.reply, focus: consulta.focus }
  const r = askAssistant(state, pergunta)
  // CUIDADO: `askAssistant` tem parser próprio e, quando acha uma ação, monta
  // "Entendi isso… / Confirmar?". Isso é uma PROPOSTA, não a resposta de uma
  // pergunta — usá-la aqui mostrava a proposta na tela sem nenhum botão para
  // confirmar. A pergunta segue em aberto e vai para quem sabe respondê-la.
  if (r.handled !== false && !r.actions?.length && !/entendi isso/i.test(r.text)) return { text: r.text, focus: consulta?.focus }
  return consulta ? { text: consulta.reply, focus: consulta.focus } : null
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
  if (!/^\s*(?:e\s+)?quanto\s+(?:ainda\s+)?(?:falta|faltam|resta|restam)\s*\??\s*$/i.test(pergunta)) return pergunta
  const alvos = candidates.map(c => c.action as any).filter(a => a.kind === 'goal-deposit' || a.kind === 'card-payment')
  if (alvos.length !== 1) return pergunta
  const [a] = alvos
  if (a.kind === 'goal-deposit' && a.name) return `quanto falta para a meta ${a.name}`
  if (a.kind === 'card-payment' && a.cardName) return `quanto falta pagar da fatura do ${a.cardName}`
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
function acrescimoAProposta(pending: AssistantCandidateAction[], mensagem: string): string | null {
  const tipos = new Set(pending.map(p => p.action.kind).filter(k => k === 'expense' || k === 'income'))
  if (tipos.size !== 1) return null
  const m = mensagem.toLowerCase().trim().match(/^(?:e\s+)?(?:mais\s+|tamb[ée]m\s+)?(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais|real|conto|contos|pila)?\s+(de|do|da|dos|das|no|na|nos|nas|em|com|pro|pra|para)\s+([a-zà-úç][a-zà-úç0-9\s]{1,40}?)\s*[?.!]*$/)
  if (!m) return null
  return `${tipos.has('income') ? 'recebi' : 'gastei'} ${m[1]} ${m[2]} ${m[3]}`
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

/**
 * Gasto avulso com o nome de uma conta fixa que tem vencimento sem confirmação.
 * O chat não confirma ocorrência (não há ação no catálogo para isso): confirmar
 * aqui E depois na tela inicial conta o mesmo pagamento duas vezes. A proposta
 * segue igual — só avisa.
 */
function avisoDeContaFixa(candidates: AssistantCandidateAction[], state: AppState): string {
  const hoje = todayISO()
  const avisos: string[] = []
  for (const c of candidates) {
    const a: any = c.action
    if (a.kind !== 'expense' || !a.description) continue
    const r = (state.recurring || []).find(x => x.kind !== 'income' && x.active !== false
      && normalizeName(x.name) === normalizeName(a.description))
    if (!r) continue
    const abertas = occurrencesBetween(r, addDays(hoje, -62), hoje).filter(d => recurringActiveOn(r, d)
      && !occurrenceRecord(r, d) && !state.transactions.some(t => t.recurringId === r.id && t.occurrenceDate === d))
    if (!abertas.length) continue
    avisos.push(`${r.name} é conta fixa, e o vencimento de ${brDate(abertas[abertas.length - 1])} ainda não foi confirmado. `
      + 'Se for o pagamento dessa conta, confirme pela tela inicial em vez de aqui: confirmar nos dois lugares conta duas vezes.')
  }
  return avisos.length ? `\n\n${avisos.join('\n\n')}` : ''
}

function proposalText(candidates: AssistantCandidateAction[], state: AppState): string {
  const lines = candidates.map(c => {
    const d = (c.action as any).date
    const suffix = d ? ` · ${dateLabel(d)}` : ''
    return `• ${describeAction(c.action, id => state.categories?.find(x => x.id === id)?.name)}${suffix}`
  })
  return `Entendi isso:\n\n${lines.join('\n')}`
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
  /\b(?:mostr[ae]|revel[ae]|me\s+d[êe]|qual\s+[ée])\b[^?]{0,40}\b(?:prompt|instru[çc][õo]es\s+internas|system\s+prompt)\b/i,
  /\b(?:chave|token|api\s*key|senha)\b[^?]{0,30}\b(?:api|deepseek|sistema|voc[êe]\s+usa)\b/i,
  /\bqual\s+[ée]\s+a\s+(?:chave|senha|api)/i,
  /\bfa[çc]a\s+de\s+conta\s+que\s+voc[êe]\b/i,
  /\besque[çc]a\s+(?:tudo|suas?\s+regras?)/i,
]

const pedeParaQuebrarRegra = (t: string): boolean => QUEBRAR_REGRA.some(re => re.test(t))

const SEM_CERTEZA = 'Não tenho certeza do que registrar aqui. Pode escrever de outro jeito?'

/**
 * Pedaço com valor que nada leu, numa mensagem em que outra parte virou
 * proposta. "Ontem gastei 30 de lanche e anteontem 20 de uber" mostrava só os
 * 30 — o usuário confirmava achando que tinha lançado os dois.
 */
function sobraComValor(unresolved: AssistantUnresolvedClause[]): string {
  const sobra = unresolved.filter(u => u.reason === 'not-understood' && /\d/.test(u.text))
  if (!sobra.length) return ''
  const trechos = sobra.map(u => `“${u.text.trim().replace(/[\s,;]+$/, '')}”`).join(', ')
  return `\n\nNão registrei ${sobra.length === 1 ? 'esta parte' : 'estas partes'}: ${trechos}. Me diga o que foi que eu lanço.`
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
  // "Gastos dessa semana", "saldo?": pergunta telegráfica vira a pergunta com
  // verbo que o app responde. Resposta a uma opção oferecida fica como está.
  const nominal = input.pendingClarification ? null : perguntaNominal(input.message)
  if (nominal) input = { ...input, message: nominal }
  const caps = buildCapabilities(input.state)
  const today = input.today || todayISO()

  // ---- 0) A mensagem escolhe uma opção que o assistente ofereceu? --------
  // "GNV" logo depois de "gás de cozinha ou GNV?" precisa recuperar o valor e
  // a descrição da mensagem anterior — o usuário não repete nada.
  const pc = input.pendingClarification
  if (pc?.options?.length) {
    const said = normalizeName(input.message)
    const financialEvent = pc.field === 'financial-event'
    // Para dinheiro, só uma resposta inequívoca aceita a ação antiga. "assim"
    // contém "sim", e "sim, mandei só 10" altera o valor da proposta.
    const simpleAnswer = said.replace(/[.!?]+$/g, '').trim()
    const negativeAnswer = financialEvent && /^(?:nao|nem)(?:\b|$)/.test(simpleAnswer)
    const hit = pc.options.find(o => financialEvent
      ? (normalizeName(o.label) === simpleAnswer || normalizeName(o.value) === simpleAnswer
        || (negativeAnswer && normalizeName(o.label) === 'nao'))
      : (normalizeName(o.label) === said || normalizeName(o.value) === said ||
        (said.length > 2 && (normalizeName(o.label).includes(said) || said.includes(normalizeName(o.label))))))
    if (hit) {
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
        const previous = pc.field === 'financial-event' ? input.pending || [] : []
        const cands = [...previous, ...validated.map(a => candidate(a, 'local'))]
        return {
          draft: null,
          correctedPending: previous.length ? cands : undefined,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cands, unresolved: [],
            reply: `${proposalText(cands, input.state)}\n\nConfirmar?`,
          },
        }
      }
      // Escolha que significa NÃO REGISTRAR ("é um plano"): a explicação já vem
      // pronta na opção, para o usuário não ficar sem saber por que nada foi
      // lançado.
      if (hit.reply) {
        return {
          draft: null,
          keepPending: pc.field === 'financial-event',
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
  }

  // ---- 1) A mensagem responde "que dia foi?" dentro de um período? ------
  // "mês passado" + "dia 10" só pode virar 10 do mês passado. Fora da janela a
  // pergunta continua aberta — nada é aproximado e nada cai em hoje.
  if (pc?.field === 'date' && pc.dateWindow && pc.pendingActions?.length) {
    const iso = resolveDayInWindow(input.message, pc.dateWindow, today)
    if (iso) {
      const cands = withDate(pc.pendingActions, iso).map(a => candidate(a, 'local'))
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: cands, unresolved: [],
          reply: `${proposalText(cands, input.state)}\n\nConfirmar?`,
        },
      }
    }
    // Resposta inválida ou fora da janela: a pergunta continua aberta. Cair no
    // fluxo comum descartava `pendingClarification`; pior, uma data completa de
    // outro mês podia ser reduzida ao número do dia e reinterpretada.
    const from = brDate(pc.dateWindow.from)
    const to = brDate(pc.dateWindow.to)
    return {
      draft: null,
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
  if (pc?.field === 'date' && !pc.dateWindow && pc.pendingActions?.length) {
    const corrected = findDate(input.message, today)
    if (corrected?.kind === 'date') {
      const cands = withDate(pc.pendingActions, corrected.date).map(a => candidate(a, 'local'))
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: cands, unresolved: [],
          reply: `${proposalText(cands, input.state)}\n\nConfirmar?`,
        },
      }
    }
    if (corrected?.kind === 'future') {
      const clarification = temporalClarification({
        kind: 'future', text: corrected.text, label: corrected.label,
        date: corrected.date, relative: corrected.relative,
        imprecise: corrected.imprecise, actions: pc.pendingActions,
        conflict: true,
      })
      return {
        draft: null,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'clarify', engine: 'local',
          actions: [], unresolved: [], clarification, reply: clarification.question,
        },
      }
    }
    return {
      draft: null,
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
  if (isDraftFresh(input.draft)) {
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

  // ---- 5) A mensagem corrige a proposta na tela? -------------------------
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
  if (input.pending?.length && contestsProposal(input.message)
    && !UNDO_REQUEST.test(input.message) && !UNDO_SHORT.test(input.message)) {
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
      const todos = [...input.pending!, ...novo.response.actions]
      return {
        draft: null, focus: input.focus,
        response: {
          version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
          actions: todos, unresolved: [], reply: `${proposalText(todos, input.state)}\n\nConfirmar?`,
        },
      }
    }
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
  if (UNDO_REQUEST.test(input.message) || UNDO_SHORT.test(input.message)) {
    const alvo = lastReversibleBatch(input.state)
    if (alvo) {
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
    const pedido = parseEditRequest(input.message, caps, today)
      ?? parseSpokenCorrection(input.message, caps, today)
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
  let turno = buildTurnPlan(input.state, input.message, { today })
  let mensagem = input.message
  let reparo: RepairedText | null = null

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
      const outro = buildTurnPlan(input.state, semMuleta.text, { today })
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
      const parcial = tentativa.corrections.some(c => c.estrutural) && turno.coverage < 0.999
      if (!hasBlock(turno, 'record') || degradado || parcial) {
        const outro = buildTurnPlan(input.state, tentativa.text, { today })
        const melhorou = outro.coverage > turno.coverage + 1e-6
          || outro.blocks.reduce((n, b) => n + b.actions.length, 0)
            > turno.blocks.reduce((n, b) => n + b.actions.length, 0)
        if ((hasBlock(outro, 'record') || hasBlock(outro, 'scenario'))
          && (!hasBlock(turno, 'record') || degradado || melhorou)) {
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
  const diaTelegrafico = parseDriverDay(mensagem, { driver: caps.isDriver })
  if (diaTelegrafico) {
    const jaAchou = turno.blocks.reduce((n, b) => n + b.actions.length, 0)
    if (diaTelegrafico.actions.length > jaAchou) {
      const dataDoDia = turno.blocks.find(b => b.clause.date)?.clause.date
      const cands: AssistantCandidateAction[] = []
      for (const bruta of diaTelegrafico.actions) {
        const comData: any = { ...bruta }
        if (dataDoDia && actionSpec(bruta.kind)?.fields.some(f => f.name === 'date')) comData.date = dataDoDia
        const v = validateAction(withLearnedCategory(input.state, comData, today, mensagem), caps, today)
        if (!isValidationFailure(v)) cands.push(candidate(v.action, 'local'))
      }
      if (cands.length) {
        return {
          draft: null,
          focus: input.focus,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cands, unresolved: [],
            reply: `${proposalText(cands, input.state)}\n\nConfirmar?`,
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
    if (pares.length > jaAchou) {
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
  const temFato = hasBlock(turno, 'record')

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
  const conversa = temFato ? null : answerConversation(input.state, mensagem, {
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
      unresolved: [], reply: conversa.reply,
    }
    return {
      draft: null,
      // Perguntar não é cancelar: a proposta na tela continua confirmável.
      keepPending: true,
      focus: conversa.focus,
      response: conversa.kind === 'clarify' && conversa.clarification
        ? { ...base, mode: 'clarify', actions: [], clarification: conversa.clarification }
        : { ...base, mode: 'answer', actions: [] },
    }
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
    const daMeta = respostaDeMetaCitada(input.state, mensagem)
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

  // ---- 13) Intenção incompleta vira rascunho ------------------------------
  if (!candidates.length && !clarification) {
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
  const local_answers = answerQuestions(input.state, questions, candidates, today)
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
    && unresolved.length && input.remoteEnabled && input.planRemoteQuery) {
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
        const r = runQuery(input.state, v.plan)
        return {
          draft: null,
          keepPending: true,
          focus: rememberQuery(input.focus, v.plan, r, explainQueryResult(r)),
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'hybrid',
            actions: [], unresolved: [], reply: composeAnswer(r),
          },
        }
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
    const textoRemoto = candidates.length ? unresolved.map(u => u.text).join('\n') : input.message
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

  // ---- 17) Avisos de duplicidade (contra o estado E dentro do lote) -------
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
    // Valor muito fora do padrão do próprio usuário — quase sempre um zero a
    // mais. AVISA, nunca bloqueia: o dia excepcional existe, e barrá-lo seria
    // pior que o erro que se quer evitar.
    const pattern = outOfPatternWarning(input.state, c.action, today)
    const next = warn ? { ...c, duplicateWarning: warn } : c
    return pattern ? { ...next, patternWarning: pattern } : next
  })

  // ---- 18) Texto final ----------------------------------------------------
  const hypo = questions.length && candidates.length && !local_answers.text ? hypotheticalSummary(candidates) : null
  // A intenção futura vira TEXTO, nunca lançamento — e continua aparecendo
  // mesmo quando o resto da mensagem gerou registros.
  const planNote = local.temporalPlan ? futurePlanReply(local.temporalPlan) : null
  const intentionNote = candidates.length
    ? analysis.clauses.filter(c => c.intention && /\d/.test(c.text))
      .map(c => `“${c.text.replace(/[.,;]\s*$/, '')}” descreve intenção futura; não registrei essa parte como realizada.`)
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
  const answerPart = [local_answers.text, remotoSemAlegacao, cenarioJunto?.reply, hypo, planNote, intentionNote, remoteNote]
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
    reply = candidates.length
      ? `${proposalText(candidates, input.state)}\n\n${clarification.question}`
      : clarification.question
  } else if (candidates.length && answerPart) {
    mode = 'answer_and_actions'
    reply = `${proposalText(candidates, input.state)}${sobraComValor(unresolved)}${avisoDeContaFixa(candidates, input.state)}\n\n${answerPart}\n\nConfirmar os registros?`
  } else if (candidates.length) {
    mode = 'propose_actions'
    reply = `${proposalText(candidates, input.state)}${sobraComValor(unresolved)}${avisoDeContaFixa(candidates, input.state)}\n\nConfirmar?`
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
      reply = ['Isso ainda não aconteceu, então não registrei nada. '
        + 'Quando acontecer de verdade, me avise que eu lanço na hora.',
      'Se quiser saber como isso ficaria antes de decidir, pergunte com "e se" — '
        + 'por exemplo, "e se eu gastar 200 esse mês?".'].join('\n\n')
    } else if (local.recorrenteDeclarada) {
      // Conta que se repete é previsão: registrar como gasto de hoje somaria ao
      // mês um dinheiro que ainda não saiu (regra 18). O cadastro de recorrência
      // não é por conversa — a tela certa faz isso com data e frequência.
      reply = 'Isso se repete todo período, então não registrei como movimentação de hoje — '
        + 'é uma previsão, não algo que já entrou ou saiu.\n\n'
        + 'Cadastre em Planejamento para eu acompanhar todo mês e te avisar do vencimento.'
    } else if (PEDE_APAGAR.test(mensagem)) {
      // "Não registrei nada" respondia um pedido de APAGAR como se fosse negação.
      reply = 'Por aqui eu não apago lançamentos salvos. Para remover, abra Movimentações e apague o lançamento. '
        + 'Se foi o último registro feito por mim, diga "desfaz o último".'
    } else if (negadas.length) {
      // O usuário disse que NÃO fez o lançamento. Confirmar isso em voz alta é
      // parte da correção — e nada pode sugerir registro.
      reply = 'Entendi que isso não aconteceu — não registrei nada. Se quiser lançar outra coisa, é só me dizer.'
    } else if (notUnderstood.length && (candidates.length || analysis.clauses.some(c => c.handled))) {
      reply = `Não consegui interpretar esta parte: "${notUnderstood[0].text}". Pode reformular só esse pedaço?`
    } else {
      // CUIDADO: `askAssistant` tem o próprio parser e monta "Entendi isso… /
      // Confirmar?" a partir dele. Se o orquestrador decidiu que NÃO há ação
      // (negação, hipótese, perfil), esse texto seria uma promessa falsa: a tela
      // mostraria a proposta sem nenhum botão. Só aproveitamos a RESPOSTA.
      const local = askAssistant(input.state, mensagem)
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
  return { draft: null, response, focus: focoFinal }
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
