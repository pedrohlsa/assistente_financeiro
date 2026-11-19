import assert from 'node:assert/strict'
import { parseNaturalFull } from '../src/services/nlp'
import { askAssistant } from '../src/services/ai'
import { currentBalance, kmCost } from '../src/services/calc'
import { plainChatText } from '../src/utils/text'
import { AppState, Transaction } from '../src/models/types'
import { DEFAULT_CATEGORIES } from '../src/data/categories'
import { runNavigationTests } from '../tests/navigation'
import { createDeferredSave } from '../src/store/persistence'
import { hydrateForTest, reducer } from '../src/store/store'

const state = (): AppState => ({
  settings: {
    name: 'Teste', currency: 'BRL', theme: 'light', profile: 'driver',
    priority: '', onboarded: true, demo: false, monthlyProfitTarget: 4500,
    safetyMarginPct: 10, workDays: [1, 2, 3, 4, 5, 6],
    homeCards: ['km'], fuelPricePerLiter: 0, kmPerLiter: 0,
    minPerKm: 0, comfortPerKm: 0, fixedMonthlyCosts: 0,
    notifications: true, balance: 0, ask99Fee: true, platform99Fee: 1,
    remoteAi: true,
  },
  transactions: [], categories: DEFAULT_CATEGORIES, workSessions: [],
  fuelRecords: [], vehicle: null, maintenance: [], goals: [], deficits: [],
  recurring: [], budgets: [], chat: [], dismissedDeficitDates: [],
  cards: [], installmentPlans: [], installments: [], cardPayments: [], cardCharges: [],
})

{
  const { actions } = parseNaturalFull(
    'Fiz uma corrida, ganhei 150 depois fiz mais 47 reais em uma corrida privada',
    { driver: true },
  )
  const incomes = actions.filter(a => a.kind === 'income')
  assert.deepEqual(incomes.map(a => a.amount), [150, 47])
  assert.ok(incomes.every(a => a.category === 'corridas'))
  assert.equal(actions.find(a => a.kind === 'work')?.trips, 2)
}

{
  const { actions } = parseNaturalFull(
    'ACABEI de ABASTECER 190 no posto, deu 41 litros estou atualmente com 220.007 km rodados',
    { driver: true },
  )
  const fuel = actions.find(a => a.kind === 'fuel')
  assert.deepEqual(fuel, { kind: 'fuel', amount: 190, liters: 41, odometer: 220007 })
  assert.equal(actions.some(a => a.kind === 'work' && a.km), false)
}

{
  const { actions } = parseNaturalFull(
    'Ganhei 430 UBER, mais 399 da 99, gastei 163 reais de gasolina deram 24 litros, consegui rodar 161km',
    { driver: true },
  )
  const incomes = actions.filter(a => a.kind === 'income')
  assert.deepEqual(incomes.map(a => [a.amount, a.description]), [[430, 'Uber'], [399, '99']])
  const fuel = actions.find(a => a.kind === 'fuel')
  assert.equal(fuel?.amount, 163)
  assert.equal(fuel?.liters, 24)
  const work = actions.find(a => a.kind === 'work')
  assert.equal(work?.km, 161)
  assert.equal(work?.trips, 2)
}

{
  const { actions } = parseNaturalFull('MAIS uma corrida de 49 reais', { driver: true })
  assert.equal(actions.find(a => a.kind === 'income')?.amount, 49)
  assert.equal(actions.find(a => a.kind === 'work')?.trips, 1)
}

{
  const { actions } = parseNaturalFull('Fiz uma corrida na 99 no valor de 37 reais', { driver: true })
  assert.equal(actions.find(a => a.kind === 'income')?.amount, 37)
  assert.equal(actions.find(a => a.kind === 'income')?.description, '99')
}

{
  const reply = askAssistant(state(), 'Vou te passar quantos km fiz hoje, quanto ganhei e quanto gastei, beleza?')
  assert.equal(reply.actions, undefined)
  assert.match(reply.text, /^Claro\./)
}

{
  const s = state()
  s.budgets = [{ id: 'food', category: 'alimentacao', limit: 350 }]
  const reply = askAssistant(s, 'Gastei 200 reais em almoço hoje, quanto ainda tenho de limite para alimentação?')
  assert.equal(reply.actions?.length, 1)
  assert.match(reply.text, /R\$\s*150,00/)
}

{
  assert.equal(plainChatText('Você ainda tem **R$ 150,00** e `R$ 20,00` hoje.'), 'Você ainda tem R$ 150,00 e R$ 20,00 hoje.')
  assert.deepEqual(kmCost(state()), {
    fuelPerKm: 0, maintenancePerKm: 0, fixedPerKm: 0,
    operational: 0, total: 0, minRecommended: 0, comfort: 0,
  })
}

const navChecks = runNavigationTests()

{
  const original = state()
  original.settings.balanceAsOf = '2026-09-01'
  const minha: Transaction = { id: 'local', type: 'income', date: '2026-09-10', amount: 50, category: 'outros-in' }
  const nova: Transaction = { ...minha, id: 'do-backup', amount: 100 }
  original.transactions = [minha]
  const backup = {
    ...original,
    transactions: [{ ...minha, amount: 999 }, nova, { ...nova, amount: 200 }, null] as unknown as Transaction[],
    workSessions: 'lista inválida' as unknown as AppState['workSessions'],
    chat: [null, {
      id: 'chat-backup', role: 'assistant', text: 'Confirmar a despesa?', time: '12:00',
      proposal: [{ id: 'despesa-antiga', action: { kind: 'expense', amount: 200, category: 'casa' } }],
      clarification: { question: 'Escolha erro antigo', options: [{ label: 'Sim', value: 'sim' }] },
    }] as unknown as AppState['chat'],
  }
  const merged = reducer(original, { type: 'mergeState', state: backup })
  assert.deepEqual(merged.transactions, [minha, nova], 'a mescla mantém o item local e insere cada ID novo uma vez')
  assert.equal(currentBalance(merged, '2026-09-15'), 150)
  assert.deepEqual(reducer(merged, { type: 'mergeState', state: backup }).transactions, merged.transactions)

  const recovered = hydrateForTest(backup)
  const restored = reducer(original, { type: 'hydrate', state: backup })
  assert.deepEqual(restored, recovered, 'restauração e recarga passam pela mesma limpeza')
  assert.deepEqual(restored.transactions.map(t => [t.id, t.amount]), [['local', 999], ['do-backup', 100]])
  assert.equal(restored.chat.length, 1)
  assert.equal(restored.chat[0].text, 'Confirmar a despesa?')
  assert.equal(restored.chat[0].proposal, undefined)
  assert.equal(restored.chat[0].clarification, undefined)
}

{
  const disk: Array<{ amount: number }> = []
  const save = createDeferredSave<{ amount: number }>(s => disk.push(s), 10)
  save.queue({ amount: 100 })
  save.queue({ amount: 180 })
  save.flush() // a página sai antes de vencer o debounce
  assert.deepEqual(disk, [{ amount: 180 }])
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(disk.length, 1, 'o timer cancelado não grava outra vez')
  save.queue({ amount: 999 })
  save.cancel() // reset remove a chave e cancela o estado antigo
  save.flush()
  assert.equal(disk.length, 1, 'sair após reset não ressuscita os dados antigos')
  save.queue({ amount: 0 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(disk, [{ amount: 180 }, { amount: 0 }])
  save.cancel()
}

console.log(`Todos os testes do núcleo passaram (inclui ${navChecks} verificações de navegação).`)
