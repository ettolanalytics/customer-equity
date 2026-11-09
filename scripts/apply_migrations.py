"""Voert supabase/migrations/*.sql uit op Supabase, in één transactie (alles of niets).

Als postgres (beheerder), via de session pooler (SUPABASE_DB_URL in .env.local).
Stopt als schema ce_private al bestaat: de migraties zijn bedoeld voor een lege start.
Meldt daarna of pg_cron beschikbaar is.

Draaien:  .venv/bin/python scripts/apply_migrations.py
"""

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import ROOT, connect  # noqa: E402

MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))


def main():
    with connect("SUPABASE_DB_URL") as conn:
        conn.add_notice_handler(lambda n: print(f"  notice: {n.message_primary}"))
        with conn.cursor() as cur:
            cur.execute("select exists (select 1 from pg_namespace where nspname = 'ce_private')")
            if cur.fetchone()[0]:
                sys.exit("Schema ce_private bestaat al. Migraties niet opnieuw uitgevoerd.")
            for path in MIGRATIONS:
                cur.execute(path.read_text())
                print(f"OK  {path.name}")
        conn.commit()
        print("Alle migraties toegepast (één transactie).")

        with conn.cursor() as cur:
            cur.execute("""select default_version, installed_version
                           from pg_available_extensions where name = 'pg_cron'""")
            row = cur.fetchone()
        if row:
            print(f"pg_cron beschikbaar (versie {row[0]}, geïnstalleerd: {row[1] or 'nee'}).")
        else:
            print("pg_cron niet beschikbaar op dit project.")


if __name__ == "__main__":
    main()
