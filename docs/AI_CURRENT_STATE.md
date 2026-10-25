# Arquitetura do assistente do AssistFin

Arquitetura da Intelligence v2 iniciada em 25/09/2026
(branch `feat/assistant-intelligence-v2`). O checkpoint vigente de 25/10/2026
está no início de [`CONTEXTO.md`](../CONTEXTO.md) e na última seção de
[`PROGRESS.md`](../PROGRESS.md). A implementação original está em
[AI_INTELLIGENCE_V2.md](AI_INTELLIGENCE_V2.md); o código atual inclui correções
posteriores e **não tem aprovação para merge/deploy**.
Contrato do assistente: **versão 1** — deliberadamente NÃO incrementado: nada no
envelope mudou, e a DSL de consulta tem versão própria (`QUERY_DSL_VERSION = 2`).

> A rodada anterior (29/07/2026, `feat/assistant-orchestrator`) trocou o `if` único
> pela orquestração por cláusula. Esta trocou o **teto**: o assistente respondia
> perguntas escritas uma a uma no código e agora monta consultas, simula hipóteses e
> mantém o assunto entre mensagens — sem que nenhum número deixe de nascer local.

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
   │        (só o trecho em aberto; a conversa vai como estrutura, nunca como transcrição)
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
| `src/assistant/journal.ts` | Auditoria por diferença de estado e reversão de lote inteiro |
| `src/assistant/editSaved.ts` | Correção de lançamento salvo: busca local e desambiguação |
| `src/assistant/proposalEdit.ts` | Campos editáveis da proposta, derivados do catálogo |
| `src/assistant/orchestrator.ts` | Orquestração e decisão local × remoto |
| `src/assistant/personalModel.ts` | Constrói o que se sabe do usuário: evidência, confiança, recência, chaves por frase |
| `src/assistant/learning.ts` | Aplica o modelo à proposta — categoria, grafia, aviso de valor |
| `src/assistant/suggestions.ts` | Fileira de sugestões, com a lista educativa por perfil |
| `src/assistant/explain.ts` | Respostas de "por que" e o controle do usuário |
| `src/assistant/driverInsights.ts` | Ritmo do motorista medido no histórico dele |
| `api/_lib/assistantPrompt.ts` | **Fonte única** da SYSTEM_PROMPT (gerada do catálogo) e do sanitizador |
| `api/_lib/assistantHandler.ts` | Pipeline do endpoint, compartilhado pelos dois backends |
| `src/assistant/capabilities.ts` | `buildCapabilities` — sozinho para quebrar o ciclo `ai.ts` ↔ `orchestrator.ts` |
| `src/assistant/query/types.ts` | Vocabulário FECHADO da DSL: 10 fontes, 12 métricas, 13 agrupamentos, campos por fonte |
| `src/assistant/query/validate.ts` | O `validateAction` das consultas — recusa com código próprio, nunca em silêncio |
| `src/assistant/query/period.ts` | Períodos em pt-BR de verdade (substituiu as SEIS frases de `periodFromText`) |
| `src/assistant/query/engine.ts` | Executor somente leitura: filtra, agrupa, aplica métrica, produz fatos com proveniência |
| `src/assistant/query/parse.ts` | Planejador composicional: cada reconhecedor CONSOME o trecho que usou |
| `src/assistant/query/answer.ts` | Composição determinística — lidera com a resposta, não com o cálculo |
| `src/assistant/scenario/` | "E se?" sobre CÓPIA projetada do estado, reusando as funções de cartão e projeção |
| `src/assistant/conversation/focus.ts` | Foco em memória e refino de plano no follow-up |
| `src/assistant/drivers/` | Explica mudanças financeiras por fatores reconciliados, local e read-only |
| `src/assistant/semantic/turn.ts` | Blocos do turno (`record`/`query`/`scenario`/…) — a guarda que impede o lançamento de sumir |
| `src/assistant/semantic/evidence.ts` | Evidência por CAMPO, com posto: o usuário ganha do parser, que ganha do histórico, que ganha do remoto |
| `src/assistant/semantic/normalize.ts` | Typo conservador (dicionário fechado), muleta de conversa, "4k", teto de tamanho |
| `src/assistant/semantic/driverDay.ts` | Dia telegráfico do motorista (`hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h`) |
| `src/assistant/grounding.ts` | Barreira aritmética sobre prosa remota — **leia a medição na seção 6 antes de confiar nela** |
| `scripts/probe-redteam.mts` | Imprime 90 respostas em português real, para LEITURA humana |
| `scripts/rubric-assistant.mts` | Classifica cada resposta: PERIGOSA / RUIM / ACEITÁVEL / EXCELENTE |
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
| 9 | Histórico remoto sem proposta pendente | **Resolvido de outro jeito (15/09/2026)** — a transcrição deixou de ir; a conversa vai como estrutura, com os tipos da proposta na tela e sem valor nenhum (regra 61) |
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
| 20 | Testes insuficientes | **Resolvido** — 531 casos + 86 invariantes na época; hoje 562 casos + 75 goldens + metamórfico + fuzz + 119 invariantes + 418 verificações do avaliador |

---

## 5. Testes

| Comando | O que roda |
|---|---|
| `npm test` | núcleo + as cinco camadas abaixo (offline, data fixa) |
| `npm run test:assistant` | **562 casos + 75 goldens novos + metamórfico + fuzz + 119 invariantes + autoteste do avaliador (418)** |
| `npm run test:assistant:remote` | 8 sondas contra a IA real; última execução: **8/8** |
| `npm run probe:redteam` | 90 mensagens em português real, para LEITURA humana |
| `npm run rubric` | classifica cada resposta; sai com código 1 se houver PERIGOSA |
| `npm run typecheck` / `typecheck:api` | `src/` e a mesma checagem que a Vercel faz |

As cinco camadas de `test:assistant`, e o que cada uma pega que a anterior não pegava:

1. **Corpus** (562 casos) — regressão frase a frase, com os textos exatos.
2. **Goldens de consulta, cenário e continuidade** (75) — totais conferidos à mão sobre
   fixtures determinísticas, 14 recusas de plano malformado e 3 ataques de protótipo.
3. **Metamórfico** (4.080 mutações que PRESERVAM o sentido + 3.800 que MUDAM a modalidade,
   semente fixa) — pega o que o corpus não imaginou: "vou gastar 80" registrava, e a muleta
   de conversa trocava o TIPO do lançamento.
4. **Fuzz** (1.416 mensagens hostis, teto de tempo relativo à máquina) — achou o `__proto__`
   que derrubava o parser e o tempo quadrático em mensagem gigante.
5. **Invariantes** (119) — 86 financeiras, 21 do copiloto e 12 do canal remoto
   (roteamento local × remoto e privacidade do que sai do aparelho).

O corpus roda o orquestrador **real**, não uma reimplementação.

### As invariantes que mais valem, e por quê

- **105 — consulta e `calc.ts` somam igual.** Dois caminhos calculam o mesmo dinheiro;
  cada um está certo sozinho, e nenhum teste de caso pegaria a divergência. Verificada por
  mutação: cortar a receita pela metade em `calc.ts` produz 14 divergências nomeadas.
- **106 — a barreira de grounding tem força MEDIDA** (ver 6.5), não alegada.
- **87–89 — consulta e cenário não escrevem.** Confirmadas por mutação: o teste acusa em
  três lugares quando o motor de cenário escreve uma linha no estado.
- **104 — nenhum caractere de controle no fonte versionado.** O projeto perdeu tempo duas
  vezes com um backspace no lugar de um `\b` de regex.

Dez arquivos de casos: `cases.ts` (regressão), `cases-critical.ts` (os dez cenários
obrigatórios do briefing, com as frases literais), `cases-adversarial.ts` (casos vindos da
rodada de QA de 28/07 — cada um escrito ANTES da correção do bug que o originou),
`cases-temporal.ts` (data futura, inválida, período, correção e frase mista),
`cases-undo.ts`, `cases-edit.ts`, `cases-fala-real.ts`, `cases-registro-real.ts`,
`cases-adaptativo.ts` e `cases-roteamento.ts` (período, meta e magnitude que o motor local
lia errado e, por isso, nunca deixava o remoto ler).

> **O que 562/562 NÃO prova.** Na rodada adversarial, **8 dos 17 bugs só apareceram no
> navegador com mensagem real** — o corpus passava 100% enquanto "não gastei 100" ainda
> propunha registrar a despesa. Nas seis rodadas de limite a proporção se repetiu: nove
> defeitos encontrados FORA do corpus, três deles só ao LER a resposta. O corpus cobre bem o
> que foi imaginado; teste manual com linguagem torta continua sendo necessário antes de cada
> entrega (regra 35 do CLAUDE.md).

---

## 6. Pendências e limitações conhecidas

Estado em 29/07/2026. Nada aqui é surpresa: tudo foi testado, reproduzido e deixado de fora
conscientemente.

### 6.1 Resolvido em 29/07: tempo e indisponibilidade remota

1. **Data futura nunca vira fato realizado.** Uma data explícita futura pergunta se o usuário
   quis dizer a última ocorrência daquele dia ou se é planejamento. Verbo passado + prazo futuro
   pergunta se já aconteceu ou se é plano. Intenção claramente futura apenas explica que o app
   ainda não agenda e não cria `Transaction`.
2. **Expressões relativas e imprecisas falham de modo seguro.** Funcionam `daqui a/em X
   dias|semanas|meses|anos`, `amanhã`, `depois de amanhã`, `próxima semana`, `semana que vem`,
   `mês/ano que vem` e dia da semana `que vem`. Sinais sem dia único (`em agosto`, `há 3 dias`,
   `3 dias atrás`, `fim do mês`, `ano passado`) interrompem o lançamento e pedem a data exata.
3. **Data inválida ou fora do período mantém a pergunta aberta.** `31/02`, `40/08`, `dia 40` e
   uma data completa fora da janela nunca são reduzidos a um número nem reinterpretados em outro
   mês. A correção curta reaproveita valor, categoria e descrição da proposta original.
4. **Período passado não cai em hoje.** `mês passado` e `semana passada` pedem o dia; a resposta
   só é aceita dentro da janela citada.
5. **DeepSeek vazia/502 auditada offline e ao vivo.** Conteúdo vazio faz no máximo uma segunda
   tentativa (duas chamadas no total); HTTP 5xx, 429, 401 e 402 não repetem. Falha nunca cria
   ação, nunca vaza corpo, chave, URL ou modelo. A ação local de uma mensagem mista sobrevive; se
   a pergunta dependia só do remoto, o usuário recebe uma mensagem clara de indisponibilidade.
   Nenhum retry novo foi adicionado.
6. **Fiação real do chat corrigida.** `Chat.tsx` agora devolve `pendingClarification` ao
   orquestrador. Os botões de data/plano funcionam no navegador e “Confirmar?” nunca aparece sem
   uma ação e um botão correspondentes.

### 6.1b Resolvido em 29/07 (segunda rodada): auditoria, edição, undo e correção

1. **Auditoria completa e reversível.** `AppState.assistantJournal` guarda, por lote,
   `batchId`, versão do contrato, motor, `createdAt` completo, perfil na criação e o **ID**
   da mensagem de origem — nunca o texto da conversa. As operações vêm da DIFERENÇA entre o
   estado antes e depois, então cobrem entidade criada, alterada e apagada, inclusive
   depósito em meta, pagamento de fatura e substituição de peça na manutenção.
2. **Edição da proposta completa e validada.** Os controles saem do catálogo (nada de lista
   escrita à mão que envelhece) e toda edição passa por `validateAction()`, com erro
   específico no formulário. `future-date` continua valendo; `firstDueDate` é exceção.
3. **"Desfaz o último".** Reverte o último lote INTEIRO pelo journal, depois de listar o que
   sai e receber confirmação. Lote sem journal é recusado com explicação; desfazer marca
   `undoneAt` e não vira lote novo, então não existe duplo undo nem redo acidental.
4. **Corrigir lançamento já salvo.** `Transaction` simples e ocorrência recorrente
   materializada, busca **local**, desambiguação quando há mais de um candidato, antes→depois
   à vista e confirmação. O tipo nunca muda. Editar a ocorrência não mexe no template nem a
   libera; desfazer o lote libera.

### 6.2 Fora do escopo por decisão (documentado, não esquecido)

1. **Editar por conversa a ESTRUTURA de parcelamento, cartão, meta, abastecimento, trabalho,
   manutenção e template de recorrência.** O assistente recusa e diz qual tela corrige. Uma
   `Transaction` que é a ponta de uma dessas estruturas (entrada financiada, espelho de
   abastecimento ou manutenção) entra na mesma recusa.
2. **`Analytics.tsx` por perfil.** Continua mostrando a mesma estrutura para motorista e
   não-motorista. Pendência antiga, anterior a esta reformulação.

### 6.3 Limitações menores

1. **Números por extenso**: "meio" ("dois e meio") não é interpretado. Reais + centavos falados
   ("quarenta e nove e noventa") funcionam desde 28/07.
2. **Datas**: intervalos ("de 1 a 5 de julho") ainda não viram intervalo estruturado; o app pede
   esclarecimento em vez de gravar em hoje. "segunda passada" resolve para a segunda-feira mais
   recente, não a da semana anterior — a data interpretada é sempre exibida antes da confirmação.
   Linguagem temporal inteiramente nova, fora das regras e dos sinais de segurança conhecidos,
   ainda pode não ser reconhecida; este é o risco residual honesto de qualquer parser
   determinístico, mas as formas comuns auditadas nesta rodada falham fechadas.
3. **Uma origem por cláusula** quando não é possível localizar o valor no texto para parear por
   proximidade.
4. **A proposta pendente não vai no payload remoto.** Investigado na rodada adversarial: nos
    fluxos multiturno reais o rascunho local resolve sozinho e a IA remota nem é chamada. Nenhum
    caso de falha foi encontrado, então o `draftSummary` **não** foi implementado — enviar dado a
    mais sem problema demonstrado seria o contrário do que a arquitetura pede.
5. **A qualidade do texto da IA remota não é testada** — só o contrato. Um modelo que responda
    algo educado e inútil passa nos testes.
6. **`type: 'saving'` continua fora do saldo**, como a regra 20 manda. A reformulação **não**
    mudou contabilização nenhuma, de propósito.

---

### 6.4 O que a rodada do copiloto (25/08/2026) resolveu

1. **Consulta arbitrária.** `periodFromText()` conhecia SEIS frases e caía em "últimos 7 dias"
   para todo o resto — "quanto gastei em obra nos últimos 3 meses?" era respondido com o total
   de uma SEMANA, apresentado como dado real. Substituído por uma DSL fechada, validada e
   executada localmente. `resolveLocal()` continua dono do que já respondia bem: a DSL só toma
   a frente quando o plano usa algo que ele comprovadamente não expressa (`beyondLegacy`).
2. **Hipótese sem gravar.** `clauses.ts` já descartava a ação de "se eu gastar 500" — o que
   faltava era o outro lado: o usuário ficava com o texto genérico de ajuda apesar de o app
   saber simular compra parcelada e projeção desde sempre.
3. **Follow-up de verdade.** "E mês passado?" troca o período e MANTÉM o filtro. Também
   funcionam "e no Nubank?", "e em 12x?", "qual foi pior", "tirando cimento", "e o outro".
4. **Evidência por campo.** O que o usuário disse nesta mensagem nunca é sobrescrito pelo
   parser, que nunca é sobrescrito pelo histórico, que nunca é sobrescrito pelo remoto.
5. **Typo conservador.** Dicionário FECHADO, nunca perto de dígito, nunca em nome do usuário,
   empate não corrige. Aceito só quando destrava alguma coisa; falha fechada.
6. **Dia telegráfico do motorista.** `hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h`
   perdia metade do turno.

### 6.5 A limitação mais importante desta rodada: o alcance real do grounding

A barreira aritmética de `grounding.ts` foi **medida**, não estimada. Sorteando 5.000 valores
entre R$ 0 e R$ 5.000 como se fossem números inventados pelo modelo:

| fatos na lista | inventados que passariam |
|---|---|
| 1 | 0,6% |
| 3 | 3,5% |
| 6 | 16,0% |
| 12 | 35,8% |
| contexto agregado inteiro (38 números) | **89,3%** |

O termo que domina é a soma e a diferença entre pares: com números demais, quase todo valor é
a combinação de dois outros. Nenhuma variação das derivações resolve — tirar a razão crua move
10,1% para 10,0%. A **única** alavanca é o tamanho da lista.

Duas consequências, e a segunda é uma decisão de NÃO fazer:

- `MAX_COMPOSE_FACTS = 6` é o teto da composição, e ele falha **fechado**: lista maior é
  recusada inteira, com código próprio.
- A barreira **não** foi ligada ao passo 16 (resposta livre da IA remota), onde o contexto tem
  38 números e ela teria ~11% de eficácia. Ligar ali faria o código alegar uma proteção que não
  existe. Fica registrado aqui, com o número.

### 6.6 Lacunas registradas em 25/08/2026 (reavaliar antes de usar)

1. **O compositor remoto existe e não está ligado.** `askRemoteCompose` está implementado,
   protegido (não envia rótulo vindo de descrição ou origem — regra 44) e limitado pelo teto
   acima, mas nenhuma resposta hoje passa por ele: toda composição é determinística. É
   infraestrutura pronta, não caminho vivo.
2. **Naquela data, o roteamento de modelo (fase 22) não tinha sido feito.**
   A avaliação comparativa e a mudança para `deepseek-v4-pro` foram concluídas
   depois, em 19–25/09; ver [AI_REMOTE_EVAL.md](AI_REMOTE_EVAL.md) §16.
3. **`orchestrate` tem 817 linhas** numa função só (eram 526). Lê-se como pipeline e os passos
   estão numerados na ordem real de execução, mas é o maior candidato a extração da próxima
   rodada.
4. **A qualidade do texto remoto continua sem teste automático** — a rubrica mede as respostas
   LOCAIS. Um modelo educado e inútil ainda passa.

---

### 6.7 Preparação da avaliação dos modelos remotos (13/09/2026; histórico)

Naquele checkpoint, a infraestrutura estava pronta e testada sem rede; **nenhuma chamada paga havia sido feita ainda**. Antes de medir, corrigiu-se o
planejador remoto de consulta, que nunca tinha funcionado (commit `7080edb`, invariante 107). Achados,
configurações, corpus, métricas, privacidade, custo e a lista de defeitos do motor LOCAL encontrados
no caminho estão em [AI_REMOTE_EVAL.md](AI_REMOTE_EVAL.md).

### 6.8 O canal remoto e o roteamento local (15/09/2026; histórico)

**O que saía do aparelho, medido antes da correção.** Numa conversa encadeada como a tela
fazia, com estado-canário, o corpo do chat remoto levava o nome do usuário, a descrição e o
valor de um lançamento e o saldo em conta — pelas respostas LOCAIS anteriores em `history` e
por `nome`/`saldoEmConta` no contexto —, e o servidor repassava tudo à DeepSeek.

| Caminho | Antes | Depois |
|---|---|---|
| Chat — conversa | últimas 8 mensagens, com as respostas locais (até 600 caracteres cada) | estrutura: tipo do último pedido, rótulo de período gerado pelo app, filtros por categoria, cartão e meta, campos que faltam; filtro de texto ou origem só como "existia" |
| Chat — contexto | nome, saldo, contas e entradas previstas com nome e valor, parcelamentos com descrição, projeção com saldo estimado, veículo, manutenções, agregados e categorias | perfil, categorias, nomes de cartão e meta, IDs das categorias mais usadas; agregados só quando o trecho é pergunta ou pedido |
| Chat — mensagem | a frase inteira, mesmo com parte resolvida no aparelho | só o trecho em aberto quando parte foi resolvida |
| Servidor | repassava contexto e histórico como vieram | ignora `history`, aplica lista de campos permitidos ao contexto e só aceita estrutura do vocabulário do usuário na conversa |
| Planejador | perfil, categorias, nomes de cartão e meta, pergunta | igual |
| Compositor | implementado, não ligado | igual |
| Cenário remoto | não existe em produção | igual |

**Roteamento.** Três classes de leitura local errada fechavam a frase e impediam a consulta
local e o remoto de a lerem: número de período lido como valor, "N mil" lido como N, e depósito
em meta lido como despesa. Além das correções de classe, `semantic/confidence.ts` descarta
a ação local suspeita por quatro critérios determinísticos e dá nome à decisão
(`local-high-confidence`, `local-partial`, `local-ambiguous`, `local-suspicious`,
`remote-needed`).

**O que continua em aberto.** Várias frases de registro em fala real ainda são lidas errado no
aparelho (a lista, com o esperado de cada uma, está em `docs/AI_REMOTE_EVAL.md` §10); 11 casos
do corpus de avaliação continuam com rota `local-errada` (eram 27, depois 15; ver §10 de lá) — desde 15/09/2026 eles ficam de fato fora
da bateria paga e da nota dos modelos, porque a elegibilidade passou a ser medida no orquestrador em
vez de lida do rótulo; o planejador remoto continua sem
estado (não recebe o plano anterior); e as mudanças de `api/**` só chegariam ao app publicado com
um redeploy. O redeploy da configuração remota ocorreu em 25/09; a V2 local continua não publicada.

**O que ainda sai do aparelho, e só isto.** No chat: o texto do turno atual (ou só o trecho em
aberto), perfil, IDs e nomes de categoria, nomes de cartão e de meta, os IDs das categorias mais
usadas e a conversa como estrutura; agregados numéricos (totais do mês, metas, orçamentos,
contagem e total de contas previstas, faturas, projeção sem saldo) só quando o trecho em aberto é
pergunta ou pedido. No planejador: perfil, categorias, nomes de cartão e meta e a pergunta. Não é
"privado 100%": o próprio texto que o usuário digita vai, com o que houver nele.

**Checkpoint de 15/09/2026.** O commit `bfd8f83` entrou com dois caracteres de controle literais
num regex de `conversation/remoteContext.ts` (escape convertido na edição), e a invariante 104
falhou no gate seguinte (118/119). Corrigido no commit de checkpoint, com o escape em texto; a
invariante só varre arquivos versionados, e o arquivo ainda não era versionado no gate anterior ao
commit — por isso passou lá.

---

## 7. A camada adaptativa (17/08/2026)

O assistente passou a usar o histórico **confirmado** deste aparelho para decidir melhor.
Nada disso é armazenado: é tudo derivado de `state.transactions`, recalculado sob demanda e
cacheado por identidade do objeto de estado — o reducer devolve um estado novo a cada
mudança, então o cache se invalida sozinho e não existe nada que sobreviva a uma troca de
estado, a um backup importado ou a um reset.

### O que é aprendido

| Coisa | De onde vem | Para que serve |
|---|---|---|
| **Vocabulário** | Categoria que ele deu a cada frase | Preencher categoria vazia; contrariar a lista genérica com evidência forte |
| **Grafia** | Descrição e origem que ele já escreveu | "Ze" e "Zé" não viram dois lugares; "casa 1" e "Casa 1" não viram dois imóveis |
| **Ordem de grandeza** | Valores do mesmo tipo e categoria | Avisar sobre o zero a mais — nunca bloquear |
| **Agregados** | Categorias e lugares mais usados | Sugestões contextuais e explicações |

### A escala de evidência

`none` não é usado; `moderate` só aparece em sugestão e explicação; `strong` preenche um
campo vazio; `overriding` contraria o palpite da lista genérica. O peso de uma ocorrência cai
pela metade a cada 90 dias e nunca abaixo de 15%, e a confiança é medida no histórico inteiro
E na janela de 120 dias — basta uma das leituras convencer.

### O que NUNCA acontece

Registrar sozinho, alterar valor, data ou tipo, criar taxa, escolher cartão, pagar fatura,
desfazer, apagar, mexer no histórico, propor categoria que o usuário não tem ou arquivou,
escolher entre duas entidades ambíguas em silêncio, ou mandar nome de estabelecimento,
cliente, endereço, grafia, journal ou valor para a IA remota.

### Limitações honestas

1. **Perguntas frequentes não alimentam as sugestões.** A fileira só aparece com
   `state.chat` vazio, então não há histórico de perguntas para ler naquele momento. Criar
   um armazenamento separado contradiria a decisão de tudo ser derivado.
2. **O assistente não liga nem desliga o aprendizado por conversa** — ele diz onde fica a
   chave. Mexer em configuração por conversa é a mesma classe de coisa que registrar sem
   confirmar.
3. **Categoria dita e categoria adivinhada são indistinguíveis** na saída do parser: vale a
   decisão de que histórico consistente e forte ganha do palpite genérico.
4. **Erro de digitação no verbo** (`gsatei 60 no merkado`) continua sem registro local.
5. **Na rodada adaptativa de 17/08, o eval comparativo ainda não tinha sido executado.**
   Isso foi superado pela avaliação de 19/09 e pelo deploy de 25/09; ver
   [AI_REMOTE_EVAL.md](AI_REMOTE_EVAL.md) §16.

A matriz caso a caso está em [AI_REGRESSION_MATRIX.md](AI_REGRESSION_MATRIX.md).

**O local sabe que não sabe (18/09/2026).** Dois casos em que o aparelho não responde, e em que o
roteador antigo respondia com número real mesmo assim:

- **consulta incompleta** — o planejador reconheceu a pergunta mas não entendeu um pedaço dela. O
  plano sai com `incompleto` (a sobra), não é executado, e a frase vai ao planejador remoto. Sobra
  feita de vocabulário de pergunta nunca vira filtro de texto; nome de lugar continua sendo busca;
- **hipótese sem simulação** — a pergunta que vem depois de um "e se…", na mesma frase, não é
  respondida localmente; a hipótese não vai ao planejador de CONSULTA remoto, só ao chat; e sem
  remoto o app diz que não sabe simular aquilo.

O motor de cenário ganhou o tipo `cut` ("e se eu parar a obra"): média real dos três meses completos
anteriores daquela categoria, por mês e no horizonte pedido. A hipótese herda a entidade da conversa
("quanto gasto com obra?" → "e se parar?") e "e se…" depois de uma consulta sai do modo consulta.
"Onde vazou", "pra onde foi meu dinheiro" e "o que mais pesou" são ranking por categoria; "maior
mudança" é comparação. O rótulo de mês ("dez/2026") é montado pelo índice do mês, sem depender da
string do ICU.

**O atalho antigo só responde o que ele expressa (18/09/2026, C5).** `alemDoAntigo`
(`query/parse.ts`) é a checagem de capacidade entre o roteador antigo e a consulta. Além de
período, comparação, agrupamento, exclusão e cartão, ela agora cobre: **nome dito na pergunta**
("no Restaurante do Amarelo" — o total antigo não filtra nada e respondia a semana inteira; o hábito
"quanto eu costumo gastar de suco" e as palavras do próprio app, "de cartão", continuam com ele) e as
**contas por unidade** ("por viagem" e "por hora" antigas são fixas em 7 dias, e por viagem é bruto).
A explicação "quantas vezes eu fiz isso" não consome mais a pergunta que já nomeia o lugar. Na
leitura: "no bar" é lugar, não a categoria Lazer; "me pagou" é receita; "parcelas da geladeira" é o
parcelamento daquela compra; "por corrida em média" é por corrida. O período passou a devolver o
trecho que casou (`span`) — antes o rótulo "este mês" não era achado no texto "esse mes", e "no Zé
esse mês" virava a busca "ze esse".

**`null` em campo opcional do contrato remoto é "não especificado" (19/09/2026).** A primeira bateria
paga mostrou os modelos mandando `"order": null` em planos válidos; o validador recusava, e a pergunta
caía no chat. `semNulosOpcionais` (`contracts.ts`) normaliza só os opcionais listados do plano, do
filtro e do envelope do chat antes da validação estrita — obrigatório `null` continua recusado, e
`filter.weekdays: null` não vira mais domingo. Detalhe e auditoria em `docs/AI_REMOTE_EVAL.md` §14.

**O que o usuário disse ganha do que o modelo leu (19/09/2026).** Dois guardas determinísticos que não
dependem do modelo remoto:

- **Modalidade explícita** (`semantic/modality.ts`): plano de consulta remoto que trata como FATO uma
  frase que declara futuro ("vou receber", "vai cair", "amanhã"), negação, retratação ou recorrência não
  é executado — segue para o chat. Consulta sobre o que vai vencer (fatura, projeção) continua respondida.
- **Alegação de execução** (`claims.ts`): no turno da proposta nada foi gravado, então o texto remoto não
  pode dizer "anotei/registrei"; vira "preparei … confirme". Depois do Confirmar, "Registrado!" só com o
  lote gravado.

**Modelo remoto em produção: `deepseek-v4-pro` com pensamento desligado**
(`docs/AI_REMOTE_EVAL.md` §16). O padrão de `api/_lib/deepseek.ts` e o exemplo de ambiente usam essa
configuração, protegida pela invariante 129 inclusive no reenvio. O override legado
`DEEPSEEK_MODEL` foi removido da Vercel, e o deployment `dpl_9T7v31TwTRBWk4Qzxf4y6MWvTBu6` passou
no smoke público de chat, proposta, esclarecimento, planner e composição em 25/09/2026.

**Registro histórico de 01/10/2026.** A branch
`feat/assistant-intelligence-v2` corrigiu C1–C3 e H1–H9 reproduzidos na
primeira auditoria, além de M1–M4 e M6. Os REDs atravessam o orquestrador real;
os gates locais estão verdes, mas **não há veredito READY** até uma segunda
auditoria Astra. Ver
[`AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md`](AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md)
para provas, totais e dívida restante. A frase acima sobre “nunca mandar nome”
se refere ao contexto/histórico estruturado: um **alias aplicado à mensagem
atual** pode levar seu valor substituto ao planejador/chat remoto quando esse
turno usa IA. A lista de preferências não sai como contexto.

**Checkpoint de 24/10/2026.** Três rodadas locais de correção após auditorias
independentes chegaram a `3693a23`, `ff6a6a3` e `c63d6bc`. Há 128/128 casos
adversariais verdes, mas a auditoria seguinte de `c63d6bc` encontrou falhas
financeiras e de linguagem natural ainda fora da cobertura. O veredito é
**NOT READY para merge/deploy**. Não usar o número de testes como substituto
das reproduções independentes. A lista atual e o estado de produção estão no
checkpoint de [`CONTEXTO.md`](../CONTEXTO.md) e na última seção de
[`PROGRESS.md`](../PROGRESS.md); os lotes anteriores estão em
[`AI_INTELLIGENCE_V2_ASTRA_AUDIT_FOLLOWUP_3.md`](AI_INTELLIGENCE_V2_ASTRA_AUDIT_FOLLOWUP_3.md)
e nos dois arquivos de follow-up anteriores.

**Checkpoint de 25/10/2026.** Após `345d55e`, uma nova auditoria Astra
reproduziu oito falhas financeiras/de continuidade e quatro oráculos falsamente
verdes. Os REDs e correções estão na última seção de
[`PROGRESS.md`](../PROGRESS.md): 165/165 casos adversariais verdes, com gates
locais completos. **Ainda NOT READY para merge/deploy** até auditoria
independente do novo diff; produção segue na `main`, sem V2.
