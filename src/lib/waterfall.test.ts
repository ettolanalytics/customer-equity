// Waterfall met de eigen CLV van klanten (migratie 21), getoetst op de opgehaalde data:
// vier balken die precies optellen tot de verandering van customer equity, per kwartaal en per jaar;
// jaar = som van de vier kwartalen; aantallen zijn de gebeurtenissen van de tegels.
import { describe, expect, it } from 'vitest'
import { quarters, selectable, type Waterfall } from './quarters'

const sum = (w: Waterfall) => Object.values(w.parts).reduce((a, v) => a + v, 0)

describe('waterfall: elke klant tegen zijn eigen CLV', () => {
  it('vier balken, zonder "who joined and who left"', () => {
    for (const q of quarters) for (const w of [q.waterfall, q.yearWaterfall]) {
      if (!w) continue
      expect(Object.keys(w.parts).sort(), q.label).toEqual(['churn', 'existingCustomerValue', 'newCustomers', 'reacquiredCustomers'])
    }
  })

  it('kwartaal: balken = CE eind − CE begin = CE nu − CE vorig kwartaal (≤ €1)', () => {
    quarters.forEach((q, i) => {
      if (!q.waterfall) return
      expect(Math.abs(sum(q.waterfall) - q.waterfall.equityChange), q.label).toBeLessThanOrEqual(1)
      expect(Math.abs(sum(q.waterfall) - (q.customerEquity - quarters[i - 1].customerEquity)), q.label).toBeLessThanOrEqual(1)
    })
  })

  it('jaar: balken = CE nu − CE een jaar eerder (≤ €1), en = som van de vier kwartalen (≤ 5 cent per balk)', () => {
    quarters.forEach((q, i) => {
      if (!q.yearWaterfall) return
      expect(Math.abs(sum(q.yearWaterfall) - (q.customerEquity - quarters[i - 4].customerEquity)), q.label).toBeLessThanOrEqual(1)
      for (const k of Object.keys(q.yearWaterfall.parts) as (keyof Waterfall['parts'])[]) {
        const four = [0, 1, 2, 3].reduce((a, d) => a + quarters[i - d].waterfall!.parts[k], 0)
        expect(Math.abs(q.yearWaterfall.parts[k] - four), `${q.label} ${k}`).toBeLessThanOrEqual(0.05)
      }
    })
  })

  it('richting: nieuw en terug positief, vertrek negatief', () => {
    for (const i of selectable) for (const w of [quarters[i].waterfall!, quarters[i].yearWaterfall!]) {
      expect(w.parts.newCustomers).toBeGreaterThan(0)
      expect(w.parts.reacquiredCustomers).toBeGreaterThanOrEqual(0)
      expect(w.parts.churn).toBeLessThan(0)
    }
  })

  it('aantallen zijn de gebeurtenissen van de tegels', () => {
    for (const i of selectable) {
      const q = quarters[i]
      expect(q.waterfall!.counts.newCustomers).toBe(q.newCustomers)
      expect(q.waterfall!.counts.reacquiredCustomers).toBe(q.reacquiredCustomers)
      expect(q.waterfall!.counts.churn).toBe(q.churn)
    }
  })
})
