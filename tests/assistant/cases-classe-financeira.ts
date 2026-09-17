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
    id: 'tc-04', group: 'tipo-clausula', ...clt,
    messages: ['salario 3200 aluguel pago 1100'],
    expectActions: [{ kind: 'income', amount: 3200, category: 'salario' }, { kind: 'expense', amount: 1100 }],
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

  // ===== 2. CORREÇÃO FALADA ==============================================
  // Sem proposta na tela, "aquele foi 90 e não 80" fala de um lançamento que
  // JÁ EXISTE. Nunca é lançamento novo, nunca são dois.
  {
    id: 'cf-01', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['aquele gasto de ontem foi 90 e não 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-80', amount: 90 }],
    thenConfirm: s => {
      if (s.transactions.length !== 2) return `${s.transactions.length} lançamentos (esperava os mesmos 2)`
      const t = s.transactions.find(x => x.id === 'tx-80')
      return t?.amount === 90 && t.type === 'expense' ? null : `tx-80 ficou ${t?.type} ${t?.amount}`
    },
  },
  {
    id: 'cf-02', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['aquele do mercado foi 230 na verdade'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-150', amount: 230 }],
  },
  {
    id: 'cf-03', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['o 150 que eu te falei era de farmácia não de mercado'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-150', category: 'compras' }],
  },
  {
    id: 'cf-04', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['aquele foi 90 e não 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-80', amount: 90 }],
  },
  {
    id: 'cf-05', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['não foi 80 foi 90'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-80', amount: 90 }],
  },
  {
    id: 'cf-06', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['aquele de ontem foi 90 na verdade'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-80', amount: 90 }],
  },
  {
    id: 'cf-07', group: 'correcao-falada', ...other, state: doisGastos,
    // Dois candidatos e nenhuma pista: perguntar.
    messages: ['corrige aquele pra 90'],
    expectMode: 'clarify', expectNoActions: true,
  },
  {
    id: 'cf-08', group: 'correcao-falada', ...other, state: doisGastos,
    messages: ['era 90 e não 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-80', amount: 90 }],
  },
  {
    id: 'cf-09', group: 'correcao-falada', ...other, state: doisGastos,
    // Contesta algo sem dizer o quê: pergunta qual, não inventa nem nega.
    messages: ['não, foi 100 mesmo'],
    expectMode: 'clarify', expectNoActions: true,
    forbidReply: [/isso não aconteceu/i],
  },
  {
    id: 'cf-10', group: 'correcao-falada', ...other, state: doisGastos,
    // Negação continua negação: não é correção de lançamento anterior.
    messages: ['não gastei 80'],
    expectNoActions: true,
    expectReply: [/não aconteceu/i],
  },
  {
    id: 'cf-11', group: 'correcao-falada', ...other,
    // Nada salvo para corrigir: explica, não cria.
    messages: ['aquele gasto de ontem foi 90 e não 80'],
    expectNoActions: true,
    expectReply: [/não encontrei|nenhum lançamento/i],
  },
  {
    id: 'cf-12', group: 'correcao-falada', ...other,
    state: {
      transactions: [
        { id: 'tx-a', type: 'expense', amount: 80, category: 'alimentacao', description: 'Lanche', date: ONTEM },
        { id: 'tx-b', type: 'expense', amount: 80, category: 'lazer', description: 'Cinema', date: ONTEM },
      ],
    },
    // Dois de 80 ontem: a pista não desempata, e escolher seria adivinhar.
    messages: ['aquele foi 90 e não 80'],
    expectMode: 'clarify', expectNoActions: true,
  },
  {
    id: 'cf-13', group: 'correcao-falada', ...other,
    // Controle: registro comum com "foi" continua sendo registro.
    messages: ['foi 90 no mercado'],
    expectActions: [{ kind: 'expense', amount: 90 }],
  },

  // ===== 3. PARES TELEGRÁFICOS ===========================================
  {
    id: 'tp-01', group: 'pares-telegraf', ...driver,
    messages: ['uber deu 210 e a 99 uns 130'],
    expectActions: [
      { kind: 'income', amount: 210, category: 'corridas', description: 'Uber', is99: null },
      { kind: 'income', amount: 130, category: 'corridas', description: '99', is99: null },
    ],
  },
  {
    id: 'tp-02', group: 'pares-telegraf', ...driver,
    messages: ['uber 210 99 130'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
    ],
  },
  {
    id: 'tp-03', group: 'pares-telegraf', ...driver,
    messages: ['deu 210 uber e 130 na 99'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
    ],
  },
  {
    id: 'tp-04', group: 'pares-telegraf', ...driver,
    messages: ['uber fez 210 e 99 fez 130'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
    ],
  },
  {
    id: 'tp-05', group: 'pares-telegraf', ...driver,
    messages: ['210 uber 130 99'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
    ],
  },
  {
    id: 'tp-06', group: 'pares-telegraf', ...driver,
    messages: ['hoje uber 210 e 99 130'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber', date: HOJE },
      { kind: 'income', amount: 130, description: '99', date: HOJE },
    ],
  },
  {
    id: 'tp-07', group: 'pares-telegraf', ...driver,
    // Controle: o segundo valor tem verbo de gasto — não são duas receitas.
    messages: ['uber deu 210 e gastei 130 de gasolina'],
    expectActions: [{ kind: 'income', amount: 210, description: 'Uber' }, { kind: 'fuel', amount: 130 }],
  },
  {
    id: 'tp-08', group: 'pares-telegraf', ...other,
    // Renda de Uber ocasional para quem não é motorista: registra, e o perfil
    // continua o mesmo.
    messages: ['uber deu 210 e a 99 uns 130'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
    ],
    thenConfirm: s => (s.settings.profile === 'other' ? null : `perfil virou ${s.settings.profile}`),
  },
  {
    id: 'tp-09', group: 'pares-telegraf', ...driver,
    messages: ['hoje uber deu 210 e a 99 uns 130 abasteci 80'],
    expectActions: [
      { kind: 'income', amount: 210, description: 'Uber' },
      { kind: 'income', amount: 130, description: '99' },
      { kind: 'fuel', amount: 80 },
    ],
  },
  {
    id: 'tp-10', group: 'pares-telegraf', ...driver,
    // Número sem par não vira dinheiro: "99" aqui não tem valor nenhum.
    messages: ['uber 210 99'],
    forbidAmounts: [99],
  },
  {
    id: 'tp-11', group: 'pares-telegraf', ...driver,
    // O par telegráfico não fura a regra temporal.
    messages: ['uber 210 99 130 amanhã'],
    expectNoActions: true,
  },
  {
    id: 'tp-12', group: 'pares-telegraf', ...other,
    // Nome solto sem tipo não vira par: continua como o bloquinho sempre leu.
    messages: ['lanche 15 e café 5'],
    expectActions: [{ kind: 'expense', amount: 15 }, { kind: 'expense', amount: 5 }],
  },

  // ===== 4. FUTURO NÃO É REALIZADO =======================================
  {
    id: 'fu-01', group: 'futuro', ...autonomo,
    // A reprodução documentada: a casa 2 ainda VAI cair. Só a casa 1 é fato.
    messages: ['recebi 1800 da casa 1 e 1200 da casa 2 mas a 2 ainda vai cair na conta amanhã'],
    expectActions: [{ kind: 'income', amount: 1800, origin: 'casa 1' }],
    forbidAmounts: [1200],
  },
  { id: 'fu-02', group: 'futuro', ...autonomo, messages: ['amanhã cai 1800 do aluguel'], expectNoActions: true },
  { id: 'fu-03', group: 'futuro', ...autonomo, messages: ['vou receber 1800 amanhã'], expectNoActions: true },
  { id: 'fu-04', group: 'futuro', ...autonomo, messages: ['semana que vem pago 500'], expectNoActions: true },
  { id: 'fu-05', group: 'futuro', ...autonomo, messages: ['vou gastar 300 mês que vem'], expectNoActions: true },
  { id: 'fu-06', group: 'futuro', ...autonomo, messages: ['depois de amanhã cai 1800'], expectNoActions: true },
  { id: 'fu-07', group: 'futuro', ...autonomo, messages: ['próximo mês recebo 2000'], expectNoActions: true },
  { id: 'fu-08', group: 'futuro', ...autonomo, messages: ['daqui a 3 dias cai 500'], expectNoActions: true },
  { id: 'fu-09', group: 'futuro', ...autonomo, messages: ['daqui a 2 semanas pago 400 de luz'], expectNoActions: true },
  { id: 'fu-10', group: 'futuro', ...autonomo, messages: ['em 5 dias cai 700'], expectNoActions: true },
  { id: 'fu-11', group: 'futuro', ...autonomo, messages: ['dia 20 cai 1500 do cliente'], expectNoActions: true },
  {
    id: 'fu-12', group: 'futuro', ...autonomo,
    // Virava DESPESA realizada de 1800: "vai cair" não era lido como futuro.
    messages: ['vai cair 1800 do aluguel'],
    expectNoActions: true,
  },
  { id: 'fu-13', group: 'futuro', ...autonomo, messages: ['recebo 1800 amanhã'], expectNoActions: true },
  { id: 'fu-14', group: 'futuro', ...autonomo, messages: ['deve entrar 900 amanhã'], expectNoActions: true },
  {
    id: 'fu-15', group: 'futuro', ...autonomo,
    messages: ['ontem caiu 1800'],
    expectActions: [{ kind: 'income', amount: 1800, date: ONTEM }],
  },
  {
    id: 'fu-16', group: 'futuro', ...autonomo,
    messages: ['hoje caiu 1800'],
    expectActions: [{ kind: 'income', amount: 1800, date: HOJE }],
  },
  { id: 'fu-17', group: 'futuro', ...autonomo, messages: ['vai entrar 500 do cliente'], expectNoActions: true },
  {
    id: 'fu-18', group: 'futuro', ...autonomo,
    // Mesma classe do lado da DESPESA: a água ainda vai ser paga.
    messages: ['paguei 200 de luz e 150 de água mas a água só vou pagar amanhã'],
    expectActions: [{ kind: 'expense', amount: 200 }],
    forbidAmounts: [150],
  },
  {
    id: 'fu-19', group: 'futuro', ...autonomo,
    // Controle: as duas casas pagas, nenhuma no futuro.
    messages: ['recebi 1800 da casa 1 e 1200 da casa 2'],
    expectActions: [{ kind: 'income', amount: 1800, origin: 'casa 1' }, { kind: 'income', amount: 1200, origin: 'casa 2' }],
  },
  {
    id: 'fu-20', group: 'futuro', ...autonomo,
    // Controle: fato de hoje com plano de amanhã continua registrando o fato.
    messages: ['gastei 40 hoje e amanhã vou pagar 120'],
    expectActions: [{ kind: 'expense', amount: 40, date: HOJE }],
  },
]
