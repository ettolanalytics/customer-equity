"""Vergelijkt de SQL-transformatie (Supabase) met de Python-referentie.

Leest uit Supabase (als ce_loader, CE_LOADER_DB_URL): mv_quarter_flows,
ce_public.quarters en ce_public.publication. Rekent met build_quarters.build() op
hetzelfde Parquet-bestand en vergelijkt:
  - klantenstroom per rekenkwartaal: exact
  - elk veld van elk kwartaal: aantallen en labels exact; bedragen exact, binnen
    1e-9 relatief (precisie), of binnen één eenheid in de laatste decimaal (afronding:
    Postgres rondt .5 van nul af, Python naar even)
  - aannames in publication tegen de constanten in de scripts

Draaien:  .venv/bin/python scripts/compare_sql_python.py [--dump bestand.json]
  --dump: vergelijk met een eerder opgeslagen dump in plaats van Supabase te lezen.
"""

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_quarters as bq  # noqa: E402
import generate_beanrise as gen  # noqa: E402

FLOW_FIELDS = ["stay", "new", "reacquired", "churned", "inout", "unexplained", "begin_groups", "end_groups"]


def read_supabase():
    import psycopg
    from env import connect
    with connect("CE_LOADER_DB_URL") as conn, conn.cursor() as cur:
        cur.execute(f"select label, {', '.join(FLOW_FIELDS)} from ce_private.mv_quarter_flows order by qs")
        flows = [dict(zip(["label", *FLOW_FIELDS], row)) for row in cur.fetchall()]
        cur.execute("select data from ce_public.quarters order by seq")
        quarters = [row[0] for row in cur.fetchall()]
        cur.execute("select to_jsonb(p) from ce_public.publication p")
        publication = cur.fetchone()[0]
    return {"flows": flows, "quarters": quarters, "publication": publication}


def decimals(x):
    s = repr(float(x))
    if "e" in s:
        return 99
    frac = s.split(".")[1].rstrip("0") if "." in s else ""
    return len(frac)


def compare_value(path, a, b, stats, fails):
    if isinstance(a, dict) or isinstance(b, dict):
        if not (isinstance(a, dict) and isinstance(b, dict)):
            fails.append(f"{path}: {a!r} vs {b!r}")
            return
        if a.keys() != b.keys():
            fails.append(f"{path}: sleutels {sorted(set(a) ^ set(b))}")
        for k in a.keys() & b.keys():
            compare_value(f"{path}.{k}", a[k], b[k], stats, fails)
        return
    if a is None or b is None or isinstance(a, str) or isinstance(b, str):
        if a == b:
            stats["exact"] += 1
        else:
            fails.append(f"{path}: {a!r} vs {b!r}")
        return
    if isinstance(a, bool) or isinstance(b, bool):
        fails.append(f"{path}: {a!r} vs {b!r}")
        return
    if a == b:
        stats["exact"] += 1
    elif isinstance(a, int) and isinstance(b, int):
        fails.append(f"{path}: {a} vs {b} (aantal)")
    elif math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9):
        stats["precisie"] += 1
    else:
        d = max(decimals(a), decimals(b))
        if d <= 8 and abs(a - b) <= 10 ** -d * 1.000001:
            stats["afronding"] += 1
            stats["afronding_voorbeelden"].append(f"{path}: SQL {a} / Python {b}")
        else:
            fails.append(f"{path}: SQL {a} / Python {b}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump")
    args = ap.parse_args()
    sql = json.loads(Path(args.dump).read_text()) if args.dump else read_supabase()
    ref = bq.build(gen.OUT_DIR / "beanrise_invoices.parquet")
    ok = True

    # 1. Klantenstroom per rekenkwartaal: exact
    py_flows = {bq.label(y, q): f for (y, q), f in ref["flows"].items()}
    flow_fails = []
    for row in sql["flows"]:
        f = py_flows.get(row["label"])
        if f is None:
            flow_fails.append(f"{row['label']}: ontbreekt in Python")
            continue
        py = {"stay": f["stay"], "new": f["new"], "reacquired": f["returning"], "churned": f["churned"],
              "inout": f["inout"], "unexplained": f["unexplained"], "begin_groups": f["begin"],
              "end_groups": f["end"]}
        for k in FLOW_FIELDS:
            if row[k] != py[k]:
                flow_fails.append(f"{row['label']}.{k}: SQL {row[k]} / Python {py[k]}")
    if len(sql["flows"]) != len(py_flows):
        flow_fails.append(f"aantal kwartalen: SQL {len(sql['flows'])} / Python {len(py_flows)}")
    n_flow = len(sql["flows"]) * len(FLOW_FIELDS)
    print(f"Klantenstroom: {len(sql['flows'])} rekenkwartalen × {len(FLOW_FIELDS)} groepen = {n_flow} getallen, "
          f"{'alle exact gelijk' if not flow_fails else f'{len(flow_fails)} afwijkend'}")
    for x in flow_fails[:20]:
        print("  FOUT", x)
    ok &= not flow_fails

    # 2. Kwartaalobjecten: elk veld
    stats = {"exact": 0, "precisie": 0, "afronding": 0, "afronding_voorbeelden": []}
    fails = []
    if [q["label"] for q in sql["quarters"]] != [q["label"] for q in ref["out"]]:
        fails.append("kwartaallabels of volgorde wijken af")
    for a, b in zip(sql["quarters"], ref["out"]):
        compare_value(a["label"], a, b, stats, fails)
    total = stats["exact"] + stats["precisie"] + stats["afronding"]
    print(f"\nKwartaalobjecten: {len(sql['quarters'])} kwartalen, {total + len(fails):,} velden")
    print(f"  exact gelijk                          {stats['exact']:>7,}")
    print(f"  binnen 1e-9 relatief (precisie)       {stats['precisie']:>7,}")
    print(f"  één eenheid in laatste decimaal       {stats['afronding']:>7,}")
    for x in stats["afronding_voorbeelden"][:10]:
        print(f"      {x}")
    print(f"  afwijkend                             {len(fails):>7,}")
    for x in fails[:20]:
        print("  FOUT", x)
    ok &= not fails

    # 3. Aannames
    pub = sql["publication"]
    expect = {
        "discount_rate_year": bq.DISCOUNT_YEAR, "horizon_quarters": bq.HORIZON, "grace_days": bq.GRACE_DAYS,
        "price_eur": float(gen.PRICE_EUR), "cost_per_invoice_eur": bq.COST_EUR,
        "margin_per_invoice_eur": round(float(gen.PRICE_EUR) - bq.COST_EUR, 2),
        "last_quarter": ref["out"][-1]["label"], "quarter_count": len(ref["out"]),
        "first_selectable": next(q["label"] for q in ref["out"] if q["waterfall"] and q["yearWaterfall"]
                                 and q["equityVsYearAgo"] and q["yearSummary"]),
        "generator_version": gen.GENERATOR_VERSION,
    }
    pub_fails = [f"{k}: SQL {pub.get(k)!r} / verwacht {v!r}" for k, v in expect.items()
                 if not (pub.get(k) == v or (isinstance(v, float) and math.isclose(float(pub.get(k)), v)))]
    print(f"\nPublicatie: {len(expect)} aannames en kenmerken, "
          f"{'alle gelijk' if not pub_fails else f'{len(pub_fails)} afwijkend'}")
    for x in pub_fails:
        print("  FOUT", x)
    ok &= not pub_fails

    print("\nSQL = Python: " + ("JA" if ok else "NEE"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
