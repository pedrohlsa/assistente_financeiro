// CONTINUIDADE — conversas de 4 a 12 turnos.
//
// Dois turnos não provam nada. O defeito de follow-up aparece na quarta
// mensagem, quando o plano já foi refinado três vezes e alguém carregou um
// filtro que o usuário não repetiu — ou trocou o período e esqueceu de trocar
// a comparação junto.
//
// A data é FIXA nas conversas de CONSULTA (todo o caminho aceita data
// injetada). As de CENÁRIO usam o relógio real, porque `monthlyProjections` e
// `currentBalance` leem `todayISO()` (regra 35 do CLAUDE.md).

import type { AppState } from '../../src/models/types'
import { autonomoRico, motoristaRico } from '../fixtures/richState'
import { todayISO } from '../../src/utils/format'

export const TODAY_C = '2026-08-15'
const HOJE = todayISO()

const autonomo = () => autonomoRico(TODAY_C)
const autonomoAgora = () => autonomoRico(HOJE)
const motorista = () => motoristaRico(TODAY_C)

export interface ConversaTurno {
  msg: string
  expectKind?: 'query' | 'scenario' | 'explain' | 'clarify'
  expectReply?: (string | RegExp)[]
  forbidReply?: (string | RegExp)[]
  expectPeriodFrom?: string
  expectTotal?: number
  expectNoAnswer?: boolean
}

export interface ConversaCase {
  id: string
  group: string
  state: () => AppState
  today?: string
  turnos: ConversaTurno[]
}

export const CONVERSA_CASES: ConversaCase[] = [
  {
    id: 'k-01', group: 'continuidade', state: autonomo, today: TODAY_C,
    turnos: [
      { msg: 'quanto gastei com obra esse mês', expectKind: 'query', expectTotal: 1430, expectPeriodFrom: '2026-08-01' },
      // O período muda; o FILTRO de obra continua. Perder o filtro aqui
      // devolveria o total do mês inteiro com cara de resposta sobre obra.
      { msg: 'e mês passado', expectKind: 'query', expectTotal: 1010, expectPeriodFrom: '2026-07-01' },
      // "Os dois" são os dois períodos que o usuário acabou de ver: agosto e
      // julho. Comparar julho com junho falaria de um mês que ninguém citou.
      { msg: 'qual a diferença', expectKind: 'query', expectReply: [/1\.430|420/] },
      { msg: 'e em junho', expectKind: 'query', expectTotal: 560, expectPeriodFrom: '2026-06-01' },
      { msg: 'por que', expectKind: 'explain', expectReply: [/somei/i, /obra|categoria/i] },
    ],
  },
  {
    id: 'k-02', group: 'continuidade', state: autonomo, today: TODAY_C,
    turnos: [
      { msg: 'quanto gastei esse mês', expectKind: 'query' },
      { msg: 'e por categoria', expectKind: 'query', expectReply: [/obra/i] },
      { msg: 'e tirando obra', expectKind: 'query', forbidReply: [/obra e constru/i] },
      { msg: 'e mês passado', expectKind: 'query', expectPeriodFrom: '2026-07-01' },
    ],
  },
  {
    id: 'k-03', group: 'continuidade', state: autonomo, today: TODAY_C,
    turnos: [
      { msg: 'nubank ou inter, qual tá mais pesado', expectKind: 'query', expectReply: [/nubank/i] },
      // `plans` é uma foto da dívida atual: trocar o período tem que trocar a
      // FONTE para parcela, senão a resposta sai idêntica e parece que o app
      // ignorou a pergunta.
      { msg: 'e mês que vem', expectKind: 'query', expectPeriodFrom: '2026-09-01' },
      { msg: 'e o outro', expectKind: 'query', expectReply: [/400/] },
      { msg: 'por que', expectKind: 'explain', expectReply: [/inter/i] },
    ],
  },
  {
    id: 'k-04', group: 'continuidade', state: motorista, today: TODAY_C,
    turnos: [
      { msg: 'quanto eu ganhei esse mês', expectKind: 'query' },
      { msg: 'e semana passada', expectKind: 'query' },
      // "Dia da semana" contém "da semana", que o leitor de período casa como
      // "esta semana": sem tratar o agrupamento antes, a pergunta virava troca
      // de período e a resposta vinha sem agrupamento nenhum.
      { msg: 'e por dia da semana', expectKind: 'query', expectReply: [/(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)/i] },
      { msg: 'por que', expectKind: 'explain' },
    ],
  },

  // ----- cenário refinado turno a turno -----------------------------------
  {
    id: 'k-10', group: 'continuidade', state: autonomoAgora,
    turnos: [
      { msg: 'se eu comprar um pc de 4000 em 10x no nubank quanto sobra', expectKind: 'scenario', expectReply: [/R\$\s*400,00/] },
      { msg: 'e em 12', expectKind: 'scenario', expectReply: [/R\$\s*333,33/] },
      { msg: 'e se for 3500', expectKind: 'scenario', expectReply: [/3\.500/] },
      { msg: 'e dando mil de entrada', expectKind: 'scenario', expectReply: [/1\.000,00 de entrada/] },
      { msg: 'qual mês fica pior', expectKind: 'scenario', expectReply: [/mais apertado/i] },
      { msg: 'por que', expectKind: 'explain', expectReply: [/simulei/i, /nada foi gravado/i] },
      { msg: 'agora em 6x', expectKind: 'scenario', expectReply: [/6x/] },
      { msg: 'e sem entrada', expectKind: 'scenario', forbidReply: [/de entrada/] },
    ],
  },
  {
    id: 'k-11', group: 'continuidade', state: autonomoAgora,
    turnos: [
      { msg: 'quanto gastei com obra esse mês', expectKind: 'query' },
      // Trocar de consulta para hipótese e voltar: os dois focos coexistem.
      { msg: 'se eu gastar mais 500 em obra quanto sobra', expectKind: 'scenario', expectReply: [/nada foi registrado/i] },
      { msg: 'e mês passado', expectKind: 'query' },
    ],
  },
]
