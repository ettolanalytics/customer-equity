import type { CustomerEquityDataset } from './types'

// Fictieve, onderling consistente voorbeelddata uit het Claude Design-ontwerp "Customer Equity".
export const sampleData: CustomerEquityDataset = {
  company: 'Voorbeeldbedrijf B.V.',
  isSampleData: true,
  refreshedAt: '2026-11-02',
  discountRate: 0.1,
  periods: {
    previous: {
      month: '2025-10',
      activeCustomers: 44100,
      marginPerCustomer: 136,
      retention: 0.64,
      averageOrderValue: 184,
      ordersPerCustomer: 2.22,
      returnRate: 0.163,
    },
    current: {
      month: '2026-10',
      activeCustomers: 46800,
      marginPerCustomer: 140,
      retention: 0.66,
      averageOrderValue: 189,
      ordersPerCustomer: 2.31,
      returnRate: 0.148,
    },
  },
  monthlyTrend: [
    { month: '2025-11', activeCustomers: 44310, marginPerCustomer: 136.2, retention: 0.641 },
    { month: '2025-12', activeCustomers: 44520, marginPerCustomer: 136.5, retention: 0.642 },
    { month: '2026-01', activeCustomers: 44680, marginPerCustomer: 136.8, retention: 0.643 },
    { month: '2026-02', activeCustomers: 44900, marginPerCustomer: 137, retention: 0.645 },
    { month: '2026-03', activeCustomers: 45120, marginPerCustomer: 137.3, retention: 0.646 },
    { month: '2026-04', activeCustomers: 45390, marginPerCustomer: 137.7, retention: 0.648 },
    { month: '2026-05', activeCustomers: 45610, marginPerCustomer: 138, retention: 0.65 },
    { month: '2026-06', activeCustomers: 45850, marginPerCustomer: 138.4, retention: 0.652 },
    { month: '2026-07', activeCustomers: 46080, marginPerCustomer: 138.8, retention: 0.654 },
    { month: '2026-08', activeCustomers: 46300, marginPerCustomer: 139.2, retention: 0.656 },
    { month: '2026-09', activeCustomers: 46560, marginPerCustomer: 139.6, retention: 0.658 },
    { month: '2026-10', activeCustomers: 46800, marginPerCustomer: 140, retention: 0.66 },
  ],
  driverInputs: {
    repeatPurchaseRate: { current: 0.412, previous: 0.385 },
    brandedSearchClicks: { current: 182000, previous: 161000 },
    directSessions: { current: 1210000, previous: 1140000 },
    newCustomersBrandedDirectShare: { current: 0.47, previous: 0.43 },
    referralShare: { current: 0.084, previous: 0.069 },
  },
  notes: {
    value:
      'Klanten kopen vaker en houden meer, bij een iets hogere orderwaarde. Marge-% daalt wel: de omzetgroei gaat deels samen met hogere kosten per order.',
    brand:
      'Meer mensen zoeken of komen rechtstreeks naar het merk. Dit zijn proxies: ze tonen merkgericht gedrag, niet de voorkeur zelf.',
    relationship:
      'Retentie is de grootste bijdrager aan de CE-groei. Referral stijgt, maar is gemeten via codes en dus een ondergrens.',
  },
}
