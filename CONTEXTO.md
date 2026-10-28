# AssistFin — Contexto do produto

Visão do produto consolidada em 25/08/2026 e revisada para o checkpoint de
28/10/2026. Regras permanentes de implementação ficam no [CLAUDE.md](CLAUDE.md);
o histórico de rodadas fica no [PROGRESS.md](PROGRESS.md). As seções antigas
abaixo preservam decisões de sua época; este checkpoint prevalece onde houver
divergência temporal. O código e os testes prevalecem sobre a documentação.

## Checkpoint vigente — 28/10/2026

- Trabalho local: `feat/assistant-intelligence-v2`, último lote retomado de `a4afa92`. Em 27-28/10/2026,
  mais de 120 commits locais depois de `c3648de` corrigiram respostas lidas como usuário
  (caixa futuro, faturas de agora, contas fixas, metas com prazo, registro e
  pergunta juntos, nomes com acento, categoria pelo nome, exclusões, períodos
  "desse/deste", agrupamento por tempo, por dia, manutenção, sobra tirando
  combustível, pedido de apagar; e, depois de `73c8d24`: proposta corrigida na
  tela, limite do cartão, parcelamento pelo nome, dívida, mês à frente em
  fatura/parcela, pergunta que virava pagamento de fatura, reserva por tipo,
  depósito em meta, janela do mês no roteador antigo, "pra pagar/vence" como
  busca, "vou receber", celular comprado, lista dos parcelamentos, limite de
  gasto por dia, pago nas faturas, "almocei 32", e no registro do motorista:
  preço do litro, viagens ditas, horas × km, "na 99", grupos de corrida,
  gorjeta, quilometragem da troca e valor depois das corridas; na conversa:
  "compara com setembro", "e de aluguel?", "e de mercado?", rótulo do texto
  e cartão sobre gasto; nas simulações: conta fixa pelo nome e corte pela
  metade; nas metas: prazo "até dezembro", nome no conector, retirada,
  alteração sem nome). Após `a4afa92`, foram corrigidas a data do pagamento de
  fatura, manutenção sem custo (pergunta o valor e preserva o hodômetro), receita
  futura por recorrências abertas, intenção futura junto com meta e consulta
  mensal de depósitos em metas (explica a ausência de histórico, sem inventar).
  O checkpoint `c72a069` salvou esse lote. Na verificação seguinte, a recarga
  imediata após Confirmar perdeu um registro por causa do debounce: agora a
  gravação é descarregada ao sair/ocultar a página. O smoke local confirmou
  manutenção, confirmação, recarga, desfazer e nova recarga. A simulação de
  gasto passou a incluir faturas e parcelas no cálculo de compromissos.
  Na rodada seguinte, entrada ausente também passou a considerar esses
  compromissos (30 dias), excluindo receita futura da média histórica e do
  saldo na data consultada. A conversa aceita uma nova hipótese completa,
  alterna previsão/recebido preservando a origem e recupera o acumulado das
  metas após uma pergunta mensal sem histórico. A Home e os resumos passaram
  a usar os mesmos compromissos; cobertura fica indefinida quando pendências
  incertas podem inverter o saldo ou há legado ambíguo de cartão.
  O saldo central também passou a ignorar movimentações e pagamentos com
  data futura, inclusive quitação direta/parcial de parcela.
  Novos pagamentos de fatura/parcela recusam datas futuras ou inválidas;
  antecipar hoje uma fatura que vencerá depois continua permitido na tela.
  Retomada: docs/CODEX_RESUME.md.
  Lista de pendências no
  fim de [PROGRESS.md](PROGRESS.md), seção "Pendências em 28/10/2026".
  `.claude/launch.json` é modificação local preexistente e não pertence às entregas.
- A produção publicada corresponde à `main` em `e6f6229`, não à Intelligence V2.
  O deployment de 25/09/2026 usa `deepseek-v4-pro` com thinking desligado;
  essa informação vem do registro de deploy e smoke, não de uma checagem ao vivo
  nesta revisão documental. Não houve push, merge, deploy ou APK da V2.
- A V2 acrescentou consultas e cenários multi-entidade, continuidade de conversa,
  preferências locais explícitas e reconciliação parcial de cartões. Baseline
  local mais recente: 666/666 corpus, 99/99 consulta/cenário/continuidade,
  50/50 semânticos, 607/607 adversariais, 4.088 + 3.800 metamórficos,
  1.416 fuzz, 151/151 invariantes e 468/468 verificações remotas **offline**;
  typechecks, teste de dinheiro, build e rubrica passaram.
- **NOT READY para merge/deploy.** O parecer sobre `345d55e` encontrou oito
  falhas e quatro oráculos falsamente verdes. Os REDs e correções locais cobrem
  corridas não recebidas, âncora de saldo, foco de consulta, rótulos, comparação,
  dívida após pagamento parcial e propagação de saldo legado ambíguo. O novo
  diff ainda precisa de auditoria independente. Pagamento parcial legado sem
  distribuição por parcela tem remoção recusada se contradisser quitações
  posteriores; falta fluxo de reconciliação com feedback na interface. Fatura
  mista não permite atribuir pagamento parcial a uma parcela específica.
  Horários legados só com minuto não revelam a ordem real. Houve smoke local
  de navegador/persistência com dados fictícios; isso não valida todos os fluxos
  nem dados legados reais. Detalhes na última seção de
  [PROGRESS.md](PROGRESS.md).

---

## 1. Produto

### Finalidade

Gestão financeira pessoal em pt-BR com um assistente que entende linguagem natural. O usuário
registra dinheiro conversando ("ganhei 250 hoje", "gastei 40 de gasolina") ou por formulários, e
o app responde perguntas usando **somente os dados reais dele** — nunca médias inventadas.

> "Eu cuido dos seus números enquanto você cuida da sua rotina."

### Público

Pessoas com renda variável ou pouco controle formal: motoristas de aplicativo, autônomos,
assalariados e qualquer pessoa que queira acompanhar entradas, saídas, contas e reserva sem
planilha.

### Perfis

`state.settings.profile: 'driver' | 'autonomo' | 'clt' | 'business' (legado) | 'other'`

O onboarding oferece 4 opções. `'business'` só existe em dados antigos e é tratado como
não-motorista.

| Perfil | Quem é | O que vê de diferente |
|---|---|---|
| `driver` | Motorista de aplicativo (Uber/99/inDrive) | Meta **diária**, km, viagens, horas, veículo, combustível, manutenção, custo por km, analisador de corrida, taxa da 99, analisador flutuante no Android |
| `autonomo` | Renda própria: aluguéis, serviços, vendas, comissões | Meta **mensal para guardar**, entradas recorrentes, previsão do mês |
| `clt` | Salário fixo | Igual ao autônomo, sem dias de trabalho configuráveis |
| `other` | Genérico | Igual ao autônomo, linguagem neutra |

`src/services/profile.ts` é a fonte única dessas regras (`isDriver`, `shouldAsk99Fee`,
`can99FeeApply`, `defaultIncomeCategory`, `MENTIONS_99`, `findPossibleDuplicate`,
`monthlyTargetLabel`, `goalCadenceOf`). Nenhum outro arquivo compara `profile === 'driver'`
diretamente.

### Offline-first

Não existe backend de dados. Todo o estado vive no `localStorage` do dispositivo, na chave
`assistfin-state-v1`. O app funciona inteiro sem rede: registros, cálculos, metas, projeções,
cartões e o motor de respostas local. Só a IA remota (perguntas abertas) exige internet, e ela é
opcional (`settings.remoteAi`). Sincronização em nuvem é **integração pendente**.

### Mobile-first

Layout desenhado para telas pequenas (verificado a 430 × 900), navegação por barra inferior,
folhas (sheets) em vez de páginas, botão flutuante contextual, entrada por voz via Web Speech API.

### Estado atual das plataformas

- **Web**: SPA em produção na Vercel, alias `https://assist-fin.vercel.app`.
- **Vercel**: além do site estático, hospeda a função serverless `api/ai/chat.ts`.
- **Android**: APK gerado por Capacitor 8, versão **1.1.0 (versionCode 2)**, instalado e testado
  em um Moto G50. Inclui o analisador de corrida flutuante (overlay + acesso a notificações).

---

## 2. Arquitetura

### Tecnologias

- **React 18** + **TypeScript 5.5** + **Vite 5**.
- **React Router 6** com `HashRouter` — SPA sem SSR, necessário para funcionar dentro do APK.
- **Capacitor 8** empacota o build web como app Android nativo (pasta `android/`), com
  `@capacitor/local-notifications` para avisos de contas a vencer e um plugin nativo próprio
  `RideOverlay` (ponte em `src/services/rideOverlay.ts`).

### Estado

`useReducer` + Context em `src/store/store.tsx`. Toda mutação passa por `dispatch`, o que deixa o
caminho pronto para uma fila de sincronização futura. A persistência é um `useEffect` com
**debounce de 150 ms** que grava o estado inteiro em `localStorage`.

Chave: **`assistfin-state-v1`**. Nunca existiu uma v2 — a compatibilidade é mantida por campos
opcionais e por `normalizeState()`, que garante que todo array esperado exista mesmo em estados
salvos antes da funcionalidade existir.

### Estrutura de pastas

```
src/
  models/types.ts     # todas as entidades e o tipo ParsedAction
  data/               # categorias padrão (+ mergeDefaultCategories) e gerador de dados demo
  utils/
    format.ts         # parseMoney (parser monetário único), datas, dueLabel
    text.ts           # sentenceCase, normalizeName/sameName, nomes de dias da semana
  services/
    calc.ts           # motor financeiro: saldo, metas, recorrências, projeções, insights
    cards.ts          # cartões, faturas, parcelas, limites
    nlp.ts            # parser determinístico pt-BR
    ai.ts             # motor de respostas local + contexto e sanitização da IA remota
    profile.ts        # regras de perfil
    navigation.ts     # rota → aba da barra inferior (fonte única do indicador)
    notifications.ts  # agendamento de notificações locais
    rideOverlay.ts    # ponte para o plugin Android do analisador flutuante
  store/store.tsx     # estado global, reducer, persistência, applyParsedAction
  components/         # design system: ui, forms, cardForms, nav, PendingRecurrings
  screens/            # Home, Chat, Transactions, Goals, Planning, Cards, Vehicle,
                      # RideAnalyzer, Analytics, Settings, More, Onboarding
api/
  _lib/deepseek.ts    # config e chamada da DeepSeek — server-only
  ai/chat.ts          # função serverless de produção
vite.config.ts        # dev server + middleware de IA equivalente
scripts/              # test-app.mts (npm test) e test-money.mjs
android/              # projeto Capacitor
```

### Assistente (arquitetura v1)

O assistente tem contrato versionado e vive em `src/assistant/`:

- **`contracts.ts`** — catálogo de ações (`ACTION_CATALOG`), validação determinística e códigos
  de erro. É a fonte de tudo: tipos, validação, schema do prompt, documentação e testes.
- **`clauses.ts`** — segmenta a mensagem em cláusulas com posição, classifica intenção e calcula
  **cobertura**. Achar uma ação não significa ter compreendido a mensagem.
- **`numbers.ts` / `dates.ts`** — números por extenso e datas em pt-BR.
- **`drafts.ts`** — conversa multiturno: guarda a ação incompleta e encaixa respostas curtas.
- **`corrections.ts`** — correções e referências sobre a proposta pendente.
- **`execute.ts`** — aplicação pura, sequencial e **atômica** do lote confirmado.
- **`journal.ts`** — auditoria por diferença de estado e reversão do lote inteiro.
- **`editSaved.ts`** — correção de lançamento já salvo, com busca **local** de candidatos.
- **`proposalEdit.ts`** — campos editáveis da proposta, derivados do catálogo.
- **`orchestrator.ts`** — amarra tudo e decide local × remoto por cobertura.
- **`capabilities.ts`** — o que ESTE usuário pode fazer; mora sozinho para quebrar um ciclo
  de import entre `services/ai.ts` e o orquestrador.

Desde 25/08/2026 há mais quatro camadas, todas **locais e somente leitura**:

- **`query/`** — consulta financeira arbitrária por uma DSL de vocabulário FECHADO (10 fontes,
  12 métricas, 13 agrupamentos, campos permitidos por fonte). `validateQueryPlan()` é o
  `validateAction` das consultas: recusa com código próprio, nunca em silêncio.
- **`scenario/`** — "e se?" sobre uma CÓPIA projetada do estado, reusando as funções reais de
  parcela, fatura e projeção, para que simulação e realidade não possam divergir.
- **`conversation/focus.ts`** — memória de foco em RAM (mesmo TTL dos rascunhos): o follow-up
  REFINA o plano anterior em vez de recomeçar.
- **`semantic/`** — blocos do turno, evidência por CAMPO com posto, tolerância conservadora a
  erro de digitação e o dia telegráfico do motorista.

O modelo remoto ganhou um papel a mais, e é o mais seguro que ele pode ter: **planejar** a
consulta que o motor local não entendeu. Recebe o vocabulário da DSL, as categorias e os nomes
de cartão e de meta — nunca um lançamento. O plano volta, é validado com as capacidades reais
deste aparelho e executado aqui. Nenhum número sai do dispositivo.

Desde 15/09/2026 o chat remoto também não recebe a transcrição da conversa: recebe a estrutura do
assunto anterior e, só para pergunta ou pedido, agregados do aparelho (regra 61). E uma leitura
local de baixa confiança — número de período lido como valor, "3 mil" lido como 3, meta lida como
despesa — não fecha mais a frase: a ação é descartada e a pergunta segue para a consulta local ou
para o remoto (regra 62).

`api/_lib/assistantPrompt.ts` é a **fonte única** da SYSTEM_PROMPT, gerada a partir do catálogo e
das capacidades reais do usuário; `api/_lib/assistantHandler.ts` concentra o pipeline do endpoint.
`vite.config.ts` e `api/ai/chat.ts` são cascas finas sobre ele — divergência dev × produção deixou
de ser possível por construção.

Detalhes e limitações honestas em [docs/AI_CURRENT_STATE.md](docs/AI_CURRENT_STATE.md).

### Endpoints

Só existe um: **`POST /api/ai/chat`**.

- Corpo do chat: `{ message, context, conversation }`. O `context` é o **mínimo** montado por
  `buildAiContext()` — perfil, categorias, nomes de cartão e meta e, só quando o trecho é
  pergunta ou pedido, agregados; nunca lançamento, descrição, saldo ou nome do usuário.
  `conversation` é a ESTRUTURA do assunto anterior, nunca as mensagens (regra 61). O servidor
  ignora `history` (de um app antigo) e aplica a própria lista de campos permitidos.
- Corpo do planejador: `{ task: 'plan-query', message, context }`, com perfil, categorias e
  nomes de cartão e meta — nada além.
- Resposta: `{ reply, actions }` em caso de sucesso, ou `{ error, message }` com uma mensagem
  segura em caso de falha.
- Duas implementações espelhadas: o middleware `aiProxy()` em `vite.config.ts` (dev) e
  `api/ai/chat.ts` (Vercel, produção/APK, endereçado por `VITE_AI_API_URL`).

### Integração DeepSeek

`api/_lib/deepseek.ts` centraliza config e chamada: modelo (default `deepseek-v4-pro`,
thinking desligado), base URL
(default `https://api.deepseek.com`), timeout (20 s), classificação de erro, retry único quando a
resposta vem vazia, e mensagens de erro seguras. A chave nunca chega ao cliente.

`response_format: json_object` é evitado de propósito: em modelos anteriores ele devolvia respostas
em branco com prompts longos. O JSON é pedido no prompt e extraído da resposta; texto puro vira
`reply` sem ações.

O antigo padrão `deepseek-v4-flash` foi substituído após a avaliação comparativa
registrada em [docs/AI_REMOTE_EVAL.md](docs/AI_REMOTE_EVAL.md) §16. A produção
de 25/09/2026 usa o padrão do código porque o override `DEEPSEEK_MODEL` da
Vercel foi removido. Qualquer nova troca de modelo ou modo de pensamento exige
nova medição (regra 60).

Variáveis de ambiente (server-only, sem prefixo `VITE_`): `DEEPSEEK_API_KEY` (obrigatória),
`DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_TIMEOUT_MS`. Ver `.env.example`.

### Build e deploy

```bash
npm install
npm run dev      # http://localhost:5199 (inclui o proxy de IA)
npm test         # tsx scripts/test-app.mts
npm run build    # tsc -b --noCheck && vite build → dist/
node node_modules/typescript/bin/tsc --noEmit   # checagem ESTRITA (o build usa --noCheck)
npx vercel build --prod                          # build local, sem publicar
npx vercel --prod                                # deploy (só com autorização)
```

APK: `npm run build` → `npx cap sync android` → `./gradlew.bat assembleDebug`.

**Atenção**: `tsconfig.json` inclui apenas `"src"`. `api/**` e `vite.config.ts` **não** são
checados por `tsc --noEmit`; quem valida esses arquivos é o build da Vercel. E como
`package.json` tem `"type": "module"`, os imports relativos dentro de `api/**` precisam de
extensão explícita (`from '../_lib/deepseek.js'`).

---

## 3. Regras financeiras permanentes

As invariantes completas estão no [CLAUDE.md](CLAUDE.md) (regras 1–24). Resumo do modelo:

### Saldo real

Fonte única: **`currentBalance(state)`** em `calc.ts`. Nenhuma tela calcula saldo por conta
própria e nenhum reducer soma ou subtrai `settings.balance`.

`settings.balance` é só a **âncora** informada pelo usuário, com data em `settings.balanceAsOf`.
O saldo de hoje é a âncora mais tudo que realmente mexeu no caixa depois dela:

```
saldo = âncora
      + receitas confirmadas        (type: 'income')
      + entradas financiadas        (type: 'financed-cash-inflow')
      − despesas confirmadas        (type: 'expense')
      − faturas pagas com "descontar do saldo" (CardPayment.fromBalance)
```

### Entradas recebidas × previstas

Nunca se misturam. Uma entrada recorrente (salário, aluguel) é **previsão** até o usuário
confirmar o recebimento. Só a confirmação cria a `Transaction`, e a chave única
`recurringId` + `occurrenceDate` — espelhada em `RecurringExpense.occurrences[]` — impede
confirmar o mesmo período duas vezes. Ocorrência resolvida sai automaticamente das listas de
previsto.

### Despesas

Somatórios filtram `type === 'expense'` explicitamente. Contas fixas cadastradas são previsão:
não geram movimentação nem alteram saldo até serem confirmadas.

### Saving e reserva

`type: 'saving'` é transferência para reserva/investimento. Não é receita nem despesa; hoje só
alimenta `savedThisMonth()` e, por decisão de projeto documentada em `currentBalance()`, **fica
fora do saldo em conta** — a reserva do AssistFin não é necessariamente outra conta bancária.
Registro: FAB → "Guardar dinheiro" (`SavingForm` em `components/forms.tsx`), categoria `reserva`.

> Pendência conhecida: tratar `saving` como transferência interna (reduzir o saldo disponível,
> aumentar a reserva, sem virar despesa) e criar "Retirar da reserva" ainda **não** foi
> implementado. Ver seção 5.

### Resultado do mês

`Sobra do mês` (positivo) ou `Déficit do mês` (negativo) = entradas − despesas **realizadas**
(`monthStats`). Resultado líquido **não** é dinheiro guardado. "Meta mensal alcançada" só aparece
quando `saved >= target`; ter sobra suficiente é rotulado "há valor disponível para cumprir sua
meta".

### Cartões, parcelas e faturas

Regra rígida, para nunca contar duas vezes:

- Compra parcelada **não cria `Transaction`**. Ela vira `InstallmentPlan` + `Installment[]`.
- O histórico da compra é o **valor total** (no plano); o fluxo de caixa mensal são as **parcelas
  que vencem no mês** (`Installment.dueDate`). Nunca os dois somados.
- Pagar a fatura (`CardPayment`) quita a dívida e reduz o saldo, mas **não gera despesa** — ela já
  foi contada como parcela.
- Consequência desejada: quem não usa cartões tem `monthStats` idêntico ao que sempre foi.
- Juros: `totalAmount = principalAmount + interestAmount`. Planos antigos sem `principalAmount`
  já têm o valor final em `totalAmount` e nunca devem ser reinterpretados.
- Assinatura removida usa remoção **lógica** (`removedAt` + `endDate`): some da lista ativa sem
  apagar cobranças de faturas anteriores.
- Dados de cartão armazenados: apenas nome, instituição, **4 últimos dígitos**, limite, dia de
  fechamento e de vencimento. Nunca número completo, CVV, senha ou token.

### Entrada financiada

`type: 'financed-cash-inflow'` — dinheiro recebido agora em troca de dívida parcelada no cartão.
**Nunca** é `'income'`: fica fora de receita, lucro e faturamento por construção. O dinheiro entra
no saldo, a dívida vive no `InstallmentPlan`, e a UI deixa claro que o patrimônio não aumentou.

### Metas

`kind: 'goal'` **sempre cria** meta nova; alterar uma existente é `goal-update`; guardar nela é
`goal-deposit`. Nome equivalente (`sameName()` — ignora caixa, acento e espaços) gera confirmação
com três saídas: criar mesmo assim, editar a existente, cancelar. Vale para onboarding, formulário,
FAB, tela de Metas e IA. Mesma regra para cartões (`findCardByExactName`).

Meta diária (`dailyGoal()`) só existe no perfil motorista, e é composta por contas fixas +
objetivo de lucro + metas pessoais + déficits + parcelas do mês + margem de segurança, diluídos
pelos dias de trabalho.

### Recorrências

`startDate` é a âncora da sequência. A frequência real é `interval` + `intervalUnit`
(`day|week|month|year`); `frequency` é legado e só alimenta o fallback documentado em
`recurrenceAnchor()`. Em meses curtos o dia original é preservado e só reduzido ao último dia
daquele mês — nunca degrada permanentemente para 28. Uma conta cadastrada com o dia já vencido
**não nasce atrasada**: a primeira ocorrência é a do próximo período. Toda data sai de
`occurrencesBetween()`; o texto legível sai de `describeRecurrence()`, que nunca mostra dia da
semana como número.

### Taxa da 99

Existe **somente** quando `perfil === 'driver'` **E** a receita é da categoria `corridas` **OU** o
usuário menciona a plataforma explicitamente (`MENTIONS_99`, que não casa com "recebi 99 reais").
Nunca em aluguel, salário, venda ou freelance. Nunca em outro perfil. É sempre uma **pergunta
separada** depois do registro, porque a taxa só existe quando o saque acontece.

### Motorista

O perfil `driver` é o mais maduro e não pode perder funcionalidade quando outro perfil muda.
Hodômetro (`Vehicle.odometer`) é dado do veículo e **nunca** vira km trabalhado (`WorkSession.km`).
Custos do veículo começam em zero e só são calculados a partir de registros reais — o app nunca
inventa consumo ou preço de combustível.

### Confirmação de ações

**Nada é registrado sem confirmação explícita.** Toda ação proposta pela IA (local ou remota) vira
um par de botões Confirmar/Cancelar no chat. Ambiguidade real ("gás") interrompe o fluxo e vira
pergunta antes de qualquer ação. Ações destrutivas (reset, substituir backup, remover assinatura,
cancelar parcelas) usam `<ConfirmDialog>`, nunca `window.confirm`, porque a janela nativa é
bloqueada em parte dos WebViews do Android.

### Compatibilidade de dados

Todo campo novo em `Settings`/`Transaction`/`RecurringExpense`/`Category`/`InstallmentPlan` é
**opcional**. O hidrate faz merge raso de `settings` com os defaults, então campo novo em
`Settings` já nasce com fallback; campos novos em outras entidades devem ser tratados como
`undefined`. Categorias padrão novas chegam por **fusão** (`mergeDefaultCategories`), preservando
personalizadas e o estado "arquivada". Importar backup oferece **Mesclar** (dedup por `id`) ou
**Substituir tudo** — nunca substitui em silêncio.

---

## 4. Estado funcional atual

Retrato funcional iniciado em 25/08/2026; para estado de entrega atual e
bloqueios, use o checkpoint no início deste arquivo.

| Área | Situação |
|---|---|
| **Onboarding** | Implementado. Escolha de perfil, nome, prioridade e primeira meta, com aviso de meta duplicada. |
| **Home** | Implementado e bifurcado por `isDriver()`. Motorista: meta diária, cards de km/viagens/R$ por km/por hora, insights. Demais perfis: resultado realizado do mês, sobra/déficit, meta mensal para guardar com "já transferido para reserva", contas próximas. Ritmo dos objetivos configurável (diário/semanal/mensal). |
| **Movimentações** | Implementado. Timeline com filtros de período e categoria, busca global (inclusive "mais de R$ 100"), lista curta com folha de detalhes, remoção com confirmação e "Desfazer". |
| **Metas** | Implementado. Metas de compra com viabilidade e sugestão de prazo, meta mensal para guardar, distinção explícita entre sobra disponível e dinheiro guardado. |
| **Planejamento** | Implementado. Contas fixas e entradas recorrentes separadas, timeline de vencimentos, previsão do mês, projeção mês a mês, orçamentos por categoria. |
| **Cartões** | Implementado. Cadastro (sem dados sensíveis), fatura corrente com status, próximas faturas, limite comprometido/disponível, pagamento total ou parcial, assinaturas recorrentes com remoção lógica. |
| **Parcelamentos** | Implementado. Compra parcelada com ou sem cartão, parcelamento avulso, entrada financiada, juros separados do principal, progresso do plano, cancelamento de parcelas futuras preservando histórico. |
| **Veículo** | Implementado (motorista). Hodômetro separado dos km trabalhados, abastecimentos com km/L real, manutenções com vida útil, custo real por km. |
| **Motorista** | Implementado. Meta diária, analisador de corrida "vale a pena?", taxa da 99 como pergunta separada, parser composto ("430 Uber, mais 399 da 99, 163 de gasolina, 24 L e 161 km"). |
| **IA** | Funcionando. Motor local determinístico + DeepSeek para perguntas abertas, com datas futuras/inválidas tratadas sem criar movimentação realizada e falha remota explícita. Detalhes e limites em [docs/AI_CURRENT_STATE.md](docs/AI_CURRENT_STATE.md). |
| **IA adaptativa** | Implementado (17/08/2026). O assistente usa o histórico CONFIRMADO deste aparelho para sugerir a categoria que o usuário costuma dar a cada frase, manter a grafia que ele já escreveu (descrição e origem), avisar sobre valor fora do padrão dele, montar sugestões da vida dele e responder o ritmo do motorista. Aprender exige repetição e evidência; o recente pesa mais sem que o antigo desapareça; palavra genérica isolada não identifica lugar; categoria arquivada nunca é aplicada; e nada é registrado sem confirmação. O usuário pode perguntar por que o app decidiu assim e desligar tudo em Configurações → Assistente adaptativo. |
| **IA copiloto** | Implementado (25/08/2026). Consulta financeira arbitrária por DSL fechada, executada no aparelho ("quanto gastei em obra nos últimos 3 meses?", "qual dia da semana eu faturo mais?", "compare com o mês passado", "tirando cimento"); cenário somente leitura ("se eu comprar um pc de 4000 em 10x, dá ruim?"), que sempre se identifica como simulação; e follow-up de verdade — "e mês passado?" troca o período e MANTÉM o filtro. O modelo remoto pode PLANEJAR a consulta que o local não entendeu, mas nunca calcula: o plano é validado e executado aqui. Empate é dito em vez de desempatado, e pergunta de sim ou não começa por sim ou não. |
| **Análises** | Implementado, mas **não é sensível a perfil** (ver pendências). Diário/semanal/mensal/anual, comparativo com período anterior, gastos por categoria, exportação CSV e impressão. |
| **Configurações** | Implementado. Perfil, tema, dias de trabalho, custos do veículo, categorias personalizadas, notificações, IA remota ligada/desligada, **assistente adaptativo ligado/desligado** (com a explicação em português do que é aprendido, de que fica no aparelho e de que apagar o histórico apaga o aprendizado), "Limpar lançamentos e trabalho", reset total. |
| **Backup** | Implementado. Exportar JSON; restaurar com escolha entre Mesclar e Substituir tudo, usando `<ConfirmDialog>`. |
| **Android** | Implementado. 1.1.0 (versionCode 2), notificações locais, analisador flutuante por overlay + acesso a notificações (sem serviço de acessibilidade). Quando a plataforma não expõe valor/km na notificação, o painel devolve ao app para análise manual. |
| **Modo demo** | Implementado, com selo "demo" visível. |

---

## 5. Limitações e pendências reais

Lista histórica confirmada em 28/07/2026; alguns itens foram resolvidos em
rodadas posteriores. Para pendências atuais, use o checkpoint e a última seção
de `PROGRESS.md`.

### Financeiro

1. **`type: 'saving'` ainda não é transferência interna.** Guardar dinheiro não reduz o saldo
   disponível (`currentBalance` ignora `saving`), não existe "Retirar da reserva", e não há campo
   para marcar um saving como transferência de saldo. Solicitado, ainda não implementado.
2. **Antecipação de parcelas** não tem campos de desconto ou juros.
3. **Não há tela para editar uma parcela específica** de um plano.
4. **`CardPayment.accountId`** não existe; pagamento de fatura não é atribuído a uma conta.
5. **Primeira ocorrência de assinatura** de cartão tem uma inconsistência de um mês em relação a
   contas recorrentes comuns.
6. **Não há tela para editar uma recorrência existente** — só criar e remover.
7. **`describeRecurrence()` suporta um único dia da semana** por recorrência.

### IA

Os vinte pontos estruturais da auditoria de 28/07/2026 foram resolvidos na reformulação do
assistente, e a rodada de QA adversarial corrigiu mais 17 defeitos de interpretação e interface.
Detalhe completo em [docs/AI_CURRENT_STATE.md §6](docs/AI_CURRENT_STATE.md).

**Corrigido em 29/07/2026**:

- Datas futuras, inválidas e períodos sem dia exato não são mais substituídos por hoje.
- `daqui a/em X dias|semanas|meses|anos`, `próxima semana`, `mês que vem` e sinais comuns sem dia
  exato falham de forma explícita. O app não ganhou agendamento: intenção futura é explicada.
- Resposta vazia e HTTP 502 da DeepSeek foram reproduzidos e auditados. Falha não cria ação,
  preserva o que o motor local entendeu e explica a indisponibilidade quando a pergunta dependia
  só do remoto. Nenhum retry novo foi adicionado.

**Implementado em 29/07/2026 (segunda rodada)**:

- **Auditoria completa e reversível** de todo lote do assistente (`assistantJournal`),
  cobrindo entidades criadas **e alteradas**. Ver [CLAUDE.md](CLAUDE.md) regra 31.
- **Edição da proposta** derivada do catálogo e validada por `validateAction()`.
- **"Desfaz o último"**: reverte o lote inteiro pelo journal, listando o que sai e
  exigindo confirmação; lote sem journal é recusado.
- **Corrigir lançamento já salvo** por conversa: `Transaction` simples e ocorrência
  recorrente materializada, com busca local e desambiguação. Ver regra 32.

**Fora do escopo por decisão** (documentado, não esquecido):

8. Editar por conversa a **estrutura** de parcelamento, cartão, meta, abastecimento,
   trabalho, manutenção e template de recorrência — o assistente recusa e indica a tela.
9. **`Analytics.tsx` por perfil** — pendência anterior a esta reformulação.

**Nota histórica:** "meio" não era interpretado; intervalos de data não viravam intervalo
estruturado naquela rodada (a V2 passou a reconhecer intervalos `desde` e fechados).
A proposta pendente não vai no payload remoto
(investigado, sem falha demonstrada); a qualidade do texto da IA remota não é testada, só o
contrato.

### Produto

11. **`Analytics.tsx` não é sensível a perfil** (`isDriver` não é usado lá): relatórios mostram a
    mesma estrutura para motorista e não motorista.
12. **Sincronização em nuvem** não existe — o app é single-device.
13. **Sem autenticação e sem multiusuário.**
14. **Registro histórico superado:** o redeploy da IA remota foi feito em
    25/09/2026. A Intelligence V2 desta branch ainda não foi publicada.
