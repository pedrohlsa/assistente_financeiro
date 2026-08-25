// TOLERÂNCIA A ERRO DE DIGITAÇÃO — estreita, fechada e reversível.
//
// O defeito conhecido: "gsatei 190 de cimento" não casava verbo nenhum, então
// não havia ação — e o resto da frase, que estava perfeito, se perdia junto.
//
// O que este módulo NÃO é: um autocorretor. Corrigir texto livre num app de
// dinheiro é perigoso de um jeito específico — "mercdao" pode ser o nome que o
// usuário deu ao lugar, "gasosa" é como o motorista chama gasolina, e trocar o
// nome de um estabelecimento por outro parecido divide o histórico dele em
// dois (regra 41 do CLAUDE.md: ou o texto é o mesmo, ou não é o mesmo lugar).
//
// Cinco travas, todas necessárias:
//
//   1. DICIONÁRIO FECHADO. Só vocabulário ESTRUTURAL do assistente: verbo
//      financeiro, palavra de tempo, unidade, palavra de pergunta e conector.
//      Substantivo de conteúdo (cimento, mercado, padaria) NUNCA entra.
//   2. NUNCA PERTO DE DÍGITO. "12x", "3200", "R$ 50" ficam intocados.
//   3. NUNCA NO VOCABULÁRIO DELE. Palavra que aparece nas categorias, cartões,
//      metas ou no histórico do próprio usuário é dele — não se corrige.
//   4. DISTÂNCIA BAIXA E VENCEDOR ÚNICO. Empate entre dois candidatos = não
//      corrige. Falha FECHADA.
//   5. O ORIGINAL É PRESERVADO. `corrections` diz o que mudou, e quem chama só
//      usa o texto reparado se ele DESTRAVAR alguma coisa.

import type { AppState } from '../../models/types'
import { normalizeName } from '../../utils/text'
import { NUMBER_WORD_RE } from '../numbers'

/**
 * Vocabulário estrutural. Cada palavra aqui é do ASSISTENTE, não do usuário:
 * são os verbos, tempos, unidades e conectores que o parser precisa reconhecer
 * para entender a frase. Acrescentar substantivo de conteúdo a esta lista é o
 * caminho mais curto para o app renomear o lugar onde a pessoa almoça.
 */
const ESTRUTURAL: string[] = [
  // verbos de dinheiro
  'gastei', 'gastou', 'gasto', 'gastar', 'paguei', 'pagou', 'pagar', 'pago',
  'recebi', 'recebeu', 'receber', 'recebo', 'ganhei', 'ganhou', 'ganhar',
  'comprei', 'comprou', 'comprar', 'guardei', 'guardou', 'guardar', 'guardo',
  'separei', 'separar', 'abasteci', 'abastecer', 'coloquei', 'colocar',
  'botei', 'rodei', 'rodou', 'rodar', 'andei', 'dirigi', 'trabalhei',
  'trabalhar', 'faturei', 'faturar', 'lucrei', 'lucrar', 'vendi', 'vender',
  'tirei', 'tirar', 'depositei', 'depositar', 'investi', 'investir',
  'parcelei', 'parcelar', 'passei', 'troquei', 'trocar', 'instalei',
  'sobrou', 'sobrar', 'entrou', 'entrar', 'saiu', 'custou', 'custar',
  'registrar', 'registra', 'apagar', 'desfazer', 'cancelar', 'corrigir',
  // tempo
  'hoje', 'ontem', 'anteontem', 'amanha', 'semana', 'semanas', 'meses',
  'passado', 'passada', 'proximo', 'proxima', 'ultimo', 'ultimos', 'ultima',
  'ultimas', 'atras', 'agora', 'manha', 'tarde', 'noite', 'ontem',
  'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  // unidades
  'reais', 'real', 'conto', 'contos', 'litros', 'litro', 'horas', 'hora',
  'viagens', 'viagem', 'corridas', 'corrida', 'parcelas', 'parcela',
  'vezes', 'hodometro', 'quilometros',
  // pergunta e intenção
  'quanto', 'quantos', 'quantas', 'qual', 'quais', 'quando', 'onde', 'como',
  'porque', 'quero', 'queria', 'preciso', 'posso', 'consigo', 'devo',
  'comparado', 'comparando', 'media', 'total', 'maior', 'menor', 'melhor',
  'pior', 'diferenca', 'tirando', 'exceto', 'somente', 'apenas',
  // conectores comuns em frase de registro
  'tambem', 'depois', 'entao', 'mesmo', 'ainda', 'menos', 'mais',
  // Palavras que o app ve o tempo todo E que ficam a UMA letra de outra do
  // dicionario. Estar aqui as torna intocaveis: "paguei 355 nas CONTAS" virava
  // "nas CONTOS" (a giria de reais), e o valor por extenso "CENTO e cinquenta"
  // virava "CONTO e cinquenta" — o lancamento de 150 sumia.
  'conta', 'contas', 'cento', 'centos', 'salario', 'aluguel', 'luz', 'agua',
  'gasolina', 'mercado', 'casa', 'carro', 'moto', 'meta', 'metas', 'saldo',
  'banco', 'cartao', 'cartoes', 'fatura', 'faturas', 'reserva', 'renda',
]

const DICIONARIO = new Set(ESTRUTURAL)

/** Comprimento mínimo do token que pode ser corrigido. */
const MIN_LEN = 4
/** A partir daqui uma distância 2 é aceitável. */
const LEN_PARA_DIST_2 = 8

export interface TypoCorrection {
  from: string
  to: string
  at: number
  /** O alvo e verbo ou palavra de tempo? So esses justificam refazer a leitura. */
  estrutural: boolean
}

export interface RepairedText {
  text: string
  corrections: TypoCorrection[]
  changed: boolean
}

/**
 * Damerau-Levenshtein com teto: para de contar assim que passa de `max`.
 * O teto não é otimização — é o que garante que uma palavra longa e diferente
 * não seja "corrigida" para outra por acaso.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2: number[] = []
  let prev: number[] = []
  let cur: number[] = []
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur = [i]
    let melhor = i
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + custo)
      // Transposição: "gsatei" → "gastei" é UMA troca, não duas.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? Infinity) + 1)
      }
      cur[j] = v
      if (v < melhor) melhor = v
    }
    if (melhor > max) return max + 1
    prev2.length = 0
    prev2.push(...prev)
    prev = cur
  }
  return prev[b.length]
}

/**
 * Palavras do PRÓPRIO usuário. Categoria, cartão, meta e o que ele já escreveu
 * em descrição ou origem: nada disso pode ser "corrigido" — é o nome que ele
 * escolheu, e trocá-lo por um parecido divide o histórico dele em dois.
 */
function vocabularioDoUsuario(state: AppState): Set<string> {
  const out = new Set<string>()
  const add = (s?: string | null) => {
    for (const w of normalizeName(s || '').split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w)
  }
  for (const c of state.categories || []) add(c.name)
  for (const c of state.cards || []) { add(c.name); add(c.institution) }
  for (const g of state.goals || []) add(g.name)
  for (const r of state.recurring || []) { add(r.name); add(r.origin) }
  // O histórico é grande; os mais recentes bastam para proteger o vocabulário
  // vivo dele sem varrer anos de lançamento a cada mensagem.
  const txs = (state.transactions || []).slice(-400)
  for (const t of txs) { add(t?.description); add(t?.origin) }
  return out
}

/**
 * Verbos no PASSADO. Servem de desempate: numa frase com valor, "gasti 60" é o
 * relato de um fato consumado, então `gastei` ganha de `gasto`. É o "contexto
 * suficiente" que a correção exige — sem ele, os dois candidatos empatam e
 * nada é corrigido.
 */
const PASSADO = new Set([
  'gastei', 'paguei', 'recebi', 'ganhei', 'comprei', 'guardei', 'separei',
  'abasteci', 'coloquei', 'botei', 'rodei', 'andei', 'trabalhei', 'faturei',
  'lucrei', 'vendi', 'tirei', 'depositei', 'investi', 'parcelei', 'passei',
  'troquei', 'instalei', 'sobrou', 'entrou', 'saiu', 'custou',
])

/**
 * Melhor candidato do dicionário, ou `null` quando não há nada perto o
 * bastante — ou quando o empate não se desfaz.
 *
 * Desempate, nesta ordem: (1) verbo no passado, quando a frase tem valor;
 * (2) o candidato mais CURTO, porque letra repetida ("quantoo") é o erro mais
 * comum. Sem desempate possível, não corrige: falha fechada.
 */
function melhorCandidato(token: string, temValor: boolean): string | null {
  const max = token.length >= LEN_PARA_DIST_2 ? 2 : 1
  let melhorDist = max + 1
  let candidatos: string[] = []
  for (const alvo of DICIONARIO) {
    if (Math.abs(alvo.length - token.length) > max) continue
    const d = editDistance(token, alvo, max)
    if (d > max) continue
    if (d < melhorDist) { melhorDist = d; candidatos = [alvo] }
    else if (d === melhorDist && !candidatos.includes(alvo)) candidatos.push(alvo)
  }
  if (!candidatos.length) return null
  if (candidatos.length === 1) return candidatos[0]

  if (temValor) {
    const passados = candidatos.filter(c => PASSADO.has(c))
    if (passados.length === 1) return passados[0]
  }
  const ordenado = [...candidatos].sort((a, b) => a.length - b.length || a.localeCompare(b))
  return ordenado[0].length < ordenado[1].length ? ordenado[0] : null
}

/**
 * Repara o vocabulário ESTRUTURAL da frase. O texto original nunca é perdido:
 * quem chama decide se usa o reparo, e a regra é usar só quando ele destrava
 * alguma coisa.
 */
export function repairStructuralTypos(message: string, state: AppState): RepairedText {
  const protegidas = vocabularioDoUsuario(state)
  const corrections: TypoCorrection[] = []
  // Frase com numero e quase sempre relato de fato consumado: e o contexto que
  // desempata "gasti" entre `gastei` e `gasto`.
  const temValor = /\d/.test(message)

  // A varredura é por TOKEN, com posição preservada: o texto reparado tem que
  // continuar casando com os offsets da segmentação por cláusula.
  const text = message.replace(/[a-zA-ZÀ-ÿ]{3,}/g, (bruto, at: number) => {
    const token = normalizeName(bruto)
    if (token.length < MIN_LEN) return bruto
    // Perto de dígito: "12x", "3200reais", "R$50" nunca são vocabulário.
    const antes = message[at - 1]
    const depois = message[at + bruto.length]
    if ((antes && /\d/.test(antes)) || (depois && /\d/.test(depois))) return bruto
    if (DICIONARIO.has(token)) return bruto
    if (protegidas.has(token)) return bruto
    // Numero por extenso e VALOR, nao vocabulario: "cento", "sete", "vinte" e
    // "cinco" nunca podem ser trocados por palavra parecida.
    if (NUMBER_WORD_RE.test(token)) return bruto

    const alvo = melhorCandidato(token, temValor)
    if (!alvo) return bruto
    corrections.push({ from: bruto, to: alvo, at, estrutural: ehVerboOuTempo(alvo) })
    // Mantém a caixa original da primeira letra: quem escreveu "Gsatei" merece
    // ver "Gastei", não "gastei".
    return /^[A-ZÀ-Þ]/.test(bruto) ? alvo[0].toUpperCase() + alvo.slice(1) : alvo
  })

  return { text, corrections, changed: corrections.length > 0 }
}

/**
 * O alvo da correcao muda a ESTRUTURA da frase (verbo ou tempo)?
 *
 * E esta a distincao que separa um typo que destroi a leitura ("gsatei") de um
 * substantivo que so parece um: um erro no verbo faz o lancamento inteiro se
 * perder; uma palavra parecida no meio da descricao quase nunca e erro.
 */
const TEMPO = new Set([
  'hoje', 'ontem', 'anteontem', 'amanha', 'semana', 'semanas', 'meses',
  'passado', 'passada', 'proximo', 'proxima', 'ultimo', 'ultimos', 'ultima',
  'ultimas', 'atras', 'segunda', 'terca', 'quarta', 'quinta', 'sexta',
  'sabado', 'domingo', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio',
  'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
])

const VERBOS = new Set(ESTRUTURAL.filter(w => PASSADO.has(w)
  || /^(?:gast|pag|receb|ganh|compr|guard|separ|abastec|coloc|rod|trabalh|fatur|lucr|vend|tir|deposit|invest|parcel|troc|sobr|entr|cust)/.test(w)))

export const ehVerboOuTempo = (alvo: string): boolean => VERBOS.has(alvo) || TEMPO.has(alvo)

/** Frase curta que conta ao usuário o que foi lido de outro jeito. */
export function describeRepairs(r: RepairedText): string | null {
  if (!r.changed) return null
  const partes = r.corrections.slice(0, 3).map(c => `"${c.from}" como "${c.to}"`)
  return `Li ${partes.join(', ')}.`
}
