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
    case 'compound': {
      linhas.push(`Cenário combinado com ${p.steps?.length || 0} mudanças:`)
      for (const step of p.steps || []) linhas.push(`• ${descricaoPasso(step)}`)
      const efeito = r.facts.find(f => f.label.startsWith('Efeito mensal combinado'))
      if (efeito) linhas.push(`Efeito mensal combinado: ${fmtBRL(efeito.value)}.`)
      if (r.months.some(m => m.saved !== undefined)) {
        const final = r.months[r.months.length - 1]
        if (r.months.every(m => !m.saved)) {
          linhas.push(`Não apareceu sobra para reservar em nenhum dos ${r.months.length} meses; acumulado até ${final.label}: ${fmtBRL(0)}.`)
        } else {
          linhas.push(r.months.slice(0, 4).map(m => `• ${m.label}: sobra ${fmtBRL(m.surplus || 0)}, reservado ${fmtBRL(m.saved || 0)}, acumulado ${fmtBRL(m.accumulated || 0)}`).join('\n'))
          if (r.months.length > 4) linhas.push(`Até ${final.label}: acumulado ${fmtBRL(final.accumulated || 0)} (${r.months.length} meses no total).`)
        }
      }
      if (r.feasible === false) linhas.push('Depois de combinar tudo, o resultado mensal estimado fica negativo.')
      break
    }

    case 'spend': {
      const depois = valor('Saldo depois do gasto')
      const sobra = valor('Sobra do mês depois do gasto')
      const contas = valor('Compromissos vencidos e dos próximos 7 dias')
      const faturas = valor('Faturas incluídas nos compromissos')
      const livre = valor('Saldo após esses compromissos')
      linhas.push(`Se você gastar ${fmtBRL(p.amount || 0)} ${p.when || 'hoje'}:`)
      const itens = [`• Saldo em conta ficaria em ${fmtBRL(depois ?? 0)}`]
      if (sobra !== undefined) itens.push(`• A sobra do mês passaria a ${fmtBRL(sobra)}`)
      if (contas) itens.push(`• Compromissos cadastrados vencidos e dos próximos 7 dias: ${fmtBRL(contas)}${faturas ? ` (inclui ${fmtBRL(faturas)} em faturas)` : ''}`)
      if (livre !== undefined) itens.push(`• Saldo após esses compromissos: ${fmtBRL(livre)}`)
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
      const acumulado = valor('Reserva acumulada no horizonte')
      const ultimo = r.months[r.months.length - 1]
      if (falta && meses !== undefined) {
        const nomeMeta = falta.label.replace('Falta para a meta ', '')
        linhas.push(meses === 0 ? `Com o valor inicial da simulação, você já alcança a meta ${nomeMeta}.`
          : `Guardando ${fmtBRL(p.amount || 0)} por mês, faltam ${fmtNum(meses, 0)} ${meses === 1 ? 'mês' : 'meses'} `
            + `para ${nomeMeta} — ainda faltam ${fmtBRL(falta.value)}.`)
      } else {
        linhas.push(`Guardando ${fmtBRL(p.amount || 0)} por mês, você teria ${fmtBRL(acumulado ?? 0)} até ${ultimo?.label || 'o fim do período'}.`)
      }
      if (falta && ultimo) linhas.push(`Até ${ultimo.label}, a reserva simulada soma ${fmtBRL(acumulado ?? 0)}.`)
      break
    }

    case 'reduce': {
      const applied = valor('Despesa futura efetivamente evitada') || 0
      linhas.push(`Você propôs reduzir ${p.description || p.category || 'esse gasto'} em ${fmtBRL(p.amount || 0)} por mês.`)
      linhas.push(`Na projeção cadastrada, isso evitaria ${fmtBRL(applied)} no horizonte.`)
      break
    }

    case 'save-share': {
      const ratio = ((p.ratio || 0) * 100).toLocaleString('pt-BR')
      linhas.push(`Guardando ${ratio}% do que sobrar em cada mês:`)
      linhas.push(r.months.slice(0, 4).map(m => `• ${m.label}: reservado ${fmtBRL(m.saved || 0)}, acumulado ${fmtBRL(m.accumulated || 0)}`).join('\n'))
      if (r.months.length > 4) {
        const final = r.months[r.months.length - 1]
        linhas.push(`Até ${final.label}: acumulado ${fmtBRL(final.accumulated || 0)} (${r.months.length} meses no total).`)
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
      const contas = valor('Compromissos vencidos e dos próximos 30 dias')
      const faturas = valor('Faturas incluídas nos compromissos')
      if (entrada) linhas.push(`${entrada.label}: ${fmtBRL(entrada.value)}${p.amount ? '' : ' por mês'}.`)
      linhas.push(`Sem ela, sobrariam ${fmtBRL(sobra ?? 0)}`
        + (contas ? ` depois de ${fmtBRL(contas)} em compromissos vencidos e dos próximos 30 dias${faturas ? ` (inclui ${fmtBRL(faturas)} em faturas)` : ''}.` : '.'))
      if (r.feasible === true) linhas.push('O saldo cobre os compromissos cadastrados nesse horizonte.')
      else if (r.feasible === false) linhas.push('Assim os compromissos cadastrados não cabem no saldo — vale se preparar.')
      else linhas.push('Ainda não dá para confirmar se o saldo cobre tudo: confira as contas sem confirmação.')
      break
    }

    case 'cut': {
      const media = r.facts.find(f => f.label.startsWith('Gasto médio por mês'))
      const fracao = r.facts.find(f => f.label.startsWith('Corte por mês'))
      const soma = r.facts.find(f => f.label === 'Despesa futura efetivamente evitada')
      linhas.push(p.ratio === 0.5
        ? `Se você cortar pela metade os gastos com ${p.description || 'esse gasto'}:`
        : `Se você parar os gastos com ${p.description || 'esse gasto'}:`)
      const itens: string[] = []
      if (media) itens.push(`• No histórico, foram em média ${fmtBRL(media.value)} por mês${fracao ? `; a metade é ${fmtBRL(fracao.value)}` : ''}`)
      if (soma) itens.push(`• Na projeção cadastrada, ${fmtBRL(soma.value)} de despesa futura seria evitada no horizonte`)
      linhas.push(itens.join('\n'))
      break
    }

    case 'extra-work': {
      if (p.driving) {
        const estimativa = r.facts.find(f => f.label === 'Estimativa')
        const referencia = r.facts.find(f => f.label === 'Referência')
        const rodagem = valor('Rodagem estimada')
        if (estimativa && rodagem !== undefined) {
          const nome = {
            profit: 'Lucro estimado',
            'fuel-cost': 'Gasto estimado de combustível',
            'fuel-volume': 'Volume estimado de combustível',
            maintenance: 'Provisão estimada de manutenção',
          }[p.driving.metric]
          const kilometros = `${fmtNum(rodagem)} km`
          const janela = p.driving.extraDaysPerWeek ? ' por semana' : ''
          linhas.push(`${nome}${janela} para ${kilometros}: ${formatValue(estimativa.value, estimativa.unit)}.`)
          if (referencia) {
            const diferenca = estimativa.value - referencia.value
            const variacao = Math.abs(diferenca) > 0.005
              ? ` (${formatValue(Math.abs(diferenca), estimativa.unit)} a ${diferenca > 0 ? 'mais' : 'menos'})` : ''
            linhas.push(`Referência sem a mudança: ${formatValue(referencia.value, referencia.unit)}${variacao}.`)
          }
        }
        break
      }
      if (p.fuelOnly) {
        const comb = r.facts.find(f => f.label === 'Combustível estimado')
        const porKm = r.facts.find(f => f.label === 'Custo de combustível por km')
        if (comb && porKm) {
          linhas.push(`Para rodar mais ${fmtNum(p.extraKm || 0)} km, o combustível deve ficar em uns ${fmtBRL(comb.value)} (${formatValue(porKm.value, porKm.unit)}, pelo seu consumo e preço registrados).`)
        }
        break
      }
      const estimativa = r.facts.find(f => f.label.startsWith('Estimativa'))
      const ritmo = r.facts.find(f => f.label.startsWith('Seu lucro por'))
      const meta = r.facts.find(f => f.label === 'Meta de hoje')
      const feito = r.facts.find(f => f.label === 'Lucro de hoje até agora')
      if (p.hoursPerDay && ritmo && estimativa) {
        // "Vale ficar mais 3h?" se decide pelo que rende e pela meta do dia.
        const quanto = estimativa.label.replace(/^Estimativa com /, '')
        linhas.push(`No seu ritmo real (${formatValue(ritmo.value, ritmo.unit)}), ${quanto} rendem uns ${fmtBRL(estimativa.value)}.`)
        if (meta && feito && meta.value > 0) {
          const falta = meta.value - feito.value
          linhas.push(falta <= 0.005
            ? `A meta de hoje (${fmtBRL(meta.value)}) já foi batida: você fez ${fmtBRL(feito.value)} até agora, então essas horas seriam lucro a mais.`
            : `Faltam ${fmtBRL(falta)} para a meta de hoje (${fmtBRL(meta.value)}); ${estimativa.value >= falta ? 'com essas horas, você bate a meta' : 'só essas horas não bastam para bater a meta'}.`)
        }
        break
      }
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

function descricaoPasso(p: NonNullable<AssistantScenarioResult['plan']['steps']>[number]): string {
  switch (p.kind) {
    case 'purchase': return `compra de ${fmtBRL(p.amount || 0)} em ${p.installments || 1}x`
    case 'save': return `guardar ${fmtBRL(p.amount || 0)} por mês`
    case 'income-missing': return `${p.origin || 'uma entrada'} não entra`
    case 'pay-invoice': return `pagar a fatura${p.cardName ? ` do ${p.cardName}` : ''}`
    case 'cut': return `${p.ratio === 0.5 ? 'cortar pela metade' : 'parar'} os gastos com ${p.description || p.category || 'a categoria'}`
    case 'reduce': return `reduzir ${p.description || p.category || 'o gasto'} em ${fmtBRL(p.amount || 0)} por mês`
    case 'save-share': {
      const pct = Math.round((p.ratio || 0) * 100)
      return pct === 50
        ? 'guardar metade (50%) do que sobrar depois das mudanças anteriores'
        : `guardar ${pct}% do que sobrar depois das mudanças anteriores`
    }
    case 'spend': return `gastar ${fmtBRL(p.amount || 0)}`
    case 'extra-work': return p.driving ? p.label : p.hoursPerDay ? `trabalhar mais ${p.hoursPerDay}h por dia` : `rodar mais ${p.extraKm || 0} km`
    case 'compound': return p.label
  }
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
