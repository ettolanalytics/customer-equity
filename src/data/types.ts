// Vorm van de brondata voor het dashboard. Een toekomstige Supabase-bron levert
// precies deze vorm aan, zodat berekeningen en interface ongewijzigd blijven.

/** Hoe een cijfer tot stand komt: direct uit bron, via een formule, of als benadering. */
export type Measurement = 'measured' | 'calculated' | 'proxy'

/** De drie drivers van customer equity: CE = N × m × r / (1 + d − r). */
export interface CustomerEquityDrivers {
  /** N: actieve klanten (≥1 niet-volledig-geretourneerde order in 12 mnd) */
  activeCustomers: number
  /** m: jaarlijkse contributiemarge per actieve klant, in euro */
  marginPerCustomer: number
  /** r: jaarlijkse retentie, als fractie (0,66 = 66%) */
  retention: number
}

/** Rolling-12-maandenperiode die eindigt in `month`. */
export interface PeriodSnapshot extends CustomerEquityDrivers {
  /** Eindmaand van de periode, YYYY-MM */
  month: string
  averageOrderValue: number
  ordersPerCustomer: number
  /** Retourpercentage op waarde, als fractie */
  returnRate: number
}

/** Rolling-12-maandenwaarden van de drivers, per eindmaand. */
export interface MonthlyDrivers extends CustomerEquityDrivers {
  /** YYYY-MM */
  month: string
}

export interface Comparison {
  current: number
  previous: number
}

export interface CustomerEquityDataset {
  company: string
  isSampleData: boolean
  /** Datum van laatste verversing, YYYY-MM-DD */
  refreshedAt: string
  /** Jaarlijkse discontovoet d, als fractie */
  discountRate: number
  periods: {
    current: PeriodSnapshot
    previous: PeriodSnapshot
  }
  /** Maandreeks; de laatste maand valt samen met `periods.current`. */
  monthlyTrend: MonthlyDrivers[]
  driverInputs: {
    repeatPurchaseRate: Comparison
    brandedSearchClicks: Comparison
    directSessions: Comparison
    newCustomersBrandedDirectShare: Comparison
    referralShare: Comparison
  }
  /** Duiding per driver, geschreven bij deze dataset. */
  notes: {
    value: string
    brand: string
    relationship: string
  }
}
