# AssistFin — Assistente Financeiro Inteligente

Aplicativo mobile-first de gestão financeira pessoal com assistente em linguagem natural.
A visão consolidada do produto — perfis, arquitetura, regras financeiras e pendências reais —
está em [CONTEXTO.md](CONTEXTO.md). As regras permanentes de implementação estão em
[CLAUDE.md](CLAUDE.md).

> "Eu cuido dos seus números enquanto você cuida da sua rotina."

## Rodando

```bash
npm install
npm run dev      # http://localhost:5199
npm test         # testes do núcleo (parser, assistente local, custo por km)
npm run build    # build de produção em dist/
```

(Nesta máquina o cmd.exe não existe em System32 — o npm está configurado com
`script-shell` apontando para `C:\Windows\SysWOW64\cmd.exe`. Alternativa direta:
`node node_modules/vite/bin/vite.js`.)

## O que está implementado

- **Onboarding** (4 telas) com adaptação por perfil.
- **Home "Hoje"**: resultado do dia (lucro/saldo/faturamento alternáveis), progresso da
  meta, projeção de horas restantes, cards personalizáveis, insights e alertas.
- **Assistente IA** (chat + voz via Web Speech API): registra por linguagem natural
  ("ganhei 250", "gastei 40 de gasolina", "rodei 120 km e fiz 14 viagens", "troquei o
  óleo por 280 com 84 mil km", "quero comprar um celular de 5000 em 6 meses") com
  confirmação antes de salvar, e responde perguntas com dados reais ("quanto posso
  gastar hoje?", "essa corrida de 18 por 12 km vale a pena?", "quando trocar o óleo?").
- **Movimentações**: timeline com filtros de período/categoria e busca global
  (inclusive "mais de R$ 100").
- **Metas**: meta diária inteligente com composição explicada (contas fixas, metas
  pessoais, déficits, margem), metas de compra com análise de viabilidade e sugestão
  de prazo, diluição de déficits (7/15/30 dias).
- **Modo motorista**: km, viagens, horas, R$/km bruto/líquido, analisador de corrida
  "Vale a pena?", abastecimentos com km/L real, manutenção com barras de vida útil,
  custo real por km (combustível + manutenção + fixos).
- **Planejamento**: contas fixas com timeline de vencimentos, previsão 30 dias,
  orçamentos por categoria.
- **Análises/Relatórios**: diário, semanal, mensal, anual, comparativos com período
  anterior, gastos por categoria, exportação CSV e PDF (impressão).
- **Configurações**: perfil, tema claro/escuro, dias de trabalho, custos do veículo,
  categorias personalizadas, notificações, backup (exportar/restaurar JSON), reset.
- **Modo demo** com ~35 dias de dados realistas.

## Arquitetura

```
src/
  models/types.ts      # entidades (transactions, goals, vehicles, fuel, budgets...)
  data/                # categorias padrão + gerador de dados demo
  services/
    calc.ts            # motor de cálculos (metas, custo/km, previsões, insights)
    nlp.ts             # parser pt-BR de linguagem natural
    ai.ts              # motor de respostas do assistente (dados reais, nunca inventa)
  store/store.tsx      # estado global + persistência localStorage (offline-first)
  components/          # design system (cards, sheets, toasts, nav, formulários)
  screens/             # Home, Chat, Movimentações, Metas, Veículo, Análises...
```

### IA (DeepSeek)

O assistente usa dois motores:

1. **Parser local** (`services/nlp.ts`) — registros de dinheiro ("ganhei 300 e
   coloquei 70 de gasolina") são extraídos deterministicamente, offline, com
   suporte a vários comandos na mesma frase.
2. **DeepSeek** (modelo padrão `deepseek-v4-flash`, configurável por
   `DEEPSEEK_MODEL`) — perguntas e análises livres. A chave fica em `.env`
   (`DEEPSEEK_API_KEY`) e é usada **apenas no servidor**. `POST /api/ai/chat`
   tem duas implementações espelhadas: o middleware em `vite.config.ts` (dev) e
   a função serverless `api/ai/chat.ts` (produção/APK, endereçada por
   `VITE_AI_API_URL`). As duas compartilham `api/_lib/deepseek.ts` e recebem um
   contexto financeiro estruturado (nunca a base bruta). Se estiver offline ou o
   serviço falhar, o motor local de respostas (`services/ai.ts`) assume.

Nota: o modo `response_format: json_object` foi evitado de propósito — em
modelos anteriores ele devolvia respostas só com espaços em branco em prompts
longos. Pedimos JSON via prompt e aceitamos texto puro como fallback.

O estado real do pipeline do assistente, com as limitações confirmadas, está em
[docs/AI_CURRENT_STATE.md](docs/AI_CURRENT_STATE.md) e
[docs/AI_REGRESSION_MATRIX.md](docs/AI_REGRESSION_MATRIX.md).

### Real × mock × integração pendente

- **Real**: todos os cálculos, registros, metas, filtros e telas operam sobre dados
  persistidos localmente (localStorage, offline-first); análises via DeepSeek.
- **Mock**: modo demonstração (claramente sinalizado com selo "demo").
- **Integração pendente**: sincronização em nuvem (Supabase/PostgreSQL); em
  produção, o middleware de IA do dev server vira um endpoint equivalente no
  backend real. API keys nunca vão para o cliente, conforme a spec.
