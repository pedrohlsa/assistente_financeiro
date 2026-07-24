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
  { id: 'lazer', name: 'Lazer', type: 'expense', icon: '🎮' },
  { id: 'compras', name: 'Compras', type: 'expense', icon: '🛍️' },
  { id: 'outros-out', name: 'Outros', type: 'expense', icon: '📦' },
  // Reserva/investimento: usada só por lançamentos type:'saving' (14.3).
  // Arquivada para não aparecer como opção de despesa nos seletores.
  { id: 'reserva', name: 'Reserva', type: 'expense', icon: '🏦', archived: true },
]

export const catById = (cats: Category[], id: string): Category =>
  cats.find(c => c.id === id) || { id, name: id, type: 'expense', icon: '📦' }

// Palavras-chave para categorização inteligente (seção 12)
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  combustivel: ['gasolina', 'etanol', 'alcool', 'álcool', 'diesel', 'gnv', 'posto', 'shell', 'ipiranga', 'petrobras', 'br ', 'abasteci', 'combustivel', 'combustível'],
  alimentacao: ['almoço', 'almoco', 'janta', 'jantar', 'lanche', 'comida', 'ifood', 'restaurante', 'padaria', 'mercado', 'café', 'cafe', 'marmita', 'pizza', 'burger', 'açaí', 'acai'],
  manutencao: ['óleo', 'oleo', 'pneu', 'freio', 'pastilha', 'revisão', 'revisao', 'mecânico', 'mecanico', 'oficina', 'peça', 'peca', 'filtro', 'vela', 'correia', 'amortecedor', 'manutenção', 'manutencao', 'lavagem', 'lava'],
  estacionamento: ['estacionamento', 'estacionei', 'zona azul', 'parquímetro', 'parquimetro'],
  pedagio: ['pedágio', 'pedagio', 'sem parar', 'veloe', 'conectcar'],
  assinaturas: ['netflix', 'spotify', 'assinatura', 'plano', 'internet', 'celular', 'amazon prime', 'disney', 'hbo', 'globoplay', 'youtube premium'],
  casa: ['aluguel', 'luz', 'energia', 'água', 'agua', 'gás', 'gas', 'condomínio', 'condominio', 'iptu'],
  lazer: ['cinema', 'bar', 'balada', 'show', 'jogo', 'festa', 'cerveja', 'passeio'],
  compras: ['roupa', 'tênis', 'tenis', 'shopping', 'loja', 'presente', 'farmácia', 'farmacia'],
  corridas: ['corrida', 'uber', '99', 'indriver', 'app', 'viagem', 'passageiro'],
  salario: ['salário', 'salario', 'pagamento', 'holerite'],
  aluguel: ['aluguel', 'aluguéis', 'alugueis', 'inquilino', 'locação', 'locacao', 'imóvel', 'imovel', 'casa alugada'],
  freelance: ['freela', 'freelance', 'bico', 'job'],
  vendas: ['venda', 'vendi'],
}

export function guessCategory(text: string, type: 'income' | 'expense'): string | undefined {
  const t = text.toLowerCase()
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => t.includes(w))) {
      const isIncomeCat = ['corridas', 'salario', 'aluguel', 'freelance', 'vendas'].includes(cat)
      if ((type === 'income') === isIncomeCat) return cat
    }
  }
  return undefined
}
