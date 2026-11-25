// Correções, negações e referências ANTES da confirmação.
//
// "não foi 100, foi 80", "remove a primeira", "era no Inter", "é GNV":
// tudo isso modifica a PROPOSTA pendente. Nada aqui toca em dado já salvo —
// alterar um lançamento existente é um fluxo próprio, com confirmação separada.

import type { ParsedAction } from '../models/types'
import { validateAction, type AssistantCandidateAction, type AssistantCapabilities, type AssistantClarification } from './contracts'
import { fmtBRL, fmtHours, fmtNum, nowTime, parseMoney, todayISO } from '../utils/format'
import { normalizeNumberWords } from './numbers'
import { brDate, dateInAnswer, findDate } from './dates'
import { explicitSpokenPayer, extractOrigins, looksLikeQuestion, revisedAction } from './clauses'
import { normalizeName } from '../utils/text'
import { guessCategory } from '../data/categories'
import { COMPOUND_DURATION, elapsedMinutes, spokenClock } from './semantic/clock'

const NUMBER = String.raw`(\d+(?:[.,]\d+)*)(?!\d|[.,]\d)`
const MONEY_START = new RegExp(String.raw`^(?:r\$\s*)?${NUMBER}(?:\s+reais?\b)?`, 'i')

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
  ambiguous?: AssistantClarification
  /** Relato afirmativo separado de uma negativa sobre outro lançamento. */
  independentStatement?: string
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
      if (nome === '99') return new RegExp(`\\b${APP_99}\\b`).test(t)
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

function correctionLabel(candidate: AssistantCandidateAction, index: number): string {
  const { action } = candidate
  const detail = ('description' in action && action.description) || ('origin' in action && action.origin)
  return `${index + 1}. ${describe(action)}${detail ? ` · ${detail}` : ''}`
}

const DENIED_KINDS = new Map<string, ParsedAction['kind'][]>([
  ['gastei', ['expense', 'fuel', 'maintenance']], ['paguei', ['expense', 'card-payment', 'recurring-confirm']],
  ['recebi', ['income']], ['ganhei', ['income']], ['comprei', ['expense', 'card-purchase']],
  ['abasteci', ['fuel']], ['guardei', ['saving', 'goal-deposit']],
])
const JUST_A_PLAN = /^(?:(?:nao|n)\s*,?\s*)?(?:(?:(?:isso\s+tudo\s+)?(?:foi|era)\s+)?(?:so|apenas)\s+(?:(?:um|uma)\s+)?(?:orcamento|simulacao|cotacao|teste|exemplo|previsao)|(?:nao|nem|n)\s+aconteceu)[.!]*$/
const DENIED_EVENT = new RegExp(String.raw`^(?:eu\s+|ainda\s+){0,2}(?:nao|nem|n)\s*,?\s*(?:eu\s+)?(${[...DENIED_KINDS.keys()].join('|')})\b\s*(.*?)\s*[.!]*$`)
const EXPLICIT_REFERENCE = /^(?:nada\s+)?(?:na|no|nas|nos|em|de|da|do|com|por)\s+(.+)$/

/**
 * "A da 99 foi 150", "tira a 99": o nome da plataforma é um número, e o
 * leitor de correção o tomava por valor — a proposta inteira era trocada por
 * uma despesa de R$ 150. Com uma receita da 99 na tela, o nome vira um
 * marcador antes da leitura.
 */
const APP_99 = 'appzz'

function matchesReference(action: ParsedAction, reference: string): boolean {
  const details = [('description' in action && action.description), ('origin' in action && action.origin),
    ('item' in action && action.item), ('cardName' in action && action.cardName)]
  return details.some(value => value && (normalizeName(value) === reference || (normalizeName(value) === '99' && reference === APP_99)))
    || (action.kind === 'fuel' && /^(?:gasolina|etanol|diesel|gnv|combustivel)$/.test(reference))
}

function withdrawDeniedProposal(message: string, pending: AssistantCandidateAction[], today: string, plan: CorrectionPlan): CorrectionPlan | null {
  const text = normalizeName(message)
  const justAPlan = JUST_A_PLAN.test(text)
  const denial = text.match(DENIED_EVENT)
  if (!justAPlan && !denial) return null

  let targets = pending
  let all = /^isso\s+tudo\b/.test(text)
  if (denial) {
    const [, verb, original] = denial
    const date = findDate(original, today)
    if (date && date.kind !== 'date') return null
    const body = (date ? `${original.slice(0, date.start)} ${original.slice(date.end)}` : original).trim()
    const amount = body.match(MONEY_START)
    const value = amount ? parseMoney(amount[1]) : undefined
    const detail = body.slice(amount?.[0].length ?? 0).trim()
    const reference = detail.match(EXPLICIT_REFERENCE)?.[1]
    if (detail && !reference && !/^(?:nada|isso|esse valor|essa quantia)$/.test(detail)) return null
    all = detail === 'nada' && value === undefined
    targets = pending.filter(({ action }) => {
      if (!DENIED_KINDS.get(verb)?.includes(action.kind)) return false
      if (value !== undefined && !(Math.abs((amountOf(action) ?? NaN) - value) < 0.005)) return false
      if (date && date.kind === 'date' && ('date' in action ? action.date || today : today) !== date.date) return false
      if (!reference) return true
      return matchesReference(action, reference)
    })
  }
  if (!targets.length) return null
  if (!all && targets.length > 1) {
    plan.ambiguous = {
      field: 'pending-correction', question: 'Qual lançamento você quer retirar da proposta?',
      options: targets.map((target, index) => ({ value: String(index + 1), label: correctionLabel(target, index),
        actions: pending.filter(p => p.id !== target.id).map(p => p.action) })),
    }
    return plan
  }
  plan.remove = targets.map(p => p.id)
  plan.summary.push(targets.length === pending.length ? 'Descartei a proposta.' : 'Retirei da proposta o que não aconteceu.')
  return plan
}

/** Separa o que foi negado do que efetivamente deve entrar na proposta. */
function contrast(message: string): { rejected: string; affirmed: string; verb?: string; kind?: 'income' | 'expense' } | undefined {
  const repeated = message.match(/^\s*(?:n[ãa]o|[nñ])\s+(gastei|paguei|recebi|ganhei)\s+(.+?)(?:\s*[,;]\s*(?:mas\s+)?|\s+mas\s+)\1\s+(.+)$/i)
  if (repeated) return { rejected: repeated[2], affirmed: repeated[3], verb: repeated[1], kind: /^(?:recebi|ganhei)$/i.test(repeated[1]) ? 'income' : 'expense' }
  const front = message.match(/^\s*(?:n[ãa]o|[nñ])\s+(?:foi|era|fui)\s+(.+?)(?:\s*[,;.!—–]\s*|\s+)\s*(?:mas\s+)?(?:foi|era|fui)\s+(.+)$/i)
  if (front) return { rejected: front[1], affirmed: front[2] }
  const back = message.match(/^\s*(?:foi|era|fui)\s+(.+?)(?:\s*[,;.!—–]\s*|\s+(?:e\s+)?)\s*(?:n[ãa]o|[nñ])\s+(?:(?:foi|era|fui)\s+)?(.+)$/i)
  if (back) return { rejected: back[2], affirmed: back[1] }
  return undefined
}

function reviseContrast(action: ParsedAction, text: string, caps: AssistantCapabilities, today: string): ParsedAction | undefined {
  const affirmed = text.trim().replace(/[.!]+$/, '')
  const cardClause = affirmed.match(/^(?:(.+?)\s+e\s+(?:era|foi)\s+)?(?:no|na|pelo|pela)\s+(.+)$/i)
  if (cardClause && 'cardName' in action) {
    const cardName = caps.cardNames.find(name => normalizeName(name) === normalizeName(cardClause[2]))
    if (!cardName) return undefined
    const updated = cardClause[1] ? revisedAction(action, cardClause[1], today) : action
    if (updated?.kind === 'card-payment' && normalizeName(updated.cardName) !== normalizeName(cardName)) {
      const { cardId, expectedPending, ...payment } = updated
      return { ...payment, cardName }
    }
    return updated && 'cardName' in updated ? { ...updated, cardName } : undefined
  }

  const date = findDate(affirmed, today)
  if (date?.kind === 'date' && affirmed.slice(date.end).trim() === ''
    && /^(?:(?:no|na|em)\s+)?$/i.test(affirmed.slice(0, date.start))) {
    return revisedAction(action, date.text, today)
  }

  const amount = affirmed.match(MONEY_START)
  let details = affirmed.slice(amount?.[0].length ?? 0).trim()
  const restatement = details.match(/^que\s+(?:eu\s+)?(gastei|paguei|recebi|ganhei)\b/i)
  if (restatement) {
    const kind = /^(?:recebi|ganhei)$/i.test(restatement[1]) ? 'income' : 'expense'
    if (kind !== action.kind) return undefined
    details = details.slice(restatement[0].length).trim()
  }
  const place = /^(?:n[oa]s?|em|d[ao]s?)\s+\S/i.test(details)
  if (!place && (!amount || details && !date)) return undefined
  if (/\bou\b|(?:[,;]|\be)\s*(?:r\$\s*)?\d/i.test(details)) return undefined

  const body = [amount?.[0], details].filter(Boolean).join(' ')
  const updated = revisedAction(action, body, today)
  if (action.kind === 'expense' && updated?.kind === 'expense') {
    return { ...updated, origin: updated.origin ?? action.origin, category: updated.category ?? action.category }
  }
  return updated
}

function revisionChoices(
  text: string, targets: AssistantCandidateAction[], pending: AssistantCandidateAction[], caps: AssistantCapabilities, today: string,
): AssistantClarification | undefined {
  const parts = text.trim().replace(/[.!?]+$/, '').split(/(?:\s*,\s*|\s+)ou\s+(?:talvez\s+)?/i)
  if (parts.length < 2) return undefined
  const dayList = /^dia\s+\d{1,2}$/i.test(parts[0])
  const amounts = parts.map(part => part.match(MONEY_START))
  const dates = parts.map(part => dateInAnswer(dayList && /^\d{1,2}$/.test(part) ? `dia ${part}` : part, today))
  const origins = parts.map(part => /^d[ao]s?\s/i.test(part) ? extractOrigins(part)[0]?.value : undefined)
  const isDate = dates.every(Boolean)
  const isAmount = amounts.every(Boolean) && !isDate
  const isOrigin = origins.every(Boolean)
  const [target] = targets
  if (!isAmount && !isDate && !isOrigin) return undefined
  if (targets.length !== 1 || (target.action.kind === 'recurring-confirm' && target.action.transactionId)) {
    return { question: 'Qual lançamento você quer corrigir? Diga também o dado exato que devo usar.' }
  }

  let field: string
  let question: string
  let choices: { text: string; value: string; label: string }[]
  if (isAmount) {
    field = 'pending-correction-amount'
    question = 'Qual foi o valor exato?'
    const detail = parts.every((part, i) => i === parts.length - 1 || part === amounts[i]?.[0])
      ? parts[parts.length - 1].slice(amounts[parts.length - 1]?.[0].length) : ''
    choices = amounts.flatMap((match, i) => {
      if (!match) return []
      const amount = parseMoney(match[1])
      return [{ text: parts[i] === match[0] ? parts[i] + detail : parts[i], value: String(amount), label: fmtBRL(amount) }]
    })
  } else if (isDate) {
    field = 'pending-correction-date'
    question = 'Em qual dessas datas aconteceu?'
    choices = dates.flatMap(date => date?.kind === 'date' ? [{ text: date.date, value: date.date, label: brDate(date.date) }] : [])
  } else {
    field = 'pending-correction-origin'
    question = 'Qual foi a origem?'
    choices = origins.flatMap((name, i) => name ? [{ text: parts[i], value: name, label: name }] : [])
  }

  const options = choices.flatMap(choice => {
    const revision = reviseContrast(target.action, choice.text, caps, today)
    const checked = revision && validateAction(revision, caps, today)
    return checked?.ok ? [{ value: choice.value, label: choice.label,
      actions: pending.map(p => p.id === target.id ? checked.action : p.action) }] : []
  })
  const unique = [...new Map(options.map(option => [option.value, option])).values()]
  return options.length === parts.length && unique.length > 1 ? { field, question, options: unique } : { question }
}

function parseContrastCorrection(
  message: string, pending: AssistantCandidateAction[], caps: AssistantCapabilities, today: string, plan: CorrectionPlan,
): CorrectionPlan | null {
  const parts = contrast(message)
  if (!parts || looksLikeQuestion(message)) return null
  const { rejected, affirmed, kind, verb } = parts
  const matchingKind = kind ? pending.filter(p => p.action.kind === kind) : pending
  if (!matchingKind.length) return null
  const amount = rejected.match(MONEY_START)
  const oldValue = amount ? parseMoney(amount[1]) : undefined
  const amountHits = oldValue === undefined ? matchingKind : matchingKind.filter(p => Math.abs((amountOf(p.action) ?? NaN) - oldValue) < 0.005)
  const date = findDate(rejected, today)
  const withoutDate = date ? `${rejected.slice(0, date.start)} ${rejected.slice(date.end)}` : rejected
  const reference = normalizeName(withoutDate.replace(MONEY_START, '')).replace(/[,\s]+$/, '').match(EXPLICIT_REFERENCE)?.[1]
  // Quando só a data estava em discussão, a proposta única sem dia explícito
  // pode receber a data nova. Valor, local ou verbo comparam o fato inteiro.
  const [sole] = amountHits
  const dateIsReference = date && (verb || oldValue !== undefined || reference || amountHits.length !== 1
    || (sole && 'date' in sole.action && sole.action.date))
  const pool = amountHits.filter(({ action }) => (!dateIsReference || (date.kind === 'date' && ('date' in action ? action.date || today : today) === date.date))
    && (!reference || matchesReference(action, reference)))
  if (!pool.length && (dateIsReference || reference) && amountHits.length) {
    if (verb) plan.independentStatement = `${verb} ${affirmed}`
    else plan.ambiguous = { question: 'Qual lançamento da proposta você quer corrigir? O local ou a data mencionada não coincide com a proposta aberta.' }
    return plan
  }
  if (oldValue !== undefined && !amountHits.length) {
    plan.ambiguous = { question: `Não há proposta de ${fmtBRL(oldValue)} nesta conversa. Qual lançamento você quer corrigir?` }
    return plan
  }

  // A referência vem do trecho rejeitado. O novo lugar pode ser o nome de
  // outro registro na mesma proposta, e nesse caso não deve virar o alvo.
  const target = resolveTarget(rejected, pool)
  const targets = !target ? pool : 'id' in target ? pool.filter(p => p.id === target.id) : target.ambiguousAmong
  const alternatives = revisionChoices(affirmed, targets, pending, caps, today)
  if (alternatives) {
    plan.ambiguous = alternatives
    return plan
  }
  const edits = targets.flatMap(p => {
    const revision = reviseContrast(p.action, affirmed, caps, today)
    const checked = revision && validateAction(revision, caps, today)
    return checked?.ok ? [{ id: p.id, action: checked.action }] : []
  })
  if (edits.length !== targets.length || !edits.length) {
    plan.ambiguous = { question: 'Qual é a correção exata? Diga o valor, a data ou o detalhe que devo trocar.' }
    return plan
  }
  if (edits.length > 1) {
    if (targets.some(({ action }) => action.kind === 'recurring-confirm' && action.transactionId)) {
      plan.ambiguous = { question: 'Há uma conta fixa vinculada nesta proposta. Diga qual lançamento e qual valor você quer corrigir.' }
      return plan
    }
    plan.ambiguous = {
      field: 'pending-correction',
      question: 'Qual lançamento você quer corrigir?',
      options: edits.map((edit, i) => ({ value: String(i + 1), label: correctionLabel(targets[i], i),
        actions: pending.map(p => p.id === edit.id ? edit.action : p.action) })),
    }
    return plan
  }

  const [{ id, action }] = edits
  const [{ action: original }] = targets
  const before = original as unknown as Record<string, unknown>
  const after = action as unknown as Record<string, unknown>
  for (const field of ['amount', 'total', 'cost', 'description', 'category', 'date', 'origin', 'cardName', 'is99']) {
    if (before[field] !== after[field]) plan.edits.push({ id, field, value: after[field], was: before[field] })
  }
  plan.summary.push(plan.edits.length ? 'Corrigi a proposta.' : 'A proposta já estava com esses dados.')
  return plan
}

function parseClockCorrection(message: string, pending: AssistantCandidateAction[], today: string, plan: CorrectionPlan): boolean {
  const body = message.match(/^\s*(?:(?:na\s+(?:real|verdade)|ops)[\s,:]+)?(?:(?:o\s+)?hor[áa]rio\s+)?(?:foi|era)\s+(.+)$/i)?.[1]
  if (!body || looksLikeQuestion(message)) return false
  const clock = spokenClock(body)
  if (!clock.time && !clock.invalid && !clock.range) return false
  const reference = clock.remaining.replace(/^[,\s]+|[,.!\s]+$/g, '')
  const date = reference ? dateInAnswer(reference, today) : undefined
  if (reference && !date) return false
  if ((reference && date?.kind !== 'date') || clock.invalid || !clock.time) {
    plan.ambiguous = { question: 'Qual foi o dia e o horário exatos desse lançamento?' }
    return true
  }
  const time = clock.time
  const targets = pending.flatMap(candidate => {
    const { action } = candidate
    if (action.kind !== 'expense' && action.kind !== 'income') return []
    const day = date?.kind === 'date' ? date.date : action.date
    return [{ candidate, action, day }]
  })
  if (!targets.length) {
    plan.ambiguous = { question: 'O assistente só grava horário informado em entradas e despesas avulsas. Qual lançamento você quer alterar?' }
    return true
  }
  const [target] = targets
  if (today === todayISO() && time > nowTime() && targets.some(t => !t.day || t.day === today)) {
    plan.ambiguous = { question: `O horário ${time} ainda não chegou hoje. Diga o dia e o horário em que aconteceu.` }
    return true
  }
  if (targets.length > 1) {
    plan.ambiguous = { field: 'pending-correction', question: `Qual lançamento aconteceu às ${time}?`,
      options: targets.map(({ candidate, action, day }, i) => ({ value: String(i + 1), label: correctionLabel(candidate, i),
        actions: pending.map(p => p.id === candidate.id ? { ...action, ...(day ? { date: day } : {}), time } : p.action) })) }
    return true
  }
  if (target.action.time !== time) plan.edits.push({ id: target.candidate.id, field: 'time', value: time, was: target.action.time })
  if (target.day && target.day !== target.action.date) plan.edits.push({ id: target.candidate.id, field: 'date', value: target.day, was: target.action.date })
  plan.summary.push(`Horário da proposta às ${time}.`)
  return true
}

const DRIVER_APP = String.raw`(?<app>ubb?er|99|${APP_99}|in\s*driver?)\b`
const DRIVER_REMOVE = new RegExp(String.raw`^(?:tira|retira|remove|exclui|apaga)\s+(?:[ao]\s+)?(?:d[ao]\s+)?${DRIVER_APP}(?<when>.*)$`)
const DRIVER_CORRECTION_MONEY = (key: string) => String.raw`(?:r\$\s*)?(?<${key}>\d+(?:[.,]\d+)*)(?:\s+reais?)?`
const DRIVER_PREVIOUS_AMOUNT = String.raw`(?:(?:,\s*|\s+e\s+)nao\s+(?:foi\s+)?${DRIVER_CORRECTION_MONEY('previous')})?`
const DRIVER_AMOUNT = new RegExp(String.raw`^(?:[ao]\s+)?(?:d[aeo]\s+|n[ao]\s+)?${DRIVER_APP}(?<when>.*?)\s+(?:foi|era|deu)\s+${DRIVER_CORRECTION_MONEY('amount')}${DRIVER_PREVIOUS_AMOUNT}$`)
const DRIVER_AMOUNT_FIRST = new RegExp(String.raw`^(?:foi|foram|era|eram)\s+${DRIVER_CORRECTION_MONEY('amount')},?\s+(?:d[aeo]|n[ao]|pel[ao])\s+${DRIVER_APP}(?<when>.*?)${DRIVER_PREVIOUS_AMOUNT}$`)
const DRIVER_AMOUNT_COMMAND = new RegExp(String.raw`^(?:troca|muda|ajusta|corrige|atualiza)\s+(?:[ao]\s+)?(?:d[ao]\s+)?${DRIVER_APP}(?<when>.*?)\s+(?:pra|para)\s+${DRIVER_CORRECTION_MONEY('amount')}$`)
const DRIVER_SOURCE = new RegExp(String.raw`^(?:foi|era|veio)\s+(?:d[ao]|n[ao]|pel[ao])\s+${DRIVER_APP}$`)
const WORK_MEASURE = /^\s*(?:n[ãa]o[\s,]+)?(?:(?:na\s+(?:real|verdade)|ops|ou\s+melhor)[\s,]+)?(?:foram|foi|era|eram|s[ãa]o)?\s*(\d+(?:[.,]\d+)?)\s*(kms?|quil[oô]metros?|h|hrs?|horas?|corridas?|viagens?)\s*(?:e\s+n[ãa]o\s+\d+(?:[.,]\d+)?\s*\S*)?\s*$/
const WORK_DURATION = new RegExp(String.raw`^(?:(?:na\s+(?:real|verdade)|ops|ou\s+melhor)[\s,]+)?(?:foram|foi|era|eram|sao)\s+(${COMPOUND_DURATION})$`)
const DROP_VERB = String.raw`(?:tirar?|retirar?|remover?|excluir?|apagar?|sem)`
const WORK_MEASURE_NAME = String.raw`(?:horas?|hrs?|kms?|quilometros?|distancia|quilometragem|viagens?|numero\s+de\s+corridas?)`
const DROP_WORK_MEASURE = new RegExp(String.raw`^${DROP_VERB}\s+(?:so\s+)?(?:[ao]s?\s+)?(?:(\d+(?:[.,]\d+)?)\s*)?(${WORK_MEASURE_NAME})(?:\s+de)?(?:\s*,\s*(?:mandei errado|me enganei|foi erro))?(?:\s+mas\s+mantem\s+(?:[ao]s?\s+)?(${WORK_MEASURE_NAME}))?$`)
const workMeasureField = (word: string) => /^(?:hor|hr)/.test(word) ? 'hours' : /^(?:via|num)/.test(word) ? 'trips' : 'km'

function removePendingWorkMeasure(text: string, pending: AssistantCandidateAction[], today: string, plan: CorrectionPlan): CorrectionPlan | undefined {
  const date = findDate(text, today)
  const body = date ? (text.slice(0, date.start) + text.slice(date.end)).trim() : text
  const drop = body.match(DROP_WORK_MEASURE)
  if (!drop) return undefined
  const field = workMeasureField(drop[2])
  if (drop[3] && workMeasureField(drop[3]) === field) {
    plan.ambiguous = { question: 'Você quer manter ou retirar essa medida da proposta?' }
    return plan
  }
  const label = { hours: 'as horas', km: 'a distância', trips: 'o número de viagens' }[field]
  const targets = pending.flatMap(item => {
    const { action } = item
    if (action.kind !== 'work') return []
    const oldValue = action[field]
    if (oldValue === undefined || (drop[1] && parseMoney(drop[1]) !== oldValue)
      || (date && (date.kind !== 'date' || (action.date || today) !== date.date))) return []
    const updated = { ...action }
    delete updated[field]
    const hasOtherMeasures = updated.km !== undefined || updated.hours !== undefined || updated.trips !== undefined
    return [{ item, updated, hasOtherMeasures, oldValue }]
  })
  if (!targets.length) {
    plan.ambiguous = { question: 'Essa medida não está na proposta com os dados indicados. Qual item você quer alterar?' }
  } else if (targets.length > 1) {
    plan.ambiguous = { field: 'pending-correction', question: `De qual jornada você quer retirar ${label}?`,
      options: targets.map(({ item, updated, hasOtherMeasures }, i) => ({ value: String(i + 1),
        label: `${i + 1}. Jornada de ${brDate(updated.date || today)}`,
        actions: pending.flatMap(p => p.id !== item.id ? [p.action] : hasOtherMeasures ? [updated] : []),
      })) }
  } else {
    const { item, hasOtherMeasures, oldValue } = targets[0]
    if (hasOtherMeasures) plan.edits.push({ id: item.id, field, value: undefined, was: oldValue })
    else plan.remove.push(item.id)
    plan.summary.push(`Retirei ${label} da proposta.`)
  }
  return plan
}

const FUEL_TYPES = String.raw`(?:gasolina(?:\s+(?:aditivada|comum))?|etanol|alcool|diesel|gnv)`
const FUEL_TARGET = String.raw`(?:[oa]\s+)?(?:de\s+)?(?:(?<fuel>${FUEL_TYPES})|combustivel|abastecimento)`
const DROP_FUEL = new RegExp(String.raw`^${DROP_VERB}\s+(?:so\s+)?${FUEL_TARGET}(?:\s+so)?$`)
const FUEL_TYPE_COMMAND = new RegExp(String.raw`^(?:troca|muda|ajusta|corrige|atualiza)\s+(?:o\s+tipo\s+d[eo]\s+)?${FUEL_TARGET}\s+(?:pra|para)\s+(?<next>${FUEL_TYPES})$`)
const FUEL_TYPE_REPORT = new RegExp(String.raw`^(?:(?:nao\s*,\s*)?(?:foi|era|e)\s+)?(?:de\s+)?(?<next>${FUEL_TYPES})(?:(?:,\s*|\s+e\s+)nao\s+(?<fuel>${FUEL_TYPES}))?$`)
const FUEL_AMOUNT = new RegExp(String.raw`^${FUEL_TARGET}\s+(?:saiu|foi|era|deu|custou)\s+${DRIVER_CORRECTION_MONEY('amount')}${DRIVER_PREVIOUS_AMOUNT}$`)
const FUEL_DATE = new RegExp(String.raw`^${FUEL_TARGET}\s+(?:foi|era)$`)

function canonicalFuel(word: string): string {
  return word === 'gnv' ? 'GNV' : word === 'alcool' ? 'Etanol' : word[0].toUpperCase() + word.slice(1)
}

function correctPendingFuel(text: string, pending: AssistantCandidateAction[], caps: AssistantCapabilities, today: string, plan: CorrectionPlan) {
  if (!/\b(?:abastecimento|combustivel|gasolina|etanol|alcool|diesel|gnv)\b/.test(text) || !pending.some(p => p.action.kind === 'fuel')) return undefined
  const date = findDate(text, today)
  const body = date ? (text.slice(0, date.start).trimEnd().replace(/\s+(?:d[eo]|no)$/, '') + ' ' + text.slice(date.end)).trim() : text
  const remove = body.match(DROP_FUEL)
  const type = body.match(FUEL_TYPE_COMMAND) || body.match(FUEL_TYPE_REPORT)
  const amount = body.match(FUEL_AMOUNT)
  const dateEdit = date && body.match(FUEL_DATE)
  const matched = remove || type || amount || dateEdit
  if (!matched) return undefined
  const { fuel, next, previous } = matched.groups
  const field = type ? 'fuelType' : amount ? 'amount' : 'date'
  const value = type ? canonicalFuel(next) : amount ? parseMoney(amount.groups.amount) : date?.kind === 'date' ? date.date : undefined
  const targets = pending.flatMap(item => {
    const { action } = item
    if (action.kind !== 'fuel' || (fuel && normalizeName(action.fuelType || 'Gasolina') !== normalizeName(canonicalFuel(fuel)))
      || (previous && action.amount !== parseMoney(previous))
      || (date && !dateEdit && (date.kind !== 'date' || (action.date || today) !== date.date))) return []
    return [{ item, action }]
  })
  if (!targets.length) {
    plan.ambiguous = { question: 'Não encontrei um abastecimento com esses dados na proposta. Qual item você quer alterar?' }
    return plan
  }
  const revise = ({ action }: typeof targets[number]): ParsedAction => ({ ...action, [field]: value })
  if (!remove && (value === undefined || targets.some(target => !validateAction(revise(target), caps, today).ok))) {
    plan.ambiguous = { question: 'Confira o valor ou a data desse abastecimento e diga o dado correto.' }
    return plan
  }
  if (targets.length > 1) {
    plan.ambiguous = { field: 'pending-correction', question: `Qual abastecimento quer ${remove ? 'retirar' : 'corrigir'}?`,
      options: targets.map((target, i) => ({ value: String(i + 1),
        label: `${correctionLabel(target.item, i)}${target.action.fuelType ? ` · ${target.action.fuelType}` : ''} · ${brDate(target.action.date || today)}`,
        actions: pending.flatMap(p => p.id !== target.item.id ? [p.action] : remove ? [] : [revise(target)]),
      })) }
    return plan
  }
  const [target] = targets
  if (remove) {
    plan.remove.push(target.item.id)
    plan.summary.push('Retirei o abastecimento da proposta.')
  } else {
    plan.edits.push({ id: target.item.id, field, value, was: target.action[field] })
    if (type) plan.summary.push(`Anotei o tipo de combustível: ${value}.`)
    else if (amount) plan.summary.push(`Atualizei o abastecimento para ${fmtBRL(value as number)}.`)
    else plan.summary.push(`Ajustei a data do abastecimento para ${brDate(value as string)}.`)
  }
  return plan
}

function readPendingWorkMeasure(text: string): { field: 'hours' | 'km' | 'trips'; value: number } | undefined {
  const namedHours = text.match(/^(?:(?:s|ss|sim)\s*,\s*)?(?:as\s+)?horas\s+(?:foram|era|eram|sao)\s+(.+)$/)?.[1]
  if (namedHours && /^\d+(?:[.,]\d+)?$/.test(namedHours)) return { field: 'hours', value: parseMoney(namedHours) }
  const duration = namedHours?.replace(/^(\d{1,2}|\p{L}+)(?=\s+e\s+)/u, '$1 horas') || text.match(WORK_DURATION)?.[1]
  if (duration) {
    const minutes = elapsedMinutes(duration)
    if (minutes !== undefined) return { field: 'hours', value: minutes / 60 }
  }
  const measure = text.match(WORK_MEASURE)
  if (!measure) return undefined
  const field = /^(?:km|quil)/.test(measure[2]) ? 'km' : /^(?:corrida|viage)/.test(measure[2]) ? 'trips' : 'hours'
  return { field, value: parseMoney(measure[1]) }
}

function correctDriverProposal(message: string, pending: AssistantCandidateAction[], caps: AssistantCapabilities, today: string,
  plan: CorrectionPlan): CorrectionPlan | null {
  const text = normalizeName(message).replace(/[.!]+$/, '').trim()
  if (!caps.isDriver || text.includes('?')) return null
  const removal = removePendingWorkMeasure(text, pending, today, plan)
  if (removal) return removal
  const fuel = correctPendingFuel(text, pending, caps, today, plan)
  if (fuel) return fuel
  const source = pending.length > 1 && text.match(DRIVER_SOURCE)?.groups.app
  if (source) {
    const rides = pending.filter(p => p.action.kind === 'income' && p.action.category === 'corridas')
    if (rides.length > 1) {
      plan.ambiguous = { question: 'Qual receita de corridas você quer corrigir? Diga o valor atual e a plataforma certa.' }
      return plan
    }
    const [ride] = rides
    if (ride?.action.kind === 'income') {
      const revision = revisedAction(ride.action, `da ${source === APP_99 ? '99' : source === 'ubber' ? 'Uber' : source}`, today)
      if (revision?.kind !== 'income' || !validateAction(revision, caps, today).ok) return null
      for (const field of ['description', 'origin', 'is99'] as const) {
        if (ride.action[field] !== revision[field]) plan.edits.push({ id: ride.id, field, value: revision[field], was: ride.action[field] })
      }
      plan.summary.push(plan.edits.length ? `Atualizei a plataforma para ${revision.description}.` : 'Essa receita já está com a plataforma informada.')
      return plan
    }
  }
  const compound = text.match(/^(.+?)\s*,?\s+e\s+(?:bota|poe|coloca|atualiza(?:\s+para)?)\s+(.+)$/)
  if (compound && DRIVER_REMOVE.test(compound[1]) && WORK_MEASURE.test(compound[2])) {
    const blank = { ...plan, edits: [], remove: [], summary: [] }
    const removal = correctDriverProposal(compound[1], pending, caps, today, blank)
    const work = correctDriverProposal(compound[2], pending, caps, today, plan)
    if (!removal?.remove.length || !work?.edits.length) {
      return { ...blank, remove: [], summary: [], ambiguous: {
        question: 'Qual receita quer retirar e qual jornada quer corrigir? Pode indicar os dias ou mandar cada correção separadamente.',
      } }
    }
    return { ...work, remove: removal.remove, summary: [...removal.summary, ...work.summary] }
  }
  const remove = text.match(DRIVER_REMOVE)
  const changeApp = remove ? null : text.match(DRIVER_AMOUNT) || text.match(DRIVER_AMOUNT_FIRST) || text.match(DRIVER_AMOUNT_COMMAND)
  const selector = remove || changeApp
  let targets = pending.filter(p => p.action.kind === 'work' || p.action.kind === 'edit-work-hours')
  if (!selector && !targets.length) return null
  const targetText = selector ? selector.groups.when.trim() : text
  const date = findDate(targetText, today)
  const withoutDate = (date ? targetText.slice(0, date.start) + ' ' + targetText.slice(date.end) : targetText).trim()
  if (selector && withoutDate && (!date || !/^(?:d[eo]|no dia|no|na)?$/.test(withoutDate))) return null
  const implicitHours = targets.length === 1 && pending.length === 1 && targets[0].action.kind === 'edit-work-hours'
    && /^(?:(?:na\s+(?:real|verdade)|ops|ou\s+melhor)[\s,]+|(?:foi|foram|era)\s+)\d+(?:[.,]\d+)?$/.test(withoutDate)
  const extraKm = /^e\s+\d+(?:[.,]\d+)?\s*(?:kms?|quilometros?)$/.test(withoutDate)
  const medida = selector ? undefined : readPendingWorkMeasure(implicitHours ? withoutDate + ' horas' : extraKm ? withoutDate.slice(2).trimStart() : withoutDate)
  if (!selector && !medida) return null

  let app: string | undefined
  if (selector) {
    const named = selector.groups.app
    app = /in\s*driv/.test(named) ? 'inDrive' : /ubb?er/.test(named) ? 'Uber' : '99'
    targets = pending.filter(({ action }) => action.kind === 'income' && action.category === 'corridas'
      && (normalizeName(action.description) === normalizeName(app) || normalizeName(action.origin) === normalizeName(app)))
  }
  if (date) targets = targets.filter(({ action }) => date.kind === 'date' && 'date' in action && (action.date || today) === date.date)
  const previous = changeApp?.groups.previous
  if (previous) targets = targets.filter(({ action }) => action.kind === 'income' && action.amount === parseMoney(previous))
  if (!targets.length) {
    plan.ambiguous = { question: app ? `Não encontrei receita da ${app}${date ? ' nesse dia' : ''} na proposta. Qual item você quer alterar?`
      : 'Não encontrei jornada nesse dia na proposta. Qual dia você quer corrigir?' }
    return plan
  }

  const field = medida?.field || 'amount'
  if (!selector && field !== 'hours') {
    targets = targets.filter(p => p.action.kind === 'work')
    if (!targets.length) {
      plan.ambiguous = { question: 'A proposta corrige o total de horas. Diga a nova duração em horas.' }
      return plan
    }
  }
  const value = medida?.value ?? parseMoney(changeApp?.groups.amount)
  if (extraKm && targets.some(({ action }) => action.kind === 'work' && action.km !== undefined)) {
    plan.ambiguous = { question: `Os ${value} km substituem a distância da proposta ou são de outra jornada? Diga o dia e o total correto.` }
    return plan
  }
  const revise = (item: AssistantCandidateAction): ParsedAction => ({ ...item.action, [field]: value })
  if (!remove && targets.some(item => !validateAction(revise(item), caps, today).ok)) {
    plan.ambiguous = { question: medida ? 'Confira a medida da jornada e diga o valor correto.' : 'Qual é o valor correto dessa receita?' }
    return plan
  }
  if (targets.length > 1) {
    plan.ambiguous = {
      field: 'pending-correction',
      question: app ? `Qual receita da ${app} você quer ${remove ? 'retirar' : 'corrigir'}?` : 'Qual jornada você quer corrigir?',
      options: targets.map((item, i) => ({
        value: String(i + 1),
        label: `${correctionLabel(item, i)} · ${brDate(('date' in item.action && item.action.date) || today)}`,
        actions: remove ? pending.filter(p => p.id !== item.id).map(p => p.action)
          : pending.map(p => p.id === item.id ? revise(p) : p.action),
      })),
    }
    return plan
  }
  const [item] = targets
  if (remove) {
    plan.remove.push(item.id)
    plan.summary.push(`Retirei a receita da ${app} da proposta.`)
  } else {
    const before = (item.action as unknown as Record<string, unknown>)[field]
    plan.edits.push({ id: item.id, field, value, was: before })
    const label = field === 'km' ? `${fmtNum(value, 3)} km` : field === 'trips' ? `${value} viagens` : field === 'hours' ? fmtHours(value) : fmtBRL(value)
    const detail = field === 'km' ? 'a distância' : field === 'trips' ? 'as viagens' : field === 'hours' ? 'as horas' : `a receita da ${app}`
    plan.summary.push(`Atualizei ${detail} para ${label}.`)
  }
  return plan
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
  const plan = parseCorrectionWithMarker(message, pending, caps, today)
  if (!plan) return plan
  // O marcador da 99 só serve para ACHAR o item; nunca vira valor gravado
  // nem texto ("Troquei para Appzz").
  // Plataforma com a grafia de sempre: "era indrive" gravava "Indrive".
  const volta = (v: any) => typeof v === 'string'
    ? v.replace(new RegExp(APP_99, 'gi'), '99').replace(/\bin\s*driver?\b/gi, 'inDrive').replace(/^uber$/i, 'Uber') : v
  return { ...plan, edits: plan.edits.map(e => ({ ...e, value: volta(e.value) })), summary: plan.summary.map(volta),
    ...(plan.independentStatement ? { independentStatement: volta(plan.independentStatement) } : {}) }
}

function parseCorrectionWithMarker(
  message: string,
  pending: AssistantCandidateAction[],
  caps: AssistantCapabilities,
  today = todayISO(),
): CorrectionPlan | null {
  if (!pending.length) return null
  if (pending.some(p => ['description', 'origin'].some(k => normalizeName((p.action as any)[k] || '') === '99'))) {
    message = message.replace(/(^|\b(?:d(?:e|[ao]s?)|n?[ao]s?)\s+)(?:99|noventa\s+e\s+nove)(?![\wÀ-ÿ]|[.,]\d|\s*(?:reais|real|contos?|pila)\b)/gi, `$1${APP_99}`)
  }
  // Pergunta não é conserto: "o que tem na fatura do Inter?" com o pagamento
  // do Nubank na tela TROCAVA o cartão da proposta. Quem pergunta quer saber;
  // a proposta fica como está e a pergunta segue para o roteador.
  if (/^\s*(?:e\s+)?(?:o\s+que|qual|quais|quanto|quanta|quantos|quantas|quando|onde|como|cad[eê]|por\s*que|ser[áa]\s+que)(?![\wÀ-ÿ])/i.test(message)) return null
  const { text: norm } = normalizeNumberWords(message)
  const t = norm.toLowerCase()
  const plan: CorrectionPlan = { remove: [], edits: [], cancelAll: false, summary: [] }
  const driverCorrection = correctDriverProposal(norm, pending, caps, today, plan)
  if (driverCorrection) return driverCorrection
  if (parseClockCorrection(message, pending, today, plan)) return plan
  const contrasted = parseContrastCorrection(norm, pending, caps, today, plan)
  if (contrasted) return contrasted
  const withdrawn = withdrawDeniedProposal(norm, pending, today, plan)
  if (withdrawn) return withdrawn
  if (/^\s*(?:n[ãa]o|[nñ])\s+(?:foi|era|fui)\b/i.test(t)) return null
  // "Não, foi na 99": com a vírgula, o "não" recusa a proposta e o resto a
  // conserta. Sem vírgula ("não foi na 99") continua sendo negação, acima.
  const repair = norm.match(/^\s*(?:(?:na\s+(?:real|verdade)|ou\s+melhor|quer\s+dizer|ops|n[ãa]o\s*,)[\s,:]+)?(?:foi|era|veio|troca\s+o\s+valor\s+(?:pra|para))\s+(.+)$/i)
  if (repair && !looksLikeQuestion(norm.replace(/\?+$/, ''))) {
    const target = resolveTarget(norm, pending)
    const targets = target && 'id' in target ? pending.filter(p => p.id === target.id) : pending
    const alternatives = revisionChoices(repair[1], targets, pending, caps, today)
    if (alternatives) {
      plan.ambiguous = alternatives
      return plan
    }
  }

  // Uma correção de origem pode trazer valor e fonte juntos. O leitor de
  // valor isolado aproveitava só o número e mantinha a plataforma anterior.
  const [income, other] = pending.filter(p => p.action.kind !== 'work')
  const creditRevision = norm.match(/^\s*(?:(?:na\s+(?:real|verdade)|ou\s+melhor|quer\s+dizer|ops|errei|corrigindo|me\s+enganei)[\s,:]+)+(?:foi\s+|era\s+|veio\s+)?(.+)$/i)?.[1]
    || repair?.[1]
  if (income?.action.kind === 'income' && !other && creditRevision && !looksLikeQuestion(norm)
    && /^(?:(?:r\$\s*)?\d+(?:[.,]\d+)*(?:\s+reais?)?\s+)?(?:d[aeo]s?|pel[oa]|n[oa])\s+\S/i.test(creditRevision)) {
    const revision = revisedAction(income.action, creditRevision, today)
    const checked = revision && validateAction(revision, caps, today)
    if (checked?.ok && checked.action.kind === 'income') {
      for (const field of ['amount', 'description', 'category', 'origin', 'date', 'is99'] as const) {
        if (checked.action[field] !== income.action[field]) {
          plan.edits.push({ id: income.id, field, value: checked.action[field], was: income.action[field] })
        }
      }
      plan.summary.push(plan.edits.length ? 'Corrigi a proposta.' : 'A proposta já estava com esses dados.')
      return plan
    }
    if (extractOrigins(creditRevision).length > 1 || /\bou\b|\be\s+(?:r\$\s*)?\d/i.test(creditRevision)) {
      plan.ambiguous = { question: 'Qual foi o valor exato e de onde veio essa receita?' }
      return plan
    }
  }

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
    String.raw`(?:(?:troca|trocar|muda|mudar|altera|alterar|corrige|corrigir|ajusta|ajustar)\s+(?:o\s+)?valor\s+(?:para|pra|por|em)\s*(?:r\$)?\s*${NUMBER}${MIL})` +
    String.raw`|(?:(?:foi|era|é)\s*(?:r\$)?\s*${NUMBER}${MIL}\s*(?:reais)?${REFORCO}\s*$)` +
    // "Na verdade 80", "quer dizer 80 reais" — o conserto mais natural que
    // existe, e o único caminho que faltava reconhecer.
    String.raw`|(?:(?:na\s+verdade|na\s+real|quer\s+dizer|queria\s+dizer|ou\s+melhor|melhor\s+dizendo|corrigindo|errei|me\s+enganei|foi\s+mal)\b[^\d]{0,12}(?:r\$)?\s*${NUMBER}${MIL})` +
    // A mensagem inteira é um número: com a proposta na tela isso só pode ser
    // o valor certo. Sem proposta, `parseCorrection` nem é chamada.
    // "Não, 280": o "não" seco na frente é o mesmo conserto.
    String.raw`|(?:^\s*(?:(?:n[ãa]o|[nñ]|ops|opa|epa)[\s,.!]+)?(?:r\$)?\s*${NUMBER}${MIL}\s*(?:reais)?${REFORCO}\s*$)`,
    'i',
  )
  const vm = t.match(valueRe)
  if (vm) {
    const pick = (n: number, m: number) => (vm[n] ? parseMoney(vm[n]) * (vm[m] ? 1000 : 1) : NaN)
    const newValue = [pick(1, 2), pick(3, 4), pick(5, 6), pick(7, 8)].find(v => v > 0) ?? NaN
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
  // A resposta curta "da casa 3", "do cliente João" (sem verbo) completa a
  // proposta na tela do mesmo jeito: caía no menu de ajuda.
  if (!touched && /^(?:e\s+)?(?:(?:era|foi|e|é|veio|vem|vieram)\s+)?d[ao]s?\s/.test(t)) {
    const primary = remaining.filter(p => p.action.kind !== 'work')
    const onlyIncome = primary.length === 1 && primary[0].action.kind === 'income'
    const said = message.trim().replace(/^(?:e\s+)?(?:(?:era|foi|e|é|veio|vem|vieram)\s+)?/i, '')
    const explicit = extractOrigins(message.trim())[0]?.value
    const origem = explicit || (onlyIncome ? explicitSpokenPayer(said) : undefined)
    const target = origem ? resolveTarget(t, remaining) : null
    const p = target && 'id' in target ? remaining.find(x => x.id === target.id) : undefined
    if (origem && p && (p.action.kind === 'income' || p.action.kind === 'expense')) {
      const nova = explicit ? origem.replace(/(^|\s)(\S)/g, (_, s: string, c: string) => s + c.toUpperCase()) : origem
      if (p.action.kind === 'income') {
        const revision = revisedAction(p.action, said, today)
        if (revision?.kind === 'income') {
          for (const field of ['category', 'description', 'is99'] as const) {
            if (p.action[field] !== revision[field]) plan.edits.push({ id: p.id, field, value: revision[field], was: p.action[field] })
          }
        }
      }
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

  // Complemento CURTO de uma proposta única: "foi na uber", "no posto", "de
  // salário", "foi janta", "foram 18 litros", "não, foi 250". Caíam no menu de
  // ajuda ou em "não peguei o quê". Só com UM item na tela: com dois, o
  // complemento não diz a quem pertence, e o fluxo de alvo acima pergunta.
  // A viagem implícita do motorista acompanha a receita e não é outro alvo.
  const principais = remaining.filter(x => x.action.kind !== 'work')
  if (!touched && principais.length === 1) {
    const p = principais[0]
    const a: any = p.action
    const semPrefixo = t.replace(/^(?:na\s+verdade|na\s+real|ou\s+melhor|quer\s+dizer|pensando\s+bem)\s*,?\s*/, '').replace(/[.!?]+$/, '').trim()
    const valor = semPrefixo.match(/^n[ãa]o\s*[,;.!]+\s*(?:foi|era|deu|[ée]|foram)\s+(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real))?$/)
    const litros = semPrefixo.match(/^(?:foram|deu|deram|eram|s[ãa]o|foi)?\s*(\d+(?:[.,]\d+)?)\s*(?:l|lts?|litros?)$/)
    const plataforma = semPrefixo.match(/^(?:e\s+)?(?:foi\s+|era\s+)?(?:n[oa]|pel[oa]|d[oa])\s+(uber|99|indrive[r]?)$/)
    const deX = semPrefixo.match(/^(?:e\s+)?(?:foi\s+|era\s+)?(?:de|do|da)\s+([a-zà-úç][a-zà-úç\s]{1,30})$/)
    const lugarCurto = semPrefixo.match(/^(?:e\s+)?(?:foi\s+|era\s+)?(?:n[oa]s?|em)\s+([a-zà-úç][a-zà-úç0-9\s]{1,40})$/)
    const coisa = semPrefixo.match(/^(?:foi|era)\s+(?:(?:um|uma|o|a)\s+)?([a-zà-úç][a-zà-úç\s]{1,30})$/)
    // "É salário", "era o aluguel", "foi comissão": a FONTE da receita.
    const fonteDita = semPrefixo.match(/^(?:e\s+|mas\s+)?(?:[ée]|era|foi)\s+(?:(?:o|a|meu|minha|do|da|de)\s+)?([a-zà-úç][a-zà-úç\s]{1,30})$/)
    const catDaFonte = fonteDita && a.kind === 'income' ? guessCategory(fonteDita[1], 'income') : undefined
    const editar = (field: string, value: unknown) => {
      if (a[field] !== value) plan.edits.push({ id: p.id, field: field as any, value, was: a[field] })
    }
    const capital = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
    if (valor && typeof a.amount === 'number') {
      const novo = parseMoney(valor[1])
      if (novo > 0) { editar('amount', novo); plan.summary.push(`Troquei o valor para ${fmtBRL(novo)}.`); touched = true }
    } else if (litros && a.kind === 'fuel') {
      const l = parseMoney(litros[1])
      if (l > 0) { editar('liters', l); plan.summary.push(`Anotei ${String(l).replace('.', ',')} litros.`); touched = true }
    } else if (plataforma && a.kind === 'income') {
      const nome = /^uber$/i.test(plataforma[1]) ? 'Uber' : /^99$/.test(plataforma[1]) ? '99' : 'inDrive'
      editar('description', nome); editar('category', 'corridas')
      plan.summary.push(`Anotei a plataforma: ${nome}.`); touched = true
    } else if (catDaFonte && fonteDita) {
      editar('category', catDaFonte)
      plan.summary.push(`Anotei: ${capital(fonteDita[1].trim())}.`); touched = true
    } else if (deX && a.kind === 'income') {
      const fonte = deX[1].trim()
      const cat = guessCategory(fonte, 'income')
      if (cat) editar('category', cat)
      if (!a.description) editar('description', capital(fonte))
      plan.summary.push(`Anotei: ${capital(fonte)}.`); touched = true
    } else if ((lugarCurto || coisa) && (a.kind === 'expense' || a.kind === 'income')) {
      const nome = (lugarCurto || coisa)![1].trim()
      // Data, cartão e categoria já tiveram sua vez acima; palavra de tempo aqui
      // seria descrição errada ("foi hoje").
      if (!/^(?:hoje|ontem|anteontem|agora|cedo|tarde|noite|isso|so|só|tudo|nada)$/i.test(nome)) {
        editar('description', capital(nome))
        const cat = guessCategory(nome, a.kind)
        if (cat) editar('category', cat)
        plan.summary.push(`Troquei para ${capital(nome)}.`); touched = true
      }
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
        const { cardId, expectedPending, ...payment } = p.action
        return { ...p, action: { ...payment, cardName: e.value } }
      }
      return { ...p, action: { ...p.action, [e.field]: e.value } }
    })
  }
  return out
}
