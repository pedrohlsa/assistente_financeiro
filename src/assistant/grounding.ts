// BARREIRA DE GROUNDING — nenhum número na prosa que não exista nos fatos.
//
// O modelo remoto pode ser útil para REDIGIR: dado um conjunto de fatos já
// calculados, ele escreve uma frase mais humana do que um template. O risco é
// conhecido e não é hipotético: modelos arredondam, somam errado, inventam um
// "aproximadamente R$ 1.500" quando o fato diz R$ 1.430,00, e o resultado é um
// JSON perfeitamente válido com um número que nunca existiu.
//
// Aqui a checagem é aritmética, não estatística. Todo valor citado tem que ser:
//
//   · um FATO, exatamente (ou arredondado para real inteiro);
//   · a soma ou a diferença de dois fatos;
//   · a porcentagem de um fato sobre outro;
//   · um número de amostra (quantas linhas sustentam um fato);
//   · uma parte de data que já está nos fatos (dia, mês, ano);
//   · um valor explicitamente autorizado por quem chama (`extra`).
//
// Qualquer outro número INVALIDA a composição inteira — e a resposta
// determinística assume. Não existe "aceitar mesmo assim": um número inventado
// no meio de três corretos é pior que uma frase sem graça, porque o usuário não
// tem como saber qual dos quatro é o inventado.

import type { AssistantFact } from './query/types'

export interface GroundingResult {
  ok: boolean
  /** Números citados que não se sustentam em nenhum fato. */
  offending: string[]
  /** Quantos números foram conferidos. Zero também é um resultado válido. */
  checked: number
}

/** Tolerância absoluta e relativa — cobre arredondamento honesto de centavo. */
const TOL_ABS = 0.02
const TOL_REL = 0.005

const perto = (a: number, b: number): boolean => {
  const d = Math.abs(a - b)
  return d <= TOL_ABS || d <= Math.abs(b) * TOL_REL
}

/**
 * Números citados no texto, em pt-BR.
 *
 * Casa "R$ 1.430,00", "1.430", "1430,50", "12%", "10x" e "1430". A leitura
 * segue `parseMoney`: o último separador com três dígitos é milhar.
 */
export function numbersIn(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = []
  for (const m of text.matchAll(/(?<![\w,.])(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w])/g)) {
    const raw = m[1]
    const norm = raw.includes(',')
      ? raw.replace(/\./g, '').replace(',', '.')
      : (/\.\d{3}(?!\d)/.test(raw) ? raw.replace(/\./g, '') : raw)
    const v = Number(norm)
    if (Number.isFinite(v)) out.push({ raw, value: v })
  }
  return out
}

/**
 * Conjunto de valores que a prosa PODE citar, derivado dos fatos.
 *
 * As derivações são poucas e explícitas de propósito. Abrir espaço para
 * "qualquer combinação aritmética" tornaria a barreira inútil: com fatos
 * suficientes, quase todo número vira uma combinação de outros dois.
 */
export function allowedValues(facts: AssistantFact[], extra: number[] = []): Set<number> {
  const base: number[] = []
  for (const f of facts) {
    base.push(Math.abs(f.value))
    if (typeof f.provenance?.rows === 'number') base.push(f.provenance.rows)
    if (f.period) {
      for (const iso of [f.period.from, f.period.to]) {
        if (!iso) continue
        const [y, mth, d] = iso.split('-').map(Number)
        base.push(y, mth, d)
      }
    }
  }
  base.push(...extra.map(Math.abs))

  const ok = new Set<number>()
  const add = (v: number) => {
    if (!Number.isFinite(v)) return
    ok.add(Math.round(v * 100) / 100)
    ok.add(Math.round(v))
    ok.add(Math.floor(v))
  }
  for (const v of base) add(v)
  // Somas, diferenças e proporções entre pares. A lista de fatos é curta
  // (dezenas), então o quadrado disso continua barato.
  const vals = [...new Set(base)].slice(0, 40)
  for (let i = 0; i < vals.length; i++) {
    for (let j = 0; j < vals.length; j++) {
      if (i === j) continue
      add(vals[i] + vals[j])
      add(Math.abs(vals[i] - vals[j]))
      if (vals[j] !== 0) {
        add((vals[i] / vals[j]) * 100)
        add(vals[i] / vals[j])
      }
    }
  }
  return ok
}

/**
 * A prosa se sustenta nos fatos?
 *
 * `extra` recebe números que o CHAMADOR sabe serem legítimos e que não vieram
 * de um fato — o número de parcelas de um cenário, por exemplo.
 */
export function checkGrounding(
  text: string, facts: AssistantFact[], extra: number[] = [],
): GroundingResult {
  const permitidos = allowedValues(facts, extra)
  const lista = [...permitidos]
  const offending: string[] = []
  const citados = numbersIn(text)

  for (const n of citados) {
    if (permitidos.has(Math.round(n.value * 100) / 100)) continue
    if (lista.some(v => perto(n.value, v))) continue
    offending.push(n.raw)
  }
  return { ok: offending.length === 0, offending, checked: citados.length }
}

/**
 * Quantos fatos podem sustentar UMA composição — e por que existe um teto.
 *
 * A força da barreira foi MEDIDA, com 5.000 valores aleatórios entre R$ 0 e
 * R$ 5.000 sorteados como se fossem números inventados pelo modelo:
 *
 *   1 fato .............  0,6% dos inventados passariam
 *   3 fatos ............  3,5%
 *   6 fatos ............ 16,0%
 *   12 fatos ........... 35,8%
 *   contexto inteiro ... 89,3%   (38 números distintos)
 *
 * O termo que domina é a soma e a diferença entre pares: com números demais,
 * quase todo valor é a combinação de dois outros — que é exatamente o que
 * `allowedValues` avisa e ninguém tinha medido. Nenhuma variação das
 * derivações resolve (tirar a razão crua muda 10,1% para 10,0%); a ÚNICA
 * alavanca é o tamanho da lista.
 *
 * Daí o teto, e daí ele falhar FECHADO: lista maior que o teto é recusada
 * inteira, em vez de passar por uma checagem que já não protege. Uma barreira
 * que aceita 9 em cada 10 números inventados é pior que barreira nenhuma,
 * porque o código passa a alegar uma proteção que não existe.
 */
export const MAX_COMPOSE_FACTS = 6

/**
 * Aceita a composição remota, ou devolve a recusa para o chamador usar o texto
 * determinístico.
 *
 * Três recusas, todas silenciosas para o usuário (ele recebe a resposta local,
 * que está certa): número inventado, resposta vazia e fatos demais. Nenhuma
 * delas nunca vira um "aproximadamente" na tela.
 */
export function acceptComposition(
  text: string | undefined | null,
  facts: AssistantFact[],
  extra: number[] = [],
): { text: string } | { rejected: 'empty' | 'ungrounded' | 'too-many-facts'; offending?: string[] } {
  const t = String(text || '').trim()
  if (!t) return { rejected: 'empty' }
  if (facts.length + extra.length > MAX_COMPOSE_FACTS) return { rejected: 'too-many-facts' }
  const g = checkGrounding(t, facts, extra)
  if (!g.ok) return { rejected: 'ungrounded', offending: g.offending }
  return { text: t }
}
