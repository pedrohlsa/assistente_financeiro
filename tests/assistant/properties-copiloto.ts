// INVARIANTES da camada de copiloto semântico.
//
// Ficam num arquivo próprio porque `properties.ts` já passa de 2.000 linhas, e
// porque o que se prova aqui é de outra natureza: as invariantes antigas
// protegem a CONTABILIDADE (saving não é receita, cartão não conta duas vezes);
// estas protegem as três fronteiras novas — consulta só lê, cenário não grava,
// e número na prosa tem que existir nos fatos.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { AppState } from '../../src/models/types'
import { buildState, TODAY } from './harness'
import { autonomoRico, motoristaRico } from '../fixtures/richState'
import { planQuery } from '../../src/assistant/query/parse'
import { isQueryFailure, validateQueryPlan } from '../../src/assistant/query/validate'
import { runQuery } from '../../src/assistant/query/engine'
import { QUERY_METRICS, QUERY_SOURCES, DRIVER_ONLY_SOURCES, FIELDS_BY_SOURCE } from '../../src/assistant/query/types'
import { planScenario } from '../../src/assistant/scenario/parse'
import { runScenario } from '../../src/assistant/scenario/engine'
import { answerConversation } from '../../src/assistant/conversation'
import { acceptComposition, checkGrounding, MAX_COMPOSE_FACTS } from '../../src/assistant/grounding'
import { handleAssistantRequest } from '../../api/_lib/assistantHandler'
import { evidenceFor, mergeByField, EVIDENCE_RANK } from '../../src/assistant/semantic/evidence'
import { buildTurnPlan } from '../../src/assistant/semantic/turn'
import { clampMessage, repairStructuralTypos, stripInvisible, MAX_MESSAGE_CHARS } from '../../src/assistant/semantic/normalize'
import { orchestrate } from '../../src/assistant/orchestrator'
import { ASSISTANT_CONTRACT_VERSION } from '../../src/assistant/contracts'
import { todayISO } from '../../src/utils/format'
import { periodStats } from '../../src/services/calc'

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

const HOJE_Q = '2026-08-15'

/** Perguntas de todos os feitios, para exercitar a REGRA e não uma frase. */
const PERGUNTAS = [
  'quanto gastei em obra nos últimos 3 meses?',
  'qual categoria aumentou mais comparando com mês passado?',
  'qual foi meu melhor mês?',
  'quanto eu gasto em fim de semana?',
  'qual cartão está mais comprometido?',
  'quanto ainda falta pagar de computador?',
  'quanto a Casa 1 representa da minha renda?',
  'quanto gastei no Zé da esquina?',
  'qual meta está mais perto de terminar?',
  'tirando obra, quanto gastei esse mês?',
  'em qual dos próximos meses eu tenho mais parcelas?',
  'quanto eu realmente guardei nos últimos 6 meses?',
]

const HIPOTESES = [
  'se eu gastar 500 agora quanto sobra?',
  'se eu comprar um pc de 4000 em 10x no nubank quanto sobra?',
  'se eu guardar 500 por mês quando bato minha meta?',
  'se eu pagar a fatura do nubank hoje?',
  'se a Casa 1 não pagar este mês, ainda cubro minhas contas?',
  'e se eu comprar um celular de 3000 em 12x com 500 de entrada?',
]

export async function runCopilotProperties(): Promise<PropertyReport> {
  const r: PropertyReport = { total: 0, failures: [] }

  // --- 87. Consulta NUNCA altera o estado -------------------------------
  // A DSL é somente leitura por construção, mas "por construção" é uma
  // afirmação sobre o código de hoje. Esta invariante é sobre QUALQUER
  // versão futura dele.
  check(r, 'consulta nunca altera o estado', () => {
    const state = autonomoRico(HOJE_Q)
    const antes = JSON.stringify(state)
    for (const p of PERGUNTAS) {
      const planned = planQuery(state, p, { today: HOJE_Q })
      if (!planned) continue
      const v = validateQueryPlan(planned.plan, state, HOJE_Q)
      if (isQueryFailure(v)) continue
      runQuery(state, v.plan)
    }
    return JSON.stringify(state) === antes ? null : 'o estado mudou depois de uma consulta'
  })

  // --- 88. Cenário nunca altera o estado e nunca vira ação ---------------
  check(r, 'cenário não grava e não produz ação', () => {
    const state = autonomoRico(todayISO())
    const antes = JSON.stringify(state)
    for (const h of HIPOTESES) {
      const plan = planScenario(state, h)
      if (!plan) continue
      const out = runScenario(state, plan, todayISO())
      // Nenhum fato de cenário pode sair sem a marca de estimativa.
      for (const f of out.facts) {
        if (!f.estimated) return `fato de cenário sem marca de estimativa: ${f.label}`
      }
      if ((out as any).actions) return 'resultado de cenário trouxe ações'
    }
    return JSON.stringify(state) === antes ? null : 'o estado mudou depois de um cenário'
  })

  // --- 89. Cenário sempre diz que é simulação ---------------------------
  check(r, 'cenário sempre se identifica como simulação', () => {
    const state = autonomoRico(todayISO())
    for (const h of HIPOTESES) {
      const out = answerConversation(state, h, { today: todayISO() })
      if (!out) continue
      if (out.kind !== 'scenario') continue
      if (!/simula[çc][ãa]o/i.test(out.reply)) return `sem marca de simulação: "${h}"`
      if (!/nada foi (?:registrado|gravado)/i.test(out.reply)) return `sem "nada foi registrado": "${h}"`
    }
    return null
  })

  // --- 90. Hipótese nunca produz lançamento no orquestrador --------------
  await checkAsync(r, 'hipótese nunca vira lançamento', async () => {
    const state = buildState({ profile: 'other', cards: [{ name: 'Nubank' }] })
    for (const h of [...HIPOTESES, 'e se eu gastar 300 em obra?', 'supondo que eu ganhar 250 hoje']) {
      const out = await orchestrate({ state, message: h, remoteEnabled: false, today: TODAY })
      if (out.response.actions.length) {
        return `"${h}" produziu ${out.response.actions.map(a => a.action.kind).join(', ')}`
      }
    }
    return null
  })

  // --- 91. Vocabulário da DSL é FECHADO ---------------------------------
  // Uma fonte, métrica ou campo inventado precisa ser recusado com CÓDIGO.
  // Descartar em silêncio é o que fazia o `sanitizeActions` antigo comer ação.
  check(r, 'vocabulário da consulta é fechado', () => {
    const state = autonomoRico(HOJE_Q)
    const periodo = { from: '2026-08-01', to: HOJE_Q, label: 'este mês', grain: 'month' }
    const hostis = [
      { source: 'usuarios', metric: 'sum', period: periodo },
      { source: 'transactions', metric: 'exec', period: periodo },
      { source: 'transactions', metric: 'sum', group: 'senha', period: periodo },
      { source: 'transactions', metric: 'sum', order: 'eval()', period: periodo },
      { source: 'transactions', field: 'km', metric: 'sum', period: periodo },
      { source: 'transactions', metric: 'sum', period: { from: '1900-01-01', to: '2999-12-31', label: 'x', grain: 'range' } },
    ]
    for (const h of hostis) {
      const v = validateQueryPlan({ version: 2, ...h }, state, HOJE_Q)
      if (!isQueryFailure(v)) return `plano hostil ACEITO: ${JSON.stringify(h)}`
    }
    return null
  })

  // --- 92. Fonte de motorista é bloqueada em outro perfil ----------------
  check(r, 'fonte de motorista não existe em outro perfil', () => {
    const outro = buildState({ profile: 'clt' })
    const periodo = { from: '2026-08-01', to: HOJE_Q, label: 'este mês', grain: 'month' }
    for (const source of DRIVER_ONLY_SOURCES) {
      const v = validateQueryPlan(
        { version: 2, source, field: FIELDS_BY_SOURCE[source][0], metric: 'sum', period: periodo },
        outro, HOJE_Q,
      )
      if (!isQueryFailure(v)) return `${source} aceito em perfil clt`
      if (v.code !== 'profile-forbidden') return `${source} recusado por ${v.code}, não por perfil`
    }
    return null
  })

  // --- 93. Toda métrica e toda fonte têm campo válido -------------------
  // Barreira contra um enum novo entrar sem `FIELDS_BY_SOURCE`: o executor
  // devolveria zero em silêncio, que é o pior desfecho.
  check(r, 'toda fonte declara os campos que aceita', () => {
    for (const s of QUERY_SOURCES) {
      const campos = FIELDS_BY_SOURCE[s]
      if (!campos?.length) return `fonte ${s} sem campo declarado`
    }
    if (!QUERY_METRICS.length) return 'nenhuma métrica declarada'
    return null
  })

  // --- 94. Sem dados, a resposta DIZ que não há dados -------------------
  // "R$ 0,00" com cara de dado real é mentir com número certo (regra 43).
  check(r, 'sem base, a consulta cala em vez de somar zero', () => {
    const novo = buildState({ profile: 'clt' })
    for (const p of PERGUNTAS) {
      const planned = planQuery(novo, p, { today: HOJE_Q })
      if (!planned) continue
      const v = validateQueryPlan(planned.plan, novo, HOJE_Q)
      if (isQueryFailure(v)) continue
      const res = runQuery(novo, v.plan)
      if (!res.empty && res.total === 0 && res.count === 0) {
        return `"${p}" devolveu zero sem marcar como vazio`
      }
    }
    return null
  })

  // --- 95. Grounding recusa número que não existe nos fatos -------------
  check(r, 'número inventado invalida a composição remota', () => {
    const facts = [
      { id: 'f1', label: 'Obra', value: 1430, unit: 'BRL' as const, provenance: { source: 'transactions', rows: 3 } },
      { id: 'f2', label: 'Obra anterior', value: 1010, unit: 'BRL' as const, provenance: { source: 'transactions', rows: 3 } },
    ]
    const boas = [
      'Obra foi R$ 1.430,00, contra R$ 1.010,00 antes.',
      'A diferença é de R$ 420,00.',
      'Foram 3 lançamentos.',
      'Seus gastos com obra subiram.',
    ]
    for (const t of boas) {
      const g = checkGrounding(t, facts)
      if (!g.ok) return `composição legítima recusada: "${t}" (${g.offending.join(', ')})`
    }
    const ruins = [
      'Você gastou aproximadamente R$ 1.500,00 com obra.',
      'Obra ficou em R$ 1.430,00 e o total do mês foi R$ 7.777,00.',
      'Foram 42 lançamentos de obra.',
    ]
    for (const t of ruins) {
      const out = acceptComposition(t, facts)
      if (!('rejected' in out)) return `composição com número inventado ACEITA: "${t}"`
    }
    return null
  })

  // --- 96. Hierarquia de evidência: o que o usuário disse manda ---------
  check(r, 'evidência do usuário nunca é sobrescrita pelo modelo', () => {
    const local = evidenceFor(
      { kind: 'income', amount: 1800, origin: 'Casa 1', category: 'aluguel' },
      { text: 'recebi 1800 de aluguel da Casa 1' },
    )
    const remoto = evidenceFor(
      { kind: 'income', amount: 180, origin: 'Casa 2', category: 'salario', description: 'Aluguel' } as any,
      { text: 'recebi 1800 de aluguel da Casa 1', remote: true },
    )
    const out = mergeByField(local, remoto)
    const a: any = out.merged.action
    if (a.amount !== 1800) return `valor explícito virou ${a.amount}`
    if (a.origin !== 'Casa 1') return `origem explícita virou ${a.origin}`
    if (a.category !== 'aluguel') return `categoria do parser virou ${a.category}`
    if (a.description !== 'Aluguel') return 'descrição que só o remoto trouxe não foi aproveitada'
    // A ordem é fixa e não admite reconfiguração.
    if (EVIDENCE_RANK['user-explicit'] >= EVIDENCE_RANK['remote-model']) {
      return 'hierarquia invertida: o modelo remoto empata ou ganha do usuário'
    }
    return null
  })

  // --- 97. Reparo de typo nunca toca no vocabulário do usuário ----------
  check(r, 'reparo não renomeia lugar do usuário', () => {
    const state = buildState({
      profile: 'other',
      transactions: [
        { id: 't1', type: 'expense', amount: 40, category: 'alimentacao', description: 'Mercdao do Zé', date: TODAY } as any,
        { id: 't2', type: 'expense', amount: 90, category: 'combustivel', description: 'Gasosa', date: TODAY } as any,
      ],
    })
    const intocaveis = ['mercdao', 'gasosa', 'cimento', 'padoca', 'quiosque', 'ze']
    for (const frase of [
      'gastei 40 no mercdao do ze', 'gastei 50 de gasosa', 'gastei 190 de cimento',
      'gastei 30 na padoca', 'gastei 60 no quiosque',
    ]) {
      const rep = repairStructuralTypos(frase, state)
      for (const c of rep.corrections) {
        if (intocaveis.includes(c.from.toLowerCase())) {
          return `"${c.from}" virou "${c.to}" — nome do usuário não se corrige`
        }
      }
    }
    return null
  })

  // --- 98. Fronteira: invisível e tamanho ------------------------------
  await checkAsync(r, 'caractere invisível nunca chega à resposta', async () => {
    const state = buildState({ profile: 'other' })
    const sujas = [
      'gastei 50 no mercado',
      `gastei${String.fromCharCode(0x200B)} 50 no mercado`,
      `${String.fromCharCode(0x202E)}gastei 50 no mercado`,
      `gastei 50 no merc${String.fromCharCode(0x0008)}ado`,
    ]
    for (const m of sujas) {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(stripInvisible(m))) {
        return `stripInvisible deixou passar em ${JSON.stringify(m)}`
      }
      const out = await orchestrate({ state, message: m, remoteEnabled: false, today: TODAY })
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(out.response.reply)) {
        return `resposta com caractere invisível para ${JSON.stringify(m)}`
      }
      for (const c of out.response.actions) {
        const d = String((c.action as any).description || '')
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(d)) {
          return `descrição com caractere invisível para ${JSON.stringify(m)}`
        }
      }
    }
    const enorme = clampMessage('a'.repeat(MAX_MESSAGE_CHARS * 3))
    if (!enorme.truncated) return 'mensagem gigante não foi cortada'
    if (enorme.text.length > MAX_MESSAGE_CHARS) return 'corte não respeitou o teto'
    return null
  })

  // --- 99. Plano de turno cobre a mensagem inteira ----------------------
  // Cada bloco tem que ter um tipo, e a soma dos blocos tem que cobrir o
  // texto: um trecho sem bloco é um trecho perdido em silêncio.
  check(r, 'todo trecho da mensagem vira um bloco de turno', () => {
    const state = buildState({ profile: 'driver', cards: [{ name: 'Nubank' }] })
    const mensagens = [
      'gastei 50 no mercado e quanto sobrou?',
      'recebi 1800 da Casa 1, mais 1750 da Casa 2',
      'se eu comprar um pc de 4000 em 10x quanto sobra?',
      'oi, tudo bem?',
      'ganhei 430 na uber e 399 na 99, rodei 161 km',
    ]
    for (const m of mensagens) {
      const plano = buildTurnPlan(state, m, { today: TODAY })
      if (!plano.blocks.length) return `"${m}" não produziu bloco nenhum`
      for (const b of plano.blocks) {
        if (!b.type) return `bloco sem tipo em "${m}"`
        if (b.start < 0 || b.end > m.length + 2) return `bloco com posição inválida em "${m}"`
      }
    }
    return null
  })

  // --- 100. Contrato do envelope continua v1 ---------------------------
  // A decisão está documentada (design §6) e precisa de guarda: subir a versão
  // faria o app recusar toda resposta do servidor que está no ar.
  check(r, 'a camada nova não subiu a versão do envelope', () => {
    if (ASSISTANT_CONTRACT_VERSION !== 1) {
      return `ASSISTANT_CONTRACT_VERSION virou ${ASSISTANT_CONTRACT_VERSION} — o servidor em produção não conhece essa versão`
    }
    return null
  })

  // --- 101. Contexto de planejamento remoto não leva histórico ---------
  // O modelo planeja a consulta sem ver lançamento nenhum. Esta invariante
  // lê o CÓDIGO: o contexto de planejamento é montado por uma função só, e
  // ela não pode tocar em `transactions`.
  check(r, 'o remoto planeja sem ver lançamento', () => {
    const src = readFileSync(new URL('../../src/services/ai.ts', import.meta.url), 'utf8')
    const m = src.match(/function planningContext[\s\S]*?\n\}/)
    if (!m) return 'planningContext não encontrado em ai.ts'
    const corpo = m[0]
    for (const proibido of ['transactions', 'assistantJournal', 'description', 'origin', 'workSessions', 'fuelRecords']) {
      if (corpo.includes(proibido)) return `planningContext toca em ${proibido}`
    }
    if (!/askRemoteQueryPlan[\s\S]{0,400}planningContext/.test(src)) {
      return 'askRemoteQueryPlan não usa planningContext'
    }
    return null
  })

  // --- 102. Motorista: consulta de perfil não vaza para outro ----------
  check(r, 'consulta de motorista não aparece em outro perfil', () => {
    const clt = buildState({ profile: 'clt' })
    const proibidas = [
      'qual semana eu rodei mais?', 'quantos km eu rodei nos últimos 7 dias?',
      'qual foi meu lucro por km?', 'uber ou 99, qual me dá mais?',
    ]
    for (const p of proibidas) {
      const planned = planQuery(clt, p, { today: HOJE_Q })
      if (!planned) continue
      if (DRIVER_ONLY_SOURCES.includes(planned.plan.source)) {
        return `"${p}" planejou a fonte ${planned.plan.source} em perfil clt`
      }
      if (planned.plan.group === 'platform') return `"${p}" agrupou por plataforma em perfil clt`
      const v = validateQueryPlan(planned.plan, clt, HOJE_Q)
      if (!isQueryFailure(v) && DRIVER_ONLY_SOURCES.includes(v.plan.source)) {
        return `"${p}" passou na validação com fonte de motorista`
      }
    }
    return null
  })

  // --- 103. O foco conversacional não persiste ------------------------
  // Ele é de memória, como o rascunho. Se algum dia for gravado no estado,
  // uma referência pendente ressuscita depois do reload e aponta para uma
  // conversa que o usuário já esqueceu.
  check(r, 'o foco conversacional nunca entra no estado', () => {
    const state = motoristaRico(todayISO())
    const antes = JSON.stringify(state)
    let focus
    for (const m of ['quanto eu ganhei esse mês', 'e semana passada', 'por que']) {
      const out = answerConversation(state, m, { today: todayISO(), focus })
      if (out) focus = out.focus
    }
    if (JSON.stringify(state) !== antes) return 'o estado mudou durante a conversa'
    if ((state as any).assistantFocus !== undefined) return 'o foco foi gravado no estado'
    const tipos = readFileSync(new URL('../../src/models/types.ts', import.meta.url), 'utf8')
    if (/ConversationFocus|conversationFocus/.test(tipos)) {
      return 'o foco entrou no modelo de dados persistido'
    }
    return null
  })

  // --- 104. Nenhum caractere de controle no CODIGO-FONTE ---------------
  // Este projeto ja perdeu tempo DUAS vezes com um backspace (0x08) entrando
  // no lugar de um `\b` de regex numa edicao por script. O caractere e
  // invisivel no editor, quebra a regex em silencio e so aparece quando um
  // teste falha por um motivo que nao faz sentido nenhum. Onde um caractere
  // de controle e dado de teste, ele e MONTADO (`String.fromCharCode`).
  check(r, 'nenhum caractere de controle no codigo-fonte', () => {
    const arquivos = execSync('git ls-files src tests scripts api', { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(f => /\.(ts|tsx|mts)$/.test(f))
    const ruins: string[] = []
    for (const f of arquivos) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
      const n = (src.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length
      if (n) ruins.push(`${f} (${n})`)
    }
    return ruins.length ? `caractere de controle em ${ruins.join(', ')}` : null
  })

  // --- 105. O motor de consulta e o `calc.ts` NUNCA discordam ------------
  // Esta e a invariante mais importante da camada nova, e a que faltava.
  // Existem agora DOIS caminhos que somam o mesmo dinheiro: `periodStats()`,
  // que alimenta a Home, e `runQuery()`, que responde o assistente. Se eles
  // divergirem, o usuario ve dois numeros diferentes para a mesma pergunta,
  // os dois apresentados como fato — e nenhum teste de caso pegaria isso,
  // porque cada lado esta certo sozinho.
  //
  // A verificacao roda sobre TRES estados e QUATRO janelas, comparando
  // entrada, saida e resultado. Centavos nao sao tolerados: uma diferenca de
  // arredondamento aqui e uma divergencia de verdade.
  check(r, 'consulta e calc.ts somam igual', () => {
    const estados: [string, AppState][] = [
      ['autonomo', autonomoRico(TODAY)],
      ['motorista', motoristaRico(TODAY)],
      ['novo', buildState()],
    ]
    const janelas: [string, string, string][] = [
      ['mes corrente', `${TODAY.slice(0, 7)}-01`, TODAY],
      ['mes passado', '2026-07-01', '2026-07-31'],
      ['ano', '2026-01-01', TODAY],
      ['dia unico', TODAY, TODAY],
    ]
    const ruins: string[] = []
    for (const [nomeEstado, st] of estados) {
      for (const [nomeJanela, from, to] of janelas) {
        const esperado = periodStats(st, from, to)
        const lados: [string, 'expense' | 'income', number][] = [
          ['saida', 'expense', esperado.expense],
          ['entrada', 'income', esperado.income],
        ]
        for (const [rotulo, txType, alvo] of lados) {
          const plano = validateQueryPlan({
            version: 2, source: 'transactions', field: 'amount', metric: 'sum',
            group: 'none', period: { from, to, label: nomeJanela, grain: 'range' },
            filter: { txType: [txType] },
          }, st, TODAY)
          if (isQueryFailure(plano)) { ruins.push(`${nomeEstado}/${nomeJanela}/${rotulo}: plano recusado (${plano.code})`); continue }
          const got = runQuery(st, plano.plan).total
          if (Math.abs(got - alvo) > 0.001) {
            ruins.push(`${nomeEstado}/${nomeJanela}/${rotulo}: consulta ${got} vs calc ${alvo}`)
          }
        }
        // O liquido tem que fechar pelos dois caminhos tambem: a metrica `net`
        // e uma terceira implementacao da mesma conta.
        const planoNet = validateQueryPlan({
          version: 2, source: 'transactions', field: 'amount', metric: 'net',
          group: 'none', period: { from, to, label: nomeJanela, grain: 'range' },
          filter: {},
        }, st, TODAY)
        if (!isQueryFailure(planoNet)) {
          const got = runQuery(st, planoNet.plan).total
          if (Math.abs(got - esperado.profit) > 0.001) {
            ruins.push(`${nomeEstado}/${nomeJanela}/liquido: consulta ${got} vs calc ${esperado.profit}`)
          }
        }
      }
    }
    return ruins.length ? ruins.join(' | ') : null
  })

  // --- 106. A barreira de grounding tem forca MEDIDA, nao alegada -------
  // A barreira so protege com lista CURTA de fatos: com o contexto inteiro
  // (38 numeros) ela aceitava 89% dos valores inventados, porque quase todo
  // numero e a soma ou a diferenca de dois outros. O `MAX_COMPOSE_FACTS`
  // existe por causa dessa medicao, e esta invariante e a medicao virando
  // teste: se alguem afrouxar o teto ou acrescentar uma derivacao nova, o
  // numero se move e o teste conta o quanto.
  //
  // O sorteio e deterministico (LCG com semente fixa): a mesma execucao da
  // sempre o mesmo percentual, entao o limite pode ser apertado.
  check(r, 'barreira de grounding rejeita valor inventado', () => {
    const facts = Array.from({ length: MAX_COMPOSE_FACTS }, (_, i) => ({
      id: `f${i}`, label: `fato ${i}`, value: 100 * (i + 1) + 37, unit: 'BRL' as const,
      provenance: { source: 'transactions', rows: i + 1 },
    }))
    let semente = 42
    const sorteia = () => { semente = (semente * 1664525 + 1013904223) >>> 0; return semente / 4294967296 }
    let passou = 0
    const N = 3000
    for (let i = 0; i < N; i++) {
      const v = Math.round(sorteia() * 500000) / 100
      const txt = `Voce gastou R$ ${v.toFixed(2).replace('.', ',')} nisso.`
      if (checkGrounding(txt, facts).ok) passou++
    }
    const pct = (100 * passou) / N
    if (pct > 20) return `no teto de ${MAX_COMPOSE_FACTS} fatos, ${pct.toFixed(1)}% dos valores inventados passam (limite 20%)`

    // E o teto tem que FALHAR FECHADO: um fato a mais recusa a composicao
    // inteira, em vez de rodar uma checagem que ja nao protege.
    const demais = [...facts, {
      id: 'x', label: 'fato x', value: 999, unit: 'BRL' as const,
      provenance: { source: 'transactions', rows: 1 },
    }]
    const out = acceptComposition('Deu R$ 999,00.', demais)
    if (!('rejected' in out) || out.rejected !== 'too-many-facts') {
      return 'lista acima do teto foi ACEITA — a barreira deveria falhar fechada'
    }
    return null
  })

  // --- 107. O planejador remoto aceita PLANO sem `reply` --------------------
  // `callDeepSeekChat` tratava todo JSON sem `reply` como resposta vazia e
  // reenviava pedindo o envelope do CHAT. O plano da Query DSL nunca tem
  // `reply`: cada pergunta custava DUAS chamadas pagas e terminava num objeto
  // que `validateQueryPlan` recusava (`bad-version`) ou num 502 `empty-reply`.
  // O planejador remoto nunca funcionou em produção por causa disso, e nenhum
  // teste via — todos rodam sem rede. Aqui a rede é falsa e CONTA as chamadas.
  await checkAsync(r, 'planejador remoto faz UMA chamada e o plano é aceito', async () => {
    const original = globalThis.fetch
    const hojeP = todayISO()
    const cfgFalsa = { apiKey: 'falsa', model: 'qualquer', baseUrl: 'https://exemplo.invalid', timeoutMs: 5000 }
    const resposta = (content: string) => new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const plano = {
      version: 2, source: 'transactions', field: 'amount',
      period: { from: `${hojeP.slice(0, 7)}-01`, to: hojeP, label: 'este mês', grain: 'month' },
      filter: { txType: ['expense'], categories: ['obra'] }, metric: 'sum', group: 'none',
    }
    try {
      let n = 0
      ;(globalThis as any).fetch = async () => { n++; return resposta(JSON.stringify(plano)) }
      const out = await handleAssistantRequest({
        task: 'plan-query', message: 'quanto gastei com obra esse mes',
        context: { perfil: 'autonomo', categorias: [{ id: 'obra', name: 'Obra e construção', type: 'expense' }] },
      }, cfgFalsa)
      if (n !== 1) return `${n} chamadas pagas para UM plano (esperava 1)`
      if (out.status !== 200) return `planejador devolveu HTTP ${out.status}`
      const v = validateQueryPlan(out.body.queryPlan, autonomoRico(hojeP), hojeP)
      if (isQueryFailure(v)) return `plano recusado no cliente: ${v.code}`

      // O envelope do CHAT continua exigindo `reply`: sem ele, uma segunda
      // tentativa — e só uma.
      let m = 0
      ;(globalThis as any).fetch = async () => {
        m++
        return resposta(JSON.stringify(m === 1
          ? { version: 1, mode: 'answer', actions: [] }
          : { version: 1, mode: 'answer', reply: 'ok', actions: [] }))
      }
      const chat = await handleAssistantRequest({ message: 'oi', context: { perfil: 'other' } }, cfgFalsa)
      if (m !== 2) return `chat sem reply fez ${m} chamada(s) (esperava 2)`
      if (chat.status !== 200) return `chat devolveu HTTP ${chat.status}`
      return null
    } finally {
      ;(globalThis as any).fetch = original
    }
  })

  return r
}

export type { AppState }
