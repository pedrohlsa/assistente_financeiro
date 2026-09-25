// INVARIANTES DO CANAL REMOTO — quando o aparelho cede a vez, e o que sai dele.
//
// A pré-checagem de rotas da avaliação dos modelos remotos (docs/AI_REMOTE_EVAL.md
// §10) achou frases que o motor local respondia ERRADO e que, por responder,
// nunca chegavam a quem sabia lê-las. Cada invariante aqui vale para uma CLASSE
// gerada de frases, não para as três que revelaram o defeito:
//
//   · o número do período nunca vira valor;
//   · a magnitude dita ("3 mil", "4k") nunca some;
//   · o depósito em meta nunca vira despesa;
//   · a leitura local suspeita não fecha a frase — o remoto participa;
//   · o remoto recebe só o trecho que ficou em aberto.

import type { AppState, ParsedAction } from '../../src/models/types'
import { buildState, TODAY } from './harness'
import { orchestrate } from '../../src/assistant/orchestrator'
import type { OrchestratorInput } from '../../src/assistant/orchestrator'
import { remoteNeedsAggregates } from '../../src/assistant/orchestrator'
import { analyzeMessage } from '../../src/assistant/clauses'
import { classifyLocalDecision, suspicionReasons } from '../../src/assistant/semantic/confidence'
import type { SuspicionInput, SuspicionReason } from '../../src/assistant/semantic/confidence'
import { normalizeRemoteConversation } from '../../src/assistant/conversation/remoteContext'
import { remoteBridge } from '../../src/services/ai'
import { handleAssistantRequest } from '../../api/_lib/assistantHandler'
import { fmtBRL } from '../../src/utils/format'
import { isQueryFailure, validateQueryPlan } from '../../src/assistant/query/validate'
import { isEnvelopeFailure, validateRemoteEnvelope } from '../../src/assistant/contracts'
import { alegacaoFalsa } from './eval/score'
import { mensagemDaExecucao } from '../../src/assistant/claims'
import { callDeepSeekChat, DEEPSEEK_DEFAULT_MODEL, getDeepSeekConfig, isDeepSeekFailure } from '../../api/_lib/deepseek'

export interface PropertyReport { total: number; failures: string[] }

const check = (r: PropertyReport, name: string, fn: () => string | null) => {
  r.total++
  try {
    const err = fn()
    if (err) r.failures.push(`${name}: ${err}`)
  } catch (e: any) {
    r.failures.push(`${name}: exceção ${e?.message || e}`)
  }
}

const checkAsync = async (r: PropertyReport, name: string, fn: () => Promise<string | null>) => {
  r.total++
  try {
    const err = await fn()
    if (err) r.failures.push(`${name}: ${err}`)
  } catch (e: any) {
    r.failures.push(`${name}: exceção ${e?.message || e}`)
  }
}

const valorDe = (a: ParsedAction): number | undefined => (a as any).amount ?? (a as any).total ?? (a as any).cost

interface Gravado { plano: number; chat: number; mensagens: string[] }

/** O orquestrador real, com os dois caminhos remotos trocados por gravadores. */
async function roda(state: AppState, message: string, extra: Partial<OrchestratorInput> = {}) {
  const remoto: Gravado = { plano: 0, chat: 0, mensagens: [] }
  const out = await orchestrate({
    state, message, remoteEnabled: true, today: TODAY,
    askRemote: async args => { remoto.chat++; remoto.mensagens.push(args.message); return null },
    planRemoteQuery: async () => { remoto.plano++; return null },
    ...extra,
  })
  return { out, remoto }
}

export async function runRemoteProperties(): Promise<PropertyReport> {
  const r: PropertyReport = { total: 0, failures: [] }

  // --- 108. O número do período nunca vira valor ------------------------
  await checkAsync(r, 'pergunta com período nunca vira lançamento com o número do período', async () => {
    const MODELOS = [
      'quanto gastei nos últimos {n} {u}', 'qnto q foi d obra nos ultimo {n} {u}', 'obra {n} {u} quanto',
      'qual foi meu maior gasto em {n} {u}', 'quanto de mercado nos últimos {n} {u}?', 'qnt deu de luz em {n} {u}',
    ]
    let geradas = 0
    for (const perfil of ['autonomo', 'clt', 'driver'] as const) {
      const s = buildState({ profile: perfil })
      for (const m of MODELOS) {
        for (const num of [2, 3, 6, 12, 90]) {
          for (const u of ['dias', 'semanas', 'meses']) {
            const frase = m.replace('{n}', String(num)).replace('{u}', u)
            geradas++
            const { out } = await roda(s, frase)
            // Tipado à parte: em `mode: 'answer'` o envelope declara `actions: []`.
            const acoes: { action: ParsedAction }[] = out.response.actions
            const errada = acoes.find(a => valorDe(a.action) === num)
            if (errada) return `"${frase}" (${perfil}) propôs ${errada.action.kind} de ${num}`
          }
        }
      }
    }
    return geradas ? null : 'nenhuma frase gerada'
  })

  // --- 109. Os critérios de suspeita acusam o errado e poupam o certo ----
  check(r, 'critérios de suspeita acusam a leitura errada e poupam a certa', () => {
    const q = (text: string, isQuestion: boolean, hasPastMoneyVerb: boolean, normalized = text): SuspicionInput =>
      ({ text, normalized, isQuestion, hasPastMoneyVerb })
    const casos: [ParsedAction, SuspicionInput, SuspicionReason | null][] = [
      [{ kind: 'expense', amount: 3, category: 'obra' } as ParsedAction, q('qnto q foi d obra nos ultimo 3 mes', true, false), 'valor-de-periodo'],
      [{ kind: 'expense', amount: 3 } as ParsedAction, q('comprei uma tv de 3 mil', false, true), 'magnitude-perdida'],
      [{ kind: 'expense', amount: 200, description: 'Meta' } as ParsedAction, q('coloquei 200 na meta', false, true), 'meta-como-despesa'],
      [{ kind: 'expense', amount: 50, description: 'Mercado' } as ParsedAction, q('foi 50 de mercado?', true, false), 'pergunta-sem-fato'],
      // As leituras CERTAS não podem ser acusadas.
      [{ kind: 'expense', amount: 190, category: 'obra' } as ParsedAction, q('gastei 190 de cimento', false, true), null],
      [{ kind: 'income', amount: 1800 } as ParsedAction, q('recebi 1800 de aluguel dos 3 meses?', true, true), null],
      [{ kind: 'expense', amount: 3000 } as ParsedAction, q('gastei 3 mil de obra', false, true, 'gastei 3000 de obra'), null],
      [{ kind: 'saving', amount: 300 } as ParsedAction, q('guardei 300 na reserva', false, true), null],
      // Valor seguido de DATA não é duração. A primeira versão do critério acusava
      // estas frases e o corpus temporal perdia nove lançamentos legítimos.
      [{ kind: 'expense', amount: 100 } as ParsedAction, q('paguei 100 mês passado', false, true), null],
      [{ kind: 'expense', amount: 80 } as ParsedAction, q('gastei 80 semana passada', false, true), null],
      [{ kind: 'expense', amount: 40 } as ParsedAction, q('gastei 40 dia 5', false, true), null],
      [{ kind: 'expense', amount: 50 } as ParsedAction, q('gastei 50 dia 31/02', false, true), null],
    ]
    for (const [acao, entrada, esperado] of casos) {
      const motivos = suspicionReasons(acao, entrada)
      if (esperado ? !motivos.includes(esperado) : motivos.length) {
        return `"${entrada.text}": esperava ${esperado || 'nenhuma suspeita'}, veio ${motivos.join(', ') || 'nenhuma'}`
      }
    }
    return null
  })

  // --- 110. Leitura suspeita não fecha a frase ---------------------------
  await checkAsync(r, 'leitura local suspeita não fecha a frase: o remoto participa', async () => {
    const s = buildState({ profile: 'other' })
    for (const frase of ['foi 50 de mercado?', 'saiu 80 de luz?']) {
      const { out, remoto } = await roda(s, frase)
      if (out.response.actions.length) return `"${frase}" propôs ${out.response.actions.map(a => a.action.kind).join(', ')}`
      if (!remoto.plano && !remoto.chat) return `"${frase}" morreu no aparelho sem consultar o remoto`
      const decisao = classifyLocalDecision(analyzeMessage(frase, { today: TODAY }))
      if (decisao !== 'local-suspicious') return `"${frase}" classificada como ${decisao}`
    }
    return null
  })

  // --- 111. A magnitude dita nunca some ----------------------------------
  await checkAsync(r, 'magnitude dita nunca some: "N mil", "N,5 mil", "Nk" e "N mil e M"', async () => {
    const s = buildState({ profile: 'other' })
    const formas: [string, number][] = []
    for (const n of [2, 3, 4, 12, 150]) {
      formas.push(
        [`gastei ${n} mil de obra`, n * 1000],
        [`gastei ${n}k de obra`, n * 1000],
        [`gastei ${n},5 mil de obra`, n * 1000 + 500],
        [`gastei ${n} mil e 200 de obra`, n * 1000 + 200],
      )
    }
    for (const [frase, esperado] of formas) {
      const { out } = await roda(s, frase)
      const valores = out.response.actions.map(a => valorDe(a.action))
      if (valores.length !== 1 || Math.abs((valores[0] ?? NaN) - esperado) > 0.005) {
        return `"${frase}" → ${JSON.stringify(valores)} (esperava ${esperado})`
      }
    }
    for (const n of [3, 12]) {
      const frase = `e se eu comprar uma tv de ${n} mil em 10x`
      const { out } = await roda(s, frase)
      if (out.response.actions.length) return `"${frase}" virou lançamento`
      if (!out.response.reply.includes(fmtBRL(n * 1000))) return `"${frase}" não simulou ${fmtBRL(n * 1000)}: ${out.response.reply.slice(0, 120)}`
    }
    return null
  })

  // --- 112. Depósito em meta nunca vira despesa --------------------------
  await checkAsync(r, 'depósito em meta nunca vira despesa, e sem meta única o app pergunta', async () => {
    const estados: [string, AppState][] = [
      ['sem meta', buildState({ profile: 'clt' })],
      ['uma meta', buildState({ profile: 'clt', goals: [{ name: 'Moto', target: 10000 }] })],
      ['duas metas', buildState({ profile: 'clt', goals: [{ name: 'Moto', target: 10000 }, { name: 'Viagem', target: 5000 }] })],
    ]
    for (const verbo of ['coloquei', 'botei', 'joguei', 'mandei', 'guardei', 'depositei', 'transferi']) {
      for (const destino of ['na meta', 'pra meta', 'na minha meta']) {
        const frase = `${verbo} 200 ${destino}`
        for (const [nome, s] of estados) {
          const { out } = await roda(s, frase)
          const kinds = out.response.actions.map(a => a.action.kind)
          if (kinds.some(k => k !== 'goal-deposit')) return `"${frase}" (${nome}) propôs ${kinds.join(', ')}`
          if (nome === 'uma meta') {
            if (kinds.length !== 1 || (out.response.actions[0].action as any).name !== 'Moto') {
              return `"${frase}" com uma meta só não propôs o depósito nela`
            }
          } else if (kinds.length || out.response.mode !== 'clarify') {
            return `"${frase}" (${nome}) não perguntou em qual meta`
          }
        }
      }
    }
    return null
  })

  // --- 113. O remoto recebe só o que ficou em aberto ----------------------
  await checkAsync(r, 'o remoto recebe só o trecho que o aparelho não resolveu', async () => {
    const s = buildState({ profile: 'other' })
    const { out, remoto } = await roda(s, 'gastei 50 no mercado. me explica o que é CDI')
    if (!remoto.chat) return 'o trecho em aberto não foi ao remoto'
    const enviado = remoto.mensagens[0] || ''
    if (/gastei|mercado|\b50\b/i.test(enviado)) return `o trecho já resolvido foi reenviado: "${enviado}"`
    if (!/cdi/i.test(enviado)) return `o trecho em aberto não foi: "${enviado}"`
    if (out.response.actions.length !== 1) return `esperava a despesa local, veio ${out.response.actions.length} ação(ões)`
    return null
  })

  // =========================================================================
  // PRIVACIDADE — o que sai do aparelho (regra 44)
  // =========================================================================
  //
  // O estado carrega CANÁRIOS: descrição, origem, reserva, pagamento de fatura,
  // saldo e nome com valores e textos que não existem em lugar nenhum além dele.
  // A conversa passa pela MESMA ponte que a tela usa (`remoteBridge`) e pelo
  // MESMO servidor (`handleAssistantRequest`), com a rede trocada por um gravador
  // nas duas pontas: o que o aparelho manda ao servidor e o que o servidor manda à
  // DeepSeek.

  const segredos = [
    'Canário Restaurante', 'Canario Restaurante', 'Canário Kitnet', 'Rua Oculta', 'Canário Cofrinho', 'Fulana',
    '731.17', '731,17', '4412.39', '4.412,39', '777.77', '777,77', '8765.43', '8.765,43', '13579.24', '13.579,24',
  ]

  const estadoCanario = (): AppState => {
    const s = buildState({ profile: 'autonomo', goals: [{ name: 'Moto', target: 10000, saved: 2000 }], cards: [{ name: 'Nubank' }] })
    s.settings = { ...s.settings, name: 'Fulana Canário da Silva', balance: 13579.24, balanceAsOf: `${TODAY}T23:59` }
    s.transactions = [
      { id: 'x1', type: 'expense', amount: 731.17, category: 'alimentacao', description: 'Canário Restaurante Sigiloso', date: TODAY, time: '10:00' },
      { id: 'x2', type: 'income', amount: 4412.39, category: 'aluguel', description: 'Aluguel', origin: 'Canário Kitnet Rua Oculta 99', date: TODAY, time: '09:00' },
      { id: 'x3', type: 'saving', amount: 777.77, category: 'reserva', description: 'Canário Cofrinho Secreto', date: '2026-06-02', time: '09:00' },
    ] as any
    s.cardPayments = [{ id: 'cp1', cardId: 'card0', amount: 8765.43, date: '2026-05-10', fromBalance: false }] as any
    return s
  }

  /** Corpo serializado e, para a DeepSeek, o conteúdo de cada mensagem já sem escape. */
  const legivel = (corpo: string): string => {
    try {
      const j = JSON.parse(corpo)
      return [corpo, ...(Array.isArray(j?.messages) ? j.messages.map((m: any) => String(m?.content ?? '')) : [])].join('\n')
    } catch { return corpo }
  }

  const CFG_FALSA = { apiKey: 'falsa', model: 'x', baseUrl: 'https://deepseek.invalid', timeoutMs: 5000 }

  async function comRedeFalsa<T>(fn: () => Promise<T>): Promise<{ resultado: T; cliente: any[]; deepseek: string[] }> {
    const guardado = globalThis.fetch
    const cliente: any[] = []
    const deepseek: string[] = []
    ;(globalThis as any).fetch = async (url: any, init?: any) => {
      const corpo = String(init?.body ?? '{}')
      if (String(url).includes('/chat/completions')) {
        deepseek.push(corpo)
        const content = JSON.stringify({ version: 1, mode: 'answer', reply: 'Certo.', actions: [] })
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const body = JSON.parse(corpo)
      cliente.push(body)
      const out = await handleAssistantRequest(body, CFG_FALSA)
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } })
    }
    try {
      const resultado = await fn()
      return { resultado, cliente, deepseek }
    } finally {
      globalThis.fetch = guardado
    }
  }

  /** Várias mensagens encadeadas exatamente como `Chat.tsx` encadeia. */
  async function conversa(state: AppState, mensagens: string[]): Promise<string[]> {
    let focus: OrchestratorInput['focus']
    let pending: OrchestratorInput['pending']
    let clarification: OrchestratorInput['pendingClarification']
    let draft: OrchestratorInput['draft'] | null = null
    const respostas: string[] = []
    for (const m of mensagens) {
      const out = await orchestrate({
        state, message: m, draft: draft || undefined, pending, pendingClarification: clarification, focus,
        remoteEnabled: true, today: TODAY, ...remoteBridge(),
      })
      if (out.focus) focus = out.focus
      draft = out.draft
      pending = out.correctedPending ? out.correctedPending : out.response.actions.length ? out.response.actions : out.keepPending ? pending : undefined
      clarification = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
      respostas.push(out.response.reply)
    }
    return respostas
  }

  // --- 114. Nada do histórico sai, por nenhum caminho remoto ---------------
  await checkAsync(r, 'nada do histórico sai por nenhum caminho remoto, nas duas pontas', async () => {
    const { resultado: respostas, cliente, deepseek } = await comRedeFalsa(() => conversa(estadoCanario(), [
      'qual foi meu maior gasto em julho?',
      'qual meu saldo?',
      'me dá uma dica pra organizar isso',
      'quanto a kitnet rendeu esse ano e o que eu faço com esse dinheiro?',
    ]))
    // A invariante só mede alguma coisa se a conversa tiver PRODUZIDO resposta
    // local com dado sigiloso e depois chegado ao remoto.
    if (!respostas[0].includes('Canário Restaurante')) return `a 1ª resposta local não citou o lançamento — nada a proteger: "${respostas[0].slice(0, 80)}"`
    if (!respostas[1].includes('13.579,24')) return `a 2ª resposta local não citou o saldo — nada a proteger: "${respostas[1].slice(0, 80)}"`
    if (!cliente.some(c => !c.task) || !deepseek.length) return `a conversa não chegou ao chat remoto (cliente ${cliente.length}, deepseek ${deepseek.length})`
    const pontas: [string, string[]][] = [
      ['aparelho → servidor', cliente.map(c => JSON.stringify(c))],
      ['servidor → DeepSeek', deepseek.map(legivel)],
    ]
    for (const [onde, corpos] of pontas) {
      for (const corpo of corpos) {
        for (const s of segredos) if (corpo.includes(s)) return `${onde}: vazou "${s}"`
        if (/"history"\s*:/.test(corpo)) return `${onde}: levou o campo history`
        for (const anterior of respostas.slice(0, 2)) {
          if (corpo.includes(anterior.slice(0, 40))) return `${onde}: levou uma resposta local anterior`
        }
      }
    }
    return null
  })

  // --- 115. O que foi escrito NESTA mensagem pode sair ---------------------
  await checkAsync(r, 'o que o usuário escreveu nesta mensagem vai junto — sem isso o modelo não entende a pergunta', async () => {
    const { cliente } = await comRedeFalsa(() => conversa(estadoCanario(), ['me explica o que é CDI e se vale pra grana da Canário Kitnet']))
    const chat = cliente.find(c => !c.task)
    if (!chat) return 'a frase não chegou ao chat remoto'
    if (!String(chat.message).includes('Canário Kitnet')) return 'o nome dito na própria mensagem não foi junto'
    return null
  })

  // --- 116. O servidor fecha o vazamento de cliente antigo -----------------
  await checkAsync(r, 'o servidor descarta histórico e campos pessoais mandados por um app antigo', async () => {
    const corpoAntigo = {
      message: 'me ajuda a organizar minhas finanças',
      history: [{ role: 'assistant', text: 'Seu maior gasto foi R$ 731,17 no Canário Restaurante Sigiloso' }],
      context: {
        perfil: 'autonomo', nome: 'Fulana Canário da Silva', saldoEmConta: 13579.24,
        saldoVsContas7dias: { contasAVencer: 8765.43, cobreAsContas: true },
        proximasContas: [{ nome: 'Canário Kitnet Rua Oculta 99', valor: 4412.39, emDias: 3 }],
        parcelamentos: { ativos: 1, dividaRestante: 900, lista: [{ descricao: 'Canário Cofrinho Secreto', valorTotal: 777.77 }] },
        projecaoProximosMeses: [{ mes: '2026-08', entradasPrevistas: 100, saldoEstimado: 13579.24 }],
        veiculo: { modelo: 'Canário Restaurante', hodometro: 731.17 },
        esteMes: { receitas: 3000, despesas: 1200, lucro: 1800 },
        categorias: [{ id: 'alimentacao', name: 'Alimentação', type: 'expense' }],
      },
      conversation: {
        version: 1, topic: 'query', activePeriod: { label: 'R$ 731,17 no Canário' },
        activeFilters: { categories: ['alimentacao', 'Canário Restaurante'], freeTextFilter: 'Canário Restaurante' },
        extra: 'Fulana',
      },
    }
    const { deepseek } = await comRedeFalsa(() => handleAssistantRequest(corpoAntigo, CFG_FALSA))
    if (!deepseek.length) return 'o servidor não chamou o modelo'
    const texto = legivel(deepseek[0])
    for (const s of segredos) if (texto.includes(s)) return `o servidor repassou "${s}"`
    if (!texto.includes('"receitas":3000')) return 'o agregado permitido não passou — a lista de campos apagou demais'
    return null
  })

  // --- 117. A conversa remota só leva estrutura ---------------------------
  check(r, 'a conversa remota só leva estrutura do vocabulário do usuário, nunca texto nem valor', () => {
    const out = normalizeRemoteConversation({
      version: 1, topic: 'query', previousIntent: 'query-answered',
      activePeriod: { label: 'Seu saldo é R$ 13.579,24', grain: 'month' },
      activeQuery: { source: 'transactions', metric: 'sum; DROP', group: 'category' },
      activeFilters: {
        categories: ['obra', 'Canário Restaurante'], cardNames: ['nubank', 'Itaú Canário'], goalName: 'Moto',
        freeTextFilter: 'Canário Restaurante', originFilter: true,
      },
      pendingKinds: ['expense', 'R$ 731,17'], missingFields: ['amount', 'valor 731'], resolvedLocally: ['income'],
      history: ['x'], saldo: 13579.24,
    }, { categoryIds: ['alimentacao', 'obra'], cardNames: ['Nubank'], goalNames: ['Moto'] })
    const json = JSON.stringify(out)
    for (const s of ['13.579', '13579', 'Canário', 'Itaú', 'DROP', '731', 'history', 'saldo']) {
      if (json.includes(s)) return `deixou passar "${s}": ${json}`
    }
    if (out?.activeFilters?.cardNames?.[0] !== 'Nubank' || out?.activeFilters?.categories?.join() !== 'obra') {
      return `apagou o que era do vocabulário: ${json}`
    }
    if (out?.activeFilters?.freeTextFilter !== undefined) return 'freeTextFilter aceitou texto no lugar de verdadeiro'
    return null
  })

  // --- 118. Agregados só quando a frase precisa deles ----------------------
  await checkAsync(r, 'agregados do aparelho só vão quando o trecho é pergunta ou pedido', async () => {
    const { cliente: doRegistro } = await comRedeFalsa(() => conversa(buildState({ profile: 'clt' }), ['tirei 500 do cofrinho pra pagar a escola']))
    const chatRegistro = doRegistro.find(c => !c.task)
    if (!chatRegistro) return 'o registro não entendido não chegou ao chat remoto'
    if ('esteMes' in (chatRegistro.context || {})) return 'registro não entendido levou os agregados do mês'
    const { cliente: doPedido } = await comRedeFalsa(() => conversa(estadoCanario(), ['me ajuda a organizar minhas finanças']))
    const chatPedido = doPedido.find(c => !c.task)
    if (!chatPedido) return 'o pedido aberto não chegou ao chat remoto'
    if (!('esteMes' in (chatPedido.context || {}))) return 'o pedido aberto ficou sem os agregados que tornam a resposta útil'
    if (!remoteNeedsAggregates('tô conseguindo guardar o suficiente?')) return 'pergunta classificada como registro'
    if (remoteNeedsAggregates('paguei 320 de luz 180 de agua e a internet eu nao lembro')) return 'registro classificado como pergunta'
    return null
  })

  // --- 119. O planejador recebe só a pergunta e o vocabulário --------------
  await checkAsync(r, 'o planejador remoto recebe só a pergunta e o vocabulário', async () => {
    const { cliente } = await comRedeFalsa(() => conversa(estadoCanario(), ['quanto do que entrou esse mês veio de freelance']))
    const plano = cliente.find(c => c.task === 'plan-query')
    if (!plano) return 'a pergunta não chegou ao planejador remoto'
    const chaves = Object.keys(plano.context || {}).sort().join(',')
    if (chaves !== 'cartoes,categorias,metasDeCompra,perfil') return `contexto de planejamento com campos a mais: ${chaves}`
    if (/\d{3,}/.test(JSON.stringify(plano.context))) return 'o contexto de planejamento levou número'
    if (Object.keys(plano).some(k => !['task', 'message', 'context'].includes(k))) return `corpo com campo a mais: ${Object.keys(plano).join(',')}`
    return null
  })

  // --- 124. `null` em campo OPCIONAL do contrato remoto é "não especificado" -
  // A primeira bateria paga (19/09/2026) mostrou os três modelos mandando
  // `"order": null` num plano válido; o validador lia `null` como valor
  // desconhecido e recusava 27 de 29 planos — a frase caía no chat. A regra é
  // do CONTRATO, não do campo: todo opcional em que `null` só quer dizer "não
  // especificado" equivale a ausente; obrigatório `null` continua recusado;
  // nada perigoso, desconhecido ou de tipo errado passa por causa disso.
  check(r, 'null em campo opcional do contrato remoto equivale a ausente', () => {
    const st = buildState({ profile: 'other', cards: [{ name: 'Nubank' }] })
    const periodo = { from: '2026-07-01', to: '2026-07-15', label: 'julho', grain: 'range' }
    const base = { version: 2, source: 'transactions', period: periodo, filter: { txType: ['expense'] }, metric: 'sum', group: 'category' }
    const valida = (p: any) => validateQueryPlan(p, st, TODAY)
    const plano = (v: any) => (isQueryFailure(v) ? `recusado: ${v.code}${v.detail ? ` (${v.detail})` : ''}` : JSON.stringify(v.plan))
    const ausente = plano(valida(base))
    if (ausente.startsWith('recusado')) return `plano-base ${ausente}`
    // 1–3: ausente, null e válido
    if (plano(valida({ ...base, order: null })) !== ausente) return `order null ≠ ausente: ${plano(valida({ ...base, order: null }))}`
    const comOrdem = valida({ ...base, order: 'value-desc' })
    if (isQueryFailure(comOrdem) || comOrdem.plan.order !== 'value-desc') return 'order válido não foi preservado'
    // 8: a mesma classe nos outros opcionais — cada um sozinho, e todos juntos
    const opcionais = ['version', 'field', 'metric', 'group', 'order', 'comparePeriod', 'filter', 'limit', 'shareBase', 'label']
    const semEles = { source: 'transactions', period: periodo }
    for (const k of opcionais) {
      const got = plano(valida({ ...semEles, [k]: null }))
      if (got !== plano(valida(semEles))) return `${k}: null ≠ ausente (${got})`
    }
    const filtros = ['categories', 'excludeCategories', 'txType', 'cardNames', 'excludeCardNames', 'goalName', 'text', 'excludeText',
      'origin', 'platform', 'profileAtCreation', 'status', 'realizedOnly', 'plannedOnly', 'weekdays', 'monthHalf', 'minAmount', 'maxAmount']
    for (const k of filtros) {
      const got = plano(valida({ ...semEles, filter: { [k]: null } }))
      if (got !== plano(valida(semEles))) return `filter.${k}: null ≠ ausente (${got})`
    }
    // `weekdays: null` virava Number(null) = 0: um filtro de DOMINGO.
    const dom = valida({ ...semEles, filter: { weekdays: [null] } })
    if (!isQueryFailure(dom) && dom.plan.filter.weekdays?.includes(0)) return 'weekdays [null] virou domingo'
    // 4: enum desconhecido continua recusado (e string vazia não é "não especificado")
    for (const [k, v] of [['order', 'aleatorio'], ['order', ''], ['metric', 'exec'], ['group', 'senha'], ['field', 7]] as const) {
      if (!isQueryFailure(valida({ ...base, [k]: v }))) return `${k}=${JSON.stringify(v)} foi ACEITO`
    }
    // 5 e 9: obrigatório null continua recusado
    for (const k of ['source', 'period']) {
      if (!isQueryFailure(valida({ ...base, [k]: null }))) return `${k} null foi ACEITO`
    }
    if (!isQueryFailure(valida({ ...base, period: { ...periodo, from: null } }))) return 'period.from null foi ACEITO'
    if (!isQueryFailure(valida(null))) return 'plano null foi ACEITO'
    // 6: chave perigosa continua barrada, com ou sem null por perto
    for (const json of ['{"source":"transactions","order":null,"__proto__":{"x":1}}', '{"source":"transactions","filter":{"constructor":null}}']) {
      const v = valida(JSON.parse(json))
      if (!isQueryFailure(v) || v.code !== 'dangerous-key') return `chave perigosa não barrada: ${json}`
    }
    // 7: campo desconhecido continua sem entrar no plano
    const extra = valida({ ...base, order: null, sql: 'drop', filter: { txType: ['expense'], campoNovo: null } })
    if (isQueryFailure(extra) || 'sql' in extra.plan || 'campoNovo' in extra.plan.filter) return 'campo desconhecido entrou no plano'
    // Envelope do chat: mesma regra
    const env = (d: any) => validateRemoteEnvelope(d)
    const okEnv = env({ reply: 'oi', version: null, actions: null, mode: null, clarification: null })
    if (isEnvelopeFailure(okEnv)) return `envelope com opcionais null recusado: ${okEnv.reason}`
    if (okEnv.rawActions.length || okEnv.mode !== 'answer') return 'envelope com null mudou de sentido'
    if (!isEnvelopeFailure(env({ reply: null, actions: [] }))) return 'reply null foi ACEITO'
    if (!isEnvelopeFailure(env({ reply: 'oi', actions: 'x' }))) return 'actions de tipo errado foi ACEITO'
    return null
  })

  // --- 125. Plano remoto com `order: null` é EXECUTADO, não descartado ----
  // O efeito em produção: o plano era recusado, e a pergunta ia ao chat — que
  // não calcula nada. De ponta a ponta, pelo orquestrador.
  await checkAsync(r, 'plano remoto com order null é executado no aparelho', async () => {
    const st = buildState({ profile: 'other' })
    const hoje = TODAY
    let pedidos = 0
    const { out, remoto } = await roda(st, 'compara o que eu gastei na primeira quinzena com a segunda quinzena desse mês', {
      today: hoje,
      planRemoteQuery: async () => (pedidos++, {
        version: 2, source: 'transactions', field: 'amount', metric: 'sum', group: 'category', order: null,
        comparePeriod: null, limit: 5, period: { from: `${hoje.slice(0, 8)}01`, to: hoje, label: 'este mês', grain: 'range' },
        filter: { txType: ['expense'] },
      }),
    })
    if (!pedidos) return 'a pergunta nem chegou ao planejador remoto'
    if (remoto.chat) return `o plano foi descartado e a pergunta foi ao chat: "${out.response.reply.slice(0, 100)}"`
    if ((out.response as any).engine !== 'hybrid') return `resposta não veio do plano remoto (engine ${(out.response as any).engine})`
    return null
  })

  // --- 126. Plano remoto não rebaixa a modalidade explícita do turno --------
  // "Vou receber 1800 da casa 1 dia 5": A e B devolveram, nas 3 repetições, um
  // plano de consulta sobre lançamentos REALIZADOS, e o app respondia "Total
  // setembro: R$ 1.800,00 (dado real)" — o futuro virava fato. Mesma classe:
  // negação ("não foi 500 na obra"), retratação e conta que se repete. O que o
  // usuário disse ganha do que o modelo leu. Contraste: consulta sobre o que
  // VAI vencer continua respondida, porque a fonte é de previsão.
  await checkAsync(r, 'plano remoto factual não atropela futuro, negação ou recorrência explícitos', async () => {
    const st = buildState({ profile: 'other', cards: [{ name: 'Nubank' }] })
    const hoje = TODAY
    const realizado = {
      version: 2, source: 'transactions', field: 'amount', metric: 'sum', group: 'none', order: null,
      period: { from: `${hoje.slice(0, 8)}01`, to: hoje, label: 'este mês', grain: 'range' }, filter: { txType: ['income'] },
    }
    const frases = [
      'vou receber 1800 da casa 1 dia 5', 'vai cair 1200 do aluguel semana que vem', 'amanhã vou pagar 300 de luz',
      'o salário vai entrar dia 30', 'semana que vem vou receber 900 do cliente', 'daqui a 3 dias vou pagar 450 do cartão',
      'nao foi 500 na obra nao, nem gastei nada hoje', 'não gastei 200 no mercado', 'nem paguei a luz ainda',
      'recebo todo dia 5', 'pago 1200 de aluguel todo mês', 'na verdade não foi nada disso',
    ]
    for (const frase of frases) {
      const { out } = await roda(st, frase, { today: hoje, planRemoteQuery: async () => realizado })
      if ((out.response as any).engine === 'hybrid' || /dado real/.test(out.response.reply)) {
        return `"${frase}" virou fato: "${out.response.reply.replace(/\n/g, ' | ').slice(0, 100)}"`
      }
    }
    // Contraste: pergunta sobre o que ainda vai vencer, com fonte de previsão.
    let pediu = 0
    const previsto = {
      version: 2, source: 'invoices', field: 'amount', metric: 'sum', group: 'none',
      period: { from: `${hoje.slice(0, 8)}01`, to: `${hoje.slice(0, 5)}12-31`, label: 'até o fim do ano', grain: 'range' }, filter: {},
    }
    const { out } = await roda(st, 'quanto vou pagar de fatura até o fim do ano', { today: hoje, planRemoteQuery: async () => (pediu++, previsto) })
    if (pediu && (out.response as any).engine !== 'hybrid') return `consulta de previsão legítima foi descartada: "${out.response.reply.slice(0, 100)}"`
    return null
  })

  // --- 127. Proposta na tela não é descrita como executada ----------------
  // Nas 3 repetições B disse "Anotei os R$ 900,00…", "Registrei o abastecimento
  // de R$ 120,00", "Já anotei…" — com a ação ainda PENDENTE de confirmação.
  // No turno da resposta remota nada foi executado (a execução só acontece no
  // Confirmar), então a resposta final não pode afirmar que aconteceu. O
  // oráculo é o detector do avaliador, independente da barreira; e a frase que
  // fala do USUÁRIO ou que nega continua intacta.
  await checkAsync(r, 'proposta pendente nunca é descrita como executada', async () => {
    const st = buildState({ profile: 'other' })
    const acao = { kind: 'expense', amount: 120, category: 'outros-out', description: 'Abastecimento' } as ParsedAction
    const alegacoes = [
      'Anotei os R$ 900,00 do projeto elétrico como recebido hoje. Sobre os R$ 650,00 do reparo, preciso da data.',
      'Beleza! Registrei o abastecimento de R$ 120,00. Sobre o dia de hoje, você lembra quantas horas trabalhou?',
      'Beleza! Já anotei o abastecimento de R$ 120,00.',
      'Anotei: R$ 1.800,00 da Casa 1 e R$ 320,00 de luz.',
      'Pronto, lancei a despesa de R$ 120,00.',
      'A despesa de R$ 120,00 foi registrada.',
      'Os dois gastos já estão lançados no app.',
      'Salvei o abastecimento, confirma aí.',
      'Já apaguei a despesa duplicada de R$ 120,00.',
    ]
    for (const acoes of [[acao], [] as ParsedAction[]]) {
      for (const texto of alegacoes) {
        const { out } = await roda(st, 'faz aquilo que eu te falei do posto', {
          askRemote: async () => ({ reply: texto, mode: acoes.length ? 'propose_actions' : 'answer', actions: acoes, rejected: [] }),
        })
        const reply = out.response.reply
        const achou = alegacaoFalsa(reply)
        if (achou) return `(${acoes.length} ação pendente) "${texto}" chegou ao usuário alegando "${achou}": "${reply.replace(/\n/g, ' | ').slice(0, 140)}"`
        const valores = texto.match(/R\$\s*[\d.,]+/g) || []
        if (valores.some(v => !reply.includes(v))) return `"${texto}" perdeu um valor na barreira: "${reply.slice(0, 140)}"`
      }
    }
    for (const intacta of ['Você disse que já registrou isso ontem, então não lancei de novo.', 'Não registrei nada ainda: toda ação precisa da sua confirmação.']) {
      const { out } = await roda(st, 'faz aquilo que eu te falei do posto', {
        askRemote: async () => ({ reply: intacta, mode: 'propose_actions', actions: [acao], rejected: [] }),
      })
      if (!out.response.reply.includes(intacta)) return `frase legítima foi reescrita: "${intacta}" → "${out.response.reply.slice(0, 140)}"`
    }
    return null
  })

  // --- 128. Só o que foi GRAVADO é dito como feito ------------------------
  // Depois do Confirmar: lote atômico gravado → "Registrado"; falhou → nada foi
  // gravado, e o texto não pode sugerir o contrário. Mesma função da tela.
  check(r, 'mensagem de execução só alega o que foi gravado', () => {
    const falhas = [{ message: 'Categoria "obra" arquivada.' }]
    for (const n of [1, 3]) {
      const ok = mensagemDaExecucao(true, n, [])
      if (!/registrad/i.test(ok)) return `execução gravada (${n}) não foi dita: "${ok}"`
    }
    const falhou = mensagemDaExecucao(false, 0, falhas)
    if (alegacaoFalsa(falhou) || /registrado/i.test(falhou)) return `falha descrita como sucesso: "${falhou}"`
    if (!falhou.includes(falhas[0].message)) return 'a falha não diz o que travou'
    return null
  })

  // --- 129. Produção usa exatamente a configuração B medida ---------------
  // O benchmark escolheu v4-pro sem pensamento. O teste usa fetch falso e
  // força o reenvio para provar que as duas tentativas mantêm essa configuração
  // sem alterar temperatura, limite de saída ou o contrato de autenticação.
  await checkAsync(r, 'configuração padrão usa v4-pro sem pensamento nas duas tentativas', async () => {
    const modeloAnterior = process.env.DEEPSEEK_MODEL
    const fetchAnterior = globalThis.fetch
    const chaveFalsa = 'CHAVE_FALSA_SOMENTE_TESTE'
    const corpos: any[] = []
    const autorizacoes: string[] = []
    try {
      delete process.env.DEEPSEEK_MODEL
      const padrao = getDeepSeekConfig()
      if (DEEPSEEK_DEFAULT_MODEL !== 'deepseek-v4-pro' || padrao.model !== 'deepseek-v4-pro') {
        return `modelo padrão inesperado: constante=${DEEPSEEK_DEFAULT_MODEL}, config=${padrao.model}`
      }

      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        corpos.push(JSON.parse(String(init?.body || '{}')))
        autorizacoes.push(String((init?.headers as Record<string, string> | undefined)?.authorization || ''))
        const content = corpos.length === 1
          ? ''
          : JSON.stringify({ version: 1, mode: 'answer', reply: 'Tudo certo.', actions: [] })
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as Response
      }) as typeof fetch

      const out = await callDeepSeekChat({
        apiKey: chaveFalsa,
        model: padrao.model,
        baseUrl: 'https://example.invalid',
        timeoutMs: 1000,
      }, [{ role: 'user', content: 'teste determinístico' }])

      if (isDeepSeekFailure(out)) return `chamada falsa falhou: ${out.code}`
      if (corpos.length !== 2) return `reenvio não exercitado: ${corpos.length} tentativa(s)`
      for (const [i, corpo] of corpos.entries()) {
        if (corpo.model !== 'deepseek-v4-pro') return `tentativa ${i + 1} usou ${corpo.model}`
        if (corpo.thinking?.type !== 'disabled') return `tentativa ${i + 1} não desligou thinking`
        if (corpo.max_tokens !== 900) return `tentativa ${i + 1} mudou max_tokens para ${corpo.max_tokens}`
        const temperaturaEsperada = i === 0 ? 0.2 : 0
        if (corpo.temperature !== temperaturaEsperada) return `tentativa ${i + 1} mudou temperature para ${corpo.temperature}`
        if (JSON.stringify(corpo).includes(chaveFalsa)) return `tentativa ${i + 1} colocou a chave no corpo`
        if (autorizacoes[i] !== `Bearer ${chaveFalsa}`) return `tentativa ${i + 1} perdeu autenticação server-only`
      }
      return null
    } finally {
      globalThis.fetch = fetchAnterior
      if (modeloAnterior === undefined) delete process.env.DEEPSEEK_MODEL
      else process.env.DEEPSEEK_MODEL = modeloAnterior
    }
  })

  return r
}
