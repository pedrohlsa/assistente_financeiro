/** Primitivas numéricas compartilhadas; cada consumidor decide seu próprio limiar. */
export function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function medianAbsoluteDeviation(values: number[], center = median(values)): number {
  return median(values.map(value => Math.abs(value - center)))
}
