// Qual aba da barra inferior está ativa.
//
// PRINCÍPIO: a decisão mora AQUI, uma vez só. Antes ela era uma lista de rotas
// copiada à mão dentro de `nav.tsx` e casada por `startsWith` — uma segunda
// fonte de verdade, paralela ao roteador, que já produzia dois erros reais:
//
//   `#/relatorios`     → o coringa renderiza a Home, e nenhuma aba ficava verde;
//   `#/config/backup`  → o coringa renderiza a Home, e "Mais" ficava verde,
//                        apontando para uma seção que não estava na tela.
//
// A regra é: **a aba marcada é sempre a aba da tela que o roteador renderiza.**

export type NavTabId = '/' | '/movimentacoes' | '/assistente' | '/metas' | '/mais'

/**
 * Rota → aba. Toda rota declarada em `App.tsx` precisa estar aqui; um teste do
 * núcleo compara os dois e falha quando uma rota nova é esquecida.
 *
 * O casamento é EXATO de propósito. `App.tsx` não declara rota aninhada
 * nenhuma, então `/config/backup` cai no coringa e mostra a Home — marcar
 * "Mais" ali seria mentir sobre o que está na tela.
 */
const ROUTE_TAB: Record<string, NavTabId> = {
  '/': '/',
  '/movimentacoes': '/movimentacoes',
  '/assistente': '/assistente',
  '/metas': '/metas',
  '/mais': '/mais',
  '/analises': '/mais',
  '/veiculo': '/mais',
  '/corrida': '/mais',
  '/planejamento': '/mais',
  '/cartoes': '/mais',
  '/config': '/mais',
}

/** Aba da rota coringa (`path="*"`, que renderiza a Home). */
const FALLBACK_TAB: NavTabId = '/'

/** As rotas que a aba "Mais" abre — derivadas do mapa, nunca redigitadas. */
export const MORE_ROUTES: string[] =
  Object.keys(ROUTE_TAB).filter(p => p !== '/mais' && ROUTE_TAB[p] === '/mais')

/** `/Analises/` e `/analises` são a mesma rota; `//` e `''` são a raiz. */
const normalize = (pathname: string): string => {
  const limpo = String(pathname || '/').trim().toLowerCase().replace(/\/+$/, '')
  return limpo || '/'
}

/**
 * Aba ativa para um caminho. Nunca devolve vazio: uma rota que o app não
 * conhece renderiza a Home, então a aba marcada é a Início.
 */
export function activeTab(pathname: string): NavTabId {
  return ROUTE_TAB[normalize(pathname)] ?? FALLBACK_TAB
}
