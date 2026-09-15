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
import { analyzeMessage } from '../../src/assistant/clauses'
import { classifyLocalDecision, suspicionReasons } from '../../src/assistant/semantic/confidence'
import type { SuspicionInput, SuspicionReason } from '../../src/assistant/semantic/confidence'
import { fmtBRL } from '../../src/utils/format'

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
    state, message, history: [], remoteEnabled: true, today: TODAY,
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

  return r
}
