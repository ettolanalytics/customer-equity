// Kwartaalcijfers en aannames uit Supabase (ce_public), bij de build opgehaald door
// scripts/fetch-quarters.mjs. De app rekent niets zelf: alle getallen komen uit dit bestand.
import raw from '../data/quarters.json'

export type Change = { abs: number; pct: number }

export type YearSummary = {
  acquiredCustomers: number
  newCustomers: number
  reacquiredCustomers: number
  avgClvChange: number
  churnQuarters: number
  churnVsExpected: number | null
}

/** Waterfall (jaar of kwartaal); alle bedragen en aantallen uit het rekenscript. */
export type Waterfall = {
  fromLabel: string
  toLabel: string
  equityBegin: number
  equityEnd: number
  equityChange: number
  equityChangePct: number
  /** Euro-posten; samen precies equityChange. Jaar: churn. Kwartaal: expectedChurn + churnVsExpected. */
  parts: {
    newCustomers: number
    reacquiredCustomers: number
    churn?: number
    expectedChurn?: number
    churnVsExpected?: number
    marginEffect: number
    retentionEffect: number
  }
  counts: {
    newCustomers: number
    reacquiredCustomers: number
    churn: number
    expectedChurn?: number
    churnVsExpected?: number
  }
  customersBegin: number
  customersEnd: number
  avgClvBegin: number
  avgClvEnd: number
  marginBegin: number
  marginEnd: number
  retentionBegin: number
  retentionEnd: number
}

export type ClvExample = {
  churnRate: number
  expectedQuarters: number
  undiscountedValue: number
}

export type Quarter = {
  label: string
  activeBegin: number
  activeEnd: number
  newCustomers: number
  reacquiredCustomers: number
  acquiredCustomers: number
  churn: number
  expectedChurn: number | null
  churnRate: number
  expectedChurnRate: number | null
  churnRateVsExpected: number | null
  revenueEur: number
  marginPerCustomer: number
  retention: number
  retentionQuarters: number
  avgClv: number
  customerEquity: number
  equityVsPrevQuarter: Change | null
  equityVsYearAgo: Change | null
  acquiredVsPrevQuarter: Change | null
  acquiredVsYearAgo: Change | null
  churnRateVsPrevQuarter: number | null
  churnRateVsYearAgo: number | null
  avgClvVsPrevQuarter: Change | null
  avgClvVsYearAgo: Change | null
  activeVsPrevQuarter: Change | null
  activeVsYearAgo: Change | null
  newVsPrevQuarter: Change | null
  newVsYearAgo: Change | null
  reacquiredVsPrevQuarter: Change | null
  reacquiredVsYearAgo: Change | null
  churnVsPrevQuarter: Change | null
  churnVsYearAgo: Change | null
  marginVsPrevQuarter: Change | null
  marginVsYearAgo: Change | null
  /** Verschil in retentie als fractie (x 100 = procentpunten). */
  retentionVsPrevQuarter: number | null
  retentionVsYearAgo: number | null
  /** Werkelijke min verwachte churn (aantal). */
  churnVsExpectedCount: number | null
  yearSummary: YearSummary | null
  clvExample: ClvExample
  waterfall: Waterfall | null
  yearWaterfall: Waterfall | null
}

/** Vaste aannames als getallen, voor de teksten op het scherm. */
export type Assumptions = {
  discountRateYear: number
  horizonQuarters: number
  graceDays: number
  priceEur: number
  costPerInvoiceEur: number
  marginPerInvoiceEur: number
  generatedAt: string
  firstSelectable: string
  lastQuarter: string
}

export const assumptions = raw.assumptions as Assumptions
export const quarters = raw.quarters as Quarter[]

/**
 * Te kiezen kwartalen: alleen kwartalen waarvoor het hele scherm gevuld is
 * (waterfall, vergelijking met vorig jaar, antwoordzin).
 */
export const selectable = quarters
  .map((q, i) => ({ q, i }))
  .filter(({ q }) => q.waterfall !== null && q.yearWaterfall !== null && q.equityVsYearAgo !== null && q.yearSummary !== null)
  .map(({ i }) => i)

/** Standaard: het laatste kwartaal. */
export const defaultIndex = selectable[selectable.length - 1]

/**
 * Eén lijn per jaar in de grafieken: Q1–Q4, null waar (nog) geen kwartaal is.
 * role 0 = jaar van het gekozen kwartaal, 1 = jaar ervoor, 2 = twee jaar ervoor.
 */
export type YearLine = { year: number; role: 0 | 1 | 2; quarters: (Quarter | null)[] }

/** Kleur per rol, vaste volgorde (dit jaar, vorig jaar, twee jaar terug); gevalideerd palet. */
export const YEAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'] as const

export const QUARTER_AXIS = ['Q1', 'Q2', 'Q3', 'Q4']

/** Alles wat het scherm nodig heeft voor het gekozen kwartaal. */
export type View = {
  /** Kwartalen tot en met het gekozen kwartaal; het laatste is het huidige. */
  series: Quarter[]
  currentIndex: number
  current: Quarter
  previous: Quarter
  yearAgo: Quarter
  /** "vs Q2" en "vs Q3 2025", zoals in het ontwerp. */
  vsQuarterLabel: string
  vsYearLabel: string
  /** De laatste drie jaar t/m het gekozen kwartaal, oudste eerst (alleen jaren met data). */
  years: YearLine[]
  /** Positie van het gekozen kwartaal op de as Q1–Q4 (0–3). */
  currentPos: number
}

export function viewFor(index: number): View {
  const previous = quarters[index - 1]
  const yearAgo = quarters[index - 4]
  const series = quarters.slice(0, index + 1)
  const [qPart, yPart] = quarters[index].label.split(' ')
  const year = Number(yPart)
  const years = [2, 1, 0]
    .map((role) => ({
      year: year - role,
      role: role as 0 | 1 | 2,
      quarters: QUARTER_AXIS.map((qq) => series.find((q) => q.label === `${qq} ${year - role}`) ?? null),
    }))
    .filter((l) => l.quarters.some((q) => q !== null))
  return {
    series,
    years,
    currentPos: Number(qPart.slice(1)) - 1,
    currentIndex: index,
    current: quarters[index],
    previous,
    yearAgo,
    vsQuarterLabel: 'vs ' + previous.label.split(' ')[0],
    vsYearLabel: 'vs ' + yearAgo.label,
  }
}

/** Hover-positie op de as Q1–Q4 (0–3); gedeeld door alle grafieken, zoals in het ontwerp. */
export type HoverProps = { hover: number | null; setHover: (i: number | null) => void }
