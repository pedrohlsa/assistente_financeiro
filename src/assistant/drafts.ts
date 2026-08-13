// Rascunhos: a memória curta da conversa.
//
// Sem isso, "Comprei um computador em 4 vezes" → "Qual o valor?" → "Quatro mil
// no Nubank" era interpretado como três mensagens sem relação, e a terceira não
// virava nada. O rascunho guarda a ação incompleta e sabe encaixar respostas
// curtas nos campos que faltam.
//
// O rascunho NUNCA executa sozinho: ele só amadurece até virar uma proposta
// normal, que ainda precisa do botão Confirmar.

import type { ParsedAction } from '../models/types'
import type { AssistantCapabilities, AssistantMissingField, AssistantActionKind } from './contracts'
import { actionSpec } from './contracts'
import { parseMoney, todayISO, uid } from '../utils/format'
import { normalizeNumberWords } from './numbers'
import { findDate } from './dates'
import { sentenceCase, normalizeName } from '../utils/text'

export type DraftStatus = 'collecting' | 'ready' | 'confirmed' | 'cancelled'

export interface AssistantDraft {
  id: string
  createdAt: string
  updatedAt: string
  /** Mensagens que alimentaram este rascunho, na ordem. */
  originalMessages: string[]
  /** Ação em construção — sempre incompleta enquanto `status === 'collecting'`. */
  partial: Partial<ParsedAction> & { kind: AssistantActionKind }
  missingFields: AssistantMissingField[]
  status: DraftStatus
}

/** Rascunho velho não pode ressuscitar no meio de outra conversa. */
export const DRAFT_TTL_MINUTES = 20

export function isDraftFresh(d: AssistantDraft | undefined, now = Date.now()): boolean {
  if (!d || d.status !== 'collecting') return false
  const t = Date.parse(d.updatedAt)
  if (!Number.isFinite(t)) return false
  return now - t < DRAFT_TTL_MINUTES * 60_000
}

// ---------------------------------------------------------------------------
// Detecção de intenção INCOMPLETA
// ---------------------------------------------------------------------------
// O parser existente devolve `[]` quando falta um campo obrigatório — o que é
// correto (nunca inventar), mas deixava o usuário sem resposta útil. Aqui a
// intenção é reconhecida mesmo incompleta, para o assistente perguntar só o que
// falta em vez de mandar o texto de ajuda genérico.

export interface IncompleteIntent {
  partial: Partial<ParsedAction> & { kind: AssistantActionKind }
  missing: string[]
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)*)`

export function detectIncomplete(text: string, caps: AssistantCapabilities): IncompleteIntent | null {
  const { text: t } = normalizeNumberWords(text.toLowerCase())

  // Compra parcelada sem valor e/ou sem número de parcelas.
  if (/\b(comprei|compra|parcelei|parcelad[oa])\b/.test(t)) {
    const instM = t.match(/(?:em|x)\s*(\d+)\s*(?:vez(?:es)?|x|parcelas?)|(\d+)\s*x\b/)
    const valM = t.match(new RegExp(String.raw`(?:de|por|custou|valor de)\s*(?:r\$)?\s*${NUMBER}`))
      || t.match(new RegExp(String.raw`r\$\s*${NUMBER}`))
    const descM = text.match(/comprei\s+(?:um|uma|o|a|uns|umas)\s+([\wçãõáéíóúâê]+(?:\s+[\wçãõáéíóúâê]+)*?)(?=\s+(?:de|por|em|no|na)\b|\s*r\$|\s*\d|$)/i)
    const total = valM ? parseMoney(valM[1]) : undefined
    const installments = instM ? parseInt(instM[1] || instM[2], 10) : undefined
    const missing: string[] = []
    if (!(total > 0)) missing.push('total')
    if (!(installments > 0)) missing.push('installments')
    // Sem NENHUM dos dois não há intenção suficiente para abrir rascunho.
    if (missing.length === 2) return null
    // Com vários cartões, saber qual é obrigatório — e essa checagem precisa
    // vir ANTES da saída antecipada, senão "comprei X de 4000 em 4 vezes" com
    // dois cartões cadastrados nunca perguntava nada.
    const citedCard = caps.cardNames.find(c => t.includes(normalizeName(c)))
    if (caps.cardNames.length > 1 && !citedCard) missing.push('cardName')
    if (!missing.length) return null // completa: o parser normal dá conta
    const partial: any = { kind: 'card-purchase' }
    if (total > 0) partial.total = total
    if (installments > 0) partial.installments = installments
    if (citedCard) partial.cardName = citedCard
    if (descM) partial.description = sentenceCase(descM[1].trim())
    return { partial, missing }
  }

  // Registro começado sem o valor: "recebi o salário", "abasteci", "gastei no
  // mercado". Antes caía no texto genérico de ajuda — o usuário tinha COMEÇADO
  // a registrar e o app respondia como se não tivesse entendido nada.
  //
  // As três guardas são o que separa isto de uma pergunta: nenhum número na
  // frase (senão o parser normal já resolveu), nenhuma palavra interrogativa
  // ("quanto eu gastei essa semana" tem o mesmo verbo) e nenhuma negação
  // ("não gastei nada" é o contrário de um registro).
  const SEM_VALOR = /^\s*(?:eu\s+)?(?:j[áa]\s+)?(ganhei|recebi|faturei|lucrei|gastei|paguei|comprei|torrei|abasteci|guardei|separei)\b/i
  const semValor = text.match(SEM_VALOR)
  // Número de UM dígito não é dinheiro: "recebi o aluguel da CASA 1" tem um
  // "1" que faz parte do nome, e a guarda antiga o tomava por valor — o pedido
  // voltava para o texto genérico de ajuda em vez de perguntar quanto foi.
  if (semValor
    && !/r\$\s*\d|\b\d{2,}\b|\b\d+[.,]\d/i.test(t)
    && !/\?|\b(?:quanto|quantos|quantas|qual|quais|quando|como|onde|quem)\b/i.test(t)
    && !/\bn[ãa]o\b/i.test(t)) {
    const verbo = semValor[1].toLowerCase()
    const kind = /ganhei|recebi|faturei|lucrei/.test(verbo) ? 'income'
      : /guardei|separei/.test(verbo) ? 'saving'
        : verbo === 'abasteci' && caps.isDriver ? 'fuel'
          : 'expense'
    return { partial: { kind } as any, missing: ['amount'] }
  }

  // Pagamento de fatura sem saber o cartão, com mais de um cadastrado.
  if (/\bfatura\b/.test(t) && /\b(paguei|pagar|quitei|quitar)\b/.test(t) && caps.cardNames.length > 1) {
    const hasCard = caps.cardNames.some(c => t.includes(normalizeName(c)))
    if (!hasCard) {
      const amountM = t.match(new RegExp(String.raw`(?:paguei|pagar|quitei)\s*(?:r\$)?\s*${NUMBER}`))
      const partial: any = { kind: 'card-payment' }
      if (amountM) { const v = parseMoney(amountM[1]); if (v > 0) partial.amount = v }
      return { partial, missing: ['cardName'] }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Perguntas — uma de cada vez, só o que falta
// ---------------------------------------------------------------------------

export function questionFor(
  kind: AssistantActionKind,
  field: string,
  caps: AssistantCapabilities,
): AssistantMissingField {
  const options = field === 'cardName'
    ? caps.cardNames.map(c => ({ label: c, value: c }))
    : undefined

  const QUESTIONS: Record<string, string> = {
    total: 'Qual foi o valor total?',
    installments: 'Em quantas parcelas?',
    amount: 'Qual foi o valor?',
    cardName: caps.cardNames.length > 1
      ? 'Em qual cartão?'
      : caps.cardNames.length === 1
        ? `Foi no ${caps.cardNames[0]}?`
        : 'Você quer cadastrar o cartão ou registrar como parcelamento sem cartão?',
    name: 'Qual é o nome da meta?',
    target: 'Qual é o valor da meta?',
    item: 'O que foi trocado?',
    date: 'De qual dia foi?',
  }
  return { actionKind: kind, field, question: QUESTIONS[field] || `Qual é o valor de ${field}?`, options }
}

// ---------------------------------------------------------------------------
// Encaixe de respostas curtas
// ---------------------------------------------------------------------------

const YES = /^\s*(?:sim|isso|isso mesmo|exato|correto|pode ser|foi|foi sim|s|ss|claro|uhum|aham)\b/i
const NO = /^\s*(?:n[ãa]o|nao|negativo|n)\b/i

export interface DraftResolution {
  draft: AssistantDraft
  /** Campos preenchidos por esta mensagem. */
  resolved: string[]
  /** O usuário respondeu algo que não encaixa em nenhum campo pendente. */
  unmatched: boolean
}

/**
 * Tenta encaixar a mensagem nos campos pendentes do rascunho.
 *
 * É aqui que "Nubank", "quatro mil", "em 4x", "sim" e "foi ontem" deixam de ser
 * frases soltas: a interpretação considera o que o assistente PERGUNTOU, não só
 * o texto isolado.
 */
export function resolveDraftAnswer(
  draft: AssistantDraft,
  message: string,
  caps: AssistantCapabilities,
  today = todayISO(),
): DraftResolution {
  const next: AssistantDraft = {
    ...draft,
    partial: { ...draft.partial },
    missingFields: [...draft.missingFields],
    originalMessages: [...draft.originalMessages, message],
    updatedAt: new Date().toISOString(),
  }
  const resolved: string[] = []
  const { text: norm } = normalizeNumberWords(message)
  const lower = norm.toLowerCase()
  const pending = new Set(draft.missingFields.map(f => f.field))

  // "Foi no Nubank?" → "sim"
  if (pending.has('cardName') && caps.cardNames.length === 1 && YES.test(message)) {
    ;(next.partial as any).cardName = caps.cardNames[0]
    resolved.push('cardName')
    pending.delete('cardName')
  } else if (pending.has('cardName') && caps.cardNames.length === 1 && NO.test(message)) {
    // Recusou o único cartão: vira parcelamento sem cartão, sem inventar nada.
    resolved.push('cardName')
    pending.delete('cardName')
  }

  // Nome de cartão citado em qualquer lugar da frase — mesmo que o assistente
  // não tenha perguntado. "Quatro mil no Nubank" informa as duas coisas.
  if (!(next.partial as any).cardName) {
    const hit = caps.cardNames.find(c => normalizeName(lower).includes(normalizeName(c)))
    if (hit) { (next.partial as any).cardName = hit; resolved.push('cardName'); pending.delete('cardName') }
  }

  // Parcelas: "em 4x", "4 vezes", "quatro vezes" (já normalizado).
  if (pending.has('installments')) {
    const m = lower.match(/(?:em\s*)?(\d+)\s*(?:x|vezes|parcelas?)\b/) || (pending.size === 1 ? lower.match(/^\s*(\d+)\s*$/) : null)
    if (m) {
      const v = parseInt(m[1], 10)
      if (v >= 1 && v <= 120) { (next.partial as any).installments = v; resolved.push('installments'); pending.delete('installments') }
    }
  }

  // Valor: qualquer quantia da frase que não seja o número de parcelas.
  for (const field of ['total', 'amount', 'target'] as const) {
    if (!pending.has(field)) continue
    const stripped = lower.replace(/(?:em\s*)?\d+\s*(?:x|vezes|parcelas?)\b/g, ' ')
    const m = stripped.match(new RegExp(String.raw`(?:r\$\s*)?${NUMBER}`))
    if (m) {
      const v = parseMoney(m[1])
      if (v > 0) { (next.partial as any)[field] = v; resolved.push(field); pending.delete(field) }
    }
  }

  // Data mencionada na resposta ("foi ontem").
  const d = findDate(message, today)
  if (d && d.kind === 'date') {
    const spec = actionSpec(draft.partial.kind)
    if (spec?.fields.some(f => f.name === 'date')) {
      ;(next.partial as any).date = d.date
      resolved.push('date')
    }
  }

  next.missingFields = draft.missingFields.filter(f => pending.has(f.field))
  next.status = next.missingFields.length ? 'collecting' : 'ready'
  return { draft: next, resolved, unmatched: resolved.length === 0 }
}

export function newDraft(
  intent: IncompleteIntent,
  message: string,
  caps: AssistantCapabilities,
): AssistantDraft {
  const now = new Date().toISOString()
  return {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    originalMessages: [message],
    partial: intent.partial,
    missingFields: intent.missing.map(f => questionFor(intent.partial.kind, f, caps)),
    status: 'collecting',
  }
}
