// CORPUS DE CONTINUIDADE — conversas inteiras pelo ORQUESTRADOR REAL.
//
// Aqui o modelo não é chamado direto. Cada turno passa por `orchestrate()` com
// foco, proposta pendente, esclarecimento e histórico encadeados exatamente
// como `Chat.tsx` faz; o motor local responde o que sabe e o modelo em teste
// recebe só o que sobra — pelos mesmos dois caminhos da produção.
//
// Consequência que importa para ler o relatório: um turno só entra na nota do
// modelo quando o modelo foi DE FATO chamado naquele turno. O resto mede o app,
// não o modelo, e é igual para todas as configurações.
//
// Proibições valem em qualquer turno: uma hipótese não vira compra, uma
// pergunta não vira lançamento, e o foco da conversa não autoriza inventar.

import { acao } from './corpus-chat-a'
import type { CasoContinuidade, TurnoOuro } from './types'

const HIPOTESE_NAO_REGISTRA = ['card-purchase', 'expense', 'income', 'saving']
const t = (mensagem: string, extra: Omit<TurnoOuro, 'mensagem'> = {}): TurnoOuro => ({ mensagem, ...extra })

export const CASOS_CONTINUIDADE: CasoContinuidade[] = [
  {
    id: 'k-01', suite: 'continuidade', dimensao: 'continuidade', perfil: 'autonomo',
    porque: 'consulta refinada turno a turno até uma referência que o foco não resolve',
    turnos: [
      t('quanto gastei com obra esse mês', { tiposProibidos: ['expense'] }),
      t('e no mes retrasado', { tiposProibidos: ['expense'] }),
      t('sem contar o cimento', { tiposProibidos: ['expense'] }),
      t('e aquele gasto grandão do telhado foi em qual mês', {
        tiposProibidos: ['expense'],
        deveMencionar: [/telhado|reforma|n[ãa]o (?:tenho|consigo|vejo|encontr)|hist[óo]rico/i],
      }),
      t('pq subiu tanto', { tiposProibidos: ['expense'] }),
      t('e se eu parar a obra agora quanto sobra até dezembro', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
    ],
  },
  {
    id: 'k-02', suite: 'continuidade', dimensao: 'continuidade', perfil: 'autonomo',
    porque: 'cenário refinado sete vezes; em nenhum turno a hipótese pode virar compra',
    turnos: [
      t('se eu comprar um pc de 4k em 10x no nubank', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('e em 12', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('dando mil de entrada', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('volta pro cenário anterior', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('agora em 6x', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('e se for no inter mas sem entrada nenhuma', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('por quê?', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
    ],
  },
  {
    id: 'k-03', suite: 'continuidade', dimensao: 'continuidade', perfil: 'autonomo',
    porque: 'cartões com elipse, comparação e um pedido de conselho no fim',
    turnos: [
      t('meu nubank ta pesando?', { tiposProibidos: ['card-payment', 'expense'] }),
      t('e o inter', { tiposProibidos: ['card-payment', 'expense'] }),
      t('e mês passado?', { tiposProibidos: ['card-payment', 'expense'] }),
      t('qual dos dois ta pior entao', { tiposProibidos: ['card-payment', 'expense'] }),
      t('pq', { tiposProibidos: ['card-payment', 'expense'] }),
      t('e o que eu faço com isso', {
        tiposProibidos: ['card-payment', 'expense'],
        deveMencionar: [/fatura|parcel|nubank|inter|400|pag/i],
      }),
    ],
  },
  {
    id: 'k-04', suite: 'continuidade', dimensao: 'continuidade', perfil: 'motorista',
    porque: 'ritmo do motorista por plataforma, hora e semana, até uma pergunta de estratégia',
    turnos: [
      t('quanto fiz na uber essa semana', { tiposProibidos: ['income', 'work'] }),
      t('e na 99', { tiposProibidos: ['income', 'work'] }),
      t('e por hora', { tiposProibidos: ['income', 'work'] }),
      t('e semana passada', { tiposProibidos: ['income', 'work'] }),
      t('compensa rodar sábado?', { tiposProibidos: ['income', 'work'], deveMencionar: [/s[áa]bado|hora|R\$/i] }),
      t('e domingo?', { tiposProibidos: ['income', 'work'] }),
    ],
  },
  {
    id: 'k-05', suite: 'continuidade', dimensao: 'continuidade', perfil: 'clt',
    porque: 'registro, correção da proposta, novos fatos e uma hipótese no meio — sem duplicar nada',
    turnos: [
      t('recebi 4200 de salario', { acoes: [acao('income', { amount: 4200, category: 'salario' })] }),
      t('nao pera foi 4250', { tiposProibidos: ['expense'] }),
      t('e paguei 1300 de aluguel', { tiposProibidos: ['income'] }),
      t('guardei 300', { tiposProibidos: ['income', 'expense'] }),
      t('quanto sobrou'),
      t('e se eu comprar um celular de 2000 em 10x', { tiposProibidos: HIPOTESE_NAO_REGISTRA }),
      t('coloca tudo isso junto e registra', { tiposProibidos: ['card-purchase'] }),
    ],
  },
  {
    id: 'k-06', suite: 'continuidade', dimensao: 'continuidade', perfil: 'other',
    porque: 'dois esclarecimentos encadeados e uma meta ambígua',
    turnos: [
      t('paguei a fatura', { perguntar: true, tiposProibidos: ['expense'] }),
      t('a do nubank', { tiposProibidos: ['expense'] }),
      t('foi 400', { tiposProibidos: ['expense', 'income'] }),
      t('e coloquei 200 na meta', { perguntar: true, tiposProibidos: ['expense'] }),
      t('na da viagem', { tiposProibidos: ['expense'] }),
      t('desfaz isso', { tiposProibidos: ['reset'] }),
    ],
  },
]
