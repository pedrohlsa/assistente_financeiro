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

]
