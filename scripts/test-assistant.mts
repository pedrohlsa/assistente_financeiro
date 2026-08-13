// Executa o corpus de regressão do assistente.
// Rodar: npm run test:assistant
//
// 100% offline e determinístico: nenhuma chamada de rede, data fixa.

import { CASES } from '../tests/assistant/cases'
import { CRITICAL } from '../tests/assistant/cases-critical'
import { ADVERSARIAL } from '../tests/assistant/cases-adversarial'
import { TEMPORAL } from '../tests/assistant/cases-temporal'
import { UNDO } from '../tests/assistant/cases-undo'
import { EDIT } from '../tests/assistant/cases-edit'
import { FALA_REAL } from '../tests/assistant/cases-fala-real'
import { REGISTRO_REAL } from '../tests/assistant/cases-registro-real'
import { runProperties } from '../tests/assistant/properties'
import { runCase } from '../tests/assistant/harness'
import type { CaseResult } from '../tests/assistant/harness'

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
const verbose = process.argv.includes('--verbose')

const ALL = [...CASES, ...CRITICAL, ...ADVERSARIAL, ...TEMPORAL, ...UNDO, ...EDIT, ...FALA_REAL, ...REGISTRO_REAL]
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

// Invariantes financeiras: valem para QUALQUER entrada, não para uma frase.
const props = only ? { total: 0, failures: [] as string[] } : await runProperties()
if (props.total) {
  console.log('\n=== Invariantes ===')
  console.log(props.failures.length
    ? `FAIL ${props.total - props.failures.length}/${props.total}\n` + props.failures.map(f => '   · ' + f).join('\n')
    : `ok   ${props.total}/${props.total} invariantes preservadas`)
}

process.exit(failed.length || props.failures.length ? 1 : 0)
