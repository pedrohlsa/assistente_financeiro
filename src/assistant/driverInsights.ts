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
import { isDriver, isDrivingExpense, RIDE_INCOME_CATEGORIES } from '../services/profile'
import { addDays, fmtBRL, fmtNum, fromISO, todayISO } from '../utils/format'
import { brDate } from './dates'
import { normalizeName, weekdayName } from '../utils/text'
import { currentMonthToDate, parsePeriod } from './query/period'
import { runQuery } from './query/engine'
import { QUERY_DSL_VERSION } from './query/types'
import { FALTAM_VIAGENS_POR_APP } from './driverAdvice'

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
function dias(s: AppState, to: string, janela = JANELA_DIAS): Dia[] {
  const from = addDays(to, -(janela - 1))
  const porDia = new Map<string, Dia>()
  const get = (d: string) => {
    let x = porDia.get(d)
    if (!x) { x = { date: d, income: 0, expense: 0, km: 0, hours: 0, trips: 0 }; porDia.set(d, x) }
    return x
  }
  for (const t of (s.transactions || []) as Transaction[]) {
    if (!t?.date || t.date < from || t.date > to) continue
    if (t.type === 'income' && RIDE_INCOME_CATEGORIES.includes(t.category)) get(t.date).income += t.amount
    else if (t.type === 'expense' && isDrivingExpense(t.category, t.description)) get(t.date).expense += t.amount
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
    .filter(d => d.income > 0 || d.km > 0 || d.hours > 0 || d.trips > 0)
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
export const DIA_TIPICO = /\bdias?\s+(?:\w+\s+)?(?:tipic\w+|normal|normais|comum|comuns)\b|\b(?:tipic\w+|normal|comum)\s+(?:por\s+)?dia\b/
export const DIAS_DE_CORRIDA = /^(?:quais|qual)\s+dias?\s+(?:da\s+semana\s+)?rend\w*\s+(?:mais|menos)\s+(?:nas\s+corridas|no\s+volante)\s*[?.!]*$/
/**
 * "Quanto tá o litro?", "quanto paguei no litro", "preço médio do litro": é
 * PREÇO, não volume. A consulta de litros respondia "96 L" para quem queria
 * saber quanto pagou em cada litro.
 */
export const PRECO_DO_LITRO = /\b(?:preco|valor)\s+(?:medio\s+)?(?:d[oe]|por|pelo)\s+litro\b|\b(?:quanto|qnto|qto)\s+(?:(?:eu|que\s+eu)\s+)?(?:ta|esta|estava|tava|paguei|pago|to\s+pagando|estou\s+pagando|tou\s+pagando|custa|custou|sai|saiu|saindo|deu)\s+(?:no\s+|o\s+|pelo\s+|por\s+|cada\s+)?litro\b|\blitro\s+(?:ta|esta|tava|custa|custou|sai|saiu|saindo)\s+(?:quanto|a\s+quanto)\b|\bmedia\s+(?:do|por|de)\s+litro\b|\ba\s+quanto\s+(?:ta|esta|tava|paguei)\s+(?:o\s+)?litro\b|^(?:e\s+)?(?:quanto|qnto|qto)\s+(?:ta|esta|tava)\s+(?:a\s+|o\s+)?(?:gasolina|etanol|alcool|diesel)\s*[?.!]*$/

/**
 * Preço pago por litro: o do último abastecimento e a média ponderada do
 * período (valor total ÷ litros), só com abastecimento que tem os dois.
 */
export function answerFuelPrice(state: AppState, t: string, hoje = todayISO()): string | null {
  if (!isDriver(state.settings) || !PRECO_DO_LITRO.test(t)) return null
  const lido = parsePeriod(t, hoje)
  const periodo = lido?.period || currentMonthToDate(hoje)
  const validos = (state.fuelRecords || []).filter(f => f.liters > 0 && f.amount > 0 && f.date <= hoje)
  if (!validos.length) {
    return 'Ainda não tenho abastecimento com valor e litros registrados, então não sei quanto você paga no litro.\n\n'
      + 'Registre o próximo assim: "abasteci 100, 17 litros".'
  }
  const ultimo = [...validos].sort((a, b) => b.date.localeCompare(a.date))[0]
  const precoUltimo = ultimo.amount / ultimo.liters
  const tipo = ultimo.fuelType ? ` de ${ultimo.fuelType.toLowerCase()}` : ''
  const linhas = [`No último abastecimento${tipo} (${brDate(ultimo.date)}) o litro saiu ${fmtBRL(precoUltimo)} (dado real).`]
  const noPeriodo = validos.filter(f => f.date >= periodo.from && f.date <= periodo.to)
  if (noPeriodo.length >= 2) {
    const valor = noPeriodo.reduce((a, f) => a + f.amount, 0)
    const litros = noPeriodo.reduce((a, f) => a + f.liters, 0)
    const media = `Média ${periodo.label}: ${fmtBRL(valor / litros)} por litro, em ${noPeriodo.length} abastecimentos (${fmtNum(litros, litros % 1 ? 1 : 0)} L por ${fmtBRL(valor)} — dado real).`
    // Período dito: a média DELE é a resposta; o último litro vira contexto.
    if (lido) linhas.unshift(media)
    else linhas.push(media)
  } else if (lido && !noPeriodo.length) {
    linhas.unshift(`Não tenho abastecimento com litros ${periodo.label}.`)
  }
  return linhas.join('\n')
}

/** "Qual horário rende mais", "de manhã ou de noite?": hora das corridas, que o app não guarda. */
export const PEDE_HORARIO = /\b(?:melhor|pior)\s+(?:horario|hora|periodo|turno)\b|\b(?:qual|que|em\s+que)\s+(?:horario|periodo\s+do\s+dia|turno)\b|\bhorario\b[^?]*\b(?:rende|compensa|paga|mais|melhor)\b|\b(?:de\s+)?(?:manha|tarde|noite|madrugada)\s+ou\s+(?:de\s+|a\s+|na\s+)?(?:manha|tarde|noite|madrugada)\b/
/** "Tô rodando no prejuízo?", "tá compensando rodar?": as corridas contra o que o carro custou. */
export const PEDE_PREJUIZO_DE_RODAR = /\b(?:rodando|rodar|dirigindo|no\s+volante|com\s+(?:o\s+)?carro|com\s+(?:as\s+)?corridas|de\s+(?:uber|99|app|aplicativo))\b[^?]*\bprejuizo\b|\bprejuizo\b[^?]*\b(?:rodando|rodar|corridas?|carro|uber|99|app)\b|\b(?:ta|esta|tá|tah)\s+compensando\s+(?:rodar|dirigir|fazer\s+(?:uber|corrida|app))\b|\b(?:compensa|vale\s+a\s+pena)\s+(?:continuar\s+)?rodando\b|\b(?:to|tou|estou)\s+(?:tendo\s+)?(?:lucro|prejuizo)\s+(?:rodando|com\s+(?:as\s+)?corridas|no\s+(?:uber|app))\b/

/**
 * As corridas do mês contra o que o carro custou nelas. Sim/não primeiro
 * (regra 57). Os custos fixos configurados entram à parte, pelo mês inteiro:
 * sem eles, "sobra" esconderia o seguro e a parcela do carro.
 */
export function rodandoNoPrejuizo(s: AppState, today = todayISO(), pergunta = 'prejuizo'): string {
  // "Tô no prejuízo?" e "tá compensando?" pedem respostas de sinal oposto.
  const perguntaPeloPrejuizo = /\bprejuizo\b/.test(pergunta)
  const inicio = `${today.slice(0, 7)}-01`
  const ds = dias(s, today, Math.round((fromISO(today).getTime() - fromISO(inicio).getTime()) / 864e5) + 1)
  const receita = soma(ds.map(d => d.income))
  const gasto = soma(ds.map(d => d.expense))
  if (!(receita > 0)) {
    return 'Não tenho receita de corridas registrada este mês para dizer se está compensando.\n\n'
      + 'Registre o dia ("fiz 280 hoje, abasteci 80") que eu comparo o que entrou com o que o carro custou.'
  }
  const sobra = receita - gasto
  const fixos = s.settings.fixedMonthlyCosts || 0
  const comFixos = sobra - fixos
  const base = `Este mês as corridas renderam ${fmtBRL(receita)} e o carro custou ${fmtBRL(gasto)} em gastos registrados (combustível, manutenção, pedágio e estacionamento) — ${sobra >= 0 ? `sobram ${fmtBRL(sobra)}` : `faltam ${fmtBRL(-sobra)}`} (dado real, ${amostra(ds)}).`
  const fixo = fixos > 0
    ? `\n\nContando os custos fixos que você configurou pelo mês inteiro (${fmtBRL(fixos)}), ${comFixos >= 0 ? `ainda sobram ${fmtBRL(comFixos)}` : `faltam ${fmtBRL(-comFixos)} para cobri-los`}.`
    : '\n\nCustos fixos do carro (seguro, IPVA, parcela) não estão configurados em Veículo — se existirem, saem dessa sobra.'
  const nota = '\n\nSuas contas pessoais não entram nesta conta: é só o que rodar rendeu contra o que o carro custou.'
  if (fixos > 0 && sobra >= 0 && comFixos < 0) return `Ainda não cobre tudo. ${base}${fixo}${nota}`
  const prejuizo = sobra < 0
  return `${prejuizo === perguntaPeloPrejuizo ? 'Sim' : 'Não'}. ${base}${fixo}${nota}`
}

/** "Qual o valor mínimo de corrida que vale a pena?", "quanto devo cobrar por km": texto sem acento. */
export const PEDE_MINIMO_POR_KM = /valor minimo|minimo (?:de|da|pra|para|por|que)|sair lucrando|quanto (?:eu\s+)?(?:devo\s+|tenho\s+que\s+|preciso\s+)?cobrar|devo aceitar|vale a pena aceitar|aceitar\s+a\s+partir\s+de\s+quanto/

/** "Quanto tá o hodômetro?", "qual o km do meu carro?": a leitura do painel, não gasto por km. */
export const PEDE_HODOMETRO = /\b(?:quanto|qual|quantos)\b[^?]*\b(?:hodometro|odometro|painel|quilometragem\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:carro|moto|veiculo)|km\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:carro|moto|veiculo))\b|\bquanto\s+(?:eu\s+)?(?:ja\s+)?rodei\s+com\s+(?:esse|este|o|meu|essa|esta|a|minha)\s+(?:carro|moto|veiculo)\b|\bquantos\s+km\s+(?:tem|esta|ta)\s+(?:o\s+|meu\s+|minha\s+|a\s+)?(?:carro|moto|veiculo)\b/

export function answerOdometer(s: AppState, t: string): string | null {
  if (!isDriver(s.settings) || !PEDE_HODOMETRO.test(t)) return null
  const odo = s.vehicle?.odometer || 0
  if (!(odo > 0)) return 'Ainda não tenho o hodômetro registrado. Diga, por exemplo, "o painel marca 45000" que eu guardo.'
  const comLeitura = (s.fuelRecords || []).filter(f => (f.odometer || 0) > 0).sort((a, b) => b.date.localeCompare(a.date))[0]
  const quando = comLeitura && comLeitura.odometer === odo ? ` (leitura do abastecimento de ${brDate(comLeitura.date)})` : ''
  const linhas = [`O hodômetro está em ${fmtNum(odo, 0)} km${quando}.`]
  if (/\brodei\s+com\b/.test(t)) {
    const trabalhados = (s.workSessions || []).reduce((a, w) => a + (w.km || 0), 0)
    linhas.push(`Esse é o total do veículo, não só o que você rodou com ele.${trabalhados > 0 ? ` Os km de trabalho que você registrou somam ${fmtNum(trabalhados, 0)} km.` : ''}`)
  }
  return linhas.join('\n\n')
}

/** "Quantos dias eu rodei esse mês?", "quantas folgas tirei?": contagem de DIAS, não dinheiro. */
export const PEDE_DIAS_TRABALHADOS = /\bquantos\s+dias\s+(?:eu\s+)?(?:ja\s+)?(?:rodei|trabalhei|rodando|trabalhando|sai\s+(?:pra|para)\s+rodar|fiz\s+corrida)\b|\bquantas\s+folgas\b|\bquantos\s+dias\s+(?:de\s+)?folga\b|\bquantos\s+dias\s+(?:eu\s+)?(?:fiquei\s+)?(?:parado|sem\s+rodar)\b/

export function answerWorkedDays(s: AppState, t: string, hoje = todayISO()): string | null {
  if (!isDriver(s.settings) || !PEDE_DIAS_TRABALHADOS.test(t)) return null
  // "Quantos dias de folga eu TENHO POR SEMANA?": a configuração, não o histórico.
  if (/\bpor\s+semana\b|\bna\s+semana\b(?!\s+passada)/.test(t) && /\b(?:tenho|tiro|costumo|devo)\b/.test(t)) {
    const dias = [...(s.settings.workDays || [])].sort((a, b) => a - b)
    const folgas = [0, 1, 2, 3, 4, 5, 6].filter(d => !dias.includes(d))
    return `Na sua configuração você trabalha ${dias.length} ${dias.length === 1 ? 'dia' : 'dias'} por semana${folgas.length ? ` e folga ${folgas.length === 1 ? 'no' : 'nos dias:'} ${folgas.map(d => weekdayName(d).toLowerCase()).join(', ')}` : ', sem folga fixa'}. `
      + 'É com esses dias que eu reparto a meta do mês. Para mudar, ajuste os dias de trabalho em Configurações.'
  }
  const periodo = parsePeriod(t, hoje)?.period || currentMonthToDate(hoje)
  const ate = periodo.to < hoje ? periodo.to : hoje
  if (periodo.from > ate) return `O período ${periodo.label} ainda não começou.`
  const rodados = new Set<string>()
  for (const w of (s.workSessions || []) as WorkSession[]) {
    if (w?.date >= periodo.from && w.date <= ate && ((w.km || 0) > 0 || (w.hours || 0) > 0 || (w.trips || 0) > 0)) rodados.add(w.date)
  }
  for (const x of (s.transactions || []) as Transaction[]) {
    if (x?.type === 'income' && RIDE_INCOME_CATEGORIES.includes(x.category) && x.date >= periodo.from && x.date <= ate) rodados.add(x.date)
  }
  const corridos = Math.round((fromISO(ate).getTime() - fromISO(periodo.from).getTime()) / 864e5) + 1
  const n = rodados.size
  const sem = corridos - n
  const folga = /\bfolga|parado|sem\s+rodar\b/.test(t)
  const linhaRodou = `Você rodou ${n} ${n === 1 ? 'dia' : 'dias'} ${periodo.label}, de ${corridos} ${corridos === 1 ? 'dia corrido' : 'dias corridos'} (dado real).`
  const linhaFolga = `${sem} ${sem === 1 ? 'dia ficou' : 'dias ficaram'} sem corrida nem rodagem registrada ${periodo.label}.`
  const nota = 'Contei os dias com receita de corridas ou com km, horas ou viagens registradas. Dia trabalhado sem nada lançado aparece como folga.'
  return [folga ? linhaFolga : linhaRodou, folga ? linhaRodou : linhaFolga, nota].join('\n\n')
}

export const COMBUSTIVEL_POR_DIA_TRABALHADO = /^quanto\s+(?:eu\s+)?(?:costumo\s+gastar|gasto)\s+(?:de|com)\s+combustivel\s+por\s+dia\s+trabalhado\s*[?.!]*$/
const RE_TIPICO = /\b(?:costum\w+|tipic\w+|normal|em m[ée]dia|m[ée]dia)\b[^?]*\b(?:por dia|no dia|dia|dias)\b|\b(?:quanto|qual)[^?]*\b(?:costum\w+|tipic\w+)\b/
const RE_DIAS_FORTES = /\b(?:dias?|dia)\b[^?]*\b(?:mais fort\w+|melhor\w*|que rende\w*|mais rende\w*|mais forte)\b|\bmelhores? dias?\b|\bpiores? dias?\b|\bdias? (?:mais )?frac\w+\b/
const RE_PLATAFORMA = /\b(?:uber|99|indrive|indriver|plataformas?|aplicativos?|apps?)\b[^?]*\b(?:mais|melhor|rende|vem|d[áa]|paga|compensa)\b|\b(?:vale\s+a\s+pena|compensa)\b[^?]*\b(?:uber|99)\b[^?]*\bou\b|\b(?:de onde|qual)\b[^?]*\b(?:vem mais|rende mais|paga mais)\b|\bdistribui[çc][ãa]o\b/
const RE_TENDENCIA = /\b(?:tend[êe]ncia|essa semana|esta semana|ultimos dias|[úu]ltimos dias)\b[^?]*\b(?:melhor|pior|normal|m[ée]dia|comparad\w+)\b|\b(?:estou|to|t[ôo])(?![\wÀ-ÿ])[^?]*\b(?:acima|abaixo)\b[^?]*\b(?:normal|m[ée]dia)\b/
const RE_COMBUSTIVEL_TIPICO = /\b(?:costum\w+|tipic\w+|em m[ée]dia|quanto)\b[^?]*\b(?:gast\w+)\b[^?]*\b(?:gasolina|combust[íi]vel|etanol|[áa]lcool|gnv|diesel)\b[^?]*\b(?:por dia|no dia|por m[êe]s)\b/

/**
 * Resposta pronta, ou `undefined` quando a pergunta não é uma destas.
 * Determinística e offline: nada aqui chega perto da IA remota.
 */
export function driverInsight(s: AppState, input: string, today = todayISO()): string | undefined {
  const t = norm(input)

  if (RE_COMBUSTIVEL_TIPICO.test(t)) return combustivelTipico(s, today)
  // "Melhor horário pra rodar": o registro guarda a hora em que o GANHO foi
  // lançado, não a hora das corridas — e um dia inteiro registrado à noite
  // diria que a noite rende tudo. Sem esse dado, o app diz o que sabe medir.
  if (PEDE_PREJUIZO_DE_RODAR.test(t)) return rodandoNoPrejuizo(s, today, t)
  if (PEDE_HORARIO.test(t)) {
    return 'Não consigo dizer o melhor horário: eu guardo a hora em que você REGISTRA cada ganho, não a hora das corridas — um dia inteiro lançado à noite pareceria que só a noite rende.\n\n'
      + 'O que dá para comparar com os seus números são os dias da semana. Pergunte "qual dia eu mais ganho?".'
  }
  if (RE_DIAS_FORTES.test(t) || DIAS_DE_CORRIDA.test(t)) return diasFortes(s, /pior|frac|menos/.test(t), today)
  if (RE_PLATAFORMA.test(t)) return porPlataforma(s, today)
  if (RE_TENDENCIA.test(t)) return tendencia(s, today)
  if (RE_TIPICO.test(t) || DIA_TIPICO.test(t)) return diaTipico(s, today)
  return undefined
}

function diaTipico(s: AppState, today: string): string {
  const ds = dias(s, today).filter(d => d.income > 0)
  if (ds.length < MIN_DIAS) return semBase('dias com receita de corridas')

  const receita = soma(ds.map(d => d.income)) / ds.length
  const despesa = soma(ds.map(d => d.expense)) / ds.length
  const lucro = receita - despesa
  const comKm = ds.filter(d => d.km > 0)
  const comHoras = ds.filter(d => d.hours > 0)
  const comViagens = ds.filter(d => d.trips > 0)
  const km = soma(comKm.map(d => d.km))
  const horas = soma(comHoras.map(d => d.hours))
  const viagens = soma(comViagens.map(d => d.trips))

  const linhas = [
    `No seu ritmo de corridas (dado real, ${amostra(ds)}):`,
    '',
    `• Faturamento: ${fmtBRL(receita)} por dia`,
    `• Despesas de rodagem: ${fmtBRL(despesa)} por dia`,
    `• Sobra: ${fmtBRL(lucro)} por dia`,
  ]
  const faltando: string[] = []
  if (km > 0) linhas.push(`• Rodagem: ${fmtNum(km / comKm.length)} km por dia com quilometragem (${comKm.length} na amostra)`)
  else faltando.push('os km')
  if (horas > 0) {
    linhas.push(`• Jornada: ${fmtNum(horas / comHoras.length)} h por dia com horas (${comHoras.length} na amostra) — ${fmtBRL(soma(comHoras.map(d => d.income - d.expense)) / horas)} líquidos por hora`)
  } else faltando.push('as horas')
  if (viagens > 0) {
    // Por viagem só com os dias em que a quantidade foi dita (regra 34).
    linhas.push(`• Viagens: ${fmtNum(viagens / comViagens.length)} por dia com viagens informadas (${comViagens.length} na amostra) — ${fmtBRL(soma(comViagens.map(d => d.income)) / viagens)} por viagem`)
  }
  else faltando.push('as viagens')
  if (km > 0) linhas.push(`• Líquido por km: ${fmtBRL(soma(comKm.map(d => d.income - d.expense)) / km)}`)

  if (faltando.length) {
    linhas.push('', `Ainda não tenho ${faltando.join(' nem ')} — registre junto com o ganho do dia que eu completo essa conta.`)
  }
  return linhas.join('\n')
}

function diasFortes(s: AppState, pior: boolean, today: string): string {
  const ds = dias(s, today, 60).filter(d => d.income > 0)
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

const NAMED_RIDE_APPS = /(?<![\p{L}\p{N}$])(?<!\d[.,])(?:uber|in\s*drive[r]?|i\s*food|rappi|99(?!\s*(?:reais?|contos?|km|quilometros?|horas?)\b))(?![\p{L}\p{N}]|[.,]\d)/giu
const RIDE_APP_LABELS = new Map([['uber', 'Uber'], ['99', '99'], ['indrive', 'inDrive'], ['indriver', 'inDrive'], ['ifood', 'iFood'], ['rappi', 'Rappi']])
const APP_RANKING = /^(?:(?:qual|quais)\s+(?:(?:o|a)\s+)?(?:app|aplicativo|plataforma)s?\b[^?]*\b(?:paga(?:ram|m)?|pagou|rende|vale|melhor|compensa)|ganhei\s+mais\s+em\s+qual\s+(?:app|aplicativo|plataforma))\b/
const APP_COMPARISON = /^(?:(?:me\s+)?compar(?:a|e|ar)|quanto\s+(?:eu\s+)?(?:ganhei|recebi|fiz|faturei|rendeu)|ganhei\s+mais|(?:qual|quem)\s+(?:ganha|rende|paga|pagou)\s+mais|vale\s+a\s+pena\s+rodar|compensa\s+rodar)\b/
const APP_GAP = /^(?:qual|quanto)\s+(?:(?:foi|e)\s+)?a\s+diferenca\b/
const APP_ORDER = /^(?:(?:a|o)\s+)?(?:uber|99|in\s*drive[r]?|i\s*food|rappi)\s+(?:me\s+)?(?:paga|pagou|rende|rendeu)\s+(mais|menos)\s+(?:do\s+)?que\b/

export function compareRideApps(state: AppState, input: string, today: string): string | undefined {
  if (!isDriver(state.settings)) return undefined
  const t = normalizeName(input).trim()
  if (/\b(?:gastei|paguei|quanto\s+custa|sem\s+contar|somando|juntas?|exceto|acima|abaixo|comparad[oa]\s+(?:com|a))\b/.test(t)
    || /[,;]\s*(?:eu\s+)?(?:recebi|ganhei|trabalhei|rodei|abasteci)\b/.test(t)) return undefined
  const names = [...new Set([...t.matchAll(NAMED_RIDE_APPS)].flatMap(m => {
    if (m[0] === '99' && /r\$\s*$/.test(t.slice(0, m.index))) return []
    const name = RIDE_APP_LABELS.get(m[0].replace(/\s/g, ''))
    return name ? [name] : []
  }))]
  const ranking = APP_RANKING.test(t)
  const gap = names.length === 2 && APP_GAP.test(t)
  const direction = names.length === 2 ? t.match(APP_ORDER)?.[1] : undefined
  if (!ranking && !gap && !direction && !(names.length > 1 && APP_COMPARISON.test(t))) return undefined
  const saidPeriod = parsePeriod(t, today)?.period
  if (!saidPeriod && /\b(?:ultima\s+quinzena|ultimos\s+meses)\b/.test(t)) return undefined
  const metric = t.match(/\bpor\s+(hora|km|quilometro|viagem|corrida)\b/)?.[1]
  if (metric) {
    if (metric === 'viagem' || metric === 'corrida') return FALTAM_VIAGENS_POR_APP
    const base = metric === 'hora' ? 'as horas de trabalho' : 'os quilômetros rodados'
    return `O app guarda ${base} por dia. Para comparar quanto cada plataforma paga por ${metric === 'hora' ? 'hora' : 'km'}, precisaria desses dados separados por plataforma.`
  }
  const advice = /\b(?:vale\s+a\s+pena|compensa|melhor)\b/.test(t)
  const period = saidPeriod || (ranking || advice ? {
    from: addDays(today, -(JANELA_DIAS - 1)), to: today, label: `nos últimos ${JANELA_DIAS} dias`, grain: 'day' as const,
  } : currentMonthToDate(today))
  const result = runQuery(state, {
    version: QUERY_DSL_VERSION, source: 'transactions', field: 'amount', period, group: 'platform',
    filter: { txType: ['income'], categories: ['corridas'] }, metric: 'sum', order: 'value-desc', limit: 8,
  }, today)
  const selected = names.length ? names : result.groups.map(group => group.key)
  const rows = selected.map(name => ({ name, value: result.groups.find(g => g.key === name) }))
  const found = rows.flatMap(({ value }) => value ? [value] : []).sort((a, b) => b.value - a.value)
  if (!found.length) {
    return `Não tenho receitas por plataforma registradas ${period.label}${names.length ? ` para ${names.join(' e ')}` : ''}.`
  }
  const [first, second] = found
  let lead = second && first.value === second.value ? `O maior total ficou empatado ${period.label}.`
    : second ? `${first.label} teve a maior receita registrada ${period.label}.` : `Receitas por plataforma ${period.label}.`
  if (gap || direction) {
    if (!second) lead = `Para calcular a diferença ${period.label}, preciso de receitas registradas dos dois apps.`
    else {
      const delta = first.value - second.value
      if (!delta) lead = `${direction ? 'Não. ' : ''}Os dois apps tiveram a mesma receita registrada ${period.label}.`
      else {
        const agrees = direction === 'mais' ? first.key === names[0] : second.key === names[0]
        lead = `${direction ? (agrees ? 'Sim. ' : 'Não. ') : ''}${first.label} registrou ${fmtBRL(delta)} a mais que ${second.label} ${period.label}.`
      }
    }
  }
  const lines = rows.map(({ name, value }) => value
    ? `• ${name}: ${fmtBRL(value.value)} em ${value.count} ${value.count === 1 ? 'registro' : 'registros'}`
    : `• ${name}: sem receita registrada no período`)
  return [lead, lines.join('\n'), ...(advice ? ['Esses são os valores recebidos. Para comparar o rendimento por hora, faltam as horas separadas por plataforma.'] : [])].join('\n\n')
}

function porPlataforma(s: AppState, today: string): string {
  const from = addDays(today, -(JANELA_DIAS - 1))
  const total = new Map<string, { valor: number; n: number }>()
  let outras = 0
  for (const t of (s.transactions || []) as Transaction[]) {
    if (t?.type !== 'income' || t.category !== 'corridas' || t.date < from || t.date > today) continue
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

function tendencia(s: AppState, today: string): string {
  const todos = dias(s, today).filter(d => d.income > 0)
  const recentes = todos.filter(d => d.date >= addDays(today, -6))
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
  const diagnosis = normal === 0 && dif !== 0 ? `Sua média anterior foi zero. Agora a sobra diária está ${fmtBRL(Math.abs(dif))} ${dif > 0 ? 'acima' : 'abaixo'} dela.`
    : Math.abs(pct) < 8 ? 'Está dentro do seu ritmo de sempre. Dados reais, sem projeção.'
      : `Você está ${Math.abs(pct)}% ${dif > 0 ? 'acima' : 'abaixo'} do seu normal. Dados reais, sem projeção.`

  return `Últimos 7 dias: ${fmtBRL(agora)} de sobra por dia (${recentes.length} ${recentes.length === 1 ? 'dia' : 'dias'} com registro).\n`
    + `Seu normal antes disso: ${fmtBRL(normal)} por dia (${anteriores.length} dias, dentro dos últimos ${JANELA_DIAS}).\n\n`
    + diagnosis
}

function combustivelTipico(s: AppState, today: string): string {
  const from = addDays(today, -(JANELA_DIAS - 1))
  const total = fuelSpend(s, from, today)
  if (total <= 0) {
    return 'Ainda não tenho abastecimento registrado nos últimos 30 dias, então não sei qual é o seu gasto típico de combustível.\n\n'
      + 'Registre um ("botei 100 de gasolina") que eu passo a calcular com os seus números.'
  }
  const ds = dias(s, today)
  const receita = soma(ds.map(d => d.income))
  return `Combustível nos últimos ${JANELA_DIAS} dias: ${fmtBRL(total)} (dado real).\n\n`
    + (ds.length ? `• Por dia trabalhado registrado: ${fmtBRL(total / ds.length)} (${amostra(ds)})\n` : 'Para calcular por dia trabalhado, preciso de dias de trabalho registrados.\n')
    + (receita > 0 ? `• Fatia do que você faturou: ${fmtNum((total / receita) * 100)}%\n` : '')
    + '\nSão os seus lançamentos, não uma média genérica.'
}
