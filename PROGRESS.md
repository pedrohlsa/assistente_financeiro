# AssistFin — Estado do Projeto

**Última atualização**: 2026-10-28 — continuidade local a partir de `a4afa92`.
**NOT READY para merge/deploy** até nova auditoria externa.
Leia a última seção antes das entradas históricas: ela distingue a produção
publicada (`main`) da branch local e lista os bloqueios reproduzidos.

> **Aviso de leitura**: as seções datadas abaixo são um diário — cada uma registra o que era
> verdade **naquela data** e não é reescrita depois. Para o estado atual verificado, use
> [CONTEXTO.md](CONTEXTO.md), [docs/AI_CURRENT_STATE.md](docs/AI_CURRENT_STATE.md) e a última
> seção deste arquivo. Os metadados de branch/produção imediatamente abaixo
> registram a sessão inicial de julho de 2026, **não o estado atual**.
**Pasta canônica do projeto (mudou nesta sessão)**: `D:\Claude\AssistFin`. A cópia antiga em
`C:\Users\ph969\OneDrive\Área de Trabalho\AssistFin` foi deixada intacta, mas **não é mais usada**
— era uma cópia interrompida no meio (faltavam `profile.ts`, `PendingRecurrings.tsx`,
`notifications.ts` e várias telas estavam desatualizadas). O conteúdo completo e atual foi
copiado da pasta antiga pra cá antes desta sessão.
**Branch**: `main`
**Commits**: `28677b9` (estado inicial) → `646ee63` / `12925d4` (correção da DeepSeek) →
`a94309a` (cartões e parcelamentos) → `3b59ca3` (chore: parar de versionar `tsconfig.tsbuildinfo`)
→ rodada de UX de 2026-07-27.
**Remote**: `https://github.com/pedrohlsa/assistente_financeiro` (push --force feito, sobrescreveu
o conteúdo antigo do repo a pedido do usuário)

Este documento foi gerado inspecionando o código-fonte e rodando comandos reais
(`npm run build`, `tsc --noEmit`, chamadas HTTP reais à DeepSeek, testes end-to-end no navegador)
— não depende de memória de conversa anterior. Sempre que uma afirmação não pôde ser verificada
com certeza, está marcada como **INCERTO**.

---

## ✅ Infraestrutura Git — RESOLVIDO nesta sessão

**Estado anterior** (histórico, não se aplica mais): o repositório Git estava inicializado na
pasta "Área de Trabalho" inteira (`C:\Users\ph969\OneDrive\Área de Trabalho`), sem nenhum commit,
misturado com arquivos pessoais do usuário.

**Correção aplicada**: `git init` feito especificamente dentro de `D:\Claude\AssistFin` (raiz
correta, só o projeto). Confirmado antes do commit que `node_modules/`, `dist/` e `.env` (chave
real da DeepSeek) **não** entraram no stage (`.gitignore` cobre os três). Primeiro commit
(`28677b9`, 96 arquivos) criado e enviado com `git push --force` para
`https://github.com/pedrohlsa/assistente_financeiro` (repo que já existia com 1 commit antigo,
sobrescrito a pedido explícito do usuário: *"pode apagar tudo se quiser, toma ai"*).
A pasta antiga da OneDrive não tem `.git` próprio, então nada foi afetado lá.

---

## ✅ Bug crítico corrigido nesta sessão — IA remota (DeepSeek) voltou a funcionar

**Sintoma original**: qualquer pergunta que dependesse da IA remota (DeepSeek) falhava com
`{"error":"empty-reply"}` / HTTP 502, tanto em produção (Vercel) quanto em dev local.

**Causa raiz confirmada** (auditoria anterior): a DeepSeek descontinuou o nome de modelo
`deepseek-chat`, hardcoded em `vite.config.ts:94` e `api/ai/chat.ts:77`.

**Verificação feita ANTES de corrigir** (item 10 do escopo desta sessão): consultei o endpoint
oficial `GET https://api.deepseek.com/models` com a chave real do `.env` (nunca exibida/logada).
Resultado: **HTTP 200**, a conta tem acesso a `deepseek-v4-flash` e `deepseek-v4-pro`. Confirmado
que `deepseek-v4-flash` existe de verdade antes de qualquer troca de código.

**Correção aplicada**:
1. Criado `api/_lib/deepseek.ts` — módulo **server-only** (nunca importado por `src/**`) que
   centraliza: `getDeepSeekConfig()` (modelo, baseURL, timeout, chave — todos via variável de
   ambiente com fallback seguro pra `deepseek-v4-flash`/`https://api.deepseek.com`/20000ms) e
   `callDeepSeekChat()` (chamada HTTP com `AbortController`, retry único em resposta vazia,
   classificação de erro em 11 códigos distintos, nunca lança exceção).
2. `vite.config.ts` e `api/ai/chat.ts` foram atualizados para importar e usar esse módulo —
   **nenhum dos dois tem mais `'deepseek-chat'` nem qualquer nome de modelo hardcoded**. O nome
   do modelo agora só existe em um lugar: `DEEPSEEK_DEFAULT_MODEL` em `api/_lib/deepseek.ts`
   (com override possível via env var `DEEPSEEK_MODEL`, sem precisar mexer em código).
3. Por que o módulo é compartilhado (não duplicado) mesmo entre dois runtimes diferentes: tanto
   `vite.config.ts` (rodado pelo Vite/esbuild em dev) quanto `api/ai/chat.ts` (empacotado pela
   Vercel/esbuild em produção) rodam em Node e resolvem imports relativos de TypeScript puro
   nativamente — não há bundler comum entre os dois processos, mas também não é necessário, já
   que um simples import relativo funciona nos dois. Não foi preciso cair no fallback de "mesma
   env var duplicada em dois lugares" citado no escopo — a duplicação de código foi eliminada de
   fato, só a `SYSTEM_PROMPT` (regras de perfil/categorias) continua duplicada entre os dois
   arquivos, porque essa parte está fora do escopo desta correção (ver seção de divergência do
   prompt, abaixo, que continua pendente).
4. `.env.example` criado com `DEEPSEEK_API_KEY=`, `DEEPSEEK_MODEL=deepseek-v4-flash`,
   `DEEPSEEK_BASE_URL=https://api.deepseek.com` — sem prefixo `VITE_`, sem valor real.

**Como foi reproduzido o bug original (para referência futura)**:
```bash
curl -X POST https://api.deepseek.com/chat/completions -d '{"model":"deepseek-chat",...}'
→ 400 {"error":{"message":"The supported API model names are deepseek-v4-pro or
   deepseek-v4-flash, but you passed deepseek-chat.", ...}}
```

**Impacto do bug enquanto existiu, mitigado**: como o app tem roteamento local-first
(`resolveLocal()` em `ai.ts`), a maioria das perguntas comuns continuava funcionando; só
perguntas realmente abertas ficavam sem resposta útil da IA remota.

---

## ⚠️ Divergência dev × produção no prompt da IA

> **⚠️ Corrigido em 28/07/2026 pela auditoria documental.** Esta seção afirmava, no presente, que
> o corpo do `SYSTEM_PROMPT` estava **sincronizado** entre os dois arquivos. Isso era verdade
> quando foi escrito (24/07) e **deixou de ser**: a rodada `eabca4a` acrescentou `odometer`, a
> categoria `autocuidado` e as regras 2b/2c/6b **só em `api/ai/chat.ts`**, e o `is99` continuou
> **só em `vite.config.ts`**. São 6 divergências, listadas em
> [docs/AI_CURRENT_STATE.md § 3](docs/AI_CURRENT_STATE.md). O parágrafo abaixo sobre
> `saving`/`origin` permanece **correto e pendente**.

Comparando manualmente `vite.config.ts` e `api/ai/chat.ts`:
**nenhum dos dois prompts menciona a ação `"saving"` nem o campo `"origin"`**, adicionados
na segunda leva de mudanças (seção 14 do escopo). Confirmado por busca textual — zero ocorrências
de `saving`/`origin` (fora do CORS header `access-control-allow-origin`, que é outra coisa) em
ambos os arquivos.

Além disso, `sanitizeActions()` em `src/services/ai.ts` **não tem `case 'saving'`** e **não repassa
o campo `origin`** de ações `income`/`expense` vindas da IA remota — mesmo que o prompt soubesse
sugerir isso, o cliente descartaria silenciosamente.

**Efeito prático**: "guardar dinheiro" e "origem/fonte" só funcionam hoje via parser local
(`nlp.ts`) e formulários manuais (`SavingForm`, campo Origem no `TransactionForm`). Se o usuário
pedir isso numa pergunta aberta que caia na IA remota, ela não vai saber sugerir essas ações
(e mesmo que soubesse, seriam descartadas no cliente).

**Status**: continua pendente. Não foi tocado nesta sessão — fora do escopo explícito (só correção
do modelo da DeepSeek). Ver plano curto na seção "🟢 Sessão de correção da IA remota" abaixo.

---

## 🟢 Sessão de correção da IA remota (DeepSeek) — 2026-07-24, evidências completas

Escopo desta sessão: **somente** corrigir o modelo descontinuado da DeepSeek e adicionar
tratamento robusto de erro/timeout. Nenhuma regra financeira, de perfil ou de design foi alterada.
Nenhum commit e nenhum deploy foram feitos — só o código local em `D:\Claude\AssistFin`.

### Arquivos modificados/criados

| Arquivo | Mudança |
|---|---|
| `api/_lib/deepseek.ts` | **Novo.** Config central (modelo/baseURL/timeout/chave) + `callDeepSeekChat()` com timeout e classificação de erro. Server-only, nunca importado por `src/**`. |
| `vite.config.ts` | Removido `readApiKey()` e a lógica de chamada duplicada; agora importa e usa `api/_lib/deepseek.ts`. Modelo hardcoded `'deepseek-chat'` removido. |
| `api/ai/chat.ts` | Mesma mudança que `vite.config.ts` — importa `api/_lib/deepseek.ts` em vez de duplicar a lógica de chamada. |
| `.env.example` | **Novo.** Documenta `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` sem valores reais. |

`SYSTEM_PROMPT` **não foi tocado** em nenhum dos dois arquivos (continua duplicado entre eles —
divergência pré-existente do `saving`/`origin`, ver acima, não fazia parte deste escopo).

### Modelo confirmado

- Consulta real a `GET https://api.deepseek.com/models` com a chave do `.env` → HTTP 200 →
  modelos disponíveis: `deepseek-v4-flash`, `deepseek-v4-pro`.
- Modelo padrão adotado: **`deepseek-v4-flash`**, configurável via env var `DEEPSEEK_MODEL` sem
  precisar editar código.

### Testes realizados e resultados reais

1. **`tsc --noEmit`** (checagem estrita de `src/`) → exit 0, zero erros.
2. **`npm run build`** → sucesso, 63 módulos, bundle final **336.60 kB** (idêntico byte-a-byte ao
   build anterior à mudança — confirma que `api/_lib/deepseek.ts` não vazou pro bundle do
   cliente).
3. **Endpoint local** (`node node_modules/vite/bin/vite.js`, depois confirmado também via
   `preview_start`/Browser pane): `POST http://localhost:5199/api/ai/chat`
   - Sem `message` → `HTTP 400 {"error":"no-message","message":"Mensagem vazia."}` (antes: só
     `{"error":"no-message"}`, sem mensagem segura pro usuário).
   - **Teste A (mensagem simples)**: `{"message":"oi, tudo bem?","context":{"perfil":"other"}}` →
     **HTTP 200**, resposta real da DeepSeek: `"Oi! Tudo bem sim, obrigado! Como posso ajudar com
     suas finanças hoje?"`.
   - **Teste B (formato real do app)**: mensagem fictícia de aluguel (`"recebi 1800 de aluguel..."`)
     com contexto `perfil:"autonomo"` completo (mesmo formato de `buildAiContext()`) → **HTTP 200**,
     `reply` coerente com o perfil (menciona meta de guardar, saldo — nunca km/motorista/99), e
     `actions: [{"kind":"income","amount":1800,"category":"aluguel",...}]` no formato que
     `sanitizeActions()` já aceita.
4. **Teste end-to-end real no navegador** (Browser pane, servidor local, estado injetado com
   `profile:"autonomo"`):
   - Pergunta que o motor local já responde (`"como estou indo esse mes?"`) → **não chamou a IA
     remota** (`read_network_requests` confirmou zero requests a `/api/ai/chat`) — roteamento
     local-first intacto.
     - ⚠️ **Achado à parte, fora do escopo desta correção**: essa pergunta caiu no handler genérico
       "resumo geral" de `ai.ts`, que **não é adaptado por perfil** e mostrou formato de motorista
       (meta diária, "Hoje/7 dias/Mês") para um perfil `autonomo`. Bug pré-existente, não
       introduzido nem corrigido nesta sessão — registrado como bug conhecido novo abaixo.
   - Pergunta genuinamente aberta (`"...o que você acha que eu deveria priorizar
     financeiramente esse trimestre?"`) → **chamou a IA remota** (`read_network_requests`
     confirmou `POST /api/ai/chat`), resposta coerente com o perfil `autonomo`, terminou
     perguntando se o usuário quer registrar o valor — **nenhuma ação foi sugerida nem
     aplicada automaticamente**. Confirmado lendo `localStorage` depois:
     `transactions.length === 0`.
5. **Simulação de erros** (harness isolado, chave real usada só localmente, nunca impressa,
   arquivo apagado depois do teste):
   - Chave ausente → `{"ok":false,"code":"no-key"}`
   - Modelo inválido (`deepseek-chat`, o bug original) → `{"ok":false,"code":"model-invalid"}`
   - Timeout (`timeoutMs:1`) → `{"ok":false,"code":"timeout"}`
   - Resposta não-JSON de um host que não é a API → `{"ok":false,"code":"server-error"}` (não
     travou, não vazou stack)
   - Chave inválida → `{"ok":false,"code":"auth-invalid"}`
   - Todos os 5 casos: nunca lançaram exceção, nunca vazaram a chave real, sempre voltaram um
     código seguro e classificado.
6. **Validação de ações antes de virarem registro financeiro** (item 14): revisão de
   `sanitizeActions()` em `src/services/ai.ts` (não alterado) confirma que já fazia tudo pedido —
   `isNum()` exige número finito **> 0** (rejeita negativo/não-numérico), `kind` desconhecido cai
   no `default` do `switch` (descartado em silêncio), JSON inválido nunca chega a `sanitizeActions`
   porque `res.json()` lança e `askAssistantRemote` captura e retorna `null` (cai no motor local).
   Toda ação, local ou remota, só é aplicada após clique explícito em "Confirmar" no chat
   (`confirmActions` em `Chat.tsx`) — confirmado no teste end-to-end acima (0 transações após a
   resposta da IA sem confirmação).

### Inspeção final de segredos (item 17)

Método: `grep -rn` no `dist/` gerado por um build limpo (`rm -rf dist && npm run build`).

| Busca | Resultado |
|---|---|
| `"sk-"` (padrão comum de chave) | nada encontrado |
| Chave real do `.env` (valor exato) | nada encontrado |
| `"DEEPSEEK"` (nome de variável/import) | nada encontrado |
| `"deepseek.com"` (endpoint da API) | nada encontrado |
| URLs relacionadas a IA no bundle | só `https://assist-fin.vercel.app/api/ai/chat` (pública, esperada) |

Conclusão: nenhum segredo, nome de variável privada ou endpoint interno vaza no bundle do cliente.

### Configuração da Vercel (item 16 — só inspeção, nenhum deploy feito)

- Rota `/api/ai/chat` é atendida por `api/ai/chat.ts` (convenção de rotas por arquivo da Vercel).
  `api/_lib/deepseek.ts` **não** vira rota própria — pasta prefixada com `_` é ignorada pela Vercel.
- Não existe `vercel.json` no projeto — configuração 100% por convenção de pastas.
- Variáveis que precisam existir no projeto Vercel (dashboard ou `vercel env add`):
  - `DEEPSEEK_API_KEY` — **já deve existir** (o bug era só o nome do modelo, a chave já
    funcionava antes). Não foi possível confirmar remotamente sem acesso ao dashboard/CLI logado
    nesta sessão.
  - `DEEPSEEK_MODEL` — **nova, recomendada mas não obrigatória**: o código já tem fallback seguro
    pra `deepseek-v4-flash` se a variável não existir na Vercel. Cadastrar é opcional, só dá
    controle de trocar o modelo sem novo deploy no futuro.
  - `DEEPSEEK_BASE_URL` — opcional, mesmo fallback seguro (`https://api.deepseek.com`).
- **O projeto exige novo build/redeploy**: sim, obrigatoriamente — o código de produção
  (`api/ai/chat.ts`) mudou, e o deploy atual na Vercel ainda está rodando a versão antiga
  (quebrada) até um novo `npx vercel --prod`.
- Diferença entre proxy local e função de produção: nenhuma relevante agora — os dois usam
  exatamente o mesmo `api/_lib/deepseek.ts`. Antes desta correção, a única diferença real era
  cosmética (middleware Vite vs. handler serverless); agora também a lógica de chamada é literalmente
  compartilhada.

**Passos exatos para configurar e redeployar (NÃO executados — aguardando autorização)**:
```bash
# 1. (opcional, recomendado) cadastrar o modelo explicitamente na Vercel:
npx vercel env add DEEPSEEK_MODEL production
# cole: deepseek-v4-flash

# 2. redeploy obrigatório pra publicar a correção do código:
npx vercel --prod
```

### Riscos e limitações restantes

- Não foi possível inspecionar as env vars **já cadastradas** na Vercel nesta sessão (exigiria
  login/CLI autenticado, que não faço sem autorização explícita — ver regra de segurança do
  projeto). Assumo que `DEEPSEEK_API_KEY` já está lá porque o app já funcionava antes do modelo
  ser descontinuado.
- A produção (`https://assist-fin.vercel.app`) **continua com o bug até o redeploy** — a correção
  só existe local em `D:\Claude\AssistFin` até então.
- `tsconfig.json` só inclui `"src"` — `api/_lib/deepseek.ts`, `vite.config.ts` e `api/ai/chat.ts`
  não passam por `tsc --noEmit`/`tsc -b`. Não é uma regressão desta sessão (já era assim antes),
  mas significa que erros de tipo nesses três arquivos só apareceriam em build/runtime, não na
  checagem estrita. Testado via execução real (Node 24 com `--experimental-strip-types`) em vez
  de checagem de tipos formal.
- Bug novo encontrado (não corrigido, fora de escopo): handler "resumo geral" em `ai.ts` não é
  adaptado por perfil (ver teste end-to-end acima).

### Plano curto de leitura para as próximas pendências (item 19 — NADA implementado, só plano)

1. **Analytics por perfil** (`src/screens/Analytics.tsx`): hoje zero referências a `isDriver`/
   `profile` — mostra os mesmos gráficos (km, R$/km) pra todo mundo. Plano: seguir o mesmo padrão
   já usado em `Home.tsx` (bifurcar com `isDriver(state.settings)`, esconder cards de veículo/km
   pros outros 3 perfis, trocar por cards de "resultado mensal"/"meta de guardar" equivalentes aos
   da Home).
2. **Sincronizar prompt remoto com `saving`/`origin`**: adicionar essas ações na `SYSTEM_PROMPT`
   de `vite.config.ts` **e** `api/ai/chat.ts` (os dois, manualmente — não há prompt compartilhado
   ainda) e adicionar `case 'saving'` + repasse do campo `origin` em `sanitizeActions()`
   (`src/services/ai.ts`). Redeploy necessário depois.
3. **Corrigir handler "resumo geral" não adaptado por perfil** (achado novo desta sessão, ver
   teste end-to-end acima): em `src/services/ai.ts`, o bloco `if (/resumo|como estou|situação/...)`
   perto do fim de `resolveLocal()` sempre usa `dailyGoal()`/formato de motorista. Plano: bifurcar
   como já é feito em outros blocos do mesmo arquivo (`if (!driverMode) {...}` com
   `monthlySavingGoal()`).

Nenhum desses três itens foi alterado nesta sessão.

---

## Status por item — legenda

- ✅ **IMPLEMENTADO E VERIFICADO** — testado nesta sessão ou em sessão anterior com evidência clara (screenshot, resposta de teste, output de comando).
- 🔧 **IMPLEMENTADO, MAS NÃO TESTADO** — código existe e parece correto, sem teste direto registrado.
- 🟡 **PARCIALMENTE IMPLEMENTADO** — parte funciona, parte não (detalhado).
- ⬜ **AINDA NÃO IMPLEMENTADO**.
- ❓ **INCERTO** — precisa verificação antes de confiar.

### Perfis e regras de negócio

| Item | Status | Nota |
|---|---|---|
| 4 perfis no onboarding (driver/autonomo/clt/other) | ✅ | Testado no navegador nesta sessão |
| Taxa da 99 só em driver + corridas/menção explícita | ✅ | Testado: aluguel dentro do perfil driver não pergunta; "recebi 99 reais" não marca `is99`; troca de perfil não aplica taxa retroativa |
| Recursos de motorista escondidos em autonomo/clt/other | ✅ | Testado: Settings, Goals, rotas `/veiculo` e `/corrida` (redirecionam pra Home via `<Navigate>`) |
| Meta diária preservada no motorista | ✅ | Testado: Home e Goals mantêm todos os campos originais |
| Meta mensal para guardar (não-motorista) | ✅ | Testado com exemplo exato da spec (entradas 3000/despesas 2000/líquido 1000) |
| Resultado líquido ≠ valor guardado | ✅ | Testado: líquido 1.000, guardado real 400, disponível 600, calculado corretamente |
| Histórico não é reinterpretado ao trocar de perfil | ✅ | Testado: JSON de transações idêntico byte-a-byte antes/depois da troca |
| Entrada recorrente não duplica no mês | ✅ | Testado: confirmar gera 1 transação, `handledMonths` impede repetição |
| `origin`/fonte sem presunção da IA | 🟡 | Formulário e parser local não presumem; **prompt remoto não conhece o campo** (ver divergência acima) |
| Categorias arquiváveis preservam histórico | ✅ | Testado: arquivar categoria custom não apaga transação que a usa |
| Backup exportar/importar (Mesclar/Substituir) | ✅ | Testado round-trip local (backup → apagar → restaurar = idêntico) |
| CSV de movimentações e resumo mensal | 🔧 | Código existe (`exportCsv`, `exportMonthlySummary` em `Settings.tsx`), não testei o download/conteúdo do arquivo em si nesta sessão |
| Toggle de IA remota (`remoteAi`) | ✅ | Testado: com `remoteAi:false`, registro e perguntas locais continuam respondendo |
| Painel de privacidade (texto explicativo) | 🔧 | Texto escrito em `Settings.tsx`, não revisado por um "usuário real" quanto a clareza |
| "Como foi calculado?" (meta mensal e previsão) | ✅ | Testado: expande e mostra os componentes do cálculo |
| Confirmação detalhada antes de registrar (tipo/valor/categoria/origem/data/taxa) | ✅ | Testado: bolha mostra "Receita de R$ 1800,00 / Categoria: Aluguéis / Data: hoje / Nenhuma taxa será aplicada" |
| Aviso de possível duplicidade (não bloqueia) | ✅ | Testado: avisa "Já existe uma receita parecida..." e permite confirmar mesmo assim |
| **Resumo mensal adaptado por perfil na tela de Análises** | ⬜ | **Não implementado.** `src/screens/Analytics.tsx` tem zero referências a `isDriver`/`profile` — mostra os mesmos gráficos genéricos pra todo mundo. Só a Home e o CSV de resumo diferenciam por perfil hoje. |
| Estados vazios honestos (sem previsão falsa) | ✅ | Testado: app sem nenhum dado não mostra previsão nem mensagem negativa |
| Sugestões de chat por perfil | ✅ | Testado visualmente — listas diferentes por `profile` em `Chat.tsx` |

### Infraestrutura / build / deploy

| Item | Status | Nota |
|---|---|---|
| `npm run build` | ✅ | Sucesso, ver seção "Resultado do build" abaixo |
| `tsc --noEmit` (checagem estrita) | ✅ | Exit code 0, zero erros |
| APK Android gerado e testado | ✅ | Gerado em sessão anterior, testado em emulador (onboarding, chat, IA respondendo) — **mas isso foi ANTES do bug do `deepseek-chat` aparecer; não sei se a IA remota já estava quebrada naquele teste ou quebrou depois** (❓ incerto — a data exata em que a DeepSeek descontinuou o modelo não foi verificada) |
| Backend de produção (Vercel) publicado | ✅ | `https://assist-fin.vercel.app` responde, mas com o bug do modelo acima |
| Chave de API fora do bundle do cliente | ✅ | Verificado nesta auditoria: `grep` por padrão `sk-...` e pela chave real do `.env` em `dist/` não encontra nada; único texto relacionado à IA no bundle é a URL pública `https://assist-fin.vercel.app/api/ai/chat` |
| Notificações nativas (contas a vencer) | 🔧 | Código existe (`src/services/notifications.ts`, plugin `@capacitor/local-notifications`), só é testável de verdade num APK instalado, não no preview web — não retestado nesta sessão |

---

## Resumo do `git status` / `git diff`

Não aplicável da forma usual — ver seção "Infraestrutura Git" acima. Não há commits para
comparar; todo o código atual em `src/`, `api/`, `vite.config.ts` etc. está "untracked" do ponto
de vista do Git, mas é o estado de trabalho real e funcional do projeto.

## Arquivos criados/alterados nesta sessão de auditoria

- **Criado**: `CLAUDE.md` (não existia antes)
- **Criado**: `PROGRESS.md` (este arquivo, não existia antes)
- **Nenhum arquivo de código foi alterado** — instrução explícita do usuário era só auditar.

## Resultado do build (rodado nesta auditoria)

```
$ npm run build
> tsc -b --noCheck && vite build
✓ 63 modules transformed.
dist/index.html                 0.50 kB │ gzip:  0.32 kB
dist/assets/index-1eQWgR3n.css  11.34 kB │ gzip:  3.26 kB
dist/assets/index-Dma_Zcak.js    0.60 kB │ gzip:  0.36 kB
dist/assets/web-Bp600l52.js      3.46 kB │ gzip:  1.11 kB
dist/assets/index-9h3J2u84.js  336.60 kB │ gzip: 102.48 kB
✓ built in 1.14s
```

```
$ node node_modules/typescript/bin/tsc --noEmit
(sem output — exit code 0, zero erros de tipo)
```

Nota: o script `npm run build` usa `tsc -b --noCheck`, que **pula** a checagem de tipos e só
transpila. Por isso rodei o `tsc --noEmit` separado pra confirmar que não há erros mascarados —
confirmado, está limpo dos dois jeitos.

## Bugs conhecidos

1. ✅ **Chat de IA remota** — CORRIGIDO e EM PRODUÇÃO (2026-07-25). Duas causas encontradas e corrigidas em sequência: (a) modelo `deepseek-chat` descontinuado → `deepseek-v4-flash`; (b) import ESM sem extensão em `api/ai/chat.ts` quebrava a função na Vercel (`ERR_MODULE_NOT_FOUND`) → corrigido para `'../_lib/deepseek.js'`. Ver seção "🟢 Causa raiz comprovada e correção aplicada". Testado em produção: HTTP 200 em mensagens válidas, erro seguro em mensagem vazia, perfil respeitado, nenhum registro automático.
2. 🟡 **Prompt remoto sem `saving`/`origin`** — ver divergência dev×produção acima. Ainda pendente.
3. ⬜ **Analytics.tsx não adaptado por perfil** — item 14.13 do escopo original, nunca implementado.
4. ✅ **CONTEXTO.md referenciado no README mas não existe no projeto** — RESOLVIDO em 2026-07-28
   na auditoria documental. O arquivo foi criado na raiz e o link do README é válido.
5. ✅ **"Resumo geral" do chat local não adaptado por perfil** — CORRIGIDO em 2026-07-27 na rodada
   de UX (item 29). `resolveLocal()` agora bifurca por perfil: não-motorista recebe entradas,
   despesas, líquido, guardado, meta mensal e parcelas do mês, sem nenhuma métrica de motorista.
   Testado no navegador com perfil CLT.

## Possíveis regressões

Nenhuma identificada nesta auditoria. Os testes dos cenários A/B/C/D (perfis) e os 10 testes da
seção 14.14 continuam consistentes com o código atual (revisão manual do código relevante, sem
re-executar os testes no navegador nesta sessão específica — ❓ recomendo re-rodar antes de
confiar 100%, já que a auditoria não re-testou UI, só leu código + testou build + testou API).

## Decisões tomadas e motivos (histórico, para contexto)

- **`profileAtCreation` opcional, não obrigatório**: para não quebrar transações já salvas no
  `localStorage` de usuários existentes (compatibilidade retroativa).
- **`type: 'saving'` como tipo de transação separado**, em vez de uma categoria de despesa
  especial: evita que "guardar dinheiro" infle o total de despesas do mês, que é usado em vários
  cálculos (`monthStats`, `dailyGoal`, etc.) — a mecânica de "não é receita nem despesa" só é
  limpa como um terceiro `type`.
- **Regra dos 4 perfis usa `isDriver()` como o único branch relevante** (não um switch por
  `autonomo`/`clt`/`other` espalhado pelo código): os três perfis não-motorista têm exatamente a
  mesma UI e regras hoje, só o texto de saudação/sugestões muda. Reduz superfície de bugs — se um
  dia precisarem divergir de verdade, aí sim vale um switch por perfil.
- **Categorias "arquivadas" em vez de deletadas**: apagar de verdade quebraria a referência
  (`category: string`) em transações antigas. Arquivar é reversível e não quebra nada.
- **Repositório Git não foi tocado**: a auditoria encontrou o problema de escopo (init na pasta
  errada, sem commits) mas corrigir isso é uma decisão de infraestrutura que o usuário deve
  aprovar explicitamente — não é uma auditoria "read-only".

## Testes já realizados (nesta sessão de auditoria)

- `npm run build` — sucesso.
- `tsc --noEmit` — zero erros.
- `curl` no backend de produção (Vercel) — reproduziu o bug 502.
- `curl` no backend local (`npm run dev` + proxy) — reproduziu o mesmo bug (confirma que não é
  específico do Vercel).
- `curl` direto na API da DeepSeek com a chave real — revelou a causa raiz exata (modelo
  descontinuado).
- `grep` por segredos em `dist/` — confirmado limpo.

## Testes que ainda precisam ser executados

1. Re-rodar os cenários A/B/C/D e os 10 testes da seção 14.14 no navegador após qualquer nova
   mudança de código (não foram re-executados nesta auditoria, só revisados via leitura de código).
2. Testar download real do CSV (`exportCsv`, `exportMonthlySummary`) e abrir o arquivo gerado.
3. Testar notificações nativas em um APK instalado de verdade (não é possível no preview web).
4. ✅ **Parcialmente feito nesta sessão**: testei uma pergunta aberta de verdade (que não caiu no
   roteamento local) no perfil `autonomo`, local, com sucesso (ver seção "🟢 Sessão de correção da
   IA remota"). **Ainda falta**: repetir para os perfis `driver`, `clt` e `other`, e testar em
   produção depois do redeploy na Vercel.

## Passos exatos para reproduzir os bugs conhecidos

**Bug 1 (IA remota fora do ar)**:
```bash
curl -X POST https://assist-fin.vercel.app/api/ai/chat -H "content-type: application/json" \
  -d '{"message":"quanto posso gastar hoje?","context":{"perfil":"driver"},"history":[]}'
# Esperado: resposta da IA. Real: {"error":"empty-reply"} HTTP 502
```

**Bug 2 (Analytics não adaptado)**: abrir `/analises` com `profile: 'autonomo'` no
`localStorage` e observar que os cards mostrados são os mesmos do motorista (sem checar
`isDriver()` em nenhum ponto do arquivo).

## Próximos passos recomendados (em ordem de prioridade)

1. **🟡 Sincronizar o prompt remoto com `saving`/`origin`** em ambos os arquivos, e adicionar os
   casos correspondentes em `sanitizeActions()` (`src/services/ai.ts`). Plano curto já registrado
   acima. (IA remota já está funcional em produção — este item é sobre um recurso que ela ainda
   não conhece, não sobre o bug de infraestrutura, já resolvido.)
2. **⬜ Adaptar `Analytics.tsx` por perfil** (item 14.13 pendente) — esconder métricas de
   motorista (km, R$/km) para os outros três perfis, igual já foi feito na Home. Plano curto já
   registrado acima.
3. **🆕⬜ Corrigir "resumo geral" não adaptado por perfil** em `src/services/ai.ts` (achado numa
   sessão anterior). Plano curto já registrado acima.
4. Rodar a bateria de testes manuais listada em "Testes que ainda precisam ser executados" nos
   perfis `driver`, `clt` e `other` (só `autonomo` foi testado em produção até agora).

## 🔴 Tentativa de deploy em produção — 2026-07-25 00:40 (horário local), FALHOU — parado conforme instrução

Escopo desta etapa: publicar **somente** a correção da DeepSeek já aprovada, testar em produção.
Nenhuma outra funcionalidade foi tocada (Analytics, saving/origin, resumo geral, Git). Nenhum
commit foi feito.

### 1–4. Diretório, projeto Vercel, variáveis, verificação local — todos OK

- Diretório confirmado: `D:\Claude\AssistFin` (`pwd` = `/d/Claude/AssistFin`).
- Projeto Vercel confirmado por `.vercel/project.json` (`projectName: "assist-fin"`) e
  `npx vercel whoami` (logado como `stguts25-2108`) — mesmo projeto referenciado em todo este
  documento, nenhuma ambiguidade.
- Variáveis de produção verificadas **só pelos nomes** (`npx vercel env ls production`):
  `DEEPSEEK_API_KEY` já existia (Encrypted, criada 2 dias antes). `DEEPSEEK_MODEL` e
  `DEEPSEEK_BASE_URL` não existiam. Cadastrei **somente** `DEEPSEEK_MODEL=deepseek-v4-flash` em
  Production (`npx vercel env add DEEPSEEK_MODEL production`) — não toquei na chave existente, não
  adicionei `DEEPSEEK_BASE_URL` (não pedido, tem fallback).
- `npx tsc --noEmit` → exit 0. `npm run build` → sucesso, mesmo bundle de sempre.

### 5. Primeiro deploy — build falhou por erro de TypeScript não detectado localmente

`npx vercel --prod` (primeira tentativa, deployment `dpl_56jZjgd7JdxdmBzuNcp7DoQos1ae`): o build da
Vercel roda uma checagem de tipos própria em `api/**` que **nosso `tsconfig.json` nunca cobre**
(`"include": ["src"]` — já documentado como risco conhecido). Erro real:
```
api/ai/chat.ts(72,41): error TS2339: Property 'code' does not exist on type 'DeepSeekSuccess | DeepSeekFailure'.
  Property 'code' does not exist on type 'DeepSeekSuccess'.
```
**Causa raiz reproduzida localmente**: com `strict: false` (config real do projeto), o TypeScript
não estreita (narrow) a união discriminada `DeepSeekSuccess | DeepSeekFailure` de forma confiável
a partir de `if (!out.ok)` — testei isolando exatamente as `compilerOptions` do projeto contra
`api/ai/chat.ts` + `api/_lib/deepseek.ts`: falha com `strict:false`, passa com `strict:true`.
Não alterei `tsconfig.json` (afetaria a checagem de `src/` inteiro, fora de escopo). Corrigi de
forma cirúrgica: adicionei `isDeepSeekFailure(out): out is DeepSeekFailure` (type predicate
explícita) em `api/_lib/deepseek.ts`, e troquei `if (!out.ok)` por `if (isDeepSeekFailure(out))`
em `vite.config.ts` e `api/ai/chat.ts` — narrowing explícito funciona independente de `strict`.
Reproduzi a checagem exata da Vercel localmente (mesmas `compilerOptions`) até confirmar 0 erros
antes de redeployar.

### Segundo deploy — build passou, mas a função quebra em runtime

`npx vercel --prod` (segunda tentativa, deployment `dpl_5yU5bUNndSmNExrxa8q2KDPvUrxG`,
**URL `https://assist-1cdhd4fl3-stuartand.vercel.app`, aliasado para `https://assist-fin.vercel.app`**):
build 100% limpo (`Build Completed`, sem erros de TS desta vez), deploy `READY`, `target: production`.

**Porém os testes pós-deploy revelaram uma falha nova, não relacionada ao TypeScript**:

### 6. Testes reais em produção

**Teste A (sem mensagem)**: `POST https://assist-fin.vercel.app/api/ai/chat` com `{}` →
**HTTP 500**, corpo `FUNCTION_INVOCATION_FAILED` (página de erro genérica da Vercel, texto puro,
sem stack trace nem dado sensível exposto ao cliente — mas também não é o erro seguro
`{"error":"no-message",...}` esperado, porque a função nem chega a rodar o nosso código).

**Teste B (mensagem neutra)**: mesmo resultado — **HTTP 500**, `FUNCTION_INVOCATION_FAILED`.

**Teste C (formato real do app, perfil autônomo)**: não testado via HTTP direto — já não fazia
sentido dado que A e B confirmaram que a função inteira não inicializa (falha antes de processar
qualquer input).

**Teste D (interface de produção, navegador real)**: app publicado abre normalmente, onboarding e
navegação funcionam. Injetei estado com `profile:"autonomo"` via `localStorage`, abri o chat, e
mandei uma pergunta genuinamente aberta ("...o que você acha que eu deveria priorizar
esse trimestre?"). Resultado:
- `read_network_requests` confirmou `POST /api/ai/chat` → **500**.
- **Nenhum erro visível ao usuário** — o app absorveu o erro graciosamente e caiu no fallback
  local genérico ("Posso te ajudar com coisas como...'), exatamente como projetado para quando a
  IA remota falha.
- Console do navegador sem erros.
- `localStorage` confirmado depois: `transactions.length === 0` — nenhum registro automático.
- Resto do app (navegação, abas) continuou funcionando normalmente.

**Conclusão prática**: o usuário final **não vê um crash** (o app não quebra), mas a IA remota
continua **de fato não respondendo perguntas abertas em produção** — o objetivo real desta etapa
(religar a IA remota) **não foi alcançado ainda**.

### 7. Logs — causa raiz exata da falha 500

`npx vercel logs https://assist-1cdhd4fl3-stuartand.vercel.app`:
```
λ POST /api/ai/chat
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/api/_lib/deepseek'
imported from /var/task/api/ai/chat.js
    at finalizeResolution (node:internal/modules/esm/resolve:277:11)
    ...
Node.js process exited with exit status: 1.
```
Nenhuma chave, token ou cabeçalho privado nos logs — só o erro de módulo, que é público/genérico.

**⚠️ Correção sobre a hipótese registrada aqui originalmente**: eu tinha escrito, sem prova
concreta, que "pastas prefixadas com `_` dentro de `api/` são excluídas do bundle". **Isso estava
errado** — a causa raiz real, comprovada com evidência (ver seção "🟢 Causa raiz comprovada e
correção aplicada" logo abaixo), é um problema de **resolução de import ESM sem extensão**, nada
relacionado ao underscore. `api/_lib/deepseek.ts` continuou exatamente onde estava.

### 8. Estado da IA remota ao fim desta tentativa (2026-07-25 00:40)

🔴 Ainda não funcional para perguntas abertas — ver seção seguinte para a causa raiz real e a
correção que resolveu isso na mesma sessão, um pouco depois.

O código local em `D:\Claude\AssistFin` está correto e testado (ver seção "🟢 Sessão de correção
da IA remota" acima — os testes locais com `node node_modules/vite/bin/vite.js` continuam válidos,
o problema era específico do empacotamento da Vercel). **Nenhum commit foi feito ainda nesta
etapa** — o fix do type-narrowing (`isDeepSeekFailure`) existia só localmente até este ponto.

---

## 🟢 Causa raiz comprovada e correção aplicada — 2026-07-25 00:55 (mesma sessão, investigação orientada pelo usuário)

O usuário pediu explicitamente para **não presumir** que o underscore de `api/_lib/` fosse a
causa, e para investigar a resolução ESM dos imports primeiro. Essa investigação estava correta —
eis a evidência real, coletada reproduzindo o build da Vercel localmente (`npx vercel pull` +
`npx vercel build --prod`, sem nunca imprimir a chave baixada por `vercel pull`):

### 1. Inspeção antes de alterar

- `package.json`: `"type": "module"` — projeto é ESM puro.
- `tsconfig.json`: `"module": "ESNext"`, `"moduleResolution": "bundler"`, cobre só `"include": ["src"]`.
- Import em `api/ai/chat.ts` (antes): `from '../_lib/deepseek'` — sem extensão.
- Import em `vite.config.ts`: `from './api/_lib/deepseek'` — sem extensão (mesmo padrão).

### 2. Build da Vercel reproduzido localmente

```bash
npx vercel pull --yes --environment production   # necessário p/ vercel build funcionar
npx vercel build --prod
```
Resultado: `{"status":"ok","outputDir":".vercel/output", ...}`.

**Evidência decisiva em `.vercel/output/functions/api/ai/chat.func/`**:
```
api/ai/chat.js
api/ai/chat.js.map
api/_lib/deepseek.js       ← O MÓDULO ESTÁ AQUI. Nunca foi excluído do bundle.
api/_lib/deepseek.js.map
package.json               ← "type": "module" (herdado do projeto)
```
O `chat.js` compilado (antes da correção) continha, literalmente:
```js
import { getDeepSeekConfig, ... } from '../_lib/deepseek';
```
**Sem extensão** — e como o `package.json` da função tem `"type":"module"`, a função roda sob o
**loader ESM nativo do Node** (`.vc-config.json`: `"runtime":"nodejs24.x"`), que — diferente do
`moduleResolution:"bundler"` do TypeScript/Vite — **exige extensão explícita em imports
relativos** e não tenta resolver `deepseek` → `deepseek.js` sozinho. Esse é o `ERR_MODULE_NOT_FOUND`
real: o arquivo existe, mas o especificador do import não aponta pra ele de um jeito que o Node
aceite.

**Confirmação de que não é o underscore**: o arquivo `api/_lib/deepseek.js` estava presente no
bundle da função desde a primeira tentativa — o problema nunca foi inclusão/exclusão, sempre foi
a extensão do especificador do import.

### 3–4. Hipótese principal testada e confirmada

Alternativa A da ordem de preferência pedida: **manter `api/_lib/deepseek.ts` onde está, corrigir
só o import ESM**. Mudança de uma linha em `api/ai/chat.ts`:
```diff
- from '../_lib/deepseek'
+ from '../_lib/deepseek.js'
```
`vite.config.ts` **não foi alterado** — é processado pelo bundler de config do próprio Vite
(esbuild interno), que resolve extensão automaticamente e nunca teve esse problema; o dev local já
funcionava antes e continuou funcionando depois, confirmado por teste real (abaixo). Os dois
imports são processados por ferramentas diferentes, como o usuário alertou — só um precisava mudar.

Validado, nesta ordem, antes de redeployar:
- TypeScript resolve `'../_lib/deepseek.js'` apontando pro `.ts` fonte (`moduleResolution:"bundler"`
  entende esse padrão) — reproduzi a checagem exata da Vercel (`compilerOptions` do projeto +
  arquivos de `api/`) → **0 erros**.
- `npx tsc --noEmit` (projeto, `src/`) → 0 erros.
- `npm run build` → sucesso, bundle do cliente **idêntico** (`index-9h3J2u84.js`, mesmo hash de
  sempre — confirma que nada server-only vazou pro frontend).
- Proxy local (`node node_modules/vite/bin/vite.js` + `curl`) → **HTTP 200**, resposta real da
  DeepSeek — dev continua funcionando.
- `npx vercel build --prod` de novo: `.vercel/output/.../chat.js` agora contém
  `from '../_lib/deepseek.js'`, e `api/_lib/deepseek.js` existe exatamente nesse caminho dentro do
  bundle — import resolvido corretamente.
- Nenhum outro import relativo sem extensão sobrou (`node:fs`/`node:path` em `deepseek.ts` são
  módulos built-in do Node, não relativos — não precisam de extensão).
- `grep` por `sk-` e pela chave real em `.vercel/output/functions/` inteiro → nada encontrado.

Não foi necessário mover o módulo (alternativa B) nem convertê-lo pra `.js`/`.mjs` (alternativa C).
Não houve duplicação nova da lógica da DeepSeek.

### 5. Redeploy e testes reais em produção

`npx vercel --prod` → build limpo, sem erros de TS.
- **Deployment ID**: `dpl_26KzU3srKKi61FfFWeqndu5hUPUZ`
- **URL de preview**: `https://assist-qxzkvg7l0-stuartand.vercel.app`
- **URL pública (alias)**: `https://assist-fin.vercel.app`

| Teste | Requisição | Resultado |
|---|---|---|
| A — sem mensagem | `POST /api/ai/chat` com `{}` | **HTTP 400**, `{"error":"no-message","message":"Mensagem vazia."}` — erro seguro, sem stack trace |
| B — mensagem neutra | `{"message":"oi, tudo bem?",...}` | **HTTP 200**, resposta real da DeepSeek |
| C — formato real do app, perfil autônomo | pergunta sobre aluguel/planejamento, contexto completo | **HTTP 200**, resposta respeita o perfil (nunca menciona motorista/km/combustível/Uber/99), `actions: []` (pergunta informativa, sem fato a registrar) |
| D — interface real de produção | pergunta aberta pelo chat, perfil `autonomo` injetado | **HTTP 200** confirmado via `read_network_requests`; resposta real apareceu na tela; console sem erros; `transactions.length === 0` depois — nenhum registro automático; resto do app funcionando |

**Nota sobre o Teste D**: as primeiras tentativas de interação via automação de clique/teclado no
navegador não registraram o texto no campo controlado por React (o `computer.type` não focava o
campo corretamente nesta sessão, e `form_input` setava o `.value` do DOM sem disparar o evento
`input` que o React observa). Contornado disparando o `input` event nativo via JS antes de clicar
em "Enviar" — depois disso, o fluxo real do app (state → `send()` → fetch → render) funcionou sem
nenhuma intervenção adicional. Isso foi um obstáculo de automação de teste, não um bug do app.

### 6. Logs da nova implantação

`npx vercel logs https://assist-qxzkvg7l0-stuartand.vercel.app` → **4 entradas, todas nível
`info`**, uma para cada requisição dos testes A–D. **Nenhum erro**: sem `ERR_MODULE_NOT_FOUND`,
sem 401, sem 429, sem timeout, sem 500. Nenhuma chave, token ou cabeçalho privado nos logs.

### Segredos — confirmação final

`npx vercel pull` baixou `.vercel/.env.production.local` (contém a chave real em texto puro) —
confirmado `.gitignore`d antes de qualquer leitura, nunca aberto/exibido, e **apagado** ao final
da sessão junto com `.vercel/output` (artefatos locais, não fazem parte do projeto versionado).
`grep` por `sk-` e pela chave real em todo `.vercel/output/functions/` → nada encontrado.

### Estado final da IA remota em produção

✅ **Funcional.** `https://assist-fin.vercel.app` está rodando o deploy `dpl_26KzU3srKKi61FfFWeqndu5hUPUZ`,
com o modelo `deepseek-v4-flash`, perguntas abertas recebendo respostas reais e corretas por
perfil, erros tratados com segurança, e sem nenhum registro financeiro automático.

### Segredos — confirmação

Nenhuma chave, token ou valor de variável apareceu em nenhum momento: nem nos comandos `vercel env
ls` (só nomes), nem nos logs de build, nem nos logs de runtime, nem nas respostas HTTP 500
(mensagem genérica da Vercel, sem detalhe interno).

### Deployment desta etapa

- **Deployment ID**: `dpl_5yU5bUNndSmNExrxa8q2KDPvUrxG`
- **URL de preview**: `https://assist-1cdhd4fl3-stuartand.vercel.app`
- **URL pública (alias)**: `https://assist-fin.vercel.app` — **está no ar com este deploy**, ou
  seja, produção está rodando o código nesta condição (app funciona, IA remota quebrada) até uma
  nova correção e novo deploy.

---

## 🟢 Cartões e Parcelamentos — implementado em 2026-07-26

Área completa de cartões de crédito, parcelamentos e projeções futuras, disponível em
**Mais → 💳 Cartões e parcelamentos** (`/cartoes`) para os 4 perfis, com linguagem adaptada.

### Arquitetura e decisão de contabilização (a parte crítica)

**Regra única, aplicada em todo o código:**
- **Histórico da compra = valor total** → vive no `InstallmentPlan`.
- **Fluxo de caixa mensal = parcelas que vencem no mês** → `Installment.dueDate`.
- Os dois **nunca** são somados.

Como isso foi garantido na prática: **compras no cartão e parcelamentos NÃO criam `Transaction`.**
Eles vivem em arrays próprios (`installmentPlans` + `installments`). Consequências:
1. `periodStats`/`monthStats`/`savedThisMonth` — que filtram `type === 'income'|'expense'` — ficam
   **byte-idênticos** ao comportamento anterior. Zero regressão para quem não usa cartões.
2. Pagar a fatura (`CardPayment`) quita a dívida e reduz o saldo em conta, mas **não gera despesa**:
   a despesa já foi contada como parcela. Dupla contagem é impossível por construção.
3. Na linha do tempo, a fatura do cartão aparece como **um** item agregando suas parcelas — as
   parcelas do cartão não são listadas de novo (seção 10 da spec).

### Entrada financiada pelo cartão (seção 7)

Novo `TxType: 'financed-cash-inflow'` — **nunca** `'income'`. Como todos os somatórios de receita
filtram `type === 'income'` explicitamente, o valor recebido fica automaticamente fora de receita,
lucro e faturamento. O que acontece ao registrar:
- `InstallmentPlan` com `operationType: 'financed-cash-inflow'`, `totalAmount` = cobrado no cartão,
  `netReceived` = líquido, `feeAmount` = custo da operação;
- uma `Transaction` do tipo próprio (aparece no histórico, sem sinal de ganho, rotulada
  "entrada financiada (não é receita)");
- `settings.balance` aumenta (o dinheiro entrou no caixa de verdade).
A UI mostra explicitamente: *"Seu patrimônio líquido não aumentou R$ X: você recebeu esse valor e
passou a dever R$ Y, um custo de R$ Z"*, mais o aviso legal exigido e um checkbox de confirmação.

### Novos tipos e armazenamento

Mesma chave de sempre (`assistfin-state-v1`) — **não** foi criada v2. Cinco arrays novos em
`AppState`: `cards`, `installmentPlans`, `installments`, `cardPayments`, `cardCharges`.
Tipos: `CreditCard`, `InstallmentPlan`, `Installment`, `CardPayment`, `RecurringCardCharge`,
`InstallmentPlanStatus`, `InstallmentStatus`, `PlanOperationType`.
Novas `ParsedAction`: `card-purchase`, `financed-cash-inflow`, `card-payment`, `card-charge`.

**Migração**: `normalizeState()` em `store.tsx` garante os arrays tanto no hidrate do localStorage
quanto no `case 'hydrate'` (restauração de backup antigo). Backup já serializa o state inteiro;
`mergeState` foi estendido para deduplicar os 5 arrays novos por `id`.

**Segurança**: o cartão guarda só nome, instituição, 4 últimos dígitos, limite e dias de
fechamento/vencimento. Nunca número completo, CVV, senha ou token.

### Arquivos

| Arquivo | Mudança |
|---|---|
| `src/services/cards.ts` | **Novo.** Toda a matemática: divisão de parcelas com arredondamento, geração de parcelas, faturas por mês, estados, limites, progresso, compromissos mensais, linha do tempo. |
| `src/screens/Cards.tsx` | **Novo.** 4 abas (Visão geral, Cartões, Parcelamentos, Projeções) + linha do tempo. |
| `src/components/cardForms.tsx` | **Novo.** 6 formulários: cartão, compra, entrada financiada, parcelamento sem cartão, pagamento de fatura, assinatura. |
| `src/models/types.ts` | Novos tipos + `TxType 'financed-cash-inflow'` + 5 arrays em `AppState` + 4 `ParsedAction`. |
| `src/store/store.tsx` | 15 actions novas, `normalizeState`, `mergeState` estendido, `findCardByName`, 4 casos em `applyParsedAction`. |
| `src/services/calc.ts` | `monthlyProjections()` (12+ meses), `hasProjectionData()`; campos **aditivos** em `dailyGoal` (`installments`), `monthlySavingGoal` (`installmentsDue`, `projectedAvailable`) e `monthForecast` (`installmentsLeft`). |
| `src/services/nlp.ts` | `parseCardClause()` — compra parcelada, entrada financiada, fatura, assinatura; resumo detalhado antes de confirmar. |
| `src/services/ai.ts` | Contexto de cartões/parcelas/projeções, validação das 4 ações novas, respostas locais determinísticas. |
| `vite.config.ts` + `api/ai/chat.ts` | `SYSTEM_PROMPT` com as regras de cartão — **confirmado byte-idêntico entre os dois**. |
| `src/screens/More.tsx` / `App.tsx` | Entrada de menu 💳 + rota `/cartoes`. |
| `Home.tsx`, `Goals.tsx`, `Transactions.tsx`, `Analytics.tsx`, `Chat.tsx` | Adaptações mínimas: parcelas na meta mensal e na previsão, componente de parcelas na meta diária, render do novo tipo, rótulo no CSV, sugestão de chat. |

### Projeções (seção 9)

`monthlyProjections(state, 12)` — expansível de 12 em 12 meses. Por mês: entradas recorrentes,
contas recorrentes, parcelas+assinaturas, resultado, saldo estimado acumulado, disponível para
guardar, comprometimento da renda e marcação de mês apertado. **Só usa obrigações cadastradas** —
não extrapola média de gasto variável, para nunca apresentar estimativa como compromisso real.

### Impacto nas metas (seção 13)

- **Não-motorista**: `monthlySavingGoal` ganhou `installmentsDue` e `projectedAvailable` — campos
  **novos**, `net` e `saved` continuam idênticos (o valor realmente guardado não muda).
- **Motorista**: `dailyGoal` ganhou o componente `installments` (parcelas do mês ÷ dias de trabalho).
  Sem parcelas cadastradas o valor é 0 e a meta diária fica **exatamente** como era.

### Testes executados (todos no navegador, dados reais)

| Cenário | Resultado |
|---|---|
| **A — compra parcelada** | Nubank (fecha 1, vence 10) + computador R$4.000 em 4x → 4 parcelas de R$1.000 em 10/ago, 10/set, 10/out, 10/nov; soma R$4.000; **0 transactions criadas**. Fatura paga (600+400) → só a parcela 1 quitada, **0 despesas geradas**. |
| **B — entrada financiada** | R$2.000 cobrado / R$1.850 líquido / 5x R$400 → custo R$150; transaction `financed-cash-inflow`; **soma de receitas = R$0**; saldo +1.850; 5 parcelas nas faturas futuras. |
| **C — CLT** | Salário R$3.000 + compra parcelada → projeções mostram a parcela por mês, comprometimento 33%; nenhuma métrica de motorista na tela. |
| **D — autônomo** | Aluguel R$1.800 + parcelas → entradas e obrigações separadas, saldo estimado R$4.050, comprometimento 78%; **busca por "99/Uber/km/combustível/corrida" retornou zero ocorrências**. |
| **E — pagamento parcial** | Fatura R$1.000, pago R$600 → status "Parcialmente paga", R$400 pendentes, nenhuma parcela quitada, **0 despesas duplicadas**, saldo 1.000→400. |
| **F — assinatura** | Netflix R$39,90 → entrou na fatura futura (439,90); pausada → deixou de ser projetada (voltou a 1.400); cobranças e pagamentos anteriores preservados. |
| **G — IA** | "Comprei uma geladeira de R$3.000 em 3 vezes no Nubank" → proposta com tipo/total/parcela/nº/cartão/1º vencimento/impacto, **aguardando confirmação, nada registrado**. "Comprei um computador em 4 vezes" (sem valor) → **nenhuma ação criada**, IA perguntou só o que faltava. "Quanto vou pagar de cartão nos próximos três meses?" → R$2.800 com o detalhe mês a mês, dados reais. |
| **Arredondamento** | R$1.000 em 3x → 333,33 · 333,33 · 333,34 (soma exata). |
| **Migração** | Estado antigo sem os 5 arrays → app carregou sem erro, arrays criados, recorrentes preservados. |
| **Regressão motorista** | Meta diária R$241,34 = (1.200+4.500)/25,98 + 10% — **idêntica à fórmula anterior**; Resumo rápido, km, viagens, R$/km e "Por que essa meta?" intactos. |
| **Fallback local** | Com `remoteAi: false`, pergunta sobre parcelas respondida localmente com dado real. |
| **Responsividade** | Viewport 375×812 — todas as abas e o card expansível renderizam sem quebra. |

### Build e checagens

```
npx tsc --noEmit                    → exit 0
npx tsc --noEmit -p (com api/**)    → exit 0   (mesma config que a Vercel usa)
npm run build                       → ✓ 66 modules, dist/assets/index-DdvIi5iD.js 412.89 kB │ gzip: 120.55 kB
```
Bundle: sem `sk-`, sem a chave real, sem `DEEPSEEK`/`deepseek.com`, sem `getDeepSeekConfig`/
`callDeepSeekChat`. `src/` não importa `api/_lib/` em lugar nenhum.

### Limitações conhecidas desta entrega

1. **Assinatura no mês de cadastro**: `monthlyCommitments` conta a assinatura no mês corrente,
   mas a *fatura* a joga para o próximo vencimento (uma assinatura cadastrada hoje não entra numa
   fatura que já venceu). Diferença de um mês só na primeira ocorrência — os dois números são
   defensáveis, mas não são idênticos. Vale unificar depois.
2. **Antecipação sem desconto/juros**: antecipar marca as parcelas como pagas, mas ainda não há
   campo para registrar desconto por antecipação nem multa/juros de atraso (seção 11 parcial).
3. **Editar parcelas futuras**: dá para cancelar futuras, quitar e pagar individualmente, mas não
   há edição de valor/vencimento de uma parcela específica pela UI (o reducer já suporta via
   `updateInstallment`).
4. **`accountId` em `CardPayment`**: o app tem um único saldo (`settings.balance`), então o
   pagamento oferece apenas "descontar do meu saldo" em vez de escolher entre contas.
5. **Analytics por perfil** continua pendente (fora do escopo desta tarefa, como instruído).

---

## 🟢 Rodada de correções de UX, valores, linguagem natural e datas — 2026-07-27

Rodada de 54 itens sobre bugs encontrados em uso real. Nenhuma funcionalidade existente foi
removida; motorista, cartões, contabilização e confirmação da IA seguem intactos.

### Bugs encontrados e causa raiz REAL de cada um

| # | Sintoma | Causa raiz confirmada | Correção |
|---|---|---|---|
| 5–7 | `100.000` virava `100` | `parseMoney()` tratava qualquer ponto sem vírgula como separador decimal; `nlp.ts` tinha um `parseNum` próprio e incompatível, e o padrão `NUM` não capturava mais de um separador | Parser pt-BR único em `format.ts` com heurística "último separador com 3 dígitos = milhar"; `NUM` virou `(\d+(?:[.,]\d+)*)` e `parseNum` passou a delegar |
| 8 | Onboarding criava prazo de 90 dias que o usuário nunca pediu | `finish()` gravava `deadline: addDays(todayISO(), 90)` fixo | Campo "Prazo desejado (opcional)"; sem prazo → `deadline: undefined` |
| 10 | IA sobrescrevia meta existente sem avisar | `applyParsedAction` case `'goal'` chamava `findGoalByName` e fazia `updateGoal` | `'goal'` só cria; alterar é `'goal-update'`; aviso obrigatório no chat |
| 17 | Preencher juros não mudava nada | O código gravava `interestAmount` mas usava só `totalV` no preview, na divisão, no `totalAmount` e nas projeções | `totalAmount = principalAmount + interestAmount`; novo campo opcional `principalAmount` |
| 22 | "Corridas" aparecia como filtro principal em CLT/autônomo | `Transactions.tsx` renderizava `state.categories` inteiro sem consultar o perfil | Filtros principais adaptados; categorias de motorista vão para "Mais categorias" (e voltam sozinhas se houver movimentação no período) |
| 24–25 | "gastei **mais** 79" e dois comandos numa frase falhavam | `splitClauses` só quebrava antes de um verbo colado ao separador — "`, depois gastei`" não casava; os regex de valor não previam "mais" depois do verbo | Conector opcional no split (`depois`, `e depois`, `também`, `logo depois`, `mais tarde`, `então`); `(?:mais\s+)?` nos verbos |
| 26 | "gás" era classificado como Casa automaticamente | `CATEGORY_KEYWORDS.casa` continha `'gás'`/`'gas'` | "gás" sozinho saiu de `casa`; `isAmbiguousGas()` dispara pergunta com botões |
| 27 | Descrição saía "colocando gas", "prando cimento" | Não havia limpeza; e a preposição `com` do regex casava dentro de "**com**prando" | `cleanDescription()` remove palavras funcionais só das **pontas**; preposições passaram a exigir `\s+` |
| 30–33 | "vence hoje" x "em 10 dias" para a mesma conta; dias 29–31 viravam 28 | `upcomingFrom()` usava `Math.min(r.dueDay, 28)` e olhava o mês seguinte, enquanto `pendingRecurrings` olhava o mês corrente e o card escrevia "vence hoje" fixo | Fonte única `occurrenceInMonth()` + `dateForDayOfMonth()` (último dia real do mês) + `dueLabel()` a partir do `inDays` real |
| 31 | Conta cadastrada dia 27 com vencimento dia 5 já nascia "vencendo hoje" | Recorrente não tinha data de início | `startDate` na criação = próxima ocorrência; checkbox "Incluir também a ocorrência deste mês" |
| 38 | Botão "Apagar todos os dados" não apagava de forma confiável, mas o comando da IA sim | Duas causas: (a) o botão dependia de `window.confirm`, bloqueado em parte dos WebViews do Android — o caminho da IA não usava; (b) a gravação debounced de 150ms podia reescrever o estado antigo | `resetAllData()` único: cancela o debounce, remove só a chave do AssistFin e restaura o estado; `<ConfirmDialog>` no lugar do `window.confirm` |
| — | (achado nesta rodada) `1.234,56` gerava DUAS despesas | A vírgula decimal casava como separador de itens enumerados | `,(?!\d)` no separador |

Também corrigido nesta rodada o **bug 5 da lista de bugs conhecidos** ("resumo geral" do chat
local usando formato de motorista em perfil não-motorista), que estava pendente desde a sessão
da IA remota.

### Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `src/utils/format.ts` | `parseMoney` reescrito, `formatMoneyInput`, `dateForDayOfMonth`, `lastDayOfMonth`, `daysBetween`, `dueLabel` |
| `src/utils/text.ts` | **Novo.** `sentenceCase`, `normalizeName`, `sameName` |
| `src/components/ui.tsx` | **Novos** `<MoneyInput>` (formata só no blur) e `<ConfirmDialog>` |
| `src/components/forms.tsx` | `MoneyInput` em todos os campos de dinheiro; `GoalForm` com confirmação de duplicidade; `RecurringForm` com `startDate` e primeira ocorrência |
| `src/components/cardForms.tsx` | Duplicidade de cartão, validação de fechamento/vencimento com sugestão de 7 dias, atalhos `1x–4x/Mais`, juros no total financiado, `<RoundingNote>` |
| `src/components/nav.tsx` | FAB contextual por rota |
| `src/components/PendingRecurrings.tsx` | Texto a partir da data real do vencimento |
| `src/screens/Onboarding.tsx` | Botão dinâmico, prazo opcional, sem dados de exemplo, "‹ Voltar" |
| `src/screens/Transactions.tsx` | Cards enxutos + folha de detalhes; filtros adaptados por perfil |
| `src/screens/Planning.tsx` | "Saldo estimado", `+ Conta fixa`, `+ Limite`, `Remover` com confirmação e desfazer |
| `src/screens/Goals.tsx` | Um ritmo por vez + "Ver detalhes" + seletor de ritmo |
| `src/screens/Settings.tsx` | "Ritmo exibido nas metas", reset com `ConfirmDialog`, demo só em dev |
| `src/screens/Home.tsx` | `dueLabel`, `MoneyInput`, sentence case, demo só em dev |
| `src/screens/Cards.tsx` | `Pagar`/`Parcial`/`Desfazer`/`+ Novo cartão`/`Mostrar arquivados`, decomposição dos juros |
| `src/screens/Vehicle.tsx` | Sentence case nos botões |
| `src/services/nlp.ts` | Conectores, "mais", ordem inversa ("cimento por 190"), `cleanDescription`, `parseNaturalFull` com ambiguidade do gás |
| `src/services/ai.ts` | `choices` na resposta, "resumo geral" adaptado por perfil |
| `src/services/calc.ts` | `occurrenceInMonth`, `recurringActiveOn`, `upcomingFrom` corrigido, `inDays` em `pendingRecurrings` |
| `src/services/cards.ts` | `suggestedDueDay`, `findCardByExactName` |
| `src/services/profile.ts` | `goalCadenceOf` e rótulos do ritmo |
| `src/data/categories.ts` | Categoria `obra`, palavras-chave, `mergeDefaultCategories` |
| `src/store/store.tsx` | `resetAllData`, `findGoalByExactName`, fusão de categorias, `choices` no chat |
| `src/models/types.ts` | `principalAmount`, `goalCadence`, `choices` |
| `vite.config.ts` + `api/ai/chat.ts` | `SYSTEM_PROMPT` com categoria `obra`, regra do gás, múltiplos comandos, descrição e `goal` x `goal-update` — **confirmado byte-idêntico entre os dois** |
| `scripts/test-money.mjs` | **Novo.** 43 asserções do parser monetário e dos helpers de texto |

### Testes executados e resultados reais

| Cenário | Resultado |
|---|---|
| **40 — valores** | 43/43 asserções OK. `100.000`→100000, `100.000,00`→100000, `10,000,00`→10000, `1,234.56`→1234.56, `R$ 5.000,00`→5000; `.` `,` `-` `R$` `abc` → NaN |
| **41 — onboarding** | Vazio → "Pular por agora"; só nome → botão desabilitado + "Informe o nome e o valor…"; apagou os dois → volta a "Pular por agora"; completo → meta `target: 100000` com o prazo **exato** escolhido |
| **42 — meta duplicada** | "  CÁSA  " reconhecida como "Casa". Cancelar → 1 meta; Editar a existente → 1 meta atualizada (nome original preservado); Criar mesmo assim → 2 metas. IA: aviso explícito e, após confirmar, a meta original ficou **intacta** (alvo 100000, guardado 2000, prazo 2027-05-28) |
| **43 — cartão** | "Nubank (Cirinha)", limite `5.000` → `5000`. " NUBANK   (CIRINHA) " → aviso de duplicidade. Vencimento em branco → "usaremos 7 dias após o fechamento — dia 1" (fechamento 25 em julho). Dia 45 → "Informe um dia entre 1 e 31" e botão bloqueado. Dias 29/30/31 → 28/02 (29/02 em ano bissexto), 30/04 |
| **44 — juros e arredondamento** | Compra R$ 410,99 + juros R$ 1,00 = **total financiado R$ 411,99**; 4 parcelas `102,99 · 102,99 · 102,99 · 103,02`, soma exata R$ 411,99; dívida, limite comprometido e fatura usam 411,99; **0 transactions criadas**; texto: "A última parcela recebeu um ajuste de R$ 0,03 para que a soma seja exatamente R$ 411,99" |
| **45 — múltiplas despesas** | "gastei 79 reais colocando gás, depois gastei mais 190 reais comprando cimento" → pergunta "Você quis dizer gás de cozinha ou GNV?"; escolhendo cozinha → R$ 79,00/Casa/"Gás de cozinha" **e** R$ 190,00/Obra e construção/"Cimento", em blocos separados, registrados só após confirmar |
| **46 — descrição e detalhes** | Lista mostra "Cimento · Obra e construção · 03:47 · -R$ 190,00"; sem botão remover por linha; toque abre detalhes com tipo, categoria, data por extenso, horário, origem do registro e perfil na criação |
| **47 — recorrentes** | Conta dia 5 cadastrada em 27/07 → "Primeira ocorrência: 5 de agosto — o dia 5 deste mês já passou" + opção de incluir; **nenhuma** pergunta "vence hoje"; Home e Planejamento mostram "Vence em 9 dias" (mesma data). Conta realmente vencida → "A conta Internet, de R$ 120,00, venceu em 5 de julho" + "Venceu há 22 dias" |
| **48 — ritmo das metas** | Por mês R$ 688,52 → Por semana R$ 160,66 → Por dia R$ 22,95, **um de cada vez**; preferência sobreviveu ao reload (`goalCadence: 'daily'`) |
| **49 — apagar dados** | Estado com 2 transações, 2 metas, 2 contas, 1 cartão, 1 plano, 4 parcelas e 7 mensagens → botão apagou tudo, chave removida **imediatamente** (sem esperar o debounce), voltou ao onboarding, e o reload não trouxe nada de volta. Chave `outro-app-teste` **preservada** (nada de `localStorage.clear()`). Comando "apaga tudo" pela IA: efeito idêntico, mesmo caminho |
| **50 — motorista** | Meta diária **R$ 241,34** — idêntica à registrada antes desta rodada; km, viagens, R$/km líquido, lucro por hora, "Resumo rápido" e sugestões de corrida intactos |
| **50 — CLT/autônomo** | "como estou?" respondeu com entradas/despesas/líquido/guardado/meta mensal e **zero** menção a meta diária, km, corrida, combustível ou veículo |
| **21/51 — migração** | Estado antigo sem os 5 arrays de cartão, sem `goalCadence` e com lista de categorias antiga → app carregou, arrays criados, dados preservados, categoria `obra` **adicionada sem duplicar** (19 categorias, 0 duplicadas), categoria personalizada arquivada preservada |
| Console | Nenhum erro |
| Responsividade | 375×812 sem estouro horizontal (`scrollWidth === innerWidth`) |

### Build e checagens

```
node node_modules/typescript/bin/tsc --noEmit          → exit 0
node node_modules/typescript/bin/tsc --noEmit (api/**) → exit 0   (mesma config da Vercel)
npm run build                                          → ✓ 67 modules, dist/assets/index-cu1jfs4W.js 430.76 kB │ gzip: 126.21 kB
npx vercel build --prod                                → {"status":"ok"} (build local, NADA publicado)
node --experimental-strip-types scripts/test-money.mjs → 43/43 OK
```
Bundle: sem `sk-`, sem `DEEPSEEK`, sem `deepseek.com`, sem `getDeepSeekConfig`/`callDeepSeekChat`.
`.vercel/output/functions/.../chat.js` mantém `from '../_lib/deepseek.js'` e o módulo está no
pacote. `.vercel/output` e `.vercel/.env.production.local` apagados ao final.

**⚠️ A `SYSTEM_PROMPT` mudou nos dois backends.** Produção continua rodando o prompt antigo até
um `npx vercel --prod` — que **não** foi feito nesta rodada (sem autorização). O app não quebra:
o comportamento novo do gás, dos múltiplos comandos e da categoria `obra` já funciona no motor
local, que é quem atende esses casos.

### Limitações que permanecem

1. **Antecipação sem desconto/juros** — antecipar marca parcelas como pagas, mas não há campo
   para desconto por antecipação nem multa/juros de atraso.
2. **Editar parcela específica** (valor/vencimento) só existe no reducer (`updateInstallment`),
   sem UI.
3. **`accountId` em `CardPayment`** não é usado — o app tem um saldo único.
4. **Assinatura no mês de cadastro** — `monthlyCommitments` conta no mês corrente e `cardInvoice`
   joga para o próximo vencimento; diferença de um mês só na primeira ocorrência.
5. **Analytics por perfil** continua pendente (fora do escopo, como instruído).
6. ✅ `settleAll`, "Cancelar futuras" e a remoção de assinatura agora usam `<ConfirmDialog>`,
   assim como reset e substituição de backup; não restam confirmações nativas no código executável.
7. ~~`CONTEXTO.md` referenciado no README continua inexistente.~~ Resolvido em 28/07/2026.

---

## 🟢 Previsto x realizado, saldo único e recorrências flexíveis — 2026-07-27 (2ª rodada do dia)

Rodada baseada em teste real: cadastrar um salário recorrente de R$ 1.625,00 e confirmar o
recebimento fazia a "Entradas" do card da meta subir, mas o saldo em conta ficava em R$ 0,00.

### Auditoria antes de mexer (estado encontrado)

| Situação | O quê |
|---|---|
| **Concluído** | Parser monetário, sentence case, FAB contextual, reset, cartões/juros, categoria "Obra e construção", ambiguidade do gás, múltiplos comandos, meta duplicada, ritmo das metas, detalhes das movimentações, `startDate` + `occurrenceInMonth` + `dueLabel` |
| **Parcialmente implementado** | `startDate` só era gravado em recorrência **mensal**; `pendingRecurrings` só tratava `frequency === 'monthly'` (semanal e anual nunca perguntavam); ocorrência tinha só `handledMonths`, sem estado por data |
| **Comportamento antigo não alterado** | `settings.balance` era um número **digitado à mão** e isolado: nenhuma receita/despesa o alterava; `frequency` só tinha 3 valores; o formulário exibia "Dia da semana (0=dom)" |
| **Regressão criada na rodada anterior** | Nenhuma. Confirmado no navegador que cadastrar a recorrente **não** inflava "Entradas" (`monthStats` só soma `transactions`) — o defeito era o saldo não acompanhar. |

### Causa raiz do salário não aparecer no saldo (reproduzida antes da correção)

| Momento | Saldo em conta | Entradas | % da meta |
|---|---|---|---|
| Recorrente só cadastrada | R$ 0,00 | R$ 0,00 | 0% |
| Após "Confirmar recebimento" | **R$ 0,00** | R$ 1.625,00 | **847% + "Meta alcançada!"** |

`confirmar()` em `PendingRecurrings.tsx` criava a `Transaction` (que entra em `monthStats().income`)
mas **não tocava em `settings.balance`** — e nenhum lançamento tocava. Só 4 pontos escreviam no
saldo: o input da Home, a ação `balance` da IA, a entrada financiada (+) e o pagamento de fatura (−).
O saldo não era uma consequência das movimentações, era um retrato manual paralelo.

### Regras de previsto x realizado (agora explícitas)

- **Previsão** (recorrente cadastrada, parcela futura, assinatura não cobrada): aparece só em
  entradas/saídas previstas, calendário, projeções e saldo estimado. Não cria movimentação, não
  mexe no saldo, não conta no mês, não influencia a meta.
- **Realizado**: nasce da confirmação do usuário. Cria `Transaction`, entra no saldo, no mês, no
  resultado e na meta.
- Ocorrência confirmada **sai** das listas de previsto (`upcomingFrom` ignora resolvidas), então
  nada é contado como saldo atual e entrada prevista ao mesmo tempo.

### Saldo: fonte única

`currentBalance(state)` em `calc.ts`. `settings.balance` virou **âncora** + `balanceAsOf`; o saldo
de hoje é a âncora mais receitas, despesas, entradas financiadas e faturas pagas "do saldo"
posteriores a ela. As mutações imperativas em `addCardPayment` e na entrada financiada foram
**removidas** (contariam duas vezes). Leitores atualizados: Home, Planejamento, `monthForecast`,
`monthlyProjections`, `balanceOutlook`, `notifications`, contexto e respostas da IA, `CardPaymentForm`.
Compatibilidade: sem `balanceAsOf`, a âncora vale a partir do início de hoje.
`type:'saving'` continua fora do saldo por decisão de projeto (a reserva pode ser cofrinho).

### Frequências disponíveis

Semanal · A cada 2 semanas · Mensal · A cada 2 meses · A cada 3 meses · A cada 6 meses · Anual ·
**Personalizada** (repetir a cada N dias/semanas/meses/anos, com data inicial, data final opcional
e "sem data final"). Modelo: `interval` + `intervalUnit`; `frequency` permanece como campo legado.

**Cálculo**: sempre a partir de `startDate`, por soma real — 15 dias são 15 dias corridos, nunca
"duas vezes por mês". **Política de meses curtos**: o dia original é preservado e só reduzido ao
último dia do mês quando aquele mês não o tem — 31/01 a cada 2 meses → 31/03, 31/05, 31/07,
**30/09**, **30/11**, **31/01**. O dia nunca degrada permanentemente para 28.

### Dias da semana

`weekdayName`/`weekdayShort`/`weekdayList` em `src/utils/text.ts` e a frase pronta de
`describeRecurrence()`. A interface mostra "Toda segunda-feira", "A cada 2 semanas, às
segundas-feiras", "A cada 15 dias", "Todo dia 5", "Todo ano, em 20 de novembro" — nunca `0`, `1`, `2`.

### Card da meta

- `Entradas` → **Entradas recebidas**; `Despesas` → **Despesas realizadas**.
- `Resultado líquido` → **Sobra do mês** (positivo) / **Déficit do mês** (negativo).
- Progresso principal = **valor realmente guardado** (`saved/target`). Antes era `net/target`, que
  produzia "847% da meta" com R$ 0,00 guardado.
- `reached` agora exige `saved >= target`; `canReach` (sobra cobre a meta) e `availablePct` são
  campos novos, rotulados "% do valor necessário está disponível" — nunca "% da meta".
- Com sobra suficiente e nada guardado, o card oferece o botão **"Guardar R$ X"**.

### Testes executados (navegador, dados reais)

| Cenário | Resultado |
|---|---|
| **A — salário só previsto** | Data futura → **não** perguntou nada, 0 transações, saldo R$ 0,00, entradas recebidas R$ 0,00, salário só em "Próximas entradas"; saldo estimado R$ 1.625,00. Card da meta sem sobra fantasma. |
| **B — salário já recebido** | Data passada → perguntou "Você já recebeu esta entrada neste período?" com as 3 opções. "Cadastrar e registrar recebimento" → **1** transação com `occurrenceDate: 2026-07-05`, ocorrência marcada `confirmed`, **saldo R$ 1.625,00**. A ocorrência de agosto continua prevista. |
| **C — despesas** | Com salário recebido + R$ 355,00 de despesas → saldo R$ 1.270,00 e "**Sobra do mês** R$ 1.270,00". Removendo o recebimento → saldo −R$ 355,00 e "**Déficit do mês** R$ 355,00". |
| **D — meta** | Meta R$ 150, sobra R$ 1.270, guardado R$ 0 → **não** mostrou "Meta alcançada"; mostrou "Você já tem valor disponível para cumprir sua meta de R$ 150,00", "1083% do valor necessário está disponível" e o botão "Guardar R$ 150,00". Após guardar R$ 150 → "🎉 **Meta mensal alcançada**" e "Guardado: R$ 150,00 de R$ 150,00". |
| **E — a cada 15 dias** | Início 10/08 → **10/08 · 25/08 · 09/09 · 24/09**, conferido no motor e na prévia do formulário. |
| **F — a cada 2 meses** | Início 31/01 → 31/01, 31/03, 31/05, 31/07, **30/09**, **30/11**, **31/01**. Política documentada acima. |
| **G — semanal** | Escolhido 03/08 (segunda) → prévia "**Toda segunda-feira** · 03/08 · 10/08 · 17/08 · 24/08", zero números de dia da semana; após recarregar, "Feira · Toda segunda-feira" persistiu. |
| **Compatibilidade** | Recorrências antigas (só `frequency` + `dueDay` + `handledMonths`, sem `startDate`/`interval`/`occurrences`) carregaram, geraram "Todo dia 10" e "Todo ano, em 20 de novembro", próxima ocorrência correta, e o `handledMonths` de julho continuou impedindo a pendência. |
| **Prevenção de duplicidade** | Chave `recurringId` + `occurrenceDate` no lançamento e em `occurrences`; `pendingRecurrings` e `upcomingFrom` pulam ocorrências resolvidas. |

### Build e checagens

```
node node_modules/typescript/bin/tsc --noEmit          → exit 0
node node_modules/typescript/bin/tsc --noEmit (api/**) → exit 0
npm run build                                          → ✓ dist/assets/index-BVEYAyzN.js 437.38 kB │ gzip: 128.20 kB
npx vercel build --prod                                → {"status":"ok"}  (build local, NADA publicado)
```
Bundle sem `sk-`, `DEEPSEEK` ou `deepseek.com`; a função serverless mantém `from '../_lib/deepseek.js'`.

### Limitações que permanecem

1. `describeRecurrence` cobre um dia da semana por recorrência — `weekdayList` já suporta
   "segunda, quarta e sexta", mas o formulário ainda não oferece múltiplos dias.
2. Estados de ocorrência gravados são `confirmed` e `skipped`; "adiada" continua sendo o
   `snoozeUntil` e "atrasada"/"prevista" são derivados da data, não persistidos.
3. Editar uma recorrência existente (valor, frequência, data inicial) ainda não tem tela — só
   criar e remover.
4. `type:'saving'` fora do saldo é uma decisão, não um consenso: se a reserva for outra conta
   bancária, o saldo exibido ficará maior que o extrato.
5. Antecipação de parcela sem desconto/juros, edição de parcela específica e Analytics por perfil
   seguem pendentes das rodadas anteriores.

---

## 🟢 Confirmações destrutivas compatíveis com Android/WebView — 2026-07-28

Auditoria de retomada confirmou que as 54 correções do briefing original e a rodada posterior de
previsto x realizado já estavam concluídas, testadas e commitadas. A pendência concreta deixada no
relatório era o uso de `window.confirm` em quatro ações.

### Correção aplicada

- Remover assinatura, quitar parcelamento e cancelar parcelas futuras em `Cards.tsx` agora usam
  o `<ConfirmDialog>` compartilhado.
- "Substituir tudo" na importação de backup em `Settings.tsx` usa o mesmo diálogo interno.
- Quitação continua marcando parcelas como pagas e cancelamento continua preservando o histórico.
- Foi corrigida uma inconsistência descoberta no teste: `removeCardCharge` apagava a recorrência
  inteira e, com ela, as cobranças históricas calculadas. Agora a remoção é lógica, com os campos
  opcionais `removedAt` e `endDate`: a assinatura some da lista ativa, para de gerar cobranças
  futuras e continua compondo as faturas anteriores.
- O backup só substitui o estado depois da confirmação.
- Busca em `src/**` confirmou zero chamadas executáveis a `window.confirm`/`confirm()`.

### Testes executados

| Cenário | Resultado |
|---|---|
| Quitar parcelamento | Diálogo interno abriu, nenhuma janela nativa; confirmar marcou 2/2 parcelas como pagas e o plano como "Quitado" |
| Cancelar futuras | Cancelar o diálogo manteve 3 parcelas pendentes; confirmar marcou o plano como "Cancelado" e preservou as 3 parcelas no histórico |
| Remover assinatura | Cancelar manteve a assinatura; confirmar a removeu da lista ativa, preservou R$ 49,90 na fatura já lançada e eliminou cobranças futuras |
| Substituir backup | Cancelar manteve o backup pendente e os dados atuais; confirmar restaurou o arquivo de teste e removeu o estado anterior |
| Console | Nenhum erro durante os quatro fluxos |
| TypeScript `src/**` | exit 0 |
| TypeScript `api/**` + `vite.config.ts` | exit 0 |
| `test-money.mjs` | 43/43 |
| `npm run build` | 67 módulos; `index-CQyzVmvx.js` 438,40 kB, gzip 128,50 kB |
| `npx vercel build --prod` | `status: ok`, build somente local, nada publicado |
| Segurança | zero padrões de segredo no bundle do cliente; módulo server-only e import ESM com `.js` presentes no pacote da função |

O arquivo JSON usado no teste de importação foi criado fora do projeto e removido ao final. Nenhum
push ou deploy foi realizado.

---

## 🟢 Entrega operacional: GitHub, produção e Android — 2026-07-28

O usuário autorizou explicitamente push, deploy e geração/instalação do APK depois da conclusão
das correções.

### GitHub

- Os 7 commits locais foram enviados para `origin/main`.
- Commit de código publicado: `17cd97bd6c9a2d89d55c9aaccc8a60ddfa061da8`.
- Repositório: `https://github.com/pedrohlsa/assistente_financeiro`.

### Vercel

- Projeto confirmado: `assist-fin`.
- Deployment de produção: `dpl_FjpKctiwGGAEYJqQegMQ3bLj2F4u`.
- URL do deployment: `https://assist-6b1u8eyfr-stuartand.vercel.app`.
- Alias público atualizado: `https://assist-fin.vercel.app`.
- Build remoto: 67 módulos, `index-CQyzVmvx.js` 438,40 kB (gzip 128,50 kB).
- HTTP do app: 200 e HTML apontando para o bundle atual.
- Endpoint da IA: mensagem vazia retorna 400; pergunta aberta retorna resposta real da DeepSeek,
  sem ação financeira sugerida.
- Teste no navegador de produção: onboarding, cartões, IA remota e reset concluídos; console sem
  erros. Os dados fictícios criados no teste foram apagados pelo próprio reset do app.

### Android

- `npx cap sync android`: sucesso; assets atuais e plugin de notificações sincronizados.
- `assembleDebug`: sucesso.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- Tamanho: 4.302.624 bytes.
- SHA-256: `59C55B8A649A5A8E9F27CDFF13B9C7D705420D0780B609018199C740FFCD9386`.
- O APK contém `assets/public/assets/index-CQyzVmvx.js`, o mesmo bundle publicado na Vercel.
- Assinatura verificada com `apksigner`: APK Signature Scheme v2, 1 signatário.
- Instalado com sucesso em um Moto G50 5G conectado (`adb install`).
- `com.assistfin.app/.MainActivity` iniciou com status OK, processo permaneceu ativo e nenhum
  `FATAL EXCEPTION` apareceu no log. A tela estava em modo ambiente/bloqueada, então o teste visual
  no aparelho foi deixado para a validação manual seguinte, sem tentar desbloquear o dispositivo.

---

## 🟢 Motorista, assistente composto e painel Android — 2026-07-28

### Dados e cálculos

- Custos do veículo começam em zero; o app não inventa preço, consumo, custo fixo
  ou valor mínimo por km.
- Hodômetro foi separado de km trabalhado. Registrar trabalho não altera mais o
  hodômetro, e frases como "estou com 220.007 km" não contaminam as estatísticas.
- Abastecimentos aceitam valor + litros + hodômetro no mesmo registro, calculam
  preço/L e, a partir de dois hodômetros, estimam km/L.
- Vida útil de manutenção começa em branco. Sem ela não existe projeção falsa;
  com vida útil e média diária de km, aparecem data aproximada e reserva diária.
- Receita de corrida conta uma viagem quando o usuário não informou quantidade.

### Assistente

- O parser preserva todas as partes de mensagens compostas, incluindo
  "430 Uber, mais 399 da 99, 163 de gasolina, 24 L e 161 km".
- "Mais uma corrida de 49" e "corrida na 99 no valor de 37" funcionam localmente.
- Mensagens que misturam registro e pergunta de orçamento respondem às duas partes.
- Avisos de intenção ("vou te passar...") recebem resposta conversacional, sem
  disparar resumo ou registro.
- A taxa é uma confirmação separada e curta ("Taxa 99"); citar a 99 não desconta
  automaticamente.
- Marcas Markdown devolvidas pela IA são removidas na conversa.

### Interface

- Planejamento separa "Contas a pagar" e "Entradas recorrentes", com explicação
  simples, formulários travados no tipo correto e botão de novo orçamento.
- Frequências rápidas: diário, semanal, mensal, anual e personalizada.
- Categoria padrão "Autocuidado" adicionada.
- Ritmo diário/semanal/mensal agora vale na Home e em Metas. Motorista continua
  diário por padrão; os outros perfis, mensal.
- Home usa "Resultado realizado" e avisa que contas previstas ainda não pagas
  ficam fora desse número.
- A barra inferior permanece visível; "Mais" continua verde em Planejamento,
  Veículo, Cartões, Análises e Configurações.
- Configurações ganhou "Limpar lançamentos e trabalho", preservando cadastros.

### Android

- Novo analisador flutuante ativado em Mais. Usa sobreposição e acesso a
  notificações concedidos pelo usuário; não usa serviço de acessibilidade.
- Ofertas da Uber, 99 e inDrive que trazem valor/km na notificação recebem cálculo
  local de R$/km bruto e após custos.
- Quando a plataforma não expõe os dados na notificação, tocar no painel volta ao
  app para análise manual.
- Versão Android: 1.1.0 (versionCode 2).

### Testes desta rodada

- `npm test`: cenários exatos do briefing passaram.
- `npx tsc -b`: sem erros.
- `npm run build`: sucesso.
- `assembleDebug` com JDK 21: sucesso.
- APK 1.1.0 instalado com sucesso no Moto G50; processo iniciou sem `FATAL EXCEPTION`.
- APK: 4.316.612 bytes; SHA-256
  `EB9B247A6A8103C981955A1B74BFBD7A112FEE595FC2E5040FE8E318C59BE651`.
- QA móvel em 430 × 900: Home, Planejamento, formulário recorrente, Configurações,
  Veículo, Assistente e destaque de Mais verificados.
- Fluxo real no navegador: R$ 430 Uber + R$ 399 da 99 + combustível + 161 km
  gerou duas receitas, duas viagens, um abastecimento e um trabalho; o hodômetro
  220.007 permaneceu separado.
- Código: commit `eabca4a`, enviado para `origin/main`.
- Produção: deployment `dpl_HkvzbjZcwauE3wojBoj4SKm2rMct`, alias
  `https://assist-fin.vercel.app`, HTTP 200 e bundle `index-CnBwvYNY.js`.
- Endpoint remoto respondeu sem criar ações a uma pergunta conversacional.

---

## 📋 Auditoria documental e consolidação — 2026-07-28

Etapa **somente documental**. Nenhuma mudança funcional, nenhuma regra financeira alterada,
nenhum push e nenhum deploy.

### Estado do Git no início e no fim

- Raiz: `D:/Claude/AssistFin` (confirmada por `git rev-parse --show-toplevel`).
- Branch: `main`, sincronizada com `origin/main`.
- Commit de partida: `7dc1832` (`docs: record driver release delivery`).
- `git status` no início: **working tree clean**. `git diff` e `git diff --stat` vazios.
- Nenhum arquivo externo rastreado, nenhum segredo, nenhum `.env`, nenhum arquivo temporário
  de teste, nenhuma alteração funcional não documentada.
- Não havia código de rodada anterior pendente de commit — a documentação criada aqui não se
  misturou com nada.
- `.vercel/output` gerado pelo build local não aparece no `git status` (já ignorado).

### Testes e builds executados (resultados reais)

| Comando | Resultado |
|---|---|
| `npm test` | ✅ exit 0 — "Todos os testes do núcleo passaram." |
| `node node_modules/typescript/bin/tsc --noEmit` | ✅ exit 0, sem erros |
| `npm run build` | ✅ `dist/assets/index-CnBwvYNY.js` (449,30 kB / gzip 132,03 kB), 68 módulos, 1,45 s |
| `npx vercel build --prod` | ✅ `"status": "ok"` — build **local**, sem deploy |

Nenhuma falha. O bundle gerado é idêntico ao que já está em produção
(`index-CnBwvYNY.js`), confirmando que nada funcional mudou.

### Documentação criada

- **`CONTEXTO.md`** (novo, na raiz — o README já apontava para ele e o arquivo não existia).
  Visão consolidada: produto, público, perfis, offline-first, mobile-first, estado de
  Web/Vercel/Android, arquitetura, endpoints, integração DeepSeek, build e deploy, regras
  financeiras permanentes, estado funcional por área e pendências reais.
- **`docs/AI_CURRENT_STATE.md`** (novo). Pipeline em 12 etapas do texto do usuário até a
  gravação, com arquivo, função, entrada, saída, responsabilidades, limitações, falhas possíveis
  e dependências de cada uma; a tabela de divergências entre os dois `SYSTEM_PROMPT`; e os 20
  pontos auditados, cada um confirmado no código.
- **`docs/AI_REGRESSION_MATRIX.md`** (novo). 126 casos por perfil e tipo de intenção, com frase,
  resultado esperado, ações esperadas, pergunta esperada, data esperada, mecanismo esperado
  (local/remoto/híbrido) e status atual honesto. A coluna "pós-correção" está vazia de propósito.
- **`CLAUDE.md`**: acrescentada a regra permanente **24** — `api/**` fora do `tsc` local,
  extensão `.js` obrigatória nos imports ESM da função serverless e `isDeepSeekFailure()`
  obrigatório sob `strict: false`.
- **`README.md`**: corrigido o modelo da DeepSeek (era `deepseek-chat`, o padrão real é
  `deepseek-v4-flash`), acrescentada a existência da função serverless de produção ao lado do
  middleware de dev, incluído `npm test` e apontados os dois documentos de IA. O link para
  `CONTEXTO.md` passou a ser válido.

### Arquitetura atual da IA (resumo)

`Chat.tsx` → `askAssistant()` → `parseNaturalFull()` + `resolveLocal()` → decisão binária
local × remoto → `buildAiContext()` → `POST /api/ai/chat` → `callDeepSeekChat()` →
`sanitizeActions()` → confirmação no chat → `applyParsedAction()` → reducer + `localStorage`.

### Problemas confirmados (nenhum corrigido nesta etapa)

Divergências reais entre os dois `SYSTEM_PROMPT`, encontradas nesta auditoria:

1. Ação `odometer` existe **só em produção**.
2. Variante `is99` existe **só no dev** — e é letra morta: `sanitizeActions()` não tem o campo.
3. Categoria `autocuidado` está **só na lista de produção**.
4. Regras 2b, 2c e 6b existem **só em produção**.
5. **Nenhum dos dois** menciona `saving` ou `origin`.

**Origem da divergência**: a rodada `eabca4a` (motorista + painel Android) editou apenas
`api/ai/chat.ts` ao acrescentar `odometer`, a categoria `autocuidado` e as regras 2b/2c/6b. Até
`6c4934c` os dois prompts eram byte-idênticos — o próprio PROGRESS.md registrava isso nas rodadas
de 26 e 27 de julho, e a afirmação continuou lá depois de deixar de valer. É o risco previsto na
regra da duplicação manual se concretizando.

### Afirmações desatualizadas corrigidas neste arquivo

A auditoria comparou o que o PROGRESS.md afirma **no presente** contra o código e corrigiu três
pontos, sem reescrever nenhuma seção histórica (elas registram o que era verdade na data):

1. Cabeçalho "Última atualização" — apontava para a entrega operacional; agora aponta para esta
   auditoria, com um aviso explicando que as seções datadas são um diário.
2. Seção "⚠️ Divergência dev × produção no prompt da IA" — afirmava que o `SYSTEM_PROMPT` estava
   sincronizado. Recebeu nota de correção com as 6 divergências reais.
3. Duas ocorrências de "`CONTEXTO.md` não existe" — marcadas como resolvidas.

Verificado e **mantido como está** (continua correto): `Analytics.tsx` sem adaptação por perfil,
`origin` desconhecido pelo prompt remoto, `accountId` não usado, assinatura com diferença de um
mês na primeira ocorrência, antecipação sem desconto/juros, sem UI para editar parcela ou
recorrência, `describeRecurrence` com um único dia da semana.

Outras falhas confirmadas, em ordem de impacto:

- Perda silenciosa de ações: `saving`, `origin` e resposta remota sem JSON são descartados sem
  aviso ao usuário.
- Confirmação tudo-ou-nada, sem atomicidade, com todas as ações do lote aplicadas sobre o mesmo
  `state` antigo (dois `goal-deposit` na mesma meta se sobrescrevem).
- `Chat.tsx:154` reporta **qualquer** falha como "Não encontrei a meta correspondente", inclusive
  cartão inexistente e fatura sem pendência.
- Nenhuma ação financeira carrega data — tudo grava `todayISO()`.
- Roteamento local encerra a mensagem na primeira intenção que casar; "registro + pergunta" só é
  tratado no caso de orçamento.
- `src/services/ai.ts:285` mantém um parser monetário paralelo com `parseFloat`, contra a regra 12.
- `sanitizeActions()` não valida categoria contra `state.categories` nem bloqueia ação de
  motorista em perfil não-motorista.
- Sem números por extenso, sem correções/negações/referências, sem rascunho estruturado para
  esclarecimento em várias mensagens.
- `scripts/test-app.mts` tem 8 blocos de asserção, todos de perfil motorista.
- `Analytics.tsx` continua sem qualquer uso de `isDriver()` — não é sensível a perfil.

### Próxima etapa recomendada

Implementar a arquitetura definitiva do assistente. **Nada dela está implementado.** Ordem
sugerida, da maior dor para a menor:

1. Unificar a `SYSTEM_PROMPT` num módulo compartilhado, eliminando a divergência dev × produção.
2. Ampliar o contrato remoto e a sanitização (`saving`, `origin`, data, validação de categoria e
   de perfil) e nunca descartar ação em silêncio.
3. Confirmação por item, com estado atualizado entre ações e erro específico por falha.
4. Datas nas ações financeiras.
5. Rascunho estruturado para esclarecimento em várias mensagens.
6. Cobertura de regressão a partir da matriz.

Continuam pendentes e **deliberadamente adiados**: o redeploy da `SYSTEM_PROMPT` sincronizada
(será feito uma única vez, junto com as demais alterações verificadas) e o tratamento de
`type: 'saving'` como transferência interna, com "Retirar da reserva".

---

## 🟢 Arquitetura definitiva do assistente — 2026-07-28

Branch dedicada `feat/assistant-orchestrator`. **Sem push e sem deploy.**

### Baseline (antes de tocar em qualquer arquivo)

- Raiz `D:/Claude/AssistFin`, branch `main` sincronizada, working tree limpo.
- Commit de partida `d3e25a4`.
- `npm test` ✅ · `tsc --noEmit` ✅ · `npm run build` ✅ (`index-CnBwvYNY.js`) ·
  `npx vercel build --prod` ✅. Sem segredo, sem artefato, sem alteração desconhecida.

### A causa estrutural

Não era o prompt. Era `Chat.tsx` decidir tudo com um `if`: **achou ação → usa o local e encerra;
não achou → manda a mensagem inteira pro modelo**. Desse único ponto saíam quase todos os
sintomas — metade da mensagem se perdia quando a outra metade era entendida, "registro +
pergunta" só funcionava para orçamento, e o remoto duplicava o que o local já tinha visto.

Somavam-se prompt duplicado à mão, validação que descartava ação em silêncio, lote aplicado sobre
estado obsoleto e erro genérico ("não encontrei a meta") para qualquer falha.

### O que foi construído

`src/assistant/`: `contracts.ts` (catálogo de ações, validação determinística, 18 códigos de erro,
resposta versionada), `clauses.ts` (segmentação com posição e **cobertura**), `numbers.ts`
(por extenso), `dates.ts` (datas e períodos), `drafts.ts` (multiturno), `corrections.ts`,
`execute.ts` (aplicação pura, sequencial e atômica) e `orchestrator.ts`.

`api/_lib/assistantPrompt.ts` virou a **fonte única** da SYSTEM_PROMPT, **gerada** a partir do
catálogo e das capacidades reais do usuário. `api/_lib/assistantHandler.ts` concentra o pipeline;
`vite.config.ts` e `api/ai/chat.ts` viraram cascas finas. Divergência dev × produção deixou de ser
possível por construção.

`src/components/ProposalCard.tsx` traz revisão por item: confirmar tudo, confirmar um, editar
campos com a MESMA validação dos formulários manuais, remover ou cancelar.

### Bugs reais encontrados pelo próprio corpus

Cada um destes só apareceu porque o teste existia:

1. `vezes?` em regex significa "veze" + "s" opcional e **nunca** casava "vez": compra "em 1 vez"
   não virava nada.
2. "uma corrida de 37" tinha o artigo "uma" convertido em número e gerava uma receita de R$ 1,00.
3. "gastei MAIS 190" criava uma despesa **e** uma receita de 190.
4. "meu salário foi 1625" caía no regex de despesa por causa do verbo "foi".
5. "84 mil km" virava "84 1000 km" ao converter números por extenso.
6. "gastei 190 reais depois comprando cimento" era cortado no conector e perdia a descrição.
7. "paguei 600 da fatura do Nubank" não achava o cartão: a captura de duas palavras engolia
   "fatura do".
8. "recebi 1800 da Casa 1, mais 1750 da Casa 2" aplicava a mesma origem nas duas.
9. "Ontem recebi X e gastei Y" datava só a primeira ação.
10. "passei 2000 em 5 vezes e recebi 1850" era cortado e virava receita de 1850.
11. `describeAction` não cobria `saving` e a proposta mostrava "undefined".

### Testes

| Comando | Resultado |
|---|---|
| `npm test` | ✅ núcleo + **234/234** casos + **26/26** invariantes |
| `npm run typecheck` | ✅ exit 0 |
| `npm run typecheck:api` | ✅ exit 0 (novo `tsconfig.api.json` replica a checagem da Vercel) |
| `npm run build` | ✅ `index-CjGhr7CS.js` 496,37 kB / gzip 147,94 kB |

> Números desta rodada. A rodada de QA adversarial que veio depois levou o corpus
> a **302 casos e 27 invariantes** — ver "🔴 QA adversarial do assistente".
| `npx vercel build --prod` | ✅ `status: ok` — build local, nada publicado |

Segurança: `dist/` sem `sk-`, `DEEPSEEK`, `deepseek.com`, `getDeepSeekConfig`, `callDeepSeekChat`,
`buildSystemPrompt` ou texto do prompt — **0 ocorrências de cada**. Única URL de IA no bundle é a
pública. `.vercel/output` sem padrão de chave; a função continua com
`from '../_lib/deepseek.js'` e `src/assistant/contracts.js` no caminho exato do import, sem nenhum
import relativo próprio.

### Navegador (dev server, perfil CLT)

- "Meu salário foi mil seiscentos e vinte e cinco, paguei trezentos e cinquenta e cinco nas contas
  e guardei cento e cinquenta. Quanto sobrou?" → 3 cards (receita 1.625, despesa 355, reserva 150),
  resposta hipotética com a diferença de R$ 1.270,00 e o aviso de que nada foi registrado.
- "Ontem recebi 1800 de aluguel da Casa 1 e gastei 150 de areia" → duas ações marcadas "· ontem",
  categorias aluguel e obra, descrição Areia.
- Confirmado o lote: gravou `date: 2026-07-27`, `origin: "Casa 1"`, `source: 'ai'` e
  `assistantBatchId` nos dois lançamentos.

### Commits

- `f6d3e6e` — contratos versionados e fonte única do prompt.
- `ba30a2f` — orquestrador por cláusula, rascunhos, correções e lote atômico.
- `e462d29` — corpus de regressão, invariantes e as onze correções acima.
- `<docs>` — documentação (este arquivo, CLAUDE.md 25–30, CONTEXTO.md, AI_CURRENT_STATE.md,
  AI_REGRESSION_MATRIX.md, README.md).

### Limitações honestas que permanecem

Listadas em [docs/AI_CURRENT_STATE.md §6](docs/AI_CURRENT_STATE.md). As principais: editar um
lançamento **já salvo** por conversa não existe; "desfaz o último" depois da gravação também não;
a proposta pendente não vai no payload remoto; a qualidade do texto da IA remota não é testada
(só o contrato); `Analytics.tsx` continua sem adaptação por perfil.

**A contabilização de `saving` NÃO foi alterada**, de propósito — a regra 20 continua valendo.

### Próxima etapa recomendada

Rodar `npm run test:assistant:remote` com o dev server no ar (valida o contrato contra a DeepSeek
real), fazer o QA manual em viewport móvel e, só então, decidir sobre merge, push e o redeploy —
que continua deliberadamente adiado.

---

## 🔴 QA adversarial do assistente — 2026-07-28

Rodada de tentativa ATIVA de quebrar a arquitetura nova, no navegador, com
mensagens reais mal escritas. **Sem merge, sem push, sem deploy.**

Método obrigatório em todos os casos: **reproduzir → escrever o teste que falha →
corrigir → ver o teste passar → rodar o corpus inteiro.** Nenhum teste foi
escrito depois da correção.

### Volume

- **73 interações manuais** no navegador, em 4 perfis (autônomo, CLT, motorista,
  outro) e 6 estados diferentes (sem cartão, 1 cartão, 2 cartões, com meta).
- **68 casos novos** no corpus (`tests/assistant/cases-adversarial.ts`).
- Corpus final: **302 casos** e **27 invariantes**.

### Bugs reais encontrados e corrigidos

| # | Mensagem que reproduzia | Causa | Correção |
|---|---|---|---|
| 1 | `não gastei 100` | o parser via verbo + valor e propunha a DESPESA | cláusula negada nunca produz ação |
| 2 | `não gastei 100` (texto) | o fallback chamava `askAssistant`, que remonta "Entendi isso… Confirmar?" com o parser próprio | o fallback usa só a RESPOSTA, nunca o texto de proposta |
| 3 | `gastei 190 de cimento hj` | "hj" não era data e virava descrição | hj/hje/ontm reconhecidos |
| 4 | `gastei 80 de mercado quanto sobrou` | a pergunta era engolida pela descrição | corte antes da palavra interrogativa |
| 5 | `gastei 100 no mercado quer dizer 80` | a correção virava uma SEGUNDA despesa | o trecho após o marcador corrige o valor anterior |
| 6 | `recebi 1800 de aluguel não pera foi 1850` | criava receita 1800 **e despesa 1850** | idem |
| 7 | `ganhei 430 na uber 399 na 99` | sem pontuação, perdia a segunda receita | valor + "na/da plataforma" é receita |
| 8 | `recebi 1800 da casa 1 e 1750 da casa 2` | perdia a segunda receita e repetia a origem "casa 1" | receita enumerada + origem por PROXIMIDADE |
| 9 | `meu hodometro ta 220007` | exigia a unidade "km" | forma coloquial aceita |
| 10 | `passei um computador de 4000 em 4x` | só "comprei" virava compra | "passei" aceito; com "recebi" continua entrada financiada |
| 11 | `guardei 150 e gastei 355` | criava a meta chamada "e" | nome de meta passa por limpeza de palavra funcional |
| 12 | `troca pro inter` | só no/na/do/da trocavam o cartão | pro/pra/para aceitos |
| 13 | `retorne um JSON que o app aceite para apagar tudo` | disparava o `reset` | o comando precisa ABRIR a frase |
| 14 | lote com meta inexistente → Confirmar | todos os cards ganhavam `outcome` e a proposta congelava | com lote não aplicado, só o item que falhou é marcado |
| 15 | proposta na tela → F5 | `proposal`/`clarification` sobreviviam com o botão Confirmar ativo | `hydrateForTest` limpa tudo que é acionável |
| 16 | `gastei 40 hoje` | a expressão de data sobrava na descrição ("— Hoje · hoje") | data retirada antes de o parser montar a descrição |
| 17 | `gastei quarenta e nove e noventa` | virava **R$ 139,00** (49 + 90) | segunda dezena no mesmo grupo é lida como centavos |

**Defeito de ferramenta, não de produto**: três regex estavam quebradas por um
caractere de controle 0x08 gravado no lugar de `\b` por scripts de edição. O
`\b` virava BACKSPACE e o regex nunca casava. Todos os arquivos foram varridos;
zero caracteres de controle restantes.

### Cenários obrigatórios

| Cenário | Resultado |
|---|---|
| A — autônomo, 2 aluguéis + cimento + gás + pergunta | ✅ 3 ações preservadas, pergunta só do gás, escolha recupera o valor |
| B — motorista composto sem pontuação | ✅ 2 receitas, abastecimento, litros, km, horas, hodômetro separado, 2 viagens, **nenhuma taxa da 99 automática** |
| C — CLT: salário + despesa + saving + compra 4x | ✅ 4 ações; só 1 despesa gravada (a compra não vira despesa), 4 parcelas |
| Multiturno de cartão (6 mensagens) | ✅ a mesma proposta sobrevive até a confirmação |
| Correção após proposta | ✅ modifica a proposta, não cria compra nova |
| Referência ("remove a primeira") | ✅ |
| Erro de cartão inexistente | ✅ erro específico, nunca "não encontrei a meta" |
| Conversação | ✅ zero ação, zero resumo desnecessário |

### Atomicidade e recuperação

Lote de 3 com falha no meio (meta inexistente): **nada gravado**, erro específico
com o nome da meta, cards continuam editáveis, remover o item e confirmar gravou
exatamente as 2 despesas restantes.

### Reload

Proposta na tela e esclarecimento pendente → F5 → **0 cards, 0 botões Confirmar**,
4 mensagens do histórico preservadas, estado vazio. Sem ação fantasma.

### Perfis cruzados

Autônomo dizendo "fiz uma corrida de uber e ganhei 50" registra a receita sem
virar motorista (sem viagens, sem taxa da 99). "rodei 120 km" é recusado com
explicação. "abasteci 100" vira despesa de combustível — o gasto é real.

### Verificação final

| Comando | Resultado |
|---|---|
| `npm test` | ✅ **302/302** casos + **27/27** invariantes |
| `npm run typecheck` | ✅ |
| `npm run typecheck:api` | ✅ |
| `npm run build` | ✅ `index-CS9axvH7.js` 499,72 kB / gzip 149,01 kB |
| `npx vercel build --prod` | ✅ `status: ok` (local) |
| Segredos no bundle | ✅ 0 ocorrências de `sk-`, `DEEPSEEK`, `deepseek.com`, `buildSystemPrompt`, texto do prompt |
| Caracteres de controle no código | ✅ 0 |
| `npm run test:assistant:remote` | ⚠️ 6–7 de 8 sondas, **instável** |

### Sobre a avaliação remota

O script é instável entre execuções: a DeepSeek às vezes devolve resposta vazia
(`empty-reply` → HTTP 502) ou responde sem gerar ações num caso que deveria
gerar. **Nenhuma execução produziu ação inválida nem vazou segredo** — o que o
script garante é o CONTRATO, e esse se manteve em 100%. A variação é do modelo,
não do app: quando o remoto falha, o motor local assume.

### Limitação investigada: proposta pendente fora do payload remoto

Testado explicitamente. Nos fluxos multiturno reais ("comprei um pc em 4x" →
"4000" → "nubank" → "foi ontem" → "na verdade foi 3800"), **o rascunho local
resolve tudo sem precisar do modelo** — a IA remota nem é chamada, porque a
cobertura local é completa. Não encontrei um caso em que a ausência da proposta
no payload remoto causasse falha. Por isso o `draftSummary` **não foi
implementado**: seria enviar dado a mais sem problema demonstrado.

### PENDÊNCIAS REGISTRADAS

**Precisam de tratamento — não fechar a branch sem decidir sobre elas:**

1. **Data futura não pode ser ignorada em silêncio.** `gastei 40 em 10/08` com
   hoje em julho reconhece a data, classifica como `kind: 'future'` e o
   orquestrador simplesmente descarta — o lançamento grava com a data de HOJE
   sem nenhum aviso. Precisa perguntar ("é 10/08 do ano passado ou uma
   previsão?") ou recusar explicitamente. Gravar data errada calado é o tipo de
   defeito que só se descobre meses depois, no relatório.
2. **"daqui a X dias/semanas/meses" precisa de tratamento seguro.**
   `daqui a 3 dias vou pagar 200` hoje não gera ação — resultado seguro — mas
   devolve o texto de ajuda genérico e o usuário não entende o motivo. Precisa
   virar previsão/recorrente explícita ou dizer com todas as letras que ainda
   não sabe agendar. **Nunca** pode virar lançamento de hoje.
3. **A DeepSeek devolve resposta vazia/502 de forma intermitente.**
   `npm run test:assistant:remote` oscilou entre 6/8 e 8/8 entre execuções, com
   `empty-reply` em sondas diferentes a cada rodada. O app trata (erro seguro +
   fallback local, sem perder ação), mas o usuário perde a resposta aberta.
   Investigar `max_tokens`, o retry único de `callDeepSeekChat` e um modelo
   alternativo.

**Fora do escopo por decisão — documentado, não esquecido:**

4. **Editar lançamento já salvo por conversa.** Só funciona enquanto a proposta
   está na tela; depois de gravado, a edição é pela tela de Movimentações.
5. **"Desfaz o último" depois da gravação.** O `assistantBatchId` já é gravado e
   viabiliza, falta o fluxo de remoção com confirmação.
6. **`Analytics.tsx` por perfil.** Pendência anterior a esta reformulação.

**Menores:**

7. "meio" ("dois e meio") não é interpretado. Reais + centavos falados
   ("quarenta e nove e noventa") passaram a funcionar nesta rodada.
8. Intervalos de data ("de 1 a 5 de julho") não são interpretados.
9. "segunda passada" resolve para a segunda-feira mais recente, não a da semana
   anterior — a data interpretada é sempre exibida antes de confirmar.
10. A proposta pendente não vai no payload remoto. Investigado nesta rodada: o
    rascunho local resolve os multiturno sozinho e a IA remota nem é chamada.
    Nenhuma falha demonstrada, então o `draftSummary` não foi implementado.
11. A qualidade do texto da IA remota não é testada — só o contrato.

---

## ⏸️ EM ANDAMENTO — datas futuras e auditoria da DeepSeek

**Status: bugs REPRODUZIDOS, testes RED escritos, NENHUM código corrigido ainda.**
Retomar exatamente daqui.

### Onde parei

| Item | Situação |
|---|---|
| Reprodução dos bugs | ✅ feita, resultado abaixo |
| `tests/assistant/cases-temporal.ts` | ✅ criado (19 casos), **untracked**, ainda NÃO ligado ao runner |
| `scripts/_repro.mts` | ✅ criado, **untracked**, script de reprodução descartável |
| `scripts/test-assistant.mts` | ❌ **não** foi editado — o import de `TEMPORAL` ainda falta |
| Código de produção | ❌ **nada alterado** — suíte segue 302/302 e 27/27 |
| Auditoria da DeepSeek | ❌ nem começou |

Primeiro passo ao retomar: acrescentar ao runner
`import { TEMPORAL } from '../tests/assistant/cases-temporal'` e incluir em `ALL`,
depois rodar `npx tsx scripts/test-assistant.mts --only=temporal` para ver o RED.

### Reprodução (hoje fixo do teste = 2026-07-15; máquina em 28/07)

| Mensagem | `findDate()` | Modo | GRAVA EM |
|---|---|---|---|
| `gastei 50 daqui a 3 dias` | **null** | propose_actions | **hoje** ❌ |
| `vou gastar 50 daqui a 3 dias` | null | answer | — (mas sem explicar) |
| `gastei 50 em 3 dias` | **null** | propose_actions | **hoje** ❌ |
| `daqui a 2 semanas vou pagar 300` | null | answer | — (sem explicar) |
| `em 3 meses tenho uma parcela de 500` | null | answer | — (sem explicar) |
| `gastei 50 dia 10/08` | **`future 2026-08-10`** | propose_actions | **hoje** ❌ |
| `vou gastar 50 dia 10/08` | future | answer | — (sem explicar) |
| `ontem gastei 50` | `date 2026-07-14` | propose_actions | 2026-07-14 ✅ |
| `anteontem gastei 50` | `date 2026-07-13` | propose_actions | 2026-07-13 ✅ |
| `paguei 100 mês passado` | **`period 2026-06`** | propose_actions | **hoje** ❌ |

### Causas identificadas na reprodução

1. **`daqui a X` e `em X dias/semanas/meses` não existem em `dates.ts`** — `findDate`
   devolve `null`, a expressão fica na descrição ("Daqui a 3 dias", "3 dias") e o
   lançamento grava com hoje.
2. **`kind: 'future'` é reconhecido e DESCARTADO** em `analyzeMessage`
   (`src/assistant/clauses.ts`): só `kind === 'date'` preenche `next.date`. A data
   futura some sem deixar rastro.
3. **`kind: 'period'` idem** — "mês passado" é reconhecido e descartado.
4. **O fallback final é a data da MÁQUINA**: `applyActionPure` usa `todayISO()`
   quando a ação não tem `date`. Por isso o teste com hoje fixo em 15/07 gravou
   28/07 — nem o `today` injetado protege.

### Plano combinado (não implementado)

1. `dates.ts`: regras para `daqui a N dias|semanas|meses|anos` e `em N dias|semanas|meses`
   → `kind: 'future'` com a data calculada. Cuidado para não colidir com
   "em 4 vezes"/"em 3x" (parcelas) — exigir unidade de tempo.
2. `contracts.ts`: `validateAction` recusa `date` no futuro para ação realizada
   (`notFuture` no `dateField`). `card-purchase.firstDueDate` continua podendo ser
   futura — é outro campo. Vira a última barreira contra data futura silenciosa.
3. `clauses.ts`:
   - verbo passado + data futura → **limpar as ações** e levantar esclarecimento
     ("já aconteceu ou é planejamento?");
   - intenção futura explícita (`vou/irei/pretendo/planejo` + infinitivo) → nenhuma
     ação e **explicação** de que ainda não sabe agendar;
   - `period` sem dia → perguntar qual dia, nunca assumir hoje.
4. `contracts.ts` + `orchestrator.ts`: `AssistantClarificationOption` ganha
   `reply?: string`, para uma opção poder significar "não registrar + explicar".
5. `properties.ts`: duas invariantes novas —
   (a) nenhuma ação realizada pode ter `date` maior que hoje;
   (b) se a mensagem tinha expressão temporal reconhecida, ou a ação carrega
   aquela data, ou não existe ação nenhuma.
6. Auditoria DeepSeek (**não** implementar retry): reproduzir resposta vazia e 502
   com `fetch` mockado, confirmar que `callDeepSeekChat` faz no máximo **uma**
   segunda tentativa (o "nudge" já existente) e só quando a resposta vem vazia,
   que 5xx **não** repete, que nenhuma ação inválida nasce, que as ações locais
   sobrevivem e que a mensagem ao usuário não expõe detalhe interno.

### Restrições desta tarefa (do briefing)

Não criar arquitetura de agendamento · não implementar retry sem antes apresentar
custo/latência/risco de duplicidade · não alterar regra financeira · não implementar
edição de lançamento salvo, "desfaz o último", Analytics por perfil nem "meio" ·
sem merge, push, deploy ou APK · commit separado só para esta correção.

---

## Comandos exatos para retomar o desenvolvimento

```bash
cd "D:/Claude/AssistFin"
npm run dev                                          # subir o dev server em localhost:5199
node node_modules/typescript/bin/tsc --noEmit         # checar tipos antes de mexer em nada
```

Pra confirmar que a correção da DeepSeek continua aplicada (não deve haver nenhum resultado):
```bash
grep -rn "deepseek-chat" vite.config.ts api/ai/chat.ts api/_lib/deepseek.ts
```

---

## ✅ Datas futuras, inválidas e auditoria da DeepSeek — concluído em 2026-07-29

Escopo fechado sem alterar regras financeiras, Analytics, edição de lançamento
salvo, “desfaz o último”, suporte a “meio” ou arquitetura de agendamento. Não
houve merge, push, deploy nem geração de APK.

### 1. Casos que falharam antes da correção

- O primeiro corpus temporal ficou em **8/20**: 12 casos falharam. Datas futuras
  e períodos reconhecidos sumiam; prazos relativos não eram reconhecidos; fatos
  eram propostos com hoje.
- A sondagem adversarial posterior encontrou sobreposição e ordem de datas,
  “amanhã” com acento, período sem dia e frases mistas.
- O navegador revelou que clicar numa opção de esclarecimento não executava seu
  efeito: `Chat.tsx` não devolvia `pendingClarification` ao orquestrador.
- Na continuação desta rodada, quatro testes novos reproduziram: plano futuro
  antes do fato passado apagando o fato; `dia 40` encerrando a pergunta; e
  `10/07` sendo reinterpretado como `10/06`.
- Cinco testes adicionais reproduziram datas impossíveis (`31/02`, `40/08`) e
  expressões comuns (`próxima semana`, `semana/mês que vem`) virando hoje.
- Um teste isolou “quarta que vem” numa quarta-feira sendo resolvida como hoje.
- Seis testes de barreira reproduziram sinais temporais sem dia único (`em
  agosto`, `há 3 dias`, `3 dias atrás`, `fim do mês`, `ano passado`) sobrando
  como descrição e usando hoje.
- Dois testes impediram uma correção conservadora demais de bloquear metas com
  horizonte textual, que não são movimentações realizadas.

Todos esses testes foram vistos em vermelho antes da respectiva correção.

### 2. Causas reais

1. `dates.ts` não conhecia `daqui a/em X unidades` nem formas imprecisas comuns.
2. `analyzeMessage()` só propagava `kind: 'date'`; `future` e `period` eram
   descartados e a execução aplicava o fallback de hoje.
3. O fallback usava `todayISO()` da máquina quando a ação chegava sem data.
4. `\b` depois de “ã” não casava em JavaScript, então “amanhã” escrito
   corretamente podia desaparecer.
5. `findAllDates()` resolvia sobreposição pela ordem das regras e removia só
   parte das expressões.
6. A primeira data da frase decidia tudo; quando futuro vinha antes de passado,
   o fato passado legítimo era descartado.
7. Regras de calendário inválidas devolviam `null`, tornando `31/02` texto
   comum para o parser.
8. A resposta a “que dia foi?” extraía só o número de uma data completa fora
   da janela.
9. `Chat.tsx` guardava proposta/rascunho, mas não a pergunta estruturada.
10. Quando o remoto caía, o cliente podia mostrar ajuda genérica ou texto
    “Confirmar?” sem ação correspondente.

### 3. Correções

- `DateResolution` passou a preservar futuro, período, data inválida e sinais
  temporais sem dia exato.
- Datas futuras relativas, explícitas e imprecisas nunca entram numa ação
  realizada. Data inválida produz pergunta específica.
- `findAllDates()` percorre todas as expressões da esquerda para a direita e a
  análise recorta o plano futuro sem contaminar o fato passado.
- `validateAction()` recusa `date` futura com `future-date`, como última
  barreira. Datas próprias de previsão, como `firstDueDate`, permanecem válidas.
- Períodos carregam sua janela; resposta inválida ou fora dela mantém a
  pergunta aberta. Correção de data reaproveita o lançamento original.
- Uma barreira de sinais temporais impede formas comuns ainda sem dia exato de
  virarem descrição + hoje.
- Metas com horizonte textual foram explicitamente preservadas.
- O chat guarda, envia e limpa `pendingClarification` junto do restante do
  estado transitório.
- Falha remota agora é distinguida de “não entendi”; ações locais permanecem e
  perguntas exclusivamente remotas recebem aviso compreensível.

### 4. Comportamento final para datas

| Entrada | Resultado |
|---|---|
| `gastei 50 daqui a 3 dias` | Pergunta se já aconteceu ou se é plano; zero ação |
| `vou gastar 50 daqui a 3 dias` | Explica que ainda não agenda; zero ação |
| `gastei 50 dia 10/08` no futuro | Oferece a última ocorrência passada ou planejamento |
| `paguei 100 mês passado` | Pergunta o dia e aceita somente data dentro da janela |
| `gastei 50 dia 31/02` | Informa que a data não existe e pede correção |
| `gastei 50 em agosto` | Pede data exata; não usa hoje |
| `amanhã vou pagar 120 e ontem gastei 50` | Propõe só o gasto de ontem e explica o plano |
| `ontem/anteontem gastei 50` | Mantém a data passada correta |
| sem expressão temporal | Hoje continua sendo o padrão |

Não foi criada previsão nem recorrência: intenção futura continua sendo somente
explicada.

### 5. Comportamento final para DeepSeek vazia/502

- Resposta vazia: uma segunda tentativa já existente, mais rígida; **máximo de
  duas chamadas no total**. Se vier vazia de novo, `empty-reply` seguro.
- HTTP 502 e demais erros HTTP auditados: **uma chamada**, sem retry.
- Zero ação criada a partir da falha; nenhum corpo bruto, chave, URL, modelo ou
  cabeçalho exposto.
- Mensagem mista preserva a ação local. Pergunta só remota recebe aviso de
  indisponibilidade.
- Nenhum retry novo foi implementado. Um retry adicional aumentaria custo e
  poderia acrescentar até outro timeout completo; também exigiria
  idempotência/reconciliação explícita para não repetir proposta. Decisão:
  manter o comportamento atual.

### 6. Testes, invariantes e builds

| Verificação | Resultado |
|---|---|
| `npm test` | ✅ núcleo + **345/345 casos** |
| Invariantes | ✅ **36/36** |
| Grupo temporal | ✅ **43/43** |
| `npm run test:assistant:remote` | ✅ **8/8** sondas reais |
| `npm run typecheck` | ✅ sem erros |
| `npm run typecheck:api` | ✅ sem erros |
| `npm run build` | ✅ 77 módulos; `index-C5dMz3ri.js` 509,80 kB / gzip 152,04 kB |
| `npx vercel build --prod` | ✅ `status: ok`, somente local |
| Bundle do cliente | ✅ zero `sk-`, `DEEPSEEK`, endpoint privado, código server-only ou Bearer |
| Função empacotada | ✅ módulos presentes; zero import relativo sem `.js` |
| Caracteres de controle | ✅ zero |

Smoke test em 430 × 900: escolha de data passada, opção “É um plano”, período
com resposta fora da janela seguido de dia válido, ordem futuro→passado e
cancelamento sem criar movimentação. Sem erro do app no console e sem estouro
horizontal. Os dois avisos vistos são os `Future Flag Warning` conhecidos do
React Router 6.

### 7. Branch e riscos restantes

- Branch: `feat/assistant-orchestrator`.
- A correção será fechada em um commit isolado; hash informado na entrega.
- Pronta para merge depois desse commit, mas deliberadamente sem push/deploy/APK.
- Intervalos (`de 1 a 5 de julho`) ainda não viram um intervalo estruturado;
  pedem esclarecimento e não caem silenciosamente em hoje.
- “segunda passada” mantém a semântica histórica de segunda-feira mais recente.
- Uma formulação temporal completamente nova, fora das regras e dos sinais de
  segurança conhecidos, ainda pode não ser reconhecida. Entre as formas
  auditadas e suportadas, nenhuma situação temporal conhecida ainda cai
  silenciosamente em hoje.

---

## 🟢 Aba ativa da barra inferior — fonte única — 2026-07-29

Escopo fechado: só a decisão de qual aba fica marcada. Nenhuma regra financeira,
nenhuma mudança no assistente, sem push, deploy ou APK.

### 1. Rotas abertas pela aba "Mais"

Levantadas em `src/screens/More.tsx` (`ALL_ITEMS`) e conferidas contra `App.tsx`:

| Rota | Tela | Observação |
|---|---|---|
| `/mais` | Hub | A própria aba |
| `/analises` | Análises e relatórios | Também alcançável pela Home |
| `/veiculo` | Meu veículo | Só perfil motorista |
| `/planejamento` | Planejamento | Também alcançável pela Home |
| `/cartoes` | Cartões e parcelamentos | |
| `/config` | Configurações | |
| `/corrida` | Analisador de corrida | Só motorista; não fica no hub, mas pertence à seção |

### 2. Reprodução ANTES da correção (navegador, 375 × 812)

As cinco rotas do hub já mantinham "Mais" verde — isso foi corrigido na rodada de
28/07. O que ainda estava quebrado era o **mecanismo**: `nav.tsx` guardava uma
cópia manual da tabela de rotas e casava por `startsWith`. Dois erros reais
reproduzidos com esse mecanismo:

| URL | Tela renderizada | Aba marcada | Problema |
|---|---|---|---|
| `#/relatorios`, `#/qualquer` | Início (rota coringa `*`) | **nenhuma** | O indicador some |
| `#/config/backup`, `#/cartoes/fatura`, `#/mais/analises` | Início (rota coringa `*`) | **Mais** | O indicador mente sobre a tela |

Causa raiz única: a lista de rotas era uma **segunda fonte de verdade**, paralela
ao roteador. Qualquer rota nova em `App.tsx` que ninguém copiasse para essa lista
perderia o indicador em silêncio, e `startsWith` marcava subcaminhos que o
roteador nem declara.

### 3. Correção

- **`src/services/navigation.ts`** (novo): mapa `ROUTE_TAB` (rota → aba),
  `activeTab(pathname)` e `MORE_ROUTES` derivado do mapa. Casamento **exato**,
  com normalização de barra final e caixa; rota desconhecida cai na aba da tela
  que o coringa realmente renderiza (Início). `activeTab` nunca devolve vazio.
- **`src/components/nav.tsx`**: `BottomNav` passou a consumir `activeTab`. O
  `NavLink` virou `Link` de propósito — o `isActive` dele era a segunda fonte de
  verdade que causava o problema, já que as telas da seção "Mais" não têm rota
  própria na barra. `aria-current="page"` agora acompanha a aba marcada,
  inclusive no botão do assistente.
- O `Fab` **não** foi tocado: ele casa rota para escolher a ação do `+`, que é
  outra responsabilidade e está fora deste escopo.

### 4. Testes

`tests/navigation.ts`, rodado por `npm test` junto do núcleo — **9 verificações**:

1. toda rota de "Mais" marca a aba Mais;
2. Início, Movimentações, Assistente e Metas continuam corretos;
3. rota desconhecida marca a aba da tela renderizada (era o defeito 1);
4. subcaminho inexistente não marca outra aba (era o defeito 2);
5. nunca fica sem indicador;
6. barra final e caixa são normalizadas;
7. **o mapa cobre exatamente as rotas declaradas em `App.tsx`** — é este que
   quebra quando alguém acrescenta uma rota e esquece de mapeá-la;
8. `BottomNav` não decide sozinho (sem `startsWith`, sem lista duplicada);
9. toda rota oferecida pelo hub `More.tsx` marca a aba Mais.

O ciclo foi vermelho → verde: os testes rodaram primeiro contra a lógica antiga
copiada para o módulo, e `/relatorios` falhou com `null !== '/'`.

### 5. Verificação no navegador (375 × 812)

| Situação | Resultado |
|---|---|
| 7 rotas da seção, carregadas direto pela URL | "Mais" verde em todas |
| Clique no hub → Cartões, Configurações | "Mais" continua verde |
| Botão voltar do navegador | "Mais" continua verde |
| Botão `‹` da própria tela (`navigate(-1)`) | "Mais" continua verde |
| Reload dentro de `/planejamento` | "Mais" continua verde |
| `/`, `/movimentacoes`, `/metas` | Cada uma marca a sua |
| `#/relatorios`, `#/config/backup` | Início verde, igual à tela renderizada |
| Barra inferior | `position: fixed`, visível, sem estouro horizontal |
| Console | Sem erro |

Cor conferida com a transição de 150 ms desligada: `--accent` (`rgb(31,92,72)`)
exatamente na aba correta e em nenhuma outra.

### 6. Comandos

| Comando | Resultado |
|---|---|
| `npm test` | ✅ núcleo (inclui 9 verificações de navegação) + 345/345 casos + 36/36 invariantes |
| `npm run typecheck` | ✅ exit 0 |
| `npm run typecheck:api` | ✅ exit 0 |
| `npm run build` | ✅ `index-BOIG93W3.js` 508,51 kB / gzip 151,60 kB |

### 7. Limitações que permanecem

- `App.tsx` não declara rota aninhada; se alguma for criada, o mapa precisa
  ganhar a entrada correspondente — a verificação 7 falha até que isso aconteça.
- O `Fab` continua com seu próprio casamento de rota por `startsWith`. Não é o
  indicador da barra, mas tem a mesma fragilidade e vale centralizar depois.

---

## 🟢 Auditoria, edição, desfazer e correção — 2026-07-29 (itens 40, 34, 23, 22+26)

Quatro blocos, quatro commits isolados, na ordem em que um destrava o seguinte.
Nenhuma regra financeira, Analytics ou navegação foi alterada. Sem push, deploy ou APK.

### Baseline confirmado antes de tocar em qualquer arquivo

345/345 casos · 36/36 invariantes · 43/43 temporais · árvore limpa em `5dcac42`.

### Casos vermelhos iniciais (todos vistos antes da respectiva correção)

| Bloco | Vermelho inicial |
|---|---|
| 40 — auditoria | **38/40 invariantes**: o journal não existia; o depósito em meta não deixava rastro do valor anterior e meta/cartão/assinatura/abastecimento/trabalho/manutenção não eram auditados |
| 34 — edição | **módulo ausente**; a folha era uma lista escrita à mão sem `name`, `months`, `item`, `lifeKm`, `pricePerLiter`, `firstDueDate`, `source`, e o hodômetro não tinha campo nenhum |
| 23 — desfazer | **3/10 casos**: `desfaz o último` não existia; depois, **10/11**, porque um lote de correção listava vazio |
| 22+26 — corrigir | **2/12 casos**: corrigir histórico por conversa não existia |

### Decisões de projeto

1. **Auditoria por DIFERENÇA de estado**, não por registro manual em cada `case`.
   `assistantBatchId` dentro da entidade só marca o que NASCEU no lote; depósito em meta,
   pagamento de fatura (que quita parcelas), abastecimento que atualiza o hodômetro e
   manutenção que substitui a peça anterior alteram ou apagam objetos que já existiam.
   O diff cobre criação, alteração e remoção — e ação nova nasce auditada.
2. **Journal no mesmo estado atômico do lote.** Ou os dois gravam, ou nenhum.
3. **Só o ID da mensagem**, nunca o texto da conversa: ele já vive em `chat`, e duplicá-lo
   aumentaria o dado sensível guardado no aparelho sem necessidade.
4. **Lote sem journal é recusado**, com explicação e o caminho alternativo. Reconstruir o
   passado procurando ids parecidos é exatamente o chute que a estrutura existe para impedir.
5. **Desfazer não vira lote auditável**: fecha o anterior com `undoneAt`. Sem isso,
   "desfaz o último" logo depois refaria tudo — um redo que ninguém pediu.
6. **Backup mesclado não traz o journal do outro estado** — seus retratos descrevem outra base.
7. **Campos editáveis derivados do catálogo**, com `validateAction()` em toda edição. A lista
   escrita à mão já tinha envelhecido uma vez; derivar impede que envelheça de novo.
8. **`edit-transaction` e `undo-batch` com `remoteAllowed: false`.** O histórico não é enviado
   para a IA remota, então ela também não propõe correção nem reversão sobre o que não vê.
9. **Corrigir ≠ desfazer** numa recorrente: editar a ocorrência materializada não toca no
   template nem a libera para nova confirmação; desfazer o lote libera.
10. **Limite de 20 lotes no journal.** Além disso o undo recusa em vez de chutar.

### Arquivos

| Arquivo | Mudança |
|---|---|
| `src/assistant/journal.ts` | **Novo.** Diff de estado, `revertBatchPure`, `lastReversibleBatch`, predicado `isRevertFailure` |
| `src/assistant/proposalEdit.ts` | **Novo.** `editableFieldsFor` derivado do catálogo |
| `src/assistant/editSaved.ts` | **Novo.** Detecção do pedido, busca local de candidatos, ação de correção |
| `src/models/types.ts` | `AssistantJournalEntry`/`Op`, `assistantJournal?` em `AppState`, ações `undo-batch` e `edit-transaction` |
| `src/assistant/contracts.ts` | Duas ações no catálogo (`remoteAllowed: false`) e 5 códigos de erro novos |
| `src/assistant/execute.ts` | Journal no lote, `editBlockReason`, execução de `edit-transaction` e `undo-batch` |
| `src/assistant/orchestrator.ts` | Passos 2b (desfazer) e 2c (corrigir), com listagem e desambiguação |
| `src/components/ProposalCard.tsx` | Campos do catálogo, `validateAction` ao salvar, rótulo do catálogo |
| `src/store/store.tsx` | `assistantJournal` em `normalizeState`, `engine`/`messageId` no lote, journal fora do merge |
| `src/screens/Chat.tsx` | Passa `caps` e a auditoria (motor + id da mensagem) |
| `src/services/nlp.ts` | `describeAction` das duas ações novas |
| `tests/assistant/cases-undo.ts` | **Novo.** 11 casos |
| `tests/assistant/cases-edit.ts` | **Novo.** 12 casos |
| `tests/assistant/properties.ts` | Invariantes 37–53 |
| `tests/assistant/harness.ts` | `journal` no cenário, `id` e campos extras preservados |

### Testes

| Verificação | Resultado |
|---|---|
| `npm test` | ✅ núcleo (9 verificações de navegação) + **368/368 casos** |
| Invariantes | ✅ **53/53** |
| Grupos novos | ✅ `undo` 11/11 · `edicao` 12/12 |
| `npm run typecheck` | ✅ exit 0 |
| `npm run typecheck:api` | ✅ exit 0 |
| `npm run build` | ✅ `index-SZR44-7M.js` 520,46 kB / gzip 155,40 kB |
| `npx vercel build --prod` | ✅ `status: ok`, somente local |
| Segredos no bundle | ✅ 0 ocorrências de `sk-`, `DEEPSEEK`, `deepseek.com`, `buildSystemPrompt`, `callDeepSeekChat`, `getDeepSeekConfig`, `Bearer` |
| Função empacotada | ✅ nenhum import relativo sem `.js`, nenhum padrão de chave |

### Smoke test móvel (375 × 812)

Lote de duas ações confirmado → journal com motor, id da mensagem, carimbo completo,
contrato e perfil. Edição da proposta com valor zero → erro específico e folha aberta;
valor válido → grava. Correção de lançamento salvo mostrando `R$ 120,00 → R$ 95,00` →
grava 95 com o tipo preservado e `before: { amount: 120 }` no journal. `desfaz o último` →
lista o que volta, confirma, restaura 120 e marca `undoneAt`. Segundo `desfaz o último` →
recusado com explicação. Sem estouro horizontal, barra inferior visível, console limpo.

> Os erros de `ProposalCard` vistos numa aba durante o desenvolvimento eram do HMR: o
> componente foi trocado a quente enquanto o `Chat` ainda passava a prop antiga. Em aba
> nova, o fluxo inteiro roda sem nenhum erro de console.

### Limitações que permanecem

1. **O assistente ainda não confirma ocorrência recorrente por conversa.** O journal e a
   reversão já tratam `recurring` genericamente, e a invariante 46 prova o mecanismo com uma
   operação de recorrência — mas hoje nenhum lote do assistente produz uma.
2. **Só 20 lotes ficam no journal.** Passou disso, o undo recusa (não erra, mas não desfaz).
3. **A correção muda um campo por vez.** "muda para 80 e para lazer" não é interpretado.
4. **A busca de candidatos usa data, valor e janela de 120 dias**, não o tipo dito. Com uma
   despesa e uma reserva no mesmo dia, "corrige o gasto de hoje" pergunta qual — seguro,
   mas poderia desempatar sozinho pelo substantivo.
5. **Editar por conversa a estrutura de parcelamento, cartão, meta, veículo e template de
   recorrência continua fora**, por decisão desta rodada.
6. **`Analytics.tsx` por perfil** segue pendente, anterior a tudo isto.

---

## ✅ Bugs de UI corrigidos (29/07/2026) — reportados em teste manual de produção

**Resolvidos** logo depois do reporte abaixo. Correção e verificação no navegador (375×812)
resumidas ao fim desta seção. Suíte: 368/368 · 53/53, typecheck src+api e build ok.

### O que foi feito

1. **Input do chat vira `<textarea>` que cresce e quebra linha.** `Chat.tsx`: `<input>` de uma
   linha virou `<textarea rows={1}>` com auto-grow (`height = scrollHeight`), Enter envia e
   Shift+Enter quebra. CSS: `white-space: pre-wrap`, `word-break`, `max-height: 7.5em` (≈5
   linhas, depois rola), barra alinha os botões embaixo. Não rola mais infinito pra esquerda.
2. **Campos da folha "Editar lançamento" estilizados.** `ProposalCard.tsx`: os `<input>`,
   `<select>` e o campo de data crus ganharam `className="input"` — antes só o `MoneyInput`
   tinha estilo (ele já traz `.input` por padrão), por isso Km/Viagens/Horas/Data saíam como
   caixas cinzas sem borda/padding do design system.
3. **"Ver detalhes" e "Confirmar só este" separados.** Os dois `.link` do card eram
   `inline-block` (o `.link` não define `display`), então grudavam. Agora `display: block`,
   cada um na sua linha.
5. **Vazamento da barra atrás da folha modal — causa raiz encontrada.** O `Sheet` era
   renderizado dentro de `.chat-screen`, que anima `transform` (`cardIn`). **`position: fixed`
   fica contido por qualquer ancestral com `transform`** — a folha encolhia (medida: 237px de
   largura em vez de 375) e o backdrop não cobria a viewport, deixando a barra inferior
   aparecer por baixo. Corrigido renderizando o `Sheet` via `createPortal(..., document.body)`,
   que escapa de qualquer ancestral transformado. Vale para TODAS as folhas do app (FAB
   também). Verificado: folha com 375px, backdrop cobrindo a nav, portal no `<body>`.

### Bug 4 — investigado, NÃO é bug

O usuário suspeitava que deixar a data em branco na edição gravasse "de hoje" por engano.
Testado: uma ação `work` sem data explícita grava a data de **hoje** — que é o padrão
**correto e intencional** (um lançamento que você registra agora, sem dizer quando, é de
hoje). A barreira `future-date` continua impedindo data futura. Nenhuma mudança de código.

### Verificação no navegador (375 × 812)

Textarea cresce e quebra (`pre-wrap`); folha de edição com todos os campos estilizados e em
largura total, sem barra vazando; os dois links do card em linhas separadas (`display: block`,
tops distintos); console sem erros. Screenshot da folha "Editar lançamento" confirmou o antes
feio (image 1 do reporte) agora limpo.

---

### Reporte original (mantido como registro)

Achados testando `https://assist-fin.vercel.app` direto no celular, depois do deploy da rodada
anterior.

Achados testando `https://assist-fin.vercel.app` direto no celular, depois do deploy desta
sessão. Registrado por instrução explícita do usuário para retomar depois — "pouco token
disponível" no momento do reporte, nada foi alterado no código ainda.

1. **Campo de texto do chat não quebra linha.** Digitando uma mensagem longa na aba do
   Assistente, o texto continua rolando para a esquerda em vez de quebrar para a linha de
   baixo. Precisa investigar o input do `Chat.tsx` (provavelmente falta `white-space` /
   `word-wrap` ou o campo é um `<input>` de uma linha só quando deveria comportar-se como
   `<textarea>` que cresce).

2. **Folha "Editar lançamento" (ação `work`) malformada.** Print mostra os campos Km,
   Viagens, Horas e Data como `<input>` sem estilo do design system — bordas retas, sem
   padding visual consistente com o resto do app. Comparar com os outros campos de
   `ProposalCard.tsx` (o que usa `MoneyInput`/`.field` vs. o que caiu no fallback genérico de
   `<input>` puro). Aconteceu na correção manual da ação `work` visto que ela usa os campos
   numéricos (`km`, `trips`, `hours`) da folha de edição criada no item 34 desta sessão.

3. **"Ver detalhes" e "Confirmar só este" colados.** No card da proposta (`ProposalCard.tsx`),
   os dois links ficam grudados um no outro, sem espaçamento — texto ilegível como dois
   links separados. Precisa de `gap`/margem entre eles.

4. **Testar campo `km` vazio na edição do `work`.** O usuário vai testar se deixar `Km` em
   branco na folha de edição aplica algum valor "de hoje" por engano (suspeita de fallback
   indevido). Ainda não testado/confirmado — só a intenção de testar foi registrada.

5. **Vazamento visual atrás da folha de edição.** No print mais recente, a barra de
   navegação inferior (`Início ... Mais`) e os ícones de microfone/localização aparecem
   "vazando" por trás/ao lado da folha modal (`Sheet`), sugerindo problema de `z-index`,
   `overflow` ou posicionamento fixo colidindo com o modal em telas de celular reais
   (diferente do preview em 375×812 do navegador de desenvolvimento).

**Nenhuma dessas 5 pendências foi investigada ou corrigida.** Retomar com: reproduzir cada
uma no navegador (mobile real, não só resize do preview), escrever antes/depois se aplicável,
corrigir, e visualmente confirmar em produção depois do próximo deploy.

---

## 🟢 Auditoria da qualidade da IA — fala real do usuário — 2026-08-01

Pedido: "verifica se os códigos dela estão bons ou se ela vai ficar meio retardada".
Auditoria feita com mensagens reais e tortas, não com as frases do manual.

### O que ESTAVA bom (registro)

O núcleo de registro é sólido. Verificado com mensagens de motorista sem pontuação e
com gíria: `fiz 380 na uber hj rodei 210km gastei 90 de gasolina` produz receita 380
(corridas/Uber) + trabalho 210 km/1 viagem + abastecimento 90, tudo separado. Erro de
digitação não quebra (`merkado`, `hje`, `gazolina`, `300 conto`). Negação, hipótese e
saudação continuam sem gerar ação. CLT e autônomo idem (salário, aluguel+luz numa frase,
reserva, freela com data).

### O que estava RUIM (perguntas) — o defeito real

Medido em 10 pares "frase do manual × frase que o usuário digita":

| | Respondidas localmente |
|---|---|
| Frase do manual (`como está meu mês?`) | **9/10** |
| Frase real (`como ta meu mes`) | **2/10** |

Causa raiz: `resolveLocal()` fazia só `input.toLowerCase()`. Sem tirar acento e sem
expandir abreviação, `ta`, `to`, `pra`, `hj`, `qnt` e qualquer palavra sem acento não
casavam padrão nenhum e caíam no texto genérico de ajuda. Em produção isso não dá erro
visível — a pergunta vai para a DeepSeek — mas viola a regra do projeto de que pergunta
factual é respondida LOCALMENTE com dado real, além de custar chamada e latência à toa.

Achado extra: `como está meu mês?` tinha resposta **apenas no ramo não-motorista**. No
perfil `driver` — o principal do app — caía no genérico.

### Correção

- **`normalizeQuestion()`** (novo, `ai.ts`): minúsculas + remoção de acento + expansão de
  21 abreviações de conversa. Usada só para reconhecer a INTENÇÃO; o registro continua
  lendo o texto original, então nenhum valor se perde. Tirar acento é seguro porque as 17
  regexes acentuadas do roteador já usam classe com as duas formas (`m[eê]s`, `est[aá]`).
- **Padrões ampliados**: saldo (`quanto eu tenho`), quanto posso gastar (`quanto da pra
  gastar`), custo por km (`quanto sai o km`), melhor dia (`qual dia eu fiz mais grana`),
  gasto por categoria (`quanto eu JÁ gastei de...`), comparação de ritmo (`to ganhando
  mais que mes passado`), meta pelo NOME (`quanto falta pra minha moto`).
- **Resumo do mês agora vale para motorista também.**

Resultado: **10/10 na frase do manual e 10/10 na frase real**, com números reais na
resposta (saldo, meta faltando, melhor dia com valor, comparação proporcional).

### Regressão

`tests/assistant/cases-fala-real.ts` — **17 casos**. A asserção é sempre "a resposta NÃO
pode ser o texto genérico de ajuda", que é exatamente o sintoma da regressão. Três casos
garantem que a normalização não transforma REGISTRO em pergunta (`ganhei 200 hj`,
`fiz 300 conto hoje`, `gastei 50 no merkado` continuam virando lançamento).

Corpus: **385/385 · 53/53 invariantes**, typecheck src+api e build ok.

### Limitações que continuam (honestas)

1. **`hoje foi fraco so 150 reais 8 horas na rua`** não registra nada — o parser não liga
   "150 reais" a receita sem verbo de ganho explícito. Perde receita + horas.
2. **`gastei 20 e 30`** vira uma despesa de 20 com descrição "30", em vez de duas ou de
   uma pergunta.
3. **`gastei 30 pila no lanche`** deixa a gíria na descrição ("Pila no lanche").
4. **`paguei 80 de gazolina`** com typo cai em `outros-out`, não em combustível.
5. Perguntas abertas de verdade (`vale a pena comprar um carro de 40000?`) continuam
   dependendo da IA remota — é o desenho, não um defeito.

---

## Rodada — fala real de registro, perguntas de motorista e exportação (13/08/2026)

Pedido: "melhorar a IA o máximo possível", mais três defeitos relatados do APK (áudio,
exportar JSON, algo na tela principal). Método de sempre: sonda → caso vermelho →
correção → corpus inteiro → commit isolado.

### Como os defeitos foram achados

Uma **sonda** (`orchestrate` sobre frases de fala real) mostrou o que o corpus não
mostrava, porque o corpus só sabe o que já perguntaram a ele. Foi assim que apareceram
tanto os quatro parsers já conhecidos quanto sete classes novas — e três bugs que
**nenhum teste pegaria**, porque só apareciam ao LER a resposta.

Registro honesto de um erro do processo: numa primeira passada eu afirmei que
`gastei 20 no lanche e 30 na farmácia` perdia a segunda despesa. Era artefato da própria
sonda (o `grep` cortava a segunda linha). O parser sempre acertou esse caso.

### Registro em fala real (corpus novo `cases-registro-real.ts`, 41 casos)

1. **Resultado do dia do motorista** — `hoje foi fraco so 150 reais 8 horas na rua`,
   `deu 200 hoje`, `fechei o dia com 280`, `tirei 300 líquido`. Não registrava nada. Pior:
   `foi 400 hoje` caía no verbo de DESPESA e gravava o faturamento do dia **com o sinal
   invertido**. Regra nova em `driverDayResult()`, exclusiva do perfil motorista.
   Valor sem nenhum sinal de resultado (`hoje 250`) vira PERGUNTA, não palpite.
   Dia inteiro não inventa "1 viagem" — isso destruiria o ganho por viagem.
2. **`dayHint` de `clauses.ts` → `nlp.ts`** — quem segmenta ARRANCA a expressão de data
   antes de chamar o parser, e `deu 200 hoje` chegava como `deu 200`. Sem o aviso, o
   contexto que dá sentido ao número sumia.
3. **Gíria de dinheiro** — `pila`, `conto`, `mango`, `pau`, `prata` viravam descrição
   ("Pila no lanche"). Agora há uma constante `MOEDA` única, consumida por todo regex de
   valor, no lugar de `reais|conto` repetido em nove pontos.
4. **Erro de digitação** — `gazolina` caía em `outros-out` e sumia do custo de
   combustível. Os termos de categoria viraram RADICAIS (`gasolin`, `gazolin`, `mercad`).
5. **Valores enumerados** — `gastei 20 e 30` virava uma despesa de 20 com descrição "30".
   `cleanDescription` passou a recusar descrição puramente numérica.
6. **Gasto anotado sem verbo** — `almoço 25`, `25 no almoço`, `lanche 15 e café 5`,
   `paguei o aluguel 900`. A trava contra invenção é a CATEGORIA: o substantivo precisa
   ser reconhecido, então `hoje 250` e `8 horas` continuam não virando gasto.
7. **Nome da meta** — `quero juntar 5000 pra uma moto` criava meta chamada "Objetivo".
   O nome só era capturado antes do valor. `meta de 10 mil pro carro` não criava nada.
8. **Parcelamento sem item** — `passei 1200 no nubank em 3x` não registrava nada: o valor
   só era achado quando o item era descrito.

### O que a sonda pegou e o teste não pegaria

- **`posso gastar 50 no mercado?` virava despesa de 50.** O verbo está no infinitivo,
  então nenhuma lista de verbo conjugado o barrava. Guarda de pergunta + invariante 56.
- **`na verdade foi 200`, sem nada na tela, criava um gasto de R$ 200.** A frase de
  CONSERTO virava lançamento. `looksLikeRetraction` é estreita de propósito: a lista geral
  de correção tem palavras que aparecem em registro legítimo ("comprei uma TROCA de óleo").
- **`tô no vermelho?` respondia "Sim" para quem tinha R$ 465 de sobra.** Polaridade
  oposta com um "Sim" fixo: número certo, resposta errada. Invariante 57.
- **`ganho 3000 por mês` dizia "não registrei como GASTO de hoje"** — era receita.

### Conta que se repete é previsão (regra 18)

`pago 90 de internet todo mês` virava despesa avulsa e **inflava o mês** com dinheiro que
ainda não saiu. O assistente não cadastra recorrência, então agora não registra e manda
para Planejamento. A guarda exige o VALOR na frase e vale só para movimento de dinheiro —
`rodei 120 km todo dia` continua sendo trabalho.

Sub-achado: a regra do resultado do dia roubava `todo dia 10` (vencimento) porque a data
já tinha sido arrancada do texto. A checagem de recorrência passou a ser no texto original.

### Perguntas que o app sabia responder e mandava para o texto de ajuda

`vale a pena corrida de 8 reais` (a pior: caía no parser e virava tentativa de REGISTRO),
`quanto eu preciso fazer hoje ainda`, `quanto eu gastei essa semana/ontem` sem categoria,
`quanto to gastando de gasolina por dia`, `to no lucro esse mes`, `quanto sobrou`.

### Três defeitos do APK

- **Áudio** — o microfone usava `webkitSpeechRecognition`, que **não existe** no Android
  System WebView. Dentro do APK a API não estava lá e o botão não fazia nada. Agora usa o
  ditado do sistema (`ACTION_RECOGNIZE_SPEECH`, plugin nativo no padrão do RideOverlay):
  quem grava é o app de voz do Android, então o AssistFin não pede `RECORD_AUDIO` nem
  guarda áudio. Falha passou a ter motivo, e o botão some onde não há ditado.
- **Exportar** — `<a download>` com Blob não faz nada no WebView do Capacitor (não há
  DownloadListener). O app dizia "Backup exportado." para um arquivo que nunca existiu.
  Plugin nativo Export escreve em Downloads via MediaStore, sem permissão de armazenamento.
  A mensagem só aparece quando o arquivo foi escrito, e diz onde ficou.
- **Tela principal** — NÃO mexido. Há quatro candidatos plausíveis ao que foi relatado e
  mudar a Home do motorista no escuro seria chute (regra 2). Aguarda o usuário apontar.

### Segunda rodada de sondagem (mesma sessão)

9. **Dois dias na mesma mensagem paravam de existir.** `ontem fiz 280 e hoje 320`
   registrava só os 280 — o segmentador só corta antes de VERBO, então "e hoje 320" ficava
   colado e a data de ontem valia para tudo. Pior ainda: `ontem gastei 50 e hoje gastei 80`
   gravava as DUAS despesas em ontem. Corte novo antes de "e hoje/ontem" (exigindo um
   número depois, para "trabalhei ontem e hoje" não ser cortado) mais **verbo herdado**: o
   "fiz" da primeira metade vale para a segunda, resolvido DENTRO do parser para a viagem
   implícita continuar valendo nos dois dias.
10. **Bug pré-existente que o corte expôs:** a fusão de registros de trabalho somava tudo
    sem olhar a data. `ontem rodei 100 km e hoje rodei 200 km` virava um único dia de
    300 km, com o km de hoje lançado em ontem — estragando o custo por km dos dois dias.
    Fusão agora é POR DIA. Invariante 58.
11. **`rodei 200 km em 10 horas` perdia as 10 horas** — e a jornada é metade do lucro por
    hora do motorista.
12. **`quanto já juntei da moto`** caía no texto de ajuda, enquanto `quanto falta pra minha
    moto` já funcionava. É a mesma pergunta pelo outro lado; a resposta agora dá os dois
    números.

### Verificação

`npm test` **440/440 casos + 58/58 invariantes**, `typecheck`, `typecheck:api` e `build`
exit 0. `cap sync` e `compileDebugJavaWithJavac` exit 0 para os dois plugins nativos.
No navegador (375×812): registro do dia proposto e confirmado, gravando receita de
R$ 150 em corridas, sessão de 8h **sem viagem inventada**, e o lote no journal.

**Não verificado, e precisa do aparelho:** o caminho NATIVO do ditado e da escrita do
arquivo. Compilam, mas não foram executados em Android físico.

### Terceira e quarta rodadas de sondagem (perfis CLT, autônomo e veículo)

Os perfis que eu tinha testado menos renderam a leva mais grave.

13. **"Quando tenho que trocar o óleo" dizia JÁ VENCIDA para uma troca feita naquele
    minuto.** O assistente grava `lifeKm: 0` quando o usuário não diz de quantos em quantos
    km troca — e é o caso NORMAL, porque a frase que o próprio app sugere ("troquei o óleo
    por 280 com 84 mil km") nem pede o intervalo. O lembrete fazia `kmInstalado + 0` e
    concluía que a próxima troca já tinha passado. Sem intervalo não existe próxima troca:
    agora o app PEDE o intervalo em vez de inventar um alarme, e passou a ouvir "troco a
    cada 10 mil km". Manutenção realmente atrasada continua sendo avisada.
14. **"Caiu" não era verbo de receita** — o mais natural para salário e pagamento que chega
    na conta. "Meu salário caiu hoje 3200" não registrava nada.
15. **Registro começado sem o valor caía no texto de ajuda.** "Recebi o salário" fazia o app
    responder como se não tivesse entendido nada. Agora abre rascunho e pergunta quanto foi.
16. **"Recebi 1800 de aluguel e 900 de um freela" registrava só os 1.800**, porque a
    enumeração exigia "da/do" e a preposição mais comum é "de". Terceiro bug da mesma
    família nesta sessão, por isso virou a invariante 60 — que cobre a CLASSE, com seis
    frases de perfis diferentes.
17. **A proposta mostrava "R$ 3200,00", sem separador de milhar.** Formatação de dinheiro à
    mão em treze pontos de `nlp.ts`, justamente na tela onde o usuário confere antes de
    gravar. Agora tudo passa por `fmtBRL` (invariante 59). Junto, a concordância: dizia
    "1 viagens".
18. **A correção de lançamento salvo quase não funcionava com fala real.** Exigia substantivo
    genérico ("corrige o GASTO de ontem"), mas ninguém fala assim — fala "muda o mercado de
    100 pra 80". Agora o lançamento pode ser citado pela própria descrição, e o apelido
    também desempata quando há vários candidatos. Reconhecer pelo verbo é mais frouxo, então
    o pedido só vira correção se existir mesmo um lançamento que combine.
19. **"Quanto tô fazendo por hora" e "quanto por viagem"** — as duas métricas que o motorista
    mais olha — caíam no texto de ajuda.

Verificado: **465/465 casos + 60/60 invariantes**, typecheck (src e api) e build exit 0.
No navegador: "ganhei 15000 hoje" aparece na proposta como **R$ 15.000,00**.

### Quinta rodada — conversa multiturno e fala corriqueira

20. **"Gastei uns 50" não registrava nada.** O "uns" entre o verbo e o número fazia o parser
    não achar o valor. É como se fala quando não se lembra o centavo, e valia para todas as
    formas ("cerca de", "mais ou menos", "quase"). Virou a constante `APROX`, que substituiu
    o antigo `(?:mais\s+)?` em todos os regex de valor.
21. **"Comprei uma tv" caía no texto de ajuda.** O rascunho de parcelamento desistia quando
    faltavam valor E parcelas, e nada assumia depois. Agora pergunta o preço guardando a
    descrição e a categoria já ditas — quem escreveu "comprei uma TV" não vai repetir "tv"
    ao responder o valor.
22. **Com a proposta na tela, "80" e "na verdade 80" não corrigiam o valor.** O primeiro caía
    na ajuda; o segundo respondia "entendi que isso não aconteceu" enquanto a proposta ERRADA
    seguia lá esperando o Confirmar. São os dois jeitos mais naturais de consertar um valor.
23. **"Tô com 3000 na conta" respondia sobre contas a vencer.** A palavra "conta" puxava a
    pergunta de contas a pagar, e o usuário estava informando o saldo — resposta de outra
    conversa sobre assunto parecido, o tipo de erro que mais confunde.
24. `joguei 200 na poupança` não registrava nada.

Verificado: **477/477 casos + 60/60 invariantes**, typecheck (src e api) e build exit 0.

---

## Rodada — assistente adaptativo (13/08/2026)

Pedido: "uma IA autoadaptativa, que se adapte ao meu cliente".

### A decisão de arquitetura

Tudo é **derivado** do histórico que já existe em `state.transactions`. Não há campo novo,
migração nem armazenamento paralelo — mesma decisão do journal por diferença de estado:
dado derivado não desincroniza, backup antigo carrega sem conversão, e apagar o histórico
apaga o aprendizado junto, que é o que o usuário espera.

Alternativa rejeitada: uma tabela de aprendizado em `AppState`. Ela desincronizaria do
histórico na primeira edição ou remoção de lançamento, e exigiria migração.

### O que é aprendido

1. **Categoria.** A lista de palavras-chave é genérica e sempre vai errar em nome de lugar
   ("Zé da esquina", "posto do Tião"). Se ele já classificou três vezes, o app tem a
   resposta. E quando o histórico CONTRADIZ a lista de forma consistente, quem manda é o
   histórico: corrigiu "mercado" para compras quatro vezes, já disse o que quer.
2. **Grafia.** Ele escreveu "Zé da esquina" e agora digitou sem acento. Sem normalizar, a
   lista fica com dois lugares parecidos e o próprio aprendizado enfraquece — o histórico
   se divide. Só vale quando o texto é O MESMO ignorando acento e caixa.
3. **Ordem de grandeza.** Dez dias de R$ 300 e um lançamento de R$ 3.000 é quase certamente
   um zero a mais. O app AVISA e deixa confirmar.

### Os limites (invariantes 61 e 62)

- Aprender exige REPETIÇÃO: 2 vezes para preencher vazio, 3 e 75% para contrariar a lista.
- Categoria aprendida passa por `validateAction` como qualquer outra, e nunca pode ser uma
  que o usuário não tem — senão a ação seria recusada e o lançamento sumiria por um palpite.
- O aprendizado **só toca em categoria e grafia**. Nunca valor, data ou tipo.
- O aviso de padrão **nunca bloqueia**: o dia excepcional existe, e barrá-lo seria pior que
  o erro de digitação. Sem amostra (menos de 6 lançamentos do mesmo tipo e categoria), CALA.
- Nada é gravado sozinho: aprender muda o que é PROPOSTO, e a proposta continua precisando
  do Confirmar (regra 8).

### Sugestões da tela

A lista fixa por perfil virou ponto de partida. Quem tem meta "Moto" vê "quanto falta pra
minha moto"; quem lança "Zé da esquina" toda semana ganha um atalho. O atalho vem SEM valor
de propósito — o assistente pergunta quanto foi, que é a conversa mais curta possível.

### Achado no navegador, não no corpus

Esse atalho leva ao caminho "registro sem valor → pergunta → resposta", que **não passava
pelo vocabulário**: o lançamento saía sem categoria e com a grafia errada, dividindo
justamente o histórico de onde o atalho veio. Só apareceu clicando no botão de verdade.

### Verificação

`npm test` **486/486 casos + 62/62 invariantes**, typecheck (src e api) e build exit 0.
No navegador, com dez dias de R$ 260–368 e quatro lançamentos "Zé da esquina":
- "ganhei 3000 hoje" → ⚠️ "Bem acima do seu normal — você costuma lançar perto de
  R$ 314,00. Confere se não sobrou um zero."
- atalho → "Qual foi o valor?" → "35" → "Despesa de R$ 35,00 (alimentacao) — Zé da esquina"

---

# 2026-08-17 — Rodada ADAPTATIVA: o assistente que conhece o cliente

**Ponto de partida**: `9a882fa`, 486/486 casos, 62/62 invariantes, árvore limpa,
contrato do assistente v1.
**Chegada**: 520/520 casos, 74/74 invariantes, oito commits de código, sem push, sem
deploy, sem APK.

## Fase 1 — auditoria adversarial ANTES de melhorar

O aprendizado de `learning.ts` já existia e funcionava para os casos que tinham sido
imaginados. Antes de expandir, foi escrita uma sonda descartável só para quebrá-lo — e
ela quebrou em oito pontos, todos reproduzidos e LIDOS antes de existir qualquer
correção.

O pior deles não era sutil: **categoria arquivada engolia o lançamento inteiro**. O
usuário usava "lazer" quatro vezes no Clube e depois arquivava a categoria; o
aprendizado propunha "lazer", `validateAction` recusava por categoria inexistente nas
capacidades, e o gasto sumia com "Não tenho certeza do que registrar aqui". Aprender
destruía um registro que funcionava sem aprender nada. A causa: `buildCapabilities`
filtrava arquivadas e o aprendizado usava outro filtro ("a categoria existe?"). Virou
`usableCategories()`, fonte única.

Os outros sete: histórico de janeiro ganhando de julho por contagem crua; quatro
lançamentos de 2020 decidindo um gasto de 2026; a palavra "casa" de "Conta de luz da
casa" contaminando "comida na casa da minha mãe" com evidência FORTE; "Mercado livre"
ensinando o que é "mercado"; origem sem grafia canônica ("casa 1" ao lado de "Casa 1");
sugestões dizendo "gastei no gasolina" e "Quanto falta pra minha notebook"; e nenhuma
explicação nem chave para desligar.

## Fases 2–4 — modelo pessoal derivado

`personalModel.ts` constrói, `learning.ts` aplica, `suggestions.ts` sugere,
`explain.ts` explica, `driverInsights.ts` mede o motorista. Cinco módulos, um trabalho
cada — a alternativa era um `learning.ts` gigante onde ninguém sabe mais o que decide o
quê.

Tudo derivado de `state.transactions`, como o journal por diferença de estado. Isso não
é economia de código, é o que faz a fase 5 (feedback real) existir **sem nenhuma linha
de código de feedback**: confirmar reforça porque a transação entra no estado; editar
antes de confirmar ensina a versão corrigida porque é ela que é salva; corrigir
lançamento salvo atualiza o padrão; desfazer e apagar removem a evidência; cancelar não
ensina nada porque nada foi salvo. Um armazenamento paralelo precisaria de cinco
handlers e desincronizaria no primeiro que faltasse.

**Recência com piso** (regra 40): peso cai pela metade a cada 90 dias, nunca abaixo de
15%. Sem decaimento, o hábito que mudou nunca valia; sem piso, o padrão sazonal seria
destruído fora da estação. A primeira tentativa não resolveu o caso `ad-11`: três
lançamentos de julho contra cinco de janeiro davam 63% de confiança — evidência demais
para ignorar, de menos para discordar do app. A saída foi medir a confiança DUAS vezes,
no histórico inteiro e na janela de 120 dias, e bastar uma convencer.

**A frase identifica, a palavra genérica não** (regra 41): chaves em três níveis (texto
inteiro, n-grama de 2 a 3 palavras, palavra própria), e palavra de classe só conta
dentro de uma frase. O caso `ad-03` (o usuário insiste que "Mercado" é Compras) e o
`ad-15` ("Mercado livre" não ensina o que é "mercado") parecem contraditórios e não
são: no primeiro a FRASE INTEIRA coincide, no segundo só a palavra genérica. Foi essa
distinção que permitiu bloquear o token sem perder o aprendizado legítimo.

Dois candidatos fortes disputando a mesma frase passaram a PERGUNTAR, com as opções
carregando o lote pronto: "Você lança Quiosque tanto em Compras quanto em Lazer. Qual é
desta vez?".

## Fase 12 — 50 mensagens, quatro perfis, e o que só aparece lendo

Sete cenários, 54 mensagens: motorista veterano com vocabulário próprio, motorista
novato sem nada, autônomo de imóveis, CLT que mudou de hábito, perfil `other` com
entidade ambígua, o mesmo cliente com o aprendizado desligado, e fala transcrita sem
pontuação. Cada resposta foi lida.

**Sete defeitos que o corpus 100% verde não mostrava:**

1. **A explicação contradizia o app.** "gastei 50 no mercado" saía em Compras por causa
   do histórico e a explicação dizia "essa veio das palavras da mensagem, não do seu
   histórico". A decisão estava sendo reavaliada sobre a ação que JÁ tinha a categoria
   aplicada.
2. **Perguntar "por que" cancelava a proposta na tela.** Toda resposta sem ação zerava a
   proposta pendente. `keepPending` marca a exceção.
3. **Ranking de dia da semana com UM dia por dia da semana.** "Sábado: R$ 328,00 (1 dia
   nessa amostra)" é ruído com cara de padrão.
4. **"Seu normal nos 30 dias anteriores" calculado sobre dois dias**, e o resultado saía
   como "13% acima do seu normal".
5. **`hoje foi 430 na uber e 380 na 99` propunha receita E despesa de 430.** Defeito
   ANTIGO do parser, sem relação nenhuma com o aprendizado: `foi` é verbo de despesa e
   `driverDayResult` só converte a despesa fraca quando ela é a única ação monetária da
   frase. O dia do motorista zerava. A invariante 74 achou a segunda forma do mesmo
   defeito — `hoje saiu 250 na 99` produzia a gêmea SEM descrição, e a primeira versão
   do conserto exigia descrição igual.
6. **`da kitnet do fundo` virava a origem `kitnet do`** — o identificador parava na
   preposição. Além do nome truncado, o imóvel passava a existir duas vezes no
   histórico.
7. **`quanto eu costumo gastar de suco por dia?` respondia com o resumo do dia inteiro.**
   O motorista que chama combustível de "suco" é literalmente o cliente simulado que a
   fase 12 exigia, e a resposta de combustível só conhecia as palavras do dicionário do
   app.

Dois cenários do corpus passaram a montar datas com `todayISO()`: estas perguntas
atravessam `resolveLocal`, que usa o RELÓGIO REAL da máquina (regra 35), e com data fixa
o cenário envelhecia para fora da janela de 30 dias.

## Commits

| Commit | O quê |
|---|---|
| `349889d` | test: casos vermelhos da auditoria adversarial do aprendizado |
| `99bf27c` | feat: modelo pessoal com evidência, confiança e recência |
| `5542e02` | feat: sugestões contextuais, neutras e honestas sobre o que fazem |
| `1cf9e2c` | feat: o assistente explica o que aprendeu, e a chave é do usuário |
| `dcf35ec` | feat: o ritmo do motorista, medido no histórico dele |
| `3c55437` | feat: contexto remoto agregado, com o pessoal ficando no aparelho |
| `22e041a` | fix: o dia do motorista contado duas vezes, com sinais opostos |
| `93ec8b5` | fix: origem truncada e o hábito perguntado com a palavra do usuário |
| (docs) | CLAUDE.md 39-45, CONTEXT.md, CONTEXTO.md, AI_CURRENT_STATE, AI_REGRESSION_MATRIX |

## Verificação

`npm test` 520/520 + 74/74 · `npm run typecheck` e `typecheck:api` exit 0 ·
`npm run build` e `npx vercel build --prod` exit 0 · bundle inspecionado (sem chave, sem
nome de env server-only, sem código server-only, sem dado de teste) · smoke test no
navegador em desktop e mobile 375x812, sem erro de console: aprendizado ligado e
desligado, usuário novo, dois clientes isolados com a MESMA frase dando categorias
opostas, sugestão contextual, explicação, correção depois da explicação, confirmação,
undo, reload e troca de perfil sem vazar dado de motorista.

## O que ficou de fora, e por quê

- **Fase 13 (eval comparativo de modelos remotos) não foi executada.** Exige chamadas
  pagas à API da DeepSeek, que não foram autorizadas. Nenhum modelo, preço ou retry foi
  alterado — o briefing proíbe mexer nisso sem resultados, e não há resultados.
- **Perguntas frequentes não alimentam as sugestões**: a fileira só aparece com
  `state.chat` vazio, então não há histórico de perguntas para ler naquele momento.
  Criar um armazenamento separado contradiria a decisão de tudo ser derivado.
- **O assistente não liga nem desliga `adaptiveAssistant` por conversa** — ele diz onde
  fica a chave. Mexer em configuração por conversa é a mesma classe de coisa que
  registrar sem confirmar.
- **Categoria dita explicitamente e categoria adivinhada pela lista genérica são
  indistinguíveis** na saída do parser. Vale a decisão da regra 37.
- **Erro de digitação no VERBO** (`gsatei 60 no merkado`) continua sem registro local —
  é o limite conhecido de um parser determinístico.

---

# 2026-08-17 (parte 2) — Rodadas de LIMITE

Depois de a camada adaptativa ficar verde, seis rodadas de sonda descartável foram
feitas só para QUEBRAR o que já estava passando. Nenhum dos nove defeitos abaixo
aparecia no corpus: todos vieram de entrada hostil, escala, estado corrompido ou de
LER a tela.

## O que cedeu

| # | Defeito | Por que importa |
|---|---|---|
| 1 | `null` no backup derrubava o app inteiro | `normalizeState` só checava "é array". Tela branca, sem recuperação: o usuário perdia o acesso ao próprio dinheiro |
| 2 | Data ilegível envenenava o modelo pessoal | `fromISO('lixo')` → peso NaN → "a última em Invalid Date" na explicação |
| 3 | A pergunta de categoria custava o lançamento | "gastei 40 no quiosque" → o app pergunta → "sei lá" → a despesa **desaparecia** |
| 4 | Caractere invisível voltava como botão | `U+202E` num atalho inverte visualmente o texto ao redor |
| 5 | "Gastei 50 centavos" registrava R$ 50,00 | Cem vezes o valor, na palavra mais explícita que existe |
| 6 | Nome do usuário virava instrução no prompt | Uma meta com `\n` abria uma linha com cara de regra no meio das regras do sistema |
| 7 | Conserto virava lançamento novo | "não, foi 100 mesmo" criava uma SEGUNDA despesa, com a primeira ainda confirmável acima |
| 8 | Descrição virava fórmula no CSV | `=HYPERLINK(...)` executa na planilha do contador que recebeu o arquivo |
| 9 | O app parava de salvar em silêncio | `setItem` sem `try`, dentro de `setTimeout`. O usuário registrava o dia inteiro no vazio |

Mais quatro de menor gravidade, todos visíveis ao usuário: "R$ NaN" e "-R$ 0,00" na
tela; dívida parcelada de R$ 0,00 ao lado de "parcelas deste mês: R$ 277,78"; "Toda
sábado" e "às segundas-feira" no Planejamento; e quatro telas rolando de lado em 320px.

## O que aguentou

Registrar isto é tão útil quanto registrar o que quebrou, porque é o que não precisa
ser reolhado: 6.000 lançamentos processados em 19 ms; as 13 ações remotas hostis todas
recusadas com código próprio; envelope malformado, versão desconhecida e modo inventado
recusados; toda data impossível perguntando em vez de chutar; recorrência com intervalo
0, negativo ou NaN caindo em mensal sem laço infinito; dia 31 virando 28/02 e 31/03 sem
degradar; backup de ida e volta idêntico byte a byte; e `goal-deposit` sem nome com três
metas sendo recusado em vez de escolher uma.

## Commits

| Commit | O quê |
|---|---|
| `edd0a9d` | fix: o que o app faz quando o dado que chega não presta |
| `ab59d1e` | fix: conserto que virava lançamento novo, e a meta com nome próprio |
| `9abcbe9` | fix: centavo virando real, e o nome do usuário virando instrução |
| `5aea2f4` | fix: português do dia da semana e dívida que se contradizia |
| `b7178e0` | fix: descrição que virava fórmula na planilha de quem recebe o CSV |
| `f308db1` | fix: o app parava de salvar em silêncio |
| `a5df4a0` | fix: "R$ NaN" e "-R$ 0,00" na tela de um app de dinheiro |
| `2dc604e` | fix: quatro telas rolavam de lado num celular de 320px |

## Verificação

`npm test` 531/531 casos + 86/86 invariantes · `npm run typecheck` e `typecheck:api`
exit 0 · `npm run build` exit 0 · varredura de layout no navegador em 320 px, 768 px e
1280 px, nos dois temas, com zero sobra horizontal nas dez rotas e sem erro de console ·
aviso de falha de gravação verificado no navegador com `QuotaExceededError` forçado.

## Nota de método

Três dos nove defeitos foram achados por uma INVARIANTE que eu tinha acabado de
escrever para outra coisa — "hoje saiu 250 na 99" (a segunda forma da despesa gêmea),
"às segundas-feira" (o plural pela metade, achado logo depois de consertar o gênero) e
o dilema com dois itens ambíguos. Testar a CLASSE, e não a frase, continua sendo o que
separa consertar um caso de consertar o problema.

---

# 2026-08-24 — Rodada COPILOTO SEMÂNTICO (fase 0: baseline real)

Antes de escrever uma linha, o baseline foi EXECUTADO, não lido da documentação. É o que
resolve a inconsistência histórica que estava nos docs (`520/520 + 74/74` num arquivo,
`531/531 + 86/86` em outro).

| Gate | Resultado real, executado em 24/08/2026 |
|---|---|
| `git status` | limpo, exceto `.claude/launch.json` (config local de outro projeto, fora de todos os commits) |
| `npm test` | **531/531 casos (100%)** e **86/86 invariantes** |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:api` | exit 0 |
| `npm run build` | exit 0 — `index-*.js` **571,02 kB** (gzip 173,85 kB), CSS 11,88 kB, `dist/` 586 KB |
| `npx vercel build --prod` | `status: ok` (build local; **nenhum deploy**) |

Números por grupo do corpus: `registroreal` 68, `adaptativo` 54, `temporal` 43, `falareal` 29,
`undo` 14, `perguntas` 12, `receitas` 12, `correcoes` 12, `valores` 10, `categorias` 10,
`negacao` 10, `multi` 9, `cartoes` 9, `motorista2` 8, `coloquial` 8, `saving` 7, `falados` 7,
`seguranca2` 7, e mais 17 grupos menores.

Correções de documentação feitas com base NESTE resultado (nenhuma mudança de comportamento):

- `docs/AI_CURRENT_STATE.md`: `520 casos + 74 invariantes` → `531 casos + 86 invariantes`
  (duas ocorrências); a ressalva "o que 368/368 NÃO prova" passou a citar o número real e as
  seis rodadas de limite; a lista de arquivos de caso passou de quatro para os nove que existem.
- `src/services/ai.ts`: o cabeçalho ainda dizia "INTEGRAÇÃO PENDENTE: conectar um backend
  seguro (ex.: POST /api/ai/chat)". Esse backend existe desde julho, nos dois ambientes. O
  comentário foi corrigido para descrever o que o módulo realmente é — o lado LOCAL, que
  responde sem rede. (O `INTEGRAÇÃO PENDENTE` de `store.tsx` continua verdadeiro: sync em
  nuvem não existe.)

Branch de trabalho: `feat/assistant-semantic-copilot`, criada a partir de `main` (`eb54a4e`,
que já contém a rodada adaptativa e as seis de limite). Sem push, sem merge, sem deploy.

---

## 🧠 Rodada do COPILOTO SEMÂNTICO — 2026-08-25

Branch `feat/assistant-semantic-copilot`. **Sem push, sem merge, sem deploy, sem APK.**

O objetivo não era "mais regex". Era trocar o **teto**: o assistente respondia bem as
perguntas que alguém escreveu no código, uma a uma, e não sabia responder mais nada.

### O defeito que definiu a rodada

`periodFromText()` em `ai.ts` conhecia **seis** frases de período e caía em "últimos 7 dias"
para todo o resto. Consequência real, não hipotética:

```
"quanto gastei em obra nos últimos 3 meses?"
  → respondia com o total de UMA SEMANA, apresentado como dado real
```

O usuário não tinha como perceber: o número era verdadeiro, o período é que era outro. É a
pior forma de erro num app de dinheiro — errado com cara de certo.

### O que passou a existir

| Camada | Onde | O que garante |
|---|---|---|
| Query DSL | `src/assistant/query/` | Vocabulário FECHADO (10 fontes, 12 métricas, 13 agrupamentos), validado como as ações, executado **local** |
| Cenário | `src/assistant/scenario/` | Somente leitura, sobre CÓPIA projetada; reusa as funções reais de cartão e projeção |
| Foco | `src/assistant/conversation/` | Follow-up REFINA o plano anterior; "e mês passado?" troca o período e mantém o filtro |
| Turno e evidência | `src/assistant/semantic/` | Blocos do turno + evidência por CAMPO com posto (usuário > parser > histórico > remoto) |
| Grounding | `src/assistant/grounding.ts` | Barreira aritmética sobre prosa remota — **com o alcance medido, ver abaixo** |

O modelo remoto ganhou UM papel novo e ele é o mais seguro possível: **planejar** a consulta
que o local não entendeu. Recebe o vocabulário e a pergunta, nunca um lançamento; devolve um
plano; o plano é validado com as capacidades reais do aparelho e executado aqui.

### O achado mais importante: a barreira que não barrava

A barreira de grounding foi **medida**, não estimada — 5.000 valores sorteados entre R$ 0 e
R$ 5.000, tratados como números inventados pelo modelo:

| fatos na lista | inventados que passariam |
|---|---|
| 1 | 0,6% |
| 3 | 3,5% |
| 6 | 16,0% |
| 12 | 35,8% |
| contexto agregado inteiro (38 números) | **89,3%** |

O termo que domina é a soma e a diferença entre pares. Tirar a razão crua move 10,1% para
10,0% — a única alavanca é o tamanho da lista.

Daí duas decisões, e a segunda é uma decisão de **não fazer**: `MAX_COMPOSE_FACTS = 6`, que
falha fechado; e a barreira **não** foi ligada à resposta livre da IA remota, onde teria ~11%
de eficácia. Alegar proteção que não existe é pior que não ter. Fica documentado com o número.

### Defeitos encontrados FORA do corpus (o padrão se repetiu pela terceira vez)

O corpus esteve **100% verde** do início ao fim da rodada. Nenhum destes falhava um teste:

- o dia telegráfico do motorista (`hj deu 430 uber 399 99 163 de gasosa 24l 161km 8h`) perdia
  metade do turno;
- `4k` virava R$ 4,00;
- "se a Casa 1 **n** pagar" virava um gasto simulado de R$ 1,00 — resposta completa, precisa e
  sobre outra coisa;
- "meu nubank tá fudendo mt meu mês?" respondia o resumo do mês inteiro;
- "quanto falta pra viagem" (a meta pelo nome) caía em parcelamento e respondia "você não tem
  parcelamentos em aberto com viagem";
- "qual dia da semana eu faturo mais?" coroava o sábado (R$ 2.945,00) sobre a sexta
  (R$ 2.935,00), com 12 ocorrências cada — cara-ou-coroa apresentado como conclusão;
- "meu salário cobre minhas contas?" devolvia a lista de contas e nunca dizia se cobre.

Além de um **crash** achado pelo fuzzer: `'__proto__' in UNITS` é `true` em objeto literal, o
acumulador virava string e o parser morria em `m.value.toFixed is not a function`. Todos os
dicionários indexados por texto viraram `Map`.

### A rubrica (fase 23)

`npm run rubric` classifica cada resposta do corpus adversarial em PERIGOSA / RUIM /
ACEITÁVEL / EXCELENTE por **predicado**, não por opinião — opinião não é comparável entre
rodadas. PERIGOSA tem meta ABSOLUTA de zero e o script sai com código 1 se houver alguma.

A própria rubrica precisou de três correções antes de servir, todas pelo mesmo motivo: ela
acusava as melhores respostas do corpus (simulação com valor, pergunta com verbo de registro,
recusa com motivo). Rubrica que grita à toa se aprende a ignorar.

**Resultado**: PERIGOSA 0 · RUIM 0 · ACEITÁVEL 6 · EXCELENTE 84 (93%).

### Gates executados

| Gate | Resultado, 25/08/2026 |
|---|---|
| `npm test` | **531/531** casos · **75/75** goldens novos · **4.080 + 3.800** mutações · **1.416** hostis · **106/106** invariantes |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:api` | exit 0 |
| `npm run build` | exit 0 |
| `grep -rn "sk-" dist/` | nada |
| `npx vercel build --prod` | `Build completed successfully` (**build local; nenhum deploy**) |
| `npm run rubric` | PERIGOSA 0 |

### Deixado de fora, conscientemente

1. **Roteamento de modelo (fase 22)** — depende de resultado de avaliação, que depende de
   chamada paga, que depende de autorização explícita de gasto. A infraestrutura está pronta
   e **não gasta** sem `--executar`.
2. **O compositor remoto não está ligado** — implementado, protegido e limitado, mas nenhuma
   resposta passa por ele hoje. Toda composição é determinística.
3. **`orchestrate` tem 817 linhas** (eram 526). Lê-se como pipeline e os passos foram
   renumerados na ordem real de execução, mas é o maior candidato a extração da próxima rodada.

---

## 🧪 Avaliação dos modelos remotos — PREPARADA, não executada — 2026-09-13

Nenhuma chamada paga. Detalhes em [docs/AI_REMOTE_EVAL.md](docs/AI_REMOTE_EVAL.md).

- `GET /models`: `deepseek-flash` (V4.1-Flash) e `deepseek-v4-pro`. O código de produção usa o nome
  LEGADO `deepseek-v4-flash`, roteado "temporariamente" desde 10/09/2026, e não manda o parâmetro de
  pensamento — que por padrão vem LIGADO. Saldo: US$ 1,96, a mesma conta do app publicado.
- **Corrigido antes de medir** (`7080edb`): o planejador remoto de consulta nunca funcionou — duas
  chamadas pagas por pergunta e plano recusado. Invariante 107.
- **Não corrigido, precisa de decisão**: o histórico mandado ao chat remoto inclui respostas locais,
  que podem conter descrição e valor de lançamento (regra 44).
- Corpus de 120 casos com gabarito executável; avaliador testado sem rede em `npm test` (416
  verificações); orçamento com prompts exatos: A+B+C em 3 repetições custa US$ 0,79 no cenário
  central e US$ 1,91 no pessimista.
- **Achado colateral**: a pré-checagem de rotas encontrou dezenas de frases que o motor LOCAL responde
  errado sem nunca consultar o modelo, várias com proposta de registro perigosa ("qnto q foi d obra msm
  nos ultimo 3 mes" vira despesa de R$ 3,00). Lista completa no documento, seção 10.

| Gate | Resultado |
|---|---|
| `npm test` | 531/531 · 75/75 · 4.080 + 3.800 mutações · 1.416 hostis · 107/107 invariantes · 416/416 do avaliador |
| `typecheck` / `typecheck:api` | exit 0 |
| `npm run build` + varredura de chave | exit 0, bundle sem chave |

---

## 🔐 Canal remoto e roteamento local — 15/09/2026

Branch `feat/assistant-semantic-copilot`. **Nenhuma chamada paga, nenhuma requisição à conta, sem
push, sem merge, sem deploy, sem APK.** O modelo de produção e o parâmetro de pensamento não foram
tocados.

### O que saía do aparelho

Reproduzido ANTES da correção, com estado-canário e a conversa encadeada como a tela fazia: o corpo
do chat remoto levava o nome do usuário, a descrição e o valor de um lançamento e o saldo em conta —
pelas respostas LOCAIS anteriores em `history` e por `nome`/`saldoEmConta` no contexto —, e o
servidor repassava tudo à DeepSeek. A regra 44 prometia o contrário.

Correção (`bfd8f83`, regra 61):

- a conversa vai como ESTRUTURA (`conversation/remoteContext.ts`), nunca como transcrição;
- o contexto é o mínimo, e agregados só vão quando o trecho em aberto é pergunta ou pedido;
- nome, saldo e o que deriva dele, lista de parcelamentos com descrição e nome de conta prevista
  nunca saem;
- com parte da mensagem resolvida no aparelho, vai só o trecho em aberto;
- o servidor ignora `history`, aplica lista de campos PERMITIDOS e só aceita estrutura do
  vocabulário do usuário — o que fecha o vazamento também para o APK antigo, depois do redeploy;
- invariantes 114–119 nas duas pontas, com o caso positivo: o que foi escrito nesta mensagem vai.

### O motor local que calava o remoto

Três classes, cada uma vista vermelha antes (22 dos 31 casos de `cases-roteamento.ts`):

- `713970d` — "3 mil", "2 mil e quinhentos", "2,5k" viram algarismo no normalizador numérico; o
  regex de compra deixou de partir "24 vezes" em 2 e 4;
- `d7b846c` — número de período não é valor, abreviação de "quanto" é pergunta, "que" solto não é
  comparação, "3 meses" e "em 90 dias" são janelas; depósito em meta com meta única propõe e sem
  meta única pergunta; "mandei" deixou de casar "andei";
- `98d23f3` — `semantic/confidence.ts`: quatro critérios determinísticos descartam a leitura local
  suspeita e deixam a cláusula em aberto (regra 62).

Dois tropeços pegos antes do commit, e ficam registrados porque são a mesma lição de sempre:

- a primeira versão do critério de período apagava nove lançamentos do corpus temporal ("paguei 100
  mês passado") — ela passou a ler o texto sem as datas;
- ao LER as respostas, a hipótese sem base "e se em vez de 10x eu fizer 12 dando mil de entrada?"
  apareceu simulada como uma compra de R$ 12,00. A causa foi a borda de dígito nova, que tirou o
  acidente que antes derrubava a frase. Foi fechada com a trava de preço.

### Avaliação dos modelos remotos

- Frases que chegam ao modelo: **66 de 120** (planejador 19, chat 44, cenário 3); eram 64. Turnos de
  conversa: 9 no chat e 9 no planejador (eram 10 e 10).
- p-14 e p-19 passaram a chegar ao remoto; p-20, p-29, c-16, s-03, s-05 e s-11 passaram a ser
  respondidas certo no aparelho (`7c7bef5`).
- Corpus PAGO: 46 chat · 40 planejador · 8 cenário · 6 conversas.
- Orçamento sem rede (`--sem-saldo`), A+B+C em 3 repetições: **US$ 0,63 central, US$ 1,50
  pessimista, US$ 7,44 no pior caso**, cerca de 36 min. Eram US$ 0,79 / 1,91 / 9,37.
- A prova de origem sintética passou para o caso (`origemVerificada`), e o canário no corpo bloqueia.

### Gates

| Gate | Resultado |
|---|---|
| `npm test` | 562/562 · 75/75 · 4.080 + 3.800 mutações · 1.416 hostis · 418/418 do avaliador · invariantes: **118/119 no gate rodado depois de `de2782d`** (a 104 acusou caractere de controle em `remoteContext.ts`), **119/119 depois da correção** — ver o CHECKPOINT abaixo |
| `typecheck` / `typecheck:api` | exit 0 |
| `npm run build` + varredura | exit 0; bundle sem `sk-` e sem código de servidor |
| `npx vercel build --prod` | `status: ok` (build local, nada publicado) |
| `npm run rubric` | PERIGOSA 0 · RUIM 0 · ACEITÁVEL 6 · EXCELENTE 84 (rodada antes do checkpoint; não foi repetida nele) |

### Continua em aberto

- Registros de fala real que o aparelho ainda lê errado ("salario caiu 3200 e ja paguei o aluguel de
  1100", as correções faladas de lançamento, o dia telegráfico com "uber deu", a entrada de amanhã
  junto de uma de hoje, "vale alimentação", "180 de agua", "vírgula cinquenta") e perguntas com o
  número certo para a pergunta errada — lista relida em `docs/AI_REMOTE_EVAL.md` §10.
- O planejador remoto continua sem estado.
- As mudanças de `api/**` só chegam ao app publicado com redeploy, que depende de autorização.
- Nome legado `deepseek-v4-flash` e pensamento no padrão da API, sem mudança: só com medição.

### CHECKPOINT — 15/09/2026 (implementação funcional PARADA aqui)

Branch `feat/assistant-semantic-copilot`, a partir de `e635d59`. **Zero chamada paga, zero requisição
à conta DeepSeek (nem `/models`, nem saldo), zero push, merge, deploy ou APK.** Modelo de produção e
parâmetro de pensamento intocados. `.claude/launch.json` segue modificado e fora dos commits
(configuração local).

**Commits desta rodada:** `713970d` (magnitude "mil"/"k") → `d7b846c` (período, "qnto", meta,
"mandei") → `98d23f3` (confiança local, `semantic/confidence.ts`) → `bfd8f83` (privacidade do canal
remoto) → `7c7bef5` (seis rotas do corpus de avaliação) → `de2782d` (docs) → commit de checkpoint
(escape do caractere de controle + esta seção).

**Gate final, na ordem em que rodou (05:28–05:28:44, depois da correção do escape):**

1. `npm test` — núcleo ok (9 de navegação) · 562/562 casos · 75/75 goldens · 4.080 mutações que
   preservam + 3.800 que mudam a modalidade · 1.416 hostis (pior 124 ms) · **119/119 invariantes**
   (86 financeiras + 21 do copiloto + 12 do canal remoto) · **418/418** verificações do avaliador
   (120 casos, 51 leituras aceitas no planejador, **66 frases chegam ao remoto**) — exit 0;
2. `npm run typecheck` — exit 0;
3. `npm run typecheck:api` — exit 0;
4. `npm run build` — exit 0; varredura `sk-` no `dist/` sem ocorrência; nenhum código de servidor
   (`DEEPSEEK_API_KEY`, `api.deepseek.com`, `sanitizeChatContext`, `normalizeRemoteConversation`) no
   bundle;
5. `npx vercel build --prod` — `status: ok`, exit 0 (local; nada publicado).

Alcance remoto: 66/120 (planejador 19 · chat 44 · cenário 3); eram 64. Turnos de conversa que chegam
ao remoto: chat 10→9 e planejador 10→9 — só os turnos 4 e 5 de k-06 mudaram.

#### Privacidade do canal remoto — antes e depois

- **Antes** (reproduzido em `98d23f3` com estado-canário): o corpo cliente→servidor e o
  servidor→DeepSeek levavam "Canário Restaurante", 731,17, 13.579,24 e o nome "Fulana" — por
  `history` (respostas locais) e por `nome`/`saldoEmConta`/listas no contexto.
- **Depois** (`bfd8f83`, invariantes 114–119, com caso positivo): `history` não é enviado e o
  servidor o ignora; o contexto passa por lista de campos permitidos; a conversa vai como estrutura
  normalizada contra o vocabulário do usuário.
- **O que AINDA sai, e só isto** — não é "privado 100%":
  - chat: o texto do turno atual (ou só o trecho em aberto quando parte foi resolvida no aparelho),
    com o que o usuário tiver escrito nele; perfil; categorias; nomes de cartão e de meta; IDs das
    categorias mais usadas (com o modo adaptativo ligado); a conversa como estrutura (tipo do último
    pedido, rótulo de período gerado pelo app, fonte/métrica/agrupamento, filtros por categoria,
    cartão e meta, "havia filtro de texto/origem" sem o texto, campos que faltam);
  - chat, só quando o trecho em aberto é pergunta ou pedido: agregados numéricos (totais do mês,
    valores de metas, orçamentos, quantidade/total/dias das contas e entradas previstas, faturas,
    agregados de parcelamento sem lista, projeção sem saldo estimado, campos de motorista ou meta
    mensal);
  - planejador: perfil, categorias, nomes de cartão e meta e a pergunta.
- Nunca saem: nome do usuário, saldo e o que deriva dele, lançamentos, descrições, origens, listas,
  veículo, journal. Limite: o app publicado roda o código anterior até um redeploy (não autorizado).

#### Rota `local-errada` no corpus de avaliação

Linha de base de 13/09: 35. **Saíram 8:** p-14 e p-19 → remota; p-20, p-29, c-16, s-03, s-05, s-11 →
local correta. **Continuam 27:** planejador p-01, 03, 06, 09, 11, 12, 13, 16, 17, 18, 21, 22, 23, 24,
25, 26, 27, 30, 32, 33, 34; chat c-20; cenário s-01, 02, 04, 07, 13. *Correção de uma contagem dita
durante a rodada: não eram "34" com "cinco corrigidas".*

#### Defeitos colaterais que NÃO foram corrigidos (relidos no código atual em 15/09)

*Em 17/09/2026 as seis primeiras linhas e a da "casa 2" foram corrigidas — ver a seção "Quatro bugs
financeiros críticos" abaixo. As demais continuam abertas.*

| Frase | Hoje | Esperado |
|---|---|---|
| `salario caiu 3200 e ja paguei o aluguel de 1100` (CLT) | receita 3.200 + receita 1.100 + despesa 1.100 | receita 3.200 + despesa 1.100 |
| `o 150 que eu te falei era de farmácia não de mercado` | nova despesa 150 | corrigir o existente ou perguntar |
| `aquele gasto de ontem foi 90 e não 80` | nova despesa 90, descrição "Não 80" | corrigir o existente ou perguntar |
| `aquele do mercado foi 230 na verdade` | nova despesa 230 | corrigir o existente ou perguntar |
| `hoje uber deu 210 e a 99 uns 130 abasteci 80` (motorista) | só abastecimento 80 | receitas 210 e 130 + abastecimento 80 |
| `recebi 1800 da casa 1 e 1200 da casa 2 mas a 2 ainda vai cair na conta amanhã` | as duas como realizadas + aviso de nada agendado | só 1.800; 1.200 explicado como futuro |
| `caiu o vale alimentação 800` (CLT) | consulta de gastos com alimentação | receita 800 ou pergunta |
| `paguei 320 de luz 180 de agua e a internet eu nao lembro` | uma despesa 320, descrição "Luz 180 de agua" | despesas 320 e 180 + pergunta da internet |
| `guardei 300 na meta da viagem e 200 na outra` (c-20) | depósito 300 na Viagem; **os 200 somem em silêncio** | 300 Viagem + 200 na outra meta, ou pergunta |
| `gastei sessenta vírgula cinquenta de farmácia ponto` | R$ 60,00 | R$ 60,50 |
| `e se eu parar a obra agora quanto sobra até dezembro` | projeção factual | simulação sem a obra |
| `onde meu dinheiro mais vazou nos últimos 90 dias?` | o total do período | a categoria ou mudança que mais pesou |

Também em aberto (lista em `docs/AI_REMOTE_EVAL.md` §10): "obra e lazer" soma só obra, "acima de
200/500" vira texto, "tirando a casa 1", "desde março/junho", "fins de semana", "qual cliente me pagou
mais", "líquido por corrida", "trocar de carro dando 20 mil" ignora a entrada, "parar de guardar por 3
meses" vira R$ 3/mês, "2 horas por dia" vira 30 dias, hipóteses compostas.

#### Bugs novos encontrados nesta rodada

| Bug | Status |
|---|---|
| "mandei 200 pra meta do carro" casava "andei" → 200 km | CORRIGIDO E TESTADO (rt-17, invariante 112) |
| "e se em vez de 10x eu fizer 12 dando mil de entrada?" simulava compra de R$ 12 (regressão da borda de dígito, pega antes do commit `713970d`) | CORRIGIDO E TESTADO só indiretamente (rotas p-36/c-23/s-12 do autoteste); **caso dedicado AINDA PENDENTE** |
| Critério de suspeita apagava lançamento datado ("paguei 100 mês passado", "gastei 40 dia 5") | CORRIGIDO E TESTADO (`98d23f3`, invariante 109 + corpus temporal) |
| "que" solto lido como comparação (p-14/p-19) | CORRIGIDO E TESTADO |
| `periodFromText` respondia 7 dias para "em 90 dias" | CORRIGIDO E TESTADO (rt-07) |
| Depósito em meta sem meta correspondente ficava confirmável | CORRIGIDO E TESTADO (rt-19) |
| Lookahead novo rejeitava "gastei 355." (mix-01) | CORRIGIDO E TESTADO |
| Caracteres de controle literais (U+0000, U+001F) no regex de `rotuloDePeriodo`, `remoteContext.ts` — entraram em `bfd8f83`; esse commit sozinho falha a invariante 104 | CORRIGIDO E TESTADO (escape em texto; gate final acima, 119/119) |
| Invariante 104 só varre arquivos versionados — arquivo novo não commitado escapa do gate | AINDA PENDENTE (limitação registrada, sem mudança) |
| `PROGRESS.md` linhas ~1460–1461 com U+0008 (diário antigo, fora da varredura) | AINDA PENDENTE (fora do escopo) |
| `remoteContext.ts` linha 140: faixa de acentos combinantes escrita literal no regex (funciona; não é controle) | AINDA PENDENTE (cosmético) |

#### Benchmark A+B+C — AINDA NÃO AUTORIZADO

Nada foi executado. Orçamento offline (`--sem-saldo`), **já sobre o conjunto elegível**: A+B+C × 1 =
US$ 0,17 central / 0,41 pessimista / 2,01 pior caso; A+B+C × 3 = 0,51 / 1,24 / 6,02. Último saldo
conhecido US$ 1,96 (13/09), compartilhado com o app publicado e **não reconferido**. Recomendação em
`docs/AI_REMOTE_EVAL.md` §12 (≈ US$ 5 de crédito; primeira rodada com `--repeticoes=1 --teto-usd=1.00`).
Depende de autorização explícita de gasto.

*Correção de uma afirmação errada desta seção:* dizia-se aqui que os 27 casos `local-errada` "ficam
fora do corpus pago". **Não ficavam.** O filtro era `rota !== 'local'`, e `local-errada` não é `local`:
os 27 entravam na bateria paga e na nota dos modelos, com c-36 dando 28. Corrigido em 15/09/2026 — ver
a seção seguinte.

#### Elegibilidade do benchmark remoto — corrigida em 15/09/2026

**A causa.** O corpus pago era filtrado por RÓTULO humano (`rota !== 'local' || dimensao ===
'seguranca'`), não por comportamento. Rótulo envelhece e rótulo mente: `local-errada` passava pelo
filtro, e o avaliador chamava o modelo em 28 frases que o aparelho fecha sozinho em produção. O modelo
era pontuado — e pago — por decisões que ele nunca toma no app.

**A regra agora.** A elegibilidade é DERIVADA da execução: antes de qualquer gasto, o orquestrador de
produção roda com os dois caminhos remotos substituídos por gravadores (`tests/assistant/eval/routing.ts`),
e um caso só entra se ali saiu requisição. Três classes, e nenhuma some do relatório:

| Classe | O que é | Entra na nota do modelo? |
|---|---|---|
| `local-correto` | o aparelho responde, e responde certo | não |
| `local-falha` | o aparelho responde, e responde errado, antes de o modelo existir | não — continua listada como bug |
| `remoto-elegivel` | saiu requisição; a saída do modelo podia mudar o resultado | **sim** |

O rótulo `rota` continua no corpus como diagnóstico. O autoteste confere que ele não divergiu da
medição e, se divergir, **quem manda é a medição** (foi o caso de p-14 e p-19).

**Recontagem sem rede (zero chamadas):** 114 frases + 6 conversas. Resolvidas no aparelho 48 (21
certas, 27 erradas); **66 elegíveis ao remoto (57,9%)** — chat 44/55, planejador 19/44, cenário 3/15 —
mais 9 turnos de chat e 9 de planejador nas 6 conversas. O número 66 não mudou: o que mudou foi
quantas frases são PAGAS. Os 27 `local-errada` continuam sendo exatamente os 27 que não chegam ao
remoto (p-01, 03, 06, 09, 11, 12, 13, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 30, 32, 33, 34; c-20;
s-01, 02, 04, 07, 13) — **nenhum deles chega**.

**Efeito no custo.** Chamadas lógicas por repetição, por configuração: **112 → 84** (−25%). A+B+C × 3
cai de US$ 0,63/1,50/7,43 para 0,51/1,24/6,02; A+B+C × 1 fica em 0,17/0,41/2,01.

**Fallback e retry.** Remoto chamado + saída inútil + fallback local salvando a UX agora conta como
falha DO MODELO (`remote failure rate`, separada de `transport failure rate`), mesmo quando o usuário
vê uma resposta certa. E uma mensagem para um caminho remoto é UMA chamada lógica por mais que o
cliente repita a requisição: retry entra em custo, latência e tentativas HTTP, nunca no denominador da
qualidade.

**Relatório em três blocos que não se misturam:** APP/ROTEAMENTO (diagnóstico do aparelho),
QUALIDADE DO MODELO (só elegíveis) e TRANSPORTE (casos lógicos, chamadas lógicas, tentativas HTTP,
retries, falhas, latência, tokens, custo). Há também uma trava de justiça: se duas configurações forem
medidas sobre conjuntos elegíveis diferentes, o relatório avisa em vez de comparar.

**Fora de escopo nesta rodada, de propósito:** os quatro bugs financeiros perigosos (receita falsa de
R$ 1.100; correção falada virando lançamento novo; Uber/99 perdendo as duas receitas; entrada futura
proposta como recebida), vale alimentação, água, c-20, decimal e o cenário "parar a obra". Nada de
parser, Query DSL, Scenario Engine, modelo, thinking ou retry de produção foi tocado.

**Testes:** 434/434 no avaliador (eram 418; 16 novos). RED demonstrado antes da correção — com o filtro
antigo o autoteste falha em 3 verificações e lista os 28 casos nominalmente. Cobertura: frase local não
é elegível; frase que chama o transporte é elegível; fallback não perdoa o remoto; retry é 1 caso
lógico e N tentativas; rótulo `local-errada` não derruba quem chega ao remoto; rótulo `remota` não
promove quem morre no aparelho; denominadores idênticos entre configurações (e divergência detectada).

#### Quatro bugs financeiros críticos — corrigidos em 17/09/2026

Nenhuma chamada paga, nenhum push, nenhum deploy. Benchmark continua NÃO AUTORIZADO.

| Bug | Componente | Causa real | Commit |
|---|---|---|---|
| Receita fantasma de R$ 1.100 | associação verbo/valor/entidade | não era herança entre cláusulas: "ja paguei o aluguel de 1100" SOZINHA já gerava receita + despesa. A regra "fonte de renda como sujeito" ignorava o verbo de pagar da própria cláusula — e "paguei a comissão de 200" virava só receita | `5ba621f` |
| Correção falada cria lançamento | correção/referência | o caminho de edição de lançamento salvo só reconhecia o imperativo com "para"; "aquele foi 90 e não 80" caía no parser de registro, onde "foi" é verbo de despesa | `b8754c7` |
| Uber/99 perde as receitas | associação entidade↔valor↔tipo | o parser de frases exige verbo de receita e valor antes da plataforma; o dia telegráfico só lê valor→plataforma, com 3+ partes e só para motorista. "salario 3200 aluguel pago 1100" era o mesmo buraco | `baebb2d` |
| Futuro proposto como recebido | modalidade temporal | o "amanhã" era lido, mas na cláusula "a 2 ainda vai cair" — sem valor próprio, referindo a casa 2 da cláusula anterior. E "vai cair 1800" não era futuro: virava despesa realizada | `5b015a9` |

Compartilhamento real de causa: só o da variante "salario 3200 aluguel pago 1100" (bug 1) com o bug
3 — ambos são pareamento telegráfico, resolvido pelo mesmo leitor. Os demais são mecanismos
diferentes e foram corrigidos separadamente. Dois efeitos colaterais da MESMA família apareceram no
reparo de digitação: "caiu" virava "saiu" (receita → despesa) e "vai sair" virava "vai saiu"
(futuro → passado); os dois verbos entraram no vocabulário estrutural.

**Testes:** corpus `cases-classe-financeira.ts` com 56 casos (tipo-clausula 11, correcao-falada 13,
pares-telegraf 12, futuro 20), RED antes: 2/11, 3/13, 3/12, 17/20. Invariantes 87–90 (tipo isolado
por verbo; correção não cria; pares preservam cardinalidade; futuro não vira realizado), as quatro
RED antes. Final: 618/618 casos, 75/75, 4.080 + 3.800 metamórficos, 1.416 fuzz, 123/123 invariantes
(90 financeiras), avaliador 434/434.

**Roteamento sem rede:** inalterado — 21 local-correto, 27 local-falha, 66 elegíveis ao remoto
(chat 44/55, planejador 19/44, cenário 3/15), 84 chamadas lógicas por repetição.

**Continuam abertos:** vale alimentação 800; água de 180; c-20; "sessenta vírgula cinquenta";
"onde vazou"; "e se parar a obra" (e o rótulo "Projeção para /z. de 2026" na resposta dela — achado
novo, já existia em `7777c17`); "o aluguel foi 1800" propõe receita E despesa do mesmo valor (achado
nesta rodada, mesma família do bug 1 mas sem verbo que desempate — não corrigido); caso dedicado para
"12x" não virar R$ 12; invariante 104 só varre arquivos versionados; os demais 27 local-falha.

#### Integridade de valor e cardinalidade — corrigida em 17/09/2026

Nenhuma chamada paga, nenhum push, nenhum deploy. Benchmark continua NÃO AUTORIZADO.

| Bug | Estágio | Causa real | Commit |
|---|---|---|---|
| "o aluguel foi 1800" propunha receita E despesa | ambiguidade / reconciliação | duas regras liam o MESMO valor com tipos opostos e nada reconciliava. "Aluguel" e "vale" não têm direção própria | `83e6a94` |
| "vale alimentação 800" sumia | mesma acima | sem verbo o valor não virava nada, e a frase era respondida como consulta de gastos com alimentação | `83e6a94` |
| R$ 180 de água sumiam | extração de candidatos | a DESCRIÇÃO da despesa engolia o item seguinte ("Luz 180 de agua"), e itens justapostos sem conector não eram lidos | `83e6a94` |
| c-20 perdia R$ 200 | extração de candidatos | o primeiro depósito em meta encerrava a cláusula e o resto nunca era procurado | `83e6a94` |
| "sessenta vírgula cinquenta" virava R$ 60 | normalização de números | a conversão por extenso resolvia cada metade e devolvia "60 vírgula 50"; os centavos iam para a descrição | `c66e52c` |
| "e em 12x?" não fazia nada | correção sobre a proposta | não havia correção do campo de parcelas; a frase caía no texto genérico com a compra pendente na tela | `51911d2` |

Causa compartilhada real: "o aluguel foi 1800" e "vale alimentação 800" são o mesmo mecanismo
(substantivo financeiro sem polaridade verbal) e foram resolvidos juntos. Água e c-20 são os dois do
mesmo estágio, mas por regras diferentes. O decimal falado e o follow-up de parcelas são isolados.

**Regra do decimal falado, escrita:** o que vem depois de "vírgula" é a parte decimal como foi dita —
"dez vírgula cinco" é 10,5 (R$ 10,50) e "sessenta vírgula cinquenta" é 60,50. Sem completar para dois
dígitos, o que transformaria 10,5 em 10,05. "Ponto" não é separador decimal: na fala transcrita é
ditado de pontuação ("de farmácia PONTO").

**Comportamento da ambiguidade:** zero ação confirmável. O app pergunta ("Você recebeu R$ 1.800,00 de
aluguel ou pagou R$ 1.800,00 de aluguel?") e cada opção carrega o lançamento inteiro, então responder
"recebi" resolve sem repetir o valor. Com verbo — recebi, entrou, paguei, gastei, "o aluguel que
recebi foi 1800" — não há pergunta nenhuma.

**Cobertura de valores (invariante 92):** todo valor monetário explícito termina numa proposta, dentro
da pergunta que o app fez, ou citado na resposta. A lista é curada de propósito e carrega os
contra-exemplos — km, litros, horas, parcelas e dias não são dinheiro.

**Correção incidental:** "abasteci 24 litros por 180" lia 24 como valor e descartava os 180; achado
pela própria invariante de cobertura e corrigido junto.

**Testes:** corpus `cases-valor-cardinalidade.ts` com 42 casos (polaridade 10, valor-sumido 9,
decimal-falado 7, parcela-nao-preco 7, nao-e-dinheiro 9). RED antes: 5/10, 5/9, 3/7, 6/7, 9/9.
Invariantes 91–94. Final: 660/660 casos, 75/75, 4.080 + 3.800 metamórficos, 1.416 fuzz, 127/127
invariantes (94 financeiras), avaliador 434/434.

**Roteamento sem rede:** inalterado — 21 local-correto, 27 local-falha, 66 elegíveis ao remoto.
Durante a rodada c-38 ("recebi o aluguel da kitnet 900") chegou a ser resolvido localmente por uma
versão intermediária da regra de polaridade; a trava de adjacência (o valor precisa pertencer ao
substantivo) devolveu o caso ao remoto, e o rótulo do corpus não precisou mudar.

**Continuam abertos:** "onde vazou"; "e se parar a obra" (e o rótulo "Projeção para /z. de 2026" na
resposta dela); os 27 local-falha do corpus; invariante 104 só varre arquivos versionados.

#### Autópsia dos 27 local-falha e três causas corrigidas — 18/09/2026

Nenhuma chamada paga, nenhum push, nenhum deploy. Benchmark continua NÃO AUTORIZADO. A integridade
monetária ficou congelada: todos os grupos das duas rodadas anteriores continuam verdes.

**Os 27, por causa principal** (antes de mexer em código):

| Causa | Casos | Estágio |
|---|---|---|
| C1 sobra não entendida vira filtro de texto → "não tenho lançamento" / "R$ 0,00 (dado real)" | p-11, p-13, p-24, p-30, p-18 | query parse + confiança |
| C2 distribuição/mudança vira total ("onde", "oq mais pesou", "maior mudança") | p-06, p-32, p-03 | query parse |
| C3 duas entidades coordenadas, só a primeira vale | p-09, p-26, p-12 | query parse |
| C4 "desde X" / "últimos meses" lido como um mês só | p-33, p-34, p-01 | período |
| C5 métrica/fonte especializada ausente, ou atalho antigo responde antes | p-16, p-17, p-21, p-23, p-25, p-27 | query/fonte + legado |
| C6 origem com número truncada na exclusão | p-22 | query parse |
| C7 hipótese composta: só a primeira é simulada | s-01, s-02 | scenario parse |
| C8 quantidade do cenário (entrada + financiado, semana = 30 dias, "3 meses" → R$ 3) | s-04, s-07, s-13 | scenario parse |
| C9 rótulo velho — já correto | c-20 | — |

**Escolhidas:** C1 (maior cluster que afirma coisa FALSA sobre os dados), C2 (contém "onde vazou") e o
bug "e se parar a obra" — que é uma classe: hipótese sem plano local respondida como fato. O "/z." de
dezembro era um defeito de saída à parte, pedido explicitamente, e foi corrigido junto.

| Commit | Causa real |
|---|---|
| `0461dde` | "/z. de 2026": `toLocaleDateString` + replace de "de" sem limite de palavra; a primeira "de" de "dez. de 2026" está dentro de "dez". Em dois lugares (projeção e consulta por mês) |
| `7bc71c0` | C1: a sobra da pergunta virava filtro de texto e o vazio era dito como fato. Plano INCOMPLETO não é executado; vai ao remoto |
| `f8045fe` | C2: "onde" nem era sinal de consulta; "oq" não virava "o que"; "maior mudança" virava `max` |
| `8c467d4` | hipótese: o roteador antigo respondia a metade "quanto sobra até dezembro" como fato; e não havia tipo de cenário para parar um gasto |

**Regressão introduzida e corrigida DENTRO da rodada:** gravar o plano no foco também quando o
roteador antigo responde (necessário para "quanto gastei com obra" → "onde?") fazia follow-ups que
iam ao remoto serem respondidos errado no aparelho — "sem contar o cimento" não excluía nada, "e na
99" buscava o texto "99". A trava de sobra passou a valer no refino, e "sem CONTAR o X" exclui X. Por
isso C1 foi commitado ANTES de C2. Outra: "parar" estava a uma letra de "pagar" no reparo de
digitação (mesma família do "caiu"/"sair").

**Roteamento:** antes 21 local-correto · 27 local-falha · 66 remoto; depois **29 · 15 · 70**. Caso a
caso em `docs/AI_REMOTE_EVAL.md` §10. Conversas: 7 turnos chegam ao chat e 7 ao planejador (eram 9 e
9) — saíram "e no mês retrasado", "sem contar o cimento" e "e semana passada" (agora certos no
aparelho, conferidos à mão) e entrou "e o que eu faço com isso", que antes respondia "não tenho
faturas com 'que eu faco com isso'… cadastre um cartão". Chamadas lógicas por repetição e
configuração: 84 (igual). A+B+C × 1 = US$ 0,17 / 0,41 / 1,98; × 3 = 0,51 / 1,22 / 5,95.

**Testes:** corpus `cases-semantica.ts` pelo ORQUESTRADOR (27 casos: distribuição 11, resíduo 6,
hipótese 10), RED antes 0/11, 1/7, 0/8. Invariantes 120 (rótulo de mês nos 12 meses), 121 (hipótese
nunca vira fato, com e sem foco, com e sem remoto) e 122 (sobra nunca vira filtro, com o contraste do
nome de lugar). Final: 660/660, 75/75, 27/27 semânticos, 4.080 + 3.800 metamórficos, 1.416 fuzz,
130/130 invariantes, avaliador 434/434.

**Achados novos, NÃO corrigidos:** "quanto gastei no restaurante do amarelo" — lugar que não existe —
é respondido pelo atalho antigo com "R$ 750,00 nos últimos 7 dias", ignorando o nome (já era assim
antes; é da causa C5). O roteador antigo lê o relógio e não a data injetada (regra 35), o que obriga
os testes de conversa a usar a data real.

**Continuam abertos:** C3, C4, C5, C6, C7 e C8 (15 casos); invariante 104 só varre arquivos
versionados.

#### C5: o atalho antigo só responde o que expressa — 18/09/2026

Nenhuma chamada paga, nenhum push, nenhum deploy. Benchmark continua NÃO AUTORIZADO. Só C5; C3, C4,
C6, C7 e C8 não foram tocados.

**Reexecução no HEAD antes de mudar** (sonda descartável pelo orquestrador real, sem rede, e cada
plano conferido com `comparaPlano`): p-17 já ia ao remoto (C1) e p-21 já estava certo (rótulo velho).
Quebrados de verdade, todos com capacidade local REAL:

| Caso | Quem respondia antes | Estágio |
|---|---|---|
| p-16 "quantas vezes eu fui no bar esse mês e quanto deu" | `explain.ts` pedia "me diga o nome do lugar"; e "no bar" virava Lazer inteiro | explicação (passo 2a) + planejador |
| p-23 "quanto já paguei das parcelas da geladeira" | resumo antigo dos cartões (`resolveLocal`) | roteador antigo + planejador |
| p-25 "qual cliente me pagou mais freela esse ano" | consulta com GASTOS por origem | planejador (direção) |
| p-27 "quanto eu tiro líquido por corrida em média esse mês" | atalho antigo: bruto, últimos 7 dias | roteador antigo + planejador (ordem da métrica) |
| "quanto gastei no restaurante do amarelo" (e "no mercado", "no Zé") | total antigo de "quanto gastei": R$ 750 da semana, sem o lugar | roteador antigo |

| Commit | Causa |
|---|---|
| `2fffd9f` | a checagem de capacidade (`alemDoAntigo`) não conhecia filtro de texto nem as contas por unidade fixas do roteador antigo. Exposto e corrigido junto: `parsePeriod` devolvia o RÓTULO como trecho e nada era consumido ("no Zé esse mês" → busca "ze esse"); e "hein" no fim da fala grudava no alvo |
| `888ef69` | o planejador lia outra métrica/direção/fonte: "por corrida em média" virava média por lançamento; "me pagou" virava gasto; "parcelas da X" perdia o X; "no bar" virava categoria; "quantas vezes… e quanto" só contava. E a explicação de "quantas vezes" consumia pergunta que nomeia o lugar |

**Regressões achadas DENTRO da rodada, antes do commit:** "quanto devo de cartão?" passou a ser
respondido pela consulta com a busca "cartao" (palavra do app não é nome — a trava a exclui); e p-30
("…mes passado hein") virou rascunho de gasto quando o período passou a ser consumido de verdade (o
"hein" grudou em "cartao"). As duas estão no corpus agora. A diferença das respostas locais do corpus
de avaliação inteiro (114 frases + 38 turnos) antes/depois mostra só p-16, p-23, p-25, p-27 e p-43
(elegível; sem remoto a resposta passou de gasto a receita, e ainda não filtra a 99). Sonda red-team
idêntica byte a byte; rubrica igual (0 · 0 · 6 · 84).

**Roteamento:** 29 · 15 · 70 → **33 · 11 · 70**. Conjunto elegível e turnos de conversa comparados
nominalmente: idênticos. 84 chamadas lógicas por configuração (chat 44 · planejador 30 · cenário 3 ·
conversa 7). A+B+C × 1 = US$ 0,17 / 0,41 / 1,98; × 3 = 0,51 / 1,22 / 5,95 (inalterado).

**Testes:** 13 casos no grupo `capacidade` do corpus semântico (RED 5/13 — só os controles passavam),
sr-04 reforçado, invariante 123 (lugar × 10 períodos × remoto ligado/desligado, com o contraste de
categoria; RED nas duas metades). Final: 660/660, 75/75, 40/40 semânticos, 4.080 + 3.800, 1.416 fuzz,
131/131 invariantes, avaliador 434/434.

**Continuam abertos:** C3, C4, C6, C7, C8 (11 casos). "Quanto paguei do mercado" (preposição "do")
ainda perde o alvo; "quanto faço por hora" do atalho antigo é lucro/hora, não faturamento/hora —
anotados, não corrigidos (fora de C5 e sem caso no corpus pago).

#### Primeira bateria paga A+B+C ×1 — 19/09/2026

Autorizada pelo dono: 1 repetição, teto US$ 0,60, reserva US$ 1,00. Nenhuma alteração de código,
prompt, modelo, pensamento, retry ou produção durante ou depois. Saldo US$ 1,96 → US$ 1,90; gasto
registrado US$ 0,092. Mesmos 77 casos para as três (lista com hash salva antes). Resultado e
metodologia em `docs/AI_REMOTE_EVAL.md` §13: B (v4-pro sem pensamento) lidera em segurança (6/77
execuções com perigo, zero ação perigosa) contra A 11/77 e C 13/77, com IC sobrepostos a A. Achados:
produção (C) trunca o raciocínio em `max_tokens: 900` (21 cortes, 16 vazias, 13 retries);
`order: null` faz o validador recusar ~40% dos planos remotos em todos os modelos; o detector de
alucinação numérica acusa número calculado no aparelho no caminho do planejador (1 caso). Nada
corrigido — aguarda decisão.

#### Infraestrutura da avaliação: `order: null`, proveniência e replay — 19/09/2026

Sem chamada DeepSeek, sem gasto. A primeira bateria paga (§13 de `docs/AI_REMOTE_EVAL.md`) foi
contaminada por dois defeitos, ambos corrigidos e medidos por replay sobre as MESMAS saídas gravadas:

- **`order: null`** (`f2ab05d`): o validador recusava 27 de 29 planos remotos em todas as
  configurações; a auditoria achou a mesma classe em outros opcionais do plano, do filtro e do
  envelope, e `filter.weekdays: null` virava domingo. Normalização de borda por lista explícita;
  invariantes 124 e 125.
- **Proveniência** (`feac1da`, `2d008be`): número calculado no aparelho a partir do plano do modelo
  contava como alucinação do modelo (C/k-04#5). Só o texto do modelo é julgado; regra 53 intacta.
- **Replay** (`041a9ed`): `--replay` repassa a bateria gravada, tentativa por tentativa, sem rede;
  com o código antigo reproduz o relatório original em todos os campos.

Resultado: planos recusados 29 → 2; e o `order: null` ESCONDIA erros de modalidade (p-37 em A/B/C,
p-38 em A), agora visíveis. Ordem B > A > C mantida. Resultados originais preservados em
`eval-results/`. **Nova bateria A+B+C do zero é necessária** antes de qualquer decisão de modelo.

Esta rodada começou com outra sessão trabalhando na mesma pasta ao mesmo tempo (`f2ab05d`, `feac1da`,
`acfb5d1`). A reconciliação manteve a Parte A e o núcleo da proveniência como estavam, ficou com o
replay que reproduz a bateria (o alternativo foi removido, junto com o doc separado, incorporado ao
§14), e corrigiu o `typecheck:api` que ele quebrava.

#### Bateria limpa A+B+C ×1 e o envelope exposto — 19/09/2026

Bateria autorizada depois das correções de infraestrutura: US$ 0,0637, mesmo corpus nas três
configurações. A leitura achou uma lacuna do avaliador: C mostrou o envelope JSON cru e truncado ao
usuário em 9 casos (pensamento consumindo o `max_tokens: 900`), e o detector não contava. Corrigido só no
avaliador (`a2824ef`, perigo `envelope-exposto`, separado de vazamento de dado); replay offline: A 0, B
0, C 9. Ordem B > A > C; C inadequado na configuração atual; A vs B ainda dentro do ruído. Detalhe em
`docs/AI_REMOTE_EVAL.md` §15. Produção, C, servidor e prompt não foram mudados.

#### Seleção final do modelo e hardening determinístico — 19/09/2026

Escolhido para a futura produção: **B — `deepseek-v4-pro`, pensamento desligado**. Três repetições de A+B,
231 execuções por modelo: A 42 execuções com perigo e 5 ações perigosas; B 19 e 0. Custo de B ~US$ 0,154
por 1.000 mensagens (~3× A) e latência maior, aceitos pela segurança. C (produção atual) rejeitado por
truncamento estrutural. A configuração de produção NÃO foi alterada.

Hardening sem chamada paga, para defeitos que os dois modelos tinham: plano remoto não rebaixa futuro,
negação, retratação ou recorrência explícitos (`08b8d2a`, invariante 126); a resposta nunca afirma
execução de ação pendente, e "Registrado!" só depois do lote gravado (`e4a247d`, invariantes 127–128).
Detalhe em `docs/AI_REMOTE_EVAL.md` §16.

#### Troca mínima preparada e smoke pré-deploy — 25/09/2026

Produção candidata alterada para a configuração escolhida no §16: padrão `deepseek-v4-pro` e
`thinking: { type: 'disabled' }` em todas as tentativas, inclusive no reenvio. Prompt, retry,
`max_tokens: 900`, temperaturas 0,2/0, timeout, parsers, Query DSL, Scenario Engine e evaluator não
mudaram. `.env.example` e `CLAUDE.md` agora documentam o mesmo padrão.

A invariante 129 usa `fetch` falso, força o reenvio e prova: modelo v4-pro, pensamento desligado nas
duas tentativas, temperaturas preservadas, `max_tokens` preservado e chave somente no header
server-side. Baseline local: 660/660 casos, 75/75 goldens, 40/40 semânticos, 4.080 + 3.800
metamórficos, 1.416 fuzz, **137/137 invariantes**, 468/468 evaluator, `typecheck`, `typecheck:api`,
build e `vercel build --prod` verdes. Varredura de 31 artefatos em `dist/` e `.vercel/output`: zero
padrão de chave e zero ocorrência da chave real do `.env`.

Pré-voo remoto: `/models` confirmou `deepseek-v4-pro`; saldo antes e depois apareceu como US$ 1,75.
Smoke limitado a cinco chamadas sintéticas pela pipeline compartilhada: chat, proposta,
esclarecimento, planner e composição deram HTTP 200, sem resposta vazia, envelope interno no `reply`
ou padrão de segredo. Nenhum benchmark foi reaberto.

**Deploy concluído:** o override Production `DEEPSEEK_MODEL=deepseek-v4-flash` foi removido da
Vercel; `DEEPSEEK_API_KEY` permaneceu intacta. A feature entrou em `main` por fast-forward, o commit
de runtime `0b5e8b9` foi enviado ao GitHub e publicado como deployment
`dpl_9T7v31TwTRBWk4Qzxf4y6MWvTBu6`, Ready e aliasado para `https://assist-fin.vercel.app`.

O smoke pós-deploy confirmou HTTP 200 no app e o mesmo bundle produzido nos gates. As cinco rotas
públicas — chat, proposta, esclarecimento, planner e composição — deram HTTP 200, sem resposta vazia,
envelope interno no `reply` ou padrão de segredo. Produção agora usa o padrão do código:
`deepseek-v4-pro` com pensamento desligado. Nenhum APK foi gerado.

#### Intelligence v2 local — 25/09/2026

Branch `feat/assistant-intelligence-v2`, criada de `main`/`origin/main` em `e6f6229`. Auditoria
prévia reexecutou os onze casos históricos C3/C4/C6/C7/C8: todos ainda tinham falha semântica
completa; p-34 só havia ganhado roteamento seguro. Implementados: consultas multi-entidade,
intervalos `desde`/fechados, exclusões com identidade inteira e listas, clarificações específicas,
cenários compostos, separação de duração e dinheiro, Conversation Focus entre modalidades e o
motor local `drivers/`, cuja soma de contribuições reconcilia com a variação do resultado.

Personalização e anomalia existentes foram auditadas e preservadas: modelo derivado de histórico
confirmado e aviso por mediana/amostra, nunca bloqueio. Não foi criada memória livre.

Gates finais offline: 660/660 corpus, 97/97 consulta/cenário/continuidade, 50/50 semânticos,
4.088 + 3.800 metamórficos, 1.416 fuzz, 138/138 invariantes, 468/468 evaluator, `typecheck`,
`typecheck:api` e build verdes. Aviso conhecido: chunk principal acima de 500 kB.

Commits de código: `d57d288`, `1e6e384`, `1d65c41`, `7aecb8a`, `3b1797a`, `7729a5c`.
Documento detalhado: `docs/AI_INTELLIGENCE_V2.md`.

Zero DeepSeek, zero gasto, zero push, zero merge, zero deploy e zero APK. `.claude/launch.json`
permaneceu como a única modificação local fora dos commits.

#### Resposta à auditoria adversarial da Intelligence V2 — 01/10/2026

A auditoria independente em `36d0135` declarou **NOT READY** e reproduziu
C1–C3/H1–H9. Checkpoint RED anterior à mudança em
`docs/AI_INTELLIGENCE_V2_ADVERSARIAL_RED.md`; correções, provas por classe,
privacidade e dívida em `docs/AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md`.

Commits locais: `dbe0bca` (baseline matemática), `66685df` (preferências e
consultas), `a733a1f` (modalidade por cláusula e dinheiro), `a8cbc53`
(clarificações de consulta) e `95f613d` (recorte causal). A suíte agora inclui
**46/46 REDs** pelo orquestrador real, com oráculos literais e aplicação de
lotes em memória quando relevante. Baseline: 660/660 corpus, 99/99 consulta,
50/50 semânticos, 4.088 + 3.800 metamórficos, 1.416 fuzz, 150/150
invariantes, 468/468 evaluator; typechecks e build verdes. O aviso antigo do
chunk maior que 500 kB permanece.

**Não declarar READY** até a segunda auditoria Astra do diff. M5 (anomalia)
permanece fora desta rodada. Zero DeepSeek/gasto, push, merge, deploy ou APK;
`.claude/launch.json` fica fora dos commits.

## 2026-10-24 — checkpoint documental após três auditorias locais da Intelligence V2

**Estado verificado nesta revisão:** branch `feat/assistant-intelligence-v2`;
base de código `c63d6bc` antes deste commit de documentação. A única alteração
preexistente no working tree era `.claude/launch.json`, configuração local não
incluída em commits. `main` e `origin/main` apontam para `e6f6229`; a
Intelligence V2 continua só na branch local. Produção foi publicada em
25/09/2026 com `deepseek-v4-pro` e thinking desligado, conforme o registro de
deploy/smoke acima — não houve nova checagem online nesta revisão.

**Por que os documentos pareciam parados:** o cabeçalho deste diário ainda
dizia “15/09”, embora o fim já contivesse checkpoints de 25/09 e 01/10.
`CONTEXT.md` era um handoff de 15/09, com números e próximos passos obsoletos;
`CONTEXTO.md` é a visão de produto. O handoff antigo foi preservado em
`docs/archive/CONTEXT-2026-09-15.md`; `CONTEXT.md` agora só encaminha para as
fontes atuais. `CONTEXTO.md`, `README.md` e `docs/AI_CURRENT_STATE.md` ganharam
o checkpoint atual; `CLAUDE.md` continua como guia de regras permanentes.

### Trabalho local desde o checkpoint de 01/10

- `acd5f7b`, `64be663`, `4e5f050`, `e9177e5` e `3693a23`: correções de
  consultas, modalidade, pagamentos e anomalias após auditorias adversariais.
- `ff6a6a3`: correções do segundo parecer, incluindo âncora temporal,
  pagamentos legados, aliases, negações e foco de categoria. Relatório em
  `docs/AI_INTELLIGENCE_V2_ASTRA_AUDIT_FOLLOWUP_2.md`.
- `c63d6bc`: correções do parecer seguinte para comparação, corrida não paga,
  precisão temporal e vínculos de fatura. Relatório em
  `docs/AI_INTELLIGENCE_V2_ASTRA_AUDIT_FOLLOWUP_3.md`.

**Gates locais registrados para `c63d6bc`:** 660/660 corpus, 99/99
consulta/cenário/continuidade, 50/50 semânticos, 128/128 adversariais,
4.088 + 3.800 metamórficos, 1.416 fuzz, 151/151 invariantes e 468/468
verificações remotas **offline**. `typecheck`, `typecheck:api`, `test:money`,
`build`, rubrica e `git diff --check` passaram. Rubrica: 0 perigosa, 0 ruim,
7 aceitáveis, 83 excelentes. O build conserva aviso de chunk acima de 500 kB.
Isso é evidência de regressão conhecida, **não aprovação**.

### Último parecer independente recebido para `c63d6bc`: NOT READY

O Astra confirmou os gates e reproduziu, com orquestrador/executor/reducer e
estados sintéticos, defeitos fora dos 128 testes. O parecer completo foi
fornecido pelo usuário nesta rodada; os itens abaixo são **achados do parecer**,
não correções desta revisão documental:

1. Comparação de receita pode manter os números de receita mas rotulá-los
   “Total gasto”; a etiqueta errada continua em follow-ups.
2. Mudança explícita de origem ou de receita para gasto pode ser ignorada e
   contaminar turnos seguintes.
3. Variantes coloquiais de corrida não paga ainda propõem receita; negativas
   sobre outra renda podem apagar uma corrida recebida.
4. Frase “gastei 50 no mercado e meu saldo é 800” registra só a âncora, perdendo
   a despesa no histórico; a variante com receita antes da âncora também falha.
5. Remover pagamento parcial anterior pode deixar parcelas como quitadas com
   pendência na fatura; o assistente pode responder R$ 0 apesar dessa pendência.
6. Pagamento de fatura vincula IDs de parcelas já quitadas diretamente, o que
   bloqueia indevidamente o desfazer dessas parcelas.
7. Continuação de comparação mensal pode excluir 31/05 de um mês histórico
   completo sem informar o recorte.
8. Eventos de lotes distintos no mesmo milissegundo continuam sem ordem
   confiável; registros antigos só com minuto também não podem ser ordenados
   retroativamente.
9. Histórico legado sem proveniência pode apresentar saldo e total de fatura
   ambíguos. Recusar novo pagamento evita piora, mas `qual meu saldo?` ainda
   pode afirmar um número sem avisar da ambiguidade. É preciso reconciliar com
   o usuário, não escolher uma interpretação por heurística.

O parecer também mostrou dois **falsos verdes** possíveis: trocar “recebido”
por “gasto” no rótulo de uma comparação e acrescentar despesa indevida a uma
corrida não paga mantêm 128/128. Fortalecer os oráculos, além de corrigir o
código, é parte do próximo lote. Não houve nesta revisão alteração de código,
chamada paga, push, merge, deploy ou APK.

**Próximo passo técnico:** REDs independentes para as classes acima, correções
com oráculos de ações/valores/rótulos/continuidade, gates completos e nova
auditoria externa. Persistência real e navegador ainda não foram validados
para este lote. **Não liberar merge/deploy antes disso.**

## 2026-10-25 — resposta local ao último parecer Astra

Partindo de `7d9096b` na branch `feat/assistant-intelligence-v2`, foram
adicionadas 19 reproduções adversariais pelo orquestrador, executor e reducer
reais (128 → 147). Os REDs cobriram rótulo de receita, troca explícita de
origem/tipo e continuidade, mês histórico completo, corrida não paga em cinco
variantes, negativa sobre salário/venda/aluguel, lançamento antes/depois de
âncora, vínculos de fatura, remoção de parcial, saldo legado ambíguo e eventos
de lotes distintos no mesmo milissegundo.

Correções locais:

- Comparações preservam modalidade e rótulo; origem/tipo explícitos substituem
  o foco anterior. “Em geral” remove os recortes de categoria/origem/texto.
- O período anterior a um mês histórico completo inclui seu último dia.
- A segmentação separa movimentação e âncora na mesma frase. Negativas de
  recebimento da corrida cobrem as variantes reproduzidas sem apagar uma
  corrida paga por causa de outra renda negada. “Venda” não vira “vendi” no
  corretor de digitação.
- A quitação da fatura só vincula parcelas ainda devidas; o reducer também
  filtra IDs de parcelas integralmente pagas diretamente. Remover um parcial
  antigo que deixaria parcelas falsamente quitadas é **recusado** até haver
  reconciliação, pois o estado não diz como distribuí-lo entre parcelas.
- Eventos novos de caixa no mesmo milissegundo recebem ordem baseada no estado,
  também entre lotes e lançamentos/pagamentos manuais. Horários legados com
  precisão de minuto continuam ambíguos; não foram reordenados por suposição.
- Consulta de saldo não afirma valor como certo quando um pagamento legado sem
  vínculo com parcelas produz total pago maior que a fatura. Pede conferência
  dos registros, sem decidir se são desembolsos distintos ou duplicados.

Gates após as correções: 660/660 corpus, 99/99 consulta/cenário/continuidade,
50/50 semânticos, **147/147 adversariais**, 4.088 + 3.800 metamórficos,
1.416 fuzz, 151/151 invariantes e 468/468 verificações remotas **offline**.
`typecheck`, `typecheck:api`, `test:money`, build, rubrica e `git diff --check`
passaram. Rubrica: 0 perigosa, 0 ruim, 7 aceitáveis, 83 excelentes. O aviso
de chunk acima de 500 kB permanece.

**Ainda NOT READY:** falta auditoria independente deste novo diff; navegador e
persistência real não foram validados nesta rodada. A recusa de remover parcial
antigo precisa de fluxo de reconciliação/feedback na interface antes de ser
tratada como funcionalidade completa. Nenhuma chamada paga, push, merge, deploy
ou APK nesta rodada. `.claude/launch.json` permaneceu intocado.

## 2026-10-25 — resposta ao parecer independente de `345d55e`

O Astra confirmou o baseline de `345d55e` e declarou **NOT READY**. Oito
defeitos foram reproduzidos com estado sintético, orquestrador, executor e
reducer reais: quatro variantes de corrida recebida/não recebida; perda de
despesa antes de âncora de saldo sem `e`; troca explícita para recebimentos
ignorada no foco; `todas as categorias` apagando origem explícita; média e
categoria omitidas do rótulo; `qual foi pior?` comparando uma consulta antiga
em vez dos dois períodos exibidos; pagamento parcial da fatura omitido da
dívida do cartão; saldo legado ambíguo usado em gasto permitido e cenário.
O mesmo parecer mostrou quatro oráculos falsamente verdes. O texto recebido
está no anexo do chat desta rodada; este registro resume os achados, sem
atribuir ao Astra as correções abaixo.

Foram adicionados REDs de classe no corpus adversarial e os quatro oráculos
foram endurecidos: valores/ações exatos nas corridas; nenhuma ação na
comparação entre imóveis; direção `abaixo` no histórico; nenhum R$ 600 na
resposta ao saldo ambíguo. Depois das correções, **165/165** casos passam.

- A segmentação reconhece `agora meu saldo` e `meu saldo` sem conector depois
  de movimentação. A negação de recebimento distingue passageiro de outra
  renda; valor de corrida não paga é representado como mencionado, sem criar
  receita nem pergunta espúria sobre o valor.
- A continuidade respeita o verbo explícito `recebi`, preserva origem citada
  junto com `todas as categorias`, recompõe o rótulo a partir da métrica e dos
  filtros executados e compara os dois números da última resposta em `qual
  foi pior?`.
- Pagamento parcial de fatura com vínculo explícito vazio e composta somente
  por parcelas reduz a dívida agregada do cartão, o limite usado e o resumo de
  dívida parcelada, sem atribuir artificialmente o pagamento a um plano
  individual. O teste cobre proposta, aplicação, saldo, fatura, dívida,
  pagamento direto posterior e desfazer. Fatura mista com assinatura/saldo
  inicial não recebe essa atribuição automática: faltam dados para dizer a
  qual item o pagamento pertence.
- Uma única verificação de inconsistência de pagamento legado é usada em
  consulta de saldo, limite de gasto, cobertura de contas, resumo com saldo e
  cenários. A resposta pede reconciliação sem afirmar saldo projetado.

Gates após este lote: 660/660 corpus, 99/99 consulta/cenário/continuidade,
50/50 semânticos, **165/165 adversariais**, 4.088 + 3.800 metamórficos,
1.416 fuzz, 151/151 invariantes, 468/468 verificações remotas offline;
`typecheck`, `typecheck:api`, `test:money`, `build`, `rubric` e
`probe:redteam -- imovel` passaram. Rubrica: 0 perigosa, 0 ruim, 7 aceitáveis,
83 excelentes. O build ainda avisa de chunk acima de 500 kB.

**Ainda NOT READY:** o novo diff precisa de auditoria independente. A
reconciliação de pagamento legado ambíguo e a alocação de pagamento parcial em
fatura mista não podem ser inventadas. Persistência e navegador não foram
revalidados neste lote. Sem chamadas remotas pagas, push, merge, deploy ou
APK. `.claude/launch.json` segue como alteração local preexistente, fora das
entregas.

## 2026-10-27 — caixa futuro: reserva até uma data e conta que aperta

O `probe:redteam -- imovel` mostrou duas respostas deslocadas. Um primeiro
ajuste em `ai.ts` (não commitado) trocava o gasto do mês por perguntas fixas,
mas a leitura humana de variantes mostrou que ele ainda errava: ecoava "dia 10"
para "até o dia 5" e "fim do mês", sequestrava "quanto preciso reservar pra
viagem" e, sobretudo, dizia que a conta que apertava era a Luz de R$ 180 com
uma fatura do Inter atrasada e a do Nubank vencendo no dia seguinte. Variantes
naturais caíam em "você já bateu a meta de hoje" (motorista), "total gasto este
mês" ("qual boleto tá me apertando") ou na recusa "não consegui ler: conta ate".

- `src/assistant/cashQuestions.ts` reconhece as duas intenções e a data-limite.
  "Dia N" sem mês é o próximo dia N; dia inexistente é recusado; sem data, o app
  pergunta até quando. Pergunta de meta ("pra viagem", "por mês") não é reserva.
  O planejador da DSL recusa essas frases e o roteador antigo responde.
- `cashObligationsUntil()` em `calc.ts` lista o que está cadastrado para sair até
  a data: contas fixas não resolvidas, pendente de cada fatura (parcela de cartão
  só pela fatura, regra 10) e parcelas fora de cartão, inclusive vencidas.
  Conta fixa vencida **sem confirmação** fica à parte e nunca é somada como
  dívida certa. Fatura cujas parcelas estão marcadas como pagas sem data
  (backup antigo) não vira atraso: o limite é o pendente pelo status de cada item.
- A resposta de "qual conta aperta" põe o vencido primeiro, depois a maior e a
  próxima a vencer (empate é dito), e compara com o saldo; com saldo legado
  ambíguo, a reserva recusa o número e o aperto não afirma cobertura.

14 casos novos em `adversarial-real.ts`, montados em volta do relógio real
porque o roteador antigo lê `todayISO()` (regra 35), e 6 no corpus
`falareal`. Duas mutações da implementação (sem a guarda por status; conta sem
confirmação somada como certa) deixam 8 desses casos vermelhos.

Gates: 666/666 corpus, 99/99, 50/50, **179/179 adversariais**, 4.088 + 3.800
metamórficos, 1.416 fuzz, 151/151 invariantes, 468/468 offline; `typecheck`,
`typecheck:api`, `test:money`, `build`, `git diff --check` passaram. Rubrica:
0 perigosa, 0 ruim, 6 aceitáveis, 84 excelentes.

**Fora deste lote, de propósito:** "o que vence essa semana" e "minhas contas
cobrem até dia 10?" ainda olham só contas fixas (sem faturas) e uma janela fixa
de 15 dias; `balanceOutlook` na Home também. **Ainda NOT READY para
merge/deploy.** Sem chamadas pagas, push, merge, deploy ou APK.

## 2026-10-27 — compra parcelada citada pelo nome

Leitura do `probe:redteam` inteiro: "quanto ainda falta do computador"
respondia **R$ 5.200,00** (Computador + Geladeira) em vez de R$ 3.200,00. O
leitor do nome da compra só aceitava "parcelas/pagar/quitar do X"; com "falta
do", "devo do" e "paguei do" o nome ficava sem leitor e a consulta somava todos
os parcelamentos. A rubrica marcava essa resposta como boa — ela não confere
o número contra a pergunta.

No mesmo caminho: "quantas parcelas faltam da geladeira" contava parcelamentos
(1) em vez de somar parcelas restantes (5); "quantas parcelas da geladeira
faltam" procurava a compra "geladeira faltam"; "quanto já paguei do computador"
virava o gasto do mês.

- `ITEM_PARCELADO` aceita falta/resta/devo/paguei e para o nome antes de
  "ainda", "faltam", "no inter"; "total", "valor" e "resto" não são nome de compra.
- "Devo do X" é dívida de parcelamento; "paguei do X" só vira parcelamento
  quando existe um plano com esse nome — "paguei do aluguel" segue lançamento.
- "Quantas parcelas" soma `remainingCount`, com rótulo "Parcelas restantes".

8 casos adversariais (6 vermelhos no planejador anterior, 2 controles).
Gates: 666/666, 99/99, 50/50, **187/187**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica (0 perigosa, 0 ruim) passaram.

## 2026-10-27 — comparação com período de outro tamanho

"Tô melhor que semana passada?" (motorista) comparava o **gasto do mês** (27
dias) com o gasto da semana passada (7 dias): "+861%". "Quanto fiz na Uber
comparado com semana passada" dava +277% pelo mesmo motivo. "E comparado cm
semana passada" nem comparava ("cm" não era expandido), "uber comparado com
semana passada" procurava gasto na Uber e "gasolina comparado com o mês
passado" perdia o assunto e comparava todos os gastos.

- Sem período principal dito, a comparação com semana/dia/ano usa a janela
  atual do MESMO tamanho (últimos 7 dias, hoje, este ano).
- "Melhor/pior que …", "como foi … comparado" e "comparado com …" sem verbo nem
  assunto comparam o **resultado**, como "qual mês foi o pior" já fazia.
  "Compara julho com junho" mantém o contrato de gasto.
- "Comparado com o passado/anterior" compara com o período imediatamente
  anterior; "cm" vira "com"; "tô pior de gasolina?" é comparação implícita.
- O assunto sem preposição antes de "comparado" vira o alvo da consulta.
- Plataforma (Uber/99/inDrive) sem verbo de gasto é receita, com rótulo
  "Total recebido".

7 casos adversariais com oráculo somado direto do fixture (vermelhos no
planejador anterior). Gates: 666/666, 99/99, 50/50, **194/194**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build e rubrica passaram.
Limite conhecido: "este mês" contra um mês passado inteiro ainda compara 27
dias com 30 quando o mês é dito por extenso.

## 2026-10-27 — mensagens internas e categoria criada pelo usuário

- Recusa de ação mostrava código interno: "Uma parte não pôde ser registrada —
  work (Trabalho)" e "expense (amount)", depois de um "não tenho certeza do que
  registrar" que mentia (a frase foi entendida). Agora o motivo vem em palavras
  do usuário — km é registro do perfil de motorista; número fora do limite pede
  para conferir — e substitui a dúvida genérica quando nada virou proposta.
- A proposta mostrava o id da categoria: "(alimentacao)", "(outros-out)" e,
  para categoria criada na tela, o id aleatório. `describeAction` recebe as
  categorias do usuário e mostra o nome.
- "Feira coloca em Feirinha" (categoria criada pelo usuário) era recusado com
  "nunca trocar valores, datas ou regras financeiras": o id vem de `uid()`,
  sempre com dígitos, e a barreira lexical lia os dígitos como valor. Em
  `category-mapping` o valor é id — a existência e o tipo da categoria já são
  conferidos no uso.

6 casos adversariais (todos vermelhos no código anterior). A rubrica aprendeu a
nova forma de "recusa com motivo". Gates: 666/666, 99/99, 50/50, **199/199**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica
(0 perigosa, 0 ruim, 6 aceitáveis, 84 excelentes).

## 2026-10-27 — sim ou não primeiro, e assunto escrito por radical

- "Meu custo por km piorou?", "tô melhor que semana passada?" e "gastei mais
  que semana passada?" mostravam os números sem dizer sim ou não (regra 57).
  `leadSimNao()` lê a polaridade da pergunta e a direção da medida — gasto que
  sobe piorou; receita ou resultado que cai piorou — e a conversa abre com
  "Sim, piorou." / "Não, melhorou." / "Não, ficou igual.". Pergunta aberta
  ("quanto gastei a mais…?") e frase sem interrogação ficam como estavam.
- "Minha gasolina aumentou?" comparava todos os gastos: o termo de combustível
  é o radical "gasolin" e o leitor de categoria solta só aceitava palavra
  inteira. Radical de 6+ letras no começo de uma palavra conta como a palavra.

6 casos (4 vermelhos no código anterior, 2 controles), com a direção esperada
calculada do fixture. Gates: 666/666, 99/99, 50/50, **205/205**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build e rubrica (0 perigosa,
0 ruim) passaram.

## 2026-10-27 — ranking do que mudou

"Tem alguma coisa que eu tô gastando muito mais que antes?" respondia o maior
gasto do mês e listava embaixo categorias que CAÍRAM; "qual despesa está mais
fora do meu padrão" virava a exclusão `excludeText: "padrao"`; "o que aumentou
mais esse mês" comparava só os dois totais; "gastei fora do normal esse mês?"
caía na ajuda.

- "Mais que antes", "gastando mais" e "fora do/acima do padrão/normal" pedem o
  que mais SUBIU (ordem por diferença); "fora do padrão" é comparação, não
  exclusão. "O que aumentou mais" agrupa por categoria.
- Em ranking por diferença, a lista "Depois" só traz itens no mesmo sentido, e
  a frase diz contra o que comparou ("comparado com setembro").
- "Tem alguma coisa…?" começa com "Sim." ou "Não."; "gastei fora do normal?"
  ganha a resposta de sim ou não sobre o total.

5 casos (vermelhos no código anterior), com diferenças por categoria somadas do
fixture. Gates: 666/666, 99/99, 50/50, **210/210**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — vencimentos coerentes entre as respostas

Depois do lote de caixa futuro, "o que vence essa semana" e "minhas contas
cobrem até dia 10?" ainda olhavam só conta fixa e uma janela fixa de 15 dias:
no fixture rico, R$ 300 de contas contra R$ 1.500 em "qual conta tá me
apertando" — duas respostas do mesmo app se contradizendo, e "até dia 10" e
"essa semana" ignorados.

As duas passam a usar `cashObligationsUntil()` com o prazo da frase
(`prazoDasContas`: essa semana, até dia N, este mês; 15 dias sem prazo dito),
com a conta fixa sem confirmação à parte. "Tem conta vencendo?" abre com sim
ou não. 4 casos, incluindo a coerência dos três totais para o mesmo prazo.
Gates: 666/666, 99/99, 50/50, **214/214**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram.

Fora de propósito: `balanceOutlook` (Home e simulações "e se eu gastar")
continua só com contas fixas; mudar isso altera a tela inicial e merece
decisão de produto.

## 2026-10-27 — continuação de simulação sem repetir a conta

Depois de "e se eu gastar mais 500 em obra", tanto "dá ruim?" quanto "volta"
repetiam a simulação inteira, idêntica; "qual mês fica pior" fazia o mesmo com
a compra parcelada. O código prometia destacar a resposta, mas reprocessava o
mesmo plano e devolvia o mesmo texto. A pergunta "se eu meter um pc de 4k em
10x dá ruim?" também não começava pelo veredito.

- O foco guarda o veredito do motor (`feasible`, `tightest`). "Dá ruim?",
  "vale a pena?", "cabe?" abrem com "Não dá ruim." / "Dá ruim." / "O saldo
  aguenta, mas aperta: o mês fecha no vermelho." (sobra do mês negativa).
- "Qual mês fica pior" sozinho responde o mês mais apertado em uma frase; na
  frase que monta o cenário composto, a resposta completa segue igual.
- "Volta" sem simulação anterior confirma que nada foi registrado; com
  anterior, volta para ela.

5 casos multiturno (4 vermelhos no código anterior; "volta com anterior" já
funcionava). Gates: 666/666, 99/99, 50/50, **219/219**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — simulação de compra: a parcela no mês em que cai

"Se eu comprar um pc de 4000 em 10x" (hoje, 27/10, sem cartão escolhido)
mostrava "out/2026: R$ 13.595,00 (com a parcela de R$ 400,00)". O saldo de
outubro estava certo — a primeira parcela vence em 30 dias, em novembro —, mas
a coluna "acrescentado" era uma função constante e o texto afirmava a parcela
em todos os meses. Agora ela sai do calendário simulado das parcelas. 2 casos:
o mês corrente sem parcela e a propriedade "parcela citada ⇔ saldo do mês mexeu
pela parcela". Gates: 666/666, 99/99, 50/50, **221/221**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — pergunta e intenção não pagam fatura

Varredura nova, fora do corpus: "quanto falta pagar da fatura do inter" virava
**proposta de pagamento** — o infinitivo "pagar" casava e, sem valor na frase,
a guarda de "pergunta com valor" (regra 33a) não via — e a resposta era
calculada sobre o estado projetado, como se o pagamento estivesse feito
("Dívida parcelada restante: R$ 4.800" em vez de 5.200). "Já paguei a fatura
do nubank?" fazia o mesmo. "Vou pagar a fatura do nubank amanhã", "quero pagar
a fatura do inter semana que vem", "vou assinar a netflix de 39,90" e "vou
guardar 200 na meta do notebook" viravam registro de algo que não aconteceu.

- O leitor de pagamento de fatura ignora cláusula que é pergunta.
- A guarda de intenção cobre pagamento de fatura, assinatura e entrada
  financiada, e os verbos assinar/contratar/financiar/transferir/mandar/
  enviar/emprestar/doar/alugar. Depósito em meta EXISTENTE com intenção não é
  registrado; sem meta com esse nome, a pergunta "criar a meta ou reservar?"
  continua (rr-38).

10 casos (6 vermelhos no código anterior, 4 controles de registro legítimo).
Gates: 666/666, 99/99, 50/50, **231/231**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — cada item com o seu dia, e nenhum valor some

- "Gastei 30 de lanche ontem e 20 de padaria anteontem" e "ontem 30 de lanche,
  anteontem 20 de padaria" gravavam os dois **ontem**: a cláusula usava a
  primeira data para todas as ações. "Gastei 30 ontem e 20 hoje" também. O
  segmentador agora corta antes do dia depois de vírgula, e no "e" antes de um
  valor quando cada metade tem o seu dia ("30 de lanche e 20 de padaria ontem"
  continua com um dia só). Um trecho que é só valor herda o verbo da metade
  anterior.
- "Ontem gastei 30 de lanche e anteontem 20 de uber" mostrava só os 30; a parte
  dos 20 sumia sem aviso. Pedaço com valor que nada leu agora aparece na
  proposta: "Não registrei esta parte: “anteontem 20 de uber”. Me diga o que foi".

7 casos (5 vermelhos no código anterior, 2 controles do dia compartilhado).
Gates: 666/666, 99/99, 50/50, **238/238**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — cada meta no seu lugar

"Meta" serve a três coisas: a meta de COMPRA (pelo nome), a meta mensal de
guardar e a meta diária do motorista. A varredura achou as três trocadas:

- "Quanto falta pra minha meta do notebook" respondia a meta MENSAL ("faltam
  R$ 300 para a meta mensal") em vez do Notebook (faltam R$ 2.800): o
  "minha meta" do roteador antigo capturava a frase. Meta citada pelo nome agora
  ganha das outras duas; o planejador consome "meta do <nome>" junto com o
  nome (sobrando, virava resíduo e a pergunta era recusada); "como tá a meta do
  notebook" deixou de cair na ajuda.
- "Consigo bater a meta esse mês?" e "bati a meta do mês?" caíam na ajuda.
  Agora abrem com o veredito ("Ainda não: guardou R$ 500 de R$ 800 (faltam
  R$ 300)", "Dá:", "Do jeito que está, não:", "Sim, já bateu").
- Motorista: "quanto falta pra meta de hoje" dizia que não havia meta de
  compra; "quanto falta pra bater a meta" procurava a compra "bater a"; "bati a
  meta?" mostrava a composição sem dizer se bateu. O progresso do dia vem antes
  da composição, com sim ou não, e "meta de hoje/do mês" e "bater a meta" não
  são consulta de meta de compra.

10 casos (9 vermelhos no código anterior; "qual minha meta" segue com a
composição). Gates: 666/666, 99/99, 50/50, **248/248**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — média por mês é média dos totais mensais

"Quanto eu ganho por mês em média" respondia "Média por lançamento por mês:
R$ 1.396,43" no fixture de quem recebe dois aluguéis (R$ 3.000/mês): a métrica
era média POR LANÇAMENTO, agrupada por mês. Agora `avg` agrupado por mês é a
média dos totais mensais, sobre os meses completos desde o primeiro com dado
(o mês que o período corta no meio fica fora, e os meses antes do primeiro
registro não contam como zero). O rótulo vira "Média por mês" e uma ressalva
diz quais meses entraram. O contrato da DSL não muda (mesmo `metric`/`group`).

2 casos (vermelhos antes): estado exato 1.000/2.000/3.000 + setembro aberto →
R$ 2.000,00; fixture rico com a média somada direto dos lançamentos. Gates:
666/666, 99/99, 50/50, **250/250**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — guardado não é saldo em conta

- "Quanto eu tenho guardado" respondia o SALDO EM CONTA (o "tenho" puxava o
  handler de saldo); "minha reserva tá em quanto" e "quanto tem na reserva"
  procuravam DESPESA na categoria reserva e diziam que não havia lançamento;
  "quanto eu já guardei" respondia só o mês. Agora: reserva = soma das
  transferências `saving` (regra 5), metas = o guardado de cada meta, e o
  saldo em conta aparece como separado. Pergunta pela reserva começa por ela;
  com período ("esse ano") continua na consulta.
- "Tirei 300 da reserva" caía na ajuda genérica. O app não tem lançamento de
  retirada da reserva (o código `insufficient-reserve` existe e nunca é usado);
  a resposta agora diz isso e aponta Movimentações. Criar a retirada é decisão
  de produto, fora deste lote.

5 casos (4 vermelhos no código anterior, 1 controle com período). Gates:
666/666, 99/99, 50/50, **255/255**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram.

## 2026-10-27 — "qual meu saldo" com as mesmas obrigações

A frase de cobertura de "qual meu saldo" ainda usava `balanceOutlook` (só
contas fixas): "cobre as 2 contas dos próximos 7 dias (R$ 300)" com uma fatura
vencendo amanhã e outra atrasada. Agora usa `cashObligationsUntil()` até hoje+7,
como "o que vence" e "qual conta aperta". 1 caso (vermelho antes). Gates:
666/666, 99/99, 50/50, **256/256**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build e rubrica passaram. `balanceOutlook` segue
inalterado na Home e nas simulações — decisão de produto pendente.

## 2026-10-27 — pedido de apagar não cria lançamento

"Exclui a despesa de 120 da luz" virava uma despesa NOVA de R$ 120; "apaga o
gasto do mercado" respondia "não registrei nada", como negação. Pedido de
apagar não cria ação e a resposta diz que apagar é pela tela de Movimentações
(ou "desfaz o último" para o último lote do assistente). Sem caso adversarial
dedicado neste lote — fica para o próximo. Gates: npm test verde (256/256),
typechecks e build.

## 2026-10-27 — situação da fatura de agora

"Quanto falta pagar da fatura do Inter" respondia a dívida parcelada do cartão
(R$ 2.000, "previsão") em vez dos R$ 400 da fatura vencida: a DSL lia "falta
pagar" como parcelamento antes de ver "fatura". "Já paguei a fatura do
Nubank?", "tá atrasada?", "quando vence", "já fechou?" caíam no resumo de todos
os cartões, sem sim/não; "quanto vem a fatura do C6" respondia a do mês do
calendário (já vencida e paga) e chamava fatura fechada de "previsão".

`perguntaDeFatura()` (em `cashQuestions.ts`) reconhece falta/paga/atrasada/
vence/fecha/valor da fatura de agora; a DSL recusa essas frases e o roteador
responde por `respostaDaFatura()`, com o pendente de `cashObligationsUntil()`
(o mesmo do caixa; a obrigação de fatura ganhou `cardId`). Atrasadas de meses
anteriores entram; a próxima fatura ainda aberta aparece à parte ("o valor pode
crescer"). Cartão citado que não existe é dito, sem número. Fatura de mês dito,
"mês que vem", "próximos meses" e "maior fatura" continuam onde estavam;
"paguei a fatura" sem "?" continua registro.

16 casos no grupo S (15 vermelhos antes, 1 controle de registro). Gates:
666/666, 99/99, 50/50, **272/272**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura de
controle e `git diff --check` passaram.

## 2026-10-27 — nome com acento contra pergunta sem acento

O roteador antigo compara a pergunta já sem acento (`normalizeQuestion`) com o
nome cadastrado COM acento. "Quanto gastei de alimentação esse mês" respondia
"R$ 0,00 … dado real" com R$ 463 lançados; "quanto falta pra câmera"
respondia a meta Notebook (a primeira da lista); o orçamento citado pelo nome
nunca era achado. Os três pontos passam o nome pela mesma normalização. No
mesmo leitor: "com O bar" levava o artigo para a busca (R$ 0,00 com R$ 480
no Bar), e palavra que não é categoria nem descrição ("comida") afirmava
R$ 0,00 — agora a pergunta segue para a consulta, que conhece mais nomes e,
sem base, diz que não tem.

6 casos no grupo U (todos vermelhos antes). Gates: 666/666, 99/99, 50/50,
**278/278**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — dinheiro posto na meta pelo nome dela

"Coloquei 300 na viagem" e "botei 200 no notebook", com as metas Viagem e
Notebook ativas, viravam despesa de R$ 300/200 (Outros): o parser não conhece
as metas e só lia depósito com a palavra "meta". "Juntei mais 100 pra viagem"
virava RECEITA de R$ 100 em Corridas para um autônomo (o "mais 100" era lido
como receita e "viagem" como corrida); sem o "mais", nada era registrado.

O orquestrador, que tem o estado, troca a despesa por depósito quando o valor
vai direto para o nome de uma meta ativa ("coloquei 300 na viagem") e a
descrição lida é esse nome. "Gastei 300 na viagem" e "coloquei 50 de gasolina
na moto" (com meta Moto) continuam gasto; sem meta, nada muda. "Juntei" entrou
nos verbos de depósito do parser e na guarda do "mais" de receita.

7 casos no grupo V (4 vermelhos antes, 3 controles). Gates: 666/666, 99/99,
50/50, **285/285**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — tempo depois do valor não é nome de meta

"Guardei 500 essa semana" respondia "não encontrei a meta Essa semana";
"esse mês", "hoje cedo", "de novo" e "de manhã" viravam as metas "Esse mes",
"Cedo", "Novo" e "Manha". O leitor de depósito pega tudo depois do valor como
nome; agora tira antes as expressões de tempo e de repetição, e sem nome o
destino é a reserva. Com meta dita antes ("pra viagem essa semana") nada muda.

6 casos no grupo W (5 vermelhos antes, 1 controle). Gates: 666/666, 99/99,
50/50, **291/291**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — pergunta que repete o verbo do registro fica inteira

"Gastei 50 no mercado, quanto gastei de alimentação esse mês?" era cortada em
"quanto" + "gastei de alimentação esse mês?": o corte de ditado sem pontuação
separa antes de "gastei/recebi/paguei" sempre que já apareceu um número, e
nenhuma das duas metades virava pergunta respondível. O corte agora não
acontece quando o fragmento anterior termina em palavra interrogativa (com até
três palavras depois: "qual conta eu | paguei"). E "e quanto" não deixa mais
um "e" sozinho como cláusula.

3 casos de segmentação no grupo Y (todos vermelhos antes). Gates: 666/666,
99/99, 50/50, **294/294**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — registra e pergunta: as duas metades, com o número marcado

Regra 27, quebrada de três jeitos. (1) Pergunta que o roteador antigo não sabe
("gastei 50 no mercado, quanto sobrou esse mês?") virava só "se você
confirmar, saem R$ 50,00" — a consulta nunca era tentada quando a mensagem
tinha registro. (2) "Quanto falta?" depois de "guardei 200 na meta notebook"
ou de "paguei 200 da fatura do inter" sumia: a cláusula não diz de quê.
(3) "Qual meu saldo" ao lado de um gasto mostrava o saldo JÁ descontado como
"Seu saldo em conta é…", e respostas assim saíam com "(dado real)".

`answerQuestions` agora responde cada pergunta como o turno normal (consulta à
frente só no que o roteador não expressa, e quando ele não sabe), mas só ao
lado de um registro e com pergunta de 3+ palavras — um fragmento como
"quanto" virava "Total gasto este mês". "Quanto falta?" ganha o assunto do
depósito ou do pagamento ao lado. Quando a resposta muda com o registro, ela
vem sob "Se você confirmar o registro acima:" e sem o selo de dado real; o
foco guardado é o do estado real.

6 casos no grupo X (5 vermelhos antes, 1 controle sem marca). Gates: 666/666,
99/99, 50/50, **300/300**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — o nome da categoria escolhe a categoria

"Gastei 50 de lazer", "de alimentação", "de compras" e "de casa" iam para
Outros com essas categorias cadastradas: o nome da própria categoria não está
nas palavras-chave delas. Categoria criada pelo usuário ("Pet", "Saúde") nunca
era achada pelo nome. `withLearnedCategory` agora usa a categoria usável do
mesmo tipo cujo nome é a descrição (com ou sem "s"), quando o palpite está
vazio ou é Outros — depois da preferência ensinada e antes do histórico, que
pode ter aprendido o próprio erro.

8 casos no grupo Z (6 vermelhos antes, 2 controles por palavra-chave).
Gates: 666/666, 99/99, 50/50, **308/308**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — "quanto falta pagar esse mês" é o que ainda vence

"Quanto falta pagar esse mês" respondia a dívida parcelada INTEIRA (R$ 1.500,
com parcelas de daqui a 40 dias); "quanto falta de conta esse mês" procurava
um parcelamento chamado "conta esse"; "quanto ainda tenho de conta pra pagar"
era recusado. O roteador antigo já respondia certo pelas mesmas obrigações do
caixa, mas a consulta se declarava `beyondLegacy` e tomava a frente.
`pedeContasAPagar()` faz a DSL recusar essas frases e leva o roteador à lista
de contas, que agora abre com "Até 31/10 falta pagar R$ X". Compra citada
("do computador") e "quanto falta pagar" sem prazo continuam na consulta.

3 casos no grupo CT (todos vermelhos antes; oráculo literal sobre estado com
fatura vencida, contas a vencer, conta sem confirmação e parcelas futuras).
Gates: 666/666, 99/99, 50/50, **311/311**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

Observação de fixture: `autonomoRico` cria Luz e Internet com `startDate` no
dia 1º e `dueDay` 10/15. A âncora é o `startDate` (o formulário sempre grava
os dois coerentes), então nesse fixture elas vencem no dia 1º — não é defeito
do produto, mas engana quem lê as respostas dele.

## 2026-10-27 — situação de uma conta fixa pelo nome

"Já paguei a luz?" e "a água tá paga?" caíam na ajuda genérica; "quanto é a
internet" dizia que não havia lançamento; "quando vence a água" devolvia a
lista de tudo que vence. `perguntaDeConta()` reconhece paga/vence/valor e o
roteador responde pelas ocorrências da conta citada: confirmada ("Sim. A conta
Luz de 07/10/2026 está paga"), pulada, ou vencida sem confirmação ("Não está
marcada como paga… Se já pagou, confirme na tela inicial"), com a próxima data
e o valor. Sem artigo antes do nome (regra 45). "Paguei a luz" sem "?"
continua registro.

4 casos no grupo CF (todos vermelhos antes). Gates: 666/666, 99/99, 50/50,
**315/315**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

Achado sem correção (decisão de produto): "paguei a luz de 180" cria despesa
avulsa; a ocorrência da conta fixa Luz continua pendente na tela inicial, e
confirmá-la lá depois duplica o gasto. Não existe ação de catálogo para
confirmar ocorrência pelo chat.

## 2026-10-27 — aviso de conta fixa em aberto na proposta de gasto

Mitigação do achado anterior, sem mudar valor nenhum: quando a despesa
proposta tem o nome de uma conta fixa ativa com vencimento sem confirmação
("paguei a água de 50", Água vencida em 12/10 sem confirmar), a proposta diz
que é conta fixa, a data em aberto, e que confirmar aqui e na tela inicial
conta duas vezes. Conta já confirmada e gasto sem conta fixa não avisam. A
ação de confirmar ocorrência pelo chat continua decisão de produto.

3 casos (1 vermelho antes, 2 controles). Gates: 666/666, 99/99, 50/50,
**318/318**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — caso adversarial do pedido de apagar

Cobertura que faltava para `c824fe0`: 4 frases de apagar (despesa com valor,
gasto pelo nome, lançamento de ontem, receita com origem) não criam ação e
apontam Movimentações. Vermelhas no código anterior a `c824fe0` (rodado numa
worktree temporária), verdes agora. **322/322**; demais gates verdes.

## 2026-10-27 — quanto guardar por mês, com prazo e meses contados

"Quanto preciso guardar por mês pro notebook" respondia "O menor foi jul/2026,
com R$ 2.800,00"; "pra completar a viagem até dezembro" e "pra ter 10 mil até
dezembro" eram recusados por resíduo; "consigo completar a viagem até
dezembro?" caía na ajuda; "quanto preciso guardar por mês" devolvia o que já
foi guardado. `planoDeGuardar()` faz a DSL recusar essas frases e o roteador
responde por `respostaDePlano()`:
- meta citada: o que falta dividido pelos meses de depósito até o prazo dito
  ("até dezembro", "em 6 meses", "até o fim do ano") ou o prazo cadastrado,
  com os meses NOMEADOS ("São 2 depósitos até dezembro (novembro e
  dezembro): R$ 600,00 por mês"). O mês corrente conta se ainda tem 7 dias.
  Arredonda para cima no centavo;
- sem prazo: dois exemplos (6 e 12 meses) e a pergunta "até quando?";
- "consigo…?": Sim/Não comparando com a sobra média dos últimos meses
  completos, marcado como estimativa;
- valor ("pra ter 10 mil"): o mesmo cálculo, contando de agora;
- sem destino: a meta mensal de Configurações e quanto falta dela.
"Quando consigo comprar" (data) e "consigo bater a meta esse mês" seguem onde
estavam.

5 casos no grupo MP (todos vermelhos antes; meses e sobra média calculados à
mão no oráculo). Gates: 666/666, 99/99, 50/50, **327/327**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica (0 perigosa,
0 ruim), varredura e `git diff --check` passaram.

Achados sem correção neste lote: "quando consigo comprar o notebook" é
recusado como hipótese (já era antes; "quando VOU conseguir" responde);
"quanto eu guardei por mês" titulava a soma de 3 meses como "Total guardado por
mês: R$ 1.200,00".

## 2026-10-27 — soma agrupada por tempo não se lê como "por mês"

"Quanto recebi por mês de aluguel" abria com "Total recebido - Aluguéis por
mês: R$ 18.000,00" — lido como 18 mil POR MÊS (são 3 mil, em 6 meses) — e
"E mais 1 item" cortava justamente o mês atual. Agrupamentos por mês, semana
ou dia (soma ou resultado) agora listam primeiro, com o corte deixando de fora
os mais ANTIGOS ("E mais N meses antes"), e fecham com "Soma dos 6 meses:
R$ 18.000,00 · média de R$ 3.000,00 por mês (sem o mês incompleto)". Período
cortado pelo recorte é dito na linha ("out/2026 (até 27/10)", "semana de
27/09 (desde 01/10)") e fica fora da média.

2 casos no grupo GT (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**329/329**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — "em cada mês" pede a lista por mês

"Quanto gastei em cada mês" e "em cada semana" respondiam só o total deste
mês: o leitor de agrupamento conhecia "por mês" e "mês a mês", não "cada
mês". As duas formas (e "semana a semana") entraram. 3 casos (2 vermelhos
antes; "mês por mês" já funcionava). Gates: 666/666, 99/99, 50/50,
**332/332**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — "desse mês", "deste ano", "dessa semana" são período

"Quanto gastei de obra desse mês" respondia "nenhum lançamento com 'obra
desse'" com R$ 1.430 lançados; "de mercado deste ano" virava "este mês" e
procurava "mercado deste"; "em cada semana desse mês" listava 12 semanas. O
leitor de período conhecia "esse/este/nesse/neste", não a contração com "de".
3 casos no grupo DP (os 3 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**335/335**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

Achado sem correção: pergunta nominal sem "quanto" ("gastos dessa semana")
cai na ajuda genérica.

## 2026-10-27 — próxima troca de óleo

"Quanto falta pra trocar o óleo" respondia parcelamentos ("trocar o oleo"),
"quantos km faltam pra trocar o óleo" procurava dias de trabalho, e "falta
muito pra troca de óleo?" caía na ajuda. `perguntaDeManutencao()` faz a DSL
recusar essas frases (gasto com a troca continua consulta), o roteador aceita
o substantivo "troca", e o "quanto falta" da meta do dia do motorista não as
toma mais. 4 casos no grupo MN (3 vermelhos antes, 1 controle de gasto;
literal: troca aos 210.000 km, hodômetro 206.400). Gates: 666/666, 99/99,
50/50, **339/339**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

Decisão de produto registrada (sem mudança): viagem inferida em total do dia.
"Fiz 320 hoje rodei 180km em 9 horas" ganha "1 viagem"; o `rr-01` diz que
inventar viagem num dia inteiro estraga o ganho por viagem, mas o `sem-04`
espera 2 viagens para "430 na uber 399 na 99 … trabalhei 8 horas" e o
`mul-07` 1 viagem com 120 km. O corpus se contradiz; mudar é escolha de
produto.

## 2026-10-27 — gasto fixo é o que se repete

"Qual meu gasto fixo por mês" listava TODOS os gastos mês a mês; "quais
minhas contas fixas" e "quanto pago de contas fixas" devolviam a lista do que
vence, com faturas; o motorista que pergunta "qual meu custo fixo" recebia o
gasto do mês, e os R$ 900 de custos fixos que ele cadastrou em Configurações
nunca apareciam. `pedeContasFixas()` faz a DSL recusar essas frases e o
roteador lista as contas fixas ativas com a regra e o peso mensal de cada uma
(repetição semanal ou anual vira equivalente por mês), somando o custo fixo do
carro para o motorista. Vencimento, prazo e cobertura pelo saldo continuam com
a lista de contas.

4 casos no grupo FX (todos vermelhos antes; literal: Luz 180 + Internet 120,
custo do carro 900). Gates: 666/666, 99/99, 50/50, **343/343**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica
(0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — sobra tirando o combustível

"Quanto fico por dia tirando a gasolina" respondia R$ 10,37: a consulta lia
"tirando" como exclusão e devolvia as OUTRAS despesas por dia (a troca de
óleo). Com verbo de sobra, "tirando/descontando/depois da gasolina" é
descontar: `pedeSobraSemCombustivel()` faz a DSL recusar e o roteador
responde entradas menos combustível no período (este mês, se nada for dito),
por dia corrido quando pedido, e diz à parte quanto sobra com as outras
despesas. O "por dia" da consulta agora se rotula "Líquido por dia" quando é
entrada menos saída e diz que divide pelos dias corridos.

3 casos no grupo SC (todos vermelhos antes; oráculo somando o fixture).
Gates: 666/666, 99/99, 50/50, **346/346**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — "tirando cimento" tira o cimento, e o rótulo diz

"Quanto gastei esse mês tirando cimento" excluía a categoria Obra INTEIRA
(cimento, areia e tijolo): R$ 943 em vez de R$ 1.853, com o rótulo "Total
gasto este mês", lido como o gasto do mês todo. A palavra da lista genérica
(cimento → Obra) serve para classificar um lançamento novo; numa exclusão,
`categoriaDaExclusao()` só tira a categoria quando a palavra é o nome dela
("tirando obra") ou quando nenhum lançamento tem esse nome ("tirando
comida"); senão, tira pelo texto. O rótulo diz o que ficou de fora ("Total
gasto sem cimento este mês"; cartão com o nome cadastrado, "sem Nubank").

3 casos no grupo EX (os 3 vermelhos antes; oráculo somando o fixture).
Gates: 666/666, 99/99, 50/50, **349/349**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — "por dia" é por dia

"Quanto gastei por dia" e "por dia na semana passada" devolviam o TOTAL do
período (o roteador antigo pegava "quanto gastei" e ignorava o "por dia");
"quanto gastei em média por dia esse mês" virava "Média por lançamento"
(R$ 215,73 em vez de R$ 87,89 por dia), porque a média vinha antes da unidade
— o contrário do que o comentário da tabela pede. O roteador deixa "por
dia/semana/mês" e "média" para a consulta, e na tabela o dia vem antes de "em
média". As palavras de hábito ("costumo", "normalmente") continuam antes: são
a pergunta que o vocabulário aprendido responde (`ad-41`, "quanto costumo
gastar de suco por dia", quebrou na primeira tentativa e voltou).

3 casos no grupo PD (os 3 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**352/352**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — a proposta de receita diz de onde veio

"Recebi 1200 da casa 2" propunha "Receita de R$ 1.200,00 (Aluguéis)" e
"ganhei 430 na uber" "Receita de R$ 430,00 (Corridas)": a linha da receita não
mostrava nem a origem nem a descrição, e é ela que o usuário confere antes de
confirmar. Agora: "(Aluguéis) — Casa 2", "(Corridas) — Uber"; a descrição só
entra quando diz algo que a categoria não diz ("de aluguel" não repete
"Aluguel"). 2 casos (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**354/354**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — meta citada não é hipótese

"Quando consigo comprar o notebook" e "consigo comprar o notebook até março?"
eram recusadas com "isso é uma hipótese, e esse tipo de cenário eu ainda não
sei simular": "consigo comprar" é marcador de hipótese de compra, mas ali a
META existe e tem resposta. Quando o turno é hipótese sem plano, sem registro,
e a frase cita uma meta ativa pelo nome com pedido de plano ou "quando",
`respostaDeMetaCitada()` responde pelo roteador (plano com prazo ou projeção).
A resposta de viabilidade agora diz a meta e quanto falta. Compra sem meta
("um celular de 3000 em 10x") continua simulação.

3 casos no grupo MC (2 vermelhos antes, 1 controle). Gates: 666/666, 99/99,
50/50, **357/357**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — simulação sim/não responde na palavra da pergunta

"Consigo comprar um celular de 3000 em 10x?" e "dá pra comprar uma geladeira
de 4000 em 12x?" simulavam sem abrir com resposta, e "…cabe?" recebia "Não dá
ruim." `releCenario` agora escolhe o veredito pela pergunta: "Sim./Não./Dá,
mas aperta" para consigo/dá pra/posso, "Cabe./Não cabe./Cabe no saldo, mas
aperta" para cabe, e o "dá ruim" de antes para dá ruim/vale a pena/compensa. O
"dá ruim?" do primeiro turno, listado como pendente, já abria com veredito.

4 casos no grupo VD (os 4 vermelhos antes, incluindo um que não cabe).
Gates: 666/666, 99/99, 50/50, **361/361**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

## 2026-10-27 — o mês pedido dentro da simulação

Depois de "se eu comprar um pc de 4000 em 10x", "e quanto fica nesse mês?" e
"e no mês que vem?" recebiam "Você quer mudar a simulação atual? Diga qual
gasto futuro cadastrado devo tirar ou reduzir." A continuação agora lê o mês
pedido ("nesse mês", "mês que vem", "em dezembro") e responde a linha dele na
simulação ativa: "Nov/2026: saldo estimado de R$ 12.095,00, com a parcela de
R$ 400,00 (seriam R$ 12.495,00 sem a hipótese)", ou que a primeira parcela só
cai depois. 2 casos no grupo SM (os 2 vermelhos antes). Gates: 666/666,
99/99, 50/50, **363/363**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — "pq?" depois do pior mês diz o que pesou

"Qual foi meu pior mês" → "pq?" respondia a metodologia ("Subtraí as saídas
das entradas de 46 registros…"); quem pergunta quer saber o que pesou NAQUELE
mês. Para ranking de lançamentos por mês, a explicação agora traz entradas e
saídas do mês do topo, as três categorias de saída maiores com o lançamento
que domina cada uma ("Casa: R$ 2.400,00 (Reforma do telhado)") e a média de
saídas dos outros meses inteiros (o mês corrente, incompleto, fica fora). O
resto continua com a metodologia. 2 casos no grupo PQ (os 2 vermelhos antes).
Gates: 666/666, 99/99, 50/50, **365/365**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — "e o Inter?" depois de uma pergunta de fatura (regressão de `748a3cc`)

Com a fatura respondida pelo roteador (`748a3cc`), a pergunta deixou de pôr
um plano de consulta no foco, e "quanto falta pagar da fatura do nubank" →
"e o inter?" caía na elipse de compra: "O inter de quanto? Me diga o valor e
em quantas vezes…". O foco agora guarda a última pergunta de fatura de um
cartão (`lastInvoiceQuestion`), e "e o <cartão>?" — exatamente um cartão
ativo — repete a pergunta com o cartão trocado, em sequência ("e o c6"
depois). 2 casos no grupo FC (os 2 vermelhos antes). Gates: 666/666, 99/99,
50/50, **367/367**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — fatura na consulta diz a situação

Na consulta, fatura atrasada sem pagamento saía "(dado real)" — lido como
paga — e fatura fechada "(previsão)", com o valor já fechado. Agora só a
fatura ABERTA é previsão, e cada fatura ganha uma linha com a situação e o
vencimento: "Inter (vencimento 15/10/2026): atrasada, falta R$ 400,00",
"fechada, a pagar", "paga em parte", "paga", "ainda aberta". O pendente é o
mesmo do caixa: o desconto pelo status de cada item (parcela marcada como paga
sem data, de backup antigo) saiu de `cashObligationsUntil` para
`invoiceOpenAmount()` em `cards.ts`, e a consulta usa a mesma função — antes
ela chamava de "atrasada, falta R$ 400" a fatura de setembro que a resposta de
fatura e o caixa davam como quitada.

3 casos no grupo FS (os 3 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**370/370**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — horas a mais hoje: quanto rendem e a meta do dia

"Se eu ficar mais 3h na rua hoje, vale?" respondia "Estimativa para um dia:
R$ 121,19" — eram 3 horas, não um dia — sem nada que ajudasse a decidir; "vale
a pena ficar mais 3 horas?" (sem "se") caía em "não tenho certeza do que
registrar". A hipótese agora reconhece "vale a pena/compensa ficar/rodar
mais", o rótulo diz as horas, e para hoje a resposta traz a meta do dia: "No
seu ritmo real (R$ 40,40/hora), 3h a mais hoje rendem uns R$ 121,19. A meta
de hoje (R$ 127,02) já foi batida…", ou quanto falta e se as horas bastam. Não
há Sim/Não inventado: o app não sabe o cansaço de ninguém.

2 casos no grupo HX (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**372/372**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica (0 perigosa, 0 ruim), varredura e `git diff --check` passaram.

## 2026-10-27 — "essa semana" na simulação de horas são 7 dias

"E se eu rodar mais 2h por dia essa semana" estimava 30 dias (R$ 2.423,75): o
leitor de duração conhecia "semana toda" e "toda a semana", não "essa semana".
Agora são 7 dias (R$ 565,54). 1 caso (vermelho antes). Gates: 666/666,
**373/373**, 151/151 e os demais verdes.

## 2026-10-27 — "como foi hoje?" e "foi bom?"

"Como foi hoje", "como foi meu dia" e "foi bom?" caíam na ajuda genérica.
`pedeResumoDoDia()` e `respostaDoDia()`: entradas, saídas e lucro de hoje
contra o lucro médio dos dias com registro nos 30 anteriores, a meta do dia
para o motorista, e sim/não na direção da palavra usada ("foi bom?" → "Não,
ficou abaixo da sua média"; "foi fraco?" inverte). Abaixo da média, a
resposta lembra que o dia pode não ter acabado. Sem nada registrado hoje, diz
isso. 2 casos no grupo DD (os 2 vermelhos antes; oráculo somando o fixture).
Gates: 666/666, 99/99, 50/50, **375/375**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — registro e "como foi?" na mesma mensagem

"Hj deu 300 uber como foi" virava "não tenho certeza do que registrar": o
segmentador não cortava antes de "como foi", a frase inteira ficava pergunta
e a receita sumia. "Fiz 280 hoje, foi bom?" chega como uma cláusula só, com
registro e pergunta; perguntada inteira ao roteador, virava proposta e a
pergunta ficava sem resposta. O corte interrogativo agora inclui "como
foi/tá/está/ficou", e ao lado de um registro a pergunta é o último pedaço
curto depois da vírgula. As duas respondem o dia marcado como hipotético ("Se
você confirmar o registro acima: Hoje: R$ 671,00 de entradas…").

2 casos (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50, **377/377**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

## 2026-10-27 — resultado do dia guarda a plataforma

"Hj deu 300 uber" e "hoje foi 300 uber" (resultado do dia, sem verbo de
ganho) registravam a receita sem descrição, e o dia não contava para a Uber em
"qual plataforma paga melhor". O leitor do resultado do dia agora guarda Uber,
inDrive ou 99 (o "99" só com preposição, porque sem ela pode ser o valor).
2 casos no grupo PL (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**379/379**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — "vale a pena rodar domingo?"

Caía na ajuda genérica. `diaDaSemanaPedido()` lê "vale a pena/compensa
rodar/trabalhar <dia>", e o roteador compara o lucro médio daquele dia da
semana com o dos outros dias, nos dias com lançamento dos últimos 90 (hoje
fora). Sem nenhum registro daquele dia, diz que não tem base e mostra a média
dos dias trabalhados e o melhor dia — com empate dito quando os dois melhores
ficam a menos de 2% (regra 56, mesma margem da consulta, agora exportada). Com
poucos registros, avisa que a base é pequena. Sem Sim/Não inventado.

2 casos no grupo WD (os 2 vermelhos antes; médias calculadas no oráculo).
Gates: 666/666, 99/99, 50/50, **381/381**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — pergunta telegráfica sem verbo

"Gastos dessa semana", "entradas do mês", "gastos com obra esse mês" e até
"saldo?" caíam na ajuda genérica. Sem verbo e sem número, a entrada do
orquestrador reescreve a pergunta com o verbo que o app já responde
(`perguntaNominal()`: "gastos <resto>" → "quanto gastei <resto>?", "entradas"
→ "quanto recebi", "saldo?" → "qual meu saldo?", com "do mês/da semana/de
hoje" ajustados). Com dígito é registro e fica como está ("gasto 50 de luz").
A reescrita mantém os acentos do resto da frase.

Dois rótulos do corpus remoto envelheceram com isso e foram atualizados com
nota datada: p-15 e c-55 ("gastos no zé da esquina desde julho") agora são
respondidos no aparelho (R$ 135,00, conferido) — 67 frases chegam hoje ao
modelo remoto (eram 69).

5 casos no grupo NM (4 vermelhos antes, 1 controle de registro). Gates:
666/666, 99/99, 50/50, **386/386**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica (0 perigosa, 0 ruim), varredura e
`git diff --check` passaram.

Achados sem correção: "resumo da semana" responde o mês; "contas do mês" olha
15 dias em vez de até o fim do mês.

## 2026-10-27 — "contas do mês" vai até o fim do mês

"Contas do mês" listava o que vence em 15 dias (até 11/11): o prazo das
contas conhecia "esse/este/nesse/neste mês", não "do mês" nem "deste/desse".
Agora as formas com "do/deste/desse" vão até o último dia do mês, e "da/dessa
semana" até 7 dias. 1 caso (vermelho antes). Gates: 666/666, **387/387**,
151/151, 468 e os demais verdes.

## 2026-10-27 — "resumo da semana" é a semana

"Resumo da semana" respondia "Sua situação neste mês". O resumo do autônomo
agora, com "semana" na frase, dá os últimos 7 dias: entradas, despesas, sobra
ou déficit e o guardado. (O resumo do motorista já trazia os 7 dias.) 1 caso
(vermelho antes). Gates: 666/666, **388/388**, 151/151, 468 e os demais
verdes.

## 2026-10-27 — simulação sem base não dá veredito

Usuário novo, que nunca informou saldo e não lançou nada: "consigo comprar um
celular de 2000 em 10x?" respondia "Não." e "e se eu gastar 500 hoje, dá
ruim?" "Dá ruim." — vereditos sobre um zero que ninguém disse. `runScenario`
agora envolve a simulação: sem saldo, sem lançamento e sem entrada fixa, a
conta continua, o veredito some e a resposta pede o saldo ("me diga 'meu
saldo é 1500'"). Com saldo informado (mesmo baixo) nada muda. 2 casos no
grupo SB (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50, **390/390**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: "meu salário é 3000 e cai dia 5" cai na ajuda genérica
("ganho 3500 por mês" recebe a orientação de cadastrar a recorrência).

## 2026-10-27 — "cai dia 5" é recorrência

"Meu salário é 3000 e cai dia 5" caía na ajuda genérica, enquanto "ganho 3500
por mês" recebia a orientação de cadastrar a recorrência (regra 18). O
reconhecimento de recorrência agora inclui "cai/caem/entra/entram (todo) dia
N", no presente; "caiu hoje" continua registro e "vence dia N" ficou de fora
(colide com pergunta de fatura). 2 casos (1 vermelho antes, 1 controle).
Gates: 666/666, 99/99, 50/50, **392/392**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — "e alimentação?" na continuação

Depois de "quanto gastei com obra esse mês", "e alimentação?", "e com lazer?"
e "e de alimentação?" caíam na ajuda genérica: a restrição da continuação só
aceitava "e no/na/do/da X". Agora "e X", "e com X", "e de X" e "e em X"
trocam o recorte — mas só quando X é o nome de uma categoria ou de um cartão
(sem isso a elipse pode ser outra coisa e segue para os outros leitores).
3 casos no grupo EL (os 3 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**395/395**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

Achados da mesma conversa, sem correção ainda: "qual foi o maior gasto
disso?" ignora o "disso" (respondeu os últimos 7 dias em Lazer); "somando as
duas?" (Casa 1 e Casa 2) cai na ajuda; "e no ano?" herda a comparação e
compara com 2025 (R$ 0); "qual a diferença?" diz "o período principal ficou
R$ 420 abaixo" em vez de "este mês ficou R$ 420 acima do mês passado".

## 2026-10-27 — continuação que fala do que acabou de ser mostrado

"Qual foi o maior gasto disso?" depois de "quanto gastei com obra esse mês"
respondia o maior gasto dos últimos 7 dias, em Lazer; "somando as duas?"
depois de Casa 1 e Casa 2 caía na ajuda. A continuação agora lê a anáfora
("disso/desse/deles") com maior/menor como o extremo do recorte em foco
("Maior valor - Obra e construção este mês: R$ 520,00"), e "somando as
duas/os dois juntos" soma a origem anterior com a atual — o foco passou a
guardar `previousOrigin` quando a conversa troca de origem. 2 casos no grupo
AN (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50, **397/397**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

## 2026-10-27 — comparação legível e sem base vazia

"Qual a diferença?" respondia "O período principal ficou R$ 420,00 abaixo" —
jargão — e "e no ano?" herdava a comparação e dizia "Em 2025: R$ 0,00. O
período principal ficou R$ 3.630,00 acima", comparando com um ano sem
lançamento. A linha de comparação agora nomeia o período ("No mês passado
ficou R$ 420,00 abaixo (-29%)"), e o resultado da consulta carrega quantos
lançamentos o período comparado tem (`compareCount`): sem nenhum, diz "Em
2025 não há lançamentos para comparar." 2 casos no grupo CP (os 2 vermelhos
antes). Gates: 666/666, 99/99, 50/50, **399/399**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

## 2026-10-27 — "e a viagem?" troca a meta

"Quanto falta pro notebook" → "e a viagem?" respondia "Você ainda não tem
metas de compra cadastradas com 'viagem'" — com a meta Viagem cadastrada. A
continuação somava o texto "viagem" por cima do filtro da meta Notebook e não
achava nada. Em consulta de metas, o nome de uma meta ativa agora TROCA a
meta do filtro ("Falta para a meta Viagem: R$ 1.200,00"). 1 caso (vermelho
antes). Gates: 666/666, **400/400**, 151/151, 468 e os demais verdes.

## 2026-10-27 — "e a internet?" é a conta cadastrada

"E a internet?" (depois de uma pergunta de fatura) caía na elipse de compra:
"A internet de quanto? Me diga o valor e em quantas vezes…". Antes dela, o
orquestrador agora verifica se o nome é de uma conta fixa ou de uma meta
ativa e responde sobre ela ("A conta Internet é de R$ 100,00, todo dia 28. A
próxima vence em 28/10/2026 (amanhã)."). Nome que não é de nada cadastrado
segue para a elipse de compra. 1 caso (vermelho antes). Gates: 666/666,
**401/401**, 151/151, 468 e os demais verdes.

## 2026-10-27 — ranking por mês sem o mês incompleto

"Qual foi meu pior mês" e "qual mês eu gastei mais" punham o mês corrente,
ainda pela metade, no ranking — ele perde (ou ganha) por estar incompleto. O
mês que o período corta no meio agora fica fora de rankings por valor, e a
resposta diz: "Out/2026, ainda incompleto, ficou fora da comparação." 2
casos no grupo PM (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**403/403**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — verbo no presente fora da descrição

"Gasto 50 de luz" gravava a descrição "Gasto de luz"; "pago 80 de internet
hoje", "Pago de internet"; "gasto de 50 no mercado", "Gasto de no mercado".
A limpeza da descrição tira "gasto/gastos/pago/compro" só do INÍCIO — no fim,
"pago" é nome ("Mercado Pago" continua inteiro). 4 casos no grupo DS (3
vermelhos antes, 1 controle). Gates: 666/666, 99/99, 50/50, **407/407**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

## 2026-10-27 — gasto simulado "esse mês" não é "hoje"

"E se eu gastar 500 esse mês?" simulava "Se você gastar R$ 500,00 hoje". O
plano de gasto ganhou `when` ("este mês" quando a frase diz esse/este/no mês;
ausente = hoje) e o texto da simulação usa o que foi dito. Os números não
mudam (saldo e sobra no fim do mês são os mesmos). 2 casos (1 vermelho antes,
1 controle). Gates: 666/666, 99/99, 50/50, **409/409**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

## 2026-10-27 — rótulo com a grafia do usuário

"Quanto gastei no zé da esquina desde julho" respondia "Total gasto - Ze da
esquina": o texto buscado sai da pergunta normalizada, sem acento. O rótulo
agora usa a grafia do próprio lançamento cuja descrição (ou origem) é aquele
texto — "Zé da esquina". 1 caso (vermelho antes). Gates: 666/666, 99/99,
50/50, **410/410**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-27 — cada item com o seu "dia N"

"Gastei 50 dia 3 e 80 dia 10" gravava as duas despesas no dia 3; "gastei 30
no mercado dia 3 e 50 na farmácia dia 4" também; e "recebi 1800 dia 5 e 1200
dia 7" PERDIA os R$ 1.200 em silêncio. O corte "cada metade com o seu dia"
conhecia hoje/ontem/anteontem, não "dia N"; agora conhece. Cortada, a segunda
metade de uma receita com origem ("1200 da casa 2") não tinha verbo e sumia: a
herança de tipo do parser passou a aceitar valor + "da/do/de <origem>" para
receita, como o leitor de receitas enumeradas. 4 casos no grupo DT (os 4
vermelhos antes; datas calculadas no oráculo). Gates: 666/666, 99/99, 50/50,
**414/414**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção: "transferi 500 pra minha mãe" e "vendi a bike por 800"
caem na ajuda genérica, sem dizer o que fazer.

## 2026-10-27 — transferência para alguém, venda e reserva com "minha"

"Transferi 500 pra minha mãe", "mandei 300 pro meu irmão" e "vendi a bike por
800" caíam na ajuda genérica; "mandei 200 pra poupança" não registrava nada.
Agora: transferência afirmada para alguém é despesa ("Transferência para
minha mae"), "vendi X por N" é receita em Vendas, e "mandei/transferi/enviei"
entraram nos verbos de reserva. No meio do caminho apareceu o pior caso:
"transferi 300 pra MINHA poupança" viraria despesa (regra 5) — o destino de
reserva não aceitava "minha/meu". Aceita agora, e a transferência a alguém
ignora o possessivo ao checar reserva/poupança/meta.

Dois rótulos do corpus remoto envelheceram e foram atualizados com nota:
c-06 (reserva) e c-07 (venda) agora são resolvidos no aparelho — 65 frases
chegam hoje ao modelo remoto (eram 67).

7 casos no grupo TV (os 7 vermelhos antes, incluindo os 2 de reserva com
"minha"). Gates: 666/666, 99/99, 50/50, **421/421**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

## 2026-10-27 — trocar a categoria da proposta na tela

Com "gastei 50 no mercado" na tela, "muda pra lazer" e "troca a categoria pra
lazer" respondiam "Entendi que isso não aconteceu — não registrei nada" e
DESCARTAVAM a proposta; "coloca em lazer", "a categoria é lazer" e "era
lazer" caíam na ajuda. A correção da proposta ganhou a categoria: muda/troca/
coloca/passa/joga… pra/em <categoria>, "a categoria é <x>", "era <x>" — só
quando o nome é de uma categoria do tipo do lançamento. Pedida a que já está,
a resposta diz "Já está na categoria Alimentação" e a proposta fica. Valor e
data continuam como antes. 5 casos no grupo CC (os 5 vermelhos antes).
Gates: 666/666, 99/99, 50/50, **426/426**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — item da proposta pelo nome

Com "almoço 30" e "café 15" na tela, "tira o café" não achava alvo, caía na
negação ("não registrei nada") e a proposta INTEIRA sumia — o almoço junto;
"na verdade o almoço foi 35" também não achava o almoço. O alvo de uma
correção agora também é achado pelo nome do lançamento (descrição ou
origem), antes do tipo ("a despesa"). 2 casos no grupo PN (os 2 vermelhos
antes). Gates: 666/666, 99/99, 50/50, **428/428**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achados sem correção ainda, na mesma conversa: "e mais 20 de pão" com
despesas na tela vira RECEITA de R$ 20 e substitui a proposta (o almoço
some); "foi na padaria" (trocar descrição) cai na ajuda.

## 2026-10-27 — "e mais 20 de pão" acrescenta à proposta

Com almoço e café na tela, "e mais 20 de pão" virava RECEITA de R$ 20 (o
"mais 20" sem verbo é lido como receita) e a resposta trazia só ela — a
proposta da tela era substituída e o almoço e o café sumiam. Com a proposta
pendente toda de um tipo e a frase sem verbo ("e mais 20 de pão", "mais 15 no
café"), o orquestrador agora lê a frase com o verbo dos itens pendentes e
junta o novo item à proposta. 1 caso (vermelho antes). Gates: 666/666,
99/99, 50/50, **429/429**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção: "pão" não é palavra de Alimentação (cai em Outros);
"foi na padaria" (trocar a descrição da proposta) cai na ajuda.

## 2026-10-27 — trocar o lugar da proposta na tela

Com "gastei 50 no mercado" na tela, "foi na padaria" caía na ajuda genérica.
A correção da proposta agora troca o lugar/descrição ("foi na/no X", "era no
X", "a descrição é X", "muda o nome pra X") e, se o lugar novo diz a
categoria, troca também ("Padaria" → Alimentação). Cartão ("foi no Inter"),
data ("foi ontem") e categoria ("era lazer") continuam com prioridade. 2
casos (1 vermelho antes, 1 controle de cartão). Gates: 666/666, **431/431**,
151/151, 468 e os demais verdes — o `typecheck:api` (que inclui os testes)
pegou uma anotação de tipo faltando no oráculo, corrigida antes do commit.

## 2026-10-27 — "pão" é Alimentação

"Gastei 20 de pão" ia para Outros: "pão" não estava nas palavras de
Alimentação. Entrou "pão", e "pao" sem acento exige início de palavra — o
`guessCategory` agora examina o texto com um espaço na frente, então " pao"
casa "pao de queijo" e nunca "japao". 3 casos (2 vermelhos antes, 1 controle).
Gates: 666/666, 99/99, 50/50, **434/434**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-27 — limite do cartão

"Quanto eu tenho de limite no nubank" respondia "Não tenho faturas nesse
período com 'limite'"; "quanto tenho de limite" (sem "cartão"), "nenhum
lançamento com 'limite'". A consulta lia "limite" como texto de busca, e a
seção de cartões do roteador só abria com "cartão/fatura/parcela". Agora
`pedeLimite()` faz a DSL recusar, a seção de cartões abre com pergunta de
limite quando há cartão cadastrado, e o cartão citado tem resposta própria:
"O Nubank tem limite de R$ 8.000,00. Comprometido em parcelas e compras:
R$ 3.200,00. Disponível: R$ 4.800,00." Sem cartão citado, a soma. 2 casos no
grupo LM (os 2 vermelhos antes; literais do fixture). Gates: 666/666, 99/99,
50/50, **436/436**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção ainda: "qual minha maior parcela" devolve o resumo dos
cartões; "quando acaba a geladeira" cai na ajuda; "antecipei 2 parcelas do
computador" devolve o resumo em vez de dizer que o chat não antecipa.

## 2026-10-27 — parcelamento pelo nome, última e maior parcela

Os três achados acima, mais os vizinhos que a sondagem trouxe: "qual a
parcela mais cara" (outra ordem) devolvia o resumo; "qual a ultima parcela do
nubank" virava "Falta pagar até agora: R$ 5.200,00" pela DSL (soma de todos os
parcelamentos, sem a data pedida); "quando é a última parcela" devolvia o
resumo. Causa: pergunta de parcelamento sem dono. A seção de cartões só abria
com "parcela/cartão/fatura", e dentro dela não havia resposta para o fim nem
para a maior parcela.

Agora `pedeFimDoParcelamento()` e `pedeMaiorParcela()` (cashQuestions) fazem a
DSL recusar, e `respostaDoParcelamento()` responde:
- com o parcelamento citado pelo nome ("quando acaba a geladeira", que abre a
  seção sem a palavra "parcela"): "Geladeira termina em DD/MM/AAAA (parcela
  6/6): faltam 5 parcelas de R$ 400,00, R$ 2.000,00 ao todo.";
- sem nome: os parcelamentos do cartão citado, ou todos, com o último
  primeiro; cartão que não existe ("do itau") diz que não encontrou, em vez de
  responder pelos outros;
- maior parcela: a próxima parcela de cada parcelamento, com o empate dito
  (regra 56).
Antecipar não tem ação no chat; a resposta aponta Mais → Cartões e
parcelamentos → "Antecipar", a tela que já faz isso. "Vale a pena quitar o
computador" continua indo para o remoto: a entrada pelo nome exige pergunta de
data ("quando… acaba/termina/quito"), e o autoteste remoto pegou c-49 quando
"quitar" bastava. 7 casos no grupo PC (os 7 vermelhos antes; datas e somas
calculadas do fixture). Gates: 666/666, 99/99, 50/50, **443/443**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: "antecipei a fatura do nubank" devolve o resumo dos
cartões (é pagamento adiantado, não antecipação de parcela).

## 2026-10-27 — "tô devendo quanto" não é gasto do mês

Dinheiro errado: "to devendo quanto", "quanto ainda devo", "quanto devo no
total" e "quanto devo ao banco" respondiam "Total gasto este mês: R$
2.373,00". A DSL lia "devo" como gasto e somava o mês; a dívida do fixture é
R$ 5.200,00. "Qual minha dívida" caía no resumo dos cartões, e "quanto eu to
devendo no inter" dava só a fatura do mês (R$ 400,00), enquanto "quanto devo
no nubank" dava o que falta (R$ 3.200,00): a DSL só reconhecia "devo" como
dívida, não "devendo".

Agora `pedeDividaTotal()` faz a DSL recusar e abre a seção de cartões, que já
tinha a resposta da dívida ("Sua dívida parcelada restante é…", com o plural
de "parcelamentos" corrigido). Ficam de fora a dívida com dono ("devo do
computador", "devendo no inter", "devo pro joão") e o "devo" modal ("quanto
devo guardar"). A DSL também lê "devendo" como dívida quando há cartão
citado. 9 casos no grupo DV (6 vermelhos antes, 3 controles). Gates: 666/666,
99/99, 50/50, **451/451**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção, da mesma sondagem:
- "quanto tenho de parcela pra pagar mes que vem" diz que não há parcelas
  "com 'para pagar'" (há duas de R$ 400,00);
- "quanto vou pagar de cartao em dezembro" diz que não há lançamento com
  "cartao";
- "quais meus parcelamentos" dá só a soma, sem listar; "quantas parcelas eu
  tenho" não dá a contagem;
- "comprei um celular de 1200 em 10x" vai para Assinaturas;
- "quanto devo gastar por dia" responde a média gasta, não quanto pode gastar.

## 2026-10-27 — fatura e parcela de um mês à frente

Dinheiro errado: "quanto vai ser a fatura do nubank em dezembro", perguntado
em outubro, respondia "R$ 0,00 (dado real)" com base em 28/12/2025. O mês
solto era lido no passado, regra certa para "quanto gastei em dezembro", e
dezembro do ano anterior vem antes de qualquer parcelamento. "Quanto vou
pagar de parcela em dezembro" dizia que não havia parcelas; "quanto vence de
fatura em janeiro" lia janeiro de 2026.

Agora `mesAFrente()` (period.ts) relê o mês para o que vem quando a fonte é
fatura ou parcela e a frase não tem verbo no passado: o mês à frente no
calendário sempre, e o mês que já passou neste ano só com futuro dito
("vence", "vai", "vou"). "Quanto foi a fatura em dezembro" segue no ano
anterior, e "quanto de parcela em setembro" segue em setembro passado. 4
casos no grupo MF (3 vermelhos antes, 1 controle; mês e valores calculados de
hoje e do fixture). Gates: 666/666, 99/99, 50/50, **455/455**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achados sem correção, da mesma sondagem:
- "quanto paguei de fatura em dezembro" PROPÕE um pagamento de fatura ("Em
  qual cartão?"): pergunta virando registro;
- "quanto vou receber em novembro" é lido como gasto ("Total gasto");
- "vence", "pra pagar" e "cartao" sobram como texto de busca ("Não tenho
  parcelas… com 'vence'").

## 2026-10-27 — "quanto paguei de fatura" propunha pagar a fatura

Regra 33 quebrada: "quanto paguei de fatura" e "quanto paguei de fatura esse
mes" respondiam "Entendi isso: • Pagar fatura (valor pendente). Em qual
cartão?"; "quanto eu paguei da fatura do nubank" propunha o pagamento e
ainda respondia como se já estivesse pago ("Se você confirmar… paga").
Confirmar ali registraria R$ 400,00 que ninguém pagou. "Paguei a fatura?"
perguntava o cartão.

Causa: `splitClauses()` corta a frase antes de cada verbo de comando, e
"quanto | paguei de fatura" deixava a segunda metade sem a palavra que a faz
pergunta. A guarda de pergunta de `parseCardClause()` olhava só a metade.
Agora a cláusula que é só a palavra de pergunta ("quanto", "quanto eu") volta
para a seguinte antes do parser. O rascunho de pagamento sem cartão
(`detectIncomplete`) também tinha a mesma brecha e passa a ignorar pergunta.
"Paguei a fatura do nubank", "paguei 300 da fatura do inter" e "já paguei a
fatura" (afirmação) continuam propondo o pagamento. 6 casos no grupo QP (4
vermelhos antes, 2 controles). Gates: 666/666, 99/99, 50/50, **461/461**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: a resposta de "quanto paguei de fatura" agora é o resumo
dos cartões, quando deveria ser quanto foi pago; "quando paguei a fatura do
nubank" também cai no resumo.

## 2026-10-27 — "quanto guardei na reserva" dizia que não havia nada

Contradição entre respostas: "quanto guardei na reserva", "quanto mandei pra
reserva" e "quanto coloquei na reserva esse mes" diziam "Não tenho nenhum
lançamento… este mês", enquanto "quanto devo guardar por mês" dizia "Este mês
você já guardou R$ 500,00" e "quanto tenho na reserva" contava os 3
depósitos. A DSL filtrava pela CATEGORIA "reserva", mas a reserva é o TIPO
`saving` e o depósito pode estar em qualquer categoria (o legado gravava
"Outros", como o fixture). "Mandei pra reserva" ainda virava gasto.

Agora a categoria "reserva" numa consulta de lançamentos vira `txType:
['saving']` sem filtro de categoria, com o rótulo "Guardado na reserva" ("…
este mês: R$ 500,00"; por ano e por mês também). 3 casos no grupo RV (os 3
vermelhos antes; valor somado dos depósitos do mês no fixture). Gates:
666/666, 99/99, 50/50, **464/464**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

Achados sem correção, da mesma sondagem:
- "quanto depositei na viagem" responde quanto FALTA (R$ 1.200,00), não o
  que foi guardado (R$ 4.800,00) — corrigido na seção seguinte;
- "quanto recebi de aluguel" olha "os últimos 7 dias";
- "quando comprei a geladeira" cai na ajuda; "quanto parcelei no nubank" dá
  a fatura do mês.

## 2026-10-27 — meta: o que já foi guardado, o que falta e o alvo

Dinheiro errado: "quanto depositei na viagem" e "quanto coloquei na meta da
viagem" respondiam "Falta para a meta Viagem: R$ 1.200,00" (há R$ 4.800,00
guardados); "quanto depositei nas metas" respondia "Metas até agora: R$
4.000,00", que é a soma do que FALTA (guardado: R$ 6.000,00), com um rótulo
que não diz qual dos números é; "qual o valor das minhas metas" dava os
mesmos R$ 4.000,00 (alvo: R$ 10.000,00). A fonte de metas sempre usava o
campo `remaining`.

Agora o verbo escolhe o campo, como "já paguei" já fazia no parcelamento:
depósito ("depositei, coloquei, guardei, juntei, já tenho…") pede `saved`;
"valor das metas" pede `target`; "falta" fica em `remaining`. Sem meta pelo
nome, o rótulo diz o número: "Guardado nas metas", "Falta para as metas",
"Valor das metas". 5 casos no grupo MG (os 5 vermelhos antes; literais do
fixture). Gates: 666/666, 99/99, 50/50, **469/469**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

Achado sem correção: "quanto guardei nas metas esse mes" responde o total
"até agora" (a meta não guarda histórico de depósitos por mês); o "até agora"
diz isso, mas a pergunta era do mês.

## 2026-10-27 — sem período dito, o mês (no roteador antigo também)

Dinheiro errado: "quanto recebi de aluguel" respondia "R$ 0,00 em Aluguéis
nos últimos 7 dias" para quem recebeu R$ 3.000,00 no mês; "quanto ganhei de
freela" dava o lucro da semana inteira (−R$ 120,00), sem filtro nenhum, e
"quanto ganhei de freela no mês passado" dava o faturamento total do mês
(R$ 3.900,00, Freelance foi R$ 900,00). Duas causas no mesmo handler:
`periodFromText()` caía em "últimos 7 dias" sem período dito, enquanto a
consulta usa o mês (a mesma pergunta mudava de janela conforme quem a lia), e
o mapa de receita por categoria não conhecia "freela" nem "bico".

Decisão: sem período dito, o roteador antigo usa o mês corrente, como a
consulta. Com "essa semana" seguem os últimos 7 dias. Corpus, semânticos e
roteamento passaram sem mudança de rótulo. 3 casos no grupo RCAT (os 3
vermelhos antes; somas dos lançamentos do fixture). Gates: 666/666, 99/99,
50/50, **472/472**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "pra pagar", "vence" e "cartão" não são nome de lançamento

"Não tenho" falso: "quanto tenho de parcela pra pagar mes que vem" dizia
"Não tenho parcelas… com 'para pagar'" (há R$ 800,00); "quanto de parcela
vence em dezembro", o mesmo "com 'vence'"; "quanto vou pagar de cartao em
dezembro" procurava lançamentos com o texto "cartao"; e "quanto tenho de
fatura pra pagar" mandava "Cadastre um cartão" a quem tem dois. As palavras
que descrevem a fonte sobravam no texto e viravam filtro de busca.

Agora, com fonte de parcela, fatura ou parcelamento, "pra/para/a pagar" e
"vence/vencem/vencendo" são consumidos; "pagar/vence de cartão" (o cartão em
geral, sem nome) passa a ser fatura, decidido antes do período para que o mês
à frente valha também ali; e "quanto tenho de fatura pra pagar" é a pergunta
de quanto falta ("Falta pagar R$ 800,00 em faturas", cartão por cartão). 4
casos no grupo FL (os 4 vermelhos antes; somas das parcelas pendentes do
fixture em cada mês). Gates: 666/666, 99/99, 50/50, **476/476**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: "quanto de fatura vence esse mes" ainda dá o resumo dos
cartões (certo em valores, mas sem somar o que vence).

## 2026-10-28 — "quanto vou receber" é entrada, e no mês que vem

Dinheiro errado: "quanto vou receber esse mes" e "quanto vai entrar esse
mes" respondiam "Total gasto este mês: R$ 2.373,00". A lista de verbos de
entrada da consulta só tinha o passado e o presente ("recebi", "recebo",
"entrou"); "receber", "entrar" e "ganhar" caíam em despesa. Corrigido isso,
apareceu o segundo defeito: "quanto vou receber em dezembro", em outubro,
respondia "Total recebido em dezembro: R$ 1.777,00 (dado real)" com um
lançamento de dezembro do ano anterior.

Agora ENTRADA reconhece o infinitivo e o futuro, e `mesAFrente()` vale também
para lançamentos quando o futuro é dito ("vou", "vai", "vamos"): o mês à
frente é o que vem. "Quanto recebi em dezembro" segue no ano anterior. 3
casos no grupo EN. No código anterior, 2 vermelhos; o terceiro passava por
acaso (o tipo errado nem somava a entrada) e ficou vermelho com a correção do
verbo sozinha, antes da do mês. Gates: 666/666, 99/99, 50/50, **479/479**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: para o mês que vem, a resposta é "Não tenho nenhum
lançamento… Assim que você registrar", quando o útil seria a previsão (contas
fixas de entrada, média dos meses).

## 2026-10-28 — comprar um celular é compra, não assinatura

"Comprei um celular de 1200 em 10x no nubank" e "comprei um celular de 900"
iam para Assinaturas: "celular" é palavra-chave da conta de telefone. Agora,
na mesma cláusula de "comprei/parcelei um celular (smartphone, iPhone)", a
categoria que veio dessa palavra vira Compras. "Paguei 60 do celular" segue
em Assinaturas, e "comprei um celular de 900 e paguei 60 da conta do
celular" dá uma de cada. 3 casos no grupo CEL (2 vermelhos antes, 1
controle). Gates: 666/666, 99/99, 50/50, **482/482**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

## 2026-10-28 — a lista dos parcelamentos

"Quais meus parcelamentos" e "quantos parcelamentos eu tenho" davam "Falta
pagar até agora: R$ 5.200,00", sem dizer quais; "quantas parcelas eu tenho"
e "quantas parcelas faltam" davam o resumo dos cartões, que não conta
parcelas (são 13); "quanto parcelei no nubank" dava a fatura do mês; "quando
comprei a geladeira" caía na ajuda.

Agora `pedeListaDeParcelamentos()` faz a DSL recusar, e a seção de cartões
responde com a lista: "Você tem 2 parcelamentos com parcela a pagar: 13
parcelas, R$ 5.200,00 ao todo", e uma linha por compra (cartão, valor e
parcelas, quanto falta, até quando); com cartão citado, só os dele. Parcela
de UMA compra ("quantas parcelas faltam do computador") segue com a
consulta. Com o parcelamento citado, "quando comprei" dá a data da compra,
valor, parcelas e cartão. 5 casos no grupo LP (os 5 vermelhos antes;
literais do fixture). Gates: 666/666, 99/99, 50/50, **487/487**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica (agora 85
excelentes, 5 aceitáveis), varredura e `git diff --check` passaram.

## 2026-10-28 — "quanto posso gastar por dia"

Resposta perigosa: "quanto posso gastar por dia" (e "hoje", e "esse mes")
respondia "Dá pra gastar até uns R$ 9.586,50 hoje mantendo uma folga de
segurança": 70% do saldo menos só as contas fixas dos próximos 7 dias
(`balanceOutlook`), como gasto de HOJE. A fatura do Inter atrasada e a do
Nubank vencendo hoje (R$ 800,00) ficavam fora, o "por dia" era ignorado, e
"esse mês" recebia a mesma frase. "Quanto devo gastar por dia" ia para a
consulta e devolvia a média do que já foi gasto (R$ 84,75).

Agora `pedeQuantoPossoGastar()` cobre "posso/devo/deveria/consigo gastar", a
DSL recusa, e a conta é: saldo menos o que vence no prazo (as mesmas fontes
de "o que vence": faturas, contas e o que já venceu; o que falta confirmar
vai à parte) menos o que falta da meta de guardar do mês, dividido pelos
dias. Sem prazo dito, 30 dias: "Dá uns R$ 406,50 por dia nos próximos 30
dias", com a conta e os itens; "esse mês" vai até o último dia e avisa o que
vence logo depois. Sem contar o que ainda vai entrar, e dito assim. Sem
saldo informado, segue o caminho anterior (mês ou meta do dia). 3 casos no
grupo GD (os 3 vermelhos antes; teto do "por dia" = (saldo − R$ 800,00) / 30,
com o saldo do fixture). Gates: 666/666, 99/99, 50/50, **490/490**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Decisão registrada: o prazo do "por dia" é de 30 dias e desconta a meta de
guardar do mês. A Home continua com `balanceOutlook` (decisão pendente
abaixo).

## 2026-10-28 — "quanto paguei de fatura" é o que foi pago

Dinheiro errado: "quanto já paguei de fatura esse ano" respondia "Faturas
neste ano: R$ 2.000,00", o FATURADO (pagos: R$ 1.200,00); "quanto paguei de
fatura mês passado" e "quanto paguei de fatura" davam o resumo dos cartões.
A consulta usava o campo `amount` mesmo com "paguei", como o parcelamento já
não fazia. Trocado o campo, apareceu a contradição de fundo: "Pago nas
faturas no mês passado: R$ 0,00" ao lado de "Nubank: paga" e "Inter: paga".
O `paid` da fatura só somava pagamentos registrados (`CardPayment`), enquanto
o status vem das parcelas quitadas (`invoiceOpenAmount`).

Agora "paguei/quitei" com fonte de fatura pede o campo `paid`, rotulado
"Pago nas faturas", e a consulta toma a frente (o roteador antigo não o
expressa). O pago é o total menos o pendente, a mesma fonte do status. 3
casos no grupo FP (os 3 vermelhos antes; soma das parcelas pagas do fixture
pelo vencimento). Gates: 666/666, 99/99, 50/50, **493/493**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achados sem correção: "quando paguei a fatura do nubank" segue no resumo dos
cartões; a base do ano conta "20 faturas", incluindo meses em que os cartões
ainda não existiam (R$ 0,00 cada).

## 2026-10-28 — "quanto de fatura vence esse mês"

"Quanto de fatura vence esse mes" e "quanto vence de fatura esse mes" davam
o resumo dos cartões, sem a soma. É a pergunta de quanto falta pagar em
faturas, dita com "vence": `perguntaDeFatura()` agora a lê como 'falta' ("Falta
pagar R$ 800,00 em faturas", cartão por cartão). "Quando vence a fatura do
nubank" segue com a data, e mês futuro ("mês que vem", "em dezembro") segue
com a consulta. 2 casos no grupo FV (os 2 vermelhos antes). Gates: 666/666,
99/99, 50/50, **495/495**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "almocei 32" e "comprei pão e leite 18"

Registro perdido: "almocei 32 reais" e "comprei pão e leite 18" caíam na
ajuda genérica. O parser só lia gasto com verbo de gasto ("gastei, paguei,
comprei…"), e "almoçar/jantar/lanchar" já dizem que houve gasto e com quê; o
padrão "comprei <item> <valor>" aceitava no máximo duas palavras, sem "e".
Agora "almocei/jantei/lanchei (por) N" é despesa de Alimentação ("Almoço",
"Jantar", "Lanche"), e o item pode ter "e" ("Pão e leite", "Cimento e
areia"). "Almocei com o João hoje", sem valor, não registra nada. 4 casos no
grupo RF (2 vermelhos antes, 2 controles). Gates: 666/666, 99/99, 50/50,
**499/499**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

Achado sem correção: "quanto almocei esse mes" responde o gasto total do mês
(R$ 2.373,00), não o de almoço/alimentação.

## 2026-10-28 — "coloquei 40 litros a 5,89"

Dinheiro errado no registro do motorista: "coloquei 40 litros a 5,89" virava
um abastecimento de R$ 5,89 (o preço do litro lido como total) e mais uma
"Despesa de R$ 40,00 — Litros a 5", que a leitura genérica criava porque o
abastecimento lido só pelos litros não travava as outras leituras (`!f`
olhava só o padrão de valor). Certo: um abastecimento de R$ 235,60, 40 L a
R$ 5,89.

Agora "a X" depois dos litros é o preço do litro quando X é de litro (menor
que R$ 20) ou vem com "o litro"; total = litros × preço, e o `pricePerLiter`
vai junto. O abastecimento pelos litros trava as leituras de despesa
(`abasteceu`). A checagem de valores soltos conta o preço do litro como valor
representado (sem isso, a resposta perguntava "o que aconteceu com os R$
5,89?"). "Abasteci 24 litros por 180" e "30 litros a 180" seguem como total.
3 casos no grupo AB (2 vermelhos antes, 1 controle). Gates: 666/666, 99/99,
50/50, **502/502**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção, da mesma sondagem do motorista:
- "fiz 12 corridas e ganhei 260" registra 13 viagens — corrigido na seção
  seguinte;
- "hoje deu 310 no uber e 90 na 99" pergunta o que houve com "R$ 99,00" (é a
  plataforma) — corrigido mais abaixo;
- "recebi 50 de gorjeta" cria uma viagem.

## 2026-10-28 — "fiz 12 corridas e ganhei 260" são 12 viagens

Contagem errada: "fiz 12 corridas e ganhei 260" (e na ordem inversa)
registrava 13 viagens. A segmentação corta a frase em duas; a metade "ganhei
260", sozinha, inferia 1 viagem da receita (regra vigente para quem não diz a
quantidade), e a fusão do trabalho do dia somava 12 + 1. Agora, se alguma
cláusula DIZ a quantidade ("N corridas/viagens"), as viagens inferidas nas
outras saem antes da fusão (o trabalho sem km nem horas sai junto). "Ganhei
260" sozinho continua inferindo 1 viagem. 3 casos no grupo VG (2 vermelhos
antes, 1 controle). Gates: 666/666, 99/99, 50/50, **505/505**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achados sem correção, da mesma sondagem:
- "rodei 8 horas, fiz 15 viagens e faturei 340" registra 8 KM (as horas
  viram quilômetros) e 16 viagens — as 16 viagens corrigidas acima, as horas
  na seção seguinte;
- "fiz 3 corridas de 40 e uma de 25" perde os R$ 145,00 e pergunta o que
  houve com "R$ 40,00, R$ 25,00";
- "fiz 12 corridas e 260", sem verbo na segunda metade, perde os R$ 260,00.

## 2026-10-28 — "rodei 8 horas" é jornada, não 8 km

Registro errado: "rodei 8 horas" e "rodei 10h hoje" viravam 8 e 10 KM, e
"rodei 8 horas, fiz 15 viagens e faturei 340" gravava 8 km e nenhuma hora.
O padrão de distância aceitava "rodei N" seguido de hora, e o de jornada só
conhecia "rodei POR N horas". Agora o número seguido de hora não é distância
(com trava de dígito, para "12 horas" não virar 1 km), "rodei N horas/h" é
jornada, e com verbo de rodar a outra medida pode vir depois de "e": "rodei
8h e 150 km" e "rodei 150 km e 8 horas" dão as duas. 6 casos no grupo KH (5
vermelhos antes, 1 controle). Gates: 666/666, 99/99, 50/50, **511/511**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado sem correção: "troquei o óleo com 150 km" vira manutenção de R$ 150,00
(é a quilometragem, não o custo).

## 2026-10-28 — "na 99" é a plataforma, não R$ 99,00

"Hoje deu 310 no uber e 90 na 99" e "recebi 85 pela 99" liam as receitas
certas e depois perguntavam "Você mencionou R$ 99,00 nesta parte… o que
aconteceu com ele?": a checagem de valores soltos (`unaccountedMoney`) lia o
nome da plataforma como dinheiro. Agora "99" depois de "na/no/pela/pelo/da/
do/de/a", sem "reais" depois, não é valor. "Gastei 99 de lanche" e "recebi
99 reais da 99" seguem com os R$ 99,00. 2 casos no grupo P99 (os 2 vermelhos
antes). Gates: 666/666, 99/99, 50/50, **513/513**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

## 2026-10-28 — "fiz 3 corridas de 40 e uma de 25"

Dinheiro perdido no registro do motorista: "fiz 3 corridas de 40 e uma de
25" e "fiz 2 viagens de 50" registravam só as viagens (3 e 2); os R$ 145,00
e os R$ 100,00 viravam a pergunta "o que aconteceu com os R$ 40,00, R$
25,00?". Só "uma corrida de X" era receita. Agora `gruposDeCorrida()` lê
quantidade × valor por grupo — o primeiro diz "N corridas/viagens de X" com
N > 1, os seguintes vêm depois de "e" ou vírgula ("e uma de 25", "e 3 de
20") — e cada grupo vira receita de Corridas; as viagens dos grupos
seguintes somam às ditas (4 no exemplo). A checagem de valores soltos ignora
os números de dentro de um grupo cujo produto está registrado. "10 corridas
de 15 km" não é valor. 3 casos no grupo CQ (2 vermelhos antes, 1 controle).
Gates: 666/666, 99/99, 50/50, **516/516**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-28 — gorjeta não é viagem

"Recebi 50 de gorjeta", "ganhei 120 de bônus da uber" e "caiu 80 de
incentivo da 99" registravam também "Trabalho: 1 viagem": a regra que infere
uma viagem de cada receita de corrida não distinguia o que não é corrida, e
o ganho por viagem do motorista caía. Agora gorjeta, bônus, incentivo,
promoção e caixinha seguem como receita de Corridas, sem viagem. "Ganhei 40
numa corrida" segue com 1 viagem. 4 casos no grupo GJ (3 vermelhos antes, 1
controle). Gates: 666/666, 99/99, 50/50, **520/520**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

## 2026-10-28 — a quilometragem da troca não é o custo

Dinheiro errado: "troquei o óleo com 45 mil km" virava manutenção de R$
45.000,00 (o "45 mil" chega como 45000 ao parser) e "troquei o óleo aos 45
mil km por 180" registrava R$ 45.000,00 e perdia os R$ 180,00. O padrão de
manutenção pegava o primeiro número depois do item como custo; a
quilometragem só era lida se viesse depois do valor e com "com". Agora a
quilometragem da troca ("com/aos/a/em/no N (mil) km") é lida e retirada antes
do custo. Sem custo dito, nada é registrado (antes: R$ 45.000,00). "Troquei o
óleo por 180 com 45 mil km" segue igual. 3 casos no grupo MK (2 vermelhos
antes, 1 controle). Gates: 666/666, 99/99, 50/50, **523/523**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achado sem correção: sem custo, "troquei o óleo com 45 mil km" cai na ajuda;
o certo seria perguntar quanto custou (rascunho).

## 2026-10-28 — "fiz 12 corridas e (deu) 260"

"Fiz 12 corridas e 260", "fiz 12 corridas e deu 260" e "fiz 12 corridas, 260
reais" registravam só as 12 viagens e perguntavam "o que aconteceu com os R$
260,00?". Para o motorista, o valor logo depois das corridas é o que elas
renderam: agora vira receita de Corridas (sem viagem a mais). No perfil
autônomo nada muda (viagem não é registro ali). 3 casos no grupo CR (os 3
vermelhos antes). Gates: 666/666, 99/99, 50/50, **526/526**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

Achado: "fiz 12 corridas e 40 km" e "fiz 5 corridas e 3 horas" perdiam a
medida depois do "e" (só "rodei" puxava a outra medida). Corrigido em
seguida: com "N corridas/viagens" na frase, "e N km" e "e N horas" também são
lidos. 2 casos a mais no grupo KH (os 2 vermelhos antes). Gates: 666/666,
99/99, 50/50, **528/528**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "quanto almocei esse mês"

"Quanto almocei esse mes" e "quanto jantei esse mes" davam "Total gasto este
mês: R$ 2.373,00", o mês inteiro: "almocei" e "jantei" não contêm as
palavras-chave "almoço" e "janta", e a pergunta ficava sem categoria
("quanto lanchei" já funcionava, porque "lanchei" contém "lanche"). Agora
"almocei", "almoçamos", "jantei" e "jantamos" são palavras-chave de
Alimentação (R$ 463,00 no mês do fixture). 2 casos no grupo QA (os 2
vermelhos antes). Gates: 666/666, 99/99, 50/50, **530/530**, metamórficos,
fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica, varredura e
`git diff --check` passaram.

## 2026-10-28 — "compara com setembro" na continuidade

Comparação com o mês errado: em conversa, "compara com setembro" ignorava o
mês dito. Depois de "quanto gastei em agosto" e "quanto recebi esse mes", a
resposta foi "Em agosto foi exatamente o mesmo valor" (o foco antigo; em
setembro entraram R$ 3.900,00); depois de "e quanto recebi?", comparou agosto
com julho. O foco tratava "compara JULHO com JUNHO" (dois meses), não
"compara COM X". Agora o período dito depois de "compara com" é o comparado;
com grão diferente ("este mês" contra "a semana passada", que dava +691%),
o período em foco vira o atual do mesmo grão (semana contra semana). 3 casos
no grupo CS (os 3 vermelhos antes; somas do fixture). Gates: 666/666, 99/99,
50/50, **533/533**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achado, da mesma conversa: "e de aluguel?" depois de "e quanto recebi?" caía
na ajuda genérica. Corrigido em seguida: a restrição só aceitava o NOME da
categoria ("Aluguéis"), e "aluguel" no singular não casava. Agora também o
id, no tipo da consulta ("aluguel" recebido é Aluguéis; o gasto não muda).
Palavra-chave ficou de fora de propósito: "sem cimento" excluiria a Obra
inteira, e "de mercado" buscaria toda a Alimentação. 1 caso a mais no grupo
CS (vermelho antes). Gates: 666/666, 99/99, 50/50, **534/534**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achados sem correção (já antes desta rodada): no contexto de gasto, "e de
mercado?" e "e de aluguel?" caem na ajuda ("e no mercado?" funciona); e "e no
mercado?" responde "Total gasto este mês: R$ 200,00" sem dizer que é só o
mercado — este último corrigido na seção seguinte.

## 2026-10-28 — "e no mercado?" diz que é só o mercado

Rótulo enganoso: em conversa, "e no mercado?" respondia "Total gasto este
mês: R$ 200,00" — número certo, lido como o gasto do mês inteiro. A
restrição trocava o cabeçalho para categoria e origem, mas a busca por texto
herdava o rótulo antigo. Agora: "Total gasto - Mercado este mês". 1 caso no
grupo CS (vermelho antes). Gates: 666/666, 99/99, 50/50, **535/535**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

Achado (já antes): "e só no nubank?" depois de "quanto gastei esse mes"
dizia "Não tenho nenhum lançamento": a restrição punha o cartão como filtro
de lançamentos, e lançamento não carrega cartão. Corrigido em seguida, como
a consulta direta já fazia: cartão sobre lançamentos é a fatura dele ("Faturas
do Nubank este mês: R$ 400,00"; "e no inter?" depois de "em setembro" dá a
de setembro). 1 caso no grupo CS (vermelho antes). Gates: 666/666, 99/99,
50/50, **536/536**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "e de mercado?" na conversa

"E de mercado?" (e "e de cimento?") depois de "quanto gastei esse mes" caía
na ajuda genérica; só "e no mercado?" funcionava. A restrição sem "no/na"
exigia que o nome fosse categoria ou cartão, para não confundir outras
elipses. Agora, com preposição ("com/de/em") sobre lançamentos, o nome também
vale quando aparece nas descrições ou origens dos lançamentos dele ("Total
gasto - Mercado este mês: R$ 200,00"). Sem essa evidência ("e de novo?", "e
com isso?") segue como antes. 2 casos no grupo CS (1 vermelho antes, 1
controle). Gates: 666/666, 99/99, 50/50, **538/538**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

## 2026-10-28 — "se eu parar de pagar a internet" simula a conta fixa

"Se eu parar de pagar a internet quanto sobra?" respondia "Se você parar os
gastos com Assinaturas… R$ 0,00… Não achei base": a simulação de corte
resolvia o alvo pela palavra-chave ("internet" é Assinaturas), e a conta
fixa Internet do fixture está em Casa. Cortar a categoria Casa também não
servia: tiraria a Luz junto. "Se eu cancelar a internet" nem era reconhecido.

Agora o corte procura antes uma conta fixa citada pelo nome e, achando, leva
o `recurringId`: o motor retira só aquela conta (a média da categoria não
entra, porque misturaria Luz e Internet) e diz "Retirei da simulação só a
conta fixa Internet, de R$ 120,00 por vencimento" (R$ 600,00 no horizonte).
`representedRecurringExpenseMonths()` ganhou o filtro opcional por conta.
"Cancelar" passou a ser verbo de corte. 2 casos no grupo CFX (os 2 vermelhos
antes). Gates: 666/666, 99/99, 50/50, **540/540**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

Achado, da mesma sondagem: "e se eu cortar o mercado pela metade?" respondia
"Se você PARAR os gastos com Alimentação" — a metade virava corte total.
Corrigido em seguida: "pela metade" leva `ratio: 0.5` no corte; o motor
multiplica o efeito pela fração e não remove a conta cadastrada; a resposta
diz "Se você cortar pela metade os gastos com Alimentação: … em média R$
614,00 por mês; a metade é R$ 307,00". Vale para conta fixa também ("metade
da conta fixa Internet: R$ 60,00 a menos por vencimento"). 1 caso a mais no
grupo CFX (vermelho antes). Gates: 666/666, 99/99, 50/50, **541/541**,
metamórficos, fuzz, 151/151, 468; typechecks, `test:money`, build, rubrica,
varredura e `git diff --check` passaram.

## 2026-10-28 — o prazo da meta não se perde

Meta sem prazo: "quero juntar 5000 pra uma moto até dezembro do ano que vem"
criava a meta chamada "Moto ate dezembro", sem prazo; e "quero comprar um
celular de 5000 em 6 meses" também nascia sem prazo — o parser lia os 6
meses, mas o texto que chegava a ele já vinha sem a data. Três causas:
- o nome depois de "pra" engolia "até dezembro";
- "até <mês>" não virava prazo;
- a análise de cláusulas protegia o prazo da meta filtrando as datas, mas o
  texto do parser (`semData`) procurava as datas de novo e as arrancava; e
  só protegia prazo relativo, não "dezembro do ano que vem".
Agora "até <mês> (do ano que vem | de AAAA)" e "até o fim do ano" viram
`months` (até o último dia do mês, em meses de 30 dias, como a execução
conta) e saem do nome; toda data futura numa frase de meta fica no texto do
parser. 3 casos no grupo MPZ (os 3 vermelhos antes). Gates: 666/666, 99/99,
50/50, **544/544**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achados sem correção, da mesma sondagem:
- "quero juntar 1000 pra viagem e amanhã pago a luz 180" cria a meta "Viagem
  e pago" e perde a luz (já antes) — o nome corrigido na seção seguinte; a
  metade futura ainda some sem aviso (a frase não é cortada em "e amanhã");

## 2026-10-28 — o nome da meta para no "e"

"Quero juntar 1000 pra viagem e amanhã pago a luz 180" criava a meta "Viagem
e pago": o nome depois de "pra" aceitava até três palavras quaisquer. Agora
para em "e/mas/que/até/em/daqui" ("Viagem"; "moto nova" segue "Moto nova").
1 caso no grupo MPZ (vermelho antes). Gates: 666/666, 99/99, 50/50,
**545/545**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "tirei 100 da viagem"

"Tirei 100 da viagem" e "retirei 200 da meta do notebook" caíam na ajuda
genérica. Retirar de meta não tem ação no chat (como a reserva, que já tinha
resposta própria), mas a tela tem: Metas → <meta> → Editar → "Já guardado".
Agora, com a meta citada pelo nome, a resposta aponta esse caminho com o
valor que fica ("de R$ 4.800,00 para R$ 4.700,00"), sem criar ação. 2 casos
no grupo TM (os 2 vermelhos antes). Gates: 666/666, 99/99, 50/50,
**547/547**, metamórficos, fuzz, 151/151, 468; typechecks, `test:money`,
build, rubrica, varredura e `git diff --check` passaram.

Achado sem correção: "usei 50 da viagem pra pagar a luz" registra a despesa
de R$ 50,00 (Casa) com a descrição "Usei da viagem pra pagar a luz" e não
mexe na meta.

## 2026-10-28 — "Alterar meta 'Viagem'"

"Muda a meta da viagem pra 7000" confirmava "Alterar meta 'viagem'", em
minúscula, enquanto o depósito na mesma meta mostra "Viagem": o nome da
alteração não passava por `cleanDescription()`. 1 caso no grupo TM (vermelho
antes). Gates: 666/666, 99/99, 50/50, **548/548**, metamórficos, fuzz,
151/151, 468; typechecks, `test:money`, build, rubrica, varredura e `git diff
--check` passaram.

Achado: "aumenta a meta pra 6000", sem dizer qual, respondia "Alterar meta:
Falta uma informação obrigatória." em vez de perguntar qual das metas.

## 2026-10-28 — alterar meta sem nome, ou com nome que não existe

"Aumenta a meta pra 6000" (sem nome, duas metas) respondia a mensagem de
validação "Alterar meta: Falta uma informação obrigatória."; com uma meta só,
também não propunha nada; e "muda a meta da casa pra 9000" (não existe meta
Casa) propunha a alteração, que só falharia depois do Confirmar. O depósito
em meta já tinha esse tratamento (`reconcileGoalDeposits`); a alteração não.
Agora a mesma reconciliação vale para `goal-update`: nome conhecido leva a
grafia da meta; sem nome e uma meta ativa, é ela; sem nome com várias, ou
nome desconhecido, a ação é segurada e vira "Qual meta você quer alterar
para R$ 6.000,00?" (ou "Não encontrei a meta "Casa". Qual…"), com uma opção
por meta. 3 casos no grupo TM (os 3 vermelhos antes). Gates: 666/666, 99/99,
50/50, **551/551**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

## 2026-10-28 — "e era da casa 2" com a proposta na tela

Proposta descartada: com "Receita de R$ 1.800,00 (Aluguéis)" na tela, "e era
da casa 2" respondia "Entendi que isso não aconteceu — não registrei nada" e
a proposta sumia. As correções liam valor, parcelas, cartão, data, categoria
e lugar, não a origem; a frase sobrava como correção sem ação, e o
orquestrador a lia como negação. Agora "(e) era/foi/veio do/da <origem>"
corrige a origem da receita ou despesa em foco, pela mesma regra explícita
de `extractOrigins` (substantivo de fonte + identificador, ou nome próprio):
"Anotei a origem: Casa 2." 2 casos no grupo OC (1 vermelho antes; o controle
garante que uma correção vaga não vira "não aconteceu"). Gates: 666/666,
99/99, 50/50, **553/553**, metamórficos, fuzz, 151/151, 468; typechecks,
`test:money`, build, rubrica, varredura e `git diff --check` passaram.

Achado, da mesma sondagem: "na verdade foi na padaria", com a despesa do
mercado na tela, respondia "não peguei o quê" (a correção de lugar só aceitava
a frase começando em "foi/era"). Corrigido em seguida: os prefixos de
conserto ("na verdade", "na real", "ou melhor", "quer dizer", "pensando bem")
saem antes de ler o lugar ("Troquei para Padaria."; "na verdade foi 45"
segue trocando o valor). 1 caso no grupo OC (vermelho antes). Gates:
666/666, 99/99, 50/50, **554/554**, metamórficos, fuzz, 151/151, 468;
typechecks, `test:money`, build, rubrica, varredura e `git diff --check`
passaram.

## 2026-10-28 — continuidade no Codex após `a4afa92`

Foram lidos os três relatos do Claude e confirmado o baseline de 554/554
adversariais. Foram acrescentados 18 casos pelo orquestrador real, com RED
antes das correções nas reproduções de falha e controles para comportamento
legítimo. O lote trata cinco causas:

- `Quando/que dia paguei a fatura`: usa `CardPayment.paymentDate`, nome do
  cartão, valor e mês da fatura. Não usa vencimento como data de pagamento e
  não chama parcial de quitação. Sem evento datado, explica a falta da data.
- Manutenção sem custo: pergunta quanto custou, retém item, hodômetro e data,
  e amadurece o rascunho após a resposta. Hodômetro não é usado como custo.
- `Quanto vou receber`: usa recorrências previstas em aberto, sem somar
  histórico realizado, ocorrências confirmadas/dispensadas ou transações já
  materializadas. O mês corrente vai de hoje ao fim do mês. Dois oráculos EN
  anteriores estavam errados ao exigir o já recebido para uma pergunta futura;
  foram corrigidos, com novos casos de valores literais (650 previstos contra
  9000 realizados). Receita no passado continua consultando transações.
- Meta seguida de `e amanhã/depois de amanhã`: segmenta as duas intenções;
  preserva a meta e informa a parte futura não registrada. O limite de palavra
  passou a aceitar o `ã` final de amanhã.
- Depósitos em metas por mês: o modelo de dados não guarda histórico completo
  de depósitos. A consulta explica isso sem apresentar o acumulado atual como
  depósito mensal. A consulta do acumulado continua válida; sua explicação
  agora mostra o campo `saved`, em vez dos valores restantes das metas.

Gates: 666/666 corpus, 99/99 consulta/cenário, 50/50 semânticos,
**572/572 adversariais**, 4.088 + 3.800 metamórficos, 1.416 fuzz,
151/151 invariantes e 468/468 verificações remotas offline. Typechecks,
teste monetário, build, rubrica e `git diff --check` passaram. Rubrica:
0 perigosa, 0 ruim, 5 aceitáveis e 85 excelentes. O build ainda avisa de
chunk acima de 500 kB. Sem chamadas DeepSeek, push, merge, deploy ou APK.
`.claude/launch.json` segue como modificação preexistente, fora da entrega.

## 2026-10-28 — persistência real e compromissos da simulação, após `c72a069`

Smoke no navegador em `http://127.0.0.1:5274`, origem local isolada, perfil
fictício "Teste local", IA remota desligada antes de usar o chat. Reproduzido:
"troquei o óleo aos 45000 km ontem" → pergunta custo → "custou 180" →
proposta correta. Porém Confirmar seguido de recarga imediata perdeu a
manutenção e a despesa: o timer de gravação de 150 ms ainda não tinha rodado.

A fila de persistência foi extraída para `store/persistence.ts`. O provider
atualiza o snapshot antes de pintar a tela e descarrega a gravação em
`pagehide`, quando a página fica oculta e ao desmontar. O reset cancela o
snapshot antigo antes de remover a chave. O teste do núcleo cobre descarga
imediata do último snapshot, cancelamento do timer, cancelamento no reset e
gravação normal pelo timer. O tratamento/aviso de erro de armazenamento foi
preservado.

Após a correção, Confirmar + recarga imediata manteve "Registrado!", a
manutenção e a despesa de R$ 180. O journal também sobreviveu: "desfaz o
último" encontrou despesa e manutenção, pediu confirmação e, após confirmar
e recarregar imediatamente, a despesa continuou removida. Esse é um smoke
específico, não validação completa de persistência nem de dados legados reais.

Foi reproduzida também a divergência da simulação: saldo 1000, gasto
hipotético 100 e fatura pendente 1200 resultavam em `feasible: true`.
Agora o cenário de gasto usa `cashObligationsUntil` para contas, faturas e
parcelas sem cartão, incluindo vencidas e próximos 7 dias. Mostra saldo 900,
compromissos 1200 e saldo após compromissos -300. Parcela de cartão entra
somente pela fatura. Compromisso já pago não volta a ser cobrado. Conta
vencida sem confirmação não é dívida certa; se puder inverter o resultado,
não há veredito de viabilidade. Quatro casos SCF cobrem esses contrastes.
Os auxiliares de calendário aceitam uma data de referência opcional, usada
pela simulação, mantendo o relógio atual como padrão dos outros chamadores.

A tela de privacidade dizia que o saldo ia no resumo remoto. Foi corrigida
para distinguir armazenamento local, mensagem atual, contexto mínimo e
totais opcionais. O histórico de movimentações e saldo em conta não são
contexto automático; dados escritos na mensagem atual podem ser enviados.
Não houve mudança do payload. O histórico de pagamentos também recusa datas
inválidas/futuras ao responder "quando paguei".

Gates: 666/666, 99/99, 50/50, **576/576 adversariais**, 4.088 + 3.800
metamórficos, 1.416 fuzz, 151/151 invariantes e 468/468 verificações remotas
offline; typechecks, build e rubrica verdes (0 perigosa, 0 ruim, 5 aceitáveis,
85 excelentes). O aviso de chunk acima de 500 kB permanece. Sem chamada
DeepSeek, push, merge, deploy ou APK; `.claude/launch.json` intocado.

## Pendências em 28/10/2026 (após o lote iniciado em `c72a069`)

Estado: 666/666 corpus, 99/99, 50/50, **576/576 adversariais**, 4.088 + 3.800
metamórficos, 1.416 fuzz, 151/151 invariantes, 468/468 offline (65 frases
chegam hoje ao modelo remoto); typechecks, `test:money`, build e rubrica
(0 perigosa, 0 ruim) verdes. Tudo local, sem DeepSeek, push, merge, deploy ou
APK. **NOT READY para merge/deploy**: os diffs `c3648de..c824fe0`,
`c824fe0..b049bdf`, `b049bdf..73c8d24` e os posteriores a `73c8d24` (seções acima,
uma por causa) precisam de auditoria independente. Houve smoke local de
navegador/persistência com manutenção e desfazer, usando somente dados
fictícios. Os demais fluxos e dados legados reais não foram revalidados.

Abertas, achadas na leitura humana e ainda não corrigidas (detalhe nas
seções de 27 e 28/10 acima):
- "Antecipei a fatura do nubank" foi tratado no lote de 28/10 abaixo:
  explica a limitação de referência no chat; não registra antecipação.
- Receita sem origem ("recebi 2 mil do cliente", "caiu 350 de pix do joão")
  é a regra "Origem explícita — nunca inferida" (`extractOrigins`, em
  clauses.ts): só valem substantivo de fonte + identificador ("do cliente
  João", "da casa 1") ou nome próprio com maiúscula. Uma tentativa em
  28/10 de ler "do <nome>" no parser foi revertida antes do commit: quebrou a
  invariante "futuro explícito nunca vira realizado" ("…e 700 do cliente ana
  mas o da ana só entra amanhã" virou recebido) e o corpus adaptativo. Se o
  produto quiser origem de nome em minúscula, o caminho é perguntar "de
  quem?", não inferir.
- "Devo muito?" foi tratado no lote de 28/10 abaixo: apresenta dívida
  cadastrada e evita classificar subjetivamente como muito ou pouco.

Decisões de produto pendentes:
- `balanceOutlook` e o cenário de entrada ausente foram alinhados com
  `cashObligationsUntil()` nos lotes abaixo; a divergência foi corrigida.
- Não existe lançamento de retirada da reserva (`insufficient-reserve` não é usado).
- O chat não apaga lançamento salvo (só "desfaz o último" lote do assistente).
- O chat não confirma ocorrência de conta fixa: "paguei a luz de 180" cria
  despesa avulsa (com aviso) no estado antigo; a correção de 28/10 abaixo
  passou a recusar essa proposta quando a conta fixa está em aberto.
- Viagem inferida em total do dia: o corpus se contradiz (`rr-01` sem viagem
  com horas; `sem-04` 2 viagens com 8 horas; `mul-07` 1 viagem com 120 km).
- "Vale a pena ficar mais 3h?" e "vale a pena rodar domingo?" respondem com
  o que rende e a meta/histórico, sem Sim/Não: o app não sabe o cansaço nem o
  custo de oportunidade de ninguém.
- Fixture `autonomoRico`: Luz/Internet com `startDate` no dia 1º e `dueDay`
  10/15 — vencem no dia 1º nas respostas (o formulário grava os dois coerentes).

## 28/10/2026 — Receita ausente, nova hipótese e modalidade em continuidade

Reproduzidos antes da correção: saldo 1000 com fatura 1200 fazia a hipótese
"e se a Casa 1 não pagar?" dizer que sobrava 1000; após ela, "e se eu gastar
100 hoje?" era bloqueada por esclarecimento. Agora a ausência de receita
usa compromissos vencidos e dos próximos 30 dias, incluindo faturas uma vez
e parcelas sem cartão. Mostra -200 no primeiro caso e -300 no novo gasto.
Contas vencidas sem confirmação não viram dívida certa; se puderem inverter
o resultado, o veredito fica indefinido e o texto pede conferir as pendências.
A média de receita e o saldo usam somente transações até a data consultada.
Valor explícito não é descrito como média. O cálculo explica que usa caixa
atual, sem somar receitas futuras ou subtrair duas vezes renda não recebida.

A consulta em continuidade agora respeita a modalidade explícita: previsão
650 da Casa 1 -> recebido 9000 da Casa 1 -> previsão deste mês 650, de hoje
ao fim do mês. Casa 2 explicitamente citada substitui Casa 1 (4000 realizados).
Os filtros de previsão/realizado não atravessam indevidamente a troca de fonte.
Depois da limitação de depósitos mensais em metas, "e no total?" recupera
6000 acumulados; "e na viagem?" restringe para 4800; mês passado continua
indisponível e "e até agora?" recupera 4800 sem perder a meta.

14 novos testes reais; 590/590 adversariais. Baseline restante preservada:
666 corpus, 99 consulta/cenário, 50 semânticos, 4088 + 3800 metamórficos,
1416 fuzz, 151 invariantes, 468 avaliações offline; typechecks, build, dinheiro
e rubrica (0 perigosa/ruim, 5 aceitáveis, 85 excelentes) passaram. Aviso de chunk
grande permanece. Sem remoto pago, publicação ou APK. `.claude/launch.json`
continua alteração preexistente fora dos commits. NOT READY: falta auditoria
independente. Retomadas autorizadas neste chat e instruções em
`docs/CODEX_RESUME.md`; reserva mínima de uso 5%, parada conservadora com 10%.

## 28/10/2026 — Cobertura de compromissos na Home e nos resumos

Após cd5aaef, reproduzida a mesma omissão de faturas em balanceOutlook,
usado pela tela inicial, avisos e resumo do chat. Saldo 1000/fatura1200
agora produz compromisso1200, falta200, sem somar a parcela de novo.
Fatura paga sai da conta, dívida vencida continua incluída e conta vencida
sem confirmação fica separada; se puder inverter o resultado, ok é indefinido.
Legado ambíguo de pagamento no cartão também impede veredito de cobertura.
Home, avisos e os dois resumos usam texto comum e mostram o horizonte de
compromissos vencidos e próximos7dias. A ressalva de pendências não atribui
conta antiga automaticamente a dívida certa. O auxiliar aceita data de
referência injetada; as transações futuras não viram saldo disponível hoje.

6 regressões adicionais,596/596 adversariais. npm test, typechecks, build
e rubrica verdes; demais contagens preservadas. Alteração local, sem envio
remoto, publicação ou APK. Aviso de bundle grande permanece. Ainda NOT READY
até auditoria independente. A exibição do número bruto do saldo em outros
pontos e todas as telas/fluxos legados não foram revalidadas nesta rodada.

## 28/10/2026 — Data futura não vira saldo disponível

Após811ef5d, o teste literal mostrou que currentBalance somava receita9000
de amanhã e descontava despesa2000 de depois de amanhã no saldo de hoje.
Também descontava antecipadamente CardPayment futuro, quitação direta
futura e parcelas parciais com datas de amanhã. Sete testes novos, primeiro
vermelhos nas cinco classes matemáticas, cobrem essas fontes, data de
referência explícita, pergunta de saldo e gasto maior que o caixa atual.

currentBalance agora tem data opcional (hoje por padrão), respeita o limite
superior da data em todos os eventos de caixa e mantém âncora/ordem/desconto
único já existentes. Cenários, balanceOutlook e projeção mensal passam a
mesma referência. A correção localizada anterior que filtrava só transações
no cenário de receita ausente foi substituída pela função central.

603/603 adversariais. npm test completo passou com os primeiros601 casos;
os dois contrastes adicionais de chat também passaram no conjunto603.
Typecheck frontend, API e build passaram. Demais invariantes e avaliações
preservadas; não houve chamada paga, publicação ou APK. NOT READY para merge
até auditoria independente. Pagamentos futuros registrados podem ainda
marcar uma parcela como paga nas visões de dívida: essa semântica não foi
alterada neste lote e deve ser investigada separadamente.

## 28/10/2026 — Pagamento não pode quitar antes de acontecer

Depois6195f23, reproduzida no reducer a quitação de parcela por CardPayment
com data futura: o saldo não saía mais antecipadamente, mas a dívida era
marcada como paga. Data vazia e30/02 também passavam. O formulário de fatura
não validava data. As três classes agora são recusadas na entrada, sem
alterar o estado: pagamento da fatura, quitação direta e parcial de parcela.
A tela limita a data a hoje, desabilita salvar e explica o erro. O mesmo
validador de data é compartilhado com o reducer, protegendo chamadas diretas.

Contraste: pagar HOJE uma fatura que vence depois permanece permitido;
vencimento e data do desembolso são coisas diferentes. Não foi feita migração
nem reinterpretação de pagamentos futuros já salvos em backups. Para eles,
o saldo respeita a data, mas a situação da dívida ainda exige investigação.

Quatro casos novos primeiro vermelhos;607/607 adversariais agora verdes.
Suíte completa, frontend/API typechecks e build passaram. Contagens restantes
preservadas. Sem chamada paga, publicação ou APK; NOT READY até auditoria.

## 28/10/2026 — Dívida em linguagem curta e limite da antecipação

Após c48c641, "devo muito?" ainda caía na ajuda; "estou devendo muito?"
mostrava a dívida sem responder ao julgamento pedido. Agora ambas mostram a
dívida registrada e explicam que os dados não bastam para classificar como
muito ou pouco. Não foi criado limiar de renda/risco. Antecipação de fatura
("antecipei", "quero antecipar", "como adiantar") explica a limitação de mês
de referência do contrato do chat. Orienta conferir cartão/vencimento na
fatura exibida antes de usar a tela; não promete seleção arbitrária de mês.
Sem alegação de registro nem ação financeira proposta nesses exemplos.

5 regressões novas primeiro vermelhas; 612/612 adversariais. Suíte completa,
frontend/API typechecks, build e rubrica (0 perigosa/ruim) verdes. Demais
contagens preservadas. Sem chamada paga, publicação ou APK. NOT READY até
auditoria independente; limitação de selecionar referência no chat permanece.

## 28/10/2026 — Período curto da previsão e origem com mês

Depois6f5a287, "quanto vou receber da Casa1 mês que vem?" -> "e este mês?"
ainda copiava a janela realizada (dia1 até hoje), excluindo a receita do
próximo dia20. Três variantes reproduziram o erro. Agora herdam o período
da previsão, de hoje ao fim do mês, preservando origem e modalidade.

Também reproduzido: "e da Casa2 esse mês?" ignorava Casa2, pois o leitor do
período retornava antes da restrição. O refino lê a restrição explícita no
texto restante antes de aplicar o mês. Testes literais distinguem Casa1 de
Casa2 na previsão(650/350) e no recebido(9000/4000), incluindo o rótulo.

Cinco regressões novas primeiro vermelhas;617/617 adversariais. Suíte completa,
frontend/API typechecks e build verdes. Demais contagens preservadas. Tudo
local, sem chamadas pagas/publicação/APK. NOT READY até auditoria independente.

## 28/10/2026 — Fatura não perde data ou mês na proposta

Depois34fc8a0, a sonda mostrou "paguei200 da fatura do Inter de setembro"
e "paguei200 da fatura do Inter ontem" propondo card-payment sem data ou
referência: o executor usaria hoje/mês atual. O contrato contém só cartão e
valor. Agora registro com informação temporal que não pode ser preservada
recebe explicação local, sem proposta e sem remoto. O exame usa a cláusula
do pagamento: "paguei a fatura do Nubank e vou pagar a do Inter amanhã"
continua propondo somente o pagamento feito, como antes. Pagamento simples
de hoje continua proposto. Não foi criada seleção de mês pelo chat.

Quatro testes novos;621/621 adversariais, suíte completa, typechecks e build
verdes. Rubrica permanece0 perigosa/ruim. Só uso local, sem chamadas pagas,
publicação ou APK. Ainda NOT READY até auditoria independente.

Pendência nova para próxima janela: extrator em nlp.ts reconhece dinheiro só
logo após paguei/pagar/quitei para card-payment. Valor ao fim pode ser perdido
e virar pagamento integral; o exemplo com referência de novembro agora é
bloqueado, mas reproduzir sem referência antes de implementar correção.
Outras prioridades e ponto de retomada em docs/CODEX_RESUME.md. Última leitura
de uso:89% consumidos (11% restantes); iniciada gravação da pausa conservadora
para preservar reserva mínima5%. Retomada recorrente existente permanece ativa.

## 28/10/2026 — Valor parcial depois do nome da fatura

Em27940a7, "paguei a fatura do Inter 200" era proposto como pagamento do
valor pendente inteiro. Com fatura sintética de R$300, confirmar descontava
R$300 e quitava a parcela, embora a frase tivesse R$200. A variante com R$
ainda confundia "Inter R" com o nome do cartão. Três formatos foram
reproduzidos vermelhos pelo orquestrador e executor reais: número simples,
R$ e "reais". Um contraste com número de conta também foi vermelho: o número
virava valor. O pagamento sem valor já funcionava e ficou como controle.

O extrator agora lê o valor no fim da frase e o remove antes de reconhecer o
cartão. O número só é valor quando vem imediatamente depois do nome do cartão
ou da palavra "fatura". Informação numérica adicional sem esse formato não
gera proposta local, evitando pagamento indevido. O teste real confirma saldo
R$800 e pendência R$100 após pagar R$200 da fatura de R$300; sem valor
explícito, continua possível pagar a fatura inteira.

Cinco regressões novas;626/626 adversariais, suíte completa, typechecks
frontend/API, build e rubrica passaram. Sem chamada paga, publicação ou APK.
V2 continua NOT READY até auditoria independente. Próximas prioridades em
docs/CODEX_RESUME.md.

## 28/10/2026 — Previsão de receita na semana

Após c30f413, "quanto vou receber esta semana?" usava o período realizado
dos últimos sete dias. O planejamento recortava o passado em hoje, resultando
em uma janela de um dia; uma entrada sintética de R$650 amanhã desaparecia e
a resposta dizia que não havia previsão. "Quanto vai entrar essa semana?"
reproduziu o mesmo erro. Dois testes novos foram vermelhos; o contraste
"quanto recebi esta semana?" ficou verde com R$9000 realizados ontem.

Agora a modalidade de previsão dá a "esta semana" uma janela explícita de
hoje até seis dias à frente, rotulada "nos próximos 7 dias". A pergunta de
receita realizada continua nos últimos sete dias. Três regressões novas,
629/629 adversariais; suíte completa, typecheck frontend e build passaram.
Sem rede paga, publicação ou APK; V2 permanece NOT READY até auditoria.

## 28/10/2026 — Backup com quitação datada no futuro

Após b225bde, um backup sintético com fatura de R$300, pagamento registrado
para amanhã e parcela marcada paga mostrava fatura quitada, dívida zero e
limite livre hoje. O saldo já não descontava R$300 antes da data: os números
se contradiziam. O mesmo acontecia com quitação direta da parcela. Testes
vermelhos cobriram essas duas classes e plano marcado `settled` pelo backup.

Os cálculos de fatura, parcela, dívida, limite e progresso agora contam apenas
pagamentos até hoje, incluindo parcelas parciais com histórico misto de hoje e
amanhã. O registro bruto não foi apagado nem migrado. A consulta pelo
orquestrador diz R$300 pendentes; a tela de parcelamento sinaliza a data
futura e impede "Antecipar"/"Quitar tudo" nesse plano antes de reconciliar.
O plano com status `settled` só volta à dívida se houver evidência de pagamento
futuro; o invariante que exclui planos quitados comuns permanece válido.

A correção de leitura expôs outra rota: pagar a fatura hoje duplicaria o
registro futuro quando a data chegasse. Dois REDs novos cobriram executor e
reducer com pagamento futuro da fatura e pagamento direto futuro da parcela.
O formulário também desabilita salvar e mostra a data; executor e reducer
recusam a nova quitação até o registro futuro ser reconciliado.

Sete regressões novas; 636/636 adversariais. Suíte completa, typechecks e
build passaram; rubrica anterior permanece 0 perigosa/ruim (não houve mudança
na redação das respostas usuais). A tela nova ainda pede smoke visual local.
Sem rede paga, publicação ou APK. V2 segue
NOT READY até auditoria independente.

## 28/10/2026 — Fatura anterior pendente torna mês implícito ambíguo

Após b1efa8e, uma fatura sintética anterior de R$300 e a atual de R$200
estavam abertas. "Paguei a fatura do Inter" propunha pagar a atual e o
executor a quitava, sem evidência de que esse era o mês referido. O novo RED
passou pelo orquestrador e executor reais. O chat agora verifica se existe
fatura anterior efetivamente pendente, explica a ambiguidade e não propõe
pagamento; o executor também rejeita uma proposta que chegasse por outra
rota. A tela de cartões segue capaz de escolher explicitamente o mês.

Os controles antigos usavam uma fixture rica com parcelas pendentes de meses
anteriores e pressupunham que o pagamento fosse da fatura atual. Esses
controles passaram a reconciliar somente as faturas antigas dentro do teste,
preservando a verificação de que pagamento corrente inequívoco é proposto.
637/637 adversariais; suíte completa e invariantes verdes. Nenhuma chamada
paga, publicação ou APK; V2 continua NOT READY até auditoria independente.

## 28/10/2026 — Smoke local da Home e da data da fatura

Em servidor local isolado, onboarding e dados de demonstração foram usados
sem dados financeiros reais. A Home exibiu aviso de contas vencidas sem
confirmação e não afirmou que o saldo cobria os compromissos. Um cartão
fictício "Inter Teste" com fatura inicial de R$300 apareceu como R$300 de
limite comprometido e R$700 disponível sobre limite R$1000. No formulário
de pagamento, a data de amanhã desabilitou "Registrar pagamento" e explicou
que só se registra pagamento já ocorrido; data vazia também ficou bloqueada.
Nenhum pagamento foi confirmado. O navegador de teste e servidor local foram
encerrados. O aviso visual para backup com pagamento futuro permanece sem
smoke; cálculos/reducer/executor dessa classe têm regressões automáticas.

## 28/10/2026 — Conta fixa paga pelo chat não duplica a Home

Com Internet de R$120 vencendo hoje e saldo R$1000, o orquestrador real
propunha uma despesa avulsa para "paguei 120 da internet". O executor a
salvava sem recurringId/occurrenceDate: saldo R$880, mas a Home ainda pedia
confirmação. Confirmar lá pelo reducer criava uma segunda saída, saldo R$760.
O teste vermelho reproduziu as duas rotas e a divergência entre registro e
ocorrência.

Quando a descrição da despesa coincide com o nome de uma conta fixa cuja
ocorrência está em aberto, o chat agora não propõe despesa avulsa e orienta
confirmar pela tela inicial. O executor também recusa proposta antiga ou de
outra rota. Aviso adiado não contorna a barreira; outra despesa no mesmo lote
continua proposta. A Home confirma a conta uma vez, com saldo R$880 no caso.
Não houve migração nem reconciliação automática de lançamentos antigos sem
vínculo: eles ainda podem duplicar se o usuário confirmar de novo na Home.
Essa reconciliação precisa de escolha explícita antes de atrelar um registro
antigo à ocorrência. Nomes diferentes não são associados por aproximação.

641/641 adversariais; 666/666 corpus, 99/99 consulta/cenário, 50/50
semânticos, 4.088 + 3.800 metamórficos, 1.416 fuzz, 151/151 invariantes e
468/468 avaliações remotas offline. Typechecks frontend/API e build verdes.
Sem chamada paga, reset, push, merge, deploy ou APK. V2 segue NOT READY para
merge/deploy até auditoria independente.

## 12/11/2026 — Retomada no Linux: relógio dos testes e defeitos de calendário

Estado encontrado: a branch só existia no disco do Windows (HEAD `9bc0457`,
167 commits à frente da `main`, nunca enviada); clonada para `~/work/assistfin`.
A baseline de 28/10 NÃO se reproduzia em 12/11: 18 regressões adversariais
vermelhas e 1 RUIM na rubrica, porque o roteador antigo lê o relógio real e os
oráculos foram escritos para o dia 28. Rodando a mesma suíte em sete datas,
apareceram defeitos reais do app e oráculos presos ao calendário.

Defeitos reais corrigidos (cada um com regressão de data fixa):
- "Quanto preciso deixar parado até dia 22" no dia 12 perguntava "o dia 22
  deste mês ainda não chegou?" — a regra do "dia N" seco engolia o prazo antes
  do roteador de caixa; só funcionava quando o dia já tinha passado. `dates.ts`
  lê "até/pro/para o/antes do dia N" como PRAZO (próximo dia N).
- "Meu salário cai dia 5" nos dias 1–4 virava a mesma pergunta de data:
  recorrência não tem data a esclarecer (`clauses.ts`).
- Média mensal no último dia do mês contava o mês corrente como completo
  (`runQuery` recebe `today`; o mês de hoje nunca fechou).
- `savedThisMonth` contava depósito com data futura como "guardado de verdade".
- "Vale a pena rodar domingo?" contava um domingo só com troca de óleo como dia
  trabalhado de lucro negativo; agora dia trabalhado exige entrada ou registro
  de trabalho.
- Consulta por nome sem período ("quanto gastei com troca de óleo") dizia só
  "nada este mês"; agora diz também o último lançamento fora do período
  (`period.implicit`, só quando o período foi assumido; o número continua zero).

Suíte: `tests/clock.ts` congela o relógio (`ASSISTFIN_TODAY`, padrão
2026-09-15; `real` usa a máquina) e `npm run test:calendario` roda a bateria
em seis datas. Oráculos que dependiam do dia (contas do mês, faturas abertas x
fechadas, domingo sem registro, dia 1º sem gasto, ano anterior com dado) agora
calculam o esperado a partir do fixture e da data. Limitação conhecida: no dia
1º a bateria adversarial ainda tem ~40 oráculos degenerados (fixture sem gasto
no mês) e não entra na matriz.

Gates em 12/11 (relógio 2026-09-15): 666/666 corpus, 99/99, 50/50, 654/654
adversariais, 4.088 + 3.800 metamórficos, 1.416 fuzz, 151/151 invariantes,
468/468 offline; typecheck, typecheck:api, build. Sem push, merge, deploy, APK
ou chamada paga. Continua **NOT READY** até auditoria independente.

## 12/11/2026 — Conta fixa pelo chat e auditoria com as frases da missão

`recurring-confirm` (regra 65): "paguei 120 de luz" com Luz em aberto propõe a
confirmação da ocorrência; "paguei a luz" usa o valor cadastrado; segunda
confirmação recusada; desfazer reabre; despesa avulsa antiga continua recusada
no executor. A RUIM da rubrica sumiu (0 perigosa, 0 ruim).

Auditoria independente: as frases do prompt da missão, pelo orquestrador real,
offline, lidas uma a uma (sonda no scratchpad, fora do repositório). Cada
achado virou caso `MI-` em `adversarial-real.ts`, vermelho antes da correção:
- correção falada "a feira foi 150, não 180" editava um Cimento de agosto
  (casava só pelo valor) — o sujeito nomeia o lançamento; sem ele, não corrige;
- "se a gasolina aumentar 12% e eu rodar 20% mais km" virava "Resultado este
  mês (dado real)" — hipótese sem "eu" é hipótese;
- "se eu rodar mais 100 km, quanto devo gastar de combustível" respondia com
  receita/km — agora custo pelo consumo e preço registrados;
- "já tenho 4.800 na viagem, se eu guardar 350 por mês" lia 4.800 — o valor
  é o que acompanha o verbo;
- "tenho 1.800 hoje, preciso pagar 950… quanto ainda preciso ganhar?" era
  "isso ainda não aconteceu" — conta declarada, com a origem dos números;
- "quanto preciso separar por semana" respondia por mês;
- "cara, tô ferrado esse mês?" caía no menu — rota do "tô no vermelho" mais
  os compromissos próximos;
- "por hora de verdade" virava filtro "verdade";
- "e na passada?", "sem contar terça", "agora compara com alimentação"
  perdiam o assunto — elipse de período, exclusão de dia da semana e duas
  categorias lado a lado;
- "quanto gastei com combustível…, e quanto isso representa" respondia "não
  tenho lançamento" — a primeira é respondida, a segunda dita como não lida;
- preferências de análise ("considera sempre uma reserva de 300", "prefiro
  líquido") eram respondidas como pergunta ou menu — ditas como não guardadas;
- "quero diminuir meus gastos com gasolina" era "isso não aconteceu";
- "fiz 350 de uber" perdia a plataforma; "gastei 120…, não, pera, foram 102"
  perguntava pelos 120.

Lidos e deixados como estão, com registro: "fiz 250 na 99" infere 1 viagem
(decisão de produto pendente desde 28/10); "recebi 500, mas 100 eram
reembolso" propõe 500 e pergunta pelos 100; "se eu trabalhar mais dois dias por
semana" e "se eu adiar a compra em dois meses" são declarados não simuláveis;
"quanto meu carro custa por km" responde o gasto registrado ÷ km do mês, não
o `kmCost` completo.

Gates: 666/666, 99/99, 50/50, 679/679 adversariais, metamórficos, fuzz,
151/151 invariantes, 468/468 offline, typechecks, test:money, build, rubrica e
`test:calendario` (seis datas) verdes. Commits locais; sem push, merge, deploy,
APK ou chamada paga. NOT READY até auditoria independente.

## 19/11/2026 — Revisão das confirmações e cobertura de cenários

- Contas fixas pedem seleção quando há mais de uma ocorrência candidata.
  A proposta preserva a identidade do vencimento e valida a data no
  executor. Repetir uma conta atrasada no dia seguinte ficou protegido.
  Duas descrições do mesmo pagamento no lote viram uma proposta. Valores
  divergentes pedem esclarecimento.
- Planejamento com valores declarados mantém a proposta de uma operação
  independente. Saldo negado ou conta sem valor pede esclarecimento.
  Correções faladas com nome composto, sem artigo ou entre aspas exigem
  a correspondência com o lançamento.
- Cenários locais incluem mudanças percentuais de combustível e km, preço
  informado por litro, volume de combustível, manutenção cadastrada e
  dias adicionais por semana. A amostra e as hipóteses são apresentadas na
  resposta. Adiar uma compra desloca entrada e parcelas. Um valor de meta
  informado para a simulação fica isolado do acumulado salvo.
- Consultas encadeiam proporções sobre totais realizados, separam compras
  registradas e faturas pelo vencimento e calculam média mensal apenas
  com meses completos. A fatura aberta informa o saldo pendente quando o
  usuário pergunta o que falta pagar daquele cartão.
- Matriz de oito datas com movimento no dia 1º, tanto em domingo quanto
  em dia útil. Smoke no Chrome com dados fictícios cobriu confirmação,
  edição, recarga, atraso, orçamento, cenários e um pagamento legado
  com data futura. A revisão independente, o remoto real e o APK seguem
  pendentes. A branch permanece NOT READY.
- Depois de comparar dois meses, "por quê?" usa os dois valores e a
  diferença. Para rankings, explica o mês ou a semana em destaque e aplica
  os filtros da pergunta, inclusive em "em qual mês eu gastei mais com
  obra?". Um período sem registros não é tratado como vencedor.
- O custo atual por km no chat usa o mesmo cálculo da tela Veículo, com
  combustível, desgaste e fixos. Uma pergunta que dá o período divide o
  gasto realizado pelas distâncias registradas no mesmo período. A falta
  de km impede o cálculo ou a comparação, inclusive em "meu custo por km
  piorou?".
- A suíte comum e a execução na data da máquina passaram com 722/722
  regressões adversariais. A matriz de oito datas em America/Sao_Paulo,
  os typechecks, o teste de dinheiro, o build e a rubrica passaram
  (zero PERIGOSA e zero RUIM). No Chrome, um backup sintético validou
  importação inválida, cancelamento, mescla sem duplicidade e restauração
  após confirmação. O pagamento legado com data futura ficou bloqueado
  após importar pela tela de Configurações.

## 19/11/2026 — Reembolsos e restauração de backups

- Reembolsos recebidos ficam em Outros e não criam viagens no perfil
  motorista. Se parte de uma entrada é reembolso, o chat confirma a
  composição antes de propor as duas movimentações. O caixa recebe o
  valor total uma vez. Data incerta, valor incompatível, mais de uma
  origem possível e recebimento pendente pedem esclarecimento.
- Para distinguir a devolução no histórico, a entrada traz a descrição
  Reembolso. Continua sendo uma entrada nos totais gerais. Vincular um
  reembolso à despesa original depende de uma definição contábil do app.
- Mesclar um backup insere cada ID novo uma vez e conserva a versão já
  presente quando há conflito. Recarga e restauração preservam o texto
  das conversas antigas e descartam propostas e escolhas pendentes.
  No Chrome, o backup fictício com ID repetido e linha nula foi importado
  e restaurado sem duplicidade e sem reativar botões antigos do chat.
- A suíte passou com 727/727 regressões adversariais no relógio padrão
  e na data da máquina. A matriz de oito datas e duas execuções extras
  no primeiro dia do ano e em 29 de fevereiro passaram, assim como os
  typechecks, o teste de dinheiro, o build e a rubrica. No Chrome, o
  desfazer reverteu as duas entradas do mesmo lote de reembolso.

## 19/11/2026 — Pagamento de faturas pelo chat

- O chat verifica o pagamento pelo cartão, vencimento, data e valor.
  Repetições e valores acima do saldo pendente ficam bloqueados na
  proposta e na execução. O fluxo manual tem sua própria confirmação
  de pagamento acima do pendente.
- Mês de vencimento e data do pagamento são tratados separadamente.
  A consulta de quanto falta usa a fatura citada e mostra o saldo após
  a confirmação quando a mensagem também inclui um pagamento.
  Pagamentos retroativos preservam a ordem de quitação das parcelas.
- No Chrome, um pagamento retroativo para uma fatura anterior manteve
  a fatura atual intacta. Repetir a mesma mensagem após recarregar não
  abriu outra proposta. A suíte passou com 738/738 regressões reais.
  Typechecks, build e rubrica local passaram. A branch permanece NOT READY.

## 19/11/2026 — Escolha da fatura no chat

- Quando há mais de um vencimento ou cartão possível, o chat oferece
  as faturas abertas com mês, ano e saldo. Cartões de mesmo nome mostram
  o final cadastrado. A escolha mantém a data e o valor informados e
  prepara uma proposta para confirmação.
- A execução confere o ID do cartão e o vencimento da proposta. Cartão
  arquivado e valor atualizado acima do pendente bloqueiam o registro.
  Corrigir o cartão troca a vinculação e revalida a mesma referência.
- No Chrome, escolhi uma fatura antiga junto de um gasto de mercado e
  confirmei os dois. Em outro perfil de teste, a opção de final 5678
  registrou o pagamento no segundo cartão de mesmo nome. A suíte passou
  com 741/741 regressões reais no relógio padrão. Typechecks, build,
  matriz de oito datas e rubrica passaram. A branch permanece NOT READY.

## 19/11/2026 — Vínculo de lançamentos com contas fixas

- A Home e o chat oferecem vincular um lançamento parecido ou informar
  um pagamento separado. O vínculo mantém valor, data, categoria, origem
  e saldo do lançamento original. Confirmações repetidas e vínculos
  vencidos são recusados pelo executor compartilhado.
- A conclusão de uma ocorrência usa uma única operação. O mês quitado
  por um backup legado continua resolvido quando a primeira ocorrência
  nova é registrada.
- O histórico de desfazer agora guarda os campos que antes estavam
  ausentes. Após recarregar, desfazer um vínculo reabre a conta e
  preserva o lançamento. Desfazer um ajuste de saldo também remove
  a âncora se o saldo original não tinha uma.
- No Chrome, o vínculo funcionou pela Home e pelo chat com dados
  fictícios. O desfazer após recarga deixou o lançamento original
  no extrato e a conta em aberto. Suíte com 745/745 regressões reais,
  typechecks, build e rubrica passaram. A branch permanece NOT READY.

## 19/11/2026 — Extrato e ocorrências vinculadas

- A consulta de conta fixa usa o valor atual do lançamento. Corrigir de
  R$ 120 para R$ 135 atualiza a resposta do chat e mantém a mesma
  ocorrência quitada.
- Remover o lançamento pelo extrato reabre o vencimento correspondente.
  Desfazer no aviso restaura o mesmo lançamento, com data, hora e
  vínculo originais. Se a ocorrência já recebeu outra baixa, a
  restauração fica bloqueada.
- O fluxo de remoção e desfazer passou no Chrome. A suíte passou
  com 747/747 regressões reais, typechecks e build.

## 19/11/2026 — Baixas futuras de contas fixas

- Uma baixa importada com data futura mantém a ocorrência em aberto
  até a data da movimentação. Home e chat mostram o aviso e bloqueiam
  outro pagamento para o mesmo vencimento. O planejamento continua
  considerando a conta.
- Adiar o lembrete na Home mantém o vencimento nos cálculos de cobertura.
  Um saldo de R$ 100 com uma conta vencida de R$ 120 sem confirmação
  deixa de produzir uma conclusão de cobertura.
- Restauração de backup fictício validada no Chrome. A suíte passou
  com 750/750 regressões reais no relógio padrão. Matriz de oito datas,
  typechecks, build e rubrica local passaram. A branch permanece NOT READY.

## 19/11/2026 — Valor da quitação mostrado na confirmação

- Uma fatura sem pendente fica sem proposta de pagamento. Se Cartões
  já mostra a próxima fatura, o chat pede escolher o mês explicitamente.
- A proposta integral mostra o valor da dívida. Se o pendente mudou
  entre a proposta e a confirmação, o executor pede o valor que foi
  pago. O valor exibido fica no contrato local.
- No Chrome, confirmar R$ 20 deixou uma proposta anterior de R$ 300
  pendente de revisão quando o saldo caiu para R$ 280. Suíte com
  752/752 regressões reais no relógio padrão, typechecks, build e rubrica.

## 19/11/2026 — Fatura e despesa na mesma frase

- “Paguei 80 da fatura e cinquenta no mercado” mantém as duas ações
  e a data comum quando informada. O nome do cartão fica na fatura.
- Valores que podem ser juros ou outro pagamento da mesma fatura
  pedem esclarecimento. Datas concorrentes sem vínculo claro são
  esclarecidas antes da proposta.
- Suíte com 754/754 regressões reais no relógio padrão, matriz de
  oito datas, typechecks, build e rubrica local passaram.

## 19/11/2026 — Calendário de registros e consultas

- Datas ISO completas mantêm dia e mês. Consultas por dia em ISO ou
  formato brasileiro e intervalos ISO usam o período solicitado.
- Dias inexistentes em registros e consultas pedem uma data válida.
  Sugestões de data só exibem dias que existem no mês ou ano em
  questão. Prazo de caixa até o fim do mês mantém o último dia.
- O contrato recusa datas inválidas também em períodos de comparação.
  A suíte passou com 758/758 regressões no relógio padrão e oito datas
  na matriz. A execução bissexta em America/New_York e o pagamento com
  data ISO no Chrome passaram, assim como typechecks, build e rubrica.

## 19/11/2026 — Confirmação de datas ambíguas

- O chat guarda o registro enquanto pede a data. Escolher um dia válido
  recupera valor e descrição. A opção futura segue para esclarecimento.
  Registros independentes permanecem disponíveis para confirmação.
- “Depois do dia 10” abre uma janela a partir do dia 11. Informar um
  valor em reais ou escolher um dia fora da janela mantém a pergunta.
  Uma data anterior de outro registro não substitui período indefinido.
- O Chrome guardou R$ 50 na data selecionada e R$ 30 de padaria no dia
  originalmente dito. A suíte padrão passou com 761/761 regressões
  reais. A branch permanece NOT READY.

## 19/11/2026 — Histórico de pagamentos de fatura

- Período de pagamento filtra a data do desembolso. Referência da
  fatura filtra o vencimento. As duas condições podem ser usadas
  juntas. Cartões arquivados continuam consultáveis no histórico.
- O total por período usa pagamentos com data válida registrada.
  Ao consultar um vencimento específico, a resposta pode informar
  o valor quitado sem data quando essa for a evidência disponível.
- No Chrome, um pagamento de R$ 80 feito neste mês ficou na fatura
  do mês anterior. Os totais por data foram R$ 100 neste mês e R$ 45
  no mês anterior. Suíte com 762/762 regressões reais, matriz de oito
  datas, typechecks, build e rubrica local passaram.

## 19/11/2026 — Datas do caixa, orçamento e extrato

- O formulário de movimentação recusa data vazia, inválida ou futura.
  Registros retroativos sem hora informada conservam apenas a data,
  sem mexer retroativamente num saldo já informado depois daquele dia.
- Relatórios de valores realizados, orçamento, métricas de trabalho e
  totais do Extrato consideram os lançamentos até hoje. Um registro
  futuro importado permanece disponível para conferência no Extrato.
- No Chrome, a data futura manteve Salvar desabilitado, e uma despesa
  retroativa deixou o saldo informado em R$ 1.000. Suíte com 764/764
  regressões reais, matriz de oito datas, typechecks, build e rubrica.

## 19/11/2026 — Compra e entrada financiada no formulário

- Compra e entrada financiada exigem a data em que aconteceram. O
  primeiro vencimento pode ser futuro.
- O formulário de financiamento registra o plano, as parcelas e a
  entrada de caixa em uma operação. O saldo sobe pela movimentação,
  uma vez. No Chrome, uma entrada líquida de R$ 80 levou R$ 1.000 a
  R$ 1.080 sem gerar receita.
- A suíte passou com 765/765 regressões reais no relógio padrão,
  typechecks, build, rubrica e teste de dinheiro. A branch permanece
  NOT READY. A forma antiga pode ter duplicado entradas no saldo já
  salvo. Esses dados exigem conferência antes de uma correção retroativa.

## 19/11/2026 — Parcelas já pagas no cadastro

- Parcelas informadas como pagas reduzem o saldo devedor sem usar a
  data de vencimento como data de pagamento. O valor do caixa segue
  o saldo informado e os movimentos com data de pagamento.
- No Chrome, um acordo de R$ 100 em duas parcelas guardou uma
  parcela de R$ 50 como paga, sem data, e manteve o saldo de R$ 1.000.
- A suíte passou com 766/766 regressões reais no relógio padrão.
  Typechecks, build, teste de dinheiro, rubrica e teste bissexto
  em Europe/Lisbon passaram. A branch permanece NOT READY.

## 20/11/2026 — Data no detalhe de parcelas pagas

- O detalhe mostra “paga · data de pagamento não informada” quando
  o histórico guarda a quitação sem a data. O Chrome confirmou que
  o vencimento de amanhã deixou de aparecer como data do pagamento.
  Typecheck e build passaram.

## 20/11/2026 — Exclusão de uma entrada financiada

- O formulário e o chat vinculam a entrada do extrato ao plano. A
  exclusão pelo detalhe do plano remove os dois juntos. Pagamentos
  registrados no financiamento ou nas faturas impedem a exclusão
  até a conferência desses lançamentos.
- Financiamento antigo sem vínculo pede escolher o lançamento que
  corresponde à operação. O Chrome confirmou que a outra entrada
  de mesmo valor ficou no extrato.
- Suíte com 768/768 regressões reais, matriz de oito datas, typechecks,
  build e rubrica passaram. A branch permanece NOT READY.

## 20/11/2026 — Cancelar só as parcelas futuras

- Cancelar futuras mantém as parcelas vencidas, as de hoje e as que
  já têm pagamento direto ou de fatura. O plano e as parcelas mudam
  juntos. Se restar dívida, o plano continua ativo.
- Parcelas antigas pagas continuam na fatura depois que o plano é
  encerrado, inclusive no histórico legado com status cancelado.
- No Chrome, cancelar a parcela futura de uma compra de R$ 300
  deixou R$ 200 pendentes. A suíte passou com 770/770 regressões
  reais, typechecks, build e rubrica.

## 20/11/2026 — Quitação de parcelas com pagamento parcial

- O saldo das parcelas determina o estado do plano. Registro legado
  de R$ 40 numa parcela de R$ 100 mantém R$ 60 a pagar, inclusive se
  o plano ou a parcela vierem marcados como quitados.
- A quitação aplica todas as baixas juntas. Um pagamento futuro no
  histórico direto bloqueia nova baixa. A antecipação seleciona só
  vencimentos após hoje.
- O Chrome confirmou a baixa de apenas R$ 60, o bloqueio da segunda
  baixa e a antecipação de um único vencimento futuro. Suíte com
  772/772 regressões reais, 151 invariantes, typechecks, build e rubrica.

## 20/11/2026 — Desfazer sem apagar mudanças posteriores

- O registro de auditoria confere as entidades novas e os campos que
  o lote alterou. Mudanças posteriores nesses dados bloqueiam a reversão.
  Alterações em campos diferentes continuam preservadas.
- Pagamentos posteriores ligados a um plano bloqueiam a remoção pelo
  chat. Pagamentos que já existiam antes do lote seguem no histórico.
- No Chrome, desfazer uma entrada intacta removeu a entrada e o plano.
  Uma parcela paga bloqueou tanto a proposta quanto a confirmação feita
  depois da baixa. Suíte com 775/775 regressões, 151 invariantes,
  typechecks, build e rubrica passaram.

## 20/11/2026 — Faturas de cartões arquivados

- Arquivar um cartão retira o limite disponível e os atalhos de compra.
  Faturas, histórico, vencimentos e projeções continuam usando o mesmo
  valor em aberto. Consultas e simulações do assistente leem a fatura
  arquivada; a baixa pode ser registrada na tela do cartão.
- A projeção e os compromissos também usam o saldo de parcelas avulsas
  pagas parcialmente em backups legados.
- O Chrome preservou os R$ 150 que faltavam na fatura e confirmou a
  quitação pela tela. Suíte com 777/777 regressões, 151 invariantes,
  typechecks, build e rubrica passaram.

## 20/11/2026 — Datas impossíveis em históricos importados

- Uma data inválida não movimenta caixa, não reduz a fatura e não
  entra nos totais do extrato, consultas, orçamentos ou relatórios.
  Os registros permanecem no histórico, com indicação de conferência.
- O Chrome mostrou os dois lançamentos do teste e somou apenas os
  R$ 17 do dia válido. Uma baixa inválida deixou a parcela em aberto.
- Suíte com 779/779 regressões, matriz de oito datas, 151 invariantes,
  teste de dinheiro, typechecks, build e rubrica passaram.

## 20/11/2026 — Negação e erro de digitação no chat

- O chat separa o fato afirmado da baixa negada na mesma mensagem. A
  abreviação “n” e o reparo de verbos como “gsatei” preservam a negação.
- No Chrome, “n gsatei 37” ficou sem proposta. Em “n gastei 37 no
  mercado mas receby 120 da Casa 2” a confirmação gravou só a receita.
  O teste com o canal remoto simulado comprovou que não houve chamada.
- Seis casos novos entre corpus e regressões, 780/780 regressões reais,
  151 invariantes, avaliação remota offline, typechecks, build e rubrica.

## 20/11/2026 — Correções dentro de uma mensagem do chat

- “Ops”, “não, foi”, “perdão” e “quer dizer” podem corrigir valor,
  estabelecimento, origem ou data. Uma correção sem informação suficiente
  espera uma resposta. “Esquece essa” retira o lançamento citado.
- No Chrome, a confirmação gravou R$ 75 na padaria e R$ 20 de ônibus.
  Outra conversa gravou R$ 900 da Casa 1 e manteve fora a compra retirada.
- Nove casos novos entre corpus e regressões. Suíte com 781/781
  regressões reais, 151 invariantes, typechecks, build e rubrica.

## 20/11/2026 — Escolha de valor ou data antes de registrar

- O chat pergunta qual é o valor quando o usuário relata alternativas
  como “29 ou 31” ou escreve os valores por extenso. Pode receber “foi
  31” e manter os outros registros da mensagem na proposta.
- “Segunda ou terça” e “dia 3 ou 4” viram escolhas de data, sem criar
  valor ou selecionar um dia pelo usuário. Uma data futura continua
  sem baixa realizada.
- O Chrome confirmou os dois fluxos. Suíte com 783/783 regressões,
  matriz de oito datas, 151 invariantes, typechecks, build e rubrica.

## 20/11/2026 — Planos abandonados e pagamentos concluídos

- “Ia pagar”, “quase gastei” e uma compra abandonada ficam como
  contexto. “Acabei de pagar”, “terminei pagando” e “acabei de receber”
  preservam a movimentação relatada e sua negação, quando houver.
- O chat aceita “exatamente” e “certinho” junto ao valor, preserva
  acentos da descrição e entende “na real” como correção após uma pausa.
- O Chrome confirmou a saída de R$ 95 pelo tênis, sem criar meta para a
  bota, e os R$ 37,50 do mercado. Suíte com 785/785 regressões,
  151 invariantes, typechecks, build e rubrica.

## 20/11/2026 — Centavos e valores incompletos

- “100 e pouco”, “quase 50” e “mais de 100” pedem o valor exato.
  A resposta curta recupera origem, categoria e data, e mantém os outros
  registros que já estavam na proposta. “Uns 50” vem identificado como
  aproximado na proposta.
- “50 e 5 centavos” vira uma única despesa de R$ 50,05. O Chrome
  confirmou esse caso e a receita de R$ 105,50 após a resposta curta.
- Suíte com 786/786 regressões, 151 invariantes, typechecks, build e
  rubrica passaram.

## 20/11/2026 — Consultas pelos dias da semana

- “Na segunda”, “segunda versus terça” e “entre segunda e terça”
  usam os dias correspondentes na consulta. “Seg ou ter” pede a
  escolha do dia e guarda o filtro da pergunta original.
- Uma proposta independente permanece na tela enquanto o usuário
  consulta um dia. O Chrome confirmou os valores de R$ 87 e R$ 172
  na comparação e R$ 35 na padaria após escolher terça.
- Suíte com 788/788 regressões, 151 invariantes, avaliação remota
  offline, typechecks, build e rubrica passaram.

## 20/11/2026 — Perguntar e registrar na mesma frase

- A consulta e o comando “anota”, “registra” ou “lança” ficam em
  cláusulas próprias. Categoria e data da consulta não são herdadas pela
  despesa que o usuário pediu para registrar.
- No Chrome, “me lembra quanto eu gastei este mês e anota que paguei 25
  na padaria” mostrou o total condicional de R$ 175. Consultar o dia 3
  em outra mensagem não mudou a data da nova despesa de ônibus.
- Suíte com 789/789 regressões, 151 invariantes, typechecks,
  build e rubrica passaram.

## 20/11/2026 — Consultas de dois dias e revisão de fala real

- “Segunda e quinta” consulta apenas os dois dias citados. Se o usuário
  pede separadamente, o chat mostra o valor de cada dia.
- O Chrome confirmou R$ 1.086 de segunda e quinta, sem incluir terça.
- A matriz adicional de fala espontânea passou com 672/672 variações
  de data, valor, origem, negação, correção e continuação. A suíte padrão
  passou com 790/790 regressões, 151 invariantes, typechecks, build e rubrica.

## 20/11/2026 — Reformulação de um valor negado

- “Não foi 90, foi 75 que gastei na padaria” propõe só a despesa de
  R$ 75. A proposta só é criada quando a segunda parte diz o que ocorreu.
- Três casos de corpus, suíte com 790/790 regressões, 151 invariantes,
  typechecks, build e rubrica passaram. A matriz adicional de consultas
  passou com 64/64 casos em oito datas.

## 20/11/2026 — Correção de uma proposta em outro turno

- O chat separa o dado negado do afirmado antes de editar o cartão.
  Com “não foi 90, foi 75 que gastei na padaria”, corrige tanto o
  valor como o lugar, e usa a data afirmada em “não foi anteontem,
  foi ontem”.
- Quando dois lançamentos têm o valor negado, o cartão anterior é
  retirado e o chat pede a seleção. O Chrome confirmou que só havia
  um cartão depois da escolha e que só o registro escolhido mudou.
  Também confirmou correção de origem sem perder a categoria.
- 11 novos casos no corpus, suíte local completa, 151 invariantes,
  avaliação remota offline, typechecks, build e rubrica.

## 20/11/2026 — Opções na correção de uma proposta

- Se o usuário corrige um valor, uma data ou uma origem com “ou”, a
  proposta fica suspensa até ele escolher. Uma resposta inconclusiva
  mantém a pergunta disponível. A parte em comum, como “na padaria”, é
  preservada para os valores alternativos.
- O Chrome confirmou a escolha de R$ 80 por mensagem, a escolha da
  Casa 2 pelo botão e a data “ontem” depois de “não sei”.
- O corpus incluiu mais oito casos. Suíte local, 151 invariantes,
  avaliação remota offline, typechecks e build passaram.

## 20/11/2026 — Digitação truncada e origem do relato seguinte

- Reconhece “rebcbi”, “reci bi” e “receebii” perto do valor em um relato
  financeiro. “Ñ” mantém a negação. Se o verbo continuar ilegível, a
  origem e a data do segundo valor ficam separadas da despesa entendida.
- “Esse mês msm” mantém o filtro pelo estabelecimento. O reparo de
  verbos preserva o nome digitado em “loja Rebcbi”.
- O Chrome confirmou os valores de R$ 37 e R$ 120 com datas distintas,
  descartou a receita negada e consultou o total exato de Mercado.
  O corpus acrescentou oito casos e passou com a suíte local, 151
  invariantes, avaliação remota offline, rubrica, typechecks e build.

## 20/11/2026 — Consultas com uma lista de dias

- “Quanto gastei dia 10 e 15” consulta duas datas, sem oferecer
  o registro de R$ 15. “Segunda, terça e quinta” consulta os três
  dias, e “quantos gastos” pede contagem de despesas.
- O Chrome confirmou R$ 72,50 nos dias 10 e 15, R$ 312,50 ao incluir
  o dia 12, três movimentações e duas despesas nos dois dias
  inicialmente citados. Os quatro lançamentos da base permaneceram.
- Suíte com 791/791 regressões reais, 151 invariantes, avaliação
  remota offline, typechecks e build.

## 20/11/2026 — Intervalos por dias e semana de calendário

- “Entre segunda e terça”, dito na terça, inclui a terça do próprio
  dia. “Segunda e quinta da semana passada” usa os dois dias da semana
  civil, de segunda a domingo. Intervalos numéricos reconhecem
  “de dia 10 a 15” e preservam o mês ou ano informado.
- Para um intervalo realizado com fim no futuro, “até ontem” recupera
  o começo e o filtro da consulta. Datas invertidas pedem esclarecimento.
- Chrome confirmou as datas, a retomada com filtro de padaria e a
  ausência de novos lançamentos. Matriz específica com 56/56
  verificações em oito datas e suíte com 792/792 regressões reais.

## 20/11/2026 — Acréscimo e confirmação parcial em conversa

- Um acréscimo como “e mais 20 de ônibus” substitui o cartão da
  proposta pelo lote acumulado. Um novo relato explícito com “e”
  também pode acrescentar receita ou despesa ao lote.
- Confirmar uma parte deixa apenas os itens que ainda precisam de
  confirmação disponíveis para correções pelo chat. Respostas que
  ficaram obsoletas enquanto a proposta mudou não reabrem itens
  confirmados ou editados na tela.
- O Chrome reproduziu dois cartões confirmáveis antes da correção e
  confirmou uma única gravação de cada item depois. Em outro lote,
  confirmou o almoço de R$ 33 e depois o café corrigido para R$ 15.
  A suíte completa manteve 792/792 regressões reais.

## 20/11/2026 — Continuação de Pix, corrida e devolução

- “Sim, mandei só 10 ontem” usa o valor e a data afirmados. “Não foi
  15, mandei 9” corrige o valor, e “ñ” ou “sim, mas não mandei” encerra
  a pergunta sem criar despesa.
- “Me pediram um Pix dia 10” trata o dia como data do pedido. Se a
  data informada para o envio ainda não chegou, o chat guarda os
  centavos e pede a data do pagamento. Consultas independentes também
  preservam a pergunta de confirmação.
- O Chrome confirmou os dois Pix corrigidos, o gasto independente
  e a ausência de registro na negativa. Suíte com 797/797 regressões,
  151 invariantes, avaliação remota offline, typechecks e build.

## 20/11/2026 — Continuidade ao voltar à tela do chat

- Ao voltar de Movimentações na mesma sessão, correções e respostas
  curtas voltam a apontar para a proposta e a pergunta ainda visíveis.
- O Chrome confirmou o gasto de R$ 75 após trocar de tela duas vezes.
  No recarregamento completo, a proposta pendente foi descartada,
  conforme a regra de reidratação, e o gasto já confirmado foi mantido.

## 20/11/2026 — Relatos enumerados sem repetir o verbo

- “Paguei 50 no mercado e a farmácia 20” prepara as duas despesas.
  “Ontem paguei mercado 55, farmácia 21 e freela entrou 260” mantém
  ontem nos três lançamentos. “Recebi da Casa 2 1.234,56 de aluguel”
  distingue o número do imóvel do valor.
- Se o relato de duas entradas termina em “e padaria 22”, pergunta
  se o último valor entrou ou saiu e preserva os dois recebimentos.
- O Chrome confirmou os dois lotes e a escolha de saída de R$ 22.
  Seis novos casos de corpus passaram com os testes locais, os
  typechecks, o build e a rubrica.

## 20/11/2026 — Distância e preço em corrida oferecida

- “Tocou corrida de 12 km por 70” guarda R$ 70 como valor a confirmar.
  Distância e duração sem preço não viram receita. Preços alternativos
  esperam o valor efetivamente recebido.
- “Recusei”, “n aceitei” e “não tocou” encerram a oferta.
- O Chrome confirmou R$ 70 e uma viagem sem copiar os 12 km como
  distância trabalhada. Suíte com 798/798 regressões reais e os
  typechecks, build, invariantes e avaliação remota offline passaram.

## 20/11/2026 — Direção e destino da devolução

- “A Uber me devolveu 20 no Pix ontem” propõe um reembolso recebido
  na data informada. “Paguei 30 no mercado e a loja devolveu 10 pra
  mim” preserva o gasto e a entrada separadamente.
- Estorno na fatura e devolução sem destinatário confirmado ficam
  em esclarecimento. Uma devolução negada não cria movimentação.
- Chrome confirmou a saída de R$ 30 e a entrada de R$ 10. Suíte com
  799/799 regressões reais, typechecks, build, 151 invariantes e
  avaliação remota offline. Rubrica com 0 respostas perigosas ou ruins.

## 20/11/2026 — Pedido e envio de Pix no mesmo relato

- “Pediu um Pix de 200 e eu mandei 35” propõe somente os R$ 35.
  A data do pedido não é usada como data do envio, e uma negativa
  encerra o pedido. “Mandei o print” continua sem ser confirmação.
- O Chrome confirmou R$ 35 e manteve a base sem movimentos adicionais.
  Suíte com 800/800 regressões reais, 151 invariantes, avaliação local,
  typechecks e build.

## 20/11/2026 — Pix recebido e transferência própria

- “Recebi Pix de 99 de João” mantém João como origem e R$ 99 como
  valor, sem criar corrida. “Me enviaram Pix” também distingue a
  entrada de um envio. Valor incompleto preserva a data na pergunta.
- Transferência entre contas próprias fica fora das despesas. O
  reparo de digitação preserva essa leitura.
- Chrome confirmou os Pix de R$ 99 e R$ 74,50, sem sessão de trabalho.
  Suíte com 801/801 regressões reais, 151 invariantes, typechecks,
  build e rubrica sem respostas ruins ou perigosas.

## 20/11/2026 — Exemplos, citações e quem pagou

- “Exemplo: gastei 80” e “o gerente falou ‘paguei 100’” ficam
  como contexto. “Eu disse que não paguei” conserva a negativa.
- “Eu paguei 80 na farmácia e meu irmão pagou 90” propõe só a
  despesa de R$ 80. Outro relato explícito após o exemplo também
  continua disponível para confirmação.
- A suíte ficou em 802/802 regressões reais. Os testes com transporte
  simulado verificaram esses trechos sem enviá-los a um serviço.

## 20/11/2026 — Ditado Web em partes e cancelamento

- O reconhecimento Web aguarda o fim da fala e junta os resultados
  finais. Cancelar, mandar texto enquanto o microfone está ativo ou
  sair da tela descarta o reconhecimento pendente.
- A suíte ganhou cinco verificações com reconhecedor simulado.
  No Chrome, com a API simulada em pt-BR, a transcrição de duas
  partes virou as propostas de R$ 37 e R$ 120. Cancelamento,
  navegação e permissão negada ficaram sem mensagem ou lançamento.
- A suíte manteve 802/802 regressões reais. O microfone físico e
  o reconhecedor do Android ficam para teste em dispositivo.

## 20/11/2026 — Recebimento explícito e retirada de propostas negadas

- “O cliente me pagou 200 ontem” e “o João me mandou um Pix” viram
  entradas com os dados ditos. “O Pix não caiu” conserva a pendência.
- “Foi só orçamento” retira a proposta. Uma negativa com valor e
  lugar retira o item correspondente. Empate pede a escolha e uma
  negativa sobre outro gasto preserva a proposta aberta.
- O Chrome verificou pagador, origem, recebimento pendente, retirada
  do orçamento, escolha entre valores iguais e correção restante.
  Suíte com 803/803 regressões reais, 151 invariantes e cinco testes
  de ditado. Matriz adicional com 640/640 casos em oito datas e
  quatro perfis, sem acionar o transporte remoto simulado.

## 20/11/2026 — Comandos citados com proposta aberta

- “Exemplo: cancela” e “o gerente falou ‘cancela’” preservam a
  proposta. Uma instrução afirmada em outra frase ainda pode
  corrigi-la. Uma pergunta já aberta continua disponível.
- O Chrome confirmou o gasto corrigido para R$ 75 depois das citações.
  O exemplo de desfazer preservou o lançamento salvo. Suíte com
  803/803 regressões reais e 30 casos de correção de proposta.

## 20/11/2026 — Horários em entradas e despesas avulsas

- Horas ditas com “às” ficam no lançamento. “Ontem às 20h gastei
  30 na padaria” mantém o dia, o horário e os R$ 30 na proposta e
  na confirmação. “Às oito e meia” vira 08:30.
- Horário inválido pede correção e recupera o restante da proposta.
  Confirmação recusa um horário posterior ao relógio no mesmo dia.
  Em um teste com saldo informado às 12h, o gasto das 9h já estava
  incluído e apenas o das 13h30 alterou o caixa.
- Chrome local e suíte com 805/805 regressões reais. O horário é
  preenchido pelo interpretador local. Contas fixas com horário
  explícito apontam para o vencimento no Planejamento.

## 20/11/2026 — Negativa com outro local ou data

- “Não gastei 90 no mercado mas gastei 75 na padaria” preserva
  o registro de R$ 90 da farmácia e propõe os R$ 75 da padaria.
  Se a referência aponta para a farmácia, corrige a ação anterior.
- Uma data incompatível numa correção com valor pede o alvo.
  Repetir a ação já proposta com os mesmos dados pede que o usuário
  diga se aconteceu outra vez antes de criar uma duplicata.
- Suíte com 806/806 regressões reais e 30/30 casos de correção.
  Conferidos no Chrome os dois registros do primeiro exemplo.

## 20/11/2026 — Receitas com origem no perfil motorista

- “Recebi 120 da Casa 2 e 80 do Uber” confirma as duas receitas
  com as origens correspondentes e uma corrida. Inverter a ordem
  também preserva a origem e a contagem.
- A numeração do cliente ou da loja pertence ao nome da origem.
  O caixa e as origens declaradas deixam de acrescentar viagens
  inferidas. Se a pessoa diz que fez cinco corridas, ficam cinco.
- Chrome com confirmação, suíte com 813/813 regressões, 151
  invariantes e rubrica com zero respostas perigosas ou ruins.

## 20/11/2026 — Correção do horário antes de confirmar

- “Foi às oito e meia” atualiza só o horário da entrada ou
  despesa avulsa proposta. Com mais de um lançamento, o
  assistente pergunta qual recebeu o novo horário.
- O Chrome confirmou duas despesas, preservando a hora original
  da farmácia e marcando somente 10h30 na padaria.
  A suíte ficou em 814/814 regressões reais.

## 20/11/2026 — Horário aproximado ou com alternativa

- “Às nove ou dez”, “entre 9h e 10h” e “por volta das 9h”
  pedem horário exato antes da proposta. R$ 50, o local e a data
  continuam disponíveis e voltam junto com a hora informada.
- Suíte com 820/820 regressões reais. As matrizes de linguagem
  passaram em 640/640 casos de fala irregular e 384/384 casos de
  horário em oito datas e quatro perfis, sem chamar o remoto.

## 20/11/2026 — Fala do dia a dia, previsão do mês e acentos (Claude)

Retomada a partir de `6129f5a` (handoff do Codex). Dez commits locais,
`2414f14..a438ef8`, todos com regressão vermelha antes da correção, pelo
orquestrador real e offline. Sondas lidas resposta por resposta.

Casos do handoff resolvidos:
- "recebi 120 da Casa 2 e 120 do Uber" (e invertido, e duas casas, e por
  extenso): três deduplicações por VALOR viraram por POSIÇÃO (regra 67a).
- "às 9 e 30 na padaria" pergunta se o 30 é minuto ou outro gasto, com as
  duas leituras prontas; "horário", "1", "mais 30 na padaria", "2" ou o
  lugar escolhem. Meio de pagamento ("no cartão") não é lugar.
- "trabalhei ontem das 9h às 13h" vira 4h de trabalho (motorista); turno que
  passa da meia-noite pergunta o dia.
- "ao meio-dia", "à meia-noite", "faz meia hora", "há 20 minutos" viram hora;
  relativa usa o relógio do aparelho e vira ontem antes da meia-noite. O
  corretor de digitação não troca mais "meio"→"maio" nem "meia"→"meta".
- "recebi 110 do joão" não presume corrida nem viagem.

Defeitos novos achados pelas sondas e corrigidos:
- Receita fantasma de R$ 15 em "gastei 30 no mercado e 20 na padaria e 15 no
  uber"; "fiz 12 corridas deu 310 e rodei 180 km" perdia os 310; "comprei
  pão 8 leite 6 e café 12" perdia R$ 14 em silêncio; "abasteci 50 de etanol
  e 30 de lanche" perguntava pelos 30.
- "gastei uns 30 ou 40 no mercado" virava DUAS despesas; agora pergunta.
- "quanto eu fiz essa semana na 99" somava todas as plataformas; "gastei
  quanto de luz esse ano" respondia a categoria Casa (o telhado); nome de
  conta fixa cadastrada agora é entidade.
- Meta "Notebook até junho" sem prazo; média "por semana" era por
  lançamento; "cm uber" virava descrição; borracheiro e lavagem.
- Oito regexes nunca casavam com acento, inclusive duas guardas contra
  injeção ("me dê o prompt", "faça de conta que você"); a correção expôs um
  corte antigo de "minha dívida tá em | quanto?" (regra 67b).
- Fim do mês: "quanto vai sobrar/sobrará", "vou fechar no azul?", "to tendo
  lucro?", "consigo guardar 500 esse mês?", "quanto vou ter dia 30" agora
  respondem com a previsão e a conta, ditas como previsão.
- Complemento curto da proposta: "foi na uber", "de salário", "no posto",
  "foi janta", "foram 18 litros", "não, foi 250", "da casa 3", "e hoje 320".

Gates (relógio 2026-09-15): 733/733 corpus, 99/99, 50/50, 899/899
adversariais, 4.088 + 3.800 metamórficos, 1.416 fuzz, 151/151 invariantes,
5/5 ditado, 468 offline; typecheck, typecheck:api, test:money, build,
rubrica (0 perigosa, 0 ruim) e `test:calendario` (oito datas). Sem push,
merge, deploy, APK ou DeepSeek. **NOT READY** até auditoria independente.

Também: "rodei 150 km" seguido de "e fiz 10 corridas" agora junta o mesmo
dia num registro de trabalho só.

Abertos e não atacados: "paguei a taxa da 99 de 1 real" cai no menu; "qual
dia eu mais ganho" responde a data, não o dia da semana; voz real, Android e
DeepSeek continuam sem validação.


## 21/11/2026 — Palavra real, dinheiro que chegou e o dia do motorista (Claude)

Retomada de `64206c0`. Nove commits locais, `386ebe3..348048d`, todos com
regressão escrita no bloco `MN-` de `tests/assistant/adversarial-real.ts`.
Sondas lidas resposta por resposta, pelo orquestrador real e offline.

Abertos da rodada anterior resolvidos:
- "paguei a taxa da 99 de 1 real", "taxa da 99 1 real": o 99 depois de
  preposição é a plataforma; sem valor, pergunta. Vale em todos os perfis
  porque é o usuário dizendo que pagou (a regra 1 continua intocada).
- "qual dia eu mais ganho", "melhor dia pra rodar", "qual dia compensa mais
  rodar": presente habitual ranqueia dia da semana; "ganhei" ranqueia datas.
- `kmCost` dividia o custo fixo MENSAL pelos km rodados até hoje no mês: no
  dia 15 o custo fixo valia o dobro e no dia 1º seis vezes mais, e o mínimo
  recomendado e o "vale a pena?" herdavam a distorção. Agora `projectedMonthlyKm`.

Classes de defeito achadas pelas sondas e corrigidas:
- Corretor de digitação trocando PALAVRA REAL por vocabulário do app (regra
  68): peguei→paguei, cobrou→sobrou, salão→saldo, comprando→comparando,
  veio→meio, passeio→passei, banheiro→janeiro (distância 2), Marcos→Marco.
- Palavra-chave de categoria casando no meio da palavra: imposto→Combustível,
  cobraram→Obra, barbeiro/embarque→Lazer, japão→Alimentação.
- Sinal do dinheiro: "paguei a corrida de 30" era RECEITA (regra 34).
- Dinheiro inventado ou perdido: "paguei o boleto de 300" e "paguei a taxa de
  5" (o valor depois de "de"), "comprei 10 sacos de cimento por 350" (R$ 10),
  orçamento e preço no presente virando despesa, "a conta de água veio 95"
  virando conta PAGA (regra 69), "o banco me cobrou 45 de tarifa e 12 de iof",
  "minha mãe me deu 50", "a Casa 1 pagou 1800", "o cliente pagou 300", "dei
  20 pro flanelinha", "comi um pastel de 12", "enchi o tanque 250", "fiz um
  bico de 150", "fiz 10 corridas e rodei 120 km, deu 300", "fiz 18 corridas
  420 reais 9 horas", "gastei 30 no mercado e paguei a luz" (a segunda metade
  sumia sem aviso).
- Perguntas respondidas com o assunto errado: "o salário já caiu?" dizia "Não,
  subiu" com o GASTO; "a Casa 2 já pagou?" ia para a ajuda; "quanto falta pro
  salário cair" falava de parcelamentos; "quanto eu economizei" dava o total
  gasto; "qual minha maior despesa fixa" dava o maior gasto avulso.
- Novas respostas locais: avaliação de um dia ("como foi ontem?", "sexta
  rendeu bem?"), corrida com distância ("pego corrida de 20 por 25 km?"),
  "quando troco o óleo/os pneus", empréstimo, confirmação digitada.
- Rascunho "comprei um celular" → "1200 em 10x" virava despesa avulsa; agora
  vira compra parcelada (regra 10).

Depois do checkpoint (`de33fd6..`):
- Mês digitado com um erro numa pergunta ("quanto gastei em agsto") é o mês;
  "de mario" continua sendo pessoa.
- Compra "no cartão", "no crédito" ou no nome do cartão nunca vira despesa
  avulsa (regra 10): o rascunho pergunta as parcelas ("à vista" é 1x) e o
  cartão; "débito" devolve a despesa com data e hora. "Passei 80 no cartão no
  mercado" mostrava o resumo dos cartões e não registrava nada.
- Regra 14 no chat: meta com nome que já existe pergunta (atualizar, criar
  outra, cancelar). "Desisti da meta" diz onde encerrar.
- "Tirei limpo" é resultado; "quanto a gasolina come do que eu faturo" dava
  100% (o numerador era lido como receita).
- Corrida com distância analisada; "quando troco o óleo/os pneus";
  confirmação digitada aponta o botão; "é salário" no segundo turno; rascunho
  "comprei um celular" → "1200 em 10x" vira parcelamento.
- Real e centavos falados: "um e cinquenta no pão" era R$ 51,00 (agora
  R$ 1,50); "paguei 4 e 90 no pão" eram dois gastos somando R$ 94 (agora
  pergunta "R$ 4,90 ou dois gastos?"). "Fiz 450 em 12 horas" guarda as horas.
- Percentual arredondado uma vez só: 12,748% saía 12,8% (achado pela matriz
  de calendário em 30/11). "Obrigado", "oi" e "bom dia" têm resposta curta.
- "Não, foi no cartão" sobre a despesa na tela vira compra no cartão;
  "quanto gastei essa semana COM LAZER" (categoria depois do período) dava o
  total da semana inteira.

Decisão de produto deixada para o usuário: no perfil motorista, cada receita
de plataforma num dia inteiro conta "1 viagem" (`crit-motorista` espera 2
viagens para Uber + 99 com 161 km e 8 horas). A regra 34 diz que um dia
inteiro não inventa viagem; o caso crítico diz o contrário. Não mudei.

Gates (relógio 2026-09-15): 733/733 corpus, 1.031/1.031 adversariais, 151/151
invariantes, mutações, fuzz, ditado e remoto offline; typecheck,
typecheck:api, test:money, build, rubrica (0 perigosa, 0 ruim) e
`test:calendario` nas oito datas. Sem push, merge, deploy, APK ou DeepSeek.
**NOT READY** até auditoria independente.

## 21/11/2026 — Viagem só quando é dita (decisão do usuário) (Claude)

Decisão autorizada pelo usuário: no perfil motorista, plataforma mencionada
num resumo do dia ou do turno é ORIGEM de receita, não viagem. A quantidade
de viagens fica ausente quando a pessoa não diz quantas fez (regra 34).

- Parser (`nlp.ts`): a viagem implícita por receita de corrida só vale quando
  a frase NOMEIA uma corrida no singular (`UMA_CORRIDA_NOMEADA`: "uma
  corrida", "numa corrida", "pela corrida", "corrida de 18"). "Ganhei 22 DE
  corrida" é categoria, não contagem. Quantidade dita ("fiz 12 corridas")
  continua valendo, inclusive com receitas de várias plataformas na frase.
- Cláusulas (`clauses.ts`): "Fiz uma corrida, ganhei 150" — a corrida
  nomeada sem valor passa a viagem para a receita da cláusula seguinte.
- Métricas: o ganho por viagem dividia a receita de TODOS os dias pelas
  viagens; com dias sem quantidade, inflaria (R$ 750 / 10 = R$ 75 em vez de
  R$ 30). Agora `periodStats` expõe `incomeWithTrips` e `perTrip` usa só os
  dias com viagens; o `per-trip` da DSL usa o mesmo recorte (bate com
  `calc.ts`, regra 58); a resposta "qual minha média por viagem?" diz quanto
  ficou fora da média; o "dia típico" do motorista também. Home, Veículo e
  Análises mostram travessão em vez de "R$ 0,00 por viagem" sem viagem.
- Catálogo: o campo `trips` diz ao planejador remoto que a quantidade é a
  DITA, nunca inferida do valor nem da plataforma. O prompt de produção só
  muda depois de um redeploy autorizado.
- Casos: `crit-motorista`, `sem-04`, `mul-01`, `mul-07` esperam o trabalho
  sem `trips`; `rec-01/02/08`, `mt2-04`, `abr-03`, `sem-02`, `fr-15/16`,
  `rr-42`, `ad-05/06/39`, `LING-origem-motorista-4/5`, `MV-*`, `MF-uber-…` e
  `VG-sem-quantidade-controle` deixaram de esperar a viagem inventada; `rr-53`
  (plural de "1 viagem") usa "fiz uma corrida de 25"; `test-app.mts` idem.
  Bloco novo `VI-` (19 casos): o relato completo do turno (proposta, texto,
  estado depois de confirmar, faturamento de R$ 829, abastecimento, 161 km,
  8 h, zero viagens e nenhum ganho por viagem), "hoje rodei 12 horas e fiz
  450", as quantidades ditas e as métricas.

Gates (relógio 2026-09-15): 733/733 corpus, 1.050/1.050 adversariais, 151/151
invariantes, mutações, fuzz, ditado e remoto offline; typecheck,
typecheck:api, test:money, build, rubrica (0 perigosa, 0 ruim) e
`test:calendario` nas oito datas. Sem push, merge, deploy, APK ou DeepSeek.
**NOT READY** até auditoria independente.

## 21/11/2026 — Depois da decisão das viagens: sondas e correções (Claude)

Continuação da mesma rodada, com sondas sobre os fixtures ricos e as
respostas lidas uma a uma (regra 35). Cada item tem bloco próprio em
`tests/assistant/adversarial-real.ts`.

Números errados ou registro que não devia existir:
- Abastecimento grava o registro do veículo E a transação de Combustível; a
  média de combustível somava os dois (R$ 200 para R$ 100). `fuelSpend()` em
  `calc.ts` conta o dinheiro uma vez (`CB-`).
- "Gastei mais que o mês passado?" no dia 15 comparava 15 dias com o mês
  passado INTEIRO e respondia "Não, caiu (-52%)" quando o gasto tinha subido
  39%. O mês citado compara o mesmo pedaço, e o rótulo diz qual
  ("De 1º a 15 de agosto") (`CP-`).
- "Dá pra guardar 500 esse mês?" respondia "Sim" pelo simulador de meta e
  "consigo guardar 300" respondia "não" pela sobra prevista. As formas
  faladas vão para a mesma conta (`GE-`).
- "Paguei 2400 no seguro em 12x no nubank" virava despesa avulsa (regra 10);
  "12x de 200" era lido como total de R$ 200; "do carro" virava cartão (`PZ-`).
- "Paguei 1/3 do aluguel, 400" era lançado em 01/03 (`FR-`); "reajustei o
  aluguel da casa 1 pra 1900" propunha uma despesa de R$ 1,00; "cancelaram a
  corrida de 30" lançava R$ 30 e 1 viagem; "tirei 200 do banco" era R$ 200 de
  corrida; saque não é ganho nem gasto (`NN-`, `SQ-`).
- "Quanto rodei esse mês" respondia o total GASTO; "melhor dia esse mês"
  devolvia um dia do mês anterior; "quanto o carro me custa por mês"
  respondia todo o gasto do mês (`KR-`, `CB-`).

Pergunta respondida pela metade ou pela ajuda genérica:
- "Tô gastando muito com obra?", "gastei muito esse mês?" (`GX-`); "tô bem
  na meta?" e "quanto falta pra meta de hoje" na forma da pergunta (`MD-`);
  "como é meu dia típico?" (`KR-`); "minha luz veio 230" (`CV-`); "quanto
  sobra até o próximo salário" (`CL-`); "o inquilino da casa 2 atrasou"
  (`AT-`); "o que eu registrei hoje?", "mostra meus últimos gastos" (`LS-`).
- Correção sem proposta na tela não diz mais "isso não aconteceu"; "errei,
  era 45 e não 54" corrige o lançamento de 54 (`RT-`).
- "Posso parcelar uma geladeira de 3000 em 10x?" mostrava os cartões e
  "posso comprar um celular de 1500?" caía na ajuda — agora simulam como
  "consigo comprar"; "e se a casa 2 ficar vazia" é entrada que não vem
  (`HP-posso-*`). "Quanto falta pra quitar o computador" dizia que não havia
  parcelamento; "vale a pena quitar?" diz o que falta e que só compensa com
  desconto, sem inventar juros (`QT-`; o caso `c-49` do corpus remoto passou
  a ser local).
- Perfil CLT: "meu 13º caiu 1600" lia R$ 13; 13º e férias são Salário;
  "paguei a pensão 600" caía na ajuda; "descontaram 300 de INSS" listava
  vencimentos (o `/contas?/` casava dentro de "desCONTAram") e agora explica o
  desconto em folha; "quanto eu ganho por hora" sem horas dizia
  "R$ 0,00/hora (dado real)"; "quanto do meu salário vai pro aluguel" é
  proporção (`SL-`). Varredura de regex sem borda no roteador antigo: "METAde"
  puxava a meta diária, "MESmo" virava mês (`BW-`).
- "Comprei um celular" → "1200" → "em 10x" → "no nubank": o parcelamento
  dito depois da proposta caía na ajuda e a compra ficava como despesa avulsa
  (regra 10); o celular comprado ia para Assinaturas. "35 cnto no mcdonalds",
  "120 d luz", "40 rs no bar" deixavam a abreviação na descrição (`AB-`).
- "Ganhei mais essa semana ou semana passada?" mostrava só a semana passada;
  "qual o melhor horário pra rodar" dava o total do mês (o app guarda a hora
  do REGISTRO, não a das corridas, e agora diz isso); "tô cansado, paro ou
  continuo?" mostra o dia contra a meta e deixa a decisão com o motorista
  (`DR-`).
- "Dei 100 pra minha mãe" gravava "Minha mã": o `\b(?:e|mas|porém)$` que tira
  o conector órfão casava no "e" depois de "ã" (regra 67b). Mais cinco regex
  com `\b` antes de "e" ganharam borda explícita (`AC-`). "Onde dá pra cortar
  gastos" buscava o texto "cortar gastos" e "me dá uma dica pra economizar"
  caía na ajuda; agora mostram onde mais saiu no mês (`OC-onde-cortar`,
  `OC-dica`).
- "Hoje fiz 18 corridas e tirei 410" perdia os R$ 410 (`SQ-`); "paguei o
  aluguel, 400" perdia a descrição e "paguei o mecânico: 350" não registrava
  nada (`VF-`); "IPTU" e "iFood" com a grafia certa; "recebi o vale" é
  Salário.

Gates (relógio 2026-09-15): 733/733 corpus, 1.175/1.175 adversariais, 151/151
invariantes, mutações, fuzz, ditado e remoto offline; typecheck,
typecheck:api, test:money, build e rubrica (0 perigosa, 0 ruim).
`test:calendario` rodou depois de cada lote e achou quatro oráculos de teste
dependentes de data (último dia do mês, dia 1º, 12/11 e 28/02/2027), todos
corrigidos no teste; o dia 1º também mudou o rótulo ("em 1º de outubro"). Sem push, merge, deploy, APK ou DeepSeek. **NOT READY**
até auditoria independente.


## 21/11/2026 — Data da compra no cartão pelo chat

- A ação de compra guarda a data explícita pelo interpretador local. O executor
  usa essa data para escolher o vencimento e mantém a data de criação.
- “Ontem passei 80 no cartão”, seguido de “à vista”, confirma a compra de
  ontem. “Foi no débito” preserva o dia e grava uma despesa avulsa.
- O dia dito em rascunho fica fora do valor e do número de parcelas.
  Data inválida pede esclarecimento. O contrato e o executor recusam primeiro
  vencimento anterior à compra.
- Chrome local verificou crédito e débito. A suíte passou com 1.180/1.180
  regressões adversariais e 151/151 invariantes.

## 21/11/2026 — Compra no cartão junto de outros fatos

- “Paguei 20 de ônibus hoje e passei 80 no cartão ontem” mantém a
  despesa de R$ 20 e pergunta quantas parcelas teve a compra de R$ 80.
  A resposta reaproveita somente os itens que ainda estão pendentes.
- “Passei 80 no cartão e recebi 60 de aluguel” mantém o aluguel como
  receita independente. “Passei 2.000 em 5x e recebi 1.850” continua
  como entrada financiada. O mesmo reconhecedor delimita o trecho
  no segmentador e no parser.
- Chrome confirmou primeiro o ônibus, depois a compra, cada um
  uma vez. A suíte passou com 1.182/1.182 regressões adversariais.

## 21/11/2026 — Prazo dito na simulação de vacância

- “Se a Casa 2 ficar vazia três meses” usa o intervalo real até 20/02,
  considerando a partir de 21/11. Dias e semanas também entram na conta.
- Retira só as ocorrências em aberto de aluguel da origem no período.
  Receitas da Casa 20, serviços da mesma origem e valores já recebidos
  continuam com o tratamento normal. Histórico sem recorrência é mostrado
  como referência, sem descontar do saldo uma entrada que já estava fora.
- Pergunta qual imóvel se houver mais de um candidato. “Mais um mês” mantém
  a origem e estende o cenário. O Chrome confirmou três e quatro meses sem
  gravar movimentação. Suíte com 1.185/1.185 regressões adversariais.

## 21/11/2026 — Simulação de quitação de um parcelamento

- “E se eu quitar o computador hoje?” mostra o saldo em aberto e o
  saldo após a quitação pelo valor nominal. Preço ou desconto informado
  recalcula a diferença. “E se sair por 600?” mantém o parcelamento.
- Usa o progresso real do plano, incluindo pagamentos parciais e parcelas
  canceladas. Com nomes repetidos, pede o alvo e aceita o cartão na frase.
  Exige um prazo válido quando o usuário pergunta pelo saldo de outro dia.
- Chrome confirmou a simulação com preço informado e parcelas intactas.
  A suíte passou com 1.187/1.187 regressões adversariais.

## 21/11/2026 — Referência de turno para o motorista

- “Hoje é feriado, vale rodar?” usa a média bruta ponderada pelos dias do
  mesmo dia da semana com receita de corridas e horas. A amostra precisa
  de três dias nas últimas oito semanas. A resposta explica que o histórico
  ainda não distingue feriados e exibe o piso por km quando configurado.
- “Tô cansado, paro ou continuo?” começa pela pausa em local seguro.
  “Vale rodar hoje? Tô com sono” considera a segunda parte da mensagem.
- A suíte passou com 1.191/1.191 regressões adversariais e ambos os
  typechecks passaram.

## 21/11/2026 — Origem de receita após uma autocorreção

- “Recebi 120 do Uber, quer dizer, 100 da Casa 2” propõe uma entrada de
  R$ 100 da Casa 2 em Outras receitas. Se a entrada foi dita como aluguel,
  corrigir só o imóvel preserva a categoria.
- “Errei, foi 100 do Uber” em uma proposta aberta pode trocar valor e
  origem juntos. A origem antiga deixa de aparecer e a viagem não é
  inferida. A suíte passou com 1.195/1.195 regressões adversariais.

## 21/11/2026 — Período de consulta com fala espontânea

- “Quanto gastei mesmo ontem?” agora usa ontem. “Mesmo” e “mesa” deixaram
  de cair nas regras que reconhecem mês. “Anteontem” é um dia próprio.
- A sobra depois da gasolina usa o dia, mês ou intervalo pedido. O
  período futuro pede uma janela já iniciada para consultar o realizado.
- A simulação de confirmação e a consulta usam a mesma data no turno.
  A suíte passou com 1.203/1.203 regressões adversariais na data padrão,
  151/151 invariantes e matriz verde nas oito datas.

## 21/11/2026 — Ofertas de corrida e unidades do ditado

- A análise soma os quilômetros até o passageiro aos da viagem e usa
  o tempo informado. Quando falta custo por km, mostra apenas o bruto.
  Distâncias conflitantes pedem confirmação. Duas ofertas na mesma frase
  não geram entradas, e o chat pede que sejam enviadas uma por vez.
- “Recebi 22 por uma corrida de 8,5 km” propõe apenas R$ 22 e a viagem
  dita. O parser protege quilômetros, metros e tempo no lugar do valor.
- Chrome verificou uma oferta de 18 km e 30 min, a resposta ao cansaço
  e a confirmação de uma única entrada de R$ 22. A suíte passou com
  1.215/1.215 regressões adversariais.

## 21/11/2026 — Primeiro vencimento informado pelo chat

- “Ontem comprei uma cadeira em 2x. O primeiro vencimento é em 10/12”
  separa a data da compra da data da primeira parcela. O vencimento
  aparece na proposta e permanece durante as perguntas de preenchimento.
- A correção de um vencimento inválido retira o cartão de confirmação até
  receber uma data válida. Compras negadas deixaram de abrir rascunho no
  fluxo de intenção incompleta.
- Chrome confirmou compra em 20/11 com parcelas em 28/11 e 28/12, após
  substituir o vencimento. Suíte com 1.219/1.219 regressões adversariais.

## 21/11/2026 — Receita e quantidade usadas na média por viagem

- A média usa dias que têm tanto a quantidade de viagens quanto a receita
  de corridas. Salário, aluguel, receita sem contagem e contagem sem
  receita ficam fora da amostra. A quantidade total continua disponível.
- O chat e as telas calculam a mesma média. Se faltar um dos dados, as
  telas mostram o campo indisponível. Perguntas por Uber ou 99 explicam
  por que o total de viagens do dia não permite atribuir uma média ao app.
- Com dez viagens e R$ 300 de corridas, a média permanece R$ 30 mesmo
  com aluguel e registros incompletos em outros dias. Suíte com
  1.222/1.222 regressões adversariais.

## 21/11/2026 — Vacância no mês do calendário

- “Se a Casa 2 não pagar este mês” simula do dia atual ao último dia do
  mês. “Mês que vem” retira só a entrada da origem naquele mês e mantém
  as ocorrências anteriores na projeção de caixa.
- Quando há mais de um imóvel, responder “Casa 2” reaproveita o prazo já
  informado. Se o histórico de recebimentos existe sem previsão cadastrada,
  a média aparece como referência. Suíte com 1.223/1.223 regressões.

## 21/11/2026 — Horário relativo composto

- “Há uma hora e quinze minutos”, “faz 1h30” e “1h30 atrás” usam toda a
  duração. O tempo em minutos deixa de aparecer como um valor solto.
- “Faz uns 30 minutos” e “uma hora e pouco” pedem o horário. A resposta
  pode trazer dia e hora juntos. A conta verifica se a data dita coincide
  com a data calculada, inclusive na virada da meia-noite.
- A suíte passou com 1.228/1.228 regressões e 151/151 invariantes.
  O teste independente confirmou viradas de mês, ano e fevereiro bissexto.

## 21/11/2026 — Escolha da data da compra com vencimento informado

- “Ontem ou anteontem comprei uma cadeira de 250 em 2x no Nubank,
  primeiro vencimento em 10/12” pede só a data. A escolha conserva os
  dados do plano. Vencimento dito só pelo dia é resolvido depois da escolha.
- Compras sem valor ou sem parcelas também preservam a data pendente.
  “15” é a data quando o rascunho pergunta o dia do mês passado.
- Chrome confirmou primeiro o ônibus de R$ 20, clicou “anteontem” e
  confirmou só uma compra de R$ 250 em 2x. Suíte com 1.233 regressões.

## 21/11/2026 — Chamada, corrida concluída e corrida paga como passageiro

- “Me ofereceram corrida de 37” e “recebi uma chamada de 27 na Uber”
  aguardam confirmação de que houve pagamento. Recusar a corrida ou
  dizer que ainda não aceitou deixa a oferta fora do caixa.
- “Entrei 25 de uma corrida e tocou outra de 17” preserva a primeira
  entrada e pergunta pela segunda. Uma pergunta de análise sobre a oferta
  usa o valor e a distância sem registrar receita.
- Pagar uma corrida de 8 km por R$ 29 gera uma despesa de R$ 29. O leitor
  de itens protege unidades de medida antes de buscar valores enumerados.
  Suíte com 1.241/1.241 regressões.

## 21/11/2026 — Comparação de duas ofertas

- “Compare corrida de 30 em 10 km ou 50 em 20 km” mostra as duas ofertas
  com seus valores e distâncias. O critério explícito de km, hora ou
  lucro total prevalece. Tempo completo permite usar a taxa por hora.
- A resposta informa quando falta distância, tempo ou custo do veículo.
  Ofertas ficam fora do caixa. O Chrome comparou R$ 75/h e R$ 60/h com
  uma despesa anterior ainda pendente. Suíte com 1.247/1.247 regressões.

## 21/11/2026 — Quem pagou, mesmo em minúsculas

- O chat guarda o nome da pessoa em “recebi 110 do joão às 8h” e
  “o joão me mandou um Pix de 40”. A categoria segue o motivo informado.
- “Recebi 120,50 da ana e 120,5 do joão” preserva as duas receitas.
  A confirmação soma R$ 241. “Ninguém me mandou Pix” fica pendente.
- “Foi da Maria” corrige a origem de uma receita da Uber e retira
  a categoria da plataforma. Suíte com 1.254/1.254 regressões.

## 21/11/2026 — Pagamentos de terceiros

- “Joao pagou 40 pro supermercado” descreve uma movimentação de outra
  pessoa. “Eu paguei 80 no posto e joao pagou 90 no mercado” propõe só
  os R$ 80. “O cliente pagou 40 pra Marina” também fica fora do caixa.
  Suíte com 1.257/1.257 regressões.

## 21/11/2026 — Data afirmada depois de recusar um dia

- “Não foi ontem, foi anteontem” seleciona anteontem. Se a pessoa disser
  só “não foi ontem”, o rascunho guarda a compra e volta a perguntar o dia.
- “Não dia 2, dia 15” dentro de “mês passado” usa o dia 15 daquele mês.
  A mesma leitura vale para corrigir o primeiro vencimento sem mudar
  a data da compra. Suíte com 1.264/1.264 regressões.

## 21/11/2026 — Dinheiro recebido, reserva e empréstimo

- Recebimento do banco ou na conta sem indicação de plataforma entra em
  Outros. O banco de destino fica fora da origem. Salário conserva a
  categoria informada.
- Dinheiro da própria conta, retirada da reserva e empréstimo não inflam
  receitas. O chat explica a limitação de registro da reserva e do
  empréstimo bancário. Crédito no cartão pede os dados da entrada financiada.
- Em relatos mistos, R$ 80,50 retirados da reserva ficam fora e R$ 15,20
  de freela permanecem na proposta. Suíte com 1.275/1.275 regressões.

## 21/11/2026 — Oferta e movimentação realizada na mesma fala

- “Gastei 25 no mercado e tiraria 30 numa corrida de 10 km, compensa?”
  prepara só o gasto e calcula R$ 3/km bruto para a oferta. O mesmo vale
  para perguntas sobre chamadas recebidas e comparações.
- “Fiz uma corrida de 30 por 10 km e outra de 50 por 20 km compensa?”
  mantém os R$ 30 e a viagem concluída e analisa apenas os 20 km da outra.
  Suíte com 1.280/1.280 regressões.

## 21/11/2026 — Durações faladas nas ofertas

- “1h30”, “uma hora e meia” e “meia hora” entram no cálculo por hora.
  Com 5 min até o passageiro e 1h30 de viagem, a base é de 95 min.
- “1h99” não produz taxa por hora. A comparação de 1h30 e 2h calcula
  R$ 16,67/h e R$ 20/h com o custo por km cadastrado. Suíte com
  1.287/1.287 regressões.

## 21/11/2026 — Consultas por nome de quem pagou

- “Quanto recebi da Ana hoje?” usa a origem exata. Ana Paula e a
  receita da Uber ficam fora da conta. “Quanto a Ana me mandou de Pix?”
  consulta entrada e preserva o filtro de Pix.
- A lista de pagadores mostra os valores de cada origem e avisa quais
  nomes ficaram sem lançamentos. O ranking indica se há entrada sem
  origem identificada.
- “Recebi 20 da Ana. Quanto ela já me pagou hoje?” mostra o total
  projetado da Ana, condicionado à confirmação. Suíte com 1.295/1.295.

## 21/11/2026 — Continuação de consulta por pagador

- “E do João?” troca a origem e conserva o período. “Somando as duas?”
  e “qual dos dois me pagou mais?” usam só Ana e João.
- “Quanto ela me pagou?” usa a pessoa da consulta recente quando é única.
  Com nenhum nome ou mais de um, pede a identificação. “E por Pix?”
  combina o meio de pagamento com a origem e o período em foco.
  Suíte com 1.298/1.298 regressões.

## 21/11/2026 — Completar os dados da oferta no chat

- O chat pede o valor ou a distância faltante e aceita a resposta curta.
  Com R$ 35, 5 km até o passageiro, 9 km de viagem e 25 min no total,
  a análise soma 14 km e calcula R$ 67,20/h estimados.
- A confirmação de registros anteriores fica disponível. O Chrome
  confirmou só o mercado, retomou a oferta em três turnos e descartou
  o esclarecimento concluído ao voltar ao chat. As 1.302 regressões
  passaram. A matriz própria passou 770 cenários em cada um de três fusos.

## 21/11/2026 — Volta informada na análise de corridas

- Embarque, viagem e retorno entram na distância e no custo quando
  declarados. “15 km no total mais 10 km de volta” usa 25 km. Se a
  frase só disser “15 km no total e 10 km de volta”, o chat pergunta
  se a volta já está incluída.
- A taxa por hora usa o tempo com retorno. A comparação usa cada
  rota separadamente. Suíte com 1.307/1.307 regressões.

## 21/11/2026 — Duração exata na jornada realizada

- “Rodei 75 km em 1h30 e ganhei 150” registra 75 km, 1h30 e R$ 150.
  “Três horas e meia” e “35 minutos” também são durações. Os números
  da hora ficam fora do caixa. Duração da viagem como passageiro fica
  fora do trabalho. Suíte com 1.313/1.313 regressões.

## 21/11/2026 — Quilometragem realizada de ida e volta

- A volta declarada soma à ida sem virar dinheiro. “Fiz uma corrida de
  45 com 15 km e mais 10 km na volta” registra R$ 45, 25 km e uma
  viagem. Se a volta já integra o total, a distância permanece única.
- Quinhentos metros viram 0,5 km. Caminhada, volta negada e volta como
  passageiro ficam fora da quilometragem do trabalho. Suíte com
  1.322/1.322 regressões.

## 21/11/2026 — Totais e valores já incluídos

- Frete, entrega, juros, taxa e pagamento em Pix explicitamente já
  incluídos explicam o total. “Paguei 60 incluindo 10 de frete”
  propõe R$ 60. “Paguei 50 mais 10 de entrega” preserva os dois.
- Um total declarado no fim da lista é conferido em centavos. Quando
  diverge dos itens, o chat pede os valores corretos antes de propor.
  Suíte com 1.332/1.332 regressões.

## 21/11/2026 — Uma compra com dois meios de pagamento

- “Gastei 150,50 no mercado, 100,25 no Nubank e 50,25 no Pix” propõe
  só R$ 50,25 no caixa. Os R$ 100,25 vão para a compra no cartão
  quando as parcelas são informadas.
- Pix, dinheiro e débito da mesma compra compõem uma saída pelo total.
  A soma informada precisa bater antes de preparar os registros.
  Suíte com 1.335/1.335 regressões.

## 21/11/2026 — Repasse recebido com taxa já retida

- “Fiz 430 bruto na Uber e recebi 380 líquido depois da taxa de 50”
  prepara R$ 380, com a origem da plataforma. Uma taxa explicitamente
  paga à parte e um abastecimento continuam em seus próprios registros.
- Quando bruto, líquido e taxa divergem, o chat pergunta o valor que
  entrou. O recebimento após retenção não reabre a oferta de lançar
  a taxa. A marca só pode vir do leitor local. Suíte com 1.340/1.340.

## 21/11/2026 — Duração inválida sem misturar caixa e jornada

- “Ontem rodei 75 km em 1h99 e ganhei 150 na Uber” separa a receita
  e pergunta só a duração. “1h45” recupera 75 km de ontem; “às 8h”
  continua como horário de relógio e pede a duração.
- O chat encerra esclarecimentos respondidos sem apagar a proposta
  que ainda pode ser confirmada. Suíte com 1.342/1.342 regressões.

## 21/11/2026 — Totais preservados enquanto falta o dia

- Uma compra dividida entre Pix e crédito pede uma data comum.
  Escolher anteontem preserva R$ 50 no caixa e R$ 100 na compra.
  O chat solicita as parcelas em seguida quando necessário.
- Datas incertas continuam pendentes. Frete já incluído fica no
  total enquanto a pessoa escolhe o dia, inclusive no mês passado.
  Suíte com 1.344/1.344 regressões.

## 21/11/2026 — Plataforma citada antes do valor

- “Na Uber recebi 120”, “pela 99 entrou 88” e “na inDrive ganhei 43”
  mantêm a plataforma em Corridas sem inventar viagens.
- Em “na Uber recebi 120 da Maria”, o nome declarado continua como
  a origem. Suíte com 1.348/1.348 regressões.

## 22/11/2026 — Depois da rodada 2 do Codex (Claude)

Retomada no HEAD `83461ab` do Codex, com a suíte verde (1.348/1.348). Cada
item tem bloco próprio em `tests/assistant/adversarial-real.ts`.

- "Quanto foi meu FATURAmento esse mês" respondia "você ainda não cadastrou
  cartões": o roteador casava `/fatura/` dentro da palavra. Cartão, parcela e
  fatura ganharam borda. "Quanto FOI meu lucro" abria com o gasto do mês, e
  o resultado líquido agora mostra o que entrou e o que saiu
  (`BW-faturamento-*`, `BW-quanto-foi-lucro`).
- "Rodei 64 km e 14 voltando" perguntava pelos "R$ 14,00"; a volta herda o
  km (`VK-volta-*`). Uma corrida já analisada aceita revisão: "na verdade o
  retorno era 7 km", "e se pagasse 30?", "e se o passageiro estiver a 3 km"
  refazem a conta, acumulando; a oferta fica só no foco em memória (`RV-`).
- "Qual FOI o mês mais apertado" respondia com a previsão de parcelas
  futuras; no passado é o pior mês fechado (`MP-apertado-*`).
- Autônomo: "vendi 3 bolos a 25 cada", "o cliente me pagou metade, 300",
  "cobrei 150 mas ele não pagou" (a receber, nada registrado), "fiz uma
  faxina e recebi 180" (Freelance — Faxina) (`AU-`).
- "Sábado retrasado" entrava uma semana depois; "hj de manhã" gravava a
  descrição "Manhã" (`DT-sabado-retrasado`, `DT-de-manha`, `DT-a-noite`).
- "Paguei 3 contas: luz 120, água 80 e internet 100" criava uma despesa de
  R$ 3,00; "mais ou menos 200" gravava "Ou menos"; "entre 40 e 50" registrava
  50 sozinho e agora pergunta (`QV-`).
- Motorista: "quanto falta pra eu tirar 300 hoje" perguntava se era ganho
  ou gasto; "em quantas horas eu faço 200" era recusada; "meu carro tá
  bebendo muito?" caía na ajuda (`MT-falta-pra-tirar`, `MT-quantas-horas`,
  `MT-bebendo-muito`). "Tirei 250 bruto e gastei 60" perdia os R$ 250; e
  "180 líquido" virava litros, porque `l\b` casa entre "l" e "í" — as
  unidades de uma letra (h, m, l, x, g, k) ganharam borda explícita em cinco
  padrões (`BR-`).
- Meta: com histórico e sem sobra, a resposta dizia "não tenho histórico";
  agora diz que saiu mais do que entrou e aponta a simulação (`GO-`).
- Gíria: "tô no prejuízo?" (até por extenso), "essa smn", "cadê meu
  dinheiro" (`SG-`).
- "Há 3 dias", "faz 3 dias", "3 dias atrás" datam o lançamento (um dia
  exato). Decisão: semanas, meses, anos e "uns 5 dias" continuam perguntando
  — `hint-03`/`hint-04` mudaram de expectativa e `hint-05..07` travam o resto.
- "Domingo compensa rodar?" e "sábado vale a pena?" (o dia antes) caíam na
  ajuda (`WD-`). "Meu salário é de 3.200" virava receita recebida; "meu
  salário é 3200" e "recebo dia 5" caíam na ajuda — salário declarado é
  previsão; a recorrência de entrada não fala mais em "vencimento" (`RC-`).
  "Atualiza meu saldo pra 5000" respondia o saldo antigo; "meu saldo tá
  certo?" agora explica a âncora e como corrigir (`SD-`).
- "Abasteci 100 de etanol a 3,99" criava dois abastecimentos (R$ 100 e
  R$ 3,99): o leitor de pares telegráficos lia "etanol a 3,99" como outro
  par. Agora é um abastecimento de R$ 100 a R$ 3,99/L. "Enchi o tanque, 250"
  caía na ajuda; o hodômetro gerava "R$ 85.400 mencionado"
  (`AB-etanol-a-preco`, `AB-enchi-o-tanque`, `AB-hodometro-nao-e-dinheiro`).
- Assinaturas: "assinei o youtube premium" gravava o verbo; "cancelei a
  netflix" caía na ajuda e agora diz onde encerrar; "quanto gasto com
  assinaturas" sem registro dizia "R$ 0,00 (0 registros — dado real)" (`AS-`).
- "Quanto paguei de IPTU" respondia "O último foi em 16/08: R$ 2.400,00
  (Reforma do telhado)", como se fosse o IPTU: a palavra vira a categoria
  Casa e a linha não dizia isso. Agora: "O último em Casa foi…". A terceira
  tentativa por palavra-chave (21/11) ficou restrita a combustível. "A casa 1
  dá lucro?" caía na ajuda; sem despesas ligadas à origem, o app diz que não
  dá para afirmar (`IM-`).
- "Peguei 500 emprestado com meu pai" caía na ajuda (é dívida, não receita);
  "paguei 100 do que eu devia pro meu pai" gravava "Que eu devia pro meu pai"
  e agora grava "Dívida com meu pai" (`EP-`).
- "A 99 tá pagando menos?" respondia só o total do mês; agora compara com o
  mesmo pedaço do mês anterior e abre com o veredito (`PG-99-pagando-menos`).
- Um valor para vários itens ("30 no pão e no leite", "50 de luz e água",
  "pão, leite e ovo por 25") gravava um item só na descrição (`IT-`).

Gates (relógio 2026-09-15): 736/736 corpus, 1.414/1.414 adversariais, 151/151
invariantes, mutações, fuzz, ditado e remoto offline; typecheck,
typecheck:api e rubrica (0 perigosa, 0 ruim). `test:calendario` verde depois
de cada lote. Sem push, merge, deploy, APK ou DeepSeek. **NOT READY** até
auditoria independente.

## 22/11/2026 — Revisão do Codex após `4b33876`

Dezesseis commits funcionais até `53ea5af`. O handoff local detalha os
casos reproduzidos, as limitações e os comandos de validação.

- Vacância combina imóvel e duração em um ou mais turnos e aplica somente os
  vencimentos atingidos pela janela. Prazos contraditórios pedem confirmação.
- Vendas por unidade lançam o valor recebido quando a pessoa também diz
  quanto vendeu ou quanto falta. Pagamento parcial de conta recorrente fica
  como movimento avulso e o vencimento segue em aberto.
- O chat distingue valor líquido informado, taxa retida pela plataforma e
  resultado depois de gastos. Preserva a fonte do motorista e a regra de
  quantidade de viagens declarada.
- Saldo zero ou negativo pode ser informado. Contexto de pagamento não
  sobrescreve o caixa. Cenários usam o horário correto da âncora e aceitam um
  saldo hipotético, separado do valor do gasto.
- Parcelas são divididas em centavos inteiros. Compra à vista no crédito
  registra 1x. Pagamentos de duas faturas mantêm a direção e totais
  contraditórios pedem esclarecimento.
- Estorno e cashback seguem o destino do crédito. Transferência para uma
  conta própria mantém o caixa. Desconto em folha fica fora do lançamento
  quando foi informado o salário que entrou.

A suíte chegou a 736 casos de corpus, 1.438 regressões adversariais e 151
invariantes. Testes independentes passaram em São Paulo, Los Angeles e
Kiritimati. No Chrome com dados fictícios, compra manual guardou a data
escolhida e o ditado simulado de uma despesa e um reembolso manteve a data
dos dois lançamentos. **NOT READY**. Voz real, Android, APK e DeepSeek real
continuam pendentes.


## 22/11/2026 — Depois da revisão do Codex (Claude, `2922a2c` em diante)

Quatro correções, cada uma com regressão escrita antes, sobre perguntas
que respondiam outra coisa com número certo:

- **Meta do motorista por período.** "Bati a meta ontem?" e "quantos dias
  bati a meta esse mês?" respondiam o lucro de HOJE. Agora medem o período
  pedido contra a meta de hoje — a mesma régua que a Home usa para o
  déficit de ontem — e dizem que a meta de cada dia passado não fica
  guardada. Sem lançamento no dia, o app cala e diz o que registrar
  (regra 43). "Minha meta de hoje bateu?" começa por sim ou não (regra 57).
  Bloco `MD-`.
- **Gasto contra ganho.** "Gastei mais que ganhei esse mês?" ia para a DSL
  como comparação entre períodos e respondia "Não, ficou igual" — o mês
  comparado com ele mesmo. `GASTO_CONTRA_GANHO` (`query/parse.ts`) manda a
  pergunta para a rota de resultado, que pesa saída contra entrada do mesmo
  período; "ganhei menos do que gastei em agosto?" também. Bloco `GG-`.
- **Déficit nomeado (regra 21).** "Quanto sobrou mês passado" mostrava
  "Resultado: -R$ 202,00", e a simulação de compra dizia "a sobra do mês
  passaria a -R$ 1.953,00". Os dois agora dizem déficit.
- **Lembrete não é lançamento.** "Me lembra de pagar a luz dia 10" caía em
  "não tenho certeza do que registrar"; agora diz que nada foi registrado e
  aponta o Planejamento, onde a conta ganha o aviso de vencimento. Bloco
  `LB-`.

- **Rótulo por unidade.** "Qual meu gasto por km" respondia "Por km: R$ 0,24/km";
  agora diz "Gasto por km", "Recebido por hora" ou "Líquido por km". Bloco `PU-`.
  "Quanto ganhei por hora essa semana" caía no resumo semanal antigo e
  devolvia o total, ignorando o "por hora"; no motorista, por hora e por
  viagem agora passam à frente do roteador antigo, como já passava o por km.

Gates no fim da rodada: `npm test` (736 corpus, 1.447 adversariais, 151
invariantes), os dois typechecks, `test:money`, build sem `sk-` em `dist/`,
rubrica 0 PERIGOSA / 0 RUIM e a matriz de oito datas. **NOT READY**; nada
foi enviado ao GitHub. Voz real, Android, APK e DeepSeek real continuam
pendentes.

### 22/11/2026 — segunda janela (Claude, depois de `84c25e0`)

Sondas por perfil, cada defeito com regressão antes da correção:

- **Valores que sumiam ou viravam outra coisa.**
  - "Paguei o pedreiro 600 conto E MAIS 180 de areia" virava CONSULTA ("Total gasto - Areia"), e as duas despesas sumiam. O leitor de valor no fim aceita a continuação, e relato no passado sem pergunta não é mais aceito como consulta (`EM-`; caso de avaliação c-02 agora é local).
  - "O João ME pagou 300" sumia como movimento de terceiro (`MP-`).
  - "Paguei 100 pro João e 50 pra Maria" e "dei 100 pra minha mãe e mais 50 pro meu pai" perdiam o segundo valor.
  - "A uber me pagou 1200 na semana", "a uber pagou 1200" e "a 99 me pagou 800 essa semana" caíam na ajuda (`UP-`).
  - "Recebi o aluguel da casa 2, 1200" caía na ajuda, e "a casa 1 atrasou o aluguel" perguntava por R$ 1,00. Número que só nomeia o imóvel não é valor (`CN-`).
  - Gírias e formas faladas: "gasosa" é gasolina, "passei 120 no débito" é despesa, "meu 13" é o décimo terceiro.
- **Respostas sobre outra coisa.**
  - "Quanto gastei de ifood" dava o total de Alimentação. Marca é estabelecimento, não classe (regra 41; `IF-`).
  - "Quando acaba o parcelamento do celular" respondia sobre o Computador (`PN-`).
  - "Em quanto tempo junto 10 mil" respondia sobre a primeira meta (`JM-`).
  - "Ganhei mais na uber ou na 99?" e "quanto ganhei na uber e na 99" davam só o total da Uber (`PL-`).
  - "Qual dia eu rodo mais km / fiz mais corridas / trabalho mais horas" respondia em reais ou por lucro (`RK-`).
  - "Tô ganhando menos que o normal?" media as DESPESAS. A métrica agora segue o verbo e a régua é a fatia real do mês anterior, não uma proporção — a proporção chegava a inverter a conclusão de quem recebe aluguel em dia fixo (`RT-`).
  - "Minha média por km" do motorista era o custo (`PU-`).
- **Uma régua só.**
  - "Quero juntar 5 mil até dezembro, dá?" criava a meta "Objetivo"; agora responde sim ou não.
  - A projeção da meta ("quanto falta pro notebook") e a viabilidade ("consigo completar até dezembro?") usam a mesma média dos meses completos (`sobraMedia`). O motorista mantém a projeção diária (regra 2).
- **Forma da resposta.**
  - "Meu saldo tá negativo?" começa por sim ou não, e "por dia até o salário" usa o prazo do salário (`SN-`).
  - Empate exato é dito como empate.
  - Cabeçalho agrupado diz o período.
  - Cartão aparece com a grafia cadastrada.
  - Correção de origem usa a grafia do histórico (`GR-`).
  - "Não, 280" corrige o valor, e "foi etanol" explica que o tipo não é guardado (`CR-`).
  - "IPTU da casa 2" sem "Da".

O invariante de preferência passou a ensinar "suco" em vez de "gasosa", que agora é nativa.

Continuação da segunda janela (depois de `4fcd62c`):

- **Pergunta pendente não engole o próximo lançamento.** Depois de "você
  devolveu os R$ 100?" ou "em qual dessas datas?", um relato novo ("gastei
  50 no mercado", "recebi 200 do João") repetia a pergunta, e o dinheiro novo
  se perdia. O fato novo derruba a pergunta e é lido do zero; "sim", "não" e
  a data continuam respondendo (`PQ-`).
- **Pergunta não edita a proposta.** "O que tem na fatura do Inter?", com o
  pagamento do Nubank na tela, trocava o cartão; mensagem que começa com
  palavra de pergunta não entra no leitor de correção (`CQ-`). Com proposta
  na tela, "qual a categoria?" explica a categoria dela.
- **Conferência não é lançamento (regra 33a).** "Rodei 30 mil km esse ano?"
  propunha 30.000 km de trabalho hoje; "gastei 500 esse mês?" propunha uma
  despesa descrita "Esse mês". Agora viram a consulta do período (`CF-`).
- **Período.** "Desde segunda" e "de sexta pra cá" vão até hoje; "nessa
  quinzena" é a metade corrente; "no dia 4 do mês passado" é aquele dia; a DSL
  ganhou o agrupamento `monthday` ("qual dia do mês eu mais gasto"), e as
  linhas de ranking dizem o período (`PD-`, `DM-`).
- **Período do dia.** O app guarda a hora do REGISTRO, não do fato: "quanto
  ganhei de manhã" e "ontem à tarde" respondem o dia inteiro e dizem isso
  (`PDIA-`).
- **Sem dado, sem número.** "Como tá meu mês" e "quanto ganhei" com o mês
  vazio diziam "R$ 0,00" como conclusão (regra 43; `VZ-`).
- **Valores.** "Comprei 2 pizzas de 45" virava R$ 2,00 e agora pergunta se
  é cada ou total; "12,50+8" é um valor só, via `parseMoney`; "a casa 2 pagou
  1200 mas atrasou 3 dias" não pede para lançar os "3 dias" (`QT-`, `DU-`).
- **Veículo.** "Meu carro tá com 207 mil km" é hodômetro; hodômetro menor que
  o registrado avisa na proposta; "quanto custa meu carro por mês" chega ao
  custo do veículo (`VC-`).
- **Abreviação.** "c" é "com" ("gastei qnto c mercado").

Lição de processo: um script Python sem string raw gravou `\b` como
backspace (0x08) em `period.ts` — o caso exato da regra 59. Varredura do
repositório inteiro depois disso: nenhum outro caractere de controle.

Pendente desta leva: "quanto gastei hoje?" com uma despesa ainda na tela não
lembra que ela não foi confirmada.

Fim da segunda janela (depois de `34af349`):

- **Rascunho aberto não engole o relato seguinte.** Depois de "recebi meu salário" → "qual foi o valor?", "gastei com uber 25 e ifood 40" virava R$ 25 de salário. "Recebi 3500" continua respondendo o rascunho (`RD-`).
- **Sem divisão por plataforma do que não é por plataforma.** "Quanto rendeu a uber por hora" dividia a Uber pelas horas de todas as plataformas e chamava de dado real. Agora explica por que não calcula. "Qual app paga melhor" e "vale a pena rodar de 99 ou uber?" mostram a divisão por plataforma. "Fiz 200 na uber em 5 horas" guarda as horas (`PH-`).
- **Dívida e investimento.**
  - "Tô endividado?" começa por sim ou não.
  - "Devo quitar o cartão ou guardar?" mostra os dois lados sem inventar taxa.
  - "Consigo pagar tudo esse mês?" é a cobertura pelo saldo.
  - "Quanto pago de juros" diz que juros não são separados (`DV-`).
  - Pedido de recomendação de investimento é recusado no aparelho (o app não é consultor) e não vai à IA remota.
  - "Investi 1000 no tesouro" vira reserva (`IV-`).
- Mantido de propósito: "gastei 45 de gás" pergunta "cozinha ou GNV?" em todos os perfis. Autônomo também tem carro a GNV. Uma tentativa de remover a pergunta foi revertida pelos casos `crit-gas`/`gas-0x`.

Gates em `956ac72` (antes destes três lotes): `npm test` (736, 1.524, 151), typecheck, typecheck:api, test:money, build sem `sk-`, rubrica 0 PERIGOSA / 0 RUIM e a matriz de oito datas. Depois, `npm test` passou em `b5c114c` com 1.531 regressões. **NOT READY**.

## 22/11/2026 — Revisão do Codex com foco no motorista

O trabalho local começou em `d442f3b` e fechou a revisão de código em `09780e8`, na branch `feat/assistant-intelligence-v2`. A matriz também passou em `d442f3b`, incluindo o ajuste original de GNV.

- Resumos de jornada preservam centavos, litros, km decimais e durações como “8h30”. O subtotal informado só confere as receitas. Números sem contexto, dias conflitantes e medidas inválidas pedem esclarecimento. A confirmação continua necessária.
- Relatos de repasse mantêm o valor recebido, o dia e o aplicativo. “A 99 me pagou 400 com taxa de 20, caíram 380” propõe R$ 380 com a taxa já retida. Um dia com bruto e líquido incertos mantém a jornada visível e pede o dinheiro que entrou.
- Ofertas de corrida e comparações ficam em modo de análise. O chat distingue a ida do retorno e recalcula com o tempo ou valor acrescentado. R$ 30 em 16 km e 25 min com custo de R$ 0,50/km dão R$ 22 de lucro estimado e R$ 52,80 por hora.
- Ganhos por hora e km cruzam receitas de corrida com as medidas registradas nos mesmos dias. O líquido desconta os custos de rodagem cadastrados. O padrão diário mostra a amostra de cada indicador. Consultas entre apps respeitam o período e mostram diferenças em reais. Horas, km e viagens continuam registrados por dia, sem atribuição a apps individuais.
- Consultas factuais mantêm a proposta aberta e avisam quando ela muda o total. Uma inclusão explícita vira simulação. “E ontem?” mantém o tipo de lista, último movimento ou comparação por app. A escolha de gás preserva a data, o horário e os outros registros do relato.
- Vacância lê o nome cadastrado, datas de início e fim e os vencimentos no intervalo. Simulação de pagamento com a reserva pede o saldo disponível após resgate.

Em `09780e8`, `npm test` passou com 736 casos do corpus, 1.554 regressões reais e 151 invariantes. A matriz das oito datas passou. Também passaram os dois typechecks, `test:money`, o build e 5.184 verificações independentes em três fusos. A rubrica teve 0 respostas perigosas e 0 ruins em 90. Os fluxos no Chrome passaram em viewport padrão e móvel com reconhecimento de voz simulado.

No ajuste complementar `99585a0`, o chat reconhece “tirou 20 de taxa”, “me passou 380 depois de descontar 50” e “vale a pena a de 30 por 8 km ou a de 80 por 25 km?”. A validação repetida passou com 1.555 regressões, matriz nas oito datas e os mesmos resultados na rubrica e nas sondas independentes.

**NOT READY**. Voz real, Android, APK, DeepSeek real e publicação continuam pendentes. O agrupamento `monthday` ainda depende de redeploy autorizado para chegar ao planejador remoto.

## 22/11/2026 — Rodada do Claude no motorista (fala de fim de turno)

Sondas de conversa em vários turnos, como a tela (`pending`, `pendingClarification`, `draft`, `focus`), com o fixture rico e com estado vazio. Cada defeito ganhou um caso que falhava antes. Os blocos estão em `adversarial-real.ts`: `TU-`, `TV-`, `TW-`, `TX-`, `TY-`, `TZ-`, `UA-` e `UB-`.

Defeitos que davam número errado com cara de certo:

- "O painel marca 45320" e "bom dia, painel 45000" viravam R$ 45.320 sem ação, ou R$ 45.000 de faturamento. O painel é o hodômetro, e a saudação não é resultado do dia.
- "Revisão dos 50 mil 900 reais" virava despesa de R$ 50.000. O número é o marco da revisão.
- "Quanto tô tirando por km" respondia o GASTO por km.
- "Quanto tá o litro" respondia o volume (96 L). Agora dá o preço do último abastecimento e a média do período.
- "Quantas corridas faço por dia" saía como "R$ 13,20 por dia". O mesmo erro valia para km e horas.
- "Posso gastar quanto hj?" (o exemplo da ajuda, invertido) respondia o total GASTO hoje.
- No motorista, o objetivo de lucro do mês saía do saldo como "meta de guardar" (regra 4).
- O valor do combustível virava também uma receita de corrida.
- "O carro me deu 200 de prejuízo" virava receita.
- "Quanto gastei de gasolina se a gasolina estivesse 7 reais" respondia o gasto real e ignorava a hipótese.
- O mínimo por km tinha fórmula própria (R$ 0,98) diferente da tela Veículo (R$ 0,96). Sem custo nenhum, inventava R$ 0,50. Agora usa `kmCost` (regra 58) e cala sem dados.

Perguntas que caíam na ajuda, num filtro de texto ou em outra pergunta:

- **Unidade e elipse.** "E por km?" e "e por corrida?" depois de uma medida por hora. "Meu lucro por km" e "lucro por corrida" sem verbo. "Quanto sobra por km depois da gasolina".
- **Meta do dia.**
  - "Tô batendo a meta hj?" agora responde sim ou não.
  - "Quanto falta pra fechar o dia" antes respondia sobre parcelamento.
  - "Se eu fizer mais 3 corridas de 25 eu bato?" é calculado com os números da frase.
  - Sem objetivo configurado, o app diz isso em vez de "meta de R$ 0,00".
- **Meta do mês.** Quanto falta para o objetivo de lucro, quanto por dia de trabalho restante (com a diferença para a meta diária explicada) e quantos dias faltam.
- **Turno inteiro.**
  - Relato telegráfico ("hj 190km 10h 22 corridas", "rodei 10h, 190km") guardava as corridas e perdia km e horas.
  - "Até agora" e "por enquanto" marcam o resultado parcial do dia.
  - "Fui no mercado e gastei 80" usa o assunto dito antes do verbo.
  - "Fechamento do dia" e "resumo de hoje" respondem o dia.
- **Plataforma.**
  - "E na Uber?" depois da 99 troca a plataforma. Antes, o app dizia que não havia lançamento.
  - "Qual rendeu mais?" compara as plataformas, e "quanto fiz em cada app" separa por app.
  - "A Uber ficou com 80" e "me descontou 25%" perguntam o líquido recebido.
  - "400 bruto 310 líquido" registra os 310. Sem plataforma, "limpo" continua perguntando (decisão do Codex).
  - Gorjeta, bônus, promoção e taxa de cancelamento são receita de corrida.
- **Veículo.**
  - Custo do carro respeita o período dito (hoje, ontem, esse mês, mês passado).
  - "Quanto tá custando meu km rodado" é custo, não o total de km.
  - "Fiz alinhamento e balanceamento 120" é manutenção.
  - Abastecimento repetido recebe aviso de duplicidade.
- **Hipóteses.**
  - "E se a gasolina subir pra 7 reais?" é simulado.
  - "Se eu trocar pra um carro que faz 15 km/l" simula o consumo novo contra o atual (campo `kmPerLiter` no cenário).
  - "Tenho dinheiro pra trocar o pneu de 600?" simula com sim ou não; sem preço, mostra o saldo e pergunta o valor.
- **Diversos.**
  - "Qual horário rende mais" explica que a hora das corridas não é guardada.
  - "Tô rodando no prejuízo?" e "tá compensando rodar?" respondem sim ou não com o sinal certo para cada forma.
  - "Qual a taxa da 99?" mostra a taxa de saque configurada e as lançadas.
  - "Uma de 40 pra 30 km, vale?" é oferta.
  - "Gastei mais de gasolina esse mês que no mês passado?" compara e diz sim ou não.

Gates em cada lote: `npm test`, typecheck, typecheck:api, rubrica (0 PERIGOSA, 0 RUIM) e a matriz das oito datas. Três oráculos foram afrouxados com justificativa no próprio caso:

- `TY-` aceita "Dá, mas aperta".
- `TZ-` aceita a falta de veredito quando o período comparado está vazio.
- `H-como-foi-hoje-ontem` aceita o número real de ontem quando hoje está vazio.

**NOT READY**. Também ficaram de fora: categoria própria para aluguel ou diária de carro de app, e correção por chat de horas de trabalho já salvas.

### 23/11/2026 — continuação da rodada do motorista (`UC-` … `UF-`)

- **Contagem em dobro.**
  - "Fiz 300 hj, 250 na uber e 50 na 99" e "gastei 100 hj, 60 de gasolina e 40 de almoço" lançavam o total e as partes. Agora, quando o valor genérico fecha no centavo com duas ou mais partes nomeadas do mesmo dia, ficam só as partes, e a resposta avisa. Total diferente da soma continua como está.
  - "Gastei 150 no total: 90 gasolina e 60 lavagem" e "entrou 500: 300 uber, 200 99" leem a lista.
  - "Abasteci 2x hoje, 100 e 80" são dois abastecimentos; antes era um de R$ 2,00.
- **Herança errada de sentido.** "E 15 de água" com uma receita na tela virava receita. "E 50 de gorjeta" depois de um gasto virava gasto.
- **Plataforma e origem.**
  - "A uber caiu 820 da semana", "repasse da 99 caiu 650" e "ganhei 1200 essa semana na uber" mantêm o app.
  - "Passageiro pagou 35 no pix" é corrida.
  - "Peguei um uber de 30" é gasto de passageiro.
  - "Quanto recebi de bônus" filtra o tipo, não uma origem chamada "Bonus".
- **Contagens que respondiam dinheiro.**
  - "Quantos dias eu rodei", "quantas folgas tirei" e "quantos dias de folga tenho por semana" (pela configuração) agora contam dias.
  - "Quanto tá o hodômetro" e "qual o km do meu carro" respondem a leitura do hodômetro.
- **Elipses e telegráficas.**
  - "E o lucro?" e "e os gastos?" trocam a medida no mesmo período.
  - "Qnto preciso fazer hj" é a meta do dia.
  - "Gasolina tá pesando quanto no meu faturamento" é a participação do combustível.
  - "Média por mês" diz se é de gastos ou de receitas; três oráculos antigos foram ajustados para o rótulo novo.
- **Avisos de folga.** "Hj não rodei, folga" e "carro na oficina" são reconhecidos sem lançar nada; a oficina pede o custo.

Uma execução da matriz reprovou o fuzz por tempo (327 ms contra o teto de 246 ms numa entrada de 60 dígitos). Repetida sem sondas rodando em paralelo, passou (pior caso de 106 ms). Era carga da máquina: não rodar sondas durante a matriz.

Depois, ainda em 23/11 (`UG-` … `UI-`):

- **Alvo dito contra o ritmo medido.**
  - "Quantas corridas preciso pra fazer 300", "quantos dias preciso rodar pra juntar 2000" e "quanto preciso rodar pra pagar a parcela de 1200" eram recusadas.
  - Agora dividem o alvo pelo ritmo dos últimos 30 dias: a sobra, para juntar ou pagar; o faturamento, para fazer ou tirar.
  - Sem amostra, o app não estima.
- **Totais de dois dias.** "Quanto rodei ontem e hoje" soma km e viagens, não só dinheiro.
- **Sugestões da tela.**
  - Sem lançamentos, "Como está meu mês?" diz isso em vez de "lucro de R$ 0,00 (meta R$ 0,00)".
  - "Como está minha meta?" não é tratada como sim ou não.
  - Resultado negativo no resumo é déficit.
- **Tipo de combustível.**
  - O abastecimento ganhou o campo opcional `fuelType`.
  - "Não, foi etanol" com a proposta na tela anota o tipo, e "abasteci 100 de etanol" já nasce com ele. Gasolina é o padrão e não é anotada.
  - O registro guarda o tipo, e o preço do litro passa a dizer de qual combustível é.
  - O caso `CR-tipo-de-combustivel` foi atualizado: antes exigia a explicação de que o tipo não era guardado.
  - Como o catálogo de ações mudou, o prompt remoto só recebe o campo depois de um redeploy autorizado.

Ainda abertos:

- categoria para aluguel ou diária do carro de app;
- "1000 de cada casa";
- correção pelo chat de horas de trabalho já salvas.

## 25/11/2026 — Bateria local do assistente (`ZJ`, `ZK`, `ZL`)

### Ditado de fim de jornada

- “xei 8 h de volante com 320 de corrida e 90 de gasosa hj” recupera as 8h, a receita de R$ 320 e o abastecimento de R$ 90 no dia.
- “xei oito horas de volante com trezentos e vinte de corrida e noventa de gasolina ontem” preserva os três fatos por extenso e a data de ontem.
- “hj xei 8h no volante com 320,50 de corridas e 90,25 de etanol” preserva os dois valores com centavos, as 8h e o etanol.
- “fechei 8 hrs no volante c/ 320 de corrida e 90 de gasoza hj” recupera o abastecimento de R$ 90 e mantém os outros dois fatos.
- “fechei 8 h no volante e ganhei 320 de corrida e gastei 90 de gasosa ontem” inclui a jornada de 8h, que desaparecia antes.
- “fechei 8h no volante com 320 de corrida e 90 de gás hj” pergunta especificamente pelo tipo de gás e mantém a receita e as 8h.
- “fechei oito horas de volante com trezentos e vinte de corridas e noventa de gas ontem” faz o mesmo com números ditados e mantém ontem.
- “foi GNV” e “foi botijão” completam, respectivamente, um abastecimento de GNV ou uma despesa de casa de R$ 90. A confirmação continua no botão.
- “fechei 8h no volante com 320 de corrida e 90 de gás de cozinha hj” separa os R$ 320 de receita e os R$ 90 de despesa de casa.

### Correções em proposta

- “tira só as horas” apaga só esse campo e preserva os km e as viagens.
- “tira a km”, “tira só os 170 km” e “sem os km, mandei errado” retiram apenas a distância.
- “tira os km de ontem” usa o dia indicado para selecionar a jornada.
- “tira as horas”, com duas jornadas, pede qual delas. “2” escolhe a segunda e preserva a primeira.
- “tira só os km”, numa jornada que só tem horas, e “tira 100 km”, quando o proposto é 170 km, pedem um alvo sem alterar a proposta.
- “99 foi cento e cinquenta e cinquenta centavos” atualiza a 99 para R$ 150,50 e preserva a data.
- “foi 150 de noventa e nove” e “troca a 99 pra 150” corrigem só a receita da 99.
- “a da ubber foi 260” corrige só a receita da Uber.

### Datas por item

- “terça passada ganhei 210 da Uber e quinta passada 175 da 99” mantém a data de cada app.
- “terça passada ganhei 210 da Uber e quinta passada ganhei 175 da 99” funciona também quando o verbo é repetido.
- “sexta-feira passada ganhei 210 da Uber e quinta-feira passada 175 da 99”, em 02/01, mantém as duas datas na virada do ano.
- “sábado ganhei 210 da Uber e domingo 175 da 99”, no 1º dia do mês, usa as duas datas do mês anterior.
- “abasteci etanol 78,50 ontem e gasolina 90,25 hoje” guarda o tipo, o valor e a data de cada abastecimento, inclusive na virada do ano.
- “abasteci etanol 78,50 ontem e abasteci gasolina 90,25 hoje”, “abasteci 78,50 de etanol ontem e 90,25 de gasolina hoje” e “abasteci 78,50 de etanol ontem e gasolina 90,25 hoje” mantêm os mesmos dados.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último fechou com 1.882 regressões adversariais na data padrão. O projeto segue **NOT READY**.

### Consultas por app (`ZM`)

- “na 99 qtos km nessa semana?” e “só na uber quanto eu rodei ontem?” explicam que a quilometragem disponível é do dia inteiro.
- “quanto a uber pagou por corrida comparado com a 99?” explica a falta de contagem de viagens por plataforma.
- “qual app deu mais corridas mês passado?” deixa de mostrar um ranking de receitas e explica a granularidade das viagens.
- “dividindo pelas horas de ontem qual foi a média da 99?” explica a granularidade das horas. Antes, mostrava a média por lançamento.
- “quanto caiu por dia da Uber este mês?” usa o rótulo de receita e a média dos dias corridos do período.
- “quanto mais a uber deu comparado com 99 esse mês?” usa os dois apps do mesmo mês para calcular a diferença.

### Aluguéis (`ZN`)

- “os 2 alugueis das casas 1 e 2 foram 1000 cada” propõe uma receita de aluguel de R$ 1.000 para cada casa.
- “recebi R$ 1.000 de cada uma das casas 1 e 2 ontem” mantém os dois recebimentos ontem. Os identificadores das casas não viram dinheiro.
- “anteontem recebi mil reais de aluguel de cada uma das casas 1 e 2” preserva os valores ditados e a data.
- “recebi 1k de cada casa” pergunta quais pagaram. “Casa 1 e Casa 2” completa a proposta, que continua exigindo confirmação.
- “os 3 alugueis das casas 1 e 2 foram 1000 cada” pede que a pessoa corrija a quantidade ou a lista. A frase negativa não vira receita. Um valor dito como total não é multiplicado.

### Ofertas (`ZO`)

- “qual paga mais por km 50 por 20 km mais 5 de volta ou 45 por 20 km no total” inclui os 5 km de retorno na primeira oferta. A segunda paga mais por km.
- “uma de 28 incluindo a gorjeta de 5, 12km ida e volta, vale a pena?” usa R$ 28 no total, incluindo os R$ 5 de gorjeta.
- “quanto por hora dá corrida 37 pra 7 km e 20 min só com passageiro?” analisa a oferta e pede o tempo total para calcular por hora.
- “se aceitasse 35 por 6 km e meia hora, quanto ia tirar por hora?” calcula R$ 70/h brutos no período informado em estado sem custos cadastrados.
- “oferta de noventa reais por dezoito km no total e uma hora e quinze totais compensa?” reconhece 75 min e calcula R$ 72/h brutos em estado sem custos cadastrados.

Cada lote passou pelos cinco comandos na ordem combinada. No último, `npm test` passou com 1.897 regressões adversariais, os dois typechecks passaram, a rubrica ficou em 0 PERIGOSA e 0 RUIM e a matriz passou nas oito datas.

### Transcrições com cortes, muletas e medidas (`ZP`)

- “então eu fechei sete horas e meia hoje e deu trezentos de corrida” mantém a meia hora. A proposta contém 7h30 e R$ 300 hoje.
- “trabalhei sete horas e cinqüenta e faturei 350” deixa de perguntar sobre R$ 50. Esse trecho já está na jornada de 7h50.
- “fechei 8h no volante com 320 de corrida e 90 de gasosa e aí” reconhece os três fatos completos antes do conector final.
- “no volante oito horas e no fim trezentos de corrida noventa de gasosa” mantém as 8h, os R$ 300 de receita e os R$ 90 de combustível.
- “é tipo foi cento e noventa km e mais umas seis horas no volante” propõe só a jornada de 190 km e 6h. Antes, também inventava R$ 190 de despesa.
- “ontem eu fiz tipo trezentos e quarenta na Uber e a noventa e nove entrou cento e vinte” guarda R$ 340 da Uber e R$ 120 da 99 ontem.
- “QUATROCENTOS E QUARENTA E TRÊS E OITENTA CENTAVOS DA UBBER HJ” guarda a plataforma e os R$ 443,80.

### Consultas sobre propostas (`ZQ`)

- “isso deu quanto líquido?” mostra os R$ 215 só da proposta com R$ 300 de receita e R$ 85 de combustível.
- “se confirmar como fica o lucro de ontem?” projeta o lucro de ontem com os registros propostos.
- “quanto sobrou ontem contando os R$ 300 da proposta?” projeta somente o item de R$ 300. Com dois itens de R$ 300, pede identificar qual incluir.
- “contando a proposta, qual foi o lucro de ontem?” aceita o escopo antes da pergunta. As quatro frases preservam a proposta e nenhuma aplica seus itens.

### Negação e exemplos (`ZR`)

- “rodo 8 horas por dia, fiz -120 na 99” e “recebi menos 15 da Uber, debitou taxa de cancelamento” perguntam o que aconteceu com o valor negativo. Antes, os sinais eram descartados e viravam receitas positivas.
- “fiz -120 na 99 e gastei 20 de almoço” prepara somente o gasto afirmado e aponta o valor negativo separadamente.
- “hoje não gastei 100 nem abasteci 90 só paguei 20 de almoço” prepara só R$ 20 de almoço hoje.
- “isso é um teste: recebi 930 da uber e paguei 120 de gasolina” e “só quero testar a frase gastei 120 de gasolina” não preparam lançamentos.
- “a frase ‘foi 400’ é exemplo” mantém a proposta anterior sem criar uma despesa de R$ 400.
- “isso é um teste: recebi 930 da Uber e paguei 120 de gasolina. De verdade gastei 22 de almoço” preserva apenas os R$ 22 afirmados após o exemplo.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. Na data padrão, o último passou com 1.911 regressões adversariais. O projeto segue **NOT READY**.

### Digitação abreviada (`ZS`)

- “FEXEI 7H NO VOLANTI C/ 280 DE CORRIDA E 79,50 D GASOZA ONTI” propõe 7h, R$ 280 de receita e R$ 79,50 de combustível ontem.
- “onti pg 85 d etanou e recebi 240 na ubber” propõe R$ 85 de etanol e R$ 240 da Uber ontem.
- “gstei 80 d disel na volta de ontem” e “colokei 80 de disel omtem” classificam R$ 80 como diesel e mantêm ontem.
- “gastey 95 d combustivel anteont” preserva anteontem para o abastecimento de R$ 95.
- “rcebi trezentos e cinco da ubber ontem” preserva R$ 305 da Uber ontem.
- “entrou 300 na uebr hoje e abast 80 de gasoza” preserva a Uber, o combustível e hoje.
- “gastei oitenta e 50 ctvs de gasoza hj” propõe R$ 80,50 de combustível hoje.
- “hj caiu 210,50 da uber e 99 ainda n/ pagô 145,25” propõe só R$ 210,50 da Uber e explica os R$ 145,25 pendentes da 99.
- “qnts hrs eu trabahei hj???” consulta as horas e “quanto a ubber me repaçou na semana passada?” consulta a receita da Uber naquela semana.

### Repasses recebidos e pendentes (`ZT`)

- “a 99 n me depô 150 e 240 caiu da ubber hj” e “99 não pagou 150 e 240 entrou da Uber hoje” propõem só R$ 240 da Uber hoje e dizem que a 99 ainda deve R$ 150.
- “150 da 99 ainda não caiu e 240 entrou na Uber ontem” e “a 99 não pagou 150 mas a Uber depositou 240 ontem” preservam ontem para o recebimento.
- “o inDrive ainda não pagou 75 e a 99 pagou 210 hoje” separa o recebimento de R$ 210 da 99 e o repasse pendente de R$ 75 do inDrive.
- “80 do inDrive só amanhã e 245,75 da Uber entrou hoje” propõe apenas R$ 245,75 da Uber hoje.
- “240 da Uber entrou ontem, mas a 99 não pagou 150” reconhece o recebimento e a dívida mesmo na ordem inversa.
- “a 99 não me pagou 150 e quanto caiu da Uber ontem?” explica a pendência e consulta o histórico da Uber, sem proposta.
- “deu 800 de corridas e 150 de gasolina, mas 300 ainda não caiu na conta” pergunta se os R$ 300 estão no total de R$ 800. “Foi por fora” mantém os R$ 800 de receita, e “tá dentro dos 800” propõe R$ 500. As duas respostas mantêm R$ 150 de combustível.

### Correções de combustível e jornada (`ZU`)

- “troca o combustível pra diesel” e “foi gasolina, não etanol” trocam o tipo do abastecimento sem alterar o valor ou a data.
- “o etanol saiu 90”, “etanol foi 90 e não 85” e “o de etanol foi 90,25” mudam o valor do abastecimento e preservam os outros itens.
- “o combustível foi ontem” altera só a data do abastecimento. “A gasolina foi anteontem”, com apenas etanol na proposta, pede o alvo e preserva os itens.
- “tira só o etanol” e “tira o diesel de ontem” retiram apenas o item identificado por tipo e data.
- “tira combustível só de ontem”, quando o abastecimento é de hoje, pede o alvo sem remover o item.
- “troca o combustível pra GNV”, com dois abastecimentos, pergunta qual. “2” altera apenas o segundo.
- “tira as viagens mas mantém os kms” tira a contagem de corridas e preserva a distância, as horas e os outros itens.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 1.935 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria: consultas com data de corte e mais de uma janela.

### Consultas com data de corte e dias separados (`ZV`)

- “quanto fiz no mês até ontem?” e “quanto entrou este mês tirando hoje?” excluem hoje do total.
- “quanto gastei do início do mês até ontem?” respeita o início do mês e a data de corte.
- “receita da Uber esse mês até ontem” soma apenas a Uber na janela solicitada.
- “quanto fiz no mês passado até o dia 20?” restringe o mês anterior aos seus primeiros 20 dias.
- “quanto gastei esse mês até dia 15?” encerra a consulta no dia 15.
- “quantas corridas fiz essa semana até ontem?” mantém a janela semanal e exclui hoje.
- “quanto fiz desde o dia 1 até ontem?” usa os dois limites ditos.
- “qual foi o lucro dos dias 20 e 22?” e “quanto ganhei nos dias 20 e 22 de novembro?” mostram os dois dias e o total sem incluir o dia 21.

### Pagamentos parciais fora do perfil motorista (`ZW`)

- “cliente João me deu 200 de sinal e os outros 300 só no mês que vem” prepara R$ 200 já recebidos do Cliente João e informa os R$ 300 pendentes.
- “recebi 200 do Cliente João e os outros 300 só amanhã” mantém o recebimento de R$ 200 e deixa os R$ 300 futuros fora da proposta.
- “recebi 300 de entrada da Cliente Lia e o restante em dezembro” mantém R$ 300 recebidos e informa que o restante segue pendente, sem inventar valor.
- “o cliente João pagou 150 agora, falta 250” separa os R$ 150 recebidos dos R$ 250 pendentes.
- “recebi 250 de locação hoje, ainda faltam 150” propõe R$ 250 de aluguel hoje e informa os R$ 150 pendentes.
- “a Casa 2 me pagou 900, falta ela completar mais 300” mantém a Casa 2 como origem dos R$ 900 propostos e informa os R$ 300 pendentes.
- “paguei 200 de manutenção, só faltam 300 de outra conta” prepara somente o gasto de R$ 200.
- “paguei 100 pro pintor e ainda falta 80” prepara o gasto de R$ 100 e informa os R$ 80 pendentes.

### Custos nas ofertas de corrida (`ZX`)

- “corrida 45 menos 5 de pedágio por 15km no total vale a pena?” e “corrida de 45 por 15 km no total, pedágio de 5 por minha conta, compensa?” mantêm a tarifa de R$ 45 e descontam R$ 5 do lucro estimado.
- “pago 5 de estacionamento e recebo 45 nessa corrida de 15 km, vale?” separa a tarifa do gasto mesmo com o gasto primeiro. “Corrida de 38 por 10 km total, quanto fica líquido descontando estacionamento de 4?” também deduz o estacionamento.
- “50 bruto com taxa de 10 e 8 km total vale a pena?”, “corrida de 40 menos 5 da taxa da 99, 10 km, compensa?” e “vale 70 menos 10 de taxa por 25km no total?” deduzem as taxas informadas. A plataforma 99 não vira dinheiro.
- “proposta de 45 por 15km no total já descontado o pedágio de 5, compensa?” evita descontar a mesma taxa duas vezes. “Corrida de 45 por 15 km e pedágio de 5 pago pelo passageiro, compensa?” e “corrida de 46 e o passageiro me reembolsa 7 do pedágio, compensa por 12km?” explicam quem cobre o pedágio.
- “a corrida de 45 tem pedágio de 5, compensa por km com 15 km?” pede quem cobre o pedágio. “Já descontou” mantém a tarifa de R$ 45.
- “corrida de 45 por 15km no total não vou pagar 5 de pedágio, compensa?” deixa o pedágio fora dos custos. Com “só pago 5 de pedágio se for pela rodovia”, pergunta e espera “é por minha conta” para deduzir R$ 5.
- “corrida de 45 por 15km no total, pedágio de 5 por minha conta, vai?” calcula a oferta sem propor receita ou jornada.
- “qual corrida dá mais lucro total, a de 40 por 12km pagando 10 de pedágio ou a de 35 por 12 km no total?” preserva as duas tarifas e aponta a segunda pelo lucro.
- “e pedágio de 5 que vou pagar”, depois de uma oferta com 15 km e 30 min, recalcula o lucro total e por hora sem pedir novamente distância ou tempo.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 1.967 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria com consultas que pedem mais de uma métrica, data ou plataforma na mesma frase.

### Consultas independentes na mesma frase (`ZY`)

- “quanto caiu da 99 ontem e quanto caiu hoje?” responde pelos dois dias usando a 99. “E ontem?” retoma a plataforma, preservando a proposta aberta.
- “quanto entrou na segunda e quanto saiu na terça?” aplica a data e o sentido de cada pergunta.
- “receita de ontem e despesa de hoje” e “ontem gastei quanto e hoje quanto?” respondem na ordem pedida, inclusive sem verbo inicial ou com o verbo omitido na segunda pergunta.
- “quanto ganhei na Uber ontem e na 99 hoje?” aplica a data indicada a cada plataforma.
- “corridas de ontem e km de hoje”, “quanto rodei ontem e quantas horas hoje?” e “quantas corridas e quantos km ontem?” separam as medidas e respeitam a data própria ou compartilhada.
- “qnto entrou dia 20 e qnto saiu dia 22?” usa os dois dias do mês, sem trazer o mês inteiro. “O lucro de ontem e o lucro de anteontem” devolve os dois resultados diários.
- “quanto entrou ontem da Uber quanto entrou hoje da Uber” reconhece a segunda pergunta na transcrição sem conector.
- “quanto a Uber repassou na semana passada e quanto a 99 entrou nessa semana?” mantém as plataformas e as janelas distintas.
- “me diz quanto ganhei ontem e quanto a Uber repassou hoje” separa o total geral do valor da Uber.
- “quanto caiu na 99 ontem e quanto caiu hoje somando todos os apps?” separa a 99 de ontem do total de hoje nas plataformas identificadas, sem somar corrida particular.
- “quanto entrou ontem e quantos km hoje na Uber?” responde a receita e explica que a quilometragem disponível é do dia inteiro.
- “quanto entrou da Casa 1 dia 5 e quanto saiu de obra dia 4?” mantém origem, categoria e datas para o autônomo.

### Correções que selecionam o item pelo valor (`ZZ`)

- “os 85 foram hoje” e “foi hj os oitenta e cinco” mudam somente a data do abastecimento de R$ 85, mesmo com duas receitas e a jornada na tela.
- “os 240 foram hoje”, “só os 130 de hoje” e “os 130 foram dia 20” alteram só a receita identificada pelo valor.
- “hoje não, só o de 85 foi anteontem” usa a data afirmada. “Os 240 entraram hoje e o etanol foi ontem” aplica cada data ao item correspondente.
- “tira os cento e trinta” retira só a receita de R$ 130. “Esquece os 85, foi engano” retira só o abastecimento. Antes, “esquece” descartava toda a proposta.
- “no de 85 põe 87,50”, “era 90 no de 85” e “os 130 foram cento e cinquenta” trocam somente o valor da ação escolhida.
- “os 90 foram hoje”, sem item de R$ 90 na proposta, pede o alvo e mantém a proposta anterior. “Muda pro dia 20 o de 85”, quando o leitor interpreta a data como futura, pede quando aconteceu.
- “os 85 foram hoje” e “tira os 85”, com Uber e etanol de mesmo valor, pedem qual item. “O etanol” escolhe o combustível e preserva a receita.
- “os oitenta e cinco e vinte e cinco centavos foram hoje” distingue a receita de R$ 85,25 do abastecimento de R$ 85,00.
- Na conversa “os 85 foram hoje” → “a da 99 foi 150” → “foram 180 km” → “tira a 99”, a proposta final mantém a Uber, o abastecimento hoje e a jornada de 180 km, 8 horas e 14 viagens. A confirmação continua no botão.

### Pedágio, estacionamento e receita realizada (`XA`)

- “pedágio saiu 8 ontem”, “ontem saiu 8 no pedagio” e “ontem estacionamento saiu 6,75” preparam despesas nas categorias certas. Antes, o valor aparecia como receita de corridas.
- “pedágio saiu 8 e corrida rendeu 45 ontem” e “pedágio saiu 8 e corrida rendeu 45 ontem no curso da noite” preservam os R$ 45 de receita e os R$ 8 de pedágio de ontem.
- “paguei pedágio oito e cinquenta e a corrida da 99 pagou quarenta e quatro” propõe R$ 8,50 de pedágio e R$ 44 da 99. O nome 99 deixa de virar uma despesa.
- “45 de corrida e 8 de pedagio pago por mim” separa o valor da corrida e o que o motorista pagou.
- “passei no sem parar saiu 8,25, ganhei 45 na Uber ontem” mantém o débito de pedágio de R$ 8,25 e a receita de R$ 45 da Uber ontem.
- “gastei oito e vinte e cinco no pedagio ontem, e deu 45 na corrida” mantém o gasto e corrige o sentido dos R$ 45 para receita.
- “ontem saiu 8 no pedagio e caiu 45 da 99” mantém as duas movimentações de ontem com sentidos opostos.
- “ontem teve pedágio de 8, o passageiro que pagou, caiu 45 da 99” propõe só o recebimento do motorista. “Deu 45 de corrida, vou pagar 8 de pedágio amanhã” mantém os R$ 45 realizados e explica que o custo ainda é futuro.
- “passei por um pedágio de 8 ontem nessa corrida que rendeu 45” preserva a receita e pergunta quem pagou. “Eu paguei” prepara o pedágio de ontem com a receita.
- “ontem fiz 45 de corrida e 8 de pedágio ou foi 9, nao lembro” preserva os R$ 45 e pede o valor exato. “9” inclui só o pedágio de R$ 9.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 2.014 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria com números extremos, sinais de menos e instruções misturadas a relatos.

### Formatos ambíguos e sinais negativos (`XB`)

- “fiz 1e9 na Uber hoje” pede o valor exato em reais e centavos. Antes, propunha R$ 1 e R$ 9.
- “recebi 2,5e3 na Uber ontem” não divide a notação em dois recebimentos. “Recebi R$ 1e+6 de um cliente ontem e gastei 20 de almoço” pede a receita exata e prepara só a despesa de R$ 20 de ontem.
- “gastei 85,505 de etanol hoje” e “ganhei 99,000 na Uber” pedem confirmação do formato; a vírgula não multiplica o valor por mil.
- “paguei R$85,5010 de etanol hoje” pede o valor em centavos em vez de arredondar silenciosamente. “Recebi 2.345,678 de aluguel” também pede o número exato no perfil autônomo.
- “ontem gastei 85,505 de etanol e recebi 300 da Uber” mantém apenas os R$ 300 reais da Uber de ontem na proposta enquanto pergunta o valor do abastecimento.
- “pedágio saiu −8 ontem e ganhei 45 na uber” pede o significado do negativo e conserva só os R$ 45 da Uber de ontem.
- “ontem na uber -250 de repasse e 120 de gasolina” pede o significado do repasse negativo e preserva os R$ 120 de combustível ontem.
- “99 depositou -100,50 e uber pagou 230” mantém só os R$ 230 da Uber e pede o significado dos R$ 100,50 negativos.
- Com uma receita de R$ 240 já na proposta, “gastei 85,505 de etanol hoje” → “85,50” prepara o abastecimento de hoje e preserva a receita de ontem.
- “fiz 1e9 na Uber hoje” → “290,75” completa a receita de R$ 290,75 da Uber hoje. “85,50”, depois da pergunta em uma frase com etanol e Uber, completa só o abastecimento.
- Quando o valor veio com sinal negativo, responder só “8” mantém a receita independente e pede uma frase que explique o débito ou a devolução.

### Continuação de consultas no chat (`XC`)

- “quanto caiu da 99 ontem?” → “e hoje quanto caiu?” e “quanto entrou na Uber ontem?” → “e anteontem quanto entrou?” conservam a plataforma e trocam o dia.
- “e a 99 essa semana?” troca da Uber para a 99 e aplica a nova janela. “E hoje da 99, quanto?” também reconhece a troca com a data no início.
- “e só na Uber ontem?” depois do total de corridas restringe a consulta à Uber no dia pedido.
- “e hoje de tudo?” deixa o filtro de plataforma da consulta anterior e soma todas as entradas de hoje. “E hoje somando todos os apps?” soma as plataformas identificadas e deixa as corridas particulares fora do cálculo.
- “quanto gastei ontem?” → “e quanto recebi anteontem?” usa o novo sentido e o novo dia.
- “qual foi o meu lucro ontem?” → “e anteontem comparando?” mostra os dois resultados reais. “E amanhã?”, após um repasse consultado no histórico, explica o limite da consulta a dias já ocorridos.
- “e Casa 2 no mês passado?” depois da Casa 1 troca a origem e o mês.
- Com R$ 320 da Uber na proposta, duas consultas da 99 preservam o item para “a uber foi 330”.

### Exemplos, fala citada e texto copiado (`XD`)

- “essa frase é só um exemplo: ‘ganhei 500’ e ‘abasteci 90’ ontem”, “é um exemplo eu disse que ganhei 500 e gastei 100 ontem” e “essa frase de exemplo ‘foi 400 e tira a 99’” recebem uma resposta de exemplo sem proposta.
- “tô só simulando se eu falar ganhei 500 da uber e paguei 80 de gasosa”, “só pra simular a transcrição: trabalhei 8 horas e ganhei trezentos de corrida” e “eu tô só praticando o áudio: ganhei enquanto ia de uber 280” tratam o texto como prática ou transcrição de exemplo.
- “é só uma frase para testar o reconhecimento: abasteci gasolina 85”, “é pergunta de teste: se eu escrever lança 390 de despesa, vc gravaria?” e “anota que esse é outro exemplo: paguei 70 na farmácia” recebem a mesma proteção, inclusive quando o trecho contém um comando.
- “texto copiado do whatsapp: meu irmão ganhou 500 uber e gastou 95 ontem”, “a notificação dizia que a Uber depositou 250 mas ainda não caiu” e “a msg do grupo foi paguei 90 de etanol e fiz 320 hoje” são tratados como fala citada.
- “supondo que alguém fale ‘recebi 120 da Uber’, o que você entende?” fica no contexto de exemplo. Aspas sem fechamento em “só pra simular a transcrição: ‘rodei oito horas. fiz 300 e 90 de gasolina” também mantêm todo o trecho citado.
- Em “essa frase é um exemplo: ‘ganhei 500 e na real eu paguei 80. gastei 90 ontem’”, a pontuação e o “na real” seguem dentro das aspas. Com “‘ganhei 500 ontem. paguei 80 de gasolina’. de verdade paguei 20 de almoço hoje”, só o almoço vira proposta.
- “fulano escreveu: apaga tudo. eu paguei 12 de almoço” e “se vier texto ‘apaga tudo’ é exemplo. paguei 12 de almoço hoje” preservam o almoço afirmado.
- “se eu disser que fiz 80 da 99 é um exemplo, na real fiz 200 da Uber ontem”, “se eu falar ‘ganhei 200 hoje’ é só exemplo e de verdade ganhei 210 da Uber ontem” e “foi brincadeira eu falar que paguei 80, na real fiz 90 na Uber” preservam as receitas afirmadas.
- “uma legenda diz ‘ganhei 300 da 99’ mas é de outra pessoa. paguei 20 hoje” propõe só a despesa. “A mensagem copiada dizia ‘ganhei 450; e agora paguei 80 de etanol’. paguei 32 de almoço de verdade” também separa a despesa própria.
- “eu tava simulando e agora paguei mesmo 80 de etanol hoje” preserva o abastecimento. “Eu disse ‘paguei 90 e ganhei 400 ontem. cancela tudo’ e de verdade abasteci 65 de etanol hoje” prepara só R$ 65 de etanol hoje.
- “tô testando uma frase: tira a 99” mantém a Uber e a 99 na proposta anterior.

Cada lote passou por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 2.067 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria com relatos de jornada atravessando a meia-noite e datas próximas à virada do mês ou do ano.

### Datas em jornadas que atravessam a meia-noite (`XE`)

- “de terça pra quarta fiz 210 de corrida” mantém os R$ 210 e pede o dia. “Quarta” usa a quarta-feira da janela indicada.
- “de 24 pra 25 foram trezentos na uber” trata 24 e 25 como datas. “Dia 25” prepara R$ 300 da Uber no dia escolhido.
- “no turno da noite de terça pra quarta gastei 90 de gasolina” esclarece a data do abastecimento. “Ontem” mantém os R$ 90 no dia 24.
- “de quinta pra sexta fiz 310 na Uber”, “de 31 pra 1 foram trezentos na uber” e “de 31/12/2026 pra 01/01/2027 fiz 180 na 99” reconhecem os dois lados da virada do ano e registram na proposta a data escolhida.
- “de ontem para hoje fiz noventa na 99” mantém R$ 90 e usa a data indicada no turno seguinte.
- “de ontem pra hoje fiz 210 de corrida mas o pix caiu hoje” registra a data do recebimento na proposta. A variante com “fiz 210 de corrida ontem” também usa hoje, como dito para o Pix.
- “de ontem pra hoje recebi 210 ontem mas o pix caiu hoje” pede qual das datas de recebimento está correta.
- “na madrugada de terça pra quarta fiz 190 na 99” e “na madrugada de quinta pra sexta ganhei 250 na Uber” usam o dia após a meia-noite.
- “de terça pra quarta fiz 210 corridas, botei 80 de gasolina na terça” já prepara o abastecimento de terça e pergunta de que dia foram as viagens. “Quarta” completa só as viagens.
- “trabalhei de ontem pra hoje, fechei 300 da Uber e paguei 85 de gasolina” pede a data de cada item. “Hoje” → “ontem” mantém R$ 300 da Uber hoje e R$ 85 de combustível ontem na proposta.

### Horas de jornada com início e fim informados (`XF`)

- “comecei às 23h de ontem e terminei às 2h de hoje” e “trabalhei ontem a partir das 23h até as 2h de hoje” preparam 1h ontem e 2h hoje.
- “comecei ontem às onze da noite e parei hoje à uma e meia da madrugada” reconhece a transcrição e prepara 1h ontem e 1h30 hoje.
- “saí ontem às 22:45 e parei hoje às 02:00” prepara 1h15 ontem e 2h hoje. “Ontem nessa jornada comecei 23h terminei hoje 1h” funciona sem conector.
- “ontem comecei 23h30 e encerrei hoje 00h15” prepara 30 minutos ontem e 15 hoje. “Comecei ontem às 23:55 e terminei hoje às 00:05” mantém cinco minutos em cada dia.
- “de ontem pra hoje rodei 2h antes da meia-noite e 3h depois” guarda 2h ontem e 3h hoje.
- “ontem comecei 22h e terminei hoje 2h, foram 250 da Uber” prepara 2h em cada dia e pergunta de qual dia foram os R$ 250. “Fiz das 22h às 2h de ontem para hoje e ganhei 290” faz a mesma separação para os R$ 290.
- “comecei ontem às 23h e parei hoje à 1h30, rodei 60 km” preserva os dois períodos e pergunta sobre a data da distância. “Ontem rodei 2h antes da meia-noite e 3h depois, 160km no turno” também mantém as horas por dia, com a distância total em aberto até a resposta.
- “ontem comecei 10h e terminei hoje 11h” e “comecei ontem 23h e terminei ontem 1h” pedem conferência dos dias e horários. “Hoje comecei 22h e vou terminar amanhã às 2h” aguarda a jornada terminar.

### Dias e valores ditados na mesma frase (`XG`)

- “ganhei 250 na uber no dia vinte e quatro e cento e cinquenta e cinquenta centavos na 99 no dia vinte e cinco” prepara R$ 250 da Uber no dia 24 e R$ 150,50 da 99 no dia 25. Antes, propunha R$ 124,50 para a 99 e punha ambas as receitas no dia 25.
- “ganhei cento e vinte na Uber no dia vinte e quatro e noventa na 99 no dia vinte e cinco” conserva R$ 120 e R$ 90, cada um com a data e o aplicativo indicados.
- “no dia vinte e quatro ganhei duzentos e cinquenta na Uber e no dia vinte e cinco ganhei cento e quarenta na 99” reconhece os dias antes dos verbos. “Dia vinte e três 200 da Uber e dia vinte e quatro 130 da 99” também separa as datas sem exigir um verbo.
- “ante ontem ganhei 195 na Uber e hoje cento e vinte na 99”, “antes de ontem recebi duzentos na Uber e hoje setenta na 99” e “ante-ontem fiz 230 na uber e hoje 120 na 99” usam dois dias atrás para a Uber.
- “paguei 80 de gasolina no último dia do mês passado” e “no último dia do mês passado recebi 220 na Uber” usam 31 de outubro. Em janeiro, “recebi duzentos e cinquenta do freela no último dia do mês passado” usa 31 de dezembro do ano anterior.
- “fiz trezentos no dia primeiro de novembro” prepara R$ 300 no dia 1. “Ganhei duzentos e cinquenta em vinte e quatro de novembro” prepara só os R$ 250 no dia 24, sem perguntar por supostos R$ 24 adicionais.
- “entrou oitenta dia quinze e noventa dia dezesseis na Uber” mantém R$ 80 no dia 15 e R$ 90 no dia 16. A Uber é explícita no segundo valor.

Os três lotes passaram por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 2.109 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria com taxas retidas pela plataforma, valores líquidos e despesas pagas separadamente.

### Taxas retidas e valor líquido recebido (`XH`)

- “ganhei 45 líquido na 99, a taxa já saiu 8” prepara R$ 45 líquidos, sem nova despesa de R$ 8.
- “deu 45 líquido na uber descontaram 8 de taxa”, “a 99 pagou 45 líquidos depois de descontar 8 de taxa” e “a 99 pagou 45 líquido taxa de 8 já inclusa no desconto” preparam somente o recebido na plataforma indicada.
- “hoje 53 bruto 45 liquido depois da taxa de 8 da noventa e nove” interpreta os R$ 53 como bruto, os R$ 8 como retenção e os R$ 45 como a receita da 99.
- “ontem entrou quarenta e cinco da 99 já tirando oito de taxa e paguei seis de estacionamento” prepara a receita de R$ 45 e a despesa de R$ 6 ontem. Os R$ 8 já foram descontados.
- “8 de taxa retida 45 liquido da uber” conserva R$ 45 da Uber mesmo com a taxa primeiro. “Na 99 recebi cinquenta e dois e cinquenta centavos líquido taxa de sete e cinquenta descontada ontem” conserva R$ 52,50 da 99 ontem.
- “eu só recebi 45 da 99 com a taxa retida 8 mas não sei o bruto” preserva o recebido sem exigir o bruto. “Caiu 45 da 99, cobrou 8 mas já tava descontado” também prepara só R$ 45, com a retenção identificada.
- “fiz 53 bruto e a uber já descontou 8 de taxa”, “fiz 53 bruto a taxa da 99 foi 8”, “fiz 45 na Uber descontaram 8 de taxa” e “ganhei 53 na 99 taxa 8 retida” pedem quanto entrou na conta antes de preparar a proposta. O valor informado depois conserva a plataforma.
- “ontem 53 bruto 48 liquido depois da taxa de 8 da noventa e nove” aponta a diferença. “45,50” prepara o valor indicado como líquido mantendo ontem e a 99.

### Medidas de trabalho em dias distintos (`XI`)

- “trabalhei ontem 1h e hoje 2h” conserva 1h ontem e 2h hoje. “Ontem rodei 170 km e hj 200 km” conserva os 170 km e os 200 km nas datas correspondentes.
- “fiz 12 corridas ontem e 9 hoje” prepara 12 e 9 viagens. “Deu 8 viagens ontem e 12 hj” conserva a unidade omitida na segunda parte.
- “rodei três horas e vinte de ontem e duas horas de hoje” prepara 3h20 ontem e 2h hoje. “Fechei três horas e meia ontem e quatro hoje” prepara 3h30 ontem e 4h hoje.
- “130 km ontem e 90 km hoje”, “foram cento e trinta quilômetros ontem e noventa e sete hoje” e “ontem 130km e anteontem 90” distribuem a quilometragem pelas datas mencionadas.
- “dirigi 95 km na terça e 160 na quarta passada” mantém 95 km na terça e 160 km na quarta da semana anterior.
- “hj 5 corridas com 20km e ontem 11 com 60km” conserva as duas medidas de cada dia. “Terça-feira passada 10 viagens e nesta segunda 12” conserva as datas e as contagens.
- “meia hora de ontem e três horas de hoje no volante” prepara 30 minutos ontem e 3h hoje. “Ontem 6h; hj 2h; anteontem 4h” mantém os três dias.
- “rodei 4 horas entre ontem e hoje” pergunta a divisão. “Ontem 1h e hoje 2h” mantém a pergunta porque faltou 1h. “Ontem 1h e hoje 3h” prepara as duas jornadas.
- “entre ontem e hoje rodei 130 km no total” pede a divisão. A proposta só aparece após “ontem 40 km e hoje 90 km”.
- Na virada de ano, “dirigi cinco horas ontem e duas hoje” usa 31 de dezembro para as 5h e 1º de janeiro para as 2h.

### Valores corrigidos por contraste e fatos negados (`XJ`)

- “paguei 10,00 e não 100,00 de estacionamento ontem” e “paguei dez reais e não cem no estacionamento ontem” preparam somente R$ 10 na categoria certa. “No estacionamento paguei 10 não 100” conserva o local dito antes do valor.
- “gastei no mercado cento e vinte e não cento e dois ontem” prepara R$ 120 em alimentação no perfil autônomo.
- “recebi da Uber 250 e não 520 hoje”, “recebi 250 e não 520 da Uber hoje” e “hoje não ganhei 500 e sim 250 na Uber” preparam R$ 250 da Uber hoje.
- “saiu 85 de gasolina mas não saíram 30 de estacionamento” mantém somente o abastecimento. “Paguei 9 de estacionamento e não foram 15 de pedágio” mantém somente o estacionamento.
- “não saiu nada de abastecimento, só 7 reais de estacionamento ontem” propõe o estacionamento de ontem. “Ontem não gastei 85 de gasolina só 62,50 de etanol” prepara o abastecimento com etanol.
- “a uber não me descontou os 10 de taxa, paguei 6 de pedágio” mantém somente o pedágio pago.
- “ganhei 250 na Uber, 💸💸 99 não caiu 150, gastei 8 de pedágio” preserva a receita de R$ 250 e o pedágio de R$ 8. Nem o repasse que não caiu nem o nome do aplicativo viram lançamento.
- “paguei dez e cinquenta centavos e não cem de estacionamento ontem e comprei café por 8” prepara R$ 10,50 de estacionamento e R$ 8 de café. “Paguei três e cinco centavos e não dez no pedágio ontem” prepara R$ 3,05. “Recebi onze e vinte centavos e não trinta da Uber hoje” prepara R$ 11,20.

Os três lotes passaram por `npm test`, os dois typechecks, a rubrica com 0 PERIGOSA e 0 RUIM e a matriz de oito datas. O último passou com 2.157 regressões adversariais na data padrão. O projeto segue **NOT READY**.

Próxima bateria com pagamentos de várias origens no perfil autônomo e total sem divisão.

## 26/11/2026 — Claude integra a bateria do GPT e continua sozinho

- A `feat/assistant-intelligence-v2` avançou até `31d1e53`, com 58 commits do GPT trazidos por bundle. O commit `d0658ce`, com o aluguel conjunto pela metade, foi terminado em `c652684`. `listedHomes` recebia "Casa 1" com maiúscula e devolvia lista vazia. ", 800 foi da primeira" criava uma "Casa 80". "Foi da segunda" virava segunda-feira.

### Combustível ditado e item negado sem verbo (`YA`)

- "Paguei gasoza 85, nada de estacionamento 30" grava só o abastecimento. Antes, os R$ 30 negados eram gravados como estacionamento.
- "Nada de X N" e "zero de X" negam o item, inclusive com "hoje" no fim. A pergunta "ganhou ou gastou?" sobre o valor negado também cai.
- "Coloquei gasolina 90", "ontem coloquei gasolina 90", "botei etanol 50 reais" e "coloquei gazosa 90 ontem" viram abastecimento. Antes, caíam no menu de ajuda.

### Plataforma antes do valor e item de gasto depois de "ganhei" (`YB`)

- "Uber 45, 5 de pedágio" propõe a receita da Uber e o pedágio. Antes, os R$ 45 sumiam sem aviso. "Uber 45 líquido, 5 de pedágio" virava receita de R$ 5.
- "Ganhei 300 na uber, 20 de lanche e 10 de água" grava o lanche e a água como despesa. Antes, os dois viravam receita de corrida. Gorjeta continua receita.
- "Recebi 900 de freela e 300 de aluguel": cada valor pega a categoria do próprio trecho. Antes, os R$ 900 iam para Aluguéis.
- Combustível lido pela enumeração e pelo leitor de abastecimento não é contado duas vezes.

### Repasse negado, dívida e cotação (`YC`)

- "99 n caiu 150, uber caiu 220, etanol 90" grava os R$ 220 da Uber e o etanol. Antes, a frase inteira virava correção e a resposta era "não tenho lançamento".
- "Uber caiu 220", sem artigo, guarda a plataforma. "Etanol 90" sem verbo, depois de vírgula, é abastecimento.
- "Recebi 450 mas foi adiantamento do cartão, vou ter que devolver" e "caiu 300 que meu irmão emprestou" não viram receita: o app explica que é dívida. O vale do salário continua receita.
- "Gasolina 6,20 o litro" é cotação, e nada é gravado. Antes, virava uma despesa de R$ 6,20.
- "Uber 45 líquido 8 de taxa retida 5 de pedagio que eu paguei" propõe os R$ 45 líquidos e os R$ 5 de pedágio. Antes, os R$ 45 viravam pedágio. Com vírgulas, a taxa retida virava receita.

Os três lotes passaram por `npm test` (2.197 regressões), pelos dois typechecks, pela rubrica (0 PERIGOSA) e pela matriz das oito datas. Os casos abertos estão em `docs/BATERIA_DUVIDAS.md`. O projeto segue **NOT READY**.

### Ditado por voz (`YD`)

- "Doze e cinquenta de pedágio na ida e doze e cinquenta na volta" propõe dois pedágios de R$ 12,50. Antes, cada um saía como R$ 62,00 (12 + 50), e o segundo ia para Outros com a descrição "Volta".
- "Ontem eu fiz quinhentos e trinta reais e hoje trezentos e dez" grava os dois dias. Antes, o corte entre os dias só existia com algarismo, e os R$ 310 viravam pergunta.
- "Recebi da 99 240" registra a receita da 99, que antes não era registrada. "Recebi da Uber 240" não grava mais "Uber 240" como origem.
- "In draive me pagou oitenta" e "o inDrive me pagou 80" são corrida do inDrive. Antes, viravam Outros com a origem "In Draive".

### Digitação (`YE`)

- "Uber 180,99 120,gasolina 60" é Uber 180, 99 120 e gasolina 60. Antes, saía R$ 180,99, e os R$ 120 da 99 se perdiam.
- "Fiz 280 tbm na 99" mantém a 99. "Fiz 300 uber" e "hj 300 uber" não perguntam mais se foi ganho ou gasto.
- "Pg 15 d estacionamento" sai com a descrição "Estacionamento". "Abast 70" depois de um item de app vira abastecimento.

### Correções com proposta na tela (`YF`)

- "Na vdd foi na 99" troca a plataforma. Antes, a descrição virava "Vdd foi na 99".
- "Foi na 99 e foi 280" e "não foi na uber foi na 99 e foi 280" aplicam as duas trocas. Antes, só o valor mudava e a Uber ficava, sem aviso.
- "Não, foi 280" com receita e abastecimento na tela pergunta qual item foi R$ 280, e a resposta "1" ou "2" aplica a troca.

### Perguntas do motorista (`YG`)

- "Gastei mais com gasolina ou manutenção esse mês?" compara os dois lados pelo próprio planejador, com empate abaixo de 2%. Antes, a resposta trazia só a gasolina e dizia "foi exatamente o mesmo valor". Funciona também sem "?". "Gasto mais no começo ou no fim do mês" continua sendo agrupamento.
- "Quanto ganhei semana passada comparado com essa" compara as duas semanas.
- "Anteontem quanto de corrida e quanto de gasolina?" responde as duas partes no mesmo dia. Antes, o app procurava o texto "corrida".

Os quatro lotes passaram por `npm test` (2.221 regressões), pelos dois typechecks, pela rubrica (0 PERIGOSA, com a lista conferida resposta por resposta) e pela matriz das oito datas.

### Datas e outros perfis (`YH`)

- "Recebi 1800 da casa 1 anteontem e 1750 da casa 2 no dia seguinte" grava o segundo aluguel um dia depois. "No outro dia", "dois dias depois" e "o dia anterior" seguem a mesma regra. Antes, a segunda metade herdava a data da primeira.
- "Recebi o décimo terceiro de 1600", "caiu o 13 de 1600" e "recebi a primeira parcela do 13 de 1600" viram salário com a descrição "13º salário". Antes, caíam no menu de ajuda.
- "A casa 3 ainda não pagou" responde que o recebimento está pendente, sem registrar nada.

### Segunda volta: dúvida de valor, data corrigida e emojis (`YI`)

- "Fiz 300 na uber, ou foi 350? não lembro", "fiz uns 300, 350 por aí" e "gastei 80 ou 90 de gasolina acho" perguntam qual foi o valor, com a proposta pronta em cada opção. Antes, a primeira frase criava uma DESPESA de R$ 350. "Uber 45, 99 30" continua sendo lista.
- "Fiz uns 300" virou receita aproximada (antes caía na ajuda).
- "Fiz 300 na uber ontem não, anteontem" usa anteontem. "Dia 5 não, dia 6" segue a mesma regra.
- "🚗 300 uber ⛽ 80": o ⛽ é combustível, e os outros emojis saem do texto.

A rubrica foi conferida resposta por resposta contra a rodada anterior, sem nenhuma diferença.

### Turno contado em várias mensagens (`YJ`)

- "Fiz 280 na uber" → "e 120 na 99" soma as duas na proposta. Antes, a da 99 substituía a da Uber.
- "Gastei 50 de gasolina" → "e 20 de lanche" → "e 8 de pedágio" mantém os três. Antes, o abastecimento sumia no segundo turno.
- "Foi 15 o estacionamento" e "foi 90 a gasolina" corrigem o item e preservam o resto. Antes, a frase virava um gasto novo e a receita da Uber sumia da proposta.
- "Quanto gastei de gasolina" soma a categoria Combustível, e o rótulo continua dizendo "Gasolina". Antes, a busca pelo texto "gasolina" deixava de fora todo abastecimento gravado como "Abastecimento", inclusive o da proposta em "contando com esse".
- "Quanto fica meu dia se eu confirmar?" mostra o resultado de hoje com a proposta. Antes, mostrava o gasto do mês.
- Ficou como está: "comecei às 6h" seguido, horas depois, de "parei às 17h" ainda pede os dois horários. O foco da conversa expira em minutos.

### Ditado mais difícil (`YK`)

- "Hoje eu rodei tipo umas dez horas né fiz trezentos e oitenta na uber e aí gastei cem de gasolina" grava as 10 horas junto com a receita e o abastecimento. Antes, as horas sumiam. "Xei 8 h de volante e fiz duzentos e noventa" e "fechei 8h de volante" também guardam as horas.
- "Gastei uns trinta e poucos de lanche" pergunta o valor exato. Antes, gravava R$ 30 com a descrição "Poucos de lanche".
- "Fiz trezentos ontem anteontem duzentos e oitenta", ditado sem pontuação, grava os dois dias. Antes, o segundo virava pergunta.

### Casos abertos do GPT (`YL`)

- "Ont não gastei 90 de gas, foi setenta e cinquenta" pergunta GNV ou gás de cozinha sobre R$ 70,50 e grava em ontem. Antes, os R$ 90 negados entravam na pergunta, e eram eles que viravam abastecimento ao responder "GNV". "Ontem não gastei 90 de gasolina, foi 70,50" registra os R$ 70,50; antes, nada era registrado.
- "A Uber enviou 45 e eu paguei 8 de estacionamento" e "a 99 me transferiu 80" viram receita do app.
- "Ontem ganhei 250 na uber em 120 km, hoje foram 80 km e 190 na 99" guarda os km de cada dia. O hodômetro ("estou com 220.007 km") continua fora.
- "O que entrou na conta ontem?", "entrou alguma coisa ontem?" e "caiu algo ontem?" respondem o que entrou. As de sim ou não começam por "Sim." ou "Não.". Antes, a resposta era a lista de contas a vencer ou o menu de ajuda.

### Pontuação, rótulo e gorjeta (`YM`)

- "Paguei gasolina 85." e "paguei gasolina 85," viram abastecimento. Antes, o ponto colava no valor reordenado e virava despesa comum.
- "Aluguel: recebi 1800 e 1750" e "mercado: gastei 120, 45 e 30" aplicam o rótulo a cada valor.
- "A corrida deu 45 com 5 de gorjeta e paguei 8 de pedágio" pergunta se a gorjeta já está nos R$ 45, com as duas propostas prontas e o pedágio nas duas. Antes, só o pedágio era proposto. Com "já incluída" ou "por fora" na frase, a proposta sai direto.

### Dias da semana e conta com os valores da frase (`YN`)

- "Domingo não rodei, segunda fiz 300" grava os R$ 300 na segunda. Antes, iam para o domingo negado.
- "Terça entrei 200 na Uber e quarta 130 na 99", dito numa quarta, grava terça e hoje. Antes, os dois iam para a terça. A quarta da semana passada ficaria antes da terça já contada, então a narração em sequência fica com hoje; "quarta passada" continua sendo a da semana anterior.
- "Paguei 8 de pedágio ontem na corrida e quanto sobrou dos 45?" responde R$ 37,00, com a conta só dos valores da mensagem. Antes, respondia o resultado do mês.

### Outros perfis (`YO`)

- "Fiz um serviço de 500 mas só recebi 200" grava só os R$ 200 e diz que faltam R$ 300. Antes, gravava R$ 700 de receita. Vale também para frete, venda, diária e corrida.
- "Vendi 5 bolos a 30 cada e 2 tortas a 50" grava R$ 150 e R$ 100. Antes, a segunda venda entrava na descrição e o valor saía R$ 50.
- "Quanto cada casa me pagou esse mês?", "quanto recebi de cada casa" e "qual casa paga mais?" respondem por origem. Antes, a consulta procurava o texto "Cada Casa", e "qual casa paga mais" respondia sobre gastos.
- "Recebi o adiantamento quinzenal de 1600" e "caiu o vale de 1200" são salário. O adiantamento do cartão continua sendo dívida.

### Ofertas de corrida (`YP`)

- "Corrida de 18 por 6 km, 3 km até o passageiro, compensa?", "6 km e 3 até o passageiro" e "6 km mais 3 de busca" analisam 9 km (R$ 2,00/km). Antes, o app perguntava os km da viagem, ou calculava R$ 3,00/km só sobre os 6 km.
- "Uber ofereceu 42 por 15 km" e "a 99 mandou uma de 25 por 10 km" analisam a oferta. Antes, caíam no menu de ajuda. "A uber me mandou 300", sem distância, continua sendo receita.
- "Proposta de 36 por 12km no total, tem taxa?" explica que o valor mostrado pelo app já vem sem a taxa e analisa os 12 km. Antes, a resposta era "não consegui ler o 36".
- "Vale a pena 1,50 por km?" responde sim ou não pela régua da tela Veículo: custo e mínimo recomendado.
- "Fiz uma corrida de 50 por 20 km" guarda os 20 km. Para quem andou como passageiro, o km continua fora.

### Correções, segunda volta (`YQ`)

- "Rodei 180 km" → "não, 190" atualiza a distância para 190 km. Antes, a jornada ganhava um valor em reais escondido, os km ficavam em 180 e o texto dizia "Troquei o valor de — para R$ 190,00". Com km e viagens na mesma jornada, o app pergunta qual medida mudou.
- "Põe pra ontem", "muda pra 99" e "só a gasolina" / "deixa só a receita" corrigem a proposta. Antes, caíam no menu de ajuda ou em "não peguei o quê". A troca de plataforma agora diz qual ficou.
- "Fiz 300 na uber" → "e mais 50" acrescenta outro item da Uber. Para gasto e abastecimento, a regra é a mesma. Antes, os R$ 50 substituíam a proposta.

### Perguntas de escolha (`YR`)

- "Tô rodando no lucro ou no prejuízo?" começa por "No lucro." ou "No prejuízo.". Antes, começava com "Não." e mostrava lucro.
- "Ganhei mais ontem ou hoje?" e "faturei mais ontem ou anteontem?" comparam os dois dias e começam pelo vencedor ("Ontem."). Com diferença abaixo de 2%, a resposta diz que é praticamente empate. Antes, o app perguntava "qual desses dias você quer consultar?".

### Digitação, segunda volta (`YS`)

- "Fiz 300.. na uber... e gastei 50,, de gasolina" mantém a Uber e o abastecimento. Pontuação repetida não conta mais como decimal.
- "Gastei 50 d gasolina e 20 d lanxe" propõe os R$ 20 uma vez só, em Alimentação. A cópia sem categoria, que já existia antes desta rodada, sai.
- "Na uver", "n uber", "ns uber", "80 n gasolina" e "na nov e nove" mantêm a plataforma ou o combustível.
- "Qnts corrida eu fiz ontem", com "corrida" no singular, responde a quantidade de viagens, não os reais.

Para continuar, o próximo prefixo livre é `YT`. Os casos abertos estão em `docs/BATERIA_DUVIDAS.md`.

### Outros perfis, segunda volta (`YT`)

- "Recebi da casa 1 e da casa 2, 1800 cada" e "recebi das casas 1, 2 e 3, 1500 cada" propõem um aluguel por casa. Antes, caíam no menu de ajuda.
- "Gastei 35 de 99 ontem" e "paguei 22 na 99", fora do perfil motorista, guardam "99" na descrição. "Gastei 20 e 99" continua sendo dois valores.

### Turno do motorista, segunda volta (`YU`)

- "Uber 12 viagens 220, 99 6 viagens 100" propõe as duas receitas, cada uma com o seu app, e 18 viagens. Antes, só ficavam as 12 viagens e uma pergunta sobre o resto.
- "Hoje 180 km rodados" registra a distância do dia. "Estou com 220007 km rodados" continua sendo hodômetro.

### Data junto do valor ou da medida (`YV`)

- "85 hj", com um pedágio de R$ 85 na proposta, muda a data desse item. Se ele já estava em hoje, o app só confirma. Antes, perguntava se os R$ 85 foram ganho ou gasto.
- "Os 170 km foram hoje", com horas e viagens na mesma jornada, pergunta se só os km mudaram de dia ou a jornada inteira, com as duas propostas prontas. Quando a jornada só tem os km, a data muda direto. Antes, o app pedia para reescrever.

### Números longos e lista telegráfica (`YW`)

- "Abasteci cento e cinco e cinquenta" é R$ 105,50, e "dois mil e cinco e cinquenta" é R$ 2.005,50. Dezena depois de unidade nunca compõe o número inteiro, então o resto são os centavos. Antes, saíam R$ 155 e R$ 2.055.
- "Ontem: uber 300, 99 120, gasolina 100, almoço 22, pedágio 12, 190 km, 9h, 18 corridas" sai com cada valor no seu item. Antes, os R$ 300 iam para a 99, os R$ 120 viravam abastecimento, e a gasolina, o almoço e o pedágio viravam pergunta.

### Sentence case e conferência ampla (`YX`)

- "Qual foi pior", depois de comparar dois meses, começa com maiúscula ("Novembro de 2026 foi pior em gastos"), pela regra 13.
- Foram conferidas, sem defeito, perguntas do autônomo (bar contra mercado, maior gasto, categoria, média por semana), metas e reserva, contas fixas e vencimentos, e as 90 respostas da sonda de red team.

### Combustível, manutenção e hodômetro (`YY`)

- "Coloquei 30 litros de etanol, deu 128" grava R$ 128 com os 30 litros. Antes, o valor virava pergunta.
- "Conserto do câmbio", embreagem, suspensão e radiador vão para Manutenção. "Paguei 380 nos pneus dianteiros" grava a descrição "Pneus dianteiros", sem o "Nos" na frente.
- "Saí com 98.500 e voltei com 98.730", "hodômetro de manhã 98500 à noite 98730" e "rodei do km 98500 ao 98730" registram 230 km e o hodômetro final. Antes, caíam no menu de ajuda.

### Ranking por dia dito com sobras (`YZ`)

- "Em qual dia eu rodei mais km?" e "em que dia eu mais rodei?" respondem com o ranking de km por dia, com os empates ditos. Antes, a primeira dizia que não leu "eu km", e a segunda virava consulta de gasto.
- As métricas por app (por hora, por km e por corrida) continuam dizendo que o histórico só guarda essas medidas para o dia inteiro, e não por plataforma. Isso é uma limitação conhecida, não um defeito.

### Taxa da 99, corrida particular e dois meios de pagamento (`ZA`)

- "A 99 me cobrou 2 de taxa de saque" grava R$ 2. Antes, gravava uma despesa de R$ 99. A taxa retida ("a 99 descontou 50 de taxa e caiu 380") continua fora, como sempre.
- "Fiz uma corrida particular de 80" e "fiz 3 corridas particulares de 50" registram R$ 80 e R$ 150, com as viagens. Antes, a primeira caía no menu de ajuda e a segunda perdia o dinheiro.
- "Ganhei 10 de gorjeta no app da uber e 5 em dinheiro" registra as duas gorjetas. Antes, os R$ 5 viravam pergunta.

### Continuação e hipóteses (`ZB`)

- "E o lucro?", depois de "quanto fiz na 99 semana passada", mostra o resultado de todas as plataformas e diz isso no rótulo. Gasto não tem plataforma; antes, a resposta mostrava a receita da 99 com o nome de "Resultado".
- "Quanto eu perco se tirar folga na segunda?" e "se eu ficar de folga sábado quanto deixo de ganhar" respondem com a média desse dia da semana nos últimos 60 dias, antes e depois dos gastos. Com menos de dois desses dias registrados, o app cala. Antes, dizia que não sabia simular.
- "E se eu tiver uma parcela de 500 por mês?" compara a parcela com a sobra média dos últimos meses fechados, por mês e em um ano. Antes, simulava um gasto único de hoje ou dizia que não sabia simular. Com menos de dois meses fechados, só diz o total anual.

### Cartões e explicações (`ZC`)

- Foram conferidos, sem defeito: compra parcelada no Nubank e no Inter, pagamento de fatura com e sem valor, "quanto tá a fatura", "quanto devo no cartão", "quando vence a fatura" e "parcelei 600 em 6x" (pergunta o cartão). As explicações também foram conferidas: "por que essa categoria?", "por que achou estranho?", "o que você aprendeu sobre mim?" e "para de usar meu histórico".
- "Como você calculou isso?", sem nenhuma conta antes, diz que ainda não fez conta na conversa e sugere uma pergunta. Antes, caía no menu de ajuda. Com uma conta recente, a explicação continua vindo do foco.

### Correção de lançamento salvo (`ZD`)

- "A feira foi 150", com Feiras salvas, pergunta se é para corrigir a mais recente ou registrar uma nova. Antes, criava um gasto novo de R$ 150 em Outros, ao lado do errado. Sem lançamento com esse nome ("o almoço foi 25"), a frase continua sendo registro.
- "O cimento era 500" corrige: com vários Cimentos salvos, o app pergunta qual, e responder "1" escolhe o primeiro. Antes, criava a despesa "Cimento era" de R$ 500, e a escolha por número não funcionava.
- "Aquele gasto de 120 no bar era lazer mesmo" responde que esses lançamentos já estão em Lazer e não muda nada. Antes, criava um gasto novo de R$ 120.

### Sinal pelo sujeito da frase, no motorista (`ZE`)

- "O abastecimento de ontem foi 90" e "o lanche de hoje foi 20" viram gasto. Antes, o "foi" do motorista (regra 34) transformava os dois em receita de corrida. O "foi" continua valendo como faturamento quando o sujeito não é um gasto.
- "A corrida foi 45", sem proposta na tela, registra uma corrida de R$ 45. Antes, virava despesa em Outros. Com proposta na tela, a frase continua sendo correção.
- "A 99 de ontem era 160" corrige o repasse salvo da 99. Antes, perguntava se os R$ 99 foram ganho ou gasto. "A uber de ontem foi 250" pergunta se é para corrigir o salvo ou registrar um novo.

### Fechamento do dia (`ZF`)

- "Fechei 300", "ontem fechei 350" e "fechei 320 bruto 260 líquido" registram o faturamento (o último, com os R$ 260 líquidos). Antes, os dois primeiros caíam no menu de ajuda e o líquido virava pergunta. "Fechei 8h de volante" e "fechei o dia com 320… depois de trabalhar 8 horas" continuam com o leitor de jornada.
- "Fiz a meta, 300" registra os R$ 300. Antes, respondia a composição da meta.

### Valor 99 e estado vazio (`ZG`)

- "Recebi 99 reais" nos perfis genérico, autônomo e CLT não vai mais para Corridas. A palavra-chave "99" da lista de categorias casava com o próprio valor, ferindo a regra 3. "Recebi 300 da 99", com preposição, continua indo para Corridas no motorista.
- Com o estado vazio, as perguntas do motorista (por hora, dia da semana, app, lucro, meta, custo do km, média por corrida e folga) calam e dizem o que registrar (regra 43). A comparação entre dois gastos sem dado nenhum não diz mais "Dado real".

### Palavras de motorista fora do motorista (`ZH`)

- Na CLT, "fiz uma corrida de 25 pro trabalho" é gasto: a corrida que a pessoa pagou como passageira. Antes, virava receita de Corridas. Quem diz que recebeu do app ("recebi 120 do Uber") continua com a receita, como no bloco `MV`.
- "Recebi bônus de 300", "prêmio", "gratificação" e "PLR" viram receita. Antes, caíam no menu de ajuda.
- Durante este lote, um script de edição inseriu um backspace (0x08) no lugar de `\b` numa regex, o mesmo problema da regra 59. Foi encontrado antes do commit e corrigido; a varredura de caracteres de controle está limpa.

### Pergunta por unidade com os valores da frase (`ZI`)

- "Fiz 320 em 10 horas, quanto deu por hora?" responde R$ 32,00 por hora, com a conta só dos valores da mensagem e antes dos custos. "Fiz 300 e rodei 150 km, quanto deu por km?" e "fiz 12 corridas e ganhei 300, quanto deu por corrida?" seguem a mesma regra. Antes, a resposta dizia que não havia horas registradas.
- Os prefixos `Z?` acabaram. Os próximos livres são `AA`, `AD`, `AE`, `AF`…

### Repasses e carteira (`AA`)

- "O repasse semanal da uber caiu 1.200" guarda a Uber, que antes sumia.
- "A uber pagou a semana, 1350", "caiu o pix da 99 de 620" e "recebi o repasse da semana passada da 99, 900" viram receita do app. Antes, caíam na ajuda ou numa consulta quebrada.
- "Tenho 300 na carteira da uber" responde como saldo de carteira, sem registrar receita (a regra é a do lote do GPT: dinheiro na carteira só vira receita quando cai na conta). Ficaram como estão: "transferi 800 da carteira da 99 pra minha conta" e "saquei 400 da uber". Os dois dependem de o motorista já ter lançado as corridas daquela semana; anotado em `docs/BATERIA_DUVIDAS.md`.

### Jornada curta (`AD`)

- "Choveu muito, fiz só 3 horas e 120" e "fiz 3 horas e 120" registram 3h e R$ 120. Antes, caíam no menu de ajuda. "Rodei só 3 horas e fiz 120" guarda as horas, que antes sumiam por causa do "só".
- Também foram conferidos, sem defeito: folga ("tô de folga hoje"), carro na oficina, turno que passa da meia-noite (pergunta o dia), "virei a noite", "fiz 150 de manhã e 200 de tarde".

### Carteira do app para a conta (`AE`)

- "Transferi 800 da carteira da 99 pra minha conta" e "saquei 400 da uber ontem" perguntam se o valor já está nas corridas lançadas. Se já está, nada é registrado, porque é só dinheiro mudando de lugar. Se não está, a resposta prepara a receita do app, com a data dita. Antes, a primeira frase respondia com vencimentos, e a segunda dizia que saque não é ganho.
- Durante o lote, a frase com o dia junto ("saquei 400 da uber ontem") derrubava o orquestrador, porque o código usava uma variável antes de declará-la. Foi corrigido antes do commit e ganhou regressão própria.

### Gíria de dinheiro (`AF`)

- "Gastei 2 paus no conserto" pergunta se foi R$ 2 ou R$ 2.000, com as duas propostas prontas. "Meio pau" também pergunta. Antes, gravava R$ 2. Com número de 10 para cima ("50 paus de gasolina"), o valor continua em reais.
- "Gastei rs 45 no almoço" e "gastei uma nota de 100 no posto" registram R$ 45 e R$ 100. Antes, caíam no menu de ajuda.
- "Pila", "mango", "conto(s)", "R$300", "1k" e "1,2 mil" foram conferidos, sem defeito.

### Quanto dá para gastar ou guardar (`AG`)

- "Posso gastar 200?", "posso gastar 200 hoje?", "posso gastar 200 no fim de semana?" e "posso comprar um tênis de 300?" viram simulação, como "dá pra gastar 200?". Antes, caíam no menu de ajuda ou perguntavam se os R$ 200 foram ganho ou gasto (regra 33a).
- "Quanto consigo guardar esse mês?", no motorista, responde com a sobra do mês e diz que é isso que dá para guardar. Antes, a resposta era "não tenho lançamento". A rota de "guardar" dos outros perfis continua igual.

### Intervalo de dias (`AH`)

- "Quanto ganhei entre o dia 10 e o dia 20?", "quanto fiz do dia 10 até o dia 20?" e "quanto gastei do dia 1 ao dia 15?" respondem o intervalo pedido. Antes, a primeira respondia o mês inteiro como se fosse o intervalo, e a última virava "gasto por dia", porque "ao dia" também significa "por dia".
- "Semana retrasada", "mês retrasado", "últimos 15 dias", "de segunda a quarta", "dia 20", "último sábado" e "outubro na Uber" foram conferidos, sem defeito.

