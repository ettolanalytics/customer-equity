"""Controle: haalt de Beanrise-data, berekend volgens CLAUDE.md, de doelen?

Leest data/synthetic/ (generate_beanrise.py) en rekent met build_quarters.build.
Toetsen:
  1. reproduceerbaar: opnieuw genereren met dezelfde seed geeft dezelfde bestanden
  2. buffer: cijfers uit de facturen vanaf BUFFER_START zijn gelijk aan die uit de
     volledige historie (vanaf de opwarmstart), voor elk kwartaal in de JSON
  3. basischurn, instroom, golf, churn 2022, CLV, reacquisitie
  4. aantal rijen en geschatte omvang in Postgres
Stopt met exitcode 1 als een toets faalt.

Draaien:  .venv/bin/python scripts/check_beanrise.py
"""

import json
import math
import sys
import tempfile
from datetime import date
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_quarters as bq  # noqa: E402
import generate_beanrise as gen  # noqa: E402

DIR = gen.OUT_DIR
PART = DIR / "beanrise_invoices.parquet"
FULL = DIR / "beanrise_invoices_full.parquet"
TRUTH = DIR / "beanrise_truth.parquet"

results = []  # (groep, toets, waarde, norm, ok)  ok: True/False/None (alleen info)


def check(group, name, value, norm, ok):
    results.append((group, name, value, norm, ok))


def pct(x):
    return f"{x:.2%}"


manifest = json.loads((DIR / "manifest.json").read_text())
con = duckdb.connect()

# --- 1. Reproduceerbaar ---------------------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    again = gen.generate(tmp, manifest["seed"])
same = again["sha256"] == manifest["sha256"]
check("reproduceerbaar", "zelfde seed, zelfde SHA-256 (4 bestanden)",
      "gelijk" if same else "ANDERS", "gelijk", same)

# Python-maandrekening in de generator = DuckDB-maandrekening in de facturen.
n_bad = con.sql(f"""select count(*) from '{TRUTH}'
                    where (start_date + to_months(n_invoices))::date <> last_expire""").fetchall()[0][0]
check("reproduceerbaar", "vervaldatum generator = vervaldatum facturen", f"{n_bad} afwijkend", "0", n_bad == 0)

# --- 2. Buffer ----------------------------------------------------------------------
res = bq.build(PART)
out = res["out"]
full = bq.build(FULL)["out"]


def same(x, y):
    """Aantallen en teksten exact gelijk; bedragen tot op 1e-9 relatief (de
    volgorde van optellen in DuckDB verschilt in de 12e decimaal)."""
    if isinstance(x, dict) and isinstance(y, dict):
        return x.keys() == y.keys() and all(same(x[k], y[k]) for k in x)
    if isinstance(x, float) or isinstance(y, float):
        return isinstance(x, (int, float)) and isinstance(y, (int, float)) and \
            math.isclose(x, y, rel_tol=1e-9, abs_tol=1e-6)
    return x == y


def diff_quarters(a, b):
    return [x["label"] for x, y in zip(a, b) if not same(x, y)]


d = diff_quarters(out, full)
check("buffer", f"facturen vanaf {gen.BUFFER_START} = volledige historie ({len(out)} kwartalen)",
      "gelijk" if not d else f"anders in {', '.join(d)}", "gelijk", not d)

# Ter vergelijking: kortere buffers.
for start in (date(2019, 1, 1), date(2020, 1, 1)):
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "inv.parquet"
        con.sql(f"copy (select * from '{FULL}' where invoice_date >= date '{start}') to '{p}' (format parquet)")
        try:
            alt = bq.build(p)["out"]
            d = diff_quarters(alt, full)
            value = "gelijk" if not d else f"anders in {len(d)} kwartalen ({d[0]} t/m {d[-1]})"
        except (SystemExit, Exception) as e:
            value = f"rekenen lukt niet ({type(e).__name__}: geen klanten in 2019)"
    check("buffer", f"ter vergelijking: buffer vanaf {start}", value, "", None)

# --- 3. Doelen ---------------------------------------------------------------------
q = {r["label"]: r for r in out}
labels = [r["label"] for r in out]


def between(a, b):
    return [q[x] for x in labels[labels.index(a):labels.index(b) + 1]]


# Basischurn: rustige kwartalen vóór de campagne en vanaf 2024.
quiet = between("Q1 2020", "Q1 2021") + between("Q1 2024", "Q3 2026")
rates = [r["churnRate"] for r in quiet]
base_churn = sum(rates) / len(rates)
check("basischurn", "gemiddeld churn% rustige kwartalen (Q1 2020-Q1 2021, Q1 2024-Q3 2026)",
      pct(base_churn), "7,5-8,5%", 0.075 <= base_churn <= 0.085)
check("basischurn", "laagste en hoogste kwartaal", f"{pct(min(rates))} / {pct(max(rates))}",
      "elk 7-9%", min(rates) >= 0.07 and max(rates) <= 0.09)

# Instroom: aanmeldingen volgens de generator en nieuwe klanten volgens het dashboard.
signups = {f"Q{qq} {y}": (b, c) for y, qq, b, c in con.sql(f"""
    select year(start_date), quarter(start_date),
           count(*) filter (where cohort <> 'campaign'), count(*) filter (where cohort = 'campaign')
    from '{TRUTH}' where spell_seq = 1 and start_date >= date '2019-01-01' group by all
""").fetchall()}
base_signups = [signups[x][0] for x in labels]
mean_base = sum(base_signups) / len(base_signups)
check("instroom", "aanmeldingen basis per kwartaal (gemiddeld, generator)", f"{mean_base:,.0f}",
      "1.360 ±2%", abs(mean_base / gen.BASE_INFLOW_Q - 1) <= 0.02)
for lbl, extra in (("Q2 2021", 1800), ("Q3 2021", 3600), ("Q4 2021", 1800)):
    b, c = signups[lbl]
    target = gen.BASE_INFLOW_Q + extra
    check("instroom", f"aanmeldingen {lbl} (basis + campagne, generator)", f"{b:,} + {c:,} = {b + c:,}",
          f"{target:,} ±5%", abs((b + c) / target - 1) <= 0.05)
ratios = [q[x]["newCustomers"] / sum(signups[x]) for x in labels]
check("instroom", "nieuwe klanten dashboard ÷ aanmeldingen generator (laagste kwartaal)",
      pct(min(ratios)), "≥ 95% (verschil: kwam en ging binnen het kwartaal)", min(ratios) >= 0.95)

# Golf.
start = q["Q4 2020"]["activeEnd"]
wave = between("Q1 2021", "Q4 2022")
peak = max(wave, key=lambda r: r["activeEnd"])
check("golf", "piek actieve klanten", f"{peak['label']}: {peak['activeEnd']:,} "
      f"({peak['activeEnd'] / start - 1:+.1%} vs begin 2021: {start:,})",
      "Q4 2021 of Q1 2022, ≥ +20%",
      peak["label"] in ("Q4 2021", "Q1 2022") and peak["activeEnd"] / start - 1 >= 0.20)
end22 = q["Q4 2022"]["activeEnd"]
check("golf", "daling tot eind 2022", f"{end22:,} ({end22 / peak['activeEnd'] - 1:+.1%} vs piek, "
      f"{end22 / start - 1:+.1%} vs begin 2021)", "≤ -5% vs piek", end22 / peak["activeEnd"] - 1 <= -0.05)
# Vanaf 2024: geleidelijk terug richting het evenwicht (~20.000), zonder sprongen.
later = between("Q4 2023", "Q3 2026")
steps = [b["activeEnd"] / a["activeEnd"] - 1 for a, b in zip(later, later[1:])]
big = max(steps, key=abs)
check("golf", "vanaf 2024: grootste verandering t.o.v. vorig kwartaal", f"{big:+.2%}", "elk kwartaal ≤ 2%",
      max(abs(s) for s in steps) <= 0.02)
first, last = later[0]["activeEnd"], later[-1]["activeEnd"]
EQUILIBRIUM = 20_000
check("golf", "richting evenwicht (Q4 2023 → Q3 2026)", f"{first:,} → {last:,} (evenwicht ~{EQUILIBRIUM:,})",
      "dichter bij het evenwicht", abs(last - EQUILIBRIUM) < abs(first - EQUILIBRIUM))

# Churn per kwartaal 2021 en 2022 (waar zit de kater).
for year in ("2021", "2022"):
    cs = between(f"Q1 {year}", f"Q4 {year}")
    check("churn 2022", f"churn% per kwartaal {year} (Q1 / Q2 / Q3 / Q4)",
          " / ".join(pct(r["churnRate"]) for r in cs), "", None)

# Churn 2022.
c22 = [r["churnRate"] for r in between("Q1 2022", "Q4 2022")]
mean22 = sum(c22) / 4
check("churn 2022", "gemiddeld churn% 2022 (Q1-Q4)",
      f"{pct(mean22)} ({' / '.join(f'{x:.1%}' for x in c22)})",
      "≥ basis + 1 pp", mean22 - base_churn >= 0.01)
peak_churn = max(between("Q1 2021", "Q4 2023"), key=lambda r: r["churnRate"])
check("churn 2022", "hoogste churn% 2021-2023", f"{peak_churn['label']}: {pct(peak_churn['churnRate'])}", "", None)

# CLV.
pre = q["Q1 2021"]["avgClv"]
span = between("Q4 2021", "Q4 2023")
low = min(span, key=lambda r: r["avgClv"])
check("CLV", "dieptepunt CLV", f"{low['label']}: €{low['avgClv']:.2f} ({low['avgClv'] / pre - 1:+.1%} vs Q1 2021 "
      f"€{pre:.2f})", "in Q1 2022-Q2 2023, ≤ -5%",
      low["label"] in labels[labels.index("Q1 2022"):labels.index("Q2 2023") + 1] and low["avgClv"] / pre - 1 <= -0.05)
rec = q["Q4 2023"]["avgClv"]
check("CLV", "herstel eind 2023", f"€{rec:.2f} ({rec / pre - 1:+.1%} vs Q1 2021)", "≥ -2%", rec / pre - 1 >= -0.02)

# Reacquisitie volgens de generator: vertrek met een volledig te volgen jaar erna.
for cohort, target, tol in (("campaign", 0.05, 0.01), ("other", 0.15, 0.015)):
    n, ret, short = con.sql(f"""
        select count(*), count(return_date),
               count(*) filter (where return_date - last_expire <= {gen.GAP_SHORT_DAYS[1]})
        from '{TRUTH}'
        where last_expire between date '2019-01-01' and date '2025-10-31'
          and {"cohort = 'campaign'" if cohort == "campaign" else "cohort <> 'campaign'"}
    """).fetchall()[0]
    share = ret / n
    name = "campagneklanten" if cohort == "campaign" else "overige klanten"
    check("reacquisitie", f"terug binnen 12 maanden, {name} (generator, {n:,} vertrekkers)",
          pct(share), f"{target:.0%} ±{tol * 100:.1f} pp", abs(share - target) <= tol)
    if cohort == "other":
        check("reacquisitie", "  waarvan binnen 2-6 maanden", pct(short / ret), "80% ±3 pp",
              abs(short / ret - 0.80) <= 0.03)
# Zoals het dashboard het meet: reacquired ÷ churn in de rustige kwartalen.
meas = sum(r["reacquiredCustomers"] for r in quiet) / sum(r["churn"] for r in quiet)
check("reacquisitie", "dashboard: reacquired ÷ churn, rustige kwartalen", pct(meas),
      "iets onder 15% (heen en terug in één kwartaal telt als stay)", None)

# --- 4. Omvang ---------------------------------------------------------------------
rows = manifest["rows"]
# Postgres-schatting voor ce_private.invoices (int4, date, date, numeric(5,2)):
# heap-tuple 24 B kop + 19 B data -> 48 B, + 4 B regelpointer; 157 rijen per 8 kB-pagina.
# PK-index (int4, date): 16 B + 4 B pointer, bladpagina's 90% gevuld.
heap = math.ceil(rows / ((8192 - 24) // 52)) * 8192
index = math.ceil(rows / int((8192 - 24 - 16) * 0.9 // 20)) * 8192
total_mb = (heap + index) / 1e6
check("omvang", "rijen ce_private.invoices", f"{rows:,} ({manifest['customers']:,} klanten)", "", None)
check("omvang", "geschat in Postgres: tabel + PK-index", f"{heap / 1e6:,.0f} + {index / 1e6:,.0f} = "
      f"{total_mb:,.0f} MB", "< 500 MB", total_mb < 500)
check("omvang", "Parquet-bestand", f"{PART.stat().st_size / 1e6:.1f} MB", "", None)

# --- Uitvoer -----------------------------------------------------------------------
w = max(len(r[1]) for r in results)
group = None
for g, name, value, norm, ok in results:
    if g != group:
        print(f"\n{g.upper()}")
        group = g
    mark = "info" if ok is None else ("OK  " if ok else "FOUT")
    print(f"  {mark}  {name:<{w}}  {value}" + (f"   [norm: {norm}]" if norm else ""))

failed = [r for r in results if r[4] is False]
print(f"\n{len(results) - len(failed)} van {len(results)} toetsen in orde of ter info, {len(failed)} fout.")
sys.exit(1 if failed else 0)
