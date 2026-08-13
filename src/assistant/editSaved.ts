// Corrigir um lançamento JÁ SALVO, por conversa.
//
// Duas garantias que este módulo existe para dar:
//
// 1. A busca é LOCAL. O histórico do usuário nunca é empacotado e enviado para
//    a IA remota para ela "achar" o lançamento — a janela é o próprio estado,
//    filtrada pelas pistas que a frase deu.
// 2. O candidato NUNCA é escolhido por adivinhação. Zero candidatos vira
//    explicação; mais de um vira pergunta com as opções à mostra.
//
// Escopo desta rodada: `Transaction` simples e ocorrência recorrente já
// materializada. Editar a ocorrência não toca no template nem a libera para ser
// confirmada de novo — quem faz isso é o "desfaz o último", que é outra coisa.

import type { AppState, Transaction } from '../models/types'
import type { AssistantCapabilities } from './contracts'
import { findDate } from './dates'
import { parseMoney, addDays } from '../utils/format'
import { normalizeName } from '../utils/text'

/** Campos que podem ser corrigidos. O TIPO do lançamento não está aqui. */
export type EditableTxField = 'amount' | 'category' | 'description' | 'origin' | 'date'

export interface EditRequest {
  field: EditableTxField
  value: string | number
  /** Pistas ditas na frase para localizar o lançamento. */
  hints: { date?: string; from?: string; to?: string; amount?: number; text?: string }
  /** Reconhecido sem substantivo genérico: só vale se achar o lançamento. */
  loose?: boolean
}

const VERBO = 'corrig[ei]|corrigir|corrija|ajust[ae]|ajustar|mud[ae]|mudar|troc[ae]|trocar|alter[ae]|alterar|arrum[ae]|arrumar'
// "meta" e "cartão" NÃO entram: são outras ações do catálogo, com fluxo próprio.
const SUBSTANTIVO = 'gast[oa]s?|despesas?|receitas?|lan[çc]amentos?|movimenta[çc][ãa]o|movimenta[çc][õo]es|compras?'

const PEDIDO = new RegExp(String.raw`\b(?:${VERBO})\b[^.?!]*?\b(?:${SUBSTANTIVO})\b`, 'i')

/**
 * Na fala real ninguém diz "corrige o gasto de ontem": diz "muda o MERCADO pra
 * 80" — o lançamento é citado pela própria descrição. Sem isto o pedido não era
 * reconhecido e o usuário recebia "entendi que isso não aconteceu", que é
 * resposta de outra conversa.
 *
 * Reconhecer assim é mais frouxo, então o pedido nasce marcado como `loose`: só
 * vale se existir de verdade um lançamento que combine com o texto. Não achou
 * nada? A frase segue o caminho normal, sem nunca alegar que era correção.
 */
const PEDIDO_SOLTO = new RegExp(String.raw`\b(?:${VERBO})\b`, 'i')

/** Palavras que não identificam lançamento nenhum — sobra o nome de verdade. */
const RUIDO = new RegExp(
  String.raw`\b(?:${VERBO}|${SUBSTANTIVO}|o|a|os|as|um|uma|uns|umas|do|da|de|dos|das|no|na|nos|nas`
  + String.raw`|meu|minha|aquele|aquela|esse|essa|este|esta|valor|categoria|descri[çc][ãa]o|origem|data|pra|para|pro)\b`,
  'gi',
)

/** O "para X" separa o valor NOVO do valor antigo citado antes dele. */
const SEPARADOR = /\b(?:para|pra|pro)\b/i

const primeiroValor = (t: string): number | undefined => {
  const m = t.match(/(\d+(?:[.,]\d+)*)/)
  if (!m) return undefined
  const v = parseMoney(m[1])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Lê o pedido de correção. Devolve `null` quando a frase não é claramente
 * sobre um lançamento salvo — melhor não reconhecer do que sair alterando
 * histórico por causa de um verbo solto.
 */
export function parseEditRequest(
  message: string,
  caps: AssistantCapabilities,
  today: string,
): EditRequest | null {
  const generico = PEDIDO.test(message)
  // Meta, cartão e fatura têm ações próprias no catálogo: "muda a meta do
  // iphone para 8000" é `goal-update`, não correção de lançamento. O caminho
  // solto reconhece pelo verbo, então precisa desviar delas explicitamente.
  const outraCoisa = /\bmetas?\b|\bcart[ãa]o\b|\bfatura\b|\bparcelas?\b|\bhod[oô]metro\b/i.test(message)
  if (!generico && (outraCoisa || !PEDIDO_SOLTO.test(message))) return null
  const loose = !generico

  const corte = message.search(SEPARADOR)
  if (corte < 0) return null
  const esquerda = message.slice(0, corte)
  const direita = message.slice(corte).replace(SEPARADOR, '').trim()
  if (!direita) return null

  const hints: EditRequest['hints'] = {}
  const quando = findDate(esquerda, today)
  if (quando) {
    if (quando.kind === 'date') hints.date = quando.date
    else if (quando.kind === 'period') { hints.from = quando.from; hints.to = quando.to }
  }
  // Um valor à ESQUERDA do "para" é o valor atual, dito para identificar o
  // lançamento — não o novo. Datas já saíram do trecho para não virar número.
  const semData = quando && quando.start < corte
    ? esquerda.slice(0, quando.start) + ' ' + esquerda.slice(quando.end)
    : esquerda
  hints.amount = primeiroValor(semData)

  // O que sobra depois de tirar verbo, artigos, números e nomes de campo é o
  // apelido do lançamento — "mercado", "uber", "lanche".
  const alvoTexto = semData
    .replace(RUIDO, ' ')
    .replace(/[\d.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (alvoTexto.length > 2) hints.text = alvoTexto

  if (/\bcategoria\b/i.test(esquerda)) {
    const alvo = normalizeName(direita)
    const cat = caps.categories.find(c => normalizeName(c.id) === alvo || normalizeName(c.name) === alvo)
      || caps.categories.find(c => normalizeName(c.name).includes(alvo) && alvo.length > 2)
    return cat ? { field: 'category', value: cat.id, hints, loose } : null
  }
  if (/\bdescri[çc][ãa]o\b/i.test(esquerda)) return { field: 'description', value: direita, hints, loose }
  if (/\borigem\b/i.test(esquerda)) return { field: 'origin', value: direita, hints, loose }
  if (/\bdata\b/i.test(esquerda)) {
    const nova = findDate(direita, today)
    return nova && nova.kind === 'date' ? { field: 'date', value: nova.date, hints, loose } : null
  }

  const novo = primeiroValor(direita)
  return novo === undefined ? null : { field: 'amount', value: novo, hints, loose }
}

/** Janela local da busca: recente e curta, nunca o histórico inteiro. */
const DIAS_DE_BUSCA = 120
const MAX_CANDIDATOS = 40

/** Lançamentos compatíveis com as pistas, do mais recente para o mais antigo. */
export function findEditCandidates(state: AppState, req: EditRequest, today: string): Transaction[] {
  const limite = addDays(today, -DIAS_DE_BUSCA)
  let lista = (state.transactions || [])
    .filter(t => t.date >= limite && t.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_CANDIDATOS)

  if (req.hints.from && req.hints.to) {
    lista = lista.filter(t => t.date >= req.hints.from! && t.date <= req.hints.to!)
  } else if (req.hints.date) {
    lista = lista.filter(t => t.date === req.hints.date)
  }
  if (req.hints.amount !== undefined) {
    lista = lista.filter(t => Math.abs(t.amount - req.hints.amount!) < 0.005)
  }
  // O apelido do lançamento desempata sozinho: com "Mercado" e "Uber" no mesmo
  // dia, "corrige o uber pra 55" não precisa de pergunta nenhuma.
  if (req.hints.text) {
    const alvo = normalizeName(req.hints.text)
    const casa = lista.filter(t => {
      const desc = normalizeName(t.description || '')
      const cat = normalizeName(t.category || '')
      return (desc && (desc.includes(alvo) || alvo.includes(desc))) || cat === alvo
    })
    // Sem nenhum casamento, o texto não estreita nada — mas num pedido `loose`
    // é ele que autoriza a correção, então ali a lista fica vazia de propósito.
    if (casa.length || req.loose) lista = casa
  }
  return lista
}

/** A ação de correção para um candidato — um campo só, o que foi pedido. */
export function editActionFor(t: Transaction, req: EditRequest) {
  return { kind: 'edit-transaction' as const, transactionId: t.id, [req.field]: req.value }
}
