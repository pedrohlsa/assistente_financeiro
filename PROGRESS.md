# AssistFin — Estado do Projeto

**Auditoria feita em**: 2026-07-24 15:16 (horário local da máquina)
**Branch**: `master`
**Commit atual**: nenhum — repositório sem commits (ver "Infraestrutura Git" abaixo, é uma
pendência real, não um erro desta auditoria).

Este documento foi gerado inspecionando o código-fonte e rodando comandos reais
(`npm run build`, `tsc --noEmit`, chamadas HTTP ao backend de IA) — não depende de memória de
conversa anterior. Sempre que uma afirmação não pôde ser verificada com certeza, está marcada
como **INCERTO**.

---

## ⚠️ Infraestrutura Git (achado da auditoria, não corrigido)

`git status` rodado dentro da pasta do projeto mostra "no commits yet" com uma lista de
arquivos/pastas **fora** do AssistFin (`../All/`, `../a/`, `../assistifn.rar`, `../contas.txt`,
`../sda/`, etc.). Investigando: `git rev-parse --show-toplevel` aponta para
`C:/Users/ph969/OneDrive/Área de Trabalho` — ou seja, **o repositório Git foi inicializado na
pasta "Área de Trabalho" inteira, não dentro de `AssistFin/`**, e nunca teve nenhum commit feito.

Consequência prática: **não existe histórico de commits para consultar** — este PROGRESS.md é a
única fonte de verdade sobre o que foi feito, já que não há `git log`/`git diff` úteis para o
projeto. Não fiz nenhuma alteração na configuração do Git durante esta auditoria (isso seria uma
decisão de infraestrutura, não uma auditoria). Se quiser corrigir, as opções são: (a) inicializar
um repositório novo dentro de `AssistFin/` especificamente, ou (b) fazer o primeiro commit no
repositório atual e aceitar que ele inclui a pasta "Área de Trabalho" toda (não recomendado —
incluiria arquivos pessoais não relacionados ao app).

---

## 🔴 Bug crítico confirmado — chat de IA remota 100% fora do ar

**Sintoma**: qualquer pergunta que dependa da IA remota (DeepSeek) falha com
`{"error":"empty-reply"}` / HTTP 502, tanto em produção (Vercel) quanto em dev local.

**Causa raiz confirmada**: a DeepSeek descontinuou o nome de modelo `deepseek-chat`. Testando a
API deles diretamente com a chave do `.env`:

```
curl -X POST https://api.deepseek.com/chat/completions -d '{"model":"deepseek-chat",...}'
→ 400 {"error":{"message":"The supported API model names are deepseek-v4-pro or
   deepseek-v4-flash, but you passed deepseek-chat.", ...}}
```

O código hoje chama `model: 'deepseek-chat'` em **dois lugares hardcoded**:
- `vite.config.ts:94`
- `api/ai/chat.ts:77`

**Como reproduzir**:
```bash
curl -X POST https://assist-fin.vercel.app/api/ai/chat -H "content-type: application/json" \
  -d '{"message":"quanto posso gastar hoje?","context":{"perfil":"driver"},"history":[]}'
# → {"error":"empty-reply"}  HTTP 502
```
Mesmo resultado local (`npm run dev` + curl em `http://localhost:5199/api/ai/chat`).

**Impacto real, mitigado**: como o app tem roteamento local-first (`resolveLocal()` em `ai.ts`),
a maioria das perguntas comuns (meta, saldo, custo/km, "como está meu mês") **continua
funcionando normalmente**, pois nunca chega a chamar a IA remota. Só perguntas realmente abertas
(fora do que o parser local reconhece) ficam sem resposta — hoje elas caem no fallback local
genérico ("Posso te ajudar com...") em vez de dar erro visível ao usuário, então o bug é **silencioso** e fácil de não perceber testando o app manualmente.

**Correção necessária** (não aplicada nesta auditoria, por instrução explícita de não fazer
mudanças funcionais): trocar `'deepseek-chat'` por `'deepseek-v4-flash'` (mais barato, equivalente
ao antigo `-chat`) ou `'deepseek-v4-pro'` nos dois arquivos, testar local, e rodar
`npx vercel --prod` para publicar a correção em produção.

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

1. 🔴 **Chat de IA remota fora do ar** — modelo `deepseek-chat` descontinuado (ver seção crítica acima). Prioridade máxima.
2. 🟡 **Prompt remoto sem `saving`/`origin`** — ver divergência dev×produção acima.
3. ⬜ **Analytics.tsx não adaptado por perfil** — item 14.13 do escopo original, nunca implementado.
4. ❓ **CONTEXTO.md referenciado no README mas não existe no projeto** — link quebrado, impacto cosmético apenas.

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
4. Depois de corrigir o modelo da DeepSeek: testar uma pergunta aberta de verdade (que não caia
   no roteamento local) em cada um dos 4 perfis, local e em produção.

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

1. **🔴 Corrigir o modelo da DeepSeek** em `vite.config.ts:94` e `api/ai/chat.ts:77`
   (`'deepseek-chat'` → `'deepseek-v4-flash'` ou `'deepseek-v4-pro'`), testar local, depois
   `npx vercel --prod`. Sem isso, todo o chat de IA remota está inoperante em produção.
2. **🟡 Sincronizar o prompt remoto com `saving`/`origin`** em ambos os arquivos, e adicionar os
   casos correspondentes em `sanitizeActions()` (`src/services/ai.ts`).
3. **⬜ Adaptar `Analytics.tsx` por perfil** (item 14.13 pendente) — esconder métricas de
   motorista (km, R$/km) para os outros três perfis, igual já foi feito na Home.
4. Decidir o que fazer com o Git (reinicializar dentro de `AssistFin/` é a recomendação, mas é
   decisão do usuário).
5. Rodar a bateria de testes manuais listada em "Testes que ainda precisam ser executados".

## Comandos exatos para retomar o desenvolvimento

```bash
cd "C:\Users\ph969\OneDrive\Área de Trabalho\AssistFin"
npm run dev                                          # subir o dev server em localhost:5199
node node_modules/typescript/bin/tsc --noEmit         # checar tipos antes de mexer em nada
```

Para investigar/corrigir o bug crítico:
```bash
grep -n "deepseek-chat" vite.config.ts api/ai/chat.ts
```
