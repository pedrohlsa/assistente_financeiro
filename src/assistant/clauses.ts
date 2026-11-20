// Segmentação da mensagem em CLÁUSULAS, com posição preservada.
//
// A falha estrutural da arquitetura antiga era tratar a mensagem como uma coisa
// só: achar uma ação encerrava a interpretação e o resto se perdia. Aqui cada
// trecho é analisado separadamente e carrega o próprio veredito — é isso que
// permite dizer "entendi esta parte, não entendi aquela" em vez de chutar.

import type { ParsedAction } from '../models/types'
import type { AssistantConfidence, AssistantIntent } from './contracts'
import { cleanDescription, gruposDeCorrida, looksRecurring, parseNaturalFull } from '../services/nlp'
import { findAllDates, findDate, findUnresolvedTemporalHint, dateLabel } from './dates'
import type { DateResolution } from './dates'
import { normalizeNumberWords } from './numbers'
import { addDays, fmtBRL, MESES_PT_BR, parseMoney, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { suspicionReasons } from './semantic/confidence'
import type { SuspicionReason } from './semantic/confidence'
import { isInvoicePaymentStatement, readInvoiceReference } from './invoicePayment'

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
  ambiguity?: { question: string; field?: string; pendingActions?: ParsedAction[]; queryTemplate?: string;
    options: { label: string; value?: string; actions: ParsedAction[]; reply?: string }[] }
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
  /** O trecho descreve um fato que quase aconteceu ou um plano abandonado. */
  unrealized?: boolean
  approximateAmount?: boolean
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
const COMPLETED_FORMS = {
  gastar: 'gastei', gastando: 'gastei', pagar: 'paguei', pagando: 'paguei',
  receber: 'recebi', recebendo: 'recebi', comprar: 'comprei', comprando: 'comprei',
  ganhar: 'ganhei', ganhando: 'ganhei', transferir: 'transferi', transferindo: 'transferi',
} as const
const COMPLETED_MONEY = String.raw`(?:acabei|terminei)\s+(?:de\s+)?(?:${Object.keys(COMPLETED_FORMS).join('|')})`
const RECORD_VERB = 'anot[ae]|registr[ae]|lan[cç][ae]|salv[ae]'
const RECORD_TYPE = 'despesa|gasto|receita|entrada'
const RECORD_NUMBER = String.raw`(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?`
const RECORD_DIRECTIVE = String.raw`(?:${RECORD_VERB})\s+(?:(?:[oa]\s+)?(?:${RECORD_TYPE})|${RECORD_NUMBER}\s+de\s+(?:${RECORD_TYPE}))`
const EMPHATIC_PAYMENT = String.raw`foi\s+(${RECORD_NUMBER})\s+que\s+(?:eu\s+)?(gastei|paguei|recebi|ganhei)\b`

const NEGATED_VERBS =
  'gastei|gastou|paguei|pagou|pagamos|quitei|quitamos|antecipei|adiantei|recebi|recebeu|ganhei|ganhou|comprei|comprou|guardar|guardei|separei|abasteci|coloquei|botei|rodei|trabalhei|fiz|foi|era|quero|vou|registra|registre|registrar|salva|salve|anota|anote|anotar'
  // Qualquer verbo de dinheiro no passado pode ser NEGADO. A lista acima
  // esquecia troquei, instalei, vendi, depositei e outros — e "nao troquei o
  // oleo por 280" registrava a manutencao mesmo assim.
  + `|troquei|instalei|vendi|depositei|investi|apliquei|parcelei|passei|tirei|retirei|faturei|lucrei|andei|dirigi|percorri|saiu|entrou|caiu|sobrou|custou|reembolsaram|reembolsou|${COMPLETED_MONEY}|${RECORD_VERB}`

/**
 * A vírgula depois do "não" é o jeito mais comum de negar em fala real: "não,
 * eu não gastei 190". Exigir espaço logo depois do "não" fazia a frase inteira
 * escapar da guarda e o gasto negado virava lançamento. "Nem" é a outra forma
 * ("nem gastei isso").
 */
const NEGATION_HEAD = String.raw`(?:n[ãa]o|nem|nunca|jamais)\b[\s,;!]*(?:\S+[\s,]+){0,3}?(?:${NEGATED_VERBS})(?![a-zà-ú])`
const SHORT_NEGATION_HEAD = String.raw`n\s+(?:(?:eu|ainda)\s+){0,2}(?:${NEGATED_VERBS})(?![a-zà-ú])`
const NEGATED_STATEMENT = new RegExp(
  String.raw`^\s*(?:(?:mas|e|ah|olha|eu|ainda)\b[\s,]+){0,3}(?:${NEGATION_HEAD}|${SHORT_NEGATION_HEAD})`,
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
  'gastei|gastou|gastamos|paguei|pagou|pagamos|quitei|quitamos|antecipei|adiantei|recebi|recebeu|recebemos|ganhei|ganhou|ganhamos|comprei|comprou|compramos|parcelei|passei|abasteci|coloquei|botei|guardei|separei|depositei|investi|apliquei|tirei|retirei|vendi|faturei|lucrei|rodei|andei|dirigi|percorri|trabalhei|fiz|fizemos|troquei|instalei|entrou|caiu|sobrou|reembolsaram|reembolsou'

const PAST_STATEMENT = new RegExp(String.raw`\b(?:${PAST_MONEY_VERBS}|${COMPLETED_MONEY}|${RECORD_DIRECTIVE})\b`, 'i')

export const looksPast = (t: string): boolean => PAST_STATEMENT.test(t)

function spokenMoney(text: string): string {
  const verbOf = (type: string) => /^(?:receita|entrada)$/i.test(type) ? 'recebi' : 'gastei'
  return text
    .replace(new RegExp(String.raw`^\s*${EMPHATIC_PAYMENT}`, 'i'), '$2 $1')
    .replace(new RegExp(String.raw`^\s*(?:${RECORD_VERB})\s+que\s+(?:eu\s+)?(?=(?:${PAST_MONEY_VERBS}|${COMPLETED_MONEY})\b)`, 'i'), '')
    .replace(new RegExp(String.raw`^\s*(?:${RECORD_VERB})\s+(?:[oa]\s+)?(${RECORD_TYPE})\s+(?:no\s+valor\s+de\s+|de\s+)?(?=${RECORD_NUMBER})`, 'i'),
      (_m, type: string) => `${verbOf(type)} `)
    .replace(new RegExp(String.raw`^\s*(?:${RECORD_VERB})\s+(${RECORD_NUMBER})\s+de\s+(${RECORD_TYPE})\b`, 'i'),
      (_m, value: string, type: string) => `${verbOf(type)} ${value}`)
    .replace(new RegExp(String.raw`\b(?:acabei|terminei)\s+(?:de\s+)?(${Object.keys(COMPLETED_FORMS).join('|')})\b`, 'gi'),
      (_m, form: keyof typeof COMPLETED_FORMS) => COMPLETED_FORMS[form.toLowerCase()])
    .replace(new RegExp(String.raw`\b(${PAST_MONEY_VERBS})\s+(?:exatamente|precisamente|certinh[oa]s?)\s+(?=(?:r\$\s*)?\d)`, 'gi'), '$1 ')
    .replace(new RegExp(String.raw`(\b(?:${PAST_MONEY_VERBS})\s+(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?)\s+(?:exat[oa]s?|certinh[oa]s?)\b`, 'gi'), '$1')
}

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
const MODAIS = 'posso|poderia|devo|deveria|quero|queria|pretendo|penso\\s+em|planejo|vou|vamos|vai|v[ãa]o|ia|iria|irei|ir[áa]|ir[ãa]o|deve|devem|preciso|precisava|tenho\\s+que|tenho\\s+de|d[áa]\\s+pra|d[áa]\\s+para|consigo|gostaria\\s+de|to\\s+querendo|estou\\s+querendo'
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
  `ganhei|ganhou|recebi|recebeu|faturei|lucrei|entrou|caiu|gastei|gastou|paguei|pagou|comprei|comprou|parcelei|passei|troquei|instalei|abasteci|coloquei|botei|rodei|andei|dirigi|percorri|trabalhei|quero|queria|vou|vamos|vai|pretendo|fiz|guardei|guarda|guardar|separei|separa|separar|depositei|investi|tirei|retirei|sobrou|sobra|vendi|apliquei|${COMPLETED_MONEY}|${RECORD_DIRECTIVE}|(?:${RECORD_VERB})\\s+que\\s+(?:eu\\s+)?(?:${PAST_MONEY_VERBS}|${COMPLETED_MONEY})`

const WISH_ABANDONED = /\b(?:queria\s+comprar|pensei\s+que|achei\s+que)\b/i
const ABANDONING = /^\s*(?:eu\s+)?(?:desisti|deixei\s+pra\s+l[áa]|mudei\s+de\s+ideia)\b/i
const ALMOST_HAPPENED = new RegExp(String.raw`^\s*(?:(?:eu|s[oó]|ainda)\s+)*quase\s+(?:${PAST_MONEY_VERBS}|${INFINITIVOS_DINHEIRO})\b`, 'i')

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
  String.raw`(?:(?:quer\s+dizer|na\s+verdade|na\s+real|ou\s+melhor|melhor\s+dizendo|digo|perd[ãa]o|desculpa|n[ãa]o[\s,]+(?:espera|pera[íi]?)|pera[íi]?|corrigindo|ops|minto|mentira|esquece\s+(?:essa|isso))(?![a-zà-ú])|n[ãa]o\s*,(?=\s*(?:foi|era)\b))`
const CORRECTION_START = new RegExp(String.raw`^\s*(?:${INTRA_CORRECTION}|era\b)`, 'i')
const CORRECTION_CONTRAST = /^\s*n[ãa]o\s+(?:foi|era)\s+[^.!?]+?\s+(?:foi|era)\s+([^.!?]+)[.!?]*$/i
const CORRECTED_AMOUNT = /^(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?:\s*(?:reais?|contos?)\b)?/i

const PROTECTED: RegExp[] = [
  /(?:passei|passou|fiz)\s+(?:r\$\s*)?[\d.,]+[^.;!?]*?(?:recebi|receber|peguei|caiu)\s+(?:r\$\s*)?[\d.,]+/gi,
  /comprei[^.;!?]*?\b(?:em|x)\s*\d+\s*(?:vez(?:es)?|x|parcelas?)/gi,
]

export function segment(text: string, today = todayISO()): { text: string; start: number; end: number }[] {
  const guarded: [number, number][] = []
  for (const re of PROTECTED) {
    for (const m of text.matchAll(re)) {
      if (m.index !== undefined) guarded.push([m.index, m.index + m[0].length])
    }
  }
  const inside = (i: number) => guarded.some(([a, b]) => i > a && i < b)

  const cuts = new Set<number>([0])
  const push = (i: number) => { if (i > 0 && i < text.length && !inside(i)) cuts.add(i) }

  const deniedAmount = text.match(new RegExp(String.raw`^\s*(?:n[ãa]o|n)\s+foi\s+${RECORD_NUMBER}[,;]\s*(?=${EMPHATIC_PAYMENT})`, 'i'))
  if (deniedAmount) push(deniedAmount[0].length)

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
  // Uma baixa anterior continua válida quando a segunda parte é negada.
  const beforeNegation = new RegExp(String.raw`(?:[,;]\s*(?:e\s+)?|\s+e\s+)(?=(?:(?:eu|ainda)\s+){0,2}(?:${NEGATION_HEAD}|${SHORT_NEGATION_HEAD}))`, 'gi')
  for (const m of text.matchAll(beforeNegation)) push((m.index || 0) + m[0].length)
  // Duas PERGUNTAS na mesma frase: "quanto gastei com combustível…, e quanto
  // isso representa do faturamento?". Juntas, o planejador lia uma consulta
  // só, com a segunda metade virando filtro, e respondia "não tenho lançamento"
  // para um número que existia. Cada pergunta é uma cláusula.
  if (/\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como)\b/i.test(text)) {
    for (const m of text.matchAll(/[,;]?\s+e\s+(?=(?:quanto|quantos|quantas|qual|quais|quando|onde|como|por\s+que|pq)\b)/gi)) {
      if (/\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como)\b/i.test(text.slice(0, m.index))) push((m.index || 0) + m[0].length)
    }
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
    const fragment = prefix.slice(Math.max(...[...cuts].filter(cut => cut <= prefix.length)))
    const date = /^(?:\s*(?:em|no|na)\s+)?\s*(?:dia\s+\d|\d{1,4}[/-])/i.test(fragment) ? findDate(fragment, today) : null
    const onlyDate = date && /^\s*(?:(?:em|no|na)\s*)?$/i.test(fragment.slice(0, date.start))
      && /^[\s,]*$/.test(fragment.slice(date.end))
    // Nunca deixe a negação no fragmento anterior: "não gastei" é uma unidade.
    // Nem a pergunta: "quanto gastei de alimentação" era cortado em "quanto" +
    // "gastei de alimentação", e nenhuma das metades tinha resposta.
    if (!onlyDate && /\d/.test(fragment) && !/\b(?:e|dps|n[ãa]o|n|nunca|jamais|nem(?:\s+sequer)?)\s*$/i.test(prefix)
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
    if (new RegExp(String.raw`${INTRA_CORRECTION}|[,;—–]\s*era\b`, 'i').test(text.slice(Math.max(0, (m.index || 0) - 70), m.index))) {
      push((m.index || 0) + m[0].length)
    }
  }
  for (const m of text.matchAll(/\s+e\s+(?=\d+(?:[.,]\d+)*\s+(?:no|na|de|em)\b)/gi)) {
    if (new RegExp(String.raw`${INTRA_CORRECTION}|[,;—–]\s*era\b`, 'i').test(text.slice(Math.max(0, (m.index || 0) - 70), m.index))) {
      push((m.index || 0) + m[0].length)
    }
  }
  // Dois DIAS na mesma mensagem: "ontem fiz 280 e hoje 320". Sem este corte a
  // frase virava uma cláusula só, a data do primeiro dia valia para tudo, e o
  // segundo dia era perdido em silêncio — o usuário achava que tinha lançado os
  // dois. Exige um número depois da palavra de dia: "trabalhei ontem e hoje"
  // não descreve dois lançamentos e não pode ser cortado.
  for (const m of text.matchAll(/[,;]?\s+e\s+(?=(?:hoje|hj|ontem|anteontem|(?:depois\s+de\s+)?amanh[ãa])(?=\s|$)[^,;.!?]*\d)/gi)) {
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
  for (const m of text.matchAll(/[,;]?\s+(?:mas|por[ée]m|s[óo]\s+que)\s+/gi)) {
    const after = (m.index || 0) + m[0].length
    const prior = text.slice(Math.max(...[...cuts].filter(cut => cut <= m.index)), m.index)
    if (/^(?:sem|tirando|exceto)\b/i.test(text.slice(after)) && looksLikeQuestion(prior)) continue
    push(after)
  }
  // Palavra interrogativa começando uma pergunta colada ao registro:
  // "gastei 80 de mercado QUANTO sobrou" — sem este corte a pergunta virava
  // parte da descrição ("Mercado quanto") e nunca era respondida.
  // "Como foi" também: "hj deu 300 uber como foi" ficava uma frase só, e o
  // registro sumia em "não tenho certeza do que registrar".
  for (const m of text.matchAll(/\s+(?=(?:e\s+)?(?:(?:quanto|quantos|quantas|qual|quais|quando)\b|como\s+(?:foi|t[aá]|est[aá]|ficou)(?![\wà-ú])))/gi)) {
    // O espaço entre "e" e "quanto" não é outro corte: o "e" ficava sozinho.
    if (/\be$/i.test(text.slice(0, m.index || 0))) continue
    const prior = expandWeekdayAlternatives(text.slice(Math.max(...[...cuts].filter(cut => cut <= m.index)), m.index))
    if (/^\s*(?:me\s+)?(?:lembra|diz|fala|conta|mostra)\s*$/i.test(prior)) continue
    const dates = /\bou\b/i.test(prior) ? alternativeDates(prior, datesMentioned(prior, today)) : undefined
    if (dates && /^\s*(?:(?:no|na|em)\s*)?[,; ]*$/i.test(prior.slice(0, dates.start) + prior.slice(dates.end))) continue
    push((m.index || 0) + m[0].length)
  }
  // Marcador de correção dentro da própria mensagem.
  for (const m of text.matchAll(new RegExp(String.raw`\s+(${INTRA_CORRECTION})`, 'gi'))) {
    push((m.index || 0) + m[0].length - m[1].length)
  }
  for (const m of text.matchAll(/[,;—–]\s*(?=era\b)/gi)) push((m.index || 0) + m[0].length)

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

const DATABLE = new Set(['income', 'expense', 'saving', 'work', 'fuel', 'maintenance', 'card-payment'])
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

const SHORT_WEEKDAYS: Record<string, string> = { seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sábado', dom: 'domingo' }

export function weekdayChoiceWord(text: string): string {
  const word = normalizeName(text).replace(/[.!?]+$/, '').trim()
  return /^(?:seg|ter|qua|qui|sex|sab|dom)$/.test(word) ? SHORT_WEEKDAYS[word] : text
}

function expandWeekdayAlternatives(text: string): string {
  const days = 'segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|seg|ter|qua|qui|sex|s[áa]b|dom'
  return text.replace(new RegExp(String.raw`(?<![\p{L}\p{M}])(${days})(\s+ou\s+)(${days})(?![\p{L}\p{M}])`, 'giu'),
    (_m, left: string, separator: string, right: string) => weekdayChoiceWord(left) + separator + weekdayChoiceWord(right))
}

function datesMentioned(text: string, today: string): DateResolution[] {
  const dates = findAllDates(text, today)
  return dates.flatMap(date => {
    if (!/\bdia\s+\d{1,2}$/i.test(date.text)) return [date]
    const short = text.slice(date.end).match(/^(\s+ou\s+)(\d{1,2})(?!\d|[.,]\d|\s+(?:reais?|contos?|km|litros?|parcelas?)\b)(?=\s|$|[,;.!?])/i)
    if (!short) return [date]
    const other = findDate(`dia ${short[2]}`, today)
    const start = date.end + short[1].length
    return other ? [date, { ...other, start, end: start + short[2].length }] : [date]
  })
}

function alternativeDates(text: string, dates: DateResolution[]) {
  if (dates.length < 2 || !/\bou\b/i.test(text)) return undefined
  const ordered = [...dates].sort((a, b) => a.start - b.start)
  const joined = (a: DateResolution, b?: DateResolution) => !!b && /^\s*,?\s*ou(?:\s+talvez)?\s*$/i.test(text.slice(a.end, b.start))
  const first = ordered.findIndex((date, i) => joined(date, ordered[i + 1]))
  if (first < 0) return undefined
  let last = first + 1
  while (joined(ordered[last], ordered[last + 1])) last++
  const choices = ordered.slice(first, last + 1).flatMap(d => d.kind === 'ambiguous' ? d.options
    : (d.kind === 'date' || d.kind === 'future') && d.date ? [{ label: d.label, value: d.date }] : [])
  const options = [...new Map(choices.map(o => [o.value, o])).values()]
  if (options.length < 2) return undefined
  return { question: 'Em qual dessas datas o lançamento aconteceu?', options, start: ordered[first].start, end: ordered[last].end }
}

function alternativeAmounts(text: string, driver: boolean | undefined, date?: string, origin?: string): AnalyzedClause['ambiguity'] {
  const re = /(?<![\w.,])(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?:\s+(?:reais?|contos?))?\s+ou(?:\s+talvez)?\s+(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?![\d.,])/gi
  const match = [...text.matchAll(re)].find(m => /r\$/i.test(m[0])
    || new RegExp(String.raw`\b(?:${PAST_MONEY_VERBS}|valor)\b\s*(?:foi\s+|de\s+)?$`, 'i').test(text.slice(0, m.index)))
  if (!match) return undefined
  if (/^\s*(?:km|quil[oô]metros?|parcelas?|vezes|litros?|horas?|dias?|viagens?|corridas?)\b/i.test(text.slice(match.index + match[0].length))) return undefined
  const options = [...new Set([parseMoney(match[1]), parseMoney(match[2])])].flatMap(value => {
    if (!(value > 0)) return []
    const alternate = `${text.slice(0, match.index)}${value.toFixed(2).replace('.', ',')}${text.slice(match.index + match[0].length)}`
    const parsed = parseNaturalFull(alternate, { driver })
    const money = parsed.actions.filter(a => a.kind !== 'work')
    if (parsed.ambiguity || money.length !== 1 || !('amount' in money[0]) || money[0].amount !== value) return []
    return [{ label: fmtBRL(value), actions: parsed.actions.map(a => ({ ...a,
      ...(date && DATABLE.has(a.kind) ? { date } : {}), ...(origin && ORIGINABLE.has(a.kind) ? { origin } : {}),
    })) }]
  })
  return { field: 'amount-choice', question: options.length === 2 ? 'Qual dos dois valores foi o valor exato?' : 'Qual foi o valor exato?',
    options: options.length === 2 ? options : [] }
}

function incompleteAmount(text: string, driver: boolean | undefined, date?: string, origin?: string): AnalyzedClause['ambiguity'] {
  const tail = /(?<![\w.,])(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?\s+e\s+(?:poucos?|alguns\s+(?:quebrados|trocados|centavos)|uns\s+(?:quebrados|trocados|(?:\d+\s+)?centavos))\b/i
  const bound = /\b(?:quase|mais\s+de|menos\s+de|pelo\s+menos|no\s+m[áa]ximo)\s+(?:r\$\s*)?\d+(?:[.,]\d+)*(?![\d.,])/i
  const match = text.match(tail) || text.match(bound)
  if (!match || !new RegExp(String.raw`\b(?:${PAST_MONEY_VERBS})\s*$`, 'i').test(text.slice(0, match.index))) return undefined
  const suffix = text.slice(match.index + match[0].length)
  if (/^\s+(?:km|quil[oô]metros?|parcelas?|vezes|litros?|horas?|dias?|viagens?|corridas?)\b/i.test(suffix)) return undefined
  const placeholder = parseFirstAmount(match[0])
  const sample = `${text.slice(0, match.index)}${placeholder.toFixed(2).replace('.', ',')}${suffix}`
  const parsed = parseNaturalFull(sample, { driver })
  const cash = parsed.actions.filter(a => a.kind !== 'work')
  const [action] = cash
  if (parsed.ambiguity || cash.length !== 1 || !(action.kind === 'income' || action.kind === 'expense' || action.kind === 'saving')
    || action.amount !== placeholder) {
    return { question: 'Qual foi o valor exato? Diga também o que aconteceu para eu preparar o lançamento certo.', options: [] }
  }
  const pendingActions = parsed.actions.map(a => ({ ...a,
    ...(date && DATABLE.has(a.kind) ? { date } : {}), ...(origin && ORIGINABLE.has(a.kind) ? { origin } : {}),
  }))
  return { field: 'exact-amount', question: 'Qual foi o valor exato, incluindo os centavos?', options: [], pendingActions }
}

const APPROXIMATE_AMOUNT = /\b(?:uns|umas|mais\s+ou\s+menos|cerca\s+de|por\s+volta\s+de|aproximadamente)\s+(?:r\$\s*)?\d/i

/** Um número numa origem (Casa 2) ou numa data não substitui o valor do registro. */
function revisedAction(action: ParsedAction, body: string, today: string): ParsedAction | undefined {
  const dates = findAllDates(body, today)
  const [date] = dates
  if (dates.length > 1 || (date && date.kind !== 'date')) return undefined
  const exactDate = date?.kind === 'date' ? date.date : undefined
  const details = (date ? `${body.slice(0, date.start)} ${body.slice(date.end)}` : body).trim()
  const payload = details.replace(/[,\s]+n[ãa]o\s+(?:r\$\s*)?\d+(?:[.,]\d+)*\s*[.!?]*$/i, '')
  const normalized = normalizeNumberWords(payload).text
  const value = normalized.match(CORRECTED_AMOUNT)
  const amount = value ? parseMoney(value[1]) : undefined
  if (value && !(amount > 0)) return undefined
  let place = normalized.slice(value?.[0].length ?? 0).replace(/^[\s,:;]+|[\s,.!?;]+$/g, '')
  if (/^(?:talvez|acho|mais\s+ou\s+menos|uns|umas)\b/i.test(place)) return undefined
  if (action.kind === 'expense' || action.kind === 'income') {
    const v = amount ?? action.amount
    // No ditado, o mesmo valor pode voltar depois do lugar como ênfase.
    const repeated = place.match(/,\s*(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?:\s|$)/i)
    if (repeated) {
      if (Math.abs(parseMoney(repeated[1]) - v) >= 0.005) return undefined
      place = place.slice(0, repeated.index).trim()
    }
    if (!place && amount === undefined && !exactDate) return undefined
    if (!place) return { ...action, amount: v, ...(exactDate ? { date: exactDate } : {}) }
    const origins = extractOrigins(payload)
    if (origins.length > 1) return undefined
    const verb = action.kind === 'expense' ? 'gastei' : 'recebi'
    const parsed = parseNaturalFull(`${verb} ${v.toFixed(2).replace('.', ',')} ${place}`, { driver: false }).actions
    const [replacement] = parsed
    if (parsed.length !== 1 || replacement?.kind !== action.kind) return undefined
    const origin = origins[0]?.value
    if (!origin && !replacement.description && !replacement.category) return undefined
    return { ...action, ...replacement, amount: v,
      description: replacement.description || (origin && normalizeName(action.description) === normalizeName(action.origin) ? undefined : action.description),
      origin: origin || (replacement.description ? undefined : action.origin), ...(exactDate ? { date: exactDate } : {}) }
  }

  if (place || exactDate || amount === undefined) return undefined
  if ('amount' in action) return { ...action, amount }
  if ('total' in action) return { ...action, total: amount }
  if ('cost' in action) return { ...action, cost: amount }
  return undefined
}

/** Números monetários ainda não representados, sem confundir data, medida e fonte. */
/**
 * "Fiz 12 corridas E ganhei 260": cortada, a metade da receita inferia sozinha
 * 1 viagem, e a mensagem registrava 13. A quantidade DITA numa cláusula vale
 * para a mensagem: as viagens que as outras cláusulas inferiram da receita
 * saem (o trabalho sem km nem horas sai junto).
 */
const QUANTIDADE_DE_VIAGENS = /\b\d+\s+(?:corridas|viagens|corrida|viagem)\b/i
function semViagemInferida(actions: ParsedAction[], text: string): ParsedAction[] {
  if (QUANTIDADE_DE_VIAGENS.test(text)) return actions
  return actions.flatMap(a => {
    if (a.kind !== 'work' || !a.trips) return [a]
    const { trips: _inferida, ...resto } = a
    return resto.km || resto.hours ? [resto] : []
  })
}

function semViagemInferidaComQuantidadeDita(clauses: AnalyzedClause[]): void {
  if (!clauses.some(c => QUANTIDADE_DE_VIAGENS.test(c.text) && c.actions.some(a => a.kind === 'work' && a.trips))) return
  for (const c of clauses) c.actions = semViagemInferida(c.actions, c.text)
}

type IncomeAction = Extract<ParsedAction, { kind: 'income' }>
const VALOR_REEMBOLSO = String.raw`(?:r\$\s*)?([-+]?\d+(?:[.,]\d+)*)(?:\s+(?:real|reais))?`
const RECEBI_REEMBOLSO = [
  new RegExp(String.raw`^(?:eu\s+)?(?:recebi|recebemos)\s+(?:mais\s+)?${VALOR_REEMBOLSO}\s+de\s+reembolso\b`, 'i'),
  new RegExp(String.raw`^(?:me\s+)?reembolsaram\s+${VALOR_REEMBOLSO}\b`, 'i'),
  new RegExp(String.raw`^(?:o\s+)?reembolso\s+de\s+${VALOR_REEMBOLSO}(?:\s+(?<referencia>d[aeo]s?\s+[^\d?!;,.]+?))?\s+(?:caiu|entrou)(?:\s+na\s+conta)?[.!]*$`, 'i'),
]
const REEMBOLSO_ADICIONAL = new RegExp(String.raw`(?:,\s*mais\s+|\be\s+(?:mais\s+)?)${VALOR_REEMBOLSO}\s+de\s+reembolso\b`, 'i')
const REEMBOLSO_INCLUIDO = new RegExp(String.raw`(?:\b(?:sendo|dos\s+quais|dess[ea]s?)\s+${VALOR_REEMBOLSO}\s+(?:(?:foi|foram|era|eram)\s+)?(?:de\s+)?reembolso|(?:[,;]\s*|\b(?:mas|porem|so\s+que)\s+)${VALOR_REEMBOLSO}\s+(?:foi|foram|era|eram)\s+(?:de\s+)?reembolso)\b`)
const PEDIU_REEMBOLSO = /\b(?:pedi|pedimos|solicitei|solicitamos)\s+(?:um\s+|o\s+)?reembolso\b/i
const REEMBOLSO_HIPOTETICO = /\bse\s+(?:(?:me\s+|nos\s+)?reembols(?:ar|arem|asse|assem)|(?:(?:eu|a\s+gente)\s+)?receber\s+[^\d.!?]{0,20}(?:r\$\s*)?\d[\d.,]*\s+de\s+reembolso|(?:o\s+)?reembolso\b[^.!?]*\b(?:cair|entrar))\b/i
const REEMBOLSO_PENDENTE = /^(?:o\s+)?reembolso\b[^.!?]*\b(?:n[aã]o\s+(?:entrou|caiu)|ainda\s+vai\s+(?:entrar|cair)|pendente)\b/i
const AINDA_NAO_CAIU = /^(?:(?:mas|porem|so\s+que)\s+)?(?:ainda\s+)?nao\s+(?:caiu|entrou)(?:\s+na\s+conta)?[.!?]*$/
const ESCLARECE_REEMBOLSO_PENDENTE = 'O reembolso já entrou? Se caiu, me diga o valor recebido e a data para preparar o lançamento.'

function entradaDeReembolso(amount: number, detalhe = ''): IncomeAction {
  return { kind: 'income', category: 'outros-in', amount, description: detalhe ? `Reembolso ${detalhe}` : 'Reembolso' }
}

export function isRefundInflow(action: ParsedAction): boolean {
  return action.kind === 'income' && action.category === 'outros-in' && /^reembolso\b/i.test(action.description || '')
}

function reembolsoRecebido(match: RegExpMatchArray, frase: string): IncomeAction | undefined {
  const detalhe = match.groups?.referencia || frase.slice((match.index ?? 0) + match[0].length).replace(/[.!]+$/, '').trim()
  if (detalhe && !/^(?:d[aeo]s?|por|referente\s+a)\s+[^\d?!;,]+$/i.test(detalhe)) return undefined
  if (/\b(?:n[aã]o|mas|recebi|gastei|paguei)\b/i.test(detalhe)) return undefined
  const valor = parseMoney(match[1])
  return valor > 0 ? entradaDeReembolso(valor, detalhe) : undefined
}

/** Resolve reembolsos cuja composição ou situação é explicada em outra cláusula. */
function esclareceReembolsos(clauses: AnalyzedClause[], original: string, today: string): void {
  if (!/\breembols\w*\b/i.test(original)) return
  for (let i = 0; i < clauses.length; i++) {
    const registro = clauses[i]
    const outra = clauses[i + 1]
    if (outra && !outra.actions.length && AINDA_NAO_CAIU.test(normalizeName(outra.text))
      && registro.actions.some(isRefundInflow)) {
      registro.actions = registro.actions.filter(a => !isRefundInflow(a))
      registro.ambiguity = { question: ESCLARECE_REEMBOLSO_PENDENTE, options: [] }
      outra.handled = true
    }
    if (registro.intent !== 'record' || !/\b(?:recebi|recebemos|ganhei)\b/i.test(registro.text)) continue
    const entradas = (registro.temporal?.actions.length ? registro.temporal.actions : registro.actions)
      .filter((a): a is IncomeAction => a.kind === 'income')
    if (!entradas.length) continue

    const textoDoRegistro = normalizeName(normalizeNumberWords(registro.text).text)
    const mesmoTrecho = textoDoRegistro.match(REEMBOLSO_INCLUIDO)
    const continua = !mesmoTrecho && outra && outra.start >= registro.end && !outra.actions.length && /\breembolso\b/i.test(outra.text)
    const textoCompleto = continua ? normalizeName(normalizeNumberWords(original.slice(registro.start, outra.end)).text) : textoDoRegistro
    const leitura = mesmoTrecho || textoCompleto.match(REEMBOLSO_INCLUIDO)
    if (!leitura) continue

    const renda = entradas[0]
    const reembolso = parseMoney(leitura[1] || leitura[2])
    registro.actions = semViagemInferida(registro.actions.filter(a => a.kind !== 'income'), registro.text)
    if (continua) {
      outra.handled = true
      outra.intent = 'unknown'
      outra.ambiguity = undefined
    }

    const datas = findAllDates(textoCompleto, today)
    const dataIncerta = registro.dateAmbiguity || registro.temporal || (continua && outra.dateAmbiguity)
      || datas.some(d => d.kind !== 'date' || d.date !== registro.date)
    const depois = textoCompleto.slice((leitura.index ?? 0) + leitura[0].length)
    const pendente = /\b(?:pendente|a\s+receber|ainda\s+(?:vai|deve)\s+(?:cair|entrar)|nao\s+(?:entrou|caiu))\b/.test(depois)
    const proxima = clauses[i + (continua ? 2 : 1)]
    const corrigiuNaProxima = !!proxima && looksLikeRetraction(proxima.text) && /\breembolso\b/i.test(proxima.text)
    const corrigiu = looksLikeRetraction(depois) || corrigiuNaProxima
    if (corrigiuNaProxima) {
      proxima.actions = []
      proxima.ambiguity = undefined
      proxima.handled = true
      proxima.intent = 'clarification'
    }
    if (registro.temporal) {
      registro.temporal.actions = semViagemInferida(registro.temporal.actions.filter(a => a.kind !== 'income'), registro.text)
      if (!registro.temporal.actions.length) registro.temporal = undefined
    }
    const valorTotal = fmtBRL(renda.amount)
    const valorReembolso = fmtBRL(reembolso)
    let question: string | undefined
    if (dataIncerta) question = 'Em que dia entrou o valor com reembolso? Diga a data exata, o total recebido e quanto desse total foi reembolso.'
    else if (corrigiu) question = 'Qual foi o total que entrou após a correção e quanto dele era reembolso?'
    else if (pendente) question = 'Qual valor já entrou? Você mencionou um reembolso pendente. Me diga se alguma parte dele foi recebida.'
    else if (entradas.length > 1) question = `Qual das entradas inclui os ${valorReembolso} de reembolso? Diga o valor e a origem de cada entrada.`
    else if (!(reembolso > 0) || reembolso > renda.amount) {
      question = `Você informou ${valorTotal} recebidos e ${valorReembolso} de reembolso. Qual foi o total que entrou e quanto dele era reembolso?`
    }
    if (question) {
      registro.ambiguity = { options: [], question }
      continue
    }

    const restante = Math.round((renda.amount - reembolso) * 100) / 100
    const devolucao = { ...entradaDeReembolso(reembolso), date: renda.date }
    const actions = restante > 0 ? [{ ...renda, amount: restante }, devolucao] : [devolucao]
    registro.ambiguity = {
      field: 'financial-event',
      question: restante > 0
        ? `Dos ${valorTotal} que entraram, posso preparar ${fmtBRL(restante)} como receita e ${valorReembolso} como reembolso na categoria Outros?`
        : `Posso preparar os ${valorTotal} que entraram como reembolso na categoria Outros?`,
      options: [
        { label: 'Sim', actions },
        { label: 'Não', actions: [], reply: 'Qual foi o total recebido e quanto dele era reembolso?' },
      ],
    }
  }
}

const ANO_DE_COMPETENCIA = new RegExp(String.raw`\b(?:${MESES_PT_BR.map(normalizeName).join('|')})\s+de\s*$`, 'i')
const INVOICE_EXTRA_AMOUNT = /\s+e\s+(?:mais\s+)?((?:r\$\s*)?\d+(?:[.,]\d+)*)(?:\s+reais?)?\s+(?=(?:no|na|em|de|do|da)\s+[a-zà-ú])/gi
const INVOICE_CONTEXT = /\b(?:faturas?|cart[aã]o|cr[eé]dito|parcelas?|juros|tarifas?|descontos?|pix)\b/i

function unaccountedMoney(clause: AnalyzedClause): number[] {
  if (clause.ambiguity || clause.temporal || clause.intention || clause.intent === 'question'
    || clause.intent === 'conversation' || clause.intent === 'correction'
    || /\bse\s+eu\b|\b(?:supondo|imagina)\b|%/.test(clause.text)) return []
  const normalized = normalizeNumberWords(clause.text).text
  if (clause.actions.some(a => a.kind === 'card-payment')) {
    const amounts = clause.actions.filter(a => a.kind === 'expense').map(a => a.amount)
    return [...normalized.matchAll(INVOICE_EXTRA_AMOUNT)].flatMap(m => {
      const amount = parseMoney(m[1])
      const matched = amounts.findIndex(v => Math.abs(v - amount) < 0.005)
      if (matched < 0) return amount > 0 ? [amount] : []
      amounts.splice(matched, 1)
      return []
    })
  }
  if (clause.actions.some(a => !['income', 'expense', 'fuel', 'maintenance', 'saving', 'work'].includes(a.kind))) return []
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
  // "3 corridas de 40 e uma de 25": quantidade e valor de cada grupo estão no
  // produto registrado (R$ 120,00 e R$ 25,00); não são valores soltos.
  const grupos = gruposDeCorrida(normalized).filter(g => represented.some(v => Math.abs(v - g.n * g.v) < 0.005))
  const missing: number[] = []
  for (const m of normalized.matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d.,])/g)) {
    const at = m.index || 0
    if (grupos.some(g => at >= g.start && at < g.end)) continue
    const before = normalized.slice(Math.max(0, at - 24), at)
    const after = normalized.slice(at + m[0].length, at + m[0].length + 24)
    // "Na 99", "pela 99": é a plataforma, não R$ 99,00.
    const plataforma99 = m[0] === '99' && /\b(?:na|no|pela|pelo|da|do|de|a)\s*$/i.test(before) && !/^\s*(?:reais|real|conto|contos|pila)\b/i.test(after)
    const anoDeCompetencia = /^(?:19|20)\d{2}$/.test(m[0]) && ANO_DE_COMPETENCIA.test(normalizeName(before))
    if (plataforma99 || anoDeCompetencia || /[\-/]$/.test(before) || /^[\-/]/.test(after)
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

  const originalParts = segment(original, today)
  const normalizedParts = segment(normalized, today)
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
    const isConversation = looksLikeConversation(part.text)
    const isQuestion = !isConversation && looksLikeQuestion(part.text)
    const negated = looksNegated(part.text)
    const following = parts[i + 1]?.text || ''
    const abandoned = /\b(?:mas|por[ée]m|s[óo]\s+que)\s*$/i.test(part.text) && WISH_ABANDONED.test(part.text)
      && (looksPast(following) || ABANDONING.test(following))
    const abandonedReply = ABANDONING.test(part.text) && WISH_ABANDONED.test(parts[i - 1]?.text || '')
    const onlyPlanned = !looksPast(part.text) && /\b(?:ia|iria)\s+/i.test(part.text) && declaresIntention(part.text)
    const unrealized = !isQuestion && (abandoned || abandonedReply || onlyPlanned || ALMOST_HAPPENED.test(part.text))
    const canShareContext = !isQuestion && !isConversation && !negated && !unrealized
    const originalMoney = spokenMoney(expandWeekdayAlternatives(part.text))
    const forParserRaw = spokenMoney(expandWeekdayAlternatives(aligned ? normalizedParts[i].text : normalized))
    const invoiceOriginal = readInvoiceReference(originalMoney, today)
    const invoiceParser = forParserRaw === originalMoney ? invoiceOriginal : readInvoiceReference(forParserRaw, today)
    const forParser = invoiceParser.paymentText
    const id = clauseId()

    // TODAS as expressões de data são retiradas ANTES de o parser rodar. Só a
    // primeira era retirada, e a que sobrava no texto virava número e descrição
    // do lançamento: "ontem gastei 50 e daqui a 3 dias pago mais 100" criava uma
    // despesa fantasma de R$ 3,00, datada de ontem.
    let datesOriginal = datesMentioned(invoiceOriginal.paymentText, today)
    let datesParser = datesMentioned(forParser, today)
    let hintOriginal = datesOriginal.length ? null : findUnresolvedTemporalHint(invoiceOriginal.paymentText)
    let hintParser = datesParser.length ? null : findUnresolvedTemporalHint(forParser)

    // "em 6 meses" em "quero comprar um celular de 5000 em 6 meses" é o PRAZO
    // da meta, não a data de um fato. Só as formas relativas colidem assim, e o
    // desempate é o parser: se a frase inteira produz uma meta, a expressão
    // pertence a ela e não pode ser arrancada do texto. Vale para toda data
    // futura: "até dezembro DO ANO QUE VEM" perdia o ano e o prazo encurtava.
    let prazoDaMeta = false
    if (datesOriginal.some(isFutureDate) || datesParser.some(isFutureDate)) {
      const full = parseNaturalFull(forParser, { driver: opts?.driver })
      if (full.actions.some(a => a.kind === 'goal' || a.kind === 'goal-update')) {
        prazoDaMeta = true
        datesOriginal = datesOriginal.filter(d => !isFutureDate(d))
        datesParser = datesParser.filter(d => !isFutureDate(d))
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
    const dateAlternatives = alternativeDates(forParser, datesParser)
    const alternatives = !looksLikeQuestion(part.text) && looksPast(part.text) ? dateAlternatives : undefined
    let base = alternatives ? `${forParser.slice(0, alternatives.start)} ${forParser.slice(alternatives.end)}` : forParser
    const futParser = datesParser.find(isFutureDate)
    const pastParser = datesParser.find(d => d.kind === 'date')
    if (futParser && pastParser && !alternatives) {
      const retoma = datesParser.find(d => d.kind === 'date' && d.start > futParser.start)?.start ?? forParser.length
      base = `${forParser.slice(0, futParser.start)} ${forParser.slice(retoma)}`
    }
    if (hintParser && !datesParser.length) {
      base = `${base.slice(0, hintParser.start)} ${base.slice(hintParser.end)}`
    }

    // O prazo da meta fica no texto: a proteção acima filtrava as datas, mas
    // aqui elas eram procuradas de novo e arrancadas — "em 6 meses" chegava ao
    // parser sem o prazo, e a meta nascia sem ele.
    let semData = base
    for (const d of [...findAllDates(base, today)].filter(d => !(prazoDaMeta && isFutureDate(d))).sort((a, b) => b.start - a.start)) {
      semData = semData.slice(0, d.start) + ' ' + semData.slice(d.end)
    }
    // Conector órfão deixado pelo recorte ("gastei 40 e") não é descrição.
    semData = semData.replace(/\s{2,}/g, ' ').replace(/[\s,;]*\b(?:e|mas|por[ée]m)\s*$/i, '').trim()
    if (isInvoicePaymentStatement(forParser)) semData = semData.replace(/\s+(?:em|no\s+dia|na\s+data)\s*$/i, '').trim()

    // A expressão de dia foi RETIRADA do texto acima. O parser precisa saber que
    // ela existia: "deu 200 hoje" chega como "deu 200", e é justamente o "hoje"
    // que transforma um número solto no resultado do dia do motorista.
    // A checagem de recorrência é no texto ORIGINAL: "todo dia 10" tem o "dia
    // 10" arrancado como data logo acima, e o que sobra ("minha conta de luz é
    // 150 todo") não parece mais conta nenhuma. Sem isto o resultado do dia
    // perguntava "esses R$ 150 foram ganho ou gasto?" para uma conta de luz.
    const dayHint = !looksRecurring(part.text)
      && [...datesOriginal, ...datesParser].some(d => d.kind === 'date')
    const lida = semData || forParser
    const fala = invoiceParser.referenceMonth ? lida.replace(/\b(?:antecipei|adiantei)\b/i, 'paguei') : lida
    const primeiroReembolso = RECEBI_REEMBOLSO.map(re => fala.match(re)).find(Boolean)
    const maisReembolso = primeiroReembolso ? null : fala.match(REEMBOLSO_ADICIONAL)
    const mencaoReembolso = primeiroReembolso || maisReembolso
    const reembolso = mencaoReembolso && reembolsoRecebido(mencaoReembolso, fala)
    const antesDoReembolso = reembolso && maisReembolso ? fala.slice(0, maisReembolso.index).trim() : fala
    const extraDaFatura = isInvoicePaymentStatement(antesDoReembolso) ? [...antesDoReembolso.matchAll(INVOICE_EXTRA_AMOUNT)][0] : undefined
    const comandoPrincipal = extraDaFatura ? antesDoReembolso.slice(0, extraDaFatura.index).trim() : antesDoReembolso
    const parsed = parseNaturalFull(comandoPrincipal, { driver: opts?.driver, dayHint, inheritedKind })
    const fatura = parsed.actions.find(a => a.kind === 'card-payment')
    const resolved = datesOriginal.length ? datesOriginal : datesParser
    const datasDitas = resolved.filter(d => d.kind === 'date' || d.kind === 'future').map(d => d.date)
    const datasSeparadas = new Set(datasDitas).size > 1
    let despesasDaFatura: ParsedAction[] = []
    if (fatura && extraDaFatura) {
      // "Paguei 80 da fatura e 50 no mercado": o verbo também governa o
      // segundo valor quando o destino identifica uma despesa independente.
      const extra = antesDoReembolso.slice(extraDaFatura.index)
        .replace(/^\s*e\s+(?:mais\s+)?/i, '')
      const despesa = !datasSeparadas && !resolved.some(d => d.kind === 'ambiguous')
        && !INVOICE_CONTEXT.test(extra) && !/\bou\b/i.test(extra)
        && /^(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?\s+(?:no|na|em)\s/i.test(extra)
        ? parseNaturalFull(`paguei ${extra}`, { driver: opts?.driver, dayHint }) : undefined
      if (despesa?.actions.length && !despesa.ambiguity && despesa.actions.every(a => a.kind === 'expense' && a.category && a.category !== 'outros-out')) {
        despesasDaFatura = despesa.actions
        parsed.actions.push(...despesa.actions)
      } else if (fatura.amount === undefined && INVOICE_CONTEXT.test(extra)) {
        parsed.actions = parsed.actions.filter(a => a !== fatura)
        parsed.ambiguity = { question: 'Qual foi o valor que você pagou da fatura? Explique também o segundo valor que citou.', options: [] }
      }
    }
    const direcaoIncerta = !!(maisReembolso && reembolso && !parsed.actions.some(a => a.kind === 'income'))
    // "Furou o pneu, foi mais 30" descreve um custo, não outra corrida
    // concluída. O verbo "foi" isolado é ambíguo no perfil motorista.
    const tireIncident = /\b(?:furando|furou|furei)\s+(?:o\s+)?pneu\b/i.test(part.text)
    const tireCost = tireIncident ? parseFirstAmount(part.text) : NaN
    const actions0: ParsedAction[] = tireIncident && tireCost > 0
      ? [{ kind: 'expense', amount: tireCost, category: 'manutencao', description: 'Pneu' }]
      : reembolso && !direcaoIncerta ? primeiroReembolso ? [reembolso] : [...parsed.actions, reembolso] : parsed.actions
    let ambiguity: AnalyzedClause['ambiguity'] = primeiroReembolso && reembolso ? undefined : parsed.ambiguity
    if (!ambiguity && direcaoIncerta && reembolso) {
      ambiguity = { question: `O reembolso de ${fmtBRL(reembolso.amount)} entrou ou saiu da sua conta?`, options: [] }
    }

    // O verbo herdado só vale para a PRÓXIMA metade se esta metade disse uma
    // coisa só: "ganhei 200 e gastei 50" não deixa contexto, deixa confusão.
    const kindsDinheiro = actions0.filter(a => a.kind === 'income' || a.kind === 'expense')
    if (canShareContext && kindsDinheiro.length && new Set(kindsDinheiro.map(a => a.kind)).size === 1) {
      inheritedKind = kindsDinheiro[0].kind as 'income' | 'expense'
    }
    let actions = actions0
    let date: string | undefined
    let dLabel: string | undefined
    let dateAmbiguity: AnalyzedClause['dateAmbiguity']
    // A expressão pode aparecer só no texto normalizado ("daqui a três dias"):
    // ignorar esse caso seria descartar em silêncio exatamente o que a regra
    // temporal proíbe.
    const future = resolved.find(isFutureDate)
    const period = resolved.find(isPeriodDate)
    const invalid = resolved.find(isInvalidDate)
    const past = resolved.find(d => d.kind === 'date')
    // Quando há plano futuro e fato passado na mesma frase, a ordem das duas
    // metades não pode decidir qual delas sobrevive. `base` já isolou o fato;
    // aqui ligamos a ele a data passada mesmo quando o plano veio primeiro.
    const primary = future && past ? past : resolved[0]
    let temporal: TemporalSignal | undefined
    if (alternatives) dateAmbiguity = { question: alternatives.question, options: alternatives.options }
    else if (primary && primary.kind === 'date') { date = primary.date; dLabel = primary.label }
    // "Meu salário cai dia 5" no dia 1º: o "dia 5" é o DIA DA RECORRÊNCIA, não
    // uma data a esclarecer. Perguntar "o dia 5 deste mês ainda não chegou?"
    // engolia a orientação de cadastrar a conta nos primeiros dias de cada mês.
    else if (primary && primary.kind === 'ambiguous' && !looksRecurring(part.text)) dateAmbiguity = { question: primary.question, options: primary.options }

    if (invalid) {
      temporal = {
        kind: 'invalid', text: invalid.text, label: invalid.label,
        question: invalid.question, actions: [],
      }
    } else if (future && !alternatives) {
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
    const limite = resolved.length === 1 && !invalid && looksPast(part.text) && !looksLikeQuestion(part.text)
      ? part.text.match(/\b(depois|ap[oó]s|a\s+partir|desde)\s+(?:d[eo]\s+|o\s+)?(?=(?:dia\s+)?\d)/i) : null
    if (limite) {
      const incluiData = /desde|partir/i.test(limite[1])
      const from = date ? addDays(date, incluiData ? 0 : 1) : undefined
      temporal = from && from <= today
        ? { kind: 'period', text: part.text.slice(limite.index), label: 'período do registro', from, to: today, actions: [] }
        : { kind: 'unknown', text: part.text.slice(limite.index), label: 'data não definida',
          question: 'Qual foi a data exata em que esse registro aconteceu?', actions: [] }
      date = undefined
      dateAmbiguity = undefined
    }
    if (canShareContext && date) { inheritedDate = date; inheritedLabel = dLabel }
    else if (canShareContext && !date && inheritedDate && !temporal && !dateAmbiguity) { date = inheritedDate; dLabel = inheritedLabel }

    // Origem por posição: "recebi 1800 da Casa 1, mais 1750 da Casa 2" tem duas
    // fontes numa cláusula só. Quando a quantidade de origens bate com a de
    // ações que aceitam origem, elas são pareadas na ordem; do contrário a
    // única origem encontrada vale para todas — e nenhuma é inventada.
    // Origem por PROXIMIDADE: numa cláusula como "recebi 1800 da casa 1 e 1750
    // da casa 2 gastei 200 de obra", parear por ordem não funciona (há 4 ações
    // que aceitam origem e só 2 fontes). Cada ação é ligada à fonte que aparece
    // logo depois do SEU valor no texto — e nenhuma origem é inventada.
    const origins = extractOrigins(part.text)
    const textoComValores = despesasDaFatura.length ? normalizeNumberWords(part.text).text : ''
    const extraOriginal = [...textoComValores.matchAll(INVOICE_EXTRA_AMOUNT)][0]
    const textoExtra = extraOriginal ? textoComValores.slice(extraOriginal.index) : ''
    const origensDoExtra = textoExtra ? extractOrigins(textoExtra) : []

    actions = actions.map(a => {
      const next: any = { ...a }
      if (date && DATABLE.has(a.kind)) next.date = date
      if (a.kind === 'card-payment' && invoiceParser.referenceMonth) next.referenceMonth = invoiceParser.referenceMonth
      const isExpenseExtra = despesasDaFatura.includes(a)
      const scopedOrigins = isExpenseExtra ? origensDoExtra : origins
      if (ORIGINABLE.has(a.kind) && !next.origin && scopedOrigins.length) {
        const at = amountPosition(isExpenseExtra ? textoExtra : part.text, next.amount)
        const perto = at >= 0
          ? scopedOrigins.filter(o => o.at > at).sort((x, y) => x.at - y.at)[0]
          : undefined
        // Sem conseguir localizar o valor no texto, só usa a origem quando ela é
        // única — do contrário arriscaria colar a fonte errada no lançamento.
        const pick = perto || (scopedOrigins.length === 1 ? scopedOrigins[0] : undefined)
        if (pick) next.origin = pick.value
      }
      return next as ParsedAction
    })

    const queryDates = isQuestion && dateAlternatives ? dateAlternatives : undefined

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
    if (negated) actions = []
    if (unrealized) {
      actions = []
      ambiguity = undefined
      temporal = undefined
      dateAmbiguity = undefined
    }

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
    let intencao = unrealized
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
      intencao ||= actions.length < antes
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

    const aguardaReembolso = PEDIU_REEMBOLSO.test(part.text) || REEMBOLSO_HIPOTETICO.test(part.text)
      || REEMBOLSO_PENDENTE.test(part.text) || /^(?:o\s+)?reembolso\b.*\?\s*$/i.test(part.text)
    if (aguardaReembolso) {
      actions = []
      ambiguity = { question: ESCLARECE_REEMBOLSO_PENDENTE, options: [] }
    }

    const faleFatura = actions.some(a => a.kind === 'card-payment')
    const duvidaFatura = faleFatura && (invoiceParser.referenceQuestion
      || (datasSeparadas || (extraDaFatura && resolved.some(d => d.kind === 'ambiguous'))
        ? extraDaFatura ? 'Qual foi a data do pagamento da fatura e qual foi a data do outro lançamento?'
          : 'Qual foi a data exata em que você pagou a fatura?' : undefined))
    if (duvidaFatura) {
      actions = actions.filter(a => a.kind !== 'card-payment')
      temporal = undefined
      dateAmbiguity = undefined
      ambiguity = { question: duvidaFatura, options: [] }
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

    const singleOrigin = origins.length === 1 ? origins[0].value : undefined
    const amountChoice = passado && !negated && !unrealized && !isQuestion && !isConversation
      ? alternativeAmounts(semData, opts?.driver, date, singleOrigin) || incompleteAmount(semData, opts?.driver, date, singleOrigin)
      : undefined
    if (amountChoice) {
      const dateMissing = !!temporal || !!dateAmbiguity
      actions = []
      temporal = undefined
      dateAmbiguity = undefined
      ambiguity = dateMissing ? { question: 'Qual foi o valor exato e em que dia aconteceu?', options: [] } : amountChoice
    }
    if (queryDates) {
      actions = []
      temporal = undefined
      dateAmbiguity = undefined
      const prefix = forParser.slice(0, queryDates.start).trimEnd().replace(/\b(?:no|na|em)\s*$/i, '').trimEnd()
      const suffix = forParser.slice(queryDates.end).replace(/^\s*(?:mas|por[ée]m)\s+(?=(?:sem|tirando|exceto)\b)/i, ' ')
      ambiguity = { field: 'query-date', question: 'Qual desses dias você quer consultar?',
        queryTemplate: `${prefix} em %DATE% ${suffix}`.trim(),
        options: queryDates.options.map(o => ({ ...o, actions: [] })) }
    }

    // Uma PERGUNTA que por acaso contém "trocar"/"mudar" não é uma correção:
    // "vale a pena trocar de plano?" era classificada como correção e o
    // assistente respondia "entendi que isso não aconteceu — não registrei
    // nada", que não tem relação nenhuma com o que foi perguntado.
    const isCorrection = !isConversation && !isQuestion && looksLikeCorrection(part.text)

    let intent: AssistantIntent
    if (queryDates) intent = 'clarification'
    else if (isConversation) intent = 'conversation'
    else if (aguardaReembolso || duvidaFatura || amountChoice || unrealized) intent = 'record'
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
    const interrompida = /^\s*n[ãa]o[\s,]+(?:espera|pera[íi]?)\b/i.test(part.text)
    const handled = (negated && !interrompida) || unrealized || intent === 'conversation'
      || (intent === 'record' && actions.length > 0) || !!temporal || !!ambiguity

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
      unrealized: unrealized || undefined,
      approximateAmount: actions.length > 0 && APPROXIMATE_AMOUNT.test(semData) || undefined,
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

  esclareceReembolsos(clauses, original, today)

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

  // Uma correção se refere ao último registro da própria mensagem. Se faltam
  // elementos para corrigir, o lançamento anterior espera uma resposta.
  for (let i = 1; i < clauses.length; i++) {
    const c = clauses[i]
    const marker = c.text.match(CORRECTION_START)?.[0]
    const contrast = c.text.match(CORRECTION_CONTRAST)?.[1]
    if (c.intent === 'clarification' || (!marker && !contrast)) continue
    c.actions = []
    c.intent = 'correction'
    c.handled = true
    c.ambiguity = undefined
    c.temporal = undefined
    c.dateAmbiguity = undefined
    const target = clauses.slice(0, i).reverse().find(prev => prev.actions.some(a => a.kind !== 'work' && a.kind !== 'odometer'))
    if (!target) continue
    const index = target.actions.map(a => a.kind !== 'work' && a.kind !== 'odometer').lastIndexOf(true)
    const original = target.actions[index]
    const body = (contrast ?? c.text.slice(marker.length)).replace(/^[\s,:;]+/, '')
      .replace(/^(?:(?:foi|foram|era|eram)\b[\s,:;]+)+/i, '').replace(/[,;\s]+e\s*$/i, '').trim()
    const cancel = /^esquece\b/i.test(marker || '') || (/^mentira\b/i.test(marker || '') && (!body || looksNegated(body)))
    const revised = cancel ? undefined : revisedAction(original, body, today)
    target.actions = target.actions.flatMap((a, at) => at === index ? revised ? [revised] : [] : [a])
    if (!revised && original.kind === 'income') target.actions = semViagemInferida(target.actions, target.text)
    if (revised && target.actions.length === 1 && 'date' in revised && revised.date) {
      target.date = revised.date
      target.dateLabel = dateLabel(revised.date, today)
    }
    const next = clauses[i + 1]
    const extraExpense = next?.text.match(/^(?:r\$\s*)?\d+(?:[.,]\d+)*\s+(?:no|na|de|em)\s+([a-zà-ú-]+)[.!]*$/i)
    if (revised?.kind === 'expense' && next && !next.actions.length && !next.ambiguity && !next.temporal && !next.dateAmbiguity
      && /\be$/i.test(c.text) && extraExpense) {
      const parsed = parseNaturalFull(`gastei ${next.text}`, { driver: opts?.driver })
      const [extra] = parsed.actions
      if (!parsed.ambiguity && parsed.actions.length === 1 && extra?.kind === 'expense') {
        next.actions = [{ ...extra, description: extra.description || cleanDescription(extraExpense[1]),
          ...(next.date ? { date: next.date } : {}) }]
        next.intent = 'record'
        next.handled = true
      }
    }
    if (!revised && !cancel) {
      c.intent = 'record'
      c.ambiguity = { question: 'Qual é o lançamento correto? Me diga o valor, o que aconteceu e a data se ela mudou.', options: [] }
    }
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
    // "Gastei 120 no mercado, não, pera, foram 102": o 120 foi substituído pela
    // correção seguinte; perguntar "o que aconteceu com os R$ 120" é ruído.
    // O marcador é o MESMO da correção intramensagem, não uma lista à parte.
    if (clauses[i + 1] && (clauses[i + 1].intent === 'correction' || CORRECTION_START.test(clauses[i + 1].text))) continue
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
