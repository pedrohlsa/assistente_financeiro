# CONTEXT.md — Handoff do AssistFin

> Documento de passagem de bastão. Escrito em **2026-08-01**, verificado contra o
> código e o Git (não só contra a conversa). Convenção de confiança:
> **[FATO]** verificado no repo · **[INFERÊNCIA]** deduzido · **[PENDÊNCIA]** não feito.
>
> Fontes de verdade permanentes, mais detalhadas que este arquivo:
> `CLAUDE.md` (regras 1–32), `CONTEXTO.md` (produto), `PROGRESS.md` (diário por rodada),
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

**[FATO] Tudo verde e em produção.**
- Suíte: **385/385 casos + 53/53 invariantes** (rodado nesta sessão, `npm test`).
- `npm run typecheck` e `npm run typecheck:api`: exit 0.
- `npm run build`: exit 0.
- Produção Vercel no ar: `https://assist-fin.vercel.app` (app HTTP 200, endpoint de IA
  respondendo com o contrato v1).
- APK debug gerado e entregue ao usuário nesta sessão (para o tio).

**Onde o desenvolvimento parou:** acabei de auditar a qualidade da IA e corrigir o roteador
de perguntas (fala real do usuário). Últimos commits já mergeados em `main`, enviados ao
GitHub e deployados. **O ciclo está fechado** — não há trabalho pela metade. O próximo passo
é opcional (ver §11): melhorar 4 casos de parser ainda fracos.

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
| `ai.ts` | Motor de respostas local (`resolveLocal`), contexto/sanitização remota. **`normalizeQuestion()`** (novo nesta sessão) normaliza acento + abreviações para reconhecer perguntas. |
| `nlp.ts` | Parser determinístico pt-BR, `parseNaturalFull`, `describeAction`. |
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
- `harness.ts` (`TODAY = '2026-07-15'`, `buildState`, `runCase`), `properties.ts` (53 invariantes).
- Corpus: `cases.ts`, `cases-critical.ts`, `cases-adversarial.ts`, `cases-temporal.ts`,
  `cases-undo.ts`, `cases-edit.ts`, `cases-fala-real.ts`.
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

### Pendências confirmadas (fora de escopo por decisão, documentadas) [FATO]
- Editar por conversa a **estrutura** de parcelamento, cartão, meta, veículo e template de
  recorrência (só Transaction simples + ocorrência é suportado).
- **`Analytics.tsx` por perfil**: continua igual para motorista e não-motorista. Pendência
  antiga, anterior a toda a reformulação da IA.
- Editar recorrência existente (valor/frequência/data inicial) não tem tela — só criar/remover.
- Antecipação de parcela sem desconto/juros; editar parcela específica só existe no reducer.

### Problemas conhecidos do parser (medidos nesta sessão, NÃO corrigidos) [PENDÊNCIA]
Prioridade sugerida do mais para o menos importante (o nº 1 afeta o motorista):
1. **`hoje foi fraco so 150 reais 8 horas na rua`** → não registra nada. Perde receita e horas
   por não haver verbo de ganho explícito.
2. **`gastei 20 e 30`** → vira uma despesa de 20 com descrição "30".
3. **`gastei 30 pila no lanche`** → deixa a gíria "Pila" na descrição.
4. **`paguei 80 de gazolina`** (com typo) → cai em `outros-out`, não em combustível.

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
- **Último commit [FATO]:** `389e2a1 fix: answer real user phrasing locally instead of falling back to the model`.
- **`main` [FATO]:** contém tudo mergeado (último merge `a8d9073`), em sincronia com `origin/main`.
- **Commits locais não enviados [FATO]:** nenhum. Branch e `main` estão em sincronia com o
  remoto (`git log origin/..` vazio nos dois).
- **Arquivos modificados / não rastreados [FATO]:** nenhum (working tree limpo — este
  `CONTEXT.md` novo será a única alteração até você commitar, se pedir).
- **Remoto:** `https://github.com/pedrohlsa/assistente_financeiro`. Sem PRs nem issues abertos.
- **Produção Vercel:** projeto `assist-fin`, alias `https://assist-fin.vercel.app`, deployado
  com o código atual nesta sessão. Env `DEEPSEEK_API_KEY` e `DEEPSEEK_MODEL` já configuradas
  (nunca exibir valores).

---

## 10. Próximos passos (priorizado)

1. **Validar no aparelho do tio** (motorista) — é o teste que falta e o público-alvo real.
2. **Corrigir o parser nº 1** do §7 (`150 reais 8 horas` sem verbo → perde receita+horas).
   É o que mais dói para motorista. Seguir o método: reproduzir → caso vermelho → corrigir →
   corpus inteiro → commit isolado.
3. Corrigir os parsers nº 2–4 do §7 (menos urgentes).
4. Só então avaliar features maiores (Analytics por perfil, confirmar recorrente por conversa).

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
