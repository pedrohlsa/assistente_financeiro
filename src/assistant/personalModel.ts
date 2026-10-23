// MODELO PESSOAL — o que o histórico deste usuário, e só dele, permite afirmar.
//
// Este módulo CONSTRÓI o conhecimento. Quem decide o que fazer com ele é
// `learning.ts` (propostas), `suggestions.ts` (atalhos) e `explain.ts`
// (respostas). Separar as duas coisas é o que impede o aprendizado de virar um
// módulo monolítico onde ninguém sabe mais o que decide o quê.
//
// Três decisões sustentam o resto:
//
// 1. TUDO É DERIVADO. Nada aqui é gravado: o modelo é recalculado a partir de
//    `state.transactions`, que é o que o usuário CONFIRMOU e que realmente
//    entrou no estado. Consequências que vêm de graça e que um armazenamento
//    paralelo não teria: apagar o histórico apaga o aprendizado, corrigir um
//    lançamento corrige o padrão, desfazer um lote remove a evidência, backup
//    antigo carrega sem migração, e o estado de um cliente não tem como
//    influenciar o de outro porque não existe nada fora do estado.
//
// 2. EVIDÊNCIA, NÃO PALPITE. Cada coisa aprendida carrega peso, tamanho de
//    amostra, data da última ocorrência e o rival mais próximo. É isso que
//    permite responder "por que" e é isso que separa "posso preencher um campo
//    vazio" de "posso contrariar a lista genérica do app".
//
// 3. RECÊNCIA COM PISO. O peso de uma ocorrência decai pela metade a cada 90
//    dias, mas nunca abaixo de 15%. Hábito que mudou é reconhecido; hábito raro
//    ou sazonal não é destruído; e quatro lançamentos de seis anos atrás
//    deixam de decidir um gasto de hoje sozinhos.
//
// O que este módulo NUNCA produz: valor, data, tipo financeiro, taxa, cartão.
// Ele só sabe de VOCABULÁRIO (que categoria o usuário dá a que frase), GRAFIA
// (como ele escreve o nome daquele lugar) e ORDEM DE GRANDEZA (quanto ele
// costuma lançar em cada categoria).

import type { AppState, Transaction } from '../models/types'
import { usableCategories } from '../data/categories'
import { fromISO } from '../utils/format'
import { normalizeName } from '../utils/text'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type MoneyType = 'income' | 'expense'
export type EntityField = 'description' | 'origin'

/**
 * Força da evidência. É esta escala, e não um booleano, que faz o aprendizado
 * respeitar a hierarquia: só `strong` preenche campo vazio e só `overriding`
 * contraria a lista genérica do app.
 */
export type EvidenceStrength = 'none' | 'moderate' | 'strong' | 'overriding'

export interface LearnedPattern<T> {
  value: T
  /** Fração do peso total que aponta para `value` (0..1). */
  confidence: number
  /** Peso com recência aplicada — NÃO é a contagem crua. */
  weight: number
  /** Quantos lançamentos sustentam. */
  sampleSize: number
  strength: EvidenceStrength
  lastSeenAt?: string
  firstSeenAt?: string
  /** Segundo colocado. Rival próximo é motivo para NÃO decidir sozinho. */
  runnerUp?: { value: T; weight: number; sampleSize: number }
  /** Frases que sustentaram a conclusão — matéria-prima da explicação. */
  evidence: string[]
  source: 'confirmed-history' | 'explicit-preference'
}

export interface AmountProfile {
  median: number
  sampleSize: number
  from: string
  to: string
}

export interface PersonalAssistantModel {
  /** Desligado pelo usuário: o modelo existe, mas responde vazio em tudo. */
  readonly enabled: boolean
  readonly today: string
  /** Amostra realmente considerada — entra em toda explicação. */
  readonly sample: { total: number; from?: string; to?: string }

  /** Categoria que o usuário costuma dar a este texto. */
  categoryFor(text: string, type: MoneyType): LearnedPattern<string> | undefined
  /**
   * Candidatos crus do melhor nível de chave, sem o corte de confiança. É o que
   * permite PERGUNTAR quando duas categorias fortes disputam a mesma frase, em
   * vez de simplesmente desistir das duas.
   */
  rawCandidates(text: string, type: MoneyType): { category: string; weight: number; sampleSize: number }[]
  /** Grafia que o usuário já usou para este mesmo nome. */
  spellingFor(text: string, type: MoneyType, field: EntityField): LearnedPattern<string> | undefined
  /** Ordem de grandeza dos lançamentos daquele tipo e categoria. */
  amountProfile(type: MoneyType, category: string): AmountProfile | undefined
  /** Categorias mais usadas, já com recência. Para sugestões e contexto remoto. */
  topCategories(type: MoneyType, limit?: number): { id: string; weight: number; sampleSize: number }[]
  /** Lugares/nomes que ele mais repete, na grafia dele. */
  frequentPlaces(type: MoneyType, limit?: number): { text: string; weight: number; sampleSize: number; lastSeenAt: string }[]
  /** Quantas vezes ele lançou algo com este nome (para "quantas vezes eu fiz isso?"). */
  timesSeen(text: string, type: MoneyType): { count: number; category?: string; lastSeenAt?: string }
}

// ---------------------------------------------------------------------------
// Constantes de recência e confiança
// ---------------------------------------------------------------------------

/** Teto de lançamentos lidos, dos mais recentes para trás. */
const MAX_TRANSACOES = 800

/** Em quantos dias o peso de uma ocorrência cai pela metade. */
const MEIA_VIDA_DIAS = 90
/**
 * Piso do peso. Sem ele o histórico antigo sumiria de vez e um padrão sazonal
 * (IPVA, material escolar, viagem de fim de ano) seria destruído todo ano.
 * Com ele, evidência velha continua contando — só precisa ser mais numerosa.
 */
const PESO_MINIMO = 0.15

/** Peso mínimo para a evidência sequer aparecer numa sugestão. */
const PESO_MODERADO = 1.0
/** Peso mínimo para PREENCHER um campo que o usuário não informou (~2 recentes). */
const PESO_FORTE = 1.7
/** Peso mínimo para CONTRARIAR a lista genérica do app (~3 recentes). */
const PESO_CONTRARIAR = 2.6

const CONFIANCA_MINIMA = 0.6
const CONFIANCA_PARA_CONTRARIAR = 0.75
/**
 * Rival a partir deste tanto do peso do vencedor = empate técnico. Duas
 * categorias disputando a mesma frase não podem ser resolvidas na sorte —
 * quem decide é o usuário, no card da proposta.
 */
const RIVAL_PROXIMO = 0.7

/**
 * O que conta como "comportamento de agora". Quatro meses é largo o bastante
 * para não confundir uma semana atípica com mudança de hábito, e curto o
 * bastante para o app acompanhar quem mudou de rotina de verdade.
 */
const JANELA_RECENTE_DIAS = 120

/** Amostra mínima para "o normal dele" significar alguma coisa. */
const MIN_AMOSTRA_VALOR = 6
/** Últimos lançamentos daquela categoria usados na mediana. */
const JANELA_VALOR = 60

// ---------------------------------------------------------------------------
// Vocabulário genérico
// ---------------------------------------------------------------------------

/** Palavras funcionais: não identificam nada e não podem abrir nem fechar frase. */
const FUNCIONAIS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'com', 'para',
  'pra', 'pro', 'por', 'pelo', 'pela', 'um', 'uma', 'uns', 'umas', 'o', 'a',
  'os', 'as', 'meu', 'minha', 'meus', 'minhas', 'seu', 'sua', 'e', 'ao', 'aos',
])

/**
 * Palavras que descrevem uma CLASSE de lugar ou de gasto, não um lugar
 * específico. Sozinhas elas não identificam nada: "casa" aparece em "Conta de
 * luz da casa" e em "comida na casa da minha mãe", e aprender por ela fazia o
 * almoço na casa da mãe virar categoria Casa com evidência forte.
 *
 * A restrição é ESTREITA de propósito: ela vale apenas quando a palavra é a
 * única ponte entre a frase nova e o histórico. Quando o usuário escreve
 * exatamente "Mercado" e o histórico dele tem exatamente "Mercado", a frase
 * inteira coincide e o aprendizado continua valendo — é o mesmo lugar.
 */
const GENERICAS = new Set([
  'casa', 'conta', 'contas', 'hoje', 'ontem', 'mes', 'dia', 'semana', 'ano',
  'mercado', 'mercadinho', 'supermercado', 'feira', 'posto', 'loja', 'lojas',
  'padaria', 'bar', 'restaurante', 'lanchonete', 'oficina', 'farmacia', 'banco',
  'shopping', 'acougue', 'quitanda', 'corrida', 'corridas', 'viagem', 'viagens',
  'almoco', 'janta', 'jantar', 'lanche', 'cafe', 'compra', 'compras', 'comida',
  'gasolina', 'combustivel', 'etanol', 'alcool', 'gnv', 'diesel', 'aditivado',
  'uber', 'indrive', 'indriver', 'app', 'aplicativo', 'salario', 'aluguel',
  'luz', 'agua', 'internet', 'telefone', 'celular', 'remedio', 'remedios',
  'gasto', 'gastos', 'despesa', 'despesas', 'receita', 'entrada', 'saida',
])

const tokensOf = (texto: string): string[] =>
  normalizeName(texto).split(/[^a-z0-9]+/).filter(Boolean)

const identificavel = (tok: string) =>
  tok.length >= 3 && !FUNCIONAIS.has(tok) && !GENERICAS.has(tok)

/**
 * Chaves pelas quais uma frase pode ser reconhecida, da mais específica para a
 * menos. O nível é o que sustenta a regra da fase 4: a FRASE identifica, a
 * palavra genérica solta não.
 *
 * - nível 3 `=frase`: o texto inteiro, igualzinho (ignorando acento e caixa);
 * - nível 2 `~n-grama`: trecho de 2 ou 3 palavras que não começa nem termina em
 *   palavra funcional;
 * - nível 1 `#palavra`: uma palavra só, e apenas se ela identificar algo.
 */
function keysOf(texto: string): { key: string; level: 1 | 2 | 3 }[] {
  const full = normalizeName(texto)
  if (!full) return []
  const out: { key: string; level: 1 | 2 | 3 }[] = [{ key: `=${full}`, level: 3 }]

  const toks = tokensOf(texto)
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const gram = toks.slice(i, i + n)
      if (FUNCIONAIS.has(gram[0]) || FUNCIONAIS.has(gram[gram.length - 1])) continue
      // Um n-grama todo genérico ("compras mercado") continua sem identificar
      // lugar nenhum — precisa de pelo menos uma palavra própria.
      if (!gram.some(identificavel)) continue
      out.push({ key: `~${gram.join(' ')}`, level: 2 })
    }
  }
  for (const t of toks) if (identificavel(t)) out.push({ key: `#${t}`, level: 1 })
  return out
}

// ---------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------

interface Bucket {
  weight: number
  /**
   * Peso contando SÓ a janela recente. Sem ele a confiança fica diluída pelo
   * passado: três lançamentos deste mês contra cinco de janeiro dão 63% de
   * confiança global — evidência demais para ignorar e de menos para discordar
   * do app —, e o hábito que mudou nunca chegava a valer.
   */
  recent: number
  count: number
  recentCount: number
  lastSeenAt: string
  firstSeenAt: string
}

const bump = (m: Map<string, Bucket>, k: string, w: number, date: string, recente: boolean) => {
  const b = m.get(k)
  if (!b) {
    m.set(k, {
      weight: w, recent: recente ? w : 0, count: 1, recentCount: recente ? 1 : 0,
      lastSeenAt: date, firstSeenAt: date,
    })
    return
  }
  b.weight += w
  b.count += 1
  if (recente) { b.recent += w; b.recentCount += 1 }
  if (date > b.lastSeenAt) b.lastSeenAt = date
  if (date < b.firstSeenAt) b.firstSeenAt = date
}

/**
 * Data que dá para situar no tempo.
 *
 * O modelo INTEIRO é temporal, e uma data ilegível não é só um dado a menos:
 * `fromISO('lixo')` devolve Invalid Date, o peso vira NaN, o NaN contamina o
 * total da categoria — e o usuário recebe "a última em Invalid Date" na
 * explicação. Backup mesclado e estado antigo podem trazer qualquer coisa aqui,
 * porque nada nunca validou o que já estava gravado.
 */
export const isReadableDate = (d: unknown): d is string =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(fromISO(d).getTime())

export const ageInDays = (date: string, today: string): number =>
  Math.max(0, Math.round((fromISO(today).getTime() - fromISO(date).getTime()) / 86400000))

/** Peso de uma ocorrência pela idade, com meia-vida e piso. */
export function recencyWeight(date: string, today: string): number {
  return PESO_MINIMO + (1 - PESO_MINIMO) * Math.pow(0.5, ageInDays(date, today) / MEIA_VIDA_DIAS)
}

/**
 * Categorias candidatas para um texto, no MELHOR nível de chave que tiver
 * evidência: a frase inteira ganha do n-grama, que ganha da palavra solta.
 * Assim que um nível responde, para — descer para a palavra solta depois de a
 * frase ter batido só enfraqueceria uma evidência melhor com uma pior.
 */
function rankCategories(
  porChave: Map<string, Map<string, Bucket>> | undefined,
  texto: string,
): { ranked: [string, Bucket][]; usadas: string[] } | undefined {
  if (!porChave || !texto) return undefined
  const porNivel = new Map<number, string[]>()
  for (const { key, level } of keysOf(texto)) {
    const arr = porNivel.get(level) || []
    arr.push(key)
    porNivel.set(level, arr)
  }
  for (const level of [3, 2, 1]) {
    const keys = porNivel.get(level)
    if (!keys) continue
    const somado = new Map<string, Bucket>()
    const usadas: string[] = []
    for (const key of keys) {
      const porCat = porChave.get(key)
      if (!porCat) continue
      usadas.push(key.slice(1))
      for (const [cat, b] of porCat) {
        const cur = somado.get(cat)
        if (!cur) { somado.set(cat, { ...b }); continue }
        // A mesma transação pode bater em duas chaves do mesmo nível
        // ("~zé da" e "~da esquina"): o peso não pode dobrar por isso.
        cur.weight = Math.max(cur.weight, b.weight)
        cur.recent = Math.max(cur.recent, b.recent)
        cur.count = Math.max(cur.count, b.count)
        cur.recentCount = Math.max(cur.recentCount, b.recentCount)
        if (b.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = b.lastSeenAt
        if (b.firstSeenAt < cur.firstSeenAt) cur.firstSeenAt = b.firstSeenAt
      }
    }
    if (!somado.size) continue
    return { ranked: [...somado.entries()].sort((a, b) => b[1].weight - a[1].weight), usadas }
  }
  return undefined
}

/**
 * A evidência é medida DUAS vezes: sobre todo o histórico e sobre a janela
 * recente. Discordar da lista genérica basta uma das duas leituras convencer —
 * é assim que a mudança de hábito passa a valer sem que o histórico antigo
 * precise ser apagado, e é assim que um padrão sazonal, que só aparece forte na
 * leitura global, continua valendo fora da estação.
 */
const strengthOf = (
  weight: number, confidence: number,
  recentWeight: number, recentConfidence: number,
): EvidenceStrength => {
  const contraria = (weight >= PESO_CONTRARIAR && confidence >= CONFIANCA_PARA_CONTRARIAR)
    || (recentWeight >= PESO_CONTRARIAR && recentConfidence >= CONFIANCA_PARA_CONTRARIAR)
  if (contraria) return 'overriding'
  if (weight >= PESO_FORTE && confidence >= CONFIANCA_MINIMA) return 'strong'
  if (weight >= PESO_MODERADO && confidence >= CONFIANCA_MINIMA) return 'moderate'
  return 'none'
}

const MODELO_VAZIO = (today: string): PersonalAssistantModel => ({
  enabled: false,
  today,
  sample: { total: 0 },
  categoryFor: () => undefined,
  rawCandidates: () => [],
  spellingFor: () => undefined,
  amountProfile: () => undefined,
  topCategories: () => [],
  frequentPlaces: () => [],
  timesSeen: () => ({ count: 0 }),
})

/**
 * Cache por IDENTIDADE do estado. O reducer devolve um objeto novo a cada
 * mudança, então uma transação nova, uma correção ou um `resetAllData` já
 * invalidam a entrada sozinhos. E como a chave é o próprio estado, não existe
 * cache global que possa sobreviver a uma troca de aparelho, a um backup
 * importado ou a um segundo cliente: outro estado é outra chave.
 */
const CACHE = new WeakMap<AppState, Map<string, PersonalAssistantModel>>()

export function buildPersonalModel(state: AppState, today: string): PersonalAssistantModel {
  let porDia = CACHE.get(state)
  if (!porDia) { porDia = new Map(); CACHE.set(state, porDia) }
  const hit = porDia.get(today)
  if (hit) return hit
  const model = computeModel(state, today)
  porDia.set(today, model)
  return model
}

/** Aprendizado pessoal ligado? Ausente = ligado (dado antigo não tem o campo). */
export const adaptiveEnabled = (state: AppState): boolean =>
  state.settings?.adaptiveAssistant !== false

function computeModel(state: AppState, today: string): PersonalAssistantModel {
  if (!adaptiveEnabled(state)) return MODELO_VAZIO(today)

  const usable = new Set(usableCategories(state.categories || []).map(c => c.id))

  // Ordenar por DATA, não pela ordem de inserção: um backup mesclado entra no
  // fim da lista (`mergeState`) e um lançamento retroativo entra no começo.
  // Cortar por posição faria o app ler "os 800 mais recentemente digitados",
  // que não é a mesma coisa que "os 800 mais recentes".
  const seenTxIds = new Set<string>()
  const txs = (state.transactions || [])
    // Data ilegível, valor não numérico e lançamento datado no FUTURO ficam de
    // fora. `validateAction` já barra data futura na criação, então isso só
    // chega por dado antigo ou backup mesclado — e um gasto de 2099 não é
    // hábito de hoje: contando como idade zero ele ganhava peso máximo e ainda
    // aparecia na explicação como o fim do período observado.
    .filter((t): t is Transaction => !!t && (t.type === 'income' || t.type === 'expense')
      && isReadableDate(t.date) && t.date <= today && Number.isFinite(t.amount))
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    // Backup/merge pode repetir o mesmo ID: seis cópias não são seis hábitos.
    .filter(t => {
      if (!t.id) return true
      if (seenTxIds.has(t.id)) return false
      seenTxIds.add(t.id)
      return true
    })
    .slice(0, MAX_TRANSACOES)

  // type → chave → categoria → bucket
  const catIndex = new Map<string, Map<string, Map<string, Bucket>>>()
  // type:field → frase normalizada → grafia original → bucket
  const spellIndex = new Map<string, Map<string, Map<string, Bucket>>>()
  // type:categoria → valores (dos mais recentes para trás)
  const amounts = new Map<string, { values: number[]; from: string; to: string }>()
  // type → categoria → bucket
  const catUse = new Map<string, Map<string, Bucket>>()
  // type → grafia → bucket
  const places = new Map<string, Map<string, Bucket>>()

  const nested = <T>(m: Map<string, Map<string, T>>, k: string) => {
    let inner = m.get(k)
    if (!inner) { inner = new Map(); m.set(k, inner) }
    return inner
  }

  for (const t of txs) {
    const type = t.type as MoneyType
    const w = recencyWeight(t.date, today)
    const recente = ageInDays(t.date, today) <= JANELA_RECENTE_DIAS
    const cat = t.category

    if (cat && usable.has(cat)) {
      bump(nested(catUse, type), cat, w, t.date, recente)

      const chaves = new Map<string, 1 | 2 | 3>()
      for (const campo of ['description', 'origin'] as EntityField[]) {
        const texto = (t as any)[campo]
        if (typeof texto !== 'string' || !texto.trim()) continue
        for (const { key } of keysOf(texto)) chaves.set(key, 1)
      }
      const porChave = nested(catIndex, type)
      for (const key of chaves.keys()) bump(nested(porChave, key), cat, w, t.date, recente)
    }

    for (const campo of ['description', 'origin'] as EntityField[]) {
      const texto = (t as any)[campo]
      if (typeof texto !== 'string' || !texto.trim()) continue
      const norm = normalizeName(texto)
      if (norm.length < 2) continue
      bump(nested(nested(spellIndex, `${type}:${campo}`), norm), texto.trim(), w, t.date, recente)
      if (campo === 'description') bump(nested(places, type), texto.trim(), w, t.date, recente)
    }

    if (cat && t.amount > 0 && recente) {
      const k = `${type}:${cat}`
      const a = amounts.get(k)
      if (!a) amounts.set(k, { values: [t.amount], from: t.date, to: t.date })
      else if (a.values.length < JANELA_VALOR) {
        a.values.push(t.amount)
        if (t.date < a.from) a.from = t.date
        if (t.date > a.to) a.to = t.date
      }
    }
  }

  const datas = txs.map(t => t.date).filter(Boolean)
  const sample = {
    total: txs.length,
    from: datas.length ? datas[datas.length - 1] : undefined,
    to: datas.length ? datas[0] : undefined,
  }

  const mediana = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b)
    const meio = Math.floor(s.length / 2)
    return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2
  }

  const model: PersonalAssistantModel = {
    enabled: true,
    today,
    sample,

    categoryFor(texto, type) {
      const r = rankCategories(catIndex.get(type), texto)
      if (!r) return undefined
      const [cat, top] = r.ranked[0]
      const total = r.ranked.reduce((acc, [, b]) => acc + b.weight, 0)
      const totalRecente = r.ranked.reduce((acc, [, b]) => acc + b.recent, 0)
      const confidence = total > 0 ? top.weight / total : 0
      const confRecente = totalRecente > 0 ? top.recent / totalRecente : 0
      const rival = r.ranked[1]
      // Empate técnico: existe evidência, mas ela não aponta para um lado.
      // Escolher aqui seria dar cara de certeza a um sorteio.
      const empatado = !!rival && rival[1].weight >= top.weight * RIVAL_PROXIMO
      const strength = empatado ? 'none' : strengthOf(top.weight, confidence, top.recent, confRecente)
      if (strength === 'none') return undefined
      return {
        value: cat,
        confidence: Math.round(confidence * 100) / 100,
        weight: Math.round(top.weight * 100) / 100,
        sampleSize: top.count,
        strength,
        lastSeenAt: top.lastSeenAt,
        firstSeenAt: top.firstSeenAt,
        runnerUp: rival ? { value: rival[0], weight: Math.round(rival[1].weight * 100) / 100, sampleSize: rival[1].count } : undefined,
        evidence: r.usadas.slice(0, 4),
        source: 'confirmed-history',
      }
    },

    rawCandidates(texto, type) {
      const r = rankCategories(catIndex.get(type), texto)
      if (!r) return []
      return r.ranked.map(([category, b]) => ({
        category, weight: Math.round(b.weight * 100) / 100, sampleSize: b.count,
      }))
    },

    spellingFor(texto, type, field) {
      const norm = normalizeName(texto)
      if (norm.length < 2) return undefined
      const porFrase = spellIndex.get(`${type}:${field}`)
      const variantes = porFrase?.get(norm)
      if (!variantes) return undefined
      const ranked = [...variantes.entries()].sort((a, b) => b[1].weight - a[1].weight)
      const [grafia, top] = ranked[0]
      // Restaurar grafia NÃO é prever comportamento: o texto normalizado é o
      // mesmo, então unificar "Ze" e "Zé" está certo mesmo com evidência
      // antiga. Por isso aqui a régua é repetição crua, não peso com recência —
      // o que não pode acontecer é uma digitação isolada virar padrão.
      if (top.count < 2) return undefined
      const total = ranked.reduce((acc, [, b]) => acc + b.weight, 0)
      return {
        value: grafia,
        confidence: total > 0 ? Math.round((top.weight / total) * 100) / 100 : 1,
        weight: Math.round(top.weight * 100) / 100,
        sampleSize: top.count,
        strength: 'strong',
        lastSeenAt: top.lastSeenAt,
        firstSeenAt: top.firstSeenAt,
        runnerUp: ranked[1] ? { value: ranked[1][0], weight: Math.round(ranked[1][1].weight * 100) / 100, sampleSize: ranked[1][1].count } : undefined,
        evidence: [norm],
        source: 'confirmed-history',
      }
    },

    amountProfile(type, category) {
      const a = amounts.get(`${type}:${category}`)
      if (!a || a.values.length < MIN_AMOSTRA_VALOR) return undefined
      const m = mediana(a.values)
      if (!(m > 0)) return undefined
      return { median: m, sampleSize: a.values.length, from: a.from, to: a.to }
    },

    topCategories(type, limit = 5) {
      const m = catUse.get(type)
      if (!m) return []
      return [...m.entries()]
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, limit)
        .map(([id, b]) => ({ id, weight: Math.round(b.weight * 100) / 100, sampleSize: b.count }))
    },

    frequentPlaces(type, limit = 5) {
      const m = places.get(type)
      if (!m) return []
      return [...m.entries()]
        .filter(([, b]) => b.weight >= PESO_MODERADO)
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, limit)
        .map(([text, b]) => ({ text, weight: Math.round(b.weight * 100) / 100, sampleSize: b.count, lastSeenAt: b.lastSeenAt }))
    },

    timesSeen(texto, type) {
      const norm = normalizeName(texto)
      const porFrase = spellIndex.get(`${type}:description`)
      const variantes = porFrase?.get(norm)
      let count = 0
      let lastSeenAt: string | undefined
      if (variantes) {
        for (const b of variantes.values()) {
          count += b.count
          if (!lastSeenAt || b.lastSeenAt > lastSeenAt) lastSeenAt = b.lastSeenAt
        }
      }
      const cat = this.categoryFor(texto, type)
      return { count, category: cat?.value, lastSeenAt }
    },
  }

  return model
}
