// Stock tegenover flow (migratie 17), getoetst op de opgehaalde data (src/data/quarters.json).
// De app rekent niets; deze test controleert alleen dat de getallen die hij toont sluiten:
//   eind = begin + new + reacquired − churn (per kwartaal);
//   actief nu − actief een jaar eerder = som van de flows over vier kwartalen;
//   CLV nu − CLV een jaar eerder = som van mix en value effect over vier kwartalen;
//   de velden "Last 4 quarters" zijn de som van de vier kwartalen, en de verandering t.o.v.
//   de vier kwartalen daarvoor klopt.
import { describe, expect, it } from 'vitest'
import { quarters, selectable } from './quarters'

const sum4 = (i: number, f: (k: number) => number) => [0, 1, 2, 3].reduce((a, d) => a + f(i - d), 0)

describe('stock en flow sluiten in quarters.json', () => {
  it('eind = begin + new + reacquired − churn, en begin = eind vorig kwartaal', () => {
    quarters.forEach((q, i) => {
      expect(q.activeBegin + q.newCustomers + q.reacquiredCustomers - q.churn, q.label).toBe(q.activeEnd)
      if (i > 0) expect(q.activeBegin, q.label).toBe(quarters[i - 1].activeEnd)
    })
  })

  it('jaar: actieve klanten en gemiddelde CLV veranderen met precies de som van de flows', () => {
    for (let i = 4; i < quarters.length; i++) {
      const q = quarters[i]
      const flows = sum4(i, (k) => quarters[k].newCustomers + quarters[k].reacquiredCustomers - quarters[k].churn)
      expect(q.activeEnd - quarters[i - 4].activeEnd, q.label).toBe(flows)
      const effects = sum4(i, (k) => quarters[k].customerMix + quarters[k].existingCustomerValue)
      expect(q.avgClv - quarters[i - 4].avgClv, q.label).toBeCloseTo(effects, 6)
    }
  })

  it('"Last 4 quarters" is de som van de vier kwartalen, voor elk kiesbaar kwartaal', () => {
    expect(selectable.length).toBeGreaterThan(0)
    for (const i of selectable) {
      const q = quarters[i]
      expect(q.newLast4Quarters, q.label).toBe(sum4(i, (k) => quarters[k].newCustomers))
      expect(q.reacquiredLast4Quarters, q.label).toBe(sum4(i, (k) => quarters[k].reacquiredCustomers))
      expect(q.churnLast4Quarters, q.label).toBe(sum4(i, (k) => quarters[k].churn))
      expect(q.customerMixLast4Quarters!, q.label).toBeCloseTo(sum4(i, (k) => quarters[k].customerMix), 3)
      expect(q.existingCustomerValueLast4Quarters!, q.label).toBeCloseTo(sum4(i, (k) => quarters[k].existingCustomerValue), 3)
      // De vergelijking met de vier kwartalen daarvoor bestaat voor elk kiesbaar kwartaal.
      expect(q.newLast4VsPrior4, q.label).not.toBeNull()
      expect(q.reacquiredLast4VsPrior4, q.label).not.toBeNull()
      expect(q.churnLast4VsPrior4, q.label).not.toBeNull()
    }
  })

  it('verschil met de vier kwartalen daarvoor sluit aan op het kwartaal een jaar eerder', () => {
    for (const i of selectable) {
      const q = quarters[i]
      const prior = quarters[i - 4]
      if (prior.newLast4Quarters === null) continue
      expect(q.newLast4VsPrior4!.abs, q.label).toBe(q.newLast4Quarters! - prior.newLast4Quarters)
      expect(q.churnLast4VsPrior4!.abs, q.label).toBe(q.churnLast4Quarters! - prior.churnLast4Quarters!)
    }
  })

  it('de jaarwaterfall telt dezelfde gebeurtenissen als de tegels', () => {
    for (const i of selectable) {
      const q = quarters[i]
      expect(q.yearWaterfall!.counts.newCustomers, q.label).toBe(q.newLast4Quarters)
      expect(q.yearWaterfall!.counts.reacquiredCustomers, q.label).toBe(q.reacquiredLast4Quarters)
      expect(q.yearWaterfall!.counts.churn, q.label).toBe(q.churnLast4Quarters)
    }
  })

  it('YoY van de flows = dit kwartaal − hetzelfde kwartaal een jaar eerder (migratie 19)', () => {
    const flows = [
      ['newCustomers', 'newVsYearAgo'],
      ['reacquiredCustomers', 'reacquiredVsYearAgo'],
      ['churn', 'churnVsYearAgo'],
    ] as const
    quarters.forEach((q, i) => {
      for (const [key, yoy] of flows) {
        if (i < 4) {
          expect(q[yoy], `${q.label} ${yoy}`).toBeNull()
          continue
        }
        const diff = q[key] - quarters[i - 4][key]
        expect(q[yoy]!.abs, `${q.label} ${yoy}`).toBe(diff)
        expect(q[yoy]!.pct, `${q.label} ${yoy}`).toBeCloseTo(diff / quarters[i - 4][key], 5)
      }
    })
    for (const i of selectable) expect(quarters[i].churnVsYearAgo, quarters[i].label).not.toBeNull()
  })

  it('effecttegels: mix + value = CLV QoQ en CLV YoY (binnen 1 cent), voor elk kiesbaar kwartaal', () => {
    for (const i of selectable) {
      const q = quarters[i]
      // QoQ: het effect dit kwartaal
      expect(Math.abs(q.customerMix + q.existingCustomerValue - q.avgClvVsPrevQuarter!.abs), q.label).toBeLessThanOrEqual(0.01)
      // YoY: de som van het effect over de laatste vier kwartalen
      expect(
        Math.abs(q.customerMixLast4Quarters! + q.existingCustomerValueLast4Quarters! - q.avgClvVsYearAgo!.abs),
        q.label,
      ).toBeLessThanOrEqual(0.01)
    }
  })

  it('mix effect = nieuwkomers + vertrekkers, per kwartaal en over vier kwartalen (migratie 20)', () => {
    quarters.forEach((q) => {
      expect(Math.abs(q.customerMixNewcomers + q.customerMixLeavers - q.customerMix), q.label).toBeLessThan(1e-9)
      if (q.customerMixLast4Quarters === null) {
        expect(q.customerMixNewcomersLast4Quarters, q.label).toBeNull()
        return
      }
      expect(
        Math.abs(q.customerMixNewcomersLast4Quarters! + q.customerMixLeaversLast4Quarters! - q.customerMixLast4Quarters),
        q.label,
      ).toBeLessThanOrEqual(0.01)
    })
  })

  it('de Vs-velden van de effecten zijn weg', () => {
    const gone = ['customerMixVsPrevQuarter', 'customerMixVsYearAgo', 'existingCustomerValueVsPrevQuarter',
      'existingCustomerValueVsYearAgo']
    for (const q of quarters) for (const k of gone) expect(k in q, `${q.label} ${k}`).toBe(false)
  })
})
