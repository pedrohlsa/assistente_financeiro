// "O salário já caiu?", "a Casa 2 já pagou?", "recebi da Casa 1 esse mês?".
//
// A pergunta é se um dinheiro CHEGOU — e o app só sabe o que foi registrado.
// Antes, "caiu" era lido como comparação ("o gasto caiu?") e a resposta era
// "Não, subiu. Total gasto este mês…", e "já pagou?" ia para a ajuda genérica.
//
// Regras desta resposta:
// - O alvo é RECONHECIDO, nunca adivinhado: uma origem que já aparece nos
//   lançamentos (mesmo texto, sem aproximação — regra 41), uma entrada prevista
//   pelo nome, ou a categoria de receita dita na frase. Sem alvo, não responde.
// - Fala em "registrado", porque o app não vê o banco.
// - Previsão continua previsão (regra 18): o que está cadastrado e não foi
//   confirmado aparece como previsto, nunca como recebido.

import type { AppState, RecurringExpense, Transaction } from '../models/types'
import { guessCategory } from '../data/categories'
import { occurrencesBetween } from '../services/calc'
import { fmtBRL, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { brDate } from './dates'

const VERBO = /\b(?:ja\s+)?(?:caiu|cairam|entrou|entraram|chegou|chegaram|pagou|pagaram|depositou|depositaram|mandou|mandaram|transferiu|transferiram)\b/
const RECEBI = /^(?:(?:eu|sera\s+que)\s+)?(?:ja\s+)?recebi\s+(?:o\s+|a\s+)?(?:d[aeo]s?\s+)?(.+?)$/
const ESTE_MES = /\b(?:esse|este|nesse|neste)\s+mes\b|\bdo\s+mes\b/g
const SUJEITO_VAZIO = /^(?:o|a|os|as|meu|minha|meus|minhas|ja|sera|que|inquilin[oa]|d[aeo]s?|e|ai|hein|ne|\s)*$/
const GENERICO = /^(?:o\s+|a\s+)?(?:pix|dinheiro|pagamento|deposito|transferencia|grana|valor)$/

interface Alvo { rotulo: string; casa: (t: Transaction) => boolean; previstas: RecurringExpense[] }

const mesDe = (iso: string) => iso.slice(0, 7)

function alvoDe(s: AppState, sujeito: string): Alvo | null {
  const suj = ` ${sujeito.replace(/\s+/g, ' ').trim()} `
  // Origem já usada, como PALAVRAS inteiras dentro do sujeito ("aluguel da
  // casa 1" contém "casa 1"). A mais longa ganha: "casa 10" antes de "casa 1".
  const origens = new Map<string, string>()
  for (const t of s.transactions) {
    if (t.type !== 'income' || !t.origin?.trim()) continue
    origens.set(normalizeName(t.origin), t.origin.trim())
  }
  const origem = [...origens.keys()].sort((a, b) => b.length - a.length).find(o => suj.includes(` ${o} `))
  const recorrentes = (s.recurring || []).filter(r => r.kind === 'income' && r.active !== false)
  if (origem) {
    return {
      rotulo: origens.get(origem)!,
      casa: t => t.type === 'income' && normalizeName(t.origin || '') === origem,
      previstas: recorrentes.filter(r => normalizeName(r.origin || '') === origem || normalizeName(r.name) === origem),
    }
  }
  const prevista = recorrentes.sort((a, b) => b.name.length - a.name.length).find(r => suj.includes(` ${normalizeName(r.name)} `))
  if (prevista) {
    return {
      rotulo: prevista.name.trim(),
      casa: t => t.type === 'income' && (t.recurringId === prevista.id || t.category === prevista.category),
      previstas: [prevista],
    }
  }
  const cat = guessCategory(sujeito, 'income')
  if (cat && cat !== 'corridas') {
    const nome = s.categories.find(c => c.id === cat)?.name || cat
    return {
      rotulo: nome,
      casa: t => t.type === 'income' && t.category === cat,
      previstas: recorrentes.filter(r => r.category === cat),
    }
  }
  return null
}

/** Sujeito da pergunta de chegada, ou `null` quando a frase não é uma. */
function sujeitoDe(t: string): string | null {
  // Valor na frase é registro ("caiu 3200 do salário"), não pergunta. Dígito
  // ÚNICO pode ser parte do nome ("Casa 2").
  if (/\d{2,}|\d[.,]\d|r\$/.test(t)) return null
  if (/\b(?:quanto|quantos|quantas|qual|quais|quando|onde|como|por\s*que)\b/.test(t)) return null
  if (/\bn[aã]o\b/.test(t)) return null
  const limpo = t.replace(/[?!.,]/g, ' ').replace(ESTE_MES, ' ').replace(/\s+/g, ' ').trim()
  const r = limpo.match(RECEBI)
  if (r && /\?|^sera\b|\bja\b/.test(t)) return r[1]
  const v = limpo.match(VERBO)
  if (!v || v.index === undefined) return null
  // O verbo fecha a pergunta: depois dele só pode haver "já", "hoje", "ainda".
  if (limpo.slice(v.index + v[0].length).replace(/\b(?:ja|hoje|ainda|ai|hein|ne|na\s+conta|pra\s+mim)\b/g, '').trim()) return null
  if (!/\?|\bja\b|^sera\b/.test(t)) return null
  const sujeito = limpo.slice(0, v.index).replace(/^(?:sera\s+que\s+)/, '').trim()
  return sujeito
}

const RENDA_QUE_CHEGA = /\b(?:salario|aluguel|alugueis|comissao|freela|freelance|pensao|beneficio|bolsa|vale|decimo|13o?|ferias|restituicao|reembolso|adiantamento|casa\s+\d|cliente|inquilin[oa]|patrao|empresa)\b/
const VERBO_SO_DE_CHEGADA = /\b(?:pagou|pagaram|depositou|depositaram|mandou|mandaram|transferiu|transferiram)\b/

/**
 * Sem estado: a frase TEM a forma de "o dinheiro chegou?". "Caiu" só conta com
 * uma renda nomeada — "o gasto caiu?" continua sendo comparação, da consulta.
 */
export function pareceChegada(input: string): boolean {
  const t = normalizeName(input)
  const sujeito = sujeitoDe(t)
  if (sujeito === null || SUJEITO_VAZIO.test(sujeito) || GENERICO.test(sujeito)) return false
  if (/\b(?:gastos?|despesas?|contas?|custos?|consumo|lucro|sobra|resultado|faturamento|renda|receitas?|ganhos?|saldo)\b/.test(sujeito)) return false
  return RENDA_QUE_CHEGA.test(sujeito) || VERBO_SO_DE_CHEGADA.test(t) || RECEBI.test(t.replace(/[?!.,]/g, ' ').trim())
}

export function respostaDeChegada(s: AppState, input: string, hoje = todayISO()): string | undefined {
  const t = normalizeName(input)
  const sujeito = sujeitoDe(t)
  if (sujeito === null || SUJEITO_VAZIO.test(sujeito) || GENERICO.test(sujeito)) return undefined
  const alvo = alvoDe(s, sujeito)
  if (!alvo) return undefined

  const mes = mesDe(hoje)
  const doMes = s.transactions.filter(x => alvo.casa(x) && mesDe(x.date) === mes && x.date <= hoje)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (doMes.length) {
    const total = doMes.reduce((a, x) => a + x.amount, 0)
    const lista = doMes.slice(-3).map(x => `• ${brDate(x.date)}: ${fmtBRL(x.amount)}`).join('\n')
    return `Sim — está registrado: ${alvo.rotulo} entrou ${fmtBRL(total)} este mês (dado real).\n\n${lista}`
  }

  const anterior = s.transactions.filter(x => alvo.casa(x) && x.date < `${mes}-01`)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  const partes = [`Ainda não — não há entrada de ${alvo.rotulo} registrada este mês.`]
  const fimMes = `${mes}-31`
  const prevista = alvo.previstas
    .flatMap(r => occurrencesBetween(r, `${mes}-01`, fimMes).map(d => ({ r, d })))
    .filter(o => !(o.r.occurrences || []).some((x: any) => x.date === o.d))
    .sort((a, b) => a.d.localeCompare(b.d))[0]
  if (prevista) partes.push(`Está prevista para ${brDate(prevista.d)}: ${fmtBRL(prevista.r.amount)} (previsão, ainda não confirmada).`)
  if (anterior) partes.push(`A última foi ${fmtBRL(anterior.amount)} em ${brDate(anterior.date)}.`)
  partes.push(`Se já caiu, me diga — por exemplo, "recebi ${anterior ? Math.round(anterior.amount) : 1000} ${/^(?:casa|cliente|loja|apart|sala|kitnet)/i.test(alvo.rotulo) ? `da ${alvo.rotulo}` : `de ${alvo.rotulo.toLowerCase()}`}" — que eu registro.`)
  return partes.join('\n\n')
}
