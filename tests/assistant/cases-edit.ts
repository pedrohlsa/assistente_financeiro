// Corpus EDIT — corrigir um lançamento JÁ SALVO por conversa.
//
// Escopo desta rodada: só `Transaction` simples e ocorrência recorrente já
// materializada. Estrutura de parcelamento, cartão, meta, abastecimento,
// trabalho, manutenção e template de recorrência continuam fora — quando o
// lançamento depende de uma dessas, o assistente RECUSA e diz para onde ir.
//
// A regra central: a busca é local, o candidato nunca é escolhido por
// adivinhação, o antes e o depois aparecem, e nada muda sem confirmação.

import type { AssistantCase } from './harness'

const other = { profile: 'other' as const }

/** Um gasto de ontem, salvo. */
const gastoOntem = {
  transactions: [
    { id: 'tx-mercado', type: 'expense', amount: 100, category: 'alimentacao', description: 'Mercado', date: '2026-07-14' },
  ],
}

/** Dois gastos no mesmo dia — o assistente tem que perguntar qual. */
const doisGastosOntem = {
  transactions: [
    { id: 'tx-a', type: 'expense', amount: 100, category: 'alimentacao', description: 'Mercado', date: '2026-07-14' },
    { id: 'tx-b', type: 'expense', amount: 60, category: 'lazer', description: 'Uber', date: '2026-07-14' },
  ],
}

export const EDIT: AssistantCase[] = [
  // ===== UM CANDIDATO — propõe a correção mostrando antes e depois =====
  {
    id: 'edt-01', group: 'edicao', ...other, state: gastoOntem,
    messages: ['corrige o gasto de ontem para 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', amount: 80 }],
    // Antes, depois, item e data precisam estar à vista antes de confirmar.
    expectReply: [/100,00/, /80,00/, /mercado/i],
    thenConfirm: s => {
      const t = s.transactions.find(x => x.id === 'tx-mercado')
      if (!t) return 'o lançamento sumiu'
      if (t.amount !== 80) return `valor ${t.amount}`
      if (t.type !== 'expense') return `tipo virou ${t.type}`
      if (t.date !== '2026-07-14') return `data virou ${t.date}`
      return null
    },
  },
  {
    id: 'edt-02', group: 'edicao', ...other, state: gastoOntem,
    messages: ['muda a despesa de 100 para 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', amount: 80 }],
  },
  {
    id: 'edt-03', group: 'edicao', ...other, state: gastoOntem,
    messages: ['muda a categoria do gasto de ontem para lazer'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', category: 'lazer' }],
    thenConfirm: s => {
      const t = s.transactions.find(x => x.id === 'tx-mercado')
      if (t?.category !== 'lazer') return `categoria ${t?.category}`
      if (t?.amount !== 100) return `o valor mudou para ${t?.amount}`
      return null
    },
  },
  {
    id: 'edt-04', group: 'edicao', ...other, state: gastoOntem,
    messages: ['muda a descrição do gasto de ontem para feira'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', description: 'feira' }],
  },

  // ===== VÁRIOS CANDIDATOS — perguntar, nunca escolher sozinho =====
  {
    id: 'edt-05', group: 'edicao', ...other, state: doisGastosOntem,
    messages: ['corrige o gasto de ontem para 80'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /qual/i,
    expectReply: [/mercado/i, /uber/i],
  },
  {
    id: 'edt-06', group: 'edicao', ...other, state: doisGastosOntem,
    // Com o valor antigo dito, o candidato fica único e não há o que perguntar.
    messages: ['corrige o gasto de 60 de ontem para 55'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-b', amount: 55 }],
  },

  // ===== NENHUM CANDIDATO — explicar, nunca inventar =====
  {
    id: 'edt-07', group: 'edicao', ...other, state: gastoOntem,
    messages: ['corrige o gasto de semana passada para 80'],
    expectNoActions: true,
    expectReply: [/não encontrei|nenhum lançamento/i],
  },
  {
    id: 'edt-08', group: 'edicao', ...other,
    messages: ['corrige o gasto de ontem para 80'],
    expectNoActions: true,
    expectReply: [/não encontrei|nenhum lançamento/i],
  },

  // ===== FORA DO ESCOPO — recusar e direcionar =====
  {
    id: 'edt-09', group: 'edicao', ...other,
    state: {
      transactions: [
        { id: 'tx-fin', type: 'financed-cash-inflow', amount: 1850, category: 'outros-in', description: 'Entrada financiada pelo cartão', date: '2026-07-14' },
      ],
    },
    messages: ['corrige o lançamento de ontem para 1800'],
    // A entrada financiada é a ponta de um parcelamento: corrigir só ela
    // desencontraria o plano, as parcelas e o limite do cartão.
    expectNoActions: true,
    expectReply: [/cart[õo]es|parcelamento|não dá para corrigir/i],
  },

  // ===== NÃO CONFUNDIR COM OUTRAS INTENÇÕES =====
  {
    id: 'edt-10', group: 'edicao', ...other,
    state: { goals: [{ name: 'iPhone', target: 5000 }], ...gastoOntem },
    messages: ['muda a meta do iphone para 8000'],
    expectActions: [{ kind: 'goal-update', target: 8000 }],
  },
  {
    id: 'edt-11', group: 'edicao', ...other, state: gastoOntem,
    messages: ['gastei 30 no mercado'],
    expectActions: [{ kind: 'expense', amount: 30 }],
  },

  // ===== OCORRÊNCIA RECORRENTE MATERIALIZADA =====
  {
    id: 'edt-12', group: 'edicao', ...other,
    state: {
      transactions: [
        { id: 'tx-luz', type: 'expense', amount: 120, category: 'casa', description: 'Luz', date: '2026-07-14', recurringId: 'rec1', occurrenceDate: '2026-07-14' } as any,
      ],
    },
    messages: ['corrige o gasto de ontem para 135'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-luz', amount: 135 }],
    thenConfirm: s => {
      const t = s.transactions.find(x => x.id === 'tx-luz') as any
      if (t?.amount !== 135) return `valor ${t?.amount}`
      // Editar a ocorrência NÃO mexe no template nem libera para reconfirmar.
      if (t?.recurringId !== 'rec1') return 'perdeu o vínculo com a recorrente'
      if (t?.occurrenceDate !== '2026-07-14') return 'perdeu a ocorrência'
      return null
    },
  },

  // ===== O lançamento citado pela DESCRIÇÃO, não pela palavra "gasto" =====
  // Na fala real ninguém diz "corrige o gasto de ontem": diz "muda o mercado
  // pra 80". O parser exigia um substantivo genérico e devolvia "entendi que
  // isso não aconteceu" — resposta de outra conversa.
  {
    id: 'edt-13', group: 'edicao', ...other, state: gastoOntem,
    messages: ['muda o mercado de 100 pra 80'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', amount: 80 }],
  },
  {
    id: 'edt-14', group: 'edicao', ...other, state: doisGastosOntem,
    // A descrição desempata: só o "Uber" combina, então não precisa perguntar.
    messages: ['corrige o uber pra 55'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-b', amount: 55 }],
  },
  {
    id: 'edt-15', group: 'edicao', ...other, state: gastoOntem,
    messages: ['muda a categoria do mercado para lazer'],
    expectActions: [{ kind: 'edit-transaction', transactionId: 'tx-mercado', category: 'lazer' }],
  },
  {
    id: 'edt-15b', group: 'edicao', ...other,
    state: { goals: [{ name: 'iPhone', target: 5000 }], ...gastoOntem },
    // Meta tem ação PRÓPRIA no catálogo. O caminho solto reconhece pelo verbo,
    // então quase engoliu "muda a meta do iphone" como correção de lançamento.
    messages: ['muda a meta do iphone para 8000'],
    expectActions: [{ kind: 'goal-update', target: 8000 }],
  },
  {
    id: 'edt-16', group: 'edicao', ...other, state: gastoOntem,
    // Apelido que não existe em lançamento nenhum: nada é alterado, e a
    // resposta diz QUAL nome não foi achado, em vez do genérico "entendi que
    // isso não aconteceu" — que é resposta de outra conversa.
    messages: ['muda o cinema para 80'],
    expectNoActions: true,
    expectReply: [/cinema/i],
  },
]

export default EDIT
