// AVALIAÇÃO SEMÂNTICA COMPARATIVA DOS MODELOS REMOTOS.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ GASTO. O padrão é o ORÇAMENTO, que não faz chamada paga nenhuma. Executar │
// │ exige `--executar` E `--teto-usd`; passa antes pelo autoteste e pelo      │
// │ saldo da conta; reserva o pior caso de cada chamada contra o teto ANTES   │
// │ de ela sair; e para sozinho no teto, em 401/402 ou em bloqueio.           │
// └──────────────────────────────────────────────────────────────────────────┘
//
//   npx tsx scripts/eval-assistant-models.mts                  orçamento (grátis)
//   npx tsx scripts/eval-assistant-models.mts --modelos        /models e saldo (grátis)
//   npx tsx scripts/eval-assistant-models.mts --autoteste      autoteste (grátis)
//   npx tsx scripts/eval-assistant-models.mts --executar --teto-usd=1.20
//       [--configs=A,B,C] [--repeticoes=3] [--suites=chat,plano,cenario,continuidade]
//       [--concorrencia=3] [--reserva-usd=0.50] [--retomar=eval-results/<pasta>]
//       [--corpus=pago|fronteira|completo]
//
// Elegibilidade: só entra na NOTA de um modelo o caso em que o caminho remoto
// foi de fato alcançado — medido no orquestrador real, sem rede, antes de
// qualquer gasto. Falha local continua no relatório, em bloco separado, e
// nunca vira nota de modelo.
//
// Privacidade: só estados de tests/assistant/eval/states.ts. O transporte
// recusa host fora da lista, contexto de chat sem o canário sintético, nome
// fora do vocabulário sintético, padrão de dado pessoal e a própria chave no
// corpo. A chave nunca é impressa, e os arquivos de resultado são varridos
// atrás de segredo antes de o script terminar.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { callDeepSeekChat, getDeepSeekConfig, isDeepSeekFailure } from '../api/_lib/deepseek'
import type { DeepSeekConfig } from '../api/_lib/deepseek'
import { handleAssistantRequest } from '../api/_lib/assistantHandler'
import { buildCapabilities } from '../src/assistant/capabilities'
import { isValidationFailure, validateAction } from '../src/assistant/contracts'
import { orchestrate, remoteNeedsAggregates } from '../src/assistant/orchestrator'
import type { ConversationFocus } from '../src/assistant/conversation'
import type { RemoteConversationContext } from '../src/assistant/conversation/remoteContext'
import { buildAiContext, planningContext } from '../src/services/ai'
import { todayISO } from '../src/utils/format'
import type { AppState, ParsedAction } from '../src/models/types'
import { SESSOES } from '../tests/assistant/redteamCorpus'
import { planoDoOuro } from '../tests/assistant/eval/canonical'
import { CASOS_CONTINUIDADE } from '../tests/assistant/eval/corpus-continuity'
import { CASOS_PLANO } from '../tests/assistant/eval/corpus-plan'
import { CASOS_CENARIO } from '../tests/assistant/eval/corpus-scenario'
import { FONTE_PRECOS, PRECOS_CONSULTADOS_EM, PREMISSAS, projeta } from '../tests/assistant/eval/cost'
import type { ChamadaPrevista } from '../tests/assistant/eval/cost'
import { calculaMetricas, divergenciaDeDenominador, empateEmSeguranca, metricasDoModelo, PESOS, pontuaEOrdena, resumoTransporte, soElegiveis, TIPOS_PERIGO } from '../tests/assistant/eval/metrics'
import type { MetricasConfig, ResumoTransporte, Trafego } from '../tests/assistant/eval/metrics'
import { elegivel, noCorpusPago, observaCorpus, resumoRoteamento } from '../tests/assistant/eval/routing'
import type { CasoDeFrase, ModoCorpus, Observacao, ResumoRoteamento } from '../tests/assistant/eval/routing'
import { falhou, verificaEstado, verificaVocabulario } from '../tests/assistant/eval/privacy'
import { buildScenarioPlannerPrompt } from '../tests/assistant/eval/scenarioPrompt'
import { pontuaCenario, pontuaChat, pontuaPlano, pontuaTurno } from '../tests/assistant/eval/score'
import { CASOS_CHAT, corpoOraculo, materializa, runEvalSelfTest } from '../tests/assistant/eval/selftest'
import { ESTADOS, vocabularioSintetico } from '../tests/assistant/eval/states'
import { contextoAvaliacao, instalaTransporte } from '../tests/assistant/eval/transport'
import type { ConfigModelo, ContextoAvaliacao, Livro, RegistroHttp } from '../tests/assistant/eval/transport'
import type { CasoCenario, CasoChat, CasoContinuidade, CasoPlano, PerfilEval, ResultadoCaso, Suite } from '../tests/assistant/eval/types'

// ---------------------------------------------------------------------------
// Configurações comparadas
// ---------------------------------------------------------------------------

export const CONFIGS: ConfigModelo[] = [
  { id: 'A', rotulo: 'deepseek-flash, pensamento desligado', modelo: 'deepseek-flash', pensamento: 'desligado' },
  { id: 'B', rotulo: 'deepseek-v4-pro, pensamento desligado', modelo: 'deepseek-v4-pro', pensamento: 'desligado' },
  // A produção de HOJE: nome legado, sem parâmetro de pensamento (o padrão da
  // API é LIGADO), temperature 0.2 e max_tokens 900 do código.
  { id: 'C', rotulo: 'produção de hoje: deepseek-v4-flash, pensamento no padrão', modelo: 'deepseek-v4-flash', pensamento: 'padrao', producao: true },
  { id: 'D', rotulo: 'deepseek-v4-pro, pensamento ligado (esforço low)', modelo: 'deepseek-v4-pro', pensamento: 'ligado', esforco: 'low' },
]

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(`--${n}`)
const valor = (n: string) => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3)

const hoje = todayISO()
const configs = CONFIGS.filter(c => (valor('configs') || 'A,B,C').toUpperCase().split(',').includes(c.id))
const suites = (valor('suites') || 'chat,plano,cenario,continuidade').split(',').map(s => s.trim()) as Suite[]
const repeticoes = Math.max(1, Math.round(Number(valor('repeticoes') || 3)))
const concorrencia = Math.max(1, Math.round(Number(valor('concorrencia') || 3)))
const corpus: ModoCorpus = valor('corpus') === 'completo' ? 'completo'
  : valor('corpus') === 'fronteira' ? 'fronteira' : 'pago'

/**
 * ELEGIBILIDADE. A bateria paga responde uma pergunta estreita: quando o modelo
 * remoto REALMENTE teve oportunidade de influenciar o resultado, qual
 * configuração foi melhor? Quem responde isso é a execução, não rótulo: o
 * orquestrador de produção roda com os dois caminhos remotos substituídos por
 * gravadores, e só a frase que faz sair requisição entra.
 *
 * O rótulo `rota` do corpus continua no relatório como DIAGNÓSTICO — ele
 * envelhece (p-14 e p-19 já eram `local-errada` e hoje chegam ao remoto) e por
 * isso não decide nada. `--corpus=fronteira` acrescenta de propósito o que o
 * aparelho resolve errado, para a decisão de ROTEAMENTO; esses casos são pagos
 * e nunca entram na nota do modelo.
 */
const FRASES: CasoDeFrase[] = [...CASOS_CHAT, ...CASOS_PLANO, ...CASOS_CENARIO]
const estados = new Map<PerfilEval, AppState>()
const estadoDe = (perfil: PerfilEval): AppState => {
  if (!estados.has(perfil)) estados.set(perfil, ESTADOS[perfil](hoje))
  return estados.get(perfil)!
}
let OBS = new Map<string, Observacao>()
const observaRoteamento = async () => { OBS = await observaCorpus(FRASES, estadoDe, hoje) }
const entraNoCorpus = (c: { id: string }): boolean => noCorpusPago(OBS.get(c.id), corpus)
/** O modelo pôde influenciar ESTE caso em produção? É o que a nota dele usa. */
const elegivelRemoto = (id: string): boolean => elegivel(OBS.get(id))
const vocabulario = vocabularioSintetico(hoje)
const usd = (v: number) => `US$ ${v.toFixed(v < 0.1 ? 4 : 2)}`
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

type Tarefa =
  | { tipo: 'chat'; caso: CasoChat; config: ConfigModelo; rep: number }
  | { tipo: 'plano'; caso: CasoPlano; config: ConfigModelo; rep: number }
  | { tipo: 'cenario'; caso: CasoCenario; config: ConfigModelo; rep: number }
  | { tipo: 'continuidade'; caso: CasoContinuidade; config: ConfigModelo; rep: number }

const chaveTarefa = (t: Tarefa) => `${t.config.id}|${t.caso.id}|${t.rep}`

/** Repetição inteira antes da próxima, e as configurações intercaladas por caso: parar no teto deixa uma comparação equilibrada. */
function montaTarefas(cs: ConfigModelo[], reps: number): Tarefa[] {
  const out: Tarefa[] = []
  for (let rep = 1; rep <= reps; rep++) {
    if (suites.includes('chat')) for (const caso of CASOS_CHAT.filter(entraNoCorpus)) for (const config of cs) out.push({ tipo: 'chat', caso, config, rep })
    if (suites.includes('plano')) for (const caso of CASOS_PLANO.filter(entraNoCorpus)) for (const config of cs) out.push({ tipo: 'plano', caso, config, rep })
    if (suites.includes('cenario')) for (const caso of CASOS_CENARIO.filter(entraNoCorpus)) for (const config of cs) out.push({ tipo: 'cenario', caso, config, rep })
    if (suites.includes('continuidade')) for (const caso of CASOS_CONTINUIDADE) for (const config of cs) out.push({ tipo: 'continuidade', caso, config, rep })
  }
  return out
}

/** Espelho de `askAssistantRemote`: mesmo corpo, mesma revalidação no cliente. */
async function chatComoCliente(
  state: AppState, message: string,
  opts: { conversation?: RemoteConversationContext; aggregates: boolean },
  cfg: DeepSeekConfig, enviado?: { contexto?: any },
) {
  const contexto = buildAiContext(state, { aggregates: opts.aggregates })
  if (enviado) enviado.contexto = contexto
  const http = await handleAssistantRequest({ message, context: contexto, conversation: opts.conversation }, cfg)
  if (http.status !== 200) return null
  const data = http.body
  const reply = String(data?.reply || '').trim()
  if (!reply) return null
  const caps = buildCapabilities(state)
  const actions: ParsedAction[] = []
  const rejected = Array.isArray(data?.rejected) ? data.rejected.slice(0, 12) : []
  for (const raw of Array.isArray(data?.actions) ? data.actions.slice(0, 12) : []) {
    const v = validateAction(raw, caps, hoje, { allowRemoteOnly: true })
    if (isValidationFailure(v)) rejected.push({ kind: String(raw?.kind || '?'), code: v.code, detail: v.detail })
    else actions.push(v.action)
  }
  return {
    reply, mode: typeof data?.mode === 'string' ? data.mode : 'answer', actions,
    clarification: data?.clarification, rejected, contractFallback: data?.contractFallback === true,
  }
}

async function executa(t: Tarefa, cfg: DeepSeekConfig, livro: Livro): Promise<ResultadoCaso[]> {
  const state = estadoDe(t.caso.perfil)
  const origem = verificaEstado(state)
  const nomes = verificaVocabulario(planningContext(state), vocabulario)
  for (const v of [origem, nomes]) if (falhou(v)) { livro.bloqueio = livro.bloqueio || v.motivo; return [] }
  // Só chega aqui o estado que passou pelo canário e pelo vocabulário sintético:
  // é essa verificação que o transporte exige antes de deixar a requisição sair.
  const ctx = (tarefa: ContextoAvaliacao['tarefa'], registros: RegistroHttp[] = [], turno?: number): ContextoAvaliacao =>
    ({ config: t.config, caso: t.caso.id, rep: t.rep, turno, tarefa, registros, origemVerificada: true })

  if (t.tipo === 'chat') {
    const c = ctx('chat')
    // A mesma decisão de produção: agregados só quando a frase é pergunta ou pedido.
    const contexto = buildAiContext(state, { aggregates: remoteNeedsAggregates(t.caso.mensagem) })
    const http = await contextoAvaliacao.run(c, () => handleAssistantRequest({ message: t.caso.mensagem, context: contexto }, cfg))
    return [pontuaChat({ caso: t.caso, config: t.config.id, rep: t.rep, state, hoje, contexto, http, registros: c.registros, elegivelRemoto: elegivelRemoto(t.caso.id) })]
  }
  if (t.tipo === 'plano') {
    const c = ctx('plano')
    const http = await contextoAvaliacao.run(c, () => handleAssistantRequest({ task: 'plan-query', message: t.caso.mensagem, context: planningContext(state) }, cfg))
    return [pontuaPlano({ caso: t.caso, config: t.config.id, rep: t.rep, state, hoje, http, registros: c.registros, elegivelRemoto: elegivelRemoto(t.caso.id) })]
  }
  if (t.tipo === 'cenario') {
    const c = ctx('cenario')
    const saida = await contextoAvaliacao.run(c, () => callDeepSeekChat(cfg, [
      { role: 'system', content: buildScenarioPlannerPrompt(buildCapabilities(state), hoje) },
      { role: 'user', content: t.caso.mensagem.slice(0, 500) },
    ], { expect: 'object' }))
    const s = isDeepSeekFailure(saida) ? { ok: false, code: saida.code } : { ok: true, envelope: saida.envelope }
    return [pontuaCenario({ caso: t.caso, config: t.config.id, rep: t.rep, saida: s, registros: c.registros, elegivelRemoto: elegivelRemoto(t.caso.id) })]
  }

  const out: ResultadoCaso[] = []
  let focus: ConversationFocus | undefined
  let pending: any
  let draft: any = null
  let clarification: any
  for (let i = 0; i < t.caso.turnos.length; i++) {
    const turno = t.caso.turnos[i]
    const registros: RegistroHttp[] = []
    const enviado: { contexto?: any } = {}
    // O orquestrador CAI para o caminho local quando o remoto não devolve nada
    // usável. O usuário pode até ver uma resposta certa; para a nota do MODELO
    // isso é falha, e é aqui que ela é registrada — depois o fallback apaga o
    // rastro.
    let falhaRemota: string | undefined
    let contratoInvalido = false
    // O que o MODELO escreveu, separado do que o aparelho compôs em volta.
    const escritoPeloModelo: string[] = []
    const r = await orchestrate({
      state, message: turno.mensagem, draft: draft || undefined, pending,
      pendingClarification: clarification, focus, remoteEnabled: true, today: hoje,
      askRemote: ({ state: s, message, conversation, aggregates }) => contextoAvaliacao.run(ctx('chat', registros, i + 1), async () => {
        const out = await chatComoCliente(s, message, { conversation, aggregates }, cfg, enviado)
        if (!out) falhaRemota = falhaRemota || 'chat remoto sem resposta utilizável'
        else {
          escritoPeloModelo.push(String(out.reply || ''))
          if (out.contractFallback || out.rejected.length) contratoInvalido = true
        }
        return out
      }),
      planRemoteQuery: ({ state: s, message }) => contextoAvaliacao.run(ctx('plano', registros, i + 1), async () => {
        const http = await handleAssistantRequest({ task: 'plan-query', message, context: planningContext(s) }, cfg)
        const plano = http.status === 200 ? http.body?.queryPlan : null
        const valido = plano && typeof plano === 'object' ? plano : null
        if (!valido) falhaRemota = falhaRemota || 'planejador remoto sem plano utilizável'
        return valido
      }),
    })
    if (r.focus) focus = r.focus
    draft = r.draft
    pending = r.correctedPending ? r.correctedPending : r.response.actions.length ? r.response.actions : r.keepPending ? pending : undefined
    clarification = r.response.mode === 'clarify' ? (r.response as any).clarification : undefined
    if (registros.length) {
      // Número permitido é o que o modelo PODE conhecer: o contexto que foi de
      // fato, e a frase deste turno. As mensagens anteriores não vão mais ao
      // modelo — citar um valor delas seria coincidência, não lastro.
      out.push(pontuaTurno({
        id: t.caso.id, config: t.config.id, rep: t.rep, turno: i + 1, perfil: t.caso.perfil, gabarito: turno, state, hoje,
        resposta: { reply: r.response.reply, mode: r.response.mode, actions: r.response.actions },
        contexto: enviado.contexto ?? planningContext(state), mensagensAnteriores: [], registros,
        falhaRemota, contratoInvalido, textoRemoto: escritoPeloModelo.join('\n'),
      }))
    }
  }
  return out
}

async function emParalelo<T>(itens: T[], n: number, f: (x: T) => Promise<void>, parar: () => boolean): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length && !parar()) await f(itens[i++])
  }))
}

// ---------------------------------------------------------------------------
// Tráfego real e previsão SEM rede
// ---------------------------------------------------------------------------

async function medeTrafego(): Promise<Trafego> {
  let total = 0
  let plano = 0
  let chat = 0
  for (const grupo of SESSOES) {
    for (const s of grupo) {
      let focus: ConversationFocus | undefined
      let pending: any
      for (const m of s.mensagens) {
        total++
        let p = false
        let c = false
        const out = await orchestrate({
          state: s.state, message: m, remoteEnabled: true, today: hoje, focus, pending,
          askRemote: async () => { c = true; return null }, planRemoteQuery: async () => { p = true; return null },
        })
        focus = out.focus || focus
        pending = out.response.actions.length ? out.response.actions : out.keepPending ? pending : undefined
        if (p) plano++
        if (c) chat++
      }
    }
  }
  return { taxaPlano: plano / total, taxaChat: chat / total, fonte: `corpus adversarial, ${total} mensagens (teto: planejador falhando manda a frase ao chat)` }
}

const porId = new Map<string, any>([...CASOS_CHAT, ...CASOS_PLANO, ...CASOS_CENARIO].map(c => [c.id, c]))

/** O "modelo" do modo falso responde o gabarito: exercita o pipeline inteiro e mede os prompts reais. */
function respostaDoGabarito(ctx: ContextoAvaliacao): string {
  const c = porId.get(ctx.caso)
  if (ctx.tarefa === 'plano') {
    return JSON.stringify(c?.suite === 'plano' && c.ouro.aceitos.length ? planoDoOuro(c.ouro.aceitos[0], hoje) : { version: 2, source: 'none' })
  }
  if (ctx.tarefa === 'cenario') {
    return JSON.stringify({ version: 2, steps: (c?.ouro?.passos || []).map((p: any) => materializa(p, hoje)), falta: null })
  }
  return JSON.stringify(c?.suite === 'chat' ? corpoOraculo(c, hoje) : { version: 1, mode: 'answer', reply: 'Certo.', actions: [] })
}

async function capturaPrompts(cfg: DeepSeekConfig): Promise<{ porTarefa: Map<string, RegistroHttp[]>; resultados: ResultadoCaso[] }> {
  const falsa: ConfigModelo = { id: 'X', rotulo: 'captura', modelo: 'deepseek-flash', pensamento: 'desligado' }
  const livro: Livro = { tetoUSD: 0, gastoUSD: 0, reservadoUSD: 0, chamadasReais: 0 }
  const porTarefa = new Map<string, RegistroHttp[]>()
  const resultados: ResultadoCaso[] = []
  const desinstala = instalaTransporte({
    modo: 'falso', hostPermitido: new URL(cfg.baseUrl).hostname, livro,
    respostaFalsa: ctx => respostaDoGabarito(ctx),
    aoRegistrar: r => { const k = `${r.caso}`; porTarefa.set(k, [...(porTarefa.get(k) || []), r]) },
  })
  try {
    for (const t of montaTarefas([falsa], 1)) resultados.push(...await executa(t, { ...cfg, apiKey: 'falsa' }, livro))
  } finally {
    desinstala()
  }
  if (livro.bloqueio) throw new Error(`o guarda de privacidade bloqueou a captura: ${livro.bloqueio}`)
  return { porTarefa, resultados }
}

function previstas(porTarefa: Map<string, RegistroHttp[]>, cs: ConfigModelo[], reps: number): ChamadaPrevista[] {
  const out: ChamadaPrevista[] = []
  for (const registros of porTarefa.values()) {
    for (const r of registros) {
      for (const c of cs) {
        for (let i = 0; i < reps; i++) {
          out.push({ config: c.id, modelo: c.modelo, pensamentoLigado: c.pensamento !== 'desligado', tarefa: r.tarefa, caracteres: r.caracteresEntrada, maxTokens: r.maxTokens || 900 })
        }
      }
    }
  }
  return out
}

async function saldoUSD(cfg: DeepSeekConfig): Promise<number | null> {
  if (!cfg.apiKey) return null
  try {
    const res = await fetch(`${cfg.baseUrl}/user/balance`, { headers: { authorization: `Bearer ${cfg.apiKey}` } })
    if (!res.ok) return null
    const data: any = await res.json()
    const usdInfo = (data?.balance_infos || []).find((b: any) => b?.currency === 'USD')
    return usdInfo ? Number(usdInfo.total_balance) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Modos grátis
// ---------------------------------------------------------------------------

async function modoModelos(cfg: DeepSeekConfig) {
  if (!cfg.apiKey) { console.log('Sem DEEPSEEK_API_KEY no ambiente nem no .env.'); return }
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.apiKey}` } })
    const data: any = res.ok ? await res.json() : null
    console.log(`GET /models → HTTP ${res.status}`)
    for (const m of data?.data || []) console.log(`  · ${m.id} (${m.owned_by})`)
  } catch (e: any) {
    console.log(`falha em /models: ${e?.message || e}`)
  }
  const saldo = await saldoUSD(cfg)
  console.log(`Saldo: ${saldo === null ? 'indisponível' : usd(saldo)}`)
  console.log(`Modelo que o código usa sem DEEPSEEK_MODEL: ${cfg.model}`)
}

async function modoOrcamento(cfg: DeepSeekConfig) {
  const t0 = Date.now()
  await observaRoteamento()
  const roteamento = resumoRoteamento(OBS.values())
  const { porTarefa, resultados } = await capturaPrompts(cfg)
  const trafego = await medeTrafego()
  const cs = configs.length ? configs : CONFIGS
  const chamadas = [...porTarefa.values()].flat()
  const porSuite = (s: string) => chamadas.filter(r => (r.tarefa === 'chat' ? porId.get(r.caso)?.suite !== 'chat' ? 'continuidade' : 'chat' : r.tarefa) === s)
  const oraculoPerfeito = resultados.filter(r => r.perigos.length).length === 0

  console.log('\n══════════ ORÇAMENTO — nenhuma chamada paga foi feita ══════════\n')
  console.log(`Data: ${hoje} · preços de ${FONTE_PRECOS} (consultados em ${PRECOS_CONSULTADOS_EM})`)
  console.log(`Casos: ${CASOS_CHAT.length} chat · ${CASOS_PLANO.length} planejador · ${CASOS_CENARIO.length} cenário (candidato) · ${CASOS_CONTINUIDADE.length} conversas`)
  console.log(`Corpus ${corpus}: ${CASOS_CHAT.filter(entraNoCorpus).length} chat · ${CASOS_PLANO.filter(entraNoCorpus).length} planejador · ${CASOS_CENARIO.filter(entraNoCorpus).length} cenário · ${CASOS_CONTINUIDADE.length} conversas`)
  console.log(linhasDeRoteamento(roteamento).join('\n'))
  console.log(`Suítes: ${suites.join(', ')} · repetições: ${repeticoes} · concorrência: ${concorrencia}`)
  console.log(`Chamadas lógicas por repetição, por configuração: ${chamadas.length} (chat ${porSuite('chat').length} · planejador ${chamadas.filter(r => r.tarefa === 'plano').length} · cenário ${porSuite('cenario').length} · turnos remotos de conversa ${porSuite('continuidade').length})`)
  console.log(`Caracteres médios de entrada: chat ${Math.round(avg(chamadas.filter(r => r.tarefa === 'chat').map(r => r.caracteresEntrada)))} · planejador ${Math.round(avg(chamadas.filter(r => r.tarefa === 'plano').map(r => r.caracteresEntrada)))} · cenário ${Math.round(avg(chamadas.filter(r => r.tarefa === 'cenario').map(r => r.caracteresEntrada)))}`)
  console.log(`Pipeline com o gabarito como resposta: ${oraculoPerfeito ? 'zero perigo (o avaliador não acusa a resposta certa)' : 'ACUSOU PERIGO NA RESPOSTA CERTA — não execute'}`)
  console.log(`Tráfego real (proxy): planejador em ${pct(trafego.taxaPlano)} das mensagens, chat em ${pct(trafego.taxaChat)} — ${trafego.fonte}`)

  for (const p of PREMISSAS) {
    const proj = projeta(previstas(porTarefa, cs, repeticoes), p)
    console.log(`\n— premissas "${p.nome}" (${p.tokensPorCaractere} token/char · cache ${Math.round(p.fracaoCache * 100)}% · ${p.pico ? 'PICO' : 'fora do pico'} · tentativas ×${p.fatorTentativas})`)
    for (const c of cs) {
      const k = proj.porConfig[c.id]
      if (!k) continue
      console.log(`   ${c.id} ${c.rotulo.padEnd(58)} ${String(Math.round(k.chamadasHttp)).padStart(5)} HTTP · ${usd(k.usd).padStart(11)} · ~${Math.ceil(k.duracaoSequencialMs / concorrencia / 60000)} min`)
    }
    console.log(`   TOTAL ${Math.round(proj.chamadasHttp)} chamadas HTTP · ${Math.round(proj.tokensEntrada).toLocaleString('pt-BR')} tokens de entrada · ${Math.round(proj.tokensSaida).toLocaleString('pt-BR')} de saída · ${usd(proj.usd)}`)
  }
  // `--sem-saldo`: nenhuma requisição à conta. O orçamento inteiro roda sem rede.
  const saldo = flag('sem-saldo') ? null : await saldoUSD(cfg)
  console.log(`\nSaldo da conta agora: ${flag('sem-saldo') ? 'não consultado (--sem-saldo)' : saldo === null ? 'indisponível' : usd(saldo)} — é a MESMA conta que atende o app publicado.`)
  console.log(`\nPesos da qualidade: ${Object.entries(PESOS).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  console.log(`Perigos (nunca compensados): ${TIPOS_PERIGO.join(', ')}`)
  console.log(`\nPara executar: npx tsx scripts/eval-assistant-models.mts --executar --teto-usd=<valor> --configs=${cs.map(c => c.id).join(',')}`)
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s, zero chamadas pagas)\n`)
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// ---------------------------------------------------------------------------
// Execução paga
// ---------------------------------------------------------------------------

const lerJsonl = (arq: string): any[] =>
  (fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const anexa = (arq: string, o: any) => fs.appendFileSync(arq, `${JSON.stringify(o)}\n`, 'utf8')

async function modoExecutar(cfg: DeepSeekConfig) {
  const teto = Number(valor('teto-usd'))
  if (!(teto > 0)) { console.log('Recusado: --teto-usd=<valor em dólares> é obrigatório para gastar.'); process.exitCode = 1; return }
  if (!cfg.apiKey) { console.log('Recusado: sem DEEPSEEK_API_KEY.'); process.exitCode = 1; return }
  const host = new URL(cfg.baseUrl).hostname
  if (host !== 'api.deepseek.com') { console.log(`Recusado: base URL aponta para ${host}; a avaliação só fala com api.deepseek.com.`); process.exitCode = 1; return }
  if (!configs.length) { console.log('Recusado: nenhuma configuração selecionada.'); process.exitCode = 1; return }

  console.log('Autoteste antes de gastar…')
  const auto = await runEvalSelfTest()
  if (auto.falhas.length) { console.log(`Recusado: autoteste com ${auto.falhas.length} falha(s):\n  ${auto.falhas.join('\n  ')}`); process.exitCode = 1; return }
  console.log(`ok · ${auto.total} verificações`)

  const reserva = Number(valor('reserva-usd') ?? 0.5)
  const saldo = await saldoUSD(cfg)
  if (saldo === null) { console.log('Recusado: não consegui ler o saldo da conta.'); process.exitCode = 1; return }
  if (teto > saldo - reserva) {
    console.log(`Recusado: teto ${usd(teto)} deixaria menos de ${usd(reserva)} de saldo (${usd(saldo)}) para o app publicado.`)
    process.exitCode = 1
    return
  }

  await observaRoteamento()
  const roteamento = resumoRoteamento(OBS.values())
  const { porTarefa } = await capturaPrompts(cfg)
  const trafego = await medeTrafego()
  const pasta = valor('retomar') || path.join('eval-results', new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(pasta, { recursive: true })
  const arqChamadas = path.join(pasta, 'chamadas.jsonl')
  const arqResultados = path.join(pasta, 'resultados.jsonl')
  const arqTarefas = path.join(pasta, 'tarefas.jsonl')
  let commit = ''
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { commit = '?' }
  fs.writeFileSync(path.join(pasta, 'manifesto.json'), JSON.stringify({
    hoje, commit, teto, repeticoes, suites, concorrencia, configs, precos: { fonte: FONTE_PRECOS, em: PRECOS_CONSULTADOS_EM }, trafego,
  }, null, 2))

  const feitas = new Set(lerJsonl(arqTarefas).map(x => x.chave))
  const livro: Livro = { tetoUSD: teto, gastoUSD: lerJsonl(arqChamadas).reduce((a, r) => a + (r.custoUSD || 0), 0), reservadoUSD: 0, chamadasReais: 0 }
  let parada = ''
  const suspensas = new Map<string, number>()
  const desinstala = instalaTransporte({
    modo: 'real', hostPermitido: host, chave: cfg.apiKey, livro,
    aoRegistrar: r => {
      anexa(arqChamadas, r)
      if (r.status === 401 || r.status === 402) parada = parada || `HTTP ${r.status} da DeepSeek (autenticação ou saldo)`
    },
  })
  const t0 = Date.now()
  const roda = async (lista: Tarefa[]) => emParalelo(lista.filter(t => !feitas.has(chaveTarefa(t))), concorrencia, async t => {
    if ((suspensas.get(t.config.id) || 0) >= 6) return
    const rs = await executa(t, cfg, livro)
    for (const r of rs) anexa(arqResultados, r)
    anexa(arqTarefas, { chave: chaveTarefa(t) })
    const falhaSeguida = rs.length > 0 && rs.every(r => r.falhaTransporte)
    suspensas.set(t.config.id, falhaSeguida ? (suspensas.get(t.config.id) || 0) + 1 : 0)
    if (livro.chamadasReais % 25 === 0) console.log(`  ${livro.chamadasReais} chamadas · gasto ${usd(livro.gastoUSD)} de ${usd(teto)}`)
  }, () => !!(livro.bloqueio || parada))

  try {
    const tarefas = montaTarefas(configs, repeticoes)
    const calibracao = tarefas.slice(0, 3 * configs.length)
    console.log(`\nCalibração: ${calibracao.length} tarefas medem o custo real antes do resto.`)
    await roda(calibracao)
    const medidas = lerJsonl(arqChamadas)
    const logicasPorRep = [...porTarefa.values()].flat().length
    let projecao = livro.gastoUSD
    for (const c of configs) {
      const custos = medidas.filter(r => r.config === c.id).map(r => r.custoUSD)
      const medio = avg(custos) || 0
      projecao += medio * logicasPorRep * repeticoes * 1.2
    }
    console.log(`Projeção com o custo MEDIDO: ${usd(projecao)} (teto ${usd(teto)})`)
    if (projecao > teto && !flag('aceitar-corte')) {
      parada = `a projeção medida (${usd(projecao)}) passa do teto; rode de novo com teto maior, menos configurações, ou --aceitar-corte para parar no teto`
    } else {
      await roda(tarefas.slice(calibracao.length))
    }
  } finally {
    desinstala()
  }

  const resultados: ResultadoCaso[] = lerJsonl(arqResultados)
  const doConfig = (id: string) => resultados.filter(r => r.config === id)
  // A NOTA sai só do que o modelo pôde influenciar. `calculaMetricas` cru fica
  // para o bloco do app, onde a falha local continua visível.
  const ordem = pontuaEOrdena(configs.map(c => metricasDoModelo(c.id, doConfig(c.id), trafego)))
  const fronteira = configs
    .map(c => calculaMetricas(c.id, doConfig(c.id).filter(r => !r.elegivelRemoto), trafego))
    .filter(m => m.execucoes > 0)
  const transportes = new Map(configs.map(c => [c.id, resumoTransporte(doConfig(c.id))] as const))
  // Justiça: A, B e C têm que ter sido medidos sobre o MESMO conjunto elegível.
  const desequilibrio: string[] = []
  for (let i = 1; i < configs.length; i++) {
    const d = divergenciaDeDenominador(doConfig(configs[0].id), doConfig(configs[i].id))
    if (d.length) desequilibrio.push(`${configs[0].id} × ${configs[i].id}: ${d.slice(0, 8).join(', ')}${d.length > 8 ? ` (+${d.length - 8})` : ''}`)
  }
  const relatorio = montaRelatorio({
    ordem, fronteira, roteamento, transportes, desequilibrio,
    rs: resultados, livro, parada: parada || livro.bloqueio || '', ms: Date.now() - t0, commit,
  })
  fs.writeFileSync(path.join(pasta, 'relatorio.md'), relatorio, 'utf8')
  fs.writeFileSync(path.join(pasta, 'relatorio.json'), JSON.stringify({
    ordem, fronteira, roteamento, transporte: Object.fromEntries(transportes), desequilibrio,
    gastoUSD: livro.gastoUSD, parada: parada || livro.bloqueio || null,
  }, null, 2))
  varreSegredos(pasta, cfg.apiKey)
  console.log(`\n${relatorio}\n\nArquivos em ${pasta}`)
}

/** Bloco APP/ROTEAMENTO: o que o aparelho resolve, o que ele erra, o que sobra para o modelo. */
function linhasDeRoteamento(r: ResumoRoteamento): string[] {
  const suites = Object.entries(r.porSuite).map(([s, v]) => `${s} ${v.elegiveis}/${v.total}`).join(' · ')
  return [
    `Roteamento medido (orquestrador real, sem rede): ${r.total} frases · resolvidas no aparelho ${r.localCorreto + r.localFalha}`
    + ` (certas ${r.localCorreto} · ERRADAS ${r.localFalha}) · elegíveis ao remoto ${r.remotoElegivel} (${pct(r.taxaAlcance)})`,
    `  por suíte: ${suites}`,
    r.rotuloVencido.length
      ? `  rótulo desatualizado (dizia local-errada, hoje chega ao remoto): ${r.rotuloVencido.join(', ')}`
      : '  nenhum rótulo desatualizado',
  ]
}

interface DadosRelatorio {
  ordem: MetricasConfig[]
  fronteira: MetricasConfig[]
  roteamento: ResumoRoteamento
  transportes: Map<string, ResumoTransporte>
  desequilibrio: string[]
  rs: ResultadoCaso[]
  livro: Livro
  parada: string
  ms: number
  commit: string
}

function montaRelatorio(d: DadosRelatorio): string {
  const { ordem, fronteira, roteamento, transportes, desequilibrio, rs, livro, parada, ms, commit } = d
  const rotulo = (id: string) => CONFIGS.find(c => c.id === id)?.rotulo || id
  const l: string[] = []
  l.push(`# Avaliação dos modelos remotos — ${hoje}`, '')
  l.push(`Commit ${commit} · gasto real ${usd(livro.gastoUSD)} de teto ${usd(livro.tetoUSD)} · ${livro.chamadasReais} chamadas · ${Math.round(ms / 60000)} min`)
  if (parada) l.push('', `**Execução interrompida:** ${parada}`)
  l.push('', '## App / roteamento', '',
    'Este bloco é do APARELHO, não dos modelos. Nada dele entra na nota de nenhuma configuração.', '')
  l.push(`- corpus de frases: **${roteamento.total}**`)
  l.push(`- resolvidas CERTO no aparelho: **${roteamento.localCorreto}**`)
  l.push(`- resolvidas ERRADO no aparelho, antes de o modelo ser chamado: **${roteamento.localFalha}**`)
  l.push(`- elegíveis ao remoto (o modelo foi de fato requisitado): **${roteamento.remotoElegivel}** (${pct(roteamento.taxaAlcance)})`)
  for (const [suite, v] of Object.entries(roteamento.porSuite)) l.push(`  - ${suite}: ${v.elegiveis} de ${v.total}`)
  if (roteamento.localFalha) {
    l.push('', `Falha local continua sendo bug e continua aqui — ${roteamento.fronteira.join(', ')}. `
      + 'Nenhuma escolha de modelo conserta isso, porque o modelo não é consultado.')
  }
  if (desequilibrio.length) {
    l.push('', '⚠️ **Denominadores diferentes entre configurações** — a comparação abaixo não é justa até isto ser explicado:',
      ...desequilibrio.map(x => `- ${x}`))
  }
  l.push('', '## Qualidade do modelo — SÓ os casos elegíveis', '',
    `Denominador: ${ordem[0]?.execucoes ?? 0} execuções por configuração, todas com chamada remota real.`, '')
  l.push('### Ordem (menos perigo primeiro; qualidade só desempata)', '')
  l.push('| # | Configuração | Perigos/100 (IC 95%) | Qualidade | Custo / 1.000 msgs | p50 | p95 | Estabilidade |', '|---|---|---|---|---|---|---|---|')
  ordem.forEach((m, i) => l.push(`| ${i + 1} | ${m.config} — ${rotulo(m.config)} | ${m.perigosPor100} (${m.perigosIntervalo[0]}–${m.perigosIntervalo[1]}) | ${m.qualidade} | ${m.custoPor1000MensagensUSD === null ? '—' : usd(m.custoPor1000MensagensUSD)} | ${(m.latenciaP50 / 1000).toFixed(1)}s | ${(m.latenciaP95 / 1000).toFixed(1)}s | ${pct(m.estabilidade)} |`))
  if (ordem.length > 1 && empateEmSeguranca(ordem[0], ordem[1])) {
    l.push('', `⚠️ ${ordem[0].config} e ${ordem[1].config} estão empatadas em segurança dentro do ruído: repetir antes de decidir.`)
  }
  const linha = (nome: string, f: (m: MetricasConfig) => string) => l.push(`| ${nome} | ${ordem.map(f).join(' | ')} |`)
  l.push('', '## Métricas', '', `| Métrica | ${ordem.map(m => m.config).join(' | ')} |`, `|---|${ordem.map(() => '---').join('|')}|`)
  linha('intent accuracy', m => pct(m.intentAccuracy))
  linha('action precision', m => pct(m.actionPrecision))
  linha('action recall', m => pct(m.actionRecall))
  linha('field accuracy', m => pct(m.fieldAccuracy))
  linha('query-plan exact', m => pct(m.queryPlanExact))
  linha('query-plan semantic', m => pct(m.queryPlanSemantic))
  linha('scenario-plan accuracy', m => pct(m.scenarioPlanAccuracy))
  linha('clarification precision', m => pct(m.clarificationPrecision))
  linha('clarification recall', m => pct(m.clarificationRecall))
  linha('hallucination rate', m => pct(m.hallucinationRate))
  linha('numeric hallucination rate', m => pct(m.numericHallucinationRate))
  linha('profile contamination', m => pct(m.profileContamination))
  linha('invalid-contract rate', m => pct(m.invalidContractRate))
  linha('generic response rate', m => pct(m.genericRate))
  linha('privacy violation rate', m => pct(m.privacyViolationRate))
  linha('transport failure rate', m => pct(m.transportFailureRate))
  linha('remote failure rate (fallback local não perdoa)', m => pct(m.remoteFailureRate))
  linha('tokens de entrada / chamada', m => String(Math.round(m.tokensEntradaMedio)))
  linha('tokens de saída / chamada', m => String(Math.round(m.tokensSaidaMedio)))
  linha('tokens de raciocínio / chamada', m => String(Math.round(m.tokensRaciocinioMedio)))
  linha('custo total', m => usd(m.custoTotalUSD))
  l.push('', '## Perigos por tipo', '', `| Tipo | ${ordem.map(m => m.config).join(' | ')} |`, `|---|${ordem.map(() => '---').join('|')}|`)
  for (const t of TIPOS_PERIGO) l.push(`| ${t} | ${ordem.map(m => m.perigos[t]).join(' | ')} |`)
  l.push('', '## Transporte', '',
    '`casos` e `chamadas lógicas` são o denominador; `tentativas HTTP` inclui retry, e é ela que a conta e a latência seguem.', '',
    '| Configuração | Casos | Chamadas lógicas | Tentativas HTTP | Retries | Falhas de transporte | Falhas remotas | p50 | p95 | Tokens in | Tokens out | Custo |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [id, t] of transportes) {
    l.push(`| ${id} | ${t.casosLogicos} | ${t.chamadasLogicas} | ${t.tentativasHttp} | ${t.retries} | ${t.falhasTransporte} | ${t.falhasRemotas} | `
      + `${(t.latenciaP50 / 1000).toFixed(1)}s | ${(t.latenciaP95 / 1000).toFixed(1)}s | ${t.tokensEntrada} | ${t.tokensSaida} | ${usd(t.custoUSD)} |`)
  }
  if (fronteira.length) {
    l.push('', '## Fronteira de ROTEAMENTO (`--corpus=fronteira`) — fora da nota do modelo', '',
      'Frases que o aparelho resolve ERRADO hoje. O modelo foi consultado aqui só para responder "valeria mandar isto a ele?".',
      'A resposta não muda a nota de ninguém: em produção esta chamada não acontece.', '',
      '| Configuração | Execuções | Plano semântico | Intenção | Perigos/100 |', '|---|---|---|---|---|')
    for (const m of fronteira) l.push(`| ${m.config} | ${m.execucoes} | ${pct(m.queryPlanSemantic)} | ${pct(m.intentAccuracy)} | ${m.perigosPor100} |`)
  }
  l.push('', '## Cada perigo, para auditoria manual', '',
    'Só os elegíveis: perigo de execução que o modelo não influenciou não é dele.', '')
  for (const r of soElegiveis(rs).filter(x => x.perigos.length)) {
    l.push(`- **${r.config}** ${r.caso}${r.turno ? `#${r.turno}` : ''} (rep ${r.rep}): ${r.perigos.map(p => `${p.tipo} — ${p.detalhe}`).join('; ')}${r.resposta ? ` · resposta: "${r.resposta.replace(/\s+/g, ' ').slice(0, 160)}"` : ''}`)
  }
  return l.join('\n')
}

function varreSegredos(pasta: string, chave: string | null) {
  for (const f of fs.readdirSync(pasta)) {
    const t = fs.readFileSync(path.join(pasta, f), 'utf8')
    if ((chave && chave.length >= 8 && t.includes(chave)) || /\bsk-[A-Za-z0-9]{16,}/.test(t)) {
      console.log(`‼ SEGREDO ENCONTRADO em ${path.join(pasta, f)} — não compartilhe este arquivo.`)
      process.exitCode = 1
    }
  }
}

// ---------------------------------------------------------------------------

const cfg = getDeepSeekConfig(process.cwd())
if (flag('modelos')) await modoModelos(cfg)
else if (flag('autoteste')) {
  const r = await runEvalSelfTest()
  console.log(`${r.total - r.falhas.length}/${r.total} verificações`)
  for (const x of r.resumo) console.log(`  ${x}`)
  for (const f of r.falhas) console.log(`  FALHA · ${f}`)
  if (r.falhas.length) process.exitCode = 1
} else if (flag('executar')) await modoExecutar(cfg)
else await modoOrcamento(cfg)
