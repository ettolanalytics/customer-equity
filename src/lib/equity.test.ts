// Hero-kaart customer equity (stock): waarde op de laatste dag, QoQ en YoY, getoetst op de
// opgehaalde data (src/data/quarters.json) en de notatie uit CLAUDE.md.
import { describe, expect, it } from 'vitest'
import { gb } from './format'
import { quarters } from './quarters'

const sumParts = (p: Record<string, number>) => Object.values(p).reduce((a, v) => a + v, 0)

describe('customer equity: QoQ en YoY', () => {
  it('QoQ = CE nu − CE vorig kwartaal = som van de kwartaalwaterfall (≤ €1)', () => {
    quarters.forEach((q, i) => {
      if (!q.equityVsPrevQuarter) return
      expect(q.equityVsPrevQuarter.abs, q.label).toBeCloseTo(q.customerEquity - quarters[i - 1].customerEquity, 1)
      expect(q.waterfall, q.label).not.toBeNull()
      expect(Math.abs(q.equityVsPrevQuarter.abs - sumParts(q.waterfall!.parts)), q.label).toBeLessThanOrEqual(1)
    })
  })

  it('YoY = CE nu − CE een jaar eerder = som van de jaarwaterfall (≤ €1)', () => {
    quarters.forEach((q, i) => {
      if (!q.equityVsYearAgo) return
      expect(q.equityVsYearAgo.abs, q.label).toBeCloseTo(q.customerEquity - quarters[i - 4].customerEquity, 1)
      expect(q.yearWaterfall, q.label).not.toBeNull()
      expect(Math.abs(q.equityVsYearAgo.abs - sumParts(q.yearWaterfall!.parts)), q.label).toBeLessThanOrEqual(1)
    })
  })

  it('percentages zijn het verschil gedeeld door de vorige stand', () => {
    quarters.forEach((q, i) => {
      if (q.equityVsPrevQuarter) {
        expect(q.equityVsPrevQuarter.pct, q.label).toBeCloseTo(q.equityVsPrevQuarter.abs / quarters[i - 1].customerEquity, 5)
      }
      if (q.equityVsYearAgo) {
        expect(q.equityVsYearAgo.pct, q.label).toBeCloseTo(q.equityVsYearAgo.abs / quarters[i - 4].customerEquity, 5)
      }
    })
  })
})

describe('notatie hero (CLAUDE.md)', () => {
  it('waarde in miljoenen met één decimaal', () => {
    expect(gb.millions(14_648_750.28)).toBe('€14.6m')
  })
  it('veranderingen onder €1m in duizenden, vanaf €1m in miljoenen, met teken', () => {
    expect(gb.signedThousands(578_376.19)).toBe('+€578k')
    expect(gb.signedThousands(1_762_004.5)).toBe('+€1.8m')
    expect(gb.signedThousands(-326_890.43)).toBe('−€327k')
    expect(gb.signedThousands(-1_250_000)).toBe('−€1.3m')
  })
})
