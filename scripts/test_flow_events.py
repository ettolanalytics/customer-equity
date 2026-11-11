"""Test van de flowtelling (migratie 17) met verzonnen klantperioden, op de database.

Toetst ce_private.spell_events(): flows tellen gebeurtenissen, ook twee keer churn voor
dezelfde klant in één kwartaal en komen en gaan binnen het kwartaal; en eind = begin + new +
reacquired − churn, per klant en in totaal. Alleen lezen (de functie is immutable).

Draaien:  .venv/bin/python scripts/test_flow_events.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import connect  # noqa: E402

Q0, QE = "2026-06-30", "2026-09-30"  # Q3 2026: gebeurtenissen in (Q0, QE]

# klant, klantperiode, eerste betaalde factuur bekend (known_start), einde respijt (spell_end)
SPELLS = [
    # A: actief aan het begin, churnt, komt terug en churnt opnieuw, komt nog eens terug.
    ("A", 1, "2025-01-10", "2026-07-15"),
    ("A", 2, "2026-07-16", "2026-08-30"),
    ("A", 3, "2026-09-10", "2026-11-09"),
    # B: nieuwe klant die binnen het kwartaal komt en gaat.
    ("B", 1, "2026-07-05", "2026-09-03"),
    # C: blijvende klant.
    ("C", 1, "2024-03-01", "2027-01-31"),
    # D: respijt verstrijkt precies op het kwartaaleinde: churn in dit kwartaal, niet actief aan het eind.
    ("D", 1, "2023-05-01", "2026-09-30"),
    # E: respijt verstreek precies op het begin: churn in het vorige kwartaal, telt hier niet.
    ("E", 1, "2023-05-01", "2026-06-30"),
    # F: eerste factuur precies op het begin: actief aan het begin, niet nieuw in dit kwartaal.
    ("F", 1, "2026-06-30", "2026-12-31"),
]

EXPECTED = {  # klant: (new, reacquired, churn, begin, eind)
    "A": (0, 2, 2, 1, 1),
    "B": (1, 0, 1, 0, 0),
    "C": (0, 0, 0, 1, 1),
    "D": (0, 0, 1, 1, 0),
    "E": (0, 0, 0, 0, 0),
    "F": (0, 0, 0, 1, 1),
}

SQL = """
select s.customer, sum(x.n_new), sum(x.n_reacq), sum(x.n_churn), sum(x.n_begin), sum(x.n_end)
from (values {rows}) as s(customer, spell_no, known_start, spell_end)
cross join lateral ce_private.spell_events(s.spell_no, s.known_start::date, s.spell_end::date,
                                           %s::date, %s::date) x
group by s.customer order by s.customer
"""


def main() -> int:
    rows = ", ".join("(%s, %s, %s, %s)" for _ in SPELLS)
    params = [v for spell in SPELLS for v in spell] + [Q0, QE]
    with connect("SUPABASE_DB_URL") as conn, conn.cursor() as cur:
        cur.execute("set transaction read only")
        cur.execute(SQL.format(rows=rows), params)
        got = {r[0]: tuple(int(v) for v in r[1:]) for r in cur.fetchall()}
        conn.rollback()

    fails = []
    for customer, exp in EXPECTED.items():
        if got.get(customer) != exp:
            fails.append(f"klant {customer}: verwacht {exp}, kreeg {got.get(customer)}")
        new, reacq, churn, begin, end = got.get(customer, (0, 0, 0, 0, 0))
        if begin + new + reacq - churn != end:
            fails.append(f"klant {customer}: stroom sluit niet ({begin} + {new} + {reacq} − {churn} ≠ {end})")
    tot = [sum(v[i] for v in got.values()) for i in range(5)]
    if tot[3] + tot[0] + tot[1] - tot[2] != tot[4]:
        fails.append(f"totaal: stroom sluit niet {tot}")
    if got.get("A", (0, 0, 0))[2] != 2:
        fails.append("dubbele churn van klant A niet als twee gebeurtenissen geteld")

    names = ("new", "reacquired", "churn", "begin", "eind")
    print("totaal:", ", ".join(f"{n} {v}" for n, v in zip(names, tot)))
    for f in fails:
        print("FOUT", f)
    print("geslaagd" if not fails else f"{len(fails)} fout(en)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
