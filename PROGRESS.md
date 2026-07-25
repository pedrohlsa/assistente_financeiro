# AssistFin — Estado do Projeto

**Última atualização**: 2026-07-24 20:10 (horário local da máquina) — sessão de correção da IA
remota, ver seção "🟢 Sessão de correção da IA remota" abaixo para o trabalho mais recente.
**Pasta canônica do projeto (mudou nesta sessão)**: `D:\Claude\AssistFin`. A cópia antiga em
`C:\Users\ph969\OneDrive\Área de Trabalho\AssistFin` foi deixada intacta, mas **não é mais usada**
— era uma cópia interrompida no meio (faltavam `profile.ts`, `PendingRecurrings.tsx`,
`notifications.ts` e várias telas estavam desatualizadas). O conteúdo completo e atual foi
copiado da pasta antiga pra cá antes desta sessão.
**Branch**: `main`
**Commit atual**: `28677b9` — "Estado atual do AssistFin: 4 perfis, metas, recorrentes, IA local+remota"
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

1. 🔴 **Chat de IA remota fora do ar em produção** — código local corrigido e testado (modelo `deepseek-chat` → `deepseek-v4-flash`), mas o deploy em produção (2026-07-25) falhou por um problema NOVO e diferente: `ERR_MODULE_NOT_FOUND` — `api/_lib/deepseek.ts` não é incluído no bundle da função pela Vercel (ver seção "🔴 Tentativa de deploy em produção" acima). Precisa mover o módulo pra fora da pasta prefixada com `_` e redeployar. Localmente (`npm run dev`) a correção funciona 100%.
2. 🟡 **Prompt remoto sem `saving`/`origin`** — ver divergência dev×produção acima. Ainda pendente.
3. ⬜ **Analytics.tsx não adaptado por perfil** — item 14.13 do escopo original, nunca implementado.
4. ❓ **CONTEXTO.md referenciado no README mas não existe no projeto** — link quebrado, impacto cosmético apenas.
5. 🆕⬜ **"Resumo geral" do chat local não adaptado por perfil** — achado nesta sessão (teste end-to-end), ver seção "🟢 Sessão de correção da IA remota". `src/services/ai.ts`, bloco `/resumo|como estou|situação/`. Não corrigido (fora do escopo desta sessão).

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

1. **🔴 Corrigir o empacotamento do módulo `api/_lib/deepseek.ts` na Vercel e redeployar** — a
   causa exata e os logs estão na seção "🔴 Tentativa de deploy em produção" acima
   (`ERR_MODULE_NOT_FOUND`, provável causa: pasta prefixada com `_` excluída do bundle da função).
   Correção proposta (não aplicada, aguardando autorização): mover `api/_lib/deepseek.ts` para
   `api/lib/deepseek.ts` (sem underscore) ou `lib/deepseek.ts` na raiz, ajustar os dois imports, e
   fazer um terceiro deploy. Prioridade máxima — produção está ativa com a IA remota quebrada.
2. **🟡 Sincronizar o prompt remoto com `saving`/`origin`** em ambos os arquivos, e adicionar os
   casos correspondentes em `sanitizeActions()` (`src/services/ai.ts`). Plano curto já registrado
   acima.
3. **⬜ Adaptar `Analytics.tsx` por perfil** (item 14.13 pendente) — esconder métricas de
   motorista (km, R$/km) para os outros três perfis, igual já foi feito na Home. Plano curto já
   registrado acima.
4. **🆕⬜ Corrigir "resumo geral" não adaptado por perfil** em `src/services/ai.ts` (achado nesta
   sessão). Plano curto já registrado acima.
5. Rodar a bateria de testes manuais listada em "Testes que ainda precisam ser executados"
   (agora que a IA remota funciona, dá pra fazer o teste #4 dessa lista de verdade).

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

**Causa raiz**: a Vercel **não incluiu `api/_lib/deepseek.ts` no bundle** da função serverless
`api/ai/chat.ts`. Hipótese mais provável (não 100% confirmada sem acesso a mais detalhes internos
do builder): pastas com nome prefixado por `_` dentro de `api/` são tratadas pela Vercel como
"não viram rota" — mas aparentemente esse mesmo prefixo também as exclui do rastreamento de
dependências (`@vercel/nft`) que decide quais arquivos acompanham a função no deploy, mesmo sendo
importadas de verdade por outro arquivo que É uma rota. Isso não apareceu localmente porque tanto
o Vite (dev) quanto o `vite build` (bundle do cliente) resolvem esse import perfeitamente — só o
empacotador de Serverless Functions da Vercel para `api/ai/chat.ts` se comporta diferente.

**Não é uma configuração da Vercel** (variável de ambiente, região, etc.) — é uma questão de
**onde o módulo compartilhado mora no projeto**. Por instrução explícita ("pare antes de modificar
o código novamente" quando a causa não é só configuração), **não apliquei nenhuma correção de
código**. A correção mais provável (não implementada, aguardando autorização) seria mover
`api/_lib/deepseek.ts` para fora da pasta prefixada com `_` — por exemplo `api/lib/deepseek.ts`
(sem underscore) ou uma pasta `lib/` na raiz do projeto — e ajustar os dois imports
(`vite.config.ts` e `api/ai/chat.ts`) de acordo.

### 8. Estado final da IA remota em produção após esta etapa

🔴 **Ainda não funcional para perguntas abertas.** O bug mudou de forma (antes: `deepseek-chat`
descontinuado, 502 `empty-reply`; agora: módulo não encontrado, 500
`FUNCTION_INVOCATION_FAILED`), mas o resultado prático pro usuário é parecido — perguntas abertas
não recebem resposta real da IA, caem no fallback local. A diferença é que agora **nenhuma
chamada à API da DeepSeek chega a acontecer de verdade** (a função quebra antes disso), então nem
o modelo `deepseek-v4-flash` foi exercitado em produção ainda.

O código local em `D:\Claude\AssistFin` está correto e testado (ver seção "🟢 Sessão de correção
da IA remota" acima — os testes locais com `node node_modules/vite/bin/vite.js` continuam válidos,
o problema é específico do empacotamento da Vercel). **Nenhum commit foi feito** — o fix do
type-narrowing (`isDeepSeekFailure`) existe só localmente, não commitado, não é possível reverter
via `git`.

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
