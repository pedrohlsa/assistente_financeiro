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
const assalariado = { profile: 'clt' as const }
const autonomo = { profile: 'autonomo' as const }

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

  // ===== Conta que se repete não é gasto de hoje (regra 18) =====
  {
    id: 'rr-32', group: 'registroreal', ...naoMotorista,
    // Virava despesa avulsa de 90 com a descrição "Pago de internet todo mes":
    // inflava o mês com um valor que é PREVISÃO, não movimentação realizada.
    messages: ['pago 90 de internet todo mes'],
    expectNoActions: true,
    expectReply: [/planejamento/i],
  },
  {
    id: 'rr-33', group: 'registroreal', ...naoMotorista,
    messages: ['minha internet e 90 por mes'],
    expectNoActions: true,
    expectReply: [/planejamento/i],
  },
  {
    id: 'rr-34', group: 'registroreal', ...naoMotorista,
    // Sem marca de repetição, gasto é gasto: a guarda não pode engolir isso.
    messages: ['gastei 90 de internet'],
    expectActions: [{ kind: 'expense', amount: 90 }],
  },
  {
    id: 'rr-35', group: 'registroreal', ...motorista,
    // "Todo dia" descrevendo a rotina de trabalho não é conta a pagar.
    messages: ['rodei 120 km'],
    expectActions: [{ kind: 'work', km: 120 }],
  },

  // ===== A meta guarda o nome que o usuário deu =====
  {
    id: 'rr-36', group: 'registroreal', ...motorista,
    // Virava uma meta chamada "Objetivo": o nome dito ia embora, e a lista de
    // metas fica ilegível quando todas se chamam a mesma coisa.
    messages: ['quero juntar 5000 pra uma moto'],
    expectActions: [{ kind: 'goal', target: 5000, name: /moto/i }],
  },
  {
    id: 'rr-37', group: 'registroreal', ...motorista,
    messages: ['meta de 10 mil pro carro'],
    expectActions: [{ kind: 'goal', target: 10000, name: /carro/i }],
  },
  {
    id: 'rr-38', group: 'registroreal', ...naoMotorista,
    // Sem meta "Viagem" cadastrada, guardar PARA ela é ambíguo entre criar a
    // meta e mandar para a reserva — e o app já pergunta em vez de escolher.
    messages: ['quero guardar 2000 para a viagem'],
    expectMode: 'clarify',
    expectClarification: /viagem|reserva/i,
  },

  // ===== Parcelamento sem dizer o que foi comprado =====
  {
    id: 'rr-39', group: 'registroreal', ...naoMotorista,
    state: { cards: [{ name: 'Nubank' }] },
    // Sem um item descrito ("passei UM PC de 4000"), o valor não era achado e
    // a compra parcelada inteira se perdia.
    messages: ['passei 1200 no nubank em 3x'],
    expectActions: [{ kind: 'card-purchase', total: 1200, installments: 3, cardName: 'nubank' }],
  },
  {
    id: 'rr-40', group: 'registroreal', ...naoMotorista,
    state: { cards: [{ name: 'Nubank' }] },
    messages: ['parcelei 1200 em 3x no nubank'],
    expectActions: [{ kind: 'card-purchase', total: 1200, installments: 3 }],
  },
  {
    id: 'rr-41', group: 'registroreal', ...naoMotorista,
    state: { cards: [{ name: 'Nubank' }] },
    // A guarda da regra 11: com "recebi" continua sendo entrada financiada,
    // nunca uma compra e nunca receita.
    messages: ['passei 2000 em 5x e recebi 1850'],
    expectActions: [{ kind: 'financed-cash-inflow', total: 2000, netReceived: 1850 }],
  },

  // ===== Saldo dito de outro jeito =====
  {
    id: 'rr-66', group: 'registroreal', ...naoMotorista,
    // Respondia "Nenhuma conta fixa vence nos próximos 15 dias": a palavra
    // "conta" puxava a pergunta de contas a pagar, e o usuário estava
    // informando o SALDO.
    messages: ['to com 3000 na conta'],
    expectActions: [{ kind: 'balance', amount: 3000 }],
  },
  {
    id: 'rr-67', group: 'registroreal', ...naoMotorista,
    messages: ['estou com 1500 no banco'],
    expectActions: [{ kind: 'balance', amount: 1500 }],
  },
  {
    id: 'rr-68', group: 'registroreal', ...naoMotorista,
    // Gíria de guardar dinheiro.
    messages: ['joguei 200 na poupanca'],
    expectActions: [{ kind: 'saving', amount: 200 }],
  },

  // ===== Valor aproximado: "uns 50", "cerca de 200" =====
  {
    id: 'rr-61', group: 'registroreal', ...naoMotorista,
    // O "uns" entre o verbo e o número fazia o parser não achar o valor, e o
    // gasto inteiro se perdia. É como se fala quando não se lembra o centavo.
    messages: ['gastei uns 50'],
    expectActions: [{ kind: 'expense', amount: 50 }],
  },
  {
    id: 'rr-62', group: 'registroreal', ...naoMotorista,
    messages: ['paguei uns 200 no mercado'],
    expectActions: [{ kind: 'expense', amount: 200, category: 'alimentacao' }],
  },
  {
    id: 'rr-63', group: 'registroreal', ...motorista,
    messages: ['botei mais ou menos 80 de gasolina'],
    expectActions: [{ kind: 'fuel', amount: 80 }],
  },

  // ===== Compra sem valor: perguntar, guardando o que já foi dito =====
  {
    id: 'rr-64', group: 'registroreal', ...naoMotorista,
    messages: ['comprei uma tv'],
    expectMode: 'clarify',
    expectClarification: /valor/i,
  },
  {
    id: 'rr-65', group: 'registroreal', ...naoMotorista,
    // A descrição dita no primeiro turno não pode se perder no caminho.
    messages: ['comprei uma tv', '3000'],
    expectActions: [{ kind: 'expense', amount: 3000, description: /tv/i }],
  },

  // ===== Duas receitas de fontes diferentes na mesma frase =====
  {
    id: 'rr-58', group: 'registroreal', ...autonomo,
    // Registrava só os 1.800: a enumeração de receitas exigia "da/do" e a
    // preposição mais comum é "DE" — a segunda entrada sumia em silêncio.
    messages: ['recebi 1800 de aluguel e 900 de um freela'],
    expectActions: [
      { kind: 'income', amount: 1800, category: 'aluguel' },
      { kind: 'income', amount: 900, category: 'freelance' },
    ],
  },
  {
    id: 'rr-59', group: 'registroreal', ...autonomo,
    messages: ['recebi 1200 da casa 1 e 800 da casa 2'],
    expectActions: [
      { kind: 'income', amount: 1200 },
      { kind: 'income', amount: 800 },
    ],
  },

  // ===== Registro sem valor, quando o texto tem número que NÃO é dinheiro ==
  {
    id: 'rr-60', group: 'registroreal', ...autonomo,
    // O "1" de "casa 1" fazia a guarda achar que havia valor na frase, e o
    // pedido caía no texto genérico de ajuda em vez de perguntar quanto foi.
    messages: ['recebi o aluguel da casa 1'],
    expectMode: 'clarify',
    expectClarification: /valor/i,
  },

  // ===== Manutenção sem intervalo informado nunca está "vencida" =====
  {
    id: 'rr-54', group: 'registroreal', ...motorista,
    // O assistente grava `lifeKm: 0` quando o usuário não diz de quantos em
    // quantos km troca — e é o normal, porque a frase sugerida no próprio app
    // ("troquei o óleo por 280 com 84 mil km") não pede isso. O lembrete então
    // fazia 84000 + 0 e anunciava que a troca RECÉM-FEITA já estava vencida.
    state: {
      vehicle: { odometer: 85000 },
      maintenance: [{ name: 'Óleo', cost: 250, kmInstalled: 85000, lifeKm: 0, date: '2026-07-15' }],
    },
    messages: ['quando tenho que trocar o oleo'],
    expectNoActions: true,
    forbidReply: [/vencida/i],
    expectReply: [/[óo]leo/i, /intervalo|de quantos em quantos/i],
  },
  {
    id: 'rr-55', group: 'registroreal', ...motorista,
    // Com o intervalo informado, o lembrete continua igual.
    state: {
      vehicle: { odometer: 85000 },
      maintenance: [{ name: 'Óleo', cost: 250, kmInstalled: 80000, lifeKm: 10000, date: '2026-05-10' }],
    },
    messages: ['quando tenho que trocar o oleo'],
    expectReply: [/90\.000 km/, /faltam/i],
    forbidReply: [/vencida/i],
  },
  {
    id: 'rr-56', group: 'registroreal', ...motorista,
    // Vencida de verdade continua sendo avisada — a guarda não pode esconder
    // manutenção realmente atrasada.
    state: {
      vehicle: { odometer: 95000 },
      maintenance: [{ name: 'Óleo', cost: 250, kmInstalled: 80000, lifeKm: 10000, date: '2026-05-10' }],
    },
    messages: ['quando tenho que trocar o oleo'],
    expectReply: [/vencida/i],
  },

  {
    id: 'rr-57', group: 'registroreal', ...motorista,
    // Quem sabe o intervalo é o usuário. Ouvir quando ele diz é o que faz o
    // lembrete de troca poder existir.
    messages: ['troquei o oleo por 250 com 85000 km e troco a cada 10 mil km'],
    expectActions: [{ kind: 'maintenance', item: 'óleo', cost: 250, km: 85000, lifeKm: 10000 }],
    expectReply: [/a cada 10\.000 km/],
  },

  // ===== Valor grande precisa ser LEGÍVEL na hora de confirmar =====
  {
    id: 'rr-51', group: 'registroreal', ...assalariado,
    // A proposta escrevia "R$ 3200,00" — sem separador de milhar. É a tela
    // onde o usuário confere antes de gravar, e "R$ 15000,00" se lê errado
    // com muito mais facilidade que "R$ 15.000,00".
    messages: ['meu salario caiu hoje 3200'],
    expectActions: [{ kind: 'income', amount: 3200 }],
    expectReply: [/R\$\s*3\.200,00/],
  },
  {
    id: 'rr-52', group: 'registroreal', ...naoMotorista,
    state: { cards: [{ name: 'Nubank' }] },
    messages: ['comprei uma geladeira de 4500 em 10x no nubank'],
    expectReply: [/R\$\s*4\.500,00/],
  },
  {
    id: 'rr-53', group: 'registroreal', ...motorista,
    // A proposta escrevia "1 viagens". A viagem precisa ser DITA (regra 34).
    messages: ['fiz uma corrida de 25'],
    expectReply: [/1 viagem\b/],
    forbidReply: [/1 viagens/],
  },

  // ===== Dinheiro que "cai" na conta =====
  {
    id: 'rr-45', group: 'registroreal', ...assalariado,
    // "Caiu" é o verbo mais natural para salário e pagamento, e não estava
    // entre os verbos de receita do parser: a entrada inteira se perdia.
    messages: ['meu salario caiu hoje 3200'],
    expectActions: [{ kind: 'income', amount: 3200, category: 'salario' }],
  },
  {
    id: 'rr-46', group: 'registroreal', ...naoMotorista,
    messages: ['caiu 500 na conta hoje'],
    expectActions: [{ kind: 'income', amount: 500 }],
  },
  {
    id: 'rr-47', group: 'registroreal', ...naoMotorista,
    messages: ['entrou 800 ontem'],
    expectActions: [{ kind: 'income', amount: 800, date: '2026-07-14' }],
  },

  // ===== Registro começado sem o valor: perguntar, não oferecer ajuda =====
  {
    id: 'rr-48', group: 'registroreal', ...assalariado,
    // Caía no texto genérico de ajuda — o usuário começou a registrar e o app
    // respondia como se não tivesse entendido nada.
    messages: ['recebi o salario'],
    expectMode: 'clarify',
    expectClarification: /valor/i,
  },
  {
    id: 'rr-49', group: 'registroreal', ...assalariado,
    // E a resposta seguinte completa o registro.
    messages: ['recebi o salario', '3200'],
    expectActions: [{ kind: 'income', amount: 3200 }],
  },
  {
    id: 'rr-50', group: 'registroreal', ...naoMotorista,
    // Pergunta com o mesmo verbo NÃO pode virar rascunho de registro.
    messages: ['quanto eu gastei essa semana'],
    expectNoActions: true,
    forbidReply: [/qual foi o valor/i],
  },

  // ===== Jornada colada na distância =====
  {
    id: 'rr-44', group: 'registroreal', ...motorista,
    // As 10 horas se perdiam: nenhum padrão cobria "em N horas" depois do km,
    // e a jornada é o que dá o lucro por hora do motorista.
    messages: ['rodei 200 km em 10 horas'],
    expectActions: [{ kind: 'work', km: 200, hours: 10 }],
  },

  // ===== Dois dias na mesma mensagem =====
  {
    id: 'rr-42', group: 'registroreal', ...motorista,
    // Registrava só os 280 de ontem; o "hoje 320" sumia sem aviso nenhum. Perda
    // silenciosa é o pior desfecho: o usuário acha que lançou os dois.
    messages: ['ontem fiz 280 e hoje 320'],
    expectActions: [
      { kind: 'income', amount: 280, date: '2026-07-14' },
      { kind: 'income', amount: 320, date: '2026-07-15' },
    ],
  },
  {
    id: 'rr-43', group: 'registroreal', ...naoMotorista,
    messages: ['ontem gastei 50 e hoje gastei 80'],
    expectActions: [
      { kind: 'expense', amount: 50, date: '2026-07-14' },
      { kind: 'expense', amount: 80, date: '2026-07-15' },
    ],
  },
]

export default REGISTRO_REAL
