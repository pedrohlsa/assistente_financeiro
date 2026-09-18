// Registro por linguagem natural (seções 9 e 10).
// Parser local em pt-BR — funciona offline. Preparado para ser substituído/complementado
// por um serviço de IA no backend (ver services/ai.ts).
import { ParsedAction } from '../models/types'
import { guessCategory } from '../data/categories'
import { fmtBRL, parseMoney } from '../utils/format'
import { sentenceCase } from '../utils/text'

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
  'colocando', 'comprando', 'pagando', 'gastando', 'depois', 'pois', 'logo', 'entao', 'então',
  'tambem', 'também', 'ainda', 'mais', 'de', 'do', 'da', 'no', 'na', 'em', 'com', 'para', 'pra',
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
export function cleanDescription(raw?: string): string | undefined {
  if (!raw) return undefined
  const words = raw.toLowerCase().replace(/[.,;!?]+$/g, '').split(/\s+/).filter(Boolean)
  while (words.length && DESC_STOPWORDS.has(words[0])) words.shift()
  while (words.length && DESC_STOPWORDS.has(words[words.length - 1])) words.pop()
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

function splitClauses(input: string): string[] {
  const marked = input
    .toLowerCase()
    .replace(new RegExp(String.raw`[\s,;]+(?:${CONNECTOR})?(?:e\s+)?(?=(?:${COMMAND_VERBS.join('|')})\b)`, 'g'), '\n')
  return marked.split(/\n|;|\.\s/).map(s => s.trim()).filter(Boolean)
}

export function parseNatural(input: string): ParsedAction[] {
  // Operações de cartão são analisadas na frase INTEIRA antes de qualquer
  // quebra: "passei 2000 em 5 vezes E RECEBI 1850" tem um verbo de comando no
  // meio, e cortar ali transformava uma entrada financiada numa receita de
  // 1850 — exatamente o que a regra 11 proíbe.
  const whole = parseCardClause(input.toLowerCase().trim())
  if (whole.length) return whole

  const clauses = splitClauses(input)
  let actions = clauses.length > 1 ? clauses.flatMap(c => parseClause(c)) : parseClause(input)

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

  // remove duplicatas exatas (mesma ação detectada em duas cláusulas)
  const seen = new Set<string>()
  return actions.filter(a => {
    const k = JSON.stringify(a)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
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
const STRONG_EXPENSE_VERB = /\b(?:gastei|paguei|comprei|torrei|coloquei|botei|abasteci|enchi|parcelei|passei|guardei|separei)\b/i
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
].join('|'), 'i')

export const looksRecurring = (t: string): boolean => RECORRENCIA.test(t)

// Número que carrega unidade não é dinheiro: "8 horas", "120 km", "14 viagens".
// Unidade de TEMPO também: "nos ultimo 3 mes" virava uma despesa de R$ 3,00,
// porque o 3 é o tamanho do período e a frase inteira era uma pergunta.
const UNIT_AFTER = String.raw`\s*(?:h\b|horas?\b|hrs?\b|km\b|quil[oô]metros?\b|viagens?\b|corridas?\b|litros?\b|l\b|%|minutos?\b|min\b|vezes\b|x\b|dias?\b|semanas?\b|m[eê]s(?:es)?\b|anos?\b)`

/**
 * Pergunta, em qualquer posição da frase, inclusive abreviada. "qnto q foi d
 * obra" não começa por "quanto" e "obra 3 meses quanto" termina por ele: as
 * duas passavam pela guarda que só olhava o começo da frase.
 */
const PERGUNTA_EM_QUALQUER_LUGAR = /\?|\b(?:quanto|quantos|quantas|qual|quais|quando|onde|qnto|qnta|qntos|qntas|qnt|qto|qta|qts|qnd|qndo)\b/i
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

  const income: ParsedAction = { kind: 'income', amount, category: 'corridas' }

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
 * Parse completo: além das ações, devolve a pergunta de desambiguação quando o
 * texto não permite decidir com segurança.
 */
export function parseNaturalFull(
  input: string,
  opts?: { driver?: boolean; dayHint?: boolean; inheritedKind?: 'income' | 'expense' },
): ParseResult {
  let actions = parseNatural(input)
  let dayAsk: DayResult['ask']
  let doDia = false

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

    const dia = driverDayResult(input, actions, opts?.dayHint)
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

    const rideContext = /\bcorridas?\b|\buber\b|\bindriver\b|\b99\b/i.test(input)
    actions = actions.map(a => a.kind === 'income' && (!a.category || rideContext)
      ? { ...a, category: a.category || 'corridas' }
      : a)

    // Um registro de receita de corrida representa uma viagem quando o usuário
    // não informou uma quantidade explícita. "Fiz 14 viagens" continua valendo 14.
    // O resultado do DIA é a exceção: "fechei o dia com 280" não diz nada sobre
    // quantas viagens foram, e cravar "1 viagem" num dia inteiro destruiria o
    // ganho por viagem do motorista.
    const hasExplicitTrips = actions.some(a => a.kind === 'work' && a.trips !== undefined)
    const rideEntries = actions.filter(a => a.kind === 'income' && a.category === 'corridas').length
    if (!hasExplicitTrips && rideEntries > 0 && !doDia) {
      const work = actions.find(a => a.kind === 'work') as Extract<ParsedAction, { kind: 'work' }> | undefined
      if (work) work.trips = rideEntries
      else actions.push({ kind: 'work', trips: rideEntries })
    }
  }

  if (dayAsk) return { actions, ambiguity: dayAsk }

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
function parseCardClause(text: string): ParsedAction[] {
  // "passei 2000 em 5 vezes e recebi 1850 líquidos" — entrada financiada (seção 7)
  const financed = text.match(new RegExp(
    String.raw`(?:passei|passou|fiz)\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:no cart[ãa]o\s*)?(?:em|x|vez(?:es)?)?\s*(\d+)?\s*(?:vez(?:es)?|x|parcelas?)?[^\d]*(?:e\s*)?(?:recebi|receber|peguei|caiu)\s*(?:r\$)?\s*${NUM}`, 'i'))
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
  if (/fatura/.test(text) && /(paguei|pagar|quitei|quitar)/.test(text)) {
    const amountM = text.match(new RegExp(String.raw`(?:paguei|pagar|quitei)\s*(?:r\$)?\s*${NUM}`, 'i'))
    return [{ kind: 'card-payment', cardName: matchCardName(text), amount: amountM ? parseNum(amountM[1]) : undefined }]
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
  if (/(comprei|compra|parcelei|parcelad[oa]|passei)/.test(text)) {
    const instM = text.match(/(?:em|x)\s*(\d+)\s*(?:vez(?:es)?|x|parcelas?)|(\d+)\s*x\b/i)
    const valM = text.match(new RegExp(String.raw`(?:de|por|custou|valor de)\s*(?:r\$)?\s*${NUM}(?:\s*(mil))?`, 'i'))
      || text.match(new RegExp(String.raw`(?:r\$)\s*${NUM}(?:\s*(mil))?`, 'i'))
      // Valor colado no verbo, sem dizer o que foi comprado: "passei 1200 no
      // nubank em 3x". Sem esta forma a compra parcelada inteira se perdia —
      // e nem todo mundo descreve o item ao lançar.
      || text.match(new RegExp(String.raw`(?:comprei|parcelei|passei)\s+(?:r\$)?\s*${NUM}(?:\s*(mil))?`, 'i'))
    // Sem valor OU sem parcelas não registra nada: quem pergunta é o assistente.
    if (!valM || !instM) return []
    let total = parseNum(valM[1])
    if (valM[2]) total *= 1000
    const installments = parseInt(instM[1] || instM[2], 10)
    if (!(total > 0) || !(installments > 0)) return []
    // terminadores precisam ser palavras inteiras, senão "geladeira" vira "gela" + "de"
    const descM = text.match(/(?:comprei|parcelei|passei)\s+(?:um|uma|o|a|uns|umas)\s+([\wçãõáéíóúâê]+(?:\s+[\wçãõáéíóúâê]+)*?)(?=\s+(?:de|por|em|no|na)\b|\s*r\$|\s*\d)/i)
    return [{
      kind: 'card-purchase',
      description: descM ? descM[1].trim() : undefined,
      total, installments,
      cardName: matchCardName(text),
      category: guessCategory(descM?.[1] || text, 'expense'),
    }]
  }
  return []
}

/** Nome do cartão citado depois de "no/na/pelo". Nunca inventa um cartão. */
function matchCardName(text: string): string | undefined {
  // Percorre TODAS as ocorrências: em "paguei 600 da fatura do Nubank" a
  // primeira ("da fatura") é genérica e a segunda é o nome real. Parar na
  // primeira devolvia `undefined` e o pagamento ficava sem cartão.
  // Trabalhar por PALAVRA em vez de uma captura de duas palavras: com regex a
  // primeira ocorrência engolia "fatura do" e o nome real ficava fora do
  // alcance da busca seguinte.
  const TRIGGER = /^(?:no|na|pelo|pela|do|da|cart[ãa]o)$/i
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

function parseClause(input: string): ParsedAction[] {
  const text = input.toLowerCase().trim()
  const actions: ParsedAction[] = []

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
  const m = text.match(maintRe)
  if (m) {
    const item = normalizeMaint(m[1])
    // De quantos em quantos km a peça é trocada. Sem isso o lembrete não tem
    // como calcular a próxima troca — e é o usuário quem sabe, então basta
    // ouvir quando ele diz: "troco a cada 10 mil km".
    const vidaM = text.match(new RegExp(String.raw`(?:a\s+)?cada\s+${NUM}\s*(?:mil\s*)?(?:km|quil[oô]metros?)`, 'i'))
    actions.push({
      kind: 'maintenance', item,
      cost: parseNum(m[2]),
      km: m[3] ? parseKmValue(m[3]) : undefined,
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
    String.raw`(?:guardei|guardar|guarda|separei|separar|separa|reservei|poupei|apliquei|investi|coloquei|botei|depositei|joguei|meti)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:(?:na|no|em|para|pra|pro)\s+(?:a\s+|o\s+)?(reserva|poupan[çc]a|investimento|investir|guardado|caixinha|cofrinho))?`,
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
  const depositRe = new RegExp(String.raw`(?:guardei|guarda|guardar|separei|separa|separar|deposita|depositei)\s*${APROX}(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*(?:para|pra|pro|na|no|da|do|em)?\s*(?:a\s+|o\s+)?(?:meta\s+)?(?:d[oa]\s+)?([\wçãõáéíóúâêô\s]+)?`, 'i')
  const dep = text.match(depositRe)
  if (dep) {
    // "guardei 150 E gastei 355" deixava o nome da meta como "e". Um nome que é
    // só palavra funcional não é meta nenhuma: o destino é a reserva.
    // O nome da meta não pode carregar palavra funcional nas pontas:
    // "guardei 100 na meta da viagem E gastei 90" virava a meta "viagem e".
    const rawName = (cleanDescription(dep[2] || '') || '').trim()
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
    actions.push({ kind: 'goal-update', name: (upd[1] || '').trim(), target })
    return actions
  }

  // ----- meta: "quero comprar um celular de 5000 em 6 meses"
  // O nome pode vir ANTES do valor ("um celular de 5000") ou DEPOIS ("5000 pra
  // uma moto"). Só o primeiro era capturado, e toda meta dita do segundo jeito
  // nascia chamada "Objetivo" — com duas ou três assim, a lista de metas fica
  // ilegível e o usuário não sabe qual é qual.
  const goalRe = new RegExp(String.raw`(?:quero|queria|vou|preciso)\s+(?:comprar|juntar|guardar)(?:\s+(?:uma|um|para|pra|o|a))?\s*([\wçãõáéíóú\s]*?)\s*(?:de|por|no valor de)?\s*(?:r\$)?\s*${NUM}(?:\s*(?:reais|mil|conto[s]?))?(?:\s*(?:pra|para|pro|p\/)\s+(?:uma?\s+|o\s+|a\s+|meu\s+|minha\s+)?([a-zà-úçãõ][\wçãõáéíóú]*(?:\s+[a-zà-úçãõ][\wçãõáéíóú]*){0,2}))?(?:\s*em\s*(\d+)\s*(mes(?:es)?|dias?|semanas?))?`, 'i')
  const g = text.match(goalRe)
  if (g && !m) {
    let target = parseNum(g[2])
    if (/(\d+(?:[.,]\d+)?)\s*mil/.test(text)) target = target < 100 ? target * 1000 : target
    let months: number | undefined
    if (g[4]) {
      const n = parseInt(g[4])
      months = /dia/.test(g[5]) ? n / 30 : /semana/.test(g[5]) ? n / 4.33 : n
    }
    const nome = cleanDescription(g[1]) || cleanDescription(g[3])
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
  const f = text.match(fuelRe) || text.match(fuelRe2) || (fuelRe3 && text.match(fuelRe3))
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
    const amount = f && !fSaoLitros ? parseNum(f[1]) : porValor ? parseNum(porValor[1]) : undefined
    actions.push({ kind: 'fuel', amount, liters: litersM ? parseNum(litersM[1]) : undefined })
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

  // ----- receitas, inclusive várias na mesma cláusula:
  // "ganhei 430 Uber, mais 399 da 99"
  if (!actions.length || !actions.some(a => a.kind === 'goal')) {
    const incRe = new RegExp(
      // "Caiu" é o verbo mais natural para salário e pagamento que chega na
      // conta — sem ele, "caiu 500 na conta hoje" não registrava nada.
      String.raw`(?:\b(?:ganhei|recebi|faturei|lucrei|entrou|caiu|cairam|pingou|fiz)\s*(?:mais\s+)?|\bmais\s+)(?:r\$)?\s*${NUM}\s*${MOEDA}?(?:\s+(?:(?:d[ao]|n[ao]|pel[ao]|via|em|numa?|uma)\s+){0,2}(uber|99|indriver|corrida(?:\s+privada)?))?`,
      'gi',
    )
    for (const inc of text.matchAll(incRe)) {
      const at = inc.index || 0
      const tail = text.slice(at)
      if (/^fiz\b/i.test(inc[0]) && new RegExp(String.raw`^fiz\s*(?:mais\s+)?${NUM}\s*(?:viagens|corridas|km)`, 'i').test(tail)) continue
      // "gastei MAIS 190 de cimento": o `mais` solto é ênfase de uma DESPESA já
      // em curso, não uma receita nova. Sem esta guarda a mesma frase gerava
      // uma despesa de 190 e uma receita fantasma de 190.
      if (/^mais\b/i.test(inc[0]) && /\b(?:gastei|paguei|comprei|torrei|coloquei|botei|abasteci)\b/i.test(text.slice(0, at))) continue
      const afterAmount = text.slice(at + inc[0].length)
      const nearbyPlatform = afterAmount.match(/^\s*(?:(?:d[ao]|n[ao]|pel[ao]|via|em|numa?|uma)\s+){0,2}(uber|99|indriver|corrida(?:\s+privada)?)/i)
      const platform = (inc[2] || nearbyPlatform?.[1] || '').trim().toLowerCase()
      const description = platform === 'uber' ? 'Uber'
        : platform === '99' ? '99'
          : platform === 'indriver' ? 'inDrive'
            : platform.includes('privada') ? 'Corrida privada'
              : undefined
      const context = platform || (VERBO_DE_PAGAR.test(text) ? janelaLocal(text, at, at + inc[0].trimEnd().length) : text)
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
      if (actions.some(a => a.kind === 'income' && a.amount === amount)) continue
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
        if (actions.some(a => (a as any).amount === amount)) continue
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
      const ni = text.match(nounIncomeRe)
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
      String.raw`(?:fiz\s+|mais\s+)?(?:uma\s+)?corrida(?:\s+(?:n[ao]|d[ao]|pel[ao]|via)\s*(uber|99|indriver))?\s+(?:de|por|no\s+valor\s+de)\s*(?:r\$)?\s*${NUM}`,
      'gi',
    )
    for (const ride of text.matchAll(rideIncomeRe)) {
      const amount = parseNum(ride[2])
      if (actions.some(a => a.kind === 'income' && a.amount === amount && a.category === 'corridas')) continue
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
  const expRe = new RegExp(String.raw`(?:${expVerbs})\s*${APROX}(?:r\$)?\s*${NUM}(?!\d|[.,]\d|\s*(?:dias|semanas|meses|anos)\b)\s*${MOEDA}?\s*(?:(?:de|com|no|na|em|para|pra)\s+)?([\wçãõáéíóúâê\s]*?)(?=\s*\d+(?:[.,]\d+)*\s*(?:${MOEDA})?\s*(?:de|com|no|na|em)\s+[a-zà-úçãõ]|[^\wçãõáéíóúâê\s]|$)`, 'i')
  const e = text.match(expRe)
  if (e && !m && !f) {
    const rawDesc = (e[2] || '').trim().split(/\s+e\s+|,/)[0].trim()
    const desc = cleanDescription(rawDesc)
    actions.push({ kind: 'expense', amount: parseNum(e[1]), category: guessCategory(rawDesc || text, 'expense'), description: desc })
  }

  // ----- valor ANTES do verbo de saída: "entrou 3200 do salario e 1100 SAIU de
  // aluguel". A ordem é a da fala; sem esta leitura a despesa sumia, e o
  // substantivo de renda da outra metade ainda tirava o "saiu" da lista acima.
  if (!m && !f) {
    const valorVerboRe = new RegExp(String.raw`(?:^|\se\s|,(?!\d)|;)\s*(?:r\$)?\s*${NUM}\s*${MOEDA}?\s+saiu\s+(?:de|do|da|com|no|na|em|pr[ao])\s+([a-zà-úçãõ][\wçãõáéíóúâê]*)`, 'gi')
    for (const vv of text.matchAll(valorVerboRe)) {
      const amount = parseNum(vv[1])
      if (!(amount > 0) || actions.some(a => (a as any).amount === amount)) continue
      actions.push({ kind: 'expense', amount, category: guessCategory(vv[2], 'expense'), description: cleanDescription(vv[2]) })
    }
  }

  // ----- despesa na ordem inversa: "comprei cimento por 190", "paguei a internet a 120"
  if (!e && !m && !f) {
    const invRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+${APROX}(?:um|uma|o|a|uns|umas)?\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[\wçãõáéíóúâê]+){0,2}?)\s+(?:por|a|custou|saiu por)\s*(?:r\$)?\s*${NUM}`, 'i')
    const inv = text.match(invRe)
    if (inv) {
      const desc = cleanDescription(inv[1])
      actions.push({ kind: 'expense', amount: parseNum(inv[2]), category: guessCategory(inv[1] || text, 'expense'), description: desc })
    } else {
      // Sem preposição nenhuma no meio: "paguei o aluguel 900". Exige que o
      // substantivo seja de uma categoria conhecida — é o que separa isto de
      // um número solto que ninguém sabe o que é.
      const nuRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+(?:mais\s+)?(?:o|a|os|as|um|uma|meu|minha)?\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[a-zà-úçãõ][\wçãõáéíóúâê]*)?)\s+(?:r\$)?\s*${NUM}\s*${MOEDA}?\s*$`, 'i')
      const nu = text.match(nuRe)
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
        if (!f) actions.push({ kind: 'fuel', amount })
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
          if (!f) actions.push({ kind: 'fuel', amount })
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
  const kmM = kmConsumo ? null : text.match(new RegExp(String.raw`\b(?:rodei|andei|dirigi|percorri|consegui\s+rodar)\s*${NUM}\s*(?:km|quil[oô]metros?)?`, 'i'))
  const tripsM = text.match(new RegExp(String.raw`(?:fiz|realizei|completei)?\s*${NUM}\s*(?:viagens|corridas)`, 'i'))
  const hoursM = text.match(new RegExp(String.raw`\b(?:trabalhei|fiquei|rodei por)\s*${NUM}\s*(?:horas?|h)\b`, 'i'))
    || text.match(new RegExp(String.raw`${NUM}\s*horas?\s*(?:online|trabalhad)`, 'i'))
    // Jornada como o motorista fala: "8 horas na rua", "10 horas rodando".
    || text.match(new RegExp(String.raw`${NUM}\s*(?:horas?|hrs?)\s+(?:na\s+rua|de\s+rua|rodando|na\s+ativa|no\s+corre|na\s+labuta|no\s+trampo|trabalhando|de\s+trabalho)`, 'i'))
    // "rodei 200 km EM 10 HORAS" — a jornada vinha junto da distância e se
    // perdia inteira, porque nenhum dos padrões acima cobre "em N horas".
    || text.match(new RegExp(String.raw`(?:km|quil[oô]metros?|viagens|corridas)\s*(?:em|durante)\s*${NUM}\s*(?:horas?|hrs?|h)\b`, 'i'))

  const kmIsMaint = m && m[3] // km da manutenção
  if ((kmM && !kmIsMaint && !kmSubM) || (tripsM && !tripsSubM) || (hoursM && !hoursSubM)) {
    actions.push({
      kind: 'work',
      km: kmM && !kmIsMaint && !kmSubM ? parseNum(kmM[1]) : undefined,
      trips: tripsM && !tripsSubM ? parseNum(tripsM[1]) : undefined,
      hours: hoursM && !hoursSubM ? parseNum(hoursM[1]) : undefined,
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

  const out: ParsedAction[] = []
  // `,(?!\d)` preserva a vírgula decimal: "1.234,56" é um valor, não dois itens.
  for (const trecho of text.split(/\s+e\s+|,(?!\d)|;/)) {
    const t = trecho.trim()
    if (!t) continue
    const vm = t.match(new RegExp(String.raw`(?:r\$)?\s*${NUM}\s*${MOEDA}?`, 'i'))
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
      lines.push(a.amount ? `Valor: ${money(a.amount)} (pagamento parcial se for menor que a fatura)` : 'Valor: todo o pendente da fatura')
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

export function describeAction(a: ParsedAction): string {
  switch (a.kind) {
    case 'income': return `Receita de ${fmtBRL(a.amount)}${a.category ? ` (${a.category})` : ''}${a.is99 ? ' — plataforma 99' : ''}`
    case 'expense': return `Despesa de ${fmtBRL(a.amount)}${a.category ? ` (${a.category})` : ''}${a.description ? ` — ${a.description}` : ''}`
    // Sem este caso o `switch` caía fora e a linha da proposta virava "undefined".
    case 'saving': return `Guardar ${fmtBRL(a.amount)} na reserva${a.description ? ` — ${a.description}` : ''}`
    case 'work': {
      // A proposta escrevia "1 viagens". É o texto que o usuário lê para
      // conferir antes de gravar — concordância errada ali passa desleixo.
      const viagem = (n: number) => `${n} ${n === 1 ? 'viagem' : 'viagens'}`
      const parts = []
      if (a.km) parts.push(a.km > 0 ? `${a.km} km` : `${Math.abs(a.km)} km removidos`)
      if (a.trips) {
        parts.push(a.trips > 0
          ? viagem(a.trips)
          : `${viagem(Math.abs(a.trips))} ${Math.abs(a.trips) === 1 ? 'removida' : 'removidas'}`)
      }
      if (a.hours) parts.push(a.hours > 0 ? `${a.hours}h trabalhadas` : `${Math.abs(a.hours)}h removidas`)
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
      return `Compra${a.description ? ` de ${a.description}` : ''} de ${fmtBRL(a.total)} em ${a.installments}x${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'financed-cash-inflow':
      return `Entrada financiada: recebeu ${fmtBRL(a.netReceived)} e deve ${fmtBRL(a.total)} em ${a.installments}x`
    case 'card-payment':
      return `Pagar fatura${a.cardName ? ` do ${a.cardName}` : ''}${a.amount ? ` — ${fmtBRL(a.amount)}` : ' (valor pendente)'}`
    case 'card-charge':
      return `Assinatura${a.description ? ` ${a.description}` : ''} de ${fmtBRL(a.amount)}/mês${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'reset': return 'Apagar TODOS os dados do app'
    case 'undo-batch': return 'Desfazer o último registro do assistente'
    case 'edit-transaction': return 'Corrigir um lançamento já salvo'
  }
}
