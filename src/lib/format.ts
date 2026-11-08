// Nederlandse getal-, valuta- en datumopmaak.

const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
const MONTHS_LONG = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
]

export function num(value: number, decimals = 0): string {
  return new Intl.NumberFormat('nl-NL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function eur(value: number, decimals = 0): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

/** Fractie als percentage: 0,148 → "14,8%". */
export function pct(fraction: number, decimals = 1): string {
  return `${num(fraction * 100, decimals)}%`
}

export function millions(value: number): string {
  return `€ ${num(value / 1e6, 2)} mln`
}

/** Plus- of minteken (typografisch minteken). */
export function sign(value: number): string {
  return value >= 0 ? '+' : '−'
}

/** Relatieve verandering: "+6,1%". */
export function relativeChange(current: number, previous: number): string {
  const diff = current - previous
  return `${sign(diff)}${num(Math.abs(diff / previous) * 100, 1)}%`
}

/** Verandering in procentpunten tussen twee fracties: "+2,0 pp". */
export function pointChange(current: number, previous: number): string {
  const diff = current - previous
  return `${sign(diff)}${num(Math.abs(diff) * 100, 1)} pp`
}

function parseMonth(month: string): { year: string; index: number } {
  const [year, m] = month.split('-')
  return { year, index: Number(m) - 1 }
}

/** "2026-03" → "mrt" */
export function monthShort(month: string): string {
  return MONTHS_SHORT[parseMonth(month).index]
}

/** "2026-03" → "mrt 2026" */
export function monthLabel(month: string): string {
  const { year, index } = parseMonth(month)
  return `${MONTHS_SHORT[index]} ${year}`
}

/** "2026-03" → "maart 2026" */
export function monthLong(month: string): string {
  const { year, index } = parseMonth(month)
  return `${MONTHS_LONG[index]} ${year}`
}

/** "2026-11-02" → "2 nov 2026" */
export function dateLabel(date: string): string {
  const [year, m, d] = date.split('-')
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]} ${year}`
}
