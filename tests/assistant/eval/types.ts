// TIPOS DA AVALIAÇÃO SEMÂNTICA DOS MODELOS REMOTOS.
//
// O gabarito é ESTRUTURADO de propósito. "Veio JSON válido" não diz nada sobre
// um modelo: dois modelos podem devolver envelopes perfeitos e um deles
// transformar "vou gastar 80" em despesa. Cada caso declara o que uma resposta
// CERTA contém, campo a campo, e o que ela nunca pode conter.

export type Suite = 'chat' | 'plano' | 'cenario' | 'continuidade'
export type PerfilEval = 'autonomo' | 'motorista' | 'clt' | 'other' | 'novo'

/**
 * Onde a frase é resolvida HOJE em produção, medido sem rede (orquestrador real
 * com os dois caminhos remotos substituídos por gravadores).
 *
 * `local-errada` é a frase que nunca chega ao modelo porque o motor local
 * responde — e responde errado. Ela entra no corpus para medir o que o modelo
 * faria SE fosse consultado: é base para uma decisão de ROTEAMENTO, não para a
 * escolha de modelo, e o relatório separa as duas coisas.
 */
export type RotaProducao = 'remota' | 'local' | 'local-errada'

export type Dimensao =
  | 'linguagem' | 'consulta-nova' | 'plano-complexo' | 'cenario-complexo'
  | 'continuidade' | 'ambiguidade' | 'seguranca' | 'perfil' | 'modalidade' | 'utilidade'

// ---------------------------------------------------------------------------
// Valores esperados
// ---------------------------------------------------------------------------

export type Primitivo = number | string | boolean

/**
 * `null` dentro de `umDe` significa "campo ausente também é aceito".
 * `ausente` exige que o campo NÃO venha. `qualquer` não confere.
 */
export type Esperado<T = Primitivo> =
  | T
  | { umDe: (T | null)[] }
  | { ausente: true }
  | { qualquer: true }

export const umDe = <T>(...valores: (T | null)[]): { umDe: (T | null)[] } => ({ umDe: valores })
export const AUSENTE: { ausente: true } = { ausente: true }
export const QUALQUER: { qualquer: true } = { qualquer: true }

// ---------------------------------------------------------------------------
// Chat — contrato de produção (`handleAssistantRequest`, passo 16)
// ---------------------------------------------------------------------------

export interface AcaoOuro {
  kind: string
  /**
   * Só os campos listados são conferidos. Valor, total, parcelas, data, origem
   * e cartão são ESTRITOS e errar qualquer um deles numa ação aceita é perigo.
   * Categoria e descrição contam para a acurácia de campo, não para perigo.
   */
  campos: Record<string, Esperado>
}

export type IntencaoChat = 'registrar' | 'registrar-e-responder' | 'perguntar' | 'responder'

export type TipoViolacao = 'alegacao-falsa' | 'contaminacao' | 'vazamento' | 'julgamento' | 'fato-errado'

export interface Violacao { re: RegExp; tipo: TipoViolacao }

export interface OuroChat {
  intencao: IntencaoChat | { umDe: IntencaoChat[] }
  /** Conjunto EXATO. `[]` = nenhuma ação é a resposta certa. */
  acoes: AcaoOuro[]
  /**
   * Outros conjuntos igualmente certos. Existe para a ambiguidade honesta:
   * "acho que gastei uns 190" admite perguntar OU propor os 190 — nunca propor
   * outro valor. Vale o conjunto que deixa MENOS perigo.
   */
  alternativas?: AcaoOuro[][]
  /** Tipos que nunca podem aparecer. Aceito pelo app = perigo máximo. */
  tiposProibidos?: string[]
  /** Quando a resposta certa é perguntar: sobre o quê. */
  perguntaSobre?: RegExp
  /** Uma resposta ÚTIL menciona pelo menos um destes. */
  deveMencionar?: RegExp[]
  proibidoNaResposta?: Violacao[]
  /**
   * Números que uma resposta correta pode DERIVAR do contexto, além dos que já
   * estão nele (sempre permitidos). Declarados caso a caso: liberar soma e
   * diferença de todos os pares tornaria a medição inútil — com 38 números no
   * contexto, 89% dos valores inventados passavam (regra 53 do CLAUDE.md).
   */
  derivados?: (contexto: any) => number[]
  /** O contexto enviado permite uma resposta útil? É o denominador da taxa de genérico. */
  respondivel?: boolean
}

// ---------------------------------------------------------------------------
// Planejador de consulta — contrato de produção (`task: 'plan-query'`)
// ---------------------------------------------------------------------------

export interface Intervalo { from: string; to: string }

export type PeriodoOuro =
  /** Cada intervalo aceito é EXATO. Mais de um só quando a frase é ambígua de verdade. */
  | { exatos: (hoje: string) => Intervalo[] }
  /** Frase vaga ("considerando os últimos meses"): regra objetiva em canonical.ts. */
  | { regra: 'recente' }
  | { qualquer: true }

export interface FiltroOuro {
  txType?: Esperado<string[]>
  categories?: Esperado<string[]>
  excludeCategories?: Esperado<string[]>
  text?: Esperado<string>
  excludeText?: Esperado<string>
  origin?: Esperado<string>
  cardNames?: Esperado<string[]>
  excludeCardNames?: Esperado<string[]>
  goalName?: Esperado<string>
  platform?: Esperado<string>
  weekdays?: Esperado<number[]>
  monthHalf?: Esperado<string>
  minAmount?: Esperado<number>
  maxAmount?: Esperado<number>
  status?: Esperado<string[]>
  realizedOnly?: Esperado<boolean>
  plannedOnly?: Esperado<boolean>
}

export interface PlanoOuro {
  source: Esperado<string>
  field?: Esperado<string>
  metric?: Esperado<string>
  group?: Esperado<string>
  order?: Esperado<string>
  limit?: Esperado<number>
  shareBase?: Esperado<string>
  periodo: PeriodoOuro
  /** Ausente no gabarito = a comparação tem que estar AUSENTE no plano. */
  comparacao?: PeriodoOuro | { presente: true }
  /**
   * Filtro que o gabarito não lista tem que vir AUSENTE. Acrescentar um valor
   * mínimo, uma exclusão ou um cartão que ninguém pediu muda o número da
   * resposta — é exatamente o que não se flexibiliza.
   */
  filtro: FiltroOuro
}

export interface OuroPlano {
  /** Leituras aceitas, cada uma estrita. A PRIMEIRA é a canônica (acerto exato). */
  aceitos: PlanoOuro[]
  /** `{"source":"none"}` também é resposta certa. */
  nenhumAceito: boolean
  /**
   * Um plano VÁLIDO aqui é perigo de modalidade: hipótese, registro ou pedido
   * fora do escopo virando consulta factual, respondida com número real.
   */
  planoEhPerigo?: boolean
}

// ---------------------------------------------------------------------------
// Planejador de cenário — CONTRATO CANDIDATO (não existe em produção)
// ---------------------------------------------------------------------------

export interface PassoOuro { kind: string; campos: Record<string, Esperado> }

export interface OuroCenario {
  /** Passos na ordem em que o usuário os disse. `[]` = não há cenário planejável. */
  passos: PassoOuro[]
  /** Outras decomposições igualmente certas ("comprar uma tv de 3 mil": gasto ou compra em 1x). */
  alternativas?: PassoOuro[][]
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

export type Historico = { role: 'user' | 'assistant'; text: string }[]

interface CasoBase {
  id: string
  dimensao: Dimensao
  perfil: PerfilEval
  mensagem: string
  /** Por que o caso é difícil. Vai para o relatório. */
  porque: string
  rota: RotaProducao
}

export interface CasoChat extends CasoBase { suite: 'chat'; ouro: OuroChat; historico?: Historico }
export interface CasoPlano extends CasoBase { suite: 'plano'; ouro: OuroPlano }
export interface CasoCenario extends CasoBase { suite: 'cenario'; ouro: OuroCenario }

export interface TurnoOuro {
  mensagem: string
  acoes?: AcaoOuro[]
  tiposProibidos?: string[]
  deveMencionar?: RegExp[]
  proibidoNaResposta?: Violacao[]
  perguntar?: boolean
}

/** Rodada pelo ORQUESTRADOR REAL: o local responde o que sabe, o modelo recebe o resto. */
export interface CasoContinuidade {
  id: string
  suite: 'continuidade'
  dimensao: 'continuidade'
  perfil: PerfilEval
  porque: string
  turnos: TurnoOuro[]
}

export type CasoEval = CasoChat | CasoPlano | CasoCenario | CasoContinuidade

// ---------------------------------------------------------------------------
// Resultado de UMA execução de UM caso (ou turno) em UMA configuração
// ---------------------------------------------------------------------------

export type TipoPerigo =
  | 'acao-perigosa'           // ação que não devia existir chegou à tela de confirmação
  | 'campo-financeiro-errado' // valor, total, parcelas, data, origem ou cartão errado numa ação aceita
  | 'alucinacao-numerica'     // valor em dinheiro sem lastro no contexto nem na frase
  | 'alegacao-falsa'          // diz que registrou, confirmou, transferiu ou apagou
  | 'vazamento'               // prompt, contexto bruto ou chave na resposta
  | 'envelope-exposto'        // o envelope interno do contrato (resposta ou ação) chegou ao usuário como texto
  | 'contaminacao-perfil'     // conteúdo ou ação de motorista para quem não é motorista
  | 'modalidade'              // hipótese, negação, futuro ou registro virando fato ou consulta factual

export interface Perigo { tipo: TipoPerigo; detalhe: string }

/**
 * Origem de cada camada que pode introduzir um número na resposta final.
 *
 * A lista é deliberadamente granular: um plano remoto pode ser correto, o
 * executor local calcular os valores e o compositor determinístico escrevê-los.
 * Só `remote-output` é texto livre produzido pelo modelo.
 */
export type ProvenienciaNumerica =
  | 'remote-output'
  | 'remote-plan'
  | 'local-query-result'
  | 'deterministic-composer'
  | 'fallback-local'

export interface ResultadoCaso {
  config: string
  caso: string
  suite: Suite
  dimensao: Dimensao
  perfil: PerfilEval
  /** Leitura humana do que o LOCAL faz com a frase. Diagnóstico — NÃO decide elegibilidade. */
  rota: RotaProducao
  /**
   * OBSERVADO: o modelo remoto foi de fato requisitado nesta execução. É o
   * único critério para o caso contar na NOTA do modelo. Um caso que o
   * aparelho fecha sozinho continua no relatório do app e fora desta conta.
   */
  elegivelRemoto: boolean
  remoteKind?: 'chat' | 'plano' | 'cenario'
  rep: number
  turno?: number
  /** Uma mensagem para um caminho remoto = uma chamada lógica. Retry não multiplica. */
  chamadasLogicas: number
  /** Timeout, HTTP de erro, resposta vazia. */
  falhaTransporte?: string
  /**
   * O remoto foi chamado e a saída dele não pôde ser usada. Continua sendo
   * falha DO MODELO mesmo quando o fallback local salvou a resposta ao usuário.
   */
  falhaRemota?: string
  /** O app respondeu pelo caminho local depois de o remoto falhar. */
  fallbackLocal?: boolean
  /**
   * Quem pôs número no texto julgado. A nota de alucinação numérica do
   * modelo só lê o que veio de `remote-output`; o resto é o aparelho.
   */
  provenienciaNumerica?: ProvenienciaNumerica[]
  contratoInvalido: boolean
  intencaoCorreta?: boolean
  intencaoObtida?: string
  acoesEsperadas: number
  acoesAceitas: number
  acoesRejeitadas: number
  acoesCasadas: number
  camposCertos: number
  camposConferidos: number
  deviaPerguntar?: boolean
  perguntou?: boolean
  perguntaNoAlvo?: boolean
  planoValido?: boolean
  planoNenhum?: boolean
  planoExato?: boolean
  planoSemantico?: boolean
  cenarioCorreto?: boolean
  util?: boolean
  generica?: boolean
  perigos: Perigo[]
  numerosSemLastro: string[]
  entidadesInventadas: string[]
  observacoes: string[]
  ms: number
  chamadasHttp: number
  tokensEntrada: number
  tokensSaida: number
  tokensRaciocinio: number
  custoUSD: number
  resposta?: string
}
