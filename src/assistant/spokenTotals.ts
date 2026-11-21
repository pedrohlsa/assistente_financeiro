import type { ParsedAction } from '../models/types'
import { fmtBRL, parseMoney } from '../utils/format'
import { analyzeMessage, looksLikeQuestion, looksPast } from './clauses'
import { normalizeNumberWords } from './numbers'

const MONEY = String.raw`(?:r\$\s*)?(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(?:\s+(?:reais?|contos?|pila))?`
const INCLUDED_ITEM = String.raw`${MONEY}\s+(?:d[eo]\s+(?:frete|entrega|taxas?|juros|servi[cç]o|gorjetas?)|(?:no|via|por)\s+pix|em\s+dinheiro)\b`
const INCLUDED = new RegExp(String.raw`(?:\s*,\s*|\s+)(?:e\s+)?(?:incluindo|contando(?:\s+com)?|dos\s+quais|dest[ea]s|dess[ea]s|j[áa]\s+com)\s+(?:[oa]s?\s+)?(${INCLUDED_ITEM}(?:(?:\s+e\s+|,\s*)${INCLUDED_ITEM})*)`, 'i')
const ITEMS = new RegExp(INCLUDED_ITEM, 'gi')
const TRAILING_TOTAL = new RegExp(String.raw`[,;]\s*(?:(?:e\s+)?(?:tudo\s+deu|somando\s+d[aá]|total(?:\s+de|\s+foi)?|ao\s+todo|no\s+total)\s+${MONEY}|${MONEY}\s+(?:no\s+total|ao\s+todo))[.!]*$`, 'i')

type Movement = { kind: 'in' | 'out'; amount: number }

function movement(a: ParsedAction): Movement | undefined {
  if (a.kind === 'income') return { kind: 'in', amount: a.amount }
  if (a.kind === 'expense' || a.kind === 'card-payment' || a.kind === 'fuel') {
    return a.amount > 0 ? { kind: 'out', amount: a.amount } : undefined
  }
  if (a.kind === 'card-purchase') return { kind: 'out', amount: a.total }
  return undefined
}

function movements(text: string, today: string, driver: boolean): Movement[] {
  const analysis = analyzeMessage(text, { today, driver })
  if (analysis.clauses.some(c => c.ambiguity || c.temporal || c.dateAmbiguity || c.intention)) return []
  const stated = analysis.actions.filter(a => a.kind !== 'work')
  const mapped = stated.map(movement)
  return mapped.every((m): m is Movement => !!m) ? mapped : []
}

const cents = (amount: number): number => Math.round(amount * 100)

/** Totais declarados e parcelas inclusas explicam os itens de um relato. */
export function reconcileSpokenTotals(message: string, today: string, driver: boolean): { text?: string; issue?: string } | undefined {
  if (!looksPast(message)) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const included = text.match(INCLUDED)
  if (included) {
    const before = text.slice(0, included.index)
    const parent = looksLikeQuestion(before) ? undefined : movements(before, today, driver).at(-1)
    if (parent) {
      const components = [...included[1].matchAll(ITEMS)].reduce((sum, item) => sum + cents(parseMoney(item[1])), 0)
      if (components > cents(parent.amount)) {
        return { issue: `Os valores incluídos somam ${fmtBRL(components / 100)}, acima do valor informado de ${fmtBRL(parent.amount)}. Qual foi o valor total?` }
      }
      const after = text.slice(included.index + included[0].length)
      const command = before + after
      // Um relato pode explicar inclusões e concluir com o total dos itens.
      return reconcileSpokenTotals(command, today, driver) || { text: command }
    }
  }
  const total = text.match(TRAILING_TOTAL)
  if (!total) return undefined
  const body = text.slice(0, total.index).trim()
  if (looksLikeQuestion(body)) return undefined
  const items = movements(body, today, driver)
  if (items.length < 2 || items.some(item => item.kind !== items[0].kind)) return undefined
  const declared = parseMoney(total[1] || total[2])
  const sum = items.reduce((amount, item) => amount + cents(item.amount), 0)
  if (cents(declared) !== sum) {
    return { issue: `Os itens somam ${fmtBRL(sum / 100)}, e você disse ${fmtBRL(declared)} no total. Quais foram os valores corretos?` }
  }
  return { text: body }
}
