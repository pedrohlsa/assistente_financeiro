// Backend de IA em produção (Vercel Serverless Function).
// Equivalente ao middleware de dev em vite.config.ts, mas lendo a chave de
// process.env (configurada no dashboard/CLI da Vercel — nunca commitada).
// Rota final: POST /api/ai/chat
// Configuração e chamada à DeepSeek centralizadas em api/_lib/deepseek.ts.

import { getDeepSeekConfig, callDeepSeekChat, safeErrorMessage, httpStatusForError, isDeepSeekFailure } from '../_lib/deepseek.js'

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

function setCors(res: any) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

export default async function handler(req: any, res: any) {
  setCors(res)
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return }

  const config = getDeepSeekConfig()
  const { message, context, history } = req.body || {}
  if (!message) { res.status(400).json({ error: 'no-message', message: safeErrorMessage('no-message') }); return }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `CONTEXTO (dados reais do usuário, hoje é ${new Date().toLocaleDateString('pt-BR')}):\n${JSON.stringify(context || {})}` },
    ...(Array.isArray(history) ? history.slice(-6).map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.text).slice(0, 500) })) : []),
    { role: 'user', content: String(message).slice(0, 1000) },
  ]

  try {
    // Timeout, retry e classificação de erro (auth/modelo/rate limit/saldo/5xx)
    // ficam centralizados em api/_lib/deepseek.ts, compartilhado com o dev proxy.
    const out = await callDeepSeekChat(config, messages)
    if (isDeepSeekFailure(out)) {
      res.status(httpStatusForError(out.code)).json({ error: out.code, message: safeErrorMessage(out.code) })
      return
    }
    res.status(200).json({ reply: out.reply, actions: out.actions })
  } catch {
    res.status(500).json({ error: 'server-error', message: safeErrorMessage('server-error') })
  }
}
