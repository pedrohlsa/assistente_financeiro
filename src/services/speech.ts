// Ditado por voz — uma porta só para os dois mundos.
//
// O botão do microfone falava direto com `webkitSpeechRecognition`. Essa API
// existe no Chrome, mas NÃO no Android System WebView: dentro do APK ela
// simplesmente não estava lá e o microfone não fazia nada. Quem usa o app de
// verdade é justamente quem está no APK.
//
// No Android o ditado passa a ser o do próprio sistema (plugin nativo Speech,
// `ACTION_RECOGNIZE_SPEECH`): o áudio é capturado pelo app de voz do Android,
// então o AssistFin não pede permissão de gravação nem guarda áudio — recebe
// só o texto final. No navegador segue a Web Speech API.

import { Capacitor, registerPlugin } from '@capacitor/core'

export interface SpeechResult {
  text: string
  cancelled: boolean
}

interface SpeechNative {
  available(): Promise<{ available: boolean }>
  listen(options: { prompt?: string }): Promise<SpeechResult>
}

const Native = registerPlugin<SpeechNative>('Speech')

const isAndroid = () => Capacitor.getPlatform() === 'android'

const webRecognition = (): any =>
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
let cancelWebSpeech: (() => void) | undefined

/** Há como ditar neste aparelho? */
export async function speechAvailable(): Promise<boolean> {
  if (isAndroid()) {
    try {
      return (await Native.available()).available
    } catch {
      return false
    }
  }
  return !!webRecognition()
}

/**
 * Motivo da falha, para a tela dizer o que fazer em vez de "não deu".
 * `unavailable` = não há ditado neste aparelho; `denied` = microfone negado;
 * `no-speech` = ouviu silêncio.
 */
export type SpeechFailure = 'unavailable' | 'denied' | 'no-speech' | 'error'

export class SpeechError extends Error {
  constructor(public reason: SpeechFailure) {
    super(reason)
  }
}

/**
 * Ouve UMA fala e devolve o texto. Cancelar não é erro: volta
 * `cancelled: true` para a tela apenas parar de ouvir, sem reclamar.
 */
export async function listenOnce(prompt?: string): Promise<SpeechResult> {
  if (isAndroid()) {
    try {
      const out = await Native.listen({ prompt })
      return { text: out?.text || '', cancelled: !!out?.cancelled || !out?.text }
    } catch (e: any) {
      throw new SpeechError(String(e?.message || e).includes('no-recognizer') ? 'unavailable' : 'error')
    }
  }

  const SR = webRecognition()
  if (!SR) throw new SpeechError('unavailable')
  stopListening()

  return new Promise<SpeechResult>((resolve, reject) => {
    const rec = new SR()
    rec.lang = 'pt-BR'
    rec.interimResults = false
    rec.maxAlternatives = 1
    let finished = false
    let finalText = ''

    const finish = (result: SpeechResult | SpeechError) => {
      if (finished) return
      finished = true
      if (cancelWebSpeech === cancel) cancelWebSpeech = undefined
      rec.onresult = null
      rec.onend = null
      rec.onerror = null
      if (result instanceof SpeechError) reject(result)
      else resolve(result)
    }
    const cancel = () => {
      finish({ text: '', cancelled: true })
      try {
        if (typeof rec.abort === 'function') rec.abort()
        else rec.stop()
      } catch { /* reconhecimento já encerrado */ }
    }
    cancelWebSpeech = cancel
    rec.onresult = (e: any) => {
      const segments: string[] = []
      for (let i = 0; i < (e.results?.length || 0); i++) {
        const segment = e.results[i]
        const text = segment?.isFinal ? segment[0]?.transcript?.trim() : ''
        if (text) segments.push(text)
      }
      if (segments.length) finalText = segments.join(' ')
    }
    // Eventos posteriores trazem a lista acumulada de trechos finais.
    rec.onend = () => finish({ text: finalText, cancelled: !finalText })
    rec.onerror = (e: any) => {
      const code = e?.error
      if (code === 'aborted') { finish({ text: '', cancelled: true }); return }
      finish(new SpeechError(
        code === 'not-allowed' || code === 'service-not-allowed' ? 'denied'
          : code === 'no-speech' ? 'no-speech'
            : 'error',
      ))
    }

    try {
      rec.start()
    } catch {
      finish(new SpeechError('error'))
    }
  })
}

/** Cancela a escuta no navegador sem enviar a transcrição parcial. */
export function stopListening(): void {
  cancelWebSpeech?.()
}

export const SPEECH_MESSAGES: Record<SpeechFailure, string> = {
  unavailable: 'Este aparelho não tem ditado por voz instalado. Dá para escrever normalmente.',
  denied: 'Preciso da permissão do microfone para ouvir. Você pode liberar nas configurações do aparelho.',
  'no-speech': 'Não ouvi nada. Tente de novo mais perto do microfone.',
  error: 'Não consegui te ouvir agora. Tente de novo.',
}
