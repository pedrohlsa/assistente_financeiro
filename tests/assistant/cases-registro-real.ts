// Corpus REGISTRO REAL — o motorista relatando o dia como ele fala de verdade.
//
// O corpus `cases-fala-real.ts` cobre PERGUNTAS. Este cobre REGISTRO: a forma
// como o dinheiro é relatado quando ninguém está seguindo o manual.
//
// Motivo deste arquivo: uma auditoria mediu que a classe inteira de "resultado
// do dia" não registrava nada. Quem roda o dia todo não escreve "ganhei 150" —
// escreve "hoje foi fraco só 150", "deu 200 hoje", "fechei o dia com 280". Pior:
// "foi 400 hoje" caía no verbo de DESPESA e registrava o faturamento do dia como
// gasto, invertendo o sinal do dinheiro.

import type { AssistantCase } from './harness'

const motorista = { profile: 'driver' as const }
const naoMotorista = { profile: 'other' as const }

export const REGISTRO_REAL: AssistantCase[] = [
  // ===== Resultado do dia sem verbo de ganho explícito =====
  {
    id: 'rr-01', group: 'registroreal', ...motorista,
    messages: ['hoje foi fraco so 150 reais 8 horas na rua'],
    expectActions: [
      { kind: 'income', amount: 150, category: 'corridas' },
      // Nada foi dito sobre viagens: inventar "1 viagem" para um dia inteiro
      // estragaria o ganho por viagem do motorista.
      { kind: 'work', hours: 8, trips: null },
    ],
  },
  {
    id: 'rr-02', group: 'registroreal', ...motorista,
    messages: ['deu 200 hoje'],
    expectActions: [{ kind: 'income', amount: 200, category: 'corridas' }],
  },
  {
    id: 'rr-03', group: 'registroreal', ...motorista,
    messages: ['fechei o dia com 280'],
    expectActions: [{ kind: 'income', amount: 280, category: 'corridas' }],
  },
  {
    id: 'rr-04', group: 'registroreal', ...motorista,
    messages: ['dia bom hoje 320'],
    expectActions: [{ kind: 'income', amount: 320, category: 'corridas' }],
  },
  {
    id: 'rr-05', group: 'registroreal', ...motorista,
    messages: ['so 90 reais hoje'],
    expectActions: [{ kind: 'income', amount: 90, category: 'corridas' }],
  },
  {
    id: 'rr-06', group: 'registroreal', ...motorista,
    messages: ['tirei 300 liquido hoje'],
    expectActions: [{ kind: 'income', amount: 300, category: 'corridas' }],
  },
  {
    id: 'rr-07', group: 'registroreal', ...motorista,
    messages: ['rodei o dia todo e deu 180'],
    expectActions: [{ kind: 'income', amount: 180, category: 'corridas' }],
  },

  // ===== O sinal do dinheiro nunca pode se inverter =====
  {
    id: 'rr-08', group: 'registroreal', ...motorista,
    // "foi" é verbo de despesa no parser. Para o motorista relatando o dia é o
    // FATURAMENTO. Registrar como gasto invertia o sinal do dinheiro.
    messages: ['foi 400 hoje 12 horas'],
    expectActions: [
      { kind: 'income', amount: 400, category: 'corridas' },
      { kind: 'work', hours: 12, trips: null },
    ],
  },
  {
    id: 'rr-09', group: 'registroreal', ...motorista,
    // Verbo de gasto explícito manda: nunca vira receita.
    messages: ['gastei 200 hoje'],
    expectActions: [{ kind: 'expense', amount: 200 }],
  },
  {
    id: 'rr-10', group: 'registroreal', ...motorista,
    messages: ['paguei 90 hoje de gasolina'],
    expectActions: [{ kind: 'fuel', amount: 90 }],
  },

  // ===== Valor solto é ambíguo: perguntar, nunca adivinhar =====
  {
    id: 'rr-11', group: 'registroreal', ...motorista,
    // Só uma palavra de dia e um número: nada indica ganho nem gasto.
    messages: ['hoje 250'],
    expectMode: 'clarify',
    expectClarification: /ganhou|ganho|gasto|gastou/i,
  },

  // ===== A regra é do motorista, não do app inteiro =====
  {
    id: 'rr-12', group: 'registroreal', ...naoMotorista,
    // Quem não roda não tem "resultado do dia" de corridas — o palpite seria
    // pura invenção.
    messages: ['deu 200 hoje'],
    expectNoActions: true,
  },
]

export default REGISTRO_REAL
