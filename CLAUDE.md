# AssistFin — Guia do Projeto

## Objetivo

App mobile-first (React + Vite + Capacitor) de gestão financeira pessoal com assistente em
linguagem natural (pt-BR). Um único código-base atende **quatro perfis de usuário** diferentes,
cada um com sua própria experiência de tela inicial, metas, configurações e comportamento de IA.

> "Eu cuido dos seus números enquanto você cuida da sua rotina."

## Perfis existentes

`state.settings.profile: 'driver' | 'autonomo' | 'clt' | 'business' | 'other'`

O onboarding hoje oferece só 4 opções (a 5ª, `'business'`, é valor legado que pode existir em
dados antigos — trate-o como não-motorista, igual a `'other'`):

| Perfil | Quem é | O que vê |
|---|---|---|
| `driver` | Motorista de aplicativo (Uber/99) | Meta diária, km, viagens, veículo, combustível, manutenção, analisador de corrida, taxa da 99 |
| `autonomo` | Renda própria — aluguéis, serviços, vendas, comissões (**não é só "dono de imóvel"**) | Meta mensal para guardar, entradas recorrentes, previsão do mês |
| `clt` | Salário fixo | Igual ao autônomo, sem dias de trabalho configuráveis |
| `other` | Genérico | Igual ao autônomo, linguagem neutra |

`src/services/profile.ts` é a **fonte única de verdade** sobre regras de perfil — todo o resto do
código consulta essas funções em vez de comparar `profile === 'driver'` inline:

- `isDriver(settings)` — único perfil com km/veículo/combustível/99/meta diária.
- `shouldAsk99Fee(state, action)` — as 4 condições obrigatórias da taxa da 99 (ver regra abaixo).
- `can99FeeApply(settings)` — proteção de segundo nível no store.
- `defaultIncomeCategory(settings)` — categoria padrão de receita por perfil.
- `MENTIONS_99` — regex de menção **explícita** à plataforma 99 (não casa com "recebi 99 reais").
- `findPossibleDuplicate(state, action)` — aviso de lançamento parecido (não bloqueia).

## Regras obrigatórias por perfil (não podem ser quebradas)

1. **Taxa da 99**: existe *somente* quando `perfil === 'driver'` **E** a receita é da categoria
   `corridas` **OU** o usuário menciona a plataforma explicitamente. Nunca em aluguel, salário,
   venda, freelance. Nunca em outro perfil, mesmo que a receita seja de corridas.
2. **Motorista preservado**: o perfil `driver` já está redondo — não perca funcionalidade nem
   mude a experiência dele "de graça" ao mexer em outro perfil.
3. **Não-motorista nunca vê**: custos do veículo, km, viagens, combustível, manutenção,
   analisador de corrida ("vale a pena?"), configurações da 99, meta diária.
4. **Meta diária vs. meta mensal**: motorista tem meta diária (`dailyGoal()` em `calc.ts`).
   Os outros três perfis têm "meta mensal para guardar" (`monthlySavingGoal()`), que reaproveita
   o mesmo campo `settings.monthlyProfitTarget` com significado diferente na UI.
5. **Resultado líquido ≠ dinheiro guardado**. Líquido = entradas − despesas do mês
   (`monthStats()`). Guardado = soma de transações `type: 'saving'` no mês (`savedThisMonth()`).
   Nunca apresentar um como se fosse o outro.
6. **Trocar de perfil não reinterpreta o passado**. Toda transação carrega
   `profileAtCreation?: ProfileId` opcional — histórico é somente leitura quanto a perfil/regras.
7. **Recorrentes nunca lançam sozinhas**. `pendingRecurrings()` só *pergunta*; o registro só
   acontece após o usuário confirmar (ver `PendingRecurrings.tsx`). `handledMonths` no
   `RecurringExpense` é o que evita duplicar no mesmo mês.
8. **IA nunca registra sem confirmação**. Toda ação da IA (local ou remota) vira um botão
   Confirmar/Cancelar no chat — nunca é aplicada direto.
9. **Segredos nunca no frontend**. `DEEPSEEK_API_KEY` só existe em `.env` (dev, git-ignored) e
   nas env vars do Vercel (produção) — nunca no bundle do cliente. Ver seção de arquitetura.
10. **Cartão nunca é contado duas vezes**. Compra parcelada e parcelamento **não criam
    `Transaction`** — vivem em `installmentPlans` + `installments`. O histórico da compra é o
    valor **total** (no plano); o fluxo de caixa mensal são as **parcelas que vencem no mês**
    (`Installment.dueDate`). Nunca some os dois. Pagar a fatura (`CardPayment`) quita a dívida e
    reduz `settings.balance`, mas **não gera despesa** — ela já foi contada como parcela.
    Consequência desejada: `periodStats`/`monthStats` continuam idênticos para quem não usa
    cartões. Ver `src/services/cards.ts`.
11. **Entrada financiada não é receita**. Dinheiro recebido em troca de dívida no cartão usa
    `TxType: 'financed-cash-inflow'` — **nunca** `'income'`. Todos os somatórios filtram
    `type === 'income'` explicitamente, então ele fica fora de receita/lucro/faturamento por
    construção. A UI precisa deixar claro que o patrimônio líquido não aumentou.
12. **Um único parser monetário**. `parseMoney()` em `src/utils/format.ts` é o ÚNICO conversor
    de dinheiro do app — formulários, telas, `nlp.ts` e IA local sempre delegam a ele. Nunca
    escrever `parseFloat(x.replace(...))` em outro arquivo: foi exatamente isso que fazia
    `100.000` virar `100`. Entrada inválida devolve **NaN**, nunca `0` silencioso. Formatação
    (`formatMoneyInput`) só acontece no **blur** — formatar durante a digitação move o cursor.
    Campo de dinheiro na UI = `<MoneyInput>` (`components/ui.tsx`).
13. **Sentence case em toda a interface**. Só a primeira palavra de títulos, botões e frases
    leva maiúscula ("Novo cartão", "Mostrar arquivados", "Vence em 10 dias"). Nada de title
    case artificial nem de ação começando em minúscula. Abreviações convencionais mantêm a
    grafia normal do pt-BR (`dd/mm/aaaa`, `(opcional)`). Texto digitado pelo usuário é
    capitalizado só na **exibição**, via `sentenceCase()` (`src/utils/text.ts`), que preserva
    `GNV` e `iPhone` — o valor armazenado nunca é reescrito.
14. **Meta duplicada nunca é atualizada em silêncio**. A ação `kind: 'goal'` SEMPRE cria meta
    nova; alterar uma existente é `kind: 'goal-update'`. Nome equivalente (ignorando caixa,
    acento e espaços — `sameName()`) gera confirmação com três saídas: criar mesmo assim,
    editar a existente, cancelar. Vale para onboarding, `GoalForm`, FAB, tela de Metas e IA.
    Mesma regra para cartões (`findCardByExactName`).
15. **Recorrente não nasce atrasada**. Ao cadastrar uma conta cujo dia já passou no mês
    corrente, a primeira ocorrência é a do mês seguinte, gravada em `startDate` — incluir a
    ocorrência deste mês é uma escolha explícita do usuário, nunca presunção. Toda data de
    recorrente sai de `occurrenceInMonth()` (`calc.ts`), que respeita o último dia real do mês
    (dia 31 em fevereiro → 28/29, nunca o dia 28 forçado). O texto de vencimento vem de
    `dueLabel()` e **jamais** escreve "vence hoje" para uma data passada.
16. **Reset apaga storage e estado pelo mesmo caminho**. `resetAllData()` (`store.tsx`) é a
    única operação de apagar tudo — usada pelo botão das Configurações e pelo comando
    confirmado da IA. Ela cancela a gravação debounced pendente, remove **somente** a chave
    `assistfin-state-v1` (nunca `localStorage.clear()`, que afetaria outros apps do domínio) e
    só então restaura o estado inicial. Confirmação destrutiva usa `<ConfirmDialog>`, não
    `window.confirm` — que é bloqueado em parte dos WebViews do Android.
17. **Lista curta, detalhe sob demanda**. A listagem de movimentações mostra só descrição,
    categoria, horário e valor. Ações destrutivas não ficam visíveis em cada linha: o toque
    abre a folha de detalhes, onde ficam origem, pagamento, observação, perfil na criação e a
    remoção (com confirmação + "Desfazer" no toast).
18. **Previsão nunca altera o saldo real**. Cadastrar salário, aluguel, conta, parcela ou
    assinatura cria apenas uma PREVISÃO: não gera movimentação, não mexe no saldo, não conta
    como entrada do mês e não influencia a meta. Previsão só aparece em "entradas/saídas
    previstas", calendário, projeções e saldo estimado.
19. **Entrada recorrente só vira saldo depois de confirmada**. O usuário confirma o
    recebimento (no card de pendências ou já no cadastro, quando a data atual ou passada faz a
    pergunta ser útil) e só então nasce a `Transaction` realizada. A chave única
    `recurringId` + `occurrenceDate` — espelhada em `RecurringExpense.occurrences` — é o que
    impede confirmar duas vezes o mesmo período. Ocorrência resolvida sai automaticamente das
    listas de previsto, para nada ser contado como realizado e previsto ao mesmo tempo.
20. **Saldo em conta tem fonte única**: `currentBalance(state)` em `calc.ts`. Nenhuma tela
    calcula saldo por conta própria e nenhum reducer soma/subtrai `settings.balance` — esse
    campo é só a ÂNCORA informada pelo usuário (`balance` + `balanceAsOf`), e o saldo de hoje é
    a âncora mais as movimentações realizadas depois dela (receitas, despesas, entrada
    financiada e fatura paga com "descontar do saldo"). `type: 'saving'` fica de fora por
    decisão de projeto — a reserva não é necessariamente outra conta.
21. **Meta alcançada = dinheiro realmente guardado**. "Meta mensal alcançada" só aparece quando
    `saved >= target` (transferências `type:'saving'`). Ter sobra suficiente **não** é ter
    guardado: nesse caso a mensagem é "há valor disponível para cumprir sua meta", e o
    percentual de disponibilidade é rotulado "% do valor necessário está disponível", nunca
    "% da meta". Resultado positivo do mês chama-se **Sobra do mês**; negativo, **Déficit do
    mês** — nunca "sobra" para uma previsão.
22. **Recorrência é calculada a partir da data inicial**. `startDate` é a âncora da sequência:
    com intervalo em dias/semanas as próximas datas saem por soma real (15 dias = 15 dias
    corridos, nunca "duas vezes por mês"). Frequência = `interval` + `intervalUnit`
    (`day|week|month|year`); `frequency` é legado e só alimenta o fallback documentado em
    `recurrenceAnchor()`. Em meses curtos o DIA ORIGINAL é preservado e só reduzido ao último
    dia daquele mês (31/01 a cada 2 meses → 31/03, 31/05, 30/09, 31/01) — nunca degrada
    permanentemente para 28. Tudo sai de `occurrencesBetween()` em `calc.ts`.
23. **Dia da semana nunca aparece como número**. `0`, `1`, `2` são detalhe do JavaScript. A
    interface usa `weekdayName`/`weekdayShort`/`weekdayList` (`src/utils/text.ts`) e a frase
    pronta de `describeRecurrence()` ("Toda segunda-feira", "A cada 2 semanas, às
    segundas-feiras", "A cada 15 dias").

## Arquitetura e tecnologias

- **Frontend**: React 18 + TypeScript + Vite 5 + React Router (`HashRouter`) — SPA, sem SSR.
- **Estado**: `useReducer` + Context em `src/store/store.tsx`, persistido em `localStorage`
  (chave `assistfin-state-v1`) com debounce de 150ms. Não há backend de dados — tudo é
  offline-first no dispositivo.
- **Mobile**: Capacitor 8 empacota o build web como app Android nativo (pasta `android/`).
  Plugin `@capacitor/local-notifications` para avisos de contas a vencer.
- **IA**: dois motores.
  - **Local** (`src/services/nlp.ts` + `src/services/ai.ts`): parser determinístico em pt-BR
    para registros de dinheiro, e um roteador de perguntas frequentes que responde direto do
    estado (`resolveLocal()` em `ai.ts`). Funciona 100% offline. Perguntas cujo `handled: true`
    **nunca** vão pra IA remota — são sempre respondidas localmente, na hora, sem erro possível.
  - **Remota** (DeepSeek): usada só para perguntas abertas que o motor local não sabe responder,
    e só se `settings.remoteAi !== false`. Dois endpoints expõem a mesma lógica, ambos rodando em
    Node e importando o mesmo módulo server-only `api/_lib/deepseek.ts` (config + chamada HTTP
    centralizadas — modelo, base URL, timeout e chave só existem ali, com fallback seguro pra
    `deepseek-v4-flash`):
    - `vite.config.ts` (middleware do dev server, plugin `aiProxy()`) — usado em `npm run dev`.
    - `api/ai/chat.ts` (Vercel Serverless Function) — usado em produção/APK, chamado via
      `VITE_AI_API_URL` (`.env.production`, hoje `https://assist-fin.vercel.app/api/ai/chat`).
    - O que **continua** duplicado manualmente entre os dois arquivos (fora do módulo
      compartilhado): a `SYSTEM_PROMPT` — regras de perfil/categorias. Editar uma sem editar a
      outra cria divergência dev×produção (ver `PROGRESS.md`, já há uma divergência conhecida de
      `saving`/`origin`).
    - A chave nunca chega ao cliente: o frontend só faz `POST` para `/api/ai/chat` com um
      **contexto agregado** (nunca a lista bruta de transações) — ver `buildAiContext()`.
    - Variáveis de ambiente (server-only, sem prefixo `VITE_`, nunca em `src/**`):
      `DEEPSEEK_API_KEY` (obrigatória), `DEEPSEEK_MODEL` (opcional, default `deepseek-v4-flash`),
      `DEEPSEEK_BASE_URL` (opcional, default `https://api.deepseek.com`). Ver `.env.example`.
- **Backend de dados**: nenhum. Sincronização em nuvem é integração pendente.

## Comandos

```bash
npm install                 # instalar dependências
npm run dev                 # http://localhost:5199 (servidor de dev + proxy de IA local)
npm run build                # tsc -b --noCheck && vite build → dist/
node node_modules/typescript/bin/tsc --noEmit   # checagem de tipos ESTRITA (o build usa --noCheck e mascara erros)
```

Gerar o APK (depois de `npm run build`):
```bash
npx cap sync android
cd android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew.bat assembleDebug
# APK em android/app/build/outputs/apk/debug/app-debug.apk
```

Nesta máquina o `cmd.exe` não existe em `System32` — alternativa direta ao `npm run dev`:
`node node_modules/vite/bin/vite.js`.

Redeploy do backend de IA em produção (depois de editar `api/ai/chat.ts`):
```bash
npx vercel --prod
```
**Importante**: `vite.config.ts` (dev) e `api/ai/chat.ts` (produção) têm prompts de sistema
independentes — editar um sem editar o outro cria divergência entre dev e produção. Depois de
editar `api/ai/chat.ts`, sempre redeployar com `npx vercel --prod`, senão a mudança fica só local.

## Padrões de código e decisões arquiteturais

- **Sem comentários óbvios**: só comenta o que não é óbvio pelo nome (regra de negócio,
  invariante escondido, decisão não intuitiva).
- **Categorias "arquivadas"** (`Category.archived`): somem dos seletores de formulário, mas o
  histórico de transações que já usa aquela categoria continua funcionando — nunca apagar
  categoria de verdade enquanto houver uso.
- **`origin` opcional** em transações/recorrentes: fonte informada pelo usuário ("Casa 1",
  "Cliente João"). A IA (local ou remota) **nunca deve inferir** origem sem o usuário dizer —
  regra explícita nos prompts e no parser local.
- **`type: 'saving'`** em `Transaction`: transferência para reserva/investimento. Não é receita
  nem despesa — só existe para calcular `savedThisMonth()`.
- **Perguntas factuais são sempre locais**: qualquer pergunta que o app consiga responder com
  certeza a partir do próprio estado (meta, saldo, custo/km, etc.) é respondida por
  `resolveLocal()`, nunca pela IA remota — isso elimina a classe inteira de "a IA respondeu
  errado/desatualizado" para esses casos.

## Arquivos e módulos mais importantes

| Arquivo | Responsabilidade |
|---|---|
| `src/services/profile.ts` | Regras de perfil e ritmo das metas (`goalCadenceOf`) — ler antes de mexer em qualquer feature perfil-dependente |
| `src/utils/format.ts` | `parseMoney`/`formatMoneyInput` (regra 12), datas de calendário (`dateForDayOfMonth`) e `dueLabel` (regra 15) |
| `src/utils/text.ts` | `sentenceCase` (regra 13) e `normalizeName`/`sameName` (regra 14) |
| `src/services/calc.ts` | Todo cálculo financeiro (meta diária, meta mensal, previsão, custo/km, déficits, pendências de recorrentes) |
| `src/services/nlp.ts` | Parser de linguagem natural pt-BR (determinístico, offline) |
| `src/services/ai.ts` | Motor de respostas local + contexto/sanitização da IA remota |
| `src/store/store.tsx` | Estado global, reducer, persistência, `applyParsedAction` (aplica ações confirmadas) |
| `src/models/types.ts` | Todos os tipos — checar aqui antes de assumir a forma de um objeto |
| `src/screens/Home.tsx` | Tela inicial — bifurca inteiramente por `isDriver()` |
| `src/screens/Chat.tsx` | Assistente — roteamento local vs. remoto, confirmação de ações, aviso de duplicidade |
| `src/components/PendingRecurrings.tsx` | Card de confirmação de entrada/conta recorrente |
| `src/services/cards.ts` | Cartões, faturas, parcelas e limites — ler antes de mexer em qualquer coisa de crédito (regras 10 e 11) |
| `src/screens/Cards.tsx` | Área "Cartões e parcelamentos" (visão geral, cartões, parcelamentos, projeções) |
| `api/_lib/deepseek.ts` | Config e chamada centralizadas da DeepSeek (modelo/baseURL/timeout/chave) — server-only, nunca importar em `src/**` |
| `vite.config.ts` / `api/ai/chat.ts` | Os dois backends de IA (dev e produção) — usam `api/_lib/deepseek.ts` para a chamada; a `SYSTEM_PROMPT` ainda precisa ser sincronizada manualmente entre os dois |

## localStorage, migração e compatibilidade

- Categorias padrão novas chegam a quem já usa o app por **fusão**, não substituição:
  `mergeDefaultCategories()` (`src/data/categories.ts`) acrescenta só os `id` ausentes,
  preservando personalizadas e o estado "arquivada". Nunca trocar a lista inteira do usuário.
- Chave única: `assistfin-state-v1`. **Nunca existiu uma v2** — todo campo novo em
  `Settings`/`Transaction`/`RecurringExpense`/`Category` deve ser **opcional** (`campo?: tipo`)
  para que dados salvos antes da mudança continuem carregando sem erro.
  Exemplos já seguidos: `profileAtCreation?`, `origin?`, `archived?`, `remoteAi?`, `kind?`.
- O hidrate em `store.tsx` faz merge raso de `settings` com os defaults
  (`{ ...defaultSettings, ...parsed.settings }`) — um campo novo em `Settings` já nasce com
  fallback automático. Campos novos em outras entidades (transações, recorrentes) **não** têm
  esse merge automático — trate a ausência deles como `undefined`/falsy no código que lê.
- Import de backup (`Settings.tsx`) oferece **Mesclar** (`mergeState`, dedup por `id`) ou
  **Substituir tudo** (`hydrate`) — nunca substituir silenciosamente sem essa escolha.

## Segredos — nunca expor no frontend

- `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` e `DEEPSEEK_BASE_URL` vivem em `.env` (raiz do projeto,
  git-ignored) e nas env vars do projeto na Vercel. **Nunca** referenciar essas variáveis em
  código que roda no navegador/APK (`src/**`) — só em `api/_lib/deepseek.ts` (lido por
  `vite.config.ts` no dev server e por `api/ai/chat.ts` na função serverless, ambos em Node).
  `.env.example` documenta os nomes sem valores reais — sempre atualizar os dois juntos se uma
  variável nova for adicionada.
- Antes de qualquer commit ou build, se mexer nesses dois arquivos, confirmar que a chave não
  foi hardcoded por engano (checar com `grep -rn "sk-" dist/` depois do build).
- `.gitignore` já protege `node_modules/`, `dist/`, `.env`, `.vercel` — mas note a ressalva sobre
  o escopo do repositório Git na seção de infraestrutura do `PROGRESS.md`.
