# AssistFin — Estado do Projeto

**Última atualização**: 2026-10-25 — correções locais após a auditoria independente
de `345d55e`. **NOT READY para merge/deploy** até nova auditoria externa.
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

## Pendências em 28/10/2026 (HEAD `4e16b70`)

Estado: 666/666 corpus, 99/99, 50/50, **516/516 adversariais**, 4.088 + 3.800
metamórficos, 1.416 fuzz, 151/151 invariantes, 468/468 offline (65 frases
chegam hoje ao modelo remoto); typechecks, `test:money`, build e rubrica
(0 perigosa, 0 ruim) verdes. Tudo local, sem DeepSeek, push, merge, deploy ou
APK. **NOT READY para merge/deploy**: os diffs `c3648de..c824fe0`,
`c824fe0..b049bdf`, `b049bdf..73c8d24` e `73c8d24..4e16b70` (seções acima,
uma por causa) precisam de auditoria independente; navegador, persistência
real e dados legados reais não foram revalidados.

Abertas, achadas na leitura humana e ainda não corrigidas (detalhe nas
seções de 27 e 28/10 acima):
- "Quando paguei a fatura do nubank" e "antecipei a fatura do nubank" dão o
  resumo dos cartões.
- Motorista: "troquei o óleo com 45 mil km", sem custo, cai na ajuda em vez
  de perguntar o valor.
- Receita sem origem ("recebi 2 mil do cliente", "caiu 350 de pix do joão")
  é a regra "Origem explícita — nunca inferida" (`extractOrigins`, em
  clauses.ts): só valem substantivo de fonte + identificador ("do cliente
  João", "da casa 1") ou nome próprio com maiúscula. Uma tentativa em
  28/10 de ler "do <nome>" no parser foi revertida antes do commit: quebrou a
  invariante "futuro explícito nunca vira realizado" ("…e 700 do cliente ana
  mas o da ana só entra amanhã" virou recebido) e o corpus adaptativo. Se o
  produto quiser origem de nome em minúscula, o caminho é perguntar "de
  quem?", não inferir.
- Mês que vem em lançamentos ("quanto vou receber em dezembro") responde
  "Não tenho nenhum lançamento… Assim que você registrar", em vez da previsão.
- "Devo muito?" cai na ajuda.
- "Quanto guardei nas metas esse mes" responde o total até agora (a meta não
  guarda depósitos por mês).

Decisões de produto pendentes:
- `balanceOutlook` (Home e simulações "e se eu gastar") só considera contas
  fixas; as respostas do chat já usam `cashObligationsUntil()`.
- Não existe lançamento de retirada da reserva (`insufficient-reserve` não é usado).
- O chat não apaga lançamento salvo (só "desfaz o último" lote do assistente).
- O chat não confirma ocorrência de conta fixa: "paguei a luz de 180" cria
  despesa avulsa (agora com aviso), e confirmar a Luz depois na tela inicial
  duplica.
- Viagem inferida em total do dia: o corpus se contradiz (`rr-01` sem viagem
  com horas; `sem-04` 2 viagens com 8 horas; `mul-07` 1 viagem com 120 km).
- "Vale a pena ficar mais 3h?" e "vale a pena rodar domingo?" respondem com
  o que rende e a meta/histórico, sem Sim/Não: o app não sabe o cansaço nem o
  custo de oportunidade de ninguém.
- Fixture `autonomoRico`: Luz/Internet com `startDate` no dia 1º e `dueDay`
  10/15 — vencem no dia 1º nas respostas (o formulário grava os dois coerentes).
