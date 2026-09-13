// Pipeline COMPLETO do endpoint de IA, compartilhado pelos dois backends.
//
// `vite.config.ts` (dev) e `api/ai/chat.ts` (Vercel) não contêm mais nenhuma
// lógica própria: os dois chamam `handleAssistantRequest`. Divergência entre
// dev e produção deixou de ser possível por construção — não há o que copiar.

import { callDeepSeekChat, isDeepSeekFailure, safeErrorMessage, httpStatusForError } from './deepseek.js'
import type { DeepSeekConfig, DeepSeekErrorCode } from './deepseek.js'
import {
  buildComposerPrompt, buildQueryPlannerPrompt, buildSystemPrompt,
  normalizeCapabilities, sanitizeRemoteResponse,
} from './assistantPrompt.js'
import { ASSISTANT_CONTRACT_VERSION } from '../../src/assistant/contracts.js'

export interface AssistantHttpResult {
  status: number
  body: Record<string, any>
}

const todayIso = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const fail = (code: DeepSeekErrorCode): AssistantHttpResult => ({
  status: httpStatusForError(code),
  body: { error: code, message: safeErrorMessage(code) },
})

/**
 * Recebe o corpo JÁ parseado da requisição e devolve status + corpo de resposta.
 *
 * Uma resposta remota que não obedece ao contrato NUNCA vira ação: se o modelo
 * devolveu texto sem JSON válido, tentamos uma vez de forma mais rígida e, se
 * ainda assim falhar, o texto só é aceito como conversa — e o cliente é avisado
 * disso por `contractFallback: true`, para nunca perder ação em silêncio.
 */
export async function handleAssistantRequest(
  body: any,
  config: DeepSeekConfig,
): Promise<AssistantHttpResult> {
  const { message, context, history, task } = body || {}
  if (!message || typeof message !== 'string' || !message.trim()) return fail('no-message')

  const today = todayIso()
  const caps = normalizeCapabilities(context)

  // Dois trabalhos alternativos, os dois SEM acesso a lancamento nenhum:
  // planejar uma consulta e redigir sobre fatos ja calculados. O padrao
  // continua sendo o assistente completo.
  if (task === 'plan-query') return planQuery(body, config, caps, today)
  if (task === 'compose') return compose(body, config, today)

  const systemPrompt = buildSystemPrompt(caps, today)

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `CONTEXTO (dados reais do usuário):\n${JSON.stringify(context || {})}` },
    ...(Array.isArray(history)
      ? history.slice(-8).map((h: any) => ({
          role: h?.role === 'user' ? 'user' : 'assistant',
          content: String(h?.text ?? '').slice(0, 600),
        }))
      : []),
    { role: 'user', content: String(message).slice(0, 1500) },
  ]

  const out = await callDeepSeekChat(config, messages)
  if (isDeepSeekFailure(out)) return fail(out.code)

  const sanitized = sanitizeRemoteResponse(out.envelope ?? { reply: out.reply, actions: out.actions }, caps, today)
  if (!sanitized) {
    // Envelope inválido: aceitamos o texto apenas como conversa, sinalizando.
    return {
      status: 200,
      body: {
        version: ASSISTANT_CONTRACT_VERSION,
        mode: 'answer',
        reply: out.reply,
        actions: [],
        rejected: [],
        contractFallback: true,
      },
    }
  }

  return {
    status: 200,
    body: {
      version: ASSISTANT_CONTRACT_VERSION,
      mode: sanitized.mode,
      reply: sanitized.reply,
      actions: sanitized.actions,
      clarification: sanitized.clarification,
      rejected: sanitized.rejected,
      contractFallback: false,
    },
  }
}

// ---------------------------------------------------------------------------
// Planejar consulta
// ---------------------------------------------------------------------------

/**
 * O modelo devolve um PLANO da Query DSL. Ele nao ve lancamento nenhum: recebe
 * o vocabulario da DSL, as categorias, os nomes de cartao e meta (que ja iam no
 * contexto) e a PERGUNTA. O plano ainda passa por `validateQueryPlan()` no
 * cliente, com as capacidades reais do aparelho, antes de ser executado ali
 * mesmo.
 */
async function planQuery(
  body: any, config: DeepSeekConfig, caps: ReturnType<typeof normalizeCapabilities>, today: string,
): Promise<AssistantHttpResult> {
  const out = await callDeepSeekChat(config, [
    { role: 'system', content: buildQueryPlannerPrompt(caps, today) },
    { role: 'user', content: String(body.message).slice(0, 500) },
  ], { expect: 'object' })
  if (isDeepSeekFailure(out)) return fail(out.code)
  const bruto = out.envelope ?? safeJson(out.reply)
  return {
    status: 200,
    body: {
      version: ASSISTANT_CONTRACT_VERSION,
      // O plano vai CRU: quem valida e o cliente, contra o estado dele. Validar
      // aqui daria uma falsa sensacao de garantia — o servidor nao conhece as
      // categorias personalizadas nem o perfil real do aparelho.
      queryPlan: bruto && typeof bruto === 'object' ? bruto : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Compor resposta sobre fatos
// ---------------------------------------------------------------------------

/**
 * O modelo redige SOBRE fatos que o app ja calculou. Nao recebe estado, nao
 * recebe historico: so a pergunta e a lista de fatos.
 *
 * A garantia nao esta aqui — esta em `checkGrounding()`, no cliente, que confere
 * numero a numero se a prosa se sustenta e DESCARTA a composicao inteira quando
 * nao se sustenta.
 */
async function compose(
  body: any, config: DeepSeekConfig, today: string,
): Promise<AssistantHttpResult> {
  const fatos = Array.isArray(body.facts) ? body.facts.slice(0, 40) : []
  if (!fatos.length) return fail('no-message')
  const out = await callDeepSeekChat(config, [
    { role: 'system', content: buildComposerPrompt(today) },
    { role: 'user', content: `PERGUNTA: ${String(body.message).slice(0, 400)}

FATOS:
${JSON.stringify(fatos)}` },
  ])
  if (isDeepSeekFailure(out)) return fail(out.code)
  const env: any = out.envelope
  const reply = typeof env?.reply === 'string' ? env.reply : out.reply
  return {
    status: 200,
    body: { version: ASSISTANT_CONTRACT_VERSION, reply: String(reply || '').slice(0, 1200) },
  }
}

const safeJson = (s: string): any => {
  try {
    const m = String(s || '').match(/\{[\s\S]*\}/)
    return m ? JSON.parse(m[0]) : null
  } catch { return null }
}
