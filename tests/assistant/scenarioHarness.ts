// Harness dos golden cases de cenário e de continuidade.
//
// Duas coisas são verificadas em TODO caso, sem o autor precisar pedir:
//   1. o estado NÃO muda (comparação byte a byte antes × depois);
//   2. nenhuma `ParsedAction` nasce de uma hipótese.
// São as duas invariantes que dão sentido ao motor inteiro.

import type { AppState } from '../../src/models/types'
import { answerConversation } from '../../src/assistant/conversation'
import type { ConversationFocus } from '../../src/assistant/conversation'
import { todayISO } from '../../src/utils/format'
import type { ScenarioCase } from './cases-cenario'
import type { ConversaCase } from './cases-continuidade'

const HOJE = todayISO()

export interface HarnessResult { id: string; group: string; ok: boolean; errors: string[] }

const casa = (texto: string, m: string | RegExp) =>
  typeof m === 'string' ? texto.toLowerCase().includes(m.toLowerCase()) : m.test(texto)

const perto = (a: number, b: number) => Math.abs(a - b) < 0.005

export function runScenarioCase(c: ScenarioCase): HarnessResult {
  const errors: string[] = []
  const state = c.state()
  const antes = JSON.stringify(state)
  let focus: ConversationFocus | undefined
  let ultima: ReturnType<typeof answerConversation> = null

  for (const msg of c.messages) {
    const out = answerConversation(state, msg, { today: HOJE, focus })
    if (out) { focus = out.focus; ultima = out }
    else ultima = null
  }

  if (JSON.stringify(state) !== antes) {
    errors.push('O ESTADO MUDOU — a simulação escreveu em algum lugar')
  }

  if (c.expectNoPlan) {
    if (ultima && ultima.kind === 'scenario') errors.push(`esperava NENHUM cenário, veio ${focus?.lastScenarioPlan?.kind}`)
    return { id: c.id, group: c.group, ok: !errors.length, errors }
  }
  if (!ultima) return { id: c.id, group: c.group, ok: false, errors: ['nenhuma resposta'] }
  if (ultima.kind !== 'scenario') errors.push(`kind "${ultima.kind}" ≠ "scenario"`)

  const plan: any = focus?.lastScenarioPlan
  if (c.expectKind && plan?.kind !== c.expectKind) errors.push(`cenário ${plan?.kind} ≠ ${c.expectKind}`)
  for (const [k, v] of Object.entries(c.expectPlan || {})) {
    const got = plan?.[k]
    const ok = typeof v === 'number' ? typeof got === 'number' && perto(got, v)
      : String(got ?? '').toLowerCase() === String(v).toLowerCase()
    if (!ok) errors.push(`plano.${k}=${JSON.stringify(got)} ≠ ${JSON.stringify(v)}`)
  }

  const fatos = focus?.lastScenario?.facts || []
  for (const esperado of c.expectFacts || []) {
    const f = fatos.find(x => casa(x.label, esperado.label))
    if (!f) { errors.push(`fato ${esperado.label} ausente (tem: ${fatos.map(x => x.label).join(' | ')})`); continue }
    if (esperado.value !== undefined && !perto(f.value, esperado.value)) {
      errors.push(`fato "${f.label}" = ${f.value} ≠ ${esperado.value}`)
    }
  }
  if (c.expectEmpty && fatos.length) errors.push(`esperava resultado sem base, veio ${fatos.length} fatos`)

  for (const m of c.expectReply || []) if (!casa(ultima.reply, m)) errors.push(`resposta não contém ${m}\n     "${ultima.reply.replace(/\n/g, ' | ')}"`)
  for (const m of c.forbidReply || []) if (casa(ultima.reply, m)) errors.push(`resposta contém proibido ${m}`)

  return { id: c.id, group: c.group, ok: !errors.length, errors }
}

// ---------------------------------------------------------------------------
// Continuidade
// ---------------------------------------------------------------------------

export function runConversaCase(c: ConversaCase): HarnessResult {
  const errors: string[] = []
  const state = c.state()
  const antes = JSON.stringify(state)
  let focus: ConversationFocus | undefined

  for (let i = 0; i < c.turnos.length; i++) {
    const t = c.turnos[i]
    const out = answerConversation(state, t.msg, { today: c.today || HOJE, focus })
    if (!out) {
      if (t.expectNoAnswer) continue
      errors.push(`turno ${i + 1} ("${t.msg}") sem resposta`)
      continue
    }
    if (t.expectNoAnswer) { errors.push(`turno ${i + 1} respondeu quando não devia`); continue }
    focus = out.focus
    if (t.expectKind && out.kind !== t.expectKind) errors.push(`turno ${i + 1} kind "${out.kind}" ≠ "${t.expectKind}"`)
    for (const m of t.expectReply || []) {
      if (!casa(out.reply, m)) errors.push(`turno ${i + 1} ("${t.msg}") não contém ${m}\n     "${out.reply.replace(/\n/g, ' | ')}"`)
    }
    for (const m of t.forbidReply || []) {
      if (casa(out.reply, m)) errors.push(`turno ${i + 1} ("${t.msg}") contém proibido ${m}`)
    }
    if (t.expectPeriodFrom && focus?.lastQueryPlan?.period.from !== t.expectPeriodFrom) {
      errors.push(`turno ${i + 1} período ${focus?.lastQueryPlan?.period.from} ≠ ${t.expectPeriodFrom}`)
    }
    if (t.expectTotal !== undefined) {
      const total = focus?.lastQuery?.total
      if (typeof total !== 'number' || !perto(total, t.expectTotal)) {
        errors.push(`turno ${i + 1} total ${total} ≠ ${t.expectTotal}`)
      }
    }
  }

  if (JSON.stringify(state) !== antes) errors.push('O ESTADO MUDOU durante a conversa')
  return { id: c.id, group: c.group, ok: !errors.length, errors }
}
