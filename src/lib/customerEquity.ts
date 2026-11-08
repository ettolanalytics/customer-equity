// Financiële berekeningen. Puur: geen opmaak, geen React, geen databron.
// Alle grootheden zijn jaarlijks: marge per klant per jaar, jaarretentie, jaarlijkse discontovoet.
import type { CustomerEquityDrivers } from '../data/types'

export type DriverKey = keyof CustomerEquityDrivers

export const DRIVER_KEYS: readonly DriverKey[] = ['activeCustomers', 'marginPerCustomer', 'retention']

/** CLV = m × r / (1 + d − r). Constante marge en retentie, oneindige horizon. */
export function customerLifetimeValue(margin: number, retention: number, discountRate: number): number {
  return (margin * retention) / (1 + discountRate - retention)
}

/** Customer equity = N × CLV. */
export function customerEquity(drivers: CustomerEquityDrivers, discountRate: number): number {
  return (
    drivers.activeCustomers *
    customerLifetimeValue(drivers.marginPerCustomer, drivers.retention, discountRate)
  )
}

/** Netto-omzet per klant per jaar = orderwaarde × orders × (1 − retour%). */
export function netRevenuePerCustomer(input: {
  averageOrderValue: number
  ordersPerCustomer: number
  returnRate: number
}): number {
  return input.averageOrderValue * input.ordersPerCustomer * (1 - input.returnRate)
}

/** Afgeleid: netto-omzet − contributiemarge. Geen uitsplitsing naar kostenposten. */
export function variableCostsPerCustomer(netRevenue: number, margin: number): number {
  return netRevenue - margin
}

/** Marge % = marge per klant ÷ netto-omzet per klant. */
export function marginRate(margin: number, netRevenue: number): number {
  return margin / netRevenue
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  )
}

/**
 * Shapley-decompositie van de verandering in customer equity: per driver de gemiddelde
 * marginale bijdrage over alle volgordes (3! = 6). De bijdragen tellen exact op tot
 * customerEquity(to) − customerEquity(from).
 */
export function shapleyDecomposition(
  from: CustomerEquityDrivers,
  to: CustomerEquityDrivers,
  discountRate: number,
): Record<DriverKey, number> {
  const orders = permutations(DRIVER_KEYS)
  const contributions: Record<DriverKey, number> = {
    activeCustomers: 0,
    marginPerCustomer: 0,
    retention: 0,
  }

  for (const order of orders) {
    const state: CustomerEquityDrivers = {
      activeCustomers: from.activeCustomers,
      marginPerCustomer: from.marginPerCustomer,
      retention: from.retention,
    }
    let previous = customerEquity(state, discountRate)
    for (const key of order) {
      state[key] = to[key]
      const next = customerEquity(state, discountRate)
      contributions[key] += (next - previous) / orders.length
      previous = next
    }
  }

  return contributions
}
