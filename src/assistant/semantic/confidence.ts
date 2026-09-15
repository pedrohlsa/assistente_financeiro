// CONFIANÇA DA DECISÃO LOCAL — quando o motor local NÃO deve ter a última palavra.
//
// A regra "local primeiro" está certa e continua valendo: o que o aparelho sabe
// com certeza, o aparelho responde. O defeito era outro — uma leitura local de
// BAIXA confiança ser tratada como resposta final. "qnto q foi d obra msm nos
// ultimo 3 mes" virava uma despesa de R$ 3,00; como havia uma ação, a cláusula
// contava como resolvida e ninguém mais olhava para a frase, nem a consulta
// local nem o modelo remoto.
//
// Aqui ficam os critérios, todos DETERMINÍSTICOS e explicáveis — nenhum escore
// somado com peso mágico. Uma ação suspeita sai da cláusula antes de virar
// proposta, e a cláusula volta a ficar em aberto: a consulta local pode
// respondê-la, e o que sobrar segue para o remoto, que nunca sobrescreve um
// campo que o usuário escreveu (evidência por campo).
//
// Critérios avaliados e NÃO adotados, com o motivo:
//   · "o parser consumiu só uma parte pequena da frase" e "sobrou muito texto":
//     registro legítimo é assim ("gastei 190 de cimento pro muro da casa da
//     minha mãe"); a medida acusaria a frase boa.
//   · "o verbo não foi reconhecido exatamente": o reparo de digitação já trata
//     isso com dicionário fechado, e descartar a leitura reparada perderia o
//     lançamento que ele existe para salvar.
//   · "valor muito diferente do padrão do usuário": já é AVISO no card (regra 38)
//     — virar suspeita bloquearia o dia excepcional, que a regra protege.

import type { ParsedAction } from '../../models/types'
import { parseMoney } from '../../utils/format'

export type SuspicionReason =
  /** O único lugar da frase onde o valor aparece é como TAMANHO de período ("3 meses"). */
  | 'valor-de-periodo'
  /** Movimento de dinheiro numa frase que é pergunta e não afirma nada no passado. */
  | 'pergunta-sem-fato'
  /** A frase diz "3 mil" ou "4k" e o valor lido ficou em 3 ou 4. */
  | 'magnitude-perdida'
  /** Uma DESPESA cuja descrição é a própria meta: o usuário guardou, não gastou. */
  | 'meta-como-despesa'

export interface SuspicionInput {
  /** A cláusula como o usuário escreveu. */
  text: string
  /** A mesma cláusula com número por extenso e "mil" já em algarismos. */
  normalized: string
  isQuestion: boolean
  hasPastMoneyVerb: boolean
}

const MOVIMENTO = new Set(['income', 'expense', 'saving'])

const valorDe = (a: ParsedAction): number | undefined => {
  const x: any = a
  return [x.amount, x.total, x.cost].find((v: unknown) => typeof v === 'number' && Number.isFinite(v))
}

const escapa = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function suspicionReasons(action: ParsedAction, i: SuspicionInput): SuspicionReason[] {
  const out: SuspicionReason[] = []
  const v = valorDe(action)

  if (v !== undefined) {
    // Só DURAÇÃO conta: "3 meses", "90 dias", "nos ultimo 3 mes". "100 mês
    // passado" e "50 dia 10" são valor seguido de data, e acusá-los apagava o
    // lançamento legítimo.
    const ocorrencias = [...i.normalized.matchAll(/(?<!\d|\d[.,])(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(\s*(?:dias|semanas|meses|anos|m[eê]s(?!\s+(?:passado|anterior|retrasado|que\s+vem|atual))|semana(?!\s+(?:passada|anterior|retrasada|que\s+vem))|ano(?!\s+(?:passado|anterior|que\s+vem)))\b)?/gi)]
    const doValor = ocorrencias.filter(m => Math.abs(parseMoney(m[1]) - v) < 0.005)
    if (doValor.length && doValor.every(m => m[2])) out.push('valor-de-periodo')

    if (v < 1000 && Number.isInteger(v)
      && new RegExp(`(?<!\\d|\\d[.,])${escapa(String(v))}(?:[.,]\\d{1,2})?\\s*(?:mil|k)\\b`, 'i').test(i.text)) {
      out.push('magnitude-perdida')
    }
  }

  if (MOVIMENTO.has(action.kind) && i.isQuestion && !i.hasPastMoneyVerb) out.push('pergunta-sem-fato')

  if (action.kind === 'expense' && /\bmetas?\b/i.test(String((action as any).description || ''))) {
    out.push('meta-como-despesa')
  }
  return out
}

// ---------------------------------------------------------------------------
// A decisão local, com nome
// ---------------------------------------------------------------------------

export type LocalDecision =
  /** Toda cláusula útil foi resolvida sem suspeita nem dúvida. */
  | 'local-high-confidence'
  /** Parte foi resolvida; o que sobrou pode ir para quem sabe responder. */
  | 'local-partial'
  /** O aparelho entendeu, mas precisa de uma escolha do usuário (gás, data, cartão). */
  | 'local-ambiguous'
  /** Uma leitura local foi DESCARTADA por suspeita; a cláusula ficou em aberto. */
  | 'local-suspicious'
  /** Nada útil foi resolvido no aparelho. */
  | 'remote-needed'

interface ClausulaMinima {
  intent: string
  handled: boolean
  suspicious?: SuspicionReason[]
  ambiguity?: unknown
  dateAmbiguity?: unknown
  temporal?: { plan?: boolean }
}

export function classifyLocalDecision(analysis: { clauses: ClausulaMinima[] }): LocalDecision {
  const uteis = analysis.clauses.filter(c => c.intent !== 'conversation')
  if (uteis.some(c => c.suspicious?.length)) return 'local-suspicious'
  if (uteis.some(c => c.ambiguity || c.dateAmbiguity || (c.temporal && !c.temporal.plan))) return 'local-ambiguous'
  const abertas = uteis.filter(c => !c.handled)
  if (!abertas.length) return 'local-high-confidence'
  return uteis.some(c => c.handled) ? 'local-partial' : 'remote-needed'
}
