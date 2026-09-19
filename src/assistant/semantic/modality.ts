// MODALIDADE EXPLÍCITA DO TURNO — o que o usuário disse ganha do que o modelo leu.
//
// "Vou receber 1800 da casa 1 dia 5" não é pergunta nem fato: é algo que ainda
// vai acontecer. Na seleção de modelo (19/09/2026) os dois candidatos devolveram,
// nas três repetições, um plano de consulta sobre lançamentos REALIZADOS — e o
// app respondia "Total setembro: R$ 1.800,00 (dado real)". Nenhum modelo precisa
// errar para isso acontecer de novo: a frase já traz a evidência, e ela é lida
// aqui, deterministicamente, antes de o plano remoto ser executado.
//
// Só evidência EXPLÍCITA conta. "Dia 5" sozinho não é futuro (é o último dia 5,
// ou um dia que o usuário vai esclarecer): o futuro vem do verbo ("vou receber",
// "vai cair") ou de uma data relativa que só existe à frente ("amanhã", "semana
// que vem", "daqui a 3 dias").

import type { AssistantQueryPlan } from '../query/types'
import { declaresIntention, looksLikeRetraction, looksNegated } from '../clauses'
import { findAllDates } from '../dates'
import { looksRecurring } from '../../services/nlp'

export type ModalidadeExplicita = 'futuro' | 'negacao' | 'retratacao' | 'recorrencia'

/** Modal de FUTURO. `declaresIntention` também casa "posso" e "quero", que não afirmam futuro. */
const MODAL_FUTURO = /\b(?:vou|vamos|vai|v[ãa]o|irei|ir[áa]|ir[ãa]o)\b/i
const PERGUNTA = /\?\s*$|^\s*(?:quanto|quantos|quantas|qual|quais|quando|onde|como|ser[áa]|tem|t[ôo]|estou|d[áa]\s+pra)\b/i

/**
 * A modalidade que a frase DECLARA, ou `null` quando ela não declara nenhuma.
 * Negação, retratação e recorrência valem só para afirmação: "não gastei nada
 * com obra esse mês?" é pergunta, e pergunta pode ser consultada.
 */
export function modalidadeExplicita(texto: string, hoje: string): ModalidadeExplicita | null {
  const t = texto.toLowerCase()
  if ((declaresIntention(t) && MODAL_FUTURO.test(t))
    || findAllDates(t, hoje).some(d => d.kind === 'future' && d.relative)) return 'futuro'
  if (PERGUNTA.test(t)) return null
  if (looksNegated(t)) return 'negacao'
  if (looksLikeRetraction(t)) return 'retratacao'
  if (looksRecurring(t)) return 'recorrencia'
  return null
}

/** Fontes que só contêm o que JÁ aconteceu. As outras (previsão, fatura, parcela, meta) falam do futuro por natureza. */
const REALIZADAS = new Set(['transactions', 'work', 'fuel', 'maintenance'])

/**
 * O plano afirma como FATO algo que a frase declarou não ser?
 *
 * Futuro contra fonte realizada sem período futuro: o que ainda vai acontecer
 * lido como o que já aconteceu. Negação e retratação contra qualquer plano: a
 * frase desmente um fato, não pede uma consulta. Recorrência contra fonte
 * realizada: "recebo todo dia 5" descreve uma conta prevista, não a soma do mês.
 */
export function planoContradizModalidade(plan: AssistantQueryPlan, modalidade: ModalidadeExplicita): boolean {
  switch (modalidade) {
    case 'negacao':
    case 'retratacao':
      return true
    case 'futuro':
      return REALIZADAS.has(plan.source) && !plan.period.future
    case 'recorrencia':
      return REALIZADAS.has(plan.source)
  }
}
