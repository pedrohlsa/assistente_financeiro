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

/** Carimbo 'YYYY-MM-DDTHH:mm' — ordenável como string, usado pela âncora do saldo. */
export const nowStamp = () => `${todayISO()}T${nowTime()}`

/** Mesmo formato de `nowStamp`, montado a partir de uma transação. */
export const stampOf = (date: string, time?: string) => `${date}T${time || '00:00'}`

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

/**
 * Parser monetário pt-BR — ÚNICO do app. Nunca duplicar esta lógica em formulário,
 * tela ou parser de linguagem natural: todos importam daqui.
 *
 * Heurística (tolerante a formatos digitados errado):
 * - o ÚLTIMO separador seguido de exatamente 3 algarismos é separador de MILHAR
 *   ("100.000" e "100,000" → 100000);
 * - qualquer outro último separador é DECIMAL, e os anteriores são milhares
 *   ("1.234,56", "1,234.56" e "10,000,00" → 1234.56 / 1234.56 / 10000);
 * - R$, espaços e símbolos são ignorados;
 * - entrada sem nenhum algarismo (".", ",", "-", "R$", "abc") devolve NaN —
 *   nunca 0 silencioso, para o formulário conseguir recusar o valor.
 */
export const parseMoney = (s: string | number | null | undefined): number => {
  if (typeof s === 'number') return isFinite(s) ? s : NaN
  if (s == null) return NaN
  let t = String(s).replace(/[^\d.,-]/g, '')
  const negative = t.startsWith('-')
  t = t.replace(/-/g, '').replace(/[.,]+$/, '')
  if (!/\d/.test(t)) return NaN

  const lastSep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','))
  let normalized: string
  if (lastSep < 0) {
    normalized = t
  } else if (t.length - lastSep - 1 === 3) {
    normalized = t.replace(/[.,]/g, '')
  } else {
    normalized = t.slice(0, lastSep).replace(/[.,]/g, '') + '.' + t.slice(lastSep + 1)
  }

  const v = parseFloat(normalized)
  if (!isFinite(v)) return NaN
  return negative ? -v : v
}

/**
 * Normaliza o que o usuário digitou para o formato pt-BR — usado SÓ no blur.
 * Formatar durante a digitação move o cursor e atrapalha; por isso nunca é
 * chamado no onChange. Entrada inválida volta intacta para o usuário corrigir.
 */
export const formatMoneyInput = (s: string): string => {
  const v = parseMoney(s)
  if (isNaN(v)) return s
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Último dia de um mês (0 = janeiro). Usado por vencimentos dia 29/30/31. */
export const lastDayOfMonth = (year: number, monthIndex: number): number =>
  new Date(year, monthIndex + 1, 0).getDate()

/**
 * Data real de um "dia do mês" dentro de um mês específico: dia 31 em fevereiro
 * vira o último dia de fevereiro, dia 31 em abril vira 30. Nunca força o dia 28.
 */
export const dateForDayOfMonth = (year: number, monthIndex: number, day: number): Date =>
  new Date(year, monthIndex, Math.min(Math.max(Math.round(day) || 1, 1), lastDayOfMonth(year, monthIndex)))

/** Diferença em dias entre duas datas ISO (b − a), sem horas envolvidas. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 86400000)

/**
 * Texto único de vencimento em todo o app (Home, Planejamento, recorrentes).
 * Nunca escreve "vence hoje" para uma data passada.
 */
export const dueLabel = (inDays: number, kind: 'income' | 'expense' = 'expense'): string => {
  const verb = kind === 'income' ? 'Cai' : 'Vence'
  if (inDays === 0) return `${verb} hoje`
  if (inDays === 1) return `${verb} amanhã`
  if (inDays > 1) return `${verb} em ${inDays} dias`
  if (inDays === -1) return kind === 'income' ? 'Era para ter caído ontem' : 'Venceu ontem'
  return kind === 'income' ? `Era para ter caído há ${-inDays} dias` : `Venceu há ${-inDays} dias`
}
