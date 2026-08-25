// TESTES METAMÓRFICOS — a classe, não a frase.
//
// Os casos do corpus são frases que alguém IMAGINOU. Eles provam que aquelas
// frases não regrediram, e nada além disso. Um teste metamórfico prova outra
// coisa, e mais forte: dada uma frase canônica, existem transformações que NÃO
// PODEM mudar o resultado (tirar acento, trocar a caixa, repetir um espaço,
// pôr um "tipo" no meio) e transformações que TÊM que mudar (negar, pôr no
// futuro, transformar em hipótese, em pergunta, em dúvida).
//
// É o contrário de escrever mais casos: em vez de imaginar mais uma frase,
// afirma-se uma REGRA sobre infinitas frases, e o gerador produz uma amostra
// determinística delas.
//
// Semente FIXA: a mesma execução, sempre. Um teste que muda de resultado entre
// duas rodadas não serve para bloquear uma entrega.

import type { AppState, ParsedAction } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { buildState, TODAY } from './harness'

/** PRNG determinístico (mulberry32). Mesma semente, mesma série. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Frases canônicas
// ---------------------------------------------------------------------------

export interface Canonica {
  id: string
  text: string
  profile: 'driver' | 'autonomo' | 'clt' | 'other'
  /** O que a frase TEM que produzir, campo a campo. */
  expect: { kind: ParsedAction['kind']; amount?: number; category?: string }[]
  /**
   * O verbo da frase nao se conjuga ("meu saldo E 1500"). As mutacoes de
   * modalidade produzem frases que nao sao portugues ("vou meu saldo e 1500") e
   * afirmar qualquer coisa sobre elas seria testar o gerador, nao o app.
   */
  semModalidade?: boolean
  /**
   * O numero da frase e QUANTIDADE, nao dinheiro. Pregar "reais" nele
   * ("rodei 161 REAIS km") muda o sentido de verdade — a mutacao deixaria de
   * preservar coisa nenhuma.
   */
  semDinheiro?: boolean
}

export const CANONICAS: Canonica[] = [
  { id: 'm-obra', text: 'gastei 190 de cimento ontem', profile: 'other', expect: [{ kind: 'expense', amount: 190, category: 'obra' }] },
  { id: 'm-mercado', text: 'gastei 80 no mercado', profile: 'other', expect: [{ kind: 'expense', amount: 80 }] },
  { id: 'm-aluguel', text: 'recebi 1800 de aluguel', profile: 'autonomo', expect: [{ kind: 'income', amount: 1800 }] },
  { id: 'm-salario', text: 'recebi meu salário de 3000', profile: 'clt', expect: [{ kind: 'income', amount: 3000 }] },
  { id: 'm-guardei', text: 'guardei 200 na reserva', profile: 'clt', expect: [{ kind: 'saving', amount: 200 }] },
  { id: 'm-luz', text: 'paguei 120 de luz', profile: 'other', expect: [{ kind: 'expense', amount: 120 }] },
  { id: 'm-uber', text: 'ganhei 250 na uber hoje', profile: 'driver', expect: [{ kind: 'income', amount: 250 }] },
  { id: 'm-gasolina', text: 'coloquei 100 de gasolina', profile: 'driver', expect: [{ kind: 'fuel' }] },
  { id: 'm-misto', text: 'recebi 1800 e gastei 150 de areia', profile: 'autonomo', expect: [{ kind: 'income', amount: 1800 }, { kind: 'expense', amount: 150 }] },
  { id: 'm-saldo', text: 'meu saldo é 1500', profile: 'other', expect: [{ kind: 'balance', amount: 1500 }], semModalidade: true },
  { id: 'm-feira', text: 'gastei 45 na feira', profile: 'other', expect: [{ kind: 'expense', amount: 45 }] },
  { id: 'm-farmacia', text: 'paguei 89 na farmácia ontem', profile: 'other', expect: [{ kind: 'expense', amount: 89 }] },
  { id: 'm-freela', text: 'recebi 1200 de um freela', profile: 'autonomo', expect: [{ kind: 'income', amount: 1200 }] },
  { id: 'm-venda', text: 'recebi 300 de uma venda', profile: 'autonomo', expect: [{ kind: 'income', amount: 300 }] },
  { id: 'm-internet', text: 'paguei 99 de internet', profile: 'clt', expect: [{ kind: 'expense', amount: 99 }] },
  { id: 'm-separei', text: 'separei 350 pra reserva', profile: 'clt', expect: [{ kind: 'saving', amount: 350 }] },
  { id: 'm-99', text: 'ganhei 399 na 99 hoje', profile: 'driver', expect: [{ kind: 'income', amount: 399 }] },
  { id: 'm-km', text: 'rodei 161 km hoje', profile: 'driver', expect: [{ kind: 'work' }], semDinheiro: true },
  { id: 'm-oleo', text: 'troquei o óleo por 280', profile: 'driver', expect: [{ kind: 'maintenance' }] },
  { id: 'm-duplo', text: 'gastei 40 de pedágio e 60 de estacionamento', profile: 'driver', expect: [{ kind: 'expense' }, { kind: 'expense' }] },
]

// ---------------------------------------------------------------------------
// Transformações que PRESERVAM o sentido
// ---------------------------------------------------------------------------

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

const FILLERS = ['tipo', 'então', 'aí', 'sei lá', 'olha', 'cara', 'mano', 'pô']

/**
 * Muletas para inserir NO MEIO da frase. "Cara", "olha" e "velho" ficam de fora
 * porque, no meio, elas sao ambiguas de verdade: "troquei O CARA oleo" e ruido,
 * mas "o cara me pagou 50" e o sujeito da frase. Tirar uma palavra que pode ser
 * conteudo e pior do que nao entender a frase com ruido — e por isso a mutacao
 * nao afirma nada sobre essa posicao. Limitacao conhecida e documentada.
 */
const FILLERS_MEIO = ['tipo', 'então', 'aí', 'sei lá', 'mano', 'pô']

export interface Mutacao { nome: string; aplica: (s: string, r: () => number) => string }

/**
 * Cada uma destas mudanças é uma coisa que o usuário REAL faz e que não muda o
 * que ele quis dizer. Se alguma delas alterar o lançamento, o app está lendo
 * ortografia em vez de sentido.
 */
export const PRESERVAM: Mutacao[] = [
  { nome: 'sem acento', aplica: s => semAcento(s) },
  { nome: 'caixa alta', aplica: s => s.toUpperCase() },
  { nome: 'caixa baixa', aplica: s => s.toLowerCase() },
  { nome: 'sem pontuação', aplica: s => s.replace(/[.,!?;]/g, '') },
  { nome: 'ponto final', aplica: s => `${s.replace(/[.!?]+$/, '')}.` },
  { nome: 'espaço duplicado', aplica: (s, r) => {
    const p = s.split(' ')
    const i = Math.floor(r() * (p.length - 1)) + 1
    return [...p.slice(0, i), '', ...p.slice(i)].join(' ')
  } },
  { nome: 'espaço no fim', aplica: s => `  ${s}   ` },
  { nome: 'filler no começo', aplica: (s, r) => `${FILLERS[Math.floor(r() * FILLERS.length)]} ${s}` },
  { nome: 'filler no meio', aplica: (s, r) => {
    const p = s.split(' ')
    const i = Math.max(1, Math.floor(r() * (p.length - 1)))
    return [...p.slice(0, i), FILLERS_MEIO[Math.floor(r() * FILLERS_MEIO.length)], ...p.slice(i)].join(' ')
  } },
  { nome: 'transposição no verbo', aplica: s => trocaLetras(s, 0) },
  { nome: 'letra a menos no verbo', aplica: s => tiraLetra(s, 0) },
  { nome: 'abreviação de hoje', aplica: s => s.replace(/\bhoje\b/i, 'hj') },
  { nome: 'reais explícito', aplica: s => s.replace(/(\d+)/, '$1 reais') },
  { nome: 'R$ na frente', aplica: s => s.replace(/(\d+)/, 'R$ $1') },
]

/** Troca duas letras vizinhas da n-ésima palavra com 5+ letras (o verbo). */
function trocaLetras(s: string, alvo: number): string {
  const p = s.split(' ')
  let vistos = 0
  for (let i = 0; i < p.length; i++) {
    if (p[i].length < 5 || /\d/.test(p[i])) continue
    if (vistos++ !== alvo) continue
    const w = p[i]
    p[i] = w[0] + w[2] + w[1] + w.slice(3)
    break
  }
  return p.join(' ')
}

/** Tira a última letra da n-ésima palavra com 6+ letras. */
function tiraLetra(s: string, alvo: number): string {
  const p = s.split(' ')
  let vistos = 0
  for (let i = 0; i < p.length; i++) {
    if (p[i].length < 6 || /\d/.test(p[i])) continue
    if (vistos++ !== alvo) continue
    p[i] = p[i].slice(0, -1)
    break
  }
  return p.join(' ')
}

// ---------------------------------------------------------------------------
// Transformações que MUDAM a modalidade
// ---------------------------------------------------------------------------

/**
 * Estas NÃO podem produzir o mesmo fato realizado. Negar, pôr no futuro,
 * transformar em hipótese, em pergunta ou em dúvida muda o que a frase afirma —
 * e um app que registra qualquer uma delas está criando dinheiro que não existe.
 */
/**
 * Negacoes que negam a PROPRIA frase. "Nada disso, gastei 80 no mercado" ficou
 * de fora de proposito: em portugues real ela nega algo ANTERIOR, e o gasto de
 * 80 e um fato novo que deve mesmo ser registrado. Uma mutacao ambigua nao
 * prova nada sobre o app — prova sobre o gerador.
 */
const NEGACOES = ['não', 'nao', 'não, eu não', 'nem']
const AUXILIARES = ['vou', 'pretendo', 'ainda vou', 'penso em']
const HIPOTETICOS = ['se eu', 'e se eu', 'supondo que eu']

const escolhe = (lista: string[], r: () => number) => lista[Math.floor(r() * lista.length) % lista.length]

export const MUDAM: Mutacao[] = [
  { nome: 'negação', aplica: (s, r) => `${escolhe(NEGACOES, r)} ${s}` },
  { nome: 'negação enfática', aplica: (s, r) => `${escolhe(NEGACOES, r)} ${s}, foi engano` },
  // Tirar o marcador de passado é parte da transformação: "vou gastar 190 de
  // cimento ONTEM" é contraditória, e o que ela testaria seria o gerador.
  { nome: 'futuro', aplica: (s, r) => `${escolhe(AUXILIARES, r)} ${infinitivo(semPassado(s))}` },
  { nome: 'futuro com amanhã', aplica: s => `amanhã eu vou ${infinitivo(semPassado(s))}` },
  { nome: 'hipótese', aplica: (s, r) => `${escolhe(HIPOTETICOS, r)} ${infinitivo(semPassado(s))}, quanto sobra?` },
  { nome: 'hipótese curta', aplica: (s, r) => `${escolhe(HIPOTETICOS, r)} ${infinitivo(semPassado(s))}?` },
  { nome: 'pergunta de permissão', aplica: s => `posso ${infinitivo(semPassado(s))}?` },
  { nome: 'dúvida', aplica: s => `acho que ${s}` },
  { nome: 'intenção', aplica: s => `tô pensando em ${infinitivo(semPassado(s))}` },
  { nome: 'pretendo', aplica: s => `pretendo ${infinitivo(semPassado(s))}` },
]

/** Tira o marcador de dia passado — o futuro não convive com "ontem". */
const semPassado = (s: string) => s.replace(/\b(?:ontem|anteontem|hoje|hj)\b/gi, '').replace(/\s{2,}/g, ' ').trim()

/** Passa o verbo da frase para o infinitivo, preservando o resto. */
const INFINITIVO: [RegExp, string][] = [
  [/\bgastei\b/i, 'gastar'], [/\bpaguei\b/i, 'pagar'], [/\brecebi\b/i, 'receber'],
  [/\bganhei\b/i, 'ganhar'], [/\bguardei\b/i, 'guardar'], [/\bcoloquei\b/i, 'colocar'],
  [/\bcomprei\b/i, 'comprar'], [/\bmeu saldo é\b/i, 'ter de saldo'],
  // Sem estes, a mutação produzia "vou separei 350" — que não é português, e o
  // que ela testaria seria o gerador, não o app.
  [/\bseparei\b/i, 'separar'], [/\brodei\b/i, 'rodar'], [/\btroquei\b/i, 'trocar'],
  [/\bvendi\b/i, 'vender'], [/\bfaturei\b/i, 'faturar'], [/\blucrei\b/i, 'lucrar'],
  [/\bbotei\b/i, 'botar'], [/\babasteci\b/i, 'abastecer'], [/\btirei\b/i, 'tirar'],
]

function infinitivo(s: string): string {
  let out = s
  for (const [re, sub] of INFINITIVO) out = out.replace(re, sub)
  return out
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

export interface MetamorphicReport {
  preservadas: number
  mudadas: number
  falhas: string[]
}

const acoesDe = (r: { actions: { action: ParsedAction }[] }) => r.actions.map(a => a.action)

/** Assinatura comparável de uma ação: tipo + valor. Descrição pode variar. */
const assinatura = (a: ParsedAction): string => {
  const x: any = a
  const v = x.amount ?? x.total ?? x.cost ?? x.value ?? ''
  return `${a.kind}:${typeof v === 'number' ? Math.round(v * 100) : v}`
}

const estadoDe = (perfil: Canonica['profile']): AppState =>
  buildState({ profile: perfil, cards: [{ name: 'Nubank' }] })

/**
 * Roda o corpus metamórfico inteiro.
 *
 * `repeticoes` multiplica as mutações com aleatoriedade (espaço duplicado,
 * filler) — cada repetição usa uma semente derivada da original, então o
 * conjunto continua determinístico.
 */
export async function runMetamorphic(repeticoes = 20, seed = 20260824): Promise<MetamorphicReport> {
  const falhas: string[] = []
  let preservadas = 0
  let mudadas = 0

  for (const c of CANONICAS) {
    const state = estadoDe(c.profile)
    const base = await orchestrate({
      state, message: c.text, history: [], remoteEnabled: false, today: TODAY,
    })
    const esperado = acoesDe(base.response).map(assinatura).sort().join('|')
    if (!esperado) {
      falhas.push(`[${c.id}] a própria frase canônica não produziu ação: "${c.text}"`)
      continue
    }

    for (let rep = 0; rep < repeticoes; rep++) {
      const r = rng(seed + rep * 7919 + c.id.length)
      for (const m of PRESERVAM) {
        if (c.semDinheiro && /reais|R\$/.test(m.nome)) continue
        const texto = m.aplica(c.text, r)
        if (texto === c.text) continue
        preservadas++
        const out = await orchestrate({
          state, message: texto, history: [], remoteEnabled: false, today: TODAY,
        })
        const got = acoesDe(out.response).map(assinatura).sort().join('|')
        if (got !== esperado) {
          falhas.push(`[${c.id}] "${m.nome}" mudou o resultado: "${texto}" → ${got || '(nada)'} ≠ ${esperado}`)
        }
      }
    }

    if (c.semModalidade) continue
    for (let rep = 0; rep < repeticoes; rep++) {
      const r = rng(seed + rep * 104729 + c.id.length)
      for (const m of MUDAM) {
      const texto = m.aplica(c.text, r)
      mudadas++
      const out = await orchestrate({
        state, message: texto, history: [], remoteEnabled: false, today: TODAY,
      })
      const acoes = acoesDe(out.response)
      const igual = acoes.map(assinatura).sort().join('|') === esperado
      if (igual) {
        falhas.push(`[${c.id}] "${m.nome}" produziu O MESMO fato realizado: "${texto}"`)
      }
      }
    }
  }

  return { preservadas, mudadas, falhas }
}
