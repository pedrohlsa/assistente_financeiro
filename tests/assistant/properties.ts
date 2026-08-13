// Testes de PROPRIEDADE — invariantes que valem para qualquer entrada.
//
// Um caso de regressão prova uma frase. Uma invariante prova uma regra: por mais
// que o parser evolua, `saving` nunca pode virar despesa e entrada financiada
// nunca pode virar receita. É isto que impede uma regex nova de quebrar a
// contabilidade sem ninguém perceber.

import { readFileSync } from 'node:fs'
import { buildState, TODAY } from './harness'
import { hydrateForTest } from '../../src/store/store'
import { applyBatchPure, planAssistantActions } from '../../src/assistant/execute'
import { validateAction, isValidationFailure, ACTION_CATALOG, allowedRemoteKinds, actionSpec } from '../../src/assistant/contracts'
import { buildCapabilities, orchestrate } from '../../src/assistant/orchestrator'
import { findDate, findUnresolvedTemporalHint } from '../../src/assistant/dates'
import { editableFieldsFor } from '../../src/assistant/proposalEdit'
import { isRevertFailure, lastReversibleBatch, revertBatchPure } from '../../src/assistant/journal'
import { currentBalance, savedThisMonth, monthStats } from '../../src/services/calc'
import { buildSystemPrompt, normalizeCapabilities, sanitizeRemoteResponse } from '../../api/_lib/assistantPrompt'
import { callDeepSeekChat, isDeepSeekFailure } from '../../api/_lib/deepseek'
import { handleAssistantRequest } from '../../api/_lib/assistantHandler'
import { describeAction } from '../../src/services/nlp'
import { todayISO } from '../../src/utils/format'
import type { ParsedAction } from '../../src/models/types'
import type { AssistantCandidateAction, AssistantResponse } from '../../src/assistant/contracts'

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

const checkAsync = async (report: PropertyReport, name: string, fn: () => Promise<string | null>) => {
  report.total++
  try {
    const err = await fn()
    if (err) report.failures.push(`${name}: ${err}`)
  } catch (e: any) {
    report.failures.push(`${name}: exceção ${e?.message || e}`)
  }
}

/**
 * Frases usadas pelas invariantes temporais. Não são casos de regressão — cada
 * uma é só uma amostra para a REGRA ser exercitada: qualquer forma de falar de
 * tempo, entendida ou não, jamais pode virar um lançamento na data errada.
 */
const FRASES_TEMPORAIS = [
  'gastei 50 daqui a 3 dias',
  'gastei 50 em 3 dias',
  'gastei 50 no mercado dia 10/08',
  'paguei 200 dia 20/12',
  'gastei 50 dia 31/02',
  'gastei 50 dia 40/08',
  'gastei 40 amanhã',
  'depois de amanhã gastei 90',
  'gastei 50 na próxima semana',
  'mês que vem vou pagar 300',
  'gastei 80 na semana que vem',
  'gastei 50 em agosto',
  'vou pagar 100 em agosto',
  'gastei 50 há 3 dias',
  'gastei 50 3 dias atrás',
  'gastei 50 no fim do mês',
  'paguei 100 ano passado',
  'vou gastar 50 daqui a 3 dias',
  'daqui a 2 semanas vou pagar 300',
  'em 3 meses tenho uma parcela de 500',
  'vou gastar 50 dia 10/08',
  'amanhã vou pagar 120 de luz',
  'daqui a 1 ano vou trocar de carro por 40000',
  'em 2 semanas recebo 1200',
  'recebi 300 na sexta que vem',
  'paguei 100 mês passado',
  'gastei 80 semana passada',
  'ontem gastei 50',
  'anteontem gastei 50',
  'gastei 50 hoje',
  'gastei 50 dia 10/07',
  'gastei 50 no mercado',
  // Prazo de meta: "em 6 meses" é o horizonte do objetivo, não a data de um
  // fato — a expressão pertence à meta e o lançamento nem existe.
  'quero comprar um celular de 5000 em 6 meses',
]

/** Carimbo fixo: reversão comparada byte a byte não pode variar com o relógio. */
const CARIMBO = `${TODAY}T09:00`

/** Estado sem o journal — o que precisa voltar idêntico depois de desfazer. */
const semJournal = (s: any) => JSON.stringify({ ...s, assistantJournal: undefined })

/** Uma ação de exemplo por tipo do catálogo, com todos os campos preenchidos. */
const AMOSTRA: Record<string, any> = {
  income: { amount: 100, category: 'salario', description: 'X', origin: 'Casa 1', date: TODAY },
  expense: { amount: 100, category: 'casa', description: 'X', origin: 'Casa 1', date: TODAY },
  saving: { amount: 100, description: 'X', date: TODAY },
  work: { km: 10, trips: 2, hours: 3, date: TODAY },
  fuel: { amount: 100, liters: 20, pricePerLiter: 5, odometer: 90000, date: TODAY },
  odometer: { value: 90000 },
  maintenance: { item: 'óleo', cost: 200, km: 90000, lifeKm: 10000, date: TODAY },
  goal: { name: 'Bike', target: 2000, months: 6 },
  'goal-update': { name: 'Bike', target: 3000, months: 8 },
  'goal-deposit': { name: 'Bike', amount: 100 },
  balance: { amount: 1500 },
  'card-purchase': { total: 400, installments: 4, description: 'PC', cardName: 'Nubank', category: 'casa', firstDueDate: '2026-09-10' },
  'financed-cash-inflow': { total: 2000, netReceived: 1850, installments: 5, cardName: 'Nubank', source: 'Loja X' },
  'card-payment': { cardName: 'Nubank', amount: 300 },
  'card-charge': { amount: 39.9, description: 'Netflix', cardName: 'Nubank', category: 'assinaturas' },
  reset: {},
}

const rodar = (message: string) =>
  orchestrate({ state: buildState({ profile: 'other' }), message, history: [], remoteEnabled: false, today: TODAY })

/**
 * No modo `answer` o contrato tipa `actions` como tupla vazia, então percorrer
 * a união estreita o elemento para `never`. Isto devolve a lista já com o tipo
 * útil, em vez de espalhar `as any` pelos testes.
 */
const acoesDe = (res: AssistantResponse): AssistantCandidateAction[] => res.actions

/** A ação aceita data? Meta e saldo não aceitam — não faz sentido cobrá-las. */
const aceitaData = (kind: string) => !!actionSpec(kind)?.fields.some(f => f.name === 'date')

// --- Auditoria da DeepSeek, 100% offline -----------------------------------
// A API é substituída por um `fetch` falso. Nada sai da máquina, nenhuma chave
// real é usada e nenhum corpo de resposta é impresso.
const CFG_FALSA = { apiKey: 'chave-de-teste', model: 'modelo-de-teste', baseUrl: 'http://exemplo.invalido', timeoutMs: 2000 }

async function comFetchFalso<T>(
  responder: () => any,
  fn: (chamadas: any[]) => Promise<T>,
): Promise<T> {
  const chamadas: any[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: any, init: any) => {
    chamadas.push(JSON.parse(init.body))
    return responder()
  }) as any
  try {
    return await fn(chamadas)
  } finally {
    globalThis.fetch = original
  }
}

const respostaVazia = () => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: '   ' } }] }),
  text: async () => '',
})

const resposta502 = () => ({
  ok: false, status: 502,
  text: async () => 'Bad gateway: upstream pool exhausted for deepseek',
  json: async () => ({}),
})

export async function runProperties(): Promise<PropertyReport> {
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

  // --- 27. Proposta não sobrevive ao reload (nada de ação fantasma) --------
  check(r, 'reload limpa propostas pendentes', () => {
    const salvo = {
      settings: {}, chat: [
        { id: 'm1', role: 'assistant', text: 'Entendi isso…', time: '10:00',
          proposal: [{ id: 'a1', action: { kind: 'expense', amount: 120 } }] },
        { id: 'm2', role: 'assistant', text: 'Qual o valor?', time: '10:01',
          clarification: { question: 'Qual o valor?' } },
        { id: 'm3', role: 'assistant', text: 'Registrado!', time: '10:02' },
      ],
    }
    const hidratado = hydrateForTest(salvo)
    const m1 = hidratado.chat.find((m: any) => m.id === 'm1')
    const m2 = hidratado.chat.find((m: any) => m.id === 'm2')
    if (m1?.proposal) return 'proposta pendente sobreviveu ao reload'
    if (m2?.clarification) return 'esclarecimento pendente sobreviveu ao reload'
    if (hidratado.chat.length !== 3) return 'mensagens antigas foram perdidas'
    return null
  })

  // --- 28. Fato realizado NUNCA nasce com data futura --------------------
  // Vale para a proposta E para as opções de esclarecimento: escolher uma
  // opção também não pode gravar um dia que ainda não chegou.
  await checkAsync(r, 'nenhuma ação realizada tem data futura', async () => {
    for (const msg of FRASES_TEMPORAIS) {
      const out = await rodar(msg)
      for (const c of out.response.actions) {
        const d = (c.action as any).date
        if (d && d > TODAY) return `"${msg}" propôs ${c.action.kind} em ${d}`
      }
      const opts = out.response.mode === 'clarify' ? out.response.clarification.options || [] : []
      for (const o of opts) {
        for (const a of o.actions || []) {
          const d = (a as any).date
          if (d && d > TODAY) return `"${msg}" ofereceu ${a.kind} em ${d} na opção "${o.label}"`
        }
      }
    }
    return null
  })

  // --- 29. Expressão temporal reconhecida nunca é trocada por hoje -------
  // Esta é a invariante que faltava: `findDate` enxergava "10/08" e "mês
  // passado", a análise descartava, e o lançamento nascia com a data de hoje
  // sem ninguém avisar. Ou a ação carrega a data dita, ou não existe ação.
  await checkAsync(r, 'data reconhecida não vira hoje em silêncio', async () => {
    for (const msg of FRASES_TEMPORAIS) {
      const dito = findDate(msg, TODAY)
      const hint = dito ? null : findUnresolvedTemporalHint(msg)
      if (!dito && !hint) continue
      const out = await rodar(msg)
      const datáveis = acoesDe(out.response).filter(c => aceitaData(c.action.kind))
      if (!datáveis.length) continue
      if (hint) {
        return `"${msg}": o sinal temporal "${hint.text}" foi ignorado e ${datáveis.length} ação(ões) propostas`
      }
      if (dito.kind === 'date') {
        for (const c of datáveis) {
          const d = (c.action as any).date
          if (d !== dito.date) return `"${msg}": disse ${dito.date}, propôs ${d || 'sem data'}`
        }
      } else {
        // future/ambiguous/period não datam um fato: propor mesmo assim é
        // exatamente a falha silenciosa que esta tarefa foi corrigir.
        return `"${msg}": "${dito.text}" (${dito.kind}) foi ignorada e ${datáveis.length} ação(ões) propostas`
      }
    }
    return null
  })

  // --- 30. Resposta vazia: UMA segunda tentativa, e só ------------------
  // O "nudge" existe porque a DeepSeek devolve conteúdo em branco de forma
  // intermitente. Ele é uma tentativa única e mais rígida — nunca um laço.
  await checkAsync(r, 'resposta vazia tenta no máximo uma segunda vez', async () =>
    comFetchFalso(respostaVazia, async chamadas => {
      const out = await callDeepSeekChat(CFG_FALSA, [{ role: 'user', content: 'oi' }])
      if (!isDeepSeekFailure(out)) return 'aceitou resposta vazia como sucesso'
      if (out.code !== 'empty-reply') return `código ${out.code}`
      if (chamadas.length !== 2) return `${chamadas.length} tentativas, esperava exatamente 2`
      if (chamadas[1].messages.length !== chamadas[0].messages.length + 1) return 'a 2ª tentativa não é o nudge'
      if (chamadas[1].temperature !== 0) return 'a 2ª tentativa não baixou a temperatura'
      return null
    }))

  // --- 31. Erro HTTP nunca é repetido automaticamente -------------------
  await checkAsync(r, 'erro HTTP da DeepSeek não repete', async () => {
    for (const [status, esperado] of [[502, 'server-error'], [500, 'server-error'], [429, 'rate-limit'], [401, 'auth-invalid'], [402, 'insufficient-balance']] as const) {
      const err = await comFetchFalso(
        () => ({ ok: false, status, text: async () => '', json: async () => ({}) }),
        async chamadas => {
          const out = await callDeepSeekChat(CFG_FALSA, [{ role: 'user', content: 'oi' }])
          if (!isDeepSeekFailure(out)) return `${status} virou sucesso`
          if (out.code !== esperado) return `${status} → código ${out.code}, esperava ${esperado}`
          if (chamadas.length !== 1) return `${status} fez ${chamadas.length} tentativas`
          return null
        })
      if (err) return err
    }
    return null
  })

  // --- 32. Falha remota não vira ação nem vaza detalhe interno ----------
  await checkAsync(r, 'falha remota é segura e sem ação', async () => {
    for (const responder of [respostaVazia, resposta502]) {
      const res = await comFetchFalso(responder, () =>
        handleAssistantRequest({ message: 'vale a pena trocar de plano?', context: {}, history: [] }, CFG_FALSA))
      const corpo = JSON.stringify(res.body)
      if (res.status !== 502) return `status ${res.status}`
      if (res.body.actions?.length) return 'criou ação a partir de uma falha'
      if (/upstream|pool exhausted|Bad gateway/i.test(corpo)) return 'vazou o corpo bruto da API'
      if (/chave-de-teste|Bearer|authorization|exemplo\.invalido|modelo-de-teste/i.test(corpo)) return 'vazou chave, cabeçalho, URL ou modelo'
      if (!res.body.message) return 'sem mensagem para o usuário'
    }
    return null
  })

  // --- 33. Remoto indisponível não apaga o que o local entendeu ---------
  await checkAsync(r, 'ação local sobrevive à queda do remoto', async () => {
    const msgs = [
      'gastei 50 no mercado, o que você acha disso?',
      // O gasto é um FATO relatado no passado; a pergunta ao lado é opinião.
      // A regra de "pergunta de análise" engolia a despesa inteira.
      'gastei 50 no mercado, vale a pena trocar de plano?',
    ]
    for (const msg of msgs) {
      const out = await orchestrate({
        state: buildState({ profile: 'other' }), message: msg,
        history: [], remoteEnabled: true, askRemote: async () => null, today: TODAY,
      })
      const gasto = acoesDe(out.response).find(c => c.action.kind === 'expense')
      if (!gasto) return `"${msg}": a despesa sumiu (${out.response.actions.length} ações, modo ${out.response.mode})`
      if ((gasto.action as any).amount !== 50) return `"${msg}": valor ${(gasto.action as any).amount}`
    }
    return null
  })

  // --- 34. Pergunta que só o remoto responde tem resposta compreensível --
  // Sem isto o usuário recebia o texto genérico de ajuda — ou, pior, a frase
  // de negação ("entendi que isso não aconteceu") — sem nunca saber que a IA
  // remota é que estava fora do ar.
  await checkAsync(r, 'queda do remoto é explicada ao usuário', async () => {
    for (const msg of ['vale a pena eu trocar de plano de celular?', 'o que você acha de eu mudar de banco?']) {
      const out = await orchestrate({
        state: buildState({ profile: 'other' }), message: msg,
        history: [], remoteEnabled: true, askRemote: async () => null, today: TODAY,
      })
      const reply = out.response.reply
      if (/n[ãa]o aconteceu|n[ãa]o registrei nada/i.test(reply)) return `"${msg}" respondeu com a frase de negação`
      if (!/n[ãa]o consegui falar|indispon[íi]vel|tente de novo|instantes/i.test(reply)) {
        return `"${msg}" não avisou que o assistente está fora do ar: "${reply.slice(0, 80)}"`
      }
    }
    return null
  })

  // --- 35. "Confirmar?" só existe quando há botão para confirmar --------
  // `askAssistant` tem parser próprio e monta "Entendi isso… / Confirmar?".
  // Reaproveitar esse texto como RESPOSTA de uma pergunta produzia uma promessa
  // falsa: a tela mostrava a proposta e nenhum botão. Vale para qualquer modo.
  await checkAsync(r, 'proposta na resposta implica ação proposta', async () => {
    const msgs = [
      'gastei 50 no mercado, vale a pena trocar de plano?',
      'vale a pena eu trocar de plano de celular?',
      'o que você acha de eu mudar de banco?',
    ]
    for (const remoto of [true, false]) {
      for (const msg of msgs) {
        const out = await orchestrate({
          state: buildState({ profile: 'other' }), message: msg, history: [],
          remoteEnabled: remoto, askRemote: remoto ? async () => null : undefined, today: TODAY,
        })
        const prometeu = /entendi isso|confirmar\?/i.test(out.response.reply)
        if (prometeu && !out.response.actions.length) {
          return `"${msg}" (remoto ${remoto ? 'caído' : 'desligado'}) prometeu confirmação sem nenhuma ação`
        }
      }
    }
    return null
  })

  // --- 37. O lote grava um journal com o que CRIOU e o que ALTEROU ------
  // `assistantBatchId` dentro da entidade só marca o que NASCEU no lote. Um
  // depósito em meta e um pagamento de fatura alteram objetos que já existiam,
  // e sem registrar o estado anterior não há como reverter sem adivinhar.
  check(r, 'lote grava journal com entidades criadas e alteradas', () => {
    const s = buildState({ goals: [{ name: 'Viagem', target: 5000, saved: 100 }], cards: [{ name: 'Nubank' }] })
    const out = applyBatchPure(s, batch([
      { kind: 'expense', amount: 50, category: 'alimentacao' },
      { kind: 'goal-deposit', name: 'Viagem', amount: 200 },
      { kind: 'card-purchase', total: 400, installments: 2, cardName: 'Nubank' },
    ]), { source: 'ai', batchId: 'lote-1', engine: 'local', messageId: 'msg-1' })
    if (!out.applied) return 'lote não foi aplicado'
    const diario = out.state.assistantJournal
    if (!Array.isArray(diario) || diario.length !== 1) return `journal com ${diario?.length} entrada(s)`
    const e = diario[0]
    if (e.batchId !== 'lote-1') return `batchId "${e.batchId}"`
    if (e.engine !== 'local') return `engine "${e.engine}"`
    if (e.contractVersion !== 1) return `contrato ${e.contractVersion}`
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(e.createdAt))) return `createdAt "${e.createdAt}"`
    if (!e.profileAtCreation) return 'sem perfil na criação'
    if (e.messageId !== 'msg-1') return 'sem referência à mensagem de origem'
    if (e.source !== 'ai') return `source "${e.source}"`
    const feitos = e.ops.map(o => `${o.op}:${o.entity}`)
    for (const esperado of ['create:transactions', 'update:goals', 'create:installmentPlans', 'create:installments']) {
      if (!feitos.includes(esperado)) return `faltou ${esperado} (veio: ${feitos.join(', ')})`
    }
    const dep: any = e.ops.find(o => o.op === 'update' && o.entity === 'goals')
    if (dep?.before?.saved !== 100) return `estado anterior da meta: ${JSON.stringify(dep?.before)}`
    return null
  })

  // --- 38. Lote recusado não deixa rastro -------------------------------
  check(r, 'lote não aplicado não grava journal', () => {
    const s = buildState()
    const out = applyBatchPure(s, batch([
      { kind: 'expense', amount: 50, category: 'alimentacao' },
      { kind: 'goal-deposit', name: 'Meta que não existe', amount: 10 },
    ]), { source: 'ai', batchId: 'lote-2' })
    if (out.applied) return 'lote com falha foi aplicado'
    if (out.state.assistantJournal?.length) return 'gravou journal de um lote que não entrou'
    return null
  })

  // --- 39. O journal não guarda conversa nem segredo ---------------------
  check(r, 'journal guarda referência, nunca o texto da conversa', () => {
    const s = buildState()
    const out = applyBatchPure(s, batch([{ kind: 'expense', amount: 50, category: 'casa' }]), {
      source: 'ai', batchId: 'lote-3', engine: 'remote', messageId: 'msg-9',
    })
    const bruto = JSON.stringify(out.state.assistantJournal)
    if (/sk-[A-Za-z0-9]/.test(bruto)) return 'padrão de chave no journal'
    if (/gastei|recebi|mensagem|prompt/i.test(bruto)) return 'texto de conversa no journal'
    return null
  })

  // --- 40. Toda entidade que o assistente cria é auditável ---------------
  // Meta, cartão, assinatura, abastecimento, trabalho e manutenção também
  // precisam aparecer — não só transação e plano de parcelas.
  check(r, 'journal cobre todas as entidades do assistente', () => {
    const casos: [string, ParsedAction[], string][] = [
      ['meta', [{ kind: 'goal', name: 'Bike', target: 2000 }], 'create:goals'],
      ['abastecimento', [{ kind: 'fuel', amount: 100, liters: 20 }], 'create:fuelRecords'],
      ['trabalho', [{ kind: 'work', km: 120 }], 'create:workSessions'],
      ['manutenção', [{ kind: 'maintenance', item: 'óleo', cost: 200 }], 'create:maintenance'],
      ['saldo', [{ kind: 'balance', amount: 1500 }], 'patch:settings'],
      ['hodômetro', [{ kind: 'odometer', value: 90000 }], 'patch:vehicle'],
    ]
    for (const [nome, acoes, esperado] of casos) {
      const s = buildState({ profile: 'driver' })
      const out = applyBatchPure(s, batch(acoes), { source: 'ai', batchId: `b-${nome}` })
      if (!out.applied) return `${nome}: lote não aplicado`
      const feitos = (out.state.assistantJournal?.[0]?.ops || []).map(o => `${o.op}:${o.entity}`)
      if (!feitos.includes(esperado)) return `${nome}: faltou ${esperado} (veio: ${feitos.join(', ') || 'nada'})`
    }
    return null
  })

  // --- 41. Todo campo do catálogo é editável na proposta ----------------
  // A folha de edição era uma lista escrita à mão e ficou para trás do
  // catálogo: `name`, `months`, `item`, `lifeKm`, `pricePerLiter`,
  // `firstDueDate`, `source` e o `value` do hodômetro não apareciam — e a ação
  // de hodômetro não tinha NENHUM campo editável.
  check(r, 'todo campo do catálogo é editável na proposta', () => {
    const caps = buildCapabilities(buildState({ profile: 'driver', cards: [{ name: 'Nubank' }], goals: [{ name: 'Bike', target: 2000 }] }))
    for (const spec of ACTION_CATALOG) {
      if (spec.kind === 'reset') continue
      const acao: any = { kind: spec.kind, ...AMOSTRA[spec.kind] }
      const campos = editableFieldsFor(acao, caps).map(f => f.name)
      for (const f of spec.fields) {
        if (!campos.includes(f.name)) return `${spec.kind}.${f.name} não aparece na edição`
      }
      const extras = campos.filter(n => !spec.fields.some(f => f.name === n))
      if (extras.length) return `${spec.kind} oferece campo fora do catálogo: ${extras.join(', ')}`
    }
    return null
  })

  // --- 42. Edição inválida ou maliciosa nunca entra na proposta ---------
  check(r, 'edição passa por validateAction', () => {
    const caps = buildCapabilities(buildState({ profile: 'other', cards: [{ name: 'Nubank' }] }))
    const casos: [string, any, string][] = [
      ['valor zero', { kind: 'expense', amount: 0, category: 'casa' }, 'invalid-amount'],
      ['valor negativo', { kind: 'expense', amount: -50, category: 'casa' }, 'invalid-amount'],
      ['valor absurdo', { kind: 'expense', amount: 1e12, category: 'casa' }, 'invalid-amount'],
      ['categoria inventada', { kind: 'expense', amount: 10, category: 'xpto' }, 'category-not-found'],
      ['categoria de entrada numa despesa', { kind: 'expense', amount: 10, category: 'salario' }, 'category-wrong-type'],
      ['data futura', { kind: 'expense', amount: 10, category: 'casa', date: '2027-01-01' }, 'future-date'],
      ['data impossível', { kind: 'expense', amount: 10, category: 'casa', date: '2026-02-31' }, 'invalid-date'],
      ['parcelas zero', { kind: 'card-purchase', total: 100, installments: 0 }, 'invalid-number'],
      ['descrição gigante', { kind: 'expense', amount: 10, category: 'casa', description: 'x'.repeat(200) }, 'text-too-long'],
      ['ação de motorista fora do perfil', { kind: 'fuel', amount: 50 }, 'profile-forbidden'],
    ]
    for (const [nome, acao, codigo] of casos) {
      const res = validateAction(acao, caps, TODAY)
      if (!isValidationFailure(res)) return `${nome}: passou na validação`
      if (res.code !== codigo) return `${nome}: código ${res.code}, esperava ${codigo}`
    }
    return null
  })

  // --- 43. Campo de PREVISÃO continua podendo ser futuro ----------------
  // `firstDueDate` é vencimento, não fato consumado: a barreira `future-date`
  // não pode alcançá-lo, senão parcelamento nenhum seria editável.
  check(r, 'primeiro vencimento aceita data futura', () => {
    const caps = buildCapabilities(buildState({ cards: [{ name: 'Nubank' }] }))
    const res = validateAction(
      { kind: 'card-purchase', total: 400, installments: 4, cardName: 'Nubank', firstDueDate: '2027-03-10' },
      caps, TODAY,
    )
    if (isValidationFailure(res)) return `recusou com ${res.code}`
    return (res.action as any).firstDueDate === '2027-03-10' ? null : 'perdeu o vencimento'
  })

  // --- 44. Desfazer devolve o estado EXATAMENTE ao anterior -------------
  check(r, 'desfazer restaura o estado anterior do lote', () => {
    const casos: [string, ReturnType<typeof buildState>, ParsedAction[]][] = [
      ['várias transações', buildState(), [
        { kind: 'expense', amount: 50, category: 'alimentacao' },
        { kind: 'expense', amount: 90, category: 'casa' },
        { kind: 'income', amount: 300, category: 'salario' },
      ]],
      ['meta criada e depósito', buildState({ goals: [{ name: 'Bike', target: 2000, saved: 300 }] }), [
        { kind: 'goal', name: 'Viagem', target: 5000 },
        { kind: 'goal-deposit', name: 'Bike', amount: 200 },
      ]],
      ['compra parcelada', buildState({ cards: [{ name: 'Nubank' }] }), [
        { kind: 'card-purchase', total: 1200, installments: 3, cardName: 'Nubank' },
      ]],
      ['saldo informado', buildState({ balance: 500 }), [{ kind: 'balance', amount: 2000 }]],
    ]
    for (const [nome, inicial, acoes] of casos) {
      const antes = semJournal(inicial)
      const feito = applyBatchPure(inicial, batch(acoes), { source: 'ai', batchId: 'b1', stamp: CARIMBO })
      if (!feito.applied) return `${nome}: lote não aplicado`
      const rev = revertBatchPure(feito.state, 'b1', CARIMBO)
      if (isRevertFailure(rev)) return `${nome}: reversão recusada (${rev.code})`
      if (semJournal(rev.state) !== antes) return `${nome}: estado não voltou ao original`
    }
    return null
  })

  // --- 45. Pagamento de fatura desfeito devolve as parcelas -------------
  check(r, 'desfazer pagamento de fatura reabre as parcelas', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }], balance: 5000 })
    // Vencimento dentro do mês corrente do teste: sem isso a fatura está vazia
    // e o pagamento é recusado antes de quitar qualquer parcela.
    const agora = { date: TODAY, time: '10:00' }
    const comPlano = applyBatchPure(s, batch([
      { kind: 'card-purchase', total: 400, installments: 1, cardName: 'Nubank', firstDueDate: '2026-07-10' },
    ]), { source: 'ai', batchId: 'compra', stamp: CARIMBO, now: agora }).state
    const antes = semJournal(comPlano)
    const pago = applyBatchPure(comPlano, batch([{ kind: 'card-payment', cardName: 'Nubank' }]), {
      source: 'ai', batchId: 'pagamento', stamp: CARIMBO, now: agora,
    })
    if (!pago.applied) return 'pagamento não aplicado'
    if (!pago.state.installments.some(i => i.status === 'paid')) return 'nenhuma parcela foi quitada'
    const rev = revertBatchPure(pago.state, 'pagamento', CARIMBO)
    if (isRevertFailure(rev)) return `reversão recusada (${rev.code})`
    if (rev.state.cardPayments.length) return 'pagamento continuou registrado'
    if (rev.state.installments.some(i => i.status === 'paid')) return 'parcela continuou quitada'
    if (semJournal(rev.state) !== antes) return 'estado não voltou ao de antes do pagamento'
    return null
  })

  // --- 46. Ocorrência recorrente volta a ficar pendente -----------------
  // O assistente ainda não confirma ocorrência por conversa; o que se prova
  // aqui é o MECANISMO: uma operação de recorrência no journal é revertida e a
  // ocorrência resolvida some, podendo ser confirmada de novo uma única vez.
  check(r, 'desfazer devolve a ocorrência recorrente para pendente', () => {
    const base = buildState()
    const recorrente: any = {
      id: 'rec1', kind: 'expense', name: 'Internet', amount: 120, dueDay: 10,
      frequency: 'monthly', startDate: '2026-07-10', occurrences: [],
    }
    const antes: any = { ...base, recurring: [recorrente] }
    const depois: any = {
      ...antes,
      recurring: [{ ...recorrente, occurrences: [{ date: '2026-07-10', status: 'confirmed' }] }],
      transactions: [{ id: 't1', type: 'expense', amount: 120, category: 'casa', date: '2026-07-10', recurringId: 'rec1', occurrenceDate: '2026-07-10' }],
      assistantJournal: [{
        batchId: 'rec-lote', contractVersion: 1, source: 'ai', createdAt: CARIMBO,
        ops: [
          { op: 'create', entity: 'transactions', id: 't1' },
          { op: 'update', entity: 'recurring', id: 'rec1', before: { occurrences: [] } },
        ],
      }],
    }
    const rev = revertBatchPure(depois, 'rec-lote', CARIMBO)
    if (isRevertFailure(rev)) return `reversão recusada (${rev.code})`
    if (rev.state.transactions.length) return 'a movimentação continuou gravada'
    const occ = (rev.state.recurring[0] as any).occurrences
    if (occ?.length) return `ocorrência continuou resolvida: ${JSON.stringify(occ)}`
    return null
  })

  // --- 47. Lote desconhecido, antigo ou já desfeito é RECUSADO ----------
  check(r, 'lote sem journal nunca é revertido por adivinhação', () => {
    const s = buildState()
    const feito = applyBatchPure(s, batch([{ kind: 'expense', amount: 50, category: 'casa' }]), {
      source: 'ai', batchId: 'b1', stamp: CARIMBO,
    })
    const inexistente = revertBatchPure(feito.state, 'lote-que-nunca-existiu', CARIMBO)
    if (!isRevertFailure(inexistente)) return 'reverteu um lote inexistente'
    if (inexistente.code !== 'batch-not-found') return `código ${inexistente.code}`
    if (!/movimenta|desfazer|segurança/i.test(inexistente.message)) return 'mensagem não explica o motivo'

    // Duplo undo: a segunda tentativa não pode aplicar a reversão de novo.
    const um = revertBatchPure(feito.state, 'b1', CARIMBO)
    if (isRevertFailure(um)) return `primeira reversão falhou (${um.code})`
    const dois = revertBatchPure(um.state, 'b1', CARIMBO)
    if (!isRevertFailure(dois)) return 'desfez o mesmo lote duas vezes'
    if (dois.code !== 'already-undone') return `segundo undo: código ${dois.code}`
    return null
  })

  // --- 48. Reversão não deixa entidade órfã nem meia reversão -----------
  check(r, 'reversão é atômica e não deixa órfão', () => {
    const s = buildState({ cards: [{ name: 'Nubank' }] })
    const feito = applyBatchPure(s, batch([
      { kind: 'card-purchase', total: 900, installments: 3, cardName: 'Nubank' },
      { kind: 'expense', amount: 40, category: 'casa' },
    ]), { source: 'ai', batchId: 'b1', stamp: CARIMBO })
    const rev = revertBatchPure(feito.state, 'b1', CARIMBO)
    if (isRevertFailure(rev)) return `recusou (${rev.code})`
    if (rev.state.installmentPlans.length) return 'plano ficou'
    if (rev.state.installments.length) return `${rev.state.installments.length} parcela(s) órfã(s)`
    if (rev.state.transactions.length) return 'transação ficou'

    // Falha não pode deixar estado meio revertido.
    const falhou = revertBatchPure(feito.state, 'inexistente', CARIMBO)
    if (!isRevertFailure(falhou)) return 'não recusou'
    if (semJournal(feito.state) !== semJournal(feito.state)) return 'estado foi mutado'
    return null
  })

  // --- 49. Desfazer não vira um lote auditável novo ---------------------
  check(r, 'desfazer fecha o lote em vez de criar outro', () => {
    const s = buildState()
    const feito = applyBatchPure(s, batch([{ kind: 'expense', amount: 50, category: 'casa' }]), {
      source: 'ai', batchId: 'b1', stamp: CARIMBO,
    })
    const rev = revertBatchPure(feito.state, 'b1', CARIMBO)
    if (isRevertFailure(rev)) return `recusou (${rev.code})`
    const diario = rev.state.assistantJournal || []
    if (diario.length !== 1) return `${diario.length} entradas no journal`
    if (!diario[0].undoneAt) return 'lote revertido não foi marcado como desfeito'
    if (lastReversibleBatch(rev.state)) return 'o lote desfeito continua sendo oferecido para desfazer'
    return null
  })

  // --- 50. Corrigir NUNCA muda o tipo da movimentação -------------------
  // Trocar despesa por receita em silêncio inverteria o sinal do dinheiro no
  // mês inteiro. O campo simplesmente não existe na ação.
  check(r, 'correção não troca o tipo do lançamento', () => {
    if (actionSpec('edit-transaction')?.fields.some(f => f.name === 'type')) return 'o catálogo aceita trocar o tipo'
    for (const tipo of ['income', 'expense', 'saving'] as const) {
      const s = buildState()
      s.transactions = [{ id: 'tx1', type: tipo, amount: 100, category: tipo === 'income' ? 'salario' : 'casa', date: TODAY, time: '10:00' } as any]
      const out = applyBatchPure(s, batch([
        { kind: 'edit-transaction', transactionId: 'tx1', amount: 80, type: 'income' } as any,
      ]), { source: 'ai', batchId: 'b1', stamp: CARIMBO })
      const t: any = out.state.transactions[0]
      if (t.type !== tipo) return `${tipo} virou ${t.type}`
      if (t.amount !== 80) return `${tipo}: valor ${t.amount}`
    }
    return null
  })

  // --- 51. Correção é auditável e reversível ----------------------------
  check(r, 'correção guarda o valor anterior no journal', () => {
    const s = buildState()
    s.transactions = [{ id: 'tx1', type: 'expense', amount: 100, category: 'casa', description: 'Mercado', date: '2026-07-14', time: '10:00' } as any]
    const antes = semJournal(s)
    const out = applyBatchPure(s, batch([
      { kind: 'edit-transaction', transactionId: 'tx1', amount: 80 },
    ]), { source: 'ai', batchId: 'b1', stamp: CARIMBO })
    const op: any = out.state.assistantJournal?.[0]?.ops?.find(o => o.op === 'update' && o.entity === 'transactions')
    if (!op) return 'a correção não foi registrada como alteração'
    if (op.before?.amount !== 100) return `valor anterior ${JSON.stringify(op.before)}`
    const rev = revertBatchPure(out.state, 'b1', CARIMBO)
    if (isRevertFailure(rev)) return `reversão recusada (${rev.code})`
    if (semJournal(rev.state) !== antes) return 'desfazer não devolveu o valor original'
    return null
  })

  // --- 52. Ocorrência recorrente: editar ≠ desfazer ---------------------
  // Editar o valor de uma conta já confirmada não pode liberar a ocorrência
  // para ser confirmada outra vez — isso duplicaria o lançamento do mês.
  check(r, 'editar ocorrência materializada não mexe na recorrente', () => {
    const s = buildState()
    const rec: any = { id: 'rec1', kind: 'expense', name: 'Luz', amount: 120, dueDay: 10, frequency: 'monthly', startDate: '2026-07-10', occurrences: [{ date: '2026-07-10', status: 'confirmed' }] }
    s.recurring = [rec]
    s.transactions = [{ id: 'tx1', type: 'expense', amount: 120, category: 'casa', date: '2026-07-10', time: '10:00', recurringId: 'rec1', occurrenceDate: '2026-07-10' } as any]
    const out = applyBatchPure(s, batch([
      { kind: 'edit-transaction', transactionId: 'tx1', amount: 135 },
    ]), { source: 'ai', batchId: 'b1', stamp: CARIMBO })
    const t: any = out.state.transactions[0]
    if (t.amount !== 135) return `valor ${t.amount}`
    if (t.recurringId !== 'rec1' || t.occurrenceDate !== '2026-07-10') return 'perdeu o vínculo com a recorrente'
    if (JSON.stringify(out.state.recurring) !== JSON.stringify(s.recurring)) return 'o template da recorrente foi alterado'
    return null
  })

  // --- 53. Correção nunca vem do canal remoto ---------------------------
  // O histórico não é enviado para a IA remota, então ela também não pode
  // propor correção sobre lançamentos que não vê.
  check(r, 'edit-transaction e undo-batch são bloqueados no remoto', () => {
    const caps = buildCapabilities(buildState())
    for (const kind of ['edit-transaction', 'undo-batch']) {
      const res = validateAction({ kind, transactionId: 'tx1', batchId: 'b1', amount: 10 }, caps, TODAY, { allowRemoteOnly: true })
      if (!isValidationFailure(res)) return `${kind} aceito do remoto`
      if (res.code !== 'unsupported-action') return `${kind}: código ${res.code}`
      for (const p of ['driver', 'clt', 'other'] as const) {
        if (allowedRemoteKinds(p).includes(kind as any)) return `${kind} listado como remoto em ${p}`
      }
    }
    return null
  })

  // --- 54. O sinal do dinheiro do motorista nunca se inverte -------------
  // "foi 400 hoje" registrava R$ 400 de DESPESA: `foi` é verbo de gasto no
  // parser, e o faturamento do dia entrava com o sinal trocado. A invariante
  // vale para a classe inteira, não para a frase que o bug mostrou.
  await checkAsync(r, 'resultado do dia do motorista nunca vira despesa', async () => {
    const frases = [
      'deu 200 hoje', 'foi 400 hoje', 'hoje foi fraco so 150 reais',
      'fechei o dia com 280', 'tirei 300 liquido hoje', 'dia bom hoje 320',
      'so 90 reais hoje', 'rodei o dia todo e deu 180', 'hoje deu 250 na rua',
    ]
    const s = buildState({ profile: 'driver' })
    for (const message of frases) {
      const out = await orchestrate({ state: s, message, history: [], remoteEnabled: false, today: TODAY })
      const acoes: AssistantCandidateAction[] = out.response.actions
      const gasto = acoes.find(a => a.action.kind === 'expense')
      if (gasto) return `"${message}" virou despesa de ${(gasto.action as any).amount}`
    }
    return null
  })

  // --- 55. Verbo de gasto explícito manda sempre -------------------------
  // A regra do resultado do dia não pode "promover" um gasto a receita só
  // porque a frase fala de hoje — seria o mesmo erro no sentido contrário.
  await checkAsync(r, 'verbo de gasto explícito nunca vira receita', async () => {
    const frases = [
      'gastei 200 hoje', 'paguei 90 hoje', 'comprei 50 hoje',
      'torrei 120 hoje', 'gastei o dia todo 80',
    ]
    const s = buildState({ profile: 'driver' })
    for (const message of frases) {
      const out = await orchestrate({ state: s, message, history: [], remoteEnabled: false, today: TODAY })
      const acoes: AssistantCandidateAction[] = out.response.actions
      const receita = acoes.find(a => a.action.kind === 'income')
      if (receita) return `"${message}" virou receita de ${(receita.action as any).amount}`
    }
    return null
  })

  // --- 56. Perguntar sobre dinheiro nunca é gastar dinheiro ---------------
  // A regra "item e preço, sem verbo" (parseSemVerbo) casa com frases que não
  // têm verbo conjugado — e pergunta usa infinitivo: "posso GASTAR 50 no
  // mercado?" virava despesa de 50. Vale para a classe toda.
  await checkAsync(r, 'pergunta com valor nunca vira lançamento', async () => {
    const frases = [
      'posso gastar 50 no mercado?', 'da pra gastar 80 hoje no lanche?',
      'quanto posso gastar de gasolina?', 'vale a pena uma corrida de 12 reais?',
      'devo separar 200 esse mes?', 'tem como economizar 300 no mercado?',
    ]
    for (const p of ['driver', 'other'] as const) {
      const s = buildState({ profile: p })
      for (const message of frases) {
        const out = await orchestrate({ state: s, message, history: [], remoteEnabled: false, today: TODAY })
        const acoes: AssistantCandidateAction[] = out.response.actions
        const registro = acoes.find(a => ['expense', 'income', 'fuel', 'saving'].includes(a.action.kind))
        if (registro) return `[${p}] "${message}" virou ${registro.action.kind}`
      }
    }
    return null
  })

  // --- 57. "Tô no lucro?" e "tô no vermelho?" têm polaridade OPOSTA --------
  // Um "Sim" fixo respondia "sim, você está no vermelho" para quem tinha
  // sobra: número certo, resposta errada. O corpus não pegaria isto porque
  // `resolveLocal` lê o relógio real da máquina, não a data injetada — por
  // isso a invariante monta as datas a partir de `todayISO()`.
  await checkAsync(r, 'lucro e vermelho respondem com sinais opostos', async () => {
    const hoje = todayISO()
    const cenario = (income: number, expense: number) => {
      const s = buildState({ profile: 'driver' })
      s.transactions = [
        { id: 'i', type: 'income', amount: income, category: 'corridas', date: hoje, time: '10:00' },
        { id: 'e', type: 'expense', amount: expense, category: 'alimentacao', date: hoje, time: '11:00' },
      ] as any
      return s
    }
    const perguntar = async (s: any, message: string) =>
      (await orchestrate({ state: s, message, history: [], remoteEnabled: false, today: TODAY })).response.reply

    const sobra = cenario(600, 135)
    const deficit = cenario(100, 400)

    if (!/^Sim/.test(await perguntar(sobra, 'to no lucro?'))) return 'com sobra, "tô no lucro?" não respondeu Sim'
    if (!/^N[ãa]o/.test(await perguntar(sobra, 'to no vermelho?'))) return 'com sobra, "tô no vermelho?" não respondeu Não'
    if (!/^N[ãa]o/.test(await perguntar(deficit, 'to no lucro?'))) return 'com déficit, "tô no lucro?" não respondeu Não'
    if (!/^Sim/.test(await perguntar(deficit, 'to no vermelho?'))) return 'com déficit, "tô no vermelho?" não respondeu Sim'
    // Pergunta de VALOR não começa com sim/não — seria resposta de outra.
    if (/^(Sim|N[ãa]o)\b/.test(await perguntar(sobra, 'quanto sobrou'))) return '"quanto sobrou" respondeu como sim/não'
    return null
  })

  // --- 58. Trabalho de dias diferentes nunca é somado ---------------------
  // A fusão de registros de trabalho existe porque "rodei 120 km e fiz 14
  // viagens" é UM turno. Mas ela somava tudo sem olhar a data, então "ontem
  // rodei 100 km e hoje rodei 200 km" virava um único dia de 300 km — com o km
  // de hoje lançado em ontem, estragando o custo por km dos dois dias.
  await checkAsync(r, 'km e viagens não atravessam dias', async () => {
    const s = buildState({ profile: 'driver' })
    const out = await orchestrate({
      state: s, message: 'ontem rodei 100 km e hoje rodei 200 km',
      history: [], remoteEnabled: false, today: TODAY,
    })
    const acoes: AssistantCandidateAction[] = out.response.actions
    const works = acoes.map(a => a.action).filter(a => a.kind === 'work') as any[]
    if (works.length !== 2) return `esperava 2 registros de trabalho, veio ${works.length}`
    const porData = new Map(works.map(w => [w.date, w.km]))
    if (porData.get('2026-07-14') !== 100) return `ontem ficou com ${porData.get('2026-07-14')} km`
    if (porData.get('2026-07-15') !== 200) return `hoje ficou com ${porData.get('2026-07-15')} km`
    return null
  })

  // --- 59. Dinheiro tem UM formatador, como tem UM parser (regra 12) ------
  // `describeAction` montava o valor à mão com `toFixed(2).replace('.', ',')`,
  // que não põe separador de milhar: a proposta mostrava "R$ 3200,00" na
  // exata tela onde o usuário confere antes de gravar. "R$ 15000,00" se lê
  // errado com muito mais facilidade que "R$ 15.000,00".
  check(r, 'nlp.ts não formata dinheiro à mão', () => {
    const src = readFileSync(new URL('../../src/services/nlp.ts', import.meta.url), 'utf8')
    if (/toFixed\(2\)\s*\.replace\(/.test(src)) return 'ainda há formatação manual de dinheiro em nlp.ts'
    const proposta = describeAction({ kind: 'income', amount: 15000, category: 'salario' } as any)
    if (!/15\.000,00/.test(proposta)) return `sem separador de milhar: "${proposta}"`
    return null
  })

  // --- 36. A tela devolve ao orquestrador a pergunta que ficou aberta ---
  // Invariante de FIAÇÃO, não de lógica: o corpus sempre passou
  // `pendingClarification`, então ele nunca poderia ver que `Chat.tsx` não
  // passava. Resultado: clicar numa opção mandava o rótulo como texto solto e o
  // efeito embutido na opção era perdido — só aparecia no navegador.
  check(r, 'Chat devolve a pergunta pendente ao orquestrador', () => {
    const src = readFileSync(new URL('../../src/screens/Chat.tsx', import.meta.url), 'utf8')
    if (!/pendingClarification:\s*clarificationRef\.current/.test(src)) {
      return 'Chat.tsx não passa pendingClarification para orchestrate'
    }
    if (!/clarificationRef\.current\s*=\s*out\.response\.mode === 'clarify'/.test(src)) {
      return 'Chat.tsx não guarda a pergunta de esclarecimento da resposta'
    }
    return null
  })

  return r
}
