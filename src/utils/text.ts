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
