# AssistFin — Handoff para o Claude

20/11/2026. O usuário pediu para continuar a revisão e os testes até restarem
5% da janela de cinco horas. O Codex registrou 95% usados ao abrir esta passagem.

## Retomada

- Repositório Linux em `/home/stuart/work/assistfin`. Branch
  `feat/assistant-intelligence-v2` no commit
  `6129f5a4662b03c2db27b4b01c8295a0469501de`.
- Desde o handoff anterior (`d9860dd`) há 58 novos commits locais. Os
  últimos 23 vão de `21cdb31` até o HEAD acima. A `main` local está
  em `e6f6229`. São 232 commits à frente dela, sem divergência do lado
  da `main`. O remoto privado conhecido é `pedrohlsa/assistente_financeiro`.
- A branch segue local. A outra cópia conhecida, em
  `D:\Claude\AssistFin`, estava em `9bc0457` segundo o handoff anterior.
  O trabalho desta rodada ocorreu no Linux.
- O estado rastreado está limpo. Os dois handoffs Markdown ficam
  fora dos commits. Preserve `docs/HANDOFF_GPT_2026-11-12.md`.
- Leia `CLAUDE.md` antes de mexer no código. `CONTEXTO.md` e
  `docs/CODEX_RESUME.md` são checkpoints anteriores. Use o final de
  `PROGRESS.md` e o log Git para o estado desta rodada.

**NOT READY para merge ou deploy.** Precisa de auditoria independente.
Push, merge, reset, force push e deploy exigem autorização do usuário. O
escopo desta revisão foi local, com dados fictícios, sem APK nem chamada
paga à DeepSeek. Confirmação precisa acontecer antes de gravar no caixa.

## O que o usuário quer

O AssistFin precisa entender a fala informal em pt-BR com a menor fricção
possível. Teste erros de digitação, transcrição fragmentada, negação, correção
em outro turno, lista sem repetição de verbo, centavos, origem, data e hora.
Valide a ação proposta e a transação depois de confirmar. Em caso de dúvida
que altere valor, data, origem ou saldo, conserve o que já está claro e peça
só o dado faltante. Uma frase citada, orçamento ou Pix que ainda vai cair
fica fora do caixa.

## O que mudou

| Commits | Comportamento |
| --- | --- |
| `11566ba..21cdb31` | Confirmações e projeções, faturas e parcelas, contas fixas e conciliação, datas importadas, backup, desfazer, arquivamento de cartões e correções faladas. A lista completa está em `git log d9860dd..21cdb31`. |
| `93e86d6`, `a5f4ae9`, `9df0eb1` | Corrige valor, data, descrição e origem na proposta certa. Pergunta diante de alternativas. Reconhece erros em “recebi” e a negativa curta “ñ”. |
| `f06e19b`, `7929b63` | “Dia 10 e 15” busca os dois dias. Intervalos e dias da semana conservam filtro, limites e contagem. |
| `3b807a5`, `a83a373` | Um cartão confirmável, confirmação parcial, proteção contra resultado assíncrono obsoleto e retomada ao navegar. Recarregar a página descarta propostas pendentes. |
| `becd29d`, `255708d`, `88c7ba3` | Respostas sobre Pix, corrida e devolução, listas com verbo omitido, valor da corrida separado de distância e duração. |
| `d80a6b5`, `0cac520`, `4550943`, `8befb86` | Estorno no cartão e pagamento em dinheiro são distintos. Usa o Pix enviado de fato. Pix recebido entra, contas próprias preservam o total e pagamento pendente aguarda. Retira orçamento da proposta e confere o alvo de uma negativa. |
| `07e0fed`, `0f28180`, `c4ee083` | Exemplos e citações ficam fora de ações e controles de proposta. Ditado Web une todos os resultados finais em pt-BR. Cancelamento, navegação ou resultado tardio não enviam texto. |
| `05f1251`, `bff5497`, `ba1fde0` | Despesas e entradas avulsas guardam hora. Negar despesa de outro lugar conserva a proposta. “R$ 120 da Casa 2 e R$ 80 do Uber” mantém as origens e conta só uma corrida. |
| `d3046a5`, `d6d042b`, `6129f5a` | A correção de horário pede o alvo quando há dois itens. Intervalos, horários aproximados e alternativas pedem hora exata. Reconhece “às nove horas e vinte minutos”. |

Horário exato é `HH:MM` e é interpretado localmente em `income` e
`expense`. O contrato rejeita esse campo vindo do remoto. A execução
rejeita hora futura no próprio dia e grava o horário indicado inclusive
em dia anterior. O cálculo do caixa usa o horário em relação a
`settings.balanceAsOf`. Nos testes, gasto prévio ao saldo de R$ 1.000
ficou embutido e somente a despesa posterior de R$ 35 reduziu o saldo
para R$ 965. Conta fixa com hora explícita encaminha para Planejamento.
Ordem dentro do mesmo minuto ainda usa a convenção do carimbo do app.

## Verificação local

```bash
cd /home/stuart/work/assistfin
source /home/stuart/.nvm/nvm.sh
nvm use 22
git status --short --branch
git log --oneline d9860dd..HEAD
npm test
npm run test:calendario
npm run typecheck
npm run typecheck:api
npm run test:money
npm run build
npm run rubric
```

- Suíte padrão final com 820/820 regressões reais, 151/151 invariantes,
  5/5 verificações de ditado e 468 verificações do remoto simulado.
  Núcleo e nove verificações de navegação passaram. A suíte exercitou
  1.416 mensagens de fuzz e 4.088 + 3.800 mutações metamórficas.
- Calendário com oito datas. Conforme o cenário, são 817 ou 820 regressões
  ativas por data. Passaram também São Paulo em 20/11 (820/820) e Lisboa
  em 31/12 (817/817). Os logs do último checkpoint têm prefixo
  `assistfin-checkpoint-`. O relógio padrão da suíte é 15/09/2026.
- As duas verificações de tipos, `test:money` e o build passaram. O Vite
  informa bundle principal maior que 500 kB. Rubrica com 85 excelentes,
  cinco aceitáveis, zero ruins e zero perigosas.
- Duas matrizes extras com fixtures, sem chamadas ao transporte remoto
  simulado. Foram 640/640 casos de fala irregular e 384/384 de horário,
  em oito datas e quatro perfis. Scripts
  `assistfin-fala-irregular-matriz.mts` e `assistfin-horarios-matriz.mts`
  no diretório de evidências abaixo. Rode com `./node_modules/.bin/tsx`.
- Chrome headless com preview local em `http://127.0.0.1:5188`, perfis
  descartáveis, `remoteAi:false` e HTTPS bloqueado pelo CDP. Confirmados
  valor/data/hora, correção com escolha de alvo, duas receitas com uma
  corrida, negativa sobre outro lugar, Pix, citações e navegação.
  O reconhecedor Web foi simulado, inclusive resultados em duas partes.
- Voz real do usuário, microfone físico, reconhecimento nativo Android,
  APK e DeepSeek real seguem pendentes.

Evidências e scripts em
`/home/stuart/Documents/Codex/2026-11-18/ass/work`. O log
`assistfin-final-fala-suite.log` registra a suíte do checkpoint. Scripts
de Chrome terminam em `-browser.mjs` e esperam preview nessa porta.

## Primeiro defeito para a próxima rodada

No perfil motorista, com estado fictício vazio, envie
“recebi 120 da Casa 2 e 120 do Uber”. O HEAD propõe só uma receita de
R$ 120 na categoria Corridas, origem Casa 2, uma viagem, e pede o segundo
valor. Inverter as duas origens também combina origens incorretamente.
Repetir o verbo (“recebi 120 da Casa 2 e recebi 120 do Uber”) já funciona.
“Recebi 120 da Casa 2 e 120 da Casa 1” também perde uma receita.

```bash
cd /home/stuart/work/assistfin
source /home/stuart/.nvm/nvm.sh
nvm use 22
./node_modules/.bin/tsx /home/stuart/Documents/Codex/2026-11-18/ass/work/assistfin-origem-mesmo-valor-probe.mts
```

O resultado esperado são duas entradas de R$ 120, Casa 2 em Outros e
Uber em Corridas, total de R$ 240 e uma viagem no perfil motorista.
Com duas casas, são duas entradas e zero viagens. O probe mostra que
o segmentador conserva a frase sem segundo verbo em uma única cláusula.
Examine `segment`, `cashPair`, pareamento por posição e a leitura de
receitas repetidas em `src/services/nlp.ts`. Preserve a distinção entre
dois fatos de mesmo valor e repetição de ênfase ou correção.

Outros casos reproduzidos no script `assistfin-fala-proxima-auditoria.mts`:

- “Ontem paguei 50 na farmácia às 9 e 30 na padaria” combina os locais
  e confirma só R$ 50 às 09:30. A frase permite ler 30 como minutos ou
  como outro gasto. Peça esclarecimento antes de confirmar.
- “Trabalhei ontem das 9h às 13h” fica sem proposta no perfil motorista.
  Turno com início e fim ainda não vira duração. Confirme o dia se
  a faixa atravessar a meia-noite.
- “Faz meia hora” e “ao meio-dia” ainda não viram hora. O meio-dia pode
  aparecer como “Padaria ao maio” na descrição. Use relógio injetável
  para expressões relativas, inclusive na virada do dia.
- “Recebi 110 do joão ontem às 8h” ainda perde a origem em minúsculo e
  infere uma viagem no perfil motorista. O ditado real pode omitir
  capitalização e pontuação. Colete exemplos reais quando houver acesso
  autorizado ao dispositivo.

Pontos de entrada para manutenção: `src/assistant/clauses.ts` segmenta e
extrai os fatos, `orchestrator.ts` aplica o contexto do turno,
`corrections.ts` corrige propostas, `semantic/clock.ts` lê horas,
`contracts.ts` valida e `execute.ts` grava. `src/services/calc.ts`
calcula o caixa. Os oráculos principais estão em
`tests/assistant/adversarial-real.ts`. O ditado Web tem regressões em
`tests/assistant/properties-speech.ts`.
