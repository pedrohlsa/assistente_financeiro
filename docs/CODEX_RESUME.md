# Retomada autônoma — AssistFin

Checkpoint de 28/10/2026. Leia este arquivo primeiro, depois CLAUDE.md,
o checkpoint de CONTEXTO.md e as últimas seções de PROGRESS.md.

## Autorização e limite de uso

- Projeto: D:\Claude\AssistFin, branch feat/assistant-intelligence-v2.
- O usuário autorizou procurar defeitos, reproduzir com dados sintéticos,
  corrigir, testar, documentar e fazer commits locais enquanto dorme.
- Consultar uso no começo e entre lotes curtos. Ao restarem10% ou menos na
  janela de cinco horas, salvar e parar para preservar pelo menos5%.
  Consumo simultâneo em outros chats pode alterar a reserva. O limite semanal
  pode ser utilizado. Não gastar uso artificialmente nem repetir gates sem causa.
- Não usar créditos de reset, comprar créditos ou fazer chamadas pagas.
- Não fazer push, merge, deploy ou APK. Preservar .claude/launch.json.
- Automação existente: retomar-testes-do-assistfin, neste mesmo chat,
  ativa desde28/10/2026 às09:09:50 de São Paulo, a cada cinco horas.
  Não criar duplicata. Computador e aplicativo precisam estar disponíveis.
- Ao faltar uso, não insistir em tentativas; retomar quando houver capacidade.
  Ficar quieto se nada mudou. Notificar avanço concreto, falha, conclusão ou
  necessidade de decisão. Não reabrir trabalho concluído só para consumir uso.

## Estado ao encerrar esta janela

Último commit antes deste checkpoint:34fc8a0. O lote que contém este documento
acrescenta a barreira de data/referência da fatura. Confira git log/status antes
de editar. Só .claude/launch.json deve permanecer modificado após o commit.

Baseline validada:666 corpus,99 consulta/cenário,50 semânticos,
621 adversariais,4088 +3800 metamórficos,1416 fuzz,151 invariantes,
468 avaliações remotas OFFLINE; suíte completa, typechecks frontend/API,
build e rubrica verdes (0 perigosa/ruim,5 aceitáveis,85 excelentes).
Aviso conhecido de bundle grande (~848kB) permanece.

Produção antiga: main em e6f6229, DeepSeek Pro com thinking desligado,
conforme registro anterior; não foi rechecada ao vivo. V2 NÃO publicada e
continua NOT READY para merge/deploy até auditoria independente. O smoke
anterior de persistência cobriu só manutenção/confirmar/recarregar/desfazer
com dados fictícios. Novas mudanças na Home/data de pagamento ainda não
tiveram novo smoke de interface.

## Commits e correções desta janela

- cd5aaef: entrada ausente considera faturas/parcelas/contas em30dias;
  não usa receita futura como histórico. Nova hipótese completa pode trocar
  cenário. Consulta alterna previsão/recebido preservando origem. Metas
  recuperam acumulado atual após pergunta mensal sem histórico.
- 811ef5d: Home, avisos e resumos usam os mesmos compromissos de caixa.
  Pendência incerta capaz de inverter resultado e legado ambíguo de cartão
  impedem afirmar cobertura. Fatura não duplica parcela.
- 6195f23: currentBalance exclui datas futuras em transações, CardPayment,
  pagamentos diretos/parciais de parcelas. Cenários/projeção recebem data.
- c48c641: formulário/reducer recusam datas futuras, inválidas e vazias de
  pagamento. Pagar HOJE uma fatura que ainda vencerá continua permitido.
- 6f5a287: "devo muito?" mostra dívida factual sem classificação inventada.
  Antecipação explica limitação do mês de referência no chat.
- 34fc8a0: "e este mês?" preserva janela futura da previsão; "e da Casa2
  esse mês?" altera origem e mês juntos, inclusive no realizado.
- Lote deste checkpoint: fatura explicitamente datada ou com referência de
  mês que o contrato não representa deixa de gerar proposta que descartaria
  a informação. Verifica a cláusula do pagamento, preservando contraste de
  pagamento feito junto de intenção futura em outra cláusula. Sem remoto.

## Próximas prioridades concretas

1. Investigar valor depois do nome da fatura. A sonda confirmou que
   "paguei a fatura de novembro do Inter200" produzia card-payment SEM amount,
   portanto pagamento de todo pendente. A referência explícita agora bloqueia
   esse exemplo, mas o extrator em nlp.ts continua lendo valor só logo após
   paguei/pagar/quitei. Reproduzir "paguei a fatura do Inter200" sem mês e
   variantes com reais/R$, número de cartão e data: não assumir que todo número
   é dinheiro nem pagar a fatura inteira quando foi informado valor parcial.
2. Backups já existentes com pagamento datado no futuro: saldo não desconta
   antes da data, mas fatura/parcela ainda pode aparecer quitada. Não migrar
   nem reinterpretar histórico sem reproduzir e preservar proveniência.
3. Chat card-payment só tem cartão e valor; não mantém data do pagamento nem
   referenceMonth. Execução usa mês do dia de execução, que pode divergir da
   fatura exibida pelo cartão. A barreira cobre referência/data explícitas;
   investigar também a escolha implícita de fatura perto da virada do mês.
4. Continuidade: previsão de receita "esta semana" ainda usa leitor de semana
   realizada (últimos7dias), ao contrário do mês que foi corrigido. Reproduzir
   com vencimentos próximos. Resolver definição de janela explicitamente.
5. Fazer smoke local da Home e da validação de pagamento com dados sintéticos,
   sem acessar dados financeiros reais e sem habilitar remoto.

Outras limitações/decisões permanecem no fim de PROGRESS.md: confirmação de
recorrente pelo chat ainda duplica se também confirmada na Home, retirada de
reserva não implementada, apagar transação salva pelo chat ausente, origem em
minúscula não deve ser inferida, fixtures antigas às vezes têm startDate/dueDay
incoerentes. Não reintroduzir inferência de origem que já quebrou modalidade.
