// SUGESTÕES da tela do assistente, montadas com a vida DESTE usuário.
//
// A lista fixa por perfil é o ponto de partida, não a resposta: quem tem uma
// meta chamada "Moto" quer ver quanto falta pra ela, e quem lança "Zé da
// esquina" toda semana ganha mais com um atalho para isso do que com um exemplo
// genérico. Mas os exemplos genéricos NUNCA somem: eles ensinam o que dá para
// fazer, e quem nunca usou cartão nem meta não descobriria sozinho.
//
// Quatro coisas que uma sugestão não pode ser:
//
// 1. UMA PREVISÃO DE GASTO. O atalho vem sem valor de propósito. Pôr o valor
//    histórico ali dentro seria o app afirmando quanto o usuário gastou hoje —
//    e um toque distraído viraria um lançamento inventado. Sem valor, o
//    assistente pergunta "qual foi o valor?", que é a conversa mais curta
//    possível e ainda passa pelo Confirmar.
// 2. UM PALPITE SOBRE QUEM ELE É. "Quanto falta pra minha moto" vira "minha
//    notebook" no cliente seguinte: flexionar o nome da meta é inventar gênero.
//    A forma neutra ("Quanto falta para a meta Notebook?") serve para todos.
// 3. CINCO VARIAÇÕES DA MESMA COISA. Duas sugestões sobre o mesmo assunto
//    ocupam o lugar de duas perguntas que o usuário ainda não sabe que pode
//    fazer.
// 4. DADO DE MOTORISTA EM OUTRO PERFIL. Vale aqui a mesma regra 3 do projeto.

import type { AppState } from '../models/types'
import { normalizeName, sentenceCase } from '../utils/text'
import { fromISO, todayISO } from '../utils/format'
import { isDriver } from '../services/profile'
import { currentBalance, kmCost, upcomingBills } from '../services/calc'
import { adaptiveEnabled, buildPersonalModel } from './personalModel'

/**
 * O usuário precisa saber o que vai acontecer ANTES de tocar. `shortcut` começa
 * um registro (e vai parar num Confirmar); `question` só consulta e nunca mexe
 * em nada.
 */
export type SuggestionKind = 'question' | 'shortcut'

export interface Suggestion {
  text: string
  kind: SuggestionKind
  /** Assunto, usado só para não repetir o mesmo tema duas vezes na fileira. */
  topic: string
}

const q = (text: string, topic: string): Suggestion => ({ text, kind: 'question', topic })
const s = (text: string, topic: string): Suggestion => ({ text, kind: 'shortcut', topic })

/**
 * Exemplos que ensinam o app. Ficam aqui, e não na tela, para que "sugestões"
 * seja um módulo só — a tela não decide mais o que sugerir.
 */
const BASE_POR_PERFIL: Record<string, Suggestion[]> = {
  driver: [
    q('Quanto posso gastar hoje?', 'folga'),
    q('Como está minha meta?', 'meta-dia'),
    q('Quanto gastei com gasolina esse mês?', 'combustivel'),
    q('Quando preciso trocar meu óleo?', 'manutencao'),
    q('Quanto meu carro custa por km?', 'custo-km'),
    s('ganhei 250 hoje', 'registro-ganho'),
    s('ganhei 430 na Uber e 399 na 99, rodei 161 km', 'registro-dia'),
  ],
  autonomo: [
    q('Como está meu mês?', 'mes'),
    q('Quanto recebi de aluguéis este mês?', 'entradas'),
    q('Tenho saldo para as próximas contas?', 'saldo'),
    q('Quanto posso guardar este mês?', 'guardar'),
    s('recebi 1800 de aluguel da Casa 1', 'registro-entrada'),
    s('ontem gastei 150 de areia', 'registro-gasto'),
  ],
  clt: [
    q('Meu salário cobre minhas contas?', 'saldo'),
    q('Quanto tenho de parcela no mês que vem?', 'cartao'),
    q('Quanto posso guardar este mês?', 'guardar'),
    q('Como está minha meta mensal?', 'meta-mes'),
    s('recebi meu salário de 3000 e guardei 150', 'registro-entrada'),
  ],
  other: [
    q('Como está meu mês?', 'mes'),
    q('Quanto posso guardar este mês?', 'guardar'),
    q('Tenho saldo para as próximas contas?', 'saldo'),
    q('Qual foi minha maior despesa?', 'maior-gasto'),
    s('gastei 80 no mercado', 'registro-gasto'),
  ],
}

export const baseSuggestionsFor = (profile: string): Suggestion[] =>
  BASE_POR_PERFIL[profile] || BASE_POR_PERFIL.other

/**
 * Palavras que o app não repete de volta, mesmo tendo sido o usuário quem
 * escreveu. Ele pode chamar um lugar do que quiser no histórico dele; a tela
 * inicial do assistente é outra coisa, e devolver isso em letra grande num
 * botão não é personalização, é falta de educação.
 */
const OFENSIVAS = /\b(?:merd|porr|caral|fod|puta|puto|buce|cuzã|cuzao|viad|krl|pqp|desgraç|desgrac|arrombad|otári|otari|babac|imbecil|idiot)/i

/** Nome de lugar bom o bastante para virar botão. */
const usavelComoAtalho = (texto: string): boolean => {
  const t = texto.trim()
  if (t.length < 3 || t.length > 32) return false
  if (OFENSIVAS.test(t)) return false
  // Um número solto ("35", "R$ 40") não é nome de lugar — é o valor que alguém
  // digitou no campo errado, e virar atalho de registro daria a ele uma
  // segunda vida que ninguém pediu.
  if (!/[a-zà-ú]{3}/i.test(t)) return false
  return true
}

export interface SuggestionContext {
  today?: string
  /** Injetável: sugestão por horário não pode depender do relógio nos testes. */
  now?: Date
}

/**
 * A fileira de sugestões do assistente.
 *
 * Ordem: primeiro o que é DESTE usuário (meta ativa, conta chegando, lugar que
 * ele repete, dado que falta), depois os exemplos que ensinam o app. Nunca mais
 * de duas do mesmo assunto, e nunca mais de dois atalhos de registro.
 */
export function assistantSuggestions(state: AppState, ctx: SuggestionContext = {}): Suggestion[] {
  const today = ctx.today || todayISO()
  const base = baseSuggestionsFor(state.settings.profile)
  const driver = isDriver(state.settings)
  const minhas: Suggestion[] = []

  if (adaptiveEnabled(state)) {
    const model = buildPersonalModel(state, today)
    const agora = ctx.now || fromISO(today)
    const hora = ctx.now ? agora.getHours() : 12
    const fimDeSemana = agora.getDay() === 0 || agora.getDay() === 6
    const diaDoMes = fromISO(today).getDate()

    // 1. Conta chegando é o que muda a decisão de hoje — vem antes de tudo.
    const contas = upcomingBills(state, 7)
    if (contas.length) minhas.push(q('Quais contas vencem nos próximos dias?', 'contas'))

    // 2. Meta ativa, na forma NEUTRA: flexionar "minha moto"/"minha notebook"
    //    é inventar gênero, e o nome da meta é escrito pelo usuário.
    const meta = (state.goals || []).find(g => !g.done && g.name?.trim())
    if (meta) minhas.push(q(`Quanto falta para a meta ${sentenceCase(meta.name.trim())}?`, 'meta-compra'))

    // 3. O lugar que ele mais repete, na grafia dele e SEM valor.
    for (const lugar of model.frequentPlaces('expense', 3)) {
      if (lugar.sampleSize < 3 || !usavelComoAtalho(lugar.text)) continue
      // "em" serve para os dois gêneros: "gastei em Zé da esquina", "gastei em
      // Água". "no água" e "no gasolina" eram o app errando português.
      minhas.push(s(`gastei em ${sentenceCase(lugar.text.trim())}`, `lugar:${normalizeName(lugar.text)}`))
      break
    }

    // 4. Dado que falta — cada um destrava uma conta que hoje não existe.
    if (driver && kmCost(state).total <= 0) {
      minhas.push(s('botei 100 de gasolina, hodômetro 220000', 'custo-km'))
    }
    if (currentBalance(state) === 0) {
      minhas.push(s('meu saldo é 1500', 'saldo'))
    }

    // 5. Horário e dia. São perguntas que o motor local responde com certeza —
    //    sugerir algo que cai no texto genérico de ajuda seria pior que nada.
    if (driver) {
      if (hora >= 17) minhas.push(q('Como está minha meta?', 'meta-dia'))
      else if (hora <= 11) minhas.push(q('Quanto preciso fazer hoje?', 'meta-dia'))
      if (fimDeSemana) minhas.push(q('Qual foi meu melhor dia?', 'melhor-dia'))
    } else if (diaDoMes >= 25) {
      minhas.push(q('Como está meu mês?', 'mes'))
    } else if (diaDoMes <= 7) {
      minhas.push(q('Quanto posso guardar este mês?', 'guardar'))
    }
  }

  return diversificar([...minhas, ...base])
}

/**
 * No máximo uma sugestão por assunto e no máximo dois atalhos de registro.
 * A fileira é curta; gastá-la com variações da mesma coisa tira do usuário as
 * perguntas que ele ainda não sabe que pode fazer.
 */
function diversificar(todas: Suggestion[]): Suggestion[] {
  const out: Suggestion[] = []
  const temas = new Set<string>()
  const textos = new Set<string>()
  let atalhos = 0
  for (const sug of todas) {
    const chave = normalizeName(sug.text)
    if (textos.has(chave) || temas.has(sug.topic)) continue
    if (sug.kind === 'shortcut' && atalhos >= 2) continue
    temas.add(sug.topic)
    textos.add(chave)
    if (sug.kind === 'shortcut') atalhos++
    out.push(sug)
    if (out.length >= 6) break
  }
  return out
}

/**
 * Compatibilidade: a forma antiga devolvia só os textos. Mantida porque o
 * corpus e o restante do código ainda a usam em alguns pontos.
 */
export function personalSuggestions(state: AppState, base: string[], today = todayISO()): string[] {
  if (!adaptiveEnabled(state)) return base
  const minhas = assistantSuggestions(state, { today })
    .filter(x => !base.some(b => normalizeName(b) === normalizeName(x.text)))
    .map(x => x.text)
  return [...minhas, ...base]
}
