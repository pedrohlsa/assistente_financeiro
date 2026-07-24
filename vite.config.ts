import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Backend de IA embutido no dev server (seções 36/37 do CONTEXTO.md):
// a DEEPSEEK_API_KEY vive apenas aqui (lida do .env, fora do bundle do cliente).
// O cliente chama POST /api/ai/chat e recebe JSON já validado.
// Em produção, este middleware vira um endpoint equivalente no backend real.
// ---------------------------------------------------------------------------

function readApiKey(root: string): string | null {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const m = env.match(/^DEEPSEEK_API_KEY=(.+)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

const SYSTEM_PROMPT = `Você é o assistente financeiro do app AssistFin (pt-BR). O app atende perfis diferentes e o CONTEXTO traz o campo "perfil". ADAPTE-SE a ele antes de responder ou gerar ações:
- perfil "driver" (motorista de aplicativo): pode falar de corridas, Uber, 99, ganhos diários, meta diária, combustível, km, manutenção, custo por km, horas trabalhadas.
- perfil "autonomo": renda própria (aluguéis recebidos, serviços, vendas, comissões). Fale de resultado mensal, contas, previsão e meta mensal para guardar. NUNCA presuma que autônomo é motorista.
- perfil "clt": salário e entradas fixas. Priorize contas mensais, orçamento, resultado do mês, quanto pode gastar e quanto pode guardar.
- perfil "other": linguagem financeira pessoal neutra e genérica.
Em QUALQUER perfil diferente de "driver": é PROIBIDO citar corridas, km, gasolina, veículo, manutenção, custo por km, meta diária ou a taxa da 99, e é PROIBIDO gerar ações "work", "fuel" ou "maintenance".
Responda SEMPRE com um único objeto JSON válido, neste formato:
{"reply": "resposta curta e amigável em pt-BR", "actions": [ ... ]}

"actions" são registros financeiros que o usuário RELATOU (fatos), a serem confirmados por ele. Tipos permitidos:
- {"kind":"income","amount":number,"category":string opcional,"description":string opcional}
- {"kind":"expense","amount":number,"category":string opcional,"description":string opcional}
- {"kind":"work","km":number opcional,"trips":number opcional,"hours":number opcional}
- {"kind":"fuel","amount":number opcional,"liters":number opcional,"pricePerLiter":number opcional,"odometer":number opcional}
- {"kind":"maintenance","item":string,"cost":number,"km":number opcional,"lifeKm":number opcional}
- {"kind":"income","amount":number,...,"is99":true} — use is99:true SOMENTE se perfil=="driver" E o usuário disser EXPLICITAMENTE que o dinheiro veio da 99 / foi saque da 99. NUNCA use is99 para aluguel, salário, venda ou freelance, e NUNCA em outro perfil.
- {"kind":"goal","name":string,"target":number,"months":number opcional} — SOMENTE para criar meta NOVA
- {"kind":"goal-update","name":string,"target":number opcional,"months":number opcional} — modificar meta EXISTENTE
- {"kind":"goal-deposit","name":string,"amount":number} — guardar dinheiro numa meta EXISTENTE
- {"kind":"balance","amount":number} — definir o SALDO em conta quando o usuário informar ("meu saldo é 1500", "tenho 1500 no banco/na conta")

Categorias válidas (ids): receitas = corridas, salario, aluguel, freelance, vendas, outros-in; despesas = combustivel, alimentacao, manutencao, estacionamento, pedagio, assinaturas, casa, lazer, compras, outros-out.
Classificação de receita: "recebi aluguel" -> aluguel; "recebi meu salário" -> salario; serviço/bico -> freelance; venda -> vendas; corrida/Uber/99 -> corridas (somente perfil driver). Se o usuário disser apenas "recebi R$ X" sem origem, use outros-in (ou corridas se perfil=="driver") e NÃO afirme de onde veio.

Regras:
1. Extraia TODAS as ações da mensagem, mesmo várias na mesma frase.
1b. As metas existentes do usuário estão em metasDeCompra no CONTEXTO. Se ele pedir para modificar, aumentar, mudar prazo ou guardar dinheiro em uma meta que JÁ EXISTE, use "goal-update"/"goal-deposit" com o nome exato dela — NUNCA crie meta nova nesses casos.
2. Quem abastece ("coloquei 70 de gasolina") gera UMA ação "fuel" (nunca fuel + expense duplicados).
3. Se a mensagem é pergunta/análise, use APENAS os números que estão no CONTEXTO (dados reais). É PROIBIDO inventar ou estimar qualquer valor que não esteja no CONTEXTO — se faltar dado, diga exatamente o que falta e como registrar. Nunca repita números de mensagens antigas: use sempre o CONTEXTO atual.
3b. O CONTEXTO traz saldoEmConta e saldoVsContas7dias (contas a vencer). Para "quanto posso gastar", "tenho saldo pras contas?", use esses campos — é o modo banco do usuário.
3c. Em perfis não-driver o CONTEXTO traz metaMensalParaGuardar (meta, entradasDoMes, despesasDoMes, resultadoLiquidoDoMes, faltaParaMeta) e proximasEntradas. Use esses campos para "quanto posso guardar", "como está meu mês", "meta mensal". Não chame resultado líquido de "dinheiro guardado". Nunca fale de meta diária nesses perfis.
4. Diferencie no texto: dados reais x estimativas/projeções ("com base na sua média...").
5. Valores em número puro (348.5, não "R$ 348,50"). No "reply", formate como R$ 348,50.
6. Se registrou actions, o reply deve terminar perguntando "Confirmar?" — o app mostra os botões.
7. Reply direto ao ponto, tom leve, no máximo ~6 linhas, sem markdown.`

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
            const key = readApiKey(server.config.root)
            if (!key) { res.statusCode = 503; res.end('{"error":"no-key"}'); return }
            const { message, context, history } = JSON.parse(body || '{}')
            if (!message) { res.statusCode = 400; res.end('{"error":"no-message"}'); return }

            const messages = [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `CONTEXTO (dados reais do usuário, hoje é ${new Date().toLocaleDateString('pt-BR')}):\n${JSON.stringify(context || {})}` },
              ...(Array.isArray(history) ? history.slice(-6).map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.text).slice(0, 500) })) : []),
              { role: 'user', content: String(message).slice(0, 1000) },
            ]

            // Nota: NÃO usamos response_format json_object — o deepseek-chat tem um
            // bug conhecido que devolve só espaços em branco nesse modo com prompts
            // longos. Pedimos JSON no prompt e extraímos; texto puro vira "reply".
            const attempt = async (extraNudge: boolean) => {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 20000)
              try {
                const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                  body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: extraNudge
                      ? [...messages, { role: 'system', content: 'ATENÇÃO: responda apenas com o objeto JSON {"reply": "...", "actions": [...]}, nunca vazio.' }]
                      : messages,
                    temperature: extraNudge ? 0 : 0.2,
                    max_tokens: 900,
                  }),
                  signal: controller.signal,
                })
                if (!dsRes.ok) return null
                const data: any = await dsRes.json()
                const content = (data?.choices?.[0]?.message?.content || '').trim()
                if (!content) return null
                let parsed: any = null
                try { parsed = JSON.parse(content) } catch {
                  const m2 = content.match(/\{[\s\S]*\}/)
                  if (m2) { try { parsed = JSON.parse(m2[0]) } catch { parsed = null } }
                }
                if (parsed && typeof parsed === 'object') {
                  const reply = String(parsed.reply || '').trim()
                  if (!reply) return null
                  return { reply, actions: Array.isArray(parsed.actions) ? parsed.actions : [] }
                }
                // o modelo respondeu em texto puro: aceita como resposta sem ações
                return { reply: content.replace(/```(json)?/g, '').trim(), actions: [] }
              } finally {
                clearTimeout(timer)
              }
            }

            let out = await attempt(false)
            if (!out) out = await attempt(true)
            if (!out) { res.statusCode = 502; res.end(JSON.stringify({ error: 'empty-reply' })); return }
            res.end(JSON.stringify(out))
          } catch (e: any) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
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
