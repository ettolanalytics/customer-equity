// Unit tests voor de Executive summary: elke tak, met verzonnen invoer (los van de data),
// plus een raster over alle combinaties voor de grenzen: hoogstens 3 zinnen, geen vaktermen, geen
// "or" en geen dubbele uitleg van wie kwam en ging, geen lege plekken, geen advies, en S3 noemt
// alleen een eenduidig verlies. Geen woordgrens.
import { describe, expect, it } from 'vitest'
import { amount, executiveSummary, joinersClause, OFFSET_SHARE, pct, SMALL_CLV, STAYERS, type SummaryInput } from './summary'

const base: SummaryInput = {
  ce1: 14_648_750,
  change: 1_762_004,
  changePrev: 1_500_000,
  n: 0.063,
  v: 0.069,
  vAbs: 30.11,
  mix: 2.22,
  mixIn: -22.49,
  mixOut: 24.71,
  val: 27.89,
  parts: { newCustomers: 2_527_831, reacquiredCustomers: 299_238, churn: -2_001_137, customerMix: 68_868, existingCustomerValue: 867_204 },
}
const run = (over: Partial<SummaryInput> = {}) => executiveSummary({ ...base, ...over })
const parts = (over: Partial<SummaryInput['parts']>) => ({ ...base.parts, ...over })
/** Wie kwam en ging met een gegeven verdeling over nieuwkomers en vertrekkers. */
const mixOf = (mixIn: number, mixOut: number) => ({ mix: mixIn + mixOut, mixIn, mixOut })

/** Vaktermen die niet in de summary mogen ("customer equity" en "CLV" mogen wel). */
const JARGON = /mix effect|value effect|customer mix|driver|waterfall|churn|reacquired|cohort|segment/i

describe('notatie en drempels', () => {
  it('percentages zonder teken: hele procenten, onder 0,5% één decimaal', () => {
    expect(pct(0.063)).toBe('6%')
    expect(pct(-0.137)).toBe('14%')
    expect(pct(0.003)).toBe('0.3%')
  })
  it('bedragen: vanaf €1m in miljoenen, daaronder in duizenden', () => {
    expect(amount(14_648_750)).toBe('€14.6m')
    expect(amount(-860_400)).toBe('€860k')
  })
  it('drempels zoals besloten', () => {
    expect(SMALL_CLV).toBe(0.01)
    expect(OFFSET_SHARE).toBe(0.1)
  })
})

describe('wie kwam en ging: nieuwkomers en vertrekkers', () => {
  it('het deel dat de doorslag gaf; het kleinere deel zonder bedrag, met wat het deed', () => {
    expect(joinersClause(2.5, 0.5)).toBe(
      'newcomers were worth more than the customers who stayed (+€2.50); that leavers were worth less strengthened this a little',
    )
  })
  it('vertrekkers die minder waard waren: bedrag als gevolg, geen plusteken naast "worth less"', () => {
    expect(joinersClause(-22, 25)).toBe(
      'leavers were worth less than the customers who stayed, which raised average CLV by €25.00; that newcomers were worth less too largely offset this',
    )
  })
  it('het voorbeeld uit het besluit', () => {
    expect(joinersClause(-1.5, 0.5)).toBe(
      'newcomers were worth less than the customers who stayed (−€1.50); that leavers were worth less too softened this a little',
    )
  })
  it('het kleinere deel onder 10% van het grootste valt weg', () => {
    expect(joinersClause(3.2, -0.2)).toBe('newcomers were worth more than the customers who stayed (+€3.20)')
    expect(joinersClause(3, -0.31)).toBe(
      'newcomers were worth more than the customers who stayed (+€3.00); that leavers were worth more too softened this a little',
    )
  })
  it('vertrekkers die meer waard waren: lager, geen minteken naast "worth more"', () => {
    expect(joinersClause(0.4, -5)).toBe('leavers were worth more than the customers who stayed, which lowered average CLV by €5.00')
  })
  it('alleen het grootste deel als het kleinere niet gevraagd is', () => {
    expect(joinersClause(-6, 1, false)).toBe('newcomers were worth less than the customers who stayed (−€6.00)')
  })
})

describe('1. Resultaat', () => {
  it('meer, en een grotere stijging dan het jaar ervoor', () => {
    expect(run().sentences[0]).toBe(
      'Your customer base is worth €14.6m, €1.8m more than a year ago, a bigger increase than the year before (€1.5m).',
    )
  })
  it('meer, maar een kleinere stijging dan het jaar ervoor', () => {
    expect(run({ change: 400_000, changePrev: 900_000 }).sentences[0]).toBe(
      'Your customer base is worth €14.6m, €400k more than a year ago, a smaller increase than the year before (€900k).',
    )
  })
  it('minder, na een stijging het jaar ervoor', () => {
    expect(run({ change: -400_000, changePrev: 900_000 }).sentences[0]).toBe(
      'Your customer base is worth €14.6m, €400k less than a year ago, after a rise of €900k the year before.',
    )
  })
  it('meer, na een daling het jaar ervoor', () => {
    expect(run({ change: 300_000, changePrev: -500_000 }).sentences[0]).toBe(
      'Your customer base is worth €14.6m, €300k more than a year ago, after a fall of €500k the year before.',
    )
  })
  it('minder, en een grotere daling dan het jaar ervoor', () => {
    expect(run({ change: -900_000, changePrev: -300_000 }).sentences[0]).toBe(
      'Your customer base is worth €14.6m, €900k less than a year ago, a bigger fall than the year before (€300k).',
    )
  })
  it('ongeveer dezelfde stijging: verschil hoogstens 0,5% van customer equity', () => {
    const r = run({ change: 1_762_004, changePrev: 1_700_000 })
    expect(r.branches.s1).toBe('meer, gelijk')
    expect(r.sentences[0]).toContain('about the same increase as the year before (€1.7m)')
  })
  it('zonder kwartaal een jaar eerder: geen vergelijking', () => {
    expect(run({ changePrev: null }).sentences[0]).toBe('Your customer base is worth €14.6m, €1.8m more than a year ago.')
  })
  it('vrijwel gelijk aan een jaar eerder (kleiner dan 0,1%)', () => {
    expect(run({ change: 10_000, changePrev: null }).sentences[0]).toBe('Your customer base is worth €14.6m, about the same as a year ago.')
  })
})

describe('2. Verklaring', () => {
  it('beide omhoog, bestaande klanten meer waard, met de bedragen per klant', () => {
    expect(run().sentences[1]).toBe(
      'Customers grew 6% and average CLV rose 7% (+€30.11 per customer), mainly because existing customers became more valuable (+€27.89).',
    )
  })
  it('CLV-verandering onder 1%: alleen "barely changed", geen redenen', () => {
    expect(run({ v: 0.004, vAbs: 1.74 }).sentences[1]).toBe('Customers grew 6% and average CLV barely changed (+€1.74 per customer).')
    expect(run({ v: -0.0099, vAbs: -4.5 }).sentences[1]).toBe('Customers grew 6% and average CLV barely changed (−€4.50 per customer).')
    expect(run({ v: 0.01, vAbs: 4.6 }).sentences[1]).toContain('mainly because')
  })
  it('klanten en CLV vrijwel gelijk', () => {
    expect(run({ n: 0.0001, v: 0.0002, vAbs: 0.09 }).sentences[1]).toBe(
      'Customers held steady and average CLV barely changed (+€0.09 per customer).',
    )
  })
  it('minder klanten en lagere CLV', () => {
    expect(run({ n: -0.02, v: -0.03, vAbs: -14, val: -15, ...mixOf(0.5, 0.5) }).sentences[1]).toBe(
      'Customers fell 2% and average CLV fell 3% (−€14.00 per customer), mainly because existing customers became less valuable (−€15.00).',
    )
  })
  it('wie kwam en ging als hoofdreden, met tegenwerking van bestaande klanten', () => {
    expect(run({ n: -0.01, v: 0.02, vAbs: 2, val: -1, ...mixOf(2.5, 0.5) }).sentences[1]).toBe(
      'Customers fell 1% but average CLV rose 2% (+€2.00 per customer), mainly because newcomers were worth more than the customers who stayed (+€2.50); that leavers were worth less strengthened this a little, although existing customers became less valuable (−€1.00).',
    )
  })
  it('bestaande klanten als hoofdreden, wie kwam en ging werkt tegen: alleen het grootste deel', () => {
    expect(run({ v: 0.05, vAbs: 25, val: 30, ...mixOf(-6, 1) }).sentences[1]).toBe(
      'Customers grew 6% and average CLV rose 5% (+€25.00 per customer), mainly because existing customers became more valuable (+€30.00), although newcomers were worth less than the customers who stayed (−€6.00).',
    )
  })
  it('tegenwerkende reden alleen vanaf 10% van de hoofdreden', () => {
    expect(run({ vAbs: 27.5, val: 30, ...mixOf(-2.5, 0) }).sentences[1]).not.toContain('although')
    expect(run({ vAbs: 27, val: 30, ...mixOf(-3, 0) }).sentences[1]).toContain('although newcomers were worth less')
  })
})

describe('3. Grootste verlies', () => {
  it('vertrekkers tegenover nieuwe en terugkerende klanten', () => {
    expect(run().sentences[2]).toBe(
      'The biggest loss was customers who left: they took €2.0m of value with them, more than half of the €2.8m that new and returning customers brought in.',
    )
  })
  it('bestaande klanten minder waard, nog niet uitgelegd in S2', () => {
    const r = run({ val: -3, vAbs: 37, ...mixOf(38, 2), parts: parts({ churn: -500_000, existingCustomerValue: -860_000 }) })
    expect(r.sentences[2]).toBe('The biggest loss (€860k) came from existing customers becoming less valuable.')
  })
  it('bestaande klanten minder waard, al uitgelegd in S2: korte verwijzing', () => {
    const r = run({ v: -0.03, vAbs: -14, val: -15, ...mixOf(0.5, 0.5), parts: parts({ churn: -500_000, existingCustomerValue: -860_000 }) })
    expect(r.sentences[2]).toBe('That fall in the value of existing customers was also the biggest loss (€860k).')
  })
  it('wie kwam en ging als grootste verlies, nog niet uitgelegd in S2', () => {
    const r = run({ ...mixOf(-1.5, 0.5), parts: parts({ churn: -100_000, customerMix: -1_200_000 }) })
    expect(r.sentences[2]).toBe(
      'The biggest loss (€1.2m) came from the shift in who joined and who left: newcomers were worth less than the customers who stayed (−€1.50); that leavers were worth less too softened this a little.',
    )
  })
  it('wie kwam en ging, al uitgelegd in S2: korte verwijzing', () => {
    const r = run({ v: -0.02, vAbs: -7, val: 1, ...mixOf(-8, 0), parts: parts({ churn: -100_000, customerMix: -1_200_000 }) })
    expect(r.sentences[2]).toBe('That shift in who joined and who left was also the biggest loss (€1.2m).')
  })
  it('wie kwam en ging, als tegenwerking al genoemd in S2: korte verwijzing', () => {
    const r = run({ v: 0.05, vAbs: 25, val: 30, ...mixOf(-5, 0), parts: parts({ churn: -100_000, customerMix: -1_200_000 }) })
    expect(r.sentences[1]).toContain('although newcomers were worth less')
    expect(r.sentences[2]).toBe('That shift in who joined and who left was also the biggest loss (€1.2m).')
  })
  it('niet eenduidig (per klant omhoog, in euro negatief): niet het grootste verlies, de volgende wel', () => {
    const mix = run({ v: 0.04, vAbs: 7, val: 1, ...mixOf(6, 0), parts: parts({ churn: -200_000, customerMix: -450_000 }) })
    expect(mix.sentences[2]).toMatch(/^The biggest loss was customers who left: they took €200k/)
    const val = run({ parts: parts({ churn: -200_000, existingCustomerValue: -450_000 }) })
    expect(val.sentences[2]).toMatch(/^The biggest loss was customers who left: they took €200k/)
  })
  it('geen eenduidig negatief onderdeel: geen derde zin', () => {
    expect(run({ parts: parts({ churn: 0 }) }).sentences).toHaveLength(2)
    expect(run({ ...mixOf(6, 0), parts: parts({ churn: 0, customerMix: -450_000 }) }).sentences).toHaveLength(2)
  })
  it('CLV nauwelijks veranderd, verlies bij bestaande klanten: deels gecompenseerd door wie kwam en ging', () => {
    const r = run({ n: 0.0001, v: 0.0002, vAbs: 0.05, val: -5, ...mixOf(5.05, 0), parts: parts({ churn: -400_000, existingCustomerValue: -950_000, customerMix: 930_000 }) })
    expect(r.sentences[2]).toBe(
      'The biggest loss (€950k) came from existing customers becoming less valuable, partly offset because newcomers and leavers together raised average CLV (€930k).',
    )
  })
  it('CLV nauwelijks veranderd, verlies door wie kwam en ging: deels gecompenseerd door bestaande klanten', () => {
    const r = run({ v: 0.0001, vAbs: 0.04, val: 1.04, ...mixOf(-1, 0), parts: parts({ churn: -100_000, customerMix: -1_100_000, existingCustomerValue: 1_050_000 }) })
    expect(r.sentences[2]).toBe(
      'The biggest loss (€1.1m) came from the shift in who joined and who left: newcomers were worth less than the customers who stayed (−€1.00); existing customers becoming more valuable partly offset this (€1.1m).',
    )
  })
})

describe('grenzen over alle combinaties', () => {
  const signs = [0.063, -0.042, 0.004, 0.0001]
  // [mix, val] per klant over het jaar; mix in drie verdelingen over nieuwkomers en vertrekkers
  const effects: [number, number][] = [[2, 30], [2, -30], [30, 2], [-30, 2], [-5, 30], [5, -30], [30, -5], [-30, 5]]
  const splits = (mix: number): [number, number][] => [[mix * 1.2, -mix * 0.2], [-22, mix + 22], [mix, 0], [mix * 0.95, mix * 0.05]]
  const s1: Partial<SummaryInput>[] = [
    { change: 1_762_004, changePrev: 1_500_000 }, { change: -1_200_000, changePrev: 900_000 },
    { change: 900_000, changePrev: 880_000 }, { change: 5_000, changePrev: null },
    { change: -900_000, changePrev: -300_000 }, { change: 300_000, changePrev: -500_000 },
  ]
  const s3 = [
    parts({}), parts({ churn: -100_000, customerMix: -1_234_567 }), parts({ churn: -100_000, existingCustomerValue: -1_234_567 }),
    parts({ churn: -9_876_543 }), parts({ churn: -100_000, customerMix: -1_234_567, existingCustomerValue: 1_200_000 }),
    parts({ churn: -100_000, existingCustomerValue: -1_234_567, customerMix: 1_200_000 }), parts({ churn: 0 }),
  ]
  const all: { s: string[]; i: SummaryInput; s3: string }[] = []
  for (const n of signs) for (const v of signs) for (const [mix, val] of effects) for (const [mixIn, mixOut] of splits(mix))
    for (const a of s1) for (const p of s3) {
      const i: SummaryInput = { ...base, n, v, vAbs: v * 430, mix, mixIn, mixOut, val, ...a, parts: p }
      const r = executiveSummary(i)
      all.push({ s: r.sentences, i, s3: r.branches.s3 })
    }
  const text = (x: { s: string[] }) => x.s.join(' ')
  it(`${all.length} combinaties: hoogstens 3 zinnen`, () => {
    for (const x of all) expect(x.s.length).toBeLessThanOrEqual(3)
  })
  it('geen vaktermen (alleen customer equity en CLV)', () => {
    for (const x of all) expect(text(x)).not.toMatch(JARGON)
  })
  it('geen "or": de summary noemt wat er gebeurde', () => {
    for (const x of all) expect(text(x)).not.toMatch(/\bor\b/i)
  })
  it('nooit "the customers who joined and left" als groep, en geen "while … also"', () => {
    for (const x of all) {
      expect(text(x)).not.toMatch(/joined and left/)
      expect(text(x)).not.toMatch(/\bwhile\b|also worth/)
    }
  })
  it('tekens: geen "+" bij "worth less" en geen "−" bij "worth more" (in dezelfde bijzin)', () => {
    for (const x of all) {
      expect(text(x)).not.toMatch(/worth less[^;,()]*\(\+/)
      expect(text(x)).not.toMatch(/worth more[^;,()]*\(−/)
      expect(text(x)).not.toMatch(/less valuable \(\+|more valuable \(−/)
    }
  })
  it('wie kwam en ging als tegenwerkende reden in S2: alleen het grootste deel', () => {
    for (const x of all) {
      const m = x.s[1].match(/although (newcomers|leavers)[^.]*/)
      if (m) expect(m[0]).not.toMatch(/; that/)
    }
  })
  it('wie kwam en ging wordt hoogstens één keer uitgelegd', () => {
    for (const x of all) expect(text(x).split(STAYERS).length - 1, text(x)).toBeLessThanOrEqual(1)
  })
  it('CLV-verandering onder 1%: geen redenen in S2', () => {
    for (const x of all) if (Math.abs(x.i.v) < SMALL_CLV) expect(x.s[1]).not.toMatch(/because|although/)
  })
  it('S3 kiest alleen een eenduidig verlies (jaarbedrag en effect per klant dezelfde richting)', () => {
    for (const x of all) {
      if (x.s3.startsWith('kwam/ging')) expect(x.i.mix).toBeLessThan(0)
      if (x.s3.startsWith('bestaand')) expect(x.i.val).toBeLessThan(0)
      expect(text(x)).not.toMatch(/Measured in euros|weigh more/)
    }
  })
  it('geen lege plekken: elke zin eindigt met een punt, geen lege haakjes of ontbrekende waarden', () => {
    for (const x of all) for (const s of x.s) {
      expect(s).toMatch(/[^ ]\.$/)
      expect(s, s).not.toMatch(/undefined|NaN|null|Infinity|\{|\}|\(\)|\( |  | ,| \.|€-|€k|€m/)
    }
  })
  it('geen advies en geen oorzaken buiten de data', () => {
    for (const x of all) expect(text(x)).not.toMatch(/\b(should|must|need to|recommend|campaign|season|price|marketing)\b/i)
  })
})
