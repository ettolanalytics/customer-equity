"""Laadt de Beanrise-facturen in Supabase (ce_private) en start de refresh.

Als ce_loader, via de session pooler (CE_LOADER_DB_URL in .env.local).
  1. controleert de SHA-256 van het Parquet-bestand tegen manifest.json
  2. in één transactie: TRUNCATE invoices, generator_runs-rij, facturen in blokken
  3. vergelijkt de vingerafdruk van de geladen facturen met de Parquet (DuckDB)
  4. roept ce_private.refresh_and_publish() aan en toont het resultaat

Draaien:  .venv/bin/python scripts/load_beanrise.py
"""

import json
import sys
from pathlib import Path

import duckdb
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_beanrise as gen  # noqa: E402
from env import connect  # noqa: E402

PART = gen.OUT_DIR / "beanrise_invoices.parquet"
BATCH = 50_000

FINGERPRINT_SQL = """
select count(*), count(distinct customer_id), sum(customer_id::bigint),
       sum(invoice_date - date '2000-01-01'), sum(expire_date - date '2000-01-01'),
       sum(amount_eur), min(invoice_date), max(invoice_date)
from {table}
"""
FINGERPRINT_NAMES = ["rijen", "klanten", "som klant-id", "som factuurdatum (dagen)",
                     "som vervaldatum (dagen)", "som bedrag", "eerste factuur", "laatste factuur"]


def parquet_fingerprint():
    con = duckdb.connect()
    con.sql(f"create view inv as select * from '{PART}'")
    return list(con.sql(FINGERPRINT_SQL.format(table="inv")).fetchall()[0])


def main():
    manifest = json.loads((gen.OUT_DIR / "manifest.json").read_text())
    sha = gen.sha256(PART)
    if sha != manifest["sha256"]["invoices"]:
        sys.exit("SHA-256 van het Parquet-bestand wijkt af van manifest.json. Eerst opnieuw genereren.")
    print(f"Parquet: {manifest['rows']:,} facturen, generator {manifest['generatorVersion']}, seed {manifest['seed']}")

    # COPY FROM werkt niet op een tabel met RLS (voor een rol die geen eigenaar is);
    # daarom INSERT in blokken via unnest(arrays), allemaal in één transactie.
    with duckdb.connect() as src:
        reader = src.execute(f"""select customer_id, invoice_date, expire_date, amount_eur::double
                                 from '{PART}' order by customer_id, invoice_date""")
        with connect("CE_LOADER_DB_URL") as conn:
            with conn.cursor() as cur:
                cur.execute("truncate ce_private.invoices")
                cur.execute(
                    """insert into ce_private.generator_runs
                         (company, generator_version, seed, parameters, rows, customers, invoices_sha256)
                       values (%s, %s, %s, %s, %s, %s, %s)""",
                    (manifest["company"], manifest["generatorVersion"], manifest["seed"],
                     json.dumps(manifest["parameters"]), manifest["rows"], manifest["customers"], sha))
                done = 0
                while batch := reader.fetchmany(BATCH):
                    cols = list(zip(*batch))
                    cur.execute(
                        """insert into ce_private.invoices (customer_id, invoice_date, expire_date, amount_eur)
                           select * from unnest(%s::integer[], %s::date[], %s::date[], %s::numeric(5,2)[])""",
                        (list(cols[0]), list(cols[1]), list(cols[2]), list(cols[3])))
                    done += len(batch)
                    print(f"\r  {done:,} / {manifest['rows']:,}", end="", flush=True)
                print()
            conn.commit()
            print("Geladen.")

            with conn.cursor() as cur:
                cur.execute(FINGERPRINT_SQL.format(table="ce_private.invoices"))
                db = list(cur.fetchone())
            pq = parquet_fingerprint()
            ok = True
            print("\nVingerafdruk facturen            Supabase              Parquet")
            for name, a, b in zip(FINGERPRINT_NAMES, db, pq):
                same = str(a) == str(b)
                ok &= same
                print(f"  {'OK  ' if same else 'FOUT'} {name:<26} {a!s:>20} {b!s:>20}")
            if not ok:
                sys.exit("Vingerafdruk wijkt af. Refresh niet gestart.")

            with conn.cursor() as cur:
                cur.execute("select ce_private.refresh_and_publish()")
                result = cur.fetchone()[0]
                conn.commit()
                cur.execute("""select status, message, finished_at - started_at
                               from ce_private.refresh_log order by id desc limit 1""")
                status, message, took = cur.fetchone()
            print(f"\nrefresh_and_publish(): {result}  ({message}, {took})")
            if status != "published":
                sys.exit(1)


if __name__ == "__main__":
    main()
