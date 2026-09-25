// Corpus SEMÂNTICA — a pergunta certa respondida pelo caminho certo.
//
// Roda pelo ORQUESTRADOR, não por `answerConversation`: os três defeitos daqui
// só aparecem no orquestrador, onde o roteador antigo responde depois que a
// consulta e o cenário desistem. Testar a camada de baixo passaria verde com o
// usuário recebendo a resposta errada.
//
//   distribuicao — "onde vazou" pede DESTINO, não total; "maior mudança" pede
//                  comparação; "maior gasto" pede um lançamento. Não colapsam;
//   residuo      — pedaço não entendido da pergunta não vira filtro de texto
//                  que "prova" que não há lançamento;
//   hipotese     — "e se…" nunca é respondido como fato;
//   capacidade   — o atalho antigo só responde o que ele sabe expressar: nome
//                  de lugar, "líquido", período e parcela de um item não são
//                  ignorados para caber numa resposta pronta.

import type { AppState } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { planQuery } from '../../src/assistant/query/parse'
import { answerConversation } from '../../src/assistant/conversation'
import type { ConversationFocus } from '../../src/assistant/conversation'
import { autonomoRico, motoristaRico } from '../fixtures/richState'
import { todayISO } from '../../src/utils/format'

/** Projeção e saldo leem o relógio (regra 35): cenário usa a data real. */
const HOJE = todayISO()

export interface SemanticaTurno {
  msg: string
  expectReply?: (string | RegExp)[]
  forbidReply?: (string | RegExp)[]
  /** Campos do plano de consulta que ficou no foco. */
  expectPlan?: {
    group?: string; order?: RegExp; compare?: boolean; filter?: Record<string, unknown>; periodFrom?: string
    source?: string; field?: string; metric?: string
    /** Filtros que têm que vir AUSENTES ("bar" não é a categoria Lazer inteira). */
    semFiltro?: string[]
  }
  /** Quem respondeu foi a CONSULTA local (o plano ficou no foco), não o atalho antigo. */
  expectQueryAnswer?: boolean
  /** Saiu requisição para algum caminho remoto (planejador ou chat). */
  expectRemote?: boolean
  /** A resposta tem que vir de um cenário (foco `last: 'scenario'`). */
  expectScenario?: boolean
  /** O pedido chegou ao planejador remoto. */
  expectRemotePlan?: boolean
}

export interface SemanticaCase {
  id: string
  group: string
  state: () => AppState
  today: string
  turnos: SemanticaTurno[]
}

// O roteador antigo lê o RELÓGIO (regra 35), não a data injetada: com a
// fixture presa em agosto, "este mês" dele seria o mês real, vazio, e o teste
// acusaria um R$ 0,00 que o usuário nunca vê. Tudo aqui roda na data real.
const autonomo = () => autonomoRico(HOJE)
const autonomoAgora = autonomo
const motorista = () => motoristaRico(HOJE)

/** Primeiro dia do mês `n` meses antes do atual. */
const inicioDoMes = (n: number): string => {
  const d = new Date(Number(HOJE.slice(0, 4)), Number(HOJE.slice(5, 7)) - 1 - n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
/** O agosto mais recente que já começou — é o que "agosto" quer dizer. */
const AGOSTO = (() => {
  const ano = Number(HOJE.slice(0, 4))
  return Number(HOJE.slice(5, 7)) >= 8 ? `${ano}-08-01` : `${ano - 1}-08-01`
})()

/** Total SEM ranking: responde "quanto" a quem perguntou "onde". */
const SO_TOTAL = /^Total gasto(?![\s\S]*•)/

export const SEMANTICA_CASES: SemanticaCase[] = [
  {
    id: 'si2-01', group: 'clareza', state: autonomo, today: HOJE,
    turnos: [{
      msg: 'qual gasto meu mais cresceu considerando os últimos meses?',
      expectReply: [/quantos meses/i], expectRemote: false,
    }],
  },
  ...[
    'por que sobrou tão pouco esse mês?',
    'por que gastei mais?',
    'onde aumentou?',
    'o que mudou do mês passado pra cá?',
    'por que meu saldo caiu?',
    'o que mais pesou no meu orçamento?',
  ].map((msg, i): SemanticaCase => ({
    id: `si2-driver-${i + 1}`, group: 'drivers', state: autonomo, today: HOJE,
    turnos: [{ msg, expectReply: [/receitas:/i, /gastos:/i, /resultado:/i, /a conta fecha/i], expectRemote: false }],
  })),
  {
    id: 'si2-driver-followup', group: 'drivers', state: autonomo, today: HOJE,
    turnos: [
      { msg: 'o que mudou do mês passado pra cá?', expectReply: [/a conta fecha/i], expectRemote: false },
      { msg: 'e o segundo maior?', expectReply: [/segundo maior fator/i], expectRemote: false },
      { msg: 'como você chegou nisso?', expectReply: [/a conta fecha/i], expectRemote: false },
    ],
  },
  {
    id: 'si2-multi-clarify', group: 'clareza', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei com alimentação e lazer este mês?', expectReply: [/juntas ou cada uma separada/i], expectRemote: false }],
  },
  // ===== 1. DISTRIBUIÇÃO ===================================================
  {
    id: 'sd-01', group: 'distribuicao', state: autonomo, today: HOJE,
    // A frase do corpus p-06. Devolvia "Total gasto nos últimos 90 dias".
    turnos: [{ msg: 'onde meu dinheiro mais vazou nos últimos 90 dias?', expectPlan: { group: 'category' }, forbidReply: [SO_TOTAL], expectReply: [/obra/i] }],
  },
  { id: 'sd-02', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'onde vazou meu dinheiro', expectPlan: { group: 'category' }, forbidReply: [SO_TOTAL] }] },
  { id: 'sd-03', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'pra onde foi meu dinheiro esse mês', expectPlan: { group: 'category' }, forbidReply: [SO_TOTAL] }] },
  { id: 'sd-04', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'onde eu mais gastei esse mês', expectPlan: { group: 'category' }, forbidReply: [SO_TOTAL] }] },
  { id: 'sd-05', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'onde gastei esse mês', expectPlan: { group: 'category' }, forbidReply: [SO_TOTAL] }] },
  {
    id: 'sd-06', group: 'distribuicao', state: autonomo, today: HOJE,
    // p-32: "oq" é "o que", e o que mais pesou é um RANKING.
    turnos: [{ msg: 'oq mais pesou agosto tirando a obra', expectPlan: { group: 'category', filter: { excludeCategories: ['obra'] }, periodFrom: AGOSTO }, forbidReply: [SO_TOTAL, /obra e constru/i] }],
  },
  {
    id: 'sd-07', group: 'distribuicao', state: autonomo, today: HOJE,
    // p-03: mudança é COMPARAÇÃO — não o maior valor do mês.
    turnos: [{ msg: 'tirando obra qual foi a maior mudança?', expectPlan: { group: 'category', order: /^delta/, compare: true, filter: { excludeCategories: ['obra'] } }, forbidReply: [/^Maior valor/] }],
  },
  // Contrastes: as intenções vizinhas NÃO podem colapsar na distribuição.
  { id: 'sd-08', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'quanto gastei esse mês', expectPlan: { group: 'none' } }] },
  { id: 'sd-09', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'qual foi meu maior gasto esse mês', expectPlan: { group: 'description' } }] },
  { id: 'sd-10', group: 'distribuicao', state: autonomo, today: HOJE, turnos: [{ msg: 'o que mais aumentou esse mês', expectPlan: { group: 'category', order: /^delta/, compare: true } }] },
  {
    id: 'sd-11', group: 'distribuicao', state: autonomo, today: HOJE,
    // "Onde" dentro de uma conversa sobre obra: destino DENTRO da obra.
    turnos: [
      { msg: 'quanto gastei com obra esse mês', expectPlan: { group: 'none', filter: { categories: ['obra'] } } },
      { msg: 'onde?', expectPlan: { group: 'description', filter: { categories: ['obra'] } }, forbidReply: [SO_TOTAL] },
      { msg: 'e mês passado?', expectPlan: { filter: { categories: ['obra'] }, periodFrom: inicioDoMes(1) } },
    ],
  },

  // ===== 2. RESÍDUO NÃO VIRA FILTRO =======================================
  {
    id: 'sr-01', group: 'residuo', state: autonomo, today: HOJE,
    // p-11: "200 reais" virava texto de busca e o app dizia que não havia gasto.
    turnos: [{ msg: 'quais foram os 3 maiores gastos acima de 200 reais em agosto tirando obra', forbidReply: [/com "200 reais"/, /não tenho nenhum lançamento/i], expectRemotePlan: true }],
  },
  {
    id: 'sr-02', group: 'residuo', state: autonomo, today: HOJE,
    // p-13: "fins de semana" é o plural de "fim de semana" — o filtro existe.
    turnos: [{ msg: 'quanto eu gastei nos fins de semana dos últimos 60 dias', expectPlan: { filter: { weekdays: [0, 6] } }, forbidReply: [/"fins de"/] }],
  },
  {
    id: 'sr-03', group: 'residuo', state: autonomo, today: HOJE,
    // p-24
    turnos: [{ msg: 'quais gastos acima de 500 eu fiz desde abril', forbidReply: [/500 eu fiz desde/, /não tenho nenhum lançamento/i], expectRemotePlan: true }],
  },
  {
    id: 'sr-04', group: 'residuo', state: autonomo, today: HOJE,
    // p-30: "cartão" repete o que o Nubank já disse — não é filtro.
    // 18/09/2026 (C5): com "mês passado" consumido de verdade, o "hein" do fim
    // grudava em "cartao" e a pergunta virava rascunho de gasto ("Qual foi o valor?").
    turnos: [{ msg: 'gastei qnt no cartao nubank mes passado hein', expectPlan: { filter: { cardNames: ['Nubank'] } }, expectReply: [/Nubank/], forbidReply: [/"cartao"/, /cadastre um cart/i, /qual foi o valor/i] }],
  },
  {
    id: 'sr-05', group: 'residuo', state: motorista, today: HOJE,
    // p-18: R$ 0,00 "dado real" para uma pergunta que ele não entendeu.
    turnos: [{ msg: 'quanto eu gastei de gasosa por km rodado mês passado comparado com esse', forbidReply: [/R\$\s*0,00/], expectRemotePlan: true }],
  },
  // Controles: nome de verdade continua sendo filtro de verdade.
  { id: 'sr-06', group: 'residuo', state: autonomo, today: HOJE, turnos: [{ msg: 'quanto gastei no Zé da esquina', expectPlan: { filter: { text: /z[eé] da esquina/i } } }] },

  // ===== 2b. CAPACIDADE: o atalho antigo não responde o que não expressa ====
  // O total antigo de "quanto gastei" ignorava o lugar e respondia o total da
  // semana inteira. "Restaurante do Amarelo" não existe no histórico: a resposta
  // certa é dizer que não há lançamento com esse nome, nunca o total geral.
  {
    id: 'sc-01', group: 'capacidade', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei no restaurante do amarelo', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { filter: { text: /restaurante do amarelo/i }, semFiltro: ['categories'] },
      expectReply: [/restaurante do amarelo/i], forbidReply: [/^Você gastou/, /nos últimos 7 dias/] }],
  },
  {
    id: 'sc-02', group: 'capacidade', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei no Restaurante do Amarelo', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { filter: { text: /restaurante do amarelo/i }, semFiltro: ['categories'] }, forbidReply: [/^Você gastou/] }],
  },
  {
    id: 'sc-03', group: 'capacidade', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei no mercado', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { filter: { text: /mercado/i }, semFiltro: ['categories'] }, forbidReply: [/^Você gastou/] }],
  },
  {
    id: 'sc-04', group: 'capacidade', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei no Zé', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { filter: { text: /z[eé]/i } }, forbidReply: [/^Você gastou/] }],
  },
  // Controle: categoria conhecida continua categoria, e continua local.
  {
    id: 'sc-05', group: 'capacidade', state: autonomo, today: HOJE,
    turnos: [{ msg: 'quanto gastei em alimentação', expectRemote: false,
      expectPlan: { filter: { categories: ['alimentacao'] }, semFiltro: ['text'] } }],
  },
  // Controle: a pergunta que o atalho antigo SABE responder continua com ele.
  { id: 'sc-06', group: 'capacidade', state: autonomo, today: HOJE, turnos: [{ msg: 'quanto gastei essa semana', expectQueryAnswer: false, expectRemote: false, expectReply: [/últimos 7 dias/] }] },
  {
    id: 'sc-07', group: 'capacidade', state: autonomo, today: HOJE,
    // p-16. A explicação "quantas vezes eu fiz ISSO" respondia "me diga o nome
    // do lugar" a quem tinha dito o lugar; e "bar" virava a categoria Lazer
    // inteira (cinema, show, festa…). Somar mostra o valor E a contagem.
    turnos: [{ msg: 'quantas vezes eu fui no bar esse mês e quanto deu', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { metric: 'sum', filter: { text: /bar/i }, semFiltro: ['categories'] },
      forbidReply: [/me diga o nome do lugar/i] }],
  },
  // Controle: sem proposta e sem nome, a explicação continua pedindo o nome.
  { id: 'sc-08', group: 'capacidade', state: autonomo, today: HOJE, turnos: [{ msg: 'quantas vezes eu fiz isso?', expectRemote: false, expectReply: [/me diga o nome do lugar/i] }] },
  {
    id: 'sc-09', group: 'capacidade', state: autonomo, today: HOJE,
    // p-23. O resumo dos cartões respondia no lugar da geladeira.
    turnos: [{ msg: 'quanto eu ja paguei do total das parcelas da geladeira', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { source: 'plans', field: 'paid', filter: { text: /geladeira/i } },
      expectReply: [/geladeira/i], forbidReply: [/Situação dos seus cartões/] }],
  },
  {
    id: 'sc-10', group: 'capacidade', state: autonomo, today: HOJE,
    // p-25. "Me pagou" é dinheiro que ENTROU; o local somava GASTOS por origem.
    turnos: [{ msg: 'qual cliente me pagou mais freela esse ano', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { group: 'origin', filter: { txType: ['income'], categories: ['freelance'] } },
      forbidReply: [/Total gasto/] }],
  },
  {
    id: 'sc-11', group: 'capacidade', state: motorista, today: HOJE,
    // p-27. O atalho antigo dava a receita BRUTA dos últimos 7 dias para quem
    // perguntou o LÍQUIDO deste mês.
    turnos: [{ msg: 'quanto eu tiro liquido por corrida em media esse mes', expectQueryAnswer: true, expectRemote: false,
      expectPlan: { metric: 'per-trip', filter: { txType: ['income', 'expense'] }, semFiltro: ['categories'] },
      forbidReply: [/últimos 7 dias/] }],
  },
  // Controle: por viagem na semana é exatamente o que o atalho antigo calcula.
  { id: 'sc-12', group: 'capacidade', state: motorista, today: HOJE, turnos: [{ msg: 'quanto eu faço por viagem essa semana', expectRemote: false, expectReply: [/por viagem/] }] },
  // Controle: o que o local não representa vai ao remoto — sem R$ 0,00 no caminho.
  {
    id: 'sc-13', group: 'capacidade', state: motorista, today: HOJE,
    turnos: [{ msg: 'qual plataforma me paga melhor por hora na última quinzena', expectRemotePlan: true, forbidReply: [/R\$\s*0,00/, /últimos 7 dias/] }],
  },

  // ===== 3. HIPÓTESE NUNCA VIRA FATO =======================================
  {
    id: 'sh-01', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // A reprodução documentada: uma projeção FACTUAL, com "/z. de 2026".
    turnos: [{ msg: 'e se eu parar a obra agora quanto sobra até dezembro', expectScenario: true, expectReply: [/obra/i, /simula/i], forbidReply: [/Projeção para/, /\/z\./] }],
  },
  { id: 'sh-02', group: 'hipotese', state: autonomoAgora, today: HOJE, turnos: [{ msg: 'e se parar a obra', expectScenario: true, expectReply: [/obra/i, /simula/i] }] },
  { id: 'sh-03', group: 'hipotese', state: autonomoAgora, today: HOJE, turnos: [{ msg: 'e se eu parar a obra', expectScenario: true, expectReply: [/obra/i, /simula/i] }] },
  { id: 'sh-04', group: 'hipotese', state: autonomoAgora, today: HOJE, turnos: [{ msg: 'se eu não gastar mais com obra', expectScenario: true, expectReply: [/obra/i, /simula/i] }] },
  { id: 'sh-05', group: 'hipotese', state: autonomoAgora, today: HOJE, turnos: [{ msg: 'supondo que eu pare a obra', expectScenario: true, expectReply: [/obra/i, /simula/i] }] },
  {
    id: 'sh-06', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // O cenário herda a entidade da conversa: "parar" é parar a OBRA.
    turnos: [
      { msg: 'quanto eu gasto com obra por mês?' },
      { msg: 'e se parar?', expectScenario: true, expectReply: [/obra/i, /simula/i] },
    ],
  },
  {
    id: 'sh-07', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // Hipótese que o app NÃO sabe simular: nunca uma resposta factual no lugar.
    turnos: [{ msg: 'e se eu mudar de cidade quanto sobra até dezembro', forbidReply: [/Projeção para/, /dado real/i, /saldo estimado/i] }],
  },
  {
    id: 'sh-09', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // A conversa da Fase 4: pergunta, destino, outro período, e a hipótese que
    // SAI do modo consulta levando a entidade junto.
    turnos: [
      { msg: 'quanto gastei em obra esse mês?', expectPlan: { filter: { categories: ['obra'] } } },
      { msg: 'onde?', expectPlan: { group: 'description', filter: { categories: ['obra'] } } },
      { msg: 'e mês passado?', expectPlan: { filter: { categories: ['obra'] }, periodFrom: inicioDoMes(1) } },
      { msg: 'e se parar a obra?', expectScenario: true, expectReply: [/obra/i, /simula/i] },
    ],
  },
  {
    id: 'sh-10', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // Depois de uma consulta, a hipótese NÃO vira refino da consulta.
    turnos: [
      { msg: 'onde meu dinheiro mais vazou nos últimos 90 dias?' },
      { msg: 'e se eu parar a obra agora quanto sobra até dezembro', expectScenario: true, expectReply: [/obra/i, /simula/i], forbidReply: [/em dezembro\. Assim que/, /\/z\./] },
      { msg: 'e se eu mudar de cidade quanto sobra até dezembro', forbidReply: [/Não tenho nenhum lançamento/, /dado real/i, /Projeção para/] },
    ],
  },
  {
    id: 'sh-08', group: 'hipotese', state: autonomoAgora, today: HOJE,
    // Controle: a MESMA pergunta sem "e se" é projeção legítima.
    turnos: [{ msg: 'quanto vai sobrar em dezembro', expectReply: [/dez\/\d{4}/], forbidReply: [/\/z\./] }],
  },
]

// ---------------------------------------------------------------------------

export interface SemanticaResult { id: string; group: string; ok: boolean; errors: string[] }

const casa = (texto: string, m: string | RegExp) =>
  typeof m === 'string' ? texto.toLowerCase().includes(m.toLowerCase()) : m.test(texto)

const confere = (esperado: unknown, obtido: unknown): boolean => {
  if (esperado instanceof RegExp) return typeof obtido === 'string' && esperado.test(obtido)
  return JSON.stringify(esperado) === JSON.stringify(obtido)
}

export async function runSemanticaCase(c: SemanticaCase): Promise<SemanticaResult> {
  const errors: string[] = []
  const state = c.state()
  const antes = JSON.stringify(state)
  let focus: ConversationFocus | undefined
  for (let i = 0; i < c.turnos.length; i++) {
    const t = c.turnos[i]
    let pediuPlano = false
    let pediuChat = false
    const out = await orchestrate({
      state, message: t.msg, focus, today: c.today,
      // Rede FALSA: grava se o pedido chegaria ao remoto, sem nunca responder.
      remoteEnabled: true,
      askRemote: async () => { pediuChat = true; return null },
      planRemoteQuery: async () => { pediuPlano = true; return null },
    })
    const r = out.response
    const anterior = focus
    const tag = `turno ${i + 1} ("${t.msg}")`
    if (r.actions.length) errors.push(`${tag} propôs ${r.actions.length} ação(ões) numa pergunta`)
    for (const m of t.expectReply || []) if (!casa(r.reply, m)) errors.push(`${tag} não contém ${m}: "${r.reply.replace(/\n/g, ' | ').slice(0, 200)}"`)
    for (const m of t.forbidReply || []) if (casa(r.reply, m)) errors.push(`${tag} contém proibido ${m}: "${r.reply.replace(/\n/g, ' | ').slice(0, 200)}"`)
    if (out.focus) focus = out.focus
    if (t.expectPlan) {
      // O plano que ficou no foco DESTE turno; quando o roteador antigo responde
      // ele não grava plano, e aí o que vale é o que o planejador leu da frase.
      const doTurno = out.focus && out.focus !== anterior && out.focus.last === 'query' ? out.focus.lastQueryPlan : undefined
      const p: any = doTurno || planQuery(state, t.msg, { today: c.today })?.plan
      if (!p) errors.push(`${tag} sem plano de consulta`)
      else {
        if (t.expectPlan.group && p.group !== t.expectPlan.group) errors.push(`${tag} group ${p.group} ≠ ${t.expectPlan.group}`)
        if (t.expectPlan.order && !t.expectPlan.order.test(String(p.order ?? ''))) errors.push(`${tag} order ${p.order} não casa ${t.expectPlan.order}`)
        if (t.expectPlan.compare !== undefined && !!p.comparePeriod !== t.expectPlan.compare) errors.push(`${tag} compare ${!!p.comparePeriod} ≠ ${t.expectPlan.compare}`)
        if (t.expectPlan.periodFrom && p.period?.from !== t.expectPlan.periodFrom) errors.push(`${tag} período ${p.period?.from} ≠ ${t.expectPlan.periodFrom}`)
        if (t.expectPlan.source && p.source !== t.expectPlan.source) errors.push(`${tag} source ${p.source} ≠ ${t.expectPlan.source}`)
        if (t.expectPlan.field && p.field !== t.expectPlan.field) errors.push(`${tag} field ${p.field} ≠ ${t.expectPlan.field}`)
        if (t.expectPlan.metric && p.metric !== t.expectPlan.metric) errors.push(`${tag} metric ${p.metric} ≠ ${t.expectPlan.metric}`)
        for (const k of t.expectPlan.semFiltro || []) {
          if (p.filter?.[k] !== undefined) errors.push(`${tag} filter.${k} = ${JSON.stringify(p.filter[k])} deveria estar ausente`)
        }
        for (const [k, v] of Object.entries(t.expectPlan.filter || {})) {
          if (!confere(v, p.filter?.[k])) errors.push(`${tag} filter.${k} = ${JSON.stringify(p.filter?.[k])} ≠ ${v instanceof RegExp ? v : JSON.stringify(v)}`)
        }
      }
    }
    if (t.expectQueryAnswer !== undefined) {
      // O foco não serve de prova: ele guarda o plano também quando o atalho
      // antigo responde (é o que deixa "onde?" funcionar depois). Prova é o
      // TEXTO ser o da consulta local.
      const consulta = answerConversation(state, t.msg, { today: c.today, focus: anterior })
      const respondeuConsulta = consulta?.kind === 'query' && consulta.reply === r.reply
      if (respondeuConsulta !== t.expectQueryAnswer) {
        errors.push(`${tag} ${t.expectQueryAnswer ? 'não foi' : 'foi'} respondido pela consulta local: "${r.reply.replace(/\n/g, ' | ').slice(0, 160)}"`)
      }
    }
    if (t.expectRemote !== undefined && (pediuPlano || pediuChat) !== t.expectRemote) {
      errors.push(`${tag} ${t.expectRemote ? 'não chegou' : 'chegou'} ao remoto (plano ${pediuPlano}, chat ${pediuChat}): "${r.reply.replace(/\n/g, ' | ').slice(0, 160)}"`)
    }
    if (t.expectScenario && out.focus?.last !== 'scenario') errors.push(`${tag} não foi respondido como cenário: "${r.reply.replace(/\n/g, ' | ').slice(0, 160)}"`)
    if (t.expectRemotePlan !== undefined && pediuPlano !== t.expectRemotePlan) {
      errors.push(`${tag} ${t.expectRemotePlan ? 'não chegou' : 'chegou'} ao planejador remoto: "${r.reply.replace(/\n/g, ' | ').slice(0, 160)}"`)
    }
  }
  if (JSON.stringify(state) !== antes) errors.push('O ESTADO MUDOU durante a conversa')
  return { id: c.id, group: c.group, ok: !errors.length, errors }
}
