import { fmtBRL, parseMoney } from '../utils/format'
import { normalizeNumberWords } from './numbers'

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

const platformLabel = (platform: string): string => /^indriv/i.test(platform) ? 'inDrive' : /^uber$/i.test(platform) ? 'Uber' : '99'

/** Prepara o dinheiro que entrou quando a plataforma já reteve uma taxa. */
export function readPlatformPayout(message: string): PlatformPayout | undefined {
  if (!/\b(?:brut[oa]s?|l[íi]quid[oa]s?|limp[oa]s?|taxa|retida|descont(?:ou|ad[oa]|ar|ando)|ficou\s+com|levou|comeu|tirou|reteve|pegou|abocanhou)\b/i.test(message) || message.includes('?')) return undefined
  const text = normalizeNumberWords(message).text.trim()
  const match = PAYOUT_PATTERNS.map(pattern => text.match(pattern)).find(Boolean)
  if (!match) {
    const kept = text.match(GROSS_THEN_KEPT) || text.match(ONLY_KEPT)
    if (kept) {
      const { platform, gross, fee, pct } = kept.groups
      const nome = platformLabel(platform)
      const parte = pct ? `${pct.replace('.', ',')}%` : fmtBRL(parseMoney(fee))
      return { description: nome, issue: gross
        ? `Você informou ${fmtBRL(parseMoney(gross))} brutos, e a ${nome} ficou com ${parte}. Qual foi o valor que realmente entrou na conta?`
        : `A parte que a ${nome} fica (${parte}) não entra como gasto: o que vale é o que caiu na sua conta. Quanto você recebeu da ${nome}?` }
    }
    const partial = text.match(PAID_WITH_FEE) || text.match(PAID_AND_TOOK_FEE)
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
  const cash = platform ? `recebi R$ ${net} ${normalizedPlatform} líquido` : reported ? `${reported} líquido` : gross ? `recebi R$ ${net} líquido` : undefined
  if (!cash) return undefined
  const payment = [lead.trim(), whenNet, cash, whenTail].filter(Boolean).join(' ')
  return { amount, text: `${payment}${tail || ''}`.trim() }
}
