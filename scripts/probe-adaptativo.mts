// SONDA DESCARTÁVEL — Fase 1 (segunda rodada), com ids de categoria REAIS.
// Rodar: npx tsx scripts/probe-adaptativo.mts

import { buildState, TODAY } from '../tests/assistant/harness'
import type { CaseState } from '../tests/assistant/harness'
import { orchestrate } from '../src/assistant/orchestrator'
import {
  learnedCategory, withLearnedCategory, canonicalDescription, personalSuggestions,
} from '../src/assistant/learning'

const line = (s = '') => console.log(s)
const hr = (t: string) => { line(); line('='.repeat(78)); line(t); line('='.repeat(78)) }

async function ask(cs: CaseState, msgs: string[]) {
  const state = buildState(cs)
  let pending: any; let draft: any = null; let clar: any; let last: any
  for (const m of msgs) {
    const out = await orchestrate({
      state, message: m, history: [], draft: draft || undefined,
      pending, pendingClarification: clar, remoteEnabled: false, today: TODAY,
    })
    last = out.response; draft = out.draft
    pending = out.correctedPending || (out.response.actions.length ? out.response.actions : undefined)
    clar = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
  }
  return { state, res: last }
}

function show(titulo: string, msgs: string[], res: any) {
  line(); line(`— ${titulo}`); line(`  > ${msgs.join('  |  ')}`); line(`  mode: ${res.mode}`)
  for (const a of res.actions) {
    const x: any = a.action
    line(`  ACAO ${x.kind} amount=${x.amount ?? '-'} cat=${x.category ?? '-'} desc=${JSON.stringify(x.description ?? null)} origin=${JSON.stringify(x.origin ?? null)}`)
    if (a.patternWarning) line(`       ⚠ padrao: ${a.patternWarning}`)
  }
  if (!res.actions.length) line('  (SEM ACOES)')
  line(`  reply: ${String(res.reply).replace(/\n/g, '\n         ')}`)
}

const tx = (o: any) => ({ type: 'expense', amount: 50, category: 'alimentacao', date: TODAY, ...o })
const rep = (n: number, o: any) => Array.from({ length: n }, (_, i) => tx({ id: `${o.id}${i}`, ...o }))

// ---------------------------------------------------------------------------
hr('D1. CATEGORIA ARQUIVADA APRENDIDA — o lancamento inteiro morre?')
{
  const s = buildState({ profile: 'other', transactions: rep(4, { id: 'q', amount: 40, category: 'lazer', description: 'Clube' }) })
  s.categories = s.categories.map(c => (c.id === 'lazer' ? { ...c, archived: true } : c))
  const out = await orchestrate({ state: s, message: 'gastei 25 no clube', history: [], remoteEnabled: false, today: TODAY })
  show('usuario arquivou "lazer" DEPOIS de usar 4 vezes em "Clube"', ['gastei 25 no clube'], out.response)
  line(`  withLearnedCategory: ${JSON.stringify(withLearnedCategory(s, { kind: 'expense', amount: 25, description: 'Clube' } as any))}`)
  line('  ESPERADO: propor com categoria generica/outros — nunca engolir o gasto.')
}

// ---------------------------------------------------------------------------
hr('D2/D3. RECENCIA — habito que mudou e historico fossilizado')
{
  const antigoLazer = Array.from({ length: 6 }, (_, i) => tx({ id: `v${i}`, amount: 40, category: 'lazer', description: 'Bar do Tiao', date: `2026-01-0${i + 1}` }))
  const novoAlim = Array.from({ length: 4 }, (_, i) => tx({ id: `n${i}`, amount: 30, category: 'alimentacao', description: 'Bar do Tiao', date: `2026-07-0${i + 1}` }))
  const r = await ask({ profile: 'other', transactions: [...novoAlim, ...antigoLazer] }, ['gastei 35 no bar do tiao'])
  show('6 antigos (janeiro) em lazer x 4 recentes (julho) em alimentacao', ['gastei 35 no bar do tiao'], r.res)
  line('  ESPERADO: alimentacao (o habito de HOJE).')

  const fossil = await ask({ profile: 'other', transactions: rep(4, { id: 'x', amount: 60, category: 'lazer', description: 'Cantina', date: '2020-03-01' }) }, ['gastei 20 na cantina'])
  show('4 lancamentos de 2020 (6 anos!) mandando em 2026', ['gastei 20 na cantina'], fossil.res)
  line('  ESPERADO: evidencia velha nao decide sozinha.')

  const volta = await ask({
    profile: 'other',
    transactions: [
      ...Array.from({ length: 3 }, (_, i) => tx({ id: `z${i}`, amount: 40, category: 'lazer', description: 'Bar do Tiao', date: `2026-07-1${i}` })),
      ...Array.from({ length: 4 }, (_, i) => tx({ id: `y${i}`, amount: 30, category: 'alimentacao', description: 'Bar do Tiao', date: `2026-05-0${i + 1}` })),
    ],
  }, ['gastei 35 no bar do tiao'])
  show('voltou ao habito antigo (3 recentes lazer x 4 antigos alimentacao)', ['gastei 35 no bar do tiao'], volta.res)
}

// ---------------------------------------------------------------------------
hr('D4. TOKEN GENERICO COLIDINDO — "casa" existe como CATEGORIA e como palavra')
{
  const cs: CaseState = {
    profile: 'other',
    transactions: [
      ...rep(4, { id: 'luz', amount: 90, category: 'casa', description: 'Conta de luz da casa' }),
    ],
  }
  const r = await ask(cs, ['gastei 60 com comida na casa da minha mae'])
  show('"casa" aprendido de "Conta de luz da casa" contamina "casa da minha mae"', ['gastei 60 com comida na casa da minha mae'], r.res)
  const s = buildState(cs)
  line(`  learnedCategory("casa da minha mae") = ${JSON.stringify(learnedCategory(s, 'casa da minha mae', 'expense'))}`)

  const cs2: CaseState = { profile: 'other', transactions: rep(4, { id: 'ml', amount: 200, category: 'compras', description: 'Mercado livre' }) }
  const r2 = await ask(cs2, ['gastei 80 no mercado'])
  show('"Mercado livre"(compras) x "mercado" (feira, alimentacao)', ['gastei 80 no mercado'], r2.res)
  line('  ESPERADO: "mercado" isolado NAO deveria herdar de "Mercado livre".')
}

// ---------------------------------------------------------------------------
hr('D5. DUAS ENTIDADES PROXIMAS — deveria PERGUNTAR, nao escolher')
{
  const cs: CaseState = {
    profile: 'other',
    transactions: [
      ...rep(3, { id: 'pad', amount: 28, category: 'alimentacao', description: 'Padaria esquina' }),
      ...rep(4, { id: 'ofi', amount: 300, category: 'manutencao', description: 'Oficina esquina' }),
    ],
  }
  const r = await ask(cs, ['gastei 200 na esquina'])
  show('"esquina" pertence a DOIS lugares de categorias diferentes', ['gastei 200 na esquina'], r.res)
  const s = buildState(cs)
  line(`  learnedCategory("esquina") = ${JSON.stringify(learnedCategory(s, 'esquina', 'expense'))}`)
  line('  ESPERADO: nao escolher em silencio.')
}

// ---------------------------------------------------------------------------
hr('D6. ORIGEM ("Casa 1", "cliente Joao") nao tem grafia canonica')
{
  const cs: CaseState = {
    profile: 'autonomo',
    transactions: rep(4, { id: 'al', type: 'income', amount: 1800, category: 'aluguel', description: 'Aluguel', origin: 'Casa 1' }),
  }
  const r = await ask(cs, ['recebi 1800 de aluguel da casa 1'])
  show('origin "casa 1" deveria virar "Casa 1"', ['recebi 1800 de aluguel da casa 1'], r.res)
  const s = buildState(cs)
  line(`  canonicalDescription("casa 1", income) = ${JSON.stringify(canonicalDescription(s, 'casa 1', 'income'))}`)
}

// ---------------------------------------------------------------------------
hr('D7. SUGESTOES — concordancia, relevancia e diversidade')
{
  const s2 = buildState({
    profile: 'driver',
    goals: [{ name: 'Moto', target: 12000, saved: 1000 }],
    transactions: rep(3, { id: 'g', amount: 100, category: 'combustivel', description: 'Gasolina' }),
  })
  line(`  driver com gasolina: ${JSON.stringify(personalSuggestions(s2, ['Quanto posso gastar hoje?', 'Como está minha meta?']))}`)
  const s3 = buildState({
    profile: 'other',
    transactions: rep(3, { id: 'u', amount: 12, category: 'alimentacao', description: 'Água' }),
  })
  line(`  "gastei no água": ${JSON.stringify(personalSuggestions(s3, ['A']))}`)
  const s4 = buildState({ profile: 'clt', goals: [{ name: 'Notebook', target: 4000 }], transactions: [] })
  line(`  clt sem historico: ${JSON.stringify(personalSuggestions(s4, ['A', 'B']))}`)
}

// ---------------------------------------------------------------------------
hr('D8. EXPLICABILIDADE — o usuario pode perguntar por que?')
{
  const cs: CaseState = { profile: 'other', transactions: rep(4, { id: 'mk', amount: 100, category: 'compras', description: 'Mercado' }) }
  for (const m of [
    'por que voce colocou essa categoria?',
    'o que voce aprendeu sobre mim?',
    'quantas vezes eu gastei no mercado?',
    'pare de usar meu historico para sugerir coisas',
  ]) {
    const r = await ask(cs, [m])
    show(`pergunta: "${m}"`, [m], r.res)
  }
}

// ---------------------------------------------------------------------------
hr('D9. MOTORISTA — metricas adaptativas existem?')
{
  const dias: any[] = []
  for (let i = 0; i < 8; i++) {
    dias.push(tx({ id: `i${i}`, type: 'income', amount: 280 + i * 5, category: 'corridas', date: `2026-07-0${i + 1}` }))
    dias.push(tx({ id: `c${i}`, amount: 60, category: 'combustivel', description: 'Gasolina', date: `2026-07-0${i + 1}` }))
  }
  for (const m of [
    'quanto eu ganho por hora?',
    'qual meu ganho tipico por dia?',
    'quais meus dias mais fortes?',
    'quanto eu costumo gastar de gasolina por dia?',
  ]) {
    const r = await ask({ profile: 'driver', transactions: dias }, [m])
    show(`driver: "${m}"`, [m], r.res)
  }
}

line(); line('FIM DA SONDA')
