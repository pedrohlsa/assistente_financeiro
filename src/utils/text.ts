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
  const i = t.search(/[a-zà-öø-ÿ0-9]/)
  if (i < 0) return t
  return t.slice(0, i) + t[i].toUpperCase() + t.slice(i + 1)
}

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
