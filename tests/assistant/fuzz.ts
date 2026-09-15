// FUZZING DETERMINÍSTICO — entrada hostil, sem travar e sem agir sozinho.
//
// Já houve, neste projeto, bug de backtracking de regex e caractere 0x08 vindo
// de uma edição por script. O fuzzer existe para que a próxima entrada estranha
// seja encontrada aqui, e não pelo usuário.
//
// O que se afirma, para TODA mensagem, por mais absurda que seja:
//
//   1. não lança exceção;
//   2. não passa do teto de tempo medido NESTA máquina (não um número
//      inventado: o teto é relativo ao baseline da própria execução);
//   3. não produz ação com valor não finito, negativo ou absurdo;
//   4. não produz ação de perfil proibido;
//   5. não devolve texto com caractere de controle.
//
// Semente fixa: a mesma bateria, sempre.

import type { AppState } from '../../src/models/types'
import { orchestrate } from '../../src/assistant/orchestrator'
import { buildState, TODAY } from './harness'
import { rng } from './metamorphic'

export interface FuzzReport {
  total: number
  falhas: string[]
  /** Baseline: tempo mediano de uma mensagem NORMAL, nesta máquina. */
  baselineMs: number
  piorMs: number
  piorMensagem: string
}

// ---------------------------------------------------------------------------
// Geradores
// ---------------------------------------------------------------------------

const PEDACOS = [
  'gastei', 'recebi', '190', 'de cimento', 'ontem', 'no mercado', 'R$',
  '1.234,56', 'e', ',', '?', 'uber', '99', 'km', 'hoje', 'guardei',
  'na reserva', 'em 10x', 'nubank', 'obra', 'não', 'se eu', 'quanto',
]

/**
 * Caracteres hostis MONTADOS por código, nunca colados como literal.
 *
 * Um caractere de controle literal dentro de um arquivo-fonte é invisível no
 * editor e some na primeira edição por script — este projeto já perdeu tempo
 * duas vezes exatamente assim, com um backspace substituindo um `\b` de regex.
 * Aqui o caractere é CONSTRUÍDO: o arquivo continua legível e a varredura
 * "nenhum caractere de controle no fonte" pode ser absoluta.
 */
const cc = (...codigos: number[]) => String.fromCharCode(...codigos)

const UNICODE_HOSTIL = [
  cc(0x202E), cc(0x200B), cc(0x200E), cc(0x2066), cc(0xFEFF), cc(0x00AD),
  cc(0x00A0), cc(0x0008), cc(0x0000), cc(0x001B),
  '\u{1F600}', '\u{1F697}\u{1F4A8}', '\u{1D7CF}\u{1D7D7}\u{1D7CE}', '\uFF32\uFF33', '\uFF11\uFF19\uFF10',
  cc(0x0301).repeat(40),
]

/**
 * Entradas escolhidas à mão, cada uma por um motivo. Não são aleatórias: são as
 * formas conhecidas de derrubar um parser de texto.
 */
export const HOSTIS: string[] = [
  '',
  ' ',
  '\n\n\n',
  'a'.repeat(20000),
  '9'.repeat(5000),
  `gastei ${'9'.repeat(400)} no mercado`,
  'e '.repeat(1000),
  ','.repeat(3000),
  '.'.repeat(3000),
  '?'.repeat(2000),
  'gastei 50 '.repeat(500),
  `gastei ${'1,'.repeat(500)}50`,
  'R$ '.repeat(2000),
  'gastei 1e400 no mercado',
  'gastei -50 no mercado',
  'gastei 0 no mercado',
  'gastei 99999999999999999999 no mercado',
  'gastei 0.0000000001 no mercado',
  'gastei NaN no mercado',
  'gastei Infinity no mercado',
  'dia 99/99/9999 gastei 50',
  'gastei 50 em 31/02/2026',
  'gastei 50 no ano 99999',
  'rodei 999999999 km',
  'comprei em 99999x',
  ...UNICODE_HOSTIL.map(u => `gastei 50${u} no mercado`),
  ...UNICODE_HOSTIL.map(u => `${u}gastei 50 no mercado`),
  '__proto__',
  '{"__proto__":{"x":1}}',
  'constructor.prototype.x = 1',
  'gastei 50 no mercado; DROP TABLE transactions',
  '<script>alert(1)</script> gastei 50',
  '${process.env.DEEPSEEK_API_KEY}',
  `gastei 50 no mercado${cc(0x0000)} e recebi 100`,
  // Lixo ENTRE duas ações válidas: as duas têm que sobreviver.
  'gastei 50 no mercado ▓▒░╬╬╬ recebi 100 de aluguel',
  'gastei 50 no mercado ' + 'x'.repeat(2000) + ' recebi 100 de aluguel',
  // Fala sem espaço.
  'gastei50nomercadohoje',
  'recebi1800dealuguelontemegastei150deareia',
  // Padrões que já causaram backtracking em regex mal formada.
  `gastei ${'a'.repeat(200)}${'!'.repeat(200)}`,
  `${'de '.repeat(300)}50`,
  `${'não '.repeat(300)}gastei 50`,
  `${'( '.repeat(500)}gastei 50`,
]

/** Mistura determinística de pedaços — cobre o que a lista à mão não imaginou. */
export function gerarAleatorias(quantas: number, seed = 424242): string[] {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < quantas; i++) {
    const n = 1 + Math.floor(r() * 12)
    const partes: string[] = []
    for (let j = 0; j < n; j++) {
      const usaUnicode = r() < 0.12
      partes.push(usaUnicode
        ? UNICODE_HOSTIL[Math.floor(r() * UNICODE_HOSTIL.length)]
        : PEDACOS[Math.floor(r() * PEDACOS.length)])
    }
    out.push(partes.join(r() < 0.2 ? '' : ' '))
  }
  return out
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

const estados = (): AppState[] => [
  buildState({ profile: 'other' }),
  buildState({ profile: 'driver', cards: [{ name: 'Nubank' }] }),
  buildState({ profile: 'clt', goals: [{ name: 'Moto', target: 9000, saved: 500 }] }),
]

/** Mede o tempo típico de uma mensagem NORMAL — é o baseline desta máquina. */
async function medeBaseline(state: AppState): Promise<number> {
  const amostras: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await orchestrate({ state, message: 'gastei 190 de cimento ontem', remoteEnabled: false, today: TODAY })
    amostras.push(performance.now() - t0)
  }
  amostras.sort((a, b) => a - b)
  return amostras[Math.floor(amostras.length / 2)]
}

/**
 * `fator` é o teto RELATIVO ao baseline medido agora. Não existe número
 * absoluto honesto aqui: a mesma mensagem custa coisas diferentes em máquinas
 * diferentes, e um limite fixo ou trava tudo num CI lento ou não pega nada num
 * desktop rápido.
 */
export async function runFuzz(aleatorias = 400, fator = 400): Promise<FuzzReport> {
  const falhas: string[] = []
  const sts = estados()
  const baselineMs = Math.max(await medeBaseline(sts[0]), 0.05)
  const teto = baselineMs * fator

  const mensagens = [...HOSTIS, ...gerarAleatorias(aleatorias)]
  let piorMs = 0
  let piorMensagem = ''

  for (const state of sts) {
    for (const msg of mensagens) {
      const t0 = performance.now()
      let out: Awaited<ReturnType<typeof orchestrate>>
      try {
        out = await orchestrate({ state, message: msg, remoteEnabled: false, today: TODAY })
      } catch (e: any) {
        falhas.push(`EXCEÇÃO em ${JSON.stringify(msg.slice(0, 60))}: ${e?.message || e}`)
        continue
      }
      const ms = performance.now() - t0
      if (ms > piorMs) { piorMs = ms; piorMensagem = msg.slice(0, 80) }
      if (ms > teto) {
        falhas.push(`LENTO (${ms.toFixed(0)}ms, teto ${teto.toFixed(0)}ms) em ${JSON.stringify(msg.slice(0, 60))}`)
      }

      const r = out.response
      if (CONTROLE.test(r.reply)) {
        falhas.push(`CARACTERE DE CONTROLE na resposta de ${JSON.stringify(msg.slice(0, 40))}`)
      }
      for (const c of r.actions) {
        const a: any = c.action
        for (const campo of ['amount', 'total', 'cost', 'netReceived', 'target']) {
          const v = a[campo]
          if (v === undefined) continue
          if (!Number.isFinite(v)) falhas.push(`VALOR NÃO FINITO (${campo}=${v}) em ${JSON.stringify(msg.slice(0, 40))}`)
          else if (v <= 0) falhas.push(`VALOR NÃO POSITIVO (${campo}=${v}) em ${JSON.stringify(msg.slice(0, 40))}`)
          else if (v > 99_999_999) falhas.push(`VALOR ABSURDO (${campo}=${v}) em ${JSON.stringify(msg.slice(0, 40))}`)
        }
        const soMotorista = ['work', 'fuel', 'odometer', 'maintenance']
        if (soMotorista.includes(c.action.kind) && state.settings.profile !== 'driver') {
          falhas.push(`AÇÃO DE MOTORISTA em perfil ${state.settings.profile}: ${c.action.kind}`)
        }
        if (c.action.kind === 'reset') {
          falhas.push(`RESET proposto por ${JSON.stringify(msg.slice(0, 40))}`)
        }
      }
      // Poluição de protótipo: qualquer objeto novo teria a chave.
      if (({} as any).polluted !== undefined || ({} as any).x === 1) {
        falhas.push(`PROTÓTIPO POLUÍDO depois de ${JSON.stringify(msg.slice(0, 40))}`)
      }
    }
  }

  return { total: mensagens.length * sts.length, falhas, baselineMs, piorMs, piorMensagem }
}
