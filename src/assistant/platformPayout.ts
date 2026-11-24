import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeNumberWords } from './numbers'
import { normalizeName } from '../utils/text'

const MONEY = (name: string) => String.raw`(?:r\$\s*)?(?<${name}>\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(?:\s+reais?)?`
const PAYOUT_APP = String.raw`(?:uber|99|in\s*drive[r]?)\b`
const PLATFORM = String.raw`(?<platform>${PAYOUT_APP})`
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
const KEPT_PERCENT_OF_GROSS = String.raw`(?:a\s+|o\s+)?${PLATFORM}\s+(?:me\s+)?${KEPT}\s+(?<pct>\d+(?:[.,]\d+)?)\s*(?:%|por\s+cento)\s+d[eo]s?\s+(?:o\s+)?${MONEY('gross')}(?:\s+${GROSS})?`
const ONLY_KEPT_PERCENT = new RegExp(String.raw`^${DATE_LEAD}${KEPT_PERCENT_OF_GROSS}${WHEN}${TAIL}`, 'iu')

const PAYOUT_PATTERNS = [
  new RegExp(String.raw`^${DATE_LEAD}${KEPT_PERCENT_OF_GROSS}(?:[;,]\s*|\s+e\s+)(?:caiu|ca[ií]ram|entrou|entraram|recebi)\s+(?:(?<whenNet>hoje|ontem|anteontem)\s+)?${MONEY('net')}(?:\s+na\s+(?:minha\s+)?conta)?(?:\s+(?<whenTail>hoje|ontem|anteontem))?${TAIL}`, 'iu'),
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

export const ridePayoutPlatformName = (platform: string): string => /^in\s*driv/i.test(platform) ? 'inDrive' : /^uber$/i.test(platform) ? 'Uber' : '99'

/** Prepara o dinheiro que entrou quando a plataforma já reteve uma taxa. */
export function readPlatformPayout(message: string): PlatformPayout | undefined {
  if (!/\b(?:brut[oa]s?|l[íi]quid[oa]s?|limp[oa]s?|taxa|retida|descont(?:ou|ad[oa]|ar|ando)|ficou\s+com|levou|comeu|tirou|reteve|pegou|abocanhou)\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const match = PAYOUT_PATTERNS.map(pattern => text.match(pattern)).find(Boolean)
  if (!match) {
    const kept = text.match(GROSS_THEN_KEPT) || text.match(ONLY_KEPT_PERCENT) || text.match(ONLY_KEPT)
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
  const { lead, platform, reported, gross, net, fee, pct, tail, whenNet, whenTail } = match.groups
  const amount = parseMoney(net)
  const beforeFee = parseMoney(gross)
  const withheld = parseMoney(fee)
  const description = platform ? ridePayoutPlatformName(platform) : undefined
  if (!(amount > 0)) return { issue: 'Qual valor você recebeu depois do desconto? Ainda não preparei nenhum lançamento.', description }
  if (pct) {
    const percentage = Number(pct.replace(',', '.'))
    const grossInCents = Math.round(beforeFee * 100)
    const feeInCents = Math.round(grossInCents * percentage / 100)
    if (percentage > 100 || Math.round(amount * 100) !== grossInCents - feeInCents) {
      return { issue: `Você disse ${fmtBRL(beforeFee)} brutos, ${pct.replace('.', ',')}% de taxa e ${fmtBRL(amount)} recebidos. Os valores não fecham. Quanto entrou na conta?`, description }
    }
  }
  if (gross && (beforeFee < amount || (fee && Math.round((beforeFee - amount) * 100) !== Math.round(withheld * 100)))) {
    return { issue: `Você disse ${fmtBRL(beforeFee)} brutos, ${fmtBRL(amount)} líquidos${fee ? ` e ${fmtBRL(withheld)} de taxa` : ''}. Qual foi o valor que entrou na conta?`, description }
  }
  const normalizedPlatform = description === 'inDrive' ? 'no inDrive' : description ? `na ${description}` : ''
  const cash = platform ? `recebi R$ ${net} ${normalizedPlatform} líquido` : reported ? `${reported} líquido` : gross ? `recebi R$ ${net} líquido` : undefined
  if (!cash) return undefined
  const payment = [lead.trim(), whenNet, cash, whenTail].filter(Boolean).join(' ')
  return { amount, text: `${payment}${tail || ''}`.trim() }
}

const PAYOUT_DAY = String.raw`(?:hoje|hj|ontem|anteontem|ha\s+\d+\s+dias?|\d+\s+dias?\s+atras|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)`
const PAYOUT_SCHEDULE = String.raw`(?:${PAYOUT_DAY}|amanha|(?:na\s+)?(?:segunda|terca|quarta|quinta|sexta)(?:-feira)?|(?:no\s+)?(?:sabado|domingo))`
const PAYOUT_SOURCE = String.raw`(?:de\s+corridas?|d[aeo]\s+ganhos?\s+d[aeo]\s+app)(?:\s+(?:n[ao]|pel[ao]|d[ao])\s+(?<platform>${PAYOUT_APP}))?|(?:n[ao]|pel[ao]|d[ao])\s+(?<app>${PAYOUT_APP})`

const FUEL_LABEL = String.raw`(?:gasolina|gasosa|etanol|alcool|diesel|gnv|combustivel)\b`
const FUEL_COST = (key: string) => [
  String.raw`(?<${key}>(?:(?:gastei|paguei|botei|coloquei)\s+)?${MONEY(key + 'Amount')}\s+(?:(?:de|em|com|n[ao])\s+)?${FUEL_LABEL}`,
  String.raw`abasteci\s+${MONEY(key + 'Fill')}`,
  String.raw`(?<${key}Label>${FUEL_LABEL})\s+${MONEY(key + 'AfterLabel')}`,
  String.raw`(?<${key}Liters>\d+(?:[.,]\d+)?)\s*(?:litros?|l)\s+de\s+(?<${key}VolumeFuel>${FUEL_LABEL})\s+(?:(?:que\s+)?cust(?:ou|aram)|por)\s+${MONEY(key + 'VolumeCost')})`,
].join('|')
const UNPAID_LINK = String.raw`(?:mas|porem|so\s+que|e|sendo|incluindo|d[eo]s\s+quais|dess[ea]s?|com)`
const UNPAID_STATUS = String.raw`(?:(?:ainda\s+)?nao\s+(?:caiu|cairam|entrou|entraram|recebi|recebid[oa]s?)|(?:ainda\s+)?(?:vai|vao|(?:ta|tao|esta|estao|ficou|ficaram)\s+(?:para|pra)|(?:para|pra))\s+(?:cair|entrar)|(?:ainda\s+)?(?:ta|tao|esta|estao|ficou|ficaram)\s+pendentes?|(?:so\s+)?(?:cai|entra)(?=\s+amanha)|(?:ainda\s+)?(?:ta|tao|esta|estao|ficou|ficaram)\s+(?:pres[oa]s?|bloquead[oa]s?)\s+(?:no\s+(?:app|aplicativo)|na\s+carteira(?:\s+do\s+app)?)|nao\s+saiu\s+da\s+carteira(?:\s+do\s+app)?(?:\s+ainda)?)`
const UNPAID_AFTER_VALUE = String.raw`(?:(?:os|as)\s+)?${MONEY('unpaid')}(?:\s+(?:d[ao]|n[ao])\s+(?<unpaidApp>${PAYOUT_APP}))?\s+(?:que\s+)?${UNPAID_STATUS}(?:\s+ainda)?`
const TELEGRAPHIC_UNPAID = String.raw`${MONEY('pendingAmount')}\s+pendentes?(?:\s+(?:n[ao]|d[ao])\s+(?<pendingApp>${PAYOUT_APP}))?`
const UNPAID_BEFORE_VALUE = String.raw`(?:ainda\s+)?(?:faltam?\s+(?:(?:cair|entrar)\s+)?|(?:ficou|ta|esta)\s+faltando\s+|tem\s+(?=${MONEY('waiting')}\s+(?:pra|para)\s+(?:cair|entrar)))${MONEY('missing')}(?:\s+(?:pra|para)\s+(?:cair|entrar)|\s+do\s+repasse)?(?:\s+(?:so\s+)?(?:d[ao]|n[ao])\s+(?<missingApp>${PAYOUT_APP})|\s+del[ae])?`
const UNPAID_BY_APP = String.raw`(?:[ao]\s+)?(?<owingApp>${PAYOUT_APP})\s+(?:ainda\s+)?nao\s+(?:me\s+)?(?:pagou|repassou|depositou)\s+(?:(?:o|os)\s+)?${MONEY('owingAmount')}`
const RECEIPT_VERB = String.raw`(?:caiu|cairam|entrou|entraram|recebi)`
const RESTRICTIVE = String.raw`(?:so|apenas|somente)`
const RECEIVED_VALUE = String.raw`(?:(?<restrictive>${RESTRICTIVE})\s+)?${RECEIPT_VERB}\s+(?:(?<restrictiveAfter>${RESTRICTIVE})\s+)?${MONEY('received')}`
const RECEIVED_REMAINDER = String.raw`(?:[;,]?\s+(?:e\s+)?(?:faltam?\s+${MONEY('reportedUnpaid')}|faltou\s+o\s+restante|(?:os|as)\s+outr[oa]s?\s+${MONEY('unpaidRemainder')}\s+${UNPAID_STATUS}))`

const UNPAID_UNSIZED = String.raw`(?<notAll>(?:ainda\s+)?nao\s+(?:caiu|entrou|recebi)\s+(?:tudo|o\s+valor\s+todo|inteir[oa])(?:\s+ainda)?)`
const UNPAID_ALL = String.raw`(?<nothingPaid>(?:(?:ainda\s+)?nao\s+(?:recebi|caiu|entrou)\s+nada|nenhum\s+(?:repasse|pagamento)\s+(?:caiu|entrou))(?:\s+ainda)?)`
const HELD_PAYOUT = String.raw`(?<heldPayout>(?:(?:o\s+)?(?:aplicativo|app|plataforma)\s+)?(?:reteve|segurou|bloqueou)\s+${MONEY('heldAmount')}\s+(?:do|no)\s+repasse)`
const PAYOUT_WORK = String.raw`(?<work>(?:rodei|trabalhei|dirigi)\s+(?:por\s+)?\d+(?:[.,]\d+)*\s*(?:km|quilometros?|h|horas?)|(?<wheelTime>\d+(?:[.,]\d+)?\s*(?:h|horas?))\s+no\s+volante)`
const INITIAL_WORK = String.raw`(?<initialWork>\d+(?:[.,]\d+)?\s*(?:h|horas?))`
const PARTIAL_RIDE_PAYOUT = new RegExp([
  String.raw`^(?:(?<lead>${PAYOUT_DAY})\s*,?\s+)?(?:(?:n[ao]|pel[ao]|d[ao])\s+(?<initialApp>${PAYOUT_APP})\s+)?(?:(?:eu\s+)?(?<verb>deu|deram|foi|fiz|ganhei|faturei|recebi|entrou|caiu|d[eo]s?|d[eo]\s+total(?:\s+de)?|(?:o\s+)?total\s+foi)\s+)?(?:(?:d[ao]|n[ao]|pel[ao])\s+(?<platformBeforeValue>${PAYOUT_APP})\s+)?${MONEY('total')}(?:\s+(?:(?:que\s+(?:fiz|ganhei|faturei)\s+)?(?<source>${PAYOUT_SOURCE})|(?:em|durante)\s+${INITIAL_WORK}))?(?:\s+(?<day>${PAYOUT_DAY}))?`,
  String.raw`(?:,?\s+(?:e\s+)?${FUEL_COST('before')}(?:\s+(?<beforeDay>${PAYOUT_DAY}))?)?`,
  String.raw`(?:[,.]\s*|\s+)(?:(?<link>${UNPAID_LINK})\s+)?(?:(?<extra>mais|(?:(?:os|as)\s+)?outr[oa]s?)\s+)?(?:(?<approximate>uns|umas|cerca\s+de|mais\s+ou\s+menos)\s+)?(?:${UNPAID_AFTER_VALUE}|${TELEGRAPHIC_UNPAID}|${UNPAID_BEFORE_VALUE}|${UNPAID_BY_APP}|${RECEIVED_VALUE}|${UNPAID_UNSIZED}|${UNPAID_ALL}|${HELD_PAYOUT})`,
  String.raw`(?:\s+(?:na\s+(?:minha\s+)?conta|no\s+pix))?(?:\s+(?<settlementDay>${PAYOUT_SCHEDULE}))?`,
  String.raw`${RECEIVED_REMAINDER}?`,
  String.raw`(?:(?:[,;]\s*(?:(?:e|com)\s+)?|\s+(?:e|com)\s+)${FUEL_COST('after')}(?:\s+(?<afterDay>${PAYOUT_DAY}))?)?`,
  String.raw`(?:(?:[.;,]\s*|\s+e\s+)${PAYOUT_WORK}(?:\s+(?<workDay>${PAYOUT_DAY}))?)?[.!]*$`,
].join(''))

export function readPartialRidePayout(message: string) {
  if (!/\b(?:ainda|n[aã]o|cair|caiu|ca[ií]ram|entrar|entrou|entraram|cai|entra|falta(?:m|ndo)?|recebi|nenhum|reteve|segurou|bloqueou|pendentes?|pres[oa]s?|bloquead[oa]s?)\b/i.test(message)) return undefined
  const parts = normalizeName(normalizeNumberWords(message).text).trim().match(PARTIAL_RIDE_PAYOUT)?.groups
  if (!parts) return undefined
  const { lead, verb, initialApp, initialWork, source, platform, app, day, beforeDay, afterDay, link, extra, unpaidApp, pendingApp, missingApp, settlementDay, notAll, nothingPaid, heldPayout, work, workDay, restrictive, restrictiveAfter } = parts
  const reportedUnpaid = parts.reportedUnpaid ?? parts.unpaidRemainder
  if (!source && !initialApp && !parts.platformBeforeValue && !(initialWork && /^(?:fiz|ganhei|faturei|deu|deram)$/.test(verb || ''))) return undefined
  const total = parseMoney(parts.total)
  const received = parts.received === undefined ? (nothingPaid ? 0 : undefined) : parseMoney(parts.received)
  if (parts.received !== undefined && !restrictive && !restrictiveAfter && !reportedUnpaid && verb !== 'faturei') return undefined
  if (reportedUnpaid && parts.received === undefined) return undefined
  const unknownReceived = notAll || heldPayout || parts.approximate
  const unpaid = unknownReceived ? undefined : received === undefined ? parseMoney(parts.unpaid || parts.pendingAmount || parts.missing || parts.owingAmount)
    : (Math.round(total * 100) - Math.round(received * 100)) / 100
  const paid = /^(?:recebi|entrou|caiu)$/.test(verb)
  const saysIncluded = /^d[eo](?:s|\s+total(?:\s+de)?)?$/.test(verb) || /^(?:sendo|incluindo|d[eo]s\s+quais|dess[ea]s?)$/.test(link || '')
  const pendingPlatform = unpaidApp || pendingApp || missingApp || parts.owingApp
  const namedApps = new Set([platform || app, initialApp, parts.platformBeforeValue].filter(Boolean).map(ridePayoutPlatformName))
  const platformName = namedApps.size === 1 ? namedApps.values().next().value : undefined
  const differentApps = platformName && pendingPlatform && platformName !== ridePayoutPlatformName(pendingPlatform)
  const inclusion = unknownReceived ? undefined : received !== undefined ? true : saysIncluded ? paid || extra || differentApps ? undefined : true : extra || paid || differentApps ? false : undefined
  const fuelCompanion = (key: 'before' | 'after', date?: string) => {
    const cost = parts[key]
    if (!cost) return []
    const label = parts[key + 'Label']
    const liters = parts[key + 'Liters']
    const text = liters ? `abasteci ${liters} litros de ${parts[key + 'VolumeFuel']} por R$ ${parts[key + 'VolumeCost']}`
      : label ? `${parts[key + 'AfterLabel']} de ${label}` : cost
    return [{ kind: 'fuel' as const, text, date: date || day || lead }]
  }
  const companions = [
    ...fuelCompanion('before', beforeDay),
    ...fuelCompanion('after', afterDay || (received !== undefined ? settlementDay : undefined)),
  ]
  return { total, unpaid, received, inclusion, date: received === undefined ? day || lead : settlementDay || day || lead,
    companions: [...companions,
      ...(initialWork ? [{ kind: 'work' as const, text: 'trabalhei ' + initialWork, date: day || lead }] : []),
      ...(work ? [{ kind: 'work' as const, text: parts.wheelTime ? 'trabalhei ' + parts.wheelTime : work, date: workDay || lead }] : [])],
    platform: platformName, inconsistent: reportedUnpaid !== undefined && Math.round(parseMoney(reportedUnpaid) * 100) !== Math.round(unpaid * 100) }
}

const SHIFT_WITH_UNPAID_PAYOUT = new RegExp(
  String.raw`^(?<shift>.+?)(?:[,.;]\s*|\s+)(?:mas|porem|so\s+que)\s+(?:${UNPAID_AFTER_VALUE}|${UNPAID_BEFORE_VALUE})(?:\s+na\s+(?:minha\s+)?conta)?(?:\s+${PAYOUT_SCHEDULE})?[.!]*$`,
)

export function readShiftWithUnpaidPayout(message: string) {
  if (!/\b(?:mas|por[ée]m|s[oó]\s+que)\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeName(normalizeNumberWords(message).text).trim()
  const parts = text.match(SHIFT_WITH_UNPAID_PAYOUT)?.groups
  if (!parts) return undefined
  const amount = parseMoney(parts.unpaid || parts.missing)
  const platform = parts.unpaidApp || parts.missingApp
  return amount > 0 ? { text: parts.shift, amount, platform: platform ? ridePayoutPlatformName(platform) : undefined } : undefined
}

const SETTLEMENT_REMAINDER = String.raw`(?<pendingRest>(?:[,;]\s*|\s+e\s+)(?:(?:o\s+(?:resto|restante)|os\s+outros|as\s+outras)\s+(?:(?:ficou|ficaram|esta|estao|ta|tao)\s+pendentes?|(?:ainda\s+)?nao\s+(?:caiu|cairam|entrou|entraram))))`
const RIDE_SETTLEMENT = new RegExp(
  String.raw`^(?:[ao]\s+)?(?<payer>${PAYOUT_APP})\s+(?:me\s+)?(?<verb>pagou|repassou|depositou|transferiu|fez\s+(?:(?:o|um)\s+)?pix\s+de)\s+(?:(?<reference>os|o|mais|so|apenas|somente)\s+)?${MONEY('amount')}(?:\s+dos\s+${MONEY('coveredTotal')})?(?:\s+(?:d[ao]|pel[ao])\s+(?<origin>${PAYOUT_APP}))?${SETTLEMENT_REMAINDER}?[.!]*$`,
)
const RIDE_INFLECTED_RECEIPT = new RegExp(
  String.raw`^${MONEY('amount')}\s+(?:so|apenas|somente)\s+(?:caiu|cairam|entrou|entraram)\s+(?:d[ao]|pel[ao])\s+(?<payer>${PAYOUT_APP})[.!]*$`,
)

export function hasRideSettlementVerb(message: string): boolean {
  return /\b(?:pagou|repassou|depositou|transferiu|fez\s+(?:(?:o|um)\s+)?pix|caiu|ca[ií]ram|entrou|entraram)\b/i.test(message)
}

export function readRideSettlement(message: string) {
  if (!hasRideSettlementVerb(message)) return undefined
  const text = normalizeName(normalizeNumberWords(message).text)
  const standard = text.match(RIDE_SETTLEMENT)?.groups
  const parts = standard || text.match(RIDE_INFLECTED_RECEIPT)?.groups
  if (!parts) return undefined
  const amount = parseMoney(parts.amount)
  if (!(amount > 0)) return undefined
  return { amount, payer: ridePayoutPlatformName(parts.payer), reference: parts.reference,
    explicitPayment: !standard || /^fez\b/.test(parts.verb), pendingRest: !!parts.pendingRest,
    coveredTotal: parts.coveredTotal ? parseMoney(parts.coveredTotal) : undefined,
    origin: parts.origin ? ridePayoutPlatformName(parts.origin) : undefined }
}

const EXACT_PAYOUT_APP = new RegExp(String.raw`^${PAYOUT_APP}$`, 'i')

export function readRidePayoutApp(text: string): string | undefined {
  return EXACT_PAYOUT_APP.test(text) ? ridePayoutPlatformName(text) : undefined
}

const REPORTED_THEN_RECEIVED = new RegExp([
  String.raw`^(?<report>.+?)`,
  String.raw`(?:[,;.]+\s*(?:e\s+)?|\s+e\s+)(?:(?<only>so|apenas|somente)\s+)?(?:recebi|caiu|cairam|entrou|entraram|veio|vieram)`,
  String.raw`(?:\s+(?:(?<reference>os|o|so|apenas|somente|mais)\s+)?${MONEY('net')}(?:\s+na\s+(?:minha\s+)?conta)?)?${SETTLEMENT_REMAINDER}?\s*[.!]*$`,
].join(''))
const SINGLE_RIDE_REPORT = new RegExp(
  String.raw`^(?:eu\s+)?(?<earned>fiz|ganhei|faturei)\s+${MONEY('total')}\s+(?:n[ao]|d[ao]|pel[ao])\s+${PLATFORM}$`,
)
const PAYOUT_DATE_PART = new RegExp(
  String.raw`^\s*,?\s*mas\s+${MONEY('part')}\s+(?:e|sao|era|eram|foi|foram)\s+d[eoa]\s*$`,
)

export function readRideReportThenReceipt(text: string) {
  const parts = normalizeName(normalizeNumberWords(text).text).trim().match(REPORTED_THEN_RECEIVED)?.groups
  if (!parts) return undefined
  const report = parts.report.trim()
  const named = report.match(SINGLE_RIDE_REPORT)?.groups
  const amount = parts.net === undefined ? undefined : parseMoney(parts.net)
  if (amount !== undefined && !(amount > 0)) return undefined
  const relation: 'same' | 'separate' | undefined = parts.pendingRest ? 'same' : parts.reference === 'mais' ? 'separate' : parts.only || parts.reference || named?.earned === 'faturei' ? 'same' : undefined
  return { report, platform: named ? ridePayoutPlatformName(named.platform) : undefined, total: named ? parseMoney(named.total) : undefined, amount, relation }
}

export function readPayoutDatePart(text: string): number | undefined {
  const parts = normalizeName(normalizeNumberWords(text).text).match(PAYOUT_DATE_PART)?.groups
  const value = parseMoney(parts?.part)
  return value > 0 ? value : undefined
}

const DEBT_PERIOD = String.raw`(?:${PAYOUT_SCHEDULE}|(?:(?:da|na)\s+)?semana\s+passada|(?:d[eo]|n[eo])\s+mes\s+passado|(?:d?ess[ea]|d?est[ea])\s+(?:semana|mes))`
const DEBT_CONTEXT = String.raw`(?:\s+(?:d[aeo]s?|pel[ao]s?)\s+corridas?)?(?:\s+(?:(?:de|desde)\s+)?${DEBT_PERIOD})?(?:\s+ainda)?`
const DEBT_TAIL = String.raw`(?:(?:\s+e\s+|\s*[.;,]\s*(?:(?:mas|e)\s+)?)(?<tail>(?:${PAYOUT_DAY}\s+)?(?:abasteci|paguei|gastei|rodei|trabalhei|recebi)\b[^?]*))?[.!]*$`
const RIDE_DEBT = new RegExp(
  String.raw`^(?:[ao]\s+)?(?<platform>${PAYOUT_APP})\s+(?:ainda\s+)?(?:me\s+deve|(?:ta|esta)\s+(?:me\s+)?devendo|nao\s+(?:me\s+)?(?:pagou|repassou|depositou))\s+(?:(?:o|os|meus)\s+)?${MONEY('amount')}${DEBT_CONTEXT}${DEBT_TAIL}`,
)
const DEBT_SOURCE = String.raw`\s+(?:d[ao]|n[ao]|pel[ao])\s+(?<platform>${PAYOUT_APP})${DEBT_CONTEXT}${DEBT_TAIL}`
const RIDE_DEBT_REVERSED = new RegExp(String.raw`^(?:ainda\s+)?me\s+devem\s+${MONEY('amount')}${DEBT_SOURCE}`)
const RIDE_DEBT_EXPECTED = new RegExp(
  String.raw`^(?:eu\s+)?(?:tenho|tem)\s+${MONEY('amount')}\s+(?:para|pra|a)\s+(?:receber|cair|entrar)${DEBT_SOURCE}`,
)
const RIDE_DEBT_PENDING = new RegExp(
  String.raw`^(?:(?:ainda\s+)?(?:ta|esta|ficou)\s+pendente|(?:ainda\s+)?(?:falta|faltou)\s+(?:cair|entrar))\s+${MONEY('amount')}${DEBT_SOURCE}`,
)
const RIDE_DEBT_STATUS = new RegExp(
  String.raw`^(?:${PAYOUT_DAY}\s+)?(?:(?:ainda\s+)?tem\s+)?${UNPAID_AFTER_VALUE}(?:\s+${PAYOUT_SCHEDULE})?${DEBT_TAIL}`,
)
const RIDE_DEBT_BALANCE = new RegExp(
  String.raw`^(?:ganhei|fiz|faturei)\s+(?:d[ao]|n[ao]|pel[ao])\s+(?<platform>${PAYOUT_APP})\s+(?:um\s+)?(?:saldo|repasse)\s+de\s+${MONEY('amount')}\s+(?:que\s+)?${UNPAID_STATUS}(?:\s+${PAYOUT_SCHEDULE})?${DEBT_TAIL}`,
)
const RIDE_DEBT_WAITING = new RegExp(
  String.raw`^(?:${PAYOUT_SCHEDULE}\s+)?(?:eu\s+)?(?:ainda\s+)?(?:(?:espero|(?:(?:to|estou|fico)\s+)?(?:esperando|aguardando))\s+(?:(?:cair|entrar|receber)\s+)?|(?:vai|vao)\s+(?:cair|entrar|receber)\s+)${MONEY('amount')}${DEBT_SOURCE}`,
)
const RIDE_DEBT_WILL_PAY = new RegExp(
  String.raw`^(?:${PAYOUT_SCHEDULE}\s+)?(?:[ao]\s+)?${PLATFORM}\s+(?:ainda\s+)?vai\s+(?:me\s+)?(?:pagar|repassar|depositar)\s+${MONEY('amount')}${DEBT_CONTEXT}${DEBT_TAIL}`,
)
const DEBT_TAIL_ORIGINAL = new RegExp(DEBT_TAIL, 'i')

export function readRideDebt(message: string): { platform: string; amount: number; tail?: string } | undefined {
  if (!/\b(?:devendo|devem?|pagou|repassou|depositou|pagar|depositar|repassar|receber|cair|caiu|ca[ií]ram|entrar|entrou|entraram|pendente|esperando|aguardando|espero|pres[oa]s?|bloquead[oa]s?)\b/i.test(message)) return undefined
  const text = normalizeName(normalizeNumberWords(message).text)
  const parts = (text.match(RIDE_DEBT) || text.match(RIDE_DEBT_REVERSED) || text.match(RIDE_DEBT_EXPECTED) || text.match(RIDE_DEBT_PENDING)
    || text.match(RIDE_DEBT_STATUS) || text.match(RIDE_DEBT_BALANCE) || text.match(RIDE_DEBT_WAITING) || text.match(RIDE_DEBT_WILL_PAY))?.groups
  const platform = parts?.platform || parts?.unpaidApp
  if (!platform) return undefined
  const amount = parseMoney(parts.amount || parts.unpaid)
  const tail = parts.tail && (message.match(DEBT_TAIL_ORIGINAL)?.groups.tail || parts.tail)
  return amount > 0 ? { platform: ridePayoutPlatformName(platform), amount, tail } : undefined
}

// Só inverte quando o relato anterior tem um verbo de despesa ou jornada.
export function readRideDebtAfterActivity(message: string) {
  if (message.includes('?') || !/^(?:(?:eu|hoje|hj|ontem|anteontem|j[áa])\s+)*(?:abasteci|paguei|gastei|trabalhei|rodei)\b/i.test(message.trim())) return undefined
  const separators = /(?:[,.]\s+|;\s*)(?:(?:e|mas)\s+)?|\s+(?:e|mas)\s+/gi
  for (const separator of message.matchAll(separators)) {
    const at = separator.index
    const debt = readRideDebt(message.slice(at + separator[0].length))
    if (debt) {
      const tail = [message.slice(0, at).trim(), debt.tail].filter(Boolean).join('; ')
      return { ...debt, tail }
    }
  }
  return undefined
}

const RIDE_WALLET = new RegExp(
  String.raw`^(?:a\s+)?carteira\s+d[ao]\s+(?<platform>${PAYOUT_APP})\s+(?:ainda\s+)?(?:ficou\s+com|(?:ta|esta)\s+com|tem)\s+${MONEY('amount')}${DEBT_TAIL}`,
)
const WALLET_PAYMENT = new RegExp(
  String.raw`^(?:(?<lead>${PAYOUT_DAY})\s+)?(?:recebi|caiu|cairam|entrou|entraram)\s+${MONEY('received')}(?:\s+na\s+(?:minha\s+)?conta|\s+no\s+pix)?(?:\s+(?<day>${PAYOUT_DAY}))?[.!]*$`,
)

export function readRideWallet(message: string): { platform: string; amount: number; tail?: string } | undefined {
  if (!/\bcarteira\b/i.test(message) || message.includes('?')) return undefined
  const parts = normalizeName(normalizeNumberWords(message).text).match(RIDE_WALLET)?.groups
  if (!parts) return undefined
  const platform = ridePayoutPlatformName(parts.platform)
  const amount = parseMoney(parts.amount)
  const receipt = parts.tail?.match(WALLET_PAYMENT)?.groups
  const tail = receipt ? [receipt.lead, `recebi R$ ${receipt.received} ${platform === 'inDrive' ? 'no' : 'na'} ${platform}`, receipt.day].filter(Boolean).join(' ')
    : parts.tail && (message.match(DEBT_TAIL_ORIGINAL)?.groups.tail || parts.tail)
  return { platform, amount, tail }
}

export function partialRidePayoutChoice(message: string, total?: number, unpaid?: number): string | undefined {
  const text = normalizeName(normalizeNumberWords(message).text).replace(/[.!]+$/, '').trim()
  const confirmedUnpaid = text.match(/^(?:(?:sim|isso),?\s+)?(?:ja\s+)?inclu(?:i|em|ia)\s+(?:os\s+)?(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?$/)
  if (confirmedUnpaid && parseMoney(confirmedUnpaid[1]) === unpaid) return 'included'
  if (/^(?:ja\s+)?(?:esta|estao|ta|tao|entra|entram)\s+no\s+total$/.test(text)) return 'included'
  const included = text.match(/^(?:(?:os\s+)?([\d.,]+)\s+)?(?:sim|(?:sim,?\s+)?(?:ja\s+)?(?:(?:esta|estao|ta|tao)\s+)?incluid[oa]s?|(?:ja\s+)?(?:esta|estao|ta|tao|entram?)\s+(?:nos|dentro(?:\s+d[eo]s)?|incluid[oa]s?\s+(?:nos|no\s+total))(?:\s+(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?)?|sao\s+dentro(?:\s+d[eo]s?\s+(?:r\$\s*)?([\d.,]+))?|faz(?:em)?\s+parte(?:\s+do\s+total)?)$/)
  if (included && (!included[1] || parseMoney(included[1]) === unpaid)
    && (!(included[2] || included[3]) || parseMoney(included[2] || included[3]) === total)) return 'included'
  const outside = text.match(/^(?:os\s+)?(?:r\$\s*)?([\d.,]+)(?:\s+reais?)?\s+(?:e|sao)\s+(?:de fora|por fora|a parte|a mais)$/)
  if (outside && parseMoney(outside[1]) === unpaid) return 'excluded'
  const excluded = text.match(/^(?:nao|nao,?\s+(?:(?:esta|estao|ta|tao)\s+)?incluid[oa]s?|(?:(?:e|sao|ficou|ficaram)\s+)?(?:por\s+fora|de\s+fora|a\s+parte|a\s+mais)|(?:os\s+)?([\d.,]+)\s+ja\s+(?:cairam|entraram)(?:\s+(?:inteir[oa]s?|todos))?)$/)
  if (excluded && (!excluded[1] || parseMoney(excluded[1]) === total)) return 'excluded'
  return undefined
}
