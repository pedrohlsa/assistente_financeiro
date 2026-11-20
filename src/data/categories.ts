import { Category } from '../models/types'

export const DEFAULT_CATEGORIES: Category[] = [
  // Receitas
  { id: 'corridas', name: 'Corridas', type: 'income', icon: '🚗' },
  { id: 'salario', name: 'Salário', type: 'income', icon: '💼' },
  { id: 'aluguel', name: 'Aluguéis', type: 'income', icon: '🔑' },
  { id: 'freelance', name: 'Freelance', type: 'income', icon: '🧑‍💻' },
  { id: 'vendas', name: 'Vendas', type: 'income', icon: '🏷️' },
  { id: 'outros-in', name: 'Outros', type: 'income', icon: '💰' },
  // Despesas
  { id: 'combustivel', name: 'Combustível', type: 'expense', icon: '⛽' },
  { id: 'alimentacao', name: 'Alimentação', type: 'expense', icon: '🍔' },
  { id: 'manutencao', name: 'Manutenção', type: 'expense', icon: '🔧' },
  { id: 'estacionamento', name: 'Estacionamento', type: 'expense', icon: '🅿️' },
  { id: 'pedagio', name: 'Pedágio', type: 'expense', icon: '🛣️' },
  { id: 'assinaturas', name: 'Assinaturas', type: 'expense', icon: '📱' },
  { id: 'casa', name: 'Casa', type: 'expense', icon: '🏠' },
  { id: 'obra', name: 'Obra e construção', type: 'expense', icon: '🧱' },
  { id: 'lazer', name: 'Lazer', type: 'expense', icon: '🎮' },
  { id: 'compras', name: 'Compras', type: 'expense', icon: '🛍️' },
  { id: 'autocuidado', name: 'Autocuidado', type: 'expense', icon: '🧴' },
  { id: 'outros-out', name: 'Outros', type: 'expense', icon: '📦' },
  // Reserva/investimento: usada só por lançamentos type:'saving' (14.3).
  // Arquivada para não aparecer como opção de despesa nos seletores.
  { id: 'reserva', name: 'Reserva', type: 'expense', icon: '🏦', archived: true },
]

export const catById = (cats: Category[], id: string): Category =>
  cats.find(c => c.id === id) || { id, name: id, type: 'expense', icon: '📦' }

/**
 * Categorias que o app pode OFERECER hoje: arquivada some dos seletores, e
 * `reserva` é a exceção histórica (só `type: 'saving'` a usa, e ela nasce
 * arquivada justamente para não aparecer como despesa).
 *
 * Fonte única de propósito. `buildCapabilities` usava este filtro inline e o
 * aprendizado usava outro (só "a categoria existe?"): o resultado é que o
 * aprendizado propunha uma categoria arquivada, a validação recusava por
 * categoria inexistente e o lançamento inteiro sumia.
 */
export const usableCategories = (cats: Category[]): Category[] =>
  cats.filter(c => !c.archived || c.id === 'reserva')

/**
 * Funde as categorias padrão nas categorias já salvas do usuário.
 * - preserva TODAS as categorias atuais, inclusive personalizadas e arquivadas;
 * - acrescenta apenas as padrão que faltam, comparando por `id`;
 * - nunca duplica, nunca renomeia o que o usuário já tem, nunca apaga histórico.
 * Sem isso, quem já usava o app nunca receberia uma categoria padrão nova.
 */
export function mergeDefaultCategories(current?: Category[] | null): Category[] {
  if (!current?.length) return DEFAULT_CATEGORIES
  const known = new Set(current.map(c => c.id))
  const missing = DEFAULT_CATEGORIES.filter(c => !known.has(c.id))
  return missing.length ? [...current, ...missing] : current
}

// Palavras-chave para categorização inteligente (seção 12).
// A ORDEM importa: a primeira categoria cujo termo aparecer no texto ganha.
// Por isso "obra" vem antes de "casa" (cimento/reforma não é conta de casa) e
// "combustivel" vem antes de tudo que possa casar com "gás".
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  // Os termos são RADICAIS de propósito: 'gasolin'/'gazolin' cobrem a grafia
  // certa e o erro de digitação de sempre ("gazolina"), que antes mandava o
  // gasto para "outros" e sumia do custo de combustível do motorista.
  combustivel: ['gasolin', 'gazolin', 'gasolna', 'etanol', 'alcool', 'álcool', 'diesel', 'dizel', 'disel', 'gnv', 'gás veicular', 'gas veicular', 'gás do carro', 'posto', 'shell', 'ipiranga', 'petrobras', 'br ', 'abasteci', 'combustivel', 'combustível', 'combustievl'],
  obra: ['cimento', 'areia', 'tijolo', 'bloco', 'brita', 'argamassa', 'rejunte', 'telha', 'madeira', 'vergalhão', 'vergalhao', 'material de construção', 'material de construcao', 'obra', 'construção', 'construcao', 'reforma', 'pedreiro'],
  // 'almocei' e 'jantei' cobrem o verbo: "quanto almocei esse mês" é
  // Alimentação, e sem eles a pergunta dava o gasto do mês inteiro.
  alimentacao: ['almoço', 'almoco', 'almocei', 'almoçamos', 'almocamos', 'janta', 'jantar', 'jantei', 'jantamos', 'lanche', 'comida', 'ifood', 'restaurante', 'padaria', 'mercad', 'mercearia', 'sacolão', 'sacolao', 'quitanda', 'café', 'cafe', 'marmita', 'pizza', 'burger', 'hamb', 'salgado', 'coxinha', 'açaí', 'acai', 'sorvete', 'pão', ' pao', 'leite', 'queijo', 'ovos', 'carne', 'frango', 'arroz', 'feijão', 'feijao', 'fruta', 'verdura', 'açougue', 'acougue', 'hortifruti'],
  manutencao: ['óleo', 'oleo', 'pneu', 'freio', 'pastilha', 'revisão', 'revisao', 'mecânico', 'mecanico', 'oficina', 'peça', 'peca', 'filtro', 'vela', 'correia', 'amortecedor', 'manutenção', 'manutencao', 'lavagem', 'lava'],
  estacionamento: ['estacionamento', 'estacionei', 'zona azul', 'parquímetro', 'parquimetro'],
  pedagio: ['pedágio', 'pedagio', 'sem parar', 'veloe', 'conectcar'],
  assinaturas: ['netflix', 'spotify', 'assinatura', 'plano', 'internet', 'celular', 'amazon prime', 'disney', 'hbo', 'globoplay', 'youtube premium'],
  // "gás" sozinho NÃO entra aqui: é ambíguo (cozinha ou GNV) e o assistente
  // pergunta em vez de escolher — ver isAmbiguousGas() em services/nlp.ts.
  casa: ['aluguel', 'luz', 'energia', 'água', 'agua', 'gás de cozinha', 'gas de cozinha', 'botijão', 'botijao', 'glp', 'condomínio', 'condominio', 'iptu'],
  lazer: ['cinema', 'bar', 'balada', 'show', 'jogo', 'festa', 'cerveja', 'passeio'],
  compras: ['roupa', 'tênis', 'tenis', 'shopping', 'loja', 'presente', 'farmácia', 'farmacia'],
  autocuidado: ['autocuidado', 'auto cuidado', 'cabeleireiro', 'barbeiro', 'barbearia', 'salão', 'salao', 'manicure', 'pedicure', 'cosmético', 'cosmetico', 'skincare', 'academia'],
  corridas: ['corrida', 'uber', '99', 'indriver', 'app', 'viagem', 'passageiro'],
  salario: ['salário', 'salario', 'pagamento', 'holerite'],
  aluguel: ['aluguel', 'aluguéis', 'alugueis', 'inquilino', 'locação', 'locacao', 'imóvel', 'imovel', 'casa alugada'],
  freelance: ['freela', 'freelance', 'bico', 'job'],
  vendas: ['venda', 'vendi'],
}

export function guessCategory(text: string, type: 'income' | 'expense'): string | undefined {
  // O espaço no começo deixa palavra-chave exigir início de palavra: " pao"
  // casa "pao de queijo", nunca "japao".
  const t = ` ${text.toLowerCase()}`
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => t.includes(w))) {
      const isIncomeCat = ['corridas', 'salario', 'aluguel', 'freelance', 'vendas'].includes(cat)
      if ((type === 'income') === isIncomeCat) return cat
    }
  }
  return undefined
}
