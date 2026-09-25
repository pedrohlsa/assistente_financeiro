// Configuração e chamada centralizadas da API da DeepSeek — código EXCLUSIVAMENTE
// server-side. NUNCA importar este módulo em código que roda no navegador/APK (src/**).
//
// Compartilhado entre vite.config.ts (proxy de dev) e api/ai/chat.ts (Vercel Serverless
// Function). Os dois rodam em Node mas são processos/empacotamentos independentes sem
// bundler comum — por isso o compartilhamento é via import relativo de TypeScript puro,
// que ambos os runtimes (esbuild do Vite / esbuild do Vercel) resolvem nativamente.

import fs from 'node:fs'
import path from 'node:path'

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro'
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_DEFAULT_TIMEOUT_MS = 20000

export interface DeepSeekConfig {
  apiKey: string | null
  model: string
  baseUrl: string
  timeoutMs: number
}

function readDotEnvVar(name: string, root: string): string | null {
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const m = env.match(new RegExp(`^${name}=(.+)$`, 'm'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function readEnvVar(name: string, root?: string): string | null {
  if (process.env[name]) return process.env[name] as string
  return root ? readDotEnvVar(name, root) : null
}

/**
 * `root`: raiz do projeto — só necessário em dev (vite.config.ts), pra ler o .env
 * manualmente (o Vite não injeta variáveis sem prefixo VITE_ em process.env nesse
 * contexto). Em produção (Vercel), as variáveis já vêm prontas em process.env e
 * `root` é ignorado.
 */
export function getDeepSeekConfig(root?: string): DeepSeekConfig {
  return {
    apiKey: readEnvVar('DEEPSEEK_API_KEY', root),
    model: readEnvVar('DEEPSEEK_MODEL', root) || DEEPSEEK_DEFAULT_MODEL,
    baseUrl: readEnvVar('DEEPSEEK_BASE_URL', root) || DEEPSEEK_DEFAULT_BASE_URL,
    timeoutMs: Number(readEnvVar('DEEPSEEK_TIMEOUT_MS', root)) || DEEPSEEK_DEFAULT_TIMEOUT_MS,
  }
}

export type DeepSeekErrorCode =
  | 'no-key' | 'no-message' | 'timeout' | 'auth-invalid' | 'insufficient-balance'
  | 'model-invalid' | 'rate-limit' | 'bad-request' | 'server-error' | 'empty-reply' | 'network-error'

const SAFE_MESSAGES: Record<DeepSeekErrorCode, string> = {
  'no-key': 'Assistente por IA não está configurado no momento.',
  'no-message': 'Mensagem vazia.',
  'timeout': 'O assistente demorou demais para responder. Tente novamente.',
  'auth-invalid': 'O assistente por IA está com um problema de configuração. Tente novamente mais tarde.',
  'insufficient-balance': 'O assistente por IA está temporariamente indisponível. Tente novamente mais tarde.',
  'model-invalid': 'O assistente por IA está com um problema de configuração. Tente novamente mais tarde.',
  'rate-limit': 'Muitas perguntas em pouco tempo. Aguarde um instante e tente de novo.',
  'bad-request': 'Não consegui processar essa mensagem. Tente reformular.',
  'server-error': 'O assistente por IA está indisponível no momento. Tente novamente em instantes.',
  'empty-reply': 'Não consegui gerar uma resposta agora. Tente reformular a pergunta.',
  'network-error': 'Falha de conexão com o assistente por IA. Tente novamente.',
}

/** Mensagem segura pro cliente — nunca inclui stack trace, chave ou corpo bruto da API. */
export function safeErrorMessage(code: DeepSeekErrorCode): string {
  return SAFE_MESSAGES[code] || SAFE_MESSAGES['server-error']
}

/** Status HTTP que o NOSSO backend devolve ao cliente pra cada tipo de erro. */
export function httpStatusForError(code: DeepSeekErrorCode): number {
  switch (code) {
    case 'no-key': return 503
    case 'no-message': return 400
    case 'timeout': return 504
    case 'rate-limit': return 429
    case 'bad-request': return 400
    default: return 502 // auth-invalid, insufficient-balance, model-invalid, server-error, empty-reply, network-error
  }
}

function classifyHttpError(status: number, bodyText: string): DeepSeekErrorCode {
  if (status === 401) return 'auth-invalid'
  if (status === 402) return 'insufficient-balance'
  if (status === 429) return 'rate-limit'
  if (status === 400 || status === 422) return /model/i.test(bodyText) ? 'model-invalid' : 'bad-request'
  if (status >= 500) return 'server-error'
  return 'server-error'
}

export interface DeepSeekMessage { role: string; content: string }
export interface DeepSeekSuccess {
  ok: true
  reply: string
  actions: any[]
  /**
   * Objeto JSON completo devolvido pelo modelo, sem interpretação nenhuma.
   * É ele que passa pela validação de contrato. `null` quando o modelo devolveu
   * texto puro — nesse caso o chamador NÃO pode tratar a resposta como proposta
   * de ações, só como conversa.
   */
  envelope: any | null
}
export interface DeepSeekFailure { ok: false; code: DeepSeekErrorCode }

/**
 * Type guard explícita — usar em vez de `if (!out.ok)` nos chamadores. Sob
 * `strict: false` (config deste projeto), o TypeScript não estreita a união
 * discriminada `DeepSeekSuccess | DeepSeekFailure` de forma confiável a partir de
 * controle de fluxo simples; um predicado de tipo explícito narrowa sempre, com
 * ou sem `strict`. Sem isso, `tsc` local passa mas o type-check da Vercel falha
 * no deploy (reproduzido e confirmado).
 */
export function isDeepSeekFailure(out: DeepSeekSuccess | DeepSeekFailure): out is DeepSeekFailure {
  return out.ok === false
}

/**
 * O que conta como resposta aproveitável.
 *
 * `envelope` (padrão) é o contrato do CHAT: objeto com `reply`. `object` é
 * qualquer objeto JSON — o que o PLANEJADOR devolve, e um plano nunca tem
 * `reply`. Sem esta distinção o planejador remoto nunca funcionou: o plano
 * contava como resposta vazia, o reenvio pedia o envelope do chat, e cada
 * pergunta custava duas chamadas para terminar num objeto que
 * `validateQueryPlan` recusava (`bad-version`) ou num 502 `empty-reply`.
 */
export interface DeepSeekCallOptions {
  expect?: 'envelope' | 'object'
}

const NUDGE_ENVELOPE = 'ATENÇÃO: responda APENAS com o objeto JSON do contrato {"version":1,"mode":"...","reply":"...","actions":[...]}, sem texto fora dele e nunca vazio.'
const NUDGE_OBJETO = 'ATENÇÃO: responda APENAS com um único objeto JSON válido, no formato pedido acima, sem texto fora dele e nunca vazio.'

/**
 * Chama a API de chat da DeepSeek com timeout (AbortController) e uma segunda
 * tentativa ("nudge") só quando a resposta vem vazia/sem JSON válido — erros
 * definitivos (auth, modelo, rate limit, saldo, 5xx) não tentam de novo.
 * Nunca lança: sempre resolve com { ok:true, ... } ou { ok:false, code },
 * pronto pra virar uma resposta HTTP segura sem vazar detalhe interno nenhum.
 */
export async function callDeepSeekChat(
  config: DeepSeekConfig,
  messages: DeepSeekMessage[],
  opts: DeepSeekCallOptions = {},
): Promise<DeepSeekSuccess | DeepSeekFailure> {
  if (!config.apiKey) return { ok: false, code: 'no-key' }

  const attempt = async (extraNudge: boolean): Promise<DeepSeekSuccess | DeepSeekFailure | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const dsRes = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: extraNudge
            ? [...messages, { role: 'system', content: opts.expect === 'object' ? NUDGE_OBJETO : NUDGE_ENVELOPE }]
            : messages,
          temperature: extraNudge ? 0 : 0.2,
          max_tokens: 900,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      })
      if (!dsRes.ok) {
        const bodyText = await dsRes.text().catch(() => '')
        return { ok: false, code: classifyHttpError(dsRes.status, bodyText) }
      }
      const data: any = await dsRes.json()
      const content = (data?.choices?.[0]?.message?.content || '').trim()
      if (!content) return null
      let parsed: any = null
      try { parsed = JSON.parse(content) } catch {
        const m2 = content.match(/\{[\s\S]*\}/)
        if (m2) { try { parsed = JSON.parse(m2[0]) } catch { parsed = null } }
      }
      if (parsed && typeof parsed === 'object') {
        // Planejador: o objeto É a resposta.
        if (opts.expect === 'object') {
          return { ok: true, reply: typeof parsed.reply === 'string' ? parsed.reply : '', actions: [], envelope: parsed }
        }
        const reply = String(parsed.reply || '').trim()
        if (!reply) return null
        return { ok: true, reply, actions: Array.isArray(parsed.actions) ? parsed.actions : [], envelope: parsed }
      }
      // Planejador sem JSON nenhum: não há o que aproveitar, vale o reenvio.
      if (opts.expect === 'object') return null
      // Texto puro: `envelope: null` avisa o chamador de que NÃO houve contrato.
      // Nenhuma ação pode ser inferida daqui — é isso que impede a perda silenciosa.
      return { ok: true, reply: content.replace(/```(json)?/g, '').trim(), actions: [], envelope: null }
    } catch (e: any) {
      if (e?.name === 'AbortError') return { ok: false, code: 'timeout' }
      return { ok: false, code: 'network-error' }
    } finally {
      clearTimeout(timer)
    }
  }

  const first = await attempt(false)
  if (first) return first
  const second = await attempt(true)
  if (second) return second
  return { ok: false, code: 'empty-reply' }
}
