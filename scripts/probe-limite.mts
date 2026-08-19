// SONDA DESCARTAVEL — rodada LIMITE 2: o aprendizado ao longo do tempo.
// Feedback real (confirmar / editar / desfazer / corrigir salvo), categorias
// personalizadas, tipos que o aprendizado nao pode tocar, e conversa longa.

import { buildState, TODAY } from '../tests/assistant/harness'
import type { CaseState } from '../tests/assistant/harness'
import { orchestrate } from '../src/assistant/orchestrator'
import { applyBatchPure } from '../src/assistant/execute'
import { buildPersonalModel } from '../src/assistant/personalModel'
import { withLearnedCategory } from '../src/assistant/learning'
import { revertBatchPure, lastReversibleBatch, isRevertFailure } from '../src/assistant/journal'
import type { AppState } from '../src/models/types'
import { addDays, todayISO } from '../src/utils/format'

const hr = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
const d = (n: number) => addDays(TODAY, -n)

/** Uma volta completa: pergunta, confirma o que voltou, devolve o novo estado. */
async function turno(state: AppState, msg: string, opts: { pending?: any; clar?: any; draft?: any } = {}) {
  const out = await orchestrate({
    state, message: msg, history: [],
    draft: opts.draft || undefined, pending: opts.pending, pendingClarification: opts.clar,
    remoteEnabled: false, today: TODAY,
  })
  const acoes = out.response.actions.map((a: any) => {
    const x = a.action
    return `${x.kind}(${x.amount ?? x.total ?? '-'}${x.category ? ' ' + x.category : ''}${x.description ? ' "' + x.description + '"' : ''})`
  })
  console.log(`  > ${msg}`)
  console.log(`    [${out.response.mode}] ${out.response.reply.slice(0, 200).replace(/\n/g, ' | ')}`)
  if (acoes.length) console.log(`    ACOES: ${acoes.join(' | ')}`)
  return out
}

function confirmar(state: AppState, out: any, rot = 'confirmado') {
  const r = applyBatchPure(state, out.response.actions.map((a: any) => ({ id: a.id, action: a.action })), { source: 'ai' })
  console.log(`    [${rot}] aplicado=${r.applied} transacoes=${r.state.transactions.length}`)
  return r.state
}

const catDe = (s: AppState, texto: string) => {
  const p = buildPersonalModel(s, TODAY).categoryFor(texto, 'expense')
  return p ? `${p.value} (n=${p.sampleSize}, ${p.strength})` : 'nada aprendido'
}

// ---------------------------------------------------------------------------
hr('T1. O APRENDIZADO MUDA CONFORME O USUARIO USA')
{
  let s = buildState({ profile: 'other' })
  console.log('  inicio:', catDe(s, 'Boteco do Ivo'))
  for (let i = 1; i <= 4; i++) {
    const out = await turno(s, 'gastei 30 no boteco do ivo')
    // O usuario EDITA a categoria antes de confirmar: e a versao corrigida que
    // tem que virar padrao, nao a que o app propos.
    const acoes = out.response.actions.map((a: any) => ({ id: a.id, action: { ...a.action, category: 'lazer' } }))
    s = applyBatchPure(s, acoes, { source: 'ai' }).state
    console.log(`    depois de ${i} confirmacao(oes): ${catDe(s, 'Boteco do Ivo')}`)
  }
  const final = await turno(s, 'gastei 45 no boteco do ivo')
  console.log('    >>> a 5a proposta ja nasce com a categoria que ELE escolheu?')
  console.log('   ', JSON.stringify((final.response.actions[0] as any)?.action))
}

// ---------------------------------------------------------------------------
hr('T2. DESFAZER REMOVE A EVIDENCIA')
{
  let s = buildState({ profile: 'other' })
  s.transactions = Array.from({ length: 3 }, (_, i) => ({
    id: `p${i}`, type: 'expense', amount: 30, category: 'lazer',
    description: 'Boteco do Ivo', date: d(i + 1), time: '10:00',
  })) as any
  console.log('  com 3 lancamentos:', catDe(s, 'Boteco do Ivo'))

  const out = await turno(s, 'gastei 30 no boteco do ivo')
  const depois = applyBatchPure(s, out.response.actions.map((a: any) => ({ id: a.id, action: a.action })),
    { source: 'ai', batchId: 'b1', engine: 'local', messageId: 'm1' })
  console.log('  depois de confirmar (4):', catDe(depois.state, 'Boteco do Ivo'))

  const lote = lastReversibleBatch(depois.state)
  if (!lote) { console.log('  SEM LOTE NO JOURNAL — nao da para desfazer') }
  else {
    const rev = revertBatchPure(depois.state, lote.batchId, TODAY + 'T12:00')
    if (isRevertFailure(rev)) console.log('  reversao falhou:', rev.code)
    else console.log('  depois de desfazer:', catDe(rev.state, 'Boteco do Ivo'), '| transacoes =', rev.state.transactions.length)
  }
}

// ---------------------------------------------------------------------------
hr('T3. CATEGORIA PERSONALIZADA')
{
  const s = buildState({ profile: 'other' })
  s.categories = [...s.categories, { id: 'cerveja', name: 'Cerveja', type: 'expense', icon: '🍺' } as any]
  s.transactions = Array.from({ length: 5 }, (_, i) => ({
    id: `cv${i}`, type: 'expense', amount: 25, category: 'cerveja',
    description: 'Boteco do Ivo', date: d(i + 1), time: '10:00',
  })) as any
  const out = await turno(s, 'gastei 30 no boteco do ivo')
  console.log('    aprendeu categoria personalizada?', JSON.stringify((out.response.actions[0] as any)?.action?.category))

  // Agora ele ARQUIVA a categoria personalizada.
  const s2 = { ...s, categories: s.categories.map(c => (c.id === 'cerveja' ? { ...c, archived: true } : c)) }
  const out2 = await turno(s2, 'gastei 30 no boteco do ivo')
  console.log('    depois de arquivar:', JSON.stringify((out2.response.actions[0] as any)?.action?.category))
}

// ---------------------------------------------------------------------------
hr('T4. TIPOS QUE O APRENDIZADO NAO PODE TOCAR')
{
  const s = buildState({ profile: 'other' })
  s.transactions = Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`, type: 'expense', amount: 200, category: 'obra',
    description: 'Reserva', date: d(i + 1), time: '10:00',
  })) as any
  // "Reserva" aprendida como OBRA. Um saving nao pode virar despesa de obra.
  await turno(s, 'guardei 200 na reserva')
  await turno(s, 'passei 1200 no cartao em 3x e recebi 1100')
  const semTipo: any = withLearnedCategory(s, { kind: 'saving', amount: 100, description: 'Reserva' } as any, TODAY)
  console.log('    withLearnedCategory num saving:', JSON.stringify(semTipo))
  const work: any = withLearnedCategory(s, { kind: 'work', km: 100 } as any, TODAY)
  console.log('    withLearnedCategory num work:', JSON.stringify(work))
}

// ---------------------------------------------------------------------------
hr('T5. LANCAMENTO RETROATIVO E O PESO DA DATA')
{
  const s = buildState({ profile: 'other' })
  s.transactions = Array.from({ length: 4 }, (_, i) => ({
    id: `a${i}`, type: 'expense', amount: 30, category: 'lazer',
    description: 'Boteco do Ivo', date: d(i + 1), time: '10:00',
  })) as any
  const out = await turno(s, 'ontem gastei 30 no boteco do ivo')
  console.log('    data proposta:', (out.response.actions[0] as any)?.action?.date)
  const out2 = await turno(s, 'gastei 30 no boteco do ivo dia 10/07')
  console.log('    data proposta:', JSON.stringify((out2.response.actions[0] as any)?.action))
}

// ---------------------------------------------------------------------------
hr('T6. CONVERSA LONGA COM CORRECAO, EXPLICACAO E CANCELAMENTO')
{
  const cs: CaseState = {
    profile: 'driver', balance: 500,
    goals: [{ name: 'Moto', target: 9000, saved: 500 }],
    transactions: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `k${i}`, type: 'expense', amount: 95, category: 'combustivel', description: 'Suco', date: d(i + 1),
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`, type: 'income', amount: 320, category: 'corridas', description: 'Uber', date: d(i + 1),
      })),
    ] as any,
  }
  const s = buildState(cs)
  let pending: any; let clar: any; let draft: any = null
  const msgs = [
    'ganhei 340 na uber hoje',
    'botei 95 de suco',
    'na verdade foi 110',
    'por que voce colocou combustivel?',
    'quantas vezes eu fiz isso?',
    'cancela',
    'quanto falta pra meta moto?',
    'gastei 3000 de suco',
    'por que voce acha esse valor estranho?',
    'nao, foi 100 mesmo',
    'o que voce aprendeu sobre mim?',
  ]
  for (const m of msgs) {
    const out = await turno(s, m, { pending, clar, draft })
    draft = out.draft
    pending = out.correctedPending || (out.response.actions.length ? out.response.actions : (out.keepPending ? pending : undefined))
    clar = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
  }
}

console.log('\nFIM')
