// SONDA DESCARTAVEL — rodada LIMITE.
// Entrada hostil, escala, colisao de roteador, interacao com cartao/meta/99.

import { buildState, TODAY } from '../tests/assistant/harness'
import type { CaseState } from '../tests/assistant/harness'
import { orchestrate } from '../src/assistant/orchestrator'
import { buildPersonalModel } from '../src/assistant/personalModel'
import { assistantSuggestions } from '../src/assistant/suggestions'
import { buildAiContext } from '../src/services/ai'
import { addDays, todayISO } from '../src/utils/format'

const hr = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
const d = (n: number) => addDays(todayISO(), -n)

async function ask(cs: CaseState, msgs: string[], rot = '') {
  const state = buildState(cs)
  let pending: any; let draft: any = null; let clar: any
  if (rot) console.log(`\n— ${rot}`)
  for (const m of msgs) {
    const out = await orchestrate({
      state, message: m, history: [], draft: draft || undefined,
      pending, pendingClarification: clar, remoteEnabled: false, today: TODAY,
    })
    const acoes = out.response.actions.map((a: any) => {
      const x = a.action
      return `${x.kind}(${x.amount ?? x.total ?? x.cost ?? '-'}${x.category ? ' ' + x.category : ''}${x.description ? ' "' + String(x.description).slice(0, 40) + '"' : ''})`
    })
    console.log(`  > ${m.slice(0, 90)}${m.length > 90 ? '...' : ''}`)
    console.log(`    [${out.response.mode}] ${out.response.reply.slice(0, 240).replace(/\n/g, ' | ')}`)
    if (acoes.length) console.log(`    ACOES: ${acoes.join(' | ')}`)
    draft = out.draft
    pending = out.correctedPending || (out.response.actions.length ? out.response.actions : (out.keepPending ? pending : undefined))
    clar = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
  }
  return state
}

hr('L1. ESCALA — 6000 lancamentos')
{
  const t0 = Date.now()
  const txs = Array.from({ length: 6000 }, (_, i) => ({
    id: `x${i}`, type: i % 3 === 0 ? 'income' : 'expense',
    amount: 20 + (i % 400), category: i % 3 === 0 ? 'corridas' : (i % 2 ? 'alimentacao' : 'compras'),
    description: i % 5 === 0 ? 'Ze da esquina' : `Lugar ${i % 97}`,
    date: d(i % 900),
  }))
  const s = buildState({ profile: 'driver', transactions: txs as any })
  console.log(`  build state: ${Date.now() - t0}ms`)
  const t1 = Date.now()
  const m = buildPersonalModel(s, TODAY)
  const cat = m.categoryFor('Ze da esquina', 'expense')
  console.log(`  build model + 1a consulta: ${Date.now() - t1}ms -> ${JSON.stringify(cat && { v: cat.value, n: cat.sampleSize, s: cat.strength })}`)
  const t2 = Date.now()
  for (let i = 0; i < 200; i++) m.categoryFor(`Lugar ${i % 97}`, 'expense')
  console.log(`  200 consultas (cache quente): ${Date.now() - t2}ms`)
  const t3 = Date.now()
  const out = await orchestrate({ state: s, message: 'gastei 30 no ze da esquina', history: [], remoteEnabled: false, today: TODAY })
  console.log(`  orquestrar 1 mensagem: ${Date.now() - t3}ms -> ${(out.response.actions[0] as any)?.action?.category}`)
  console.log(`  amostra lida: ${m.sample.total}, de ${m.sample.from} a ${m.sample.to}`)
}

hr('L2. TEXTO HOSTIL NO HISTORICO')
{
  const hostis = [
    '<script>alert(1)</script>',
    String.fromCharCode(39) + '; DROP TABLE transactions; --',
    'A'.repeat(300),
    '\u{1F44D}\u{1F44D}\u{1F44D}',
    '‮mercado‭',
    'zero​width',
    '   ',
    '123456',
    'Ze da esquina',
  ]
  for (const h of hostis) {
    const s = buildState({
      profile: 'other',
      transactions: Array.from({ length: 4 }, (_, i) => ({
        id: `h${i}`, type: 'expense', amount: 30, category: 'compras', description: h, date: d(i + 1),
      })) as any,
    })
    const m = buildPersonalModel(s, TODAY)
    const cat = m.categoryFor(h, 'expense')
    const sug = assistantSuggestions(s, { today: TODAY }).filter(x => x.kind === 'shortcut').map(x => x.text)
    console.log(`  ${JSON.stringify(h.slice(0, 26))} -> cat=${cat?.value ?? '-'} | atalhos=${JSON.stringify(sug).slice(0, 95)}`)
  }
}

hr('L3. HISTORICO CORROMPIDO')
{
  const s = buildState({ profile: 'other' })
  s.transactions = [
    { id: 'a', type: 'expense', amount: NaN, category: 'compras', description: 'Feira', date: d(1), time: '10:00' },
    { id: 'b', type: 'expense', amount: 30, category: 'compras', description: 'Feira', date: 'lixo', time: '10:00' },
    { id: 'c', type: 'expense', amount: 30, category: 'compras', description: 'Feira', date: '2099-01-01', time: '10:00' },
    { id: 'dd', type: 'expense', amount: 30, category: null as any, description: 'Feira', date: d(2), time: '10:00' },
    { id: 'e', type: 'expense', amount: 30, category: 'compras', description: null as any, date: d(3), time: '10:00' },
    { id: 'f', type: 'expense', amount: 30, category: 'compras', description: 'Feira', date: d(4), time: '10:00' },
    { id: 'g', type: 'expense', amount: 30, category: 'compras', description: 'Feira', date: d(5), time: '10:00' },
    null as any, undefined as any,
  ]
  try {
    const m = buildPersonalModel(s, TODAY)
    console.log('  categoryFor("Feira") =', JSON.stringify(m.categoryFor('Feira', 'expense')))
    console.log('  amountProfile =', JSON.stringify(m.amountProfile('expense', 'compras')))
    console.log('  sample =', JSON.stringify(m.sample))
    const out = await orchestrate({ state: s, message: 'gastei 40 na feira', history: [], remoteEnabled: false, today: TODAY })
    console.log('  proposta ->', JSON.stringify((out.response.actions[0] as any)?.action))
  } catch (e: any) {
    console.log('  EXCECAO:', e?.message)
  }
}

hr('L4. COLISAO DO ROTEADOR DE EXPLICACAO')
{
  const cs: CaseState = {
    profile: 'other', balance: 500,
    transactions: Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, type: 'expense', amount: 120, category: 'compras', description: 'Mercado', date: d(i + 1),
    })) as any,
  }
  await ask(cs, [
    'por que meu saldo esta negativo?',
    'por que eu gastei tanto esse mes?',
    'por que voce colocou 100?',
    'de quando e essa conta?',
    'quantas vezes eu preciso trabalhar pra pagar isso?',
    'pare de me mandar notificacao',
    'nao use meu cartao de credito',
  ], 'perguntas que NAO sao pedido de explicacao')
}

hr('L5. APRENDIZADO x CARTAO, META, 99 E RECORRENTE')
{
  const cs: CaseState = {
    profile: 'driver',
    cards: [{ name: 'Nubank' }, { name: 'Inter' }],
    goals: [{ name: 'Moto', target: 9000, saved: 100 }],
    transactions: [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `co${i}`, type: 'income', amount: 300, category: 'corridas', description: '99', date: d(i + 1),
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `nu${i}`, type: 'expense', amount: 200, category: 'compras', description: 'Nubank', date: d(i + 1),
      })),
    ] as any,
  }
  await ask(cs, ['ganhei 400 na 99 hoje'], 'receita da 99: taxa NUNCA por habito')
  await ask(cs, ['passei 900 no nubank em 3x'], 'cartao citado')
  await ask(cs, ['guardei 200 na moto'], 'deposito em meta')
  await ask(cs, ['paguei a fatura do nubank'], 'fatura')
  await ask(cs, ['pago 90 de internet todo mes'], 'recorrente declarada')
}

hr('L6. DILEMA SOB PRESSAO')
{
  const amb = (nome: string, ida: string, catA: string, catB: string) => [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `${ida}a${i}`, type: 'expense', amount: 50, category: catA, description: nome, date: d(i + 1) })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `${ida}b${i}`, type: 'expense', amount: 50, category: catB, description: nome, date: d(i + 5) })),
  ]
  const cs: CaseState = {
    profile: 'other',
    cards: [{ name: 'Nubank' }, { name: 'Inter' }],
    transactions: [...amb('Quiosque', 'q', 'lazer', 'compras'), ...amb('Banca', 'b', 'lazer', 'assinaturas')] as any,
  }
  await ask(cs, ['gastei 40 no quiosque e 20 na banca'], 'DOIS dilemas na mesma mensagem')
  await ask(cs, ['gastei 40 no quiosque', 'compras'], 'escolher a opcao do dilema')
  await ask(cs, ['gastei 40 no quiosque', 'sei la'], 'resposta que nao e opcao')
  await ask(cs, ['gastei 40 no quiosque no cartao'], 'dilema + cartao ambiguo')
  await ask(cs, ['gastei 40 no quiosque ontem'], 'dilema + data')
}

hr('L7. PRIVACIDADE SOB PRESSAO')
{
  const s = buildState({ profile: 'autonomo' })
  s.transactions = [
    { id: 'p1', type: 'income', amount: 5000, category: 'freelance', description: 'CPF 123.456.789-00', origin: 'Cliente Maria Silva', date: d(1), time: '10:00' },
    { id: 'p2', type: 'expense', amount: 80, category: 'compras', description: 'Rua das Flores 42 apto 301', date: d(2), time: '10:00' },
    { id: 'p3', type: 'expense', amount: 80, category: 'compras', description: 'senha do banco 4321', date: d(3), time: '10:00' },
  ] as any
  const json = JSON.stringify(buildAiContext(s))
  for (const p of ['CPF', '123.456', 'Maria Silva', 'Rua das Flores', 'senha', '4321']) {
    console.log(`  "${p}" no contexto remoto? ${json.includes(p) ? 'VAZOU' : 'ok'}`)
  }
  console.log('  tamanho do contexto:', json.length, 'bytes')
}

hr('L8. MENSAGEM MONSTRO E VALOR EXTREMO')
{
  const partes: string[] = []
  for (let i = 1; i <= 12; i++) partes.push(`gastei ${i * 7} no lugar ${i}`)
  await ask({ profile: 'other' }, [partes.join(' e ')], '12 despesas numa frase')
  await ask({ profile: 'driver' }, ['ganhei 300 hoje ' + 'muito '.repeat(400) + 'e gastei 50'], 'frase gigante')
  await ask({ profile: 'other' }, [''], 'mensagem vazia')
  await ask({ profile: 'other' }, ['?????'], 'so pontuacao')
  await ask({ profile: 'other' }, ['gastei 0 no mercado'], 'valor zero')
  await ask({ profile: 'other' }, ['gastei 999999999 no mercado'], 'valor absurdo')
  await ask({ profile: 'other' }, ['gastei -50 no mercado'], 'valor negativo')
}

console.log('\nFIM')
