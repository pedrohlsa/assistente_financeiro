// GOLDEN CASES do motor de cenários.
//
// A asserção mais importante aqui não é sobre o texto: é que o ESTADO não muda.
// A comparação é byte a byte (JSON antes × JSON depois) — a única prova real de
// que uma simulação não escreveu nada. Um cenário que grava é o pior defeito
// possível desta camada, porque o usuário não pediu registro nenhum.
//
// CUIDADO (regra 35 do CLAUDE.md): `monthlyProjections`, `currentBalance` e
// `monthStats` leem o RELÓGIO REAL, não uma data injetada. Por isso os fixtures
// daqui nascem de `todayISO()`, e nenhuma asserção depende de um mês específico.

import type { AppState } from '../../src/models/types'
import { autonomoRico, motoristaRico, usuarioNovo } from '../fixtures/richState'
import { todayISO } from '../../src/utils/format'

const HOJE = todayISO()

const autonomo = () => autonomoRico(HOJE)
const motorista = () => motoristaRico(HOJE)

export interface ScenarioCase {
  id: string
  group: string
  state: () => AppState
  /** Uma ou mais mensagens, na ordem — cobre o refino ("e em 12x?"). */
  messages: string[]
  expectKind?: string
  expectPlan?: Record<string, unknown>
  /** Fatos que precisam existir, com valor exato. */
  expectFacts?: { label: string | RegExp; value?: number }[]
  expectReply?: (string | RegExp)[]
  forbidReply?: (string | RegExp)[]
  expectEmpty?: boolean
  /** A frase NÃO é cenário: o planner tem que devolver `null`. */
  expectNoPlan?: boolean
}

export const SCENARIO_CASES: ScenarioCase[] = [
  // ----- gasto avulso ------------------------------------------------------
  {
    id: 'c-01', group: 'gasto', state: autonomo,
    messages: ['se eu gastar 500 agora quanto sobra?'],
    expectKind: 'spend', expectPlan: { amount: 500 },
    expectFacts: [{ label: 'Saldo hoje' }, { label: 'Saldo depois do gasto' }],
    expectReply: [/simula[çc][ãa]o/i, /nada foi registrado/i],
  },
  {
    id: 'c-02', group: 'gasto', state: autonomo,
    messages: ['se eu gastar mais 300 em obra, quanto sobra?'],
    expectKind: 'spend', expectPlan: { amount: 300, category: 'obra' },
  },
  {
    id: 'c-03', group: 'gasto', state: usuarioNovo,
    messages: ['se eu gastar 500 agora quanto sobra?'],
    expectKind: 'spend',
    // Sem saldo informado e sem conta cadastrada, o texto NÃO pode falar de
    // "contas que vêm aí" — elas não existem.
    forbidReply: [/contas que v[êe]m a[íi]/i],
  },

  // ----- compra parcelada --------------------------------------------------
  {
    id: 'c-10', group: 'compra', state: autonomo,
    messages: ['se eu comprar um pc de 4000 em 10x no nubank quanto sobra?'],
    expectKind: 'purchase',
    expectPlan: { amount: 4000, installments: 10, cardName: 'Nubank' },
    expectFacts: [{ label: 'Valor da compra', value: 4000 }, { label: 'Parcela em 10x', value: 400 }],
    expectReply: [/R\$\s*400,00/, /nada foi registrado/i],
  },
  {
    id: 'c-11', group: 'compra', state: autonomo,
    messages: ['se eu comprar um pc de 4000 em 10x', 'e em 12'],
    expectKind: 'purchase',
    expectPlan: { amount: 4000, installments: 12 },
    expectFacts: [{ label: 'Parcela em 12x', value: 333.33 }],
  },
  {
    id: 'c-12', group: 'compra', state: autonomo,
    messages: ['se eu comprar um pc de 4000 em 10x', 'e dando mil de entrada'],
    expectKind: 'purchase',
    expectPlan: { amount: 4000, installments: 10, downPayment: 1000 },
    // 4000 − 1000 = 3000 financiados em 10x = 300.
    expectFacts: [{ label: 'Valor financiado', value: 3000 }, { label: 'Parcela em 10x', value: 300 }],
  },
  {
    id: 'c-13', group: 'compra', state: autonomo,
    messages: ['se eu comprar um pc de 4000 em 10x', 'e se for 3500', 'agora em 5x'],
    expectKind: 'purchase',
    expectPlan: { amount: 3500, installments: 5 },
    expectFacts: [{ label: 'Parcela em 5x', value: 700 }],
  },
  {
    id: 'c-14', group: 'compra', state: autonomo,
    // Valor que não divide exato: a última parcela absorve a diferença, e o
    // texto DIZ isso. Falar só da primeira é a metade da verdade.
    messages: ['se eu comprar uma tv de 2500 em 6x'],
    expectReply: [/n[ãa]o s[ãa]o todas iguais/i],
  },
  {
    id: 'c-15', group: 'compra', state: autonomo,
    messages: ['se eu comprar um pc de 4000 em 10x', 'e em 12', 'volta pro cenário anterior'],
    expectKind: 'purchase',
    expectPlan: { installments: 10 },
  },

  // ----- guardar -----------------------------------------------------------
  {
    id: 'c-20', group: 'guardar', state: autonomo,
    // Notebook: falta 2800. Guardando 500/mês → 6 meses.
    messages: ['se eu guardar 500 por mês quando bato minha meta?'],
    expectKind: 'save',
    expectFacts: [{ label: /Falta para a meta/, value: 2800 }, { label: 'Meses até bater a meta', value: 6 }],
  },
  {
    id: 'c-21', group: 'guardar', state: usuarioNovo,
    messages: ['se eu guardar 500 por mês quando bato minha meta?'],
    expectKind: 'save',
    expectReply: [/n[ãa]o tem meta/i],
  },

  // ----- fatura ------------------------------------------------------------
  {
    id: 'c-30', group: 'fatura', state: autonomo,
    // Dois cartões e nenhum citado: PERGUNTA em vez de escolher.
    messages: ['se eu pagar a fatura inteira hoje, quanto fica meu saldo?'],
    expectKind: 'pay-invoice', expectEmpty: true,
    expectReply: [/qual/i, /nubank/i, /inter/i],
  },
  {
    id: 'c-31', group: 'fatura', state: autonomo,
    messages: ['se eu pagar a fatura do nubank hoje, quanto fica meu saldo?'],
    expectKind: 'pay-invoice', expectPlan: { cardName: 'Nubank' },
    expectReply: [/n[ãa]o entra como despesa nova/i],
  },

  // ----- entrada que não vem ----------------------------------------------
  {
    id: 'c-40', group: 'entrada', state: autonomo,
    // O "1" de "Casa 1" é parte do NOME, não um valor: sem essa separação a
    // entrada média saía como R$ 1,00.
    messages: ['se a Casa 1 não pagar este mês, ainda cubro minhas contas?'],
    expectKind: 'income-missing', expectPlan: { origin: 'casa 1' },
    expectFacts: [{ label: /Entrada m[ée]dia/, value: 1800 }],
    forbidReply: [/R\$\s*1,00/],
  },

  // ----- motorista ---------------------------------------------------------
  {
    id: 'c-50', group: 'motorista', state: motorista,
    messages: ['se eu trabalhar mais 3 horas por dia nessa média, quanto faria?'],
    expectKind: 'extra-work', expectPlan: { hoursPerDay: 3, days: 30 },
    expectReply: [/ritmo/i, /estimativa/i],
  },
  {
    id: 'c-51', group: 'motorista', state: motorista,
    messages: ['e se eu rodar mais 80km'],
    expectKind: 'extra-work', expectPlan: { extraKm: 80 },
  },
  {
    id: 'c-52', group: 'motorista', state: usuarioNovo,
    // Perfil CLT: a simulação de motorista não existe, e o app NÃO pode citar
    // km, hora na rua nem nada de veículo (regra 3 do CLAUDE.md).
    messages: ['se eu trabalhar mais 3 horas por dia quanto faria?'],
    expectNoPlan: true,
  },

  // ----- não é cenário -----------------------------------------------------
  { id: 'c-60', group: 'naocenario', state: autonomo, messages: ['gastei 50 no mercado'], expectNoPlan: true },
  { id: 'c-61', group: 'naocenario', state: autonomo, messages: ['quanto gastei esse mês?'], expectNoPlan: true },
  { id: 'c-62', group: 'naocenario', state: autonomo, messages: ['oi'], expectNoPlan: true },
]
