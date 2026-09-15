// ROTEAMENTO LOCAL × REMOTO — frases que o motor local respondia ERRADO e, por
// responder, nunca deixava o modelo remoto participar.
//
// Três classes, todas encontradas pela pré-checagem de rotas da avaliação dos
// modelos remotos (docs/AI_REMOTE_EVAL.md §10), antes de qualquer chamada paga:
//
//   1. número de PERÍODO lido como dinheiro: "nos ultimo 3 mes" virava uma
//      despesa de R$ 3,00;
//   2. depósito em META lido como despesa: "coloquei 200 na meta";
//   3. MAGNITUDE perdida: "tv de 3 mil" era simulada como R$ 3,00.
//
// Cada caso foi visto vermelho antes da correção correspondente.

import type { AssistantCase } from './harness'

/** Valor em reais como a tela escreve: `fmtBRL` usa espaço inseparável depois do R$. */
const R = (v: string) => new RegExp(`R\\$\\s?${v.replace(/\./g, '\\.')}(?!\\d)`)

const OBRA_TRES_MESES = {
  profile: 'autonomo' as const,
  transactions: [
    { type: 'expense', amount: 300, category: 'obra', description: 'Cimento', date: '2026-05-02' },
    { type: 'expense', amount: 500, category: 'obra', description: 'Areia', date: '2026-06-10' },
    { type: 'expense', amount: 200, category: 'obra', description: 'Tijolo', date: '2026-07-01' },
    // Fora da janela de 3 meses: se aparecer no total, o período está errado.
    { type: 'expense', amount: 4000, category: 'obra', description: 'Telhado', date: '2026-02-10' },
    { type: 'expense', amount: 90, category: 'alimentacao', description: 'Mercado', date: '2026-07-10' },
  ],
}

const DUAS_METAS = [{ name: 'Celular', target: 2500, saved: 900 }, { name: 'Viagem', target: 5000, saved: 1000 }]

export const ROTEAMENTO: AssistantCase[] = [
  // ---- 1. número de período nunca é valor --------------------------------
  {
    id: 'rt-01', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['qnto q foi d obra msm nos ultimo 3 mes'],
    expectNoActions: true, expectMode: 'answer',
    expectReply: [/obra/i, /3 meses/i, R('1.000,00')], forbidReply: [R('3,00'), R('5.000,00')],
  },
  {
    id: 'rt-02', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['qnt q foi d obra nos ultimos 3 meses'],
    expectNoActions: true, expectMode: 'answer',
    expectReply: [/obra/i, R('1.000,00')], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-03', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['quanto foi de obra nos últimos tres meses'],
    expectNoActions: true, expectMode: 'answer',
    expectReply: [/obra/i, R('1.000,00')],
  },
  {
    id: 'rt-04', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['obra últimos 3 meses deu quanto'],
    expectNoActions: true,
    expectReply: [/obra/i, R('1.000,00')], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-05', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['obra 3 meses quanto'],
    expectNoActions: true,
    expectReply: [/obra/i, R('1.000,00')], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-06', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['quanto gastei nos últimos 3 meses'],
    expectNoActions: true, expectReply: [/3 meses/i], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-07', group: 'roteamento', state: OBRA_TRES_MESES,
    // Nos últimos 7 dias o maior gasto seria o Mercado de R$ 90; nos 90 dias é a
    // Areia de R$ 500. O valor prova qual janela foi usada.
    messages: ['qual foi meu maior gasto em 90 dias'],
    expectNoActions: true, expectReply: [/areia/i, R('500,00')], forbidReply: [/7 dias/i, /mercado, de/i],
  },
  {
    id: 'rt-08', group: 'roteamento', state: OBRA_TRES_MESES,
    messages: ['quanto de obra nos últimos 6 meses'],
    expectNoActions: true, expectReply: [/obra/i, /6 meses/i], forbidReply: [R('6,00')],
  },

  // ---- 2. depósito em meta nunca vira despesa ----------------------------
  {
    id: 'rt-10', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['coloquei 200 na meta'],
    expectNoActions: true, expectMode: 'clarify', expectClarification: /meta/i,
    forbidReply: [/despesa/i],
  },
  {
    id: 'rt-11', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['botei 200 na meta'],
    expectNoActions: true, expectMode: 'clarify', expectClarification: /meta/i,
    forbidReply: [/despesa/i],
  },
  {
    id: 'rt-12', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['joguei 200 pra meta'],
    expectNoActions: true, expectMode: 'clarify', expectClarification: /meta/i,
  },
  {
    id: 'rt-13', group: 'roteamento', state: { profile: 'other', goals: [{ name: 'Moto', target: 12000, saved: 3000 }] },
    messages: ['coloquei 200 na meta'],
    expectActions: [{ kind: 'goal-deposit', amount: 200, name: 'Moto' }],
  },
  {
    id: 'rt-14', group: 'roteamento', state: { profile: 'other' },
    messages: ['coloquei 200 na meta'],
    expectNoActions: true, expectReply: [/meta/i], forbidReply: [/despesa/i],
  },
  {
    id: 'rt-15', group: 'roteamento', state: { profile: 'clt', goals: [{ name: 'Casa', target: 50000 }, { name: 'Viagem', target: 5000 }] },
    messages: ['guardei 200 pra meta Casa'],
    expectActions: [{ kind: 'goal-deposit', amount: 200, name: 'Casa' }],
  },
  {
    id: 'rt-16', group: 'roteamento', state: { profile: 'other', goals: [{ name: 'Moto', target: 12000 }, { name: 'Viagem', target: 5000 }] },
    messages: ['coloquei 200 na meta da moto'],
    expectActions: [{ kind: 'goal-deposit', amount: 200, name: 'Moto' }],
  },
  {
    // "mANDEI" contém "andei": o regex de km casava dentro da palavra e, no
    // perfil motorista, propunha 200 km rodados no lugar do depósito.
    id: 'rt-17', group: 'roteamento', state: { profile: 'driver', goals: [{ name: 'Carro', target: 30000 }, { name: 'Viagem', target: 5000 }] },
    messages: ['mandei 200 pra meta do carro'],
    expectActions: [{ kind: 'goal-deposit', amount: 200, name: 'Carro' }],
  },
  {
    id: 'rt-18', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['coloquei 200 na meta Casa'],
    expectNoActions: true, expectMode: 'clarify', forbidReply: [/despesa/i],
  },
  {
    // Meta que não existe: a proposta NÃO pode ficar confirmável na tela, e a
    // pergunta precisa trazer as saídas prontas.
    id: 'rt-19', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['guardei 200 pra casa'],
    expectNoActions: true, expectMode: 'clarify', expectClarification: /casa/i,
  },
  {
    id: 'rt-20', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['botei 200 na reserva'],
    expectActions: [{ kind: 'saving', amount: 200 }],
  },
  {
    // Escolher a meta na pergunta propõe o depósito completo, sem repetir nada.
    id: 'rt-21', group: 'roteamento', state: { profile: 'clt', goals: DUAS_METAS },
    messages: ['coloquei 200 na meta', 'Viagem'],
    expectActions: [{ kind: 'goal-deposit', amount: 200, name: 'Viagem' }],
  },

  // ---- 3. magnitude dita por extenso ou abreviada ------------------------
  {
    id: 'rt-30', group: 'roteamento', profile: 'autonomo',
    messages: ['e se eu comprar uma tv de 3 mil'],
    expectNoActions: true, expectReply: [R('3.000,00'), /simula/i], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-31', group: 'roteamento', profile: 'autonomo',
    messages: ['se eu comprar um celular de 4k'],
    expectNoActions: true, expectReply: [R('4.000,00')], forbidReply: [R('4,00')],
  },
  {
    id: 'rt-32', group: 'roteamento', profile: 'autonomo',
    messages: ['se eu comprar um pc de 2 mil e quinhentos'],
    expectNoActions: true, expectReply: [R('2.500,00')], forbidReply: [R('2,00'), R('2.000,00')],
  },
  {
    id: 'rt-33', group: 'roteamento', profile: 'autonomo',
    messages: ['se eu pegar uma moto de 12 mil em 24 vezes'],
    expectNoActions: true, expectReply: [R('12.000,00'), /24x/], forbidReply: [R('4,00'), /\b2x\b/],
  },
  {
    id: 'rt-34', group: 'roteamento', profile: 'autonomo',
    messages: ['e se eu comprar uma tv de 3 mil em 10x'],
    expectNoActions: true, expectReply: [R('3.000,00'), /10x/], forbidReply: [R('3,00')],
  },
  {
    id: 'rt-35', group: 'roteamento', profile: 'other',
    messages: ['gastei 2 mil e 500 no mercado'],
    expectActions: [{ kind: 'expense', amount: 2500 }],
  },
  {
    id: 'rt-36', group: 'roteamento', profile: 'autonomo',
    messages: ['recebi 4 mil e quinhentos de aluguel'],
    expectActions: [{ kind: 'income', amount: 4500 }],
  },
  {
    id: 'rt-37', group: 'roteamento', profile: 'other',
    messages: ['gastei 2,5 mil de obra'],
    expectActions: [{ kind: 'expense', amount: 2500, category: 'obra' }],
  },
  {
    id: 'rt-38', group: 'roteamento', profile: 'driver',
    messages: ['troquei o óleo por 280 com 84 mil km'],
    expectActions: [{ kind: 'maintenance', cost: 280, km: 84000 }],
  },
  {
    id: 'rt-39', group: 'roteamento', profile: 'other',
    messages: ['quero juntar 5 mil pra uma moto'],
    expectActions: [{ kind: 'goal', target: 5000 }],
  },
  {
    // "220.800 mil km" é como se fala o hodômetro: o número JÁ é 220800.
    id: 'rt-40', group: 'roteamento', profile: 'driver',
    messages: ['meu hodometro ta 220.800 mil km'],
    expectActions: [{ kind: 'odometer', value: 220800 }],
  },
]
