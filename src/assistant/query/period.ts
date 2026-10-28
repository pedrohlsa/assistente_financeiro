// PERÍODOS ditos em pt-BR → `QueryPeriod`.
//
// Substitui `periodFromText()` de `src/services/ai.ts`, que conhecia SEIS frases
// e caía em "últimos 7 dias" para todo o resto — respondendo "quanto gastei nos
// últimos 3 meses" com o total de uma semana, sem avisar ninguém.
//
// Regra desta camada: expressão que não é reconhecida devolve `null`. Nunca um
// período "aproximado". Quem chama decide o que fazer com a ausência — e a
// resposta certa quase sempre é usar o padrão EXPLÍCITO ("este mês") e dizer
// qual período foi usado.

import { addDays, fromISO, monthKey, toISO, todayISO } from '../../utils/format'
import type { PeriodGrain, QueryPeriod } from './types'

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]
const MES_RE = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'

// MAPA, nao objeto: leitura por colchete anda pela cadeia de prototipo, e
// `MES_CURTO['con']` de "constructor" ja foi um crash real em outro modulo.
const MES_CURTO = new Map<string, number>(Object.entries({
  jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
  jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11,
}))

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const mesIndex = (nome: string): number => {
  const s = semAcento(nome)
  const i = MESES.findIndex(m => semAcento(m) === s)
  if (i >= 0) return i
  return MES_CURTO.get(s.slice(0, 3)) ?? -1
}

const primeiroDia = (ano: number, mes: number) => toISO(new Date(ano, mes, 1))
const ultimoDia = (ano: number, mes: number) => toISO(new Date(ano, mes + 1, 0))

const P = (from: string, to: string, label: string, grain: PeriodGrain, hoje: string): QueryPeriod =>
  ({ from, to, label, grain, future: from > hoje })

/** Mês inteiro que contém `iso`, recuado `back` meses. */
export function monthPeriod(iso: string, back = 0, hoje = todayISO()): QueryPeriod {
  const d = fromISO(iso)
  const alvo = new Date(d.getFullYear(), d.getMonth() - back, 1)
  const ano = alvo.getFullYear()
  const mes = alvo.getMonth()
  const label = back === 0 ? 'este mês' : back === 1 ? 'no mês passado' : `em ${MESES[mes]}`
  return P(primeiroDia(ano, mes), ultimoDia(ano, mes), label, 'month', hoje)
}

/** Mês corrente, mas terminando HOJE — é o que "este mês" significa numa pergunta. */
export function currentMonthToDate(hoje = todayISO()): QueryPeriod {
  return P(`${hoje.slice(0, 7)}-01`, hoje, 'este mês', 'month', hoje)
}

/** Período imediatamente anterior, do mesmo tamanho. É o "comparado com o anterior". */
export function previousPeriod(p: QueryPeriod): QueryPeriod {
  if (p.grain === 'month') {
    const d = fromISO(p.from)
    const ant = new Date(d.getFullYear(), d.getMonth() - 1, 1)
    const ano = ant.getFullYear()
    const mes = ant.getMonth()
    // "Este mês" vai do dia 1 até hoje: o comparável é o MESMO pedaço do mês
    // anterior, não o mês inteiro — senão 15 dias perdem para 31 por construção.
    const mesPrincipalCompleto = p.to === ultimoDia(d.getFullYear(), d.getMonth())
    const diaFim = mesPrincipalCompleto ? 31 : fromISO(p.to).getDate()
    const fimReal = fromISO(ultimoDia(ano, mes)).getDate()
    const to = `${primeiroDia(ano, mes).slice(0, 8)}${String(Math.min(diaFim, fimReal)).padStart(2, '0')}`
    return { from: primeiroDia(ano, mes), to, label: `em ${MESES[mes]}`, grain: 'month' }
  }
  if (p.grain === 'year') {
    const ano = Number(p.from.slice(0, 4)) - 1
    return { from: `${ano}-01-01`, to: `${ano}-12-31`, label: `em ${ano}`, grain: 'year' }
  }
  const dias = Math.round((fromISO(p.to).getTime() - fromISO(p.from).getTime()) / 86400000) + 1
  const to = addDays(p.from, -1)
  return { from: addDays(to, -(dias - 1)), to, label: 'no período anterior', grain: p.grain }
}

const NUM_PALAVRA = new Map<string, number>(Object.entries({
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15,
  vinte: 20, trinta: 30, sessenta: 60, noventa: 90,
}))

const FUTURO_NA_FRASE = /\b(?:vou|vai|vamos|irei|ira|proxim[oa]s?|daqui|que\s+vem|faltam?|restam?|vence|vencem|parcelas?|prestac)/
const PASSADO_NA_FRASE = /\b(?:foi|foram|gastei|gastou|recebi|recebeu|ganhei|ganhou|paguei|pagou|fiz|fez|faturei|lucrei|guardei|entrou|entraram|saiu|sairam|tive|teve|rendeu|veio|vieram|torrei)\b/
/** Preposições que marcam JANELA ("em 90 dias", "nos 3 meses"): exigem verbo no passado. */
const PREPOSICAO_DE_JANELA = new Set(['em', 'no', 'nos', 'do', 'dos', 'durante'])
/** Preposições que marcam DURAÇÃO ou ponto no tempo, nunca janela até hoje. */
const PREPOSICAO_DE_DURACAO = new Set(['por', 'a', 'cada', 'de', 'pra', 'para', 'ha', 'faz', 'ate', 'com', 'x', 'daqui', 'dentro', 'mais', 'menos'])

const lerNumero = (s: string): number => {
  const n = parseInt(s, 10)
  if (Number.isFinite(n)) return n
  return NUM_PALAVRA.get(semAcento(s)) ?? NaN
}

/**
 * Extrai o período que a frase descreve.
 *
 * Devolve `null` quando não há expressão de período reconhecível — nunca um
 * palpite. `matched` traz o trecho literal, para a resposta poder citar de volta
 * exatamente o que o usuário disse.
 *
 * `span` existe quando `matched` é um RÓTULO ("este mês") e não o trecho: o
 * texto normalizado diz "esse mes", e quem consumia o rótulo não tirava nada da
 * frase — "no Zé esse mês" virava a busca pelo texto "ze esse".
 */
export function parsePeriod(input: string, hoje = todayISO()): { period: QueryPeriod; matched: string; span?: string } | null {
  const t = semAcento(input)
  const ano = fromISO(hoje).getFullYear()
  const mesAtual = fromISO(hoje).getMonth()

  // --- intervalo por mês: "desde março", "de março até junho" -----------
  // Precisa vir antes do mês isolado. Caso contrário, "desde março" virava
  // somente março e "de março até junho" ignorava silenciosamente a metade
  // final da janela.
  const mesesFechados = t.match(new RegExp(String.raw`\bde\s+(${MES_RE})(?:\s+de\s+(20\d{2}))?\s+(?:a|ate)\s+(${MES_RE})(?:\s+de\s+(20\d{2}))?\b`))
  if (mesesFechados) {
    const mi1 = mesIndex(mesesFechados[1])
    const mi2 = mesIndex(mesesFechados[3])
    if (mi1 >= 0 && mi2 >= 0) {
      let y2 = mesesFechados[4] ? Number(mesesFechados[4]) : ano
      // Um fim ainda futuro, sem ano dito, descreve o intervalo passado mais
      // recente; já um intervalo que cruza dezembro recebe anos consecutivos.
      if (!mesesFechados[4] && mi2 > mesAtual) y2--
      const y1 = mesesFechados[2] ? Number(mesesFechados[2]) : (mi1 <= mi2 ? y2 : y2 - 1)
      const from = primeiroDia(y1, mi1)
      const to = ultimoDia(y2, mi2)
      if (from <= to) return {
        period: P(from, to, `de ${MESES[mi1]} a ${MESES[mi2]}`, 'range', hoje),
        matched: mesesFechados[0],
      }
    }
  }
  const desdeMes = t.match(new RegExp(String.raw`\bdesde\s+(${MES_RE})(?:\s+de\s+(20\d{2}))?\b`))
  if (desdeMes) {
    const mi = mesIndex(desdeMes[1])
    if (mi >= 0) {
      const y = desdeMes[2] ? Number(desdeMes[2]) : (mi <= mesAtual ? ano : ano - 1)
      return {
        period: P(primeiroDia(y, mi), hoje, `desde ${MESES[mi]}`, 'range', hoje),
        matched: desdeMes[0],
      }
    }
  }

  // --- intervalo explícito: "de 01/07 a 15/07", "entre 1/8 e 20/8" ----------
  const intervalo = t.match(/\b(?:de|entre)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\s+(?:a|ate|e)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/)
  if (intervalo) {
    const y1 = intervalo[3] ? normalizaAno(intervalo[3]) : ano
    const y2 = intervalo[6] ? normalizaAno(intervalo[6]) : y1
    const from = iso(y1, Number(intervalo[2]) - 1, Number(intervalo[1]))
    const to = iso(y2, Number(intervalo[5]) - 1, Number(intervalo[4]))
    if (from && to && from <= to) {
      return { period: P(from, to, `de ${br(from)} a ${br(to)}`, 'range', hoje), matched: intervalo[0] }
    }
  }

  // --- "últimos N dias/semanas/meses/anos" ---------------------------------
  const ultimos = t.match(/\b(?:nos?\s+)?(?:ultim[oa]s?|passad[oa]s?)\s+(\d{1,4}|[a-z]+)\s+(dias?|semanas?|mes(?:es)?|anos?)\b/)
    || t.match(/\b(\d{1,4})\s+(dias?|semanas?|mes(?:es)?|anos?)\s+(?:atras|pra\s+ca|para\s+ca)\b/)
  if (ultimos) {
    const n = lerNumero(ultimos[1])
    const unidade = ultimos[2]
    if (Number.isFinite(n) && n > 0) {
      const { from, label, grain } = janelaRelativa(n, unidade, hoje)
      return { period: P(from, hoje, label, grain, hoje), matched: ultimos[0] }
    }
  }

  // --- a mesma janela dita sem "últimos": "obra 3 meses quanto" -------------
  // e "qual foi meu maior gasto em 90 dias". Lida como PASSADO só quando nada na
  // frase aponta para o futuro. Depois de preposição, só com verbo no passado:
  // "quanto vou gastar em 3 meses" é projeção, e "por 3 meses" é duração.
  const solto = t.match(/(?:^|\s)(?:([a-z]+)\s+)?(\d{1,3})\s+(dias|semanas|meses|anos)\b(?!\s+(?:atras|pra\s+ca|para\s+ca|que\s+vem))/)
  if (solto && !FUTURO_NA_FRASE.test(t)) {
    const antes = solto[1] || ''
    const n = Number(solto[2])
    const aceita = PREPOSICAO_DE_JANELA.has(antes) ? PASSADO_NA_FRASE.test(t) : !PREPOSICAO_DE_DURACAO.has(antes)
    if (aceita && n > 0) {
      const { from, label, grain } = janelaRelativa(n, solto[3], hoje)
      // Só o número e a unidade são o período: a palavra de antes ("obra") é o
      // assunto da pergunta e não pode ser consumida junto.
      return { period: P(from, hoje, label, grain, hoje), matched: `${solto[2]} ${solto[3]}` }
    }
  }

  // --- "este/esse mês", "mês passado", "mês retrasado" ---------------------
  {
    const m = t.match(/\bmes\s+retrasado\b|\bretrasado\b.*\bmes\b/)
    if (m) return { period: monthPeriod(hoje, 2, hoje), matched: 'mês retrasado', span: m[0] }
  }
  {
    const m = t.match(/\bmes\s+(?:passado|anterior)\b/)
    if (m) return { period: monthPeriod(hoje, 1, hoje), matched: 'mês passado', span: m[0] }
  }
  const queVem = t.match(/\b(?:mes\s+que\s+vem|proximo\s+mes)\b/)
  if (queVem) {
    const d = new Date(fromISO(hoje).getFullYear(), fromISO(hoje).getMonth() + 1, 1)
    return {
      period: P(primeiroDia(d.getFullYear(), d.getMonth()), ultimoDia(d.getFullYear(), d.getMonth()),
        'no mês que vem', 'month', hoje),
      matched: 'mês que vem',
      span: queVem[0],
    }
  }
  {
    // "Desse/deste mês" é "de + esse": sem a contração, "de obra desse mês"
    // buscava o texto "obra desse" e respondia que não havia lançamento.
    const m = t.match(/\b(?:d?est[ea]|d?ess[ea]|ness?[ea]|nest[ea])\s+mes\b|\bdo\s+mes\b|\bno\s+mes\b(?!\s+de)|\bmes\s+atual\b/)
    if (m) return { period: currentMonthToDate(hoje), matched: 'este mês', span: m[0] }
  }

  // --- semana --------------------------------------------------------------
  {
    const m = t.match(/\bsemana\s+retrasada\b/)
    if (m) return { period: P(addDays(hoje, -20), addDays(hoje, -14), 'na semana retrasada', 'week', hoje), matched: 'semana retrasada', span: m[0] }
  }
  {
    const m = t.match(/\bsemana\s+(?:passada|anterior)\b/)
    if (m) return { period: P(addDays(hoje, -13), addDays(hoje, -7), 'na semana passada', 'week', hoje), matched: 'semana passada', span: m[0] }
  }
  {
    const m = t.match(/\bsemana\s+que\s+vem\b|\bproxima\s+semana\b/)
    if (m) return { period: P(addDays(hoje, 1), addDays(hoje, 7), 'na semana que vem', 'week', hoje), matched: 'semana que vem', span: m[0] }
  }
  {
    const m = t.match(/\b(?:d?est[ea]|d?ess[ea]|ness?[ea]|nest[ea])\s+semana\b|\bda\s+semana\b|\bna\s+semana\b/)
    if (m) return { period: P(addDays(hoje, -6), hoje, 'nos últimos 7 dias', 'week', hoje), matched: 'esta semana', span: m[0] }
  }

  // --- ano -----------------------------------------------------------------
  {
    const m = t.match(/\bano\s+passado\b/)
    if (m) return { period: P(`${ano - 1}-01-01`, `${ano - 1}-12-31`, `em ${ano - 1}`, 'year', hoje), matched: 'ano passado', span: m[0] }
  }
  {
    const m = t.match(/\b(?:d?est[ea]|d?ess[ea]|ness?[ea]|nest[ea])\s+ano\b|\bano\s+atual\b|\b(?:no|do)\s+ano\b/)
    if (m) return { period: P(`${ano}-01-01`, hoje, 'neste ano', 'year', hoje), matched: 'este ano', span: m[0] }
  }
  const anoExplicito = t.match(/\bem\s+(20\d{2})\b/)
  if (anoExplicito) {
    const y = Number(anoExplicito[1])
    return { period: P(`${y}-01-01`, `${y}-12-31`, `em ${y}`, 'year', hoje), matched: anoExplicito[0] }
  }

  // --- dia único -----------------------------------------------------------
  if (/\banteontem\b/.test(t)) return { period: P(addDays(hoje, -2), addDays(hoje, -2), 'anteontem', 'day', hoje), matched: 'anteontem' }
  if (/\bontem\b/.test(t)) return { period: P(addDays(hoje, -1), addDays(hoje, -1), 'ontem', 'day', hoje), matched: 'ontem' }
  if (/\bhoje\b|\bhj\b/.test(t)) return { period: P(hoje, hoje, 'hoje', 'day', hoje), matched: 'hoje' }

  // --- mês pelo NOME: "em outubro", "de agosto", "outubro de 2025" ---------
  const mesNome = t.match(new RegExp(String.raw`\b(?:em|n[oa]|de|do)?\s*(${MES_RE})\b(?:\s+de\s+(20\d{2}))?`))
  if (mesNome) {
    const mi = mesIndex(mesNome[1])
    if (mi >= 0) {
      const anoAlvo = mesNome[2]
        ? Number(mesNome[2])
        // Sem ano, a leitura é o mês MAIS PRÓXIMO no passado: quem pergunta
        // "quanto gastei em outubro" em agosto fala de outubro do ano passado.
        // Projeção é outra coisa e usa `source: 'projections'`, onde o mês
        // futuro é o correto — por isso o desempate fica com quem chama.
        : (mi <= mesAtual ? ano : ano - 1)
      return {
        period: P(primeiroDia(anoAlvo, mi), ultimoDia(anoAlvo, mi),
          `em ${MESES[mi]}${mesNome[2] ? ` de ${anoAlvo}` : ''}`, 'month', hoje),
        matched: mesNome[0].trim(),
      }
    }
  }

  return null
}

/**
 * O mesmo mês pelo nome, mas lido para o FUTURO — usado por projeção
 * ("em qual dos próximos meses eu tenho mais parcelas", "e em outubro?").
 */
export function parseFutureMonth(input: string, hoje = todayISO()): QueryPeriod | null {
  const t = semAcento(input)
  const m = t.match(new RegExp(String.raw`\b(${MES_RE})\b(?:\s+de\s+(20\d{2}))?`))
  if (!m) return null
  const mi = mesIndex(m[1])
  if (mi < 0) return null
  const ano = fromISO(hoje).getFullYear()
  const mesAtual = fromISO(hoje).getMonth()
  const anoAlvo = m[2] ? Number(m[2]) : (mi >= mesAtual ? ano : ano + 1)
  return P(primeiroDia(anoAlvo, mi), ultimoDia(anoAlvo, mi), `em ${MESES[mi]}`, 'month', hoje)
}

/**
 * Mês solto que `parsePeriod` jogou para o ano anterior por estar à frente no
 * calendário ("dezembro", dito em outubro), relido para o que VEM quando a
 * pergunta é de fatura ou parcela e não tem verbo no passado. Fatura e parcela
 * vencem no futuro; lidas no passado, a resposta era "R$ 0,00" de um mês
 * anterior a qualquer parcelamento. `null` quando a leitura original fica.
 */
export function mesAFrente(lido: { period: QueryPeriod; matched: string }, texto: string, hoje = todayISO()): QueryPeriod | null {
  if (lido.period.grain !== 'month' || /\b20\d{2}\b/.test(lido.matched)) return null
  const t = semAcento(texto)
  if (PASSADO_NA_FRASE.test(t)) return null
  // Mês já passado neste ano ("janeiro", em outubro) só vira o próximo com o
  // futuro dito: "quanto vence em janeiro". Sem verbo, segue o que já houve.
  const anoAnterior = Number(lido.period.from.slice(0, 4)) < fromISO(hoje).getFullYear()
  const passouComFuturoDito = lido.period.to < hoje && /\b(?:vou|vai|vamos|vao|irei|ira|vence|vencem|vencer)\b/.test(t)
  if (!anoAnterior && !passouComFuturoDito) return null
  return parseFutureMonth(lido.matched, hoje)
}

/** Janela "próximos N meses", para projeção. */
export function nextMonths(n: number, hoje = todayISO()): QueryPeriod {
  const d = fromISO(hoje)
  const fim = new Date(d.getFullYear(), d.getMonth() + Math.max(1, n), 0)
  return P(`${hoje.slice(0, 7)}-01`, toISO(fim), n === 1 ? 'neste mês' : `nos próximos ${n} meses`, 'month', hoje)
}

function janelaRelativa(n: number, unidade: string, hoje: string): { from: string; label: string; grain: PeriodGrain } {
  if (/^dias?$/.test(unidade)) {
    return { from: addDays(hoje, -(n - 1)), label: `nos últimos ${n} dias`, grain: 'day' }
  }
  if (/^semanas?$/.test(unidade)) {
    return { from: addDays(hoje, -(n * 7 - 1)), label: `nas últimas ${n} semanas`, grain: 'week' }
  }
  if (/^anos?$/.test(unidade)) {
    const d = fromISO(hoje)
    return { from: toISO(new Date(d.getFullYear() - n, d.getMonth(), d.getDate() + 1)), label: `nos últimos ${n} anos`, grain: 'year' }
  }
  // meses: conta a partir do primeiro dia do mês que começa a janela, porque é
  // assim que a pessoa pensa — "últimos 3 meses" inclui o mês inteiro de trás.
  const d = fromISO(hoje)
  const inicio = new Date(d.getFullYear(), d.getMonth() - (n - 1), 1)
  return {
    from: toISO(inicio),
    label: n === 1 ? 'neste mês' : `nos últimos ${n} meses`,
    grain: 'month',
  }
}

const normalizaAno = (s: string): number => {
  const n = Number(s)
  return s.length <= 2 ? 2000 + n : n
}

const iso = (ano: number, mes: number, dia: number): string | null => {
  if (mes < 0 || mes > 11 || dia < 1 || dia > 31) return null
  const d = new Date(ano, mes, dia)
  if (d.getDate() !== dia || d.getMonth() !== mes) return null
  return toISO(d)
}

const br = (isoDate: string) => fromISO(isoDate).toLocaleDateString('pt-BR')

export { MESES, monthKey }
