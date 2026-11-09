"""Generator: synthetische facturen van Beanrise Coffee (fictief koffieabonnement).

Eén pak bonen per maand, maandfactuur van EUR 24,95, geen proefperiode, geen
pauze. Een klant betaalt elke maand op de dag waarop hij begon, tot hij een
keer niet verlengt (churn). Een deel van de vertrekkers komt later terug.

Schrijft naar data/synthetic/:
  beanrise_invoices.parquet       facturen vanaf BUFFER_START (gaat naar Supabase)
  beanrise_invoices_full.parquet  alle facturen vanaf de opwarmstart (alleen controle)
  beanrise_truth.parquet          per abonnementsperiode: groep, start, einde,
                                  terugkeer (alleen controle, nooit voor het dashboard)
  manifest.json                   seed, parameters, aantallen en controlesommen

Draaien:  .venv/bin/python scripts/generate_beanrise.py
"""

import csv
import hashlib
import json
import math
import random
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "synthetic"

GENERATOR_VERSION = "1.1"
SEED = 20261109

# --- Parameters ---------------------------------------------------------------
PRICE_EUR = "24.95"                 # per factuur, de hele periode gelijk
SIM_START = date(2014, 1, 1)        # opwarmstart (niet in de data)
BUFFER_START = date(2018, 10, 1)    # eerste factuur in de data (zie check_beanrise.py)
DATA_END = date(2026, 10, 31)       # laatste factuurdatum

OPENING_CUSTOMERS = 20_000          # klanten bij de opwarmstart, begin in januari 2014
BASE_INFLOW_Q = 1_360               # nieuwe klanten per kwartaal: 0,85 x 0,08 x 20.000
CAMPAIGN_EXTRA = {(2021, 2): 1_800, (2021, 3): 3_600, (2021, 4): 1_800}  # bovenop de basis

BASE_CHURN_Q = 0.08                 # churn per kwartaal (basis, en wie terugkomt)
CAMPAIGN_CHURN_Q = [0.25, 0.20, 0.18, 0.16, 0.14, 0.12, 0.085]  # per kwartaal sinds aanmelding; laatste geldt daarna (V2)
RETURN_P = {"opening": 0.15, "base": 0.15, "campaign": 0.05}  # kans op terugkeer na elke churn
RETURN_GAP_SHORT = 0.80             # aandeel dat 2-6 maanden na de vervaldatum terugkomt
GAP_SHORT_DAYS = (61, 183)          # 2-6 maanden
GAP_LONG_DAYS = (184, 365)          # 6-12 maanden


def monthly(q_rate):
    """Kans per maand om niet te verlengen, uit een kans per kwartaal."""
    return 1 - (1 - q_rate) ** (1 / 3)


BASE_H = monthly(BASE_CHURN_Q)
CAMPAIGN_H = [monthly(x) for x in CAMPAIGN_CHURN_Q]


def add_months(d, n):
    """d + n maanden, dag afgekapt op het einde van de maand (zoals DuckDB)."""
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return date(y, m, min(d.day, (nxt - timedelta(days=1)).day))


def quarters(start, end):
    y, q = start.year, (start.month - 1) // 3 + 1
    while date(y, 3 * q - 2, 1) <= end:
        qs = date(y, 3 * q - 2, 1)
        qe = add_months(qs, 3) - timedelta(days=1)
        yield y, q, qs, min(qe, end)
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)


def geometric(rng, h):
    """Aantal verlengmomenten tot en met de eerste keer niet verlengen."""
    return int(math.log(1 - rng.random()) / math.log(1 - h)) + 1


def n_invoices(rng, cohort, seq):
    """Aantal betaalde facturen in een abonnementsperiode (minimaal 1)."""
    if cohort != "campaign" or seq > 1:
        return geometric(rng, BASE_H)
    done = 0
    for i, h in enumerate(CAMPAIGN_H):
        g = geometric(rng, h)
        if i == len(CAMPAIGN_H) - 1 or g <= 3:
            return done + g
        done += 3


def arrivals(rng):
    """Aanmeldingen: Poisson-proces per kwartaal (exponentiële tussentijden)."""
    out = []
    for i in range(OPENING_CUSTOMERS):
        out.append((SIM_START + timedelta(days=rng.randrange(31)), "opening"))
    for y, q, qs, qe in quarters(SIM_START, DATA_END):
        days = (add_months(qs, 3) - qs).days
        for cohort, n in (("base", BASE_INFLOW_Q), ("campaign", CAMPAIGN_EXTRA.get((y, q), 0))):
            t = rng.expovariate(n / days) if n else days
            while t < days:
                d = qs + timedelta(days=int(t))
                if d <= qe:
                    out.append((d, cohort))
                t += rng.expovariate(n / days)
    out.sort()
    return out


def simulate(seed=SEED):
    """Abonnementsperiodes (spells) per klant, in vaste volgorde."""
    rng = random.Random(seed)
    queue = [(cid, d, cohort, 1) for cid, (d, cohort) in enumerate(arrivals(rng), start=1)]
    spells = []
    i = 0
    while i < len(queue):
        cid, start, cohort, seq = queue[i]
        i += 1
        n = n_invoices(rng, cohort, seq)
        expire = add_months(start, n)          # vervaldatum van de laatste factuur
        ret = None
        if rng.random() < RETURN_P[cohort]:
            lo, hi = GAP_SHORT_DAYS if rng.random() < RETURN_GAP_SHORT else GAP_LONG_DAYS
            ret = expire + timedelta(days=rng.randint(lo, hi))
            if ret <= DATA_END:
                queue.append((cid, ret, cohort, seq + 1))
        spells.append((cid, cohort, seq, start, n, expire, ret))
    return spells


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def generate(out_dir=OUT_DIR, seed=SEED):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    spells = simulate(seed)
    with tempfile.TemporaryDirectory() as tmp:
        spells_csv = Path(tmp) / "spells.csv"
        with open(spells_csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["customer_id", "cohort", "spell_seq", "start_date", "n_invoices",
                        "last_expire", "return_date"])
            for cid, cohort, seq, start, n, expire, ret in spells:
                w.writerow([cid, cohort, seq, start, n, expire, ret or ""])
        spells_hash = sha256(spells_csv)

        con = duckdb.connect()
        con.sql(f"""
        create table spells as
        select * from read_csv('{spells_csv}', header = true, columns = {{
            'customer_id': 'INTEGER', 'cohort': 'VARCHAR', 'spell_seq': 'INTEGER',
            'start_date': 'DATE', 'n_invoices': 'INTEGER', 'last_expire': 'DATE',
            'return_date': 'DATE'}})
        """)
    # Facturen: start + k maanden (k = 0 .. n-1); vervaldatum = start + k+1 maanden.
    con.sql(f"""
    create table inv as
    select customer_id,
           (start_date + to_months(k))::date      as invoice_date,
           (start_date + to_months(k + 1))::date  as expire_date,
           {PRICE_EUR}::decimal(5, 2)             as amount_eur
    from spells, range(n_invoices) r(k)
    where (start_date + to_months(k))::date <= date '{DATA_END}'
    """)
    full = out_dir / "beanrise_invoices_full.parquet"
    part = out_dir / "beanrise_invoices.parquet"
    truth = out_dir / "beanrise_truth.parquet"
    con.sql(f"copy (select * from inv order by customer_id, invoice_date) to '{full}' (format parquet)")
    con.sql(f"""copy (select * from inv where invoice_date >= date '{BUFFER_START}'
                     order by customer_id, invoice_date) to '{part}' (format parquet)""")
    con.sql(f"copy (select * from spells order by customer_id, spell_seq) to '{truth}' (format parquet)")

    rows_full = con.sql("select count(*) from inv").fetchall()[0][0]
    rows, customers = con.sql(f"""select count(*), count(distinct customer_id) from inv
                                  where invoice_date >= date '{BUFFER_START}'""").fetchall()[0]
    manifest = {
        "company": "Beanrise Coffee",
        "generatorVersion": GENERATOR_VERSION,
        "seed": seed,
        "parameters": {
            "priceEur": float(PRICE_EUR), "simStart": str(SIM_START),
            "bufferStart": str(BUFFER_START), "dataEnd": str(DATA_END),
            "openingCustomers": OPENING_CUSTOMERS, "baseInflowPerQuarter": BASE_INFLOW_Q,
            "campaignExtra": {f"Q{q} {y}": n for (y, q), n in CAMPAIGN_EXTRA.items()},
            "baseChurnPerQuarter": BASE_CHURN_Q, "campaignChurnPerQuarter": CAMPAIGN_CHURN_Q,
            "returnProbability": RETURN_P, "returnGapShortShare": RETURN_GAP_SHORT,
            "gapShortDays": GAP_SHORT_DAYS, "gapLongDays": GAP_LONG_DAYS,
        },
        "rows": rows, "rowsFull": rows_full, "customers": customers, "spells": len(spells),
        "sha256": {"spells": spells_hash, "invoices": sha256(part),
                   "invoicesFull": sha256(full), "truth": sha256(truth)},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    m = generate()
    print(f"Geschreven: {OUT_DIR.relative_to(ROOT)}/")
    print(f"  facturen vanaf {BUFFER_START}: {m['rows']:,} ({m['customers']:,} klanten)")
    print(f"  facturen vanaf {SIM_START} (controle): {m['rowsFull']:,}")
    print(f"  abonnementsperiodes: {m['spells']:,}")
    print(f"  sha256 facturen: {m['sha256']['invoices']}")
