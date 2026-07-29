// Campos editáveis de uma proposta — derivados do CATÁLOGO, não escritos à mão.
//
// A folha de edição era uma lista digitada dentro do componente e ficou para
// trás: `name`, `months`, `item`, `lifeKm`, `pricePerLiter`, `firstDueDate` e o
// `source` da entrada financiada não apareciam, e a ação de hodômetro não tinha
// campo nenhum — só a data. Derivar de `ACTION_CATALOG` faz esse tipo de
// defasagem deixar de ser possível: ação nova nasce editável.
//
// A validação continua sendo `validateAction()`, a mesma do servidor e do
// cliente. Este módulo só descreve os controles.

import type { ParsedAction } from '../models/types'
import type { ActionFieldSpec, AssistantCapabilities } from './contracts'
import { actionSpec } from './contracts'

export type EditControl = 'money' | 'number' | 'text' | 'select' | 'date' | 'flag'

export interface EditableField {
  name: string
  label: string
  control: EditControl
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  maxLength?: number
  /** Campo de PREVISÃO: data futura é legítima (ex.: `firstDueDate`). */
  allowsFuture?: boolean
}

const LABELS: Record<string, string> = {
  amount: 'Valor', total: 'Valor total', cost: 'Custo', target: 'Valor alvo',
  netReceived: 'Recebido agora', value: 'Hodômetro',
  description: 'Descrição', origin: 'Origem', category: 'Categoria',
  cardName: 'Cartão', name: 'Nome', months: 'Prazo em meses',
  item: 'Peça trocada', lifeKm: 'Vida útil em km',
  km: 'Km', trips: 'Viagens', hours: 'Horas', liters: 'Litros',
  pricePerLiter: 'Preço por litro', odometer: 'Hodômetro',
  installments: 'Parcelas', firstDueDate: 'Primeiro vencimento',
  source: 'Intermediário', date: 'Data',
}

/** Metas existentes viram lista: `goal-update` e `goal-deposit` exigem uma. */
const PICKS_EXISTING_GOAL = new Set(['goal-update', 'goal-deposit'])

function controlFor(kind: string, f: ActionFieldSpec, caps: AssistantCapabilities): EditControl {
  if (f.categoryOf) return 'select'
  if (f.name === 'cardName') return caps.cardNames.length ? 'select' : 'text'
  if (f.name === 'name') return PICKS_EXISTING_GOAL.has(kind) && caps.goalNames.length ? 'select' : 'text'
  switch (f.type) {
    case 'money': return 'money'
    case 'int':
    case 'quantity': return 'number'
    case 'date': return 'date'
    case 'flag': return 'flag'
    default: return 'text'
  }
}

function optionsFor(kind: string, f: ActionFieldSpec, caps: AssistantCapabilities) {
  if (f.categoryOf) {
    return caps.categories
      .filter(c => c.type === f.categoryOf)
      .map(c => ({ value: c.id, label: c.name }))
  }
  if (f.name === 'cardName') return caps.cardNames.map(n => ({ value: n, label: n }))
  if (f.name === 'name' && PICKS_EXISTING_GOAL.has(kind)) return caps.goalNames.map(n => ({ value: n, label: n }))
  return undefined
}

/**
 * Todos os campos que o catálogo declara para esta ação, na ordem do catálogo.
 * Campo ausente na ação também aparece — é assim que o usuário CORRIGE o que o
 * parser não pegou (uma origem que ficou de fora, um prazo que faltou).
 */
export function editableFieldsFor(action: ParsedAction, caps: AssistantCapabilities): EditableField[] {
  const spec = actionSpec(action.kind)
  if (!spec) return []
  return spec.fields.map(f => {
    const campo: EditableField = {
      name: f.name,
      label: LABELS[f.name] || f.name,
      control: controlFor(spec.kind, f, caps),
      min: f.min,
      max: f.max,
      maxLength: f.maxLength,
    }
    const opts = optionsFor(spec.kind, f, caps)
    if (opts) campo.options = opts
    if (f.type === 'date') campo.allowsFuture = !f.notFuture
    return campo
  })
}

/** Converte o texto do formulário para o tipo que `validateAction` espera. */
export function coerceEditValue(field: EditableField, raw: string): unknown {
  if (raw === '') return undefined
  if (field.control === 'number' || field.control === 'money') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : NaN
  }
  if (field.control === 'flag') return raw === 'true'
  return raw
}
