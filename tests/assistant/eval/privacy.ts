// GUARDA DE PRIVACIDADE — roda sobre o corpo SERIALIZADO, imediatamente antes
// de a requisição sair da máquina.
//
// Três barreiras independentes, porque cada uma cobre uma falha diferente:
//
//   1. o ESTADO precisa carregar o canário sintético — prova de origem, marcada
//      no contexto do caso (`origemVerificada`) e exigida pelo transporte;
//   2. o CORPO não pode conter padrão de dado pessoal nem a chave da API —
//      pega o que a primeira não pega (um texto colado num caso, por exemplo);
//   3. todo NOME de categoria, cartão ou meta enviado precisa existir no
//      vocabulário sintético.
//
// Até 15/09/2026 o canário também era exigido NO CORPO do chat, porque o nome do
// usuário ia no contexto. Ele deixou de ir (regra 44), e a prova de origem
// passou a morar no caso.
//
// Qualquer falha BLOQUEIA a chamada. Não existe "enviar mesmo assim".

import type { AppState } from '../../../src/models/types'
import { normalizeName } from '../../../src/utils/text'
import { CANARIO } from './states'

export type Verificacao = { ok: true } | { ok: false; motivo: string }

const luhn = (digitos: string): boolean => {
  let soma = 0
  let dobra = false
  for (let i = digitos.length - 1; i >= 0; i--) {
    let n = digitos.charCodeAt(i) - 48
    if (dobra) { n *= 2; if (n > 9) n -= 9 }
    soma += n
    dobra = !dobra
  }
  return soma % 10 === 0
}

const PADROES: { nome: string; teste: (t: string) => boolean }[] = [
  { nome: 'CPF', teste: t => /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(t) },
  { nome: 'CNPJ', teste: t => /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/.test(t) },
  { nome: 'e-mail', teste: t => /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(t) },
  { nome: 'telefone', teste: t => /\(\d{2}\)\s?9?\d{4}-?\d{4}|\+55\s?\d{2}\s?9?\d{4}-?\d{4}/.test(t) },
  {
    nome: 'número de cartão',
    teste: t => [...t.matchAll(/\b(?:\d[ -]?){13,19}\b/g)].some(m => {
      const d = m[0].replace(/\D/g, '')
      return d.length >= 13 && d.length <= 19 && luhn(d)
    }),
  },
  { nome: 'chave de API', teste: t => /\bsk-[A-Za-z0-9_-]{12,}/.test(t) },
  { nome: 'token JWT', teste: t => /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(t) },
  { nome: 'CEP', teste: t => /\b\d{5}-\d{3}\b/.test(t) },
]

export function verificaCorpo(corpo: string, opts: { chave?: string | null }): Verificacao {
  if (opts.chave && opts.chave.length >= 8 && corpo.includes(opts.chave)) {
    return { ok: false, motivo: 'a chave da API apareceu no corpo da requisição' }
  }
  for (const p of PADROES) {
    if (p.teste(corpo)) return { ok: false, motivo: `padrão de dado pessoal no corpo: ${p.nome}` }
  }
  // O nome do usuário não vai mais ao modelo: se o canário aparecer no corpo, é
  // o nome que voltou a vazar.
  if (corpo.includes(CANARIO)) return { ok: false, motivo: 'o nome do usuário (canário) apareceu no corpo da requisição' }
  return { ok: true }
}

export function verificaEstado(state: AppState): Verificacao {
  return state?.settings?.name === CANARIO
    ? { ok: true }
    : { ok: false, motivo: 'estado sem o canário sintético — só estados de tests/assistant/eval/states.ts podem ser enviados' }
}

/** Contexto de planejamento: todo nome de categoria, cartão e meta tem que ser sintético. */
export function verificaVocabulario(contexto: any, vocabulario: Set<string>): Verificacao {
  const nomes: string[] = [
    ...(contexto?.categorias || []).flatMap((c: any) => [c?.id, c?.name]),
    ...(contexto?.cartoes || []).map((c: any) => c?.nome),
    ...(contexto?.metasDeCompra || []).map((g: any) => g?.nome),
  ].filter((x: any) => typeof x === 'string')
  for (const n of nomes) {
    if (!vocabulario.has(normalizeName(n))) return { ok: false, motivo: `nome fora do vocabulário sintético: "${n}"` }
  }
  return { ok: true }
}

/** Predicado explícito — sob `strict: false` o `if (!v.ok)` não estreita a união (regra 24). */
export const falhou = (v: Verificacao): v is { ok: false; motivo: string } => v.ok === false
