// Getal- en valutaopmaak volgens het ontwerp: en-GB, €, "m" voor miljoenen.
// CLV-bedragen altijd met twee decimalen (CLAUDE.md, Schermteksten 7).

const gbNum = (value: number, decimals = 0): string =>
  new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)

const gbSign = (value: number): string => (value >= 0 ? '+' : '−')

/** Decimalen voor een asstap, maar nooit meer dan 3 cijfers in totaal. */
function axisDecimals(value: number, step: number): number {
  const needed = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.max(1, Math.abs(value)))) + 1)
  return Math.min(needed, Math.max(0, 3 - intDigits))
}

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
  /** Euro met teken, in duizenden of vanaf een miljoen in miljoenen: "+€396k", "+€1.3m" */
  signedThousands: (value: number) =>
    gbSign(value) +
    (Math.abs(value) >= 1e6 ? '€' + gbNum(Math.abs(value) / 1e6, 1) + 'm' : '€' + gbNum(Math.abs(value) / 1e3) + 'k'),
  /** Verschil in fractie als procentpunten zonder teken: 0.005 → "0.5 pp" */
  points: (fraction: number) => gbNum(Math.abs(fraction) * 100, 1) + ' pp',
  /** Asopmaak percentage, max. 3 cijfers: "8%", "91.5%" */
  axisPct: (step: number) => (value: number) => gbNum(value * 100, axisDecimals(value * 100, step * 100)) + '%',
  /** Asopmaak aantallen, max. 3 cijfers: 20500 → "20.5k", 850 → "850" */
  axisCount: (step: number) => (value: number) =>
    Math.abs(value) >= 1000
      ? gbNum(value / 1e3, axisDecimals(value / 1e3, step / 1e3)) + 'k'
      : gbNum(value, axisDecimals(value, step)),
  /** Asopmaak euro per klant, max. 3 cijfers: "€250", "€31.5" */
  axisClv: (step: number) => (value: number) => '€' + gbNum(value, axisDecimals(value, step)),
  /** Asopmaak euro per klant met teken (Mix effect, Value effect): "−€2", "€0", "€5" */
  axisSignedClv: (step: number) => (value: number) =>
    (value < -1e-9 ? '−' : '') + '€' + gbNum(Math.abs(value), axisDecimals(Math.abs(value), step)),
  /** Datum: "2026-11-09" → "9 Nov 2026" */
  date: (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso)),
  /** Abonnement naar gewicht: 250 → "250 g", 1000 → "1 kg" */
  plan: (sizeGrams: number) => (sizeGrams >= 1000 && sizeGrams % 1000 === 0 ? `${sizeGrams / 1000} kg` : `${sizeGrams} g`),
  /** Customer equity, één decimaal: 5239362 → "€5.2m" */
  millions: (value: number) => '€' + gbNum(value / 1e6, 1) + 'm',
  /** Bedrag in de antwoordzin: onder een miljoen in duizenden, anders miljoenen: "€56k", "€1.2m" */
  eurShort: (value: number) =>
    Math.abs(value) >= 1e6 ? '€' + gbNum(Math.abs(value) / 1e6, 1) + 'm' : '€' + gbNum(Math.abs(value) / 1e3) + 'k',
  /** Fractie zonder teken: 0.08034 → "8.0%" */
  pct: (fraction: number) => gbNum(Math.abs(fraction) * 100, 1) + '%',
  /** Fractie met teken: -0.0054 → "−0.5%" */
  signedPct: (fraction: number) => gbSign(fraction) + gbNum(Math.abs(fraction) * 100, 1) + '%',
  /** Asopmaak in miljoenen, max. 3 cijfers: "€5M", "€5.25M" */
  axisMillions: (step: number) => (value: number) => '€' + gbNum(value / 1e6, axisDecimals(value / 1e6, step / 1e6)) + 'M',
}

/** "Q3 2026" → "Q3 '26" */
export function quarterShort(label: string): string {
  const [q, year] = label.split(' ')
  return `${q} '${year.slice(2)}`
}
