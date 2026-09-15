# Copiloto financeiro semântico — desenho da arquitetura

> Documento de projeto da rodada de 24/08/2026. Escrito **antes** da implementação e
> atualizado ao final com o que a implementação provou. Tudo aqui é sobre o assistente;
> nenhuma regra financeira do `CLAUDE.md` é revista.

---

## 1. Arquitetura atual (o que existe hoje, verificado no código)

```
mensagem
  │
  ├─ orchestrate()                      src/assistant/orchestrator.ts   (1140 linhas)
  │    ├─ 0)  resposta a esclarecimento pendente (opção, data, categoria)
  │    ├─ 1)  resposta a rascunho multiturno            drafts.ts
  │    ├─ 2)  correção da proposta na tela              corrections.ts
  │    ├─ 2a) explicação ("por que essa categoria?")    explain.ts
  │    ├─ 2b) desfazer o último lote                    journal.ts
  │    ├─ 2c) correção de lançamento já salvo           editSaved.ts
  │    ├─ 3)  análise por CLÁUSULA                      clauses.ts → nlp.ts
  │    │       cada cláusula: intent, actions, data, origem, cobertura
  │    ├─ 4)  intenção incompleta vira rascunho
  │    ├─ 5)  perguntas respondidas LOCALMENTE          ai.ts → resolveLocal()
  │    ├─ 6)  IA remota SÓ para o que sobrou            api/ai/chat.ts
  │    └─ 7/8) avisos + texto final
  │
  └─ AssistantResponse v1 → ProposalCard → Confirmar → applyBatchPure() → estado
```

O que já é sólido e **não muda nesta rodada**: catálogo de ações (`ACTION_CATALOG`),
`validateAction()` idêntica no cliente e no servidor, execução atômica e sequencial,
`assistantJournal` derivado por diferença, aprendizado pessoal derivado do histórico
confirmado, prompt de sistema com fonte única e gerado do catálogo, e a regra de que
**nada entra no estado sem o botão Confirmar**.

---

## 2. O teto da arquitetura atual

O gargalo tem nome e endereço: **`resolveLocal()`, em `src/services/ai.ts`**. São ~700
linhas de uma cadeia linear de `if (regex.test(t))`. Cada pergunta nova que o usuário
inventa custa uma regex nova, na posição certa da cadeia, sem quebrar as 25 anteriores.

Cinco limites concretos, todos verificáveis hoje:

1. **Períodos são um conjunto fechado de seis frases.** `periodFromText()` conhece
   `semana passada`, `essa semana`, `mês passado`, `esse mês`, `ontem`, `hoje`. Qualquer
   outra coisa cai no `default` — **"últimos 7 dias"**. Ou seja: *"quanto gastei em obra
   nos últimos 3 meses?"* é respondido com o total de 7 dias, com cara de resposta certa.
   Esse é o pior modo de falha possível: número errado apresentado como dado real.
2. **Não existe agrupamento nem comparação.** Não há como responder "qual categoria
   aumentou mais em relação ao mês passado" — não existe `group by` em lugar nenhum.
3. **Não existe exclusão.** "tirando obra", "sem o Nubank", "e sem cimento" não têm
   representação.
4. **Não existe composição.** Período × categoria × origem × cartão × métrica ×
   agrupamento × comparação é um produto cartesiano; a cadeia de `if` cobre pontos
   isolados dele.
5. **Cada frase é um turno isolado.** "e mês passado?" não tem a que se referir: não há
   memória do que foi perguntado antes.

Fora do `ai.ts`, mais três tetos:

6. **Hipótese não tem motor.** `clauses.ts` remove as ações de qualquer frase com
   `se eu`/`tô pensando` (correto: hipótese não é fato), mas o que sobra é o texto
   genérico de ajuda. O app sabe simular uma compra (`simulatePurchase`, `monthlyProjections`)
   e nunca oferece isso por conversa.
7. **Evidência é por AÇÃO, não por CAMPO.** `AssistantCandidateAction.confidence` é um
   valor só. A reconciliação com o remoto é dedupe por `JSON.stringify` ou por
   `(kind, amount)` — não há como aceitar a *descrição* do remoto mantendo o *valor* que
   o usuário disse explicitamente.
8. **Typo no VERBO mata a interpretação.** `gsatei 190 de cimento` não casa nenhum verbo,
   então não há ação nenhuma — e o resto da frase, que estava perfeito, é perdido junto.

---

## 3. Arquitetura proposta

Uma fronteira dura, dita em uma frase:

> **A parte generativa traz LINGUAGEM. A parte determinística controla DINHEIRO.**

O modelo remoto pode interpretar, planejar consulta, planejar cenário e redigir. Ele
**não** é banco de dados, calculadora, executor nem fonte de verdade. Todo número
financeiro final nasce de código local.

```
mensagem
  │
  ├─ semantic/normalize.ts    tolerância conservadora a typo e fala
  │      dicionário FECHADO (verbos, tempo, unidades, palavras de pergunta)
  │      nunca toca em nome, origem, descrição, cartão, meta ou número
  │
  ├─ clauses.ts               segmentação por cláusula                (já existe)
  │
  ├─ semantic/turn.ts         AssistantTurnPlan — blocos semânticos
  │      record | query | scenario | correction | clarification | conversation | unknown
  │
  ├── record ─────► nlp + learning + validateAction ─► proposta      (já existe)
  │                   ▲
  │                   └─ semantic/evidence.ts  — merge POR CAMPO com hierarquia fixa
  │
  ├── query ──────► query/parse.ts ──► AssistantQueryPlan
  │                        │                    ▲
  │                        │                    └── (fallback) plano vindo do remoto
  │                        ▼
  │                 query/validate.ts   ← o `validateAction` das consultas
  │                        ▼
  │                 query/engine.ts     SOMENTE LEITURA, determinístico
  │                        ▼
  │                 AssistantQueryResult + AssistantFact[]
  │                        ▼
  │                 query/answer.ts     template local  (ou remoto COM grounding)
  │
  ├── scenario ───► scenario/parse.ts ─► AssistantScenarioPlan
  │                        ▼
  │                 scenario/engine.ts  puro, sobre estado PROJETADO
  │                        ▼
  │                 AssistantScenarioResult (sempre marcado SIMULAÇÃO)
  │
  └── conversation/focus.ts   guarda o último plano/resultado para o follow-up
```

### 3.1 Query DSL

Uma estrutura de dados tipada, **nunca uma string**. Sem SQL, sem `eval`, sem função
arbitrária, sem código vindo do modelo.

```ts
interface AssistantQueryPlan {
  version: 2
  source: 'transactions' | 'recurring' | 'installments' | 'invoices'
        | 'plans' | 'goals' | 'work' | 'fuel' | 'maintenance' | 'projections'
  period: QueryPeriod                 // { from, to, label, grain }
  comparePeriod?: QueryPeriod         // é o que responde "comparado com mês passado"
  filter: QueryFilter                 // tipo, categoria, texto, origem, cartão, exclusões…
  metric: 'sum'|'count'|'avg'|'median'|'min'|'max'|'net'|'share'
        | 'per-day'|'per-km'|'per-hour'|'per-trip'|'trend'
  group: 'none'|'category'|'origin'|'card'|'month'|'week'|'day'|'weekday'
       | 'description'|'goal'|'plan'|'platform'
  order?: 'value-desc'|'value-asc'|'date-desc'|'date-asc'|'count-desc'
  limit?: number
}
```

`validateQueryPlan()` é ao plano o que `validateAction()` é à ação: recusa fonte, métrica,
agrupamento e campo fora do vocabulário; limita período, número de grupos e limite;
recusa chave perigosa (`__proto__`, `constructor`, `prototype`); recusa fonte de
motorista em perfil não motorista. **Recusa devolve código, nunca `false` mudo.**

O executor devolve `AssistantQueryResult`, e dele saem `AssistantFact[]`: cada número com
rótulo, unidade, período, quantas linhas o sustentam e se é realizado ou estimado.

### 3.2 Scenario Engine

Somente leitura, puro, sobre uma **cópia projetada** do estado. Nunca `dispatch`, nunca
`localStorage`, nunca journal, nunca `handledMonths`, nunca pagamento real.

A simulação de compra parcelada usa as MESMAS funções da compra real
(`splitInstallmentAmounts`, `nextInvoiceDueDate`, `buildInstallments`,
`monthlyProjections`) sobre o estado projetado. Simulação e realidade não podem divergir
porque são o mesmo código.

Toda resposta de cenário é marcada como **simulação/estimativa** e não cria `Transaction`.

### 3.3 Conversation Focus

Estado conversacional **mínimo, estruturado e em memória** (como os rascunhos: não
sobrevive a reload, de propósito). Guarda o último plano de consulta, o último resultado
resumido, o último cenário e as entidades citadas.

O follow-up é resolvido por REFINAMENTO do plano anterior, não por adivinhação:
troca de período, exclusão, restrição, comparação, explicação. Dois candidatos possíveis
para uma referência → **perguntar**. Chute probabilístico sobre dinheiro é proibido.

### 3.4 Evidência por campo

```ts
interface AssistantFieldEvidence {
  field: string
  value: unknown
  source: 'user-explicit' | 'clarification' | 'local-parser'
        | 'personal-history' | 'remote-model' | 'fallback'
  confidence: 'high' | 'medium' | 'low'
  clauseId?: string
  span?: { start: number; end: number }
}
```

Precedência **fixa** (menor número ganha): 1 `user-explicit`, 2 `clarification`,
3 `local-parser`, 4 `personal-history`, 5 `remote-model`, 6 `fallback`. Um nível inferior
**nunca** sobrescreve um superior em silêncio. Dois níveis fortes em conflito real →
perguntar.

---

## 4. Fluxo de dados

```
     LOCAL (aparelho)                          REMOTO (DeepSeek, server-only)
┌──────────────────────────┐
│ estado completo          │
│ transações, cartões,     │
│ metas, journal, modelo   │        ─ nunca sai ─►  ✗
│ pessoal, grafias         │
└──────────────────────────┘
             │
             ├─ agregados seguros ───────────►  contexto (buildAiContext)
             ├─ schema da Query DSL ─────────►  para o modelo PLANEJAR
             ├─ literais da PRÓPRIA mensagem ►  "Zé da esquina" veio da pergunta
             │
             ◄──────── AssistantQueryPlan / prosa ────────┤
             │
             ▼
    validateQueryPlan() → engine local → fatos reais → grounding → resposta
```

O modelo **nunca recebe** lista de transações, descrições históricas, nomes de
estabelecimento, clientes, journal ou valores individuais do histórico. O que ele
recebe de nome próprio é o que **já estava na mensagem do usuário** — e quem procura
isso no histórico é o executor local.

---

## 5. Fronteiras de privacidade

| Dado | Sai do aparelho? |
|---|---|
| Lançamento individual (valor, data, descrição) | **Nunca** |
| Nome de estabelecimento / cliente / imóvel do histórico | **Nunca** |
| Grafia aprendida | **Nunca** |
| `assistantJournal` | **Nunca** |
| Modelo pessoal (pesos, evidências, frequências) | **Nunca** |
| IDs das categorias mais usadas | Só com `adaptiveAssistant` ligado (já existia) |
| Agregados do mês/semana/hoje | Sim, como já era (`buildAiContext`) |
| Literal digitado NESTA mensagem | Sim — o usuário acabou de escrevê-lo |
| Resultado de consulta (fatos já calculados) | Só quando o remoto for **compor** a frase |

Toda a camada nova — planejar consulta local, executar, compor resposta determinística,
simular cenário, refinar follow-up — **funciona 100% offline**.

---

## 6. Contrato

**Decisão: `ASSISTANT_CONTRACT_VERSION` continua `1`.**

O contrato v1 descreve o **envelope de resposta** (`version`, `mode`, `reply`, `actions`,
`clarification`). Nada disso muda: consulta e cenário são `mode: 'answer'` com zero ações,
que o cliente v1 já entende perfeitamente.

O que é novo (`AssistantTurnPlan`, `AssistantQueryPlan`, `AssistantScenarioPlan`,
`AssistantFieldEvidence`) é **estrutura interna** do cliente, ou campo **opcional** no
canal remoto: um servidor que não conhece `queryPlan` simplesmente não devolve o campo, e
o cliente cai no plano local.

Subir a versão teria um custo concreto e nenhum ganho: o cliente **recusa** resposta com
versão desconhecida (por construção, e é uma boa regra). Como o deploy da Vercel **não
está autorizado nesta rodada**, subir a versão no cliente faria o app rejeitar todas as
respostas do servidor que está no ar. As estruturas novas carregam `version: 2` **delas
mesmas**, independente da versão do envelope — é por elas que um plano vindo de um
servidor futuro é aceito ou recusado.

---

## 7. Estratégia de compatibilidade

- `assistfin-state-v1` intacto. **Nenhum campo novo obrigatório** em nenhuma entidade.
- Nenhuma migração. O foco conversacional é em memória e derivável; os planos de consulta
  e cenário não são persistidos.
- Backup antigo, chat antigo, journal antigo, ações antigas e o perfil legado `business`
  continuam carregando e funcionando.
- `resolveLocal()` **não é apagado**: ele continua dono das perguntas que já respondia
  (e que o corpus de 531 casos assegura). A Query DSL entra onde hoje há o texto genérico
  de ajuda, e é onde toda pergunta nova passa a viver. Um plano de consulta só toma a
  frente de `resolveLocal` quando reconhece algo que ele comprovadamente erra — período
  que `periodFromText` não conhece, agrupamento, comparação ou exclusão.
- Web, Android (Capacitor) e Vercel: nada exigido de novo.

---

## 8. Riscos

| Risco | Mitigação |
|---|---|
| A DSL responder com número errado e cara de certo | Cada resultado carrega amostra e `caveats`; sem dado, `empty: true` e o app **diz** que não sabe |
| O planner local roubar perguntas que `resolveLocal` já respondia bem | Só assume com `confident: true`; o corpus de 531 casos é o árbitro e roda a cada passo |
| O modelo remoto inventar número na prosa | Barreira de **grounding**: valor monetário que não existe nos fatos (nem é derivação autorizada) invalida a composição remota, e a resposta determinística assume |
| O modelo remoto mandar plano hostil | `validateQueryPlan()` com vocabulário fechado; fonte de motorista bloqueada por perfil; sem `eval`, sem chave dinâmica, sem `__proto__` |
| Cenário virar fato | O motor é puro e a saída é texto; nenhuma `ParsedAction` nasce de cenário. Invariante dedicada |
| Autocorreção estragar nome do usuário | Dicionário FECHADO só de vocabulário estrutural; distância baixa; nunca perto de dígito; falha fechada em empate |
| Perder desempenho | Fuzz com baseline medido NESTA máquina, e teto relativo a ele |
| Inchar os monólitos | Módulos novos em `query/`, `scenario/`, `conversation/`, `semantic/` — `ai.ts` e `orchestrator.ts` só ganham fiação |

---

## 9. Plano de migração

1. **Fase 0** baseline executado e documentação corrigida. ✔
2. **Fase 1** este documento.
3. **Fase 2–3** turno semântico e evidência por campo (estrutura, sem mudar decisão).
4. **Fase 4–5** Query DSL: tipos → validação → período → executor → planner → resposta.
5. **Fase 6–8** remoto como planejador; fatos; grounding; compositor.
6. **Fase 9** Scenario Engine.
7. **Fase 10–11** foco conversacional, follow-up e elipse.
8. **Fase 12** tolerância a typo.
9. **Fase 13** arbitragem por campo entre local, histórico e remoto.
10. **Fases 16–20** metamórficos, fuzz, golden cases de query/cenário/continuidade.
11. **Fase 21** infraestrutura de eval semântico — **sem bateria paga sem autorização**.
12. **Fases 23–25** rubrica, red team manual, três revisões independentes.

Cada marco: `npm test` + `typecheck` + `typecheck:api` + `build`. Commit pequeno por
conceito. **Sem push, sem merge, sem deploy, sem APK.**

---

## 10. Como provar que a arquitetura nova é melhor

Não por opinião. Por medida:

1. **Perguntas respondidas sem regra frase a frase.** Contagem de perguntas do catálogo da
   Fase 5 que passam a ser respondidas com número REAL — hoje, sem exceção, elas caem no
   texto genérico de ajuda ou (pior) num período errado.
2. **Zero regressão.** Os 531 casos continuam em 100%, e as invariantes passaram de 86 para 106.
3. **Golden cases de consulta e cenário** com resultado EXATO, não "não quebrou".
4. **Testes metamórficos**: ≥2.000 mutações que preservam sentido e ≥1.000 que o mudam.
   Uma frase que muda de modalidade (negação, futuro, hipótese, pergunta) **não pode**
   produzir o mesmo fato realizado.
5. **Fuzz** sem travar, sem estourar memória e sem ação inesperada, com teto de tempo
   relativo ao baseline medido nesta máquina.
6. **Grounding provado**: uma resposta remota com número inventado é REJEITADA em teste.
7. **Privacidade provada**: invariante que varre o payload remoto atrás de nome de
   estabelecimento, descrição histórica e journal.
8. **Custo do próximo problema.** Uma pergunta nova da mesma classe deve custar um caso de
   teste, não uma regex — e isso é verificável lendo o diff da próxima rodada.

---

## 11. O que esta arquitetura NÃO resolve

Registrado aqui para não virar promessa:

- Não existe benchmark semântico pago executado. A infraestrutura fica pronta
  (`scripts/eval-assistant-models.mts`), mas rodar bateria paga exige autorização.
- O modelo remoto continua sem receber a proposta pendente. Nenhuma falha real justificou.
- Typo em nome próprio continua sem correção — **de propósito**.
- Intervalos temporais muito compostos ("entre o dia 10 do mês passado e o dia 5 deste")
  continuam limitados ao que `query/period.ts` reconhece.
- `Analytics.tsx` por perfil segue como pendência separada, fora desta rodada.

---

## 12. O que a implementação PROVOU (escrito em 25/08/2026, depois de construir)

As seções 1–11 são o desenho. Esta é a correção do desenho pela realidade — as quatro coisas
que só apareceram construindo, e que mudam o que este documento afirmava.

### 12.1 A barreira de grounding é mais fraca do que a seção 3 assumia

O desenho tratava a barreira aritmética como uma proteção binária: número que não se sustenta
nos fatos é rejeitado. A medição desmente o binário. Sorteando 5.000 valores entre R$ 0 e
R$ 5.000 como se fossem números inventados pelo modelo:

| fatos na lista | inventados que passariam |
|---|---|
| 1 | 0,6% |
| 3 | 3,5% |
| 6 | 16,0% |
| 12 | 35,8% |
| contexto agregado inteiro (38 números) | **89,3%** |

O comentário original de `allowedValues` já avisava — "com fatos suficientes, quase todo número
vira uma combinação de outros dois" — mas ninguém tinha transformado o aviso em número. O termo
que domina é a soma e a diferença entre pares; nenhuma variação das derivações resolve (tirar a
razão crua move 10,1% para 10,0%). A **única** alavanca é o tamanho da lista.

Correções no desenho: `MAX_COMPOSE_FACTS = 6`, falhando FECHADO; e a decisão explícita de **não
ligar** a barreira à resposta livre da IA remota, onde ela teria ~11% de eficácia. A seção 10,
item 6, dizia "grounding provado" — a prova existe (invariante 106), mas ela prova um alcance
LIMITADO, e é assim que está escrita.

### 12.2 A guarda que o desenho não previu: fato cala a conversa

A arquitetura proposta punha consulta, cenário e continuação como uma camada nova antes da
análise por cláusula. Ligada assim, ela comeu **nove casos do corpus**: "meu salário caiu hoje
3200" contém "caiu", que é palavra de pergunta; "recebi 1800 da Casa 1, **mais** 1750 da Casa
2" contém "mais". As duas viraram consulta e o lançamento DESAPARECEU.

A guarda — mensagem com bloco `record` não fala pela camada de conversa — não estava no
desenho e é hoje a linha mais importante do passo 11. A única exceção é o cenário, porque
`looksLikeScenario` exige marcador explícito de hipótese, que ninguém escreve sem querer;
graças a ela, "meu salário entrou 1625, paguei 355, guardei 150 e quero saber se consigo
comprar um celular de 3000 em 10x" responde às duas metades.

### 12.3 A DSL não podia simplesmente substituir o roteador antigo

O desenho falava em migrar `resolveLocal()` para a DSL. Feito de forma direta, treze casos
adaptativos regrediram: para as perguntas que ele já respondia, o texto dele é MELHOR e o
corpus assegura essas frases exatas. A solução foi `beyondLegacy` — a DSL só toma a frente
quando o plano usa algo que o roteador comprovadamente não expressa (período dito fora das
seis frases dele, comparação, agrupamento, exclusão, mediana, participação, filtro por
cartão). Convivência, não substituição.

### 12.4 Rubrica e barreira falham do mesmo jeito: alarme demais

A rubrica da fase 23 precisou de três correções antes de servir, todas porque ela acusava as
MELHORES respostas do corpus: simulação com valor não é "valor sem histórico"; "quanto gastei
entre 01/07 e 15/07" é pergunta, não lançamento perdido, apesar do verbo igual; recusa com
motivo é o comportamento certo. É a mesma lição da barreira medida — um mecanismo de segurança
que dispara sem motivo é desligado pelo leitor, e aí não protege mais nada.

### 12.5b Um canal que o desenho não olhou: o histórico (15/09/2026)

A seção 4 dizia que o modelo nunca recebe descrição histórica nem valor individual — e para a
consulta, o cenário e o planejador isso era verdade. O chat remoto, porém, recebia as últimas 8
mensagens da conversa, e as respostas LOCAIS entre elas carregavam exatamente isso ("Foi Areia,
de R$ 460,00"; "Seu saldo em conta é R$ 3.100,00"). A tabela da seção 5 também estava otimista:
o contexto do chat levava o nome do usuário e o saldo. A preparação da avaliação dos modelos
remotos achou o canal; ele foi reproduzido com estado-canário e fechado nas duas pontas (regra
61 do `CLAUDE.md`). A lição é a da seção 12.4 pelo outro lado: a garantia estava escrita sobre
os caminhos que alguém desenhou, e o vazamento morava no caminho que ninguém redesenhou.

### 12.5 O que o desenho acertou e vale repetir

- **Vocabulário fechado.** Nenhum ataque de protótipo, nenhum campo dinâmico, nenhuma injeção
  possível: o plano é construído campo a campo e nada do objeto cru é espalhado.
- **Reuso dos calculadores.** O motor de cenário chama `splitInstallmentAmounts` e
  `nextInvoiceDueDate`; o de consulta chama `monthlyProjections` e `occurrencesBetween`.
  Simulação e realidade não podem divergir porque são o mesmo código — e a invariante 105
  prova que consulta e `calc.ts` também não divergem.
- **Remoto como planejador.** É o papel mais útil e o mais seguro: ele não vê lançamento, não
  calcula e não escreve prosa com número. O plano volta, é validado e roda aqui.
