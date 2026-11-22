# Passagem para o Claude — AssistFin, rodada 2 de 21/11/2026

O Stuart pediu para continuar melhorando a compreensão do português falado até a reserva para a passagem. O último uso indicado antes de escrever este arquivo foi de 95% da janela de cinco horas.

## Repositório e escopo

- Repositório de trabalho `/home/stuart/work/assistfin`, branch `feat/assistant-intelligence-v2`.
- HEAD final `83461abe8d05355ae791794b8a4bc012be895e8e`. A rodada começou em `da063f7` e tem 24 commits locais. Veja `git log --oneline da063f7..HEAD` e as entradas datadas em `PROGRESS.md`.
- A cópia do Copiloto em `/home/stuart/work/assistfin-driver-copilot` está em `feat/driver-copilot` no commit `3cfdbd1`. A rodada deixou essa cópia intacta.
- O projeto continua **NOT READY**. Push, merge, deploy e distribuição dependem de autorização explícita. O repositório manteve os handoffs anteriores fora dos commits. Este arquivo também fica local e fora dos commits.
- A regra 34 continua em vigor. Uma receita agregada da Uber ou da 99 só conta viagens quando a pessoa informa a quantidade ou descreve uma corrida concluída. O valor recebido, a quilometragem e as horas podem ser registrados separadamente.

## Comportamentos entregues

| Área | Exemplos e resultado | Arquivos principais |
| --- | --- | --- |
| Data e cartão | “Ontem ou anteontem comprei uma cadeira de 250 em 2x, primeiro vencimento em 10/12” pergunta o dia e preserva o vencimento. “Não foi ontem, foi anteontem” usa a data afirmada. A recusa sem substituto mantém a pergunta. | `dates.ts`, `drafts.ts`, `cardPurchaseDue.ts`, `orchestrator.ts` |
| Origens reais | “Recebi 120,50 da ana e 120,5 do joão” cria duas propostas separadas. “Joao pagou 40 pro supermercado” descreve outra pessoa. “Na Uber recebi 120 da maria” conserva Maria. “Pela 99 entrou 88” conserva a plataforma. | `clauses.ts`, `corrections.ts`, `services/nlp.ts` |
| Consulta por pessoa | Ana e Ana Paula ficam separadas. “E do João?” conserva o período, e “somando as duas?” soma só as duas origens. “Quanto ela me pagou?” exige uma referência única. A resposta projetada só inclui um Pix pendente se mencionar a confirmação. | `query/parse.ts`, `query/engine.ts`, `query/answer.ts`, `query/validate.ts`, `conversation/focus.ts` |
| Natureza do dinheiro | Recebimento bancário sem plataforma entra em Outros. Transferências próprias, retirada da reserva e empréstimo bancário ficam fora das receitas. Uma entrada financiada pelo cartão continua seguindo seu fluxo próprio. | `clauses.ts`, `cashQuestions.ts`, `services/ai.ts` |
| Ofertas | Uma chamada fica fora do caixa. O chat compara duas ofertas, lê “1h30” e aceita preço, km e tempo em turnos separados. Soma retorno explicitamente adicional e pergunta se um total ambíguo já inclui a volta. A taxa horária usa o tempo com retorno. | `rideOffer.ts`, `contracts.ts`, `orchestrator.ts` |
| Jornada realizada | “Fiz uma corrida de 45 com 15 km e mais 10 km na volta” prepara 25 km, uma viagem e R$ 45. Quinhentos metros viram 0,5 km. “1h99” pergunta a duração e guarda data, km e receita. “Às 8h” não completa duração. | `semantic/clock.ts`, `services/nlp.ts`, `clauses.ts`, `orchestrator.ts` |
| Totais e meios de pagamento | “Paguei 60 incluindo 10 de frete” conserva R$ 60. Totais declarados e itens são conferidos em centavos. Em compra de R$ 150,50 com R$ 50,25 no Pix e R$ 100,25 no cartão, só o Pix sai do caixa ao confirmar a despesa. As duas partes usam a mesma data e a compra aguarda as parcelas quando faltam. | `spokenTotals.ts`, `orchestrator.ts` |
| Repasse líquido | “A 99 descontou 50 de taxa e caiu 380” prepara R$ 380, com a taxa já retida. A marca é local e não abre novo aviso de taxa. Uma taxa paga à parte continua saída. | `platformPayout.ts`, `contracts.ts`, `services/profile.ts`, `screens/Chat.tsx` |

Os caminhos da tabela a partir de `dates.ts` e módulos afins ficam sob `src/assistant/`. `services/` e `screens/` ficam sob `src/`. As regressões novas estão em `tests/assistant/adversarial-real.ts`.

## Validação concluída

- No HEAD final, `npm test` passou com 733/733 no corpus, 1.348/1.348 regressões adversariais e 151/151 invariantes. Também passaram 99 novos casos do conjunto complementar, 50 casos semânticos, cinco testes de ditado com reconhecedor simulado e 468 verificações do canal remoto simulado.
- `npm run test:calendario` passou nas oito datas do comando. Os totais adversariais por data variaram de 1.343 a 1.348 conforme os casos condicionais. A matriz rodou durante os dois últimos ajustes de compatibilidade TypeScript, que preservaram a lógica. A suíte completa, os dois typechecks e a compilação passaram no HEAD final.
- Matriz adicional com 1.120 cenários em cada fuso, 3.360 ao todo. America/Sao_Paulo, UTC e Pacific/Auckland, quatro perfis e dez datas. Nenhum cenário chamou os simuladores remotos.
- `npm run test:money` passou. A rubrica teve 85 excelentes, cinco aceitáveis, zero ruins e zero perigosas. A compilação mantém o aviso de tamanho do pacote principal.
- Chrome isolado e sem HTTPS externo confirmou os três fluxos no HEAD final. Confirmou ônibus antes de escolher anteontem no cartão, completou a oferta em três turnos sem perder a despesa, consultou Ana e João e confirmou R$ 380 líquidos da 99. Também confirmou Pix e cartão em etapas sem repetir a saída.

Logs em `/tmp/assistfin-ia-2026-11-rodada2-*.log`. Script da matriz independente em `/home/stuart/Documents/Codex/2026-11-18/ass/work/assistfin-ia-rodada2-matriz.mts`. Os testes Chrome estão na mesma pasta com os nomes `assistfin-escolha-data-cartao-browser.mjs`, `assistfin-rodada2-oferta-etapas-browser.mjs` e `assistfin-rodada2-repasse-pix-cartao-browser.mjs`. Eles usam o preview local em `http://127.0.0.1:5198`.

Para retomar, rode `git status --short`, confira o HEAD e use o Node v22.23.5 do ambiente. Rode `npm test`, `npm run test:calendario`, `npm run typecheck`, `npm run typecheck:api`, `npm run test:money`, `npm run rubric` e `npm run build`. Para a matriz independente, execute o arquivo com `node_modules/.bin/tsx` e defina `TZ` para cada um dos três fusos.

## Pendências e próximos casos

- Voz com microfone e reconhecedor reais, Android em aparelho, APK e DeepSeek real continuam sem validação. O navegador desta rodada testou texto digitado e gravação local com perfis fictícios.
- Retirada da reserva e empréstimo bancário sem cartão ainda não têm lançamento próprio. O chat informa a limitação. Compras divididas em dois cartões pedem valores separados. Pix, débito e dinheiro da mesma compra são tratados como uma despesa pelo total quando não há crédito.
- Próxima sonda de fala sugerida pelo que restou nesta rodada. “Rodei 64 km e 14 voltando” ainda pode pedir esclarecimento sobre 14 porque a unidade foi omitida. Validar o escopo da unidade antes de mudar, preservar o total de trabalho e fazer controle com “14 reais na volta”. O retorno já funciona quando a pessoa diz “14 km”.
- Depois disso, testar refinos de oferta já calculada. A recuperação em vários turnos cobre ofertas ainda aguardando dados. Uma revisão como “na verdade o retorno era 7 km” depois de já dar a resposta completa ainda merece uma sonda própria.
