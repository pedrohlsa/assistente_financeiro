// APLICAÇÃO do que o app aprendeu com o PRÓPRIO usuário.
//
// Quem CONSTRÓI o conhecimento é `personalModel.ts`. Aqui só se decide o que
// fazer com ele — e a resposta quase sempre é "quase nada": aprender muda o que
// é PROPOSTO, e a proposta continua precisando do botão Confirmar (regra 8).
//
// A hierarquia é fixa e o aprendizado ocupa o penúltimo degrau:
//
//   1. regra financeira e segurança      ← nada aqui pode chegar perto
//   2. validação determinística          ← toda categoria aprendida passa por ela
//   3. o que o usuário disse AGORA       ← valor, data, tipo, origem: intocáveis
//   4. preferência confirmada por ele
//   5. padrão histórico com evidência    ← é este módulo
//   6. lista genérica do app
//   7. IA remota, só para o que sobrou
//
// O que o aprendizado PODE fazer: preencher uma categoria que ninguém informou,
// contrariar a lista genérica quando o histórico é forte e consistente,
// restaurar a grafia que o próprio usuário já escreveu, e AVISAR sobre um valor
// fora do padrão dele.
//
// O que ele NUNCA pode fazer: registrar, alterar valor, data ou tipo, criar
// taxa, escolher cartão, pagar fatura, desfazer, apagar, mexer no histórico, ou
// escolher entre duas entidades ambíguas sem perguntar.

import type { AppState, ParsedAction } from '../models/types'
import { preferenceCategoryFor } from './preferences'
import { usableCategories } from '../data/categories'
import { fmtBRL, todayISO } from '../utils/format'
import { adaptiveEnabled, ageInDays, buildPersonalModel } from './personalModel'
import type { LearnedPattern, MoneyType, PersonalAssistantModel } from './personalModel'
import { median, medianAbsoluteDeviation } from './statistics'
import { normalizeName } from '../utils/text'

export { adaptiveEnabled, buildPersonalModel } from './personalModel'
export type { LearnedPattern, PersonalAssistantModel } from './personalModel'

const isMoney = (kind: ParsedAction['kind']): kind is MoneyType =>
  kind === 'income' || kind === 'expense'

/** O texto que identifica o lançamento: o que o usuário escreveu sobre ele. */
const entityText = (a: any): string => String(a.description || a.origin || '').trim()

/**
 * Categoria que o usuário costuma dar para este texto, com a evidência junto.
 *
 * `strength` é o que separa os dois usos possíveis: `strong` basta para
 * preencher um campo vazio; contrariar um palpite da lista genérica exige
 * `overriding`, porque discordar do app é afirmar que o usuário já corrigiu
 * aquilo várias vezes.
 */
export function learnedCategory(
  state: AppState,
  texto: string,
  tipo: MoneyType,
  today = todayISO(),
): LearnedPattern<string> | undefined {
  return buildPersonalModel(state, today).categoryFor(texto, tipo)
}

/**
 * A grafia que o usuário já usou para este mesmo lugar.
 *
 * Ele escreveu "Zé da esquina" três vezes e agora digitou sem acento, no
 * celular, com pressa. Sem isto a lista de movimentações fica com "Ze da
 * esquina" ao lado de "Zé da esquina" parecendo dois lugares diferentes — e o
 * próprio aprendizado enfraquece, porque o histórico se divide.
 *
 * Só entra quando o texto é O MESMO ignorando acento e caixa. Nada de
 * aproximação: trocar a descrição por algo que o usuário não escreveu seria
 * inventar, e a fase 4 é explícita — nenhuma aproximação pode trocar uma
 * entidade por outra em silêncio.
 */
export function canonicalDescription(
  state: AppState,
  texto: string,
  tipo: MoneyType,
  today = todayISO(),
  campo: 'description' | 'origin' = 'description',
): string | undefined {
  const p = buildPersonalModel(state, today).spellingFor(texto, tipo, campo)
  if (!p) return undefined
  return p.value === texto ? undefined : p.value
}

/** Por que a categoria da proposta ficou assim — matéria-prima da explicação. */
export interface CategoryDecision {
  applied: boolean
  /** `fill` preencheu um vazio; `override` discordou da lista genérica. */
  how?: 'fill' | 'override'
  pattern?: LearnedPattern<string>
  /** Dois candidatos fortes e próximos: quem decide é o usuário. */
  dilemma?: { a: string; b: string }
}

function decideCategory(
  model: PersonalAssistantModel,
  state: AppState,
  action: ParsedAction,
): CategoryDecision {
  if (!isMoney(action.kind)) return { applied: false }
  const a: any = action
  const texto = entityText(a)
  if (!texto) return { applied: false }

  const p = model.categoryFor(texto, action.kind)
  if (!p) return { applied: false }

  // Defesa em profundidade: o modelo só indexa categoria oferecível, mas se
  // isso mudar aqui a proposta não pode sair com uma categoria que a validação
  // vai recusar — foi exatamente assim que o gasto no Clube sumiu inteiro
  // depois de o usuário arquivar "lazer".
  if (!usableCategories(state.categories || []).some(c => c.id === p.value)) return { applied: false }

  if (!a.category) {
    if (p.strength === 'strong' || p.strength === 'overriding') {
      return { applied: true, how: 'fill', pattern: p }
    }
    return { applied: false, pattern: p }
  }
  if (a.category !== p.value && p.strength === 'overriding') {
    return { applied: true, how: 'override', pattern: p }
  }
  return { applied: false, pattern: p }
}

/**
 * Aplica o vocabulário e a grafia do usuário à ação.
 *
 * Nunca toca em valor, data, tipo, origem informada ou qualquer campo que o
 * usuário tenha dito nesta mensagem: só categoria e grafia, e só quando a
 * evidência sustenta.
 */
export function withLearnedCategory(
  state: AppState,
  action: ParsedAction,
  today = todayISO(),
  message = '',
): ParsedAction {
  if (!isMoney(action.kind)) return action
  const a: any = action
  if (!entityText(a)) return action

  // Uma categoria nomeada neste turno ganha da preferência guardada. O
  // classificador genérico pode ter preenchido `category` sem o usuário citá-la,
  // por isso só usamos o texto atual como prova de escolha explícita.
  const said = normalizeName(message)
  const explicit = (state.categories || []).some(c => c.id === a.category &&
    ['em', 'na', 'no', 'categoria', 'como'].some(prefix => said.includes(`${prefix} ${normalizeName(c.name)}`)))
  if (explicit) return action

  // Preferência ensinada explicitamente é evidência estruturada e vem antes do
  // histórico inferido. Continua limitada à categoria/grafia: nunca toca em
  // valor, tipo, data ou confirmação.
  const preferred = preferenceCategoryFor(state, entityText(a)!, action.kind)
  if (preferred) return { ...action, category: preferred } as ParsedAction

  if (!adaptiveEnabled(state)) return action
  const model = buildPersonalModel(state, today)

  let out: any = action

  // A grafia dele ganha da que ele digitou com pressa — na descrição e na
  // origem. Sem a origem, "casa 1" e "Casa 1" viravam dois imóveis.
  if (a.description) {
    const g = model.spellingFor(a.description, action.kind, 'description')
    if (g && g.value !== a.description) out = { ...out, description: g.value }
  }
  if (a.origin) {
    const g = model.spellingFor(a.origin, action.kind, 'origin')
    if (g && g.value !== a.origin) out = { ...out, origin: g.value }
  }

  const d = decideCategory(model, state, action)
  return d.applied ? { ...out, category: d.pattern!.value } : out
}

/** A decisão de categoria, sem aplicar — para explicar e para perguntar. */
export function categoryDecision(
  state: AppState,
  action: ParsedAction,
  today = todayISO(),
): CategoryDecision {
  if (!adaptiveEnabled(state)) return { applied: false }
  return decideCategory(buildPersonalModel(state, today), state, action)
}

/**
 * Duas categorias fortes disputando a mesma frase.
 *
 * O usuário lança no Quiosque tanto em Lazer quanto em Compras. Escolher uma
 * seria dar cara de certeza a um sorteio, e ignorar as duas joga fora uma
 * informação que ele já deu. A saída é a mesma do resto do app: perguntar, com
 * as duas opções já carregando a proposta pronta.
 */
export function categoryDilemma(
  state: AppState,
  action: ParsedAction,
  today = todayISO(),
): { entity: string; options: string[] } | undefined {
  if (!adaptiveEnabled(state) || !isMoney(action.kind)) return undefined
  const a: any = action
  // Campo já preenchido não é dilema: a lista genérica deu um palpite e ele
  // fica, porque discordar exige evidência forte de UM lado só.
  if (a.category) return undefined
  const texto = entityText(a)
  if (!texto) return undefined

  const model = buildPersonalModel(state, today)
  // `categoryFor` devolve `undefined` justamente por causa do empate. O dilema
  // só existe quando cada ponta, sozinha, bastaria para preencher o campo —
  // senão a resposta certa continua sendo calar e usar a lista genérica.
  if (model.categoryFor(texto, action.kind)) return undefined
  const bruto = model.rawCandidates(texto, action.kind)
  if (bruto.length < 2) return undefined
  const [x, y] = bruto
  if (y.weight < x.weight * 0.7) return undefined
  if (x.weight < PESO_PARA_PERGUNTAR || y.weight < PESO_PARA_PERGUNTAR) return undefined
  const usable = new Set(usableCategories(state.categories || []).map(c => c.id))
  if (!usable.has(x.category) || !usable.has(y.category)) return undefined
  return { entity: texto, options: [x.category, y.category] }
}

/** Cada lado do dilema precisa, sozinho, de evidência de preencher um vazio. */
const PESO_PARA_PERGUNTAR = 1.7

/**
 * Sugestões da tela do assistente. Mora em `suggestions.ts`; reexportado aqui
 * só enquanto a tela não migra.
 */
export { personalSuggestions } from './suggestions'

// ---------------------------------------------------------------------------
// Ordem de grandeza
// ---------------------------------------------------------------------------

/** Quantas vezes acima da mediana já é quase certamente um zero a mais. */
const FATOR = 6

export function merchantAmountProfile(
  state: AppState, action: ParsedAction, today = todayISO(),
): { median: number; sampleSize: number; from: string; to: string; name: string } | undefined {
  if (!isMoney(action.kind)) return undefined
  const a: any = action
  const field = a.origin ? 'origin' : a.description ? 'description' : undefined
  const name = field ? String(a[field] || '').trim() : ''
  if (!field || normalizeName(name).length < 2 || !a.category) return undefined
  const seenIds = new Set<string>()
  const rows = (state.transactions || [])
    .filter(t => t?.type === action.kind && t.category === a.category
      && t.date <= today && ageInDays(t.date, today) >= 0 && ageInDays(t.date, today) <= 120
      && Number.isFinite(t.amount) && t.amount > 0
      && normalizeName(String((t as any)[field] || '')) === normalizeName(name))
    .sort((x, y) => y.date.localeCompare(x.date))
    .filter(t => {
      if (!t.id) return true
      if (seenIds.has(t.id)) return false
      seenIds.add(t.id)
      return true
    })
    .slice(0, 60)
  if (rows.length < 6) return undefined
  const values = rows.map(t => t.amount)
  const center = median(values)
  const mad = medianAbsoluteDeviation(values, center)
  if (!(center > 0) || mad > center * 0.25) return undefined
  return { median: center, sampleSize: rows.length, from: rows[rows.length - 1].date, to: rows[0].date, name }
}

/**
 * Aviso quando o valor está muito fora do que o usuário costuma lançar.
 *
 * Compara com lançamentos do MESMO tipo e da MESMA categoria: o padrão de
 * combustível não diz nada sobre o padrão de aluguel. Devolve `undefined`
 * quando não há amostra suficiente — sem base, calar é melhor que alarmar.
 *
 * AVISA, nunca bloqueia: o dia excepcional existe, e barrá-lo seria pior que o
 * erro de digitação que se quer evitar (regra 38).
 */
export function outOfPatternWarning(
  state: AppState,
  action: ParsedAction,
  today = todayISO(),
): string | undefined {
  if (!isMoney(action.kind)) return undefined
  if (!adaptiveEnabled(state)) return undefined
  const a: any = action
  const valor = Number(a.amount)
  if (!(valor > 0) || !a.category) return undefined
  // Um lançamento retroativo não deve ser comparado com o preço de hoje.
  // Sem data explícita, a proposta é de hoje; datas futuras também não têm base.
  const age = a.date ? ageInDays(a.date, today) : 0
  if (age < 0 || age > 120) return undefined

  // Identidade exata, no mesmo tipo e categoria. Sem seis ocorrências recentes
  // e estáveis, um lugar novo ou de preço variável não gera alerta.
  const name = String(a.description || a.origin || '').trim()
  if (name) {
    const p = merchantAmountProfile(state, action, today)
    if (p && valor >= p.median * 4) {
      return `Esse valor está bem acima do seu padrão recente em ${p.name}. Confirma ${fmtBRL(valor)}?`
    }
    return undefined
  }

  const p = buildPersonalModel(state, today).amountProfile(action.kind, a.category)
  if (!p) return undefined

  if (valor >= p.median * FATOR) {
    return `Bem acima do seu normal — nos seus ${p.sampleSize} últimos lançamentos dessa categoria o valor fica perto de ${fmtBRL(p.median)}. Confere se não sobrou um zero.`
  }
  if (valor * FATOR <= p.median) {
    return `Bem abaixo do seu normal — nos seus ${p.sampleSize} últimos lançamentos dessa categoria o valor fica perto de ${fmtBRL(p.median)}. Confere se não faltou um dígito.`
  }
  return undefined
}
