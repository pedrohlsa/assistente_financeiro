// O QUE É TÍPICO DESTE MOTORISTA — nunca "o que é típico de um motorista".
//
// O foco do produto é quem roda o dia inteiro, e as perguntas que ele faz não
// são sobre o mês: são sobre o RITMO dele. Quanto costumo fazer por dia, quais
// dias rendem mais, de onde vem mais dinheiro, quanto o combustível come do que
// eu faturo, esta semana está melhor ou pior que o meu normal.
//
// Três regras que valem para toda resposta daqui:
//
// 1. SEM AMOSTRA, O APP CALA. "Você faz R$ 0,00 por dia" com zero dias
//    registrados é uma mentira com número certo. Sem base, a resposta é dizer o
//    que registrar para a conta passar a existir.
// 2. A AMOSTRA VAI JUNTO. Quantos dias, qual período, e se o número é
//    realizado ou estimado. Uma média de 8 dias e uma de 2 dias não valem a
//    mesma coisa, e quem decide se confia é o motorista.
// 3. NADA DE TAXA POR HÁBITO. A taxa da 99 continua sendo pergunta separada
//    (regra 1) — este módulo lê o histórico, não desconta nada de ninguém.
//
// Só é chamado quando `isDriver(settings)`: as métricas aqui não existem para
// os outros perfis (regra 3).

import type { AppState, Transaction, WorkSession } from '../models/types'
import { fuelSpend } from '../services/calc'
import { isDriver } from '../services/profile'
import { addDays, fmtBRL, fmtNum, fromISO, todayISO } from '../utils/format'
import { brDate } from './dates'
import { normalizeName, weekdayName } from '../utils/text'
import { currentMonthToDate, parsePeriod } from './query/period'
import { runQuery } from './query/engine'
import { QUERY_DSL_VERSION } from './query/types'

/** Janela padrão do "meu normal": um mês corrido de trabalho. */
const JANELA_DIAS = 30
/** Mínimo de dias distintos para uma média significar alguma coisa. */
const MIN_DIAS = 3
/** Quantas vezes um dia da SEMANA precisa se repetir para entrar no ranking. */
const MIN_REPETICOES_DIA = 2

const norm = (s: string) => s.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '')

interface Dia {
  date: string
  income: number
  expense: number
  km: number
  hours: number
  trips: number
}

/** Os dias em que ele realmente trabalhou, dentro da janela. */
function dias(s: AppState, janela = JANELA_DIAS): Dia[] {
  const from = addDays(todayISO(), -(janela - 1))
  const to = todayISO()
  const porDia = new Map<string, Dia>()
  const get = (d: string) => {
    let x = porDia.get(d)
    if (!x) { x = { date: d, income: 0, expense: 0, km: 0, hours: 0, trips: 0 }; porDia.set(d, x) }
    return x
  }
  for (const t of (s.transactions || []) as Transaction[]) {
    if (!t?.date || t.date < from || t.date > to) continue
    if (t.type === 'income') get(t.date).income += t.amount
    else if (t.type === 'expense') get(t.date).expense += t.amount
  }
  for (const w of (s.workSessions || []) as WorkSession[]) {
    if (!w?.date || w.date < from || w.date > to) continue
    const d = get(w.date)
    d.km += w.km || 0
    d.hours += w.hours || 0
    d.trips += w.trips || 0
  }
  // Dia sem receita e sem km não é dia de trabalho: incluí-lo puxaria a média
  // para baixo com uma folga, e o motorista sabe que não rodou naquele dia.
  return [...porDia.values()]
    .filter(d => d.income > 0 || d.km > 0 || d.trips > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}

const soma = (v: number[]) => v.reduce((a, b) => a + b, 0)

/** "de 01/07/2026 a 08/07/2026, 8 dias com registro" — a régua de toda resposta. */
const amostra = (ds: Dia[]) =>
  `${ds.length} ${ds.length === 1 ? 'dia' : 'dias'} com registro, de ${brDate(ds[0].date)} a ${brDate(ds[ds.length - 1].date)}`

const semBase = (o_que: string) =>
  `Ainda não tenho ${o_que} suficiente para dizer o que é típico pra você — prefiro não inventar uma média.\n\n`
  + 'Registre alguns dias ("ganhei 320 hoje, rodei 180 km em 9 horas") que eu passo a comparar cada dia com o SEU normal, não com uma média de internet.'

// ---------------------------------------------------------------------------
// Perguntas
// ---------------------------------------------------------------------------

/** "Dia típico", "dia normal", "um dia comum": o ritmo diário dele. */
export const DIA_TIPICO = /\bdias?\s+(?:\w+\s+)?(?:tipic\w+|normal|normais|comum|comuns)\b|\b(?:tipic\w+|normal|comum)\s+dia\b/
const RE_TIPICO = /\b(?:costum\w+|tipic\w+|normal|em m[ée]dia|m[ée]dia)\b[^?]*\b(?:por dia|no dia|dia|dias)\b|\b(?:quanto|qual)[^?]*\b(?:costum\w+|tipic\w+)\b/
const RE_DIAS_FORTES = /\b(?:dias?|dia)\b[^?]*\b(?:mais fort\w+|melhor\w*|que rende\w*|mais rende\w*|mais forte)\b|\bmelhores? dias?\b|\bpiores? dias?\b|\bdias? (?:mais )?frac\w+\b/
const RE_PLATAFORMA = /\b(?:uber|99|indrive|indriver|plataformas?|aplicativos?|apps?)\b[^?]*\b(?:mais|melhor|rende|vem|d[áa]|paga|compensa)\b|\b(?:vale\s+a\s+pena|compensa)\b[^?]*\b(?:uber|99)\b[^?]*\bou\b|\b(?:de onde|qual)\b[^?]*\b(?:vem mais|rende mais|paga mais)\b|\bdistribui[çc][ãa]o\b/
const RE_TENDENCIA = /\b(?:tend[êe]ncia|essa semana|esta semana|ultimos dias|[úu]ltimos dias)\b[^?]*\b(?:melhor|pior|normal|m[ée]dia|comparad\w+)\b|\b(?:estou|to|t[ôo])(?![\wÀ-ÿ])[^?]*\b(?:acima|abaixo)\b[^?]*\b(?:normal|m[ée]dia)\b/
const RE_COMBUSTIVEL_TIPICO = /\b(?:costum\w+|tipic\w+|em m[ée]dia|quanto)\b[^?]*\b(?:gast\w+)\b[^?]*\b(?:gasolina|combust[íi]vel|etanol|[áa]lcool|gnv|diesel)\b[^?]*\b(?:por dia|no dia|por m[êe]s)\b/

/**
 * Resposta pronta, ou `undefined` quando a pergunta não é uma destas.
 * Determinística e offline: nada aqui chega perto da IA remota.
 */
export function driverInsight(s: AppState, input: string): string | undefined {
  const t = norm(input)

  if (RE_COMBUSTIVEL_TIPICO.test(t)) return combustivelTipico(s)
  // "Melhor horário pra rodar": o registro guarda a hora em que o GANHO foi
  // lançado, não a hora das corridas — e um dia inteiro registrado à noite
  // diria que a noite rende tudo. Sem esse dado, o app diz o que sabe medir.
  if (/\b(?:melhor|pior)\s+(?:horario|hora|periodo|turno)\b/.test(t)) {
    return 'Não consigo dizer o melhor horário: eu guardo a hora em que você REGISTRA cada ganho, não a hora das corridas — um dia inteiro lançado à noite pareceria que só a noite rende.\n\n'
      + 'O que dá para comparar com os seus números são os dias da semana. Pergunte "qual dia eu mais ganho?".'
  }
  if (RE_DIAS_FORTES.test(t)) return diasFortes(s, /pior|frac/.test(t))
  if (RE_PLATAFORMA.test(t)) return porPlataforma(s)
  if (RE_TENDENCIA.test(t)) return tendencia(s)
  if (RE_TIPICO.test(t) || DIA_TIPICO.test(t)) return diaTipico(s)
  return undefined
}

function diaTipico(s: AppState): string {
  const ds = dias(s)
  if (ds.length < MIN_DIAS) return semBase('dia de trabalho registrado')

  const receita = soma(ds.map(d => d.income)) / ds.length
  const despesa = soma(ds.map(d => d.expense)) / ds.length
  const km = soma(ds.map(d => d.km))
  const horas = soma(ds.map(d => d.hours))
  const viagens = soma(ds.map(d => d.trips))
  const lucro = receita - despesa

  const linhas = [
    `No seu ritmo dos últimos dias (dado real, ${amostra(ds)}):`,
    '',
    `• Faturamento: ${fmtBRL(receita)} por dia`,
    `• Despesas: ${fmtBRL(despesa)} por dia`,
    `• Sobra: ${fmtBRL(lucro)} por dia`,
  ]
  const faltando: string[] = []
  if (km > 0) linhas.push(`• Rodagem: ${fmtNum(km / ds.length, 0)} km por dia`)
  else faltando.push('os km')
  if (horas > 0) {
    linhas.push(`• Jornada: ${fmtNum(horas / ds.length)} h por dia — ${fmtBRL(soma(ds.map(d => d.income - d.expense)) / horas)} por hora`)
  } else faltando.push('as horas')
  if (viagens > 0) {
    // Por viagem só com os dias em que a quantidade foi dita (regra 34).
    const comViagem = ds.filter(d => d.trips > 0)
    linhas.push(`• Viagens: ${fmtNum(viagens / comViagem.length, 0)} por dia com viagens informadas — ${fmtBRL(soma(comViagem.map(d => d.income)) / viagens)} por viagem`)
  }
  else faltando.push('as viagens')
  if (km > 0 && horas > 0) linhas.push(`• Líquido por km: ${fmtBRL(soma(ds.map(d => d.income - d.expense)) / km)}`)

  if (faltando.length) {
    linhas.push('', `Ainda não tenho ${faltando.join(' nem ')} — registre junto com o ganho do dia que eu completo essa conta.`)
  }
  return linhas.join('\n')
}

function diasFortes(s: AppState, pior: boolean): string {
  const ds = dias(s, 60)
  if (ds.length < MIN_DIAS) return semBase('dia de trabalho registrado')

  const porSemana = new Map<number, { total: number; n: number }>()
  for (const d of ds) {
    const dow = fromISO(d.date).getDay()
    const cur = porSemana.get(dow) || { total: 0, n: 0 }
    cur.total += d.income - d.expense
    cur.n += 1
    porSemana.set(dow, cur)
  }
  // Um dia por dia da semana não é padrão, é ruído: dizer "sábado rende mais"
  // com um sábado registrado é uma afirmação que o dado não sustenta. Só entra
  // no ranking o dia da semana que se repetiu.
  const ranking = [...porSemana.entries()]
    .filter(([, v]) => v.n >= MIN_REPETICOES_DIA)
    .map(([dow, v]) => ({ dow, media: v.total / v.n, n: v.n }))
    .sort((a, b) => b.media - a.media)

  if (ranking.length < 3) {
    const semanas = Math.max(1, 3 - Math.floor(ds.length / 7))
    return `Ainda não dá para dizer quais dias da semana rendem mais: eu tenho ${amostra(ds)}, `
      + `e cada dia da semana apareceu poucas vezes.\n\nMe dê mais ${semanas} ${semanas === 1 ? 'semana' : 'semanas'} de registro `
      + 'que a comparação passa a valer alguma coisa — com um sábado só, dizer que sábado é o seu melhor dia seria chute.'
  }

  const melhor = ranking.slice(0, 2)
  const fraco = ranking[ranking.length - 1]
  const linha = (x: { dow: number; media: number; n: number }) =>
    `• ${weekdayName(x.dow)}: ${fmtBRL(x.media)} por dia (${x.n} ${x.n === 1 ? 'dia' : 'dias'} nessa amostra)`

  const corpo = pior
    ? [`Seus dias mais fracos (dado real, ${amostra(ds)}):`, '', linha(fraco), linha(ranking[ranking.length - 2])]
    : [`Seus dias mais fortes (dado real, ${amostra(ds)}):`, '', ...melhor.map(linha), '', `O mais fraco é ${weekdayName(fraco.dow)}, com ${fmtBRL(fraco.media)}.`]

  corpo.push('', 'É a média dos dias que você registrou — quanto mais dias, mais firme fica a comparação.')
  return corpo.join('\n')
}

/** Plataformas que o parser reconhece e grava na descrição da receita. */
const PLATAFORMAS: [RegExp, string][] = [
  [/^uber$/i, 'Uber'],
  [/^99$/i, '99'],
  [/^indrive$/i, 'inDrive'],
  [/corrida privada/i, 'Corrida privada'],
]

const NAMED_RIDE_APPS = /(?<![\p{L}\p{N}])(?<!\d[.,])(?:uber|in\s*drive[r]?|99(?!\s*(?:reais?|contos?)\b))(?![\p{L}\p{N}]|[.,]\d)/giu
const APP_RANKING = /^(?:qual|quais)\s+(?:(?:o|a)\s+)?(?:app|aplicativo|plataforma)s?\b[^?]*\b(?:paga|rende|vale|melhor|compensa)\b/
const APP_COMPARISON = /^(?:(?:me\s+)?compar(?:a|e|ar)|quanto\s+(?:eu\s+)?(?:ganhei|recebi|fiz|faturei|rendeu)|ganhei\s+mais|qual\s+(?:ganha|rende|paga)\s+mais|vale\s+a\s+pena\s+rodar|compensa\s+rodar)\b/

export function compareRideApps(state: AppState, input: string, today: string): string | undefined {
  if (!isDriver(state.settings)) return undefined
  const t = normalizeName(input).trim()
  if (/\b(?:gastei|paguei|quanto\s+custa|sem\s+contar|somando|juntas?|exceto|acima|abaixo|comparad[oa]\s+(?:com|a))\b/.test(t)) return undefined
  const names = [...new Set([...t.matchAll(NAMED_RIDE_APPS)].map(m =>
    m[0] === '99' ? '99' : m[0] === 'uber' ? 'Uber' : 'inDrive'))]
  const ranking = APP_RANKING.test(t)
  if (!ranking && !(names.length > 1 && APP_COMPARISON.test(t))) return undefined
  const saidPeriod = parsePeriod(t, today)?.period
  if (!saidPeriod && /\b(?:ultima\s+quinzena|ultimos\s+meses)\b/.test(t)) return undefined
  const metric = t.match(/\bpor\s+(hora|km|quilometro|viagem|corrida)\b/)?.[1]
  if (metric) {
    if (metric === 'viagem' || metric === 'corrida') return 'O histórico guarda a quantidade de viagens por dia. Preciso da quantidade por plataforma para calcular o valor por viagem de cada app.'
    const base = metric === 'hora' ? 'as horas de trabalho' : 'os quilômetros rodados'
    return `O app guarda ${base} por dia. Para comparar quanto cada plataforma paga por ${metric}, precisaria desses dados separados por plataforma.`
  }
  const advice = ranking || /\b(?:vale\s+a\s+pena|compensa)\b/.test(t)
  const period = saidPeriod || (advice ? {
    from: addDays(today, -(JANELA_DIAS - 1)), to: today, label: `nos últimos ${JANELA_DIAS} dias`, grain: 'day' as const,
  } : currentMonthToDate(today))
  const result = runQuery(state, {
    version: QUERY_DSL_VERSION, source: 'transactions', field: 'amount', period, group: 'platform',
    filter: { txType: ['income'], categories: ['corridas'] }, metric: 'sum', order: 'value-desc', limit: 8,
  }, today)
  const selected = names.length ? names : ['Uber', '99', 'inDrive'].filter(name => result.groups.some(g => g.key === name))
  const rows = selected.map(name => ({ name, value: result.groups.find(g => g.key === name) }))
  const found = rows.flatMap(({ value }) => value ? [value] : []).sort((a, b) => b.value - a.value)
  if (!found.length) {
    return `Não tenho receitas por plataforma registradas ${period.label}${names.length ? ` para ${names.join(' e ')}` : ''}.`
  }
  const [first, second] = found
  const lead = second && first.value === second.value ? `O maior total ficou empatado ${period.label}.`
    : second ? `${first.label} teve a maior receita registrada ${period.label}.`
      : `Receitas por plataforma ${period.label}.`
  const lines = rows.map(({ name, value }) => value
    ? `• ${name}: ${fmtBRL(value.value)} em ${value.count} ${value.count === 1 ? 'registro' : 'registros'}`
    : `• ${name}: sem receita registrada no período`)
  return [lead, lines.join('\n'), ...(advice ? ['Esses são os valores recebidos. Para comparar o rendimento por hora, faltam as horas separadas por plataforma.'] : [])].join('\n\n')
}

function porPlataforma(s: AppState): string {
  const from = addDays(todayISO(), -(JANELA_DIAS - 1))
  const total = new Map<string, { valor: number; n: number }>()
  let outras = 0
  for (const t of (s.transactions || []) as Transaction[]) {
    if (t?.type !== 'income' || t.category !== 'corridas' || t.date < from) continue
    const nome = PLATAFORMAS.find(([re]) => re.test((t.description || '').trim()))?.[1]
    if (!nome) { outras += t.amount; continue }
    const cur = total.get(nome) || { valor: 0, n: 0 }
    cur.valor += t.amount
    cur.n += 1
    total.set(nome, cur)
  }
  if (!total.size) {
    return 'Ainda não sei separar suas corridas por plataforma: as receitas registradas não dizem se foram Uber, 99, inDrive ou particular.\n\n'
      + 'Quando registrar, diga a plataforma ("ganhei 430 na Uber e 399 na 99") que eu passo a mostrar de onde vem mais dinheiro.'
  }
  const soma_ = [...total.values()].reduce((a, b) => a + b.valor, 0) + outras
  const ranked = [...total.entries()].sort((a, b) => b[1].valor - a[1].valor)
  const linhas = ranked.map(([nome, v]) =>
    `• ${nome}: ${fmtBRL(v.valor)} em ${v.n} ${v.n === 1 ? 'registro' : 'registros'} (${Math.round((v.valor / soma_) * 100)}%)`)
  if (outras > 0) linhas.push(`• Sem plataforma informada: ${fmtBRL(outras)} (${Math.round((outras / soma_) * 100)}%)`)

  const [top] = ranked
  return `De onde veio o seu dinheiro nos últimos ${JANELA_DIAS} dias (dado real):\n\n${linhas.join('\n')}\n\n`
    + `${top[0]} é a sua maior fonte no período. Isso é o que foi registrado — plataforma que você não citar na mensagem eu não tenho como separar.`
}

function tendencia(s: AppState): string {
  const recentes = dias(s, 7)
  const todos = dias(s, JANELA_DIAS)
  if (todos.length < MIN_DIAS || !recentes.length) return semBase('dia de trabalho registrado')

  const mediaDe = (ds: Dia[]) => soma(ds.map(d => d.income - d.expense)) / ds.length
  const agora = mediaDe(recentes)
  const anteriores = todos.filter(d => !recentes.some(x => x.date === d.date))
  // Comparar a semana com dois dias soltos e chamar isso de "o seu normal" é
  // dar cara de padrão a uma amostra que não é padrão nenhum.
  if (anteriores.length < MIN_DIAS) {
    return `Ainda não dá para comparar: praticamente tudo que eu tenho registrado é dos últimos dias (${amostra(todos)}), `
      + `e sobram só ${anteriores.length} ${anteriores.length === 1 ? 'dia' : 'dias'} para formar o seu normal.\n\n`
      + 'Depois de mais uma ou duas semanas de registro eu consigo dizer se você está acima ou abaixo do seu ritmo.'
  }
  const normal = mediaDe(anteriores)
  const dif = agora - normal
  const pct = normal !== 0 ? Math.round((dif / Math.abs(normal)) * 100) : 0

  return `Últimos 7 dias: ${fmtBRL(agora)} de sobra por dia (${recentes.length} ${recentes.length === 1 ? 'dia' : 'dias'} com registro).\n`
    + `Seu normal antes disso: ${fmtBRL(normal)} por dia (${anteriores.length} dias, dentro dos últimos ${JANELA_DIAS}).\n\n`
    + (Math.abs(pct) < 8
      ? 'Está dentro do seu ritmo de sempre. Dados reais, sem projeção.'
      : dif > 0
        ? `Você está ${pct}% acima do seu normal. 💪 Dados reais, sem projeção.`
        : `Você está ${Math.abs(pct)}% abaixo do seu normal. Dados reais — pode ser só a semana, mas vale olhar.`)
}

function combustivelTipico(s: AppState): string {
  const from = addDays(todayISO(), -(JANELA_DIAS - 1))
  const total = fuelSpend(s, from, todayISO())
  if (total <= 0) {
    return 'Ainda não tenho abastecimento registrado nos últimos 30 dias, então não sei qual é o seu gasto típico de combustível.\n\n'
      + 'Registre um ("botei 100 de gasolina") que eu passo a calcular com os seus números.'
  }
  const ds = dias(s)
  const receita = soma(ds.map(d => d.income))
  const porDia = ds.length ? total / ds.length : total / JANELA_DIAS
  return `Combustível nos últimos ${JANELA_DIAS} dias: ${fmtBRL(total)} (dado real).\n\n`
    + `• Por dia trabalhado: ${fmtBRL(porDia)}${ds.length ? ` (${amostra(ds)})` : ''}\n`
    + (receita > 0 ? `• Fatia do que você faturou: ${fmtNum((total / receita) * 100)}%\n` : '')
    + '\nSão os seus lançamentos, não uma média genérica.'
}
