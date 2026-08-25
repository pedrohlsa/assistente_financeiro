// COMPOSIÇÃO DETERMINÍSTICA da resposta a partir dos FATOS.
//
// Separado do executor de propósito: interpretar, executar e redigir são três
// coisas, e misturá-las é como `resolveLocal()` acabou com 700 linhas onde a
// conta e a frase nasciam juntas — cada frase nova exigia refazer a conta.
//
// O que vale para todo texto daqui:
//   · nenhum número é inventado: tudo vem de `AssistantFact`;
//   · previsão é sempre dita como previsão;
//   · sem base, o texto DIZ que não há base e o que registrar (regra 43);
//   · sem markdown decorativo, sem repetir a pergunta, sem parecer formulário.

import { fmtBRL, fmtNum, fromISO } from '../../utils/format'
import type { AssistantQueryResult, FactUnit, QueryGroupResult } from './types'

const brDate = (iso: string) => fromISO(iso).toLocaleDateString('pt-BR')

/** Formata um número na unidade do resultado. Dinheiro é dinheiro; km é km. */
export function formatValue(v: number, unit: FactUnit): string {
  switch (unit) {
    case 'count': return fmtNum(v, 0)
    case 'pct': return `${fmtNum(v, 1)}%`
    case 'km': return `${fmtNum(v, 0)} km`
    case 'hours': return `${fmtNum(v, 1)}h`
    case 'liters': return `${fmtNum(v, 1)} L`
    case 'per-km': return `${fmtBRL(v)}/km`
    case 'per-hour': return `${fmtBRL(v)}/hora`
    case 'per-trip': return `${fmtBRL(v)} por viagem`
    case 'per-day': return `${fmtBRL(v)} por dia`
    default: return fmtBRL(v)
  }
}

const plural = (n: number, um: string, muitos: string) => (n === 1 ? um : muitos)

/** "3 lançamentos entre 01/08 e 20/08" — a amostra vai junto com o número. */
function amostra(r: AssistantQueryResult): string {
  const n = r.count
  if (!n) return ''
  const nome = r.plan.source === 'installments' ? plural(n, 'parcela', 'parcelas')
    : r.plan.source === 'invoices' ? plural(n, 'fatura', 'faturas')
      : r.plan.source === 'work' ? plural(n, 'dia registrado', 'dias registrados')
        : r.plan.source === 'goals' ? plural(n, 'meta', 'metas')
          : r.plan.source === 'plans' ? plural(n, 'parcelamento', 'parcelamentos')
            : plural(n, 'lançamento', 'lançamentos')
  if (r.sample.from === r.sample.to) return `${n} ${nome} em ${brDate(r.sample.from)}`
  return `${n} ${nome} entre ${brDate(r.sample.from)} e ${brDate(r.sample.to)}`
}

const FONTE_VAZIA: Record<string, string> = {
  transactions: 'Não tenho nenhum lançamento que se encaixe nisso',
  recurring: 'Não tenho nenhuma conta ou entrada fixa cadastrada para esse período',
  installments: 'Não tenho parcelas vencendo nesse período',
  invoices: 'Não tenho faturas nesse período',
  plans: 'Você não tem parcelamentos em aberto',
  goals: 'Você ainda não tem metas de compra cadastradas',
  work: 'Não tenho dias de trabalho registrados nesse período',
  fuel: 'Não tenho abastecimentos registrados nesse período',
  maintenance: 'Não tenho manutenções registradas nesse período',
  projections: 'Não tenho obrigações cadastradas para projetar esses meses',
}

const COMO_REGISTRAR: Record<string, string> = {
  transactions: 'Assim que você registrar, eu respondo com os seus números.',
  recurring: 'Cadastre em Planejamento que eu passo a acompanhar.',
  installments: 'Cadastre em Mais → Cartões e parcelamentos.',
  invoices: 'Cadastre um cartão em Mais → Cartões e parcelamentos.',
  plans: 'Cadastre em Mais → Cartões e parcelamentos.',
  goals: 'Diga algo como "quero juntar 5000 para uma moto" que eu crio a meta.',
  work: 'Diga "rodei 120 km e fiz 14 viagens" que eu passo a calcular.',
  fuel: 'Diga "botei 100 de gasolina" que eu passo a calcular.',
  maintenance: 'Diga "troquei o óleo por 280 com 84 mil km".',
  projections: 'Cadastre suas contas fixas em Planejamento.',
}

/**
 * Texto da resposta. Sempre em cima dos fatos que o executor produziu — nenhum
 * número nasce aqui.
 *
 * A primeira linha responde à PERGUNTA, não ao cálculo. "Qual categoria
 * aumentou mais?" começava pelo total do período — que naquele mês tinha
 * CAÍDO. A resposta estava aritmeticamente certa e contradizia a pergunta logo
 * na primeira linha; quem lê para de ler ali.
 */
export function composeAnswer(r: AssistantQueryResult): string {
  const p = r.plan
  const periodo = p.period.label

  if (r.empty) {
    const base = FONTE_VAZIA[p.source] || 'Não tenho dados para isso'
    const alvo = p.filter.text ? ` com "${p.filter.text}"` : ''
    return `${base}${alvo} ${periodo}. ${COMO_REGISTRAR[p.source] || ''}`.trim()
  }

  const linhas: string[] = []
  const selo = r.estimated ? ' (previsão)' : ' (dado real)'
  const top = r.groups[0]
  const rankeado = p.group !== 'none' && !!top
    && (p.order === 'delta-desc' || p.order === 'delta-asc' || p.order === 'count-desc'
      || p.order === 'value-desc' || p.order === 'value-asc')

  if (rankeado && top) {
    // A resposta é o PRIMEIRO colocado, dito por extenso.
    linhas.push(`${respostaDeRanking(r, top)}${selo}.`)
    const resto = r.groups.slice(1, p.group === 'weekday' ? 7 : 5)
    if (resto.length) {
      linhas.push(['Depois:', ...resto.map(g => `• ${g.label}: ${formatValue(g.value, r.unit)}${sufixoGrupo(g, r)}`)].join('\n'))
    }
  } else {
    linhas.push(`${cabecalho(r)}: ${formatValue(r.total, r.unit)}${selo}.`)
    if (p.group !== 'none' && r.groups.length) {
      const mostra = r.groups.slice(0, p.group === 'weekday' ? 7 : 5)
      linhas.push(mostra.map(g => `• ${g.label}: ${formatValue(g.value, r.unit)}${sufixoGrupo(g, r)}`).join('\n'))
      if (r.groups.length > mostra.length) {
        linhas.push(`E mais ${r.groups.length - mostra.length} ${plural(r.groups.length - mostra.length, 'item', 'itens')}.`)
      }
    }
  }

  // ---- comparação do TOTAL ----------------------------------------------
  if (r.compareTotal !== undefined && p.comparePeriod && !rankeado) {
    const antes = formatValue(r.compareTotal, r.unit)
    const d = r.delta || 0
    const direcao = d > 0 ? 'a mais' : 'a menos'
    const pct = r.deltaPct !== undefined && r.deltaPct !== 0 ? ` (${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%)` : ''
    linhas.push(d === 0
      ? `${maiuscula(p.comparePeriod.label)} foi exatamente o mesmo valor.`
      : `${maiuscula(p.comparePeriod.label)} foram ${antes} — ${formatValue(Math.abs(d), r.unit)} ${direcao}${pct}.`)
  }

  // ---- amostra e ressalvas ----------------------------------------------
  const am = amostra(r)
  if (am && p.group === 'none') linhas.push(`Base: ${am}.`)
  for (const c of r.caveats) linhas.push(c)

  return linhas.join('\n\n')
}

/** A frase que responde direto quem ficou em primeiro. */
function respostaDeRanking(r: AssistantQueryResult, top: QueryGroupResult): string {
  const p = r.plan
  const valor = formatValue(top.value, r.unit)
  if (p.order === 'delta-desc' && top.delta !== undefined) {
    return top.delta > 0
      ? `${top.label} foi o que mais subiu: ${formatValue(top.delta, r.unit)} a mais, indo para ${valor}`
      : `Nada subiu — ${top.label} foi o que menos caiu (${formatValue(top.delta, r.unit)}), ficando em ${valor}`
  }
  if (p.order === 'delta-asc' && top.delta !== undefined) {
    return top.delta < 0
      ? `${top.label} foi o que mais caiu: ${formatValue(Math.abs(top.delta), r.unit)} a menos, ficando em ${valor}`
      : `Nada caiu — ${top.label} foi o que menos subiu (+${formatValue(top.delta, r.unit)}), chegando a ${valor}`
  }
  if (p.order === 'count-desc') {
    return `${top.label}, ${top.count} ${plural(top.count, 'vez', 'vezes')} ${p.period.label}`
  }
  const posicao = p.order === 'value-asc' ? 'menor' : 'maior'
  switch (p.group) {
    case 'month': return `O ${posicao} foi ${top.label}, com ${valor}`
    case 'week': return `A ${posicao} foi a ${top.label}, com ${valor}`
    case 'day': return `O ${posicao} foi ${top.label}, com ${valor}`
    case 'weekday': return `${maiuscula(top.label)}, com ${valor}`
    case 'description': return `Foi ${top.label}, de ${valor}`
    case 'card': return `${top.label}, com ${valor}`
    case 'goal': return `${top.label} — ${valor}`
    case 'plan': return `${top.label} — falta ${valor}`
    case 'month-half': return `${maiuscula(top.label)}, com ${valor}`
    default: return `${top.label}, com ${valor} ${p.period.label}`
  }
}

function sufixoGrupo(g: QueryGroupResult, r: AssistantQueryResult): string {
  if (g.delta === undefined) return ''
  if (g.delta === 0) return ' (igual)'
  const sinal = g.delta > 0 ? '+' : '−'
  return ` (${sinal}${formatValue(Math.abs(g.delta), r.unit)})`
}

function cabecalho(r: AssistantQueryResult): string {
  const p = r.plan
  const nome = p.label || 'Total'
  if (p.group === 'none') {
    return `${nome} ${p.period.label}`.replace(/\s+/g, ' ').trim()
  }
  switch (p.group) {
    case 'category': return `${nome} por categoria`
    case 'month': return `${nome} por mês`
    case 'week': return `${nome} por semana`
    case 'day': return `${nome} por dia`
    case 'weekday': return `${nome} por dia da semana`
    case 'card': return `${nome} por cartão`
    case 'origin': return `${nome} por origem`
    case 'goal': return 'Suas metas'
    case 'plan': return 'Seus parcelamentos'
    case 'platform': return `${nome} por plataforma`
    default: return nome
  }
}

const maiuscula = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * "Como você chegou nisso?" — a metodologia REAL, saída da proveniência dos
 * fatos. Nunca uma metodologia inventada (regra da fase 15).
 */
export function explainQueryResult(r: AssistantQueryResult): string {
  const p = r.plan
  const partes: string[] = []
  const oQue: Record<string, string> = {
    transactions: 'seus lançamentos', recurring: 'suas contas e entradas fixas',
    installments: 'suas parcelas', invoices: 'suas faturas', plans: 'seus parcelamentos',
    goals: 'suas metas', work: 'seus turnos', fuel: 'seus abastecimentos',
    maintenance: 'suas manutenções', projections: 'a projeção dos próximos meses',
  }
  const conta: Record<string, string> = {
    sum: 'Somei', count: 'Contei', avg: 'Tirei a média de', median: 'Peguei a mediana de',
    min: 'Peguei o menor de', max: 'Peguei o maior de', net: 'Subtraí as saídas das entradas de',
    share: 'Calculei a proporção sobre', 'per-day': 'Dividi pelos dias de',
    'per-km': 'Dividi pelos km de', 'per-hour': 'Dividi pelas horas de',
    'per-trip': 'Dividi pelas viagens de',
  }

  partes.push(`${conta[p.metric] || 'Calculei sobre'} ${r.count} ${plural(r.count, 'registro', 'registros')} `
    + `de ${oQue[p.source] || p.source}, ${p.period.label} (${brDate(p.period.from)} a ${brDate(p.period.to)}).`)

  const filtros: string[] = []
  if (p.filter.txType?.length) filtros.push(p.filter.txType.map(nomeTipo).join(' e '))
  if (p.filter.categories?.length) filtros.push(`só a categoria pedida`)
  if (p.filter.excludeCategories?.length) filtros.push('tirando a categoria que você excluiu')
  if (p.filter.text) filtros.push(`só o que menciona "${p.filter.text}"`)
  if (p.filter.excludeText) filtros.push(`tirando "${p.filter.excludeText}"`)
  if (p.filter.origin) filtros.push(`só a origem "${p.filter.origin}"`)
  if (p.filter.cardNames?.length) filtros.push(`só ${p.filter.cardNames.join(', ')}`)
  if (p.filter.excludeCardNames?.length) filtros.push(`sem ${p.filter.excludeCardNames.join(', ')}`)
  if (p.filter.weekdays?.length === 2) filtros.push('só fim de semana')
  if (p.filter.monthHalf) filtros.push(p.filter.monthHalf === 'first' ? 'só a primeira metade do mês' : 'só a segunda metade do mês')
  if (filtros.length) partes.push(`Filtros: ${filtros.join('; ')}.`)

  if (p.comparePeriod) {
    partes.push(`Comparei com ${p.comparePeriod.label} (${brDate(p.comparePeriod.from)} a ${brDate(p.comparePeriod.to)}).`)
  }

  if (r.samples.length && r.count <= 6) {
    partes.push(`Os valores: ${r.samples.map(s => fmtBRL(s.value)).join(', ')}.`)
  }
  for (const c of r.caveats) partes.push(c)
  return partes.join('\n\n')
}

const nomeTipo = (t: string): string =>
  t === 'income' ? 'entradas' : t === 'expense' ? 'saídas'
    : t === 'saving' ? 'transferências para a reserva' : 'entradas financiadas'
