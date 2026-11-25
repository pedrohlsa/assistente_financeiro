// TOLERÂNCIA A ERRO DE DIGITAÇÃO — estreita, fechada e reversível.
//
// O defeito conhecido: "gsatei 190 de cimento" não casava verbo nenhum, então
// não havia ação — e o resto da frase, que estava perfeito, se perdia junto.
//
// O que este módulo NÃO é: um autocorretor. Corrigir texto livre num app de
// dinheiro é perigoso de um jeito específico — "mercdao" pode ser o nome que o
// usuário deu ao lugar, "gasosa" é como o motorista chama gasolina, e trocar o
// nome de um estabelecimento por outro parecido divide o histórico dele em
// dois (regra 41 do CLAUDE.md: ou o texto é o mesmo, ou não é o mesmo lugar).
//
// Cinco travas, todas necessárias:
//
//   1. DICIONÁRIO FECHADO. Só vocabulário ESTRUTURAL do assistente: verbo
//      financeiro, palavra de tempo, unidade, palavra de pergunta e conector.
//      Substantivo de conteúdo (cimento, mercado, padaria) NUNCA entra.
//   2. NUNCA PERTO DE DÍGITO. "12x", "3200", "R$ 50" ficam intocados.
//   3. NUNCA NO VOCABULÁRIO DELE. Palavra que aparece nas categorias, cartões,
//      metas ou no histórico do próprio usuário é dele — não se corrige.
//   4. DISTÂNCIA BAIXA E VENCEDOR ÚNICO. Empate entre dois candidatos = não
//      corrige. Falha FECHADA.
//   5. O ORIGINAL É PRESERVADO. `corrections` diz o que mudou, e quem chama só
//      usa o texto reparado se ele DESTRAVAR alguma coisa.

import type { AppState } from '../../models/types'
import { normalizeName } from '../../utils/text'
import { NUMBER_WORD_RE } from '../numbers'

/**
 * Vocabulário estrutural. Cada palavra aqui é do ASSISTENTE, não do usuário:
 * são os verbos, tempos, unidades e conectores que o parser precisa reconhecer
 * para entender a frase. Acrescentar substantivo de conteúdo a esta lista é o
 * caminho mais curto para o app renomear o lugar onde a pessoa almoça.
 */
const ESTRUTURAL: string[] = [
  // verbos de dinheiro
  'gastei', 'gastou', 'gasto', 'gastar', 'paguei', 'pagou', 'pagar', 'pago',
  'recebi', 'recebeu', 'receber', 'recebo', 'ganhei', 'ganhou', 'ganhar',
  'comprei', 'comprou', 'comprar', 'guardei', 'guardou', 'guardar', 'guardo',
  'separei', 'separar', 'abasteci', 'abastecer', 'coloquei', 'colocar',
  'botei', 'rodei', 'rodou', 'rodar', 'andei', 'dirigi', 'trabalhei',
  'trabalhar', 'faturei', 'faturar', 'lucrei', 'lucrar', 'vendi', 'vender',
  'tirei', 'tirar', 'depositei', 'depositar', 'investi', 'investir',
  'parcelei', 'parcelar', 'passei', 'troquei', 'trocar', 'instalei',
  'sobrou', 'sobra', 'sobrar', 'entrou', 'entrar', 'saiu', 'custou', 'custar',
  // "Caiu" é o verbo do salário que chega na conta. Fora do dicionário ele
  // estava a uma letra de "saiu" e era "corrigido" para ele: a RECEITA virava
  // despesa ("depois caiu meu salario 3200" → "saiu meu salario").
  'caiu', 'cair', 'pingou',
  // Mesmo defeito no FUTURO: "vai sair 430 de luz" virava "vai saiu 430" e o
  // plano passava a ser uma despesa realizada.
  'sair', 'pingar', 'vencer',
  // Verbos de CENÁRIO: "e se eu parar a obra" virava "e se eu pagar a obra" —
  // a uma letra de distância — e a hipótese perdia o sentido inteiro.
  'parar', 'pare', 'parasse', 'cortar', 'corte',
  'registrar', 'registra', 'apagar', 'desfazer', 'cancelar', 'corrigir',
  // tempo
  'hoje', 'ontem', 'anteontem', 'amanha', 'semana', 'semanas', 'meses',
  'passado', 'passada', 'proximo', 'proxima', 'ultimo', 'ultimos', 'ultima',
  'ultimas', 'atras', 'agora', 'manha', 'tarde', 'noite', 'ontem',
  'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo',
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
  // unidades
  'reais', 'real', 'conto', 'contos', 'centavo', 'centavos', 'litros', 'litro', 'horas', 'hora',
  'viagens', 'viagem', 'corridas', 'corrida', 'parcelas', 'parcela',
  'vezes', 'hodometro', 'quilometros',
  // pergunta e intenção
  'quanto', 'quantos', 'quantas', 'qual', 'quais', 'quando', 'onde', 'como',
  'porque', 'quero', 'queria', 'preciso', 'posso', 'consigo', 'devo',
  'comparado', 'comparando', 'media', 'total', 'maior', 'menor', 'melhor',
  'pior', 'diferenca', 'tirando', 'exceto', 'somente', 'apenas',
  // conectores comuns em frase de registro
  'tambem', 'depois', 'entao', 'mesmo', 'ainda', 'menos', 'mais',
  // Palavras que o app ve o tempo todo E que ficam a UMA letra de outra do
  // dicionario. Estar aqui as torna intocaveis: "paguei 355 nas CONTAS" virava
  // "nas CONTOS" (a giria de reais), e o valor por extenso "CENTO e cinquenta"
  // virava "CONTO e cinquenta" — o lancamento de 150 sumia.
  'conta', 'contas', 'cento', 'centos', 'salario', 'aluguel', 'luz', 'agua',
  'gasolina', 'mercado', 'casa', 'carro', 'moto', 'meta', 'metas', 'saldo',
  'banco', 'cartao', 'cartoes', 'fatura', 'faturas', 'reserva', 'renda', 'venda',
  // Relato de transferência: "mandei Pix" não é "andei km". Também não
  // corrigir conectores e parentesco comuns para verbos/tempo por semelhança.
  'mandei', 'enviei', 'transferi', 'pix', 'para', 'minha', 'minhas', 'nossa', 'nossas', 'filha',
]

// Palavras corretas que ficam a uma letra de vocabulário estrutural e nunca
// podem ser "consertadas": "meio-dia" virava "maio" (mês) e "meia" virava
// "meta" — a hora sumia e a descrição ganhava "ao maio".
const PALAVRAS_DE_HORA = ['meio', 'meia', 'noite', 'hora', 'horas', 'minuto', 'minutos', 'tarde', 'manha', 'madrugada']
/**
 * Palavras CORRETAS do dia a dia que ficam a uma letra de um verbo ou unidade
 * do app. Fora daqui o corretor as "consertava" — e a frase mudava de sentido:
 * "peguei uma corrida" virava "paguei", "o banco me cobrou 45" virava "me
 * sobrou", "salão" virava "saldo", "comprando" virava "comparando". A lista
 * só PROTEGE: nenhuma delas é alvo de correção. A varredura `MA-corretor-nao-troca-
 * palavra-real` falha se uma destas voltar a ser trocada.
 */
export const PALAVRAS_REAIS_PROTEGIDAS = [
  'cobrou', 'cobrar', 'cobra', 'cobrei', 'cobraram', 'cobrado', 'cobrada', 'cobranca',
  // "Cancelei a corrida" virava "parcelei a corrida".
  'cancelei', 'cancelou', 'cancelaram', 'cancela', 'cancelar', 'cancelada', 'cancelado', 'cancelamento',
  'peguei', 'pegou', 'pegar', 'pego', 'pega', 'pegaram', 'pegamos',
  'transferiu', 'depositou', 'gastaram', 'ganharam', 'receberam', 'venderam', 'vendeu',
  'compraram', 'comprando', 'trocaram', 'trocou', 'tirou', 'botou', 'colocou', 'abasteceu',
  'custa', 'custam', 'custaram', 'deve', 'devem', 'pagos', 'pagas', 'gasta', 'gastas',
  'sobras', 'parcelado', 'parcelada', 'abri', 'abriu', 'abrir',
  'livro', 'livros', 'salao', 'filho', 'filhos', 'sogra', 'sogro',
  'rendeu', 'renderam', 'rende', 'render', 'tocou', 'pagaram', 'faltaram', 'faltou', 'troco',
  'veio', 'vieram', 'vem', 'chegou', 'chegaram', 'passeio', 'passeios',
]

const DICIONARIO = new Set([...ESTRUTURAL, ...PALAVRAS_DE_HORA])
/** Nunca é corrigida — e nunca é ALVO: senão "rendeu" virava "vendeu". */
const INTOCAVEIS = new Set([...DICIONARIO, ...PALAVRAS_REAIS_PROTEGIDAS])

/** Comprimento mínimo do token que pode ser corrigido. */
const MIN_LEN = 4
/** A partir daqui uma distância 2 é aceitável. */
const LEN_PARA_DIST_2 = 8

export interface TypoCorrection {
  from: string
  to: string
  at: number
  /** O alvo e verbo ou palavra de tempo? So esses justificam refazer a leitura. */
  estrutural: boolean
}

export interface RepairedText {
  text: string
  corrections: TypoCorrection[]
  changed: boolean
}

const SPOKEN_PAYOUT_VERBS: Record<string, string> = { caio: 'caiu', 'liberô': 'liberou', pingou: 'caiu', 'pingô': 'caiu', 'depositô': 'depositou' }

export function normalizeDriverShorthand(message: string): string {
  // A expansão da negação precisa vir antes dos leitores de repasse.
  let text = message.replace(/(?<![\p{L}\p{M}\d])(?:n(?:\/|\u0303)?|ñ|nao|não|num|nem)\s+(me\s+)?(caiu|caio|ca[ií]ram|entrou|entraram|pingou|pingô|liberou|liberô|repassou|depositou|depositô|pagou|recebi)(?![\p{L}\p{M}\d])/giu,
    (_, dative: string | undefined, verb: string) => `não ${dative || ''}${SPOKEN_PAYOUT_VERBS[verb.toLowerCase()] || verb}`)
  text = text.replace(/(?<![\p{L}\p{M}\d])(não\s+(?:caiu|entrou|recebi))\s+n[ãa]o(?=\s*(?:$|[;,.!?])|\s+(?:e|mas)\s+)/giu, '$1')
  text = text.replace(/\b(n[ao]|d[ao]|pel[ao]|[ao])\s+noventa[- ]?e[- ]?nove\b/gi, '$1 99')
    .replace(/\b(n[ao]|d[ao]|pel[ao]|[ao])\s+in[-\s]*draiver?\b/gi, '$1 inDrive')
  if (/\b(?:ganhei|faturei|caiu|recebi|corridas?|quanto|quantos?|quantas?)\b|\b(?:reais?|centavos?|contos?)\s+d[ao]\s+ubber\b/i.test(text)) {
    text = text.replace(/\b(n[ao]|d[ao]|pel[ao])\s+ubber\b/gi, '$1 Uber')
  }
  // O começo do ditado pode sumir; só recupera o verbo diante da duração ao volante.
  text = text.replace(/^(\s*(?:(?:hoje|hj|ontem|anteontem)\s+)?)(?:fexei|feichei|[cx]hei|xei)(?=\s+[^;!?]{1,42}\s+(?:no|de)\s+volant[ei]\b)/i, '$1fechei')
  if (/^\s*(?:(?:hoje|hj|ontem|anteontem)\s+)?fechei\b/i.test(text)) {
    text = text.replace(/\b(no|de)\s+volant[ei]\s+c\/\s*/i, '$1 volante com ').replace(/\b(no|de)\s+volanti\b/i, '$1 volante')
  }
  return text
    .replace(/(^|[,;.!]\s*|\s+(?:e|mas)\s+)((?:(?:eu|hoje|hj|ontem|anteontem)\s+)*)\b(abast|gstei|pg(?=\.?\s+(?:r\$\s*)?\d[\d.,]*\s+(?:de?|em)\s+(?:gasosa|gasolina|combust[íi]vel|etanol|diesel)\b))\.?\s+(?=(?:r\$\s*)?\d)/gi,
      (_, boundary: string, lead: string, verb: string) => `${boundary}${lead}${({ abast: 'abasteci', gstei: 'gastei', pg: 'paguei' })[verb.toLowerCase()]} `)
    .replace(/(?<![\p{L}\p{M}\d.,])(\d{1,2})\s*ctvs?\b/giu, '$1 centavos')
    .replace(/\b(de|em|com)\s+combstivel\b/gi, '$1 combustível')
    .replace(/\bd\s+(?=gasosa\b|gasolina\b|combust[íi]vel\b)/gi, 'de ')
    .replace(/(^\s*|\s+(?:e|mas)\s+)(onti?|antontem)\s+(?=(?:eu\s+)?(?:ganhei|recebi|faturei|fiz|abasteci|trabalhei|rodei|gastei|paguei)\b)/gi,
      (_, boundary: string, date: string) => `${boundary}${/^ont/i.test(date) ? 'ontem' : 'anteontem'} `)
    .replace(/\b(corridas?|gasosa|gasolina|combust[íi]vel|uber|99|in\s*drive|kms?|horas?)\s+(onti?|antontem)(?=\s+(?:e|mas)\s+|\s*[.!?]*$|[,;])/gi,
      (_, previous: string, date: string) => `${previous} ${/^ont/i.test(date) ? 'ontem' : 'anteontem'}`)
    .replace(/^(\s*(?:e\s+)?)(?:qto|qnto)\s+(?=(?:deu|deram)\s+d(?:e)?\s+corridas?\b)/i, '$1quanto ')
    .replace(/^(\s*(?:e\s+)?quanto\s+(?:deu|deram))\s+d\s+(?=corridas?\b)/i, '$1 de ')
    .replace(/(^\s*(?:e\s+)?|[?;,]\s*(?:e\s+)?|\s+e\s+)(?:qts|qnts|qntos|qntas)\s+(?=(kms?|quil[oô]metros?|h|hrs?|horas?|viagens?|corridas?)\b)/gi,
      (_, boundary: string, measure: string) => `${boundary}${/^(?:h|v|c)/i.test(measure) ? 'quantas' : 'quantos'} `)
}

/**
 * Damerau-Levenshtein com teto: para de contar assim que passa de `max`.
 * O teto não é otimização — é o que garante que uma palavra longa e diferente
 * não seja "corrigida" para outra por acaso.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev2: number[] = []
  let prev: number[] = []
  let cur: number[] = []
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur = [i]
    let melhor = i
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + custo)
      // Transposição: "gsatei" → "gastei" é UMA troca, não duas.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? Infinity) + 1)
      }
      cur[j] = v
      if (v < melhor) melhor = v
    }
    if (melhor > max) return max + 1
    prev2.length = 0
    prev2.push(...prev)
    prev = cur
  }
  return prev[b.length]
}

/**
 * Palavras do PRÓPRIO usuário. Categoria, cartão, meta e o que ele já escreveu
 * em descrição ou origem: nada disso pode ser "corrigido" — é o nome que ele
 * escolheu, e trocá-lo por um parecido divide o histórico dele em dois.
 */
function vocabularioDoUsuario(state: AppState): Set<string> {
  const out = new Set<string>()
  const add = (s?: string | null) => {
    for (const w of normalizeName(s || '').split(/[^a-z0-9]+/)) if (w.length >= 3) out.add(w)
  }
  for (const c of state.categories || []) add(c.name)
  for (const c of state.cards || []) { add(c.name); add(c.institution) }
  for (const g of state.goals || []) add(g.name)
  for (const r of state.recurring || []) { add(r.name); add(r.origin) }
  // O histórico é grande; os mais recentes bastam para proteger o vocabulário
  // vivo dele sem varrer anos de lançamento a cada mensagem.
  const txs = (state.transactions || []).slice(-400)
  for (const t of txs) { add(t?.description); add(t?.origin) }
  return out
}

/**
 * Verbos no PASSADO. Servem de desempate: numa frase com valor, "gasti 60" é o
 * relato de um fato consumado, então `gastei` ganha de `gasto`. É o "contexto
 * suficiente" que a correção exige — sem ele, os dois candidatos empatam e
 * nada é corrigido.
 */
const PASSADO = new Set([
  'gastei', 'paguei', 'recebi', 'ganhei', 'comprei', 'guardei', 'separei',
  'abasteci', 'coloquei', 'botei', 'rodei', 'andei', 'trabalhei', 'faturei',
  'lucrei', 'vendi', 'tirei', 'depositei', 'investi', 'parcelei', 'passei',
  'troquei', 'instalei', 'sobrou', 'entrou', 'saiu', 'custou',
])

const MESES = new Set(['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'])
const ERROS_DE_RECEBIMENTO = new Map([['reci bi', 'recebi'], ['rece bi', 'recebi'], ['rebcbi', 'recebi']])
const ANTES_DE_RELATO = /(?:^|[,:;.!?]|(?<![\wÀ-ÿ])(?:e|mas|depois))\s*(?:(?:eu|j[áa]|ainda|n|ñ|n[ãa]o|nem|hoje|hj|ontem|anteontem)\s+)*$/i
const VALOR_DE_RELATO = /^\s+(?:r\$\s*)?\d/i

/**
 * Melhor candidato do dicionário, ou `null` quando não há nada perto o
 * bastante — ou quando o empate não se desfaz.
 *
 * Desempate, nesta ordem: (1) verbo no passado, quando a frase tem valor;
 * (2) o candidato mais CURTO, porque letra repetida ("quantoo") é o erro mais
 * comum. Sem desempate possível, não corrige: falha fechada.
 */
function melhorCandidato(token: string, temValor: boolean): string | null {
  const max = token.length >= LEN_PARA_DIST_2 ? 2 : 1
  let melhorDist = max + 1
  let candidatos: string[] = []
  for (const alvo of DICIONARIO) {
    if (Math.abs(alvo.length - token.length) > max) continue
    const d = editDistance(token, alvo, max)
    if (d > max) continue
    if (d < melhorDist) { melhorDist = d; candidatos = [alvo] }
    else if (d === melhorDist && !candidatos.includes(alvo)) candidatos.push(alvo)
  }
  if (!candidatos.length) return null
  // Distância 2 é longe demais para trocar uma palavra de CONTEÚDO: "banheiro"
  // virava "janeiro" e a reforma ia para o mês errado na descrição. Só o verbo
  // de relato no passado ("gastii" → "gastei") justifica um salto desses.
  if (melhorDist === 2) candidatos = candidatos.filter(c => PASSADO.has(c))
  if (!candidatos.length) return null
  if (candidatos.length === 1) return candidatos[0]

  if (temValor) {
    const passados = candidatos.filter(c => PASSADO.has(c))
    if (passados.length === 1) return passados[0]
  }
  const ordenado = [...candidatos].sort((a, b) => a.length - b.length || a.localeCompare(b))
  return ordenado[0].length < ordenado[1].length ? ordenado[0] : null
}

/**
 * Repara o vocabulário ESTRUTURAL da frase. O texto original nunca é perdido:
 * quem chama decide se usa o reparo, e a regra é usar só quando ele destrava
 * alguma coisa.
 */
export function repairStructuralTypos(message: string, state: AppState): RepairedText {
  const protegidas = vocabularioDoUsuario(state)
  const corrections: TypoCorrection[] = []
  // Frase com numero e quase sempre relato de fato consumado: e o contexto que
  // desempata "gasti" entre `gastei` e `gasto`.
  const temValor = /\d/.test(message)

  // A varredura é por TOKEN, com posição preservada: o texto reparado tem que
  // continuar casando com os offsets da segmentação por cláusula.
  const text = message.replace(/\brec[ei]\s+bi\b|[a-zA-ZÀ-ÿ]{3,}/gi, (bruto, at: number) => {
    const token = normalizeName(bruto)
    if (token.length < MIN_LEN) return bruto
    // Perto de dígito: "12x", "3200reais", "R$50" nunca são vocabulário.
    const antes = message[at - 1]
    const depois = message[at + bruto.length]
    if ((antes && /\d/.test(antes)) || (depois && /\d/.test(depois))) return bruto
    if (INTOCAVEIS.has(token)) return bruto
    if (token.split(' ').some(word => protegidas.has(word))) return bruto
    // Maiúscula no meio da frase é NOME: "o cliente Marcos" virava "Marco"
    // (o mês) e a origem do lançamento saía errada.
    if (/^[A-ZÀ-Þ]/.test(bruto) && at > 0 && !/[.!?:]\s*$/.test(message.slice(0, at))) return bruto
    // Numero por extenso e VALOR, nao vocabulario: "cento", "sete", "vinte" e
    // "cinco" nunca podem ser trocados por palavra parecida.
    if (NUMBER_WORD_RE.test(token)) return bruto

    const emRelato = ANTES_DE_RELATO.test(message.slice(0, at)) && VALOR_DE_RELATO.test(message.slice(at + bruto.length))
    const semRepeticao = emRelato ? token.replace(/([a-z])\1+/g, '$1') : token
    const direto = emRelato && (ERROS_DE_RECEBIMENTO.get(token)
      || (semRepeticao !== token && PASSADO.has(semRepeticao) ? semRepeticao : null))
    const alvo = direto || melhorCandidato(token, temValor)
    // Uma correção também não pode CRIAR um número. "Meu saldo tá certo?"
    // virava "meu saldo tá cento" e propunha alterar o saldo para R$ 100.
    if (!alvo || NUMBER_WORD_RE.test(alvo)) return bruto
    // Mês só com contexto de data: "cliente marcos" não é "março", "maios" não
    // é "maio". Antes de um mês vem "em", "de", "desde", "até", "mês de".
    if (MESES.has(alvo) && !/\b(?:em|de|desde|ate|at[ée]|no|todo|cada|m[eê]s\s+de)\s*$/i.test(message.slice(0, at))) return bruto
    if (/\bpix\b/i.test(message) && /^(?:andei|rodei|dirigi|percorri|trabalhei)$/.test(alvo)) return bruto
    corrections.push({ from: bruto, to: alvo, at, estrutural: ehVerboOuTempo(alvo) })
    // Mantém a caixa original da primeira letra: quem escreveu "Gsatei" merece
    // ver "Gastei", não "gastei".
    return /^[A-ZÀ-Þ]/.test(bruto) ? alvo[0].toUpperCase() + alvo.slice(1) : alvo
  })

  return { text, corrections, changed: corrections.length > 0 }
}

/**
 * O alvo da correcao muda a ESTRUTURA da frase (verbo ou tempo)?
 *
 * E esta a distincao que separa um typo que destroi a leitura ("gsatei") de um
 * substantivo que so parece um: um erro no verbo faz o lancamento inteiro se
 * perder; uma palavra parecida no meio da descricao quase nunca e erro.
 */
const TEMPO = new Set([
  'hoje', 'ontem', 'anteontem', 'amanha', 'semana', 'semanas', 'meses',
  'passado', 'passada', 'proximo', 'proxima', 'ultimo', 'ultimos', 'ultima',
  'ultimas', 'atras', 'segunda', 'terca', 'quarta', 'quinta', 'sexta',
  'sabado', 'domingo', 'janeiro', 'fevereiro', 'marco', 'abril', 'maio',
  'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
])

const VERBOS = new Set(ESTRUTURAL.filter(w => PASSADO.has(w)
  || /^(?:gast|pag|receb|ganh|compr|guard|separ|abastec|coloc|rod|trabalh|fatur|lucr|vend|tir|deposit|invest|parcel|troc|sobr|entr|cust)/.test(w)))

export const ehVerboOuTempo = (alvo: string): boolean => VERBOS.has(alvo) || TEMPO.has(alvo)

/**
 * Muletas de conversa: "gastei TIPO 190 de cimento", "gastei CARA 80 no
 * mercado", "ganhei SEI LÁ 250 hoje".
 *
 * Elas não querem dizer nada e ficam exatamente onde mais atrapalham — entre o
 * verbo e o valor. O corpus metamórfico mostrou 67 frases perdidas por causa
 * disso: com a muleta no meio, o parser não achava lançamento NENHUM.
 *
 * A remoção é estreita: a palavra só sai quando está grudada num número ou num
 * conector de valor. "Comprei uma cara de cavalo" não perde nada, e "gastei 50
 * numa cara" também não — ali a palavra não está entre verbo e valor.
 */
/**
 * Muletas que NUNCA são conteúdo. Estas saem de QUALQUER posição entre duas
 * palavras: "troquei o SEI LÁ óleo por 280" perdia a manutenção inteira, e o
 * lugar onde a muleta cai é imprevisível — depende de como a pessoa fala.
 */
const MULETAS_SEMPRE = 'sei\\s+l[aá]|a[íi]|p[oô]|pow|n[ée]|hum|mano'

/**
 * Muletas que PODEM ser conteúdo: "cara" é apelido, "olha" é verbo, "tipo de
 * conta" é substantivo. Estas só saem quando estão coladas num valor — a
 * POSIÇÃO é o que prova que ali elas não significam nada.
 */
const MULETAS = `tipo|cara|velho|olha|olhe|ent[ãa]o|assim|ah|eh|${MULETAS_SEMPRE}`

/** Muleta ANTES do valor: "gastei tipo 190 de cimento". */
const RE_MULETA_ANTES = new RegExp(
  String.raw`\s+(?:${MULETAS})\s+(?=(?:r\$\s*)?\d|de\s+\d|uns?\s+\d)`,
  'gi',
)

/**
 * Muleta DEPOIS do valor: "guardei 200 sei lá na reserva".
 *
 * Este é o lado que mais estraga: com a muleta entre o valor e o complemento,
 * "na reserva" deixa de ser lido como reserva e o lançamento vira depósito em
 * meta; "de gasolina" deixa de ser abastecimento e vira despesa comum. O
 * dinheiro fica certo e o TIPO fica errado, que é pior de perceber.
 */
const RE_MULETA_DEPOIS = new RegExp(
  String.raw`(?<=\d)\s+(?:${MULETAS})\s+(?=(?:de|da|do|na|no|em|para|pra|nas|nos)\b)`,
  'gi',
)

/**
 * Muleta entre o substantivo e o verbo de ligação: "meu saldo SEI LÁ é 1500".
 * Sem esta variante o valor não chegava a lugar nenhum — a frase inteira ficava
 * sem lançamento.
 */
const RE_MULETA_LIGACAO = new RegExp(
  String.raw`\s+(?:${MULETAS})\s+(?=(?:[ée]|eh|foi|ficou|deu|de|da|do|na|no|em)\s+(?:r\$\s*)?\d)`,
  'gi',
)

/** As inequívocas, em qualquer posição depois da primeira palavra. */
const RE_MULETA_LIVRE = new RegExp(
  String.raw`(?<=\S)\s+(?:${MULETAS_SEMPRE})(?=\s|[.,!?]|$)`,
  'gi',
)

/**
 * Muleta logo depois do VERBO: "troquei TIPO o óleo por 280".
 *
 * Nessa posição nenhuma delas é conteúdo — o que vem depois de um verbo de
 * dinheiro conjugado é o objeto, não um "tipo" nem um "olha". Sem esta regra a
 * manutenção inteira se perdia.
 */
const RE_MULETA_POS_VERBO = new RegExp(
  String.raw`(?<=\b(?:${[...PASSADO].join('|')})\s)(?:${MULETAS})\s+`,
  'gi',
)

/**
 * Muleta logo depois do ARTIGO: "troquei o TIPO óleo por 280".
 *
 * Aqui a lista é a restrita de propósito: "o cara", "a olha" e "o velho" podem
 * ser substantivo de verdade, e trocar um substantivo por nada é pior do que
 * não entender a frase com ruído. "O tipo óleo" não é português nenhum.
 */
const RE_MULETA_POS_ARTIGO = new RegExp(
  String.raw`(?<=\b(?:o|a|os|as|um|uma|meu|minha)\s)(?:tipo|ent[ãa]o|assim|${MULETAS_SEMPRE})\s+`,
  'gi',
)

/**
 * Caracteres que nunca são conteúdo: controle C0/C1, largura zero e marcas de
 * direção de texto.
 *
 * A limpeza acontece na FRONTEIRA (regra 46): a mensagem entra por aqui e nada
 * depois precisa se preocupar com isso. Sem ela, o `\b` que o usuário colou sem
 * perceber sobrevivia até a DESCRIÇÃO do lançamento, voltava na resposta do
 * assistente e ia parar no histórico — e um `U+202E` no meio de um nome inverte
 * visualmente tudo que vem depois dele na tela.
 *
 * `\n` e `\t` ficam: eles separam ideias numa mensagem longa, e a segmentação
 * por cláusula usa isso.
 */
const INVISIVEIS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

/**
 * Teto de tamanho da mensagem.
 *
 * O parser tem trechos QUADRÁTICOS no comprimento — não por descuido, mas
 * porque reconhecer valor, data e origem exige varrer o texto mais de uma vez.
 * Com 5.000 caracteres isso vira meio segundo; o fuzzer mediu 500 ms para uma
 * sequência de 5.000 dígitos, mil vezes o custo de uma mensagem normal.
 *
 * Perseguir cada regex quadrática seria caro e frágil. O teto é a resposta
 * honesta: ninguém digita um número de 5.000 algarismos, e 2.000 caracteres já
 * é uma mensagem longuíssima para um chat — a chamada remota, aliás, já cortava
 * em 1.500. O que é cortado é DITO ao usuário, nunca sumido em silêncio.
 */
export const MAX_MESSAGE_CHARS = 2000

export function stripInvisible(message: string): string {
  return message.replace(INVISIVEIS, '')
}

/**
 * "4k" = 4.000. E o jeito mais curto de dizer mil, e o parser lia so o 4:
 * "se eu meter um pc de 4K em 10x" virava uma simulacao de gasto de R$ 4,00.
 *
 * Estreito de proposito: so ate tres digitos (999k), so com o `k` colado ou a
 * um espaco, e nunca depois de "tv" — "tv 4k" e resolucao de tela, nao dinheiro.
 */
const RE_MIL_ABREVIADO = /(?<!\btv\s)(?<![a-zà-ú\d]|\d[.,])(\d{1,3})(?:[.,](\d{1,2}))?\s?k\b(?![a-zà-ú])/gi

export function expandMilAbreviado(message: string): string {
  // "2,5k" e "2.5k" são 2500. O decimal só vale com até dois dígitos: o
  // separador de milhar não aparece antes de um "k".
  return message.replace(RE_MIL_ABREVIADO, (_m, n: string, dec?: string) =>
    String(Math.round((Number(n) + (dec ? Number(`0.${dec}`) : 0)) * 1000)))
}

export interface ClampedMessage { text: string; truncated: boolean }

/**
 * Abreviações de preposição do celular: "gastei 30 cm uber" virava a descrição
 * "Cm uber", e "p/ o mercado" deixava "p/" no texto. "cm" só vira "com" antes
 * de palavra que não seja de medida ("30 cm de cano" continua centímetro).
 */
export function expandPreposicoesAbreviadas(message: string): string {
  return message
    .replace(/(?<![\p{L}\p{M}\d])(?:c\/|cm)\s+(?!(?:de|do|da|x|por|e)(?![\p{L}\p{M}]))(?=[\p{L}])/giu, 'com ')
    .replace(/(?<![\p{L}\p{M}\d])p\/\s*(?=[\p{L}])/giu, 'pra ')
}

/** Limpa e limita. É a única porta de entrada da mensagem no orquestrador. */
export function clampMessage(message: string): ClampedMessage {
  const limpa = expandPreposicoesAbreviadas(expandMilAbreviado(stripInvisible(String(message ?? ''))))
  return limpa.length > MAX_MESSAGE_CHARS
    ? { text: limpa.slice(0, MAX_MESSAGE_CHARS), truncated: true }
    : { text: limpa, truncated: false }
}

export function stripFillers(message: string): { text: string; changed: boolean } {
  const text = message
    // "Quanto ganho por hora DE VERDADE": intensificador, não nome de nada —
    // virava filtro de texto e a resposta era "não tenho lançamento com verdade".
    .replace(/\b(?:de\s+verdade|realmente|de\s+fato)\b/gi, ' ')
    .replace(/\bna\s+real\b/gi, (match, offset, original) => /[,;—–]\s*$/.test(original.slice(0, offset)) ? match : ' ')
    // “Este mês msm” termina a referência de período. Fora dela, “Mesmo”
    // pode fazer parte do nome que o usuário deu a um lançamento.
    .replace(/(\b(?:hoje|hj|ontem|anteontem|(?:este|esse|do|no)\s+m[eê]s|m[eê]s\s+passado|(?:esta|essa)\s+semana|semana\s+passada))\s+(?:msm|mesmo)(?=\s*[.!?]*$)/gi, '$1')
    .replace(RE_MULETA_LIVRE, '')
    .replace(RE_MULETA_POS_VERBO, '')
    .replace(RE_MULETA_POS_ARTIGO, '')
    .replace(RE_MULETA_ANTES, ' ')
    .replace(RE_MULETA_DEPOIS, ' ')
    .replace(RE_MULETA_LIGACAO, ' ')
    .replace(/\s{2,}/g, ' ')
  return { text, changed: text !== message }
}

/** Frase curta que conta ao usuário o que foi lido de outro jeito. */
export function describeRepairs(r: RepairedText): string | null {
  if (!r.changed) return null
  const partes = r.corrections.slice(0, 3).map(c => `"${c.from}" como "${c.to}"`)
  return `Li ${partes.join(', ')}.`
}
