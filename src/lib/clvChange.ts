// Kaart "What changed average CLV": per blok (QoQ, YoY) drie bars uit de data, zonder te rekenen.
//   1. bestaande klanten: existingCustomerValue (QoQ), existingCustomerValueLast4Quarters (YoY);
//   2. wie kwam en ging: customerMix (QoQ), customerMixLast4Quarters (YoY);
//   3. totaal: de CLV-verandering van de CLV-tegel (avgClvVsPrevQuarter.abs, avgClvVsYearAgo.abs).
// Bar 1 + bar 2 = bar 3 (getoetst in clvChange.test.ts).
import type { View } from './quarters'

export type ClvBar = { label: string; value: number; total?: boolean }
export type ClvBlock = { key: 'qoq' | 'yoy'; title: string; vs: string; bars: ClvBar[] }

function block(key: ClvBlock['key'], title: string, vs: string, existing: number | null, mix: number | null, total: number | null): ClvBlock | null {
  if (existing === null || mix === null || total === null) return null
  return {
    key,
    title,
    vs,
    bars: [
      { label: `Existing customers became ${existing >= 0 ? 'more' : 'less'} valuable`, value: existing },
      { label: 'Who joined and who left', value: mix },
      { label: 'Change in average CLV', value: total, total: true },
    ],
  }
}

export function clvChangeBlocks(view: View): ClvBlock[] {
  const c = view.current
  return [
    block('qoq', view.vsQuarterLabel, `vs ${view.previous?.label ?? ''}`, c.existingCustomerValue, c.customerMix, c.avgClvVsPrevQuarter?.abs ?? null),
    block('yoy', view.vsYearLabel, `vs ${view.yearAgo?.label ?? ''}`, c.existingCustomerValueLast4Quarters, c.customerMixLast4Quarters, c.avgClvVsYearAgo?.abs ?? null),
  ].filter((b): b is ClvBlock => b !== null)
}
