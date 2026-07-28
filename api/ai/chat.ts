// Backend de IA em produção (Vercel Serverless Function).
// Rota final: POST /api/ai/chat
//
// Este arquivo é DE PROPÓSITO uma casca fina: prompt, contrato, validação e
// pipeline vivem em api/_lib/assistantHandler.ts, compartilhado byte a byte com
// o middleware de dev em vite.config.ts. Não acrescente regra de negócio aqui —
// foi exatamente assim que dev e produção divergiram antes.
//
// Imports com extensão `.js`: a função roda sob o loader ESM nativo do Node.

import { getDeepSeekConfig, safeErrorMessage } from '../_lib/deepseek.js'
import { handleAssistantRequest } from '../_lib/assistantHandler.js'

function setCors(res: any) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

export default async function handler(req: any, res: any) {
  setCors(res)
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return }

  try {
    const out = await handleAssistantRequest(req.body || {}, getDeepSeekConfig())
    res.status(out.status).json(out.body)
  } catch {
    res.status(500).json({ error: 'server-error', message: safeErrorMessage('server-error') })
  }
}
