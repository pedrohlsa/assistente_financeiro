// ALEGAÇÃO DE EXECUÇÃO — o texto só diz que aconteceu o que de fato aconteceu.
//
// Na seleção de modelo (19/09/2026) o modelo escolhido escreveu, com a ação
// ainda PENDENTE na tela: "Anotei os R$ 900,00…", "Registrei o abastecimento de
// R$ 120,00", "Já anotei…". Nada tinha sido gravado — a execução só acontece no
// Confirmar (regra 8). Isso não pode depender do modelo: a barreira olha o
// ESTADO da ação, não a vontade do texto.
//
//   proposta pendente  → o texto não afirma execução; vira "preparei";
//   nada proposto      → o texto não afirma execução; vira "entendi";
//   confirmado e gravado → "Registrado!" é a verdade (mensagem do app);
//   falha na execução  → "Não registrei nada" (mensagem do app).
//
// Só a PRIMEIRA PESSOA do assistente é reescrita: "você disse que já registrou"
// fala do usuário, e "não registrei nada" já é a verdade.

export type EstadoDaAcao = 'pendente' | 'nada-proposto'

/** Verbo de execução na primeira pessoa, com o "já" que costuma vir antes. */
const PRIMEIRA_PESSOA = /\b(j[áa]\s+)?(registrei|anotei|lancei|salvei|gravei|confirmei)\b/gi
/** Ação irreversível: "preparei" não cabe; o texto passa a oferecer, não a afirmar. */
const IRREVERSIVEL = /\b(j[áa]\s+)?(transferi|apaguei|deletei|exclu[íi])(?![\wÀ-ÿ])/gi
const OFERTA: Record<string, string> = { transferi: 'posso transferir', apaguei: 'posso apagar', deletei: 'posso apagar', 'excluí': 'posso excluir', exclui: 'posso excluir' }
/** Passiva que afirma o fato consumado: "foi registrada", "já estão lançados". */
const PASSIVA = /\b(?:j[áa]\s+)?(foi|foram|est[áa]|est[ãa]o|ficou|ficaram)\s+(registrad|lan[çc]ad|anotad|salv|gravad|confirmad|transferid|apagad)(a|o|as|os)\b/gi
/** Negação logo antes: "não registrei", "ainda não foi lançado", "nada foi salvo". */
const NEGADO = /\b(?:n[ãa]o|nada|nunca|sem|nenhum[a]?)\b[^.!?\n]{0,12}$/i

const maiuscula = (s: string, como: string) => (/^[A-ZÁÉÍÓÚÂÊÔÃÕ]/.test(como) ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Tira do texto remoto toda afirmação de que a ação JÁ aconteceu. Só troca o
 * verbo: valor, descrição e o resto da frase ficam como o modelo escreveu.
 */
export function semAlegacaoDeExecucao(texto: string, estado: EstadoDaAcao): string {
  const negadoAntes = (s: string, i: number) => NEGADO.test(s.slice(Math.max(0, i - 24), i))
  const verbo = estado === 'pendente' ? 'preparei' : 'entendi'
  let out = texto.replace(PRIMEIRA_PESSOA, (m, _ja, _v, i: number, s: string) =>
    (negadoAntes(s, i) ? m : maiuscula(verbo, m)))
  out = out.replace(IRREVERSIVEL, (m, _ja, v: string, i: number, s: string) =>
    (negadoAntes(s, i) ? m : maiuscula(OFERTA[v.toLowerCase()] || 'posso fazer isso', m)))
  out = out.replace(PASSIVA, (m, aux: string, _p, g: string, i: number, s: string) => {
    if (negadoAntes(s, i)) return m
    const plural = /[ãa]o$|foram|ficaram/i.test(aux) || g.length === 2
    const pronto = `pront${g}`
    const frase = estado === 'pendente'
      ? `${plural ? 'estão' : 'está'} ${pronto} para você confirmar`
      : `ainda não ${plural ? 'foram registrad' : 'foi registrad'}${g}`
    return maiuscula(frase, m)
  })
  return out
}

/**
 * Texto do app DEPOIS do Confirmar. É aqui, e só aqui, que "registrado" pode
 * ser dito — e só se o lote atômico foi de fato gravado.
 */
export function mensagemDaExecucao(gravado: boolean, okCount: number, falhas: { message: string }[]): string {
  if (gravado) return okCount > 1 ? `Registrado! ✅ ${okCount} lançamentos salvos.` : 'Registrado! ✅'
  // Atômico: nada foi salvo. A mensagem diz exatamente o que travou.
  return 'Não registrei nada ainda — o lote inteiro depende de todos os itens.\n\n'
    + falhas.map(f => `• ${f.message}`).join('\n')
    + '\n\nCorrija ou remova esse item e confirme de novo.'
}
