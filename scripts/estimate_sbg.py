"""Schat het sBG-model per kwartaaleinde en publiceert naar ce_public.quarters_v2 (nog niet live).

Stap in de dagelijkse Action, na het ophalen (scripts/ingest_beanrise.py):
  1. ce_private.refresh_v2_base(): klantperioden, toestand per kwartaal, stroom, marge, invoer
  2. per kwartaaleinde vanaf first_param_quarter en per segment (settings_v2: segmentatie en
     terugkeerders) α en β schatten op de data zoals bekend op dat kwartaaleinde
  3. run en parameters in ce_private.sbg_runs / sbg_params (één transactie)
  4. ce_private.publish_v2(): DERL, CLV, waterfall, controles, publiceren — alleen als alle fits
     convergeren (V4). Anders: run 'failed', niets gepubliceerd, exitcode 1.

Drukt alleen aantallen en parameters af.
Draaien:  .venv/bin/python scripts/estimate_sbg.py [--no-publish]
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbg  # noqa: E402
from env import connect  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-publish", action="store_true", help="alleen schatten en opslaan")
    args = ap.parse_args()
    t0 = time.monotonic()
    with connect("CE_LOADER_DB_URL") as conn:
        with conn.cursor() as cur:
            t = time.monotonic()
            cur.execute("select ce_private.refresh_v2_base()")
            conn.commit()
            print(f"refresh_v2_base: {time.monotonic() - t:.0f} s")

            cur.execute("select segmentation, returners, first_param_quarter from ce_private.settings_v2")
            segmentation, returners, first_param = cur.fetchone()
            cur.execute("select max(load_id) from ce_private.loads where status = 'complete'")
            load_id = cur.fetchone()[0]
            cur.execute("""select i.qe, i.grp, i.start_plan, i.n, i.churned::int, i.customers
                           from ce_private.sbg_input i
                           join ce_private.v_bz_quarters q on q.qe = i.qe
                           where q.qs >= %s""", (first_param,))
            rows = cur.fetchall()
        conn.rollback()

        data = defaultdict(list)
        for qe, grp, sp, n, ch, w in rows:
            data[(qe, sbg.segment_key(segmentation, returners, grp, sp))].append((n, ch, w))
        t = time.monotonic()
        fits = {}
        for key in sorted(data):
            a = np.array(data[key], dtype=float)
            fits[key] = sbg.fit(a[:, 0], a[:, 1].astype(bool), a[:, 2])
        fit_s = time.monotonic() - t
        failed = [k for k, f in fits.items() if not f["converged"]]
        status = "failed" if failed else "complete"

        with conn.cursor() as cur:
            cur.execute("""insert into ce_private.sbg_runs
                             (load_id, segmentation, returners, status, fits, failed_fits, seconds, git_sha, gh_run_id)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning run_id""",
                        (load_id, segmentation, returners, status, len(fits), len(failed), round(fit_s, 2),
                         os.environ.get("GITHUB_SHA"), os.environ.get("GITHUB_RUN_ID")))
            run_id = cur.fetchone()[0]
            cur.executemany("""insert into ce_private.sbg_params
                                 (run_id, qe, segment, alpha, beta, var_log_alpha, var_log_beta, cov_log,
                                  loglik, customers, grad, converged, checks)
                               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            [(run_id, qe, seg, f["alpha"], f["beta"],
                              *(None if np.isnan(f["cov"]).any() else float(v)
                                for v in (f["cov"][0, 0], f["cov"][1, 1], f["cov"][0, 1])),
                              f["loglik"], f["customers"], f["grad"], f["converged"],
                              json.dumps({k: bool(v) for k, v in f["checks"].items()}))
                             for (qe, seg), f in fits.items()])
        conn.commit()

        quarters = sorted({k[0] for k in fits})
        print(f"Schatting #{run_id}: {segmentation}/{returners}, {len(quarters)} kwartaaleinden "
              f"({quarters[0]} – {quarters[-1]}), {len(fits)} fits in {fit_s:.1f} s, "
              f"{'alle geconvergeerd' if not failed else str(len(failed)) + ' NIET geconvergeerd'}")
        last = quarters[-1]
        for (qe, seg), f in sorted(fits.items()):
            if qe == last:
                name = {0: "terugkeerders", -1: "samen"}.get(seg, f"startabonnement {seg}")
                se = np.sqrt(np.diag(f["cov"])) if not np.isnan(f["cov"]).any() else [np.nan, np.nan]
                print(f"  {qe} {name:<18} α {f['alpha']:.4f} (se log {se[0]:.3f})  β {f['beta']:.3f} "
                      f"(se log {se[1]:.3f})  {f['customers']:,.0f} klantperioden")
        for k in failed:
            print(f"  NIET geconvergeerd: {k[0]} segment {k[1]}: {fits[k]['checks']}")
        if failed:
            print("✖ Niet gepubliceerd: niet alle fits geconvergeerd (V4).")
            return 1
        if args.no_publish:
            return 0

        with conn.cursor() as cur:
            t = time.monotonic()
            cur.execute("select ce_private.publish_v2()")
            result = cur.fetchone()[0]
            conn.commit()
            print(f"publish_v2: {result} ({time.monotonic() - t:.0f} s)")
            if result != "published":
                cur.execute("""select details from ce_private.refresh_log
                               where message like 'v2:%%' order by id desc limit 1""")
                details = cur.fetchone()[0]
                for d in (details if isinstance(details, list) else [details])[:20]:
                    print(f"  FOUT {d}")
                return 1
    print(f"Totaal {time.monotonic() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
