// Perguntas sobre o caixa FUTURO: quanto deixar disponível até uma data e qual
// conta está pesando.
//
// A DSL de consulta soma o que JÁ aconteceu. Estas duas perguntas olham para o
// que AINDA vai sair — contas fixas, faturas e parcelas cadastradas. Mandá-las
// para a DSL respondia o gasto do mês (número certo, pergunta outra), a meta
// de hoje do motorista, ou recusava por resíduo ("não consegui ler: conta ate").
// O planejador as recusa por aqui e o roteador antigo responde com
// `cashObligationsUntil()`.
//
// Recebem texto já normalizado: minúsculo, sem acento, "ta" → "esta" e
// "pra"/"pro" → "para" — as duas normalizações do app fazem isso.

import { addDays, dateForDayOfMonth, fromISO, toISO } from '../utils/format'

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

/** "quanto preciso deixar…", "quanto tenho que separar…", "quanto devo ter…". */
const QUANTO_DEIXAR = /\bquanto\b.*\b(?:preciso|devo|tenho\s+(?:que|de)|teria\s+que)\s+(?:deixar|ter|manter|separar|reservar|segurar)\b/

/**
 * Sem prazo nem destino do dinheiro, "quanto preciso reservar" é pergunta de
 * META ("pra viagem", "por mês") — que tem outra resposta.
 */
// "pro dia 10" chega aqui como "para dia 10": a normalização engole o artigo.
const PRAZO_OU_CAIXA = /\b(?:ate|para|no)\s+(?:o\s+)?(?:dia\s+\d{1,2}|fim\s+do\s+mes|final\s+do\s+mes)\b|\bate\s+(?:amanha|o\s+fim|o\s+final)\b|\bparad[oa]\b|\bna\s+conta\b|\bem\s+caixa\b|\bdisponivel\b|\bpara\s+(?:as\s+|os\s+)?(?:contas|boletos)\b/
const PERGUNTA_DE_META = /\bmeta\b|\bpor\s+mes\b|\bpor\s+semana\b|\bjuntar\b/

export function pedeReservaDeCaixa(t: string): boolean {
  return QUANTO_DEIXAR.test(t) && PRAZO_OU_CAIXA.test(t) && !PERGUNTA_DE_META.test(t)
}

/** "qual conta está me apertando", "qual das contas pesa mais", "qual boleto…". */
export function pedeContaQueAperta(t: string): boolean {
  return /\bqual\s+(?:das\s+|dos\s+|e\s+a\s+|e\s+o\s+)?(?:contas?|boletos?|compromissos?)\b.*\b(?:apertando|aperta|pesando|pesa|pesada|pesado|matando|sufocando)\b/.test(t)
}

/**
 * Até quando olhar o que vence: "essa semana", "até dia 10", "este mês".
 * Sem prazo dito, `padraoDias` — o mesmo horizonte que a resposta já usava.
 */
export function prazoDasContas(t: string, hoje: string, padraoDias: number): string {
  if (/\b(?:essa|esta|nessa|nesta)\s+semana\b|\bproxim[oa]s?\s+7\s+dias\b/.test(t)) return addDays(hoje, 7)
  const dito = alvoDaReserva(t, hoje)
  if (dito.kind === 'date') return dito.date
  if (/\b(?:esse|este|nesse|neste)\s+mes\b/.test(t)) {
    const h = fromISO(hoje)
    return toISO(new Date(h.getFullYear(), h.getMonth() + 1, 0))
  }
  return addDays(hoje, padraoDias)
}

export type AlvoDaReserva =
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; dia: number }
  | { kind: 'missing' }

/**
 * Data-limite da reserva. "Dia 10" sem mês é o PRÓXIMO dia 10 — é o que
 * qualquer pessoa entende; perguntar "de qual mês?" atrapalhava sem proteger
 * nada. Dia que o mês não tem (31 em novembro) vira o último dia do mês, a
 * mesma regra das contas recorrentes.
 */
export function alvoDaReserva(t: string, hoje: string): AlvoDaReserva {
  if (/\bamanha\b/.test(t)) return { kind: 'date', date: addDays(hoje, 1) }
  const h = fromISO(hoje)
  if (/\b(?:fim|final)\s+do\s+mes\b/.test(t)) {
    return { kind: 'date', date: toISO(new Date(h.getFullYear(), h.getMonth() + 1, 0)) }
  }
  const m = t.match(/\bdia\s+(\d{1,2})(?:\s+de\s+([a-z]+)|\s*\/\s*(\d{1,2}))?\b/)
  if (!m) return { kind: 'missing' }
  const dia = Number(m[1])
  const mesDito = m[2] ? MESES.indexOf(m[2]) : m[3] ? Number(m[3]) - 1 : -1
  if (dia < 1 || dia > 31 || (m[2] && mesDito < 0) || mesDito > 11) return { kind: 'invalid', dia }
  if (mesDito >= 0) {
    const neste = dateForDayOfMonth(h.getFullYear(), mesDito, dia)
    return { kind: 'date', date: toISO(neste < h ? dateForDayOfMonth(h.getFullYear() + 1, mesDito, dia) : neste) }
  }
  const neste = dateForDayOfMonth(h.getFullYear(), h.getMonth(), dia)
  return { kind: 'date', date: toISO(neste < h ? dateForDayOfMonth(h.getFullYear(), h.getMonth() + 1, dia) : neste) }
}
