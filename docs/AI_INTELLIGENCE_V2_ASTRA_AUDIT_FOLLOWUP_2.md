# Intelligence v2 — resposta ao segundo parecer do Astra

Estado local da branch `feat/assistant-intelligence-v2`, a partir do commit
`3693a23`. Este documento registra correções locais e seus limites; **não é
aprovação para merge ou deploy**.

## Falhas reproduzidas e corrigidas

- A âncora de saldo agora guarda segundos, como os pagamentos. No caso auditado,
  pagamento às 09:00:10 seguido de saldo informado às 09:00:50 mantém R$ 800,
  tanto para fatura quanto para parcela paga diretamente. O lote do assistente
  compartilha o mesmo carimbo entre a simulação e a aplicação no reducer.
- Ao acrescentar pagamento a uma parcela legada com `paidAmount` e `paidAt`, o
  reducer preserva o valor anterior como evento na data conhecida e lança
  somente o novo valor. Com R$ 100 antigos e mais R$ 50, o saldo passa de
  R$ 900 para R$ 850; ao completar os R$ 100 restantes, para R$ 800.
- Quando a parcela legada tem R$ 100 pagos, mas não tem data, completar os
  R$ 100 restantes cria evento novo de R$ 100, não de R$ 200. A data do valor
  antigo continua desconhecida.
- Quitar uma fatura preserva o pagamento direto de parcela legada mesmo sem
  `paidVia`. O caminho do assistente e o reducer da interface usam a mesma
  detecção de pagamento direto.
- Aliases que transformariam sonho, hipótese ou intenção em receita/despesa
  são recusados. Além do vocabulário protegido no cadastro, cada substituição
  compara os efeitos financeiros antes/depois, nos perfis com e sem motorista.
- “Nunca”, “nem sequer”, “jamais” e “ainda não fui pago” não geram dinheiro ou
  corrida realizada. Negar salário fixo não elimina uma corrida já recebida.
- Uma comparação de meses mantém a categoria anterior só quando o novo pedido
  não especifica outra. “Em casa” muda para casa; “todas as categorias” remove
  o filtro.
- O reducer impede desfazer uma parcela isoladamente quando há pagamento da
  fatura do mesmo cartão/mês. A interface mostra essa restrição no lugar do
  botão “Desfazer”, evitando estado financeiro contraditório.
- Os testes adversariais agora proíbem **qualquer** receita no caso de corrida
  não recebida e verificam também a direção da diferença na comparação.

## Verificação local

`npm test`: 660/660 casos do corpus, 99/99 consultas/cenários/continuidade,
50/50 semânticos, 114/114 adversariais, 4.088 + 3.800 metamórficos,
1.416 fuzz, 151/151 invariantes e 468/468 verificações remotas **offline**.
Também passaram `typecheck`, `typecheck:api`, `test:money`, `build`, rubrica
local (0 perigosa, 0 ruim, 7 aceitáveis, 83 excelentes) e `git diff --check`.
O build conserva o aviso de chunk acima de 500 kB.

## Limites que continuam abertos

- Um backup com apenas `paidAmount`, sem data ou proveniência, não permite
  reconstruir o saldo histórico exato nem saber se um pagamento já estava
  embutido numa âncora. Isso exige reconciliação com o usuário; a correção
  impede inventar um pagamento **novo**, mas não inventa uma data **antiga**.
- Um pagamento de fatura já salvo não pode ser desfeito pelo botão individual
  da parcela. Para corrigir um pagamento equivocado da fatura é necessário um
  fluxo de reconciliação da fatura inteira; esse fluxo não foi criado aqui.
- A precisão de segundos resolve o caso auditado dentro do mesmo minuto, mas
  eventos distintos no mesmo segundo ainda não têm uma ordem histórica
  confiável. Isso requer carimbos mais precisos ou ordenação explícita.
- A sonda/rubrica não prova adequação de todas as respostas: pedidos como
  “quanto preciso deixar parado até dia 10” continuam merecendo revisão.
  Persistência real, navegador, dados legados reais e serviço remoto não foram
  validados por esta bateria.

Próximo passo: nova auditoria adversarial independente dos casos corrigidos e
dos limites acima. Sem essa revisão e sem reconciliação dos dados legados,
**NOT READY para merge/deploy**. Nenhuma chamada paga, push, merge, deploy ou
APK faz parte deste lote.
