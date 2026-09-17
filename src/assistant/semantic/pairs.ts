// PARES TELEGRÁFICOS: entidade ↔ valor ↔ tipo.
//
//     uber deu 210 e a 99 uns 130
//     uber 210 99 130
//     210 uber 130 99
//     salario 3200 aluguel pago 1100
//
// Nenhuma dessas frases tem a oração que o parser de frases procura ("ganhei
// 210 NA uber"), e nenhuma tem a forma do dia do motorista (valor ANTES da
// plataforma, três partes ou mais, só no perfil motorista). As duas receitas
// sumiam em silêncio — zero lançamentos para uma frase que diz exatamente
// quanto entrou e de onde.
//
// O que existe em comum é o PAR: cada valor anda colado a uma coisa que diz o
// que ele é. A plataforma diz receita; o salário diz receita; "aluguel" não
// diz nada sozinho, mas "aluguel PAGO" diz despesa. Este módulo lê pares e
// nada além disso.
//
// TRÊS TRAVAS, porque "qualquer palavra + número" não pode virar dinheiro:
//   1. vocabulário FECHADO — uma palavra desconhecida (data, negação, "se",
//      pergunta, nome próprio) derruba a leitura inteira;
//   2. todo valor precisa de par com TIPO — substantivo neutro sem verbo
//      ("lanche 15") não é par, e continua com quem sempre o leu;
//   3. o pareamento precisa ser ÚNICO — se as duas direções (entidade→valor e
//      valor→entidade) servem com resultados diferentes, não escolhe.
// Falhando qualquer uma, devolve `null` e nada muda.

import type { ParsedAction } from '../../models/types'
import { guessCategory } from '../../data/categories'
import { parseMoney } from '../../utils/format'
import { sentenceCase } from '../../utils/text'

type Tipo = 'income' | 'expense'

interface Entidade {
  /** Tipo que a própria entidade impõe; `null` = precisa de verbo. */
  tipo: Tipo | null
  category?: string
  description?: string
  combustivel?: boolean
}

type Item =
  | { k: 'sep' }
  | { k: 'num'; valor: number }
  | { k: 'ent'; ent: Entidade }
  | { k: 'verbo'; tipo: Tipo; combustivel?: boolean }
  /** "99": plataforma ou valor — decide o pareamento. */
  | { k: 'ambiguo'; valor: number; ent: Entidade }

const PLATAFORMA: Record<string, string> = { uber: 'Uber', '99': '99', indrive: 'inDrive', indriver: 'inDrive', ifood: 'iFood', rappi: 'Rappi' }
const renda = (description: string): Entidade => ({ tipo: 'income', category: 'corridas', description })

const NOMES_DE_RENDA = /^(?:sal[áa]rio|freela|freelance|comiss[ãa]o)$/
/** Neutros: gasto ou renda conforme o verbo. Lista curta de propósito. */
const NOMES_NEUTROS = /^(?:alugu[eé]l|luz|[áa]gua|internet)$/
const COMBUSTIVEL = /^(?:gasolina|gasosa|etanol|[áa]lcool|diesel|gnv|combust[íi]vel)$/

const VERBO_RENDA = /^(?:deu|deram|fez|fiz|caiu|entrou|recebi|ganhei|pingou|rendeu|faturei)$/
const VERBO_GASTO = /^(?:paguei|pago|paga|pagou|gastei|saiu|comprei)$/
const VERBO_ABASTECER = /^abasteci$/

/** Palavras que não carregam sentido no par. "e" e a vírgula também separam grupos. */
const FUNCIONAIS = /^(?:a|o|as|os|na|no|da|do|de|pela|pelo|com|em|uns|umas|mais|j[áa]|depois|meu|minha|a[íi]|cerca|r\$|reais|real|conto|contos|pila|hoje|hj|ontem|anteontem)$/
const ARTIGO = /^(?:a|o|na|no|da|do|pela|pelo)$/

function tokeniza(message: string): Item[] | null {
  const tokens = message
    .toLowerCase()
    .replace(/[.!]+\s*$/, '')
    .replace(/,(?!\d)|;/g, ' , ')
    .split(/\s+/)
    .filter(Boolean)
  const itens: Item[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const anterior = tokens[i - 1] || ''
    if (t === ',' || t === 'e') { itens.push({ k: 'sep' }); continue }
    if (/^\d+(?:[.,]\d+)*$/.test(t)) {
      const valor = parseMoney(t)
      if (!(valor > 0)) return null
      if (t === '99') {
        // Com artigo antes ("a 99", "na 99") é a plataforma, sem dúvida.
        if (ARTIGO.test(anterior)) itens.push({ k: 'ent', ent: renda('99') })
        else itens.push({ k: 'ambiguo', valor, ent: renda('99') })
      } else itens.push({ k: 'num', valor })
      continue
    }
    if (PLATAFORMA[t]) { itens.push({ k: 'ent', ent: renda(PLATAFORMA[t]) }); continue }
    if (NOMES_DE_RENDA.test(t)) {
      itens.push({ k: 'ent', ent: { tipo: 'income', category: guessCategory(t, 'income') } })
      continue
    }
    if (NOMES_NEUTROS.test(t)) {
      itens.push({ k: 'ent', ent: { tipo: null, category: guessCategory(t, 'expense'), description: sentenceCase(t) } })
      continue
    }
    if (COMBUSTIVEL.test(t)) {
      itens.push({ k: 'ent', ent: { tipo: 'expense', category: 'combustivel', combustivel: true } })
      continue
    }
    if (VERBO_RENDA.test(t)) { itens.push({ k: 'verbo', tipo: 'income' }); continue }
    if (VERBO_GASTO.test(t)) { itens.push({ k: 'verbo', tipo: 'expense' }); continue }
    if (VERBO_ABASTECER.test(t)) { itens.push({ k: 'verbo', tipo: 'expense', combustivel: true }); continue }
    if (FUNCIONAIS.test(t)) continue
    return null
  }
  return itens
}

type Concreto = Exclude<Item, { k: 'ambiguo' } | { k: 'sep' }>
interface Grupo { valor: number; ents: Entidade[]; verbos: Extract<Item, { k: 'verbo' }>[] }

/** Agrupa um trecho sem separador, numa direção. `null` = não fecha. */
function agrupa(trecho: Concreto[], direcao: 'entidade-antes' | 'valor-antes'): Grupo[] | null {
  const grupos: Grupo[] = []
  if (direcao === 'entidade-antes') {
    let atual: Grupo = { valor: 0, ents: [], verbos: [] }
    for (const it of trecho) {
      if (it.k === 'num') { atual.valor = it.valor; grupos.push(atual); atual = { valor: 0, ents: [], verbos: [] } }
      else if (it.k === 'ent') atual.ents.push(it.ent)
      else atual.verbos.push(it)
    }
    // Sobrou entidade ou verbo depois do último valor: pertence a quê?
    if (atual.ents.length || atual.verbos.length) {
      // Só o caso de UM valor admite a entidade depois ("deu 210 uber").
      if (grupos.length !== 1) return null
      grupos[0].ents.push(...atual.ents)
      grupos[0].verbos.push(...atual.verbos)
    }
  } else {
    let atual: Grupo | null = null
    for (const it of trecho) {
      if (it.k === 'num') { atual = { valor: it.valor, ents: [], verbos: [] }; grupos.push(atual) } else if (!atual) return null
      else if (it.k === 'ent') atual.ents.push(it.ent)
      else atual.verbos.push(it)
    }
  }
  return grupos.length ? grupos : null
}

/** Um grupo vira UMA ação, ou a leitura inteira cai. */
function acaoDe(g: Grupo, driver: boolean, sozinho: boolean): ParsedAction | null {
  if (g.ents.length > 1 || g.verbos.length > 1) return null
  const ent = g.ents[0]
  const verbo = g.verbos[0]
  // Vários pares no mesmo trecho sem separador: cada um precisa de ENTIDADE —
  // "deu 210 130" não diz o que é o segundo valor.
  if (!sozinho && !ent && !verbo?.combustivel) return null
  const tipo = ent?.tipo ?? verbo?.tipo ?? null
  if (!tipo) return null
  if (ent?.tipo && verbo && verbo.tipo !== ent.tipo) return null
  const combustivel = !!(ent?.combustivel || verbo?.combustivel)
  if (combustivel) {
    if (tipo !== 'expense') return null
    return driver ? { kind: 'fuel', amount: g.valor } : { kind: 'expense', amount: g.valor, category: 'combustivel' }
  }
  if (!ent) return null
  const base: any = { kind: tipo, amount: g.valor }
  if (tipo === 'income') {
    const cat = ent.category && ent.tipo === 'income' ? ent.category : guessCategory(ent.description || '', 'income')
    if (cat) base.category = cat
  } else if (ent.category) base.category = ent.category
  if (ent.description) base.description = ent.description
  return base as ParsedAction
}

const assinatura = (as: ParsedAction[]) => JSON.stringify(as)

/**
 * Lê a frase como lista de pares tipados. `null` quando ela não é isso — e
 * "não é isso" é a resposta certa para quase tudo.
 */
export function parseTypedPairs(message: string, opts: { driver: boolean }): ParsedAction[] | null {
  const itens = tokeniza(message)
  if (!itens) return null

  // Trechos entre separadores.
  const trechos: Item[][] = [[]]
  for (const it of itens) {
    if (it.k === 'sep') { if (trechos[trechos.length - 1].length) trechos.push([]) } else trechos[trechos.length - 1].push(it)
  }
  if (!trechos[trechos.length - 1].length) trechos.pop()

  const acoes: ParsedAction[] = []
  for (const trecho of trechos) {
    // Cada "99" sem artigo é tentado como plataforma e como valor.
    const ambiguos = trecho.map((it, i) => (it.k === 'ambiguo' ? i : -1)).filter(i => i >= 0)
    if (ambiguos.length > 3) return null
    const leituras = new Map<string, ParsedAction[]>()
    for (let mask = 0; mask < 1 << ambiguos.length; mask++) {
      const concreto: Concreto[] = trecho.map((it, i) => {
        if (it.k !== 'ambiguo') return it as Concreto
        const bit = ambiguos.indexOf(i)
        return (mask >> bit) & 1 ? { k: 'num', valor: it.valor } : { k: 'ent', ent: it.ent }
      })
      for (const direcao of ['entidade-antes', 'valor-antes'] as const) {
        const grupos = agrupa(concreto, direcao)
        if (!grupos) continue
        const lidas = grupos.map(g => acaoDe(g, opts.driver, grupos.length === 1))
        if (lidas.some(a => !a)) continue
        const certas = lidas as ParsedAction[]
        leituras.set(assinatura(certas), certas)
      }
    }
    // Nenhuma leitura fecha, ou mais de uma diferente: não escolhe.
    if (leituras.size !== 1) return null
    acoes.push(...[...leituras.values()][0])
  }
  return acoes.length >= 2 ? acoes : null
}
