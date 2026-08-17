// Corpus ADAPTATIVO — o que o app aprende com o PRÓPRIO usuário.
//
// A lista de palavras-chave de categoria é genérica e sempre vai errar em nome
// de lugar ("Zé da esquina", "seu Manoel", "posto do Tião"). O histórico do
// usuário, esse é dele: se ele já classificou aquilo três vezes, o app tem a
// resposta e não precisa perguntar nem chutar de novo.
//
// Garantias que estes casos protegem:
//  1. Aprender exige REPETIÇÃO — um lançamento isolado não vira regra.
//  2. Nada é gravado sozinho: aprender muda o que é PROPOSTO, e a proposta
//     continua precisando do Confirmar (regra 8).
//  3. O comportamento RECENTE pesa mais que o antigo, sem que o antigo suma de
//     um dia para o outro.
//  4. Palavra genérica isolada ("casa", "mercado", "posto") não identifica
//     lugar nenhum — o que identifica é a FRASE.
//  5. Categoria arquivada nunca é aplicada, e o lançamento nunca morre por
//     causa de um palpite do aprendizado.
//  6. Dois clientes com a mesma frase e históricos diferentes recebem
//     respostas diferentes; com o mesmo histórico, respostas iguais.
//
// A numeração `ad-NN` é contínua com a rodada anterior de propósito: cada caso
// novo nasceu de um defeito REAL encontrado na auditoria adversarial de
// 17/08/2026, e o número é o rastro dessa origem.

import type { AssistantCase } from './harness'

const other = { profile: 'other' as const }
const driver = { profile: 'driver' as const }
const autonomo = { profile: 'autonomo' as const }
const clt = { profile: 'clt' as const }

/** Um lugar que nenhuma lista de palavras-chave conhece. */
const historicoZe = {
  transactions: [
    { id: 'z1', type: 'expense', amount: 22, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-01' },
    { id: 'z2', type: 'expense', amount: 18, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-05' },
    { id: 'z3', type: 'expense', amount: 25, category: 'alimentacao', description: 'Zé da esquina', date: '2026-07-09' },
  ],
}

/** O usuário insiste que mercado é COMPRAS, não alimentação. */
const historicoMercado = {
  transactions: [
    { id: 'm1', type: 'expense', amount: 120, category: 'compras', description: 'Mercado', date: '2026-07-01' },
    { id: 'm2', type: 'expense', amount: 90, category: 'compras', description: 'Mercado', date: '2026-07-04' },
    { id: 'm3', type: 'expense', amount: 140, category: 'compras', description: 'Mercado', date: '2026-07-08' },
    { id: 'm4', type: 'expense', amount: 110, category: 'compras', description: 'Mercado', date: '2026-07-12' },
  ],
}

/** Um único lançamento não ensina nada. */
const historicoRaro = {
  transactions: [
    { id: 'r1', type: 'expense', amount: 40, category: 'lazer', description: 'Padaria', date: '2026-07-01' },
  ],
}

const diasDeCorrida = Array.from({ length: 10 }, (_, i) => ({
  id: `d${i}`, type: 'income', amount: 260 + i * 12, category: 'corridas',
  date: `2026-07-0${(i % 9) + 1}`,
}))

// ---------------------------------------------------------------------------
// Clientes simulados — a MESMA frase, histórias diferentes
// ---------------------------------------------------------------------------

/** Motorista que chama combustível de "suco". Ninguém adivinha isso. */
const motoristaDoSuco = {
  transactions: Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`, type: 'expense', amount: 90 + i, category: 'combustivel',
    description: 'Suco', date: `2026-07-0${i + 5}`,
  })),
}

/** CLT que trata mercado como alimentação (a lista genérica concorda). */
const cltDoMercado = {
  transactions: Array.from({ length: 4 }, (_, i) => ({
    id: `c${i}`, type: 'expense', amount: 200 + i, category: 'alimentacao',
    description: 'Mercado', date: `2026-07-0${i + 2}`,
  })),
}

/** "Casa 1" é imóvel alugado — receita. */
const autonomoDaCasa1 = {
  transactions: Array.from({ length: 4 }, (_, i) => ({
    id: `k${i}`, type: 'income', amount: 1800, category: 'aluguel',
    description: 'Aluguel', origin: 'Casa 1', date: `2026-07-0${i + 1}`,
  })),
}

/** "Casa 1" é a obra da casa dele — despesa. Mesmo apelido, outro significado. */
const outroDaCasa1 = {
  transactions: Array.from({ length: 4 }, (_, i) => ({
    id: `w${i}`, type: 'expense', amount: 300, category: 'obra',
    description: 'Casa 1', date: `2026-07-0${i + 1}`,
  })),
}

/**
 * Hábito que MUDOU: cinco lançamentos antigos em lazer, três recentes em
 * alimentação. Contagem crua diz lazer; a vida dele diz alimentação.
 */
const habitoQueMudou = {
  transactions: [
    { id: 'h1', type: 'expense', amount: 30, category: 'alimentacao', description: 'Bar do Tião', date: '2026-07-14' },
    { id: 'h2', type: 'expense', amount: 32, category: 'alimentacao', description: 'Bar do Tião', date: '2026-07-12' },
    { id: 'h3', type: 'expense', amount: 28, category: 'alimentacao', description: 'Bar do Tião', date: '2026-07-10' },
    { id: 'h4', type: 'expense', amount: 40, category: 'lazer', description: 'Bar do Tião', date: '2026-01-05' },
    { id: 'h5', type: 'expense', amount: 45, category: 'lazer', description: 'Bar do Tião', date: '2026-01-06' },
    { id: 'h6', type: 'expense', amount: 42, category: 'lazer', description: 'Bar do Tião', date: '2026-01-07' },
    { id: 'h7', type: 'expense', amount: 38, category: 'lazer', description: 'Bar do Tião', date: '2026-01-08' },
    { id: 'h8', type: 'expense', amount: 44, category: 'lazer', description: 'Bar do Tião', date: '2026-01-09' },
  ],
}

/** Histórico fossilizado: quatro lançamentos de seis anos atrás. */
const historicoFossil = {
  transactions: Array.from({ length: 4 }, (_, i) => ({
    id: `f${i}`, type: 'expense', amount: 60, category: 'lazer',
    description: 'Cantina', date: `2020-03-0${i + 1}`,
  })),
}

export const ADAPTATIVO: AssistantCase[] = [
  // ===== Aprender o vocabulário do usuário =====
  {
    id: 'ad-01', group: 'adaptativo', ...other, state: historicoZe,
    // "Zé da esquina" não está em lista de palavra-chave nenhuma, mas o
    // usuário já disse três vezes o que é.
    messages: ['gastei 30 no ze da esquina'],
    expectActions: [{ kind: 'expense', amount: 30, category: 'alimentacao' }],
  },
  {
    id: 'ad-02', group: 'adaptativo', ...other, state: historicoRaro,
    // UM lançamento não vira regra: "padaria" continua vindo da lista genérica
    // (alimentação), não do único registro em lazer.
    messages: ['gastei 15 na padaria'],
    expectActions: [{ kind: 'expense', amount: 15, category: 'alimentacao' }],
  },

  // ===== O histórico do usuário ganha da lista genérica =====
  {
    id: 'ad-03', group: 'adaptativo', ...other, state: historicoMercado,
    // A lista diz alimentação. O usuário classificou como compras quatro
    // vezes — quem manda no dinheiro dele é ele.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'compras' }],
  },
  {
    id: 'ad-04', group: 'adaptativo', ...other,
    // Sem histórico, a lista genérica continua valendo.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'alimentacao' }],
  },

  // ===== A grafia é a do usuário, não a que ele digitou com pressa =====
  {
    id: 'ad-07', group: 'adaptativo', ...other, state: historicoZe,
    // Ele escreveu "Zé da esquina" três vezes. Digitou sem acento agora, no
    // celular, com a mão na direção — a lista de movimentações não pode virar
    // "Ze da esquina" ao lado de "Zé da esquina" e parecerem dois lugares.
    messages: ['gastei 30 no ze da esquina'],
    expectActions: [{ kind: 'expense', amount: 30, description: 'Zé da esquina' }],
  },
  {
    id: 'ad-08', group: 'adaptativo', ...other, state: historicoZe,
    // Descrição que ele nunca usou continua sendo a que ele acabou de digitar.
    messages: ['gastei 30 na oficina do joao'],
    expectActions: [{ kind: 'expense', amount: 30, description: /oficina/i }],
  },

  {
    id: 'ad-09', group: 'adaptativo', ...other, state: historicoZe,
    // O atalho personalizado da tela leva a este caminho: registro sem valor,
    // pergunta, resposta. O que sai tem que ser IGUAL ao que ele já lançou —
    // mesma grafia e mesma categoria —, senão o histórico se divide em dois
    // lugares parecidos e o próprio aprendizado enfraquece.
    messages: ['gastei no ze da esquina', '35'],
    expectActions: [{ kind: 'expense', amount: 35, description: 'Zé da esquina', category: 'alimentacao' }],
  },

  // ===== Valor muito fora do padrão do usuário: AVISAR, nunca bloquear =====
  {
    id: 'ad-05', group: 'adaptativo', ...driver,
    state: { transactions: diasDeCorrida as any },
    // Dez dias entre R$ 260 e R$ 370. "3000" é quase certamente um zero a
    // mais — mas pode ser real, então o app avisa e deixa confirmar.
    messages: ['ganhei 3000 hoje'],
    expectActions: [{ kind: 'income', amount: 3000 }, { kind: 'work', trips: 1 }],
    expectWarning: /bem acima|fora do|confere/i,
  },
  {
    id: 'ad-06', group: 'adaptativo', ...driver,
    state: { transactions: diasDeCorrida as any },
    // Dentro do padrão: nenhum aviso.
    messages: ['ganhei 300 hoje'],
    expectActions: [{ kind: 'income', amount: 300 }, { kind: 'work', trips: 1 }],
    expectNoWarning: true,
  },

  // =========================================================================
  // AUDITORIA ADVERSARIAL DE 17/08/2026 — cada caso abaixo nasceu de um
  // defeito REAL, reproduzido na sonda antes de existir correção.
  // =========================================================================

  // ----- A1: categoria arquivada engolia o lançamento inteiro --------------
  {
    id: 'ad-10', group: 'adaptativo', ...other,
    state: {
      archivedCategories: ['lazer'],
      transactions: Array.from({ length: 4 }, (_, i) => ({
        id: `q${i}`, type: 'expense', amount: 40, category: 'lazer',
        description: 'Clube', date: `2026-07-0${i + 1}`,
      })) as any,
    },
    // O usuário usou "lazer" quatro vezes no Clube e DEPOIS arquivou a
    // categoria. O aprendizado propunha "lazer", a validação recusava, e o
    // gasto sumia com "Não tenho certeza do que registrar aqui". Aprender
    // jamais pode destruir um registro que funcionava sem ele.
    messages: ['gastei 25 no clube'],
    expectActions: [{ kind: 'expense', amount: 25, category: 'outros-out' }],
  },

  // ----- A2/A3: recência ---------------------------------------------------
  {
    id: 'ad-11', group: 'adaptativo', ...other, state: habitoQueMudou,
    // Cinco lançamentos de janeiro em lazer, três de julho em alimentação.
    // Contagem crua diz lazer. A vida dele hoje diz alimentação.
    messages: ['gastei 35 no bar do tião'],
    expectActions: [{ kind: 'expense', amount: 35, category: 'alimentacao' }],
  },
  {
    id: 'ad-12', group: 'adaptativo', ...other, state: historicoFossil,
    // Quatro lançamentos de 2020 decidindo um gasto de 2026. Evidência velha
    // não some, mas também não manda sozinha: sem reforço recente ela cai
    // abaixo do mínimo e a lista genérica volta a valer.
    messages: ['gastei 20 na cantina'],
    expectActions: [{ kind: 'expense', amount: 20, category: 'outros-out' }],
  },
  {
    id: 'ad-13', group: 'adaptativo', ...other,
    state: {
      transactions: [
        // Mesmo lugar, hábito antigo RETOMADO: cinco recentes em lazer.
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `n${i}`, type: 'expense', amount: 40, category: 'lazer',
          description: 'Bar do Tião', date: `2026-07-0${i + 5}`,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `o${i}`, type: 'expense', amount: 30, category: 'alimentacao',
          description: 'Bar do Tião', date: `2026-04-0${i + 1}`,
        })),
      ] as any,
    },
    messages: ['gastei 35 no bar do tião'],
    expectActions: [{ kind: 'expense', amount: 35, category: 'lazer' }],
  },

  // ----- A4: palavra genérica isolada não identifica lugar nenhum ----------
  {
    id: 'ad-14', group: 'adaptativo', ...other,
    state: {
      transactions: Array.from({ length: 4 }, (_, i) => ({
        id: `l${i}`, type: 'expense', amount: 90, category: 'casa',
        description: 'Conta de luz da casa', date: `2026-07-0${i + 1}`,
      })) as any,
    },
    // "casa" aparece na conta de luz E na casa da mãe. A palavra é genérica:
    // aprender por ela fazia "comida na casa da minha mãe" virar categoria
    // Casa, com evidência FORTE o bastante para contrariar a lista genérica.
    messages: ['gastei 60 com comida na casa da minha mãe'],
    expectActions: [{ kind: 'expense', amount: 60, category: 'alimentacao' }],
  },
  {
    id: 'ad-15', group: 'adaptativo', ...other,
    state: {
      transactions: Array.from({ length: 4 }, (_, i) => ({
        id: `ml${i}`, type: 'expense', amount: 200, category: 'compras',
        description: 'Mercado livre', date: `2026-07-0${i + 1}`,
      })) as any,
    },
    // "Mercado livre" é um lugar. "mercado" é outro. O que identifica é a
    // FRASE inteira, não a palavra solta que as duas compartilham.
    messages: ['gastei 80 no mercado'],
    expectActions: [{ kind: 'expense', amount: 80, category: 'alimentacao' }],
  },

  // ----- A6: a origem também tem a grafia do usuário -----------------------
  {
    id: 'ad-16', group: 'adaptativo', ...autonomo, state: autonomoDaCasa1,
    // Ele escreveu "Casa 1" quatro vezes. Digitou minúsculo agora. Sem isto o
    // app passa a ter duas origens diferentes para o mesmo imóvel.
    messages: ['recebi 1800 de aluguel da casa 1'],
    // Regex com caixa: comparar texto sem diferenciar maiúscula é justamente o
    // que esconderia "casa 1" ao lado de "Casa 1" no histórico.
    expectActions: [{ kind: 'income', amount: 1800, origin: /^Casa 1$/ }],
  },

  // ----- Clientes diferentes, a MESMA frase --------------------------------
  {
    id: 'ad-17', group: 'adaptativo', ...driver, state: motoristaDoSuco,
    // Para ele "suco" é combustível. A lista genérica diria alimentação.
    messages: ['gastei 100 de suco'],
    expectActions: [{ kind: 'expense', amount: 100, category: 'combustivel' }],
  },
  {
    id: 'ad-18', group: 'adaptativo', ...clt, state: cltDoMercado,
    // Mesmo texto de ad-03, história diferente: aqui mercado é alimentação.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'alimentacao' }],
  },
  {
    id: 'ad-19', group: 'adaptativo', ...other, state: outroDaCasa1,
    // "Casa 1" aqui é a obra da casa dele — despesa, categoria obra. Mesmo
    // apelido do cliente de ad-16, significado oposto.
    messages: ['gastei 250 na casa 1'],
    expectActions: [{ kind: 'expense', amount: 250, category: 'obra' }],
  },
  {
    id: 'ad-20', group: 'adaptativo', ...other,
    // Usuário novo: a mesma frase de ad-19, sem nenhuma história. Nada pode
    // vazar do cliente anterior.
    messages: ['gastei 250 na casa 1'],
    expectActions: [{ kind: 'expense', amount: 250, category: 'outros-out' }],
  },

  // ----- Histórico contraditório: sem maioria, ninguém decide -------------
  {
    id: 'ad-21', group: 'adaptativo', ...other,
    state: {
      transactions: [
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `x${i}`, type: 'expense', amount: 50, category: 'lazer',
          description: 'Quiosque', date: `2026-07-0${i + 1}`,
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `y${i}`, type: 'expense', amount: 50, category: 'compras',
          description: 'Quiosque', date: `2026-07-0${i + 4}`,
        })),
      ] as any,
    },
    // Metade e metade. Escolher seria chutar com cara de certeza.
    messages: ['gastei 20 no quiosque'],
    expectActions: [{ kind: 'expense', amount: 20, category: 'outros-out' }],
  },

  // ----- Aprendizado DESLIGADO: o app genérico continua inteiro ------------
  {
    id: 'ad-22', group: 'adaptativo', ...other,
    state: { ...historicoMercado, adaptiveAssistant: false } as any,
    // Mesmo estado de ad-03. Com o aprendizado desligado, vale a lista
    // genérica — e nada mais muda: valor, data e tipo são os mesmos.
    messages: ['gastei 50 no mercado'],
    expectActions: [{ kind: 'expense', amount: 50, category: 'alimentacao' }],
  },
  {
    id: 'ad-23', group: 'adaptativo', ...other,
    state: { ...historicoZe, adaptiveAssistant: false } as any,
    // Desligado, a grafia canônica também para: sai o que ele digitou.
    messages: ['gastei 30 no ze da esquina'],
    expectActions: [{ kind: 'expense', amount: 30, description: /^ze da esquina$/i }],
  },

  // ----- Histórico importado (mergeState anexa no FIM da lista) ------------
  {
    id: 'ad-24', group: 'adaptativo', ...other,
    state: {
      transactions: [
        // Lançamentos digitados hoje, sem relação com a feira.
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `t${i}`, type: 'expense', amount: 20, category: 'alimentacao',
          description: 'Café', date: `2026-07-1${i}`,
        })),
        // Backup mesclado: entra no fim da lista, com datas próprias.
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `imp${i}`, type: 'expense', amount: 70, category: 'compras',
          description: 'Feira do bairro', date: `2026-07-0${i + 1}`,
        })),
      ] as any,
    },
    messages: ['gastei 55 na feira do bairro'],
    expectActions: [{ kind: 'expense', amount: 55, category: 'compras' }],
  },

  // ----- O aviso de padrão é por CATEGORIA, não pelo total ----------------
  {
    id: 'ad-25', group: 'adaptativo', ...other,
    state: {
      transactions: Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`, type: 'expense', amount: 40 + i, category: 'alimentacao',
        description: 'Almoço', date: `2026-07-0${(i % 9) + 1}`,
      })) as any,
    },
    // Dez almoços perto de R$ 44. Um aluguel de R$ 2.500 é outra categoria —
    // o padrão do almoço não diz nada sobre ele, então nada de alarme.
    messages: ['paguei 2500 de aluguel da casa'],
    expectNoWarning: true,
  },
]

export default ADAPTATIVO
