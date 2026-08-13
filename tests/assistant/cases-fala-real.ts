// Corpus FALA REAL — a pergunta como o usuário DIGITA, não como o manual escreve.
//
// Motivo deste arquivo: uma auditoria manual mediu 9/10 de acerto com a frase
// "de manual" e apenas 2/10 com a frase real ("como ta meu mes", "quanto eu
// tenho", "quanto falta pra minha moto"). Tudo o que não casava caía no texto
// genérico de ajuda e ia parar na IA remota — contra a regra do projeto de que
// pergunta factual é SEMPRE respondida localmente, com dado real.
//
// A asserção destes casos é sempre a mesma: a resposta NÃO pode ser o texto
// genérico de ajuda. É isso que detecta a regressão do roteador.

import type { AssistantCase } from './harness'

const AJUDA_GENERICA = /Posso te ajudar com coisas como/i

const motorista = {
  profile: 'driver' as const,
  state: {
    balance: 1200,
    goals: [{ name: 'Moto', target: 12000, saved: 2000 }],
    transactions: [
      { id: 'r1', type: 'income', amount: 380, category: 'corridas', date: '2026-07-14' },
      { id: 'r2', type: 'expense', amount: 90, category: 'combustivel', date: '2026-07-14' },
    ],
  },
}

const q = (id: string, message: string, extra: Partial<AssistantCase> = {}): AssistantCase => ({
  id, group: 'falareal', ...motorista, messages: [message],
  expectNoActions: true,
  forbidReply: [AJUDA_GENERICA],
  ...extra,
})

export const FALA_REAL: AssistantCase[] = [
  // ===== Abreviação de conversa: "ta", "to", "pra", "hj", "qnt" =====
  q('fr-01', 'como ta meu mes'),
  q('fr-02', 'quanto da pra gastar hoje'),
  q('fr-03', 'qnt eu posso gastar hj'),
  q('fr-04', 'to ganhando mais que mes passado?'),

  // ===== Sem acento nenhum, como se digita no celular =====
  q('fr-05', 'qual meu saldo'),
  q('fr-06', 'quanto eu ja gastei de gasolina esse mes'),
  q('fr-07', 'qual foi meu maior gasto'),

  // ===== Sinônimo e gíria =====
  q('fr-08', 'quanto eu tenho'),
  q('fr-09', 'qual dia eu fiz mais grana'),
  q('fr-10', 'quanto sai o km do meu carro'),

  // ===== Meta pelo NOME, não pela palavra "meta" =====
  q('fr-11', 'quanto falta pra minha moto', { expectReply: [/moto/i] }),
  // A mesma pergunta pelo outro lado: quem pergunta o progresso tanto faz se
  // pede o que falta ou o que já tem. A resposta agora diz os dois.
  q('fr-11b', 'quanto ja juntei da moto', { expectReply: [/moto/i, /2\.000,00/] }),

  // ===== A forma do manual continua funcionando =====
  q('fr-12', 'como está meu mês?'),
  q('fr-13', 'quanto posso gastar hoje?'),
  q('fr-14', 'qual foi meu melhor dia?'),

  // ===== A normalização NÃO pode transformar registro em pergunta =====
  {
    id: 'fr-15', group: 'falareal', ...motorista,
    messages: ['ganhei 200 hj'],
    expectActions: [{ kind: 'income', amount: 200 }, { kind: 'work', trips: 1 }],
  },
  {
    id: 'fr-16', group: 'falareal', ...motorista,
    // "conto" vira "reais" na normalização da PERGUNTA, mas o registro lê o
    // texto original — o valor não pode se perder no caminho.
    messages: ['fiz 300 conto hoje'],
    expectActions: [{ kind: 'income', amount: 300 }, { kind: 'work', trips: 1 }],
  },
  {
    id: 'fr-17', group: 'falareal', ...motorista,
    messages: ['gastei 50 no merkado'],
    expectActions: [{ kind: 'expense', amount: 50 }],
  },

  // ===== Perguntas que o app SABE responder e mandava para o texto de ajuda =====
  // Todas caem em `resolveLocal`: são conta feita sobre o próprio estado, e a
  // regra do projeto é que pergunta factual nunca vai para a IA remota.
  q('fr-18', 'quanto eu preciso fazer hoje ainda', { expectReply: [/falta/i] }),
  q('fr-19', 'quanto eu gastei essa semana'),
  q('fr-20', 'quanto eu gastei ontem'),
  q('fr-21', 'quanto to gastando de gasolina por dia'),
  q('fr-22', 'to no lucro esse mes?'),
  q('fr-23', 'quanto sobrou'),
  // A pergunta mais direta que existe sobre a saúde do mês, e caía na ajuda.
  q('fr-25', 'to gastando mais do que ganho?'),
  q('fr-26', 'gasto mais do que recebo'),
  {
    id: 'fr-24', group: 'falareal', ...motorista,
    // Pergunta central de motorista. Além do texto de ajuda, caía no "não
    // tenho certeza do que registrar" — a pergunta virava tentativa de
    // registro, que é o pior desfecho possível.
    messages: ['vale a pena corrida de 8 reais'],
    expectNoActions: true,
    forbidReply: [AJUDA_GENERICA, /n[ãa]o tenho certeza do que registrar/i],
    expectReply: [/km/i],
  },
]

export default FALA_REAL
