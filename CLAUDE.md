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
    e só se `settings.remoteAi !== false`. Dois lugares implementam o **mesmo** proxy e devem ser
    mantidos em sincronia manualmente (não há import compartilhado entre eles):
    - `vite.config.ts` (middleware do dev server, plugin `aiProxy()`) — usado em `npm run dev`.
    - `api/ai/chat.ts` (Vercel Serverless Function) — usado em produção/APK, chamado via
      `VITE_AI_API_URL` (`.env.production`, hoje `https://assist-fin.vercel.app/api/ai/chat`).
    - A chave nunca chega ao cliente: o frontend só faz `POST` para `/api/ai/chat` com um
      **contexto agregado** (nunca a lista bruta de transações) — ver `buildAiContext()`.
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
| `src/services/profile.ts` | Regras de perfil — ler antes de mexer em qualquer feature perfil-dependente |
| `src/services/calc.ts` | Todo cálculo financeiro (meta diária, meta mensal, previsão, custo/km, déficits, pendências de recorrentes) |
| `src/services/nlp.ts` | Parser de linguagem natural pt-BR (determinístico, offline) |
| `src/services/ai.ts` | Motor de respostas local + contexto/sanitização da IA remota |
| `src/store/store.tsx` | Estado global, reducer, persistência, `applyParsedAction` (aplica ações confirmadas) |
| `src/models/types.ts` | Todos os tipos — checar aqui antes de assumir a forma de um objeto |
| `src/screens/Home.tsx` | Tela inicial — bifurca inteiramente por `isDriver()` |
| `src/screens/Chat.tsx` | Assistente — roteamento local vs. remoto, confirmação de ações, aviso de duplicidade |
| `src/components/PendingRecurrings.tsx` | Card de confirmação de entrada/conta recorrente |
| `vite.config.ts` / `api/ai/chat.ts` | Os dois backends de IA (dev e produção) — manter sincronizados manualmente |

## localStorage, migração e compatibilidade

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

- `DEEPSEEK_API_KEY` vive em `.env` (raiz do projeto, git-ignored) e nas env vars do projeto na
  Vercel. **Nunca** referenciar essa variável em código que roda no navegador/APK
  (`src/**`) — só em `vite.config.ts` (roda em Node, no dev server) e `api/ai/chat.ts` (roda em
  Node, na função serverless).
- Antes de qualquer commit ou build, se mexer nesses dois arquivos, confirmar que a chave não
  foi hardcoded por engano (checar com `grep -rn "sk-" dist/` depois do build).
- `.gitignore` já protege `node_modules/`, `dist/`, `.env`, `.vercel` — mas note a ressalva sobre
  o escopo do repositório Git na seção de infraestrutura do `PROGRESS.md`.
