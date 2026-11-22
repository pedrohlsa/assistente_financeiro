// O DIA DO MOTORISTA escrito como ele escreve de verdade.
//
//     hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h
//
// Sem verbo, sem vírgula, sem conector: valor, plataforma, valor, plataforma,
// valor de combustível, litros, km, horas. É a mensagem que ele manda no fim do
// turno, com o celular numa mão e o cinto na outra.
//
// O parser de frases não dá conta disso, e não é por descuido: ele foi feito
// para ORAÇÕES ("ganhei 430 na uber E coloquei 163 de gasolina"), e essa forma
// não tem oração nenhuma. Na prática, ele lia o primeiro valor e as horas —
// R$ 399 da 99, R$ 163 de combustível, 24 litros e 161 km sumiam em silêncio.
// Perder metade do dia de trabalho de alguém é o pior tipo de defeito: o
// usuário confirma o que vê e nunca descobre o que faltou.
//
// TRÊS TRAVAS para isto não vazar para outras frases:
//   1. só no perfil MOTORISTA;
//   2. só quando a frase tem a FORMA telegráfica — ao menos três pares
//      número+unidade e nenhum verbo de comando estruturando orações;
//   3. só quando reconhece MAIS coisas do que o parser normal já tinha achado.
// Falhando qualquer uma delas, este módulo devolve `null` e nada muda.

import type { ParsedAction } from '../../models/types'
import { parseMoney } from '../../utils/format'
import { normalizeName } from '../../utils/text'
import { normalizeNumberWords } from '../numbers'
import { COMPOUND_DURATION, elapsedMinutes } from './clock'

/** Plataformas de onde o dinheiro vem. O nome vira a descrição do lançamento. */
const PLATAFORMAS: [RegExp, string][] = [
  [/^uber$/i, 'Uber'],
  [/^99$|^noventa\s*e\s*nove$/i, '99'],
  [/^in\s*driver?$/i, 'inDrive'],
  [/^ifood$/i, 'iFood'],
  [/^rappi$/i, 'Rappi'],
  [/^particular(?:es)?$/i, 'Particular'],
  [/^app$/i, 'App'],
]

/** Palavras que significam combustível na boca dele, gíria incluída. */
const COMBUSTIVEL = /^(?:gasolina|gasosa|alcool|etanol|gnv|diesel|combustivel|suco)$/i
const LIQUIDO = /^(?:liquid[oa]s?|limp[oa]s?)$/

const plataformaDe = (token: string): string | null => {
  for (const [re, nome] of PLATAFORMAS) if (re.test(token)) return nome
  return null
}

export interface DriverDay {
  actions: ParsedAction[]
  /** Quantos tokens da frase foram efetivamente entendidos. */
  reconhecidos: number
  unclassifiedAmounts: number[]
  invalidWork: boolean
}

/** Verbo que estrutura oração: com ele, quem lê a frase é o parser normal. */
const TEM_ORACAO = /\b(?:ganhei|recebi|faturei|coloquei|botei|abasteci|rodei|andei|trabalhei|gastei|paguei|comprei|guardei|troquei)\b/i
const NAO_E_RELATO = /\?|\b(?:nao|nem|nunca|se|talvez|ou|quanto|qual|compara|compensa|vale|somando|total|vou|pretendo)\b/
const DURACAO = new RegExp(String.raw`(?<![\d.,])${COMPOUND_DURATION}(?![\p{L}\p{M}\d]|[.,]\d)`, 'gu')

/**
 * Lê o dia telegráfico. `null` quando a frase não tem essa forma — e "não tem
 * essa forma" é a resposta certa para quase tudo.
 */
export function parseDriverDay(message: string, opts: { driver: boolean }): DriverDay | null {
  if (!opts.driver) return null
  const raw = normalizeNumberWords(normalizeName(message)).text
  if (TEM_ORACAO.test(raw) || NAO_E_RELATO.test(raw)) return null

  // Normaliza só o suficiente para tokenizar: separa número de unidade colada
  // ("161km" → "161 km", "24l" → "24 l", "8h" → "8 h").
  const texto = raw
    .replace(DURACAO, duration => ` ${elapsedMinutes(duration) ?? 0} min-jornada `)
    .replace(/(\d)\s*(km|l|h|hrs?|horas?|litros?)\b/gi, '$1 $2')
    .replace(/(?<!\d)[.,]|[.,](?!\d)|[;!?:]/g, ' ')
  const tokens = texto.split(/\s+/).filter(Boolean)

  const actions: ParsedAction[] = []
  let reconhecidos = 0
  const work: { km?: number; hours?: number; trips?: number } = {}
  const fuel: { amount?: number; liters?: number } = {}
  const unclassifiedAmounts: number[] = []
  let invalidWork = false
  let rendaSemPlataforma = 0
  const saidLiters = /\d\s+(?:l|litros?)\b/.test(texto)
  const isFuel = (t: string) => COMBUSTIVEL.test(t) || t === 'gas' && saidLiters

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!/^\d[\d.,]*$/.test(t)) continue
    const valor = parseMoney(t)
    const seguinte = tokens[i + 1] || ''
    const depois = tokens[i + 2] || ''
    if (seguinte === 'min-jornada') {
      if (valor > 0) work.hours = (work.hours || 0) + valor / 60
      else invalidWork = true
      reconhecidos += 2; i++; continue
    }
    if (!Number.isFinite(valor) || valor <= 0) continue

    // --- quantidade com unidade -----------------------------------------
    if (/^km$/i.test(seguinte)) { work.km = (work.km || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:h|hrs?|horas?)$/i.test(seguinte)) { work.hours = (work.hours || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:l|litros?)$/i.test(seguinte)) { fuel.liters = (fuel.liters || 0) + valor; reconhecidos += 2; i++; continue }
    if (/^(?:corridas?|viagens?|chamadas?)$/i.test(seguinte)) {
      if (Number.isInteger(valor)) work.trips = (work.trips || 0) + valor
      else invalidWork = true
      reconhecidos += 2; i++; continue
    }

    // --- combustível: "163 de gasosa" ou "163 gasolina" ------------------
    if (isFuel(seguinte) || (seguinte === 'de' && isFuel(depois))) {
      fuel.amount = (fuel.amount || 0) + valor
      reconhecidos += /^de$/i.test(seguinte) ? 3 : 2
      i += /^de$/i.test(seguinte) ? 2 : 1
      continue
    }

    // --- receita por plataforma: "430 uber" ------------------------------
    const plat = plataformaDe(seguinte) || (/^(?:na|no|da|do|pela|pelo)$/i.test(seguinte) ? plataformaDe(depois) : null)
    if (plat) {
      const used = plataformaDe(seguinte) ? 1 : 2
      const reportedNet = LIQUIDO.test(tokens[i + used + 1] || '')
      actions.push({ kind: 'income', amount: valor, category: 'corridas', description: plat, ...(reportedNet ? { reportedNet } : {}) })
      reconhecidos += 1 + used + Number(reportedNet)
      i += used + Number(reportedNet)
      continue
    }

    // --- valor solto logo depois do verbo de resultado --------------------
    // "hj DEU 430 ..." — o primeiro número da frase é o faturamento quando
    // nenhuma plataforma o acompanha. Um número solto no MEIO da frase não
    // vira nada: adivinhar ali seria inventar dinheiro.
    const anterior = tokens[i - 1] || ''
    if (/^(?:deu|foi|fiz|saiu|deram)$/i.test(anterior)) {
      rendaSemPlataforma += valor
      reconhecidos += 2
      continue
    }
    unclassifiedAmounts.push(valor)
  }

  if (rendaSemPlataforma > 0) {
    actions.unshift({ kind: 'income', amount: rendaSemPlataforma, category: 'corridas' })
  }
  if (fuel.amount !== undefined || fuel.liters !== undefined) {
    const f: any = { kind: 'fuel' }
    if (fuel.amount !== undefined) f.amount = fuel.amount
    if (fuel.liters !== undefined) f.liters = fuel.liters
    actions.push(f as ParsedAction)
  }
  if (work.km !== undefined || work.hours !== undefined || work.trips !== undefined) {
    actions.push({ kind: 'work', ...work } as ParsedAction)
  }

  // A forma telegráfica precisa estar ali de verdade: três coisas entendidas e
  // pelo menos metade da frase consumida. Abaixo disso é uma frase comum com um
  // número dentro, e quem lê é o parser normal.
  const partes = actions.length
  if (partes < 3) return null
  if (reconhecidos < tokens.length * 0.5) return null

  return { actions, reconhecidos, unclassifiedAmounts, invalidWork }
}
