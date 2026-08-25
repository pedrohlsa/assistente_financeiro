// AVALIAÇÃO SEMÂNTICA COMPARATIVA de modelos remotos.
//
// A limitação mais importante do assistente NUNCA foi medida: um modelo pode
// responder algo educado e inútil e passar em todos os testes de contrato.
// Envelope válido, JSON bem formado, zero ação inválida — e uma resposta que
// não ajuda ninguém. Este script existe para medir isso.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ GASTO: rodar a bateria completa CUSTA DINHEIRO. Por isso o padrão é o   │
// │ modo ORÇAMENTO: o script conta as requisições, estima os tokens, calcula│
// │ o custo com a tabela de preços informada e PARA. Executar de verdade    │
// │ exige `--executar`, que é uma autorização explícita de quem digita.     │
// └─────────────────────────────────────────────────────────────────────────┘
//
//   npx tsx scripts/eval-assistant-models.mts                → orçamento
//   npx tsx scripts/eval-assistant-models.mts --models       → lista os modelos
//   npx tsx scripts/eval-assistant-models.mts --executar     → RODA (paga)
//   ... --modelo=deepseek-v4-flash,deepseek-reasoner         → compara modelos
//   ... --prompt=candidato                                   → compara prompts
//
// Nada aqui roda em `npm test`.

import { getDeepSeekConfig } from '../api/_lib/deepseek'
import { handleAssistantRequest } from '../api/_lib/assistantHandler'
import { EVAL_CASES, METRICAS } from '../tests/assistant/cases-eval'
import type { EvalCase } from '../tests/assistant/cases-eval'
import { buildAiContext } from '../src/services/ai'
import { autonomoRico, motoristaRico, usuarioNovo } from '../tests/fixtures/richState'
import { buildState } from '../tests/assistant/harness'
import { validateQueryPlan, isQueryFailure } from '../src/assistant/query/validate'
import { todayISO } from '../src/utils/format'
import type { AppState } from '../src/models/types'

const argv = process.argv.slice(2)
const flag = (nome: string) => argv.includes(`--${nome}`)
const valor = (nome: string) => argv.find(a => a.startsWith(`--${nome}=`))?.split('=')[1]

const EXECUTAR = flag('executar')
const HOJE = todayISO()

// ---------------------------------------------------------------------------
// Preço — fonte declarada, nunca chutada
// ---------------------------------------------------------------------------

/**
 * Preços por MILHÃO de tokens. Estes números vêm da tabela pública da DeepSeek
 * e são a parte mais perecível deste arquivo: confira antes de usar o número
 * numa decisão. `--preco-entrada` e `--preco-saida` sobrescrevem.
 *
 * A estimativa está aqui para dar ORDEM DE GRANDEZA e permitir a decisão de
 * gastar — não para fechar contabilidade.
 */
const PRECO_PADRAO = { entrada: 0.28, saida: 0.42, fonte: 'tabela pública da DeepSeek (verificar antes de decidir)' }

const preco = {
  entrada: Number(valor('preco-entrada')) || PRECO_PADRAO.entrada,
  saida: Number(valor('preco-saida')) || PRECO_PADRAO.saida,
}

/** Aproximação de tokens: ~4 caracteres por token em pt-BR. */
const tokensDe = (s: string) => Math.ceil(s.length / 4)

// ---------------------------------------------------------------------------
// Estados por perfil
// ---------------------------------------------------------------------------

const estadoDe = (c: EvalCase): AppState => {
  if (c.group === 'alucinacao' && /melhor m[êe]s|custa por km/.test(c.message)) return usuarioNovo()
  switch (c.profile) {
    case 'driver': return motoristaRico(HOJE)
    case 'autonomo': return autonomoRico(HOJE)
    case 'clt': return { ...autonomoRico(HOJE), settings: { ...autonomoRico(HOJE).settings, profile: 'clt' } }
    default: return buildState({ profile: 'other', cards: [{ name: 'Nubank' }, { name: 'Inter' }] })
  }
}

// ---------------------------------------------------------------------------
// Avaliação de UMA resposta
// ---------------------------------------------------------------------------

interface Veredito { ok: boolean; motivo?: string; alucinou?: boolean; inutil?: boolean }

const casa = (t: string, m: string | RegExp) =>
  typeof m === 'string' ? t.toLowerCase().includes(m.toLowerCase()) : m.test(t)

/** Resposta "educada e vazia": sem número, sem nome, sem próximo passo. */
const pareceInutil = (reply: string): boolean => {
  if (!reply.trim()) return true
  const temNumero = /\d/.test(reply)
  const temAcao = /(?:registre|cadastre|me diga|toque|confira|posso|vou)/i.test(reply)
  return !temNumero && !temAcao && reply.length < 160
}

function avalia(c: EvalCase, body: any, state: AppState): Veredito {
  const reply = String(body?.reply || '')
  const acoes: any[] = Array.isArray(body?.actions) ? body.actions : []
  const modo = String(body?.mode || 'answer')

  switch (c.expect.kind) {
    case 'actions': {
      if (!acoes.length) return { ok: false, motivo: 'nenhuma ação proposta' }
      for (const esperada of c.expect.actions) {
        const achou = acoes.find(a => a.kind === esperada.kind
          && (esperada.amount === undefined || Math.abs((a.amount ?? a.total ?? a.cost ?? -1) - esperada.amount) < 0.01)
          && (esperada.category === undefined || a.category === esperada.category))
        if (!achou) return { ok: false, motivo: `faltou ${esperada.kind}${esperada.amount ? ` de ${esperada.amount}` : ''}` }
      }
      return { ok: true }
    }
    case 'answer': {
      if (acoes.length) return { ok: false, motivo: `propôs ${acoes.length} ação(ões) numa frase que não registra` }
      for (const m of c.expect.mustMention || []) {
        if (!casa(reply, m)) return { ok: false, motivo: `resposta não menciona ${m}` }
      }
      for (const m of c.expect.mustNotMention || []) {
        if (casa(reply, m)) return { ok: false, motivo: `resposta menciona o proibido ${m}`, alucinou: true }
      }
      return { ok: true, inutil: pareceInutil(reply) }
    }
    case 'clarify': {
      if (modo !== 'clarify' && !/\?/.test(reply)) return { ok: false, motivo: 'não perguntou nada' }
      if (c.expect.about && !casa(reply, c.expect.about)) {
        return { ok: false, motivo: `perguntou outra coisa (esperava sobre "${c.expect.about}")` }
      }
      return { ok: true }
    }
    case 'refuse': {
      if (acoes.length) return { ok: false, motivo: `propôs ${acoes.length} ação(ões) quando deveria recusar` }
      return { ok: true }
    }
    case 'scenario': {
      if (acoes.length) return { ok: false, motivo: 'transformou hipótese em lançamento' }
      return { ok: true, inutil: pareceInutil(reply) }
    }
    case 'query-plan': {
      const plano = body?.queryPlan
      if (!plano) return { ok: false, motivo: 'não devolveu plano de consulta' }
      const v = validateQueryPlan(plano, state, HOJE)
      if (isQueryFailure(v)) return { ok: false, motivo: `plano inválido: ${v.code} ${v.detail || ''}` }
      const e = c.expect
      if (e.source && v.plan.source !== e.source) return { ok: false, motivo: `source ${v.plan.source} ≠ ${e.source}` }
      if (e.metric && v.plan.metric !== e.metric) return { ok: false, motivo: `metric ${v.plan.metric} ≠ ${e.metric}` }
      if (e.group && v.plan.group !== e.group) return { ok: false, motivo: `group ${v.plan.group} ≠ ${e.group}` }
      return { ok: true }
    }
  }
  return { ok: false, motivo: 'expectativa desconhecida' }
}

// ---------------------------------------------------------------------------
// Orçamento
// ---------------------------------------------------------------------------

function orcamento(modelos: string[]): void {
  let tokensEntrada = 0
  let tokensSaida = 0
  const SAIDA_ESTIMADA = 180 // tokens de resposta, medidos nas sondas atuais

  for (const c of EVAL_CASES) {
    const state = estadoDe(c)
    const contexto = c.expect.kind === 'query-plan'
      ? { perfil: state.settings.profile, categorias: state.categories.filter(x => !x.archived) }
      : buildAiContext(state)
    // Prompt de sistema + contexto + mensagem. O prompt é gerado do catálogo e
    // varia pouco; 1.800 tokens é a medida do prompt atual.
    tokensEntrada += 1800 + tokensDe(JSON.stringify(contexto)) + tokensDe(c.message)
    tokensSaida += SAIDA_ESTIMADA
  }

  const porModelo = {
    requisicoes: EVAL_CASES.length,
    tokensEntrada,
    tokensSaida,
    custoUSD: (tokensEntrada / 1e6) * preco.entrada + (tokensSaida / 1e6) * preco.saida,
  }

  console.log('\n╔════════════════════════════════════════════════════════════════════╗')
  console.log('║  ORÇAMENTO — nada foi executado                                    ║')
  console.log('╚════════════════════════════════════════════════════════════════════╝\n')
  console.log(`Casos no corpus:        ${EVAL_CASES.length}`)
  console.log(`Modelos a comparar:     ${modelos.length} (${modelos.join(', ')})`)
  console.log(`Requisições por modelo: ${porModelo.requisicoes}`)
  console.log(`Requisições TOTAIS:     ${porModelo.requisicoes * modelos.length}`)
  console.log(`\nTokens de entrada:      ~${porModelo.tokensEntrada.toLocaleString('pt-BR')} por modelo`)
  console.log(`Tokens de saída:        ~${porModelo.tokensSaida.toLocaleString('pt-BR')} por modelo (${SAIDA_ESTIMADA}/resposta)`)
  console.log(`\nPreço usado:            US$ ${preco.entrada}/M entrada · US$ ${preco.saida}/M saída`)
  console.log(`Fonte do preço:         ${PRECO_PADRAO.fonte}`)
  console.log(`\nCUSTO ESTIMADO:         US$ ${porModelo.custoUSD.toFixed(4)} por modelo`)
  console.log(`CUSTO TOTAL ESTIMADO:   US$ ${(porModelo.custoUSD * modelos.length).toFixed(4)}`)
  console.log('\nA estimativa é ORDEM DE GRANDEZA: ~4 caracteres por token, saída medida')
  console.log('nas sondas atuais. Confira o preço na fonte antes de decidir.')
  console.log('\nPara executar de verdade:  npx tsx scripts/eval-assistant-models.mts --executar')
  console.log('Isso GASTA. Só rode com autorização explícita de quem paga a conta.\n')

  console.log('Métricas que a execução produz:')
  for (const [k, v] of Object.entries(METRICAS)) console.log(`  · ${k.padEnd(16)} ${v}`)
  console.log('  · latência p50 e p95, tokens e custo real por modelo')
}

// ---------------------------------------------------------------------------
// Listar modelos
// ---------------------------------------------------------------------------

async function listarModelos(): Promise<void> {
  const cfg = getDeepSeekConfig(process.cwd())
  if (!cfg.apiKey) {
    console.log('Sem DEEPSEEK_API_KEY no ambiente nem no .env — não dá para listar modelos.')
    return
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    })
    if (!res.ok) { console.log(`/models respondeu HTTP ${res.status}`); return }
    const data: any = await res.json()
    const ids = (data?.data || []).map((m: any) => m?.id).filter(Boolean)
    console.log(`\nModelos disponíveis nesta conta (${ids.length}):`)
    for (const id of ids) console.log(`  · ${id}`)
    console.log(`\nModelo em uso hoje: ${cfg.model}`)
  } catch (e: any) {
    console.log(`Falha ao consultar /models: ${e?.message || e}`)
  }
}

// ---------------------------------------------------------------------------
// Execução (paga)
// ---------------------------------------------------------------------------

interface Resultado { caso: EvalCase; ok: boolean; motivo?: string; ms: number; alucinou: boolean; inutil: boolean; erro?: string }

async function executa(modelo: string): Promise<Resultado[]> {
  const base = getDeepSeekConfig(process.cwd())
  const cfg = { ...base, model: modelo }
  const out: Resultado[] = []

  for (const c of EVAL_CASES) {
    const state = estadoDe(c)
    const t0 = Date.now()
    try {
      const task = c.expect.kind === 'query-plan' ? 'plan-query' : undefined
      const contexto = task === 'plan-query'
        ? {
            perfil: state.settings.profile,
            categorias: state.categories.filter(x => !x.archived).map(x => ({ id: x.id, name: x.name, type: x.type })),
            cartoes: (state.cards || []).map(x => ({ nome: x.name })),
            metasDeCompra: (state.goals || []).map(g => ({ nome: g.name })),
          }
        : buildAiContext(state)
      const r = await handleAssistantRequest({ task, message: c.message, context: contexto, history: [] }, cfg)
      const ms = Date.now() - t0
      if (r.status !== 200) {
        out.push({ caso: c, ok: false, motivo: `HTTP ${r.status}`, ms, alucinou: false, inutil: false, erro: String(r.body?.error) })
        continue
      }
      const v = avalia(c, r.body, state)
      out.push({ caso: c, ok: v.ok, motivo: v.motivo, ms, alucinou: !!v.alucinou, inutil: !!v.inutil })
    } catch (e: any) {
      out.push({ caso: c, ok: false, motivo: 'exceção', ms: Date.now() - t0, alucinou: false, inutil: false, erro: e?.message })
    }
  }
  return out
}

function relatorio(modelo: string, res: Resultado[]): void {
  const porGrupo = new Map<string, { total: number; ok: number }>()
  for (const r of res) {
    const g = porGrupo.get(r.caso.group) || { total: 0, ok: 0 }
    g.total++
    if (r.ok) g.ok++
    porGrupo.set(r.caso.group, g)
  }
  const lat = res.map(r => r.ms).sort((a, b) => a - b)
  const p = (q: number) => lat[Math.min(Math.floor(lat.length * q), lat.length - 1)] ?? 0

  console.log(`\n${'═'.repeat(70)}\n  ${modelo}\n${'═'.repeat(70)}`)
  for (const [g, v] of [...porGrupo.entries()].sort()) {
    const pct = Math.round((v.ok / v.total) * 100)
    console.log(`  ${g.padEnd(16)} ${String(v.ok).padStart(2)}/${v.total}  ${String(pct).padStart(3)}%  ${METRICAS[g] || ''}`)
  }
  const ok = res.filter(r => r.ok).length
  console.log(`\n  TOTAL            ${ok}/${res.length}  ${Math.round((ok / res.length) * 100)}%`)
  console.log(`  alucinações      ${res.filter(r => r.alucinou).length}`)
  console.log(`  respostas vazias ${res.filter(r => r.inutil).length}`)
  console.log(`  falhas de rede   ${res.filter(r => r.erro).length}`)
  console.log(`  latência p50     ${p(0.5)}ms`)
  console.log(`  latência p95     ${p(0.95)}ms`)

  const ruins = res.filter(r => !r.ok)
  if (ruins.length) {
    console.log(`\n  --- ${ruins.length} falha(s) ---`)
    for (const r of ruins) {
      console.log(`  [${r.caso.id}] ${r.caso.group}: ${r.motivo}`)
      console.log(`      "${r.caso.message}"`)
      console.log(`      por que é difícil: ${r.caso.porque}`)
    }
  }
}

// ---------------------------------------------------------------------------

const modelos = (valor('modelo') || getDeepSeekConfig(process.cwd()).model).split(',').map(s => s.trim()).filter(Boolean)

if (flag('models')) {
  await listarModelos()
} else if (!EXECUTAR) {
  orcamento(modelos)
} else {
  console.log(`\nExecutando ${EVAL_CASES.length} casos × ${modelos.length} modelo(s). Isto GASTA.\n`)
  for (const m of modelos) relatorio(m, await executa(m))
  console.log('\nNão troque de modelo por sensação: só com ganho material nas frases difíceis,')
  console.log('e com o custo e a latência ao lado do ganho.\n')
}
