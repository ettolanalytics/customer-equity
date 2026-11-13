// Kaart "What changed average CLV": per blok bar 1 + 2 + 3 = bar 4, en bar 4 = de CLV-verandering
// van de CLV-tegel, binnen 1 cent, voor alle kiesbare kwartalen. De teksten volgen het teken.
import { describe, expect, it } from 'vitest'
import { clvChangeBlocks, existingLabel, leaversLabel, newcomersLabel } from './clvChange'
import { quarters, selectable, viewFor } from './quarters'

describe('What changed average CLV', () => {
  it('twee blokken (QoQ, YoY) met vier bars voor elk kiesbaar kwartaal', () => {
    for (const i of selectable) {
      const blocks = clvChangeBlocks(viewFor(i))
      expect(blocks.map((b) => b.key), quarters[i].label).toEqual(['qoq', 'yoy'])
      for (const b of blocks) expect(b.bars).toHaveLength(4)
    }
  })

  it('bar 1 + 2 + 3 = bar 4 = CLV-verandering van de CLV-tegel (binnen 1 cent)', () => {
    for (const i of selectable) {
      const q = quarters[i]
      const [qoq, yoy] = clvChangeBlocks(viewFor(i))
      for (const [b, tile] of [[qoq, q.avgClvVsPrevQuarter!.abs], [yoy, q.avgClvVsYearAgo!.abs]] as const) {
        const [existing, newcomers, leavers, total] = b.bars
        expect(Math.abs(existing.value + newcomers.value + leavers.value - total.value), `${q.label} ${b.key}`).toBeLessThanOrEqual(0.01)
        expect(Math.abs(total.value - tile), `${q.label} ${b.key}`).toBeLessThanOrEqual(0.01)
      }
    }
  })

  it('teksten volgen het teken; vertrekkers positief = minder waard', () => {
    expect(leaversLabel(6.5)).toBe('Customers who left were worth less than those who stayed')
    expect(leaversLabel(-0.4)).toBe('Customers who left were worth more than those who stayed')
    expect(newcomersLabel(-5.7)).toBe('New and returning customers were worth less than existing ones')
    expect(newcomersLabel(1.2)).toBe('New and returning customers were worth more than existing ones')
    for (const i of selectable) {
      for (const b of clvChangeBlocks(viewFor(i))) {
        const [existing, newcomers, leavers, total] = b.bars
        expect(existing.label).toBe(existingLabel(existing.value))
        expect(newcomers.label).toBe(newcomersLabel(newcomers.value))
        expect(leavers.label).toBe(leavers.value >= 0
          ? 'Customers who left were worth less than those who stayed'
          : 'Customers who left were worth more than those who stayed')
        expect(total.label).toBe('Change in average CLV')
        expect(total.total).toBe(true)
      }
    }
  })

  it('vergelijkingslabels uit de data', () => {
    const i = quarters.findIndex((q) => q.label === 'Q3 2026')
    const [qoq, yoy] = clvChangeBlocks(viewFor(i))
    expect([qoq.title, qoq.vs, yoy.title, yoy.vs]).toEqual(['QoQ', 'vs Q2 2026', 'YoY', 'vs Q3 2025'])
  })
})
