// TRANSPORTE DA AVALIAÇÃO — a única porta entre o pipeline de produção e a rede.
//
// A avaliação NÃO reimplementa nada do servidor. Ela chama o mesmo
// `handleAssistantRequest` que a Vercel executa — prompt gerado, sanitização,
// retry, validação — e intercepta só o `fetch` que sai para a DeepSeek. Ali, e
// só ali, ela:
//
//   · troca o modelo e o modo de pensamento pela configuração em teste;
//   · roda o guarda de privacidade sobre o corpo serializado;
//   · reserva o pior caso da chamada contra o teto de gasto ANTES de enviar;
//   · mede latência e o `usage` real devolvido pela API;
//   · no modo falso, devolve uma resposta sintética sem sair da máquina.
//
// O contexto de cada chamada (caso, repetição, configuração) viaja em
// `AsyncLocalStorage`: chamadas concorrentes de configurações diferentes não
// se misturam, e uma requisição feita FORA de um caso é recusada.

import { AsyncLocalStorage } from 'node:async_hooks'
import { custoUSD, piorCasoUSD, usoDaResposta, usoFalso } from './cost'
import type { Uso } from './cost'
import { falhou, verificaCorpo } from './privacy'

export interface ConfigModelo {
  id: string
  rotulo: string
  modelo: string
  /** `padrao` = não manda o parâmetro, exatamente como a produção faz hoje. */
  pensamento: 'padrao' | 'desligado' | 'ligado'
  esforco?: 'low' | 'high' | 'max'
  /** Esta configuração reproduz a produção de hoje, byte a byte. */
  producao?: boolean
}

export type Tarefa = 'chat' | 'plano' | 'cenario'

export interface RegistroHttp {
  config: string
  caso: string
  rep: number
  turno?: number
  tarefa: Tarefa
  tentativa: number
  inicio: string
  ms: number
  status: number
  erro?: string
  finishReason?: string
  uso: Uso
  custoUSD: number
  /** Requisição abortada sem `usage`: o custo registrado é a reserva de pior caso. */
  custoEstimado?: boolean
  caracteresEntrada: number
  maxTokens?: number
  conteudo: string
  raciocinioCaracteres: number
}

export interface ContextoAvaliacao {
  config: ConfigModelo
  caso: string
  rep: number
  turno?: number
  tarefa: Tarefa
  registros: RegistroHttp[]
  /**
   * O estado do caso passou pelo canário e pelo vocabulário sintético. Sem esta
   * marca a requisição não sai. Ela substitui o canário NO CORPO: o nome do
   * usuário deixou de ir ao modelo (regra 44), então o corpo não tem mais como
   * provar a origem sozinho.
   */
  origemVerificada?: boolean
}

export const contextoAvaliacao = new AsyncLocalStorage<ContextoAvaliacao>()

export class OrcamentoEsgotado extends Error {
  constructor(m: string) { super(m); this.name = 'OrcamentoEsgotado' }
}
export class BloqueioPrivacidade extends Error {
  constructor(m: string) { super(m); this.name = 'BloqueioPrivacidade' }
}

export interface Livro {
  tetoUSD: number
  gastoUSD: number
  reservadoUSD: number
  chamadasReais: number
  /**
   * Primeiro motivo de parada (teto de gasto ou privacidade). `callDeepSeekChat`
   * transforma qualquer exceção de rede em `network-error`: a exceção nunca
   * chega ao executor, que por isso olha AQUI depois de cada caso.
   */
  bloqueio?: string
}

export interface OpcoesTransporte {
  modo: 'real' | 'falso'
  hostPermitido: string
  chave?: string | null
  livro: Livro
  /** Conteúdo que o "modelo" devolve no modo falso. */
  respostaFalsa?: (ctx: ContextoAvaliacao, corpo: any) => string
  aoRegistrar?: (r: RegistroHttp) => void
}

let fetchOriginal: typeof fetch | null = null

const caracteresDas = (corpo: any): number =>
  (Array.isArray(corpo?.messages) ? corpo.messages : []).reduce((a: number, m: any) => a + String(m?.content ?? '').length, 0)

export function instalaTransporte(o: OpcoesTransporte): () => void {
  if (fetchOriginal) throw new Error('transporte de avaliação já está instalado')
  fetchOriginal = globalThis.fetch
  const real = fetchOriginal

  const barra = <E extends Error>(e: E): E => {
    if (!o.livro.bloqueio) o.livro.bloqueio = e.message
    return e
  }

  globalThis.fetch = (async (entrada: any, init?: any) => {
    const ctx = contextoAvaliacao.getStore()
    if (!ctx) throw barra(new BloqueioPrivacidade('requisição de rede fora de um caso de avaliação'))

    const url = new URL(typeof entrada === 'string' ? entrada : String(entrada?.url ?? entrada))
    if (url.hostname !== o.hostPermitido) throw barra(new BloqueioPrivacidade(`host fora da lista permitida: ${url.hostname}`))
    if (!ctx.origemVerificada) {
      throw barra(new BloqueioPrivacidade('caso sem origem verificada: o estado não passou pelo canário e pelo vocabulário sintético'))
    }

    const corpo = JSON.parse(String(init?.body ?? '{}'))
    corpo.model = ctx.config.modelo
    if (ctx.config.pensamento === 'desligado') corpo.thinking = { type: 'disabled' }
    else if (ctx.config.pensamento === 'ligado') {
      corpo.thinking = { type: 'enabled', ...(ctx.config.esforco ? { reasoning_effort: ctx.config.esforco } : {}) }
    } else delete corpo.thinking
    const serial = JSON.stringify(corpo)

    const priv = verificaCorpo(serial, { chave: o.chave })
    if (falhou(priv)) throw barra(new BloqueioPrivacidade(priv.motivo))

    const quando = new Date()
    const caracteres = caracteresDas(corpo)
    const reserva = o.modo === 'real' ? piorCasoUSD(ctx.config.modelo, caracteres, corpo.max_tokens, quando) : 0
    if (o.modo === 'real' && o.livro.gastoUSD + o.livro.reservadoUSD + reserva > o.livro.tetoUSD) {
      throw barra(new OrcamentoEsgotado(
        `teto de US$ ${o.livro.tetoUSD.toFixed(2)} alcançado — gasto ${o.livro.gastoUSD.toFixed(4)}, `
        + `reservado ${o.livro.reservadoUSD.toFixed(4)}, próxima chamada até ${reserva.toFixed(4)}`,
      ))
    }
    o.livro.reservadoUSD += reserva

    const tentativa = ctx.registros.filter(r => r.tarefa === ctx.tarefa && r.turno === ctx.turno).length + 1
    const t0 = Date.now()
    let status = 0
    let texto = ''
    let erro: string | undefined
    try {
      if (o.modo === 'real') {
        const res = await real(entrada, { ...init, body: serial })
        status = res.status
        texto = await res.text()
      } else {
        const conteudo = o.respostaFalsa ? o.respostaFalsa(ctx, corpo) : '{}'
        status = 200
        texto = JSON.stringify({
          choices: [{ message: { content: conteudo }, finish_reason: 'stop' }],
          usage: usoFalso(caracteres, conteudo.length),
        })
      }
    } catch (e: any) {
      erro = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e).slice(0, 200)
      throw e
    } finally {
      o.livro.reservadoUSD -= reserva
      let json: any = null
      try { json = texto ? JSON.parse(texto) : null } catch { json = null }
      const uso = usoDaResposta(json)
      const medido = !!json?.usage
      // Sem `usage` (abortada, erro de rede): conta a reserva inteira. A API
      // pode ter cobrado a geração mesmo com o cliente desistindo.
      const custo = o.modo !== 'real' ? 0 : medido ? custoUSD(ctx.config.modelo, uso, quando) : reserva
      if (o.modo === 'real') {
        o.livro.gastoUSD += custo
        o.livro.chamadasReais++
      }
      const msg = json?.choices?.[0]?.message
      const registro: RegistroHttp = {
        config: ctx.config.id, caso: ctx.caso, rep: ctx.rep, turno: ctx.turno, tarefa: ctx.tarefa,
        tentativa, inicio: quando.toISOString(), ms: Date.now() - t0, status, erro,
        finishReason: json?.choices?.[0]?.finish_reason, uso, custoUSD: custo,
        custoEstimado: o.modo === 'real' && !medido, caracteresEntrada: caracteres,
        maxTokens: corpo.max_tokens, conteudo: String(msg?.content ?? '').slice(0, 8000),
        raciocinioCaracteres: String(msg?.reasoning_content ?? '').length,
      }
      ctx.registros.push(registro)
      o.aoRegistrar?.(registro)
    }
    return new Response(texto, { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return () => {
    if (fetchOriginal) globalThis.fetch = fetchOriginal
    fetchOriginal = null
  }
}

/** Livro sem teto — só para o modo falso e para o autoteste. */
export const livroSemGasto = (): Livro => ({ tetoUSD: 0, gastoUSD: 0, reservadoUSD: 0, chamadasReais: 0 })
