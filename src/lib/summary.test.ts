// Unit tests voor de Executive summary: elke tak van S1–S3, met verzonnen invoer (los van de data).
import { describe, expect, it } from 'vitest'
import { amount, executiveSummary, pct, type SummaryInput } from './summary'

const base: SummaryInput = {
  ce1: 14_648_750,
  g: 0.137,
  gPrev: 0.08,
  n: 0.063,
  v: 0.069,
  mix: 2.2,
  val: 27.9,
  parts: { newCustomers: 2_527_831, reacquiredCustomers: 299_238, churn: -2_001_137, customerMix: 68_868, existingCustomerValue: 867_204 },
  churnLever: 200_113.69,
}
const run = (over: Partial<SummaryInput> = {}) => executiveSummary({ ...base, ...over })
const parts = (over: Partial<SummaryInput['parts']>) => ({ ...base.parts, ...over })

describe('notatie', () => {
  it('percentages: hele procenten met teken, onder 0,5% één decimaal', () => {
    expect(pct(0.063, true)).toBe('+6%')
    expect(pct(-0.137, true)).toBe('−14%')
    expect(pct(0.003, true)).toBe('+0.3%')
    expect(pct(-0.004, false)).toBe('0.4%')
  })
  it('bedragen: vanaf €1m in miljoenen, daaronder in duizenden, zonder teken', () => {
    expect(amount(14_648_750)).toBe('€14.6m')
    expect(amount(-860_400)).toBe('€860k')
  })
})

describe('S1: antwoord en vergelijking met een jaar eerder', () => {
  it('meer, beter dan het jaar ervoor', () => {
    const r = run()
    expect(r.sentences[0]).toBe('Your customer base is worth €14.6m, 14% more than a year ago, a better result than the year before (+8%).')
    expect(r.branches.s1).toBe('beter')
  })
  it('minder, zwakker dan het jaar ervoor', () => {
    const r = run({ g: -0.05, gPrev: 0.02 })
    expect(r.sentences[0]).toBe('Your customer base is worth €14.6m, 5% less than a year ago, a weaker result than the year before (+2%).')
    expect(r.branches.s1).toBe('zwakker')
  })
  it('gelijk binnen 0,5 procentpunt', () => {
    const r = run({ g: 0.084, gPrev: 0.08 })
    expect(r.sentences[0]).toBe('Your customer base is worth €14.6m, 8% more than a year ago, in line with the year before (+8%).')
    expect(r.branches.s1).toBe('gelijk')
  })
  it('precies 0,5 procentpunt beter is nog "in line"', () => {
    expect(run({ g: 0.085, gPrev: 0.08 }).branches.s1).toBe('gelijk')
  })
  it('zonder kwartaal een jaar eerder: geen vergelijking', () => {
    const r = run({ gPrev: null })
    expect(r.sentences[0]).toBe('Your customer base is worth €14.6m, 14% more than a year ago.')
  })
  it('g = 0 telt als "more"', () => {
    expect(run({ g: 0, gPrev: null }).sentences[0]).toBe('Your customer base is worth €14.6m, 0.0% more than a year ago.')
  })
})

describe('S2: de twee factoren en de grootste oorzaak', () => {
  it('beide omhoog, value effect positief', () => {
    expect(run().sentences[1]).toBe(
      'Both drivers helped: you have more customers (+6%) and they are worth more (average CLV +7%), mainly because existing customers became more valuable.',
    )
  })
  it('beide omlaag, value effect negatief', () => {
    expect(run({ n: -0.02, v: -0.03, val: -10, mix: 1 }).sentences[1]).toBe(
      'Both drivers fell: you have fewer customers (−2%) and they are worth less (average CLV −3%), mainly because existing customers became less valuable.',
    )
  })
  it('meer klanten, lagere CLV, mix effect negatief', () => {
    expect(run({ n: 0.04, v: -0.01, mix: -3, val: 1 }).sentences[1]).toBe(
      'You have more customers (+4%), but they are worth less (average CLV −1%), mainly because the customers who joined and left were, on average, worth less than the ones who stayed.',
    )
  })
  it('minder klanten, hogere CLV, mix effect positief', () => {
    expect(run({ n: -0.01, v: 0.02, mix: 3, val: -1 }).sentences[1]).toBe(
      'You have fewer customers (−1%), but they are worth more (average CLV +2%), mainly because the customers who joined and left were, on average, worth more than the ones who stayed.',
    )
  })
  it('0 telt als ≥ 0, en bij gelijke grootte wint het value effect', () => {
    const r = run({ n: 0, v: 0, mix: -5, val: 5 })
    expect(r.branches.s2).toBe('beide omhoog')
    expect(r.branches.r).toBe('value +')
  })
})

describe('S3: wat het meest remt', () => {
  it('churn, meer dan de nieuwe klanten (groei)', () => {
    const r = run({ parts: parts({ churn: -3_000_000 }) })
    expect(r.sentences[2]).toBe(
      'What holds growth back is churn: the customers you lost were worth €3.0m, more than the value of new customers added (€2.5m).',
    )
    expect(r.branches.c).toBe('more than')
  })
  it('churn: bijna even veel (0,75 ≤ r < 1)', () => {
    expect(run({ parts: parts({ churn: -2_000_000 }) }).branches.c).toBe('almost as much as')
  })
  it('churn: meer dan de helft (0,5 ≤ r < 0,75)', () => {
    expect(run({ parts: parts({ churn: -1_500_000 }) }).branches.c).toBe('more than half of')
  })
  it('churn: minder dan de helft (r < 0,5)', () => {
    expect(run({ parts: parts({ churn: -1_000_000 }) }).branches.c).toBe('less than half of')
  })
  it('churn bij daling: "What pulls value down most is"', () => {
    expect(run({ g: -0.02, parts: parts({ churn: -900_000 }) }).sentences[2]).toBe(
      'What pulls value down most is churn: the customers you lost were worth €900k, less than half of the value of new customers added (€2.5m).',
    )
  })
  it('value effect', () => {
    expect(run({ g: -0.02, parts: parts({ churn: -500_000, existingCustomerValue: -860_000 }) }).sentences[2]).toBe(
      'What pulls value down most is that existing customers became less valuable (€860k).',
    )
  })
  it('mix effect', () => {
    expect(run({ parts: parts({ churn: -100_000, customerMix: -1_200_000 }) }).sentences[2]).toBe(
      'What holds growth back is the customer mix: the customers who joined and left were, on average, worth less than the ones who stayed (€1.2m).',
    )
  })
})

describe('S4: waar ruimte zit', () => {
  it('10% minder churn, uit de data', () => {
    expect(run().sentences.at(-1)).toBe('Every 10% less churn adds about €200k.')
  })
  it('altijd vier zinnen', () => {
    expect(run().sentences).toHaveLength(4)
  })
})
