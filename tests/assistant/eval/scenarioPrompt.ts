// PLANEJADOR DE CENÁRIO — CONTRATO CANDIDATO. NÃO EXISTE EM PRODUÇÃO.
//
// Hoje nenhum caminho do app pede plano de cenário ao modelo remoto, e a DSL de
// cenário é de PASSO ÚNICO: "comprar um pc em 10x E continuar guardando 500"
// não é expressável. Quando o motor local não entende uma hipótese, a frase cai
// no CHAT remoto, que responde em prosa, sem grounding.
//
// Este prompt existe só para MEDIR se vale construir o planejador: se algum
// modelo decompõe hipóteses compostas em passos válidos com consistência, a
// próxima rodada tem base para decidir. O formato `steps` é proposta — nada em
// `src/` o conhece, e nenhum resultado desta suíte muda o app.

import type { AssistantCapabilities } from '../../../src/assistant/contracts'
import { SCENARIO_DSL_VERSION } from '../../../src/assistant/scenario/types'

export const MAX_PASSOS = 3

export function buildScenarioPlannerPrompt(caps: AssistantCapabilities, hoje: string): string {
  const cartoes = caps.cardNames.length ? caps.cardNames.join(', ') : 'nenhum'
  const metas = caps.goalNames.length ? caps.goalNames.join(', ') : 'nenhuma'
  const saidas = caps.categories.filter(c => c.type === 'expense').map(c => c.id).join(', ') || 'nenhuma'
  const tipos = [
    '"spend" — gasto avulso. Campos: amount (obrigatório), category',
    '"purchase" — compra parcelada. Campos: amount = preço TOTAL (obrigatório), installments (obrigatório), downPayment = parte paga à vista e já incluída no total, cardName, category, description',
    '"save" — guardar todo mês. Campos: amount (obrigatório), goalName',
    '"pay-invoice" — pagar a fatura inteira. Campos: cardName',
    '"income-missing" — uma entrada que deixa de vir. Campos: origin (só se dita), amount (só se dito)',
    ...(caps.isDriver ? ['"extra-work" — trabalhar mais. Campos: hoursPerDay, days, extraKm'] : []),
  ]
  return `Você traduz HIPÓTESES financeiras em pt-BR ("e se eu...", "se eu comprar...") para um PLANO DE SIMULAÇÃO em JSON. Hoje é ${hoje}.

Você NÃO calcula nada e NÃO tem acesso aos dados: quem simula é o aplicativo, no aparelho do usuário.

Responda SEMPRE com um único objeto JSON válido, nada fora dele:
{"version":${SCENARIO_DSL_VERSION},"steps":[{"kind":"...", ...campos}],"falta":"texto curto ou null"}

TIPOS DE PASSO — use SOMENTE estes:
${tipos.map(t => `- ${t}`).join('\n')}

CARTÕES: ${cartoes}
METAS: ${metas}
CATEGORIAS DE SAÍDA: ${saidas}

REGRAS:
1. Um passo por hipótese dita, na ordem em que o usuário falou. No máximo ${MAX_PASSOS} passos.
2. Valores SÓ da frase ("4k" = 4000, "mil" = 1000). NUNCA invente valor, parcela, entrada ou origem.
3. Falta um dado obrigatório de um passo? Deixe esse passo de fora e diga em "falta" o que faltou.
4. Hipótese que estes tipos não representam: deixe de fora e explique em "falta".
5. Se a frase NÃO for hipótese (relata um fato, pergunta sobre o passado, conversa), responda {"version":${SCENARIO_DSL_VERSION},"steps":[],"falta":"não é hipótese"}.
6. cardName e goalName só das listas acima. Nunca escreva texto fora do JSON.`
}
