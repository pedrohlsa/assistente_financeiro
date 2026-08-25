// EVIDÊNCIA POR CAMPO — quem disse cada coisa, e quem ganha de quem.
//
// O problema: `AssistantCandidateAction.confidence` é UM valor para a ação
// inteira. Numa frase como "recebi 1800 de aluguel da Casa 1", o valor e a
// origem vieram explicitamente do usuário, a categoria veio do parser e a
// descrição poderia vir do modelo remoto — três procedências diferentes tratadas
// como uma só.
//
// A consequência prática era a reconciliação com o remoto: sem saber a
// procedência de cada campo, ela só sabia fazer duas coisas — descartar a ação
// remota inteira (perdendo a descrição boa) ou aceitá-la inteira (arriscando
// trocar 1800 por 180). Aqui o merge é POR CAMPO, com uma ordem fixa.
//
// A ordem NÃO é configurável e não admite empate resolvido por peso:
//
//   1 user-explicit    o usuário escreveu o valor NESTA mensagem
//   2 clarification    o usuário respondeu a uma pergunta do assistente
//   3 local-parser     o parser determinístico reconheceu com confiança
//   4 personal-history o histórico confirmado dele (regra 39, nível 5)
//   5 remote-model     a IA remota
//   6 fallback         a lista genérica do app
//
// Um nível inferior NUNCA sobrescreve um superior em silêncio. Dois níveis
// FORTES em conflito real não são resolvidos por votação: perguntam.

import type { ParsedAction } from '../../models/types'
import { normalizeName } from '../../utils/text'

export type EvidenceSource =
  | 'user-explicit' | 'clarification' | 'local-parser'
  | 'personal-history' | 'remote-model' | 'fallback'

export const EVIDENCE_RANK: Record<EvidenceSource, number> = {
  'user-explicit': 1,
  clarification: 2,
  'local-parser': 3,
  'personal-history': 4,
  'remote-model': 5,
  fallback: 6,
}

/** Até este nível a evidência é FORTE: conflito entre duas delas se pergunta. */
const NIVEL_FORTE = EVIDENCE_RANK['local-parser']

export interface AssistantFieldEvidence {
  field: string
  value: unknown
  source: EvidenceSource
  confidence: 'high' | 'medium' | 'low'
  clauseId?: string
  span?: { start: number; end: number }
}

export interface EvidencedAction {
  action: ParsedAction
  evidence: AssistantFieldEvidence[]
}

export interface FieldConflict {
  field: string
  mine: AssistantFieldEvidence
  theirs: AssistantFieldEvidence
}

// ---------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------

/** Campos cuja presença já significa que o usuário os disse (regra do projeto). */
const SEMPRE_EXPLICITOS = new Set(['origin', 'source'])
/** Campos numéricos que só existem se estiverem escritos na frase. */
const NUMERICOS = new Set(['amount', 'total', 'cost', 'netReceived', 'installments', 'target', 'km', 'hours', 'trips', 'liters', 'value', 'months'])

const aparece = (texto: string, valor: unknown): boolean => {
  if (valor === undefined || valor === null) return false
  const t = normalizeName(texto)
  if (typeof valor === 'number') {
    const inteiro = Math.round(valor)
    return [
      String(valor).replace('.', ','),
      String(inteiro),
      inteiro.toLocaleString('pt-BR'),
    ].some(c => t.includes(normalizeName(c)))
  }
  const s = normalizeName(String(valor))
  return s.length > 1 && t.includes(s)
}

export interface EvidenceContext {
  clauseId?: string
  /** Trecho literal que originou a ação — é nele que se procura o valor. */
  text: string
  /** Categoria aplicada pelo aprendizado pessoal, quando houve. */
  learnedCategory?: string
  /** Categoria preenchida por padrão do app (Outros, categoria de receita). */
  fallbackCategory?: string
  /** A ação inteira veio da IA remota. */
  remote?: boolean
  /** O campo veio da resposta a uma pergunta do assistente. */
  fromClarification?: string[]
}

/**
 * Deriva a procedência de cada campo da ação.
 *
 * Nada aqui adivinha: um número é `user-explicit` porque ele APARECE no texto,
 * a origem é explícita porque o parser tem proibição de inferir origem (regra do
 * projeto), e a categoria é `fallback` porque quem a preencheu foi o padrão.
 */
export function evidenceFor(action: ParsedAction, ctx: EvidenceContext): EvidencedAction {
  const a: any = action
  const evidence: AssistantFieldEvidence[] = []
  const push = (field: string, value: unknown, source: EvidenceSource, confidence: AssistantFieldEvidence['confidence'] = 'high') => {
    evidence.push({ field, value, source, confidence, clauseId: ctx.clauseId })
  }

  for (const field of Object.keys(a)) {
    if (field === 'kind') continue
    const value = a[field]
    if (value === undefined || value === null || value === '') continue

    if (ctx.fromClarification?.includes(field)) { push(field, value, 'clarification'); continue }
    if (SEMPRE_EXPLICITOS.has(field)) { push(field, value, 'user-explicit'); continue }

    if (field === 'category') {
      if (ctx.learnedCategory === value) push(field, value, 'personal-history')
      else if (ctx.fallbackCategory === value) push(field, value, 'fallback', 'low')
      else push(field, value, ctx.remote ? 'remote-model' : 'local-parser')
      continue
    }

    if (NUMERICOS.has(field)) {
      push(field, value, aparece(ctx.text, value) ? 'user-explicit' : (ctx.remote ? 'remote-model' : 'local-parser'))
      continue
    }

    if (field === 'date') {
      // Data só entra na ação quando uma expressão temporal foi reconhecida —
      // `validateAction` recusa data futura e o parser nunca inventa dia.
      push(field, value, ctx.remote ? 'remote-model' : 'local-parser')
      continue
    }

    push(field, value, ctx.remote ? 'remote-model' : 'local-parser', ctx.remote ? 'medium' : 'high')
  }

  return { action, evidence }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const rankOf = (e: AssistantFieldEvidence | undefined): number =>
  (e ? EVIDENCE_RANK[e.source] : Number.MAX_SAFE_INTEGER)

const mesmoValor = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005
  if (typeof a === 'string' && typeof b === 'string') return normalizeName(a) === normalizeName(b)
  return a === b
}

export interface MergeOutcome {
  merged: EvidencedAction
  /** Campos em que duas evidências FORTES discordam. Quem recebe, PERGUNTA. */
  conflicts: FieldConflict[]
  /** Campos que a segunda fonte acrescentou de fato. */
  filled: string[]
  /** Campos da segunda fonte que foram recusados por perder na hierarquia. */
  rejected: { field: string; value: unknown; reason: 'lower-rank' }[]
}

/**
 * Funde duas leituras da MESMA ação, campo a campo.
 *
 * `base` é a leitura de maior autoridade por padrão (o local); `extra` só entra
 * onde tem procedência melhor ou onde não havia nada. É isto que permite
 * aproveitar a descrição do modelo remoto sem deixá-lo trocar o valor que o
 * usuário escreveu.
 */
export function mergeByField(base: EvidencedAction, extra: EvidencedAction): MergeOutcome {
  const porCampo = new Map<string, AssistantFieldEvidence>()
  for (const e of base.evidence) porCampo.set(e.field, e)

  const out: any = { ...(base.action as any) }
  const conflicts: FieldConflict[] = []
  const filled: string[] = []
  const rejected: MergeOutcome['rejected'] = []

  for (const e of extra.evidence) {
    const atual = porCampo.get(e.field)
    if (!atual) {
      // Campo vazio: qualquer procedência serve para preencher.
      porCampo.set(e.field, e)
      out[e.field] = e.value
      filled.push(e.field)
      continue
    }
    if (mesmoValor(atual.value, e.value)) continue

    const rankAtual = rankOf(atual)
    const rankNovo = rankOf(e)
    if (rankNovo < rankAtual) {
      porCampo.set(e.field, e)
      out[e.field] = e.value
      filled.push(e.field)
      continue
    }
    if (rankNovo === rankAtual && rankAtual <= NIVEL_FORTE) {
      // Duas evidências fortes discordando: não existe desempate honesto.
      conflicts.push({ field: e.field, mine: atual, theirs: e })
      continue
    }
    rejected.push({ field: e.field, value: e.value, reason: 'lower-rank' })
  }

  return {
    merged: { action: out as ParsedAction, evidence: [...porCampo.values()] },
    conflicts, filled, rejected,
  }
}

/** As duas ações descrevem o MESMO fato? Só então faz sentido fundi-las. */
export function sameFact(a: ParsedAction, b: ParsedAction): boolean {
  if (a.kind !== b.kind) return false
  const x: any = a
  const y: any = b
  for (const campo of ['amount', 'total', 'cost'] as const) {
    const va = x[campo]
    const vb = y[campo]
    if (va !== undefined && vb !== undefined) return mesmoValor(va, vb)
  }
  // Sem valor dos dois lados, só o mesmo tipo não basta para afirmar que é o
  // mesmo fato — fundir aqui juntaria dois lançamentos diferentes num só.
  return false
}

/** Pergunta pronta para um conflito real entre duas evidências fortes. */
export function conflictQuestion(c: FieldConflict): string {
  const nome: Record<string, string> = {
    amount: 'o valor', total: 'o valor total', category: 'a categoria',
    description: 'a descrição', origin: 'a origem', date: 'a data',
    cardName: 'o cartão', installments: 'o número de parcelas',
  }
  return `Fiquei em dúvida sobre ${nome[c.field] || c.field}: `
    + `é "${String(c.mine.value)}" ou "${String(c.theirs.value)}"?`
}
