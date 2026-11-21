// CORPUS DO CHAT REMOTO — parte A: linguagem, ambiguidade e modalidade.
//
// Contrato de produção: a mensagem vai para `handleAssistantRequest` com o
// contexto de `buildAiContext` do estado sintético, exatamente como o passo 16
// do orquestrador faz quando sobra cláusula sem resposta local.
//
// Quase todas as frases daqui CHEGAM ao chat remoto em produção (medido sem
// rede). As marcadas `local` ou `local-errada` são respondidas pelo motor
// local hoje: estão aqui para medir o modelo como defesa em profundidade, e o
// relatório as separa.
//
// Ação sem data no gabarito é conferida como HOJE — a regra 7 do prompt manda
// omitir a data de hoje, e uma data inventada é erro financeiro.

import { AUSENTE, umDe } from './types'
import type { AcaoOuro, CasoChat, Dimensao, Esperado, Historico, IntencaoChat, OuroChat, PerfilEval, RotaProducao } from './types'

const COM_DATA = ['income', 'expense', 'saving', 'fuel', 'work']

/** Mais de uma intenção igualmente certa. */
export const intencoes = (...i: IntencaoChat[]): { umDe: IntencaoChat[] } => ({ umDe: i })

export const acao = (kind: string, campos: Record<string, Esperado>): AcaoOuro =>
  ({ kind, campos: COM_DATA.includes(kind) && !('date' in campos) ? { ...campos, date: '@hoje' } : campos })

export function casoChat(
  id: string, perfil: PerfilEval, dimensao: Dimensao, rota: RotaProducao,
  mensagem: string, porque: string, ouro: OuroChat, historico?: Historico,
): CasoChat {
  return { id, suite: 'chat', perfil, dimensao, rota, mensagem, porque, ouro, historico }
}

export const CASOS_CHAT_A: CasoChat[] = [
  // ===== Linguagem de verdade: autocorreção, voz, interrupção ==============
  casoChat('c-01', 'autonomo', 'linguagem', 'remota',
    'coloquei na reserva quinhentos reais digo quatrocentos',
    'autocorreção falada no meio da frase: propor os 500 é registrar o valor que o usuário corrigiu',
    { intencao: 'registrar', acoes: [acao('saving', { amount: 400 })] }),
  casoChat('c-02', 'autonomo', 'linguagem', 'remota',
    'paguei o pedreiro 600 conto e mais 180 de areia',
    'gíria de dinheiro + duas despesas coladas por "e mais"; o motor local não entende nenhuma das duas',
    {
      intencao: 'registrar',
      acoes: [
        acao('expense', { amount: 600, category: umDe('obra', 'casa') }),
        acao('expense', { amount: 180, category: 'obra' }),
      ],
    }),
  casoChat('c-03', 'autonomo', 'linguagem', 'remota',
    'comprei tv 2500 10 vezes nubank',
    'telegráfico: total, parcelas e cartão sem nenhuma preposição',
    { intencao: 'registrar', acoes: [acao('card-purchase', { total: 2500, installments: 10, cardName: 'Nubank' })], tiposProibidos: ['expense'] }),
  casoChat('c-04', 'autonomo', 'linguagem', 'remota',
    'recebi mil e oitocentos da casa um vírgula e paguei ponto final trezentos e vinte de luz',
    'transcrição de voz com a pontuação falada; "casa um" é a origem Casa 1',
    {
      intencao: 'registrar',
      acoes: [
        acao('income', { amount: 1800, category: umDe('aluguel', 'outros-in'), origin: umDe('Casa 1', 'casa um', null) }),
        acao('expense', { amount: 320, category: 'casa' }),
      ],
    }),
  casoChat('c-05', 'autonomo', 'linguagem', 'local',
    'gastei 80 no... não, espera, foi no posto, 80 de gasolina',
    'frase interrompida e retomada; gasolina de quem NÃO é motorista é despesa comum, nunca abastecimento',
    { intencao: 'registrar', acoes: [acao('expense', { amount: 80, category: umDe('combustivel', 'outros-out') })], tiposProibidos: ['fuel'] }),
  // 27/10/2026: "transferi … pra minha poupança" agora é reserva no aparelho (conferido).
  casoChat('c-06', 'other', 'linguagem', 'local',
    'transferi 300 pra minha poupança',
    'transferência para reserva não é receita nem despesa (regra 5)',
    { intencao: 'registrar', acoes: [acao('saving', { amount: 300 })], tiposProibidos: ['expense', 'income'] }),
  // 27/10/2026: "vendi … por N" agora é receita em Vendas no aparelho (conferido).
  casoChat('c-07', 'autonomo', 'linguagem', 'local',
    'vendi a bicicleta velha por 350',
    'venda avulsa é entrada, e o motor local não reconhece "vendi"',
    { intencao: 'registrar', acoes: [acao('income', { amount: 350, category: umDe('vendas', 'outros-in') })] }),
  casoChat('c-08', 'autonomo', 'linguagem', 'remota',
    'o inquilino da casa 2 pagou com 3 dias de atraso 1200',
    'o atraso é do vencimento, não da data do recebimento: a data continua sendo hoje',
    { intencao: 'registrar', acoes: [acao('income', { amount: 1200, category: 'aluguel', origin: umDe('Casa 2', 'casa 2') })] }),
  casoChat('c-09', 'autonomo', 'linguagem', 'remota',
    'recebi 900 do projeto elétrico e 650 do reparo mas o de 650 foi mês passado',
    'uma entrada de hoje e outra de um dia NÃO dito do mês passado: datar é chutar',
    {
      intencao: 'perguntar',
      acoes: [acao('income', { amount: 900 })],
      perguntaSobre: /dia|data|quando|650/i,
    }),
  casoChat('c-10', 'motorista', 'linguagem', 'remota',
    'hj rodei o dia todo mas nao lembro qnt fiz so sei q abasteci 120',
    'o faturamento não foi dito: inventar um valor de corrida é o erro mais caro do motorista',
    {
      intencao: intencoes('registrar', 'perguntar', 'registrar-e-responder'),
      acoes: [acao('fuel', { amount: 120 })],
    }),
  casoChat('c-11', 'clt', 'linguagem', 'local',
    'o banco me cobrou 45 de tarifa e 12 de iof sem eu saber',
    'duas cobranças, reclamação no meio; a reclamação não vira terceira ação',
    { intencao: intencoes('registrar', 'registrar-e-responder'), acoes: [acao('expense', { amount: 45 }), acao('expense', { amount: 12 })] }),

  // ===== Ambiguidade: o modelo BOM pergunta ================================
  casoChat('c-12', 'autonomo', 'ambiguidade', 'remota',
    'é que assim né eu fui no mercado e tal e deu 230 mas metade era da minha irmã',
    'registrar 230 ou só a metade é decisão do usuário, não do modelo',
    { intencao: 'perguntar', acoes: [], perguntaSobre: /metade|115|230|irm[ãa]|tudo/i }),
  casoChat('c-13', 'other', 'ambiguidade', 'local',
    'passei 300 no cartão',
    'dois cartões e nenhuma parcela: compra no cartão nunca é despesa (regra 10), e escolher o cartão é chutar',
    { intencao: 'perguntar', acoes: [], perguntaSobre: /cart[ãa]o|nubank|inter|parcela|vezes/i, tiposProibidos: ['expense'] }),
  casoChat('c-14', 'other', 'ambiguidade', 'remota',
    'emprestei 500 pro meu irmão',
    'empréstimo não tem tipo próprio: perguntar, ou registrar a saída dos 500 — nunca outro valor',
    { intencao: intencoes('perguntar', 'registrar'), acoes: [], alternativas: [[acao('expense', { amount: 500 })]], tiposProibidos: ['income', 'saving'] }),
  casoChat('c-15', 'autonomo', 'ambiguidade', 'remota',
    'acho q gastei uns 190 de cimento mas n tenho ctz',
    'dúvida declarada: confirmar os 190 ou perguntar; propor outro valor é inventar',
    {
      intencao: intencoes('perguntar', 'registrar'),
      acoes: [],
      alternativas: [[acao('expense', { amount: 190, category: 'obra' })]],
    }),
  casoChat('c-16', 'other', 'ambiguidade', 'local',
    'coloquei 200 na meta',
    'duas metas (Moto, Viagem): tem que perguntar qual; até 15/09/2026 o motor local fazia uma DESPESA de 200, hoje pergunta com as metas como opção',
    { intencao: 'perguntar', acoes: [], perguntaSobre: /moto|viagem|qual meta/i, tiposProibidos: ['expense'] }),
  casoChat('c-17', 'other', 'ambiguidade', 'local',
    'paguei a fatura',
    'dois cartões e nenhum valor',
    {
      intencao: 'perguntar', acoes: [], perguntaSobre: /nubank|inter|qual cart/i,
      alternativas: [[acao('card-payment', { cardName: AUSENTE })]],
      tiposProibidos: ['expense'],
    }),
  casoChat('c-18', 'other', 'ambiguidade', 'local',
    'gastei 79 de gás',
    'gás de cozinha ou GNV — regra 10 do prompt, sem escolher categoria',
    {
      intencao: 'perguntar', acoes: [], perguntaSobre: /cozinha|gnv/i,
      alternativas: [[acao('expense', { amount: 79, category: umDe('outros-out', null) })]],
      tiposProibidos: ['fuel'],
    }),
  casoChat('c-19', 'other', 'ambiguidade', 'local',
    'comprei uma geladeira',
    'sem valor e sem forma de pagamento: perguntar só o que falta',
    { intencao: 'perguntar', acoes: [], perguntaSobre: /valor|quanto|pre[çc]o|pag/i }),
  // 18/09/2026: rótulo velho — resolvido certo no aparelho desde a rodada de integridade de valor
  casoChat('c-20', 'autonomo', 'ambiguidade', 'local',
    'guardei 300 na meta da viagem e 200 na outra',
    '"a outra" tem UM referente possível (Notebook); o local criou uma meta chamada "Viagem e 200 na outra"',
    {
      intencao: intencoes('registrar', 'perguntar'),
      acoes: [acao('goal-deposit', { name: 'Viagem', amount: 300 }), acao('goal-deposit', { name: 'Notebook', amount: 200 })],
      alternativas: [[acao('goal-deposit', { name: 'Viagem', amount: 300 })]],
    }),

  // ===== Modalidade: hipótese, futuro e negação que chegam ao chat ==========
  casoChat('c-21', 'autonomo', 'modalidade', 'remota',
    'vou receber 1800 da casa 1 dia 5',
    'futuro nunca vira movimentação realizada (regra 18)',
    { intencao: 'responder', acoes: [], tiposProibidos: ['income'] }),
  casoChat('c-22', 'autonomo', 'modalidade', 'local',
    'nao foi 500 na obra nao, nem gastei nada hoje',
    'negação dupla, sem nenhuma proposta na tela',
    { intencao: 'responder', acoes: [], tiposProibidos: ['expense'] }),
  casoChat('c-23', 'autonomo', 'modalidade', 'remota',
    'e se em vez de 10x eu fizer 12 dando mil de entrada?',
    'hipótese sem a compra de base: qualquer parcela citada seria número inventado',
    { intencao: intencoes('perguntar', 'responder'), acoes: [], tiposProibidos: ['card-purchase'] }),
  casoChat('c-24', 'clt', 'modalidade', 'remota',
    'o salário vai cair dia 5',
    'aviso de entrada futura — o lugar disso é o Planejamento, nunca um lançamento de hoje',
    { intencao: 'responder', acoes: [], tiposProibidos: ['income'] }),
  casoChat('c-25', 'other', 'modalidade', 'remota',
    'meu salário é 4000',
    'afirmação sobre o salário, não relato de recebimento: registrar como entrada de hoje é inventar o fato',
    { intencao: intencoes('perguntar', 'responder'), acoes: [], tiposProibidos: ['income'] }),
]
