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
import { editActionFor, findEditCandidates, parseEditRequest } from './editSaved'
import type { EditableTxField } from './editSaved'
import { editBlockReason } from './execute'
import type {
  AssistantCandidateAction, AssistantCapabilities, AssistantClarification,
  AssistantDiagnostics, AssistantErrorCode, AssistantResponse, AssistantUnresolvedClause,
} from './contracts'
import { ASSISTANT_CONTRACT_VERSION, MAX_ACTIONS_PER_BATCH, actionSpec, isValidationFailure, validateAction } from './contracts'
import { analyzeMessage, contestsProposal, looksLikeRetraction, looksRecurring } from './clauses'
import { categoryDilemma, outOfPatternWarning, withLearnedCategory } from './learning'
import { explainRequest } from './explain'
import { answerConversation, isFocusFresh, looksLikeFollowUp } from './conversation'
import { buildTurnPlan, hasBlock } from './semantic/turn'
import { parseDriverDay } from './semantic/driverDay'
import { clampMessage, describeRepairs, repairStructuralTypos, stripFillers } from './semantic/normalize'
import { conflictQuestion, evidenceFor, mergeByField, sameFact } from './semantic/evidence'
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
import { askAssistant } from '../services/ai'
import { buildCapabilities } from './capabilities'
import { describeAction } from '../services/nlp'
import { isDriver, findPossibleDuplicate, defaultIncomeCategory } from '../services/profile'
import { catById, usableCategories } from '../data/categories'
import { fmtBRL, todayISO, uid } from '../utils/format'
import { normalizeName, sentenceCase } from '../utils/text'
import { brDate, dateLabel, findDate, previousYearOf, resolveDayInWindow } from './dates'

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
  history: { role: string; text: string }[]
  draft?: AssistantDraft
  /** Proposta ainda na tela — alvo de correções. */
  pending?: AssistantCandidateAction[]
  /** Pergunta de esclarecimento aberta, para casar a resposta do usuário. */
  pendingClarification?: AssistantClarification
  remoteEnabled: boolean
  /** Injetável: os testes rodam sem rede. */
  askRemote?: (args: { state: AppState; message: string; history: { role: string; text: string }[] }) => Promise<RemoteResult | null>
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
  const ambiguous = analysis.clauses.find(c => c.ambiguity)
  const dateAmbiguous = analysis.clauses.find(c => c.dateAmbiguity)

  // A informação temporal tem PRIORIDADE sobre as outras perguntas: ela decide
  // se o lançamento existe. Perguntar o cartão antes de saber se a despesa
  // aconteceu seria conversar sobre um fato que talvez nem exista.
  const temporalAsk = analysis.clauses.find(c => c.temporal && !c.temporal.plan)?.temporal
  const temporalPlan = analysis.clauses.find(c => c.temporal?.plan)?.temporal
  if (temporalAsk) clarification = temporalClarification(temporalAsk)

  const { actions: reconciled, clarification: goalClar } = reconcileGoalDeposits(input.state, analysis.actions)
  if (goalClar && !clarification) clarification = goalClar

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
      action = withLearnedCategory(input.state, action, today)

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

  if (!clarification && ambiguous?.ambiguity) {
    // Cada opção carrega a lista COMPLETA de ações já resolvidas: escolher
    // "GNV" não obriga o usuário a repetir o valor nem a descrição.
    clarification = {
      question: ambiguous.ambiguity.question,
      options: ambiguous.ambiguity.options.map(o => ({ label: o.label, value: o.label, actions: o.actions })),
      field: 'ambiguity',
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
    // CUIDADO: `askAssistant` tem parser próprio e, quando acha uma ação, monta
    // "Entendi isso… / Confirmar?". Isso é uma PROPOSTA, não a resposta de uma
    // pergunta — usá-la aqui mostrava a proposta na tela sem nenhum botão para
    // confirmar. A pergunta segue em aberto e vai para quem sabe respondê-la.
    if (r.actions?.length || /entendi isso/i.test(r.text)) continue
    parts.push(r.text)
    answered.push(q)
  }
  return { text: parts.join('\n\n'), answered }
}

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

const rejectionNote = (rejected: LocalPass['rejected']): string => {
  if (!rejected.length) return ''
  const first = rejected[0]
  const what = first.detail ? `${first.kind} (${first.detail})` : first.kind
  return `\n\nUma parte não pôde ser registrada — ${what}. Se quiser, reformule só esse pedaço.`
}

export async function orchestrate(entradaBruta: OrchestratorInput): Promise<OrchestratorOutput> {
  const started = Date.now()
  // FRONTEIRA (regra 46): caractere invisível e de controle saem AQUI, antes de
  // qualquer interpretação. Sem isso o `\b` que o usuário colou sem perceber
  // sobrevivia até a DESCRIÇÃO do lançamento, voltava na resposta e ia parar no
  // histórico; e um `U+202E` no meio de um nome inverte visualmente a linha
  // inteira na tela. Depois desta linha, o resto do código pode confiar.
  const limpa = clampMessage(entradaBruta.message)
  const input: OrchestratorInput = limpa.text === entradaBruta.message
    ? entradaBruta
    : { ...entradaBruta, message: limpa.text }
  const caps = buildCapabilities(input.state)
  const today = input.today || todayISO()

  // ---- 0) A mensagem escolhe uma opção que o assistente ofereceu? --------
  // "GNV" logo depois de "gás de cozinha ou GNV?" precisa recuperar o valor e
  // a descrição da mensagem anterior — o usuário não repete nada.
  const pc = input.pendingClarification
  if (pc?.options?.length) {
    const said = normalizeName(input.message)
    const hit = pc.options.find(o =>
      normalizeName(o.label) === said || normalizeName(o.value) === said ||
      (said.length > 2 && (normalizeName(o.label).includes(said) || said.includes(normalizeName(o.label)))))
    if (hit) {
      if (hit.actions?.length) {
        const cands = hit.actions.map(a => candidate(a, 'local'))
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cands, unresolved: [],
            reply: `${proposalText(cands)}\n\nConfirmar?`,
          },
        }
      }
      // Escolha que significa NÃO REGISTRAR ("é um plano"): a explicação já vem
      // pronta na opção, para o usuário não ficar sem saber por que nada foi
      // lançado.
      if (hit.reply) {
        return {
          draft: null,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'answer', engine: 'local',
            actions: [], unresolved: [], reply: hit.reply,
          },
        }
      }
      // Opção sem efeito pré-calculado (ex.: escolha de cartão): a resposta
      // segue o fluxo normal já com o valor escolhido embutido na frase.
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
          reply: `${proposalText(cands)}\n\nConfirmar?`,
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
          reply: `${proposalText(cands)}\n\nConfirmar?`,
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

${proposalText(cands)}

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
          reply: `${plan.summary.join(' ')}\n\n${proposalText(next)}\n\nConfirmar?`,
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
    const pedido = parseEditRequest(input.message, caps, today)
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
      if (candidatos.length === 1) {
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
        const v = validateAction(withLearnedCategory(input.state, comData, today), caps, today)
        if (!isValidationFailure(v)) cands.push(candidate(v.action, 'local'))
      }
      if (cands.length) {
        return {
          draft: null,
          focus: input.focus,
          response: {
            version: ASSISTANT_CONTRACT_VERSION, mode: 'propose_actions', engine: 'local',
            actions: cands, unresolved: [],
            reply: `${proposalText(cands)}\n\nConfirmar?`,
          },
        }
      }
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
  const assumeAgora = !!conversa && (
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
    const incomplete = detectIncomplete(mensagem, caps)
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
  const questions = analysis.clauses.filter(c => c.intent === 'question')
  const local_answers = answerQuestions(input.state, questions, candidates)
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
  if (!candidates.length && !clarification && !local_answers.text
    && unresolved.length && input.remoteEnabled && input.planRemoteQuery) {
    const bruto = await input.planRemoteQuery({ state: input.state, message: mensagem })
    if (bruto) {
      const v = validateQueryPlan(bruto, input.state, today)
      if (!isQueryFailure(v)) {
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
    const remote = await input.askRemote({ state: input.state, message: input.message, history: input.history })
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
            candidates.push(candidate(a, 'remote', undefined, 'medium'))
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
  // A IA remota caiu (vazia, 502, timeout, rede). O usuário precisa saber que a
  // pergunta ficou sem resposta POR ISSO — antes ele recebia o texto genérico
  // de ajuda e não tinha como distinguir "não entendi" de "estou fora do ar".
  const remoteNote = !remoteReply && unresolved.some(u => u.reason === 'remote-unavailable')
    ? 'Não consegui falar com o assistente por IA agora, então essa pergunta ficou sem resposta. Tente de novo em instantes — registrar e consultar seus números continua funcionando normalmente.'
    : null
  const answerPart = [local_answers.text, remoteReply, cenarioJunto?.reply, hypo, planNote, remoteNote]
    .filter(Boolean).join('\n\n')
  const rejectedAll = [...local.rejected, ...remoteRejected]

  let reply: string
  let mode: AssistantResponse['mode']
  /** Foco devolvido ao chamador. So muda quando a consulta de fato respondeu. */
  let focoFinal: ConversationFocus | undefined = cenarioJunto?.focus || input.focus

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
    if (local.intencaoDeclarada && !candidates.length) {
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
          ? 'Não tenho certeza do que registrar aqui. Pode escrever de outro jeito?'
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
