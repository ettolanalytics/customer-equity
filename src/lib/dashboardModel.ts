// Zet een dataset om in kant-en-klare waarden voor de interface. Componenten rekenen niet zelf.
import type { Comparison, CustomerEquityDataset, Measurement, PeriodSnapshot } from '../data/types'
import {
  customerEquity,
  customerLifetimeValue,
  DRIVER_KEYS,
  marginRate,
  netRevenuePerCustomer,
  shapleyDecomposition,
  variableCostsPerCustomer,
  type DriverKey,
} from './customerEquity'
import {
  dateLabel,
  eur,
  millions,
  monthLabel,
  monthLong,
  monthShort,
  num,
  pct,
  pointChange,
  relativeChange,
  sign,
} from './format'

export interface MetricView {
  label: string
  value: string
  previous: string
  change: string
  isImprovement: boolean
  measurement: Measurement
}

export interface MarginRowView {
  label: string
  previous: string
  current: string
  change: string
  measurement: Measurement
  emphasis: boolean
}

export type BridgeRowView =
  | { kind: 'total'; label: string; value: string }
  | { kind: 'part'; label: string; value: string; share: string; barPercent: number; isNegative: boolean }

export interface TrendPointView {
  shortLabel: string
  label: string
  value: number
}

export interface DriverView {
  metrics: MetricView[]
  note: string
}

export interface DashboardModel {
  company: string
  currentLabel: string
  previousLabel: string
  hero: {
    value: string
    change: string
    isIncrease: boolean
    previous: string
  }
  trend: {
    points: TrendPointView[]
    referenceValue: number
    ariaLabel: string
  }
  financials: MetricView[]
  margin: {
    rows: MarginRowView[]
    explanation: string
  }
  bridge: BridgeRowView[]
  drivers: {
    value: DriverView
    brand: DriverView
    relationship: DriverView
  }
  discountRate: string
  refreshedAt: string
  isSampleData: boolean
  warnings: string[]
}

interface CompareOptions {
  format: (value: number) => string
  measurement: Measurement
  /** Daling is een verbetering (bijv. churn, retour%). */
  lowerIsBetter?: boolean
  /** Verandering in procentpunten in plaats van relatief. */
  inPoints?: boolean
}

function compare(label: string, { current, previous }: Comparison, options: CompareOptions): MetricView {
  const diff = current - previous
  return {
    label,
    value: options.format(current),
    previous: options.format(previous),
    change: options.inPoints ? pointChange(current, previous) : relativeChange(current, previous),
    isImprovement: options.lowerIsBetter ? diff < 0 : diff > 0,
    measurement: options.measurement,
  }
}

const money = (v: number) => eur(v)
const count = (v: number) => num(v)
const twoDecimals = (v: number) => num(v, 2)
const percent = (v: number) => pct(v)
const wholePercent = (v: number) => pct(v, 0)

const BRIDGE_LABELS: Record<DriverKey, [increase: string, decrease: string]> = {
  activeCustomers: ['Meer actieve klanten', 'Minder actieve klanten'],
  marginPerCustomer: ['Hogere marge per klant', 'Lagere marge per klant'],
  retention: ['Hogere retentie', 'Lagere retentie'],
}

function marginExplanation(
  revenue: Comparison,
  costs: Comparison,
  margin: Comparison,
  rate: Comparison,
): string {
  const revenueGrowth = num((revenue.current / revenue.previous - 1) * 100, 1)
  const costGrowth = num((costs.current / costs.previous - 1) * 100, 1)
  const marginDiff = margin.current - margin.previous
  const marginChange = `${sign(marginDiff)}${eur(Math.abs(marginDiff))}`

  if (marginDiff > 0 && rate.current < rate.previous) {
    return `Netto-omzet per klant groeit met ${revenueGrowth}%, de variabele kosten met ${costGrowth}%. De marge per klant stijgt daardoor in euro’s (${marginChange}), maar minder hard dan de omzet. Het percentage daalt dus van ${pct(rate.previous)} naar ${pct(rate.current)}: elke euro omzet levert minder op, terwijl elke klant meer oplevert. Voor customer equity telt de marge in euro’s.`
  }
  return `Netto-omzet per klant verandert met ${relativeChange(revenue.current, revenue.previous)}, de variabele kosten met ${relativeChange(costs.current, costs.previous)}. De marge per klant gaat van ${eur(margin.previous)} naar ${eur(margin.current)} (${marginChange}); het percentage van ${pct(rate.previous)} naar ${pct(rate.current)}. Voor customer equity telt de marge in euro’s.`
}

export function buildDashboardModel(data: CustomerEquityDataset): DashboardModel {
  const d = data.discountRate
  const { current, previous } = data.periods
  const warnings: string[] = []

  // Customer equity en CLV, met dezelfde definities voor beide periodes.
  const clv: Comparison = {
    current: customerLifetimeValue(current.marginPerCustomer, current.retention, d),
    previous: customerLifetimeValue(previous.marginPerCustomer, previous.retention, d),
  }
  const ce: Comparison = {
    current: customerEquity(current, d),
    previous: customerEquity(previous, d),
  }
  const ceChange = ce.current - ce.previous

  // Margeopbouw per actieve klant per jaar.
  const revenue: Comparison = {
    current: netRevenuePerCustomer(current),
    previous: netRevenuePerCustomer(previous),
  }
  const costs: Comparison = {
    current: variableCostsPerCustomer(revenue.current, current.marginPerCustomer),
    previous: variableCostsPerCustomer(revenue.previous, previous.marginPerCustomer),
  }
  const rate: Comparison = {
    current: marginRate(current.marginPerCustomer, revenue.current),
    previous: marginRate(previous.marginPerCustomer, revenue.previous),
  }
  const pick = (key: Exclude<keyof PeriodSnapshot, 'month'>): Comparison => ({
    current: current[key],
    previous: previous[key],
  })
  const customers = pick('activeCustomers')
  const margin = pick('marginPerCustomer')
  const retention = pick('retention')
  const orderValue = pick('averageOrderValue')
  const orders = pick('ordersPerCustomer')
  const returns = pick('returnRate')
  const churn: Comparison = { current: 1 - retention.current, previous: 1 - retention.previous }

  // Trend: dezelfde CE-formule per maand.
  const points = data.monthlyTrend.map((m) => ({
    shortLabel: monthShort(m.month),
    label: monthLabel(m.month),
    value: customerEquity(m, d),
  }))
  const lastMonth = data.monthlyTrend.at(-1)
  if (!lastMonth || lastMonth.month !== current.month) {
    warnings.push('De laatste trendmaand valt niet samen met de huidige periode.')
  } else if (Math.abs(points[points.length - 1].value - ce.current) > 1) {
    warnings.push('Customer equity in de laatste trendmaand wijkt af van de huidige periode.')
  }

  // Shapley-decompositie.
  const shapley = shapleyDecomposition(previous, current, d)
  const shapleyTotal = DRIVER_KEYS.reduce((sum, key) => sum + shapley[key], 0)
  if (Math.abs(shapleyTotal - ceChange) > 1) {
    warnings.push('Shapley-bijdragen tellen niet op tot de totale verandering.')
  }
  const largest = Math.max(...DRIVER_KEYS.map((key) => Math.abs(shapley[key])))
  const bridge: BridgeRowView[] = [
    { kind: 'total', label: `Startwaarde ${monthLabel(previous.month)}`, value: millions(ce.previous) },
    ...DRIVER_KEYS.map((key): BridgeRowView => {
      const v = shapley[key]
      return {
        kind: 'part',
        label: BRIDGE_LABELS[key][v >= 0 ? 0 : 1],
        value: `${sign(v)} ${eur(Math.abs(v))}`,
        share: ceChange === 0 ? '' : `${num((v / ceChange) * 100, 0)}%`,
        barPercent: largest === 0 ? 0 : Math.round((Math.abs(v) / largest) * 100),
        isNegative: v < 0,
      }
    }),
    { kind: 'total', label: `Eindwaarde ${monthLabel(current.month)}`, value: millions(ce.current) },
  ]

  const inputs = data.driverInputs
  const first = data.monthlyTrend[0]

  return {
    company: data.company,
    currentLabel: monthLabel(current.month),
    previousLabel: monthLabel(previous.month),
    hero: {
      value: millions(ce.current),
      change: `${sign(ceChange)} ${eur(Math.abs(ceChange))}  ·  ${relativeChange(ce.current, ce.previous)}`,
      isIncrease: ceChange >= 0,
      previous: millions(ce.previous),
    },
    trend: {
      points,
      referenceValue: ce.previous,
      ariaLabel: first
        ? `Lijngrafiek customer equity per maand van ${monthLong(first.month)} tot ${monthLong(current.month)}, van ${millions(points[0].value)} naar ${millions(points[points.length - 1].value)}`
        : 'Lijngrafiek customer equity per maand',
    },
    financials: [
      compare('Customer lifetime value', clv, { format: money, measurement: 'calculated' }),
      compare('Actieve klanten', customers, { format: count, measurement: 'measured' }),
      compare('Contributiemarge per klant', margin, { format: money, measurement: 'measured' }),
      compare('Contributiemarge %', rate, { format: percent, measurement: 'calculated', inPoints: true }),
      compare('Retentie', retention, { format: wholePercent, measurement: 'calculated', inPoints: true }),
      compare('Churn', churn, {
        format: wholePercent,
        measurement: 'calculated',
        inPoints: true,
        lowerIsBetter: true,
      }),
    ],
    margin: {
      rows: [
        marginRow('Gem. orderwaarde', orderValue, money, 'measured'),
        marginRow('Orders per klant', orders, twoDecimals, 'calculated'),
        marginRow('Retour% (waarde)', returns, percent, 'measured', { inPoints: true }),
        marginRow('Netto-omzet', revenue, money, 'calculated'),
        marginRow('Variabele kosten', costs, money, 'calculated'),
        marginRow('Contributiemarge', margin, money, 'measured', { emphasis: true }),
        marginRow('Contributiemarge %', rate, percent, 'calculated', { inPoints: true, emphasis: true }),
      ],
      explanation: marginExplanation(revenue, costs, margin, rate),
    },
    bridge,
    drivers: {
      value: {
        metrics: [
          compare('Herhaalaankoop (≥2 orders)', inputs.repeatPurchaseRate, {
            format: percent,
            measurement: 'measured',
            inPoints: true,
          }),
          compare('Gem. orderwaarde', orderValue, { format: money, measurement: 'measured' }),
          compare('Retourpercentage (waarde)', returns, {
            format: percent,
            measurement: 'measured',
            inPoints: true,
            lowerIsBetter: true,
          }),
        ],
        note: data.notes.value,
      },
      brand: {
        metrics: [
          compare('Branded search-klikken', inputs.brandedSearchClicks, { format: count, measurement: 'proxy' }),
          compare('Direct verkeer (sessies)', inputs.directSessions, { format: count, measurement: 'proxy' }),
          compare('Nieuwe klanten via branded + direct', inputs.newCustomersBrandedDirectShare, {
            format: wholePercent,
            measurement: 'calculated',
            inPoints: true,
          }),
        ],
        note: data.notes.brand,
      },
      relationship: {
        metrics: [
          compare('Retentie', retention, { format: wholePercent, measurement: 'calculated', inPoints: true }),
          compare('Orders per actieve klant', orders, { format: twoDecimals, measurement: 'calculated' }),
          compare('Referral-aandeel nieuwe klanten', inputs.referralShare, {
            format: percent,
            measurement: 'measured',
            inPoints: true,
          }),
        ],
        note: data.notes.relationship,
      },
    },
    discountRate: pct(d, 0),
    refreshedAt: dateLabel(data.refreshedAt),
    isSampleData: data.isSampleData,
    warnings,
  }
}

function marginRow(
  label: string,
  { current, previous }: Comparison,
  format: (value: number) => string,
  measurement: Measurement,
  options: { inPoints?: boolean; emphasis?: boolean } = {},
): MarginRowView {
  return {
    label,
    previous: format(previous),
    current: format(current),
    change: options.inPoints ? pointChange(current, previous) : relativeChange(current, previous),
    measurement,
    emphasis: options.emphasis ?? false,
  }
}
