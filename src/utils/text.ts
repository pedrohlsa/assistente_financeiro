// Helpers de texto compartilhados — capitalização de exibição e comparação de nomes.
// Regra do app: o texto original digitado pelo usuário NUNCA é reescrito no
// armazenamento; a capitalização acontece só na camada de apresentação (ou ao
// criar uma descrição canônica pelo parser).

/**
 * Sentence case para exibição: só a primeira letra vira maiúscula.
 * Se o texto JÁ tem alguma maiúscula, ele é devolvido intacto — assim "GNV",
 * "iPhone" e "Nubank (Cirinha)" nunca são estragados.
 */
export function sentenceCase(s?: string | null): string {
  if (!s) return ''
  const t = String(s).trim()
  if (!t) return ''
  if (/[A-ZÀ-ÖØ-Þ]/.test(t)) return t
  // Sigla digitada em minúsculas é sigla: "iptu" vira "IPTU", nunca "Iptu".
  const u = t.replace(SIGLAS, m => m.toUpperCase()).replace(MARCAS, m => MARCA_GRAFIA[m.toLowerCase()] || m)
  // A primeira LETRA decide: depois de "IPTU" a frase já começou, e procurar
  // a primeira minúscula escrevia "IPTU Da casa 2".
  const i = u.search(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/)
  if (i < 0 || u[i] !== u[i].toLowerCase()) return u
  // A marca que começa em minúscula fica como é: "iFood", não "IFood".
  if (Object.values(MARCA_GRAFIA).some(m => u.startsWith(m, i))) return u
  return u.slice(0, i) + u[i].toUpperCase() + u.slice(i + 1)
}

/** Siglas comuns em lançamentos. Só palavras que nunca são palavra comum. */
/** Marcas com grafia própria: "ifood" é "iFood", nunca "Ifood". */
const MARCA_GRAFIA: Record<string, string> = { ifood: 'iFood', iphone: 'iPhone', ipad: 'iPad' }
const MARCAS = /(?<![\wÀ-ÿ])(?:ifood|iphone|ipad)(?![\wÀ-ÿ])/gi
const SIGLAS = /(?<![\wÀ-ÿ])(?:iptu|ipva|inss|fgts|cnh|dpvat|darf|gnv|mei|irpf|cpf|cnpj)(?![\wÀ-ÿ])/g

/**
 * Chave de comparação de nomes: minúsculas, sem acento, sem espaço duplicado.
 * "Casa", "casa", "  Cása" e "CASA" viram a mesma chave.
 */
export function normalizeName(s?: string | null): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Dois nomes são equivalentes para efeito de aviso de duplicidade? */
export const sameName = (a?: string | null, b?: string | null): boolean => {
  const x = normalizeName(a)
  return !!x && x === normalizeName(b)
}

/** A conversa é texto simples; remove marcas que modelos às vezes devolvem. */
export function plainChatText(s?: string | null): string {
  return String(s || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

// ---------- DIAS DA SEMANA ----------
// O índice 0–6 é detalhe do JavaScript e NUNCA aparece para o usuário: a
// interface sempre mostra o nome. Abreviação só onde o espaço aperta.
export const WEEKDAY_NAMES = [
  'Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado',
] as const

export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const

export const weekdayName = (i: number): string => WEEKDAY_NAMES[((i % 7) + 7) % 7]
export const weekdayShort = (i: number): string => WEEKDAY_SHORT[((i % 7) + 7) % 7]

/**
 * "Toda segunda-feira", "Toda segunda, quarta e sexta-feira".
 * Só o último nome mantém o sufixo "-feira", como se fala em pt-BR.
 */
export function weekdayList(days: number[]): string {
  const uniq = [...new Set(days.map(d => ((d % 7) + 7) % 7))].sort()
  if (!uniq.length) return ''
  const names = uniq.map((d, i) =>
    i === uniq.length - 1 ? weekdayName(d).toLowerCase() : weekdayName(d).toLowerCase().replace('-feira', ''))
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`
}

/**
 * Uma célula de CSV, pronta para ir para dentro do arquivo.
 *
 * As aspas do formato protegem o SEPARADOR, não o conteúdo: uma descrição que
 * começa com `=`, `+`, `-` ou `@` continua sendo interpretada como FÓRMULA ao
 * abrir no Excel, no LibreOffice ou no Sheets. O usuário exporta as
 * movimentações e manda para o contador, para a família, para o banco — e
 * `=HYPERLINK(...)` ou a sintaxe DDE do Excel executam na máquina de quem
 * recebeu. O texto pode nem ter sido ele que escreveu: um backup mesclado
 * carrega descrição de outro estado.
 *
 * A proteção é a padrão para este formato: um apóstrofo na frente, que as
 * planilhas consomem como marca de "isto é texto". O conteúdo continua legível
 * e nada é apagado.
 */
/**
 * Texto do usuario indo para um PROMPT. Terceiro destino perigoso da regra 47,
 * ao lado do prompt de sistema (que o servidor ja protege) e do CSV.
 *
 * Colapsa quebra de linha, tabulacao e caractere de controle em espaco simples
 * e corta no limite: o prompt e montado por LINHAS, e uma quebra no meio de um
 * nome escrito pelo usuario da a ele a forma de uma instrucao nova.
 *
 * O servidor tem a sua propria copia disto, de proposito. Protecao que so
 * existe no cliente e protecao que some quando alguem chama a API direto.
 */
export function promptSafe(v: unknown, max = 60): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

export function csvCell(v: unknown): string {
  const bruto = String(v ?? '')
  // Tab e retorno de carro no começo também abrem espaço para a fórmula: a
  // planilha os ignora e passa a ler o `=` seguinte.
  const limpo = bruto.replace(/^[\t\r\n]+/, '')
  const perigoso = /^[=+\-@]/.test(limpo)
  const conteudo = perigoso ? `'${limpo}` : bruto
  return `"${conteudo.replace(/"/g, '""')}"`
}
