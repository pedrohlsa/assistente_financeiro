// Sugestões da tela do assistente, montadas com a vida DESTE usuário.
//
// A lista fixa por perfil é o ponto de partida, não a resposta: quem tem uma
// meta chamada "Moto" quer ver quanto falta pra ela, e quem lança "Mercado"
// toda semana ganha mais com um atalho para isso do que com um exemplo
// genérico. O atalho vem SEM valor de propósito — o assistente pergunta quanto
// foi, que é a conversa mais curta possível, e um valor histórico dentro de uma
// ação pronta seria o app inventando quanto o usuário gastou.
//
// As sugestões da lista fixa nunca somem: elas ensinam o que dá para fazer.

import type { AppState } from '../models/types'
import { normalizeName } from '../utils/text'
import { adaptiveEnabled, buildPersonalModel } from './personalModel'
import { todayISO } from '../utils/format'

export function personalSuggestions(state: AppState, base: string[], today = todayISO()): string[] {
  if (!adaptiveEnabled(state)) return base
  const model = buildPersonalModel(state, today)
  const minhas: string[] = []

  const meta = (state.goals || []).find(g => !g.done && g.name)
  if (meta) minhas.push(`Quanto falta pra minha ${meta.name.toLowerCase()}?`)

  const campeao = model.frequentPlaces('expense', 1)[0]
  if (campeao && campeao.sampleSize >= 3) minhas.push(`gastei no ${campeao.text.toLowerCase()}`)

  const vistas = new Set(minhas.map(s => normalizeName(s)))
  return [...minhas, ...base.filter(s => !vistas.has(normalizeName(s)))]
}
