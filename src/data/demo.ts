// Modo demonstração (seção 44) — gera ~30 dias de dados realistas de motorista de app.
import { AppState, Transaction, WorkSession, FuelRecord } from '../models/types'
import { addDays, todayISO, uid } from '../utils/format'

const rnd = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) * 100) / 100

export function buildDemoData(): Partial<AppState> {
  const transactions: Transaction[] = []
  const workSessions: WorkSession[] = []
  const fuelRecords: FuelRecord[] = []
  const today = todayISO()
  let odometer = 81200

  for (let i = 34; i >= 0; i--) {
    const date = addDays(today, -i)
    const weekday = new Date(date + 'T12:00:00').getDay()
    const works = weekday !== 0 || Math.random() < 0.3 // domingo às vezes folga
    if (!works) continue

    const isToday = i === 0
    const factor = isToday ? 0.75 : 1 // dia atual ainda em andamento
    const km = Math.round(rnd(95, 175) * factor)
    const trips = Math.round(rnd(11, 21) * factor)
    const hours = Math.round(rnd(6.5, 10.5) * factor * 10) / 10
    const gross = Math.round(km * rnd(2.1, 2.75) * 100) / 100

    workSessions.push({ id: uid(), date, km, trips, hours, source: 'demo' })
    transactions.push({ id: uid(), type: 'income', amount: gross, category: 'corridas', description: 'Corridas do dia', date, time: '20:30', source: 'demo' })

    if (Math.random() < 0.55) {
      const fuelAmount = rnd(60, 110)
      const price = rnd(5.79, 6.29)
      odometer += km
      fuelRecords.push({ id: uid(), date, amount: fuelAmount, liters: Math.round((fuelAmount / price) * 100) / 100, pricePerLiter: price, odometer, station: Math.random() < 0.5 ? 'Posto Shell' : 'Posto Ipiranga', fuelType: 'Gasolina' })
      transactions.push({ id: uid(), type: 'expense', amount: fuelAmount, category: 'combustivel', description: 'Abastecimento', date, time: '14:10', source: 'demo' })
    } else {
      odometer += km
    }
    if (Math.random() < 0.6) transactions.push({ id: uid(), type: 'expense', amount: rnd(18, 42), category: 'alimentacao', description: 'Almoço', date, time: '12:45', source: 'demo' })
    if (Math.random() < 0.12) transactions.push({ id: uid(), type: 'expense', amount: rnd(8, 25), category: 'estacionamento', description: 'Estacionamento', date, source: 'demo' })
    if (Math.random() < 0.1) transactions.push({ id: uid(), type: 'expense', amount: rnd(30, 90), category: 'lazer', description: 'Lazer', date, source: 'demo' })
  }

  return {
    transactions,
    workSessions,
    fuelRecords,
    vehicle: { brand: 'Chevrolet', model: 'Onix', year: '2021', odometer },
    maintenance: [
      { id: uid(), name: 'Óleo', cost: 280, kmInstalled: odometer - 8200, lifeKm: 10000, date: addDays(today, -48) },
      { id: uid(), name: 'Pneus', cost: 1600, kmInstalled: odometer - 21000, lifeKm: 40000, date: addDays(today, -160) },
      { id: uid(), name: 'Pastilhas', cost: 350, kmInstalled: odometer - 12000, lifeKm: 30000, date: addDays(today, -90) },
    ],
    goals: [
      { id: uid(), name: 'iPhone', target: 7000, saved: 2500, deadline: addDays(today, 148), createdAt: addDays(today, -60) },
      { id: uid(), name: 'Reserva de emergência', target: 5000, saved: 1200, deadline: addDays(today, 240), createdAt: addDays(today, -30) },
    ],
    recurring: [
      { id: uid(), name: 'Aluguel', amount: 950, frequency: 'monthly', dueDay: 5, category: 'casa' },
      { id: uid(), name: 'Internet', amount: 120, frequency: 'monthly', dueDay: Number(today.slice(8, 10)) % 25 + 3, category: 'assinaturas' },
      { id: uid(), name: 'Seguro do carro', amount: 280, frequency: 'monthly', dueDay: Number(today.slice(8, 10)) % 20 + 8, category: 'manutencao' },
      { id: uid(), name: 'Netflix', amount: 44.9, frequency: 'monthly', dueDay: 15, category: 'assinaturas' },
      { id: uid(), name: 'Academia', amount: 89.9, frequency: 'monthly', dueDay: 10, category: 'lazer' },
    ],
    budgets: [
      { id: uid(), category: 'alimentacao', limit: 600 },
      { id: uid(), category: 'lazer', limit: 300 },
    ],
  }
}
