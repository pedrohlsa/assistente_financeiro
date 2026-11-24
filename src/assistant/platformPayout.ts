import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeNumberWords } from './numbers'
import { normalizeName } from '../utils/text'

const MONEY = (name: string) => String.raw`(?:r\$\s*)?(?<${name}>\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(?:\s+reais?)?`
const PLATFORM = String.raw`(?<platform>uber|99|indrive[r]?)\b`
const DATE_LEAD = String.raw`(?<lead>(?:(?:eu|hoje|ontem|anteontem|j[áa])\s+){0,3})`
const TAIL = String.raw`(?<tail>\s*(?:[.;]\s*(?=[\p{L}])|(?:,\s*|\s+)e\s+(?=(?:gastei|paguei|comprei|abasteci|guardei|recebi|ganhei|rodei|trabalhei)\b))[^?]*|[.!]*\s*)$`
const NET = String.raw`(?:l[íi]quid[oa]s?|limp[oa]s?)(?![\wÀ-ÿ])`
const GROSS = String.raw`brut[oa]s?\b`
/** Sem plataforma, só "líquido": "limpo" pode ser depois dos CUSTOS, e aí o app pergunta. */
const SO_LIQUIDO = String.raw`l[íi]quid[oa]s?(?![\wÀ-ÿ])`
const FEE = String.raw`(?:depois\s+d[aeo]\s+taxa|com\s+a\s+taxa\s+descontada)\s+de\s+${MONEY('fee')}`
const WITHHELD_FEE = String.raw`,?\s+(?:j[áa]\s+)?(?:com\s+(?:a\s+)?taxa\s+(?:j[áa]\s+)?(?:retida|descontada)|(?:retida|descontad[oa])\s+(?:a\s+)?taxa)(?:\s+de\s+${MONEY('fee')})?`
const PLATFORM_PAYMENT = String.raw`(?:a\s+|o\s+)?${PLATFORM}\s+(?:(?:me\s+)?pagou|depositou|repassou)\s+${MONEY('gross')}(?:\s+${GROSS})?`
const STATED_FEE = String.raw`(?:com\s+(?:a\s+)?taxa\s+de|(?:j[áa]\s+)?menos\s+(?:a\s+)?taxa\s+de)\s+${MONEY('fee')}`
const PAID_WITH_FEE = new RegExp(String.raw`^${DATE_LEAD}${PLATFORM_PAYMENT}\s+${STATED_FEE}${TAIL}`, 'iu')
const PAID_AND_TOOK_FEE = new RegExp(String.raw`^${DATE_LEAD}${PLATFORM_PAYMENT},?\s+e\s+(?:tirou|descontou|reteve)\s+${MONEY('fee')}\s+de\s+taxa${TAIL}`, 'iu')

/**
 * "A Uber ficou com 80", "a 99 me descontou 25%", "fiz 300 bruto e a Uber
 * levou 75": a parte da plataforma, sem o que caiu na conta. Não é gasto
 * (ela nunca passou pela mão dele) e o líquido não é presumido — pergunta.
 * Antes, "a 99 ficou com 30" perguntava se "R$ 99,00" foi ganho ou gasto.
 */
const KEPT = String.raw`(?:ficou\s+com|levou|comeu|tirou|descontou|reteve|pegou|abocanhou)`
const SHARE = String.raw`(?:(?<pct>\d+(?:[.,]\d+)?)\s*(?:%|por\s*cento)|${MONEY('fee')})`
const KEPT_SHARE = String.raw`(?:a\s+|o\s+)?${PLATFORM}\s+(?:me\s+)?${KEPT}\s+(?:(?:de\s+)?mim\s+)?${SHARE}(?:\s+de\s+(?:taxa|mim|comiss[aã]o))?`
const WHEN = String.raw`(?:\s+(?:hoje|ontem|anteontem))?`
const GROSS_THEN_KEPT = new RegExp(String.raw`^${DATE_LEAD}(?:fiz|ganhei|faturei|deu|rodei)\s+${MONEY('gross')}(?:\s+${GROSS})?(?:\s+(?:n[ao]|pel[ao])\s+(?:uber|99|indrive[r]?))?${WHEN},?\s+(?:e|mas)\s+${KEPT_SHARE}${WHEN}${TAIL}`, 'iu')
const ONLY_KEPT = new RegExp(String.raw`^${DATE_LEAD}${KEPT_SHARE}${WHEN}${TAIL}`, 'iu')

const PAYOUT_PATTERNS = [
  new RegExp(String.raw`^${DATE_LEAD}(?:a\s+|o\s+)?${PLATFORM}\s+recebeu\s+${MONEY('gross')},?\s+e\s+(?:me\s+)?(?:passou|repassou)\s+${MONEY('net')}\s+(?:depois\s+de\s+descontar|j[áa]\s+descontando)\s+${MONEY('fee')}(?:\s+de\s+taxa)?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}${PLATFORM_PAYMENT}\s+${STATED_FEE}(?:,\s*|\s+e\s+|\s+)(?:caiu|ca[ií]ram|entrou|entraram|recebi)\s+(?:(?<whenNet>hoje|ontem|anteontem)\s+)?${MONEY('net')}(?:\s+${NET})?(?:\s+na\s+(?:minha\s+)?conta)?(?:\s+(?<whenTail>hoje|ontem|anteontem))?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:fiz|ganhei|faturei)\s+${MONEY('gross')}\s+${GROSS}\s+(?:n[ao]|pel[ao]|d[ao])\s+${PLATFORM}(?:\s+e\s+|,\s*)(?:recebi|caiu|entrou)\s+${MONEY('net')}\s+${NET}(?:\s+${FEE})?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:na|no|pela|pelo)\s+${PLATFORM}\s+(?:deu|foram)\s+${MONEY('gross')}\s+${GROSS}\s*,\s*${MONEY('net')}\s+${NET}(?:\s+e\s+a\s+taxa\s+(?:ficou\s+em|foi\s+de)\s+${MONEY('fee')})?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}recebi\s+${MONEY('net')}\s+${NET}\s+(?:na|no|pela|pelo|da|do)\s+${PLATFORM}\s*,\s*${MONEY('gross')}\s+(?:era|foi)\s+o\s+${GROSS}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:a\s+|o\s+)?${PLATFORM}\s+descontou\s+${MONEY('fee')}\s+de\s+taxa\s+e\s+(?:caiu|entrou|recebi)\s+${MONEY('net')}(?:\s+na\s+(?:minha\s+)?conta)?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?<reported>(?:recebi|caiu|entrou)\s+${MONEY('net')}(?:\s+(?:n[ao]|d[ao]|pel[ao])\s+${PLATFORM})?)\s+(?:j[áa]\s+)?descontad[oa]\s+(?:a\s+)?taxa\s+de\s+${MONEY('fee')}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:recebi|caiu|entrou)\s+${MONEY('net')}(?:\s+${NET})?\s+(?:n[ao]|d[ao]|pel[ao])\s+${PLATFORM}(?:\s+${NET})?${WITHHELD_FEE}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:(?:o\s+)?(?:saldo|dep[óo]sito)\s+d[ao]\s+|[oa]\s+)?${PLATFORM}\s+(?:veio|caiu|entrou|(?:me\s+)?pagou)\s+${MONEY('net')}(?:\s+${NET})?${WITHHELD_FEE}${TAIL}`, 'iu'),
  // "Faturei 400 bruto, líquido 310", "400 bruto 310 líquido", "bruto 400
  // líquido 310": sem plataforma. O bruto virava a receita e o líquido, que é
  // o dinheiro que entrou, ficava como "o que aconteceu com ele?".
  new RegExp(String.raw`^${DATE_LEAD}(?:(?:fiz|ganhei|faturei|deu|foram|tirei)\s+)?${MONEY('gross')}\s+${GROSS}\s*,?\s+(?:e\s+)?(?:(?:recebi|caiu|entrou|ficou|sobrou|deu|foram)\s+)?(?:o\s+)?${SO_LIQUIDO}\s+(?:(?:foi|deu|ficou)\s+)?${MONEY('net')}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:(?:fiz|ganhei|faturei|deu|foram|tirei)\s+)?${MONEY('gross')}\s+${GROSS}\s*,?\s+(?:e\s+)?(?:(?:recebi|caiu|entrou|ficou|sobrou|deu|foram)\s+)?${MONEY('net')}\s+${SO_LIQUIDO}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:o\s+)?${GROSS}\s+(?:(?:foi|deu)\s+)?${MONEY('gross')}\s*,?\s+(?:e\s+)?(?:o\s+)?${SO_LIQUIDO}\s+(?:(?:foi|deu|ficou)\s+)?${MONEY('net')}${TAIL}`, 'iu'),
]

export type PlatformPayout = { text: string; amount: number } | { issue: string; description?: string }

export const ridePayoutPlatformName = (platform: string): string => /^indriv/i.test(platform) ? 'inDrive' : /^uber$/i.test(platform) ? 'Uber' : '99'

/** Prepara o dinheiro que entrou quando a plataforma já reteve uma taxa. */
export function readPlatformPayout(message: string): PlatformPayout | undefined {
  if (!/\b(?:brut[oa]s?|l[íi]quid[oa]s?|limp[oa]s?|taxa|retida|descont(?:ou|ad[oa]|ar|ando)|ficou\s+com|levou|comeu|tirou|reteve|pegou|abocanhou)\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const match = PAYOUT_PATTERNS.map(pattern => text.match(pattern)).find(Boolean)
  if (!match) {
    const kept = text.match(GROSS_THEN_KEPT) || text.match(ONLY_KEPT)
    if (kept) {
      const { platform, gross, fee, pct } = kept.groups
      const nome = ridePayoutPlatformName(platform)
      const parte = pct ? `${pct.replace('.', ',')}%` : fmtBRL(parseMoney(fee))
      return { description: nome, issue: gross
        ? `Você informou ${fmtBRL(parseMoney(gross))} brutos, e a ${nome} ficou com ${parte}. Qual foi o valor que realmente entrou na conta?`
        : `A parte que a ${nome} fica (${parte}) não entra como gasto: o que vale é o que caiu na sua conta. Quanto você recebeu da ${nome}?` }
    }
    const partial = text.match(PAID_WITH_FEE) || text.match(PAID_AND_TOOK_FEE)
    if (!partial) return undefined
    const { platform, gross, fee } = partial.groups
    return { description: ridePayoutPlatformName(platform),
      issue: `Você informou ${fmtBRL(parseMoney(gross))} e ${fmtBRL(parseMoney(fee))} de taxa. Qual foi o valor que realmente entrou na conta?` }
  }
  const { lead, platform, reported, gross, net, fee, tail, whenNet, whenTail } = match.groups
  const amount = parseMoney(net)
  const beforeFee = parseMoney(gross)
  const withheld = parseMoney(fee)
  const description = platform ? ridePayoutPlatformName(platform) : undefined
  if (!(amount > 0)) return { issue: 'Qual valor você recebeu depois do desconto? Ainda não preparei nenhum lançamento.', description }
  if (gross && (beforeFee < amount || (fee && Math.round((beforeFee - amount) * 100) !== Math.round(withheld * 100)))) {
    return { issue: `Você disse ${fmtBRL(beforeFee)} brutos, ${fmtBRL(amount)} líquidos${fee ? ` e ${fmtBRL(withheld)} de taxa` : ''}. Qual foi o valor que entrou na conta?`, description }
  }
  const normalizedPlatform = /^indriv/i.test(platform || '') ? 'no inDrive' : platform ? `na ${platform}` : ''
  const cash = platform ? `recebi R$ ${net} ${normalizedPlatform} líquido` : reported ? `${reported} líquido` : gross ? `recebi R$ ${net} líquido` : undefined
  if (!cash) return undefined
  const payment = [lead.trim(), whenNet, cash, whenTail].filter(Boolean).join(' ')
  return { amount, text: `${payment}${tail || ''}`.trim() }
}

const PAYOUT_DAY = String.raw`(?:hoje|hj|ontem|anteontem|ha\s+\d+\s+dias?|\d+\s+dias?\s+atras|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)`
const PAYOUT_APP = String.raw`(?:uber|99|indrive[r]?)\b`
const PAYOUT_SOURCE = String.raw`(?:de\s+corridas?|d[aeo]\s+ganhos?\s+d[aeo]\s+app)(?:\s+(?:n[ao]|pel[ao]|d[ao])\s+(?<platform>${PAYOUT_APP}))?|(?:n[ao]|pel[ao]|d[ao])\s+(?<app>${PAYOUT_APP})`

const FUEL_COST = (key: string) => String.raw`(?<${key}>(?:(?:gastei|paguei)\s+)?${MONEY(key + 'Amount')}\s+(?:(?:de|em|com)\s+)?(?:gasolina|gasosa|etanol|alcool|diesel|gnv|combustivel)\b|abasteci\s+${MONEY(key + 'Fill')})`
const UNPAID_LINK = String.raw`(?:mas|porem|so\s+que|e|sendo|incluindo|d[eo]s\s+quais|dess[ea]s?|com)`
const UNPAID_STATUS = String.raw`(?:(?:ainda\s+)?nao\s+(?:caiu|cairam|entrou|entraram|recebi|recebid[oa]s?)|(?:ainda\s+)?(?:vai|vao|(?:esta|estao|ficou|ficaram)\s+(?:para|pra))\s+(?:cair|entrar)|(?:ainda\s+)?(?:ta|tao|esta|estao|ficou|ficaram)\s+pendentes?|(?:so\s+)?(?:cai|entra)(?=\s+amanha)|nao\s+saiu\s+da\s+carteira(?:\s+do\s+app)?(?:\s+ainda)?)`
const UNPAID_AFTER_VALUE = String.raw`(?:(?:os|as)\s+)?${MONEY('unpaid')}(?:\s+(?:d[ao]|n[ao])\s+(?<unpaidApp>${PAYOUT_APP}))?\s+(?:que\s+)?${UNPAID_STATUS}(?:\s+ainda)?`
const TELEGRAPHIC_UNPAID = String.raw`${MONEY('pendingAmount')}\s+pendentes?(?:\s+(?:n[ao]|d[ao])\s+(?<pendingApp>${PAYOUT_APP}))?`
const UNPAID_BEFORE_VALUE = String.raw`(?:ainda\s+)?(?:faltam?\s+(?:(?:cair|entrar)\s+)?|ficou\s+faltando\s+|tem\s+(?=${MONEY('waiting')}\s+(?:pra|para)\s+(?:cair|entrar)))${MONEY('missing')}(?:\s+(?:pra|para)\s+(?:cair|entrar))?`
const RECEIVED_VALUE = String.raw`(?:so|apenas)\s+(?:caiu|cairam|entrou|entraram|recebi)\s+${MONEY('received')}`

const UNPAID_UNSIZED = String.raw`(?<notAll>(?:ainda\s+)?nao\s+(?:caiu|entrou|recebi)\s+(?:tudo|o\s+valor\s+todo|inteir[oa])(?:\s+ainda)?)`
const PAYOUT_WORK = String.raw`(?<work>(?:rodei|trabalhei|dirigi)\s+(?:por\s+)?\d+(?:[.,]\d+)*\s*(?:km|quilometros?|h|horas?))`
const INITIAL_WORK = String.raw`(?<initialWork>\d+(?:[.,]\d+)?\s*(?:h|horas?))`
const PARTIAL_RIDE_PAYOUT = new RegExp([
  String.raw`^(?:(?<lead>${PAYOUT_DAY})\s*,?\s+)?(?:(?:n[ao]|pel[ao])\s+(?<initialApp>${PAYOUT_APP})\s+)?(?:(?:eu\s+)?(?<verb>deu|deram|fiz|ganhei|faturei|recebi|entrou|caiu|d[eo]s?)\s+)?${MONEY('total')}(?:\s+(?:(?<source>${PAYOUT_SOURCE})|(?:em|durante)\s+${INITIAL_WORK}))?(?:\s+(?<day>${PAYOUT_DAY}))?`,
  String.raw`(?:,?\s+(?:e\s+)?${FUEL_COST('before')}(?:\s+(?<beforeDay>${PAYOUT_DAY}))?)?`,
  String.raw`(?:,\s*|\s+)(?:(?<link>${UNPAID_LINK})\s+)?(?:(?<extra>mais|outr[oa]s?)\s+)?(?:${UNPAID_AFTER_VALUE}|${TELEGRAPHIC_UNPAID}|${UNPAID_BEFORE_VALUE}|${RECEIVED_VALUE}|${UNPAID_UNSIZED})`,
  String.raw`(?:\s+na\s+(?:minha\s+)?conta)?(?:\s+(?<settlementDay>${PAYOUT_DAY}|amanha))?`,
  String.raw`(?:[,;]?\s+e\s+${FUEL_COST('after')}(?:\s+(?<afterDay>${PAYOUT_DAY}))?)?`,
  String.raw`(?:(?:[.;,]\s*|\s+e\s+)${PAYOUT_WORK}(?:\s+(?<workDay>${PAYOUT_DAY}))?)?[.!]*$`,
].join(''))

export function readPartialRidePayout(message: string) {
  if (!/\b(?:ainda|n[aã]o|cair|caiu|ca[ií]ram|entrar|entrou|entraram|cai|entra|falta(?:m|ndo)?|recebi|pendentes?)\b/i.test(message)) return undefined
  const parts = normalizeName(normalizeNumberWords(message).text).trim().match(PARTIAL_RIDE_PAYOUT)?.groups
  if (!parts) return undefined
  const { lead, verb, initialApp, initialWork, source, platform, app, day, before, beforeDay, after, afterDay, link, extra, unpaidApp, pendingApp, settlementDay, notAll, work, workDay } = parts
  if (!source && !initialApp && !(initialWork && /^(?:fiz|ganhei|faturei|deu|deram)$/.test(verb || ''))) return undefined
  const total = parseMoney(parts.total)
  const received = parts.received === undefined ? undefined : parseMoney(parts.received)
  const unpaid = notAll ? undefined : received === undefined ? parseMoney(parts.unpaid || parts.pendingAmount || parts.missing)
    : (Math.round(total * 100) - Math.round(received * 100)) / 100
  const paid = /^(?:recebi|entrou|caiu)$/.test(verb)
  const saysIncluded = /^d[eo]s?$/.test(verb) || /^(?:sendo|incluindo|d[eo]s\s+quais|dess[ea]s?)$/.test(link || '')
  const pendingPlatform = unpaidApp || pendingApp
  const namedApps = new Set([platform || app, initialApp].filter(Boolean).map(ridePayoutPlatformName))
  const platformName = namedApps.size === 1 ? namedApps.values().next().value : undefined
  const differentApps = platformName && pendingPlatform && platformName !== ridePayoutPlatformName(pendingPlatform)
  const inclusion = notAll ? undefined : received !== undefined ? true : saysIncluded ? paid || extra || differentApps ? undefined : true : extra || paid || differentApps ? false : undefined
  const companions = [{ text: before, date: beforeDay }, { text: after, date: afterDay }]
    .filter(cost => !!cost.text).map(cost => ({ kind: 'fuel' as const, text: cost.text, date: cost.date || day || lead }))
  return { total, unpaid, received, inclusion, date: received === undefined ? day || lead : settlementDay || day || lead,
    companions: [...companions,
      ...(initialWork ? [{ kind: 'work' as const, text: 'trabalhei ' + initialWork, date: day || lead }] : []),
      ...(work ? [{ kind: 'work' as const, text: work, date: workDay || lead }] : [])],
    platform: platformName }
}

const DEBT_CONTEXT = String.raw`(?:\s+(?:d[aeo]s?|pel[ao]s?)\s+corridas?(?:\s+(?:de\s+)?${PAYOUT_DAY})?)?`
const DEBT_TAIL = String.raw`(?:(?:\s+e\s+|\s*[.;,]\s*)(?<tail>(?:${PAYOUT_DAY}\s+)?(?:abasteci|paguei|gastei|rodei|trabalhei|recebi)\b[^?]*))?[.!]*$`
const RIDE_DEBT = new RegExp(
  String.raw`^(?:[ao]\s+)?(?<platform>${PAYOUT_APP})\s+(?:ainda\s+)?(?:me\s+deve|(?:ta|esta)\s+me\s+devendo|nao\s+(?:me\s+)?pagou)\s+${MONEY('amount')}${DEBT_CONTEXT}${DEBT_TAIL}`,
)
const RIDE_DEBT_REVERSED = new RegExp(
  String.raw`^(?:ainda\s+)?me\s+devem\s+${MONEY('amount')}\s+(?:d[ao]|pel[ao])\s+(?<platform>${PAYOUT_APP})${DEBT_CONTEXT}${DEBT_TAIL}`,
)
const DEBT_TAIL_ORIGINAL = new RegExp(DEBT_TAIL, 'i')

export function readRideDebt(message: string): { platform: string; amount: number; tail?: string } | undefined {
  if (!/\b(?:devendo|devem?|pagou)\b/i.test(message)) return undefined
  const text = normalizeName(normalizeNumberWords(message).text)
  const parts = (text.match(RIDE_DEBT) || text.match(RIDE_DEBT_REVERSED))?.groups
  if (!parts) return undefined
  const amount = parseMoney(parts.amount)
  const tail = parts.tail && (message.match(DEBT_TAIL_ORIGINAL)?.groups.tail || parts.tail)
  return amount > 0 ? { platform: ridePayoutPlatformName(parts.platform), amount, tail } : undefined
}

export function partialRidePayoutChoice(message: string, total?: number, unpaid?: number): string | undefined {
  const text = normalizeName(normalizeNumberWords(message).text).replace(/[.!]+$/, '').trim()
  const confirmedUnpaid = text.match(/^(?:(?:sim|isso),?\s+)?(?:ja\s+)?inclu(?:i|em|ia)\s+(?:os\s+)?(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?$/)
  if (confirmedUnpaid && parseMoney(confirmedUnpaid[1]) === unpaid) return 'included'
  const included = text.match(/^(?:(?:os\s+)?([\d.,]+)\s+)?(?:sim|(?:sim,?\s+)?(?:ja\s+)?(?:(?:esta|estao|ta|tao)\s+)?incluid[oa]s?|(?:ja\s+)?(?:esta|estao|ta|tao|entram?)\s+(?:nos|dentro(?:\s+d[eo]s)?|incluid[oa]s?\s+(?:nos|no\s+total))(?:\s+(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?)?|sao\s+dentro(?:\s+d[eo]s?\s+(?:r\$\s*)?([\d.,]+))?|faz(?:em)?\s+parte(?:\s+do\s+total)?)$/)
  if (included && (!included[1] || parseMoney(included[1]) === unpaid)
    && (!(included[2] || included[3]) || parseMoney(included[2] || included[3]) === total)) return 'included'
  const outside = text.match(/^(?:os\s+)?(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?\s+(?:e|sao)\s+(?:de fora|por fora|a parte|a mais)$/)
  if (outside && parseMoney(outside[1]) === unpaid) return 'excluded'
  const excluded = text.match(/^(?:nao|nao,?\s+(?:(?:esta|estao|ta|tao)\s+)?incluid[oa]s?|(?:(?:e|sao|ficou|ficaram)\s+)?(?:por\s+fora|de\s+fora|a\s+parte|a\s+mais)|(?:os\s+)?([\d.,]+)\s+ja\s+(?:cairam|entraram)(?:\s+(?:inteir[oa]s?|todos))?)$/)
  if (excluded && (!excluded[1] || parseMoney(excluded[1]) === total)) return 'excluded'
  return undefined
}
