# Estado atual da IA do AssistFin

Auditoria do pipeline do assistente, **verificada linha a linha no código** em 28/07/2026
(commit `7dc1832`, branch `main`).

Este documento é **descritivo, não prescritivo**: registra o que existe hoje, incluindo as falhas.
Nada aqui foi corrigido nesta etapa. A reformulação da arquitetura do assistente **não começou**.

---

## 1. Visão geral do pipeline

```
usuário digita/fala
      │
      ▼
[1] Chat.tsx · send()
      │
      ▼
[2] ai.ts · askAssistant()  ──►  [3] nlp.ts · parseNaturalFull()
      │                                    │
      │                          [4] ai.ts · resolveLocal()
      ▼
[5] decisão: local ou remoto
      │
      ├─ local  ──────────────────────────────────────────┐
      │                                                    │
      └─ remoto                                            │
           │                                               │
           ▼                                               │
      [6] ai.ts · buildAiContext()                         │
           │                                               │
           ▼                                               │
      [7] POST /api/ai/chat  (vite.config.ts | api/ai/chat.ts)
           │                                               │
           ▼                                               │
      [8] api/_lib/deepseek.ts · callDeepSeekChat()        │
           │                                               │
           ▼                                               │
      [9] ai.ts · sanitizeActions()                        │
           │                                               │
           └───────────────────────────────────────────────┤
                                                           ▼
                                              [10] confirmação no chat
                                                           │
                                                           ▼
                                        [11] store.tsx · applyParsedAction()
                                                           │
                                                           ▼
                                        [12] reducer + localStorage
```

---

## 2. Etapa por etapa

### [1] Chat.tsx · `send(text)`

| | |
|---|---|
| **Arquivo** | `src/screens/Chat.tsx:72` |
| **Entrada** | String digitada, ditada (Web Speech API) ou vinda de um chip de sugestão / da Home (`location.state.ask`) |
| **Saída** | Mensagens despachadas para `state.chat` |
| **Responsabilidades** | Adicionar a mensagem do usuário; decidir local × remoto; montar o balão de resposta com `pending` (botões), `detail` (resumo detalhado) e `duplicateWarning` |
| **Dependências** | `askAssistant`, `askAssistantRemote`, `describeAction`, `describeActionDetailed`, `findGoalByExactName`, `findPossibleDuplicate` |
| **Limitações** | Só as **6** últimas mensagens viram histórico remoto, e só como texto puro. Nenhuma proposta pendente é enviada de forma estruturada. O `state` capturado no closure é o do início do turno |
| **Falhas possíveis** | Duas mensagens enviadas em sequência rápida usam o mesmo `state`; `thinking` bloqueia envio novo, mas não protege o estado de uma confirmação feita no meio |

### [2] ai.ts · `askAssistant(state, input)`

| | |
|---|---|
| **Arquivo** | `src/services/ai.ts:804` |
| **Entrada** | `AppState`, texto |
| **Saída** | `AiReply { text, actions?, choices?, engine, handled }` |
| **Responsabilidades** | Envelope fino sobre `resolveLocal()`; marca `engine: 'local'` e normaliza `handled` (`handled !== false` ⇒ `true`) |
| **Limitações** | `handled` é binário: não existe grau de confiança nem cobertura parcial da mensagem |

### [3] nlp.ts · `parseNaturalFull(input, { driver })`

| | |
|---|---|
| **Arquivo** | `src/services/nlp.ts:128` |
| **Entrada** | Texto livre, flag de perfil motorista |
| **Saída** | `ParseResult { actions, ambiguity? }` |
| **Responsabilidades** | Quebrar a frase em cláusulas (`splitClauses`, por verbos de comando e conectores); extrair ações por regex; fundir registros de trabalho; deduplicar; inferir viagens a partir de receitas de corrida; detectar a ambiguidade do "gás" |
| **Dependências** | `parseMoney` (parser monetário único), `guessCategory`, `sentenceCase` |
| **Limitações** | Determinístico e puramente regex. **Não produz** `kind: 'saving'` — "guardei 100" vira `goal-deposit`. **Não extrai `origin`**. **Não extrai data** — toda ação é implicitamente "hoje". Não entende números por extenso ("mil e quinhentos"). Não entende correção nem negação ("não, era 50") |
| **Falhas possíveis** | Frases longas com estruturas mistas podem gerar ações duplicadas ou perder cláusulas; `parseCardClause` tem prioridade e faz `return` cedo, descartando o resto da cláusula |

### [4] ai.ts · `resolveLocal(state, input)`

| | |
|---|---|
| **Arquivo** | `src/services/ai.ts:305` |
| **Entrada** | `AppState`, texto em minúsculas |
| **Saída** | `AiReply` |
| **Responsabilidades** | Cadeia de `if` sobre regex de intenção. Ordem: conversa ("vou te passar…") → registros → registro+orçamento → cartões → projeção por mês citado → perguntas de perfil não-motorista → perguntas de motorista → perguntas genéricas → fallback |
| **Dependências** | Praticamente todo o `calc.ts` e `cards.ts` |
| **Limitações** | Só o **fallback final** devolve `handled: false`. Qualquer `if` que casar encerra a mensagem inteira; não existe cobertura por cláusula |
| **Falhas possíveis** | Uma frase que casa um regex genérico ("contas") é respondida como pergunta mesmo quando o usuário queria outra coisa |

### [5] Decisão local × remoto

| | |
|---|---|
| **Arquivo** | `src/screens/Chat.tsx:84-94` |
| **Regra** | `local.actions?.length \|\| local.handled` ⇒ **local**. `settings.remoteAi === false` ⇒ **local**. Caso contrário ⇒ **remoto**, com o local como fallback se o remoto devolver `null` |
| **Limitações** | Binário e por mensagem inteira. Uma mensagem que é "registro + pergunta aberta" fica presa no local e a pergunta não é respondida, salvo o caso especial de orçamento tratado em `resolveLocal` |

### [6] ai.ts · `buildAiContext(state)`

| | |
|---|---|
| **Arquivo** | `src/services/ai.ts:38` |
| **Entrada** | `AppState` |
| **Saída** | Objeto agregado em pt-BR |
| **Responsabilidades** | Enviar só agregados — nunca a base bruta. Base comum: perfil, nome, saldo, saldo × contas de 7 dias, hoje/7 dias/mês/mês anterior, metas de compra, próximas contas, próximas entradas, orçamentos. Cartões e projeções só entram se `cardsOverview().hasData`. Motorista recebe taxa da 99, meta diária, custo por km, consumo, veículo e manutenções; os demais recebem `metaMensalParaGuardar` |
| **Limitações** | Sem lista de categorias válidas, sem cartões por nome quando não há dados, sem histórico de transações recentes. Nada de `saving` além de `guardadoDeVerdade` dentro da meta mensal |

### [7] Endpoint `POST /api/ai/chat`

| | |
|---|---|
| **Arquivos** | `vite.config.ts:60` (dev, plugin `aiProxy()`) · `api/ai/chat.ts:65` (produção, Vercel) |
| **Entrada** | `{ message, context, history }` |
| **Saída** | `{ reply, actions }` ou `{ error, message }` |
| **Responsabilidades** | Montar `messages`: system prompt, CONTEXTO com a data de hoje, até 6 mensagens de histórico (500 chars cada), mensagem atual (1000 chars) |
| **Limitações** | **A `SYSTEM_PROMPT` é duplicada manualmente** entre os dois arquivos e hoje está divergente (ver seção 3) |

### [8] api/_lib/deepseek.ts · `callDeepSeekChat(config, messages)`

| | |
|---|---|
| **Arquivo** | `api/_lib/deepseek.ts:120` |
| **Entrada** | Config (chave, modelo, base URL, timeout) e mensagens |
| **Saída** | `{ ok: true, reply, actions }` ou `{ ok: false, code }` — **nunca lança** |
| **Responsabilidades** | Chamada HTTP com `AbortController` (20 s); classificação de erro por status (401 auth, 402 saldo, 429 rate limit, 400/422 modelo ou bad request, 5xx); retry único ("nudge" com `temperature: 0`) só quando a resposta vem vazia ou sem JSON; extração de JSON do texto |
| **Limitações** | Se o JSON não for extraível, devolve o **texto puro como `reply` e `actions: []`** — as ações que o modelo tenha proposto somem em silêncio. Contrato limitado a `reply` + `actions` |
| **Dependências** | `fetch` nativo do Node; `isDeepSeekFailure()` é obrigatório nos chamadores porque, sob `strict: false`, o TS não estreita a união a partir de `if (!out.ok)` |

### [9] ai.ts · `sanitizeActions(raw)`

| | |
|---|---|
| **Arquivo** | `src/services/ai.ts:168` |
| **Entrada** | `data.actions` da resposta remota (JSON não confiável) |
| **Saída** | `ParsedAction[]`, no máximo **8** |
| **Responsabilidades** | Whitelist por `kind`; validação de números (`isNum` exige `> 0` e finito); strings limitadas a 80 chars; `installments` entre 1 e 120; `netReceived <= total`; `firstDueDate` no formato ISO. `reset` é deliberadamente recusado da IA remota |
| **Limitações** | **Não aceita `kind: 'saving'`** — some silenciosamente. **Não preserva `origin`** em `income`/`expense`. **Não aceita `is99`**, embora o prompt de dev instrua o modelo a produzi-lo. **Não valida `category` contra `state.categories`** — qualquer string de até 80 chars passa. **Não valida perfil**: uma ação `work`/`fuel`/`maintenance` para um perfil não-motorista passa pela sanitização (a única defesa é a limpeza de `is99` em `askAssistantRemote`, que é inócua porque `is99` nunca sobrevive) |

### [10] Confirmação no chat

| | |
|---|---|
| **Arquivo** | `src/screens/Chat.tsx:104-129` e `148-172` |
| **Responsabilidades** | Renderizar `pending` como Confirmar/Cancelar, `detail` com o resumo detalhado, `duplicateWarning` com o aviso de duplicidade, `choices` para desambiguação (escolher **não** registra: gera a confirmação normal) |
| **Limitações** | **Confirmação é tudo-ou-nada**: não dá para aceitar 2 de 3 ações propostas. Confirmações pendentes são descartadas ao recarregar o app (proposital) |

### [11] store.tsx · `applyParsedAction(dispatch, state, action, source)`

| | |
|---|---|
| **Arquivo** | `src/store/store.tsx:423` |
| **Entrada** | Uma ação confirmada |
| **Saída** | `boolean` — `false` quando não foi possível aplicar |
| **Responsabilidades** | Traduzir `ParsedAction` em `dispatch`. Grava sempre com `date = todayISO()` e `time = nowTime()`. Anexa `profileAtCreation`. `goal` só cria; `goal-update`/`goal-deposit` procuram por nome aproximado; `balance` redefine a âncora com `balanceAsOf: nowStamp()`; cartões nunca criam `Transaction` de despesa |
| **Limitações** | **Todas as ações do lote recebem o MESMO `state`**, capturado antes do primeiro `dispatch` — o React só reprocessa depois. Registrar duas receitas em um lote é seguro (são `addTx` independentes), mas dois `goal-deposit` na mesma meta calculam `saved` a partir do mesmo valor antigo e o segundo sobrescreve o primeiro. **Não há atomicidade**: se a ação 3 de 4 falha, as duas primeiras já foram aplicadas |
| **Falhas possíveis** | `return false` acontece por motivos diferentes (meta não encontrada, cartão citado inexistente, fatura sem valor pendente), mas o chat reporta todos como **"Não encontrei a meta correspondente"** (`Chat.tsx:154`) |

### [12] Reducer e persistência

| | |
|---|---|
| **Arquivo** | `src/store/store.tsx:122` (reducer), `368` (persistência) |
| **Responsabilidades** | Aplicar a mutação e gravar o estado inteiro em `localStorage['assistfin-state-v1']` com debounce de 150 ms |
| **Limitações** | Gravação do estado completo a cada mudança; sem versionamento de schema; sem journal de operações |

---

## 3. Divergências confirmadas entre os dois `SYSTEM_PROMPT`

Comparação literal entre `vite.config.ts` (dev) e `api/ai/chat.ts` (produção).

| # | Item | Dev (`vite.config.ts`) | Produção (`api/ai/chat.ts`) |
|---|---|---|---|
| 1 | Ação `{"kind":"odometer","value":number}` | **ausente** | presente, com a nota "NUNCA transforme hodômetro em km trabalhados" |
| 2 | Variante `{"kind":"income",...,"is99":true}` | **presente** | ausente |
| 3 | Categoria de despesa `autocuidado` | **ausente** da lista | presente na lista |
| 4 | Regra 2b (valor + litros + hodômetro no mesmo registro de abastecimento) | ausente | presente |
| 5 | Regra 2c (receita de corrida conta como viagem; "430 Uber, mais 399 da 99" são duas receitas) | ausente | presente |
| 6 | Regra 6b (mensagem que registra E pergunta deve responder às duas metades) | ausente | presente |

O restante dos dois textos é idêntico.

**Consequências práticas:**

- Em `npm run dev` a IA remota não sabe gerar `odometer` e não conhece `autocuidado` — dois
  comportamentos que existem em produção.
- A instrução `is99` do dev é **letra morta**: `sanitizeActions()` não tem esse campo em `income`,
  então ele é descartado antes de chegar ao chat. A "defesa extra" em `askAssistantRemote`
  (`ai.ts:275`) que limpa `is99` para não-motoristas nunca é acionada.
- **Nenhum dos dois prompts** menciona `saving` ou `origin`.

---

## 4. Pontos auditados

Os vinte pontos levantados, cada um confirmado no código. **Nenhum foi corrigido nesta etapa.**

| # | Ponto | Confirmado? | Onde |
|---|---|---|---|
| 1 | `SYSTEM_PROMPT` duplicada entre dev e produção | **Sim** | `vite.config.ts:13` e `api/ai/chat.ts:9` |
| 2 | Diferenças reais entre os dois prompts | **Sim** — 6 divergências | Seção 3 acima |
| 3 | Sanitização remota não preserva/suporta `origin`, `is99`, `saving`, categorias personalizadas, todos os tipos | **Sim, todos** | `ai.ts:168-244`. Sem `case 'saving'`; `origin` e `is99` não são copiados; `category` aceita qualquer string |
| 4 | `parseFloat` e parser monetário paralelo em `ai.ts` | **Sim** | `ai.ts:285` — `const n = (s) => parseFloat(s.replace(',', '.'))`, com `NUM = (\d+(?:[.,]\d+)?)` diferente do `NUM` de `nlp.ts`. Viola a regra 12 do CLAUDE.md |
| 5 | Roteamento local encerra a mensagem ao encontrar qualquer ação | **Sim** | `ai.ts:322-332` — `if (actions.length && !isQuestion) return` |
| 6 | Ausência de cobertura por cláusula ou trecho | **Sim** | `resolveLocal` opera sobre a string inteira; só `parseNaturalFull` quebra em cláusulas, e o resultado não é rastreado de volta ao texto |
| 7 | Só alguns casos de "registro + pergunta" são tratados | **Sim** | `ai.ts:338` cobre exclusivamente pergunta sobre **orçamento/limite**. Qualquer outra combinação perde a pergunta |
| 8 | Sem rascunho estruturado para esclarecimento em várias mensagens | **Sim** | O único mecanismo é `choices` (`types.ts:299`), resolvido numa única troca. Não há estado de proposta parcial |
| 9 | Histórico remoto limitado a textos recentes, sem proposta pendente | **Sim** | `Chat.tsx:92` envia 6 mensagens; `chat.ts:77` corta em 500 chars. `pending` nunca é serializado |
| 10 | Ausência de datas nas ações financeiras | **Sim** | Nenhum `kind` de `ParsedAction` tem campo de data (exceto `card-purchase.firstDueDate`); `applyParsedAction` usa `todayISO()` sempre |
| 11 | Sem suporte robusto a números por extenso | **Sim** | `parseMoney` só aceita dígitos. As únicas palavras numéricas reconhecidas são "mil" (em km e metas) e `dois..seis` numa única pergunta sobre meses (`ai.ts:386`) |
| 12 | Tratamento insuficiente de correções, negações e referências | **Parcial** | Existem verbos de subtração **apenas para trabalho** (`WORK_SUB_VERBS`, `nlp.ts:37`): "tira 100 km". Não há nada para "não, era 50", "cancela o último", "aquele gasto de ontem" |
| 13 | Várias ações aplicadas usando o mesmo `state` antigo | **Sim** | `Chat.tsx:152` — `actions.forEach(a => applyParsedAction(dispatch, state, a, 'ai'))` |
| 14 | Falta de atomicidade em lotes | **Sim** | Não há rollback; ações anteriores permanecem quando uma posterior falha |
| 15 | Mensagem genérica incorreta "Não encontrei a meta correspondente" | **Sim** | `Chat.tsx:154` usa esse texto para **qualquer** `false`, inclusive cartão inexistente e fatura sem pendência |
| 16 | Confirmação tudo ou nada | **Sim** | `Chat.tsx:258` — um único botão Confirmar para `m.pending.map(p => p.action)` |
| 17 | Contrato remoto limitado a `reply` e `actions` | **Sim** | `deepseek.ts:98` (`DeepSeekSuccess`) e `chat.ts:89`. Sem campo para perguntas, confiança, cobertura ou raciocínio |
| 18 | Resposta textual remota aceita com perda silenciosa de ações | **Sim** | `deepseek.ts:160` — quando não há JSON, devolve o texto com `actions: []` sem aviso nenhum |
| 19 | Validação insuficiente de categoria e perfil | **Sim** | `optStr(a.category)` não checa `state.categories`; nenhum `kind` é bloqueado por perfil na sanitização |
| 20 | Testes de regressão insuficientes | **Sim** | `scripts/test-app.mts` tem **8 blocos de asserção**, todos de perfil motorista, e cobre um único caminho de resposta local. Nenhum teste de `sanitizeActions`, `buildAiContext`, roteamento local×remoto, ou perfis não-motoristas |

---

## 5. Resumo das falhas mais graves

Em ordem de impacto no usuário:

1. **Perda silenciosa de ações** (pontos 3, 18) — o modelo propõe, o app descarta sem avisar.
2. **Divergência dev × produção** (pontos 1, 2) — o que se testa localmente não é o que roda.
3. **Confirmação tudo-ou-nada com estado obsoleto** (pontos 13, 14, 16) — lotes podem corromper
   metas e não podem ser aplicados parcialmente.
4. **Mensagem de erro enganosa** (ponto 15) — o usuário é mandado à tela errada.
5. **Sem datas** (ponto 10) — impossível registrar "ontem gastei 40".
6. **Roteamento binário por mensagem** (pontos 5, 6, 7) — metade da mensagem é ignorada.
7. **Parser monetário paralelo** (ponto 4) — a mesma classe de bug que já fez `100.000` virar
   `100` continua viva num arquivo.
8. **Cobertura de testes quase inexistente** (ponto 20) — nada disso é detectado automaticamente.

A matriz de casos concretos está em [AI_REGRESSION_MATRIX.md](AI_REGRESSION_MATRIX.md).
