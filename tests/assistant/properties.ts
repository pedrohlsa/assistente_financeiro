// Testes de PROPRIEDADE — invariantes que valem para qualquer entrada.
//
// Um caso de regressão prova uma frase. Uma invariante prova uma regra: por mais
// que o parser evolua, `saving` nunca pode virar despesa e entrada financiada
// nunca pode virar receita. É isto que impede uma regex nova de quebrar a
// contabilidade sem ninguém perceber.

import { buildState, TODAY } from './harness'
import { applyBatchPure, planAssistantActions } from '../../src/assistant/execute'
import { validateAction, isValidationFailure, ACTION_CATALOG, allowedRemoteKinds } from '../../src/assistant/contracts'
import { buildCapabilities } from '../../src/assistant/orchestrator'
import { currentBalance, savedThisMonth, monthStats } from '../../src/services/calc'
import { buildSystemPrompt, normalizeCapabilities, sanitizeRemoteResponse } from '../../api/_lib/assistantPrompt'
import { describeAction } from '../../src/services/nlp'
import type { ParsedAction } from '../../src/models/types'

export interface PropertyReport { total: number; failures: string[] }

const check = (report: PropertyReport, name: string, fn: () => string | null) => {
  report.total++
  try {
    const err = fn()
    if (err) report.failures.push(`${name}: ${err}`)
  } catch (e: any) {
    report.failures.push(`${name}: exceção ${e?.message || e}`)
  }
}

const batch = (actions: ParsedAction[]) => actions.map((action, i) => ({ id: `a${i}`, action }))

export function runProperties(): PropertyReport {
  const r: PropertyReport = { total: 0, failures: [] }

  // --- 1. `saving` nunca é receita nem despesa ---------------------------
  check(r, 'saving não vira receita/despesa', () => {
    const s = buildState({ profile: 'clt' })
    const out = applyBatchPure(s, batch([{ kind: 'saving', amount: 150 }]))
    const m = monthStats(out.state)
    if (m.income !== 0) return `receita ${m.income} ≠ 0`
    if (m.expense !== 0) return `despesa ${m.expense} ≠ 0`
    if (savedThisMonth(out.state) !== 150) return 'savedThisMonth não contou'
    return null
  })

  // --- 2. `saving` não altera o saldo (regra 20, inalterada) -------------
  check(r, 'saving não altera o saldo em conta', () => {
    const s = buildState({ balance: 1000 })
    const before = currentBalance(s)
    const out = applyBatchPure(s, batch([{ kind: 'saving', amount: 300 }]))
    const after = currentBalance(out.state)
    return before === after ? null : `saldo mudou de ${before} para ${after}`
  })

  // --- 3. Entrada financiada nunca é renda ------------------------------
  check(r, 'entrada financiada não vira receita', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const out = applyBatchPure(s, batch([
      { kind: 'financed-cash-inflow', total: 2000, netReceived: 1850, installments: 5, cardName: 'Nubank' },
    ]))
    const m = monthStats(out.state)
    if (m.income !== 0) return `receita ${m.income} ≠ 0`
    if (currentBalance(out.state) !== 1850) return `saldo ${currentBalance(out.state)} ≠ 1850`
    return null
  })

  // --- 4. Compra no cartão não cria Transaction (dupla contagem) ---------
  check(r, 'compra parcelada não vira despesa', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const out = applyBatchPure(s, batch([
      { kind: 'card-purchase', total: 4000, installments: 4, cardName: 'Nubank' },
    ]))
    if (out.state.transactions.length) return 'criou Transaction'
    const soma = out.state.installments.reduce((a, i) => a + i.amount, 0)
    return Math.abs(soma - 4000) < 0.005 ? null : `parcelas somam ${soma}`
  })

  // --- 5. Pagar fatura não gera despesa nova -----------------------------
  check(r, 'pagamento de fatura não vira despesa', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const withPlan = applyBatchPure(s, batch([
      { kind: 'card-purchase', total: 400, installments: 1, cardName: 'Nubank' },
    ])).state
    const out = applyBatchPure(withPlan, batch([{ kind: 'card-payment', cardName: 'Nubank' }]))
    const exp = out.state.transactions.filter(t => t.type === 'expense')
    return exp.length ? `gerou ${exp.length} despesa(s)` : null
  })

  // --- 6. Lote confirmado não duplica ------------------------------------
  check(r, 'lote não duplica lançamentos', () => {
    const s = buildState()
    const out = applyBatchPure(s, batch([
      { kind: 'expense', amount: 50, category: 'alimentacao' },
      { kind: 'expense', amount: 50, category: 'alimentacao' },
    ]))
    if (out.state.transactions.length !== 2) return `${out.state.transactions.length} transações`
    const ids = new Set(out.state.transactions.map(t => t.id))
    return ids.size === 2 ? null : 'ids repetidos'
  })

  // --- 7. Ações dependentes enxergam o estado atualizado -----------------
  check(r, 'lote aplica sobre estado sequencial', () => {
    const s = buildState({ goals: [{ name: 'Viagem', target: 5000, saved: 0 }] })
    const out = applyBatchPure(s, batch([
      { kind: 'goal-deposit', name: 'Viagem', amount: 100 },
      { kind: 'goal-deposit', name: 'Viagem', amount: 200 },
    ]))
    return out.state.goals[0].saved === 300 ? null : `saved ${out.state.goals[0].saved} ≠ 300`
  })

  // --- 8. Atomicidade: falha no meio não grava nada ----------------------
  check(r, 'lote é atômico', () => {
    const s = buildState()
    const out = applyBatchPure(s, batch([
      { kind: 'expense', amount: 50, category: 'alimentacao' },
      { kind: 'goal-deposit', name: 'Meta que não existe', amount: 10 },
      { kind: 'expense', amount: 90, category: 'casa' },
    ]))
    if (out.applied) return 'lote com falha foi aplicado'
    if (out.state.transactions.length) return 'gravou parcialmente'
    const fail = out.results.find(x => !x.ok) as any
    return fail?.code === 'goal-not-found' ? null : `código ${fail?.code}`
  })

  // --- 9. Erro específico, nunca genérico -------------------------------
  check(r, 'erro de cartão não vira erro de meta', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const out = applyBatchPure(s, batch([{ kind: 'card-payment', cardName: 'Bradesco' }]), { atomic: false })
    const fail = out.results.find(x => !x.ok) as any
    if (!fail) return 'não falhou'
    if (fail.code !== 'card-not-found') return `código ${fail.code}`
    return /meta/i.test(fail.message) ? `mensagem fala de meta: "${fail.message}"` : null
  })

  // --- 10. Fatura sem pendência tem erro próprio -------------------------
  check(r, 'fatura vazia tem erro próprio', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const out = applyBatchPure(s, batch([{ kind: 'card-payment', cardName: 'Nubank' }]), { atomic: false })
    const fail = out.results.find(x => !x.ok) as any
    return fail?.code === 'invoice-empty' ? null : `código ${fail?.code}`
  })

  // --- 11. Ação remota respeita o perfil ---------------------------------
  check(r, 'ação de motorista é bloqueada em outro perfil', () => {
    for (const profile of ['clt', 'autonomo', 'other', 'business'] as const) {
      const caps = buildCapabilities(buildState({ profile }))
      for (const kind of ['work', 'fuel', 'odometer', 'maintenance']) {
        const res = validateAction({ kind, amount: 10, km: 10, value: 10, item: 'óleo', cost: 10 }, caps, TODAY, { allowRemoteOnly: true })
        if (!isValidationFailure(res)) return `${kind} passou em ${profile}`
        if (res.code !== 'profile-forbidden') return `${kind}/${profile}: código ${res.code}`
      }
    }
    return null
  })

  // --- 12. Categoria inventada é recusada --------------------------------
  check(r, 'categoria inexistente é recusada', () => {
    const caps = buildCapabilities(buildState())
    const res = validateAction({ kind: 'expense', amount: 10, category: 'xpto' }, caps, TODAY)
    if (!isValidationFailure(res)) return 'aceitou categoria inventada'
    return res.code === 'category-not-found' ? null : `código ${res.code}`
  })

  // --- 13. Categoria do tipo errado é recusada ---------------------------
  check(r, 'categoria de entrada não serve para despesa', () => {
    const caps = buildCapabilities(buildState())
    const res = validateAction({ kind: 'expense', amount: 10, category: 'salario' }, caps, TODAY)
    if (!isValidationFailure(res)) return 'aceitou categoria de entrada numa despesa'
    return res.code === 'category-wrong-type' ? null : `código ${res.code}`
  })

  // --- 14. Valores inválidos são recusados -------------------------------
  check(r, 'valores inválidos são recusados', () => {
    const caps = buildCapabilities(buildState())
    for (const amount of [0, -50, NaN, Infinity, null, undefined, '100' as any, 1e12]) {
      const res = validateAction({ kind: 'expense', amount }, caps, TODAY)
      if (!isValidationFailure(res)) return `aceitou amount=${String(amount)}`
    }
    return null
  })

  // --- 15. Datas impossíveis são recusadas -------------------------------
  check(r, 'datas inválidas são recusadas', () => {
    const caps = buildCapabilities(buildState())
    for (const date of ['2026-02-31', '15/07/2026', '2026-13-01', 'ontem', '1800-01-01', '2999-01-01']) {
      const res = validateAction({ kind: 'expense', amount: 10, date }, caps, TODAY)
      if (!isValidationFailure(res)) return `aceitou date=${date}`
    }
    return null
  })

  // --- 16. `reset` nunca vem da IA remota --------------------------------
  check(r, 'reset é bloqueado no canal remoto', () => {
    const caps = buildCapabilities(buildState())
    const res = validateAction({ kind: 'reset' }, caps, TODAY, { allowRemoteOnly: true })
    if (!isValidationFailure(res)) return 'aceitou reset remoto'
    for (const p of ['driver', 'clt', 'other'] as const) {
      if (allowedRemoteKinds(p).includes('reset')) return `reset listado como remoto em ${p}`
    }
    return null
  })

  // --- 17. `origin` sobrevive à sanitização remota -----------------------
  check(r, 'origin não é removido pelo sanitizador', () => {
    const caps = normalizeCapabilities({
      perfil: 'autonomo',
      categorias: [{ id: 'aluguel', name: 'Aluguéis', type: 'income' }],
    })
    const out = sanitizeRemoteResponse({
      version: 1, mode: 'propose_actions', reply: 'ok',
      actions: [{ kind: 'income', amount: 1800, category: 'aluguel', origin: 'Casa 1' }],
    }, caps, TODAY)
    const a: any = out?.actions[0]
    if (!a) return 'ação descartada'
    return a.origin === 'Casa 1' ? null : `origin "${a.origin}"`
  })

  // --- 18. `saving` sobrevive à sanitização remota -----------------------
  check(r, 'saving é aceito no canal remoto', () => {
    const caps = normalizeCapabilities({ perfil: 'clt', categorias: [] })
    const out = sanitizeRemoteResponse({
      version: 1, mode: 'propose_actions', reply: 'ok',
      actions: [{ kind: 'saving', amount: 150 }],
    }, caps, TODAY)
    return out?.actions[0]?.kind === 'saving' ? null : 'saving foi descartado'
  })

  // --- 19. Recusa remota nunca é silenciosa ------------------------------
  check(r, 'ação remota recusada é reportada', () => {
    const caps = normalizeCapabilities({ perfil: 'clt', categorias: [] })
    const out = sanitizeRemoteResponse({
      version: 1, mode: 'propose_actions', reply: 'ok',
      actions: [{ kind: 'fuel', amount: 100 }, { kind: 'transferencia', amount: 10 }],
    }, caps, TODAY)
    if (!out) return 'envelope recusado por inteiro'
    if (out.actions.length) return 'aceitou ação proibida'
    if (out.rejected.length !== 2) return `${out.rejected.length} recusas reportadas, esperava 2`
    return null
  })

  // --- 20. Envelope inválido nunca vira ação -----------------------------
  check(r, 'envelope inválido é recusado', () => {
    const caps = normalizeCapabilities({ perfil: 'clt', categorias: [] })
    const bad = [
      null, 'texto puro', [], { actions: [] }, { reply: '' },
      { version: 99, reply: 'oi' }, { reply: 'oi', mode: 'executar' },
      { reply: 'oi', actions: 'nada' },
    ]
    for (const b of bad) {
      if (sanitizeRemoteResponse(b, caps, TODAY)) return `aceitou ${JSON.stringify(b)}`
    }
    return null
  })

  // --- 21. Prompt é gerado do catálogo, não escrito à mão ---------------
  check(r, 'prompt cobre todo o catálogo remoto', () => {
    const caps = normalizeCapabilities({
      perfil: 'driver',
      categorias: [{ id: 'corridas', name: 'Corridas', type: 'income' }],
    })
    const prompt = buildSystemPrompt(caps, TODAY)
    for (const spec of ACTION_CATALOG) {
      if (!spec.remoteAllowed) {
        if (prompt.includes(`"kind":"${spec.kind}"`)) return `${spec.kind} não deveria estar no prompt`
        continue
      }
      if (!prompt.includes(`"kind":"${spec.kind}"`)) return `${spec.kind} ausente do prompt`
    }
    return null
  })

  // --- 22. Prompt não vaza segredo --------------------------------------
  check(r, 'prompt não contém segredo', () => {
    const caps = normalizeCapabilities({ perfil: 'clt', categorias: [] })
    const prompt = buildSystemPrompt(caps, TODAY)
    if (/sk-[A-Za-z0-9]/.test(prompt)) return 'padrão de chave no prompt'
    if (/DEEPSEEK_API_KEY/.test(prompt)) return 'nome da variável de chave no prompt'
    return null
  })

  // --- 23. Prompt de perfil não-motorista não fala de motorista ---------
  check(r, 'prompt respeita o perfil', () => {
    for (const perfil of ['clt', 'autonomo', 'other']) {
      const caps = normalizeCapabilities({ perfil, categorias: [] })
      const prompt = buildSystemPrompt(caps, TODAY)
      for (const kind of ['work', 'fuel', 'odometer', 'maintenance']) {
        if (prompt.includes(`"kind":"${kind}"`)) return `${kind} anunciado no perfil ${perfil}`
      }
    }
    return null
  })

  // --- 24. Simulação não altera o estado --------------------------------
  check(r, 'planAssistantActions não grava nada', () => {
    const s = buildState()
    const snapshot = JSON.stringify(s)
    planAssistantActions(s, batch([{ kind: 'expense', amount: 50, category: 'casa' }]))
    return JSON.stringify(s) === snapshot ? null : 'estado original foi mutado'
  })

  // --- 25. Auditoria: lote e origem gravados ----------------------------
  check(r, 'lançamento da IA guarda origem e lote', () => {
    const s = buildState()
    const out = applyBatchPure(s, batch([{ kind: 'expense', amount: 10, category: 'casa' }]), {
      source: 'ai', batchId: 'lote-1',
    })
    const t = out.state.transactions[0]
    if (t.source !== 'ai') return `source ${t.source}`
    if (t.assistantBatchId !== 'lote-1') return `batchId ${t.assistantBatchId}`
    if (!t.profileAtCreation) return 'perfil na criação ausente'
    return null
  })

  // --- 26. Toda ação do catálogo tem descrição legível ------------------
  check(r, 'describeAction cobre o catálogo inteiro', () => {
    const sample: Record<string, any> = {
      income: { amount: 10 }, expense: { amount: 10 }, saving: { amount: 10 },
      work: { km: 10 }, fuel: { amount: 10 }, odometer: { value: 10 },
      maintenance: { item: 'óleo', cost: 10 }, goal: { name: 'X', target: 10 },
      'goal-update': { name: 'X', target: 10 }, 'goal-deposit': { name: 'X', amount: 10 },
      balance: { amount: 10 }, 'card-purchase': { total: 10, installments: 2 },
      'financed-cash-inflow': { total: 10, netReceived: 9, installments: 2 },
      'card-payment': {}, 'card-charge': { amount: 10 }, reset: {},
    }
    for (const spec of ACTION_CATALOG) {
      const text = describeAction({ kind: spec.kind, ...sample[spec.kind] } as any)
      if (!text || /undefined|\[object/.test(text)) return `${spec.kind} → "${text}"`
    }
    return null
  })

  return r
}
