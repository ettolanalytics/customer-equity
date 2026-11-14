// Waterfall met de eigen CLV van klanten, getoetst op de opgehaalde data: vier balken die precies
// optellen tot de verandering van customer equity. Kwartaal (migratie 21): begin → eind kwartaal,
// aantallen zijn de gebeurtenissen van de tegels. Jaar (migratie 22): foto tegen foto, eind zelfde
// kwartaal vorig jaar → eind gekozen kwartaal, netto aantallen; niet de som van vier kwartalen.
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

  it('jaar: balken = CE nu − CE een jaar eerder (≤ €1), begin en eind uit de twee foto’s', () => {
    quarters.forEach((q, i) => {
      if (!q.yearWaterfall) return
      const w = q.yearWaterfall
      expect(Math.abs(sum(w) - (q.customerEquity - quarters[i - 4].customerEquity)), q.label).toBeLessThanOrEqual(1)
      expect(Math.abs(w.equityBegin - quarters[i - 4].customerEquity), q.label).toBeLessThanOrEqual(0.01)
      expect(Math.abs(w.equityEnd - q.customerEquity), q.label).toBeLessThanOrEqual(0.01)
    })
  })

  it('jaar: netto aantallen sluiten (een jaar eerder + new + reacquired − churn = nu; blijvers + churn = een jaar eerder)', () => {
    quarters.forEach((q, i) => {
      if (!q.yearWaterfall) return
      const c = q.yearWaterfall.counts
      expect(quarters[i - 4].activeEnd + c.newCustomers + c.reacquiredCustomers - c.churn, q.label).toBe(q.activeEnd)
      expect(c.stayingCustomers! + c.churn, q.label).toBe(quarters[i - 4].activeEnd)
    })
  })

  it('jaar: netto aantallen zijn kleiner dan of gelijk aan de gebeurtenissen van vier kwartalen', () => {
    for (const i of selectable) {
      const q = quarters[i]
      expect(q.yearWaterfall!.counts.newCustomers + q.yearWaterfall!.counts.reacquiredCustomers, q.label)
        .toBeLessThanOrEqual(q.newLast4Quarters! + q.reacquiredLast4Quarters!)
      expect(q.yearWaterfall!.counts.churn, q.label).toBeLessThanOrEqual(q.churnLast4Quarters!)
    }
  })

  it('richting: nieuw en terug positief, vertrek negatief', () => {
    for (const i of selectable) for (const w of [quarters[i].waterfall!, quarters[i].yearWaterfall!]) {
      expect(w.parts.newCustomers).toBeGreaterThan(0)
      expect(w.parts.reacquiredCustomers).toBeGreaterThanOrEqual(0)
      expect(w.parts.churn).toBeLessThan(0)
    }
  })

  it('kwartaal: aantallen zijn de gebeurtenissen van de tegels', () => {
    for (const i of selectable) {
      const q = quarters[i]
      expect(q.waterfall!.counts.newCustomers).toBe(q.newCustomers)
      expect(q.waterfall!.counts.reacquiredCustomers).toBe(q.reacquiredCustomers)
      expect(q.waterfall!.counts.churn).toBe(q.churn)
    }
  })
})
