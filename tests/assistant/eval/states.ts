// ESTADOS SINTÉTICOS da avaliação remota.
//
// A avaliação manda texto para fora da máquina. Por isso o estado nunca vem de
// lugar nenhum além daqui: fixtures determinísticos, com um NOME-CANÁRIO que
// prova a origem sintética em toda requisição de chat (ver privacy.ts). Nenhuma
// função deste diretório lê localStorage, backup ou arquivo do usuário — e o
// transporte recusa enviar um contexto de chat sem o canário.

import type { AppState, Transaction } from '../../../src/models/types'
import { DEFAULT_CATEGORIES } from '../../../src/data/categories'
import { addDays } from '../../../src/utils/format'
import { normalizeName } from '../../../src/utils/text'
import { autonomoRico, motoristaRico, usuarioNovo, monthStart } from '../../fixtures/richState'
import { buildState } from '../harness'
import type { PerfilEval } from './types'

export const CANARIO = 'Usuário Sintético AssistFin'

const marca = (s: AppState): AppState => ({ ...s, settings: { ...s.settings, name: CANARIO } })

const tx = (
  id: string, type: Transaction['type'], amount: number, category: string,
  date: string, description?: string, origin?: string,
): Transaction => ({ id, type, amount, category, date, description, origin, time: '10:00', source: 'manual' })

/**
 * CLT: salário fixo, aluguel PAGO (despesa, nunca receita), mercado, Uber como
 * DESPESA de deslocamento, Netflix e reserva. Existe separado do autônomo
 * porque os casos de perfil dependem justamente disto: "Uber" e "aluguel" aqui
 * não são renda.
 */
export function cltSintetico(hoje: string): AppState {
  const t: Transaction[] = []
  let n = 0
  const add = (type: Transaction['type'], amount: number, category: string, date: string, description?: string) => {
    if (date > hoje) return
    t.push(tx(`c${++n}`, type, amount, category, date, description))
  }
  for (let m = 0; m < 6; m++) {
    const ini = monthStart(hoje, m)
    add('income', 4200, 'salario', addDays(ini, 4), 'Salário')
    add('expense', 1300, 'casa', addDays(ini, 9), 'Aluguel')
    add('expense', 410 - m * 10, 'alimentacao', addDays(ini, 6), 'Mercado')
    add('expense', 260 + m * 5, 'alimentacao', addDays(ini, 20), 'Mercado')
    add('expense', 32, 'outros-out', addDays(ini, 3), 'Uber')
    add('expense', 28, 'outros-out', addDays(ini, 11), 'Uber')
    add('expense', 41, 'outros-out', addDays(ini, 17), 'Uber')
    add('expense', 55.9, 'assinaturas', addDays(ini, 14), 'Netflix')
    add('saving', 300, 'outros-out', addDays(ini, 5), 'Reserva')
  }
  const base = buildState({
    profile: 'clt', balance: 3100, monthlyProfitTarget: 600,
    cards: [{ name: 'Nubank', limit: 4000, closingDay: 3, dueDay: 10 }],
    goals: [{ name: 'Celular', target: 2500, saved: 900 }, { name: 'Reserva de emergência', target: 10000, saved: 3200 }],
  })
  return marca({
    ...base,
    transactions: t,
    categories: DEFAULT_CATEGORIES,
    settings: { ...base.settings, balanceAsOf: `${monthStart(hoje, 6)}T00:00` },
    recurring: [
      {
        id: 'cr1', name: 'Luz', amount: 160, frequency: 'monthly', dueDay: 12, category: 'casa',
        kind: 'expense', startDate: monthStart(hoje, 6), active: true, interval: 1, intervalUnit: 'month',
      },
      {
        id: 'cr2', name: 'Internet', amount: 110, frequency: 'monthly', dueDay: 20, category: 'casa',
        kind: 'expense', startDate: monthStart(hoje, 6), active: true, interval: 1, intervalUnit: 'month',
      },
    ] as any,
  })
}

/** Perfil genérico com DOIS cartões e DUAS metas: é o que torna "paguei a fatura" e "coloquei na meta" ambíguos. */
export function outroSintetico(hoje: string): AppState {
  const ini = monthStart(hoje, 0)
  const ant = monthStart(hoje, 1)
  const t = [
    tx('o1', 'income', 3000, 'outros-in', addDays(ant, 4), 'Pagamento'),
    tx('o2', 'expense', 230, 'alimentacao', addDays(ant, 8), 'Mercado'),
    tx('o3', 'expense', 90, 'lazer', addDays(ant, 15), 'Cinema'),
    tx('o4', 'income', 3000, 'outros-in', addDays(ini, 4), 'Pagamento'),
    tx('o5', 'expense', 245, 'alimentacao', addDays(ini, 7), 'Mercado'),
    tx('o6', 'expense', 45, 'autocuidado', addDays(ini, 9), 'Farmácia'),
  ].filter(x => x.date <= hoje)
  const base = buildState({
    profile: 'other', balance: 2000, monthlyProfitTarget: 500,
    cards: [
      { name: 'Nubank', limit: 3000, closingDay: 20, dueDay: 28 },
      { name: 'Inter', limit: 2000, closingDay: 5, dueDay: 15 },
    ],
    goals: [{ name: 'Moto', target: 12000, saved: 3000 }, { name: 'Viagem', target: 5000, saved: 1000 }],
  })
  return marca({ ...base, transactions: t, settings: { ...base.settings, balanceAsOf: `${ant}T00:00` } })
}

export const ESTADOS: Record<PerfilEval, (hoje: string) => AppState> = {
  autonomo: h => marca(autonomoRico(h)),
  motorista: h => marca(motoristaRico(h)),
  clt: cltSintetico,
  other: outroSintetico,
  novo: () => marca(usuarioNovo()),
}

/**
 * Todo nome que pode aparecer num contexto de PLANEJAMENTO: categorias, cartões,
 * metas. O guarda de privacidade recusa enviar um nome fora desta lista — um
 * nome desconhecido só poderia ter vindo de um estado que não é sintético.
 */
export function vocabularioSintetico(hoje: string): Set<string> {
  const v = new Set<string>()
  for (const construir of Object.values(ESTADOS)) {
    const s = construir(hoje)
    for (const c of s.categories || []) { v.add(normalizeName(c.name)); v.add(normalizeName(c.id)) }
    for (const c of s.cards || []) v.add(normalizeName(c.name))
    for (const g of s.goals || []) v.add(normalizeName(g.name))
  }
  return v
}
