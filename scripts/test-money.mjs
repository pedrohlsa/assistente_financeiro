// Testes do parser monetário central (item 6 do escopo).
// Rodar: node --experimental-strip-types scripts/test-money.mjs
import { parseMoney } from '../src/utils/format.ts'
import { sentenceCase, normalizeName, sameName } from '../src/utils/text.ts'

const cases = [
  ['100.000', 100000], ['100.000,00', 100000], ['100000', 100000],
  ['5.000', 5000], ['5.000,00', 5000], ['5000', 5000],
  ['10.000', 10000], ['10.000,00', 10000], ['10,000,00', 10000],
  ['1.234,56', 1234.56], ['1234,56', 1234.56], ['1,234.56', 1234.56],
  ['10,50', 10.5], ['10.50', 10.5],
  ['R$ 5.000,00', 5000], ['R$ 5.000', 5000], ['  1.000.000,50  ', 1000000.5],
  ['0,01', 0.01], ['410,99', 410.99], ['39,90', 39.9], ['1', 1],
]
const invalid = ['.', ',', '-', 'R$', 'abc', '', '   ', 'R$ ,']

let fail = 0
for (const [input, expected] of cases) {
  const got = parseMoney(input)
  const ok = Math.abs(got - expected) < 1e-9
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} parseMoney(${JSON.stringify(input)}) = ${got} (esperado ${expected})`)
}
for (const input of invalid) {
  const got = parseMoney(input)
  const ok = Number.isNaN(got)
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} parseMoney(${JSON.stringify(input)}) = ${got} (esperado NaN)`)
}

const textCases = [
  ['areia', 'Areia'], ['cimento', 'Cimento'], ['casa', 'Casa'],
  ['nubank cirinha', 'Nubank cirinha'], ['GNV', 'GNV'], ['iPhone', 'iPhone'],
  ['Nubank (Cirinha)', 'Nubank (Cirinha)'], ['gás de cozinha', 'Gás de cozinha'],
]
for (const [input, expected] of textCases) {
  const got = sentenceCase(input)
  const ok = got === expected
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} sentenceCase(${JSON.stringify(input)}) = ${JSON.stringify(got)} (esperado ${JSON.stringify(expected)})`)
}

const nameCases = [
  ['Casa', 'casa', true], ['  Cása', 'CASA', true],
  ['Nubank (Cirinha)', ' NUBANK   (CIRINHA) ', true],
  ['Casa', 'Carro', false], ['', 'casa', false],
]
for (const [a, b, expected] of nameCases) {
  const got = sameName(a, b)
  const ok = got === expected
  if (!ok) fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} sameName(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got} (esperado ${expected})`)
}
console.log(normalizeName('  Cása  Nova ') === 'casa nova' ? 'ok   normalizeName' : (fail++, 'FAIL normalizeName'))

console.log(fail === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${fail} TESTE(S) FALHARAM`)
process.exit(fail === 0 ? 0 : 1)
