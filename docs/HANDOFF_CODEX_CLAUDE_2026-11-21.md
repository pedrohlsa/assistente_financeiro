# AssistFin V2 · passagem do Codex para o Claude · 21/11/2026

## Repositório e limites da rodada

A revisão da IA está em /home/stuart/work/assistfin, na branch local feat/assistant-intelligence-v2. A rodada começou em d342626 e terminou em da063f7698479280bd85036281615e27b5a00c06. São 12 commits locais. Rode git status --short --branch e git log -12 --oneline antes de alterar a árvore. Este arquivo e os quatro handoffs anteriores ficam fora dos commits.

A worktree /home/stuart/work/assistfin-driver-copilot usa feat/driver-copilot em 3cfdbd1. O Copiloto separado segue com o avaliador offline daquela rodada. As mudanças deste documento são da V2 e do assistente de chat.

O produto segue **NOT READY**. Push, merge, deploy, publicação, teste externo de DeepSeek e distribuição de APK exigem autorização explícita. Os testes desta rodada usaram dados sintéticos, o modelo simulado e perfis isolados do Chrome. O pedido do Stuart foi continuar corrigindo a compreensão do português falado e deixar a passagem com cerca de 5% disponíveis na janela de cinco horas.

A última leitura marcou **95% usados** na janela de cinco horas. O repositório estava limpo de alterações rastreadas e o HEAD era da063f7.

A regra do motorista está decidida. Um dia de R$ 430 na Uber e R$ 399 na 99 registra as duas receitas, com quilômetros e horas quando ditos. A quantidade de viagens vem do que a pessoa informou. A receita de plataforma sozinha nunca fornece contagem.

## O que mudou

| Commit | Mudança e reprodução |
| --- | --- |
| 90c18cf | “Ontem passei 80 no cartão” leva a data da compra até o plano, inclusive quando pergunta as parcelas ou quando a pessoa corrige para débito. Para o cartão que fecha dia 20, uma compra de 20/11 usa o vencimento de 25/11. |
| 3094d5a | “Paguei 20 de ônibus hoje e passei 80 no cartão ontem” prepara as duas movimentações separadas. Confirmar o ônibus antes de responder as parcelas mantém uma despesa de R$ 20. Receber aluguel na mesma frase continua sendo receita independente. |
| f8ad0a2 | “E se a Casa 2 ficar vazia por três meses?” usa o intervalo de tempo dito. No exemplo de 21/11, vai até 20/02 e retira os R$ 4.800 de aluguel da Casa 2 que ainda estavam em aberto. Casa 20, serviço da Casa 2 e aluguel já recebido seguem no cálculo. “E por mais um mês?” refaz o cenário em quatro meses. |
| a42d9b7 | “E se eu quitar o computador hoje?” usa só parcelas em aberto e pagamentos parciais. “E se sair por 500?” reaproveita o plano e calcula com esse preço. Se houver nomes repetidos, pede a compra ou permite distinguir pelo cartão. |
| 9fe1fc0 | “Hoje é feriado, vale rodar?” usa ao menos três dias comparáveis das últimas oito semanas com horas e receita de corridas. A referência é média bruta ponderada por hora. “Tô cansado, paro ou continuo?” e a menção de sono depois da pergunta puxam a orientação de pausa em local seguro. |
| 6292fed | “Recebi 120 do Uber, quer dizer, 100 da Casa 2” produz uma receita de R$ 100 em Outras receitas. Mudar só o imóvel de um aluguel preserva sua categoria. “Errei, foi 100 do Uber” também corrige valor e origem de uma proposta aberta. |
| 12944a8 | “Quanto gastei mesmo ontem?” respeita ontem. “Quanto sobrou tirando a gasolina anteontem?” usa anteontem. Datas, mês nomeado e intervalos passam pelo leitor compartilhado, incluindo a data da projeção de registros pendentes. |
| 47956ed | A análise de oferta soma a ida até o passageiro à viagem e usa o tempo informado. Sem custo por km, mostra o bruto. “Recebi 22 por uma corrida de 8,5 km” propõe R$ 22 e uma viagem explícita, com os 8,5 km protegidos de virar receita. |
| e80e319 | O primeiro vencimento pode ser dito separadamente da data da compra. Vencimento inválido segura a proposta até a correção. Chrome confirmou uma compra em 20/11 com duas parcelas em 28/11 e 28/12 após corrigir o dia. |
| 42358ba | A média por viagem exige receita de corridas e quantidade no mesmo dia. Aluguel não muda a média e as telas exibem indisponível quando falta base. A pergunta por Uber ou 99 pede contagem por app. |
| 83ef572 | “Se a Casa 2 não pagar este mês” usa até o último dia do mês. “Mês que vem” preserva as entradas deste mês e altera só as ocorrências do seguinte. “Casa 2” responde à pergunta de qual imóvel mantendo o prazo. |
| da063f7 | “Há uma hora e quinze minutos” e “faz 1h30” usam a duração completa. “Faz uns 30 minutos” pede horário. “Ontem às 23h50” completa a proposta com valor e descrição preservados. A data relativa respeita a virada da meia-noite. |

## Como revalidar

Use Node 22 no repositório da V2. A versão desta máquina foi v22.23.5.

~~~sh
cd /home/stuart/work/assistfin
npm test
npm run test:calendario
npm run typecheck
npm run typecheck:api
npm run test:money
npm run rubric
npm run build
~~~

A suíte padrão em da063f7 teve **733/733** casos do corpus base, **1.228/1.228** regressões adversariais, **151/151** invariantes, **1.416** mensagens hostis, **5/5** verificações de ditado com reconhecedor simulado e **468** verificações do canal remoto em 120 casos sem rede. As regressões adversariais têm casos condicionais e variam na matriz. A rubrica registrou **0 perigosas, 0 ruins, 5 aceitáveis e 85 excelentes** em 90 respostas. Typechecks, testes monetários e build passaram. O Vite ainda avisa sobre um pacote acima de 500 kB.

A matriz de calendário passou nas oito datas em da063f7. A menor contagem foi 1.223/1.223 em 30/11/2026. As oito rodadas preservaram as 151 invariantes.

A matriz independente /home/stuart/Documents/Codex/2026-11-18/ass/work/assistfin-ia-continua-matriz.mts fez 270 verificações em cada fuso America/Sao_Paulo, Europe/Lisbon e America/New_York. Foram **810/810** ao todo, com nove datas, quatro perfis, viradas e ano bissexto. Os mocks de chat e de planejamento remoto ficaram disponíveis e receberam zero chamadas nesses casos. O teste /home/stuart/Documents/Codex/2026-11-18/ass/work/assistfin-horario-virada-independente.mts cobre doze verificações com relógio em 00h15.

Os roteiros de Chrome estão em /home/stuart/Documents/Codex/2026-11-18/ass/work. A rodada final executou assistfin-compra-data-browser.mjs, assistfin-cartao-misto-browser.mjs, assistfin-vacancia-browser.mjs, assistfin-quitacao-browser.mjs, assistfin-oferta-browser.mjs, assistfin-vencimento-browser.mjs e assistfin-horario-virada-browser.mjs. Eles usam o build local em http://127.0.0.1:5198. Os roteiros carregam dados artificiais, bloqueiam HTTPS e validam o que ficou no armazenamento da nova sessão.

Os relatórios mais recentes estão em /tmp/assistfin-ia-horario-exato-suite.log, /tmp/assistfin-ia-horario-exato-calendario.log, /tmp/assistfin-ia-horario-exato-rubrica.log, /tmp/assistfin-ia-final-money.log, /tmp/assistfin-ia-horario-exato-build.log e /tmp/assistfin-ia-final-independente-*.log. Os primeiros handoffs preservam o histórico anterior.

## Pontos de entrada

- src/assistant/orchestrator.ts, src/assistant/clauses.ts e src/assistant/drafts.ts ligam as partes da fala a propostas e esclarecimentos.
- src/assistant/cardPurchaseDue.ts separa o primeiro vencimento, e src/assistant/execute.ts usa as datas na criação do plano.
- src/services/ai.ts e src/assistant/query/period.ts aplicam a janela pedida em consultas. src/services/calc.ts e src/assistant/query/engine.ts aplicam a média por viagem.
- src/assistant/driverAdvice.ts e src/assistant/rideOffer.ts tratam turno, cansaço e análise de oferta. O parser de movimento está em src/services/nlp.ts.
- src/assistant/scenario/incomeWindow.ts, src/assistant/scenario/payoff.ts e src/assistant/conversation/focus.ts guardam as fontes, os prazos e a continuação de cenário.
- src/assistant/semantic/clock.ts trata pontuação, duração, aproximação e horário relativo. Os casos da superfície real estão em tests/assistant/adversarial-real.ts.

## Pendências para retomar

1. Validar voz real em português, Android e APK no aparelho. Exercitar ditado com rodagem, valores e datas mistas, pausa e repetições. A validação desta rodada usou Chrome de computador e reconhecimento simulado.
2. Validar DeepSeek real com autorização e um estado sintético. Comparar o plano devolvido às somas locais e verificar rejeição a mudanças de valor, modalidade, data e origem. O canal remoto simulado está coberto.
3. Duas ofertas na mesma frase são reconhecidas como pergunta e o chat pede uma por vez. A comparação direta precisaria distinguir cada valor, seus quilômetros até o passageiro e seu tempo, além do custo informado do veículo.
4. Preservar os dados da compra quando há datas alternativas junto com o vencimento. “Ontem ou anteontem comprei uma cadeira de 250 em 2x no Nubank, primeiro vencimento em 10/12/2026” pede novamente a compra inteira. O resultado desejado é perguntar apenas qual foi o dia, mantendo R$ 250, 2x, Nubank e o vencimento.
5. Ampliar os testes com fontes e horários inventados pelo ditado. Começar por nomes próprios em minúsculas, como “recebi 110 do joão ontem às 8h”, em que a entrada permanece, mas a origem pode vir sem o nome.
