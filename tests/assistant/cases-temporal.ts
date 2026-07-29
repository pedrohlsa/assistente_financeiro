// Corpus TEMPORAL — nenhuma informação de tempo dada pelo usuário pode sumir.
//
// Regra que estes casos protegem: **uma expressão temporal reconhecida jamais é
// descartada e substituída por hoje**. Ou o app interpreta, ou pergunta, ou
// explica que não sabe — nunca grava calado numa data que o usuário não disse.
//
// Todos escritos ANTES da correção, a partir da reprodução em
// `scripts/_repro.mts` (hoje fixo = 2026-07-15, uma quarta-feira).

import type { AssistantCase } from './harness'

const other = { profile: 'other' as const }
const clt = { profile: 'clt' as const }

export const TEMPORAL: AssistantCase[] = [
  // ===== VERBO NO PASSADO + DATA FUTURA — contradição, tem que perguntar =====
  {
    id: 'fut-01', group: 'temporal', ...other,
    messages: ['gastei 50 daqui a 3 dias'],
    // Antes: gravava R$ 50 com a data de HOJE, sem avisar.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu|planejar/i,
  },
  {
    id: 'fut-02', group: 'temporal', ...other,
    messages: ['gastei 50 em 3 dias'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu|planejar/i,
  },
  {
    id: 'fut-03', group: 'temporal', ...other,
    messages: ['gastei 50 no mercado dia 10/08'],
    // Data explícita futura: perguntar se foi o último 10/08 ou é um plano.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /10\/08\/2025|[úu]ltimo|planejar/i,
  },
  {
    id: 'fut-04', group: 'temporal', ...other,
    messages: ['paguei 200 dia 20/12'],
    expectMode: 'clarify', expectNoActions: true,
  },

  // ===== INTENÇÃO CLARAMENTE FUTURA — explicar, nunca registrar =====
  {
    id: 'fut-05', group: 'temporal', ...other,
    messages: ['vou gastar 50 daqui a 3 dias'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
    forbidReply: [/entendi isso/i, /confirmar\?/i],
  },
  {
    id: 'fut-06', group: 'temporal', ...other,
    messages: ['daqui a 2 semanas vou pagar 300'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
  },
  {
    id: 'fut-07', group: 'temporal', ...other,
    messages: ['em 3 meses tenho uma parcela de 500'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer|parcelamento/i],
  },
  {
    id: 'fut-08', group: 'temporal', ...other,
    messages: ['vou gastar 50 dia 10/08'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
  },
  {
    id: 'fut-09', group: 'temporal', ...other,
    messages: ['amanhã vou pagar 120 de luz'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
  },

  // ===== PERÍODO SEM DIA — perguntar, nunca assumir hoje =====
  {
    id: 'per-01', group: 'temporal', ...other,
    messages: ['paguei 100 mês passado'],
    // Antes: gravava com a data de HOJE, apagando "mês passado".
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /que dia|qual dia/i,
  },
  {
    id: 'per-02', group: 'temporal', ...other,
    messages: ['gastei 80 semana passada'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /que dia|qual dia/i,
  },

  // ===== PASSADO EXPLÍCITO — continua funcionando exatamente como antes =====
  {
    id: 'pas-01', group: 'temporal', ...other, messages: ['ontem gastei 50'],
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-14' }],
    thenConfirm: s => (s.transactions[0]?.date === '2026-07-14' ? null : `gravou em ${s.transactions[0]?.date}`),
  },
  {
    id: 'pas-02', group: 'temporal', ...other, messages: ['anteontem gastei 50'],
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-13' }],
    thenConfirm: s => (s.transactions[0]?.date === '2026-07-13' ? null : `gravou em ${s.transactions[0]?.date}`),
  },
  {
    id: 'pas-03', group: 'temporal', ...other, messages: ['gastei 50 hoje'],
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-15' }] },
  {
    id: 'pas-04', group: 'temporal', ...other, messages: ['gastei 50 dia 10/07'],
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-10' }] },
  {
    id: 'pas-05', group: 'temporal', ...clt, messages: ['dia 5 recebi 1800 de aluguel'],
    expectActions: [{ kind: 'income', amount: 1800, date: '2026-07-05' }] },

  // ===== SEM EXPRESSÃO TEMPORAL — hoje continua sendo o padrão =====
  {
    id: 'sem-tempo-01', group: 'temporal', ...other, messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, date: null }],
    thenConfirm: s => (s.transactions[0]?.date ? null : 'não gravou data nenhuma') },

  // ===== ESCOLHA DA DESAMBIGUAÇÃO =====
  {
    id: 'esc-01', group: 'temporal', ...other,
    messages: ['gastei 50 no mercado dia 10/08', 'Foi em 10/08/2025'],
    // A palavra "dia" faz parte da expressão temporal e sai junto: sobrando,
    // virava descrição ("Mercado dia").
    expectActions: [{ kind: 'expense', amount: 50, date: '2025-08-10', description: 'Mercado' }] },
  {
    id: 'esc-02', group: 'temporal', ...other,
    messages: ['gastei 50 daqui a 3 dias', 'Já aconteceu'],
    // "Já aconteceu" é escolha EXPLÍCITA do usuário — só então vale hoje.
    expectActions: [{ kind: 'expense', amount: 50 }] },
  {
    id: 'esc-03', group: 'temporal', ...other,
    messages: ['paguei 100 mês passado', 'dia 10'],
    expectActions: [{ kind: 'expense', amount: 100, date: '2026-06-10' }] },
  {
    id: 'esc-04', group: 'temporal', ...other,
    messages: ['paguei 100 mês passado', 'dia 40'],
    // Uma resposta inválida mantém a pergunta aberta. Nunca descarta a janela
    // temporal e nunca cai no lançamento de hoje.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /dia.*(?:inválido|entre 1 e 30)|que dia/i,
  },
  {
    id: 'esc-05', group: 'temporal', ...other,
    messages: ['paguei 100 mês passado', 'dia 10/07'],
    // Julho está fora da janela de junho. O "10" não pode ser arrancado da
    // data explícita e reinterpretado silenciosamente como 10/06.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /fora.*período|mês passado|que dia/i,
  },

  // ===== SEGUNDA RODADA — defeitos achados sondando o orquestrador =====
  // Todos escritos antes da correção, a partir de `scripts/_dbg.mts`.
  {
    id: 'fut-10', group: 'temporal', ...other,
    messages: ['gastei 50 daqui a 3 dias?'],
    // O ponto de interrogação fazia a guarda temporal ser pulada e a despesa
    // era proposta com a data de HOJE. Perguntar não autoriza gravar errado.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu|planejar/i,
  },
  {
    id: 'fut-11', group: 'temporal', ...other,
    messages: ['gastei 40 amanhã'],
    // "Amanhã" é relativo a hoje: oferecer "foi 16/07/2025" não faz sentido.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu/i,
    forbidReply: [/2025/],
  },
  {
    id: 'fut-12', group: 'temporal', ...other,
    messages: ['gastei 50 na próxima semana'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu|plano/i,
  },
  {
    id: 'fut-13', group: 'temporal', ...other,
    messages: ['mês que vem vou pagar 300'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
  },
  {
    id: 'fut-14', group: 'temporal', ...other,
    messages: ['gastei 80 na semana que vem'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /j[áa] aconteceu|plano/i,
  },
  {
    id: 'fut-15', group: 'temporal', ...other,
    messages: ['gastei 50 na quarta que vem'],
    // Hoje fixo é quarta (15/07): "quarta que vem" é 22/07, nunca hoje.
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /22\/07\/2026/,
  },
  {
    id: 'inv-01', group: 'temporal', ...other,
    messages: ['gastei 50 dia 31/02'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /n[ãa]o existe|inv[áa]lida|data correta/i,
  },
  {
    id: 'inv-02', group: 'temporal', ...other,
    messages: ['gastei 50 dia 40/08'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /n[ãa]o existe|inv[áa]lida|data correta/i,
  },
  {
    id: 'inv-03', group: 'temporal', ...other,
    messages: ['gastei 50 dia 31/02', 'foi 28/02/2026'],
    // A correção reaproveita valor e descrição; o usuário não repete o gasto.
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-02-28' }],
  },
  {
    id: 'hint-01', group: 'temporal', ...other,
    messages: ['gastei 50 em agosto'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /data exata|que dia|planejamento/i,
  },
  {
    id: 'hint-02', group: 'temporal', ...other,
    messages: ['vou pagar 100 em agosto'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)|quando acontecer/i],
  },
  {
    id: 'hint-03', group: 'temporal', ...other,
    messages: ['gastei 50 há 3 dias'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /data exata|que dia/i,
  },
  {
    id: 'hint-04', group: 'temporal', ...other,
    messages: ['gastei 50 3 dias atrás'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /data exata|que dia/i,
  },
  {
    id: 'hint-05', group: 'temporal', ...other,
    messages: ['gastei 50 no fim do mês'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /data exata|que dia/i,
  },
  {
    id: 'hint-06', group: 'temporal', ...other,
    messages: ['paguei 100 ano passado'],
    expectMode: 'clarify', expectNoActions: true,
    expectClarification: /data exata|que dia/i,
  },
  {
    id: 'goal-hint-01', group: 'temporal', ...other,
    messages: ['quero comprar um celular de 5000 em agosto'],
    // Meta não é fato realizado; a barreira temporal não pode bloquear a ação.
    expectActions: [{ kind: 'goal', target: 5000, name: 'celular' }],
  },
  {
    id: 'goal-hint-02', group: 'temporal', ...other,
    messages: ['quero juntar 10000 no fim do ano'],
    expectActions: [{ kind: 'goal', target: 10000 }],
  },
  {
    id: 'mix-01', group: 'temporal', ...other,
    messages: ['ontem gastei 50 e daqui a 3 dias pago mais 100'],
    // Só a segunda expressão temporal ficava solta no texto: o "3" de
    // "daqui a 3 dias" virava uma despesa fantasma de R$ 3,00 datada de ontem.
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-14' }],
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)/i],
    // O plano também não pode virar a DESCRIÇÃO do gasto de ontem.
    forbidReply: [/pago mais/i],
    thenConfirm: s => (s.transactions.length === 1 ? null : `gravou ${s.transactions.length} lançamentos`),
  },
  {
    id: 'mix-02', group: 'temporal', ...other,
    messages: ['gastei 40 hoje e amanhã vou pagar 120'],
    // O registro de hoje é legítimo e continua; o plano de amanhã vira
    // explicação, nunca lançamento — e nunca descrição do lançamento de hoje.
    expectActions: [{ kind: 'expense', amount: 40, date: '2026-07-15' }],
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)/i],
    forbidReply: [/vou pagar 120/i],
  },
  {
    id: 'mix-03', group: 'temporal', ...other,
    messages: ['amanhã vou pagar 120 e ontem gastei 50'],
    // A ordem das duas metades não muda o resultado: o plano é explicado e o
    // fato passado continua disponível para confirmação.
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-14' }],
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)/i],
    forbidReply: [/pagar 120/i],
  },
  {
    id: 'mix-04', group: 'temporal', ...other,
    messages: ['daqui a 3 dias pago 100 e ontem gastei 50'],
    expectActions: [{ kind: 'expense', amount: 50, date: '2026-07-14' }],
    expectReply: [/ainda n[ãa]o sei (?:agendar|registrar)/i],
    forbidReply: [/pago 100/i],
  },
]

export default TEMPORAL
