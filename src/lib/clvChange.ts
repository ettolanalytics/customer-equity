// Kaart "What changed average CLV": per blok (QoQ, YoY) drie bars uit de data.
// Beide blokken foto tegen foto: QoQ begin → eind kwartaal, YoY eind zelfde kwartaal vorig jaar → nu
// (migratie 23).
//   1. bestaande klanten: existingCustomerValue (QoQ), existingCustomerValueYoY (YoY);
//   2. Change in customer mix = nieuwkomers + vertrekkers t.o.v. de blijvers, uit de data: customerMix (QoQ)
//      en customerMixYoY (YoY, migratie 24). De twee delen staan in de tooltip. Vertrekkers positief = MINDER waard (hun vertrek verhoogde de gemiddelde CLV);
//   3. totaal: de CLV-verandering van de CLV-tegel (avgClvVsPrevQuarter.abs, avgClvVsYearAgo.abs).
// Bar 1 + 2 = bar 3 (getoetst in clvChange.test.ts).
import { gb } from './format'
import type { View } from './quarters'

export type ClvBar = { label: string; value: number; total?: boolean; tip?: string }
export type ClvBlock = { key: 'qoq' | 'yoy'; title: string; vs: string; bars: ClvBar[] }

export const existingLabel = (v: number) => `Existing customers became ${v >= 0 ? 'more' : 'less'} valuable`

/**
 * Tooltip bij "Change in customer mix", met de twee delen uit de data. Nieuwkomers > 0: meer waard dan de bestaande
 * klanten. Vertrekkers > 0: minder waard dan de blijvers, wat het gemiddelde verhoogde. "too" alleen als
 * beide groepen dezelfde kant op afweken (allebei less of allebei more).
 */
export function mixTip(newcomers: number, leavers: number): string {
  const inWord = newcomers >= 0 ? 'more' : 'less'
  const outWord = leavers >= 0 ? 'less' : 'more'
  const too = inWord === outWord ? ' too' : ''
  return (
    'The effect of who joined and who left. ' +
    `New and returning customers were worth ${inWord} than existing ones (${gb.signedClv(newcomers)}); ` +
    `customers who left were worth ${outWord}${too}, which ${leavers >= 0 ? 'raised' : 'lowered'} the average (${gb.signedClv(leavers)}).`
  )
}

function block(
  key: ClvBlock['key'],
  title: string,
  vs: string,
  existing: number | null,
  mix: number | null,
  newcomers: number | null,
  leavers: number | null,
  total: number | null,
): ClvBlock | null {
  if (existing === null || mix === null || newcomers === null || leavers === null || total === null) return null
  return {
    key,
    title,
    vs,
    bars: [
      { label: existingLabel(existing), value: existing },
      // Customer mix uit de data (QoQ customerMix, YoY customerMixYoY); de twee delen staan in de tooltip.
      { label: 'Change in customer mix', value: mix, tip: mixTip(newcomers, leavers) },
      { label: 'Change in average CLV', value: total, total: true },
    ],
  }
}

export function clvChangeBlocks(view: View): ClvBlock[] {
  const c = view.current
  return [
    block('qoq', view.vsQuarterLabel, `vs ${view.previous?.label ?? ''}`, c.existingCustomerValue, c.customerMix,
      c.customerMixNewcomers, c.customerMixLeavers, c.avgClvVsPrevQuarter?.abs ?? null),
    block('yoy', view.vsYearLabel, `vs ${view.yearAgo?.label ?? ''}`, c.existingCustomerValueYoY, c.customerMixYoY,
      c.customerMixNewcomersYoY, c.customerMixLeaversYoY, c.avgClvVsYearAgo?.abs ?? null),
  ].filter((b): b is ClvBlock => b !== null)
}
