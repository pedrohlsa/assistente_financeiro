# Matriz de regressão do assistente — AssistFin

> **Status: esta matriz virou código.** O documento continua servindo como visão panorâmica,
> mas a fonte de verdade agora é executável:
>
> - `tests/assistant/cases.ts` — regressão da reformulação;
> - `tests/assistant/cases-critical.ts` — os dez cenários obrigatórios do briefing;
> - `tests/assistant/cases-adversarial.ts` — **68 casos** da rodada de QA adversarial,
>   cada um escrito ANTES da correção do bug que o originou;
> - `tests/assistant/cases-temporal.ts` — **43 casos** de datas futuras, inválidas,
>   períodos, correções e frases mistas;
> - `tests/assistant/cases-undo.ts` — **14 casos** de "desfaz o último";
> - `tests/assistant/cases-edit.ts` — **17 casos** de correção de lançamento salvo;
> - `tests/assistant/cases-fala-real.ts` — **29 casos** de PERGUNTA como o usuário digita;
> - `tests/assistant/cases-registro-real.ts` — **68 casos** de REGISTRO em fala real
>   (resultado do dia do motorista, gíria de dinheiro, typo, valor sem verbo, dois dias
>   na mesma mensagem);
> - `tests/assistant/properties.ts` — **60 invariantes financeiras e de segurança**;
> - `npm run test:assistant` — roda tudo offline, com data fixa, contra o orquestrador real.
>
> **Resultado da última execução (13/08/2026, branch `feat/assistant-orchestrator`):
> 477/477 casos e 60/60 invariantes.**
>
> ⚠️ **100% aqui não significa "a IA está correta".** Na rodada adversarial, 8 dos 17 bugs só
> apareceram no navegador com mensagem real. Na rodada de 13/08/2026 repetiu-se o padrão por
> outro caminho: uma SONDA sobre fala real achou 15 defeitos que o corpus não achava — o
> corpus só sabe o que já perguntaram a ele. Três deles nenhum teste pegaria, porque só
> apareciam ao LER a resposta ("tô no vermelho?" respondendo "Sim" para quem tinha sobra).
> Exemplo do que o corpus deixava passar: "não gastei 100" propunha registrar a despesa.
> Sondar com frase torta e ler a resposta continua obrigatório.
>
> A coluna "Atual" abaixo descreve o estado **anterior** à reformulação e foi mantida como
> registro histórico — é o retrato do que motivou cada correção. O que vale hoje está em
> [AI_CURRENT_STATE.md](AI_CURRENT_STATE.md) §4 e §6.

Casos representativos para avaliar o assistente antes e depois da reformulação da arquitetura.
Montada em 28/07/2026 sobre o commit `7dc1832`.

**Como o status atual foi determinado**: leitura do código de `nlp.ts`, `ai.ts`, `Chat.tsx`,
`store.tsx` e dos dois `SYSTEM_PROMPT`. Casos que dependem da resposta da DeepSeek em produção
estão marcados como **não verificável estaticamente** — o que se avalia neles é o contrato
(o que o app faz com a resposta), não a qualidade do texto do modelo.

## Legenda

| Símbolo | Significado |
|---|---|
| ✅ | Funciona como esperado |
| ⚠️ | Funciona em parte / depende de fraseado |
| ❌ | Não funciona |
| 🔒 | Depende do modelo remoto — só o contrato é auditável |

**Mecanismo esperado**: `local` (determinístico e offline), `remoto` (DeepSeek), `híbrido`
(registro local + resposta remota na mesma mensagem).

A coluna **Pós-correção** ficou em branco de propósito quando esta matriz foi escrita. Em vez de
preenchê-la à mão — o que envelheceria na primeira mudança —, cada linha virou um caso executável.
Os grupos correspondem assim:

| Seção desta matriz | Grupo no corpus |
|---|---|
| 1–3 receitas, despesas, várias ações | `receitas`, `origem`, `despesas`, `multi` |
| 4 perguntas | `perguntas`, `coloquial` |
| 5 registro + pergunta | `misto`, `mistos2` |
| 6 números pt-BR | `valores`, `extenso` |
| 7 datas e recorrências | `datas`, `datas2` |
| 8 cartões | `cartoes`, `cartoes2` |
| 9 metas, saving, saldo | `metas`, `saving`, `saldo` |
| 10 motorista | `motorista`, `motorista2`, `perfil` |
| 11 ambiguidades e correções | `ambiguidade`, `correcoes`, `correcoes2`, `multiturno` |
| 12 conversacional | `conversa`, `conversa2`, `incompletas` |
| 13 erros remotos e contrato | `seguranca`, `seguranca2` + as 58 invariantes |
| 14 datas futuras, inválidas e períodos | `temporal` (43 casos) |
| 15 desfazer o último lote | `undo` (14 casos) |
| 16 corrigir lançamento já salvo | `edicao` (17 casos) |
| Cenários obrigatórios do briefing | `criticos` (10 casos, frases literais) |

Grupos criados na rodada adversarial de 28/07, todos em `cases-adversarial.ts`:
`negacao`, `hipoteses`, `abreviacao`, `descricao`, `sempontuacao`, `metanome`, `gasadv`,
`correcaomsg`, `preposicao`, `hodometro`, `passei`, `datadesc`, `centavos`, `falados`,
`explicacao`, `injecao`, `datafutura`.

---

## 1. Receitas

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | driver | receita simples | ganhei 250 hoje | Confirmação de receita | `income 250 · corridas` | — | hoje | local | ✅ | |
| 2 | driver | receita com plataforma | ganhei 430 no Uber | Receita descrita como Uber | `income 430 · corridas · "Uber"` | — | hoje | local | ✅ | |
| 3 | driver | duas receitas | ganhei 430 Uber, mais 399 da 99 | Duas receitas distintas + 2 viagens | `income 430`, `income 399`, `work trips 2` | — | hoje | local | ✅ | |
| 4 | driver | receita em ordem coloquial | mais uma corrida de 49 reais | Uma receita + 1 viagem | `income 49 · corridas`, `work trips 1` | — | hoje | local | ✅ | |
| 5 | clt | salário | recebi meu salário de 3000 | Receita de salário | `income 3000 · salario` | — | hoje | local | ⚠️ categoria vem de `guessCategory`, não garantida | |
| 6 | autonomo | aluguel | recebi 1800 de aluguel | Receita de aluguel | `income 1800 · aluguel` | — | hoje | local | ⚠️ idem | |
| 7 | autonomo | receita sem origem | recebi 500 | Receita genérica, sem afirmar origem | `income 500 · outros-in` | — | hoje | local | ✅ | |
| 8 | driver | receita sem origem | recebi 500 | Receita de corridas (padrão do perfil) | `income 500 · corridas` | — | hoje | local | ✅ | |
| 9 | autonomo | receita com origem nomeada | recebi 1200 de aluguel da Casa 1 | Receita com `origin: "Casa 1"` | `income 1200 · aluguel · origin "Casa 1"` | — | hoje | local | ❌ `origin` nunca é extraído | |
| 10 | other | receita com data passada | ontem recebi 300 | Receita datada de ontem | `income 300` em D−1 | — | ontem | local | ❌ sempre grava hoje | |
| 11 | driver | receita por extenso | ganhei mil e quinhentos hoje | Receita de 1500 | `income 1500` | — | hoje | local | ❌ sem números por extenso | |
| 12 | driver | receita ambígua com "99" | recebi 99 reais | Receita de 99, **sem** marcar plataforma | `income 99` sem `is99` | — | hoje | local | ✅ `MENTIONS_99` não casa | |

## 2. Despesas

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 13 | driver | despesa simples | gastei 40 de gasolina | Um abastecimento (não despesa duplicada) | `fuel 40` | — | hoje | local | ✅ | |
| 14 | other | despesa comum | gastei 250 no mercado | Despesa de alimentação | `expense 250 · alimentacao` | — | hoje | local | ✅ | |
| 15 | other | descrição limpa | gastei 190 reais depois comprando cimento | Descrição "Cimento", categoria obra | `expense 190 · obra · "Cimento"` | — | hoje | local | ✅ | |
| 16 | other | ordem inversa | comprei cimento por 190 | Mesma coisa do caso 15 | `expense 190 · obra · "Cimento"` | — | hoje | local | ✅ | |
| 17 | other | enumeração | gastei 20 de pedágio e 40 de gasolina, 15 de lanche | Três lançamentos | `expense 20`, `fuel 40`, `expense 15` | — | hoje | local | ✅ | |
| 18 | other | decimal com vírgula | gastei 1.234,56 no material | **Uma** despesa de 1234,56 | `expense 1234.56` | — | hoje | local | ✅ regressão coberta por `,(?!\d)` | |
| 19 | other | milhar sem decimal | gastei 100.000 na obra | Despesa de 100000 | `expense 100000` | — | hoje | local | ✅ | |
| 20 | other | despesa com data | gastei 80 no mercado sexta passada | Despesa datada | `expense 80` na sexta anterior | — | sexta anterior | local | ❌ sem datas | |
| 21 | driver | despesa de manutenção | troquei o óleo por 280 com 84 mil km | Manutenção + despesa + hodômetro | `maintenance óleo 280 km 84000` | — | hoje | local | ✅ | |
| 22 | other | despesa recorrente implícita | pago 120 de internet todo mês | Criar **recorrente**, não despesa avulsa | recorrente mensal 120 | confirmar dia | — | local | ❌ não existe ação de recorrente | |
| 23 | autonomo | despesa com origem | paguei 300 de luz da Casa 2 | Despesa com `origin` | `expense 300 · casa · origin "Casa 2"` | — | hoje | local | ❌ `origin` não extraído | |

## 3. Várias ações na mesma mensagem

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 24 | driver | composta longa | Ganhei 430 UBER, mais 399 da 99, gastei 163 de gasolina deram 24 litros, rodei 161km | 2 receitas + 1 abastecimento + 1 trabalho | `income 430`, `income 399`, `fuel 163/24L`, `work km 161 trips 2` | — | hoje | local | ✅ coberto por `npm test` | |
| 25 | driver | abastecimento completo | abasteci 190, deu 41 litros, estou com 220.007 km | Um `fuel` com hodômetro, **sem** km trabalhado | `fuel 190/41L/odo 220007` | — | hoje | local | ✅ coberto por `npm test` | |
| 26 | other | dois gastos conectados | gastei 79 de gás de cozinha, depois gastei mais 190 de cimento | Duas despesas | `expense 79 · casa`, `expense 190 · obra` | — | hoje | local | ✅ | |
| 27 | driver | receita + despesa + trabalho | ganhei 300, coloquei 70 de gasolina e rodei 120 km | 3 ações | `income 300`, `fuel 70`, `work km 120` | — | hoje | local | ✅ | |
| 28 | other | confirmação parcial | (3 ações propostas, usuário quer só 2) | Poder aceitar um subconjunto | — | — | — | local | ❌ confirmação é tudo-ou-nada | |
| 29 | other | lote com falha no meio | 2 receitas + 1 depósito numa meta inexistente | Ou tudo, ou nada, com erro específico | — | qual meta? | hoje | local | ❌ sem atomicidade; erro genérico | |
| 30 | other | dois depósitos na mesma meta | guardei 100 no iphone e mais 50 no iphone | Meta soma 150 | `goal-deposit 100`, `goal-deposit 50` | — | hoje | local | ❌ `state` obsoleto: fica 50 | |

## 4. Perguntas factuais

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 31 | driver | saldo | qual meu saldo? | Saldo real + contas próximas | nenhuma | — | — | local | ✅ | |
| 32 | driver | quanto posso gastar | quanto posso gastar hoje? | Usa saldo e contas de 7 dias | nenhuma | — | — | local | ✅ | |
| 33 | driver | meta diária | qual minha meta? | Meta com composição | nenhuma | — | — | local | ✅ | |
| 34 | autonomo | meta mensal | quanto posso guardar este mês? | Meta, sobra e guardado separados | nenhuma | — | — | local | ✅ | |
| 35 | clt | resumo do mês | como está meu mês? | Entradas, saídas, sobra/déficit | nenhuma | — | — | local | ✅ | |
| 36 | other | maior despesa | qual foi minha maior despesa? | Maior despesa do período | nenhuma | — | — | local | ✅ | |
| 37 | driver | melhor dia | qual foi meu melhor dia? | Melhor dia dos últimos 30 | nenhuma | — | — | local | ✅ | |
| 38 | driver | gasto por categoria | quanto gastei com gasolina esse mês? | Total real da categoria | nenhuma | — | — | local | ✅ | |
| 39 | autonomo | receita por fonte | quanto recebi de aluguéis este mês? | Total real | nenhuma | — | — | local | ✅ | |
| 40 | other | comparação de ritmo | tô gastando demais esse mês? | Comparação proporcional com o mês anterior | nenhuma | — | — | local | ✅ | |
| 41 | other | pergunta sem dados | qual foi minha maior despesa? (base vazia) | "Não encontrei despesas…" | nenhuma | — | — | local | ✅ | |
| 42 | other | pergunta aberta | vale a pena eu trocar de plano de celular? | Resposta conversacional, sem inventar número | nenhuma | — | — | remoto | 🔒 contrato ok | |
| 43 | driver | pergunta fora de escopo | qual a capital da Austrália? | Redirecionar ao escopo financeiro | nenhuma | — | — | remoto | 🔒 | |

## 5. Registro + pergunta na mesma mensagem

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 44 | other | gasto + orçamento | Gastei 200 em almoço, quanto ainda tenho de limite para alimentação? | Registro + saldo do orçamento | `expense 200 · alimentacao` | — | hoje | híbrido | ✅ único caso coberto | |
| 45 | driver | gasto + meta | gastei 40 de gasolina, ainda bato minha meta hoje? | Registro + resposta sobre a meta | `fuel 40` | — | hoje | híbrido | ❌ pergunta ignorada | |
| 46 | autonomo | receita + saldo | recebi 1800 de aluguel, isso cobre minhas contas? | Registro + análise de contas | `income 1800` | — | hoje | híbrido | ❌ pergunta ignorada | |
| 47 | clt | gasto + projeção | gastei 500 no cartão, como fica meu mês? | Registro + projeção | — | quantas parcelas? | hoje | híbrido | ❌ | |
| 48 | other | pergunta + registro invertidos | quanto tenho de saldo? ah, e gastei 30 no lanche | Responder e propor o registro | `expense 30` | — | hoje | híbrido | ❌ `isQuestion` desvia tudo | |

## 6. Números e formatos pt-BR

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 49 | other | milhar com ponto | meu saldo é 5.000 | Saldo 5000 | `balance 5000` | — | agora | local | ✅ | |
| 50 | other | milhar + decimal | gastei 1.000.000,50 | Despesa 1000000,50 | `expense 1000000.5` | — | hoje | local | ✅ | |
| 51 | other | formato americano | gastei 1,234.56 | Despesa 1234,56 | `expense 1234.56` | — | hoje | local | ✅ | |
| 52 | other | valor com R$ | gastei R$ 39,90 na assinatura | Despesa 39,90 | `expense 39.9` | — | hoje | local | ✅ | |
| 53 | other | entrada inválida | gastei R$ | Nenhuma ação, pedido de esclarecimento | nenhuma | quanto? | — | local | ⚠️ devolve fallback genérico | |
| 54 | driver | "mil" em meta | quero comprar um celular de 5 mil em 6 meses | Meta de 5000 | `goal "celular" 5000 · 6 meses` | — | — | local | ✅ | |
| 55 | driver | "mil" em km | estou com 84 mil km | Hodômetro 84000 | `odometer 84000` | — | — | local | ✅ | |
| 56 | other | valor por extenso | gastei duzentos reais no mercado | Despesa 200 | `expense 200` | — | hoje | local | ❌ | |

## 7. Datas e recorrências

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 57 | other | data relativa | anteontem gastei 60 | Despesa em D−2 | `expense 60` em D−2 | — | D−2 | local | ❌ | |
| 58 | other | data absoluta | dia 15 paguei 300 de luz | Despesa no dia 15 | `expense 300` em D15 | — | dia 15 | local | ❌ | |
| 59 | clt | criar recorrente | meu salário de 3000 cai todo dia 5 | Criar entrada recorrente | recorrente income 3000, dia 5 | primeira ocorrência? | — | local | ❌ sem ação de recorrente | |
| 60 | other | recorrente quinzenal | tenho uma conta de 200 a cada 15 dias | Recorrente com `interval 15, unit day` | recorrente | data inicial? | — | local | ❌ | |
| 61 | other | consultar recorrentes | quais contas vencem essa semana? | Lista real de vencimentos | nenhuma | — | — | local | ✅ | |
| 62 | autonomo | confirmar recebimento | já recebi o aluguel deste mês | Resolver a ocorrência pendente | resolver ocorrência | qual mês? | mês atual | local | ❌ só pelo card de pendências | |
| 63 | other | pular ocorrência | esse mês não vou pagar a academia | Marcar ocorrência como pulada | ocorrência `skipped` | — | mês atual | local | ❌ | |

## 8. Cartões, parcelas e faturas

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 64 | other | compra parcelada | comprei um computador de 4000 em 4 vezes no nubank | Plano de 4x | `card-purchase 4000/4x · Nubank` | — | hoje | local | ✅ | |
| 65 | other | compra sem parcelas | comprei uma geladeira de 3000 no cartão | Nenhuma ação; perguntar parcelas | nenhuma | em quantas vezes? | — | local | ⚠️ não gera ação, mas o texto é o fallback genérico | |
| 66 | other | compra sem valor | parcelei o notebook em 10x | Nenhuma ação; perguntar valor | nenhuma | qual o valor total? | — | local | ⚠️ idem | |
| 67 | other | cartão inexistente | comprei 500 em 2x no cartão Itaú (não cadastrado) | Recusar e avisar que o cartão não existe | nenhuma aplicada | cadastrar o cartão? | — | local | ❌ erro reportado como "não encontrei a meta" | |
| 68 | other | pagar fatura | paguei a fatura do nubank | Quitar o pendente | `card-payment · Nubank` | — | hoje | local | ✅ | |
| 69 | other | pagamento parcial | paguei 700 da fatura do nubank | Pagamento parcial | `card-payment 700 · Nubank` | — | hoje | local | ✅ | |
| 70 | other | assinatura | tenho uma assinatura de 39,90 no cartão | Cobrança recorrente | `card-charge 39.90` | qual cartão? | — | local | ⚠️ sem cartão único, falha silenciosa | |
| 71 | other | entrada financiada | passei 2000 em 5x e recebi 1850 | Dívida 2000 + entrada 1850, **não** receita | `financed-cash-inflow 2000/1850/5x` | — | hoje | local | ✅ | |
| 72 | other | consulta de fatura | quanto tenho de parcela no mês que vem? | Valor real | nenhuma | — | — | local | ✅ | |
| 73 | other | consulta de dívida | quanto eu devo de cartão? | Dívida restante + faturas | nenhuma | — | — | local | ✅ | |
| 74 | other | maior fatura | qual será minha maior fatura? | Fatura de maior valor prevista | nenhuma | — | — | local | ✅ | |
| 75 | other | sem cartões | quanto devo de cartão? (sem dados) | "Você ainda não cadastrou cartões…" | nenhuma | — | — | local | ✅ | |

## 9. Metas, saving e saldo

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 76 | other | criar meta | quero comprar um celular de 5000 em 6 meses | Meta nova | `goal "celular" 5000 · 6m` | — | — | local | ✅ | |
| 77 | other | meta duplicada | (criar meta com nome já existente) | Aviso antes de confirmar; nunca sobrescreve | `goal` + aviso | criar mesmo assim? | — | local | ✅ | |
| 78 | other | alterar meta | muda a meta do iphone para 8000 | Alterar a existente | `goal-update "iphone" 8000` | — | — | local | ✅ | |
| 79 | other | depósito em meta | guardei 100 para o iphone | Depósito na meta | `goal-deposit 100 · iphone` | — | hoje | local | ✅ | |
| 80 | other | guardar na reserva | separei 150 para a reserva | Transferência `saving`, não depósito em meta | `saving 150` | — | hoje | local | ❌ vira `goal-deposit` | |
| 81 | other | guardar sem meta | guardei 200 esse mês | `saving`, não meta | `saving 200` | — | hoje | local | ❌ | |
| 82 | other | retirar da reserva | tirei 100 da reserva | Reduzir reserva, aumentar disponível | retirada | — | hoje | local | ❌ não existe | |
| 83 | other | informar saldo | meu saldo é 1500 | Redefinir a âncora | `balance 1500` | — | agora | local | ✅ | |
| 84 | other | informar saldo variante | tenho 1500 no banco | Idem | `balance 1500` | — | agora | local | ✅ | |
| 85 | autonomo | meta alcançada | (sobra 1270, guardado 150, meta 150) | "Meta alcançada" só pelo guardado | nenhuma | — | — | local | ✅ regra 21 | |
| 86 | autonomo | sobra ≠ guardado | (sobra 1270, guardado 0, meta 150) | "Há valor disponível", **não** "meta alcançada" | nenhuma | — | — | local | ✅ | |

## 10. Motorista, combustível e veículo

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 87 | driver | trabalho | rodei 120 km e fiz 14 viagens | Um registro de trabalho | `work km 120 trips 14` | — | hoje | local | ✅ | |
| 88 | driver | horas | trabalhei 8 horas hoje | Horas registradas | `work hours 8` | — | hoje | local | ✅ | |
| 89 | driver | correção de trabalho | tira 100 km dos rodados hoje | Subtração de km | `work km −100` | — | hoje | local | ✅ | |
| 90 | driver | hodômetro isolado | meu hodômetro está em 220.007 km | Hodômetro, **nunca** km trabalhado | `odometer 220007` | — | — | local | ✅ | |
| 91 | driver | análise de corrida | essa corrida de 18 por 12 km vale a pena? | Análise com custo real | nenhuma | — | — | local | ✅ | |
| 92 | driver | valor mínimo | qual o valor mínimo de corrida que vale a pena? | R$/km mínimo e confortável | nenhuma | — | — | local | ✅ | |
| 93 | driver | custo por km | quanto meu carro custa por km? | Custo real; zero se não houver dados | nenhuma | — | — | local | ✅ | |
| 94 | driver | consumo | qual meu consumo? | km/L real de 2+ abastecimentos | nenhuma | — | — | local | ✅ | |
| 95 | driver | manutenção | quando preciso trocar meu óleo? | Próxima troca por km | nenhuma | — | — | local | ✅ | |
| 96 | driver | taxa da 99 | (após registrar receita de corridas) | Pergunta **separada** sobre a taxa | pergunta com botão | registrar a taxa? | hoje | local | ✅ | |
| 97 | autonomo | taxa da 99 indevida | recebi 1800 de aluguel | **Nunca** perguntar sobre a taxa | `income 1800` | — | hoje | local | ✅ | |
| 98 | clt | assunto de motorista | quanto meu carro custa por km? | Não responder com dados de motorista | nenhuma | — | — | local | ✅ guardas de `driverMode` | |

## 11. Ambiguidades, correções e negações

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 99 | driver | gás ambíguo | gastei 79 de gás | Perguntar antes de registrar | nenhuma até escolher | cozinha ou GNV? | hoje | local | ✅ | |
| 100 | other | gás qualificado | gastei 79 de gás de cozinha | Direto, sem pergunta | `expense 79 · casa` | — | hoje | local | ✅ | |
| 101 | driver | GNV qualificado | coloquei 79 de GNV | Abastecimento | `fuel 79` | — | hoje | local | ✅ | |
| 102 | other | correção de valor | não, era 50 (após propor 500) | Corrigir a proposta pendente | `expense 50` | — | hoje | local | ❌ sem referência à proposta | |
| 103 | other | negação | não registra isso | Cancelar a proposta | nenhuma | — | — | local | ❌ só pelo botão Cancelar | |
| 104 | other | referência ao passado | apaga aquele gasto de ontem | Remover transação específica | remoção | qual deles? | ontem | local | ❌ | |
| 105 | other | referência à última ação | desfaz o último registro | Desfazer | remoção | — | — | local | ❌ | |
| 106 | other | esclarecimento em 2 turnos | "comprei uma TV em 10x" → "custou 3000" | Juntar as duas mensagens numa proposta | `card-purchase 3000/10x` | — | hoje | híbrido | ❌ sem rascunho estruturado | |

## 12. Conversacional e entradas incompletas

| # | Perfil | Intenção | Frase | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 107 | driver | aviso do que vem | vou te passar quantos km fiz hoje | Resposta receptiva, **sem** registrar | nenhuma | — | — | local | ✅ coberto por `npm test` | |
| 108 | other | saudação | oi, tudo bem? | Resposta curta e cordial | nenhuma | — | — | remoto | 🔒 | |
| 109 | other | mensagem vazia | (espaços) | Nada acontece | nenhuma | — | — | local | ✅ `send` retorna cedo | |
| 110 | other | frase sem número | gastei um dinheirão hoje | Pedir o valor | nenhuma | quanto? | — | local | ⚠️ fallback genérico | |
| 111 | other | pedido de ajuda | o que você sabe fazer? | Lista de exemplos por perfil | nenhuma | — | — | local | ✅ | |
| 112 | other | reset | reseta tudo | Confirmação obrigatória antes de apagar | `reset` com confirmação | tem certeza? | — | local | ✅ nunca aceito do remoto | |

## 13. Erros remotos e limites de contrato

| # | Perfil | Intenção | Situação | Resultado esperado | Ações esperadas | Pergunta esperada | Data esperada | Mecanismo | Atual | Pós |
|---|---|---|---|---|---|---|---|---|---|---|
| 113 | qualquer | sem chave | `DEEPSEEK_API_KEY` ausente | Mensagem segura, sem vazar detalhe | nenhuma | — | — | remoto | ✅ `no-key` → 503 | |
| 114 | qualquer | timeout | DeepSeek demora > 20 s | "demorou demais" e fallback local | nenhuma | — | — | remoto | ✅ | |
| 115 | qualquer | rate limit | HTTP 429 | "muitas perguntas em pouco tempo" | nenhuma | — | — | remoto | ✅ | |
| 116 | qualquer | saldo insuficiente | HTTP 402 | Mensagem genérica, sem citar cobrança | nenhuma | — | — | remoto | ✅ | |
| 117 | qualquer | resposta vazia | conteúdo em branco | Retry único e depois erro claro | nenhuma | — | — | remoto | ✅ | |
| 118 | qualquer | resposta sem JSON | modelo devolve texto puro com ações descritas | Avisar que as ações não puderam ser lidas | nenhuma | — | — | remoto | ❌ texto aceito, ações somem em silêncio | |
| 119 | qualquer | ação desconhecida | `{"kind":"transfer"}` | Descartar com segurança | nenhuma | — | — | remoto | ✅ whitelist | |
| 120 | qualquer | ação `saving` remota | `{"kind":"saving","amount":150}` | Registrar transferência | `saving 150` | — | hoje | remoto | ❌ descartada sem aviso | |
| 121 | qualquer | ação com origem | `{"kind":"income",...,"origin":"Casa 1"}` | Preservar `origin` | `income` com `origin` | — | hoje | remoto | ❌ campo perdido | |
| 122 | qualquer | categoria inválida | `{"kind":"expense","category":"xpto"}` | Recusar ou cair no padrão | `expense · outros-out` | — | hoje | remoto | ❌ grava `xpto` | |
| 123 | qualquer | `reset` remoto | `{"kind":"reset"}` | Sempre recusado | nenhuma | — | — | remoto | ✅ | |
| 124 | qualquer | lote gigante | 20 ações | Limitar | máx. 8 | — | — | remoto | ✅ `slice(0, 8)` | |
| 125 | clt | ação de motorista remota | `{"kind":"fuel","amount":70}` em perfil CLT | Recusar por perfil | nenhuma | — | — | remoto | ❌ passa pela sanitização | |
| 126 | qualquer | divergência dev × prod | mesma frase em `npm run dev` e em produção | Mesmo comportamento | idênticas | — | — | remoto | ❌ prompts divergentes | |

---

## 14. Datas futuras, inválidas, períodos e DeepSeek indisponível

Adicionado em 29/07/2026. A fonte de verdade é
`tests/assistant/cases-temporal.ts`; todos os grupos abaixo passam contra o
orquestrador real com hoje fixo em 15/07/2026.

| Grupo | Casos | Regra protegida | Resultado |
|---|---:|---|---|
| Futuro e prazo relativo | 15 | Futuro nunca vira movimentação realizada; intenção futura é explicada | ✅ |
| Período sem dia | 2 | `mês/semana passada` perguntam o dia e preservam a janela | ✅ |
| Passado explícito | 5 | Hoje, ontem, anteontem e datas passadas continuam corretos | ✅ |
| Sem tempo informado | 1 | Hoje continua sendo o padrão somente quando o usuário não falou de tempo | ✅ |
| Escolha e correção | 5 | Opção de plano/data, dia inválido e data fora da janela não perdem o contexto | ✅ |
| Data impossível | 3 | `31/02` e `40/08` não viram descrição nem lançamento de hoje | ✅ |
| Sinais temporais sem dia exato | 6 | `em agosto`, `há 3 dias`, `fim do mês`, `ano passado` falham fechados | ✅ |
| Metas com horizonte textual | 2 | A barreira temporal não bloqueia meta, que não é fato realizado | ✅ |
| Passado + futuro na mesma frase | 4 | O fato passado sobrevive em qualquer ordem; o plano só é explicado | ✅ |
| **Total temporal** | **43** | | **43/43** |

As invariantes 28–36 cobrem a barreira de data futura, o não descarte de sinais
temporais, resposta vazia, HTTP 502/5xx/429/401/402, preservação de ações locais,
mensagem compreensível quando o remoto cai, ausência de “Confirmar?” sem ação e
a fiação de `pendingClarification` em `Chat.tsx`.

Auditoria da DeepSeek:

- resposta vazia: exatamente duas tentativas no total (a original + um `nudge`);
- HTTP 502 e demais erros HTTP: uma tentativa, sem retry automático;
- falha: zero ações, resposta segura e nenhum detalhe interno;
- mensagem mista: ação local preservada;
- pergunta só remota: aviso claro de indisponibilidade;
- teste real em 29/07: **8/8 sondas**.

---

## Resumo quantitativo

O quadro abaixo é o retrato **histórico anterior** à reformulação, mantido para
explicar de onde o trabalho partiu. O estado executável atual é
**477/477 casos e 60/60 invariantes**.

| Situação | Casos |
|---|---|
| ✅ Funciona | 81 |
| ⚠️ Parcial | 7 |
| ❌ Falha | 35 |
| 🔒 Só o contrato é auditável | 3 |
| **Total** | **126** |

Concentração das falhas: **datas** (6 casos), **`saving`/reserva** (5), **`origin`** (3),
**correções e referências** (5), **contrato remoto** (6), **atomicidade e confirmação parcial**
(3), **criação de recorrentes por conversa** (4).

---

## 15–16. Desfazer e corrigir (29/07/2026, segunda rodada)

Fonte de verdade: `tests/assistant/cases-undo.ts` e `tests/assistant/cases-edit.ts`,
mais as invariantes 37–53.

| Grupo | Casos | Regra protegida | Resultado |
|---|---:|---|---|
| Desfazer — caminho feliz | 4 | Lista o que sai, exige confirmação, reverte o lote inteiro | ✅ |
| Desfazer — lote de correção | 1 | O valor que VOLTA aparece antes de confirmar | ✅ |
| Desfazer — nada a desfazer | 3 | Lote inexistente, sem journal ou já desfeito é recusado com explicação | ✅ |
| Desfazer — não confundir | 3 | `apaga tudo` continua reset; "último" numa frase de registro não vira undo | ✅ |
| Corrigir — um candidato | 4 | Antes→depois à vista; valor, categoria e descrição | ✅ |
| Corrigir — vários candidatos | 2 | Pergunta com as opções; valor antigo dito desempata | ✅ |
| Corrigir — nenhum candidato | 2 | Explica, nunca inventa | ✅ |
| Corrigir — fora do escopo | 1 | Entrada financiada recusada, com a tela certa indicada | ✅ |
| Corrigir — não confundir | 2 | `goal-update` e registro novo seguem intactos | ✅ |
| Corrigir — ocorrência recorrente | 1 | Template preservado, ocorrência não liberada | ✅ |
| **Total** | **23** | | **23/23** |

Invariantes 37–53 cobrem: journal com entidades criadas e alteradas, lote recusado sem
rastro, ausência de texto de conversa e segredo no journal, cobertura de todas as
entidades, campos editáveis derivados do catálogo, `validateAction` em toda edição,
`firstDueDate` futuro permitido, reversão exata de vários formatos de lote, pagamento de
fatura reaberto, ocorrência recorrente devolvida a pendente, recusa de lote sem journal,
duplo undo, ausência de órfãos, undo que não vira lote novo, tipo preservado na correção,
correção auditável e reversível, template de recorrente intocado e bloqueio de
`edit-transaction`/`undo-batch` no canal remoto.
