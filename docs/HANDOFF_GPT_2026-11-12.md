# AssistFin — Passagem de contexto (sessão de 12/11/2026)

Documento para outro assistente continuar o trabalho sem depender do histórico da conversa.
Tudo abaixo foi verificado no repositório; nada aqui é só intenção.

---

## 1. Onde está o código

- **Repositório GitHub:** `pedrohlsa/assistente_financeiro` (privado).
- **Branch de trabalho:** `feat/assistant-intelligence-v2`.
- **HEAD atual:** `d9860dd`, árvore limpa, 174 commits à frente da `main`.
- **A branch NUNCA foi enviada ao GitHub.** No remoto existem só `main` (`e6f6229`, que é a produção com DeepSeek v4 pro) e `feat/assistant-orchestrator` (já mesclada).
- **Cópias locais:**
  - Linux (onde o trabalho acontece agora): `~/work/assistfin`.
  - Windows, mesmo computador em dual-boot: `D:\Claude\AssistFin`, parado no HEAD `9bc0457` de 28/10/2026. Só tem `.claude/launch.json` modificado, que é configuração local e não deve ser commitado.
- **Ferramentas no Linux:** Node 22 via nvm. Em cada shell novo: `source ~/.nvm/nvm.sh`.

### Divergência com o histórico que o usuário lembrava

O usuário lembrava "HEAD `36d0135`, 12 commits à frente da main". O real era bem diferente: `36d0135` existe, mas ficou 155 commits para trás. Depois dele houve quatro rodadas de auditoria adversarial respondidas (C1–C3 e H1–H9, depois A1–A5/B1/C1–C2, depois mais oito achados) e dezenas de correções lidas como usuário em 27–28/10. **Confie no repositório, não no resumo.**

---

## 2. Regras que não podem ser violadas

- Sem push, merge, force push, reset ou deploy sem autorização explícita do usuário.
- Sem chamada paga à DeepSeek, sem APK.
- O projeto se declara **NOT READY para merge/deploy** até uma auditoria independente do diff novo.
- `CLAUDE.md` na raiz tem 66 regras permanentes de implementação (as 4 últimas foram criadas nesta sessão). Leia antes de mexer em qualquer coisa.
- Documentos de estado: topo de `CONTEXTO.md` (checkpoint de 12/11), duas últimas seções de `PROGRESS.md`, e `docs/CODEX_RESUME.md`.
- Relatórios de auditoria anteriores: `docs/AI_INTELLIGENCE_V2_*.md`.

---

## 3. Como rodar

```bash
cd ~/work/assistfin
source ~/.nvm/nvm.sh
npm ci                        # se faltar node_modules
npm test                      # suíte completa, offline, relógio congelado em 2026-09-15
npm run test:calendario       # mesma suíte em seis datas diferentes
ASSISTFIN_TODAY=2026-11-30 npm test   # uma data específica; "real" usa o relógio da máquina
npm run typecheck             # tsc estrito do src
npm run typecheck:api         # inclui api/, tests/ e scripts/
npm run build
npm run rubric                # classifica 90 respostas; PERIGOSA tem meta absoluta de zero
```

---

## 4. O que foi encontrado ao retomar

A baseline documentada em 28/10 era "tudo verde". Em 12/11 ela **não se reproduzia**:

- 18 regressões adversariais vermelhas (623/641) e 1 resposta RUIM na rubrica.
- Causa principal: o roteador antigo (`resolveLocal` em `src/services/ai.ts`) lê o relógio real da máquina, enquanto o orquestrador recebe `today` injetado. Os dois discordavam no mesmo turno, e muitos oráculos dos testes só valiam no dia 28 do mês.
- Rodando a suíte em sete datas, separei **defeitos reais do app** de **oráculos presos ao calendário**.

---

## 5. O que foi feito (7 commits locais)

| Commit | Conteúdo |
|---|---|
| `62e7f76` | Defeitos de calendário no app |
| `bbd2e3d` | Relógio congelado dos testes e oráculos robustos ao calendário |
| `2ff9dfa` | Documentação da retomada |
| `3f0d536` | Nova ação `recurring-confirm`: conta fixa confirmada pelo chat |
| `c7a8aab` | Correções da auditoria com as frases do prompt da missão |
| `f98b86a` | Últimos itens da auditoria |
| `d9860dd` | Documentação: regras 63–66 no CLAUDE.md, checkpoint em CONTEXTO.md e PROGRESS.md |

Diff total da sessão: 36 arquivos, +1.107 / −130 linhas.

### 5.1 Infraestrutura de teste

- **`tests/clock.ts` (novo):** congela `Date` antes de qualquer import nos runners. Variável `ASSISTFIN_TODAY` (padrão `2026-09-15`; `real` usa a máquina). O tempo continua andando a partir do instante congelado, para carimbos de ordem seguirem monotônicos.
- **`npm run test:calendario`:** roda a bateria em 2026-11-12, 2026-10-28, 2026-11-21, 2026-11-30, 2026-12-31 e 2027-02-28.
- **Oráculos reescritos** para calcular o esperado a partir do fixture e da data, em vez de números que só eram verdade em 28/10: contas do mês, faturas abertas versus fechadas, domingo sem registro, dia 1º sem gasto, ano anterior com dado, custo por km no último dia do mês, registros com "dia N" ainda não chegado, ranking de meses, e o autoteste `c-47` do avaliador remoto.

### 5.2 Defeitos reais do app corrigidos (cada um com teste vermelho antes da correção)

**Calendário**
1. "Quanto preciso deixar parado até dia 22" no dia 12 respondia "o dia 22 deste mês ainda não chegou, qual data?". Só funcionava quando o dia já tinha passado. Agora "até/pro/para o/antes do dia N" é prazo e resolve para o próximo dia N (`src/assistant/dates.ts`).
2. "Meu salário cai dia 5" nos dias 1 a 4 fazia a mesma pergunta. Frase de recorrência não tem data a esclarecer (`src/assistant/clauses.ts`).
3. Média mensal no último dia do mês contava o mês corrente como completo. `runQuery` agora recebe `today` (`src/assistant/query/engine.ts`).
4. `savedThisMonth` contava depósito com data futura como "guardado de verdade" (`src/services/calc.ts`).
5. "Vale a pena rodar domingo?" contava um domingo só com troca de óleo como dia trabalhado com lucro negativo. Agora dia trabalhado exige entrada ou registro de trabalho (`src/services/ai.ts`).
6. Consulta por nome sem período ("quanto gastei com troca de óleo") dizia só "nada este mês", que soa como "nunca". Agora também cita o último lançamento fora do período, sem mudar o número (`period.implicit` + `lastOutside` na DSL).

**Conta fixa pelo chat (`recurring-confirm`, regra 65)**
7. "Paguei 120 de luz" com a conta em aberto era recusado e mandava para a Home; a rubrica marcava como RUIM ("o lançamento sumiu"). Agora o chat propõe confirmar aquela ocorrência: mesma operação do card da Home, chave `recurringId` + data, com o valor dito e o cadastrado citado quando diferem. "Paguei a luz" sem valor usa o cadastrado. Ação local-only, segunda confirmação recusada com `occurrence-resolved`, desfazer reabre a ocorrência, despesa avulsa antiga continua recusada pelo executor. Arquivos: `contracts.ts`, `execute.ts`, `orchestrator.ts`, `models/types.ts`, `nlp.ts`, `proposalEdit.ts`.

**Auditoria com as frases do prompt da missão** (sonda pelo orquestrador real, offline, lida resposta por resposta; cada achado virou caso `MI-` em `tests/assistant/adversarial-real.ts`)
8. "Na verdade a feira foi 150, não 180" **editava um Cimento de R$ 180 de três meses antes**, casado só pelo valor. Agora o sujeito da frase nomeia o lançamento; sem lançamento com esse nome, nada é corrigido (`editSaved.ts`).
9. "Se a gasolina aumentar 12% e eu rodar 20% mais km, qual meu lucro?" virava "Resultado este mês (dado real)": hipótese apresentada como fato. Hipótese sobre algo que não é "eu" agora é hipótese (`scenario/parse.ts`).
10. "Se eu rodar mais 100 km, quanto devo gastar de combustível?" respondia receita por km. Agora calcula o custo com consumo e preço registrados, e diz o que fica de fora (`scenario/*`).
11. "Já tenho 4.800 na viagem. Se eu guardar 350 por mês, quando termino?" lia 4.800 como depósito. O valor é o que acompanha o verbo.
12. "Tenho R$ 1.800 hoje, preciso pagar 950 de aluguel, 320 de energia e quero guardar 400. Quanto ainda preciso ganhar?" respondia "isso ainda não aconteceu". Agora faz a conta só com os números da frase e diz que não olhou os lançamentos (`contaDeclarada` em `cashQuestions.ts`).
13. "Quanto preciso separar por semana" respondia por mês.
14. "Cara, tô ferrado esse mês?" caía no menu de ajuda. Agora usa a rota de "tô no vermelho" e acrescenta os compromissos próximos.
15. "Quanto ganho por hora de verdade" transformava "verdade" em filtro de texto.
16. Conversa "gasolina esta semana → e na passada? → sem contar terça → agora compara com alimentação" perdia o assunto a partir do segundo turno. Agora há elipse de período, exclusão de dia da semana e comparação de duas categorias lado a lado (`conversation/focus.ts`).
17. "Quanto gastei de combustível…, e quanto isso representa do meu faturamento na Uber?" respondia "não tenho lançamento". Agora responde a primeira pergunta e diz que a segunda, que depende da primeira, não foi respondida.
18. Preferências de análise ("considera sempre uma reserva de 300", "prefiro analisar ganhos líquidos", "não usa projeções otimistas") eram respondidas como pergunta ou com o menu. Agora o app diz que ainda não guarda esse tipo de preferência e o que consegue aprender.
19. "Quero diminuir meus gastos com gasolina" respondia "entendi que isso não aconteceu". Agora reconhece a intenção e mostra o gasto dos últimos 30 dias.
20. "Fiz 350 de uber" perdia a plataforma.
21. "Gastei 120 no mercado, não, pera, foram 102" propunha 102 e ainda perguntava pelos 120.

---

## 6. Resultado dos testes (HEAD `d9860dd`)

| Gate | Antes (12/11, sem mudanças) | Agora |
|---|---|---|
| Corpus | 666/666 | 666/666 |
| Consulta / cenário / continuidade | 99/99 | 99/99 |
| Semânticos | 50/50 | 50/50 |
| Adversariais pelo orquestrador real | 623/641 | **679/679** |
| Metamórficos | 4.088 + 3.800 | 4.088 + 3.800 |
| Fuzz | 1.416 | 1.416 |
| Invariantes | 151/151 | 151/151 |
| Avaliador remoto offline | 468/468 | 468/468 |
| Rubrica | 0 perigosa, **1 ruim** | 0 perigosa, **0 ruim** |
| typecheck, typecheck:api, test:money, build | verdes | verdes |
| `test:calendario` (seis datas) | não existia | verde |

O build mantém o aviso antigo de chunk acima de 500 kB.

---

## 7. O que NÃO foi validado

- Nada foi testado contra a DeepSeek real; todo o caminho remoto foi exercitado só offline.
- Não houve teste no navegador nem no APK nesta sessão.
- Persistência real em `localStorage` e dados legados reais não foram revalidados.

---

## 8. Limitações conhecidas que continuam abertas

- **Dia 1º do mês fica fora da matriz de datas:** os fixtures ricos não têm gasto no mês, e cerca de 35 oráculos ficam degenerados nesse dia.
- **Cenários com porcentagem** ("gasolina +12%") e **"mais N dias por semana"** são reconhecidos como hipótese, mas só declarados como não simuláveis. Não há número.
- **"Se eu adiar a compra em dois meses"** também é declarado não simulável.
- **Preferências de análise** (reserva mínima, líquido, sem projeção otimista) não são guardadas.
- **"Quanto isso representa"** não encadeia com a pergunta anterior.
- **"Já tenho X na meta"** dentro de um cenário não sobrescreve o acumulado cadastrado; o cálculo usa o acumulado da meta.
- **"Quanto meu carro custa por km"** responde gasto registrado ÷ km do mês, não o `kmCost` completo com manutenção e fixos.
- **"Fiz 250 na 99"** infere 1 viagem. É uma decisão de produto pendente desde 28/10: o corpus se contradiz sobre inferir viagem.
- **"Recebi 500, mas 100 eram reembolso"** propõe 500 e pergunta pelos 100, sem separar a natureza do valor.
- Fatura com vencimento no mês seguinte não aparece em "gastei no cartão esse mês".
- Pendências herdadas de 28/10 (pagamentos legados sem proveniência, reconciliação de fatura sem fluxo na interface, ordem de eventos no mesmo minuto em backups antigos) estão em `PROGRESS.md`.

---

## 9. Próximas prioridades sugeridas

1. **Auditoria independente** do diff `9bc0457..d9860dd` antes de qualquer merge.
2. Simulação real de **variação percentual de custo e de km** e de **dias extras por semana**, sobre o motor de cenários existente (`src/assistant/scenario/`), sem criar arquitetura paralela.
3. Fixture que tenha movimento no dia 1º, para colocar essa data na matriz.
4. Verificação ponta a ponta no navegador (`npm run dev`, porta 5199) e, com autorização, no caminho remoto.
5. Decidir com o usuário se a branch deve ir ao GitHub como backup. Hoje ela só existe em duas máquinas locais.

---

## 10. Mapa rápido dos arquivos tocados

- `src/assistant/dates.ts` — prazo "até dia N".
- `src/assistant/clauses.ts` — recorrência sem ambiguidade de data, duas perguntas na mesma frase, resíduo após correção.
- `src/assistant/orchestrator.ts` — `recurring-confirm`, conta fixa sem valor, conta declarada, intenção de reduzir.
- `src/assistant/contracts.ts`, `execute.ts`, `proposalEdit.ts`, `src/models/types.ts` — nova ação no catálogo.
- `src/assistant/editSaved.ts` — correção falada pelo sujeito.
- `src/assistant/preferences.ts` — preferências não suportadas ditas como tal.
- `src/assistant/cashQuestions.ts` — `contaDeclarada`.
- `src/assistant/query/{engine,answer,parse,types,validate,index}.ts` — `today` no executor, período implícito, anáfora em proporção.
- `src/assistant/scenario/{parse,engine,answer,types}.ts` — hipótese sem "eu", custo de combustível, valor junto do verbo.
- `src/assistant/conversation/{focus,index}.ts` — follow-ups novos e duas perguntas encadeadas.
- `src/assistant/semantic/normalize.ts` — intensificadores.
- `src/services/{ai,calc,nlp}.ts` — "tô ferrado", meta por semana, dia trabalhado, guardado do mês, "de uber".
- `tests/clock.ts`, `tests/assistant/adversarial-real.ts`, `tests/assistant/properties.ts`, `tests/assistant/eval/selftest.ts`, `scripts/test-assistant.mts`, `package.json`.
- Documentação: `CLAUDE.md` (regras 63–66), `CONTEXTO.md`, `PROGRESS.md`, `docs/CODEX_RESUME.md`.
