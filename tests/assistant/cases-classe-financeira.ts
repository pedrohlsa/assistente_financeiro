// Corpus CLASSE FINANCEIRA — quatro defeitos que registravam dinheiro errado.
//
// Cada grupo protege uma CLASSE, não uma frase: a frase documentada está aqui,
// mas junto dela vêm as variações de ordem, de verbo e de forma que caem no
// mesmo mecanismo, e os controles que provam que a correção não engoliu o que
// já funcionava.
//
//   tipo-clausula   — o tipo de um lançamento vem da evidência DELE, não do
//                     substantivo nem da outra metade da frase;
//   correcao-falada — "foi 90 e não 80" corrige o que existe, nunca cria;
//   pares-telegraf  — "uber 210 99 130" são duas receitas, não zero;
//   futuro          — o que ainda vai acontecer não vira lançamento de hoje.

import type { AssistantCase } from './harness'

const clt = { profile: 'clt' as const }
const autonomo = { profile: 'autonomo' as const }
const driver = { profile: 'driver' as const }
const other = { profile: 'other' as const }

const ONTEM = '2026-07-14'
const HOJE = '2026-07-15'

/** Um gasto de ontem e um de hoje, com valores e nomes diferentes. */
const doisGastos = {
  transactions: [
    { id: 'tx-80', type: 'expense', amount: 80, category: 'alimentacao', description: 'Lanche', date: ONTEM },
    { id: 'tx-150', type: 'expense', amount: 150, category: 'alimentacao', description: 'Mercado', date: HOJE },
  ],
}

export const CLASSE_FINANCEIRA: AssistantCase[] = [
  // ===== 1. TIPO POR CLÁUSULA ============================================
  // "Aluguel", "salário", "comissão" e "freela" são renda para quem recebe e
  // gasto para quem paga. O substantivo não decide: o verbo dito decide.
  {
    id: 'tc-01', group: 'tipo-clausula', ...clt,
    messages: ['salario caiu 3200 e ja paguei o aluguel de 1100'],
    expectActions: [{ kind: 'income', amount: 3200, category: 'salario' }, { kind: 'expense', amount: 1100 }],
  },
  {
    id: 'tc-02', group: 'tipo-clausula', ...clt,
    messages: ['caiu meu salario 3200 e paguei 1100 de aluguel'],
    expectActions: [{ kind: 'income', amount: 3200, category: 'salario' }, { kind: 'expense', amount: 1100 }],
  },
  {
    id: 'tc-03', group: 'tipo-clausula', ...clt,
    // O "aluguel" da despesa virava a CATEGORIA da receita.
    messages: ['recebi 3200 e ja saiu 1100 do aluguel'],
    expectActions: [{ kind: 'income', amount: 3200, category: /^(?!aluguel$)/ }, { kind: 'expense', amount: 1100 }],
  },
  {
    id: 'tc-05', group: 'tipo-clausula', ...clt,
    messages: ['entrou 3200 do salario e 1100 saiu de aluguel'],
    expectActions: [{ kind: 'income', amount: 3200, category: 'salario' }, { kind: 'expense', amount: 1100 }],
  },
  {
    id: 'tc-06', group: 'tipo-clausula', ...clt,
    // A ordem não pode contaminar o tipo. E "caiu" é palavra, não erro de
    // digitação de "saiu": trocar um pelo outro inverte o dinheiro.
    messages: ['paguei 1100 de aluguel e depois caiu meu salario 3200'],
    expectActions: [{ kind: 'expense', amount: 1100 }, { kind: 'income', amount: 3200, category: 'salario' }],
    forbidReply: [/li "caiu" como "saiu"/i],
  },
  {
    id: 'tc-07', group: 'tipo-clausula', ...autonomo,
    // Mesma classe, sem segunda cláusula nenhuma: virava RECEITA de 200.
    messages: ['paguei a comissão de 200'],
    forbidKinds: ['income'],
  },
  {
    id: 'tc-08', group: 'tipo-clausula', ...autonomo,
    messages: ['paguei o freela de 300'],
    forbidKinds: ['income'],
  },
  {
    id: 'tc-09', group: 'tipo-clausula', ...clt,
    messages: ['paguei o salario de 1500 da diarista'],
    forbidKinds: ['income'],
  },
  {
    id: 'tc-10', group: 'tipo-clausula', ...autonomo,
    // Controle: sem verbo de pagar, o substantivo de renda continua valendo.
    messages: ['recebi o aluguel de 1800'],
    expectActions: [{ kind: 'income', amount: 1800, category: 'aluguel' }],
  },
  {
    id: 'tc-11', group: 'tipo-clausula', ...clt,
    messages: ['meu salario foi 1625'],
    expectActions: [{ kind: 'income', amount: 1625, category: 'salario' }],
  },

]
