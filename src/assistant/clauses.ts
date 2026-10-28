// Segmentação da mensagem em CLÁUSULAS, com posição preservada.
//
// A falha estrutural da arquitetura antiga era tratar a mensagem como uma coisa
// só: achar uma ação encerrava a interpretação e o resto se perdia. Aqui cada
// trecho é analisado separadamente e carrega o próprio veredito — é isso que
// permite dizer "entendi esta parte, não entendi aquela" em vez de chutar.

import type { ParsedAction } from '../models/types'
import type { AssistantConfidence, AssistantIntent } from './contracts'
import { looksRecurring, parseNaturalFull } from '../services/nlp'
import { findAllDates, findUnresolvedTemporalHint, dateLabel } from './dates'
import type { DateResolution } from './dates'
import { normalizeNumberWords } from './numbers'
import { parseMoney, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { suspicionReasons } from './semantic/confidence'
import type { SuspicionReason } from './semantic/confidence'

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
  ambiguity?: { question: string; field?: string; options: { label: string; actions: ParsedAction[]; reply?: string }[] }
  /** Data ambígua: precisa de escolha antes de virar lançamento. */
  dateAmbiguity?: { question: string; options: { label: string; value: string }[] }
  /**
   * Expressão temporal reconhecida que NÃO pode datar um fato já ocorrido.
   * Existe para que nada seja descartado em silêncio: quem recebe isto tem que
   * perguntar ou explicar, jamais gravar com a data de hoje.
   */
  temporal?: TemporalSignal
  /**
   * Intencao declarada: o verbo de dinheiro esta no INFINITIVO, governado por
   * modal ("vou gastar", "posso guardar", "pretendo colocar"). O movimento foi
   * removido; quem recebe isto EXPLICA em vez de registrar.
   */
  intention?: boolean
  /**
   * Leituras locais DESCARTADAS por baixa confiança (ver semantic/confidence.ts).
   * A cláusula que as tinha fica em aberto — é isso que deixa a consulta local e
   * o modelo remoto participarem em vez de a ação errada fechar a frase.
   */
  suspicious?: SuspicionReason[]
  /** Valor dito de uma corrida explicitamente não recebida: não é dinheiro faltando. */
  unpaidRideAmount?: number
}

export interface TemporalSignal {
  /** Futuro, intervalo sem dia certo ou expressão de calendário impossível. */
  kind: 'future' | 'period' | 'invalid' | 'unknown'
  /** Trecho literal que o usuário escreveu ("daqui a 3 dias", "mês passado"). */
  text: string
  label: string
  /** Data calculada, quando a expressão aponta para um dia único. */
  date?: string
  /** Janela do período, quando não há dia único. */
  from?: string
  to?: string
  /** Contada a partir de hoje ("daqui a 3 dias") em vez de dita ("10/08"). */
  relative?: boolean
  /** Período futuro sem um dia exato ("próxima semana", "mês que vem"). */
  imprecise?: boolean
  /** Pergunta pronta para corrigir uma data inválida. */
  question?: string
  /**
   * Verbo no passado + data futura: "gastei 50 daqui a 3 dias". A frase se
   * contradiz, então o assistente PERGUNTA em vez de escolher uma das leituras.
   */
  conflict?: boolean
  /** Intenção declaradamente futura: "vou gastar 50 daqui a 3 dias". */
  plan?: boolean
  /** Ações que a frase descrevia, guardadas para depois da resposta. */
  actions: ParsedAction[]
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
  // Como se digita no celular. Sem estas, "qnto q foi d obra" não era pergunta,
  // e o número do período da frase podia virar lançamento.
  /\b(?:qnto|qnta|qntos|qntas|qnt|qto|qta|qts|qnd|qndo)\b/i,
  /\bcomo\s+(?:est[aáo]|foi|fica|t[aá]|anda|vai)\b/i,
  /\b(?:sobra|sobrou|sobrar[áa]?|resta|restou|restar[áa]?)\b/i,
  /\bd[áa]\s+(?:pra|para)\b/i,
  /\bvai\s+(?:faltar|sobrar|pesar|dar|apertar)\b/i,
  /\b(?:t[ôo]|tou|estou|to)\s+(?:bem|bom|mal|ruim|apertad|indo|gastando|lucrando)/i,
  /\bt[áa]\s+(?:pesad|caro|apertad|ok|tranquil|folgad)/i,
  /\b(?:compensa|vale\s+a\s+pena)\b/i,
  /\bo\s+que\s+(?:voc[êe]|vc)\s+acha\b/i,
  /^\s*e\s+(?:agora|depois|no\s+pr[óo]ximo|mês\s+que\s+vem|m[eê]s\s+que\s+vem)\b/i,
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
  // "Na verdade foi 200" é conserto do que está na tela, não lançamento novo:
  // `foi` é verbo de despesa no parser, e sem isto a frase criava um gasto de
  // R$ 200 do nada.
  /\b(?:na\s+verdade|na\s+real|pensando\s+bem|quis\s+dizer|queria\s+dizer)\b/i,
  /\b(?:errei|me\s+enganei|enganei|foi\s+mal|desculpa)\b/i,
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
  // Qualquer verbo de dinheiro no passado pode ser NEGADO. A lista acima
  // esquecia troquei, instalei, vendi, depositei e outros — e "nao troquei o
  // oleo por 280" registrava a manutencao mesmo assim.
  + '|troquei|instalei|vendi|depositei|investi|apliquei|parcelei|passei|tirei|retirei|faturei|lucrei|andei|dirigi|percorri|entrou|caiu|sobrou|custou'

/**
 * A vírgula depois do "não" é o jeito mais comum de negar em fala real: "não,
 * eu não gastei 190". Exigir espaço logo depois do "não" fazia a frase inteira
 * escapar da guarda e o gasto negado virava lançamento. "Nem" é a outra forma
 * ("nem gastei isso").
 */
const NEGATED_STATEMENT = new RegExp(
  String.raw`^\s*(?:mas\s*,?\s*|e\s*,?\s*|ah\s*,?\s*|olha\s*,?\s*)?(?:n[ãa]o|nem|nunca|jamais)\b[\s,;!]*(?:\S+[\s,]+){0,3}?(?:${NEGATED_VERBS})(?![a-zà-ú])`,
  'i',
)

export const looksNegated = (t: string): boolean => NEGATED_STATEMENT.test(t)

/**
 * Verbo de dinheiro no PASSADO. É o que separa "gastei 50 daqui a 3 dias"
 * (contradição — o usuário afirma um fato consumado numa data que não chegou)
 * de "vou gastar 50 daqui a 3 dias" (plano declarado). As duas situações têm
 * respostas diferentes, e nenhuma delas é gravar na data de hoje.
 */
const PAST_MONEY_VERBS =
  'gastei|gastou|gastamos|paguei|pagou|pagamos|recebi|recebeu|recebemos|ganhei|ganhou|ganhamos|comprei|comprou|compramos|parcelei|passei|abasteci|coloquei|botei|guardei|separei|depositei|investi|apliquei|tirei|retirei|vendi|faturei|lucrei|rodei|andei|dirigi|percorri|trabalhei|fiz|fizemos|troquei|instalei|entrou|caiu|sobrou'

const PAST_STATEMENT = new RegExp(String.raw`\b(?:${PAST_MONEY_VERBS})\b`, 'i')

export const looksPast = (t: string): boolean => PAST_STATEMENT.test(t)

const hasAny = (t: string, list: RegExp[]) => list.some(r => r.test(t))

export const looksLikeQuestion = (t: string): boolean =>
  !hasAny(t, CONVERSATION_PATTERNS) && hasAny(t, QUESTION_PATTERNS)

export const looksLikeCorrection = (t: string): boolean => hasAny(t, CORRECTION_PATTERNS)

/**
 * Frases que SÓ existem para consertar algo já dito. Diferente da lista geral
 * de correção, nenhuma delas cabe num registro de primeira vez: ninguém abre a
 * conversa com "na verdade foi 200".
 *
 * A distinção importa porque a lista geral tem palavras que aparecem em
 * registro legítimo ("comprei uma TROCA de óleo"), e barrar por ela cortaria
 * lançamento de verdade.
 */
const RETRACTION_PATTERNS: RegExp[] = [
  /\b(?:na\s+verdade|na\s+real|pensando\s+bem|quis\s+dizer|queria\s+dizer)\b/i,
  /\b(?:errei|me\s+enganei|enganei|foi\s+mal)\b/i,
  /\bn[ãa]o\s+(?:foi|era)\b/i,
]

export const looksLikeRetraction = (t: string): boolean => hasAny(t, RETRACTION_PATTERNS)

/**
 * O usuário está discordando do que ESTÁ NA TELA.
 *
 * Deliberadamente mais largo que `looksLikeRetraction`, e por isso só pode ser
 * usado quando existe proposta pendente: ali o custo de errar se inverte. Sem
 * proposta, um falso positivo engoliria um registro legítimo — com proposta,
 * ele apenas faz o app perguntar, e o falso NEGATIVO é que é caro: era ele que
 * transformava "não cara, tá errado isso aí" num segundo lançamento enquanto o
 * primeiro continuava confirmável logo acima.
 */
const CONTEST_PATTERNS: RegExp[] = [
  ...RETRACTION_PATTERNS,
  /^\s*n[ãa]o\b/i,
  /\b(?:est[áa]|ta|tah)\s+errad[oa]\b/i,
  /\b(?:errad[oa]|engano|enganado)\b/i,
  /\bn[ãa]o\s+(?:[ée]|eh)\s+(?:isso|assim|bem\s+assim)\b/i,
]

export const contestsProposal = (t: string): boolean => hasAny(t, CONTEST_PATTERNS)

/**
 * Conta que SE REPETE — "pago 90 de internet todo mês", "minha luz é 150 por
 * mês". Isso é PREVISÃO, não movimentação realizada (regra 18): registrar como
 * despesa de hoje inflava o mês com dinheiro que ainda não saiu.
 *
 * O assistente não cadastra recorrência (não existe ação para isso no
 * catálogo), então o certo é não registrar nada e mandar para a tela que
 * cadastra de verdade.
 *
 * A lista mora em `nlp.ts`: este módulo importa aquele, então o contrário seria
 * ciclo, e o parser precisa da mesma checagem para não confundir "todo dia 10"
 * (vencimento) com o resultado do dia do motorista.
 */
export { looksRecurring }

export const looksLikeConversation = (t: string): boolean => hasAny(t, CONVERSATION_PATTERNS)

/**
 * Verbo de dinheiro no INFINITIVO, governado por modal ou intenção.
 *
 * "Vou gastar 80 no mercado", "posso guardar 200?", "pretendo colocar 100 de
 * gasolina" — nenhuma delas afirma um fato consumado, e as três viravam
 * lançamento. As regras temporais só pegavam a variante COM data ("vou gastar
 * 50 daqui a 3 dias"); sem data não havia sinal nenhum e o dinheiro entrava.
 *
 * É a mesma família da regra 33: perguntar não é movimentar dinheiro, e
 * pretender não é ter feito. O verbo no infinitivo é o que identifica a classe
 * inteira — nenhuma lista de verbo conjugado a barra.
 *
 * NÃO zera meta: "quero comprar um celular de 5000 em 6 meses" é justamente
 * como se cria um objetivo de compra, e ali a intenção é o ponto.
 */
// "Vai cair", "vai entrar", "deve entrar" são o FUTURO de quem espera dinheiro:
// o sujeito é o dinheiro, não a pessoa, e por isso não estavam aqui. "Vai cair
// 1800 do aluguel" virava uma DESPESA realizada de 1800 — o leitor sem verbo
// achava o valor e o substantivo, e nada dizia que aquilo ainda não aconteceu.
const MODAIS = 'posso|poderia|devo|deveria|quero|queria|pretendo|penso\\s+em|planejo|vou|vamos|vai|v[ãa]o|irei|iria|ir[áa]|ir[ãa]o|deve|devem|preciso|precisava|tenho\\s+que|tenho\\s+de|d[áa]\\s+pra|d[áa]\\s+para|consigo|gostaria\\s+de|to\\s+querendo|estou\\s+querendo'
const INFINITIVOS_DINHEIRO = 'gastar|pagar|receber|ganhar|comprar|guardar|separar|colocar|botar|abastecer|investir|depositar|tirar|vender|parcelar|juntar|poupar|torrar|meter|trocar|instalar|rodar|trabalhar|faturar|lucrar|aplicar|quitar'
  + '|cair|entrar|pingar|sair|vencer|debitar|descontar|cobrar'
  // "Vou assinar a netflix de 39,90" virava despesa de hoje com a frase inteira
  // como descrição; mandar, transferir e emprestar são o mesmo dinheiro futuro.
  + '|assinar|contratar|financiar|transferir|mandar|enviar|emprestar|doar|alugar'

const INTENCAO = new RegExp(
  String.raw`\b(?:${MODAIS})\s+(?:\S+\s+){0,2}?(?:${INFINITIVOS_DINHEIRO})\b`,
  'i',
)

export const declaresIntention = (t: string): boolean => INTENCAO.test(t)

/** Pedido de apagar um lançamento salvo — o assistente não apaga por conversa. */
export const PEDE_APAGAR = /^\s*(?:por\s+favor\s+)?(?:apaga|apague|apagar|exclui|exclua|excluir|deleta|delete|deletar|remove|remova|remover)\s+(?:o|a|os|as|esse|essa|aquele|aquela|meu|minha)?\s*(?:gasto|despesa|lancamento|lançamento|receita|entrada|registro)s?\b/i

// ---------------------------------------------------------------------------
// Segmentação com offsets
// ---------------------------------------------------------------------------

const COMMAND_VERBS =
  'ganhei|ganhou|recebi|recebeu|faturei|lucrei|entrou|caiu|gastei|gastou|paguei|pagou|comprei|comprou|parcelei|passei|troquei|instalei|abasteci|coloquei|botei|rodei|andei|dirigi|percorri|trabalhei|quero|queria|vou|vamos|vai|pretendo|fiz|guardei|guarda|guardar|separei|separa|separar|depositei|investi|tirei|retirei|sobrou|sobra|vendi|apliquei'

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
  // A âncora de saldo não começa com verbo de comando. Sem esta divisão,
  // parseClause encontra o saldo e retorna antes de registrar a movimentação
  // que o usuário acabou de declarar na mesma frase.
  for (const m of text.matchAll(/\s+e\s+(?=(?:(?:meu|o)\s+)?saldo\b)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  for (const m of text.matchAll(/\s+(?:agora\s+)?(?=(?:(?:meu|o)\s+)?saldo\s*(?:atual|[ée]|:)?\s*(?:r\$\s*)?\d)/gi)) {
    if (/\d/.test(text.slice(0, m.index))) push((m.index || 0) + m[0].length)
  }
  // Ditado sem pontuação: "fiz 20 reais gastei 40 ... furando o pneu foi
  // mais 30" contém fatos separados mesmo sem "e". Sem estes cortes o parser
  // escolhia um único valor e os demais desapareciam dentro da descrição.
  for (const m of text.matchAll(/\s+(?=(?:ganhei|recebi|gastei|paguei|fiz|furando|furou|furei|tocou)\b)/gi)) {
    const prefix = text.slice(0, m.index || 0)
    // Nunca deixe a negação no fragmento anterior: "não gastei" é uma unidade.
    // Nem a pergunta: "quanto gastei de alimentação" era cortado em "quanto" +
    // "gastei de alimentação", e nenhuma das metades tinha resposta.
    if (/\d/.test(prefix) && !/\b(?:e|dps|n[ãa]o|nunca|jamais|nem(?:\s+sequer)?)\s*$/i.test(prefix)
      && !/\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como|que)\b(?:\s+[^\s\d,;.!?]+){0,3}\s*$/i.test(prefix)) {
      push((m.index || 0) + m[0].length)
    }
  }
  // Pedido, corrida oferecida e gasto avulso após vírgula são proposições
  // próprias. A modalidade de uma não pode contaminar a outra.
  for (const m of text.matchAll(/[,;]\s*(?=(?:(?:minha|meu|a|o)\s+\w+\s+)?(?:pediu|pediram|tocou|furando|furou|furei)\b)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  for (const m of text.matchAll(/\s+e\s+(?=(?:(?:minha|meu|a|o)\s+\w+\s+)?(?:pediu|pediram|tocou|furando|furou|furei)\b)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  for (const m of text.matchAll(/\s+(?=(?:minha|meu|a|o)\s+\w+\s+(?:pediu|pediram|tocou)\b)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  // Depois de "quer dizer 45", "e 30 no pneu" é um segundo gasto — não
  // parte do valor corrigido. Não mexe em enumerações sem correção.
  for (const m of text.matchAll(/[,;]\s*e\s+(?=\d+(?:[.,]\d+)*\s+(?:no|na|de|em)\b)/gi)) {
    if (new RegExp(INTRA_CORRECTION, 'i').test(text.slice(Math.max(0, (m.index || 0) - 70), m.index))) {
      push((m.index || 0) + m[0].length)
    }
  }
  for (const m of text.matchAll(/\s+e\s+(?=\d+(?:[.,]\d+)*\s+(?:no|na|de|em)\b)/gi)) {
    if (new RegExp(INTRA_CORRECTION, 'i').test(text.slice(Math.max(0, (m.index || 0) - 70), m.index))) {
      push((m.index || 0) + m[0].length)
    }
  }
  // Dois DIAS na mesma mensagem: "ontem fiz 280 e hoje 320". Sem este corte a
  // frase virava uma cláusula só, a data do primeiro dia valia para tudo, e o
  // segundo dia era perdido em silêncio — o usuário achava que tinha lançado os
  // dois. Exige um número depois da palavra de dia: "trabalhei ontem e hoje"
  // não descreve dois lançamentos e não pode ser cortado.
  for (const m of text.matchAll(/[,;]?\s+e\s+(?=(?:hoje|hj|ontem|anteontem)\b[^,;.!?]*\d)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  // O mesmo com vírgula ("ontem 30 de lanche, anteontem 20 de padaria") e com
  // o dia DEPOIS de cada item ("30 de lanche ontem e 20 de padaria anteontem").
  // Sem o corte, o primeiro dia valia para tudo e a padaria entrava na data
  // errada. O segundo caso só corta quando CADA metade tem o seu dia: em "30 de
  // lanche e 20 de padaria ontem" o dia é dos dois.
  for (const m of text.matchAll(/[,;]\s*(?=(?:hoje|hj|ontem|anteontem)\b[^,;.!?]*\d)/gi)) {
    push((m.index || 0) + m[0].length)
  }
  const DIA = /\b(?:hoje|hj|ontem|anteontem|dia\s+\d{1,2})\b/i
  for (const m of text.matchAll(/\s+e\s+(?=\d)/gi)) {
    const antes = text.slice(0, m.index || 0)
    const depois = text.slice((m.index || 0) + m[0].length).split(/[,;.!?]|\s+e\s+/)[0]
    if (DIA.test(antes.split(/[,;.!?]/).pop() || '') && DIA.test(depois)) push((m.index || 0) + m[0].length)
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
  // "Como foi" também: "hj deu 300 uber como foi" ficava uma frase só, e o
  // registro sumia em "não tenho certeza do que registrar".
  for (const m of text.matchAll(/\s+(?=(?:e\s+)?(?:(?:quanto|quantos|quantas|qual|quais|quando)\b|como\s+(?:foi|t[aá]|est[aá]|ficou)(?![\wà-ú])))/gi)) {
    // O espaço entre "e" e "quanto" não é outro corte: o "e" ficava sozinho.
    if (/\be$/i.test(text.slice(0, m.index || 0))) continue
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

  // O identificador pode vir ligado por preposição: "kitnet DO fundo", "casa DO
  // meio", "loja DE roupas". Sem aceitar esse conector o casamento parava na
  // própria preposição e a origem virava "kitnet do" — um nome truncado que
  // ainda por cima não bate com a grafia guardada no histórico, fazendo o mesmo
  // imóvel existir duas vezes.
  for (const m of originalClause.matchAll(new RegExp(String.raw`\bd[ao]s?\s+((?:${ORIGIN_NOUNS})\s+(?:d[aeo]s?\s+)?[\wçãõáéíóúâê\d]+)`, 'gi'))) {
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
// Futuro referido por outra cláusula
// ---------------------------------------------------------------------------

const MOVIMENTO_REFERIVEL = new Set(['income', 'expense', 'saving'])
const ARTIGO_REF = '(?:a|o|as|os|da|do|na|no|pela|pelo)'
const escapa = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Como a cláusula futura pode chamar este lançamento: origem inteira, o identificador dela, ou a descrição. */
function nomesDe(a: ParsedAction): RegExp[] {
  const out: RegExp[] = []
  const origem = normalizeName(String((a as any).origin || ''))
  if (origem) {
    out.push(new RegExp(String.raw`\b${escapa(origem)}\b`))
    const ultimo = origem.split(' ').pop()!
    if (ultimo && ultimo !== origem) out.push(new RegExp(String.raw`\b${ARTIGO_REF}\s+${escapa(ultimo)}\b`))
  }
  const desc = normalizeName(String((a as any).description || ''))
  if (desc && desc.split(' ').length <= 2) out.push(new RegExp(String.raw`\b${ARTIGO_REF}\s+${escapa(desc)}\b`))
  return out
}

function moveFuturoReferido(clauses: AnalyzedClause[], today: string): void {
  for (let i = 1; i < clauses.length; i++) {
    const c = clauses[i]
    if (c.actions.length || c.temporal?.actions?.length) continue
    if (c.intent === 'question' || c.intent === 'conversation' || looksNegated(c.text)) continue
    const futura = findAllDates(c.text, today).find(isFutureDate)
    const intencao = !looksPast(c.text) ? c.text.match(INTENCAO) : null
    if (!futura && !intencao) continue

    const texto = normalizeName(c.text)
    const movidas: ParsedAction[] = []
    for (let j = 0; j < i; j++) {
      const e = clauses[j]
      const ficam: ParsedAction[] = []
      for (const a of e.actions) {
        if (MOVIMENTO_REFERIVEL.has(a.kind) && nomesDe(a).some(re => re.test(texto))) movidas.push(a)
        else ficam.push(a)
      }
      if (ficam.length !== e.actions.length) e.actions = ficam
    }
    if (!movidas.length) continue

    const sinal: TemporalSignal = c.temporal?.kind === 'future'
      ? c.temporal
      : futura
        ? { kind: 'future', text: futura.text, label: futura.label, date: futura.date, relative: futura.relative, imprecise: futura.imprecise, actions: [] }
        : { kind: 'future', text: intencao![0], label: intencao![0], imprecise: true, actions: [] }
    sinal.actions = [...sinal.actions, ...movidas]
    // Sem verbo no passado na cláusula futura, é o plano declarado.
    if (looksPast(c.text)) sinal.conflict = true
    else sinal.plan = true
    c.temporal = sinal
    c.intent = 'record'
    c.handled = true
    // A cláusula de onde o lançamento saiu não ficou "não entendida": o que ela
    // dizia foi lido, só que é futuro.
    for (let j = 0; j < i; j++) {
      const e = clauses[j]
      if (!e.actions.length && e.intent === 'record' && !e.temporal) { e.temporal = sinal; e.handled = true }
    }
  }
}

// ---------------------------------------------------------------------------
// Análise
// ---------------------------------------------------------------------------

const DATABLE = new Set(['income', 'expense', 'saving', 'work', 'fuel', 'maintenance'])
const ORIGINABLE = new Set(['income', 'expense'])

// Predicados explícitos: sob `strict: false` o TypeScript não estreita união
// discriminada dentro de `find()` sem eles (ver CLAUDE.md, regra 24).
const isFutureDate = (d: DateResolution): d is Extract<DateResolution, { kind: 'future' }> => d.kind === 'future'
const isPeriodDate = (d: DateResolution): d is Extract<DateResolution, { kind: 'period' }> => d.kind === 'period'
const isInvalidDate = (d: DateResolution): d is Extract<DateResolution, { kind: 'invalid' }> => d.kind === 'invalid'
const isRelativeFuture = (d: DateResolution): boolean => isFutureDate(d) && d.relative === true

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

/** Números monetários ainda não representados, sem confundir data, medida e fonte. */
/**
 * "Fiz 12 corridas E ganhei 260": cortada, a metade da receita inferia sozinha
 * 1 viagem, e a mensagem registrava 13. A quantidade DITA numa cláusula vale
 * para a mensagem: as viagens que as outras cláusulas inferiram da receita
 * saem (o trabalho sem km nem horas sai junto).
 */
const QUANTIDADE_DE_VIAGENS = /\b\d+\s+(?:corridas|viagens|corrida|viagem)\b/i
function semViagemInferidaComQuantidadeDita(clauses: AnalyzedClause[]): void {
  if (!clauses.some(c => QUANTIDADE_DE_VIAGENS.test(c.text) && c.actions.some(a => a.kind === 'work' && a.trips))) return
  for (const c of clauses) {
    if (QUANTIDADE_DE_VIAGENS.test(c.text)) continue
    c.actions = c.actions.flatMap(a => {
      if (a.kind !== 'work' || !a.trips) return [a]
      const { trips: _inferida, ...resto } = a
      return resto.km || resto.hours ? [resto] : []
    })
  }
}

function unaccountedMoney(clause: AnalyzedClause): number[] {
  if (clause.ambiguity || clause.temporal || clause.intention || clause.intent === 'question'
    || clause.intent === 'conversation' || clause.intent === 'correction'
    || /\bse\s+eu\b|\b(?:supondo|imagina)\b|%/.test(clause.text)) return []
  if (clause.actions.some(a => !['income', 'expense', 'fuel', 'maintenance', 'saving', 'work'].includes(a.kind))) return []
  const normalized = normalizeNumberWords(clause.text).text
  // Sem leitura local, a frase segue para o planejador remoto. A guarda só
  // impede que uma ação PARCIAL feche a cláusula e esconda outro valor.
  if (!clause.actions.length) return []
  // O preço do litro também é valor dito e representado: "40 litros a 5,89"
  // vira um abastecimento de R$ 235,60, e os 5,89 estão nele.
  const represented = clause.actions.flatMap(a => {
    const v: any = a
    return [v.amount ?? v.cost, v.pricePerLiter]
  }).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (clause.unpaidRideAmount !== undefined) represented.push(clause.unpaidRideAmount)
  const missing: number[] = []
  for (const m of normalized.matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])/g)) {
    const at = m.index || 0
    const before = normalized.slice(Math.max(0, at - 24), at)
    const after = normalized.slice(at + m[0].length, at + m[0].length + 24)
    // "Na 99", "pela 99": é a plataforma, não R$ 99,00.
    const plataforma99 = m[0] === '99' && /\b(?:na|no|pela|pelo|da|do|de|a)\s*$/i.test(before) && !/^\s*(?:reais|real|conto|contos|pila)\b/i.test(after)
    if (plataforma99 || /[\-/]$/.test(before) || /^[\-/]/.test(after)
      || /\b(?:dia|casa|apto|apartamento|numero|número|aro|tamanho|placa|modelo)\s*$/i.test(before)
      || /^\s*(?:x|vezes|parcelas?|km|quil[oô]metros?|litros?|horas?|viagens?|corridas?|dias?|semanas?|meses?|anos?|%|k\b)/i.test(after)) continue
    const amount = parseMoney(m[0])
    const representedAt = represented.findIndex(v => Math.abs(v - amount) < 0.005)
    if (representedAt >= 0) represented.splice(representedAt, 1)
    else missing.push(amount)
  }
  return missing
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
  /**
   * Verbo herdado: "ontem fiz 280 e hoje 320". O "fiz" da primeira metade vale
   * para a segunda — o usuário não repete o verbo ao mudar de dia. Sem isto o
   * app perguntava "esses R$ 320 foram ganho ou gasto?" numa frase que já
   * tinha respondido isso.
   */
  let inheritedKind: 'income' | 'expense' | undefined

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const forParser = aligned ? normalizedParts[i].text : normalized
    const id = clauseId()

    // TODAS as expressões de data são retiradas ANTES de o parser rodar. Só a
    // primeira era retirada, e a que sobrava no texto virava número e descrição
    // do lançamento: "ontem gastei 50 e daqui a 3 dias pago mais 100" criava uma
    // despesa fantasma de R$ 3,00, datada de ontem.
    let datesOriginal = findAllDates(part.text, today)
    let datesParser = findAllDates(forParser, today)
    let hintOriginal = datesOriginal.length ? null : findUnresolvedTemporalHint(part.text)
    let hintParser = datesParser.length ? null : findUnresolvedTemporalHint(forParser)

    // "em 6 meses" em "quero comprar um celular de 5000 em 6 meses" é o PRAZO
    // da meta, não a data de um fato. Só as formas relativas colidem assim, e o
    // desempate é o parser: se a frase inteira produz uma meta, a expressão
    // pertence a ela e não pode ser arrancada do texto.
    if (datesOriginal.some(isRelativeFuture) || datesParser.some(isRelativeFuture)) {
      const full = parseNaturalFull(forParser, { driver: opts?.driver })
      if (full.actions.some(a => a.kind === 'goal' || a.kind === 'goal-update')) {
        datesOriginal = datesOriginal.filter(d => !isRelativeFuture(d))
        datesParser = datesParser.filter(d => !isRelativeFuture(d))
        hintOriginal = null
        hintParser = null
      }
    }
    if (hintOriginal || hintParser) {
      const full = parseNaturalFull(forParser, { driver: opts?.driver })
      if (full.actions.some(a => a.kind === 'goal' || a.kind === 'goal-update')) {
        hintOriginal = null
        hintParser = null
      }
    }

    // O trecho que fala do FUTURO não descreve o fato passado. Sem recortá-lo,
    // "gastei 40 hoje e amanhã vou pagar 120" gravava a despesa de hoje com a
    // descrição "Vou pagar 120" — o plano contaminava o lançamento real.
    let base = forParser
    const futParser = datesParser.find(isFutureDate)
    const pastParser = datesParser.find(d => d.kind === 'date')
    if (futParser && pastParser) {
      const retoma = datesParser.find(d => d.kind === 'date' && d.start > futParser.start)?.start ?? forParser.length
      base = `${forParser.slice(0, futParser.start)} ${forParser.slice(retoma)}`
    }
    if (hintParser && !datesParser.length) {
      base = `${base.slice(0, hintParser.start)} ${base.slice(hintParser.end)}`
    }

    let semData = base
    for (const d of [...findAllDates(base, today)].sort((a, b) => b.start - a.start)) {
      semData = semData.slice(0, d.start) + ' ' + semData.slice(d.end)
    }
    // Conector órfão deixado pelo recorte ("gastei 40 e") não é descrição.
    semData = semData.replace(/\s{2,}/g, ' ').replace(/[\s,;]*\b(?:e|mas|por[ée]m)\s*$/i, '').trim()

    // A expressão de dia foi RETIRADA do texto acima. O parser precisa saber que
    // ela existia: "deu 200 hoje" chega como "deu 200", e é justamente o "hoje"
    // que transforma um número solto no resultado do dia do motorista.
    // A checagem de recorrência é no texto ORIGINAL: "todo dia 10" tem o "dia
    // 10" arrancado como data logo acima, e o que sobra ("minha conta de luz é
    // 150 todo") não parece mais conta nenhuma. Sem isto o resultado do dia
    // perguntava "esses R$ 150 foram ganho ou gasto?" para uma conta de luz.
    const dayHint = !looksRecurring(part.text)
      && [...datesOriginal, ...datesParser].some(d => d.kind === 'date')
    const parsed = parseNaturalFull(semData || forParser, { driver: opts?.driver, dayHint, inheritedKind })
    // "Furou o pneu, foi mais 30" descreve um custo, não outra corrida
    // concluída. O verbo "foi" isolado é ambíguo no perfil motorista.
    const tireIncident = /\b(?:furando|furou|furei)\s+(?:o\s+)?pneu\b/i.test(part.text)
    const tireCost = tireIncident ? parseFirstAmount(part.text) : NaN
    const actions0: ParsedAction[] = tireIncident && tireCost > 0
      ? [{ kind: 'expense', amount: tireCost, category: 'manutencao', description: 'Pneu' }]
      : parsed.actions
    let ambiguity: AnalyzedClause['ambiguity'] = parsed.ambiguity

    // O verbo herdado só vale para a PRÓXIMA metade se esta metade disse uma
    // coisa só: "ganhei 200 e gastei 50" não deixa contexto, deixa confusão.
    const kindsDinheiro = actions0.filter(a => a.kind === 'income' || a.kind === 'expense')
    if (kindsDinheiro.length && new Set(kindsDinheiro.map(a => a.kind)).size === 1) {
      inheritedKind = kindsDinheiro[0].kind as 'income' | 'expense'
    }
    let actions = actions0
    let date: string | undefined
    let dLabel: string | undefined
    let dateAmbiguity: AnalyzedClause['dateAmbiguity']
    // A expressão pode aparecer só no texto normalizado ("daqui a três dias"):
    // ignorar esse caso seria descartar em silêncio exatamente o que a regra
    // temporal proíbe.
    const resolved = datesOriginal.length ? datesOriginal : datesParser
    const future = resolved.find(isFutureDate)
    const period = resolved.find(isPeriodDate)
    const invalid = resolved.find(isInvalidDate)
    const past = resolved.find(d => d.kind === 'date')
    // Quando há plano futuro e fato passado na mesma frase, a ordem das duas
    // metades não pode decidir qual delas sobrevive. `base` já isolou o fato;
    // aqui ligamos a ele a data passada mesmo quando o plano veio primeiro.
    const primary = future && past ? past : resolved[0]
    let temporal: TemporalSignal | undefined
    if (primary && primary.kind === 'date') { date = primary.date; dLabel = primary.label }
    else if (primary && primary.kind === 'ambiguous') dateAmbiguity = { question: primary.question, options: primary.options }

    if (invalid) {
      temporal = {
        kind: 'invalid', text: invalid.text, label: invalid.label,
        question: invalid.question, actions: [],
      }
    } else if (future) {
      temporal = {
        kind: 'future', text: future.text, label: future.label,
        date: future.date, relative: future.relative,
        imprecise: future.imprecise, actions: [],
      }
    } else if (period) {
      temporal = {
        kind: 'period', text: period.text, label: period.label,
        from: period.from, to: period.to, actions: [],
      }
    } else if (hintOriginal || hintParser) {
      const hint = hintOriginal || hintParser!
      temporal = {
        kind: 'unknown', text: hint.text, label: 'data não definida',
        question: `Você mencionou "${hint.text}", mas eu não consegui identificar uma data exata. Qual foi a data correta?`,
        actions: [],
      }
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
    // Mas com verbo no passado o dinheiro JÁ saiu: "gastei 50 no mercado, vale
    // a pena trocar de plano?" é um fato mais uma opinião, e descartar tudo
    // fazia a despesa real do usuário desaparecer sem aviso.
    if (isQuestion && !looksPast(part.text)
      && /\bvale\s+a\s+pena\b|\bcompensa\b|\bdevo\s+aceitar\b|\bacei(?:to|tar)\b/i.test(part.text)) {
      actions = []
    }

    // Relato NEGADO nunca vira lançamento: "não gastei 100" propunha registrar
    // a despesa de 100 — o erro mais perigoso possível num app de dinheiro.
    const negated = looksNegated(part.text)
    if (negated) actions = []

    // Hipótese descreve um cenário, não um fato consumado.
    // "Supondo que eu ganhar 250 na uber" registrava os 250: a lista só
    // conhecia "se eu", e as outras formas de abrir uma hipótese passavam
    // direto. Uma hipótese que vira fato é dinheiro inventado.
    // "Exclui a despesa de 120 da luz" virava uma despesa NOVA de 120: pedido
    // de apagar nunca cria lançamento.
    if (PEDE_APAGAR.test(part.text)) actions = []
    if (/\bse\s+(?:eu|voc[êe]|a\s+gente)\b|\bt[ôo]\s+pensando\b|\bestou\s+pensando\b|\bacho\s+que\b|\bsupondo\b|\bimagina(?:ndo)?\s+que\b|\bvamos\s+supor\b|\bpartindo\s+do\s+principio\b/i.test(part.text)) {
      actions = []
    }

    // Intenção declarada ("vou gastar 80 no mercado", "posso guardar 200?"):
    // nenhum MOVIMENTO de dinheiro nasce dela. Meta continua passando, porque
    // "quero comprar um celular de 5000 em 6 meses" é como se cria um objetivo.
    let intencao = false
    // Com verbo no PASSADO na mesma cláusula o fato existe e a intenção é só a
    // outra metade da frase — "gastei 40 hoje e amanhã vou pagar 120" tem um
    // lançamento legítimo, e quem cuida do plano é a regra temporal. Sem esta
    // condição a guarda de intenção engolia o gasto de hoje junto.
    if (!looksPast(part.text) && declaresIntention(part.text)) {
      // Pagar fatura, assinar e financiar também movem dinheiro: "vou pagar a
      // fatura do nubank amanhã" virava pagamento feito. Depósito em meta fica
      // com o orquestrador, que sabe se a meta existe ("quero guardar 2000 para
      // a viagem" sem meta Viagem é pergunta: criar a meta ou reservar?).
      const MOVIMENTO_INTENCAO = new Set(['income', 'expense', 'saving', 'fuel', 'work', 'maintenance', 'card-purchase', 'balance',
        'card-payment', 'financed-cash-inflow', 'card-charge'])
      const antes = actions.length
      actions = actions.filter(a => !MOVIMENTO_INTENCAO.has(a.kind))
      intencao = actions.length < antes
    }

    const requestedPix = /\b(?:pediu|pediram|solicitou|solicitaram)\b[^.;!?]*\bpix\b|\bpix\b[^.;!?]*\b(?:pediu|pediram|solicitou)\b/i.test(part.text)
    const offeredRide = /\b(?:tocou|chamou|apareceu)\s+(?:uma?\s+)?corrida\b/i.test(part.text)
    const refund = /\b(?:devolvi|devolveu|estornei|estornou)\b/i.test(part.text)
    if (requestedPix || offeredRide || refund) {
      actions = []
      const value = requestedPix
        ? parseFirstAmount(part.text.match(/\bpix\b[^.;!?]*?\b(?:de|no\s+valor\s+de)\s*(?:r\$\s*)?\d+(?:[.,]\d+)*/i)?.[0] || part.text)
        : refund ? parseFirstAmount(part.text.match(/\b(?:devolvi|devolveu|estornei|estornou)\b[^.;!?]*?\d+(?:[.,]\d+)*/i)?.[0] || part.text)
          : parseFirstAmount(part.text)
      const amount = Number.isFinite(value) ? `R$ ${value.toFixed(2).replace('.', ',')}` : ''
      const yesActions: ParsedAction[] = value > 0
        ? requestedPix ? [{ kind: 'expense', amount: value, category: 'outros-out', description: 'Pix enviado' }]
          : offeredRide ? [
            { kind: 'income', amount: value, category: opts?.driver ? 'corridas' : undefined, description: 'Corrida' },
            ...(opts?.driver ? [{ kind: 'work' as const, trips: 1 }] : []),
          ] : [{ kind: 'expense', amount: value, category: 'outros-out', description: 'Devolução' }]
        : []
      ambiguity = { field: 'financial-event', question: requestedPix
        ? `Você chegou a enviar o Pix${amount ? ` de ${amount}` : ''}? Pedido não é transferência realizada.`
        : offeredRide ? `Essa corrida${amount ? ` de ${amount}` : ''} foi concluída e paga? Uma chamada não é receita recebida.`
          : `Você devolveu${amount ? ` ${amount}` : ''} ao pagador? Posso registrar essa devolução como saída após você confirmar.`,
        options: yesActions.length ? [
          { label: 'Sim', actions: yesActions },
          { label: 'Não', actions: [], reply: 'Certo, não vou registrar esse valor como realizado.' },
        ] : [] }
    }

    // Leitura local de BAIXA confiança não fecha a cláusula. O número do período
    // lido como valor, a magnitude perdida, a meta lida como despesa e o
    // movimento de dinheiro dentro de uma pergunta sem fato: a ação sai, e a
    // cláusula volta a ficar em aberto para quem sabe lê-la.
    const suspeitas = new Set<SuspicionReason>()
    const passado = looksPast(part.text)
    // O texto é o MESMO que o parser leu, com as datas já retiradas: "paguei 100
    // mês passado" tem o "mês" do período, não a duração do 100.
    const lidoPeloParser = semData || forParser
    actions = actions.filter(a => {
      const motivos = suspicionReasons(a, { text: part.text, normalized: lidoPeloParser, isQuestion, hasPastMoneyVerb: passado })
      for (const m of motivos) suspeitas.add(m)
      return !motivos.length
    })

    // NENHUMA EXPRESSÃO TEMPORAL É DESCARTADA. Uma data que ainda não chegou,
    // ou um período sem dia certo, não pode virar um lançamento de hoje: as
    // ações ficam guardadas no sinal e quem decide é o usuário.
    if (temporal && !negated && !isConversation) {
      const dataveis = actions.filter(a => DATABLE.has(a.kind))
      const falaDeDinheiro = dataveis.length > 0 || /\d/.test(semData)
      if (date) {
        // Data passada explícita E plano futuro na mesma frase ("gastei 40 hoje
        // e amanhã vou pagar 120"): o registro legítimo continua com a data
        // certa, e o plano vira explicação — nunca um segundo lançamento.
        if (temporal.kind === 'future' && falaDeDinheiro) temporal.plan = true
        else temporal = undefined
      } else if (temporal.kind === 'future' && (dataveis.length || (!isQuestion && falaDeDinheiro))) {
        // Perguntar não autoriza gravar na data errada: "gastei 50 daqui a 3
        // dias?" também para aqui.
        temporal.actions = actions
        // Passado + futuro é contradição: perguntar. Sem verbo no passado, é
        // plano declarado: explicar que ainda não sabemos agendar.
        if (looksPast(part.text)) temporal.conflict = true
        else temporal.plan = true
        actions = []
      } else if ((temporal.kind === 'period' || temporal.kind === 'invalid') && dataveis.length) {
        temporal.actions = actions
        actions = []
      } else if (temporal.kind === 'unknown' && (dataveis.length || (!isQuestion && falaDeDinheiro))) {
        temporal.actions = actions
        if (looksPast(part.text)) temporal.conflict = true
        else temporal.plan = true
        actions = []
      } else {
        temporal = undefined
      }
    } else if (temporal) {
      temporal = undefined
    }

    // Uma PERGUNTA que por acaso contém "trocar"/"mudar" não é uma correção:
    // "vale a pena trocar de plano?" era classificada como correção e o
    // assistente respondia "entendi que isso não aconteceu — não registrei
    // nada", que não tem relação nenhuma com o que foi perguntado.
    const isCorrection = !isConversation && !isQuestion && looksLikeCorrection(part.text)

    let intent: AssistantIntent
    if (isConversation) intent = 'conversation'
    else if (negated) intent = 'correction'
    else if (isCorrection && !actions.length) intent = 'correction'
    else if (actions.length && !isQuestion) intent = 'record'
    else if (actions.length && isQuestion) intent = 'record' // a pergunta vira cláusula própria abaixo
    else if (isQuestion) intent = 'question'
    else intent = 'unknown'

    // A cláusula temporal FOI compreendida — o que falta é a decisão do
    // usuário. Marcá-la como resolvida é o que impede a mensagem de ir para a
    // IA remota e voltar de lá como um lançamento datado de hoje.
    if (temporal) intent = 'record'

    // Uma cláusula com ação E pergunta juntas ("gastei 40, ainda bato a meta?")
    // rende DUAS entradas: a pergunta não pode sumir porque a ação foi entendida.
    const handled = intent === 'conversation' || (intent === 'record' && actions.length > 0) || !!temporal || !!ambiguity

    clauses.push({
      id, text: part.text, start: part.start, end: part.end,
      intent, handled,
      confidence: actions.length ? (ambiguity ? 'medium' : 'high') : (intent === 'conversation' ? 'high' : 'low'),
      actions,
      date, dateLabel: date ? dLabel || dateLabel(date, today) : undefined,
      ambiguity,
      dateAmbiguity,
      temporal,
      intention: intencao || undefined,
      suspicious: suspeitas.size ? [...suspeitas] : undefined,
    })

    if (actions.length && isQuestion) {
      clauses.push({
        id: clauseId(), text: part.text, start: part.start, end: part.end,
        intent: 'question', handled: false, confidence: 'low', actions: [],
      })
    }
  }

  // "Fiz a corrida, mas ainda não pagou": a viagem pode ter acontecido,
  // porém o dinheiro não entrou. A negação está na cláusula seguinte.
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]
    const unpaid = /\b(?:(?:ainda\s+)?n[ãa]o|nunca|jamais)\s+(?:me\s+)?pag(?:ou|aram)\b|\bn[ãa]o\s+recebi(?:\s+ainda)?\s*(?:[.!?,;]|$)|\bn[ãa]o\s+recebi\s+(?:nada|um\s+centavo|o\s+pix|o\s+valor(?:\s+ainda)?|o\s+pagamento|pela\s+corrida|da\s+corrida)\b|\bn[ãa]o\s+caiu\s+nada\b|\bn[ãa]o\s+fui\s+pag[oa]\b|\bsem\s+(?:pagamento|receber)\b|\bfiquei\s+sem\s+receber\b|\b(?:cliente|passageiro)\s+t[áa]\s+me\s+devendo\b|\bdinheiro\s+ainda\s+n[ãa]o\s+caiu\b|\bpix\s+n[ãa]o\s+entrou\b/i.test(clause.text)
    if (!unpaid) continue
    // O alvo da negação importa mais que a mera presença de uma palavra.
    // "cliente não me pagou porque não recebeu salário" nega a corrida;
    // "da comissão não recebi nada" nega outra renda, não a corrida paga.
    const negativePart = clause.text.split(/\bmas\b/i).pop() || clause.text
    const ridePayerDenied = /\b(?:cliente|passageiro)\b[^.!?]*\bn[ãa]o\s+(?:me\s+)?pag(?:ou|aram)\b|\bn[ãa]o\s+(?:me\s+)?pag(?:ou|aram)\b[^.!?]*\b(?:cliente|passageiro)\b/i.test(negativePart)
    if (!ridePayerDenied && /\b(?:sal[áa]rio|patr[ãa]o|venda|aluguel|comiss[ãa]o)\b/i.test(negativePart)) continue
    const previous = [...clauses.slice(0, i + 1)].reverse().find(c => /\bcorrida\b/i.test(c.text)
      && c.actions.some(a => a.kind === 'income'))
    if (!previous) continue
    const income = previous.actions.find(a => a.kind === 'income') as Extract<ParsedAction, { kind: 'income' }> | undefined
    previous.actions = previous.actions.filter(a => a !== income)
    previous.unpaidRideAmount = income?.amount
    clause.ambiguity = { question: `O passageiro ainda não pagou os R$ ${income?.amount.toFixed(2).replace('.', ',')}? Não vou registrar essa receita antes do pagamento.`, options: [] }
    clause.handled = true
  }

  // A quantidade dita vale antes de fundir: depois, a viagem inferida já está
  // somada às ditas.
  semViagemInferidaComQuantidadeDita(clauses)

  // Registros de trabalho de cláusulas diferentes são o MESMO dia: "rodei 120 km
  // e fiz 14 viagens" não são dois turnos. A fusão acontece aqui porque a
  // segmentação separou o que o parser antigo via junto.
  // A fusão é POR DIA. "Ontem fiz 280 e hoje 320" são dois turnos diferentes, e
  // somá-los punha as viagens de hoje na conta de ontem — o dia do motorista
  // ficava com o número errado nos dois lados.
  const works = clauses.flatMap(c => c.actions.filter(a => a.kind === 'work')) as any[]
  const porDia = new Map<string, any[]>()
  for (const w of works) {
    const chave = w.date || ''
    porDia.set(chave, [...(porDia.get(chave) || []), w])
  }
  if (works.length > porDia.size) {
    const fundido = new Map<string, any>()
    for (const [chave, lista] of porDia) {
      if (lista.length < 2) continue
      const merged: any = { kind: 'work' }
      for (const w of lista) {
        for (const f of ['km', 'trips', 'hours'] as const) {
          if (w[f] !== undefined) merged[f] = (merged[f] || 0) + w[f]
        }
        if (w.date && !merged.date) merged.date = w.date
      }
      fundido.set(chave, merged)
    }
    // O resumo de cada dia fica na ÚLTIMA cláusula que falou daquele dia: é
    // como a frase é lida ("ganhei X, gastei Y, rodei Z km").
    const restantes = new Map<string, number>()
    for (const [chave, lista] of porDia) restantes.set(chave, lista.length)
    for (const c of clauses) {
      c.actions = c.actions.flatMap(a => {
        if (a.kind !== 'work') return [a]
        const chave = (a as any).date || ''
        const merged = fundido.get(chave)
        if (!merged) return [a]
        const n = (restantes.get(chave) || 1) - 1
        restantes.set(chave, n)
        return n === 0 ? [merged as ParsedAction] : []
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
    // O alvo da correção é o PRIMEIRO valor após o marcador. Uma ação posterior
    // ("e 30 no pneu") nunca pode virar o valor corrigido do combustível.
    const novo = parseFirstAmount(c.text)
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

  // FUTURO QUE APONTA PARA A OUTRA METADE: "recebi 1800 da casa 1 e 1200 da
  // casa 2 MAS A 2 AINDA VAI CAIR amanhã". A cláusula futura não tem valor
  // próprio — ela fala do lançamento da cláusula anterior pelo nome ("a 2", "a
  // água", "o da ana"). Sem ligar as duas, os 1200 saíam como recebidos hoje,
  // ao lado de um aviso de que algo ainda não tinha acontecido.
  moveFuturoReferido(clauses, today)

  // Nenhum valor explícito pode ficar escondido na descrição de outra ação.
  // O oráculo é independente do parser: lê os numerais da própria cláusula e
  // compara com os valores das ações. Correção, intenção e dúvida já têm classe.
  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i]
    if (clauses[i + 1] && /^\s*(?:quer\s+dizer|na\s+verdade|corrigindo)\b/i.test(clauses[i + 1].text)) continue
    const missing = unaccountedMoney(c)
    if (!missing.length) continue
    const values = missing.map(v => `R$ ${v.toFixed(2).replace('.', ',')}`).join(', ')
    c.ambiguity = { question: `Você mencionou ${values} nesta parte, mas não consegui ligar esse valor a uma ação. O que aconteceu com ele?`, options: [] }
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
