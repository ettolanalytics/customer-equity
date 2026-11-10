"""Haalt de Beanrise-data op via de API (datacontract v1.2) en schrijft ze in ce_private.bz_*.

Incrementeel, met watermerken uit de laatste geslaagde lading in ce_private.loads:
  facturen en events   ?after_id=<hoogste id>          (veranderen nooit)
  klanten, abonnementen ?updated_since=<vorige as_of>  (overlap van een dag; dubbelen vallen weg)
  plans, product-costs  elke keer volledig (klein)
as_of uit /v1/status is de bovengrens: records van na die dag blijven voor de volgende lading.

Volgorde: eerst alles ophalen naar tijdelijke bestanden en per record controleren, dan in
één transactie schrijven en de controles op de hele tabellen draaien (o.a. aantallen gelijk
aan /v1/status). Faalt er iets, dan wordt niets geschreven, schuift geen watermerk op, en
komt alleen een rij 'failed' in ce_private.loads.

Drukt nooit de API-URL, de sleutel, de database-URL of gegevens per klant af; alleen aantallen.

Nodig: BEANRISE_API_URL, BEANRISE_API_KEY, CE_LOADER_DB_URL (omgeving of .env.local).
Draaien:  .venv/bin/python scripts/ingest_beanrise.py
          .venv/bin/python scripts/ingest_beanrise.py --dry-run --max-pages 3   (test, rollback)
"""

import argparse
import gzip
import hashlib
import http.client
import json
import os
import sys
import tempfile
import time
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env import connect, require  # noqa: E402

PAGE_SIZE = 1000                 # maximum van de API
WARN_DB_BYTES = 450 * 1000 ** 2  # waarschuwen boven 450 MB (grens gratis plan: 500 MB)
MAX_429_WAIT = 15 * 60
IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"

SUB_STATUS = {"active": 1, "past_due": 2, "canceled": 3}
EVENT_TYPE = {"created": 1, "plan_changed": 2, "canceled": 3}
INV_STATUS = {"paid": 1, "failed": 2}

# Volgorde = schrijfvolgorde. table: doeltabel; mode: hoe incrementeel.
ENDPOINTS = [
    ("plans", "/v1/plans", "full", "bz_plans"),
    ("product_costs", "/v1/product-costs", "full", "bz_product_costs"),
    ("customers", "/v1/customers", "updated", "bz_customers"),
    ("subscriptions", "/v1/subscriptions", "updated", "bz_subscriptions"),
    ("subscription_events", "/v1/subscription-events", "after_id", "bz_subscription_events"),
    ("invoices", "/v1/invoices", "after_id", "bz_invoices"),
]
KEY = {"bz_customers": "customer_id", "bz_subscriptions": "subscription_id",
       "bz_subscription_events": "event_id", "bz_invoices": "invoice_id"}
COLUMNS = {
    "bz_plans": ["plan_id", "valid_from", "valid_to", "name", "size_grams", "billing_interval",
                 "price_excl_vat_cents", "vat_rate"],
    "bz_product_costs": ["plan_id", "valid_from", "valid_to", "cost_cents"],
    "bz_customers": ["customer_id", "created_at", "updated_at"],
    "bz_subscriptions": ["subscription_id", "customer_id", "plan_id", "status", "billing_day",
                         "started_at", "canceled_at", "updated_at"],
    "bz_subscription_events": ["event_id", "subscription_id", "type", "from_plan_id", "to_plan_id",
                               "occurred_at", "created_at"],
    "bz_invoices": ["paid_at", "invoice_id", "subscription_id", "customer_id", "amount_excl_vat_cents",
                    "period_start", "period_end", "plan_id", "status"],
}


class LoadError(Exception):
    def __init__(self, code, message, checks=None):
        super().__init__(message)
        self.code, self.message, self.checks = code, message, checks or []


def log(msg=""):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
class Api:
    """Kleine HTTPS-client met keep-alive en gzip. Meldt nooit host, querystring of antwoordtekst."""

    def __init__(self, base_url, key):
        u = urlparse(base_url)
        if u.scheme != "https" or not u.hostname:
            raise LoadError("config", "BEANRISE_API_URL is geen https-URL.")
        self.host, self.port, self.prefix, self.key = u.hostname, u.port, u.path.rstrip("/"), key
        self.conn = None
        self.requests = self.wire_bytes = self.json_bytes = 0

    def _close(self):
        if self.conn:
            self.conn.close()
        self.conn = None

    def get(self, path, params, page):
        query = urlencode({k: v for k, v in params.items() if v is not None})
        target = f"{self.prefix}{path}?{query}" if query else f"{self.prefix}{path}"
        where = f"GET {path} (pagina {page})"
        waited, attempt = 0, 0
        while True:
            try:
                if self.conn is None:
                    self.conn = http.client.HTTPSConnection(self.host, self.port, timeout=60)
                self.conn.request("GET", target, headers={
                    "X-API-Key": self.key, "Accept": "application/json", "Accept-Encoding": "gzip"})
                resp = self.conn.getresponse()
                body = resp.read()
                status, enc, retry_after = resp.status, resp.getheader("Content-Encoding"), resp.getheader("Retry-After")
            except (OSError, http.client.HTTPException) as e:
                self._close()
                attempt += 1
                if attempt > 5:
                    raise LoadError("netwerk", f"{where}: netwerkfout ({type(e).__name__}) na 5 pogingen.") from None
                time.sleep(2 ** attempt)
                continue
            self.requests += 1
            self.wire_bytes += len(body)
            if status == 200:
                if enc == "gzip":
                    body = gzip.decompress(body)
                self.json_bytes += len(body)
                try:
                    return json.loads(body)
                except ValueError:
                    raise LoadError("api_json", f"{where}: geen geldige JSON.") from None
            if status == 401:
                raise LoadError("api_401", f"{where}: 401, API-sleutel ongeldig.")
            if status == 429:
                wait = min(int(retry_after) if (retry_after or "").isdigit() else 10, 120)
                waited += wait
                if waited > MAX_429_WAIT:
                    raise LoadError("api_429", f"{where}: 429, meer dan 15 minuten gewacht.")
                log(f"  429 bij {path}: {wait} s wachten (Retry-After)")
                time.sleep(wait)
                continue
            if 500 <= status < 600:
                self._close()
                attempt += 1
                if attempt > 5:
                    raise LoadError("api_5xx", f"{where}: {status} na 5 pogingen.")
                time.sleep(2 ** attempt)
                continue
            raise LoadError(f"api_{status}", f"{where}: onverwachte status {status}.")


# ---------------------------------------------------------------------------
# Records controleren en omzetten naar COPY-regels
# ---------------------------------------------------------------------------
def ts(value):
    """ISO-tijdstip met tijdzone → datetime (UTC)."""
    d = datetime.fromisoformat(value)
    if d.tzinfo is None:
        raise ValueError("tijd zonder tijdzone")
    return d.astimezone(timezone.utc)


def day(value):
    if len(value) != 10:
        raise ValueError("geen datum JJJJ-MM-DD")
    return date.fromisoformat(value)


def next_month(d):
    """(jaar, maand) van de kalendermaand na d."""
    return (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)


def pos_int(v):
    if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
        raise ValueError("geen positieve integer")
    return v


def copy_text(v):
    """Waarde in het tekstformaat van COPY."""
    if v is None:
        return r"\N"
    s = v.isoformat() if isinstance(v, (date, datetime)) else str(v)
    return s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")


class Checker:
    """Telt overtredingen per controle; bewaart geen ids of waarden."""

    def __init__(self):
        self.fail = {}

    def bad(self, name):
        self.fail[name] = self.fail.get(name, 0) + 1


def convert(name, rec, st, chk):
    """Eén record → rij voor de doeltabel, of None als het na as_of valt. st: toestand per endpoint."""
    upper = st["upper"]
    if name == "plans":
        if rec.get("billing_interval") != "month":
            chk.bad("plans: billing_interval niet 'month'")
        if float(rec.get("vat_rate")) != 0.09:
            chk.bad("plans: vat_rate niet 0,09")
        return [pos_int(rec["plan_id"]), day(rec["valid_from"]),
                day(rec["valid_to"]) if rec.get("valid_to") else None, rec["name"],
                pos_int(rec["size_grams"]), rec["billing_interval"], int(rec["price_excl_vat_cents"]),
                rec["vat_rate"]]
    if name == "product_costs":
        return [pos_int(rec["plan_id"]), day(rec["valid_from"]),
                day(rec["valid_to"]) if rec.get("valid_to") else None, int(rec["cost_cents"])]
    if name == "customers":
        upd = ts(rec["updated_at"])
        if upd >= upper:
            return None
        return [pos_int(rec["customer_id"]), ts(rec["created_at"]), upd]
    if name == "subscriptions":
        upd = ts(rec["updated_at"])
        if upd >= upper:
            return None
        if rec.get("status") not in SUB_STATUS:
            chk.bad("subscriptions: onbekende status")
            return None
        bd = rec["billing_day"]
        if not isinstance(bd, int) or not 1 <= bd <= 31:
            chk.bad("subscriptions: billing_day buiten 1-31")
        return [pos_int(rec["subscription_id"]), pos_int(rec["customer_id"]), pos_int(rec["plan_id"]),
                SUB_STATUS[rec["status"]], bd, ts(rec["started_at"]),
                ts(rec["canceled_at"]) if rec.get("canceled_at") else None, upd]
    if name == "subscription_events":
        eid, created = pos_int(rec["event_id"]), ts(rec["created_at"])
        if eid <= st["last_id"]:
            chk.bad("events: event_id loopt niet op")
        if created < st["last_ts"]:
            chk.bad("events: event_id loopt niet op met created_at")
        st["last_id"], st["last_ts"] = eid, max(created, st["last_ts"])
        if created >= upper:
            return None
        st["kept_id"], st["kept_ts"] = eid, created
        if rec.get("type") not in EVENT_TYPE:
            chk.bad("events: onbekend type")
            return None
        frm, to = rec.get("from_plan_id"), rec.get("to_plan_id")
        if (rec["type"] == "plan_changed" and (frm is None or to is None)) or (rec["type"] == "created" and to is None):
            chk.bad("events: plan ontbreekt")
        return [eid, pos_int(rec["subscription_id"]), EVENT_TYPE[rec["type"]],
                pos_int(frm) if frm is not None else None, pos_int(to) if to is not None else None,
                ts(rec["occurred_at"]), created]
    if name == "invoices":
        iid, issued = pos_int(rec["invoice_id"]), ts(rec["issued_at"])
        if iid <= st["last_id"]:
            chk.bad("invoices: invoice_id loopt niet op")
        if issued < st["last_ts"]:
            chk.bad("invoices: invoice_id loopt niet op met issued_at")
        st["last_id"], st["last_ts"] = iid, max(issued, st["last_ts"])
        if issued >= upper:
            return None
        st["kept_id"], st["kept_ts"] = iid, issued
        status = rec.get("status")
        if status not in INV_STATUS:
            chk.bad("invoices: status niet paid/failed")
            return None
        paid_at = ts(rec["paid_at"]) if rec.get("paid_at") else None
        if (status == "paid") != (paid_at is not None):
            chk.bad("invoices: paid_at past niet bij de status")
        amount, vat = rec["amount_excl_vat_cents"], rec["vat_cents"]
        if not isinstance(amount, int) or amount < 0:
            chk.bad("invoices: bedrag geen geheel getal >= 0")
        elif abs(vat - (amount * 9 + 50) // 100) > 1:
            chk.bad("invoices: btw niet 9% (±1 cent)")
        if rec.get("currency") != "EUR":
            chk.bad("invoices: valuta niet EUR")
        ps, pe = day(rec["period_start"]), day(rec["period_end"])
        # Maandabonnement: de periode eindigt (exclusief) in de volgende kalendermaand. De API
        # rekent met de factuurdag van het abonnement (31 jan → 29 feb → 31 mrt).
        if pe <= ps or (pe.year, pe.month) != next_month(ps):
            chk.bad("invoices: period_end niet in de maand na period_start")
        return [paid_at, iid, pos_int(rec["subscription_id"]), pos_int(rec["customer_id"]), amount,
                ps, pe, pos_int(rec["plan_id"]), INV_STATUS[status]]
    raise AssertionError(name)


# ---------------------------------------------------------------------------
# Ophalen
# ---------------------------------------------------------------------------
def fetch(api, name, path, params, st, chk, out_path, max_pages):
    """Pagineert tot has_more = false; schrijft COPY-regels naar out_path. Geeft statistiek terug."""
    sha = hashlib.sha256()
    pages = fetched = kept = 0
    cursor, seen = None, set()
    t0 = time.monotonic()
    with open(out_path, "w", encoding="utf-8", newline="\n") as out:
        while True:
            pages += 1
            body = api.get(path, {**params, "limit": PAGE_SIZE, "cursor": cursor}, pages)
            data = body.get("data")
            if not isinstance(data, list) or not isinstance(body.get("has_more"), bool):
                raise LoadError("api_vorm", f"GET {path} (pagina {pages}): antwoord zonder data/has_more.")
            for rec in data:
                fetched += 1
                try:
                    row = convert(name, rec, st, chk)
                except (KeyError, TypeError, ValueError):
                    chk.bad(f"{name}: veld ontbreekt of heeft een verkeerd type")
                    continue
                if row is None:
                    continue
                kept += 1
                sha.update(json.dumps(rec, sort_keys=True, separators=(",", ":")).encode())
                sha.update(b"\n")
                out.write("\t".join(copy_text(v) for v in row) + "\n")
            if not body["has_more"]:
                break
            nxt = body.get("next_cursor")
            if not nxt or nxt in seen:
                raise LoadError("api_cursor", f"GET {path} (pagina {pages}): has_more zonder nieuwe cursor.")
            seen.add(nxt)
            cursor = nxt
            if max_pages and pages >= max_pages:
                st["truncated"] = True
                break
            if pages % 250 == 0:
                log(f"  {name}: {pages} pagina's, {fetched:,} records")
    return {"pages": pages, "fetched": fetched, "kept": kept, "sha256": sha.hexdigest(),
            "seconds": round(time.monotonic() - t0, 1)}


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def copy_into(cur, temp, path):
    cols = ", ".join(COLUMNS[temp.removeprefix("t_")])
    with cur.copy(f"copy {temp} ({cols}) from stdin") as cp, open(path, "rb") as f:
        while block := f.read(1 << 20):
            cp.write(block)


def merge(cur, table, files):
    """Schrijft de tijdelijke rijen in de doeltabel. Geeft {nieuw, bijgewerkt, ongewijzigd} terug."""
    temp = f"t_{table}"
    cur.execute(f"create temp table {temp} (like ce_private.{table}) on commit drop")
    copy_into(cur, temp, files[table])
    cur.execute(f"select count(*) from {temp}")
    rows = cur.fetchone()[0]
    cols = COLUMNS[table]
    if table in ("bz_plans", "bz_product_costs"):
        # Volledig vervangen; "nieuw" = rijen die er nog niet precies zo stonden.
        cur.execute(f"select count(*) from (select * from {temp} except select * from ce_private.{table}) d")
        new = cur.fetchone()[0]
        cur.execute(f"delete from ce_private.{table}")
        cur.execute(f"insert into ce_private.{table} select * from {temp}")
        return {"rows": rows, "new": new}
    key = KEY[table]
    if table in ("bz_customers", "bz_subscriptions"):
        # Laatste versie per sleutel; bijwerken alleen als er iets veranderde.
        sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c != key)
        diff = f"({', '.join(f'ce_private.{table}.{c}' for c in cols)}) is distinct from " \
               f"({', '.join(f'excluded.{c}' for c in cols)})"
        cur.execute(f"""
            with ins as (
              insert into ce_private.{table}
              select distinct on ({key}) * from {temp} order by {key}, updated_at desc
              on conflict ({key}) do update set {sets} where {diff}
              returning (xmax = 0) as inserted)
            select count(*) filter (where inserted), count(*) filter (where not inserted) from ins""")
        new, updated = cur.fetchone()
        cur.execute(f"select count(distinct {key}) from {temp}")
        return {"rows": rows, "new": new, "updated": updated, "unchanged": cur.fetchone()[0] - new - updated}
    # Events en facturen veranderen nooit: elke sleutel mag maar één keer voorkomen.
    cur.execute(f"select count(*) - count(distinct {key}) from {temp}")
    if cur.fetchone()[0]:
        raise LoadError("contract", f"{table}: dezelfde sleutel meerdere keren geleverd.")
    cur.execute(f"select count(*) from {temp} t join ce_private.{table} b using ({key})")
    if cur.fetchone()[0]:
        raise LoadError("contract", f"{table}: een bestaande rij opnieuw geleverd (veranderen nooit).")
    cur.execute(f"insert into ce_private.{table} select * from {temp}")
    return {"rows": rows, "new": rows}


# Controles op de hele tabellen na het samenvoegen: elke query telt overtredingen.
TABLE_CHECKS = [
    ("factuur → onbekend abonnement",
     "select count(*) from ce_private.bz_invoices i left join ce_private.bz_subscriptions s "
     "using (subscription_id) where s.subscription_id is null"),
    ("factuur → onbekende klant",
     "select count(*) from ce_private.bz_invoices i left join ce_private.bz_customers c "
     "using (customer_id) where c.customer_id is null"),
    ("factuur → klant wijkt af van abonnement",
     "select count(*) from ce_private.bz_invoices i join ce_private.bz_subscriptions s "
     "using (subscription_id) where s.customer_id <> i.customer_id"),
    ("factuur → onbekend plan",
     "select count(*) from ce_private.bz_invoices where plan_id not in (select plan_id from ce_private.bz_plans)"),
    ("abonnement → onbekende klant",
     "select count(*) from ce_private.bz_subscriptions s left join ce_private.bz_customers c "
     "using (customer_id) where c.customer_id is null"),
    ("abonnement → onbekend plan",
     "select count(*) from ce_private.bz_subscriptions where plan_id not in (select plan_id from ce_private.bz_plans)"),
    ("event → onbekend abonnement",
     "select count(*) from ce_private.bz_subscription_events e left join ce_private.bz_subscriptions s "
     "using (subscription_id) where s.subscription_id is null"),
    ("event → onbekend plan",
     "select count(*) from ce_private.bz_subscription_events where "
     "(from_plan_id is not null and from_plan_id not in (select plan_id from ce_private.bz_plans)) or "
     "(to_plan_id is not null and to_plan_id not in (select plan_id from ce_private.bz_plans))"),
    ("plans: size_grams niet uniek",
     "select count(*) - count(distinct size_grams) from (select distinct plan_id, size_grams from ce_private.bz_plans) p"),
    ("kostprijzen: gat of overlap per plan",
     "select count(*) from (select valid_to, lead(valid_from) over (partition by plan_id order by valid_from) nxt "
     "from ce_private.bz_product_costs) c where nxt is not null and (valid_to is null or valid_to <> nxt)"),
    ("kostprijs ontbreekt op een period_start",
     "select count(*) from (select plan_id, min(period_start) lo, max(period_start) hi "
     "from ce_private.bz_invoices group by plan_id) i "
     "left join (select plan_id, min(valid_from) f, bool_or(valid_to is null) open, max(valid_to) t "
     "from ce_private.bz_product_costs group by plan_id) c using (plan_id) "
     "where c.plan_id is null or c.f > i.lo or (not c.open and c.t <= i.hi)"),
    ("twee betaalde facturen voor dezelfde periode",
     "select count(*) from (select 1 from ce_private.bz_invoices where status = 1 "
     "group by subscription_id, period_start having count(*) > 1) d"),
    ("betaalde perioden van een abonnement overlappen",
     "select count(*) from (select period_start, lag(period_end) over "
     "(partition by subscription_id order by period_start) prev_end "
     "from ce_private.bz_invoices where status = 1) p where prev_end > period_start"),
]


def counts_check(cur, status_counts, partial):
    """Aantal rijen per tabel tegen /v1/status. Geeft [(endpoint, tabel, api)] terug."""
    out = []
    for name, _, _, table in ENDPOINTS:
        cur.execute(f"select count(*) from ce_private.{table}")
        out.append((name, cur.fetchone()[0], status_counts.get(name)))
    return out


def last_complete(cur):
    cur.execute("""select load_id, as_of, endpoints from ce_private.loads
                   where status = 'complete' order by load_id desc limit 1""")
    return cur.fetchone()


def record_failure(started, as_of, endpoints, checks, error):
    try:
        with connect("CE_LOADER_DB_URL") as conn, conn.cursor() as cur:
            cur.execute("""insert into ce_private.loads
                             (started_at, status, as_of, endpoints, checks, error, git_sha, run_id)
                           values (%s, 'failed', %s, %s, %s, %s, %s, %s)""",
                        (started, as_of, json.dumps(endpoints), json.dumps(checks), error,
                         os.environ.get("GITHUB_SHA"), os.environ.get("GITHUB_RUN_ID")))
    except Exception as e:  # noqa: BLE001 - alleen melden, nooit de oorspronkelijke fout maskeren
        log(f"  (mislukte lading niet geregistreerd: {type(e).__name__})")


def summary(lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")


def mb(n):
    return f"{n / 1000 ** 2:,.1f} MB"


# ---------------------------------------------------------------------------
def run(args):
    started = datetime.now(timezone.utc)
    t0 = time.monotonic()
    api = Api(require("BEANRISE_API_URL"), require("BEANRISE_API_KEY"))
    endpoints, checks, as_of = {}, [], None
    try:
        with connect("CE_LOADER_DB_URL") as conn:
            with conn.cursor() as cur:
                prev = last_complete(cur)
            conn.rollback()
            prev_ep = prev[2] if prev else {}
            prev_as_of = prev[1] if prev else None

            status = api.get("/v1/status", {}, 1)
            as_of = day(status["as_of"])
            status_counts = status["counts"]
            if prev_as_of and as_of < prev_as_of:
                raise LoadError("as_of", f"as_of ({as_of}) ligt vóór de vorige lading ({prev_as_of}).")
            upper = datetime(as_of.year, as_of.month, as_of.day, tzinfo=timezone.utc) + timedelta(days=1)
            log(f"as_of {as_of} · vorige geslaagde lading: "
                f"{'#' + str(prev[0]) + ' (as_of ' + str(prev_as_of) + ')' if prev else 'geen (eerste volledige lading)'}")

            chk = Checker()
            with tempfile.TemporaryDirectory(dir=os.environ.get("RUNNER_TEMP")) as tmp:
                files = {}
                for name, path, mode, table in ENDPOINTS:
                    pe = prev_ep.get(name, {})
                    st = {"upper": upper, "last_id": pe.get("max_id", 0),
                          "last_ts": datetime.fromisoformat(pe["max_ts"]) if pe.get("max_ts")
                          else datetime.min.replace(tzinfo=timezone.utc)}
                    params = {}
                    if mode == "after_id" and pe.get("max_id"):
                        params["after_id"] = pe["max_id"]
                    if mode == "updated" and prev_as_of:
                        params["updated_since"] = prev_as_of.isoformat()
                    files[table] = Path(tmp) / f"{table}.tsv"
                    stats = fetch(api, name, path, params, st, chk, files[table], args.max_pages)
                    stats["watermark_from"] = params.get("after_id") or params.get("updated_since")
                    if mode == "after_id":
                        # Watermerk = laatste record dat in deze lading is opgenomen (niet na as_of).
                        stats["max_id"] = st["kept_id"] if stats["kept"] else pe.get("max_id", 0)
                        stats["max_ts"] = st["kept_ts"].isoformat() if stats["kept"] else pe.get("max_ts")
                    endpoints[name] = stats
                    log(f"  {name:<20} {stats['pages']:>5} pagina's  {stats['kept']:>9,} records  {stats['seconds']:>6} s")
                if chk.fail:
                    checks = [{"check": k, "violations": v} for k, v in sorted(chk.fail.items())]
                    raise LoadError("controles", "controles op de records mislukt", checks)

                fetch_s = time.monotonic() - t0
                t_db = time.monotonic()
                with conn.cursor() as cur:
                    for name, _, _, table in ENDPOINTS:
                        endpoints[name].update(merge(cur, table, files))
                    for label, sql in TABLE_CHECKS:
                        cur.execute(sql)
                        checks.append({"check": label, "violations": cur.fetchone()[0]})
                    for name, in_db, in_api in counts_check(cur, status_counts, args.max_pages):
                        endpoints[name]["table_rows"], endpoints[name]["status_count"] = in_db, in_api
                        checks.append({"check": f"aantal {name} = /v1/status", "violations": abs(in_db - (in_api or 0))
                                       if in_api is not None else 1})
                    cur.execute("select pg_database_size(current_database())")
                    db_bytes = cur.fetchone()[0]
                    failed = [c for c in checks if c["violations"]]
                    if failed:
                        raise LoadError("controles", f"{len(failed)} controle(s) op de tabellen mislukt", checks)
                    traffic = {"requests": api.requests, "wire_bytes": api.wire_bytes, "json_bytes": api.json_bytes}
                    cur.execute("""insert into ce_private.loads
                                     (started_at, status, as_of, endpoints, checks, db_bytes, git_sha, run_id)
                                   values (%s, 'complete', %s, %s, %s, %s, %s, %s) returning load_id""",
                                (started, as_of, json.dumps({**endpoints, "_traffic": traffic}),
                                 json.dumps(checks), db_bytes, os.environ.get("GITHUB_SHA"),
                                 os.environ.get("GITHUB_RUN_ID")))
                    load_id = cur.fetchone()[0]
                if args.dry_run:
                    conn.rollback()
                    log("\n--dry-run: alles teruggedraaid.")
                else:
                    conn.commit()
                db_s = time.monotonic() - t_db
    except LoadError as e:
        if e.checks:
            for c in e.checks:
                if c["violations"]:
                    log(f"  FOUT  {c['check']}: {c['violations']:,}")
        log(f"\n✖ Lading mislukt ({e.code}): {e.message} Niets geschreven; watermerken ongewijzigd.")
        if not args.dry_run:
            record_failure(started, as_of, endpoints, e.checks, f"{e.code}: {e.message}")
        return 1

    total_s = time.monotonic() - t0
    log("\nControles")
    for c in checks:
        log(f"  {'OK  ' if not c['violations'] else 'FOUT'} {c['check']}")
    log(f"\nRijen per tabel (tabel / /v1/status) en nieuw in deze lading")
    lines = ["### Beanrise-lading", "", f"as_of **{as_of}**, lading #{load_id}", "",
             "| endpoint | tabel | /v1/status | nieuw | bijgewerkt |", "|---|---:|---:|---:|---:|"]
    for name, *_ in ENDPOINTS:
        s = endpoints[name]
        new = s.get("new", 0)
        log(f"  {name:<20} {s['table_rows']:>10,} / {s['status_count']:>10,}   nieuw {new:>9,}   "
            f"bijgewerkt {s.get('updated', 0):>6,}")
        lines.append(f"| {name} | {s['table_rows']:,} | {s['status_count']:,} | {new:,} | {s.get('updated', 0):,} |")
    log(f"\nDuur: {total_s:,.0f} s (ophalen {fetch_s:,.0f} s, database {db_s:,.0f} s)")
    log(f"Dataverkeer: {api.requests:,} verzoeken, {mb(api.wire_bytes)} over de lijn (gzip), "
        f"{mb(api.json_bytes)} JSON uitgepakt")
    log(f"Database: {mb(db_bytes)}")
    lines += ["", f"Duur {total_s:,.0f} s · {api.requests:,} verzoeken · {mb(api.wire_bytes)} (gzip) · "
                  f"database {mb(db_bytes)}"]
    if db_bytes > WARN_DB_BYTES:
        msg = f"Database {mb(db_bytes)}: boven 450 MB (grens 500 MB)."
        log(f"::warning::{msg}" if IN_CI else f"WAARSCHUWING: {msg}")
        lines.append(f"\n**Waarschuwing:** {msg}")
    if not args.dry_run:
        summary(lines)
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dry-run", action="store_true", help="alles doen, maar terugdraaien")
    p.add_argument("--max-pages", type=int, default=0, help="test: hoogstens zoveel pagina's per endpoint")
    args = p.parse_args()
    if args.max_pages and not args.dry_run:
        sys.exit("--max-pages kan alleen met --dry-run.")
    try:
        sys.exit(run(args))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        # Geen foutmelding met inhoud (kan URL of data bevatten): alleen type en plaats.
        primary = getattr(getattr(e, "diag", None), "message_primary", None)
        log(f"\n✖ Onverwachte fout: {type(e).__name__}{': ' + primary if primary else ''}")
        log("".join(traceback.format_tb(e.__traceback__)))
        sys.exit(1)


if __name__ == "__main__":
    main()
