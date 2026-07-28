import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { getDeepSeekConfig, safeErrorMessage } from './api/_lib/deepseek'
import { handleAssistantRequest } from './api/_lib/assistantHandler'

// ---------------------------------------------------------------------------
// Backend de IA embutido no dev server: a DEEPSEEK_API_KEY vive só aqui (lida do
// .env, fora do bundle do cliente). O cliente chama POST /api/ai/chat.
//
// PARIDADE DEV × PRODUÇÃO: este middleware e a função serverless
// (api/ai/chat.ts) chamam a MESMA `handleAssistantRequest`. A SYSTEM_PROMPT não
// mora mais aqui — está em api/_lib/assistantPrompt.ts, gerada a partir do
// catálogo de ações. Não reintroduza prompt nem validação neste arquivo.
// ---------------------------------------------------------------------------

function aiProxy(): Plugin {
  return {
    name: 'assistfin-ai-proxy',
    configureServer(server) {
      server.middlewares.use('/api/ai/chat', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{"error":"method"}'); return }
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json')
          try {
            const config = getDeepSeekConfig(server.config.root)
            const out = await handleAssistantRequest(JSON.parse(body || '{}'), config)
            res.statusCode = out.status
            res.end(JSON.stringify(out.body))
          } catch {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'server-error', message: safeErrorMessage('server-error') }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), aiProxy()],
  server: { port: 5199 },
})
