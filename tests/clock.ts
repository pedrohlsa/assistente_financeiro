// Relógio FIXO para os testes do assistente.
//
// O roteador antigo (`resolveLocal`, `calc.ts`) lê o relógio real da máquina,
// enquanto o orquestrador recebe `today` injetado. Sem congelar o relógio, a
// mesma suíte passa num dia do mês e falha em outro — foi assim que 18
// regressões adversariais "verdes" em 28/10/2026 apareceram vermelhas em
// 12/11/2026, com os dois relógios discordando dentro de um mesmo turno.
//
// Este módulo é importado ANTES de qualquer outro pelos runners de teste. A
// data vem de `ASSISTFIN_TODAY` (AAAA-MM-DD); sem a variável, o padrão é a data
// fixa abaixo. O tempo continua ANDANDO a partir do instante congelado, para
// carimbos de ordem (`nowStamp`) seguirem monotônicos.
//
//   ASSISTFIN_TODAY=2026-11-30 npm test     # o mesmo código, no fim do mês
//   ASSISTFIN_TODAY=real npm test           # relógio real da máquina

export const DEFAULT_TEST_TODAY = '2026-09-15'

const pedido = process.env.ASSISTFIN_TODAY?.trim()

export function installClock(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`ASSISTFIN_TODAY inválido: "${iso}" (use AAAA-MM-DD ou "real")`)
  const RealDate = Date
  const [y, m, d] = iso.split('-').map(Number)
  const congeladoEm = new RealDate(y, m - 1, d, 12, 0, 0, 0).getTime()
  const deslocamento = congeladoEm - RealDate.now()
  const agora = () => RealDate.now() + deslocamento

  class FakeDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(agora())
      else super(...(args as ConstructorParameters<typeof Date>))
    }
    static now(): number { return agora() }
  }
  Object.defineProperty(FakeDate, 'name', { value: 'Date' })
  ;(globalThis as any).Date = FakeDate
}

export const TEST_TODAY: string = (() => {
  if (pedido === 'real') return new Date().toISOString().slice(0, 10)
  const iso = pedido || DEFAULT_TEST_TODAY
  installClock(iso)
  return iso
})()
