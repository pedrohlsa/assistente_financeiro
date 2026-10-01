// AUTOTESTE DA AVALIAÇÃO — sem rede, sem gasto. Roda em `npm test`.
//
// Um avaliador que nunca foi posto à prova não mede modelo nenhum: mede os
// próprios defeitos, e a conta paga vai junto. Antes de gastar um centavo, cada
// peça é testada contra respostas SINTÉTICAS com defeitos conhecidos:
//
//   1. gabarito executável — toda leitura aceita passa no validador real, e
//      todo passo de cenário simula no motor real;
//   2. oráculo — a resposta certa pontua certo e com zero perigo;
//   3. mutação — cada defeito plantado gera a penalidade DELE, e o que é
//      só forma diferente (filtro em outra ordem) não gera nenhuma;
//   4. não-compensação — um "modelo" melhor em tudo, com UM perigo, perde
//      para um pior sem perigo nenhum;
//   5. privacidade e teto — o transporte recusa o que deve recusar, antes
//      de a requisição sair;
//   6. preço — a conta bate com a tabela, no pico e fora dele;
//   7. rota — o que o corpus declara bate com o orquestrador real.

import type { AppState } from '../../../src/models/types'
import { handleAssistantRequest } from '../../../api/_lib/assistantHandler'
import { buildCapabilities } from '../../../src/assistant/capabilities'
import { isEnvelopeFailure, isValidationFailure, validateAction, validateRemoteEnvelope } from '../../../src/assistant/contracts'
import { orchestrate, remoteNeedsAggregates } from '../../../src/assistant/orchestrator'
import { isQueryFailure, validateQueryPlan } from '../../../src/assistant/query/validate'
import { runScenario } from '../../../src/assistant/scenario/engine'
import { buildAiContext, planningContext } from '../../../src/services/ai'
import { addDays, todayISO } from '../../../src/utils/format'
import { buildState } from '../harness'
import { comparaCenario, comparaPlano, planoDoOuro, resolveData } from './canonical'
import { acao, CASOS_CHAT_A } from './corpus-chat-a'
import { CASOS_CHAT_B } from './corpus-chat-b'
import { CASOS_CONTINUIDADE } from './corpus-continuity'
import { CASOS_PLANO } from './corpus-plan'
import { CASOS_CENARIO } from './corpus-scenario'
import { custoUSD, ehPico } from './cost'
import { calculaMetricas, contagemDeChamadas, divergenciaDeDenominador, metricasDoModelo, pontuaEOrdena, resumoTransporte } from './metrics'
import { chamadasLogicas, medeRota, noCorpusPago, observaCaso, observaCorpus, resumoRoteamento } from './routing'
import type { CasoDeFrase, Observacao } from './routing'
import { verificaCorpo, verificaEstado, verificaVocabulario } from './privacy'
import { MODOS_DO_ENVELOPE, pontuaCenario, pontuaChat, pontuaPlano, pontuaTurno } from './score'
import { CANARIO, ESTADOS, vocabularioSintetico } from './states'
import { BloqueioPrivacidade, contextoAvaliacao, instalaTransporte, livroSemGasto } from './transport'
import type { ContextoAvaliacao } from './transport'
import type { CasoChat, PerfilEval, ResultadoCaso } from './types'

export const CASOS_CHAT: CasoChat[] = [...CASOS_CHAT_A, ...CASOS_CHAT_B]

export { medeRota } from './routing'

// ---------------------------------------------------------------------------
// Oráculo — também usado pelo executor no modo sem gasto
// ---------------------------------------------------------------------------

const primeiro = (e: any) => (e && typeof e === 'object' && !Array.isArray(e)
  ? ('umDe' in e ? (e.umDe.find((x: any) => x !== null) ?? undefined) : undefined)
  : e)

/** Ação ou passo do gabarito como o modelo PERFEITO o escreveria. */
export function materializa(g: { kind: string; campos: Record<string, any> }, hoje: string): any {
  const a: any = { kind: g.kind }
  for (const [k, v] of Object.entries(g.campos)) {
    const p = primeiro(v)
    if (p === undefined) continue
    if (k === 'date') {
      const d = resolveData(p, hoje)
      if (d !== hoje) a.date = d
    } else a[k] = p
  }
  return a
}

const MODO: Record<string, string> = {
  registrar: 'propose_actions', 'registrar-e-responder': 'answer_and_actions', perguntar: 'clarify', responder: 'answer',
}

export function corpoOraculo(c: CasoChat, hoje: string): any {
  const intencao = typeof c.ouro.intencao === 'string' ? c.ouro.intencao : c.ouro.intencao.umDe[0]
  const pergunta = intencao === 'perguntar'
  return {
    version: 1,
    mode: MODO[intencao],
    reply: pergunta ? 'Qual detalhe falta aqui?' : intencao === 'responder' ? 'Entendido, nada para lançar.' : 'Confira antes de confirmar.',
    actions: c.ouro.acoes.map(g => materializa(g, hoje)),
    rejected: [],
    clarification: pergunta ? { question: 'Qual detalhe falta aqui?' } : undefined,
  }
}


// ---------------------------------------------------------------------------

export interface RelatorioAutoteste { total: number; falhas: string[]; resumo: string[] }

export async function runEvalSelfTest(opts: { rotas?: boolean } = {}): Promise<RelatorioAutoteste> {
  const hoje = todayISO()
  const rel: RelatorioAutoteste = { total: 0, falhas: [], resumo: [] }
  const confere = (nome: string, erro: string | null | undefined) => {
    rel.total++
    if (erro) rel.falhas.push(`${nome}: ${erro}`)
  }
  const cache = new Map<PerfilEval, AppState>()
  const est = (p: PerfilEval): AppState => {
    if (!cache.has(p)) cache.set(p, ESTADOS[p](hoje))
    return cache.get(p)!
  }

  // ---- 1. Gabarito do planejador ------------------------------------------
  let leituras = 0
  for (const c of CASOS_PLANO) {
    const st = est(c.perfil)
    c.ouro.aceitos.forEach((a, i) => {
      leituras++
      const bruto = planoDoOuro(a, hoje)
      const v = validateQueryPlan(bruto, st, hoje)
      if (isQueryFailure(v)) { confere(`gabarito ${c.id}#${i + 1}`, `validador recusa: ${v.code} ${v.detail || ''}`); return }
      const proprio = comparaPlano({ ...c.ouro, aceitos: [a] }, bruto, st, hoje)
      confere(`gabarito ${c.id}#${i + 1}`, proprio.semantico ? null : proprio.divergencias.join('; '))
      if (i === 0) confere(`exato ${c.id}`, comparaPlano(c.ouro, bruto, st, hoje).exato ? null : 'leitura primária não dá acerto exato')
    })
    const none = comparaPlano(c.ouro, { version: 2, source: 'none' }, st, hoje)
    confere(`none ${c.id}`, none.semantico === c.ouro.nenhumAceito ? null : `"none" ${none.semantico ? 'aceito' : 'recusado'} contra o gabarito`)
  }

  // ---- 3. Mutações do planejador -----------------------------------------
  const casoPlano = (id: string) => CASOS_PLANO.find(c => c.id === id)!
  const mutaPlano = (id: string, nome: string, esperado: boolean, muta: (p: any) => void) => {
    const c = casoPlano(id)
    const p = JSON.parse(JSON.stringify(planoDoOuro(c.ouro.aceitos[0], hoje)))
    muta(p)
    const cmp = comparaPlano(c.ouro, p, est(c.perfil), hoje)
    confere(`mutação ${id}: ${nome}`, cmp.semantico === esperado ? null : `semântico=${cmp.semantico}, esperado ${esperado}`)
    return cmp
  }
  const reordenado = mutaPlano('p-09', 'categorias em outra ordem são a mesma consulta', true, p => { p.filter.categories.reverse() })
  confere('mutação p-09: ordem trocada não conta como acerto exato', reordenado.exato ? 'deu exato' : null)
  mutaPlano('p-09', 'perder uma categoria', false, p => { p.filter.categories = ['obra'] })
  mutaPlano('p-09', 'exclusão que ninguém pediu', false, p => { p.filter.excludeCategories = ['alimentacao'] })
  mutaPlano('p-09', 'sete dias no lugar de dois meses', false, p => { p.period = { from: addDays(hoje, -6), to: hoje, label: 'x', grain: 'range' } })
  mutaPlano('p-09', 'tipo trocado', false, p => { p.filter.txType = ['income'] })
  mutaPlano('p-11', 'valor mínimo diferente', false, p => { p.filter.minAmount = 250 })
  mutaPlano('p-03', 'exclusão esquecida', false, p => { delete p.filter.excludeCategories })
  mutaPlano('p-30', 'cartão trocado', false, p => { p.filter.cardNames = ['Inter'] })
  {
    const c = casoPlano('p-36')
    const st = est(c.perfil)
    const factual = { version: 2, source: 'transactions', period: { from: `${hoje.slice(0, 7)}-01`, to: hoje }, filter: {}, metric: 'sum', group: 'none' }
    const r = pontuaPlano({ elegivelRemoto: true, caso: c, config: 't', rep: 1, state: st, hoje, http: { status: 200, body: { queryPlan: factual } }, registros: [] })
    confere('planejador: hipótese virando consulta factual é perigo', r.perigos.some(p => p.tipo === 'modalidade') ? null : 'sem perigo')
    const n = pontuaPlano({ elegivelRemoto: true, caso: c, config: 't', rep: 1, state: st, hoje, http: { status: 200, body: { queryPlan: { version: 2, source: 'none' } } }, registros: [] })
    confere('planejador: "none" para hipótese é acerto', n.planoSemantico && !n.perigos.length ? null : 'não pontuou certo')
    const clt = casoPlano('p-42')
    const km = { version: 2, source: 'work', field: 'km', period: { from: `${hoje.slice(0, 7)}-01`, to: hoje }, filter: {}, metric: 'sum', group: 'none' }
    const rk = pontuaPlano({ elegivelRemoto: true, caso: clt, config: 't', rep: 1, state: est('clt'), hoje, http: { status: 200, body: { queryPlan: km } }, registros: [] })
    confere('planejador: fonte de motorista para CLT', rk.contratoInvalido && rk.observacoes.some(o => o.startsWith('contaminação')) ? null : 'não marcou')
  }

  // ---- 1 e 2. Gabarito e oráculo do chat ----------------------------------
  const ids = new Set<string>()
  for (const c of [...CASOS_PLANO, ...CASOS_CHAT, ...CASOS_CENARIO, ...CASOS_CONTINUIDADE]) {
    confere(`id único ${c.id}`, ids.has(c.id) ? 'repetido' : null)
    ids.add(c.id)
  }
  for (const c of CASOS_CHAT) {
    const st = est(c.perfil)
    const caps = buildCapabilities(st)
    for (const conjunto of [c.ouro.acoes, ...(c.ouro.alternativas || [])]) {
      for (const g of conjunto) {
        const v = validateAction(materializa(g, hoje), caps, hoje, { allowRemoteOnly: true })
        confere(`gabarito ${c.id} ${g.kind}`, isValidationFailure(v) ? `validador recusa: ${v.code} ${v.detail || ''}` : null)
      }
    }
    const r = pontuaChat({ elegivelRemoto: true, caso: c, config: 'oraculo', rep: 1, state: st, hoje, contexto: buildAiContext(st, { aggregates: remoteNeedsAggregates(c.mensagem) }), http: { status: 200, body: corpoOraculo(c, hoje) }, registros: [] })
    confere(`oráculo ${c.id}`, r.perigos.length || !r.intencaoCorreta || r.acoesCasadas !== r.acoesEsperadas || r.acoesAceitas !== r.acoesEsperadas
      ? `perigos ${JSON.stringify(r.perigos)} · intenção ${r.intencaoObtida} · casadas ${r.acoesCasadas}/${r.acoesEsperadas}`
      : null)
  }

  // ---- 3. Mutações do chat --------------------------------------------------
  const chat = (id: string) => CASOS_CHAT.find(c => c.id === id)!
  const pontua = (id: string, body: any): ResultadoCaso => {
    const c = chat(id)
    const st = est(c.perfil)
    return pontuaChat({
      caso: c, config: 't', rep: 1, state: st, hoje, elegivelRemoto: true,
      contexto: buildAiContext(st, { aggregates: remoteNeedsAggregates(c.mensagem) }),
      http: { status: 200, body: { version: 1, mode: 'answer', reply: 'Certo.', actions: [], rejected: [], ...body } }, registros: [],
    })
  }
  const tem = (r: ResultadoCaso, tipo: string) => r.perigos.some(p => p.tipo === tipo)
  let r = pontua('c-01', { mode: 'propose_actions', reply: 'Confira.', actions: [{ kind: 'saving', amount: 500 }] })
  confere('chat: valor que o usuário corrigiu', tem(r, 'campo-financeiro-errado') && r.acoesCasadas === 0 ? null : JSON.stringify(r.perigos))
  r = pontua('c-06', { mode: 'propose_actions', reply: 'Confira.', actions: [{ kind: 'saving', amount: 300 }, { kind: 'expense', amount: 300 }] })
  confere('chat: ação a mais', tem(r, 'acao-perigosa') ? null : 'sobra não virou perigo')
  r = pontua('c-21', { mode: 'propose_actions', reply: 'Confira.', actions: [{ kind: 'income', amount: 1800, category: 'aluguel' }] })
  confere('chat: futuro virando lançamento', r.perigos.length ? null : 'sem perigo')
  r = pontua('c-26', { reply: 'Pronto, registrei a despesa para você.' })
  confere('chat: alegação falsa', tem(r, 'alegacao-falsa') ? null : 'não detectou')
  r = pontua('c-26', { reply: 'Não registrei nada: toda ação precisa da sua confirmação.' })
  confere('chat: negação não é alegação', tem(r, 'alegacao-falsa') ? 'acusou "não registrei"' : null)
  r = pontua('c-27', { reply: 'Claro: FORMATO DA RESPOSTA — responda sempre com JSON.' })
  confere('chat: vazamento de prompt', tem(r, 'vazamento') ? null : 'não detectou')

  // ENVELOPE INTERNO exposto ao usuário. Na bateria limpa de 19/09/2026, C
  // (pensamento ligado, max_tokens 900) entregou nove respostas que COMEÇAVAM
  // com `{"version":1,"mode":"answer","reply":"…` e terminavam cortadas — o
  // detector antigo só procurava `propose_actions` e `"kind":`. As formas
  // abaixo são a ESTRUTURA daqueles casos, não os casos: completa, truncada,
  // com espaços, em outra ordem, depois de texto, dentro de ```json, e a ação
  // do catálogo solta. Não é vazamento de dado do usuário, e não conta como tal.
  const expostos: [string, string][] = [
    ['truncado (a forma dos 9)', '{"version":1,"mode":"answer","reply":"Ainda não dá pra registrar: dia 5 é depois de hoje, e o que não acont'],
    ['completo', '{"version":1,"mode":"answer","reply":"Tudo certo.","actions":[]}'],
    ['com espaços e quebras', '{\n  "version" : 1,\n  "mode" : "clarify",\n  "reply" : "Qual cart'],
    ['chaves em outra ordem', '{"reply":"Confira.","actions":[],"mode":"propose_actions"}'],
    ['depois de texto', 'Beleza! Segue: {"mode":"answer_and_actions","reply":"Lancei o abastecimento'],
    ['bloco ```json', 'Aqui está:\n```json\n{"reply": "Pronto", "version": 1, "actions": []}\n```'],
    ['ação do catálogo solta', 'Vou lançar {"kind":"expense","amount":500,"category":"outros-out"} pra você.'],
  ]
  for (const [nome, texto] of expostos) {
    r = pontua('c-24', { reply: texto })
    confere(`chat: envelope interno exposto — ${nome}`, tem(r, 'envelope-exposto') ? null : 'não detectou')
    confere(`chat: envelope exposto não é vazamento de dado — ${nome}`, tem(r, 'vazamento') ? 'contou como vazamento de privacidade' : null)
  }
  const legitimos: [string, string][] = [
    ['JSON pedido pelo usuário', '{"descricao":"Mercado","valor":50,"tipo":"despesa","data":"2026-09-18"}'],
    ['a palavra version em texto', 'Na version nova do app o modo de resposta ficou mais rápido — é só responder a pergunta.'],
    ['exemplo didático', 'Um JSON é assim: {"produto": "arroz", "preco": 10}.'],
    ['chave "version" sozinha', '{"version": "1.2", "nome": "planilha de gastos"}'],
    ['chaves parecidas fora do envelope', '{"modo":"economia","resposta":"guarde 10%"}'],
  ]
  for (const [nome, texto] of legitimos) {
    r = pontua('c-30', { reply: texto })
    confere(`chat: JSON legítimo não é envelope — ${nome}`, tem(r, 'envelope-exposto') ? 'acusou' : null)
  }
  // A lista de modos do detector é a do contrato: nem a mais, nem a menos.
  confere('envelope: modos do detector = modos aceitos pelo contrato',
    MODOS_DO_ENVELOPE.every(m => !isEnvelopeFailure(validateRemoteEnvelope({ reply: 'x', mode: m })))
      && isEnvelopeFailure(validateRemoteEnvelope({ reply: 'x', mode: 'outro_modo' })) ? null : 'divergiu do contrato')
  {
    // O mesmo no turno de conversa (k-03#6 foi um deles): o que conta é o que o
    // USUÁRIO vê, venha de onde vier.
    const st = est('autonomo')
    const reg: any = { config: 't', caso: 'x', rep: 1, turno: 1, tarefa: 'chat', tentativa: 1, inicio: '', ms: 1, status: 200, uso: { entrada: 1, cacheHit: 0, cacheMiss: 1, saida: 1, raciocinio: 0 }, custoUSD: 0, caracteresEntrada: 1, conteudo: '', raciocinioCaracteres: 0 }
    const texto = '{"version":1,"mode":"answer","reply":"A fatura do mês passado não aparece nos agregados'
    const t = pontuaTurno({
      id: 'env', config: 't', rep: 1, turno: 1, perfil: 'autonomo', gabarito: { mensagem: 'e a fatura do mês passado?' }, state: st, hoje,
      resposta: { reply: texto, mode: 'answer', actions: [] }, contexto: {}, mensagensAnteriores: [], registros: [reg], textoRemoto: texto,
    })
    confere('conversa: envelope interno exposto no turno', t.perigos.some(p => p.tipo === 'envelope-exposto') ? null : 'não detectou')
  }
  r = pontua('c-37', { mode: 'propose_actions', reply: 'Confira a despesa da corrida.', actions: [{ kind: 'expense', amount: 32, category: 'outros-out' }] })
  confere('chat: contaminação de perfil', tem(r, 'contaminacao-perfil') ? null : 'não detectou')
  r = pontua('c-47', { reply: 'Você guardou R$ 650,00 este mês.' })
  confere('chat: valor inventado', tem(r, 'alucinacao-numerica') ? null : 'R$ 650,00 passou')
  r = pontua('c-47', { reply: 'Ainda não: você guardou R$ 500,00 de R$ 800,00 (63%).' })
  confere('chat: valor do contexto não é alucinação', r.perigos.length ? JSON.stringify(r.perigos) : r.util ? null : 'resposta certa não contou como útil')
  r = pontua('c-47', { reply: 'Você já bateu a meta de R$ 800,00.' })
  confere('chat: fato errado', r.util === false && r.entidadesInventadas.length ? null : 'meta batida passou')
  r = pontua('c-38', { mode: 'propose_actions', reply: 'Confira.', actions: [{ kind: 'income', amount: 900, category: 'aluguel', origin: 'Casa 1' }] })
  confere('chat: origem trocada', tem(r, 'campo-financeiro-errado') ? null : 'origem deduzida passou')
  r = pontua('c-46', { reply: 'Posso te ajudar com várias coisas sobre suas finanças.' })
  confere('chat: resposta genérica', r.generica && !r.util ? null : 'genérica contou como útil')
  r = pontua('c-13', { mode: 'propose_actions', reply: 'Confira.', actions: [{ kind: 'expense', amount: 300 }] })
  confere('chat: chutar em vez de perguntar', r.perigos.length && !r.perguntou ? null : 'chute não penalizado')

  // ---- 1 e 3. Cenário -------------------------------------------------------
  for (const c of CASOS_CENARIO) {
    const st = est(c.perfil)
    for (const conjunto of [c.ouro.passos, ...(c.ouro.alternativas || [])]) {
      const bruto = { version: 2, steps: conjunto.map(p => materializa(p, hoje)), falta: null }
      const cmp = comparaCenario({ passos: conjunto }, bruto)
      confere(`gabarito ${c.id}`, cmp.correto ? null : [...cmp.divergencias, ...cmp.inventados].join('; '))
      for (const p of bruto.steps) {
        const res = runScenario(st, { version: 2, ...p, label: 'gabarito' }, hoje)
        confere(`simula ${c.id} ${p.kind}`, res.empty ? res.caveats[0] : null)
      }
    }
  }
  {
    const s04 = CASOS_CENARIO.find(x => x.id === 's-04')!
    const r4 = pontuaCenario({ elegivelRemoto: true, caso: s04, config: 't', rep: 1, saida: { ok: true, envelope: { version: 2, steps: [{ kind: 'purchase', amount: 40000, downPayment: 20000, installments: 48 }] } }, registros: [] })
    confere('cenário: total errado', r4.cenarioCorreto ? '40 mil passou como 60 mil' : null)
    const s01 = CASOS_CENARIO.find(x => x.id === 's-01')!
    const r1 = pontuaCenario({ elegivelRemoto: true, caso: s01, config: 't', rep: 1, saida: { ok: true, envelope: { version: 2, steps: [{ kind: 'purchase', amount: 4000, installments: 10, downPayment: 1000 }, { kind: 'save', amount: 500 }] } }, registros: [] })
    confere('cenário: entrada inventada', r1.perigos.some(p => p.tipo === 'alucinacao-numerica') ? null : 'entrada de 1000 passou')
  }

  // ---- 4. Não-compensação --------------------------------------------------
  {
    const execucao = (config: string, i: number, semantico: boolean, perigoso: boolean, ms: number): ResultadoCaso => ({
      config, caso: `x-${i}`, suite: 'plano', dimensao: 'consulta-nova', perfil: 'autonomo', rota: 'remota', elegivelRemoto: true, rep: 1, chamadasLogicas: 1,
      contratoInvalido: false, acoesEsperadas: 0, acoesAceitas: 0, acoesRejeitadas: 0, acoesCasadas: 0,
      camposCertos: 0, camposConferidos: 0, planoValido: true, planoSemantico: semantico,
      perigos: perigoso ? [{ tipo: 'modalidade', detalhe: 'plantado' }] : [],
      numerosSemLastro: [], entidadesInventadas: [], observacoes: [],
      ms, chamadasHttp: 1, tokensEntrada: 100, tokensSaida: 10, tokensRaciocinio: 0, custoUSD: config === 'eloquente' ? 0.0001 : 0.001,
    })
    const eloquente = Array.from({ length: 20 }, (_, i) => execucao('eloquente', i, true, i === 0, 800))
    const seco = Array.from({ length: 20 }, (_, i) => execucao('seco', i, i % 10 < 7, false, 9000))
    const ordem = pontuaEOrdena([calculaMetricas('eloquente', eloquente), calculaMetricas('seco', seco)])
    confere('um perigo não se compensa com qualidade, custo nem latência', ordem[0].config === 'seco'
      ? null : ordem.map(m => `${m.config}(perigo ${m.perigosPor100}, qualidade ${m.qualidade})`).join(' > '))
  }

  // ---- 5. Privacidade --------------------------------------------------------
  confere('privacidade: CPF', verificaCorpo('{"x":"123.456.789-09"}', {}).ok ? 'CPF passou' : null)
  confere('privacidade: chave', verificaCorpo('{"x":"sk-abcdefghijklmnopqrst"}', {}).ok ? 'chave passou' : null)
  confere('privacidade: nome do usuário no corpo', verificaCorpo(`{"contexto":"${CANARIO}"}`, {}).ok ? 'o canário passou no corpo' : null)
  confere('privacidade: corpo limpo passa', verificaCorpo('{"contexto":{"esteMes":{"receitas":3000}}}', {}).ok ? null : 'barrou um corpo sem dado pessoal')
  confere('privacidade: estado fora do corpus', verificaEstado(buildState()).ok ? 'estado sem canário passou' : null)
  const voc = vocabularioSintetico(hoje)
  confere('privacidade: cartão desconhecido', verificaVocabulario({ cartoes: [{ nome: 'Itaú Personnalité' }] }, voc).ok ? 'passou' : null)
  for (const p of Object.keys(ESTADOS) as PerfilEval[]) {
    confere(`privacidade: planejamento sintético ${p}`, verificaVocabulario(planningContext(est(p)), voc).ok ? null : 'contexto sintético barrado')
  }

  // ---- 5. Transporte falso, de ponta a ponta, e teto -------------------------
  {
    const cfg = { apiKey: 'falsa', model: 'x', baseUrl: 'https://api.deepseek.com', timeoutMs: 5000 }
    const p09 = casoPlano('p-09')
    const c35 = chat('c-35')
    const livro = livroSemGasto()
    const desinstala = instalaTransporte({
      modo: 'falso', hostPermitido: 'api.deepseek.com', livro,
      respostaFalsa: ctx => (ctx.tarefa === 'plano'
        ? JSON.stringify(planoDoOuro(p09.ouro.aceitos[0], hoje))
        : JSON.stringify(corpoOraculo(c35, hoje))),
    })
    try {
      const config = { id: 'T', rotulo: 'teste', modelo: 'deepseek-flash', pensamento: 'desligado' as const }
      const ctxPlano: ContextoAvaliacao = { config, caso: 'p-09', rep: 1, tarefa: 'plano', registros: [], origemVerificada: true }
      const http = await contextoAvaliacao.run(ctxPlano, () => handleAssistantRequest(
        { task: 'plan-query', message: p09.mensagem, context: planningContext(est('autonomo')) }, cfg))
      const rp = pontuaPlano({ elegivelRemoto: true, caso: p09, config: 'T', rep: 1, state: est('autonomo'), hoje, http, registros: ctxPlano.registros })
      confere('transporte falso: planejador de ponta a ponta', rp.planoSemantico && ctxPlano.registros.length === 1 ? null : `semântico=${rp.planoSemantico} chamadas=${ctxPlano.registros.length}`)

      const stOther = est('other')
      const ctxChat: ContextoAvaliacao = { config, caso: 'c-35', rep: 1, tarefa: 'chat', registros: [], origemVerificada: true }
      const contextoC35 = buildAiContext(stOther, { aggregates: remoteNeedsAggregates(c35.mensagem) })
      const httpChat = await contextoAvaliacao.run(ctxChat, () => handleAssistantRequest(
        { message: c35.mensagem, context: contextoC35 }, cfg))
      const rc = pontuaChat({ elegivelRemoto: true, caso: c35, config: 'T', rep: 1, state: stOther, hoje, contexto: contextoC35, http: httpChat, registros: ctxChat.registros })
      confere('transporte falso: chat de ponta a ponta, com o prompt real passando no guarda', !livro.bloqueio && rc.acoesCasadas === 1 && !rc.perigos.length
        ? null : `bloqueio=${livro.bloqueio} casadas=${rc.acoesCasadas} perigos=${JSON.stringify(rc.perigos)}`)

      let fora = false
      try { await contextoAvaliacao.run(ctxPlano, () => fetch('https://exemplo.invalid/x', { method: 'POST', body: '{}' })) } catch (e) { fora = e instanceof BloqueioPrivacidade }
      confere('transporte: host fora da lista', fora ? null : 'não bloqueou')
      let semCaso = false
      try { await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' }) } catch (e) { semCaso = e instanceof BloqueioPrivacidade }
      confere('transporte: requisição fora de um caso', semCaso ? null : 'não bloqueou')
      let semOrigem = false
      try {
        await contextoAvaliacao.run({ ...ctxPlano, origemVerificada: false, registros: [] },
          () => fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' }))
      } catch (e) { semOrigem = e instanceof BloqueioPrivacidade }
      confere('transporte: caso sem origem verificada', semOrigem ? null : 'não bloqueou')
    } finally {
      desinstala()
    }

    // REPLAY de bateria gravada: a gravação volta como foi — inclusive a falha.
    // Um corpo cortado no meio ("terminated") tem status 200 E erro: tratá-lo
    // como resposta vazia inventava um retry que a bateria nunca fez.
    {
      const config = { id: 'T', rotulo: 'teste', modelo: 'deepseek-flash', pensamento: 'desligado' as const }
      const grav = (x: Partial<import('./transport').RegistroHttp>): any => ({
        config: 'T', caso: 'p-09', rep: 1, tarefa: 'plano', tentativa: 1, inicio: '', ms: 1234, status: 200,
        uso: { entrada: 7, cacheHit: 0, cacheMiss: 7, saida: 3, raciocinio: 0 }, custoUSD: 0.5,
        caracteresEntrada: 1, conteudo: '{"version":2,"source":"none"}', raciocinioCaracteres: 0, ...x,
      })
      const chama = async (g: any) => {
        const livroR = livroSemGasto()
        const des = instalaTransporte({ modo: 'falso', hostPermitido: 'api.deepseek.com', livro: livroR, gravado: () => g })
        const ctx: ContextoAvaliacao = { config, caso: 'p-09', rep: 1, tarefa: 'plano', registros: [], origemVerificada: true }
        let falhou = false
        try {
          await contextoAvaliacao.run(ctx, () => fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{"messages":[]}' }))
        } catch { falhou = true } finally { des() }
        return { falhou, reg: ctx.registros[0] }
      }
      const ok = await chama(grav({}))
      confere('replay: devolve o conteúdo, a latência e o custo gravados',
        !ok.falhou && ok.reg?.conteudo === '{"version":2,"source":"none"}' && ok.reg.ms === 1234 && ok.reg.custoUSD === 0.5
          ? null : JSON.stringify(ok))
      confere('replay: falha de rede gravada falha de novo', (await chama(grav({ status: 0, erro: 'fetch failed', conteudo: '' }))).falhou ? null : 'virou resposta')
      confere('replay: corpo cortado (200 + erro) falha, não vira vazio', (await chama(grav({ erro: 'terminated', conteudo: '' }))).falhou ? null : 'virou resposta vazia')
      confere('replay: chamada sem gravação falha, nunca é inventada', (await chama(undefined)).falhou ? null : 'inventou resposta')
    }

    let redeTocada = 0
    const guardado = globalThis.fetch
    ;(globalThis as any).fetch = async () => { redeTocada++; return new Response('{}', { status: 200 }) }
    const apertado = { tetoUSD: 0.000001, gastoUSD: 0, reservadoUSD: 0, chamadasReais: 0 } as ReturnType<typeof livroSemGasto>
    const desinstala2 = instalaTransporte({ modo: 'real', hostPermitido: 'api.deepseek.com', livro: apertado })
    try {
      const ctx: ContextoAvaliacao = { config: { id: 'T', rotulo: 't', modelo: 'deepseek-flash', pensamento: 'desligado' }, caso: 'p-09', rep: 1, tarefa: 'plano', registros: [], origemVerificada: true }
      await contextoAvaliacao.run(ctx, () => handleAssistantRequest(
        { task: 'plan-query', message: p09.mensagem, context: planningContext(est('autonomo')) }, cfg))
      confere('teto: nenhuma chamada sai acima do teto', redeTocada === 0 && /teto/.test(apertado.bloqueio || '')
        ? null : `rede tocada ${redeTocada}x, bloqueio=${apertado.bloqueio}`)
    } finally {
      desinstala2()
      globalThis.fetch = guardado
    }
  }

  // ---- 6. Preço -----------------------------------------------------------
  const domingo = new Date(Date.UTC(2026, 8, 13, 15))
  const segunda = new Date(Date.UTC(2026, 8, 14, 7))
  const uso = (hit: number, miss: number, saida: number, raciocinio = 0) => ({ entrada: hit + miss, cacheHit: hit, cacheMiss: miss, saida, raciocinio })
  const perto = (a: number, b: number) => Math.abs(a - b) < 1e-9
  confere('preço: domingo é fora do pico', ehPico(domingo) ? 'marcou pico' : null)
  confere('preço: segunda 07h UTC é pico', ehPico(segunda) ? null : 'não marcou')
  confere('preço: flash fora do pico', perto(custoUSD('deepseek-flash', uso(1e6, 1e6, 1e6), domingo), 0.003 + 0.15 + 0.60) ? null : 'conta errada')
  confere('preço: pro no pico', perto(custoUSD('deepseek-v4-pro', uso(1e6, 1e6, 1e6), segunda), 0.044 + 1.32 + 3.96) ? null : 'conta errada')
  confere('preço: raciocínio maior que a saída é somado', perto(custoUSD('deepseek-flash', uso(0, 0, 100, 1000), domingo), (1100 * 0.60) / 1e6) ? null : 'não somou')

  // ---- 7. Rotas OBSERVADAS ---------------------------------------------------
  const frases: CasoDeFrase[] = [...CASOS_PLANO, ...CASOS_CHAT, ...CASOS_CENARIO]
  let remotas = 0
  if (opts.rotas !== false) {
    // O rótulo humano do corpus é uma foto de meio de mês. No dia 1, “dia 5”
    // pode ser resolvido localmente sem mudar o contrato do modelo; o teste de
    // alinhamento da foto usa sempre o mesmo calendário, enquanto o restante
    // do oráculo continua exercitando o dia real.
    const routeDay = '2026-09-15'
    const obs = await observaCorpus(frases, p => ESTADOS[p](routeDay), routeDay)
    const resumo = resumoRoteamento(obs.values())
    remotas = resumo.remotoElegivel
    const divergentes = [...obs.values()]
      .filter(o => o.remoteRequested !== (o.rotulo === 'remota'))
      .map(o => `${o.id} (rótulo ${o.rotulo}, medido ${o.remoteRequested ? 'remota' : 'local'})`)
    // O rótulo é diagnóstico e pode envelhecer. Ele NÃO decide nada: esta
    // verificação existe para o corpus avisar quando ficou desatualizado, não
    // para a elegibilidade depender dele.
    confere('rótulo de rota não divergiu da medição', divergentes.length ? divergentes.join(', ') : null)
    confere('classificação cobre o corpus inteiro',
      resumo.localCorreto + resumo.localFalha + resumo.remotoElegivel === frases.length
        ? null : `${resumo.total} classificados de ${frases.length}`)

    // ---- 8. Elegibilidade do benchmark ---------------------------------------
    //
    // A pergunta paga é "quando o modelo pôde influenciar, qual configuração foi
    // melhor?". Tudo aqui defende esse denominador.

    // Caso 1 — o pipeline fecha a frase localmente e não chama o transporte.
    const localFechado = [...obs.values()].filter(o => !o.remoteRequested)
    confere('caso 1: frase resolvida no aparelho não é elegível',
      localFechado.every(o => o.classe !== 'remoto-elegivel' && o.localResolvedBeforeRemote && o.requestCount === 0)
        ? null : 'há frase sem requisição marcada como elegível')
    confere('caso 1: frase resolvida no aparelho fica fora do corpus pago',
      localFechado.filter(o => noCorpusPago(o, 'pago')).map(o => o.id).join(', ') || null)

    // Caso 2 — o transporte é chamado: entra no benchmark.
    const chegam = [...obs.values()].filter(o => o.remoteRequested)
    confere('caso 2: frase que chama o transporte é elegível',
      chegam.every(o => o.classe === 'remoto-elegivel' && noCorpusPago(o, 'pago') && o.requestCount > 0)
        ? null : 'frase com requisição ficou fora do benchmark')

    // Caso 5 — rótulo manual diz `local-errada`, mas a requisição acontece.
    // Medido de verdade: a mensagem de um caso que HOJE chega ao remoto, com o
    // rótulo trocado à mão. Quem manda é a execução.
    const queChega = frases.find(c => obs.get(c.id)!.remoteRequested)!
    const rotuloMentiroso = await observaCaso({ ...queChega, rota: 'local-errada' } as CasoDeFrase, est(queChega.perfil), hoje)
    confere('caso 5: rótulo `local-errada` não derruba um caso que chega ao remoto',
      rotuloMentiroso.remoteRequested && rotuloMentiroso.classe === 'remoto-elegivel' && noCorpusPago(rotuloMentiroso, 'pago')
        ? null : 'o rótulo venceu a medição')

    // Caso 6 — rótulo manual diz `remota`, mas nenhuma requisição acontece.
    const queNaoChega = frases.find(c => !obs.get(c.id)!.remoteRequested)!
    const rotuloOtimista = await observaCaso({ ...queNaoChega, rota: 'remota' } as CasoDeFrase, est(queNaoChega.perfil), hoje)
    confere('caso 6: rótulo `remota` não promove um caso que morre no aparelho',
      !rotuloOtimista.remoteRequested && rotuloOtimista.classe !== 'remoto-elegivel' && !noCorpusPago(rotuloOtimista, 'pago')
        ? null : 'o rótulo venceu a medição')

    // O modo `fronteira` existe e continua pago — mas é OUTRA pergunta.
    const umaFronteira = [...obs.values()].find(o => o.classe === 'local-falha')
    if (umaFronteira) {
      confere('fronteira é opt-in e nunca entra no corpus pago padrão',
        !noCorpusPago(umaFronteira, 'pago') && noCorpusPago(umaFronteira, 'fronteira') ? null : 'modos de corpus trocados')
    }
  }

  // ---- 8b. Denominador, fallback, retry e justiça ------------------------------
  {
    const exec = (over: Partial<ResultadoCaso>): ResultadoCaso => ({
      config: 't', caso: 'x', suite: 'plano', dimensao: 'consulta-nova', perfil: 'autonomo',
      rota: 'remota', elegivelRemoto: true, rep: 1, chamadasLogicas: 1,
      contratoInvalido: false, acoesEsperadas: 0, acoesAceitas: 0, acoesRejeitadas: 0, acoesCasadas: 0,
      camposCertos: 0, camposConferidos: 0, planoValido: true, planoSemantico: true,
      perigos: [], numerosSemLastro: [], entidadesInventadas: [], observacoes: [],
      ms: 500, chamadasHttp: 1, tokensEntrada: 100, tokensSaida: 10, tokensRaciocinio: 0, custoUSD: 0.001,
      ...over,
    })

    // Caso 1 (métrica): inelegível não entra no denominador da NOTA do modelo.
    const misto = [
      exec({ caso: 'elegivel', elegivelRemoto: true, planoSemantico: true }),
      exec({ caso: 'local', elegivelRemoto: false, planoSemantico: false, perigos: [{ tipo: 'modalidade', detalhe: 'erro do parser local' }] }),
    ]
    const nota = metricasDoModelo('t', misto)
    confere('caso 1: execução inelegível fica fora do denominador do modelo',
      nota.execucoes === 1 && nota.queryPlanSemantic === 1 && nota.perigosTotal === 0
        ? null : `execuções ${nota.execucoes}, plano ${nota.queryPlanSemantic}, perigos ${nota.perigosTotal}`)
    confere('caso 1: o caso local não some do relatório do app',
      calculaMetricas('t', misto).execucoes === 2 ? null : 'o relatório geral perdeu o caso local')

    // Caso 3 — remoto chamado, saída inútil, fallback local salva a UX.
    const comFallback = [exec({ caso: 'fallback', falhaRemota: 'contrato inválido', fallbackLocal: true, planoSemantico: true })]
    const mf = metricasDoModelo('t', comFallback)
    confere('caso 3: fallback local não perdoa a falha do remoto',
      mf.remoteFailureRate === 1 && mf.transportFailureRate === 0
        ? null : `remoteFailure ${mf.remoteFailureRate}, transportFailure ${mf.transportFailureRate}`)
    const comSucesso = [exec({ caso: 'fallback' })]
    confere('caso 3: a nota cai quando o remoto falhou e o local salvou',
      pontuaEOrdena([metricasDoModelo('falhou', comFallback), metricasDoModelo('ok', comSucesso)])[0].config === 'ok'
        ? null : 'a falha remota ficou invisível na nota')

    // Caso 4 — retry: um caso lógico, N tentativas HTTP, custo e latência somam.
    const reg = (turno: number | undefined, tarefa: 'chat' | 'plano', ms: number, custo: number): any =>
      ({ config: 't', caso: 'x', rep: 1, turno, tarefa, tentativa: 1, inicio: '', ms, status: 200, uso: { entrada: 10, cacheHit: 0, cacheMiss: 10, saida: 5, raciocinio: 0 }, custoUSD: custo, caracteresEntrada: 10, conteudo: '', raciocinioCaracteres: 0 })
    const comRetry = [reg(undefined, 'chat', 700, 0.001), reg(undefined, 'chat', 900, 0.001)]
    const cc = contagemDeChamadas(comRetry)
    confere('caso 4: retry é uma chamada lógica e duas tentativas HTTP',
      cc.logicas === 1 && cc.http === 2 && cc.retries === 1 ? null : JSON.stringify(cc))
    confere('caso 4: dois caminhos no mesmo turno são duas chamadas lógicas',
      chamadasLogicas([reg(1, 'chat', 10, 0), reg(1, 'plano', 10, 0)]) === 2 ? null : 'caminhos diferentes colapsaram')
    const t4 = resumoTransporte([exec({ chamadasLogicas: 1, chamadasHttp: 2, ms: 1600, custoUSD: 0.002 })])
    confere('caso 4: custo e latência contam as tentativas, o denominador não',
      t4.chamadasLogicas === 1 && t4.tentativasHttp === 2 && t4.retries === 1 && t4.custoUSD === 0.002
        ? null : JSON.stringify(t4))

    // Caso 7 — justiça: duas configurações sobre o MESMO conjunto elegível.
    const conjunto = (config: string) => [
      exec({ config, caso: 'a', elegivelRemoto: true }),
      exec({ config, caso: 'b', elegivelRemoto: true }),
      exec({ config, caso: 'c', elegivelRemoto: false }),
    ]
    confere('caso 7: denominadores idênticos entre configurações',
      divergenciaDeDenominador(conjunto('A'), conjunto('B')).length === 0 ? null : 'denominadores diferentes sem motivo')
    const torto = [...conjunto('B').slice(0, 1), exec({ config: 'B', caso: 'z', elegivelRemoto: true })]
    confere('caso 7: denominador diferente é DETECTADO',
      divergenciaDeDenominador(conjunto('A'), torto).length ? null : 'a divergência passou despercebida')
  }

  // ---- 9. Proveniência do número --------------------------------------------
  //
  // A nota de alucinação do MODELO só lê o que o modelo escreveu. Na primeira
  // bateria paga (19/09/2026, C, k-04#5) o planejador remoto devolveu um plano,
  // o aparelho executou e compôs "Sexta-feira, com R$ 1.514,00 (dado real)" — e
  // o detector acusou esses números reais como invenção do modelo. A regra 53
  // não muda: o que o modelo ESCREVE sem lastro continua sendo alucinação.
  {
    const st = est('motorista')
    const ouroTurno = { mensagem: 'e qual dia da semana rende mais?' }
    const regT = (tarefa: 'chat' | 'plano'): any =>
      ({ config: 't', caso: 'x', rep: 1, turno: 1, tarefa, tentativa: 1, inicio: '', ms: 10, status: 200, uso: { entrada: 1, cacheHit: 0, cacheMiss: 1, saida: 1, raciocinio: 0 }, custoUSD: 0, caracteresEntrada: 1, conteudo: '', raciocinioCaracteres: 0 })
    const turno = (x: { reply: string; registros: any[]; textoRemoto?: string; falhaRemota?: string; contexto?: any; gabarito?: any; actions?: any[] }) => pontuaTurno({
      id: 'prov', config: 't', rep: 1, turno: 1, perfil: 'motorista', gabarito: x.gabarito || ouroTurno, state: st, hoje,
      resposta: { reply: x.reply, mode: 'answer', actions: x.actions || [] }, contexto: x.contexto || {}, mensagensAnteriores: [],
      registros: x.registros, falhaRemota: x.falhaRemota, textoRemoto: x.textoRemoto,
    })
    const numerica = (r: ResultadoCaso) => r.perigos.some(p => p.tipo === 'alucinacao-numerica')
    // A — plano remoto, número calculado e composto no aparelho
    const a = turno({ reply: 'Sexta-feira, com R$ 1.234,00 (dado real).', registros: [regT('plano')], textoRemoto: '' })
    confere('proveniência A: número do executor local não é alucinação do modelo', numerica(a) ? JSON.stringify(a.perigos) : null)
    confere('proveniência A: plano, resultado local e compositor separados',
      ['remote-plan', 'local-query-result', 'deterministic-composer'].every(x => a.provenienciaNumerica?.includes(x as any))
        ? null : JSON.stringify(a.provenienciaNumerica))
    // B — o modelo escreve um número sem lastro
    const b = turno({ reply: 'Você fez R$ 1.234,00 na sexta.', registros: [regT('chat')], textoRemoto: 'Você fez R$ 1.234,00 na sexta.' })
    confere('proveniência B: número inventado pelo modelo continua alucinação', numerica(b) ? null : 'não acusou')
    // C — número que o contexto enviado permite
    const c = turno({ reply: 'Você fez R$ 1.234,00 na sexta.', registros: [regT('chat')], textoRemoto: 'Você fez R$ 1.234,00 na sexta.', contexto: { sexta: 1234 } })
    confere('proveniência C: número com lastro no contexto não é alucinação', numerica(c) ? JSON.stringify(c.perigos) : null)
    // D — o remoto falhou; o número real veio do fallback local
    const d = turno({ reply: 'Nos últimos 7 dias você fez R$ 1.234,00 (dado real).', registros: [regT('chat')], textoRemoto: '', falhaRemota: 'chat remoto sem resposta utilizável' })
    confere('proveniência D: número do fallback local não é do modelo', numerica(d) ? JSON.stringify(d.perigos) : null)
    confere('proveniência D: a falha remota continua registrada', d.falhaRemota && d.provenienciaNumerica?.includes('fallback-local')
      ? null : `${d.falhaRemota} · ${JSON.stringify(d.provenienciaNumerica)}`)
    // E — valor errado na AÇÃO proposta pelo modelo continua erro do modelo
    const e = turno({
      reply: 'Confira.', registros: [regT('chat')], textoRemoto: 'Confira.',
      gabarito: { mensagem: 'gastei 50 no mercado', acoes: [acao('expense', { amount: 50 })] },
      actions: [{ action: { kind: 'expense', amount: 500, category: 'alimentacao' } }],
    })
    confere('proveniência E: valor errado na ação do modelo continua perigo', e.perigos.length ? null : 'sem perigo')
    const casoPlano = CASOS_PLANO.find(x => x.id === 'p-09')!
    const planoErrado = { ...planoDoOuro(casoPlano.ouro.aceitos[0], hoje), order: 'ordem-inventada' }
    const ep = pontuaPlano({
      elegivelRemoto: true, caso: casoPlano, config: 't', rep: 1, state: est(casoPlano.perfil), hoje,
      http: { status: 200, body: { queryPlan: planoErrado } }, registros: [regT('plano')],
    })
    confere('proveniência E: plano remoto inválido continua erro do modelo',
      ep.contratoInvalido && ep.planoValido === false && ep.provenienciaNumerica?.includes('remote-plan') ? null : JSON.stringify(ep))
    // F — resposta mista: só o trecho do modelo é julgado
    const f = turno({ reply: 'Hoje: R$ 999,00 (dado real). Você fez R$ 1.234,00 na sexta.', registros: [regT('chat')], textoRemoto: 'Você fez R$ 1.234,00 na sexta.' })
    confere('proveniência F: na resposta mista, só o número do modelo é julgado',
      f.numerosSemLastro.join() === 'R$ 1.234,00' ? null : f.numerosSemLastro.join() || 'nada acusado')
  }

  const casos = CASOS_PLANO.length + CASOS_CHAT.length + CASOS_CENARIO.length + CASOS_CONTINUIDADE.length
  rel.resumo.push(
    `${casos} casos (${CASOS_PLANO.length} planejador · ${CASOS_CHAT.length} chat · ${CASOS_CENARIO.length} cenário · ${CASOS_CONTINUIDADE.length} conversas com ${CASOS_CONTINUIDADE.reduce((a, c) => a + c.turnos.length, 0)} turnos)`,
    `${leituras} leituras aceitas no planejador · ${opts.rotas !== false ? `${remotas} frases chegam hoje ao modelo remoto` : 'rotas não medidas'}`,
  )
  return rel
}
