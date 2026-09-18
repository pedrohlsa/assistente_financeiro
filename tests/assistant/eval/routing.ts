// ROTEAMENTO OBSERVADO — quem decide se o modelo pode ser cobrado por um caso.
//
// A pergunta que a bateria paga responde é estreita: "quando o modelo remoto
// REALMENTE teve oportunidade de influenciar o resultado, qual configuração foi
// melhor?". Um caso que o aparelho resolve sozinho — bem ou mal — não responde
// essa pergunta: o modelo não foi consultado, e cobrar dele o desfecho é medir
// o parser local com o nome do modelo na tabela.
//
// Por isso a elegibilidade NÃO vem de rótulo humano. Ela vem de rodar o
// orquestrador de produção com os dois caminhos remotos substituídos por
// gravadores e perguntar: saiu requisição? O rótulo `rota` do corpus continua
// existindo, mas como DIAGNÓSTICO (o local acerta ou erra o que responde), e o
// autoteste confere que ele não divergiu da medição — não o contrário.

import type { AppState } from '../../../src/models/types'
import { orchestrate } from '../../../src/assistant/orchestrator'
import type { RegistroHttp } from './transport'
import type { CasoCenario, CasoChat, CasoPlano, Dimensao, PerfilEval, RotaProducao, Suite } from './types'

/** A frase chega a qual caminho remoto, HOJE, no orquestrador real? */
export async function medeRota(state: AppState, mensagem: string, hoje: string): Promise<RotaMedida> {
  const m: RotaMedida = { plano: false, chat: false, chamadas: 0, chamadasPlano: 0, chamadasChat: 0 }
  await orchestrate({
    state, message: mensagem, remoteEnabled: true, today: hoje,
    askRemote: async () => { m.chat = true; m.chamadas++; m.chamadasChat++; return null },
    planRemoteQuery: async () => { m.plano = true; m.chamadas++; m.chamadasPlano++; return null },
  })
  return m
}

export interface RotaMedida {
  plano: boolean
  chat: boolean
  chamadas: number
  /** Por caminho: uma frase do planejador pode ir ao CHAT (hipótese) e isso não a torna elegível ao planejador. */
  chamadasPlano: number
  chamadasChat: number
}

/**
 * `local-correto` e `local-falha` são o MESMO fato para a bateria paga: o modelo
 * não foi chamado. A separação existe porque as duas dizem coisas diferentes
 * para o app — uma é o aparelho funcionando, a outra é bug local aberto — e
 * nenhuma das duas pode sumir do relatório.
 */
export type ClasseCaso = 'local-correto' | 'local-falha' | 'remoto-elegivel'

export type CasoDeFrase = CasoChat | CasoPlano | CasoCenario

export interface Observacao {
  id: string
  suite: Suite
  dimensao: Dimensao
  perfil: PerfilEval
  /** Leitura humana do que o LOCAL faz. Diagnóstico, nunca fonte de elegibilidade. */
  rotulo: RotaProducao
  /** Saiu requisição para o modelo no orquestrador real? É isto, e só isto, que decide. */
  remoteRequested: boolean
  remoteKind: 'chat' | 'plano' | null
  requestCount: number
  /** O aparelho fechou a frase sozinho, sem consultar o modelo. */
  localResolvedBeforeRemote: boolean
  classe: ClasseCaso
}

/**
 * O caminho de cenário NÃO existe em produção: o corpus mede um contrato
 * candidato. A oportunidade do modelo ali é a mesma do chat — se a frase não
 * chega nem ao chat hoje, nenhum modelo muda o que o usuário vê.
 */
const caminhoDe = (suite: Suite): 'chat' | 'plano' => (suite === 'plano' ? 'plano' : 'chat')

export async function observaCaso(
  caso: CasoDeFrase, state: AppState, hoje: string,
): Promise<Observacao> {
  const m = await medeRota(state, caso.mensagem, hoje)
  const caminho = caminhoDe(caso.suite)
  const remoteRequested = caminho === 'plano' ? m.plano : m.chat
  return {
    id: caso.id,
    suite: caso.suite,
    dimensao: caso.dimensao,
    perfil: caso.perfil,
    rotulo: caso.rota,
    remoteRequested,
    remoteKind: remoteRequested ? caminho : null,
    // Requisições no caminho que DECIDE a elegibilidade desta suíte. Uma
    // hipótese do corpus do planejador vai ao chat, não ao planejador — contar
    // as duas juntas fazia o caso parecer elegível e não elegível ao mesmo tempo.
    requestCount: caminho === 'plano' ? m.chamadasPlano : m.chamadasChat,
    localResolvedBeforeRemote: !remoteRequested,
    classe: remoteRequested ? 'remoto-elegivel' : caso.rota === 'local-errada' ? 'local-falha' : 'local-correto',
  }
}

export async function observaCorpus(
  casos: CasoDeFrase[], estado: (p: PerfilEval) => AppState, hoje: string,
): Promise<Map<string, Observacao>> {
  const out = new Map<string, Observacao>()
  for (const c of casos) out.set(c.id, await observaCaso(c, estado(c.perfil), hoje))
  return out
}

/** Elegível = o modelo teria sido chamado. Sem exceção, sem lista de IDs, sem rótulo. */
export const elegivel = (o: Observacao | undefined): boolean => !!o?.remoteRequested

export interface ResumoRoteamento {
  total: number
  localCorreto: number
  localFalha: number
  remotoElegivel: number
  taxaAlcance: number
  porSuite: Record<string, { total: number; elegiveis: number }>
  /** Casos que o rótulo humano chama de `local-errada` e a medição confirma que não chegam. */
  fronteira: string[]
  /** Rótulo `local-errada` que HOJE chega ao remoto: o rótulo envelheceu, a medição manda. */
  rotuloVencido: string[]
}

export function resumoRoteamento(obs: Iterable<Observacao>): ResumoRoteamento {
  const r: ResumoRoteamento = {
    total: 0, localCorreto: 0, localFalha: 0, remotoElegivel: 0, taxaAlcance: 0,
    porSuite: {}, fronteira: [], rotuloVencido: [],
  }
  for (const o of obs) {
    r.total++
    r.porSuite[o.suite] = r.porSuite[o.suite] || { total: 0, elegiveis: 0 }
    r.porSuite[o.suite].total++
    if (o.classe === 'remoto-elegivel') { r.remotoElegivel++; r.porSuite[o.suite].elegiveis++ }
    else if (o.classe === 'local-falha') r.localFalha++
    else r.localCorreto++
    if (o.rotulo === 'local-errada') (o.remoteRequested ? r.rotuloVencido : r.fronteira).push(o.id)
  }
  r.taxaAlcance = r.total ? r.remotoElegivel / r.total : 0
  return r
}

// ---------------------------------------------------------------------------
// Chamada lógica x tentativa HTTP
// ---------------------------------------------------------------------------

/**
 * Uma mensagem para um caminho remoto é UMA chamada lógica, mesmo que o cliente
 * tenha repetido a requisição. Retry infla latência, tokens e conta — não infla
 * o denominador da qualidade, ou um modelo instável pareceria pior duas vezes
 * pelo mesmo motivo.
 */
export const chamadasLogicas = (registros: RegistroHttp[]): number =>
  new Set(registros.map(r => `${r.tarefa}#${r.turno ?? ''}`)).size

export const tentativasHttp = (registros: RegistroHttp[]): number => registros.length

export const retries = (registros: RegistroHttp[]): number =>
  Math.max(0, registros.length - chamadasLogicas(registros))

// ---------------------------------------------------------------------------
// Quem entra na bateria PAGA
// ---------------------------------------------------------------------------

/**
 * `pago` — só o que o modelo pode influenciar hoje. É o padrão e é o que a nota
 *   de modelo usa.
 * `fronteira` — acrescenta o que o local resolve ERRADO, para a decisão de
 *   ROTEAMENTO ("valeria mandar isto ao modelo?"). Custa dinheiro e NUNCA entra
 *   na nota do modelo: o relatório mostra esses casos em bloco separado.
 * `completo` — corpus inteiro, sem gasto, para o autoteste.
 */
export type ModoCorpus = 'pago' | 'fronteira' | 'completo'

export function noCorpusPago(o: Observacao | undefined, modo: ModoCorpus): boolean {
  if (modo === 'completo') return true
  if (modo === 'fronteira') return !!o && (o.remoteRequested || o.classe === 'local-falha')
  return elegivel(o)
}
