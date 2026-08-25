// GOLDEN CASES da Query DSL.
//
// Diferente do corpus de frases, aqui se afirma o RESULTADO EXATO. Um teste que
// só verifica "não quebrou" não prova nada sobre um app de dinheiro: os valores
// abaixo foram conferidos à mão contra o fixture, e é por isso que eles
// detectam um erro de período ou de filtro que uma asserção frouxa deixaria
// passar.
//
// A data é FIXA (`TODAY_Q`) e o fixture nasce dela — a consulta aceita a data
// injetada em todo o caminho, então nada aqui depende do relógio da máquina.

import type { AppState } from '../../src/models/types'
import { autonomoRico, motoristaRico, usuarioNovo } from '../fixtures/richState'
import type { QueryErrorCode } from '../../src/assistant/query/validate'

/** 15/08/2026 — meio do mês, para "este mês" ser um recorte parcial de verdade. */
export const TODAY_Q = '2026-08-15'

const autonomo = () => autonomoRico(TODAY_Q)
const motorista = () => motoristaRico(TODAY_Q)

export interface QueryCase {
  id: string
  group: string
  state: () => AppState
  message: string
  /** Campos do plano que precisam bater. Subconjunto. */
  expectPlan?: {
    source?: string
    field?: string
    metric?: string
    group?: string
    order?: string
    periodFrom?: string
    periodTo?: string
    comparePeriodFrom?: string
    filter?: Record<string, unknown>
  }
  /** Total EXATO (duas casas). */
  expectTotal?: number
  expectCount?: number
  expectEmpty?: boolean
  /** Grupos esperados, na ordem. Só os primeiros precisam bater. */
  expectGroups?: { label: string | RegExp; value?: number; delta?: number }[]
  expectReply?: (string | RegExp)[]
  forbidReply?: (string | RegExp)[]
  /** A consulta deve ser assumida pela DSL em vez do roteador antigo. */
  expectBeyondLegacy?: boolean
  /** A frase NÃO é consulta: o planner tem que devolver `null`. */
  expectNoPlan?: boolean
}

/**
 * Plano CRU + o código de recusa esperado. É o teste do vocabulário fechado:
 * fonte inventada, operador inventado, campo fora da fonte, intervalo absurdo e
 * tentativa de poluir o protótipo.
 */
export interface PlanRejectionCase {
  id: string
  state: () => AppState
  raw: any
  expectCode: QueryErrorCode
}

// ---------------------------------------------------------------------------
// Período — o defeito que originou a DSL
// ---------------------------------------------------------------------------

export const QUERY_CASES: QueryCase[] = [
  {
    id: 'q-01', group: 'periodo', state: autonomo,
    // Obra: 1430 (ago, 3 lançamentos) + 1010 (jul, 3) + 560 (jun, 2) = 3000.
    // O roteador antigo respondia isto com o total de SETE DIAS.
    message: 'quanto eu gastei em obra nos últimos 3 meses?',
    expectPlan: { source: 'transactions', metric: 'sum', group: 'none', periodFrom: '2026-06-01', periodTo: TODAY_Q },
    expectTotal: 3000, expectCount: 8, expectBeyondLegacy: true,
    expectReply: [/R\$\s*3\.000,00/, /obra/i],
  },
  {
    id: 'q-02', group: 'periodo', state: autonomo,
    message: 'quanto eu gastei em obra mês passado?',
    expectPlan: { periodFrom: '2026-07-01', periodTo: '2026-07-31' },
    expectTotal: 1010, expectCount: 3,
  },
  {
    id: 'q-03', group: 'periodo', state: autonomo,
    message: 'quanto eu gastei com obra esse mês?',
    expectPlan: { periodFrom: '2026-08-01', periodTo: TODAY_Q },
    expectTotal: 1430, expectCount: 3,
  },
  {
    id: 'q-04', group: 'periodo', state: autonomo,
    // Junho inteiro: 300 + 260 = 560.
    message: 'quanto gastei em obra em junho?',
    expectPlan: { periodFrom: '2026-06-01', periodTo: '2026-06-30' },
    expectTotal: 560, expectBeyondLegacy: true,
  },
  {
    id: 'q-05', group: 'periodo', state: autonomo,
    // Últimos 90 dias a partir de 15/08 → 18/05. Obra: 1430+1010+560 = 3000.
    message: 'quanto gastei com obra nos últimos 90 dias?',
    expectPlan: { periodFrom: '2026-05-18' },
    expectTotal: 3000, expectBeyondLegacy: true,
  },
  {
    id: 'q-06', group: 'periodo', state: autonomo,
    message: 'quanto recebi de aluguel nos últimos 6 meses?',
    // 6 meses × (1800 + 1200) = 18000.
    expectPlan: { periodFrom: '2026-03-01' },
    expectTotal: 18000, expectCount: 12, expectBeyondLegacy: true,
  },

  // -------------------------------------------------------------------------
  // Agrupamento e comparação
  // -------------------------------------------------------------------------
  {
    id: 'q-10', group: 'grupo', state: autonomo,
    // Agosto até 15: obra 1430, alimentação 200, Zé 83 (também alimentação).
    message: 'quanto gastei por categoria esse mês?',
    expectPlan: { group: 'category', metric: 'sum' },
    expectGroups: [{ label: 'Obra e construção', value: 1430 }],
    expectBeyondLegacy: true,
  },
  {
    id: 'q-11', group: 'grupo', state: autonomo,
    // Agosto (1..15) contra julho (1..15): obra +420. Alimentação 283 contra
    // 340 (só o lançamento de 09/07 cabe na janela) = −57.
    message: 'qual categoria aumentou mais comparando com mês passado?',
    expectPlan: { group: 'category', order: 'delta-desc', comparePeriodFrom: '2026-07-01' },
    expectGroups: [{ label: 'Obra e construção', value: 1430, delta: 420 }],
    expectBeyondLegacy: true,
    expectReply: [/obra/i, /mais subiu|subiu/i],
  },
  {
    id: 'q-12', group: 'grupo', state: autonomo,
    message: 'qual foi meu melhor mês?',
    expectPlan: { group: 'month', metric: 'net', order: 'value-desc' },
    expectBeyondLegacy: true,
    forbidReply: [/posso te ajudar com coisas como/i],
  },
  {
    id: 'q-13', group: 'grupo', state: autonomo,
    message: 'qual foi meu maior gasto dos últimos 90 dias?',
    expectPlan: { group: 'description', metric: 'max' },
    expectGroups: [{ label: 'Reforma do telhado', value: 2400 }],
    expectReply: [/reforma do telhado/i, /R\$\s*2\.400,00/],
  },
  {
    id: 'q-14', group: 'grupo', state: autonomo,
    message: 'quanto eu gasto em fim de semana?',
    expectPlan: { filter: { weekdays: [0, 6] } },
    expectBeyondLegacy: true,
  },
  {
    id: 'q-15', group: 'grupo', state: autonomo,
    message: 'eu gasto mais no começo ou no fim do mês?',
    expectPlan: { group: 'month-half' },
    expectBeyondLegacy: true,
  },

  // -------------------------------------------------------------------------
  // Exclusão e restrição
  // -------------------------------------------------------------------------
  {
    id: 'q-20', group: 'exclusao', state: autonomo,
    // Agosto sem obra: 200 (alimentação) + 45 + 38 (Zé) + lazer dos sábados.
    message: 'tirando obra, quanto eu gastei esse mês?',
    expectPlan: { filter: { excludeCategories: ['obra'] } },
    expectBeyondLegacy: true,
    forbidReply: [/R\$\s*1\.430,00/],
  },
  {
    id: 'q-21', group: 'exclusao', state: autonomo,
    message: 'quanto gastei esse mês sem contar alimentação?',
    expectPlan: { filter: { excludeCategories: ['alimentacao'] } },
    expectBeyondLegacy: true,
  },

  // -------------------------------------------------------------------------
  // Texto livre — o lugar com nome próprio
  // -------------------------------------------------------------------------
  {
    id: 'q-30', group: 'texto', state: autonomo,
    // 45 + 38 em agosto. NÃO pode virar o total de Alimentação (283): quem
    // pergunta por um LUGAR quer o lugar.
    message: 'quanto gastei no Zé da esquina?',
    expectPlan: { filter: { text: 'ze da esquina' } },
    expectTotal: 83, expectCount: 2,
    forbidReply: [/R\$\s*283,00/],
  },
  {
    id: 'q-31', group: 'texto', state: autonomo,
    message: 'quanto eu recebi da Casa 1 nos últimos 6 meses?',
    expectPlan: { filter: { origin: 'casa 1' } },
    expectTotal: 10800, expectCount: 6, expectBeyondLegacy: true,
  },
  {
    id: 'q-32', group: 'texto', state: autonomo,
    // 1800 de 3000 recebidos em agosto = 60%.
    message: 'quanto a Casa 1 representa da minha renda?',
    expectPlan: { metric: 'share' },
    expectTotal: 60, expectBeyondLegacy: true,
    expectReply: [/60/],
  },

  // -------------------------------------------------------------------------
  // Cartões, parcelas e metas
  // -------------------------------------------------------------------------
  {
    id: 'q-40', group: 'cartoes', state: autonomo,
    // Computador: 10x de 400, 2 pagas → falta 3200. Geladeira: 6x de 400, 1
    // paga → falta 2000. Nubank tem o computador, Inter a geladeira.
    message: 'qual cartão está mais comprometido?',
    expectPlan: { source: 'plans', group: 'card', field: 'remaining' },
    expectGroups: [{ label: 'Nubank', value: 3200 }, { label: 'Inter', value: 2000 }],
    expectBeyondLegacy: true,
  },
  {
    id: 'q-41', group: 'cartoes', state: autonomo,
    message: 'quanto ainda falta pagar de computador?',
    expectPlan: { source: 'plans', field: 'remaining' },
    expectTotal: 3200, expectBeyondLegacy: true,
  },
  {
    id: 'q-42', group: 'cartoes', state: autonomo,
    message: 'qual meta está mais perto de terminar?',
    expectPlan: { source: 'goals' },
    // Viagem: 4800/6000 = 80%. Notebook: 1200/4000 = 30%.
    expectGroups: [{ label: 'Viagem', value: 80 }],
    expectBeyondLegacy: true,
  },

  // -------------------------------------------------------------------------
  // Reserva
  // -------------------------------------------------------------------------
  {
    id: 'q-50', group: 'reserva', state: autonomo,
    // 500 (13/08) + 400 (13/07) + 300 (13/06) = 1200.
    message: 'quanto eu realmente guardei nos últimos 6 meses?',
    expectPlan: { filter: { txType: ['saving'] } },
    expectTotal: 1200, expectCount: 3, expectBeyondLegacy: true,
  },
  {
    id: 'q-51', group: 'reserva', state: autonomo,
    // 500 guardados sobre 3000 recebidos em agosto = 16,67%.
    message: 'quanto das minhas entradas eu consegui guardar?',
    expectPlan: { metric: 'share' },
    expectBeyondLegacy: true,
    expectReply: [/16,7|16,67/],
  },

  // -------------------------------------------------------------------------
  // Motorista
  // -------------------------------------------------------------------------
  {
    id: 'q-60', group: 'motorista', state: motorista,
    message: 'qual semana eu rodei mais?',
    expectPlan: { source: 'work', field: 'km', group: 'week' },
    expectBeyondLegacy: true,
    expectReply: [/km/],
  },
  {
    id: 'q-61', group: 'motorista', state: motorista,
    message: 'qual dia da semana eu faço mais?',
    expectPlan: { group: 'weekday', filter: { txType: ['income'] } },
    expectBeyondLegacy: true,
    // Sabado R$ 2.945,00 e sexta R$ 2.935,00, com 12 ocorrencias cada.
    // Coroar o sabado sozinho e apresentar cara-ou-coroa como conclusao, e um
    // motorista pode reorganizar a semana por causa disso.
    expectReply: [/praticamente empate/i, /Sexta-feira/],
  },
  {
    id: 'q-62', group: 'motorista', state: motorista,
    // Receita − despesa, dividido pelos km dos turnos.
    message: 'qual foi meu lucro por km nos últimos 30 dias?',
    expectPlan: { metric: 'per-km', filter: { txType: ['income', 'expense'] } },
    expectBeyondLegacy: true,
    expectReply: [/\/km/],
  },
  {
    id: 'q-63', group: 'motorista', state: motorista,
    message: 'uber ou 99, qual me dá mais?',
    expectPlan: { group: 'platform', filter: { txType: ['income'] } },
    expectGroups: [{ label: 'Uber' }],
  },

  // -------------------------------------------------------------------------
  // Sem dados — o app CALA
  // -------------------------------------------------------------------------
  {
    id: 'q-70', group: 'semdados', state: usuarioNovo,
    message: 'qual foi meu melhor mês?',
    expectEmpty: true,
    expectReply: [/não tenho|nao tenho/i],
    forbidReply: [/R\$\s*0,00/],
  },
  {
    id: 'q-71', group: 'semdados', state: usuarioNovo,
    message: 'quanto eu gastei em obra nos últimos 3 meses?',
    expectEmpty: true,
    forbidReply: [/R\$\s*0,00/],
  },
  {
    id: 'q-72', group: 'semdados', state: autonomo,
    message: 'quanto gastei no Restaurante do Amarelo?',
    expectEmpty: true,
    expectReply: [/amarelo/i],
  },

  // -------------------------------------------------------------------------
  // NÃO é consulta
  // -------------------------------------------------------------------------
  { id: 'q-80', group: 'naoconsulta', state: autonomo, message: 'gastei 50 no mercado', expectNoPlan: true },
  { id: 'q-81', group: 'naoconsulta', state: autonomo, message: 'se eu gastar 500 quanto sobra?', expectNoPlan: true },
  { id: 'q-82', group: 'naoconsulta', state: autonomo, message: 'oi, tudo bem?', expectNoPlan: true },
  { id: 'q-83', group: 'naoconsulta', state: autonomo, message: 'por que você colocou essa categoria?', expectNoPlan: true },
]

// ---------------------------------------------------------------------------
// Planos malformados — o vocabulário é FECHADO
// ---------------------------------------------------------------------------

const periodoOk = { from: '2026-08-01', to: TODAY_Q, label: 'este mês', grain: 'month' }

export const PLAN_REJECTIONS: PlanRejectionCase[] = [
  {
    id: 'pr-01', state: autonomo,
    raw: { version: 2, source: 'usuarios', period: periodoOk, metric: 'sum', group: 'none' },
    expectCode: 'unknown-source',
  },
  {
    id: 'pr-02', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'exfiltrar', group: 'none' },
    expectCode: 'unknown-metric',
  },
  {
    id: 'pr-03', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'sum', group: 'cpf' },
    expectCode: 'unknown-group',
  },
  {
    id: 'pr-04', state: autonomo,
    // `km` não existe em `transactions`: pedir isso é plano malformado, não um
    // zero silencioso.
    raw: { version: 2, source: 'transactions', field: 'km', period: periodoOk, metric: 'sum' },
    expectCode: 'field-not-in-source',
  },
  {
    id: 'pr-05', state: autonomo,
    raw: { version: 2, source: 'transactions', period: { from: '1000-01-01', to: '9999-12-31', label: 'tudo', grain: 'range' }, metric: 'sum' },
    expectCode: 'bad-period',
  },
  {
    id: 'pr-06', state: autonomo,
    raw: { version: 2, source: 'transactions', period: { from: '2016-01-01', to: TODAY_Q, label: 'muito', grain: 'range' }, metric: 'sum' },
    expectCode: 'period-too-long',
  },
  {
    id: 'pr-07', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'sum', filter: { categories: ['nao-existe'] } },
    expectCode: 'category-not-found',
  },
  {
    id: 'pr-08', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'sum', filter: { cardNames: ['Banco Fantasma'] } },
    expectCode: 'card-not-found',
  },
  {
    id: 'pr-09', state: autonomo,
    raw: { version: 3, source: 'transactions', period: periodoOk, metric: 'sum' },
    expectCode: 'bad-version',
  },
  {
    id: 'pr-10', state: autonomo,
    // Perfil não motorista não tem turno de trabalho (regra 3 do CLAUDE.md).
    raw: { version: 2, source: 'work', field: 'km', period: periodoOk, metric: 'sum' },
    expectCode: 'profile-forbidden',
  },
  {
    id: 'pr-11', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'sum', filter: { realizedOnly: true, plannedOnly: true } },
    expectCode: 'bad-filter',
  },
  {
    id: 'pr-12', state: autonomo,
    // `net` só existe onde há entrada E saída.
    raw: { version: 2, source: 'goals', period: periodoOk, metric: 'net' },
    expectCode: 'metric-not-applicable',
  },
  {
    id: 'pr-13', state: autonomo,
    raw: 'DROP TABLE transactions',
    expectCode: 'not-object',
  },
  {
    id: 'pr-14', state: autonomo,
    raw: { version: 2, source: 'transactions', period: periodoOk, metric: 'sum', order: 'eval(fetch)' },
    expectCode: 'unknown-order',
  },
]

/**
 * Poluição de protótipo, num teste próprio: o JSON tem que ser PARSEADO com a
 * chave perigosa presente, e um literal de objeto no TypeScript não produz isso
 * — `{ '__proto__': {...} }` define o protótipo em vez de criar a chave.
 */
export const PROTOTYPE_ATTACKS: string[] = [
  '{"version":2,"source":"transactions","metric":"sum","__proto__":{"polluted":true}}',
  '{"version":2,"source":"transactions","metric":"sum","filter":{"__proto__":{"polluted":true}}}',
  '{"version":2,"source":"transactions","metric":"sum","constructor":{"prototype":{"x":1}}}',
]
