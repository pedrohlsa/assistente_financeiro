// Regressões adversariais pelo caminho que a tela usa: mensagem → orchestrate
// → resposta/proposta/foco. O oráculo financeiro é literal, não runScenario.
import type { AppState } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { monthlyProjections } from '../../src/services/calc'
import { applyBatchPure } from '../../src/assistant/execute'
import { applyPreferenceAliases } from '../../src/assistant/preferences'
import { hydrateForTest, reducer } from '../../src/store/store'
import { autonomoRico } from '../fixtures/richState'
import { buildState } from './harness'

const TODAY = '2026-09-15'

export interface AdversarialResult { id: string; actual: unknown; expected: unknown; ok: boolean }

const recurringIncome = (amount = 1000) => ({
  id: 'salary', name: 'Salário', amount, frequency: 'monthly' as const,
  dueDay: 20, startDate: '2026-09-20', category: 'salario', kind: 'income' as const, active: true,
})

function baseline(): AppState {
  const s = buildState({ profile: 'autonomo', balance: 0 })
  s.recurring = [recurringIncome()]
  return s
}

async function scenario(s: AppState, message: string) {
  const out = await orchestrate({ state: s, message, today: TODAY, remoteEnabled: false })
  return {
    mode: out.response.mode, reply: out.response.reply,
    actions: out.response.actions.map(a => a.action),
    plan: out.focus?.lastScenarioPlan, months: out.focus?.lastScenario?.months,
  }
}

async function turn(s: AppState, message: string, focus?: Awaited<ReturnType<typeof orchestrate>>['focus']) {
  const out = await orchestrate({ state: s, message, today: TODAY, remoteEnabled: false, focus })
  return {
    mode: out.response.mode, reply: out.response.reply,
    actions: out.response.actions.map(a => a.action),
    clarification: out.response.mode === 'clarify' ? out.response.clarification : undefined,
    preferenceMutation: out.preferenceMutation, focus: out.focus,
  }
}

const result = (id: string, actual: unknown, expected: unknown, ok: boolean): AdversarialResult => ({ id, actual, expected, ok })

export async function runAdversarialReal(): Promise<AdversarialResult[]> {
  const out: AdversarialResult[] = []

  const c1 = baseline()
  c1.transactions = ['2026-06-10', '2026-07-10', '2026-08-10'].map((date, i) => ({
    id: `obra-${i}`, type: 'expense', amount: 300, category: 'obra', date, description: 'Obra', time: '10:00',
  }))
  const c1Answer = await scenario(c1, 'Se eu parar a obra e guardar metade do que sobrar até dezembro.')
  out.push(result('C1-corte', c1Answer, '4 meses; sobra R$ 1.000, depósito R$ 500/mês, acumulado R$ 2.000',
    c1Answer.months?.length === 4 && c1Answer.months.every(m => m.saved === 500 && m.surplus === 1000)
      && c1Answer.months[3].accumulated === 2000))

  const c1Reduce = await scenario(c1, 'Se eu reduzir alimentação em 1300 e guardar tudo que sobrar até dezembro.')
  out.push(result('C1-reducao', c1Reduce, 'sem alimentação futura: sobra e reserva R$ 1.000/mês, R$ 4.000 acumulados',
    c1Reduce.months?.length === 4 && c1Reduce.months.every(m => m.surplus === 1000 && m.saved === 1000)
      && c1Reduce.months[3].accumulated === 4000))

  const c1Capped = baseline()
  c1Capped.recurring.push({ id: 'food', name: 'Alimentação', amount: 200, frequency: 'monthly',
    dueDay: 25, startDate: '2026-09-25', category: 'alimentacao', kind: 'expense', active: true })
  const c1CappedAnswer = await scenario(c1Capped, 'Se eu reduzir alimentação em 1300 e guardar tudo que sobrar até dezembro.')
  out.push(result('C1-reducao-limitada', c1CappedAnswer,
    'redução de R$ 1.300 fica limitada aos R$ 200/mês existentes na projeção',
    c1CappedAnswer.months?.length === 4 && c1CappedAnswer.months.every(m => m.surplus === 1000 && m.saved === 1000)))

  const c2Salary = baseline()
  c2Salary.settings.balance = 800
  c2Salary.settings.balanceAsOf = TODAY
  c2Salary.recurring = [{ ...recurringIncome(), startDate: '2026-09-05', dueDay: 5,
    occurrences: [{ date: '2026-09-05', status: 'confirmed', txId: 'salary-paid', amount: 1000 }] }]
  c2Salary.transactions = [{ id: 'salary-paid', type: 'income', amount: 1000, category: 'salario', date: '2026-09-05',
    recurringId: 'salary', occurrenceDate: '2026-09-05', time: '10:00' }]
  const c2SalaryAnswer = await scenario(c2Salary, 'Se eu guardar tudo que sobrar até setembro, quanto teria?')
  out.push(result('C2-salario', { projection: monthlyProjections(c2Salary, 1, TODAY), scenario: c2SalaryAnswer },
    'setembro não soma de novo o salário recebido; saldo estimado R$ 800',
    monthlyProjections(c2Salary, 1, TODAY)[0]?.runningBalance === 800
      && c2SalaryAnswer.months?.[0]?.before === 800 && c2SalaryAnswer.months[0].saved === 0))

  const c2Installment = baseline()
  c2Installment.recurring = []
  c2Installment.settings.balance = 800
  c2Installment.settings.balanceAsOf = TODAY
  c2Installment.installments = [{ id: 'paid', planId: 'plan', number: 1, total: 1, amount: 200,
    dueDate: '2026-09-10', status: 'paid', paidAt: '2026-09-10' }]
  const c2InstallmentAnswer = await scenario(c2Installment, 'Se eu guardar tudo que sobrar até setembro, quanto teria?')
  out.push(result('C2-parcela', { projection: monthlyProjections(c2Installment, 1, TODAY), scenario: c2InstallmentAnswer },
    'parcela já paga não reduz saldo R$ 800', monthlyProjections(c2Installment, 1, TODAY)[0]?.runningBalance === 800
      && c2InstallmentAnswer.months?.[0]?.before === 800))

  const c2Bi = baseline()
  c2Bi.recurring = [{ ...recurringIncome(), frequency: 'monthly', startDate: '2026-09-20',
    interval: 2, intervalUnit: 'month' }]
  const c2BiAnswer = await scenario(c2Bi, 'Se eu guardar tudo que sobrar até dezembro, quanto teria?')
  out.push(result('C2-bimestral', { projection: monthlyProjections(c2Bi, 4, TODAY), scenario: c2BiAnswer },
    'entradas setembro–dezembro [1000,0,1000,0]',
    JSON.stringify(monthlyProjections(c2Bi, 4, TODAY).map(m => m.incomes)) === '[1000,0,1000,0]'
      && JSON.stringify(c2BiAnswer.months?.map(m => m.saved)) === '[1000,0,1000,0]'))

  const c2End = baseline()
  c2End.recurring = [{ id: 'end', name: 'Conta', amount: 200, frequency: 'monthly', dueDay: 28,
    startDate: '2026-09-28', endDate: '2026-10-01', category: 'casa', kind: 'expense', active: true }]
  const c2EndAnswer = await scenario(c2End, 'Se eu guardar tudo que sobrar até dezembro, quanto teria?')
  out.push(result('C2-encerramento', { projection: monthlyProjections(c2End, 4, TODAY), scenario: c2EndAnswer },
    'conta dia 28: setembro R$ 200, outubro R$ 0',
    JSON.stringify(monthlyProjections(c2End, 4, TODAY).map(m => m.bills)) === '[200,0,0,0]'
      && c2EndAnswer.months?.[1]?.before === -200))

  for (const [id, phrase, ratio] of [
    ['H1-30', 'Se eu guardar 30% da sobra até dezembro', 0.3],
    ['H1-extenso', 'Se eu guardar trinta por cento da sobra até dezembro', 0.3],
    ['H1-metade', 'Se eu guardar metade da sobra até dezembro', 0.5],
    ['H1-50', 'Se eu guardar 50% da sobra até dezembro', 0.5],
    ['H1-tudo', 'Se eu guardar tudo que sobrar até dezembro', 1],
  ] as const) {
    const actual = await scenario(baseline(), phrase)
    out.push(result(id, actual, `save-share ${ratio}, quatro meses e valor acumulado literal`,
      actual.plan?.kind === 'save-share' && actual.plan.ratio === ratio && actual.months?.length === 4
        && actual.months.every(m => m.saved === 1000 * ratio)
        && actual.months[3].accumulated === 4000 * ratio))
  }

  const h2Purchase = await scenario(baseline(), 'Se eu comprar algo de R$ 1.234,56 em 10x')
  out.push(result('H2-compra', h2Purchase, 'purchase principal R$ 1.234,56 em 10x',
    h2Purchase.plan?.kind === 'purchase' && h2Purchase.plan.amount === 1234.56 && h2Purchase.plan.installments === 10))
  const h2Reduce = await scenario(baseline(), 'Se eu reduzir alimentação em 100,50')
  out.push(result('H2-reducao', h2Reduce, 'reduce R$ 100,50',
    h2Reduce.plan?.kind === 'reduce' && h2Reduce.plan.amount === 100.5))
  const h2K = await scenario(baseline(), 'Se eu comprar algo de 2,5k em 10x')
  out.push(result('H2-2,5k', h2K, 'purchase principal R$ 2.500 em 10x',
    h2K.plan?.kind === 'purchase' && h2K.plan.amount === 2500 && h2K.plan.installments === 10))
  const h2Comma = await scenario(baseline(), 'Se eu guardar 30% da sobra, depois reduzir alimentação em 100')
  out.push(result('H2-virgula-textual', h2Comma, 'vírgula entre cláusulas mantém dois passos em ordem',
    h2Comma.plan?.kind === 'compound' && h2Comma.plan.steps?.[0]?.kind === 'save-share'
      && h2Comma.plan.steps?.[1]?.kind === 'reduce'))

  const h4Start = await scenario(baseline(), 'Se eu guardar metade só a partir de novembro até dezembro')
  out.push(result('H4-inicio', h4Start, 'somente novembro e dezembro recebem depósitos',
    !!h4Start.months?.length && h4Start.months.filter(m => !!m.saved).length === 2
      && h4Start.months.filter(m => !!m.saved)[0]?.monthKey === '2026-11'))
  const h4Year = await scenario(baseline(), 'Se eu guardar metade da sobra até dezembro de 2027')
  out.push(result('H4-ano', h4Year, 'limite de 12 meses dito sem valor projetado',
    /12 meses/.test(h4Year.reply) && !/acumulado|R\$\s*2\.027/.test(h4Year.reply)))
  const h4Unsupported = await scenario(baseline(), 'Se eu guardar metade da sobra até dezembro e investir 200 em ações')
  out.push(result('H4-investir', h4Unsupported, 'investimento representado, esclarecido ou explicitamente não incluído',
    /não incluí[^\n]*investir 200/i.test(h4Unsupported.reply)))

  const c3Teach = await turn(baseline(), 'quando eu falar cem é mil')
  const c3State = baseline()
  if (c3Teach.preferenceMutation?.type === 'upsert') c3State.assistantPreferences = [c3Teach.preferenceMutation.preference]
  const c3Spent = await turn(c3State, 'gastei cem reais no mercado')
  out.push(result('C3-dinheiro', { teach: c3Teach, spent: c3Spent }, 'recusar ensino; gasto continua R$ 100',
    !c3Teach.preferenceMutation && c3Spent.actions.every(a => !('amount' in a) || a.amount !== 1000)))
  const c3Week = await turn(baseline(), 'quando eu falar sexta é segunda')
  out.push(result('C3-data', c3Week, 'recusar alias de dia da semana', !c3Week.preferenceMutation))
  const c3Protected = await Promise.all([
    'quando eu falar amanhã é hoje',
    'quando eu falar gasto é renda',
    'quando eu falar confirmado é pendente',
    'quando eu falar 10x é 12x',
    'quando eu falar não é sim',
    'quando eu falar trinta é quarenta',
  ].map(message => turn(baseline(), message)))
  out.push(result('C3-classes', c3Protected.map(x => x.preferenceMutation),
    'data, polaridade, confirmação, parcela e número não podem ser ensinados',
    c3Protected.every(x => !x.preferenceMutation)))

  const m2State = baseline()
  const m2First = await turn(m2State, 'quando eu falar gasosa é gasolina')
  const m2Second = await turn(m2State, 'quando eu falar gasosa é etanol')
  let m2Applied = m2State
  for (const proposal of [m2First, m2Second]) {
    if (proposal.preferenceMutation?.type === 'upsert') {
      m2Applied = reducer(m2Applied, { type: 'assistantPreferenceUpsert', preference: proposal.preferenceMutation.preference })
    }
  }
  const m2Removal = await turn(m2Applied, 'esquece preferência gasosa')
  const m2Removed = m2Removal.preferenceMutation?.type === 'remove'
    ? reducer(m2Applied, { type: 'assistantPreferenceRemove', id: m2Removal.preferenceMutation.id }) : m2Applied
  out.push(result('M2-concorrencia', {
    proposals: [m2First.preferenceMutation, m2Second.preferenceMutation],
    applied: m2Applied.assistantPreferences, removed: m2Removed.assistantPreferences,
  }, 'um trigger, valor da última confirmação, remoção efetiva',
  m2Applied.assistantPreferences?.length === 1 && m2Applied.assistantPreferences[0].value === 'etanol'
    && m2Removed.assistantPreferences?.length === 0))

  const m3Teach = await turn(baseline(), 'quando eu falar café é cafeteria')
  const m3State = baseline()
  if (m3Teach.preferenceMutation?.type === 'upsert') {
    m3State.assistantPreferences = [m3Teach.preferenceMutation.preference]
  }
  const m3Forms = ['café', 'CAFÉ', 'cafe', 'decafeinado'].map(x => applyPreferenceAliases(m3State, x))
  out.push(result('M3-acentos', m3Forms, 'três grafias equivalentes; não substituir palavra parcial',
    JSON.stringify(m3Forms) === '["cafeteria","cafeteria","cafeteria","decafeinado"]'))

  const malformed = { id: 'bad', kind: 'alias', trigger: { nested: true }, value: 'gasolina', source: 'user-explicit' }
  const m4Hydrated = hydrateForTest({ assistantPreferences: [malformed] })
  const m4MergedObject = reducer(m4Hydrated, { type: 'mergeState', state: { assistantPreferences: {} as never } })
  const m4MergedArray = reducer(m4MergedObject, { type: 'mergeState', state: {
    assistantPreferences: [malformed, ...(m2Applied.assistantPreferences || [])] as never,
  } })
  out.push(result('M4-backup', {
    hydrated: m4Hydrated.assistantPreferences, mergedObject: m4MergedObject.assistantPreferences,
    mergedArray: m4MergedArray.assistantPreferences,
  }, 'malformados ignorados sem quebrar merge',
  m4Hydrated.assistantPreferences?.length === 0 && m4MergedObject.assistantPreferences?.length === 0
    && m4MergedArray.assistantPreferences?.length === 1))

  const m1State = buildState({ profile: 'driver', transactions: [
    { id: 'food-june', type: 'expense', amount: 60, category: 'alimentacao', date: '2026-06-05' },
    { id: 'food-aug', type: 'expense', amount: 30, category: 'alimentacao', date: '2026-08-05' },
    { id: 'food-sep', type: 'expense', amount: 100, category: 'alimentacao', date: '2026-09-05' },
    { id: 'leisure-sep', type: 'expense', amount: 50, category: 'lazer', date: '2026-09-05' },
    { id: 'fuel-sep', type: 'expense', amount: 900, category: 'combustivel', date: '2026-09-05' },
  ] })
  const m1Categories = await turn(m1State, 'quanto gastei com alimentação e lazer este mês?')
  const m1Separate = await turn(m1State, 'separadas', m1Categories.focus)
  out.push(result('M1-separadas', { question: m1Categories, answer: m1Separate },
    'segundo turno retoma duas categorias, total R$ 150 em dois grupos',
    m1Categories.mode === 'clarify' && m1Separate.focus?.lastQuery?.total === 150
      && m1Separate.focus?.lastQuery?.groups.length === 2
      && /Alimentação/.test(m1Separate.reply) && /Lazer/.test(m1Separate.reply)))
  const m1Period = await turn(m1State, 'quanto gastei com alimentação nos últimos meses?')
  const m1Three = await turn(m1State, '3 meses', m1Period.focus)
  const m1Since = await turn(m1State, 'desde junho', m1Period.focus)
  out.push(result('M1-tres-meses', { question: m1Period, answer: m1Three },
    'julho–setembro alimentação = R$ 130',
    m1Period.mode === 'clarify' && m1Three.focus?.lastQueryPlan?.period.from === '2026-07-01'
      && m1Three.focus?.lastQuery?.total === 130))
  out.push(result('M1-desde-junho', m1Since, 'junho–setembro alimentação = R$ 190',
    m1Since.focus?.lastQueryPlan?.period.from === '2026-06-01'
      && m1Since.focus?.lastQuery?.total === 190))

  const h3State = buildState({ profile: 'autonomo', transactions: [
    { id: 'casa1', type: 'income', amount: 100, category: 'aluguel', origin: 'Casa 1', date: '2026-09-05' },
    { id: 'casa2', type: 'income', amount: 200, category: 'aluguel', origin: 'Casa 2', date: '2026-09-05' },
    { id: 'casa3', type: 'income', amount: 9000, category: 'aluguel', origin: 'Casa 3', date: '2026-09-05' },
    { id: 'empresa', type: 'income', amount: 500, category: 'freelance', origin: 'Empresa A', date: '2026-09-05' },
  ] })
  const h3Together = await turn(h3State, 'Quanto recebi da Casa 1 e Casa 2 juntas?')
  const h3Compare = await turn(h3State, 'Casa 1 ou Casa 2, qual rendeu mais?')
  const h3Three = await turn(h3State, 'Quanto recebi da Casa 1, Casa 2 e Empresa A juntas?')
  const h3Separate = await turn(h3State, 'Casa 1 ou Casa 2 separadas, quanto recebi?')
  out.push(result('H3-juntas', h3Together, 'total R$ 300; filtros Casa 1 e Casa 2',
    /300,00/.test(h3Together.reply) && !/9\.800,00|9\.000,00/.test(h3Together.reply)))
  out.push(result('H3-compara', h3Compare, 'maior Casa 2; nunca Casa 3',
    /Casa 2/.test(h3Compare.reply) && !/Casa 3/.test(h3Compare.reply)))
  out.push(result('H3-tres', h3Three, 'somente Casa 1, Casa 2 e Empresa A = R$ 800',
    h3Three.focus?.lastQuery?.total === 800 && h3Three.focus?.lastQueryPlan?.filter.origins?.length === 3))
  out.push(result('H3-separadas', h3Separate, 'Casa 1 e Casa 2 separadas; não Casa 3',
    h3Separate.focus?.lastQuery?.total === 300
      && h3Separate.focus?.lastQuery?.groups?.length === 2
      && !/Casa 3/.test(h3Separate.reply)))

  const h5 = await turn(autonomoRico(TODAY), 'Por que gastei mais em alimentação desde junho?')
  out.push(result('H5-drivers', h5, 'escopo alimentação desde junho ou uma clarificação objetiva',
    h5.mode === 'clarify' || (!!h5.focus?.lastDriver
      && h5.focus.lastDriver.analysis.current.from === '2026-06-01'
      && h5.focus.lastDriver.analysis.drivers.every(d => d.key === 'alimentacao'))))
  const h5Category = await turn(autonomoRico(TODAY), 'Por que gastei mais em alimentação?')
  out.push(result('H5-categoria', h5Category, 'comparação padrão limitada à categoria alimentação',
    h5Category.focus?.lastDriver?.analysis.drivers.every(d => d.key === 'alimentacao') === true
      && h5Category.focus?.lastDriver?.analysis.totals.incomeAfter === 0))

  const h6State = autonomoRico(TODAY)
  const h6a = await turn(h6State, 'Quanto gastei com obra esse mês?')
  const h6b = await turn(h6State, 'Se eu guardar metade do que sobrar até dezembro.', h6a.focus)
  const h6c = await turn(h6State, 'E tirando alimentação?', h6b.focus)
  out.push(result('H6-followup', { first: h6a, second: h6b, third: h6c },
    'terceiro turno permanece cenário ou esclarece; não consulta obra histórica',
    h6c.focus?.last !== 'query' && !/Total gasto.*obra/i.test(h6c.reply)))

  const m6State = baseline()
  m6State.recurring.push({ id: 'obra-futura', name: 'Obra', amount: 200, frequency: 'monthly',
    dueDay: 25, startDate: '2026-09-25', category: 'obra', kind: 'expense', active: true })
  const m6Simple = await scenario(m6State, 'Se eu parar a obra')
  const m6Compound = await scenario(m6State, 'Se eu parar a obra e guardar metade do que sobrar até dezembro')
  out.push(result('M6-corte', { simple: m6Simple, compound: m6Compound },
    'ambos removem os mesmos R$ 200 futuros; sobra R$ 1.000',
    m6Simple.months?.[0]?.after === 1000 && m6Simple.months?.[0]?.before === 800
      && m6Compound.months?.[0]?.surplus === 1000
      && m6Compound.months?.[0]?.saved === 500))

  const h7Mixed = await turn(buildState({ profile: 'driver' }), 'Paguei 30 no pneu e vou gastar 40 no combustível')
  const h7Applied = applyBatchPure(buildState({ profile: 'driver' }),
    h7Mixed.actions.map((action, i) => ({ id: `h7-${i}`, action })), { source: 'ai' })
  out.push(result('H7-futuro', { answer: h7Mixed, applied: h7Applied.state.transactions },
    'pneu R$ 30 realizado; combustível R$ 40 não aplicado',
    h7Mixed.actions.some(a => a.kind === 'expense' && a.amount === 30)
      && !h7Mixed.actions.some(a => 'amount' in a && a.amount === 40)
      && /40/.test(h7Mixed.reply) && /n[ãa]o registrei/i.test(h7Mixed.reply)
      && !h7Applied.state.transactions.some(t => t.amount === 40)))
  const h7Pix = await turn(buildState(), 'Minha filha pediu um Pix de 15')
  out.push(result('H7-pix-pedido', h7Pix, 'perguntar se Pix foi enviado; nenhuma despesa',
    h7Pix.actions.length === 0 && /envi|mand|fez|pag/i.test(h7Pix.reply)))
  const h7Ride = await turn(buildState({ profile: 'driver' }), 'Tocou uma corrida de 70')
  out.push(result('H7-corrida-tocou', h7Ride, 'corrida oferecida não é receita',
    !h7Ride.actions.some(a => a.kind === 'income' && a.amount === 70)))
  const h7Unpaid = await turn(buildState({ profile: 'driver' }), 'Fiz uma corrida de 70, mas o passageiro ainda não pagou')
  out.push(result('H7-corrida-nao-paga', h7Unpaid, 'corrida não paga não é receita recebida',
    !h7Unpaid.actions.some(a => a.kind === 'income' && a.amount === 70)
      && /70/.test(h7Unpaid.reply) && /n[ãa]o.*pagou/i.test(h7Unpaid.reply)))

  const h8 = await turn(buildState({ profile: 'driver' }), 'Mandei 15 de pix para minha filha comprar sorvete')
  const h8Applied = applyBatchPure(buildState({ profile: 'driver' }),
    h8.actions.map((action, i) => ({ id: `h8-${i}`, action })), { source: 'ai' })
  out.push(result('H8-pix-km', { answer: h8, applied: h8Applied.state.workSessions },
    'não criar trabalho de 15 km por Pix',
    h8.actions.some(a => a.kind === 'expense' && a.amount === 15)
      && !h8.actions.some(a => a.kind === 'work' && a.km === 15)
      && h8Applied.state.workSessions.length === 0
      && h8Applied.state.transactions.some(t => t.type === 'expense' && t.amount === 15)))

  const h9Correction = await turn(buildState({ profile: 'driver' }), 'Gastei 40 no combustível, quer dizer 45, e 30 no pneu')
  const h9CorrectedState = applyBatchPure(buildState({ profile: 'driver' }),
    h9Correction.actions.map((action, i) => ({ id: `h9-correction-${i}`, action })), { source: 'ai' }).state
  out.push(result('H9-correcao', h9Correction, 'combustível R$ 45 e pneu R$ 30, ambos representados',
    h9Correction.actions.some(a => a.kind === 'fuel' && a.amount === 45)
      && h9Correction.actions.some(a => a.kind === 'expense' && a.amount === 30 && a.category === 'manutencao')
      && !h9Correction.actions.some(a => 'amount' in a && a.amount === 40)
      && h9CorrectedState.transactions.some(t => t.amount === 45 && t.category === 'combustivel')
      && h9CorrectedState.transactions.some(t => t.amount === 30 && t.category === 'manutencao')))
  const h9Residue = await turn(buildState({ profile: 'driver' }), 'gastei 40 no combustível e 30 adicionais no pneu')
  out.push(result('H9-residuo', h9Residue, 'R$ 30 não pode ficar só na descrição do gasto de R$ 40',
    h9Residue.actions.some(a => a.kind === 'fuel' && a.amount === 40)
      && (h9Residue.actions.some(a => 'amount' in a && a.amount === 30)
        || (h9Residue.mode === 'clarify' && /30/.test(h9Residue.reply)))))
  const h9Refund = await turn(buildState(), 'Recebi 70, mas devolvi 20')
  out.push(result('H9-devolucao', h9Refund, 'R$ 20 como ação ou clarificação; nunca sumir',
    h9Refund.actions.some(a => 'amount' in a && a.amount === 20)
      || (h9Refund.mode === 'clarify' && /20/.test(h9Refund.reply))))
  const h9Whole = await turn(buildState({ profile: 'driver' }),
    'fiz 20 reais, gastei 40 em combustievl, furando o pneu foi mais 30, minha filha pediu um pix de 15, tocou uma corrida de 70 reais')
  const h9Applied = applyBatchPure(buildState({ profile: 'driver' }),
    h9Whole.actions.map((action, i) => ({ id: `h9-${i}`, action })), { source: 'ai' })
  out.push(result('H9-frase-completa', h9Whole,
    '20 recebido; 40 combustível; 30 pneu; 15 Pix pedido e 70 corrida oferecida esclarecidos, sem registrar os dois últimos',
    h9Whole.actions.filter(a => a.kind === 'income' && a.amount === 20).length === 1
      && h9Whole.actions.filter(a => a.kind === 'expense' && a.amount === 40 && a.category === 'combustivel').length === 1
      && h9Whole.actions.filter(a => a.kind === 'expense' && a.amount === 30 && a.category === 'manutencao').length === 1
      && !h9Whole.actions.some(a => 'amount' in a && (a.amount === 15 || a.amount === 70))
      && /Pix[^\n]*15/.test(h9Whole.reply) && /corrida[^\n]*70/.test(h9Whole.reply)
      && h9Applied.state.transactions.some(t => t.type === 'income' && t.amount === 20)
      && h9Applied.state.transactions.some(t => t.type === 'expense' && t.amount === 40 && t.category === 'combustivel')
      && h9Applied.state.transactions.some(t => t.type === 'expense' && t.amount === 30 && t.category === 'manutencao')
      && !h9Applied.state.transactions.some(t => t.amount === 15 || t.amount === 70)))
  return out
}

if (process.argv.includes('--probe')) {
  runAdversarialReal().then(results => {
    for (const r of results) console.log(JSON.stringify(r))
    console.log(`${results.filter(r => r.ok).length}/${results.length} adversarial`)
  }).catch(err => { console.error(err); process.exitCode = 1 })
}
