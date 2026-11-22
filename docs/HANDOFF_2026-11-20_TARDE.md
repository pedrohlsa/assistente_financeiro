# AssistFin — Handoff (20/11/2026, tarde)

Continua o `docs/HANDOFF_CLAUDE_2026-11-20.md`, escrito pelo Codex. Leia este primeiro.

## Estado

- Repositório Linux: `/home/stuart/work/assistfin`, branch `feat/assistant-intelligence-v2`.
- HEAD: veja `git log -1`. Doze commits locais desde `6129f5a`.
- A branch **nunca foi enviada** ao GitHub. Ela existe só neste Linux e, parada em `9bc0457`, no disco do Windows.
- Os arquivos `docs/HANDOFF_*.md` ficam fora dos commits.
- **NOT READY para merge ou deploy.** Push, merge, reset e deploy exigem autorização do usuário.
- Nada foi testado com voz real, Android, APK ou DeepSeek.

```bash
cd /home/stuart/work/assistfin
source ~/.nvm/nvm.sh
npm test
npm run test:calendario
npm run typecheck && npm run typecheck:api && npm run build && npm run rubric
```

## O que esta rodada fez

O resumo por defeito está na última seção de `PROGRESS.md`. A regra nova é a 67 do `CLAUDE.md`. Os blocos de teste em `tests/assistant/adversarial-real.ts` têm estes prefixos:

| Prefixo | Assunto |
|---|---|
| `MV-` | Dois fatos do mesmo valor numa frase |
| `MF-` | Meio-dia, hora relativa, turno, minuto ou valor |
| `ML-` | Listas faladas: receita fantasma, itens com valor, abastecimento com lanche |
| `MQ-` | Origem curta, plataforma na pergunta, nome de conta fixa |
| `MT-` | Meta com "até", média semanal, abreviações |
| `MA-` | Acento e `\b` (varre `src/`), guardas contra injeção |
| `MP-` | Previsão do fim do mês |
| `MC-` | Complemento curto da proposta no turno seguinte |
| `MX-` | "Uns 30 ou 40", lavagem |

Resultado: 899/899 adversariais, rubrica com 0 perigosa e 0 ruim, e calendário verde nas oito datas.

## Abertos

- "paguei a taxa da 99 de 1 real" cai no menu de ajuda. Cuidado com a regra 1 da taxa da 99.
- "qual dia eu mais ganho" responde a data, não o dia da semana.
- "quanto meu carro custa por km" e o custo completo (`kmCost`) não foram revistos nesta rodada.
- Voz real, microfone, reconhecimento nativo do Android, APK e DeepSeek continuam pendentes.

## Como as sondas foram feitas

Os scripts foram escritos em `scripts/.probe-tmp/` e apagados no fim. Cada um chamava `orchestrate()` com `remoteEnabled: false`, importando `tests/clock` primeiro, e imprimia modo, ações e a primeira linha da resposta. Cada defeito lido virou caso no bloco correspondente antes da correção.
