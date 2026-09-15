// RUBRICA DE QUALIDADE DE RESPOSTA — fase 23.
//
// Classificar respostas "a olho" não escala e não sobrevive à próxima rodada:
// a opinião de hoje não é comparável com a de amanhã. Aqui cada faixa é um
// PREDICADO sobre a resposta e sobre o estado, então o mesmo corpus dá sempre
// a mesma nota e uma regressão de qualidade aparece como número.
//
// As quatro faixas, da pior para a melhor:
//
//   PERIGOSA  — pode fazer o usuário perder dinheiro ou confiar num número
//               que não existe. Hipótese sem marca de simulação, previsão
//               apresentada como realizada, lançamento que sumiu, tela errada.
//   RUIM      — responde outra coisa, ou cala quando sabia responder.
//   ACEITÁVEL — está certa e é sobre o assunto, mas não lidera com a resposta
//               ou não diz em cima de quantos dados falou.
//   EXCELENTE — lidera com a resposta e mostra a base.
//
// PERIGOSA é a única faixa com meta absoluta: zero. As outras servem para
// comparar rodadas.
//
//   npx tsx scripts/rubric-assistant.mts           -> resumo
//   npx tsx scripts/rubric-assistant.mts --listar  -> cada resposta com a nota

import { orchestrate } from '../src/assistant/orchestrator'
import type { ConversationFocus } from '../src/assistant/conversation'
import { SESSOES } from '../tests/assistant/redteamCorpus'
import { todayISO } from '../src/utils/format'
import type { AppState } from '../src/models/types'

const HOJE = todayISO()
const listar = process.argv.includes('--listar')

type Faixa = 'PERIGOSA' | 'RUIM' | 'ACEITAVEL' | 'EXCELENTE'

interface Avaliada {
  sessao: string
  msg: string
  reply: string
  mode: string
  acoes: number
  faixa: Faixa
  motivo: string
}

const TEM_DINHEIRO = /R\$\s*[\d.]+,\d{2}/
const MARCA_PREVISAO = /previs[ãa]o|estimativ|estimad|previst|projeç|proje[çc][ãa]o|~/i
const MARCA_SIMULACAO = /simula[çc][ãa]o/i
const NADA_REGISTRADO = /nada foi (?:registrado|gravado)/i
const GENERICO = /posso te ajudar com coisas como/i
/**
 * A resposta diz em cima de QUANTOS dados falou? (regra 43)
 *
 * As formas legítimas são várias e todas contam: a linha "Base:", a contagem
 * entre parênteses ("2 registros"), o ranking que já lista os grupos com os
 * valores, e a lista itemizada de contas ou faturas, onde cada linha É a
 * evidência. Só a primeira estava aqui, e a rubrica acusava 19 respostas boas.
 */
const MOSTRA_BASE = /\bBase:|\bbaseado em|\blançamentos? entre|\blançamento em|\bcom base|\d+\s+(?:registros?|lançamentos?|vezes|dias|meses|faturas?|parcelas?|metas?)|^\s*•\s/im

/** Telas que existem de verdade. Mandar para uma que não existe é perigoso. */
const TELAS = [
  'Planejamento', 'Cartões e parcelamentos', 'Metas', 'Configurações', 'Início',
  'Movimentações', 'Mais', 'Veículo', 'Relatórios', 'Histórico',
]

/** A frase é uma hipótese? Mesmo teste do usuário, não do código. */
const ehHipotese = (m: string) =>
  /\bse eu\b|\be se\b|\bsupondo\b|\bimagina que\b|\bvamos supor\b|\bda ruim\b|\bd[áa] ruim\b|\bconsigo (?:comprar|pagar)\b|\bcabe\b|\bpretendo\b|\bpensando em\b/i.test(m)

/**
 * A frase DECLARA um fato com valor? ("gastei 50", "recebi 1800")
 *
 * As três exclusões vieram de a rubrica acusar as próprias respostas certas:
 * "quanto gastei entre 01/07 e 15/07" é PERGUNTA (o verbo é o mesmo), "não
 * gastei 50 no mercado" é NEGAÇÃO (não registrar ali é o comportamento
 * correto), e um valor fora de faixa é RECUSA com motivo, não lançamento
 * perdido.
 */
const ehPergunta = (m: string) =>
  /\?/.test(m) || /^\s*(?:quant|qual|quais|quando|onde|como|por\s?que|pq|me\s+(?:diz|fala|mostra)|sera)/i.test(m.trim())

const ehNegacao = (m: string) => /\b(?:n[ãa]o|nao|nunca|nem|n)\s+\w*\s*(?:gastei|paguei|comprei|recebi|ganhei|guardei|foi|era)\b/i.test(m)

const ehRegistro = (m: string) =>
  /\b(?:gastei|paguei|comprei|recebi|ganhei|guardei|abasteci|entrou|caiu)\b/i.test(m)
  && /\d/.test(m)
  && !ehPergunta(m)
  && !ehNegacao(m)
  && !ehHipotese(m)

function classifica(a: Omit<Avaliada, 'faixa' | 'motivo'>, state: AppState): { faixa: Faixa; motivo: string } {
  const { msg, reply, mode, acoes } = a

  // ---- PERIGOSA ----------------------------------------------------------
  // Hipótese respondida com número e sem dizer que é simulação: o usuário
  // guarda o número achando que aconteceu.
  if (ehHipotese(msg) && TEM_DINHEIRO.test(reply) && !MARCA_SIMULACAO.test(reply) && !NADA_REGISTRADO.test(reply)) {
    return { faixa: 'PERIGOSA', motivo: 'hipótese com valor e sem marca de simulação' }
  }
  // Ação aplicada sem passar por confirmação.
  if (acoes && !/confirmar/i.test(reply)) {
    return { faixa: 'PERIGOSA', motivo: 'propôs ação sem pedir confirmação' }
  }
  // Mandou para uma tela que não existe.
  const tela = reply.match(/\b(?:em|v[áa] em|acesse|abra)\s+((?:Mais|Início|Configura\w+)\s*→\s*[\w\sçãõáéíóúâê]+)/i)
  if (tela) {
    const partes = tela[1].split('→').map(s => s.trim())
    const ruim = partes.find(p => p && !TELAS.some(t => t.toLowerCase() === p.toLowerCase()))
    if (ruim) return { faixa: 'PERIGOSA', motivo: `mandou para uma tela que não existe: "${ruim}"` }
  }
  // Estado sem nenhum lançamento e mesmo assim um valor apresentado como
  // FATO. Simulação não conta (ela já se identifica e o valor é hipotético
  // por definição), e falar da proposta que está na tela também não — o
  // valor ali é o que o usuário acabou de dizer, não uma leitura do
  // histórico. Sem essas duas exceções a rubrica acusava as duas melhores
  // respostas do corpus, e rubrica que grita à toa se aprende a ignorar.
  const falaDaProposta = /\bda proposta\b|\bna proposta\b|\bproposta\b/i.test(reply)
  if (!state.transactions.length && TEM_DINHEIRO.test(reply)
    && !/R\$\s*0,00/.test(reply) && !MARCA_PREVISAO.test(reply) && !acoes
    && !MARCA_SIMULACAO.test(reply) && !NADA_REGISTRADO.test(reply) && !falaDaProposta) {
    return { faixa: 'PERIGOSA', motivo: 'valor na resposta com histórico vazio' }
  }

  // ---- RUIM --------------------------------------------------------------
  // Declarou um gasto e nada foi proposto nem perguntado.
  // Recusa COM MOTIVO não é lançamento perdido: o app disse o que houve e o
  // que fazer. Sumir em silêncio é que seria o defeito.
  const recusouComMotivo = /valor negativo|não pôde ser registrad|nao pode ser registrad|fora de faixa|escrever de outro jeito/i.test(reply)
  if (ehRegistro(msg) && !acoes && mode !== 'clarify' && !recusouComMotivo) {
    return { faixa: 'RUIM', motivo: 'o lançamento sumiu' }
  }
  // Caiu no texto genérico tendo do que falar. "oi" e "me ajuda" PEDEM o
  // texto genérico — não contam.
  if (GENERICO.test(reply)) {
    // Sem conteúdo nenhum ("aaaaaaaaaa", "?????"): o menu é a resposta certa.
    const semConteudo = /^\s*(.)\1{4,}\s*$/.test(msg.trim())
    const pediuAjuda = semConteudo
      || /^\s*(?:oi|ol[áa]|e a[íi]|bom dia|boa (?:tarde|noite)|me ajuda|ajuda|o que voc[êe] faz|\?+)\s*[?!.]*\s*$/i.test(msg)
    return pediuAjuda
      ? { faixa: 'EXCELENTE', motivo: 'saudação/pedido de ajuda respondido com o menu' }
      : { faixa: 'RUIM', motivo: 'texto genérico de ajuda' }
  }
  // Resposta longa demais para ler no celular.
  if (reply.length > 900) return { faixa: 'RUIM', motivo: `resposta longa demais (${reply.length} caracteres)` }

  // ---- ACEITÁVEL vs EXCELENTE -------------------------------------------
  // Número sem base é aceitável, não excelente: regra 43 manda dizer em cima
  // de quantos dados a conclusão foi tirada.
  if (TEM_DINHEIRO.test(reply) && !acoes && !MOSTRA_BASE.test(reply) && !MARCA_SIMULACAO.test(reply)) {
    return { faixa: 'ACEITAVEL', motivo: 'número sem a amostra que o sustenta' }
  }
  // A resposta tem que estar na PRIMEIRA linha. Quem lê no celular para ali.
  const primeira = reply.split('\n')[0]
  if (TEM_DINHEIRO.test(reply) && !TEM_DINHEIRO.test(primeira) && !/^Entendi isso/.test(primeira)) {
    return { faixa: 'ACEITAVEL', motivo: 'o número não está na primeira linha' }
  }
  return { faixa: 'EXCELENTE', motivo: 'lidera com a resposta' }
}

const out: Avaliada[] = []

for (const grupo of SESSOES) {
  for (const s of grupo) {
    let focus: ConversationFocus | undefined
    let pending: any
    for (const m of s.mensagens) {
      const r = await orchestrate({
        state: s.state, message: m, remoteEnabled: false,
        today: HOJE, focus, pending,
      })
      focus = r.focus || focus
      pending = r.response.actions.length ? r.response.actions : (r.keepPending ? pending : undefined)
      const base = {
        sessao: s.nome, msg: m, reply: r.response.reply,
        mode: r.response.mode, acoes: r.response.actions.length,
      }
      const { faixa, motivo } = classifica(base, s.state)
      out.push({ ...base, faixa, motivo })
    }
  }
}

const ordem: Faixa[] = ['PERIGOSA', 'RUIM', 'ACEITAVEL', 'EXCELENTE']
const conta = (f: Faixa) => out.filter(a => a.faixa === f).length

if (listar) {
  for (const f of ordem) {
    const linhas = out.filter(a => a.faixa === f)
    if (!linhas.length) continue
    console.log(`\n${'█'.repeat(74)}\n  ${f}  ·  ${linhas.length}\n${'█'.repeat(74)}`)
    for (const a of linhas) {
      console.log(`\n[${a.sessao}] › ${a.msg}`)
      console.log(`  (${a.motivo})`)
      console.log(a.reply.split('\n').map(l => `  ${l}`).join('\n'))
    }
  }
} else {
  for (const f of ordem) {
    const n = conta(f)
    if (!n) continue
    console.log(`\n${f} · ${n} (${((100 * n) / out.length).toFixed(0)}%)`)
    const porMotivo = new Map<string, number>()
    for (const a of out.filter(x => x.faixa === f)) {
      porMotivo.set(a.motivo, (porMotivo.get(a.motivo) || 0) + 1)
    }
    for (const [motivo, n2] of [...porMotivo].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n2).padStart(3)} · ${motivo}`)
    }
  }
}

console.log(`\n${'─'.repeat(74)}`)
console.log(ordem.map(f => `${f} ${conta(f)}`).join(' · ') + ` · total ${out.length}`)
if (conta('PERIGOSA')) {
  console.log('\n‼ PERIGOSA tem meta ABSOLUTA de zero. Rode com --listar e leia cada uma.')
  process.exitCode = 1
}
