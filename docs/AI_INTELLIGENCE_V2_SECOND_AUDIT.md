# Intelligence V2 — segunda auditoria, correções locais

Checkpoint de 23/10/2026. Branch `feat/assistant-intelligence-v2`, base
`de1e67d`. Este documento continua
[`AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md`](AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md)
e responde ao segundo parecer independente **NOT READY**. Não houve chamada
remota paga, push, merge, deploy ou APK. O `.claude/launch.json` já estava
modificado antes desta rodada e deve continuar fora de qualquer commit.

## Achados reproduzidos e corrigidos

Os dez bloqueios do segundo parecer foram reproduzidos pelo caminho real
`orchestrate` e transformados em regressões com data fixa (`2026-09-15`) e
resultados literais, sem usar o motor sob teste como oráculo:

| Achado | Correção | Prova principal |
| --- | --- | --- |
| C3: preferência muda intenção ou data | Proteção de `queria`, `comprei`, `agora`, `anteontem` e flexões de compra; alias nominal `sobrado → Casa 1` continua permitido | `queria uma TV` não propõe compra; `gastei 100 agora` preserva hoje; origem Casa 1 recebe R$ 100 |
| C2: diária antiga desaparece | Enumerador salta para perto do início da janela antes do limite de 400 ocorrências | 108 diárias futuras de R$ 10 reduzem a reserva de setembro–dezembro de R$ 4.000 para R$ 2.920 |
| C2: fatura paga reaparece | Projeção usa pendência reconciliada da fatura, mais órfãos sem cartão, em vez de somar assinatura bruta | Assinatura paga de R$ 200 não reduz saldo R$ 800 outra vez; parcela marcada paga não é cobrada na projeção |
| H7: corrida não paga vira receita | A negação na mesma cláusula remove a entrada de dinheiro | Corrida de R$ 70 explicitamente não paga não propõe receita |
| H7/H9: Pix solicitado apaga pneu e herda R$ 30 | Segmentação separa eventos sem pontuação; esclarecimento do Pix usa seu próprio valor | Pneu R$ 30 entra no lote; Pix R$ 15 fica pendente |
| H9: correção sem vírgula perde gasto | Segmentação preserva o item após “quer dizer” | Combustível R$ 45 e pneu R$ 30 entram; R$ 40 não entra |
| H1: percentual decimal vira reais | Leitura decimal de percentuais e bloqueio da interpretação como valor fixo | 30,5% e 2,5% da sobra são proporções |
| H4: segunda operação some | Operação posterior não suportada é explicitamente declarada fora do resultado | “depois investir 200” e “e ajudar minha filha” não somem silenciosamente |
| H4: reserva fixa ignora começo/fim | Reserva fixa usa cronograma mensal e horizonte explícitos | R$ 100 em novembro e dezembro soma R$ 200, não R$ 1.200 |
| H5: drivers ignoram mês dito | Análise recebe o período lido da pergunta | Agosto é comparado com julho, não setembro |

Os dois achados médios também têm regressões: “sim” após Pix solicitado,
corrida oferecida e devolução gera proposta para confirmação, nunca registro
automático. Na devolução, a receita original de R$ 70 continua confirmável ao
esclarecer os R$ 20. As ações trazidas por uma opção são validadas antes de
virarem proposta, e a UI não apaga a proposta ao limpar só o esclarecimento.

Os três falsos verdes apontados foram fortalecidos: C3 exige a despesa real
de R$ 100; H2 verifica resposta e projeção numérica de R$ 1.234,56 em 10x;
H6 exige esclarecimento específico sobre alimentação. As duas invariantes
dependentes do relógio passaram a usar `today` fixo.

## Sonda adicional

A sonda exploratória mostrou quatro erros não marcados como ruins pela rubrica:
“média por lançamento” virava busca textual, “maior gasto do ano” usava sete
dias, “compara julho com junho” ignorava junho, e “qual foi pior?” invertia a
direção da diferença. Foram adicionados testes com valores exatos e corrigidas
as rotas. A mudança da média foi limitada à expressão explícita “por
lançamento” para não regredir a média diária própria do perfil motorista.

## Estado e limites

- Os testes automatizados são **offline** e verificam código local. Ainda falta
  nova revisão adversarial independente antes de declarar READY para merge ou
  deploy; a rubrica automática sozinha não prova segurança financeira.
- M5 (alerta estatístico com IDs repetidos, recência e repetição após “está
  correto”) continua aberto, como no parecer.
- A sonda ainda mostra “e uma geladeira” após proposta de TV recebendo um
  esclarecimento de *simulação* genérico. Não registrar nem simular nada sem
  esclarecer; o fluxo de continuação dessa compra precisa de revisão própria.
- Marcar parcela como paga diretamente na tela de cartões não cria um
  `CardPayment` nem um lançamento de caixa. A projeção deixa de cobrá-la de
  novo, mas a consistência do saldo e da fatura da UI nesse fluxo merece uma
  auditoria separada, principalmente com pagamentos parciais ou mistos.
- O conteúdo substituto de alias pode sair como parte da mensagem atual para o
  remoto. Histórico bruto, saldo e lista de preferências não foram enviados
  nas capturas locais do parecer; isso não é prova de uma implantação real.
- O build emite o aviso preexistente de chunk principal acima de 500 kB.

## Gate e próximo passo

Gates finais desta rodada: `npm test`, `npm run typecheck`,
`npm run typecheck:api`, `npm run build` e `git diff --check` passaram.
Foram 660/660 corpus, 99/99 novos, 50/50 semânticos, 71/71 adversariais,
4.088 + 3.800 metamórficos, 1.416 fuzz, 150/150 invariantes e 468/468
avaliação remota offline. Repetir os gates após qualquer edição posterior.

Se todos os gates passarem, fazer somente commit **local** dos arquivos desta
rodada, excluindo `.claude/launch.json`. Solicitar nova auditoria independente
do diff. Não fazer push, merge, deploy, smoke remoto pago nem APK nesta etapa.
