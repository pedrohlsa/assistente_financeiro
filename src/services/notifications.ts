// Notificações locais no celular (funciona com o app fechado).
// Avisa quando uma conta está pra vencer / vencendo e quando uma entrada
// (salário/aluguel) cai. Só roda no app nativo (Android); na web é no-op.
import { Capacitor } from '@capacitor/core'
import { AppState } from '../models/types'
import { upcomingBills, upcomingIncomes } from './calc'
import { fromISO } from '../utils/format'
import { fmtBRL } from '../utils/format'

// carrega o plugin sob demanda (evita quebrar no ambiente web/preview)
async function getPlugin() {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const mod = await import('@capacitor/local-notifications')
    return mod.LocalNotifications
  } catch {
    return null
  }
}

/** define o horário (09:00 local) de um dia YYYY-MM-DD */
function at9am(dateISO: string, hour = 9): Date {
  const d = fromISO(dateISO)
  d.setHours(hour, 0, 0, 0)
  return d
}

/**
 * Reagenda todas as notificações do app a partir do estado atual.
 * Chamar no boot e quando contas/entradas/preferências mudam.
 */
export async function syncNotifications(state: AppState): Promise<void> {
  const LN = await getPlugin()
  if (!LN) return
  try {
    // permissão (Android 13+ exige POST_NOTIFICATIONS)
    let perm = await LN.checkPermissions()
    if (perm.display !== 'granted') perm = await LN.requestPermissions()
    if (perm.display !== 'granted') return

    // limpa o que já estava agendado por nós (recomeça do zero)
    const pending = await LN.getPending()
    if (pending.notifications.length) {
      await LN.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) })
    }

    if (!state.settings.notifications) return

    const now = Date.now()
    const list: any[] = []
    let id = 1

    // ----- contas a pagar: aviso na véspera (9h) e no dia (9h) -----
    for (const b of upcomingBills(state, 45)) {
      const due = at9am(b.date)
      const dayBefore = new Date(due.getTime() - 86400000)
      if (dayBefore.getTime() > now) {
        list.push({
          id: id++, title: '📄 Conta amanhã',
          body: `${b.name}: ${fmtBRL(b.amount)} vence amanhã.`,
          schedule: { at: dayBefore, allowWhileIdle: true },
        })
      }
      if (due.getTime() > now) {
        list.push({
          id: id++, title: '⚠️ Conta vence hoje',
          body: `${b.name}: ${fmtBRL(b.amount)} vence hoje. Não esqueça de pagar.`,
          schedule: { at: due, allowWhileIdle: true },
        })
      }
    }

    // ----- entradas fixas: aviso no dia que cai (9h) -----
    for (const inc of upcomingIncomes(state, 45)) {
      const day = at9am(inc.date)
      if (day.getTime() > now) {
        list.push({
          id: id++, title: '🔑 Entrada hoje',
          body: `${inc.name}: ${fmtBRL(inc.amount)} deve cair hoje.`,
          schedule: { at: day, allowWhileIdle: true },
        })
      }
    }

    if (list.length) await LN.schedule({ notifications: list.slice(0, 60) })
  } catch (e) {
    // nunca deixa a notificação quebrar o app
    console.warn('notifications sync falhou', e)
  }
}
