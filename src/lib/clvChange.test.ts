// Kaart "What changed average CLV": per blok drie bars (Existing customers, Customer mix, totaal).
// Bar 1 + bar 2 = bar 3 = de CLV-verandering van de CLV-tegel, binnen 1 cent, voor alle kiesbare
// kwartalen. De tooltip bij Customer mix noemt de twee delen met woorden die bij het teken passen.
import { describe, expect, it } from 'vitest'
import { clvChangeBlocks, existingLabel, mixTip } from './clvChange'
import { quarters, selectable, viewFor } from './quarters'

describe('What changed average CLV', () => {
  it('twee blokken (QoQ, YoY) met drie bars in vaste volgorde', () => {
    for (const i of selectable) {
      const blocks = clvChangeBlocks(viewFor(i))
      expect(blocks.map((b) => b.key), quarters[i].label).toEqual(['qoq', 'yoy'])
      for (const b of blocks) {
        expect(b.bars.map((x) => x.label)).toEqual([existingLabel(b.bars[0].value), 'Change in customer mix', 'Change in average CLV'])
        expect(b.bars[2].total).toBe(true)
      }
    }
  })

  it('bar 1 + bar 2 = bar 3 = CLV-verandering van de CLV-tegel (binnen 1 cent), QoQ en YoY', () => {
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

  it('Customer mix: QoQ = customerMix, YoY = nieuwkomers + vertrekkers foto tegen foto', () => {
    for (const i of selectable) {
      const q = quarters[i]
      const [qoq, yoy] = clvChangeBlocks(viewFor(i))
      expect(Math.abs(qoq.bars[1].value - q.customerMix), q.label).toBeLessThan(1e-9)
      expect(yoy.bars[0].value, q.label).toBe(q.existingCustomerValueYoY)
      expect(yoy.bars[1].value, q.label).toBe(q.customerMixNewcomersYoY! + q.customerMixLeaversYoY!)
    }
  })

  it('tooltip: woorden passen bij het teken', () => {
    expect(mixTip(-5.71, 6.51)).toBe(
      'The effect of who joined and who left. New and returning customers were worth less than existing ones (−€5.71); customers who left were worth less too, which raised the average (+€6.51).',
    )
    expect(mixTip(1.2, -0.4)).toBe(
      'The effect of who joined and who left. New and returning customers were worth more than existing ones (+€1.20); customers who left were worth more too, which lowered the average (−€0.40).',
    )
    expect(mixTip(-2, -1)).toBe(
      'The effect of who joined and who left. New and returning customers were worth less than existing ones (−€2.00); customers who left were worth more, which lowered the average (−€1.00).',
    )
    for (const i of selectable) {
      const q = quarters[i]
      for (const [inV, outV] of [[q.customerMixNewcomers, q.customerMixLeavers], [q.customerMixNewcomersYoY!, q.customerMixLeaversYoY!]]) {
        const t = mixTip(inV, outV)
        expect(t).toContain(`New and returning customers were worth ${inV >= 0 ? 'more' : 'less'} than existing ones (${inV >= 0 ? '+' : '−'}€`)
        expect(t).toContain(`customers who left were worth ${outV >= 0 ? 'less' : 'more'}`)
        expect(t).toContain(`which ${outV >= 0 ? 'raised' : 'lowered'} the average (${outV >= 0 ? '+' : '−'}€`)
      }
    }
  })

  it('YoY Existing customers × actieve klanten nu = Existing customers in de jaarwaterfall (≤ €1)', () => {
    for (const i of selectable) {
      const q = quarters[i]
      expect(Math.abs(q.existingCustomerValueYoY! * q.activeEnd - q.yearWaterfall!.parts.existingCustomerValue), q.label)
        .toBeLessThanOrEqual(1)
    }
  })

  it('zonder kwartaal een jaar eerder geen YoY-delen', () => {
    quarters.slice(0, 4).forEach((q) => {
      expect([q.existingCustomerValueYoY, q.customerMixNewcomersYoY, q.customerMixLeaversYoY], q.label).toEqual([null, null, null])
    })
  })

  it('vergelijkingslabels uit de data', () => {
    const i = quarters.findIndex((q) => q.label === 'Q3 2026')
    const [qoq, yoy] = clvChangeBlocks(viewFor(i))
    expect([qoq.title, qoq.vs, yoy.title, yoy.vs]).toEqual(['QoQ', 'vs Q2 2026', 'YoY', 'vs Q3 2025'])
  })
})
