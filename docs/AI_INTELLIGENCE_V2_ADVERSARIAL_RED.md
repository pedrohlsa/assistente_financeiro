# Intelligence V2 — checkpoint adversarial antes das correções

Branch: `feat/assistant-intelligence-v2`; HEAD inicial: `36d0135`.
Estado inicial: somente `.claude/launch.json` modificado, preservado fora dos commits.
Fonte: auditoria adversarial fornecida pelo usuário. As saídas abaixo são as
**observadas na auditoria**, não ainda reproduções locais desta rodada.
Cada caso deverá ganhar RED pelo orquestrador real, salvo os cálculos de base
que também exigem conferência direta de `monthlyProjections`.

| ID | Reprodução/saída observada no HEAD auditado | Saída esperada |
|---|---|---|
| C1 | Renda R$ 1.000, histórico de obra R$ 300 sem obra futura; cortar obra + guardar metade inventa sobra R$ 1.300, depósito R$ 650/mês, R$ 2.600 em quatro meses. | Corte/redução só libera despesa representada: sobra R$ 1.000, depósito R$ 500/mês, R$ 2.000 em quatro meses. |
| C2 | Salário R$ 1.000 já recebido soma de novo ao saldo R$ 800; parcela R$ 200 já paga desconta de novo; bimestral entra quatro vezes em vez de duas; conta vencendo dia 28 aparece após fim em 01/10. | Eventos já resolvidos não entram na previsão; frequência real respeitada; fim anterior ao dia de vencimento exclui ocorrência. |
| C3 | `cem → mil` altera gasto de R$ 100 para R$ 1.000; `sexta → segunda` altera data. | Recusar alias financeiro/temporal e preservar tokens protegidos antes/depois de qualquer alias. |
| H1 | `guardar 30% da sobra` passa pelo reparo e vira `guardar R$ 30`, resposta R$ 360 em um ano. | `save-share` 30%; com R$ 1.000 por quatro meses, R$ 300/mês e R$ 1.200 acumulados. |
| H2 | `R$ 1.234,56 em 10x` vira R$ 1.234 à vista; `100,50` vira R$ 100. | Preservar centavos, parcelamento e vírgula decimal pt-BR. |
| H3 | Casa 1=100, Casa 2=200, Casa 3=9.000; consulta das duas retorna R$ 9.800 ou escolhe Casa 3. | Restringir explicitamente a Casa 1 e Casa 2: R$ 300; maior é Casa 2. |
| H4 | `só a partir de novembro` começa em setembro; `dezembro de 2027` vira 2026; `investir 200` some. | Respeitar início/ano ou declarar limite; nenhum fragmento material silenciosamente descartado. |
| H5 | `por que gastei mais em alimentação desde junho?` responde mês atual versus anterior, com todas as categorias/receitas. | Preservar categoria e período; se a comparação não estiver definida, uma clarificação objetiva. |
| H6 | Consulta obra → cenário guardar até dezembro → `E tirando alimentação?` ressuscita consulta histórica de obra. | Manter cenário ativo ou esclarecer; nunca cruzar modalidade pelo fallback. |
| H7 | Gasto futuro, Pix pedido, corrida apenas tocada e corrida ainda não paga viram lançamentos realizados. | Modalidade por cláusula; só propor fatos consumados, perguntar quando pagamento/transferência não foi confirmado. |
| H8 | `Mandei 15 de pix para minha filha comprar sorvete` é reparado para `andei`, propõe 15 km. | Dinheiro/transferência ou clarificação; nunca quilometragem sem evidência. |
| H9 | `Gastei 40 no combustível, quer dizer 45, e 30 no pneu` vira abastecimento de R$ 30; `recebi 70, mas devolvi 20` perde R$ 20. | Combustível R$ 45 e pneu R$ 30; devolução representada ou esclarecida; cada magnitude com destino explícito. |

## RED local no HEAD `36d0135`

`tests/assistant/adversarial-real.ts --probe` atravessou `orchestrate` com
`remoteEnabled: false` e data injetada `2026-09-15`. As saídas principais
foram lidas antes de qualquer mudança em `src/**`:

- C1: `parar obra` + 50% mostrou sobra R$ 1.300 e R$ 650/mês; redução de
  alimentação em R$ 1.300 mostrou R$ 2.300/mês sem alimentação futura.
- C2: salário confirmado levou saldo R$ 800 a R$ 1.800; parcela paga levou
  R$ 800 a R$ 600; bimestral gerou `[1000,1000,1000,1000]`; conta até 01/10
  gerou `[200,200,0,0]` embora vença dia 28.
- C3: ensino `cem → mil` gerou proposta e gasto posterior de R$ 1.000;
  `sexta → segunda` também foi aceito.
- H1: 30% e 50% viraram valores fixos R$ 30/R$ 50; “metade da sobra” foi
  recusada; somente “tudo que sobrar” preservou `save-share`.
- H2: R$ 1.234,56 em 10x virou gasto hipotético à vista de R$ 1.234;
  R$ 100,50 virou R$ 100. `2,5k em 10x` permaneceu correto.
- H3: duas casas deram R$ 9.800 e comparação escolheu Casa 3.
- H4: início em novembro foi recusado sem explicar a janela; ano 2027 virou
  valor fixo R$ 2.027; `investir 200` foi usado como “guardar 200”, sem dizer
  que o investimento não entrou.
- H5: pergunta “alimentação desde junho” respondeu setembro versus agosto,
  incluindo obra, lazer e receitas.
- H6: terceiro turno `E tirando alimentação?` voltou à consulta real de obra.
- H7: o lote `paguei 30 ... vou gastar 40` propôs e, ao aplicar em memória,
  gravou ambos; `tocou corrida 70` e `corrida ainda não paga` propuseram
  R$ 70 recebidos. Pix pedido não gerou pergunta objetiva na fixture local.
- H8: o reparo `Mandei → andei` propôs e, ao aplicar em memória, criou
  sessão de trabalho de 15 km por um Pix.
- H9: correção combustível 40→45 + pneu 30 resultou em um único
  abastecimento de R$ 30; devolução de R$ 20 sumiu; a frase longa omitiu
  o pneu/Pix e propôs R$ 70 como receita.

O teste contém oráculos literais independentes. Não será integrado ao gate
verde até que cada caso deixe de ser RED; as saídas completas podem ser
reproduzidas localmente pelo script.

Status deste checkpoint: evidência externa e REDs locais preservados; correções pendentes.
Não fazer DeepSeek, push, merge, deploy ou APK.
