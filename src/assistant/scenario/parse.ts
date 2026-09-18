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
import type { AssistantScenarioPlan, ScenarioKind } from './types'

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

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
  /\bse\s+(?:a|o|as|os)\s+[\w\s]{2,24}?\s(?:nao|n|atrasar|atrasarem|falhar|sumir)\b/,
  // "só quero saber se 500 de obra cabe esse mês" — hipótese sem "eu", dita do
  // jeito mais direto possível. Sem estas formas ela caía no texto genérico de
  // ajuda, e é justamente a frase de quem NÃO quer registrar nada.
  /\bse\s+(?:r\$\s*)?\d/,
  /\bcabe\b/, /\bd[áa]\s+pra\b[^?]*\d/, /\bdaria\s+pra\b/,
  /\bconsigo\s+(?:comprar|pagar|bancar)\b/, /\bs[óo]\s+quero\s+saber\s+se\b/,
]

export const looksLikeScenario = (input: string): boolean => {
  const t = semAcento(input)
  return HIPOTESE.some(re => re.test(t))
}

const NUM = String.raw`(\d+(?:[.,]\d+)*)`

/** "4000 em 10x", "4 mil em 10 vezes", "3600 em 12 parcelas". */
function lerCompra(t: string): { total: number; installments: number } | null {
  // As bordas de dígito são obrigatórias: sem elas "24 vezes" era partido em
  // "2" (o valor) e "4" (as parcelas), e a moto de 12 mil virava R$ 4,00 em 2x.
  const m = t.match(new RegExp(String.raw`(?:r\$\s*)?${NUM}(?!\d|[.,]\d)\s*(?:reais\s*)?(?:em|x|de)?\s*(?:em\s*)?(?<!\d|\d[.,])(\d{1,3})\s*(?:x|vezes|parcelas|prestacoes)\b`))
    || t.match(new RegExp(String.raw`(?<!\d|\d[.,])(\d{1,3})\s*(?:x|vezes|parcelas)\b[^\d]{0,20}(?:r\$\s*)?${NUM}`))
  if (!m) return null
  const a = parseMoney(m[1])
  const b = Number(m[2])
  // A ordem pode vir invertida ("em 10x um pc de 4000"): o maior é o preço.
  const total = Math.max(a, b)
  const parcelas = Math.min(a, b)
  if (!(total > 0) || !(parcelas >= 1) || parcelas > 120) return null
  // O preço tem que ser DINHEIRO. "e se em vez de 10x eu fizer 12" fala de
  // parcelas, não de uma compra de R$ 12,00 — e sem esta trava a hipótese sem
  // base virava uma simulação com valor inventado.
  if (valorDeDinheiro(t, total) === undefined) return null
  return { total, installments: Math.round(parcelas) }
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

function cartaoDe(state: AppState, t: string): string | undefined {
  for (const c of activeCards(state)) {
    const n = normalizeName(c.name)
    if (n.length >= 3 && t.includes(n)) return c.name
  }
  return undefined
}

/** Fonte que deixaria de pagar: "se a Casa 1 não pagar", "se o Cliente João atrasar". */
function origemDe(t: string): string | undefined {
  const m = t.match(/\b(?:casa|cliente|empresa|loja|kitnet|apart\w*|inquilin\w+|contrato|sala|ponto|unidade)\s+([\w\d]+)/)
  return m ? m[0] : undefined
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
  const m = t.match(new RegExp(String.raw`\bate\s+(${MESES_NOME.join('|')})\b`))
  if (!m) return 6
  const alvo = MESES_NOME.indexOf(m[1])
  const atual = Number(hoje.slice(5, 7)) - 1
  const n = (alvo >= atual ? alvo - atual : alvo + 12 - atual) + 1
  return Math.min(Math.max(n, 1), 12)
}

/** Parar um tipo de gasto: "parar a obra", "cortar o lazer", "não gastar mais com mercado". */
const PARAR_GASTO = /\b(?:parar|pare|parasse|parando|cortar|corte|cortasse|tirar|tirasse|deixar\s+de\s+gastar|nao\s+gastar\s+mais|parar\s+de\s+gastar)\b/

export function planScenario(
  state: AppState, input: string, opts: { today?: string; focusCategory?: string } = {},
): AssistantScenarioPlan | null {
  if (!looksLikeScenario(input)) return null
  // Números por extenso viram algarismos antes dos regex, igual ao parser de
  // registro — "quatro mil em dez vezes" é a mesma frase.
  const t = semAcento(normalizeNumberWords(input).text)
  const driver = isDriver(state.settings)

  const base = (kind: ScenarioKind, extra: Partial<AssistantScenarioPlan>, label: string): AssistantScenarioPlan =>
    ({ version: SCENARIO_DSL_VERSION, kind, label, ...extra })

  // ---- motorista: horas ou km a mais -------------------------------------
  if (driver) {
    const horas = t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*(?:h|horas?)\b`))
      || t.match(new RegExp(String.raw`\b(?:trabalhar|ficar|rodar|fazer)\s+(?:mais\s+)?${NUM}\s*(?:h|horas?)\b`))
    if (horas) {
      const porDia = /\bpor\s+dia\b|\bdiari|\bcada\s+dia\b|\btodo\s+dia\b/.test(t)
      const dias = porDia ? 30 : 1
      return base('extra-work', { hoursPerDay: parseMoney(horas[1]), days: dias },
        `mais ${horas[1]}h ${porDia ? 'por dia' : 'hoje'}`)
    }
    const km = t.match(new RegExp(String.raw`\bmais\s+${NUM}\s*km\b`))
      || t.match(new RegExp(String.raw`\brodar\s+(?:mais\s+)?${NUM}\s*km\b`))
    if (km) return base('extra-work', { extraKm: parseMoney(km[1]) }, `mais ${km[1]} km`)
  }

  // ---- parar um tipo de gasto --------------------------------------------
  // "E se eu parar a obra, quanto sobra até dezembro?" não tinha tipo nenhum
  // no motor: a hipótese sumia e a metade "quanto sobra" era respondida como
  // PROJEÇÃO FACTUAL. Guardar/poupar ficam de fora — "parar de guardar" é
  // outra conta, e sem representação ainda.
  if (PARAR_GASTO.test(t) && !/\bguard|\bpoup|\bjunt|\bsepar/.test(t)) {
    // A entidade pode ter ficado na conversa: "quanto gasto com obra?" → "e se
    // parar?". Sem categoria nem no texto nem no foco, não há o que simular.
    const categoria = categoriaDe(state, t) || opts.focusCategory
    if (categoria) {
      const nome = usableCategories(state.categories || []).find(c => c.id === categoria)?.name || categoria
      return base('cut', { category: categoria, description: nome, months: horizonte(t, opts.today || todayISO()) },
        `parar os gastos com ${nome}`)
    }
  }

  // ---- pagar a fatura -----------------------------------------------------
  if (/\bpagar\s+(?:a\s+)?fatura\b|\bquitar\s+(?:a\s+)?fatura\b/.test(t)) {
    return base('pay-invoice', { cardName: cartaoDe(state, t) }, 'pagar a fatura')
  }

  // ---- entrada que não vem ------------------------------------------------
  // "n pagar" é como se escreve no celular. Sem aceitar o "n" abreviado, a
  // frase caía no ramo de GASTO e o "1" de "Casa 1" virava um gasto simulado
  // de R$ 1,00 — resposta completa, precisa e sobre outra coisa.
  if (/\b(?:nao|n)\s+(?:me\s+)?(?:pagar|pagarem|vier|entrar|cair|depositar|receber)\b|\batrasar\b|\bfalhar\b/.test(t)) {
    const origem = origemDe(t)
    // O número de "Casa 1" é parte do NOME, não um valor: sem tirar a origem do
    // texto antes de ler o dinheiro, "se a Casa 1 não pagar" virava uma entrada
    // média de R$ 1,00.
    const semOrigem = origem ? t.replace(origem, ' ') : t
    const valor = lerValor(semOrigem)
    return base('income-missing',
      { origin: origem, amount: valorDeDinheiro(semOrigem, valor) },
      'uma entrada que não vem')
  }

  // ---- guardar por mês ----------------------------------------------------
  if (/\bguardar?\b|\bguardasse\b|\bpoupar\b|\bseparar\b|\bjuntar\b/.test(t)) {
    const valor = lerValor(t)
    if (Number.isFinite(valor) && valor > 0) {
      const meta = (state.goals || []).find(g => !g.done && normalizeName(g.name).length > 2
        && t.includes(normalizeName(g.name).split(' ')[0]))
      return base('save', { amount: valor, goalName: meta?.name }, `guardar ${valor} por mês`)
    }
  }

  // ---- compra parcelada ---------------------------------------------------
  const compra = lerCompra(t)
  if (compra) {
    const entrada = t.match(new RegExp(String.raw`\b(?:dando|com|de)\s+${NUM}\s*(?:reais\s*)?de\s+entrada\b`))
      || t.match(new RegExp(String.raw`\bentrada\s+de\s+(?:r\$\s*)?${NUM}`))
    // Entrada do tamanho do preço, ou maior, não descreve compra parcelada
    // nenhuma: a leitura está errada, e simular seria inventar.
    if (entrada && parseMoney(entrada[1]) >= compra.total) return null
    return base('purchase', {
      amount: compra.total,
      installments: compra.installments,
      downPayment: entrada ? parseMoney(entrada[1]) : undefined,
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
  if (/\bgastar\b|\bgastasse\b|\bpagar\b|\bcomprar\b|\bmeter\b|\btorrar\b|\bcabe\b|\bcaberia\b|\bd[áa]\s+pra\b|\bdaria\s+pra\b/.test(t)) {
    // O valor tem que ser DINHEIRO: um "1" solto quase sempre e identificador
    // ("Casa 1", "unidade 2"), e simular um gasto de R$ 1,00 e pior que nao
    // simular nada.
    const valor = valorDeDinheiro(t, lerValor(t))
    if (valor !== undefined) {
      return base('spend', { amount: valor, category: categoriaDe(state, t) }, `gastar ${valor}`)
    }
  }

  return null
}

/** O objeto da compra, quando a frase o nomeia ("um pc de 4000 em 10x"). */
function descricaoDe(t: string): string | undefined {
  const m = t.match(/\b(?:comprar|comprasse|pegar|meter|parcelar)\s+(?:um|uma|o|a)?\s*([a-z0-9çãõáéíóúâê]{3,20})\b/)
  if (!m) return undefined
  const p = m[1]
  if (/^\d+$/.test(p) || ['mil', 'reais', 'mais', 'isso'].includes(p)) return undefined
  return p
}
