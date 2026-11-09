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
        returningCustomers=f["returning"],
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

# --- Waterfall per kwartaal (vanaf Q3 2015) ---------------------------------
# Tegen de gemiddelde CLV aan het begin van het kwartaal (= CLV vorig kwartaal).
# Nieuwe klanten = nieuw + terug (= eind - begin + churn).
# Zonder verwachte churn (geen vorig jaar) is er geen waterfall: veld null.
for i, (y, q) in enumerate(DASHBOARD[1:], start=1):
    r, p = rows[(y, q)], rows[DASHBOARD[i - 1]]
    acquired = r["newCustomers"] + r["returningCustomers"]
    assert acquired == r["activeEnd"] - r["activeBegin"] + r["churn"]
    exp = r["expectedChurn"]
    if exp is None:
        continue
    clv0, clv1 = p["avgClv"], r["avgClv"]
    wf = {
        "equityBegin": p["customerEquity"],
        "newCustomers": acquired * clv0,
        "expectedChurn": -exp * clv0,
        "churnVsExpected": (exp - r["churn"]) * clv0,
        "clvChange": (clv1 - clv0) * r["activeEnd"],
        "equityEnd": r["customerEquity"],
    }
    wf["sum"] = (wf["newCustomers"] + wf["expectedChurn"]
                 + wf["churnVsExpected"] + wf["clvChange"])
    wf["delta"] = wf["equityEnd"] - wf["equityBegin"]
    wf["deviation"] = wf["delta"] - wf["sum"]
    r["waterfall"] = wf

WATERFALL = [k for k in DASHBOARD if "waterfall" in rows[k]]
bad = [(rows[k]["label"], rows[k]["waterfall"]["deviation"]) for k in WATERFALL
       if abs(rows[k]["waterfall"]["deviation"]) >= 1]
if bad:
    for lbl, dev in bad:
        print(f"{lbl}: afwijking {dev:+,.2f} EUR")
    sys.exit("Waterfall sluit niet. Niets weggeschreven.")

# --- Wegschrijven ----------------------------------------------------------
out = []
for y, q in DASHBOARD:
    r = rows[(y, q)]
    out.append({
        "label": r["label"],
        "activeBegin": r["activeBegin"],
        "activeEnd": r["activeEnd"],
        "newCustomers": r["newCustomers"],
        "returningCustomers": r["returningCustomers"],
        "acquiredCustomers": r["newCustomers"] + r["returningCustomers"],
        "churn": r["churn"],
        "expectedChurn": None if r["expectedChurn"] is None else round(r["expectedChurn"], 1),
        "revenueEur": round(r["revenueEur"], 2),
        "marginPerCustomer": round(r["marginPerCustomer"], 4),
        "retention": round(r["retention"], 6),
        "retentionQuarters": r["retentionQuarters"],
        "clvBasis": r["clvBasis"],
        "avgClv": round(r["avgClv"], 4),
        "customerEquity": round(r["customerEquity"], 2),
        "waterfall": None if "waterfall" not in r else {
            k: round(r["waterfall"][k], 2)
            for k in ("equityBegin", "newCustomers", "expectedChurn",
                      "churnVsExpected", "clvChange", "equityEnd")
        },
    })
OUT.write_text(json.dumps(out, indent=2) + "\n")

# --- Uitvoer ----------------------------------------------------------------
print("Weggelaten klanten")
print(f"  na opschonen                         {n0:>10,}")
print(f"  besluit 1: ooit methode 39           {n1 - n0:>+10,}")
print(f"  besluit 2: nooit betaald >= 30 dagen {n2 - n1:>+10,}")
print(f"  over                                 {n2:>10,}")
print(f"  (transacties vóór eerste betaalde abonnement weggelaten: {tx_before_start:,})\n")
print(f"Geschreven: {OUT.relative_to(ROOT)}  ({len(out)} kwartalen)")
print(f"Klanten met record in members_v3: {members_cover:.1%}\n")

print("Waterfall per kwartaal (EUR, tegen begin-CLV)")
hdr = (f"{'kwartaal':<8} {'CE begin':>12} {'+nieuw':>11} {'-verw.churn':>12} "
       f"{'verschil':>11} {'CLV-wijz.':>11} {'CE eind':>12} {'som':>11} "
       f"{'verandering':>12} {'afwijking':>10}")
print(hdr)
print("-" * len(hdr))


for k in WATERFALL:
    w = rows[k]["waterfall"]
    print(f"{rows[k]['label']:<8} {w['equityBegin']:>12,.0f} {w['newCustomers']:>+11,.0f} "
          f"{w['expectedChurn']:>+12,.0f} {w['churnVsExpected']:>+11,.0f} "
          f"{w['clvChange']:>+11,.0f} {w['equityEnd']:>12,.0f} {w['sum']:>+11,.0f} "
          f"{w['delta']:>+12,.0f} {w['deviation']:>10.4f}")
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
