import assert from 'node:assert/strict'
import { parseNaturalFull } from '../src/services/nlp'
import { askAssistant } from '../src/services/ai'
import { kmCost } from '../src/services/calc'
import { plainChatText } from '../src/utils/text'
import { AppState } from '../src/models/types'
import { DEFAULT_CATEGORIES } from '../src/data/categories'
import { runNavigationTests } from '../tests/navigation'

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

console.log(`Todos os testes do núcleo passaram (inclui ${navChecks} verificações de navegação).`)
