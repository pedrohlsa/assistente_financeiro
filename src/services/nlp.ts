// Registro por linguagem natural (seções 9 e 10).
// Parser local em pt-BR — funciona offline. Preparado para ser substituído/complementado
// por um serviço de IA no backend (ver services/ai.ts).
import { ParsedAction } from '../models/types'
import { DEFAULT_CATEGORIES, guessCategory } from '../data/categories'
import { fmtBRL, fmtNum, fromISO, parseMoney, todayISO } from '../utils/format'
import { normalizeName, sentenceCase } from '../utils/text'
import { workDuration } from '../assistant/semantic/clock'

// Captura valores com QUALQUER combinação de separadores ("100.000,00",
// "10,000,00", "1.234,56", "5000"). A interpretação é sempre delegada ao
// parser monetário central — este módulo não converte número por conta própria.
const NUM = String.raw`(\d+(?:[.,]\d+)*)`
const parseNum = (s: string) => parseMoney(s)

// Como o brasileiro chama a moeda depois do número. É a UNIDADE do valor, nunca
// o objeto do gasto: sem isto "gastei 30 pila no lanche" gravava a descrição
// "Pila no lanche". Uma fonte só — todo regex de valor consome esta lista.
const MOEDA = String.raw`(?:reais|real|conto[s]?|pila[s]?|mang[oa]s?|pau[s]?|prata[s]?)`

// Valor aproximado, como se fala quando não se lembra o centavo: "gastei UNS
// 50", "botei MAIS OU MENOS 80". Sem consumir isso o número não fica logo
// depois do verbo e o lançamento inteiro se perdia. Substitui o antigo
// `(?:mais\s+)?` — "mais ou menos" vem antes de "mais" na alternância para a
// forma longa ganhar.
const APROX = String.raw`(?:(?:mais\s+ou\s+menos|uns|umas|cerca\s+de|em\s+torno\s+de|aproximadamente|quase|tipo|mais)\s+)?`

// Combustível como se digita no celular, com os erros de sempre. Escrever
// "gazolina" não pode tirar o gasto do custo de combustível do motorista.
const COMBUSTIVEL = String.raw`(?:ga[sz]olina|gasolna|etanol|[áa]lcool|alcool|diesel|d[ie]zel|gnv|combust[íi]vel)`

const MAINT_ITEMS = ['óleo', 'oleo', 'pneu', 'pneus', 'pastilha', 'pastilhas', 'freio', 'freios', 'correia', 'filtro', 'filtros', 'vela', 'velas', 'amortecedor', 'amortecedores', 'bateria', 'embreagem']
function normalizeMaint(item: string): string {
  const i = item.toLowerCase().replace(/s$/, '')
  if (i === 'oleo') return 'óleo'
  return i
}

/** Extrai um valor "X mil" ou número com sufixo km */
function parseKmValue(raw: string): number {
  let v = parseNum(raw)
  // "220.800 mil km" aparece na fala coloquial, mas 220.800 já é 220800.
  // Só multiplica "mil" quando o número ainda está abaixo de mil ("84 mil").
  if (/mil/.test(raw) && v < 1000) v *= 1000
  return v
}

/** Registro de manutenção iniciado sem custo. O hodômetro nunca é o preço. */
export function maintenanceWithoutCost(text: string): Omit<Extract<ParsedAction, { kind: 'maintenance' }>, 'cost'> | null {
  const item = text.match(new RegExp(String.raw`^\s*(?:eu\s+)?(?:j[áa]\s+)?(?:troquei|instalei|coloquei)\s+(?:o\s+|a\s+|os\s+|as\s+)?(${MAINT_ITEMS.join('|')})\b`, 'i'))
  if (!item) return null
  const km = text.match(/\b(?:com|aos|a|em|no|nos)\s+(\d+(?:[.,]\d+)?\s*(?:mil)?)\s*(?:km|quil[oô]metros?)\b/i)
  const vida = text.match(/\b(?:a\s+)?cada\s+(\d+(?:[.,]\d+)?\s*(?:mil)?)\s*(?:km|quil[oô]metros?)\b/i)
  let semMedidas = text
  if (km) semMedidas = semMedidas.replace(km[0], ' ')
  if (vida) semMedidas = semMedidas.replace(vida[0], ' ')
  if (/\d/.test(semMedidas)) return null
  return { kind: 'maintenance', item: normalizeMaint(item[1]),
    ...(km ? { km: parseKmValue(km[1]) } : {}), ...(vida ? { lifeKm: parseKmValue(vida[1]) } : {}) }
}

// Verbos que iniciam um novo comando — usados para quebrar frases compostas
// como "rodei no uber e ganhei 300 reais coloquei 70 de gasolina".
const COMMAND_VERBS = ['ganhei', 'recebi', 'faturei', 'lucrei', 'gastei', 'paguei', 'comprei', 'parcelei', 'passei', 'troquei', 'instalei', 'abasteci', 'coloquei', 'botei', 'rodei', 'andei', 'dirigi', 'percorri', 'trabalhei', 'quero', 'fiz', 'guardei', 'guarda', 'guardar', 'separei', 'separa', 'muda', 'mudar', 'altera', 'alterar', 'aumenta', 'aumentar', 'diminui', 'diminuir', 'retira', 'retirei', 'tira', 'tirei', 'remove', 'removi', 'desconta', 'descontei', 'reduz', 'reduzi', 'corrige', 'corrigi']

// Verbos que indicam correção/subtração de um registro de trabalho já lançado
// ("retira 100km rodados", "diminui 80 km dos rodados hoje", "tira 2 viagens")
const WORK_SUB_VERBS = String.raw`retira|retirei|tira|tirei|remove|removi|desconta|descontei|diminui|diminuir|reduz(?:e|i)?|corrige|corrigi`

// Conectores que ligam dois comandos na mesma mensagem: "gastei 79 de gás,
// DEPOIS gastei mais 190 de cimento". Sem isso a segunda ação se perdia.
const CONNECTOR = String.raw`(?:e\s+)?(?:logo\s+)?(?:depois|em\s+seguida|mais\s+tarde|tamb[ée]m|ent[ãa]o|a[ií])\s+`

/** Palavras funcionais que nunca são o objeto real da despesa (item 27). */
const DESC_STOPWORDS = new Set([
  // Unidade abreviada e o "d" de "de": "35 CNTO no mcdonalds", "120 D luz",
  // "40 RS no bar" ficavam na descrição.
  'd', 'rs', 'r', 'cnto', 'cto', 'ctos', 'conto', 'contos', 'pila', 'pilas', 'reais', 'real', 'mango', 'mangos',
  'colocando', 'comprando', 'pagando', 'gastando', 'depois', 'pois', 'logo', 'entao', 'então',
  'tambem', 'também', 'ainda', 'mais', 'de', 'do', 'da', 'no', 'na', 'em', 'com', 'para', 'pra', 'pro', 'pros', 'pras',
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  // Gíria de dinheiro é a UNIDADE do valor, nunca o objeto do gasto.
  'reais', 'real', 'conto', 'contos', 'pila', 'pilas', 'mango', 'mangos', 'pau', 'paus', 'prata',
  // Conjunção residual: a quebra em cláusulas deixa "gastei 100 e" e sem isto
  // a descrição do lançamento virava a letra "E".
  'e',
  // Abreviações de celular e palavras interrogativas: "cimento hj" e
  // "mercado quanto" eram descrições reais antes desta lista.
  'hj', 'hje', 'ontm', 'dps', 'pq', 'q', 'blz', 'vc', 'tbm', 'msm',
  'quanto', 'quantos', 'quantas', 'qual', 'quais', 'quando', 'como', 'onde',
  'sobrou', 'sobra', 'ainda', 'tenho', 'agora', 'entao',
])

/**
 * Limpa a descrição extraída removendo palavras funcionais SÓ das pontas.
 * Remoção no meio destruiria nomes legítimos ("gás de cozinha",
 * "material de construção"), por isso nunca é feita.
 */
const VERBO_NO_INICIO = new Set(['gasto', 'gastos', 'pago', 'compro'])

// Palavra que só sobra no FIM de uma descrição cortada no meio da frase:
// "12 de iof SEM eu saber" gravava "Iof sem". No início ela pode ser nome
// ("Sem Parar"), por isso a lista é só do fim.
const FIM_SOLTO = new Set(['sem', 'que', 'porque', 'mas', 'quando', 'se', 'por', 'ai', 'aí', 'la', 'lá', 'hoje', 'ontem', 'agora', 'tipo', 'ne', 'né', 'veio', 'chegou', 'ficou', 'deu'])

/** "Celular" → "celular" no meio da frase; "IPTU", "iPhone" e "Casa 1" ficam. */
const noMeioDaFrase = (d: string): string =>
  /^[A-ZÀ-Þ][a-zà-ÿ]/.test(d) && !/^[A-ZÀ-Þ][a-zà-ÿ]*\s+\d/.test(d) ? d[0].toLowerCase() + d.slice(1) : d

export function cleanDescription(raw?: string): string | undefined {
  if (!raw) return undefined
  // "No ifood ontem À NOITE": a hora do dia não é parte do que foi comprado.
  // Só com preposição — "café da manhã" continua sendo o café da manhã.
  const words = raw.toLowerCase().replace(/[.,;!?]+$/g, '')
    .replace(/\s+(?:a|à|de|pela|pelo|na|no|hoje|ontem)\s+(?:noite|tarde|manh[ãa]|madrugada|cedinho|cedo|almo[çc]o)$/i, '')
    // O MEIO de pagamento não é o que foi comprado: "mercado no débito".
    .replace(/\s+(?:no|em|pelo|via|com)\s+(?:d[ée]bito|pix|dinheiro|esp[ée]cie|cart[ãa]o\s+de\s+d[ée]bito)$/i, '')
    .split(/\s+/).filter(Boolean)
  // O verbo no presente só sai do INÍCIO: "gasto 50 de luz" gravava "Gasto de
  // luz", mas no fim o "pago" é nome ("Mercado Pago").
  while (words.length && (DESC_STOPWORDS.has(words[0]) || VERBO_NO_INICIO.has(words[0]))) words.shift()
  while (words.length && (DESC_STOPWORDS.has(words[words.length - 1]) || FIM_SOLTO.has(words[words.length - 1]))) words.pop()
  const out = words.join(' ').trim()
  // Um número sozinho nunca descreve um gasto: "gastei 20 e 30" deixava a
  // descrição "30" no primeiro lançamento, escondendo ali o segundo valor.
  if (!out || /^[\d\s.,r$]+$/i.test(out)) return undefined
  return sentenceCase(out)
}

/**
 * Verbo EXPLÍCITO de dinheiro saindo. "Aluguel", "salário", "comissão" e
 * "freela" são renda para quem recebe e gasto para quem paga — o substantivo
 * sozinho não decide o tipo. Quando a cláusula diz que PAGOU, nenhuma regra
 * guiada pelo substantivo pode criar receita ali.
 */
const VERBO_DE_PAGAR = /\b(?:paguei|pagou|pagamos|pago|paga|gastei|gastou|comprei|comprou|torrei|quitei|quitou|saiu)\b/i

/** Verbo EXPLÍCITO de dinheiro entrando. O par de `VERBO_DE_PAGAR`. */
const VERBO_DE_RECEBER = /\b(?:recebi|recebeu|recebemos|ganhei|ganhou|caiu|cairam|ca[íi]ram|entrou|entraram|pingou|faturei|lucrei)\b/i

/**
 * SUBSTANTIVO FINANCEIRO AMBÍGUO: sozinho, não diz direção nenhuma.
 *
 * "Aluguel" é renda de quem aluga e despesa de quem mora; "vale alimentação" é
 * benefício que entra e dinheiro que sai quando se gasta dele. Sem verbo,
 * "o aluguel foi 1800" propunha receita de 1800 E despesa de 1800 — o mesmo
 * dinheiro somado e subtraído, com os dois botões na tela.
 *
 * A lista é curta e fechada porque é uma decisão de TIPO: um substantivo a mais
 * aqui transforma um registro que funciona numa pergunta desnecessária.
 */
const SUBSTANTIVO_AMBIGUO = /\b(alugu[eé]l|alugu[eé]is|vale(?:\s+(?:alimenta[çc][ãa]o|refei[çc][ãa]o|transporte))?)\b/i

/**
 * O que pode existir ENTRE o substantivo ambíguo e o valor dele: preposição,
 * artigo, cópula e o próprio verbo de dinheiro. Qualquer outro substantivo no
 * meio quer dizer que o número é de outra coisa.
 */
const FUNCIONAL_ENTRE = /^(?:\s|de|do|da|dos|das|em|no|na|por|pra|para|r\$|:|-|que|o|a|os|as|meu|minha|este|esse|deste|desse|m[eê]s|foi|era|[ée]|eh|ficou|deu|saiu|recebi|recebeu|paguei|pagou|ganhei|entrou|caiu|gastei|total|valor)*$/i

/** Direção dita pelo verbo da frase. `null` = a frase não decidiu (ou disse as duas). */
function polaridadeDita(text: string): 'income' | 'expense' | null {
  const paga = VERBO_DE_PAGAR.test(text)
  const recebe = VERBO_DE_RECEBER.test(text)
  if (paga === recebe) return null
  return paga ? 'expense' : 'income'
}

/**
 * O trecho da frase que pertence a UMA receita: do separador anterior ao
 * seguinte. Numa frase com dinheiro entrando e saindo, a categoria da receita
 * não pode vir de uma palavra da outra metade — "recebi 3200 e ja saiu 1100 do
 * aluguel" punha a receita em Aluguéis.
 */
function janelaLocal(text: string, inicio: number, fim: number): string {
  const SEP = /\s+e\s+|,(?!\d)|;/gi
  let de = 0
  let ate = text.length
  for (const m of text.matchAll(SEP)) {
    const at = m.index || 0
    if (at + m[0].length <= inicio) de = at + m[0].length
    else if (at >= fim) { ate = at; break }
  }
  return text.slice(de, ate)
}

/**
 * Grupos de corrida com quantidade e valor: "3 corridas de 40 e uma de 25" →
 * [{n: 3, v: 40}, {n: 1, v: 25}], com o trecho de cada um (a checagem de
 * valores soltos ignora os números de dentro). O primeiro grupo precisa dizer
 * "corridas/viagens" e ter mais de uma; os seguintes vêm depois de "e" ou
 * vírgula. "10 corridas de 15 km" não é valor.
 */
export function gruposDeCorrida(text: string): { n: number, v: number, start: number, end: number }[] {
  const QTD = String.raw`(\d+|uma|um|duas|dois|tres|três|quatro|cinco)`
  const qtd = (s: string) => /^\d+$/.test(s) ? parseInt(s, 10)
    : ({ um: 1, uma: 1, dois: 2, duas: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5 } as Record<string, number>)[s.toLowerCase()] ?? NaN
  const VALOR = String.raw`\s+(?:de|por)\s*(?:r\$)?\s*${NUM}(?![\d.,]|\s*(?:km|quil|horas?|h\b|litros?|min))`
  const primeiro = text.match(new RegExp(String.raw`\b${QTD}\s+(?:corridas|viagens)${VALOR}`, 'i'))
  if (!primeiro || !(qtd(primeiro[1]) > 1) || !(parseNum(primeiro[2]) > 0)) return []
  const inicio = primeiro.index || 0
  const fim = inicio + primeiro[0].length
  const out = [{ n: qtd(primeiro[1]), v: parseNum(primeiro[2]), start: inicio, end: fim }]
  for (const g of text.slice(fim).matchAll(new RegExp(String.raw`(?:\be\s+|,\s*)(?:mais\s+)?${QTD}${VALOR}`, 'gi'))) {
    const n = qtd(g[1])
    const v = parseNum(g[2])
    if (!(n > 0) || !(v > 0)) continue
    out.push({ n, v, start: fim + (g.index || 0), end: fim + (g.index || 0) + g[0].length })
  }
  return out
}

/**
 * "Celular" é a palavra da CONTA ("paguei 60 do celular" → Assinaturas), mas
 * comprar o aparelho é compra: "comprei um celular de 1200 em 10x" ia para
 * Assinaturas. Só troca a categoria que veio da palavra "celular".
 */
/** "Comprei um celular": o APARELHO, não a conta do celular (Assinaturas). */
export const compraDeAparelho = (texto: string): boolean =>
  /\b(?:comprei|compramos|parcelei|comprar)\s+(?:um|uma|o|a|meu|minha)?\s*(?:novo\s+|nova\s+)?(?:celular|smartphone|iphone|aparelho\s+de\s+celular)\b/i.test(texto)

function aparelhoComprado(texto: string, actions: ParsedAction[]): ParsedAction[] {
  if (!compraDeAparelho(texto)) return actions
  return actions.map(a => (a.kind === 'expense' || a.kind === 'card-purchase') && a.category === 'assinaturas'
    ? { ...a, category: 'compras' } : a)
}

function splitClauses(input: string): string[] {
  const marked = input
    .toLowerCase()
    .replace(new RegExp(String.raw`[\s,;]+(?:${CONNECTOR})?(?:e\s+)?(?=(?:${COMMAND_VERBS.join('|')})\b)`, 'g'), '\n')
  return marked.split(/\n|;|\.\s/).map(s => s.trim()).filter(Boolean)
}

const VERBO_DE_GASTO_LISTA = /\b(?:gastei|gasto|paguei|comprei|torrei|abasteci|coloquei|botei|saiu|saiu|foi\s+(?:de|com)|dei)\b/gi

/**
 * "O banco ME COBROU 45 de tarifa", "me cobraram 30 de taxa": o dinheiro saiu.
 * Lido como "paguei", com quem cobrou virando o lugar quando a frase não diz
 * outro ("o mecânico me cobrou 500" → "paguei 500 no mecânico"). Sem isso o
 * leitor sem verbo usava a frase inteira como descrição.
 */
/**
 * "A Casa 1 PAGOU 1800", "o inquilino da Casa 2 pagou 1200", "o cliente
 * pagou 300": a fonte do próprio usuário pagou — o dinheiro entrou. Sem
 * "me", a frase era lida como movimento de outra pessoa e nada era registrado.
 */
function fontePagou(input: string): string {
  const m = input.match(/^\s*(?:a|o)\s+((?:inquilin[oa](?:\s+d[ao]\s+(?:casa|kitnet|apartamento|apto|loja|sala)\s+[\p{L}\d]+)?)|(?:casa|kitnet|apartamento|apto|loja|sala)\s+[\p{L}\d]+|cliente(?:\s+[\p{Lu}][\p{L}]+)?|empresa|patr[ãa]o)\s+(?:j[áa]\s+)?pag(?:ou|aram)\s+((?:r\$\s*)?\d+(?:[.,]\d+)*)(?![\d.,])(?!\s*(?:reais\s+)?(?:n[oa]s?|em)\s)(.*)$/iu)
  if (!m) return input
  const fonte = m[1].replace(/^inquilin[oa]\s+d[ao]\s+/i, '')
  if (/^inquilin[oa]$/i.test(fonte)) return `recebi ${m[2]} do inquilino${m[3]}`
  return `recebi ${m[2]} d${/^(?:casa|kitnet|loja|sala|empresa)/i.test(fonte) ? 'a' : 'o'} ${fonte}${m[3]}`
}

function cobrancaRecebida(input: string): string {
  const m = input.match(/^\s*(?:(o|a|os|as)\s+)?((?:[\p{L}]+)(?:\s+[\p{L}]+)?)?\s*\bme\s+cobr(?:ou|aram)\s+(.+)$/iu)
  if (!m || (m[2] && /^(?:eu|ele|ela|eles|elas|voc[eê]|que|quem|quanto)$/i.test(m[2].trim()))) return input
  const resto = m[3]
  const soValor = /^(?:r\$\s*)?\d[\d.,]*\s*(?:reais|real|conto|contos)?\s*$/i.test(resto)
  const lugar = soValor && m[2] ? ` ${m[1] && /^a/i.test(m[1]) ? 'na' : 'no'} ${m[2].trim()}` : ''
  return `paguei ${resto}${lugar}`
}

/**
 * "DEI 20 pro flanelinha", "COMI um pastel de 12", "TOMEI um café de 8": o
 * dinheiro saiu, só que o verbo não é de pagar. Lidos como "paguei" — antes
 * caíam na ajuda genérica ou gravavam "Tomei um café" como descrição.
 */
function verboDeConsumo(input: string): string {
  // "A conta de luz veio 180 e já paguei": o pagamento fecha a conta que veio.
  const paga = input.match(/^\s*(?:a\s+|minha\s+)?conta\s+d([aeo])\s+([\p{L}]+(?:\s+[\p{L}]+)?)\s+(?:veio|chegou)\s+(?:de\s+|em\s+)?((?:r\$\s*)?\d+(?:[.,]\d+)*)\s*(?:reais)?\s*,?\s*e\s+(?:j[áa]\s+)?(?:paguei|quitei)\b.*$/iu)
  if (paga) return `paguei ${paga[3]} de conta d${paga[1]} ${paga[2]}`
  // "Minha LUZ veio 230 e já paguei": a mesma conta, sem a palavra "conta".
  const semConta = input.match(/^\s*(?:a\s+|o\s+|minha\s+|meu\s+)?(luz|[áa]gua|energia|internet|net|g[áa]s|telefone|celular|condom[íi]nio|iptu|ipva)\s+(?:veio|chegou)\s+(?:de\s+|em\s+)?((?:r\$\s*)?\d+(?:[.,]\d+)*)\s*(?:reais)?\s*,?\s*e\s+(?:j[áa]\s+)?(?:paguei|quitei)\b.*$/iu)
  if (semConta) return `paguei ${semConta[2]} de ${semConta[1]}`
  return input
    .replace(/^((?:\s*(?:eu|hoje|hj|ontem|anteontem)\b)*\s*)dei\s+(?=(?:r\$\s*)?\d)/i, '$1paguei ')
    .replace(/^((?:\s*(?:eu|hoje|hj|ontem|anteontem)\b)*\s*)(?:comi|tomei|bebi)\s+(?:(um|uma|uns|umas)\s+)?(?=[\p{L}][^\d]*\d)/iu, (_m, pre, art) => `${pre}paguei ${art || 'um'} `)
}

/** "13º", "13o salário": o décimo terceiro, nunca R$ 13. */
export const DECIMO_TERCEIRO = /(?<![\d.,])13\s*[º°o](?:\s+sal[áa]rio)?(?![\wÀ-ÿ])|(?<![\d.,])13\s+sal[áa]rio(?![\wÀ-ÿ])/gi

/** "1/3 do aluguel", "1/2 da conta": fração de algo, nunca valor nem data. */
export const FRACAO_DE = /(?<![\d\/.,])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d\/])(?=\s+d[oa]s?\s)/g

/**
 * "Paguei o aluguel, 400", "gastei no mercado, 230", "paguei o mecânico: 350":
 * o valor depois da vírgula. A descrição sumia, e com dois-pontos nada era
 * registrado. Reescrito como "paguei 400 o aluguel", a forma que o parser lê.
 */
function valorNoFim(input: string): string {
  const m = input.match(/^(\s*(?:(?:eu|hoje|hj|ontem|anteontem)\s+)*)(gastei|paguei|comprei|torrei|recebi|ganhei|dei)\s+([^\d,:;?]{2,60}?)\s*([,:;]?)\s*(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais|real|contos?|pila)?\s*[.!]?\s*$/i)
  if (!m) return input
  // Sem vírgula ("paguei a pensão 600"), o número pode ser parte de um NOME:
  // "a parcela 3", "a casa 2", "o cliente 1". Aí não é valor.
  if (!m[4] && /(?:^|\s)(?:parcela|presta[çc][ãa]o|casa|apto|apartamento|loja|sala|kitnet|quarto|cliente|n[ºo°]?|numero|n[úu]mero|lote|bloco|vaga)$/i.test(m[3].trim())) return input
  // "Um celular DE 900", "a taxa DA 99": a preposição já liga o número à coisa
  // — a frase está na forma que o parser lê, e "99" ali é a plataforma.
  if (/(?:^|\s)(?:de|da|do|das|dos|na|no|nas|nos|pela|pelo|em|com|por|a|o)$/i.test(m[3].trim())) return input
  return `${m[1]}${m[2]} ${m[5]} ${m[3].trim()}`
}

export function parseNatural(input: string): ParsedAction[] {
  input = verboDeConsumo(cobrancaRecebida(fontePagou(valorNoFim(input.replace(DECIMO_TERCEIRO, 'décimo terceiro').replace(FRACAO_DE, 'parte')))))
  // Operações de cartão são analisadas na frase INTEIRA antes de qualquer
  // quebra: "passei 2000 em 5 vezes E RECEBI 1850" tem um verbo de comando no
  // meio, e cortar ali transformava uma entrada financiada numa receita de
  // 1850 — exatamente o que a regra 11 proíbe.
  const whole = parseCardClause(input.toLowerCase().trim())
  if (whole.length) return aparelhoComprado(input, whole)

  // Cláusula que é só a palavra de pergunta volta para a seguinte: cortada no
  // verbo, "quanto | paguei de fatura" deixava a segunda metade sem o que a faz
  // pergunta, e ela virava pagamento de fatura (regra 33).
  const clauses = splitClauses(input).reduce<string[]>((acc, c) => {
    const anterior = acc[acc.length - 1]
    if (anterior !== undefined && SO_PALAVRA_DE_PERGUNTA.test(anterior)) acc[acc.length - 1] = `${anterior} ${c}`
    else acc.push(c)
    return acc
  }, [])
  let actions = clauses.length > 1
    ? clauses.flatMap(c => aparelhoComprado(c, parseClause(c)))
    : aparelhoComprado(clauses[0] ?? input, parseClause(clauses[0] ?? input))

  // funde múltiplos registros de trabalho (km + viagens + horas) em um só
  const works = actions.filter(a => a.kind === 'work') as Extract<ParsedAction, { kind: 'work' }>[]
  if (works.length > 1) {
    const merged = works.reduce((m, w) => ({
      kind: 'work' as const,
      km: (m.km || 0) + (w.km || 0) || undefined,
      trips: (m.trips || 0) + (w.trips || 0) || undefined,
      hours: (m.hours || 0) + (w.hours || 0) || undefined,
    }))
    actions = actions.filter(a => a.kind !== 'work')
    actions.push(merged)
  }

  // Remove duplicatas exatas — a mesma ação lida duas vezes — mas só até o
  // número de vezes que aquele VALOR aparece na frase. "Recebi 120 da Casa 2 e
  // 120 da Casa 1" tem duas receitas iguais como objeto (a origem entra depois,
  // na cláusula) e dois "120" no texto: as duas existem.
  // Primeiro, uma de cada; depois, a cópia idêntica só volta enquanto o TOTAL
  // de ações com aquele valor (de qualquer descrição) couber nas ocorrências
  // do valor no texto. "90 na farmácia e 90 no mercado" lido duas vezes no
  // mercado tem três ações para dois "90": a cópia não volta.
  const seen = new Set<string>()
  const unicas: ParsedAction[] = []
  const copias: ParsedAction[] = []
  for (const a of actions) {
    const k = JSON.stringify(a)
    if (seen.has(k)) copias.push(a)
    else { seen.add(k); unicas.push(a) }
  }
  const porValor = new Map<number, number>()
  for (const a of unicas) {
    const v = (a as any).amount
    if (typeof v === 'number' && v > 0) porValor.set(v, (porValor.get(v) || 0) + 1)
  }
  const ocorrencias = new Map<number, number>()
  if (copias.length) {
    for (const match of input.matchAll(/(?<![\d.,-])\d+(?:[.,]\d+)*(?!\d|[.,]\d)/g)) {
      const valor = parseNum(match[0])
      ocorrencias.set(valor, (ocorrencias.get(valor) || 0) + 1)
    }
  }
  const voltam = new Set<ParsedAction>()
  for (const a of copias) {
    const v = (a as any).amount
    if (!(typeof v === 'number' && v > 0)) continue
    const n = porValor.get(v) || 0
    if (n < (ocorrencias.get(v) || 1)) { voltam.add(a); porValor.set(v, n + 1) }
  }
  return actions.filter(a => unicas.includes(a) || voltam.has(a))
}

// ---------- AMBIGUIDADE DO "GÁS" (item 26) ----------
// No Rio, "gás" tanto é o botijão de cozinha quanto o GNV do carro. Sem contexto
// suficiente o app NÃO escolhe: pergunta. Escolher sozinho erra a categoria e
// contamina o custo por km do motorista.
const GAS_MENTION = /\bg[áa]s\b|\bg[áa]s\s|\bgas\b/i
const GAS_KITCHEN = /g[áa]s\s+de\s+cozinha|botij[ãa]o|\bglp\b|g[áa]s\s+da\s+casa|g[áa]s\s+de\s+casa/i
const GAS_VEHICLE = /\bgnv\b|g[áa]s\s+veicular|g[áa]s\s+do\s+carro|abasteci\s+com\s+g[áa]s|posto\s+de\s+g[áa]s|g[áa]s\s+no\s+carro/i

export interface ParseResult {
  actions: ParsedAction[]
  /**
   * Pergunta obrigatória antes de qualquer registro. Cada opção já carrega a
   * lista COMPLETA de ações resolvidas — as demais ações da mensagem são
   * preservadas em todas as alternativas.
   */
  ambiguity?: {
    question: string
    options: { label: string; actions: ParsedAction[] }[]
  }
}

/** É menção a gás sem qualificação suficiente para decidir a categoria? */
export function isAmbiguousGas(text: string): boolean {
  return GAS_MENTION.test(text) && !GAS_KITCHEN.test(text) && !GAS_VEHICLE.test(text)
}

// ---------- RESULTADO DO DIA DO MOTORISTA (item 41) ----------
// Quem roda o dia inteiro não escreve "ganhei 150": escreve "hoje foi fraco só
// 150", "deu 200 hoje", "fechei o dia com 280". Sem esta regra a receita do dia
// se perdia por completo — e, pior, "foi 400 hoje" caía no verbo de DESPESA e
// registrava o faturamento do dia como gasto, invertendo o sinal do dinheiro.
//
// A regra é EXCLUSIVA do perfil motorista: para os outros perfis um valor solto
// junto de "hoje" não tem leitura padrão nenhuma, e chutar seria invenção.

/** Verbo de gasto explícito. Onde ele aparece, a leitura é gasto e ponto. */
const STRONG_EXPENSE_VERB = /\b(?:gastei|paguei|comprei|torrei|coloquei|botei|abasteci|enchi|parcelei|passei|guardei|separei|dei|comi|tomei|bebi)\b/i
const DAY_WORD = /\b(?:hoje|hj|ontem|anteontem|o\s+dia|no\s+dia|dia|na\s+rua|de\s+rua|no\s+corre|na\s+ativa|na\s+labuta|no\s+trampo|rodando)\b/i
const DAY_RESULT_VERB = /\b(?:deu|deram|fez|fiz|foi|fechei|fechou|tirei|tirou|rendeu|rendi|saiu|bati|consegui|entrou)\b/i
const DAY_QUALIFIER = /\b(?:fraco|fraca|fraquinho|bom|boa|[óo]tim[oa]|ruim|puxad[oa]|parad[oa]|movimentad[oa]|tranquil[oa]|l[íi]quido|limpo|s[óo]|apenas|somente)\b/i
const MONEY_MARK = /r\$|\breais\b|\bconto?s?\b|\bpila\b|\bmang[oa]s?\b/i

/**
 * Conta que SE REPETE. Mora aqui, e não no segmentador, porque `clauses.ts`
 * importa este módulo — o contrário seria ciclo. Quem precisa da checagem no
 * orquestrador usa o reexport de `clauses.ts`, para a lista existir uma vez só.
 *
 * "Todo dia 10" é DIA DE VENCIMENTO, não o resultado do dia: sem esta guarda a
 * regra do resultado do dia perguntava "esses R$ 150 foram ganho ou gasto?"
 * para quem estava descrevendo a conta de luz.
 */
const RECORRENCIA = new RegExp([
  String.raw`\btod[oa]s?\s+(?:o\s+)?(?:m[eê]s|m[eê]ses|dia\s+\d{1,2}|semana|ano)\b`,
  String.raw`\b(?:por|ao|a\s+cada)\s+m[eê]s\b`,
  String.raw`\bmensalmente\b|\btodo\s+m[eê]s\b|\bmensal\b`,
  String.raw`\bcada\s+\d{1,2}\s+(?:dias|semanas|meses)\b`,
  // "Meu salário cai dia 5": o presente diz que se repete ("caiu" é registro).
  // "Vence dia N" fica de fora: colide com pergunta sobre a fatura.
  String.raw`\b(?:cai|caem|entra|entram)\s+(?:sempre\s+)?(?:todo\s+)?(?:no\s+)?dia\s+\d{1,2}\b`,
].join('|'), 'i')

export const looksRecurring = (t: string): boolean => RECORRENCIA.test(t)

// Número que carrega unidade não é dinheiro: "8 horas", "120 km", "14 viagens".
// Unidade de TEMPO também: "nos ultimo 3 mes" virava uma despesa de R$ 3,00,
// porque o 3 é o tamanho do período e a frase inteira era uma pergunta.
const UNIT_AFTER = String.raw`\s*(?:h\b|horas?\b|hrs?\b|km\b|quil[oô]metros?\b|m\b|metros?\b|viagens?\b|corridas?\b|litros?\b|l\b|%|minutos?\b|min\b|vezes\b|x\b|dias?\b|semanas?\b|m[eê]s(?:es)?\b|anos?\b)`
const MEASURE_AFTER_AMOUNT = new RegExp(`^${UNIT_AFTER}`, 'i')

/**
 * Pergunta, em qualquer posição da frase, inclusive abreviada. "qnto q foi d
 * obra" não começa por "quanto" e "obra 3 meses quanto" termina por ele: as
 * duas passavam pela guarda que só olhava o começo da frase.
 */
const PERGUNTA_EM_QUALQUER_LUGAR = /\?|\b(?:quanto|quantos|quantas|qual|quais|quando|onde|qnto|qnta|qntos|qntas|qnt|qto|qta|qts|qnd|qndo)\b/i
/** "quanto", "quanto eu", "e quando que eu": a pergunta sem o resto da frase. */
const SO_PALAVRA_DE_PERGUNTA = /^(?:e\s+)?(?:quanto|quantos|quantas|qual|quais|quando|onde|qnto|qto|qnd|qndo)(?:\s+(?:que|eu|voce|vc|a\s+gente|ja|foi\s+que))*$/i
const HOURS_ANY = new RegExp(String.raw`${NUM}\s*(?:horas?|hrs?|h)\b`, 'i')

/** Valores monetários de um texto, já descartando o que é unidade. */
function moneyValuesIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(new RegExp(String.raw`(?:r\$\s*)?${NUM}`, 'gi'))) {
    const after = text.slice((m.index || 0) + m[0].length)
    if (new RegExp(`^${UNIT_AFTER}`, 'i').test(after)) continue
    const v = parseNum(m[1])
    if (v > 0) out.push(v)
  }
  return out
}

interface DayResult {
  actions: ParsedAction[]
  /** Valor solto demais para decidir sozinho — pergunta em vez de chutar. */
  ask?: NonNullable<ParseResult['ambiguity']>
}

function driverDayResult(input: string, actions: ParsedAction[], dayHint?: boolean): DayResult | null {
  const t = input.toLowerCase()
  if (STRONG_EXPENSE_VERB.test(t)) return null
  // "Todo dia 10" é vencimento de conta, não o resultado do dia de trabalho.
  if (RECORRENCIA.test(t)) return null
  // O `dayHint` existe porque quem segmenta a mensagem ARRANCA a expressão de
  // data antes de chamar o parser: "deu 200 hoje" chega aqui como "deu 200".
  // Sem o aviso, o contexto de dia — que é o que dá sentido ao valor — some.
  if (!dayHint && !DAY_WORD.test(t)) return null

  // `work` e `odometer` descrevem o dia, não o dinheiro dele: convivem com a
  // receita do resultado. Qualquer outra ação significa que a frase já foi
  // entendida por um caminho melhor e não pode ser reinterpretada.
  const monetary = actions.filter(a => a.kind !== 'work' && a.kind !== 'odometer')
  // "foi 400 hoje" vira despesa porque `foi` é verbo de gasto no parser. Sem
  // verbo de gasto explícito na frase, essa despesa é o faturamento do dia.
  const weak = monetary.length === 1 && monetary[0].kind === 'expense' ? monetary[0] : null
  if (monetary.length && !weak) return null

  const amount = weak ? (weak as any).amount : moneyValuesIn(t)[0]
  if (!(amount > 0)) return null

  const rest = actions.filter(a => a !== weak)

  // Horas ditas sem qualificação ("foi 400 hoje 12 horas") só são jornada
  // dentro deste contexto — fora dele, um número seguido de "h" pode ser hora
  // do relógio.
  const jaTemHoras = rest.some(a => a.kind === 'work' && (a as any).hours)
  const hm = jaTemHoras ? null : t.match(HOURS_ANY)
  const comHoras = hm
    ? [...rest, { kind: 'work', hours: parseNum(hm[1]) } as ParsedAction]
    : rest

  // A plataforma dita fica na receita: sem ela, "hj deu 300 uber" não contava
  // para a Uber no "qual plataforma paga melhor". O "99" só com preposição — sem
  // ela, pode ser o próprio valor.
  const plataforma = /\buber\b/.test(t) ? 'Uber'
    : /\bin\s*driver?\b/.test(t) ? 'inDrive'
      : /\b(?:n[ao]|d[ao]|pel[ao])\s+99\b/.test(t) ? '99' : undefined
  const income: ParsedAction = { kind: 'income', amount, category: 'corridas', ...(plataforma ? { description: plataforma } : {}) }

  // Sinal forte de resultado (verbo, qualificação ou marca de dinheiro) decide
  // sozinho. "hoje 250", sem nenhum deles, é ambíguo de verdade: pergunta.
  if (DAY_RESULT_VERB.test(t) || DAY_QUALIFIER.test(t) || MONEY_MARK.test(t)) {
    return { actions: [income, ...comHoras] }
  }

  return {
    actions: comHoras,
    ask: {
      question: `Esses ${fmtBRL(amount)} foram o que você ganhou ou o que você gastou?`,
      options: [
        { label: 'Ganhei', actions: [income, ...comHoras] },
        { label: 'Gastei', actions: [{ kind: 'expense', amount, category: 'outros-out' }, ...comHoras] },
      ],
    },
  }
}

/**
 * Corrida CANCELADA não pagou nada: "cancelaram a corrida de 30" virava R$ 30
 * de receita e 1 viagem. A taxa de cancelamento, quando dita, é receita.
 */
export const CORRIDA_CANCELADA = /(?<![\wÀ-ÿ])(?:cancel(?:aram|ou|ei|amos)\b[^.;!?]*\bcorridas?\b|corridas?\b[^.;!?]*\bcancelad[ao]s?\b)/i

export const RIDE_EVALUATION_REQUEST = /\b(?:vale(?:\s+a\s+pena)?|compensa|aceito|pego|(?:devo|posso|vale)\s+(?:aceitar|pegar)|(?:d[áa]|serve)\s+(?:pra|para)\s+(?:aceitar|pegar))\b/i
export const RIDE_COMPARISON_REQUEST = /\b(?:compara|compare|comparar|comparando|qual\s+(?:dessas?\s+)?(?:corrida|oferta)s?\s+(?:paga|rende)\s+mais)\b/i
export const RIDE_CONDITIONAL = /^(?:eu\s+)?(?:tiraria|ganharia|receberia|renderia|pagaria)\b[^.;!?]*\bcorrida\b/i
export const NEXT_RIDE_DISTANCE = /^\s*(?:a\s+)?outra(?=\s+(?:de|por)\s+[^.;!?]*\d\s*(?:kms?|quil[oô]metros?)\b)/i

const APP_DE_CORRIDA = String.raw`(?:uber|99|in\s*drive[r]?)`
const AVISO_DE_CORRIDA = String.raw`(?:oferta|chamada|proposta|solicita[çc][ãa]o)`
const UMA_OFERTA = String.raw`(?:(?:uma|a|outra|nova|essa|esta)\s+)?`
export const RIDE_OFFER_NOTICE = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:(?:tocou|chamou|apareceu|caiu|(?:me\s+)?oferece(?:u|ram))\s+${UMA_OFERTA}corrida|`
  + String.raw`(?:recebi|me\s+(?:mandou|mandaram|enviou|enviaram|ofereceu|ofereceram))\s+${UMA_OFERTA}${AVISO_DE_CORRIDA}`
  + String.raw`(?:\s+de\s+corrida|\s+d[ao]\s+${APP_DE_CORRIDA}|(?=[^.;!?\n]*\s+(?:na|no|da|do|pela|pelo)\s+${APP_DE_CORRIDA}\b)))(?![\p{L}\p{M}])`,
  'iu',
)

/**
 * Reajuste de valor RECORRENTE ("reajustei o aluguel da casa 1 pra 1900") muda
 * a previsão, não é lançamento. O "1" de "Casa 1" virava uma despesa de R$ 1.
 */
export const REAJUSTE = /(?<![\wÀ-ÿ])(?:reajustei|reajustou|reajustaram|aumentei|subi|baixei|abaixei|diminui|atualizei|mudei)\s+(?:o\s+|a\s+)?(?:valor\s+d[oa]\s+)?(?:aluguel|condom[íi]nio|mensalidade|pre[çc]o\s+d[oa]\s+aluguel)(?![\wÀ-ÿ])/i

/**
 * Saque do PRÓPRIO dinheiro: "saquei 200", "tirei 200 do banco", "fiz um
 * saque de 150". Não é ganho nem gasto — o dinheiro só mudou de lugar
 * (regra 69). Tirar da META ou da reserva é outra operação e fica de fora.
 */
export const SAQUE = /(?<![\wÀ-ÿ])(?:saquei|sacamos|fiz\s+um\s+saque|(?:tirei|retirei)\s+(?:r\$\s*)?\d[\d.,]*\s*(?:reais|real|contos?|pila)?\s*(?:d[oa]\s+(?:banco|conta|caixa(?:\s+eletr[oô]nico)?)|n[oa]\s+(?:caixa(?:\s+eletr[oô]nico)?|banco|lot[eé]rica|24\s*horas)|em\s+(?:dinheiro|esp[eé]cie)))(?![\wÀ-ÿ])/i

/**
 * Uma corrida NOMEADA no singular: "uma corrida", "numa viagem", "a corrida",
 * "corrida de 18", "corrida pro aeroporto". "Ganhei 22 DE corrida" é a
 * categoria da receita, não a contagem — fica de fora.
 */
export const UMA_CORRIDA_NOMEADA = /(?<![\p{L}\p{M}])(?:(?:uma|1|numa|outra|mais\s+uma|essa|nessa|esta|nesta|aquela|naquela|daquela|a|na|da|pela|dessa|desta)\s+(?:corrida|viagem)(?![\p{L}\p{M}])|(?<!\bde\s)(?:corrida|viagem)\s+(?:de|por|pro|pra|para|at[eé])\s)/giu

/**
 * Parse completo: além das ações, devolve a pergunta de desambiguação quando o
 * texto não permite decidir com segurança.
 */
export function parseNaturalFull(
  input: string,
  opts?: { driver?: boolean; dayHint?: boolean; inheritedKind?: 'income' | 'expense' },
): ParseResult {
  // Saque não vira receita (nem o "resultado do dia" do motorista) nem gasto.
  if (SAQUE.test(input) && !/\b(?:paguei|gastei|comprei|recebi|ganhei|faturei)\b/i.test(input)) return { actions: [] }
  if (CORRIDA_CANCELADA.test(input) && !/\btaxa\s+de\s+cancelamento\b/i.test(input)) return { actions: [] }
  if (RIDE_OFFER_NOTICE.test(input) && !/\b(?:paguei|gastei|recebi|ganhei|faturei|entrou|me\s+pagaram)\b/i.test(input.replace(RIDE_OFFER_NOTICE, ' '))) {
    return { actions: [] }
  }
  if (REAJUSTE.test(input) && !/\b(?:paguei|gastei|recebi|ganhei)\b/i.test(input)) return { actions: [] }
  let actions = parseNatural(input)
  let dayAsk: DayResult['ask']
  let doDia = false

  // "Gastei 30 ontem e 20 hoje": a segunda metade é só o valor (o dia saiu na
  // análise de cláusulas) e o verbo é o da metade anterior. Sem herdar, os 20
  // sumiam — ou entravam na data de ontem quando a frase não era cortada.
  if (!actions.length && opts?.inheritedKind && !opts.driver) {
    const so = input.trim().match(new RegExp(String.raw`^(?:mais\s+)?(?:r\$\s*)?${NUM}\s*(?:reais|real|conto|contos|pila)?$`, 'i'))
    const valor = so ? parseNum(so[1]) : NaN
    if (valor > 0) {
      actions = [opts.inheritedKind === 'income'
        ? { kind: 'income', amount: valor } as ParsedAction
        : { kind: 'expense', amount: valor, category: 'outros-out' } as ParsedAction]
    }
    // "Recebi 1800 da casa 1 dia 5 E 1200 da casa 2 dia 7": cortada pelos dois
    // dias, a segunda metade é valor + DE ONDE veio, sem verbo. Sem isto os
    // 1200 sumiam em silêncio.
    const comOrigem = !actions.length && opts.inheritedKind === 'income'
      ? input.trim().match(new RegExp(String.raw`^(?:mais\s+)?(?:r\$\s*)?${NUM}\s*${MOEDA}?\s+d[aoe]s?\s+(?:um\s+|uma\s+|o\s+|a\s+)?([a-zà-ú][\wçãõáéíóúâê]*(?:\s+\d+)?)\s*$`, 'i'))
      : null
    if (comOrigem && parseNum(comOrigem[1]) > 0) {
      actions = [{ kind: 'income', amount: parseNum(comOrigem[1]), category: guessCategory(comOrigem[2], 'income') } as ParsedAction]
    }
  }

  // No perfil motorista, uma receita sem origem explícita continua sendo de
  // corridas. Se a frase menciona corrida/Uber/99, o contexto vale também para
  // cláusulas curtas como "ganhei 150" logo após "fiz uma corrida".
  if (opts?.driver) {
    // "hoje FOI 430 na uber e 380 na 99": `foi` é verbo de despesa no parser, e
    // a receita da plataforma JÁ leu esse mesmo dinheiro. O que sobrava era uma
    // despesa gêmea — mesmo valor, mesma descrição, sem categoria — que zerava
    // o dia do motorista. `driverDayResult` não pegava este caso porque ele só
    // converte a despesa fraca quando ela é a ÚNICA ação monetária da frase.
    //
    // O corte é estreito: sem verbo de gasto explícito, e só a despesa que não
    // tem categoria própria e repete o valor de uma receita da mesma mensagem
    // trazendo a MESMA descrição ou nenhuma — os dois jeitos que a despesa
    // fantasma aparece ("foi 430 na uber" traz "Uber", "saiu 250 na 99" vem
    // sem descrição). Despesa de verdade tem categoria ou verbo próprio e
    // continua existindo.
    if (!STRONG_EXPENSE_VERB.test(input.toLowerCase())) {
      const gemea = (a: ParsedAction) => a.kind === 'expense' && !(a as any).category
        && actions.some(b => b.kind === 'income'
          && (b as any).amount === (a as any).amount
          && (!(a as any).description
            || String((b as any).description || '') === String((a as any).description)))
      if (actions.some(gemea)) actions = actions.filter(a => !gemea(a))
    }

    const dia = driverDayResult(workDuration(input).remaining, actions, opts?.dayHint)
    if (dia) {
      actions = dia.actions
      dayAsk = dia.ask
      doDia = !dia.ask
      // "Ontem fiz 280 E HOJE 320": a metade anterior da mensagem já disse se
      // era ganho ou gasto. Herdar o verbo não é o mesmo que ler um valor
      // solto — o usuário DISSE "fiz", só não repetiu. Por isso a ação segue o
      // caminho normal (com a viagem implícita) em vez do resultado do dia, e a
      // mesma frase não trata os dois dias de forma diferente.
      if (dia.ask && opts?.inheritedKind) {
        const escolhida = dia.ask.options.find(o => o.actions[0]?.kind === opts.inheritedKind)
        if (escolhida) {
          actions = escolhida.actions
          dayAsk = undefined
          doDia = false
        }
      }
    }

    // "Fiz 12 corridas E (deu) 260": o valor depois das corridas é o que elas
    // renderam. Só as viagens entravam, e o dinheiro virava uma pergunta.
    if (!actions.some(a => a.kind === 'income') && actions.some(a => a.kind === 'work' && (a.trips || a.km || a.hours))) {
      // O separador é opcional quando há verbo de resultado ("12 corridas DEU
      // 310"), e o valor não precisa fechar a frase: "…deu 310 e rodei 180 km"
      // perdia a receita inteira.
      const verboResultado = 'deu|deram|rendeu|renderam|fiz|faturei|ganhei|foi|foram|tirei|bateu'
      const rendeu = input.match(new RegExp(String.raw`\b(?:corridas|viagens)\b(?:\s+(?:hoje|ontem))?\s*(?:(?:,|\be\b)\s*(?:${verboResultado})?|(?:${verboResultado}))\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?(?=\s*$|\s*[,;.]|\s+e\b)`, 'i'))
      // A jornada pode vir no meio: "fiz 10 corridas E RODEI 120 KM, deu 300".
      const colado = rendeu ? null : input.match(new RegExp(String.raw`\b(?:corridas|viagens)\s+(?:r\$\s*)?${NUM}(?![\d.,])\s*(?:reais|real|contos?|pilas?)\b`, 'i'))
      const depoisDaJornada = rendeu || colado ? null : input.match(new RegExp(String.raw`(?:^|[,;]\s*|\s)(?:deu|deram|rendeu|renderam|faturei|tirei|bateu)\s+(?:r\$)?\s*${NUM}(?![\d.,])\s*${MOEDA}?(?!\s*(?:km|h\b|hrs?|horas?|litros?|l\b|corridas|viagens|%))`, 'i'))
      const valor = rendeu ? parseNum(rendeu[1]) : colado ? parseNum(colado[1]) : depoisDaJornada ? parseNum(depoisDaJornada[1]) : NaN
      if (valor > 0) actions.push({ kind: 'income', amount: valor, category: 'corridas' })
    }

    const rideContext = /\bcorridas?\b|\buber\b|\bindriver\b|\b99\b/i.test(input)
    actions = actions.map(a => a.kind === 'income' && (!a.category || rideContext)
      ? { ...a, category: a.category || 'corridas' }
      : a)

    // Viagem só entra quando o usuário a DISSE (regra 34). "Fiz 14 viagens"
    // vale 14, e "fiz UMA corrida de 35" / "corrida de 18" valem 1 — a frase
    // nomeia uma corrida só. Plataforma não é viagem: "ganhei 430 na Uber"
    // é uma ORIGEM de receita, quase sempre o dia ou o turno inteiro, e cravar
    // "1 viagem" por plataforma inventava o número que o ganho por viagem
    // divide. Sem quantidade dita, o campo fica ausente.
    const hasExplicitTrips = actions.some(a => a.kind === 'work' && a.trips !== undefined)
    const rideIncomes = actions.filter(a => a.kind === 'income' && a.category === 'corridas').length
    const corridasNomeadas = input.match(UMA_CORRIDA_NOMEADA)?.length || 0
    const rideEntries = Math.min(rideIncomes, corridasNomeadas)
    // Gorjeta, bônus e incentivo são receita da corrida, não viagem: "recebi 50
    // de gorjeta" contava 1 viagem e derrubava o ganho por viagem.
    const naoEViagem = /\b(?:gorjetas?|b[oô]nus|incentivos?|promo(?:cao|ção|çao)?|caixinha)\b/i.test(input)
    if (!hasExplicitTrips && rideEntries > 0 && !doDia && !naoEViagem) {
      const work = actions.find(a => a.kind === 'work') as Extract<ParsedAction, { kind: 'work' }> | undefined
      if (work) work.trips = rideEntries
      else actions.push({ kind: 'work', trips: rideEntries })
    }
  }

  if (dayAsk) return { actions, ambiguity: dayAsk }

  // "Paguei 4 E 90 no pão": R$ 4,90 dito como se fala, ou dois gastos? Os dois
  // são possíveis, e somados davam R$ 94,00 sem aviso. Pergunta, com as duas
  // leituras prontas.
  {
    const dito = input.match(/^\s*(?:(?:eu|hoje|hj|ontem)\s+)*(?:gastei|paguei|comprei|torrei|dei)\s+(?:r\$\s*)?(\d{1,2})\s+e\s+(\d{2})(?![\d.,])\s*(?:reais\s+)?(?:n[oa]s?|em|de|com|pr[ao])\s+[^\d]+$/i)
    const gastos = actions.filter(a => a.kind === 'expense') as Extract<ParsedAction, { kind: 'expense' }>[]
    if (dito && gastos.length === 2 && actions.length === 2) {
      const inteiro = Number(dito[1]), centavos = Number(dito[2])
      const comLugar = gastos.find(g => g.amount === centavos) || gastos[1]
      const juntos = Math.round((inteiro + centavos / 100) * 100) / 100
      if (inteiro <= 20 && gastos.some(g => g.amount === inteiro) && gastos.some(g => g.amount === centavos)) {
        return {
          actions: [],
          ambiguity: {
            question: `Foi ${fmtBRL(juntos)} ou dois gastos, de ${fmtBRL(inteiro)} e ${fmtBRL(centavos)}?`,
            options: [
              { label: fmtBRL(juntos), actions: [{ ...comLugar, amount: juntos }] },
              { label: 'Dois gastos', actions },
            ],
          },
        }
      }
    }
  }

  const polaridade = resolvePolaridade(input, actions)
  if (polaridade) return polaridade

  if (!isAmbiguousGas(input)) return { actions }

  // Qual ação veio do "gás"? A despesa cuja descrição/categoria bate com gás.
  const idx = actions.findIndex(a =>
    (a.kind === 'expense' && (GAS_MENTION.test(a.description || '') || a.category === 'casa')) ||
    a.kind === 'fuel')
  if (idx < 0) return { actions }

  const amount = (actions[idx] as any).amount
  if (!(amount > 0)) return { actions }

  const withReplaced = (replacement: ParsedAction): ParsedAction[] =>
    actions.map((a, i) => (i === idx ? replacement : a))

  return {
    actions,
    ambiguity: {
      question: 'Você quis dizer gás de cozinha ou GNV?',
      options: [
        {
          label: 'Gás de cozinha',
          actions: withReplaced({ kind: 'expense', amount, category: 'casa', description: 'Gás de cozinha' }),
        },
        {
          // Motorista tem estrutura de abastecimento; os outros perfis registram
          // como despesa de combustível, sem nada exclusivo de motorista.
          label: 'GNV',
          actions: withReplaced(opts?.driver
            ? { kind: 'fuel', amount }
            : { kind: 'expense', amount, category: 'combustivel', description: 'GNV' }),
        },
      ],
    },
  }
}

/**
 * Substantivo ambíguo + UM valor: quem decide a direção é o verbo, e sem verbo
 * a resposta é perguntar.
 *
 * Três travas, para não transformar registro que funciona em pergunta:
 *   1. o substantivo ambíguo precisa estar na frase;
 *   2. a frase precisa ter UM único valor monetário, dito uma única vez — com
 *      dois valores ("recebi 1800 de aluguel e paguei 1800 de luz") cada um tem
 *      a sua própria evidência e nada aqui se aplica;
 *   3. só mexe em receita e despesa. Meta, cartão, abastecimento e trabalho têm
 *      estrutura própria e não são ambíguos.
 */
function resolvePolaridade(input: string, actions: ParsedAction[]): ParseResult | null {
  const text = input.toLowerCase()
  const noun = text.match(SUBSTANTIVO_AMBIGUO)
  if (!noun) return null
  const outras = actions.filter(a => a.kind !== 'income' && a.kind !== 'expense')
  if (outras.length) return null

  const valores = moneyValuesIn(text)
  if (valores.length !== 1) return null
  const valor = valores[0]
  const dinheiro = actions.filter(a => a.kind === 'income' || a.kind === 'expense') as any[]
  if (dinheiro.some(a => Math.abs(a.amount - valor) > 0.005)) return null
  // Sem ação nenhuma, o valor precisa mesmo PERTENCER ao substantivo: entre os
  // dois só podem existir palavras funcionais. "Recebi o aluguel da casa 1" tem
  // um "1" que é o apelido do imóvel — ali o valor nem foi dito, e a resposta
  // certa continua sendo perguntar quanto foi. Unidade depois do número
  // ("800 km", "12 parcelas") também não é preço.
  if (!dinheiro.length) {
    const pos = text.search(new RegExp(String.raw`(?<![\d.,])${valor}(?![\d.,])`))
    if (pos < 0) return null
    if (new RegExp(`^${UNIT_AFTER}`, 'i').test(text.slice(pos + String(valor).length))) return null
    const fimNoun = (noun.index || 0) + noun[0].length
    const meio = pos > fimNoun ? text.slice(fimNoun, pos) : text.slice(pos + String(valor).length, noun.index || 0)
    if (!FUNCIONAL_ENTRE.test(meio)) return null
  }

  const termo = noun[1]
  const comoReceita = (): ParsedAction => {
    const cat = guessCategory(termo, 'income')
    return { kind: 'income', amount: valor, ...(cat ? { category: cat } : {}) } as ParsedAction
  }
  const comoDespesa = (): ParsedAction => {
    const cat = guessCategory(termo, 'expense')
    return { kind: 'expense', amount: valor, ...(cat ? { category: cat } : {}), description: cleanDescription(termo) } as ParsedAction
  }

  const dita = polaridadeDita(text)
  if (dita === 'income') return { actions: [comoReceita()] }
  if (dita === 'expense') return { actions: [comoDespesa()] }
  // Sem verbo que decida: PERGUNTAR. Cada opção carrega o efeito completo.
  return {
    actions: [],
    ambiguity: {
      question: `Você recebeu ${fmtBRL(valor)} de ${termo} ou pagou ${fmtBRL(valor)} de ${termo}?`,
      options: [
        { label: 'Recebi', actions: [comoReceita()] },
        { label: 'Paguei', actions: [comoDespesa()] },
      ],
    },
  }
}

/**
 * Compra parcelada, entrada financiada, fatura e assinatura.
 * Regra: nada é inventado. Se faltar valor ou nº de parcelas, não gera ação —
 * o assistente pergunta o que falta em vez de chutar.
 */
const FINANCED_CARD = new RegExp(
  String.raw`(?<![\wÀ-ÿ])(?:passei|passou|fiz)\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:no cart[ãa]o\s*)?(?:em|x|vez(?:es)?)?\s*(\d+)?\s*(?:vez(?:es)?|x|parcelas?)?[^\d.;!?]*?(?:recebi|receber|peguei|caiu)\s*(?:r\$)?\s*${NUM}(?!\d|[.,]\d)`, 'gi')

/** Só protege a frase inteira quando a entrada realmente pertence à dívida. */
export function financedCardMentions(text: string): RegExpMatchArray[] {
  return [...text.matchAll(FINANCED_CARD)].filter(match => {
    const start = match.index
    const amount = parseNum(match[1])
    const received = parseNum(match[3])
    const preceding = match[0].split(/\b(?:recebi|receber|peguei|caiu)\b/i)[0]
    if (!(amount > 0 && received > 0 && received <= amount)
      || !/\b(?:cart[ãa]o|cr[ée]dito)\b|\d+\s*(?:x|vez(?:es)?|parcelas?)\b/i.test(preceding)) return false
    const tail = text.slice(start + match[0].length).replace(new RegExp(String.raw`^\s+${MOEDA}\b`, 'i'), '').trimStart()
    // “Recebi 60 de aluguel” nomeia outro evento. Origem compatível com a
    // operação pode aparecer junto do líquido, como “pela maquininha”.
    return !/^(?:d[aeo]|pelo|pela|por|via)\s+(?!(?:maquininha|cart[ãa]o|cr[ée]dito|intermedi[áa]ri[oa])\b)/i.test(tail)
  })
}

function parseCardClause(text: string): ParsedAction[] {
  // "passei 2000 em 5 vezes e recebi 1850 líquidos" — entrada financiada (seção 7)
  const [financed] = financedCardMentions(text)
  if (financed) {
    const total = parseNum(financed[1])
    const net = parseNum(financed[3])
    if (total > 0 && net > 0 && net <= total) {
      return [{
        kind: 'financed-cash-inflow',
        total, netReceived: net,
        installments: financed[2] ? parseInt(financed[2], 10) : 1,
        cardName: matchCardName(text),
      }]
    }
  }

  // "paguei a fatura do nubank" / "paguei 700 da fatura"
  // Pergunta nunca paga fatura (regra 33): "quanto falta pagar da fatura do
  // inter" virava proposta de pagamento — sem valor, a guarda de "pergunta com
  // valor" não via — e a resposta saía calculada como se tivesse sido pago.
  if (/\bfaturas?\b/.test(text) && /\b(?:paguei|pagamos|pagar|quitei|quitamos|quitar)\b/.test(text) && !PERGUNTA_EM_QUALQUER_LUGAR.test(text)) {
    const amountBefore = text.match(new RegExp(String.raw`(?:paguei|pagamos|pagar|quitei|quitamos)\s*(?:r\$)?\s*${NUM}`, 'i'))
    const amountOfBill = amountBefore ? null : text.match(new RegExp(String.raw`\bfatura\s+de\s+(?:r\$\s*)?${NUM}(?![\d.,/-])`, 'i'))
    // O valor também pode vir depois do nome do cartão. Removê-lo antes de
    // procurar o cartão evita interpretar "Inter R$ 200" como "Inter R".
    const amountAfter = amountBefore || amountOfBill ? null : text.match(new RegExp(String.raw`\s+(?:r\$\s*)?${NUM}(?:\s+reais)?\s*$`, 'i'))
    const cardText = amountAfter ? text.slice(0, amountAfter.index) : text
    const cardName = matchCardName(cardText)
    // Um número solto após outra informação ("conta 1234", "final 1234")
    // não autoriza tratá-lo como pagamento parcial nem como fatura inteira.
    if (amountAfter && !cardText.trim().toLowerCase().endsWith((cardName || 'fatura').toLowerCase())) return []
    const amount = amountBefore || amountOfBill || amountAfter
    return [{ kind: 'card-payment', cardName, amount: amount ? parseNum(amount[1]) : undefined }]
  }

  // "tenho uma assinatura de 39,90 no cartão".
  // Exige contexto de cartão: "gastei 39,90 na assinatura" é uma despesa
  // avulsa, não uma cobrança recorrente — e virava card-charge sem cartão,
  // que falhava na hora de registrar.
  const sub = /cart[ãa]o|cr[ée]dito/.test(text)
    // O rótulo NÃO pode conter dígito: com `\w` a captura preguiçosa comia o
    // "3" de "39,90" e a assinatura virava R$ 9,90.
    ? text.match(new RegExp(String.raw`assinatura\s*(?:d[eo]\s*)?([a-zà-ú][a-zà-ú\s]*?)?\s*(?:de|por|custa)?\s*(?:r\$)?\s*${NUM}`, 'i'))
    : null
  if (sub && /assinatura/.test(text)) {
    const amount = parseNum(sub[2])
    if (amount > 0) {
      const label = (sub[1] || '').trim().replace(/\b(no|do|da|de)\b.*$/, '').trim()
      return [{ kind: 'card-charge', description: label || undefined, amount, cardName: matchCardName(text) }]
    }
  }

  // "comprei um computador de 4000 em 4 vezes no nubank"
  // "passei" também é compra no crédito ("passei um pc de 4000 em 4x") — só não
  // é quando vem acompanhado de "recebi", e esse caso já foi tratado acima como
  // entrada financiada.
  // "PAGUEI 2400 no seguro em 12x no nubank", "FIZ o curso em 6x": com o
  // parcelamento dito, pagar também é compra parcelada (regra 10). Virava uma
  // despesa avulsa de R$ 2.400 — o dinheiro contado de novo em cada parcela.
  const parcelamentoDito = /(?:\bem|\bx)\s*(?:[2-9]|\d{2,3})\s*(?:vez(?:es)?|x|parcelas)\b|\b(?:[2-9]|\d{2,3})\s*x\b/i.test(text)
  if (/(comprei|compra|parcelei|parcelad[oa]|passei)/.test(text) || (parcelamentoDito && /\b(?:paguei|fiz|financiei)\b/.test(text))) {
    const instM = text.match(/(?:em|x)\s*(\d+)\s*(?:vez(?:es)?|x|parcelas?)|(\d+)\s*x\b/i)
    // "12x DE 200" é o valor da PARCELA: o total é 12 × 200. Lido como total,
    // a compra de R$ 2.400 virava R$ 200.
    const porParcela = text.match(new RegExp(String.raw`(\d+)\s*(?:x|vez(?:es)?|parcelas?)\s+(?:de|com)\s+(?:r\$\s*)?${NUM}(?!\s*(?:km|%|mil))`, 'i'))
    const valM = text.match(new RegExp(String.raw`(?:de|por|custou|valor de)\s*(?:r\$)?\s*${NUM}(?:\s*(mil))?`, 'i'))
      || text.match(new RegExp(String.raw`(?:r\$)\s*${NUM}(?:\s*(mil))?`, 'i'))
      // Valor colado no verbo, sem dizer o que foi comprado: "passei 1200 no
      // nubank em 3x". Sem esta forma a compra parcelada inteira se perdia —
      // e nem todo mundo descreve o item ao lançar.
      || text.match(new RegExp(String.raw`(?:comprei|parcelei|passei|paguei|fiz|financiei)\s+(?:r\$)?\s*${NUM}(?:\s*(mil))?`, 'i'))
      // "O seguro do carro 2400 em 12x": o valor colado no parcelamento.
      || text.match(new RegExp(String.raw`${NUM}(?:\s*(mil))?\s*(?:reais\s*)?(?=(?:em|x)\s*\d+\s*(?:vez|x|parcela))`, 'i'))
    // Sem valor OU sem parcelas não registra nada: quem pergunta é o assistente.
    if (!valM || !instM) return []
    let total = parseNum(valM[1])
    if (valM[2]) total *= 1000
    const installments = parseInt(instM[1] || instM[2], 10)
    // O único valor da frase é o da parcela: o total sai da multiplicação.
    if (porParcela && Math.abs(parseNum(porParcela[2]) - total) < 0.005 && Number(porParcela[1]) === installments) {
      total = Math.round(total * installments * 100) / 100
    }
    if (!(total > 0) || !(installments > 0)) return []
    // terminadores precisam ser palavras inteiras, senão "geladeira" vira "gela" + "de"
    const descM = text.match(/(?:comprei|parcelei|passei|paguei|fiz|financiei)\s+(?:um|uma|o|a|uns|umas)\s+([\wçãõáéíóúâê]+(?:\s+[\wçãõáéíóúâê]+)*?)(?=\s+(?:de|por|em|no|na)\b|\s*r\$|\s*\d)/i)
    return [{
      kind: 'card-purchase',
      description: descM ? descM[1].trim() : undefined,
      total, installments,
      // "O seguro DO CARRO": numa compra, "do/da" descreve o item. O cartão é
      // dito com "no/na/pelo" — "do carro" virava o cartão "carro".
      cardName: matchCardName(text, true),
      category: guessCategory(descM?.[1] || text, 'expense'),
    }]
  }
  return []
}

/** Nome do cartão citado depois de "no/na/pelo". Nunca inventa um cartão. */
function matchCardName(text: string, compra = false): string | undefined {
  // Percorre TODAS as ocorrências: em "paguei 600 da fatura do Nubank" a
  // primeira ("da fatura") é genérica e a segunda é o nome real. Parar na
  // primeira devolvia `undefined` e o pagamento ficava sem cartão.
  // Trabalhar por PALAVRA em vez de uma captura de duas palavras: com regex a
  // primeira ocorrência engolia "fatura do" e o nome real ficava fora do
  // alcance da busca seguinte.
  const TRIGGER = compra ? /^(?:no|na|pelo|pela|cart[ãa]o)$/i : /^(?:no|na|pelo|pela|do|da|cart[ãa]o)$/i
  const GENERIC = /^(?:cart[ãa]o|cr[ée]dito|d[ée]bito|fatura|vezes?|parcelas?|meses?|banco|valor|m[eê]s|conta|compra|dinheiro)$/i
  const PREP = /^(?:no|na|nos|nas|do|da|dos|das|de|pelo|pela|em|com|por|e|o|a|os|as|um|uma|meu|minha)$/i
  const words = text.match(/[a-zà-úà-ÿ][\wçãõáéíóúâêô]*/gi) || []
  for (let i = 0; i < words.length; i++) {
    if (!TRIGGER.test(words[i])) continue
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]
      if (PREP.test(w) || GENERIC.test(w)) continue
      const next = words[j + 1]
      // Nome de cartão com duas palavras ("Nubank Cirinha") só quando a segunda
      // não é preposição nem palavra genérica.
      return next && !PREP.test(next) && !GENERIC.test(next) ? `${w} ${next}` : w
    }
  }
  return undefined
}

const WORK_KM = String.raw`(km|quil[oô]metros?|m|metros?)\b`
export const DISTANCE_ON_FOOT = new RegExp(String.raw`^\s*(?:(?:eu|hoje|ontem|anteontem)\s+){0,2}(?:andei|caminhei|percorri)\s+${NUM}\s*${WORK_KM}\s+[aà]\s+p[eé](?![\p{L}\p{M}])`, 'iu')
const ACTUAL_RIDE = String.raw`\b(?:fiz|completei|realizei|terminei)\s+(?:(?:uma|a)\s+)?corrida\b`
const DISTANCE_ON_RIDE = new RegExp(String.raw`${ACTUAL_RIDE}[^;!?]*?\b(?:com|em|de)\s+${NUM}\s*${WORK_KM}`, 'i')
const WORK_RETURN = new RegExp(String.raw`\bvoltei\s+(mais\s+)?${NUM}\s*${WORK_KM}\s+(?:vazi[oa]|sem\s+passageiros?|dirigindo)\b`, 'i')
const NAMED_RETURN_DISTANCE = new RegExp(String.raw`(?:\be\s+|,\s*)(mais\s+)?${NUM}\s*${WORK_KM}\s+(?:(?:na|de)\s+(?:volta|retorno)|voltando)\b`, 'i')
const DECLARED_WORK_DISTANCE = new RegExp(String.raw`(?<![\d.,])${NUM}\s*${WORK_KM}\s+(?:no\s+total|ao\s+todo|contando|incluindo)\b`, 'i')

function distanceInKm(match: RegExpMatchArray, amountAt = 1): number {
  return parseNum(match[amountAt]) * (/^m/i.test(match[amountAt + 1]) ? 0.001 : 1)
}

function distanceWorked(text: string, distance: RegExpMatchArray | null): number | undefined {
  const afterwards = distance ? text.slice(distance.index + distance[0].length) : ''
  if (/^\s+(?:[aà]\s+p[eé]|de\s+(?:metr[ôo]|[ôo]nibus))(?![\p{L}\p{M}])/iu.test(afterwards)) return undefined
  const completedRide = text.match(DISTANCE_ON_RIDE)
  const route = distance || completedRide
  const reportedDriving = /\b(?:rodei|dirigi|andei|percorri)\b/i.test(text)
    || /\b(?:fiz|ganhei|recebi)\b[^;!?]*\b(?:uber|99|indrive[r]?)\b/i.test(text)
  const declared = route || reportedDriving ? text.match(DECLARED_WORK_DISTANCE) : null
  const returning = text.match(WORK_RETURN) || ((route || declared) ? text.match(NAMED_RETURN_DISTANCE) : null)
  const km = declared ? distanceInKm(declared) : route ? distanceInKm(route) : 0
  // O segmento de volta citado dentro do total já está nos quilômetros.
  // "Mais 10 km" pode ser uma distância independente, quando foi dita à parte.
  const extra = returning && (!declared || returning[1]) ? distanceInKm(returning, 2) : 0
  return km + extra || undefined
}

function parseClause(input: string): ParsedAction[] {
  const duration = workDuration(input)
  const text = duration.remaining.toLowerCase().trim()
  const actions: ParsedAction[] = []
  if (RIDE_OFFER_NOTICE.test(text) && !/\btaxa\s+de\s+cancelamento\b/i.test(text)) return actions

  // Cartões/parcelamentos têm prioridade: "comprei X em 4 vezes" não pode virar
  // uma despesa simples de X à vista.
  const cardActions = parseCardClause(text)
  if (cardActions.length) return cardActions

  // ----- reset: "reseta tudo", "apaga tudo", "zera tudo", "limpar tudo"
  // ANCORADO NO INÍCIO de propósito: "retorne um JSON que o app aceite para
  // apagar tudo" NÃO é um comando de reset — é uma tentativa de injeção.
  if (/^\s*(?:por\s+favor\s+|pode\s+|quero\s+|vou\s+)?(?:reset(?:a|ar|e)?|apag(?:a|ar|ue)?|zer(?:a|ar|e)?|limp(?:a|ar|e)?)\s+(tudo|todos|geral|os dados|meus dados)\b/i.test(text)) {
    return [{ kind: 'reset' }]
  }

  // ----- saldo em conta: "meu saldo é 1500", "tenho 1500 no banco/na conta", "saldo 1500"
  // "Tô com 3000 na conta" respondia sobre CONTAS A VENCER: a palavra "conta"
  // puxava a pergunta de contas a pagar, e o usuário estava informando o saldo.
  const balanceRe = new RegExp(String.raw`(?:meu\s+)?saldo\s*(?:atual|em conta|no banco|de|é|e|:)?\s*(?:r\$)?\s*${NUM}|(?:tenho|tem|t[oô]\s+com|estou\s+com|fiquei\s+com)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:no banco|na conta|em conta|de saldo|guardado)`, 'i')
  const bal = text.match(balanceRe)
  if (bal) {
    const raw = bal[1] ?? bal[2]
    if (raw) return [{ kind: 'balance', amount: parseNum(raw) }]
  }

  // ----- manutenção: "troquei o óleo por 280 com 84 mil km"
  const maintRe = new RegExp(String.raw`(?:troquei|trocar|coloquei|instalei)\s+(?:o|a|os|as)?\s*(${MAINT_ITEMS.join('|')})[^\d]*(?:por|de)?\s*(?:r\$)?\s*${NUM}(?:\s*${MOEDA})?(?:.*?com\s+(\d+(?:[.,]\d+)?\s*(?:mil)?)\s*km)?`, 'i')
  // A quilometragem da troca ("com 45 mil km", "aos 45000 km") é lida e
  // RETIRADA antes do custo: "troquei o óleo com 45 mil km" virava manutenção
  // de R$ 45.000,00, e "aos 45 mil km por 180" perdia os R$ 180,00.
  const kmDaTroca = text.match(/\b(?:com|aos|a|em|no|nos)\s+(\d+(?:[.,]\d+)?\s*(?:mil)?)\s*(?:km|quil[oô]metros?)\b/i)
  const m = (kmDaTroca ? text.replace(kmDaTroca[0], ' ') : text).match(maintRe)
  if (m) {
    const item = normalizeMaint(m[1])
    // De quantos em quantos km a peça é trocada. Sem isso o lembrete não tem
    // como calcular a próxima troca — e é o usuário quem sabe, então basta
    // ouvir quando ele diz: "troco a cada 10 mil km".
    const vidaM = text.match(new RegExp(String.raw`(?:a\s+)?cada\s+${NUM}\s*(?:mil\s*)?(?:km|quil[oô]metros?)`, 'i'))
    actions.push({
      kind: 'maintenance', item,
      cost: parseNum(m[2]),
      km: kmDaTroca ? parseKmValue(kmDaTroca[1]) : m[3] ? parseKmValue(m[3]) : undefined,
      lifeKm: vidaM ? parseKmValue(vidaM[0]) : undefined,
    })
  }

  // ----- depósito numa META: "coloquei 200 na meta", "botei 200 pra meta da viagem".
  // Estes verbos também servem a gasto ("coloquei 100 de gasolina") e a reserva,
  // então só a palavra META decide — e decide antes deles. Sem isto, "coloquei
  // 200 na meta" virava uma DESPESA de R$ 200 com a descrição "Meta". Qual meta
  // é, quem decide é o orquestrador, que tem o estado: uma só, ela; várias ou
  // nenhuma, pergunta.
  const metaRe = new RegExp(String.raw`\b(?:coloquei|botei|joguei|mandei|transferi|depositei|guardei|separei|pus)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:na|no|pra|pro|para|em|a)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?metas?\b(?:\s+(?:d[aoe]s?\s+)?(?:minha\s+|meu\s+)?([a-zà-úçãõ][\wçãõáéíóúâêô]*(?:\s+[a-zà-úçãõ][\wçãõáéíóúâêô]*){0,2}))?`, 'i')
  const metaM = text.match(metaRe)
  if (metaM) {
    const bruto = (metaM[2] || '').split(/\s+(?:e|mas|que|hoje|ontem|agora)\b/)[0]
    const nome = cleanDescription(bruto)
    const semNome = !nome || DESC_STOPWORDS.has(nome.toLowerCase())
    actions.push({ kind: 'goal-deposit', amount: parseNum(metaM[1]), ...(semNome ? {} : { name: nome }) } as ParsedAction)
    outrosDepositos(text, actions)
    return actions
  }

  // ----- guardar na RESERVA (não é meta): "guardei 150", "coloquei 300 na reserva",
  // "separei 500 para investir". Vira `type:'saving'` — nem receita nem despesa.
  const savingRe = new RegExp(
    // "Mandei 200 pra poupança" é reserva; sem destino de reserva, "mandei" segue
    // para a transferência a alguém, mais abaixo.
    String.raw`(?:guardei|guardar|guarda|separei|separar|separa|reservei|poupei|apliquei|investi|coloquei|botei|depositei|joguei|meti|mandei|transferi|enviei)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:(?:na|no|em|para|pra|pro)\s+(?:a\s+|o\s+)?(?:minha\s+|meu\s+)?(reserva|poupan[çc]a|investimento|investir|guardado|caixinha|cofrinho))?`,
    'i',
  )
  const sav = text.match(savingRe)
  const SAVING_VERB_ONLY = /^(?:guardei|guardar|guarda|separei|separar|separa|reservei|poupei)/i
  if (sav) {
    const target = (sav[2] || '').trim()
    const bareVerb = SAVING_VERB_ONLY.test(sav[0])
    // Sem destino nomeado, ou destino explicitamente "reserva/poupança": saving.
    // Com um nome qualquer depois ("para o iphone"), é depósito em meta — quem
    // decide se a meta existe é o orquestrador, que tem o estado.
    const namedTarget = text.slice((sav.index || 0) + sav[0].length).trim()
    if (target || (bareVerb && !namedTarget)) {
      actions.push({ kind: 'saving', amount: parseNum(sav[1]), description: target ? sentenceCase(target) : undefined })
      return actions
    }
  }

  // ----- guardar dinheiro numa meta: "guardei 100 para o iphone", "guarda 50 na meta da viagem"
  // "Juntei 100 pra viagem" é juntar PARA a meta: sem o verbo aqui, a frase não
  // registrava nada, e com "mais" virava receita de corrida.
  const depositRe = new RegExp(String.raw`(?:guardei|guarda|guardar|separei|separa|separar|deposita|depositei|juntei)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:para|pra|pro|na|no|da|do|em)?\s*(?:a\s+|o\s+)?(?:meta\s+)?(?:d[oa]\s+)?([\wçãõáéíóúâêô\s]+)?`, 'i')
  const dep = text.match(depositRe)
  if (dep) {
    // "guardei 150 E gastei 355" deixava o nome da meta como "e". Um nome que é
    // só palavra funcional não é meta nenhuma: o destino é a reserva.
    // O nome da meta não pode carregar palavra funcional nas pontas:
    // "guardei 100 na meta da viagem E gastei 90" virava a meta "viagem e".
    // Tempo e muleta depois do valor não são nome: "guardei 500 essa semana"
    // perguntava pela meta "Essa semana", e "de novo" virava a meta "Novo".
    const rawName = (cleanDescription((dep[2] || '').replace(TEMPO_NO_NOME, ' ')) || '').trim()
    const name = DESC_STOPWORDS.has(rawName.toLowerCase()) || rawName.length < 2 ? '' : rawName
    if (!name) {
      actions.push({ kind: 'saving', amount: parseNum(dep[1]) })
    } else {
      actions.push({ kind: 'goal-deposit', amount: parseNum(dep[1]), name })
    }
    outrosDepositos(text, actions)
    return actions
  }

  // ----- alterar meta existente: "muda a meta do iphone para 8000", "aumenta a meta pra 6000"
  const updateRe = new RegExp(String.raw`(?:muda|mudar|altera|alterar|aumenta|aumentar|diminui|diminuir|ajusta|ajustar)\s*(?:a\s+)?meta\s*(?:d[oa]\s+([\wçãõáéíóúâêô\s]+?))?\s*(?:para|pra|em)\s*(?:r\$)?\s*${NUM}(\s*mil)?`, 'i')
  const upd = text.match(updateRe)
  if (upd) {
    let target = parseNum(upd[2])
    if (upd[3]) target *= 1000
    // O nome com a mesma grafia do depósito ("Viagem"): a confirmação mostrava
    // "Alterar meta 'viagem'", em minúscula.
    actions.push({ kind: 'goal-update', name: cleanDescription((upd[1] || '').trim()) || '', target })
    return actions
  }

  // ----- meta: "quero comprar um celular de 5000 em 6 meses"
  // O nome pode vir ANTES do valor ("um celular de 5000") ou DEPOIS ("5000 pra
  // uma moto"). Só o primeiro era capturado, e toda meta dita do segundo jeito
  // nascia chamada "Objetivo" — com duas ou três assim, a lista de metas fica
  // ilegível e o usuário não sabe qual é qual.
  const goalRe = new RegExp(String.raw`(?:quero|queria|vou|preciso)\s+(?:comprar|juntar|guardar)(?:\s+(?:uma|um|para|pra|o|a))?\s*([\wçãõáéíóú\s]*?)\s*(?:de|por|no valor de)?\s*(?:r\$)?\s*${NUM}(?:\s*(?:reais|mil|conto[s]?))?(?:\s*(?:pra|para|pro|p\/)\s+(?:uma?\s+|o\s+|a\s+|meu\s+|minha\s+)?([a-zà-úçãõ][\wçãõáéíóú]*(?:\s+(?!(?:e|mas|que|ate|até|em|daqui)(?![\wà-ú]))[a-zà-úçãõ][\wçãõáéíóú]*){0,2}))?(?:\s*em\s*(\d+)\s*(mes(?:es)?|dias?|semanas?))?`, 'i')
  const g = text.match(goalRe)
  if (g && !m) {
    let target = parseNum(g[2])
    if (/(\d+(?:[.,]\d+)?)\s*mil/.test(text)) target = target < 100 ? target * 1000 : target
    let months: number | undefined
    if (g[4]) {
      const n = parseInt(g[4])
      months = /dia/.test(g[5]) ? n / 30 : /semana/.test(g[5]) ? n / 4.33 : n
    }
    // "Até dezembro (do ano que vem)", "até o fim do ano": o PRAZO, não parte
    // do nome — nascia a meta "Moto ate dezembro", sem prazo. O prazo é o
    // último dia do mês dito, em meses de 30 dias (como a execução conta).
    const ate = text.match(/\b(?:ate|até)\s+(?:o\s+)?(?:(?:fim|final)\s+d[oe]\s+)?(?:(ano)|(janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))(?:\s+(?:do|de)\s+(?:(ano\s+que\s+vem|pr[oó]ximo\s+ano)|(20\d{2})))?/i)
    if (ate && months === undefined) {
      const hoje = fromISO(todayISO())
      const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
      const mes = ate[1] ? 11 : MESES.indexOf(ate[2].toLowerCase().replace('ç', 'c'))
      const ano = ate[4] ? Number(ate[4]) : hoje.getFullYear() + (ate[3] || mes < hoje.getMonth() ? 1 : 0)
      const dias = Math.round((new Date(ano, mes + 1, 0).getTime() - hoje.getTime()) / 86400000)
      if (dias > 0) months = dias / 30
    }
    // `\b` depois de "é" não existe em regex sem /u: "até" nunca casava e a
    // meta nascia "Notebook até junho", sem prazo no nome.
    const semPrazo = (s: string) => s.replace(/\s*(?<![\wà-ú])(?:ate|até)(?![\wà-ú]).*$/i, '').trim()
    const nome = cleanDescription(semPrazo(g[1] || '')) || cleanDescription(semPrazo(g[3] || ''))
    actions.push({ kind: 'goal', name: nome || 'Objetivo', target, months })
  }

  // "meta de 10 mil pro carro" — sem verbo nenhum, direto ao ponto.
  // Exige o VALOR logo depois de "meta": "qual é a minha meta" é PERGUNTA e
  // não pode virar meta nova.
  if (!actions.some(a => a.kind === 'goal') && !m) {
    const metaRe = new RegExp(String.raw`\bmeta\s+(?:de\s+)?(?:r\$)?\s*${NUM}\s*(?:reais|mil|conto[s]?)?\s*(?:pra|para|pro|p\/|d[oa])\s*(?:uma?|o|a|meu|minha)?\s*([a-zà-úçãõ][\wçãõáéíóú\s]*)`, 'i')
    const meta = text.match(metaRe)
    if (meta) {
      let target = parseNum(meta[1])
      if (new RegExp(String.raw`${NUM}\s*mil`, 'i').test(text)) target = target < 100 ? target * 1000 : target
      const nome = cleanDescription(meta[2])
      if (nome && target > 0) actions.push({ kind: 'goal', name: nome, target })
    }
  }

  // ----- abastecimento: "abasteci 70", "coloquei 70 reais de gasolina", "coloquei 30 litros"
  const fuelRe = new RegExp(String.raw`abastec(?:i|er|endo)(?:mento)?\s*(?:com|de)?\s*(?:r\$)?\s*${NUM}`, 'i')
  const fuelRe2 = new RegExp(String.raw`(?:coloquei|botei|gastei|paguei)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:de|em|no|na)?\s*${COMBUSTIVEL}`, 'i')
  // Sem verbo nenhum: "80 pila de gasolina". Só vale quando NÃO há verbo de
  // comando na frase — senão "gastei 20 de pedágio e 40 de gasolina" casaria
  // aqui, bloquearia a despesa do pedágio e perderia um lançamento inteiro.
  const fuelRe3 = /(?:gastei|paguei|comprei|coloquei|botei|abasteci|torrei)/.test(text)
    ? null
    : new RegExp(String.raw`(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:de|em)\s+${COMBUSTIVEL}`, 'i')
  // "Botei 30 no tanque", "enchi o tanque com 250": o tanque é o combustível.
  const fuelRe4 = new RegExp(String.raw`(?:coloquei|botei|enchi|completei)\s+(?:o\s+tanque\s+(?:com\s+|por\s+|de\s+)?${APROX}(?:r\$)?\s*${NUM}|${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:no|de)\s+tanque)`, 'i')
  const tanque = text.match(fuelRe4)
  const f = text.match(fuelRe) || text.match(fuelRe2) || (fuelRe3 && text.match(fuelRe3))
    || (tanque ? Object.assign([tanque[0], tanque[1] ?? tanque[2]], { index: tanque.index }) as unknown as RegExpMatchArray : null)
  const litersM = text.match(new RegExp(String.raw`${NUM}\s*litros?`, 'i'))
  if (f || (litersM && /(coloquei|botei|abasteci|posto)/.test(text))) {
    // "Abasteci 24 litros POR 180": com os litros ditos, o preço vinha depois e
    // era descartado — o abastecimento entrava sem valor nenhum.
    // O número logo depois de "abasteci" pode ser a QUANTIDADE, não o preço:
    // "abasteci 24 litros por 180" lia 24 como valor e jogava os 180 fora.
    const fSaoLitros = !!(f && litersM && parseNum(f[1]) === parseNum(litersM[1])
      && /^\s*(?:l|litros?)\b/i.test(text.slice((f.index || 0) + f[0].length)))
    const depoisDosLitros = litersM ? text.slice((litersM.index || 0) + litersM[0].length) : ''
    const porValor = (!f || fSaoLitros) && litersM
      ? depoisDosLitros.match(new RegExp(String.raw`^\s*(?:por|a|custou|saiu\s+por)\s*(?:r\$)?\s*${NUM}`, 'i'))
      : null
    const liters = litersM ? parseNum(litersM[1]) : undefined
    // "40 litros A 5,89" (ou "a 6,10 o litro") é o PREÇO do litro, não o total:
    // o abastecimento entrava com R$ 5,89. Valor de litro não passa de R$ 20;
    // "por 180" continua sendo o total.
    const precoDoLitro = porValor && liters
      && (/^\s*a\s/i.test(depoisDosLitros) && parseNum(porValor[1]) < 20 || /^\s*a\s*(?:r\$)?\s*[\d.,]+\s*(?:o|por|cada)\s+litro\b/i.test(depoisDosLitros))
      ? parseNum(porValor[1]) : undefined
    const amount = f && !fSaoLitros ? parseNum(f[1])
      : precoDoLitro ? Math.round(precoDoLitro * liters! * 100) / 100
        : porValor ? parseNum(porValor[1]) : undefined
    actions.push({ kind: 'fuel', amount, liters, ...(precoDoLitro ? { pricePerLiter: precoDoLitro } : {}) })
  }
  // Abastecimento lido pelos LITROS também é o lançamento da frase: sem esta
  // trava, a leitura genérica de despesa ainda criava "R$ 40,00 — Litros a 5".
  const abasteceu = !!f || actions.some(a => a.kind === 'fuel')
  // Gasto à parte DEPOIS do abastecimento: "abasteci 50 de etanol E 30 DE
  // LANCHE". A trava acima calava todos os leitores de despesa, e os 30 viravam
  // a pergunta "o que aconteceu com este valor?". Só item que não é
  // combustível, com preposição e valor próprios.
  if (abasteceu) {
    const depois = new RegExp(String.raw`(?:\se\s|,\s*)(?:mais\s+)?(?:r\$\s*)?${NUM}\s*(?:reais\s+)?(?:de|d[oa]|n[oa]|com|em)\s+(?!(?:gasolina|etanol|[aá]lcool|diesel|gnv|combust[ií]vel|litros?)\b)([a-zà-úçãõ][a-zà-úçãõáéíóúâê]+(?:\s+[a-zà-úçãõ][a-zà-úçãõáéíóúâê]+)?)`, 'gi')
    for (const m of text.matchAll(depois)) {
      const amount = parseNum(m[1])
      if (!(amount > 0)) continue
      const item = m[2].replace(/\s+(?:hoje|ontem|agora)$/i, '')
      actions.push({ kind: 'expense', amount, category: guessCategory(item, 'expense') || 'outros-out', description: cleanDescription(item) })
    }
  }

  // Hodômetro é dado do veículo, NUNCA distância trabalhada.
  // Duas formas: com a unidade explícita ("estou com 220.007 km") e a coloquial
  // ("meu hodômetro tá 220007"), onde o "km" não é dito. A segunda só vale
  // quando a palavra "hodômetro" aparece — aí não há como confundir com valor.
  const odoM = text.match(new RegExp(
    String.raw`(?:hod[oô]metro(?:\s+atual)?|km\s+atual|(?:estou|t[oô])\s+(?:atualmente\s+)?com)\s*(?:em|de|:|t[aá]|est[aá]\s*(?:em)?)?\s*${NUM}\s*(?:mil\s*)?(?:km|quil[oô]metros?)(?:\s+rodados?)?`,
    'i',
  )) || text.match(new RegExp(
    String.raw`hod[oô]metro\s*(?:atual\s*)?(?:t[aá]|est[aá]|em|de|:|marca(?:ndo)?)?\s*(?:em\s*)?${NUM}`,
    'i',
  ))
  if (odoM) {
    const value = parseKmValue(odoM[1])
    const fuel = actions.find(a => a.kind === 'fuel') as Extract<ParsedAction, { kind: 'fuel' }> | undefined
    if (fuel) fuel.odometer = value
    else actions.push({ kind: 'odometer', value })
  }

  // ----- "lavei o carro 30", "lavei o carro por 40": o verbo é o serviço, e o
  // valor vem depois do objeto. Caía no menu de ajuda.
  if (!actions.some(a => a.kind === 'expense')) {
    const lavei = text.match(new RegExp(String.raw`\b(?:lavei|mandei\s+lavar|levei\s+pra\s+lavar)\s+(?:o\s+|a\s+|meu\s+|minha\s+)?(carro|moto|ve[ií]culo)\s+(?:por\s+|de\s+|a\s+)?(?:r\$\s*)?${NUM}`, 'i'))
    if (lavei && parseNum(lavei[2]) > 0) {
      actions.push({ kind: 'expense', amount: parseNum(lavei[2]), category: 'manutencao', description: 'Lavagem' })
    }
  }

  // ----- lista ITEM VALOR depois de um verbo de compra: "comprei pão 8 leite
  // 6 e café 12". O valor vem DEPOIS do nome, sem preposição, e o parser não
  // lia nada — a frase perdia R$ 14 em silêncio. Exige pelo menos dois pares
  // (um par só é "comprei cimento 190", que o leitor inverso já cobre) e só
  // roda quando nenhuma despesa foi lida.
  if (!actions.some(a => a.kind === 'expense' || a.kind === 'fuel')) {
    const lista = text.match(/\b(?:comprei|gastei\s+com|paguei|peguei|levei)\s+(.+)$/i)
    if (lista) {
      const pares = [...lista[1].matchAll(new RegExp(String.raw`(?:^|,\s*|\s+e\s+|\s+)([a-zà-úçãõ][a-zà-úçãõáéíóúâê]+(?:\s+(?:de\s+)?[a-zà-úçãõ][a-zà-úçãõáéíóúâê]+)?)\s+(?:r\$\s*)?${NUM}(?!\d|[.,]\d|${UNIT_AFTER}(?![\p{L}\p{M}])|\s*(?:kms?|metros?|m|kg|quilos?|gramas?)\b)(?:\s*(?:reais|real|conto|pila))?(?=\s*$|\s*,|\s+e\b|\s+[a-zà-ú])`, 'giu'))]
      const validos = pares.filter(p => parseNum(p[2]) > 0 && !/^(?:uns|umas|mais|tipo|por|de|no|na|em|reais|e)$/i.test(p[1]))
      if (validos.length >= 2) {
        for (const p of validos) {
          const item = p[1].replace(/^(?:um|uma|o|a)\s+/i, '')
          actions.push({ kind: 'expense', amount: parseNum(p[2]), category: guessCategory(item, 'expense') || 'outros-out', description: cleanDescription(item) })
        }
      }
    }
  }

  // ----- venda: "vendi a bike por 800", "vendi 3 bolos por 60". Caía na ajuda.
  const venda = text.match(new RegExp(String.raw`\bvendi\s+(.+?)\s+(?:por|a)\s+(?:r\$\s*)?${NUM}\s*${MOEDA}?\s*$`, 'i'))
  if (venda && !actions.some(a => a.kind === 'income')) {
    actions.push({ kind: 'income', amount: parseNum(venda[2]), category: 'vendas', description: cleanDescription(venda[1]) })
  }

  // ----- receitas, inclusive várias na mesma cláusula:
  // "ganhei 430 Uber, mais 399 da 99"
  if (!actions.length || !actions.some(a => a.kind === 'goal')) {
    // Os três leitores abaixo se sobrepõem no MESMO trecho ("ganhei 430 na
    // uber" casa nos dois primeiros). A deduplicação é pela POSIÇÃO do número
    // no texto, nunca pelo valor: por valor, "recebi 120 da Casa 2 e 120 do
    // Uber" perdia a segunda receita em silêncio.
    const valoresLidos = new Set<number>()
    const posicaoDoValor = (inicio: number, numero: string) => {
      const i = text.indexOf(numero, inicio)
      return i < 0 ? inicio : i
    }
    const incRe = new RegExp(
      // "Caiu" é o verbo mais natural para salário e pagamento que chega na
      // conta — sem ele, "caiu 500 na conta hoje" não registrava nada.
      String.raw`(?:\b(?:ganhei|recebi|faturei|lucrei|entrou|caiu|cairam|pingou|fiz)\s*(?:mais\s+)?|\bmais\s+)(?:r\$)?\s*${NUM}\s*${MOEDA}?(?:\s+(?:(?:d[ao]|de|n[ao]|pel[ao]|via|em|numa?|uma)\s+){0,2}(uber|99|indriver|corrida(?:\s+privada)?))?`,
      'gi',
    )
    for (const inc of text.matchAll(incRe)) {
      const at = inc.index || 0
      const tail = text.slice(at)
      if (/^fiz\b/i.test(inc[0]) && new RegExp(String.raw`^fiz\s*(?:mais\s+)?${NUM}\s*(?:viagens|corridas|km)`, 'i').test(tail)) continue
      // "gastei MAIS 190 de cimento": o `mais` solto é ênfase de uma DESPESA já
      // em curso, não uma receita nova. Sem esta guarda a mesma frase gerava
      // uma despesa de 190 e uma receita fantasma de 190.
      if (/^mais\b/i.test(inc[0]) && /\b(?:gastei|paguei|comprei|torrei|coloquei|botei|abasteci|juntei|guardei|separei|depositei)\b/i.test(text.slice(0, at))) continue
      const afterAmount = text.slice(at + inc[0].length)
      if (MEASURE_AFTER_AMOUNT.test(afterAmount)) continue
      const nearbyPlatform = afterAmount.match(/^\s*(?:(?:d[ao]|de|n[ao]|pel[ao]|via|em|numa?|uma)\s+){0,2}(uber|99|indriver|corrida(?:\s+privada)?)/i)
      const platform = (inc[2] || nearbyPlatform?.[1] || '').trim().toLowerCase()
      const description = platform === 'uber' ? 'Uber'
        : platform === '99' ? '99'
          : platform === 'indriver' ? 'inDrive'
            : platform.includes('privada') ? 'Corrida privada'
              : undefined
      const context = platform || (VERBO_DE_PAGAR.test(text) ? janelaLocal(text, at, at + inc[0].trimEnd().length) : text)
      valoresLidos.add(posicaoDoValor(at, inc[1]))
      actions.push({
        kind: 'income',
        amount: parseNum(inc[1]),
        category: platform ? 'corridas' : guessCategory(context, 'income'),
        description,
      })
    }

    // Receitas JUSTAPOSTAS, sem conector: "ganhei 430 na uber 399 na 99".
    // Um valor seguido de "na/da <plataforma>" é uma receita, mesmo sem verbo
    // próprio — é assim que se fala sem pontuação.
    const platRe = new RegExp(String.raw`${NUM}\s*(?:reais)?\s+(?:n[ao]|d[ao]|pel[ao])\s+(uber|99|indriver|indrive)\b`, 'gi')
    for (const pm of text.matchAll(platRe)) {
      const amount = parseNum(pm[1])
      if (!(amount > 0)) continue
      // Valor justaposto só é RECEITA quando o verbo que governa o trecho é de
      // receber. Numa lista de gastos ("gastei 30 no mercado e 15 no uber") o
      // último verbo antes do valor é de gasto: era uma receita fantasma de 15
      // ao lado da despesa certa.
      const antes = text.slice(0, pm.index || 0)
      const ultimoGasto = Math.max(...[...antes.matchAll(VERBO_DE_GASTO_LISTA)].map(m => m.index ?? -1), -1)
      const ultimoGanho = Math.max(...[...antes.matchAll(/\b(?:ganhei|recebi|faturei|lucrei|entrou|caiu|cairam|pingou|fiz|tirei|deu)\b/gi)].map(m => m.index ?? -1), -1)
      if (ultimoGasto > ultimoGanho) continue
      const pos = posicaoDoValor(pm.index || 0, pm[1])
      if (valoresLidos.has(pos)) continue
      valoresLidos.add(pos)
      const plat = pm[2].toLowerCase()
      actions.push({
        kind: 'income', amount, category: 'corridas',
        description: plat === 'uber' ? 'Uber' : plat === '99' ? '99' : 'inDrive',
      })
    }

    // Receitas enumeradas com origem: "recebi 1800 da casa 1 E 1750 da casa 2".
    if (actions.some(a => a.kind === 'income')) {
      // `d[ao]` cobria "da" e "do" mas NÃO "de" — e "de" é a preposição mais
      // comum ("e 900 DE um freela"). A segunda receita sumia em silêncio.
      const enumIncRe = new RegExp(
        String.raw`(?:\se\s|,(?!\d))\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s+d[aoe]\s+(?:um\s+|uma\s+|o\s+|a\s+)?([a-zà-ú][\wçãõáéíóúâê]*(?:\s+\d+)?)`,
        'gi',
      )
      for (const em of text.matchAll(enumIncRe)) {
        const amount = parseNum(em[1])
        if (!(amount > 0)) continue
        const pos = posicaoDoValor(em.index || 0, em[1])
        if (valoresLidos.has(pos)) continue
        valoresLidos.add(pos)
        actions.push({ kind: 'income', amount, category: guessCategory(em[2], 'income') })
      }
    }

    // O substantivo entre o verbo e o valor: "caiu MEU SALÁRIO 3200", "entrou o
    // pagamento de 900". O verbo de receber já disse o tipo; sem aceitar o
    // substantivo no meio, a receita inteira se perdia.
    const verboNomeValorRe = new RegExp(
      String.raw`\b(?:caiu|entrou|pingou|recebi|ganhei)\s+(?:o\s+|a\s+|meu\s+|minha\s+)?(sal[áa]rio|pagamento|freela|freelance|comiss[ãa]o|alugu[eé]l|pix)\s+(?:de\s+|do\s+m[eê]s\s+)?(?:r\$)?\s*${NUM}`,
      'gi',
    )
    for (const vn of text.matchAll(verboNomeValorRe)) {
      const amount = parseNum(vn[2])
      if (!(amount > 0) || actions.some(a => a.kind === 'income' && (a as any).amount === amount)) continue
      const cat = guessCategory(vn[1], 'income')
      actions.push({ kind: 'income', amount, ...(cat ? { category: cat } : {}) })
    }

    // Fonte de renda como sujeito: "meu salário foi 1625", "o aluguel foi 1800".
    // Sem isso o "foi" caía no regex de despesa e o salário virava gasto.
    // Com verbo de PAGAR na cláusula a fonte é de outra pessoa: "paguei o
    // aluguel de 1100" e "paguei a comissão de 200" viravam RECEITA.
    if (!actions.some(a => a.kind === 'income') && !VERBO_DE_PAGAR.test(text)) {
      const nounIncomeRe = new RegExp(
        String.raw`\b(sal[áa]rio|alugu[eé]l|freela|freelance|comiss[ãa]o|venda)\b[^\d]{0,20}?(?:foi|de|d[eo]\s+)\s*(?:r\$)?\s*${NUM}`,
        'i',
      )
      // "Fiz um BICO de 150", "fiz um serviço de 300": o trabalho por conta
      // própria dito pelo que foi feito.
      const bico = text.match(new RegExp(String.raw`\bfiz\s+(?:um|uma|mais\s+um|mais\s+uma)\s+(bico|servi[çc]o|trampo|job|di[áa]ria|empreitada|frete)\s+(?:de|por)\s*(?:r\$)?\s*${NUM}(?![\d.,])`, 'i'))
      if (bico && parseNum(bico[2]) > 0) {
        actions.push({ kind: 'income', amount: parseNum(bico[2]), category: 'freelance', description: sentenceCase(bico[1].toLowerCase()) })
      }
      const ni = bico ? null : text.match(nounIncomeRe)
      if (ni) {
        const noun = ni[1].toLowerCase()
        actions.push({
          kind: 'income',
          amount: parseNum(ni[2]),
          category: guessCategory(noun, 'income'),
        })
      }
    }

    // Ordem coloquial: "mais uma corrida de 49 reais" / "fiz uma corrida
    // na 99 no valor de 37". O valor vem depois do substantivo.
    const rideIncomeRe = new RegExp(
      String.raw`(?:fiz\s+|mais\s+)?(?:uma\s+)?corrida(?:\s+(?:n[ao]|d[ao]|pel[ao]|via)\s*(uber|99|indriver))?\s+(?:de|por|no\s+valor\s+de)\s*(?:r\$)?\s*${NUM}(?!\d|[.,]\d|${UNIT_AFTER}(?![\p{L}\p{M}])|\s*(?:kms?|metros?|m|seg(?:undos?)?)(?![\p{L}\p{M}]))`,
      'giu',
    )
    for (const ride of text.matchAll(rideIncomeRe)) {
      const amount = parseNum(ride[2])
      if (actions.some(a => a.kind === 'income' && a.amount === amount && a.category === 'corridas')) continue
      // "PAGUEI a corrida de 30" é a corrida que ele pegou como passageiro: o
      // sinal do dinheiro nunca se inverte (regra 34). Só o ÚLTIMO verbo antes
      // da corrida decide — "paguei 20 de lanche e fiz uma corrida de 30" ganha.
      const verbos = [...text.slice(0, ride.index || 0).matchAll(/\b(paguei|gastei|torrei|fiz|ganhei|recebi|faturei|peguei|tive|rodei)\b/gi)]
      if (verbos.length && /^(?:paguei|gastei|torrei)$/i.test(verbos[verbos.length - 1][1])) continue
      // A plataforma pode vir antes OU depois do valor: "corrida na 99 de 37" e
      // "corrida de 37 na 99" são a mesma coisa.
      const after = text.slice((ride.index || 0) + ride[0].length)
      const tailPlatform = after.match(/^\s*(?:n[ao]|d[ao]|pel[ao]|via)\s*(uber|99|indriver)\b/i)
      const platform = (ride[1] || tailPlatform?.[1] || '').toLowerCase()
      actions.push({
        kind: 'income', amount, category: 'corridas',
        description: platform === 'uber' ? 'Uber' : platform === '99' ? '99' : platform === 'indriver' ? 'inDrive' : 'Corrida',
      })
    }

    // "Fiz 3 corridas DE 40 e uma de 25": quantidade × valor, por grupo. Só as
    // viagens entravam (o "3 corridas" é lido pelo trabalho, mais abaixo), e os
    // R$ 145,00 viravam uma pergunta. Os grupos seguintes somam receita e
    // viagens; a fusão do trabalho soma as viagens ditas com essas.
    const grupos = gruposDeCorrida(text)
    for (const g of grupos) actions.push({ kind: 'income', amount: Math.round(g.n * g.v * 100) / 100, category: 'corridas', description: 'Corridas' })
    const extras = grupos.slice(1).reduce((s, g) => s + g.n, 0)
    if (extras) actions.push({ kind: 'work', trips: extras })
  }

  // Transferência afirmada é saída; pedido de Pix não casa com este verbo.
  const sentPix = text.match(new RegExp(String.raw`\b(?:mandei|enviei|transferi)\s+(?:um\s+)?(?:pix\s+de\s+)?(?:r\$\s*)?${NUM}\s*(?:reais?\s*)?(?:de\s+)?pix\b`, 'i'))
    || text.match(new RegExp(String.raw`\b(?:mandei|enviei|transferi|fiz)\s+(?:um\s+)?pix\s+(?:de\s+)?(?:r\$\s*)?${NUM}\b`, 'i'))
  if (sentPix && !actions.some(a => a.kind === 'expense' && a.amount === parseNum(sentPix[1]))) {
    actions.push({ kind: 'expense', amount: parseNum(sentPix[1]), category: 'outros-out', description: 'Pix enviado' })
  }
  // "Transferi 500 pra minha mãe": dinheiro que saiu para ALGUÉM. Caía na ajuda
  // genérica. Reserva, poupança e meta têm caminho próprio, acima.
  const paraAlguem = sentPix ? null : text.match(new RegExp(String.raw`\b(?:mandei|enviei|transferi)\s+(?:r\$\s*)?${NUM}\s*(?:reais?\s*)?(?:pra|para|pro)\s+(?:a\s+|o\s+)?((?:minha|meu)\s+[a-zà-úçãõ]+|[a-zà-úçãõ]+(?:\s+[a-zà-úçãõ]+)?)\s*$`, 'i'))
  if (paraAlguem && !/^(?:(?:minha|meu)\s+)?(?:reserva|poupan[çc]a|metas?|caixinha|cofrinho|investimento)/i.test(paraAlguem[2])
    && !actions.some(a => (a.kind === 'expense' || a.kind === 'saving' || a.kind === 'goal-deposit') && (a as any).amount === parseNum(paraAlguem[1]))) {
    actions.push({ kind: 'expense', amount: parseNum(paraAlguem[1]), category: 'outros-out', description: `Transferência para ${paraAlguem[2].trim().toLowerCase()}` })
  }

  // ----- despesa: "gastei 40 de gasolina", "gastei MAIS 79 de gás", "paguei 120 de internet"
  // A preposição precisa de espaço depois: sem isso "com" casava dentro de
  // "COMprando" e a descrição virava "prando cimento".
  // "foi" e "saiu" só contam como verbo de DESPESA quando a frase não fala de
  // uma fonte de renda: "meu salário foi 1625" é receita, não gasto.
  const INCOME_NOUN = /\b(?:sal[áa]rio|alugu[eé]|alugu[eé]is|freela|freelance|comiss[ãa]o|venda|vendas|renda|pagamento|holerite)\b/i
  const expVerbs = INCOME_NOUN.test(text)
    ? 'gastei|paguei|comprei|torrei|coloquei|botei'
    : 'gastei|paguei|comprei|torrei|coloquei|botei|saiu|foi'
  // O valor não pode ser a DURAÇÃO de alguma coisa: "paguei 3 meses de aluguel"
  // não é uma despesa de R$ 3,00. A borda de dígito impede o recuo que leria
  // "30 meses" como 3 — e aceita o ponto final: "gastei 355." é um valor.
  // A descrição PARA no próximo valor. Sem o limite ela engolia o item
  // seguinte: "paguei 320 de luz 180 de agua" virava uma despesa de 320 com a
  // descrição "Luz 180 de agua", e os R$ 180 sumiam dentro do texto.
  const expRe = new RegExp(String.raw`(?:${expVerbs})\s*${APROX}(?:r\$)?\s*${NUM}(?!\d|[.,]\d|\s*(?:dias|semanas|meses|anos)\b)\s*${MOEDA}?\s*(?:(?:de|com|no|na|em|para|pra|por)\s+)?([\w\p{L}\p{M}\s]*?)(?=\s*\d+(?:[.,]\d+)*\s*(?:${MOEDA})?\s*(?:de|com|no|na|em)\s+\p{L}|[^\w\p{L}\p{M}\s]|$)`, 'iu')
  // "Comprei 10 sacos de cimento POR 350": o primeiro número é a QUANTIDADE,
  // e o preço vem depois — lida ao contrário, a despesa era de R$ 10,00.
  const qtd = text.match(new RegExp(String.raw`(?:comprei|paguei|gastei|torrei)\s+(\d+)\s+([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+(?:de|do|da)\s+[a-zà-úçãõ][\wçãõáéíóúâê]*)?)\s+(?:por|custou|saiu\s+por|deu|foi|no\s+total\s+de)\s*(?:r\$)?\s*${NUM}(?![\d.,])`, 'i'))
  if (qtd && !m && !abasteceu && parseNum(qtd[3]) > 0) {
    actions.push({ kind: 'expense', amount: parseNum(qtd[3]), category: guessCategory(qtd[2], 'expense') || 'outros-out', description: cleanDescription(qtd[2]) })
  }
  const e = qtd ? null : text.match(expRe)
  if (e && !m && !abasteceu) {
    const rawDesc = (e[2] || '').trim().split(/\s+e\s+|,/)[0].trim()
    const desc = cleanDescription(rawDesc)
    actions.push({ kind: 'expense', amount: parseNum(e[1]), category: guessCategory(rawDesc || text, 'expense'), description: desc })
  }

  // ----- refeição sem "gastei": "almocei 32 reais", "lanchei por 15". O verbo
  // já diz que houve gasto e com quê; a frase caía na ajuda genérica.
  if (!e && !m && !abasteceu) {
    const ref = text.match(new RegExp(String.raw`\b(almoc|jant|lanch)(?:ei|amos)\b\s*(?:por|de|uns|umas)?\s*(?:r\$)?\s*${NUM}(?!\d|[.,]\d)\s*${MOEDA}?\s*$`, 'i'))
    const amount = ref ? parseNum(ref[2]) : NaN
    if (ref && amount > 0) {
      const nome: Record<string, string> = { almoc: 'Almoço', jant: 'Jantar', lanch: 'Lanche' }
      actions.push({ kind: 'expense', amount, category: 'alimentacao', description: nome[ref[1].toLowerCase()] })
    }
  }

  // ----- valor ANTES do verbo de saída: "entrou 3200 do salario e 1100 SAIU de
  // aluguel". A ordem é a da fala; sem esta leitura a despesa sumia, e o
  // substantivo de renda da outra metade ainda tirava o "saiu" da lista acima.
  if (!m && !abasteceu) {
    const valorVerboRe = new RegExp(String.raw`(?:^|\se\s|,(?!\d)|;)\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s+saiu\s+(?:de|do|da|com|no|na|em|pr[ao])\s+([a-zà-úçãõ][\wçãõáéíóúâê]*)`, 'gi')
    for (const vv of text.matchAll(valorVerboRe)) {
      const amount = parseNum(vv[1])
      if (!(amount > 0) || actions.some(a => (a as any).amount === amount)) continue
      actions.push({ kind: 'expense', amount, category: guessCategory(vv[2], 'expense'), description: cleanDescription(vv[2]) })
    }
  }

  // ----- despesa na ordem inversa: "comprei cimento por 190", "paguei a internet a 120"
  if (!e && !m && !abasteceu) {
    const rideFare = text.match(new RegExp(
      String.raw`\b(?:paguei|gastei)\s+(?:(?:a|uma|minha)\s+)?(corrida(?:\s+(?:d[ao]|n[ao]|via)\s+${APP_DE_CORRIDA})?)`
      + String.raw`\s+(?:(?:de|com)\s+\d+(?:[.,]\d+)?\s*(?:kms?|quil[oô]metros?|metros?)\s+)?`
      + String.raw`(?:de|por|no\s+valor\s+de)\s*(?:r\$\s*)?${NUM}(?!\d|[.,]\d|${UNIT_AFTER}(?![\p{L}\p{M}])|\s*(?:kms?|metros?|m)\b)`, 'iu',
    ))
    const invRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+${APROX}(?:um|uma|o|a|uns|umas)?\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[\wçãõáéíóúâê]+){0,2}?)\s+(?:por|a|custou|saiu por)\s*(?:r\$)?\s*${NUM}(?!\d|[.,]\d|${UNIT_AFTER}(?![\p{L}\p{M}]))`, 'iu')
    // "paguei o boleto de 300", "comprei uma camisa de 60": o "de" depois do
    // item também liga o valor. O número não pode ser seguido de unidade —
    // "a parcela de 3 meses", "o pacote de 2 kg" não dizem quanto custou.
    const deRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+${APROX}(?:um|uma|o|a|uns|umas)\s+([a-zà-úçãõ][\wçãõáéíóúâê-]*(?:\s+[\wçãõáéíóúâê-]+){0,3}?)\s+de\s+(?:r\$)?\s*${NUM}\s*${MOEDA}?(?!\s*(?:x\b|vezes|parcelas?|meses|m[eê]s|dias?|anos?|semanas?|horas?|h\b|min|minutos?|km|quil[oô]metros?|litros?|l\b|kg|quilos?|gramas?|g\b|gb|%|por\s*cento|metros?|m\b|unidades?|pe[cç]as?))\s*$`, 'i')
    const inv = rideFare || text.match(invRe) || text.match(deRe)
    if (inv) {
      const desc = cleanDescription(inv[1])
      actions.push({ kind: 'expense', amount: parseNum(inv[2]), category: guessCategory(inv[1] || text, 'expense'), description: desc })
    } else {
      // Sem preposição nenhuma no meio: "paguei o aluguel 900". Exige que o
      // substantivo seja de uma categoria conhecida — é o que separa isto de
      // um número solto que ninguém sabe o que é.
      // Dois itens com "e" ("comprei pão e leite 18") são um gasto só: sem o
      // "e" a frase caía na ajuda genérica.
      const nuRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+(?:mais\s+)?(?:o|a|os|as|um|uma|meu|minha)?\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+(?:e\s+)?[a-zà-úçãõ][\wçãõáéíóúâê]*)?)\s+(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*$`, 'i')
      // "Paguei a taxa DA 99": o número é a plataforma, não o valor.
      const nu = /\b(?:d[ao]|n[ao]|pel[ao]|via)\s+99\s*$/i.test(text) ? null : text.match(nuRe)
      const cat = nu ? guessCategory(nu[1], 'expense') : undefined
      if (nu && cat) {
        actions.push({ kind: 'expense', amount: parseNum(nu[2]), category: cat, description: cleanDescription(nu[1]) })
      }
    }
  }

  // itens enumerados após o verbo, nas duas ordens:
  // "gastei 20 de pedágio e 40 de gasolina, 15 de lanche"
  // "comprei cimento por 190 e depois areia por 150"
  if (/(gastei|paguei|comprei|torrei|coloquei|botei)/.test(text) && !m) {
    // `,(?!\d)` é essencial: sem isso a vírgula decimal de "1.234,56" era lida
    // como separador de itens e inventava uma segunda despesa de R$ 56.
    const sep = String.raw`(?:\se\s|,(?!\d)|;|\s(?:${CONNECTOR}))`
    const enumRe = new RegExp(String.raw`${sep}\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:de|com|no|na|em)\s+([a-zà-úçãõ]+(?:\s+[a-zà-úçãõ]+)?)`, 'gi')
    for (const mm of text.matchAll(enumRe)) {
      const rawDesc = mm[2].trim()
      const amount = parseNum(mm[1])
      const isFuel = /gasolina|etanol|alcool|álcool|diesel|combust/.test(rawDesc)
      if (isFuel) {
        if (!abasteceu) actions.push({ kind: 'fuel', amount })
      } else {
        actions.push({ kind: 'expense', amount, category: guessCategory(rawDesc, 'expense'), description: cleanDescription(rawDesc) })
      }
    }
    // Itens JUSTAPOSTOS, sem conector nenhum: "paguei 320 de luz 180 de agua".
    // É como se lê a conta de casa em voz alta, e o separador simplesmente não
    // existe. A trava é a mesma dos itens enumerados — o valor precisa vir
    // seguido de preposição e substantivo —, e a varredura começa depois do
    // primeiro gasto, que já foi lido acima.
    if (e) {
      const desde = (e.index || 0) + e[0].length
      const juxRe = new RegExp(String.raw`(?:^|\s)(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:de|com|no|na|em)\s+([a-zà-úçãõ]+(?:\s+[a-zà-úçãõ]+)?)`, 'gi')
      for (const jx of text.slice(desde).matchAll(juxRe)) {
        const rawDesc = jx[2].trim()
        const amount = parseNum(jx[1])
        if (!(amount > 0) || DESC_STOPWORDS.has(rawDesc)) continue
        const isFuel = /gasolina|etanol|alcool|álcool|diesel|combust/.test(rawDesc)
        if (isFuel) {
          if (!abasteceu) actions.push({ kind: 'fuel', amount })
        } else {
          actions.push({ kind: 'expense', amount, category: guessCategory(rawDesc, 'expense'), description: cleanDescription(rawDesc) })
        }
      }
    }

    // Valor enumerado SEM descrição própria: "gastei 20 e 30" são dois gastos.
    // O segundo valor virava a descrição do primeiro e o dinheiro sumia. O
    // lookahead é a trava: o valor precisa terminar a frase ou ser seguido de
    // outro separador — se vier "30 na farmácia", quem cuida é o regex acima.
    const enumBareRe = new RegExp(String.raw`${sep}\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?=$|\se\s|,(?!\d)|;)`, 'gi')
    for (const mm of text.matchAll(enumBareRe)) {
      const amount = parseNum(mm[1])
      if (!(amount > 0)) continue
      if (actions.some(a => (a as any).amount === amount)) continue
      actions.push({ kind: 'expense', amount, category: guessCategory(text, 'expense') })
    }

    const enumInvRe = new RegExp(String.raw`${sep}\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[\wçãõáéíóúâê]+)?)\s+(?:por|a|custou)\s*(?:r\$)?\s*${NUM}`, 'gi')
    for (const mm of text.matchAll(enumInvRe)) {
      const rawDesc = mm[1].trim()
      if (DESC_STOPWORDS.has(rawDesc)) continue
      actions.push({ kind: 'expense', amount: parseNum(mm[2]), category: guessCategory(rawDesc, 'expense'), description: cleanDescription(rawDesc) })
    }
  }

  // despesa implícita em frase de abastecimento com "gastei X de gasolina" já coberta acima;
  // se detectamos fuel sem valor mas há "gastei X", funde
  const fuelIdx = actions.findIndex(a => a.kind === 'fuel' && !(a as any).amount)
  const expIdx = actions.findIndex(a => a.kind === 'expense' && /gasolina|combust|etanol|alcool/.test((a as any).description || ''))
  if (fuelIdx >= 0 && expIdx >= 0) {
    ;(actions[fuelIdx] as any).amount = (actions[expIdx] as any).amount
    actions.splice(expIdx, 1)
  }

  // ----- correção de trabalho: "retira 100km rodados", "diminui 80 km dos rodados hoje", "tira 2 viagens"
  const kmSubM = text.match(new RegExp(String.raw`(?:${WORK_SUB_VERBS})\s+(?:os|as)?\s*${NUM}\s*(?:km|quil[oô]metros?)`, 'i'))
  const tripsSubM = text.match(new RegExp(String.raw`(?:${WORK_SUB_VERBS})\s+(?:as|os)?\s*${NUM}\s*(?:viagens|corridas)`, 'i'))
  const hoursSubM = text.match(new RegExp(String.raw`(?:${WORK_SUB_VERBS})\s+(?:as)?\s*${NUM}\s*(?:horas?|h)\b`, 'i'))
  if (kmSubM || tripsSubM || hoursSubM) {
    actions.push({
      kind: 'work',
      km: kmSubM ? -parseNum(kmSubM[1]) : undefined,
      trips: tripsSubM ? -parseNum(tripsSubM[1]) : undefined,
      hours: hoursSubM ? -parseNum(hoursSubM[1]) : undefined,
    })
  }

  // ----- trabalho: "rodei 120 km", "fiz 14 viagens", "trabalhei 8 horas"
  // (não confundir "faz 8 km/litro" — consumo — com distância rodada)
  const kmConsumo = /km\s*(?:\/\s*l\b|\/\s*litro|\s+l\b|\s+litro|\s+por\s+litro)/.test(text)
  // A borda de palavra é obrigatória: "mANDEI 200 pra meta" casava "andei 200" e,
  // no perfil motorista, virava 200 km rodados.
  // "Rodei 8 HORAS" é jornada: o número seguido de hora não é distância (virava
  // 8 km). A trava de dígito impede o recuo que leria "12 horas" como 1 km.
  const kmM = kmConsumo ? null : text.match(new RegExp(String.raw`\b(?:rodei|andei|dirigi|percorri|consegui\s+rodar)\s*(?:mais\s+)?${NUM}(?![\d.,]|\s*(?:horas?|hrs?|h)\b)\s*(?:${WORK_KM})?`, 'i'))
    // "Rodei 8h E 150 KM", "fiz 12 corridas E 40 KM": a distância vem depois
    // da outra medida, com a unidade dita.
    || (/\b(?:rodei|andei|dirigi|percorri)\b|\b\d+\s+(?:corridas|viagens)\b/i.test(text)
      ? text.match(new RegExp(String.raw`(?<![\wÀ-ÿ])(?:e|com)\s+${NUM}\s*${WORK_KM}`, 'i')) : null)
  const tripsM = text.match(new RegExp(String.raw`(?:fiz|realizei|completei)?\s*${NUM}\s*(?:viagens|corridas)`, 'i'))
  const hoursM = text.match(new RegExp(String.raw`\b(?:trabalhei|fiquei|rodei(?:\s+por)?)\s*${NUM}\s*(?:horas?|hrs?|h)\b`, 'i'))
    // "Rodei 150 km E 8 HORAS", "fiz 5 corridas E 3 HORAS": a jornada depois.
    || (/\b(?:rodei|trabalhei)\b|\b\d+\s+(?:corridas|viagens)\b/i.test(text) ? text.match(new RegExp(String.raw`\be\s+${NUM}\s*(?:horas?|hrs?|h)\b`, 'i')) : null)
    // Ditado telegráfico com a quantidade de corridas: "fiz 18 corridas 420
    // reais 9 horas". Sem conector nenhum, as horas se perdiam.
    || (/\b\d+\s+(?:corridas|viagens)\b/i.test(text) ? text.match(new RegExp(String.raw`(?<![\d.,])${NUM}\s*(?:horas|hrs?)\b`, 'i')) : null)
    || text.match(new RegExp(String.raw`${NUM}\s*horas?\s*(?:online|trabalhad)`, 'i'))
    // Jornada como o motorista fala: "8 horas na rua", "10 horas rodando".
    || text.match(new RegExp(String.raw`${NUM}\s*(?:horas?|hrs?)\s+(?:na\s+rua|de\s+rua|rodando|na\s+ativa|no\s+corre|na\s+labuta|no\s+trampo|trabalhando|de\s+trabalho)`, 'i'))
    // "rodei 200 km EM 10 HORAS" — a jornada vinha junto da distância e se
    // perdia inteira, porque nenhum dos padrões acima cobre "em N horas".
    || text.match(new RegExp(String.raw`(?:km|quil[oô]metros?|viagens|corridas)\s*(?:em|durante)\s*${NUM}\s*(?:horas?|hrs?|h)\b`, 'i'))
    // "Fiz 450 EM 12 HORAS": o resultado do dia e a jornada na mesma frase.
    || text.match(new RegExp(String.raw`\b(?:fiz|ganhei|faturei|tirei)\s+(?:r\$\s*)?\d+(?:[.,]\d+)?\s*(?:reais\s*)?(?:em|durante)\s*${NUM}\s*(?:horas?|hrs?|h)\b`, 'i'))

  const hours = duration.minutes ? duration.minutes / 60 : hoursM ? parseNum(hoursM[1]) : undefined
  const km = distanceWorked(text, kmM)
  const kmIsMaint = m && m[3] // km da manutenção
  if ((km && !kmIsMaint && !kmSubM) || (tripsM && !tripsSubM) || (hours !== undefined && !hoursSubM)) {
    actions.push({
      kind: 'work',
      km: !kmIsMaint && !kmSubM ? km : undefined,
      trips: tripsM && !tripsSubM ? parseNum(tripsM[1]) : undefined,
      hours: hoursSubM ? undefined : hours,
    })
  }

  // Último recurso: nem verbo, nem preposição, só o item e o preço.
  if (!actions.length) actions.push(...parseSemVerbo(text))

  // dedupe: receita detectada dentro de frase de meta
  return actions
}

/**
 * "Almoço 25", "25 no almoço", "lanche 15 e café 5".
 *
 * É como se anota gasto no bloquinho: item e preço, sem verbo nenhum. Só entra
 * quando a frase NÃO tem verbo de comando — os caminhos acima já atenderam quem
 * disse o verbo, e disputar com eles duplicaria o lançamento.
 *
 * A trava contra invenção é a CATEGORIA: o substantivo precisa ser reconhecido
 * por `guessCategory`. "Hoje 250" e "8 horas" não viram gasto porque "hoje" e
 * "horas" não são categoria de nada.
 */
/**
 * DEPÓSITOS ALÉM DO PRIMEIRO: "guardei 300 na meta da viagem E 200 NA OUTRA".
 *
 * O caminho da meta devolvia a primeira leitura e encerrava a cláusula ali: os
 * R$ 200 nunca eram procurados e sumiam em silêncio — o usuário confirmava 300
 * e achava que tinha guardado 500.
 *
 * Só roda quando um depósito JÁ foi reconhecido (senão "paguei 200 na padaria"
 * viraria meta), e só aceita valor seguido de destino. "A outra" não é nome de
 * meta nenhuma: vai com essa marca e quem resolve é o orquestrador, que tem o
 * estado — uma meta sobrando, é ela; mais de uma, pergunta.
 */
export const META_OUTRA = 'outra'

/** Quando e como, ditos depois do valor de um depósito. O fim é lookahead porque `\b` não vê o "ã". */
const TEMPO_NO_NOME = /\b(?:(?:essa|esta|nessa|nesta)\s+semana|(?:esse|este|nesse|neste)\s+m[eê]s|hoje(?:\s+cedo)?|cedo|agora|de\s+novo|novamente|de\s+(?:manh[ãa]|tarde|noite)|(?:mais\s+)?uma\s+vez)(?![\wà-ú])/gi

function outrosDepositos(text: string, actions: ParsedAction[]): void {
  const re = new RegExp(
    String.raw`(?:\se\s|,(?!\d)|;)\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:na|no|pra|pro|para|em)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?(?:met[ao]\s+(?:d[aoe]\s+)?)?([a-zà-úçãõ][\wçãõáéíóúâê]*)`,
    'gi',
  )
  for (const m of text.matchAll(re)) {
    const amount = parseNum(m[1])
    if (!(amount > 0)) continue
    if (actions.some(a => Math.abs(((a as any).amount ?? 0) - amount) < 0.005)) continue
    const nome = m[2].toLowerCase()
    if (/^(?:outra|outro)$/.test(nome)) actions.push({ kind: 'goal-deposit', amount, name: META_OUTRA } as ParsedAction)
    else if (!DESC_STOPWORDS.has(nome)) actions.push({ kind: 'goal-deposit', amount, name: nome } as ParsedAction)
  }
}

function parseSemVerbo(text: string): ParsedAction[] {
  if (new RegExp(String.raw`\b(?:${COMMAND_VERBS.join('|')})\b`, 'i').test(text)) return []
  // Perguntar quanto PODE gastar não é dizer que gastou. Sem esta guarda,
  // "posso gastar 50 no mercado?" virava uma despesa de 50 — o verbo está no
  // infinitivo, então nenhuma das listas de comando o barrava.
  if (PERGUNTA_EM_QUALQUER_LUGAR.test(text)
    || /^\s*(?:como|posso|poderia|devo|preciso|vale|d[áa]\s+pra|d[áa]\s+para|ser[áa]|tem\s+como)\b/i.test(text)) return []
  // Orçamento, cotação e preço no PRESENTE não são dinheiro que saiu: "o
  // mecânico me deu um orçamento de 500", "o pneu tá 400 na loja", "cobra 500
  // pra trocar". Sem verbo de pagar, nada disso é lançamento.
  // "A conta de água VEIO 95": a conta chegou, não foi paga — e pago ou não
  // é o usuário quem diz.
  if (/(?<![\wÀ-ÿ])(?:veio|vieram|chegou|chegaram|vem|vai\s+vir)(?![\wÀ-ÿ])/i.test(text)
    || /or[çc]amento|cota[çc][ãa]o|\bpre[çc]os?\b/i.test(text)
    || /(?<![\wÀ-ÿ])(?:t[áa]|est[áa]|custa|custam|cobra|cobram|fica|ficaria|sairia|custaria|cobraria|vale)(?![\wÀ-ÿ])/i.test(text)) return []

  const out: ParsedAction[] = []
  // `,(?!\d)` preserva a vírgula decimal: "1.234,56" é um valor, não dois itens.
  for (const trecho of text.split(/\s+e\s+|,(?!\d)|;/)) {
    const t = trecho.trim()
    if (!t) continue
    // "Taxa DA 99 1 real": o 99 depois de preposição é a plataforma.
    const vm = [...t.matchAll(new RegExp(String.raw`(?:r\$)?\s*${NUM}\s*${MOEDA}?`, 'gi'))]
      .find(m => !(m[1] === '99' && /(?:\b(?:d[ao]|n[ao]|pel[ao]|via|app|aplicativo|plataforma)\s*)$/i.test(t.slice(0, m.index || 0))))
    if (!vm) continue
    const amount = parseNum(vm[1])
    if (!(amount > 0)) continue
    // Número com unidade é quantidade, não preço.
    const depois = t.slice((vm.index || 0) + vm[0].length)
    if (new RegExp(`^${UNIT_AFTER}`, 'i').test(depois)) continue

    const nome = (t.slice(0, vm.index || 0) + ' ' + depois).replace(/\s+/g, ' ').trim()
    const cat = guessCategory(nome, 'expense')
    if (!cat) continue
    out.push({ kind: 'expense', amount, category: cat, description: cleanDescription(nome) })
  }
  return out
}

/**
 * Resumo detalhado mostrado antes de registrar (14.7): tipo, valor, categoria,
 * origem, data e taxa. O usuário sempre vê exatamente o que será gravado.
 */
export function describeActionDetailed(a: ParsedAction, opts?: { fee?: number; categoryName?: (id: string) => string }): string[] {
  const money = (v: number) => `${fmtBRL(v)}`
  const catName = (id?: string) => (id ? (opts?.categoryName?.(id) || id) : undefined)
  const lines: string[] = []
  switch (a.kind) {
    case 'income':
    case 'expense': {
      lines.push(`${a.kind === 'income' ? 'Receita' : 'Despesa'} de ${money(a.amount)}`)
      const c = catName(a.category)
      if (c) lines.push(`Categoria: ${sentenceCase(c)}`)
      if ((a as any).origin) lines.push(`Origem: ${sentenceCase((a as any).origin)}`)
      if (a.description) lines.push(`Descrição: ${sentenceCase(a.description)}`)
      lines.push('Data: Hoje')
      if (a.kind === 'income' && (a.category === 'corridas' || a.is99)) {
        lines.push('A taxa da 99 só será incluída se você confirmar o saque separadamente.')
      }
      break
    }
    case 'saving':
      lines.push(`Guardar ${money(a.amount)} na reserva`)
      if (a.description) lines.push(`Onde: ${sentenceCase(a.description)}`)
      lines.push('Data: Hoje')
      lines.push('Não conta como despesa.')
      break
    case 'card-purchase': {
      const per = a.total / Math.max(a.installments, 1)
      lines.push(`Compra parcelada${a.description ? `: ${sentenceCase(a.description)}` : ''}`)
      lines.push(`Valor total: ${money(a.total)}`)
      lines.push(`Parcelas: ${a.installments}x de ${money(per)}`)
      lines.push(`Cartão: ${a.cardName || 'não informado (registra sem cartão)'}`)
      if (a.date) lines.push(`Data da compra: ${a.date.split('-').reverse().join('/')}`)
      lines.push(`1º vencimento: ${a.firstDueDate ? a.firstDueDate.split('-').reverse().join('/') : 'próxima fatura'}`)
      const c = catName(a.category)
      if (c) lines.push(`Categoria: ${sentenceCase(c)}`)
      lines.push(`Impacto: ${money(per)} por mês nas próximas ${a.installments} fatura(s).`)
      break
    }
    case 'financed-cash-inflow': {
      const per = a.total / Math.max(a.installments, 1)
      lines.push('Entrada financiada pelo cartão')
      lines.push(`Recebido agora: ${money(a.netReceived)}`)
      lines.push(`Dívida no cartão: ${money(a.total)}`)
      lines.push(`Custo da operação: ${money(Math.max(a.total - a.netReceived, 0))}`)
      lines.push(`Parcelas: ${a.installments}x de ${money(per)}`)
      if (a.cardName) lines.push(`Cartão: ${a.cardName}`)
      lines.push('Não é receita nem lucro — seu patrimônio não aumenta.')
      break
    }
    case 'card-payment':
      lines.push('Pagamento de fatura')
      lines.push(`Cartão: ${a.cardName || 'não informado'}`)
      if (a.referenceMonth) lines.push(`Mês de vencimento: ${a.referenceMonth.split('-').reverse().join('/')}`)
      if (a.date) lines.push(`Data do pagamento: ${a.date.split('-').reverse().join('/')}`)
      lines.push(a.amount ? `Valor: ${money(a.amount)} (pagamento parcial se for menor que a fatura)`
        : a.expectedPending !== undefined ? `Valor: ${money(a.expectedPending)} (todo o pendente da fatura)` : 'Valor: todo o pendente da fatura')
      lines.push('Não gera despesa nova — as compras já foram contadas como parcelas.')
      break
    case 'card-charge':
      lines.push(`Assinatura${a.description ? `: ${sentenceCase(a.description)}` : ''}`)
      lines.push(`Valor: ${money(a.amount)} por mês`)
      lines.push(`Cartão: ${a.cardName || 'não informado'}`)
      lines.push('Recorrente até você cancelar — não é parcelamento.')
      break
    default:
      lines.push(describeAction(a))
  }
  return lines
}

/**
 * Linha da proposta que o usuário confere antes de gravar. A categoria sai
 * pelo NOME: o id ("outros-out", "alimentacao") é detalhe interno, e o de uma
 * categoria criada pelo usuário é aleatório.
 */
export function describeAction(a: ParsedAction, categoryName?: (id: string) => string | undefined): string {
  const cat = (id?: string) => id
    ? ` (${categoryName?.(id) || DEFAULT_CATEGORIES.find(c => c.id === id)?.name || id})` : ''
  switch (a.kind) {
    case 'income': {
      // De ONDE veio é o que se confere: "(Aluguéis)" não diz que foi a Casa 2.
      // A descrição só entra quando diz algo que a categoria e a origem não dizem.
      const nomeCat = normalizeName(categoryName?.(a.category || '') || DEFAULT_CATEGORIES.find(c => c.id === a.category)?.name)
      const extra = [a.origin, a.description]
        .filter((x, i, xs): x is string => !!x?.trim() && xs.findIndex(y => normalizeName(y) === normalizeName(x)) === i
          && !nomeCat.startsWith(normalizeName(x).replace(/s$/, '')))
      return `Receita de ${fmtBRL(a.amount)}${cat(a.category)}${extra.length ? ` — ${extra.map(x => sentenceCase(x)).join(' · ')}` : ''}${a.is99 ? ' — plataforma 99' : ''}`
    }
    case 'expense': return `Despesa de ${fmtBRL(a.amount)}${cat(a.category)}${a.description ? ` — ${a.description}` : ''}`
    // Sem este caso o `switch` caía fora e a linha da proposta virava "undefined".
    case 'saving': return `Guardar ${fmtBRL(a.amount)} na reserva${a.description ? ` — ${a.description}` : ''}`
    case 'work': {
      // A proposta escrevia "1 viagens". É o texto que o usuário lê para
      // conferir antes de gravar — concordância errada ali passa desleixo.
      const viagem = (n: number) => `${n} ${n === 1 ? 'viagem' : 'viagens'}`
      const parts = []
      if (a.km) parts.push(a.km > 0 ? `${fmtNum(a.km, 3)} km` : `${fmtNum(Math.abs(a.km), 3)} km removidos`)
      if (a.trips) {
        parts.push(a.trips > 0
          ? viagem(a.trips)
          : `${viagem(Math.abs(a.trips))} ${Math.abs(a.trips) === 1 ? 'removida' : 'removidas'}`)
      }
      if (a.hours) {
        const rawMinutes = Math.abs(a.hours) * 60
        const rounded = Math.round(rawMinutes)
        const h = Math.floor(rounded / 60)
        const min = rounded % 60
        const asMinutes = rounded && Math.abs(rounded - rawMinutes) <= 0.031
        const duration = asMinutes ? [h ? `${h}h` : '', min ? `${min} min` : ''].filter(Boolean).join(' ')
          : `${fmtNum(Math.abs(a.hours), 3)}h`
        parts.push(`${duration} ${a.hours > 0 ? 'de trabalho' : 'de trabalho removidos'}`)
      }
      return `Trabalho: ${parts.join(', ')}`
    }
    case 'fuel': return `Abastecimento${a.amount ? ` de ${fmtBRL(a.amount)}` : ''}${a.liters ? ` (${a.liters} L)` : ''}${a.odometer ? ` · hodômetro ${a.odometer.toLocaleString('pt-BR')} km` : ''}`
    case 'odometer': return `Hodômetro atual: ${a.value.toLocaleString('pt-BR')} km`
    // O intervalo aparece na proposta porque é ele que faz o lembrete de troca
    // existir — confirmar sem ver isso esconde metade do que foi entendido.
    case 'maintenance': return `Manutenção: ${a.item} — ${fmtBRL(a.cost)}${a.km ? ` aos ${a.km.toLocaleString('pt-BR')} km` : ''}${a.lifeKm ? ` · troca a cada ${a.lifeKm.toLocaleString('pt-BR')} km` : ''}`
    case 'goal': return `Meta: ${a.name} — R$ ${a.target.toLocaleString('pt-BR')}${a.months ? ` em ${Math.round(a.months)} meses` : ''}`
    case 'goal-update': return `Alterar meta${a.name ? ` "${a.name}"` : ''}${a.target ? ` para R$ ${a.target.toLocaleString('pt-BR')}` : ''}`
    case 'goal-deposit': return `Guardar ${fmtBRL(a.amount)}${a.name ? ` na meta "${a.name}"` : ' na meta'}`
    case 'balance': return `Saldo em conta: ${fmtBRL(a.amount)}`
    case 'card-purchase':
      // No meio da frase, a descrição vai em minúscula (regra 13): "Compra de
      // celular", nunca "Compra de Celular". Sigla e marca ficam como estão.
      return `Compra${a.description ? ` de ${noMeioDaFrase(a.description)}` : ''} de ${fmtBRL(a.total)} em ${a.installments}x${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'financed-cash-inflow':
      return `Entrada financiada: recebeu ${fmtBRL(a.netReceived)} e deve ${fmtBRL(a.total)} em ${a.installments}x`
    case 'card-payment':
      return `Pagar fatura${a.cardName ? ` do ${a.cardName}` : ''}${a.referenceMonth ? ` de ${a.referenceMonth.split('-').reverse().join('/')}` : ''}${a.amount ? ` — ${fmtBRL(a.amount)}`
        : a.expectedPending !== undefined ? ` — ${fmtBRL(a.expectedPending)} (todo o pendente)` : ' (valor pendente)'}`
    case 'card-charge':
      return `Assinatura${a.description ? ` ${a.description}` : ''} de ${fmtBRL(a.amount)}/mês${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'reset': return 'Apagar TODOS os dados do app'
    case 'undo-batch': return 'Desfazer o último registro do assistente'
    case 'edit-transaction': return 'Corrigir um lançamento já salvo'
    case 'recurring-confirm': {
      const venc = /^\d{4}-\d{2}-\d{2}$/.test(a.occurrenceDate || '') ? a.occurrenceDate.split('-').reverse().join('/') : ''
      const title = a.transactionId ? 'Vincular lançamento existente à conta fixa' : 'Confirmar pagamento da conta fixa'
      return `${title}${a.description ? ` "${a.description}"` : ''}${a.amount ? ` — ${fmtBRL(a.amount)}` : ' (valor cadastrado)'}${venc ? ` · vencimento ${venc}` : ''}`
    }
  }
}
