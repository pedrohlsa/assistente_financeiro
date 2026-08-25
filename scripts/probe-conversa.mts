// Sonda de CONTINUIDADE: conversas de 10 a 20 mensagens, lidas em sequência.
//
// Dois turnos não provam nada — o defeito de follow-up aparece na quarta
// mensagem, quando o plano já foi refinado três vezes e alguém carregou um
// filtro que o usuário não repetiu.
//
//   npx tsx scripts/probe-conversa.mts

import { autonomoRico, motoristaRico } from '../tests/fixtures/richState'
import { answerConversation } from '../src/assistant/conversation'
import type { ConversationFocus } from '../src/assistant/conversation'
import { todayISO } from '../src/utils/format'
import type { AppState } from '../src/models/types'

const TODAY = todayISO()

const CONVERSAS: { nome: string; state: AppState; turnos: string[] }[] = [
  {
    nome: 'obra',
    state: autonomoRico(TODAY),
    turnos: [
      'quanto gastei com obra esse mês',
      'e mês passado',
      'qual a diferença',
      'o que mais aumentou',
      'e tirando obra',
      'e só casa',
      'qual foi o maior gasto',
      'e no mês anterior',
      'compara os dois',
      'por que',
    ],
  },
  {
    nome: 'compra',
    state: autonomoRico(TODAY),
    turnos: [
      'se eu comprar um pc de 4000 em 10x no nubank quanto sobra',
      'e em 12',
      'e se for 3500',
      'e dando mil de entrada',
      'qual mês fica pior',
      'por que',
      'volta pro cenário anterior',
      'agora em 6x',
      'e sem entrada',
    ],
  },
  {
    nome: 'cartoes',
    state: autonomoRico(TODAY),
    turnos: [
      'nubank ou inter, qual tá mais pesado',
      'e mês que vem',
      'e o outro',
      'por que',
    ],
  },
  {
    nome: 'motorista',
    state: motoristaRico(TODAY),
    turnos: [
      'quanto eu ganhei esse mês',
      'e semana passada',
      'e por dia da semana',
      'qual foi meu lucro por km nos últimos 30 dias',
      'e nos últimos 7 dias',
      'se eu rodar mais 80km quanto faria',
      'e mais 3 horas por dia',
      'por que',
    ],
  },
]

let total = 0
let semResposta = 0

for (const c of CONVERSAS) {
  console.log(`\n${'═'.repeat(72)}\n  ${c.nome.toUpperCase()}\n${'═'.repeat(72)}`)
  let focus: ConversationFocus | undefined
  const antes = JSON.stringify(c.state)
  for (const turno of c.turnos) {
    total++
    console.log(`\n› ${turno}`)
    const out = answerConversation(c.state, turno, { today: TODAY, focus })
    if (!out) { semResposta++; console.log('   ✗ SEM RESPOSTA'); continue }
    focus = out.focus
    console.log(`   [${out.kind}${out.confidence ? '/' + out.confidence : ''}]`)
    console.log(out.reply.split('\n').map(l => `   ${l}`).join('\n'))
  }
  if (JSON.stringify(c.state) !== antes) console.log('\n   ‼ ESTADO MUDOU DURANTE A CONVERSA')
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`${total} turnos · ${semResposta} sem resposta`)
