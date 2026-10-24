# Intelligence v2 — correções após auditoria independente

Estado local em `feat/assistant-intelligence-v2`, após o parecer do Astra sobre `e9177e5`.
Este documento descreve as alterações feitas neste lote; não é aprovação de merge ou deploy.

## Correções reproduzidas

- Negação permanece junto ao verbo na divisão da mensagem. As frases com “não gastei” e “não fiz uma corrida” não produzem o lançamento negado.
- Preferências não aceitam os aliases de modalidade reproduzidos (`planejo → faturei`, `se → já`, `sonho → vendi`). A checagem também usa o detector de verbos financeiros no passado.
- Esclarecimento financeiro só aceita uma resposta simples e inequívoca. “Não, assim que receber eu mando” não é confundido com “sim”; respostas que alteram valor ou data pedem uma frase completa, em vez de reaproveitar a ação antiga.
- Quitar fatura preserva a parte da parcela já paga diretamente. Pagamentos diretos novos registram eventos com data e hora, inclusive parciais; o saldo usa só eventos posteriores à âncora.
- O relato longo original conserva os R$ 30 do pneu. “Não recebi ainda” impede a receita de uma corrida ainda não paga.
- Assinatura mensal encerrada antes da cobrança do mês seguinte não entra na projeção.
- Comparação de dois meses preserva a categoria em foco. Ao mudar de Casa 1 para Casa 2, o cabeçalho acompanha o novo filtro.
- Compromisso de cenário com valor por extenso não desaparece silenciosamente: aparece como trecho não incluído.
- Aviso de valor fora do padrão usa somente evidências anteriores à data do lançamento retroativo.
- Testes adversariais agora conferem o conjunto exato de ações em casos críticos e o vencedor da comparação, impedindo os falsos verdes demonstrados no parecer.

## Evidência local

`npm test`: 660/660 corpus, 99/99 consultas/cenários/continuidade, 50/50 semânticos, 97/97 adversariais, 4.088 + 3.800 metamórficos, 1.416 fuzz, 151/151 invariantes e 468/468 autotestes remotos offline. `typecheck`, `typecheck:api`, `build` e rubrica local também passaram. Rubrica: 0 perigosa, 0 ruim, 7 aceitáveis e 83 excelentes. O build mantém o aviso já existente de chunk acima de 500 kB.

## Limites e próximos passos

- Pagamentos parciais salvos em versões anteriores podem ter apenas `paidAmount`, sem data/hora. Não há como reconstruir se ocorreram antes ou depois de uma âncora de saldo. Os novos registros passam a guardar os eventos, mas dados legados ambíguos exigem reconciliação com o usuário.
- Resposta como “sim, mandei só 10” ou “sim, ontem” não vira proposta corrigida automaticamente: o assistente pede uma frase completa para não lançar os R$ 15 de hoje por engano.
- O fluxo com Pix pedido e corrida oferecida na mesma mensagem ainda não resolve “sim, fiz os dois” numa única resposta; mantém as movimentações sem registro automático.
- A sonda de conversa mostrou outras respostas a investigar fora dos casos desta auditoria (por exemplo, “quanto preciso deixar parado até dia 10” e “quantas parcelas faltam”). Testes verdes e rubrica não provam cobertura geral.
- Falta uma nova auditoria adversarial independente, principalmente com estados persistidos antigos, interface real, desfazer e pagamentos mistos. Não houve chamada paga, push, merge, deploy nem APK neste lote.
