// CANONICALIZAÇÃO E COMPARAÇÃO SEMÂNTICA.
//
// Dois planos podem pedir exatamente a mesma consulta com JSON diferente:
// filtros em outra ordem, `order` omitido quando o executor já ordenaria igual,
// `limit` num plano sem agrupamento. Isso não pode reprovar um modelo.
//
// O que NÃO se flexibiliza, em lugar nenhum deste arquivo: valor, data,
// exclusão, tipo, origem, cartão, categoria e modalidade. Filtro que o gabarito
// não lista tem que vir AUSENTE; período só casa com um dos intervalos
// declarados, ao dia.
//
// Duas medidas saem daqui, e são deliberadamente diferentes:
//   · EXATO     — o plano validado é idêntico, campo a campo, à leitura
//                 primária do gabarito (ordem de lista e `order` literais);
//   · SEMÂNTICO — o plano bate com ALGUMA leitura aceita, pelas regras acima.

import type { AppState, ParsedAction } from '../../../src/models/types'
import { isQueryFailure, validateQueryPlan } from '../../../src/assistant/query/validate'
import { FIELDS_BY_SOURCE } from '../../../src/assistant/query/types'
import type { AssistantQueryPlan, QueryPeriod } from '../../../src/assistant/query/types'
import { addDays } from '../../../src/utils/format'
import { normalizeName } from '../../../src/utils/text'
import type { AcaoOuro, Esperado, FiltroOuro, Intervalo, OuroCenario, OuroPlano, PeriodoOuro, PlanoOuro } from './types'

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

const vazio = (x: any): boolean =>
  x === undefined || x === null || x === '' || x === false || (Array.isArray(x) && x.length === 0)

const especial = (e: any): e is { umDe: any[] } | { ausente: true } | { qualquer: true } =>
  !!e && typeof e === 'object' && !Array.isArray(e) && ('umDe' in e || 'ausente' in e || 'qualquer' in e)

export const igualExato = (a: any, b: any): boolean => a === b
export const igualTexto = (a: any, b: any): boolean =>
  typeof a === 'string' && typeof b === 'string' && normalizeName(a) === normalizeName(b)
export const igualNumero = (a: any, b: any): boolean =>
  Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005
const igualConjunto = (elem: (a: any, b: any) => boolean) => (a: any, b: any): boolean => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const ua = a.filter((x, i) => a.findIndex(y => elem(x, y)) === i)
  const ub = b.filter((x, i) => b.findIndex(y => elem(x, y)) === i)
  return ua.length === ub.length && ua.every(x => ub.some(y => elem(x, y)))
}

/** `undefined` no gabarito = o campo tem que vir ausente. Não existe "não conferido" implícito. */
export function confere<T>(esperado: Esperado<T> | undefined, obtido: any, igual: (a: any, b: any) => boolean): boolean {
  if (esperado === undefined) return vazio(obtido)
  if (especial(esperado)) {
    if ('qualquer' in esperado) return true
    if ('ausente' in esperado) return vazio(obtido)
    return esperado.umDe.some(v => (v === null ? vazio(obtido) : igual(v, obtido)))
  }
  return igual(esperado, obtido)
}

/** Primeira opção de um esperado — é assim que se monta a leitura primária do gabarito. */
function primeiro<T>(e: Esperado<T> | undefined): T | undefined {
  if (e === undefined || !especial(e)) return e as T | undefined
  if ('umDe' in e) return (e.umDe[0] ?? undefined) as T | undefined
  return undefined
}

const estavel = (v: any): string => {
  if (Array.isArray(v)) return `[${v.map(estavel).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${estavel(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** Datas relativas no gabarito de AÇÃO: '@hoje', '@ontem', '@anteontem'. */
export function resolveData(v: any, hoje: string): any {
  if (v === '@hoje') return hoje
  if (v === '@ontem') return addDays(hoje, -1)
  if (v === '@anteontem') return addDays(hoje, -2)
  return v
}

// ---------------------------------------------------------------------------
// Plano de consulta
// ---------------------------------------------------------------------------

/** A ordem que o EXECUTOR aplica de fato (espelho de `runQuery`). */
export function ordemEfetiva(p: AssistantQueryPlan): string {
  const pedida = p.order
  if ((pedida === 'delta-desc' || pedida === 'delta-asc') && !p.comparePeriod) return 'value-desc'
  if (pedida) return pedida
  if (p.group === 'none') return 'value-desc'
  return p.group === 'month' || p.group === 'day' || p.group === 'week' ? 'date-asc' : 'value-desc'
}

function confereIntervalo(o: PeriodoOuro, obtido: QueryPeriod, hoje: string, referencia?: QueryPeriod): boolean {
  if ('qualquer' in o) return true
  if ('exatos' in o) return o.exatos(hoje).some(i => i.from === obtido.from && i.to === obtido.to)
  // 'recente': a frase não diz o período. Principal: termina nos últimos 31 dias
  // e não olha mais de 13 meses para trás. Comparação: termina ANTES do
  // principal começar, com no máximo 31 dias de intervalo entre os dois.
  if (!referencia) return obtido.to >= addDays(hoje, -31) && obtido.from >= addDays(hoje, -400)
  return obtido.to < referencia.from && obtido.to >= addDays(referencia.from, -31)
}

const CHAVES_FILTRO: [keyof FiltroOuro, (a: any, b: any) => boolean][] = [
  ['txType', igualConjunto(igualExato)],
  ['categories', igualConjunto(igualExato)],
  ['excludeCategories', igualConjunto(igualExato)],
  ['text', igualTexto],
  ['excludeText', igualTexto],
  ['origin', igualTexto],
  ['cardNames', igualConjunto(igualTexto)],
  ['excludeCardNames', igualConjunto(igualTexto)],
  ['goalName', igualTexto],
  ['platform', igualTexto],
  ['weekdays', igualConjunto(igualNumero)],
  ['monthHalf', igualExato],
  ['minAmount', igualNumero],
  ['maxAmount', igualNumero],
  ['status', igualConjunto(igualExato)],
  ['realizedOnly', igualExato],
  ['plannedOnly', igualExato],
]

/** Divergências entre UMA leitura aceita e o plano validado. Lista vazia = casou. */
export function divergencias(o: PlanoOuro, p: AssistantQueryPlan, hoje: string): string[] {
  const d: string[] = []
  if (!confere(o.source, p.source, igualExato)) d.push(`source=${p.source}`)
  const campoPadrao = FIELDS_BY_SOURCE[p.source]?.[0]
  if (o.field === undefined ? p.field !== campoPadrao : !confere(o.field, p.field, igualExato)) d.push(`field=${p.field}`)
  if (o.metric === undefined ? p.metric !== 'sum' : !confere(o.metric, p.metric, igualExato)) d.push(`metric=${p.metric}`)
  if (o.group === undefined ? p.group !== 'none' : !confere(o.group, p.group, igualExato)) d.push(`group=${p.group}`)
  if (p.group !== 'none') {
    const padrao = p.group === 'month' || p.group === 'day' || p.group === 'week' ? 'date-asc' : 'value-desc'
    const efetiva = ordemEfetiva(p)
    if (o.order === undefined ? efetiva !== padrao : !confere(o.order, efetiva, igualExato)) d.push(`order=${efetiva}`)
    if (o.limit !== undefined && !confere(o.limit, p.limit, igualNumero)) d.push(`limit=${p.limit}`)
  }
  if (p.metric === 'share' && o.shareBase !== undefined && !confere(o.shareBase, p.shareBase, igualExato)) {
    d.push(`shareBase=${p.shareBase}`)
  }
  if (!confereIntervalo(o.periodo, p.period, hoje)) d.push(`period=${p.period.from}..${p.period.to}`)
  if (o.comparacao === undefined) {
    if (p.comparePeriod) d.push(`comparePeriod=${p.comparePeriod.from}..${p.comparePeriod.to} (não pedida)`)
  } else if ('presente' in o.comparacao) {
    if (!p.comparePeriod) d.push('comparePeriod ausente')
  } else if (!p.comparePeriod || !confereIntervalo(o.comparacao, p.comparePeriod, hoje, p.period)) {
    d.push(`comparePeriod=${p.comparePeriod ? `${p.comparePeriod.from}..${p.comparePeriod.to}` : 'ausente'}`)
  }
  const f: any = p.filter || {}
  for (const [chave, igual] of CHAVES_FILTRO) {
    if (!confere((o.filtro as any)[chave], f[chave], igual)) d.push(`filter.${chave}=${JSON.stringify(f[chave])}`)
  }
  if (!vazio(f.profileAtCreation)) d.push('filter.profileAtCreation (não pedido)')
  return d
}

/** Leitura primária do gabarito, como plano CRU — oráculo do autoteste e base do acerto exato. */
export function planoDoOuro(o: PlanoOuro, hoje: string): any {
  const intervalo = (po: PeriodoOuro | undefined, ref?: Intervalo): Intervalo | undefined => {
    if (!po) return undefined
    if ('exatos' in po) return po.exatos(hoje)[0]
    if (ref) {
      // Mesmo pedaço do mês anterior — a leitura que o app faz de "comparado com antes".
      const d = new Date(`${ref.from}T00:00:00`)
      const ini = new Date(d.getFullYear(), d.getMonth() - 1, 1)
      const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
      const fim = new Date(ini.getFullYear(), ini.getMonth() + 1, 0)
      const diaFim = Math.min(Number(ref.to.slice(8, 10)), fim.getDate())
      return { from: iso(ini), to: `${iso(ini).slice(0, 8)}${String(diaFim).padStart(2, '0')}` }
    }
    return { from: `${hoje.slice(0, 7)}-01`, to: hoje }
  }
  const period = intervalo(o.periodo)!
  const comparePeriod = o.comparacao === undefined ? undefined
    : 'presente' in o.comparacao ? intervalo({ regra: 'recente' }, period)
      : intervalo(o.comparacao, period)
  const filter: any = {}
  for (const [chave] of CHAVES_FILTRO) {
    const v = primeiro((o.filtro as any)[chave])
    if (v !== undefined) filter[chave] = v
  }
  return {
    version: 2,
    source: primeiro(o.source),
    field: primeiro(o.field),
    metric: primeiro(o.metric),
    group: primeiro(o.group),
    order: primeiro(o.order),
    limit: primeiro(o.limit),
    shareBase: primeiro(o.shareBase),
    period: { ...period, label: 'gabarito', grain: 'range' },
    comparePeriod: comparePeriod ? { ...comparePeriod, label: 'gabarito', grain: 'range' } : undefined,
    filter,
  }
}

const formaExata = (p: AssistantQueryPlan): string => estavel({
  source: p.source, field: p.field, metric: p.metric, group: p.group, order: p.order,
  limit: p.group === 'none' ? undefined : p.limit, shareBase: p.shareBase,
  period: { from: p.period.from, to: p.period.to },
  comparePeriod: p.comparePeriod ? { from: p.comparePeriod.from, to: p.comparePeriod.to } : undefined,
  filter: Object.fromEntries(Object.entries(p.filter || {}).filter(([, v]) => !vazio(v))),
})

export interface ComparacaoPlano {
  nenhum: boolean
  valido: boolean
  codigo?: string
  exato: boolean
  semantico: boolean
  divergencias: string[]
}

export function comparaPlano(ouro: OuroPlano, bruto: any, state: AppState, hoje: string): ComparacaoPlano {
  const nenhum = !!bruto && typeof bruto === 'object' && (bruto.source === 'none' || bruto.source === null)
  if (!bruto || nenhum) {
    return {
      nenhum: true, valido: false, exato: ouro.nenhumAceito && !ouro.aceitos.length,
      semantico: ouro.nenhumAceito, divergencias: ouro.nenhumAceito ? [] : ['devolveu "none" para uma consulta expressável'],
    }
  }
  const v = validateQueryPlan(bruto, state, hoje)
  if (isQueryFailure(v)) {
    return { nenhum: false, valido: false, codigo: v.code, exato: false, semantico: false, divergencias: [`recusado: ${v.code} ${v.detail || ''}`.trim()] }
  }
  const leituras = ouro.aceitos.map(o => divergencias(o, v.plan, hoje))
  const semantico = leituras.some(l => l.length === 0)
  let exato = false
  if (ouro.aceitos.length) {
    const primario = validateQueryPlan(planoDoOuro(ouro.aceitos[0], hoje), state, hoje)
    exato = !isQueryFailure(primario) && formaExata(primario.plan) === formaExata(v.plan)
  }
  const melhor = leituras.length ? leituras.reduce((a, b) => (b.length < a.length ? b : a)) : ['nenhuma leitura aceita']
  return { nenhum: false, valido: true, exato, semantico, divergencias: semantico ? [] : melhor }
}

// ---------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------

/** Campo cujo erro numa ação aceita é PERIGO, não só imprecisão. */
export const CAMPOS_FINANCEIROS = new Set([
  'amount', 'total', 'netReceived', 'installments', 'date', 'origin', 'cardName',
  'value', 'liters', 'km', 'hours', 'trips', 'cost', 'target', 'months', 'name', 'firstDueDate',
])

const comparadorDe = (campo: string) =>
  ['amount', 'total', 'netReceived', 'installments', 'value', 'liters', 'km', 'hours', 'trips', 'cost', 'target', 'months', 'pricePerLiter', 'odometer'].includes(campo)
    ? igualNumero
    : campo === 'category' || campo === 'date' || campo === 'firstDueDate' ? igualExato
      : igualTexto

/** Data omitida numa ação é HOJE (a regra do prompt manda omitir) — só aí vazio e hoje se equivalem. */
function confereCampo(campo: string, esperado: Esperado, obtido: any, hoje: string): boolean {
  if (campo === 'date' || campo === 'firstDueDate') {
    const alvo = especial(esperado) && 'umDe' in esperado
      ? { umDe: esperado.umDe.map(x => resolveData(x, hoje)) }
      : resolveData(esperado, hoje)
    const efetivo = campo === 'date' && vazio(obtido) ? hoje : obtido
    return confere(alvo as Esperado, efetivo, igualExato)
  }
  if (campo === 'description') {
    const contem = (a: any, b: any) => typeof a === 'string' && typeof b === 'string'
      && (normalizeName(b).includes(normalizeName(a)) || normalizeName(a).includes(normalizeName(b)))
    return confere(esperado, obtido, contem)
  }
  return confere(esperado, obtido, comparadorDe(campo))
}

export interface ComparacaoAcoes {
  casadas: number
  camposCertos: number
  camposConferidos: number
  /** Ações obtidas sem par no gabarito. */
  sobras: ParsedAction[]
  faltas: AcaoOuro[]
  /** Par encontrado, mas com campo financeiro errado. */
  errosFinanceiros: string[]
}

export function comparaAcoes(ouro: AcaoOuro[], obtidas: ParsedAction[], hoje: string): ComparacaoAcoes {
  const usadas = new Set<number>()
  const out: ComparacaoAcoes = { casadas: 0, camposCertos: 0, camposConferidos: 0, sobras: [], faltas: [], errosFinanceiros: [] }
  for (const g of ouro) {
    let melhor = -1
    let melhorNota = -1
    obtidas.forEach((a, i) => {
      if (usadas.has(i) || a.kind !== g.kind) return
      const nota = Object.entries(g.campos).filter(([c, e]) => confereCampo(c, e, (a as any)[c], hoje)).length
      if (nota > melhorNota) { melhor = i; melhorNota = nota }
    })
    if (melhor < 0) { out.faltas.push(g); continue }
    usadas.add(melhor)
    const a: any = obtidas[melhor]
    let financeiroOk = true
    for (const [campo, esperado] of Object.entries(g.campos)) {
      out.camposConferidos++
      if (confereCampo(campo, esperado, a[campo], hoje)) out.camposCertos++
      else if (CAMPOS_FINANCEIROS.has(campo)) {
        financeiroOk = false
        out.errosFinanceiros.push(`${g.kind}.${campo}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(a[campo])}`)
      }
    }
    if (financeiroOk) out.casadas++
  }
  obtidas.forEach((a, i) => { if (!usadas.has(i)) out.sobras.push(a) })
  return out
}

// ---------------------------------------------------------------------------
// Cenário (contrato candidato)
// ---------------------------------------------------------------------------

const CAMPOS_FINANCEIROS_CENARIO = ['amount', 'installments', 'downPayment', 'cardName', 'origin', 'goalName', 'hoursPerDay', 'days', 'extraKm']

export interface ComparacaoCenario { correto: boolean; divergencias: string[]; inventados: string[]; valido: boolean }

/** Vale a leitura aceita que deixa MENOS valor inventado; depois, menos divergência. */
export function comparaCenario(ouro: OuroCenario, bruto: any): ComparacaoCenario {
  return [ouro.passos, ...(ouro.alternativas || [])]
    .map(p => comparaPassos(p, bruto))
    .reduce((a, b) => ((b.correto && !a.correto) || b.inventados.length < a.inventados.length
      || (b.inventados.length === a.inventados.length && b.divergencias.length < a.divergencias.length) ? b : a))
}

function comparaPassos(esperados: OuroCenario['passos'], bruto: any): ComparacaoCenario {
  const passos: any[] = Array.isArray(bruto?.steps) ? bruto.steps : []
  const valido = !!bruto && typeof bruto === 'object' && Array.isArray(bruto.steps) && passos.every(p => p && typeof p.kind === 'string')
  const divergencias: string[] = []
  const inventados: string[] = []
  if (!valido) return { correto: false, divergencias: ['sem "steps" válido'], inventados, valido }
  if (passos.length !== esperados.length) divergencias.push(`${passos.length} passo(s), esperado ${esperados.length}`)
  const ouro = { passos: esperados }
  ouro.passos.forEach((g, i) => {
    const p = passos[i]
    if (!p) return
    if (p.kind !== g.kind) { divergencias.push(`passo ${i + 1}: kind ${p.kind} ≠ ${g.kind}`); return }
    for (const [campo, esperado] of Object.entries(g.campos)) {
      const igual = typeof primeiro(esperado as any) === 'number' ? igualNumero : igualTexto
      if (!confere(esperado, p[campo], igual)) divergencias.push(`passo ${i + 1}: ${campo}=${JSON.stringify(p[campo])}`)
    }
    for (const campo of CAMPOS_FINANCEIROS_CENARIO) {
      // Campo que o gabarito não pede, ou que ele exige AUSENTE: valor ali é um
      // número que a frase não tem. Sem o segundo caso, uma entrada inventada
      // num "comprar em 10x" contava só como divergência, e não como perigo.
      const esperado: any = g.campos[campo]
      const exigeAusente = !!esperado && typeof esperado === 'object' && 'ausente' in esperado
      if ((!(campo in g.campos) || exigeAusente) && !vazio(p[campo])) inventados.push(`passo ${i + 1}: ${campo}=${JSON.stringify(p[campo])}`)
    }
  })
  passos.slice(ouro.passos.length).forEach((p, j) => {
    for (const campo of CAMPOS_FINANCEIROS_CENARIO) {
      if (!vazio(p?.[campo])) inventados.push(`passo extra ${ouro.passos.length + j + 1}: ${campo}=${JSON.stringify(p[campo])}`)
    }
  })
  return { correto: divergencias.length === 0 && inventados.length === 0, divergencias, inventados, valido }
}
