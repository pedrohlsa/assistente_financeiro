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

  // ===== Gíria de dinheiro não é o objeto do gasto =====
  {
    id: 'rr-13', group: 'registroreal', ...motorista,
    // "Pila" é a moeda, não a compra. Ia parar na descrição do lançamento.
    messages: ['gastei 30 pila no lanche'],
    expectActions: [{ kind: 'expense', amount: 30, category: 'alimentacao', description: 'Lanche' }],
  },
  {
    id: 'rr-14', group: 'registroreal', ...motorista,
    messages: ['gastei 50 conto no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'alimentacao', description: 'Mercado' }],
  },
  {
    id: 'rr-15', group: 'registroreal', ...motorista,
    messages: ['80 pila de gasolina'],
    expectActions: [{ kind: 'fuel', amount: 80 }],
  },

  // ===== Erro de digitação não pode trocar a categoria =====
  {
    id: 'rr-16', group: 'registroreal', ...motorista,
    // Ia para "outros-out" e sumia do custo de combustível do motorista.
    messages: ['paguei 80 de gazolina'],
    expectActions: [{ kind: 'fuel', amount: 80 }],
  },
  {
    id: 'rr-17', group: 'registroreal', ...motorista,
    messages: ['botei 60 de alcool'],
    expectActions: [{ kind: 'fuel', amount: 60 }],
  },
  {
    id: 'rr-18', group: 'registroreal', ...naoMotorista,
    messages: ['gastei 45 no mercadinho'],
    expectActions: [{ kind: 'expense', amount: 45, category: 'alimentacao' }],
  },

  // ===== Valores enumerados sem descrição própria =====
  {
    id: 'rr-19', group: 'registroreal', ...naoMotorista,
    // Virava UMA despesa de 20 com a descrição "30": o segundo valor sumia
    // dentro do texto do primeiro lançamento.
    messages: ['gastei 20 e 30'],
    expectActions: [
      // Um número nunca é a descrição de um gasto.
      { kind: 'expense', amount: 20, description: null },
      { kind: 'expense', amount: 30, description: null },
    ],
  },
  {
    id: 'rr-20', group: 'registroreal', ...naoMotorista,
    // Guarda da vírgula decimal: 1.234,56 é UM valor, não 1.234 e 56.
    messages: ['gastei 1.234,56 no mercado'],
    expectActions: [{ kind: 'expense', amount: 1234.56, category: 'alimentacao' }],
  },

  // ===== Substantivo e valor, sem verbo nenhum =====
  {
    id: 'rr-21', group: 'registroreal', ...naoMotorista,
    messages: ['almoço 25'],
    expectActions: [{ kind: 'expense', amount: 25, category: 'alimentacao' }],
  },
  {
    id: 'rr-22', group: 'registroreal', ...naoMotorista,
    messages: ['25 no almoço'],
    expectActions: [{ kind: 'expense', amount: 25, category: 'alimentacao' }],
  },
  {
    id: 'rr-23', group: 'registroreal', ...naoMotorista,
    messages: ['lanche 15 e cafe 5'],
    expectActions: [
      { kind: 'expense', amount: 15, category: 'alimentacao' },
      { kind: 'expense', amount: 5, category: 'alimentacao' },
    ],
  },
  {
    id: 'rr-24', group: 'registroreal', ...naoMotorista,
    // O valor vem DEPOIS do substantivo, sem preposição nenhuma no meio.
    messages: ['paguei o aluguel 900'],
    expectActions: [{ kind: 'expense', amount: 900, category: 'casa' }],
  },

  // ===== As guardas do que já funcionava =====
  {
    id: 'rr-25', group: 'registroreal', ...motorista,
    // "14 viagens" é quantidade, não dinheiro: não pode virar receita de 14.
    messages: ['fiz 14 viagens'],
    expectActions: [{ kind: 'work', trips: 14 }],
  },
  {
    id: 'rr-26', group: 'registroreal', ...motorista,
    messages: ['rodei 120 km'],
    expectActions: [{ kind: 'work', km: 120 }],
  },
  {
    id: 'rr-27', group: 'registroreal', ...naoMotorista,
    // Perguntar quanto PODE gastar não é dizer que gastou. A regra sem verbo
    // registrava a pergunta como despesa de 50.
    messages: ['posso gastar 50 no mercado?'],
    expectNoActions: true,
  },
  {
    id: 'rr-28', group: 'registroreal', ...naoMotorista,
    messages: ['da pra gastar 80 hoje no lanche?'],
    expectNoActions: true,
  },

  // ===== Corrigir sem ter o que corrigir não cria lançamento =====
  {
    id: 'rr-29', group: 'registroreal', ...naoMotorista,
    // Sem nada na tela para corrigir, "na verdade foi 200" criava uma despesa
    // de R$ 200 do nada: a frase de CORREÇÃO virava registro novo.
    messages: ['na verdade foi 200'],
    expectNoActions: true,
  },
  {
    id: 'rr-30', group: 'registroreal', ...naoMotorista,
    messages: ['me enganei foi 50'],
    expectNoActions: true,
  },
  {
    id: 'rr-31', group: 'registroreal', ...naoMotorista,
    // A correção sobre uma proposta na tela continua funcionando.
    messages: ['gastei 100 no mercado', 'na verdade foi 80'],
    expectActions: [{ kind: 'expense', amount: 80, category: 'alimentacao' }],
  },
]

export default REGISTRO_REAL
