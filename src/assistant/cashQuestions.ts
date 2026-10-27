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

/**
 * "Quanto eu tenho guardado", "minha reserva tá em quanto", "quanto já guardei":
 * o TOTAL guardado até hoje, não o saldo em conta nem o guardado do mês. A
 * reserva é a soma das transferências `saving` (regra 5) e as metas guardam o
 * próprio valor. Pergunta com período ("esse ano") continua na consulta.
 */
export function pedeTotalGuardado(t: string): boolean {
  return /\bquanto\s+(?:eu\s+)?(?:tenho|tem|ha)\s+(?:de\s+)?(?:guardado|reservado|na\s+reserva|na\s+poupanca)\b|\breserva\s+(?:esta|ta)\s+em\s+quanto\b|\bquanto\s+(?:esta|ta)\s+(?:a\s+)?(?:minha\s+)?reserva\b|\bsaldo\s+da\s+reserva\b|\bquanto\s+(?:eu\s+)?ja\s+guardei\s*\??$/.test(t)
}

/** "Tirei 300 da reserva": não há lançamento de retirada no app. */
export const retiraDaReserva = (t: string): boolean =>
  /\b(?:tirei|retirei|saquei|peguei|usei)\b[^.?!]*\b(?:da|na)\s+(?:minha\s+)?(?:reserva|poupanca)\b/.test(t)

export type PerguntaDeFatura = 'falta' | 'paga' | 'atrasada' | 'vence' | 'fecha' | 'valor'

/**
 * Situação da fatura de agora: quanto falta, se já foi paga, se atrasou, quando
 * vence ou fecha. "Quanto falta pagar DA FATURA" é o pendente dela — a DSL lia
 * "falta pagar" como parcelamento e respondia a dívida inteira do cartão. Fatura
 * futura ("mês que vem", "próximos meses", "maior fatura") fica com quem já a
 * responde. "Paguei a fatura" só é pergunta com "?" — sem ele, é registro.
 */
export function perguntaDeFatura(t: string): PerguntaDeFatura | null {
  if (!/\bfaturas?\b/.test(t)) return null
  if (/\bmaior\b|\bproxim[oa]s?\s+(?:\d+\s+|dois\s+|tres\s+|quatro\s+|cinco\s+|seis\s+)?meses\b|\bmes\s+que\s+vem\b|\bproximo\s+mes\b|\b(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(t)) return null
  if (/\bquanto\b[^?]*\b(?:falta|faltam|resta|restam)\b|\b(?:falta|resta)\s+(?:pagar|quitar)\b|\bquanto\s+(?:eu\s+)?(?:ainda\s+)?devo\s+d[ae]s?\s+(?:minhas?\s+)?faturas?\b/.test(t)) return 'falta'
  if (/\batrasad|\bvencid|\bja\s+venceu\b/.test(t)) return 'atrasada'
  if (/\bfaturas?\b[^?]*\b(?:esta|foi|estao|foram)\s+(?:ja\s+)?pagas?\b|\bpague[iu]\b[^?]*\bfaturas?\b[^?]*\?|\bsera\s+que\s+(?:eu\s+)?(?:ja\s+)?pague[iu]\b/.test(t)) return 'paga'
  if (/\bquando\b[^?]*\bvence\b|\bvence\s+quando\b|\bque\s+dia\s+vence\b|\bvencimento\b/.test(t)) return 'vence'
  if (/\bfecha\b|\bfechou\b|\bfechamento\b|\bquando\b[^?]*\bvira\b|\bvira\s+quando\b/.test(t)) return 'fecha'
  // "Quanto tá a fatura": a de AGORA. O mês do calendário respondia a do C6
  // que já venceu e foi paga, e chamava de "previsão" uma fatura fechada.
  if (!/\bpassad[oa]\b|\banterior\b|\bultima\b|\b(?:esse|este)\s+ano\b/.test(t)
    && /\bquanto\s+(?:e|esta|vem|veio|ficou|deu|vai\s+(?:vir|ficar|dar))\s+(?:a\s+)?(?:minha\s+)?fatura\b|\bquanto\s+(?:e|esta|vem|veio|ficou|deu|vai\s+(?:vir|ficar|dar))\b[^?]*\bfatura\b|\bvalor\s+da\s+(?:minha\s+)?fatura\b|\bqual\s+(?:e\s+)?a\s+(?:minha\s+)?fatura\b/.test(t)) return 'valor'
  return null
}

/**
 * "Quanto falta pagar esse mês", "quanto falta de conta", "quanto ainda tenho
 * de conta pra pagar": o que AINDA vence. A DSL lia "falta pagar" como
 * parcelamento e respondia a dívida parcelada inteira, ou procurava um
 * parcelamento chamado "conta esse". Compra citada ("do computador") e fatura
 * ficam com quem já as responde.
 */
export function pedeContasAPagar(t: string): boolean {
  return /\bquanto\b[^?]*\b(?:falta|faltam|resta|restam)\s+(?:(?:eu\s+)?pagar\s+)?(?:de\s+|em\s+)?(?:conta|contas|boleto|boletos)\b/.test(t)
    || /\bquanto\b[^?]*\b(?:tenho|tem)\s+(?:de\s+|em\s+)?(?:conta|contas|boleto|boletos)\s+(?:para|a)\s+pagar\b/.test(t)
    || /\bquanto\s+(?:ainda\s+)?(?:me\s+)?(?:falta|resta)\s+(?:eu\s+)?pagar\s+(?:(?:esse|este|nesse|neste)\s+mes|ate\s+o\s+(?:fim|final)\s+do\s+mes)\s*\??$/.test(t)
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
