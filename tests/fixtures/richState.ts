// Estados RICOS para exercitar consulta, cenário e continuidade.
//
// O corpus antigo usa estados minúsculos porque testa PARSER: duas transações
// bastam para provar que "gastei 50" vira uma despesa. Consulta é outra coisa —
// comparar períodos, agrupar por categoria e achar o mês pior exigem meses de
// histórico. Estes fixtures existem para isso, e são DETERMINÍSTICOS: mesma
// semente, mesmos números, sem `Math.random` e sem relógio.

import type { AppState, Transaction } from '../../src/models/types'
import { DEFAULT_CATEGORIES } from '../../src/data/categories'
import { addDays, fromISO, toISO } from '../../src/utils/format'
import { buildState, TODAY } from '../assistant/harness'

/** PRNG determinístico (mulberry32) — mesma semente, mesma série, sempre. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const iso = (base: string, deltaDias: number) => addDays(base, deltaDias)

/** Primeiro dia do mês `back` meses atrás de `base`. */
export const monthStart = (base: string, back: number): string => {
  const d = fromISO(base)
  return toISO(new Date(d.getFullYear(), d.getMonth() - back, 1))
}

const tx = (
  id: string, type: Transaction['type'], amount: number, category: string,
  date: string, description?: string, origin?: string,
): Transaction => ({
  id, type, amount, category, date, description, origin, time: '10:00', source: 'manual',
})

/**
 * AUTÔNOMO com imóveis: seis meses de histórico, entradas de aluguel de duas
 * casas, obra crescendo, alimentação caindo, cartões e metas.
 *
 * Os números são escolhidos para as perguntas terem resposta CONFERÍVEL à mão —
 * um teste que só compara com o que o código produziu não prova nada.
 */
export function autonomoRico(hoje = TODAY): AppState {
  const primeiroDia = hoje.endsWith('-01')
  const t: Transaction[] = []
  let n = 0
  const add = (
    type: Transaction['type'], amount: number, category: string,
    date: string, description?: string, origin?: string,
  ) => t.push(tx(`t${++n}`, type, amount, category, date, description, origin))

  // Aluguéis: Casa 1 = 1800/mês, Casa 2 = 1200/mês, nos 6 meses.
  for (let m = 0; m < 6; m++) {
    const inicio = monthStart(hoje, m)
    add('income', 1800, 'aluguel', primeiroDia && m === 0 ? inicio : iso(inicio, 4), 'Aluguel', 'Casa 1')
    add('income', 1200, 'aluguel', primeiroDia && m === 0 ? inicio : iso(inicio, 6), 'Aluguel', 'Casa 2')
  }
  // Serviço avulso só em dois meses.
  add('income', 900, 'freelance', iso(monthStart(hoje, 1), 10), 'Projeto elétrico')
  add('income', 650, 'freelance', iso(monthStart(hoje, 3), 12), 'Reparo hidráulico')

  // OBRA: sobe mês a mês. Mês atual 1430, anterior 1010.
  const obraPorMes = [
    [520, 460, 450],        // mês atual  → 1430
    [400, 360, 250],        // mês -1     → 1010
    [300, 260],             // mês -2     → 560
    [180],                  // mês -3
    [220, 140],             // mês -4
    [90],                   // mês -5
  ]
  const obraDesc = ['Cimento', 'Areia', 'Tijolo', 'Ferro', 'Telha']
  obraPorMes.forEach((valores, m) => {
    valores.forEach((v, i) => add('expense', v, 'obra', iso(monthStart(hoje, m), primeiroDia && m === 0 && i === 0 ? 0 : 3 + i * 5), obraDesc[i % obraDesc.length]))
  })

  // ALIMENTAÇÃO: cai. Mês atual 380, anterior 640.
  const alimPorMes = [[200, 180], [340, 300], [310, 290], [280, 270], [250, 240], [230, 220]]
  alimPorMes.forEach((valores, m) => {
    valores.forEach((v, i) => add('expense', v, 'alimentacao', iso(monthStart(hoje, m), primeiroDia && m === 0 && i === 0 ? 0 : 8 + i * 9), i === 0 ? 'Mercado' : 'Feira'))
  })

  // Um gasto grande e isolado, para "qual foi meu maior gasto".
  add('expense', 2400, 'casa', iso(monthStart(hoje, 1), 15), 'Reforma do telhado')

  // Lugar com nome próprio, para busca por texto livre.
  add('expense', 45, 'alimentacao', iso(monthStart(hoje, 0), 2), 'Zé da esquina')
  add('expense', 38, 'alimentacao', iso(monthStart(hoje, 0), 9), 'Zé da esquina')
  add('expense', 52, 'alimentacao', iso(monthStart(hoje, 1), 5), 'Zé da esquina')

  // Fim de semana: dois gastos em sábado/domingo do mês atual.
  const inicio = fromISO(monthStart(hoje, 0))
  for (let d = 0; d < 28; d++) {
    const dia = addDays(monthStart(hoje, 0), d)
    if (dia > hoje) break
    const wd = fromISO(dia).getDay()
    if (wd === 6 || (primeiroDia && d === 0)) add('expense', 120, 'lazer', dia, 'Bar')
  }
  void inicio

  // Reserva: guardou em três meses.
  add('saving', 500, 'outros-out', iso(monthStart(hoje, 0), 12), 'Reserva')
  add('saving', 400, 'outros-out', iso(monthStart(hoje, 1), 12), 'Reserva')
  add('saving', 300, 'outros-out', iso(monthStart(hoje, 2), 12), 'Reserva')

  const base = buildState({
    profile: 'autonomo',
    balance: 4200,
    monthlyProfitTarget: 800,
    cards: [
      { name: 'Nubank', limit: 8000, closingDay: 20, dueDay: 28 },
      { name: 'Inter', limit: 5000, closingDay: 5, dueDay: 15 },
    ],
    goals: [
      { name: 'Notebook', target: 4000, saved: 1200 },
      { name: 'Viagem', target: 6000, saved: 4800 },
    ],
  })

  return {
    ...base,
    transactions: t,
    categories: DEFAULT_CATEGORIES,
    settings: { ...base.settings, balanceAsOf: `${monthStart(hoje, 6)}T00:00` },
    recurring: [
      {
        id: 'r1', name: 'Luz', amount: 180, frequency: 'monthly', dueDay: 10,
        category: 'casa', kind: 'expense', startDate: monthStart(hoje, 6), active: true,
        interval: 1, intervalUnit: 'month',
      },
      {
        id: 'r2', name: 'Internet', amount: 120, frequency: 'monthly', dueDay: 15,
        category: 'casa', kind: 'expense', startDate: monthStart(hoje, 6), active: true,
        interval: 1, intervalUnit: 'month',
      },
    ],
    installmentPlans: [
      {
        id: 'p1', description: 'Computador', cardId: 'card0', totalAmount: 4000,
        installmentCount: 10, firstDueDate: iso(monthStart(hoje, 2), 27),
        purchaseDate: iso(monthStart(hoje, 2), 1), status: 'active',
        operationType: 'card-purchase', createdAt: iso(monthStart(hoje, 2), 1),
        categoryId: 'outros-out',
      },
      {
        id: 'p2', description: 'Geladeira', cardId: 'card1', totalAmount: 2400,
        installmentCount: 6, firstDueDate: iso(monthStart(hoje, 1), 14),
        purchaseDate: iso(monthStart(hoje, 1), 2), status: 'active',
        operationType: 'card-purchase', createdAt: iso(monthStart(hoje, 1), 2),
        categoryId: 'outros-out',
      },
    ],
    installments: [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `i1-${i}`, planId: 'p1', number: i + 1, total: 10, amount: 400,
        dueDate: iso(monthStart(hoje, 2 - i > -8 ? 2 - i : 0), 27),
        status: (i < 2 ? 'paid' : 'pending') as 'paid' | 'pending',
      })).map((x, i) => ({ ...x, dueDate: iso(monthStart(hoje, 2 - i), 27) })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `i2-${i}`, planId: 'p2', number: i + 1, total: 6, amount: 400,
        dueDate: iso(monthStart(hoje, 1 - i), 14),
        status: (i < 1 ? 'paid' : 'pending') as 'paid' | 'pending',
      })),
    ],
  }
}

/**
 * MOTORISTA com 40 dias de histórico: ganhos por plataforma, km, horas,
 * viagens e abastecimentos. Segunda a sábado, domingo mais fraco.
 */
export function motoristaRico(hoje = TODAY): AppState {
  const r = rng(20260824)
  const t: Transaction[] = []
  const work: any[] = []
  const fuel: any[] = []
  let n = 0

  for (let d = 39; d >= 0; d--) {
    const dia = addDays(hoje, -d)
    const wd = fromISO(dia).getDay()
    if (wd === 0 && !(d === 0 && hoje.endsWith('-01'))) continue // folga, salvo um plantão no primeiro dia
    const forte = wd === 5 || wd === 6
    const baseUber = Math.round((forte ? 260 : 190) + r() * 60)
    const base99 = Math.round((forte ? 180 : 130) + r() * 50)
    t.push(tx(`u${++n}`, 'income', baseUber, 'corridas', dia, 'Uber'))
    t.push(tx(`n${++n}`, 'income', base99, 'corridas', dia, '99'))
    const km = Math.round((forte ? 190 : 150) + r() * 40)
    work.push({ id: `w${d}`, date: dia, km, hours: forte ? 10 : 8, trips: Math.round(km / 12) })
    if (d % 3 === 0) {
      const litros = Math.round((22 + r() * 6) * 10) / 10
      const valor = Math.round(litros * 5.9 * 100) / 100
      t.push(tx(`f${++n}`, 'expense', valor, 'combustivel', dia, 'Gasolina'))
      fuel.push({ id: `fr${d}`, date: dia, amount: valor, liters: litros, pricePerLiter: 5.9, odometer: 200000 + (39 - d) * 160 })
    }
  }
  t.push(tx(`m1`, 'expense', 280, 'manutencao', addDays(hoje, -20), 'Troca de óleo'))

  const base = buildState({ profile: 'driver', balance: 900, monthlyProfitTarget: 3000 })
  return {
    ...base,
    transactions: t,
    workSessions: work,
    fuelRecords: fuel,
    vehicle: { brand: 'Chevrolet', model: 'Onix', odometer: 206400, averageDailyKm: 160 } as any,
    maintenance: [{ id: 'mt1', name: 'Óleo', cost: 280, kmInstalled: 200000, lifeKm: 10000, date: addDays(hoje, -20) }],
    settings: { ...base.settings, balanceAsOf: `${addDays(hoje, -40)}T00:00`, fixedMonthlyCosts: 900 },
  }
}

/** Usuário NOVO: nada registrado. Toda pergunta tem que dizer que falta base. */
export function usuarioNovo(): AppState {
  return buildState({ profile: 'clt' })
}

export { TODAY }
