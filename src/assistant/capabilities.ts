// O que ESTE usuário pode fazer: perfil, categorias, cartões e metas que ele
// realmente tem.
//
// Mora sozinho por causa de um ciclo de import: `services/ai.ts` precisa das
// capacidades para montar o contexto remoto, e o orquestrador precisa de
// `askAssistant` para falar com a IA. Os dois se importavam, e o ciclo só não
// quebrava porque `function` é içada — qualquer refatoração que movesse a
// chamada para o topo do módulo viraria um `undefined is not a function` em
// produção, onde o empacotador decide a ordem de inicialização.

import type { AppState } from '../models/types'
import type { AssistantCapabilities } from './contracts'
import { isDriver } from '../services/profile'
import { usableCategories } from '../data/categories'

export function buildCapabilities(state: AppState): AssistantCapabilities {
  const driver = isDriver(state.settings)
  return {
    profile: state.settings.profile,
    isDriver: driver,
    kinds: [],
    categories: usableCategories(state.categories).map(c => ({ id: c.id, name: c.name, type: c.type })),
    cardNames: (state.cards || []).filter(c => !c.archived).map(c => c.name),
    goalNames: state.goals.filter(g => !g.done).map(g => g.name),
  }
}
