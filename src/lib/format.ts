// Getal- en valutaopmaak volgens het ontwerp: en-GB, €, "m" voor miljoenen.
// CLV-bedragen altijd met twee decimalen (CLAUDE.md, Schermteksten 7).

const gbNum = (value: number, decimals = 0): string =>
  new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)

const gbSign = (value: number): string => (value >= 0 ? '+' : '−')

export const gb = {
  /** 1108028 → "1,108,028" */
  num: gbNum,
  sign: gbSign,
  /** 21.7 → "€22" */
  eur: (value: number) => '€' + gbNum(Math.round(value)),
  /** 1788334 → "+€1,788,334" */
  signedEur: (value: number) => gbSign(value) + '€' + gbNum(Math.abs(Math.round(value))),
  /** CLV-bedrag, altijd twee decimalen: 21.7034 → "€21.70" */
  clv: (value: number) => '€' + gbNum(value, 2),
  /** CLV-verschil met teken: 0.7008 → "+€0.70" */
  signedClv: (value: number) => gbSign(value) + '€' + gbNum(Math.abs(value), 2),
  /** Aantal met teken: -37956 → "−37,956" */
  signedCount: (value: number) => gbSign(value) + gbNum(Math.abs(value)),
  /** Euro in duizenden met teken: 395767 → "+€396k" */
  signedThousands: (value: number) => gbSign(value) + '€' + gbNum(Math.abs(value) / 1e3) + 'k',
  /** Verschil in fractie als procentpunten zonder teken: 0.005 → "0.5 percentage points" */
  points: (fraction: number) => gbNum(Math.abs(fraction) * 100, 1) + ' percentage points',
  /** Asopmaak percentage: "8%" */
  axisPct: (step: number) => (value: number) => gbNum(value * 100, step >= 0.01 ? 0 : 1) + '%',
  /** Asopmaak aantallen: "150,000" */
  axisCount: () => (value: number) => gbNum(value),
  /** Asopmaak CLV, twee decimalen: "€20.00" */
  axisClv: () => (value: number) => '€' + gbNum(value, 2),
  /** 24048003 → "€24.05m" */
  millions: (value: number) => '€' + gbNum(value / 1e6, 2) + 'm',
  /** Fractie zonder teken: 0.08034 → "8.0%" */
  pct: (fraction: number) => gbNum(Math.abs(fraction) * 100, 1) + '%',
  /** Fractie met teken: -0.0054 → "−0.5%" */
  signedPct: (fraction: number) => gbSign(fraction) + gbNum(Math.abs(fraction) * 100, 1) + '%',
  /**
   * Asopmaak in miljoenen: "€24M". Zoveel decimalen als de stapgrootte nodig
   * heeft, zodat een stap van 2,5 miljoen "€22.5M" toont en niet "€23M".
   */
  axisMillions: (step: number) => (value: number) =>
    '€' +
    gbNum(
      value / 1e6,
      Number.isInteger(Math.round(step) / 1e6) ? 0 : Number.isInteger(Math.round(step) / 1e5) ? 1 : 2,
    ) +
    'M',
}

/** "Q3 2026" → "Q3 '26" */
export function quarterShort(label: string): string {
  const [q, year] = label.split(' ')
  return `${q} '${year.slice(2)}`
}
