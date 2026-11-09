"""Rekenscript: kwartaalcijfers customer equity uit de KKBox-data.

Leest data/raw/{transactions,transactions_v2,members_v3}.parquet en schrijft
src/data/quarters.json. Definities en aannames: zie CLAUDE.md.

Draaien:  .venv/bin/python scripts/build_quarters.py
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "data" / "quarters.json"

# Vaste aannames (CLAUDE.md)
MARGIN = 0.30                 # contributiemarge op actual_amount_paid
TWD_PER_EUR = 35.14           # gemiddelde jaarkoers 2015-2017
DISCOUNT_YEAR = 0.10          # discontovoet per jaar
HORIZON = 20                  # max. kwartalen (5 jaar)
GRACE_DAYS = 30               # respijt voor churn
SHORT_PLAN_DAYS = 30          # "abonnement van minder dan 30 dagen"

DISCOUNT_Q = (1 + DISCOUNT_YEAR) ** 0.25 - 1

# Q1 2015 t/m Q4 2016. Q1 2015 is nodig als "vorig jaar" voor Q1 2016 en als
# eerste kwartaal in het CLV-gemiddelde; het staat niet in het dashboard.
QUARTERS = [(y, q) for y in (2015, 2016) for q in (1, 2, 3, 4)]
DASHBOARD = QUARTERS[1:]  # Q2 2015 - Q4 2016


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


con = duckdb.connect()

# --- Opschonen -------------------------------------------------------------
# v1 en v2 samenvoegen, dubbele regels weg, vervaldatums buiten 2015-2019 weg.
con.sql(f"""
create table tx0 as
select msno,
       strptime(cast(transaction_date as varchar), '%Y%m%d')::date        as tdate,
       strptime(cast(membership_expire_date as varchar), '%Y%m%d')::date  as edate,
       is_cancel,
       payment_plan_days,
       payment_method_id,
       actual_amount_paid
from (
    select distinct * from (
        select * from '{RAW / "transactions.parquet"}'
        union all
        select * from '{RAW / "transactions_v2.parquet"}'
    )
)
where membership_expire_date between 20150101 and 20191231
""")

# Besluit 1: klanten die ooit betaalmethode 39 gebruikten, helemaal weglaten.
con.sql("""
create table tx1 as
select * from tx0
where msno not in (select msno from tx0 where payment_method_id = 39)
""")
# Besluit 2: klant vanaf het eerste betaalde abonnement (is_cancel = 0,
# >= 30 dagen, > 0 betaald). Eerdere transacties en klanten zonder zo'n
# abonnement tellen nergens mee.
con.sql("""
create table tx as
select t.* exclude (payment_method_id)
from tx1 t
join (select msno, min(tdate) start from tx1
      where is_cancel = 0 and payment_plan_days >= 30 and actual_amount_paid > 0
      group by msno) s using (msno)
where t.tdate >= s.start
""")
n0, n1, n2 = (con.sql(f"select count(distinct msno) from {t}").fetchall()[0][0]
              for t in ("tx0", "tx1", "tx"))
tx_before_start = con.sql("""
select count(*) from tx1 where msno in (select msno from tx)
""").fetchall()[0][0] - con.sql("select count(*) from tx").fetchall()[0][0]

# --- Tijdlijn per klant -----------------------------------------------------
# Elke transactie zet het einde van het abonnement op haar vervaldatum (ook een
# cancel-rij: die vervaldatum is het nieuwe einde). Bij gelijke datum telt een
# cancel-rij als laatste. De transactie geldt tot de volgende transactie.
con.sql("""
create table tl as
select *,
       lead(tdate) over w as next_tdate,
       -- moment waarop het abonnement afloopt als er niets meer gebeurt;
       -- een cancel met vervaldatum in het verleden stopt direct
       greatest(edate, tdate) as lapse
from tx
window w as (partition by msno order by tdate, is_cancel, edate)
""")

# --- Peildata --------------------------------------------------------------
peil = [date(2014, 12, 31)] + [q_end(y, q) for y, q in QUARTERS]
con.sql("create table peil (d date)")
con.executemany("insert into peil values (?)", [[d] for d in peil])

# Geldende transactie per klant op peildatum d: tdate <= d < next_tdate.
# Actief op d: einde van die transactie + 30 dagen ligt ná d. Einde = de
# vervaldatum (bij een cancel met vervaldatum in het verleden: de cancel-datum).
# Een nieuwe transactie binnen de 30 dagen wordt zelf de geldende transactie,
# dus wie op tijd verlengt blijft zonder onderbreking actief.
con.sql(f"""
create table gov as
select p.d, t.msno, t.edate, t.lapse, t.next_tdate,
       t.lapse + interval {GRACE_DAYS} day > p.d as active
from peil p
join tl t on t.tdate <= p.d and (t.next_tdate is null or t.next_tdate > p.d)
""")
con.sql("create table firsts as select msno, min(tdate) first from tx group by msno")

# --- Klantenstroom per kwartaal ----------------------------------------------
# Elke klant die aan begin of eind actief is, valt in precies één groep:
#   stay       actief begin en eind
#   new        niet actief begin, wel eind, eerste transactie ooit in dit kwartaal
#   returning  niet actief begin, wel eind, eerder al klant
#   churned    actief begin, niet eind: de 30 dagen na de vervaldatum liepen af
#              in dit kwartaal zonder nieuwe transactie
#   unexplained  actief begin, niet eind, maar de 30 dagen liepen niet in dit
#              kwartaal af (mag niet voorkomen)
# Daarnaast, buiten de som: inout = niet actief begin en niet eind, wel een
# transactie in het kwartaal (kwam en ging binnen het kwartaal).


def flow_sql(y, q, select):
    d0, qs, d1 = q_begin_peil(y, q), q_start(y, q), q_end(y, q)
    return f"""
with b as (select msno from gov where d = date '{d0}' and active),
     e as (select msno from gov where d = date '{d1}' and active),
     g1 as (select * from gov where d = date '{d1}'),
     txq as (select msno, max(payment_plan_days) maxplan from tx
             where tdate between date '{qs}' and date '{d1}' group by msno),
     pop as (select msno from b union select msno from e union select msno from txq),
     c as (
        select pop.msno,
          case
            when b.msno is not null and e.msno is not null then 'stay'
            when e.msno is not null then
              case when f.first >= date '{qs}' then 'new' else 'returning' end
            when b.msno is not null then
              case
                when g1.lapse + interval {GRACE_DAYS} day
                     between date '{qs}' and date '{d1}' then 'churned'
                else 'unexplained'
              end
            else 'inout'
          end as grp,
          txq.maxplan < {SHORT_PLAN_DAYS} as short
        from pop
        left join b using (msno)
        left join e using (msno)
        left join g1 using (msno)
        left join txq using (msno)
        left join firsts f using (msno)
     )
{select}
"""


GROUPS = ["stay", "new", "returning", "churned", "inout", "unexplained"]
flows = {}
for y, q in QUARTERS:
    res = con.sql(flow_sql(
        y, q, "select grp, count(*), count(*) filter (where short) from c group by grp"
    )).fetchall()
    f = {g: 0 for g in GROUPS}
    f["inoutShort"] = 0
    for grp, n, n_short in res:
        f[grp] = n
        if grp == "inout":
            f["inoutShort"] = n_short
    f["begin"] = f["stay"] + f["churned"] + f["unexplained"]
    f["end"] = f["stay"] + f["new"] + f["returning"]
    flows[(y, q)] = f

# Controle: begin + nieuw + terug - churn = eind, rest 0. Begin en
# eind komen rechtstreeks uit de peildata, niet uit de groepen.
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
        ids = [m for (m,) in con.sql(flow_sql(
            y, q, "select msno from c where grp = 'unexplained' order by msno limit 5"
        )).fetchall()]
        for m in ids:
            print(f"\n  {m}")
            print(f"    {'transactie':<12}{'vervalt':<12}{'cancel':>6}{'dagen':>6}{'betaald':>9}")
            for t, e, c, p, a in con.execute(
                "select tdate, edate, is_cancel, payment_plan_days, actual_amount_paid "
                "from tx where msno = ? order by tdate, is_cancel, edate", [m]
            ).fetchall():
                print(f"    {t!s:<12}{e!s:<12}{c:>6}{p:>6}{a:>9}")
if fail:
    sys.exit("Klantenstroom sluit niet. Niets weggeschreven.")

# --- Omzet ------------------------------------------------------------------
# actual_amount_paid, alleen regels met is_cancel = 0.
revenue_twd = {(y, q): n for y, q, n in con.sql("""
select year(tdate) y, quarter(tdate) q, sum(actual_amount_paid)
from tx where is_cancel = 0 group by all
""").fetchall()}

# members_v3: alleen ter controle van de dekking, niet om te filteren.
members_cover = con.execute(f"""
select count(*) filter (where m.msno is not null) * 1.0 / count(*)
from (select distinct msno from tx) c
left join (select distinct msno from '{RAW / "members_v3.parquet"}') m using (msno)
""").fetchall()[0][0]

# --- Kwartaalcijfers --------------------------------------------------------
rows = {}
for y, q in QUARTERS:
    f = flows[(y, q)]
    begin, end = f["begin"], f["end"]
    rev_eur = revenue_twd.get((y, q), 0) / TWD_PER_EUR
    rows[(y, q)] = dict(
        label=label(y, q),
        activeBegin=begin,
        activeEnd=end,
        newCustomers=f["new"],
        reacquiredCustomers=f["returning"],
        churn=f["churned"],
        churnRate=f["churned"] / begin if begin else None,
        revenueEur=rev_eur,
        marginPerCustomer=rev_eur * MARGIN / ((begin + end) / 2),
    )

for i, (y, q) in enumerate(QUARTERS):
    if (y, q) not in DASHBOARD:
        continue
    r = rows[(y, q)]
    # Verwachte churn: churnpercentage zelfde kwartaal vorig jaar (waterfall).
    prev = rows.get((y - 1, q))
    prev_rate = prev["churnRate"] if prev else None
    r["expectedChurn"] = None if prev_rate is None else prev_rate * r["activeBegin"]
    r["expectedChurnRate"] = prev_rate
    # CLV-retentie: 1 - gemiddeld churnpercentage van de vorige 4 kwartalen
    # (of van de kwartalen die er zijn). Zijn er geen, dan de werkelijke churn
    # van dit kwartaal (alleen Q2 2015: Q1 2015 heeft geen beginklanten).
    prior = [rows[k]["churnRate"] for k in QUARTERS[max(0, i - 4):i]
             if rows[k]["churnRate"] is not None]
    if prior:
        retention = 1 - sum(prior) / len(prior)
        r["clvBasis"] = "trailing"
    else:
        retention = 1 - r["churnRate"]
        r["clvBasis"] = "actual"
    r["retentionQuarters"] = len(prior)
    r["retention"] = retention
    r["avgClv"] = clv(r["marginPerCustomer"], retention)
    r["customerEquity"] = r["activeEnd"] * r["avgClv"]

# --- Waterfalls: jaar en kwartaal (CLAUDE.md, Verklaring van de verandering) --
# Beide tegen de CLV aan het begin van de periode (V0). De CLV-verandering is
# gesplitst: Vm = CLV met de marge van het eind en de retentie van het begin;
# marge-effect = (Vm - V0) x N1, retentie-effect = (V1 - Vm) x N1.
# Zonder verwachte churn (geen vorig jaar) is er geen waterfall: veld null.
def waterfall(begin, periods, expected):
    """begin = kwartaal aan het begin; periods = kwartalen in de periode (laatste = eind)."""
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

# --- Vergelijkingen en antwoordzin (voor het scherm; de app rekent niets) -----
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
    # kwartalen, afgerond op 0,1 zoals in het ontwerp) en marge x die duur.
    # Met disconto is de uitkomst avgClv.
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
ALL_WF = [(rows[k]["label"], kind, rows[k][field]) for k in DASHBOARD
          for kind, field in (("kwartaal", "waterfall"), ("jaar", "yearWaterfall"))
          if rows[k][field] is not None]
bad = [(lbl, kind, w["_deviation"]) for lbl, kind, w in ALL_WF if abs(w["_deviation"]) >= 1]
if bad:
    for lbl, kind, dev in bad:
        print(f"{lbl} ({kind}): afwijking {dev:+,.2f} EUR")
    sys.exit("Waterfall sluit niet. Niets weggeschreven.")


def public(w):
    return None if w is None else {k: v for k, v in w.items() if not k.startswith("_")}


# --- Wegschrijven ----------------------------------------------------------
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
        "clvBasis": r["clvBasis"],
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
#     (afwijking x active customers, dus in euro customer equity)
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

OUT.write_text(json.dumps(out, indent=2) + "\n")

# --- Uitvoer ----------------------------------------------------------------
print("Weggelaten klanten")
print(f"  na opschonen                         {n0:>10,}")
print(f"  besluit 1: ooit methode 39           {n1 - n0:>+10,}")
print(f"  besluit 2: nooit betaald >= 30 dagen {n2 - n1:>+10,}")
print(f"  over                                 {n2:>10,}")
print(f"  (transacties vóór eerste betaalde abonnement weggelaten: {tx_before_start:,})\n")
print(f"Geschreven: {OUT.relative_to(ROOT)}  ({len(out)} kwartalen)")
print("Controle drivers (grootste afwijking over alle kwartalen):")
print(f"  (a) CE = klanten x CLV:                 {max_dev['a']:.4f} EUR")
print(f"  (b) klanten = vorig + new + reacq - churn: {max_dev['b']} klanten")
print(f"  (c) CLV uit marge en retentie (x klanten): {max_dev['c']:.4f} EUR")
print(f"Klanten met record in members_v3: {members_cover:.1%}\n")

print("Waterfalls (EUR, tegen begin-CLV)")
for lbl, kind, w in ALL_WF:
    parts = "  ".join(f"{k} {v:+,.0f}" for k, v in w["parts"].items())
    print(f"  {lbl} {kind:<8} {w['fromLabel']} -> {w['toLabel']}: {parts}")
    print(f"  {'':<17} som {w['_sum']:+,.0f}  verandering {w['equityChange']:+,.0f}  "
          f"afwijking {w['_deviation']:.4f}")
print()

hdr = (f"{'kwartaal':<8} {'begin':>9} {'eind':>9} {'nieuw':>8} {'churn':>8} "
       f"{'verw.churn':>10} {'omzet EUR':>12} {'marge/kl':>8} {'retentie':>8} "
       f"{'basis':>10} {'CLV':>7} {'cust. equity':>13} {'in&uit':>8} {'w.v.<30d':>8}")
print(hdr)
print("-" * len(hdr))
for (y, q), r in zip(DASHBOARD, out):
    f = flows[(y, q)]
    ec = "-" if r["expectedChurn"] is None else f"{r['expectedChurn']:,.0f}"
    basis = f"{r['clvBasis']}({r['retentionQuarters']})"
    print(f"{r['label']:<8} {r['activeBegin']:>9,} {r['activeEnd']:>9,} "
          f"{r['newCustomers']:>8,} {r['churn']:>8,} {ec:>10} "
          f"{r['revenueEur']:>12,.0f} {r['marginPerCustomer']:>8.2f} "
          f"{r['retention']:>8.3f} {basis:>10} {r['avgClv']:>7.2f} "
          f"{r['customerEquity']:>13,.0f} {f['inout']:>8,} {f['inoutShort']:>8,}")

print("\nKlantenstroom: begin + nieuw + terug - churn = eind")
hdr = (f"{'kwartaal':<8} {'begin':>9} {'blijft':>9} {'+nieuw':>8} {'+terug':>8} "
       f"{'-churn':>8} {'eind':>9} {'rest':>5}")
print(hdr)
print("-" * len(hdr))
for y, q in DASHBOARD:
    f = flows[(y, q)]
    print(f"{label(y, q):<8} {f['begin']:>9,} {f['stay']:>9,} {f['new']:>8,} "
          f"{f['returning']:>8,} {f['churned']:>8,} "
          f"{f['end']:>9,} {f['rest']:>5,}")
