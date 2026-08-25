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
    cartões. Assinatura removida usa `RecurringCardCharge.removedAt?` + `endDate`, some da lista
    ativa sem apagar cobranças de faturas anteriores. Ver `src/services/cards.ts`.
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
16. **Ações destrutivas não usam `window.confirm`**. Confirmações de reset, substituição de
    backup, remoção de assinatura, quitação e cancelamento de parcelas usam
    `<ConfirmDialog>` (`components/ui.tsx`), porque a janela nativa é bloqueada ou ignorada em
    parte dos WebViews do Android. **Reset apaga storage e estado pelo mesmo caminho**:
    `resetAllData()` (`store.tsx`) é a
    única operação de apagar tudo — usada pelo botão das Configurações e pelo comando
    confirmado da IA. Ela cancela a gravação debounced pendente, remove **somente** a chave
    `assistfin-state-v1` (nunca `localStorage.clear()`, que afetaria outros apps do domínio) e
    só então restaura o estado inicial.
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
24. **`api/**` não é checado pelo `tsc` local**. `tsconfig.json` inclui só `"src"`, então
    `node node_modules/typescript/bin/tsc --noEmit` passa mesmo com erro na função serverless —
    quem valida esses arquivos é o build da Vercel. Duas consequências permanentes: (a) como
    `package.json` tem `"type": "module"`, todo import relativo dentro de `api/**` precisa de
    extensão explícita (`from '../_lib/deepseek.js'`), senão o loader ESM do Node quebra em
    produção; (b) sob `strict: false` o TypeScript não estreita união discriminada a partir de
    `if (!out.ok)` — use o predicado `isDeepSeekFailure()`. Antes de publicar qualquer mudança em
    `api/**` ou `vite.config.ts`, rodar `npx vercel build --prod` localmente.

25. **A `SYSTEM_PROMPT` tem UMA fonte só**. Ela vive em `api/_lib/assistantPrompt.ts`
    e é GERADA a partir do catálogo de ações (`ACTION_CATALOG` em
    `src/assistant/contracts.ts`) mais as capacidades reais do usuário. `vite.config.ts`
    e `api/ai/chat.ts` são cascas finas sobre `handleAssistantRequest` — nenhum dos dois
    contém prompt, validação ou regra de negócio. Nunca voltar a copiar prompt: foi assim
    que dev e produção divergiram em silêncio por duas rodadas.
26. **Nada entra no estado sem passar por `validateAction()`**. É a MESMA função no
    servidor e no cliente, e valida contra o catálogo: tipo do campo, faixa de valor,
    categoria existente e do tipo certo, e perfil. Ação recusada é sempre DEVOLVIDA com o
    código do motivo — descartar em silêncio é proibido. `reset` nunca é aceito do canal
    remoto (`remoteAllowed: false`).
27. **Achar uma ação não é compreender a mensagem**. A interpretação é por CLÁUSULA
    (`src/assistant/clauses.ts`), com posição preservada e cobertura calculada; a IA
    remota só é chamada pelo que sobrou, e reconcilia em vez de duplicar. Uma mensagem
    que registra E pergunta responde às duas metades, com o número marcado como
    hipotético até a confirmação.
28. **Lote do assistente é atômico e sequencial**. `applyBatchPure()`
    (`src/assistant/execute.ts`) aplica cada ação sobre o estado que a anterior produziu
    e só grava se TODAS passarem; o reducer usa a action única `assistantBatch`. Nunca
    voltar ao `forEach(applyParsedAction(dispatch, state, ...))`: ele passava o mesmo
    estado velho para todas e dois depósitos na mesma meta se sobrescreviam.
29. **Erro específico, sempre**. Cada ação confirmada devolve
    `ActionExecutionResult` com código próprio (`card-not-found`, `invoice-empty`,
    `category-wrong-type`, `goal-not-found`…). É proibido reportar "não encontrei a meta"
    para qualquer falha — foi exatamente esse erro genérico que mandava o usuário para a
    tela errada.
30. **Um regex novo exige um caso novo**. `tests/assistant/cases*.ts` é o corpus de
    regressão (roda em `npm test`, offline e com data fixa) e
    `tests/assistant/properties.ts` guarda as invariantes financeiras. Mexeu em parser,
    orquestrador ou validação sem acrescentar caso? A mudança não está terminada.
31. **Todo lote do assistente é auditável e reversível**. `AppState.assistantJournal`
    (opcional, retrocompatível) guarda por lote: `batchId`, versão do contrato, motor,
    `createdAt` completo, perfil na criação e o **ID** da mensagem de origem — nunca o
    texto da conversa. As operações são derivadas por DIFERENÇA entre o estado antes e
    depois (`src/assistant/journal.ts`), então ação nova nasce auditada sem que cada
    `case` do executor precise se registrar. `assistantBatchId` dentro da entidade **não
    basta**: ele só marca o que nasceu no lote, e depósito em meta, pagamento de fatura e
    manutenção ALTERAM objetos que já existiam. Journal e lote gravam no mesmo estado
    atômico. Lote sem entrada no journal (anterior a esta versão ou fora do limite de 20)
    é **recusado** — nunca revertido por adivinhação. Desfazer fecha o lote com `undoneAt`
    em vez de virar um lote novo, e backup mesclado nunca traz o journal do outro estado.
32. **Corrigir e desfazer são coisas diferentes**. `edit-transaction` altera uma
    `Transaction` já salva (valor, descrição, categoria, origem, data — **nunca o tipo**);
    `undo-batch` reverte o lote inteiro. Editar uma ocorrência recorrente materializada
    não toca no template nem a libera para nova confirmação; desfazer o lote libera.
    As duas ações têm `remoteAllowed: false`: o histórico não vai para a IA remota, então
    ela também não propõe correção nem reversão sobre o que não vê. Lançamento que é a
    ponta de outra estrutura (entrada financiada, abastecimento, manutenção) é **recusado**
    com o nome da tela que corrige de verdade.

33. **Perguntar não é movimentar dinheiro, e corrigir não é registrar.** Três guardas
    que valem para a classe inteira, não para a frase que revelou cada uma:
    (a) pergunta com valor nunca vira lançamento — o verbo da pergunta está no
    INFINITIVO ("posso GASTAR 50 no mercado?"), então nenhuma lista de verbo
    conjugado a barra; (b) frase que só existe para consertar algo já dito
    (`looksLikeRetraction`: "na verdade", "me enganei", "errei", "não foi/era")
    não cria lançamento quando não há proposta na tela — sem alvo, "na verdade foi
    200" inventava um gasto de R$ 200; (c) conta que se repete (`looksRecurring`)
    é PREVISÃO pela regra 18 e nunca é gravada como movimento de hoje — o
    assistente não cadastra recorrência e aponta o Planejamento. As guardas (b) e
    (c) são estreitas de propósito: a lista geral de correção contém palavras de
    registro legítimo ("comprei uma TROCA de óleo"), e "todo mês" sem valor não
    descreve conta nenhuma. Invariantes 56 e 57.
34. **O sinal do dinheiro do motorista nunca se inverte.** `foi`, `deu` e `saiu` são
    verbos de DESPESA no parser, mas para quem roda o dia inteiro "foi 400 hoje" é o
    FATURAMENTO. `driverDayResult()` (`nlp.ts`) trata a classe, só no perfil
    motorista, e só quando não há verbo de gasto explícito — este manda sempre.
    Valor sem nenhum sinal de resultado ("hoje 250") vira PERGUNTA, jamais palpite.
    Um dia inteiro NÃO inventa "1 viagem": cravar isso destrói o ganho por viagem.
    Invariantes 54 e 55 travam os dois sentidos.
35. **O corpus só sabe o que já perguntaram a ele.** Duas rodadas seguidas
    encontraram a maioria dos defeitos FORA dele: a adversarial no navegador, a de
    13/08 com uma sonda sobre fala real. Três defeitos daquela rodada não apareciam
    em teste nenhum, só ao LER a resposta ("tô no vermelho?" respondia "Sim" para
    quem tinha sobra). Depois de mexer no roteador de perguntas, LEIA as respostas —
    passar no corpus prova apenas que não é o texto genérico de ajuda. E note que
    `resolveLocal` usa o RELÓGIO REAL da máquina, não a data injetada nos testes:
    asserção que depende de mês/semana precisa montar as datas com `todayISO()`.
36. **`webkitSpeechRecognition` e `<a download>` NÃO funcionam dentro do APK.** O
    Android System WebView não tem a API de voz, e o WebView do Capacitor não tem
    DownloadListener — os dois falhavam em silêncio, e a exportação ainda dizia
    "Backup exportado." para um arquivo que nunca existiu. Ambos passam por plugin
    nativo (`SpeechPlugin`, `ExportPlugin`), com `src/services/speech.ts` e
    `src/services/exportFile.ts` como porta única para navegador e APK. Regra geral:
    **antes de usar API de navegador que toca hardware ou sistema de arquivos,
    confirme que ela existe no WebView** — no navegador tudo passa.

37. **O assistente aprende com o usuário, e o aprendizado é DERIVADO.**
    `src/assistant/personalModel.ts` constrói o conhecimento a partir do
    histórico que já existe em `state.transactions`; `learning.ts` decide o que
    fazer com ele. Não há campo novo, migração nem armazenamento paralelo —
    mesma decisão do journal por diferença de estado: dado derivado não
    desincroniza, backup antigo carrega sem conversão, apagar o histórico apaga
    o aprendizado junto, e o estado de um cliente não tem como influenciar o de
    outro porque não existe nada fora do estado. Três coisas são aprendidas: a
    **categoria** que ele usa para cada frase (a lista genérica sempre erra em
    nome de lugar), a **grafia** que ele já escreveu em descrição E origem
    (senão "Ze" e "Zé" viram dois lugares e o histórico se divide), e a **ordem
    de grandeza** dos valores dele. Limites que não podem ser afrouxados sem
    caso novo: categoria aprendida passa por `validateAction` como qualquer
    outra e nunca pode ser uma que o usuário não tem ou **arquivou**; e o
    aprendizado **só toca em categoria e grafia** — nunca em valor, data, tipo
    ou origem informada. Invariantes 61–67 e 70–74.
38. **Valor fora do padrão AVISA, nunca bloqueia.** Quem lança R$ 300 por dia há
    dez dias e digita R$ 3.000 quase certamente pôs um zero a mais — mas o dia
    excepcional existe, e barrá-lo seria pior que o erro. O aviso
    (`patternWarning`) aparece no card da proposta ao lado do de duplicidade, e
    a ação segue confirmável. A comparação é sempre com o MESMO tipo e a MESMA
    categoria (o padrão de combustível não diz nada sobre o de aluguel), e sem
    amostra suficiente o app CALA: sem base, alarmar é chutar.

39. **A hierarquia do aprendizado é fixa, e ele ocupa o penúltimo degrau.**
    (1) regra financeira e segurança; (2) validação determinística; (3) o que o
    usuário disse NESTA mensagem; (4) preferência confirmada por ele; (5) padrão
    histórico com evidência; (6) lista genérica do app; (7) IA remota, só para o
    que sobrou. O aprendizado é o nível 5 e **jamais** ganha de 1–3. Traduzido em
    código: `EvidenceStrength` tem quatro degraus e só `strong` preenche um campo
    VAZIO, só `overriding` contraria o palpite da lista genérica, `moderate` só
    aparece em sugestão e explicação, e `none` não é usado. Aprendizado pode
    ordenar opções, preencher categoria vazia, restaurar grafia, gerar sugestão,
    emitir aviso e formular esclarecimento. Não pode registrar, alterar valor,
    data ou tipo, criar taxa, escolher cartão, pagar fatura, desfazer, apagar,
    mexer no histórico, nem escolher entre entidades ambíguas sem perguntar.
40. **Recência tem peso, o passado tem piso.** O peso de uma ocorrência cai pela
    metade a cada 90 dias e **nunca abaixo de 15%**. Os dois lados importam:
    sem decaimento, cinco lançamentos de janeiro ganhavam de três de julho e o
    hábito que mudou nunca valia; sem piso, um padrão sazonal seria destruído
    fora da estação. A confiança é medida DUAS vezes — no histórico inteiro e na
    janela de 120 dias — e basta uma das leituras convencer, senão a mudança de
    hábito ficava eternamente em ~63%: evidência demais para ignorar e de menos
    para discordar do app. O histórico é ordenado por DATA antes de cortar:
    `mergeState` anexa backup no fim da lista, e cortar por posição lia "os mais
    recentemente digitados". Invariante 67.
41. **A frase identifica, a palavra genérica não.** As chaves de reconhecimento
    têm três níveis — texto inteiro, n-grama de 2 a 3 palavras, e palavra
    própria — e o mais específico que tiver evidência decide sozinho. Palavra de
    CLASSE (`casa`, `mercado`, `posto`, `corrida`, `gasolina`…) só conta dentro
    de uma frase: sozinha ela fazia "Conta de luz da casa" ensinar o que é
    "comida na casa da minha mãe". **Nenhuma aproximação fuzzy**: ou o texto é o
    mesmo ignorando acento e caixa, ou não é o mesmo lugar. Dois candidatos
    fortes disputando a mesma frase PERGUNTAM, com as opções carregando o lote
    pronto — nunca sorteiam nem descartam os dois.
42. **O usuário pode perguntar por quê, e pode desligar.**
    `src/assistant/explain.ts` responde local e deterministicamente: por que
    essa categoria, por que esse valor é estranho, o que você aprendeu sobre
    mim, quantas vezes eu fiz isso, qual período você usa, pare de usar meu
    histórico. Explicar é sempre `mode: 'answer'` com zero ações, nunca vai à IA
    remota (explicação inventada sobre o raciocínio do app é pior que nenhuma) e
    **não consome a proposta na tela** — `keepPending` existe porque perguntar
    não é cancelar, e a frase seguinte ainda fala do mesmo lançamento.
    `settings.adaptiveAssistant?: boolean` (ausente = LIGADO) desliga a camada
    pessoal e mais nada: parser, validação, valor, data e tipo continuam
    idênticos, e nada já gravado muda. O assistente **não mexe nessa chave
    sozinho** — ele diz onde ela fica. Invariantes 66 e 70.
43. **Sem amostra, o app CALA — e diz o que registrar.** Vale para o modelo
    pessoal e para as métricas do motorista (`driverInsights.ts`): "você faz
    R$ 0,00 por dia" com zero dias registrados é mentira com número certo. Toda
    conclusão carrega a amostra: quantos dias, qual período, e se é realizado ou
    estimado. Um dia da semana só entra no ranking se tiver se REPETIDO, e a
    comparação com "o seu normal" exige base mínima — senão vira "13% acima do
    normal" calculado sobre dois dias.
44. **O pessoal fica no aparelho.** Ao contexto remoto vai, no máximo, um
    agregado: os IDs das categorias que o usuário mais usa, e só com
    `adaptiveAssistant` ligado. **Nunca** estabelecimento, cliente, endereço,
    descrição, grafia, journal ou valor de lançamento. Todo o aprendizado —
    proposta, grafia, aviso, explicação e sugestão — funciona offline e nunca
    aciona a IA remota. Invariantes 71–73.
45. **Sugestão não é previsão, nem palpite sobre quem o usuário é.** O atalho
    personalizado vem SEM valor: com o valor histórico dentro, um toque
    distraído viraria um gasto que nunca aconteceu. Nome de meta e de lugar
    aparecem na forma NEUTRA ("Quanto falta para a meta Notebook?", "gastei em
    Água") — flexionar é inferir gênero, e o mesmo código que acerta "minha
    moto" erra em "minha notebook". Linguagem ofensiva do histórico não volta
    como botão. Máximo de um item por assunto, dois atalhos e seis no total, e
    o toque avisa se é pergunta ou registro. Invariantes 68 e 69.

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
npm run typecheck:api        # replica o que a Vercel checa (inclui api/, tests/ e scripts/)
npm test                     # corpus + goldens + metamórfico + fuzz + invariantes (offline)
npm run probe:redteam        # imprime 90 respostas em português real, para LEITURA humana
npm run rubric               # classifica cada resposta: PERIGOSA / RUIM / ACEITÁVEL / EXCELENTE
```

`npm run rubric` sai com código 1 se houver qualquer resposta PERIGOSA — essa faixa tem meta
ABSOLUTA de zero. As outras servem para comparar rodadas. Depois de mexer no roteador de
perguntas, rode a sonda e **leia as respostas**: passar no corpus só prova que não é o texto
genérico de ajuda (regra 35).

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
| `src/assistant/personalModel.ts` | CONSTRÓI o que se sabe do usuário: evidência, confiança, recência, chaves por frase (regras 37, 40, 41) |
| `src/assistant/learning.ts` | APLICA o modelo à proposta — categoria, grafia, aviso de valor (regras 38, 39) |
| `src/assistant/suggestions.ts` | Fileira de sugestões do assistente, incluindo a lista educativa por perfil (regra 45) |
| `src/assistant/explain.ts` | "Por que você fez isso?" e a explicação do controle do usuário (regra 42) |
| `src/assistant/driverInsights.ts` | Ritmo do motorista medido no histórico dele — só no perfil `driver` (regra 43) |
| `src/assistant/query/` | Query DSL: `types` (vocabulário fechado), `validate` (o `validateAction` das consultas), `period`, `engine` (executor somente leitura), `parse` (planejador composicional), `answer` (composição determinística) — regras 51 e 58 |
| `src/assistant/scenario/` | "E se?" somente leitura sobre cópia projetada do estado (regra 54) |
| `src/assistant/conversation/focus.ts` | Memória de foco e refino de plano no follow-up (regra 55) |
| `src/assistant/semantic/` | `turn` (blocos do turno), `evidence` (evidência por campo), `normalize` (typo conservador, muleta, "4k", teto de tamanho), `driverDay` (dia telegráfico) |
| `src/assistant/grounding.ts` | Barreira aritmética sobre prosa remota — leia a medição antes de confiar nela (regra 53) |
| `src/assistant/capabilities.ts` | `buildCapabilities` — mora sozinho para quebrar o ciclo `ai.ts` ↔ `orchestrator.ts` |
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

46. **Dado que chega de fora é filtrado na FRONTEIRA.** `normalizeState()` em
    `store.tsx` é o único ponto onde backup e `localStorage` viram estado — e
    ali um item que não é objeto é descartado. Não basta checar "é array":
    um `null` no meio da lista fazia o primeiro `t.type` quebrar a tela em
    branco, sem recuperação. Depois dessa fronteira o resto do código pode
    confiar no que recebe. A mesma ideia vale para o modelo pessoal, que só
    lê lançamento com data legível, valor finito e data não futura — o modelo
    inteiro é temporal, e `fromISO('lixo')` envenenava o peso com NaN até
    chegar ao usuário como "a última em Invalid Date".
47. **Nome escrito pelo usuário nunca vira instrução nem fórmula.** Categoria,
    cartão e meta são batizados por ele e viajam para dois lugares perigosos:
    o prompt de sistema (montado por LINHAS — `nomeSeguro()` colapsa quebra de
    linha e controle) e o CSV exportado (`csvCell()` em `utils/text.ts`, fonte
    única). No CSV as aspas protegem o SEPARADOR, não o conteúdo: uma descrição
    começando com `=`, `+`, `-` ou `@` executa como fórmula na planilha de quem
    receber o arquivo. Caractere invisível ou de direção (`U+202E`, `U+200B`)
    também não volta em botão de sugestão.
48. **Falha de gravação nunca é silenciosa.** `setItem` mora dentro de um
    `try` e a falha vira `storageError` no contexto do store, que a tela
    mostra numa faixa fixa até uma gravação dar certo. Sem isso, com o
    armazenamento cheio ou bloqueado, o app continuava respondendo enquanto
    NADA era salvo — o pior desfecho possível num app offline-first de
    dinheiro. Invariante 84.
49. **Perguntar não pode custar o lançamento.** A pergunta de categoria é um
    refinamento opcional: o usuário já disse que gastou. Resposta fora das
    opções propõe a versão genérica, nunca descarta. E com DOIS itens
    ambíguos o app não pergunta: uma pergunta só privilegiaria um e deixaria
    o outro em Outros sem o usuário entender por quê. Do mesmo lado: com uma
    proposta na tela, frase de contestação (`contestsProposal`) nunca vira
    registro — ou o conserto é entendido, ou o assistente pergunta o que
    mudar. Invariante 76.
50. **Número na tela nunca é NaN, ∞ ou menos zero.** `fmtBRL`/`fmtNum`
    devolvem travessão para valor não finito. Trocar por "R$ 0,00" seria pior:
    número errado com cara de certo. E toda caixa de layout tem que encolher —
    coluna `1fr` tem `min-width: auto` e leva a página inteira a rolar de lado
    num celular de 320px. Invariantes 85 e 86.

51. **Consulta financeira é uma DSL fechada, executada aqui.** Perguntar
    "quanto gastei em obra nos últimos 3 meses" não é achar um regex: é
    montar um `AssistantQueryPlan` (`src/assistant/query/`) sobre um
    vocabulário FECHADO — 10 fontes, 12 métricas, 13 agrupamentos, campos
    permitidos por fonte. `validateQueryPlan()` é o `validateAction` das
    consultas e recusa com código próprio (nome de categoria, cartão ou meta
    que o usuário não tem; fonte proibida pelo perfil; período acima de dez
    anos; chave perigosa). Não existe SQL, `eval`, nome de campo dinâmico
    nem acesso a nada fora do estado. O que substituiu isso era pior do que
    parecia: `periodFromText()` conhecia SEIS frases e caía em "últimos 7
    dias" para todo o resto, então "nos últimos 3 meses" era respondido com
    o total de uma SEMANA, apresentado como dado real.
52. **O modelo remoto PLANEJA, nunca calcula.** Ele recebe o vocabulário da
    DSL, as categorias, os nomes de cartão e de meta e a pergunta — nunca um
    lançamento. Devolve um plano, que passa por `validateQueryPlan()` com as
    capacidades REAIS deste aparelho e é executado localmente. Os números
    nascem aqui e nunca saem. `engine: 'hybrid'` é o rótulo honesto disso.
53. **A barreira de grounding só protege com lista CURTA, e isso foi
    medido.** Com 1 fato, 0,6% dos valores inventados passariam; com 6,
    16%; com o contexto agregado inteiro (38 números), **89,3%**. O termo
    que domina é a soma e a diferença entre pares — com números demais,
    quase todo valor é a combinação de dois outros. Daí `MAX_COMPOSE_FACTS`
    e daí ele falhar FECHADO. Consequência que é uma decisão de NÃO fazer:
    a barreira **não** foi ligada à resposta livre da IA remota, onde ela
    teria ~11% de eficácia — alegar proteção que não existe é pior que não
    ter. Fica como limitação conhecida, com o número. Invariante 106.
54. **Cenário é somente leitura, e diz que é.** `runScenario()`
    (`src/assistant/scenario/`) trabalha sobre uma CÓPIA projetada do estado
    e reaproveita `splitInstallmentAmounts`, `nextInvoiceDueDate` e
    `monthlyProjections` — simulação e realidade não podem divergir porque
    são o mesmo código. Todo fato de cenário nasce `estimated: true` e toda
    resposta termina em "Simulação — nada foi registrado". Invariantes 87–89,
    e o teste acusa em três lugares se o motor escrever uma linha no estado.
55. **Follow-up REFINA o plano anterior; não recomeça.** O foco
    (`src/assistant/conversation/focus.ts`) é de memória, com o mesmo TTL dos
    rascunhos, e guarda o último plano de consulta, o de cenário e as
    entidades. "E mês passado?" troca o período e MANTÉM o filtro; "e o
    Inter?" troca o cartão; "e em 12x?" troca a parcela. A guarda que não
    pode cair: **mensagem com fato a registrar não fala pela camada de
    conversa** — "recebi 1800 da Casa 1, MAIS 1750 da Casa 2" e "meu salário
    CAIU hoje 3200" viram consulta por acidente de vocabulário, e o
    lançamento desaparecia. A ÚNICA exceção é o cenário, porque
    `looksLikeScenario` exige marcador explícito de hipótese: registrar e
    simular na mesma frase responde às duas metades (regra 27).
56. **Empate é dito, não desempatado.** "Qual dia da semana eu faturo mais?"
    respondia "Sábado, com R$ 2.945,00" — e a sexta tinha R$ 2.935,00, com as
    mesmas 12 ocorrências. Coroar um dos dois é apresentar cara-ou-coroa como
    conclusão, e um motorista pode reorganizar a semana por causa disso.
    Diferença abaixo de 2% (RELATIVO: dez reais entre dois mil é empate, dez
    entre trinta não é) sai escrita, com a distância em reais. Mesma família
    da regra 43: separação sem significado nunca vira achado.
57. **Pergunta de sim ou não começa por sim ou não.** "Meu salário cobre
    minhas contas?" devolvia a lista de contas a vencer, e o usuário é que
    somava de cabeça. `balanceOutlook()` já sabia a resposta. Vale para a
    classe: quando a pergunta tem forma de sim/não, a primeira palavra é a
    resposta e o detalhe vem depois. `scripts/rubric-assistant.mts` mede isso
    em todo o corpus adversarial, e PERIGOSA tem meta ABSOLUTA de zero.
58. **Toda leitura de dinheiro tem que bater com `calc.ts`.** Existem dois
    caminhos que somam o mesmo dinheiro — `periodStats()`, que alimenta a
    Home, e `runQuery()`, que responde o assistente. Cada um está certo
    sozinho, e nenhum teste de caso pegaria a divergência: o usuário é que
    veria dois números diferentes para a mesma pergunta, os dois apresentados
    como fato. Invariante 105 compara três estados × quatro janelas × entrada,
    saída e líquido, sem tolerância de centavo.
59. **Nenhum caractere de controle no código-fonte versionado.** Este projeto
    já perdeu tempo DUAS vezes com um backspace (0x08) entrando no lugar de um
    `\b` de regex numa edição por script: o caractere é invisível no editor,
    quebra a regex em silêncio e só aparece quando um teste falha por um
    motivo que não faz sentido. Onde um caractere de controle é dado de teste,
    ele é MONTADO (`String.fromCharCode`). Invariante 104.
