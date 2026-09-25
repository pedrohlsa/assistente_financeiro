// Harness dos golden cases de consulta.
//
// Roda o caminho REAL — planner → validação → executor → compositor — e afirma
// o RESULTADO EXATO. É diferente do harness de frases de propósito: ali o que
// se prova é interpretação, aqui é aritmética.

import { planQuery } from '../../src/assistant/query/parse'
import { isQueryFailure, validateQueryPlan } from '../../src/assistant/query/validate'
import { runQuery } from '../../src/assistant/query/engine'
import { composeAnswer } from '../../src/assistant/query/answer'
import { TODAY_Q } from './cases-consulta'
import type { PlanRejectionCase, QueryCase } from './cases-consulta'

export interface QueryResult { id: string; group: string; ok: boolean; errors: string[] }

const perto = (a: number, b: number) => Math.abs(a - b) < 0.005

const casa = (texto: string, m: string | RegExp) =>
  typeof m === 'string' ? texto.toLowerCase().includes(m.toLowerCase()) : m.test(texto)

export function runQueryCase(c: QueryCase): QueryResult {
  const errors: string[] = []
  const state = c.state()
  const planned = planQuery(state, c.message, { today: TODAY_Q })

  if (c.expectNoPlan) {
    if (planned) errors.push(`esperava NENHUM plano, veio ${planned.plan.source}/${planned.plan.metric}`)
    return { id: c.id, group: c.group, ok: !errors.length, errors }
  }
  if (!planned) {
    return { id: c.id, group: c.group, ok: false, errors: ['nenhum plano foi montado'] }
  }
  if (c.expectIncomplete) {
    const got = planned.incompleto || ''
    if (!casa(got, c.expectIncomplete)) errors.push(`incompleto "${got}" não contém ${c.expectIncomplete}`)
    return { id: c.id, group: c.group, ok: !errors.length, errors }
  }
  if (planned.incompleto) {
    return { id: c.id, group: c.group, ok: false, errors: [`plano incompleto: ${planned.incompleto}`] }
  }
  if (c.expectBeyondLegacy !== undefined && !!planned.beyondLegacy !== c.expectBeyondLegacy) {
    errors.push(`beyondLegacy ${!!planned.beyondLegacy} ≠ ${c.expectBeyondLegacy}`)
  }

  const v = validateQueryPlan(planned.plan, state, TODAY_Q)
  if (isQueryFailure(v)) {
    return { id: c.id, group: c.group, ok: false, errors: [`plano recusado: ${v.code} ${v.detail || ''}`] }
  }
  const p = v.plan

  const e = c.expectPlan
  if (e) {
    if (e.source && p.source !== e.source) errors.push(`source ${p.source} ≠ ${e.source}`)
    if (e.field && p.field !== e.field) errors.push(`field ${p.field} ≠ ${e.field}`)
    if (e.metric && p.metric !== e.metric) errors.push(`metric ${p.metric} ≠ ${e.metric}`)
    if (e.group && p.group !== e.group) errors.push(`group ${p.group} ≠ ${e.group}`)
    if (e.order && p.order !== e.order) errors.push(`order ${p.order} ≠ ${e.order}`)
    if (e.periodFrom && p.period.from !== e.periodFrom) errors.push(`period.from ${p.period.from} ≠ ${e.periodFrom}`)
    if (e.periodTo && p.period.to !== e.periodTo) errors.push(`period.to ${p.period.to} ≠ ${e.periodTo}`)
    if (e.comparePeriodFrom && p.comparePeriod?.from !== e.comparePeriodFrom) {
      errors.push(`comparePeriod.from ${p.comparePeriod?.from} ≠ ${e.comparePeriodFrom}`)
    }
    for (const [k, esperado] of Object.entries(e.filter || {})) {
      const got = (p.filter as any)[k]
      if (JSON.stringify(got) !== JSON.stringify(esperado)) {
        errors.push(`filter.${k}=${JSON.stringify(got)} ≠ ${JSON.stringify(esperado)}`)
      }
    }
  }

  // Segunda tentativa pelo aprendizado — o mesmo caminho que `runPlannedQuery`
  // usa em produção, para o teste medir o que o usuário recebe.
  let r = runQuery(state, p)
  let planoFinal = p
  if (r.empty && planned.fallbackCategory && p.filter.text) {
    const alt = validateQueryPlan(
      { ...p, filter: { ...p.filter, text: undefined, categories: [planned.fallbackCategory] } },
      state, TODAY_Q,
    )
    if (!isQueryFailure(alt)) {
      const r2 = runQuery(state, alt.plan)
      if (!r2.empty) { r = r2; planoFinal = alt.plan }
    }
  }
  void planoFinal

  if (c.expectEmpty !== undefined && r.empty !== c.expectEmpty) {
    errors.push(`empty ${r.empty} ≠ ${c.expectEmpty} (total ${r.total}, ${r.count} linhas)`)
  }
  if (c.expectTotal !== undefined && !perto(r.total, c.expectTotal)) {
    errors.push(`total ${r.total} ≠ ${c.expectTotal}`)
  }
  if (c.expectCount !== undefined && r.count !== c.expectCount) {
    errors.push(`count ${r.count} ≠ ${c.expectCount}`)
  }
  for (let i = 0; i < (c.expectGroups || []).length; i++) {
    const esperado = c.expectGroups![i]
    const got = r.groups[i]
    if (!got) { errors.push(`grupo ${i + 1} ausente`); continue }
    if (!casa(got.label, esperado.label)) errors.push(`grupo ${i + 1} label "${got.label}" ≠ ${esperado.label}`)
    if (esperado.value !== undefined && !perto(got.value, esperado.value)) {
      errors.push(`grupo ${i + 1} valor ${got.value} ≠ ${esperado.value}`)
    }
    if (esperado.delta !== undefined && !perto(got.delta ?? NaN, esperado.delta)) {
      errors.push(`grupo ${i + 1} delta ${got.delta} ≠ ${esperado.delta}`)
    }
  }

  const reply = composeAnswer(r)
  for (const m of c.expectReply || []) if (!casa(reply, m)) errors.push(`resposta não contém ${m}\n     "${reply.replace(/\n/g, ' | ')}"`)
  for (const m of c.forbidReply || []) if (casa(reply, m)) errors.push(`resposta contém proibido ${m}`)

  return { id: c.id, group: c.group, ok: !errors.length, errors }
}

export function runPlanRejection(c: PlanRejectionCase): QueryResult {
  const v = validateQueryPlan(c.raw, c.state(), TODAY_Q)
  if (!isQueryFailure(v)) {
    return { id: c.id, group: 'recusa', ok: false, errors: [`plano ACEITO — deveria falhar com ${c.expectCode}`] }
  }
  return v.code === c.expectCode
    ? { id: c.id, group: 'recusa', ok: true, errors: [] }
    : { id: c.id, group: 'recusa', ok: false, errors: [`código ${v.code} ≠ ${c.expectCode}`] }
}
