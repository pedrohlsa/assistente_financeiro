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

import { addDays, fmtBRL, fmtNum, fromISO, toISO } from '../../utils/format'
import type { AssistantQueryPlan, AssistantQueryResult, FactUnit, QueryGroupResult } from './types'

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

/** Uma linha por fatura com a situação dela e o que falta, quando falta. */
function situacaoDaFatura(row: AssistantQueryResult['samples'][number]): string {
  const data = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
  const falta = typeof row.extra?.pending === 'number' ? row.extra.pending : 0
  // O vencimento identifica a fatura: com várias, "Nubank: paga" se repetia.
  const quem = `• ${row.cardName ? `${row.cardName} ` : ''}(vencimento ${data(row.date)}): `
  switch (row.status) {
    case 'atrasada': return `${quem}atrasada, falta ${fmtBRL(falta)}.`
    case 'fechada': return `${quem}fechada, a pagar.`
    case 'parcial': return `${quem}paga em parte, falta ${fmtBRL(falta)}.`
    case 'paga': return `${quem}paga.`
    case 'aberta': return `${quem}ainda aberta; o valor pode crescer até fechar.`
    default: return ''
  }
}

/** Agrupamentos por tempo: singular, plural e gênero ("dos meses", "das semanas"). */
const TEMPO: Partial<Record<AssistantQueryPlan['group'], { um: string; varios: string; feminino: boolean }>> = {
  month: { um: 'mês', varios: 'meses', feminino: false },
  week: { um: 'semana', varios: 'semanas', feminino: true },
  day: { um: 'dia', varios: 'dias', feminino: false },
}

/** O intervalo de datas de um grupo de tempo, pela chave que o motor gera. */
function intervaloDoGrupo(group: AssistantQueryPlan['group'], key: string): [string, string] {
  if (group === 'month') {
    const [y, m] = key.split('-').map(Number)
    return [`${key}-01`, toISO(new Date(y, m, 0))]
  }
  if (group === 'week') return [key, addDays(key, 6)]
  return [key, key]
}

/**
 * Soma agrupada por mês, semana ou dia. "Total recebido por mês: R$ 18.000,00"
 * lia como 18 mil POR MÊS — eram 3 mil em seis meses. A lista vem primeiro, a
 * soma depois com o nome do que soma, e a média só dos períodos inteiros. O
 * corte, quando há, deixa de fora os mais ANTIGOS: "E mais 1 item" escondia o
 * mês atual. Período cortado pelo recorte é dito na própria linha.
 */
function linhasPorTempo(r: AssistantQueryResult, selo: string): string[] {
  const p = r.plan
  const t = TEMPO[p.group]!
  const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  const recorte = (g: QueryGroupResult): string => {
    const [ini, fim] = intervaloDoGrupo(p.group, g.key)
    if (ini < p.period.from) return ` (desde ${diaMes(p.period.from)})`
    if (fim > p.period.to) return ` (até ${diaMes(p.period.to)})`
    return ''
  }
  const limite = p.group === 'month' ? 12 : p.group === 'week' ? 8 : 10
  const mostra = r.groups.slice(-limite)
  const out = [[`${cabecalho(r)}${selo}:`, ...mostra.map(g => `• ${g.label}${recorte(g)}: ${formatValue(g.value, r.unit)}${sufixoGrupo(g, r)}`)].join('\n')]
  const antes = r.groups.length - mostra.length
  if (antes > 0) out.push(`E mais ${antes} ${plural(antes, t.um, t.varios)} antes.`)
  const inteiros = r.groups.filter(g => !recorte(g))
  const media = inteiros.length > 1 ? inteiros.reduce((a, g) => a + g.value, 0) / inteiros.length : undefined
  const fora = r.groups.length - inteiros.length
  const [o, os, incompleto] = t.feminino ? ['a', 'as', 'incompleta'] : ['o', 'os', 'incompleto']
  const semIncompletos = fora === 1 ? ` (sem ${o} ${t.um} ${incompleto})` : fora > 1 ? ` (sem ${os} ${fora} ${incompleto}s)` : ''
  out.push(`Soma d${os} ${r.groups.length} ${t.varios}: ${formatValue(r.total, r.unit)}`
    + (media !== undefined ? ` · média de ${formatValue(Math.round(media * 100) / 100, r.unit)} por ${t.um}${semIncompletos}` : '')
    + '.')
  return out
}

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
/**
 * "Meu custo por km piorou?" é pergunta de sim ou não (regra 57): a resposta
 * começa por "Sim" ou "Não" e só depois mostra os números. Vazio quando a
 * pergunta não é de sim ou não, ou quando não houve comparação.
 *
 * "Piorou" muda de sentido com a medida: gasto que SOBE piorou; receita ou
 * resultado que CAI piorou. Recebe o texto já sem acento e em minúsculas.
 */
export function leadSimNao(t: string, plan: AssistantQueryPlan, total: number, compareTotal?: number, topDelta?: number): string {
  // "Tem alguma coisa que eu tô gastando mais que antes?" responde com o
  // ranking do que subiu — e começa dizendo se algo subiu.
  if (plan.group !== 'none' && plan.order === 'delta-desc' && topDelta !== undefined
    && /\btem\s+(?:alguma\s+coisa|algo|alguma|algum)\b/.test(t)) return topDelta > 0 ? 'Sim. ' : 'Não. '
  if (compareTotal === undefined || plan.group !== 'none' || !plan.comparePeriod) return ''
  if (/^\s*(?:e\s+)?(?:qual|quais|quanto|quanta|quantos|quantas|quando|onde|como|por\s*que|pq)\b/.test(t)) return ''
  if (!/\?\s*$|^\s*(?:e\s+)?(?:eu\s+)?(?:estou|esta|ando|to|tou|meu|minha|gastei|ganhei|fiz|recebi)\b/.test(t)) return ''
  const pior = /\b(?:piorou|pioraram|pior)\b/.test(t)
  const melhor = /\b(?:melhorou|melhoraram|melhor)\b/.test(t)
  const sobe = /\b(?:aumentou|aumentaram|subiu|subiram|cresceu|mais\s+(?:do\s+)?que)\b|\b(?:fora|acima)\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:padrao|normal|comum|costume|media)\b/.test(t)
  const desce = /\b(?:caiu|cairam|diminuiu|diminuiram|desceu|baixou|menos\s+(?:do\s+)?que)\b/.test(t)
  if ([pior, melhor, sobe, desce].filter(Boolean).length !== 1) return ''
  const d = Math.round((total - compareTotal) * 100) / 100
  if (d === 0) return 'Não, ficou igual. '
  const custo = plan.metric !== 'net' && plan.filter.txType?.length === 1 && plan.filter.txType[0] === 'expense'
  const piorou = custo ? d > 0 : d < 0
  if (pior || melhor) {
    const sim = pior ? piorou : !piorou
    return `${sim ? 'Sim' : 'Não'}, ${piorou ? 'piorou' : 'melhorou'}. `
  }
  const sim = sobe ? d > 0 : d < 0
  return `${sim ? 'Sim' : 'Não'}, ${d > 0 ? 'subiu' : 'caiu'}. `
}

export function composeAnswer(r: AssistantQueryResult): string {
  const p = r.plan
  const periodo = p.period.label

  if (r.empty) {
    if (p.source === 'goals' && p.field === 'saved' && r.caveats.length) return r.caveats.join('\n\n')
    if (p.source === 'recurring' && p.filter.plannedOnly && p.filter.txType?.[0] === 'income') {
      return `Não há entradas recorrentes previstas em aberto ${periodo}. Cadastre as entradas em Planejamento para eu calcular essa previsão.`
    }
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
    const empate = empateNoTopo(r)
    if (empate) linhas.push(empate)
    // Em "o que mais subiu", o resto da lista também SUBIU: listar quem caiu
    // embaixo de "foi o que mais subiu" responde outra pergunta.
    const mesmoSentido = (g: QueryGroupResult) => p.order === 'delta-desc' ? (g.delta ?? 0) > 0
      : p.order === 'delta-asc' ? (g.delta ?? 0) < 0 : true
    const resto = r.groups.slice(1).filter(mesmoSentido).slice(0, p.group === 'weekday' ? 6 : 4)
    if (resto.length) {
      linhas.push(['Depois:', ...resto.map(g => `• ${g.label}: ${formatValue(g.value, r.unit)}${sufixoGrupo(g, r)}`)].join('\n'))
    }
  } else if (TEMPO[p.group] && (p.metric === 'sum' || p.metric === 'net') && r.groups.length > 1) {
    linhas.push(...linhasPorTempo(r, selo))
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
    const direcao = d > 0 ? 'acima' : 'abaixo'
    const pct = r.deltaPct !== undefined && r.deltaPct !== 0 ? ` (${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%)` : ''
    // Sem lançamento no período comparado, "R$ 0,00 … acima" não compara nada.
    // E o período principal tem nome: "o período principal ficou" era jargão.
    linhas.push(r.compareCount === 0
      ? `${maiuscula(p.comparePeriod.label)} não há lançamentos para comparar.`
      : d === 0
        ? `${maiuscula(p.comparePeriod.label)} foi exatamente o mesmo valor.`
        : `${maiuscula(p.comparePeriod.label)}: ${antes}. ${maiuscula(p.period.label)} ficou ${formatValue(Math.abs(d), r.unit)} ${direcao}${pct}.`)
  }

  // ---- situação das faturas ---------------------------------------------
  // "(dado real)" numa fatura atrasada se lia como paga. Cada fatura diz onde
  // está: aberta, fechada a pagar, atrasada, paga em parte ou paga.
  if (p.source === 'invoices' && p.group === 'none') {
    const situacoes = r.samples.filter(row => row.value > 0.005).map(situacaoDaFatura).filter(Boolean)
    if (situacoes.length) linhas.push(situacoes.join('\n'))
  }

  // ---- amostra e ressalvas ----------------------------------------------
  const am = amostra(r)
  if (am && p.group === 'none') linhas.push(`Base: ${am}.`)
  for (const c of r.caveats) linhas.push(c)

  return linhas.join('\n\n')
}

/** A frase que responde direto quem ficou em primeiro. */
/**
 * O primeiro colocado ganhou de verdade, ou empatou?
 *
 * "Qual dia da semana eu faturo mais?" respondia "Sábado, com R$ 2.945,00" —
 * e a sexta tinha R$ 2.935,00, dez reais atrás, com as mesmas 12 ocorrências.
 * Coroar o sábado ali é apresentar cara-ou-coroa como conclusão, e um
 * motorista pode reorganizar a semana por causa disso. É a mesma classe de
 * defeito que a regra 43 nomeia: separação sem significado dita como achado.
 *
 * O limiar é RELATIVO (2%) porque a distância que importa depende da escala:
 * dez reais entre dois mil é empate, dez reais entre trinta não é.
 */
export const MARGEM_EMPATE = 0.02

function empateNoTopo(r: AssistantQueryResult): string | null {
  const [a, b] = r.groups
  if (!a || !b) return null
  // Só vale para ranking por VALOR. Em delta e contagem a leitura é outra.
  if (r.plan.order !== 'value-desc' && r.plan.order !== 'value-asc') return null
  const escala = Math.max(Math.abs(a.value), Math.abs(b.value))
  if (!escala) return null
  if (Math.abs(a.value - b.value) / escala > MARGEM_EMPATE) return null
  const juntos = r.groups.filter(g => Math.abs(g.value - a.value) / escala <= MARGEM_EMPATE)
  const nomes = juntos.map(g => g.label).join(', ')
  return juntos.length > 2
    ? `Mas é praticamente empate: ${nomes} ficam a menos de ${Math.round(MARGEM_EMPATE * 100)}% um do outro.`
    : `Mas é praticamente empate com ${b.label} (${formatValue(b.value, r.unit)}) — a diferença é de ${formatValue(Math.abs(a.value - b.value), r.unit)}.`
}

function respostaDeRanking(r: AssistantQueryResult, top: QueryGroupResult): string {
  const p = r.plan
  const valor = formatValue(top.value, r.unit)
  // "Subiu" sem dizer em relação a quê não deixa conferir: o período de
  // comparação vai junto.
  const contra = p.comparePeriod ? ` comparado com ${p.comparePeriod.label
    .replace(/^em\s+/, '').replace(/^n([oa]s?)\s+/, '$1 ')}` : ''
  if (p.order === 'delta-desc' && top.delta !== undefined) {
    return top.delta > 0
      ? `${top.label} foi o que mais subiu${contra}: ${formatValue(top.delta, r.unit)} a mais, indo para ${valor}`
      : `Nada subiu${contra} — ${top.label} foi o que menos caiu (${formatValue(top.delta, r.unit)}), ficando em ${valor}`
  }
  if (p.order === 'delta-asc' && top.delta !== undefined) {
    return top.delta < 0
      ? `${top.label} foi o que mais caiu${contra}: ${formatValue(Math.abs(top.delta), r.unit)} a menos, ficando em ${valor}`
      : `Nada caiu${contra} — ${top.label} foi o que menos subiu (+${formatValue(top.delta, r.unit)}), chegando a ${valor}`
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
  // O cartão precisa aparecer no cabeçalho. Sem ele, a pergunta sobre o Nubank
  // e a pergunta seguinte sobre o Inter devolviam a MESMA frase — dois números
  // iguais por coincidência, sem nada dizendo qual era qual.
  const cartao = p.group !== 'card' && p.filter.cardNames?.length === 1
    ? ` do ${p.filter.cardNames[0]}` : ''
  // Mesma razão para a meta: "Metas até agora: R$ 1.200,00" não diz de QUAL
  // meta faltam mil e duzentos. Aqui o rótulo é REESCRITO, não emendado —
  // "Metas Viagem" é a informação certa em português errado.
  if (p.group !== 'goal' && p.filter.goalName) {
    const verbo = p.field === 'pct' ? 'Progresso da meta'
      : p.field === 'remaining' ? 'Falta para a meta'
        : p.field === 'saved' ? 'Já guardado na meta' : 'Meta'
    return `${verbo} ${p.filter.goalName}`
  }
  const nome = `${p.label || 'Total'}${cartao}`
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
  if (p.filter.origins?.length) filtros.push(`só as origens ${p.filter.origins.join(', ')}`)
  if (p.filter.cardNames?.length) filtros.push(`só ${p.filter.cardNames.join(', ')}`)
  if (p.filter.excludeCardNames?.length) filtros.push(`sem ${p.filter.excludeCardNames.join(', ')}`)
  if (p.filter.weekdays?.length === 2) filtros.push('só fim de semana')
  if (p.filter.monthHalf) filtros.push(p.filter.monthHalf === 'first' ? 'só a primeira metade do mês' : 'só a segunda metade do mês')
  if (filtros.length) partes.push(`Filtros: ${filtros.join('; ')}.`)

  if (p.comparePeriod) {
    partes.push(`Comparei com ${p.comparePeriod.label} (${brDate(p.comparePeriod.from)} a ${brDate(p.comparePeriod.to)}).`)
  }

  if (r.samples.length && r.count <= 6) {
    const campo = p.field || 'amount'
    partes.push(`Os valores: ${r.samples.map(s => fmtBRL(campo === 'amount' ? s.value : s.extra?.[campo] ?? s.value)).join(', ')}.`)
  }
  for (const c of r.caveats) partes.push(c)
  return partes.join('\n\n')
}

const nomeTipo = (t: string): string =>
  t === 'income' ? 'entradas' : t === 'expense' ? 'saídas'
    : t === 'saving' ? 'transferências para a reserva' : 'entradas financiadas'
