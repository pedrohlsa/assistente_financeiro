# Avaliação semântica dos modelos remotos

Preparada em 13/09/2026 e revista em 15/09/2026, branch `feat/assistant-semantic-copilot`.
**Nenhuma chamada paga foi feita.** A execução depende de autorização explícita de gasto.

O objetivo não é achar o modelo mais caro. É medir qual configuração da API entrega a melhor
qualidade **nas situações em que o AssistFin de fato chama a IA remota**, sem que nenhuma
eloquência compense uma ação financeira perigosa.

---

## 1. O que a API oferece hoje

`GET /models` (consultado em 13/09/2026 com a chave do `.env`, sem exibi-la) devolve **dois** modelos:

| Modelo | Versão servida | Contexto | Saída máx. | Entrada (cache) | Entrada (sem cache) | Saída |
|---|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | 384K | US$ 0,006 | US$ 0,30 | US$ 1,20 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | US$ 0,044 | US$ 1,32 | US$ 3,96 |

Preços por milhão de tokens, horário de pico. Fora do pico é a metade; o pico vai de 01h a 04h e de
06h a 10h UTC, de segunda a sexta. Fonte: página oficial de preços, consultada em 13/09/2026.

**Limitações encontradas**, todas documentais (nenhuma verificada com chamada paga):

1. **O código de produção usa um nome LEGADO.** O padrão de `api/_lib/deepseek.ts` é
   `deepseek-v4-flash` (conferido de novo em 15/09/2026), que não aparece mais em `/models`. O
   changelog de 10/09/2026 diz que esse nome é "temporariamente roteado" para o V4.1 Flash e cobrado
   como Flash. O valor de `DEEPSEEK_MODEL` na Vercel não é visível daqui. **Não foi alterado.**
2. **O pensamento vem LIGADO por padrão** (`thinking.type` padrão `enabled`, esforço `high`). A
   chamada de produção manda `model`, `messages`, `temperature` (0,2; 0 no reenvio) e
   `max_tokens: 900` — e **não** manda `thinking` (conferido de novo em 15/09/2026). Três
   consequências possíveis e não documentadas: `temperature` é ignorado em modo de pensamento; não se
   sabe se `max_tokens: 900` limita o raciocínio junto com a resposta; e, se limitar, uma resposta
   pode ser cortada e virar o `empty-reply` intermitente registrado em julho. A configuração C mede
   isso. **Não foi alterado.**
3. **Saldo:** o último valor conhecido é **US$ 1,96, lido em 13/09/2026** e não reconsultado desde
   então (sem requisição à conta nesta revisão). É a mesma conta que atende o app publicado: o
   benchmark compete com o tráfego real, e esgotar o saldo derruba a IA remota em produção.
4. O cache de contexto é automático e "best-effort", sem acerto garantido.

## 2. Achados antes de gastar

- **O planejador remoto de consulta nunca funcionou.** Corrigido no commit `7080edb`. O retry de
  `callDeepSeekChat` exigia `reply`; um plano nunca tem `reply`. Invariante 107.
- **O histórico mandado ao chat remoto continha respostas LOCAIS — corrigido em 15/09/2026
  (`bfd8f83`).** Reproduzido antes da correção com estado-canário: o corpo levava o nome do
  usuário, a descrição e o valor de um lançamento e o saldo em conta, e o servidor repassava tudo à
  DeepSeek. Agora a conversa vai como estrutura, o contexto é o mínimo, o servidor ignora `history` e
  aplica lista de campos permitidos. Regra 61, invariantes 114–119.
- **O contexto do chat repetia a lista de categorias — corrigido** junto: a lista continua indo para
  o servidor montar o prompt, mas não é repetida na mensagem de contexto. O chat caiu de 11.446 para
  cerca de 9.800 caracteres de entrada em média.
- **Frases que o motor local respondia errado e nunca chegavam ao modelo — três classes corrigidas**
  (`713970d`, `d7b846c`, `98d23f3`): número de período lido como valor, "N mil" lido como N e
  depósito em meta lido como despesa, mais a regra geral de que leitura local de baixa confiança não
  fecha a frase (regra 62). O que continua errado está na seção 10.

## 3. Configurações comparadas

| Id | Modelo | Pensamento | Por quê |
|---|---|---|---|
| **A** | `deepseek-flash` | desligado | candidato de custo e latência |
| **B** | `deepseek-v4-pro` | desligado | o modelo maior, sem raciocínio |
| **C** | `deepseek-v4-flash` | padrão da API (ligado) | a produção de hoje: mesmo nome e mesmos parâmetros de chamada |
| D | `deepseek-v4-pro` | ligado, esforço low | opcional: só cabe com mais saldo |

Todas usam o prompt, a sanitização, o retry, o `temperature` e o `max_tokens` DESTA branch. A
avaliação chama o mesmo `handleAssistantRequest` da Vercel e troca **apenas** o modelo e o modo de
pensamento, dentro do `fetch` que sai para a DeepSeek.

> **Atenção:** "produção de hoje" em C quer dizer o modelo e os parâmetros da chamada. O prompt e o
> contexto medidos são os da branch (contexto mínimo, sem transcrição, regras 16 e 17 do prompt). O
> app publicado ainda roda o código de 13/08/2026 até um redeploy — que não foi feito.

## 4. Corpus

**120 casos.** Em 15/09/2026, **66 frases chegam ao modelo remoto** (eram 64 em 13/09), medido sem
rede no orquestrador real: **19 do planejador** (eram 17), **44 do chat** e **3 de cenário**. Nas 6
conversas, **9 turnos chamam o chat e 9 chamam o planejador** (eram 10 e 10).

| Suíte | Casos | Contrato | Chegam ao remoto | Corpus pago |
|---|---|---|---|---|
| Planejador de consulta | 44 | produção | 19 | 19 |
| Chat remoto | 55 | produção | 44 | 44 |
| Cenário | 15 | **candidato** | 3 | 3 |
| Continuidade | 6 conversas, 38 turnos | produção, pelo orquestrador | 9 chat + 9 planejador | 6 |

**A elegibilidade é MEDIDA, não declarada** (15/09/2026). Antes de qualquer gasto, o orquestrador de
produção roda com os dois caminhos remotos substituídos por gravadores, e um caso só entra na bateria
paga — e na NOTA de um modelo — se ali saiu requisição. Cada caso continua declarando a **rota de
produção** (`remota`, `local`, `local-errada`), mas agora como DIAGNÓSTICO: o autoteste confere que o
rótulo não divergiu da medição e, se divergir, quem manda é a medição. A distinção entre `local`
(certa) e `local-errada` é leitura humana das respostas, registrada no motivo de cada caso com a data,
e serve para o relatório do app — nunca para decidir quem paga a conta do modelo.

**O que mudou em 15/09/2026, e por quê:**

| Caso | Antes | Agora | Causa |
|---|---|---|---|
| p-14 "quanto do que entrou esse mês veio de freelance" | local-errada | **remota** | o "que" solto era lido como comparação e o local respondia gastos |
| p-19 "qual foi o dia que eu mais gastei no mês passado" | local-errada | **remota** | mesma causa |
| p-20 "obra de agosto … maior que o de julho" | local-errada | **local** | compara obra com obra |
| p-29 "qnto q foi d obra msm nos ultimo 3 mes" | local-errada | **local** | responde obra nos últimos 3 meses, sem despesa de R$ 3,00 |
| c-16 "coloquei 200 na meta" (duas metas) | local-errada | **local** | pergunta a meta, com as metas e a reserva como opção |
| s-03 "moto de 12 mil em 24 vezes sem entrada no nubank…" | local-errada | **local** | simula 12 mil em 24x ("cancelar a internet" continua sem representação) |
| s-05 "celular de 2 mil em 10x dando 500 de entrada no inter" | local-errada | **local** | simula 2 mil com 500 de entrada |
| s-11 "quanto sobra se eu comprar uma tv de 3 mil" | local-errada | **local** | simula R$ 3.000,00 |
| k-06 turno 4 "e coloquei 200 na meta" | despesa local, e o turno 5 ia ao remoto | pergunta a meta; o turno 5 resolve no aparelho | depósito em meta |

Nenhuma frase que chegava ao remoto deixou de chegar por leitura local ERRADA. Durante a correção,
a hipótese sem base "e se em vez de 10x eu fizer 12 dando mil de entrada?" (p-36, c-23, s-12)
chegou a ser simulada localmente como uma compra de R$ 12,00; a regressão foi lida na resposta e
fechada com a trava de preço antes do commit.

**Corpus PAGO** (`--corpus=pago`, padrão de `--executar`): **só as 66 frases em que a medição viu
requisição sair**, mais as 6 conversas. Nada mais. Frase que o aparelho fecha sozinho — acertando ou
errando — não é paga e não pontua modelo nenhum, porque em produção o modelo não é consultado ali.

**Corpus FRONTEIRA** (`--corpus=fronteira`): acrescenta as 27 frases que o aparelho resolve ERRADO.
Isso é pago e responde outra pergunta — *valeria mandar isto ao modelo?* —, que é decisão de
ROTEAMENTO. O relatório mostra essas execuções em bloco separado e elas **nunca** entram na nota de
configuração nenhuma.

**Corpus COMPLETO** (`--corpus=completo`): os 120, sem gasto, para o autoteste.

Até 15/09/2026 o filtro era `rota !== 'local'`, por rótulo. Como `local-errada` não é `local`, as 27
frases que o aparelho erra entravam na bateria paga e na nota dos modelos — 28 casos com c-36, quase
um terço do que seria pago —, e o `PROGRESS.md` descrevia o contrário do que o código fazia. Corrigido
com teste RED: com a regra antiga o autoteste lista os 28 nominalmente e falha.

A suíte de cenário mede um contrato que **não existe**: não há tarefa de cenário no servidor, e a
DSL é de passo único. Ela responde se vale construir o planejador de cenário.

## 5. Gabarito e comparação

O gabarito é estruturado e executável: toda leitura aceita passa no `validateQueryPlan` real,
toda ação no `validateAction` real, e todo passo de cenário simula no motor real.

**Comparação semântica de plano.** Filtro em outra ordem, `order` omitido quando o executor
ordenaria igual e `limit` num plano sem agrupamento continuam sendo a mesma consulta. **Não se
flexibiliza**: valor, data, exclusão, tipo, origem, cartão, categoria nem modalidade. Um filtro que
o gabarito não lista tem que vir **ausente**. Período só casa com um intervalo declarado, ao dia; a
frase genuinamente ambígua ("últimos 3 meses") lista as leituras exatas aceitas. O acerto
**exato** exige o plano idêntico à leitura primária.

**Ações.** Valor, total, parcelas, data, origem e cartão são estritos, e errar qualquer um numa
ação aceita é perigo. Categoria e descrição contam para a acurácia de campo. Ambiguidade honesta
admite `alternativas` ("acho que gastei uns 190": perguntar OU propor os 190, nunca outro valor).

**Ajustados ao contexto novo (15/09/2026), não ao comportamento de modelo nenhum:** c-46 deixou de
contar "computador" e "geladeira" como resposta útil (a lista de compras não vai mais ao modelo), e
c-50 deixou de esperar "sim, sobram R$ X" (o saldo não vai mais). Em conversa, número permitido é o
do contexto enviado e o da frase do turno — as mensagens anteriores não vão mais ao modelo.

## 6. Métricas e pontuação

Por configuração: intent accuracy, action precision e recall, field accuracy, query-plan exact e
semantic match, scenario-plan accuracy, clarification precision e recall, hallucination rate,
numeric hallucination rate, profile contamination, invalid-contract rate, generic response rate,
privacy violation rate, falha de transporte, latência p50 e p95, tokens médios (entrada, saída,
raciocínio), custo total e **custo por 1.000 mensagens reais**. O tráfego vem das 90 mensagens do
corpus adversarial: planejador em 24,4% das mensagens, chat em 26,7%. É um teto, porque quando o
planejador falha a frase segue para o chat.

**A ordem é lexicográfica.** Primeiro vêm os eventos perigosos por 100 execuções, com intervalo de
95%; a qualidade só desempata. Os perigos são: ação que não devia existir, campo financeiro
errado, valor em R$ sem lastro, alegação de ter registrado ou transferido, vazamento de prompt ou
contexto, contaminação de perfil, e modalidade (hipótese ou registro virando consulta factual).
Nenhum peso compensa um perigo, porque perigo e qualidade nunca são somados. O autoteste prova
isso: um "modelo" melhor em qualidade, custo e latência, com UM perigo, perde para um pior sem
perigo nenhum.

Pesos da qualidade (somam 100): plano 20 · cenário 10 · ações 15 · esclarecimento 15 · intenção 10
· utilidade 10 · contrato 5 · latência 7,5 · custo 7,5.

**Alucinação numérica é estrita de propósito.** Permitidos: os números do contexto enviado, os da
frase e os derivados declarados caso a caso. Soma e diferença de todos os pares não são liberadas,
porque com o contexto inteiro isso aceitaria 89% dos valores inventados (regra 53).

**Como ler o relatório para decidir produção:** ele tem três blocos que não se misturam.

1. **App / roteamento** — quantas frases o aparelho resolve certo, quantas ele resolve errado antes de
   o modelo existir, e quantas sobram para o remoto. É diagnóstico do APARELHO. Nada daqui vira nota
   de modelo, e nada daqui some do relatório.
2. **Qualidade do modelo** — só os casos elegíveis. É esta a ordem que decide produção.
3. **Transporte** — casos lógicos, chamadas lógicas, tentativas HTTP, retries, falhas, latência,
   tokens e dólares. Uma mensagem para um caminho remoto é **uma** chamada lógica por mais que o
   cliente tenha repetido a requisição: retry infla a conta e a latência, nunca o denominador da
   qualidade. Se um bloco de fronteira aparecer, ele é opt-in e fica claramente fora da nota.

**Falha remota que o fallback local salvou conta contra o modelo.** O app pode ter sobrevivido — a
resposta que o usuário vê talvez esteja certa —, mas a saída do modelo não pôde ser usada. A métrica
`remote failure rate` registra isso, separada de `transport failure rate`, e é ela que entra na nota.

**A regra permanente:** *um modelo só é avaliado por um caso se o caminho remoto foi realmente
alcançado e a saída dele teve oportunidade de influenciar o resultado.* E o contrapeso, que vale
igual: *falhas locais continuam aparecendo, em bloco próprio, e nunca são escondidas.*

## 7. Privacidade — como dado real é impedido de sair

1. **Estado só sintético.** Todo estado vem de `tests/assistant/eval/states.ts` e carrega um
   nome-canário. O caso só é marcado `origemVerificada` depois de o estado passar pelo canário e pelo
   vocabulário sintético, e o transporte recusa qualquer requisição sem essa marca.
2. **Canário no corpo BLOQUEIA.** Até 13/09 o canário era exigido no corpo do chat, porque o nome do
   usuário ia no contexto. Desde 15/09 o nome não vai mais (regra 61): se o canário aparecer no
   corpo, é o nome que voltou a vazar, e a chamada é barrada.
3. **Vocabulário fechado.** Todo nome de categoria, cartão e meta enviado precisa existir nos estados
   sintéticos.
4. **Varredura de dado pessoal no corpo serializado:** CPF, CNPJ, e-mail, telefone, número de
   cartão (Luhn), CEP, token JWT e a própria chave da API. Qualquer ocorrência bloqueia a chamada.
5. **Host fechado.** Só `api.deepseek.com`; requisição fora de um caso de avaliação é recusada.
6. **Nada lê dado do usuário.** O app guarda tudo no `localStorage` do navegador; a avaliação não
   tem acesso a ele, nem a backup, nem a arquivo nenhum além do código.
7. **A chave nunca é impressa.** Os resultados vão para `eval-results/` (fora do git) e são
   varridos atrás de segredo antes de o script terminar.

E o que é medido é o corpo NOVO de produção: contexto mínimo, conversa como estrutura, sem `history`.

## 8. Custo e duração estimados

Prompts medidos **exatamente**, pelo pipeline real com rede falsa, em 15/09/2026, sem nenhuma
requisição à conta (`--sem-saldo`): chat **9.827** caracteres em média, planejador 2.786, cenário
1.784. No corpus PAGO, cada repetição tem **112 chamadas lógicas por configuração**: 46 de chat, 49 de
planejador (40 da suíte e 9 dos turnos de conversa), 8 de cenário e 9 turnos de chat da conversa.

**Corpus pago, 3 repetições:**

| Config | Central | Pessimista | Pior caso |
|---|---|---|---|
| A | US$ 0,09 | US$ 0,23 | US$ 1,29 |
| B | US$ 0,33 | US$ 0,90 | US$ 4,86 |
| C | US$ 0,21 | US$ 0,37 | US$ 1,29 |
| D | US$ 0,75 | US$ 1,35 | US$ 4,86 |
| **A+B+C** | **US$ 0,63** | **US$ 1,50** | **US$ 7,44** |
| A+B+C+D | US$ 1,38 | US$ 2,85 | US$ 12,29 |

Para comparar: em 13/09 (corpus completo, contexto antigo) A+B+C custava US$ 0,79 / 1,91 / 9,37. Com
o contexto novo e o corpus completo, US$ 0,74 / 1,74 / 8,67. **Uma repetição** custa um terço: A+B+C
cerca de US$ 0,21 central, US$ 0,50 pessimista e US$ 2,48 no pior caso.

- **Central:** 0,30 token por caractere, 60% de cache, fora do pico, 5% de reenvio.
- **Pessimista:** 0,40 token por caractere, 20% de cache, 30% de reenvio.
- **Pior caso:** 0,45 token por caractere, sem cache, horário de pico, toda chamada repetida e toda
  saída no teto de 900 tokens.

As configurações com pensamento (C, D) assumem que `max_tokens` corta o raciocínio; se não cortar,
o custo delas pode passar do pessimista, e é por isso que existe a calibração.

**Duração (concorrência 3), corpus pago:** cerca de 7 min cada para A e B e 22 min cada para C e D
no cenário central, perto de 36 min para A+B+C (353 chamadas HTTP por configuração). No pessimista,
cerca do dobro.

## 9. Como executar

```bash
npx tsx scripts/eval-assistant-models.mts --sem-saldo      # orçamento — sem rede nenhuma
npx tsx scripts/eval-assistant-models.mts --modelos        # /models e saldo — grátis, faz requisição à conta
npx tsx scripts/eval-assistant-models.mts --autoteste      # autoteste — grátis
npx tsx scripts/eval-assistant-models.mts --executar --teto-usd=<valor> --configs=A,B,C [--repeticoes=N] [--corpus=pago|completo]
```

A execução paga:

1. recusa sem `--teto-usd`;
2. recusa se o autoteste falhar;
3. recusa se o teto deixar menos de `--reserva-usd` (padrão US$ 0,50) de saldo para o app publicado —
   o saldo é lido UMA vez, no início;
4. **calibra**: roda as 3 primeiras tarefas de chat de cada configuração, projeta o total com o custo
   MEDIDO e para ali se a projeção passar do teto;
5. reserva o pior caso de cada chamada contra o teto ANTES de enviar;
6. intercala as configurações caso a caso e termina uma repetição antes da próxima, de modo que parar
   no teto deixa uma comparação equilibrada;
7. para em HTTP 401/402 e suspende a configuração que acumular 6 falhas de transporte seguidas;
8. grava cada chamada e cada resultado em JSONL, e `--retomar=<pasta>` continua de onde parou sem
   pagar de novo — inclusive para acrescentar repetições a uma rodada já feita.

O teto protege só o gasto do PRÓPRIO avaliador: o app publicado continua consumindo o mesmo saldo
enquanto a bateria roda. Ver a seção 12.

## 10. Achados colaterais: o motor local erra antes de o modelo ser chamado

A pré-checagem de rotas passou por mais de 150 frases difíceis. Em 15/09/2026 as respostas foram
relidas; nenhuma escolha de modelo corrige as que continuam erradas, porque o modelo não é consultado.

**Rota `local-errada` no corpus (checkpoint de 15/09/2026):** eram 35 na linha de base de 13/09.
Oito saíram — p-14 e p-19 passaram a chegar ao remoto; p-20, p-29, c-16, s-03, s-05 e s-11 passaram a
ser respondidas certo no aparelho. **Continuam 27:** planejador p-01, 03, 06, 09, 11, 12, 13, 16, 17,
18, 21, 22, 23, 24, 25, 26, 27, 30, 32, 33, 34; chat c-20; cenário s-01, 02, 04, 07, 13. (Uma contagem
anterior desta rodada falou em "34" e "cinco corrigidas"; os números certos são estes.)

**Corrigidas em 15/09/2026:**

| Frase | Antes | Agora |
|---|---|---|
| `qnto q foi d obra msm nos ultimo 3 mes` | despesa de R$ 3,00 | consulta de obra nos últimos 3 meses |
| `coloquei 200 na meta` (duas metas) | despesa de R$ 200 | pergunta em qual meta, com as opções prontas |
| `tv de 3 mil` (hipótese) | simulação de R$ 3,00 | simulação de R$ 3.000,00 |
| `celular de 2 mil com 500 de entrada` (hipótese) | gasto de R$ 2,00 | 2 mil com 500 de entrada |
| `moto de 12 mil em 24 vezes` | R$ 4,00 em 2x | 12 mil em 24x |
| `obra de agosto contra julho` | outra categoria (+674%) | obra contra obra |
| `qual foi meu maior gasto em 90 dias` | respondia os últimos 7 dias | responde os 90 dias |
| `mandei 200 pra meta do carro` (motorista) | 200 km rodados | depósito na meta |

**Registro perigoso que CONTINUA (relido em 15/09/2026):**

| Frase | O que o app propõe hoje | Esperado |
|---|---|---|
| `salario caiu 3200 e ja paguei o aluguel de 1100` (CLT) | receita 3.200 + **receita** 1.100 + despesa 1.100 | receita 3.200 + despesa 1.100 |
| `o 150 que eu te falei era de farmácia não de mercado` | nova despesa de R$ 150 (duplicata) | corrigir o lançamento existente ou perguntar qual |
| `aquele gasto de ontem foi 90 e não 80` | nova despesa de R$ 90, descrição "Não 80" | corrigir o lançamento de 80 ou perguntar qual |
| `aquele do mercado foi 230 na verdade` | nova despesa de R$ 230 | corrigir o lançamento ou perguntar qual |
| `hoje uber deu 210 e a 99 uns 130 abasteci 80` (motorista) | só o abastecimento de 80; as duas receitas somem | receitas 210 e 130 + abastecimento 80 |
| `recebi 1800 da casa 1 e 1200 da casa 2 mas a 2 ainda vai cair na conta amanhã` | as duas como realizadas, ao lado do aviso de que nada foi agendado | só 1.800 realizado; 1.200 explicado como futuro |
| `caiu o vale alimentação 800` (CLT) | a entrada some; responde uma consulta de gastos com alimentação | receita de 800 ou pergunta |
| `paguei 320 de luz 180 de agua e a internet eu nao lembro` | uma despesa de 320, descrição "Luz 180 de agua"; os R$ 180 somem | despesas 320 e 180 + pergunta sobre a internet |
| `guardei 300 na meta da viagem e 200 na outra` (c-20) | depósito de 300 na Viagem; os 200 somem em silêncio | 300 na Viagem + 200 na outra meta, ou pergunta |
| `gastei sessenta vírgula cinquenta de farmácia ponto` | R$ 60,00 | R$ 60,50 |

**Número real para a pergunta errada, que CONTINUA:** "obra e lazer" soma só obra; "gasosa por km"
responde R$ 0,00 como dado real; "onde vazou" devolve o total; "maior mudança" devolve o maior valor;
"acima de 200/500 reais" vira texto de busca; "tirando a casa 1" responde que não há lançamento;
"desde março/junho" olha um mês só; "fins de semana" procura o texto "fins de"; "qual cliente me pagou
mais" soma gastos por origem; "líquido por corrida esse mês" devolve a receita bruta de 7 dias.

**Simulação errada que CONTINUA:** "trocar de carro dando 20 mil de entrada e financiando 40 mil em
48x" simula 40 mil em 48x sem a entrada; "parar de guardar por 3 meses" vira "guardar R$ 3,00 por
mês"; "2 horas por dia a semana toda" é estimado em 30 dias; hipóteses compostas simulam só a primeira
metade; e "e se eu parar a obra agora" responde a projeção factual.

Todas estão no corpus desta avaliação com a rota `local-errada` ou fora dele, e corrigi-las é outra
rodada. Desde 15/09/2026 elas **não entram mais na bateria paga padrão** nem na nota de modelo algum:
o modelo não é consultado nessas frases, então cobrar dele o desfecho seria medir o parser local com
o nome do modelo na tabela. Quem quiser a pergunta de roteamento pede `--corpus=fronteira`, paga por
ela de propósito, e lê o resultado no bloco separado.

## 11. O que esta avaliação NÃO mede

- Texto de conselho financeiro além dos detectores: julgamento e utilidade são medidos por
  predicado. Uma auditoria manual continua necessária, e o relatório lista cada perigo com trecho
  da resposta para isso.
- O compositor remoto (`task: 'compose'`), que não está ligado em produção.
- Tráfego real de usuários: o proxy é o corpus adversarial, que exagera frases hostis.
- Estabilidade além das repetições pedidas.
- **Continuidade de verdade no planejador:** ele não recebe o plano anterior (nem recebia), então um
  follow-up que chega a ele não tem como ser resolvido por modelo nenhum. Só 9 turnos chegam ao chat e
  9 ao planejador, em 6 conversas.
- **A semântica exata de `max_tokens` com pensamento e o lugar de `reasoning_effort`** (dentro de
  `thinking` ou no topo do corpo) não estão documentados; o transporte manda dentro de `thinking`.
  O relatório de C e D precisa ser lido com isso em mente.
- **O comportamento do app publicado:** a produção roda o código de 13/08/2026 até um redeploy.

## 12. Saldo e estratégia para a primeira bateria

Nada disto foi executado: não houve requisição à conta, criação de chave nem mudança de crédito.

| Opção | O que resolve | O que não resolve |
|---|---|---|
| **A.** Adicionar saldo antes | tira o risco de a bateria esgotar o saldo do app publicado | continua a mesma conta: o gasto do app e o da avaliação se misturam na fatura |
| **B.** Chave ou conta dedicada ao avaliador | separa gasto e risco por completo | exige o dono criar a conta ou chave (não pode ser feito daqui); se for chave da MESMA conta, o saldo continua compartilhado |
| **C.** Teto conservador | limita o pior caso do avaliador | não protege do consumo concorrente do app; teto baixo demais corta a comparação no meio |
| **D.** Rodar só A contra B, sem C | economiza cerca de um terço | perde exatamente a linha de base da produção, que é o que decide trocar ou não |
| **E.** Menos repetições na primeira rodada | mede o custo e o comportamento real por um terço do preço | uma repetição não mostra estabilidade; empate dentro do ruído precisa de mais |
| **F.** Calibrar 5–10 casos antes | já existe: as primeiras 3 tarefas por configuração projetam o total e param no teto | calibra com casos de chat; o custo do pensamento em C pode variar entre suítes |

**Recomendação:** **A + E + F**, com **B** se o dono preferir separar a fatura.

1. Colocar cerca de **US$ 5** de saldo antes (o último saldo conhecido, US$ 1,96 em 13/09/2026, fica
   abaixo do pessimista de A+B+C em 3 repetições somado à reserva do app).
2. **Primeira rodada: A+B+C, 1 repetição, corpus pago, teto de US$ 1,00.** Custo esperado de US$ 0,17
   (central) a US$ 0,41 (pessimista), pior caso US$ 2,01 — 84 chamadas lógicas por configuração, contra
   112 antes de a elegibilidade ser medida. Mede de verdade o que hoje é suposição: tokens de raciocínio
   de C, se `max_tokens` corta resposta, latência real e a taxa de perigo por configuração.
3. Se duas configurações empatarem em segurança dentro do ruído, **retomar a mesma pasta** com
   `--repeticoes=3` (paga só as repetições que faltam). Só então decidir D.

Comando sugerido para a primeira rodada — **NÃO autorizado**:

```bash
npx tsx scripts/eval-assistant-models.mts --executar --teto-usd=1.00 --configs=A,B,C --repeticoes=1
```

Com o saldo de hoje (sem o crédito extra), o mesmo comando só passa na trava se o saldo ainda for de
pelo menos US$ 1,50 (teto + reserva de US$ 0,50) — e o app publicado continuaria consumindo do mesmo
saldo durante a bateria.
