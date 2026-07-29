// ---------------------------------------------------------------------------
// CONTRATO DO ASSISTENTE — fonte única, compartilhada entre cliente e servidor.
//
// REGRA CRÍTICA DE PORTABILIDADE: este arquivo é importado por `api/**`, que roda
// sob o loader ESM nativo do Node (ver regra 24 do CLAUDE.md). Por isso ele:
//   1. NÃO faz nenhum import relativo em runtime — só `import type`, que o
//      TypeScript apaga na compilação e nunca vira um `import` de verdade;
//   2. não toca em `window`, `localStorage`, `import.meta` nem em segredo algum.
// Quebrar (1) faz a função serverless morrer com ERR_MODULE_NOT_FOUND.
// ---------------------------------------------------------------------------

import type { ParsedAction, ProfileId } from '../models/types'

/**
 * Versão do contrato. Sobe quando a FORMA da resposta muda de um jeito que um
 * cliente antigo não entenderia. Resposta com versão desconhecida é recusada —
 * nunca interpretada "na sorte".
 */
export type AssistantContractVersion = 1
export const ASSISTANT_CONTRACT_VERSION: AssistantContractVersion = 1

export type AssistantEngine = 'local' | 'remote' | 'hybrid'
export type AssistantConfidence = 'high' | 'medium' | 'low'

/** O que uma cláusula da mensagem quer dizer. */
export type AssistantIntent =
  | 'record'        // relata um fato financeiro
  | 'question'      // pergunta algo
  | 'correction'    // corrige/nega/remove algo proposto ou registrado
  | 'clarification' // responde a uma pergunta que o assistente fez
  | 'conversation'  // conversa, aviso, saudação
  | 'unknown'       // não compreendido

// ---------------------------------------------------------------------------
// CATÁLOGO DE AÇÕES — a fonte de verdade de tudo
// ---------------------------------------------------------------------------
// Tipos, validação, schema enviado à IA, documentação e testes saem DAQUI.
// Anunciar ao modelo uma ação ausente deste catálogo é proibido por construção:
// o prompt é gerado a partir dele.

export type AssistantActionKind = ParsedAction['kind']

export type FieldType = 'money' | 'int' | 'quantity' | 'text' | 'date' | 'flag'

export interface ActionFieldSpec {
  name: string
  type: FieldType
  required?: boolean
  /** Categoria precisa existir E ser deste tipo. */
  categoryOf?: 'income' | 'expense'
  min?: number
  max?: number
  maxLength?: number
  /**
   * Data de um fato JÁ OCORRIDO — não pode estar no futuro. É a última barreira
   * contra o defeito que motivou esta regra: uma data futura reconhecida sendo
   * trocada por hoje sem ninguém avisar. Vencimento e previsão usam campos
   * próprios (`firstDueDate`), que continuam podendo ser futuros.
   */
  notFuture?: boolean
  /** Texto usado para gerar o schema do prompt remoto. */
  describe: string
}

export interface ActionSpec {
  kind: AssistantActionKind
  /** Rótulo curto em pt-BR, usado na revisão e nas mensagens de erro. */
  label: string
  /** Só existe no perfil motorista — bloqueado nos demais, venha de onde vier. */
  driverOnly?: boolean
  /** A IA remota pode propor esta ação? `reset` nunca pode. */
  remoteAllowed: boolean
  /** Pelo menos um destes campos precisa estar presente (além dos `required`). */
  anyOf?: string[]
  fields: ActionFieldSpec[]
  promptHint?: string
}

const money = (name: string, describe: string, required = true): ActionFieldSpec =>
  ({ name, type: 'money', required, min: 0.01, max: 99_999_999, describe })

const dateField: ActionFieldSpec = {
  name: 'date', type: 'date', required: false, notFuture: true,
  describe: 'data do fato no formato YYYY-MM-DD. Omita quando for hoje. NUNCA invente uma data e NUNCA use uma data futura: o que ainda não aconteceu não se registra',
}

const textField = (name: string, describe: string, maxLength = 80): ActionFieldSpec =>
  ({ name, type: 'text', required: false, maxLength, describe })

export const ACTION_CATALOG: ActionSpec[] = [
  {
    kind: 'income', label: 'Receita', remoteAllowed: true,
    fields: [
      money('amount', 'valor recebido'),
      { name: 'category', type: 'text', required: false, categoryOf: 'income', describe: 'id de categoria de ENTRADA' },
      textField('description', 'o que foi (ex.: "Uber", "Aluguel")'),
      textField('origin', 'fonte informada EXPLICITAMENTE pelo usuário ("Casa 1", "Cliente João"). NUNCA deduza'),
      dateField,
    ],
    promptHint: 'dinheiro que entrou de verdade',
  },
  {
    kind: 'expense', label: 'Despesa', remoteAllowed: true,
    fields: [
      money('amount', 'valor gasto'),
      { name: 'category', type: 'text', required: false, categoryOf: 'expense', describe: 'id de categoria de SAÍDA' },
      textField('description', 'o objeto real do gasto, sem palavras funcionais'),
      textField('origin', 'fonte informada EXPLICITAMENTE pelo usuário. NUNCA deduza'),
      dateField,
    ],
    promptHint: 'dinheiro que saiu de verdade',
  },
  {
    kind: 'saving', label: 'Guardar na reserva', remoteAllowed: true,
    fields: [
      money('amount', 'valor transferido para a reserva'),
      textField('description', 'onde guardou, se o usuário disser'),
      dateField,
    ],
    promptHint: 'transferência para reserva/investimento ("guardei", "separei", "coloquei na reserva"). NÃO é receita nem despesa',
  },
  {
    kind: 'work', label: 'Trabalho', driverOnly: true, remoteAllowed: true,
    anyOf: ['km', 'trips', 'hours'],
    fields: [
      { name: 'km', type: 'quantity', required: false, min: -100_000, max: 100_000, describe: 'quilômetros RODADOS no trabalho (nunca o hodômetro)' },
      { name: 'trips', type: 'quantity', required: false, min: -999, max: 999, describe: 'número de viagens/corridas' },
      { name: 'hours', type: 'quantity', required: false, min: -24, max: 24, describe: 'horas trabalhadas' },
      dateField,
    ],
  },
  {
    kind: 'fuel', label: 'Abastecimento', driverOnly: true, remoteAllowed: true,
    anyOf: ['amount', 'liters'],
    fields: [
      { name: 'amount', type: 'money', required: false, min: 0.01, max: 100_000, describe: 'valor pago no abastecimento' },
      { name: 'liters', type: 'quantity', required: false, min: 0.01, max: 500, describe: 'litros abastecidos' },
      { name: 'pricePerLiter', type: 'quantity', required: false, min: 0.01, max: 100, describe: 'preço por litro' },
      { name: 'odometer', type: 'quantity', required: false, min: 0, max: 9_999_999, describe: 'hodômetro no momento do abastecimento' },
      dateField,
    ],
    promptHint: 'gera UMA ação fuel — nunca fuel + expense duplicados',
  },
  {
    kind: 'odometer', label: 'Hodômetro', driverOnly: true, remoteAllowed: true,
    fields: [{ name: 'value', type: 'quantity', required: true, min: 0, max: 9_999_999, describe: 'hodômetro atual do veículo' }],
    promptHint: 'hodômetro JAMAIS vira km trabalhado',
  },
  {
    kind: 'maintenance', label: 'Manutenção', driverOnly: true, remoteAllowed: true,
    fields: [
      { name: 'item', type: 'text', required: true, maxLength: 40, describe: 'peça trocada (óleo, pneu, pastilha)' },
      money('cost', 'custo da manutenção'),
      { name: 'km', type: 'quantity', required: false, min: 0, max: 9_999_999, describe: 'hodômetro na troca' },
      { name: 'lifeKm', type: 'quantity', required: false, min: 0, max: 999_999, describe: 'vida útil em km, se informada' },
      dateField,
    ],
  },
  {
    kind: 'goal', label: 'Nova meta', remoteAllowed: true,
    fields: [
      { name: 'name', type: 'text', required: true, maxLength: 60, describe: 'nome da meta' },
      money('target', 'valor alvo'),
      { name: 'months', type: 'quantity', required: false, min: 0.1, max: 600, describe: 'prazo em meses, se informado' },
    ],
    promptHint: 'SEMPRE cria meta nova. Alterar uma existente é goal-update',
  },
  {
    kind: 'goal-update', label: 'Alterar meta', remoteAllowed: true,
    anyOf: ['target', 'months'],
    fields: [
      { name: 'name', type: 'text', required: true, maxLength: 60, describe: 'nome EXATO da meta existente' },
      { name: 'target', type: 'money', required: false, min: 0.01, max: 99_999_999, describe: 'novo valor alvo' },
      { name: 'months', type: 'quantity', required: false, min: 0.1, max: 600, describe: 'novo prazo em meses' },
    ],
  },
  {
    kind: 'goal-deposit', label: 'Guardar na meta', remoteAllowed: true,
    fields: [
      { name: 'name', type: 'text', required: false, maxLength: 60, describe: 'nome da meta existente' },
      money('amount', 'valor guardado na meta'),
    ],
  },
  {
    kind: 'balance', label: 'Saldo em conta', remoteAllowed: true,
    fields: [money('amount', 'saldo atual informado pelo usuário')],
    promptHint: 'só quando o usuário INFORMA o saldo ("meu saldo é 1500")',
  },
  {
    kind: 'card-purchase', label: 'Compra parcelada', remoteAllowed: true,
    fields: [
      money('total', 'valor total da compra'),
      { name: 'installments', type: 'int', required: true, min: 1, max: 120, describe: 'número de parcelas' },
      textField('description', 'o que foi comprado'),
      textField('cardName', 'nome do cartão, se o usuário citar'),
      { name: 'category', type: 'text', required: false, categoryOf: 'expense', describe: 'id de categoria de SAÍDA' },
      { name: 'firstDueDate', type: 'date', required: false, describe: 'primeiro vencimento YYYY-MM-DD, se informado' },
    ],
    promptHint: 'SÓ gere com valor total E número de parcelas. Faltando um, pergunte só o que falta',
  },
  {
    kind: 'financed-cash-inflow', label: 'Entrada financiada', remoteAllowed: true,
    fields: [
      money('total', 'valor cobrado no cartão'),
      money('netReceived', 'valor líquido recebido — nunca maior que total'),
      { name: 'installments', type: 'int', required: true, min: 1, max: 120, describe: 'número de parcelas' },
      textField('cardName', 'nome do cartão'),
      textField('source', 'intermediário/credor informado pelo usuário'),
    ],
    promptHint: 'NUNCA é receita, salário ou lucro',
  },
  {
    kind: 'card-payment', label: 'Pagamento de fatura', remoteAllowed: true,
    fields: [
      textField('cardName', 'nome do cartão'),
      { name: 'amount', type: 'money', required: false, min: 0.01, max: 99_999_999, describe: 'valor pago. Omitir = pagar todo o pendente' },
    ],
    promptHint: 'pagar fatura NÃO é despesa nova',
  },
  {
    kind: 'card-charge', label: 'Assinatura no cartão', remoteAllowed: true,
    fields: [
      money('amount', 'valor mensal'),
      textField('description', 'nome da assinatura'),
      textField('cardName', 'nome do cartão'),
      { name: 'category', type: 'text', required: false, categoryOf: 'expense', describe: 'id de categoria de SAÍDA' },
    ],
  },
  {
    kind: 'reset', label: 'Apagar todos os dados',
    // Barreira determinística: a IA remota NUNCA pode propor reset. Só o parser
    // local, a partir de uma frase explícita do usuário, e ainda com confirmação.
    remoteAllowed: false,
    fields: [],
  },
]

export const actionSpec = (kind: string): ActionSpec | undefined =>
  ACTION_CATALOG.find(a => a.kind === kind)

/** Ações que a IA remota pode propor no perfil informado. */
export function allowedRemoteKinds(profile: ProfileId): AssistantActionKind[] {
  const driver = profile === 'driver'
  return ACTION_CATALOG.filter(a => a.remoteAllowed && (driver || !a.driverOnly)).map(a => a.kind)
}

// ---------------------------------------------------------------------------
// ERROS — específicos, nunca genéricos
// ---------------------------------------------------------------------------

export type AssistantErrorCode =
  | 'invalid-amount' | 'invalid-date' | 'future-date' | 'invalid-number'
  | 'category-not-found' | 'category-wrong-type'
  | 'card-not-found' | 'card-ambiguous' | 'goal-not-found' | 'goal-ambiguous'
  | 'duplicate' | 'missing-field' | 'profile-forbidden'
  | 'invoice-empty' | 'insufficient-reserve'
  | 'unsupported-action' | 'conflict' | 'text-too-long' | 'unknown-field'

/** Mensagem em pt-BR para o usuário. NUNCA "não encontrei a meta" para tudo. */
export const ERROR_MESSAGES: Record<AssistantErrorCode, string> = {
  'invalid-amount': 'O valor informado não é um número válido.',
  'invalid-date': 'Não consegui entender a data.',
  'future-date': 'Essa data ainda não chegou — só registro o que já aconteceu.',
  'invalid-number': 'Um dos números informados não é válido.',
  'category-not-found': 'Essa categoria não existe no seu app.',
  'category-wrong-type': 'Essa categoria não serve para esse tipo de lançamento.',
  'card-not-found': 'Não encontrei esse cartão.',
  'card-ambiguous': 'Você tem mais de um cartão — preciso saber qual.',
  'goal-not-found': 'Não encontrei essa meta.',
  'goal-ambiguous': 'Você tem mais de uma meta parecida — preciso saber qual.',
  'duplicate': 'Isso parece já ter sido registrado.',
  'missing-field': 'Falta uma informação obrigatória.',
  'profile-forbidden': 'Esse tipo de registro não existe no seu perfil.',
  'invoice-empty': 'Essa fatura não tem valor pendente.',
  'insufficient-reserve': 'Você não tem esse valor guardado na reserva.',
  'unsupported-action': 'Ainda não sei registrar isso.',
  'conflict': 'Esse registro entra em conflito com outro da mesma mensagem.',
  'text-too-long': 'O texto informado é longo demais.',
  'unknown-field': 'Recebi um campo que não reconheço.',
}

export const errorMessage = (code: AssistantErrorCode, detail?: string): string =>
  detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code]

// ---------------------------------------------------------------------------
// PEÇAS DA RESPOSTA
// ---------------------------------------------------------------------------

/** Campo obrigatório que ainda falta para uma ação poder ser proposta. */
export interface AssistantMissingField {
  actionKind: AssistantActionKind
  field: string
  /** Pergunta pronta, em pt-BR, para pedir só este campo. */
  question: string
  /** Opções quando o campo é uma escolha (cartões, metas, categorias). */
  options?: { label: string; value: string }[]
}

export interface AssistantCandidateAction {
  /** Estável dentro da proposta — é por ele que o usuário edita/remove. */
  id: string
  action: ParsedAction
  engine: AssistantEngine
  confidence: AssistantConfidence
  /** Trecho da mensagem que originou a ação. */
  clauseId?: string
  /** Aviso de possível duplicidade (não bloqueia). */
  duplicateWarning?: string
}

export interface AssistantClarificationOption {
  label: string
  value: string
  /**
   * Efeito COMPLETO de escolher esta opção. É o que impede o usuário de ter que
   * repetir valor e descrição depois de responder "GNV": a escolha já carrega a
   * lista inteira de ações resolvidas. Escolher continua não registrando nada —
   * vira a confirmação normal.
   */
  actions?: ParsedAction[]
  /**
   * Resposta pronta quando a escolha significa NÃO REGISTRAR. Sem isto, "é um
   * plano futuro" cairia no texto genérico de proposta e o usuário ficaria sem
   * entender por que nada foi lançado.
   */
  reply?: string
}

export interface AssistantClarification {
  /** Pergunta única, curta. */
  question: string
  field?: string
  options?: AssistantClarificationOption[]
  /** Ação a que a pergunta se refere, quando aplicável. */
  actionId?: string
  /**
   * "Que dia foi?" precisa de uma janela: a resposta curta ("dia 10") só vale
   * dentro do período que o usuário citou. Fora dela a pergunta continua aberta
   * — nada é aproximado e nada cai em hoje.
   */
  dateWindow?: { from: string; to: string }
  /** Ações que só serão propostas depois da resposta. Nada foi registrado. */
  pendingActions?: ParsedAction[]
}

export interface AssistantUnresolvedClause {
  clauseId: string
  text: string
  reason: 'not-understood' | 'question-unanswered' | 'missing-data' | 'remote-unavailable'
}

interface AssistantResponseBase {
  version: AssistantContractVersion
  reply: string
  engine: AssistantEngine
  unresolved: AssistantUnresolvedClause[]
  /** Só preenchido em desenvolvimento. */
  diagnostics?: AssistantDiagnostics
}

export type AssistantResponse =
  | (AssistantResponseBase & { mode: 'answer'; actions: [] })
  | (AssistantResponseBase & { mode: 'propose_actions'; actions: AssistantCandidateAction[] })
  | (AssistantResponseBase & { mode: 'answer_and_actions'; actions: AssistantCandidateAction[] })
  | (AssistantResponseBase & {
      mode: 'clarify'
      actions: AssistantCandidateAction[]
      clarification: AssistantClarification
    })

export interface AssistantDiagnostics {
  engine: AssistantEngine
  coverage: number
  clauses: { id: string; text: string; intent: AssistantIntent; handled: boolean; confidence: AssistantConfidence }[]
  localActions: number
  remoteActions: number
  rejected: { kind: string; code: AssistantErrorCode; detail?: string }[]
  elapsedMs?: number
}

// ---------------------------------------------------------------------------
// RESULTADO DE EXECUÇÃO
// ---------------------------------------------------------------------------

export interface ActionFailure {
  ok: false
  actionId: string
  code: AssistantErrorCode
  message: string
  /** O usuário consegue consertar respondendo algo? */
  recoverable: boolean
}

export type ActionExecutionResult =
  | { ok: true; actionId: string; entityId?: string }
  | ActionFailure

/** Predicado explícito — obrigatório sob `strict: false` (ver regra 24). */
export function isActionFailure(r: ActionExecutionResult): r is ActionFailure {
  return r.ok === false
}

// ---------------------------------------------------------------------------
// CAPACIDADES — o que ESTE usuário, neste perfil, pode registrar agora
// ---------------------------------------------------------------------------

export interface AssistantCategoryInfo {
  id: string
  name: string
  type: 'income' | 'expense'
}

export interface AssistantCapabilities {
  profile: ProfileId
  isDriver: boolean
  kinds: AssistantActionKind[]
  categories: AssistantCategoryInfo[]
  cardNames: string[]
  goalNames: string[]
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO DETERMINÍSTICA — o mesmo código valida o local e o remoto
// ---------------------------------------------------------------------------

export type ValidationOutcome =
  | { ok: true; action: ParsedAction }
  | { ok: false; code: AssistantErrorCode; detail?: string }

/**
 * Predicado explícito — obrigatório nos chamadores, igual a `isDeepSeekFailure`.
 * Sob `strict: false` (config real do projeto) o TypeScript NÃO estreita a união
 * a partir de `if (!res.ok)`, então `tsc` local passa e o build da Vercel falha.
 * Ver regra 24 do CLAUDE.md.
 */
export function isValidationFailure(
  r: ValidationOutcome,
): r is { ok: false; code: AssistantErrorCode; detail?: string } {
  return r.ok === false
}

const isFiniteNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Data plausível: ISO válida, entre 2000 e 5 anos à frente. */
export function isPlausibleDate(v: any, todayIso: string): boolean {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  if (new Date(y, m - 1, d).getDate() !== d) return false // 31/02 não existe
  const maxYear = Number(todayIso.slice(0, 4)) + 5
  return y >= 2000 && y <= maxYear
}

/**
 * Valida UMA ação candidata contra o catálogo e as capacidades do usuário.
 * Recusa é sempre explicada por um código específico — nunca um `false` mudo.
 */
export function validateAction(
  raw: any,
  caps: AssistantCapabilities,
  todayIso: string,
  opts?: { allowRemoteOnly?: boolean },
): ValidationOutcome {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'unsupported-action' }
  const spec = actionSpec(raw.kind)
  if (!spec) return { ok: false, code: 'unsupported-action', detail: String(raw.kind || '').slice(0, 30) }
  if (opts?.allowRemoteOnly && !spec.remoteAllowed) {
    return { ok: false, code: 'unsupported-action', detail: spec.label }
  }
  if (spec.driverOnly && !caps.isDriver) return { ok: false, code: 'profile-forbidden', detail: spec.label }

  const out: any = { kind: spec.kind }
  const known = new Set(spec.fields.map(f => f.name))
  // Campos fora do catálogo são descartados — nunca repassados adiante.
  for (const key of Object.keys(raw)) {
    if (key !== 'kind' && !known.has(key) && raw[key] !== undefined) {
      // silencioso de propósito: o modelo às vezes inventa campos decorativos.
      // O que importa é que eles JAMAIS cheguem ao estado.
    }
  }

  for (const f of spec.fields) {
    const v = raw[f.name]
    if (v === undefined || v === null || v === '') {
      if (f.required) return { ok: false, code: 'missing-field', detail: f.name }
      continue
    }
    switch (f.type) {
      case 'money': {
        if (!isFiniteNum(v)) return { ok: false, code: 'invalid-amount', detail: f.name }
        if (v < (f.min ?? 0.01) || v > (f.max ?? Infinity)) return { ok: false, code: 'invalid-amount', detail: f.name }
        out[f.name] = Math.round(v * 100) / 100
        break
      }
      case 'int': {
        const n = Math.round(Number(v))
        if (!Number.isFinite(n)) return { ok: false, code: 'invalid-number', detail: f.name }
        if (n < (f.min ?? 1) || n > (f.max ?? Infinity)) return { ok: false, code: 'invalid-number', detail: f.name }
        out[f.name] = n
        break
      }
      case 'quantity': {
        if (!isFiniteNum(v)) return { ok: false, code: 'invalid-number', detail: f.name }
        if (v < (f.min ?? -Infinity) || v > (f.max ?? Infinity)) return { ok: false, code: 'invalid-number', detail: f.name }
        if (v === 0) continue // zero não acrescenta nada
        out[f.name] = Math.round(v * 1000) / 1000
        break
      }
      case 'text': {
        if (typeof v !== 'string') return { ok: false, code: 'unknown-field', detail: f.name }
        const t = v.trim()
        if (!t) { if (f.required) return { ok: false, code: 'missing-field', detail: f.name }; continue }
        if (t.length > (f.maxLength ?? 80)) return { ok: false, code: 'text-too-long', detail: f.name }
        if (f.categoryOf) {
          const cat = caps.categories.find(c => c.id === t)
          if (!cat) return { ok: false, code: 'category-not-found', detail: t }
          if (cat.type !== f.categoryOf) return { ok: false, code: 'category-wrong-type', detail: cat.name }
        }
        out[f.name] = t
        break
      }
      case 'date': {
        if (!isPlausibleDate(v, todayIso)) return { ok: false, code: 'invalid-date', detail: String(v).slice(0, 20) }
        // Última barreira: se uma data futura chegou até aqui, ela é RECUSADA
        // com motivo — nunca silenciosamente trocada por hoje.
        if (f.notFuture && v > todayIso) return { ok: false, code: 'future-date', detail: String(v).slice(0, 10) }
        out[f.name] = v
        break
      }
      case 'flag': {
        if (typeof v !== 'boolean') return { ok: false, code: 'unknown-field', detail: f.name }
        out[f.name] = v
        break
      }
    }
  }

  if (spec.anyOf && !spec.anyOf.some(k => out[k] !== undefined)) {
    return { ok: false, code: 'missing-field', detail: spec.anyOf.join('/') }
  }

  // Invariantes entre campos.
  if (out.kind === 'financed-cash-inflow' && out.netReceived > out.total) {
    return { ok: false, code: 'conflict', detail: 'recebido maior que a dívida' }
  }

  return { ok: true, action: out as ParsedAction }
}

/**
 * Valida o ENVELOPE devolvido pela IA remota. Um envelope inválido nunca vira
 * ação: ou o chamador tenta de novo, ou cai no fallback local.
 */
export type EnvelopeOutcome =
  | { ok: true; reply: string; rawActions: any[]; clarification?: AssistantClarification; mode: string }
  | { ok: false; reason: 'not-object' | 'bad-version' | 'no-reply' | 'bad-mode' | 'bad-actions' }


export interface EnvelopeFailure { ok: false; reason: 'not-object' | 'bad-version' | 'no-reply' | 'bad-mode' | 'bad-actions' }

/** Predicado explícito — obrigatório sob `strict: false` (ver regra 24). */
export function isEnvelopeFailure(o: EnvelopeOutcome): o is EnvelopeFailure {
  return o.ok === false
}

const VALID_MODES = ['answer', 'propose_actions', 'answer_and_actions', 'clarify']

export function validateRemoteEnvelope(data: any): EnvelopeOutcome {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not-object' }
  if (data.version !== undefined && data.version !== ASSISTANT_CONTRACT_VERSION) {
    return { ok: false, reason: 'bad-version' }
  }
  const reply = typeof data.reply === 'string' ? data.reply.trim() : ''
  if (!reply) return { ok: false, reason: 'no-reply' }
  const mode = typeof data.mode === 'string' ? data.mode : 'answer'
  if (!VALID_MODES.includes(mode)) return { ok: false, reason: 'bad-mode' }
  if (data.actions !== undefined && !Array.isArray(data.actions)) return { ok: false, reason: 'bad-actions' }
  const rawActions: any[] = Array.isArray(data.actions) ? data.actions.slice(0, MAX_ACTIONS_PER_BATCH) : []

  let clarification: AssistantClarification | undefined
  const c = data.clarification
  if (c && typeof c === 'object' && typeof c.question === 'string' && c.question.trim()) {
    clarification = {
      question: c.question.trim().slice(0, 300),
      field: typeof c.field === 'string' ? c.field.slice(0, 40) : undefined,
      options: Array.isArray(c.options)
        ? c.options
            .filter((o: any) => o && typeof o.label === 'string' && typeof o.value === 'string')
            .slice(0, 6)
            .map((o: any) => ({ label: o.label.slice(0, 60), value: o.value.slice(0, 60) }))
        : undefined,
    }
  }
  return { ok: true, reply, rawActions, clarification, mode }
}

/** Teto de ações por proposta — protege contra resposta gigante do modelo. */
export const MAX_ACTIONS_PER_BATCH = 12

// ---------------------------------------------------------------------------
// SCHEMA PARA O PROMPT — gerado a partir do catálogo, nunca escrito à mão
// ---------------------------------------------------------------------------

/**
 * Documentação das ações no formato que o modelo lê. Como sai do próprio
 * catálogo, é IMPOSSÍVEL o prompt anunciar uma ação que o cliente não valida.
 */
export function buildActionSchemaDoc(caps: Pick<AssistantCapabilities, 'isDriver'>): string {
  const lines: string[] = []
  for (const spec of ACTION_CATALOG) {
    if (!spec.remoteAllowed) continue
    if (spec.driverOnly && !caps.isDriver) continue
    const fields = spec.fields
      .map(f => `"${f.name}":${f.type === 'text' || f.type === 'date' ? 'string' : 'number'}${f.required ? '' : ' opcional'}`)
      .join(', ')
    const detail = spec.fields.map(f => `${f.name} = ${f.describe}`).join('; ')
    lines.push(`- {"kind":"${spec.kind}", ${fields}} — ${spec.label}. ${detail}.${spec.promptHint ? ` ${spec.promptHint}.` : ''}`)
  }
  return lines.join('\n')
}
