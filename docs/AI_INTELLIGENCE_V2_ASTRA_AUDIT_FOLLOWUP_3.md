# Intelligence v2 — resposta à terceira auditoria adversarial

Base: `feat/assistant-intelligence-v2` em `ff6a6a3`. O parecer independente
recebido apontou A1–A5, B1 e C1–C2. Este lote é uma correção local, **não uma
aprovação de merge/deploy**.

## Corrigido e coberto por regressões

- A1/A2: comparação com dois meses conserva o tipo de movimentação, origem e
  demais filtros da consulta anterior; só muda a categoria quando o usuário a
  especifica. “Em geral”/“de tudo” removem a categoria sem virarem filtro de
  texto. Há casos de receita Casa 1 e de todas as categorias.
- B1: cinco variantes de corrida não paga deixam de propor receita, inclusive
  “não recebi nada”, “não caiu nada” e “nunca me pagaram”.
- C1/C2: lançamentos financeiros e âncora usam milissegundos; ações de um
  mesmo lote ganham ordem explícita dentro desse instante. A interface continua
  exibindo horário legível. O teste cobre saldo antes/depois de um gasto no
  mesmo lote.
- A3: pagamentos de fatura novos guardam exatamente os IDs de parcelas
  quitadas. Um pagamento parcial anterior, que não quitou nenhuma parcela, não
  bloqueia desfazer um pagamento direto posterior. O toast explica quando o
  desfazer é bloqueado. Para pagamentos legados sem IDs, há apenas um fallback
  conservador por data, pois a vinculação exata é desconhecida.
- A5: parcela legada marcada `paid` com `paidAmount` menor que o valor pode ser
  completada sem apagar o pagamento anterior, desde que não esteja vinculada
  à quitação da fatura. A interface identifica o parcial e oferece “Completar”.
- Remover uma fatura nova pelo reducer reabre as parcelas que ela quitou e
  preserva o pagamento direto parcial anterior. Remover fatura legada sem IDs
  é recusado para não deixar dívida e caixa divergentes. Ainda não existe um
  fluxo de remoção/reconciliação de fatura na interface.
- A4: quando os pagamentos registrados já superam o total da fatura, o
  assistente recusa acrescentar outro pagamento. Isso impede ampliar o erro,
  **mas não resolve o saldo pré-existente**.

## Verificação local

`npm test`: 660/660 corpus, 99/99 consulta/cenário/continuidade, 50/50
semânticos, 128/128 adversariais, 4.088 + 3.800 metamórficos, 1.416 fuzz,
151/151 invariantes, 468 verificações remotas offline. `typecheck`,
`typecheck:api`, `test:money`, `build`, rubrica local e `git diff --check`
passaram. Rubrica: 0 perigosa, 0 ruim, 7 aceitáveis, 83 excelentes. O build
mantém o aviso de chunk acima de 500 kB.

## Bloqueios e limites

- **NOT READY:** o caso A4 contém um histórico legado sem proveniência no qual
  o saldo já é calculado como R$ 600, embora uma interpretação possível dos
  desembolsos reais seja R$ 800. Não há informação suficiente para distinguir
  pagamento direto de pagamento representado na fatura. Recusar um novo
  pagamento evita piora, não corrige a resposta de saldo. É necessária
  reconciliação explícita com o usuário, sem inferir a origem do pagamento.
- Backups antigos com horários só em minutos continuam sem ordenação segura
  dentro daquele minuto; a precisão nova vale para eventos novos.
- A remoção segura de fatura pelo reducer não é um fluxo disponível ao usuário
  na interface. Backups sem `settledInstallmentIds` exigem reconciliação.
- Sem validação independente deste novo lote, persistência real, navegador ou
  serviço remoto. Não fazer push, merge, deploy ou APK a partir destes gates.
