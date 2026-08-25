// Sonda de LEITURA dos cenários: roda hipóteses reais e imprime a resposta.
//
// Além de ler o texto, confere o que mais importa: o estado NÃO pode mudar.
// A comparação é byte a byte (JSON antes × JSON depois) — a única prova real
// de que uma simulação não escreveu nada.
//
//   npx tsx scripts/probe-scenario.mts

import { autonomoRico, motoristaRico, usuarioNovo } from '../tests/fixtures/richState'
import { todayISO } from '../src/utils/format'

// CUIDADO (regra 35 do CLAUDE.md): `monthlyProjections`, `currentBalance` e
// `monthStats` leem o RELÓGIO REAL, não uma data injetada. Um cenário montado
// sobre 2026-07-15 com o relógio em agosto projeta a partir de agosto e o
// resultado sai sem sentido. Aqui os fixtures nascem de `todayISO()`.
const TODAY = todayISO()
import { answerScenario } from '../src/assistant/scenario'
import type { AppState } from '../src/models/types'

const CASOS: { nome: string; state: AppState; frases: string[] }[] = [
  {
    nome: 'autonomo',
    state: autonomoRico(TODAY),
    frases: [
      'se eu gastar 500 agora quanto sobra?',
      'se eu comprar um pc de 4000 em 10x no nubank qual mês aperta mais?',
      'e se eu comprar um celular de 3600 em 12x?',
      'e se eu der mil de entrada?',
      'se eu comprar um notebook de 4000 em 12x com 1000 de entrada, quanto sobra?',
      'se eu guardar 500 por mês quando bato minha meta?',
      'se eu pagar a fatura inteira hoje, quanto fica meu saldo?',
      'se a Casa 1 não pagar este mês, ainda cubro minhas contas?',
      'se eu gastar mais 300 em obra, quanto sobra?',
      'to pensando em comprar uma tv de 2500 em 6x',
      'e se eu meter um pc de 4000 em 10x, da ruim?',
    ],
  },
  {
    nome: 'motorista',
    state: motoristaRico(TODAY),
    frases: [
      'se eu trabalhar mais 3 horas por dia nessa média, quanto faria?',
      'e se eu rodar mais 80km',
      'se eu ficar mais 3h na rua na minha media vale?',
      'se eu comprar um celular de 3000 em 10x quanto sobra?',
    ],
  },
  {
    nome: 'novo',
    state: usuarioNovo(),
    frases: [
      'se eu gastar 500 agora quanto sobra?',
      'se eu guardar 500 por mês quando bato minha meta?',
      'se eu pagar a fatura inteira hoje?',
      'se eu trabalhar mais 3 horas por dia quanto faria?',
    ],
  },
]

let total = 0
let semPlano = 0
let vazios = 0
let mutou = 0

for (const g of CASOS) {
  console.log(`\n${'═'.repeat(72)}\n  ${g.nome.toUpperCase()}\n${'═'.repeat(72)}`)
  for (const frase of g.frases) {
    total++
    console.log(`\n▸ ${frase}`)
    const antes = JSON.stringify(g.state)
    const out = answerScenario(g.state, frase, { today: TODAY })
    const depois = JSON.stringify(g.state)
    if (antes !== depois) { mutou++; console.log('   ‼ ESTADO MUDOU — a simulação escreveu em algum lugar') }
    if (!out) { semPlano++; console.log('   ✗ SEM PLANO (não reconhecida como hipótese)'); continue }
    if (out.result.empty) vazios++
    const p = out.plan
    console.log(`   [${p.kind}] ${JSON.stringify({
      amount: p.amount, installments: p.installments, downPayment: p.downPayment,
      cardName: p.cardName, hoursPerDay: p.hoursPerDay, extraKm: p.extraKm,
      goalName: p.goalName, origin: p.origin, category: p.category,
    })}`)
    console.log(out.reply.split('\n').map(l => `   ${l}`).join('\n'))
  }
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`${total} hipóteses · ${semPlano} sem plano · ${vazios} sem base · ${mutou} MUTARAM O ESTADO`)
if (mutou) process.exit(1)
