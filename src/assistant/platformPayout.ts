import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeNumberWords } from './numbers'

const MONEY = (name: string) => String.raw`(?:r\$\s*)?(?<${name}>\d+(?:[.,]\d+)*)(?!\d|[.,]\d)(?:\s+reais?)?`
const PLATFORM = String.raw`(?<platform>uber|99|indrive[r]?)\b`
const DATE_LEAD = String.raw`(?<lead>(?:(?:eu|hoje|ontem|anteontem|j[áa])\s+){0,3})`
const TAIL = String.raw`(?<tail>\s*(?:[.;]\s*(?=[\p{L}])|(?:,\s*|\s+)e\s+(?=(?:gastei|paguei|comprei|abasteci|guardei|recebi|ganhei|rodei|trabalhei)\b))[^?]*|[.!]*\s*)$`
const NET = String.raw`(?:l[íi]quid[oa]s?|limp[oa]s?)(?![\wÀ-ÿ])`
const GROSS = String.raw`brut[oa]s?\b`
const FEE = String.raw`(?:depois\s+d[aeo]\s+taxa|com\s+a\s+taxa\s+descontada)\s+de\s+${MONEY('fee')}`
const WITHHELD_FEE = String.raw`,?\s+(?:j[áa]\s+)?(?:com\s+(?:a\s+)?taxa\s+(?:j[áa]\s+)?(?:retida|descontada)|(?:retida|descontad[oa])\s+(?:a\s+)?taxa)(?:\s+de\s+${MONEY('fee')})?`
const PLATFORM_PAYMENT = String.raw`(?:a\s+|o\s+)?${PLATFORM}\s+(?:(?:me\s+)?pagou|depositou|repassou)\s+${MONEY('gross')}(?:\s+${GROSS})?`
const STATED_FEE = String.raw`(?:com\s+(?:a\s+)?taxa\s+de|(?:j[áa]\s+)?menos\s+(?:a\s+)?taxa\s+de)\s+${MONEY('fee')}`
const PAID_WITH_FEE = new RegExp(String.raw`^${DATE_LEAD}${PLATFORM_PAYMENT}\s+${STATED_FEE}${TAIL}`, 'iu')

const PAYOUT_PATTERNS = [
  new RegExp(String.raw`^${DATE_LEAD}${PLATFORM_PAYMENT}\s+${STATED_FEE}(?:,\s*|\s+e\s+|\s+)(?:caiu|ca[ií]ram|entrou|entraram|recebi)\s+(?:(?<whenNet>hoje|ontem|anteontem)\s+)?${MONEY('net')}(?:\s+${NET})?(?:\s+na\s+(?:minha\s+)?conta)?(?:\s+(?<whenTail>hoje|ontem|anteontem))?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:fiz|ganhei|faturei)\s+${MONEY('gross')}\s+${GROSS}\s+(?:n[ao]|pel[ao]|d[ao])\s+${PLATFORM}(?:\s+e\s+|,\s*)(?:recebi|caiu|entrou)\s+${MONEY('net')}\s+${NET}(?:\s+${FEE})?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:na|no|pela|pelo)\s+${PLATFORM}\s+(?:deu|foram)\s+${MONEY('gross')}\s+${GROSS}\s*,\s*${MONEY('net')}\s+${NET}(?:\s+e\s+a\s+taxa\s+(?:ficou\s+em|foi\s+de)\s+${MONEY('fee')})?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}recebi\s+${MONEY('net')}\s+${NET}\s+(?:na|no|pela|pelo|da|do)\s+${PLATFORM}\s*,\s*${MONEY('gross')}\s+(?:era|foi)\s+o\s+${GROSS}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:a\s+|o\s+)?${PLATFORM}\s+descontou\s+${MONEY('fee')}\s+de\s+taxa\s+e\s+(?:caiu|entrou|recebi)\s+${MONEY('net')}(?:\s+na\s+(?:minha\s+)?conta)?${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?<reported>(?:recebi|caiu|entrou)\s+${MONEY('net')}(?:\s+(?:n[ao]|d[ao]|pel[ao])\s+${PLATFORM})?)\s+(?:j[áa]\s+)?descontad[oa]\s+(?:a\s+)?taxa\s+de\s+${MONEY('fee')}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:recebi|caiu|entrou)\s+${MONEY('net')}(?:\s+${NET})?\s+(?:n[ao]|d[ao]|pel[ao])\s+${PLATFORM}(?:\s+${NET})?${WITHHELD_FEE}${TAIL}`, 'iu'),
  new RegExp(String.raw`^${DATE_LEAD}(?:(?:o\s+)?(?:saldo|dep[óo]sito)\s+d[ao]\s+|[oa]\s+)?${PLATFORM}\s+(?:veio|caiu|entrou|(?:me\s+)?pagou)\s+${MONEY('net')}(?:\s+${NET})?${WITHHELD_FEE}${TAIL}`, 'iu'),
]

export type PlatformPayout = { text: string; amount: number } | { issue: string; description?: string }

const platformLabel = (platform: string): string => /^indriv/i.test(platform) ? 'inDrive' : /^uber$/i.test(platform) ? 'Uber' : '99'

/** Prepara o dinheiro que entrou quando a plataforma já reteve uma taxa. */
export function readPlatformPayout(message: string): PlatformPayout | undefined {
  if (!/\b(?:brut[oa]s?|l[íi]quid[oa]s?|limp[oa]s?|taxa|retida|descont(?:ou|ad[oa]))\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const match = PAYOUT_PATTERNS.map(pattern => text.match(pattern)).find(Boolean)
  if (!match) {
    const partial = text.match(PAID_WITH_FEE)
    if (!partial) return undefined
    const { platform, gross, fee } = partial.groups
    return { description: platformLabel(platform),
      issue: `Você informou ${fmtBRL(parseMoney(gross))} e ${fmtBRL(parseMoney(fee))} de taxa. Qual foi o valor que realmente entrou na conta?` }
  }
  const { lead, platform, reported, gross, net, fee, tail, whenNet, whenTail } = match.groups
  const amount = parseMoney(net)
  const beforeFee = parseMoney(gross)
  const withheld = parseMoney(fee)
  const description = platform ? platformLabel(platform) : undefined
  if (!(amount > 0)) return { issue: 'Qual valor você recebeu depois do desconto? Ainda não preparei nenhum lançamento.', description }
  if (gross && (beforeFee < amount || (fee && Math.round((beforeFee - amount) * 100) !== Math.round(withheld * 100)))) {
    return { issue: `Você disse ${fmtBRL(beforeFee)} brutos, ${fmtBRL(amount)} líquidos${fee ? ` e ${fmtBRL(withheld)} de taxa` : ''}. Qual foi o valor que entrou na conta?`, description }
  }
  const normalizedPlatform = /^indriv/i.test(platform || '') ? 'no inDrive' : platform ? `na ${platform}` : ''
  const cash = platform ? `recebi R$ ${net} ${normalizedPlatform} líquido` : reported ? `${reported} líquido` : undefined
  if (!cash) return undefined
  const payment = [lead.trim(), whenNet, cash, whenTail].filter(Boolean).join(' ')
  return { amount, text: `${payment}${tail || ''}`.trim() }
}
