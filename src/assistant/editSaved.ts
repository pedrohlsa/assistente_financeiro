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
import { guessCategory } from '../data/categories'
import { normalizeName } from '../utils/text'

/** Campos que podem ser corrigidos. O TIPO do lançamento não está aqui. */
export type EditableTxField = 'amount' | 'category' | 'description' | 'origin' | 'date'

export interface EditRequest {
  field: EditableTxField
  value: string | number
  /** Pistas ditas na frase para localizar o lançamento. */
  hints: {
    date?: string; from?: string; to?: string; amount?: number; text?: string
    /** O nome veio do SUJEITO da frase ("a FEIRA foi 150"): sem lançamento com esse nome, não há candidato. */
    textRequired?: boolean
  }
  /** Reconhecido sem substantivo genérico: só vale se achar o lançamento. */
  loose?: boolean
  /**
   * A frase contesta um valor sem dizer de qual lançamento ("não, foi 100
   * mesmo"). Mesmo com um candidato só, a resposta é PERGUNTAR: ali "foi 100
   * mesmo" também pode ser confirmação, e corrigir histórico por dedução não
   * é aceitável.
   */
  ask?: boolean
  /**
   * "O almoço FOI 25": pode ser correção do lançamento salvo ou um gasto novo.
   * Só vale com lançamento desse nome, e aí o app pergunta qual das duas.
   */
  orNew?: boolean
  /** "Era lazer MESMO": confirma a categoria; nada muda se ela já é essa. */
  confirm?: boolean
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
  // "Tenho dinheiro pra TROCAR o pneu de 600?" pergunta pelo saldo; não é
  // correção de um lançamento chamado "Tenho dinheiro".
  if (/\btenho\s+(?:dinheiro|grana|saldo|bala)\s+(?:pra|para)\b|\b(?:d[aá]|daria)\s+(?:pra|para)\s+(?:trocar|pagar|comprar)\b/i.test(message)) return null
  // "SE EU TROCAR pra um carro que faz 15 km/l": hipótese, não correção.
  if (/^\s*(?:e\s+)?se\s+(?:eu\s+)?(?:troc|mud|compr|vend)/i.test(message)) return null
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

// ---------------------------------------------------------------------------
// Correção FALADA — a forma declarativa
// ---------------------------------------------------------------------------
//
// Na fala real a correção quase nunca vem no imperativo ("corrige o gasto de
// ontem para 90"). Vem assim:
//
//     aquele gasto de ontem foi 90 e não 80
//     aquele do mercado foi 230 na verdade
//     o 150 que eu te falei era de farmácia não de mercado
//     não foi 80, foi 90
//
// Nenhuma tem verbo de edição nem "para", então `parseEditRequest` não as
// reconhecia — e a frase seguia para o parser de registro, onde `foi` é verbo
// de despesa: nascia um lançamento NOVO de 90, com a descrição "Não 80", ao
// lado do de 80 que continuava errado.
//
// O reconhecimento aqui é estreito de propósito. Precisa da MARCA de correção
// (o par "X e não Y", "não foi Y, foi X", "na verdade" junto de uma referência
// a algo já dito) e não aceita verbo de registro: "não gastei 80" é negação,
// "gastei 150 na verdade 130" é correção dentro da própria frase, e as duas
// têm dono em outro lugar.

const VALOR = String.raw`(?:r\$\s*)?(\d+(?:[.,]\d+)*)`
const COPULA = String.raw`(?:foi|era|[ée]|deu|custou)`
const NAO = String.raw`n[ãa]o`

/** Verbo de REGISTRO: com ele a frase é relato (ou negação de relato), não correção de algo salvo. */
const VERBO_DE_REGISTRO = /\b(?:gastei|gastou|paguei|pagou|recebi|recebeu|ganhei|ganhou|comprei|comprou|caiu|entrou|saiu|abasteci|coloquei|botei|guardei|separei|depositei|rodei|fiz|parcelei|passei)\b/i

/** A frase aponta para algo já dito ou salvo. */
const REFERENCIA = /\b(?:aquel[ea]|ess[ea]|est[ea])\b|\b[oa]\s+(?:de|do|da)\s+\S+|\b[oa]\s+\d+(?:[.,]\d+)*\s+que\s+eu\s+(?:te\s+)?(?:falei|disse|passei|mandei)|\bque\s+eu\s+(?:te\s+)?(?:falei|disse|passei|mandei)\b/i

const NOVO_E_NAO_ANTIGO = new RegExp(String.raw`\b${COPULA}\s+${VALOR}\s*,?\s*(?:e\s+)?${NAO}\s+(?:${COPULA}\s+)?${VALOR}(?![\d.,]*\d)`, 'i')
const NAO_ANTIGO_NOVO = new RegExp(String.raw`\b${NAO}\s+(?:${COPULA})\s+${VALOR}\s*,?\s*(?:e\s+sim\s+|mas\s+|foi\s+|era\s+|[ée]\s+)+${VALOR}`, 'i')
const NA_VERDADE_NOVO = new RegExp(String.raw`\b${COPULA}\s+${VALOR}\s+na\s+(?:verdade|real)\b|\bna\s+(?:verdade|real)\s*,?\s*(?:\S+\s+){0,3}?${COPULA}\s+${VALOR}`, 'i')
const DISSE_ANTIGO_ERA_NOVO = new RegExp(String.raw`\b[oa]\s+${VALOR}\s+que\s+eu\s+(?:te\s+)?(?:falei|disse|passei|mandei)\s+${COPULA}\s+${VALOR}`, 'i')
const CATEGORIA_TROCADA = new RegExp(String.raw`\b${COPULA}\s+(?:de|d[oa])\s+([a-zà-úçãõ][\wçãõáéíóúâê]*)\s*,?\s*(?:e\s+)?${NAO}\s+(?:de|d[oa])\s+([a-zà-úçãõ][\wçãõáéíóúâê]*)`, 'i')
const CONTESTA_SEM_ALVO = new RegExp(String.raw`^\s*${NAO}\s*[,!.]?\s+${COPULA}\s+${VALOR}(?:\s+mesmo)?\s*[.!]?\s*$`, 'i')

const COPULA_COM_VALOR = new RegExp(String.raw`\b${COPULA}\s+${VALOR}`, 'i')
// "ERREI, era 45 e não 54": a muleta de retratação abre a frase e não nomeia
// nada — virava a busca por um lançamento chamado "Errei".
const INICIO_CORRECAO = /^\s*(?:(?:e|ops+|opa|ih|xi|putz|nossa|desculp[ae]|perd[aã]o|foi\s+mal|errei|me\s+enganei|enganei|corrigindo|na\s+(?:verdade|real))(?![\wÀ-ÿ])[\s,;:.!-]*)*/i
const ARTIGO_CORRECAO = /^(?:(?:o|a|os|as|aquele|aquela|esse|essa|este|esta|meu|minha)\s+)+/i

function nomeDaCorrecao(prefixo: string, today: string): string | undefined {
  const sujeito = prefixo.replace(INICIO_CORRECAO, '').trim().replace(ARTIGO_CORRECAO, '')
    .replace(/[,;:.!?]+$/, '').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim()
  if (!/^[a-zà-ú]/i.test(sujeito) || /\b(?:nao|não|nem)\s*$/i.test(sujeito)) return undefined
  const data = findDate(sujeito, today)
  const semData = data
    ? sujeito.slice(0, data.start) + ' ' + sujeito.slice(data.end)
    : sujeito
  const nome = semData.trim()
    .replace(new RegExp(String.raw`^(?:${SUBSTANTIVO}|valor|conta|entrada|sa[íi]da)\s+d[aeo]\s+`, 'i'), '')
    .replace(/^(?:de|do|da)\s+/i, '').replace(/\s+(?:de|do|da)$/i, '').trim()
  if (!nome || /^(?:de|do|da|gasto|despesa|lan[çc]amento|receita|valor|compra|conta|total|entrada|sa[íi]da|[úu]ltim[oa]|primeir[oa]|outr[oa]|mesm[oa]|aquel[ea]|ess[ea]|est[ea]|me[uo]|minha)$/i.test(nome)) return undefined
  return nome
}

function valorDe(raw?: string): number | undefined {
  if (!raw) return undefined
  const v = parseMoney(raw)
  return Number.isFinite(v) && v > 0 ? v : undefined
}

/**
 * Lê a correção dita na forma declarativa. `null` quando a frase não é
 * claramente isso — e aí ela segue o caminho de sempre.
 */
export function parseSpokenCorrection(
  message: string,
  caps: AssistantCapabilities,
  today: string,
): EditRequest | null {
  const t = message.toLowerCase()
  if (VERBO_DE_REGISTRO.test(t)) return null

  const hints: EditRequest['hints'] = {}
  const quando = findDate(t, today)
  if (quando?.kind === 'date') hints.date = quando.date
  else if (quando?.kind === 'period') { hints.from = quando.from; hints.to = quando.to }
  const novoNao = t.match(NOVO_E_NAO_ANTIGO)
  const cat = t.match(CATEGORIA_TROCADA)
  const troca = novoNao || cat || t.match(COPULA_COM_VALOR)
  const nome = troca ? nomeDaCorrecao(t.slice(0, troca.index), today) : undefined
  if (nome) {
    hints.text = nome
    hints.textRequired = true
  }

  if (cat) {
    const alvo = normalizeName(cat[1])
    const categoria = caps.categories.find(c => normalizeName(c.id) === alvo || normalizeName(c.name) === alvo)
      || caps.categories.find(c => c.id === guessCategory(cat[1], 'expense'))
      || caps.categories.find(c => c.id === guessCategory(cat[1], 'income'))
    if (!categoria) return null
    const dito = t.match(/\b[oa]\s+(\d+(?:[.,]\d+)*)\s+que\s+eu/i)
    const antigo = valorDe(dito?.[1])
    if (antigo !== undefined) hints.amount = antigo
    // O nome antigo ("não de MERCADO") identifica o lançamento tanto quanto o apelido.
    if (!hints.text) hints.text = cat[2].toLowerCase()
    return { field: 'category', value: categoria.id, hints }
  }

  if (novoNao) {
    const novo = valorDe(novoNao[1])
    const antigo = valorDe(novoNao[2])
    if (novo === undefined || antigo === undefined || novo === antigo) return null
    return { field: 'amount', value: novo, hints: { ...hints, amount: antigo } }
  }
  const naoNovo = t.match(NAO_ANTIGO_NOVO)
  if (naoNovo) {
    const antigo = valorDe(naoNovo[1])
    const novo = valorDe(naoNovo[2])
    if (novo === undefined || antigo === undefined || novo === antigo) return null
    return { field: 'amount', value: novo, hints: { ...hints, amount: antigo } }
  }
  const disse = t.match(DISSE_ANTIGO_ERA_NOVO)
  if (disse) {
    const antigo = valorDe(disse[1])
    const novo = valorDe(disse[2])
    if (novo === undefined || antigo === undefined || novo === antigo) return null
    return { field: 'amount', value: novo, hints: { ...hints, amount: antigo } }
  }
  // "na verdade" sozinho corrige o que está na TELA; para mexer no histórico
  // precisa apontar para algo já dito ("aquele", "o de ontem", "o do mercado").
  const naVerdade = t.match(NA_VERDADE_NOVO)
  if (naVerdade && REFERENCIA.test(t)) {
    const novo = valorDe(naVerdade[1] ?? naVerdade[2])
    return novo === undefined ? null : { field: 'amount', value: novo, hints }
  }
  const contesta = t.match(CONTESTA_SEM_ALVO)
  if (contesta) {
    const novo = valorDe(contesta[1])
    return novo === undefined ? null : { field: 'amount', value: novo, hints, ask: true }
  }
  // "Aquele gasto de 120 no bar era LAZER MESMO": confirmação de categoria,
  // nunca um gasto novo de R$ 120.
  const confirma = REFERENCIA.test(t) ? t.match(/\b(?:era|foi|[ée])\s+(?:de\s+|d[oa]\s+)?([a-zà-úçãõ][\wçãõáéíóúâê]*)\s+mesmo\b/i) : null
  if (confirma) {
    const alvo = normalizeName(confirma[1])
    const categoria = caps.categories.find(c => normalizeName(c.id) === alvo || normalizeName(c.name) === alvo)
    if (categoria) {
      const valor = t.match(/\b(?:gasto|despesa|receita|lan[çc]amento|compra)\s+de\s+(?:r\$\s*)?(\d+(?:[.,]\d+)*)/i)
      const lugar = t.match(/\b(?:n[oa]|d[oa])\s+([a-zà-úçãõ][\wçãõáéíóúâê]*)\s+(?:era|foi|[ée])(?![\wÀ-ÿ])/i)
      return { field: 'category', value: categoria.id, confirm: true,
        hints: { ...hints, ...(valorDe(valor?.[1]) ? { amount: valorDe(valor?.[1]) } : {}), ...(lugar ? { text: lugar[1].toLowerCase() } : {}) } }
    }
  }
  // "A feira foi 150", "o cimento ERA 500": sujeito + cópula + valor, sem
  // verbo de registro. Com "era" é correção; com "foi", também pode ser um
  // gasto novo — o orquestrador pergunta. Sem lançamento com esse nome, a
  // frase segue o caminho de registro.
  const simples = t.match(new RegExp(String.raw`^\s*(?:(?:o|a|os|as)\s+)?([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[a-zà-úçãõ][\wçãõáéíóúâê]*){0,2})\s+(foi|era|deu|custou)\s+${VALOR}(?:\s+reais)?(?:\s+mesmo)?\s*[.!]*$`, 'i'))
  if (simples && nome) {
    const novo = valorDe(simples[3])
    if (novo !== undefined) return { field: 'amount', value: novo, hints, loose: true, orNew: simples[2].toLowerCase() !== 'era' }
  }
  return null
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
      if (req.hints.textRequired) return cat === alvo || ` ${desc} `.includes(` ${alvo} `)
      return (desc && (desc.includes(alvo) || alvo.includes(desc))) || cat === alvo
    })
    // Sem nenhum casamento, o texto não estreita nada — mas num pedido `loose`
    // é ele que autoriza a correção, então ali a lista fica vazia de propósito.
    if (casa.length || req.loose || req.hints.textRequired) lista = casa
  }
  return lista
}

/** A ação de correção para um candidato — um campo só, o que foi pedido. */
export function editActionFor(t: Transaction, req: EditRequest) {
  return { kind: 'edit-transaction' as const, transactionId: t.id, [req.field]: req.value }
}
