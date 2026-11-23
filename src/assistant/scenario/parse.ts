// Hipótese em pt-BR → `AssistantScenarioPlan`.
//
// O reconhecimento de hipótese já existia em `clauses.ts` — e servia para
// DESCARTAR as ações ("se eu gastar 500" não é um gasto). Isso está certo e
// continua valendo. O que faltava era o outro lado: descartada a ação, o
// usuário ficava com o texto genérico de ajuda, apesar de o app saber simular
// compra parcelada, projeção e saldo desde sempre.

import type { AppState } from '../../models/types'
import { parseMoney, todayISO } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { isDriver } from '../../services/profile'
import { activeCards } from '../../services/cards'
import { usableCategories, CATEGORY_KEYWORDS } from '../../data/categories'
import { normalizeNumberWords } from '../numbers'
import { SCENARIO_DSL_VERSION } from './types'
import { guardarEsteMes } from '../cashQuestions'
import { readPayoffQuote } from './payoff'
import { describeMissingRentalInput, incomeLossEnd, mentionedRentals, readIncomeLossDuration, readIncomeLossTiming, rentalSources } from './incomeWindow'
import type { AssistantScenarioPlan, DrivingScenario, ScenarioKind } from './types'

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const normalizaCenario = (s: string) => semAcento(normalizeNumberWords(s.replace(/\bpor\s+cento\b/gi, '%')).text)

/**
 * Marcadores de hipótese. Deliberadamente amplos: uma frase hipotética que o
 * app não reconhece cai no texto genérico de ajuda, o que é ruim mas seguro —
 * o perigoso seria o contrário, e disso cuida `clauses.ts`, que já zera as
 * ações de qualquer frase com "se eu".
 */
const HIPOTESE = [
  /\bse\s+eu\b/, /\bse\s+a\s+gente\b/, /\bse\s+for\b/, /\bse\s+eu\s+for\b/,
  /\be\s+se\b/, /\bsupondo\b/, /\bimagina\s+que\b/, /\bvamos\s+supor\b/,
  /\bestou\s+pensando\s+em\b/, /\bto\s+pensando\s+em\b/, /\bpretendo\b/,
  /\bqueria\s+saber\s+se\b/, /\bda\s+ruim\b/, /\bcompensa\s+(?:comprar|pegar|parcelar)\b/,
  // "se a Casa 1 não pagar": entre o artigo e o verbo cabe um nome com número
  // ("casa 1", "cliente joão silva"), e exigir uma palavra só deixava a frase
  // mais comum do dono de imóvel de fora.
  /\bse\s+(?:o|um)\s+inquilino\b[^?;]*\b(?:sair|saisse|for\s+embora)\b/,
  /\bse\s+(?:a|o|as|os)\s+[\w\s]{2,24}?\s(?:nao|n|atrasar|atrasarem|falhar|sumir|ficar\s+(?:vazi[ao]|sem\s+inquilino)|desocupar)\b/,
  // "só quero saber se 500 de obra cabe esse mês" — hipótese sem "eu", dita do
  // jeito mais direto possível. Sem estas formas ela caía no texto genérico de
  // ajuda, e é justamente a frase de quem NÃO quer registrar nada.
  /\bse\s+(?:r\$\s*)?\d/,
  /\bcabe\b/, /\bd[áa]\s+pra\b[^?]*\d/, /\bdaria\s+pra\b/,
  /\bconsigo\s+(?:comprar|pagar|bancar)\b/, /\bs[óo]\s+quero\s+saber\s+se\b/,
  // "Tenho dinheiro pra trocar o pneu de 600?": a pergunta de sempre, com o
  // saldo como sujeito. Virava busca por um lançamento chamado "Tenho dinheiro".
  /\btenho\s+(?:dinheiro|grana|saldo|bala)\s+(?:pra|para)\b[^?]*\d/,
  // "Posso parcelar uma geladeira de 3000 em 10x?" mostrava a situação dos
  // cartões; "posso comprar um celular de 1500?" caía na ajuda.
  /\bposso\s+(?:comprar|parcelar|financiar|bancar)\b/,
  // "Vale a pena ficar mais 3 horas?" é a mesma hipótese do "se eu ficar mais
  // 3h", sem o "se" — caía em "não tenho certeza do que registrar".
  /\b(?:vale\s+a\s+pena|compensa)\s+(?:eu\s+)?(?:ficar|rodar|trabalhar|fazer)\s+mais\b/,
  // "Se a gasolina aumentar 12%", "se o aluguel subir": hipótese sobre uma
  // coisa que não é "eu". Sem este marcador a frase ia à consulta e voltava
  // como fato ("Resultado este mês: R$ 3.439,90 (dado real)").
  /\bse\s+(?:a|o)\s+(?:gasolina|combustivel|etanol|diesel)\s*[+-]\s*\d/,
  /\bse\s+(?:a|o|as|os|meu|minha|meus|minhas)\s+[\w\s]{2,30}?\s(?:aumentar|aumentasse|aumentarem|subir|subisse|subirem|cair|caisse|cairem|baixar|baixasse|dobrar|dobrasse|diminuir|diminuisse|ficar|ficasse|ficarem|custar|custasse|encarecer)\b/,
]

export const looksLikeScenario = (input: string): boolean => {
  const t = semAcento(input)
  if (/\b(?:posso|consigo|daria\s+pra|da\s+(?:pra|para))\s+(?:pagar|comprar|bancar)\b/.test(t)
    && withoutReserveFunding(input) !== undefined) return true
  // "Dá pra guardar 300 ESTE MÊS?" é a sobra prevista do mês (fato
  // projetado, `cashQuestions`), não uma simulação de guardar por mês.
  if (guardarEsteMes(t.replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ')) !== null) return false
  // "Consigo pagar TUDO / as contas esse mês?": cobertura do que vence pelo
  // saldo, uma conta de fato (roteador), sem valor hipotético nenhum.
  if (!/\d/.test(t) && /\b(?:consigo|vou\s+conseguir|da\s+(?:pra|para))\s+pagar\s+(?:tudo|as\s+contas|todas\s+as\s+contas|os\s+boletos)\b/.test(t)) return false
  return HIPOTESE.some(re => re.test(t)) || (/\b(?:da\s+pra|se)\b/.test(t) && HIPOTESE.some(re => re.test(normalizaCenario(t))))
}

const NUM = String.raw`(\d+(?:[.,]\d+)*)`
const CASH_ASSUMPTION = String.raw`(?:r\$\s*)?((?:[-−]\s*|menos\s+)?(?:r\$\s*)?\d+(?:[.,]\d+)*)(?![\d.,]\d)(?:\s+(?:reais?|contos?))?`
const CASH_ASSUMPTION_END = String.raw`(?=\s*(?:$|[?,;.!]|(?:e\s+)?(?:d[aá]\s+pra|daria\s+pra|consigo|posso|cabe|pagar|gastar|comprar|quitar|guardar|ou)\b))`
const BALANCE_CONTEXT = [
  new RegExp(String.raw`(?<![\wÀ-ÿ])(?:com|considerando|partindo\s+de|(?:e\s+)?se\s+(?:eu\s+)?tiver)\s+(?:(?:um|o|meu)\s+)?saldo(?:\s+(?:dispon[íi]vel|em\s+conta|n[ao]\s+(?:conta|banco)))?(?:\s+de)?\s+${CASH_ASSUMPTION}${CASH_ASSUMPTION_END}`, 'gi'),
  new RegExp(String.raw`(?<![\wÀ-ÿ])(?:com|considerando|partindo\s+de|(?:e\s+)?se\s+(?:eu\s+)?tiver)\s+${CASH_ASSUMPTION}\s+(?:de\s+saldo|n[ao]\s+(?:(?:minha|meu)\s+)?(?:conta|banco))\b${CASH_ASSUMPTION_END}`, 'gi'),
]
const CASH_ALTERNATE = new RegExp(String.raw`^\s+ou\s+${CASH_ASSUMPTION}${CASH_ASSUMPTION_END}`, 'i')
const CASH_BALANCE_REPLY = new RegExp(String.raw`^(?:(?:usa|use|foi|e|o\s+de|use\s+o\s+de|fica(?:m|ria|riam)?|vou\s+ficar\s+com)\s+)?${CASH_ASSUMPTION}[.!?]*$`, 'i')
export const SCENARIO_BALANCE_QUESTION = 'Qual saldo em conta devo usar nesta simulação? Diga um valor só.'
export const RESERVE_SPEND_BALANCE_QUESTION = 'Qual valor ficará disponível na conta depois do resgate? O app guarda os depósitos na reserva, mas não acompanha os resgates.'

const RESERVE = String.raw`(?:(?:a|minha|nossa)\s+)*(?:reserva|poupanca)\b`
const FUNDING_WITH_RESERVE = [
  new RegExp(String.raw`\b(?:com|considerando)\s+(?:(?:o|um|meu)\s+)?saldo\b[^?!;]{0,48}?\s+(?:da|na)\s+${RESERVE}`),
  new RegExp(String.raw`\b(?:usando|usar|tirando|tirar|retirando|retirar|sacando|sacar|resgatando|resgatar)\s+[^?!;]{0,36}?\b(?:da|na)\s+${RESERVE}`),
  new RegExp(String.raw`\b(?:com|usando|usar)\s+${RESERVE}(?:\s+de\s+${CASH_ASSUMPTION})?`),
]

function withoutReserveFunding(input: string): string | undefined {
  const t = normalizaCenario(input)
  const source = FUNDING_WITH_RESERVE.map(pattern => t.match(pattern)).find(Boolean)
  return source ? t.replace(source[0], ' ') : undefined
}

const parseScenarioBalance = (raw: string): number =>
  parseMoney(raw.replace(/−|menos\s+/i, '-'))

const validScenarioBalance = (balance: number): boolean => Number.isFinite(balance) && Math.abs(balance) <= 99_999_999

export function readScenarioBalanceReply(message: string, awaitingValue: boolean): number | undefined {
  const explicit = readScenarioBalance(message)
  if (explicit.balance !== undefined && /^(?:e|agora|entao)?[\s.!?]*$/.test(semAcento(explicit.remaining).trim())) return explicit.balance
  if (!awaitingValue) return undefined
  const said = normalizeNumberWords(message).text.trim()
  const raw = said.match(CASH_BALANCE_REPLY)?.[1]
  const amount = raw ? parseScenarioBalance(raw) : NaN
  return validScenarioBalance(amount) ? amount : undefined
}

function readScenarioBalance(input: string) {
  const text = normalizeNumberWords(input).text
  const matches = BALANCE_CONTEXT.flatMap(pattern => [...text.matchAll(pattern)])
  if (!matches.length) return { remaining: input }
  const amounts = new Set<number>()
  let remaining = text
  for (const match of matches.sort((a, b) => b.index! - a.index!)) {
    const start = match.index!
    const tail = text.slice(start + match[0].length)
    const alternate = tail.match(CASH_ALTERNATE)
    for (const raw of [match[1], alternate?.[1]]) {
      if (raw) amounts.add(parseScenarioBalance(raw))
    }
    remaining = remaining.slice(0, start) + ' ' + remaining.slice(start + match[0].length + (alternate?.[0].length || 0))
  }
  const [balance] = amounts
  if (amounts.size !== 1 || !validScenarioBalance(balance)) {
    return { remaining, issue: SCENARIO_BALANCE_QUESTION }
  }
  return { remaining, balance }
}

const INSTALLMENT_COUNT = String.raw`(?<!\d|\d[.,])(\d+)\s*(?:x|vezes|parcelas|prestacoes)\b`
const TOTAL_BEFORE_INSTALLMENTS = new RegExp(String.raw`(?<![\d.,−-])(?:r\$\s*)?${NUM}(?!\d|[.,]\d)\s*(?:reais\s*)?(?:em|x|de)?\s*(?:em\s*)?${INSTALLMENT_COUNT}`)
const TOTAL_AFTER_INSTALLMENTS = new RegExp(String.raw`${INSTALLMENT_COUNT}[^\d;!?−-]{0,40}?(?:r\$\s*)?${NUM}(?!\d|[.,]\d)`)
const INSTALLMENT_PRICE = new RegExp(String.raw`${INSTALLMENT_COUNT}\s+(?:de|no\s+valor\s+de)\s+(?:r\$\s*)?${NUM}(?!\d|[.,]\d)`)

/** O preço e a quantidade têm funções distintas, mesmo quando o preço é menor. */
function lerCompra(t: string): { total: number; installments: number } | { issue: string } | null {
  const forward = t.match(TOTAL_BEFORE_INSTALLMENTS)
  const unit = t.match(INSTALLMENT_PRICE)
  const reverse = forward || unit ? null : t.match(TOTAL_AFTER_INSTALLMENTS)
  if (!forward && !unit && !reverse) return null
  const installments = Number(forward?.[2] ?? unit?.[1] ?? reverse?.[1])
  const saidTotal = forward ? parseMoney(forward[1]) : reverse ? parseMoney(reverse[2]) : undefined
  const unitTotal = unit ? Math.round(parseMoney(unit[2]) * 100) * installments / 100 : undefined
  const total = saidTotal ?? unitTotal
  const priceAt = forward?.index ?? (reverse ? reverse.index! + reverse[0].lastIndexOf(reverse[2]) : 0)
  const directlyNamed = /\b(?:por|de|comprar|pagar)\s+(?:r\$\s*)?$/.test(t.slice(0, priceAt))
  // "E se em vez de 10x eu fizer 12?" fala de duas quantidades.
  if (unitTotal === undefined && valorDeDinheiro(t, total) === undefined && !directlyNamed) return null
  if (!Number.isInteger(installments) || installments < 1 || installments > 120) {
    return { issue: 'Em quantas parcelas seria a compra? Informe entre 1 e 120.' }
  }
  if (saidTotal !== undefined && unitTotal !== undefined && Math.round(saidTotal * 100) !== Math.round(unitTotal * 100)) {
    return { issue: 'O valor total e o valor das parcelas informadas dão contas diferentes. Qual valor total devo usar?' }
  }
  if (!Number.isFinite(total) || total > 99_999_999 || Math.round(total * 100) < installments) {
    return { issue: 'Qual seria o valor total da compra? Cada parcela precisa ter pelo menos um centavo.' }
  }
  return { total, installments }
}

function lerValor(t: string): number {
  const m = t.match(new RegExp(String.raw`(?:r\$\s*)?${NUM}`))
  return m ? parseMoney(m[1]) : NaN
}

/**
 * O número lido é mesmo DINHEIRO?
 *
 * Um "1" solto quase nunca é um valor — é um identificador ("Casa 1", "unidade
 * 2"). Só aceitamos um número pequeno quando a frase o marca como dinheiro
 * (R$, "reais", "mil"). Na dúvida, `undefined`: o motor sabe medir a entrada
 * pelo histórico, e um valor errado seria pior que valor nenhum.
 */
function valorDeDinheiro(t: string, valor: number): number | undefined {
  if (!Number.isFinite(valor) || valor <= 0) return undefined
  if (valor >= 100) return valor
  return /\br\$|\breais\b|\bmil\b|\bconto/.test(t) ? valor : undefined
}

function categoriaDe(state: AppState, t: string): string | undefined {
  for (const c of usableCategories(state.categories || [])) {
    if (c.type !== 'expense') continue
    const n = normalizeName(c.name)
    if (n.length >= 4 && t.includes(n)) return c.id
  }
  for (const [id, palavras] of Object.entries(CATEGORY_KEYWORDS)) {
    if (palavras.some(p => new RegExp(`\\b${normalizeName(p)}`).test(t))) return id
  }
  return undefined
}

function cartaoDe(state: AppState, t: string, cards = activeCards(state)): string | undefined {
  for (const c of cards) {
    const n = normalizeName(c.name)
    if (n.length >= 3 && t.includes(n)) return c.name
  }
  return undefined
}

/** Fonte que deixaria de pagar: "se a Casa 1 não pagar", "se o Cliente João atrasar". */
function origemDe(t: string): string | undefined {
  return [...t.matchAll(/\b(?:casa|cliente|empresa|loja|kitnet|apart\w*|inquilin\w+|contrato|sala|ponto|unidade)\s+([\w\d]+)/g)]
    .find(m => !/^(?:ficar|ficasse|vazia|vazio|nao|n|atrasar|falhar|desocupar|sumir|sair|por|durante|da|do|de)$/.test(m[1]))?.[0]
}

/**
 * Interpreta a hipótese. `null` quando a frase não é um cenário — nunca um
 * plano "por garantia".
 */
/**
 * Quantos meses a hipótese cobre: "até dezembro" conta do mês atual até ele,
 * inclusive; sem mês dito, seis.
 */
const MESES_NOME = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
function horizonte(t: string, hoje: string): number {
  const duracao = t.match(/\b(?:durante|por)\s+(\d{1,2})\s+(mes(?:es)?|semanas?)\b/)
  if (duracao) {
    const n = Number(duracao[1])
    return /^semana/.test(duracao[2]) ? Math.max(1, Math.ceil(n * 7 / 30)) : Math.min(Math.max(n, 1), 12)
  }
  const m = t.match(new RegExp(String.raw`\bate\s+(${MESES_NOME.join('|')})(?:\s+de\s+(\d{4}))?\b`))
  if (!m) return 6
  const alvo = MESES_NOME.indexOf(m[1])
  const atual = Number(hoje.slice(5, 7)) - 1
  const ano = m[2] ? Number(m[2]) : Number(hoje.slice(0, 4)) + (alvo < atual ? 1 : 0)
  const n = (ano - Number(hoje.slice(0, 4))) * 12 + alvo - atual + 1
  return Math.min(Math.max(n, 1), 12)
}

function horizonProblem(t: string, hoje: string): string | undefined {
  const named = t.match(new RegExp(String.raw`\bate\s+(${MESES_NOME.join('|')})(?:\s+de\s+(\d{4}))?\b`))
  if (named?.[2]) {
    const months = (Number(named[2]) - Number(hoje.slice(0, 4))) * 12
      + MESES_NOME.indexOf(named[1]) - (Number(hoje.slice(5, 7)) - 1) + 1
    if (months < 1) return `A data ${named[1]} de ${named[2]} já passou; me diga um horizonte futuro.`
    if (months > 12) return `Só consigo projetar até 12 meses; ${named[1]} de ${named[2]} fica fora desse limite.`
  }
  const duration = t.match(/\b(?:durante|por)\s+(\d{1,3})\s+mes(?:es)?\b/)
  if (duration && Number(duration[1]) > 12) return 'Só consigo projetar até 12 meses; me diga um horizonte menor.'
  return undefined
}

function firstSavingMonth(t: string, hoje: string): string | undefined {
  const m = t.match(new RegExp(String.raw`\ba\s+partir\s+de\s+(${MESES_NOME.join('|')})(?:\s+de\s+(\d{4}))?\b`))
  if (!m) return undefined
  const month = MESES_NOME.indexOf(m[1]) + 1
  const year = m[2] ? Number(m[2]) : Number(hoje.slice(0, 4)) + (month < Number(hoje.slice(5, 7)) ? 1 : 0)
  return `${year}-${String(month).padStart(2, '0')}`
}

/** Parar um tipo de gasto: "parar a obra", "cortar o lazer", "não gastar mais com mercado". */
const PARAR_GASTO = /\b(?:parar|pare|parasse|parando|cortar|corte|cortasse|tirar|tirasse|cancelar|cancelasse|cancelo|deixar\s+de\s+gastar|nao\s+gastar\s+mais|parar\s+de\s+gastar)\b/

const FUEL = String.raw`(?:combustivel|gasolina|etanol|alcool|gnv|diesel)`
const PERCENT = String.raw`${NUM}\s*(?:%|por\s+cento\b)`
const DRIVE = String.raw`(?:rodar|andar|dirigir|trabalhar|fazer)`

function drivingAdjustments(t: string): Omit<DrivingScenario, 'metric'> {
  const kmBefore = t.match(new RegExp(String.raw`\b${DRIVE}\s+(mais|menos)\s+${PERCENT}`))
  const kmAfter = t.match(new RegExp(String.raw`\b${DRIVE}\s+${PERCENT}\s+(?:a\s+)?(mais|menos)\b`))
  const kmNumber = kmBefore?.[2] || kmAfter?.[1]
  const kmDirection = kmBefore?.[1] || kmAfter?.[2]

  const fuelVerb = t.match(new RegExp(String.raw`\b${FUEL}\s+(aument\w*|sub\w*|encarec\w*|cair|caisse|baix\w*|diminu\w*|reduz\w*|barate\w*)\s+(?:em\s+)?${PERCENT}`))
  const fuelAdjective = t.match(new RegExp(String.raw`\b${FUEL}\s+(?:(?:ficar|ficasse|estiver|for)\s+)?${PERCENT}\s+mais\s+(car[oa]|barat[oa])\b`))
  const fuelSign = t.match(new RegExp(String.raw`\b${FUEL}\s*([+-])\s*${PERCENT}`))
  const fuelNumber = fuelVerb?.[2] || fuelAdjective?.[1] || fuelSign?.[2]
  const fuelDown = fuelSign?.[1] === '-' || /^(?:cai|baix|diminu|reduz|barat)/.test(fuelVerb?.[1] || fuelAdjective?.[2] || '')
  const fuelPrice = t.match(new RegExp(String.raw`\b${FUEL}\s+(?:(?:for|ficar|custar|passar|subir|cair|aumentar|baixar)\s+)?(?:de\s+(?:r\$\s*)?\d+(?:[.,]\d+)*\s+para\s+|(?:a|por|para)\s+)?(?:r\$\s*)?${NUM}\s*(?:reais?\s+)?(?:/\s*l\b|(?:o|por)\s+litro\b)`))

  const daysBefore = t.match(new RegExp(String.raw`\b${DRIVE}\s+mais\s+(\d+)\s+dias?\s+(?:por|a\s+cada)\s+semana\b`))
  const daysAfter = t.match(new RegExp(String.raw`\b${DRIVE}\s+(\d+)\s+dias?\s+a\s+mais\s+(?:por|a\s+cada)\s+semana\b`))
  const days = daysBefore?.[1] || daysAfter?.[1]
  return {
    distanceChange: kmNumber ? parseMoney(kmNumber) / 100 * (kmDirection === 'menos' ? -1 : 1) : undefined,
    fuelPriceChange: fuelNumber ? parseMoney(fuelNumber) / 100 * (fuelDown ? -1 : 1) : undefined,
    fuelPricePerLiter: fuelPrice ? parseMoney(fuelPrice[1]) : undefined,
    extraDaysPerWeek: days ? Number(days) : undefined,
  }
}

const absoluteKm = (t: string) => t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*(?:km|quilometros?)\b`))
  || t.match(new RegExp(String.raw`\b(?:rodar|andar|dirigir)\s+${NUM}\s*(?:km|quilometros?)\s+a\s+mais\b`))
  || t.match(new RegExp(String.raw`\brodar\s+${NUM}\s*(?:km|quilometros?)\b`))

export function parsePurchaseDelay(text: string): { months: number; additional: boolean } | undefined {
  const t = normalizaCenario(text)
  const m = t.match(/\b(?:adiar|adiasse|atrasar|atrasasse|postergar|postergasse)\b[^?!;]{0,95}?(?:(?:por|em|pra|para)\s+(?:daqui\s+a\s+)?|mais\s+)(\d+)\s+mes(?:es)?\b/)
  return m ? { months: Number(m[1]), additional: /\bmais\s+\d+\s+mes/.test(m[0]) } : undefined
}

/** Valores declarados junto de uma meta conhecida ("já tenho 2.000 na viagem"). */
function declaredGoalSavings(state: AppState, text: string): { name: string; amount: number } | undefined {
  const metas = (state.goals || []).filter(g => !g.done).sort((a, b) => b.name.length - a.name.length)
  for (const meta of metas) {
    const nome = normalizeName(meta.name)
    if (nome.length < 3) continue
    const literal = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = text.match(new RegExp(String.raw`\b(?:(nao|nem|nunca)\s+(?:mais\s+)?)?(?:ja\s+)?tenho\s+(?:r\$\s*)?${NUM}\s*(?:reais?\s+)?(?:guardad[oa]s?\s+)?(?:n[oa]|para\s+[oa]|pr[oa])\s+(?:meta\s+(?:d[aeo]\s+)?)?${literal}(?=$|[\s,.!?;])`))
    const amount = m && !m[1] ? parseMoney(m[2]) : NaN
    if (amount >= 0 && Number.isSafeInteger(Math.round(amount * 100))) return { name: meta.name, amount }
  }
  return undefined
}

function planSingleScenario(
  state: AppState, input: string, opts: { today?: string; focusCategory?: string; fullText?: string } = {},
  fragment = false,
): AssistantScenarioPlan | null {
  if (!fragment && !looksLikeScenario(input)) return null
  // Números por extenso viram algarismos antes dos regex, igual ao parser de
  // registro — "quatro mil em dez vezes" é a mesma frase.
  const t = normalizaCenario(input)
    .replace(/\b(\d+(?:[.,]\d+)?)\s*k\b/g, (_, n: string) => String(parseMoney(n) * 1000))
  const driver = isDriver(state.settings)

  const base = (kind: ScenarioKind, extra: Partial<AssistantScenarioPlan>, label: string): AssistantScenarioPlan =>
    ({ version: SCENARIO_DSL_VERSION, kind, label, ...extra })

  // ---- motorista: horas ou km a mais -------------------------------------
  if (driver) {
    const horas = t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*(?:h|horas?)\b`))
      || t.match(new RegExp(String.raw`\b(?:trabalhar|ficar|rodar|fazer)\s+(?:mais\s+)?${NUM}\s*(?:h|horas?)\b`))
    if (horas) {
      const porDia = /\bpor\s+dia\b|\bdiari|\bcada\s+dia\b|\btodo\s+dia\b/.test(t)
      const duracao = t.match(/\b(?:durante|por)\s+(\d{1,2})\s+(dias?|semanas?|mes(?:es)?)\b/)
      const dias = porDia
        ? (duracao ? Number(duracao[1]) * (/^semana/.test(duracao[2]) ? 7 : /^mes/.test(duracao[2]) ? 30 : 1)
          : /\bsemana\s+toda\b|\btoda\s+a\s+semana\b|\b(?:essa|esta|nessa|nesta)\s+semana\b/.test(t) ? 7
          : /\bdias?\s+uteis\b/.test(t) ? 5 : 30)
        : 1
      return base('extra-work', { hoursPerDay: parseMoney(horas[1]), days: dias },
        `mais ${horas[1]}h ${porDia ? 'por dia' : 'hoje'}`)
    }
    const km = absoluteKm(t)
    const ownChanges = drivingAdjustments(t)
    if (km || Object.values(ownChanges).some(v => v !== undefined)) {
      const inteira = opts.fullText ? normalizaCenario(opts.fullText) : t
      const firstQuestion = inteira.search(/\b(?:quanto[sa]?|quantas|qual|quais)\b/)
      const pergunta = firstQuestion >= 0 ? inteira.slice(firstQuestion) : inteira
      const ganho = /\b(?:ganh\w*|fatur\w*|render|rende|lucr\w*|sobr\w*)\b/.test(pergunta)
      const custo = /\b(?:gastar|custar|custa|custo|gasto|preco)\b/.test(pergunta)
      const combustivel = new RegExp(String.raw`\b${FUEL}\b`).test(pergunta)
      const manutencao = /\b(?:manutencao|desgaste|pneus?|revisao)\b/.test(pergunta)
      const litros = /\bquantos\s+litros\b|\bconsumo\s+em\s+litros\b/.test(pergunta)
      const adjustments = drivingAdjustments(inteira)
      const qtdPercentuais = [...inteira.matchAll(/\d\s*(?:%|por\s+cento\b)/g)].length
      const reconhecidos = Number(adjustments.distanceChange !== undefined) + Number(adjustments.fuelPriceChange !== undefined)
      const kmTotal = km || absoluteKm(inteira)
      const extraKm = kmTotal ? parseMoney(kmTotal[1]) : undefined
      const fuelOnly = combustivel && !ganho && !manutencao
      const metric: DrivingScenario['metric'] = litros ? 'fuel-volume'
        : manutencao ? 'maintenance' : fuelOnly || (!ganho && custo && adjustments.fuelPriceChange !== undefined)
          ? 'fuel-cost' : 'profit'
      const precoSemUnidade = new RegExp(String.raw`\b${FUEL}\s+(?:(?:for|ficar|custar|passar|subir|cair|aumentar|baixar)\s+)?(?:para\s+|a\s+|por\s+)?r\$\s*\d`).test(inteira)
        && adjustments.fuelPricePerLiter === undefined
      const planningIssue = qtdPercentuais > reconhecidos
        ? 'Ainda não consigo combinar todos os percentuais informados nessa simulação.'
        : precoSemUnidade && !litros && !manutencao
          ? 'Qual preço por litro você quer usar na simulação?'
        : (manutencao && (combustivel || ganho)) || (ganho && custo)
          ? 'Posso estimar esses valores separadamente. Qual você quer primeiro?'
          : custo && !combustivel && !manutencao && metric === 'profit'
            ? 'Qual custo você quer estimar para esses km: combustível ou manutenção?'
            : undefined
      const driving = litros || manutencao || Object.values(adjustments).some(v => v !== undefined)
        ? { ...adjustments, metric }
        : undefined
      const label = driving ? 'mudança na rodagem do motorista'
        : fuelOnly ? `combustível para mais ${kmTotal?.[1]} km` : `mais ${kmTotal?.[1]} km`
      return base('extra-work', {
        extraKm, driving, planningIssue, ...(fuelOnly && !driving ? { fuelOnly: true } : {}),
      }, label)
    }
  }

  // ---- parar um tipo de gasto --------------------------------------------
  // "E se eu parar a obra, quanto sobra até dezembro?" não tinha tipo nenhum
  // no motor: a hipótese sumia e a metade "quanto sobra" era respondida como
  // PROJEÇÃO FACTUAL. Guardar/poupar ficam de fora — "parar de guardar" é
  // outra conta, e sem representação ainda.
  if (PARAR_GASTO.test(t) && !/\bguard|\bpoup|\bjunt|\bsepar/.test(t)) {
    // Conta fixa citada pelo nome vem antes da categoria: "parar de pagar a
    // internet" ia para Assinaturas (a palavra-chave) e dizia "não achei
    // base", com a Internet cadastrada em Casa.
    const conta = (state.recurring || []).find(r => r.kind !== 'income' && r.active !== false && r.name?.trim()
      && new RegExp(`\\b${semAcento(r.name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))
    const metade = /\b(?:pela|a|na)\s+metade\b|\bmetade\s+d[oa]s?\b/.test(t)
    if (conta) {
      return base('cut', { category: conta.category, description: conta.name, recurringId: conta.id,
        months: horizonte(t, opts.today || todayISO()), ...(metade ? { ratio: 0.5 } : {}) },
      `${metade ? 'cortar pela metade' : 'parar de pagar'} ${conta.name}`)
    }
    // A entidade pode ter ficado na conversa: "quanto gasto com obra?" → "e se
    // parar?". Sem categoria nem no texto nem no foco, não há o que simular.
    const categoria = categoriaDe(state, t) || opts.focusCategory
    if (categoria) {
      const nome = usableCategories(state.categories || []).find(c => c.id === categoria)?.name || categoria
      // "Cortar o mercado PELA METADE" é metade, não parar: a resposta dizia
      // "se você parar os gastos com Alimentação".
      return base('cut', { category: categoria, description: nome, months: horizonte(t, opts.today || todayISO()),
        ...(metade ? { ratio: 0.5 } : {}) }, `${metade ? 'cortar pela metade' : 'parar'} os gastos com ${nome}`)
    }
  }

  // Parar de guardar ainda não está representado. O “3” é duração, nunca R$ 3 por mês.
  if (/\bparar\s+de\s+(?:guardar|poupar|juntar|separar)\b/.test(t)) return null

  // Uma quitação hipotética se refere ao plano, sem baixar as suas parcelas.
  const quitacao = t.match(/\b(?:quitar|antecipar|adiantar)\s+(?:(?:o|a|os|as)\s+)?(?:(?:parcelamento|parcelas)\s+d[oa]\s+)?(.+)$/)
  if (quitacao && !/^fatura[s]?\b/.test(quitacao[1])) {
    const named = readPayoffQuote(quitacao[1])
    const wholeCard = (state.cards || []).find(c => normalizeName(c.name) === named.name)
    if (wholeCard && /\binteir[ao]\b/.test(quitacao[1])) return base('pay-invoice', { cardName: wholeCard.name }, 'pagar a fatura')
    const [qualified] = (state.cards || []).flatMap(card => {
      const suffix = ['do', 'da', 'no', 'na', 'pelo', 'pela'].map(article => ` ${article} ${normalizeName(card.name)}`)
        .find(candidate => named.name.endsWith(candidate))
      return suffix ? [{ cardName: card.name, description: named.name.slice(0, -suffix.length) }] : []
    })
    const description = qualified?.description || named.name
    const planningIssue = named.conflict ? 'Informe só o preço final da quitação ou só o desconto oferecido.'
      : /\b(?:amanha|mes\s+que\s+vem|mes\s+seguinte|daqui\s+a|dia\s+\d+)\b/.test(quitacao[1])
        ? 'Esta conta usa o saldo de hoje. Diga se quer simular a quitação hoje.' : undefined
    return base('payoff', { description, cardName: qualified?.cardName, payoffQuote: named.quote, planningIssue }, 'quitar um parcelamento')
  }

  // ---- pagar a fatura -----------------------------------------------------
  const cartaoDaFatura = cartaoDe(state, t, state.cards || [])
  if (/\bpagar\s+(?:a\s+)?fatura\b|\bquitar\s+(?:a\s+)?fatura\b/.test(t)
    || (!!cartaoDaFatura && /\b(?:pagar|quitar)\b[^?]*\binteir[oa]\b/.test(t))) {
    return base('pay-invoice', { cardName: cartaoDaFatura }, 'pagar a fatura')
  }

  // Por quanto tempo uma fonte fica sem pagar. O número do imóvel ou do
  // período nunca entra no valor em reais.
  const parsedDuration = readIncomeLossDuration(t)
  const vacancia = /\b(?:ficar(?:em)?|ficasse(?:m)?)\s+(?:vazi[ao]s?|sem\s+inquilino)\b|\bdesocupar\b|\bsem\s+receber\s+(?:o\s+)?aluguel\b|\binquilino\b[^?;]*\b(?:sair|saisse|for\s+embora)\b/.test(parsedDuration.remaining)
  if (vacancia || /\b(?:nao|n)\s+(?:me\s+)?(?:pagar|pagarem|vier|entrar|cair|depositar|receber)\b|\batrasar\b|\bfalhar\b/.test(t)) {
    const today = opts.today || todayISO()
    const rentals = vacancia ? mentionedRentals(state, t, today) : []
    const explicitOrigin = rentals[0]?.origin || origemDe(t)
    let origem = explicitOrigin
    const { duration: incomeLossDuration, window: incomeLossWindow, start: incomeLossStart, remaining, issue } =
      readIncomeLossTiming(t, today)
    let planningIssue = issue
    if (vacancia && !origem) {
      const [only, second] = rentalSources(state, today)
      if (only && !second) origem = only
    }
    if (rentals.length > 1) {
      origem = undefined
      planningIssue ||= 'Qual dos imóveis você quer simular primeiro? Informe um imóvel por vez.'
    } else if (vacancia) {
      planningIssue ||= describeMissingRentalInput(origem, !!(incomeLossDuration || incomeLossWindow || (explicitOrigin && !incomeLossStart)))
    } else if (incomeLossStart) {
      planningIssue ||= 'Por quanto tempo essa entrada ficaria ausente?'
    }
    const saidOrigin = rentals[0]?.said || origem
    const semOrigem = saidOrigin ? remaining.replace(saidOrigin, ' ') : remaining
    const valor = lerValor(semOrigem)
    return base('income-missing', { origin: origem, amount: valorDeDinheiro(semOrigem, valor), incomeLossDuration,
      incomeLossWindow, incomeLossStart, ...(vacancia ? { incomeLossForRent: true } : {}), planningIssue },
      'uma entrada que não vem')
  }

  // ---- guardar por mês ----------------------------------------------------
  const sharePercent = t.match(/\b(?:guardar|guardando|poupar|separar|juntar)\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s+(?:cento|100))\s+(?:da\s+sobra|do\s+que\s+sobrar)\b/)
  const shareHalf = /\b(?:guardar|guardando|poupar|separar|juntar)\s+(?:a\s+)?metade(?:\s+(?:da\s+sobra|do\s+que\s+sobrar)\b|(?=\s+(?:so\s+)?a\s+partir\b|\s+ate\b|$))/.test(t)
  const shareAll = /\b(?:guardar|guardando|poupar|separar|juntar)\s+(?:tudo|100\s*%)\s+(?:da\s+sobra|(?:o\s+)?que\s+sobrar)\b/.test(t)
  if (sharePercent || shareHalf || shareAll) {
    const ratio = shareAll ? 1 : shareHalf ? 0.5 : Math.min(parseMoney(sharePercent![1]) / 100, 1)
    return base('save-share', { ratio, months: horizonte(t, opts.today || todayISO()), startMonth: firstSavingMonth(t, opts.today || todayISO()) },
      `guardar ${(ratio * 100).toLocaleString('pt-BR')}% do que sobrar`)
  }
  // Uma porcentagem da sobra nunca pode cair no ramo de valor fixo.
  if (/\b(?:guardar|guardando|poupar|separar|juntar)\b.{0,35}?(?:%|por\s+(?:cento|100))/.test(t)) return null

  // Redução por valor mantém a categoria explícita e não finge que o gasto
  // desapareceu por completo.
  if (/\b(?:reduzir|diminuir|baixar)\b/.test(t)) {
    const valor = valorDeDinheiro(t, lerValor(t))
    const categoria = categoriaDe(state, t)
    if (valor !== undefined && categoria) {
      const nome = usableCategories(state.categories || []).find(c => c.id === categoria)?.name || categoria
      return base('reduce', { amount: valor, category: categoria, description: nome, months: horizonte(t, opts.today || todayISO()) },
        `reduzir ${nome} em ${valor} por mês`)
    }
  }

  if (/\bguardar?\b|\bguardando\b|\bguardasse\b|\bpoupar\b|\bseparar\b|\bjuntar\b/.test(t)) {
    // O valor é o que acompanha o verbo: em "já tenho 4.800 na viagem, se eu
    // guardar 350 por mês", o primeiro número da frase é o acumulado, não o depósito.
    const juntoDoVerbo = t.match(new RegExp(String.raw`\b(?:guardar|guardando|guardasse|poupar|poupasse|separar|separasse|juntar|juntasse)\s+(?:r\$\s*)?${NUM}`))
    const valor = juntoDoVerbo ? parseMoney(juntoDoVerbo[1]) : lerValor(t)
    if (Number.isFinite(valor) && valor > 0) {
      const declarada = declaredGoalSavings(state, opts.fullText ? normalizaCenario(opts.fullText) : t)
      const deposito = juntoDoVerbo ? t.slice(juntoDoVerbo.index) : t
      const metas = (state.goals || []).filter(g => !g.done && normalizeName(g.name).length > 2)
      const alvos = metas.filter(g => deposito.includes(normalizeName(g.name)))
      const meta = alvos.length ? alvos.sort((a, b) => b.name.length - a.name.length)[0] : undefined
      const goalName = meta?.name || declarada?.name
        || metas.find(g => t.includes(normalizeName(g.name).split(' ')[0]))?.name
      const explicitWindow = /\b(?:a\s+partir\s+de|ate\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|durante\s+\d+\s+mes|por\s+\d+\s+mes)/.test(t)
      return base('save', { amount: valor, goalName,
        declaredGoalSaved: declarada?.name === goalName ? declarada?.amount : undefined,
        months: explicitWindow ? horizonte(t, opts.today || todayISO()) : 12,
        startMonth: firstSavingMonth(t, opts.today || todayISO()) }, `guardar ${valor} por mês`)
    }
  }

  // ---- compra parcelada ---------------------------------------------------
  const financiada = t.match(new RegExp(String.raw`\b(?:der|dar|dando|dou)\s+(?:r\$\s*)?${NUM}\s*(?:reais\s*)?de\s+entrada\b[^?]{0,50}?\bfinanciar\s+(?:r\$\s*)?${NUM}\s*(?:reais\s*)?(?:em\s+)?(\d{1,3})\s*(?:x|vezes|parcelas)\b`))
  const compra = financiada
    ? { total: parseMoney(financiada[1]) + parseMoney(financiada[2]), installments: Number(financiada[3]), financed: parseMoney(financiada[2]), entry: parseMoney(financiada[1]) }
    : lerCompra(t)
  if (compra && 'issue' in compra) return base('purchase', { planningIssue: compra.issue }, 'comprar parcelado')
  if (compra && 'total' in compra) {
    const atraso = parsePurchaseDelay(opts.fullText || t)
    const entrada = financiada || t.match(new RegExp(String.raw`\b(?:der|dar|dando|com|de)\s+${NUM}\s*(?:reais\s*)?de\s+entrada\b`))
      || t.match(new RegExp(String.raw`\bentrada\s+de\s+(?:r\$\s*)?${NUM}`))
    // Entrada do tamanho do preço, ou maior, não descreve compra parcelada
    // nenhuma: a leitura está errada, e simular seria inventar.
    if (entrada && parseMoney(entrada[1]) >= compra.total) return null
    return base('purchase', {
      amount: compra.total,
      installments: compra.installments,
      downPayment: entrada ? parseMoney(entrada[1]) : undefined,
      purchaseDelayMonths: atraso?.months,
      ...(atraso ? { months: Math.max(6, Math.min(12, atraso.months + 3)) } : {}),
      cardName: cartaoDe(state, t),
      category: categoriaDe(state, t),
      description: descricaoDe(t),
    }, `comprar ${compra.total} em ${compra.installments}x`)
  }

  // ---- gasto avulso -------------------------------------------------------
  // "cabe" e "dá pra" são a forma mais curta de perguntar se um gasto entra no
  // mês: "só quero saber se 500 de obra CABE esse mês". Sem elas a frase caía
  // no texto genérico de ajuda — logo a frase de quem DIZ que não quer
  // registrar nada, e que é justamente quem mais precisa da simulação.
  if (/\bgastar\b|\bgastasse\b|\bpagar\b|\bcomprar\b|\bmeter\b|\btorrar\b|\bcabe\b|\bcaberia\b|\bd[áa]\s+pra\b|\bdaria\s+pra\b|\btenho\s+(?:dinheiro|grana|saldo|bala)\s+(?:pra|para)\b/.test(t)) {
    // O valor tem que ser DINHEIRO: um "1" solto quase sempre e identificador
    // ("Casa 1", "unidade 2"), e simular um gasto de R$ 1,00 e pior que nao
    // simular nada.
    const direct = t.match(new RegExp(String.raw`\b(?:gastar|gastasse|pagar|comprar|meter|torrar)\s+(?:r\$\s*)?${NUM}(?![\d.,]\d)(?!\s*(?:x\b|vezes\b|parcelas?\b|dias?\b|semanas?\b|mes(?:es)?\b|anos?\b|%))`))
    const valor = direct ? parseMoney(direct[1]) : valorDeDinheiro(t, lerValor(t))
    if (valor !== undefined) {
      // "Gastar 500 esse mês" não é gasto de hoje: o texto da simulação diz quando.
      const when = /\b(?:d?esse|d?este|nesse|neste|no)\s+mes\b/.test(t) ? 'este mês' : undefined
      return base('spend', { amount: valor, category: categoriaDe(state, t), ...(when ? { when } : {}) }, `gastar ${valor}`)
    }
  }

  return null
}

/**
 * Interpreta todos os passos suportados da mesma hipótese, preservando ordem.
 * Conjunções internas de financiamento não são separadas: “entrada e
 * financiar” continua sendo uma única compra.
 */
export function planScenario(
  state: AppState, input: string, opts: { today?: string; focusCategory?: string } = {},
): AssistantScenarioPlan | null {
  if (!looksLikeScenario(input)) return null
  const funding = withoutReserveFunding(input)
  const cash = readScenarioBalance(funding ?? input)
  input = cash.remaining
  const partes = input.split(/,(?=\s*[a-zA-ZÀ-ÿ])|\s+(?:e\s+|depois\s+)(?=(?:eu\s+)?(?:ainda\s+|tamb[eé]m\s+)?(?:continuar\s+guardando|pagar|quitar|guardar|poupar|reduzir|diminuir|baixar|parar|cortar|investir|aplicar|ajudar|comprar|gastar)\b)/i)
    .map(p => p.trim()).filter(Boolean)
  const planned = partes.map(p => ({ fragment: p, plan: planSingleScenario(state, p, { ...opts, fullText: input }, true) }))
  const steps = planned.map(p => p.plan).filter((p): p is AssistantScenarioPlan => !!p)
  // Variação do combustível e da distância podem vir em cláusulas separadas.
  // O plano de rodagem já leu as duas condições e precisa ser aplicado uma vez.
  const drivingStep = steps.find(p => p.driving)
  const separateSteps = drivingStep ? steps.filter(p => !p.driving || p === drivingStep) : steps
  const unsupportedFragments = planned.filter(p => !p.plan && /\d|\binvestir\b|\baplicar\b/i.test(normalizeNumberWords(p.fragment).text)
    && !separateSteps.some(step => step.declaredGoalSaved !== undefined
      && declaredGoalSavings(state, normalizaCenario(p.fragment))?.name === step.goalName))
    .map(p => p.fragment)
  const normalized = semAcento(normalizeNumberWords(input).text)
  const planningIssue = horizonProblem(normalized, opts.today || todayISO())
  const startMonth = separateSteps.some(step => step.kind === 'save' || step.kind === 'save-share')
    ? firstSavingMonth(normalized, opts.today || todayISO()) : undefined
  const endMonth = (() => {
    const d = new Date(`${opts.today || todayISO()}T12:00:00`)
    d.setMonth(d.getMonth() + horizonte(normalized, opts.today || todayISO()) - 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })()
  const reserveIssue = funding !== undefined ? RESERVE_SPEND_BALANCE_QUESTION : undefined
  const balance = reserveIssue ? undefined : cash.balance
  const issue = reserveIssue || cash.issue || planningIssue || (startMonth && startMonth > endMonth
    ? 'O início da reserva fica depois do horizonte final; me diga outras datas.' : undefined)
  if (separateSteps.length > 1) {
    const today = opts.today || todayISO()
    const maxIncomeWindow = Math.max(0, ...separateSteps.flatMap(step => {
      if (!step.incomeLossDuration && !step.incomeLossWindow) return []
      const final = step.incomeLossWindow?.to || incomeLossEnd(today, step.incomeLossDuration!)
      return [(Number(final.slice(0, 4)) - Number(today.slice(0, 4))) * 12
        + Number(final.slice(5, 7)) - Number(today.slice(5, 7)) + 1]
    }))
    const months = Math.max(horizonte(normalized, today), Math.min(maxIncomeWindow, 12))
    return {
      version: SCENARIO_DSL_VERSION,
      kind: 'compound',
      declaredBalance: balance,
      steps: separateSteps.map(step => ({ ...step, months })),
      months,
      planningIssue: issue || (maxIncomeWindow > 12 ? 'Para combinar as mudanças, informe um prazo que caiba nos próximos 12 meses do calendário.'
        : separateSteps.find(step => step.planningIssue)?.planningIssue),
      unsupportedFragments,
      label: `cenário com ${separateSteps.length} mudanças`,
    }
  }
  const plan = separateSteps[0] || planSingleScenario(state, input, opts)
  if (plan) return { ...plan, declaredBalance: balance, planningIssue: issue || plan.planningIssue, unsupportedFragments }
  return reserveIssue ? { version: SCENARIO_DSL_VERSION, kind: 'spend', label: 'pagar com a reserva',
    planningIssue: 'Diga o valor do pagamento e quanto ficará disponível na conta depois do resgate. Exemplo de pergunta: “Com saldo em conta de R$ 1.200, dá pra pagar R$ 800?”' } : null
}

/** O objeto da compra, quando a frase o nomeia ("um pc de 4000 em 10x"). */
function descricaoDe(t: string): string | undefined {
  const m = t.match(/\b(?:comprar|comprasse|pegar|meter|parcelar)\s+(?:um|uma|o|a)?\s*([a-z0-9çãõáéíóúâê]{3,20})\b/)
  if (!m) return undefined
  const p = m[1]
  if (/^\d+$/.test(p) || ['mil', 'reais', 'mais', 'isso'].includes(p)) return undefined
  return p
}
