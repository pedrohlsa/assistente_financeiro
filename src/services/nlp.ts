// Registro por linguagem natural (seções 9 e 10).
// Parser local em pt-BR — funciona offline. Preparado para ser substituído/complementado
// por um serviço de IA no backend (ver services/ai.ts).
import { ParsedAction } from '../models/types'
import { guessCategory } from '../data/categories'
import { parseMoney } from '../utils/format'
import { sentenceCase } from '../utils/text'

// Captura valores com QUALQUER combinação de separadores ("100.000,00",
// "10,000,00", "1.234,56", "5000"). A interpretação é sempre delegada ao
// parser monetário central — este módulo não converte número por conta própria.
const NUM = String.raw`(\d+(?:[.,]\d+)*)`
const parseNum = (s: string) => parseMoney(s)

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
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'reais', 'conto', 'contos',
  // Conjunção residual: a quebra em cláusulas deixa "gastei 100 e" e sem isto
  // a descrição do lançamento virava a letra "E".
  'e',
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
  return out ? sentenceCase(out) : undefined
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

/**
 * Parse completo: além das ações, devolve a pergunta de desambiguação quando o
 * texto não permite decidir com segurança.
 */
export function parseNaturalFull(input: string, opts?: { driver?: boolean }): ParseResult {
  let actions = parseNatural(input)

  // No perfil motorista, uma receita sem origem explícita continua sendo de
  // corridas. Se a frase menciona corrida/Uber/99, o contexto vale também para
  // cláusulas curtas como "ganhei 150" logo após "fiz uma corrida".
  if (opts?.driver) {
    const rideContext = /\bcorridas?\b|\buber\b|\bindriver\b|\b99\b/i.test(input)
    actions = actions.map(a => a.kind === 'income' && (!a.category || rideContext)
      ? { ...a, category: a.category || 'corridas' }
      : a)

    // Um registro de receita de corrida representa uma viagem quando o usuário
    // não informou uma quantidade explícita. "Fiz 14 viagens" continua valendo 14.
    const hasExplicitTrips = actions.some(a => a.kind === 'work' && a.trips !== undefined)
    const rideEntries = actions.filter(a => a.kind === 'income' && a.category === 'corridas').length
    if (!hasExplicitTrips && rideEntries > 0) {
      const work = actions.find(a => a.kind === 'work') as Extract<ParsedAction, { kind: 'work' }> | undefined
      if (work) work.trips = rideEntries
      else actions.push({ kind: 'work', trips: rideEntries })
    }
  }

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
 * Compra parcelada, entrada financiada, fatura e assinatura.
 * Regra: nada é inventado. Se faltar valor ou nº de parcelas, não gera ação —
 * o assistente pergunta o que falta em vez de chutar.
 */
function parseCardClause(text: string): ParsedAction[] {
  // "passei 2000 em 5 vezes e recebi 1850 líquidos" — entrada financiada (seção 7)
  const financed = text.match(new RegExp(
    String.raw`(?:passei|passou|fiz)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:no cart[ãa]o\s*)?(?:em|x|vez(?:es)?)?\s*(\d+)?\s*(?:vez(?:es)?|x|parcelas?)?[^\d]*(?:e\s*)?(?:recebi|receber|peguei|caiu)\s*(?:r\$)?\s*${NUM}`, 'i'))
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
  if (/(comprei|compra|parcelei|parcelado|parcelada)/.test(text)) {
    const instM = text.match(/(?:em|x)\s*(\d+)\s*(?:vez(?:es)?|x|parcelas?)|(\d+)\s*x\b/i)
    const valM = text.match(new RegExp(String.raw`(?:de|por|custou|valor de)\s*(?:r\$)?\s*${NUM}(?:\s*(mil))?`, 'i'))
      || text.match(new RegExp(String.raw`(?:r\$)\s*${NUM}(?:\s*(mil))?`, 'i'))
    // Sem valor OU sem parcelas não registra nada: quem pergunta é o assistente.
    if (!valM || !instM) return []
    let total = parseNum(valM[1])
    if (valM[2]) total *= 1000
    const installments = parseInt(instM[1] || instM[2], 10)
    if (!(total > 0) || !(installments > 0)) return []
    // terminadores precisam ser palavras inteiras, senão "geladeira" vira "gela" + "de"
    const descM = text.match(/comprei\s+(?:um|uma|o|a|uns|umas)\s+([\wçãõáéíóúâê]+(?:\s+[\wçãõáéíóúâê]+)*?)(?=\s+(?:de|por|em|no|na)\b|\s*r\$|\s*\d)/i)
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
  if (/\b(reset(?:a|ar|e)?|apag(?:a|ar)|zer(?:a|ar))\s+(tudo|todos|geral|os dados|meus dados)\b/.test(text) || /\bresetar tudo\b/.test(text)) {
    return [{ kind: 'reset' }]
  }

  // ----- saldo em conta: "meu saldo é 1500", "tenho 1500 no banco/na conta", "saldo 1500"
  const balanceRe = new RegExp(String.raw`(?:meu\s+)?saldo\s*(?:atual|em conta|no banco|de|é|e|:)?\s*(?:r\$)?\s*${NUM}|(?:tenho|tem)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:no banco|na conta|em conta|de saldo|guardado)`, 'i')
  const bal = text.match(balanceRe)
  if (bal) {
    const raw = bal[1] ?? bal[2]
    if (raw) return [{ kind: 'balance', amount: parseNum(raw) }]
  }

  // ----- manutenção: "troquei o óleo por 280 com 84 mil km"
  const maintRe = new RegExp(String.raw`(?:troquei|trocar|coloquei|instalei)\s+(?:o|a|os|as)?\s*(${MAINT_ITEMS.join('|')})[^\d]*(?:por|de)?\s*(?:r\$)?\s*${NUM}(?:\s*(?:reais|conto[s]?))?(?:.*?com\s+(\d+(?:[.,]\d+)?\s*(?:mil)?)\s*km)?`, 'i')
  const m = text.match(maintRe)
  if (m) {
    const item = normalizeMaint(m[1])
    actions.push({
      kind: 'maintenance', item,
      cost: parseNum(m[2]),
      km: m[3] ? parseKmValue(m[3]) : undefined,
      lifeKm: undefined,
    })
  }

  // ----- guardar na RESERVA (não é meta): "guardei 150", "coloquei 300 na reserva",
  // "separei 500 para investir". Vira `type:'saving'` — nem receita nem despesa.
  const savingRe = new RegExp(
    String.raw`(?:guardei|guardar|guarda|separei|separar|separa|reservei|poupei|apliquei|investi|coloquei|botei|depositei)\s*(?:mais\s+)?(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:(?:na|no|em|para|pra|pro)\s+(?:a\s+|o\s+)?(reserva|poupan[çc]a|investimento|investir|guardado|caixinha|cofrinho))?`,
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
  const depositRe = new RegExp(String.raw`(?:guardei|guarda|guardar|separei|separa|separar|deposita|depositei)\s*(?:mais\s+)?(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:para|pra|pro|na|no|da|do|em)?\s*(?:a\s+|o\s+)?(?:meta\s+)?(?:d[oa]\s+)?([\wçãõáéíóúâêô\s]+)?`, 'i')
  const dep = text.match(depositRe)
  if (dep) {
    const name = (dep[2] || '').trim()
    if (!name) {
      actions.push({ kind: 'saving', amount: parseNum(dep[1]) })
    } else {
      actions.push({ kind: 'goal-deposit', amount: parseNum(dep[1]), name })
    }
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
  const goalRe = new RegExp(String.raw`(?:quero|queria|vou|preciso)\s+(?:comprar|juntar|guardar)(?:\s+(?:uma|um|para|pra|o|a))?\s*([\wçãõáéíóú\s]*?)\s*(?:de|por|no valor de)?\s*(?:r\$)?\s*${NUM}(?:\s*(?:reais|mil|conto[s]?))?(?:\s*em\s*(\d+)\s*(mes(?:es)?|dias?|semanas?))?`, 'i')
  const g = text.match(goalRe)
  if (g && !m) {
    let target = parseNum(g[2])
    if (/(\d+(?:[.,]\d+)?)\s*mil/.test(text)) target = target < 100 ? target * 1000 : target
    let months: number | undefined
    if (g[3]) {
      const n = parseInt(g[3])
      months = /dia/.test(g[4]) ? n / 30 : /semana/.test(g[4]) ? n / 4.33 : n
    }
    actions.push({ kind: 'goal', name: (g[1] || 'Objetivo').trim() || 'Objetivo', target, months })
  }

  // ----- abastecimento: "abasteci 70", "coloquei 70 reais de gasolina", "coloquei 30 litros"
  const fuelRe = new RegExp(String.raw`abastec(?:i|er|endo)(?:mento)?\s*(?:com|de)?\s*(?:r\$)?\s*${NUM}`, 'i')
  const fuelRe2 = new RegExp(String.raw`(?:coloquei|botei|gastei|paguei)\s*(?:mais\s+)?(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:de|em|no|na)?\s*(?:gasolina|etanol|[áa]lcool|diesel|gnv|combust[íi]vel)`, 'i')
  const f = text.match(fuelRe) || text.match(fuelRe2)
  const litersM = text.match(new RegExp(String.raw`${NUM}\s*litros?`, 'i'))
  if (f || (litersM && /(coloquei|botei|abasteci|posto)/.test(text))) {
    const amount = f ? parseNum(f[1]) : undefined
    actions.push({ kind: 'fuel', amount, liters: litersM ? parseNum(litersM[1]) : undefined })
  }

  // Hodômetro é dado do veículo, NUNCA distância trabalhada.
  const odoM = text.match(new RegExp(
    String.raw`(?:hod[oô]metro(?:\s+atual)?|km\s+atual|(?:estou|t[oô])\s+(?:atualmente\s+)?com)\s*(?:em|de|:|est[aá]\s+em)?\s*${NUM}\s*(?:mil\s*)?(?:km|quil[oô]metros?)(?:\s+rodados?)?`,
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
      String.raw`(?:\b(?:ganhei|recebi|faturei|lucrei|entrou|fiz)\s*(?:mais\s+)?|\bmais\s+)(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?|pila)?(?:\s+(?:(?:d[ao]|n[ao]|pel[ao]|via|em|numa?|uma)\s+){0,2}(uber|99|indriver|corrida(?:\s+privada)?))?`,
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
      const context = platform || text
      actions.push({
        kind: 'income',
        amount: parseNum(inc[1]),
        category: platform ? 'corridas' : guessCategory(context, 'income'),
        description,
      })
    }

    // Fonte de renda como sujeito: "meu salário foi 1625", "o aluguel foi 1800".
    // Sem isso o "foi" caía no regex de despesa e o salário virava gasto.
    if (!actions.some(a => a.kind === 'income')) {
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
  const expVerbs = INCOME_NOUN.test(text) ? 'gastei|paguei|comprei|torrei' : 'gastei|paguei|comprei|torrei|saiu|foi'
  const expRe = new RegExp(String.raw`(?:${expVerbs})\s*(?:mais\s+)?(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:(?:de|com|no|na|em|para|pra)\s+)?([\wçãõáéíóúâê\s]*)`, 'i')
  const e = text.match(expRe)
  if (e && !m && !f) {
    const rawDesc = (e[2] || '').trim().split(/\s+e\s+|,/)[0].trim()
    const desc = cleanDescription(rawDesc)
    actions.push({ kind: 'expense', amount: parseNum(e[1]), category: guessCategory(rawDesc || text, 'expense'), description: desc })
  }

  // ----- despesa na ordem inversa: "comprei cimento por 190", "paguei a internet a 120"
  if (!e && !m && !f) {
    const invRe = new RegExp(String.raw`(?:gastei|paguei|comprei|torrei)\s+(?:mais\s+)?(?:um|uma|o|a|uns|umas)?\s*([a-zà-úçãõ][\wçãõáéíóúâê]*(?:\s+[\wçãõáéíóúâê]+){0,2}?)\s+(?:por|a|custou|saiu por)\s*(?:r\$)?\s*${NUM}`, 'i')
    const inv = text.match(invRe)
    if (inv) {
      const desc = cleanDescription(inv[1])
      actions.push({ kind: 'expense', amount: parseNum(inv[2]), category: guessCategory(inv[1] || text, 'expense'), description: desc })
    }
  }

  // itens enumerados após o verbo, nas duas ordens:
  // "gastei 20 de pedágio e 40 de gasolina, 15 de lanche"
  // "comprei cimento por 190 e depois areia por 150"
  if (/(gastei|paguei|comprei|torrei|coloquei|botei)/.test(text) && !m) {
    // `,(?!\d)` é essencial: sem isso a vírgula decimal de "1.234,56" era lida
    // como separador de itens e inventava uma segunda despesa de R$ 56.
    const sep = String.raw`(?:\se\s|,(?!\d)|;|\s(?:${CONNECTOR}))`
    const enumRe = new RegExp(String.raw`${sep}\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:de|com|no|na|em)\s+([a-zà-úçãõ]+(?:\s+[a-zà-úçãõ]+)?)`, 'gi')
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
  const kmM = kmConsumo ? null : text.match(new RegExp(String.raw`(?:rodei|andei|dirigi|percorri|consegui\s+rodar)\s*${NUM}\s*(?:km|quil[oô]metros?)?`, 'i'))
  const tripsM = text.match(new RegExp(String.raw`(?:fiz|realizei|completei)?\s*${NUM}\s*(?:viagens|corridas)`, 'i'))
  const hoursM = text.match(new RegExp(String.raw`(?:trabalhei|fiquei|rodei por)\s*${NUM}\s*(?:horas?|h)\b`, 'i'))
    || text.match(new RegExp(String.raw`${NUM}\s*horas?\s*(?:online|trabalhad)`, 'i'))

  const kmIsMaint = m && m[3] // km da manutenção
  if ((kmM && !kmIsMaint && !kmSubM) || (tripsM && !tripsSubM) || (hoursM && !hoursSubM)) {
    actions.push({
      kind: 'work',
      km: kmM && !kmIsMaint && !kmSubM ? parseNum(kmM[1]) : undefined,
      trips: tripsM && !tripsSubM ? parseNum(tripsM[1]) : undefined,
      hours: hoursM && !hoursSubM ? parseNum(hoursM[1]) : undefined,
    })
  }

  // dedupe: receita detectada dentro de frase de meta
  return actions
}

/**
 * Resumo detalhado mostrado antes de registrar (14.7): tipo, valor, categoria,
 * origem, data e taxa. O usuário sempre vê exatamente o que será gravado.
 */
export function describeActionDetailed(a: ParsedAction, opts?: { fee?: number; categoryName?: (id: string) => string }): string[] {
  const money = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`
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
    case 'income': return `Receita de R$ ${a.amount.toFixed(2).replace('.', ',')}${a.category ? ` (${a.category})` : ''}${a.is99 ? ' — plataforma 99' : ''}`
    case 'expense': return `Despesa de R$ ${a.amount.toFixed(2).replace('.', ',')}${a.category ? ` (${a.category})` : ''}${a.description ? ` — ${a.description}` : ''}`
    // Sem este caso o `switch` caía fora e a linha da proposta virava "undefined".
    case 'saving': return `Guardar R$ ${a.amount.toFixed(2).replace('.', ',')} na reserva${a.description ? ` — ${a.description}` : ''}`
    case 'work': {
      const parts = []
      if (a.km) parts.push(a.km > 0 ? `${a.km} km` : `${Math.abs(a.km)} km removidos`)
      if (a.trips) parts.push(a.trips > 0 ? `${a.trips} viagens` : `${Math.abs(a.trips)} viagens removidas`)
      if (a.hours) parts.push(a.hours > 0 ? `${a.hours}h trabalhadas` : `${Math.abs(a.hours)}h removidas`)
      return `Trabalho: ${parts.join(', ')}`
    }
    case 'fuel': return `Abastecimento${a.amount ? ` de R$ ${a.amount.toFixed(2).replace('.', ',')}` : ''}${a.liters ? ` (${a.liters} L)` : ''}${a.odometer ? ` · hodômetro ${a.odometer.toLocaleString('pt-BR')} km` : ''}`
    case 'odometer': return `Hodômetro atual: ${a.value.toLocaleString('pt-BR')} km`
    case 'maintenance': return `Manutenção: ${a.item} — R$ ${a.cost.toFixed(2).replace('.', ',')}${a.km ? ` aos ${a.km.toLocaleString('pt-BR')} km` : ''}`
    case 'goal': return `Meta: ${a.name} — R$ ${a.target.toLocaleString('pt-BR')}${a.months ? ` em ${Math.round(a.months)} meses` : ''}`
    case 'goal-update': return `Alterar meta${a.name ? ` "${a.name}"` : ''}${a.target ? ` para R$ ${a.target.toLocaleString('pt-BR')}` : ''}`
    case 'goal-deposit': return `Guardar R$ ${a.amount.toFixed(2).replace('.', ',')}${a.name ? ` na meta "${a.name}"` : ' na meta'}`
    case 'balance': return `Saldo em conta: R$ ${a.amount.toFixed(2).replace('.', ',')}`
    case 'card-purchase':
      return `Compra${a.description ? ` de ${a.description}` : ''} de R$ ${a.total.toFixed(2).replace('.', ',')} em ${a.installments}x${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'financed-cash-inflow':
      return `Entrada financiada: recebeu R$ ${a.netReceived.toFixed(2).replace('.', ',')} e deve R$ ${a.total.toFixed(2).replace('.', ',')} em ${a.installments}x`
    case 'card-payment':
      return `Pagar fatura${a.cardName ? ` do ${a.cardName}` : ''}${a.amount ? ` — R$ ${a.amount.toFixed(2).replace('.', ',')}` : ' (valor pendente)'}`
    case 'card-charge':
      return `Assinatura${a.description ? ` ${a.description}` : ''} de R$ ${a.amount.toFixed(2).replace('.', ',')}/mês${a.cardName ? ` no ${a.cardName}` : ''}`
    case 'reset': return 'Apagar TODOS os dados do app'
  }
}
