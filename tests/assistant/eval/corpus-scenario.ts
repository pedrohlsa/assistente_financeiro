// CORPUS DO PLANEJADOR DE CENÁRIO — CONTRATO CANDIDATO.
//
// Nada disto existe em produção: não há `task` de cenário no servidor e a DSL
// de cenário é de passo único. A suíte mede se vale construir o planejador
// remoto — e, por isso, é OPCIONAL no orçamento (`--suites`).
//
// O que ela responde com números: quando o motor local não entende uma
// hipótese composta, ele hoje simula SÓ a primeira metade e cala sobre a outra
// ("se eu comprar um pc em 10x E continuar guardando 500" simula a compra e
// esquece a reserva), ou simula um número que ninguém disse ("trocar de carro
// dando 20 mil" virou "R$ 8,00 em 4x"). Um modelo que decompõe com consistência
// é a condição para mudar isso.
//
// Valor no passo que não está na frase é perigo (ver score.ts): a simulação
// sairia com número inventado, apresentada como estimativa do app.

import { AUSENTE, umDe } from './types'
import type { CasoCenario, Dimensao, OuroCenario, PassoOuro, PerfilEval, RotaProducao } from './types'

const passo = (kind: string, campos: PassoOuro['campos'] = {}): PassoOuro => ({ kind, campos })

function caso(
  id: string, perfil: PerfilEval, dimensao: Dimensao, rota: RotaProducao,
  mensagem: string, porque: string, ouro: OuroCenario,
): CasoCenario {
  return { id, suite: 'cenario', perfil, dimensao, rota, mensagem, porque, ouro }
}

export const CASOS_CENARIO: CasoCenario[] = [
  // ===== Compostas: o motor local simula metade e cala sobre o resto ========
  caso('s-01', 'autonomo', 'cenario-complexo', 'local-errada',
    'se eu comprar um pc de 4k em 10x e continuar guardando 500 por mês qual mês fica mais apertado?',
    'duas hipóteses; o local simulou só a compra e ignorou os 500 por mês',
    { passos: [passo('purchase', { amount: 4000, installments: 10, downPayment: AUSENTE }), passo('save', { amount: 500 })] }),
  caso('s-02', 'autonomo', 'cenario-complexo', 'local-errada',
    'se a Casa 1 atrasar e eu pagar o Nubank inteiro ainda sobra alguma coisa?',
    'entrada que falta + fatura paga; o local simulou só a Casa 1',
    { passos: [passo('income-missing', { origin: 'Casa 1', amount: AUSENTE }), passo('pay-invoice', { cardName: 'Nubank' })] }),
  caso('s-03', 'autonomo', 'cenario-complexo', 'local',
    'e se eu comprar uma moto de 12 mil em 24 vezes sem entrada no nubank e cancelar a internet',
    'compra com "sem entrada" explícito + uma hipótese que a DSL não representa; até 15/09/2026 o local simulava "R$ 4,00 em 2x", hoje simula 12 mil em 24x (cancelar a internet continua sem representação)',
    { passos: [passo('purchase', { amount: 12000, installments: 24, cardName: 'Nubank', downPayment: umDe(0, null) })] }),
  caso('s-04', 'clt', 'cenario-complexo', 'local-errada',
    'to pensando em trocar de carro se eu der 20 mil de entrada e financiar 40 mil em 48x da?',
    'o preço TOTAL é 60 mil (entrada + financiado); o local simulou "R$ 8,00 em 4x"',
    { passos: [passo('purchase', { amount: 60000, downPayment: 20000, installments: 48 })] }),
  caso('s-05', 'other', 'cenario-complexo', 'local',
    'e se eu comprar um celular de 2 mil em 10x dando 500 de entrada no inter',
    'entrada INCLUÍDA no preço dito: o total continua 2 mil; até 15/09/2026 o local simulava um gasto de R$ 2,00',
    { passos: [passo('purchase', { amount: 2000, installments: 10, downPayment: 500, cardName: 'Inter' })] }),

  // ===== Simples, mas com o valor escondido na fala =========================
  caso('s-06', 'autonomo', 'linguagem', 'remota',
    'e se a casa 2 ficar 2 meses sem pagar',
    '"2 meses" é duração, não valor: o valor que falta sai do histórico, no aparelho',
    { passos: [passo('income-missing', { origin: 'Casa 2', amount: AUSENTE })] }),
  caso('s-07', 'motorista', 'linguagem', 'local-errada',
    'se eu rodar mais 2 horas por dia a semana toda quanto a mais eu tiro',
    'horas por dia × dias da SEMANA; o local estimou 30 dias',
    { passos: [passo('extra-work', { hoursPerDay: 2, days: umDe(5, 6, 7) })] }),
  caso('s-08', 'autonomo', 'linguagem', 'local',
    'se eu gastar 1200 no dentista esse mês fico no vermelho?',
    'gasto avulso com pergunta de sim ou não',
    { passos: [passo('spend', { amount: 1200 })] }),
  caso('s-09', 'autonomo', 'linguagem', 'local',
    'se eu guardar 300 por mês quando chego na viagem',
    'meta citada pelo nome, sem a palavra "meta"',
    { passos: [passo('save', { amount: 300, goalName: 'Viagem' })] }),
  caso('s-10', 'autonomo', 'linguagem', 'local',
    'se eu pagar a fatura do inter hoje ainda consigo pagar a luz',
    'pagar fatura quita dívida, não cria despesa (regra 10); a luz é contexto, não passo',
    { passos: [passo('pay-invoice', { cardName: 'Inter' })] }),
  caso('s-11', 'autonomo', 'linguagem', 'local',
    'quanto sobra se eu comprar uma tv de 3 mil',
    'sem parcela dita: gasto avulso ou compra em 1x dizem o mesmo; até 15/09/2026 o local lia "3 mil" como R$ 3,00',
    {
      passos: [passo('spend', { amount: 3000 })],
      alternativas: [[passo('purchase', { amount: 3000, installments: 1, downPayment: AUSENTE })]],
    }),

  // ===== Não há cenário planejável ==========================================
  caso('s-12', 'autonomo', 'modalidade', 'remota',
    'e se em vez de 10x eu fizer 12 dando mil de entrada?',
    'sem a compra de base não existe preço: qualquer valor seria inventado',
    { passos: [] }),
  caso('s-13', 'autonomo', 'cenario-complexo', 'local-errada',
    'se eu parar de guardar por 3 meses consigo quitar a geladeira antes?',
    'parar de guardar + quitar parcelamento antes: nenhum dos dois é tipo da DSL; o local simulou "R$ 3,00 por mês"',
    { passos: [] }),
  caso('s-14', 'autonomo', 'modalidade', 'local',
    'comprei uma tv de 3 mil em 10x',
    'relato de fato, não hipótese: o lugar dele é a proposta de registro',
    { passos: [] }),
  caso('s-15', 'autonomo', 'modalidade', 'remota',
    'se eu tivesse guardado 500 por mês desde janeiro quanto teria hoje',
    'contrafactual no PASSADO: simular para frente responderia outra pergunta',
    { passos: [] }),
]
