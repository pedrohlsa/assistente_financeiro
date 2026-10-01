# Intelligence V2 — resposta à auditoria adversarial

Estado em 01/10/2026: branch `feat/assistant-intelligence-v2`, base auditada
`36d0135`. A primeira auditoria classificou essa base como **NOT READY**.
Esta rodada corrigiu os achados Critical e High reproduzidos, mas **não declara
READY**: falta a segunda auditoria independente do Astra sobre o diff novo.
Não houve push, merge, deploy, APK, chamada à DeepSeek ou gasto com modelo.
`.claude/launch.json` continua sendo configuração local fora dos commits.

O checkpoint RED anterior às alterações está em
[`AI_INTELLIGENCE_V2_ADVERSARIAL_RED.md`](AI_INTELLIGENCE_V2_ADVERSARIAL_RED.md).
O harness novo, [`tests/assistant/adversarial-real.ts`](../tests/assistant/adversarial-real.ts),
atravessa mensagem → `orchestrate` real → parser/planner → resposta/proposta/foco.
Nos casos com confirmação, aplica as ações por `applyBatchPure` e verifica o
estado resultante. Os valores esperados críticos são literais, não calculados
por `runScenario` ou pelo parser sob teste. Toda a bateria roda em `npm test`,
offline (`remoteEnabled: false`), com data fixa `2026-09-15`.

## C1–C3: causas e correções

| Achado | Causa na base auditada | Correção e regressão real |
| --- | --- | --- |
| C1 — corte/redução cria dinheiro | `runCompoundMonths` somava média histórica ou redução sem despesa correspondente na projeção | `representedRecurringExpenseMonths` mede só despesas futuras cadastradas ainda presentes na baseline. Corte retira no máximo esse valor; reduções são limitadas por mês e descontam reduções anteriores. Histórico variável fica como contexto, não crédito. Com renda R$ 1.000, histórico de obra R$ 300 e nenhuma obra futura, a sobra permanece R$ 1.000; guardar metade acumula R$ 2.000 em quatro meses. Redução de R$ 1.300 sem gasto futuro não aumenta a sobra; com conta de R$ 200, limita-se a R$ 200. Corte simples e composto usam a mesma primitive. |
| C2 — dupla contagem/calendário | `monthlyProjections` usava aproximação por frequência e mês, somando fatos já recebidos ou pagos ao saldo atual | Projeta `occurrencesBetween` por dia, respeitando `interval`, `intervalUnit`, início/fim e ocorrência resolvida; parcela paga não entra novamente. REDs: salário confirmado e parcela paga mantêm saldo R$ 800; recorrência bimestral entra só em setembro/novembro; conta encerrada 01/10 não vence em 28/10. |
| C3 — preferência muda dinheiro/data | Alias era validado por dígitos e blacklist parcial, aplicado antes da interpretação | Validação de tokens financeiros/temporais protegidos e checagem da assinatura antes/depois da aplicação. `cem → mil`, `sexta → segunda`, negação, confirmação, parcelas e números por extenso são recusados. `gastei cem reais` continua R$ 100. Aliases nominais seguros continuam permitidos. |

## H1–H9: causas e correções

| Achado | Correção e prova pelo orquestrador |
| --- | --- |
| H1 — porcentagem vira reais | `sobra` não é mais reescrita pelo corretor; parser preserva `save-share` para 30%, trinta por cento, metade, 50% e tudo. Com sobra R$ 1.000, 30% gera R$ 300/mês e R$ 1.200 em quatro meses. |
| H2 — vírgula decimal divide cenário | Separação de cláusulas ignora vírgula dentro de número pt-BR. Compra R$ 1.234,56 em 10x e redução R$ 100,50 permanecem exatas; `2,5k` e vírgula textual têm REDs distintos. |
| H3 — multi-origem inclui terceiros | `QueryFilter.origins` preserva conjunto fechado; validador e motor restringem linhas antes de agrupar/rankear. Casa 1 (100) + Casa 2 (200) = R$ 300, nunca inclui Casa 3 (9.000); comparação escolhe Casa 2. Há testes com duas/três origens, `ou`, juntas e separadas. |
| H4 — fragmentos somem | Início da reserva por mês (`a partir de novembro`), ano explícito no horizonte e limite de 12 meses; fragmento não suportado como `investir 200` aparece explicitamente como não incluído. Não há simulação numérica silenciosa para dezembro de 2027. |
| H5 — drivers ignoram recorte | O motor recebe `ChangeScope` explícito. Categoria citada limita fatos, totais, fatores e mudanças estruturais. `desde junho` primeiro pergunta se deve comparar com período anterior equivalente; após “sim”, compara 01/06–15/09 com 14/02–31/05, só alimentação (R$ 940 → R$ 2.125 no fixture), e reconcilia a diferença. |
| H6 — follow-up ressuscita query antiga | Quando cenário é o foco mais recente, refino não reconhecido esclarece; não cai em `lastQueryPlan` histórico. A sequência consulta de obra → cenário de reserva → “e tirando alimentação?” permanece no cenário/clarificação. |
| H7 — intenção/pedido/corrida viram fato | Segmentação preserva modalidade por cláusula. “Paguei 30 … e vou gastar 40” propõe só 30 e explica o 40 futuro. Pix pedido pergunta se foi enviado. Corrida oferecida pergunta se foi concluída/paga. Corrida concluída mas não paga não propõe receita recebida. O lote aplicado em memória não grava os valores não realizados. |
| H8 — Pix vira km | Transferência/parentesco não são corrigidos para verbo de distância; reparo de domínio trabalho é recusado quando a frase fala de Pix. “Mandei 15 de Pix” propõe saída de R$ 15, sem trabalho de 15 km, inclusive após aplicação em memória. |
| H9 — correção e valores somem | A correção usa o primeiro valor após “quer dizer”; item posterior permanece cláusula própria. Combustível 40 → 45 e pneu 30 geram dois registros, não um de 30. Devolução de 20 gera pergunta explícita. Guarda de resíduo monetário compara numerais da cláusula com as ações e esclarece valor não representado. Na frase longa: 20 recebido, 40 combustível, 30 pneu; Pix de 15 solicitado e corrida de 70 oferecida ficam em duas perguntas, sem lançá-los. O lote aplicado confirma só 20/40/30. |

## Mediums, privacidade e limites

- M1: esclarecimentos locais guardam o plano estruturado apenas no foco em
  memória. “Separadas”, “3 meses” e “desde junho” retomam a consulta original
  em dois turnos, sem consulta genérica nem categoria extra.
- M2/M3/M4: gatilho normalizado tem identidade única mesmo com duas propostas
  concorrentes; última confirmação substitui a anterior; remoção elimina a
  preferência ativa. `café`, `CAFÉ` e `cafe` casam de forma consistente. Load e
  merge validam formato antes de usar a lista; objetos/itens malformados são
  descartados, inclusive trigger que não é string.
- M6: corte simples e composto compartilham a despesa futura representada.
- M5 (anomalia estatística) **não foi alterado**: IDs repetidos, recência e
  confirmação textual do valor ainda merecem investigação separada. Não é
  classificado como fechado por esta rodada.
- A lista de preferências, amostras, histórico bruto, descrições históricas,
  saldos e journal não são enviados ao remoto pelo contexto. Porém o alias é
  aplicado localmente à **mensagem atual** antes do caminho remoto: em uma
  pergunta enviada ao planejador/chat, o **valor substituto** pode sair no texto
  da mensagem. Não dizer que o conteúdo de toda preferência “nunca sai do
  aparelho”. O foco de esclarecimento é plano estruturado e não entra no
  `RemoteConversationContext` sanitizado.
- Projeção não inventa gastos variáveis futuros não cadastrados. Composição
  parcial e limite de 12 meses continuam limitações declaradas. O build ainda
  emite o aviso preexistente de chunk principal maior que 500 kB.

## Verificação e commits

Gates finais offline desta rodada: núcleo/navegação verde; corpus **660/660**;
consulta/cenário/continuidade **99/99**; semânticos **50/50**; adversariais
pelo orquestrador real **46/46**; metamórficos **4.088 + 3.800**; fuzz **1.416**;
invariantes **150/150**; avaliador offline **468/468**; `typecheck`,
`typecheck:api` e `build` verdes. Os casos antigos de salário/aluguel, correção
falada, Uber/99, água 180, c-20 200, vale alimentação 800, 24 litros por 180,
decimais falados, 10x/12x, futuro, negação e barreira de alegação seguem no
corpus/invariantes/evaluator. Nenhuma avaliação remota paga foi executada.

Commits desta resposta à auditoria:

- `dbe0bca` — baseline mensal/cenários e checkpoint RED;
- `66685df` — preferências, multi-origem, drivers e foco de cenário;
- `a733a1f` — modalidade por cláusula, Pix, correção e cobertura monetária;
- `a8cbc53` — continuação de esclarecimentos de consulta;
- `95f613d` — continuação do recorte causal de drivers.

**Próximo passo:** segunda auditoria adversarial do Astra no diff contra
`36d0135`. Mesmo com gates verdes, não fazer merge, push ou deploy antes de
avaliar o novo veredito. Não gerar APK nesta rodada.
