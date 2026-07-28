// Segmentação da mensagem em CLÁUSULAS, com posição preservada.
//
// A falha estrutural da arquitetura antiga era tratar a mensagem como uma coisa
// só: achar uma ação encerrava a interpretação e o resto se perdia. Aqui cada
// trecho é analisado separadamente e carrega o próprio veredito — é isso que
// permite dizer "entendi esta parte, não entendi aquela" em vez de chutar.

import type { ParsedAction } from '../models/types'
import type { AssistantConfidence, AssistantIntent } from './contracts'
import { parseNaturalFull } from '../services/nlp'
import { findDate, dateLabel } from './dates'
import { normalizeNumberWords } from './numbers'
import { todayISO } from '../utils/format'

export interface AnalyzedClause {
  id: string
  /** Trecho literal, como o usuário escreveu. */
  text: string
  start: number
  end: number
  intent: AssistantIntent
  handled: boolean
  confidence: AssistantConfidence
  actions: ParsedAction[]
  /** Data interpretada para esta cláusula, quando houver. */
  date?: string
  dateLabel?: string
  /** Pergunta de desambiguação levantada pelo parser (ex.: gás). */
  ambiguity?: { question: string; options: { label: string; actions: ParsedAction[] }[] }
  /** Data ambígua: precisa de escolha antes de virar lançamento. */
  dateAmbiguity?: { question: string; options: { label: string; value: string }[] }
}

export interface MessageAnalysis {
  originalText: string
  /** Texto com números por extenso convertidos — só para alimentar os regex. */
  normalizedText: string
  clauses: AnalyzedClause[]
  actions: ParsedAction[]
  unansweredQuestions: AnalyzedClause[]
  unresolvedClauses: AnalyzedClause[]
  /** 0..1 — fração do texto útil que o motor local entendeu. */
  coverage: number
}

// ---------------------------------------------------------------------------
// Detecção de intenção
// ---------------------------------------------------------------------------

/**
 * Perguntas coloquiais. NÃO basta procurar "?" ou "quanto": em conversa real o
 * usuário escreve "e agora sobra quanto", "dá pra pagar?", "tô bem esse mês?".
 * Cada padrão aqui nasceu de uma frase que a versão anterior ignorava.
 */
const QUESTION_PATTERNS: RegExp[] = [
  /\?/,
  /\b(?:quanto|quantos|quantas|qual|quais|quando|onde)\b/i,
  /\bcomo\s+(?:est[aáo]|foi|fica|t[aá]|anda|vai)\b/i,
  /\b(?:sobra|sobrou|sobrar[áa]?|resta|restou|restar[áa]?)\b/i,
  /\bd[áa]\s+(?:pra|para)\b/i,
  /\bvai\s+(?:faltar|sobrar|pesar|dar|apertar)\b/i,
  /\b(?:t[ôo]|tou|estou|to)\s+(?:bem|bom|mal|ruim|apertad|indo|gastando|lucrando)/i,
  /\bt[áa]\s+(?:pesad|caro|apertad|ok|tranquil|folgad)/i,
  /\b(?:compensa|vale\s+a\s+pena)\b/i,
  /\bo\s+que\s+(?:voc[êe]|vc)\s+acha\b/i,
  /\be\s+(?:agora|depois|no\s+pr[óo]ximo|mês\s+que\s+vem|m[eê]s\s+que\s+vem)\b/i,
  /\b(?:posso|consigo|devo|preciso|dever[ií]a)\b/i,
  /\bcobr[eo]m?\b/i,
  /\bd[íi]vida\s+(?:t[áa]|est[áa])\b/i,
  /\bmelhor(?:ou)?\b/i,
  /\bpior(?:ou)?\b/i,
]

/** Avisos e conversa — precisam ganhar de "posso"/"quanto" na ordem. */
const CONVERSATION_PATTERNS: RegExp[] = [
  /\b(?:vou|posso|quero)\s+(?:te\s+)?(?:passar|falar|dizer|mandar|contar)\b/i,
  /^\s*(?:oi|ol[áa]|e\s*a[íi]|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem)\b/i,
  /^\s*(?:obrigad[oa]|valeu|beleza|blz|ok|okay|show|top)\b\s*[.!]?\s*$/i,
]

/** Correções, negações e remoções sobre algo já proposto ou registrado. */
const CORRECTION_PATTERNS: RegExp[] = [
  /\bn[ãa]o\s+(?:foi|era|é|e)\b/i,
  /\bn[ãa]o\s+(?:registra|registre|salva|salve|quero\s+registrar|era\s+pra)\b/i,
  /\b(?:troca|trocar|troque|muda|mudar|mude|altera|alterar|corrige|corrigir|ajusta|ajustar)\b/i,
  /\b(?:remove|remover|remova|tira|tirar|retira|retirar|apaga|apagar|exclui|excluir|cancela|cancelar)\b/i,
  /\b(?:desfaz|desfazer|desfaça)\b/i,
  /\bera\s+(?:ontem|hoje|anteontem|no|na|de|do|da)\b/i,
  /\b[ée]\s+gnv\b/i,
]

const hasAny = (t: string, list: RegExp[]) => list.some(r => r.test(t))

export const looksLikeQuestion = (t: string): boolean =>
  !hasAny(t, CONVERSATION_PATTERNS) && hasAny(t, QUESTION_PATTERNS)

export const looksLikeCorrection = (t: string): boolean => hasAny(t, CORRECTION_PATTERNS)

export const looksLikeConversation = (t: string): boolean => hasAny(t, CONVERSATION_PATTERNS)

// ---------------------------------------------------------------------------
// Segmentação com offsets
// ---------------------------------------------------------------------------

const COMMAND_VERBS =
  'ganhei|ganhou|recebi|recebeu|faturei|lucrei|entrou|caiu|gastei|gastou|paguei|pagou|comprei|comprou|parcelei|passei|troquei|instalei|abasteci|coloquei|botei|rodei|andei|dirigi|percorri|trabalhei|quero|queria|fiz|guardei|guarda|guardar|separei|separa|separar|depositei|investi|tirei|retirei|sobrou|sobra|vendi|apliquei'

const CONNECTORS = '(?:e\\s+)?(?:logo\\s+)?(?:depois|em\\s+seguida|mais\\s+tarde|tamb[ée]m|ent[ãa]o|a[íi])\\s+'

/**
 * Pontos de corte da mensagem. O texto ORIGINAL nunca é alterado — só marcamos
 * onde cortar, para cada cláusula manter posição real e poder ser citada de
 * volta ao usuário.
 */
export function segment(text: string): { text: string; start: number; end: number }[] {
  const cuts = new Set<number>([0])
  const push = (i: number) => { if (i > 0 && i < text.length) cuts.add(i) }

  // Fim de frase.
  for (const m of text.matchAll(/[.!?;]+\s+/g)) push((m.index || 0) + m[0].length)
  // Vírgula ou " e " logo antes de um verbo de comando (a vírgula decimal não
  // casa porque exigimos um verbo depois, nunca um dígito).
  for (const m of text.matchAll(new RegExp(String.raw`[,;]\s*(?:${CONNECTORS})?(?:e\s+)?(?=(?:${COMMAND_VERBS})\b)`, 'gi'))) {
    push((m.index || 0) + m[0].length)
  }
  for (const m of text.matchAll(new RegExp(String.raw`\s+e\s+(?=(?:${COMMAND_VERBS})\b)`, 'gi'))) {
    push((m.index || 0) + m[0].length)
  }
  // Conector explícito começando uma nova ideia.
  for (const m of text.matchAll(new RegExp(String.raw`[,;]?\s+${CONNECTORS}`, 'gi'))) {
    push((m.index || 0) + m[0].length)
  }
  // "mas", "porém" e "só que" separam registro de pergunta.
  for (const m of text.matchAll(/[,;]?\s+(?:mas|por[ée]m|s[óo]\s+que)\s+/gi)) push((m.index || 0) + m[0].length)

  const sorted = [...cuts].sort((a, b) => a - b)
  const out: { text: string; start: number; end: number }[] = []
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    const end = i + 1 < sorted.length ? sorted[i + 1] : text.length
    const slice = text.slice(start, end)
    if (slice.trim()) out.push({ text: slice.trim(), start, end })
  }
  return out.length ? out : [{ text: text.trim(), start: 0, end: text.length }]
}

// ---------------------------------------------------------------------------
// Origem explícita — nunca inferida
// ---------------------------------------------------------------------------

/** Substantivos que, seguidos de identificador, são fonte e não descrição. */
const ORIGIN_NOUNS = 'casa|cliente|empresa|loja|apart(?:amento)?|kitnet|kitinete|sala|ponto|unidade|obra|inquilin[oa]|contrato'

/**
 * Extrai a origem SÓ quando o usuário a marcou explicitamente. Dois sinais são
 * aceitos, e nenhum deles é dedução:
 *   1. "da Casa 1", "do Cliente João" — substantivo de fonte + identificador;
 *   2. "da Empresa X" com Inicial Maiúscula no texto original (nome próprio).
 * "gastei 190 de cimento" nunca vira origem: "cimento" não é nome próprio nem
 * substantivo de fonte.
 */
export function extractOrigin(originalClause: string): string | undefined {
  const known = originalClause.match(new RegExp(String.raw`\bd[ao]s?\s+((?:${ORIGIN_NOUNS})\s+[\wçãõáéíóúâê\d]+)`, 'i'))
  if (known) return known[1].replace(/\s+/g, ' ').trim()

  const proper = originalClause.match(
    /\bd[ao]s?\s+((?:[A-ZÀ-ÖØ-Þ][\wçãõáéíóúâêô]+)(?:\s+(?:[A-ZÀ-ÖØ-Þ][\wçãõáéíóúâêô]+|\d+))*)/,
  )
  if (proper) {
    const v = proper[1].trim()
    // Plataformas de corrida são descrição, não origem.
    if (/^(uber|99|indrive|indriver)$/i.test(v)) return undefined
    return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

const DATABLE = new Set(['income', 'expense', 'saving', 'work', 'fuel', 'maintenance'])
const ORIGINABLE = new Set(['income', 'expense'])

let seq = 0
const clauseId = () => `c${++seq}`

/**
 * Analisa a mensagem inteira, cláusula por cláusula.
 *
 * `handled` de uma cláusula NÃO significa que a mensagem foi compreendida: é
 * justamente a soma dos `handled` que vira `coverage`, e é a cobertura
 * incompleta que manda a mensagem para a IA remota.
 */
export function analyzeMessage(
  input: string,
  opts?: { driver?: boolean; today?: string },
): MessageAnalysis {
  const today = opts?.today || todayISO()
  const original = input.trim()
  // Números por extenso viram algarismos ANTES dos regex, para reaproveitar
  // todo o parser já testado em vez de duplicá-lo.
  const { text: normalized } = normalizeNumberWords(original)

  const originalParts = segment(original)
  const normalizedParts = segment(normalized)
  // Os dois textos podem ter contagens diferentes de cláusula quando a
  // conversão muda a pontuação; nesse caso analisamos o texto normalizado
  // inteiro como uma cláusula só, para nunca perder conteúdo.
  const aligned = originalParts.length === normalizedParts.length

  const clauses: AnalyzedClause[] = []
  const parts = aligned ? originalParts : [{ text: original, start: 0, end: original.length }]

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const forParser = aligned ? normalizedParts[i].text : normalized
    const id = clauseId()

    const parsed = parseNaturalFull(forParser, { driver: opts?.driver })
    let actions = parsed.actions

    const dateRes = findDate(part.text, today)
    let date: string | undefined
    let dLabel: string | undefined
    let dateAmbiguity: AnalyzedClause['dateAmbiguity']
    if (dateRes) {
      if (dateRes.kind === 'date') { date = dateRes.date; dLabel = dateRes.label }
      else if (dateRes.kind === 'ambiguous') dateAmbiguity = { question: dateRes.question, options: dateRes.options }
      // 'future' e 'period' não datam um fato já ocorrido: ficam de fora e a
      // cláusula segue com a data de hoje, como sempre foi.
    }

    const origin = extractOrigin(part.text)

    actions = actions.map(a => {
      const next: any = { ...a }
      if (date && DATABLE.has(a.kind)) next.date = date
      if (origin && ORIGINABLE.has(a.kind) && !next.origin) next.origin = origin
      return next as ParsedAction
    })

    const isConversation = looksLikeConversation(part.text)
    const isQuestion = !isConversation && looksLikeQuestion(part.text)
    const isCorrection = !isConversation && looksLikeCorrection(part.text)

    let intent: AssistantIntent
    if (isConversation) intent = 'conversation'
    else if (isCorrection && !actions.length) intent = 'correction'
    else if (actions.length && !isQuestion) intent = 'record'
    else if (actions.length && isQuestion) intent = 'record' // a pergunta vira cláusula própria abaixo
    else if (isQuestion) intent = 'question'
    else intent = 'unknown'

    // Uma cláusula com ação E pergunta juntas ("gastei 40, ainda bato a meta?")
    // rende DUAS entradas: a pergunta não pode sumir porque a ação foi entendida.
    const handled = intent === 'conversation' || (intent === 'record' && actions.length > 0)

    clauses.push({
      id, text: part.text, start: part.start, end: part.end,
      intent, handled,
      confidence: actions.length ? (parsed.ambiguity ? 'medium' : 'high') : (intent === 'conversation' ? 'high' : 'low'),
      actions,
      date, dateLabel: date ? dLabel || dateLabel(date, today) : undefined,
      ambiguity: parsed.ambiguity,
      dateAmbiguity,
    })

    if (actions.length && isQuestion) {
      clauses.push({
        id: clauseId(), text: part.text, start: part.start, end: part.end,
        intent: 'question', handled: false, confidence: 'low', actions: [],
      })
    }
  }

  const actions = clauses.flatMap(c => c.actions)
  const unansweredQuestions = clauses.filter(c => c.intent === 'question' && !c.handled)
  const unresolvedClauses = clauses.filter(c => !c.handled)

  const total = clauses.reduce((a, c) => a + c.text.length, 0) || 1
  const covered = clauses.filter(c => c.handled).reduce((a, c) => a + c.text.length, 0)

  return {
    originalText: original,
    normalizedText: normalized,
    clauses,
    actions,
    unansweredQuestions,
    unresolvedClauses,
    coverage: Math.min(covered / total, 1),
  }
}
