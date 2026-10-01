# AssistFin — fechamento local da Intelligence V2

Data: 25/09/2026. Branch: `feat/assistant-intelligence-v2`. Ponto de partida desta
rodada: `9c9c72b`. Este documento complementa o checkpoint
[`AI_INTELLIGENCE_V2.md`](AI_INTELLIGENCE_V2.md); não substitui sua descrição de
C3/C4/C6/C7/C8 e dos drivers. Escopo desta rodada: três dívidas finais, sem
mudança de modelo remoto nem publicação.

## 1. Desenho da acumulação mensal

O Scenario Engine existente recebe um plano ordenado e usa
`monthlyProjections(state, meses, hoje)` como calendário/base read-only. Para
cada mês há um efeito incremental e um depósito simulado. Cortes, reduções,
compra/parcelas e entrada ausente suportadas alteram a base simulada; um passo
`save-share` deposita a fração da sobra **daquele mês**, nunca de uma média
multiplicada pelo horizonte. O acumulado é a soma arredondada dos depósitos,
sem escrever transações, saldos ou metas reais. O horizonte é limitado a 12
meses; o mês corrente segue a semântica já usada por `monthlyProjections`.

## 2. Exemplo mês a mês

Uma invariante com receita cadastrada de R$ 1.000/mês, conta cadastrada de
R$ 200 que termina após o primeiro mês e `guardar metade` produz:

| Mês projetado | Sobra usada | Reservado | Acumulado |
|---|---:|---:|---:|
| 1 | R$ 800 | R$ 400 | R$ 400 |
| 2 | R$ 1.000 | R$ 500 | R$ 900 |
| 3 | R$ 1.000 | R$ 500 | R$ 1.400 |

Os números vêm do motor local. A resposta traz o selo “Simulação — nada foi
registrado.”. É uma projeção das entradas, contas e parcelas **cadastradas**;
gastos variáveis futuros desconhecidos não são inventados e a ressalva aparece
na resposta.

## 3. Estado intermediário e ordem das transformações

Não há cópia do reducer financeiro. `runCompoundMonths` mantém um
`projectedState` pequeno para obrigações que `monthlyProjections` já sabe
projetar, mais vetores mensais `effects` e `saved`. Compra injeta parcelas;
cortar recorrência a retira da projeção respeitando início/fim; cortar gasto
variável usa a média dos três meses completos anteriores, excluindo itens com
`recurringId`; reduzir categoria soma efeito informado; entrada ausente afeta
só o primeiro mês, pois repetir a ausência seria uma hipótese nova. A ordem
oficial é a ordem declarada no plano: `cortar → guardar metade` pode reservar
mais que `guardar metade → cortar`. Corte repetido não é somado outra vez e
redução seguida de corte na mesma categoria é compensada. `pay-invoice`,
`spend` e `extra-work` ainda não têm materialização mensal segura nesse
compositor: retornam resultado parcial com ressalva, não números completos
fingidos.

## 4. Invariantes de cenário

Cobertura nova comprova: estado real byte a byte inalterado; acumulado igual à
soma dos depósitos; depósito nunca negativo com sobra não positiva; horizonte
sem mês duplicado; encerramento de recorrência alterando cada mês correto;
corte aplicado uma vez; ordem não comutativa respeitada. O harness de cenário
também verifica a sequência de meses. Os casos `c-82` e `c-83` cobrem a
conversa de guardar metade e o follow-up “até dezembro?”.

## 5. Modelo de preferências explícitas

`AssistantPreference` tem `id`, `kind`, `trigger`, `value`, `createdAt`,
`updatedAt` e `source: 'user-explicit'`. Os tipos são `alias`,
`entity-alias`, `category-mapping` e `terminology`. É dado estruturado local,
não um blob de prompt ou memória livre. Exemplos aceitos: `gasosa → gasolina`,
`Casa Azul → Casa 2`, `Mercadinho do João → alimentação` e
`trabalho → freelance` pela frase “quando eu falar trabalho considera
freelance”. Não há embeddings ou chamadas remotas para aprender isso.

## 6. Precedência

Categoria informada explicitamente **no turno atual** prevalece. Depois vem
o mapeamento estruturado ensinado pelo usuário; histórico confirmado serve
como sugestão de menor prioridade; palpite remoto não pode sobrescrever a
preferência. Aliases locais são aplicados antes de analisar a mensagem ou
validar a proposta remota. A camada não substitui valores, modalidade,
tipo explícito de receita/despesa, confirmação ou regras financeiras.

## 7. Persistência e migração

`assistantPreferences` é campo opcional em `AppState`, normalizado para lista
vazia quando ausente. Entradas restauradas são validadas. Backup antigo
`assistfin-state-v1` continua carregando sem o campo; importação mescla por
`id`; reset apaga as preferências junto com o estado. A lista não é enviada
no `RemoteConversationContext` ou `buildAiContext`; só o texto atual já
interpretado pode seguir o fluxo remoto normal quando necessário.

## 8. Edição, remoção e confirmação

O domínio oferece `upsertPreference`, `updatePreference` e
`removePreference`. Reensinar o mesmo gatilho/tipo atualiza o valor mantendo
identidade e data de criação. No chat, ensinar ou esquecer cria uma proposta
com **Confirmar/Cancelar**; nada é salvo antes da confirmação. “Lista minhas
preferências” mostra a lista, e “esquece essa preferência” remove apenas
quando há uma única candidata; com várias, pede o nome. Propostas pendentes
não sobrevivem a reload. Não foi criada tela própria em Configurações; a
edição exposta ao usuário é por nova frase de ensino.

## 9. Histórico não reinterpretado

Preferências só afetam compreensão de mensagens futuras. Nenhum lançamento
antigo é reprocessado. Uma invariante compara `transactions` antes/depois do
ensino; outra testa confirmação, uso posterior de “gasosa”, remoção e perda
do alias. Números, datas, modalidade e verbos financeiros são bloqueados como
gatilhos/valores de preferência: “100 → 1000”, “amanhã → ontem” e
“gastei → recebi” não são salvos.

## 10. Detector por estabelecimento/origem

`merchantAmountProfile` procura transações do mesmo tipo financeiro, mesma
categoria e **mesma identidade normalizada exata** da descrição ou origem
(origem tem preferência quando informada na ação). Não agrupa por substring:
“Posto Shell Tijuca” não vira “Shell Shopping”. Sem nome confiável, permanece
o detector por categoria existente. Para uma ação nomeada sem perfil local
confiável, o detector prefere ficar quieto. O alerta é consultivo, não muda
valor nem impede Confirmar.

## 11. Regra estatística

Para perfil local, calcula mediana e MAD (mediana dos desvios absolutos). Só
alerta para valor pelo menos **4×** a mediana de um histórico estável, com
`MAD ≤ 25%` da mediana. O detector de categoria já existente mantém seu
limiar próprio de **6×** e não foi misturado ao conceito de estabelecimento.
Valor baixo incomum em estabelecimento nomeado não gera novo alerta.

## 12. Mínimo de amostras

São exigidas pelo menos **seis** transações elegíveis e de valor positivo no
perfil da identidade. Primeira compra e duas amostras ficam sem aviso.

## 13. Recência

O perfil de identidade usa somente os **120 dias anteriores** ao dia do
turno, no máximo os 60 lançamentos recentes elegíveis, aproveitando a janela
de recência da personalização existente. Padrão de anos atrás não serve como
evidência atual.

## 14. Falsos positivos

As invariantes cobrem seis valores estáveis de R$ 85–95 seguidos de R$ 450
(avisa); nome parecido mas diferente (silêncio); duas amostras (silêncio);
seis valores dispersos ou mudança gradual (silêncio); dados antigos
(silêncio); R$ 40 em vez de valor alto (silêncio); e perfil por origem. Compra
grande legítima pode receber **pergunta**, mas nunca é bloqueada. Se o usuário
confirmar, o valor original é preservado.

## 15. Drivers versus anomalia

`median` e `medianAbsoluteDeviation` estão em `statistics.ts` para reúso.
O driver de despesa extraordinária só reutiliza a primitiva de mediana;
mantém seu critério e sua finalidade: explicar a variação do mês. Anomalia
serve para confirmar um lançamento atípico. A identidade de reconciliação
dos drivers continua coberta: soma das contribuições = delta do resultado.

## 16. Conversas novas

O cenário encadeado reconhece “e se eu parar a obra?” → “e guardar metade do
que sobrar?” → “até dezembro?”, preservando o cenário e acrescentando
`save-share` e horizonte. O ensino “quando eu falar gasosa é gasolina” →
“gastei 200 de gasosa” usa a preferência depois da confirmação; “esquece essa
preferência” desliga o alias depois de confirmada a remoção. A frase de
terminologia com “considera freelance” tem teste específico.

> **Atualização de 01/10/2026:** a auditoria adversarial posterior a este
> relatório encontrou bloqueios Critical/High. Eles foram corrigidos na branch,
> com regressões pelo orquestrador real, mas a branch **não está declarada
> READY** até a segunda auditoria independente do Astra. Ver
> [AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md](AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md).

## 17. Auditoria de UX

As respostas reais do compositor e propostas foram lidas. A projeção mostra
no máximo quatro linhas mensais e o total final; quando todos os depósitos
são zero, resume o período em uma frase. A preferência mostra exatamente o
par aprendido e pede confirmação, sem parecer aprendizado silencioso. O
aviso usa “Esse valor está bem acima do seu padrão recente em Posto X.
Confirma R$ 450,00?” — pergunta curta, sem acusar nem expor a estatística.
Clarificações antigas e o selo de simulação permanecem.

## 18. Casos novos

O conjunto consulta/cenário/continuidade passou de 97 a **99**: dois casos
novos de acumulação/follow-up. Cobertura de preferências e anomalias entrou
principalmente nas invariantes, não por aumento artificial do corpus.

## 19. Invariantes

Passaram de 138 a **150/150**: 94 financeiras, 38 do copiloto e 18 do canal
remoto. As novas propriedades cobrem calendário, soma, ordem, não mutação,
CRUD, backup antigo, precedência, confirmação, privacidade e negativos de
anomalia. O autoteste do avaliador remoto usa transporte falso/replay.

## 20. Metamórficos

Continuam verdes **4.088** mutações que preservam sentido e **3.800** que
mudam modalidade. Não foram criadas novas mutações nesta rodada; servem de
gate de regressão para futuro, negação e interpretação financeira.

## 21. Regressões encontradas e resolvidas

Durante a implementação, fixtures novas precisaram completar o contrato de
categoria e evitar uma API de array não disponível no alvo TypeScript; o
`typecheck:api` voltou a passar. A auditoria final achou que a forma explícita
“quando eu falar trabalho considera freelance” ainda não era reconhecida;
o parser e o teste foram corrigidos. Nenhuma regressão permanece conhecida
nos gates rodados. Casos antigos como `c-75` e `k-14` seguem protegidos.

## 22. Totais finais

`npm test`: núcleo/navegação verde (inclui 9 verificações); corpus **660/660**;
consulta/cenário/continuidade **99/99**; semânticos **50/50**; metamórficos
**4.088 + 3.800**; fuzz **1.416**; invariantes **150/150**; avaliador offline
**468/468**. `npm run typecheck`, `npm run typecheck:api` e `npm run build`:
verdes na verificação final. O aviso preexistente de chunk acima de 500 kB
permanece no build.

## 23. Arquivos principais

- Cenário: `src/assistant/scenario/{parse,engine,answer,types}.ts`,
  `src/assistant/conversation/focus.ts`, `src/services/calc.ts`,
  `tests/assistant/{cases-cenario,scenarioHarness,properties-copiloto}.ts`.
- Preferências: `src/assistant/preferences.ts`, `src/models/types.ts`,
  `src/store/store.tsx`, `src/screens/Chat.tsx`,
  `src/assistant/{orchestrator,learning}.ts`.
- Anomalia e drivers: `src/assistant/{learning,explain,statistics}.ts`,
  `src/assistant/drivers/engine.ts`,
  `tests/assistant/properties-copiloto.ts`.

## 24. Commits desta rodada

- `277d019` — acumulação mensal de cenários;
- `9fbf03a` — preferências explícitas locais;
- `6f6c20c` — anomalia por estabelecimento/origem;
- `6461648` — reconhecimento de terminologia ensinada explicitamente.

O checkpoint anterior é `9c9c72b`. Não houve push.

## 25. Estado do Git

Branch `feat/assistant-intelligence-v2`. Após o commit deste relatório,
`git status` deve mostrar **somente** `M .claude/launch.json`, modificação
local preexistente e intencionalmente fora dos commits. Confirmar novamente
antes de merge ou qualquer publicação. Nenhum merge foi feito nesta rodada.

## 26. Dívida técnica restante

- Não há editor visual dedicado para preferências em Configurações; o chat e
  as funções de domínio cobrem listar, ensinar/editar e remover.
- A projeção mensal considera só obrigações e entradas cadastradas, mais as
  transformações representáveis; gastos variáveis futuros desconhecidos não
  entram. Alguns tipos de passo composto retornam resultado parcial com
  ressalva, não uma simulação mensal completa.
- Horizonte máximo de 12 meses; a resposta detalha até quatro meses para
  evitar uma tabela longa.
- O build ainda aponta o chunk acima de 500 kB, já existente antes da rodada.

## 27. Prontidão e limite desta tarefa

A afirmação original de prontidão foi **revogada** pela auditoria adversarial.
O estado vigente está no relatório de correções ligado acima. Há gates locais
verdes, mas a segunda auditoria Astra ainda é obrigatória antes de qualquer
decisão de merge/deploy. Nesta rodada: **zero DeepSeek, zero gasto com modelo,
zero push, zero merge, zero deploy e zero APK**.
