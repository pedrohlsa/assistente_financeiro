// Redação do cenário, sempre em cima dos fatos que o motor produziu.
//
// Duas coisas não são negociáveis no texto: ele diz que é SIMULAÇÃO, e ele diz
// que NADA foi registrado. Um número de cenário lido como fato é a forma mais
// direta de o app mentir sem errar uma conta.

import { fmtBRL, fmtNum } from '../../utils/format'
import { formatValue } from '../query/answer'
import type { AssistantScenarioResult } from './types'

const SELO = 'Simulação — nada foi registrado.'

export function composeScenario(r: AssistantScenarioResult): string {
  // Sem base: TODAS as ressalvas aparecem, não só a primeira. Elas são o que o
  // usuário precisa fazer para a pergunta passar a ter resposta — e a pergunta
  // "qual cartão?" estava sendo engolida por um marcador de simulação.
  if (r.empty) return r.caveats.filter(c => c !== SELO).concat(SELO).join('\n\n')

  const linhas: string[] = []
  const p = r.plan
  const valor = (label: string) => r.facts.find(f => f.label === label)?.value

  switch (p.kind) {
    case 'spend': {
      const depois = valor('Saldo depois do gasto')
      const sobra = valor('Sobra do mês depois do gasto')
      const contas = valor('Contas nos próximos 7 dias')
      linhas.push(`Se você gastar ${fmtBRL(p.amount || 0)} hoje:`)
      const itens = [`• Saldo em conta ficaria em ${fmtBRL(depois ?? 0)}`]
      if (sobra !== undefined) itens.push(`• A sobra do mês passaria a ${fmtBRL(sobra)}`)
      if (contas) itens.push(`• Ainda vencem ${fmtBRL(contas)} em contas nos próximos 7 dias`)
      linhas.push(itens.join('\n'))
      if (r.feasible === false) {
        // Sem contas cadastradas não existe "as contas que vêm aí" — dizer isso
        // seria inventar uma obrigação que o usuário nunca registrou.
        linhas.push(contas
          ? 'Do jeito que está, isso não cobre as contas que vêm aí.'
          : 'Isso deixaria seu saldo negativo.')
      }
      break
    }

    case 'purchase': {
      const parcela = valor(`Parcela em ${p.installments}x`) ?? 0
      const cabeca = p.downPayment
        ? `${fmtBRL(p.amount || 0)} com ${fmtBRL(p.downPayment)} de entrada, o resto em ${p.installments}x`
        : `${fmtBRL(p.amount || 0)} em ${p.installments}x`
      linhas.push(`Comprando ${cabeca}: ${fmtBRL(parcela)} por mês.`)
      if (r.tightest) {
        linhas.push(`O mês mais apertado seria ${r.tightest.label}, com saldo estimado de ${fmtBRL(r.tightest.after)}`
          + (r.tightest.before !== r.tightest.after ? ` (seriam ${fmtBRL(r.tightest.before)} sem a compra).` : '.'))
      }
      const proximos = r.months.slice(0, 4)
      if (proximos.length > 1 && proximos.some(m => m.before !== m.after)) {
        linhas.push(proximos.map(m => `• ${m.label}: ${fmtBRL(m.after)}${m.added ? ` (com a parcela de ${fmtBRL(m.added)})` : ''}`).join('\n'))
      }
      if (r.feasible === false) linhas.push('Nesse ritmo o saldo estimado fica negativo — vale olhar um prazo maior ou uma entrada.')
      break
    }

    case 'save': {
      const falta = r.facts.find(f => f.label.startsWith('Falta para a meta'))
      const meses = valor('Meses até bater a meta')
      if (falta && meses !== undefined) {
        linhas.push(`Guardando ${fmtBRL(p.amount || 0)} por mês, faltam ${fmtNum(meses, 0)} ${meses === 1 ? 'mês' : 'meses'} `
          + `para ${falta.label.replace('Falta para a meta ', '')} — ainda faltam ${fmtBRL(falta.value)}.`)
      } else {
        const doze = valor('Em 12 meses')
        linhas.push(`Guardando ${fmtBRL(p.amount || 0)} por mês, você teria ${fmtBRL(doze ?? 0)} em um ano.`)
      }
      break
    }

    case 'pay-invoice': {
      const pendente = r.facts.find(f => f.label.startsWith('Fatura pendente'))
      const depois = valor('Saldo depois de pagar')
      if (pendente) {
        linhas.push(`${pendente.label}: ${fmtBRL(pendente.value)}. Pagando hoje, seu saldo ficaria em ${fmtBRL(depois ?? 0)}.`)
      }
      if (r.feasible === false) linhas.push('O saldo não cobre a fatura inteira agora.')
      break
    }

    case 'income-missing': {
      const entrada = r.facts.find(f => f.label.includes('Entrada'))
      const sobra = valor('Sobra estimada sem essa entrada')
      const contas = valor('Contas previstas nos próximos 30 dias')
      if (entrada) linhas.push(`${entrada.label}: ${fmtBRL(entrada.value)} por mês.`)
      linhas.push(`Sem ela, sobrariam ${fmtBRL(sobra ?? 0)}`
        + (contas ? ` depois das ${fmtBRL(contas)} em contas dos próximos 30 dias.` : '.'))
      linhas.push(r.feasible ? 'Ainda dá para cobrir suas contas.' : 'Assim as contas não fecham — vale se preparar.')
      break
    }

    case 'cut': {
      const media = r.facts.find(f => f.label.startsWith('Gasto médio por mês'))
      const soma = r.facts.find(f => f.label.startsWith('A menos em'))
      linhas.push(`Se você parar os gastos com ${p.description || 'esse gasto'}:`)
      const itens: string[] = []
      if (media) itens.push(`• Em média, ${fmtBRL(media.value)} por mês a menos saindo`)
      if (soma) itens.push(`• ${soma.label.replace('A menos em', 'Em')}, cerca de ${fmtBRL(soma.value)}`)
      linhas.push(itens.join('\n'))
      break
    }

    case 'extra-work': {
      const estimativa = r.facts.find(f => f.label.startsWith('Estimativa'))
      const ritmo = r.facts.find(f => f.label.startsWith('Seu lucro por'))
      if (ritmo) linhas.push(`No seu ritmo real (${formatValue(ritmo.value, ritmo.unit)}):`)
      if (estimativa) linhas.push(`• ${estimativa.label}: ${fmtBRL(estimativa.value)}`)
      break
    }
  }

  for (const c of r.caveats) if (c !== SELO) linhas.push(c)
  // O selo fecha SEMPRE. É a última coisa que o usuário lê, e é a que impede
  // um número de cenário de ser guardado na cabeça como fato.
  linhas.push(SELO)
  return linhas.filter(Boolean).join('\n\n')
}

/** "Como você chegou nisso?" para um cenário — a metodologia REAL. */
export function explainScenario(r: AssistantScenarioResult): string {
  if (r.empty) return r.caveats[0] || 'Não consegui simular isso.'
  const partes = [`Simulei ${r.plan.label} sobre uma cópia dos seus dados — nada foi gravado.`]
  partes.push(r.facts.map(f => `• ${f.label}: ${formatValue(f.value, f.unit)} (${f.provenance.detail})`).join('\n'))
  if (r.months.length) {
    partes.push('A projeção usa suas contas fixas, parcelas e assinaturas já cadastradas — nunca uma média de gasto variável.')
  }
  for (const c of r.caveats) partes.push(c)
  return partes.join('\n\n')
}
