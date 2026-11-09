"""Rekenscript: kwartaalcijfers customer equity uit de Beanrise-facturen.

Leest data/synthetic/beanrise_invoices.parquet (scripts/generate_beanrise.py) en
schrijft src/data/quarters.json. Definities en aannames: zie CLAUDE.md.

Draaien:  .venv/bin/python scripts/build_quarters.py [--input X.parquet] [--out Y.json]
"""

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "data" / "synthetic" / "beanrise_invoices.parquet"
DEFAULT_OUT = ROOT / "src" / "data" / "quarters.json"

# Vaste aannames
COST_EUR = 14.00              # kostprijs per factuur (pak bonen + bezorging)
DISCOUNT_YEAR = 0.10          # discontovoet per jaar
HORIZON = 20                  # max. kwartalen (5 jaar)
GRACE_DAYS = 30               # respijt voor churn

DISCOUNT_Q = (1 + DISCOUNT_YEAR) ** 0.25 - 1

# Rekenkwartalen Q1 2019 t/m Q3 2026. Q1-Q4 2019 zijn alleen nodig als historie
# (CLV-retentie en verwachte churn van 2020). In de JSON: Q1 2020 t/m Q3 2026,
# zodat Q1 2021 een volledig kwartaal van een jaar eerder heeft.
QUARTERS = [(y, q) for y in range(2019, 2027) for q in (1, 2, 3, 4) if (y, q) <= (2026, 3)]
DASHBOARD = [k for k in QUARTERS if k >= (2020, 1)]


def q_start(y, q):
    return date(y, 3 * q - 2, 1)


def q_end(y, q):
    return date(y, 12, 31) if q == 4 else date(y, 3 * q + 1, 1) - timedelta(days=1)


def q_begin_peil(y, q):
    return q_end(y, q - 1) if q > 1 else date(y - 1, 12, 31)


def label(y, q):
    return f"Q{q} {y}"


def clv(margin_q, retention):
    """Som over k = 1..20 van marge x (retentie / (1 + kwartaaldisconto))^k."""
    factor = retention / (1 + DISCOUNT_Q)
    return margin_q * sum(factor**k for k in range(1, HORIZON + 1))


# Een klant valt per kwartaal in precies één groep (zie flow_sql).
GROUPS = ["stay", "new", "returning", "churned", "inout", "unexplained"]


def flow_sql(y, q, select):
    """Klantenstroom in een kwartaal. Elke klant die aan begin of eind actief is:
      stay       actief begin en eind
      new        niet actief begin, wel eind, eerste factuur ooit in dit kwartaal
      returning  niet actief begin, wel eind, eerder al klant
      churned    actief begin, niet eind: de 30 dagen na de vervaldatum liepen af
                 in dit kwartaal zonder nieuwe factuur
      unexplained  actief begin, niet eind, maar de 30 dagen liepen niet in dit
                 kwartaal af (mag niet voorkomen)
    Daarnaast, buiten de som: inout = niet actief begin en niet eind, wel een
    factuur in het kwartaal (kwam en ging binnen het kwartaal)."""
    d0, qs, d1 = q_begin_peil(y, q), q_start(y, q), q_end(y, q)
    return f"""
with b as (select customer_id from gov where d = date '{d0}' and active),
     e as (select customer_id from gov where d = date '{d1}' and active),
     g1 as (select * from gov where d = date '{d1}'),
     txq as (select distinct customer_id from tx
             where tdate between date '{qs}' and date '{d1}'),
     pop as (select customer_id from b union select customer_id from e
             union select customer_id from txq),
     c as (
        select pop.customer_id,
          case
            when b.customer_id is not null and e.customer_id is not null then 'stay'
            when e.customer_id is not null then
              case when f.first >= date '{qs}' then 'new' else 'returning' end
            when b.customer_id is not null then
              case
                when g1.lapse + interval {GRACE_DAYS} day
                     between date '{qs}' and date '{d1}' then 'churned'
                else 'unexplained'
              end
            else 'inout'
          end as grp
        from pop
        left join b using (customer_id)
        left join e using (customer_id)
        left join g1 using (customer_id)
        left join firsts f using (customer_id)
     )
{select}
"""


def waterfall(begin, periods, expected):
    """Waterfall tegen de CLV aan het begin (V0); CLV-verandering gesplitst in
    marge-effect (Vm - V0) x N1 en retentie-effect (V1 - Vm) x N1.
    begin = kwartaal aan het begin; periods = kwartalen in de periode (laatste = eind)."""
    end = periods[-1]
    v0, v1 = begin["avgClv"], end["avgClv"]
    n0, n1 = begin["activeEnd"], end["activeEnd"]
    assert n0 == periods[0]["activeBegin"]
    vm = clv(end["marginPerCustomer"], begin["retention"])
    new = sum(x["newCustomers"] for x in periods)
    reacq = sum(x["reacquiredCustomers"] for x in periods)
    churn = sum(x["churn"] for x in periods)
    parts = {"newCustomers": new * v0, "reacquiredCustomers": reacq * v0}
    counts = {"newCustomers": new, "reacquiredCustomers": reacq, "churn": churn}
    if expected:
        exp = end["expectedChurn"]
        parts["expectedChurn"] = -exp * v0
        parts["churnVsExpected"] = (exp - churn) * v0
        counts["expectedChurn"] = round(exp, 1)
        counts["churnVsExpected"] = round(exp - churn, 1)
    else:
        parts["churn"] = -churn * v0
    parts["marginEffect"] = (vm - v0) * n1
    parts["retentionEffect"] = (v1 - vm) * n1
    delta = end["customerEquity"] - begin["customerEquity"]
    return {
        "fromLabel": begin["label"],
        "toLabel": end["label"],
        "equityBegin": round(begin["customerEquity"], 2),
        "equityEnd": round(end["customerEquity"], 2),
        "equityChange": round(delta, 2),
        "equityChangePct": round(delta / begin["customerEquity"], 6),
        "parts": {k: round(v, 2) for k, v in parts.items()},
        "counts": counts,
        "customersBegin": n0,
        "customersEnd": n1,
        "avgClvBegin": round(v0, 4),
        "avgClvEnd": round(v1, 4),
        "marginBegin": round(begin["marginPerCustomer"], 4),
        "marginEnd": round(end["marginPerCustomer"], 4),
        "retentionBegin": round(begin["retention"], 6),
        "retentionEnd": round(end["retention"], 6),
        "_sum": sum(parts.values()),
        "_deviation": delta - sum(parts.values()),
    }


def change(cur, base, key="customerEquity"):
    """Verschil met een eerder kwartaal: absoluut en relatief."""
    if base is None:
        return None
    d = cur[key] - base[key]
    return {"abs": round(d, 4), "pct": round(d / base[key], 6)}


def rate_change(cur, base, key="churnRate"):
    """Verschil in een fractie (x 100 = procentpunten)."""
    return None if base is None else round(cur[key] - base[key], 8)


# Velden met een vergelijking met vorig kwartaal en een jaar eerder (tegels).
COMPARE = {
    "active": "activeEnd",
    "new": "newCustomers",
    "reacquired": "reacquiredCustomers",
    "churn": "churn",
    "margin": "marginPerCustomer",
}


def public(w):
    return None if w is None else {k: v for k, v in w.items() if not k.startswith("_")}


def build(input_path):
    """Rekent alle kwartaalcijfers uit. Stopt (sys.exit) als een controle faalt."""
    con = duckdb.connect()
    con.sql(f"""
    create table tx as
    select customer_id, invoice_date as tdate, expire_date as edate, amount_eur::double as amount
    from '{input_path}'
    """)
    n_rows, n_customers, first_tx, last_tx = con.sql(
        "select count(*), count(distinct customer_id), min(tdate), max(tdate) from tx"
    ).fetchall()[0]

    # --- Tijdlijn per klant ---------------------------------------------------
    # Elke factuur zet het einde van het abonnement op haar vervaldatum en geldt
    # tot de volgende factuur.
    con.sql("""
    create table tl as
    select *, lead(tdate) over w as next_tdate, edate as lapse
    from tx
    window w as (partition by customer_id order by tdate)
    """)

    # --- Peildata ---------------------------------------------------------------
    peil = [q_begin_peil(*QUARTERS[0])] + [q_end(y, q) for y, q in QUARTERS]
    con.sql("create table peil (d date)")
    con.executemany("insert into peil values (?)", [[d] for d in peil])

    # Geldende factuur per klant op peildatum d: tdate <= d < next_tdate.
    # Actief op d: vervaldatum + 30 dagen ligt ná d. Een nieuwe factuur binnen de
    # 30 dagen wordt zelf de geldende, dus wie op tijd verlengt blijft actief.
    con.sql(f"""
    create table gov as
    select p.d, t.customer_id, t.edate, t.lapse, t.next_tdate,
           t.lapse + interval {GRACE_DAYS} day > p.d as active
    from peil p
    join tl t on t.tdate <= p.d and (t.next_tdate is null or t.next_tdate > p.d)
    """)
    con.sql("create table firsts as select customer_id, min(tdate) first from tx group by customer_id")

    # --- Klantenstroom per kwartaal --------------------------------------------
    flows = {}
    for y, q in QUARTERS:
        f = {g: 0 for g in GROUPS}
        for grp, n in con.sql(flow_sql(y, q, "select grp, count(*) from c group by grp")).fetchall():
            f[grp] = n
        f["begin"] = f["stay"] + f["churned"] + f["unexplained"]
        f["end"] = f["stay"] + f["new"] + f["returning"]
        flows[(y, q)] = f

    # Controle: begin + nieuw + terug - churn = eind, rest 0. Begin en eind komen
    # rechtstreeks uit de peildata, niet uit de groepen.
    active = dict(con.sql("select d, count(*) from gov where active group by d").fetchall())
    fail = False
    for y, q in QUARTERS:
        f = flows[(y, q)]
        begin, end = active.get(q_begin_peil(y, q), 0), active.get(q_end(y, q), 0)
        f["rest"] = begin + f["new"] + f["returning"] - f["churned"] - end
        if f["rest"] or f["unexplained"] or f["begin"] != begin or f["end"] != end:
            fail = True
            print(f"{label(y, q)}: rest {f['rest']:+,}, onverklaard {f['unexplained']:,}, "
                  f"begin {begin:,} vs groepen {f['begin']:,}, eind {end:,} vs groepen {f['end']:,}")
    if fail:
        sys.exit("Klantenstroom sluit niet. Niets weggeschreven.")

    # --- Omzet en marge ---------------------------------------------------------
    money = {(y, q): (rev, marg) for y, q, rev, marg in con.sql(f"""
    select year(tdate) y, quarter(tdate) q, sum(amount), sum(amount - {COST_EUR})
    from tx group by all
    """).fetchall()}

    # --- Kwartaalcijfers --------------------------------------------------------
    rows = {}
    for y, q in QUARTERS:
        f = flows[(y, q)]
        begin, end = f["begin"], f["end"]
        rev_eur, margin_eur = money.get((y, q), (0, 0))
        rows[(y, q)] = dict(
            label=label(y, q),
            activeBegin=begin,
            activeEnd=end,
            newCustomers=f["new"],
            reacquiredCustomers=f["returning"],
            churn=f["churned"],
            churnRate=f["churned"] / begin if begin else None,
            revenueEur=rev_eur,
            marginPerCustomer=margin_eur / ((begin + end) / 2),
        )

    for i, (y, q) in enumerate(QUARTERS):
        if (y, q) not in DASHBOARD:
            continue
        r = rows[(y, q)]
        # Verwachte churn: churnpercentage zelfde kwartaal vorig jaar.
        prev = rows.get((y - 1, q))
        prev_rate = prev["churnRate"] if prev else None
        r["expectedChurn"] = None if prev_rate is None else prev_rate * r["activeBegin"]
        r["expectedChurnRate"] = prev_rate
        # CLV-retentie: 1 - gemiddeld churnpercentage van de vorige 4 kwartalen
        # (of van de kwartalen die er zijn; zijn er geen, dan dit kwartaal).
        prior = [rows[k]["churnRate"] for k in QUARTERS[max(0, i - 4):i]
                 if rows[k]["churnRate"] is not None]
        if prior:
            retention = 1 - sum(prior) / len(prior)
        else:
            retention = 1 - r["churnRate"]
        r["retentionQuarters"] = len(prior)
        r["retention"] = retention
        r["avgClv"] = clv(r["marginPerCustomer"], retention)
        r["customerEquity"] = r["activeEnd"] * r["avgClv"]

    # --- Waterfalls: jaar en kwartaal --------------------------------------------
    for i, (y, q) in enumerate(DASHBOARD):
        r = rows[(y, q)]
        assert r["newCustomers"] + r["reacquiredCustomers"] == r["activeEnd"] - r["activeBegin"] + r["churn"]
        r["waterfall"] = None
        r["yearWaterfall"] = None
        if i == 0 or r["expectedChurn"] is None:
            continue
        r["waterfall"] = waterfall(rows[DASHBOARD[i - 1]], [r], expected=True)
        if (y - 1, q) in DASHBOARD:
            r["yearWaterfall"] = waterfall(rows[(y - 1, q)], [rows[k] for k in DASHBOARD[i - 3:i + 1]],
                                           expected=False)

    # --- Vergelijkingen en antwoordzin (voor het scherm; de app rekent niets) ---
    for i, (y, q) in enumerate(DASHBOARD):
        r = rows[(y, q)]
        r["acquiredCustomers"] = r["newCustomers"] + r["reacquiredCustomers"]
        prev_q = rows[DASHBOARD[i - 1]] if i > 0 else None
        year_ago = rows[(y - 1, q)] if (y - 1, q) in DASHBOARD else None
        r["equityVsPrevQuarter"] = change(r, prev_q)
        r["equityVsYearAgo"] = change(r, year_ago)
        r["acquiredVsPrevQuarter"] = change(r, prev_q, "acquiredCustomers")
        r["acquiredVsYearAgo"] = change(r, year_ago, "acquiredCustomers")
        r["churnRateVsPrevQuarter"] = rate_change(r, prev_q)
        r["churnRateVsYearAgo"] = rate_change(r, year_ago)
        r["avgClvVsPrevQuarter"] = change(r, prev_q, "avgClv")
        r["avgClvVsYearAgo"] = change(r, year_ago, "avgClv")
        r["churnRateVsExpected"] = (None if r["expectedChurnRate"] is None
                                    else r["churnRate"] - r["expectedChurnRate"])
        for name, key in COMPARE.items():
            r[f"{name}VsPrevQuarter"] = change(r, prev_q, key)
            r[f"{name}VsYearAgo"] = change(r, year_ago, key)
        r["retentionVsPrevQuarter"] = rate_change(r, prev_q, "retention")
        r["retentionVsYearAgo"] = rate_change(r, year_ago, "retention")
        # Werkelijke min verwachte churn (aantal), voor de hover van de Churn-tegel.
        r["churnVsExpectedCount"] = (None if r["expectedChurn"] is None
                                     else round(r["churn"] - r["expectedChurn"], 1))
        # Rekenvoorbeeld "How we calculate": verwachte duur als klant (max. 20
        # kwartalen, afgerond op 0,1) en marge x die duur. Met disconto: avgClv.
        ret = r["retention"]
        quarters_as_customer = round(ret * (1 - ret**HORIZON) / (1 - ret), 1)
        r["clvExample"] = {
            "churnRate": round(1 - ret, 6),
            "expectedQuarters": quarters_as_customer,
            "undiscountedValue": round(r["marginPerCustomer"] * quarters_as_customer, 4),
        }
        r["yearSummary"] = None
        if year_ago is not None:
            last4 = [rows[k] for k in DASHBOARD[i - 3:i + 1]]
            with_exp = [x for x in last4 if x["expectedChurn"] is not None]
            r["yearSummary"] = {
                "acquiredCustomers": sum(x["newCustomers"] + x["reacquiredCustomers"] for x in last4),
                "newCustomers": sum(x["newCustomers"] for x in last4),
                "reacquiredCustomers": sum(x["reacquiredCustomers"] for x in last4),
                "avgClvChange": round(r["avgClv"] - year_ago["avgClv"], 4),
                "churnQuarters": len(with_exp),
                "churnVsExpected": None if not with_exp else round(
                    sum(x["expectedChurn"] - x["churn"] for x in with_exp), 1),
            }

    # Controle: elke waterfall sluit exact (afwijking < 1 euro).
    all_wf = [(rows[k]["label"], kind, rows[k][field]) for k in DASHBOARD
              for kind, field in (("kwartaal", "waterfall"), ("jaar", "yearWaterfall"))
              if rows[k][field] is not None]
    bad = [(lbl, kind, w["_deviation"]) for lbl, kind, w in all_wf if abs(w["_deviation"]) >= 1]
    if bad:
        for lbl, kind, dev in bad:
            print(f"{lbl} ({kind}): afwijking {dev:+,.2f} EUR")
        sys.exit("Waterfall sluit niet. Niets weggeschreven.")

    # --- Uitvoer (zelfde vorm als voorheen) --------------------------------------
    out = []
    for y, q in DASHBOARD:
        r = rows[(y, q)]
        out.append({
            "label": r["label"],
            "activeBegin": r["activeBegin"],
            "activeEnd": r["activeEnd"],
            "newCustomers": r["newCustomers"],
            "reacquiredCustomers": r["reacquiredCustomers"],
            "acquiredCustomers": r["newCustomers"] + r["reacquiredCustomers"],
            "churn": r["churn"],
            "expectedChurn": None if r["expectedChurn"] is None else round(r["expectedChurn"], 1),
            "churnRate": round(r["churnRate"], 6),
            "expectedChurnRate": None if r["expectedChurnRate"] is None else round(r["expectedChurnRate"], 6),
            "churnRateVsExpected": None if r["churnRateVsExpected"] is None else round(r["churnRateVsExpected"], 6),
            "revenueEur": round(r["revenueEur"], 2),
            "marginPerCustomer": round(r["marginPerCustomer"], 12),
            "retention": round(r["retention"], 12),
            "retentionQuarters": r["retentionQuarters"],
            "avgClv": round(r["avgClv"], 12),
            "customerEquity": round(r["customerEquity"], 2),
            "equityVsPrevQuarter": r["equityVsPrevQuarter"],
            "equityVsYearAgo": r["equityVsYearAgo"],
            "acquiredVsPrevQuarter": r["acquiredVsPrevQuarter"],
            "acquiredVsYearAgo": r["acquiredVsYearAgo"],
            "churnRateVsPrevQuarter": r["churnRateVsPrevQuarter"],
            "churnRateVsYearAgo": r["churnRateVsYearAgo"],
            "avgClvVsPrevQuarter": r["avgClvVsPrevQuarter"],
            "avgClvVsYearAgo": r["avgClvVsYearAgo"],
            **{f"{name}Vs{when}": r[f"{name}Vs{when}"]
               for name in [*COMPARE, "retention"] for when in ("PrevQuarter", "YearAgo")},
            "churnVsExpectedCount": r["churnVsExpectedCount"],
            "yearSummary": r["yearSummary"],
            "clvExample": r["clvExample"],
            "waterfall": public(r["waterfall"]),
            "yearWaterfall": public(r["yearWaterfall"]),
        })

    # Controle op de weggeschreven waarden (wat de app leest), per kwartaal:
    # (a) customer equity = active customers x average CLV
    # (b) active customers = vorig kwartaal + new + reacquired - churn
    # (c) average CLV opnieuw berekend uit margin per customer en retention
    problems = []
    max_dev = {"a": 0.0, "b": 0, "c": 0.0}
    for i, o in enumerate(out):
        dev_a = o["activeEnd"] * o["avgClv"] - o["customerEquity"]
        prev_end = out[i - 1]["activeEnd"] if i > 0 else o["activeBegin"]
        dev_b = (prev_end + o["newCustomers"] + o["reacquiredCustomers"] - o["churn"]) - o["activeEnd"]
        dev_b += abs(o["activeBegin"] - prev_end)
        dev_c = (clv(o["marginPerCustomer"], o["retention"]) - o["avgClv"]) * o["activeEnd"]
        max_dev["a"] = max(max_dev["a"], abs(dev_a))
        max_dev["b"] = max(max_dev["b"], abs(dev_b))
        max_dev["c"] = max(max_dev["c"], abs(dev_c))
        if abs(dev_a) > 1:
            problems.append(f"{o['label']}: CE - klanten x CLV = {dev_a:+,.2f} EUR")
        if dev_b != 0:
            problems.append(f"{o['label']}: klantenstroom wijkt {dev_b:+,} klanten af")
        if abs(dev_c) > 1:
            problems.append(f"{o['label']}: CLV uit marge en retentie wijkt {dev_c:+,.2f} EUR af (x klanten)")
    if problems:
        print("\n".join(problems))
        sys.exit("Controle op de drivers faalt. Niets weggeschreven.")

    return {
        "out": out, "flows": flows, "all_wf": all_wf, "max_dev": max_dev,
        "input": {"rows": n_rows, "customers": n_customers, "first": first_tx, "last": last_tx},
    }


def report(res, out_path):
    out, flows, inp = res["out"], res["flows"], res["input"]
    print(f"Invoer: {inp['rows']:,} facturen, {inp['customers']:,} klanten, "
          f"{inp['first']} t/m {inp['last']}")
    print(f"Geschreven: {out_path}  ({len(out)} kwartalen)")
    md = res["max_dev"]
    print("Controle drivers (grootste afwijking over alle kwartalen):")
    print(f"  (a) CE = klanten x CLV:                    {md['a']:.4f} EUR")
    print(f"  (b) klanten = vorig + new + reacq - churn: {md['b']} klanten")
    print(f"  (c) CLV uit marge en retentie (x klanten): {md['c']:.4f} EUR\n")

    print("Waterfalls (EUR, tegen begin-CLV): grootste afwijking "
          f"{max(abs(w['_deviation']) for _, _, w in res['all_wf']):.4f} over {len(res['all_wf'])} waterfalls\n")

    hdr = (f"{'kwartaal':<8} {'begin':>7} {'eind':>7} {'nieuw':>6} {'terug':>6} {'churn':>6} "
           f"{'churn%':>7} {'verw.':>7} {'marge/kl':>8} {'retentie':>8} {'CLV':>8} "
           f"{'cust. equity':>13} {'in&uit':>6}")
    print(hdr)
    print("-" * len(hdr))
    for (y, q), r in zip(DASHBOARD, out):
        ec = "-" if r["expectedChurn"] is None else f"{r['expectedChurn']:,.0f}"
        print(f"{r['label']:<8} {r['activeBegin']:>7,} {r['activeEnd']:>7,} "
              f"{r['newCustomers']:>6,} {r['reacquiredCustomers']:>6,} {r['churn']:>6,} "
              f"{r['churnRate']:>7.2%} {ec:>7} {r['marginPerCustomer']:>8.2f} "
              f"{r['retention']:>8.4f} {r['avgClv']:>8.2f} "
              f"{r['customerEquity']:>13,.0f} {flows[(y, q)]['inout']:>6,}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(DEFAULT_INPUT))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()
    res = build(args.input)
    Path(args.out).write_text(json.dumps(res["out"], indent=2) + "\n")
    report(res, args.out)
