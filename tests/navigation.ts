// Aba ativa da barra inferior.
//
// Cada caso abaixo foi reproduzido no navegador ANTES da correção, em 375×812:
// rota desconhecida deixava a barra sem nenhum indicador, e um subcaminho
// inexistente deixava "Mais" verde enquanto a tela renderizada era a Início.
//
// A regra que estes testes protegem é uma só: **a aba marcada é sempre a aba da
// tela que o roteador realmente renderiza**.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MORE_ROUTES, activeTab } from '../src/services/navigation'

export function runNavigationTests(): number {
  let n = 0
  const check = (name: string, fn: () => void) => { n++; try { fn() } catch (e: any) { throw new Error(`${name}: ${e.message}`) } }

  // --- 1. Toda rota aberta pela aba "Mais" mantém "Mais" marcada ----------
  check('rotas de Mais marcam a aba Mais', () => {
    for (const rota of ['/mais', ...MORE_ROUTES]) {
      assert.equal(activeTab(rota), '/mais', `${rota} deveria marcar Mais`)
    }
  })

  // --- 2. As demais abas continuam corretas -------------------------------
  check('abas próprias continuam corretas', () => {
    assert.equal(activeTab('/'), '/')
    assert.equal(activeTab('/movimentacoes'), '/movimentacoes')
    assert.equal(activeTab('/assistente'), '/assistente')
    assert.equal(activeTab('/metas'), '/metas')
  })

  // --- 3. Rota desconhecida cai na aba que a rota coringa RENDERIZA -------
  // `<Route path="*" element={<Home />} />`: a tela é a Início, então a aba
  // marcada tem que ser Início. Antes não havia indicador nenhum.
  check('rota desconhecida marca a aba da tela renderizada', () => {
    for (const rota of ['/relatorios', '/analytics', '/qualquer', '/config-antigo']) {
      assert.equal(activeTab(rota), '/', `${rota} deveria marcar Início (a tela é a Home)`)
    }
  })

  // --- 4. Subcaminho inexistente não pode mentir --------------------------
  // `/config/backup` também cai no coringa e renderiza a Home. Marcar "Mais"
  // apontava para uma seção que não estava na tela.
  check('subcaminho inexistente não marca Mais', () => {
    for (const rota of ['/config/backup', '/cartoes/fatura', '/mais/analises', '/metas/2026']) {
      assert.equal(activeTab(rota), '/', `${rota} não deveria marcar outra aba (a tela é a Home)`)
    }
  })

  // --- 5. Barra grudenta: sempre existe uma aba marcada -------------------
  check('nunca fica sem indicador', () => {
    for (const rota of ['/', '/mais', '/analises', '/qualquer', '/x/y/z', '']) {
      assert.ok(activeTab(rota), `${rota || '(vazio)'} ficou sem aba ativa`)
    }
  })

  // --- 6. Barra final e caixa não mudam a aba -----------------------------
  check('barra final e caixa são normalizadas', () => {
    assert.equal(activeTab('/analises/'), '/mais')
    assert.equal(activeTab('/CONFIG'), '/mais')
    assert.equal(activeTab('//'), '/')
  })

  // --- 7. O mapa e o roteador não podem divergir --------------------------
  // Foi exatamente a divergência entre os dois que criou o defeito: a lista
  // vivia em `nav.tsx` e era esquecida quando uma rota nova entrava no App.
  check('o mapa cobre exatamente as rotas do App', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const declaradas = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]).filter(p => p !== '*')
    assert.ok(declaradas.length >= 11, `só ${declaradas.length} rotas encontradas em App.tsx`)
    for (const rota of declaradas) {
      assert.ok(activeTab(rota), `rota ${rota} do App.tsx não está mapeada para nenhuma aba`)
    }
    for (const rota of MORE_ROUTES) {
      assert.ok(declaradas.includes(rota), `${rota} está no mapa mas não existe em App.tsx`)
    }
  })

  // --- 8. `nav.tsx` não pode ter uma segunda lista de rotas ---------------
  check('nav.tsx não decide sozinho qual aba está ativa', () => {
    const nav = readFileSync(new URL('../src/components/nav.tsx', import.meta.url), 'utf8')
    // Só o BottomNav: o FAB casa rota para escolher a ação do +, que é outra
    // responsabilidade e continua onde está.
    const inicio = nav.indexOf('export function BottomNav')
    const barra = nav.slice(inicio, nav.indexOf('type SheetKind'))
    assert.ok(inicio > 0 && barra.length > 0, 'não encontrei o BottomNav')
    assert.ok(/activeTab\(/.test(barra), 'BottomNav não usa activeTab')
    assert.ok(!/startsWith/.test(barra), 'BottomNav ainda casa rota por startsWith')
    assert.ok(!/moreRoutes/.test(nav), 'a lista de rotas duplicada voltou para nav.tsx')
  })

  // --- 9. Toda rota de "Mais" é oferecida pelo hub ------------------------
  check('o hub Mais oferece as rotas da seção', () => {
    const more = readFileSync(new URL('../src/screens/More.tsx', import.meta.url), 'utf8')
    const oferecidas = [...more.matchAll(/to:\s*'([^']+)'/g)].map(m => m[1])
    for (const rota of oferecidas) {
      assert.equal(activeTab(rota), '/mais', `${rota} é oferecida em Mais mas não marca a aba Mais`)
    }
  })

  return n
}
