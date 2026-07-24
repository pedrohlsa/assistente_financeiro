export const fmtBRL = (v: number, digits = 2) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits })

export const fmtNum = (v: number, digits = 1) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: digits })

export const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const addDays = (iso: string, days: number) => {
  const d = fromISO(iso)
  d.setDate(d.getDate() + days)
  return toISO(d)
}

export const fromISO = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const nowTime = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const fmtDateShort = (iso: string) => {
  const d = fromISO(iso)
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
}

export const fmtDateLong = (iso: string) => {
  const today = todayISO()
  if (iso === today) return 'Hoje'
  if (iso === addDays(today, -1)) return 'Ontem'
  return fromISO(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' })
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export const greeting = () => {
  const h = new Date().getHours()
  if (h < 5) return 'Boa madrugada'
  if (h < 12) return 'Bom dia'
  if (h < 18) return 'Boa tarde'
  return 'Boa noite'
}

export const daysInMonth = (iso: string) => {
  const d = fromISO(iso)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

export const monthKey = (iso: string) => iso.slice(0, 7)

// parse "1.234,56" ou "1234.56" ou "80"
export const parseMoney = (s: string): number => {
  if (!s) return NaN
  let t = s.trim().replace(/[R$\s]/g, '')
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  return parseFloat(t)
}
