// Registro por linguagem natural (seções 9 e 10).
// Parser local em pt-BR — funciona offline. Preparado para ser substituído/complementado
// por um serviço de IA no backend (ver services/ai.ts).
import { ParsedAction } from '../models/types'
import { guessCategory } from '../data/categories'
import { MENTIONS_99 } from './profile'

const NUM = String.raw`(\d+(?:[.,]\d+)?)`
const parseNum = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')) || parseFloat(s.replace(',', '.'))

const MAINT_ITEMS = ['óleo', 'oleo', 'pneu', 'pneus', 'pastilha', 'pastilhas', 'freio', 'freios', 'correia', 'filtro', 'filtros', 'vela', 'velas', 'amortecedor', 'amortecedores', 'bateria', 'embreagem']
const MAINT_LIFE: Record<string, number> = { 'óleo': 10000, pneu: 40000, pastilha: 30000, freio: 30000, correia: 60000, filtro: 10000, vela: 30000, amortecedor: 60000, bateria: 50000, embreagem: 80000 }

function normalizeMaint(item: string): string {
  const i = item.toLowerCase().replace(/s$/, '')
  if (i === 'oleo') return 'óleo'
  return i
}

/** Extrai um valor "X mil" ou número com sufixo km */
function parseKmValue(raw: string): number {
  let v = parseNum(raw)
  if (/mil/.test(raw)) v = parseNum(raw) * 1000
  return v
}

// Verbos que iniciam um novo comando — usados para quebrar frases compostas
// como "rodei no uber e ganhei 300 reais coloquei 70 de gasolina".
const COMMAND_VERBS = ['ganhei', 'recebi', 'faturei', 'lucrei', 'gastei', 'paguei', 'comprei', 'parcelei', 'passei', 'troquei', 'instalei', 'abasteci', 'coloquei', 'botei', 'rodei', 'andei', 'dirigi', 'percorri', 'trabalhei', 'quero', 'fiz', 'guardei', 'guarda', 'guardar', 'separei', 'separa', 'muda', 'mudar', 'altera', 'alterar', 'aumenta', 'aumentar', 'diminui', 'diminuir', 'retira', 'retirei', 'tira', 'tirei', 'remove', 'removi', 'desconta', 'descontei', 'reduz', 'reduzi', 'corrige', 'corrigi']

// Verbos que indicam correção/subtração de um registro de trabalho já lançado
// ("retira 100km rodados", "diminui 80 km dos rodados hoje", "tira 2 viagens")
const WORK_SUB_VERBS = String.raw`retira|retirei|tira|tirei|remove|removi|desconta|descontei|diminui|diminuir|reduz(?:e|i)?|corrige|corrigi`

function splitClauses(input: string): string[] {
  const marked = input
    .toLowerCase()
    .replace(new RegExp(String.raw`[\s,;]+(?:e\s+)?(?=(?:${COMMAND_VERBS.join('|')})\b)`, 'g'), '\n')
  return marked.split(/\n|;|\.\s/).map(s => s.trim()).filter(Boolean)
}

export function parseNatural(input: string): ParsedAction[] {
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

/**
 * Compra parcelada, entrada financiada, fatura e assinatura.
 * Regra: nada é inventado. Se faltar valor ou nº de parcelas, não gera ação —
 * o assistente pergunta o que falta em vez de chutar.
 */
function parseCardClause(text: string): ParsedAction[] {
  // "passei 2000 em 5 vezes e recebi 1850 líquidos" — entrada financiada (seção 7)
  const financed = text.match(new RegExp(
    String.raw`(?:passei|passou|fiz)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:no cart[ãa]o\s*)?(?:em|x|vezes?)?\s*(\d+)?\s*(?:vezes|x|parcelas?)?[^\d]*(?:e\s*)?(?:recebi|receber|peguei|caiu)\s*(?:r\$)?\s*${NUM}`, 'i'))
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

  // "tenho uma assinatura de 39,90 no cartão"
  const sub = text.match(new RegExp(String.raw`assinatura\s*(?:d[eo]\s*)?([\wçãõáéíóúâê\s]+?)?\s*(?:de|por|custa)?\s*(?:r\$)?\s*${NUM}`, 'i'))
  if (sub && /assinatura/.test(text)) {
    const amount = parseNum(sub[2])
    if (amount > 0) {
      const label = (sub[1] || '').trim().replace(/\b(no|do|da|de)\b.*$/, '').trim()
      return [{ kind: 'card-charge', description: label || undefined, amount, cardName: matchCardName(text) }]
    }
  }

  // "comprei um computador de 4000 em 4 vezes no nubank"
  if (/(comprei|compra|parcelei|parcelado|parcelada)/.test(text)) {
    const instM = text.match(/(?:em|x)\s*(\d+)\s*(?:vezes|x|parcelas?)|(\d+)\s*x\b/i)
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
  const m = text.match(/\b(?:no|na|pelo|pela|cart[ãa]o(?:\s+d[oa])?)\s+([a-zà-ú][\wçãõáéíóúâê]*(?:\s+[a-zà-ú][\wçãõáéíóúâê]*)?)/i)
  if (!m) return undefined
  const raw = m[1].trim()
  // palavras genéricas não são nome de cartão
  if (/^(cart[ãa]o|cr[ée]dito|d[ée]bito|fatura|vezes|parcelas?|meses?|banco)$/i.test(raw)) return undefined
  return raw
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
      lifeKm: MAINT_LIFE[item] || 10000,
    })
  }

  // ----- guardar dinheiro numa meta: "guardei 100 para o iphone", "guarda 50 na meta da viagem"
  const depositRe = new RegExp(String.raw`(?:guardei|guarda|guardar|separei|separa|separar|deposita|depositei)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:para|pra|pro|na|no|da|do|em)?\s*(?:a\s+|o\s+)?(?:meta\s+)?(?:d[oa]\s+)?([\wçãõáéíóúâêô\s]+)?`, 'i')
  const dep = text.match(depositRe)
  if (dep) {
    actions.push({ kind: 'goal-deposit', amount: parseNum(dep[1]), name: (dep[2] || '').trim() })
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
  const fuelRe = new RegExp(String.raw`abasteci(?:mento)?\s*(?:com|de)?\s*(?:r\$)?\s*${NUM}`, 'i')
  const fuelRe2 = new RegExp(String.raw`(?:coloquei|botei|gastei|paguei)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:de|em|no|na)?\s*(?:gasolina|etanol|[áa]lcool|diesel|gnv|combust[íi]vel)`, 'i')
  const f = text.match(fuelRe) || text.match(fuelRe2)
  const litersM = text.match(new RegExp(String.raw`${NUM}\s*litros?`, 'i'))
  if (f || (litersM && /(coloquei|botei|abasteci|posto)/.test(text))) {
    const amount = f ? parseNum(f[1]) : undefined
    actions.push({ kind: 'fuel', amount, liters: litersM ? parseNum(litersM[1]) : undefined })
  }

  // ----- receita: "ganhei 250", "fiz 320 reais", "recebi 100"
  if (!actions.length || !actions.some(a => a.kind === 'goal')) {
    const incRe = new RegExp(String.raw`(?:ganhei|recebi|faturei|lucrei|entrou|fiz)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?|pila)?`, 'i')
    const inc = text.match(incRe)
    // evita conflito com "fiz 14 viagens"
    if (inc && !new RegExp(String.raw`fiz\s*${NUM}\s*(viagens|corridas|km)`).test(text.replace(inc[0], m2 => m2))) {
      const isTrips = /fiz\s*\d+\s*(viagens|corridas)/.test(inc[0])
      // Só marca saque quando a plataforma 99 é citada EXPLICITAMENTE
      // ("caiu da 99", "saque da 99"). "recebi 99 reais" NÃO conta.
      const is99 = MENTIONS_99.test(text)
      if (!isTrips) actions.push({ kind: 'income', amount: parseNum(inc[1]), category: guessCategory(text, 'income'), description: undefined, is99: is99 || undefined })
    }
  }

  // ----- despesa: "gastei 40 de gasolina", "paguei 120 de internet"
  const expRe = new RegExp(String.raw`(?:gastei|paguei|comprei|saiu|foi)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:de|com|no|na|em)?\s*([\wçãõáéíóú\s]*)`, 'i')
  const e = text.match(expRe)
  if (e && !m && !f) {
    const desc = (e[2] || '').trim().split(/\s+e\s+|,/)[0].trim()
    actions.push({ kind: 'expense', amount: parseNum(e[1]), category: guessCategory(desc || text, 'expense'), description: desc || undefined })
  }

  // itens enumerados após o verbo: "gastei 20 de pedágio e 40 de gasolina, 15 de lanche"
  if (/(gastei|paguei|comprei|coloquei|botei)/.test(text) && !m) {
    const enumRe = new RegExp(String.raw`(?:\se\s|,)\s*(?:r\$)?\s*${NUM}\s*(?:reais|conto[s]?)?\s*(?:de|com|no|na|em)\s+([a-zà-úçãõ]+(?:\s+[a-zà-úçãõ]+)?)`, 'gi')
    for (const mm of text.matchAll(enumRe)) {
      const desc = mm[2].trim()
      const amount = parseNum(mm[1])
      const isFuel = /gasolina|etanol|alcool|álcool|diesel|combust/.test(desc)
      if (isFuel) {
        if (!f) actions.push({ kind: 'fuel', amount })
      } else {
        actions.push({ kind: 'expense', amount, category: guessCategory(desc, 'expense'), description: desc })
      }
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
  const kmM = text.match(new RegExp(String.raw`(?:rodei|andei|dirigi|percorri)\s*${NUM}\s*(?:km|quil[oô]metros?)?`, 'i'))
    || (kmConsumo ? null : text.match(new RegExp(String.raw`${NUM}\s*(?:km|quil[oô]metros?)\b(?!\s*(?:\/?\s*l\b|\/?\s*litro|por\s*litro))`, 'i')))
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
      if (c) lines.push(`Categoria: ${c}`)
      if ((a as any).origin) lines.push(`Origem: ${(a as any).origin}`)
      if (a.description) lines.push(`Descrição: ${a.description}`)
      lines.push('Data: hoje')
      if (a.kind === 'income') {
        lines.push(a.is99 && opts?.fee ? `Taxa de saque 99: −${money(opts.fee)}` : 'Nenhuma taxa será aplicada.')
      }
      break
    }
    case 'saving':
      lines.push(`Guardar ${money(a.amount)} na reserva`)
      if (a.description) lines.push(`Onde: ${a.description}`)
      lines.push('Data: hoje')
      lines.push('Não conta como despesa.')
      break
    case 'card-purchase': {
      const per = a.total / Math.max(a.installments, 1)
      lines.push(`Compra parcelada${a.description ? `: ${a.description}` : ''}`)
      lines.push(`Valor total: ${money(a.total)}`)
      lines.push(`Parcelas: ${a.installments}x de ${money(per)}`)
      lines.push(`Cartão: ${a.cardName || 'não informado (registra sem cartão)'}`)
      lines.push(`1º vencimento: ${a.firstDueDate ? a.firstDueDate.split('-').reverse().join('/') : 'próxima fatura'}`)
      const c = catName(a.category)
      if (c) lines.push(`Categoria: ${c}`)
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
      lines.push(`Assinatura${a.description ? `: ${a.description}` : ''}`)
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
    case 'income': return `Receita de R$ ${a.amount.toFixed(2).replace('.', ',')}${a.category ? ` (${a.category})` : ''}${a.is99 ? ' — saque 99 (−R$ 1,00)' : ''}`
    case 'expense': return `Despesa de R$ ${a.amount.toFixed(2).replace('.', ',')}${a.category ? ` (${a.category})` : ''}${a.description ? ` — ${a.description}` : ''}`
    case 'work': {
      const parts = []
      if (a.km) parts.push(a.km > 0 ? `${a.km} km` : `${Math.abs(a.km)} km removidos`)
      if (a.trips) parts.push(a.trips > 0 ? `${a.trips} viagens` : `${Math.abs(a.trips)} viagens removidas`)
      if (a.hours) parts.push(a.hours > 0 ? `${a.hours}h trabalhadas` : `${Math.abs(a.hours)}h removidas`)
      return `Trabalho: ${parts.join(', ')}`
    }
    case 'fuel': return `Abastecimento${a.amount ? ` de R$ ${a.amount.toFixed(2).replace('.', ',')}` : ''}${a.liters ? ` (${a.liters} L)` : ''}`
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
