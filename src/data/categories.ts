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
  { id: 'aluguel-veiculo', name: 'Locação de veículo', type: 'expense', icon: '🚙' },
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
  combustivel: ['gasolin', 'gazolin', 'gasolna', 'etanol', 'alcool', 'álcool', 'diesel', 'dizel', 'disel', 'gnv', 'gás veicular', 'gas veicular', 'gás do carro', 'posto ', 'postos', 'shell', 'ipiranga', 'petrobras', 'br ', 'abasteci', 'combustivel', 'combustível', 'combustievl'],
  obra: ['cimento', 'areia', 'tijolo', 'bloco', 'brita', 'argamassa', 'rejunte', 'telha', 'madeira', 'vergalhão', 'vergalhao', 'material de construção', 'material de construcao', 'obra ', 'obras', 'construção', 'construcao', 'reforma', 'pedreiro'],
  // 'almocei' e 'jantei' cobrem o verbo: "quanto almocei esse mês" é
  // Alimentação, e sem eles a pergunta dava o gasto do mês inteiro.
  alimentacao: ['mcdonald', 'mc donald', 'burger', 'subway', 'habib', 'pizza', 'lanchonete', 'acai', 'açaí', 'almoço', 'almoco', 'almocei', 'almoçar', 'almocar', 'lanchar', 'lanchei', 'almoçamos', 'almocamos', 'janta', 'jantar', 'jantei', 'jantamos', 'lanche', 'comida', 'ifood', 'restaurante', 'padaria', 'mercad', 'supermercad', 'minimercad', 'hipermercad', 'mercearia', 'sacolão', 'sacolao', 'quitanda', 'café', 'cafe', 'marmita', 'marmitex', 'quentinha', 'prato feito', 'pastel', 'esfirra', 'espetinho', 'churrasco', 'refrigerante', 'refri ', 'sanduíche', 'sanduiche', 'cachorro quente', 'x tudo', 'x salada', 'x bacon', 'x egg', 'x burg', 'tapioca', 'cuscuz', 'pizza', 'burger', 'hamb', 'salgad', 'coxinha', 'açaí', 'acai', 'sorvete', 'pão', 'pao ', 'paes', 'pães', 'pãozinho', 'paozinho', 'leite', 'queijo', 'ovos', 'carne', 'frango', 'arroz', 'feijão', 'feijao', 'fruta', 'verdura', 'açougue', 'acougue', 'hortifruti'],
  'aluguel-veiculo': [
    'aluguel do carro', 'aluguel de carro', 'aluguel do veículo', 'aluguel de veículo', 'aluguel do veiculo', 'aluguel de veiculo',
    'aluguel da moto', 'aluguel de moto', 'diária do carro', 'diaria do carro', 'diária de carro', 'diaria de carro',
    'diária do veículo', 'diaria do veiculo', 'diária da moto', 'diaria da moto',
    'locação de carro', 'locacao de carro', 'locação do carro', 'locacao do carro', 'locação de veículo', 'locacao de veiculo',
  ],
  manutencao: ['óleo', 'oleo', 'pneu', 'freio', 'pastilha', 'revisão', 'revisao', 'mecânico', 'mecanico', 'oficina', 'borracheiro', 'borracharia', 'funilaria', 'lanternagem', 'alinhamento', 'balanceamento', 'calibragem', 'peça ', 'peca ', 'peças', 'pecas', 'autopeça', 'autopeca', 'filtro', 'vela ', 'velas', 'correia', 'amortecedor', 'manutenção', 'manutencao', 'lavagem', 'lava ', 'lava jato'],
  estacionamento: ['estacionamento', 'estacionei', 'flanelinha', 'flanela ', 'zona azul', 'parquímetro', 'parquimetro'],
  pedagio: ['pedágio', 'pedagio', 'sem parar', 'veloe', 'conectcar'],
  assinaturas: ['netflix', 'spotify', 'assinatura', 'plano', 'internet', 'celular', 'amazon prime', 'disney', 'hbo', 'globoplay', 'youtube premium'],
  // "gás" sozinho NÃO entra aqui: é ambíguo (cozinha ou GNV) e o assistente
  // pergunta em vez de escolher — ver isAmbiguousGas() em services/nlp.ts.
  casa: ['aluguel', 'luz ', 'energia', 'água ', 'agua ', 'gás de cozinha', 'gas de cozinha', 'botijão', 'botijao', 'glp', 'condomínio', 'condominio', 'iptu'],
  lazer: ['cinema', 'bar ', 'bares', 'barzinho', 'balada', 'show ', 'shows', 'jogo', 'festa', 'cerveja', 'passeio'],
  compras: ['roupa', 'tênis', 'tenis', 'shopping', 'loja', 'presente', 'farmácia', 'farmacia', ' camisa', ' camiseta', ' blusa', ' bermuda', ' vestido', ' sapato', ' chinelo', ' sandália', ' sandalia'],
  autocuidado: ['autocuidado', 'auto cuidado', 'cabeleireiro', 'barbeiro', 'barbearia', 'salão', 'salao', 'manicure', 'pedicure', 'cosmético', 'cosmetico', 'skincare', 'academia'],
  corridas: ['corrida', 'uber', '99 ', 'indriver', 'app ', 'aplicativo', 'viagem', 'passageiro'],
  // "Recebi o vale": o adiantamento do salário (vale-refeição também é do emprego).
  salario: ['salário', 'salario', 'pagamento', 'holerite', 'vale ', 'adiantamento', 'decimo terceiro', 'décimo terceiro', '13o salario', 'ferias', 'férias'],
  aluguel: ['aluguel', 'aluguéis', 'alugueis', 'inquilino', 'locação', 'locacao', 'imóvel', 'imovel', 'casa alugada'],
  freelance: ['freela', 'freelance', 'bico', 'job', 'faxina', 'diaria', 'diária', 'servico ', 'serviço ', 'conserto', 'manicure em', 'aula particular'],
  vendas: ['venda', 'vendi', 'sinal ', 'encomenda', 'comissao', 'comissão'],
  // Por último: só decide quando nada mais específico casou. São palavras que
  // SÃO despesa por natureza ("taxa 5", "boleto 300") — sem elas a frase
  // telegráfica caía na ajuda, porque número com substantivo desconhecido não
  // vira gasto (é o que impede "casa 1" de virar R$ 1,00).
  'outros-out': [' taxa', ' tarifa', ' multa', ' boleto', ' juros', ' anuidade'],
}

export function guessCategory(text: string, type: 'income' | 'expense'): string | undefined {
  // O espaço no começo deixa palavra-chave exigir início de palavra: " pao"
  // casa "pao de queijo", nunca "japao".
  // Toda palavra-chave casa no INÍCIO de uma palavra: no meio, 'posto' achava
  // "imposto", 'obra' achava "cobraram" e 'bar' achava "embarque". As curtas
  // terminam em espaço e só casam a palavra inteira ("bar ", não "barbeiro").
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => t.includes(w.startsWith(' ') ? w : ` ${w}`))) {
      const isIncomeCat = ['corridas', 'salario', 'aluguel', 'freelance', 'vendas'].includes(cat)
      if ((type === 'income') === isIncomeCat) return cat
    }
  }
  return undefined
}
