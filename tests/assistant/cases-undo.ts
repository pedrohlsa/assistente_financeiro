// Corpus UNDO — "desfaz o último".
//
// Decisão de produto que estes casos protegem: desfazer é sempre o ÚLTIMO LOTE
// confirmado pelo assistente, inteiro, nunca um pedaço, nunca um registro
// manual. Antes de reverter, o app lista o que vai sumir e pede confirmação.
// Lote sem journal — anterior a esta versão ou já fora do limite — é recusado
// com explicação, jamais reconstruído por adivinhação.

import type { AssistantCase } from './harness'

const other = { profile: 'other' as const }

const CARIMBO = '2026-07-15T09:00'

/** Um lote já confirmado: uma despesa de 50 no mercado. */
const loteDespesa = {
  transactions: [{ id: 'tx-antigo', type: 'expense', amount: 50, category: 'alimentacao', description: 'Mercado', date: '2026-07-15' }],
  journal: [{
    batchId: 'b1', contractVersion: 1, source: 'ai' as const, engine: 'local' as const,
    createdAt: CARIMBO, profileAtCreation: 'other' as const, messageId: 'm1',
    ops: [{ op: 'create' as const, entity: 'transactions' as const, id: 'tx-antigo' }],
  }],
}

export const UNDO: AssistantCase[] = [
  // ===== O CAMINHO FELIZ — lista o que será desfeito e pede confirmação =====
  {
    id: 'und-01', group: 'undo', ...other, state: loteDespesa,
    messages: ['desfaz o último'],
    expectActions: [{ kind: 'undo-batch', batchId: 'b1' }],
    // Mostrar o que some ANTES de sumir é o requisito, não um detalhe de texto.
    expectReply: [/R\$\s*50,00/, /confirmar/i],
    thenConfirm: s => (s.transactions.length === 0 ? null : `sobraram ${s.transactions.length} movimentações`),
  },
  {
    id: 'und-02', group: 'undo', ...other, state: loteDespesa,
    messages: ['desfazer o último registro'],
    expectActions: [{ kind: 'undo-batch', batchId: 'b1' }],
  },
  {
    id: 'und-03', group: 'undo', ...other, state: loteDespesa,
    messages: ['cancela o último lançamento'],
    expectActions: [{ kind: 'undo-batch', batchId: 'b1' }],
  },
  {
    id: 'und-04', group: 'undo', ...other, state: loteDespesa,
    messages: ['desfaz isso'],
    expectActions: [{ kind: 'undo-batch', batchId: 'b1' }],
  },

  // ===== LOTE DE CORREÇÃO — o que VOLTA também precisa aparecer =====
  {
    id: 'und-11', group: 'undo', ...other,
    state: {
      transactions: [{ id: 'tx-corrigido', type: 'expense', amount: 80, category: 'alimentacao', description: 'Mercado', date: '2026-07-14' }],
      journal: [{
        batchId: 'b-edit', contractVersion: 1, source: 'ai' as const, createdAt: CARIMBO,
        ops: [{ op: 'update' as const, entity: 'transactions' as const, id: 'tx-corrigido', before: { amount: 100 } }],
      }],
    },
    messages: ['desfaz o último'],
    expectActions: [{ kind: 'undo-batch', batchId: 'b-edit' }],
    // Sem esta linha o card dizia só "vou desfazer o último registro", e o
    // usuário confirmava sem saber que o valor voltaria para 100.
    expectReply: [/mercado/i, /100,00/],
    thenConfirm: s => (s.transactions[0]?.amount === 100 ? null : `valor ${s.transactions[0]?.amount}`),
  },

  // ===== NÃO HÁ O QUE DESFAZER — explicar, nunca inventar =====
  {
    id: 'und-05', group: 'undo', ...other,
    messages: ['desfaz o último'],
    expectNoActions: true,
    expectReply: [/não (?:tenho|encontrei|há)|nada (?:para|pra) desfazer/i],
  },
  {
    id: 'und-06', group: 'undo', ...other,
    // Lançamento salvo sem journal: é o caso do lote anterior a esta versão.
    state: { transactions: [{ id: 'tx-velho', type: 'expense', amount: 90, category: 'casa', date: '2026-07-10' }] },
    messages: ['desfaz o último'],
    expectNoActions: true,
    expectReply: [/movimenta|não sei desfazer|com segurança/i],
    forbidReply: [/desfeito|removido/i],
  },
  {
    id: 'und-07', group: 'undo', ...other,
    state: {
      transactions: [],
      journal: [{ ...loteDespesa.journal[0], undoneAt: CARIMBO }],
    },
    messages: ['desfaz o último'],
    expectNoActions: true,
    expectReply: [/não (?:tenho|encontrei|há)|já foi desfeito|nada (?:para|pra) desfazer/i],
  },

  // ===== NÃO CONFUNDIR COM OUTRAS INTENÇÕES =====
  {
    id: 'und-08', group: 'undo', ...other, state: loteDespesa,
    // "apaga tudo" continua sendo reset, com o caminho destrutivo próprio.
    messages: ['apaga tudo'],
    expectActions: [{ kind: 'reset' }],
  },
  {
    id: 'und-09', group: 'undo', ...other, state: loteDespesa,
    // Registro novo não vira undo só porque a mensagem tem "último".
    messages: ['gastei 30 no último posto'],
    expectActions: [{ kind: 'expense', amount: 30 }],
  },
  {
    id: 'und-10', group: 'undo', ...other, state: loteDespesa,
    // Correção da proposta na tela tem precedência: aqui não há proposta, mas
    // a frase também não pede desfazer nada já gravado.
    messages: ['não registra isso'],
    expectNoActions: true,
    forbidReply: [/desfazer o último/i],
  },
]

export default UNDO
