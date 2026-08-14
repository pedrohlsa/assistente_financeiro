// O que o app aprende com o PRÓPRIO usuário.
//
// Tudo aqui é DERIVADO do histórico que já existe em `state.transactions`: não
// há campo novo, migração nem armazenamento paralelo. É a mesma decisão do
// journal por diferença de estado — dado derivado não desincroniza, backup
// antigo funciona sem conversão, e apagar o histórico apaga o aprendizado
// junto, que é o comportamento que o usuário espera.
//
// Duas coisas são aprendidas:
//
// 1. VOCABULÁRIO. A lista de palavras-chave de categoria é genérica e sempre
//    vai errar em nome de lugar ("Zé da esquina", "posto do Tião"). O histórico
//    é dele: se já classificou aquilo três vezes, o app tem a resposta. E
//    quando o histórico CONTRADIZ a lista genérica de forma consistente, quem
//    manda é o histórico — foi o usuário que corrigiu, então ele já disse o que
//    quer.
//
// 2. ORDEM DE GRANDEZA. Quem lança R$ 300 por dia há dez dias e digita R$ 3.000
//    quase certamente pôs um zero a mais. O app AVISA e deixa confirmar: o dia
//    excepcional existe, e bloquear seria pior que o erro.
//
// Nada aqui grava coisa alguma. Aprender muda o que é PROPOSTO, e a proposta
// continua precisando do botão Confirmar (regra 8).

import type { AppState, ParsedAction, Transaction } from '../models/types'
import { fmtBRL } from '../utils/format'
import { normalizeName } from '../utils/text'

/** Janela do aprendizado: recente o bastante para refletir a vida de hoje. */
const MAX_TRANSACOES = 500

/** Repetições mínimas para uma palavra virar regra. Uma só é ruído. */
const MIN_PARA_APRENDER = 2
/** Para CONTRARIAR a lista genérica a evidência precisa ser mais forte. */
const MIN_PARA_CONTRARIAR = 3
const MAIORIA = 0.6
const MAIORIA_PARA_CONTRARIAR = 0.75

/** Palavras curtas ou funcionais não identificam nada. */
const IRRELEVANTES = new Set([
  'de', 'do', 'da', 'no', 'na', 'em', 'com', 'para', 'pra', 'por',
  'um', 'uma', 'uns', 'umas', 'os', 'as', 'meu', 'minha', 'seu', 'sua',
])

const tokens = (texto: string): string[] =>
  normalizeName(texto)
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !IRRELEVANTES.has(w))

const recentes = (state: AppState): Transaction[] =>
  (state.transactions || []).slice(0, MAX_TRANSACOES)

/**
 * Categoria que o usuário costuma dar para as palavras deste texto.
 *
 * `forte` diz se a evidência basta para CONTRARIAR a lista genérica — o chamador
 * decide, porque preencher um vazio e discordar de um palpite são coisas
 * diferentes.
 */
export function learnedCategory(
  state: AppState,
  texto: string,
  tipo: 'income' | 'expense',
): { category: string; forte: boolean } | undefined {
  const alvo = tokens(texto)
  if (!alvo.length) return undefined

  // token → categoria → quantas vezes
  const contagem = new Map<string, Map<string, number>>()
  for (const t of recentes(state)) {
    if (t.type !== tipo || !t.category || !t.description) continue
    for (const w of tokens(t.description)) {
      if (!alvo.includes(w)) continue
      const porCat = contagem.get(w) || new Map<string, number>()
      porCat.set(t.category, (porCat.get(t.category) || 0) + 1)
      contagem.set(w, porCat)
    }
  }
  if (!contagem.size) return undefined

  // A palavra mais usada é a que melhor identifica o lançamento.
  let melhor: { category: string; n: number; total: number } | undefined
  for (const porCat of contagem.values()) {
    let total = 0
    let top: { category: string; n: number } | undefined
    for (const [cat, n] of porCat) {
      total += n
      if (!top || n > top.n) top = { category: cat, n }
    }
    if (!top) continue
    if (!melhor || top.n > melhor.n) melhor = { ...top, total }
  }
  if (!melhor) return undefined

  const proporcao = melhor.n / melhor.total
  if (melhor.n < MIN_PARA_APRENDER || proporcao < MAIORIA) return undefined
  return {
    category: melhor.category,
    forte: melhor.n >= MIN_PARA_CONTRARIAR && proporcao >= MAIORIA_PARA_CONTRARIAR,
  }
}

/**
 * Aplica o vocabulário aprendido à ação, sem nunca inventar categoria que não
 * exista para o usuário.
 */
export function withLearnedCategory(state: AppState, action: ParsedAction): ParsedAction {
  if (action.kind !== 'income' && action.kind !== 'expense') return action
  const a: any = action
  const texto = String(a.description || a.origin || '')
  if (!texto) return action

  let out: any = action

  // A grafia dele ganha da que ele digitou com pressa.
  if (a.description) {
    const grafia = canonicalDescription(state, a.description, action.kind)
    if (grafia) out = { ...out, description: grafia }
  }

  const aprendido = learnedCategory(state, texto, action.kind)
  if (!aprendido) return out
  if (!(state.categories || []).some(c => c.id === aprendido.category)) return out

  // Vazio: qualquer aprendizado serve. Já preenchido pela lista genérica: só
  // troca com evidência forte — o usuário corrigiu aquilo várias vezes.
  if (!a.category) return { ...out, category: aprendido.category }
  if (a.category !== aprendido.category && aprendido.forte) {
    return { ...out, category: aprendido.category }
  }
  return out
}

/**
 * A grafia que o usuário já usou para este mesmo lugar.
 *
 * Ele escreveu "Zé da esquina" três vezes e agora digitou sem acento, no
 * celular, com pressa. Sem isto a lista de movimentações fica com "Ze da
 * esquina" ao lado de "Zé da esquina" parecendo dois lugares diferentes — e o
 * próprio aprendizado de categoria enfraquece, porque o histórico se divide.
 *
 * Só entra quando o texto é O MESMO ignorando acento e caixa. Nada de
 * aproximação: trocar a descrição por algo que o usuário não escreveu seria
 * inventar.
 */
export function canonicalDescription(
  state: AppState,
  texto: string,
  tipo: 'income' | 'expense',
): string | undefined {
  const alvo = normalizeName(texto)
  if (alvo.length < 3) return undefined

  const contagem = new Map<string, number>()
  for (const t of recentes(state)) {
    if (t.type !== tipo || !t.description) continue
    if (normalizeName(t.description) !== alvo) continue
    contagem.set(t.description, (contagem.get(t.description) || 0) + 1)
  }
  if (!contagem.size) return undefined

  let melhor: { texto: string; n: number } | undefined
  for (const [grafia, n] of contagem) {
    if (!melhor || n > melhor.n) melhor = { texto: grafia, n }
  }
  if (!melhor || melhor.n < MIN_PARA_APRENDER) return undefined
  // Já está escrito igualzinho: nada a fazer.
  return melhor.texto === texto ? undefined : melhor.texto
}

/**
 * Sugestões da tela do assistente, montadas com a vida DESTE usuário.
 *
 * A lista fixa por perfil é o ponto de partida, não a resposta: quem tem uma
 * meta chamada "Moto" quer ver "quanto falta pra minha moto", e quem lança
 * "Mercado" toda semana ganha mais com um atalho para isso do que com um
 * exemplo genérico. O atalho vem SEM valor de propósito — o assistente pergunta
 * quanto foi, que é a conversa mais curta possível.
 *
 * As sugestões da lista fixa nunca somem: elas ensinam o que dá para fazer.
 */
export function personalSuggestions(state: AppState, base: string[]): string[] {
  const minhas: string[] = []

  const meta = (state.goals || []).find(g => !g.done && g.name)
  if (meta) minhas.push(`Quanto falta pra minha ${meta.name.toLowerCase()}?`)

  // O gasto que ele mais repete — vira atalho de registro.
  const contagem = new Map<string, number>()
  for (const t of recentes(state)) {
    if (t.type !== 'expense' || !t.description) continue
    contagem.set(t.description, (contagem.get(t.description) || 0) + 1)
  }
  let campeao: { texto: string; n: number } | undefined
  for (const [texto, n] of contagem) {
    if (!campeao || n > campeao.n) campeao = { texto, n }
  }
  if (campeao && campeao.n >= MIN_PARA_CONTRARIAR) {
    minhas.push(`gastei no ${campeao.texto.toLowerCase()}`)
  }

  const vistas = new Set(minhas.map(s => normalizeName(s)))
  return [...minhas, ...base.filter(s => !vistas.has(normalizeName(s)))]
}

// ---------------------------------------------------------------------------
// Ordem de grandeza
// ---------------------------------------------------------------------------

/** Amostra mínima para o "padrão" do usuário significar alguma coisa. */
const MIN_AMOSTRA = 6
/** Quantas vezes acima da mediana já é quase certamente um zero a mais. */
const FATOR = 6

const mediana = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const meio = Math.floor(s.length / 2)
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2
}

/**
 * Aviso quando o valor está muito fora do que o usuário costuma lançar.
 *
 * Compara com lançamentos do MESMO tipo e da MESMA categoria: o padrão de
 * combustível não diz nada sobre o padrão de aluguel. Devolve `undefined`
 * quando não há amostra suficiente — sem base, calar é melhor que alarmar.
 */
export function outOfPatternWarning(state: AppState, action: ParsedAction): string | undefined {
  if (action.kind !== 'income' && action.kind !== 'expense') return undefined
  const a: any = action
  const valor = Number(a.amount)
  if (!(valor > 0)) return undefined

  const iguais = recentes(state)
    .filter(t => t.type === action.kind && (!a.category || t.category === a.category))
    .map(t => t.amount)
    .filter(v => v > 0)
  if (iguais.length < MIN_AMOSTRA) return undefined

  const m = mediana(iguais)
  if (!(m > 0)) return undefined

  if (valor >= m * FATOR) {
    return `Bem acima do seu normal — você costuma lançar perto de ${fmtBRL(m)}. Confere se não sobrou um zero.`
  }
  if (valor * FATOR <= m) {
    return `Bem abaixo do seu normal — você costuma lançar perto de ${fmtBRL(m)}. Confere se não faltou um dígito.`
  }
  return undefined
}
