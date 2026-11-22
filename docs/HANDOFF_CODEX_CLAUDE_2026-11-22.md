# AssistFin — passagem do Codex em 22/11/2026

## Estado local

- Repositório `/home/stuart/work/assistfin`, branch `feat/assistant-intelligence-v2`.
- Rodada começou em `4b33876`, após o relato em `docs/HANDOFF_2026-11-22.md`.
- HEAD funcional em `53ea5af`. HEAD do fechamento em `2922a2c`, com 16 commits funcionais e um registro no `PROGRESS.md`. Este arquivo fica fora dos commits, junto dos handoffs anteriores.
- **NOT READY**. Tudo foi local. Push, merge, deploy, APK e DeepSeek real exigem autorização explícita. A cópia `/home/stuart/work/assistfin-driver-copilot` ficou fora desta revisão.

## Correções

- `0fe009a` — vacância aceita o imóvel e o prazo juntos ou em respostas separadas. Entende “ficar três meses sem receber o aluguel” e “o inquilino da Casa 2 sair”. Prazo aproximado, negativo ou com alternativas pede esclarecimento.
- `1519a76` — vacância aceita “até fevereiro”, “até 27/12/2026”, “três meses começando mês que vem” e “e no mês que vem?”. Usa o intervalo exato para retirar vencimentos da fonte. No fixture, três meses começando em dezembro preservam novembro e retiram R$ 4.800. A data final é inclusiva.
- `1902fa1` — “vendi três bolos a 25 cada e recebi só 50” propõe R$ 50 em Vendas. Pagamento pendente sem valor recebido pede o valor que entrou. Uma despesa independente e uma entrada de outra fonte continuam separadas. A data informada no recebimento prevalece sobre a data da venda quando as duas aparecem na construção testada.
- `fd090a3` — “paguei metade dos 150 da luz, deu 75” propõe R$ 75 como despesa avulsa. O vencimento segue em aberto. O Planejamento ainda usa o valor previsto da conta porque o modelo atual não vincula recebimentos ou pagamentos parciais a uma ocorrência. R$ 70 como suposta metade de R$ 150 pede o valor real. A pergunta de consulta após o registro parcial continua respondida.
- `f27d7be` — propostas com “limpo” e “líquido” identificam o valor declarado. A fonte Uber ou 99 é mantida. “Na 99 tirei 180 limpo” prepara R$ 180, sem transformar o nome da plataforma em valor ou inventar viagem.
- `4b1181e` — “a 99 pagou 380 com a taxa já descontada” e “o saldo da Uber veio 380 líquido com a taxa já descontada” mantêm um único repasse líquido. A taxa retida fica marcada na proposta, inclusive quando o valor da taxa não foi informado, e o chat dispensa a pergunta de cobrança de saque.
- `f47b4ce` — “deu 200 limpo já com combustível” e “fiz 250 bruto e 200 limpo” pedem o valor que entrou. Quando a frase declara R$ 430 brutos, R$ 50 de combustível e R$ 380 de sobra, a proposta contém só a receita e o combustível. Se a conta for contraditória, pede confirmação dos valores.
- `8d948e0` — “paguei 80 de luz com saldo de 1000” propõe R$ 80 de despesa. “Paguei 80 e fiquei com 1000 na conta” mantém o relato em ordem. Saldo atual admite zero e negativo, e alternativas pedem escolha. O corretor fica impedido de transformar uma palavra em número, como “certo” em “cento”.
- `4545b7f` — gasto hipotético desconta do saldo mesmo quando a âncora é atualizada depois do meio-dia. A sobra do mês usa a data da simulação. Zero informado tem tratamento de saldo conhecido.
- `c56b9d9` — “com saldo de 1000 dá pra pagar 800?” simula R$ 200 restantes e mantém o registro intacto. Aceita valor por extenso, saldo negativo e revisão do saldo no turno seguinte.
- `ca52cb4` — R$ 2,26 em duas parcelas dá R$ 1,13 em cada uma. Varredura independente em 96 mil combinações detectou 783 divergências no cálculo anterior.
- `1023eab` — simulação distingue R$ 90 em 120 vezes de R$ 120 em 90 vezes. “12x de 100” calcula R$ 1.200. Total e parcelas contraditórios pedem esclarecimento.
- `3cf6106` — compra à vista no cartão vira 1x com a data dita. Compra explicitamente em dinheiro, Pix ou débito vira despesa. Pagamentos paralelos das faturas de dois cartões retêm a direção, e “paguei 1 de 12 parcelas” orienta a baixa da parcela específica.
- `5500ee0` — cashback e estorno abatidos na fatura ficam fora do caixa. Reembolso via Pix ou na conta usa o valor que entrou, inclusive quando o usuário cita o preço original e explica o que foi cobrado a mais.
- `2f4fdc2` — “transferi 100 para mim” e “do Nubank pra minha conta do Inter” mantêm o caixa. Envio a outra pessoa e despesas ditas à parte continuam propostas.
- `53ea5af` — “me descontaram 150 em folha, recebi 1800” propõe salário líquido de R$ 1.800. A dedução descrita não se torna uma segunda saída, e outras origens e despesas continuam separadas.

## Validação

- Baseline em `4b33876`: 736/736 no corpus, 1.414/1.414 regressões adversariais e 151/151 invariantes.
- Em `53ea5af`: `npm test` passou com 1.438/1.438 regressões adversariais, 151/151 invariantes, ditado simulado e testes remotos offline. Os dois typechecks passaram. Consulte `/tmp/assistfin-22-payslip.log`.
- No fechamento, os testes monetários, a rubrica e o build passaram. A rubrica teve 85 casos excelentes, 5 aceitáveis, zero ruins e zero perigosos, em 90 avaliados. O build emitiu o aviso de tamanho do pacote principal.
- Duas matrizes independentes fizeram 1.120 + 440 verificações por fuso, em São Paulo, Los Angeles e Kiritimati. Foram 4.680 aprovações e zero chamadas ao serviço remoto. Scripts `work/assistfin-ia-rodada2-matriz.mts` e `work/assistfin-22-matriz.mts` no workspace `/home/stuart/Documents/Codex/2026-11-18/ass`.
- Chrome com perfil isolado e base fictícia validou vacância em dois turnos, venda parcial, despesa de luz com vencimento em aberto, repasse líquido da 99, data manual e ditado simulado. Scripts `work/assistfin-22-vacancia-vendas-repasse-browser.mjs` e `work/assistfin-22-browser-suite/{compra-manual-data,ditado-saldo-estorno}.mjs`.
- A matriz oficial passou nas oito datas. Contagens adversariais por execução na ordem do log: 1.438, 1.435, 1.438, 1.433, 1.435, 1.435, 1.438 e 1.438. A quantidade varia conforme casos condicionais da data. Log em `/tmp/assistfin-22-calendario-final.log`.
- Logs em `/tmp/assistfin-22-*.log`. As sondagens independentes ficam em `/tmp/assistfin-22-{vacancia,dinheiro,vendas,parciais}.mts` enquanto essa sessão estiver disponível.

## Limites da validação e próximos casos

- Chrome confirmou a data escolhida na compra manual, o bloqueio de data futura e o fluxo de “ontem passei 80 no cartão” no crédito e no débito. A ficha separada “Novo parcelamento” para dívidas e acordos tem primeiro vencimento. Nessa ficha, dias de pagamento passados ficam sem histórico quando não foram informados.
- Ditado simulado de Chrome passou com transcrição final em dois trechos pt-BR, cancelamento, permissão negada e navegação durante o ditado. O reconhecedor foi substituído por um simulado.
- “Dá pra pagar 800 com saldo de 1.000 na poupança?” ainda usa o saldo geral do app. Antes de projetar, diferencie a disponibilidade na conta da poupança. A variação “com saldo de 1.000 na conta” já usa a premissa correta. Sondagem em `/tmp/assistfin-22-scenario-dinheiro.mts`.
- “Meus 1800 entraram depois do empréstimo descontado em folha” ainda pede relato direto do salário líquido. Preserve a distinção entre recebimento de um empréstimo, verba em folha e pagamento de parcela. Sondagem em `/tmp/assistfin-22-retornos.mts`.
- Pagamento parcial de conta recorrente ainda não abate o pendente no Planejamento. A semântica de parcelas específicas continua na tela de Cartões e parcelamentos. Retirada de reserva continua sem lançamento próprio.
- Voz real, Android, APK e DeepSeek real pendentes.

```bash
cd /home/stuart/work/assistfin
npm test
npm run test:calendario
npm run typecheck
npm run typecheck:api
npm run test:money
npm run rubric
npm run build
```

Rode a matriz com `src/` e `tests/` estáveis. Ela recarrega os arquivos a cada data.
