// Salvar um arquivo gerado pelo app — uma porta só para navegador e APK.
//
// As telas criavam um Blob e clicavam num `<a download>`. Isso funciona no
// navegador, mas o WebView do Capacitor NÃO tem DownloadListener: o clique não
// fazia absolutamente nada e o arquivo nunca chegava a existir. Backup em JSON
// e os dois CSVs caíam todos nesse buraco.
//
// No Android o arquivo passa a ser escrito pelo plugin nativo Export (pasta
// Downloads via MediaStore, sem pedir permissão de armazenamento). No navegador
// segue o caminho de sempre.

import { Capacitor, registerPlugin } from '@capacitor/core'

interface ExportNative {
  save(options: { filename: string; mime: string; data: string }): Promise<{ saved: boolean; filename: string; where: string }>
  share(options: { filename: string; mime: string; data: string }): Promise<{ shared: boolean }>
}

const Native = registerPlugin<ExportNative>('Export')

const isAndroid = () => Capacitor.getPlatform() === 'android'

export interface SaveOutcome {
  ok: boolean
  /** Onde o arquivo ficou, para a mensagem dizer ao usuário onde procurar. */
  where?: string
  error?: string
}

/** Escreve o arquivo e devolve onde ele ficou. Nunca lança. */
export async function saveTextFile(filename: string, mime: string, data: string): Promise<SaveOutcome> {
  if (isAndroid()) {
    try {
      const out = await Native.save({ filename, mime, data })
      return { ok: !!out?.saved, where: out?.where }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  try {
    const blob = new Blob([data], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    // Sem estar no documento, o clique é ignorado por parte dos navegadores.
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revogar na hora cancelaria um download que ainda nem começou.
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Menu de compartilhar do sistema. Só existe no APK. */
export const canShareFile = () => isAndroid()

export async function shareTextFile(filename: string, mime: string, data: string): Promise<boolean> {
  if (!isAndroid()) return false
  try {
    return !!(await Native.share({ filename, mime, data }))?.shared
  } catch {
    return false
  }
}
