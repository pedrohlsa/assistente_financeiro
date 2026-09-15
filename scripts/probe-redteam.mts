// RED TEAM — leitura humana das respostas.
//
// Roda pelo ORQUESTRADOR REAL (o mesmo caminho da tela) e imprime TODA a
// resposta. O criterio nao e "nao crashou": e se a resposta ajuda. Regra 35 do
// CLAUDE.md — tres dos nove defeitos da rodada anterior apareceram lendo a
// resposta, nao rodando teste.
//
//   npx tsx scripts/probe-redteam.mts            -> tudo
//   npx tsx scripts/probe-redteam.mts motorista  -> so o grupo

import { orchestrate } from '../src/assistant/orchestrator'
import type { ConversationFocus } from '../src/assistant/conversation'
import { SESSOES } from '../tests/assistant/redteamCorpus'
import { todayISO } from '../src/utils/format'

const HOJE = todayISO()
const filtro = process.argv[2]

let total = 0
let semResposta = 0
let generico = 0

for (const grupo of SESSOES) {
  for (const s of grupo) {
    if (filtro && !s.nome.includes(filtro)) continue
    console.log(`\n${'█'.repeat(74)}\n  ${s.nome.toUpperCase()}  ·  perfil ${s.state.settings.profile}\n${'█'.repeat(74)}`)
    const antes = JSON.stringify(s.state)
    let focus: ConversationFocus | undefined
    let pending: any
    for (const m of s.mensagens) {
      total++
      const out = await orchestrate({
        state: s.state, message: m, remoteEnabled: false,
        today: HOJE, focus, pending,
      })
      focus = out.focus || focus
      pending = out.response.actions.length ? out.response.actions : (out.keepPending ? pending : undefined)
      const r = out.response
      const marca = /posso te ajudar com coisas como/i.test(r.reply) ? ' ⟵ TEXTO GENÉRICO' : ''
      if (marca) generico++
      if (!r.reply.trim()) semResposta++
      console.log(`\n› ${m}`)
      console.log(`  [${r.mode}${r.actions.length ? `/${r.actions.length} ação(ões)` : ''}]${marca}`)
      console.log(r.reply.split('\n').map(l => `  ${l}`).join('\n'))
    }
    if (JSON.stringify(s.state) !== antes) console.log('\n  ‼ O ESTADO MUDOU SEM CONFIRMAÇÃO')
  }
}

console.log(`\n${'─'.repeat(74)}`)
console.log(`${total} mensagens · ${semResposta} sem resposta · ${generico} caíram no texto genérico de ajuda`)
