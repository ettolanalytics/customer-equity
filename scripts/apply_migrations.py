"""Voert supabase/migrations/*.sql uit op Supabase, in één transactie (alles of niets).

Als postgres (beheerder), via de session pooler (SUPABASE_DB_URL in .env.local).
Stopt als schema ce_private al bestaat: de migraties zijn bedoeld voor een lege start.
Meldt daarna of pg_cron beschikbaar is.

Draaien:  .venv/bin/python scripts/apply_migrations.py
          .venv/bin/python scripts/apply_migrations.py supabase/migrations/<nieuw>.sql
Met bestandsnamen: alleen die migraties, op een bestaand schema, gevolgd door de
beveiligingsasserties; alles in één transactie.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import ROOT, connect  # noqa: E402

MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
ASSERTIONS = ROOT / "supabase" / "migrations" / "20261107150300_ce_security_assertions.sql"


def main():
    only = [Path(a).resolve() for a in sys.argv[1:]]
    for path in only:
        if path not in MIGRATIONS:
            sys.exit(f"Onbekende migratie: {path.name}")
    with connect("SUPABASE_DB_URL") as conn:
        conn.add_notice_handler(lambda n: print(f"  notice: {n.message_primary}"))
        with conn.cursor() as cur:
            cur.execute("select exists (select 1 from pg_namespace where nspname = 'ce_private')")
            exists = cur.fetchone()[0]
            if only:
                if not exists:
                    sys.exit("Schema ce_private bestaat nog niet. Eerst alle migraties.")
                for path in [*only, ASSERTIONS]:
                    cur.execute(path.read_text())
                    print(f"OK  {path.name}")
            else:
                if exists:
                    sys.exit("Schema ce_private bestaat al. Migraties niet opnieuw uitgevoerd.")
                for path in MIGRATIONS:
                    cur.execute(path.read_text())
                    print(f"OK  {path.name}")
        conn.commit()
        print("Migraties toegepast (één transactie).")

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
