# Arquitetura do assistente do AssistFin

Estado **depois** da reformulação de 28/07/2026 (branch `feat/assistant-orchestrator`).
Contrato do assistente: **versão 1**.

> A versão anterior deste documento descrevia o pipeline antigo e os 20 problemas
> auditados. Todos foram endereçados; a seção 6 registra o que ficou de fora, sem maquiagem.

---

## 1. A causa estrutural do problema antigo

Não era o prompt. Era a arquitetura tratar a mensagem como **uma coisa só**:

```
achou ação?  → usa o local, encerra
não achou?   → manda a mensagem INTEIRA pro modelo
```

Desse único `if` saíam quase todos os sintomas: metade da mensagem se perdia quando a outra
metade era entendida; "registro + pergunta" só funcionava para orçamento; o remoto duplicava o
que o local já tinha visto; e não existia nenhum lugar onde o sistema pudesse dizer
"entendi isto, não entendi aquilo".

Somavam-se a isso quatro decisões que se pagavam caro: prompt duplicado à mão, validação frouxa
que descartava ação em silêncio, lote aplicado sobre estado obsoleto e erro genérico.

---

## 2. O pipeline novo

```
usuário
   │
   ▼
Chat.tsx ── casca fina: envia, renderiza, confirma
   │
   ▼
orchestrator.ts
   ├─ 0. a mensagem escolhe uma opção que eu ofereci?      → resolve com as ações prontas
   ├─ 1. a mensagem responde a uma pergunta pendente?      → drafts.ts
   ├─ 2. a mensagem corrige a proposta na tela?            → corrections.ts
   ├─ 3. análise por cláusula                              → clauses.ts
   │        ├─ numbers.ts  (números por extenso)
   │        ├─ dates.ts    (datas e períodos)
   │        └─ nlp.ts      (parser determinístico)
   ├─ 4. intenção incompleta                               → abre rascunho e pergunta
   ├─ 5. perguntas respondidas no estado PROJETADO         → ai.ts
   ├─ 6. sobrou cláusula? → IA remota, que RECONCILIA      → /api/ai/chat
   ├─ 7. avisos de duplicidade (estado + dentro do lote)
   └─ 8. AssistantResponse versionada
   │
   ▼
ProposalCard.tsx ── revisão por item: confirmar tudo / um / editar / remover / cancelar
   │
   ▼
execute.ts · applyBatchPure ── sequencial e atômico
   │
   ▼
store.tsx · action única `assistantBatch`
```

### Arquivos

| Arquivo | Papel |
|---|---|
| `src/assistant/contracts.ts` | Catálogo de ações, validação determinística, códigos de erro, tipos da resposta. **Sem import em runtime** — é importado pela função serverless |
| `src/assistant/clauses.ts` | Segmentação com posição, intenção por trecho, cobertura, origem, data |
| `src/assistant/numbers.ts` | Números por extenso em pt-BR |
| `src/assistant/dates.ts` | Datas e períodos; marca ambiguidade em vez de chutar |
| `src/assistant/drafts.ts` | Rascunho multiturno e encaixe de respostas curtas |
| `src/assistant/corrections.ts` | Correções, negações e referências sobre a proposta |
| `src/assistant/execute.ts` | Aplicação pura, sequencial e atômica + resolvedores de referência |
| `src/assistant/orchestrator.ts` | Orquestração e decisão local × remoto |
| `api/_lib/assistantPrompt.ts` | **Fonte única** da SYSTEM_PROMPT (gerada do catálogo) e do sanitizador |
| `api/_lib/assistantHandler.ts` | Pipeline do endpoint, compartilhado pelos dois backends |
| `src/components/ProposalCard.tsx` | Revisão por item, com edição validada |

---

## 3. Decisões que sustentam o resto

### Contrato versionado

```ts
type AssistantResponse =
  | { version: 1; mode: 'answer';             reply; actions: []; unresolved }
  | { version: 1; mode: 'propose_actions';    reply; actions; unresolved }
  | { version: 1; mode: 'answer_and_actions'; reply; actions; unresolved }
  | { version: 1; mode: 'clarify';            reply; actions; clarification; unresolved }
```

Uma resposta com versão desconhecida é **recusada**, nunca interpretada na sorte.

### O prompt é gerado, não escrito

`buildSystemPrompt(caps, hoje)` monta o texto a partir de `ACTION_CATALOG` e das capacidades
reais: perfil, categorias (inclusive personalizadas), cartões e metas do usuário. Consequências:

- é impossível anunciar ao modelo uma ação que o cliente não valida;
- é impossível o prompt listar uma categoria que não existe naquele aparelho;
- ação `driverOnly` **não aparece** no prompt de perfil não-motorista.

Uma invariante do teste percorre o catálogo e confere que o prompt cobre exatamente as ações
remotas — e nenhuma a mais.

### Validação única

`validateAction(raw, caps, hoje)` roda no servidor **e** no cliente. Checa tipo de campo, faixa,
data plausível, categoria existente e do tipo certo, e perfil. Toda recusa volta com código
(`category-wrong-type`, `profile-forbidden`, `invalid-date`…). `reset` tem `remoteAllowed: false`.

### Cobertura por cláusula

Cada trecho carrega `intent`, `handled`, `confidence`, `actions`, `date` e `ambiguity`, com
`start`/`end` no texto original. `coverage` é a fração do texto que o motor local resolveu. A IA
remota é chamada quando sobra cláusula — e reconcilia por assinatura de ação, sem duplicar.

Trechos que **não podem ser cortados** são protegidos: "passei 2000 em 5 vezes **e recebi** 1850"
tem verbo de comando no meio, e cortar ali transformava a entrada financiada numa receita.

### Multiturno

O rascunho guarda a ação incompleta e os campos que faltam, com TTL de 20 minutos, e mora em
memória — uma pergunta pendente **não ressuscita** depois de recarregar o app. Respostas curtas
("Nubank", "quatro mil", "em 4x", "sim", "foi ontem") são encaixadas contra o que foi perguntado.

Opções de esclarecimento carregam o **efeito completo**: responder "GNV" recupera o valor e a
descrição sozinho — o usuário nunca repete o que já disse.

### Execução atômica

`applyBatchPure` aplica cada ação sobre o estado que a anterior produziu e só devolve o novo
estado se todas passarem. Dois depósitos na mesma meta somam. Uma falha no meio não deixa meio
lote gravado, e a interface diz exatamente qual item travou.

Auditoria opcional em cada lançamento: `source: 'ai'`, `assistantBatchId`, `profileAtCreation`.

---

## 4. Os 20 pontos auditados

| # | Ponto | Situação |
|---|---|---|
| 1 | `SYSTEM_PROMPT` duplicada | **Resolvido** — fonte única em `assistantPrompt.ts` |
| 2 | Divergências entre os prompts | **Resolvido** — não há o que divergir |
| 3 | Sanitização sem `origin`/`saving`/categorias | **Resolvido** — validação pelo catálogo |
| 4 | `parseFloat` paralelo em `ai.ts` | **Resolvido** — delega a `parseMoney` |
| 5 | Roteamento encerra na primeira ação | **Resolvido** — cobertura por cláusula |
| 6 | Sem cobertura por trecho | **Resolvido** — `clauses.ts` |
| 7 | "Registro + pergunta" só no orçamento | **Resolvido** — genérico, com estado projetado |
| 8 | Sem rascunho estruturado | **Resolvido** — `drafts.ts` |
| 9 | Histórico remoto sem proposta pendente | **Parcial** — histórico foi a 8 mensagens; a proposta continua fora do payload remoto |
| 10 | Sem datas | **Resolvido** — `date?` opcional + `dates.ts` |
| 11 | Sem números por extenso | **Resolvido** — `numbers.ts` |
| 12 | Correções e referências | **Resolvido para a proposta pendente**; editar lançamento já salvo continua fora |
| 13 | Lote sobre estado obsoleto | **Resolvido** — aplicação sequencial |
| 14 | Sem atomicidade | **Resolvido** — tudo ou nada, com resultado por ação |
| 15 | "Não encontrei a meta" para tudo | **Resolvido** — 18 códigos de erro |
| 16 | Confirmação tudo-ou-nada | **Resolvido** — revisão por item |
| 17 | Contrato remoto pobre | **Resolvido** — envelope versionado com `mode` e `clarification` |
| 18 | Texto puro engolindo ações | **Resolvido** — `envelope: null` e `contractFallback: true` |
| 19 | Validação de categoria e perfil | **Resolvido** |
| 20 | Testes insuficientes | **Resolvido** — 302 casos + 27 invariantes |

---

## 5. Testes

| Comando | O que roda |
|---|---|
| `npm test` | núcleo + corpus do assistente (offline, data fixa 2026-07-15) |
| `npm run test:assistant` | **302 casos + 27 invariantes** |
| `npm run test:assistant:remote` | 8 sondas contra a IA real; valida o CONTRATO, não o texto |
| `npm run typecheck` / `typecheck:api` | `src/` e a mesma checagem que a Vercel faz |

O corpus roda o orquestrador **real**, não uma reimplementação.

Três arquivos de casos: `cases.ts` (regressão), `cases-critical.ts` (os dez cenários
obrigatórios do briefing, com as frases literais) e `cases-adversarial.ts` (68 casos vindos da
rodada de QA de 28/07 — cada um escrito ANTES da correção do bug que o originou).

> **O que 302/302 NÃO prova.** Na rodada adversarial, **8 dos 17 bugs só apareceram no
> navegador com mensagem real** — o corpus passava 100% enquanto "não gastei 100" ainda
> propunha registrar a despesa. O corpus cobre bem o que foi imaginado; teste manual com
> linguagem torta continua sendo necessário antes de cada entrega.

---

## 6. Pendências e limitações conhecidas

Estado em 28/07/2026, depois da rodada de QA adversarial. Nada aqui é surpresa: tudo foi
testado, reproduzido e deixado de fora conscientemente.

### 6.1 Pendências que precisam de tratamento (ordem de prioridade)

1. **Data futura é ignorada em silêncio — corrigir.**
   `gastei 40 em 10/08` (com hoje em julho) reconhece a data, classifica como futura e
   simplesmente **não data o lançamento**, gravando como hoje sem avisar. O comportamento certo é
   perguntar ("essa data ainda não chegou — foi 10/08 do ano passado ou é uma previsão?") ou
   recusar explicitamente. Silêncio aqui grava a data errada.
   Vale para `findDate()` → `kind: 'future'`, hoje descartado em `analyzeMessage`.

2. **"daqui a X dias/semanas/meses" precisa de tratamento seguro.**
   `daqui a 3 dias vou pagar 200` hoje não gera ação nenhuma — o que é o resultado seguro, mas o
   usuário recebe o texto de ajuda genérico e não entende por quê. Precisa de uma das duas
   saídas: virar recorrente/previsão explícita, ou dizer com todas as letras que ainda não sabe
   agendar. **Nunca** pode virar lançamento de hoje.

3. **A DeepSeek devolve resposta vazia de forma intermitente.**
   `npm run test:assistant:remote` oscila entre 6/8 e 8/8 entre execuções, com
   `empty-reply` → HTTP 502 em sondas diferentes a cada rodada. O app trata: erro seguro e
   fallback local, sem nunca perder ação. Mas o usuário perde a resposta aberta. Investigar
   `max_tokens`, o retry único de `callDeepSeekChat` e a possibilidade de um segundo modelo.

### 6.2 Fora do escopo por decisão (documentado, não esquecido)

4. **Editar um lançamento já salvo por conversa.** "O mercado de ontem foi 80, não 100" é
   entendido como correção apenas enquanto a proposta está na tela. Depois de gravado, a edição é
   pela tela de Movimentações. Exigiria uma ação de edição auditável no store — ampliar o escopo
   sem autorização seria pior que a limitação.
5. **"Desfaz o último" depois da gravação.** O `assistantBatchId` já é gravado em cada
   lançamento e torna isso viável, mas o fluxo de remoção com confirmação não foi feito.
6. **`Analytics.tsx` por perfil.** Continua mostrando a mesma estrutura para motorista e
   não-motorista. Pendência antiga, anterior a esta reformulação.

### 6.3 Limitações menores

7. **Números por extenso**: "meio" ("dois e meio") não é interpretado. Reais + centavos falados
   ("quarenta e nove e noventa") funcionam desde 28/07.
8. **Datas**: intervalos ("de 1 a 5 de julho") não são interpretados; período ("semana passada")
   serve para pergunta, não para datar um lançamento. "segunda passada" resolve para a
   segunda-feira mais recente, não a da semana anterior — a data interpretada é sempre exibida
   antes da confirmação.
9. **Uma origem por cláusula** quando não é possível localizar o valor no texto para parear por
   proximidade.
10. **A proposta pendente não vai no payload remoto.** Investigado na rodada adversarial: nos
    fluxos multiturno reais o rascunho local resolve sozinho e a IA remota nem é chamada. Nenhum
    caso de falha foi encontrado, então o `draftSummary` **não** foi implementado — enviar dado a
    mais sem problema demonstrado seria o contrário do que a arquitetura pede.
11. **A qualidade do texto da IA remota não é testada** — só o contrato. Um modelo que responda
    algo educado e inútil passa nos testes.
12. **`type: 'saving'` continua fora do saldo**, como a regra 20 manda. A reformulação **não**
    mudou contabilização nenhuma, de propósito.

A matriz caso a caso está em [AI_REGRESSION_MATRIX.md](AI_REGRESSION_MATRIX.md).
