"""Toetst beveiliging en faalroute op Supabase.

Beveiliging
  - via de Data API met de publishable key (rol anon), zoals de browser en Netlify:
    ce_public lezen mag; schrijven en ce_private niet; refresh niet aanroepbaar
  - via de database als ce_loader: geen schrijfrechten op ce_public, geen UPDATE op
    facturen; wie refresh_and_publish() mag uitvoeren
Faalroute (als ce_loader)
  - een generatorrun met een verkeerd aantal rijen laat de controle "bron" falen
  - ce_public blijft gelijk (inhoud en generated_at), de fout staat in refresh_log
  - daarna een juiste run en een geslaagde refresh

Draaien:  .venv/bin/python scripts/test_supabase.py
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_beanrise as gen  # noqa: E402
from env import connect, load_env, require  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'OK  ' if ok else 'FOUT'} {name}" + (f"  ({detail})" if detail else ""))


def rest(method, path, profile, body=None):
    load_env()
    import os
    url = (os.environ.get("SUPABASE_URL") or require("VITE_SUPABASE_URL")).rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or require("VITE_SUPABASE_PUBLISHABLE_KEY")
    headers = {"apikey": key, "Accept": "application/json",
               ("Accept-Profile" if method == "GET" else "Content-Profile"): profile}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{url}/rest/v1/{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    sys.exit("Buiten gebruik sinds 10 nov 2026: de oude facturen zijn leeggemaakt en de oude "
             "refresh_and_publish() mag niet meer draaien. Data komt via scripts/ingest_beanrise.py.")
    print("Beveiliging via de Data API (publishable key = rol anon)")
    s, b = rest("GET", "quarters?select=seq,label&order=seq", "ce_public")
    check("anon leest ce_public.quarters", s == 200 and len(json.loads(b)) > 0, f"HTTP {s}, {len(json.loads(b)) if s == 200 else b[:80]} rijen")
    s, b = rest("GET", "publication?select=*", "ce_public")
    check("anon leest ce_public.publication", s == 200 and len(json.loads(b)) == 1, f"HTTP {s}")
    s, b = rest("GET", "invoices?select=*&limit=1", "ce_private")
    check("anon kan ce_private.invoices niet lezen", s >= 400, f"HTTP {s} {b[:90]}")
    s, b = rest("GET", "mv_quarters_json?select=seq&limit=1", "ce_private")
    check("anon kan ce_private-views niet lezen", s >= 400, f"HTTP {s}")
    s, b = rest("POST", "quarters", "ce_public", {"seq": 999, "label": "Q1 2099", "data": {"label": "Q1 2099"}})
    check("anon kan niet invoegen in ce_public", s in (401, 403), f"HTTP {s} {b[:90]}")
    s, b = rest("PATCH", "publication?id=eq.999", "ce_public", {"grace_days": 1})
    check("anon kan ce_public niet wijzigen", s in (401, 403), f"HTTP {s}")
    s, b = rest("DELETE", "quarters?seq=eq.999", "ce_public")
    check("anon kan niet verwijderen uit ce_public", s in (401, 403), f"HTTP {s}")
    s, b = rest("POST", "rpc/refresh_and_publish", "ce_private", {})
    check("anon kan refresh_and_publish niet aanroepen (ce_private)", s >= 400, f"HTTP {s} {b[:90]}")
    s, b = rest("POST", "rpc/refresh_and_publish", "ce_public", {})
    check("anon kan refresh_and_publish niet aanroepen (ce_public)", s >= 400, f"HTTP {s}")

    with connect("CE_LOADER_DB_URL", autocommit=True) as conn, conn.cursor() as cur:
        print("\nBeveiliging in de database (als ce_loader)")
        cur.execute("""select r, has_function_privilege(r, 'ce_private.refresh_and_publish()', 'EXECUTE')
                       from unnest(array['anon', 'authenticated', 'service_role', 'ce_loader']) r""")
        for role, can in cur.fetchall():
            check(f"refresh_and_publish uitvoerbaar door {role}: {'ja' if can else 'nee'}",
                  can == (role == "ce_loader"))
        for name, sql in [
            ("ce_loader kan niet schrijven in ce_public",
             "insert into ce_public.publication (id) values (1)"),
            ("ce_loader kan ce_public niet leegmaken", "delete from ce_public.quarters"),
            ("ce_loader kan facturen niet wijzigen",
             "update ce_private.invoices set amount_eur = 1 where customer_id = -1"),
        ]:
            try:
                with conn.transaction():
                    cur.execute(sql)
                check(name, False, "toegestaan")
            except psycopg.errors.InsufficientPrivilege as e:
                check(name, True, str(e).splitlines()[0])

        print("\nFaalroute (als ce_loader)")
        snap = """select (select md5(string_agg(data::text, ',' order by seq)) from ce_public.quarters),
                         (select generated_at from ce_public.publication),
                         (select count(*) from ce_public.quarters)"""
        cur.execute(snap)
        before = cur.fetchone()
        cur.execute("""insert into ce_private.generator_runs
                         (company, generator_version, seed, parameters, rows, customers, invoices_sha256)
                       select company, generator_version, seed, '{"test": "faalroute"}', rows + 1,
                              customers, invoices_sha256
                       from ce_private.generator_runs order by id desc limit 1""")
        cur.execute("select ce_private.refresh_and_publish()")
        res = cur.fetchone()[0]
        check("refresh faalt bij een bewust kapotte controle", res.startswith("failed"), res)
        cur.execute(snap)
        after = cur.fetchone()
        check("ce_public onveranderd (inhoud, generated_at, aantal)", before == after,
              f"{before[2]} kwartalen, gemaakt {before[1]}")
        s, b = rest("GET", "publication?select=generated_at", "ce_public")
        check("ook via de Data API dezelfde publicatie", s == 200 and json.loads(b)[0]["generated_at"][:19]
              == before[1].isoformat()[:19], b[:80])
        cur.execute("select status, message, details from ce_private.refresh_log order by id desc limit 1")
        status, message, details = cur.fetchone()
        check("fout staat in refresh_log", status == "failed", f"{message}: {json.dumps(details)[:160]}")

        manifest = json.loads((gen.OUT_DIR / "manifest.json").read_text())
        cur.execute("""insert into ce_private.generator_runs
                         (company, generator_version, seed, parameters, rows, customers, invoices_sha256)
                       values (%s, %s, %s, %s, %s, %s, %s)""",
                    (manifest["company"], manifest["generatorVersion"], manifest["seed"],
                     json.dumps(manifest["parameters"]), manifest["rows"], manifest["customers"],
                     manifest["sha256"]["invoices"]))
        cur.execute("select ce_private.refresh_and_publish()")
        res = cur.fetchone()[0]
        check("herstel: juiste run, refresh publiceert weer", res == "published", res)

    print(f"\n{sum(results)} van {len(results)} toetsen geslaagd.")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
