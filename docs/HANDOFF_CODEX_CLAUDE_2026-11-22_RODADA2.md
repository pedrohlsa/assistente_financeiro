# AssistFin — continuação da revisão em 22/11/2026

- Repositório `/home/stuart/work/assistfin`, branch `feat/assistant-intelligence-v2`. A rodada começou em `d442f3b`, depois de `docs/HANDOFF_2026-11-22.md`.
- HEAD de código `99585a0`. São 18 commits de código e testes desde `d442f3b`, além do registro em `PROGRESS.md`.
- **NOT READY**. O usuário autorizou publicar esta branch e os handoffs no GitHub privado para continuar a revisão no GPT Web. Merge, deploy, APK e DeepSeek real exigem autorização separada. A cópia do Copiloto em `/home/stuart/work/assistfin-driver-copilot` está fora desta revisão.
- Este é o ponto de entrada para continuar a revisão. Os outros handoffs documentam etapas anteriores. Os caminhos absolutos e logs em `/tmp` referem-se à máquina onde os testes foram executados. Em outro ambiente, use o clone de `pedrohlsa/assistente_financeiro` na branch `feat/assistant-intelligence-v2` e os comandos abaixo.

## Verificações e correções

- A matriz das oito datas passou em `d442f3b`, incluindo a alteração do GNV. Log em `/tmp/assistfin-22-gnv-baseline.log`. Os totais adversariais por data foram 1.532, 1.529, 1.532, 1.527, 1.529, 1.529, 1.532 e 1.532.
- `fb5d097` mantém a proposta disponível após uma consulta factual. “Quanto gastei hoje?” usa o estado confirmado e avisa se a proposta mudaria o resultado. O aviso não se repete em uma consulta com período ou filtro que exclua a proposta. A consulta não grava nem reapresenta a ação.
- `3ca98d0` responde “o que gastei hoje?” e “quanto foi o último gasto?” com os movimentos e o dia do chat. Restrições como “acima de R$ 500 desde abril” continuam no caminho que trata o filtro.
- `6c4816e` responde “quanto gastaria se eu confirmar?” e “quanto gastei hoje contando esse também?” com uma simulação que usa uma cópia descartável do estado. A proposta segue aguardando confirmação.
- `00f70fb` compara somente os aplicativos citados e respeita o período da pergunta. O chat e o executor de consultas recusam indicadores por plataforma quando a base de horas, quilômetros ou viagens só existe por dia.
- `9af6447` mantém a lista, o último movimento e o par de apps ao responder “e ontem?”. A lista usa os dois extremos de “de ontem até hoje”.
- `e0d7765` preserva dia e horário ao escolher gás de cozinha ou GNV. Os outros lançamentos da mensagem continuam na proposta. Gás sem tipo ou dia definido aguarda esclarecimento.
- `8b06294` identifica imóveis pelo nome completo, como Kitnet do Fundo. Ao citar vários imóveis, a simulação pede que o usuário escolha um e preserva o prazo.
- `87bfbaf` lê intervalos explícitos de vacância, incluindo virada de ano. Usa vencimentos cadastrados, inclusive no último dia, e pede correção quando a data não existe ou conflita com a duração.
- `8c2be5c` distingue o dinheiro disponível após resgate do saldo já em conta. Pede a premissa ausente e usa a resposta apenas na simulação do pagamento.
- `6bea217` preserva centavos, litros, quilometragem decimal e duração no resumo telegráfico da jornada. A pergunta “quanto sobra” com valores informados faz a conta sem criar registro. Resumos com datas conflitantes ou valores sem rótulo pedem esclarecimento.
- `19bd14d` mantém comparações de ofertas em modo de análise, lê “18 km só de ida” e recalcula uma oferta quando chegam o tempo total ou um novo valor. R$ 30 em 16 km, com combustível a R$ 0,50/km e 25 min totais, resultam em R$ 22 estimados e R$ 52,80/h.
- `d154c5b` concilia relatos como “a 99 me pagou 400 com taxa de 20, caíram 380”. Registra somente o líquido depois da confirmação. Se os valores conflitam, o valor esclarecido conserva a plataforma e o dia, com a taxa já retida.
- `51a14a8` cruza as receitas de corrida e os custos de rodagem com os dias em que houve horas ou km registrados. A pergunta genérica de despesa por km mantém o recorte de todas as despesas. “Últimos dois dias comparado com os dois dias anteriores” usa janelas adjacentes.
- `1c33d0c` calcula ritmo típico com receitas de corrida e despesas de rodagem. Mostra a amostra de cada medida. Os fixtures adaptativos usam o mesmo dia injetado no chat.
- `10bffb1` responde “qual a diferença entre Uber e 99?” em reais, com os apps citados e o período correto. Perguntas “pagou mais/menos?” começam com sim ou não quando há dados dos dois lados.
- `e3b509e` trata “430 na Uber e 399 na 99 somando 829” como duas receitas com subtotal de conferência. Os R$ 163 de gasolina e a jornada continuam separados.
- `09780e8` esclarece o que efetivamente entrou no relato “420 bruto e 310 líquido”. Quilometragem e horas explícitas continuam na proposta durante a pergunta. A receita esclarecida conserva o dia e o app.
- `99585a0` cobre também “a 99 me pagou 400 e tirou 20 de taxa”, “a Uber recebeu 430 e me passou 380 depois de descontar 50” e “vale a pena a de 30 por 8 km ou a de 80 por 25 km?”. O primeiro pede o valor recebido, o segundo propõe somente R$ 380 e o último compara as ofertas.
- Chrome isolado passou com os dois valores anteriores, R$ 20 confirmado e R$ 70 simulado, além de correção para R$ 45, confirmação e busca posterior de R$ 150 de GNV no perfil autônomo. Script em `/home/stuart/Documents/Codex/2026-11-18/ass/work/assistfin-22-pendencia-gnv-browser.mjs`.
- A mesma validação no Chrome passou para a escolha de GNV de ontem com horário explícito e consulta do último gasto de ontem. Sondas independentes deram 4.680/4.680 em três fusos no checkpoint `9af6447`.

## Validação final

- `npm test` em `99585a0` passou com 736/736 no corpus, 1.555/1.555 regressões reais, 151/151 invariantes e 468 verificações da avaliação remota simulada. Log `/tmp/assistfin-22-r2-last-suite.log`.
- `test:calendario` passou nas oito datas em `99585a0`. Os totais adversariais na ordem da matriz foram 1.555, 1.552, 1.555, 1.550, 1.552, 1.552, 1.555 e 1.555. Todas as datas passaram com 151 invariantes. Log `/tmp/assistfin-22-r2-final-head-matrix.log`.
- Typechecks da interface e da API, conversão monetária, build e `git diff --check` passaram. A rubrica teve 85 excelentes, 5 aceitáveis, 0 ruins e 0 perigosas. O build mantém o aviso de tamanho do bundle e a busca por `sk-` em `dist/` voltou vazia.
- 4.680/4.680 verificações independentes anteriores passaram novamente em São Paulo, Los Angeles e Kiritimati. A nova sonda do motorista passou 504/504 nesses três fusos. Foram verificados diálogo, centavos, datas, execução pura e isolamento dos indicadores. Logs `/tmp/assistfin-22-r2-final-independent.log` e `/tmp/assistfin-22-r2-driver-independent.log`.
- Chrome isolado passou no fluxo do motorista em viewport padrão e móvel. O reconhecimento simulado em pt-BR entregou 430,50 de Uber, 399,25 de 99, 163,90 de combustível com 24,5 L, 161,8 km, 8h30 e 12 viagens. A tela aguardou confirmação, salvou quatro itens e calculou ganho por hora sem o aluguel inserido como controle. Também passaram cancelamento do ditado, permissão negada, troca de tela durante o ditado, estorno e compra manual datada.

## Próximos alvos

- A pedido do usuário, a continuação deve priorizar o perfil motorista. Não há horas, km ou viagens por plataforma. Dividir o ganho de um app pelas medidas de todos continua proibido. O histórico ainda pode ter receitas que chegam em dia diferente do trabalho. O indicador usa os dias com as duas bases cadastradas.
- “Fechei 8 horas no volante, com 320 de corrida e 90 de combustível” ainda propõe só o combustível e pede contexto para os R$ 320. “Deu 800 de corridas e 150 de gasolina, mas 300 ainda não caiu” pede esclarecimento para as receitas. Testar esses dois relatos em `/tmp/assistfin-22-driver-remaining.mts`. Em resumo telegráfico, `8h30` funciona; `8:30` sem unidade fica ambíguo entre horário e duração.
- Fora do foco atual, “mostra as despesas com alimentação de ontem” pode listar outros gastos e “qual foi o último gasto no mercado?” pode devolver a soma. Sonda em `/tmp/assistfin-22-query-list.mts`.
- Voz real, Android, APK e DeepSeek real continuam sem validação. Agrupamento remoto `monthday` depende de redeploy autorizado.

## Como reproduzir

```bash
cd /home/stuart/work/assistfin
git status --short
git log --oneline d442f3b..HEAD
npm test
npm run test:calendario
npm run typecheck && npm run typecheck:api
npm run test:money && npm run rubric && npm run build
```

- Execute `test:calendario` sem editar `src/` e `tests/` durante a execução. Para continuar em paralelo, faça um snapshot com `git archive HEAD`, vincule `node_modules` e rode no snapshot.
- Sondas extras vivem em `/home/stuart/Documents/Codex/2026-11-18/ass/work`. O fluxo `assistfin-22-driver-browser-flow.mjs` usa a prévia local `127.0.0.1:5198` e aceita `--mobile`. `assistfin-22-driver-independent.mts` roda com o `tsx` do projeto. As execuções usaram dados fictícios.
