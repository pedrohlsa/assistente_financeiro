// EXPLICABILIDADE — o assistente diz por que fez o que fez, em português.
//
// Um app que decide sozinho e não sabe explicar não é adaptativo, é opaco. Se
// o usuário não pode perguntar "por que você colocou essa categoria?", a única
// coisa que ele pode fazer com um palpite errado é desconfiar de todos.
//
// Três regras que valem para tudo aqui:
//
// 1. RESPOSTA, NUNCA AÇÃO. Explicar não registra, não corrige e não muda
//    configuração. O retorno é texto — o orquestrador o devolve em `mode:
//    'answer'` e nenhum botão de confirmação nasce daqui.
// 2. LOCAL E DETERMINÍSTICO. Tudo sai do estado do aparelho. Nenhuma dessas
//    perguntas chega perto da IA remota: uma explicação inventada sobre o
//    raciocínio do app seria pior que nenhuma explicação.
// 3. LINGUAGEM, NÃO PLACAR. Peso, confiança e meia-vida existem no modelo
//    porque a decisão precisa deles. O usuário recebe "você já lançou isso 4
//    vezes nessa categoria, a última em 12/07" — não uma tela de scores.

import type { AppState, ParsedAction } from '../models/types'
import { catById } from '../data/categories'
import { fmtBRL } from '../utils/format'
import { brDate } from './dates'
import { sentenceCase } from '../utils/text'
import { adaptiveEnabled, buildPersonalModel } from './personalModel'
import { categoryDecision } from './learning'

/** Minúsculas e sem acento — o usuário digita "por quê", "porque" e "pq". */
const norm = (s: string) =>
  s.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\bpq\b/g, 'por que').replace(/\bvc\b/g, 'voce').replace(/\bta\b/g, 'esta')

const PORQUE = String.raw`(?:por\s*qu[e]|porqu[e]|por\s*qu\b)`

const RE_CATEGORIA = new RegExp(`${PORQUE}[^?]*\\b(?:categoria|classific|catalog)`)
/**
 * "por que você colocou isso?" também pergunta pela categoria — mas
 * "por que você colocou 100?" pergunta pelo VALOR, e responder sobre categoria
 * seria responder outra coisa. Sem número na frase o pedido é o primeiro.
 */
const RE_CATEGORIA_ALT = new RegExp(`^(?![^?]*\\d)[^?]*${PORQUE}[^?]*\\b(?:colocou|escolheu|botou|poe|pos|marcou)\\b`)
const RE_VALOR = new RegExp(`${PORQUE}[^?]*\\b(?:estranho|estranha|fora do|acima|abaixo|avisou|aviso|alerta|alertou|suspeit)`)
const RE_APRENDEU = /\b(?:o que|que)\s+(?:voce|vc|tu)?\s*(?:ja\s+)?(?:aprendeu|sabe|guardou|descobriu)\s+(?:sobre|de)\s+mim\b|\bo que voce aprendeu\b|\bque voce sabe sobre mim\b/
/**
 * "Quantas vezes eu fiz isso?" pergunta pelo histórico. "Quantas vezes eu
 * preciso trabalhar pra pagar isso?" pergunta outra coisa — responder "me diga
 * o nome do lugar" seria responder a pergunta errada.
 */
const RE_QUANTAS = /\bquantas?\s+vezes\b(?![^?]*\b(?:preciso|precisa|tenho que|teria que|vou ter|falta|faltam)\b)/
/**
 * "Quantas vezes eu fui NO BAR": o nome já está na pergunta, e contar no
 * histórico é CONSULTA. Pedir "me diga o nome do lugar" a quem acabou de dizer
 * o lugar é responder sem ter lido a frase. Só "isso", "esse", o período e a
 * proposta na tela ficam aqui.
 */
const NOMEIA_ALVO = /\b(?:no|na|nos|nas|em|com|pro|pra)\s+(?!(?:isso|isto|esse|essa|este|esta|aquilo|aquele|aquela|mes|semana|ano|dia|hoje|ontem)\b)[a-z0-9]{2,}/
/**
 * "de quando" e "desde quando" sozinhos são pergunta sobre um lançamento
 * ("de quando é essa conta?"). Só valem aqui junto de uma palavra do próprio
 * aprendizado.
 */
const RE_PERIODO = /\b(?:qual|que)\s+(?:o\s+)?periodo\b|\b(?:de|desde)\s+quando\b[^?]*\b(?:historico|aprend\w*|voce\s+(?:usa|olha|considera)|dados)\b|\bquanto\s+tempo\s+(?:de\s+)?historico\b/
const RE_PARAR = /\b(?:par[ae]|pare|parar|desativ\w*|desligu?[ae]\w*|nao\s+(?:use|usa|utilize)|deixa\s+de\s+usar|esquec[ae])\b[^?]*\b(?:historico|aprend\w*|sugest\w*|padrao|padroes|meus?\s+dados)\b/
const RE_VOLTAR = /\b(?:volt[ae]\w*|reativ\w*|ligu?[ae]\w*|pode\s+usar)\b[^?]*\b(?:historico|aprend\w*|sugest\w*)\b/

export interface ExplainInput {
  state: AppState
  message: string
  /** Proposta ainda na tela — é sobre ela que "essa categoria" fala. */
  pending?: { action: ParsedAction }[]
  today: string
}

const ONDE_DESLIGA = 'Dá para desligar em Mais → Configurações → Assistente adaptativo. '
  + 'O resto continua igual: eu sigo entendendo suas mensagens, fazendo as contas e respondendo suas perguntas.'

/** Texto da explicação, ou `undefined` quando a mensagem não é uma pergunta destas. */
export function explainRequest(input: ExplainInput): string | undefined {
  const t = norm(input.message)
  const { state, today } = input

  if (RE_PARAR.test(t)) return respostaDesligar(state)
  if (RE_VOLTAR.test(t)) return respostaLigar(state)
  if (RE_APRENDEU.test(t)) return respostaAprendeu(state, today)
  if (RE_PERIODO.test(t)) return respostaPeriodo(state, today)
  if (RE_VALOR.test(t)) return respostaValor(input)
  if (RE_QUANTAS.test(t) && !NOMEIA_ALVO.test(t)) return respostaQuantas(input)
  if (RE_CATEGORIA.test(t) || RE_CATEGORIA_ALT.test(t)) return respostaCategoria(input)
  return undefined
}

// ---------------------------------------------------------------------------

const alvo = (input: ExplainInput): ParsedAction | undefined => {
  const money = (input.pending || []).filter(p => p.action.kind === 'income' || p.action.kind === 'expense')
  return money[money.length - 1]?.action
}

const entidade = (a: any): string => String(a?.description || a?.origin || '').trim()

function respostaCategoria(input: ExplainInput): string {
  const { state, today } = input
  const a: any = alvo(input)
  if (!a) {
    return 'Me diga sobre qual lançamento — se a proposta ainda estiver na tela eu explico de onde saiu a categoria dela. '
      + 'Em geral eu uso duas coisas: as palavras da mensagem e, quando você já classificou aquilo antes, o seu próprio histórico.'
  }
  const nome = (id?: string) => (id ? catById(state.categories, id).name : '—')
  const texto = entidade(a)

  if (!adaptiveEnabled(state)) {
    return `Coloquei ${nome(a.category)} pelas palavras da mensagem — o aprendizado com o seu histórico está desligado, `
      + 'então eu não olhei como você classificou isso antes. Se quiser trocar, é só tocar em Editar no card.'
  }

  // CUIDADO: a ação que chega aqui é a que já está na tela, com a categoria
  // APLICADA. Reavaliar a decisão sobre ela devolvia "não mudei nada" — e a
  // explicação saía dizendo que a categoria veio das palavras da mensagem
  // justamente quando ela tinha vindo do histórico. O que responde "usei o seu
  // histórico?" é comparar o padrão com o que está proposto, não repetir a
  // decisão sobre um campo que ela mesma preencheu.
  const p = categoryDecision(state, a, today).pattern
  const veioDoHistorico = !!p && p.value === a.category
    && (p.strength === 'strong' || p.strength === 'overriding')

  if (veioDoHistorico && p) {
    const quando = p.lastSeenAt ? `, a última em ${brDate(p.lastSeenAt)}` : ''
    return `Você já lançou ${sentenceCase(texto)} ${p.sampleSize} ${p.sampleSize === 1 ? 'vez' : 'vezes'} em ${nome(p.value)}${quando}.`
      + '\n\nComo você não disse a categoria nesta mensagem, segui o seu histórico — quem classifica o seu dinheiro é você. '
      + 'Se desta vez for diferente, é só tocar em Editar no card.'
  }

  if (p) {
    return `Coloquei ${nome(a.category)} pelas palavras da mensagem. Você já lançou ${sentenceCase(texto)} em ${nome(p.value)} `
      + `${p.sampleSize} ${p.sampleSize === 1 ? 'vez' : 'vezes'}, mas ainda não o bastante para eu discordar do que a mensagem diz — `
      + 'uma ocorrência isolada eu não transformo em regra. Se você lançar assim mais algumas vezes, eu passo a sugerir sozinho.'
  }
  return `Coloquei ${nome(a.category)} pelas palavras da mensagem. Ainda não tenho histórico seu com ${sentenceCase(texto) || 'esse nome'} `
    + 'para sugerir outra coisa. Se você trocar no card, eu aprendo com a sua correção.'
}

function respostaValor(input: ExplainInput): string {
  const { state, today } = input
  const a: any = alvo(input)
  if (!a?.category) {
    return 'Eu comparo cada lançamento com os seus últimos lançamentos do MESMO tipo e da MESMA categoria — '
      + 'o normal do combustível não diz nada sobre o normal do aluguel. Quando o valor fica muito longe dessa faixa, eu aviso. '
      + 'Aviso e nada mais: o dia fora da curva existe, e travar o registro seria pior que o erro de digitação.'
  }
  const perfil = buildPersonalModel(state, today).amountProfile(a.kind, a.category)
  const nome = catById(state.categories, a.category).name
  if (!perfil) {
    return `Ainda não tenho lançamentos suficientes em ${nome} para saber qual é o seu normal, então não avisei nada sobre esse valor. `
      + 'Sem base, alarmar seria chute.'
  }
  return `Nos seus ${perfil.sampleSize} últimos lançamentos de ${nome} (de ${brDate(perfil.from)} a ${brDate(perfil.to)}), `
    + `o valor fica perto de ${fmtBRL(perfil.median)}. Este está bem longe disso — quase sempre é um zero a mais ou a menos.\n\n`
    + 'É só um aviso: se o valor estiver certo, confirme normalmente.'
}

function respostaQuantas(input: ExplainInput): string {
  const { state, today } = input
  const a: any = alvo(input)
  const texto = entidade(a)
  if (!texto) {
    return 'Me diga o nome do lugar ou do lançamento ("quantas vezes eu gastei no Zé da esquina?") que eu conto no seu histórico.'
  }
  const model = buildPersonalModel(state, today)
  const r = model.timesSeen(texto, a.kind)
  if (!r.count) return `Não encontrei nenhum lançamento anterior com ${sentenceCase(texto)} no seu histórico.`
  const cat = r.category ? ` — quase sempre em ${catById(state.categories, r.category).name}` : ''
  const quando = r.lastSeenAt ? `, e a última foi em ${brDate(r.lastSeenAt)}` : ''
  return `Você lançou ${sentenceCase(texto)} ${r.count} ${r.count === 1 ? 'vez' : 'vezes'}${cat}${quando}.`
}

function respostaPeriodo(state: AppState, today: string): string {
  if (!adaptiveEnabled(state)) {
    return 'Nenhum: o aprendizado com o seu histórico está desligado. Eu respondo suas perguntas com os números do mês e do período que você pedir, '
      + 'mas não uso o passado para adivinhar categoria nem para montar sugestão.'
  }
  const m = buildPersonalModel(state, today)
  if (!m.sample.total) {
    return 'Ainda não tenho histórico para usar. Assim que você registrar algumas coisas, eu passo a olhar os seus lançamentos mais recentes.'
  }
  return `Eu olho os seus lançamentos mais recentes: hoje são ${m.sample.total}, de ${brDate(m.sample.from!)} a ${brDate(m.sample.to!)}.\n\n`
    + 'O que é recente pesa mais — um lançamento de três meses atrás vale cerca de metade de um de hoje. '
    + 'Mas nada é jogado fora: coisa antiga continua contando, só precisa ter acontecido mais vezes para valer o mesmo. '
    + 'É assim que eu acompanho quando você muda de hábito sem esquecer o que só acontece uma vez por ano.'
}

function respostaAprendeu(state: AppState, today: string): string {
  if (!adaptiveEnabled(state)) {
    return 'Nada — o aprendizado com o seu histórico está desligado nas Configurações. '
      + 'Eu continuo entendendo suas mensagens e fazendo as contas, mas sem usar o seu passado para sugerir categoria ou atalho.'
  }
  const m = buildPersonalModel(state, today)
  if (!m.sample.total) {
    return 'Ainda nada. Eu aprendo só com o que você confirma aqui no aparelho, e por enquanto não há histórico suficiente.\n\n'
      + 'Conforme você for registrando, eu passo a sugerir a categoria que você costuma usar, a manter a grafia que você escreve '
      + 'e a avisar quando um valor foge do seu normal.'
  }

  const linhas: string[] = [
    `Só o que está neste aparelho: ${m.sample.total} lançamentos confirmados por você, de ${brDate(m.sample.from!)} a ${brDate(m.sample.to!)}.`,
  ]

  const cats = m.topCategories('expense', 3).map(c => catById(state.categories, c.id).name)
  if (cats.length) linhas.push(`• Onde você mais gasta: ${cats.join(', ')}.`)
  const lugares = m.frequentPlaces('expense', 3).map(p => sentenceCase(p.text))
  if (lugares.length) linhas.push(`• Nomes que você repete: ${lugares.join(', ')} — eu guardo a grafia do jeito que você escreve.`)
  const receitas = m.topCategories('income', 2).map(c => catById(state.categories, c.id).name)
  if (receitas.length) linhas.push(`• De onde vem o seu dinheiro: ${receitas.join(', ')}.`)

  return `${linhas.join('\n')}\n\n`
    + 'Com isso eu faço três coisas: sugiro a categoria que você costuma usar quando você não diz qual é, '
    + 'mantenho a grafia que você já escreveu para o histórico não se dividir, e aviso quando um valor foge do seu normal.\n\n'
    + 'O que eu NÃO faço: mudar valor, data ou tipo do lançamento, e registrar qualquer coisa sem você confirmar. '
    + `Isso tudo fica no seu aparelho, não é compartilhado com ninguém e some junto se você apagar o histórico. ${ONDE_DESLIGA}`
}

function respostaDesligar(state: AppState): string {
  if (!adaptiveEnabled(state)) {
    return 'O aprendizado com o seu histórico já está desligado. Se quiser religar, é em Mais → Configurações → Assistente adaptativo.'
  }
  return 'Combinado — mas essa chave é sua, eu não mexo em configuração sozinho.\n\n'
    + `${ONDE_DESLIGA}\n\n`
    + 'Desligar não apaga nem altera nada do que já está registrado: só para de usar o passado para sugerir categoria, '
    + 'manter grafia e montar atalhos.'
}

function respostaLigar(state: AppState): string {
  if (adaptiveEnabled(state)) {
    return 'Ele já está ligado: eu uso os seus lançamentos confirmados para sugerir categoria, manter a sua grafia e avisar sobre valor fora do normal. '
      + 'Nada é registrado sem você confirmar.'
  }
  return 'Você liga em Mais → Configurações → Assistente adaptativo. A chave é sua — eu não mexo em configuração sozinho.\n\n'
    + 'Assim que ligar, eu volto a usar os seus lançamentos confirmados para sugerir categoria e manter a grafia que você escreve.'
}
