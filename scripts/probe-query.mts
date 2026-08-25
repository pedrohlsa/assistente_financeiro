// Sonda de LEITURA: roda perguntas reais pelo planner + executor + compositor e
// imprime a resposta para um humano ler.
//
// Existe porque passar no corpus prova só que a frase testada não regrediu.
// Três dos nove defeitos da rodada anterior apareceram lendo a resposta, não
// rodando teste (regra 35 do CLAUDE.md).
//
//   npx tsx scripts/probe-query.mts            → todas
//   npx tsx scripts/probe-query.mts motorista  → só o grupo

import { autonomoRico, motoristaRico, usuarioNovo, TODAY } from '../tests/fixtures/richState'
import { planQuery } from '../src/assistant/query/parse'
import { QUERY_ERROR_MESSAGES } from '../src/assistant/query/validate'
import { runPlannedQuery } from '../src/assistant/query'
import type { AppState } from '../src/models/types'

const filtro = process.argv[2]
const explicar = process.argv.includes('--explica')

const GRUPOS: { nome: string; state: AppState; perguntas: string[] }[] = [
  {
    nome: 'autonomo',
    state: autonomoRico(TODAY),
    perguntas: [
      'quanto eu gastei em obra nos últimos 3 meses?',
      'quanto eu gasto em média com mercado?',
      'qual categoria aumentou mais comparando com mês passado?',
      'qual categoria caiu mais?',
      'qual foi meu maior gasto dos últimos 90 dias?',
      'qual gasto eu faço com mais frequência?',
      'quanto eu recebi da Casa 1 nos últimos 6 meses?',
      'quanto a Casa 1 representa da minha renda?',
      'qual mês teve a maior sobra?',
      'qual mês foi o pior?',
      'quanto eu gasto em fim de semana?',
      'eu gasto mais no começo ou no fim do mês?',
      'quanto aumentaram minhas despesas comparando com 3 meses atrás?',
      'qual cartão está mais comprometido?',
      'nubank ou inter, qual tá mais pesado?',
      'em qual dos próximos meses eu tenho mais parcelas?',
      'quanto ainda falta pagar de computador?',
      'quantas parcelas faltam das minhas compras?',
      'qual meta está mais perto de terminar?',
      'quanto eu realmente guardei nos últimos 6 meses?',
      'quanto das minhas entradas eu consegui guardar?',
      'quanto eu recebi de aluguel e quanto gastei com obra?',
      'tirando obra, quanto eu gastei esse mês?',
      'tirando o Nubank, quanto tenho comprometido?',
      'quanto gastei no Zé da esquina?',
      'quanto gastei em obra mês passado?',
      'qual foi meu melhor mês?',
    ],
  },
  {
    nome: 'motorista',
    state: motoristaRico(TODAY),
    perguntas: [
      'qual foi minha melhor semana?',
      'quanto estou fazendo por hora este mês?',
      'qual foi meu lucro por km nos últimos 30 dias?',
      'meu combustível aumentou?',
      'quanto das minhas receitas está indo para combustível?',
      'qual semana eu rodei mais?',
      'quanto eu ganhei na uber esse mês?',
      'uber ou 99, qual me dá mais?',
      'qual dia da semana eu faço mais?',
      'quantos km eu rodei nos últimos 7 dias?',
    ],
  },
  {
    nome: 'novo',
    state: usuarioNovo(),
    perguntas: [
      'qual foi meu melhor mês?',
      'quanto eu gastei em obra nos últimos 3 meses?',
      'qual categoria aumentou mais?',
    ],
  },
]

let total = 0
let semPlano = 0
let recusados = 0
let vazios = 0

for (const g of GRUPOS) {
  if (filtro && !g.nome.includes(filtro)) continue
  console.log(`\n${'═'.repeat(72)}\n  ${g.nome.toUpperCase()}\n${'═'.repeat(72)}`)
  for (const pergunta of g.perguntas) {
    total++
    console.log(`\n▸ ${pergunta}`)
    const planned = planQuery(g.state, pergunta, { today: TODAY })
    if (!planned) { semPlano++; console.log('   ✗ SEM PLANO (não reconhecida como consulta)'); continue }
    let motivo = ''
    const out = runPlannedQuery(g.state, planned, {
      today: TODAY,
      onReject: info => { motivo = `${info.code} ${info.detail || ''} — ${QUERY_ERROR_MESSAGES[info.code]}` },
    })
    if (!out) { recusados++; console.log(`   ✗ RECUSADO: ${motivo}`); continue }
    if (out.result.empty) vazios++
    const p = out.plan
    console.log(`   [${out.confidence}] ${p.source}.${p.field} ${p.metric} por ${p.group} · ${p.period.label}`
      + (p.comparePeriod ? ` vs ${p.comparePeriod.label}` : '')
      + (p.order ? ` · ${p.order}` : '')
      + (Object.keys(p.filter).length ? ` · filtro ${JSON.stringify(p.filter)}` : ''))
    console.log(out.reply.split('\n').map(l => `   ${l}`).join('\n'))
    if (explicar) console.log(`   ── como: ${out.explain.replace(/\n\n/g, ' ')}`)
  }
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`${total} perguntas · ${semPlano} sem plano · ${recusados} recusadas · ${vazios} vazias`)
