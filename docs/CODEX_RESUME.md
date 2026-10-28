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

Último commit confirmado ao iniciar o lote atual:b1efa8e. Este lote impede
o chat de escolher mês errado entre faturas pendentes. Confira git log/status antes de
editar. Só .claude/launch.json deve permanecer modificado após o commit.

Baseline validada:666 corpus,99 consulta/cenário,50 semânticos,
637 adversariais,4088 +3800 metamórficos,1416 fuzz,151 invariantes,
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
- Lote atual: "paguei a fatura do Inter 200", com R$ ou reais, propõe e executa
  pagamento parcial de200; uma fatura300 mantém100 pendentes e saldo cai200.
  Número de conta depois do cartão não é interpretado como pagamento. Cinco
  testes adversariais novos, quatro vermelhos antes da correção. Sem valor explícito,
  pagamento integral permanece. Sem remoto.
- Previsão de receita "esta/essa semana" passa a olhar hoje e os próximos seis
  dias. A entrada recorrente de amanhã não some; o recebido permanece nos
  últimos sete dias realizados. Três regressões pelo orquestrador real.
- Pagamentos futuros em backups não quitam a fatura/parcela hoje. Fatura,
  dívida total, limite usado, projeções, consulta e progresso consideram só o
  que foi pago até hoje. O registro bruto foi preservado; a tela sinaliza a
  data futura e bloqueia pagamento duplicado até a reconciliação, inclusive
  no formulário, executor e reducer. Sete regressões.
- Quando há fatura anterior ainda aberta, pagamento pelo chat sem mês não
  escolhe a fatura atual automaticamente; explica a ambiguidade e indica a
  tela com mês de referência. O executor também recusa a ação ambígua. Testes
  de controle com fixture rica usam faturas antigas reconciliadas.

## Próximas prioridades concretas

1. Chat card-payment só tem cartão e valor; não mantém data do pagamento nem
   referenceMonth. Referência/data explícitas e múltiplas faturas abertas são
   recusadas no chat. Seleção de outro mês ainda exige a tela de cartões.
2. Fazer smoke local da Home, da validação de pagamento e do aviso de pagamento
   futuro em backup sintético, sem acessar dados financeiros reais nem habilitar remoto.

Outras limitações/decisões permanecem no fim de PROGRESS.md: confirmação de
recorrente pelo chat ainda duplica se também confirmada na Home, retirada de
reserva não implementada, apagar transação salva pelo chat ausente, origem em
minúscula não deve ser inferida, fixtures antigas às vezes têm startDate/dueDay
incoerentes. Não reintroduzir inferência de origem que já quebrou modalidade.
