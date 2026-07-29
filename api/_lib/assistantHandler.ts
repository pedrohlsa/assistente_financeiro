// Pipeline COMPLETO do endpoint de IA, compartilhado pelos dois backends.
//
// `vite.config.ts` (dev) e `api/ai/chat.ts` (Vercel) não contêm mais nenhuma
// lógica própria: os dois chamam `handleAssistantRequest`. Divergência entre
// dev e produção deixou de ser possível por construção — não há o que copiar.

import { callDeepSeekChat, isDeepSeekFailure, safeErrorMessage, httpStatusForError } from './deepseek.js'
import type { DeepSeekConfig, DeepSeekErrorCode } from './deepseek.js'
import { buildSystemPrompt, normalizeCapabilities, sanitizeRemoteResponse } from './assistantPrompt.js'
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
  const { message, context, history } = body || {}
  if (!message || typeof message !== 'string' || !message.trim()) return fail('no-message')

  const today = todayIso()
  const caps = normalizeCapabilities(context)
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
