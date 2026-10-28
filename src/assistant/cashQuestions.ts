// Perguntas sobre o caixa FUTURO: quanto deixar disponível até uma data e qual
// conta está pesando.
//
// A DSL de consulta soma o que JÁ aconteceu. Estas duas perguntas olham para o
// que AINDA vai sair — contas fixas, faturas e parcelas cadastradas. Mandá-las
// para a DSL respondia o gasto do mês (número certo, pergunta outra), a meta
// de hoje do motorista, ou recusava por resíduo ("não consegui ler: conta ate").
// O planejador as recusa por aqui e o roteador antigo responde com
// `cashObligationsUntil()`.
//
// Recebem texto já normalizado: minúsculo, sem acento, "ta" → "esta" e
// "pra"/"pro" → "para" — as duas normalizações do app fazem isso.

import { addDays, dateForDayOfMonth, fromISO, toISO } from '../utils/format'

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

/** "quanto preciso deixar…", "quanto tenho que separar…", "quanto devo ter…". */
const QUANTO_DEIXAR = /\bquanto\b.*\b(?:preciso|devo|tenho\s+(?:que|de)|teria\s+que)\s+(?:deixar|ter|manter|separar|reservar|segurar)\b/

/**
 * Sem prazo nem destino do dinheiro, "quanto preciso reservar" é pergunta de
 * META ("pra viagem", "por mês") — que tem outra resposta.
 */
// "pro dia 10" chega aqui como "para dia 10": a normalização engole o artigo.
const PRAZO_OU_CAIXA = /\b(?:ate|para|no)\s+(?:o\s+)?(?:dia\s+\d{1,2}|fim\s+do\s+mes|final\s+do\s+mes)\b|\bate\s+(?:amanha|o\s+fim|o\s+final)\b|\bparad[oa]\b|\bna\s+conta\b|\bem\s+caixa\b|\bdisponivel\b|\bpara\s+(?:as\s+|os\s+)?(?:contas|boletos)\b/
const PERGUNTA_DE_META = /\bmeta\b|\bpor\s+mes\b|\bpor\s+semana\b|\bjuntar\b/

export function pedeReservaDeCaixa(t: string): boolean {
  return QUANTO_DEIXAR.test(t) && PRAZO_OU_CAIXA.test(t) && !PERGUNTA_DE_META.test(t)
}

/**
 * "Quanto eu tenho guardado", "minha reserva tá em quanto", "quanto já guardei":
 * o TOTAL guardado até hoje, não o saldo em conta nem o guardado do mês. A
 * reserva é a soma das transferências `saving` (regra 5) e as metas guardam o
 * próprio valor. Pergunta com período ("esse ano") continua na consulta.
 */
export function pedeTotalGuardado(t: string): boolean {
  return /\bquanto\s+(?:eu\s+)?(?:tenho|tem|ha)\s+(?:de\s+)?(?:guardado|reservado|na\s+reserva|na\s+poupanca)\b|\breserva\s+(?:esta|ta)\s+em\s+quanto\b|\bquanto\s+(?:esta|ta)\s+(?:a\s+)?(?:minha\s+)?reserva\b|\bsaldo\s+da\s+reserva\b|\bquanto\s+(?:eu\s+)?ja\s+guardei\s*\??$/.test(t)
}

/** "Tirei 300 da reserva": não há lançamento de retirada no app. */
export const retiraDaReserva = (t: string): boolean =>
  /\b(?:tirei|retirei|saquei|peguei|usei)\b[^.?!]*\b(?:da|na)\s+(?:minha\s+)?(?:reserva|poupanca)\b/.test(t)

export type PerguntaDeFatura = 'falta' | 'paga' | 'atrasada' | 'vence' | 'fecha' | 'valor' | 'pagamentos'

/** Antecipação exige escolher a referência, ausente no contrato atual do chat. */
export const pedeAntecipacaoDeFatura = (t: string): boolean =>
  /\bfaturas?\b/.test(t) && /\bantecip\w*\b|\badiantei\b|\badiantar\b/.test(t)

/**
 * Situação da fatura de agora: quanto falta, se já foi paga, se atrasou, quando
 * vence ou fecha. "Quanto falta pagar DA FATURA" é o pendente dela — a DSL lia
 * "falta pagar" como parcelamento e respondia a dívida inteira do cartão. Fatura
 * futura ("mês que vem", "próximos meses", "maior fatura") fica com quem já a
 * responde. "Paguei a fatura" só é pergunta com "?" — sem ele, é registro.
 */
export function perguntaDeFatura(t: string): PerguntaDeFatura | null {
  if (!/\bfaturas?\b/.test(t)) return null
  if (/\bmaior\b|\bproxim[oa]s?\s+(?:\d+\s+|dois\s+|tres\s+|quatro\s+|cinco\s+|seis\s+)?meses\b|\bmes\s+que\s+vem\b|\bproximo\s+mes\b|\b(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(t)) return null
  // Data do desembolso, não vencimento nem situação de quitação.
  if (/\b(?:quando|que\s+dia)\b[^?]*\b(?:paguei|pagamos|quitei)\b|\bquando\s+(?:foi|fiz)\b[^?]*\bpagamento\b|\bdata\s+do\s+(?:ultimo\s+)?pagamento\b/.test(t)) return 'pagamentos'
  // "Quanto tenho de fatura pra pagar" e "quanto de fatura vence esse mês" são
  // o que falta, ditos de outro jeito.
  if (/\bquanto\b[^?]*\bfaturas?\b[^?]*\bvencem?\b|\bquanto\b[^?]*\bvencem?\b[^?]*\bfaturas?\b/.test(t)) return 'falta'
  if (/\bquanto\b[^?]*\b(?:falta|faltam|resta|restam)\b|\b(?:falta|resta)\s+(?:pagar|quitar)\b|\bquanto\s+(?:eu\s+)?(?:ainda\s+)?devo\s+d[ae]s?\s+(?:minhas?\s+)?faturas?\b/.test(t)
    || /\bquanto\b[^?]*\bfaturas?\b[^?]*\b(?:para|pra|a)\s+pagar\b|\bquanto\b[^?]*\b(?:para|pra|a)\s+pagar\b[^?]*\bfaturas?\b/.test(t)) return 'falta'
  if (/\batrasad|\bvencid|\bja\s+venceu\b/.test(t)) return 'atrasada'
  if (/\bfaturas?\b[^?]*\b(?:esta|foi|estao|foram)\s+(?:ja\s+)?pagas?\b|\bpague[iu]\b[^?]*\bfaturas?\b[^?]*\?|\bsera\s+que\s+(?:eu\s+)?(?:ja\s+)?pague[iu]\b/.test(t)) return 'paga'
  if (/\bquando\b[^?]*\bvence\b|\bvence\s+quando\b|\bque\s+dia\s+vence\b|\bvencimento\b/.test(t)) return 'vence'
  if (/\bfecha\b|\bfechou\b|\bfechamento\b|\bquando\b[^?]*\bvira\b|\bvira\s+quando\b/.test(t)) return 'fecha'
  // "Quanto tá a fatura": a de AGORA. O mês do calendário respondia a do C6
  // que já venceu e foi paga, e chamava de "previsão" uma fatura fechada.
  if (!/\bpassad[oa]\b|\banterior\b|\bultima\b|\b(?:esse|este)\s+ano\b/.test(t)
    && /\bquanto\s+(?:e|esta|vem|veio|ficou|deu|vai\s+(?:vir|ficar|dar))\s+(?:a\s+)?(?:minha\s+)?fatura\b|\bquanto\s+(?:e|esta|vem|veio|ficou|deu|vai\s+(?:vir|ficar|dar))\b[^?]*\bfatura\b|\bvalor\s+da\s+(?:minha\s+)?fatura\b|\bqual\s+(?:e\s+)?a\s+(?:minha\s+)?fatura\b/.test(t)) return 'valor'
  return null
}

/**
 * "Quanto falta pagar esse mês", "quanto falta de conta", "quanto ainda tenho
 * de conta pra pagar": o que AINDA vence. A DSL lia "falta pagar" como
 * parcelamento e respondia a dívida parcelada inteira, ou procurava um
 * parcelamento chamado "conta esse". Compra citada ("do computador") e fatura
 * ficam com quem já as responde.
 */
export function pedeContasAPagar(t: string): boolean {
  return /\bquanto\b[^?]*\b(?:falta|faltam|resta|restam)\s+(?:(?:eu\s+)?pagar\s+)?(?:de\s+|em\s+)?(?:conta|contas|boleto|boletos)\b/.test(t)
    || /\bquanto\b[^?]*\b(?:tenho|tem)\s+(?:de\s+|em\s+)?(?:conta|contas|boleto|boletos)\s+(?:para|a)\s+pagar\b/.test(t)
    || /\bquanto\s+(?:ainda\s+)?(?:me\s+)?(?:falta|resta)\s+(?:eu\s+)?pagar\s+(?:(?:esse|este|nesse|neste)\s+mes|ate\s+o\s+(?:fim|final)\s+do\s+mes)\s*\??$/.test(t)
}

export type PlanoDeGuardar =
  /** "quanto preciso guardar por mês pro X" (`viavel` false) ou "consigo juntar o X até dezembro?" (true). */
  | { kind: 'meta'; viavel: boolean }
  /** "quanto preciso guardar por mês pra ter 10 mil". */
  | { kind: 'valor'; valor: number }
  /** "quanto preciso guardar por mês", sem destino: a meta mensal. */
  | { kind: 'mensal' }

const GUARDAR = String.raw`(?:guardar|juntar|separar|poupar|economizar|reservar)`
const PRECISO = String.raw`(?:preciso|tenho\s+que|tenho\s+de|devo|teria\s+que|precisaria)`

/**
 * "Quanto PRECISO guardar por mês" é plano, não histórico — a consulta somava o
 * que já foi guardado, ou o resto da meta agrupado por mês ("o menor foi
 * jul/2026"). Qual meta é, quem acha é o roteador, que tem o estado. "Consigo
 * bater a meta esse mês?" é a meta MENSAL e fica com quem já responde.
 */
export function planoDeGuardar(t: string): PlanoDeGuardar | null {
  const consigo = /\b(?:consigo|conseguiria|vou\s+conseguir|da\s+para|e\s+possivel)\s+(?:completar|juntar|atingir|comprar|chegar|fechar|guardar)\b/.test(t)
  // "QUANDO consigo comprar" pede a data, e quem a projeta já responde.
  if (consigo && !/\bquando\b|\b(?:esse|este|nesse|neste)\s+mes\b|\bmeta\s+(?:de\s+hoje|do\s+dia|diaria|do\s+mes|mensal)\b/.test(t)) {
    return { kind: 'meta', viavel: true }
  }
  if (!new RegExp(String.raw`\bquanto\b[^?]*\b${PRECISO}\s+${GUARDAR}\b`).test(t)) return null
  const dito = t.match(/\b(?:ter|juntar|chegar\s+(?:a|em)|completar)\s+(?:r\$\s*)?(\d+(?:[.,]\d+)*)\s*(mil|k)?\b/)
  if (dito) {
    const bruto = dito[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')
    const valor = Number(bruto) * (dito[2] ? 1000 : 1)
    if (valor > 0) return { kind: 'valor', valor }
  }
  // Com destino ("pro notebook", "pra completar a viagem") é meta de compra;
  // sem destino, a meta mensal. "Pra" e "pro" já chegam como "para".
  if (/\bpara\s+(?!o\s+mes\b|ter\b)[a-z]/.test(t)) return { kind: 'meta', viavel: false }
  return /\bpor\s+mes\b|\bcada\s+mes\b|\bmensal(?:mente)?\b/.test(t) ? { kind: 'mensal' } : null
}

/**
 * Os meses de depósito até o prazo dito ("até dezembro", "em 6 meses", "até o
 * fim do ano") ou o prazo cadastrado na meta. O mês corrente conta quando ainda
 * tem 7 dias ou mais — e a resposta NOMEIA os meses, para a conta ficar à vista.
 */
export function mesesAtePrazo(t: string, hoje: string, prazoDaMeta?: string): string[] | null {
  const h = fromISO(hoje)
  const ultimoDia = new Date(h.getFullYear(), h.getMonth() + 1, 0).getDate()
  const inicio = ultimoDia - h.getDate() + 1 >= 7 ? 0 : 1
  const mes = (n: number) => toISO(new Date(h.getFullYear(), h.getMonth() + n, 1)).slice(0, 7)
  const ate = (fim: number) => Array.from({ length: Math.max(fim - inicio + 1, 1) }, (_, i) => mes(fim < inicio ? fim : inicio + i))
  const emMeses = t.match(/\bem\s+(\d{1,2})\s+mes(?:es)?\b/)
  if (emMeses && Number(emMeses[1]) > 0) return Array.from({ length: Math.min(Number(emMeses[1]), 60) }, (_, i) => mes(inicio + i))
  if (/\bate\s+o\s+(?:fim|final)\s+do\s+ano\b/.test(t)) return ate(11 - h.getMonth())
  const nome = t.match(/\bate\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/)
  if (nome) {
    const alvo = MESES.indexOf(nome[1])
    return ate(((alvo - h.getMonth()) + 12) % 12)
  }
  if (prazoDaMeta && prazoDaMeta >= hoje) {
    const p = fromISO(prazoDaMeta)
    return ate((p.getFullYear() - h.getFullYear()) * 12 + p.getMonth() - h.getMonth())
  }
  return null
}

/**
 * "Quanto falta pra trocar o óleo", "falta muito pra troca de óleo?": a PRÓXIMA
 * troca, que o roteador calcula pelo hodômetro. A DSL lia "falta" como
 * parcelamento e "km" como dias de trabalho. Quanto se GASTOU com a troca
 * continua sendo consulta.
 */
export function perguntaDeManutencao(t: string): boolean {
  if (/\b(?:gastei|gasto|gastou|paguei|custou|custa|custo)\b/.test(t)) return false
  return /\btroca\w*\b[^?]*\b(?:oleo|pneus?|pastilhas?|filtros?|correia)\b|\b(?:oleo|pneus?|pastilhas?|filtros?|correia)\b[^?]*\btroca\w*\b/.test(t)
}

/**
 * "Qual meu gasto fixo", "quais minhas contas fixas", "quanto pago de contas
 * fixas": o que se REPETE todo mês, não tudo o que saiu nem o que vence agora
 * (fatura entrava na lista). Prazo, vencimento e cobertura pelo saldo ficam com
 * quem já os responde.
 */
export function pedeContasFixas(t: string): boolean {
  if (/\bvenc|\bproxim|\bcobre|\batrasad|\bsaldo\b|\bdinheiro\b/.test(t)) return false
  return /\b(?:gastos?|custos?|despesas?|contas?)\s+fix[oa]s?\b/.test(t)
    && /\b(?:qual|quais|quanto|quanta|lista|listar|mostra|mostrar)\b|\?/.test(t)
}

const COMBUSTIVEL = String.raw`(?:a\s+|o\s+)?(?:gasolina|combustivel|etanol|alcool|gnv|abastecimentos?)\b`

/**
 * "Quanto fico por dia tirando a gasolina", "quanto sobra depois do
 * combustível": com verbo de SOBRA, "tirando" é descontar. A consulta lia
 * exclusão — tirava a gasolina das despesas e respondia o resto delas.
 */
export function pedeSobraSemCombustivel(t: string): boolean {
  const desconta = new RegExp(String.raw`\b(?:tirando|descontando|depois\s+d[aoe]s?|menos|pagando)\s+${COMBUSTIVEL}`)
  return /\b(?:sobra|sobram|sobrou|fico|fica|ficou|lucro|lucrei|lucra|liquido|limpo)\b/.test(t) && desconta.test(t)
    && !/\b(?:gastei|gasto|gastos|despesas?)\b/.test(t)
}

/**
 * "Como foi hoje?", "como foi meu dia", "foi bom?", "hoje foi fraco?": o dia
 * de hoje contra os outros dias. Caíam na ajuda genérica.
 */
export function pedeResumoDoDia(t: string): boolean {
  return /^\s*(?:e\s+)?como\s+(?:foi|esta|ficou|vai|anda)(?:\s+(?:(?:o\s+)?(?:meu\s+)?dia(?:\s+de\s+hoje)?|hoje))?\s*\??\s*$/.test(t)
    || /^\s*(?:e\s+)?(?:(?:o\s+)?(?:meu\s+)?dia\s+|hoje\s+)?(?:foi|esta|tava|estava)\s+(?:um\s+dia\s+)?(?:bom|boa|fraco|ruim|bem|razoavel|legal|forte)\s*(?:hoje)?\s*\??\s*$/.test(t)
}

/**
 * Pergunta TELEGRÁFICA, sem verbo nem número: "gastos dessa semana", "entradas
 * do mês", "saldo?". Caíam na ajuda genérica. Vira a pergunta com verbo que o
 * app já responde ("quanto gastei essa semana?"). Recebe o texto do usuário;
 * com dígito, é registro ("gasto 50 de luz") e fica como está.
 */
export function perguntaNominal(texto: string): string | null {
  if (/\d/.test(texto)) return null
  // Só minúscula: o resto da frase segue com os acentos dele ("Zé da esquina").
  const n = texto.toLowerCase().replace(/[?.!]+\s*$/, '').trim()
  const fim = String.raw`(?![\wà-ú])`
  if (new RegExp(String.raw`^(?:e\s+)?(?:o\s+|meu\s+)?saldo(?:\s+(?:atual|de\s+hoje|agora))?$`).test(n)) return 'qual meu saldo?'
  const m = n.match(/^(?:e\s+)?(?:(?:os|as|meus|minhas)\s+)?(gastos?|despesas?|sa[ií]das?|entradas?|receitas?|ganhos?)\s+(.+)$/)
  if (!m) return null
  const verbo = /^(?:gasto|despesa|sa[ií]da)/.test(m[1]) ? 'gastei' : 'recebi'
  const resto = m[2]
    .replace(new RegExp(String.raw`^de\s+(hoje|ontem)${fim}`), '$1')
    .replace(/^d(ess|est)([ea])\s+/, '$1$2 ')
    .replace(new RegExp(String.raw`^do\s+m[eê]s\s+passado${fim}`), 'no mês passado')
    .replace(new RegExp(String.raw`^do\s+m[eê]s${fim}`), 'esse mês')
    .replace(new RegExp(String.raw`^da\s+semana\s+passada${fim}`), 'na semana passada')
    .replace(new RegExp(String.raw`^da\s+semana${fim}`), 'essa semana')
    .replace(new RegExp(String.raw`^do\s+ano${fim}`), 'esse ano')
    .replace(new RegExp(String.raw`^de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)${fim}`), 'em $1')
  return `quanto ${verbo} ${resto}?`
}

/**
 * "Quanto eu tenho de limite no nubank", "qual o limite disponível": a DSL lia
 * "limite" como texto de busca nas faturas e respondia que não havia nada.
 */
export const pedeLimite = (t: string): boolean =>
  /\blimite\b/.test(t) && /\b(?:quanto|qual|quais|tenho|tem|sobra|sobrou|resta|disponivel|livre)\b/.test(t)

/**
 * "Qual a última parcela do nubank", "quando termino de pagar as parcelas": o
 * fim do parcelamento. A DSL somava o que falta pagar e o resumo dos cartões
 * respondia o resto. Sem a palavra "parcela" ("quando acaba a geladeira"), só
 * o nome do parcelamento diz o assunto, e quem decide isso é o roteador.
 */
export const pedeFimDoParcelamento = (t: string): boolean =>
  /\bultimas?\s+parcelas?\b/.test(t)
  || (/\bparcel/.test(t) && /\b(?:quando|que\s+mes|que\s+dia)\b[^?]*\b(?:acaba|acabam|termina|terminam|quita|quito|termino|acabo)\b/.test(t))

/**
 * "Tô devendo quanto", "quanto ainda devo", "qual minha dívida": a dívida toda.
 * A DSL lia "devo" como gasto e somava o mês. Fica de fora o que tem dono —
 * "devo do computador", "devendo no inter" — e o "devo" modal ("quanto devo
 * guardar"), que não é dívida.
 */
export const pedeDividaTotal = (t: string): boolean =>
  (/\b(?:quanto|qual|quais)\b/.test(t) || /\b(?:to|estou|esta)\s+devendo\b/.test(t)
    || /^(?:e\s+)?(?:eu\s+)?devo\s+muito\s*\??$/.test(t))
  && /\b(?:devo|devendo|dividas?)\b/.test(t)
  && !/\bdevo\s+(?:\w+\s+)?[a-z]+(?:ar|er|ir)\b/.test(t)
  && !/\b(?:devo|devendo|dividas?)\s+(?:(?:ainda|hoje|agora)\s+)?(?:d[oa]s?|n[oa]s?|com(?:\s+[oa]s?)?|pr[oa]s?|para(?:\s+[oa]s?)?|ao|a)\s+(?!(?:total|geral|todo|tudo|cartao|cartoes|banco|bancos)\b)[a-z]/.test(t)

/**
 * "Quais meus parcelamentos", "quantas parcelas faltam", "quanto parcelei no
 * nubank": a lista. A DSL dava só a soma do que falta, e o resumo dos cartões
 * não dizia quantas parcelas eram. Parcela de UMA compra ("quantas parcelas
 * faltam do computador") fica com a consulta.
 */
export const pedeListaDeParcelamentos = (t: string): boolean =>
  /\b(?:quais|lista|listar|liste|mostra|mostrar|quantos|meus)\b[^?]*\bparcelamentos\b/.test(t)
  || /\bquantas\s+parcelas\s+(?:eu\s+)?(?:tenho|faltam|restam|ainda)\b(?![^?]*\bd[oa]s?\s+[a-z])/.test(t)
  || /\bquanto\s+(?:eu\s+)?(?:ja\s+)?parcelei\b/.test(t)

/**
 * "Quanto posso gastar (por dia, hoje, esse mês)": quanto cabe no saldo.
 * "Quanto devo gastar por dia" é a mesma pergunta; a DSL lia a média do que já
 * foi gasto.
 */
export const pedeQuantoPossoGastar = (t: string): boolean =>
  /\bquanto\s+(?:eu\s+)?(?:posso|devo|deveria|da\s+para|consigo|poderia)\s+gastar\b|\bda\s+para\s+gastar\s+quanto\b/.test(t)

/** "Qual a maior parcela", "a parcela mais cara". */
export const pedeMaiorParcela = (t: string): boolean =>
  /\b(?:maior|mais\s+cara|mais\s+alta)\s+parcela\b|\bparcela\s+mais\s+(?:cara|alta)\b/.test(t)

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

/**
 * "Vale a pena rodar domingo?", "compensa trabalhar no sábado?": o dia da
 * semana perguntado (0 = domingo), ou `null`. Caía na ajuda genérica.
 */
export function diaDaSemanaPedido(t: string): number | null {
  const m = t.match(/\b(?:vale\s+a\s+pena|compensa|e\s+bom|da\s+para\s+ganhar\s+bem)\s+(?:eu\s+)?(?:rodar|trabalhar|sair|abrir)\s+(?:n[oa]s?\s+|d[ea]\s+|aos?\s+|as\s+)?(domingo|segunda|terca|quarta|quinta|sexta|sabado)s?\b/)
  return m ? DIAS_DA_SEMANA.indexOf(m[1]) : null
}

export type PerguntaDeConta = 'paga' | 'vence' | 'valor'

/**
 * Situação de UMA conta fixa citada pelo nome — quem acha o nome é o roteador,
 * que tem o estado. "Já paguei a luz?" só é pergunta com "?"; sem ele, é
 * registro. Fatura, meta e parcela ficam com quem já as responde.
 */
export function perguntaDeConta(t: string): PerguntaDeConta | null {
  if (/\bfaturas?\b|\bmetas?\b|\bparcel/.test(t)) return null
  if (/\bpague[iu]\b[^?]*\?|\b(?:esta|foi|estao|foram)\s+(?:ja\s+)?pag[ao]s?\b|\bpag[ao]\s*\?\s*$|\bpaguei\s+ou\s+nao\b/.test(t)) return 'paga'
  if (/\bquando\b[^?]*\bvence\b|\bvence\s+quando\b|\bque\s+dia\s+vence\b|\bvencimento\b/.test(t)) return 'vence'
  if (/\bquanto\s+(?:e|esta|vem|veio|fica|ficou|custa|deu)\b|\bvalor\s+d[ao]s?\b|\bqual\s+(?:e\s+)?o\s+valor\b/.test(t)) return 'valor'
  return null
}

/** "qual conta está me apertando", "qual das contas pesa mais", "qual boleto…". */
export function pedeContaQueAperta(t: string): boolean {
  return /\bqual\s+(?:das\s+|dos\s+|e\s+a\s+|e\s+o\s+)?(?:contas?|boletos?|compromissos?)\b.*\b(?:apertando|aperta|pesando|pesa|pesada|pesado|matando|sufocando)\b/.test(t)
}

/**
 * Até quando olhar o que vence: "essa semana", "até dia 10", "este mês".
 * Sem prazo dito, `padraoDias` — o mesmo horizonte que a resposta já usava.
 */
export function prazoDasContas(t: string, hoje: string, padraoDias: number): string {
  if (/\b(?:d?essa|d?esta|nessa|nesta|da)\s+semana\b|\bproxim[oa]s?\s+7\s+dias\b/.test(t)) return addDays(hoje, 7)
  const dito = alvoDaReserva(t, hoje)
  if (dito.kind === 'date') return dito.date
  // "Contas DO mês", "deste mês": o mesmo fim de mês — olhavam 15 dias.
  if (/\b(?:d?esse|d?este|nesse|neste|do)\s+mes\b/.test(t)) {
    const h = fromISO(hoje)
    return toISO(new Date(h.getFullYear(), h.getMonth() + 1, 0))
  }
  return addDays(hoje, padraoDias)
}

export type AlvoDaReserva =
  | { kind: 'date'; date: string }
  | { kind: 'invalid'; dia: number }
  | { kind: 'missing' }

/**
 * Data-limite da reserva. "Dia 10" sem mês é o PRÓXIMO dia 10 — é o que
 * qualquer pessoa entende; perguntar "de qual mês?" atrapalhava sem proteger
 * nada. Dia que o mês não tem (31 em novembro) vira o último dia do mês, a
 * mesma regra das contas recorrentes.
 */
export function alvoDaReserva(t: string, hoje: string): AlvoDaReserva {
  if (/\bamanha\b/.test(t)) return { kind: 'date', date: addDays(hoje, 1) }
  const h = fromISO(hoje)
  if (/\b(?:fim|final)\s+do\s+mes\b/.test(t)) {
    return { kind: 'date', date: toISO(new Date(h.getFullYear(), h.getMonth() + 1, 0)) }
  }
  const m = t.match(/\bdia\s+(\d{1,2})(?:\s+de\s+([a-z]+)|\s*\/\s*(\d{1,2}))?\b/)
  if (!m) return { kind: 'missing' }
  const dia = Number(m[1])
  const mesDito = m[2] ? MESES.indexOf(m[2]) : m[3] ? Number(m[3]) - 1 : -1
  if (dia < 1 || dia > 31 || (m[2] && mesDito < 0) || mesDito > 11) return { kind: 'invalid', dia }
  if (mesDito >= 0) {
    const neste = dateForDayOfMonth(h.getFullYear(), mesDito, dia)
    return { kind: 'date', date: toISO(neste < h ? dateForDayOfMonth(h.getFullYear() + 1, mesDito, dia) : neste) }
  }
  const neste = dateForDayOfMonth(h.getFullYear(), h.getMonth(), dia)
  return { kind: 'date', date: toISO(neste < h ? dateForDayOfMonth(h.getFullYear(), h.getMonth() + 1, dia) : neste) }
}
