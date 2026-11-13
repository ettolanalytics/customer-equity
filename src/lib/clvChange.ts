// Kaart "What changed average CLV": per blok (QoQ, YoY) vier bars uit de data, zonder te rekenen.
//   1. bestaande klanten: existingCustomerValue (QoQ), existingCustomerValueLast4Quarters (YoY);
//   2. nieuwkomers t.o.v. de blijvers: customerMixNewcomers (QoQ), customerMixNewcomersLast4Quarters (YoY);
//   3. vertrekkers t.o.v. de blijvers: customerMixLeavers (QoQ), customerMixLeaversLast4Quarters (YoY).
//      Positief = vertrekkers waren MINDER waard (hun vertrek verhoogde de gemiddelde CLV);
//   4. totaal: de CLV-verandering van de CLV-tegel (avgClvVsPrevQuarter.abs, avgClvVsYearAgo.abs).
// Bar 1 + 2 + 3 = bar 4 (getoetst in clvChange.test.ts); 2 + 3 = het mix effect (migratie 20).
import type { View } from './quarters'

export type ClvBar = { label: string; value: number; total?: boolean }
export type ClvBlock = { key: 'qoq' | 'yoy'; title: string; vs: string; bars: ClvBar[] }

export const existingLabel = (v: number) => `Existing customers became ${v >= 0 ? 'more' : 'less'} valuable`
export const newcomersLabel = (v: number) => `New and returning customers were worth ${v >= 0 ? 'more' : 'less'} than existing ones`
export const leaversLabel = (v: number) => `Customers who left were worth ${v >= 0 ? 'less' : 'more'} than those who stayed`

function block(
  key: ClvBlock['key'],
  title: string,
  vs: string,
  existing: number | null,
  newcomers: number | null,
  leavers: number | null,
  total: number | null,
): ClvBlock | null {
  if (existing === null || newcomers === null || leavers === null || total === null) return null
  return {
    key,
    title,
    vs,
    bars: [
      { label: existingLabel(existing), value: existing },
      { label: newcomersLabel(newcomers), value: newcomers },
      { label: leaversLabel(leavers), value: leavers },
      { label: 'Change in average CLV', value: total, total: true },
    ],
  }
}

export function clvChangeBlocks(view: View): ClvBlock[] {
  const c = view.current
  return [
    block('qoq', view.vsQuarterLabel, `vs ${view.previous?.label ?? ''}`, c.existingCustomerValue,
      c.customerMixNewcomers, c.customerMixLeavers, c.avgClvVsPrevQuarter?.abs ?? null),
    block('yoy', view.vsYearLabel, `vs ${view.yearAgo?.label ?? ''}`, c.existingCustomerValueLast4Quarters,
      c.customerMixNewcomersLast4Quarters, c.customerMixLeaversLast4Quarters, c.avgClvVsYearAgo?.abs ?? null),
  ].filter((b): b is ClvBlock => b !== null)
}
