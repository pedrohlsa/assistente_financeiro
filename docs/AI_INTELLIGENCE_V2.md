# Assistente Intelligence v2 — auditoria, implementação e checkpoint

> Este é o checkpoint da rodada anterior (`9c9c72b`). As dívidas descritas nas
> seções 7 e 10 foram revisitadas na rodada final. Depois disso, uma auditoria
> adversarial encontrou bloqueios e foi respondida na branch. Para o estado
> vigente (ainda aguardando segunda auditoria Astra), veja
> [AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md](AI_INTELLIGENCE_V2_ADVERSARIAL_FIXES.md).

Data: 25/09/2026  
Branch: `feat/assistant-intelligence-v2`  
Base: `main` / `origin/main` em `e6f6229`

Esta rodada foi inteiramente local e determinística. Não alterou `api/**`, modelo, thinking,
prompt remoto, retry ou configuração de produção. Não houve chamada DeepSeek, benchmark, gasto,
push, merge, deploy ou APK.

## 1. Baseline antes da mudança

- branch de origem e `origin/main`: `e6f6229`;
- working tree: apenas `.claude/launch.json`, configuração local preservada e nunca commitada;
- 660/660 casos, 75/75 goldens, 40/40 semânticos;
- 4.080 metamórficos preservando semântica + 3.800 mudando modalidade;
- 1.416 fuzz, 137/137 invariantes e 468/468 evaluator;
- `typecheck`, `typecheck:api` e build verdes.

## 2. Autópsia dos clusters no código que existia

Todos os casos abaixo foram reproduzidos pelo caminho real antes da correção. Nenhum dos onze
estava semanticamente resolvido por completo. O p-34 tinha ganhado apenas uma falha segura: o
resíduo `alimentação desde` impedia um número local errado e mandava a pergunta adiante, mas a
semântica temporal ainda não existia.

| Cluster | ID | Frase resumida | Comportamento antes | Esperado | Onde se perdia |
|---|---|---|---|---|---|
| C3 | p-09 | obra e lazer juntos em 2 meses | mantinha só `obra` | filtro OR com as duas; total combinado | `query/parse.ts`: alvo singular e parada em `e` |
| C3 | p-12 | Casa 2 comparada com Casa 1 | filtrava só Casa 2 | agrupamento por origem com as duas | extração singular de origem |
| C3 | p-26 | lazer ou alimentação | mantinha só lazer, sem breakdown | duas categorias, grupo `category` | cardinalidade e intenção colapsavam |
| C4 | p-01 | cresceu nos últimos meses | adotava janela implícita | perguntar quantos meses | período vago ganhava default silencioso |
| C4 | p-33 | caiu ou subiu desde junho | junho isolado/comparação inadequada | série desde junho até hoje | mês nomeado consumia `desde` |
| C4 | p-34 | média mensal desde março | não respondia localmente; antes já respondeu março isolado | março até hoje, por mês | `parsePeriod` só representava mês isolado |
| C6 | p-22 | tirar Casa 1 | `excludeText: casa` | `excludeText: casa 1` | filtro de palavras removia dígito de um caractere |
| C7 | s-01 | comprar e continuar guardando | primeira/uma transformação | compra + guardar no mesmo cenário | `planScenario` retornava no primeiro ramo |
| C7 | s-02 | Casa 1 atrasar e pagar Nubank | só entrada ausente | dois passos no mesmo cenário | plano de cenário era singular |
| C8 | s-04 | 20 mil de entrada + financiar 40 mil em 48x | total 40 mil, sem entrada | total 60 mil, entrada 20 mil, financiado 40 mil | dinheiro e estrutura da compra não eram ligados |
| C8 | s-07 | 2 horas/dia a semana toda | 30 dias | 7 dias | `por dia` tinha horizonte fixo de 30 dias |
| C8 | s-13 | parar de guardar por 3 meses | guardar R$ 3/mês | recusar: transformações não representadas | primeiro número temporal virava dinheiro |

### Causas reais agrupadas

1. **Cardinalidade ausente:** categorias e origens eram extraídas como um único alvo.
2. **Calendário incompleto:** mês nomeado ganhava de intervalo, e período vago ganhava convenção implícita.
3. **Identidade podada:** a limpeza lexical descartava o `1` de `Casa 1`.
4. **Plano de cenário singular:** ramos com `return` impediam composição.
5. **Domínio numérico não tipado no parser:** duração, entrada, financiado e valor disputavam o mesmo primeiro número.

## 3. Consultas, períodos e exclusões

- categorias múltiplas são preservadas em arrays já suportados pela Query DSL;
- `juntos/somados/total` produz combinação; `ou/separados/qual pesou mais` produz breakdown e
  ranking; sem marcador, o app pergunta `total juntas` ou `separadas`;
- duas origens explícitas produzem agrupamento por origem sem filtrar uma delas para fora;
- `desde março` é março até hoje; `de março até junho` é intervalo fechado; `últimos N meses`
  mantém calendário mensal; `últimos meses` pergunta quantos;
- `desde que comecei a obra` pergunta a data quando não existe um marco confiável no estado;
- identificadores numéricos são preservados; exclusões múltiplas têm `excludeTexts[]` e
  validação tipada; plataformas como Uber e 99 são excluídas individualmente, não pela categoria inteira.

## 4. Cenários compostos

`AssistantScenarioPlan` continua sendo a porta do Scenario Engine e ganhou `kind: compound` com
`steps` ordenados. Não foi criado um segundo motor.

Tipos novos: `compound`, `reduce` e `save-share`. O executor roda cada passo somente leitura. Para
`guardar metade do que sobrar`, calcula o resultado mensal, aplica os efeitos anteriores e só então
usa a fração. A resposta lista todos os passos e termina com `Simulação — nada foi registrado.`.
O harness continua comparando o estado antes e depois byte a byte.

Também foram separados preço total, entrada, financiado, parcelas, dias, semanas, meses e dinheiro.
`Semana toda` usa 7 dias; `dias úteis`, 5; `R$ 300 por mês durante 3 meses` mantém valor 300 e
horizonte 3, sem transformar o 3 em dinheiro.

## 5. Motor determinístico de drivers

O módulo `src/assistant/drivers/` é local e read-only:

1. compara o mês atual até hoje com o mesmo número de dias do mês anterior;
2. soma receitas e despesas realizadas, excluindo `saving` e outras transferências internas;
3. calcula deltas por categoria;
4. converte cada delta em contribuição para o resultado: receita usa `delta`; despesa usa `-delta`;
5. ordena os responsáveis por impacto absoluto;
6. identifica recorrências iniciadas/encerradas, parcelas iniciadas/terminadas e despesas
   extraordinárias como fatos estruturais, sem contá-las duas vezes;
7. produz fatos com proveniência e composição local.

Identidade verificada por invariante:

```text
sum(driver.contribution)
  = delta(receitas) - delta(despesas)
  = delta(resultado)
```

A tolerância é R$ 0,005. A resposta só diz `A conta fecha` quando a reconciliação passa.

Rotas locais cobertas: `por que sobrou tão pouco`, `por que/pq gastei mais`, `onde aumentou`,
`o que/oq mudou`, `por que meu saldo caiu` e `o que pesou no orçamento`. `Pra onde foi a grana`
continua sendo distribuição, e `qual foi o motivo?` sozinho continua sendo follow-up.

## 6. Clarificação e Conversation Focus

- uma ambiguidade material gera uma pergunta específica, uma por vez;
- período vago, cardinalidade ambígua e evento sem data têm perguntas próprias;
- o foco ganhou o pacote de drivers e responde `como chegou nisso?` sem usar remoto;
- `e o segundo maior?` usa o segundo driver estruturado;
- a conversa de teste muda em sete turnos: consulta → outro período → distribuição → exclusão →
  cenário → cenário encadeado → viabilidade;
- exclusão por origem no follow-up preserva `Casa 1` inteira;
- `e guardar metade disso?` acrescenta `save-share` ao cenário ativo.

## 7. Personalização e anomalias

Não foi criada memória livre nem armazenamento novo. `personalModel.ts` continua derivado apenas de
histórico confirmado, com recência, amostra, confiança, rival e níveis de evidência. Correção e undo
mudam a evidência porque mudam o próprio histórico; histórico antigo não é reinterpretado.

O detector de valor atípico já existia em `learning.ts`: exige perfil da mesma categoria/tipo,
amostra mínima de seis, mediana e fator 6; avisa sem bloquear. Foi auditado e preservado, não
duplicado. O motor de drivers acrescenta só a marca read-only de despesa extraordinária.

Limitação mantida: `explicit-preference` existe no tipo, mas não há armazenamento editável próprio
de preferências. Criá-lo exige contrato de edição/migração e ficou fora desta rodada.

## 8. Testes finais

- núcleo e navegação: verdes;
- corpus: 660/660;
- consulta, cenário e continuidade: 97/97 (os 75 anteriores + 22 casos novos);
- semânticos pelo orquestrador: 50/50 (eram 40);
- metamórficos: 4.088 preservando sentido + 3.800 mudando modalidade;
- fuzz: 1.416;
- invariantes: 138/138 (94 financeiras + 26 copiloto + 18 canal remoto);
- evaluator offline: 468/468;
- `typecheck`, `typecheck:api` e build: verdes;
- build mantém apenas o aviso conhecido de chunk acima de 500 kB.

Nenhum `api/**` mudou. O evaluator usou transporte falso/replay; nenhuma rede externa foi tocada.

## 9. Commits

- `d57d288` — consultas multi-entidade, intervalos e exclusões;
- `1e6e384` — cenários compostos;
- `1d65c41` — drivers financeiros reconciliados;
- `7aecb8a` — duração de cenário separada de dinheiro;
- `3b1797a` — intenção preservada em follow-ups analíticos;
- `7729a5c` — evento sem data pede esclarecimento.

## 10. Dívida técnica honesta

- cenário composto reconcilia efeitos mensais suportados, mas não materializa uma nova cópia de
  `AppState` a cada passo para todas as espécies futuras de transformação;
- `save-share` usa o resultado mensal e os efeitos anteriores; ainda não produz conta acumulada
  mês a mês até a data-alvo;
- parcela/recorrência estrutural aparece como contexto, sem ser somada novamente aos drivers;
- não existe preferência explícita editável fora do histórico confirmado;
- a anomalia existente é conservadora e por categoria, não por estabelecimento/origem;
- o compositor de drivers é local. Um compositor remoto futuro só deve receber fatos agregados e
  precisa passar pela barreira numérica antes de ser ligado.
