// Kaart "What changed average CLV": per blok bar 1 + bar 2 = bar 3, en bar 3 = de CLV-verandering
// van de CLV-tegel, binnen 1 cent, voor alle kiesbare kwartalen.
import { describe, expect, it } from 'vitest'
import { clvChangeBlocks } from './clvChange'
import { quarters, selectable, viewFor } from './quarters'

describe('What changed average CLV', () => {
  it('twee blokken (QoQ, YoY) met drie bars voor elk kiesbaar kwartaal', () => {
    for (const i of selectable) {
      const blocks = clvChangeBlocks(viewFor(i))
      expect(blocks.map((b) => b.key), quarters[i].label).toEqual(['qoq', 'yoy'])
      for (const b of blocks) expect(b.bars).toHaveLength(3)
    }
  })

  it('bar 1 + bar 2 = bar 3 = CLV-verandering van de CLV-tegel (binnen 1 cent)', () => {
    for (const i of selectable) {
      const q = quarters[i]
      const [qoq, yoy] = clvChangeBlocks(viewFor(i))
      for (const [b, tile] of [[qoq, q.avgClvVsPrevQuarter!.abs], [yoy, q.avgClvVsYearAgo!.abs]] as const) {
        const [existing, mix, total] = b.bars
        expect(Math.abs(existing.value + mix.value - total.value), `${q.label} ${b.key}`).toBeLessThanOrEqual(0.01)
        expect(Math.abs(total.value - tile), `${q.label} ${b.key}`).toBeLessThanOrEqual(0.01)
      }
    }
  })

  it('label van bar 1 volgt het teken; bar 3 is het totaal', () => {
    for (const i of selectable) {
      for (const b of clvChangeBlocks(viewFor(i))) {
        const [existing, mix, total] = b.bars
        expect(existing.label).toBe(`Existing customers became ${existing.value >= 0 ? 'more' : 'less'} valuable`)
        expect(mix.label).toBe('Who joined and who left')
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
