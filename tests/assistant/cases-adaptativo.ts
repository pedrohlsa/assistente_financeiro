// Corpus ADAPTATIVO — o que o app aprende com o PRÓPRIO usuário.
//
// A lista de palavras-chave de categoria é genérica e sempre vai errar em nome
// de lugar ("Zé da esquina", "seu Manoel", "posto do Tião"). O histórico do
// usuário, esse é dele: se ele já classificou aquilo três vezes, o app tem a
// resposta e não precisa perguntar nem chutar de novo.
//
// Duas garantias que estes casos protegem:
//  1. Aprender exige REPETIÇÃO — um lançamento isolado não vira regra.
//  2. Nada é gravado sozinho: aprender muda o que é PROPOSTO, e a proposta
//     continua precisando do Confirmar (regra 8).

import type { AssistantCase } from './harness'

const other = { profile: 'other' as const }
const driver = { profile: 'driver' as const }

/** Um lugar que nenhuma lista de palavras-chave conhece. */
const historicoZe = {
  transactions: [
    { id: 'z1', type: 'expense', amount: 22, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-01' },
    { id: 'z2', type: 'expense', amount: 18, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-05' },
    { id: 'z3', type: 'expense', amount: 25, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-09' },
  ],
}

/** O usuário insiste que mercado é COMPRAS, não alimentação. */
const historicoMercado = {
  transactions: [
    { id: 'm1', type: 'expense', amount: 120, category: 'compras', description: 'Mercado', date: '2026-07-01' },
    { id: 'm2', type: 'expense', amount: 90, category: 'compras', description: 'Mercado', date: '2026-07-04' },
    { id: 'm3', type: 'expense', amount: 140, category: 'compras', description: 'Mercado', date: '2026-07-08' },
    { id: 'm4', type: 'expense', amount: 110, category: 'compras', description: 'Mercado', date: '2026-07-12' },
  ],
}

/** Um único lançamento não ensina nada. */
const historicoRaro = {
  transactions: [
    { id: 'r1', type: 'expense', amount: 40, category: 'lazer', description: 'Padaria', date: '2026-07-01' },
  ],
}

const diasDeCorrida = Array.from({ length: 10 }, (_, i) => ({
  id: `d${i}`, type: 'income', amount: 260 + i * 12, category: 'corridas',
  date: `2026-07-0${(i % 9) + 1}`,
}))

export const ADAPTATIVO: AssistantCase[] = [
  // ===== Aprender o vocabulário do usuário =====
  {
    id: 'ad-01', group: 'adaptativo', ...other, state: historicoZe,
    // "Zé da esquina" não está em lista de palavra-chave nenhuma, mas o
    // usuário já disse três vezes o que é.
    messages: ['gastei 30 no ze da esquina'],
    expectActions: [{ kind: 'expense', amount: 30, category: 'alimentacao' }],
  },
  {
    id: 'ad-02', group: 'adaptativo', ...other, state: historicoRaro,
    // UM lançamento não vira regra: "padaria" continua vindo da lista genérica
    // (alimentação), não do único registro em lazer.
    messages: ['gastei 15 na padaria'],
    expectActions: [{ kind: 'expense', amount: 15, category: 'alimentacao' }],
  },

  // ===== O histórico do usuário ganha da lista genérica =====
  {
    id: 'ad-03', group: 'adaptativo', ...other, state: historicoMercado,
    // A lista diz alimentação. O usuário classificou como compras quatro
    // vezes — quem manda no dinheiro dele é ele.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'compras' }],
  },
  {
    id: 'ad-04', group: 'adaptativo', ...other,
    // Sem histórico, a lista genérica continua valendo.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'alimentacao' }],
  },

  // ===== A grafia é a do usuário, não a que ele digitou com pressa =====
  {
    id: 'ad-07', group: 'adaptativo', ...other, state: historicoZe,
    // Ele escreveu "Zé da esquina" três vezes. Digitou sem acento agora, no
    // celular, com a mão na direção — a lista de movimentações não pode virar
    // "Ze da esquina" ao lado de "Zé da esquina" e parecerem dois lugares.
    messages: ['gastei 30 no ze da esquina'],
    expectActions: [{ kind: 'expense', amount: 30, description: 'Zé da esquina' }],
  },
  {
    id: 'ad-08', group: 'adaptativo', ...other, state: historicoZe,
    // Descrição que ele nunca usou continua sendo a que ele acabou de digitar.
    messages: ['gastei 30 na oficina do joao'],
    expectActions: [{ kind: 'expense', amount: 30, description: /oficina/i }],
  },

  {
    id: 'ad-09', group: 'adaptativo', ...other, state: historicoZe,
    // O atalho personalizado da tela leva a este caminho: registro sem valor,
    // pergunta, resposta. O que sai tem que ser IGUAL ao que ele já lançou —
    // mesma grafia e mesma categoria —, senão o histórico se divide em dois
    // lugares parecidos e o próprio aprendizado enfraquece.
    messages: ['gastei no ze da esquina', '35'],
    expectActions: [{ kind: 'expense', amount: 35, description: 'Zé da esquina', category: 'alimentacao' }],
  },

  // ===== Valor muito fora do padrão do usuário: AVISAR, nunca bloquear =====
  {
    id: 'ad-05', group: 'adaptativo', ...driver,
    state: { transactions: diasDeCorrida as any },
    // Dez dias entre R$ 260 e R$ 370. "3000" é quase certamente um zero a
    // mais — mas pode ser real, então o app avisa e deixa confirmar.
    messages: ['ganhei 3000 hoje'],
    expectActions: [{ kind: 'income', amount: 3000 }, { kind: 'work', trips: 1 }],
    expectWarning: /bem acima|fora do|confere/i,
  },
  {
    id: 'ad-06', group: 'adaptativo', ...driver,
    state: { transactions: diasDeCorrida as any },
    // Dentro do padrão: nenhum aviso.
    messages: ['ganhei 300 hoje'],
    expectActions: [{ kind: 'income', amount: 300 }, { kind: 'work', trips: 1 }],
    expectNoWarning: true,
  },
]

export default ADAPTATIVO
