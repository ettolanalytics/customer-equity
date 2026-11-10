// Unit tests voor de Executive summary: elke tak, met verzonnen invoer (los van de data),
// plus een raster over alle combinaties voor de grenzen (3 zinnen, 60 woorden, geen advies).
import { describe, expect, it } from 'vitest'
import { amount, executiveSummary, pct, wordCount, type SummaryInput } from './summary'

const base: SummaryInput = {
  ce1: 14_648_750,
  change: 1_762_004,
  changePrev: 1_500_000,
  n: 0.063,
  v: 0.069,
  mix: 2.2,
  val: 27.9,
  parts: { newCustomers: 2_527_831, reacquiredCustomers: 299_238, churn: -2_001_137, customerMix: 68_868, existingCustomerValue: 867_204 },
}
const run = (over: Partial<SummaryInput> = {}) => executiveSummary({ ...base, ...over })
const parts = (over: Partial<SummaryInput['parts']>) => ({ ...base.parts, ...over })

describe('notatie', () => {
  it('percentages zonder teken: hele procenten, onder 0,5% één decimaal', () => {
    expect(pct(0.063)).toBe('6%')
    expect(pct(-0.137)).toBe('14%')
    expect(pct(0.003)).toBe('0.3%')
  })
  it('bedragen: vanaf €1m in miljoenen, daaronder in duizenden', () => {
    expect(amount(14_648_750)).toBe('€14.6m')
    expect(amount(-860_400)).toBe('€860k')
  })
})

describe('1. Resultaat', () => {
  it('meer, beter dan het jaar ervoor', () => {
    expect(run().sentences[0]).toBe('Your customer base is worth €14.6m, €1.8m more than a year ago, a better result than the year before (+€1.5m).')
  })
  it('minder, zwakker dan het jaar ervoor', () => {
    expect(run({ change: -400_000, changePrev: 900_000 }).sentences[0]).toBe(
      'Your customer base is worth €14.6m, €400k less than a year ago, a weaker result than the year before (+€900k).',
    )
  })
  it('in line: verschil hoogstens 0,5% van customer equity', () => {
    expect(run({ change: 1_762_004, changePrev: 1_700_000 }).branches.s1).toBe('meer, gelijk')
    expect(run({ change: 1_762_004, changePrev: 1_700_000 }).sentences[0]).toContain('in line with the year before (+€1.7m)')
  })
  it('precies op de drempel is nog in line', () => {
    expect(run({ change: 1_000_000, changePrev: 1_000_000 - 0.005 * base.ce1 }).branches.s1).toBe('meer, gelijk')
  })
  it('vorig jaar was een daling', () => {
    expect(run({ change: 300_000, changePrev: -500_000 }).sentences[0]).toContain('a better result than the year before (−€500k)')
  })
  it('zonder kwartaal een jaar eerder: geen vergelijking', () => {
    expect(run({ changePrev: null }).sentences[0]).toBe('Your customer base is worth €14.6m, €1.8m more than a year ago.')
  })
  it('vrijwel gelijk aan een jaar eerder (kleiner dan 0,1%)', () => {
    expect(run({ change: 10_000, changePrev: null }).sentences[0]).toBe('Your customer base is worth €14.6m, about the same as a year ago.')
  })
})

describe('2. Verklaring', () => {
  it('beide omhoog, value effect', () => {
    expect(run().sentences[1]).toBe('Customers grew 6% and average CLV rose 7%, mainly because existing customers became more valuable.')
  })
  it('beide omlaag, value effect negatief', () => {
    expect(run({ n: -0.02, v: -0.03, val: -10, mix: 1 }).sentences[1]).toBe(
      'Customers fell 2% and average CLV fell 3%, mainly because existing customers became less valuable.',
    )
  })
  it('meer klanten, lagere CLV: "but"', () => {
    expect(run({ n: 0.09, v: -0.11, val: -40, mix: 2 }).sentences[1]).toBe(
      'Customers grew 9% but average CLV fell 11%, mainly because existing customers became less valuable.',
    )
  })
  it('minder klanten, hogere CLV, mix effect positief', () => {
    expect(run({ n: -0.01, v: 0.02, mix: 3, val: -1 }).sentences[1]).toBe(
      'Customers fell 1% but average CLV rose 2%, mainly because customers who joined and left were worth more than those who stayed.',
    )
  })
  it('mix effect negatief als grootste reden', () => {
    expect(run({ n: 0.04, v: -0.01, mix: -3, val: 1 }).sentences[1]).toBe(
      'Customers grew 4% but average CLV fell 1%, mainly because customers who joined and left were worth less than those who stayed.',
    )
  })
  it('klanten gelijk: "held steady" en "and"', () => {
    expect(run({ n: 0.0002, v: 0.02 }).sentences[1]).toBe(
      'Customers held steady and average CLV rose 2%, mainly because existing customers became more valuable.',
    )
  })
  it('CLV gelijk: geen reden', () => {
    expect(run({ v: -0.0001, mix: 0.01, val: -0.05 }).sentences[1]).toBe('Customers grew 6% and average CLV held steady.')
  })
  it('klanten en CLV allebei gelijk', () => {
    expect(run({ n: 0.0001, v: -0.0002 }).sentences[1]).toBe('Customers and average CLV both held steady.')
  })
  it('bij gelijke grootte wint het value effect', () => {
    expect(run({ mix: -5, val: 5 }).branches.r).toBe('value +')
  })
})

describe('3. Grootste effect (zoals voorheen; drempels vast)', () => {
  it('churn: meer dan de nieuwe klanten (r ≥ 1)', () => {
    expect(run({ parts: parts({ churn: -3_000_000 }) }).sentences[2]).toBe(
      'The customers you lost were worth €3.0m, more than the value of new customers added (€2.5m).',
    )
  })
  it('churn: bijna even veel (0,75 ≤ r < 1)', () => {
    expect(run().sentences[2]).toBe('The customers you lost were worth €2.0m, almost as much as the value of new customers added (€2.5m).')
  })
  it('churn: meer dan de helft (0,5 ≤ r < 0,75)', () => {
    expect(run({ parts: parts({ churn: -1_500_000 }) }).branches.s3).toBe('churn: more than half of')
  })
  it('churn: minder dan de helft (r < 0,5)', () => {
    expect(run({ parts: parts({ churn: -1_000_000 }) }).branches.s3).toBe('churn: less than half of')
  })
  it('churn zonder nieuwe klanten telt als "more than"', () => {
    expect(run({ parts: parts({ newCustomers: 0 }) }).branches.s3).toBe('churn: more than')
  })
  it('value effect als grootste verlies', () => {
    expect(run({ parts: parts({ churn: -500_000, existingCustomerValue: -860_000 }) }).sentences[2]).toBe(
      'The largest loss came from existing customers becoming less valuable (€860k).',
    )
  })
  it('mix effect als grootste verlies', () => {
    expect(run({ parts: parts({ churn: -100_000, customerMix: -1_200_000 }) }).sentences[2]).toBe(
      'The largest loss came from customers who joined and left being worth less than those who stayed (€1.2m).',
    )
  })
  it('geen negatief onderdeel: geen derde zin', () => {
    expect(run({ parts: parts({ churn: 0 }) }).sentences).toHaveLength(2)
  })
})

describe('grenzen over alle combinaties', () => {
  const signs = [0.063, -0.042, 0.0001]
  const effects: [number, number][] = [[2, 30], [2, -30], [30, 2], [-30, 2]]
  const s1: Partial<SummaryInput>[] = [
    { change: 1_762_004, changePrev: 1_500_000 }, { change: -1_200_000, changePrev: 900_000 },
    { change: 900_000, changePrev: 880_000 }, { change: 5_000, changePrev: null }, { change: -2_500_000, changePrev: null },
  ]
  const s3 = [parts({}), parts({ churn: -100_000, customerMix: -1_234_567 }), parts({ churn: -100_000, existingCustomerValue: -1_234_567 }), parts({ churn: -9_876_543 })]
  const all: string[][] = []
  for (const n of signs) for (const v of signs) for (const [mix, val] of effects) for (const a of s1) for (const p of s3) {
    all.push(run({ n, v, mix, val, ...a, parts: p }).sentences)
  }
  it(`${all.length} combinaties: hoogstens 3 zinnen en 60 woorden (langste: ${Math.max(...all.map(wordCount))})`, () => {
    for (const s of all) {
      expect(s.length).toBeLessThanOrEqual(3)
      expect(wordCount(s)).toBeLessThanOrEqual(60)
    }
  })
  it('geen advies en geen oorzaken buiten de data', () => {
    for (const s of all) expect(s.join(' ')).not.toMatch(/\b(should|must|need to|campaign|season|price)\b/i)
  })
  it('elke zin eindigt met een punt en bevat geen lege plekken', () => {
    for (const s of all) for (const x of s) {
      expect(x).toMatch(/\.$/)
      expect(x).not.toMatch(/undefined|NaN|null|\{|\}/)
    }
  })
})
