// Regressões adversariais pelo caminho que a tela usa: mensagem → orchestrate
// → resposta/proposta/foco. O oráculo financeiro é literal, não runScenario.
import type { AppState } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { currentBalance, monthlyProjections, occurrencesBetween } from '../../src/services/calc'
import { cardInvoice, cardOutstanding, cardsOverview } from '../../src/services/cards'
import { applyBatchPure } from '../../src/assistant/execute'
import { applyPreferenceAliases } from '../../src/assistant/preferences'
import { hydrateForTest, reducer } from '../../src/store/store'
import { addDays, fmtBRL, fromISO, monthShortLabel, nowPaymentTime, nowStamp, todayISO, toISO as toISOdate } from '../../src/utils/format'
import { autonomoRico, motoristaRico } from '../fixtures/richState'
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

/** A DSL usa o `today` injetado; estados montados em volta do relógio real precisam dele. */
async function turnoHoje(s: AppState, message: string, focus?: Awaited<ReturnType<typeof orchestrate>>['focus']) {
  const out = await orchestrate({ state: s, message, today: todayISO(), remoteEnabled: false, focus })
  return { reply: out.response.reply, actions: out.response.actions.map(a => a.action), focus: out.focus || focus }
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
    h2Purchase.plan?.kind === 'purchase' && h2Purchase.plan.amount === 1234.56 && h2Purchase.plan.installments === 10
      && /R\$\s*1\.234,56\s+em\s+10x/.test(h2Purchase.reply)
      && /R\$\s*123,45\s+por\s+mês/.test(h2Purchase.reply)
      && h2Purchase.months?.[1]?.after === 1876.55))
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
    !c3Teach.preferenceMutation && c3Spent.actions.length === 1
      && c3Spent.actions[0].kind === 'expense' && c3Spent.actions[0].amount === 100))
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
  const h5Compared = await turn(autonomoRico(TODAY), 'sim', h5.focus)
  out.push(result('H5-continuacao', h5Compared,
    'junho–setembro contra período anterior equivalente, só alimentação: R$ 940 → R$ 2.125',
    h5Compared.focus?.lastDriver?.analysis.current.from === '2026-06-01'
      && h5Compared.focus?.lastDriver?.analysis.previous.to === '2026-05-31'
      && h5Compared.focus?.lastDriver?.analysis.totals.expenseBefore === 940
      && h5Compared.focus?.lastDriver?.analysis.totals.expenseAfter === 2125
      && h5Compared.focus?.lastDriver?.analysis.drivers.every(d => d.key === 'alimentacao') === true
      && h5Compared.focus?.lastDriver?.analysis.reconciled === true))
  const h5Category = await turn(autonomoRico(TODAY), 'Por que gastei mais em alimentação?')
  out.push(result('H5-categoria', h5Category, 'comparação padrão limitada à categoria alimentação',
    h5Category.focus?.lastDriver?.analysis.drivers.every(d => d.key === 'alimentacao') === true
      && h5Category.focus?.lastDriver?.analysis.totals.incomeAfter === 0))

  const h6State = autonomoRico(TODAY)
  const h6a = await turn(h6State, 'Quanto gastei com obra esse mês?')
  const h6b = await turn(h6State, 'Se eu guardar metade do que sobrar até dezembro.', h6a.focus)
  const h6c = await turn(h6State, 'E tirando alimentação?', h6b.focus)
  out.push(result('H6-followup', { first: h6a, second: h6b, third: h6c },
    'terceiro turno simula tirar alimentação ou pergunta claramente o que falta',
    h6c.focus?.last !== 'query' && !/Total gasto.*obra/i.test(h6c.reply)
      && (/Simulação.*alimentação/is.test(h6c.reply)
        || (h6c.mode === 'clarify' && /alimenta[cç][ãa]o/i.test(h6c.reply)))))

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

  const c3Modality = await Promise.all([
    'quando eu falar queria é comprei',
    'quando eu falar agora é anteontem',
  ].map(message => turn(baseline(), message)))
  out.push(result('C3-modalidade-tempo', c3Modality, 'nenhuma preferência muda intenção ou data',
    c3Modality.every(x => !x.preferenceMutation)))
  const c3Entity = await turn(baseline(), 'sobrado é minha Casa 1')
  const c3AliasState = baseline()
  if (c3Entity.preferenceMutation?.type === 'upsert') c3AliasState.assistantPreferences = [c3Entity.preferenceMutation.preference]
  const c3Aliased = await turn(c3AliasState, 'recebi 100 do sobrado')
  out.push(result('C3-alias-entidade', c3Aliased, 'R$ 100, origem Casa 1',
    c3Aliased.actions.some(a => a.kind === 'income' && a.amount === 100 && a.origin === 'Casa 1')))

  const daily = baseline()
  daily.recurring.push({ id: 'old-daily', name: 'Diária', amount: 10, frequency: 'monthly',
    dueDay: 1, startDate: '2025-01-01', interval: 1, intervalUnit: 'day',
    category: 'casa', kind: 'expense', active: true })
  const dailyAnswer = await scenario(daily, 'Se eu guardar tudo que sobrar até dezembro')
  const dailyProjection = monthlyProjections(daily, 4, TODAY)
  out.push(result('C2-diaria-antiga', { answer: dailyAnswer, projection: dailyProjection },
    '108 ocorrências futuras; reservas [840,690,700,690], total R$ 2.920',
    occurrencesBetween(daily.recurring[1], TODAY, '2026-12-31', TODAY).length === 108
      && JSON.stringify(dailyProjection.map(m => m.bills)) === '[160,310,300,310]'
      && JSON.stringify(dailyAnswer.months?.map(m => m.saved)) === '[840,690,700,690]'
      && dailyAnswer.months?.[3]?.accumulated === 2920))

  const paidCard = buildState({ profile: 'autonomo', balance: 1000,
    cards: [{ name: 'Inter', dueDay: 20, closingDay: 5 }] })
  paidCard.settings.balanceAsOf = '2026-09-14T00:00'
  paidCard.cardCharges = [{ id: 'charge', cardId: 'card0', description: 'Assinatura', amount: 200,
    frequency: 'monthly', nextDate: '2026-09-20', active: true, createdAt: '2026-09-01' }]
  const paid = applyBatchPure(paidCard, [{ id: 'pay-inter', action: { kind: 'card-payment', cardName: 'Inter', amount: 200 } }],
    { source: 'ai', now: { date: TODAY, time: '10:00' } })
  const paidProjection = monthlyProjections(paid.state, 1, TODAY)
  out.push(result('C2-assinatura-paga', { paid: paid.applied, balance: currentBalance(paid.state), projection: paidProjection },
    'saldo R$ 800 e setembro não desconta assinatura já paga',
    paid.applied && currentBalance(paid.state) === 800 && paidProjection[0]?.runningBalance === 800
      && paidProjection[0]?.installments === 0))
  const manuallyPaidCard = buildState({ profile: 'autonomo', balance: 800,
    cards: [{ name: 'Inter', dueDay: 20, closingDay: 5 }] })
  manuallyPaidCard.settings.balanceAsOf = TODAY
  manuallyPaidCard.installmentPlans = [{ id: 'manual-plan', description: 'Compra', cardId: 'card0',
    totalAmount: 200, installmentCount: 1, firstDueDate: '2026-09-20', purchaseDate: '2026-09-01',
    status: 'active', operationType: 'card-purchase', createdAt: '2026-09-01' }]
  manuallyPaidCard.installments = [{ id: 'manual-inst', planId: 'manual-plan', number: 1, total: 1,
    amount: 200, dueDate: '2026-09-20', status: 'paid', paidAt: '2026-09-10', paidAmount: 200 }]
  out.push(result('C2-parcela-cartao-paga-avulsa', monthlyProjections(manuallyPaidCard, 1, TODAY),
    'parcela do cartão já marcada paga não volta à projeção',
    monthlyProjections(manuallyPaidCard, 1, TODAY)[0]?.installments === 0))
  const directStart = buildState({ profile: 'autonomo', balance: 1000,
    cards: [{ name: 'Inter', dueDay: 20, closingDay: 5 }] })
  directStart.settings.balanceAsOf = '2026-09-09T00:00'
  directStart.installmentPlans = manuallyPaidCard.installmentPlans
  directStart.installments = [{ ...manuallyPaidCard.installments[0], status: 'pending', paidAt: undefined, paidAmount: undefined }]
  const directPaid = reducer(directStart, { type: 'payInstallment', id: 'manual-inst', paidAt: '2026-09-10' })
  const directInvoice = cardInvoice(directPaid, directPaid.cards[0], '2026-09')
  out.push(result('C2-parcela-marcada-paga-caixa',
    { balance: currentBalance(directPaid), invoice: directInvoice.pending,
      projection: monthlyProjections(directPaid, 1, TODAY)[0]?.runningBalance },
    'pagar R$ 200 diretamente: saldo R$ 800, fatura pendente R$ 0, projeção R$ 800',
    currentBalance(directPaid) === 800 && directInvoice.pending === 0
      && monthlyProjections(directPaid, 1, TODAY)[0]?.runningBalance === 800))
  const directUndone = reducer(directPaid, { type: 'unpayInstallment', id: 'manual-inst' })
  out.push(result('C2-desfazer-pagamento-direto',
    { balance: currentBalance(directUndone), invoice: cardInvoice(directUndone, directUndone.cards[0], '2026-09').pending },
    'desmarcar pagamento devolve saldo R$ 1.000 e fatura R$ 200',
    currentBalance(directUndone) === 1000
      && cardInvoice(directUndone, directUndone.cards[0], '2026-09').pending === 200))
  const viaInvoice = applyBatchPure(directStart,
    [{ id: 'invoice-pay', action: { kind: 'card-payment', cardName: 'Inter', amount: 200 } }],
    { source: 'ai', now: { date: '2026-09-10', time: '10:00' } })
  out.push(result('C2-parcela-paga-pela-fatura',
    { balance: currentBalance(viaInvoice.state), invoice: cardInvoice(viaInvoice.state, viaInvoice.state.cards[0], '2026-09').pending },
    'pagamento de fatura quita parcela sem desconto duplo no saldo',
    viaInvoice.applied && viaInvoice.state.installments[0]?.paidVia === 'invoice'
      && currentBalance(viaInvoice.state) === 800
      && cardInvoice(viaInvoice.state, viaInvoice.state.cards[0], '2026-09').pending === 0))

  for (const [id, phrase, ratio, monthly, total] of [
    ['H1-percentual-decimal', 'Se eu guardar 30,5% da sobra até dezembro', 0.305, 305, 1220],
    ['H1-percentual-pequeno', 'Se eu guardar 2,5% da sobra até dezembro', 0.025, 25, 100],
  ] as const) {
    const actual = await scenario(baseline(), phrase)
    out.push(result(id, actual, `${ratio * 100}% da sobra, ${monthly} por mês, total ${total}`,
      actual.plan?.kind === 'save-share' && actual.plan.ratio === ratio
        && actual.months?.every(m => m.saved === monthly)
        && actual.months?.[3]?.accumulated === total
        && !/R\$\s*30,50\s+por\s+mês/.test(actual.reply)))
  }
  const h4Fixed = await scenario(baseline(), 'Se eu guardar 100 reais por mês a partir de novembro até dezembro')
  out.push(result('H4-fixo-com-datas', h4Fixed, 'somente novembro e dezembro: R$ 200 até dezembro',
    h4Fixed.plan?.kind === 'save' && h4Fixed.plan.startMonth === '2026-11'
      && JSON.stringify(h4Fixed.months?.map(m => m.saved)) === '[0,0,100,100]'
      && /R\$\s*200,00\s+até\s+dez\/2026/.test(h4Fixed.reply)))
  const h4Second = await scenario(baseline(), 'Se eu guardar metade da sobra até dezembro depois investir 200 em ações')
  out.push(result('H4-segunda-operacao', h4Second, 'investir R$ 200 fica explicitamente fora da simulação',
    /n[ãa]o inclu[íi][^\n]*investir 200/i.test(h4Second.reply)))
  const h4Help = await scenario(baseline(), 'Se eu guardar metade da sobra até dezembro e ajudar minha filha com 200 reais por mês')
  out.push(result('H4-ajuda', h4Help, 'ajuda mensal fica explicitamente fora da simulação',
    /n[ãa]o inclu[íi][^\n]*ajudar minha filha/i.test(h4Help.reply)))

  const h5Last = await turn(m1State, 'Por que gastei mais em alimentação mês passado?')
  const h5August = await turn(m1State, 'Por que gastei mais em alimentação em agosto?')
  out.push(result('H5-periodos-explicitos', { last: h5Last, august: h5August },
    'agosto R$ 30 comparado a julho R$ 0, sem usar setembro como mês atual',
    [h5Last, h5August].every(x => x.focus?.lastDriver?.analysis.current.from === '2026-08-01'
      && x.focus.lastDriver.analysis.previous.from === '2026-07-01'
      && x.focus.lastDriver.analysis.totals.expenseAfter === 30
      && x.focus.lastDriver.analysis.totals.expenseBefore === 0)))

  const unpaidSame = await turn(buildState({ profile: 'driver' }), 'Fiz uma corrida de 70 e o passageiro não me pagou')
  out.push(result('H7-nao-pagou-mesma-frase', unpaidSame, 'sem receita de R$ 70',
    !unpaidSame.actions.some(a => a.kind === 'income' && a.amount === 70)
      && /n[ãa]o.*pagou/i.test(unpaidSame.reply)))
  const mixedPix = await turn(buildState({ profile: 'driver' }), 'Paguei 30 no pneu e minha filha pediu um pix de 15')
  const mixedPixApplied = applyBatchPure(buildState({ profile: 'driver' }),
    mixedPix.actions.map((action, i) => ({ id: `mixed-pix-${i}`, action })), { source: 'ai' })
  out.push(result('H7-pix-misto', { answer: mixedPix, applied: mixedPixApplied.state.transactions },
    'pneu R$ 30 realizado; Pix R$ 15 pendente, nunca R$ 30',
    mixedPix.actions.some(a => a.kind === 'expense' && a.amount === 30)
      && !mixedPix.actions.some(a => 'amount' in a && a.amount === 15)
      && /Pix[^\n]*15/.test(mixedPix.reply)
      && mixedPixApplied.state.transactions.some(t => t.amount === 30)
      && !mixedPixApplied.state.transactions.some(t => t.amount === 15)))
  const noComma = await turn(buildState({ profile: 'driver' }), 'Gastei 40 no combustível quer dizer 45 e 30 no pneu')
  const noCommaApplied = applyBatchPure(buildState({ profile: 'driver' }),
    noComma.actions.map((action, i) => ({ id: `no-comma-${i}`, action })), { source: 'ai' })
  out.push(result('H9-correcao-sem-virgula', { answer: noComma, applied: noCommaApplied.state.transactions },
    'combustível R$ 45 e pneu R$ 30 aplicados, nenhum R$ 40',
    noComma.actions.some(a => a.kind === 'fuel' && a.amount === 45)
      && noComma.actions.some(a => a.kind === 'expense' && a.amount === 30 && a.category === 'manutencao')
      && noCommaApplied.state.transactions.some(t => t.amount === 45)
      && noCommaApplied.state.transactions.some(t => t.amount === 30)
      && !noCommaApplied.state.transactions.some(t => t.amount === 40)))
  const wholeNoComma = await turn(buildState({ profile: 'driver' }),
    'fiz 20 reais gastei 40 em combustievl furando o pneu foi mais 30 minha filha pediu um pix de 15 tocou uma corrida de 70 reais')
  const wholeNoCommaApplied = applyBatchPure(buildState({ profile: 'driver' }),
    wholeNoComma.actions.map((action, i) => ({ id: `whole-no-comma-${i}`, action })), { source: 'ai' })
  out.push(result('H9-relato-sem-virgulas', { answer: wholeNoComma, applied: wholeNoCommaApplied.state.transactions },
    'receita 20, combustível 40, pneu 30; Pix 15 e corrida 70 esclarecidos',
    wholeNoComma.actions.some(a => a.kind === 'income' && a.amount === 20)
      && wholeNoComma.actions.some(a => a.kind === 'expense' && a.amount === 40 && a.category === 'combustivel')
      && wholeNoComma.actions.some(a => a.kind === 'expense' && a.amount === 30 && a.category === 'manutencao')
      && /Pix[^\n]*15/.test(wholeNoComma.reply) && /corrida[^\n]*70/.test(wholeNoComma.reply)
      && !wholeNoComma.actions.some(a => 'amount' in a && (a.amount === 15 || a.amount === 70))
      && wholeNoCommaApplied.state.transactions.some(t => t.type === 'income' && t.amount === 20)
      && wholeNoCommaApplied.state.transactions.some(t => t.type === 'expense' && t.amount === 40)
      && wholeNoCommaApplied.state.transactions.some(t => t.type === 'expense' && t.amount === 30)))

  const pixFirst = await orchestrate({ state: buildState(), message: 'Minha filha pediu um Pix de 15', today: TODAY, remoteEnabled: false })
  const pixYes = await orchestrate({ state: buildState(), message: 'sim', today: TODAY, remoteEnabled: false,
    pendingClarification: pixFirst.response.mode === 'clarify' ? pixFirst.response.clarification : undefined })
  out.push(result('H7-pix-continuacao', pixYes.response, 'sim propõe despesa R$ 15 para confirmação',
    pixYes.response.mode === 'propose_actions'
      && pixYes.response.actions.length === 1
      && pixYes.response.actions[0].action.kind === 'expense'
      && pixYes.response.actions[0].action.amount === 15))
  const rideFirst = await orchestrate({ state: buildState({ profile: 'driver' }), message: 'Tocou uma corrida de 70', today: TODAY, remoteEnabled: false })
  const rideYes = await orchestrate({ state: buildState({ profile: 'driver' }), message: 'sim', today: TODAY, remoteEnabled: false,
    pendingClarification: rideFirst.response.mode === 'clarify' ? rideFirst.response.clarification : undefined })
  out.push(result('H7-corrida-continuacao', rideYes.response, 'sim propõe receita R$ 70 para confirmação',
    rideYes.response.mode === 'propose_actions'
      && rideYes.response.actions.some(a => a.action.kind === 'income' && a.action.amount === 70)))
  const refundFirst = await orchestrate({ state: buildState(), message: 'Recebi 70, mas devolvi 20', today: TODAY, remoteEnabled: false })
  const refundYes = await orchestrate({ state: buildState(), message: 'sim', today: TODAY, remoteEnabled: false,
    pending: refundFirst.response.actions,
    pendingClarification: refundFirst.response.mode === 'clarify' ? refundFirst.response.clarification : undefined })
  out.push(result('H9-devolucao-continuacao', refundYes.response, 'sim mantém receita R$ 70 e propõe saída R$ 20',
    refundYes.response.mode === 'propose_actions'
      && refundYes.response.actions.some(a => a.action.kind === 'income' && a.action.amount === 70)
      && refundYes.response.actions.some(a => a.action.kind === 'expense' && a.action.amount === 20)))
  const invalidChoice = await orchestrate({ state: buildState(), message: 'sim', today: TODAY, remoteEnabled: false,
    pendingClarification: { question: 'Registrar?', field: 'financial-event',
      options: [{ label: 'Sim', value: 'sim', actions: [{ kind: 'expense', amount: -10, category: 'alimentacao' }] }] } })
  out.push(result('H7-opcao-validada', invalidChoice.response, 'ação inválida de opção não vira proposta',
    invalidChoice.response.actions.length === 0 && invalidChoice.response.mode === 'answer'))
  const cardWithQuestion = buildState()
  cardWithQuestion.chat = [{ id: 'm', role: 'assistant', text: 'Recebi 70, mas devolvi 20', time: '10:00',
    proposal: [{ id: 'income-70', action: { kind: 'income', amount: 70, category: 'outros-in' },
      engine: 'local', confidence: 'high' }],
    clarification: { question: 'Devolveu 20?', options: [{ label: 'Sim', value: 'sim' }] } }]
  const clearedQuestion = reducer(cardWithQuestion, { type: 'chatClearClarification', id: 'm' })
  out.push(result('H9-proposta-sobrevive-esclarecimento', clearedQuestion.chat[0],
    'limpar escolha não apaga receita ainda confirmável',
    !clearedQuestion.chat[0].clarification && clearedQuestion.chat[0].proposal?.[0]?.action.kind === 'income'
      && clearedQuestion.chat[0].proposal?.[0]?.action.amount === 70))

  // A sonda exploratória encontrou respostas com números plausíveis, mas
  // período, métrica ou sentido da comparação errados. Oráculos literais.
  const q = buildState()
  q.transactions = [
    { id: 'q-jun', type: 'expense', amount: 10, category: 'casa', date: '2026-06-05', time: '10:00' },
    { id: 'q-jul', type: 'expense', amount: 30, category: 'casa', date: '2026-07-05', time: '10:00' },
    { id: 'q-ago', type: 'expense', amount: 500, category: 'casa', date: '2026-08-05', time: '10:00' },
    { id: 'q-set', type: 'expense', amount: 100, category: 'casa', date: '2026-09-05', time: '10:00' },
  ]
  const qAverage = await turn(q, 'quanto eu gasto em media por lançamento')
  out.push(result('Q-media-lancamento', qAverage, 'média dos últimos 90 dias = R$ 210, sem filtro de texto',
    qAverage.focus?.lastQuery?.total === 210 && !qAverage.focus?.lastQueryPlan?.filter.text
      && /210,00/.test(qAverage.reply)))
  const qMax = await turn(q, 'qual foi meu maior gasto do ano')
  out.push(result('Q-maior-do-ano', qMax, 'maior gasto de 2026 = R$ 500 em agosto',
    qMax.focus?.lastQueryPlan?.period.from === '2026-01-01'
      && qMax.focus?.lastQuery?.total === 500 && /500,00/.test(qMax.reply)))
  const qCompare = await turn(q, 'compara julho com junho')
  out.push(result('Q-dois-meses', qCompare, 'julho R$ 30 contra junho R$ 10, diferença de R$ 20',
    qCompare.focus?.lastQueryPlan?.period.from === '2026-07-01'
      && qCompare.focus?.lastQueryPlan?.comparePeriod?.from === '2026-06-01'
      && qCompare.focus?.lastQuery?.total === 30
      && /30,00/.test(qCompare.reply) && /10,00/.test(qCompare.reply) && /20,00/.test(qCompare.reply)))
  const qJuly = await turn(q, 'quanto gastei em julho')
  const qCompareWithFocus = await turn(q, 'compara julho com junho', qJuly.focus)
  out.push(result('Q-dois-meses-com-foco', qCompareWithFocus, 'meses explícitos vencem foco anterior',
    qCompareWithFocus.focus?.lastQueryPlan?.period.from === '2026-07-01'
      && qCompareWithFocus.focus?.lastQueryPlan?.comparePeriod?.from === '2026-06-01'
      && /30,00/.test(qCompareWithFocus.reply) && /10,00/.test(qCompareWithFocus.reply)))
  const qThis = await turn(q, 'quanto gastei este mês')
  const qLast = await turn(q, 'e mês passado?', qThis.focus)
  const qWorse = await turn(q, 'qual foi pior', qLast.focus)
  out.push(result('Q-pior-mes', qWorse, 'agosto R$ 500 foi pior que setembro R$ 100 em gastos',
    /agosto(?: de \d{4})? foi pior[^\n]*R\$\s*500,00[^\n]*R\$\s*100,00[^\n]*setembro/i
      .test(qWorse.reply.replace(/\u00a0/g, ' '))
      && !/500,00[^\n]*a menos/i.test(qWorse.reply)))
  const cardContext = buildState({ cards: [{ name: 'Nubank' }] })
  const oldScenario = await orchestrate({ state: cardContext, message: 'Se eu comprar algo de 100 em 10x',
    today: TODAY, remoteEnabled: false })
  const tvPending = await orchestrate({ state: cardContext, message: 'Comprei uma TV de 2500 em 6x no Nubank',
    today: TODAY, remoteEnabled: false, focus: oldScenario.focus })
  const otherPurchase = await orchestrate({ state: cardContext, message: 'E uma geladeira',
    today: TODAY, remoteEnabled: false, focus: oldScenario.focus, pending: tvPending.response.actions })
  out.push(result('Q-compra-eliptica', otherPurchase.response, 'pedir detalhes da geladeira; preservar TV pendente',
    tvPending.response.mode === 'propose_actions'
      && tvPending.response.actions.some(a => a.action.kind === 'card-purchase')
      && otherPurchase.keepPending === true && otherPurchase.response.actions.length === 0
      && /geladeira/i.test(otherPurchase.response.reply) && /TV/i.test(otherPurchase.response.reply)
      && !/simula[çc][ãa]o/i.test(otherPurchase.response.reply)))
  const patternState = autonomoRico(TODAY)
  patternState.transactions = Array.from({ length: 6 }, (_, i) => ({
    id: `p-${i}`, type: 'expense' as const, amount: 100, category: 'combustivel',
    description: 'Posto X', date: `2026-09-${String(i + 1).padStart(2, '0')}`, time: '10:00',
  }))
  const warned = await orchestrate({ state: patternState, message: 'Gastei 500 no Posto X', today: TODAY, remoteEnabled: false })
  const acknowledged = await orchestrate({ state: patternState, message: 'está correto', today: TODAY,
    remoteEnabled: false, pending: warned.response.actions })
  out.push(result('M5-aviso-reconhecido', { warned: warned.response, acknowledged: acknowledged.response },
    'reconhecer alerta preserva proposta e orienta confirmar, sem repetir aviso',
    warned.response.mode === 'propose_actions'
      && warned.response.actions.some(a => !!a.patternWarning)
      && acknowledged.keepPending === true && acknowledged.response.actions.length === 0
      && /confirmar/i.test(acknowledged.response.reply)
      && !/acima do seu padr[ãa]o|zero a mais/i.test(acknowledged.response.reply)))

  // Auditoria independente: checar o conjunto EXATO aplicado, não apenas a
  // presença da ação correta (o que deixava passar despesas extras).
  for (const [id, phrase, expected] of [
    ['A-negacao-gasto', 'Recebi 100 mas não gastei 40 no mercado', 'income:100'],
    ['A-negacao-corrida', 'Paguei 30 no pneu mas não fiz uma corrida de 70', 'expense:30'],
  ] as const) {
    const state = buildState({ profile: 'autonomo' })
    const answer = await turn(state, phrase)
    const applied = applyBatchPure(state, answer.actions.map((action, i) => ({ id: `${id}-${i}`, action })),
      { now: { date: TODAY, time: '14:00' } })
    const actual = applied.state.transactions.map(t => `${t.type}:${t.amount}`).sort().join(',')
    out.push(result(id, { answer, transactions: applied.state.transactions, work: applied.state.workSessions },
      `somente ${expected}, sem trabalho inventado`,
      applied.applied && actual === expected && applied.state.workSessions.length === 0))
  }
  for (const phrase of ['quando eu falar planejo é faturei', 'quando eu falar se é já',
    'quando eu falar sonho é vendi']) {
    const answer = await turn(baseline(), phrase)
    out.push(result(`A-alias-${phrase.includes('planejo') ? 'plano' : phrase.includes('sonho') ? 'verbo' : 'hipotese'}`, answer,
      'alias que troca modalidade recusado', !answer.preferenceMutation))
  }
  const pixClarify = (await orchestrate({ state: buildState(), message: 'Minha filha pediu um Pix de 15',
    today: TODAY, remoteEnabled: false })).response
  for (const [id, answerText] of [
    ['A-pix-assim', 'não, assim que receber eu mando'],
    ['A-pix-valor', 'sim mas mandei só 10'],
    ['A-pix-data', 'sim, ontem'],
  ] as const) {
    const answer = await orchestrate({ state: buildState(), message: answerText, today: TODAY,
      remoteEnabled: false,
      pendingClarification: pixClarify.mode === 'clarify' ? pixClarify.clarification : undefined })
    out.push(result(id, answer.response, 'não propor Pix antigo de R$ 15 hoje',
      answer.response.actions.length === 0))
  }
  const directMixed = buildState({ balance: 1000, cards: [{ name: 'Inter', dueDay: 20, closingDay: 5 }] })
  directMixed.settings.balanceAsOf = '2026-09-14T09:00'
  directMixed.installmentPlans = [{ id: 'mixed-plan', description: 'Compra', cardId: 'card0',
    totalAmount: 300, installmentCount: 2, firstDueDate: '2026-09-20', purchaseDate: '2026-09-01',
    status: 'active', operationType: 'card-purchase', createdAt: '2026-09-01' }]
  directMixed.installments = [200, 100].map((amount, index) => ({ id: `mixed-${index}`, planId: 'mixed-plan',
    number: index + 1, total: 2, amount, dueDate: '2026-09-20', status: 'pending' as const }))
  const directFirst = reducer(directMixed, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '10:00' })
  const invoiceRest = applyBatchPure(directFirst,
    [{ id: 'pay-rest', action: { kind: 'card-payment', cardName: 'Inter' } }],
    { now: { date: TODAY, time: '14:00' } })
  out.push(result('A-direto-depois-fatura', {
    balance: currentBalance(invoiceRest.state), invoice: cardInvoice(invoiceRest.state, directMixed.cards[0], '2026-09'),
    installments: invoiceRest.state.installments,
  }, 'saldo 700, fatura zero e parcelas pagas', invoiceRest.applied
    && currentBalance(invoiceRest.state) === 700
    && cardInvoice(invoiceRest.state, directMixed.cards[0], '2026-09').pending === 0
    && invoiceRest.state.installments.every(i => i.status === 'paid')))
  const undoDirectAfterInvoice = reducer(invoiceRest.state, { type: 'unpayInstallment', id: 'mixed-0' })
  out.push(result('D-desfazer-direto-apos-fatura-de-outra-parcela', {
    payment: invoiceRest.state.cardPayments[0], balance: currentBalance(undoDirectAfterInvoice),
    pending: cardInvoice(undoDirectAfterInvoice, directMixed.cards[0], '2026-09').pending,
  }, 'fatura vincula só mixed-1; desfazer mixed-0 deixa saldo 900 e dívida 200',
    invoiceRest.state.cardPayments[0]?.settledInstallmentIds?.join(',') === 'mixed-1'
      && currentBalance(undoDirectAfterInvoice) === 900
      && cardInvoice(undoDirectAfterInvoice, directMixed.cards[0], '2026-09').pending === 200
      && undoDirectAfterInvoice.installments[0].status === 'pending'))
  const partialState = reducer(directMixed, { type: 'partialPayInstallment', id: 'mixed-0',
    amount: 100, paidAt: TODAY, paidTime: '14:00' })
  out.push(result('A-parcial-caixa', {
    balance: currentBalance(partialState), invoice: cardInvoice(partialState, directMixed.cards[0], '2026-09'),
  }, 'pagamento parcial R$ 100 reduz saldo e pendência em R$ 100',
    currentBalance(partialState) === 900
      && cardInvoice(partialState, directMixed.cards[0], '2026-09').pending === 200))
  const sameDay = { ...directMixed, settings: { ...directMixed.settings, balanceAsOf: `${TODAY}T09:00` } }
  const sameDayInvoice = applyBatchPure(sameDay,
    [{ id: 'same-day-invoice', action: { kind: 'card-payment', cardName: 'Inter', amount: 300 } }],
    { now: { date: TODAY, time: '14:00' } })
  const sameDayDirect = reducer(sameDay, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '14:00' })
  out.push(result('A-ancora-mesmo-dia', {
    invoiceBalance: currentBalance(sameDayInvoice.state), directBalance: currentBalance(sameDayDirect),
  }, 'pagamentos posteriores à âncora reduzem saldo',
    currentBalance(sameDayInvoice.state) === 700 && currentBalance(sameDayDirect) === 800))
  const uiMixed = reducer(directFirst, { type: 'addCardPayment',
    payment: { id: 'ui-pay', cardId: 'card0', amount: 100, paymentDate: TODAY,
      paymentTime: '14:00', referenceMonth: '2026-09', fromBalance: true },
    settleInstallmentIds: ['mixed-0', 'mixed-1'] })
  out.push(result('A-fatura-pela-interface-apos-direto', {
    balance: currentBalance(uiMixed), invoice: cardInvoice(uiMixed, directMixed.cards[0], '2026-09'),
    installments: uiMixed.installments,
  }, 'reducer da interface preserva pagamento direto e quita restante',
    currentBalance(uiMixed) === 700
      && cardInvoice(uiMixed, directMixed.cards[0], '2026-09').pending === 0
      && uiMixed.installments[0].paidVia === 'direct'))
  const partialThenInvoice = reducer(partialState, { type: 'addCardPayment',
    payment: { id: 'ui-partial-rest', cardId: 'card0', amount: 200, paymentDate: TODAY,
      paymentTime: '15:00', referenceMonth: '2026-09', fromBalance: true },
    settleInstallmentIds: ['mixed-0', 'mixed-1'] })
  out.push(result('A-fatura-apos-parcial-direto', {
    balance: currentBalance(partialThenInvoice), invoice: cardInvoice(partialThenInvoice, directMixed.cards[0], '2026-09'),
  }, 'parcial direto 100 + fatura 200 quitam 300 sem desconto duplo',
    currentBalance(partialThenInvoice) === 700
      && cardInvoice(partialThenInvoice, directMixed.cards[0], '2026-09').pending === 0))
  const removedMixedInvoice = reducer(partialThenInvoice, { type: 'removeCardPayment', id: 'ui-partial-rest' })
  out.push(result('C-remover-fatura-reabre-parcelas', {
    balance: currentBalance(removedMixedInvoice),
    pending: cardInvoice(removedMixedInvoice, directMixed.cards[0], '2026-09').pending,
    installments: removedMixedInvoice.installments,
  }, 'sem a fatura, parcial direto R$ 100 permanece e R$ 200 voltam a ficar pendentes',
    currentBalance(removedMixedInvoice) === 900
      && cardInvoice(removedMixedInvoice, directMixed.cards[0], '2026-09').pending === 200
      && removedMixedInvoice.installments.every(i => i.status === 'pending')
      && removedMixedInvoice.installments[0].paidAmount === 100))
  const partialInvoiceFirst = reducer(directMixed, { type: 'addCardPayment',
    payment: { id: 'early-30', cardId: 'card0', amount: 30, paymentDate: TODAY,
      paymentTime: '10:00', referenceMonth: '2026-09', fromBalance: true },
    settleInstallmentIds: [] })
  const partialInvoiceRest = applyBatchPure(partialInvoiceFirst,
    [{ id: 'later-270', action: { kind: 'card-payment', cardName: 'Inter' } }],
    { now: { date: TODAY, time: '14:00' } })
  const unsafeRemoval = reducer(partialInvoiceRest.state, { type: 'removeCardPayment', id: 'early-30' })
  out.push(result('D-remover-parcial-antes-quitacao-exige-reconciliacao', {
    applied: partialInvoiceRest.applied, unchanged: unsafeRemoval === partialInvoiceRest.state,
    payments: unsafeRemoval.cardPayments, installments: unsafeRemoval.installments,
  }, 'sem distribuição por parcela, recusar remoção que deixaria quitadas com fatura pendente',
    partialInvoiceRest.applied && unsafeRemoval === partialInvoiceRest.state))
  const longReport = await turn(buildState({ profile: 'driver' }),
    'fiz 20 reais mas gastei 40 em combustievl acabando furando o pneu foi mais 30 e depois disso minha filha pediu um pix de 15 reais para sorvete tocou uma corrida de 70 reais bla bla bla bla')
  const longState = buildState({ profile: 'driver' })
  longState.settings.balanceAsOf = '2026-09-14T09:00'
  const longApplied = applyBatchPure(longState,
    longReport.actions.map((action, i) => ({ id: `long-${i}`, action })),
    { now: { date: TODAY, time: '14:00' } })
  out.push(result('A-relato-original', { answer: longReport, transactions: longApplied.state.transactions },
    'saldo -50: receita 20, gastos 40+30, Pix e corrida pendentes',
    longApplied.applied && currentBalance(longApplied.state) === -50
      && JSON.stringify(longApplied.state.transactions.map(t => `${t.type}:${t.amount}`).sort())
        === JSON.stringify(['expense:30', 'expense:40', 'income:20'])
      && !longReport.actions.some(a => 'amount' in a && (a.amount === 15 || a.amount === 70))))
  const unpaidRide = await turn(buildState({ profile: 'driver' }), 'Fiz uma corrida de 70 mas não recebi ainda')
  out.push(result('A-corrida-sem-receber', unpaidRide, 'viagem sem receita de R$ 70',
    !unpaidRide.actions.some(a => a.kind === 'income')))
  const endedCharge = baseline()
  endedCharge.cards = [{ ...directMixed.cards[0] }]
  endedCharge.cardCharges = [{ id: 'ended', cardId: 'card0', description: 'Assinatura', amount: 200,
    frequency: 'monthly', nextDate: '2026-09-20', endDate: '2026-10-01', active: true,
    createdAt: '2026-09-01' }]
  const endedScenario = await scenario(endedCharge, 'Se eu guardar tudo que sobrar até dezembro')
  out.push(result('A-assinatura-encerrada', endedScenario, 'reservas [800,1000,1000,1000]',
    JSON.stringify(endedScenario.months?.map(m => m.saved)) === '[800,1000,1000,1000]'
      && endedScenario.months?.[3]?.accumulated === 3800))
  const categoryFocus = buildState()
  categoryFocus.transactions = [
    { id: 'food-jun', type: 'expense', amount: 10, category: 'alimentacao', date: '2026-06-05', time: '10:00' },
    { id: 'food-jul', type: 'expense', amount: 80, category: 'alimentacao', date: '2026-07-05', time: '10:00' },
    { id: 'home-jun', type: 'expense', amount: 1000, category: 'casa', date: '2026-06-05', time: '10:00' },
    { id: 'home-jul', type: 'expense', amount: 2000, category: 'casa', date: '2026-07-05', time: '10:00' },
  ]
  const foodJuly = await turn(categoryFocus, 'quanto gastei com alimentação em julho')
  const foodCompare = await turn(categoryFocus, 'compara julho com junho', foodJuly.focus)
  out.push(result('A-comparacao-categoria', foodCompare, 'alimentação 80 contra 10, diferença 70',
    foodCompare.focus?.lastQueryPlan?.filter.categories?.includes('alimentacao') === true
      && foodCompare.focus?.lastQuery?.total === 80
      && /80,00/.test(foodCompare.reply) && /10,00/.test(foodCompare.reply)
      && /70,00\s+acima/i.test(foodCompare.reply.replace(/\u00a0/g, ' '))))
  const incomeCompareState = buildState({ transactions: [
    { id: 'rent-aug', type: 'income', amount: 1800, category: 'aluguel', origin: 'Casa 1', date: '2026-08-05' },
    { id: 'rent-jul', type: 'income', amount: 1200, category: 'aluguel', origin: 'Casa 1', date: '2026-07-05' },
    { id: 'home-aug', type: 'expense', amount: 300, category: 'casa', origin: 'Casa 1', date: '2026-08-10' },
  ] })
  const rentAugust = await turn(incomeCompareState, 'quanto a Casa 1 me rendeu em agosto')
  const rentCompare = await turn(incomeCompareState, 'compara agosto com julho', rentAugust.focus)
  out.push(result('C-comparacao-receita-nao-vira-despesa', rentCompare,
    'receita de R$ 1800 contra R$ 1200, diferença R$ 600',
    rentCompare.focus?.lastQueryPlan?.filter.txType?.[0] === 'income'
      && rentCompare.focus?.lastQuery?.total === 1800
      && /1\.800,00/.test(rentCompare.reply) && /1\.200,00/.test(rentCompare.reply)
      && /600,00\s+acima/i.test(rentCompare.reply.replace(/\u00a0/g, ' '))))
  for (const [id, phrase] of [
    ['em-geral', 'compara julho com junho em geral'],
    ['de-tudo', 'compara julho com junho de tudo'],
  ] as const) {
    const comparison = await turn(categoryFocus, phrase, foodJuly.focus)
    out.push(result(`C-comparacao-${id}`, comparison, 'todas as categorias: 2080 contra 1010',
      !comparison.focus?.lastQueryPlan?.filter.categories?.length
        && !comparison.focus?.lastQueryPlan?.filter.text
        && comparison.focus?.lastQuery?.total === 2080
        && /2\.080,00/.test(comparison.reply) && /1\.010,00/.test(comparison.reply)))
  }
  const houseState = buildState({ transactions: [
    { id: 'house-1', type: 'income', amount: 1800, category: 'aluguel', origin: 'Casa 1', date: '2026-09-05' },
    { id: 'house-2', type: 'income', amount: 1200, category: 'aluguel', origin: 'Casa 2', date: '2026-09-07' },
  ] })
  const houseOne = await turn(houseState, 'quanto a Casa 1 me rendeu este mês')
  const houseTwo = await turn(houseState, 'e a Casa 2', houseOne.focus)
  out.push(result('A-foco-origem-rotulo', houseTwo, 'Casa 2 R$ 1.200, sem rotular Casa 1',
    houseTwo.focus?.lastQuery?.total === 1200 && /Casa 2/.test(houseTwo.reply)
      && !/Casa 1/.test(houseTwo.reply)))
  const wordsScenario = await scenario(baseline(),
    'Se eu guardar metade da sobra até dezembro e ajudar minha filha com duzentos reais por mês')
  out.push(result('A-cenario-extenso-nao-suportado', wordsScenario,
    'ajuda de duzentos reais explicitamente excluída ou esclarecida',
    /n[ãa]o inclu[íi][^\n]*ajudar minha filha/i.test(wordsScenario.reply)))
  const splitAnchor = { ...directMixed, settings: { ...directMixed.settings, balanceAsOf: `${TODAY}T12:00` } }
  const partialBefore = reducer(splitAnchor, { type: 'partialPayInstallment', id: 'mixed-0',
    amount: 50, paidAt: TODAY, paidTime: '10:00' })
  const partialAfter = reducer(partialBefore, { type: 'partialPayInstallment', id: 'mixed-0',
    amount: 50, paidAt: TODAY, paidTime: '14:00' })
  out.push(result('A-parciais-dos-dois-lados-da-ancora', {
    balance: currentBalance(partialAfter), invoice: cardInvoice(partialAfter, directMixed.cards[0], '2026-09'),
  }, 'saldo desconta só R$ 50 depois da âncora; fatura desconta os R$ 100 pagos',
    currentBalance(partialAfter) === 950
      && cardInvoice(partialAfter, directMixed.cards[0], '2026-09').pending === 200))
  const pastPattern = buildState()
  pastPattern.transactions = Array.from({ length: 6 }, (_, i) => ({
    id: `future-sample-${i}`, type: 'expense', amount: 100, category: 'combustivel',
    description: 'Posto X', date: `2026-09-${String(i + 2).padStart(2, '0')}`, time: '10:00',
  }))
  const retroactive = await orchestrate({ state: pastPattern, message: 'Gastei 500 no Posto X em 01/08/2026',
    today: TODAY, remoteEnabled: false })
  out.push(result('A-aviso-sem-evidencia-futura', retroactive.response,
    'lançamento em agosto não recebe aviso baseado somente em gastos de setembro',
    retroactive.response.mode === 'answer'
      || retroactive.response.actions.every(a => !a.patternWarning)))
  const sameMinute = { ...directMixed, settings: { ...directMixed.settings,
    balanceAsOf: '2026-09-01T00:00' }, installments: [directMixed.installments[0]] }
  const actualStamp = nowStamp()
  out.push(result('B-carimbo-ancora-tem-milissegundos', actualStamp,
    'âncora com precisão de milissegundos', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(actualStamp)))
  const actualPaymentTime = nowPaymentTime()
  out.push(result('C-carimbo-lancamento-tem-milissegundos', actualPaymentTime,
    'lançamento financeiro com a mesma precisão da âncora',
    /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(actualPaymentTime)))
  const earlyInvoice = applyBatchPure(sameMinute,
    [{ id: 'early-invoice', action: { kind: 'card-payment', cardName: 'Inter', amount: 200 } }],
    { now: { date: TODAY, time: '09:00:10' } })
  const laterAnchor = applyBatchPure(earlyInvoice.state,
    [{ id: 'later-anchor', action: { kind: 'balance', amount: 800 } }],
    { now: { date: TODAY, time: '09:00:50' } })
  const earlyDirect = reducer(sameMinute, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '09:00:10' })
  const laterDirectAnchor = applyBatchPure(earlyDirect,
    [{ id: 'later-direct-anchor', action: { kind: 'balance', amount: 800 } }],
    { now: { date: TODAY, time: '09:00:50' } })
  out.push(result('B-ancora-mesmo-minuto', {
    invoice: currentBalance(laterAnchor.state), direct: currentBalance(laterDirectAnchor.state),
  }, 'pagamento às 09:00:10 já incluído na âncora das 09:00:50',
    laterAnchor.applied && laterDirectAnchor.applied
      && currentBalance(laterAnchor.state) === 800 && currentBalance(laterDirectAnchor.state) === 800))
  const anchorThenExpense = applyBatchPure(buildState({ balance: 0 }), [
    { id: 'anchor-first', action: { kind: 'balance', amount: 800 } },
    { id: 'expense-second', action: { kind: 'expense', amount: 50, description: 'Mercado' } },
  ], { now: { date: TODAY, time: '09:00:50' } })
  const expenseThenAnchor = applyBatchPure(buildState({ balance: 0 }), [
    { id: 'expense-first', action: { kind: 'expense', amount: 50, description: 'Mercado' } },
    { id: 'anchor-second', action: { kind: 'balance', amount: 800 } },
  ], { now: { date: TODAY, time: '09:00:50' } })
  out.push(result('C-ordem-do-lote-na-mesma-hora', {
    first: currentBalance(anchorThenExpense.state), second: currentBalance(expenseThenAnchor.state),
  }, 'saldo antes do gasto = 750; saldo depois do gasto = 800',
    anchorThenExpense.applied && expenseThenAnchor.applied
      && currentBalance(anchorThenExpense.state) === 750
      && currentBalance(expenseThenAnchor.state) === 800))
  const exactTime = '09:00:10.100'
  const anchorOne = applyBatchPure(buildState({ balance: 0 }),
    [{ id: 'same-ms-anchor', action: { kind: 'balance', amount: 800 } }],
    { now: { date: TODAY, time: exactTime } })
  const expenseLater = applyBatchPure(anchorOne.state,
    [{ id: 'same-ms-expense', action: { kind: 'expense', amount: 100, description: 'Mercado' } }],
    { now: { date: TODAY, time: exactTime } })
  const manualExpenseLater = reducer(anchorOne.state, { type: 'addTx', tx: {
    id: 'manual-same-ms', type: 'expense', amount: 100, category: 'casa', date: TODAY,
    time: exactTime, source: 'manual',
  } })
  out.push(result('D-eventos-separados-mesmo-milissegundo', {
    batch: currentBalance(expenseLater.state), manual: currentBalance(manualExpenseLater),
  }, 'despesa posterior à âncora descontada em ambos os fluxos',
    anchorOne.applied && expenseLater.applied
      && currentBalance(expenseLater.state) === 700
      && currentBalance(manualExpenseLater) === 700))
  const cardAnchor = applyBatchPure(directMixed,
    [{ id: 'card-same-ms-anchor', action: { kind: 'balance', amount: 800 } }],
    { now: { date: TODAY, time: exactTime } })
  const cardPaymentLater = applyBatchPure(cardAnchor.state,
    [{ id: 'card-same-ms-pay', action: { kind: 'card-payment', cardName: 'Inter', amount: 200 } }],
    { now: { date: TODAY, time: exactTime } })
  const directPaymentLater = reducer(cardAnchor.state, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: exactTime })
  out.push(result('D-pagamentos-mesmo-milissegundo', {
    invoice: currentBalance(cardPaymentLater.state), direct: currentBalance(directPaymentLater),
  }, 'pagamento posterior à âncora descontado, por fatura ou direto',
    cardAnchor.applied && cardPaymentLater.applied
      && currentBalance(cardPaymentLater.state) === 600
      && currentBalance(directPaymentLater) === 600))
  const legacyKnown = { ...sameMinute, installments: [{ ...sameMinute.installments[0],
    status: 'pending' as const, paidAmount: 100, paidAt: '2026-09-10', paidVia: 'direct' as const }] }
  const legacyCompleted = reducer(legacyKnown, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '14:00' })
  const legacyMore = reducer(legacyKnown, { type: 'partialPayInstallment', id: 'mixed-0',
    amount: 50, paidAt: TODAY, paidTime: '14:00' })
  out.push(result('B-legado-com-data-mais-pagamento', {
    before: currentBalance(legacyKnown), completed: currentBalance(legacyCompleted),
    partial: currentBalance(legacyMore), events: legacyMore.installments[0].directPayments,
  }, 'R$ 900 antes, R$ 800 ao completar, R$ 850 no novo parcial',
    currentBalance(legacyKnown) === 900 && currentBalance(legacyCompleted) === 800
      && currentBalance(legacyMore) === 850
      && legacyMore.installments[0].directPayments?.length === 2))
  const legacyUndated = { ...sameMinute, settings: { ...sameMinute.settings,
    balance: 900, balanceAsOf: `${TODAY}T09:00` },
    installments: [{ ...sameMinute.installments[0], status: 'pending' as const, paidAmount: 100 }] }
  const undatedCompleted = reducer(legacyUndated, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '14:00' })
  out.push(result('B-legado-sem-data-nao-inventa-novo-pagamento', {
    balance: currentBalance(undatedCompleted), events: undatedCompleted.installments[0].directPayments,
  }, 'só os R$ 100 restantes são pagamento novo',
    currentBalance(undatedCompleted) === 800
      && undatedCompleted.installments[0].directPayments?.[0]?.amount === 100))
  const legacyInvoice = { ...directMixed, settings: { ...directMixed.settings,
    balanceAsOf: '2026-09-01T00:00' },
    installments: [{ ...directMixed.installments[0], status: 'paid' as const,
      paidAmount: 200, paidAt: '2026-09-10' }, directMixed.installments[1]] }
  const legacyInvoiceRest = applyBatchPure(legacyInvoice,
    [{ id: 'legacy-invoice-rest', action: { kind: 'card-payment', cardName: 'Inter' } }],
    { now: { date: TODAY, time: '14:00' } })
  out.push(result('B-legado-direto-depois-fatura', {
    balance: currentBalance(legacyInvoiceRest.state),
    pending: cardInvoice(legacyInvoiceRest.state, legacyInvoice.cards[0], '2026-09').pending,
  }, 'saldo R$ 700 e fatura zero', legacyInvoiceRest.applied
    && currentBalance(legacyInvoiceRest.state) === 700
    && cardInvoice(legacyInvoiceRest.state, legacyInvoice.cards[0], '2026-09').pending === 0))
  const conflictingLegacy = { ...legacyInvoice, installments: [{ ...legacyInvoice.installments[0],
    paidAt: '2026-09-12' }, legacyInvoice.installments[1]],
    cardPayments: [{ id: 'old-invoice', cardId: 'card0', amount: 200,
      paymentDate: '2026-09-13', referenceMonth: '2026-09', fromBalance: true }] }
  const refusedConflict = applyBatchPure(conflictingLegacy,
    [{ id: 'conflicting-payment', action: { kind: 'card-payment', cardName: 'Inter', amount: 100 } }],
    { now: { date: TODAY, time: '14:00' } })
  out.push(result('C-fatura-legada-conflitante-nao-amplia-erro', {
    paid: cardInvoice(conflictingLegacy, conflictingLegacy.cards[0], '2026-09').paid,
    applied: refusedConflict.applied, results: refusedConflict.results,
  }, 'recusar novo pagamento enquanto o histórico da fatura é inconsistente',
    cardInvoice(conflictingLegacy, conflictingLegacy.cards[0], '2026-09').paid > 300
      && !refusedConflict.applied
      && refusedConflict.results[0]?.ok === false
      && refusedConflict.state === conflictingLegacy))
  const ambiguousBalance = await turn(conflictingLegacy, 'qual meu saldo?')
  out.push(result('D-saldo-legado-ambiguo-nao-afirma-numero', ambiguousBalance,
    'pedir reconciliação sem afirmar saldo R$ 600',
    /conferir|reconcilia|confirmar/i.test(ambiguousBalance.reply)
      && !/R\$\s*600(?:,00)?\b/i.test(ambiguousBalance.reply)))
  for (const [id, phrase] of [
    ['gasto-hoje', 'quanto posso gastar hoje?'],
    ['cenario-gasto', 'se eu gastar 100 hoje quanto sobra?'],
    ['cobertura-contas', 'meu salário cobre minhas contas?'],
    ['resumo-mes', 'como está meu mês?'],
  ] as const) {
    const answer = await turn(conflictingLegacy, phrase)
    out.push(result(`E-saldo-legado-${id}`, answer,
      'reconciliação exigida antes de usar saldo ambíguo',
      /conferir|reconcilia|confirmar/i.test(answer.reply)
        && !/R\$\s*(?:600|500|420|400)(?:,00)?\b/i.test(answer.reply)
        && answer.actions.length === 0))
  }
  const legacyMarkedPaidPartial = { ...legacyKnown, installments: [{ ...legacyKnown.installments[0],
    status: 'paid' as const }] }
  const legacyMarkedCompleted = reducer(legacyMarkedPaidPartial, { type: 'payInstallment',
    id: 'mixed-0', paidAt: TODAY, paidTime: '14:00' })
  out.push(result('C-legado-marcado-pago-mas-parcial', {
    before: currentBalance(legacyMarkedPaidPartial), after: currentBalance(legacyMarkedCompleted),
    events: legacyMarkedCompleted.installments[0].directPayments,
  }, 'completar apenas R$ 100 restantes sem perder o histórico de R$ 100',
    currentBalance(legacyMarkedPaidPartial) === 900
      && currentBalance(legacyMarkedCompleted) === 800
      && legacyMarkedCompleted.installments[0].directPayments?.length === 2))
  const mixedUndo = reducer(partialThenInvoice, { type: 'unpayInstallment', id: 'mixed-0' })
  out.push(result('B-desfazer-parcela-com-fatura-bloqueado', {
    balance: currentBalance(mixedUndo), pending: cardInvoice(mixedUndo, directMixed.cards[0], '2026-09').pending,
  }, 'não reabrir só a parcela enquanto a fatura paga continua no estado',
    currentBalance(mixedUndo) === 700
      && cardInvoice(mixedUndo, directMixed.cards[0], '2026-09').pending === 0
      && mixedUndo.installments[0].status === 'paid'))
  const unrelatedPartial = reducer(directMixed, { type: 'addCardPayment',
    payment: { id: 'prior-partial', cardId: 'card0', amount: 30, paymentDate: '2026-09-14',
      paymentTime: '14:00', referenceMonth: '2026-09', fromBalance: true },
    settleInstallmentIds: [] })
  const cardDebt = await turn(unrelatedPartial, 'quanto falta pagar do Inter?')
  out.push(result('E-cartao-parcial-divida', {
    cardDebt, invoice: cardInvoice(unrelatedPartial, unrelatedPartial.cards[0], '2026-09'),
  }, 'fatura e dívida do cartão R$ 270 após pagamento parcial de R$ 30',
    cardInvoice(unrelatedPartial, unrelatedPartial.cards[0], '2026-09').pending === 270
      && cardOutstanding(unrelatedPartial, 'card0') === 270
      && cardsOverview(unrelatedPartial).totalDebt === 270
      && /270,00/.test(cardDebt.reply) && !/300,00/.test(cardDebt.reply)
      && cardDebt.actions.length === 0))
  const proposedPartial = await turn(directMixed, 'paguei 30 da fatura do Inter')
  const appliedPartial = applyBatchPure(directMixed, proposedPartial.actions.map((action, i) =>
    ({ id: `audit-partial-${i}`, action })), { now: { date: TODAY, time: '14:00' } })
  const debtFromRealFlow = await turn(appliedPartial.state, 'quanto falta pagar do Inter?')
  out.push(result('E-cartao-parcial-fluxo-real', { proposedPartial, appliedPartial, debtFromRealFlow },
    'proposta confirmada, saldo 970, fatura e dívida 270, sem despesa extra',
    proposedPartial.actions.length === 1 && proposedPartial.actions[0].kind === 'card-payment'
      && proposedPartial.actions[0].amount === 30 && appliedPartial.applied
      && appliedPartial.state.transactions.length === directMixed.transactions.length
      && currentBalance(appliedPartial.state) === 970
      && cardInvoice(appliedPartial.state, directMixed.cards[0], '2026-09').pending === 270
      && cardOutstanding(appliedPartial.state, 'card0') === 270
      && cardsOverview(appliedPartial.state).totalDebt === 270
      && /270,00/.test(debtFromRealFlow.reply) && !/300,00/.test(debtFromRealFlow.reply)
      && debtFromRealFlow.actions.length === 0))
  const paidDirectAfterPartial = reducer(unrelatedPartial, { type: 'payInstallment',
    id: 'mixed-0', paidAt: TODAY, paidTime: '14:30' })
  const debtAfterDirect = await turn(paidDirectAfterPartial, 'quanto falta pagar do Inter?')
  const undoneDirectAfterPartial = reducer(paidDirectAfterPartial, { type: 'unpayInstallment', id: 'mixed-0' })
  const debtAfterUndo = await turn(undoneDirectAfterPartial, 'quanto falta pagar do Inter?')
  out.push(result('E-cartao-parcial-direto-desfazer', { debtAfterDirect, debtAfterUndo },
    'R$ 70 depois de pagar R$ 200 diretamente; R$ 270 após desfazer',
    cardOutstanding(paidDirectAfterPartial, 'card0') === 70
      && /70,00/.test(debtAfterDirect.reply) && !/270,00/.test(debtAfterDirect.reply)
      && cardOutstanding(undoneDirectAfterPartial, 'card0') === 270
      && /270,00/.test(debtAfterUndo.reply)
      && debtAfterDirect.actions.length === 0 && debtAfterUndo.actions.length === 0))
  const paidAfterPartial = reducer(unrelatedPartial, { type: 'payInstallment', id: 'mixed-0',
    paidAt: TODAY, paidTime: '14:00' })
  const undoneAfterPartial = reducer(paidAfterPartial, { type: 'unpayInstallment', id: 'mixed-0' })
  out.push(result('C-desfazer-direto-apos-fatura-parcial', {
    paid: currentBalance(paidAfterPartial), undone: currentBalance(undoneAfterPartial),
  }, 'parcial anterior não impede desfazer pagamento direto posterior',
    currentBalance(paidAfterPartial) === 770
      && currentBalance(undoneAfterPartial) === 970
      && undoneAfterPartial.installments[0].status === 'pending'))
  for (const [name, phrase] of [
    ['pingou', 'quando eu falar sonho é pingou'],
    ['cairam', 'quando eu falar sonharia é cairam'],
    ['quitei', 'quando eu falar imagino é quitei'],
    ['abastecendo', 'quando eu falar pretendia é abastecendo'],
  ] as const) {
    const proposal = await turn(buildState({ cards: [{ name: 'Inter' }] }), phrase)
    out.push(result(`B-alias-${name}`, proposal, 'ensino de alias financeiro recusado',
      !proposal.preferenceMutation))
  }
  for (const [id, phrase, amount] of [
    ['nunca', 'Recebi 100 mas nunca gastei 40 no mercado', 100],
    ['nem-sequer', 'Recebi 100 mas nem sequer gastei 40 no mercado', 100],
    ['jamais', 'Paguei 30 no pneu mas jamais fiz uma corrida de 70', -30],
  ] as const) {
    const st = buildState({ profile: id === 'jamais' ? 'driver' : 'autonomo' })
    st.settings.balanceAsOf = '2026-09-14T09:00'
    const answer = await turn(st, phrase)
    const applied = applyBatchPure(st, answer.actions.map((action, i) => ({ id: `${id}-${i}`, action })),
      { now: { date: TODAY, time: '14:00' } })
    out.push(result(`B-negacao-${id}`, { answer, balance: currentBalance(applied.state) },
      `saldo ${amount}, sem viagem inventada`,
      currentBalance(applied.state) === amount && applied.state.workSessions.length === 0))
  }
  const unpaidPassive = await turn(buildState({ profile: 'driver' }),
    'Fiz uma corrida de 70 mas ainda não fui pago')
  const unrelatedNegative = await turn(buildState({ profile: 'driver' }),
    'Recebi 70 pela corrida mas não recebo salário fixo')
  out.push(result('B-corrida-nega-pagamento', unpaidPassive, 'sem qualquer receita',
    !unpaidPassive.actions.some(a => a.kind === 'income')))
  out.push(result('B-negacao-de-outra-renda', unrelatedNegative, 'receita de corrida R$ 70 preservada',
    unrelatedNegative.actions.filter(a => a.kind === 'income').length === 1
      && unrelatedNegative.actions.some(a => a.kind === 'income' && a.amount === 70)))
  for (const [id, phrase] of [
    ['nao-me-pagaram', 'Fiz uma corrida de 70 mas não me pagaram'],
    ['nao-recebi-nada', 'Fiz uma corrida de 70 mas não recebi nada'],
    ['nao-recebi-o-valor', 'Fiz uma corrida de 70 mas não recebi o valor ainda'],
    ['nao-caiu-nada', 'Fiz uma corrida de 70 mas não caiu nada ainda'],
    ['nunca-me-pagaram', 'Fiz uma corrida de 70 mas nunca me pagaram'],
  ] as const) {
    const unpaid = await turn(buildState({ profile: 'driver' }), phrase)
    out.push(result(`C-corrida-${id}`, unpaid, 'nenhuma receita proposta',
      !unpaid.actions.some(a => a.kind === 'income')))
  }
  const houseCompare = await turn(categoryFocus, 'compara julho com junho em casa', foodJuly.focus)
  const allCompare = await turn(categoryFocus, 'compara julho com junho de todas as categorias', foodJuly.focus)
  out.push(result('B-comparacao-categoria-explicita', houseCompare, 'casa R$ 2000 contra R$ 1000',
    houseCompare.focus?.lastQueryPlan?.filter.categories?.includes('casa') === true
      && houseCompare.focus?.lastQuery?.total === 2000
      && /2\.000,00/.test(houseCompare.reply) && /1\.000,00/.test(houseCompare.reply)))
  out.push(result('B-comparacao-todas-categorias', allCompare, 'total R$ 2080 contra R$ 1010',
    !allCompare.focus?.lastQueryPlan?.filter.categories?.length
      && allCompare.focus?.lastQuery?.total === 2080
      && /2\.080,00/.test(allCompare.reply) && /1\.010,00/.test(allCompare.reply)))
  const incomeByHouse = buildState({ transactions: [
    { id: 'h1-aug', type: 'income', amount: 1800, category: 'aluguel', origin: 'Casa 1', date: '2026-08-05' },
    { id: 'h1-jul', type: 'income', amount: 1200, category: 'aluguel', origin: 'Casa 1', date: '2026-07-05' },
    { id: 'h1-jun', type: 'income', amount: 600, category: 'aluguel', origin: 'Casa 1', date: '2026-06-05' },
    { id: 'h2-aug', type: 'income', amount: 2500, category: 'aluguel', origin: 'Casa 2', date: '2026-08-05' },
    { id: 'h2-jul', type: 'income', amount: 2100, category: 'aluguel', origin: 'Casa 2', date: '2026-07-05' },
    { id: 'h2-jun', type: 'income', amount: 1900, category: 'aluguel', origin: 'Casa 2', date: '2026-06-05' },
    { id: 'h1-exp-aug', type: 'expense', amount: 300, category: 'casa', origin: 'Casa 1', date: '2026-08-10' },
    { id: 'h1-exp-jul', type: 'expense', amount: 100, category: 'casa', origin: 'Casa 1', date: '2026-07-10' },
  ] })
  const h1August = await turn(incomeByHouse, 'quanto a Casa 1 me rendeu em agosto')
  const allIncome = await turn(incomeByHouse, 'compara agosto com julho em geral', h1August.focus)
  out.push(result('D-comparacao-receita-rotulo', allIncome, 'receita 4300 contra 3300, rotulada como recebida',
    allIncome.focus?.lastQuery?.total === 4300
      && allIncome.focus?.lastQueryPlan?.filter.txType?.[0] === 'income'
      && /total recebido/i.test(allIncome.reply) && !/total gasto/i.test(allIncome.reply)))
  const h2Compare = await turn(incomeByHouse, 'compara agosto com julho da Casa 2', h1August.focus)
  const h2June = await turn(incomeByHouse, 'e em junho', h2Compare.focus)
  out.push(result('D-comparacao-origem-explicita', { h2Compare, h2June },
    'Casa 2: 2500 contra 2100, depois junho 1900',
    h2Compare.focus?.lastQuery?.total === 2500
      && h2Compare.focus?.lastQueryPlan?.filter.origin === 'casa 2'
      && h2June.focus?.lastQuery?.total === 1900
      && /Casa 2/i.test(h2Compare.reply) && /Casa 2/i.test(h2June.reply)
      && h2Compare.actions.length === 0 && h2June.actions.length === 0))
  const expenses = await turn(incomeByHouse, 'compara agosto com julho em gastos', h1August.focus)
  out.push(result('D-comparacao-tipo-explicito', expenses, 'mudança explícita para despesa',
    expenses.focus?.lastQueryPlan?.filter.txType?.[0] === 'expense'
      && /total gasto/i.test(expenses.reply) && !/total recebido/i.test(expenses.reply)))
  const historical = buildState({ transactions: [
    { id: 'food-aug-h', type: 'expense', amount: 60, category: 'alimentacao', date: '2026-08-10' },
    { id: 'food-jul-h', type: 'expense', amount: 40, category: 'alimentacao', date: '2026-07-10' },
    { id: 'food-jun-h', type: 'expense', amount: 100, category: 'alimentacao', date: '2026-06-10' },
    { id: 'food-may-last', type: 'expense', amount: 500, category: 'alimentacao', date: '2026-05-31' },
  ] })
  const histAugust = await turn(historical, 'quanto gastei com alimentação em agosto')
  const histCompare = await turn(historical, 'compara agosto com julho', histAugust.focus)
  const histJune = await turn(historical, 'e em junho', histCompare.focus)
  out.push(result('D-mes-historico-completo', histJune, 'junho 100 contra maio 500 incluindo 31/05',
    histJune.focus?.lastQuery?.total === 100
      && histJune.focus?.lastQueryPlan?.comparePeriod?.to === '2026-05-31'
      && /500,00/.test(histJune.reply) && /400,00\s+abaixo/.test(histJune.reply.replace(/\u00a0/g, ' '))))
  for (const [id, phrase] of [
    ['devendo', 'Fiz uma corrida de 70 mas o cliente tá me devendo'],
    ['sem-receber', 'Fiz uma corrida de 70 mas fiquei sem receber'],
    ['dinheiro-nao-caiu', 'Fiz uma corrida de 70 mas o dinheiro ainda não caiu'],
    ['pix-nao-entrou', 'Fiz uma corrida de 70 mas o Pix não entrou'],
    ['nem-centavo', 'Fiz uma corrida de 70 mas não recebi um centavo'],
  ] as const) {
    const proposal = await turn(buildState({ profile: 'driver' }), phrase)
    out.push(result(`D-corrida-nao-paga-${id}`, proposal, 'só viagem; nenhuma ação financeira',
      proposal.actions.length > 0 && proposal.actions.every(a => a.kind === 'work')))
  }
  for (const [id, phrase] of [
    ['salario', 'Recebi 70 pela corrida mas meu patrão nunca me pagou o salário'],
    ['venda', 'Recebi 70 pela corrida mas da venda não recebi nada'],
    ['aluguel', 'Recebi 70 pela corrida mas não caiu nada do aluguel'],
  ] as const) {
    const proposal = await turn(buildState({ profile: 'driver' }), phrase)
    out.push(result(`D-corrida-outra-renda-${id}`, proposal, 'receita de corrida 70 preservada, sem extras',
      JSON.stringify(proposal.actions.filter(a => a.kind === 'income').map(a => a.amount)) === '[70]'
        && proposal.actions.every(a => a.kind === 'income' || a.kind === 'work')))
  }
  const expenseAnchor = await turn(buildState(), 'gastei 50 no mercado e meu saldo é 800')
  const expenseAnchorApplied = applyBatchPure(buildState(), expenseAnchor.actions.map((action, i) =>
    ({ id: `expense-anchor-${i}`, action })), { now: { date: TODAY, time: '14:00' } })
  out.push(result('D-despesa-antes-ancora', { expenseAnchor, expenseAnchorApplied },
    'despesa 50 antes de âncora 800; histórico preservado',
    expenseAnchor.actions.map(a => a.kind).join(',') === 'expense,balance'
      && expenseAnchorApplied.applied && currentBalance(expenseAnchorApplied.state) === 800
      && expenseAnchorApplied.state.transactions.some(t => t.type === 'expense' && t.amount === 50)))
  const threeEvents = await turn(buildState(),
    'recebi 100 de aluguel e meu saldo é 800 e gastei 20 no mercado')
  const threeApplied = applyBatchPure(buildState(), threeEvents.actions.map((action, i) =>
    ({ id: `three-events-${i}`, action })), { now: { date: TODAY, time: '14:00' } })
  out.push(result('D-receita-ancora-despesa-na-ordem', { threeEvents, threeApplied },
    'receita 100, âncora 800, despesa 20; saldo 780 e histórico íntegro',
    threeEvents.actions.map(a => a.kind).join(',') === 'income,balance,expense'
      && threeApplied.applied && currentBalance(threeApplied.state) === 780
      && threeApplied.state.transactions.some(t => t.type === 'income' && t.amount === 100)
      && threeApplied.state.transactions.some(t => t.type === 'expense' && t.amount === 20)))
  // Parecer independente seguinte: variantes que os 147 casos anteriores não
  // distinguiam. O oráculo recusa qualquer ação financeira extra.
  for (const [id, phrase, expectedIncomes, expectedTrips] of [
    ['pix-pendente', 'Fiz uma corrida de 70 mas não recebi o Pix', [], 1],
    ['comissao-negada', 'Recebi 70 pela corrida mas da comissão não recebi nada', [70], 1],
    ['cliente-devendo-salario', 'Fiz uma corrida de 70 mas o cliente não me pagou porque não recebeu o salário', [], 1],
    ['duas-corridas', 'Fiz uma corrida de 70 sem receber e recebi 40 de outra corrida', [40], 2],
  ] as const) {
    const proposal = await turn(buildState({ profile: 'driver' }), phrase)
    const incomes = proposal.actions.filter(a => a.kind === 'income').map(a => a.amount).sort((a, b) => a - b)
    const trips = proposal.actions.filter(a => a.kind === 'work').reduce((n, a) => n + (a.trips || 0), 0)
    out.push(result(`E-corrida-${id}`, proposal, { incomes: expectedIncomes, trips: expectedTrips },
      JSON.stringify(incomes) === JSON.stringify(expectedIncomes)
        && trips === expectedTrips
        && proposal.actions.every(a => a.kind === 'income' || a.kind === 'work')))
  }
  for (const [id, phrase] of [
    ['agora', 'gastei 50 no mercado agora meu saldo é 800'],
    ['sem-conector', 'gastei 50 no mercado meu saldo é 800'],
  ] as const) {
    const proposal = await turn(buildState(), phrase)
    const applied = applyBatchPure(buildState(), proposal.actions.map((action, i) =>
      ({ id: `anchor-no-and-${id}-${i}`, action })), { now: { date: TODAY, time: '14:00' } })
    out.push(result(`E-ancora-${id}`, { proposal, applied }, 'despesa 50, âncora 800, histórico preservado',
      proposal.actions.map(a => a.kind).join(',') === 'expense,balance'
        && applied.applied && currentBalance(applied.state) === 800
        && applied.state.transactions.length === 1
        && applied.state.transactions[0].type === 'expense'
        && applied.state.transactions[0].amount === 50))
  }
  const auditQueryState = buildState()
  const auditEntries = [
    ['Casa 1', 'income', 'aluguel', [1800, 1200, 600]],
    ['Casa 1', 'income', 'outros-in', [700, 400, 200]],
    ['Casa 2', 'income', 'aluguel', [2500, 2100, 1900]],
    ['Casa 2', 'income', 'outros-in', [900, 800, 300]],
    ['Casa 1', 'expense', 'casa', [300, 100, 50]],
    ['Casa 1', 'expense', 'alimentacao', [60, 40, 100]],
    ['Casa 2', 'expense', 'casa', [550, 450, 350]],
    ['Casa 2', 'expense', 'alimentacao', [80, 20, 200]],
  ] as const
  auditQueryState.transactions = auditEntries.flatMap(([origin, type, category, amounts], row) =>
    amounts.map((amount, month) => ({ id: `audit-${row}-${month}`, type, category, origin,
      amount, date: `2026-${String(8 - month).padStart(2, '0')}-10` })))
  auditQueryState.transactions.push({ id: 'audit-may', type: 'income', category: 'aluguel',
    origin: 'Casa 2', amount: 1000, date: '2026-05-10' })
  const spentH1 = await turn(auditQueryState, 'quanto gastei da Casa 1 em agosto')
  const receivedH1 = await turn(auditQueryState, 'compara agosto com julho quanto recebi', spentH1.focus)
  const receivedH1June = await turn(auditQueryState, 'e em junho', receivedH1.focus)
  out.push(result('E-foco-recebi-explicito', { receivedH1, receivedH1June },
    'Casa 1: receitas 2500/1600/800, rótulo recebido, sem ações',
    receivedH1.focus?.lastQueryPlan?.filter.txType?.[0] === 'income'
      && receivedH1.focus?.lastQuery?.total === 2500
      && /1\.600,00/.test(receivedH1.reply)
      && receivedH1June.focus?.lastQuery?.total === 800
      && /total recebido/i.test(receivedH1June.reply)
      && receivedH1.actions.length === 0 && receivedH1June.actions.length === 0))
  const foodH1 = await turn(auditQueryState, 'quanto gastei com alimentação da Casa 1 em agosto')
  const allH2 = await turn(auditQueryState, 'compara agosto com julho de todas as categorias da Casa 2', foodH1.focus)
  const allH2June = await turn(auditQueryState, 'e em junho', allH2.focus)
  out.push(result('E-todas-categorias-origem-explicita', { allH2, allH2June },
    'Casa 2 gastos 630/470/550, sem ações nem outras origens',
    allH2.focus?.lastQueryPlan?.filter.origin === 'casa 2'
      && !allH2.focus?.lastQueryPlan?.filter.categories?.length
      && allH2.focus?.lastQuery?.total === 630 && /470,00/.test(allH2.reply)
      && allH2June.focus?.lastQuery?.total === 550
      && allH2.actions.length === 0 && allH2June.actions.length === 0))
  const avgH1 = await turn(auditQueryState, 'qual a média de gastos da Casa 1 em agosto')
  const avgH2 = await turn(auditQueryState, 'compara agosto com julho da Casa 2 em gastos', avgH1.focus)
  const avgH2June = await turn(auditQueryState, 'e em junho', avgH2.focus)
  out.push(result('E-media-nao-vira-total', { avgH2, avgH2June },
    'médias 315/235/275, rotuladas como média',
    avgH2.focus?.lastQueryPlan?.metric === 'avg'
      && avgH2.focus?.lastQuery?.total === 315 && /235,00/.test(avgH2.reply)
      && avgH2June.focus?.lastQuery?.total === 275
      && /m[eé]dia/i.test(avgH2.reply) && /m[eé]dia/i.test(avgH2June.reply)
      && !/total gasto/i.test(avgH2.reply + avgH2June.reply)))
  const foodH2 = await turn(auditQueryState, 'compara agosto com julho da Casa 2', foodH1.focus)
  out.push(result('E-rotulo-conserva-categoria', foodH2,
    'alimentação da Casa 2: 80/20, ambos os filtros no rótulo',
    foodH2.focus?.lastQuery?.total === 80 && /20,00/.test(foodH2.reply)
      && /alimenta/i.test(foodH2.reply) && /Casa 2/i.test(foodH2.reply)))
  const incomeH2 = await turn(auditQueryState, 'compara agosto com julho da Casa 2 em receitas', spentH1.focus)
  const incomeH2June = await turn(auditQueryState, 'e em junho', incomeH2.focus)
  const worse = await turn(auditQueryState, 'qual foi pior?', incomeH2June.focus)
  out.push(result('E-pior-comparativo-visivel', { incomeH2June, worse },
    'maio 1000 foi pior que junho 2200; agosto não participa',
    incomeH2June.focus?.lastQuery?.total === 2200
      && incomeH2June.focus?.lastQueryPlan?.comparePeriod?.from === '2026-05-01'
      && /maio.*pior/i.test(worse.reply) && /1\.000,00/.test(worse.reply)
      && /2\.200,00/.test(worse.reply) && !/agosto/i.test(worse.reply)
      && worse.actions.length === 0))

  // Caixa FUTURO pelo roteador antigo, que lê o relógio real (regra 35): o
  // estado é montado em volta de hoje. Oráculos calculados à mão:
  //   até hoje+10 → fatura Inter atrasada 300 + Internet 100 + Aluguel 900 = 1.300;
  //   Água de hoje−15 venceu SEM confirmação (50) e fica à parte;
  //   a fatura do Nubank tem a parcela marcada como paga e não é compromisso.
  const hoje = todayISO()
  const alvo = addDays(hoje, 10)
  const dd = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
  const deslocada = /total gasto|meta de hoje|n[ãa]o consegui ler|pr[óo]ximas contas|de qual m[êe]s|bateu a meta/i
  for (const [id, perfil, frase] of [
    ['F-reserva-parado', 'autonomo', `quanto eu preciso deixar parado ate dia ${Number(alvo.slice(8, 10))}`],
    ['F-reserva-na-conta', 'autonomo', `quanto preciso deixar na conta ate dia ${Number(alvo.slice(8, 10))}`],
    ['F-reserva-separar-motorista', 'driver', `quanto tenho que separar pras contas ate dia ${Number(alvo.slice(8, 10))}`],
    ['F-reserva-ter-pro-dia', 'driver', `qnt preciso ter na conta pro dia ${Number(alvo.slice(8, 10))}`],
  ] as const) {
    const st = estadoDeCaixaFuturo(hoje, 2000, perfil)
    const antes = JSON.stringify(st)
    const r = await turn(st, frase)
    out.push(result(id, r.reply, `até ${dd(alvo)}: R$ 1.300 certos, Água 50 sem confirmação, sobram R$ 700`,
      r.actions.length === 0 && JSON.stringify(st) === antes
        && r.reply.startsWith(`Até ${dd(alvo)}, deixe pelo menos R$`) && /1\.300,00/.test(r.reply)
        && /Fatura Inter: R\$\s300,00/.test(r.reply) && /Aluguel: R\$\s900,00/.test(r.reply)
        && /Internet: R\$\s100,00/.test(r.reply) && !/Nubank/.test(r.reply)
        && /sem confirma[çc][ãa]o — [ÁA]gua, somando R\$\s50,00/.test(r.reply)
        && /sobram R\$\s700,00/.test(r.reply) && !deslocada.test(r.reply)))
  }
  {
    const st = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const dia5 = await turn(st, 'quanto devo deixar reservado até o dia 5')
    const alvo5 = (() => {
      const d = Number(hoje.slice(8, 10))
      const [y, m] = hoje.split('-').map(Number)
      return d <= 5 ? `${hoje.slice(0, 8)}05` : `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-05`
    })()
    const semDia = await turn(st, 'quanto preciso deixar parado pras contas')
    const dia32 = await turn(st, 'quanto preciso reservar ate dia 32')
    const meta = await turn({ ...st, goals: [{ id: 'g-viagem', name: 'Viagem', target: 6000, saved: 4800, createdAt: hoje }] },
      'quanto preciso reservar pra viagem')
    out.push(result('F-reserva-ecoa-o-dia-pedido', dia5.reply, `data ${dd(alvo5)}, nunca "dia 10" fixo`,
      dia5.reply.startsWith(`Até ${dd(alvo5)}`) && !/dia 10/.test(dia5.reply)))
    out.push(result('F-reserva-sem-data-pergunta', semDia.reply, 'pergunta até quando, sem número',
      /at[ée] quando/i.test(semDia.reply) && !/R\$/.test(semDia.reply)))
    out.push(result('F-reserva-dia-inexistente', dia32.reply, 'recusa o dia 32, sem número',
      /dia 32/.test(dia32.reply) && !/R\$/.test(dia32.reply)))
    out.push(result('F-reserva-nao-sequestra-meta', meta.reply, 'responde a meta Viagem (falta R$ 1.200)',
      /viagem/i.test(meta.reply) && /1\.200,00/.test(meta.reply) && !/deixe pelo menos/i.test(meta.reply)))
  }
  {
    // Total do aperto: atrasada 300 + Internet 100 + Aluguel 900 + Água (a
    // próxima, dentro de 30 dias) 50 = 1.350. A maior futura é o Aluguel; a
    // mais próxima é a Internet.
    for (const frase of ['qual conta ta me apertando', 'qual das contas ta pesando mais', 'qual boleto ta me apertando']) {
      const st = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
      const r = await turn(st, frase)
      out.push(result(`F-aperto-${frase.split(' ')[1]}-${frase.split(' ').slice(-1)[0]}`, r.reply,
        'atrasada primeiro; maior Aluguel 900; próxima Internet 100; cobre R$ 1.350',
        r.actions.length === 0
          && /^O que mais aperta é o que já venceu: Fatura Inter, R\$\s300,00/.test(r.reply)
          && /a maior é Aluguel: R\$\s900,00/.test(r.reply)
          && /A próxima a vencer é Internet: R\$\s100,00/.test(r.reply)
          && /cobre os R\$\s1\.350,00/.test(r.reply) && !/Nubank/.test(r.reply)
          && /sem confirma[çc][ãa]o/.test(r.reply) && !deslocada.test(r.reply)))
    }
    const curto = await turn(estadoDeCaixaFuturo(hoje, 500, 'autonomo'), 'qual conta ta me apertando')
    out.push(result('F-aperto-saldo-nao-cobre', curto.reply, 'saldo 500 não cobre 1.350: faltam 850',
      /n[ãa]o cobre os R\$\s1\.350,00/.test(curto.reply) && /faltam R\$\s850,00/.test(curto.reply)))
    const empate = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    empate.recurring = empate.recurring.map(r => r.id === 'aluguel' ? { ...r, amount: 100 } : r)
    const empatou = await turn(empate, 'qual conta pesa mais')
    out.push(result('F-aperto-empate-dito', empatou.reply, 'Internet e Aluguel empatam em R$ 100',
      /empatam/.test(empatou.reply) && /Internet/.test(empatou.reply) && /Aluguel/.test(empatou.reply)
      && !/a maior é/i.test(empatou.reply)))
    const ambiguo = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    ambiguo.installments = ambiguo.installments.map(i => i.id === 'cx-inter' ? { ...i, status: 'paid' as const,
      paidAt: addDays(hoje, -5), paidAmount: 300, paidVia: 'direct' as const } : i)
    ambiguo.cardPayments = [{ id: 'cx-dup', cardId: 'cx-card-inter', amount: 300, paymentDate: addDays(hoje, -4),
      paymentTime: '10:00:00', referenceMonth: addDays(hoje, -5).slice(0, 7), fromBalance: true }]
    const reservaAmbigua = await turn(ambiguo, `quanto preciso deixar parado ate dia ${Number(alvo.slice(8, 10))}`)
    const apertoAmbiguo = await turn(ambiguo, 'qual conta ta me apertando')
    out.push(result('F-caixa-futuro-saldo-legado-ambiguo', { reservaAmbigua: reservaAmbigua.reply, apertoAmbiguo: apertoAmbiguo.reply },
      'reserva recusa o número; aperto não afirma cobertura pelo saldo',
      /n[ãa]o consigo confirmar seu saldo/i.test(reservaAmbigua.reply) && !/deixe pelo menos/.test(reservaAmbigua.reply)
        && /n[ãa]o consigo confirmar seu saldo/i.test(apertoAmbiguo.reply) && !/cobre os/.test(apertoAmbiguo.reply)))

    // As três respostas de vencimento usam as MESMAS fontes e o prazo dito.
    // "O que vence" e "contas cobrem" olhavam só conta fixa, 15 dias fixos,
    // e contradiziam a reserva no mesmo aparelho.
    const n = Number(alvo.slice(8, 10))
    const estado = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const vence = await turn(estado, `quais contas vencem ate dia ${n}`)
    const cobre = await turn(estado, `minhas contas cobrem ate dia ${n}?`)
    const reserva = await turn(estado, `quanto preciso deixar parado ate dia ${n}`)
    const totalDe = (s: string) => (s.match(/R\$\s([\d.]+,\d{2})/) || [])[1]
    out.push(result('F-vencimentos-coerentes', { vence: vence.reply, cobre: cobre.reply, reserva: reserva.reply },
      'R$ 1.300,00 nas três, com a fatura atrasada e sem a Água sem confirmação',
      totalDe(vence.reply) === '1.300,00' && /cobre os R\$\s1\.300,00/.test(cobre.reply)
        && /deixe pelo menos R\$\s1\.300,00/.test(reserva.reply)
        && [vence, cobre].every(r => /Fatura Inter/.test(r.reply) && /sem confirma[çc][ãa]o — [ÁA]gua/.test(r.reply))
        && cobre.reply.startsWith('Sim.') && /sobram R\$\s700,00/.test(cobre.reply)))
    const curtoCobre = await turn(estadoDeCaixaFuturo(hoje, 500, 'autonomo'), `minhas contas cobrem ate dia ${n}?`)
    out.push(result('F-cobre-nao', curtoCobre.reply, 'Não; faltam R$ 800',
      curtoCobre.reply.startsWith('Não.') && /faltam R\$\s800,00/.test(curtoCobre.reply)))
    const semana = await turn(estado, 'o que vence essa semana')
    out.push(result('F-vence-essa-semana', semana.reply, `até ${dd(addDays(hoje, 7))}, R$ 1.300`,
      semana.reply.startsWith(`Vence até ${dd(addDays(hoje, 7))}: R$`) && /1\.300,00/.test(semana.reply)))
    const temConta = await turn(estado, 'tem conta vencendo?')
    out.push(result('F-tem-conta-sim', temConta.reply, 'começa com Sim.', temConta.reply.startsWith('Sim.')))
  }

  // Compra parcelada citada pelo NOME com "falta do", "devo do", "paguei do".
  // O nome ficava sem leitor e a resposta somava os dois parcelamentos
  // (R$ 5.200) como se fossem o computador. Oráculo do fixture: Computador
  // 10 × 400 com 2 pagas (falta 3.200, pago 800, 8 parcelas); Geladeira 6 × 400
  // com 1 paga (falta 2.000, pago 400, 5 parcelas).
  for (const [id, frase, esperado, rotuloEsperado] of [
    ['G-falta-do-computador', 'quanto ainda falta do computador', /R\$\s3\.200,00/, /Computador/],
    ['G-devo-do-computador', 'quanto ainda devo do computador', /R\$\s3\.200,00/, /Computador/],
    ['G-parcelas-faltam-do-computador', 'quantas parcelas faltam do computador', /:\s8\b/, /Parcelas restantes - Computador/],
    ['G-parcelas-da-geladeira-faltam', 'quantas parcelas da geladeira faltam', /:\s5\b/, /Parcelas restantes - Geladeira/],
    ['G-ja-paguei-do-computador', 'quanto ja paguei do computador', /R\$\s800,00/, /J[áa] pago - Computador/],
    ['G-controle-geladeira', 'quanto falta pagar da geladeira', /R\$\s2\.000,00/, /Geladeira/],
  ] as const) {
    const r = await turn(autonomoRico(todayISO()), frase)
    out.push(result(id, r.reply, `${esperado} com rótulo ${rotuloEsperado}`,
      esperado.test(r.reply) && rotuloEsperado.test(r.reply) && !/5\.200,00|total gasto/i.test(r.reply)
        && r.actions.length === 0))
  }
  const semCompra = await turn(autonomoRico(todayISO()), 'quanto falta do carro')
  out.push(result('G-compra-inexistente', semCompra.reply, 'sem parcelamento "carro", sem número',
    /carro/i.test(semCompra.reply) && !/R\$/.test(semCompra.reply)))
  const aluguel = await turn(autonomoRico(todayISO()), 'quanto paguei do aluguel')
  out.push(result('G-paguei-sem-plano-continua-lancamento', aluguel.reply, 'não lê "aluguel" como parcelamento',
    !/j[áa] pago|parcelamento/i.test(aluguel.reply)))

  // Comparação com período de outro TAMANHO: "tô melhor que semana passada?"
  // comparava o gasto do mês (27 dias) com o da semana (7), "+861%". O oráculo
  // soma os lançamentos do fixture direto, sem passar pela consulta.
  {
    const st = motoristaRico(hoje)
    const soma = (from: string, to: string, tipo?: 'income' | 'expense', desc?: string) => Math.round(st.transactions
      .filter(t => t.date >= from && t.date <= to && (!desc || t.description === desc))
      .reduce((a, t) => a + (t.type === 'income' && tipo !== 'expense' ? t.amount
        : t.type === 'expense' && tipo !== 'income' ? (tipo ? t.amount : -t.amount) : 0), 0) * 100) / 100
    const sete = [addDays(hoje, -6), hoje] as const
    const antes = [addDays(hoje, -13), addDays(hoje, -7)] as const
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    for (const [id, frase, tipo, desc, rotuloEsperado] of [
      ['H-melhor-que-semana', 'to melhor que semana passada?', undefined, undefined, /^Resultado nos últimos 7 dias/],
      ['H-comparado-cm-semana', 'e comparado cm semana passada', undefined, undefined, /^Resultado nos últimos 7 dias/],
      ['H-gastei-mais-que-semana', 'gastei mais que semana passada?', 'expense', undefined, /^Total gasto nos últimos 7 dias/],
      ['H-uber-comparado-semana', 'uber comparado com semana passada', 'income', 'Uber', /^Total recebido na Uber nos últimos 7 dias/],
      ['H-fiz-na-uber-comparado', 'quanto fiz na uber comparado com semana passada', 'income', 'Uber', /^Total recebido na Uber nos últimos 7 dias/],
    ] as const) {
      const r = await turnoHoje(st, frase)
      const atual = soma(sete[0], sete[1], tipo, desc)
      const anterior = soma(antes[0], antes[1], tipo, desc)
      const texto = limpa(r.reply)
      out.push(result(id, r.reply, `${brl(atual)} nos últimos 7 dias contra ${brl(anterior)} na semana anterior`,
        // A pergunta de sim ou não ganha "Sim, …"/"Não, …" na frente (regra 57).
        rotuloEsperado.test(texto.replace(/^(?:Sim|Não), [a-z]+\. /, ''))
          && texto.includes(brl(atual)) && texto.includes(`Na semana passada: ${brl(anterior)}`)
          && !/este m[êe]s/i.test(texto) && r.actions.length === 0))
    }
    const hojeOntem = await turnoHoje(st, 'como foi hoje comparado com ontem')
    const ontem = addDays(hoje, -1)
    out.push(result('H-como-foi-hoje-ontem', hojeOntem.reply, 'resultado de hoje contra o de ontem',
      /^Resultado hoje/.test(limpa(hojeOntem.reply)) && limpa(hojeOntem.reply).includes(brl(soma(hoje, hoje)))
        && limpa(hojeOntem.reply).includes(brl(soma(ontem, ontem)))))
    const gasolina = await turnoHoje(st, 'gasolina comparado com o mes passado')
    const inicioMes = `${hoje.slice(0, 8)}01`
    out.push(result('H-sujeito-sem-preposicao', gasolina.reply, 'gasto com gasolina, não o gasto total',
      /Gasolina/.test(gasolina.reply) && limpa(gasolina.reply).includes(brl(soma(inicioMes, hoje, 'expense', 'Gasolina')))
        && !limpa(gasolina.reply).includes(`${brl(soma(inicioMes, hoje, 'expense'))} (dado real)`)
        || soma(inicioMes, hoje, 'expense', 'Gasolina') === soma(inicioMes, hoje, 'expense') && /Gasolina/.test(gasolina.reply)))

    // Sim ou não primeiro, com o sentido calculado do fixture: "melhor" é
    // resultado maior; "gastei mais" é gasto maior; "custo por km piorou" é
    // gasto por km maior. Pergunta aberta e frase sem "?" não ganham "Sim".
    const net7 = soma(sete[0], sete[1]); const netAntes = soma(antes[0], antes[1])
    const gasto7 = soma(sete[0], sete[1], 'expense'); const gastoAntes = soma(antes[0], antes[1], 'expense')
    const melhor = await turnoHoje(st, 'to melhor que semana passada?')
    out.push(result('J-sim-nao-melhor', melhor.reply, net7 > netAntes ? 'Sim, melhorou.' : 'Não, piorou.',
      limpa(melhor.reply).startsWith(net7 > netAntes ? 'Sim, melhorou.' : 'Não, piorou.')))
    const gastou = await turnoHoje(st, 'gastei mais que semana passada?')
    out.push(result('J-sim-nao-gastei-mais', gastou.reply, gasto7 > gastoAntes ? 'Sim, subiu.' : 'Não, caiu.',
      limpa(gastou.reply).startsWith(gasto7 > gastoAntes ? 'Sim, subiu.' : 'Não, caiu.')))
    const dia = Number(hoje.slice(8, 10))
    const [y, m] = hoje.split('-').map(Number)
    const inicioAnt = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`
    const fimAnt = `${inicioAnt.slice(0, 8)}${String(Math.min(dia, new Date(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 0).getDate())).padStart(2, '0')}`
    const kmEntre = (from: string, to: string) => st.workSessions.filter(w => w.date >= from && w.date <= to).reduce((a, w) => a + w.km, 0)
    const porKm = (from: string, to: string) => soma(from, to, 'expense') / Math.max(kmEntre(from, to), 1)
    const custoKm = await turnoHoje(st, 'meu custo por km piorou?')
    const subiuKm = porKm(inicioMes, hoje) > porKm(inicioAnt, fimAnt)
    out.push(result('J-sim-nao-custo-por-km', custoKm.reply, subiuKm ? 'Sim, piorou.' : 'Não, melhorou.',
      limpa(custoKm.reply).startsWith(subiuKm ? 'Sim, piorou.' : 'Não, melhorou.')))
    for (const [id, frase] of [
      ['J-sem-interrogacao-nao-ganha-lead', 'comparado com a semana passada'],
      ['J-pergunta-aberta-nao-ganha-lead', 'quanto gastei a mais que semana passada?'],
    ] as const) {
      const r = await turnoHoje(st, frase)
      out.push(result(id, r.reply, 'sem "Sim"/"Não" na frente', !/^(?:Sim|Não),/.test(r.reply)))
    }
    const gasolinaSubiu = await turnoHoje(st, 'minha gasolina aumentou?')
    const combustivelMes = Math.round(st.transactions.filter(t => t.type === 'expense' && t.category === 'combustivel'
      && t.date >= inicioMes && t.date <= hoje).reduce((a, t) => a + t.amount, 0) * 100) / 100
    out.push(result('J-assunto-por-radical', gasolinaSubiu.reply, `combustível do mês ${brl(combustivelMes)}`,
      /Combust[íi]vel/.test(gasolinaSubiu.reply) && limpa(gasolinaSubiu.reply).includes(brl(combustivelMes))))
  }

  // "O que mais subiu" é ranking pela DIFERENÇA, e a lista embaixo segue o
  // mesmo sentido. "Gastando mais que antes" virava o maior gasto do mês e
  // "fora do meu padrão" virava a exclusão "padrao". Oráculo: diferença por
  // categoria entre o mês até hoje e o mesmo trecho do mês anterior.
  {
    const st = autonomoRico(hoje)
    const dia = Number(hoje.slice(8, 10))
    const [y, m] = hoje.split('-').map(Number)
    const ya = m === 1 ? y - 1 : y; const ma = m === 1 ? 12 : m - 1
    const ini = `${hoje.slice(0, 8)}01`
    const iniAnt = `${ya}-${String(ma).padStart(2, '0')}-01`
    const fimAnt = `${iniAnt.slice(0, 8)}${String(Math.min(dia, new Date(ya, ma, 0).getDate())).padStart(2, '0')}`
    const porCat = (from: string, to: string) => {
      const acc = new Map<string, number>()
      for (const t of st.transactions) if (t.type === 'expense' && t.date >= from && t.date <= to) acc.set(t.category, (acc.get(t.category) || 0) + t.amount)
      return acc
    }
    const agora = porCat(ini, hoje); const antes = porCat(iniAnt, fimAnt)
    const deltas = [...new Set([...agora.keys(), ...antes.keys()])]
      .map(id => ({ id, nome: st.categories.find(c => c.id === id)?.name || id, d: (agora.get(id) || 0) - (antes.get(id) || 0) }))
    const subiu = [...deltas].sort((a, b) => b.d - a.d)[0]
    const caiu = [...deltas].sort((a, b) => a.d - b.d)[0]
    for (const frase of ['tem alguma coisa q eu to gastando mt mais q antes?', 'qual despesa esta mais fora do meu padrao', 'o que aumentou mais esse mes']) {
      const r = await turnoHoje(st, frase)
      const depois = r.reply.split('Depois:')[1] || ''
      out.push(result(`K-subiu-${frase.split(' ').slice(2, 4).join('-')}`, r.reply, `${subiu.nome} foi o que mais subiu; lista só com altas`,
        subiu.d > 0 && r.reply.includes(`${subiu.nome} foi o que mais subiu comparado com`) && !/−R\$/.test(depois)
          && !/padrao|padrão/i.test(r.reply) && (!/^tem/.test(frase) || r.reply.startsWith('Sim.'))))
    }
    const r = await turnoHoje(st, 'qual categoria caiu mais')
    out.push(result('K-caiu-lista-so-quedas', r.reply, `${caiu.nome} foi o que mais caiu; lista só com quedas`,
      r.reply.includes(`${caiu.nome} foi o que mais caiu comparado com`) && !/\+R\$/.test(r.reply.split('Depois:')[1] || '')))
    const totalAgora = [...agora.values()].reduce((a, v) => a + v, 0)
    const totalAntes = [...antes.values()].reduce((a, v) => a + v, 0)
    const normal = await turnoHoje(st, 'gastei fora do normal esse mes?')
    out.push(result('K-fora-do-normal-sim-ou-nao', normal.reply, totalAgora > totalAntes ? 'Sim, subiu.' : 'Não, caiu.',
      normal.reply.startsWith(totalAgora > totalAntes ? 'Sim, subiu.' : 'Não, caiu.')))
  }

  // Continuação de simulação: "dá ruim?", "volta" e "qual mês fica pior"
  // repetiam a simulação inteira, idêntica. O veredito tem que bater com os
  // números mostrados: mês com sobra negativa não é "não dá ruim".
  {
    const st = autonomoRico(hoje)
    const t1 = await turnoHoje(st, 'e se eu gastar mais 500 em obra')
    const t2 = await turnoHoje(st, 'da ruim?', t1.focus)
    const t3 = await turnoHoje(st, 'volta', t2.focus)
    const t4 = await turnoHoje(st, 'e se for 50000?', t2.focus)
    const t5 = await turnoHoje(st, 'da ruim?', t4.focus)
    const veredito = (r: string) => /sobra do m[êe]s passaria a -R\$/.test(r) || /saldo em conta ficaria em -R\$/i.test(r.replace(/ /g, ' '))
    const esperado = (r: string) => /saldo em conta ficaria em -R\$/i.test(r.replace(/ /g, ' ')) ? /^D[áa] ruim\./
      : veredito(r) ? /^O saldo aguenta, mas aperta/ : /^N[ãa]o d[áa] ruim\./
    out.push(result('L-da-ruim-com-veredito', [t2.reply, t5.reply], 'veredito primeiro, coerente com a sobra mostrada',
      esperado(t2.reply).test(t2.reply) && esperado(t5.reply).test(t5.reply) && t2.reply !== t1.reply))
    out.push(result('L-volta-sem-anterior', t3.reply, 'confirma que nada foi registrado, sem repetir a conta',
      /nada foi registrado/i.test(t3.reply) && !/R\$/.test(t3.reply)))
    const c1 = await turnoHoje(st, 'se eu meter um pc de 4k em 10x da ruim?')
    const c2 = await turnoHoje(st, 'qual mes fica pior', c1.focus)
    const c3 = await turnoHoje(st, 'e em 12?', c1.focus)
    const c4 = await turnoHoje(st, 'volta', c3.focus)
    const apertado = (c1.reply.match(/mais apertado seria ([a-z]{3}\/\d{4})/) || [])[1]
    out.push(result('L-compra-pergunta-com-veredito', c1.reply, 'abre com o veredito',
      /^(?:N[ãa]o d[áa] ruim|D[áa] ruim|O saldo aguenta)/.test(c1.reply)))
    out.push(result('L-qual-mes-pior-direto', c2.reply, `${apertado} primeiro, sem a lista de meses`,
      !!apertado && c2.reply.startsWith(apertado.charAt(0).toUpperCase() + apertado.slice(1)) && !/•/.test(c2.reply)))
    out.push(result('L-volta-com-anterior', c4.reply, 'volta para os 10x', /em 10x/.test(c4.reply) && /em 12x/.test(c3.reply)))
  }

  // Pergunta e intenção não movem dinheiro (regra 33). "Quanto falta pagar da
  // fatura do inter" virava proposta de pagamento (sem valor, a guarda de
  // pergunta com valor não via) e a resposta era calculada como se pago;
  // "vou pagar a fatura amanhã" e "vou assinar a netflix" viravam registro.
  for (const [id, frase] of [
    ['N-pergunta-falta-pagar-fatura', 'quanto falta pagar da fatura do inter'],
    ['N-pergunta-ja-paguei-fatura', 'ja paguei a fatura do nubank?'],
    ['N-intencao-pagar-fatura', 'vou pagar a fatura do nubank amanha'],
    ['N-intencao-quero-pagar-fatura', 'quero pagar a fatura do inter semana que vem'],
    ['N-intencao-assinar', 'vou assinar a netflix de 39,90 no nubank'],
    ['N-intencao-deposito-meta-existente', 'vou guardar 200 na meta do notebook'],
  ] as const) {
    const r = await turnoHoje(autonomoRico(hoje), frase)
    out.push(result(id, { reply: r.reply, actions: r.actions }, 'nenhuma ação proposta', r.actions.length === 0))
  }
  for (const [id, frase, esperado] of [
    ['N-controle-paguei-fatura', 'paguei a fatura do nubank', 'card-payment:'],
    ['N-controle-guardei-meta', 'guardei 200 na meta do notebook', 'goal-deposit:200'],
    ['N-controle-paguei-e-pergunta', 'paguei 200 da fatura do inter, quanto falta?', 'card-payment:200'],
    ['N-controle-feito-e-intencao', 'paguei a fatura do nubank e vou pagar a do inter amanha', 'card-payment:'],
  ] as const) {
    const r = await turnoHoje(autonomoRico(hoje), frase)
    const atual = r.actions.map((a: any) => `${a.kind}:${a.amount ?? ''}`).join(',')
    out.push(result(id, { reply: r.reply, actions: r.actions }, esperado, atual === esperado))
  }

  // Cada item com o SEU dia, e nenhum valor some. "30 de lanche ontem e 20 de
  // padaria anteontem" punha os dois ontem; "gastei 30 ontem e 20 hoje" também;
  // "anteontem 20 de uber" sumia sem aviso ao lado de um item entendido.
  {
    const ontem = addDays(hoje, -1); const anteontem = addDays(hoje, -2)
    const datas = (r: { actions: any[] }) => r.actions.map(a => `${a.kind}:${a.amount}@${a.date || hoje}`).join(',')
    for (const [id, frase, esperado] of [
      ['O-dia-depois-de-cada-item', 'gastei 30 de lanche ontem e 20 de padaria anteontem', `expense:30@${ontem},expense:20@${anteontem}`],
      ['O-dia-depois-da-virgula', 'ontem 30 de lanche, anteontem 20 de padaria', `expense:30@${ontem},expense:20@${anteontem}`],
      ['O-valor-solto-herda-verbo', 'gastei 30 ontem e 20 hoje', `expense:30@${ontem},expense:20@${hoje}`],
      ['O-receita-solta-herda-verbo', 'recebi 1800 ontem e 1200 hoje', `income:1800@${ontem},income:1200@${hoje}`],
      ['O-dia-unico-vale-para-os-dois', 'gastei 30 de lanche e 20 de padaria ontem', `expense:30@${ontem},expense:20@${ontem}`],
      ['O-dia-no-comeco-vale-para-os-dois', 'ontem gastei 30 de lanche e 20 de padaria', `expense:30@${ontem},expense:20@${ontem}`],
    ] as const) {
      const r = await turnoHoje(buildState({ profile: 'autonomo' }), frase)
      out.push(result(id, { reply: r.reply, actions: r.actions }, esperado, datas(r) === esperado))
    }
    const sobra = await turnoHoje(buildState({ profile: 'autonomo' }), 'ontem gastei 30 de lanche e anteontem 20 de uber')
    out.push(result('O-parte-com-valor-nao-some', sobra.reply, 'propõe os 30 e diz que a parte dos 20 não foi registrada',
      sobra.actions.some((a: any) => a.amount === 30) && /N[ãa]o registrei esta parte: “anteontem 20 de uber”/.test(sobra.reply)))
  }

  // Cada "meta" no seu lugar: a de COMPRA pelo nome, a mensal de guardar e a
  // diária do motorista. "Minha meta do notebook" respondia a meta mensal;
  // "quanto falta pra meta de hoje" dizia que não havia meta de compra; "bati
  // a meta?" mostrava a composição sem dizer se bateu.
  {
    const st = autonomoRico(hoje)
    const notebook = st.goals.find(g => g.name === 'Notebook')!
    const faltaNotebook = fmtBRL(notebook.target - notebook.saved).replace(/ /g, ' ')
    for (const frase of ['quanto falta pra minha meta do notebook', 'quanto falta pra meta do notebook', 'como ta a meta do notebook']) {
      const r = await turnoHoje(st, frase)
      out.push(result(`P-meta-pelo-nome-${frase.replace(/\W+/g, '-')}`, r.reply, `Notebook, falta ${faltaNotebook}`,
        r.reply.replace(/ /g, ' ').includes(faltaNotebook) && /Notebook/.test(r.reply) && !/por m[êe]s\./.test(r.reply.split('\n')[0])))
    }
    const mesAtual = hoje.slice(0, 7)
    const guardado = st.transactions.filter(t => t.type === 'saving' && t.date.slice(0, 7) === mesAtual && t.date <= hoje)
      .reduce((a, t) => a + t.amount, 0)
    const alvoMensal = st.settings.monthlyProfitTarget
    const bati = await turnoHoje(st, 'bati a meta do mes?')
    out.push(result('P-bati-meta-do-mes', bati.reply, guardado >= alvoMensal ? 'Sim, já bateu' : 'Ainda não',
      bati.reply.startsWith(guardado >= alvoMensal ? 'Sim, já bateu' : 'Ainda não:')))
    const consigo = await turnoHoje(st, 'consigo bater a meta esse mes?')
    const falta = fmtBRL(Math.max(alvoMensal - guardado, 0)).replace(/ /g, ' ')
    out.push(result('P-consigo-bater-meta', consigo.reply, `veredito primeiro, faltam ${falta}`,
      /^(?:Sim, já bateu|Dá:|Do jeito que está, não:)/.test(consigo.reply)
        && (guardado >= alvoMensal || consigo.reply.replace(/ /g, ' ').split('\n')[0].includes(`faltam ${falta}`))))
  }
  {
    const st = motoristaRico(hoje)
    const lucroHoje = st.transactions.filter(t => t.date === hoje)
      .reduce((a, t) => a + (t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0), 0)
    const lucro = fmtBRL(Math.round(lucroHoje * 100) / 100).replace(/ /g, ' ')
    for (const frase of ['bati a meta?', 'quanto falta pra meta de hoje', 'quanto falta pra bater a meta', 'ja bati a meta de hoje?']) {
      const r = await turnoHoje(st, frase)
      out.push(result(`P-meta-do-dia-${frase.replace(/\W+/g, '-')}`, r.reply, `sim/não primeiro, com o lucro de hoje ${lucro}`,
        /^(?:Sim, bateu:|Ainda não:)/.test(r.reply) && r.reply.replace(/ /g, ' ').includes(`lucro de ${lucro}`)))
    }
    const composicao = await turnoHoje(st, 'qual minha meta')
    out.push(result('P-composicao-continua', composicao.reply, 'composição da meta diária', /Composi[çc][ãa]o/.test(composicao.reply)))
  }

  // "Por mês em média" é a média dos TOTAIS mensais, em meses fechados. Era a
  // média por lançamento agrupada por mês: R$ 1.396 para quem recebe R$ 3.000.
  {
    const st = buildState({ profile: 'autonomo', transactions: [
      { id: 'm6a', type: 'income', amount: 400, category: 'outros-in', date: '2026-06-05' },
      { id: 'm6b', type: 'income', amount: 600, category: 'outros-in', date: '2026-06-20' },
      { id: 'm7', type: 'income', amount: 2000, category: 'outros-in', date: '2026-07-10' },
      { id: 'm8a', type: 'income', amount: 1000, category: 'outros-in', date: '2026-08-03' },
      { id: 'm8b', type: 'income', amount: 2000, category: 'outros-in', date: '2026-08-25' },
      { id: 'm9', type: 'income', amount: 500, category: 'outros-in', date: '2026-09-02' },
    ] })
    const r = await turn(st, 'quanto eu ganho por mes em media')
    out.push(result('Q-media-mensal-de-totais', r.reply, 'R$ 2.000,00 = (1.000 + 2.000 + 3.000) / 3; setembro aberto fica fora',
      /^M[ée]dia por m[êe]s: R\$\s2\.000,00/.test(r.reply) && /3 meses completos/.test(r.reply) && !/por lan[çc]amento/.test(r.reply)))
    const rico = autonomoRico(hoje)
    const mesAtual = hoje.slice(0, 7)
    const inicio = (() => { const d = fromISO(hoje); return toISOdate(new Date(d.getFullYear(), d.getMonth() - 5, 1)) })()
    const porMes = new Map<string, number>()
    for (const t of rico.transactions) {
      if (t.type !== 'income' || t.date < inicio || t.date.slice(0, 7) >= mesAtual) continue
      porMes.set(t.date.slice(0, 7), (porMes.get(t.date.slice(0, 7)) || 0) + t.amount)
    }
    const chaves = [...porMes.keys()].sort()
    const meses: string[] = []
    for (let k = chaves[0]; k && k <= chaves[chaves.length - 1];) {
      meses.push(k)
      const [y, m] = k.split('-').map(Number)
      k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
    }
    const media = meses.reduce((a, k) => a + (porMes.get(k) || 0), 0) / Math.max(meses.length, 1)
    const esperado = fmtBRL(Math.round(media * 100) / 100).replace(/ /g, ' ')
    const rr = await turnoHoje(rico, 'quanto eu ganho por mes em media')
    out.push(result('Q-media-mensal-fixture', rr.reply, esperado, rr.reply.replace(/ /g, ' ').startsWith(`Média por mês: ${esperado}`)))
  }

  // Guardado ≠ saldo em conta. "Quanto eu tenho guardado" respondia o saldo,
  // "minha reserva tá em quanto" procurava despesa na categoria reserva e
  // "tirei 300 da reserva" caía na ajuda. Oráculo: soma dos `saving` e das metas.
  {
    const st = autonomoRico(hoje)
    const reserva = st.transactions.filter(t => t.type === 'saving').reduce((a, t) => a + t.amount, 0)
    const metas = st.goals.reduce((a, g) => a + g.saved, 0)
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const guardado = await turnoHoje(st, 'quanto eu tenho guardado')
    out.push(result('R-guardado-nao-e-saldo', guardado.reply, `${brl(reserva + metas)} = reserva ${brl(reserva)} + metas ${brl(metas)}`,
      limpa(guardado.reply).startsWith(`Guardado ao todo: ${brl(reserva + metas)}`) && !/saldo em conta é R\$/i.test(guardado.reply)))
    for (const frase of ['minha reserva ta em quanto', 'quanto tem na reserva']) {
      const r = await turnoHoje(st, frase)
      out.push(result(`R-reserva-${frase.replace(/\W+/g, '-')}`, r.reply, `reserva ${brl(reserva)} primeiro`,
        limpa(r.reply).startsWith(`Sua reserva tem ${brl(reserva)}`)))
    }
    const comPeriodo = await turnoHoje(st, 'quanto eu guardei esse ano')
    out.push(result('R-guardado-com-periodo-continua-consulta', comPeriodo.reply, 'consulta do ano', /neste ano/.test(comPeriodo.reply)))
    const tirei = await turnoHoje(st, 'tirei 300 da reserva')
    out.push(result('R-retirada-explicada', tirei, 'diz que retirada não existe, sem ajuda genérica e sem ação',
      /retirada da reserva/.test(tirei.reply) && !/Posso te ajudar com coisas como/.test(tirei.reply) && tirei.actions.length === 0))
  }

  // A linha do mês só diz "com a parcela" se a parcela cai nele. Sem cartão,
  // a primeira vence em 30 dias: a linha do mês corrente afirmava a parcela
  // com o saldo intacto.
  {
    const semCartao = await turnoHoje(buildState({ balance: 5000 }), 'se eu comprar um pc de 4000 em 10x')
    const linhaDoMes = (r: string, iso: string) => r.split('\n').find(l => l.startsWith(`• ${monthShortLabel(fromISO(iso))}:`)) || ''
    const r2 = (v: number) => Math.round(v * 100) / 100
    const primeira = addDays(hoje, 30)
    const mesmoMes = primeira.slice(0, 7) === hoje.slice(0, 7)
    out.push(result('M-parcela-so-no-mes-em-que-cai', semCartao.reply, `sem parcela no mês corrente; parcela em ${primeira.slice(0, 7)}`,
      (mesmoMes || !/com a parcela/.test(linhaDoMes(semCartao.reply, hoje)))
        && /com a parcela de R\$\s400,00/.test(linhaDoMes(semCartao.reply, primeira))))
    const rico = await turnoHoje(autonomoRico(hoje), 'se eu comprar um pc de 4000 em 10x')
    const meses = rico.focus?.lastScenario?.months || []
    out.push(result('M-texto-bate-com-o-saldo', meses, 'parcela citada ⇔ saldo do mês mexeu pela parcela',
      meses.length > 0 && meses.every((m, i) => {
        const caiu = r2(m.delta - (i ? meses[i - 1].delta : 0)) < 0
        const citou = /com a parcela/.test(linhaDoMes(rico.reply, `${m.monthKey}-01`))
        return !linhaDoMes(rico.reply, `${m.monthKey}-01`) || caiu === citou
      })))
  }

  // Código interno nunca chega ao usuário: "work (Trabalho)", "expense
  // (amount)", "(outros-out)", nem o id aleatório de uma categoria criada.
  const interno = /\b(?:work|expense|income|fuel|saving)\s*\(|\((?:amount|km|outros-out|alimentacao|combustivel)\)|c-uid-/i
  const kmSemPerfil = await turn(buildState({ profile: 'other' }), 'rodei 200 km hoje')
  out.push(result('I-km-fora-do-perfil', kmSemPerfil.reply, 'explica que km é do perfil motorista',
    /perfil de motorista/i.test(kmSemPerfil.reply) && !/n[ãa]o tenho certeza/i.test(kmSemPerfil.reply)
      && !interno.test(kmSemPerfil.reply) && kmSemPerfil.actions.length === 0))
  const gigante = await turn(buildState(), 'gastei 99999999999 no mercado')
  out.push(result('I-valor-fora-do-limite', gigante.reply, 'pede para conferir o valor, sem nome de campo',
    /confere o valor/i.test(gigante.reply) && !interno.test(gigante.reply) && gigante.actions.length === 0))
  const nomeDaCategoria = await turn(buildState(), 'gastei 50 no mercado')
  out.push(result('I-proposta-mostra-nome-da-categoria', nomeDaCategoria.reply, '(Alimentação), não (alimentacao)',
    /\(Alimenta[çc][ãa]o\)/.test(nomeDaCategoria.reply) && !interno.test(nomeDaCategoria.reply)))
  const personalizada = buildState()
  personalizada.categories = [...personalizada.categories,
    { id: 'c-uid-k3j9', name: 'Feirinha', type: 'expense', icon: '🏷️', custom: true }]
  personalizada.assistantPreferences = [{ id: 'pref-feira', kind: 'category-mapping', trigger: 'feira', value: 'c-uid-k3j9',
    source: 'user-explicit', createdAt: TODAY, updatedAt: TODAY }]
  const feira = await turn(personalizada, 'gastei 30 na feira')
  out.push(result('I-categoria-personalizada-pelo-nome', { reply: feira.reply, actions: feira.actions },
    'proposta com (Feirinha), nunca o id aleatório',
    feira.actions.some(a => a.kind === 'expense' && a.category === 'c-uid-k3j9')
      && /\(Feirinha\)/.test(feira.reply) && !interno.test(feira.reply)))
  // O id real vem de `uid()`, sempre com dígitos: o cadastro lia os dígitos
  // como valor financeiro e recusava "coloca em <categoria criada>".
  const comUid = buildState()
  comUid.categories = [...comUid.categories,
    { id: 'k3x9q2mvqjx0we', name: 'Feirinha', type: 'expense', icon: '🏷️', custom: true }]
  const ensina = await turn(comUid, 'feira coloca em Feirinha')
  out.push(result('I-ensinar-categoria-criada', ensina, 'propõe guardar feira → Feirinha',
    ensina.preferenceMutation?.type === 'upsert'
      && ensina.preferenceMutation.preference.value === 'k3x9q2mvqjx0we' && /Feirinha/.test(ensina.reply)))
  return out
}

/**
 * Estado com compromissos em volta de HOJE: fatura do Inter vencida há 5 dias
 * (parcela pendente de 300), Internet 100 amanhã, Aluguel 900 em 3 dias, Água
 * 50 mensal que venceu há 15 dias sem confirmação, e uma parcela do Nubank no
 * mês passado marcada como paga sem data — forma de backup antigo que deixa a
 * fatura com "pendente" no cálculo de caixa.
 */
function estadoDeCaixaFuturo(hoje: string, balance: number, profile: 'autonomo' | 'driver'): AppState {
  const s = buildState({ profile, balance })
  s.settings.balanceAsOf = `${addDays(hoje, -60)}T00:00:00`
  const vencida = addDays(hoje, -5)
  const passada = addDays(hoje, -35)
  const dia = (iso: string) => Number(iso.slice(8, 10))
  const conta = (id: string, name: string, amount: number, start: string, end?: string) => ({
    id, name, amount, frequency: 'monthly' as const, dueDay: dia(start), startDate: start,
    ...(end ? { endDate: end } : {}), category: 'casa', kind: 'expense' as const, active: true,
  })
  s.recurring = [
    conta('internet', 'Internet', 100, addDays(hoje, 1), addDays(hoje, 1)),
    conta('aluguel', 'Aluguel', 900, addDays(hoje, 3), addDays(hoje, 3)),
    conta('agua', 'Água', 50, addDays(hoje, -15)),
  ]
  s.cards = [
    { id: 'cx-card-inter', name: 'Inter', limit: 5000, closingDay: dia(vencida), dueDay: dia(vencida), createdAt: addDays(hoje, -90) },
    { id: 'cx-card-nubank', name: 'Nubank', limit: 5000, closingDay: dia(passada), dueDay: dia(passada), createdAt: addDays(hoje, -90) },
  ] as AppState['cards']
  s.installmentPlans = [
    { id: 'cx-p-inter', description: 'Celular', cardId: 'cx-card-inter', totalAmount: 300, installmentCount: 1,
      firstDueDate: vencida, purchaseDate: addDays(hoje, -40), status: 'active', operationType: 'card-purchase',
      createdAt: addDays(hoje, -40) },
    { id: 'cx-p-nubank', description: 'Fone', cardId: 'cx-card-nubank', totalAmount: 300, installmentCount: 1,
      firstDueDate: passada, purchaseDate: addDays(hoje, -70), status: 'active', operationType: 'card-purchase',
      createdAt: addDays(hoje, -70) },
  ] as AppState['installmentPlans']
  s.installments = [
    { id: 'cx-inter', planId: 'cx-p-inter', number: 1, total: 1, amount: 300, dueDate: vencida, status: 'pending' },
    { id: 'cx-nubank', planId: 'cx-p-nubank', number: 1, total: 1, amount: 300, dueDate: passada, status: 'paid' },
  ] as AppState['installments']
  return s
}

if (process.argv.includes('--probe')) {
  runAdversarialReal().then(results => {
    for (const r of results) console.log(JSON.stringify(r))
    console.log(`${results.filter(r => r.ok).length}/${results.length} adversarial`)
  }).catch(err => { console.error(err); process.exitCode = 1 })
}
