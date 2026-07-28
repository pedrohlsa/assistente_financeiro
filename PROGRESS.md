# AssistFin — Estado do Projeto

**Última atualização**: 2026-07-28 — confirmações destrutivas internas em cartões e backup.
Ver "🟢 Confirmações destrutivas compatíveis com Android/WebView" para o trabalho mais recente.
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

Comparando manualmente `vite.config.ts` e `api/ai/chat.ts`: o corpo do `SYSTEM_PROMPT` (regras
de perfil, categorias, `is99`, `balance`) está **sincronizado** entre os dois arquivos hoje.

Porém: **nenhum dos dois prompts menciona a ação `"saving"` nem o campo `"origin"`**, adicionados
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
4. ❓ **CONTEXTO.md referenciado no README mas não existe no projeto** — link quebrado, impacto cosmético apenas.
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
7. `CONTEXTO.md` referenciado no README continua inexistente.

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
