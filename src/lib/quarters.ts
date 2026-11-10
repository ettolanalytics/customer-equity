// Kwartaalcijfers en aannames uit Supabase, bij de build opgehaald door scripts/fetch-quarters.mjs.
// Proefversie (branch proef-v2): ce_public.quarters_v2 (CE_DATA=v2). De app rekent niets zelf.
import raw from '../data/quarters.json'

export type Change = { abs: number; pct: number }

/** Antwoordzin: de laatste vier kwartalen. Mix effect (customerMix) + value effect (existingCustomerValue) = avgClvChange. */
export type YearSummary = {
  acquiredCustomers: number
  newCustomers: number
  reacquiredCustomers: number
  churn: number
  avgClvChange: number
  customerMix: number
  existingCustomerValue: number
}

/** Waterfall met vijf balken (jaar of kwartaal); de balken tellen precies op tot equityChange. */
export type Waterfall = {
  fromLabel: string
  toLabel: string
  equityBegin: number
  equityEnd: number
  equityChange: number
  equityChangePct: number
  parts: {
    newCustomers: number
    reacquiredCustomers: number
    churn: number
    customerMix: number
    existingCustomerValue: number
  }
  counts: {
    newCustomers: number
    reacquiredCustomers: number
    churn: number
    /** Alleen in de kwartaalwaterfall. */
    stayingCustomers?: number
  }
  customersBegin: number
  customersEnd: number
  avgClvBegin: number
  avgClvEnd: number
  /** Per klant; in het jaar de som van de vier kwartalen. */
  customerMixPerCustomer: number
  existingCustomerValuePerCustomer: number
}

/** Rekenvoorbeeld: een nieuwe klant op het meest gekozen abonnement van het kwartaal. */
export type ClvExample = {
  planId: number
  sizeGrams: number
  nextInvoiceChance: number
  expectedInvoices: number
  undiscountedInvoices: number
  marginPerInvoice: number
  value: number
}

export type Quarter = {
  label: string
  activeBegin: number
  activeEnd: number
  newCustomers: number
  reacquiredCustomers: number
  acquiredCustomers: number
  churn: number
  churnRate: number
  revenueEur: number
  customerEquity: number
  avgClv: number
  /** Verandering van de gemiddelde CLV t.o.v. het begin van het kwartaal = customerMix + existingCustomerValue. */
  avgClvChange: number
  customerMix: number
  existingCustomerValue: number
  expectedInvoices: number
  marginPerFutureInvoice: number
  lateRenewalFactor: number
  model: { segment: number; alpha: number; beta: number }[]
  clvExample: ClvExample
  equityVsPrevQuarter: Change | null
  equityVsYearAgo: Change | null
  activeVsPrevQuarter: Change | null
  activeVsYearAgo: Change | null
  avgClvVsPrevQuarter: Change | null
  avgClvVsYearAgo: Change | null
  newVsPrevQuarter: Change | null
  newVsYearAgo: Change | null
  reacquiredVsPrevQuarter: Change | null
  reacquiredVsYearAgo: Change | null
  churnVsPrevQuarter: Change | null
  churnVsYearAgo: Change | null
  churnRateVsPrevQuarter: number | null
  churnRateVsYearAgo: number | null
  /** Verschil in euro per klant (bijdragen met teken). */
  customerMixVsPrevQuarter: number | null
  customerMixVsYearAgo: number | null
  existingCustomerValueVsPrevQuarter: number | null
  existingCustomerValueVsYearAgo: number | null
  yearSummary: YearSummary | null
  waterfall: Waterfall | null
  yearWaterfall: Waterfall | null
}

/** Vaste aannames en herkomst als getallen, voor de teksten op het scherm. */
export type Assumptions = {
  discountRateYear: number
  horizonMonths: number
  /** Wat €1 aan het eind van de horizon vandaag waard is: 1 ÷ (1 + disconto)^(jaren). */
  horizonDiscountFactor: number
  graceDays: number
  asOf: string
  generatedAt: string
  firstSelectable: string
  lastQuarter: string
  plans: { planId: number; sizeGrams: number; priceExclVatCents: number; costCents: number }[]
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
  /** Vergelijkingslabels: "QoQ" (vorig kwartaal) en "YoY" (een jaar eerder). */
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
    vsQuarterLabel: 'QoQ',
    vsYearLabel: 'YoY',
  }
}

/**
 * Hover: positie op de as Q1–Q4 (0–3) en het jaar (rol) van de lijn onder de muis.
 * Gedeeld door alle grafieken, zoals in het ontwerp: elke grafiek toont hetzelfde kwartaal.
 */
export type Hover = { pos: number; role: 0 | 1 | 2 }
export type HoverProps = { hover: Hover | null; setHover: (h: Hover | null) => void }

/** Kwartaal onder de muis (of null). */
export function hoveredQuarter(view: View, hover: Hover | null): Quarter | null {
  if (!hover) return null
  return view.years.find((l) => l.role === hover.role)?.quarters[hover.pos] ?? null
}

/** Hovertekst: alleen het punt onder de muis, bijv. "Q2 2025 · 21,073". */
export function yearRead(view: View, hover: Hover | null, value: (q: Quarter) => number | null, fmt: (v: number) => string): string {
  const q = hoveredQuarter(view, hover)
  const v = q ? value(q) : null
  return q && v !== null ? `${q.label} · ${fmt(v)}` : ''
}
