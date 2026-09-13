// CUSTO — medido quando há uso real, projetado quando não há.
//
// A tabela de preços é a parte mais perecível deste diretório: foi copiada da
// página oficial na data abaixo e muda sem aviso (mudou em 10/09/2026, com o
// V4.1 Flash). Toda saída de custo cita a fonte e a data. Em execução real o
// custo de cada chamada sai do `usage` que a própria API devolve.

export const FONTE_PRECOS = 'https://api-docs.deepseek.com/quick_start/pricing'
export const PRECOS_CONSULTADOS_EM = '2026-09-13'

/** USD por 1 milhão de tokens, horário de PICO. Fora do pico é a metade. */
export const PRECOS_PICO: Record<string, { cacheHit: number; cacheMiss: number; saida: number }> = {
  'deepseek-flash': { cacheHit: 0.006, cacheMiss: 0.30, saida: 1.20 },
  'deepseek-v4-pro': { cacheHit: 0.044, cacheMiss: 1.32, saida: 3.96 },
  // Nome LEGADO, que é o default do código de produção. A página diz que ele
  // "ainda é aceito", servido pelo V4.1 Flash e cobrado como Flash — e o
  // changelog diz que o roteamento é TEMPORÁRIO.
  'deepseek-v4-flash': { cacheHit: 0.006, cacheMiss: 0.30, saida: 1.20 },
}

/**
 * Pico: 01:00–04:00 e 06:00–10:00 UTC, segunda a sexta. Em Brasília (UTC−3),
 * 22:00–01:00 e 03:00–07:00. Fim de semana é todo fora do pico.
 */
export function ehPico(d: Date): boolean {
  const dia = d.getUTCDay()
  if (dia === 0 || dia === 6) return false
  const h = d.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

export function precoEm(modelo: string, d: Date): { cacheHit: number; cacheMiss: number; saida: number } {
  const p = PRECOS_PICO[modelo]
  if (!p) throw new Error(`sem preço cadastrado para o modelo "${modelo}"`)
  const f = ehPico(d) ? 1 : 0.5
  return { cacheHit: p.cacheHit * f, cacheMiss: p.cacheMiss * f, saida: p.saida * f }
}

/**
 * Tokens por caractere. A documentação dá "1 caractere em inglês ≈ 0,3 token"
 * e avisa que varia por modelo; português com acento e JSON escapado tende a
 * ficar acima. Por isso a projeção usa 0,30 como central e 0,45 como teto.
 */
export const TOKENS_POR_CARACTERE = { central: 0.30, pessimista: 0.40, teto: 0.45 }

export interface Uso {
  entrada: number
  cacheHit: number
  cacheMiss: number
  saida: number
  raciocinio: number
}

export function usoDaResposta(json: any): Uso {
  const u = json?.usage || {}
  const d = u.prompt_tokens_details || {}
  const hit = Number(u.prompt_cache_hit_tokens ?? d.prompt_cache_hit_tokens ?? d.cached_tokens ?? 0) || 0
  const entrada = Number(u.prompt_tokens ?? 0) || 0
  const miss = Number(u.prompt_cache_miss_tokens ?? d.prompt_cache_miss_tokens ?? Math.max(entrada - hit, 0)) || 0
  return {
    entrada: entrada || hit + miss,
    cacheHit: hit,
    cacheMiss: miss,
    saida: Number(u.completion_tokens ?? 0) || 0,
    raciocinio: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
  }
}

/**
 * A documentação não diz se `completion_tokens` já inclui o raciocínio. Se o
 * raciocínio informado for MAIOR que a saída, ele não pode estar incluído — e
 * é somado. É a leitura que nunca subestima.
 */
export function custoUSD(modelo: string, u: Uso, d: Date): number {
  const p = precoEm(modelo, d)
  const saidaCobrada = u.raciocinio > u.saida ? u.saida + u.raciocinio : u.saida
  return (u.cacheHit * p.cacheHit + u.cacheMiss * p.cacheMiss + saidaCobrada * p.saida) / 1e6
}

/** Reserva feita ANTES de cada chamada real: entrada toda sem cache, saída no teto de `max_tokens`. */
export function piorCasoUSD(modelo: string, caracteres: number, maxTokens: number | undefined, d: Date): number {
  const entrada = Math.ceil(caracteres * TOKENS_POR_CARACTERE.teto)
  return custoUSD(modelo, { entrada, cacheHit: 0, cacheMiss: entrada, saida: maxTokens || 900, raciocinio: 0 }, d)
}

/** `usage` sintético do modo falso — só para o pipeline fechar a conta sem rede. */
export function usoFalso(caracteresEntrada: number, caracteresSaida: number): Record<string, number> {
  const entrada = Math.ceil(caracteresEntrada * TOKENS_POR_CARACTERE.central)
  return {
    prompt_tokens: entrada,
    completion_tokens: Math.ceil(caracteresSaida * TOKENS_POR_CARACTERE.central),
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: entrada,
  }
}

// ---------------------------------------------------------------------------
// Projeção
// ---------------------------------------------------------------------------

export type TarefaCusto = 'chat' | 'plano' | 'cenario'

export interface ChamadaPrevista {
  config: string
  modelo: string
  pensamentoLigado: boolean
  tarefa: TarefaCusto
  /** Caracteres EXATOS das mensagens, capturados do pipeline real com rede falsa. */
  caracteres: number
  maxTokens: number
}

export interface Premissas {
  nome: string
  tokensPorCaractere: number
  /** Fração dos tokens de entrada cobrada como acerto de cache. */
  fracaoCache: number
  pico: boolean
  saidaTokens: Record<TarefaCusto, number>
  /** Somado à saída quando o pensamento está ligado. */
  raciocinioTokens: number
  /** `max_tokens` corta raciocínio + resposta juntos (não documentado; ver relatório). */
  maxTokensCortaTudo: boolean
  /** Média de chamadas HTTP por chamada lógica (o retry de `callDeepSeekChat`). */
  fatorTentativas: number
  latenciaMs: { semPensamento: number; comPensamento: number }
}

export const PREMISSAS: Premissas[] = [
  {
    nome: 'central', tokensPorCaractere: 0.30, fracaoCache: 0.6, pico: false,
    saidaTokens: { chat: 250, plano: 180, cenario: 200 }, raciocinioTokens: 600,
    maxTokensCortaTudo: true, fatorTentativas: 1.05,
    latenciaMs: { semPensamento: 3500, comPensamento: 11000 },
  },
  {
    nome: 'pessimista', tokensPorCaractere: 0.40, fracaoCache: 0.2, pico: false,
    saidaTokens: { chat: 450, plano: 300, cenario: 350 }, raciocinioTokens: 900,
    maxTokensCortaTudo: true, fatorTentativas: 1.3,
    latenciaMs: { semPensamento: 6000, comPensamento: 18000 },
  },
  {
    // Nada de cache, horário de pico, toda chamada repetida e toda saída no
    // teto de 900 tokens. Não é previsão: é o limite do que o teto de gasto
    // precisa aguentar.
    nome: 'pior caso', tokensPorCaractere: 0.45, fracaoCache: 0, pico: true,
    saidaTokens: { chat: 900, plano: 900, cenario: 900 }, raciocinioTokens: 0,
    maxTokensCortaTudo: true, fatorTentativas: 2,
    latenciaMs: { semPensamento: 20000, comPensamento: 20000 },
  },
]

export interface Projecao {
  premissas: string
  chamadasHttp: number
  tokensEntrada: number
  tokensSaida: number
  usd: number
  duracaoSequencialMs: number
  porConfig: Record<string, { chamadasHttp: number; usd: number; duracaoSequencialMs: number }>
}

export function projeta(chamadas: ChamadaPrevista[], p: Premissas): Projecao {
  const out: Projecao = {
    premissas: p.nome, chamadasHttp: 0, tokensEntrada: 0, tokensSaida: 0, usd: 0, duracaoSequencialMs: 0, porConfig: {},
  }
  // Uma segunda-feira às 07h UTC (pico) ou um domingo à tarde (fora do pico).
  const quando = p.pico ? new Date(Date.UTC(2026, 8, 14, 7)) : new Date(Date.UTC(2026, 8, 13, 15))
  for (const c of chamadas) {
    const entrada = Math.ceil(c.caracteres * p.tokensPorCaractere) * p.fatorTentativas
    const saidaBruta = p.saidaTokens[c.tarefa] + (c.pensamentoLigado ? p.raciocinioTokens : 0)
    const saida = (p.maxTokensCortaTudo ? Math.min(c.maxTokens, saidaBruta) : saidaBruta) * p.fatorTentativas
    const hit = entrada * p.fracaoCache
    const usd = custoUSD(c.modelo, { entrada, cacheHit: hit, cacheMiss: entrada - hit, saida, raciocinio: 0 }, quando)
    const ms = (c.pensamentoLigado ? p.latenciaMs.comPensamento : p.latenciaMs.semPensamento) * p.fatorTentativas
    out.chamadasHttp += p.fatorTentativas
    out.tokensEntrada += entrada
    out.tokensSaida += saida
    out.usd += usd
    out.duracaoSequencialMs += ms
    const k = out.porConfig[c.config] || (out.porConfig[c.config] = { chamadasHttp: 0, usd: 0, duracaoSequencialMs: 0 })
    k.chamadasHttp += p.fatorTentativas
    k.usd += usd
    k.duracaoSequencialMs += ms
  }
  return out
}
