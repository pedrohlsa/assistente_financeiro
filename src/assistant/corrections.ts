// Correções, negações e referências ANTES da confirmação.
//
// "não foi 100, foi 80", "remove a primeira", "era no Inter", "é GNV":
// tudo isso modifica a PROPOSTA pendente. Nada aqui toca em dado já salvo —
// alterar um lançamento existente é um fluxo próprio, com confirmação separada.

import type { ParsedAction } from '../models/types'
import type { AssistantCandidateAction, AssistantCapabilities } from './contracts'
import { fmtBRL, parseMoney, todayISO } from '../utils/format'
import { normalizeNumberWords } from './numbers'
import { findDate } from './dates'
import { extractOrigins } from './clauses'
import { normalizeName } from '../utils/text'
import { guessCategory } from '../data/categories'

const NUMBER = String.raw`(\d+(?:[.,]\d+)*)`

export interface CorrectionPlan {
  /** Ids a remover da proposta. */
  remove: string[]
  /** Alterações campo a campo. */
  edits: { id: string; field: string; value: any; was: any }[]
  /** Cancelar a proposta inteira. */
  cancelAll: boolean
  /** Descrição em pt-BR do que foi entendido, para o assistente confirmar. */
  summary: string[]
  /** A frase referenciava algo que não deu para identificar com segurança. */
  ambiguous?: { question: string; options: { label: string; value: string }[] }
}

const ORDINALS: Record<string, number> = {
  primeira: 0, primeiro: 0, '1a': 0, '1o': 0, '1ª': 0, '1º': 0,
  segunda: 1, segundo: 1, '2a': 1, '2o': 1, '2ª': 1, '2º': 1,
  terceira: 2, terceiro: 2, '3a': 2, '3o': 2, '3ª': 2, '3º': 2,
  quarta: 3, quarto: 3, quinta: 4, quinto: 4,
}

const KIND_WORDS: { re: RegExp; kinds: ParsedAction['kind'][] }[] = [
  { re: /\b(?:sal[áa]rio|receita|entrada|ganho|recebimento)\b/i, kinds: ['income'] },
  { re: /\b(?:despesa|gasto|sa[íi]da|conta)\b/i, kinds: ['expense'] },
  { re: /\b(?:abastecimento|gasolina|combust[íi]vel)\b/i, kinds: ['fuel'] },
  { re: /\b(?:compra|parcelamento|parcelad[oa])\b/i, kinds: ['card-purchase'] },
  { re: /\b(?:guardado|reserva|poupan[çc]a)\b/i, kinds: ['saving'] },
  { re: /\b(?:trabalho|km|viagens|horas)\b/i, kinds: ['work'] },
  { re: /\b(?:meta)\b/i, kinds: ['goal', 'goal-update', 'goal-deposit'] },
]

const amountOf = (a: ParsedAction): number | undefined =>
  (a as any).amount ?? (a as any).total ?? (a as any).cost ?? (a as any).target

/** Qual ação pendente a frase está referenciando? */
function resolveTarget(
  text: string,
  pending: AssistantCandidateAction[],
): { id: string } | { ambiguousAmong: AssistantCandidateAction[] } | null {
  if (!pending.length) return null
  // Sem acento: "última" pode chegar com o acento composto (u + ˊ) da entrada
  // por voz ou de outro teclado, e aí um `[úu]ltim[ao]` literal não casa.
  const t = normalizeName(text)

  // "a última"
  if (/\b[úu]ltim[ao]\b/.test(t)) return { id: pending[pending.length - 1].id }

  // "a primeira", "o segundo"
  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (new RegExp(String.raw`\b${word}\b`, 'i').test(t)) {
      if (idx < pending.length) return { id: pending[idx].id }
    }
  }

  // "o gasto de 190" — valor citado
  const { text: norm } = normalizeNumberWords(t)
  for (const m of norm.matchAll(new RegExp(String.raw`(?:de|do|da)\s*(?:r\$)?\s*${NUMBER}(\s*mil)?`, 'g'))) {
    const v = parseMoney(m[1]) * (m[2] ? 1000 : 1)
    const hits = pending.filter(p => Math.abs((amountOf(p.action) ?? NaN) - v) < 0.005)
    if (hits.length === 1) return { id: hits[0].id }
    if (hits.length > 1) return { ambiguousAmong: hits }
  }

  // "o café", "o almoço" — o NOME do lançamento. Sem isto, "tira o café" com
  // almoço e café na tela não achava alvo e a proposta inteira sumia.
  {
    const hits = pending.filter(p => {
      const nome = normalizeName(String((p.action as any).description || (p.action as any).origin || ''))
      return nome.length >= 3 && new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)
    })
    if (hits.length === 1) return { id: hits[0].id }
    if (hits.length > 1) return { ambiguousAmong: hits }
  }

  // "o salário", "a despesa"
  for (const kw of KIND_WORDS) {
    if (!kw.re.test(t)) continue
    const hits = pending.filter(p => kw.kinds.includes(p.action.kind))
    if (hits.length === 1) return { id: hits[0].id }
    if (hits.length > 1) return { ambiguousAmong: hits }
  }

  // Uma proposta só: a referência é inequívoca.
  if (pending.length === 1) return { id: pending[0].id }
  return null
}

const describe = (a: ParsedAction): string => {
  const v = amountOf(a)
  const label = a.kind === 'income' ? 'receita' : a.kind === 'expense' ? 'despesa'
    : a.kind === 'saving' ? 'valor guardado' : a.kind === 'fuel' ? 'abastecimento'
      : a.kind === 'card-purchase' ? 'compra' : a.kind
  return v !== undefined ? `${label} de ${fmtBRL(v)}` : label
}

/**
 * Interpreta uma frase de correção contra a proposta pendente.
 * Devolve `null` quando a frase não é uma correção reconhecível — nesse caso o
 * fluxo normal segue e nada é alterado por engano.
 */
export function parseCorrection(
  message: string,
  pending: AssistantCandidateAction[],
  caps: AssistantCapabilities,
  today = todayISO(),
): CorrectionPlan | null {
  if (!pending.length) return null
  const { text: norm } = normalizeNumberWords(message)
  const t = norm.toLowerCase()
  const plan: CorrectionPlan = { remove: [], edits: [], cancelAll: false, summary: [] }

  // Cancelar tudo.
  if (/\b(?:cancela|cancelar|esquece|esquecer|deixa\s+pra\s+l[áa]|n[ãa]o\s+registra\s+(?:nada|isso\s+tudo))\b/.test(t)
    && !/\b(?:primeir|segund|terceir|[úu]ltim|s[óo]\s+)/.test(t)) {
    plan.cancelAll = true
    plan.summary.push('Descartei a proposta inteira.')
    return plan
  }

  let touched = false

  // Remoções: "remove a primeira", "não registra o salário", "tira o de 190"
  const removeRe = /\b(?:remove|remover|remova|tira|tirar|retira|retirar|apaga|apagar|exclui|excluir|descarta|descartar|n[ãa]o\s+(?:registra|registre|quero\s+registrar|salva))\b/i
  if (removeRe.test(t)) {
    const after = t.slice(t.search(removeRe))
    const target = resolveTarget(after, pending)
    if (target && 'id' in target) {
      plan.remove.push(target.id)
      const p = pending.find(x => x.id === target.id)!
      plan.summary.push(`Removi a ${describe(p.action)} da proposta.`)
      touched = true
    } else if (target && 'ambiguousAmong' in target) {
      return {
        ...plan,
        ambiguous: {
          question: 'Qual delas você quer remover?',
          options: target.ambiguousAmong.map(p => ({ label: describe(p.action), value: p.id })),
        },
      }
    }
  }

  const remaining = pending.filter(p => !plan.remove.includes(p.id))

  // Valor: "não foi 100, foi 80" · "troca o valor para 80" · "a segunda foi 190"
  // `(?:\s*mil)?` é essencial: "não foi 4 mil, foi 3.800" é como se fala.
  const MIL = String.raw`(?:\s*(mil))?`
  // Reforço no fim do conserto: "foi 100 MESMO", "era 80 SIM", "foi 90 no
  // total". Sem isso a frase não casava, caía no parser normal e virava uma
  // SEGUNDA despesa — com a primeira ainda confirmável logo acima.
  const REFORCO = String.raw`(?:\s*(?:mesmo|mesma|sim|isso|isso a[ií]|certo|exato|exatamente|redondo|cravado|ao\s+todo|no\s+total|s[oó]|apenas|apenas isso))?`
  const valueRe = new RegExp(
    String.raw`(?:n[ãa]o\s+(?:foi|era|é|e)\s*(?:r\$)?\s*${NUMBER}${MIL}\s*,?\s*(?:e|mas)?\s*(?:foi|era|é|e|sim)?\s*(?:r\$)?\s*${NUMBER}${MIL})` +
    String.raw`|(?:(?:troca|trocar|muda|mudar|altera|alterar|corrige|corrigir|ajusta|ajustar)\s+(?:o\s+)?valor\s+(?:para|pra|por|em)\s*(?:r\$)?\s*${NUMBER}${MIL})` +
    String.raw`|(?:(?:foi|era|é)\s*(?:r\$)?\s*${NUMBER}${MIL}\s*(?:reais)?${REFORCO}\s*$)` +
    // "Na verdade 80", "quer dizer 80 reais" — o conserto mais natural que
    // existe, e o único caminho que faltava reconhecer.
    String.raw`|(?:(?:na\s+verdade|na\s+real|quer\s+dizer|queria\s+dizer|ou\s+melhor|melhor\s+dizendo|corrigindo|errei|me\s+enganei|foi\s+mal)\b[^\d]{0,12}(?:r\$)?\s*${NUMBER}${MIL})` +
    // A mensagem inteira é um número: com a proposta na tela isso só pode ser
    // o valor certo. Sem proposta, `parseCorrection` nem é chamada.
    String.raw`|(?:^\s*(?:r\$)?\s*${NUMBER}${MIL}\s*(?:reais)?${REFORCO}\s*$)`,
    'i',
  )
  const vm = t.match(valueRe)
  if (vm) {
    // Pares [valor, "mil"]: 1/2 = antigo, 3/4 = novo, 5/6 e 7/8 = formas
    // curtas, 9/10 = "na verdade X", 11/12 = a mensagem inteira sendo o valor.
    const pick = (n: number, m: number) => (vm[n] ? parseMoney(vm[n]) * (vm[m] ? 1000 : 1) : NaN)
    const newValue = [pick(3, 4), pick(5, 6), pick(7, 8), pick(9, 10), pick(11, 12), pick(1, 2)].find(v => v > 0) ?? NaN
    if (newValue > 0) {
      const target = resolveTarget(t, remaining)
      if (target && 'id' in target) {
        const p = remaining.find(x => x.id === target.id)!
        const field = 'amount' in (p.action as any) ? 'amount'
          : 'total' in (p.action as any) ? 'total'
            : 'cost' in (p.action as any) ? 'cost' : 'amount'
        const was = (p.action as any)[field]
        if (was !== newValue) {
          plan.edits.push({ id: p.id, field, value: newValue, was })
          plan.summary.push(`Troquei o valor de ${fmtBRL(Number(was))} para ${fmtBRL(newValue)}.`)
          touched = true
        }
      } else if (target && 'ambiguousAmong' in target) {
        return {
          ...plan,
          ambiguous: {
            question: `Qual lançamento passa a ser ${fmtBRL(newValue)}?`,
            options: target.ambiguousAmong.map(p => ({ label: describe(p.action), value: p.id })),
          },
        }
      }
    }
  }

  // PARCELAS: "e em 12x?", "muda pra 10 vezes". O follow-up mais comum depois
  // de uma compra parcelada — e o número de parcelas nunca é preço (invariante
  // 94): antes, a frase não casava com nada, caía no parser normal e voltava
  // como texto genérico de ajuda, com a compra ainda pendente na tela.
  //
  // Três travas: só com compra parcelada na proposta, só quando a mensagem NÃO
  // relata uma compra nova, e só quando o único número dito é a contagem.
  {
    const parcelaRe = /(?:^|\s)(?:e\s+)?(?:em|pra|para|por|de)?\s*(\d{1,2})\s*(?:x|vezes|parcelas)\b/i
    const pm = t.match(parcelaRe)
    const outroNumero = (t.match(/\d+(?:[.,]\d+)*/g) || []).length > 1
    const relataCompra = /\b(?:comprei|comprou|parcelei|passei|gastei|paguei|recebi)\b/i.test(t)
    if (pm && !outroNumero && !relataCompra) {
      const n = Number(pm[1])
      const alvo = remaining.find(p => 'installments' in (p.action as any))
      if (alvo && n >= 1 && n <= 60) {
        const was = (alvo.action as any).installments
        if (was !== n) {
          plan.edits.push({ id: alvo.id, field: 'installments', value: n, was })
          plan.summary.push(`Troquei para ${n}x.`)
          touched = true
        }
      }
    }
  }

  // Cartão: "era no Inter, não no Nubank" · "foi no Inter"
  if (caps.cardNames.length) {
    const cardHit = caps.cardNames.find(c => {
      // "pro/pra/para" são como se fala ("troca PRO inter"); sem eles a correção
      // de cartão só funcionava com "no/na/do/da".
      const re = new RegExp(String.raw`(?:^|\s)(?:no|na|pelo|pela|do|da|pro|pra|para|era|foi)\s+${normalizeName(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'i')
      return re.test(normalizeName(t))
    })
    if (cardHit) {
      for (const p of remaining) {
        if (!('cardName' in (p.action as any))) continue
        const was = (p.action as any).cardName
        if (normalizeName(was) === normalizeName(cardHit)) continue
        plan.edits.push({ id: p.id, field: 'cardName', value: cardHit, was })
        plan.summary.push(`Troquei o cartão para ${cardHit}.`)
        touched = true
        break
      }
    }
  }

  // Data: "era ontem, não hoje"
  const d = findDate(message, today)
  if (d && d.kind === 'date' && /\b(?:era|foi|na verdade|corrige|troca|muda)\b/.test(t)) {
    const target = resolveTarget(t, remaining)
    const ids = target && 'id' in target ? [target.id] : remaining.map(p => p.id)
    for (const id of ids) {
      const p = remaining.find(x => x.id === id)
      if (!p) continue
      const was = (p.action as any).date
      if (was === d.date) continue
      plan.edits.push({ id, field: 'date', value: d.date, was })
      touched = true
    }
    if (touched) plan.summary.push(`Ajustei a data para ${d.label}.`)
  }

  // Categoria: "muda pra lazer", "coloca em lazer", "a categoria é lazer", "era
  // lazer". Sem isto, "muda pra lazer" virava negação — "não registrei nada" —
  // e a proposta sumia; as outras formas caíam na ajuda. Só vale quando o nome
  // é de uma categoria do tipo do lançamento.
  {
    const cm = normalizeName(t).match(/^(?:(?:muda|mudar|troca|trocar|coloca|colocar|poe|bota|botar|passa|passar|joga|jogar|lanca|lancar)\s+(?:a\s+categoria\s+)?(?:pra|para|pro|em|na|no|como)|(?:a\s+)?categoria\s+(?:e|eh|era|foi|e\s+de)|era|e\s+de|foi\s+de)\s+([a-z][a-z\s]{2,30}?)\s*[.!?]*$/)
    if (cm) {
      const nome = cm[1].trim().replace(/s$/, '')
      const target = resolveTarget(t, remaining)
      const p = target && 'id' in target ? remaining.find(x => x.id === target.id) : undefined
      const kind = p?.action.kind
      const cat = (kind === 'expense' || kind === 'income')
        ? caps.categories.find(c => c.type === kind && normalizeName(c.name).replace(/s$/, '') === nome)
        : undefined
      if (p && cat && (p.action as any).category !== cat.id) {
        plan.edits.push({ id: p.id, field: 'category', value: cat.id, was: (p.action as any).category })
        plan.summary.push(`Passei para a categoria ${cat.name}.`)
        touched = true
      } else if (p && cat) {
        // Já está nela: dizer isso, e a proposta fica — sem esta volta, a
        // frase caía na negação e a proposta sumia.
        plan.summary.push(`Já está na categoria ${cat.name}.`)
        touched = true
      }
    }
  }

  // Origem: "e era da casa 2", "foi do cliente João", "veio da Empresa X". Caía
  // na negação ("isso não aconteceu") e a proposta sumia. Só origem explícita
  // (`extractOrigins`): substantivo de fonte + identificador, ou nome próprio.
  if (!touched && /^(?:e\s+)?(?:era|foi|e|é|veio|vem|vieram)\s+d[ao]s?\s/.test(t)) {
    const origem = extractOrigins(message.trim())[0]?.value
    const target = origem ? resolveTarget(t, remaining) : null
    const p = target && 'id' in target ? remaining.find(x => x.id === target.id) : undefined
    if (origem && p && (p.action.kind === 'income' || p.action.kind === 'expense')) {
      const nova = origem.replace(/(^|\s)(\S)/g, (_, s: string, c: string) => s + c.toUpperCase())
      if (normalizeName((p.action as any).origin || '') !== normalizeName(nova)) {
        plan.edits.push({ id: p.id, field: 'origin', value: nova, was: (p.action as any).origin })
        plan.summary.push(`Anotei a origem: ${nova}.`)
      }
      touched = true
    }
  }

  // Lugar/descrição: "foi na padaria", "era no açougue", "a descrição é feira".
  // Caía na ajuda. Cartão ("foi no Inter"), data ("foi ontem") e categoria
  // ("era lazer") já foram lidos acima e têm prioridade.
  if (!touched) {
    // O prefixo de conserto ("na verdade foi na padaria") é o jeito mais comum
    // de dizer; sem ele a frase não casava e a resposta era "não peguei o quê".
    const semPrefixo = t.replace(/^(?:na\s+verdade|na\s+real|ou\s+melhor|quer\s+dizer|pensando\s+bem)\s*,?\s*/, '')
    const dm = semPrefixo.match(/^(?:(?:foi|era)\s+(?:n[oa]s?|em)|(?:a\s+)?descri[cç][aã]o\s+(?:[ée]|era)|(?:muda|troca)\s+(?:a\s+descri[cç][aã]o|o\s+nome)\s+(?:pra|para))\s+([a-zà-úç][a-zà-úç0-9\s]{1,40}?)\s*[.!?]*$/)
    const target = dm ? resolveTarget(t, remaining) : null
    const p = target && 'id' in target ? remaining.find(x => x.id === target.id) : undefined
    if (dm && p && (p.action.kind === 'expense' || p.action.kind === 'income')) {
      const lugar = dm[1].trim()
      const nova = lugar.charAt(0).toUpperCase() + lugar.slice(1)
      plan.edits.push({ id: p.id, field: 'description', value: nova, was: (p.action as any).description })
      // O lugar novo pode dizer a categoria ("padaria" é comida).
      const cat = guessCategory(lugar, p.action.kind)
      if (cat && cat !== (p.action as any).category) plan.edits.push({ id: p.id, field: 'category', value: cat, was: (p.action as any).category })
      plan.summary.push(`Troquei para ${nova}.`)
      touched = true
    }
  }

  // Ambiguidade do gás resolvida por correção: "é GNV, não gás de cozinha"
  if (/\b[ée]\s+gnv\b/i.test(t) || /\bgnv\b.*\bn[ãa]o\b/i.test(t)) {
    for (const p of remaining) {
      if (p.action.kind !== 'expense') continue
      if (!/g[áa]s/i.test((p.action as any).description || '')) continue
      plan.edits.push({ id: p.id, field: 'category', value: 'combustivel', was: (p.action as any).category })
      plan.edits.push({ id: p.id, field: 'description', value: 'GNV', was: (p.action as any).description })
      plan.summary.push('Passei esse lançamento para GNV.')
      touched = true
      break
    }
  }

  return touched ? plan : null
}

/** Aplica o plano de correção sobre a proposta, sem tocar em nada salvo. */
export function applyCorrection(
  pending: AssistantCandidateAction[],
  plan: CorrectionPlan,
): AssistantCandidateAction[] {
  if (plan.cancelAll) return []
  let out = pending.filter(p => !plan.remove.includes(p.id))
  for (const e of plan.edits) {
    out = out.map(p => {
      if (p.id !== e.id) return p
      if (p.action.kind === 'card-payment' && e.field === 'cardName') {
        const { cardId, ...payment } = p.action
        return { ...p, action: { ...payment, cardName: e.value } }
      }
      return { ...p, action: { ...p.action, [e.field]: e.value } }
    })
  }
  return out
}
