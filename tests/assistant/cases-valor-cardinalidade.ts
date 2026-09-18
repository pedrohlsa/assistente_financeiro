// Corpus VALOR E CARDINALIDADE — dinheiro que muda de tipo sozinho, some, ou
// aparece onde não havia.
//
//   polaridade        — substantivo financeiro ambíguo não escolhe direção;
//   valor-sumido      — valor dito explicitamente termina em algum lugar;
//   decimal-falado    — "sessenta vírgula cinquenta" tem centavos;
//   parcela-nao-preco — o número de parcelas nunca é dinheiro;
//   nao-e-dinheiro    — km, litros, horas, dias, %, dia do mês e número de casa.

import type { AssistantCase } from './harness'

const clt = { profile: 'clt' as const }
const autonomo = { profile: 'autonomo' as const }
const driver = { profile: 'driver' as const }
const other = { profile: 'other' as const }

const duasMetas = { goals: [{ name: 'Viagem', target: 5000 }, { name: 'Carro', target: 20000 }] }
const tresMetas = { goals: [{ name: 'Viagem', target: 5000 }, { name: 'Carro', target: 20000 }, { name: 'Curso', target: 3000 }] }

export const VALOR_CARDINALIDADE: AssistantCase[] = [
  // ===== 1. POLARIDADE =====================================================
  // "Aluguel" é renda para quem recebe e gasto para quem paga. Sem verbo que
  // desempate, propor as DUAS coisas é somar e subtrair o mesmo dinheiro.
  {
    id: 'pa-01', group: 'polaridade', ...autonomo,
    messages: ['o aluguel foi 1800'],
    expectMode: 'clarify', expectNoActions: true,
    expectReply: [/1\.800,00/, /recebeu|entrou|pagou|saiu/i],
  },
  {
    id: 'pa-02', group: 'polaridade', ...autonomo,
    messages: ['aluguel 1800'],
    expectMode: 'clarify', expectNoActions: true,
  },
  {
    id: 'pa-03', group: 'polaridade', ...autonomo,
    messages: ['recebi 1800 de aluguel'],
    expectActions: [{ kind: 'income', amount: 1800, category: 'aluguel' }],
  },
  {
    id: 'pa-04', group: 'polaridade', ...autonomo,
    messages: ['entrou 1800 de aluguel'],
    expectActions: [{ kind: 'income', amount: 1800, category: 'aluguel' }],
  },
  {
    id: 'pa-05', group: 'polaridade', ...autonomo,
    messages: ['paguei 1800 de aluguel'],
    expectActions: [{ kind: 'expense', amount: 1800 }],
  },
  {
    id: 'pa-06', group: 'polaridade', ...autonomo,
    messages: ['gastei 1800 de aluguel'],
    expectActions: [{ kind: 'expense', amount: 1800 }],
  },
  {
    id: 'pa-07', group: 'polaridade', ...autonomo,
    messages: ['o aluguel que recebi foi 1800'],
    expectActions: [{ kind: 'income', amount: 1800, category: 'aluguel' }],
  },
  {
    id: 'pa-08', group: 'polaridade', ...autonomo,
    messages: ['o aluguel que paguei foi 1800'],
    expectActions: [{ kind: 'expense', amount: 1800 }],
  },
  {
    id: 'pa-09', group: 'polaridade', ...clt,
    // Sem verbo, "vale alimentação 800" também não escolhe — mas os R$ 800 não
    // podem sumir.
    messages: ['vale alimentação 800'],
    expectMode: 'clarify', expectNoActions: true,
    expectReply: [/800,00/],
  },
  {
    id: 'pa-10', group: 'polaridade', ...autonomo,
    // A resposta à pergunta resolve a direção sem repetir o valor.
    messages: ['o aluguel foi 1800', 'recebi'],
    expectActions: [{ kind: 'income', amount: 1800, category: 'aluguel' }],
  },

  // ===== 2. VALOR QUE SOME ==================================================
  {
    id: 'vs-01', group: 'valor-sumido', ...autonomo,
    // Os R$ 180 viravam DESCRIÇÃO do gasto de luz ("Luz 180 de agua").
    messages: ['paguei 320 de luz 180 de agua e a internet eu nao lembro'],
    expectActions: [{ kind: 'expense', amount: 320 }, { kind: 'expense', amount: 180 }],
  },
  {
    id: 'vs-02', group: 'valor-sumido', ...autonomo,
    messages: ['gastei 180 de água e 200 de luz'],
    expectActions: [{ kind: 'expense', amount: 180 }, { kind: 'expense', amount: 200 }],
  },
  {
    id: 'vs-03', group: 'valor-sumido', ...other, state: duasMetas,
    // c-20: os 200 sumiam em silêncio. Com duas metas, "a outra" é a que sobra.
    messages: ['guardei 300 na meta da viagem e 200 na outra'],
    expectActions: [
      { kind: 'goal-deposit', name: 'Viagem', amount: 300 },
      { kind: 'goal-deposit', name: 'Carro', amount: 200 },
    ],
  },
  {
    id: 'vs-04', group: 'valor-sumido', ...other, state: tresMetas,
    // Com três metas "a outra" não identifica nada: pergunta, e os 200 continuam
    // na pergunta.
    messages: ['guardei 300 na meta da viagem e 200 na outra'],
    expectMode: 'clarify',
    expectReply: [/200,00/],
  },
  {
    id: 'vs-05', group: 'valor-sumido', ...clt,
    // A entrada sumia e o app respondia uma CONSULTA de gastos com alimentação.
    messages: ['caiu o vale alimentação 800'],
    expectActions: [{ kind: 'income', amount: 800 }],
  },
  {
    id: 'vs-06', group: 'valor-sumido', ...clt,
    messages: ['recebi 800 de vale alimentação'],
    expectActions: [{ kind: 'income', amount: 800 }],
  },
  {
    id: 'vs-07', group: 'valor-sumido', ...clt,
    messages: ['entrou 800 de vale'],
    expectActions: [{ kind: 'income', amount: 800 }],
  },
  {
    id: 'vs-08', group: 'valor-sumido', ...clt,
    messages: ['gastei 80 do vale alimentação'],
    expectActions: [{ kind: 'expense', amount: 80 }],
  },
  {
    id: 'vs-09', group: 'valor-sumido', ...autonomo,
    // Controle de cardinalidade: dois fatos, dois lançamentos — nunca um de 380.
    messages: ['paguei 180 de água e 200 de luz'],
    expectActions: [{ kind: 'expense', amount: 180 }, { kind: 'expense', amount: 200 }],
    forbidAmounts: [380],
  },

  // ===== 3. DECIMAL FALADO ==================================================
  {
    id: 'df-01', group: 'decimal-falado', ...autonomo,
    messages: ['gastei sessenta vírgula cinquenta de farmácia ponto'],
    expectActions: [{ kind: 'expense', amount: 60.5 }],
  },
  {
    id: 'df-02', group: 'decimal-falado', ...autonomo,
    messages: ['gastei cento e vinte vírgula noventa no mercado'],
    expectActions: [{ kind: 'expense', amount: 120.9 }],
  },
  {
    id: 'df-03', group: 'decimal-falado', ...autonomo,
    // "dez vírgula cinco" é 10,5 — que em dinheiro é R$ 10,50.
    messages: ['recebi dez vírgula cinco'],
    expectActions: [{ kind: 'income', amount: 10.5 }],
  },
  {
    id: 'df-04', group: 'decimal-falado', ...autonomo,
    // Controle: a magnitude de "mil" não muda.
    messages: ['gastei 2,5 mil no mercado'],
    expectActions: [{ kind: 'expense', amount: 2500 }],
  },
  {
    id: 'df-05', group: 'decimal-falado', ...autonomo,
    messages: ['recebi 3 mil'],
    expectActions: [{ kind: 'income', amount: 3000 }],
  },
  {
    id: 'df-06', group: 'decimal-falado', ...autonomo,
    // Controle: centavos escritos continuam iguais.
    messages: ['gastei 60,50 na farmácia'],
    expectActions: [{ kind: 'expense', amount: 60.5 }],
  },
  {
    id: 'df-07', group: 'decimal-falado', ...driver,
    // Contraste NÃO monetário: o mesmo decimal em quilômetros.
    messages: ['rodei dez vírgula cinco km'],
    expectActions: [{ kind: 'work', km: 10.5 }],
    forbidKinds: ['expense', 'income'],
  },

  // ===== 4. PARCELA NÃO É PREÇO =============================================
  {
    id: 'pp-01', group: 'parcela-nao-preco', ...autonomo,
    messages: ['comprei um pc de 4000 em 10x'],
    expectActions: [{ kind: 'card-purchase', total: 4000, installments: 10 }],
    forbidAmounts: [10],
  },
  {
    id: 'pp-02', group: 'parcela-nao-preco', ...autonomo,
    // O follow-up muda as PARCELAS, não o preço.
    messages: ['comprei um pc de 4000 em 10x', 'e em 12x?'],
    expectActions: [{ kind: 'card-purchase', total: 4000, installments: 12 }],
    forbidAmounts: [12],
  },
  {
    id: 'pp-03', group: 'parcela-nao-preco', ...autonomo,
    messages: ['comprei em 12x por 2400'],
    expectActions: [{ kind: 'card-purchase', total: 2400, installments: 12 }],
    forbidAmounts: [12],
  },
  {
    id: 'pp-04', group: 'parcela-nao-preco', ...autonomo,
    messages: ['10x de 400'],
    forbidAmounts: [10],
  },
  {
    id: 'pp-05', group: 'parcela-nao-preco', ...autonomo,
    messages: ['e se em vez de 10x eu fizer 12 dando mil de entrada?'],
    forbidAmounts: [10, 12],
  },
  {
    id: 'pp-06', group: 'parcela-nao-preco', ...autonomo,
    messages: ['celular de 3000 em 12'],
    forbidAmounts: [12],
  },
  {
    id: 'pp-07', group: 'parcela-nao-preco', ...autonomo,
    messages: ['12 parcelas'],
    expectNoActions: true,
  },

  // ===== 5. NÚMERO QUE NÃO É DINHEIRO =======================================
  { id: 'nd-01', group: 'nao-e-dinheiro', ...driver, messages: ['faltam 200 km'], forbidAmounts: [200] },
  { id: 'nd-02', group: 'nao-e-dinheiro', ...autonomo, messages: ['daqui a 180 dias'], forbidAmounts: [180] },
  { id: 'nd-03', group: 'nao-e-dinheiro', ...autonomo, messages: ['12 parcelas'], forbidAmounts: [12] },
  { id: 'nd-04', group: 'nao-e-dinheiro', ...autonomo, messages: ['casa 2'], forbidAmounts: [2] },
  {
    id: 'nd-05', group: 'nao-e-dinheiro', ...driver,
    messages: ['trabalhei 8 horas'],
    expectActions: [{ kind: 'work', hours: 8 }],
    forbidAmounts: [8],
  },
  { id: 'nd-06', group: 'nao-e-dinheiro', ...driver, messages: ['24 litros'], forbidAmounts: [24] },
  { id: 'nd-07', group: 'nao-e-dinheiro', ...autonomo, messages: ['90%'], forbidAmounts: [90] },
  { id: 'nd-08', group: 'nao-e-dinheiro', ...autonomo, messages: ['dia 10'], forbidAmounts: [10] },
  {
    id: 'nd-09', group: 'nao-e-dinheiro', ...driver,
    messages: ['rodei 180 km e gastei 200 de gasolina'],
    expectActions: [{ kind: 'work', km: 180 }, { kind: 'fuel', amount: 200 }],
    forbidAmounts: [180],
  },
]
