"""Validatie van het sBG-model op een holdout (docs/ontwerp-dashboard-v3.md §1.1 en §1.2).

T = laatste kwartaaleinde waarna nog 24 maanden afgesloten kwartalen volgen. Schat op de data
zoals bekend op T; voorspel voor alle klanten die op T actief zijn de 24 maanden daarna.

  V1a  holdout overleving: voorspeld tegen werkelijk aantal klanten met factuur n+h, h = 1..24;
       grootste maandfout totaal ≤ 1,5%, per startabonnement en voor de groep eerste ≤ 3%.
       Terugkerende klanten: apart gerapporteerd, niet getoetst (besluit 11 nov 2026).
  V1b  holdout gerealiseerde marge: verdisconteerde marge per maand over factuur n+1..n+24,
       gewaardeerd tegen de 12-maandsmarge per abonnement op T; fout over 24 maanden totaal ≤ 2%,
       per abonnement ≤ 3%. Varianten: marge van het huidige abonnement / met overstappen.
  Intervallen (95%, per maand) zijn diagnose: ze worden gerapporteerd, niet getoetst.
  V2   tegen de oude methode (vaste retentie: 1 − gemiddelde churn van de 4 kwartalen t/m T):
       gemiddelde absolute fout van sBG kleiner, totaal en per segment.
  V3   kalibratie per klantduur × startabonnement, na 3 en 12 maanden: cellen met ≥ 200 klanten
       binnen het 95%-binomiale interval of ≤ 2 procentpunt; ≥ 90% van de cellen.
  V4   convergentie van elke fit.

Beslisregels: kies het eenvoudigste model dat V1a en V3 haalt; een ingewikkelder model wint
alleen als zijn holdout-log-likelihood meer dan 2 × (extra parameters) hoger is. Marge: de marge
van het huidige abonnement, tenzij die V1b per abonnement niet haalt en de variant met
overstappen wel. Het advies wordt vergeleken met ce_private.settings_v2; een verschil laat de
validatie falen (de keuze wijzigen is een besluit, geen automatisme).

Alleen lezen, behalve met --save (rij in ce_private.validation_runs). Exitcode 1 als een toets
of het advies afwijkt. Drukt alleen aantallen en uitkomsten af.

Draaien:  .venv/bin/python scripts/validate_holdout.py [--save]
"""

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbg  # noqa: E402
from env import connect  # noqa: E402

H = 24
DRAWS = 200
MAX_OUTSIDE = 0.10          # alleen voor de diagnose: 10% van de maanden buiten het 95%-interval
PLAN_NAMES = {}

# Modellen in volgorde van eenvoud: segment per (groep, startabonnement, huidig abonnement).
MODELS = [
    (code, label, k, setting, (lambda st: lambda g, sp, cp: sbg.segment_key(st[0], st[1], g, sp))(setting))
    for code, label, k, setting in [
        ("A", "alles samen", 2, ("pooled", "pooled")),
        ("B", "terugkeerders apart", 4, ("pooled", "separate")),
        ("C", "per startabonnement", 6, ("start_plan", "pooled")),
        ("D", "per startabonnement, terugkeerders apart", 8, ("start_plan", "separate")),
    ]
]
COMPARE = ("E", "per huidig abonnement (alleen vergelijking)", 6, None, lambda g, sp, cp: cp)
BANDS = [(1, 3), (4, 6), (7, 12), (13, 24), (25, 36), (37, 60), (61, 10_000)]


def q(cur, sql, params=None):
    cur.execute(sql, params or {})
    return cur.fetchall()


def load(cur):
    s = q(cur, "select horizon_months, discount_rate_year, segmentation, returners, margin_method, "
               "holdout_months from ce_private.settings_v2")[0]
    hold = s[5]
    last_qe = q(cur, "select max(qe) from ce_private.v_bz_quarters")[0][0]
    T = q(cur, """select max(qe) from ce_private.v_bz_quarters
                  where (qe + make_interval(months => %(h)s))::date <= %(last)s
                    and extract(month from qe + 1) in (1, 4, 7, 10)""", {"h": hold, "last": last_qe})[0][0]
    as_of = q(cur, "select as_of from ce_private.loads where status = 'complete' order by load_id desc limit 1")[0][0]
    delta = (1 + s[1]) ** (-1 / 12)
    fit_rows = np.array(q(cur, """select grp, start_plan, cur_plan, n, churned::int, customers
                                   from ce_private.sbg_input where qe = %(T)s""", {"T": T}), dtype=float)
    margins = dict(q(cur, "select plan_id, margin_eur from ce_private.mv_bz_plan_money where qe = %(T)s", {"T": T}))
    switch = q(cur, "select from_plan, to_plan, p_month from ce_private.v_bz_switch where qe = %(T)s", {"T": T})
    g = q(cur, "select g from ce_private.mv_bz_late where qe = %(T)s", {"T": T})[0][0]
    for pid, size in q(cur, "select distinct plan_id, size_grams from ce_private.bz_plans"):
        PLAN_NAMES[pid] = f"{size} g" if size < 1000 else f"{size // 1000} kg"
    # Cohort: actief op T, met de uitkomst daarna (j extra facturen, max. 24) en de gerealiseerde
    # marge (factuur n+1..n+24, verdisconteerd naar T, tegen de marge per abonnement op T).
    cohort = np.array(q(cur, """
        with st as (select * from ce_private.mv_bz_state where qe = %(T)s),
             m  as (select plan_id, margin_eur from ce_private.mv_bz_plan_money where qe = %(T)s),
             fut as (
               select st.customer_id, st.spell_no,
                      sum(power(%(d)s, (v.k - st.n)::double precision) * m.margin_eur) as realized
               from st
               join ce_private.v_bz_paid v
                 on v.customer_id = st.customer_id and v.spell_no = st.spell_no
                and v.k > st.n and v.k <= st.n + %(H)s
               join m on m.plan_id = v.plan_id
               group by 1, 2)
        select st.returning::int + 1, st.start_plan, st.plan_id, st.n, st.paid_through::int,
               least(sp.n_total - st.n, %(H)s), (sp.spell_end <= %(asof)s)::int,
               count(*), coalesce(sum(f.realized), 0)
        from st
        join ce_private.mv_bz_spells sp using (customer_id, spell_no)
        left join fut f using (customer_id, spell_no)
        group by 1, 2, 3, 4, 5, 6, 7""", {"T": T, "d": delta, "H": H, "asof": as_of}), dtype=float)
    # Gerealiseerde marge per maand h (factuur n+h), per cohortgroep, tegen de marge op T.
    real_h = q(cur, """
        with st as (select * from ce_private.mv_bz_state where qe = %(T)s),
             m  as (select plan_id, margin_eur from ce_private.mv_bz_plan_money where qe = %(T)s)
        select st.returning::int + 1, st.start_plan, st.plan_id, st.n, st.paid_through::int,
               least(sp.n_total - st.n, %(H)s), (sp.spell_end <= %(asof)s)::int, v.k - st.n,
               sum(power(%(d)s, (v.k - st.n)::double precision) * m.margin_eur)
        from st
        join ce_private.mv_bz_spells sp using (customer_id, spell_no)
        join ce_private.v_bz_paid v
          on v.customer_id = st.customer_id and v.spell_no = st.spell_no
         and v.k > st.n and v.k <= st.n + %(H)s
        join m on m.plan_id = v.plan_id
        group by 1, 2, 3, 4, 5, 6, 7, 8""", {"T": T, "d": delta, "H": H, "asof": as_of})
    # Oude methode: churn% (churn ÷ actief begin) van de 4 kwartalen t/m T.
    rates = q(cur, """select sum(customers) filter (where flow = 'L')::double precision
                             / sum(customers) filter (where flow in ('S', 'L'))
                      from ce_private.mv_bz_pairs where qe <= %(T)s and qe > (%(T)s - interval '12 months')
                      group by qe""", {"T": T})
    return {"T": T, "as_of": as_of, "last_qe": last_qe, "delta": delta, "settings": s, "fit": fit_rows,
            "margins": margins, "switch": switch, "g": g, "cohort": cohort, "real_h": real_h,
            "old_rate_q": float(np.mean([r[0] for r in rates]))}


def fit_model(fn, rows):
    keys = np.array([fn(int(g), int(sp), int(cp)) for g, sp, cp in rows[:, :3]])
    fits = {}
    for k in np.unique(keys):
        r = rows[keys == k]
        fits[int(k)] = sbg.fit(r[:, 3], r[:, 4].astype(bool), r[:, 5])
    return fits


def margin_path(d):
    """M_k(t) voor t = 1..H: verwachte marge per factuur t maanden vooruit, per huidig abonnement."""
    plans = sorted(d["margins"])
    idx = {p: i for i, p in enumerate(plans)}
    P = np.eye(len(plans)) * 0
    for f, t, p in d["switch"]:
        P[idx[f], idx[t]] = p
    m = np.array([d["margins"][p] for p in plans])
    out, v = {}, np.eye(len(plans))
    for t in range(1, H + 1):
        v = v @ P
        for p in plans:
            out.setdefault(p, []).append(float(v[idx[p]] @ m))
    return {p: np.array(x) for p, x in out.items()}


def evaluate(d, fn, fits, rng):
    """Voorspellingen op het cohort voor één model, met bootstrap over de parameters."""
    c = d["cohort"]
    known = ~((c[:, 6] == 0) & (c[:, 5] < H))          # uitkomst bekend (afgelopen of 24 extra facturen)
    c = c[known]
    grp, sp, cp, n, pt, j, ended, w, real = c.T
    pos = {tuple(int(x) for x in row[:7]): i for i, row in enumerate(c)}
    real_h = np.zeros((len(c), H))
    for row in d["real_h"]:
        i = pos.get(tuple(int(x) for x in row[:7]))
        if i is not None:
            real_h[i, int(row[7]) - 1] += row[8]
    keys = np.array([fn(int(a), int(b), int(e)) for a, b, e in zip(grp, sp, cp)])
    gfac = np.where(pt == 1, 1.0, d["g"])
    h = np.arange(1, H + 1)
    disc = d["delta"] ** h
    mcur = np.array([d["margins"][int(p)] for p in cp])
    mpath = margin_path(d)
    msw = np.array([mpath[int(p)] for p in cp])                      # rijen × H

    def pred(params):
        S = np.empty((len(c), H))
        for k, (a, b) in params.items():
            sel = keys == k
            S[sel] = sbg.surv(a, b, n[sel][:, None], h[None, :])
        return S * gfac[:, None]

    point = {k: (f["alpha"], f["beta"]) for k, f in fits.items()}
    S = pred(point)
    draws = []
    for _ in range(DRAWS):
        p = {}
        for k, f in fits.items():
            x = rng.multivariate_normal(f["x"], f["cov"])
            p[k] = tuple(np.exp(x))
        draws.append(pred(p))
    draws = np.array(draws)                                           # draws × rijen × H
    groups = {"totaal": np.ones(len(c), bool)}
    for p in sorted(set(sp.astype(int))):
        groups[f"start {PLAN_NAMES[p]}"] = sp == p
    groups["groep eerste"] = grp == 1
    groups["groep terugkeer"] = grp == 2
    pgroups = {"totaal": np.ones(len(c), bool)}
    for p in sorted(set(cp.astype(int))):
        pgroups[f"huidig {PLAN_NAMES[p]}"] = cp == p
    return {"c": c, "S": S, "draws": draws, "w": w, "j": j, "ended": ended, "n": n, "sp": sp, "cp": cp,
            "pt": pt, "real": real, "real_h": real_h, "disc": disc, "mcur": mcur, "msw": msw, "groups": groups,
            "pgroups": pgroups, "keys": keys, "point": point, "h": h}


def v1a(e, rng):
    out = {}
    for name, sel in e["groups"].items():
        w = e["w"][sel]
        act = np.array([(w * (e["j"][sel] >= hh)).sum() for hh in e["h"]])
        pred = (w[:, None] * e["S"][sel]).sum(0)
        var = (w[:, None] * e["S"][sel] * (1 - e["S"][sel])).sum(0)
        sim = (e["draws"][:, sel] * w[None, :, None]).sum(1) + rng.normal(0, np.sqrt(var), (DRAWS, len(var)))
        lo, hi = np.percentile(sim, [2.5, 97.5], axis=0)
        rel = np.abs(pred - act) / act
        norm = 0.015 if name == "totaal" else 0.03
        outside = int(np.sum((act < lo) | (act > hi)))
        tested = name != "groep terugkeer"
        out[name] = {"customers": float(w.sum()), "max_rel_err": float(rel.max()), "mae_rel": float(rel.mean()),
                     "months_outside": outside, "norm": norm, "tested": tested,
                     "pass": bool(rel.max() <= norm),
                     "actual_24": float(act[-1]), "pred_24": float(pred[-1])}
    return out


def v1b(e, rng, variant):
    """Gerealiseerde marge per maand tegen de voorspelling; fout op het totaal, interval per maand."""
    out = {}
    for name, sel in e["pgroups"].items():
        w, S = e["w"][sel], e["S"][sel]
        M = e["mcur"][sel][:, None] * np.ones(H) if variant == "current" else e["msw"][sel]
        DM = M * e["disc"]                                            # rijen × H
        pred_h = (w[:, None] * S * DM).sum(0)
        act_h = e["real_h"][sel].sum(0)
        pred, act = pred_h.sum(), act_h.sum()
        var_h = (w[:, None] * DM ** 2 * S * (1 - S)).sum(0)
        sim = (e["draws"][:, sel] * DM[None] * w[None, :, None]).sum(1) + rng.normal(0, np.sqrt(var_h), (DRAWS, H))
        lo, hi = np.percentile(sim, [2.5, 97.5], axis=0)
        outside = int(np.sum((act_h < lo) | (act_h > hi)))
        rel = abs(pred - act) / act
        norm = 0.02 if name == "totaal" else 0.03
        out[name] = {"actual_eur": float(act), "pred_eur": float(pred), "rel_err": float(rel),
                     "months_outside": outside, "norm": norm, "pass": bool(rel <= norm)}
    return out


def v2(d, e, sbg_v1a, sbg_v1b):
    """sbg_v1b: de V1b-uitkomsten van de gekozen margemethode."""
    r_m = (1 - d["old_rate_q"]) ** (1 / 3)
    surv_old = r_m ** e["h"]
    out = {}
    for name, sel in e["groups"].items():
        w = e["w"][sel]
        act = np.array([(w * (e["j"][sel] >= hh)).sum() for hh in e["h"]])
        old = w.sum() * surv_old
        mae_old = float(np.mean(np.abs(old - act) / act))
        out[name] = {"mae_sbg": sbg_v1a[name]["mae_rel"], "mae_old": mae_old,
                     "pass": sbg_v1a[name]["mae_rel"] < mae_old}
    for name, sel in e["pgroups"].items():
        if name == "totaal":
            continue
        w = e["w"][sel]
        old = (w * e["mcur"][sel]).sum() * (surv_old * e["disc"]).sum()
        act = e["real"][sel].sum()
        out[f"marge {name}"] = {"err_sbg": sbg_v1b[name]["rel_err"], "err_old": float(abs(old - act) / act),
                                "pass": sbg_v1b[name]["rel_err"] < abs(old - act) / act}
    w = e["w"]
    old = (w * e["mcur"]).sum() * (surv_old * e["disc"]).sum()
    act = e["real"].sum()
    out["marge totaal"] = {"err_sbg": sbg_v1b["totaal"]["rel_err"], "err_old": float(abs(old - act) / act),
                           "pass": sbg_v1b["totaal"]["rel_err"] < abs(old - act) / act}
    return out, float(d["old_rate_q"])


def v3(e):
    cells = []
    for lo, hi in BANDS:
        for p in sorted(set(e["sp"].astype(int))):
            sel = (e["n"] >= lo) & (e["n"] <= hi) & (e["sp"] == p)
            N = e["w"][sel].sum()
            if N < 200:
                continue
            for hh in (3, 12):
                pred = float((e["w"][sel] * e["S"][sel][:, hh - 1]).sum() / N)
                obs = float((e["w"][sel] * (e["j"][sel] >= hh)).sum() / N)
                tol = max(1.96 * np.sqrt(pred * (1 - pred) / N), 0.02)
                cells.append({"band": f"{lo}-{hi if hi < 10_000 else '+'}", "start": PLAN_NAMES[p], "months": hh,
                              "customers": int(N), "pred": pred, "obs": obs, "pass": bool(abs(obs - pred) <= tol)})
    share = float(np.mean([c["pass"] for c in cells])) if cells else 0.0
    return {"cells": cells, "share_pass": share, "pass": share >= 0.9}


def holdout_ll(e):
    """Log-likelihood van de uitkomsten na T (alleen klanten die betaald hebben t/m T)."""
    ll = 0.0
    sel = e["pt"] == 1
    for k, (a, b) in e["point"].items():
        s = sel & (e["keys"] == k)
        n, j, w, ended = e["n"][s], e["j"][s], e["w"][s], e["ended"][s]
        churn = (ended == 1) & (j < H)
        p = np.where(churn, sbg.churn_prob(a, b, n, j), sbg.surv(a, b, n, j))
        ll += float((w * np.log(p)).sum())
    return ll


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(20261110)
    with connect("CE_LOADER_DB_URL") as conn, conn.cursor() as cur:
        d = load(cur)
    print(f"Holdout: schatten t/m {d['T']}, voorspellen t/m {d['T'].replace(year=d['T'].year + 2)} "
          f"(as_of {d['as_of']}); cohort {int(d['cohort'][:, 7].sum()):,} klanten; g op T {d['g']:.3f}")
    res = {"T": d["T"].isoformat(), "as_of": d["as_of"].isoformat(), "models": {}}
    evals = {}
    for code, label, k, setting, fn in MODELS + [COMPARE]:
        fits = fit_model(fn, d["fit"])
        e = evaluate(d, fn, fits, rng)
        r = {"label": label, "params": k, "setting": setting,
             "fits": {str(s): {"alpha": f["alpha"], "beta": f["beta"], "converged": f["converged"],
                               "checks": f["checks"], "customers": f["customers"]} for s, f in fits.items()},
             "V4": all(f["converged"] for f in fits.values()),
             "V1a": v1a(e, rng), "V1b_current": v1b(e, rng, "current"),
             "V1b_switching": v1b(e, rng, "switching"), "V3": v3(e), "holdout_ll": holdout_ll(e)}
        r["V2"], old_rate = v2(d, e, r["V1a"], r["V1b_current"])
        evals[code] = e
        r["passes"] = all(x["pass"] for x in r["V1a"].values() if x["tested"]) and r["V3"]["pass"] and r["V4"]
        res["models"][code] = r
        print(f"\n{code} {label}: V4 {'OK' if r['V4'] else 'FOUT'}, V1a "
              f"{'OK' if all(x['pass'] for x in r['V1a'].values() if x['tested']) else 'FOUT'}, V3 {r['V3']['share_pass']:.0%}, "
              f"holdout-LL {r['holdout_ll']:,.1f}")
        for s, f in r["fits"].items():
            print(f"    segment {s}: α {f['alpha']:.4f}  β {f['beta']:.3f}  ({f['customers']:,.0f} klantperioden)")
        for g, x in r["V1a"].items():
            print(f"    V1a {g:<16} max {x['max_rel_err']:.2%} (norm {x['norm']:.1%}), gem {x['mae_rel']:.2%}, "
                  f"{x['months_outside']} mnd buiten interval (diagnose)"
                  f"  {('OK' if x['pass'] else 'FOUT') if x['tested'] else ('apart: ' + ('binnen norm' if x['pass'] else 'boven norm'))}")
    res["old_rate_q"] = old_rate

    # Beslisregel segmenten en terugkeerders
    order = [m[0] for m in MODELS]
    passing = [m for m in order if res["models"][m]["passes"]]
    choice = passing[0] if passing else max(order, key=lambda m: res["models"][m]["holdout_ll"])
    for m in order[order.index(choice) + 1:]:
        mm, cc = res["models"][m], res["models"][choice]
        if mm["passes"] and mm["holdout_ll"] - cc["holdout_ll"] > 2 * (mm["params"] - cc["params"]):
            choice = m
    ch = res["models"][choice]
    # Marge
    cur_ok = all(x["pass"] for x in ch["V1b_current"].values())
    sw_ok = all(x["pass"] for x in ch["V1b_switching"].values())
    margin = "switching" if (not cur_ok and sw_ok) else "current"
    advice = {"model": choice, "segmentation": ch["setting"][0], "returners": ch["setting"][1],
              "margin_method": margin}
    ch["V2"], _ = v2(d, evals[choice], ch["V1a"], ch[f"V1b_{margin}"])
    res["advice"] = advice
    seg, ret, mm_ = d["settings"][2], d["settings"][3], d["settings"][4]
    res["matches_settings"] = (seg, ret, mm_) == (advice["segmentation"], advice["returners"], margin)

    print(f"\nAdvies: model {choice} ({ch['label']}), marge '{margin}'. "
          f"Instelling nu: {seg}/{ret}/{mm_} → {'gelijk' if res['matches_settings'] else 'WIJKT AF'}")
    print("V1b gerealiseerde marge (gekozen model):")
    for variant in ("current", "switching"):
        for g, x in ch[f"V1b_{variant}"].items():
            print(f"    {variant:<9} {g:<12} werkelijk €{x['actual_eur']:,.0f}  voorspeld €{x['pred_eur']:,.0f}  "
                  f"fout {x['rel_err']:.2%} (norm {x['norm']:.0%}), {x['months_outside']} mnd buiten interval (diagnose)  "
                  f"{'OK' if x['pass'] else 'FOUT'}")
    print(f"V2 tegen de oude methode (vaste retentie {1 - old_rate:.2%} per kwartaal):")
    for g, x in ch["V2"].items():
        a, b = (x.get("mae_sbg"), x.get("mae_old")) if "mae_sbg" in x else (x["err_sbg"], x["err_old"])
        print(f"    {g:<20} sBG {a:.2%}  oud {b:.2%}  {'OK' if x['pass'] else 'FOUT'}")
    print(f"V3 kalibratie: {ch['V3']['share_pass']:.0%} van {len(ch['V3']['cells'])} cellen binnen de norm "
          f"{'OK' if ch['V3']['pass'] else 'FOUT'}")
    for cell in ch["V3"]["cells"]:
        if not cell["pass"]:
            print(f"    buiten norm: {cell['band']} mnd, start {cell['start']}, na {cell['months']} mnd: "
                  f"voorspeld {cell['pred']:.1%}, werkelijk {cell['obs']:.1%} ({cell['customers']:,})")
    ret_note = {("A", "B"), ("C", "D")}
    pair = next((p for p in ret_note if choice in p), None)
    if pair:
        a, b = res["models"][pair[0]], res["models"][pair[1]]
        dll = b["holdout_ll"] - a["holdout_ll"]
        print(f"Terugkeerders apart ({pair[1]} t.o.v. {pair[0]}): holdout-LL +{dll:,.1f} bij 2 extra parameters; "
              f"V1a terugkeer {a['V1a']['groep terugkeer']['max_rel_err']:.2%} → "
              f"{b['V1a']['groep terugkeer']['max_rel_err']:.2%}: "
              f"{'maakt verschil' if dll > 4 else 'maakt geen wezenlijk verschil'}.")
        res["returners_note"] = {"delta_ll": dll, "v1a_pooled": a["V1a"]["groep terugkeer"]["max_rel_err"],
                                 "v1a_separate": b["V1a"]["groep terugkeer"]["max_rel_err"]}

    # De job faalt alleen bij een overschreden foutnorm (V1a, V1b van de gekozen margemethode,
    # V3) of bij een fit die niet convergeert (V4). V2 en het advies worden gerapporteerd.
    ok = ch["passes"] and all(x["pass"] for x in ch[f"V1b_{margin}"].values())
    if not res["matches_settings"]:
        print("Let op: het advies wijkt af van ce_private.settings_v2 (rapportage, geen fout).")
    if not all(x["pass"] for x in ch["V2"].values()):
        print("Let op: V2 niet overal beter dan de oude methode (rapportage, geen fout).")
    res["pass"] = bool(ok)
    if args.save:
        with connect("CE_LOADER_DB_URL") as conn, conn.cursor() as cur:
            cur.execute("""insert into ce_private.validation_runs (T, as_of, pass, advice, results, git_sha, run_id)
                           values (%s, %s, %s, %s, %s, %s, %s)""",
                        (d["T"], d["as_of"], ok, json.dumps(advice), json.dumps(res, default=float),
                         os.environ.get("GITHUB_SHA"), os.environ.get("GITHUB_RUN_ID")))
    print(f"\nValidatie {'geslaagd' if ok else 'NIET geslaagd'}.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
