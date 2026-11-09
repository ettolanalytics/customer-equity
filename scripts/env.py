"""Leest .env.local (KEY=waarde) als die bestaat; echte omgevingsvariabelen gaan voor.
Gedeeld door de lokale scripts die met Supabase praten. Drukt nooit waarden af."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    path = ROOT / ".env.local"
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def connect(name, **kwargs):
    """Verbindt met de database-URL uit `name`. Foutmeldingen worden nooit met de
    URL of een deel ervan getoond (psycopg citeert anders het wachtwoord)."""
    import psycopg
    url = require(name)
    try:
        return psycopg.connect(url, **kwargs)
    except psycopg.ProgrammingError:
        raise SystemExit(f"{name} is geen geldige URL. Bevat het wachtwoord tekens als % ^ @ / ? # of :? "
                         "Kies een wachtwoord met alleen letters en cijfers.") from None
    except psycopg.OperationalError as e:
        kind = "inloggen mislukt" if "password" in str(e).lower() or "authentication" in str(e).lower() \
            else "verbinding mislukt"
        raise SystemExit(f"{name}: {kind}. Controleer gebruiker, wachtwoord en host in .env.local.") from None


def require(name):
    load_env()
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} ontbreekt (zet hem in .env.local). Zie supabase/README.md.")
    return value
