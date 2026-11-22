// MOTOR DE CENÁRIOS — puro, somente leitura, sobre estado PROJETADO.
//
// Não existe uma única escrita neste arquivo. O estado chega como valor, uma
// CÓPIA é montada com a hipótese dentro, e as funções de cálculo do app rodam
// sobre a cópia. Terminado o cálculo, a cópia é descartada.
//
// A simulação de compra usa `splitInstallmentAmounts` e `nextInvoiceDueDate` —
// as MESMAS funções da compra real. Reescrever a matemática aqui criaria duas
// versões da verdade, e a divergência só apareceria depois que o usuário
// tivesse comprado.

import type { AppState, InstallmentPlan, Transaction } from '../../models/types'
import { addDays, dateForDayOfMonth, fmtBRL, fmtNum, fromISO, monthKey, todayISO, toISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import {
  cashObligationsUntil, currentBalance, dailyGoal, monthlyProjections, nextCashEventTime, periodStats,
  representedRecurringExpenseMonths, todayStats, fuelCostBasis, kmCost,
} from '../../services/calc'
import {
  activeCards, buildInstallments, cardById, currentInvoice, invoiceOpenAmount, nextInvoiceDueDate, splitInstallmentAmounts, hasAmbiguousLegacyCardBalance,
} from '../../services/cards'
import { isDriver } from '../../services/profile'
import { brDate } from '../dates'
import { findPayoffPlan } from './payoff'
import { incomeLossEnd, incomeLossLabel, isRentalIncome, matchesIncomeSource, pendingIncomeInWindow, validIncomeLossDuration, INCOME_LOSS_WINDOW_LIMIT } from './incomeWindow'
import type { AssistantFact } from '../query/types'
import type { AssistantScenarioPlan, AssistantScenarioResult, DrivingScenario, ScenarioMonth } from './types'

const r2 = (v: number) => Math.round(v * 100) / 100

let seq = 0
const fid = () => `s${++seq}`

const fato = (
  label: string, value: number, unit: AssistantFact['unit'], detalhe: string, linhas = 1,
): AssistantFact => ({
  id: fid(), label, value: r2(value), unit,
  provenance: { source: 'simulação', rows: linhas, detail: detalhe },
  // TODO fato de cenário é SEMPRE estimativa. Nunca remover esta marca.
  estimated: true,
})

/** Cópia do estado com uma despesa hipotética de hoje. Nada é gravado. */
function comDespesa(state: AppState, amount: number, category: string, hoje: string): AppState {
  const t: Transaction = {
    id: `sim-${fid()}`, type: 'expense', amount, category,
    description: 'Simulação', date: hoje, time: nextCashEventTime(state, hoje, '23:59:59.999', true), source: 'manual',
  }
  return { ...state, transactions: [...(state.transactions || []), t] }
}

/**
 * Cópia do estado com uma compra parcelada hipotética.
 *
 * Reaproveita a construção real das parcelas. Uma entrada futura é descontada
 * da projeção no mês da compra. Se for hoje, vale como despesa na cópia.
 */
function comCompra(
  state: AppState, plan: AssistantScenarioPlan, hoje: string,
): { state: AppState; parcela: number; financiado: number; cardNome?: string; porMes: (mk: string) => number;
  compraEm: string; primeiro: string; entrada: number } {
  const total = plan.amount || 0
  const entrada = Math.min(plan.downPayment || 0, total)
  const financiado = r2(total - entrada)
  const n = Math.max(1, Math.round(plan.installments || 1))

  const card = plan.cardName
    ? activeCards(state).find(c => normalizeName(c.name).includes(normalizeName(plan.cardName!)))
    : (activeCards(state).length === 1 ? activeCards(state)[0] : undefined)

  const d = fromISO(hoje)
  const compraEm = toISO(dateForDayOfMonth(d.getFullYear(), d.getMonth() + (plan.purchaseDelayMonths || 0), d.getDate()))
  const primeiro = card ? nextInvoiceDueDate(card, compraEm) : addDays(compraEm, 30)

  const planoSim: InstallmentPlan = {
    id: `sim-plan-${fid()}`, description: plan.description || 'Compra simulada',
    cardId: card?.id, totalAmount: financiado, installmentCount: n,
    firstDueDate: primeiro, purchaseDate: compraEm, status: 'active',
    operationType: 'card-purchase', createdAt: compraEm,
  }
  const parcelasSim = buildInstallments(planoSim, () => `sim-inst-${fid()}`)

  let projetado: AppState = {
    ...state,
    installmentPlans: [...(state.installmentPlans || []), planoSim],
    installments: [...(state.installments || []), ...parcelasSim],
  }
  if (entrada > 0 && compraEm === hoje) projetado = comDespesa(projetado, entrada, plan.category || 'outros-out', hoje)

  // Parcela que cai em CADA mês, pelo calendário simulado. A linha de outubro
  // dizia "com a parcela de R$ 400" para uma compra cuja primeira parcela vence
  // em novembro — o saldo estava certo, o texto não.
  const porMes = (mk: string) => r2(parcelasSim.filter(i => monthKey(i.dueDate) === mk).reduce((a, i) => a + i.amount, 0))
  return { state: projetado, parcela: parcelasSim[0].amount, financiado, cardNome: card?.name, porMes, compraEm, primeiro, entrada }
}

/** Projeção mês a mês antes e depois, com o mês mais apertado. */
function comparaCompra(state: AppState, compra: ReturnType<typeof comCompra>, meses: number, hoje: string): ScenarioMonth[] {
  const antes = monthlyProjections(state, meses, hoje)
  const depois = monthlyProjections(compra.state, meses, hoje)
  const porMes = new Map(antes.map(m => [m.monthKey, m]))
  return depois.map(m => {
    const antes = porMes.get(m.monthKey)?.runningBalance ?? m.runningBalance
    const entradaFutura = compra.compraEm > hoje && m.monthKey >= monthKey(compra.compraEm) ? compra.entrada : 0
    const saldo = m.runningBalance - entradaFutura
    return {
      monthKey: m.monthKey, label: m.label,
      before: r2(antes), after: r2(saldo), delta: r2(saldo - antes),
      added: compra.porMes(m.monthKey),
    }
  })
}

function problemaDoAdiamento(plan: AssistantScenarioPlan): string | undefined {
  const atraso = plan.purchaseDelayMonths
  if (atraso !== undefined && (!Number.isInteger(atraso) || atraso < 0 || atraso >= 12)) {
    return 'A projeção cobre até 12 meses a partir deste mês. Informe uma data de compra dentro desse intervalo.'
  }
  return undefined
}

function notaDaCompraAdiada(compra: ReturnType<typeof comCompra>): string {
  return `Compra prevista para ${brDate(compra.compraEm)}. Primeira parcela em ${brDate(compra.primeiro)}.`
    + (compra.entrada ? ` Entrada de ${fmtBRL(compra.entrada)} em ${brDate(compra.compraEm)}.` : '')
}

/** Média mensal usada por `cut`, isolada para composto e cenário simples usarem a mesma conta. */
function cutPerMonth(state: AppState, category: string, hoje: string): { value: number; rows: number; from: string; to: string } | undefined {
  const d = fromISO(hoje)
  const from = toISO(new Date(d.getFullYear(), d.getMonth() - 3, 1))
  const to = toISO(new Date(d.getFullYear(), d.getMonth(), 0))
  const txs = (state.transactions || []).filter(t => t.type === 'expense' && !t.recurringId
    && t.category === category && t.date >= from && t.date <= to)
  if (!txs.length) return undefined
  return { value: r2(txs.reduce((sum, t) => sum + t.amount, 0) / 3), rows: txs.length, from, to }
}

/**
 * Estado intermediário mínimo do cenário composto. Não replica o reducer: as
 * obrigações continuam vindo de `monthlyProjections`; aqui guardamos apenas o
 * efeito incremental de cada passo e a reserva, na ordem em que foram pedidos.
 */
function runCompoundMonths(
  state: AppState, steps: AssistantScenarioPlan[], meses: number, hoje: string,
): { months: ScenarioMonth[]; facts: AssistantFact[]; caveats: string[]; incomplete: boolean } {
  const baseline = monthlyProjections(state, meses, hoje)
  const effects = baseline.map(() => 0)
  const saved = baseline.map(() => 0)
  const facts: AssistantFact[] = []
  const caveats: string[] = []
  let projectedState = state
  let incomplete = false
  let hasSaving = false
  const cutCategories = new Set<string>()
  const priorReductions = new Map<string, number[]>()
  const missingIncomeEvents = new Set<string>()

  for (const step of steps) {
    if (step.kind === 'cut') {
      const chave = step.recurringId || step.category
      if (chave && cutCategories.has(chave)) {
        caveats.push(`O corte em ${step.description || step.category} apareceu mais de uma vez; apliquei uma vez só.`)
        continue
      }
      // Conta fixa pelo nome: só ela sai, e a média da categoria não entra (a
      // de Casa mistura Luz e Internet).
      const cut = step.category && !step.recurringId ? cutPerMonth(state, step.category, hoje) : undefined
      const recurring = (projectedState.recurring || []).filter(r => r.kind !== 'income' && r.category === step.category && r.active !== false
        && (!step.recurringId || r.id === step.recurringId))
      if (!cut && !recurring.length) { incomplete = true; caveats.push(`Não achei base para estimar o corte em ${step.description || step.category || 'esse gasto'}.`); continue }
      cutCategories.add(chave!)
      const represented = representedRecurringExpenseMonths(projectedState, step.category!, meses, hoje, step.recurringId)
      // "Pela metade" (`ratio`): a conta cadastrada continua, só metade sai.
      const fracao = step.ratio && step.ratio > 0 && step.ratio < 1 ? step.ratio : 1
      if (recurring.length && fracao === 1) projectedState = { ...projectedState, recurring: projectedState.recurring.filter(r => !recurring.includes(r)) }
      const alreadyReduced = priorReductions.get(step.category!) || represented.map(() => 0)
      effects.forEach((_, i) => { effects[i] += Math.max(represented[i] - alreadyReduced[i], 0) * fracao })
      if (cut) {
        facts.push(fato(`Gasto médio por mês com ${step.description || step.category}`, cut.value, 'BRL', `média de ${cut.rows} lançamento(s) entre ${cut.from} e ${cut.to}`, cut.rows))
        if (fracao < 1) facts.push(fato(`Corte por mês (${Math.round(fracao * 100)}% da média)`, cut.value * fracao, 'BRL', 'fração da média do histórico'))
        caveats.push('O histórico variável é contexto, não crédito: só retirei despesas futuras já cadastradas na projeção.')
      }
      if (!represented.some(x => x > 0)) caveats.push(`Não há ${step.description || step.category} futuro cadastrado para retirar da sobra projetada.`)
      if (step.recurringId && recurring.length) {
        const r = recurring[0]
        caveats.push(fracao < 1
          ? `Considerei metade da conta fixa ${r.name}: ${fmtBRL(r.amount * fracao)} a menos por vencimento.`
          : `Retirei da simulação só a conta fixa ${r.name}, de ${fmtBRL(r.amount)} por vencimento, respeitando início e fim cadastrados.`)
      } else if (recurring.length && fracao === 1) caveats.push(`Também retirei da simulação ${recurring.length} conta(s) recorrente(s) dessa categoria, respeitando início e fim cadastrados.`)
      else if (recurring.length) caveats.push(`Considerei metade das ${recurring.length} conta(s) recorrente(s) dessa categoria.`)
      continue
    }
    if (step.kind === 'reduce') {
      const value = Math.max(step.amount || 0, 0)
      if (step.category && cutCategories.has(step.category)) {
        caveats.push(`O corte já eliminou o gasto em ${step.description || step.category}; não somei outra redução.`)
        continue
      }
      const represented = step.category
        ? representedRecurringExpenseMonths(projectedState, step.category, meses, hoje)
        : baseline.map(() => 0)
      const previous = step.category ? priorReductions.get(step.category) || represented.map(() => 0) : represented.map(() => 0)
      const applied = represented.map((n, i) => Math.min(value, Math.max(n - previous[i], 0)))
      if (step.category) priorReductions.set(step.category, previous.map((n, i) => n + applied[i]))
      effects.forEach((_, i) => { effects[i] += applied[i] })
      facts.push(fato(`Redução solicitada em ${step.description || step.category || 'gasto'}`, value, 'BRL', 'valor informado na pergunta'))
      if (applied.some((n, i) => n < value)) caveats.push(`A redução em ${step.description || step.category || 'esse gasto'} foi limitada ao que já estava previsto em cada mês; não criei sobra com gasto ausente.`)
      continue
    }
    if (step.kind === 'purchase') {
      const problema = problemaDoAdiamento(step)
      if (problema) { incomplete = true; caveats.push(problema); continue }
      const before = monthlyProjections(projectedState, meses, hoje)
      const purchase = comCompra(projectedState, step, hoje)
      projectedState = purchase.state
      const after = monthlyProjections(projectedState, meses, hoje)
      after.forEach((m, i) => { effects[i] += m.net - (before[i]?.net || 0) })
      const mesDaEntrada = after.findIndex(m => m.monthKey === monthKey(purchase.compraEm))
      if (mesDaEntrada >= 0) effects[mesDaEntrada] -= purchase.entrada
      if (step.purchaseDelayMonths) caveats.push(notaDaCompraAdiada(purchase))
      facts.push(fato(`Parcela em ${step.installments || 1}x`, purchase.parcela, 'BRL', 'parcelas reais no calendário projetado'))
      continue
    }
    if (step.kind === 'income-missing') {
      if (step.incomeLossDuration || step.incomeLossWindow) {
        const partial = forecastIncomeGap(state, step, hoje)
        facts.push(...partial.result.facts)
        caveats.push(...partial.result.caveats)
        incomplete ||= partial.result.empty
        for (const income of partial.missing) {
          const i = baseline.findIndex(m => m.monthKey === monthKey(income.date))
          if (i < 0 || missingIncomeEvents.has(income.id)) continue
          effects[i] -= income.amount
          missingIncomeEvents.add(income.id)
        }
        continue
      }
      const partial = runScenario(state, step, hoje)
      const value = partial.facts.find(f => f.label.includes('Entrada média'))?.value || step.amount || 0
      if (!(value > 0)) { incomplete = true; caveats.push(...partial.caveats); continue }
      // Uma fonte que atrasa neste mês não desaparece automaticamente em todo
      // o horizonte; sem declaração explícita de recorrência seria invenção.
      if (effects.length) effects[0] -= value
      facts.push(...partial.facts)
      caveats.push('A entrada ausente foi considerada somente no primeiro mês do cenário.')
      continue
    }
    if (step.kind === 'save') {
      hasSaving = true
      const value = Math.max(step.amount || 0, 0)
      saved.forEach((_, i) => {
        if (step.startMonth && baseline[i].monthKey < step.startMonth) return
        saved[i] += value; effects[i] -= value
      })
      facts.push(fato('Guardar valor fixo por mês', value, 'BRL', 'valor informado na pergunta'))
      continue
    }
    if (step.kind === 'save-share') {
      hasSaving = true
      const ratio = Math.min(Math.max(step.ratio || 0, 0), 1)
      baseline.forEach((m, i) => {
        if (step.startMonth && m.monthKey < step.startMonth) return
        const surplus = Math.max(m.net + effects[i], 0)
        const deposit = r2(surplus * ratio)
        saved[i] += deposit
        effects[i] -= deposit
      })
      facts.push(fato(`Reservar ${(ratio * 100).toLocaleString('pt-BR')}% da sobra`, ratio * 100, 'count', 'percentual aplicado separadamente a cada mês'))
      continue
    }
    // Pagar fatura não cria nova despesa; gasto avulso e trabalho extra não
    // têm hoje uma regra mensal segura. O resultado parcial continua visível,
    // mas não fingimos materializar aquilo que o calendário não representa.
    const partial = runScenario(state, step, hoje)
    facts.push(...partial.facts)
    caveats.push(...partial.caveats)
    incomplete = true
    caveats.push(`Ainda não combino ${step.label} com a projeção mensal; os números dos outros passos são parciais.`)
  }

  let accumulated = 0
  let cumulativeEffect = 0
  const months = baseline.map((m, i) => {
    accumulated = r2(accumulated + Math.max(saved[i], 0))
    cumulativeEffect = r2(cumulativeEffect + effects[i])
    return {
      monthKey: m.monthKey, label: m.label,
      before: r2(m.runningBalance), after: r2(m.runningBalance + cumulativeEffect),
      delta: cumulativeEffect, added: r2(-effects[i]),
      surplus: hasSaving ? r2(Math.max(m.net + effects[i] + saved[i], 0)) : undefined,
      saved: hasSaving ? r2(Math.max(saved[i], 0)) : undefined,
      accumulated: hasSaving ? accumulated : undefined,
    }
  })
  if (hasSaving) caveats.push('A sobra usa só entradas, contas e parcelas cadastradas; outros gastos variáveis futuros não entram na projeção.')
  const savingStart = steps.find(s => (s.kind === 'save' || s.kind === 'save-share') && s.startMonth)?.startMonth
  if (savingStart) caveats.push(`A reserva simulada começa em ${savingStart}; meses anteriores não recebem depósito.`)
  return { months, facts, caveats, incomplete }
}

/**
 * Executa o cenário. Nunca lança e nunca escreve: entrada estranha vira
 * resultado vazio com ressalva, porque um erro no meio de uma pergunta é pior
 * para o usuário do que um "não consigo simular isso".
 */
/**
 * Sem BASE nenhuma — saldo zero, nada lançado, nenhuma entrada fixa — o app não
 * sabe a situação de ninguém: "consigo comprar em 10x?" respondia "Não" para um
 * zero que o usuário nunca disse. A conta continua; o veredito some, e a
 * resposta pede o saldo.
 */
/** Projeta o intervalo exato pelos vencimentos, sem presumir rendas históricas. */
function forecastIncomeGap(state: AppState, plan: AssistantScenarioPlan, today: string) {
  const duration = plan.incomeLossDuration
  const calendar = plan.incomeLossWindow
  if (plan.planningIssue || duration && !validIncomeLossDuration(duration)) {
    return { missing: [], result: vazio(plan, [], plan.planningIssue || INCOME_LOSS_WINDOW_LIMIT) }
  }
  const lossStart = calendar?.from || today
  const until = calendar?.to || incomeLossEnd(today, duration!)
  const name = plan.origin
  const entries = pendingIncomeInWindow(state, today, until)
  const target = (origin: string | undefined, description: string | undefined, category: string) => name
    && matchesIncomeSource(name, origin, description) && (!plan.incomeLossForRent || isRentalIncome(category, description))
  const missing = entries.filter(e => e.date >= lossStart && target(e.origin, e.name, e.category))
  const scheduled = state.recurring.some(r => r.kind === 'income' && target(r.origin, r.name, r.category))
  const startBalance = currentBalance(state, today)
  const obligations = cashObligationsUntil(state, until, today)
  const known = obligations.filter(o => !o.unconfirmed)
  const totalCosts = r2(known.reduce((sum, o) => sum + o.amount, 0))
  const forecastLost = r2(missing.reduce((sum, p) => sum + p.amount, 0))
  const lostIds = new Set(missing.map(p => p.id))
  const kept = entries.filter(entry => !lostIds.has(entry.id))
  const otherIncome = r2(kept.reduce((sum, entry) => sum + entry.amount, 0))
  const dailyChanges = new Map<string, number>()
  for (const e of kept) dailyChanges.set(e.date, (dailyChanges.get(e.date) || 0) + e.amount)
  for (const o of known) {
    const day = o.date < today ? today : o.date
    dailyChanges.set(day, (dailyChanges.get(day) || 0) - o.amount)
  }
  let running = startBalance
  let lowest = startBalance
  let shortageDay: string | undefined = startBalance < 0 ? today : undefined
  for (const day of [...dailyChanges.keys()].sort()) {
    running = r2(running + dailyChanges.get(day))
    lowest = Math.min(lowest, running)
    if (!shortageDay && running < 0) shortageDay = day
  }
  const facts: AssistantFact[] = [
    fato('Saldo hoje', startBalance, 'BRL', 'saldo atual'),
    fato('Outras entradas previstas', otherIncome, 'BRL', 'ocorrências cadastradas no intervalo', kept.length),
    fato('Compromissos no intervalo', totalCosts, 'BRL', 'contas, faturas e parcelas sem duplicidade', known.length),
    fato('Saldo estimado ao fim do intervalo', r2(startBalance + otherIncome - totalCosts), 'BRL', 'saldo de hoje, outras entradas previstas e compromissos'),
  ]
  const caveats: string[] = []
  if (scheduled) {
    facts.unshift(fato('Entrada prevista que deixaria de cair', forecastLost, 'BRL', 'vencimentos em aberto da origem no intervalo', missing.length))
    if (plan.amount && plan.amount !== forecastLost) {
      caveats.push(`Você citou ${fmtBRL(plan.amount)}. A diferença entre os cenários segue os vencimentos cadastrados da origem.`)
    }
  } else {
    caveats.push(name
      ? `O AssistFin não tem uma entrada recorrente cadastrada para ${sentenceCase(name)}. O saldo projetado já estava sem essa entrada.`
      : 'Diga qual origem deixaria de pagar para retirar seus vencimentos da projeção.')
    const from = addDays(today, -89)
    const history = name ? state.transactions.filter(t => t.type === 'income' && t.date >= from && t.date <= today
      && target(t.origin, t.description, t.category)) : []
    if (history.length && (duration?.unit === 'months' || calendar)) {
      const average = history.reduce((sum, t) => sum + t.amount, 0) / Math.max(mesesEntre(history), 1)
      if (duration) {
        facts.unshift(fato('Perda estimada pelo histórico', average * duration.value, 'BRL', 'média mensal dos recebimentos registrados', history.length))
      } else {
        facts.unshift(fato('Entrada média no histórico', average, 'BRL', 'média mensal dos recebimentos registrados', history.length))
      }
    }
    if (plan.amount) caveats.push(`Valor citado para a entrada ${fmtBRL(plan.amount)}. Ele não alterou o saldo sem uma previsão correspondente.`)
  }
  if (shortageDay) caveats.push(`Pelos vencimentos cadastrados, o primeiro dia em que o caixa ficaria negativo é ${brDate(shortageDay)}.`)
  const uncertain = obligations.filter(o => o.unconfirmed)
  if (uncertain.length) caveats.push('Há contas antigas em aberto que ainda precisam de confirmação. Elas ficaram fora do total de compromissos certos.')
  const scope = duration ? `A janela de ${incomeLossLabel(duration)} vai de ${brDate(lossStart)} a ${brDate(until)}.`
    : `A ausência vale de ${brDate(lossStart)} a ${brDate(until)}. O saldo considera o caixa de hoje até o fim desse período.`
  caveats.push(`${scope} Considerei as entradas previstas e os compromissos cadastrados. Novos gastos avulsos podem mudar o resultado.`)
  return {
    missing,
    result: {
      plan, facts, caveats, months: [], empty: false,
      feasible: lowest < 0 ? false : lowest < uncertain.reduce((sum, o) => sum + o.amount, 0) ? undefined : true,
    } satisfies AssistantScenarioResult,
  }
}

export function runScenario(
  state: AppState,
  plan: AssistantScenarioPlan,
  hoje = todayISO(),
): AssistantScenarioResult {
  const initial = plan.declaredBalance
  const from = initial === undefined ? state : {
    ...state, settings: { ...state.settings, balance: initial, balanceAsOf: `${hoje}T${nextCashEventTime(state, hoje, '23:59:59.999', true)}` },
  }
  const r = simulaCenario(from, plan, hoje)
  if (initial !== undefined && !r.empty) {
    return { ...r, caveats: [`Usei ${fmtBRL(initial)} como saldo inicial informado para esta simulação.`, ...r.caveats] }
  }
  const semBase = !from.settings.balanceAsOf && currentBalance(from, hoje) === 0 && !(from.transactions || []).length
    && !(from.recurring || []).some(x => x.kind === 'income' && x.active !== false)
  if (!semBase || r.empty || r.feasible === undefined) return r
  const aviso = 'Seu saldo está zerado no app e não há nada lançado, então não sei dizer se cabe. Me diga "meu saldo é 1500" (com o seu valor) que eu refaço a conta.'
  return { ...r, feasible: undefined, caveats: [...r.caveats.filter(c => !/ainda não informou seu saldo/.test(c)), aviso] }
}

function simulaRodagem(
  state: AppState, plan: AssistantScenarioPlan, driving: DrivingScenario, hoje: string, caveats: string[],
): AssistantScenarioResult {
  const { metric, distanceChange, fuelPriceChange, fuelPricePerLiter, extraDaysPerWeek } = driving
  const kmAvulsos = plan.extraKm ?? 0
  if (!Number.isFinite(kmAvulsos) || kmAvulsos < 0
    || (distanceChange !== undefined && (!Number.isFinite(distanceChange) || distanceChange < -1))
    || (fuelPriceChange !== undefined && (!Number.isFinite(fuelPriceChange) || fuelPriceChange < -1))
    || (fuelPricePerLiter !== undefined && (!Number.isFinite(fuelPricePerLiter) || fuelPricePerLiter < 0))) {
    return vazio(plan, caveats, 'Confira os números informados. Distância e preço por litro não podem ficar abaixo de zero.')
  }
  if (distanceChange !== undefined && kmAvulsos) {
    return vazio(plan, caveats, 'Você quer mudar a distância em km ou pela porcentagem? Informe um dos dois.')
  }
  if (fuelPriceChange !== undefined && fuelPricePerLiter !== undefined) {
    return vazio(plan, caveats, 'Você quer usar o preço por litro informado ou calcular o preço pela porcentagem?')
  }

  const semanal = extraDaysPerWeek !== undefined
  const jan = semanal ? 28 : 30
  const divisor = semanal ? 4 : 1
  const ini = addDays(hoje, 1 - jan)
  const noPeriodo = (t: { date: string }) => t.date >= ini && t.date <= hoje
  const st = periodStats(state, ini, hoje, hoje)
  const corridas = state.transactions.filter(t => noPeriodo(t) && t.type === 'income' && t.category === 'corridas')
  const trabalho = state.workSessions.filter(noPeriodo)
  const diasRodados = new Set(trabalho.filter(w => w.km > 0).map(w => w.date))
  const diasComReceita = new Set(corridas.filter(t => t.amount > 0).map(t => t.date))
  const diasTrabalhados = new Set([...diasComReceita, ...trabalho.filter(w => w.km > 0 || w.hours > 0 || w.trips > 0).map(w => w.date)])
  const somenteDistanciaDita = kmAvulsos > 0 && !semanal && distanceChange === undefined && metric !== 'profit'
  if (!somenteDistanciaDita && (!(st.km > 0) || diasRodados.size < 3)) {
    return vazio(plan, caveats, `Preciso de quilometragem em pelo menos 3 dias nos últimos ${jan} dias para estimar seu ritmo.`)
  }
  if (semanal && (extraDaysPerWeek <= 0 || !Number.isInteger(extraDaysPerWeek)
    || diasTrabalhados.size / 4 + extraDaysPerWeek > 7)) {
    return vazio(plan, caveats, 'Esse acréscimo não cabe em uma semana com seu ritmo registrado. Informe quantos dias extras cabem, até o limite de sete dias no total.')
  }
  const kmBase = somenteDistanciaDita ? kmAvulsos : st.km / divisor
  const kmExtras = semanal ? (st.km / diasRodados.size) * extraDaysPerWeek : 0
  const km = somenteDistanciaDita ? kmAvulsos : kmBase * (1 + (distanceChange ?? 0)) + kmAvulsos + kmExtras
  const facts = [fato('Rodagem estimada', km, 'km', somenteDistanciaDita ? 'distância informada na pergunta' : 'quilometragem registrada e ajuste informado', diasRodados.size || 1)]
  if (!somenteDistanciaDita) {
    facts.push(fato('Rodagem de referência', kmBase, 'km', `últimos ${jan} dias`, diasRodados.size))
    caveats.push(`Base dos últimos ${jan} dias com ${diasRodados.size} dias de quilometragem registrada${semanal ? ', dividida por quatro para comparar por semana' : ''}.`)
  }
  if (semanal) caveats.push(`Cada dia extra usa sua média de km por dia com rodagem. Simulei ${extraDaysPerWeek} ${extraDaysPerWeek === 1 ? 'dia a mais por semana' : 'dias a mais por semana'}.`)

  const { kmPerLiter, pricePerLiter } = fuelCostBasis(state, hoje)
  const positive = (v: number) => Number.isFinite(v) && v > 0
  const price = fuelPricePerLiter ?? pricePerLiter * (1 + (fuelPriceChange ?? 0))
  const litros = km / kmPerLiter
  const litrosBase = kmBase / kmPerLiter
  let estimativa: number
  let referencia: number | undefined
  let unit: AssistantFact['unit'] = 'BRL'
  let formula: string
  if (metric === 'maintenance') {
    const registrado = { ...state, maintenance: state.maintenance.filter(m => m.date <= hoje) }
    const custo = kmCost(registrado).maintenancePerKm
    if (!positive(custo)) return vazio(plan, caveats, 'Para estimar manutenção, cadastre o custo e a vida útil em km das peças em Veículo.')
    estimativa = km * custo
    formula = 'km estimados × custo de manutenção cadastrado por km'
    if (!somenteDistanciaDita) referencia = kmBase * custo
    caveats.push('É uma provisão de desgaste das peças cadastradas. Reparos imprevistos, combustível e tempo ficam fora.')
  } else {
    if (!positive(kmPerLiter)) return vazio(plan, caveats, 'Para estimar combustível, registre o consumo do veículo em km/L.')
    if (metric === 'fuel-volume') {
      unit = 'liters'
      formula = 'km estimados ÷ consumo registrado (km/L)'
      estimativa = litros
      if (!somenteDistanciaDita) referencia = litrosBase
    } else {
      if (fuelPricePerLiter === undefined && !positive(pricePerLiter)) {
        return vazio(plan, caveats, 'Para estimar o gasto, registre o preço do combustível ou informe o preço por litro que quer simular.')
      }
      if (fuelPriceChange !== undefined || fuelPricePerLiter !== undefined) {
        caveats.push(`Usei ${fmtBRL(price)} por litro na simulação${positive(pricePerLiter) ? `, com ${fmtBRL(pricePerLiter)} por litro de referência` : ''}.`)
      }
      if (metric === 'fuel-cost') {
        estimativa = litros * price
        formula = 'litros estimados × preço por litro'
        if (positive(pricePerLiter) && (!somenteDistanciaDita || fuelPriceChange !== undefined || fuelPricePerLiter !== undefined)) {
          referencia = litrosBase * pricePerLiter
        }
        caveats.push('A conta cobre apenas o combustível.')
      } else {
        const variacaoKm = km - kmBase
        const diasComAmbos = new Set([...diasComReceita].filter(d => diasRodados.has(d)))
        const receitaCorridas = corridas.filter(t => diasComAmbos.has(t.date)).reduce((a, t) => a + t.amount, 0)
        const kmCorrespondentes = trabalho.filter(w => diasComAmbos.has(w.date)).reduce((a, w) => a + w.km, 0)
        if (variacaoKm !== 0 && (!positive(receitaCorridas) || !positive(kmCorrespondentes) || diasComAmbos.size < 3)) {
          return vazio(plan, caveats, 'Preciso de pelo menos 3 dias com receita de corridas e quilometragem registrados no mesmo dia para estimar quanto a mudança de rodagem rende.')
        }
        const custoForaCombustivel = (st.expense - state.transactions.filter(t =>
          noPeriodo(t) && t.type === 'expense' && t.category === 'combustivel').reduce((a, t) => a + t.amount, 0)) / divisor
        const receitaBase = st.income / divisor
        const receita = receitaBase + (variacaoKm === 0 ? 0 : receitaCorridas / kmCorrespondentes * variacaoKm)
        estimativa = receita - custoForaCombustivel - litros * price
        formula = 'receita estimada menos combustível e outras despesas registradas'
        if (positive(pricePerLiter)) referencia = receitaBase - custoForaCombustivel - litrosBase * pricePerLiter
        caveats.push('Ajustei a receita de corridas pelo mesmo faturamento por km da amostra e mantive as demais receitas e despesas registradas no nível de referência.')
        caveats.push('O combustível é estimado pelo consumo e preço por litro na base e no cenário. Variações de demanda e despesas futuras fora dos registros não entram.')
      }
    }
  }
  if (!Number.isFinite(estimativa) || (referencia !== undefined && !Number.isFinite(referencia))) {
    return vazio(plan, caveats, 'Os valores informados excedem o que consigo calcular. Confira a distância e os preços.')
  }
  facts.push(fato('Estimativa', estimativa, unit, formula, diasRodados.size || 1))
  if (referencia !== undefined) facts.push(fato('Referência', referencia, unit, 'mesma conta sem a mudança informada', diasRodados.size || 1))
  return { plan, facts, months: [], caveats, empty: false }
}

function simulaCenario(
  state: AppState,
  plan: AssistantScenarioPlan,
  hoje = todayISO(),
): AssistantScenarioResult {
  // Um marcador só. Duas frases dizendo a mesma coisa na mesma resposta é
  // ruído, e o compositor já garante que a marca de simulação aparece.
  const caveats: string[] = (plan.unsupportedFragments || [])
    .map(fragment => `Não incluí “${fragment}” na simulação; essa parte ainda não é suportada.`)
  const facts: AssistantFact[] = []
  const meses = Math.min(Math.max(plan.months || 6, 1), 12)
  if (plan.planningIssue) return vazio(plan, caveats, plan.planningIssue)
  if (hasAmbiguousLegacyCardBalance(state)) {
    return vazio(plan, caveats, 'Não consigo confirmar seu saldo com segurança. Confira o pagamento antigo da fatura e as parcelas antes de usar uma simulação de saldo.')
  }

  switch (plan.kind) {
    // ----------------------------------------------------------- composto
    case 'compound': {
      const steps = plan.steps || []
      if (!steps.length) return vazio(plan, caveats, 'Não encontrei nenhuma mudança que eu saiba simular.')
      const combined = runCompoundMonths(state, steps, meses, hoje)
      facts.push(...combined.facts)
      caveats.push(...combined.caveats)
      const final = combined.months[combined.months.length - 1]
      if (final?.accumulated !== undefined) facts.push(fato('Reserva acumulada no horizonte', final.accumulated, 'BRL', 'soma dos depósitos simulados de cada mês'))
      const tightest = [...combined.months].sort((a, b) => a.after - b.after)[0]
      return {
        plan, facts, months: combined.months, tightest,
        feasible: combined.incomplete ? undefined : combined.months.every(m => m.after >= 0),
        caveats: [...new Set(caveats)], empty: !facts.length,
      }
    }

    // ------------------------------------------------------------------ gasto
    case 'spend': {
      const valor = plan.amount || 0
      if (!(valor > 0)) return vazio(plan, caveats, 'Me diga o valor que você está pensando em gastar.')
      const projetado = comDespesa(state, valor, plan.category || 'outros-out', hoje)
      const saldoAntes = currentBalance(state, hoje)
      const saldoDepois = currentBalance(projetado, hoje)
      const resultadoNoMes = periodStats(projetado, `${monthKey(hoje)}-01`, hoje, hoje).profit
      const obligations = cashObligationsUntil(projetado, addDays(hoje, 7), hoje)
      const certas = obligations.filter(o => !o.unconfirmed)
      const compromissos = r2(certas.reduce((sum, o) => sum + o.amount, 0))
      const faturas = r2(certas.filter(o => o.kind === 'invoice').reduce((sum, o) => sum + o.amount, 0))
      const livre = r2(saldoDepois - compromissos)

      facts.push(fato('Saldo hoje', saldoAntes, 'BRL', 'saldo atual'))
      facts.push(fato('Saldo depois do gasto', saldoDepois, 'BRL', 'saldo projetado'))
      facts.push(fato('Sobra do mês depois do gasto', resultadoNoMes, 'BRL', 'resultado do mês projetado'))
      if (certas.length) {
        facts.push(fato('Compromissos vencidos e dos próximos 7 dias', compromissos, 'BRL', 'contas, faturas e parcelas pendentes cadastradas', certas.length))
        facts.push(fato('Saldo após esses compromissos', livre, 'BRL', 'saldo projetado menos compromissos cadastrados'))
      }
      if (faturas > 0) facts.push(fato('Faturas incluídas nos compromissos', faturas, 'BRL', 'parte do total de compromissos, sem somar parcelas novamente'))
      const semConfirmacao = obligations.filter(o => o.unconfirmed)
      const podeMudarVeredito = livre - semConfirmacao.reduce((sum, o) => sum + o.amount, 0) < 0
      if (semConfirmacao.length) caveats.push('Há contas vencidas sem confirmação de pagamento. Não as contei como dívida certa; confira essas pendências antes de usar a folga estimada.')
      if (saldoAntes === 0 && !state.settings.balanceAsOf) caveats.push('Você ainda não informou seu saldo em conta, então o número olha só o resultado do mês.')
      return {
        plan, facts, months: [],
        feasible: livre < 0 ? false : podeMudarVeredito ? undefined : true,
        caveats, empty: false,
      }
    }

    // ----------------------------------------------------------------- compra
    case 'purchase': {
      const total = plan.amount || 0
      const n = Math.round(plan.installments || 0)
      if (!(total > 0) || !(n > 0)) {
        return vazio(plan, caveats, 'Me diga o valor total e em quantas vezes que eu simulo.')
      }
      const problema = problemaDoAdiamento(plan)
      if (problema) return vazio(plan, caveats, problema)
      const compra = comCompra(state, plan, hoje)
      const { parcela, financiado, cardNome } = compra
      const linhas = comparaCompra(state, compra, meses, hoje)
      const primeiraNoHorizonte = linhas.some(m => m.monthKey === monthKey(compra.primeiro))
      if (plan.purchaseDelayMonths) caveats.push(notaDaCompraAdiada(compra))
      if (!primeiraNoHorizonte) caveats.push('A primeira parcela fica fora do período mostrado.')
      const apertado = [...linhas].sort((a, b) => a.after - b.after)[0]

      facts.push(fato('Valor da compra', total, 'BRL', 'informado na pergunta'))
      if (plan.downPayment) {
        facts.push(fato('Entrada', plan.downPayment, 'BRL', 'informada na pergunta'))
        facts.push(fato('Valor financiado', financiado, 'BRL', 'total menos a entrada'))
      }
      facts.push(fato(`Parcela em ${n}x`, parcela, 'BRL', 'divisão do financiado'))
      // Valor que não divide exato: a última parcela absorve a diferença. Dizer
      // só a primeira e calar sobre a última é a metade da verdade.
      const ultima = valoresDaCompra(financiado, n)
      if (ultima !== parcela) {
        caveats.push(`As parcelas não são todas iguais: ${n - 1} de ${fmtSimples(parcela)} e a última de ${fmtSimples(ultima)}.`)
      }
      facts.push(fato('Compromisso mensal depois da compra', parcela, 'BRL', 'parcela nova'))
      if (apertado) facts.push(fato(`Saldo estimado no mês mais apertado (${apertado.label})`, apertado.after, 'BRL', 'projeção'))

      if (!cardNome && plan.cardName) caveats.push(`Não encontrei o cartão "${plan.cardName}" — simulei sem vincular a nenhum.`)
      if (!activeCards(state).length) caveats.push('Você não tem cartão cadastrado; usei o primeiro vencimento 30 dias após a compra.')
      if (!state.settings.balanceAsOf && !linhas.some(m => m.before !== 0)) {
        caveats.push('Sem contas fixas nem saldo informado, a projeção mostra só o peso da parcela.')
      }
      return { plan, facts, months: linhas, tightest: apertado, feasible: apertado && primeiraNoHorizonte ? apertado.after >= 0 : undefined, caveats, empty: false }
    }

    // --------------------------------------------------------------- guardar
    case 'save': {
      const porMes = plan.amount || 0
      if (!(porMes > 0)) return vazio(plan, caveats, 'Me diga quanto você quer guardar por mês.')
      const combined = runCompoundMonths(state, [plan], meses, hoje)
      const final = combined.months[combined.months.length - 1]
      if (final?.accumulated !== undefined) facts.push(fato('Reserva acumulada no horizonte', final.accumulated, 'BRL', 'depósitos simulados dentro das datas pedidas'))
      caveats.push(...combined.caveats)
      const metas = (state.goals || []).filter(g => !g.done)
      const alvo = plan.goalName
        ? metas.find(g => normalizeName(g.name) === normalizeName(plan.goalName))
          || metas.find(g => normalizeName(g.name).includes(normalizeName(plan.goalName)))
        : metas[0]
      if (!alvo) {
        facts.push(fato('Guardando por mês', porMes, 'BRL', 'informado na pergunta'))
        caveats.push('Você não tem meta de compra cadastrada, então não dá para dizer quando ela seria batida.')
        return { plan, facts, months: combined.months, caveats, empty: false }
      }
      const guardado = plan.declaredGoalSaved ?? alvo.saved
      const falta = Math.max(alvo.target - guardado, 0)
      if (plan.declaredGoalSaved !== undefined) {
        facts.push(fato('Já guardado informado', guardado, 'BRL', 'valor informado para a simulação'))
        caveats.push(`Usei ${fmtBRL(guardado)} como acumulado inicial para esta simulação.`)
      }
      const mesesNecessarios = Math.ceil(falta / porMes)
      const inicio = plan.startMonth ? fromISO(`${plan.startMonth}-01`) : fromISO(hoje)
      const quando = new Date(inicio.getFullYear(), inicio.getMonth() + mesesNecessarios - 1, 1)
      facts.push(fato(`Falta para a meta ${alvo.name}`, falta, 'BRL', 'meta menos o já guardado'))
      facts.push(fato('Guardando por mês', porMes, 'BRL', 'informado na pergunta'))
      facts.push(fato('Meses até bater a meta', mesesNecessarios, 'count', 'divisão'))
      if (mesesNecessarios > 0) caveats.push(`Nesse ritmo, por volta de ${quando.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}.`)
      return { plan, facts, months: combined.months, feasible: true, caveats, empty: false }
    }

    // ----------------------------------------------- reduzir por valor fixo
    case 'reduce': {
      const valor = plan.amount || 0
      if (!(valor > 0) || !plan.category) {
        return vazio(plan, caveats, 'Me diga a categoria e quanto você reduziria por mês.')
      }
      const nome = plan.description || plan.category
      const combined = runCompoundMonths(state, [plan], meses, hoje)
      const applied = combined.months[combined.months.length - 1]?.delta || 0
      facts.push(fato(`Redução solicitada em ${nome}`, valor, 'BRL', 'valor informado na pergunta'))
      facts.push(fato('Despesa futura efetivamente evitada', applied, 'BRL', 'somente obrigações previstas da categoria'))
      return { plan, facts, months: combined.months, caveats: [...caveats, ...combined.caveats], empty: false }
    }

    case 'save-share': {
      const proporcao = Math.min(Math.max(plan.ratio || 0, 0), 1)
      if (!(proporcao > 0)) return vazio(plan, caveats, 'Me diga qual parte da sobra você quer guardar.')
      const combined = runCompoundMonths(state, [plan], meses, hoje)
      facts.push(...combined.facts)
      const final = combined.months[combined.months.length - 1]
      if (final?.accumulated !== undefined) facts.push(fato('Reserva acumulada no horizonte', final.accumulated, 'BRL', 'soma dos depósitos simulados de cada mês'))
      return { plan, facts, months: combined.months, caveats: [...caveats, ...combined.caveats], empty: false }
    }

    // ------------------------------------------------- parar um tipo de gasto
    // A base é o que o usuário REALMENTE gastou naquela categoria nos últimos
    // três meses COMPLETOS — nunca o mês corrente, que ainda está pela metade.
    // A projeção de saldo do app não usa gasto variável (só contas fixas e
    // parcelas), então este cenário não finge mexer nela: diz quanto deixaria
    // de sair, por mês e no horizonte pedido.
    case 'cut': {
      const nome = plan.description || plan.category || 'esse gasto'
      if (!plan.category) return vazio(plan, caveats, 'Me diga qual gasto você pararia — por exemplo, "e se eu parar a obra".')
      const combined = runCompoundMonths(state, [plan], meses, hoje)
      const applied = combined.months[combined.months.length - 1]?.delta || 0
      facts.push(...combined.facts)
      facts.push(fato('Despesa futura efetivamente evitada', applied, 'BRL', 'somente obrigações previstas da categoria'))
      return { plan, facts, months: combined.months, caveats: [...caveats, ...combined.caveats], empty: false }
    }

    // ------------------------------------------------------ pagar a fatura
    case 'payoff': {
      const chosen = findPayoffPlan(state, plan.description || '', hoje, plan.cardName)
      if ('question' in chosen) return vazio(plan, caveats, chosen.question)
      const { progress, lastDue } = chosen
      const nominal = progress.remainingAmount
      const quote = plan.payoffQuote
      if (quote && (!Number.isFinite(quote.amount) || quote.amount < 0 || quote.amount > 99_999_999
        || (quote.kind === 'discount' && quote.amount > nominal) || (quote.kind === 'percent' && quote.amount > 100))) {
        return vazio(plan, caveats, 'Confira o valor oferecido. O desconto precisa ficar entre zero e o total em aberto.')
      }
      const price = quote ? r2(quote.kind === 'price' ? quote.amount
        : nominal - quote.amount * (quote.kind === 'percent' ? nominal / 100 : 1)) : nominal
      const balance = currentBalance(state, hoje)
      const after = r2(balance - price)
      const name = sentenceCase(progress.plan.description)
      facts.push(fato(`Saldo em aberto de ${name}`, nominal, 'BRL', 'parcelas pendentes com baixas e cancelamentos descontados'))
      facts.push(fato('Parcelas em aberto', progress.remainingCount, 'count', 'parcelas com saldo a pagar', progress.remainingCount))
      facts.push(fato('Preço simulado da quitação', price, 'BRL', quote ? 'valor ou desconto informado na pergunta' : 'saldo em aberto, sem oferta do cartão'))
      if (quote) facts.push(fato('Diferença a favor da quitação', nominal - price, 'BRL', 'saldo em aberto menos preço simulado'))
      facts.push(fato('Saldo hoje', balance, 'BRL', 'saldo atual'))
      facts.push(fato('Saldo depois da quitação', after, 'BRL', 'saldo atual menos pagamento simulado'))
      if (lastDue) caveats.push(`A última parcela em aberto vence em ${brDate(lastDue)}.`)
      if (!quote) caveats.push('Usei o saldo em aberto. Diga o preço de quitação do cartão para eu calcular o desconto real.')
      caveats.push('O saldo após a quitação vem antes das demais contas. Confira no cartão o valor e a baixa das parcelas.')
      return { plan: { ...plan, description: name }, facts, months: [], feasible: after >= 0, caveats, empty: false }
    }

    case 'pay-invoice': {
      const cards = (state.cards || []).filter(c => plan.cardName || !c.archived || invoiceOpenAmount(state, currentInvoice(state, c, hoje), hoje) > 0)
      if (!cards.length) return vazio(plan, caveats, 'Você não tem cartão cadastrado.')
      const alvo = plan.cardName
        ? cards.find(c => normalizeName(c.name).includes(normalizeName(plan.cardName!)))
        : (cards.length === 1 ? cards[0] : undefined)
      if (!alvo) {
        caveats.push(`Você tem ${cards.length} cartões — me diga qual (${cards.map(c => c.name).join(', ')}).`)
        return { plan, facts, months: [], caveats, empty: true }
      }
      const inv = currentInvoice(state, alvo, hoje)
      const pendente = invoiceOpenAmount(state, inv, hoje)
      const saldo = currentBalance(state, hoje)
      facts.push(fato(`Fatura pendente do ${alvo.name}`, pendente, 'BRL', 'fatura atual'))
      facts.push(fato('Saldo hoje', saldo, 'BRL', 'saldo atual'))
      facts.push(fato('Saldo depois de pagar', saldo - pendente, 'BRL', 'subtração'))
      // Regra 10: pagar fatura quita dívida, não cria despesa nova.
      caveats.push('Pagar a fatura quita a dívida e reduz o saldo — não entra como despesa nova no mês.')
      if (pendente <= 0) caveats.push('Essa fatura não tem valor pendente agora.')
      return { plan, facts, months: [], feasible: saldo - pendente >= 0, caveats, empty: false }
    }

    // -------------------------------------------------- entrada que não vem
    case 'income-missing': {
      if (plan.incomeLossDuration || plan.incomeLossWindow) {
        const { result } = forecastIncomeGap(state, plan, hoje)
        return { ...result, caveats: [...result.caveats, ...caveats] }
      }
      const nome = plan.origin || plan.description
      // Quanto essa fonte costuma trazer por mês, medido no histórico DELE.
      const from = addDays(hoje, -89)
      const doOrigem = (state.transactions || []).filter(t =>
        t && t.type === 'income' && t.date >= from && t.date <= hoje
        && (!nome || matchesIncomeSource(nome, t.origin, t.description)))
      const valor = plan.amount
        || (doOrigem.length ? r2(doOrigem.reduce((a, t) => a + t.amount, 0) / Math.max(mesesEntre(doOrigem), 1)) : 0)
      if (!(valor > 0)) {
        return vazio(plan, caveats, nome
          ? `Não tenho entradas de "${nome}" registradas nos últimos 90 dias, então não sei quanto deixaria de entrar.`
          : 'Me diga quanto deixaria de entrar que eu faço a conta.')
      }
      const saldo = currentBalance(state, hoje)
      const obligations = cashObligationsUntil(state, addDays(hoje, 30), hoje)
      const certas = obligations.filter(o => !o.unconfirmed)
      const contas = r2(certas.reduce((sum, o) => sum + o.amount, 0))
      const faturas = r2(certas.filter(o => o.kind === 'invoice').reduce((sum, o) => sum + o.amount, 0))
      const livre = r2(saldo - contas)
      const incertas = obligations.filter(o => o.unconfirmed)
      const podeMudarVeredito = livre - incertas.reduce((sum, o) => sum + o.amount, 0) < 0
      facts.push(fato(plan.amount ? 'Entrada que faltaria' : nome ? `Entrada média de ${sentenceCase(nome)}` : 'Entrada que faltaria',
        valor, 'BRL', plan.amount ? 'valor informado na pergunta' : 'média dos últimos 90 dias', plan.amount ? 1 : doOrigem.length))
      facts.push(fato('Saldo hoje', saldo, 'BRL', 'saldo atual'))
      facts.push(fato('Compromissos vencidos e dos próximos 30 dias', contas, 'BRL', 'contas, faturas e parcelas pendentes cadastradas', certas.length))
      if (faturas > 0) facts.push(fato('Faturas incluídas nos compromissos', faturas, 'BRL', 'parte dos compromissos, sem contar parcelas novamente'))
      facts.push(fato('Sobra estimada sem essa entrada', livre, 'BRL', 'saldo atual menos compromissos cadastrados'))
      caveats.push('A conta usa o saldo disponível hoje e os compromissos cadastrados; não soma receitas futuras nem desconta de novo uma entrada que ainda não entrou.')
      if (incertas.length) caveats.push('Há contas vencidas sem confirmação de pagamento. Não as contei como dívida certa; confira essas pendências antes de usar a folga estimada.')
      return { plan, facts, months: [], feasible: livre < 0 ? false : podeMudarVeredito ? undefined : true, caveats, empty: false }
    }

    // ------------------------------------------------- horas/km a mais
    case 'extra-work': {
      if (!isDriver(state.settings)) return vazio(plan, caveats, 'Essa simulação só existe no perfil de motorista.')
      if (plan.driving) return simulaRodagem(state, plan, plan.driving, hoje, caveats)
      const st = periodStats(state, addDays(hoje, -29), hoje, hoje)
      if (plan.hoursPerDay) {
        if (st.hours <= 0) {
          return vazio(plan, caveats, 'Ainda não tenho horas registradas para calcular seu ritmo. Diga "trabalhei 8 horas" que eu passo a estimar.')
        }
        const dias = Math.max(1, Math.round(plan.days || 30))
        const porHora = st.profitPerHour
        facts.push(fato('Seu lucro por hora (últimos 30 dias)', porHora, 'per-hour', 'histórico real', st.days))
        facts.push(fato('Horas a mais por dia', plan.hoursPerDay, 'hours', 'informado na pergunta'))
        // O rótulo diz as HORAS: "Estimativa para um dia" lia como o dia inteiro.
        facts.push(fato(dias === 1 ? `Estimativa com ${fmtNum(plan.hoursPerDay)}h a mais hoje` : `Estimativa com ${fmtNum(plan.hoursPerDay)}h a mais por dia em ${dias} dias`,
          porHora * plan.hoursPerDay * dias, 'BRL', 'ritmo × horas × dias'))
        // Para decidir se vale ficar HOJE, a meta do dia é a referência que o
        // motorista já usa: falta quanto, ou já bateu.
        if (dias === 1) {
          facts.push(fato('Meta de hoje', dailyGoal(state).total, 'BRL', 'meta diária do app'))
          facts.push(fato('Lucro de hoje até agora', todayStats(state).profit, 'BRL', 'lançamentos de hoje'))
        }
        caveats.push(`Estimativa no SEU ritmo dos últimos 30 dias (${st.days} dias com registro). Dia bom e dia ruim mudam isso.`)
        return { plan, facts, months: [], caveats, empty: false }
      }
      if (plan.extraKm && plan.fuelOnly) {
        // Custo de combustível dos km a mais: preço por litro ÷ consumo, os
        // mesmos números do custo por km do app. Sem consumo ou preço, cala.
        const custo = kmCost(state)
        if (custo.fuelPerKm <= 0) {
          return vazio(plan, caveats, 'Para estimar o combustível preciso do seu consumo (km/L) e do preço por litro: registre um abastecimento com litros e valor, ou preencha os dois em Veículo.')
        }
        facts.push(fato('Custo de combustível por km', custo.fuelPerKm, 'per-km', 'preço por litro ÷ consumo registrados'))
        facts.push(fato('Km a mais', plan.extraKm, 'km', 'informado na pergunta'))
        facts.push(fato('Combustível estimado', custo.fuelPerKm * plan.extraKm, 'BRL', 'custo por km × km'))
        caveats.push('Só o combustível: desgaste, manutenção e tempo não entram nesta conta.')
        return { plan, facts, months: [], caveats, empty: false }
      }
      if (plan.extraKm) {
        if (st.km <= 0) return vazio(plan, caveats, 'Ainda não tenho km registrados para calcular seu ganho por km.')
        facts.push(fato('Seu lucro por km (últimos 30 dias)', st.netPerKm, 'per-km', 'histórico real', st.days))
        facts.push(fato('Km a mais', plan.extraKm, 'km', 'informado na pergunta'))
        facts.push(fato('Estimativa', st.netPerKm * plan.extraKm, 'BRL', 'ritmo × km'))
        caveats.push(`Estimativa no SEU ritmo dos últimos 30 dias (${st.days} dias com registro).`)
        return { plan, facts, months: [], caveats, empty: false }
      }
      return vazio(plan, caveats, 'Me diga quantas horas ou quantos km a mais que eu estimo.')
    }
  }
  return vazio(plan, caveats, 'Não consigo simular isso ainda.')
}

/** Última parcela da divisão real — é ela que absorve o centavo que sobra. */
const valoresDaCompra = (financiado: number, n: number): number => {
  const v = splitInstallmentAmounts(financiado, n)
  return v[v.length - 1]
}

const fmtSimples = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const mesesEntre = (txs: Transaction[]): number => {
  const meses = new Set(txs.map(t => monthKey(t.date)))
  return meses.size
}

function vazio(
  plan: AssistantScenarioPlan, caveats: string[], motivo: string,
): AssistantScenarioResult {
  return { plan, facts: [], months: [], caveats: [motivo, ...caveats], empty: true }
}

export { cardById }
