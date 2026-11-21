// "Como foi ontem?", "ontem rendeu bem?", "hoje tá fraco?".
//
// A pergunta de AVALIAÇÃO de um dia caía no texto genérico de ajuda: nenhum
// roteador sabia que "rendeu bem" pede um julgamento, e não um total. Três
// regras de casa valem aqui:
//
// - Pergunta de sim ou não começa por sim ou não (regra 57).
// - Sem amostra, o app não julga (regra 43): o "normal" exige dias trabalhados
//   suficientes ANTES do dia avaliado, e a resposta diz quantos foram.
// - Diferença pequena é "dentro do normal", nunca um veredito (regra 56).
//
// Frase com número nunca chega aqui: "ontem foi 400" é o motorista REGISTRANDO
// o dia (regra 34), não perguntando por ele.

import type { AppState } from '../models/types'
import { isDriver } from '../services/profile'
import { addDays, fmtBRL, fromISO, todayISO } from '../utils/format'
import { normalizeName } from '../utils/text'
import { brDate } from './dates'

const JANELA = 30
const MIN_DIAS_NORMAL = 5
/** Abaixo disto (relativo), a diferença não diz nada sobre o dia. */
const FAIXA_NORMAL = 0.08

const AVALIACAO = /\bcomo\s+(?:foi|ta|esta|anda|ficou|vai|tava|estava)\b|\bfoi\s+(?:um\s+)?(?:dia\s+)?(?:bom|boa|ruim|fraco|fraca|forte|bem|mal|legal|ok|ruim)\b|\brend(?:eu|endo|e)\b|\b(?:ta|tava|esta|estava|to|tou|estou)\s+(?:bom|boa|ruim|fraco|fraca|forte|indo\s+(?:bem|mal)|rendendo|devagar|parado)\b|\bvaleu\s+a\s+pena\b|\bfoi\s+(?:fraco|forte|parado)\b|\bfoi\s+bom\s+o\s+dia\b/
const SO_O_DIA = /\b(?:como|foi|no|na|ta|esta|anda|ficou|vai|tava|estava|o|a|meu|minha|dia|de|do|da|hoje|ontem|anteontem|domingo|segunda|terca|quarta|quinta|sexta|sabado|feira|passad[oa]|ultim[oa]|bom|boa|ruim|fraco|fraca|forte|legal|ok|rendeu|rendendo|rende|e|eu|to|tou|estou|indo|bem|mal|devagar|parado|valeu|pena|um|uma|la|ai|entao|ne|hein|ae|pra|mim|trabalho|movimento)\b|-/g
const NEGATIVA = /\b(?:ruim|fraco|fraca|mal|pior|devagar|parado)\b/
const POSITIVA = /\b(?:bom|boa|bem|forte|rendeu|rendendo|rende|legal|ok|valeu)\b/

type Alvo = { dia: string; nome: string; hoje: boolean; curto: string }

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

function alvoDe(t: string, hoje: string): Alvo | null {
  if (/\banteontem\b/.test(t)) return { dia: addDays(hoje, -2), nome: 'anteontem', hoje: false, curto: 'anteontem' }
  if (/\bontem\b/.test(t)) return { dia: addDays(hoje, -1), nome: 'ontem', hoje: false, curto: 'ontem' }
  if (/\bhoje\b|\bo\s+dia\s+de\s+hoje\b/.test(t)) return { dia: hoje, nome: 'hoje', hoje: true, curto: 'hoje' }
  // "Como foi domingo?": o ÚLTIMO domingo que já terminou — nunca o de hoje,
  // que ainda está acontecendo, e nunca o próximo.
  const m = t.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira|\s+feira)?\b/)
  if (m) {
    const alvoDow = DIAS_DA_SEMANA.indexOf(m[1])
    let dia = addDays(hoje, -1)
    for (let i = 0; i < 7 && fromISO(dia).getDay() !== alvoDow; i++) dia = addDays(dia, -1)
    const nome = alvoDow === 0 || alvoDow === 6 ? `no ${m[1] === 'sabado' ? 'sábado' : 'domingo'}` : `na ${m[1] === 'terca' ? 'terça' : m[1]}-feira`
    return { dia, nome: `${nome} (${brDate(dia)})`, hoje: false, curto: `${nome}` }
  }
  return null
}

interface DiaLido { income: number; expense: number; km: number; trips: number }

function lerDia(s: AppState, dia: string): DiaLido {
  const d: DiaLido = { income: 0, expense: 0, km: 0, trips: 0 }
  for (const t of s.transactions) {
    if (t.date !== dia) continue
    if (t.type === 'income') d.income += t.amount
    else if (t.type === 'expense') d.expense += t.amount
  }
  for (const w of s.workSessions || []) {
    if (w.date !== dia) continue
    d.km += w.km || 0
    d.trips += w.trips || 0
  }
  return d
}

/** Faturamento médio dos dias TRABALHADOS antes do dia avaliado. */
function normalAntes(s: AppState, dia: string): { media: number; dias: number; de: string; ate: string } | null {
  const de = addDays(dia, -JANELA)
  const ate = addDays(dia, -1)
  const porDia = new Map<string, number>()
  for (const t of s.transactions) {
    if (t.type !== 'income' || t.date < de || t.date > ate) continue
    porDia.set(t.date, (porDia.get(t.date) || 0) + t.amount)
  }
  const datas = [...porDia.keys()].sort()
  if (datas.length < MIN_DIAS_NORMAL) return null
  const total = [...porDia.values()].reduce((a, b) => a + b, 0)
  return { media: total / datas.length, dias: datas.length, de: datas[0], ate: datas[datas.length - 1] }
}

/**
 * Resposta pronta, ou `undefined` quando a frase não é uma avaliação de um dia
 * (hoje, ontem, anteontem). Somente leitura.
 */
export function avaliacaoDoDia(s: AppState, input: string, hoje = todayISO()): string | undefined {
  const t = normalizeName(input)
  if (/\d/.test(t) || !AVALIACAO.test(t)) return undefined
  const alvo = alvoDe(t, hoje)
  if (!alvo) return undefined
  // Só o dia e o julgamento: "como tá minha META hoje", "como foi a FATURA
  // ontem" têm assunto próprio e são de outro roteador.
  if (t.replace(/[?!.,]/g, ' ').replace(SO_O_DIA, ' ').trim()) return undefined

  const d = lerDia(s, alvo.dia)
  const Nome = alvo.nome[0].toUpperCase() + alvo.nome.slice(1)
  const simNao = !/^\s*como\b/.test(t) && (POSITIVA.test(t) || NEGATIVA.test(t))
  const perguntaNegativa = NEGATIVA.test(t) && !/\b(?:bom|boa|bem|forte)\b/.test(t)

  if (!d.income && !d.expense && !d.km) {
    return `Não tenho nada registrado ${alvo.nome}${alvo.hoje ? ' até agora' : ''}, então não sei dizer como foi.`
      + (isDriver(s.settings) ? ` Se você rodou, me diga quanto fez — por exemplo, "${alvo.curto} fiz 320" — que eu registro.` : '')
  }

  const resultado = d.income - d.expense
  const numeros = `entrou ${fmtBRL(d.income)} e saiu ${fmtBRL(d.expense)}, resultado de ${fmtBRL(resultado)}`
    + (d.km > 0 ? `, em ${Math.round(d.km)} km` : '')

  if (!isDriver(s.settings)) {
    // Fora do perfil motorista o DIA não é a unidade de trabalho: comparar com
    // um "dia normal" seria inventar um padrão. Os números do dia bastam.
    const confirma = perguntaNegativa ? resultado < 0 : resultado >= 0
    const frase = `${alvo.hoje ? 'até agora, hoje' : alvo.nome} ${numeros} (dado real).`
    return simNao
      ? `${confirma ? 'Sim' : 'Não'}, no resultado: ${frase}`
      : frase[0].toUpperCase() + frase.slice(1)
  }

  const normal = normalAntes(s, alvo.dia)
  if (!normal) {
    return `${alvo.hoje ? 'Até agora, hoje' : Nome} ${numeros} (dado real).\n\n`
      + `Ainda não tenho dias trabalhados suficientes antes desse para dizer qual é o seu normal — prefiro não julgar o dia sem base.`
  }

  const base = `Seu normal: ${fmtBRL(normal.media)} de faturamento por dia trabalhado (${normal.dias} dias com registro, de ${brDate(normal.de)} a ${brDate(normal.ate)}).`

  if (alvo.hoje) {
    // O dia ainda não acabou: comparar o parcial com um dia inteiro seria
    // chamar de fraco um dia que está na metade.
    const falta = normal.media - d.income
    return `Até agora, hoje ${numeros} (dado real).\n\n${base}`
      + (falta > 0.009 ? `\n\nFaltam ${fmtBRL(falta)} de faturamento para chegar no seu dia normal.` : `\n\nVocê já passou do seu dia normal em ${fmtBRL(-falta)}.`)
  }

  const rel = (d.income - normal.media) / normal.media
  const dentro = Math.abs(rel) < FAIXA_NORMAL
  const acima = rel > 0
  const pct = Math.round(Math.abs(rel) * 100)
  let abre: string
  if (dentro) {
    abre = simNao && perguntaNegativa ? `Não, ${alvo.nome} ficou dentro do seu normal.`
      : simNao ? `Foi um dia normal para você: ficou dentro da sua média.`
        : `${Nome} foi um dia dentro do seu normal.`
  }
  else if (simNao) {
    const confirma = perguntaNegativa ? !acima : acima
    abre = `${confirma ? 'Sim' : 'Não'}, ${alvo.nome} ficou ${pct}% ${acima ? 'acima' : 'abaixo'} do seu normal.`
  } else abre = `${Nome} ficou ${pct}% ${acima ? 'acima' : 'abaixo'} do seu normal.`

  return `${abre}\n\n${Nome} ${numeros} (dado real).\n\n${base}`
}
