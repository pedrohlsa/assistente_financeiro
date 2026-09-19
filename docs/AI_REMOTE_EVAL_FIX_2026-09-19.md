# Correção da primeira bateria remota — 19/09/2026

## Escopo e cadeia de custódia

- Base de documentação antes da correção: `da0e884`.
- Artefatos originais reprocessados: `eval-results/2026-09-19T07-57-40-544Z`.
- O manifesto da execução registra o commit de código `5510bdf`.
- Custo histórico preservado: **US$ 0.0921**.
- O replay foi exclusivamente offline: 231 resultados e 263 registros HTTP já existentes.
- Nenhuma chamada DeepSeek, consulta de saldo, alteração de modelo, prompt,
  `max_tokens`, produção, deploy, APK, push ou merge foi feita.
- Os artefatos originais foram somente lidos. O replay registra SHA-256 dos três
  arquivos usados para permitir conferir que a entrada permaneceu intacta.

## 1. Causa da recusa de `order: null`

O planejador remoto usa JSON e os modelos devolveram `order: null` para dizer
"ordenação não especificada". O contrato TypeScript declara `order` opcional,
mas o validador distinguia `null` de campo ausente e tentava validar `null` como
enum. O resultado foi `unknown-order` em 27 planos que, nessa dimensão, eram
estruturalmente válidos.

A correção normaliza `null` para ausência apenas na borda remota e apenas para
campos explicitamente opcionais cujo `null` não possui significado próprio. O
objeto bruto não é alterado.

## 2. Auditoria dos contratos remotos

| Contrato | Campos | Política efetiva |
|---|---|---|
| Plano de consulta | `source`, `period` | Obrigatórios; `null`, vazio ou tipo incorreto são recusados. |
| Plano de consulta | `version`, `field`, `metric`, `group`, `order`, `comparePeriod`, `filter`, `limit`, `shareBase`, `label` | Opcionais; `null` equivale a ausente. Enum/tipo inválido continua recusado onde o contrato exige validação. |
| Filtros | todos os filtros do DSL | Opcionais; `null` equivale a ausente. `weekdays` não converte mais `null`, `false` ou string vazia em domingo por coerção de `Number(...)`. |
| Período | `from`, `to` | Obrigatórios; `null`, vazio, data impossível e intervalo excessivo continuam recusados. |
| Envelope de chat | `reply` | Obrigatório; `null` e vazio continuam recusados. |
| Envelope de chat | `version`, `mode`, `actions`, `clarification` | Opcionais; `null` equivale a ausente. `actions` de tipo errado continua recusado. |
| Ações | campos marcados `required` no catálogo | `undefined`, `null` e vazio continuam sendo `missing-field`. |
| Ações | demais campos do catálogo | Já tratavam `null` como ausência; nenhuma mudança. |
| Cenário candidato da avaliação | `falta` | `null` tem sentido próprio (nenhum dado faltando) e foi preservado, sem normalização genérica. |

Campos desconhecidos continuam seguindo o contrato vigente: são descartados e
nunca entram no plano/ação validado. Chaves perigosas (`__proto__`,
`constructor`, `prototype`) continuam recusadas antes da normalização do plano;
os demais contratos constroem a saída campo a campo e não propagam a entrada.

Casos de contrato acrescentados:

1. `order` ausente é válido;
2. `order: null` equivale a ausente;
3. valor válido é preservado;
4. enum desconhecido e string vazia são recusados;
5. campo obrigatório `null` é recusado;
6. tentativa de prototype poisoning é recusada;
7. campo desconhecido não entra no objeto validado;
8. os outros opcionais `null` seguem a mesma regra documentada;
9. `null` com significado próprio não é apagado genericamente;
10. plano remoto com `order: null` é executado ponta a ponta, em vez de cair no chat.

## 3. Proveniência numérica

O avaliador agora registra separadamente estas origens:

- `remote-output`: texto livre escrito pelo modelo;
- `remote-plan`: estrutura proposta pelo modelo;
- `local-query-result`: números calculados pelo executor local de consulta;
- `local-scenario-result`: números calculados pelo executor local de cenário;
- `deterministic-composer`: texto produzido sem modelo a partir do resultado;
- `fallback-local`: resposta local depois de falha remota.

Somente o trecho `remote-output` é examinado como texto livre para alucinação
numérica do modelo. Planos e ações remotos continuam comparados ao gabarito e
validados deterministicamente. A regra 53 permanece estrita: uma derivação que
o próprio modelo escreve ainda precisa estar explicitamente permitida pelo caso.

O falso positivo conhecido `C / k-04 / turno 5` foi corrigido: os seis valores
por dia da semana vieram de `remote-plan` → `local-query-result` →
`deterministic-composer`, e não do texto do modelo.

## 4. Replay offline: antes → depois

| Config | Perigos/100 | Qualidade | Plano semântico | Contrato inválido | Alucinação numérica |
|---|---:|---:|---:|---:|---:|
| B antes | 9,1 | 61,8 | 34,8% | 15,6% | 7,8% (4) |
| B depois | 10,4 | 65,9 | 52,2% | 2,6% | 7,8% (4) |
| A antes | 16,9 | 63,2 | 34,8% | 13,0% | 4,0% (2) |
| A depois | 19,5 | 68,1 | 56,5% | 1,3% | 4,0% (2) |
| C antes | 19,5 | 62,6 | 43,5% | 10,4% | 12,2% (6) |
| C depois | 19,5 | 65,7 | 56,5% | 0,0% | 10,2% (5) |

A aceitação dos planos revelou erros de modalidade que antes ficavam ocultos
atrá da recusa de contrato; por isso o total de perigos de A/B pode subir mesmo
com a correção. Isso é um diagnóstico mais fiel, não uma regressão do modelo.

- Planos recusados: **29 → 2**.
- Recusas `unknown-order`: **27 → 0**.
- Recusas reais restantes: A/p-17 e B/p-17, ambas
  `metric-not-applicable per-hour em work`.
- Valores locais retirados da atribuição ao modelo: **6**, todos em C/k-04#5.
- Ordem final preservada: **B > A > C**.
- Plano exato não mudou: aceitar `null` resolve validade/semântica, não faz a
  saída ficar byte a byte igual ao gabarito.

## 5. Achado operacional de C preservado

O replay não mascara nem reclassifica falhas de transporte:

- `finish_reason=length`: **21**;
- respostas HTTP 200 vazias: **16**;
- retries: **13 antes e 13 depois**;
- p95: **10.597 ms antes e depois** (aprox. 10,6 s).

## 6. Decisão sobre nova bateria paga

Uma nova bateria A+B+C **não é necessária para validar estas duas correções**:
o replay usa exatamente as mesmas saídas remotas e reaplica apenas o contrato e
o avaliador corrigidos.

Ela **continua necessária antes de uma decisão definitiva de modelo**, porque a
amostra tem uma repetição e B/A permanecem estatisticamente próximos em
segurança. Não deve ser executada agora: primeiro convém decidir se os 21
encerramentos por limite, 16 vazios e 13 retries de C justificam uma mudança
separada de configuração; essa mudança está fora do escopo deste trabalho.

## 7. Como reproduzir sem custo

```text
npx tsx scripts/replay-assistant-eval.mts
```

O comando imprime o comparativo e os hashes em `stdout`; não escreve na pasta
de artefatos.
