// REPLAY OFFLINE DA PRIMEIRA BATERIA PAGA.
//
// Lê somente os artefatos JSONL já gravados. Não importa transporte, não
// consulta saldo e não possui caminho que chame DeepSeek. Serve para reaplicar
// validadores e a atribuição de proveniência sem gastar nem alterar o original.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CASOS_PLANO } from '../tests/assistant/eval/corpus-plan'
import { metricasDoModelo, pontuaEOrdena, resumoTransporte } from '../tests/assistant/eval/metrics'
import { pontuaPlano } from '../tests/assistant/eval/score'
import { ESTADOS } from '../tests/assistant/eval/states'
import type { ResultadoCaso, ProvenienciaNumerica } from '../tests/assistant/eval/types'
import type { RegistroHttp } from '../tests/assistant/eval/transport'

const argumento = process.argv.find(a => a.startsWith('--artefatos='))?.slice('--artefatos='.length)
const pasta = path.resolve(argumento || 'eval-results/2026-09-19T07-57-40-544Z')
const arquivos = ['manifesto.json', 'resultados.jsonl', 'chamadas.jsonl'] as const

for (const nome of arquivos) {
  if (!fs.existsSync(path.join(pasta, nome))) throw new Error(`artefato ausente: ${path.join(pasta, nome)}`)
}

const lerJsonl = <T,>(nome: string): T[] => fs.readFileSync(path.join(pasta, nome), 'utf8')
  .split(/\r?\n/).filter(Boolean).map(linha => JSON.parse(linha) as T)
const manifesto = JSON.parse(fs.readFileSync(path.join(pasta, 'manifesto.json'), 'utf8'))
const antes = lerJsonl<ResultadoCaso>('resultados.jsonl')
const chamadas = lerJsonl<RegistroHttp>('chamadas.jsonl')
const casosPlano = new Map(CASOS_PLANO.map(c => [c.id, c]))

const chave = (x: { config: string; caso: string; rep: number; turno?: number }) =>
  `${x.config}|${x.caso}|${x.rep}|${x.turno ?? ''}`
const porResultado = new Map<string, RegistroHttp[]>()
for (const c of chamadas) {
  const k = chave(c)
  porResultado.set(k, [...(porResultado.get(k) || []), c])
}

const jsonDoConteudo = (texto: string): any => {
  try {
    const bloco = String(texto || '').match(/\{[\s\S]*\}/)?.[0]
    return bloco ? JSON.parse(bloco) : null
  } catch { return null }
}
const normalizaEspaco = (s: string) => String(s || '').replace(/\s+/g, ' ').trim()
const semPerigoNumerico = (r: ResultadoCaso): ResultadoCaso => ({
  ...r,
  perigos: r.perigos.filter(p => p.tipo !== 'alucinacao-numerica'),
  numerosSemLastro: [],
})
const comProveniencia = (r: ResultadoCaso, fontes: ProvenienciaNumerica[]): ResultadoCaso =>
  ({ ...r, provenienciaNumerica: [...new Set(fontes)] })

let planosRecalculados = 0
let numerosReatribuidos = 0
const depois = antes.map(original => {
  const regs = porResultado.get(chave(original)) || []

  // Suíte de plano: reaplica o validador atual ao JSON bruto da chamada.
  if (original.suite === 'plano' && original.turno === undefined) {
    const caso = casosPlano.get(original.caso)
    const ultima = [...regs].reverse().find(c => c.tarefa === 'plano' && c.status === 200 && c.conteudo.trim())
    const bruto = ultima ? jsonDoConteudo(ultima.conteudo) : null
    if (caso && bruto) {
      planosRecalculados++
      return pontuaPlano({
        caso, config: original.config, rep: original.rep,
        state: ESTADOS[caso.perfil](manifesto.hoje), hoje: manifesto.hoje,
        http: { status: 200, body: { queryPlan: bruto } }, registros: regs,
        elegivelRemoto: original.elegivelRemoto,
      })
    }
    return comProveniencia(original, ['remote-plan'])
  }

  if (original.suite === 'chat') return comProveniencia(original, ['remote-output'])
  if (original.suite === 'cenario') return comProveniencia(original, ['remote-plan'])
  if (original.suite !== 'continuidade') return original

  const temPlano = regs.some(c => c.tarefa === 'plano')
  const chats = regs.filter(c => c.tarefa === 'chat')
  const fontes: ProvenienciaNumerica[] = []
  if (temPlano) fontes.push('remote-plan')
  if (chats.length) fontes.push('remote-output')
  if (temPlano && !chats.length && !original.falhaRemota) fontes.push('local-query-result', 'deterministic-composer')
  if (original.falhaRemota || original.fallbackLocal) fontes.push('fallback-local')

  // O JSONL antigo não guardava a proveniência, mas guardava tanto o texto
  // final quanto o conteúdo bruto de cada chamada. Conservamos acusações que
  // aparecem no reply remoto e retiramos somente números exclusivos da parte
  // calculada/composta localmente.
  const textoRemoto = normalizaEspaco(chats.map(c => {
    const env = jsonDoConteudo(c.conteudo)
    return typeof env?.reply === 'string' ? env.reply : ''
  }).join(' '))
  const mantidos = original.numerosSemLastro.filter(n => textoRemoto.includes(normalizaEspaco(n)))
  let atualizado = semPerigoNumerico(original)
  if (mantidos.length) {
    atualizado = {
      ...atualizado,
      numerosSemLastro: mantidos,
      perigos: [...atualizado.perigos, { tipo: 'alucinacao-numerica', detalhe: mantidos.join(', ') }],
    }
  }
  if (mantidos.length !== original.numerosSemLastro.length) numerosReatribuidos += original.numerosSemLastro.length - mantidos.length
  return comProveniencia(atualizado, fontes)
})

const configs = [...new Set(antes.map(r => r.config))].sort()
const metricas = (rs: ResultadoCaso[]) => pontuaEOrdena(configs.map(c =>
  metricasDoModelo(c, rs.filter(r => r.config === c), manifesto.trafego)))
const mAntes = metricas(antes)
const mDepois = metricas(depois)
const reduz = (m: ReturnType<typeof metricas>[number]) => ({
  config: m.config,
  perigosPor100: m.perigosPor100,
  qualidade: m.qualidade,
  queryPlanExact: m.queryPlanExact,
  queryPlanSemantic: m.queryPlanSemantic,
  numericHallucinationRate: m.numericHallucinationRate,
  invalidContractRate: m.invalidContractRate,
  perigosNumericos: m.perigos['alucinacao-numerica'],
})
const recusados = (rs: ResultadoCaso[]) => rs.filter(r => r.suite === 'plano' && r.observacoes.some(o => o.startsWith('plano recusado:')))
const unknownOrder = (rs: ResultadoCaso[]) => rs.filter(r => r.suite === 'plano' && r.observacoes.some(o => o.includes('unknown-order')))
const cAntes = resumoTransporte(antes.filter(r => r.config === 'C'))
const cDepois = resumoTransporte(depois.filter(r => r.config === 'C'))
const chamadasC = chamadas.filter(c => c.config === 'C')
const hashes = Object.fromEntries(arquivos.map(nome => [nome,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(pasta, nome))).digest('hex')]))

console.log(JSON.stringify({
  modo: 'offline-sem-rede',
  artefatos: pasta,
  hashesOriginaisSha256: hashes,
  resultados: antes.length,
  chamadas: chamadas.length,
  planosRecalculados,
  planosRecusados: { antes: recusados(antes).length, depois: recusados(depois).length },
  unknownOrder: { antes: unknownOrder(antes).length, depois: unknownOrder(depois).length },
  numerosLocaisReatribuidos: numerosReatribuidos,
  ordemAntes: mAntes.map(m => m.config),
  ordemDepois: mDepois.map(m => m.config),
  metricasAntes: mAntes.map(reduz),
  metricasDepois: mDepois.map(reduz),
  achadoCPreservado: {
    finishReasonLength: chamadasC.filter(c => c.finishReason === 'length').length,
    respostasVaziasHttp200: chamadasC.filter(c => c.status === 200 && !c.conteudo.trim()).length,
    retriesAntes: cAntes.retries,
    retriesDepois: cDepois.retries,
    p95AntesMs: cAntes.latenciaP95,
    p95DepoisMs: cDepois.latenciaP95,
  },
}, null, 2))
