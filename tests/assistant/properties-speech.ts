import { listenOnce, SpeechError, stopListening } from '../../src/services/speech'

const segment = (transcript: string, isFinal = true) => Object.assign([{ transcript }], { isFinal })
type Segment = ReturnType<typeof segment>

export async function runSpeechChecks(): Promise<{ total: number; failures: string[] }> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let microphone: Recognition
  class Recognition {
    lang: string
    onresult: (event: { results: Segment[]; resultIndex: number }) => void
    onend: () => void
    onerror: (event: { error: string }) => void
    aborted = false
    stopped = false

    start() { microphone = this }
    abort() { this.aborted = true; this.onerror?.({ error: 'aborted' }) }
    stop() {
      this.stopped = true
      this.onresult?.({ results: [segment('gastei 77 no mercado')], resultIndex: 0 })
      this.onend?.()
    }
  }
  const checks: [string, boolean][] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { SpeechRecognition: Recognition } })
  try {
    const full = listenOnce()
    const first = segment('gastei 37 no mercado')
    const last = segment('mas recebi 120 da Casa 2')
    microphone.onresult({ results: [first], resultIndex: 0 })
    microphone.onresult({ results: [first, segment('ruído', false)], resultIndex: 1 })
    microphone.onresult({ results: [first, last], resultIndex: 1 })
    microphone.onend()
    const fullResult = await full
    checks.push(['ditado reúne todos os trechos finais em português', microphone.lang === 'pt-BR'
      && fullResult.text === 'gastei 37 no mercado mas recebi 120 da Casa 2' && !fullResult.cancelled])

    const aborted = listenOnce()
    microphone.onresult({ results: [first], resultIndex: 0 })
    stopListening()
    const cancelled = await aborted
    checks.push(['cancelamento descarta o que já foi ouvido', cancelled.cancelled && !cancelled.text && microphone.aborted])

    const fallback = listenOnce()
    microphone.abort = undefined
    stopListening()
    const stopped = await fallback
    checks.push(['cancelamento descarta resultado de navegador com stop', stopped.cancelled && !stopped.text && microphone.stopped])

    const ended = listenOnce()
    microphone.onend()
    const silent = await ended
    checks.push(['fim sem fala não envia mensagem', silent.cancelled && !silent.text])

    const denied = listenOnce().catch(error => error)
    microphone.onerror({ error: 'not-allowed' })
    const error = await denied
    checks.push(['permissão negada tem erro próprio', error instanceof SpeechError && error.reason === 'denied'])
  } finally {
    stopListening()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
  return { total: checks.length, failures: checks.filter(([, ok]) => !ok).map(([name]) => name) }
}
