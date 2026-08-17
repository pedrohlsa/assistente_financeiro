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
import { addDays, todayISO } from '../../src/utils/format'

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

/**
 * Oito dias reais de motorista: receita por plataforma, combustível e as
 * sessões de trabalho com km, horas e viagens. É a base de tudo que o app pode
 * afirmar sobre o ritmo dele — e do que ele NÃO pode afirmar sem isso.
 *
 * As datas saem de `todayISO()`, não da data fixa do corpus, porque estas
 * perguntas passam por `resolveLocal`, que usa o RELÓGIO REAL da máquina
 * (regra 35). Com datas fixas o cenário envelhecia para fora da janela de 30
 * dias e o teste passava a medir a passagem do tempo, não o comportamento.
 */
const DIAS_RODADOS = 21
const diaDeTrabalho = (i: number) => addDays(todayISO(), -(DIAS_RODADOS - i))
const rodados = <T>(f: (i: number) => T): T[] => Array.from({ length: DIAS_RODADOS }, (_, i) => f(i))

const semanaDeMotorista = {
  transactions: [
    ...rodados(i => ({
      id: `u${i}`, type: 'income', amount: 180 + (i % 7) * 5, category: 'corridas',
      description: 'Uber', date: diaDeTrabalho(i),
    })),
    ...rodados(i => ({
      id: `n${i}`, type: 'income', amount: 110 + (i % 7) * 3, category: 'corridas',
      description: '99', date: diaDeTrabalho(i),
    })),
    ...rodados(i => ({
      id: `g${i}`, type: 'expense', amount: 70, category: 'combustivel',
      description: 'Gasolina', date: diaDeTrabalho(i),
    })),
  ],
  workSessions: rodados(i => ({
    id: `w${i}`, date: diaDeTrabalho(i), km: 150 + (i % 7) * 8, hours: 9, trips: 18 + (i % 7),
  })),
}

/**
 * "Quanto eu costumo gastar em X" olha os últimos 30 dias pelo RELÓGIO REAL
 * (`resolveLocal`, regra 35), então estes dois cenários precisam de datas
 * relativas a hoje — com data fixa eles envelheciam para fora da janela.
 */
const sucoRecente = Array.from({ length: 4 }, (_, i) => ({
  id: `sr${i}`, type: 'expense', amount: 90 + i, category: 'combustivel',
  description: 'Suco', date: addDays(todayISO(), -(i + 2)),
}))

const padocaRecente = Array.from({ length: 6 }, (_, i) => ({
  id: `pd${i}`, type: 'expense', amount: 15, category: 'alimentacao',
  description: 'Padoca da Rita', date: addDays(todayISO(), -(i + 1)),
}))

/** Três dias soltos: existe registro, mas não existe padrão semanal. */
const tresDiasDeMotorista = {
  transactions: Array.from({ length: 3 }, (_, i) => ({
    id: `t${i}`, type: 'income', amount: 300, category: 'corridas',
    description: 'Uber', date: addDays(todayISO(), -(3 - i)),
  })),
  workSessions: Array.from({ length: 3 }, (_, i) => ({
    id: `tw${i}`, date: addDays(todayISO(), -(3 - i)), km: 160, hours: 9, trips: 20,
  })),
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

  {
    id: 'ad-40', group: 'adaptativo', ...autonomo,
    state: {
      transactions: Array.from({ length: 4 }, (_, i) => ({
        id: `kn${i}`, type: 'income', amount: 1200, category: 'aluguel',
        description: 'Aluguel', origin: 'Kitnet do fundo', date: `2026-07-0${i + 1}`,
      })) as any,
    },
    // "da kitnet do fundo" virava a origem "kitnet do": o identificador depois
    // do substantivo de fonte parava na primeira palavra, e ela era o
    // conector. Além de guardar um nome truncado, isso quebrava o
    // reconhecimento da grafia — "kitnet do" não é "Kitnet do fundo", então o
    // imóvel passava a existir duas vezes no histórico.
    messages: ['recebi 1200 da kitnet do fundo'],
    expectActions: [{ kind: 'income', amount: 1200, origin: /^Kitnet do fundo$/ }],
  },

  // ----- Clientes diferentes, a MESMA frase --------------------------------
  {
    id: 'ad-17', group: 'adaptativo', ...driver, state: motoristaDoSuco,
    // Para ele "suco" é combustível. A lista genérica diria alimentação.
    messages: ['gastei 100 de suco'],
    expectActions: [{ kind: 'expense', amount: 100, category: 'combustivel' }],
  },
  {
    id: 'ad-41', group: 'adaptativo', ...driver, state: { transactions: sucoRecente as any },
    // Ele chama combustível de "suco". Perguntar quanto costuma gastar DE SUCO
    // caía no resumo do dia inteiro, porque a resposta de combustível só
    // conhecia as palavras do dicionário do app. Quem sabe o que é "suco" é o
    // histórico dele.
    messages: ['quanto eu costumo gastar de suco por dia?'],
    expectNoActions: true,
    expectReply: [/combust[íi]vel/i, /4 lan[çc]amentos|4 registros/i],
    forbidReply: [/faturamento|jornada/i],
  },
  {
    id: 'ad-42', group: 'adaptativo', ...other,
    state: { transactions: padocaRecente as any },
    // A mesma pergunta fora do perfil motorista, com o nome de um lugar.
    messages: ['quanto eu costumo gastar na padoca da rita?'],
    expectNoActions: true,
    expectReply: [/padoca/i, /6 lan[çc]amentos|6 registros/i],
  },
  {
    id: 'ad-43', group: 'adaptativo', ...other,
    // Sem histórico daquilo, o app diz que não sabe em vez de somar zero.
    messages: ['quanto eu costumo gastar na padoca da rita?'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o|n[ãa]o encontrei|n[ãa]o tenho/i],
    forbidReply: [/R\$ 0,00 por dia/i],
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

  // ----- Explicabilidade: a explicação tem que bater com o que foi feito --
  {
    id: 'ad-26', group: 'adaptativo', ...other, state: historicoMercado,
    // A proposta saiu com "compras" POR CAUSA do histórico. A explicação
    // dizia o contrário — "essa veio das palavras da mensagem, não do seu
    // histórico" —, porque ela relia a ação já com a categoria aplicada e
    // concluía que não tinha mudado nada. Explicação que contradiz o que o
    // app fez é pior que explicação nenhuma.
    messages: ['gastei 50 no mercado', 'por que você colocou essa categoria?'],
    expectNoActions: true,
    expectReply: [/4 vezes/i, /compras/i],
    forbidReply: [/não do seu hist[óo]rico/i, /repetição suficiente/i],
  },
  {
    id: 'ad-27', group: 'adaptativo', ...other, state: historicoMercado,
    // Perguntar "por que" não pode cancelar a proposta que está na tela: a
    // pergunta seguinte ainda se refere a ela. Antes, qualquer resposta sem
    // ação zerava a proposta pendente e o "isso" perdia o alvo.
    messages: ['gastei 50 no mercado', 'por que essa categoria?', 'quantas vezes eu fiz isso?'],
    expectNoActions: true,
    expectReply: [/mercado/i, /4 vezes/i],
  },
  {
    id: 'ad-28', group: 'adaptativo', ...other, state: historicoMercado,
    // A explicação é local e determinística, e desligar é decisão do usuário:
    // o assistente diz onde fica a chave e não mexe em configuração sozinho.
    messages: ['pare de usar meu histórico para sugerir coisas'],
    expectNoActions: true,
    expectReply: [/configura/i, /assistente adaptativo/i],
  },
  {
    id: 'ad-29', group: 'adaptativo', ...driver,
    state: { transactions: diasDeCorrida as any },
    // O aviso de padrão precisa saber se explicar: com quantos lançamentos,
    // de que período e qual é o valor de referência.
    messages: ['ganhei 3000 hoje', 'por que você acha esse valor estranho?'],
    expectNoActions: true,
    expectReply: [/10 [úu]ltimos/i, /corridas/i],
  },

  // ----- Motorista: o que É típico DELE, com a amostra à vista ------------
  {
    id: 'ad-30', group: 'adaptativo', ...driver, state: semanaDeMotorista,
    // "Quanto eu costumo fazer por dia?" caía no texto genérico de ajuda,
    // que é a pergunta mais óbvia de quem roda o dia inteiro.
    messages: ['quanto eu costumo fazer por dia?'],
    expectNoActions: true,
    expectReply: [/21 dias/i, /dado real|realizado/i],
    forbidReply: [/posso te ajudar com coisas como/i],
  },
  {
    id: 'ad-31', group: 'adaptativo', ...driver, state: semanaDeMotorista,
    messages: ['quais são meus dias mais fortes?'],
    expectNoActions: true,
    expectReply: [/(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)/i],
    forbidReply: [/posso te ajudar com coisas como/i],
  },
  {
    id: 'ad-32', group: 'adaptativo', ...driver, state: semanaDeMotorista,
    // Uber, 99 e privada na mesma semana: de onde vem o dinheiro dele.
    messages: ['de onde vem mais dinheiro, uber ou 99?'],
    expectNoActions: true,
    expectReply: [/uber/i, /99/i],
    forbidReply: [/posso te ajudar com coisas como/i],
  },
  {
    id: 'ad-33', group: 'adaptativo', ...driver,
    // Sem amostra o app CALA em vez de inventar média — e diz o que registrar
    // para a conta passar a existir.
    messages: ['quanto eu costumo fazer por dia?'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o tenho|registre/i],
    forbidReply: [/R\$ 0,00\s*por dia/i],
  },
  {
    id: 'ad-34', group: 'adaptativo', ...clt,
    // A mesma pergunta em perfil CLT não pode responder com dado de
    // motorista (regra 3).
    messages: ['quais são meus dias mais fortes?'],
    expectNoActions: true,
    forbidReply: [/km|gasolina|hod[oô]metro|corrida|viagem/i],
  },
  {
    id: 'ad-35', group: 'adaptativo', ...driver, state: tresDiasDeMotorista,
    // Três dias soltos dão UM registro por dia da semana. Ranquear terça
    // contra quinta com uma observação cada é ruído com cara de padrão —
    // "Sábado: R$ 328,00 por dia (1 dia nessa amostra)" é uma afirmação que o
    // dado não sustenta. O app precisa dizer que ainda não sabe.
    messages: ['quais são meus dias mais fortes?'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o|mais algumas semanas|poucos dias/i],
    forbidReply: [/\(1 dia nessa amostra\)/i],
  },
  {
    id: 'ad-36', group: 'adaptativo', ...driver, state: tresDiasDeMotorista,
    // "Seu normal nos 30 dias anteriores: R$ 254,00 (2 dias)" comparava a
    // semana com uma base de dois dias e ainda chamava isso de normal. Sem
    // base para comparar, o certo é dizer que ainda não dá.
    messages: ['essa semana está melhor que o normal?'],
    expectNoActions: true,
    expectReply: [/ainda n[ãa]o|n[ãa]o d[áa] para comparar/i],
    forbidReply: [/acima do seu normal|abaixo do seu normal/i],
  },

  // ----- O dinheiro do dia não pode ser contado duas vezes ---------------
  {
    id: 'ad-37', group: 'adaptativo', ...driver,
    // "hoje FOI 430 na uber e 380 na 99": `foi` é verbo de despesa no parser,
    // e a receita da plataforma já tinha lido esse mesmo dinheiro. Saía uma
    // despesa GÊMEA de R$ 430 com a mesma descrição, que zerava o dia do
    // motorista. É a regra 34 pelo lado que ninguém tinha olhado: o sinal não
    // se inverteu, ele foi DUPLICADO.
    messages: ['boa noite, hoje foi 430 na uber e 380 na 99, rodei 172 km em 10 horas'],
    expectActions: [
      { kind: 'income', amount: 430, category: 'corridas' },
      { kind: 'income', amount: 380, category: 'corridas' },
      { kind: 'work', km: 172, hours: 10 },
    ],
  },
  {
    id: 'ad-38', group: 'adaptativo', ...driver,
    // A mesma frase com verbo de gasto EXPLÍCITO continua sendo gasto: o
    // conserto não pode engolir despesa de verdade.
    // (No perfil motorista combustível tem estrutura própria: vira `fuel`.)
    messages: ['hoje gastei 430 de gasolina'],
    expectActions: [{ kind: 'fuel', amount: 430 }],
  },
  {
    id: 'ad-39', group: 'adaptativo', ...driver,
    // Despesa de verdade com o MESMO valor de uma receita continua existindo:
    // o conserto só apaga a gêmea sem categoria e com a mesma descrição.
    messages: ['hoje foi 430 na uber e paguei 430 de manutenção'],
    expectActions: [
      { kind: 'income', amount: 430, category: 'corridas' },
      { kind: 'work', trips: 1 },
      { kind: 'expense', amount: 430, category: 'manutencao' },
    ],
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
