// Executa TODA a bateria do assistente.
// Rodar: npm run test:assistant   ·   npm run test:assistant -- --only=temporal
//
// 100% offline e determinístico: nenhuma chamada de rede, semente fixa, e a
// data injetada onde o caminho aceita data injetada.
//
// Cinco camadas, e cada uma prova uma coisa diferente:
//
//   1. CORPUS de frases       — aquelas frases não regrediram
//   2. CONSULTA e CENÁRIO     — a aritmética está certa, com resultado EXATO
//   3. CONTINUIDADE           — a conversa mantém o assunto por 4 a 12 turnos
//   4. METAMÓRFICOS           — a CLASSE de frases, não a frase
//   5. FUZZ e INVARIANTES     — nada trava, nada age sozinho, nada some

import { CASES } from '../tests/assistant/cases'
import { CRITICAL } from '../tests/assistant/cases-critical'
import { ADVERSARIAL } from '../tests/assistant/cases-adversarial'
import { TEMPORAL } from '../tests/assistant/cases-temporal'
import { UNDO } from '../tests/assistant/cases-undo'
import { EDIT } from '../tests/assistant/cases-edit'
import { FALA_REAL } from '../tests/assistant/cases-fala-real'
import { ADAPTATIVO } from '../tests/assistant/cases-adaptativo'
import { REGISTRO_REAL } from '../tests/assistant/cases-registro-real'
import { ROTEAMENTO } from '../tests/assistant/cases-roteamento'
import { CLASSE_FINANCEIRA } from '../tests/assistant/cases-classe-financeira'
import { VALOR_CARDINALIDADE } from '../tests/assistant/cases-valor-cardinalidade'
import { runProperties } from '../tests/assistant/properties'
import { runCopilotProperties } from '../tests/assistant/properties-copiloto'
import { runRemoteProperties } from '../tests/assistant/properties-remoto'
import { runEvalSelfTest } from '../tests/assistant/eval/selftest'
import { runCase } from '../tests/assistant/harness'
import type { CaseResult } from '../tests/assistant/harness'
import { QUERY_CASES, PLAN_REJECTIONS, PROTOTYPE_ATTACKS, TODAY_Q } from '../tests/assistant/cases-consulta'
import { runPlanRejection, runQueryCase } from '../tests/assistant/queryHarness'
import { SCENARIO_CASES } from '../tests/assistant/cases-cenario'
import { CONVERSA_CASES } from '../tests/assistant/cases-continuidade'
import { SEMANTICA_CASES, runSemanticaCase } from '../tests/assistant/cases-semantica'
import { runConversaCase, runScenarioCase } from '../tests/assistant/scenarioHarness'
import { runMetamorphic } from '../tests/assistant/metamorphic'
import { runFuzz } from '../tests/assistant/fuzz'
import { isQueryFailure, validateQueryPlan } from '../src/assistant/query/validate'
import { autonomoRico } from '../tests/fixtures/richState'
import { runAdversarialReal } from '../tests/assistant/adversarial-real'

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
const verbose = process.argv.includes('--verbose')

let extrasFalharam = false

const ALL = [...CASES, ...CRITICAL, ...ADVERSARIAL, ...TEMPORAL, ...UNDO, ...EDIT, ...FALA_REAL, ...REGISTRO_REAL, ...ADAPTATIVO, ...ROTEAMENTO, ...CLASSE_FINANCEIRA, ...VALOR_CARDINALIDADE]
const selected = only
  ? ALL.filter(c => c.id.includes(only) || c.group.includes(only))
  : ALL

const results: CaseResult[] = []
for (const c of selected) {
  try {
    results.push(await runCase(c))
  } catch (e: any) {
    results.push({ id: c.id, group: c.group, ok: false, errors: [`exceção: ${e?.message || e}`] })
  }
}

const failed = results.filter(r => !r.ok)
const byGroup = new Map<string, { total: number; ok: number }>()
for (const r of results) {
  const g = byGroup.get(r.group) || { total: 0, ok: 0 }
  g.total++
  if (r.ok) g.ok++
  byGroup.set(r.group, g)
}

console.log('\n=== Corpus do assistente ===')
for (const [group, g] of [...byGroup.entries()].sort()) {
  const mark = g.ok === g.total ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${group.padEnd(14)} ${g.ok}/${g.total}`)
}

if (failed.length) {
  console.log(`\n--- ${failed.length} falha(s) ---`)
  for (const f of failed) {
    console.log(`\n[${f.id}] ${f.group}`)
    for (const e of f.errors) console.log(`   · ${e}`)
  }
}

const pct = results.length ? Math.round((results.length - failed.length) / results.length * 100) : 0
console.log(`\n${results.length - failed.length}/${results.length} casos passaram (${pct}%)`)

if (verbose) {
  for (const r of results.filter(r => r.ok)) console.log(`ok   ${r.id}`)
}

// ---------------------------------------------------------------------------
// Consulta, cenário e continuidade — resultado EXATO, não "não quebrou"
// ---------------------------------------------------------------------------

if (!only) {
  const novos = [
    ...QUERY_CASES.map(runQueryCase),
    ...PLAN_REJECTIONS.map(runPlanRejection),
    ...SCENARIO_CASES.map(runScenarioCase),
    ...CONVERSA_CASES.map(runConversaCase),
  ]
  const porGrupo = new Map<string, { total: number; ok: number }>()
  for (const r of novos) {
    const g = porGrupo.get(r.group) || { total: 0, ok: 0 }
    g.total++
    if (r.ok) g.ok++
    porGrupo.set(r.group, g)
  }
  console.log('\n=== Consulta, cenário e continuidade ===')
  for (const [grupo, g] of [...porGrupo.entries()].sort()) {
    console.log(`${g.ok === g.total ? 'ok  ' : 'FAIL'} ${grupo.padEnd(14)} ${g.ok}/${g.total}`)
  }
  const ruins = novos.filter(r => !r.ok)
  if (ruins.length) {
    console.log(`\n--- ${ruins.length} falha(s) ---`)
    for (const f of ruins) {
      console.log(`\n[${f.id}] ${f.group}`)
      for (const e of f.errors) console.log(`   · ${e}`)
    }
    extrasFalharam = true
  }
  console.log(`\n${novos.length - ruins.length}/${novos.length} casos novos passaram`)

  // Semântica pelo ORQUESTRADOR: é lá que o roteador antigo respondia depois de
  // a consulta e o cenário desistirem — testar a camada de baixo passaria verde.
  const semantica = []
  for (const c of SEMANTICA_CASES) semantica.push(await runSemanticaCase(c))
  const semGrupo = new Map<string, { total: number; ok: number }>()
  for (const r of semantica) {
    const g = semGrupo.get(r.group) || { total: 0, ok: 0 }
    g.total++
    if (r.ok) g.ok++
    semGrupo.set(r.group, g)
  }
  console.log('\n=== Semântica pelo orquestrador ===')
  for (const [grupo, g] of [...semGrupo.entries()].sort()) {
    console.log(`${g.ok === g.total ? 'ok  ' : 'FAIL'} ${grupo.padEnd(14)} ${g.ok}/${g.total}`)
  }
  const semRuins = semantica.filter(r => !r.ok)
  for (const f of semRuins) {
    console.log(`\n[${f.id}] ${f.group}`)
    for (const e of f.errors) console.log(`   · ${e}`)
  }
  if (semRuins.length) extrasFalharam = true
  console.log(`${semantica.length - semRuins.length}/${semantica.length} casos semânticos passaram`)

  // Poluição de protótipo precisa do JSON PARSEADO: um literal de objeto no
  // TypeScript define o protótipo em vez de criar a chave.
  const estadoProto = autonomoRico(TODAY_Q)
  let protoOk = true
  for (const json of PROTOTYPE_ATTACKS) {
    const v = validateQueryPlan(JSON.parse(json), estadoProto, TODAY_Q)
    if (!isQueryFailure(v)) protoOk = false
    if (({} as any).polluted !== undefined) protoOk = false
  }
  console.log(protoOk
    ? `ok   ${PROTOTYPE_ATTACKS.length} tentativas de poluir o protótipo recusadas`
    : 'FAIL poluição de protótipo NÃO foi barrada')
  if (!protoOk) extrasFalharam = true
}

// ---------------------------------------------------------------------------
// Metamórficos e fuzz — a CLASSE de frases, não a frase
// ---------------------------------------------------------------------------

if (!only) {
  const adversarialAB = (await runAdversarialReal()).filter(r => /^(?:C1|C2|C3|H1|H2|H3|H4|H5|H6|M2|M3|M4|M6)/.test(r.id))
  const failures = adversarialAB.filter(r => !r.ok)
  console.log('\n=== Auditoria adversarial: matemática, preferências e consultas ===')
  console.log(`${adversarialAB.length - failures.length}/${adversarialAB.length} regressões reais`)
  for (const failure of failures) {
    console.log(`FAIL ${failure.id}: esperado ${JSON.stringify(failure.expected)}; recebido ${JSON.stringify(failure.actual)}`)
  }
  if (failures.length) extrasFalharam = true
}

if (!only) {
  const meta = await runMetamorphic()
  console.log('\n=== Metamórficos ===')
  if (meta.falhas.length) {
    console.log(`FAIL ${meta.falhas.length} de ${meta.preservadas + meta.mudadas} mutações`)
    for (const f of meta.falhas.slice(0, 20)) console.log(`   · ${f}`)
    extrasFalharam = true
  } else {
    console.log(`ok   ${meta.preservadas} mutações preservam o sentido · ${meta.mudadas} mudam a modalidade`)
  }

  const fz = await runFuzz()
  console.log('\n=== Fuzz ===')
  if (fz.falhas.length) {
    console.log(`FAIL ${fz.falhas.length} de ${fz.total}`)
    for (const f of fz.falhas.slice(0, 15)) console.log(`   · ${f}`)
    extrasFalharam = true
  } else {
    console.log(`ok   ${fz.total} mensagens hostis · baseline ${fz.baselineMs.toFixed(2)}ms · pior ${fz.piorMs.toFixed(0)}ms`)
  }
}

// Invariantes: valem para QUALQUER entrada, não para uma frase. As antigas
// protegem a CONTABILIDADE (saving não é receita, cartão não conta duas vezes);
// as novas protegem as fronteiras do copiloto — consulta só lê, cenário não
// grava, e número na prosa tem que existir nos fatos.
const props = only ? { total: 0, failures: [] as string[] } : await runProperties()
const copiloto = only ? { total: 0, failures: [] as string[] } : await runCopilotProperties()
const remoto = only ? { total: 0, failures: [] as string[] } : await runRemoteProperties()
const todas = {
  total: props.total + copiloto.total + remoto.total,
  failures: [...props.failures, ...copiloto.failures, ...remoto.failures],
}
if (todas.total) {
  console.log('\n=== Invariantes ===')
  console.log(todas.failures.length
    ? `FAIL ${todas.total - todas.failures.length}/${todas.total}\n` + todas.failures.map(f => '   · ' + f).join('\n')
    : `ok   ${todas.total}/${todas.total} invariantes preservadas `
      + `(${props.total} financeiras + ${copiloto.total} do copiloto + ${remoto.total} do canal remoto)`)
}

// A avaliação PAGA dos modelos remotos não roda aqui — o avaliador dela, sim.
// Gabarito que não passa no validador real, pontuação que acusa a resposta
// certa ou deixa passar um defeito plantado, e rota declarada que não bate com
// o orquestrador são defeitos que só apareceriam depois de gastar.
if (!only) {
  const avaliacao = await runEvalSelfTest()
  console.log('\n=== Avaliação remota (autoteste, sem rede) ===')
  if (avaliacao.falhas.length) {
    console.log(`FAIL ${avaliacao.falhas.length} de ${avaliacao.total}`)
    for (const f of avaliacao.falhas.slice(0, 20)) console.log(`   · ${f}`)
    extrasFalharam = true
  } else {
    console.log(`ok   ${avaliacao.total} verificações · ${avaliacao.resumo.join(' · ')}`)
  }
}

process.exit(failed.length || todas.failures.length || extrasFalharam ? 1 : 0)
