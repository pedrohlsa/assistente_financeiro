// Regressões adversariais pelo caminho que a tela usa: mensagem → orchestrate
// → resposta/proposta/foco. O oráculo financeiro é literal, não runScenario.
import type { AppState } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { segment } from '../../src/assistant/clauses'
import { findDate } from '../../src/assistant/dates'
import { balanceOutlook, balanceOutlookText, budgetUsage, cashObligationsUntil, categoryBreakdown, currentBalance, kmCost, monthlyProjections, occurrencesBetween, pendingRecurrings, periodStats, possibleRecurringTransactions, recurringLinkAction, transactionOccurrence, upcomingBills } from '../../src/services/calc'
import { buildInstallments, cardInvoice, cardOutstanding, cardsOverview, commitmentTimeline, futureInstallmentPaymentDate, futureInvoicePaymentDate, invoiceOpenAmount, planProgress } from '../../src/services/cards'
import { applyBatchPure } from '../../src/assistant/execute'
import { buildCapabilities } from '../../src/assistant/capabilities'
import { isValidationFailure, validateAction } from '../../src/assistant/contracts'
import { editableFieldsFor } from '../../src/assistant/proposalEdit'
import { validateQueryPlan } from '../../src/assistant/query/validate'
import { runQuery } from '../../src/assistant/query/engine'
import { isRevertFailure, revertBatchPure } from '../../src/assistant/journal'
import { applyPreferenceAliases } from '../../src/assistant/preferences'
import { hydrateForTest, reducer } from '../../src/store/store'
import { addDays, fmtBRL, fmtDateShort, fromISO, MESES_PT_BR, monthShortLabel, nowPaymentTime, nowStamp, todayISO, toISO as toISOdate } from '../../src/utils/format'
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

/** Controles de pagamento corrente sem dívidas antigas incoerentes do fixture rico. */
function somenteFaturasAtuais(s: AppState, hoje: string): AppState {
  const inicioMes = `${hoje.slice(0, 7)}-01`
  return { ...s, installments: s.installments.map(i => i.dueDate < inicioMes && i.status === 'pending'
    ? { ...i, status: 'paid' as const, paidAt: i.dueDate, paidAmount: i.amount, paidVia: 'direct' as const }
    : i) }
}

const result = (id: string, actual: unknown, expected: unknown, ok: boolean): AdversarialResult => ({ id, actual, expected, ok })

/**
 * O que "falta pagar em faturas" tem que dizer no fixture rico, conforme o dia
 * do mês: antes do fechamento do Nubank (dia 20) a fatura dele ainda está
 * ABERTA e sai à parte ("pode crescer até fechar"); depois, as duas fechadas
 * somam R$ 800,00. O oráculo antigo só valia do dia 20 em diante.
 */
function faturasAPagarEsperadas(rico: AppState, hoje: string): { descricao: string; confere: (r: string) => boolean } {
  const mk = hoje.slice(0, 7)
  const porCartao = rico.cards.map(c => ({ nome: c.name, inv: cardInvoice(rico, c, mk) }))
  const fechadas = porCartao.filter(x => x.inv.status !== 'aberta' && x.inv.total > 0)
  const abertas = porCartao.filter(x => x.inv.status === 'aberta' && x.inv.total > 0)
  const soma = fechadas.reduce((a, x) => a + x.inv.total, 0)
  const brl = (v: number) => fmtBRL(v).replace(/\u00a0/g, ' ')
  // A resposta também lista a próxima fatura ainda aberta de cada cartão, por
  // isso "Ainda aberta" pode aparecer mesmo com as duas do mês fechadas.
  const descricao = !fechadas.length ? 'nenhuma fatura fechada ou vencida; só abertas'
    : abertas.length ? `falta pagar ${brl(soma)} fechado; ${abertas.map(x => x.nome).join(', ')} ainda aberta à parte`
      : `falta pagar ${brl(soma)} em faturas`
  return {
    descricao,
    confere: (r: string) => (!fechadas.length
      ? /Nenhuma fatura vencida ou fechada/.test(r) && !/Falta pagar R\$/.test(r)
      : r.includes(`Falta pagar ${brl(soma)}`))
      && abertas.every(x => /Ainda abertas?/.test(r) && r.includes(x.nome)),
  }
}

export async function runAdversarialReal(): Promise<AdversarialResult[]> {
  const out: AdversarialResult[] = []

  const spokenDate = todayISO()
  const spoken = buildState({ profile: 'autonomo', balance: 1200 })
  spoken.settings.balanceAsOf = `${addDays(spokenDate, -1)}T10:00`
  let calledForNegation = 0
  const remoteSpy = async () => { calledForNegation++; return null }
  const onlyIncome = await orchestrate({ state: spoken, today: spokenDate, remoteEnabled: true,
    askRemote: remoteSpy, planRemoteQuery: remoteSpy, message: 'n gastei 37 no mercado mas receby 120 da Casa 2' })
  const ignored = await orchestrate({ state: spoken, today: spokenDate, remoteEnabled: true,
    askRemote: remoteSpy, planRemoteQuery: remoteSpy, message: 'n gsatei 37 no mercado, foi só orçamento' })
  const appliedSpoken = applyBatchPure(spoken, onlyIncome.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '15:00' } })
  out.push(result('LING-negacao-abreviada-e-erro-de-digitacao', { proposta: onlyIncome.response, negacao: ignored.response,
    chamadoRemoto: calledForNegation, saldo: currentBalance(appliedSpoken.state) },
    'a despesa negada não vira proposta; a receita de R$ 120 da Casa 2 é a única gravada, sem recorrer ao remoto',
    calledForNegation === 0 && ignored.response.actions.length === 0 && onlyIncome.response.actions.length === 1
      && appliedSpoken.applied && appliedSpoken.state.transactions.length === 1
      && appliedSpoken.state.transactions[0].type === 'income' && appliedSpoken.state.transactions[0].origin === 'Casa 2'
      && currentBalance(appliedSpoken.state) === 1320 && spoken.transactions.length === 0))

  const correctedSpoken = await orchestrate({ state: spoken, today: spokenDate, remoteEnabled: true,
    askRemote: remoteSpy, planRemoteQuery: remoteSpy,
    message: 'gastei 90 na farmácia ontem, ops, 75 na padaria anteontem e 20 de ônibus' })
  const appliedCorrection = applyBatchPure(spoken, correctedSpoken.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '15:00' } })
  out.push(result('LING-correcao-muda-valor-categoria-e-dia-sem-duplicar', { response: correctedSpoken.response,
      transactions: appliedCorrection.state.transactions },
    'corrige o gasto de R$ 90 da farmácia para R$ 75 da padaria anteontem e preserva saída independente de R$ 20',
    appliedCorrection.applied && appliedCorrection.state.transactions.length === 2 && calledForNegation === 0
      && appliedCorrection.state.transactions.some(t => t.amount === 75 && t.description === 'Padaria'
        && t.category === 'alimentacao' && t.date === addDays(spokenDate, -2))
      && appliedCorrection.state.transactions.some(t => t.amount === 20 && t.description === 'Ônibus')
      && !appliedCorrection.state.transactions.some(t => t.amount === 90)))

  const answerChoices = (out?: Awaited<ReturnType<typeof orchestrate>>) =>
    out?.response.mode === 'clarify' ? out.response.clarification : undefined
  const localSpoken = (message: string, context?: Awaited<ReturnType<typeof orchestrate>>) => orchestrate({
    state: spoken, today: spokenDate, remoteEnabled: true, askRemote: remoteSpy, planRemoteQuery: remoteSpy, message,
    pending: context?.response.actions, pendingClarification: answerChoices(context),
  })
  const twoAmounts = await localSpoken('recebi 125 do freela e gastei vinte e nove ou trinta e um no mercado')
  const stillTwo = await localSpoken('31 ou 29', twoAmounts)
  const choseAmount = await localSpoken('foi 31', twoAmounts)
  const chosenState = applyBatchPure(spoken, choseAmount.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '16:00' } })
  out.push(result('LING-escolha-curta-de-valor-preserva-receita-da-mesma-frase', { first: twoAmounts.response,
      repeated: stillTwo.response, chosen: choseAmount.response, caixa: currentBalance(chosenState.state) },
    'o gasto aguarda escolha exata; depois só R$ 31 saem do caixa e a receita independente de R$ 125 aparece uma vez',
    answerChoices(twoAmounts)?.field === 'amount-choice' && answerChoices(twoAmounts)?.options?.length === 2
      && twoAmounts.response.actions.length === 1 && twoAmounts.response.actions[0].action.kind === 'income'
      && answerChoices(stillTwo)?.field === 'amount-choice' && !!stillTwo.keepPending && !stillTwo.response.actions.length
      && chosenState.applied && currentBalance(chosenState.state) === 1294 && chosenState.state.transactions.length === 2
      && chosenState.state.transactions.some(t => t.type === 'expense' && t.amount === 31 && t.description === 'Mercado')
      && calledForNegation === 0 && spoken.transactions.length === 0))

  const days = await localSpoken('gastei 72 segunda ou terça no mercado')
  const chosenDay = await localSpoken('terça', days)
  const tuesday = addDays(spokenDate, -(((fromISO(spokenDate).getDay() + 5) % 7) || 7))
  const shortDays = await localSpoken('paguei 72 no mercado dia 3 ou 4')
  const futureDay = await localSpoken('gastei 72 no mercado ontem ou amanhã')
  const chosenFuture = await localSpoken('amanhã', futureDay)
  out.push(result('LING-dias-alternativos-nao-escolhem-dia-nem-viram-dinheiro', { first: days.response, chosen: chosenDay.response,
      shortDays: shortDays.response, choseFuture: chosenFuture.response },
    'segunda e terça ficam em aberto; dia abreviado não vira R$ 4; escolher amanhã impede uma baixa realizada',
    answerChoices(days)?.field === 'date-choice' && answerChoices(days)?.options?.length === 2 && !days.response.actions.length
      && chosenDay.response.actions.length === 1 && chosenDay.response.actions[0].action.kind === 'expense'
      && chosenDay.response.actions[0].action.amount === 72 && chosenDay.response.actions[0].action.description === 'Mercado'
      && chosenDay.response.actions[0].action.date === tuesday && answerChoices(shortDays)?.field === 'date-choice'
      && answerChoices(shortDays)?.pendingActions?.length === 1 && !shortDays.response.actions.length
      && answerChoices(futureDay)?.field === 'date-choice' && !chosenFuture.response.actions.length
      && chosenFuture.response.mode === 'clarify' && calledForNegation === 0))

  const intentAndFact = await localSpoken('queria comprar uma bota de 150 mas acabei pagando 95 por um tênis')
  const expenseConfirmed = applyBatchPure(spoken, intentAndFact.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '16:00' } })
  const formerlyPlanned = await localSpoken('eu ia pagar 80 no estacionamento mas paguei 35 na padaria')
  const abandonedPlan = await localSpoken('eu só queria comprar um notebook de 2000 mas desisti')
  const actualGoal = await localSpoken('quero comprar um notebook de 2000 em 3 meses')
  out.push(result('LING-plano-desistido-nao-vira-meta-nem-despesa', { proposed: intentAndFact.response,
      formerPlan: formerlyPlanned.response, abandoned: abandonedPlan.response, goal: actualGoal.response },
    'o gasto de R$ 95 é a única saída; a intenção antiga não cria meta, enquanto um pedido de meta atual continua funcionando',
    expenseConfirmed.applied && expenseConfirmed.state.transactions.length === 1 && currentBalance(expenseConfirmed.state) === 1105
      && expenseConfirmed.state.transactions[0].description === 'Tênis' && expenseConfirmed.state.goals.length === 0
      && formerlyPlanned.response.actions.length === 1 && formerlyPlanned.response.actions[0].action.kind === 'expense'
      && formerlyPlanned.response.actions[0].action.amount === 35 && !abandonedPlan.response.actions.length
      && actualGoal.response.actions.length === 1 && actualGoal.response.actions[0].action.kind === 'goal'
      && actualGoal.response.actions[0].action.name === 'Notebook' && actualGoal.response.actions[0].action.target === 2000))

  const exact = await localSpoken('acabei de receber 130 da Casa 2 e paguei precisamente R$ 37,50 de mercado hj')
  const almost = await localSpoken('quase gastei 80 no Pix mas gastei 35 no mercado')
  out.push(result('LING-conclusao-e-enfase-preservam-os-valores-e-o-origem', { exact: exact.response, almost: almost.response },
    'recebimento concluído guarda R$ 130 da Casa 2; centavos e local do gasto exato permanecem; o quase gasto fica fora',
    exact.response.actions.length === 2 && exact.response.actions.some(({ action: a }) => a.kind === 'income' && a.amount === 130 && a.origin === 'Casa 2')
      && exact.response.actions.some(({ action: a }) => a.kind === 'expense' && a.amount === 37.5 && a.description === 'Mercado' && a.date === spokenDate)
      && almost.response.actions.length === 1 && almost.response.actions[0].action.kind === 'expense'
      && almost.response.actions[0].action.amount === 35 && calledForNegation === 0))

  const amountMissing = await localSpoken('ganhei 100 e pouco do freela mas gastei exatamente 37 no mercado')
  const stillRough = await localSpoken('mais ou menos 105', amountMissing)
  const completed = await localSpoken('105,50', amountMissing)
  const exactApplied = applyBatchPure(spoken, completed.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '16:30' } })
  const yesterdayPartial = await localSpoken('paguei 50 e uns quebrados na padaria ontem')
  const resolvedYesterday = await localSpoken('foi 51,30', yesterdayPartial)
  out.push(result('LING-centavos-incertos-aguardam-resposta-exata-sem-perder-contexto', { first: amountMissing.response,
    rough: stillRough.response, completed: completed.response, dated: resolvedYesterday.response },
    'R$ 100 e pouco aguarda resposta, mas R$ 37 já foram compreendidos; centavos informados preservam tipo, descrição e dia',
    answerChoices(amountMissing)?.field === 'exact-amount' && amountMissing.response.actions.length === 1
      && amountMissing.response.actions[0].action.kind === 'expense' && amountMissing.response.actions[0].action.amount === 37
      && answerChoices(stillRough)?.field === 'exact-amount' && !!stillRough.keepPending && !stillRough.response.actions.length
      && exactApplied.applied && exactApplied.state.transactions.length === 2 && currentBalance(exactApplied.state) === 1268.5
      && exactApplied.state.transactions.some(t => t.amount === 105.5 && t.category === 'freelance')
      && resolvedYesterday.response.actions.length === 1 && resolvedYesterday.response.actions[0].action.kind === 'expense'
      && resolvedYesterday.response.actions[0].action.amount === 51.3 && resolvedYesterday.response.actions[0].action.description === 'Padaria'
      && resolvedYesterday.response.actions[0].action.date === addDays(spokenDate, -1) && calledForNegation === 0))

  const friday = addDays(spokenDate, -((fromISO(spokenDate).getDay() + 2) % 7))
  const recentMonday = addDays(friday, -4)
  const recentTuesday = addDays(friday, -3)
  const weekdayState = buildState({ profile: 'autonomo', transactions: [
    { type: 'expense', category: 'alimentacao', description: 'Padaria', date: recentMonday, amount: 25 },
    { type: 'expense', category: 'alimentacao', description: 'Padaria', date: recentTuesday, amount: 35 },
    { type: 'expense', category: 'alimentacao', description: 'Mercado', date: recentTuesday, amount: 137 },
    { type: 'expense', category: 'casa', description: 'Água', date: recentMonday, amount: 62 },
    { type: 'expense', category: 'obra', description: 'Tinta', date: addDays(friday, -1), amount: 999 },
  ] })
  const weekdayQuery = (message: string, prior?: Awaited<ReturnType<typeof orchestrate>>) => orchestrate({
    state: weekdayState, today: friday, remoteEnabled: true, askRemote: remoteSpy, planRemoteQuery: remoteSpy, message,
    pending: prior?.response.actions, pendingClarification: answerChoices(prior),
  })
  const mondayTotal = await weekdayQuery('quanto gastei na segunda?')
  const compareWeekdays = await weekdayQuery('quanto gastei segunda versus terça?')
  const dayRange = await weekdayQuery('quanto gastei na padaria entre segunda e terça?')
  out.push(result('LING-consulta-dias-da-semana-filtra-e-compara-datas-exatas', { monday: mondayTotal.response,
    compare: compareWeekdays.response, range: dayRange.response },
    'segunda soma R$ 87, terça R$ 172 e a padaria soma R$ 60 no intervalo, sem misturar a obra',
    mondayTotal.focus?.lastQuery?.total === 87 && mondayTotal.focus.lastQueryPlan?.period.from === recentMonday
      && compareWeekdays.focus?.lastQueryPlan?.comparePeriod?.from === recentTuesday
      && /87,00/.test(compareWeekdays.response.reply) && /172,00/.test(compareWeekdays.response.reply)
      && dayRange.focus?.lastQuery?.total === 60 && dayRange.focus.lastQueryPlan?.period.from === recentMonday
      && dayRange.focus.lastQueryPlan.period.to === recentTuesday && !dayRange.response.actions.length))

  const queryAlternatives = await weekdayQuery('qnt gastei na padaria seg ou ter?')
  const chooseTuesday = await weekdayQuery('ter', queryAlternatives)
  const queryExclusion = await weekdayQuery('quanto gastei segunda ou terça mas sem mercado?')
  const excludingMarket = await weekdayQuery('terça', queryExclusion)
  const mixedQuery = await weekdayQuery('paguei 50 no posto e quanto gastei na padaria segunda ou terça?')
  const chooseMonday = await weekdayQuery('segunda', mixedQuery)
  out.push(result('LING-consulta-com-ou-guarda-dia-filtro-e-proposta-independente', { choices: queryAlternatives.response,
    chosen: chooseTuesday.response, exclusion: excludingMarket.response, mixed: mixedQuery.response },
    'só responde após escolher; preserva padaria, exclusão e a proposta em paralelo, sem gravar movimentações',
    answerChoices(queryAlternatives)?.field === 'query-date' && answerChoices(queryAlternatives)?.options?.length === 2
      && !queryAlternatives.response.actions.length && chooseTuesday.focus?.lastQuery?.total === 35
      && chooseTuesday.focus.lastQueryPlan?.period.from === recentTuesday && !chooseTuesday.response.actions.length
      && excludingMarket.focus?.lastQuery?.total === 35 && answerChoices(mixedQuery)?.field === 'query-date'
      && mixedQuery.response.actions.length === 1 && chooseMonday.keepPending && chooseMonday.focus?.lastQuery?.total === 25
      && !chooseMonday.response.actions.length && calledForNegation === 0 && weekdayState.transactions.length === 5))

  const mixedState = buildState({ profile: 'autonomo', balance: 1000, transactions: [
    { type: 'expense', category: 'casa', description: 'Água', amount: 100, date: spokenDate },
    { type: 'expense', category: 'alimentacao', description: 'Padaria', amount: 50, date: spokenDate },
  ] })
  mixedState.settings.balanceAsOf = `${addDays(spokenDate, -1)}T10:00`
  const mixedPrompt = await orchestrate({ state: mixedState, today: spokenDate, remoteEnabled: true,
    askRemote: remoteSpy, planRemoteQuery: remoteSpy, message: 'me lembra quanto eu gastei este mês e anota que paguei 25 na padaria' })
  const mixedApplied = applyBatchPure(mixedState, mixedPrompt.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: spokenDate, time: '16:00' } })
  const separateDate = await weekdayQuery('quanto gastei na padaria dia 03 ou dia 04? e anota 50 de gasto de ônibus')
  const separateApplied = applyBatchPure(weekdayState, separateDate.response.actions.map(({ id, action }) => ({ id, action })),
    { now: { date: friday, time: '16:00' } })
  out.push(result('LING-pergunta-e-comando-independentes-na-mesma-mensagem', { proposal: mixedPrompt.response,
    cash: currentBalance(mixedApplied.state), alternateDate: separateDate.response },
    'consulta mensal inclui todas as categorias, e a data de uma pergunta não muda a do novo lançamento',
    mixedPrompt.response.actions.length === 1 && mixedPrompt.response.actions[0].action.kind === 'expense'
      && mixedPrompt.response.actions[0].action.amount === 25 && mixedPrompt.response.actions[0].action.description === 'Padaria'
      && /175,00/.test(mixedPrompt.response.reply) && /Se você confirmar/.test(mixedPrompt.response.reply)
      && mixedApplied.applied && currentBalance(mixedApplied.state) === 825 && mixedState.transactions.length === 2
      && answerChoices(separateDate)?.field === 'query-date' && separateApplied.applied
      && separateApplied.state.transactions.some(t => t.description === 'Ônibus' && t.amount === 50 && t.date === friday)
      && calledForNegation === 0))

  const twoDaysTotal = await weekdayQuery('quanto gastei segunda e quinta?')
  const twoDaysSeparately = await weekdayQuery('quanto gastei segunda e terça separadamente?')
  out.push(result('LING-consulta-de-dois-dias-nao-inclui-os-dias-do-meio', { total: twoDaysTotal.response, separately: twoDaysSeparately.response },
    'segunda e quinta somam R$ 1.086 sem trazer terça; separadamente devolve R$ 87 e R$ 172 sem somá-los',
    /87,00/.test(twoDaysTotal.response.reply) && /999,00/.test(twoDaysTotal.response.reply)
      && /Total dos dois dias:.*1\.086,00/.test(twoDaysTotal.response.reply) && !/172,00/.test(twoDaysTotal.response.reply)
      && /87,00/.test(twoDaysSeparately.response.reply) && /172,00/.test(twoDaysSeparately.response.reply)
      && !/259,00/.test(twoDaysSeparately.response.reply) && !twoDaysSeparately.response.actions.length && calledForNegation === 0))

  const threeDays = await weekdayQuery('quanto gastei na segunda, terça e quinta?')
  const countDays = await weekdayQuery('quantos lançamentos fiz na segunda e quinta?')
  const dateListState = buildState({ profile: 'other', transactions: [
    { type: 'expense', amount: 30, category: 'alimentacao', date: '2026-11-10' },
    { type: 'expense', amount: 240, category: 'alimentacao', date: '2026-11-12' },
    { type: 'expense', amount: 42.50, category: 'alimentacao', date: '2026-11-15' },
  ] })
  const shorthandDays = await orchestrate({ state: dateListState, message: 'quanto gastei dia 10 e 15', today: '2026-11-20',
    remoteEnabled: true, askRemote: remoteSpy, planRemoteQuery: remoteSpy })
  out.push(result('LING-lista-de-dias-trata-numero-como-data-e-conta-registros', { threeDays: threeDays.response,
    count: countDays.response, shorthand: shorthandDays.response },
    'três dias somam R$ 1.258, dois dias têm três registros e dia 10 e 15 soma R$ 72,50 sem propor R$ 15',
    /Total dos 3 dias:.*1\.258,00/.test(threeDays.response.reply)
      && /Total dos dois dias: 3 lançamentos/.test(countDays.response.reply)
      && /Total dos dois dias:.*72,50/.test(shorthandDays.response.reply) && !/240,00/.test(shorthandDays.response.reply)
      && ![threeDays, countDays, shorthandDays].some(r => r.response.actions.length) && calledForNegation === 0))

  const rangeState = buildState({ profile: 'other', transactions: [
    { type: 'expense', description: 'Padaria', amount: 35, category: 'alimentacao', date: '2026-11-16' },
    { type: 'expense', description: 'Padaria', amount: 48, category: 'alimentacao', date: '2026-11-17' },
    { type: 'expense', description: 'Mercado', amount: 250, category: 'alimentacao', date: '2026-11-16' },
    { type: 'expense', description: 'Padaria', amount: 12, category: 'alimentacao', date: '2026-11-09' },
    { type: 'expense', description: 'Padaria', amount: 17, category: 'alimentacao', date: '2026-11-12' },
  ] })
  const rangeQuery = (message: string, prior?: Awaited<ReturnType<typeof orchestrate>>) => orchestrate({
    state: rangeState, today: '2026-11-17', message, pendingClarification: answerChoices(prior),
    remoteEnabled: true, askRemote: remoteSpy, planRemoteQuery: remoteSpy,
  })
  const currentRange = await rangeQuery('quanto gastei na padaria entre segunda e terça?')
  const priorWeek = await rangeQuery('quanto gastei na segunda e quinta da semana passada?')
  const futureRange = await rangeQuery('quanto gastei na padaria de segunda até sexta dessa semana?')
  const narrowedRange = await rangeQuery('até ontem', futureRange)
  const backwardsRange = await rangeQuery('quanto gastei entre 15/11 e 10/11?')
  out.push(result('LING-intervalo-com-duas-datas-ancora-semana-e-recupera-filtro', { current: currentRange.response,
    prior: priorWeek.response, future: futureRange.response, narrowed: narrowedRange.response, backwards: backwardsRange.response },
    'segunda a terça soma R$ 83 na terça; a semana passada soma R$ 29; até ontem recupera só a padaria; datas invertidas pedem confirmação',
    currentRange.focus?.lastQuery?.total === 83 && currentRange.focus.lastQueryPlan?.period.to === '2026-11-17'
      && /Total dos dois dias:.*29,00/.test(priorWeek.response.reply)
      && answerChoices(futureRange)?.field === 'query-range-end' && narrowedRange.focus?.lastQuery?.total === 35
      && narrowedRange.focus.lastQueryPlan?.period.from === '2026-11-16'
      && narrowedRange.focus.lastQueryPlan?.period.to === '2026-11-16'
      && backwardsRange.response.mode === 'clarify' && calledForNegation === 0
      && ![currentRange, priorWeek, futureRange, narrowedRange, backwardsRange].some(r => r.response.actions.length)))

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
  const rideDriver = buildState({ profile: 'driver' })
  const ride = (message: string, prior?: Awaited<ReturnType<typeof orchestrate>>) => orchestrate({ state: rideDriver, message,
    today: TODAY, remoteEnabled: false, pendingClarification: answerChoices(prior) })
  const withDistance = await ride('tocou corrida de 12 km por 70')
  const onlyDistance = await ride('tocou corrida de 8 km e 40 minutos')
  const uncertainFare = await ride('tocou corrida de 70 ou 80')
  const exactFare = await ride('recebi 77,25 ontem', uncertainFare)
  const acceptedFare = await ride('sim', withDistance)
  const declinedOffers = await Promise.all(['tocou corrida de 70 mas recusei', 'tocou corrida de 70, mas n aceitei',
    'não tocou corrida de 70'].map(message => ride(message)))
  out.push(result('H7-medida-na-corrida-oferecida-nao-vira-dinheiro', { price: withDistance.response, onlyDistance: onlyDistance.response,
    uncertain: uncertainFare.response, actualFare: exactFare.response, declined: declinedOffers.map(r => r.response) },
    'o preço é R$ 70, quilômetros e duração não viram receita, preço alternativo pede o valor e recusa encerra a oferta',
    /R\$\s70,00/.test(withDistance.response.reply) && !/R\$\s12,00/.test(withDistance.response.reply)
      && answerChoices(onlyDistance)?.options?.length === 0 && answerChoices(uncertainFare)?.options?.length === 0
      && exactFare.response.actions.map(a => a.action).some(a => a.kind === 'income' && a.amount === 77.25 && a.date === addDays(TODAY, -1))
      && acceptedFare.response.actions.length === 2 && acceptedFare.response.actions.map(a => a.action).some(a => a.kind === 'work' && a.trips === 1 && !a.km)
      && declinedOffers.every(r => r.response.mode !== 'clarify' && !r.response.actions.length)))
  const refundFirst = await orchestrate({ state: buildState(), message: 'Recebi 70, mas devolvi 20', today: TODAY, remoteEnabled: false })
  const refundYes = await orchestrate({ state: buildState(), message: 'sim', today: TODAY, remoteEnabled: false,
    pending: refundFirst.response.actions,
    pendingClarification: refundFirst.response.mode === 'clarify' ? refundFirst.response.clarification : undefined })
  out.push(result('H9-devolucao-continuacao', refundYes.response, 'sim mantém receita R$ 70 e propõe saída R$ 20',
    refundYes.response.mode === 'propose_actions'
      && refundYes.response.actions.some(a => a.action.kind === 'income' && a.action.amount === 70)
      && refundYes.response.actions.some(a => a.action.kind === 'expense' && a.action.amount === 20)))
  const refundState = buildState({ profile: 'driver', cards: [{ name: 'Inter' }], balance: 1000 })
  refundState.settings.balanceAsOf = addDays(TODAY, -3)
  const refundTurn = (message: string) => turn(refundState, message)
  const cashReturn = await refundTurn('a Uber me devolveu 20 no Pix ontem')
  const purchaseRefund = await refundTurn('paguei 30 no mercado e a loja devolveu 10 pra mim')
  const purchaseApplied = applyBatchPure(refundState, purchaseRefund.actions.map((a, i) => ({ id: `refund-${i}`, action: a })), { now: { date: TODAY, time: '12:00' } })
  const cardRefunds = await Promise.all(['o cartão estornou 120', 'estornaram 100 na fatura do Inter', 'me reembolsaram 35 no cartão'].map(refundTurn))
  const ambiguousRefunds = await Promise.all(['a loja devolveu 20', 'a loja disse que me devolveu 20', 'o banco não me devolveu 20'].map(refundTurn))
  out.push(result('H9-devolucao-confere-o-destinatario-e-o-caixa', { cash: cashReturn.actions, split: purchaseRefund.actions,
    card: cardRefunds, uncertain: ambiguousRefunds },
    'reembolso recebido entra no caixa sem viagem; reembolso de fatura e destinatário incerto não geram lançamento',
    cashReturn.actions.length === 1 && cashReturn.actions.some(a => a.kind === 'income' && a.category === 'outros-in' && a.amount === 20 && a.date === addDays(TODAY, -1))
      && purchaseApplied.applied && purchaseApplied.state.transactions.length === 2 && currentBalance(purchaseApplied.state, TODAY) === 980
      && cardRefunds.every(r => !r.actions.length && /crédito na fatura/.test(r.reply))
      && ambiguousRefunds.every(r => !r.actions.length)))
  {
    const perfil = buildState({ profile: 'driver', balance: 900 })
    perfil.settings.balanceAsOf = addDays(TODAY, -2)
    let chamadasRemotas = 0
    const falar = (message: string, pending?: Awaited<ReturnType<typeof orchestrate>>['response']) => orchestrate({
      state: perfil, message, today: TODAY, remoteEnabled: true,
      askRemote: async () => { chamadasRemotas++; return null },
      pending: pending?.actions,
      pendingClarification: pending?.mode === 'clarify' ? pending.clarification : undefined,
    })
    const consultas = await Promise.all([
      'Ontem recebi 500 da Uber, mas 100 eram reembolso',
      'Ontem recebi 500 da Uber, sendo 100 de reembolso',
      'Ontem recebi 500, 100 foi reembolso',
      'Ontem recebi 500, dos quais 100 eram reembolso',
    ].map(mensagem => falar(mensagem)))
    const aceito = await falar('sim', consultas[0].response)
    const propostas = aceito.response.actions.map(a => a.action)
    const aplicado = applyBatchPure(perfil, aceito.response.actions, { now: { date: TODAY, time: '12:00' } })
    out.push(result('RE-parcial-confirmado-soma-o-caixa-uma-vez', { consultas: consultas.map(r => r.response.reply), propostas },
      '500 recebidos ontem, em 400 de receita e 100 de reembolso, sem viagem e sem chamada remota',
      chamadasRemotas === 0 && consultas.every(r => r.response.mode === 'clarify' && r.response.actions.length === 0
        && /R\$\s500,00.*R\$\s400,00.*R\$\s100,00/.test(r.response.reply))
      && aceito.response.mode === 'propose_actions' && propostas.length === 2 && perfil.transactions.length === 0
      && propostas.some(a => a.kind === 'income' && a.amount === 400 && a.description === 'Uber' && a.date === addDays(TODAY, -1))
      && propostas.some(a => a.kind === 'income' && a.amount === 100 && a.category === 'outros-in' && a.date === addDays(TODAY, -1))
      && aplicado.applied && aplicado.state.transactions.length === 2 && currentBalance(aplicado.state, TODAY) === 1400))

    const misto = await falar('Recebi 500, dos quais 100 eram reembolso, gastei 36 no mercado e fiz 3 viagens')
    const negado = await falar('não', misto.response)
    const comMisto = await falar('sim', misto.response)
    out.push(result('RE-preserva-gasto-e-viagens-ditas', { misto: misto.response, negado: negado.response, aceito: comMisto.response.actions },
      'pendência conserva mercado de 36 e 3 viagens, e a aceitação acrescenta só as duas entradas',
      misto.response.mode === 'clarify' && misto.response.actions.length === 2
      && misto.response.actions.some(a => a.action.kind === 'expense' && a.action.amount === 36)
      && misto.response.actions.some(a => a.action.kind === 'work' && a.action.trips === 3)
      && comMisto.response.actions.length === 4 && negado.keepPending && negado.response.actions.length === 0))

    const incertos = await Promise.all([
      'Recebi 500, mas 600 eram reembolso', 'Recebi 500, mas -100 eram reembolso',
      `Recebi 500 em ${addDays(TODAY, 7).split('-').reverse().join('/')}, sendo 100 de reembolso`,
      'Recebi 500, sendo 100 de reembolso, na verdade foram 120 de reembolso',
      'Recebi 500 hoje, sendo 100 de reembolso ontem',
      'Recebi 500 da Uber e 350 da 99, sendo 100 de reembolso',
      'Recebi 500, mas 100 eram reembolso pendente',
    ].map(mensagem => falar(mensagem)))
    const integral = await falar('Recebi 500, sendo 500 de reembolso')
    const aceitaIntegral = await falar('sim', integral.response)
    out.push(result('RE-valores-e-data-tem-que-ser-compativeis', { incertos: incertos.map(r => r.response), integral: aceitaIntegral.response },
      'reembolso maior ou negativo e data futura seguram o registro; se todo o valor é reembolso, gera uma entrada de 500',
      incertos.every(r => r.response.mode === 'clarify' && !r.response.actions.length && !r.response.clarification.options.length)
      && aceitaIntegral.response.actions.length === 1
      && aceitaIntegral.response.actions.some(a => a.action.kind === 'income' && a.action.amount === 500 && a.action.category === 'outros-in')))

    const avulsos = await Promise.all([
      'Me reembolsaram 100 do pneu', 'Reembolso de 100 caiu na conta', 'Recebi hoje 100 de reembolso',
      'O reembolso de 100 do pneu caiu na conta',
    ].map(mensagem => falar(mensagem)))
    const salario = await falar('Recebi 500 de salário e mais 100 de reembolso')
    const doisRecebimentos = await falar('Recebi 500 e recebi mais 100 de reembolso')
    const acoesDoisRecebimentos = doisRecebimentos.response.actions.map(a => a.action)
    const naoEntra = await falar('Não me reembolsaram 100 do pneu')
    out.push(result('RE-avulso-entra-em-outros', { avulsos: avulsos.map(r => r.response.actions), salario: salario.response.actions, doisRecebimentos: doisRecebimentos.response.actions },
      'reembolso é entrada em Outros; salário e outros recebimentos adicionais mantêm o próprio valor',
      avulsos.every(r => r.response.actions.length === 1 && r.response.actions.some(a => a.action.kind === 'income'
        && a.action.category === 'outros-in' && a.action.amount === 100 && a.action.description?.startsWith('Reembolso')))
      && salario.response.actions.length === 2 && salario.response.actions.some(a => a.action.kind === 'income' && a.action.category === 'salario' && a.action.amount === 500)
      && salario.response.actions.some(a => a.action.kind === 'income' && a.action.category === 'outros-in' && a.action.amount === 100)
      && acoesDoisRecebimentos.some(a => a.kind === 'income' && a.category === 'outros-in' && a.amount === 100)
      && acoesDoisRecebimentos.every(a => a.kind !== 'work' || a.trips === 1)
      && !naoEntra.response.actions.length))

    const naoRecebidos = await Promise.all([
      'Pedi reembolso de 100 do pneu', 'Se me reembolsarem 100 do pneu, quanto sobra?',
      'Me reembolsaram 100 do pneu, mas ainda não caiu na conta', 'Reembolso de 100 ainda não caiu na conta',
      'O reembolso de 100 do pneu caiu na conta?',
    ].map(mensagem => falar(mensagem)))
    const pergunta = await falar('Recebi R$ 1.200,50, sendo R$ 120,25 de reembolso. Qual é meu saldo?')
    const centavos = await falar('sim', pergunta.response)
    out.push(result('RE-hipotese-e-pergunta-preservam-confirmacao', { naoRecebidos: naoRecebidos.map(r => r.response), pergunta: pergunta.response },
      'pedido e hipótese não geram ação, e a pergunta de saldo mantém a escolha com os dois valores exatos',
      naoRecebidos.every(r => !r.response.actions.length && /O reembolso já entrou/.test(r.response.reply))
      && pergunta.response.mode === 'clarify' && pergunta.response.actions.length === 0
      && /R\$\s1\.080,25.*R\$\s120,25/.test(pergunta.response.reply)
      && centavos.response.actions.map(a => a.action).filter(a => a.kind === 'income').reduce((soma, a) => soma + a.amount, 0) === 1200.5))
  }
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
  const motivoComparacao = await turn(q, 'por quê?', qWorse.focus)
  const valorAtual = qLast.focus?.lastQuery?.total
  const valorAnterior = qLast.focus?.previousQuery?.total
  const valoresNoMotivo = valorAtual !== undefined && valorAnterior !== undefined
    && motivoComparacao.reply.includes(fmtBRL(valorAtual)) && motivoComparacao.reply.includes(fmtBRL(valorAnterior))
    && motivoComparacao.reply.includes(fmtBRL(Math.abs(valorAtual - valorAnterior)))
  out.push(result('PQ-explica-os-dois-periodos-comparados', motivoComparacao.reply,
    'o porquê explica os dois totais e a diferença no mesmo recorte',
    valoresNoMotivo && /no mesmo recorte/i.test(motivoComparacao.reply) && motivoComparacao.actions.length === 0))

  out.push(result('Q-pior-mes', qWorse, 'agosto R$ 500 foi pior que setembro R$ 100 em gastos',
    /agosto(?: de \d{4})? foi pior[^\n]*R\$\s*500,00[^\n]*R\$\s*100,00[^\n]*setembro/i
      .test(qWorse.reply.replace(/\u00a0/g, ' '))
      && !/500,00[^\n]*a menos/i.test(qWorse.reply)))
  const qVazio = await turn(q, 'e em janeiro de 2024?', qLast.focus)
  const semComparacao = await turn(q, 'qual foi melhor?', qVazio.focus)
  out.push(result('Q-pior-melhor-sem-base-nao-escolhe', semComparacao.reply, 'período vazio não vira vencedor com gasto zero',
    /não consigo comparar|não há lançamentos/i.test(semComparacao.reply) && !/foi melhor|empataram/i.test(semComparacao.reply)))

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
  for (const [id, answerText, amount, date] of [
    ['A-pix-assim', 'não, assim que receber eu mando', null, null],
    ['A-pix-valor', 'sim mas mandei só 10', 10, undefined],
    ['A-pix-data', 'sim, ontem', 15, addDays(TODAY, -1)],
    ['A-pix-n-curto', 'ñ', null, null],
    ['A-pix-sem-prova', 'sim?', null, null],
    ['A-pix-negacao-final', 'sim, mas não mandei', null, null],
    ['A-pix-reformulacao', 'não foi 15, mandei 9', 9, undefined],
  ] as const) {
    const answer = await orchestrate({ state: buildState(), message: answerText, today: TODAY,
      remoteEnabled: false,
      pendingClarification: pixClarify.mode === 'clarify' ? pixClarify.clarification : undefined })
    const [action] = answer.response.actions.map(item => item.action)
    out.push(result(id, answer.response, 'usa o valor e a data afirmados e espera quando o envio não foi confirmado', amount === null
      ? answer.response.actions.length === 0
      : answer.response.actions.length === 1 && action?.kind === 'expense' && action.amount === amount && action.date === date))
  }
  const semValorPix = await orchestrate({ state: buildState(), message: 'me pediram um Pix dia 10', today: TODAY, remoteEnabled: false })
  const pixAlternativo = await orchestrate({ state: buildState(), message: 'mandei 10 e 5 centavos amanhã', today: TODAY, remoteEnabled: false,
    pendingClarification: answerChoices(semValorPix) })
  const pixDiaCerto = await orchestrate({ state: buildState(), message: 'foi ontem', today: TODAY, remoteEnabled: false,
    pendingClarification: answerChoices(pixAlternativo) })
  const [pixCerto] = pixDiaCerto.response.actions.map(item => item.action)
  out.push(result('A-pix-dia-do-pedido-nao-vira-valor-e-data-corrigida', { original: semValorPix.response, future: pixAlternativo.response, final: pixDiaCerto.response },
    'pedido sem valor abre pergunta; corrige data futura e mantém os R$ 10,05 enviados',
    answerChoices(semValorPix)?.options?.length === 0 && !/10,00/.test(semValorPix.response.reply)
      && answerChoices(pixAlternativo)?.field === 'date' && !pixAlternativo.response.actions.length
      && pixCerto?.kind === 'expense' && pixCerto.amount === 10.05 && pixCerto.date === addDays(TODAY, -1)))
  const pixSameTurn = await Promise.all([
    'minha filha pediu um Pix de 200 e eu mandei 35',
    'me pediu Pix de R$ 25 e acabei enviando 20',
    'ontem me pediu um Pix de 150 mas mandei só 36 hoje',
  ].map(message => turn(buildState({ profile: 'driver' }), message)))
  const pixDenied = await Promise.all([
    'pediu Pix de 20 e eu não mandei', 'pediu Pix de 20 mas ainda não enviei', 'não mandei Pix de 30',
  ].map(message => turn(buildState({ profile: 'driver' }), message)))
  const sentPrint = await turn(buildState({ profile: 'driver' }), 'pediu Pix de 25 e mandei o print de 20')
  out.push(result('A-pix-pedido-envio-e-negacao-no-mesmo-relato', { sent: pixSameTurn, denied: pixDenied, sentPrint },
    'só o valor enviado entra na proposta, e enviar print ou negar envio não vira transferência',
    pixSameTurn.every((r, index) => r.mode === 'propose_actions' && r.actions.length === 1
      && r.actions.some(a => a.kind === 'expense' && a.amount === [35, 20, 36][index] && a.description === 'Pix enviado'))
      && pixSameTurn[2].actions.some(a => a.kind === 'expense' && a.date === TODAY)
      && pixDenied.every(r => !r.actions.length && r.mode !== 'clarify')
      && sentPrint.mode === 'clarify' && !sentPrint.actions.length))
  const pixDriver = buildState({ profile: 'driver' })
  const pixBank = (message: string, prior?: Awaited<ReturnType<typeof orchestrate>>) => orchestrate({ state: pixDriver,
    today: TODAY, remoteEnabled: false, message, pendingClarification: answerChoices(prior) })
  const receivedPix = await pixBank('recebi Pix de 99 de João ontem')
  const thirdPersonPix = await pixBank('me enviaram Pix de 16,25')
  const incompletePix = await pixBank('recebi Pix de 70 e pouco ontem')
  const chosenPix = await pixBank('foi 74,50', incompletePix)
  const internalPix = await Promise.all([
    'fiz um Pix de 40 entre minhas contas',
    'transferi 40 da minha conta do Inter pra minha conta do Nubank',
  ].map(message => pixBank(message)))
  out.push(result('A-pix-entrada-sem-inventar-corrida-e-transferencia-propria', { received: receivedPix.response, thirdPerson: thirdPersonPix.response,
    incomplete: incompletePix.response, exact: chosenPix.response, internal: internalPix.map(r => r.response) },
    'Pix recebido é entrada com a origem dita, números e valores incertos não criam viagem, e transferência própria não é despesa',
    receivedPix.response.actions.length === 1 && receivedPix.response.actions.map(a => a.action).some(a => a.kind === 'income'
      && a.amount === 99 && a.category === 'outros-in' && a.origin === 'João' && a.date === addDays(TODAY, -1))
      && thirdPersonPix.response.actions.length === 1 && thirdPersonPix.response.actions.map(a => a.action).some(a => a.kind === 'income' && a.amount === 16.25)
      && !incompletePix.response.actions.length && answerChoices(incompletePix)?.field === 'exact-amount'
      && chosenPix.response.actions.length === 1 && chosenPix.response.actions.map(a => a.action).some(a => a.kind === 'income' && a.amount === 74.50 && a.date === addDays(TODAY, -1))
      && internalPix.every(r => !r.response.actions.length && /contas próprias/.test(r.response.reply))))
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
  const ambiguousHome = balanceOutlook(conflictingLegacy, 7, TODAY)
  out.push(result('HOME-legado-nao-afirma-cobertura', ambiguousHome, 'sem veredito de cobertura nem promessa de sobra para saldo ambíguo',
    ambiguousHome.ok === undefined && /concilia/.test(balanceOutlookText(ambiguousHome))
      && !/sobra|cobre esse total/.test(balanceOutlookText(ambiguousHome))))
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
    const r = await turnoHoje(st, frase)
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
    const dia5 = await turnoHoje(st, 'quanto devo deixar reservado até o dia 5')
    const alvo5 = (() => {
      const d = Number(hoje.slice(8, 10))
      const [y, m] = hoje.split('-').map(Number)
      return d <= 5 ? `${hoje.slice(0, 8)}05` : `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-05`
    })()
    const semDia = await turnoHoje(st, 'quanto preciso deixar parado pras contas')
    const dia32 = await turnoHoje(st, 'quanto preciso reservar ate dia 32')
    const meta = await turnoHoje({ ...st, goals: [{ id: 'g-viagem', name: 'Viagem', target: 6000, saved: 4800, createdAt: hoje }] },
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
      const r = await turnoHoje(st, frase)
      out.push(result(`F-aperto-${frase.split(' ')[1]}-${frase.split(' ').slice(-1)[0]}`, r.reply,
        'atrasada primeiro; maior Aluguel 900; próxima Internet 100; cobre R$ 1.350',
        r.actions.length === 0
          && /^O que mais aperta é o que já venceu: Fatura Inter, R\$\s300,00/.test(r.reply)
          && /a maior é Aluguel: R\$\s900,00/.test(r.reply)
          && /A próxima a vencer é Internet: R\$\s100,00/.test(r.reply)
          && /cobre os R\$\s1\.350,00/.test(r.reply) && !/Nubank/.test(r.reply)
          && /sem confirma[çc][ãa]o/.test(r.reply) && !deslocada.test(r.reply)))
    }
    const curto = await turnoHoje(estadoDeCaixaFuturo(hoje, 500, 'autonomo'), 'qual conta ta me apertando')
    out.push(result('F-aperto-saldo-nao-cobre', curto.reply, 'saldo 500 não cobre 1.350: faltam 850',
      /n[ãa]o cobre os R\$\s1\.350,00/.test(curto.reply) && /faltam R\$\s850,00/.test(curto.reply)))
    const empate = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    empate.recurring = empate.recurring.map(r => r.id === 'aluguel' ? { ...r, amount: 100 } : r)
    const empatou = await turnoHoje(empate, 'qual conta pesa mais')
    out.push(result('F-aperto-empate-dito', empatou.reply, 'Internet e Aluguel empatam em R$ 100',
      /empatam/.test(empatou.reply) && /Internet/.test(empatou.reply) && /Aluguel/.test(empatou.reply)
      && !/a maior é/i.test(empatou.reply)))
    const ambiguo = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    ambiguo.installments = ambiguo.installments.map(i => i.id === 'cx-inter' ? { ...i, status: 'paid' as const,
      paidAt: addDays(hoje, -5), paidAmount: 300, paidVia: 'direct' as const } : i)
    ambiguo.cardPayments = [{ id: 'cx-dup', cardId: 'cx-card-inter', amount: 300, paymentDate: addDays(hoje, -4),
      paymentTime: '10:00:00', referenceMonth: addDays(hoje, -5).slice(0, 7), fromBalance: true }]
    const reservaAmbigua = await turnoHoje(ambiguo, `quanto preciso deixar parado ate dia ${Number(alvo.slice(8, 10))}`)
    const apertoAmbiguo = await turnoHoje(ambiguo, 'qual conta ta me apertando')
    out.push(result('F-caixa-futuro-saldo-legado-ambiguo', { reservaAmbigua: reservaAmbigua.reply, apertoAmbiguo: apertoAmbiguo.reply },
      'reserva recusa o número; aperto não afirma cobertura pelo saldo',
      /n[ãa]o consigo confirmar seu saldo/i.test(reservaAmbigua.reply) && !/deixe pelo menos/.test(reservaAmbigua.reply)
        && /n[ãa]o consigo confirmar seu saldo/i.test(apertoAmbiguo.reply) && !/cobre os/.test(apertoAmbiguo.reply)))

    // As três respostas de vencimento usam as MESMAS fontes e o prazo dito.
    // "O que vence" e "contas cobrem" olhavam só conta fixa, 15 dias fixos,
    // e contradiziam a reserva no mesmo aparelho.
    const n = Number(alvo.slice(8, 10))
    const estado = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const vence = await turnoHoje(estado, `quais contas vencem ate dia ${n}`)
    const cobre = await turnoHoje(estado, `minhas contas cobrem ate dia ${n}?`)
    const reserva = await turnoHoje(estado, `quanto preciso deixar parado ate dia ${n}`)
    const totalDe = (s: string) => (s.match(/R\$\s([\d.]+,\d{2})/) || [])[1]
    out.push(result('F-vencimentos-coerentes', { vence: vence.reply, cobre: cobre.reply, reserva: reserva.reply },
      'R$ 1.300,00 nas três, com a fatura atrasada e sem a Água sem confirmação',
      totalDe(vence.reply) === '1.300,00' && /cobre os R\$\s1\.300,00/.test(cobre.reply)
        && /deixe pelo menos R\$\s1\.300,00/.test(reserva.reply)
        && [vence, cobre].every(r => /Fatura Inter/.test(r.reply) && /sem confirma[çc][ãa]o — [ÁA]gua/.test(r.reply))
        && cobre.reply.startsWith('Sim.') && /sobram R\$\s700,00/.test(cobre.reply)))
    const curtoCobre = await turnoHoje(estadoDeCaixaFuturo(hoje, 500, 'autonomo'), `minhas contas cobrem ate dia ${n}?`)
    out.push(result('F-cobre-nao', curtoCobre.reply, 'Não; faltam R$ 800',
      curtoCobre.reply.startsWith('Não.') && /faltam R\$\s800,00/.test(curtoCobre.reply)))
    const semana = await turnoHoje(estado, 'o que vence essa semana')
    out.push(result('F-vence-essa-semana', semana.reply, `até ${dd(addDays(hoje, 7))}, R$ 1.300`,
      semana.reply.startsWith(`Vence até ${dd(addDays(hoje, 7))}: R$`) && /1\.300,00/.test(semana.reply)))
    const temConta = await turnoHoje(estado, 'tem conta vencendo?')
    out.push(result('F-tem-conta-sim', temConta.reply, 'começa com Sim.', temConta.reply.startsWith('Sim.')))
    const saldo = await turnoHoje(estado, 'qual meu saldo')
    out.push(result('F-saldo-cobre-as-mesmas-obrigacoes', saldo.reply, 'R$ 2.000 cobre R$ 1.300 (fatura atrasada incluída) e sobram R$ 700',
      /cobre os R\$\s1\.300,00/i.test(saldo.reply) && /sobram R\$\s700,00/.test(saldo.reply)))
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
    const temHoje = st.transactions.some(t => t.date === hoje)
    const temOntem = st.transactions.some(t => t.date === ontem)
    out.push(result('H-como-foi-hoje-ontem', hojeOntem.reply, temHoje ? 'resultado de hoje contra o de ontem' : 'sem lançamento hoje: diz isso, sem número',
      temHoje
        ? /^Resultado hoje/.test(limpa(hojeOntem.reply)) && limpa(hojeOntem.reply).includes(brl(soma(hoje, hoje)))
          && (temOntem ? limpa(hojeOntem.reply).includes(brl(soma(ontem, ontem))) : /Ontem não há lançamentos/.test(hojeOntem.reply))
        : /hoje/.test(hojeOntem.reply) && !/R\$/.test(hojeOntem.reply)))
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
    // No último dia do mês o mês principal está completo, e o comparável é o
    // mês anterior INTEIRO (`previousPeriod`), não o mesmo pedaço.
    const ultimoDiaDoMes = new Date(y, m, 0).getDate()
    const diaCorte = dia === ultimoDiaDoMes ? 31 : dia
    const fimAnt = `${inicioAnt.slice(0, 8)}${String(Math.min(diaCorte, new Date(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 0).getDate())).padStart(2, '0')}`
    const kmEntre = (from: string, to: string) => st.workSessions.filter(w => w.date >= from && w.date <= to).reduce((a, w) => a + w.km, 0)
    const porKm = (from: string, to: string) => soma(from, to, 'expense') / Math.max(kmEntre(from, to), 1)
    const custoKm = await turnoHoje(st, 'meu custo por km piorou?')
    const c2 = (v: number) => Math.round(v * 100) / 100
    const igualKm = c2(porKm(inicioMes, hoje)) === c2(porKm(inicioAnt, fimAnt))
    const subiuKm = c2(porKm(inicioMes, hoje)) > c2(porKm(inicioAnt, fimAnt))
    const leadKm = igualKm ? 'Não, ficou igual.' : subiuKm ? 'Sim, piorou.' : 'Não, melhorou.'
    const semKm = kmEntre(inicioMes, hoje) <= 0 || kmEntre(inicioAnt, fimAnt) <= 0
    const semGastoComparavel = !st.transactions.some(t => t.type === 'expense' && t.date >= inicioAnt && t.date <= fimAnt)
    out.push(result('J-sim-nao-custo-por-km', custoKm.reply, semKm || semGastoComparavel ? 'diz o que falta sem dar veredito' : leadKm,
      semKm || semGastoComparavel
        ? /Não tenho quilometragem|não há lançamentos para comparar/.test(custoKm.reply) && !/^(?:Sim|Não,)/.test(custoKm.reply)
        : limpa(custoKm.reply).startsWith(leadKm)))
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
    // Dia 1º sem gasto ainda: não há ranking possível, e o app diz que não há
    // base (regra 43) em vez de coroar uma categoria com R$ 0,00.
    const semGastoNoMes = agora.size === 0
    const semBase = (r: string) => /Não tenho nenhum lançamento/.test(r) && !/foi o que mais/.test(r)
    for (const frase of ['tem alguma coisa q eu to gastando mt mais q antes?', 'qual despesa esta mais fora do meu padrao', 'o que aumentou mais esse mes']) {
      const r = await turnoHoje(st, frase)
      const depois = r.reply.split('Depois:')[1] || ''
      out.push(result(`K-subiu-${frase.split(' ').slice(2, 4).join('-')}`, r.reply,
        semGastoNoMes ? 'mês sem gasto: sem ranking, diz que não há base' : `${subiu.nome} foi o que mais subiu; lista só com altas`,
        semGastoNoMes ? semBase(r.reply) && r.actions.length === 0
          : subiu.d > 0 && r.reply.includes(`${subiu.nome} foi o que mais subiu comparado com`) && !/−R\$/.test(depois)
            && !/padrao|padrão/i.test(r.reply) && (!/^tem/.test(frase) || r.reply.startsWith('Sim.'))))
    }
    const r = await turnoHoje(st, 'qual categoria caiu mais')
    const esperadaQueda = semGastoNoMes ? 'mês sem gasto: sem ranking'
      : caiu.d < 0 ? `${caiu.nome} foi o que mais caiu; lista só com quedas` : 'nenhuma categoria caiu'
    out.push(result('K-caiu-lista-so-quedas', r.reply, esperadaQueda,
      semGastoNoMes ? semBase(r.reply)
        : caiu.d < 0 ? r.reply.includes(`${caiu.nome} foi o que mais caiu comparado com`) && !/\+R\$/.test(r.reply.split('Depois:')[1] || '')
          : /^Nada caiu/.test(r.reply)))
    const totalAgora = [...agora.values()].reduce((a, v) => a + v, 0)
    const totalAntes = [...antes.values()].reduce((a, v) => a + v, 0)
    const normal = await turnoHoje(st, 'gastei fora do normal esse mes?')
    const leadGasto = totalAgora === totalAntes ? 'Não, ficou igual.' : totalAgora > totalAntes ? 'Sim, subiu.' : 'Não, caiu.'
    out.push(result('K-fora-do-normal-sim-ou-nao', normal.reply,
      semGastoNoMes || !antes.size ? 'período sem lançamentos comparáveis, sem veredito' : leadGasto,
      semGastoNoMes ? semBase(normal.reply) : !antes.size
        ? /não há lançamentos para comparar/.test(normal.reply) && !/^(?:Sim|Não,)/.test(normal.reply)
        : normal.reply.startsWith(leadGasto)))
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
    const r = await turnoHoje(somenteFaturasAtuais(autonomoRico(hoje), hoje), frase)
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
    const atual = buildState({ profile: 'autonomo', transactions: [
      { id: 'm-atual', type: 'income', amount: 610, category: 'outros-in', date: hoje },
    ] })
    const semBase = await turnoHoje(atual, 'quanto eu ganho por mes em media')
    out.push(result('Q-media-mensal-sem-mes-completo', semBase.reply, 'avisa que ainda não há mês completo',
      /não há um mês completo/i.test(semBase.reply) && !/R\$\s610,00/.test(semBase.reply)))
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

  // "Quanto falta pagar DA FATURA": o pendente da fatura, não a dívida
  // parcelada do cartão. Oráculos à mão: Inter 300 vencida (dívida 900),
  // Nubank 250 fechada a vencer (dívida 750), C6 200 paga pela fatura.
  {
    const st = estadoDeFaturas(hoje)
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const data = (iso: string) => fromISO(iso).toLocaleDateString('pt-BR')
    const casos: [string, string, string, (r: string) => boolean][] = [
      ['S-falta-fatura-inter', 'quanto falta pagar da fatura do inter', `${brl(300)} vencida em ${data(addDays(hoje, -5))}, nunca ${brl(900)}`,
        r => r.includes(brl(300)) && r.includes(data(addDays(hoje, -5))) && /atrasad|venceu/.test(r) && !r.includes(brl(900))],
      ['S-falta-fatura-nubank', 'quanto falta da fatura do nubank', `${brl(250)} até ${data(addDays(hoje, 3))}, nunca ${brl(750)}`,
        r => r.includes(brl(250)) && r.includes(data(addDays(hoje, 3))) && !r.includes(brl(750))],
      ['S-ja-paguei-nubank', 'ja paguei a fatura do nubank?', `Não; falta ${brl(250)}`,
        r => /^Não\b/.test(r) && r.includes(brl(250)) && !/Inter/.test(r)],
      ['S-c6-paga', 'a fatura do c6 ta paga?', 'Sim, paga', r => /^Sim\b/.test(r) && /paga/.test(r)],
      ['S-inter-atrasada', 'a fatura do inter ta atrasada?', `Sim; ${brl(300)}`, r => /^Sim\b/.test(r) && r.includes(brl(300))],
      ['S-nubank-nao-atrasada', 'a fatura do nubank ta atrasada?', 'Não, vence depois', r => /^Não\b/.test(r) && r.includes(data(addDays(hoje, 3)))],
      ['S-vencimento-nubank', 'quando vence a fatura do nubank', `vence ${data(addDays(hoje, 3))}`,
        r => r.includes(data(addDays(hoje, 3))) && r.includes(brl(250)) && !/Inter|C6/.test(r)],
      ['S-tem-atrasada', 'tenho fatura atrasada?', `Sim: Inter ${brl(300)}`,
        r => /^Sim\b/.test(r) && /Inter/.test(r) && r.includes(brl(300)) && !/Nubank|C6/.test(r)],
      ['S-falta-todas', 'quanto falta pagar das faturas', `${brl(550)} somando Inter e Nubank, nunca a dívida ${brl(2050)}`,
        r => r.includes(brl(550)) && !r.includes(brl(2050))],
      ['S-fechamento', 'a fatura do nubank fecha quando', 'diz o dia de fechamento',
        r => new RegExp(`fecha\\w*\\b[^.]*\\bdia ${st.cards.find(c => c.name === 'Nubank')!.closingDay}\\b`).test(r)],
      ['S-cartao-inexistente', 'quanto falta da fatura do itau', 'não há cartão Itaú; nenhum valor',
        r => /n[ãa]o (?:encontrei|tenho|achei)[^.]*cart[ãa]o/i.test(r) && !/R\$/.test(r)],
      // A fatura de AGORA, não a do mês do calendário: a do C6 que venceu está
      // paga, e "quanto vem" quer a próxima.
      ['S-valor-nubank-fechada', 'quanto ta a fatura do nubank', `${brl(250)}, fechada, vence ${data(addDays(hoje, 3))}, sem "previsão"`,
        r => r.includes(brl(250)) && /fech/.test(r) && r.includes(data(addDays(hoje, 3))) && !/previs/i.test(r)],
      ['S-valor-c6-proxima', 'quanto vem a fatura do c6', `próxima, aberta, ${brl(200)}`,
        r => r.includes(brl(200)) && /aberta/.test(r) && !r.includes(data(addDays(hoje, -2))) && !/Nubank|Inter/.test(r)],
      ['S-ja-fechou', 'a fatura do nubank ja fechou?', `Sim, fechou em ${data(addDays(hoje, -2))}`,
        r => /^Sim\b/.test(r) && r.includes(data(addDays(hoje, -2)))],
      ['S-atrasada-primeiro', 'quanto falta pagar das faturas', 'Inter (atrasada) antes do Nubank',
        r => r.indexOf('Inter') >= 0 && r.indexOf('Inter') < r.indexOf('Nubank')],
    ]
    for (const [id, frase, esperado, ok] of casos) {
      const r = await turnoHoje(st, frase)
      out.push(result(id, r.reply, esperado, ok(limpa(r.reply)) && r.actions.length === 0))
    }
    const vencimento = addDays(hoje, 3).slice(0, 7).split('-').reverse().join('/')
    const paguei = await turnoHoje(st, `paguei a fatura do nubank de ${vencimento}`)
    out.push(result('S-afirmacao-ainda-registra', paguei.actions, 'pagamento de fatura do Nubank proposto',
      paguei.actions.some(a => a.kind === 'card-payment' && /nubank/i.test(a.cardName || ''))))
  }

  // A pergunta chega SEM acento ao roteador; o nome cadastrado tem acento.
  // "Quanto gastei de alimentação" respondia R$ 0,00 "dado real", e "quanto
  // falta pra câmera" respondia a primeira meta da lista.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const alimentacao = Math.round(rico.transactions.filter(x => x.type === 'expense' && x.category === 'alimentacao'
      && x.date >= `${hoje.slice(0, 8)}01` && x.date <= hoje).reduce((a, x) => a + x.amount, 0) * 100) / 100
    for (const frase of ['quanto gastei de alimentacao esse mes?', 'quanto gastei com alimentação esse mês?']) {
      const r = await turnoHoje(rico, frase)
      out.push(result(`U-categoria-${frase.includes('ç') ? 'com' : 'sem'}-acento`, r.reply, `${brl(alimentacao)} em Alimentação`,
        alimentacao > 0 && limpa(r.reply).includes(brl(alimentacao)) && !limpa(r.reply).includes(brl(0))))
    }
    const comida = await turnoHoje(rico, 'quanto gastei com comida esse mes?')
    out.push(result('U-sinonimo-nao-vira-zero', comida.reply, `${brl(alimentacao)}, nunca ${brl(0)} "dado real"`,
      limpa(comida.reply).includes(brl(alimentacao)) && !limpa(comida.reply).includes(brl(0))))
    const bar = Math.round(rico.transactions.filter(x => x.type === 'expense' && x.description === 'Bar'
      && x.date >= `${hoje.slice(0, 8)}01` && x.date <= hoje).reduce((a, x) => a + x.amount, 0) * 100) / 100
    const oBar = await turnoHoje(rico, 'quanto gastei com o bar esse mes')
    out.push(result('U-artigo-fora-do-nome', oBar.reply, `${brl(bar)} no Bar`,
      bar > 0 && limpa(oBar.reply).includes(brl(bar))))
    const metas = buildState({ profile: 'autonomo', balance: 1000,
      goals: [{ name: 'Notebook', target: 4000, saved: 1200 }, { name: 'Câmera', target: 3000, saved: 500 }] })
    for (const frase of ['quanto falta pra camera', 'quanto falta pra câmera']) {
      const r = await turnoHoje(metas, frase)
      out.push(result(`U-meta-${frase.includes('â') ? 'com' : 'sem'}-acento`, r.reply, `Câmera: faltam ${brl(2500)}`,
        /C[âa]mera/.test(r.reply) && limpa(r.reply).includes(brl(2500)) && !/Notebook/.test(r.reply)))
    }
  }

  // Pôr dinheiro NA META pelo nome dela: "coloquei 300 na viagem" virava
  // despesa de R$ 300 (Outros) e "juntei mais 100 pra viagem" virava receita
  // de corrida para um autônomo. Gastar na viagem continua sendo gasto.
  {
    const rico = autonomoRico(hoje)
    const deposito = (nome: string, valor: number) => (acts: any[]) => acts.length === 1
      && acts[0].kind === 'goal-deposit' && acts[0].name === nome && acts[0].amount === valor
    const casos: [string, AppState, string, string, (acts: any[]) => boolean][] = [
      ['V-coloquei-na-meta', rico, 'coloquei 300 na viagem', 'depósito de 300 na meta Viagem', deposito('Viagem', 300)],
      ['V-botei-no-notebook', rico, 'botei 200 no notebook', 'depósito de 200 na meta Notebook', deposito('Notebook', 200)],
      ['V-juntei-mais', rico, 'juntei mais 100 pra viagem', 'depósito de 100 na meta Viagem, sem receita', deposito('Viagem', 100)],
      ['V-juntei', rico, 'juntei 100 pra viagem', 'depósito de 100 na meta Viagem', deposito('Viagem', 100)],
      ['V-gastei-na-viagem-e-gasto', rico, 'gastei 300 na viagem', 'despesa de 300, não depósito',
        acts => acts.length === 1 && acts[0].kind === 'expense' && acts[0].amount === 300],
      ['V-gasolina-na-moto-e-gasto', buildState({ profile: 'autonomo', balance: 500, goals: [{ name: 'Moto', target: 9000, saved: 1000 }] }),
        'coloquei 50 de gasolina na moto', 'gasto de combustível, não depósito na meta Moto',
        acts => acts.length === 1 && acts[0].kind !== 'goal-deposit' && acts[0].amount === 50],
      ['V-sem-meta-nao-inventa', buildState({ profile: 'autonomo', balance: 500 }), 'coloquei 300 na viagem', 'sem meta, sem depósito',
        acts => !acts.some(a => a.kind === 'goal-deposit')],
    ]
    for (const [id, st, frase, esperado, ok] of casos) {
      const r = await turnoHoje(st, frase)
      out.push(result(id, r.actions, esperado, ok(r.actions)))
    }

    // Palavra de tempo depois do valor não é nome de meta: "guardei 500 essa
    // semana" perguntava "não encontrei a meta Essa semana".
    for (const [frase, valor] of [['guardei 500 essa semana', 500], ['guardei 200 esse mes', 200], ['guardei 100 hoje cedo', 100],
      ['guardei 200 de novo', 200], ['guardei 150 de manha', 150]] as [string, number][]) {
      const r = await turnoHoje(rico, frase)
      out.push(result(`W-${frase.replace(/\W+/g, '-')}`, { reply: r.reply, actions: r.actions }, `reserva de ${valor}, sem perguntar meta`,
        r.actions.length === 1 && r.actions[0].kind === 'saving' && r.actions[0].amount === valor && !/n[ãa]o encontrei a meta/i.test(r.reply)))
    }
    const comMeta = await turnoHoje(rico, 'guardei 300 pra viagem essa semana')
    out.push(result('W-meta-antes-do-tempo', comMeta.actions, 'depósito de 300 na Viagem', deposito('Viagem', 300)(comMeta.actions)))
  }

  // Registra E pergunta (regra 27): as duas metades têm resposta, e o número
  // que conta com o registro ainda não confirmado é marcado como hipotético.
  // Antes: "quanto sobrou" virava "se você confirmar, saem R$ 50", "quanto
  // falta?" depois de um depósito sumia, e "qual meu saldo" mostrava o saldo
  // já descontado como se fosse o real.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const doMes = (tipo: string, cat?: string) => Math.round(rico.transactions.filter(x => x.type === tipo
      && (!cat || x.category === cat) && x.date >= `${hoje.slice(0, 8)}01` && x.date <= hoje).reduce((a, x) => a + x.amount, 0) * 100) / 100
    const marcado = (r: string) => /se voc[êe] confirmar/i.test(r) && !/dados? reais?|dado real/i.test(r)
    const registrou = (acts: any[], kind: string, valor: number) => acts.some(a => a.kind === kind && a.amount === valor)
    const casos: [string, string, string, (r: string, acts: any[]) => boolean][] = [
      ['X-sobrou-respondido', 'gastei 50 no mercado, quanto sobrou esse mes?', `sobra ${brl(doMes('income') - doMes('expense') - 50)}, marcada`,
        (r, a) => r.includes(brl(doMes('income') - doMes('expense') - 50)) && marcado(r) && registrou(a, 'expense', 50)],
      ['X-categoria-com-registro', 'gastei 50 no mercado, quanto gastei de alimentacao esse mes?', `${brl(doMes('expense', 'alimentacao') + 50)}, marcado`,
        (r, a) => r.includes(brl(doMes('expense', 'alimentacao') + 50)) && marcado(r) && registrou(a, 'expense', 50)],
      ['X-saldo-marcado', 'gastei 50 no mercado, qual meu saldo?', 'saldo com o registro marcado como hipotético',
        (r, a) => marcado(r) && registrou(a, 'expense', 50)],
      ['X-falta-meta', 'guardei 200 na meta notebook, quanto falta?', `Notebook: faltam ${brl(2600)}, marcado`,
        (r, a) => /Notebook/.test(r) && r.includes(brl(2600)) && marcado(r) && registrou(a, 'goal-deposit', 200)],
      ['X-falta-fatura', 'paguei 200 da fatura do inter, quanto falta?', `falta ${brl(200)} da fatura do Inter, marcado`,
        (r, a) => /Pendente nas faturas do Inter.*R\$\s200,00/.test(r) && marcado(r) && registrou(a, 'card-payment', 200)],
      ['X-nao-afetada-sem-marca', 'gastei 50 no mercado, quando vence a fatura do nubank?', 'vencimento sem marca de hipótese',
        (r, a) => /vence/.test(r) && !/se voc[êe] confirmar/i.test(r.split('Confirmar')[0].replace(/Se você confirmar, saem[^.]*\./, '')) && registrou(a, 'expense', 50)],
    ]
    for (const [id, frase, esperado, ok] of casos) {
      const r = await turnoHoje(id === 'X-falta-fatura' ? somenteFaturasAtuais(rico, hoje) : rico, frase)
      out.push(result(id, { reply: r.reply, actions: r.actions }, esperado, ok(limpa(r.reply), r.actions)))
    }
  }
  // O NOME da categoria escolhe a categoria: "gastei 50 de lazer" ia para
  // Outros com Lazer cadastrada, e a categoria que o usuário criou ("Pet",
  // "Saúde") nunca era achada pelo nome.
  {
    const st = buildState({ profile: 'autonomo', balance: 1000 })
    st.categories = [...st.categories,
      { id: 'k3x9pet', name: 'Pet', type: 'expense', icon: '🐶', custom: true },
      { id: 'k7saude', name: 'Saúde', type: 'expense', icon: '💊', custom: true }] as AppState['categories']
    for (const [frase, cat] of [['gastei 50 de lazer', 'lazer'], ['gastei 50 de alimentacao', 'alimentacao'],
      ['gastei 50 de compras', 'compras'], ['gastei 50 de casa', 'casa'], ['gastei 50 de pet', 'k3x9pet'],
      ['gastei 50 com saude', 'k7saude'], ['gastei 50 no bar', 'lazer'], ['gastei 50 de areia', 'obra']] as [string, string][]) {
      const r = await turnoHoje(st, frase)
      out.push(result(`Z-${frase.replace(/\W+/g, '-')}`, r.actions, `categoria ${cat}`,
        r.actions.length === 1 && r.actions[0].kind === 'expense' && r.actions[0].category === cat))
    }
  }

  // "Quanto falta pagar esse mês" é o que AINDA vence no mês, não a dívida
  // parcelada inteira: a consulta respondia R$ 1.500 de parcelamentos, ou
  // "parcelamentos com 'conta esse'", por cima do roteador que sabia.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const st = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const sofa = addDays(hoje, 40)
    st.installmentPlans = [...st.installmentPlans, { id: 'ct-sofa', description: 'Sofá', totalAmount: 1200, installmentCount: 6,
      firstDueDate: sofa, purchaseDate: hoje, status: 'active', operationType: 'card-purchase', createdAt: hoje }] as AppState['installmentPlans']
    st.installments = [...st.installments, ...[0, 1, 2, 3, 4, 5].map(n => ({ id: `ct-sofa-${n + 1}`, planId: 'ct-sofa', number: n + 1, total: 6,
      amount: 200, dueDate: addDays(sofa, 30 * n), status: 'pending' }))] as AppState['installments']
    const fimDoMes = toISOdate(new Date(fromISO(hoje).getFullYear(), fromISO(hoje).getMonth() + 1, 0))
    // Literal: Inter 300 vencida há 5 dias, Internet 100 amanhã, Aluguel 900 em 3 dias; Água 50 sem confirmação à parte.
    // A Água (dia de hoje−15, mensal) volta a vencer dentro do mês em parte do
    // calendário — aí ela entra no "falta pagar" como qualquer conta do mês.
    const agua = st.recurring.find(r => r.id === 'agua')!
    const aguaNoMes = occurrencesBetween(agua, addDays(hoje, 1), fimDoMes, hoje).length * 50
    const esperado = [[-5, 300], [1, 100], [3, 900]].filter(([d]) => addDays(hoje, d) <= fimDoMes).reduce((a, [, v]) => a + v, 0) + aguaNoMes
    for (const frase of ['quanto falta pagar esse mes', 'quanto falta de conta esse mes?', 'quanto ainda tenho de conta pra pagar esse mes']) {
      const r = await turnoHoje(st, frase)
      const texto = limpa(r.reply)
      out.push(result(`CT-${frase.replace(/\W+/g, '-')}`, r.reply, `${brl(esperado)} até ${fimDoMes}, nunca a dívida ${brl(1500)}`,
        texto.includes(brl(esperado)) && !texto.includes(brl(1500)) && !/parcelamentos? em aberto|conta esse/.test(texto)))
    }
  }

  // Situação de UMA conta fixa pelo nome: "já paguei a luz?" e "a água tá
  // paga?" caíam na ajuda genérica; "quanto é a internet" dizia que não havia
  // lançamento; "quando vence a água" devolvia a lista de tudo que vence.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const data = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
    const st = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const luz = addDays(hoje, -20)
    st.recurring = [...st.recurring, { id: 'luz', name: 'Luz', amount: 150, frequency: 'monthly', dueDay: Number(luz.slice(8, 10)),
      startDate: luz, category: 'casa', kind: 'expense', active: true,
      occurrences: [{ date: luz, status: 'confirmed', txId: 'luz-paga', amount: 150 }] }] as AppState['recurring']
    st.transactions = [...st.transactions, { id: 'luz-paga', type: 'expense', amount: 150, category: 'casa', date: luz,
      description: 'Luz', recurringId: 'luz', occurrenceDate: luz, time: '10:00' }] as AppState['transactions']
    const agua = addDays(hoje, -15)
    const casos: [string, string, string, (r: string) => boolean][] = [
      ['CF-luz-paga', 'ja paguei a luz?', `Sim, ${brl(150)} de ${data(luz)}`, r => /^Sim\b/.test(r) && r.includes(brl(150)) && r.includes(data(luz))],
      ['CF-agua-nao-confirmada', 'a agua ta paga?', `Não confirmada: ${brl(50)} de ${data(agua)}`,
        r => /^Não\b/.test(r) && r.includes(brl(50)) && r.includes(data(agua))],
      ['CF-vencimento-agua', 'quando vence a agua', `todo dia ${Number(agua.slice(8, 10))}, só a Água`,
        r => new RegExp(`dia ${Number(agua.slice(8, 10))}\\b`).test(r) && !/Internet|Aluguel|Fatura/.test(r)],
      ['CF-valor-internet', 'quanto e a internet', `${brl(100)}, vence ${data(addDays(hoje, 1))}`,
        r => r.includes(brl(100)) && r.includes(data(addDays(hoje, 1))) && !/nenhum lan[çc]amento/i.test(r)],
    ]
    for (const [id, frase, esperado, ok] of casos) {
      const r = await turnoHoje(st, frase)
      out.push(result(id, r.reply, esperado, ok(limpa(r.reply)) && r.actions.length === 0))
    }
    // Conta fixa em aberto: a proposta é a CONFIRMAÇÃO da ocorrência (com a
    // chave recurringId + vencimento), nunca uma despesa avulsa que duplicaria a Home.
    const agua50 = await turnoHoje(st, 'paguei a agua de 50')
    out.push(result('CF-avulsa-vira-confirmacao', agua50, `confirmação da Água de ${data(agua)} com R$ 50, sem despesa avulsa`,
      agua50.actions.length === 1 && agua50.actions[0].kind === 'recurring-confirm' && agua50.actions[0].amount === 50
        && agua50.actions[0].occurrenceDate === agua && /conta fixa/i.test(agua50.reply) && agua50.reply.includes(data(agua))))
    const mercado = await turnoHoje(st, 'paguei 50 no mercado')
    out.push(result('CF-sem-conta-fixa-sem-aviso', mercado.reply, 'sem aviso de conta fixa', !/conta fixa/i.test(mercado.reply)))
    const luzPaga = await turnoHoje(st, `paguei 150 da luz, vencimento ${data(luz)}`)
    out.push(result('CF-conta-confirmada-sem-duplicar', luzPaga, 'Luz já confirmada: sem nova proposta',
      luzPaga.actions.length === 0 && /já encontrei um registro/i.test(luzPaga.reply)))
  }

  // "Quanto PRECISO guardar por mês" é plano, não histórico: "pro notebook"
  // respondia "O menor foi jul/2026, com R$ 2.800,00"; "pra viagem até
  // dezembro" era recusado; "consigo completar a viagem até dezembro?" caía na
  // ajuda; "quanto preciso guardar por mês" devolvia o que já foi guardado.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const h = fromISO(hoje)
    const ultimoDia = new Date(h.getFullYear(), h.getMonth() + 1, 0).getDate()
    // Depósitos até dezembro: o mês corrente conta se ainda tem 7 dias ou mais.
    const depositos = Math.max(11 - h.getMonth() + (ultimoDia - h.getDate() + 1 >= 7 ? 1 : 0), 1)
    const porMes = (v: number) => Math.ceil((v / depositos) * 100) / 100
    // Sobra média dos 3 meses completos anteriores, entradas menos saídas.
    const sobra = [1, 2, 3].map(n => {
      const ini = toISOdate(new Date(h.getFullYear(), h.getMonth() - n, 1))
      const fim = toISOdate(new Date(h.getFullYear(), h.getMonth() - n + 1, 0))
      const doMes = rico.transactions.filter(x => x.date >= ini && x.date <= fim)
      return doMes.filter(x => x.type === 'income').reduce((a, x) => a + x.amount, 0) - doMes.filter(x => x.type === 'expense').reduce((a, x) => a + x.amount, 0)
    }).reduce((a, v) => a + v, 0) / 3
    const casos: [string, string, string, (r: string) => boolean][] = [
      ['MP-viagem-ate-dezembro', 'quanto eu preciso guardar por mes pra completar a viagem ate dezembro', `${brl(porMes(1200))} por mês em ${depositos} depósitos`,
        r => r.includes(brl(porMes(1200))) && r.includes(brl(1200)) && new RegExp(`\\b${depositos} dep[óo]sitos?`).test(r)],
      ['MP-notebook-sem-prazo', 'quanto preciso guardar por mes pro notebook', `faltam ${brl(2800)}, sem prazo: pergunta até quando`,
        r => r.includes(brl(2800)) && /prazo/.test(r) && /at[ée] quando/i.test(r) && !/menor foi/i.test(r)],
      ['MP-consigo-viagem', 'consigo completar a viagem ate dezembro?', `${porMes(1200) <= sobra ? 'Sim' : 'Não'}: ${brl(porMes(1200))}/mês contra sobra média`,
        r => new RegExp(`^${porMes(1200) <= sobra ? 'Sim' : 'Não'}\\b`).test(r) && r.includes(brl(porMes(1200))) && /estimativa/i.test(r)],
      ['MP-valor-ate-dezembro', 'quanto preciso guardar por mes pra ter 10 mil ate dezembro', `${brl(porMes(10000))} por mês`,
        r => r.includes(brl(porMes(10000))) && r.includes(brl(10000))],
      ['MP-meta-mensal', 'quanto preciso guardar por mes', `meta de ${brl(800)} por mês, não o histórico`,
        r => r.includes(brl(800)) && !/Total guardado/i.test(r)],
    ]
    for (const [id, frase, esperado, ok] of casos) {
      const r = await turnoHoje(rico, frase)
      out.push(result(id, r.reply, esperado, ok(limpa(r.reply)) && r.actions.length === 0))
    }
  }

  // Soma agrupada por tempo: "Total recebido - Aluguéis por mês: R$ 18.000,00"
  // lia como 18 mil POR MÊS (são 3 mil, em 6 meses), e "E mais 1 item" cortava
  // justamente o mês atual.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const aluguel = await turnoHoje(rico, 'quanto recebi por mes de aluguel')
    const texto = limpa(aluguel.reply)
    const mesAtual = monthShortLabel(fromISO(hoje))
    out.push(result('GT-soma-nao-e-por-mes', aluguel.reply, 'R$ 18.000,00 só como soma dos 6 meses; média R$ 3.000,00; mês atual listado',
      !/por m[êe]s: R\$ 18\.000,00/.test(texto) && /Soma dos 6 meses: R\$ 18\.000,00/.test(texto)
        && /m[ée]dia de R\$ 3\.000,00 por m[êe]s/.test(texto) && texto.includes(`• ${mesAtual}`)))
    const semana = await turnoHoje(rico, 'quanto gastei por semana esse mes')
    // "Esse mês" por semana: a primeira semana começa antes do dia 1º e só conta
    // dali em diante — a linha precisa dizer isso.
    const comecaNoDomingo = fromISO(`${hoje.slice(0, 8)}01`).getDay() === 0
    out.push(result('GT-semana-parcial-marcada', semana.reply, 'primeira semana marcada "desde 01/mm"; soma no fim',
      (comecaNoDomingo || new RegExp(`\\((?:desde|só) 01/${hoje.slice(5, 7)}\\)`).test(semana.reply)) && /(?:Soma das \d+ semanas|Total da semana)/.test(limpa(semana.reply))))
  }

  // "Em cada mês" e "mês por mês" pedem a lista por mês — respondiam só o mês atual.
  {
    const rico = autonomoRico(hoje)
    for (const [frase, soma] of [['quanto gastei em cada mes', /Soma dos \d+ meses/], ['quanto recebi mes por mes', /Soma dos \d+ meses/],
      ['quanto gastei em cada semana desse mes', /(?:Soma das \d+ semanas|Total da semana)/]] as [string, RegExp][]) {
      const r = await turnoHoje(rico, frase)
      out.push(result(`GT-${frase.replace(/\W+/g, '-')}`, r.reply, 'lista por período com a soma no fim', soma.test(r.reply.replace(/ /g, ' '))))
    }
  }

  // "Desse mês", "deste ano", "dessa semana": a contração não era período, o
  // resto virava texto de busca ("obra desse") e o período caía em "este mês".
  {
    const brl = (v: number) => fmtBRL(v).replace(/\u00a0/g, ' ')
    const limpa = (s: string) => s.replace(/\u00a0/g, ' ')
    const rico = autonomoRico(hoje)
    const soma = (f: (x: AppState['transactions'][number]) => boolean) =>
      Math.round(rico.transactions.filter(x => x.date <= hoje && f(x)).reduce((a, x) => a + x.amount, 0) * 100) / 100
    const obraMes = soma(x => x.type === 'expense' && x.category === 'obra' && x.date >= `${hoje.slice(0, 8)}01`)
    const mercadoAno = soma(x => x.type === 'expense' && x.description === 'Mercado' && x.date >= `${hoje.slice(0, 4)}-01-01`)
    const obra = await turnoHoje(rico, 'quanto gastei de obra desse mes')
    out.push(result('DP-desse-mes', obra.reply, `${brl(obraMes)} de obra`, obraMes > 0 && limpa(obra.reply).includes(brl(obraMes))))
    const mercado = await turnoHoje(rico, 'quanto gastei de mercado deste ano')
    out.push(result('DP-deste-ano', mercado.reply, `${brl(mercadoAno)} no ano`, mercadoAno > 0 && limpa(mercado.reply).includes(brl(mercadoAno))))
    const semanas = await turnoHoje(rico, 'quanto gastei em cada semana desse mes')
    const mesPassado = toISOdate(new Date(fromISO(hoje).getFullYear(), fromISO(hoje).getMonth() - 1, 15)).slice(5, 7)
    out.push(result('DP-semanas-desse-mes', semanas.reply, 'só as semanas deste mês',
      /(?:Soma das \d+ semanas|Total da semana)/.test(limpa(semanas.reply)) && !new RegExp(`semana de \\d{2}/${mesPassado}(?! \\((?:desde|só))`).test(semanas.reply)
        && !/últimas 12 semanas/.test(semanas.reply)))
  }

  // Troca de óleo é manutenção: "quanto falta pra trocar o óleo" respondia
  // parcelamentos, "quantos km faltam" procurava dias de trabalho, "falta muito
  // pra troca de óleo?" caía na ajuda. Literal: troca aos 210.000, hodômetro 206.400.
  {
    const mot = motoristaRico(hoje)
    for (const frase of ['quanto falta pra trocar o oleo', 'quantos km faltam pra trocar o oleo', 'falta muito pra troca de oleo?']) {
      const r = await turnoHoje(mot, frase)
      out.push(result(`MN-${frase.replace(/\W+/g, '-')}`, r.reply, 'faltam 3.600 km para a troca aos 210.000',
        /3\.600 km/.test(r.reply) && /210\.000/.test(r.reply) && r.actions.length === 0))
    }
    const gasto = await turnoHoje(mot, 'quanto gastei com troca de oleo')
    out.push(result('MN-gasto-com-troca-continua-consulta', gasto.reply, 'R$ 280,00 gastos, não a próxima troca',
      /R\$\s280,00/.test(gasto.reply) && !/pr[óo]xima troca/.test(gasto.reply)))
  }

  // "Gasto fixo" é o que se repete: listava TODOS os gastos por mês; "quais
  // minhas contas fixas" misturava faturas; o custo fixo do carro (R$ 900 em
  // Configurações) nunca aparecia. Literal: Luz 180 + Internet 120 por mês.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    for (const frase of ['qual meu gasto fixo por mes', 'quais minhas contas fixas', 'quanto pago de contas fixas']) {
      const r = limpa((await turnoHoje(rico, frase)).reply)
      out.push(result(`FX-${frase.replace(/\W+/g, '-')}`, r, 'R$ 300,00 por mês: Luz 180 e Internet 120, sem fatura',
        /R\$ 300,00 por m[êe]s/.test(r) && /Luz: R\$ 180,00/.test(r) && /Internet: R\$ 120,00/.test(r) && !/Fatura/.test(r)))
    }
    const mot = limpa((await turnoHoje(motoristaRico(hoje), 'qual meu custo fixo')).reply)
    out.push(result('FX-motorista-custo-fixo', mot, 'R$ 900,00 cadastrados em Configurações', /R\$ 900,00/.test(mot) && /Configura[çc][õo]es/.test(mot)))
  }

  // "Quanto fico por dia tirando a gasolina" é entrada MENOS combustível: a
  // consulta excluía a gasolina das despesas e respondia R$ 10,37 (a troca de
  // óleo por dia). E "Por dia este mês" não dizia de quê nem por quantos dias.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const mot = motoristaRico(hoje)
    const ini = `${hoje.slice(0, 8)}01`
    const doMes = mot.transactions.filter(x => x.date >= ini && x.date <= hoje)
    const entradas = doMes.filter(x => x.type === 'income').reduce((a, x) => a + x.amount, 0)
    const combustivel = doMes.filter(x => x.type === 'expense' && x.category === 'combustivel').reduce((a, x) => a + x.amount, 0)
    const dias = Number(hoje.slice(8, 10))
    const r2 = (v: number) => Math.round(v * 100) / 100
    const porDia = limpa((await turnoHoje(mot, 'quanto fico por dia tirando a gasolina')).reply)
    out.push(result('SC-por-dia-tirando-gasolina', porDia, `${brl(r2((entradas - combustivel) / dias))} por dia`,
      porDia.includes(brl(r2((entradas - combustivel) / dias))) && !porDia.includes(brl(10.37))))
    const total = limpa((await turnoHoje(mot, 'quanto sobra depois da gasolina')).reply)
    out.push(result('SC-total-depois-da-gasolina', total, `${brl(r2(entradas - combustivel))} no mês`, total.includes(brl(r2(entradas - combustivel)))))
    const rotulo = limpa((await turnoHoje(mot, 'quanto sobra por dia')).reply)
    out.push(result('SC-rotulo-por-dia', rotulo, 'diz que é líquido e que divide pelos dias corridos',
      /L[íi]quido por dia/.test(rotulo) && rotulo.includes(dias === 1 ? '1 dia corrido' : `${dias} dias corridos`)))
  }

  // "Tirando cimento" tira o CIMENTO, não a categoria Obra inteira (areia e
  // tijolo junto), e o rótulo diz o que ficou de fora. "Tirando obra" (o nome
  // da categoria) e "tirando comida" (sem lançamento com esse nome) continuam
  // tirando a categoria.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const ini = `${hoje.slice(0, 8)}01`
    const gastos = rico.transactions.filter(x => x.type === 'expense' && x.date >= ini && x.date <= hoje)
    const soma = (f: (x: typeof gastos[number]) => boolean) => Math.round(gastos.filter(f).reduce((a, x) => a + x.amount, 0) * 100) / 100
    const casos: [string, string, number, RegExp][] = [
      ['EX-tirando-cimento', 'quanto gastei esse mes tirando cimento', soma(x => x.description !== 'Cimento'), /sem cimento/i],
      ['EX-tirando-obra', 'quanto gastei esse mes tirando obra', soma(x => x.category !== 'obra'), /sem obra/i],
      ['EX-tirando-comida', 'quanto gastei esse mes tirando comida', soma(x => x.category !== 'alimentacao'), /sem (?:comida|alimenta)/i],
    ]
    for (const [id, frase, valor, rotulo] of casos) {
      const r = limpa((await turnoHoje(rico, frase)).reply)
      out.push(result(id, r, `${brl(valor)} e o rótulo diz a exclusão`, r.includes(brl(valor)) && rotulo.test(r)))
    }
  }

  // "Por dia" é por dia: "quanto gastei por dia" devolvia o total de 7 dias,
  // e "em média por dia" a média por LANÇAMENTO.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const gasto = (de: string, ate: string) => rico.transactions.filter(x => x.type === 'expense' && x.date >= de && x.date <= ate)
      .reduce((a, x) => a + x.amount, 0)
    const r2 = (v: number) => Math.round(v * 100) / 100
    const mes = r2(gasto(`${hoje.slice(0, 8)}01`, hoje) / Number(hoje.slice(8, 10)))
    const semana = r2(gasto(addDays(hoje, -13), addDays(hoje, -7)) / 7)
    const casos: [string, string, number][] = [
      ['PD-gastei-por-dia', 'quanto gastei por dia', mes],
      ['PD-media-por-dia', 'quanto gastei em media por dia esse mes', mes],
      ['PD-por-dia-semana-passada', 'quanto gastei por dia na semana passada', semana],
    ]
    for (const [id, frase, valor] of casos) {
      const r = limpa((await turnoHoje(rico, frase)).reply)
      const semGasto = valor === 0
      out.push(result(id, r, semGasto ? 'sem despesa registrada no período' : `${brl(valor)} por dia`,
        semGasto ? /não tenho nenhum lançamento/i.test(r)
          : r.includes(brl(valor)) && /dias? corridos?/.test(r) && !/por lan[çc]amento/.test(r)))
    }
  }

  // A proposta de receita diz DE ONDE: "Receita de R$ 1.200,00 (Aluguéis)" não
  // dizia que era a Casa 2, nem "(Corridas)" que era a Uber — e é isso que o
  // usuário confere antes de confirmar.
  {
    const casa = await turnoHoje(autonomoRico(hoje), 'recebi 1200 da casa 2')
    out.push(result('OR-receita-com-origem', casa.reply, 'proposta mostra Casa 2', /Receita de R\$\s1\.200,00 \(Alugu[ée]is\) — Casa 2/.test(casa.reply)))
    const uber = await turnoHoje(motoristaRico(hoje), 'ganhei 430 na uber')
    out.push(result('OR-receita-com-plataforma', uber.reply, 'proposta mostra Uber', /Receita de R\$\s430,00 \(Corridas\) — Uber/.test(uber.reply)))
  }

  // A META existe: "quando consigo comprar o notebook" e "consigo comprar o
  // notebook até março?" eram recusadas como hipótese que não se sabe simular.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const quando = limpa((await turnoHoje(rico, 'quando consigo comprar o notebook')).reply)
    out.push(result('MC-quando-consigo', quando, `Notebook: faltam ${brl(2800)}, com projeção`,
      /Notebook/.test(quando) && quando.includes(brl(2800)) && !/hip[óo]tese/i.test(quando)))
    const ate = limpa((await turnoHoje(rico, 'consigo comprar o notebook ate marco?')).reply)
    out.push(result('MC-consigo-ate-marco', ate, 'Sim/Não com o valor por mês até março',
      /^(?:Sim|Não)\b/.test(ate) && /Notebook|dep[óo]sitos/.test(ate) && !/hip[óo]tese/i.test(ate)))
    const celular = limpa((await turnoHoje(rico, 'consigo comprar um celular de 3000 em 10x?')).reply)
    out.push(result('MC-compra-sem-meta-simula', celular, 'compra sem meta continua simulação', /R\$ 300,00 por m[êe]s/.test(celular)))
  }

  // Simulação perguntada como sim/não abre com a resposta, na palavra da
  // pergunta: "consigo comprar … em 10x?" não tinha veredito, e "cabe?"
  // recebia "Não dá ruim".
  {
    const rico = autonomoRico(hoje)
    const apertado = buildState({ profile: 'autonomo', balance: 500 })
    const casos: [string, AppState, string, RegExp][] = [
      ['VD-consigo-sim', rico, 'consigo comprar um celular de 3000 em 10x?', /^Sim\b/],
      ['VD-da-pra-sim', rico, 'da pra comprar uma geladeira de 4000 em 12x?', /^Sim\b/],
      ['VD-cabe', rico, 'se eu comprar uma tv de 2000 em 5x cabe?', /^Cabe\b/],
      ['VD-consigo-nao', apertado, 'consigo comprar um celular de 3000 em 2x?', /^Não\b/],
    ]
    for (const [id, st, frase, lead] of casos) {
      const r = await turnoHoje(st, frase)
      out.push(result(id, r.reply, String(lead), lead.test(r.reply) && r.actions.length === 0))
    }
  }

  // Depois de simular a compra, "e quanto fica nesse mês?" e "e no mês que
  // vem?" pedem a linha DAQUELE mês — recebiam "você quer mudar a simulação?".
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const sim = await turnoHoje(rico, 'se eu comprar um pc de 4000 em 10x')
    const meses = sim.focus?.lastScenario?.months || []
    const h = fromISO(hoje)
    const mk = (n: number) => toISOdate(new Date(h.getFullYear(), h.getMonth() + n, 1)).slice(0, 7)
    for (const [frase, n] of [['e quanto fica nesse mes', 0], ['e no mes que vem?', 1]] as [string, number][]) {
      const m = meses.find(x => x.monthKey === mk(n))
      const r = limpa((await turnoHoje(rico, frase, sim.focus)).reply)
      out.push(result(`SM-${frase.replace(/\W+/g, '-')}`, r, m ? `${m.label}: ${brl(m.after)}` : 'mês na simulação',
        !!m && r.includes(brl(m.after)) && r.toLowerCase().includes(m.label.toLowerCase()) && !/mudar a simula/i.test(r)))
    }
  }

  // "Pq?" depois de "qual foi meu pior mês" quer saber o que pesou NAQUELE
  // mês — recebia a metodologia ("subtraí as saídas das entradas de 46
  // registros"). No fixture, o mês passado tem a reforma do telhado (2.400).
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    for (const [pergunta, porque] of [['qual foi meu pior mes', 'pq?'], ['qual mes eu gastei mais', 'por que?']]) {
      const r1 = await turnoHoje(rico, pergunta)
      const topo = r1.focus?.lastQuery?.groups?.[0]
      const r2 = limpa((await turnoHoje(rico, porque, r1.focus)).reply)
      out.push(result(`PQ-${pergunta.replace(/\W+/g, '-')}`, r2, `${topo?.label}: o que pesou, com a reforma do telhado`,
        !!topo && r2.toLowerCase().includes(topo.label.toLowerCase()) && /Reforma do telhado/i.test(r2) && /R\$ 2\.400,00/.test(r2)
          && !/^Subtra[íi]|^Somei/.test(r2)))
    }
  }

  {
    const rico = autonomoRico(hoje)
    const seleciona = await turnoHoje(rico, 'Em qual mês eu gastei mais com obra?')
    const selecionado = seleciona.focus?.lastQuery?.groups[0]
    const motivo = await turnoHoje(rico, 'Por quê?', seleciona.focus)
    out.push(result('PQ-ranking-mantem-o-filtro-de-categoria', { selecionado, reply: motivo.reply },
      'explica os gastos com obra do mês selecionado, sem incluir a reforma que está na categoria Casa',
      !!selecionado && motivo.reply.includes(fmtBRL(selecionado.value)) && /Obra/.test(motivo.reply) && !/Reforma do telhado/i.test(motivo.reply)))
  }

  {
    const st = motoristaRico(hoje)
    const melhor = await turnoHoje(st, 'Qual foi minha melhor semana?')
    const topo = melhor.focus?.lastQuery?.groups[0]
    const motivo = await turnoHoje(st, 'Por quê?', melhor.focus)
    out.push(result('PQ-explica-a-semana-vencedora', { topo, reply: motivo.reply },
      'explica entradas e saídas da semana selecionada, sem trocar pelo período agregado',
      !!topo && motivo.reply.toLowerCase().includes(topo.label.toLowerCase())
        && /entradas de R\$.*saídas de R\$/i.test(motivo.reply) && !/nas últimas 12 semanas/.test(motivo.reply)))
  }

  // Continuidade da fatura: "quanto tá a fatura do nubank" → "e o inter?"
  // virava "O inter de quanto?" (elipse de compra) depois que a fatura passou
  // a ser respondida pelo roteador, sem plano no foco.
  {
    const st = estadoDeFaturas(hoje)
    const r1 = await turnoHoje(st, 'quanto falta pagar da fatura do nubank')
    const r2 = await turnoHoje(st, 'e o inter?', r1.focus)
    out.push(result('FC-e-o-inter-depois-da-fatura', r2.reply, 'a mesma pergunta para o Inter: R$ 300,00 atrasada',
      /Inter/.test(r2.reply) && /R\$\s300,00/.test(r2.reply) && !/de quanto/i.test(r2.reply) && r2.actions.length === 0))
    const r3 = await turnoHoje(st, 'e o c6', r2.focus)
    out.push(result('FC-e-o-c6-em-seguida', r3.reply, 'segue trocando o cartão', /C6/.test(r3.reply) && !/de quanto/i.test(r3.reply)))
  }

  // Fatura na consulta diz a SITUAÇÃO: a atrasada sem pagamento saía "(dado
  // real)", lido como paga, e a fechada "(previsão)" com valor já fechado.
  {
    const st = estadoDeFaturas(hoje)
    const palavra: Record<string, RegExp> = { atrasada: /atrasada/, fechada: /fechada/, paga: /\bpaga\b/, parcial: /paga em parte/, aberta: /aberta/ }
    for (const [frase, nome] of [['quanto gastei no cartao inter esse mes', 'Inter'], ['quanto gastei no cartao nubank esse mes', 'Nubank']]) {
      const card = st.cards.find(c => c.name === nome)!
      const inv = cardInvoice(st, card, hoje.slice(0, 7))
      const r = (await turnoHoje(st, frase)).reply
      // Fechamento num mês e vencimento no seguinte: na virada, a fatura que
      // vence neste mês está vazia e a compra foi para a próxima.
      out.push(result(`FS-${nome}`, r, inv.total > 0 ? `situação ${inv.status}` : 'fatura do mês vazia: R$ 0,00',
        inv.total > 0 ? palavra[inv.status].test(r) && (inv.status === 'aberta' || !/previs/i.test(r)) : /R\$\s0,00/.test(r)))
    }
    const compras = buildState({ profile: 'autonomo', cards: [{ name: 'Inter', limit: 5000, closingDay: 5, dueDay: 15 }] })
    const atual = `${hoje.slice(0, 7)}-01`
    const antes = addDays(atual, -1)
    const proximo = toISOdate(new Date(fromISO(hoje).getFullYear(), fromISO(hoje).getMonth() + 1, 15))
    const compra = { id: 'tv', description: 'TV', cardId: compras.cards[0].id, totalAmount: 1200, installmentCount: 1,
      firstDueDate: proximo, purchaseDate: hoje, status: 'active' as const, operationType: 'card-purchase' as const, createdAt: hoje }
    compras.installmentPlans = [
      compra,
      { ...compra, id: 'mesa', description: 'Mesa', purchaseDate: antes, firstDueDate: `${hoje.slice(0, 7)}-15`, totalAmount: 250 },
      { ...compra, id: 'financiado', operationType: 'financed-cash-inflow', totalAmount: 600 },
      { ...compra, id: 'cancelada', status: 'cancelled', totalAmount: 300 },
      { ...compra, id: 'futura', purchaseDate: addDays(hoje, 1), totalAmount: 900 },
    ]
    compras.installments = [
      { id: 'tv-p1', planId: 'tv', number: 1, total: 1, amount: 1200, dueDate: proximo, status: 'pending' },
      { id: 'mesa-p1', planId: 'mesa', number: 1, total: 1, amount: 250, dueDate: `${hoje.slice(0, 7)}-15`, status: 'pending' },
    ]
    const gasto = await turnoHoje(compras, 'quanto gastei no cartao inter esse mes')
    out.push(result('FS-compras-do-mes-e-fatura-pelo-vencimento', gasto.reply,
      'R$ 1.200 pela compra deste mês e R$ 250 em fatura que vence neste mês',
      /Compras registradas no cartão Inter este mês: R\$\s1\.200,00/.test(gasto.reply)
        && /fatura[^\n]*R\$\s250,00|R\$\s250,00[^\n]*fatura/i.test(gasto.reply) && gasto.actions.length === 0))

    // Parcela marcada como paga SEM data (backup antigo): o caixa e a resposta
    // de fatura já a tratam como quitada; a consulta não pode chamá-la de atrasada.
    const caixa = estadoDeCaixaFuturo(hoje, 1000, 'autonomo')
    const passada = addDays(hoje, -35)
    const mesDela = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][fromISO(passada).getMonth()]
    const antiga = (await turnoHoje(caixa, `quanto gastei no cartao nubank em ${mesDela}`)).reply
    out.push(result('FS-backup-pago-nao-atrasa', antiga, 'paga, sem "atrasada"', /\bpaga\b/.test(antiga) && !/atrasada/.test(antiga)))
  }

  // Horas a mais HOJE: o rótulo dizia "Estimativa para um dia" (eram 3 horas),
  // a resposta não ajudava a decidir, e "vale a pena ficar mais 3 horas?" (sem
  // "se eu") caía em "não tenho certeza do que registrar".
  {
    const mot = motoristaRico(hoje)
    for (const frase of ['se eu ficar mais 3h na rua hoje vale?', 'vale a pena ficar mais 3 horas?']) {
      const r = (await turnoHoje(mot, frase)).reply
      out.push(result(`HX-${frase.replace(/\W+/g, '-')}`, r, '3 horas a mais rendem ~R$ X, com a meta de hoje',
        /3\s*h(?:oras)? a mais/.test(r) && !/para um dia/.test(r) && /meta de hoje/.test(r) && !/n[ãa]o tenho certeza/i.test(r)))
    }
  }

  // "Mais 2h por dia ESSA SEMANA" são 7 dias, não 30.
  {
    const r = (await turnoHoje(motoristaRico(hoje), 'e se eu rodar mais 2h por dia essa semana')).reply
    out.push(result('HX-essa-semana-sete-dias', r, '7 dias', /em 7 dias/.test(r) && !/30 dias rendem/.test(r)))
  }

  // "Como foi hoje?" e "foi bom?" caíam na ajuda genérica. Oráculo: lucro de
  // hoje e lucro médio dos dias com registro nos 30 dias anteriores.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const mot = motoristaRico(hoje)
    const r2 = (v: number) => Math.round(v * 100) / 100
    const lucro = (de: string, ate: string) => mot.transactions.filter(x => x.date >= de && x.date <= ate)
      .reduce((a, x) => a + (x.type === 'income' ? x.amount : x.type === 'expense' ? -x.amount : 0), 0)
    const ini = addDays(hoje, -30), ontem = addDays(hoje, -1)
    const dias = new Set([...mot.transactions.filter(x => x.date >= ini && x.date <= ontem).map(x => x.date),
      ...mot.workSessions.filter(w => w.date >= ini && w.date <= ontem).map(w => w.date)]).size
    const hojeLucro = r2(lucro(hoje, hoje))
    const media = r2(lucro(ini, ontem) / dias)
    const nadaHoje = !mot.transactions.some(x => x.date === hoje) && !mot.workSessions.some(w => w.date === hoje)
    const como = limpa((await turnoHoje(mot, 'como foi hoje')).reply)
    out.push(result('DD-como-foi-hoje', como, nadaHoje ? 'dia sem registro: pede o registro, sem número' : `lucro ${brl(hojeLucro)} contra média ${brl(media)}`,
      nadaHoje ? /Hoje ainda não tem nada registrado/.test(como) && !/R\$/.test(como)
        : como.includes(brl(hojeLucro)) && como.includes(brl(media)) && !/Posso te ajudar/.test(como)))
    const bom = limpa((await turnoHoje(mot, 'foi bom?')).reply)
    out.push(result('DD-foi-bom', bom, nadaHoje ? 'dia sem registro' : hojeLucro >= media ? 'Sim, acima da média' : 'abaixo da média',
      nadaHoje ? /Hoje ainda não tem nada registrado/.test(bom)
        : (hojeLucro >= media ? /^Sim\b/ : /^N[ãa]o\b|^Abaixo|^Foi mais fraco/).test(bom) && bom.includes(brl(media))))
  }

  // Registro e "como foi?" juntos: "hj deu 300 uber como foi" virava "não
  // tenho certeza do que registrar" (a frase não era cortada antes do "como"),
  // e "fiz 280 hoje, foi bom?" registrava sem responder.
  {
    const mot = motoristaRico(hoje)
    for (const [frase, valor] of [['hj deu 300 uber como foi', 300], ['fiz 280 hoje, foi bom?', 280]] as [string, number][]) {
      const r = await turnoHoje(mot, frase)
      out.push(result(`DD-registro-e-${frase.replace(/\W+/g, '-')}`, { reply: r.reply, actions: r.actions },
        `receita de ${valor} proposta e o dia comparado, marcado como hipotético`,
        r.actions.some(a => a.kind === 'income' && a.amount === valor) && /Se voc[êe] confirmar (?:o registro|os registros) acima/.test(r.reply)
          && /m[ée]dia/.test(r.reply)))
    }
  }

  // O resultado do dia guarda a PLATAFORMA dita: "hj deu 300 uber" ficava sem
  // descrição, e o dia não contava para a Uber em "qual plataforma paga melhor".
  {
    const mot = motoristaRico(hoje)
    for (const frase of ['hj deu 300 uber', 'hoje foi 300 uber']) {
      const r = await turnoHoje(mot, frase)
      out.push(result(`PL-${frase.replace(/\W+/g, '-')}`, r.actions, 'receita de 300 com descrição Uber',
        r.actions.some(a => a.kind === 'income' && a.amount === 300 && a.description === 'Uber')))
    }
  }

  // "Vale a pena rodar domingo?" caía na ajuda. Sem domingo no histórico, diz
  // que não há base; com domingo, compara o lucro médio dele com o dos outros dias.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const semDomingo = limpa((await turnoHoje(motoristaRico(hoje), 'vale a pena rodar domingo?')).reply)
    // Os dois melhores dias pelo lucro médio; a menos de 2% um do outro, é empate (regra 56).
    const lucroPorData = new Map<string, number>()
    for (const x of motoristaRico(hoje).transactions.filter(x => x.date >= addDays(hoje, -90) && x.date < hoje)) {
      lucroPorData.set(x.date, (lucroPorData.get(x.date) || 0) + (x.type === 'income' ? x.amount : x.type === 'expense' ? -x.amount : 0))
    }
    const medias = [1, 2, 3, 4, 5, 6].map(wd => {
      const v = [...lucroPorData].filter(([d]) => fromISO(d).getDay() === wd).map(([, x]) => x)
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0
    }).sort((x, y) => y - x)
    const empatados = Math.abs(medias[0] - medias[1]) / Math.max(Math.abs(medias[0]), 1) <= 0.02
    out.push(result('WD-sem-domingo', semDomingo, 'sem domingo registrado: diz que não há base',
      /domingo/i.test(semDomingo) && /nenhum/i.test(semDomingo) && !/Posso te ajudar/.test(semDomingo)
        && empatados === /empat/.test(semDomingo)))
    const comDomingo = motoristaRico(hoje)
    let domingo = addDays(hoje, -1)
    while (fromISO(domingo).getDay() !== 0) domingo = addDays(domingo, -1)
    comDomingo.transactions = [...comDomingo.transactions,
      { id: 'dom-1', type: 'income', amount: 400, category: 'corridas', date: domingo, description: 'Uber', time: '10:00' }] as AppState['transactions']
    const ini = addDays(hoje, -90)
    const porDia = new Map<string, number>()
    for (const x of comDomingo.transactions.filter(x => x.date >= ini && x.date < hoje && fromISO(x.date).getDay() !== 0)) {
      porDia.set(x.date, (porDia.get(x.date) || 0) + (x.type === 'income' ? x.amount : x.type === 'expense' ? -x.amount : 0))
    }
    const outros = Math.round([...porDia.values()].reduce((a, v) => a + v, 0) / porDia.size * 100) / 100
    const r = limpa((await turnoHoje(comDomingo, 'vale a pena rodar domingo?')).reply)
    out.push(result('WD-com-domingo', r, `domingo ${brl(400)} contra ${brl(outros)} nos outros dias`,
      r.includes(brl(400)) && r.includes(brl(outros)) && /estimativa|hist[óo]rico/i.test(r)))
  }

  // Pergunta telegráfica, sem verbo nem número: "gastos dessa semana",
  // "entradas do mês", "saldo?" caíam na ajuda genérica.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const soma = (f: (x: AppState['transactions'][number]) => boolean) =>
      Math.round(rico.transactions.filter(x => x.date <= hoje && f(x)).reduce((a, x) => a + x.amount, 0) * 100) / 100
    const ini = `${hoje.slice(0, 8)}01`
    const casos: [string, number][] = [
      ['gastos dessa semana', soma(x => x.type === 'expense' && x.date >= addDays(hoje, -6))],
      ['entradas do mes', soma(x => x.type === 'income' && x.date >= ini)],
      ['gastos com obra esse mes', soma(x => x.type === 'expense' && x.category === 'obra' && x.date >= ini)],
      ['saldo?', currentBalance(rico)],
    ]
    for (const [frase, valor] of casos) {
      const r = limpa((await turnoHoje(rico, frase)).reply)
      out.push(result(`NM-${frase.replace(/\W+/g, '-')}`, r, brl(valor), r.includes(brl(valor)) && !/Posso te ajudar/.test(r)))
    }
    const comUmaLuz = { ...rico, recurring: [{
      id: 'luz-nominal', name: 'Luz', amount: 180, category: 'casa', kind: 'expense' as const,
      frequency: 'monthly' as const, active: true, dueDay: Number(hoje.slice(8)), startDate: hoje,
    }] }
    const registro = await turnoHoje(comUmaLuz, 'gasto 50 de luz')
    out.push(result('NM-com-valor-conta-fixa', registro, 'Luz pendente vira confirmação com R$ 50 (cadastrado R$ 180 citado)',
      registro.actions.length === 1 && registro.actions[0].kind === 'recurring-confirm' && registro.actions[0].amount === 50
        && /cadastrado: R\$\s180,00/.test(registro.reply)))
    const avulso = await turnoHoje(rico, 'paguei 50 no mercado')
    out.push(result('NM-com-valor-avulso-continua-registro', avulso.actions, 'despesa avulsa de 50',
      avulso.actions.some(a => a.kind === 'expense' && a.amount === 50)))
  }

  // "Resumo da semana" respondia o mês; "contas do mês" olhava 15 dias.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const semana = Math.round(rico.transactions.filter(x => x.type === 'expense' && x.date >= addDays(hoje, -6) && x.date <= hoje)
      .reduce((a, x) => a + x.amount, 0) * 100) / 100
    const resumo = limpa((await turnoHoje(rico, 'resumo da semana')).reply)
    out.push(result('RS-resumo-da-semana', resumo, `semana: despesas ${brl(semana)}`,
      /semana|7 dias/i.test(resumo) && resumo.includes(brl(semana)) && !/neste m[êe]s/.test(resumo)))
    const h = fromISO(hoje)
    const fim = toISOdate(new Date(h.getFullYear(), h.getMonth() + 1, 0))
    const contas = (await turnoHoje(rico, 'contas do mes')).reply
    out.push(result('RS-contas-do-mes', contas, `até ${fim.slice(8, 10)}/${fim.slice(5, 7)}`, contas.includes(`${fim.slice(8, 10)}/${fim.slice(5, 7)}`)))
  }

  // Usuário NOVO (saldo nunca informado, nada registrado): "consigo comprar
  // um celular de 2000 em 10x?" respondia "Não." com base num zero que ninguém
  // disse. Sem base, a simulação não dá veredito — pede o saldo.
  {
    const novo = buildState({ profile: 'clt' })
    for (const frase of ['consigo comprar um celular de 2000 em 10x?', 'e se eu gastar 500 hoje, da ruim?']) {
      const r = (await turnoHoje(novo, frase)).reply
      out.push(result(`SB-${frase.replace(/\W+/g, '-')}`, r, 'sem veredito; pede o saldo',
        !/^(?:Sim|Não|N[ãa]o dá ruim|Dá ruim)\b/.test(r) && /meu saldo [ée]/i.test(r)))
    }
  }

  // "Meu salário é 3000 e cai dia 5" é recorrência, como "ganho 3500 por
  // mês" — caía na ajuda. "Caiu dia 5" (passado) continua registro.
  {
    const clt = buildState({ profile: 'clt' })
    const declara = await turnoHoje(clt, 'meu salario e 3000 e cai dia 5')
    out.push(result('RC-cai-dia-5', declara, 'orienta cadastrar a recorrência, sem lançamento',
      /se repete|Planejamento/.test(declara.reply) && declara.actions.length === 0))
    const caiu = await turnoHoje(clt, 'meu salario de 3000 caiu hoje')
    out.push(result('RC-caiu-continua-registro', caiu.actions, 'receita de 3000', caiu.actions.some(a => a.kind === 'income' && a.amount === 3000)))
  }

  // Elipse de categoria sem "no/na": depois de "quanto gastei com obra esse
  // mês", "e alimentação?", "e com lazer?" e "e de alimentação?" caíam na ajuda.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const ini = `${hoje.slice(0, 8)}01`
    const daCat = (cat: string) => Math.round(rico.transactions.filter(x => x.type === 'expense' && x.category === cat && x.date >= ini && x.date <= hoje)
      .reduce((a, x) => a + x.amount, 0) * 100) / 100
    const r1 = await turnoHoje(rico, 'quanto gastei com obra esse mes')
    for (const [frase, cat] of [['e alimentacao?', 'alimentacao'], ['e com lazer?', 'lazer'], ['e de alimentacao?', 'alimentacao']]) {
      const r = limpa((await turnoHoje(rico, frase, r1.focus)).reply)
      out.push(result(`EL-${frase.replace(/\W+/g, '-')}`, r, brl(daCat(cat)), daCat(cat) > 0 && r.includes(brl(daCat(cat))) && !/Posso te ajudar/.test(r)))
    }
  }

  // Anáfora e soma na continuação: "qual foi o maior gasto disso?" respondia
  // o maior gasto dos últimos 7 dias (Lazer) depois de uma pergunta sobre obra;
  // "somando as duas?" depois de Casa 1 e Casa 2 caía na ajuda.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const ini = `${hoje.slice(0, 8)}01`
    const obras = rico.transactions.filter(x => x.type === 'expense' && x.category === 'obra' && x.date >= ini && x.date <= hoje)
    const maior = Math.max(...obras.map(x => x.amount))
    const r1 = await turnoHoje(rico, 'quanto gastei com obra esse mes')
    const disso = limpa((await turnoHoje(rico, 'qual foi o maior gasto disso?', r1.focus)).reply)
    out.push(result('AN-maior-disso', disso, `maior gasto de obra: ${brl(maior)}`, disso.includes(brl(maior)) && !/Lazer/.test(disso)))
    const ano = `${hoje.slice(0, 4)}-01-01`
    const da = (origem: string) => rico.transactions.filter(x => x.type === 'income' && x.origin === origem && x.date >= ano && x.date <= hoje)
      .reduce((a, x) => a + x.amount, 0)
    const c1 = await turnoHoje(rico, 'quanto recebi da casa 1 esse ano')
    const c2 = await turnoHoje(rico, 'e da casa 2?', c1.focus)
    const soma = limpa((await turnoHoje(rico, 'somando as duas?', c2.focus)).reply)
    out.push(result('AN-somando-as-duas', soma, `Casa 1 + Casa 2: ${brl(da('Casa 1') + da('Casa 2'))}`,
      soma.includes(brl(da('Casa 1') + da('Casa 2'))) && !/Posso te ajudar/.test(soma)))
  }

  // Comparação legível: "O período principal ficou R$ 420,00 abaixo" era
  // jargão; e "Em 2025: R$ 0,00 … acima" comparava com um ano sem lançamento.
  {
    const brl = (v: number) => fmtBRL(v).replace(/ /g, ' ')
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const h = fromISO(hoje)
    const obra = (de: string, ate: string) => rico.transactions.filter(x => x.type === 'expense' && x.category === 'obra' && x.date >= de && x.date <= ate)
      .reduce((a, x) => a + x.amount, 0)
    const esteMes = obra(`${hoje.slice(0, 8)}01`, hoje)
    const passado = obra(toISOdate(new Date(h.getFullYear(), h.getMonth() - 1, 1)), toISOdate(new Date(h.getFullYear(), h.getMonth(), 0)))
    const r1 = await turnoHoje(rico, 'quanto gastei com obra esse mes')
    const r2 = await turnoHoje(rico, 'e no mes passado?', r1.focus)
    const r3 = await turnoHoje(rico, 'qual a diferenca?', r2.focus)
    const dif = limpa(r3.reply)
    out.push(result('CP-diferenca-sem-jargao', dif, `diferença de ${brl(Math.abs(esteMes - passado))}, sem "período principal"`,
      dif.includes(brl(Math.abs(esteMes - passado))) && !/per[íi]odo principal/i.test(dif)))
    const r4 = limpa((await turnoHoje(rico, 'e no ano?', r3.focus)).reply)
    const anoAnterior = String(h.getFullYear() - 1)
    const obraAnoAnterior = rico.transactions.some(x => x.type === 'expense' && x.category === 'obra' && x.date.startsWith(anoAnterior))
    out.push(result('CP-ano-sem-base-para-comparar', r4, obraAnoAnterior ? `compara com ${anoAnterior}, sem R$ 0,00 inventado` : 'ano anterior sem lançamento: diz que não há o que comparar',
      obraAnoAnterior ? new RegExp(`Em ${anoAnterior}: R\\$`).test(r4) && !/n[ãa]o h[áa] lan[çc]amentos? para comparar/i.test(r4)
        : /n[ãa]o h[áa] lan[çc]amentos? para comparar/i.test(r4) && !/R\$ 0,00/.test(r4)))
  }

  // Elipse com o nome de algo CADASTRADO: "e a internet?" (conta fixa) e "e a
  // viagem?" (meta) caíam na elipse de compra — "A internet de quanto?".
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const caixa = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
    const f1 = await turnoHoje(caixa, 'quanto falta pagar da fatura do inter')
    const internet = limpa((await turnoHoje(caixa, 'e a internet?', f1.focus)).reply)
    out.push(result('EC-e-a-internet', internet, 'conta Internet: R$ 100,00', /Internet/.test(internet) && /R\$ 100,00/.test(internet) && !/de quanto/i.test(internet)))
    const rico = autonomoRico(hoje)
    const m1 = await turnoHoje(rico, 'quanto falta pro notebook')
    const viagem = limpa((await turnoHoje(rico, 'e a viagem?', m1.focus)).reply)
    out.push(result('EC-e-a-viagem', viagem, 'meta Viagem: faltam R$ 1.200,00', /Viagem/.test(viagem) && /R\$ 1\.200,00/.test(viagem) && !/de quanto/i.test(viagem)))
  }

  // Ranking por mês sem o mês corrente incompleto: "qual foi meu pior mês"
  // listava o mês atual, que perde (ou ganha) por estar pela metade.
  {
    const rico = autonomoRico(hoje)
    const mesAtual = monthShortLabel(fromISO(hoje))
    const ultimoDia = new Date(fromISO(hoje).getFullYear(), fromISO(hoje).getMonth() + 1, 0).getDate() === fromISO(hoje).getDate()
    // No dia 1º o mês corrente ainda não tem gasto nenhum: não há o que deixar
    // de fora, e o aviso de "incompleto" não tem a que se referir.
    const mesAtualTemGasto = rico.transactions.some(t => t.type === 'expense' && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje)
    for (const frase of ['qual foi meu pior mes', 'qual mes eu gastei mais']) {
      const r = (await turnoHoje(rico, frase)).reply
      out.push(result(`PM-${frase.replace(/\W+/g, '-')}`, r, mesAtualTemGasto ? `${mesAtual} fora do ranking, dito` : `${mesAtual} sem gasto: fora do ranking`,
        ultimoDia || (!r.includes(`• ${mesAtual}:`) && !r.startsWith(`O menor foi ${mesAtual}`) && (!mesAtualTemGasto || /incomplet/.test(r)))))
    }
  }

  // O verbo no presente não é descrição: "gasto 50 de luz" gravava "Gasto de
  // luz", e "gasto de 50 no mercado", "Gasto de no mercado". "Mercado Pago"
  // continua com o "pago" — ali ele é nome.
  {
    const clt = buildState({ profile: 'clt' })
    for (const [frase, desc] of [['gasto 50 de luz', 'Luz'], ['pago 80 de internet hoje', 'Internet'], ['gasto de 50 no mercado', 'Mercado'],
      ['gastei 50 no mercado pago', 'Mercado pago']]) {
      const r = await turnoHoje(clt, frase)
      out.push(result(`DS-${frase.replace(/\W+/g, '-')}`, r.actions, `descrição "${desc}"`,
        r.actions.some(a => a.kind === 'expense' && a.amount > 0 && a.description === desc)))
    }
  }

  // "E se eu gastar 500 esse mês" não é gasto de HOJE: a simulação dizia "Se
  // você gastar R$ 500,00 hoje".
  {
    const r = (await turnoHoje(autonomoRico(hoje), 'e se eu gastar 500 esse mes?')).reply
    out.push(result('GM-gasto-este-mes', r, '"este mês", não "hoje"', /gastar R\$\s500,00 este m[êe]s/.test(r) && !/500,00 hoje/.test(r)))
    const hojeMesmo = (await turnoHoje(autonomoRico(hoje), 'e se eu gastar 500 hoje?')).reply
    out.push(result('GM-gasto-hoje-continua', hojeMesmo, '"hoje"', /gastar R\$\s500,00 hoje/.test(hojeMesmo)))
  }

  // O rótulo usa a grafia DELE: "Total gasto - Ze da esquina" perdia o acento
  // que está nos próprios lançamentos ("Zé da esquina").
  {
    const r = (await turnoHoje(autonomoRico(hoje), 'quanto gastei no zé da esquina desde julho')).reply
    out.push(result('GR-rotulo-com-acento', r, '"Zé da esquina" no rótulo', /Zé da esquina/.test(r)))
  }

  // Cada item com o SEU "dia N": "gastei 50 dia 3 e 80 dia 10" gravava os dois
  // no dia 3, e "recebi 1800 dia 5 e 1200 dia 7" perdia os 1200 em silêncio.
  {
    const rico = autonomoRico(hoje)
    const h = fromISO(hoje)
    // "Dia N" num registro é o último dia N que já passou.
    const dia = (n: number) => toISOdate(n <= h.getDate() ? new Date(h.getFullYear(), h.getMonth(), n) : new Date(h.getFullYear(), h.getMonth() - 1, n))
    const casos: [string, [string, number, number][]][] = [
      ['gastei 50 dia 3 e 80 dia 10', [['expense', 50, 3], ['expense', 80, 10]]],
      ['recebi 1800 dia 5 e 1200 dia 7', [['income', 1800, 5], ['income', 1200, 7]]],
      ['recebi 1800 da casa 1 dia 5 e 1200 da casa 2 dia 7', [['income', 1800, 5], ['income', 1200, 7]]],
      ['gastei 30 no mercado dia 3 e 50 na farmacia dia 4', [['expense', 30, 3], ['expense', 50, 4]]],
    ]
    for (const [frase, itens] of casos) {
      const r = await turnoHoje(rico, frase)
      // Dia que ainda não chegou neste mês é ambíguo (mês passado ou previsão).
      const aindaNaoChegou = itens.some(([, , d]) => d > h.getDate())
      const conhecidos = itens.filter(([, , d]) => d <= h.getDate())
      const ok = (!aindaNaoChegou || /ainda n[ãa]o chegou|data indefinida/.test(r.reply))
        && conhecidos.every(([kind, amount, d]) => r.actions.some(a => a.kind === kind && a.amount === amount && a.date === dia(d)))
        && r.actions.filter(a => a.kind === 'income' || a.kind === 'expense').length === conhecidos.length
      out.push(result(`DT-${frase.replace(/\W+/g, '-')}`, { reply: r.reply, actions: r.actions },
        aindaNaoChegou ? 'pergunta a data e só propõe itens com dia definido' : itens.map(([k, v, d]) => `${k} ${v} em ${dia(d)}`).join('; '), ok))
    }
  }

  // Transferência para alguém e venda: "transferi 500 pra minha mãe" e "vendi
  // a bike por 800" caíam na ajuda genérica. Reserva continua reserva.
  {
    const clt = buildState({ profile: 'clt' })
    const casos: [string, string, (acts: any[]) => boolean][] = [
      ['transferi 500 pra minha mae', 'despesa de 500 para a mãe', a => a.some(x => x.kind === 'expense' && x.amount === 500 && /m[ãa]e/i.test(x.description || ''))],
      ['mandei 300 pro meu irmao', 'despesa de 300 para o irmão', a => a.some(x => x.kind === 'expense' && x.amount === 300 && /irm[ãa]o/i.test(x.description || ''))],
      ['vendi a bike por 800', 'receita de 800 em Vendas', a => a.some(x => x.kind === 'income' && x.amount === 800 && x.category === 'vendas' && /bike/i.test(x.description || ''))],
      ['vendi 3 bolos por 60', 'receita de 60 em Vendas', a => a.some(x => x.kind === 'income' && x.amount === 60 && x.category === 'vendas')],
      ['mandei 200 pra poupanca', 'continua guardar na reserva', a => a.some(x => x.kind === 'saving' && x.amount === 200)],
      // Regra 5: transferência para a PRÓPRIA reserva não é despesa, com ou sem "minha".
      ['transferi 300 pra minha poupança', 'reserva, nunca despesa', a => a.some(x => x.kind === 'saving' && x.amount === 300) && !a.some(x => x.kind === 'expense')],
      ['mandei 200 pra minha reserva', 'reserva, nunca despesa', a => a.some(x => x.kind === 'saving' && x.amount === 200) && !a.some(x => x.kind === 'expense')],
    ]
    for (const [frase, esperado, ok] of casos) {
      const r = await turnoHoje(clt, frase)
      out.push(result(`TV-${frase.replace(/\W+/g, '-')}`, r.actions, esperado, ok(r.actions)))
    }
  }

  // Trocar a CATEGORIA da proposta na tela: "muda pra lazer" respondia "não
  // registrei nada" e descartava a proposta; "coloca em lazer" caía na ajuda.
  {
    const rico = autonomoRico(hoje)
    for (const frase of ['muda pra lazer', 'coloca em lazer', 'a categoria e lazer', 'era lazer', 'troca a categoria pra lazer']) {
      const p1 = await orchestrate({ state: rico, message: 'gastei 50 no mercado', today: hoje, remoteEnabled: false })
      const p2 = await orchestrate({ state: rico, message: frase, today: hoje, remoteEnabled: false, pending: p1.response.actions })
      const acts = p2.response.actions.map(a => a.action as any)
      out.push(result(`CC-${frase.replace(/\W+/g, '-')}`, { reply: p2.response.reply, acts }, 'mesma despesa de 50, agora em Lazer',
        acts.length === 1 && acts[0].kind === 'expense' && acts[0].amount === 50 && acts[0].category === 'lazer' && /\(Lazer\)/.test(p2.response.reply)))
    }
  }

  // O item da proposta pelo NOME: com almoço e café na tela, "tira o café"
  // descartava os dois ("não registrei nada"), e "o almoço foi 35" não achava
  // o almoço.
  {
    const rico = autonomoRico(hoje)
    const base = await orchestrate({ state: rico, message: 'gastei 30 no almoço e 15 no café', today: hoje, remoteEnabled: false })
    const tira = await orchestrate({ state: rico, message: 'tira o café', today: hoje, remoteEnabled: false, pending: base.response.actions })
    const restam = tira.response.actions.map(a => a.action as any)
    out.push(result('PN-tira-pelo-nome', restam, 'só o almoço de 30 fica', restam.length === 1 && restam[0].amount === 30 && /Almo/.test(restam[0].description)))
    const corrige = await orchestrate({ state: rico, message: 'na verdade o almoço foi 35', today: hoje, remoteEnabled: false, pending: base.response.actions })
    const itens = corrige.response.actions.map(a => a.action as any)
    out.push(result('PN-corrige-pelo-nome', itens, 'almoço 35, café 15',
      itens.length === 2 && itens.some(x => /Almo/.test(x.description) && x.amount === 35) && itens.some(x => /Caf/.test(x.description) && x.amount === 15)))
  }

  // "E mais 20 de pão" com despesas na tela ACRESCENTA uma despesa: virava
  // RECEITA de R$ 20 e substituía a proposta (o almoço e o café sumiam).
  {
    const rico = autonomoRico(hoje)
    const base = await orchestrate({ state: rico, message: 'gastei 30 no almoço e 15 no café', today: hoje, remoteEnabled: false })
    const mais = await orchestrate({ state: rico, message: 'e mais 20 de pão', today: hoje, remoteEnabled: false, pending: base.response.actions })
    const receitaTambem = await orchestrate({ state: rico, message: 'e recebi 120 da Casa 2', today: hoje, remoteEnabled: false, pending: mais.response.actions })
    const itens = mais.response.actions.map(a => a.action as any)
    const idsOriginais = base.response.actions.map(a => a.id)
    const comReceita = receitaTambem.response.actions.map(a => a.action)
    out.push(result('PN-e-mais-acrescenta', itens, 'despesas anteriores e pão de R$ 20 ficam em um cartão, que aceita a receita adicional',
      itens.length === 3 && itens.every(x => x.kind === 'expense') && itens.some(x => x.amount === 20 && /p[ãa]o/i.test(x.description || ''))
        && itens.some(x => x.amount === 30) && itens.some(x => x.amount === 15)
        && mais.correctedPending?.length === 3 && idsOriginais.every(id => mais.correctedPending.some(next => next.id === id))
        && receitaTambem.correctedPending?.length === 4 && comReceita.some(action =>
          action.kind === 'income' && action.amount === 120 && action.origin === 'Casa 2')))
  }

  // Trocar o LUGAR da proposta: "foi na padaria" caía na ajuda. E "pão" é
  // comida: "gastei 20 de pão" ia para Outros.
  {
    const rico = autonomoRico(hoje)
    const p1 = await orchestrate({ state: rico, message: 'gastei 50 no mercado', today: hoje, remoteEnabled: false })
    const p2 = await orchestrate({ state: rico, message: 'foi na padaria', today: hoje, remoteEnabled: false, pending: p1.response.actions })
    const acts = p2.response.actions.map(a => a.action as any)
    out.push(result('PN-foi-na-padaria', { reply: p2.response.reply, acts }, 'mesma despesa de 50, agora Padaria',
      acts.length === 1 && acts[0].amount === 50 && acts[0].description === 'Padaria' && acts[0].category === 'alimentacao'))
    const cartao = await orchestrate({ state: rico, message: 'comprei uma tv de 2400 em 12x no nubank', today: hoje, remoteEnabled: false })
    const noInter = await orchestrate({ state: rico, message: 'foi no inter', today: hoje, remoteEnabled: false, pending: cartao.response.actions })
    out.push(result('PN-foi-no-cartao-continua-cartao', noInter.response.actions.map(a => a.action), 'cartão Inter, descrição intacta',
      (noInter.response.actions as { action: any }[]).some(a => /inter/i.test(a.action.cardName || '') && /tv/i.test(a.action.description || ''))))
    const pao = await turnoHoje(rico, 'gastei 20 de pão')
    out.push(result('PN-pao-e-alimentacao', pao.actions, 'Alimentação', pao.actions.some(a => a.kind === 'expense' && a.category === 'alimentacao')))
    const paoSem = await turnoHoje(rico, 'gastei 20 de pao')
    out.push(result('PN-pao-sem-acento', paoSem.actions, 'Alimentação', paoSem.actions.some(a => a.kind === 'expense' && a.category === 'alimentacao')))
    const japao = await turnoHoje(rico, 'gastei 40 no japao')
    out.push(result('PN-japao-nao-e-pao', japao.actions, 'não vira Alimentação', japao.actions.some(a => a.kind === 'expense' && a.category !== 'alimentacao')))
  }

  // Limite de UM cartão: "quanto eu tenho de limite no nubank" respondia "não
  // tenho faturas com 'limite'". Literal: Nubank 8.000, 8 parcelas de 400
  // pendentes (3.200 comprometidos), 4.800 disponíveis.
  {
    const r = (await turnoHoje(autonomoRico(hoje), 'quanto eu tenho de limite no nubank')).reply.replace(/ /g, ' ')
    out.push(result('LM-limite-do-nubank', r, 'limite 8.000, comprometido 3.200, disponível 4.800, só Nubank',
      /R\$ 8\.000,00/.test(r) && /R\$ 3\.200,00/.test(r) && /R\$ 4\.800,00/.test(r) && /Nubank/.test(r) && !/Inter/.test(r)))
    // Sem cartão citado: a soma dos cartões (13.000, 5.200 comprometidos, 7.800 livres).
    const todos = (await turnoHoje(autonomoRico(hoje), 'quanto tenho de limite')).reply.replace(/ /g, ' ')
    out.push(result('LM-limite-de-todos', todos, 'soma: 13.000, 5.200, 7.800',
      /R\$ 13\.000,00/.test(todos) && /R\$ 5\.200,00/.test(todos) && /R\$ 7\.800,00/.test(todos)))
  }

  // Parcelamento pelo nome: "quando acaba a geladeira" caía na ajuda; "qual
  // minha maior parcela" e "antecipei 2 parcelas do computador" devolviam o
  // resumo dos cartões. Geladeira: 6x de 400, 5 pendentes, a última no dia 15
  // daqui a 4 meses; Computador: 400 por parcela também (empate).
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const ultima = rico.installments.filter(i => i.planId === 'p2' && i.status === 'pending').map(i => i.dueDate).sort().pop()!
    const data = `${ultima.slice(8, 10)}/${ultima.slice(5, 7)}/${ultima.slice(0, 4)}`
    const acaba = limpa((await turnoHoje(rico, 'quando acaba a geladeira')).reply)
    out.push(result('PC-quando-acaba', acaba, `termina em ${data}, 5 parcelas, R$ 2.000,00`,
      acaba.includes(data) && /\b5 parcelas\b/.test(acaba) && /R\$ 2\.000,00/.test(acaba)))
    const maior = limpa((await turnoHoje(rico, 'qual minha maior parcela')).reply)
    out.push(result('PC-maior-parcela', maior, 'R$ 400,00, empate entre Computador e Geladeira',
      /R\$ 400,00/.test(maior) && /Computador/.test(maior) && /Geladeira/.test(maior) && !/Situação dos seus cartões/.test(maior)))
    const antecipa = await turnoHoje(rico, 'antecipei 2 parcelas do computador')
    out.push(result('PC-antecipar-aponta-a-tela', antecipa.reply, 'aponta Cartões e parcelamentos → Antecipar, sem ação',
      antecipa.actions.length === 0 && /Cart[õo]es e parcelamentos/.test(antecipa.reply) && /Antecipar/.test(antecipa.reply)
        && !/Situação dos seus cartões/.test(antecipa.reply)))
    // A outra ordem das palavras e "última parcela" sem o nome: a DSL somava o
    // que falta pagar (R$ 5.200,00) e o resumo dos cartões respondia o resto.
    const cara = limpa((await turnoHoje(rico, 'qual a parcela mais cara')).reply)
    out.push(result('PC-parcela-mais-cara', cara, 'R$ 400,00, empate entre Computador e Geladeira',
      /R\$ 400,00/.test(cara) && /empate/.test(cara) && !/Situação dos seus cartões/.test(cara)))
    const fimComputador = rico.installments.filter(i => i.planId === 'p1' && i.status === 'pending').map(i => i.dueDate).sort().pop()!
    const dataComputador = `${fimComputador.slice(8, 10)}/${fimComputador.slice(5, 7)}/${fimComputador.slice(0, 4)}`
    const doNubank = limpa((await turnoHoje(rico, 'qual a ultima parcela do nubank')).reply)
    out.push(result('PC-ultima-parcela-do-cartao', doNubank, `Computador (Nubank) termina em ${dataComputador}, não "falta pagar"`,
      doNubank.includes(dataComputador) && /Computador/.test(doNubank) && !/Geladeira/.test(doNubank) && !/Falta pagar/.test(doNubank)))
    const todas = limpa((await turnoHoje(rico, 'quando e a ultima parcela')).reply)
    out.push(result('PC-ultima-parcela-de-todas', todas, `a última é a do Computador, em ${dataComputador}; Geladeira em ${data}`,
      todas.includes(dataComputador) && todas.includes(data) && /Computador/.test(todas.split('\n')[0])
        && !/Situação dos seus cartões/.test(todas)))
    const itau = limpa((await turnoHoje(rico, 'qual a ultima parcela do itau')).reply)
    out.push(result('PC-ultima-parcela-cartao-inexistente', itau, 'não há cartão Itau; nada de responder pelos outros',
      /Não encontrei/.test(itau) && /Itau/.test(itau) && !/termina em/.test(itau)))
  }

  // Dívida sem a palavra "cartão": a DSL somava o gasto do mês (R$ 2.373,00)
  // como se fosse o que a pessoa deve. Dívida do autonomoRico: 8 + 5 parcelas
  // de 400 = R$ 5.200,00; no Inter, só a Geladeira: R$ 2.000,00. "Devo" modal
  // ("quanto devo guardar") e "devo do computador" ficam como estavam.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    for (const [id, msg] of [['DV-to-devendo', 'to devendo quanto'], ['DV-ainda-devo', 'quanto ainda devo'], ['DV-devo-no-total', 'quanto devo no total'],
      ['DV-devo-ao-banco', 'quanto devo ao banco']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      out.push(result(id, r, 'dívida R$ 5.200,00, nunca o gasto do mês', /R\$ 5\.200,00/.test(r) && !/Total gasto/.test(r)))
    }
    const divida = limpa((await turnoHoje(rico, 'qual minha divida')).reply)
    out.push(result('DV-qual-minha-divida', divida, 'começa pela dívida, R$ 5.200,00', /^Sua dívida[^\n]*R\$ 5\.200,00/.test(divida)))
    const inter = limpa((await turnoHoje(rico, 'quanto eu to devendo no inter')).reply)
    out.push(result('DV-devendo-no-cartao', inter, 'falta pagar no Inter R$ 2.000,00, como "quanto devo no nubank"',
      /R\$ 2\.000,00/.test(inter) && !/Faturas do Inter este mês/.test(inter)))
    const guardar = limpa((await turnoHoje(rico, 'quanto devo guardar por mes')).reply)
    out.push(result('DV-devo-modal-controle', guardar, 'meta de guardar, não dívida', /guardar/.test(guardar) && !/dívida/i.test(guardar)))
    const computador = limpa((await turnoHoje(rico, 'quanto devo do computador')).reply)
    out.push(result('DV-devo-do-item-controle', computador, 'Computador R$ 3.200,00', /Computador/.test(computador) && /R\$ 3\.200,00/.test(computador)))
  }

  // Mês solto à frente no calendário, com fatura ou parcela: é o que VEM. Lido
  // no passado, "dezembro" em outubro virava dezembro do ano anterior, antes de
  // qualquer parcela, e a resposta dizia "R$ 0,00 (dado real)". O mês pedido é
  // calculado de hoje (dois meses à frente), e as parcelas pendentes dele vêm
  // do fixture. Com verbo no passado ("foi"), segue o ano anterior.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const alvo = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) + 1, 1)
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const mes = nomes[alvo.getMonth()]
    const prefixo = `${alvo.getFullYear()}-${String(alvo.getMonth() + 1).padStart(2, '0')}`
    const doMes = (plano?: string) => rico.installments
      .filter(i => i.status === 'pending' && i.dueDate.startsWith(prefixo) && (!plano || i.planId === plano)).reduce((a, i) => a + i.amount, 0)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const fatura = limpa((await turnoHoje(rico, `quanto vai ser a fatura do nubank em ${mes}`)).reply)
    out.push(result('MF-fatura-mes-a-frente', fatura, `${fmt(doMes('p1'))} do ${mes} que vem, não R$ 0,00 do ano passado`,
      doMes('p1') > 0 && fatura.includes(fmt(doMes('p1'))) && fatura.includes(String(alvo.getFullYear())) && !/R\$ 0,00/.test(fatura)))
    const parcelas = limpa((await turnoHoje(rico, `quanto vou pagar de parcela em ${mes}`)).reply)
    out.push(result('MF-parcela-mes-a-frente', parcelas, `${fmt(doMes())} em parcelas`,
      doMes() > 0 && parcelas.includes(fmt(doMes())) && parcelas.includes(String(alvo.getFullYear()))))
    // Mês já passado neste ano, com o futuro dito: o do ano que vem.
    const atras = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 3, 1)
    const vence = limpa((await turnoHoje(rico, `quanto vence de fatura em ${nomes[atras.getMonth()]}`)).reply)
    out.push(result('MF-vence-mes-ja-passado', vence, `${nomes[atras.getMonth()]} de ${atras.getFullYear() + 1}`,
      vence.includes(String(atras.getFullYear() + 1)) && !vence.includes(`/${atras.getFullYear()}`)))
    const foi = limpa((await turnoHoje(rico, `quanto foi a fatura do nubank em ${mes}`)).reply)
    out.push(result('MF-passado-controle', foi, `${mes} do ano anterior: nada ali`, !foi.includes(fmt(doMes('p1'))) || doMes('p1') === 0))
  }

  // Pergunta sobre pagamento nunca propõe pagamento (regra 33). O parser
  // cortava a frase no verbo ("quanto | paguei de fatura"), a metade sem o
  // "quanto" virava pagamento da fatura, e o rascunho perguntava o cartão.
  // Confirmar ali registraria R$ 400,00 que ninguém pagou.
  {
    const rico = autonomoRico(hoje)
    for (const [id, msg] of [['QP-quanto-paguei-de-fatura', 'quanto paguei de fatura'],
      ['QP-quanto-paguei-da-fatura-do-cartao', 'quanto eu paguei da fatura do nubank'],
      ['QP-quanto-paguei-fatura-no-mes', 'quanto paguei de fatura esse mes'],
      ['QP-paguei-a-fatura-pergunta', 'paguei a fatura?']]) {
      const r = await turnoHoje(rico, msg)
      out.push(result(id, { reply: r.reply, actions: r.actions }, 'resposta, sem proposta de pagamento',
        r.actions.length === 0 && !/Em qual cartão|Confirmar|Se você confirmar/.test(r.reply)))
    }
    const registra = await turnoHoje(somenteFaturasAtuais(rico, hoje), 'paguei a fatura do nubank')
    out.push(result('QP-registro-controle', registra.actions, 'pagamento proposto',
      (registra.actions as { kind: string }[]).some(a => a.kind === 'card-payment')))
    const semCartao = await turnoHoje(rico, 'paguei a fatura')
    out.push(result('QP-registro-sem-cartao-controle', semCartao.reply, 'pergunta o cartão', /Em qual cartão/.test(semCartao.reply)))
  }

  // A reserva é o tipo `saving`, não a categoria "reserva": os depósitos do
  // fixture estão em "Outros", como no legado. Filtrada pela categoria, "quanto
  // guardei na reserva" dizia "não tenho lançamento" enquanto "quanto devo
  // guardar" dizia "este mês você já guardou R$ 500,00"; "mandei pra reserva"
  // ainda virava gasto.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const doMes = rico.transactions.filter(t => t.type === 'saving' && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje)
      .reduce((a, t) => a + t.amount, 0)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    for (const [id, msg] of [['RV-guardei-na-reserva', 'quanto guardei na reserva'], ['RV-mandei-pra-reserva', 'quanto mandei pra reserva'],
      ['RV-coloquei-na-reserva', 'quanto coloquei na reserva esse mes']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      out.push(result(id, r, doMes > 0 ? `${fmt(doMes)} guardados no mês` : 'sem depósito até hoje: diz que não há lançamento, nunca "Total gasto"',
        doMes > 0 ? r.includes(fmt(doMes)) && !/Não tenho nenhum lançamento|Total gasto/.test(r)
          : /Não tenho nenhum lançamento|R\$ 0,00/.test(r) && !/Total gasto/.test(r)))
    }
  }

  // Meta com verbo de depósito pede o que JÁ foi guardado. Viagem: 4.800 de
  // 6.000; Notebook: 1.200 de 4.000. "Quanto depositei nas metas" dizia "Metas
  // até agora: R$ 4.000,00" — a soma do que FALTA, com o rótulo de nenhum dos
  // dois números.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const viagem = limpa((await turnoHoje(rico, 'quanto depositei na viagem')).reply)
    out.push(result('MG-depositei-na-meta', viagem, 'R$ 4.800,00 guardados na Viagem',
      /R\$ 4\.800,00/.test(viagem) && !/^Falta/.test(viagem)))
    const coloquei = limpa((await turnoHoje(rico, 'quanto coloquei na meta da viagem')).reply)
    out.push(result('MG-coloquei-na-meta', coloquei, 'R$ 4.800,00', /R\$ 4\.800,00/.test(coloquei) && !/^Falta/.test(coloquei)))
    const todas = limpa((await turnoHoje(rico, 'quanto depositei nas metas')).reply)
    out.push(result('MG-depositei-nas-metas', todas, 'R$ 6.000,00 guardados nas metas',
      /R\$ 6\.000,00/.test(todas) && !/R\$ 4\.000,00/.test(todas)))
    const falta = limpa((await turnoHoje(rico, 'quanto falta nas metas')).reply)
    out.push(result('MG-falta-nas-metas', falta, 'R$ 4.000,00, dito que é o que falta',
      /R\$ 4\.000,00/.test(falta) && /[Ff]alta/.test(falta)))
    const valor = limpa((await turnoHoje(rico, 'qual o valor das minhas metas')).reply)
    out.push(result('MG-valor-das-metas', valor, 'R$ 10.000,00 de alvo', /R\$ 10\.000,00/.test(valor)))
  }

  // Receita por categoria sem período: o mês, como na consulta. O roteador
  // antigo olhava os últimos 7 dias e dizia "R$ 0,00 em Aluguéis" para quem
  // recebeu os dois aluguéis do mês; "freela" nem era reconhecido, e a
  // resposta era o lucro da semana inteira.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const aluguelDoMes = rico.transactions.filter(t => t.type === 'income' && t.category === 'aluguel'
      && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje).reduce((a, t) => a + t.amount, 0)
    const aluguel = limpa((await turnoHoje(rico, 'quanto recebi de aluguel')).reply)
    out.push(result('RCAT-aluguel-no-mes', aluguel, `${fmt(aluguelDoMes)} este mês`,
      aluguelDoMes > 0 && aluguel.includes(fmt(aluguelDoMes)) && !/7 dias/.test(aluguel)))
    const passado = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 2, 1)
    const prefixo = `${passado.getFullYear()}-${String(passado.getMonth() + 1).padStart(2, '0')}`
    const freelaPassado = rico.transactions.filter(t => t.type === 'income' && t.category === 'freelance' && t.date.startsWith(prefixo))
      .reduce((a, t) => a + t.amount, 0)
    const freela = limpa((await turnoHoje(rico, 'quanto ganhei de freela no mes passado')).reply)
    out.push(result('RCAT-freela-mes-passado', freela, `${fmt(freelaPassado)} de Freelance`,
      freelaPassado > 0 && freela.includes(fmt(freelaPassado)) && !/lucro/i.test(freela)))
    const freelaMes = limpa((await turnoHoje(rico, 'quanto ganhei de freela')).reply)
    out.push(result('RCAT-freela-sem-periodo', freelaMes, 'Freelance do mês, não o lucro da semana',
      /[Ff]reela/.test(freelaMes) && !/lucro|faturou/i.test(freelaMes)))
  }

  // "Pra pagar", "vence" e "cartão" genérico descrevem a FONTE (parcela,
  // fatura), não um nome. Sobrando, viravam busca por texto e a resposta dizia
  // "não tenho parcelas com 'para pagar'" — ou mandava cadastrar um cartão a
  // quem tem dois. Somas das parcelas pendentes do fixture em cada mês.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const mesAdiante = (n: number) => new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 1 + n, 1)
    const pendentesEm = (d: Date) => {
      const prefixo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      return rico.installments.filter(i => i.status === 'pending' && i.dueDate.startsWith(prefixo)).reduce((a, i) => a + i.amount, 0)
    }
    const proximo = pendentesEm(mesAdiante(1))
    const praPagar = limpa((await turnoHoje(rico, 'quanto tenho de parcela pra pagar mes que vem')).reply)
    out.push(result('FL-parcela-pra-pagar', praPagar, `${fmt(proximo)} no mês que vem`,
      proximo > 0 && praPagar.includes(fmt(proximo)) && !/Não tenho|para pagar/.test(praPagar)))
    const daqui2 = mesAdiante(2)
    const vence = limpa((await turnoHoje(rico, `quanto de parcela vence em ${nomes[daqui2.getMonth()]}`)).reply)
    out.push(result('FL-parcela-vence', vence, `${fmt(pendentesEm(daqui2))} em ${nomes[daqui2.getMonth()]}`,
      pendentesEm(daqui2) > 0 && vence.includes(fmt(pendentesEm(daqui2))) && !/Não tenho|"vence"/.test(vence)))
    const cartao = limpa((await turnoHoje(rico, `quanto vou pagar de cartao em ${nomes[daqui2.getMonth()]}`)).reply)
    out.push(result('FL-pagar-de-cartao', cartao, `faturas de ${nomes[daqui2.getMonth()]}: ${fmt(pendentesEm(daqui2))}`,
      cartao.includes(fmt(pendentesEm(daqui2))) && !/Não tenho|"cartao"/.test(cartao)))
    const fatura = limpa((await turnoHoje(rico, 'quanto tenho de fatura pra pagar')).reply)
    const esperadoFL = faturasAPagarEsperadas(rico, hoje)
    out.push(result('FL-fatura-pra-pagar', fatura, `${esperadoFL.descricao}, nunca "cadastre um cartão"`,
      esperadoFL.confere(fatura) && !/Cadastre|Não tenho|para pagar|Situação dos seus cartões/.test(fatura)))
  }

  // "Fiz 12 corridas e (deu) 260": para o motorista, o valor depois das
  // corridas é o que elas renderam. Antes: só as viagens, e uma pergunta.
  {
    const moto = motoristaRico(hoje)
    for (const [id, msg] of [['CR-corridas-e-valor', 'fiz 12 corridas e 260'], ['CR-corridas-e-deu', 'fiz 12 corridas e deu 260'],
      ['CR-corridas-virgula-reais', 'fiz 12 corridas, 260 reais']]) {
      const t = await turnoHoje(moto, msg)
      const a = t.actions as { kind: string, amount?: number, trips?: number, category?: string }[]
      out.push(result(id, { reply: t.reply, actions: a }, 'receita de Corridas R$ 260,00 e 12 viagens, sem pergunta',
        a.some(x => x.kind === 'income' && x.amount === 260 && x.category === 'corridas')
          && a.filter(x => x.kind === 'work').reduce((s, x) => s + (x.trips || 0), 0) === 12 && !/não consegui ligar/.test(t.reply)))
    }
  }

  // A quilometragem da troca não é o custo: "troquei o óleo com 45 mil km"
  // virava manutenção de R$ 45,00, e "aos 45 mil km por 180" perdia os R$ 180.
  {
    const moto = motoristaRico(hoje)
    const manut = async (msg: string) => ((await turnoHoje(moto, msg)).actions as { kind: string, cost?: number, km?: number }[])
      .filter(a => a.kind === 'maintenance')
    const soKm = await manut('troquei o oleo com 45 mil km')
    out.push(result('MK-so-km', soKm, 'nenhuma manutenção de R$ 45,00 nem de R$ 45.000,00', !soKm.some(a => a.cost === 45 || a.cost === 45000)))
    const aos = await manut('troquei o oleo aos 45 mil km por 180')
    out.push(result('MK-aos-km-por-valor', aos, 'R$ 180,00 aos 45.000 km', aos.length === 1 && aos[0].cost === 180 && aos[0].km === 45000))
    const ordem = await manut('troquei o oleo por 180 com 45 mil km')
    out.push(result('MK-valor-com-km-controle', ordem, 'R$ 180,00 aos 45.000 km', ordem.length === 1 && ordem[0].cost === 180 && ordem[0].km === 45000))
  }

  // Gorjeta, bônus e incentivo são receita, não viagem: "recebi 50 de gorjeta"
  // registrava "Trabalho: 1 viagem", e o ganho por viagem caía.
  {
    const moto = motoristaRico(hoje)
    for (const [id, msg, valor] of [['GJ-gorjeta', 'recebi 50 de gorjeta', 50], ['GJ-bonus', 'ganhei 120 de bonus da uber', 120],
      ['GJ-incentivo', 'caiu 80 de incentivo da 99', 80]] as const) {
      const a = (await turnoHoje(moto, msg)).actions as { kind: string, amount?: number, trips?: number }[]
      out.push(result(id, a, `receita de ${valor}, sem viagem`,
        a.some(x => x.kind === 'income' && x.amount === valor) && !a.some(x => x.kind === 'work' && x.trips)))
    }
    const corrida = (await turnoHoje(moto, 'ganhei 40 numa corrida')).actions as { kind: string, trips?: number }[]
    out.push(result('GJ-corrida-controle', corrida, '1 viagem', corrida.some(x => x.kind === 'work' && x.trips === 1)))
  }

  // "Fiz 3 corridas DE 40 e uma de 25": quantidade × valor. Só as 3 viagens
  // entravam, e os R$ 145,00 viravam uma pergunta.
  {
    const moto = motoristaRico(hoje)
    const conta = async (msg: string) => {
      const t = await turnoHoje(moto, msg)
      const a = t.actions as { kind: string, amount?: number, trips?: number }[]
      return {
        receita: Math.round(a.filter(x => x.kind === 'income').reduce((s, x) => s + (x.amount || 0), 0) * 100) / 100,
        viagens: a.filter(x => x.kind === 'work').reduce((s, x) => s + (x.trips || 0), 0),
        pergunta: /não consegui ligar/.test(t.reply),
      }
    }
    for (const [id, msg, receita, viagens] of [['CQ-3-de-40-e-1-de-25', 'fiz 3 corridas de 40 e uma de 25', 145, 4],
      ['CQ-2-viagens-de-50', 'fiz 2 viagens de 50', 100, 2], ['CQ-uma-de-30-controle', 'fiz uma corrida de 30 reais', 30, 1]] as const) {
      const r = await conta(msg)
      out.push(result(id, r, `receita R$ ${receita}, ${viagens} viagens, sem pergunta de valor solto`,
        r.receita === receita && r.viagens === viagens && !r.pergunta))
    }
  }

  // "Na 99" é a plataforma, não R$ 99,00: o turno perguntava "o que aconteceu
  // com os R$ 99,00?" depois de ler as duas receitas certas.
  {
    const moto = motoristaRico(hoje)
    for (const [id, msg] of [['P99-no-uber-e-na-99', 'hoje deu 310 no uber e 90 na 99'], ['P99-pela-99', 'recebi 85 pela 99']]) {
      const r = await turnoHoje(moto, msg)
      out.push(result(id, { reply: r.reply, actions: r.actions }, 'receitas registradas, sem perguntar de R$ 99,00',
        r.actions.some(a => (a as { kind: string }).kind === 'income') && !/R\$ 99,00/.test(r.reply)))
    }
  }

  // "Rodei 8 horas" é jornada, não distância: virava 8 km.
  {
    const moto = motoristaRico(hoje)
    const trabalho = async (msg: string) => ((await turnoHoje(moto, msg)).actions as { kind: string, km?: number, hours?: number, trips?: number }[])
      .filter(a => a.kind === 'work')
    for (const [id, msg, horas] of [['KH-rodei-horas', 'rodei 8 horas', 8], ['KH-rodei-h', 'rodei 10h hoje', 10]] as const) {
      const w = await trabalho(msg)
      out.push(result(id, w, `${horas} horas, sem km`, w.length === 1 && w[0].hours === horas && !w[0].km))
    }
    const tudo = await trabalho('rodei 8 horas, fiz 15 viagens e faturei 340')
    out.push(result('KH-jornada-viagens-e-receita', tudo, '8 horas, 15 viagens, sem km',
      tudo.length === 1 && tudo[0].hours === 8 && tudo[0].trips === 15 && !tudo[0].km))
    const km = await trabalho('rodei 120 km')
    out.push(result('KH-km-controle', km, '120 km', km.length === 1 && km[0].km === 120 && !km[0].hours))
    for (const [id, msg] of [['KH-horas-e-km', 'rodei 8h e 150 km'], ['KH-km-e-horas', 'rodei 150 km e 8 horas']]) {
      const w = await trabalho(msg)
      out.push(result(id, w, '150 km e 8 horas', w.length === 1 && w[0].km === 150 && w[0].hours === 8))
    }
    // Depois das corridas também: "fiz 12 corridas e 40 km" perdia os 40 km.
    const corridasKm = await trabalho('fiz 12 corridas e 40 km')
    out.push(result('KH-corridas-e-km', corridasKm, '12 viagens e 40 km', corridasKm.length === 1 && corridasKm[0].trips === 12 && corridasKm[0].km === 40))
    const corridasHoras = await trabalho('fiz 5 corridas e 3 horas')
    out.push(result('KH-corridas-e-horas', corridasHoras, '5 viagens e 3 horas', corridasHoras.length === 1 && corridasHoras[0].trips === 5 && corridasHoras[0].hours === 3))
  }

  // Quantidade de viagens DITA vale para a mensagem toda: "fiz 12 corridas e
  // ganhei 260" registrava 13 (a receita da outra metade inferia mais uma).
  {
    const moto = motoristaRico(hoje)
    const viagens = async (msg: string) => ((await turnoHoje(moto, msg)).actions as { kind: string, trips?: number }[])
      .filter(a => a.kind === 'work').reduce((s, a) => s + (a.trips || 0), 0)
    for (const [id, msg] of [['VG-fiz-n-e-ganhei', 'fiz 12 corridas e ganhei 260'], ['VG-ganhei-e-fiz-n', 'ganhei 260 e fiz 12 corridas']]) {
      const n = await viagens(msg)
      out.push(result(id, n, '12 viagens', n === 12))
    }
    const so = await viagens('ganhei 260')
    out.push(result('VG-sem-quantidade-controle', so, '1 viagem inferida (decisão vigente)', so === 1))
  }

  // "40 litros A 5,89" é o preço do litro: o abastecimento entrava com R$ 5,89,
  // e a leitura genérica ainda criava "Despesa de R$ 40,00 — Litros a 5".
  // Total = 40 × 5,89 = R$ 235,60. "Por 180" segue sendo o total.
  {
    const moto = motoristaRico(hoje)
    const acoes = async (msg: string) => ((await turnoHoje(moto, msg)).actions as { kind: string, amount?: number, liters?: number, pricePerLiter?: number }[])
    const turno = await turnoHoje(moto, 'coloquei 40 litros a 5,89')
    const a = turno.actions as { kind: string, amount?: number, liters?: number, pricePerLiter?: number }[]
    out.push(result('AB-litros-a-preco', { reply: turno.reply, actions: a }, 'um abastecimento: 40 L a 5,89 = R$ 235,60, sem perguntar dos 5,89',
      a.length === 1 && a[0].kind === 'fuel' && a[0].liters === 40 && a[0].pricePerLiter === 5.89 && a[0].amount === 235.6
        && !/não consegui ligar/.test(turno.reply)))
    const oLitro = await acoes('abasteci 30 litros a 6,10 o litro')
    out.push(result('AB-litros-a-preco-o-litro', oLitro, 'um abastecimento: 30 L a 6,10 = R$ 183,00',
      oLitro.length === 1 && oLitro[0].kind === 'fuel' && oLitro[0].amount === 183 && oLitro[0].pricePerLiter === 6.1))
    const por = await acoes('abasteci 24 litros por 180')
    out.push(result('AB-litros-por-total-controle', por, 'um abastecimento: 24 L por R$ 180,00',
      por.length === 1 && por[0].kind === 'fuel' && por[0].amount === 180 && por[0].liters === 24))
  }

  // "Se eu parar de pagar a internet": a conta fixa Internet (R$ 120,00 por
  // mês, categoria Casa), não a categoria Assinaturas da palavra-chave — que
  // dava "Não achei base". E só ela: a Luz, também Casa, fica.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const r = limpa((await turnoHoje(rico, 'se eu parar de pagar a internet quanto sobra?')).reply)
    out.push(result('CFX-parar-conta-fixa', r, 'Internet, R$ 120,00 por mês evitados, sem a Luz',
      /Internet/.test(r) && /R\$ 120,00/.test(r) && !/Não achei base/.test(r) && !/Assinaturas/.test(r) && !/2 conta/.test(r)))
    // "Até dezembro" é o PRAZO da meta, não parte do nome: nascia a meta "Moto
  // ate dezembro", sem prazo. Prazo = último dia do mês dito.
  {
    const rico = autonomoRico(hoje)
    const meta = async (msg: string) => ((await turnoHoje(rico, msg)).actions as { kind: string, name?: string, months?: number }[])
      .find(a => a.kind === 'goal')
    const dias = (ano: number, mes: number) => Math.round((new Date(ano, mes + 1, 0).getTime() - fromISO(hoje).getTime()) / 86400000)
    const anoQueVem = await meta('quero juntar 5000 pra uma moto ate dezembro do ano que vem')
    const esperado = dias(Number(hoje.slice(0, 4)) + 1, 11)
    out.push(result('MPZ-ate-dezembro-ano-que-vem', anoQueVem, `"Moto", prazo em ${esperado} dias`,
      !!anoQueVem && anoQueVem.name === 'Moto' && Math.round((anoQueVem.months || 0) * 30) === esperado))
    const desteAno = await meta('quero juntar 5000 pra uma moto ate dezembro')
    const esperado2 = dias(Number(hoje.slice(0, 4)) + (Number(hoje.slice(5, 7)) > 12 ? 1 : 0), 11)
    out.push(result('MPZ-ate-dezembro', desteAno, `"Moto", prazo em ${esperado2} dias`,
      !!desteAno && desteAno.name === 'Moto' && Math.round((desteAno.months || 0) * 30) === esperado2))
    // "Em 6 meses" também se perdia: o texto que ia ao parser tirava as datas
    // de novo, sem a proteção do prazo.
    const seisMeses = await meta('quero comprar um celular de 5000 em 6 meses')
    out.push(result('MPZ-em-6-meses', seisMeses, '"Celular", 6 meses', !!seisMeses && seisMeses.name === 'Celular' && seisMeses.months === 6))
    // O nome para no conector: "pra viagem E amanhã pago…" virava "Viagem e pago".
    const comConector = await meta('quero juntar 1000 pra viagem e amanha pago a luz 180')
    out.push(result('MPZ-nome-para-no-e', comConector, '"Viagem"', !!comConector && comConector.name === 'Viagem'))
  }

  // Com a receita na tela, "e era da casa 2" diz DE ONDE veio. Respondia
  // "Entendi que isso não aconteceu — não registrei nada" e a proposta sumia.
  {
    const rico = autonomoRico(hoje)
    const recebi = await orchestrate({ state: rico, message: 'recebi 1800 do aluguel', today: todayISO(), remoteEnabled: false })
    const origem = await orchestrate({ state: rico, message: 'e era da casa 2', today: todayISO(), remoteEnabled: false,
      pending: recebi.response.actions } as Parameters<typeof orchestrate>[0])
    const acao = origem.response.actions.map(a => a.action as { kind: string, origin?: string, amount?: number })
    out.push(result('OC-origem-na-proposta', { reply: origem.response.reply, actions: acao }, 'a receita fica, com origem Casa 2',
      acao.length === 1 && acao[0].kind === 'income' && acao[0].amount === 1800 && /casa 2/i.test(acao[0].origin || '')
        && !/não aconteceu/.test(origem.response.reply)))
    // "Na verdade foi na padaria": o conserto de lugar com o prefixo mais comum.
    const mercado = await orchestrate({ state: rico, message: 'gastei 50 no mercado', today: todayISO(), remoteEnabled: false })
    const padaria = await orchestrate({ state: rico, message: 'na verdade foi na padaria', today: todayISO(), remoteEnabled: false,
      pending: mercado.response.actions } as Parameters<typeof orchestrate>[0])
    const lugar = padaria.response.actions.map(a => a.action as { kind: string, description?: string, amount?: number })
    out.push(result('OC-na-verdade-lugar', { reply: padaria.response.reply, actions: lugar }, 'Padaria, R$ 50,00',
      lugar.length === 1 && lugar[0].amount === 50 && /padaria/i.test(lugar[0].description || '')))
    // Correção que não deu para entender, com proposta na tela: pergunta e
    // mantém a proposta; nunca "não aconteceu".
    const vaga = await orchestrate({ state: rico, message: 'e era daquele lugar', today: todayISO(), remoteEnabled: false,
      pending: recebi.response.actions } as Parameters<typeof orchestrate>[0])
    out.push(result('OC-correcao-vaga-mantem', vaga.response.reply, 'não diz "não aconteceu"', !/não aconteceu/.test(vaga.response.reply)))
  }

  // "Tirei 100 da viagem": retirar de meta não tem ação no chat, mas a tela tem
  // (Metas → Editar → "Já guardado"). Caía na ajuda; agora aponta o caminho
  // com o valor que fica (R$ 4.800,00 − R$ 100,00), sem criar ação.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const r = await turnoHoje(rico, 'tirei 100 da viagem')
    const txt = limpa(r.reply)
    out.push(result('TM-tirei-da-meta', { reply: txt, actions: r.actions }, 'aponta Metas → Editar, de R$ 4.800,00 para R$ 4.700,00, sem ação',
      r.actions.length === 0 && /Metas/.test(txt) && /Já guardado/.test(txt) && /R\$ 4\.700,00/.test(txt)))
    // "Aumenta a meta pra 6000" sem dizer qual: com duas metas, pergunta qual
    // (antes: "Falta uma informação obrigatória"); com uma só, é ela.
    const semNome = await turnoHoje(rico, 'aumenta a meta pra 6000')
    out.push(result('TM-alterar-sem-nome-pergunta', semNome.reply, 'pergunta qual meta, Notebook ou Viagem',
      /Qual meta/.test(semNome.reply) && !/Falta uma informação/.test(semNome.reply) && semNome.actions.length === 0))
    const umaMeta = { ...rico, goals: rico.goals.filter(g => g.name === 'Viagem') }
    const sozinha = (await turnoHoje(umaMeta, 'aumenta a meta pra 6000')).actions as { kind: string, name?: string }[]
    out.push(result('TM-alterar-sem-nome-uma-meta', sozinha, 'altera a Viagem', sozinha.some(a => a.kind === 'goal-update' && a.name === 'Viagem')))
    const inexistente = await turnoHoje(rico, 'muda a meta da casa pra 9000')
    out.push(result('TM-alterar-meta-inexistente', inexistente.reply, 'não achei "Casa"; qual meta?',
      /Não encontrei a meta "Casa"/.test(inexistente.reply) && inexistente.actions.length === 0))
    // Alterar a meta mostra o nome como o depósito mostra: "viagem" em minúscula.
    const muda = await turnoHoje(rico, 'muda a meta da viagem pra 7000')
    out.push(result('TM-alterar-nome-da-meta', muda.reply, 'Alterar meta "Viagem"', /meta "Viagem"/.test(muda.reply)))
    const notebook = limpa((await turnoHoje(rico, 'retirei 200 da meta do notebook')).reply)
    out.push(result('TM-retirei-da-meta-do', notebook, 'Notebook: de R$ 1.200,00 para R$ 1.000,00', /Notebook/.test(notebook) && /R\$ 1\.000,00/.test(notebook)))
  }

  // "Pela metade" é metade: a resposta dizia "Se você PARAR os gastos com
    // Alimentação". Metade da média de 3 meses do fixture, pela soma dele.
    const metade = limpa((await turnoHoje(rico, 'e se eu cortar o mercado pela metade?')).reply)
    out.push(result('CFX-pela-metade', metade, 'cortar pela metade, não parar', /metade/i.test(metade) && !/parar os gastos/i.test(metade)))
    const cancelar = limpa((await turnoHoje(rico, 'se eu cancelar a internet?')).reply)
    out.push(result('CFX-cancelar-conta-fixa', cancelar, 'simula o corte da Internet', /Internet/.test(cancelar) && /R\$ 120,00/.test(cancelar)))
  }

  // "Compara COM SETEMBRO" na continuidade compara com setembro. O foco antigo
  // vencia: "Em agosto foi exatamente o mesmo valor" (o mês do turno de antes),
  // ou "Em julho" (o anterior ao foco).
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const setembro = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 2, 1)
    const nomeSet = setembro.toLocaleDateString('pt-BR', { month: 'long' })
    const pref = `${setembro.getFullYear()}-${String(setembro.getMonth() + 1).padStart(2, '0')}`
    const recebidoSet = rico.transactions.filter(t => t.type === 'income' && t.date.startsWith(pref)).reduce((a, t) => a + t.amount, 0)
    const agosto = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 3, 1).toLocaleDateString('pt-BR', { month: 'long' })
    for (const [id, antes] of [['CS-depois-do-mes-atual', ['quanto gastei em ' + agosto, 'quanto recebi esse mes']],
      ['CS-depois-de-outro-mes', ['quanto gastei em ' + agosto, 'e quanto recebi?']]] as const) {
      let foco: Awaited<ReturnType<typeof turnoHoje>>['focus']
      for (const m of antes) foco = (await turnoHoje(rico, m, foco)).focus
      const r = limpa((await turnoHoje(rico, `compara com ${nomeSet}`, foco)).reply)
      out.push(result(id, r, `comparado com ${nomeSet} (${fmt(recebidoSet)})`,
        new RegExp(nomeSet, 'i').test(r) && r.includes(fmt(recebidoSet))))
    }
    // "E de aluguel?" (singular) depois de "quanto recebi": a categoria
    // Aluguéis. Só "aluguéis" casava; o singular caía na ajuda.
    const focoReceita = (await turnoHoje(rico, 'quanto recebi esse mes')).focus
    const aluguelDoMes = rico.transactions.filter(t => t.type === 'income' && t.category === 'aluguel'
      && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje).reduce((a, t) => a + t.amount, 0)
    const deAluguel = limpa((await turnoHoje(rico, 'e de aluguel?', focoReceita)).reply)
    out.push(result('CS-e-de-aluguel', deAluguel, `Aluguéis ${fmt(aluguelDoMes)}`, deAluguel.includes(fmt(aluguelDoMes)) && /Aluguéis/.test(deAluguel)))
    // "E no mercado?" filtra pelo texto e o cabeçalho diz isso: o número certo
    // saía como "Total gasto este mês", lido como o mês inteiro.
    const focoGasto = (await turnoHoje(rico, 'quanto gastei esse mes')).focus
    const noMercado = limpa((await turnoHoje(rico, 'e no mercado?', focoGasto)).reply)
    out.push(result('CS-rotulo-do-texto', noMercado, 'o cabeçalho cita o mercado', /^Total gasto - Mercado/i.test(noMercado)))
    // "E de mercado?" (com preposição, nome que está nos lançamentos dele) é a
    // mesma restrição de "e no mercado?". Caía na ajuda. "E de novo?" não é.
    const deMercado = limpa((await turnoHoje(rico, 'e de mercado?', focoGasto)).reply)
    out.push(result('CS-e-de-nome-do-historico', deMercado, 'Total gasto - Mercado, R$ 200,00',
      /^Total gasto - Mercado/i.test(deMercado) && /R\$ 200,00/.test(deMercado)))
    const deNovo = limpa((await turnoHoje(rico, 'e de novo?', focoGasto)).reply)
    out.push(result('CS-e-de-novo-controle', deNovo, 'não vira busca por "novo"', !/Total gasto - Novo/i.test(deNovo)))
    // "E só no nubank?" depois de um gasto é a fatura do Nubank (R$ 400,00 no
    // mês): lançamento não carrega cartão, e o filtro dizia "não tenho nada".
    const noNubank = limpa((await turnoHoje(rico, 'e so no nubank?', focoGasto)).reply)
    out.push(result('CS-cartao-depois-de-gasto', noNubank, 'fatura do Nubank, R$ 400,00',
      /Nubank/.test(noNubank) && /R\$ 400,00/.test(noNubank) && !/Não tenho nenhum lançamento/.test(noNubank)))
    // Grãos diferentes: "este mês" contra "a semana passada" é semana com semana.
    const focoMes = (await turnoHoje(rico, 'quanto gastei esse mes')).focus
    const semana = limpa((await turnoHoje(rico, 'compara com a semana passada', focoMes)).reply)
    out.push(result('CS-graos-diferentes', semana, 'semana contra semana, nunca o mês contra uma semana',
      /semana passada/i.test(semana) && !/^Total gasto este mês/.test(semana)))
  }

  // "Quanto almocei esse mês" é Alimentação, não o gasto do mês inteiro.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const comida = rico.transactions.filter(t => t.type === 'expense' && t.category === 'alimentacao'
      && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje).reduce((a, t) => a + t.amount, 0)
    for (const [id, msg] of [['QA-almocei', 'quanto almocei esse mes'], ['QA-jantei', 'quanto jantei esse mes']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      out.push(result(id, r, `Alimentação ${fmt(comida)}`, comida > 0 && r.includes(fmt(comida)) && !/^Total gasto este mês/.test(r)))
    }
  }

  // Refeição é gasto sem "gastei" ("almocei 32 reais"), e dois itens com "e"
  // antes do valor ("comprei pão e leite 18") são um gasto só. As duas caíam
  // na ajuda genérica.
  {
    const rico = autonomoRico(hoje)
    const gasto = async (msg: string) => ((await turnoHoje(rico, msg)).actions as { kind: string, amount?: number, category?: string }[])
    for (const [id, msg, valor] of [['RF-almocei', 'almocei 32 reais', 32], ['RF-jantei-no-lugar', 'jantei 45 no restaurante', 45],
      ['RF-comprei-dois-itens', 'comprei pão e leite 18', 18]] as const) {
      const a = await gasto(msg)
      out.push(result(id, a, `despesa de ${valor} em Alimentação`,
        a.length === 1 && a[0].kind === 'expense' && a[0].amount === valor && a[0].category === 'alimentacao'))
    }
    const semValor = await gasto('almocei com o joao hoje')
    out.push(result('RF-sem-valor-controle', semValor, 'nada a registrar', semValor.length === 0))
  }

  // "Quanto de fatura vence esse mês" é a soma das faturas a pagar (Inter
  // atrasada + Nubank de hoje = R$ 800,00), não o resumo dos cartões.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const esperadoFV = faturasAPagarEsperadas(rico, hoje)
    for (const [id, msg] of [['FV-quanto-de-fatura-vence', 'quanto de fatura vence esse mes'], ['FV-quanto-vence-de-fatura', 'quanto vence de fatura esse mes']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      out.push(result(id, r, esperadoFV.descricao, esperadoFV.confere(r) && !/Situação dos seus cartões/.test(r)))
    }
  }

  // O vencimento de uma parcela marcada como paga não é a data do pagamento.
  {
    const rico = autonomoRico(hoje)
    for (const [id, frase, rotulo] of [
      ['FP-paguei-mes-passado', 'quanto paguei de fatura mes passado', /mês passado/],
      ['FP-paguei-no-ano', 'quanto ja paguei de fatura esse ano', /este ano/],
      ['FP-paguei-sem-periodo', 'quanto paguei de fatura', /este mês/],
    ] as const) {
      const r = await turnoHoje(rico, frase)
      out.push(result(id, r, 'informa ausência de data de pagamento no período solicitado',
        r.actions.length === 0 && /Não tenho pagamento de fatura.*data registrada/.test(r.reply)
          && rotulo.test(r.reply) && !/R\$/.test(r.reply)))
    }

    const agora = hoje.slice(0, 7)
    const anterior = addDays(`${agora}-01`, -2)
    const antiga = anterior.slice(0, 7)
    const referencia = antiga.split('-').reverse().join('/')
    const nomeDoMes = MESES_PT_BR[Number(antiga.slice(5)) - 1]
    const st = buildState({ profile: 'autonomo', cards: [{ name: 'Inter' }, { name: 'Nubank' }] })
    st.cardPayments = [
      { id: 'old-paid-now', cardId: 'card0', referenceMonth: antiga, paymentDate: hoje, amount: 80 },
      { id: 'now-paid-old', cardId: 'card0', referenceMonth: agora, paymentDate: anterior, amount: 45 },
      { id: 'now-paid-now', cardId: 'card0', referenceMonth: agora, paymentDate: hoje, amount: 20 },
      { id: 'future-paid', cardId: 'card0', referenceMonth: antiga, paymentDate: addDays(hoje, 1), amount: 999 },
      { id: 'other-card', cardId: 'card1', referenceMonth: antiga, paymentDate: hoje, amount: 888 },
    ]
    const quandoPorReferencia = await turnoHoje(st, `Quando paguei a fatura do Inter de ${nomeDoMes} de ${antiga.slice(0, 4)}?`)
    const quandoPorData = await turnoHoje(st, 'Quando paguei fatura do Inter no mês passado?')
    const totalDoMes = await turnoHoje(st, 'Quanto paguei de faturas do Inter neste mês?')
    const totalAntigo = await turnoHoje(st, 'Quanto paguei de faturas do Inter mês passado?')
    const soDaFatura = await turnoHoje(st, `Quanto paguei da fatura do Inter de ${referencia}?`)
    const doisFiltros = await turnoHoje(st, `Quanto paguei da fatura do Inter de ${referencia} no mês passado?`)
    const arquivado = await turnoHoje({ ...st, cards: st.cards.map(c => ({ ...c, archived: true })) },
      `Qual a data do último pagamento da fatura do Inter de ${referencia}?`)
    const porValor = [totalDoMes, totalAntigo, soDaFatura].map(r => r.reply)
    const datas = [quandoPorReferencia.reply, quandoPorData.reply, arquivado.reply]
    out.push(result('FP-separa-data-de-desembolso-e-competencia', { porValor, datas, doisFiltros },
      'o período lê a data do pagamento; a referência lê o vencimento, os filtros podem coexistir e o histórico inclui cartões arquivados',
      /100,00/.test(porValor[0]) && /45,00/.test(porValor[1]) && /80,00/.test(porValor[2])
        && /80,00/.test(datas[0]) && !/45,00|20,00/.test(datas[0]) && /45,00/.test(datas[1]) && !/80,00/.test(datas[1])
        && /80,00/.test(datas[2]) && /não tenho pagamento/i.test(doisFiltros.reply)
        && [...porValor, ...datas].every(reply => !/999,00|888,00/.test(reply))
        && [quandoPorReferencia, quandoPorData, totalDoMes, totalAntigo, soDaFatura, doisFiltros, arquivado].every(r => !r.actions.length)))
  }

  // "Quanto posso gastar por dia" dava 70% do saldo menos só as contas fixas de
  // 7 dias, como gasto de HOJE: "R$ 9.586,50 hoje", com a fatura do Inter
  // atrasada e a do Nubank vencendo hoje (R$ 800,00) fora da conta. O limite
  // por dia tem que caber em 30 dias do saldo depois dessas faturas, e "esse
  // mês" vai até o último dia do mês. "Quanto devo gastar por dia" é a mesma
  // pergunta, não a média do que já foi gasto.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const saldo = currentBalance(rico)
    const valorDe = (s: string, re: RegExp) => { const m = s.match(re); return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : NaN }
    for (const [id, msg] of [['GD-posso-por-dia', 'quanto posso gastar por dia'], ['GD-devo-por-dia', 'quanto devo gastar por dia']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      const porDia = valorDe(r, /R\$ ([\d.]+,\d{2}) por dia/)
      out.push(result(id, r, `por dia ≤ (saldo − faturas) / 30 = ${((saldo - 800) / 30).toFixed(2)}, com as faturas na conta`,
        porDia > 0 && porDia <= (saldo - 800) / 30 + 0.01 && /Inter/.test(r) && /Nubank/.test(r) && !/hoje mantendo|Dividido pelos/.test(r)))
    }
    const ultimo = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)), 0)
    const fimDoMes = `${String(ultimo.getDate()).padStart(2, '0')}/${hoje.slice(5, 7)}`
    const mes = limpa((await turnoHoje(rico, 'quanto posso gastar esse mes')).reply)
    out.push(result('GD-posso-esse-mes', mes, `até ${fimDoMes}, com as faturas na conta`,
      mes.includes(fimDoMes) && /Inter/.test(mes) && !/hoje mantendo/.test(mes)))
  }

  // Lista dos parcelamentos: quais são, quantas parcelas faltam, quanto foi
  // parcelado num cartão e quando foi a compra. Antes: a soma sem nomes, o
  // resumo dos cartões sem contagem, a fatura do mês e a ajuda genérica.
  // Fixture: Computador (Nubank) 4.000 em 10x, 8 pendentes; Geladeira (Inter)
  // 2.400 em 6x, 5 pendentes — 13 parcelas, R$ 5.200,00.
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const quais = limpa((await turnoHoje(rico, 'quais meus parcelamentos')).reply)
    out.push(result('LP-quais-parcelamentos', quais, 'Computador R$ 3.200,00 e Geladeira R$ 2.000,00; 13 parcelas',
      /Computador/.test(quais) && /Geladeira/.test(quais) && /R\$ 3\.200,00/.test(quais) && /R\$ 2\.000,00/.test(quais) && /\b13 parcelas\b/.test(quais)))
    for (const [id, msg] of [['LP-quantas-parcelas-tenho', 'quantas parcelas eu tenho'], ['LP-quantas-parcelas-faltam', 'quantas parcelas faltam']]) {
      const r = limpa((await turnoHoje(rico, msg)).reply)
      out.push(result(id, r, '13 parcelas', /\b13 parcelas\b/.test(r) && !/Situação dos seus cartões/.test(r)))
    }
    const parcelei = limpa((await turnoHoje(rico, 'quanto parcelei no nubank')).reply)
    out.push(result('LP-parcelei-no-cartao', parcelei, 'Computador, R$ 4.000,00 no Nubank',
      /Computador/.test(parcelei) && /R\$ 4\.000,00/.test(parcelei) && !/Geladeira/.test(parcelei)))
    const compra = rico.installmentPlans.find(p => p.id === 'p2')!.purchaseDate
    const dataCompra = `${compra.slice(8, 10)}/${compra.slice(5, 7)}/${compra.slice(0, 4)}`
    const quando = limpa((await turnoHoje(rico, 'quando comprei a geladeira')).reply)
    out.push(result('LP-quando-comprei', quando, `Geladeira comprada em ${dataCompra}`,
      /Geladeira/.test(quando) && quando.includes(dataCompra)))
  }

  // Comprar o APARELHO é compra; "celular" sozinho é a conta do telefone. "Comprei
  // um celular de 1200 em 10x" ia para Assinaturas.
  {
    const rico = autonomoRico(hoje)
    const cat = async (msg: string) => ((await turnoHoje(rico, msg)).actions as { category?: string }[])[0]?.category
    for (const [id, msg] of [['CEL-comprei-parcelado', 'comprei um celular de 1200 em 10x no nubank'],
      ['CEL-comprei-a-vista', 'comprei um celular de 900']]) {
      const c = await cat(msg)
      out.push(result(id, c, 'compras', c === 'compras'))
    }
    const conta = await cat('paguei 60 do celular')
    out.push(result('CEL-conta-do-celular-controle', conta, 'assinaturas (a conta)', conta === 'assinaturas'))
  }

  // "Receber" e "entrar" no infinitivo são entrada. Sem eles, "quanto vou
  // receber esse mes" respondia "Total gasto este mês: R$ 2.373,00".
  {
    const limpa = (s: string) => s.replace(/ /g, ' ')
    const rico = autonomoRico(hoje)
    const fmt = (v: number) => `R$ ${v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
    const doMes = (tipo: string) => rico.transactions.filter(t => t.type === tipo && t.date.slice(0, 7) === hoje.slice(0, 7) && t.date <= hoje)
      .reduce((a, t) => a + t.amount, 0)
    const receber = limpa((await turnoHoje(rico, 'quanto vou receber esse mes')).reply)
    out.push(result('EN-vou-receber-no-mes', receber, 'sem entradas recorrentes cadastradas; não usar o recebido como previsão',
      /previst|cadastrad/i.test(receber) && !receber.includes(fmt(doMes('income'))) && !/gasto|dado real/i.test(receber)))
    const entrar = limpa((await turnoHoje(rico, 'quanto vai entrar esse mes')).reply)
    out.push(result('EN-vai-entrar-no-mes', entrar, 'sem previsão cadastrada; não usar histórico realizado',
      /previst|cadastrad/i.test(entrar) && !entrar.includes(fmt(doMes('income'))) && !/gasto|dado real/i.test(entrar)))
    // Mês à frente com verbo no futuro: nada do ano passado com cara de dado.
    const alvo = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) + 1, 1)
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const anoPassado = `${alvo.getFullYear() - 1}-${String(alvo.getMonth() + 1).padStart(2, '0')}-10`
    const comHistorico = { ...rico, transactions: [...rico.transactions,
      { ...rico.transactions.find(t => t.type === 'income')!, id: 'en-ano-passado', amount: 1777, date: anoPassado, createdAt: `${anoPassado}T10:00` }] }
    const futuro = limpa((await turnoHoje(comHistorico, `quanto vou receber em ${nomes[alvo.getMonth()]}`)).reply)
    out.push(result('EN-vou-receber-mes-a-frente', futuro, `${nomes[alvo.getMonth()]} que vem, nunca os R$ 1.777,00 do ano anterior`,
      !/gasto/i.test(futuro) && !/R\$ 1\.777,00/.test(futuro) && !futuro.includes(`/${alvo.getFullYear() - 1}`)))
  }

  // Pedido de APAGAR nunca cria lançamento: "exclui a despesa de 120 da luz"
  // virava uma despesa NOVA de R$ 120, e "apaga o gasto do mercado" respondia
  // "não registrei nada", como negação.
  {
    const st = autonomoRico(hoje)
    for (const frase of ['exclui a despesa de 120 da luz', 'apaga o gasto do mercado', 'remove o lançamento de ontem',
      'deleta a receita de 1200 da casa 2']) {
      const r = await turnoHoje(st, frase)
      out.push(result(`AP-${frase.replace(/\W+/g, '-')}`, { reply: r.reply, actions: r.actions }, 'nenhuma ação; aponta Movimentações',
        r.actions.length === 0 && /Movimenta[çc][õo]es/.test(r.reply) && !/n[ãa]o registrei nada/i.test(r.reply)))
    }
  }

  // A pergunta que repete o verbo do registro é uma cláusula só: "quanto
  // gastei de alimentação" era cortado em "quanto" + "gastei de alimentação",
  // e nenhuma das duas metades tinha resposta.
  for (const [frase, pergunta] of [
    ['gastei 50 no mercado, quanto gastei de alimentacao esse mes?', 'quanto gastei de alimentacao esse mes?'],
    ['recebi 1200 da casa 2 e quanto eu recebi esse mes?', 'quanto eu recebi esse mes?'],
    ['paguei 80 de luz, qual conta eu paguei mais caro?', 'qual conta eu paguei mais caro?'],
  ] as [string, string][]) {
    const partes = segment(frase).map(c => c.text.trim())
    out.push(result(`Y-pergunta-inteira-${pergunta.split(' ').slice(0, 2).join('-')}`, partes, `cláusula "${pergunta}" inteira`,
      partes.some(p => p.replace(/^e\s+/, '') === pergunta) && !partes.includes('e')))
  }

  // A data do pagamento vem do evento, nunca do vencimento ou de uma parcela
  // marcada paga sem data. Pagamento parcial não prova quitação da fatura.
  {
    const st = autonomoRico(hoje)
    const pagoEm = addDays(hoje, -2)
    const data = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
    st.cardPayments = [{ id: 'hp-parcial', cardId: st.cards[0].id, amount: 123,
      paymentDate: pagoEm, referenceMonth: hoje.slice(0, 7), settledInstallmentIds: [] },
      { id: 'hp-futuro', cardId: st.cards[0].id, amount: 456, paymentDate: addDays(hoje, 1), referenceMonth: hoje.slice(0, 7) },
      { id: 'hp-invalido', cardId: st.cards[0].id, amount: 789, paymentDate: '2026-02-31', referenceMonth: '2026-02' }]
    for (const message of ['quando paguei a fatura do nubank', 'que dia paguei a fatura do nubank?',
      'quando foi o último pagamento da fatura do nubank?']) {
      const r = await turnoHoje(st, message)
      out.push(result(`HP-${message}`, r, 'data do evento e valor parcial 123; sem afirmar quitação',
        r.reply.includes(data(pagoEm)) && /123,00/.test(r.reply) && !/456,00|789,00/.test(r.reply) && /pagamento/i.test(r.reply)
          && !/est[aá] paga|quitad[ao]/i.test(r.reply) && r.actions.length === 0))
    }
    const semEvento = await turnoHoje({ ...st, cardPayments: [] }, 'quando paguei a fatura do nubank')
    out.push(result('HP-sem-evento-nao-inventa-data', semEvento, 'sem data de pagamento registrada',
      /n[ãa]o.*pagamento|sem.*pagamento/i.test(semEvento.reply) && !/Situa[çc][ãa]o dos seus cart[õo]es/i.test(semEvento.reply)
        && semEvento.actions.length === 0))
    const outro = await turnoHoje(st, 'quando paguei a fatura do inter')
    out.push(result('HP-respeita-cartao', outro, 'não atribuir o pagamento do Nubank ao Inter',
      !/123,00/.test(outro.reply) && /n[ãa]o.*pagamento|sem.*pagamento/i.test(outro.reply)
        && outro.actions.length === 0))
  }

  {
    const st = motoristaRico(hoje)
    for (const phrase of ['troquei o óleo com 45 mil km', 'troquei o óleo aos 45000 km ontem']) {
      const first = await orchestrate({ state: st, message: phrase, today: hoje, remoteEnabled: false })
      const second = await orchestrate({ state: st, message: 'aos 45000 km, custou 180', draft: first.draft || undefined,
        today: hoje, remoteEnabled: false })
      const maintenance = second.response.actions.map(a => a.action)
      out.push(result(`MCO-${phrase}`, { first, second }, 'pergunta custo; manutenção de 180 aos 45000 km após resposta',
        first.response.mode === 'clarify' && /quanto|valor|cust/i.test(first.response.reply)
          && first.response.actions.length === 0 && maintenance.length === 1
          && maintenance[0].kind === 'maintenance' && maintenance[0].cost === 180
          && maintenance[0].km === 45000 && /[óo]leo/i.test(maintenance[0].item)
          && (!/ontem/.test(phrase) || maintenance[0].date === addDays(hoje, -1))))
    }
    const question = await turnoHoje(st, 'quando troquei o óleo com 45 mil km?')
    out.push(result('MCO-pergunta-nao-vira-registro', question, 'nenhuma manutenção proposta por pergunta',
      question.actions.length === 0))
  }

  {
    const st = buildState({ profile: 'autonomo' })
    const proximo = fromISO(hoje)
    proximo.setMonth(proximo.getMonth() + 1, 1)
    const outroMes = toISOdate(proximo).slice(0, 7)
    const renda = (id: string, amount: number) => ({ id, name: `Recebimento ${id}`, amount,
      frequency: 'monthly' as const, dueDay: Number(hoje.slice(8)), startDate: hoje,
      category: 'salario', kind: 'income' as const, active: true })
    st.recurring = [renda('aberta', 650), { ...renda('paga', 4500), endDate: hoje,
      occurrences: [{ date: hoje, status: 'confirmed', txId: 'renda-real' }] },
      { ...renda('dispensada', 400), endDate: hoje, occurrences: [{ date: hoje, status: 'skipped' }] }]
    st.transactions = [{ id: 'renda-real', type: 'income', category: 'salario', amount: 9000,
      date: hoje, recurringId: 'paga', occurrenceDate: hoje }]
    for (const phrase of ['quanto vou receber esse mes', 'quanto vai entrar esse mes', 'quanto vou receber mês que vem']) {
      const r = await turnoHoje(st, phrase)
      out.push(result(`RFUT-${phrase}`, r, 'só previsão aberta de 650, sem somar 9000 recebidos ou 400 dispensados',
        /650,00/.test(r.reply) && !/9\.000,00|4\.500,00|400,00|dado real/.test(r.reply)
          && /previst|previs[ãa]o/i.test(r.reply) && r.focus?.lastQueryPlan?.source === 'recurring'
          && r.actions.length === 0 && (!/vem/.test(phrase) || r.focus?.lastQueryPlan?.period.from.startsWith(outroMes))))
    }
    const passado = await turnoHoje(st, 'quanto recebi esse mes')
    out.push(result('RFUT-recebido-continua-realizado', passado, 'receita realizada 9000, nunca previsão 650',
      /9\.000,00/.test(passado.reply) && !/650,00/.test(passado.reply) && passado.actions.length === 0))
    const semPrevisao = await turnoHoje({ ...st, recurring: [] }, 'quanto vou receber mês que vem')
    out.push(result('RFUT-sem-previsao-explicita', semPrevisao, 'não prometer zero nem o histórico como receita futura',
      /previst|cadastrad/i.test(semPrevisao.reply) && !/9\.000,00|dado real/.test(semPrevisao.reply)
        && semPrevisao.actions.length === 0))
  }

  {
    const amanha = addDays(hoje, 1)
    const st = buildState({ profile: 'autonomo' })
    st.recurring = [{ id: 'weekly-forecast', name: 'Freela previsto', amount: 650,
      frequency: 'monthly', dueDay: Number(amanha.slice(8)), startDate: amanha, endDate: amanha,
      category: 'freelance', kind: 'income', active: true }]
    st.transactions = [{ id: 'weekly-real', type: 'income', amount: 9000, category: 'freelance',
      date: addDays(hoje, -1), time: '12:00' }]
    for (const phrase of ['quanto vou receber esta semana?', 'quanto vai entrar essa semana?']) {
      const r = await turnoHoje(st, phrase)
      out.push(result(`RSEM-previsao-${phrase}`, r,
        'próximos sete dias incluem entrada de amanhã650, sem somar os9000 já recebidos',
        /650,00/.test(r.reply) && !/9\.000,00/.test(r.reply)
          && r.focus?.lastQueryPlan?.source === 'recurring'
          && r.focus?.lastQueryPlan?.period.from === hoje
          && r.focus?.lastQueryPlan?.period.to === addDays(hoje, 6)
          && r.actions.length === 0))
    }
    const realized = await turnoHoje(st, 'quanto recebi esta semana?')
    out.push(result('RSEM-realizado-continua-passado', realized,
      'recebido usa últimos sete dias:9000, sem previsão650',
      /9\.000,00/.test(realized.reply) && !/650,00/.test(realized.reply)
        && realized.focus?.lastQueryPlan?.source === 'transactions' && realized.actions.length === 0))
  }

  for (const future of ['amanhã pago a luz 180', 'depois de amanhã vou pagar 180 de luz']) {
    const r = await turnoHoje(autonomoRico(hoje), `quero juntar 1000 pra viagem e ${future}`)
    out.push(result(`MFUT-${future}`, r, 'meta 1000 preservada e intenção futura explicada, sem despesa 180',
      r.actions.length === 1 && r.actions[0].kind === 'goal' && r.actions[0].target === 1000
        && /futur|ainda n[ãa]o|n[ãa]o registrei essa parte|planejad/i.test(r.reply)
        && /180/.test(r.reply)))
  }

  {
    const st = autonomoRico(hoje)
    for (const phrase of ['quanto guardei nas metas esse mes', 'quanto depositei na viagem esse mes']) {
      const r = await turnoHoje(st, phrase)
      out.push(result(`HMETA-${phrase}`, r, 'explicar ausência de histórico mensal, sem atribuir o acumulado ao mês',
        /hist[óo]rico|data.*dep[óo]sito/i.test(r.reply) && !/6\.000,00|4\.800,00|dado real/.test(r.reply)
          && r.actions.length === 0 && r.focus?.lastQuery?.empty === true))
    }
    const total = await turnoHoje(st, 'quanto já guardei nas metas')
    out.push(result('HMETA-total-acumulado-preservado', total, 'total atual 6000 pode ser consultado',
      /6\.000,00/.test(total.reply) && total.actions.length === 0
        && /4\.800,00/.test(total.focus?.lastQuery?.explain || '')
        && !/2\.800,00/.test(total.focus?.lastQuery?.explain || '')))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', dueDay: Number(addDays(hoje, 3).slice(8)), closingDay: 1 }] })
    st.installmentPlans = [{ id: 'scf-plan', description: 'Compra', cardId: 'card0', totalAmount: 1200,
      installmentCount: 1, firstDueDate: addDays(hoje, 3), purchaseDate: addDays(hoje, -20),
      createdAt: addDays(hoje, -20), status: 'active', operationType: 'card-purchase' }]
    for (const offset of [3, -3]) {
      st.installments = [{ id: 'scf-installment', planId: 'scf-plan', number: 1, total: 1,
        amount: 1200, dueDate: addDays(hoje, offset), status: 'pending' }]
      const r = await turnoHoje(st, 'se eu gastar 100 hoje, dá ruim?')
      out.push(result(`SCF-fatura-${offset}`, r, 'saldo 900 não cobre fatura 1200; falta 300',
        r.focus?.lastScenario?.feasible === false && /1\.200,00/.test(r.reply)
          && /300,00/.test(r.reply) && /fatura/i.test(r.reply) && r.actions.length === 0))
    }
    st.installments[0].status = 'paid'
    const pago = await turnoHoje(st, 'se eu gastar 100 hoje, dá ruim?')
    out.push(result('SCF-fatura-paga-nao-recobra', pago, 'não contar como devida a parcela já quitada',
      pago.focus?.lastScenario?.feasible === true && !/1\.200,00/.test(pago.reply) && pago.actions.length === 0))
    st.installments[0].status = 'pending'
    st.settings.balance = 1500
    const ontem = addDays(hoje, -1)
    st.recurring = [{ id: 'scf-incerta', name: 'Conta sem confirmação', amount: 500, frequency: 'monthly',
      dueDay: Number(ontem.slice(8)), startDate: ontem, endDate: ontem, category: 'casa', kind: 'expense', active: true }]
    const incerto = await turnoHoje(st, 'se eu gastar 100 hoje, dá ruim?')
    out.push(result('SCF-pendencia-pode-mudar-veredito', incerto, 'não afirmar que cabe enquanto a conta vencida pode mudar o resultado',
      incerto.focus?.lastScenario?.feasible === undefined && /sem confirma[çc][ãa]o/.test(incerto.reply)
        && incerto.actions.length === 0))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', dueDay: 18, closingDay: 1 }] })
    st.settings.balanceAsOf = TODAY
    st.transactions = [{ id: 'rent-history', type: 'income', category: 'aluguel', amount: 500,
      origin: 'Casa 1', date: '2026-09-05' }]
    st.installmentPlans = [{ id: 'missing-plan', description: 'Compra', cardId: 'card0', totalAmount: 1200,
      installmentCount: 1, firstDueDate: '2026-09-18', purchaseDate: '2026-08-25',
      createdAt: '2026-08-25', status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'missing-installment', planId: 'missing-plan', number: 1, total: 1,
      amount: 1200, dueDate: '2026-09-18', status: 'pending' }]
    const before = JSON.stringify(st)
    const missing = await turn(st, 'e se a Casa 1 não pagar?')
    out.push(result('IMISS-fatura-nao-omitida', missing, 'saldo 1000 menos fatura 1200 deixa -200, sem duplicar renda histórica',
      missing.focus?.lastScenario?.feasible === false && /1\.200,00/.test(missing.reply)
        && /-R\$\s*200,00/.test(missing.reply) && /fatura/i.test(missing.reply) && missing.actions.length === 0))
    const verdict = await turn(st, 'dá ruim?', missing.focus)
    out.push(result('IMISS-veredito-continuado', verdict, 'não declarar que a ausência da renda cabe no saldo',
      verdict.focus?.lastScenario?.feasible === false && /^Dá ruim\./i.test(verdict.reply)))
    const spend = await turn(st, 'e se eu gastar 100 hoje?', missing.focus)
    out.push(result('SCEN-nova-hipotese-explicita', spend, 'nova hipótese de gasto 100, não esclarecimento do cenário anterior',
      spend.focus?.lastScenarioPlan?.kind === 'spend' && spend.focus.lastScenarioPlan.amount === 100
        && spend.focus.lastScenario?.feasible === false && /-R\$\s*300,00/.test(spend.reply) && spend.actions.length === 0))
    out.push(result('IMISS-somente-leitura', JSON.stringify(st), before, JSON.stringify(st) === before))
    st.transactions.push({ id: 'future-income', type: 'income', category: 'aluguel', amount: 9500,
      origin: 'Casa 1', date: '2026-09-25' })
    const future = await turn(st, 'e se a Casa 1 não pagar?')
    out.push(result('IMISS-media-exclui-futuro', future, 'base histórica apenas até a data injetada: 500, não 10000',
      future.focus?.lastScenario?.facts.find(f => f.label.startsWith('Entrada'))?.value === 500))
    st.transactions.pop()
    st.installments[0].status = 'paid'
    const paid = await turn(st, 'e se a Casa 1 não pagar?')
    out.push(result('IMISS-fatura-paga', paid, 'não recobrar dívida quitada nem subtrair renda não projetada',
      paid.focus?.lastScenario?.feasible === true && /1\.000,00/.test(paid.reply) && !/1\.200,00/.test(paid.reply)))
    st.recurring = [{ id: 'missing-uncertain', name: 'Conta sem confirmação', amount: 1500, frequency: 'monthly',
      dueDay: 14, startDate: '2026-09-14', endDate: '2026-09-14', category: 'casa', kind: 'expense', active: true }]
    const uncertain = await turn(st, 'e se a Casa 1 não pagar?')
    out.push(result('IMISS-pendencia-incerta', uncertain, 'sem veredito quando pendência pode inverter resultado',
      uncertain.focus?.lastScenario?.feasible === undefined && /sem confirma[çc][ãa]o/.test(uncertain.reply)
        && !/Ainda dá para|Assim as contas não fecham/.test(uncertain.reply)))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000 })
    st.recurring = [
      { ...recurringIncome(650), id: 'house1', name: 'Casa 1', category: 'aluguel', origin: 'Casa 1' },
      { ...recurringIncome(350), id: 'house2', name: 'Casa 2', category: 'aluguel', origin: 'Casa 2' },
    ]
    st.transactions = [
      { id: 'received-house1', type: 'income', category: 'aluguel', amount: 9000, origin: 'Casa 1', date: TODAY },
      { id: 'received-house2', type: 'income', category: 'aluguel', amount: 4000, origin: 'Casa 2', date: TODAY },
    ]
    const first = await turn(st, 'quanto vou receber da Casa 1 mês que vem?')
    out.push(result('QMOD-futuro-base-com-origem', first, 'previsão 650 da Casa 1, não 1000 de todas',
      first.focus?.lastQuery?.total === 650 && first.focus.lastQueryPlan?.source === 'recurring'))
    const real = await turn(st, 'e quanto recebi esse mes?', first.focus)
    out.push(result('QMOD-futuro-para-real', real, '9000 recebidos da mesma origem; fonte e filtro de previsão removidos',
      real.focus?.lastQuery?.total === 9000 && real.focus.lastQueryPlan?.source === 'transactions'
        && !real.focus.lastQueryPlan.filter.plannedOnly && /9\.000,00/.test(real.reply)
        && !/previs[ãa]o/.test(real.reply) && real.actions.length === 0))
    const forecast = await turn(st, 'e a previsão deste mês?', real.focus)
    out.push(result('QMOD-real-para-previsao', forecast, '650 previstos da Casa 1 entre hoje e o fim do mês',
      forecast.focus?.lastQuery?.total === 650 && forecast.focus.lastQueryPlan?.source === 'recurring'
        && forecast.focus.lastQueryPlan.period.from === TODAY && forecast.focus.lastQueryPlan.period.to === '2026-09-30'
        && forecast.focus.lastQueryPlan.filter.plannedOnly === true && /previs[ãa]o/.test(forecast.reply)))
    const changed = await turn(st, 'e quanto recebi da Casa 2 esse mes?', forecast.focus)
    out.push(result('QMOD-origem-explicita-substitui', changed, 'origem explícita nova substitui Casa 1: 4000',
      changed.focus?.lastQuery?.total === 4000 && changed.actions.length === 0))
    for (const phrase of ['e esse mês?', 'e neste mês?', 'e este mês?']) {
      const periodOnly = await turn(st, phrase, first.focus)
      out.push(result(`QMOD-janela-prevista-${phrase}`, periodOnly, 'continuidade só de mês mantém previsão futura650 até30/09',
        periodOnly.focus?.lastQuery?.total === 650 && periodOnly.focus.lastQueryPlan?.period.from === TODAY
          && periodOnly.focus.lastQueryPlan.period.to === '2026-09-30' && /previs[ãa]o/.test(periodOnly.reply)))
    }
    const otherForecast = await turn(st, 'e da Casa 2 esse mês?', first.focus)
    out.push(result('QMOD-periodo-e-outra-origem-prevista', otherForecast, 'Casa2 prevista350, de hoje ao fim do mês',
      otherForecast.focus?.lastQuery?.total === 350 && /Casa 2/.test(otherForecast.reply)
        && otherForecast.focus.lastQueryPlan?.period.to === '2026-09-30'))
    const otherReal = await turn(st, 'e da Casa 2 esse mês?', real.focus)
    out.push(result('QMOD-periodo-e-outra-origem-real', otherReal, 'Casa2 recebida4000 neste mês',
      otherReal.focus?.lastQuery?.total === 4000 && /Casa 2/.test(otherReal.reply)))
  }

  {
    const st = autonomoRico(TODAY)
    const monthly = await turn(st, 'quanto guardei nas metas esse mes')
    const total = await turn(st, 'e no total?', monthly.focus)
    out.push(result('HMETA-mensal-para-total', total, 'total atual 6000 após explicar ausência de histórico mensal',
      total.focus?.lastQuery?.total === 6000 && /6\.000,00/.test(total.reply) && total.actions.length === 0))
    const named = await turn(st, 'e na viagem?', total.focus)
    out.push(result('HMETA-total-restringe-meta', named, 'Viagem: saldo acumulado 4800',
      named.focus?.lastQuery?.total === 4800 && /4\.800,00/.test(named.reply)))
    const lastMonth = await turn(st, 'e no mês passado?', named.focus)
    const again = await turn(st, 'e até agora?', lastMonth.focus)
    out.push(result('HMETA-ate-agora-preserva-meta', { lastMonth, again }, 'mês passado continua indisponível; até agora recupera Viagem4800',
      lastMonth.focus?.lastQuery?.empty === true && /hist[óo]rico/.test(lastMonth.reply)
        && again.focus?.lastQuery?.total === 4800 && /4\.800,00/.test(again.reply)))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', dueDay: 18, closingDay: 1 }] })
    st.installmentPlans = [{ id: 'home-plan', description: 'Compra', cardId: 'card0', totalAmount: 1200,
      installmentCount: 1, firstDueDate: '2026-09-18', purchaseDate: '2026-08-25',
      createdAt: '2026-08-25', status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'home-installment', planId: 'home-plan', number: 1, total: 1,
      amount: 1200, dueDate: '2026-09-18', status: 'pending' }]
    const before = JSON.stringify(st)
    const debt = balanceOutlook(st, 7, TODAY)
    out.push(result('HOME-fatura-no-compromisso', debt, 'compromissos 1200, falta200, sem duplicação da parcela',
      debt.billsSoon === 1200 && debt.shortfall === 200 && debt.ok === false))
    st.installments[0].status = 'paid'
    const paid = balanceOutlook(st, 7, TODAY)
    out.push(result('HOME-fatura-paga-nao-recobra', paid, 'nenhum compromisso após quitar parcela',
      paid.billsSoon === 0 && paid.ok === true))
    st.recurring = [{ id: 'home-uncertain', name: 'Luz', amount: 1500, frequency: 'monthly',
      dueDay: 14, startDate: '2026-09-14', endDate: '2026-09-14', category: 'casa', kind: 'expense', active: true }]
    const uncertain = balanceOutlook(st, 7, TODAY)
    out.push(result('HOME-conta-vencida-sem-veredito', uncertain, 'conta sem confirmação não é dívida certa, mas pode impedir cobertura',
      uncertain.ok === undefined && uncertain.billsSoon === 0 && uncertain.unconfirmed.length === 1
        && /sem confirma[çc][ãa]o/.test(balanceOutlookText(uncertain))
        && !/saldo cobre esse total/.test(balanceOutlookText(uncertain))))
    st.recurring = []
    st.installments[0].status = 'pending'
    st.installments[0].dueDate = '2026-09-10'
    const overdue = balanceOutlook(st, 7, TODAY)
    out.push(result('HOME-fatura-atrasada-incluida', overdue, 'inclui fatura vencida ainda em aberto',
      overdue.billsSoon === 1200 && overdue.ok === false))
    st.installments[0].dueDate = '2026-09-18'
    out.push(result('HOME-leitura-nao-muta', JSON.stringify(st), before, JSON.stringify(st) === before))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000 })
    st.settings.balanceAsOf = `${hoje}T00:00:00`
    st.transactions = [
      { id: 'cash-today', type: 'income', category: 'salario', amount: 100, date: hoje, time: '12:00' },
      { id: 'cash-future-income', type: 'income', category: 'salario', amount: 9000, date: addDays(hoje, 1) },
      { id: 'cash-future-expense', type: 'expense', category: 'casa', amount: 2000, date: addDays(hoje, 2) },
    ]
    const tx = currentBalance(st)
    out.push(result('CAIXA-data-futura-nao-disponivel', tx, 'saldo hoje1100; receita e despesa futuras não movimentam caixa atual', tx === 1100))
    st.transactions = []
    st.cardPayments = [{ id: 'future-card-payment', cardId: 'unused-card', amount: 200,
      paymentDate: addDays(hoje, 1), referenceMonth: hoje.slice(0, 7), fromBalance: true }]
    const payment = currentBalance(st)
    out.push(result('CAIXA-pagamento-futuro-nao-sai', payment, 'pagamento de fatura amanhã não reduz saldo hoje1000', payment === 1000))
    st.cardPayments = []
    st.installmentPlans = [{ id: 'cash-direct', description: 'Acordo', totalAmount: 300, installmentCount: 1,
      firstDueDate: addDays(hoje, 1), purchaseDate: hoje, createdAt: hoje, status: 'active', operationType: 'standalone' }]
    st.installments = [{ id: 'cash-direct-1', planId: 'cash-direct', number: 1, total: 1, amount: 300,
      dueDate: addDays(hoje, 1), status: 'paid', paidAt: addDays(hoje, 1) }]
    const direct = currentBalance(st)
    out.push(result('CAIXA-quitacao-direta-futura', direct, 'quitação direta com data futura não reduz saldo hoje', direct === 1000))
    st.installments[0] = { ...st.installments[0], status: 'pending', paidAmount: 200,
      directPayments: [{ amount: 100, date: hoje, time: '12:00' }, { amount: 100, date: addDays(hoje, 1), time: '12:00' }] }
    const partial = currentBalance(st)
    out.push(result('CAIXA-parcial-apenas-ate-hoje', partial, 'sai somente o parcial de hoje: saldo900', partial === 900))
    st.transactions = [{ id: 'explicit-asof', type: 'income', category: 'salario', amount: 300,
      date: addDays(hoje, 2), time: '12:00' }]
    const projectedDate = currentBalance(st, addDays(hoje, 1))
    out.push(result('CAIXA-referencia-injetada', projectedDate, 'no dia seguinte saíram dois parciais, mas receita de depois ainda não:800',
      projectedDate === 800))
    st.installments = []
    const real = await turnoHoje(st, 'qual meu saldo?')
    out.push(result('CAIXA-chat-nao-antecipa-receita', real, 'chat usa saldo1000, não1300 com receita futura',
      /1\.000,00/.test(real.reply) && !/1\.300,00/.test(real.reply) && real.actions.length === 0))
    st.transactions[0].amount = 9000
    const spend = await turnoHoje(st, 'se eu gastar 1200 hoje, cabe?')
    out.push(result('CAIXA-cenario-nao-usa-receita-futura', spend, 'gasto1200 não cabe em1000, mesmo com9000 futuros',
      spend.focus?.lastScenario?.feasible === false && spend.actions.length === 0))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', dueDay: Number(addDays(hoje, 3).slice(8)), closingDay: 1 }] })
    st.installmentPlans = [{ id: 'payment-date-plan', description: 'Compra', cardId: 'card0', totalAmount: 300,
      installmentCount: 1, firstDueDate: addDays(hoje, 3), purchaseDate: hoje,
      createdAt: hoje, status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'payment-date-installment', planId: 'payment-date-plan', number: 1, total: 1,
      amount: 300, dueDate: addDays(hoje, 3), status: 'pending' }]
    for (const date of [addDays(hoje, 1), '', '2026-02-30']) {
      const payment = reducer(st, { type: 'addCardPayment', payment: { id: 'invalid-date-payment', cardId: 'card0',
        amount: 300, paymentDate: date, referenceMonth: addDays(hoje, 3).slice(0, 7), fromBalance: true },
        settleInstallmentIds: ['payment-date-installment'] })
      const direct = reducer(st, { type: 'payInstallment', id: 'payment-date-installment', paidAt: date })
      const partial = reducer(st, { type: 'partialPayInstallment', id: 'payment-date-installment', paidAt: date, amount: 100 })
      out.push(result(`PDATE-rejeita-${date || 'vazia'}`, { payment, direct, partial }, 'datas futuras/inválidas não quitam dívida nem salvam pagamento',
        payment === st && direct === st && partial === st))
    }
    const early = reducer(st, { type: 'addCardPayment', payment: { id: 'early-payment', cardId: 'card0', amount: 300,
      paymentDate: hoje, referenceMonth: addDays(hoje, 3).slice(0, 7), fromBalance: true },
      settleInstallmentIds: ['payment-date-installment'] })
    out.push(result('PDATE-pagamento-hoje-fatura-futura', early.installments[0], 'pagamento de hoje pode quitar parcela de fatura que ainda vencerá',
      early.cardPayments.length === 1 && early.installments[0].status === 'paid'))
  }

  {
    const amanha = addDays(hoje, 1)
    const st = buildState({ profile: 'autonomo', balance: 1000, cards: [{ name: 'Inter' }] })
    st.installmentPlans = [{ id: 'legacy-future-plan', description: 'Compra', cardId: 'card0', totalAmount: 300,
      installmentCount: 1, firstDueDate: hoje, purchaseDate: addDays(hoje, -20),
      createdAt: addDays(hoje, -20), status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'legacy-future-installment', planId: 'legacy-future-plan', number: 1, total: 1,
      amount: 300, dueDate: hoje, status: 'paid', paidAt: amanha, paidAmount: 300, paidVia: 'invoice' }]
    st.cardPayments = [{ id: 'legacy-future-payment', cardId: 'card0', amount: 300,
      paymentDate: amanha, referenceMonth: hoje.slice(0, 7), fromBalance: true,
      settledInstallmentIds: ['legacy-future-installment'] }]
    const inv = cardInvoice(st, st.cards[0], hoje.slice(0, 7))
    const ov = cardsOverview(st)
    const chat = await turnoHoje(st, 'quanto falta pagar da fatura do Inter?')
    out.push(result('PLEG-fatura-futura-nao-quitada-hoje', { inv, ov, balance: currentBalance(st) },
      'pagamento legado de amanhã não quita fatura ou dívida hoje; saldo permanece1000',
      inv.paid === 0 && inv.pending === 300 && inv.status !== 'paga'
        && invoiceOpenAmount(st, inv) === 300 && ov.totalDebt === 300
        && ov.usedLimit === 300 && currentBalance(st) === 1000))
    out.push(result('PLEG-chat-mostra-pendencia-hoje', chat,
      'consulta real da fatura informa300 pendentes, sem alegar quitação futura',
      /300,00/.test(chat.reply) && !/quitad|paga integralmente/i.test(chat.reply)
        && chat.actions.length === 0))
    const duplicateInvoice = applyBatchPure(st,
      [{ id: 'duplicate-legacy-invoice', action: { kind: 'card-payment', cardName: 'Inter', amount: 300 } }],
      { now: { date: hoje, time: '14:00' } })
    const duplicateReducer = reducer(st, { type: 'addCardPayment',
      payment: { id: 'duplicate-direct-reducer', cardId: 'card0', amount: 300,
        paymentDate: hoje, referenceMonth: hoje.slice(0, 7), fromBalance: true },
      settleInstallmentIds: ['legacy-future-installment'] })
    out.push(result('PLEG-impede-pagamento-duplicado-da-fatura', { duplicateInvoice, duplicateReducer },
      'com pagamento futuro preservado, confirmar hoje exige reconciliação primeiro',
      !duplicateInvoice.applied && duplicateInvoice.state === st && duplicateReducer === st))
    const settledPlan = { ...st, installmentPlans: st.installmentPlans.map(p => ({ ...p, status: 'settled' as const })) }
    out.push(result('PLEG-plano-marcado-quitado-no-backup', cardsOverview(settledPlan),
      'plano marcado quitado por pagamento futuro ainda representa dívida de300 hoje',
      cardsOverview(settledPlan).totalDebt === 300 && cardsOverview(settledPlan).usedLimit === 300
        && planProgress(settledPlan, settledPlan.installmentPlans[0]).remainingCount === 1
        && planProgress(settledPlan, settledPlan.installmentPlans[0]).paidCount === 0
        && futureInstallmentPaymentDate(settledPlan, settledPlan.installments[0], hoje) === amanha))
    st.cardPayments = []
    st.installments[0] = { ...st.installments[0], paidVia: 'direct' }
    const directInv = cardInvoice(st, st.cards[0], hoje.slice(0, 7))
    const directOv = cardsOverview(st)
    out.push(result('PLEG-direto-futuro-nao-quitado-hoje', { directInv, directOv, balance: currentBalance(st) },
      'quitação direta legada de amanhã não quita parcela ou fatura hoje',
      directInv.paid === 0 && directInv.pending === 300
        && invoiceOpenAmount(st, directInv) === 300 && directOv.totalDebt === 300
        && directOv.usedLimit === 300 && currentBalance(st) === 1000))
    const duplicateDirect = applyBatchPure(st,
      [{ id: 'duplicate-legacy-direct', action: { kind: 'card-payment', cardName: 'Inter', amount: 300 } }],
      { now: { date: hoje, time: '14:00' } })
    out.push(result('PLEG-impede-duplicar-parcela-direta-futura', duplicateDirect,
      'pagamento direto futuro também exige reconciliação antes da fatura',
      !duplicateDirect.applied && duplicateDirect.state === st))
    st.installments[0] = { ...st.installments[0], status: 'pending', paidAmount: 200,
      directPayments: [{ amount: 100, date: hoje }, { amount: 100, date: amanha }] }
    const mixedInv = cardInvoice(st, st.cards[0], hoje.slice(0, 7))
    out.push(result('PLEG-parcial-mista-respeita-data', mixedInv,
      'parcial de hoje100 conta; parcial futura100 não antecipa quitação',
      mixedInv.paid === 100 && mixedInv.pending === 200 && cardsOverview(st).totalDebt === 200))
  }

  {
    const d = fromISO(hoje)
    const mesAnterior = toISOdate(new Date(d.getFullYear(), d.getMonth() - 1, 10))
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', closingDay: 1, dueDay: 10 }] })
    st.installmentPlans = [
      { id: 'reference-old', description: 'Antiga', cardId: 'card0', totalAmount: 300,
        installmentCount: 1, firstDueDate: mesAnterior, purchaseDate: addDays(mesAnterior, -20),
        createdAt: addDays(mesAnterior, -20), status: 'active', operationType: 'card-purchase' },
      { id: 'reference-now', description: 'Atual', cardId: 'card0', totalAmount: 200,
        installmentCount: 1, firstDueDate: hoje, purchaseDate: addDays(hoje, -20),
        createdAt: addDays(hoje, -20), status: 'active', operationType: 'card-purchase' },
    ]
    st.installments = [
      { id: 'reference-old-1', planId: 'reference-old', number: 1, total: 1,
        amount: 300, dueDate: mesAnterior, status: 'pending' },
      { id: 'reference-now-1', planId: 'reference-now', number: 1, total: 1,
        amount: 200, dueDate: hoje, status: 'pending' },
    ]
    const proposed = await turnoHoje(st, 'paguei a fatura do Inter')
    const execution = applyBatchPure(st,
      [{ id: 'ambiguous-reference-payment', action: { kind: 'card-payment', cardName: 'Inter' } }],
      { now: { date: hoje, time: '14:00' } })
    out.push(result('FIMP-duas-faturas-nao-escolhe-mes', { proposed, execution },
      'fatura antiga300 e atual200: chat sem referência não paga a atual silenciosamente',
      cardInvoice(st, st.cards[0], mesAnterior.slice(0, 7)).pending === 300
        && cardInvoice(st, st.cards[0], hoje.slice(0, 7)).pending === 200
        && proposed.actions.length === 0 && /fatura|m[eê]s|refer[eê]ncia/i.test(proposed.reply)
        && !execution.applied && execution.state === st))

    const antiga = mesAnterior.slice(0, 7)
    const atual = hoje.slice(0, 7)
    const pagamento = addDays(hoje, -1)
    const nomeMesAnterior = `${MESES_PT_BR[Number(antiga.slice(5)) - 1]} de ${antiga.slice(0, 4)}`
    const mesNumerico = antiga.split('-').reverse().join('/')
    st.settings.balanceAsOf = addDays(hoje, -90)
    const escolha = await orchestrate({ state: st, message: 'Paguei 80 da fatura do Inter e gastei 50 no mercado',
      today: hoje, remoteEnabled: false })
    const pendencia = escolha.response.mode === 'clarify' ? escolha.response.clarification : undefined
    const options = pendencia?.options || []
    const escolhido = await orchestrate({ state: st, message: mesNumerico, today: addDays(hoje, 1), remoteEnabled: false,
      pending: escolha.response.actions, pendingClarification: pendencia })
    const trocouValor = await orchestrate({ state: st, message: `${mesNumerico}, mas foram só 20`,
      today: hoje, remoteEnabled: false, pending: escolha.response.actions, pendingClarification: pendencia })
    const comEscolha = escolhido.response.actions.map(({ id, action }) => ({ id, action }))
    const confirmado = applyBatchPure(st, comEscolha, { now: { date: addDays(hoje, 1), time: '14:00' } })
    out.push(result('FESC-opcoes-preservam-data-valor-e-outro-gasto', { options, escolhido: escolhido.response, trocouValor: trocouValor.response },
      'escolher mês paga R$ 80 na data original, conserva o mercado de R$ 50 e pede confirmação; mudar o valor deixa a escolha em aberto',
      options.length === 2 && trocouValor.response.mode === 'clarify' && trocouValor.response.actions.length === 0 && trocouValor.keepPending
        && escolhido.response.mode === 'propose_actions' && comEscolha.length === 2 && escolhido.correctedPending?.length === 2
        && confirmado.applied && confirmado.state.cardPayments[0]?.paymentDate === hoje
        && confirmado.state.cardPayments[0]?.amount === 80 && confirmado.state.cardPayments[0]?.referenceMonth === antiga
        && confirmado.state.transactions.some(t => t.amount === 50 && t.type === 'expense')
        && cardInvoice(confirmado.state, st.cards[0], atual).pending === 200
        && cardInvoice(confirmado.state, st.cards[0], antiga).pending === 220))

    const cartoesMesmoNome: AppState = { ...st, cards: [{ ...st.cards[0], lastFourDigits: '1234' },
      { ...st.cards[0], id: 'inter-2', lastFourDigits: '5678' }],
    installmentPlans: [...st.installmentPlans, { ...st.installmentPlans[0], id: 'inter-2-plan', cardId: 'inter-2' }],
    installments: [...st.installments, { ...st.installments[0], id: 'inter-2-installment', planId: 'inter-2-plan' }],
    }
    const { response: mesmaFatura } = await orchestrate({ state: cartoesMesmoNome, message: `Paguei 80 da fatura do Inter de ${mesNumerico}`,
      today: hoje, remoteEnabled: false })
    const referencia = mesmaFatura.mode === 'clarify' ? mesmaFatura.clarification : undefined
    const final5678 = referencia?.options?.find(o => /5678/.test(o.label))
    const clicked = final5678 && await orchestrate({ state: cartoesMesmoNome, message: final5678.value,
      today: hoje, remoteEnabled: false, pendingClarification: referencia })
    const picked = clicked ? clicked.response.actions[0]?.action : undefined
    const semIdentidade = applyBatchPure(cartoesMesmoNome,
      [{ id: 'ambiguous-card-id', action: { kind: 'card-payment', cardName: 'Inter', referenceMonth: antiga, amount: 80 } }],
      { now: { date: hoje, time: '14:00' } })
    const arquivado: AppState = { ...cartoesMesmoNome, cards: cartoesMesmoNome.cards.map(c => c.id === 'inter-2' ? { ...c, archived: true } : c) }
    const atrasou = final5678 && await orchestrate({ state: arquivado, message: final5678.value,
      today: hoje, remoteEnabled: false, pendingClarification: referencia })
    const campos = picked ? editableFieldsFor(picked, buildCapabilities(cartoesMesmoNome)).map(f => f.name) : []
    out.push(result('FESC-cartoes-homonimos-exigem-identidade-e-revalidacao', { mesmaFatura, picked, atrasou, campos },
      'duas opções de mesmo nome exibem os finais; o ID escolhido fica fixo e o cartão arquivado bloqueia a proposta',
      referencia?.options?.length === 2 && picked?.kind === 'card-payment' && picked.cardId === 'inter-2'
        && picked.referenceMonth === antiga && !campos.includes('cardName') && !campos.includes('cardId')
        && campos.includes('amount') && campos.includes('date') && !semIdentidade.applied
        && !!atrasou && atrasou.response.actions.length === 0 && /arquivado/.test(atrasou.response.reply)))
    const doisBancos: AppState = { ...cartoesMesmoNome,
      cards: cartoesMesmoNome.cards.map(c => c.id === 'inter-2' ? { ...c, name: 'Nubank' } : c) }
    const primeiro = await orchestrate({ state: doisBancos, message: `Paguei 80 da fatura do Inter de ${mesNumerico}`,
      today: hoje, remoteEnabled: false })
    const corrige = (message: string) => orchestrate({ state: doisBancos, message,
      pending: primeiro.response.actions, today: hoje, remoteEnabled: false })
    const outroBanco = await corrige('na verdade foi no Nubank')
    const excesso = await corrige('na verdade foram 350')
    const outro = outroBanco.response.actions[0]?.action
    out.push(result('FESC-correcao-revalida-id-e-valor', { outroBanco: outroBanco.response, excesso: excesso.response },
      'novo cartão conserva a referência e troca o ID; valor acima do pendente descarta a proposta anterior',
      outro?.kind === 'card-payment' && outro.cardId === 'inter-2' && outro.referenceMonth === antiga
        && outroBanco.correctedPending?.[0]?.action === outro && excesso.correctedPending?.length === 0
        && excesso.response.actions.length === 0 && /supera/.test(excesso.response.reply)))
    const dataEmAberto = await orchestrate({ state: st, message: `Paguei 80 da fatura do Inter de ${mesNumerico} dia 25`,
      today: `${atual}-15`, remoteEnabled: false })
    const escolhaDaData = dataEmAberto.response.mode === 'clarify' ? dataEmAberto.response.clarification : undefined
    const dataResolvida = await orchestrate({ state: st, message: `${antiga}-25`, today: `${atual}-15`, remoteEnabled: false,
      pendingClarification: escolhaDaData })
    const pagamentoResolvido = dataResolvida.response.actions[0]?.action
    out.push(result('FESC-escolha-da-data-preserva-vencimento', { dataEmAberto: dataEmAberto.response, pagamentoResolvido },
      'escolher a data efetiva mantém o vencimento da fatura que foi informado',
      escolhaDaData?.field === 'date-choice' && dataEmAberto.response.actions.length === 0
        && pagamentoResolvido?.kind === 'card-payment' && pagamentoResolvido.referenceMonth === antiga
        && pagamentoResolvido.date === `${antiga}-25` && pagamentoResolvido.amount === 80))

    for (const frase of [
      `paguei 80 da fatura do Inter de ${nomeMesAnterior} ontem`,
      `pagamos 80 da fatura do Inter de ${nomeMesAnterior} ontem`,
      `paguei a fatura de ${mesNumerico} do Inter 80 reais ontem`,
      `paguei 80 da fatura do Inter do mês passado em ${pagamento.split('-').reverse().join('/')}`,
      `paguei 80 da fatura do Inter de ${mesNumerico} em ${pagamento}`,
    ]) {
      const proposta = await turnoHoje(st, frase)
      const aplicado = applyBatchPure(st, proposta.actions.map((action, i) => ({ id: `fref-${i}`, action })),
        { now: { date: hoje, time: '14:00' } })
      const salvo = aplicado.state.cardPayments[0]
      out.push(result(`FREF-data-e-vencimento-${frase}`, { proposta, salvo },
        `salva R$ 80 em ${pagamento} para a fatura ${antiga}; a fatura atual fica em 200`,
        proposta.actions.length === 1 && proposta.reply.includes(mesNumerico)
          && aplicado.applied && salvo?.paymentDate === pagamento && salvo?.referenceMonth === antiga
          && salvo?.paymentTime === undefined && salvo.amount === 80 && currentBalance(aplicado.state) === 920
          && cardInvoice(aplicado.state, st.cards[0], antiga).pending === 220
          && cardInvoice(aplicado.state, st.cards[0], atual).pending === 200))
    }
    const invalida = await turnoHoje(st, `paguei 80 da fatura do Inter de 13/${hoje.slice(0, 4)} e gastei 50 no mercado`)
    const futuro = await turnoHoje(st, `paguei 80 da fatura do Inter de ${mesNumerico} amanhã e gastei 50 no mercado`)
    const doisMeses = await turnoHoje(st, `paguei 80 da fatura do Inter de ${mesNumerico} e de ${atual.split('-').reverse().join('/')}`)
    const negado = await turnoHoje(st, `não pagamos 80 da fatura do Inter de ${mesNumerico}`)
    out.push(result('FREF-referencia-e-data-incertas-nao-travam-outro-gasto', { invalida, futuro, doisMeses },
      'mês inválido, data futura ou dois meses nunca criam pagamento; o mercado é preservado',
      [invalida, futuro].every(r => r.actions.length === 1 && r.actions[0].kind === 'expense' && r.actions[0].amount === 50)
        && doisMeses.actions.length === 0 && /mês e o ano de vencimento/.test(doisMeses.reply)
        && negado.actions.length === 0 && /isso não aconteceu/.test(negado.reply)))

    const saldoDaAntiga = await turnoHoje(st, 'quanto falta pagar da fatura do Inter no mês passado?')
    const saldoDaAtual = await turnoHoje(st, 'quanto falta pagar da fatura do Inter deste mês?')
    const saldoSeConfirmar = await turnoHoje(st, `paguei 80 da fatura do Inter de ${nomeMesAnterior}, quanto falta?`)
    out.push(result('FREF-quanto-falta-usa-o-vencimento-selecionado', [saldoDaAntiga.reply, saldoDaAtual.reply, saldoSeConfirmar.reply],
      'fatura antiga 300 e atual 200; a prévia desconta os 80 só da antiga',
      /Pendente nas faturas.*R\$\s300,00/.test(saldoDaAntiga.reply)
        && /Pendente nas faturas.*R\$\s200,00/.test(saldoDaAtual.reply)
        && /Se você confirmar/.test(saldoSeConfirmar.reply) && /Pendente nas faturas.*R\$\s220,00/.test(saldoSeConfirmar.reply)
        && !/R\$\s200,00/.test(saldoSeConfirmar.reply) && saldoSeConfirmar.actions.length === 1))

    const extra = await turnoHoje(st, `Paguei 80 da fatura do Inter de ${mesNumerico} e cinquenta no mercado ontem`)
    const mais = await turnoHoje(st, `Paguei 80 da fatura do Inter de ${mesNumerico} e R$ 50 no mercado e 20 na padaria`)
    const juros = await turnoHoje(st, `Paguei 80 da fatura do Inter de ${mesNumerico} e 50 de juros`)
    const duvida = await turnoHoje(st, `Paguei a fatura do Inter de ${mesNumerico} e 50 na mesma fatura`)
    const negacao = await turnoHoje(st, `Não paguei 80 da fatura do Inter de ${mesNumerico} e 50 no mercado`)
    out.push(result('FREF-pagamento-e-despesa-eliptica', { extra, mais, juros, duvida, negacao },
      'mercado e padaria entram como despesas independentes sem atribuir o cartão como origem; juros e valores incertos pedem esclarecimento',
      extra.actions.length === 2 && extra.actions.some(a => a.kind === 'card-payment' && a.referenceMonth === antiga && a.date === pagamento)
        && extra.actions.some(a => a.kind === 'expense' && a.amount === 50 && a.date === pagamento && !a.origin)
        && mais.actions.length === 3 && mais.actions.filter(a => a.kind === 'expense' && !a.origin).map(a => a.amount).join(',') === '50,20'
        && juros.actions.length === 1 && juros.actions[0].kind === 'card-payment' && /R\$ 50,00.*O que aconteceu/.test(juros.reply)
        && duvida.actions.length === 0 && /Qual foi o valor/.test(duvida.reply) && negacao.actions.length === 0))
    const diasDiferentes = await turnoHoje(st, `Paguei 80 da fatura do Inter de ${mesNumerico} em ${pagamento.split('-').reverse().join('/')} e 50 no mercado em ${addDays(hoje, -2).split('-').reverse().join('/')}`)
    out.push(result('FREF-datas-concorrentes-nao-datam-despesa-no-chute', diasDiferentes,
      'mediante duas datas na mesma cláusula, pede o dia de cada pagamento antes de propor qualquer um',
      diasDiferentes.actions.length === 0 && /data do pagamento da fatura.*data do outro lançamento/.test(diasDiferentes.reply)))

    const nextDue = toISOdate(new Date(d.getFullYear(), d.getMonth() + 1, 10))
    const nextRef = nextDue.slice(0, 7)
    const adiantavel: AppState = { ...st,
      installmentPlans: [...st.installmentPlans, { ...st.installmentPlans[0], id: 'reference-next',
        description: 'Próxima', totalAmount: 150, firstDueDate: nextDue }],
      installments: [...st.installments, { ...st.installments[0], id: 'reference-next-1', planId: 'reference-next',
        amount: 150, dueDate: nextDue }],
    }
    const antecipacao = await turnoHoje(adiantavel, 'Antecipei 80 da fatura do Inter do mês que vem')
    const aguardando = applyBatchPure(adiantavel, antecipacao.actions.map((action, i) => ({ id: `antecipacao-${i}`, action })),
      { now: { date: hoje, time: '14:00' } })
    out.push(result('FREF-distingue-antecipacao-de-data-futura', { antecipacao, payment: aguardando.state.cardPayments[0] },
      'R$ 80 de hoje são inscritos no mês que vem, sem tocar a fatura de hoje',
      antecipacao.actions.length === 1 && aguardando.applied && aguardando.state.cardPayments[0]?.paymentDate === hoje
        && aguardando.state.cardPayments[0]?.referenceMonth === nextRef
        && cardInvoice(aguardando.state, st.cards[0], nextRef).pending === 70
        && cardInvoice(aguardando.state, st.cards[0], atual).pending === 200))

    const caps = buildCapabilities(st)
    const control = validateAction({ kind: 'card-payment', cardName: 'Inter', amount: 80 }, caps, hoje, { allowRemoteOnly: true })
    const explicit = { kind: 'card-payment' as const, cardName: 'Inter', amount: 80, date: pagamento, referenceMonth: antiga }
    const remoteDate = validateAction({ ...explicit, referenceMonth: undefined }, caps, hoje, { allowRemoteOnly: true })
    const remoteMonth = validateAction({ ...explicit, date: undefined }, caps, hoje, { allowRemoteOnly: true })
    const remoteId = validateAction({ ...explicit, date: undefined, referenceMonth: undefined, cardId: 'card0' }, caps, hoje, { allowRemoteOnly: true })
    const remotePending = validateAction({ ...explicit, date: undefined, referenceMonth: undefined, expectedPending: 300 }, caps, hoje, { allowRemoteOnly: true })
    const localFields = validateAction(explicit, caps, hoje)
    const invalidFields = validateAction({ ...explicit, referenceMonth: `${hoje.slice(0, 4)}-13` }, caps, hoje)
    out.push(result('FREF-data-e-referencia-sao-locais', { localFields, invalidFields, remoteDate, remoteMonth, remoteId, remotePending, control },
      'o contrato local mantém data e referência válidas; remoto continua aceitando só cartão e valor',
      !isValidationFailure(localFields) && !isValidationFailure(control) && isValidationFailure(invalidFields)
        && isValidationFailure(remoteDate) && isValidationFailure(remoteMonth) && isValidationFailure(remoteId) && isValidationFailure(remotePending)))

    const historico: AppState = { ...st, cardPayments: [{ id: 'later-partial', cardId: 'card0', amount: 220,
      paymentDate: hoje, referenceMonth: antiga, fromBalance: true, settledInstallmentIds: [] }] }
    const semValor = await turnoHoje(historico, `paguei a fatura do Inter de ${mesNumerico} ontem`)
    const atrasada = applyBatchPure(historico, [{ id: 'pay-previous-part', action: explicit }],
      { now: { date: hoje, time: '14:00' } })
    out.push(result('FREF-registro-retroativo-respeita-pagamento-posterior', { semValor, atrasada: atrasada.results },
      'sem valor explícito pede o valor pago; ao salvar R$ 80 de ontem, a quitação de R$ 300 só aconteceu hoje',
      semValor.actions.length === 0 && /Qual foi o valor pago/.test(semValor.reply) && atrasada.applied
        && atrasada.state.cardPayments[0]?.paymentDate === pagamento
        && atrasada.state.installments.find(i => i.id === 'reference-old-1')?.paidAt === hoje
        && cardInvoice(atrasada.state, st.cards[0], antiga, pagamento).paid === 80
        && cardInvoice(atrasada.state, st.cards[0], antiga).pending === 0
        && currentBalance(atrasada.state) === 700))
  }

  {
    const now = '2026-11-19'
    const st = buildState({ profile: 'autonomo', transactions: [
      { type: 'expense', amount: 37, date: '2026-11-10', description: 'Mercado' },
      { type: 'expense', amount: 70, date: '2026-10-11', description: 'Mercado' },
      { type: 'expense', amount: 20, date: '2026-11-11', description: 'Padaria' },
    ] })
    const run = async (message: string) => (await orchestrate({ state: st, message, today: now, remoteEnabled: false })).response
    const isoDate = await run('Quanto gastei em 2026-11-10?')
    const localDate = await run('Quanto gastei em 10/11/2026?')
    const range = await run('Quanto gastei de 2026-11-10 a 2026-11-11?')
    const invalid = await run('Quanto gastei em 2026-02-31?')
    const mixed = await run('Gastei 7 no mercado hoje. Quanto gastei em 31/02/2026?')
    out.push(result('DATE-consulta-preserva-dia-e-recusa-calendario-impossivel', [isoDate.reply, localDate.reply, range.reply, invalid.reply, mixed.reply],
      'cada dia e intervalo retornam os valores exatos; datas inválidas pedem correção e não tiram o registro independente',
      [isoDate, localDate].every(r => r.actions.length === 0 && /10\/11\/2026.*R\$\s37,00/.test(r.reply) && !/70,00/.test(r.reply))
        && range.actions.length === 0 && /10\/11\/2026 a 11\/11\/2026.*R\$\s57,00/.test(range.reply)
        && invalid.mode === 'clarify' && /não existe/.test(invalid.reply) && !/dado real/.test(invalid.reply)
        && mixed.actions.length === 1 && mixed.actions[0].action.kind === 'expense' && mixed.actions[0].action.amount === 7
        && /não existe/.test(mixed.reply) && !/dado real/.test(mixed.reply)))

    const rawPeriod = (from: string, to: string) => ({ from, to, grain: 'range' })
    const badPeriods = [
      rawPeriod('2026-02-29', '2026-03-01'), rawPeriod('2026-11-01', '2026-11-31'),
      rawPeriod('2026-00-01', '2026-03-01'), rawPeriod('2026-11-01 adicional', '2026-11-19'),
    ]
    const valid = rawPeriod('2024-02-29', '2024-03-01')
    const checks = badPeriods.flatMap(period => [
      validateQueryPlan({ source: 'transactions', metric: 'sum', period }, st, now),
      validateQueryPlan({ source: 'transactions', metric: 'sum', period: valid, comparePeriod: period }, st, now),
    ])
    out.push(result('DATE-validador-de-periodo-requer-datas-reais-completas', checks,
      'consulta e comparação rejeitam datas inexistentes e sufixos; 29/02 de ano bissexto é válido',
      checks.every(r => 'code' in r && r.code === 'bad-period')
        && validateQueryPlan({ source: 'transactions', metric: 'sum', period: valid }, st, now).ok))

    const literal = findDate('paguei 80 em 2026-11-10', now)
    const semDia = findDate('gastei 50 dia 31', '2026-02-28')
    const prazo = findDate('quanto até dia 31?', '2026-02-15')
    const mesCurto = findDate('gastei 50 dia 31', '2026-05-15')
    const fevereiro = findDate('paguei 80 em 29 de fevereiro', '2028-02-15')
    out.push(result('DATE-dia-do-mes-nao-arredonda-para-ultima-data', { literal, semDia, prazo, mesCurto, fevereiro },
      'fato no dia 31 inexistente é inválido; prazo de fim do mês mantém o último dia; escolhas de data correspondem ao dia escrito',
      literal?.kind === 'date' && literal.date === '2026-11-10' && semDia?.kind === 'invalid'
        && prazo?.kind === 'future' && prazo.date === '2026-02-28'
        && mesCurto?.kind === 'ambiguous' && mesCurto.options.length === 1 && mesCurto.options[0].value === '2026-05-31'
        && fevereiro?.kind === 'ambiguous' && fevereiro.options.length === 1 && fevereiro.options[0].value === '2028-02-29'))

    const pergunta = await run('Gastei 50 no mercado dia 25 e paguei 30 na padaria hoje')
    const contestada = pergunta.mode === 'clarify' ? pergunta.clarification : undefined
    const resolve = (message: string) => orchestrate({ state: st, message, today: now, remoteEnabled: false,
      pending: pergunta.actions, pendingClarification: contestada })
    const escolhida = await resolve('2026-10-25')
    const futura = await resolve('Dia 25 deste mês (25/11/2026)')
    const contraria = await resolve('25/10/2026 e foram só 20')
    const absoluta = await run('Gastei 70 no mercado em 2028-02-29')
    out.push(result('DATE-acao-aguarda-data-e-propoe-apos-escolha', { pergunta, escolhida: escolhida.response, futura: futura.response,
      contraria: contraria.response, absoluta },
      'só o gasto independente pode ser confirmado; data válida recupera o valor original; data futura ou valor corrigido não registram',
      contestada?.field === 'date-choice' && pergunta.actions.length === 1 && /Padaria/.test(pergunta.reply) && !/Mercado/.test(pergunta.reply)
        && escolhida.response.actions.length === 2 && escolhida.response.actions.some(({ action }) => action.kind === 'expense'
          && action.amount === 50 && action.date === '2026-10-25')
        && escolhida.correctedPending?.length === 2 && futura.response.mode === 'clarify'
        && futura.response.actions.length === 0 && futura.keepPending && /ainda não chegou/.test(futura.response.reply)
        && contraria.response.mode === 'clarify' && contraria.response.actions.length === 0 && contraria.keepPending
        && absoluta.mode === 'clarify' && absoluta.actions.length === 0 && !/28\/02\/2027/.test(absoluta.reply)))

    const janela = await run('Gastei 50 no mercado depois do dia 10')
    const pcJanela = janela.mode === 'clarify' ? janela.clarification : undefined
    const naJanela = (message: string) => orchestrate({ state: st, message, today: now, remoteEnabled: false,
      pendingClarification: pcJanela })
    const dentro = await naJanela('dia 14')
    const fora = await naJanela('dia 10')
    const valor = await naJanela('foram 15 reais')
    const heranca = await run('Gastei 9 no mercado ontem e paguei 50 na padaria mês passado')
    out.push(result('DATE-limite-da-janela-nao-vira-data-do-fato', { janela, dentro: dentro.response, fora: fora.response,
      valor: valor.response, heranca },
      'depois do dia 10 exige data a partir do dia 11, rejeita valor avulso e deixa outro registro com seu período independente',
      janela.actions.length === 0 && pcJanela?.dateWindow?.from === '2026-11-11' && pcJanela.dateWindow.to === now
        && dentro.response.actions[0]?.action.kind === 'expense' && dentro.response.actions[0].action.date === '2026-11-14'
        && fora.response.mode === 'clarify' && valor.response.mode === 'clarify'
        && heranca.actions.length === 1 && heranca.actions[0].action.kind === 'expense' && heranca.actions[0].action.amount === 9
        && /que dia/i.test(heranca.reply)))

    const apos = addDays(now, 1)
    const before = addDays(now, -1)
    const caixa = buildState({ profile: 'driver', balance: 1000, transactions: [
      { type: 'expense', amount: 37, date: now, category: 'casa' },
      { type: 'expense', amount: 80, date: apos, category: 'casa' },
    ], workSessions: [{ date: now, km: 10, hours: 1 }, { date: apos, km: 100, hours: 10 }] })
    caixa.settings.balanceAsOf = `${before}T12:00:00.000`
    const periodo = { from: before, to: apos, label: 'intervalo informado', grain: 'range' as const }
    const planoPorKm = validateQueryPlan({ source: 'transactions', metric: 'per-km', period: periodo, filter: { txType: ['expense'] } }, caixa, now)
    const porKm = planoPorKm.ok === true ? runQuery(caixa, planoPorKm.plan, now) : undefined
    const stats = periodStats(caixa, before, apos, now)
    const foraDaData = reducer(caixa, { type: 'addTx', tx: { ...caixa.transactions[1], id: 'future-new', date: addDays(hoje, 1) } })
    const futuroNoLote = applyBatchPure(caixa, [{ id: 'future-local', action: { kind: 'expense', amount: 80, date: apos } }],
      { now: { date: now, time: '15:00' } })
    out.push(result('DATE-futuro-nao-entra-em-orcamento-relatorio-ou-caixa', { stats, porKm, saldo: currentBalance(caixa, now) },
      'a despesa de amanhã permanece no backup; hoje só gasta 37, o orçamento consome 37 e o custo usa 10 km',
      stats.expense === 37 && stats.km === 10 && budgetUsage(caixa, 'casa', now) === 37 && currentBalance(caixa, now) === 963
        && porKm?.total === 3.7 && porKm.count === 1 && foraDaData === caixa && !futuroNoLote.applied && futuroNoLote.state === caixa
        && caixa.transactions.length === 2 && periodStats(caixa, before, apos, apos).expense === 117))

    const retroativo = applyBatchPure(caixa, [{ id: 'retroactive-expense', action: { kind: 'expense', amount: 25, date: before, category: 'casa' } }],
      { now: { date: now, time: '15:00' } })
    out.push(result('DATE-lancamento-retroativo-nao-ganha-hora-da-confirmacao', retroativo.state.transactions[0],
      'despesa de ontem sem hora fica no extrato de ontem e não muda o saldo que já foi informado depois',
      retroativo.applied && retroativo.state.transactions[0]?.date === before && retroativo.state.transactions[0]?.time === undefined
        && currentBalance(retroativo.state, now) === 963 && periodStats(retroativo.state, before, before, now).expense === 25))

    const receita = buildState({ balance: 1000, profile: 'autonomo', cards: [{ name: 'Inter' }] })
    receita.settings.balanceAsOf = `${addDays(hoje, -1)}T12:00:00.000`
    const compra = { id: 'financiada', description: 'Entrada financiada', cardId: 'card0', totalAmount: 100,
      installmentCount: 2, firstDueDate: addDays(hoje, 25), purchaseDate: hoje,
      createdAt: hoje, status: 'active' as const, operationType: 'financed-cash-inflow' as const, netReceived: 80 }
    let parcelaId = 0
    const registro = { type: 'addPlan' as const, plan: compra, installments: buildInstallments(compra, () => `parcela-${++parcelaId}`),
      cashInflow: { id: 'receipt', type: 'financed-cash-inflow' as const, amount: 80, category: 'outros-in', date: hoje, time: '15:00' } }
    const valido = reducer(receita, registro)
    const futuro = reducer(receita, { ...registro, plan: { ...compra, purchaseDate: addDays(hoje, 1) },
      cashInflow: { ...registro.cashInflow, date: addDays(hoje, 1) } })
    const incompleto = reducer(receita, { ...registro, cashInflow: undefined })
    const divergente = reducer(receita, { ...registro, cashInflow: { ...registro.cashInflow, amount: 90 } })
    out.push(result('DATE-entrada-financiada-manual-atomica-e-uma-vez', { saldo: currentBalance(valido), recusados: [futuro === receita, incompleto === receita, divergente === receita] },
      'entrada de 80 soma uma vez a 1000, primeira parcela pode vencer depois; dados incompletos ou futuros não gravam plano nem caixa',
      valido.settings.balance === 1000 && currentBalance(valido) === 1080 && periodStats(valido, hoje, hoje).income === 0
        && valido.installmentPlans.length === 1 && valido.installments.length === 2 && valido.transactions.length === 1
        && futuro === receita && incompleto === receita && divergente === receita && reducer(valido, registro) === valido))
    const planoHistorico = { ...compra, id: 'acordo-em-andamento', cardId: undefined, netReceived: undefined,
      operationType: 'standalone' as const }
    const parcelas = buildInstallments(planoHistorico, () => `parcela-${++parcelaId}`, 1)
    const acordado = reducer(receita, { type: 'addPlan', plan: planoHistorico, installments: parcelas })
    out.push(result('DATE-parcelas-ja-pagas-sem-inventar-data-ou-saida', { parcelas, saldo: currentBalance(acordado) },
      'quitar uma parcela histórica reduz a dívida de 100 para 50; não cria um dia de pagamento nem muda o saldo',
      parcelas[0].status === 'paid' && parcelas[0].paidAmount === 50 && !parcelas[0].paidAt && parcelas[1].status === 'pending'
        && currentBalance(acordado) === 1000 && planProgress(acordado, planoHistorico).remainingAmount === 50))

    const peloChat = applyBatchPure(receita, [{ id: 'financiamento-chat', action: { kind: 'financed-cash-inflow',
      total: 100, netReceived: 80, installments: 2, cardName: 'Inter' } }], { now: { date: hoje, time: '15:10' } })
    const posRecarga = hydrateForTest(JSON.parse(JSON.stringify(valido)))
    const apagarEntrada = reducer(posRecarga, { type: 'removeTx', id: registro.cashInflow.id })
    const apagarOperacao = reducer(posRecarga, { type: 'removePlan', id: compra.id })
    const apagarChat = reducer(peloChat.state, { type: 'removePlan', id: peloChat.state.installmentPlans[0]?.id })
    const parcelaPaga = reducer(valido, { type: 'payInstallment', id: registro.installments[0].id, paidAt: hoje })
    const faturaComBaixa: AppState = { ...valido, cardPayments: [{ id: 'invoice-dependence', cardId: 'card0',
      amount: 20, referenceMonth: compra.firstDueDate.slice(0, 7), paymentDate: hoje, fromBalance: true }] }
    out.push(result('FIN-excluir-operacao-mantem-caixa-e-divida-coerentes', { apagarEntrada: apagarEntrada === posRecarga,
      caixaReduzido: currentBalance(apagarOperacao), caixaChat: currentBalance(apagarChat) },
      'financiamentos novos têm vínculo nos dois fluxos; remover o plano elimina a entrada e só libera se não houver parcelas ou fatura pagas',
      posRecarga.transactions[0]?.financedPlanId === compra.id && apagarEntrada === posRecarga
        && peloChat.applied && peloChat.state.transactions[0]?.financedPlanId === peloChat.state.installmentPlans[0]?.id
        && [apagarOperacao, apagarChat].every(s => !s.transactions.length && !s.installments.length
          && !s.installmentPlans.length && currentBalance(s) === 1000)
        && parcelaPaga !== valido && reducer(parcelaPaga, { type: 'removePlan', id: compra.id }) === parcelaPaga
        && reducer(faturaComBaixa, { type: 'removePlan', id: compra.id }) === faturaComBaixa))

    const legadoFinanceiro: AppState = { ...valido, transactions: [
      { ...registro.cashInflow, id: 'fin-legado-1' }, { ...registro.cashInflow, id: 'fin-legado-2', time: '16:50' },
      { ...registro.cashInflow, id: 'sem-match', date: addDays(hoje, -1) },
    ] }
    const semEscolha = reducer(legadoFinanceiro, { type: 'removePlan', id: compra.id })
    const errada = reducer(legadoFinanceiro, { type: 'removePlan', id: compra.id, legacyReceiptId: 'sem-match' })
    const certa = reducer(legadoFinanceiro, { type: 'removePlan', id: compra.id, legacyReceiptId: 'fin-legado-2' })
    out.push(result('FIN-excluir-legado-exige-vinculo-confirmado', { semEscolha: semEscolha === legadoFinanceiro,
      restantes: certa.transactions.map(t => t.id) },
      'com duas entradas legadas, excluir só depois da escolha explícita e manter intactos os outros lançamentos',
      semEscolha === legadoFinanceiro && errada === legadoFinanceiro
        && reducer(legadoFinanceiro, { type: 'removeTx', id: 'fin-legado-1' }) === legadoFinanceiro
        && certa.transactions.map(t => t.id).join(',') === 'fin-legado-1,sem-match'
        && !certa.installmentPlans.length && !certa.installments.length))

    const plano = { ...planoHistorico, id: 'historico-e-futuras', cardId: 'card0', totalAmount: 600,
      purchaseDate: addDays(hoje, -30), firstDueDate: addDays(hoje, -2), installmentCount: 6,
      operationType: 'card-purchase' as const }
    const novas = [-2, -1, 0, 7, 14, 45].map((offset, index) => ({
      id: `cancela-${index}`, planId: plano.id, number: index + 1, total: 6,
      amount: 100, dueDate: addDays(hoje, offset), status: 'pending' as const,
    }))
    const misto: AppState = { ...receita, settings: { ...receita.settings, balanceAsOf: addDays(hoje, -15) },
      installmentPlans: [plano], installments: [
        { ...novas[0], status: 'paid', paidAt: addDays(hoje, -2), paidVia: 'direct', paidAmount: 100 },
        ...novas.slice(1, 4),
        { ...novas[4], paidAmount: 40, paidVia: 'direct', paidAt: hoje, directPayments: [{ date: hoje, amount: 40 }] },
        novas[5],
      ],
      cardPayments: [{ id: 'avanco-fatura', cardId: 'card0', referenceMonth: novas[5].dueDate.slice(0, 7),
        paymentDate: hoje, amount: 60, fromBalance: true }],
    }
    const cancelar = { type: 'cancelFutureInstallments' as const, planId: plano.id }
    const cancelado = reducer(misto, cancelar)
    out.push(result('FCAN-preserva-hoje-atrasadas-e-pagamentos-parciais', { estados: cancelado.installments.map(i => i.status),
      antes: currentBalance(misto), depois: currentBalance(cancelado) },
      'só a parcela futura livre sai, preservando as atrasadas, a de hoje, a paga e pagamentos parcial e de fatura',
      cancelado.installments.map(i => i.status).join(',') === 'paid,pending,pending,cancelled,pending,pending'
        && cancelado.installmentPlans[0].status === 'active' && planProgress(cancelado, plano).remainingAmount === 360
        && currentBalance(misto) === 800 && currentBalance(cancelado) === 800 && reducer(cancelado, cancelar) === cancelado))
    const encerrar = { ...misto, cardPayments: [], installments: [misto.installments[0], misto.installments[3]] }
    const encerrado = reducer(encerrar, cancelar)
    const salvoAntigo = { ...encerrado, installmentPlans: [{ ...encerrado.installmentPlans[0], status: 'cancelled' as const }] }
    const competenciaPaga = misto.installments[0].dueDate.slice(0, 7)
    const faturaPaga = cardInvoice(salvoAntigo, salvoAntigo.cards[0], competenciaPaga)
    out.push(result('FCAN-encerra-sem-liberar-um-vencimento-ja-pago', { plano: encerrado.installmentPlans[0].status, fatura: faturaPaga },
      'o plano fica encerrado sem saldo a pagar; uma fatura anterior continua com a parcela de 100 paga inclusive em plano legado cancelado',
      encerrado.installmentPlans[0]?.status === 'settled' && planProgress(encerrado, plano).remainingCount === 0
        && faturaPaga.total === 100 && faturaPaga.paid === 100 && faturaPaga.pending === 0))

    const planoParcial = { ...plano, cardId: undefined, status: 'settled' as const, totalAmount: 100, installmentCount: 1 }
    const parcial: AppState = { ...misto, installmentPlans: [planoParcial], cardPayments: [], installments: [
      { ...novas[0], total: 1, status: 'paid', paidAmount: 40 },
    ] }
    const quitar = { type: 'payInstallments' as const, planId: planoParcial.id, ids: [novas[0].id], paidAt: hoje, completePlan: true }
    const quitado = reducer(parcial, quitar)
    out.push(result('FPAR-legado-quitado-com-saldo', { antes: planProgress(parcial, planoParcial).remainingAmount,
      depois: planProgress(quitado, planoParcial).remainingAmount, eventos: quitado.installments[0].directPayments },
      'a dívida legada de R$ 60 aparece e somente esse valor sai do caixa ao quitar',
      planProgress(parcial, planoParcial).remainingAmount === 60 && cardsOverview(parcial).totalDebt === 60
        && cardsOverview(parcial).overdueAmount === 60
        && planProgress(quitado, planoParcial).remainingAmount === 0 && quitado.installmentPlans[0]?.status === 'settled'
        && quitado.installments[0].directPayments?.[0]?.amount === 60
        && currentBalance(parcial) - currentBalance(quitado) === 60 && reducer(quitado, quitar) === quitado))

    const comFutura: AppState = { ...parcial, installments: [...parcial.installments, {
      ...novas[3], paidAmount: 40, directPayments: [{ date: addDays(hoje, 2), amount: 40 }],
    }] }
    const dataFutura = futureInstallmentPaymentDate(comFutura, comFutura.installments[1])
    const loteMisto = { ...quitar, ids: [novas[0].id, novas[3].id] }
    out.push(result('FPAR-data-futura-bloqueia-quitacao-atomica', { dataFutura,
      projetado: planProgress(comFutura, planoParcial).remainingAmount, caixa: currentBalance(comFutura) },
      'uma data futura só no histórico direto bloqueia pagamento individual e o lote inteiro',
      dataFutura === addDays(hoje, 2) && planProgress(comFutura, planoParcial).remainingAmount === 160
        && currentBalance(comFutura) === currentBalance(parcial) && reducer(comFutura, loteMisto) === comFutura
        && reducer(comFutura, quitar) === comFutura
        && reducer(comFutura, { type: 'partialPayInstallment', id: novas[3].id, paidAt: hoje, amount: 20 }) === comFutura))

    const stamp = `${hoje}T16:00:00.000`
    const loanOptions = { batchId: 'fin-com-diario', now: { date: hoje, time: '15:10' } }
    const loanActions = [{ id: 'fin-diario', action: { kind: 'financed-cash-inflow' as const,
      total: 100, netReceived: 80, installments: 2, cardName: 'Inter' } }]
    const loan = applyBatchPure(receita, loanActions, loanOptions)
    const intact = hydrateForTest(JSON.parse(JSON.stringify(loan.state)))
    const proposal = await orchestrate({ state: intact, message: 'desfaz o último', today: hoje, remoteEnabled: false })
    const undo = (s: AppState) => applyBatchPure(s, proposal.response.actions.map(({ id, action }) => ({ id, action })), { stamp })
    const undone = undo(intact)
    const repaid = reducer(intact, { type: 'payInstallment', id: intact.installments[0]?.id, paidAt: hoje, paidTime: '15:30' })
    const conflicted = undo(repaid)
    const denied = await orchestrate({ state: repaid, message: 'desfaz o último', today: hoje, remoteEnabled: false })
    const legacyJournal = { ...repaid, assistantJournal: repaid.assistantJournal.map(entry => ({ ...entry,
      ops: entry.ops.map(op => {
        if (op.op === 'delete') return op
        const { after, ...legacy } = op
        return legacy
      }),
    })) }
    const legacyDenied = undo(legacyJournal)
    out.push(result('UNDO-financiamento-apos-pagamento-independente', { proposta: proposal.response.mode,
      refusals: [conflicted.results, denied.response.reply, legacyDenied.results] },
      'financiamento intacto é reversível após recarga; pagamento posterior bloqueia proposta e confirmação inclusive em journal legado',
      loan.applied && proposal.response.actions.length === 1 && proposal.response.actions[0].action.kind === 'undo-batch'
        && undone.applied && !undone.state.installments.length && !undone.state.transactions.length && currentBalance(undone.state) === 1000
        && currentBalance(repaid) === 1030 && conflicted.state === repaid && !conflicted.applied && !legacyDenied.applied
        && conflicted.results[0]?.ok === false && 'code' in conflicted.results[0] && conflicted.results[0].code === 'batch-changed'
        && denied.response.actions.length === 0 && /alterações ou pagamentos posteriores/.test(denied.response.reply)))

    const payment = { id: 'fatura-dependente', cardId: 'card0', amount: 20, paymentDate: hoje,
      referenceMonth: intact.installments[0].dueDate.slice(0, 7), fromBalance: true, settledInstallmentIds: [] }
    const external = { ...intact, cardPayments: [payment] }
    const afterExisting = applyBatchPure({ ...receita, cardPayments: [payment] }, loanActions, loanOptions)
    const withoutLoan = undo(afterExisting.state)
    out.push(result('UNDO-preserva-pagamento-preexistente-e-bloqueia-posterior', { posterior: undo(external).results,
      anterior: withoutLoan.results },
      'pagamento anterior continua salvo ao desfazer; baixa posterior na mesma fatura exige conferência',
      undo(external).state === external && !undo(external).applied && afterExisting.applied && withoutLoan.applied
        && !withoutLoan.state.installmentPlans.length && withoutLoan.state.cardPayments[0] === payment
        && currentBalance(withoutLoan.state) === 980))

    const balanceBatch = applyBatchPure(receita, [{ id: 'saldo-do-chat', action: { kind: 'balance', amount: 400 } }], loanOptions)
    const balanceEdited = reducer(balanceBatch.state, { type: 'settings', patch: { balance: 623, balanceAsOf: stamp } })
    const balanceDenied = revertBatchPure(balanceEdited, loanOptions.batchId, stamp)
    const expenseBatch = applyBatchPure(receita, [{ id: 'despesa-do-chat', action: { kind: 'expense', amount: 50, category: 'casa' } }], loanOptions)
    const edited = applyBatchPure(expenseBatch.state, [{ id: 'edicao-despesa', action: {
      kind: 'edit-transaction', transactionId: expenseBatch.state.transactions[0].id, amount: 151,
    } }], { stamp })
    const editDenied = revertBatchPure(edited.state, loanOptions.batchId, stamp)
    out.push(result('UNDO-preserva-saldo-e-lancamento-editados-manualmente', { balanceDenied, editDenied },
      'desfazer nunca sobrescreve saldo manual posterior nem apaga despesa que o usuário alterou',
      currentBalance(balanceEdited) === 623 && edited.applied && edited.state.transactions[0].amount === 151
        && isRevertFailure(balanceDenied) && balanceDenied.code === 'batch-changed'
        && isRevertFailure(editDenied) && editDenied.code === 'batch-changed'))

    const due = addDays(hoje, 4)
    const card = { ...receita.cards[0], dueDay: Number(due.slice(8)), closingDay: 1, limit: 1000 }
    const archivePlan = { ...plano, totalAmount: 200, installmentCount: 1, firstDueDate: due }
    const activeCard: AppState = { ...receita, cards: [card], installmentPlans: [archivePlan],
      installments: [{ ...novas[0], total: 1, dueDate: due, amount: 200 }],
      cardCharges: [{ id: 'assinatura-arquivada', cardId: card.id, description: 'Assinatura',
        active: true, frequency: 'monthly', amount: 50, nextDate: due, createdAt: hoje }],
      cardPayments: [{ ...payment, cardId: card.id, referenceMonth: due.slice(0, 7), amount: 100 }],
    }
    const archivedCard = reducer(activeCard, { type: 'updateCard', id: card.id, patch: { archived: true } })
    const obligations = cashObligationsUntil(archivedCard, due, hoje)
    const projected = monthlyProjections(archivedCard, 2, hoje)
    const timeline = commitmentTimeline(archivedCard, hoje, due)
    const getInvoice = await turnoHoje(archivedCard, 'quanto falta pagar da fatura do Inter?')
    const simulate = await turnoHoje(archivedCard, 'se eu pagar a fatura do Inter?')
    out.push(result('ARCH-cartao-arquivado-preserva-projecao-fatura-e-pagamento', { obligations, timeline,
      projected: projected.map(m => m.installments), fatura: getInvoice.reply, simulacao: simulate.reply },
      'arquivar preserva os R$ 150 em aberto e o débito já pago; deixa de oferecer os R$ 1.000 de limite para compra nova',
      currentBalance(archivedCard) === 900 && obligations.length === 1 && obligations[0].kind === 'invoice' && obligations[0].amount === 150
        && JSON.stringify(projected) === JSON.stringify(monthlyProjections(activeCard, 2, hoje))
        && projected.find(m => m.monthKey === due.slice(0, 7))?.installments === 150
        && timeline.length === 1 && timeline[0].kind === 'invoice' && timeline[0].amount === 250
        && cardsOverview(archivedCard).totalLimit === 0 && cardsOverview(activeCard).totalLimit === 1000
        && /150,00/.test(getInvoice.reply) && /750,00/.test(simulate.reply) && !getInvoice.actions.length && !simulate.actions.length))

    const standalone: AppState = { ...parcial, installments: [{ ...parcial.installments[0], dueDate: due }] }
    const obligationsSingle = cashObligationsUntil(standalone, due, hoje)
    const monthlySingle = monthlyProjections(standalone, 2, hoje).find(m => m.monthKey === due.slice(0, 7))
    out.push(result('FPAR-saldo-avulso-entra-em-obrigacoes-e-projecao', { obligationsSingle, monthlySingle },
      'a projeção inclui exatamente os R$ 60 restantes da parcela avulsa marcada como paga',
      obligationsSingle.length === 1 && obligationsSingle[0].kind === 'installment' && obligationsSingle[0].amount === 60
        && monthlySingle?.installments === 60 && monthlySingle.runningBalance === 940))

    const invalidDate = '2024-02-30'
    const validLeapDate = '2024-02-29'
    const expense = { id: 'despesa-bissexto', type: 'expense' as const, amount: 17, category: 'casa', date: validLeapDate, time: '09:00' }
    const invalidBackup = hydrateForTest(JSON.parse(JSON.stringify({ ...receita,
      settings: { ...receita.settings, balanceAsOf: '2024-01-01T00:00' },
      transactions: [expense, { ...expense, id: 'despesa-impossivel', date: invalidDate, amount: 100 },
        { ...expense, id: 'dia-zero', date: `${hoje.slice(0, 7)}-00`, amount: 200 }],
      workSessions: [{ id: 'turno-certo', date: validLeapDate, km: 50, trips: 4, hours: 2 },
        { id: 'turno-impossivel', date: invalidDate, km: 900, trips: 10, hours: 5 }],
    })))
    const realized = periodStats(invalidBackup, '2024-01-01', hoje)
    const queryDate = validateQueryPlan({ source: 'transactions', metric: 'sum',
      period: { from: '2024-01-01', to: '2024-12-31' }, filter: { txType: ['expense'] } }, invalidBackup, hoje)
    const confirmedExpense = queryDate.ok === true ? runQuery(invalidBackup, queryDate.plan, hoje) : undefined
    out.push(result('DATE-backup-invalido-nao-conta-no-caixa-relatorio-ou-orcamento', { realized, confirmed: confirmedExpense?.total,
      cash: currentBalance(invalidBackup), label: fmtDateShort(invalidDate) },
      '29/02 válido soma R$ 17 e 50 km; dia impossível fica no backup e sai dos totais',
      invalidBackup.transactions.length === 3 && currentBalance(invalidBackup) === 983 && realized.expense === 17 && realized.km === 50
        && confirmedExpense?.total === 17 && categoryBreakdown(invalidBackup, '2024-01-01', hoje)[0]?.total === 17
        && budgetUsage(invalidBackup, 'casa', hoje) === 0 && fmtDateShort(invalidDate) === 'Data a conferir'))

    const ref = due.slice(0, 7)
    const invalidPayments: AppState = { ...activeCard, cardCharges: [], cardPayments: [
      { ...payment, id: 'impossivel', referenceMonth: ref, amount: 90, paymentDate: invalidDate },
      { ...payment, id: 'futuro-inexistente', referenceMonth: ref, amount: 50, paymentDate: '9999-13-01' },
      { ...payment, id: 'valido', referenceMonth: ref, amount: 20 },
    ] }
    const corruptedSettlement: AppState = { ...invalidPayments, installments: [{ ...invalidPayments.installments[0],
      status: 'paid', paidVia: 'direct', paidAmount: 200, paidAt: invalidDate,
      directPayments: [{ date: hoje, amount: 30 }, { date: invalidDate, amount: 170 }],
    }] }
    const corruptedInvoice = cardInvoice(corruptedSettlement, card, ref)
    out.push(result('DATE-fatura-legada-ignora-baixas-datadas-em-dias-impossiveis', { invoice: corruptedInvoice,
      cash: currentBalance(corruptedSettlement), debt: cardOutstanding(corruptedSettlement, card.id) },
      'só os R$ 20 da fatura e os R$ 30 da baixa direta válidos contam; o restante de R$ 150 permanece devido',
      invalidPayments.cardPayments.length === 3 && planProgress(corruptedSettlement, archivePlan).remainingAmount === 170
        && corruptedInvoice.paid === 50 && corruptedInvoice.pending === 150 && cardOutstanding(corruptedSettlement, card.id) === 150
        && currentBalance(corruptedSettlement) === 950 && futureInvoicePaymentDate(corruptedSettlement, card, ref) === undefined))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000,
      cards: [{ name: 'Inter', dueDay: Number(addDays(hoje, 3).slice(8)), closingDay: 1 }] })
    st.installmentPlans = [{ id: 'debt-magnitude', description: 'Compra', cardId: 'card0', totalAmount: 300,
      installmentCount: 1, firstDueDate: addDays(hoje, 3), purchaseDate: hoje,
      createdAt: hoje, status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'debt-magnitude-1', planId: 'debt-magnitude', number: 1, total: 1,
      amount: 300, dueDate: addDays(hoje, 3), status: 'pending' }]
    for (const phrase of ['devo muito?', 'estou devendo muito?']) {
      const r = await turnoHoje(st, phrase)
      out.push(result(`DEBT-magnitude-${phrase}`, r, 'dívida cadastrada300, sem julgamento inventado de muito/pouco',
        /300,00/.test(r.reply) && /n[ãa]o.*(?:classificar|dizer)|depende/i.test(r.reply)
          && /d[ií]vida|parcelad/i.test(r.reply) && r.actions.length === 0))
    }
    for (const phrase of ['antecipei a fatura do Inter', 'quero antecipar a fatura do Inter', 'como adiantar a fatura do Inter?']) {
      const r = await turnoHoje(st, phrase)
      out.push(result(`FANT-limite-explicito-${phrase}`, r, 'explicar limite de referência da fatura no chat, sem alegar registro',
        /chat/.test(r.reply) && /m[eê]s|refer[eê]ncia/.test(r.reply) && /Cart[õo]es e parcelamentos/i.test(r.reply)
          && !/Anotei|Registrei|Registrado!/i.test(r.reply) && r.actions.length === 0))
    }
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000, cards: [{ name: 'Inter' }] })
    for (const phrase of ['paguei a fatura de novembro do Inter 200',
      'paguei 200 da fatura do Inter de setembro', 'paguei 200 da fatura do Inter ontem']) {
      let remoteCalls = 0
      const r = await orchestrate({ state: st, message: phrase, today: hoje, remoteEnabled: true,
        askRemote: async () => { remoteCalls++; return { reply: 'Registrei!', mode: 'propose_actions',
          actions: [{ kind: 'card-payment', cardName: 'Inter', amount: 200 }], rejected: [] } } })
      out.push(result(`FREF-nao-descarta-${phrase}`, r.response, 'sem fatura para a referência; não registra e não pede ao remoto',
        r.response.actions.length === 0 && remoteCalls === 0 && /valor pendente|mês de vencimento/.test(r.response.reply)))
    }
    const ordinary = await turnoHoje(st, 'paguei 200 da fatura do Inter hoje')
    out.push(result('FREF-fatura-sem-pendente-nao-abre-confirmacao', ordinary, 'sem pendente nem outra fatura, não há botão para pagar',
      ordinary.actions.length === 0 && /não há valor pendente/i.test(ordinary.reply)))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000, cards: [{ name: 'Inter' }] })
    st.installmentPlans = [{ id: 'amount-after-card-plan', description: 'Compra', cardId: 'card0', totalAmount: 300,
      installmentCount: 1, firstDueDate: hoje, purchaseDate: addDays(hoje, -20),
      createdAt: addDays(hoje, -20), status: 'active', operationType: 'card-purchase' }]
    st.installments = [{ id: 'amount-after-card-installment', planId: 'amount-after-card-plan', number: 1, total: 1,
      amount: 300, dueDate: hoje, status: 'pending' }]
    for (const phrase of ['paguei a fatura do Inter 200', 'paguei a fatura do Inter R$ 200',
      'paguei a fatura do Inter 200 reais']) {
      const proposed = await turnoHoje(st, phrase)
      const applied = applyBatchPure(st, proposed.actions.map((action, i) =>
        ({ id: `amount-after-card-${i}`, action })), { now: { date: hoje, time: '14:00' } })
      out.push(result(`FAMT-parcial-apos-cartao-${phrase}`, { proposed, applied },
        'proposta e execução de R$ 200: saldo 800 e fatura ainda pendente em R$ 100',
        proposed.actions.length === 1 && proposed.actions[0].kind === 'card-payment'
          && proposed.actions[0].amount === 200 && applied.applied
          && currentBalance(applied.state) === 800
          && cardInvoice(applied.state, st.cards[0], hoje.slice(0, 7)).pending === 100))
    }
    const full = await turnoHoje(st, 'paguei a fatura do Inter')
    out.push(result('FAMT-sem-valor-paga-inteira', full, 'sem valor explícito, a proposta exibe o pendente da fatura',
      full.actions.length === 1 && full.actions[0].kind === 'card-payment'
        && full.actions[0].amount === undefined && full.actions[0].expectedPending === 300 && /R\$\s300,00/.test(full.reply)))
    const agora = { date: hoje, time: '14:00' }
    const outroPagamento = applyBatchPure(st, [{ id: 'pago-enquanto-esperava', action: { kind: 'card-payment', cardName: 'Inter', amount: 20 } }], { now: agora })
    const totalAntigo = applyBatchPure(outroPagamento.state, full.actions.map((action, i) => ({ id: `integral-${i}`, action })), { now: agora })
    const tentarDeNovo = await turnoHoje(outroPagamento.state, 'paguei a fatura do Inter')
    const pagoIntegral = applyBatchPure(st, full.actions.map((action, i) => ({ id: `integral-${i}`, action })), { now: agora })
    const jaQuitada = await turnoHoje(pagoIntegral.state, 'paguei a fatura do Inter')
    out.push(result('FAMT-valor-pendente-fixado-ate-confirmar', { full, totalAntigo: totalAntigo.results, tentarDeNovo, jaQuitada },
      'a proposta integral de 300 bloqueia se agora faltam 280, nova proposta mostra 280; quitada jamais propõe outra quitação',
      outroPagamento.applied && !totalAntigo.applied && totalAntigo.state === outroPagamento.state
        && /mudou de.*300,00.*280,00/.test(JSON.stringify(totalAntigo.results))
        && tentarDeNovo.actions[0]?.expectedPending === 280 && pagoIntegral.applied
        && jaQuitada.actions.length === 0 && /não há valor pendente/i.test(jaQuitada.reply)))

    const d = fromISO(hoje)
    const depoisDoDiaUm = toISOdate(new Date(d.getFullYear(), d.getMonth(), 2))
    const primeiroDaProxima = toISOdate(new Date(d.getFullYear(), d.getMonth() + 1, 1))
    const proxima = { ...st, cards: [{ ...st.cards[0], dueDay: 1, closingDay: 1 }],
      installmentPlans: [{ ...st.installmentPlans[0], firstDueDate: primeiroDaProxima }],
      installments: [{ ...st.installments[0], dueDate: primeiroDaProxima }] }
    const escolherProxima = await orchestrate({ state: proxima, message: 'paguei a fatura do Inter',
      today: depoisDoDiaUm, remoteEnabled: false })
    const propostaProxima = escolherProxima.response.mode === 'clarify' ? escolherProxima.response.clarification.options : undefined
    out.push(result('FAMT-proxima-fatura-aparece-para-escolha', escolherProxima.response,
      'após o vencimento, a fatura que a tela exibe para o próximo mês exige escolha explícita',
      escolherProxima.response.actions.length === 0 && propostaProxima?.length === 1
        && propostaProxima[0].actions?.[0].kind === 'card-payment'
        && propostaProxima[0].actions[0].referenceMonth === primeiroDaProxima.slice(0, 7)))
    const accountNumber = await turnoHoje(st, 'paguei a fatura do Inter conta 1234')
    out.push(result('FAMT-numero-de-conta-nao-e-valor', accountNumber,
      'número de conta depois do cartão não vira valor de pagamento', accountNumber.actions.length === 0))

    const overpay = await turnoHoje(st, 'Paguei 350 da fatura do Inter e gastei 15 no mercado')
    const bypass = applyBatchPure(st, [{ id: 'overpay', action: { kind: 'card-payment', cardName: 'Inter', amount: 350 } }],
      { now: { date: hoje, time: '14:00' } })
    out.push(result('FAMT-excesso-exige-conferencia', { overpay, bypass: bypass.results },
      'o valor acima do pendente fica para verificar; a despesa separada continua proposta',
      overpay.actions.length === 1 && overpay.actions.some(a => a.kind === 'expense' && a.amount === 15)
        && /supera os R\$\s300,00 pendentes/.test(overpay.reply) && !bypass.applied && bypass.state === st))

    const mesmaFala = await turnoHoje(st, 'paguei 80 da fatura do Inter e paguei 80 da fatura do Inter')
    const first = applyBatchPure(st, [{ id: 'first-payment', action: { kind: 'card-payment', cardName: 'Inter', amount: 80 } }],
      { now: { date: hoje, time: '14:00' } })
    const again = await turnoHoje(first.state, 'paguei 80 da fatura do Inter')
    const retry = applyBatchPure(first.state, [{ id: 'repeat-payment', action: { kind: 'card-payment', cardName: 'Inter', amount: 80 } }],
      { now: { date: hoje, time: '14:01' } })
    const duplicateId = reducer(first.state, { type: 'addCardPayment', payment: first.state.cardPayments[0], settleInstallmentIds: [] })
    out.push(result('FAMT-mesma-fatura-valor-data-duplicados', { mesmaFala, again, retry: retry.results },
      'uma ação no lote repetido; o mesmo pagamento no mesmo dia não sai novamente pelo chat',
      mesmaFala.actions.length === 1 && /duas vezes/.test(mesmaFala.reply) && first.applied
        && again.actions.length === 0 && /Já existe um pagamento/.test(again.reply)
        && !retry.applied && retry.state === first.state && duplicateId === first.state
        && currentBalance(first.state) === 920 && cardInvoice(first.state, st.cards[0], hoje.slice(0, 7)).pending === 220))
  }

  {
    const st = buildState({ profile: 'autonomo', balance: 1000 })
    st.settings.balanceAsOf = addDays(hoje, -1)
    st.recurring = [{ id: 'internet-pendente', name: 'Internet', amount: 120,
      frequency: 'monthly', dueDay: Number(hoje.slice(8)), startDate: hoje,
      category: 'casa', kind: 'expense', active: true }]
    // "Paguei 120 da internet" com a conta em aberto: o chat PROPÕE confirmar a
    // ocorrência (o mesmo que o card da Home faz), com o valor dito. Confirmar
    // pelo chat e depois pela Home não é possível: a ocorrência já está
    // resolvida. A despesa avulsa antiga continua recusada pelo executor.
    const proposed = await turnoHoje(st, 'paguei 120 da internet')
    const forced = applyBatchPure(st, [{ id: 'internet-chat', action: {
      kind: 'expense', amount: 120, category: 'assinaturas', description: 'Internet', date: hoje,
    } }], { now: { date: hoje, time: '14:00' } })
    const viaChat = applyBatchPure(st, proposed.actions.map((action, i) => ({ id: `rc-${i}`, action })), { now: { date: hoje, time: '14:00' }, batchId: 'rc-lote', stamp: `${hoje}T14:00:00.000` })
    const pendingAfterChat = pendingRecurrings(viaChat.state, hoje)
    const segundaVez = applyBatchPure(viaChat.state, proposed.actions.map((action, i) => ({ id: `rc2-${i}`, action })), { now: { date: hoje, time: '15:00' } })
    out.push(result('RCUR-conta-fixa-chat-confirma-ocorrencia',
      { proposed, forced: forced.results, viaChat: viaChat.results, pendingAfterChat: pendingAfterChat.length,
        saldo: currentBalance(viaChat.state), transactions: viaChat.state.transactions.length, segundaVez: segundaVez.results },
      'proposta de confirmação com R$ 120 e o vencimento; executor recusa a avulsa; confirmar baixa a conta uma vez só',
      proposed.actions.length === 1 && proposed.actions[0].kind === 'recurring-confirm'
        && proposed.actions[0].amount === 120 && proposed.actions[0].occurrenceDate === hoje && proposed.actions[0].recurringId === 'internet-pendente'
        && /conta fixa/i.test(proposed.reply) && !/tela inicial/i.test(proposed.reply)
        && !forced.applied && forced.state.transactions.length === 0
        && viaChat.applied && viaChat.state.transactions.length === 1
        && viaChat.state.transactions[0].recurringId === 'internet-pendente' && viaChat.state.transactions[0].occurrenceDate === hoje
        && viaChat.state.recurring[0].occurrences?.some(o => o.date === hoje && o.status === 'confirmed' && o.amount === 120)
        && pendingAfterChat.length === 0 && currentBalance(viaChat.state) === 880
        && !segundaVez.applied && segundaVez.results.some(r => 'code' in r && r.code === 'occurrence-resolved')))

    // Valor diferente do cadastrado: a proposta leva o valor DITO e a resposta
    // mostra os dois. Sem valor ("paguei a internet"), vale o cadastrado.
    const diferente = await turnoHoje(st, 'paguei 135 da internet')
    const semValor = await turnoHoje(st, 'paguei a internet')
    const semValorAplicado = applyBatchPure(st, semValor.actions.map((action, i) => ({ id: `sv-${i}`, action })), { now: { date: hoje, time: '14:00' } })
    out.push(result('RCUR-valor-dito-prevalece', { diferente: diferente.reply, actions: diferente.actions },
      'R$ 135 na proposta, cadastrado R$ 120 citado',
      diferente.actions.length === 1 && diferente.actions[0].kind === 'recurring-confirm' && diferente.actions[0].amount === 135
        && /135,00/.test(diferente.reply) && /cadastrado: R\$\s120,00/.test(diferente.reply)))
    out.push(result('RCUR-sem-valor-usa-cadastrado', { actions: semValor.actions, aplicado: semValorAplicado.results },
      'confirmação com o valor cadastrado (R$ 120)',
      semValor.actions.length === 1 && semValor.actions[0].kind === 'recurring-confirm'
        && semValorAplicado.applied && semValorAplicado.state.transactions[0]?.amount === 120))

    // Desfazer o lote reabre a ocorrência: a conta volta a aparecer como pendente.
    const desfeito = revertBatchPure(viaChat.state, 'rc-lote', `${hoje}T16:00:00.000`)
    out.push(result('RCUR-desfazer-reabre-ocorrencia', isRevertFailure(desfeito) ? desfeito : { pendentes: pendingRecurrings(desfeito.state, hoje).length, tx: desfeito.state.transactions.length },
      'ocorrência pendente de novo, lançamento removido',
      !isRevertFailure(desfeito) && pendingRecurrings(desfeito.state, hoje).length === 1 && desfeito.state.transactions.length === 0))

    const snoozed = { ...st, recurring: st.recurring.map(r => ({ ...r, snoozeUntil: addDays(hoje, 1) })) }
    const whileSnoozed = await turnoHoje(snoozed, 'paguei 120 da internet')
    const forcedSnoozed = applyBatchPure(snoozed, [{ id: 'internet-snoozed', action: {
      kind: 'expense', amount: 120, description: 'Internet', category: 'assinaturas',
    } }], { now: { date: hoje, time: '14:00' } })
    out.push(result('RCUR-adiada-nao-abre-rota-avulsa', { whileSnoozed, forcedSnoozed: forcedSnoozed.results },
      'adiar o aviso não permite duplicar pelo chat: a proposta é a confirmação, nunca a avulsa',
      whileSnoozed.actions.length === 1 && whileSnoozed.actions[0].kind === 'recurring-confirm' && !forcedSnoozed.applied))

    const repetida = await turnoHoje(viaChat.state, 'paguei 120 da internet')
    const antiga = applyBatchPure(viaChat.state, [{ id: 'avulsa-antiga', action: {
      kind: 'expense', amount: 120, description: 'Internet', category: 'casa',
    } }], { now: { date: hoje, time: '15:00' } })
    const distinta = await turnoHoje(viaChat.state, 'paguei 40 de instalação da internet')
    out.push(result('RCUR-nova-mensagem-nao-duplica', { repetida, antiga: antiga.results, distinta },
      'repetição não vira nova despesa; proposta avulsa antiga é recusada; instalação separada continua possível',
      repetida.actions.length === 0 && /já encontrei um registro/i.test(repetida.reply)
        && !antiga.applied && currentBalance(antiga.state) === 880
        && distinta.actions.some(a => a.kind === 'expense' && a.amount === 40)))

    const vencimentoAnterior = addDays(`${hoje.slice(0, 7)}-01`, -1)
    const quitada = { ...viaChat.state,
      recurring: [{ ...st.recurring[0], startDate: vencimentoAnterior,
        occurrences: [{ date: vencimentoAnterior, status: 'confirmed' as const, txId: viaChat.state.transactions[0].id, amount: 120 }] }],
      transactions: viaChat.state.transactions.map(t => ({ ...t, occurrenceDate: vencimentoAnterior })),
    }
    const diaSeguinte = addDays(hoje, 1)
    const repetidaAtrasada = await orchestrate({ state: quitada, message: 'Paguei 120 da internet',
      today: diaSeguinte, remoteEnabled: false })
    const origemInserida = applyBatchPure(st, [{ id: 'avulsa-com-origem', action: {
      kind: 'expense', amount: 120, description: 'Internet', category: 'casa', origin: 'Casa 2',
    } }], { now: { date: hoje, time: '15:00' } })
    out.push(result('RCUR-atrasada-nao-duplica-no-dia-seguinte', repetidaAtrasada.response,
      'pagamento recente vinculado a vencimento anterior impede repetir como avulsa',
      repetidaAtrasada.response.actions.length === 0 && /já encontrei um registro/i.test(repetidaAtrasada.response.reply)))
    out.push(result('RCUR-origem-ausente-nao-e-origem-diferente', origemInserida.results,
      'executor recusa despesa sem vínculo quando só a proposta tem origem e há conta homônima em aberto',
      !origemInserida.applied && origemInserida.state === st))

    const mesmoTurno = await turnoHoje(st, 'Paguei 120 da internet. Paguei 120 da internet. Gastei 30 no mercado.')
    const aplicado = applyBatchPure(st, mesmoTurno.actions.map((action, i) => ({ id: `repetida-${i}`, action })),
      { now: { date: hoje, time: '15:00' } })
    out.push(result('RCUR-repeticao-na-mesma-mensagem-nao-invalida-lote', { mesmoTurno, resultados: aplicado.results },
      'um pagamento da ocorrência e uma despesa avulsa válidos no lote',
      mesmoTurno.actions.filter(a => a.kind === 'recurring-confirm').length === 1 && aplicado.applied
        && aplicado.state.transactions.length === 2 && currentBalance(aplicado.state) === 850))

    const divergente = await turnoHoje(st, 'Paguei 120 da internet. Paguei 150 da internet. Gastei 30 no mercado.')
    out.push(result('RCUR-dois-valores-mesma-ocorrencia-pede-esclarecer', divergente,
      'pergunta o valor que divergiu e mantém apenas a despesa independente',
      divergente.actions.length === 1 && divergente.actions[0].kind === 'expense' && divergente.actions[0].amount === 30
        && /pagamentos diferentes/.test(divergente.reply) && !/a proposta confirma/i.test(divergente.reply)))

    const confirm = proposed.actions.find(a => a.kind === 'recurring-confirm')
    if (confirm) {
      const campos = editableFieldsFor(confirm, buildCapabilities(st)).map(f => f.name)
      const forged = applyBatchPure(st, [{ id: 'data-incorreta', action: {
        ...confirm, occurrenceDate: addDays(hoje, -1),
      } }], { now: { date: hoje, time: '15:00' } })
      out.push(result('RCUR-vencimento-invalido-recusado', { campos, results: forged.results },
        'só valor e data de pagamento editáveis; executor recusa dia fora da recorrência',
        campos.length === 2 && campos.includes('amount') && campos.includes('date') && !forged.applied
          && forged.state === st && forged.results.some(r => 'code' in r && r.code === 'occurrence-invalid')))
    } else {
      out.push(result('RCUR-vencimento-invalido-recusado', proposed, 'proposta de recorrência', false))
    }

    const homonimas = { ...st, recurring: [...st.recurring, { ...st.recurring[0], id: 'internet-2', origin: 'Casa 2', amount: 190 }] }
    const duvida = await orchestrate({ state: homonimas, message: 'Paguei 190 da internet e 30 no mercado', today: hoje, remoteEnabled: false })
    const opcoes = duvida.response.mode === 'clarify' ? duvida.response.clarification.options : undefined
    const seletor = opcoes?.find(o => o.label.includes('Casa 2'))
    const escolha = seletor && duvida.response.mode === 'clarify' ? await orchestrate({
      state: homonimas, message: seletor.label, pending: duvida.response.actions, pendingClarification: duvida.response.clarification,
      today: hoje, remoteEnabled: false,
    }) : undefined
    const comOrigem = await turnoHoje(homonimas, 'Paguei a internet da Casa 2')
    out.push(result('RCUR-homonimas-precisam-de-escolha', { duvida: duvida.response, escolha: escolha?.response, comOrigem },
      'escolher a Casa 2 prepara somente essa conta por R$ 190 e preserva o mercado',
      opcoes?.length === 2 && duvida.response.actions.length === 1 && escolha?.response.mode === 'propose_actions'
        && escolha.response.actions.some(({ action }) => action.kind === 'recurring-confirm' && action.recurringId === 'internet-2' && action.amount === 190)
        && escolha.response.actions.some(({ action }) => action.kind === 'expense' && action.amount === 30)
        && comOrigem.actions.some(a => a.kind === 'recurring-confirm' && a.recurringId === 'internet-2' && a.amount === 190)))

    const vencimentos = { ...st, recurring: [{ ...st.recurring[0], startDate: `${addDays(`${hoje.slice(0, 7)}-01`, -1).slice(0, 7)}-01` }] }
    const semMes = await turnoHoje(vencimentos, 'Paguei 120 da internet hoje')
    const desteMes = await turnoHoje(vencimentos, 'Paguei 120 da internet deste mês')
    const doMesPassado = await turnoHoje(vencimentos, 'Paguei 120 da internet do mês passado')
    const pendentes = pendingRecurrings(vencimentos, hoje)
    out.push(result('RCUR-referencia-de-mes-escolhe-vencimento', { semMes, desteMes, doMesPassado },
      'dia do pagamento não escolhe a competência; qualificadores deste mês e do mês passado selecionam cada vencimento',
      pendentes.length === 2 && semMes.actions.length === 0 && /qual ocorrência/i.test(semMes.reply)
        && desteMes.actions.some(a => a.kind === 'recurring-confirm' && a.occurrenceDate === pendentes[1].dueDate && a.amount === 120)
        && doMesPassado.actions.some(a => a.kind === 'recurring-confirm' && a.occurrenceDate === pendentes[0].dueDate && a.amount === 120)))

    const setembro = '2026-09-15'
    const fixas = { ...st, recurring: [{ ...st.recurring[0], startDate: '2026-08-05' }] }
    const nomeado = await turn(fixas, 'Paguei 120 da internet referente a setembro de 2026')
    const antigo = await turn(fixas, 'Paguei a internet de agosto')
    const conflito = await turn(fixas, 'Paguei 120 da internet deste mês com vencimento 05/08')
    const pagoOntem = await turn(fixas, 'Paguei 120 da internet do mês passado ontem')
    const referenciada = applyBatchPure(fixas, [{ id: 'avulsa-competencia', action: {
      kind: 'expense', description: 'Internet de setembro de 2026', category: 'casa', amount: 120,
    } }], { now: { date: setembro, time: '15:00' } })
    out.push(result('RCUR-competencia-por-nome-e-vencimento-conflitante', { nomeado, antigo, conflito, pagoOntem, referenciada: referenciada.applied },
      'competência nomeada seleciona a ocorrência, dia do pagamento fica separado e referências conflitantes pedem escolha',
      nomeado.mode !== 'clarify' && nomeado.actions.some(a => a.kind === 'recurring-confirm' && a.occurrenceDate === '2026-09-05')
        && antigo.actions.some(a => a.kind === 'recurring-confirm' && a.occurrenceDate === '2026-08-05' && a.amount === 120)
        && conflito.actions.length === 0 && /mês informado é diferente/.test(conflito.reply)
        && pagoOntem.actions.some(a => a.kind === 'recurring-confirm' && a.occurrenceDate === '2026-08-05' && a.date === '2026-09-14')
        && !referenciada.applied))

    const other = await turnoHoje(st, 'paguei 120 da internet e 30 no mercado')
    out.push(result('RCUR-outra-despesa-do-lote-preservada', other,
      'conta fixa vira confirmação; despesa independente de 30 continua proposta',
      other.actions.length === 2 && other.actions.some(a => a.kind === 'recurring-confirm' && a.amount === 120)
        && other.actions.some(a => a.kind === 'expense' && a.amount === 30) && /internet/i.test(other.reply)))

    const ontem = addDays(hoje, -1)
    const avulsa = { id: 'avulsa-existente', type: 'expense' as const, category: 'assinaturas', amount: 120,
      description: 'Internet', origin: 'Casa 2', date: ontem, time: '13:00', source: 'manual' as const }
    const legado: AppState = { ...st, settings: { ...st.settings, balanceAsOf: addDays(hoje, -30) },
      recurring: [{ ...st.recurring[0], origin: 'Casa 2' }], transactions: [avulsa] }
    const conta = legado.recurring[0]
    const candidatos = possibleRecurringTransactions({ ...legado, transactions: [avulsa,
      { ...avulsa, id: 'outra-casa', origin: 'Casa 1' },
      { ...avulsa, id: 'receita', type: 'income' },
      { ...avulsa, id: 'data-futura', date: addDays(hoje, 1) },
      { ...avulsa, id: 'vinculada', recurringId: 'outra-conta' },
    ] }, conta, hoje, hoje)
    const agora = { date: hoje, time: '15:00' }
    const payload = { type: 'confirmRecurring' as const, id: 'home-confirm-link', stamp: `${hoje}T15:00:00.000`,
      action: recurringLinkAction(conta, hoje, avulsa) }
    const pelaHome = reducer(legado, payload)
    const replay = reducer(pelaHome, { ...payload, id: 'home-repeat-link' })
    const pularDepois = reducer(pelaHome, { type: 'resolveOccurrence', recurringId: conta.id,
      occurrence: { date: hoje, status: 'skipped' } })
    const legadoSemEscolha = reducer(legado, { ...payload, action: { kind: 'recurring-confirm', recurringId: conta.id,
      occurrenceDate: hoje, amount: 120 } })
    out.push(result('RVIN-home-vincula-sem-mexer-no-caixa', { candidatos, saldo: currentBalance(pelaHome), pelaHome: pelaHome.recurring },
      'a Home vincula a avulsa sem mexer no valor, data, categoria ou caixa; replays e confirmação sem escolha são bloqueados',
      candidatos.length === 1 && candidatos[0].id === avulsa.id && currentBalance(pelaHome) === 880
        && pelaHome.transactions.length === 1 && JSON.stringify(pelaHome.transactions[0]) ===
          JSON.stringify({ ...avulsa, recurringId: conta.id, occurrenceDate: hoje })
        && pelaHome.recurring[0].occurrences?.[0]?.txId === avulsa.id && !pendingRecurrings(pelaHome, hoje).length
        && replay === pelaHome && pularDepois === pelaHome && legadoSemEscolha === legado))

    const noChat = await orchestrate({ state: legado, message: 'Paguei 120 da internet', today: hoje, remoteEnabled: false })
    const escolhaLegado = noChat.response.mode === 'clarify' ? noChat.response.clarification : undefined
    const escolher = (state: AppState, message: string) => orchestrate({ state, message, today: hoje, remoteEnabled: false,
      pendingClarification: escolhaLegado })
    const vincular = await escolher(legado, '1')
    const conferir = (state: AppState, actions: typeof vincular.response.actions) => applyBatchPure(state,
      actions.map(({ id, action }) => ({ id, action })), { now: agora, batchId: 'vinculo-chat', stamp: payload.stamp })
    const vinculado = conferir(legado, vincular.response.actions)
    const registroAlterado = { ...legado, transactions: [{ ...avulsa, amount: 99 }] }
    const vencida = conferir(registroAlterado, vincular.response.actions)
    const depoisDaRecarga = hydrateForTest(JSON.parse(JSON.stringify(vinculado.state)))
    const desvinculado = revertBatchPure(depoisDaRecarga, 'vinculo-chat', `${hoje}T16:00:00.000`)
    const criarNova = await escolher(legado, 'Registrar outro pagamento')
    const novoConfirmado = conferir(legado, criarNova.response.actions)
    out.push(result('RVIN-chat-escolha-explicita-e-desfaz-vinculo', { noChat: noChat.response, vincular: vincular.response,
      vinculado: vinculado.results, vencida: vencida.results, novoConfirmado: novoConfirmado.results },
      'escolher vínculo não movimenta caixa, desfazer reabre conta sem apagar a avulsa; registro separado exige sua própria escolha',
      escolhaLegado?.field === 'recurring-link' && escolhaLegado.options?.length === 2 && !noChat.response.actions.length
        && vincular.response.mode === 'propose_actions' && /Vincular lançamento existente/.test(vincular.response.reply)
        && vincular.response.actions.length === 1 && editableFieldsFor(vincular.response.actions[0].action, buildCapabilities(legado)).length === 0
        && vinculado.applied && currentBalance(vinculado.state) === 880 && !pendingRecurrings(vinculado.state, hoje).length
        && !vencida.applied && vencida.state === registroAlterado
        && !isRevertFailure(desvinculado) && currentBalance(desvinculado.state) === 880
        && desvinculado.state.transactions[0]?.id === avulsa.id && !desvinculado.state.transactions[0]?.recurringId
        && !desvinculado.state.transactions[0]?.occurrenceDate && !desvinculado.state.recurring[0]?.occurrences
        && pendingRecurrings(desvinculado.state, hoje).length === 1
        && novoConfirmado.applied && currentBalance(novoConfirmado.state) === 760 && novoConfirmado.state.transactions.length === 2))

    const diaUm = `${hoje.slice(0, 7)}-01`
    const mesAnterior = addDays(diaUm, -1).slice(0, 7)
    const contaMigrada = { ...conta, startDate: `${mesAnterior}-01`, dueDay: 1, handledMonths: [mesAnterior] }
    const txMigrada = { ...avulsa, date: diaUm }
    const migrado = { ...legado, recurring: [contaMigrada], transactions: [txMigrada] }
    const estadoMigrado = reducer(migrado, { ...payload, action: recurringLinkAction(contaMigrada, diaUm, txMigrada) })
    const mesQuitado = await turnoHoje(estadoMigrado, 'Paguei 120 da internet do mês passado')
    out.push(result('RVIN-data-antiga-ja-resolvida-continua-quitada', { ocorrencias: estadoMigrado.recurring[0].occurrences, mesQuitado },
      'criar a primeira ocorrência exata mantém o mês legado quitado no planejamento e no chat',
      estadoMigrado.recurring[0].occurrences?.[0]?.date === diaUm && !pendingRecurrings(estadoMigrado, hoje).length
        && mesQuitado.actions.length === 0 && /já encontrei um registro/i.test(mesQuitado.reply)))

    const semAncora = { ...legado, settings: { ...legado.settings, balanceAsOf: undefined },
      transactions: [{ ...avulsa, date: hoje }] }
    const novoSaldo = applyBatchPure(semAncora, [{ id: 'ajuste-saldo', action: { kind: 'balance', amount: 400 } }],
      { now: agora, batchId: 'ancora-ajustada', stamp: payload.stamp })
    const saldoDesfeito = revertBatchPure(hydrateForTest(JSON.parse(JSON.stringify(novoSaldo.state))),
      'ancora-ajustada', `${hoje}T16:00:00.000`)
    out.push(result('RVIN-undo-apos-recarga-restaura-ausencia-de-ancora', saldoDesfeito,
      'saldo anterior de 1000 menos gasto de hoje de 120 volta a 880 após recarga e desfazer',
      novoSaldo.applied && currentBalance(novoSaldo.state) === 400 && !isRevertFailure(saldoDesfeito)
        && !saldoDesfeito.state.settings.balanceAsOf && currentBalance(saldoDesfeito.state) === 880))

    const valorCorrigido = applyBatchPure(pelaHome, [{ id: 'corrigir-vinculo', action: {
      kind: 'edit-transaction', transactionId: avulsa.id, amount: 135,
    } }], { now: agora })
    const seguePaga = await turnoHoje(valorCorrigido.state, 'A conta de internet está paga?')
    const transacao = valorCorrigido.state.transactions[0]
    const snapshot = transactionOccurrence(valorCorrigido.state, transacao)
    const removido = reducer(valorCorrigido.state, { type: 'removeTx', id: transacao.id })
    const reaberta = await turnoHoje(removido, 'A conta de internet está paga?')
    const restaurar = { type: 'restoreTx' as const, tx: transacao, occurrence: snapshot }
    const restaurado = reducer(removido, restaurar)
    const novaBaixa = reducer(removido, { ...payload, action: { kind: 'recurring-confirm', recurringId: conta.id,
      occurrenceDate: hoje, amount: 120 } })
    out.push(result('RVIN-extrato-corrige-reabre-e-restaura-vencimento', { seguePaga, reaberta, restaurado: restaurado.recurring },
      'chat lê o valor corrigido de 135; excluir reabre a conta; desfazer restaura o mesmo lançamento e bloqueia duplicidades',
      valorCorrigido.applied && /está paga.*135,00/.test(seguePaga.reply) && !/120,00/.test(seguePaga.reply)
        && currentBalance(valorCorrigido.state) === 865 && !removido.transactions.length
        && pendingRecurrings(removido, hoje).length === 1 && /não.*paga/i.test(reaberta.reply)
        && restaurado.transactions[0] === transacao && restaurado.recurring[0].occurrences?.[0]?.txId === transacao.id
        && currentBalance(restaurado) === 865 && !pendingRecurrings(restaurado, hoje).length
        && reducer(restaurado, restaurar) === restaurado && novaBaixa !== removido && reducer(novaBaixa, restaurar) === novaBaixa))

    const hora = '13:00:00.000'
    const naAncora: AppState = { ...st, settings: { ...st.settings, balanceAsOf: `${hoje}T${hora}` },
      transactions: [{ ...avulsa, date: hoje, time: hora }] }
    const restauradaNaAncora = reducer(reducer(naAncora, { type: 'removeTx', id: avulsa.id }),
      { type: 'restoreTx', tx: naAncora.transactions[0] })
    out.push(result('RVIN-extrato-desfazer-mantem-hora-da-ancora', restauradaNaAncora.transactions[0],
      'desfazer exclusão mantém o carimbo da transação que já estava incluída no saldo informado',
      restauradaNaAncora.transactions[0]?.time === hora && currentBalance(restauradaNaAncora) === 1000))

    const amanha = addDays(hoje, 1)
    const baixaFutura: AppState = { ...legado, settings: { ...legado.settings, balance: 100 },
      recurring: [{ ...conta, startDate: ontem, dueDay: Number(ontem.slice(8)),
        occurrences: [{ date: ontem, status: 'confirmed', txId: avulsa.id, amount: 120 }] }],
      transactions: [{ ...avulsa, date: amanha, recurringId: conta.id, occurrenceDate: ontem }],
    }
    const futuroRestaurado = hydrateForTest(JSON.parse(JSON.stringify(baixaFutura)))
    const statusFuturo = await turnoHoje(futuroRestaurado, 'A conta de internet está paga?')
    const tentativa = await turnoHoje(futuroRestaurado, 'Paguei 120 da internet')
    const executor = applyBatchPure(futuroRestaurado, [{ id: 'baixa-anterior', action: { kind: 'recurring-confirm',
      recurringId: conta.id, occurrenceDate: ontem, amount: 120 } }], { now: agora })
    const cobertura = balanceOutlook(futuroRestaurado, 7, hoje)
    out.push(result('RFUT-backup-nao-confirma-conta-com-baixa-futura', { statusFuturo, tentativa, cobertura, executor: executor.results },
      'hoje o saldo é 100 e a conta de 120 ainda está pendente; chat e executor bloqueiam duplicidade e o caixa só baixa na data',
      /ainda está em aberto.*data futura/.test(statusFuturo.reply) && tentativa.actions.length === 0 && /data futura/.test(tentativa.reply)
        && !executor.applied && executor.state === futuroRestaurado && /data futura/.test(JSON.stringify(executor.results))
        && cobertura.balance === 100 && cobertura.ok === undefined && cobertura.unconfirmed.some(p => p.amount === 120)
        && pendingRecurrings(futuroRestaurado, hoje)[0]?.futurePaymentDate === amanha
        && pendingRecurrings(futuroRestaurado, amanha).length === 0 && currentBalance(futuroRestaurado, amanha) === -20))

    const adiada = { ...futuroRestaurado, recurring: futuroRestaurado.recurring.map(r => ({ ...r, snoozeUntil: amanha })) }
    const vencidaAdiada = { ...adiada, transactions: [], recurring: adiada.recurring.map(r => ({ ...r, occurrences: [] })) }
    out.push(result('RFUT-adiar-alerta-nao-remove-conta-da-cobertura', balanceOutlook(vencidaAdiada, 7, hoje),
      'a conta adiada some da Home até amanhã, mas o compromisso vencido continua na cobertura',
      pendingRecurrings(vencidaAdiada, hoje).length === 0 && balanceOutlook(vencidaAdiada, 7, hoje).unconfirmed.length === 1
        && balanceOutlook(vencidaAdiada, 7, hoje).ok === undefined))

    const previsao: AppState = { ...baixaFutura, recurring: [{ ...conta, startDate: amanha, dueDay: Number(amanha.slice(8)),
      occurrences: [{ date: amanha, status: 'confirmed', txId: avulsa.id, amount: 120 }] }],
      transactions: [{ ...avulsa, date: addDays(hoje, 2), recurringId: conta.id, occurrenceDate: amanha }],
    }
    const previstos = upcomingBills(previsao, 7, hoje)
    const projecao = monthlyProjections(previsao, 2, hoje).find(m => m.monthKey === amanha.slice(0, 7))
    out.push(result('RFUT-baixa-futura-nao-apaga-previsao-de-vencimento', { previstos, projecao },
      'vencimento pertence ao período previsto até que a baixa tenha ocorrido',
      previstos.length === 1 && previstos[0].date === amanha && previstos[0].amount === 120 && projecao?.bills === 120))
  }

  // "Até dia N" é PRAZO, não fato. No dia 12, "quanto preciso deixar parado
  // até dia 22" perguntava "o dia 22 deste mês ainda não chegou — qual data?":
  // a regra do "dia N" seco, feita para registro, engolia a pergunta antes do
  // roteador de caixa, e a resposta só saía nos dias do mês em que o dia já
  // tinha passado. As leituras abaixo têm data fixa; as últimas passam pelo
  // orquestrador com o relógio dos testes.
  {
    const leituras: [string, string, string, string][] = [
      ['DL-ate-dia-futuro-no-mes', 'até dia 22', '2026-11-12', 'future:2026-11-22'],
      ['DL-ate-dia-hoje', 'até dia 12', '2026-11-12', 'date:2026-11-12'],
      ['DL-ate-dia-ja-passou', 'até dia 5', '2026-11-12', 'future:2026-12-05'],
      ['DL-pro-dia', 'pro dia 25', '2026-11-12', 'future:2026-11-25'],
      ['DL-para-o-dia', 'para o dia 20', '2026-11-12', 'future:2026-11-20'],
      ['DL-antes-do-dia', 'antes do dia 30', '2026-11-12', 'future:2026-11-30'],
      ['DL-ate-dia-31-em-novembro', 'até dia 31', '2026-11-12', 'future:2026-11-30'],
      ['DL-ate-dia-virada-de-ano', 'até dia 5', '2026-12-20', 'future:2027-01-05'],
      ['DL-dia-seco-continua-ambiguo', 'gastei 50 dia 22', '2026-11-12', 'ambiguous'],
      ['DL-dia-com-mes-nao-e-prazo', 'até dia 22 de outubro', '2026-11-12', 'date:2026-10-22'],
    ]
    for (const [id, texto, dia, esperado] of leituras) {
      const d = findDate(texto, dia)
      const atual = !d ? 'null' : d.kind === 'date' || d.kind === 'future' ? `${d.kind}:${d.date}` : d.kind
      out.push(result(id, atual, esperado, atual === esperado))
    }
    const hojeN = Number(hoje.slice(8, 10))
    const futuroNoMes = hojeN <= 20 ? 25 : hojeN < 28 ? 28 : null
    if (futuroNoMes) {
      const st = estadoDeCaixaFuturo(hoje, 2000, 'autonomo')
      const alvoIso = `${hoje.slice(0, 8)}${String(futuroNoMes).padStart(2, '0')}`
      for (const [id, frase] of [
        ['DL-orquestrador-deixar-parado', `quanto preciso deixar parado ate dia ${futuroNoMes}`],
        ['DL-orquestrador-cobrem', `minhas contas cobrem ate dia ${futuroNoMes}?`],
        ['DL-orquestrador-vencem', `quais contas vencem ate dia ${futuroNoMes}`],
      ] as const) {
        const r = await turnoHoje(st, frase)
        out.push(result(id, r.reply, `fala de ${alvoIso.slice(8, 10)}/${alvoIso.slice(5, 7)}, sem perguntar a data`,
          r.actions.length === 0 && r.reply.includes(`${alvoIso.slice(8, 10)}/${alvoIso.slice(5, 7)}`)
            && !/ainda n[ãa]o chegou|quis dizer qual data/.test(r.reply)))
      }
    }
  }

  // ---- Auditoria de 12/11/2026 com as frases da missão -------------------
  // Cada caso abaixo foi lido na resposta real antes da correção (sonda
  // offline): correção que editava OUTRO lançamento, hipótese que virava fato,
  // custo de combustível respondido com receita, depósito lido do número
  // errado, aritmética declarada tratada como registro, gíria sem rota,
  // intensificador virando filtro e follow-ups que perdiam o assunto.
  {
    const brl = (v: number) => fmtBRL(v).replace(/\u00a0/g, ' ')
    const limpa = (x: string) => x.replace(/\u00a0/g, ' ')

    // Correção falada nomeia o lançamento: com Cimento e Feira de R$ 180, a
    // frase "a feira foi 150, não 180" corrige a FEIRA; sem feira, não corrige nada.
    {
      const st = buildState({ profile: 'autonomo', transactions: [
        { id: 'mi-cimento', type: 'expense', amount: 180, category: 'obra', description: 'Cimento', date: addDays(hoje, -40) },
        { id: 'mi-feira', type: 'expense', amount: 180, category: 'alimentacao', description: 'Feira', date: addDays(hoje, -1) },
      ] })
      const r = await turnoHoje(st, 'na verdade a feira foi 150, não 180')
      out.push(result('MI-correcao-pelo-sujeito', { reply: r.reply, actions: r.actions }, 'edit-transaction em mi-feira, nunca em mi-cimento',
        r.actions.length === 1 && r.actions[0].kind === 'edit-transaction' && r.actions[0].transactionId === 'mi-feira' && r.actions[0].amount === 150))
      const soCimento = { ...st, transactions: st.transactions.filter(t => t.id !== 'mi-feira') }
      const frase = 'Na verdade a compra de material escolar foi 150, não 180'
      const semMaterial = await turnoHoje(soCimento, frase)
      const comMaterial = await turnoHoje({ ...soCimento, transactions: [...soCimento.transactions, {
        ...soCimento.transactions[0], id: 'material', description: 'Material escolar',
      }] }, frase)
      out.push(result('MI-correcao-com-nome-composto', { semMaterial, comMaterial },
        'o conector "de" preserva o nome composto; ausência do alvo impede corrigir Cimento',
        semMaterial.actions.length === 0
          && comMaterial.actions.some(a => a.kind === 'edit-transaction' && a.transactionId === 'material' && a.amount === 150)))
      const formas = [
        'Na verdade compra de material escolar foi 150, não 180',
        'Na verdade a "feira de rua" foi 150, não 180',
        'Na verdade o material e ferramenta foi 150, não 180',
      ]
      const historico = { ...soCimento, transactions: [...soCimento.transactions, {
        ...soCimento.transactions[0], id: 'material-eletrico', description: 'Material elétrico',
      }] }
      const correcoes = await Promise.all(formas.map(text => turnoHoje(historico, text)))
      out.push(result('MI-correcao-preserva-o-nome-inteiro', correcoes,
        'sem correspondência para nome sem artigo, entre aspas ou com conjunção, nenhuma edição é proposta',
        correcoes.every(r => r.actions.length === 0 && /não achei/i.test(r.reply))))
      const r2 = await turnoHoje(soCimento, 'na verdade a feira foi 150, não 180')
      out.push(result('MI-correcao-sem-alvo-nao-chuta', { reply: r2.reply, actions: r2.actions }, 'sem feira: nenhuma ação, diz que não achou',
        r2.actions.length === 0 && /n[ãa]o achei/i.test(r2.reply) && /feira/i.test(r2.reply)))
    }

    // Hipótese sobre uma coisa que não é "eu" nunca vira fato.
    {
      const mot = motoristaRico(hoje)
      const r = await turnoHoje(mot, 'Se a gasolina aumentar 12% e eu rodar 20% mais quilômetros, qual seria meu lucro estimado?')
      out.push(result('MI-hipotese-percentual-nao-vira-fato', r.reply, 'diz que é hipótese; nenhum "(dado real)"',
        r.actions.length === 0 && /hip[óo]tese|simula/i.test(r.reply) && !/dado real/.test(r.reply)))
    }

    // "Quanto devo gastar de combustível" é custo, não ganho por km.
    {
      const mot = motoristaRico(hoje)
      const custo = kmCost(mot)
      const r = await turnoHoje(mot, 'Se eu rodar mais 100 km hoje, quanto devo gastar de combustível?')
      out.push(result('MI-km-a-mais-pede-combustivel', r.reply, custo.fuelPerKm > 0 ? `combustível ≈ ${brl(custo.fuelPerKm * 100)}` : 'sem consumo/preço: pede o abastecimento',
        r.actions.length === 0 && /combust[íi]vel/i.test(r.reply) && !/ritmo real/i.test(r.reply)
          && (custo.fuelPerKm > 0 ? limpa(r.reply).includes(brl(Math.round(custo.fuelPerKm * 100 * 100) / 100)) : /consumo/i.test(r.reply))))
    }

    {
      const diaAnterior = `${addDays(`${hoje.slice(0, 7)}-01`, -1).slice(0, 7)}-01`
      const st = buildState({ profile: 'driver', transactions: [
        { id: 'km-hoje-carro', type: 'expense', amount: 50, category: 'combustivel', date: hoje },
        { id: 'km-hoje-comida', type: 'expense', amount: 150, category: 'alimentacao', date: hoje },
        { id: 'km-anterior-carro', type: 'expense', amount: 100, category: 'combustivel', date: diaAnterior },
        { id: 'km-anterior-pedagio', type: 'expense', amount: 50, category: 'pedagio', date: diaAnterior },
        { id: 'km-anterior-casa', type: 'expense', amount: 400, category: 'casa', date: diaAnterior },
      ] })
      st.settings.kmPerLiter = 10
      st.settings.fuelPricePerLiter = 5
      st.settings.fixedMonthlyCosts = 50
      st.fuelRecords = []
      st.maintenance = [{ id: 'km-peca', name: 'Peça', cost: 200, lifeKm: 1000, kmInstalled: 10000, date: diaAnterior }]
      st.workSessions = [
        { id: 'km-trabalho-atual', date: hoje, km: 100, hours: 6, trips: 10 },
        { id: 'km-trabalho-anterior', date: diaAnterior, km: 100, hours: 6, trips: 10 },
      ]

      const historico = await turnoHoje(st, 'Quanto meu carro custou por km no mês passado?')
      out.push(result('VK-periodo-consulta-gastos-registrados', historico.reply,
        'R$ 1,50/km de R$ 150 em despesas do veículo ÷ 100 km, sem o gasto da casa',
        /mês passado.*R\$\s1,50\/km.*R\$\s150,00.*100 km/.test(historico.reply) && historico.actions.length === 0))

      const geral = await turnoHoje(st, 'Quanto gastei por km este mês?')
      out.push(result('VK-gasto-geral-informa-a-unidade', geral.reply, 'R$ 2,00/km de todas as despesas realizadas',
        /este mês.*R\$\s2,00\/km.*dado real/.test(geral.reply) && geral.actions.length === 0))

      const respostas = await Promise.all([
        'Quanto meu carro custa por km?', 'Qual é o custo do meu carro por quilômetro?',
        'Quanto sai o km do veículo?', 'Qual o custo por km da minha moto?',
      ].map(frase => turnoHoje(st, frase, geral.focus)))
      const porQue = await turnoHoje(st, 'Por quê?', respostas[1].focus)
      out.push(result('VK-estimativa-bate-com-veiculo-e-explica', { replies: respostas.map(r => r.reply), porQue: porQue.reply },
        'R$ 1,20/km de R$ 0,50 de combustível, R$ 0,20 de manutenção e R$ 0,50 de fixos; o por quê explica a estimação',
        respostas.every(r => r.actions.length === 0 && /R\$\s1,20\/km/.test(r.reply)
          && /Combustível: R\$\s0,50\/km/.test(r.reply) && /Manutenção: R\$\s0,20\/km/.test(r.reply)
          && /Custos fixos: R\$\s0,50\/km/.test(r.reply)) && /cálculo da tela Veículo/.test(porQue.reply)))
      const anterior = await turnoHoje(st, 'E no mês passado?', porQue.focus)
      out.push(result('VK-continua-no-veiculo', anterior.reply, historico.reply,
        anterior.reply === historico.reply && anterior.actions.length === 0))

      const semKm = await turnoHoje({ ...st, workSessions: [] }, 'Quanto gastei por km este mês?')
      const semKmAnterior = await turnoHoje({ ...st, workSessions: st.workSessions.slice(0, 1) }, 'Meu custo por km piorou?')
      out.push(result('VK-sem-distancia-nao-mostra-zero-ou-veredito', [semKm.reply, semKmAnterior.reply],
        'sem km, pede dados; na comparação mostra só o gasto atual e explica o que falta',
        /^Não tenho quilometragem/.test(semKm.reply) && !/R\$/.test(semKm.reply)
          && /R\$\s2,00\/km/.test(semKmAnterior.reply) && /quilometragem.*para comparar/.test(semKmAnterior.reply)
          && !/^(?:Sim|Não,)|R\$\s0,00\/km/.test(semKmAnterior.reply)))
    }

    // Os valores esperados são calculados a partir dos valores fixos do
    // fixture, com 300 km, R$ 600 de corridas e consumo de 10 km/L.
    {
      const dias = [addDays(hoje, -3), addDays(hoje, -2), addDays(hoje, -1)]
      const st = buildState({ profile: 'driver', transactions: [
        ...dias.map((date, i) => ({ id: `rodagem-r${i}`, type: 'income' as const, amount: 200, category: 'corridas', date })),
        { id: 'rodagem-c', type: 'expense', amount: 100, category: 'combustivel', date: dias[0] },
        { id: 'rodagem-m', type: 'expense', amount: 50, category: 'manutencao', date: dias[0] },
      ] })
      st.settings.kmPerLiter = 10
      st.settings.fuelPricePerLiter = 5
      st.workSessions = dias.map((date, i) => ({ id: `rodagem-w${i}`, date, km: 100, hours: 6, trips: 10 }))
      st.maintenance = [{ id: 'desgaste', date: dias[0], name: 'Peça', cost: 1000, lifeKm: 5000, kmInstalled: 5000 }]
      const casos: [string, string, RegExp, RegExp?][] = [
        ['percentuais', 'Se a gasolina aumentar 20%, e eu rodar 10% mais quilômetros, qual seria meu lucro?', /Lucro estimado para 330 km: R\$\s412,00/, /R\$\s400,00.*R\$\s12,00 a mais/],
        ['preco-por-cento', 'Se eu rodar mais 100 km com a gasolina doze por cento mais cara, quanto vou gastar de combustível?', /100 km: R\$\s56,00/, /R\$\s50,00.*R\$\s6,00 a mais/],
        ['preco-por-litro', 'Se eu rodar mais 100 km e a gasolina for de 5 para 9 reais o litro, quanto vou gastar de combustível?', /100 km: R\$\s90,00/, /R\$\s9,00 por litro/],
        ['novo-preco-dado', 'Se eu rodar mais 100 km e a gasolina subir para R$ 9 por litro, quanto vou gastar de combustível?', /100 km: R\$\s90,00/],
        ['preco-sem-unidade', 'Se eu rodar mais 100 km com a gasolina a R$ 9, quanto vou gastar de combustível?', /qual preço por litro/i],
        ['litros', 'Se eu rodar mais 100 km, quantos litros de gasolina vou gastar?', /100 km: 10(?:,0)? L/],
        ['manutencao', 'Se eu rodar mais 100 km, quanto vai custar a manutenção?', /100 km: R\$\s20,00/, /provisão de desgaste/],
        ['dias', 'Se eu trabalhar mais dois dias por semana, quanto aumenta meu lucro?', /Lucro estimado por semana para 275 km: R\$\s400,00/, /R\$\s100,00.*R\$\s300,00 a mais/],
        ['semana-impossivel', 'Se eu trabalhar mais sete dias por semana, quanto aumenta meu lucro?', /não cabe em uma semana/],
      ]
      for (const [id, text, valor, detalhe] of casos) {
        const r = await turnoHoje(st, text)
        out.push(result(`MI-rodagem-${id}`, r.reply, `${valor}${detalhe ? ` e ${detalhe}` : ''}`,
          r.actions.length === 0 && valor.test(r.reply) && (!detalhe || detalhe.test(r.reply))
          && /Simulação — nada foi registrado/.test(r.reply)))
      }
      const vazio = await turnoHoje(buildState({ profile: 'driver' }),
        'Se a gasolina aumentar 20% e eu rodar 10% mais km, qual seria meu lucro?')
      out.push(result('MI-rodagem-sem-historico', vazio.reply, 'pede registros antes de estimar lucro sem base',
        vazio.actions.length === 0 && /quilometragem em pelo menos 3 dias/.test(vazio.reply) && !/R\$/.test(vazio.reply)))
    }

    {
      const st = buildState({ profile: 'autonomo', balance: 1000, cards: [
        { name: 'Inter', limit: 5000, closingDay: 10, dueDay: 25 },
      ] })
      st.settings.balanceAsOf = '2026-09-01'
      const compra = await turn(st, 'Se eu der R$ 200 de entrada e financiar R$ 1.000 em 4x no Inter, como fica a compra?')
      const adiada = await turn(st, 'E se eu adiar a compra por dois meses?', compra.focus)
      const linhas = adiada.focus?.lastScenario?.months || []
      out.push(result('MI-adiar-compra-desloca-entrada-e-fatura', { compra: compra.reply, adiada: adiada.reply, linhas },
        'setembro e outubro sem saída; entrada de R$ 200 em novembro e primeira parcela de R$ 250 em dezembro',
        adiada.actions.length === 0 && /15\/11\/2026.*25\/12\/2026/.test(adiada.reply)
          && linhas[0]?.after === 1000 && linhas[1]?.after === 1000 && linhas[2]?.after === 800 && linhas[3]?.after === 550))
      const semCompra = await turn(st, 'Se eu adiar a compra em dois meses, como fica?')
      out.push(result('MI-adiar-compra-sem-alvo-pede-dados', semCompra, 'pede qual compra se não há simulação anterior',
        semCompra.actions.length === 0 && /qual compra você quer adiar/i.test(semCompra.reply)))
    }

    // O depósito é o número junto do verbo, não o acumulado dito antes.
    {
      const rico = autonomoRico(hoje)
      const r = await turnoHoje(rico, 'Já tenho R$ 4.800 na viagem. Se eu guardar R$ 350 por mês, quando termino?')
      out.push(result('MI-guardar-valor-junto-do-verbo', r.reply, 'R$ 350,00 por mês e 4 meses (faltam R$ 1.200)',
        /R\$\s350,00 por m[êe]s/.test(r.reply) && /\b4 meses\b/.test(r.reply) && !/4\.800,00 por m/.test(r.reply)))
    }

    {
      const rico = autonomoRico(hoje)
      const declarado = await turnoHoje(rico, 'Já tenho R$ 2.000 na viagem, se eu guardar R$ 500 por mês, quando termino?')
      const outraMeta = await turnoHoje(rico, 'Já tenho R$ 2.000 na viagem. Se eu guardar R$ 500 por mês para o Notebook, quando termino?')
      const completa = await turnoHoje(rico, 'Já tenho R$ 6.000 na viagem. Se eu guardar R$ 500 por mês, quando termino?')
      out.push(result('MI-meta-usa-acumulado-informado', { declarado, outraMeta, completa },
        'Viagem usa o valor da pergunta, Notebook usa seu próprio acumulado e meta atingida não cita mês anterior',
        declarado.actions.length === 0 && /8 meses.*Viagem.*4\.000,00/.test(declarado.reply)
          && /2\.000,00 como acumulado inicial/.test(declarado.reply) && !/não incluí/i.test(declarado.reply)
          && /6 meses.*Notebook.*2\.800,00/.test(outraMeta.reply) && !/2\.000,00 como acumulado inicial/.test(outraMeta.reply)
          && /já alcança a meta Viagem/.test(completa.reply) && !/por volta de/.test(completa.reply)))
    }

    // Aritmética com os números da frase: nem registro, nem "ainda não aconteceu".
    {
      const st = buildState({ profile: 'autonomo', balance: 5000 })
      const r = await turnoHoje(st, 'Tenho R$ 1.800 hoje. Preciso pagar R$ 950 de aluguel, R$ 320 de energia e quero guardar R$ 400. Quanto ainda preciso ganhar?')
      out.push(result('MI-conta-declarada-sobra', { reply: r.reply, actions: r.actions }, 'sobram R$ 130,00; sem ação; não usa o saldo do app (5.000)',
        r.actions.length === 0 && /sobram R\$\s130,00/.test(r.reply) && !/5\.000,00/.test(r.reply) && !/ainda n[ãa]o aconteceu/.test(r.reply)))
      const r2 = await turnoHoje(st, 'tenho 1000 hoje, preciso pagar 950 de aluguel e 320 de luz. quanto falta ganhar?')
      out.push(result('MI-conta-declarada-falta', { reply: r2.reply, actions: r2.actions }, 'faltam R$ 270,00',
        r2.actions.length === 0 && /Faltam R\$\s270,00/.test(r2.reply)))
      const milhar = await turnoHoje(st, 'Tenho 1800 hoje, preciso pagar 1.250 de aluguel e 320 de energia. Quanto sobra?')
      const misto = await turnoHoje(st, 'Gastei 100 no mercado. Tenho 1800 hoje, preciso pagar 950 de aluguel e 320 de energia. Quanto sobra?')
      out.push(result('MI-conta-declarada-com-milhar', milhar,
        'saldo R$ 230, com aluguel R$ 1.250 e energia R$ 320',
        milhar.actions.length === 0 && /sobram R\$\s230,00/.test(milhar.reply) && /1\.250,00.*320,00/.test(milhar.reply)))
      out.push(result('MI-conta-declarada-preserva-registro', misto, 'sobra declarada de R$ 530 mais proposta de R$ 100 no mercado',
        /sobram R\$\s530,00/.test(misto.reply) && misto.actions.length === 1
          && misto.actions.some(a => a.kind === 'expense' && a.amount === 100 && /mercado/i.test(a.description || ''))))
      const reservado = await turnoHoje(st, 'Tenho 1800 para pagar 950 de aluguel e 320 da Casa 2. Quanto sobra?')
      const negado = await turnoHoje(st, 'Não tenho 1800 hoje, preciso pagar 950 de aluguel e 320 de energia. Quanto sobra?')
      const incompleto = await turnoHoje(st, 'Tenho 1800 hoje, preciso pagar 1250 de aluguel e a energia. Quanto sobra?')
      out.push(result('MI-dinheiro-para-pagar-e-orcamento', reservado, 'sobra de R$ 530 e nenhuma proposta de despesa',
        reservado.actions.length === 0 && /sobram R\$\s530,00/.test(reservado.reply)))
      out.push(result('MI-conta-declarada-saldo-negado', negado, 'pede saldo disponível sem concluir que sobrou dinheiro',
        negado.actions.length === 0 && /quanto você tem disponível/i.test(negado.reply) && !/sobram R\$/.test(negado.reply)))
      out.push(result('MI-conta-declarada-compromisso-sem-valor', incompleto, 'pede o valor de cada conta antes de calcular sobra',
        incompleto.actions.length === 0 && /valor de cada conta/i.test(incompleto.reply) && !/sobram R\$/.test(incompleto.reply)))
      const noMeio = await turnoHoje(st, 'Tenho 1800 hoje. Gastei 100 no mercado ontem. Preciso pagar 950 de aluguel e 320 de energia. Quanto sobra?')
      out.push(result('MI-conta-declarada-com-gasto-no-meio', noMeio, 'R$ 530 de sobra e proposta de despesa de ontem',
        /sobram R\$\s530,00/.test(noMeio.reply) && noMeio.actions.length === 1
          && noMeio.actions.some(a => a.kind === 'expense' && a.amount === 100 && a.date === addDays(hoje, -1))))
      const soSaldo = await turnoHoje(st, 'tenho 1800 hoje')
      out.push(result('MI-conta-declarada-nao-sequestra-saldo', soSaldo.actions, 'só "tenho 1800 hoje" não é a conta declarada',
        !/Usei só os valores que você disse/.test(soSaldo.reply)))
    }

    // "Por semana" responde em semanas.
    {
      const st = buildState({ profile: 'autonomo' })
      const r = await turnoHoje(st, 'Quero ter R$ 6.000 guardados até março. Quanto preciso separar por semana?')
      out.push(result('MI-meta-por-semana', r.reply, 'N semanas e valor por semana', /\d+ semanas, de R\$\s[\d.,]+ por semana/.test(r.reply)))
    }

    // Gíria de aperto tem a mesma rota de "tô no vermelho", com o que vence.
    for (const [perfil, st] of [['autonomo', autonomoRico(hoje)], ['driver', motoristaRico(hoje)]] as const) {
      const r = await turnoHoje(st, 'Cara, tô ferrado esse mês?')
      out.push(result(`MI-to-ferrado-${perfil}`, r.reply, 'Sim/Não na frente, entradas e saídas, compromissos',
        /^(?:Sim|Não) — /.test(r.reply) && /entraram R\$/.test(r.reply) && /Compromissos vencidos/.test(r.reply) && !/Posso te ajudar/.test(r.reply)))
    }

    // Intensificador não é nome de nada.
    {
      const r = await turnoHoje(motoristaRico(hoje), 'Quanto estou ganhando por hora de verdade?')
      out.push(result('MI-de-verdade-nao-e-filtro', r.reply, 'R$/hora, sem "verdade"', /\/hora/.test(r.reply) && !/"verdade"/.test(r.reply)))
    }

    // Conversa da missão: gasolina esta semana → e na passada → sem contar terça → compara com alimentação.
    {
      const mot = motoristaRico(hoje)
      const t1 = await turnoHoje(mot, 'Quanto eu gastei com gasolina esta semana?')
      const t2 = await turnoHoje(mot, 'E na passada?', t1.focus)
      const t3 = await turnoHoje(mot, 'Sem contar terça.', t2.focus)
      const t4 = await turnoHoje(mot, 'Agora compara com alimentação.', t3.focus)
      out.push(result('MI-conversa-e-na-passada', t2.reply, 'gasolina no período anterior, sem filtro "passada"',
        /Gasolina/.test(t2.reply) && /anterior|passad/.test(t2.reply) && !/"passada"/.test(t2.reply)))
      out.push(result('MI-conversa-sem-contar-terca', t3.reply, 'continua gasolina; nada de vencimentos',
        /Gasolina/.test(t3.reply) && !/vence/.test(t3.reply)))
      out.push(result('MI-conversa-compara-com-alimentacao', t4.reply, 'os dois assuntos lado a lado',
        /Gasolina/.test(t4.reply) && /Alimenta[çc][ãa]o/.test(t4.reply)))
    }

    // Correção dentro da frase não deixa resíduo: o 120 foi substituído.
    {
      const r = await turnoHoje(motoristaRico(hoje), 'Gastei 120 no mercado, não, pera, foram 102.')
      out.push(result('MI-correcao-intra-sem-residuo', { reply: r.reply, actions: r.actions }, 'uma despesa de 102, sem perguntar pelos 120',
        r.actions.length === 1 && r.actions[0].kind === 'expense' && r.actions[0].amount === 102 && !/mencionou R\$\s120/.test(r.reply)))
    }

    // "Fiz 350 DE uber": a plataforma depois de "de" fica na receita.
    {
      const r = await turnoHoje(motoristaRico(hoje), 'ontem fiz 350 de uber e 180 na 99')
      const descs = r.actions.filter(a => a.kind === 'income').map((a: any) => `${a.amount}:${a.description}`).sort().join(',')
      out.push(result('MI-fiz-de-uber', descs, '180:99,350:Uber', descs === '180:99,350:Uber'))
    }

    // A proporção usa o total da primeira pergunta e o faturamento da Uber
    // no mesmo período. Um denominador ausente não vira 0% ou infinito.
    {
      const st = motoristaRico(hoje)
      const limite = addDays(hoje, -29)
      const despesas = st.transactions.filter(t => t.type === 'expense' && t.category === 'combustivel' && t.date >= limite && t.date <= hoje)
      const uber = st.transactions.filter(t => t.type === 'income' && t.description === 'Uber' && t.date >= limite && t.date <= hoje)
      const total = (items: typeof uber) => items.reduce((sum, t) => sum + t.amount, 0)
      const proporcao = (total(despesas) / total(uber) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
      const primeira = 'Quanto gastei de combustível nos últimos 30 dias, sem contar a despesa de manutenção'
      const segunda = 'quanto isso representa do meu faturamento na Uber?'
      const composta = await turnoHoje(st, `${primeira}, e ${segunda}`)
      const inicial = await turnoHoje(st, `${primeira}?`)
      const continuacao = await turnoHoje(st, segunda, inicial.focus)
      out.push(result('MI-pergunta-composta', composta.reply, `total de combustível e ${proporcao}% do faturamento na Uber`,
        /Combust[íi]vel[^\n]*nos últimos 30 dias: R\$/.test(composta.reply)
          && composta.reply.includes(`${proporcao}%`) && composta.reply.includes(fmtBRL(total(uber)))
          && /total recebido na Uber nos últimos 30 dias/i.test(composta.reply) && composta.actions.length === 0))
      out.push(result('MI-proporcao-em-outro-turno', continuacao.reply, `${proporcao}% sobre o mesmo período`,
        continuacao.reply.includes(`${proporcao}%`) && /Uber nos últimos 30 dias/.test(continuacao.reply) && continuacao.actions.length === 0))
      const semUber = { ...st, transactions: st.transactions.filter(t => t.description !== 'Uber') }
      const semBase = await turnoHoje(semUber, `${primeira}, e ${segunda}`)
      out.push(result('MI-proporcao-sem-denominador', semBase.reply, 'explica a falta do denominador sem inventar proporção',
        /não encontrei um total disponível/i.test(semBase.reply) && !/\d\s*%/.test(semBase.reply) && semBase.actions.length === 0))
    }

    // Preferência de análise que o app não guarda: dita, nunca o menu nem a resposta à pergunta embutida.
    for (const [id, frase] of [
      ['MI-preferencia-reserva', 'Considera sempre uma reserva de emergência de R$ 300 antes de me dizer quanto posso gastar.'],
      ['MI-preferencia-liquido', 'Prefiro analisar meus ganhos líquidos.'],
      ['MI-preferencia-otimista', 'Não usa projeções otimistas.'],
    ] as const) {
      const r = await turnoHoje(autonomoRico(hoje), frase)
      out.push(result(id, r.reply, 'diz que ainda não guarda esse tipo de preferência',
        r.actions.length === 0 && /ainda não guardo/.test(r.reply) && !/Posso te ajudar|Dá uns/.test(r.reply)))
    }

    // Intenção de gastar menos: histórico do assunto, não "isso não aconteceu".
    {
      const r = await turnoHoje(motoristaRico(hoje), 'Quero diminuir meus gastos com gasolina, mas sem mudar minha meta diária.')
      out.push(result('MI-intencao-de-reduzir', r.reply, 'entende a intenção e mostra o combustível dos últimos 30 dias',
        r.actions.length === 0 && /Entendi a intenção/.test(r.reply) && /R\$/.test(r.reply) && !/não aconteceu/.test(r.reply)))
    }
  }

  return out
}

/**
 * Três cartões em volta de HOJE: Inter com fatura de 300 vencida há 5 dias
 * (Celular 3x de 300), Nubank com fatura de 250 fechada que vence em 3 dias
 * (Fone 3x de 250), C6 com fatura de 200 vencida há 2 dias e paga pela fatura.
 */
function estadoDeFaturas(hoje: string): AppState {
  const s = buildState({ profile: 'autonomo', balance: 3000 })
  const dia = (iso: string) => Number(iso.slice(8, 10))
  const mes = (iso: string, n: number) => {
    const d = fromISO(iso)
    return toISOdate(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28)))
  }
  const inter = addDays(hoje, -5)
  const nubank = addDays(hoje, 3)
  const c6 = addDays(hoje, -2)
  s.cards = [
    { id: 'sf-nubank', name: 'Nubank', limit: 5000, closingDay: dia(addDays(hoje, -2)), dueDay: dia(nubank), createdAt: addDays(hoje, -120) },
    { id: 'sf-inter', name: 'Inter', limit: 5000, closingDay: dia(addDays(inter, -7)), dueDay: dia(inter), createdAt: addDays(hoje, -120) },
    { id: 'sf-c6', name: 'C6', limit: 5000, closingDay: dia(addDays(c6, -7)), dueDay: dia(c6), createdAt: addDays(hoje, -120) },
  ] as AppState['cards']
  const plano = (id: string, description: string, cardId: string, parcela: number, primeira: string) => ({
    id, description, cardId, totalAmount: parcela * 3, installmentCount: 3, firstDueDate: primeira,
    purchaseDate: addDays(primeira, -20), status: 'active', operationType: 'card-purchase', createdAt: addDays(primeira, -20),
  })
  s.installmentPlans = [
    plano('sf-p-inter', 'Celular', 'sf-inter', 300, inter),
    plano('sf-p-nubank', 'Fone', 'sf-nubank', 250, nubank),
    plano('sf-p-c6', 'Cadeira', 'sf-c6', 200, c6),
  ] as AppState['installmentPlans']
  const parcelas = (planId: string, valor: number, primeira: string, dueDay: number) => [0, 1, 2].map(n => {
    const base = mes(primeira, n)
    return { id: `${planId}-${n + 1}`, planId, number: n + 1, total: 3, amount: valor,
      dueDate: n === 0 ? primeira : `${base.slice(0, 8)}${String(Math.min(dueDay, 28)).padStart(2, '0')}`, status: 'pending' }
  })
  s.installments = [
    ...parcelas('sf-p-inter', 300, inter, dia(inter)),
    ...parcelas('sf-p-nubank', 250, nubank, dia(nubank)),
    ...parcelas('sf-p-c6', 200, c6, dia(c6)).map((i, n) => n === 0
      ? { ...i, status: 'paid', paidAt: c6, paidAmount: 200, paidVia: 'invoice' } : i),
  ] as AppState['installments']
  s.cardPayments = [{ id: 'sf-pay-c6', cardId: 'sf-c6', amount: 200, paymentDate: c6, referenceMonth: c6.slice(0, 7),
    settledInstallmentIds: ['sf-p-c6-1'] }]
  return s
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
