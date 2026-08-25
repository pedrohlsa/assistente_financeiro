# CONTEXT.md — Handoff do AssistFin

> Documento de passagem de bastão. Escrito em **2026-08-01**, revisado em
> **2026-08-25** (rodada do copiloto semântico), verificado contra o
> código e o Git (não só contra a conversa). Convenção de confiança:
> **[FATO]** verificado no repo · **[INFERÊNCIA]** deduzido · **[PENDÊNCIA]** não feito.
>
> Fontes de verdade permanentes, mais detalhadas que este arquivo:
> `CLAUDE.md` (regras 1–59), `CONTEXTO.md` (produto), `PROGRESS.md` (diário por rodada),
> `docs/AI_CURRENT_STATE.md` e `docs/AI_REGRESSION_MATRIX.md` (IA). Este `CONTEXT.md`
> resume e aponta para eles — em caso de divergência, o código vence.

---

## 1. Visão geral do projeto

**AssistFin** — app mobile-first de gestão financeira pessoal em pt-BR, com um assistente
que entende linguagem natural. O usuário registra dinheiro conversando ("ganhei 250 hoje",
"gastei 40 de gasolina") ou por formulários, e pergunta sobre os próprios números. Um único
código atende **quatro perfis**: `driver` (motorista de app), `autonomo`, `clt`, `other`
(e o legado `business`, tratado como não-motorista).

**Objetivo atual:** o app está funcional e em produção. O trabalho recente foi endurecer o
assistente de IA (segurança temporal, auditoria/undo, edição de lançamento salvo) e polir a
UI mobile. O foco declarado do dono é o perfil **motorista** (o "tio" que vai usar).

**Stack [FATO]:** React 18 + TypeScript 5.5 + Vite 5 + React Router 6 (`HashRouter`, SPA sem
SSR). Estado em `useReducer` + Context (`src/store/store.tsx`), persistido em `localStorage`
na chave **`assistfin-state-v1`** (debounce 150 ms), offline-first, sem backend de dados.
Capacitor 8 empacota como APK Android. IA remota: DeepSeek (`deepseek-v4-flash`), server-only,
via função serverless na Vercel.

---

## 2. Estado atual

**[FATO] Tudo verde.**
- Suíte: **531/531 casos + 75/75 goldens novos + 4.080/3.800 mutações metamórficas +
  1.416 mensagens hostis + 106/106 invariantes** (rodado em 25/08/2026, `npm test`).
- Qualidade das respostas (`npm run rubric`, 90 mensagens em português real):
  **PERIGOSA 0 · RUIM 0 · ACEITÁVEL 6 · EXCELENTE 84**. PERIGOSA tem meta absoluta de zero.
- `npm run typecheck` e `npm run typecheck:api`: exit 0.
- `npm run build` e `npx vercel build --prod`: exit 0. Bundle inspecionado: sem chave,
  sem nome de env server-only, sem código server-only e sem dado de teste.
- Produção Vercel no ar: `https://assist-fin.vercel.app` (app HTTP 200, endpoint de IA
  respondendo com o contrato v1).
- APK debug gerado e entregue ao usuário nesta sessão (para o tio).

**Onde o desenvolvimento parou (17/08/2026):** a rodada ADAPTATIVA seguida de seis rodadas
de LIMITE. A adaptativa deu ao assistente um modelo pessoal derivado com evidência,
confiança e recência (`src/assistant/personalModel.ts`), a explicação das próprias decisões
(`explain.ts`), o ritmo do motorista medido no histórico dele (`driverInsights.ts`), e a
chave `settings.adaptiveAssistant` para desligar tudo. As de limite quebraram o que já
estava verde — entrada hostil, escala, estado corrompido, injeção pelo próprio dado,
cálculo extremo, persistência e layout — e acharam nove defeitos que o corpus não pegava
(centavo virando real, app parando de salvar em silêncio, CSV virando fórmula, e mais). Ver
as regras 37–50 do `CLAUDE.md` e as seções 17 e 18 do `docs/AI_REGRESSION_MATRIX.md`.
**Tudo mergeado na `main` e enviado ao remoto** (§9).

**Antes disso (13/08/2026):** vinte e dois commits em cinco rodadas de
sondagem. Atacaram o REGISTRO em fala real (os quatro parsers pendentes e mais vinte
defeitos que o corpus não achava), as perguntas que caíam no texto de ajuda, a correção de
lançamento salvo, e dois plugins nativos novos (ditado por voz e exportação de arquivo, que
simplesmente não funcionavam dentro do APK). Esse era o estado do deploy em produção até
hoje — as rodadas de 17/08 ainda não foram para o `.vercel`.

**O método que achou quase tudo:** rodar frases de fala real pelo orquestrador numa sonda
descartável e LER as respostas. Vários defeitos não apareciam em teste nenhum — só na
leitura ("tô no vermelho?" respondia "Sim" para quem tinha sobra; o lembrete de óleo dizia
JÁ VENCIDA para uma troca recém-feita). Ver regra 35 do `CLAUDE.md`.

O que já está implementado e funcionando (arquitetura da IA v1, contrato versionado):
- Registro por linguagem natural (receita, despesa, saving, trabalho, combustível,
  hodômetro, manutenção, meta, depósito em meta, saldo, cartão/parcelas, entrada financiada,
  pagamento de fatura, assinatura).
- Perguntas factuais respondidas **localmente** com dado real.
- Datas: passado relativo/absoluto, e segurança contra data futura (§4).
- Lote atômico + **journal de auditoria reversível**.
- **Desfazer o último lote** por conversa.
- **Corrigir um lançamento já salvo** por conversa (Transaction simples e ocorrência
  recorrente materializada).
- Edição da proposta antes de confirmar, validada.

---

## 3. Arquitetura e arquivos importantes

### Assistente de IA — `src/assistant/` [FATO: arquivos existem]
| Arquivo | Responsabilidade |
|---|---|
| `contracts.ts` | **Fonte de tudo**: `ACTION_CATALOG` (catálogo de ações), `validateAction()`, códigos de erro, tipos da `AssistantResponse` versionada. Só `import type` — é importado pela função serverless, não pode ter import de runtime. |
| `clauses.ts` | Segmenta a mensagem em cláusulas com posição, classifica intenção, calcula **cobertura**. Segurança temporal (`TemporalSignal`). |
| `dates.ts` | Datas e períodos pt-BR. `findDate`, `findAllDates`, `resolveDayInWindow`, `previousYearOf`. Reconhece `daqui a N`, `em N dias/semanas/meses`, `amanhã`, etc. |
| `numbers.ts` | Números por extenso. |
| `drafts.ts` | Conversa multiturno (rascunho, TTL 20 min, em memória). |
| `corrections.ts` | Correções/negações sobre a proposta na tela. |
| `execute.ts` | `applyActionPure`, `applyBatchPure` (atômico), `editBlockReason`, grava o journal no mesmo estado atômico. |
| `journal.ts` | Auditoria por **diferença de estado** (`diffForJournal`) + reversão (`revertBatchPure`, `lastReversibleBatch`, `isRevertFailure`). Limite `JOURNAL_LIMIT = 20`. |
| `editSaved.ts` | Corrigir lançamento salvo: `parseEditRequest`, `findEditCandidates` (busca **local**), `editActionFor`. |
| `proposalEdit.ts` | `editableFieldsFor` — campos editáveis da proposta derivados do catálogo. |
| `orchestrator.ts` | Amarra tudo: `orchestrate()`, decide local × remoto por cobertura, passos 2b (undo) e 2c (editar salvo). |

### Backend de IA — `api/_lib/` [FATO]
| Arquivo | Responsabilidade |
|---|---|
| `deepseek.ts` | Config + chamada HTTP da DeepSeek. **Server-only, nunca importar em `src/**`.** `callDeepSeekChat`, `isDeepSeekFailure`, classificação de erro. |
| `assistantPrompt.ts` | **Fonte única** da `SYSTEM_PROMPT`, gerada do catálogo. `buildSystemPrompt`, `normalizeCapabilities`, `sanitizeRemoteResponse`. |
| `assistantHandler.ts` | Pipeline do endpoint, compartilhado por `vite.config.ts` (dev) e `api/ai/chat.ts` (Vercel). |

### Motor local e serviços — `src/services/` [FATO]
| Arquivo | Responsabilidade |
|---|---|
| `ai.ts` | Motor de respostas local (`resolveLocal`), contexto/sanitização remota. `normalizeQuestion()` normaliza acento + abreviações para reconhecer perguntas. |
| `nlp.ts` | Parser determinístico pt-BR, `parseNaturalFull`, `describeAction`. Constantes-fonte `MOEDA`, `COMBUSTIVEL` e `looksRecurring` (esta reexportada por `clauses.ts` — o contrário seria ciclo). `driverDayResult()` é o resultado do dia do motorista. |
| `speech.ts` | Ditado por voz: plugin nativo no Android, Web Speech API no navegador. |
| `assistant/learning.ts` | O que o app aprende com o PRÓPRIO usuário — categoria, grafia e ordem de grandeza —, tudo DERIVADO de `state.transactions`. Sem campo novo, sem migração. Regras 37 e 38. |
| `exportFile.ts` | Escrita de arquivo: plugin nativo no Android, `<a download>` no navegador. |
| `calc.ts` | Todo cálculo financeiro: `currentBalance`, `dailyGoal`, `monthlySavingGoal`, `occurrencesBetween`, projeções. |
| `cards.ts` | Cartões, faturas, parcelas, limites. |
| `profile.ts` | Regras de perfil (`isDriver`, `shouldAsk99Fee`, `MENTIONS_99`, etc.). |
| `navigation.ts` | **Fonte única** da aba ativa da barra inferior (`activeTab`, `ROUTE_TAB`, `MORE_ROUTES`). |
| `notifications.ts`, `rideOverlay.ts` | Notificações locais e ponte do analisador flutuante Android. |

### UI — `src/components/` e `src/screens/` [FATO]
- `components/ui.tsx`: design system. `Sheet` (agora via **`createPortal` para `document.body`**),
  `MoneyInput` (traz `className="input"` por padrão), `ConfirmDialog`, `Icon`, toast.
- `components/ProposalCard.tsx`: revisão da proposta por item; folha de edição derivada do
  catálogo com `validateAction` ao salvar.
- `components/nav.tsx`: `BottomNav` (usa `activeTab`), `Fab` (ação contextual por rota).
- `screens/Chat.tsx`: assistente (casca fina sobre `orchestrate`). Input é `<textarea>` que
  cresce. Passa `caps` ao `ProposalCard` e `engine`+`messageId` ao lote.
- Demais telas: `Home`, `Transactions`, `Goals`, `Planning`, `Cards`, `Vehicle`,
  `RideAnalyzer`, `Analytics`, `Settings`, `More`, `Onboarding`.

### Estado e tipos [FATO]
- `src/store/store.tsx`: reducer, `applyAssistantBatch`, `normalizeState`, `resetAllData`,
  `hydrateForTest`. Action `assistantBatch` carrega `engine` e `messageId`.
- `src/models/types.ts`: todas as entidades. Novos nesta rodada anterior:
  `AssistantJournalEntry`, `AssistantJournalOp`, `assistantJournal?` em `AppState`, e as ações
  `undo-batch` e `edit-transaction` em `ParsedAction`.

### Testes — `tests/assistant/` e `scripts/` [FATO]
- `harness.ts` (`TODAY = '2026-07-15'`, `buildState`, `runCase`), `properties.ts` (57 invariantes).
- Corpus: `cases.ts`, `cases-critical.ts`, `cases-adversarial.ts`, `cases-temporal.ts`,
  `cases-undo.ts`, `cases-edit.ts`, `cases-fala-real.ts`, `cases-registro-real.ts`.
- **Cuidado ao escrever caso novo:** `resolveLocal` lê o RELÓGIO REAL da máquina, não a data
  injetada `TODAY`. Asserção que depende de mês/semana precisa montar as datas a partir de
  `todayISO()` — foi por isso que a invariante 57 existe em vez de um caso de corpus.
- Runner: `scripts/test-assistant.mts` (importa todos). `scripts/test-app.mts` (núcleo +
  `tests/navigation.ts`). `scripts/test-money.mjs`.

---

## 4. Regras de negócio (preservar nomes e comportamento)

As 32 regras completas estão em `CLAUDE.md`. Resumo das invariantes que **não podem quebrar**:

- **Taxa da 99**: só `perfil === 'driver'` E categoria `corridas` OU menção explícita
  (`MENTIONS_99`). Pergunta separada, nunca automática.
- **Cartão nunca contado 2×**: compra parcelada NÃO cria `Transaction` (vive em
  `installmentPlans` + `installments`). Pagar fatura (`CardPayment`) NÃO gera despesa.
- **Entrada financiada** (`type: 'financed-cash-inflow'`) NUNCA é `income`.
- **`parseMoney()`** é o único parser monetário. Entrada inválida → **NaN**, nunca 0.
- **Saldo**: fonte única `currentBalance(state)`. `settings.balance` é só âncora. `saving`
  fica **fora** do saldo (decisão de projeto).
- **IA nunca registra sem confirmação** (botão Confirmar/Cancelar).
- **`SYSTEM_PROMPT` tem uma fonte só** (`assistantPrompt.ts`, gerada do catálogo).
- **Nada entra no estado sem `validateAction()`** (mesma função server e cliente).
- **Lote atômico** (`applyBatchPure`): tudo ou nada.
- **Segurança temporal** (regra 24 do temporal fix): data futura de fato realizado é
  RECUSADA (`future-date`); `firstDueDate` é exceção (é previsão). Expressão temporal
  reconhecida nunca é trocada por hoje em silêncio — pergunta ou explica.
- **Regra 31 — auditoria reversível**: todo lote gera `assistantJournal` com `batchId`,
  contrato, motor, `createdAt`, perfil e **ID** da mensagem (nunca o texto). Ops derivadas por
  diferença de estado. Lote sem journal é recusado no undo, nunca revertido por adivinhação.
- **Regra 32 — corrigir ≠ desfazer**: `edit-transaction` muda Transaction salva (valor,
  descrição, categoria, origem, data — **nunca o tipo**); `undo-batch` reverte o lote. Editar
  ocorrência recorrente materializada NÃO mexe no template nem libera reconfirmação; desfazer
  o lote libera. Ambas com `remoteAllowed: false`.
- **Pergunta factual é sempre local** — respondida de `resolveLocal()` com dado real, nunca
  enviada à IA remota. (Foi o defeito corrigido nesta sessão, ver §6.)

---

## 5. Decisões tomadas (com o porquê)

- **Auditoria por diferença de estado, não registro manual** [FATO, regra 31]: `assistantBatchId`
  dentro da entidade só marca o que nasceu no lote; depósito em meta / pagamento de fatura /
  manutenção ALTERAM objetos existentes. O diff cobre create/update/delete e ação nova nasce
  auditada. Alternativa rejeitada: cada `case` do executor se registrar (frágil, esquecível).
- **Sheet via portal para `document.body`** [FATO, esta sessão]: `position: fixed` fica contido
  por ancestral com `transform` (a `.chat-screen` anima `cardIn`). Portal resolve para todas as
  folhas. Alternativa rejeitada: remover a animação (perderia o efeito e não seria robusto).
- **`normalizeQuestion()` só para intenção, registro lê o texto original** [FATO, esta sessão]:
  tirar acento + expandir abreviação para casar perguntas, sem risco de perder valor no registro.
- **Escopo do "editar salvo" limitado a Transaction simples + ocorrência recorrente** [FATO]:
  editar estrutura de parcelamento/cartão/meta desencontraria plano/parcelas/limite; recusa e
  aponta a tela certa.
- **`type: 'saving'` fora do saldo** [FATO, decisão antiga mantida]: a reserva pode ser cofrinho,
  não necessariamente outra conta.
- **Deixar data em branco na edição grava hoje** [FATO, verificado esta sessão]: é o padrão
  correto (registro feito agora, sem data dita, é de hoje). NÃO é bug.

---

## 6. Alterações realizadas nesta sessão (2026-08-01)

Duas frentes: 5 bugs de UI mobile + auditoria de qualidade da IA.

### Bugs de UI (commit `63c1fae`) [FATO]
1. **Input do chat** → `<textarea>` que cresce e quebra linha (Enter envia, Shift+Enter pula).
   CSS em `global.css` (`.chat-input-bar textarea`, `max-height: 7.5em`).
2. **Campos da folha "Editar lançamento"** → ganharam `className="input"` (antes só o
   `MoneyInput` tinha estilo).
3. **"Ver detalhes" / "Confirmar só este"** → `display: block` (eram inline-block grudados).
4. **Data em branco na edição** → investigado, **NÃO é bug** (padrão = hoje). Nenhuma mudança.
5. **Vazamento da barra atrás da folha** → `Sheet` portalizado para `document.body`.

### Qualidade da IA (commit `389e2a1`) [FATO]
- Auditoria mediu o roteador de perguntas: **9/10** na frase do manual, **2/10** na frase real
  que o usuário digita. Causa: `resolveLocal()` só fazia `toLowerCase()`.
- **`normalizeQuestion()`** em `src/services/ai.ts`: minúsculas + remove acento + expande 21
  abreviações (`ta`→`esta`, `to`→`estou`, `pra`→`para`, `hj`→`hoje`, `qnt`→`quanto`, etc.).
- Padrões ampliados: saldo, quanto posso gastar, custo por km, melhor dia, gasto por
  categoria (`já gastei`), comparação mês a mês, meta pelo NOME.
- `como está meu mês?` agora responde também no perfil motorista (antes só não-motorista).
- Resultado: **10/10 nos dois jeitos**.
- Novo corpus `tests/assistant/cases-fala-real.ts` (17 casos), incluindo 3 que garantem que a
  normalização não transforma REGISTRO em pergunta.
- Docs (`PROGRESS.md`) atualizados com ambas as frentes.

### Rodada anterior (mesma sessão longa, já commitada e deployada)
- Item 40 (journal `016f467`), Item 34 (edição da proposta `0e33549`), Item 23 (undo `ea78bc6`),
  Itens 22+26 (editar salvo `2ebf9dd`), navegação (`5dcac42`), correção temporal (`d4675bd`).

---

## 7. Pendências

### Rodada ADAPTATIVA (17/08/2026) — o que mudou [FATO]

Arquitetura em cinco módulos separados, cada um com um trabalho só:

| Arquivo | Papel |
|---|---|
| `src/assistant/personalModel.ts` | CONSTRÓI o conhecimento: evidência, confiança, recência, chaves por frase |
| `src/assistant/learning.ts` | APLICA à proposta: categoria, grafia, aviso de valor |
| `src/assistant/suggestions.ts` | Fileira de sugestões, incluindo a lista educativa por perfil |
| `src/assistant/explain.ts` | "Por que você fez isso?" e o controle do usuário |
| `src/assistant/driverInsights.ts` | Ritmo do motorista, medido no histórico dele |

Nada de armazenamento paralelo: tudo é derivado de `state.transactions`, então apagar o
histórico apaga o aprendizado, corrigir um lançamento corrige o padrão, e desfazer um lote
remove a evidência — sem uma linha de código de sincronização.

**Defeitos do aprendizado antigo, todos reproduzidos numa sonda adversarial antes de
existir correção:** categoria arquivada fazia o lançamento inteiro sumir; cinco lançamentos
de janeiro ganhavam de três de julho; quatro lançamentos de 2020 decidiam um gasto de 2026;
a palavra "casa" de "Conta de luz da casa" contaminava "comida na casa da minha mãe" com
evidência forte; "Mercado livre" ensinava o que é "mercado"; origem não tinha grafia
canônica; sugestões diziam "gastei no gasolina" e "minha notebook"; e não existia nem
explicação nem chave para desligar.

**Defeitos achados LENDO as respostas, que teste nenhum tinha visto:** a explicação
contradizia o app ("essa veio das palavras da mensagem" para uma categoria vinda do
histórico); perguntar "por que" cancelava a proposta na tela; o ranking de dia da semana
ranqueava sábado com UM sábado; "seu normal nos 30 dias" era calculado sobre dois dias;
`"hoje foi 430 na uber"` propunha receita E despesa de 430 (defeito antigo do parser, sem
relação com o aprendizado); `"da kitnet do fundo"` virava a origem `"kitnet do"`; e
`"quanto eu costumo gastar de suco por dia"` respondia com o resumo do dia inteiro.

**Limitações honestas que ficaram:**
- "Perguntas frequentes" como fonte de sugestão **não** foi implementado: as sugestões só
  aparecem quando `state.chat` está vazio, então não há histórico de perguntas para ler
  naquele momento. Criar um armazenamento separado contradiria a decisão de tudo ser
  derivado.
- O assistente **não** liga nem desliga `adaptiveAssistant` por conversa — ele explica onde
  fica a chave. Mexer em configuração por conversa é a mesma classe de coisa que registrar
  sem confirmar.
- Categoria dita explicitamente na mensagem e categoria adivinhada pela lista genérica são
  indistinguíveis na saída do parser. Vale a decisão da regra 37: histórico consistente e
  forte ganha do palpite genérico.
- Erro de digitação no VERBO (`gsatei 60 no merkado`) continua sem registro local — é o
  limite conhecido de um parser determinístico.
- O eval comparativo de modelos remotos (fase 13) **não foi executado**: exige chamadas
  pagas à API, que não foram autorizadas. Nada de modelo, preço ou retry foi alterado.

### Pendências confirmadas (fora de escopo por decisão, documentadas) [FATO]
- Editar por conversa a **estrutura** de parcelamento, cartão, meta, veículo e template de
  recorrência (só Transaction simples + ocorrência é suportado).
- **`Analytics.tsx` por perfil**: continua igual para motorista e não-motorista. Pendência
  antiga, anterior a toda a reformulação da IA.
- Editar recorrência existente (valor/frequência/data inicial) não tem tela — só criar/remover.
- Antecipação de parcela sem desconto/juros; editar parcela específica só existe no reducer.

### Problemas do parser — TODOS CORRIGIDOS em 13/08/2026 [FATO]
Os quatro estão no corpus `tests/assistant/cases-registro-real.ts` (41 casos):
1. ~~`hoje foi fraco so 150 reais 8 horas na rua`~~ → registra receita + horas. Junto veio
   um defeito pior que ninguém tinha visto: **`foi 400 hoje` gravava o faturamento do dia
   como DESPESA** (o `foi` é verbo de gasto no parser). Invariantes 54 e 55 travam os dois
   sentidos.
2. ~~`gastei 20 e 30`~~ → duas despesas; descrição puramente numérica é recusada.
3. ~~`gastei 30 pila no lanche`~~ → constante `MOEDA` única (pila, conto, mango, pau, prata).
4. ~~`paguei 80 de gazolina`~~ → termos de categoria viraram RADICAIS (`gasolin`/`gazolin`).

### Defeitos achados pela SONDA na mesma rodada e corrigidos [FATO]
Nenhum deles apareceria só rodando o corpus:
- `posso gastar 50 no mercado?` virava despesa de 50 (verbo no infinitivo). Invariante 56.
- `na verdade foi 200`, sem nada na tela, criava gasto de R$ 200. `looksLikeRetraction`.
- `tô no vermelho?` respondia "Sim" para quem tinha sobra — polaridade. Invariante 57.
- `pago 90 de internet todo mês` virava despesa avulsa e inflava o mês (regra 18).
- `quero juntar 5000 pra uma moto` criava meta chamada "Objetivo".
- `passei 1200 no nubank em 3x` não registrava nada.
- `ontem fiz 280 e hoje 320` registrava só os 280, e `ontem gastei 50 e hoje gastei 80`
  gravava as duas despesas em ONTEM. Junto veio um bug pré-existente: a fusão de registros
  de trabalho somava dias diferentes (invariante 58).
- `rodei 200 km em 10 horas` perdia a jornada; `quanto já juntei da moto` não era
  respondida.
- **"Quando trocar o óleo" dizia JÁ VENCIDA para uma troca recém-feita** — o assistente
  grava `lifeKm: 0` e o lembrete somava zero. O pior achado da sessão.
- `meu salário caiu hoje 3200` não registrava nada ("caiu" não era verbo de receita);
  `recebi o salário` caía no texto de ajuda em vez de perguntar o valor.
- `recebi 1800 de aluguel e 900 de um freela` perdia a segunda receita (invariante 60).
- A proposta mostrava `R$ 3200,00`, sem separador de milhar (invariante 59).
- Corrigir lançamento salvo só funcionava com substantivo genérico; agora aceita o nome
  do próprio lançamento ("muda o mercado de 100 pra 80").
- `gastei uns 50` não registrava nada (o "uns" quebrava o parser); `comprei uma tv` caía
  no texto de ajuda; com a proposta na tela, `80` e `na verdade 80` não corrigiam o valor.
- `tô com 3000 na conta` respondia sobre CONTAS A VENCER — a palavra "conta" puxava a
  pergunta errada.
- 7 perguntas que o app sabia responder caíam no texto de ajuda, entre elas
  `vale a pena corrida de 8 reais` — que ainda virava tentativa de REGISTRO.

### Melhorias desejáveis [PENDÊNCIA]
- Assistente confirmar **ocorrência recorrente por conversa** (o journal/reversão já tratam
  `recurring` genericamente e a invariante 46 prova o mecanismo, mas nenhum lote produz uma hoje).
- Correção de múltiplos campos numa frase ("muda para 80 e para lazer" não é interpretado).
- Busca de candidatos da edição desempatar pelo tipo/substantivo (hoje usa data + valor + janela
  de 120 dias).

### Pontos que precisam de validação manual [PENDÊNCIA]
- Teste no **aparelho real** do tio (motorista): fluxo de registro do dia, perguntas, undo.
- Confirmar as 5 correções de UI num Android físico (o preview do navegador não compõe frames
  de forma idêntica).
- **Os dois plugins nativos novos (Speech e Export) só foram COMPILADOS**, nunca executados
  em Android físico. `cap sync` e `compileDebugJavaWithJavac` passam; o comportamento em
  aparelho é desconhecido. É a maior incerteza aberta desta rodada.
- **"Aquela coisa que fica na tela principal só pra clicar"** (relatado pelo dono, 13/08):
  NÃO mexido. Há quatro candidatos na Home — o card do assistente com os chips, o
  "toque no valor para alternar" do resultado do dia, o alerta 🎯 que repete o que o card
  da meta já diz, e o "Por que essa meta? →". Mudar a Home do motorista no escuro violaria
  a regra 2. Precisa o dono apontar qual é.

### Ideias discutidas, NÃO aprovadas [INFERÊNCIA — não implementar sem pedir]
- Nenhuma ideia grande pendente de aprovação neste momento.

---

## 8. Testes e validações

**Comandos [FATO]:** `npm test` · `npm run test:assistant` · `npm run typecheck` ·
`npm run typecheck:api` · `npm run build` · `npx vercel build --prod` (build local) ·
`npm run test:assistant:remote` (8 sondas contra a DeepSeek real — só o CONTRATO, instável).

**Resultados nesta sessão [FATO]:**
- `npm test`: **385/385 casos + 53/53 invariantes**, exit 0.
- `typecheck` e `typecheck:api`: exit 0.
- `build`: exit 0.
- Smoke em produção: app HTTP 200, endpoint de IA respondendo contrato v1.

**Verificações manuais no navegador (375×812) [FATO]:** textarea cresce/quebra; folha de
edição estilizada e em largura total sem vazamento; links do card em linhas separadas;
console sem erros (em aba nova — erros de `ProposalCard` durante desenvolvimento eram do HMR).

**Não testado [PENDÊNCIA]:** aparelho Android físico; os 4 casos de parser fracos do §7.

**Riscos de regressão [INFERÊNCIA]:** baixo. As mudanças da IA são aditivas (normalização +
padrões novos + campo opcional no estado). A blindagem por corpus (385 casos) é o que segura;
os 3 casos `fr-15/16/17` garantem que a normalização não vira registro em pergunta.

**Caveat conhecido [FATO]:** `ai.ts` usa o relógio real da máquina em alguns cálculos de mês;
como os fixtures são de julho e a máquina está em agosto, respostas de "mês" mostram R$ 0,00
em teste manual isolado — não é bug de produção, é o fixture defasado.

---

## 9. Estado do Git

- **Branch atual [FATO]:** `feat/assistant-orchestrator`.
- **Último commit [FATO]:** rodada adaptativa de 17/08/2026 — nove commits, do
  `349889d test: casos vermelhos da auditoria adversarial do aprendizado` em diante.
  Ver `PROGRESS.md`.
- **Antes [FATO]:** `b148661 fix: saldo dito de outro jeito e gíria de guardar dinheiro`
  (13/08/2026), fim das cinco rodadas de sondagem.
- **`feat/assistant-orchestrator` [FATO]:** `9d76061`, **já no remoto**
  (`origin/feat/assistant-orchestrator` em sincronia). É a branch de trabalho.
- **`main` [FATO]:** `eb54a4e`, **já no remoto** (`origin/main` em sincronia). A rodada
  adaptativa + as seis de limite foram mescladas na main em 17/08/2026 (merge `--no-ff`,
  seguindo o padrão dos três merges anteriores). Tudo que está na branch está na main.
- **Push feito em 17/08/2026 com autorização explícita do dono.** Deploy e APK NÃO foram
  refeitos nesta rodada — o `.vercel` em produção ainda serve o código de 13/08. Republicar
  exige `npm run build` + `npx vercel --prod` (ver §5) e continua dependendo de autorização.
- **Repositório continua PRIVADO** (`gh repo view` → `isPrivate: true`). O dono cogitou
  torná-lo público para revisão externa; a decisão foi NÃO — em vez disso, o código-fonte
  foi empacotado com `git archive` (só arquivo versionado, sem `.env`/`node_modules`/`dist`)
  para revisão fora do GitHub.
- **`.claude/launch.json` [FATO]:** tem uma entrada apontando para outro projeto
  (`D:/Claude/sopa`) e fica FORA de todos os commits de propósito — é config local de
  máquina, não do AssistFin. Working tree limpo exceto por esse arquivo.
- **Segurança do histórico [FATO]:** varredura em TODO o histórico antes do push — nenhum
  `.env` jamais versionado; zero ocorrências de `sk-*` real, `ghp_`, `AKIA`, chave privada
  ou JWT; keystore, `google-services` e `.vercel` não rastreados. Os `sk-` que aparecem no
  `PROGRESS.md` são texto de documentação ("bundle sem `sk-`").
- **Remoto:** `https://github.com/pedrohlsa/assistente_financeiro`. Sem PRs nem issues abertos.
- **Produção Vercel:** projeto `assist-fin`, alias `https://assist-fin.vercel.app`. Env
  `DEEPSEEK_API_KEY` e `DEEPSEEK_MODEL` já configuradas (nunca exibir valores). O deploy no ar
  é o de 13/08 — as rodadas adaptativa e de limite ainda não foram para produção.

---

## 10. Próximos passos (priorizado)

1. **Gerar APK e validar no aparelho do tio** — os dois plugins nativos (ditado e
   exportação) NUNCA rodaram em Android físico. É a maior incerteza aberta.
2. **Perguntar ao dono qual é "aquela coisa da tela principal"** (§7) antes de mexer na Home.
3. **Enviar ao GitHub e deployar** quando o dono autorizar — vinte e dois commits estão só aqui.
4. Só então avaliar features maiores (Analytics por perfil, confirmar recorrente por conversa,
   cadastrar recorrência por conversa — hoje o assistente recusa e aponta o Planejamento).

---

## 11. Instruções para a próxima IA (ler antes de tocar em qualquer coisa)

- **Confira o código antes de afirmar que algo existe.** Este arquivo é resumo; o código vence.
- **NÃO recrie** a arquitetura da IA (contrato, orquestrador, journal, undo, edição). Está
  pronta e testada. Verifique `src/assistant/` antes.
- **NÃO desfaça decisões aprovadas** do §5 (saving fora do saldo, Sheet via portal, escopo do
  editar salvo, normalização só para intenção).
- **NÃO altere regra financeira** sem necessidade — as invariantes do §4 / `CLAUDE.md` são lei.
- **Método obrigatório** (regra 30 do `CLAUDE.md`): mexeu em parser/orquestrador/validação?
  Adicione caso em `tests/assistant/cases*.ts`. Reproduza o bug ANTES de corrigir, veja o
  vermelho, então conserte. Commit isolado por correção.
- **Extensão `.js` obrigatória** em imports relativos dentro de `api/**` (loader ESM do Node).
  `api/**` não é coberto por `tsc` local — rode `npm run typecheck:api` (replica a Vercel).
- **`deepseek.ts` é server-only** — nunca importar em `src/**`.
- **Não invente frases do parser como se funcionassem** — os 4 casos do §7 estão QUEBRADOS.
- **Não faça push/deploy/APK sem o usuário pedir explicitamente.**
- **UI/UX:** sentence case em toda a interface (regra 13); dinheiro só via `<MoneyInput>`;
  ações destrutivas via `<ConfirmDialog>`, nunca `window.confirm`.
- **Preview do navegador não compõe frames** de forma idêntica ao dispositivo — medir cor no
  meio de transição CSS engana; desligue a transição ao medir, ou valide no aparelho.

---

## 12. Informações que NÃO puderam ser confirmadas

- **SHA-256 / bytes do último APK** e **IDs de deployment da Vercel**: existem na conversa
  desta sessão, mas não são re-verificáveis a partir do repositório. Se precisar, regere o APK
  e rode `sha256sum`.
- **Env vars da Vercel além dos nomes**: só os nomes foram vistos (`DEEPSEEK_API_KEY`,
  `DEEPSEEK_MODEL`); valores nunca exibidos, por regra de segurança.
- **Contagem exata de casos por arquivo de corpus**: o total autoritativo é **385** (do runner);
  as contagens por grupo em `docs/AI_REGRESSION_MATRIX.md` podem estar defasadas de rodadas
  anteriores — confie no total do `npm test`.
