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
import { parseMoney, todayISO } from '../utils/format'

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

/**
 * Negação de um relato: "não gastei 100", "nao foi 99", "não quero guardar 150".
 *
 * Sem esta guarda o parser via o verbo e o valor e propunha a ação POSITIVA —
 * o usuário dizia que NÃO gastou e o app oferecia registrar o gasto. É o erro
 * mais perigoso possível num app de dinheiro.
 */
const NEGATED_VERBS =
  'gastei|gastou|paguei|pagou|recebi|recebeu|ganhei|ganhou|comprei|comprou|guardar|guardei|separei|abasteci|coloquei|botei|rodei|trabalhei|fiz|foi|era|quero|vou|registra|registre|salva|salve'

const NEGATED_STATEMENT = new RegExp(
  String.raw`^\s*(?:mas\s+|e\s+|ah\s+|olha\s+)?n[ãa]o\s+(?:\S+\s+){0,3}?(?:${NEGATED_VERBS})(?![a-zà-ú])`,
  'i',
)

export const looksNegated = (t: string): boolean => NEGATED_STATEMENT.test(t)

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
/**
 * Trechos que NÃO podem ser cortados: a frase inteira é uma unidade só.
 * "passei 2000 em 5 vezes e recebi 1850" tem um verbo de comando no meio, mas
 * cortar ali destrói a entrada financiada e cria uma receita de 1850 — que é
 * exatamente o erro que a regra 11 proíbe.
 */
/**
 * Marcadores de correção DENTRO da mesma mensagem: "gastei 100 no mercado quer
 * dizer 80". A segunda metade não é um lançamento novo — é o valor certo do
 * primeiro. Antes, virava uma despesa a mais (ou pior, uma despesa de 1850 numa
 * frase que falava de receita).
 */
const INTRA_CORRECTION =
  String.raw`(?:quer\s+dizer|na\s+verdade|ou\s+melhor|melhor\s+dizendo|digo|perd[ãa]o|desculpa|n[ãa]o\s+pera|pera[íi]?|corrigindo)`

const PROTECTED: RegExp[] = [
  /(?:passei|passou|fiz)\s+(?:r\$\s*)?[\d.,]+[^.;!?]*?(?:recebi|receber|peguei|caiu)\s+(?:r\$\s*)?[\d.,]+/gi,
  /comprei[^.;!?]*?\b(?:em|x)\s*\d+\s*(?:vez(?:es)?|x|parcelas?)/gi,
]

export function segment(text: string): { text: string; start: number; end: number }[] {
  const guarded: [number, number][] = []
  for (const re of PROTECTED) {
    for (const m of text.matchAll(re)) {
      if (m.index !== undefined) guarded.push([m.index, m.index + m[0].length])
    }
  }
  const inside = (i: number) => guarded.some(([a, b]) => i > a && i < b)

  const cuts = new Set<number>([0])
  const push = (i: number) => { if (i > 0 && i < text.length && !inside(i)) cuts.add(i) }

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
  // Conector explícito começando uma nova ideia — só quando um verbo de comando
  // vem logo depois. Sem essa exigência, "gastei 190 reais DEPOIS comprando
  // cimento" era cortado no meio e a descrição se perdia.
  for (const m of text.matchAll(new RegExp(String.raw`[,;]?\s+${CONNECTORS}(?=(?:${COMMAND_VERBS})\b)`, 'gi'))) {
    push((m.index || 0) + m[0].length)
  }
  // "mas", "porém" e "só que" separam registro de pergunta.
  for (const m of text.matchAll(/[,;]?\s+(?:mas|por[ée]m|s[óo]\s+que)\s+/gi)) push((m.index || 0) + m[0].length)
  // Palavra interrogativa começando uma pergunta colada ao registro:
  // "gastei 80 de mercado QUANTO sobrou" — sem este corte a pergunta virava
  // parte da descrição ("Mercado quanto") e nunca era respondida.
  for (const m of text.matchAll(/\s+(?=(?:e\s+)?(?:quanto|quantos|quantas|qual|quais|quando)\b)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  // Marcador de correção dentro da própria mensagem.
  for (const m of text.matchAll(new RegExp(String.raw`\s+(?=${INTRA_CORRECTION})`, 'gi'))) {
    push((m.index || 0) + m[0].length)
  }

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
 * TODAS as origens explícitas do trecho, com posição. Dois sinais são aceitos,
 * e nenhum deles é dedução:
 *   1. "da Casa 1", "do Cliente João" — substantivo de fonte + identificador;
 *   2. "da Empresa X" com Inicial Maiúscula no original (nome próprio).
 * "gastei 190 de cimento" nunca vira origem: "cimento" não é nome próprio nem
 * substantivo de fonte.
 */
export function extractOrigins(originalClause: string): { value: string; at: number }[] {
  const out: { value: string; at: number }[] = []
  const taken: [number, number][] = []
  const add = (v: string, start: number, end: number) => {
    if (taken.some(([a, b]) => start < b && end > a)) return
    if (/^(uber|99|indrive|indriver)$/i.test(v)) return // plataforma é descrição
    taken.push([start, end])
    out.push({ value: v.replace(/\s+/g, ' ').trim(), at: start })
  }

  for (const m of originalClause.matchAll(new RegExp(String.raw`\bd[ao]s?\s+((?:${ORIGIN_NOUNS})\s+[\wçãõáéíóúâê\d]+)`, 'gi'))) {
    if (m.index !== undefined) add(m[1], m.index, m.index + m[0].length)
  }
  for (const m of originalClause.matchAll(
    /\bd[ao]s?\s+((?:[A-ZÀ-ÖØ-Þ][\wçãõáéíóúâêô]+)(?:\s+(?:[A-ZÀ-ÖØ-Þ][\wçãõáéíóúâêô]+|\d+))*)/g,
  )) {
    if (m.index !== undefined) add(m[1], m.index, m.index + m[0].length)
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Compatibilidade: a primeira origem do trecho. */
export const extractOrigin = (t: string): string | undefined => extractOrigins(t)[0]?.value

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

const DATABLE = new Set(['income', 'expense', 'saving', 'work', 'fuel', 'maintenance'])
const ORIGINABLE = new Set(['income', 'expense'])

let seq = 0
const clauseId = () => `c${++seq}`

/**
 * Onde, no texto, está escrito o valor desta ação. Serve para ligar cada
 * lançamento à origem que o usuário citou logo depois dele.
 * Devolve -1 quando o valor não aparece de forma reconhecível.
 */
function amountPosition(text: string, amount?: number): number {
  if (!(amount > 0)) return -1
  const inteiro = Math.round(amount)
  const candidatos = [
    String(amount).replace('.', ','),
    String(inteiro),
    inteiro.toLocaleString('pt-BR'),
  ]
  for (const c of candidatos) {
    const i = text.indexOf(c)
    if (i >= 0) return i
  }
  return -1
}

/** Primeiro valor monetário de um trecho — usado só pela correção intramensagem. */
function parseFirstAmount(text: string): number {
  const m = text.match(/(\d+(?:[.,]\d+)*)/)
  return m ? parseMoney(m[1]) : NaN
}

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

  /**
   * Data herdada: "ONTEM recebi 1800 e gastei 150" tem uma data só, dita uma
   * vez, valendo para a frase inteira. Sem herança a segunda ação caía em hoje
   * e o usuário só descobria depois de confirmar.
   */
  let inheritedDate: string | undefined
  let inheritedLabel: string | undefined

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const forParser = aligned ? normalizedParts[i].text : normalized
    const id = clauseId()

    // A expressão de data é retirada ANTES de o parser rodar: sem isso ela
    // sobrava na descrição do lançamento ("Despesa de R$ 40,00 — Hoje · hoje").
    const dateRes = findDate(part.text, today)
    const dateInParser = findDate(forParser, today)
    const semData = dateInParser
      ? (forParser.slice(0, dateInParser.start) + ' ' + forParser.slice(dateInParser.end)).replace(/\s{2,}/g, ' ').trim()
      : forParser

    const parsed = parseNaturalFull(semData || forParser, { driver: opts?.driver })
    let actions = parsed.actions
    let date: string | undefined
    let dLabel: string | undefined
    let dateAmbiguity: AnalyzedClause['dateAmbiguity']
    if (dateRes) {
      if (dateRes.kind === 'date') { date = dateRes.date; dLabel = dateRes.label }
      else if (dateRes.kind === 'ambiguous') dateAmbiguity = { question: dateRes.question, options: dateRes.options }
      // 'future' e 'period' não datam um fato já ocorrido: ficam de fora e a
      // cláusula segue com a data de hoje, como sempre foi.
    }
    if (date) { inheritedDate = date; inheritedLabel = dLabel }
    else if (inheritedDate) { date = inheritedDate; dLabel = inheritedLabel }

    // Origem por posição: "recebi 1800 da Casa 1, mais 1750 da Casa 2" tem duas
    // fontes numa cláusula só. Quando a quantidade de origens bate com a de
    // ações que aceitam origem, elas são pareadas na ordem; do contrário a
    // única origem encontrada vale para todas — e nenhuma é inventada.
    // Origem por PROXIMIDADE: numa cláusula como "recebi 1800 da casa 1 e 1750
    // da casa 2 gastei 200 de obra", parear por ordem não funciona (há 4 ações
    // que aceitam origem e só 2 fontes). Cada ação é ligada à fonte que aparece
    // logo depois do SEU valor no texto — e nenhuma origem é inventada.
    const origins = extractOrigins(part.text)

    actions = actions.map(a => {
      const next: any = { ...a }
      if (date && DATABLE.has(a.kind)) next.date = date
      if (ORIGINABLE.has(a.kind) && !next.origin && origins.length) {
        const at = amountPosition(part.text, next.amount)
        const perto = at >= 0
          ? origins.filter(o => o.at > at).sort((x, y) => x.at - y.at)[0]
          : undefined
        // Sem conseguir localizar o valor no texto, só usa a origem quando ela é
        // única — do contrário arriscaria colar a fonte errada no lançamento.
        const pick = perto || (origins.length === 1 ? origins[0] : undefined)
        if (pick) next.origin = pick.value
      }
      return next as ParsedAction
    })

    const isConversation = looksLikeConversation(part.text)
    const isQuestion = !isConversation && looksLikeQuestion(part.text)

    // Pergunta de ANÁLISE cita valores para serem avaliados, não registrados:
    // "essa corrida de 18 por 12 km vale a pena?" não é uma receita de 18.
    if (isQuestion && /\bvale\s+a\s+pena\b|\bcompensa\b|\bdevo\s+aceitar\b|\bacei(?:to|tar)\b/i.test(part.text)) {
      actions = []
    }

    // Relato NEGADO nunca vira lançamento: "não gastei 100" propunha registrar
    // a despesa de 100 — o erro mais perigoso possível num app de dinheiro.
    const negated = looksNegated(part.text)
    if (negated) actions = []

    // Hipótese descreve um cenário, não um fato consumado.
    if (/\bse\s+(?:eu|voc[êe]|a\s+gente)\b|\bt[ôo]\s+pensando\b|\bestou\s+pensando\b|\bacho\s+que\b/i.test(part.text)) {
      actions = []
    }

    const isCorrection = !isConversation && looksLikeCorrection(part.text)

    let intent: AssistantIntent
    if (isConversation) intent = 'conversation'
    else if (negated) intent = 'correction'
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

  // Registros de trabalho de cláusulas diferentes são o MESMO dia: "rodei 120 km
  // e fiz 14 viagens" não são dois turnos. A fusão acontece aqui porque a
  // segmentação separou o que o parser antigo via junto.
  const works = clauses.flatMap(c => c.actions.filter(a => a.kind === 'work')) as any[]
  if (works.length > 1) {
    const merged: any = { kind: 'work' }
    for (const w of works) {
      for (const f of ['km', 'trips', 'hours'] as const) {
        if (w[f] !== undefined) merged[f] = (merged[f] || 0) + w[f]
      }
      if (w.date && !merged.date) merged.date = w.date
    }
    // O resumo de trabalho fica na ÚLTIMA cláusula que falava de trabalho: é
    // como a frase é lida ("ganhei X, gastei Y, rodei Z km").
    let remaining = works.length
    for (const c of clauses) {
      c.actions = c.actions.flatMap(a => {
        if (a.kind !== 'work') return [a]
        remaining--
        return remaining === 0 ? [merged as ParsedAction] : []
      })
    }
  }

  // CORREÇÃO DENTRO DA MESMA MENSAGEM: "gastei 100 no mercado quer dizer 80".
  // A cláusula que começa com o marcador não é um lançamento novo — carrega o
  // valor certo do anterior. Antes disso, "recebi 1800 não pera foi 1850" criava
  // uma receita de 1800 E uma despesa de 1850.
  const startsWithCorrection = new RegExp(String.raw`^\s*${INTRA_CORRECTION}`, 'i')
  for (let i = 1; i < clauses.length; i++) {
    const c = clauses[i]
    if (!startsWithCorrection.test(c.text)) continue
    const novo = c.actions.map(a => (a as any).amount ?? (a as any).total ?? (a as any).cost).find(v => v > 0)
      ?? parseFirstAmount(c.text)
    // Última cláusula anterior que tem ação com valor.
    let alvo: AnalyzedClause | undefined
    for (let j = i - 1; j >= 0; j--) if (clauses[j].actions.length) { alvo = clauses[j]; break }
    if (alvo && novo > 0) {
      const ult: any = alvo.actions[alvo.actions.length - 1]
      const campo = ult.amount !== undefined ? 'amount' : ult.total !== undefined ? 'total' : ult.cost !== undefined ? 'cost' : null
      if (campo) ult[campo] = novo
    }
    c.actions = []
    c.intent = 'correction'
    c.handled = true
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
