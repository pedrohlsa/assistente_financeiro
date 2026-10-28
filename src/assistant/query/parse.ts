// PLANNER LOCAL — pergunta em pt-BR → `AssistantQueryPlan`.
//
// A diferença estrutural em relação a `resolveLocal()` não é o tamanho: é a
// COMPOSIÇÃO. Lá, cada pergunta era uma regex que reconhecia a frase inteira, e
// período × categoria × agrupamento × comparação × exclusão é um produto
// cartesiano que nenhuma cadeia de `if` cobre.
//
// Aqui cada DIMENSÃO é reconhecida sozinha:
//
//     comparação   ← "comparado com", "em relação a", "aumentou", "caiu"
//     período      ← query/period.ts
//     métrica      ← o verbo e o substantivo da pergunta
//     fonte        ← o assunto (parcela, fatura, meta, km, projeção…)
//     agrupamento  ← "por categoria", "qual mês", "qual cartão"
//     filtros      ← categoria, texto livre, origem, cartão, exclusão, dia
//
// CADA RECONHECEDOR CONSOME O TRECHO QUE USOU. Sem isso os reconhecedores se
// atropelam: "qual gasto eu faço com mais FREQUÊNCIA" saía com o filtro de
// texto `"frequencia"` (o extrator de alvo lia o "com ..." que a métrica já
// tinha usado) e devolvia "não tenho nenhum lançamento" para quem tinha
// centenas. É a mesma ideia da segmentação por cláusula: posição preservada,
// nada lido duas vezes.
//
// O que este módulo NÃO faz: responder. Ele devolve um PLANO, que ainda passa
// por `validateQueryPlan()` e só então é executado por `query/engine.ts`.

import type { AppState } from '../../models/types'
import { CATEGORY_KEYWORDS, usableCategories } from '../../data/categories'
import { addDays, fromISO, todayISO, toISO } from '../../utils/format'
import { normalizeName, sentenceCase } from '../../utils/text'
import { isDriver } from '../../services/profile'
import { buildPersonalModel, adaptiveEnabled } from '../personalModel'
import { pedeAntecipacaoDeFatura, pedeContaQueAperta, pedeContasAPagar, pedeContasFixas, pedeDividaTotal, pedeFimDoParcelamento, pedeListaDeParcelamentos, pedeQuantoPossoGastar, pedeLimite, pedeMaiorParcela, pedeSobraSemCombustivel, pedeReservaDeCaixa, pedeTotalGuardado, perguntaDeFatura, perguntaDeManutencao, planoDeGuardar } from '../cashQuestions'
import {
  currentMonthToDate, mesAFrente, monthPeriod, nextMonths, parseFutureMonth, parsePeriod, previousPeriod,
} from './period'
import type {
  AssistantQueryPlan, QueryField, QueryFilter, QueryGroup, QueryMetric,
  QueryOrder, QueryPeriod, QuerySource,
} from './types'
import { QUERY_DSL_VERSION } from './types'

export interface PlannedQuery {
  plan: AssistantQueryPlan
  /**
   * `high` = a frase traz algo que o roteador antigo comprovadamente não faz
   * (período fora das seis frases dele, agrupamento, comparação ou exclusão).
   * É o que autoriza a consulta a assumir a pergunta; com `medium` ela só entra
   * onde hoje sai o texto genérico de ajuda.
   */
  confidence: 'high' | 'medium'
  /** Trechos reconhecidos — entram na explicação "como você chegou nisso?". */
  recognized: string[]
  /**
   * Pedaço da pergunta que o planejador NÃO entendeu e que não é nome de nada
   * ("acima de 200 reais", "desde abril", "gasosa por km"). Com ele o plano
   * está INCOMPLETO: executá-lo responderia outra pergunta com número real. Quem
   * recebe isto não responde localmente — manda para quem sabe ler a frase.
   */
  incompleto?: string
  /** Pergunta específica que resolve uma ambiguidade sem chutar um número. */
  clarification?: { question: string; options: { label: string; value: string }[] }
  /**
   * Categoria que o HISTÓRICO dele associa ao nome procurado. Só é usada quando
   * a busca literal não acha nada — ver o comentário em `resolverCategoria`.
   */
  fallbackCategory?: string
  /**
   * O plano usa algo que o roteador antigo (`resolveLocal`) nao expressa. E o
   * unico caso em que a consulta toma a frente dele — ver `alemDoAntigo`.
   */
  beyondLegacy?: boolean
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Abreviações que o usuário REAL digita. */
const ABREV: [RegExp, string][] = [
  [/\bqnt[oa]?\b/g, 'quanto'], [/\bqto\b/g, 'quanto'], [/\bqnd\b/g, 'quando'],
  // "oq mais pesou" — sem esta troca o "oq" ficava de fora de todo padrão de
  // ranking e a pergunta virava o total do mês.
  [/\boq\b/g, 'o que'],
  [/\bq\b/g, 'que'], [/\bpq\b/g, 'porque'], [/\bvc\b/g, 'voce'],
  // "comparado cm semana passada": sem a troca o marcador de comparação não
  // casava e a semana passada virava o período principal.
  [/\bcm\b/g, 'com'],
  [/\bhj\b/g, 'hoje'], [/\bontm\b/g, 'ontem'], [/\bmsm\b/g, 'mesmo'],
  [/\bmt\b/g, 'muito'], [/\btbm?\b/g, 'tambem'], [/\bta[h]?\b/g, 'esta'],
  [/\bto[u]?\b/g, 'estou'], [/\bpra\b/g, 'para'], [/\bpro\b/g, 'para'],
  [/\bnd\b/g, 'nada'], [/\bmes?es\b/g, 'meses'],
  // "d obra" é "de obra": sem a preposição, o extrator de alvo não achava o
  // assunto da pergunta e a resposta vinha com o total de tudo.
  [/\bd\b/g, 'de'],
]

export function normalizeQuery(input: string): string {
  let t = semAcento(input).trim()
  for (const [re, sub] of ABREV) t = t.replace(re, sub)
  return t.replace(/\s{2,}/g, ' ')
}

// ---------------------------------------------------------------------------
// A frase é uma CONSULTA de dados?
// ---------------------------------------------------------------------------

const PEDE_DADO = [
  /\bquant[oa]s?\b/, /\bqual\b/, /\bquais\b/, /\bmedia\b/, /\bmediana\b/,
  /\bmaior\b/, /\bmenor\b/, /\bmelhor\b/, /\bpior\b/, /\bmais\b/, /\bmenos\b/,
  /\bcompar[ao]/, /\bdiferenca\b/, /\baument(?:ou|aram|o)\b/, /\bcai(?:u|ram)\b/,
  /\bsubiu\b/, /\bdesceu\b/, /\bcresceu\b/, /\bdiminuiu\b/, /\bpiorou\b/,
  /\bmelhorou\b/, /\bfrequen/, /\btotal\b/, /\bsoma\b/, /\bproporcao\b/,
  /\bporcentagem\b/, /\brepresent/, /\btirando\b/, /\bexceto\b/,
  // "Meu nubank tá pesando muito meu mês?" — a pergunta sobre PESO, que é como
  // se pergunta de verdade se uma dívida está atrapalhando. Nenhuma palavra de
  // medida aparece na frase, então ela caía em `resolveLocal`, que respondia o
  // resumo do mês inteiro: número certo, pergunta outra. E como nada do cartão
  // ficava no foco, o "e o inter" seguinte não tinha em que se apoiar.
  /\b(?:ta|esta|anda|vem)\s+(?:me\s+)?(?:pesando|apertando|matando|fudendo|acabando|estourando|quebrando|sufocando|comendo)\b/,
  /\bpesa(?:ndo)?\b/, /\bcomprometid/,
  // "Como tá a meta do notebook" pergunta o progresso de uma meta pelo nome.
  /\bcomo\s+(?:esta|vai|anda)\s+(?:a\s+|minha\s+)?metas?\s+d[aeo]s?\s+\w/,
  // "Gastei fora do normal esse mês?" não tem palavra de medida e caía na ajuda.
  /\b(?:fora|acima)\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:padrao|normal|comum|costume|media)\b/,
  // "Onde vazou meu dinheiro", "pra onde foi", "onde gastei": DESTINO do
  // dinheiro. Nenhuma palavra de medida aparece, e a frase nem chegava ao
  // planejador — o roteador antigo respondia o total, que diz QUANTO e não ONDE.
  /\b(?:para\s+)?a?onde\b/,
]

const NAO_E_CONSULTA = [
  // Cenário tem motor próprio: chegar aqui daria número REAL para hipótese.
  /\bse\s+eu\b/, /\bse\s+a\s+gente\b/, /\bsupondo\b/, /\be\s+se\b/,
  /\bestou\s+pensando\b/, /\bpretendo\b/, /\bvou\s+comprar\b/, /\bse\s+for\b/,
  // Explicação é local, determinística e tem módulo próprio.
  /\bpor\s*que\s+voce\b/, /\bo\s+que\s+voce\s+aprendeu\b/, /\bquantas\s+vezes\s+eu\s+fiz\s+isso\b/,
  // Meta do DIA ou do MÊS é a de lucro/guardar, que mora no roteador antigo —
  // não a meta de compra. "Quanto falta pra meta de hoje" respondia que não
  // havia meta de compra; "quanto falta pra bater a meta" procurava "bater a".
  /\bbat(?:er|i|eu|endo)\s+(?:a\s+)?(?:minha\s+)?meta\b/,
  /\bmeta\s+(?:de\s+hoje|do\s+dia|diaria|de\s+amanha|do\s+mes|deste\s+mes|desse\s+mes|mensal)\b/,
]

export function looksLikeDataQuestion(input: string): boolean {
  const t = normalizeQuery(input)
  if (NAO_E_CONSULTA.some(re => re.test(t))) return false
  // Caixa FUTURO: a DSL soma o passado, e estas perguntas olham o que ainda
  // vai vencer. O roteador antigo responde com `cashObligationsUntil()`.
  // Situação da fatura de agora ("quanto falta pagar da fatura") é o pendente
  // dela, não a dívida parcelada que a DSL somava.
  if (pedeReservaDeCaixa(t) || pedeContaQueAperta(t) || pedeTotalGuardado(t) || perguntaDeFatura(t) || pedeAntecipacaoDeFatura(t)
    || pedeContasAPagar(t) || planoDeGuardar(t) || perguntaDeManutencao(t)
    || pedeContasFixas(t) || pedeSobraSemCombustivel(t) || pedeLimite(t)
    || pedeFimDoParcelamento(t) || pedeMaiorParcela(t) || pedeDividaTotal(t) || pedeListaDeParcelamentos(t)
    || pedeQuantoPossoGastar(t)) return false
  return PEDE_DADO.some(re => re.test(t))
}

// ---------------------------------------------------------------------------
// Consumo de trechos
// ---------------------------------------------------------------------------

/** Texto que ainda não foi usado por nenhum reconhecedor. */
class Restante {
  constructor(public texto: string) {}
  /** Marca o trecho como usado. Substitui por espaço para não colar palavras. */
  consome(frag?: string) {
    if (!frag) return
    const i = this.texto.indexOf(frag)
    if (i < 0) return
    this.texto = `${this.texto.slice(0, i)} ${this.texto.slice(i + frag.length)}`.replace(/\s{2,}/g, ' ')
  }
}

/** Primeira regra da tabela que casa, com o trecho literal casado junto. */
function primeira<T>(t: string, tabela: [RegExp, T][]): { valor: T; matched: string } | null {
  for (const [re, valor] of tabela) {
    const m = t.match(re)
    if (m) return { valor, matched: m[0] }
  }
  return null
}

// ---------------------------------------------------------------------------
// Métrica
// ---------------------------------------------------------------------------

interface MetricaLida {
  metric: QueryMetric
  txType?: ('income' | 'expense' | 'saving')[]
  order?: QueryOrder
  limit?: number
  group?: QueryGroup
  label: string
}

const GASTO = /\bgast(?:ei|o|ou|ando|os?|ar)\b|\bpag(?:uei|o|ou|amento)\b|\btorr(?:ei|o)\b|\bdespesas?\b|\bsai(?:u|ram|da)\b|\bcustos?\b|\bcomprometid|\b(?:indo|vai|foi|vao)\s+(?:para|pra)\b/
/**
 * Verbos de GANHAR na boca de quem trabalha por conta. "Quanto estou fazendo
 * por hora", "quanto eu faço no sábado", "qual me dá mais" e "quanto tirei
 * hoje" são todas perguntas de RECEITA — sem elas, a pergunta do motorista
 * sobre o próprio ganho era respondida com o total de DESPESA, e o número
 * saía com cara de certo.
 */
// "Vou receber", "vai entrar", "quanto ganha": o futuro e o infinitivo também
// são entrada. Sem eles, "quanto vou receber esse mês" dava o total GASTO.
const ENTRADA = /\bganh(?:ei|o|ou|ar|a|amos)\b|\breceb(?:i|o|er|e|eu|emos|endo)\b|\bentr(?:ou|ada|adas|aram|ar|a|am)\b|\bfatur(?:ei|o|amento|ou)\b|\breceitas?\b|\brenda\b|\bvend(?:i|as?)\b|\brend(?:e|eu|imento)\b|\bfa(?:co|z(?:endo|er))\b|\bfiz\b|\btir(?:ei|o)\b|\bd[aá]\s+mais\b|\bme\s+d[aá]\b/
const GUARDADO = /\bguard(?:ei|o|ado|ar)\b|\bseparei\b|\breservei\b|\bpoupei\b/
const RESULTADO = /\blucr(?:ei|o|ou)\b|\bsobr(?:ou|a|as|ando)\b|\bliquido\b|\bresultado\b|\bmelhor\s+mes\b|\bpior\s+mes\b|\bmelhor\s+semana\b|\bpior\s+semana\b|\bmelhor\s+dia\b|\bpior\s+dia\b/

/**
 * "Qual cliente ME PAGOU mais", "quem me paga melhor": o dinheiro veio para o
 * usuário. `pagou` está em GASTO (e está certo lá: "quanto eu paguei"), então
 * sem esta leitura a pergunta virava um ranking de DESPESAS por origem.
 */
const ME_PAGOU = /\bme\s+pag(?:ou|aram|a|am|ava|avam)\b|\bpag(?:ou|aram)\s+(?:pra|para)\s+mim\b/

function tipoBaseDe(t: string): ('income' | 'expense' | 'saving')[] {
  if (ME_PAGOU.test(t)) return ['income']
  if (GUARDADO.test(t) && !GASTO.test(t)) return ['saving']
  if (ENTRADA.test(t) && !GASTO.test(t)) return ['income']
  return ['expense']
}

function lerMetrica(t: string): { valor: MetricaLida; matched: string } {
  // "Lucro por km" é (entrou − saiu) / km. Sem isto, `tipoBaseDe` não achava
  // verbo de receita em "lucro" e a conta virava DESPESA por km — um número
  // seis vezes menor, com a mesma cara de resposta certa.
  const tipo: ('income' | 'expense' | 'saving')[] =
    RESULTADO.test(t) && !GASTO.test(t) ? ['income', 'expense'] : tipoBaseDe(t)
  // Entrada menos saída dividida pela unidade: o rótulo diz que é LÍQUIDO,
  // senão "R$ 24,57 por viagem" se lê como o que a corrida paga.
  const porUnidade = tipo.length > 1 ? 'Líquido por ' : 'Por '
  const rotuloBase = tipo.length > 1 ? 'Resultado'
    : tipo[0] === 'income' ? 'Total recebido' : tipo[0] === 'saving' ? 'Total guardado' : 'Total gasto'

  const tabela: [RegExp, MetricaLida][] = [
    [/\b(?:com\s+)?(?:mais|maior)\s+frequencia\b|\bmais\s+frequente\b|\bque\s+(?:eu\s+)?mais\s+(?:faco|repito)\b/,
      { metric: 'count', txType: tipo, group: 'description', order: 'count-desc', limit: 5, label: 'Mais frequente' }],
    // "Quantas vezes eu fui no bar E QUANTO DEU": duas medidas. A soma
    // responde as duas — a resposta traz a contagem na linha da base —, e a
    // contagem sozinha deixava o "quanto deu" sem resposta.
    [/\bquantas?\s+vezes\b(?=.*\be\s+quanto\s+(?:deu|foi|gastei|saiu|custou|paguei)\b)/,
      { metric: 'sum', txType: tipo, label: rotuloBase }],
    [/\bquantas?\s+vezes\b|\bquantos?\s+(?:lancamentos|registros)\b/,
      { metric: 'count', txType: tipo, label: 'Quantidade' }],
    [/\bquantas?\s+parcelas\b/, { metric: 'count', txType: tipo, label: 'Parcelas' }],
    [/\brepresent\w*\b|\bporcentagem\b|\bproporcao\b|\bpercentual\b|\bquantos?\s*%/,
      { metric: 'share', txType: tipo, label: 'Participação' }],
    [/\bquanto\s+d[aeo]s?\s+(?:minhas?\s+|meus?\s+)?(?:receitas?|entradas?|renda|faturamento|ganhos)\b/,
      { metric: 'share', txType: tipo, label: 'Participação' }],
    [/\bmediana\b/, { metric: 'median', txType: tipo, label: 'Mediana' }],
    // A UNIDADE vem antes da média: "por corrida EM MÉDIA" é o valor por
    // corrida — o "em média" só reforça. Lido como média por LANÇAMENTO, o
    // "líquido por corrida" virava a média das receitas de corrida.
    [/\bpor\s+km\b|\bpor\s+quilometro\b|\bo\s+km\b|\bkm\s+sai\b/, { metric: 'per-km', txType: tipo, label: `${porUnidade}km` }],
    [/\bpor\s+hora\b|\ba\s+hora\b|\bhora\s+trabalhada\b/, { metric: 'per-hour', txType: tipo, label: `${porUnidade}hora` }],
    [/\bpor\s+(?:viagem|corrida)\b|\bcada\s+(?:viagem|corrida)\b/, { metric: 'per-trip', txType: tipo, label: `${porUnidade}viagem` }],
    // Hábito ("quanto COSTUMO gastar de suco por dia") é a pergunta que o
    // vocabulário aprendido responde, e fica antes do dia. Já "em média POR
    // DIA" pede o dia: lido como média, virava média por lançamento.
    [/\bnormalmente\b|\bcostum[oa]\b|\bgeralmente\b/, { metric: 'avg', txType: tipo, label: 'Média por lançamento' }],
    [/\bpor\s+dia\b|\bao\s+dia\b|\bdiari[oa]\b/, { metric: 'per-day', txType: tipo, label: `${porUnidade}dia` }],
    [/\b(?:em|na|por)\s+media\b|\bmedia\b/, { metric: 'avg', txType: tipo, label: 'Média por lançamento' }],
  ]

  const achou = primeira(t, tabela)
  if (achou) return achou

  if (RESULTADO.test(t) && !GASTO.test(t)) {
    return {
      valor: { metric: 'net', txType: ['income', 'expense'], label: 'Resultado' },
      matched: (t.match(RESULTADO) || [''])[0],
    }
  }
  const maior = t.match(/\bmaior\b|\bmais\s+car[oa]\b|\bmais\s+alt[oa]\b|\bpesou\s+mais\b/)
  if (maior) {
    return { valor: { metric: 'max', txType: tipo, order: 'value-desc', limit: 3, label: 'Maior valor' }, matched: maior[0] }
  }
  const menor = t.match(/\bmenor\b|\bmais\s+barat[oa]\b|\bmais\s+baix[oa]\b/)
  if (menor) {
    return { valor: { metric: 'min', txType: tipo, order: 'value-asc', limit: 3, label: 'Menor valor' }, matched: menor[0] }
  }
  return { valor: { metric: 'sum', txType: tipo, label: rotuloBase }, matched: '' }
}

// ---------------------------------------------------------------------------
// Fonte
// ---------------------------------------------------------------------------

interface FonteLida { source: QuerySource; field?: QueryField }

/** Nome escrito pelo usuário virando padrão de busca — regra 47. */
const escapaRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * "Parcelas da geladeira", "parcelamento do celular": o nome da compra depois
 * da parcela. Período ("do mês"), cartão ("do nubank") e fatura não são compra.
 * "Quanto falta DO computador" e "quanto ainda devo do computador" dizem o nome
 * do mesmo jeito; sem estes verbos o nome ficava sem leitor e a resposta somava
 * todos os parcelamentos como se fossem o computador.
 */
const ITEM_PARCELADO = /\b(?:parcelas?|parcelamentos?|prestac(?:ao|oes)|pagar|quitar|paguei|pagamos|quitei|faltam?|faltando|restam?|restando|devo|deve|devendo)\s+d[oa]s?\s+(?!(?:mes|meses|ano|semana|cartao|cartoes|fatura|faturas|total|valor|resto|restante|saldo|parcelas?|proxim[oa]s?|ultim[oa]s?|nubank|inter|itau|bradesco|santander|caixa|c6|next|pan|picpay|mercado\s+pago)\b)([a-z][a-z0-9\-]*(?:\s+(?!(?:e|ou|que|quanto|quantas?|esse|este|nesse|neste|ja|ainda|faltam?|faltando|restam?|restando|tem|tenho|pagar|paguei|pago|agora|hoje|ate|no|na|nos|nas|em|pelo|pela)\b)[a-z0-9][a-z0-9\-]*){0,2})/

function lerFonte(t: string, driver: boolean, metas: string[] = []): { valor: FonteLida; matched: string } | null {
  // "Quanto falta pra viagem?" — sem a palavra "meta". O usuário chama a meta
  // pelo NOME que ele mesmo deu, e é exatamente assim que se fala logo depois
  // de o app responder "Viagem — 80%". Sem esta leitura, "falta" caía em
  // parcelamento e a resposta era "você não tem parcelamentos em aberto com
  // viagem": específica, educada e sobre outra coisa.
  const meta = metas.find(n => new RegExp(`\\b${escapaRegex(n)}\\b`).test(t))
  if (meta && /\bfalta\b|\bfaltam\b|\bquanto\b|\bcomo\s+(?:ta|esta|vai)\b|\bperto\b/.test(t)) {
    // "Meta DO notebook": o artigo e a palavra "meta" saem junto com o nome.
    // Sobrando, "meta do" virava resíduo e a pergunta era recusada.
    const comMeta = t.match(new RegExp(String.raw`\b(?:(?:minha|a)\s+)?metas?\s+(?:d[aeo]s?\s+)?${escapaRegex(meta)}\b`))
    return { valor: { source: 'goals', field: 'remaining' }, matched: comMeta?.[0] || meta }
  }

  const tabela: [RegExp, FonteLida][] = [
    [/\bquantas?\s+parcelas\s+(?:faltam?|restam?|ainda)\b/, { source: 'installments' }],
    // A META vem ANTES de "quanto falta". "Quanto falta pra meta Moto?" caía em
    // parcelamento, e o app respondia "você não tem parcelamentos em aberto"
    // para quem perguntou por uma meta de compra que existe.
    [/\bmetas?\b(?!\s+(?:diaria|mensal|do\s+dia|do\s+mes))/, { source: 'goals', field: 'remaining' }],
    [/\bfalta\s+(?:pagar|quitar)\b|\bquanto\s+(?:ainda\s+)?falta\b/, { source: 'plans', field: 'remaining' }],
    // "Quanto ainda devo do computador": dívida de uma compra, não gasto do mês.
    [/\b(?:devo|devendo)\s+d[oa]s?\s+(?!(?:mes|meses|ano|semana|cartao|cartoes|fatura|faturas)\b)[a-z]/, { source: 'plans', field: 'remaining' }],
    [/\bparcelamentos?\b/, { source: 'plans', field: 'remaining' }],
    // "As parcelas DA GELADEIRA": a compra tem nome, e a pergunta é sobre o
    // parcelamento dela inteiro. Lido como "parcelas" soltas, a pergunta caía
    // no resumo dos cartões — o item sumia da resposta.
    [/\b(?:parcelas?|prestac(?:ao|oes))\s+d[oa]s?\s+(?!(?:mes|meses|ano|semana|cartao|cartoes|fatura|faturas|proxim[oa]s?|ultim[oa]s?)\b)[a-z]/,
      { source: 'plans', field: 'remaining' }],
    [/\bparcelas?\b/, { source: 'installments' }],
    [/\bfaturas?\b/, { source: 'invoices' }],
    [/\bprojecao\b|\bprevisao\b|\bproxim[oa]s?\s+meses\b|\bvai\s+(?:ficar|sobrar|pesar|apertar)\b|\bmes\s+mais\s+(?:pesado|apertado)\b/,
      { source: 'projections' }],
    [/\bcontas?\s+(?:fixas?|a\s+vencer|recorrentes?)\b|\bvencendo\b|\bvence\b/, { source: 'recurring' }],
  ]
  const achou = primeira(t, tabela)
  if (achou) return achou

  if (driver) {
    const dr: [RegExp, FonteLida][] = [
      [/\bquantos?\s+km\b|\bkm\s+(?:eu\s+)?rode[iu]\b|\bkm\s+(?:rodad|percorr)/, { source: 'work', field: 'km' }],
      [/\bquantas?\s+horas\b|\bhoras\s+(?:trabalhad|na\s+rua)/, { source: 'work', field: 'hours' }],
      [/\bquantas?\s+(?:viagens|corridas)\b/, { source: 'work', field: 'trips' }],
      [/\bsemana\s+(?:que\s+)?(?:eu\s+)?(?:mais\s+)?rode[iu]\b|\brode[iu]\s+mais\b/, { source: 'work', field: 'km' }],
      [/\blitros?\b|\bconsumo\b|\bkm\s*\/\s*l\b/, { source: 'fuel', field: 'liters' }],
    ]
    return primeira(t, dr)
  }
  return null
}

// ---------------------------------------------------------------------------
// Agrupamento
// ---------------------------------------------------------------------------

function lerGrupo(t: string, driver: boolean): { valor: QueryGroup; matched: string } | null {
  const tabela: [RegExp, QueryGroup][] = [
    [/\bdia\s+da\s+semana\b/, 'weekday'],
    // O "do mês" faz parte da expressão e precisa ser CONSUMIDO junto: sobrando
    // no texto, ele era lido como o período "este mês", e a pergunta comparava
    // as duas metades dentro de uma quinzena só.
    [/\bcomeco\s+ou\s+(?:no\s+)?(?:fim|final)(?:\s+d[oa]\s+mes)?\b|\b(?:fim|final)\s+ou\s+(?:no\s+)?comeco(?:\s+d[oa]\s+mes)?\b/, 'month-half'],
    [/\bpor\s+categoria\b|\bqual\s+categoria\b|\bque\s+categoria\b|\bem\s+que\s+categoria\b|\bcategorias?\b/, 'category'],
    // "Em cada mês" pede a lista: sem a forma, a pergunta virava o total deste mês.
    [/\bqual\s+mes\b|\bque\s+mes\b|\bpor\s+mes\b|\bmes\s+a\s+mes\b|\b(?:em\s+)?cada\s+mes\b|\bmes\s+mais\b|\bmelhor\s+mes\b|\bpior\s+mes\b|\bmeses\s+(?:eu\s+)?(?:tenho|vou)\b/, 'month'],
    [/\bqual\s+semana\b|\bpor\s+semana\b|\b(?:em\s+)?cada\s+semana\b|\bsemana\s+a\s+semana\b|\bmelhor\s+semana\b|\bpior\s+semana\b|\bsemana\s+(?:que\s+)?(?:eu\s+)?mais\b/, 'week'],
    [/\bqual\s+dia\b|\bmelhor\s+dia\b|\bpior\s+dia\b|\bdia\s+que\s+(?:eu\s+)?mais\b/, 'day'],
    [/\bqual\s+cartao\b|\bpor\s+cartao\b|\bcartao\s+(?:esta|mais)\b|\bqual\s+(?:dos\s+)?(?:meus\s+)?cartoes\b/, 'card'],
    [/\bqual\s+(?:casa|imovel|cliente|origem|fonte)\b|\bpor\s+(?:origem|imovel|cliente)\b/, 'origin'],
    [/\bqual\s+meta\b|\bpor\s+meta\b|\bmeta\s+(?:esta\s+)?mais\s+per/, 'goal'],
    // "O que mais aumentou?" pede um RANKING por categoria. Sem esta regra o
    // agrupamento ficava em `none`, a ordenação por diferença não tinha o que
    // ordenar e a resposta virava um total solto — que não responde "o quê".
    // "O que aumentou mais esse mês" diz o verbo antes do "mais"; sem esta
    // forma a pergunta comparava só os dois totais.
    [/\bo\s+que\s+(?:mais\s+)?(?:aumentou|subiu|cresceu|pesou|caiu|diminuiu|desceu)\b/, 'category'],
    // DISTRIBUIÇÃO: "onde vazou", "pra onde foi meu dinheiro", "onde gastei
    // mais". "Onde" pergunta pelo destino, e a resposta é um ranking por
    // categoria — não o total, que responde "quanto". "De onde" é a pergunta
    // contrária (de onde VEM o dinheiro) e fica de fora.
    [/(?<!\bde\s)\b(?:para\s+)?a?onde\b(?=[^?]*\b(?:gast\w*|vaz\w*|foi|foram|vai|sai\w*|pes\w*|escorr\w*|torr\w*|dinheiro|grana)\b)/, 'category'],
    // MUDANÇA: "maior mudança", "o que mais mudou". É comparação entre dois
    // períodos, ranqueada pela diferença — não o maior valor do mês.
    [/\bmaior(?:es)?\s+mudancas?\b|\bo\s+que\s+(?:mais\s+)?mudou\b|\bmudou\s+mais\b/, 'category'],
    // "Tem alguma coisa que eu tô gastando muito mais que antes?" é a mesma
    // pergunta dita do jeito que a pessoa fala. Sem agrupar, a resposta era o
    // total do mês — verdadeira e sem relação com o que foi perguntado.
    [/\btem\s+(?:alguma\s+coisa|algo|alguma)\b[^?]*\bmais\b/, 'category'],
    [/\bqual\s+despesa\b|\bqual\s+gasto\s+(?:esta|ta)\b/, 'category'],
    [/\bqual\s+(?:foi\s+)?(?:o\s+)?(?:meu\s+)?(?:maior|menor)\s+(?:gasto|despesa|compra|receita|entrada)\b|\bo\s+que\s+(?:eu\s+)?mais\s+(?:gasto|gastei)\b|\bqual\s+gasto\b/, 'description'],
  ]
  const achou = primeira(t, tabela)
  if (achou) return achou
  if (driver) {
    const dr: [RegExp, QueryGroup][] = [
      [/\bqual\s+plataforma\b|\bpor\s+plataforma\b|\buber\s+ou\s+(?:a\s+)?99\b|\b99\s+ou\s+(?:a\s+)?uber\b/, 'platform'],
    ]
    return primeira(t, dr)
  }
  return null
}

// ---------------------------------------------------------------------------
// Comparação
// ---------------------------------------------------------------------------

// O "que" só compara depois de um comparativo ("mais QUE o mês passado"). Solto,
// ele abre qualquer oração: "qnto q foi d obra nos ultimo 3 mes" tinha o período
// inteiro lido como o termo de COMPARAÇÃO, e a resposta vinha sobre este mês.
const MARCADOR_CMP = /\b(?:comparad[oa]\s+(?:com|ao|a)|comparando\s+com|compar[ao]\s+com|em\s+relacao\s+a[o]?|versus|vs|(?:mais|menos|maior|menor|melhor|pior)\s+(?:do\s+)?que)\s+(?:o\s+|a\s+|os\s+|as\s+)?([^?,.!]{2,40})/
/** Marca "comparado com o anterior": o período de comparação é o imediatamente anterior. */
const ANTERIOR = 'periodo-anterior'
// "Tô pior de gasolina?" pergunta por mudança, como "piorou": sem isto a
// resposta era só o total do mês.
// "Fora do meu padrão" é desvio do que ele costuma gastar — comparação, não a
// exclusão "fora o aluguel".
const FORA_DO_PADRAO = /\b(?:fora|acima)\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:padrao|normal|comum|costume|media)\b/
const CMP_IMPLICITA = /\b(?:fora|acima)\s+d[oa]\s+(?:meu\s+|minha\s+)?(?:padrao|normal|comum|costume|media)\b|\b(?:estou|esta|ando|anda|tou)\s+(?:pior|melhor)\s+(?:de|em|com|no|na)\b|\baument(?:ou|aram|o)\b|\bcai(?:u|ram)\b|\bsubiu\b|\bdesceu\b|\bcresceu\b|\bdiminuiu\b|\bpiorou\b|\bmelhorou\b|\bdiferenca\b|\bmudou\b|\bmudancas?\b|\bque\s+antes\b|\bdo\s+que\s+antes\b|\bmais\s+(?:do\s+)?que\s+(?:eu\s+)?(?:gastava|ganhava|fazia)\b/

/** "3 meses atrás" dentro de uma comparação = a MESMA janela, deslocada. */
function deslocaPeriodo(p: QueryPeriod, n: number, unidade: string): QueryPeriod {
  if (/^mes/.test(unidade)) {
    const a = fromISO(p.from), b = fromISO(p.to)
    const from = toISO(new Date(a.getFullYear(), a.getMonth() - n, a.getDate()))
    const to = toISO(new Date(b.getFullYear(), b.getMonth() - n, b.getDate()))
    return { from, to, label: `${n} ${n === 1 ? 'mês' : 'meses'} atrás`, grain: p.grain }
  }
  if (/^ano/.test(unidade)) {
    const a = fromISO(p.from), b = fromISO(p.to)
    return {
      from: toISO(new Date(a.getFullYear() - n, a.getMonth(), a.getDate())),
      to: toISO(new Date(b.getFullYear() - n, b.getMonth(), b.getDate())),
      label: `${n} ${n === 1 ? 'ano' : 'anos'} atrás`, grain: p.grain,
    }
  }
  const dias = /^semana/.test(unidade) ? n * 7 : n
  return {
    from: addDays(p.from, -dias), to: addDays(p.to, -dias),
    label: `${n} ${unidade} atrás`, grain: p.grain,
  }
}

// ---------------------------------------------------------------------------
// Alvo e exclusão
// ---------------------------------------------------------------------------

/** Palavras que nunca são o alvo — são estrutura da pergunta. */
const ESTRUTURAIS = new Set([
  'quanto', 'quantos', 'quantas', 'qual', 'quais', 'quando', 'onde', 'como',
  'eu', 'meu', 'minha', 'meus', 'minhas', 'o', 'a', 'os', 'as', 'um', 'uma',
  'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'com', 'por',
  // Interjeição de fala ("…mês passado HEIN") nunca é nome de nada.
  'hein', 'ne', 'viu', 'uai',
  'para', 'que', 'e', 'ou', 'mais', 'menos', 'muito', 'total', 'media', 'mediana',
  'mes', 'meses', 'semana', 'semanas', 'dia', 'dias', 'ano', 'anos', 'hoje',
  'ontem', 'passado', 'passada', 'este', 'esta', 'esse', 'essa', 'neste', 'nesse',
  'ultimos', 'ultimas', 'ultimo', 'ultima', 'proximo', 'proximos', 'atras',
  'gastei', 'gasto', 'gastos', 'gasta', 'paguei', 'recebi', 'ganhei', 'ganho',
  'faturei', 'lucrei', 'sobrou', 'sobra', 'guardei', 'guardado', 'foi', 'sao',
  'estou', 'tenho', 'tem', 'vou', 'ainda', 'ja', 'nao', 'sim', 'reais', 'valor',
  'dinheiro', 'realmente', 'mesmo', 'entao', 'agora', 'frequencia', 'frequente',
  'vezes', 'maior', 'menor', 'melhor', 'pior', 'comeco', 'inicio', 'fim', 'final',
  'consegui', 'costumo', 'normalmente', 'geralmente', 'representa', 'comprometido',
  'pesado', 'terminar', 'perto', 'faltam', 'falta', 'parcelas', 'parcela',
  'compras', 'comprei', 'categoria', 'categorias', 'aumentaram', 'aumentou',
  'caiu', 'cairam', 'despesas', 'despesa', 'receitas', 'receita', 'entradas',
  'renda', 'me', 'minhas', 'meus', 'cada', 'todos', 'toda', 'todas', 'algum',
])

const soUteis = (frase: string): string | undefined => {
  // Dígito único pode ser a parte que distingue uma entidade real: Casa 1 e
  // Casa 2. Removê-lo fazia "tirando a Casa 1" excluir todas as casas.
  const palavras = frase.trim().split(/\s+/).filter(w => (/^\d+$/.test(w) || w.length > 1) && !ESTRUTURAIS.has(w))
  return palavras.length ? palavras.join(' ') : undefined
}

const PARADA = String.raw`(?=\s*(?:\?|$|,|\.|!|\be\b|\bou\b|\bnos?\b|\bnas?\b|\bneste\b|\bnesse\b|\bem\b|\bcomparad|\bcompar|\bultim|\bpassad|\bmes\b|\bmeses\b|\bsemana\b|\bdia\b|\bano\b|\bhoje\b|\bontem\b|\bpor\b|\btirando\b|\bsem\b|\bexceto\b|\bquanto\b|\bqual\b))`

/**
 * O QUÊ da pergunta.
 *
 * Devolve DUAS leituras do mesmo trecho: `valor` sem as palavras de estrutura
 * (é ela que casa com nome de categoria) e `literal`, como o usuário escreveu
 * (é ela que procura no histórico). Guardar só a primeira quebrava a busca por
 * lugar: "no Zé DA esquina" virava "ze esquina", que não é substring de "Zé da
 * esquina" — e o lugar com três lançamentos aparecia como inexistente.
 */
/**
 * Vocabulário da PERGUNTA, não de lançamento. Um nome de lugar ("Zé da
 * esquina", "restaurante do Amarelo") nunca é feito disto; a sobra de uma
 * pergunta mal lida ("200 reais", "500 eu fiz desde", "ultima quinzena",
 * "gasosa rodado", "dezembro") sempre tem.
 */
const VOCABULARIO_DA_PERGUNTA = /\b(?:reais?|conto|contos|pila|desde|ate|ultim[ao]s?|quinzenas?|semanas?|fins?|mes|meses|dias?|anos?|rodad[oa]s?|acima|abaixo|maior(?:es)?|menor(?:es)?|eu|fiz|gastei|paguei|recebi|ganhei|mais|menos|hein|vezes|km|horas?|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/

/** A sobra do planejador é pedaço de pergunta que ele não entendeu? */
export function ehResiduo(literal: string): boolean {
  const t = normalizeName(literal)
  return /\d/.test(t) || VOCABULARIO_DA_PERGUNTA.test(t) || /(?:^|\s)(?:de|do|da|e|em|no|na)$/.test(t)
}

function extrairAlvo(t: string): { valor: string; literal: string; matched: string } | undefined {
  const m = t.match(new RegExp(String.raw`\b(?:com|de|em|no|na|nos|nas|para|pra)\s+([a-z0-9çãõáéíóúâêô][a-z0-9\s\-çãõáéíóúâêô]{1,40}?)${PARADA}`))
  if (!m) return undefined
  const valor = soUteis(m[1])
  if (!valor) return undefined
  // O trecho tem que ser MAJORITARIAMENTE conteúdo. "De onde vem mais dinheiro"
  // deixa uma palavra útil em quatro — e virava o filtro de texto
  // `"onde vem mais dinheiro"`, que não existe em lançamento nenhum e fazia o
  // app responder "não tenho nada com esse nome" a quem tem centenas.
  const total = m[1].trim().split(/\s+/).length
  const uteis = valor.split(/\s+/).length
  if (uteis * 2 < total) return undefined
  // A busca usa o LITERAL: a interjeição do fim da fala sai dele, senão "no bar
  // hein" procurava o texto "bar hein" e não achava nada.
  return { valor, literal: m[1].trim().replace(/(?:\s+(?:hein|ne|viu|uai))+$/, ''), matched: m[0] }
}

/**
 * Nome de categoria dito SOLTO, sem preposição: "meu combustível aumentou?",
 * "alimentação subiu?". Só entra quando nenhum alvo foi encontrado antes.
 */
function categoriaSolta(state: AppState, t: string, tipo: 'income' | 'expense'): { id: string; nome: string } | undefined {
  for (const c of usableCategories(state.categories || [])) {
    if (c.type !== tipo) continue
    const n = normalizeName(c.name)
    if (n.length < 4) continue
    if (new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(t)) return { id: c.id, nome: c.name }
  }
  // A palavra-chave da categoria dita solta: "obra 3 meses quanto". Só palavra
  // INTEIRA com quatro letras ou mais — termo curto ("bar", "app") casa em frase
  // demais — e só termo simples: radical como "gasolin" não é palavra dita.
  for (const [id, palavras] of Object.entries(CATEGORY_KEYWORDS)) {
    const c = usableCategories(state.categories || []).find(x => x.id === id && x.type === tipo)
    if (!c) continue
    for (const p of palavras) {
      const chave = normalizeName(p)
      if (chave.length < 4 || /\s/.test(chave)) continue
      // Radical longo no COMEÇO de uma palavra é a palavra dita: "minha
      // gasolina aumentou?" perdia o assunto porque o termo é "gasolin".
      const fim = chave.length >= 6 ? String.raw`[a-z]*(\s|$)` : String.raw`(\s|$)`
      const dita = t.match(new RegExp(`(^|\\s)${escapaRegex(chave)}${fim}`))
      if (dita) return { id: c.id, nome: dita[0].trim() }
    }
  }
  return undefined
}

/** Todas as categorias explicitamente ditas, na ordem da frase. */
function categoriasCitadas(
  state: AppState, t: string, tipo: 'income' | 'expense',
): { id: string; matched: string; at: number }[] {
  const achadas: { id: string; matched: string; at: number }[] = []
  const cats = usableCategories(state.categories || []).filter(c => c.type === tipo)
  for (const c of cats) {
    const candidatos = [c.name, ...(CATEGORY_KEYWORDS[c.id] || [])]
    let melhor: { matched: string; at: number } | undefined
    for (const nome of candidatos) {
      const n = normalizeName(nome)
      if (n.length < 4 || /\s/.test(n) && n.length < 6) continue
      const m = new RegExp(`(^|\\s)(${escapaRegex(n)})(?=\\s|$)`).exec(t)
      if (m && (!melhor || m.index < melhor.at)) melhor = { matched: m[2], at: m.index + m[1].length }
    }
    if (melhor) achadas.push({ id: c.id, ...melhor })
  }
  return achadas.sort((a, b) => a.at - b.at).filter((v, i, a) => a.findIndex(x => x.id === v.id) === i)
}

function extrairExclusao(t: string): { valor: string; matched: string } | undefined {
  // "Sem CONTAR o cimento", "sem considerar a obra": o verbo não é o que se
  // exclui. Sem pular o verbo, o texto excluído era "contar o cimento", que não
  // casa com nada — e o total saía igual, com cara de total sem o cimento.
  const m = t.match(new RegExp(String.raw`\b(?:tirando|sem|fora|exceto|desconsiderando|descontando)\s+(?:contar\s+|considerar\s+|incluir\s+|botar\s+|por\s+)?(?:o\s+|a\s+|os\s+|as\s+)?([a-z0-9çãõáéíóúâêô][a-z0-9\s\-çãõáéíóúâêô]{1,30}?)${PARADA}`))
  if (!m) return undefined
  const valor = soUteis(m[1])
  return valor ? { valor, matched: m[0] } : undefined
}

/** Lista explícita depois de “tirando/sem/exceto”: “Uber e 99”. */
function extrairExclusoes(t: string): { valores: string[]; matched: string } | undefined {
  const m = t.match(/\b(?:tirando|sem|fora|exceto|desconsiderando|descontando)\s+(?:contar\s+|considerar\s+|incluir\s+|botar\s+|por\s+)?(?:o\s+|a\s+|os\s+|as\s+)?(.+?)(?=\s+(?:quanto|qual|quais|o\s+que|esse|essa|este|esta|neste|nesta|nos\s+ultimos|nas\s+ultimas)\b|[?,.!]|$)/)
  if (!m || !/\s+(?:e|ou)\s+/.test(m[1])) return undefined
  const valores = m[1].split(/\s+(?:e|ou)\s+/).map(soUteis).filter((v): v is string => !!v)
  return valores.length > 1 ? { valores, matched: m[0] } : undefined
}

/** Substantivos de FONTE — os mesmos de `clauses.ts`, menos os que são categoria. */
const ORIGEM_NOUNS = 'casa|cliente|empresa|loja|apart(?:amento)?|kitnet|kitinete|sala|ponto|unidade|inquilin[oa]|contrato'

function extrairOrigem(t: string): { valor: string; matched: string } | undefined {
  const re = new RegExp(String.raw`\b(?:d?[ao]s?\s+)?((?:${ORIGEM_NOUNS})\s+([\w\d]+))`, 'i')
  const m = t.match(re)
  if (!m) return undefined
  // O identificador precisa identificar: número, ou palavra própria. Sem isso,
  // "quanto gastei em casa este mês" viraria a origem "casa este".
  const id = m[2]
  if (!/\d/.test(id) && (ESTRUTURAIS.has(id) || id.length < 3)) return undefined
  return { valor: m[1], matched: m[0] }
}

// ---------------------------------------------------------------------------
// Resolução de nomes contra os dados REAIS do usuário
// ---------------------------------------------------------------------------

/**
 * Resolve um nome para uma categoria REAL do usuário: o nome da categoria ou a
 * lista genérica de palavras-chave.
 *
 * O histórico pessoal fica FORA daqui de propósito. Registrar e consultar
 * puxam para lados opostos: no registro, saber que "Zé da esquina" é
 * Alimentação é exatamente o que se quer; na consulta, "quanto gastei no Zé da
 * esquina?" vira o total de Alimentação inteira — R$ 283,00 no lugar dos
 * R$ 83,00 que ele gastou lá. Quem pergunta por um LUGAR quer o lugar. O
 * aprendizado volta como SEGUNDA tentativa (`fallbackCategory`), só quando a
 * busca literal não achou nada — que é o caso do motorista que fala "suco" e
 * tem "Combustível" gravado na descrição.
 */
/**
 * A categoria que uma EXCLUSÃO tira. "Tirando cimento" com lançamentos chamados
 * Cimento tira o cimento: a lista genérica (cimento → Obra) tirava a categoria
 * inteira, com areia e tijolo junto. O nome da categoria ("tirando obra") e a
 * palavra que não nomeia lançamento nenhum ("tirando comida") continuam
 * tirando a categoria.
 */
function categoriaDaExclusao(state: AppState, valor: string, tipo: 'income' | 'expense'): string | undefined {
  const cat = resolverCategoria(state, valor, tipo)
  if (!cat) return undefined
  const alvo = normalizeName(valor)
  const nome = normalizeName((state.categories || []).find(c => c.id === cat)?.name)
  if (nome === alvo || (alvo.length >= 4 && (nome.includes(alvo) || alvo.includes(nome)))) return cat
  const palavra = new RegExp(`\\b${alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  return (state.transactions || []).some(x => palavra.test(normalizeName(x.description))) ? undefined : cat
}

function resolverCategoria(
  state: AppState, nome: string, tipo: 'income' | 'expense', lugar = false,
): string | undefined {
  const alvo = normalizeName(nome)
  if (!alvo) return undefined
  const cats = usableCategories(state.categories || []).filter(c => c.type === tipo)

  const exata = cats.find(c => normalizeName(c.name) === alvo)
  if (exata) return exata.id
  const parcial = cats.find(c => alvo.length >= 4
    && (normalizeName(c.name).includes(alvo) || alvo.includes(normalizeName(c.name))))
  if (parcial) return parcial.id
  // "Fui NO bar", "gastei NA padaria": com a preposição de lugar o usuário
  // nomeou um ESTABELECIMENTO, e a palavra da lista genérica não o transforma
  // na categoria inteira — "no bar" contando cinema, show e festa responde
  // outra pergunta. O nome da categoria dito por extenso continua valendo
  // (acima), e o histórico dele é a segunda tentativa (`categoriaAprendida`).
  if (lugar) return undefined

  for (const [id, palavras] of Object.entries(CATEGORY_KEYWORDS)) {
    if (!cats.some(c => c.id === id)) continue
    for (const p of palavras) {
      const chave = normalizeName(p)
      if (alvo !== chave && !alvo.includes(` ${chave}`) && !alvo.startsWith(`${chave} `)) continue
      // A palavra-chave só define a categoria quando ela é PRATICAMENTE todo o
      // alvo. "Restaurante do Amarelo" começa com "restaurante", mas o usuário
      // nomeou um lugar — responder com o total de Alimentação inteira é o
      // mesmo defeito de "Zé da esquina". Sobrando nome próprio, o filtro é de
      // TEXTO, e a categoria vira só a segunda tentativa.
      const resto = alvo.replace(chave, ' ').split(/\s+/).filter(w => w.length > 2 && !FUNCIONAIS_ALVO.has(w))
      if (!resto.length) return id
    }
  }
  return undefined
}

/** Palavras que não acrescentam identidade a um alvo ("mercado DO bairro"). */
const FUNCIONAIS_ALVO = new Set([
  'do', 'da', 'dos', 'das', 'de', 'no', 'na', 'nos', 'nas', 'em', 'com',
  'meu', 'minha', 'seu', 'sua', 'esse', 'essa', 'este', 'esta', 'todo', 'toda',
])

/** Categoria que o HISTÓRICO dele associa a este nome. Só como segunda tentativa. */
function categoriaAprendida(
  state: AppState, nome: string, tipo: 'income' | 'expense', hoje: string,
): string | undefined {
  if (!adaptiveEnabled(state)) return undefined
  const p = buildPersonalModel(state, hoje).categoryFor(nome, tipo)
  return p && (p.strength === 'strong' || p.strength === 'overriding') ? p.value : undefined
}

/** Cartões citados pelo nome, entre os que o usuário tem. */
function cartoesCitados(state: AppState, t: string): string[] {
  const out: string[] = []
  for (const c of state.cards || []) {
    if (c.archived) continue
    const n = normalizeName(c.name)
    if (n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) out.push(c.name)
  }
  return out
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export interface PlanContext { today?: string }

/** Janela padrão quando o agrupamento pede várias fatias e ninguém disse quando. */
function janelaParaGrupo(group: QueryGroup, hoje: string): QueryPeriod | null {
  const d = fromISO(hoje)
  switch (group) {
    case 'month':
      return { from: toISO(new Date(d.getFullYear(), d.getMonth() - 5, 1)), to: hoje, label: 'nos últimos 6 meses', grain: 'month' }
    case 'week':
      return { from: addDays(hoje, -83), to: hoje, label: 'nas últimas 12 semanas', grain: 'week' }
    case 'day':
      return { from: addDays(hoje, -29), to: hoje, label: 'nos últimos 30 dias', grain: 'day' }
    case 'weekday':
      return { from: addDays(hoje, -59), to: hoje, label: 'nos últimos 60 dias', grain: 'day' }
    case 'month-half':
      return { from: toISO(new Date(d.getFullYear(), d.getMonth() - 2, 1)), to: hoje, label: 'nos últimos 3 meses', grain: 'month' }
    default:
      return null
  }
}

/**
 * Estado ATUAL (meta, parcelamento): não é recorte de tempo, é "tudo que vale".
 * Ainda assim precisa caber no teto de `validateQueryPlan` — um intervalo de
 * vinte anos era recusado por `period-too-long` e a pergunta morria com um erro
 * técnico que não dizia nada ao usuário.
 */
const janelaAberta = (hoje: string): QueryPeriod =>
  ({ from: addDays(hoje, -1800), to: addDays(hoje, 1800), label: 'até agora', grain: 'range' })

export function planQuery(state: AppState, input: string, ctx: PlanContext = {}): PlannedQuery | null {
  const hoje = ctx.today || todayISO()
  const t0 = normalizeQuery(input)
  if (!looksLikeDataQuestion(input)) return null

  const driver = isDriver(state.settings)
  const recognized: string[] = []
  const rest = new Restante(t0)
  const periodoVago = /\b(?:nos?\s+)?ultimos\s+meses\b/.test(t0)
  const inicioSemData = /\bdesde\s+que\s+(?:eu\s+)?(?:comecei|iniciei|abri|entrei)\b/.test(t0)
  let entidadesAmbiguas = false

  // ---- 1) comparação: consumida ANTES do período ------------------------
  // "comparando com mês passado" tem um período dentro dela. Sem consumir esse
  // trecho primeiro, ele era lido como o período PRINCIPAL — e a pergunta
  // comparava o mês passado com ele mesmo.
  let textoComparacao: string | undefined
  /** "Gasolina comparado com o mês passado": o assunto vem sem preposição. */
  let sujeitoDaComparacao: string | undefined
  // "Compara julho com junho" traz os dois períodos na mesma construção;
  // o marcador genérico só entende "comparado com junho".
  const doisMeses = t0.match(/\bcompar[ao]\s+((?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+20\d{2})?)\s+com\s+((?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+20\d{2})?)\b/)
  const periodoComparadoDireto = doisMeses ? parsePeriod(doisMeses[1], hoje)?.period : undefined
  const marcador = doisMeses ? null : t0.match(MARCADOR_CMP)
  if (doisMeses && periodoComparadoDireto && parsePeriod(doisMeses[2], hoje)) {
    textoComparacao = doisMeses[2]
    rest.consome(doisMeses[0])
  } else if (marcador && parsePeriod(marcador[1], hoje)) {
    textoComparacao = marcador[1]
    rest.consome(marcador[0])
    sujeitoDaComparacao = soUteis(t0.slice(0, marcador.index))
  } else if (marcador && /^(?:o\s+|a\s+)?(?:passad[oa]|anterior)\s*$/.test(marcador[1].trim())) {
    // "Comparado com o passado" / "com a anterior": o período imediatamente
    // anterior ao principal. Sem período legível a frase saía da consulta e
    // virava o resumo do mês, que não compara nada.
    textoComparacao = ANTERIOR
    rest.consome(marcador[0])
  }
  const pedeComparacao = !!textoComparacao || CMP_IMPLICITA.test(t0)
  // Consumido aqui para o leitor de exclusão não ler "fora do meu padrão" como
  // "exceto padrão" — virava o filtro `excludeText: "padrao"`.
  const desvio = t0.match(FORA_DO_PADRAO)
  if (desvio) rest.consome(desvio[0])

  // ---- 1b) denominador da proporção, consumido ANTES do verbo ------------
  // "quanto DAS MINHAS RECEITAS está indo para combustível" tem dois lados: o
  // denominador ("receitas") e o numerador ("combustível"). Deixar o
  // denominador no texto fazia o leitor de verbo classificar a pergunta inteira
  // como receita — e a resposta era 100%, aritmeticamente impecável e inútil.
  const baseProporcao = t0.match(/\bd[aeo]s?\s+(?:minhas?\s+|meus?\s+)?(?:receitas?|entradas?|renda|faturamento|ganhos)\b/)
  if (baseProporcao) rest.consome(baseProporcao[0])

  // ---- 2/3/4) métrica, fonte e agrupamento -------------------------------
  // Os três LEEM o mesmo texto (sem a comparação, que já saiu) e cada um
  // consome o trecho que usou. Detectar em cadeia estragava o vizinho: a
  // métrica consumia "maior" e o agrupamento não reconhecia mais "qual foi meu
  // maior gasto" — a pergunta perdia o "por lançamento" e devolvia só um número
  // solto, sem dizer QUAL foi o gasto.
  const base = rest.texto
  const metrica = lerMetrica(base)
  const fonteLida = lerFonte(base, driver, (state.goals || [])
    .filter(g => !g.done)
    .map(g => normalizeName(g.name))
    .filter(n => n.length >= 3))
  const grupoLido = lerGrupo(base, driver)

  rest.consome(metrica.matched)
  if (metrica.matched) recognized.push(metrica.matched.trim())
  if (fonteLida) { rest.consome(fonteLida.matched); recognized.push(fonteLida.matched.trim()) }
  if (grupoLido) { rest.consome(grupoLido.matched); recognized.push(grupoLido.matched.trim()) }

  let source: QuerySource = fonteLida?.valor.source || 'transactions'
  let group: QueryGroup = grupoLido?.valor || metrica.valor.group || 'none'
  let metric: QueryMetric = metrica.valor.metric

  // O denominador foi consumido lá em cima, então a frase deixou de conter o
  // "das minhas receitas" que sinalizava proporção. O sinal veio junto — é ele
  // que manda, e não o texto que já não existe mais.
  if (baseProporcao) {
    if (metric === 'sum') { metric = 'share'; metrica.valor.label = 'Participação' }
    // O NUMERADOR é o que sobrou da frase. "Quanto das minhas receitas está
    // INDO PARA combustível" mede uma saída; "quanto a Casa 1 representa da
    // minha renda" mede uma entrada. Sem separar os dois, consumir "da minha
    // renda" deixava a segunda sem verbo nenhum e ela virava despesa — a Casa 1
    // aparecia como "sem lançamento" para quem recebe dela todo mês.
    if (metric === 'share' && !GUARDADO.test(base)) {
      metrica.valor.txType = GASTO.test(base) ? ['expense'] : ['income']
    }
  }

  // "qual mês foi o pior?" sem verbo de dinheiro pergunta pelo RESULTADO do
  // mês, não pelo total gasto. Com verbo explícito ("qual mês gastei mais") o
  // que ele disse manda — o usuário sempre ganha do palpite.
  const semVerbo = !GASTO.test(base) && !ENTRADA.test(base) && !GUARDADO.test(base)
  // "Tô melhor que semana passada?" é a mesma pergunta sem ranking: melhor no
  // RESULTADO. Lida como gasto, a resposta comparava despesas.
  // O marcador da comparação já saiu de `base`; a construção é lida na frase.
  // "E comparado com semana passada", sem verbo nem assunto, também é "como
  // estou indo": sobra só palavra de estrutura e de período.
  // "Compara julho com junho" é outra construção, com contrato próprio (gasto).
  const soComparacao = !!marcador && !!textoComparacao && !base
    .replace(/\b(?:e|eu|estou|esta|como|foi|ficou|meu|minha|o|a|os|as|de|do|da|em|no|na|nesse|neste|essa|esse|esta|este|mes|semana|hoje|ano|dia|entao|ai|hein|ne)\b/g, '')
    .replace(/[?!.,\s]+/g, '')
  const melhorQue = pedeComparacao && (soComparacao
    || /\b(?:melhor|pior)\s+(?:do\s+)?que\b|\bcomo\s+(?:foi|esta|anda|vai|ficou)\b/.test(t0))
  if (semVerbo && metric === 'sum' && (melhorQue || (/\b(?:melhor|pior)\b/.test(base)
    && (group === 'month' || group === 'week' || group === 'day')))) {
    metric = 'net'
    metrica.valor.txType = ['income', 'expense']
    metrica.valor.label = 'Resultado'
  }

  // Dois cartões citados numa pergunta é comparação entre eles, não filtro por
  // um: "nubank ou inter, qual tá mais pesado?".
  const cartoes = cartoesCitados(state, rest.texto)
  if (cartoes.length > 1) group = 'card'

  // Agrupar por cartão em `transactions` não devolve nada: lançamento não tem
  // cartão (regra 10 — compra parcelada não vira Transaction). A fonte certa é
  // a dívida ou a fatura, e qual delas depende do que se perguntou.
  if (group === 'card' && source === 'transactions') {
    source = /\bcomprometid|\bpesad|\bdivida|\bdevo\b|\bdevendo\b|\bfalta\b/.test(t0) ? 'plans' : 'invoices'
  }
  // Plataforma (Uber, 99, inDrive) é de onde o dinheiro VEM. Sem verbo de gasto
  // explícito, "uber ou 99, qual me dá mais?" é pergunta de receita — comparar
  // as duas pelo que se GASTA nelas não responde nada.
  if (group === 'platform') {
    source = 'transactions'
    if (!GASTO.test(t0)) metrica.valor.txType = ['income']
  }

  // "Quanto vou pagar DE CARTÃO em dezembro": o cartão em geral, sem nome, é a
  // fatura. Em lançamentos ele virava a busca pelo texto "cartao".
  const cartaoGeral = source === 'transactions' && cartoes.length === 0
    && /\b(?:pagar|pago|pagando|vence|vencem|vou\s+pagar)\b/.test(t0)
    ? rest.texto.match(/\b(?:de|no|em|com|nos)\s+(?:meus?\s+)?cart(?:ao|oes)\b/) : null
  if (cartaoGeral) {
    source = 'invoices'
    rest.consome(cartaoGeral[0])
  }
  // "Pra pagar", "a pagar", "vence" descrevem a parcela e a fatura, não um
  // nome. Sobrando, viravam a busca por "para pagar", e a resposta dizia que
  // não havia nada — ou mandava cadastrar um cartão a quem tem dois.
  if (source === 'installments' || source === 'invoices' || source === 'plans') {
    for (const m of rest.texto.match(/\b(?:(?:para|pra|a)\s+pagar|vencem|vence|vencendo|vencer)\b/g) || []) rest.consome(m)
  }

  // ---- 5) período --------------------------------------------------------
  const lido = parsePeriod(rest.texto, hoje)
  let period: QueryPeriod
  let periodoExplicito = false

  if (source === 'projections') {
    const futuro = parseFutureMonth(rest.texto, hoje)
    // O mês lido é CONSUMIDO: sobrando no texto, "dezembro" virava o alvo da
    // busca e a projeção procurava lançamentos chamados "dezembro".
    if (futuro) {
      const mesDito = rest.texto.match(/\b(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b(?:\s+de\s+20\d{2})?/)
      if (mesDito) rest.consome(mesDito[0])
    }
    const nMeses = rest.texto.match(/\bproxim[oa]s?\s+(\d{1,2})\s+meses\b/)
    period = futuro || nextMonths(nMeses ? Math.min(Number(nMeses[1]), 12) : 6, hoje)
    periodoExplicito = !!futuro || !!nMeses
    if (group === 'none') group = 'month'
  } else if (source === 'goals' || source === 'plans') {
    period = janelaAberta(hoje)
  } else if (lido || periodoComparadoDireto) {
    period = lido?.period || periodoComparadoDireto!
    if (lido && (source === 'invoices' || source === 'installments')) period = mesAFrente(lido, t0, hoje) || period
    else if (lido && source === 'transactions') period = mesAFrente(lido, t0, hoje, true) || period
    periodoExplicito = true
    if (lido) { rest.consome(lido.span ?? lido.matched); recognized.push(lido.matched) }
    // “Caiu ou subiu desde junho?” pede a série desde o marco dito, não uma
    // janela anterior inventada com a mesma duração.
    if (/^desde\s/.test(period.label) && pedeComparacao && group === 'none') group = 'month'
  } else {
    // "qual dos próximos meses eu tenho mais parcelas": parcela REAL, janela
    // futura. Sem isto a resposta olhava só o mês corrente e dizia "1 parcela".
    const futuroPedido = /\bproxim[oa]s?\s+meses\b|\bqual\s+(?:dos\s+)?(?:proximos\s+)?meses\b|\bmeses\s+(?:eu\s+)?(?:tenho|vou)\b|\bmes\s+mais\s+(?:pesado|apertado)\b/.test(t0)
    if (futuroPedido) {
      period = nextMonths(6, hoje)
      group = group === 'none' ? 'month' : group
      periodoExplicito = true
    } else {
      // "quanto eu gasto EM MÉDIA com mercado" é pergunta sobre hábito, não
      // sobre o mês corrente: três lançamentos não descrevem costume nenhum.
      const habito = (metric === 'avg' || metric === 'median') && group === 'none'
      period = janelaParaGrupo(group, hoje)
        || (habito ? { from: addDays(hoje, -89), to: hoje, label: 'nos últimos 90 dias', grain: 'day' as const } : currentMonthToDate(hoje))
      if (habito) periodoExplicito = true
      if (group === 'month' || group === 'week' || group === 'day' || group === 'weekday' || group === 'month-half') {
        // Janela ampliada por causa do agrupamento: perguntar "qual mês foi o
        // pior" olhando só o mês atual devolveria um ranking de um item só.
        periodoExplicito = true
      }
    }
  }

  // Receita futura vem do calendário de recorrências, nunca do realizado.
  const previsaoDeReceita = source === 'transactions' && metrica.valor.txType?.length === 1
    && metrica.valor.txType[0] === 'income'
    && (/\b(?:vou|vamos|vai|vao|irei|ira)\s+(?:receber|entrar|ganhar)\b/.test(t0)
      || !!period.future && !/\b(?:recebi|ganhei|entrou|entraram|faturei)\b/.test(t0))
  let previsaoNoPassado = false
  if (previsaoDeReceita) {
    source = 'recurring'
    // "Esta semana" é retrospectiva para receita realizada, mas a previsão
    // precisa de sete dias a partir de hoje; recortar a janela passada em hoje
    // deixava só um dia e ocultava vencimentos de amanhã.
    if (lido?.matched === 'esta semana' && period.to === hoje) {
      period = { ...period, from: hoje, to: addDays(hoje, 6), label: 'nos próximos 7 dias', future: true }
    }
    if (period.to === hoje && (period.grain === 'month' || period.grain === 'year')) {
      const h = fromISO(hoje)
      const fim = period.grain === 'year' ? `${h.getFullYear()}-12-31`
        : toISO(new Date(h.getFullYear(), h.getMonth() + 1, 0))
      period = { ...period, to: fim, label: period.grain === 'year' ? 'até o fim deste ano' : 'até o fim deste mês' }
    }
    previsaoNoPassado = period.to < hoje
    if (!previsaoNoPassado) period = { ...period, from: period.from < hoje ? hoje : period.from, future: true }
  }

  // ---- 6) período de comparação ------------------------------------------
  let comparePeriod: QueryPeriod | undefined
  if (pedeComparacao) {
    if (textoComparacao && textoComparacao !== ANTERIOR) {
      const atras = textoComparacao.match(/(\d{1,3})\s+(dias?|semanas?|mes(?:es)?|anos?)\s+atras/)
      if (atras) comparePeriod = deslocaPeriodo(period, Number(atras[1]), atras[2])
      else comparePeriod = parsePeriod(textoComparacao, hoje)?.period
    }
    if (!comparePeriod) comparePeriod = previousPeriod(period)
    // "Comparado com a semana passada" sem período principal dito compara com
    // ESTA semana. O padrão era o mês corrente, e a resposta punha 27 dias de
    // gasto contra 7 — "+861%" sobre períodos de tamanhos diferentes.
    if (comparePeriod && !periodoExplicito && group === 'none' && comparePeriod.grain !== period.grain) {
      const mesmoTamanho = comparePeriod.grain === 'week' ? 'nos ultimos 7 dias'
        : comparePeriod.grain === 'day' ? 'hoje' : comparePeriod.grain === 'year' ? 'este ano' : undefined
      const atual = mesmoTamanho ? parsePeriod(mesmoTamanho, hoje)?.period : undefined
      if (atual) period = atual
    }
    if (comparePeriod) recognized.push(`comparação com ${comparePeriod.label}`)
  }

  // ---- 7) filtros --------------------------------------------------------
  const filter: QueryFilter = {}
  if (previsaoDeReceita) filter.plannedOnly = true
  if (source === 'transactions' || source === 'recurring') {
    filter.txType = metric === 'net' ? ['income', 'expense'] : metrica.valor.txType
  }
  const tipoAlvo: 'income' | 'expense' = filter.txType?.[0] === 'income' ? 'income' : 'expense'

  const excluirLista = extrairExclusoes(rest.texto)
  const excluir = excluirLista ? undefined : extrairExclusao(rest.texto)
  if (excluirLista) {
    rest.consome(excluirLista.matched)
    const cats = excluirLista.valores.map(v => categoriaDaExclusao(state, v, tipoAlvo))
    const cards = excluirLista.valores.map(v => cartoesCitados(state, v)[0])
    const plataformas = driver && excluirLista.valores.every(v => /^(?:uber|99|indrive|in\s*drive)$/.test(normalizeName(v)))
    if (plataformas) filter.excludeTexts = excluirLista.valores
    else if (cats.every((v): v is string => !!v)) filter.excludeCategories = [...new Set(cats)]
    else if (cards.every((v): v is string => !!v)) filter.excludeCardNames = [...new Set(cards)]
    else filter.excludeTexts = excluirLista.valores
    recognized.push(`sem ${excluirLista.valores.join(', ')}`)
  } else if (excluir) {
    rest.consome(excluir.matched)
    const cartao = cartoesCitados(state, excluir.valor)[0]
    const cat = cartao ? undefined : categoriaDaExclusao(state, excluir.valor, tipoAlvo)
    if (cartao) filter.excludeCardNames = [cartao]
    else if (cat) filter.excludeCategories = [cat]
    else filter.excludeText = excluir.valor
    recognized.push(`sem ${excluir.valor}`)
  }

  const origem = extrairOrigem(rest.texto)
  const origens = [...rest.texto.matchAll(new RegExp(String.raw`\b(?:d?[ao]s?\s+)?((?:${ORIGEM_NOUNS})\s+[\w\d]+)`, 'gi'))]
    .map(m => ({ valor: m[1], matched: m[0] }))
    .filter((v, i, a) => a.findIndex(x => normalizeName(x.valor) === normalizeName(v.valor)) === i)
  if (origens.length > 1) {
    for (const o of origens) rest.consome(o.matched)
    filter.origins = origens.map(o => o.valor)
    group = 'origin'
    recognized.push(`origens ${origens.map(o => o.valor).join(', ')}`)
  } else if (origem) {
    rest.consome(origem.matched)
    filter.origin = origem.valor
    recognized.push(`origem ${origem.valor}`)
  }

  // Meta citada pelo nome. Sem isto, "quanto falta pra viagem" devolvia a soma
  // de TODAS as metas ("Metas até agora: R$ 4.000,00"), que é uma resposta que
  // ninguém pediu e some com a meta perguntada no meio das outras.
  if (source === 'goals') {
    const alvo = (state.goals || []).find(g => !g.done && normalizeName(g.name).length >= 3
      // `t0`, não `rest.texto`: quem detectou a fonte já consumiu o nome da
      // meta, e procurar no que sobrou nunca acharia nada.
      && new RegExp(`\\b${escapaRegex(normalizeName(g.name))}\\b`).test(t0))
    if (alvo) {
      filter.goalName = alvo.name
      recognized.push(`meta ${alvo.name}`)
      rest.consome(normalizeName(alvo.name))
    }
  }

  const semExcluidos = cartoes.filter(c => !filter.excludeCardNames?.includes(c))
  if (semExcluidos.length === 1 && group !== 'card') {
    filter.cardNames = semExcluidos
    recognized.push(`cartão ${semExcluidos[0]}`)
    rest.consome(normalizeName(semExcluidos[0]))
  }

  // O plural é como se pergunta de um período inteiro: "nos FINS de semana dos
  // últimos 60 dias". Sem ele, "fins de" sobrava e virava texto de busca, e o
  // app afirmava que não havia lançamento nenhum.
  const FIM_DE_SEMANA = /\bf(?:im|ins)\s+de\s+semana\b|\bfina(?:l|is)\s+de\s+semana\b|\bsabado\s+e\s+domingo\b/
  if (FIM_DE_SEMANA.test(rest.texto)) {
    filter.weekdays = [0, 6]
    rest.consome((rest.texto.match(FIM_DE_SEMANA) || [''])[0])
    recognized.push('fim de semana')
  } else if (/\bdias?\s+uteis\b|\bdurante\s+a\s+semana\b/.test(rest.texto)) {
    filter.weekdays = [1, 2, 3, 4, 5]
    recognized.push('dias úteis')
  }

  if (group !== 'month-half') {
    const meia = rest.texto.match(/\b(?:comeco|inicio|primeira\s+(?:metade|quinzena))\s+(?:d[oa]\s+)?mes\b/)
      || rest.texto.match(/\b(?:segunda\s+(?:metade|quinzena))\s+(?:d[oa]\s+)?mes\b/)
    if (meia) {
      filter.monthHalf = /comeco|inicio|primeira/.test(meia[0]) ? 'first' : 'second'
      rest.consome(meia[0])
      recognized.push(filter.monthHalf === 'first' ? 'começo do mês' : 'fim do mês')
    }
  }

  if (driver && group !== 'platform') {
    const plat = rest.texto.match(/\b(uber|99|indrive|in\s*drive)\b/)
    if (plat) {
      filter.platform = /in\s*drive/.test(plat[1]) ? 'inDrive' : plat[1]
      rest.consome(plat[0])
      recognized.push(`plataforma ${filter.platform}`)
      // Plataforma é de onde o dinheiro VEM (a mesma regra do agrupamento por
      // plataforma): "uber comparado com semana passada" procurava gasto na
      // Uber e respondia que não havia lançamento.
      if (!GASTO.test(t0) && filter.txType?.length === 1 && filter.txType[0] === 'expense') {
        filter.txType = ['income']
        if (metrica.valor.label === 'Total gasto') metrica.valor.label = 'Total recebido'
      }
    }
  }

  // O alvo é o ÚLTIMO: ele lê o que sobrou depois de todo o resto ter tirado
  // a sua parte.
  const categorias = categoriasCitadas(state, rest.texto, tipoAlvo)
  if (categorias.length > 1) {
    filter.categories = categorias.map(c => c.id)
    for (const c of categorias) rest.consome(c.matched)
    const separadas = /\bou\b|\bseparad[oa]s?\b|\bqual\b[^?]*\b(?:mais|menos|maior|menor)\b/.test(t0)
    if (separadas) {
      group = 'category'
      if (!metrica.valor.order) metrica.valor.order = 'value-desc'
    }
    const juntas = /\bjunt[oa]s?\b|\bsomad[oa]s?\b|\bao\s+todo\b|\btotal\b/.test(t0)
    entidadesAmbiguas = !separadas && !juntas
    recognized.push(`categorias ${categorias.map(c => c.id).join(', ')}`)
  }
  // Sem preposição o leitor de alvo não via o assunto, que sumia da consulta:
  // "gasolina comparado com o mês passado" comparava TODOS os gastos.
  const sujeito = sujeitoDaComparacao && !filter.categories?.length && !filter.origin
    && new RegExp(`(?:^|\\s)${escapaRegex(sujeitoDaComparacao)}(?:\\s|$)`).test(rest.texto)
    ? { valor: sujeitoDaComparacao, literal: sujeitoDaComparacao, matched: sujeitoDaComparacao } : undefined
  const alvo = extrairAlvo(rest.texto) || sujeito
  let fallbackCategory: string | undefined
  let incompleto: string | undefined = previsaoNoPassado ? 'recebimento futuro em período que já terminou'
    : periodoVago ? 'últimos meses — quantos meses?' : undefined
  // "No CARTÃO nubank": com o cartão já reconhecido, a palavra repete o que foi
  // lido e não filtra nada. Virava texto de busca "cartao", e o app mandava
  // cadastrar um cartão que existe.
  const repeteCartao = !!alvo && (filter.cardNames?.length || filter.excludeCardNames?.length)
    && /^cart(?:ao|oes)$/.test(normalizeName(alvo.valor))
  if (alvo && repeteCartao) {
    rest.consome(alvo.matched)
  } else if (alvo && ehResiduo(alvo.literal)) {
    // Sobra que é pedaço da PERGUNTA, não nome de lugar: o plano ficou
    // incompleto. Filtrar por esse texto afirmava "não tenho lançamento" ou
    // "R$ 0,00 (dado real)" sobre uma pergunta que ninguém entendeu.
    rest.consome(alvo.matched)
    incompleto = alvo.literal
  } else if (alvo) {
    rest.consome(alvo.matched)
    const cat = resolverCategoria(state, alvo.valor, tipoAlvo, /^(?:no|na|nos|nas)\s/.test(alvo.matched.trim()))
    if (cat) {
      filter.categories = [cat]
      recognized.push(`categoria ${alvo.valor}`)
    } else {
      // A busca vai pelo LITERAL que o usuário escreveu, não pela versão
      // podada — ver o comentário em `extrairAlvo`.
      filter.text = alvo.literal
      // Segunda tentativa, só se a busca literal não achar nada, e SÓ com
      // evidência no histórico dele: o motorista que fala "suco" tem
      // "Combustível" gravado na descrição.
      //
      // A lista genérica de palavras-chave NÃO entra aqui. Ela transformaria
      // "quanto gastei no Restaurante do Amarelo?" — um lugar que não existe no
      // histórico — no total de Alimentação inteira, que é o mesmo defeito do
      // "Zé da esquina" pelo outro lado. Sem o lugar, a resposta certa é dizer
      // que não há lançamento com esse nome.
      fallbackCategory = categoriaAprendida(state, alvo.valor, tipoAlvo, hoje)
      recognized.push(`texto "${alvo.literal}"`)
    }
  } else if (source === 'transactions' && !filter.origin && !filter.origins) {
    const solta = categoriaSolta(state, rest.texto, tipoAlvo)
    if (solta) {
      filter.categories = [solta.id]
      rest.consome(normalizeName(solta.nome))
      recognized.push(`categoria ${solta.nome}`)
    }
  }

  // A reserva É o tipo `saving`, não uma categoria: o depósito pode estar em
  // qualquer uma (o legado gravava "Outros"), e é assim que a resposta de
  // "quanto tenho na reserva" conta. Filtrada pela categoria, "quanto guardei
  // na reserva" dizia "não tenho lançamento" para quem guardou R$ 500,00 no
  // mês, e "mandei pra reserva" ainda virava gasto.
  const naReserva = source === 'transactions' && !!filter.categories?.includes('reserva')
  if (naReserva) {
    filter.categories = filter.categories!.filter(c => c !== 'reserva')
    if (!filter.categories.length) delete filter.categories
    filter.txType = ['saving']
    metrica.valor.label = metrica.valor.label.replace(/^Total (?:gasto|recebido|guardado)\b/, 'Guardado na reserva')
  }

  if (source === 'installments' && /\bfaltam?\b|\brestam?\b|\bpendentes?\b|\bem\s+aberto\b/.test(t0)) {
    filter.status = ['pending']
    // Parcela que FALTA é toda a que ainda vai vencer, não a deste mês. Sem
    // ampliar a janela, "quantas parcelas faltam?" respondia "1".
    if (!periodoExplicito) {
      period = { from: hoje, to: addDays(hoje, 1095), label: 'daqui para a frente', grain: 'range', future: false }
    }
  }
  // Cartão citado (incluído ou excluído) em `transactions` não filtra nada:
  // lançamento não carrega cartão. A pergunta é sobre dívida ou fatura.
  if (source === 'transactions' && (filter.cardNames?.length || filter.excludeCardNames?.length)) {
    source = /\bcomprometid|\bpesad|\bdivida|\bdevo\b|\bdevendo\b|\bfalta\b|\bparcelad/.test(t0) ? 'plans' : 'invoices'
    delete filter.txType
    if (source === 'plans') period = janelaAberta(hoje)
  }
  if (source === 'goals' && !/\bconclui|\bterminad|\btodas\b/.test(t0)) filter.status = ['open']

  // A compra citada pelo nome ("parcelas da geladeira") é o filtro do
  // parcelamento. Cartão com esse nome já foi lido acima e não é compra.
  // "Quanto já paguei do computador": o nome é de um PARCELAMENTO cadastrado.
  // Sem um plano com esse nome, "paguei do aluguel" continua sendo lançamento.
  if (source === 'transactions' && !filter.text && !filter.categories?.length) {
    const pago = t0.match(/\b(?:paguei|pagamos|quitei)\s+d[oa]s?\s+([a-z][a-z0-9-]*)/)
    const nome = pago ? normalizeName(pago[1]) : ''
    if (nome && (state.installmentPlans || []).some(p => p.status !== 'cancelled'
      && normalizeName(p.description).split(/\s+/).includes(nome))) {
      source = 'plans'
      delete filter.txType
      if (!periodoExplicito) period = janelaAberta(hoje)
    }
  }
  const itemParcelado = (source === 'plans' || source === 'installments') && !filter.text ? t0.match(ITEM_PARCELADO) : null
  if (itemParcelado && cartoesCitados(state, itemParcelado[1]).length) {
    // "As parcelas do <cartão que ele batizou>": é o cartão, lido acima — a
    // pergunta continua sendo sobre as parcelas dele, como sempre foi.
    if (fonteLida && /^(?:parcelas?|prestac)/.test(fonteLida.matched.trim())) {
      source = 'installments'
      fonteLida.valor = { source: 'installments' }
    }
  } else if (itemParcelado) {
    // "Quantas parcelas faltam do computador": a contagem é do PARCELAMENTO
    // citado. Parcela solta não carrega o nome da compra.
    if (source === 'installments') {
      source = 'plans'
      delete filter.status
      if (!periodoExplicito) period = janelaAberta(hoje)
    }
    filter.text = itemParcelado[1].trim()
    rest.consome(itemParcelado[0])
    recognized.push(`parcelamento "${filter.text}"`)
  }

  // Média agrupada por mês é a média dos TOTAIS mensais (ver `runQuery`), não
  // por lançamento — o rótulo antigo dizia uma coisa e o número outra.
  if (metric === 'avg' && group === 'month' && metrica.valor.label === 'Média por lançamento') metrica.valor.label = 'Média'

  // ---- 8) campo e ordem --------------------------------------------------
  let field: QueryField = fonteLida?.valor.field
    || (source === 'goals' ? 'remaining' : source === 'plans' ? 'remaining'
      : source === 'projections' ? projField(t0) : 'amount')
  if (source === 'goals' && /\bmais\s+per|\bperto\s+de\s+terminar|\bfalta\s+menos\b|\bquase\b/.test(t0)) field = 'pct'
  if (source === 'plans' && /\bquantas\s+parcelas\b/.test(t0)) {
    field = 'remainingCount'
    // "Quantas" pede a SOMA das parcelas restantes. Contar linhas respondia
    // "1" — o número de parcelamentos — para quem tem cinco parcelas a pagar.
    if (metric === 'count') metric = 'sum'
  }
  // "Quanto eu JÁ PAGUEI da geladeira": o que saiu, não o que falta. Na
  // fatura também: "quanto paguei de fatura esse ano" dava o faturado.
  if ((source === 'plans' || source === 'invoices') && /\b(?:ja\s+)?(?:paguei|pagamos|quitei)\b/.test(t0) && !/\bfalta\b|\bfaltam\b/.test(t0)) field = 'paid'
  // A meta também: "quanto DEPOSITEI na viagem" é o que já foi guardado. A
  // resposta dava o que falta (R$ 1.200,00 de uma meta com R$ 4.800,00 dentro).
  if (source === 'goals' && field === 'remaining' && !/\bfalta\b|\bfaltam\b/.test(t0)
    && /\b(?:depositei|depositamos|coloquei|colocamos|guardei|guardamos|juntei|juntamos|poupei|economizei|mandei|botei|pus|transferi|acumulei)\b|\bja\s+(?:tenho|foi)\b|\btenho\s+(?:guardado|juntado)\b/.test(t0)) field = 'saved'
  if (source === 'goals' && field === 'saved' && lido) {
    period = lido.period
    periodoExplicito = true
  }
  // "Qual o valor das minhas metas" é o alvo, não o que falta.
  if (source === 'goals' && field === 'remaining' && !/\bfalta\b|\bfaltam\b/.test(t0)
    && /\bvalor\s+(?:total\s+)?d[ao]s?\s+(?:minhas?\s+)?metas?\b|\bquanto\s+(?:e|sao|custa|custam)\s+(?:a|as)\s+(?:minhas?\s+)?metas?\b/.test(t0)) field = 'target'

  let order: QueryOrder | undefined = metrica.valor.order
  if (comparePeriod && group !== 'none') {
    // "Gastando muito mais que antes" e "fora do meu padrão" pedem o que mais
    // SUBIU. Lidas pelo "mais" solto, viravam o maior gasto do mês.
    if (/\baument(?:ou|aram|o)\b|\bsubiu\b|\bcresceu\b|\bpiorou\b|\bpesou\s+mais\b|\bmudancas?\b|\bmudou\b|\bmais\s+(?:do\s+)?que\s+antes\b|\bgastando\s+(?:muito\s+)?mais\b/.test(t0)
      || FORA_DO_PADRAO.test(t0)) {
      order = 'delta-desc'
      // "Qual foi a MAIOR mudança": o "maior" é da diferença, não do
      // lançamento. Sem isto a métrica virava `max` e a resposta era o maior
      // valor do mês — número real, pergunta outra.
      if (metric === 'max') metric = 'sum'
    }
    else if (/\bcai(?:u|ram)\b|\bdiminuiu\b|\bdesceu\b|\bmelhorou\b|\bbaixou\b/.test(t0)) order = 'delta-asc'
  }
  if (!order && group !== 'none') {
    // "Pior" e "melhor" invertem de sentido conforme o que se está medindo: o
    // pior mês de RESULTADO é o menor, o pior mês de GASTO é o maior. Tratar os
    // dois igual respondia "o maior foi junho" para "qual mês foi o pior?".
    const olhaParaCima = metric === 'net' || filter.txType?.[0] === 'income' || filter.txType?.[0] === 'saving'
    if (/\bpior\b/.test(t0)) order = olhaParaCima ? 'value-asc' : 'value-desc'
    else if (/\bmelhor\b/.test(t0)) order = olhaParaCima ? 'value-desc' : 'value-asc'
    else if (source === 'goals' && field === 'pct') order = 'value-desc'
    else if (source === 'goals' && field === 'remaining') order = 'value-asc'
    else if (/\bmaior\b|\bmais\b/.test(t0)) order = 'value-desc'
    else if (/\bmenor\b|\bmenos\b/.test(t0)) order = 'value-asc'
  }

  const shareBase: AssistantQueryPlan['shareBase'] = baseProporcao ? 'income' : 'same'

  const plan: AssistantQueryPlan = {
    version: QUERY_DSL_VERSION,
    source, field, period, comparePeriod, filter,
    metric,
    group, order,
    limit: metrica.valor.limit || (group === 'none' ? 1 : 8),
    shareBase,
    // Sobra repetida ou não entendida não é assunto: "Faturas - cartao do
    // Nubank" repetia no rótulo a palavra que o filtro já tinha descartado.
    label: rotulo(metrica.valor, repeteCartao || incompleto || naReserva ? undefined : alvo?.valor, filter, state, source, field),
  }

  const confidence: PlannedQuery['confidence'] =
    (periodoExplicito || !!comparePeriod || group !== 'none' || !!excluir || !!excluirLista
      || metric === 'share' || metric === 'median'
      || source === 'plans' || source === 'projections' || source === 'goals'
      || !!filter.weekdays || !!filter.monthHalf || !!filter.origin || !!filter.origins?.length)
      ? 'high' : 'medium'

  return {
    plan, confidence, recognized, fallbackCategory,
    beyondLegacy: alemDoAntigo(plan, !!lido || !!periodoComparadoDireto,
      /\bpor\s+lancamentos?\b/.test(t0)),
    ...(periodoVago ? {
      clarification: {
        question: 'Quando você diz “últimos meses”, quer olhar quantos meses?',
        options: [
          { label: '3 meses', value: '3 meses' },
          { label: '6 meses', value: '6 meses' },
          { label: '12 meses', value: '12 meses' },
        ],
      },
    } : inicioSemData ? {
      clarification: {
        question: 'Não tenho uma data confiável para esse começo. A partir de qual mês ou data você quer calcular?',
        options: [],
      },
    } : entidadesAmbiguas ? {
      clarification: {
        question: 'Você quer o total dessas categorias juntas ou cada uma separada?',
        options: [
          { label: 'Total juntas', value: 'juntas' },
          { label: 'Separadas', value: 'separadas' },
        ],
      },
    } : {}),
    ...(incompleto ? { incompleto } : {}),
  }
}

/**
 * Períodos que `periodFromText()` (o roteador antigo, em `src/services/ai.ts`)
 * sabe produzir. São SEIS, e qualquer outra coisa caía no default dele —
 * "últimos 7 dias" — respondendo a pergunta errada com cara de certa.
 */
const PERIODOS_ANTIGOS = new Set([
  'hoje', 'ontem', 'este mês', 'no mês passado', 'nos últimos 7 dias', 'na semana passada',
])

/** O assunto é o app, não um lugar: cartão, fatura, parcela, conta, meta, saldo. */
const VOCABULARIO_DO_APP = /^(?:(?:meu|minha|meus|minhas|o|a|os|as)\s+)?(?:cart(?:ao|oes)|faturas?|parcel(?:a|as|amentos?)|contas?|metas?|saldo|limite|reserva)$/

/**
 * Agrupamentos que `resolveLocal()` não sabe montar de jeito nenhum.
 *
 * `description`, `card`, `platform` e `day` ficam de FORA de propósito: para
 * essas perguntas ele tem resposta própria e boa ("de onde vem mais dinheiro,
 * Uber ou 99?" é respondida pelo ritmo do motorista, medido no histórico dele).
 * Tomar a frente ali trocaria uma resposta melhor por uma pior.
 */
const GRUPOS_NOVOS = new Set(['category', 'month', 'week', 'weekday', 'month-half', 'origin', 'goal', 'plan'])

/**
 * O plano usa algo que o roteador antigo COMPROVADAMENTE não expressa?
 *
 * Este é o gate que decide quem responde, e ele é ESTREITO de propósito.
 * `resolveLocal()` continua dono das perguntas que já respondia — são elas que
 * o corpus assegura, frase por frase, e várias delas (o ritmo do motorista, o
 * hábito medido no vocabulário do usuário) são MELHORES que uma consulta
 * genérica. Alargar este gate sem rodar o corpus é a maneira mais rápida de
 * trocar uma resposta boa por uma pior.
 *
 * `periodoDito` é a distinção que faltava: só conta o período que o USUÁRIO
 * disse. As janelas que o planner deriva sozinho (90 dias para hábito, 6 meses
 * para agrupar por mês) não provam nada sobre o roteador antigo — foi assim que
 * "quanto eu costumo gastar de suco por dia?" deixou de ser respondida pelo
 * histórico dele e virou uma média genérica.
 */
function alemDoAntigo(plan: AssistantQueryPlan, periodoDito: boolean, porLancamento: boolean): boolean {
  // (A) Período dito e fora das seis frases do roteador antigo. Este é o caso
  // em que ele responde a pergunta errada com cara de certa.
  if (periodoDito && !PERIODOS_ANTIGOS.has(plan.period.label)) return true
  // (B) Estruturas que ele não tem como expressar.
  if (plan.comparePeriod) return true
  if (GRUPOS_NOVOS.has(plan.group)) return true
  const f = plan.filter
  if (f.excludeCategories?.length || f.excludeText || f.excludeTexts?.length || f.excludeCardNames?.length) return true
  if (f.weekdays?.length || f.monthHalf || f.origin || f.origins?.length) return true
  if (plan.metric === 'share' || plan.metric === 'median') return true
  // O roteador antigo trata "média por lançamento" como nome de despesa.
  // Hábito de um item nomeado continua com ele (ex.: suco por dia).
  if (plan.metric === 'avg' && porLancamento && !f.text) return true
  if (plan.source === 'plans' || plan.source === 'projections') return true
  if (plan.source === 'recurring' && plan.filter.plannedOnly) return true
  // O que foi PAGO nas faturas: o roteador antigo só tem o resumo dos cartões.
  if (plan.source === 'invoices' && plan.field === 'paid') return true
  // (C) Pergunta sobre UM cartão. O roteador antigo responde o mês inteiro —
  // certo como número, errado como resposta, e sem deixar o cartão no foco.
  if (f.cardNames?.length) return true
  // (D) Nome dito NESTA pergunta. O total antigo de "quanto gastei" não tem
  // filtro nenhum: "no Restaurante do Amarelo" era ignorado e a resposta era o
  // total da semana inteira, com "(dado real)". Filtro que ele não aplica é
  // pergunta que ele não sabe responder. O hábito fica com ele: "quanto eu
  // costumo gastar de suco" é lido no vocabulário do usuário, e é melhor lá.
  // Palavra do PRÓPRIO app ("de cartão", "da fatura") não é nome dito pelo
  // usuário: para ela o roteador antigo tem resposta dedicada.
  if (f.text && plan.metric !== 'avg' && !VOCABULARIO_DO_APP.test(normalizeName(f.text))) return true
  // (E) As contas "por viagem" e "por hora" do roteador antigo são FIXAS: os
  // últimos 7 dias, e por viagem é a receita BRUTA. "Líquido por corrida esse
  // mês" recebia a receita bruta da semana — outra conta, com cara de certa.
  if (plan.metric === 'per-trip' || plan.metric === 'per-hour') {
    if (periodoDito && plan.period.label !== 'nos últimos 7 dias') return true
    if (plan.metric === 'per-trip' && (f.txType?.length || 0) > 1) return true
  }
  return false
}

function projField(t: string): QueryField {
  if (/\bentradas?\b|\breceitas?\b|\brenda\b/.test(t)) return 'incomes'
  if (/\bsaldo\b|\bsobrar\b|\bvai\s+sobrar\b/.test(t)) return 'balance'
  if (/\bcontas?\b/.test(t)) return 'bills'
  if (/\bliquido\b|\bresultado\b/.test(t)) return 'net'
  return 'installments'
}

/** Rótulos por fonte: "Total gasto" não descreve uma fatura nem uma meta. */
const ROTULO_FONTE: Partial<Record<QuerySource, string>> = {
  installments: 'Parcelas',
  invoices: 'Faturas',
  plans: 'Falta pagar',
  goals: 'Metas',
  recurring: 'Contas previstas',
  projections: 'Projecao',
  work: 'Trabalho',
  fuel: 'Combustivel',
  maintenance: 'Manutencao',
}

function rotulo(
  m: MetricaLida, alvo: string | undefined, filter: QueryFilter,
  state: AppState, source: QuerySource, field: QueryField,
): string {
  // "Falta pagar" em cima do que JÁ FOI pago é o número certo com o nome do
  // outro: o parcelamento tem três campos, e o rótulo diz qual deles é.
  const base = source === 'transactions'
    ? m.label
    : field === 'pct' ? 'Progresso das metas'
      : source === 'plans' && field === 'paid' ? 'Já pago'
        : source === 'invoices' && field === 'paid' ? 'Pago nas faturas'
        : source === 'plans' && field === 'total' ? 'Valor total'
          // "Falta pagar: 8" parecia R$ 8; é a QUANTIDADE de parcelas.
          : source === 'plans' && field === 'remainingCount' ? 'Parcelas restantes'
          // "Metas: R$ 4.000,00" não dizia se é o que falta ou o que já tem.
          : source === 'goals' && field === 'remaining' ? 'Falta para as metas'
          : source === 'goals' && field === 'saved' ? 'Guardado nas metas'
          : source === 'goals' && field === 'target' ? 'Valor das metas'
          : source === 'recurring' && filter.txType?.length === 1 && filter.txType[0] === 'income' ? 'Entradas previstas'
          : ROTULO_FONTE[source] || m.label
  const cat = filter.categories?.length
    ? (state.categories || []).find(c => c.id === filter.categories![0])?.name
    : undefined
  // O texto buscado chega sem acento (a pergunta é normalizada); o rótulo usa a
  // grafia dos próprios lançamentos — "Zé da esquina", não "Ze da esquina".
  const comoEle = (texto: string) => {
    const k = normalizeName(texto)
    const x = (state.transactions || []).find(t => normalizeName(t.description) === k || normalizeName(t.origin) === k)
    return x ? (normalizeName(x.description) === k ? x.description! : x.origin!) : sentenceCase(texto)
  }
  const nome = cat || (filter.origin ? comoEle(filter.origin) : undefined)
    || (filter.text ? comoEle(filter.text) : undefined) || alvo
  // Filtro que MUDA o número tem que aparecer no texto. "Total recebido na
  // semana passada: R$ 1.433" somava só a Uber, e "Total gasto nos últimos 60
  // dias: R$ 3.340" só os fins de semana — número certo, lido como outro.
  const extras: string[] = []
  if (filter.platform) extras.push(`na ${/^uber$/i.test(filter.platform) ? 'Uber' : filter.platform}`)
  const dias = (filter.weekdays || []).join(',')
  if (dias === '0,6') extras.push('nos fins de semana')
  else if (dias === '1,2,3,4,5') extras.push('nos dias úteis')
  // A exclusão também muda o número: "tirando cimento" respondia "Total gasto
  // este mês", lido como o gasto do mês inteiro.
  // Cartão é nome próprio e fica como foi cadastrado; o resto vai em minúscula.
  const fora = [
    ...[
      ...(filter.excludeCategories || []).map(id => (state.categories || []).find(c => c.id === id)?.name || id),
      ...(filter.excludeText ? [filter.excludeText] : []), ...(filter.excludeTexts || []),
    ].map(v => v.trim().toLowerCase()),
    ...(filter.excludeCardNames || []),
  ]
  if (fora.length) extras.push(`sem ${fora.length > 1 ? `${fora.slice(0, -1).join(', ')} e ${fora[fora.length - 1]}` : fora[0]}`)
  const cabeca = nome ? `${base} - ${nome}` : base
  return extras.length ? `${cabeca} ${extras.join(' ')}` : cabeca
}

export { previousPeriod, parsePeriod, monthPeriod }
