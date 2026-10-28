# Retomada autônoma — AssistFin

Atualizado em 28/10/2026. Este arquivo orienta a tarefa recorrente deste chat.

## Autorização e limites

- Projeto: `D:\Claude\AssistFin`, branch `feat/assistant-intelligence-v2`.
- O usuário autorizou procurar defeitos, reproduzir com dados sintéticos,
  corrigir, testar, documentar e fazer commits locais enquanto dorme.
- Consultar o uso no começo e entre lotes curtos. Ao restarem 10% ou menos na
  janela de cinco horas, salvar e parar para preservar pelo menos 5%.
  A porcentagem é compartilhada com outros chats: não há garantia de reserva
  exata se houver consumo simultâneo. O limite semanal pode ser utilizado.
- Não comprar créditos, usar créditos de reset ou fazer chamadas pagas.
- Não fazer push, merge, deploy ou APK. Preservar `.claude/launch.json`.
- A automação existente é `retomar-testes-do-assistfin`, neste mesmo chat,
  ativa a partir de 28/10/2026 às 09:09:50 de São Paulo, a cada cinco horas.
  Não criar outra. Depende do computador e do aplicativo disponíveis.
- Não repetir gates sem motivo nem inventar trabalho para gastar uso.

## Checkpoint confirmado

HEAD antes da rodada atual: `27d40cc`, após `c72a069`. Confira Git antes de
continuar; o código e os commits mais novos prevalecem sobre este registro.
Leia CLAUDE.md, checkpoint do CONTEXTO.md e fim do PROGRESS.md.

Baseline no commit `27d40cc`: 666 corpus, 99 consulta/cenário, 50 semânticos,
576 adversariais, 4088 + 3800 metamórficos, 1416 fuzz, 151 invariantes,
468 avaliações offline; typechecks, dinheiro, build e rubrica verdes.
Produção antiga em `e6f6229`; a V2 continua NOT READY para merge/deploy e
precisa de auditoria independente. O smoke de persistência cobriu somente
manutenção, confirmação, recarga, desfazer e nova recarga com dados fictícios.

## Reproduções da rodada atual

As reproduções abaixo foram incorporadas aos testes adversariais, sem remoto:

1. Receita recorrente 650 e recebida 9000: depois de perguntar quanto vou
   receber mês que vem, "e quanto recebi esse mês?" mantém a previsão de 650.
   "E a previsão deste mês?" também herda a janela realizada indevidamente.
2. Saldo 1000 e fatura pendente 1200: "e se a Casa 1 não pagar?" afirma que
   sobra 1000 e que as contas fecham. O cenário só desconta contas fixas.
3. Depois desse cenário, "e se eu gastar 100 hoje?" pede esclarecimento
   em vez de executar a nova hipótese completa.
4. Depois de depósitos em metas no mês (sem histórico), "e no total?" não
   recupera o saldo total das metas; "e até agora?" cai na ajuda.

As quatro causas foram corrigidas em `cd5aaef`: 590/590 adversariais,
demais gates preservados, incluindo build e rubrica. A média histórica e o
saldo do cenário de entrada ausente também excluem transações futuras.

## Próxima busca

- A rodada posterior alinhou `balanceOutlook` (Home/resumos/avisos) com os
  compromissos do chat: 596/596 adversariais. Inclui fatura, exclui quitada,
  admite incerteza de contas vencidas e bloqueia cobertura com legado ambíguo.
- Depois, `currentBalance` central passou a ignorar datas futuras em receitas,
  despesas e pagamentos (fatura e direto/parcial de parcela). Cenários e
  projeção mensal recebem a data de referência. 603/603 adversariais.
- O lote seguinte recusa datas futuras, vazias e inválidas para registrar
  pagamento de fatura e quitação direta/parcial. A tela explica o erro;
  pagamento de hoje para vencimento futuro continua válido. 607/607 testes
  adversariais, suíte completa, typechecks e build verdes. Backups antigos
  já gravados não são reescritos; verificar separadamente essas inconsistências.
- Reproduzir "antecipei a fatura do Nubank" e "devo muito?"; o chat não
  possui ação para antecipação por mês. Não inventar execução nem capacidade.
- Testar novos contrastes de continuidade e datas, sem repetir os exemplos
  anteriores como substituto de busca independente.
- Restrições de produto e demais pendências estão no fim do PROGRESS.md.
  Atualizar este arquivo e os checkpoints a cada lote concluído.
