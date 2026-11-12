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

import type { AppState, Installment, InstallmentPlan, Transaction } from '../../models/types'
import { addDays, fmtBRL, fmtNum, fromISO, monthKey, todayISO, toISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import {
  cashObligationsUntil, currentBalance, dailyGoal, monthlyProjections, monthlySavingGoal, periodStats,
  representedRecurringExpenseMonths, todayStats, kmCost,
} from '../../services/calc'
import {
  activeCards, cardById, currentInvoice, nextInvoiceDueDate, splitInstallmentAmounts, hasAmbiguousLegacyCardBalance,
} from '../../services/cards'
import { isDriver } from '../../services/profile'
import type { AssistantFact } from '../query/types'
import type { AssistantScenarioPlan, AssistantScenarioResult, ScenarioMonth } from './types'

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
    description: 'Simulação', date: hoje, time: '12:00', source: 'manual',
  }
  return { ...state, transactions: [...(state.transactions || []), t] }
}

/**
 * Cópia do estado com uma compra parcelada hipotética.
 *
 * Reaproveita a construção real das parcelas. A entrada, quando existe, sai do
 * caixa HOJE (vira despesa simulada) e reduz o valor financiado — que é
 * exatamente o que acontece na vida.
 */
function comCompra(
  state: AppState, plan: AssistantScenarioPlan, hoje: string,
): { state: AppState; parcela: number; financiado: number; cardNome?: string; porMes: (mk: string) => number } {
  const total = plan.amount || 0
  const entrada = Math.min(plan.downPayment || 0, total)
  const financiado = r2(total - entrada)
  const n = Math.max(1, Math.round(plan.installments || 1))

  const card = plan.cardName
    ? activeCards(state).find(c => normalizeName(c.name).includes(normalizeName(plan.cardName!)))
    : (activeCards(state).length === 1 ? activeCards(state)[0] : undefined)

  const primeiro = card ? nextInvoiceDueDate(card, hoje) : addDays(hoje, 30)
  const valores = splitInstallmentAmounts(financiado, n)

  const planoSim: InstallmentPlan = {
    id: `sim-plan-${fid()}`, description: plan.description || 'Compra simulada',
    cardId: card?.id, totalAmount: financiado, installmentCount: n,
    firstDueDate: primeiro, purchaseDate: hoje, status: 'active',
    operationType: 'card-purchase', createdAt: hoje,
  }
  const d = fromISO(primeiro)
  const parcelasSim: Installment[] = valores.map((valor, i) => ({
    id: `sim-inst-${planoSim.id}-${i}`, planId: planoSim.id, number: i + 1,
    total: n, amount: valor,
    dueDate: toISO(new Date(d.getFullYear(), d.getMonth() + i, Math.min(d.getDate(), 28))),
    status: 'pending',
  }))

  let projetado: AppState = {
    ...state,
    installmentPlans: [...(state.installmentPlans || []), planoSim],
    installments: [...(state.installments || []), ...parcelasSim],
  }
  if (entrada > 0) projetado = comDespesa(projetado, entrada, plan.category || 'outros-out', hoje)

  // Parcela que cai em CADA mês, pelo calendário simulado. A linha de outubro
  // dizia "com a parcela de R$ 400" para uma compra cuja primeira parcela vence
  // em novembro — o saldo estava certo, o texto não.
  const porMes = (mk: string) => r2(parcelasSim.filter(i => monthKey(i.dueDate) === mk).reduce((a, i) => a + i.amount, 0))
  return { state: projetado, parcela: valores[0], financiado, cardNome: card?.name, porMes }
}

/** Projeção mês a mês antes e depois, com o mês mais apertado. */
function compara(state: AppState, projetado: AppState, meses: number, extraPorMes: (mk: string) => number, hoje = todayISO()): ScenarioMonth[] {
  const antes = monthlyProjections(state, meses, hoje)
  const depois = monthlyProjections(projetado, meses, hoje)
  const porMes = new Map(antes.map(m => [m.monthKey, m]))
  return depois.map(m => {
    const a = porMes.get(m.monthKey)
    return {
      monthKey: m.monthKey, label: m.label,
      before: r2(a?.runningBalance ?? m.runningBalance),
      after: r2(m.runningBalance),
      delta: r2(m.runningBalance - (a?.runningBalance ?? m.runningBalance)),
      added: r2(extraPorMes(m.monthKey)),
    }
  })
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
      const before = monthlyProjections(projectedState, meses, hoje)
      const purchase = comCompra(projectedState, step, hoje)
      projectedState = purchase.state
      const after = monthlyProjections(projectedState, meses, hoje)
      after.forEach((m, i) => { effects[i] += m.net - (before[i]?.net || 0) })
      if (effects.length) effects[0] -= Math.max(step.downPayment || 0, 0)
      facts.push(fato(`Parcela em ${step.installments || 1}x`, purchase.parcela, 'BRL', 'parcelas reais no calendário projetado'))
      continue
    }
    if (step.kind === 'income-missing') {
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
export function runScenario(
  state: AppState,
  plan: AssistantScenarioPlan,
  hoje = todayISO(),
): AssistantScenarioResult {
  const r = simulaCenario(state, plan, hoje)
  const semBase = currentBalance(state, hoje) === 0 && !(state.transactions || []).length
    && !(state.recurring || []).some(x => x.kind === 'income' && x.active !== false)
  if (!semBase || r.empty || r.feasible === undefined) return r
  const aviso = 'Seu saldo está zerado no app e não há nada lançado, então não sei dizer se cabe. Me diga "meu saldo é 1500" (com o seu valor) que eu refaço a conta.'
  return { ...r, feasible: undefined, caveats: [...r.caveats.filter(c => !/ainda não informou seu saldo/.test(c)), aviso] }
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
      const mgDepois = monthlySavingGoal(projetado)
      const obligations = cashObligationsUntil(projetado, addDays(hoje, 7), hoje)
      const certas = obligations.filter(o => !o.unconfirmed)
      const compromissos = r2(certas.reduce((sum, o) => sum + o.amount, 0))
      const faturas = r2(certas.filter(o => o.kind === 'invoice').reduce((sum, o) => sum + o.amount, 0))
      const livre = r2(saldoDepois - compromissos)

      facts.push(fato('Saldo hoje', saldoAntes, 'BRL', 'saldo atual'))
      facts.push(fato('Saldo depois do gasto', saldoDepois, 'BRL', 'saldo projetado'))
      facts.push(fato('Sobra do mês depois do gasto', mgDepois.net, 'BRL', 'resultado do mês projetado'))
      if (certas.length) {
        facts.push(fato('Compromissos vencidos e dos próximos 7 dias', compromissos, 'BRL', 'contas, faturas e parcelas pendentes cadastradas', certas.length))
        facts.push(fato('Saldo após esses compromissos', livre, 'BRL', 'saldo projetado menos compromissos cadastrados'))
      }
      if (faturas > 0) facts.push(fato('Faturas incluídas nos compromissos', faturas, 'BRL', 'parte do total de compromissos, sem somar parcelas novamente'))
      const semConfirmacao = obligations.filter(o => o.unconfirmed)
      const podeMudarVeredito = livre - semConfirmacao.reduce((sum, o) => sum + o.amount, 0) < 0
      if (semConfirmacao.length) caveats.push('Há contas vencidas sem confirmação de pagamento. Não as contei como dívida certa; confira essas pendências antes de usar a folga estimada.')
      if (saldoAntes === 0) caveats.push('Você ainda não informou seu saldo em conta, então o número olha só o resultado do mês.')
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
      const { state: projetado, parcela, financiado, cardNome, porMes } = comCompra(state, plan, hoje)
      const linhas = compara(state, projetado, meses, porMes, hoje)
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
      if (!activeCards(state).length) caveats.push('Você não tem cartão cadastrado; usei o primeiro vencimento em 30 dias.')
      if (!linhas.some(m => m.before !== 0)) {
        caveats.push('Sem contas fixas nem saldo informado, a projeção mostra só o peso da parcela.')
      }
      return { plan, facts, months: linhas, tightest: apertado, feasible: apertado ? apertado.after >= 0 : undefined, caveats, empty: false }
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
        ? metas.find(g => normalizeName(g.name).includes(normalizeName(plan.goalName!)))
        : metas[0]
      if (!alvo) {
        facts.push(fato('Guardando por mês', porMes, 'BRL', 'informado na pergunta'))
        caveats.push('Você não tem meta de compra cadastrada, então não dá para dizer quando ela seria batida.')
        return { plan, facts, months: combined.months, caveats, empty: false }
      }
      const falta = Math.max(alvo.target - alvo.saved, 0)
      const mesesNecessarios = Math.ceil(falta / porMes)
      const inicio = plan.startMonth ? fromISO(`${plan.startMonth}-01`) : fromISO(hoje)
      const quando = new Date(inicio.getFullYear(), inicio.getMonth() + mesesNecessarios - 1, 1)
      facts.push(fato(`Falta para a meta ${alvo.name}`, falta, 'BRL', 'meta menos o já guardado'))
      facts.push(fato('Guardando por mês', porMes, 'BRL', 'informado na pergunta'))
      facts.push(fato('Meses até bater a meta', mesesNecessarios, 'count', 'divisão'))
      caveats.push(`Nesse ritmo, por volta de ${quando.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}.`)
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
    case 'pay-invoice': {
      const cards = activeCards(state)
      if (!cards.length) return vazio(plan, caveats, 'Você não tem cartão cadastrado.')
      const alvo = plan.cardName
        ? cards.find(c => normalizeName(c.name).includes(normalizeName(plan.cardName!)))
        : (cards.length === 1 ? cards[0] : undefined)
      if (!alvo) {
        caveats.push(`Você tem ${cards.length} cartões — me diga qual (${cards.map(c => c.name).join(', ')}).`)
        return { plan, facts, months: [], caveats, empty: true }
      }
      const inv = currentInvoice(state, alvo)
      const saldo = currentBalance(state, hoje)
      facts.push(fato(`Fatura pendente do ${alvo.name}`, inv.pending, 'BRL', 'fatura atual'))
      facts.push(fato('Saldo hoje', saldo, 'BRL', 'saldo atual'))
      facts.push(fato('Saldo depois de pagar', saldo - inv.pending, 'BRL', 'subtração'))
      // Regra 10: pagar fatura quita dívida, não cria despesa nova.
      caveats.push('Pagar a fatura quita a dívida e reduz o saldo — não entra como despesa nova no mês.')
      if (inv.pending <= 0) caveats.push('Essa fatura não tem valor pendente agora.')
      return { plan, facts, months: [], feasible: saldo - inv.pending >= 0, caveats, empty: false }
    }

    // -------------------------------------------------- entrada que não vem
    case 'income-missing': {
      const nome = plan.origin || plan.description
      // Quanto essa fonte costuma trazer por mês, medido no histórico DELE.
      const from = addDays(hoje, -89)
      const doOrigem = (state.transactions || []).filter(t =>
        t && t.type === 'income' && t.date >= from && t.date <= hoje
        && (nome ? normalizeName(t.origin || t.description || '').includes(normalizeName(nome)) : true))
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
      const st = periodStats(state, addDays(hoje, -29), hoje)
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
