// SONDA DESCARTÁVEL — rodada manual de 17/08/2026.
// 50+ mensagens naturais, 4 perfis, usuário novo, usuário com histórico,
// usuário que mudou de hábito, frases compostas, erro de digitação, voz
// simulada, pergunta aberta, correção e cancelamento.
//
// Não é teste: é para LER (regra 35). Rodar: npx tsx scripts/probe-adaptativo.mts

import { buildState } from '../tests/assistant/harness'
import type { CaseState } from '../tests/assistant/harness'
import { orchestrate } from '../src/assistant/orchestrator'
import { assistantSuggestions } from '../src/assistant/suggestions'
import { addDays, todayISO } from '../src/utils/format'

const T = todayISO()
const d = (atras: number) => addDays(T, -atras)

let n = 0
const hr = (t: string) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

async function conversa(titulo: string, cs: CaseState, msgs: string[]) {
  hr(titulo)
  const state = buildState(cs)
  for (const x of assistantSuggestions(state, {}).slice(0, 3)) {
    console.log(`   chip [${x.kind === 'shortcut' ? '+' : '?'}] ${x.text}`)
  }
  let pending: any; let draft: any = null; let clar: any
  for (const m of msgs) {
    n++
    const out = await orchestrate({
      state, message: m, history: [], draft: draft || undefined,
      pending, pendingClarification: clar, remoteEnabled: false, today: T,
    })
    const acoes = out.response.actions.map((a: any) => {
      const x = a.action
      return `${x.kind}(${x.amount ?? x.total ?? x.cost ?? x.km ?? '-'}${x.category ? ' ' + x.category : ''}${x.description ? ' "' + x.description + '"' : ''}${x.origin ? ' @' + x.origin : ''})`
    })
    console.log(`\n${String(n).padStart(3)}. > ${m}`)
    console.log(`     [${out.response.mode}] ${out.response.reply.replace(/\n/g, '\n     ')}`)
    if (acoes.length) console.log(`     AÇÕES: ${acoes.join(' | ')}`)
    for (const a of out.response.actions as any[]) {
      if (a.patternWarning) console.log(`     ⚠ ${a.patternWarning}`)
      if (a.duplicateWarning) console.log(`     ⚠ ${a.duplicateWarning}`)
    }
    draft = out.draft
    pending = out.correctedPending
      ? out.correctedPending
      : out.response.actions.length ? out.response.actions : (out.keepPending ? pending : undefined)
    clar = out.response.mode === 'clarify' ? (out.response as any).clarification : undefined
  }
}

// ---------------------------------------------------------------------------
const motoristaVeterano: CaseState = {
  profile: 'driver',
  balance: 640,
  goals: [{ name: 'Moto', target: 12000, saved: 2400 }],
  transactions: [
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `u${i}`, type: 'income', amount: 190 + (i % 7) * 8, category: 'corridas',
      description: 'Uber', date: d(20 - i),
    })),
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `nn${i}`, type: 'income', amount: 120 + (i % 5) * 6, category: 'corridas',
      description: '99', date: d(20 - i),
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `sk${i}`, type: 'expense', amount: 95, category: 'combustivel',
      description: 'Suco', date: d(20 - i),
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `mz${i}`, type: 'expense', amount: 24, category: 'alimentacao',
      description: 'Marmita da Dona Zica', date: d(18 - i * 2),
    })),
  ] as any,
  workSessions: Array.from({ length: 18 }, (_, i) => ({
    id: `w${i}`, date: d(20 - i), km: 160 + (i % 7) * 9, hours: 9, trips: 19 + (i % 6),
  })),
}

await conversa('1) MOTORISTA VETERANO — vocabulário próprio, dia composto, correção', motoristaVeterano, [
  'boa noite, hoje foi 430 na uber e 380 na 99, rodei 172 km em 10 horas',
  'botei 95 de suco tambem',
  'na verdade foi 105 o suco',
  'quanto eu costumo fazer por dia?',
  'quais sao meus dias mais fortes?',
  'de onde vem mais dinheiro, uber ou 99?',
  'essa semana ta melhor que o normal?',
  'quanto falta pra minha moto?',
  'vale a pena corrida de 7 reais?',
  'comprei marmita da dona zica',
  '26',
  'por que voce colocou essa categoria?',
])

// ---------------------------------------------------------------------------
await conversa('2) MOTORISTA NOVATO — nada registrado, o app precisa admitir', { profile: 'driver' }, [
  'oi',
  'quanto eu costumo fazer por dia?',
  'quais meus dias mais fortes?',
  'quanto meu carro custa por km?',
  'o que voce aprendeu sobre mim?',
  'ganhei 250 hoje',
  'quantas vezes eu fiz isso?',
  'cancela',
])

// ---------------------------------------------------------------------------
const autonomoImoveis: CaseState = {
  profile: 'autonomo',
  balance: 5200,
  transactions: [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`, type: 'income', amount: 1800, category: 'aluguel',
      description: 'Aluguel', origin: 'Casa 1', date: d(180 - i * 30),
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`, type: 'income', amount: 1200, category: 'aluguel',
      description: 'Aluguel', origin: 'Kitnet do fundo', date: d(150 - i * 30),
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `o${i}`, type: 'expense', amount: 340, category: 'obra',
      description: 'Depósito do Nilo', date: d(40 - i * 7),
    })),
  ] as any,
}

await conversa('3) AUTÔNOMO DE IMÓVEIS — origem, grafia, frase composta, pergunta aberta', autonomoImoveis, [
  'recebi 1800 de aluguel da casa 1 e 1200 da kitnet do fundo',
  'gastei 380 no deposito do nilo',
  'quanto recebi de alugueis este mes?',
  'to no lucro esse mes?',
  'quanto eu ja gastei com obra?',
  'o que voce aprendeu sobre mim?',
  'sera que vale a pena eu comprar outro imovel agora?',
  'quantas vezes eu fiz isso?',
])

// ---------------------------------------------------------------------------
const cltQueMudou: CaseState = {
  profile: 'clt',
  balance: 2100,
  monthlyProfitTarget: 600,
  goals: [{ name: 'Notebook', target: 4500, saved: 900 }],
  transactions: [
    // Hábito ANTIGO: mercado era compras.
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `v${i}`, type: 'expense', amount: 230, category: 'compras',
      description: 'Mercado', date: d(200 - i * 7),
    })),
    // Hábito NOVO: virou alimentação nos últimos meses.
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, type: 'expense', amount: 240, category: 'alimentacao',
      description: 'Mercado', date: d(30 - i * 6),
    })),
    { id: 's1', type: 'income', amount: 3800, category: 'salario', description: 'Salário', date: d(15) },
    { id: 's2', type: 'income', amount: 3800, category: 'salario', description: 'Salário', date: d(45) },
  ] as any,
}

await conversa('4) CLT QUE MUDOU DE HÁBITO — recência, digitação torta, voz simulada', cltQueMudou, [
  'gastei 250 no mercado',
  'por que voce colocou essa categoria?',
  'quantas vezes eu fiz isso?',
  'gastei 250 no mercadooo',
  'gsatei 60 no merkado',
  'recebi meu salario de 3800 e guardei 400',
  'como ta minha meta mensal?',
  'quanto posso guardar este mes',
  'você está usando qual período?',
])

// ---------------------------------------------------------------------------
const outroBasico: CaseState = {
  profile: 'other',
  balance: 300,
  transactions: [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `q${i}`, type: 'expense', amount: 45, category: 'lazer',
      description: 'Quiosque', date: d(20 - i * 3),
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `p${i}`, type: 'expense', amount: 50, category: 'compras',
      description: 'Quiosque', date: d(8 - i * 2),
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`, type: 'expense', amount: 18, category: 'alimentacao',
      description: 'Café da Rita', date: d(15 - i),
    })),
  ] as any,
}

await conversa('5) PERFIL OTHER — entidade ambígua, valor absurdo, negação, cancelamento', outroBasico, [
  'gastei 40 no quiosque',
  'lazer',
  'gastei 20 no cafe da rita',
  'gastei 1800 no cafe da rita',
  'por que voce acha esse valor estranho?',
  'nao gastei 1800 nao',
  'gastei 15 no cafe da rita e 40 no mercado',
  'cancela isso',
  'pare de usar meu historico',
])

// ---------------------------------------------------------------------------
const desligado: CaseState = { ...outroBasico, adaptiveAssistant: false } as any
await conversa('6) O MESMO CLIENTE COM O APRENDIZADO DESLIGADO', desligado, [
  'gastei 40 no quiosque',
  'gastei 20 no cafe da rita',
  'o que voce aprendeu sobre mim?',
  'quanto eu gastei essa semana?',
])

// ---------------------------------------------------------------------------
await conversa('7) FALA TRANSCRITA E FRASE SEM PONTUAÇÃO (voz simulada)', motoristaVeterano, [
  'ó hoje eu fiz quatrocentos e trinta na uber mais trezentos e oitenta na noventa e nove',
  'coloquei noventa e cinco reais de suco no carro e rodei cento e setenta e dois quilometros',
  'tô no vermelho esse mes',
  'quanto eu costumo gastar de suco por dia',
  'me diz quanto eu ganho por hora',
])

console.log(`\n\nTOTAL DE MENSAGENS: ${n}`)
