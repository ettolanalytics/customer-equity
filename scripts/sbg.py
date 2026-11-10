"""Shifted-beta-geometric (sBG), Fader & Hardie (2007), op tellingen per klantduur.

T = aantal betaalde facturen in een klantperiode; θ ~ Beta(α, β) per klant.
  P(T = t) = B(α+1, β+t−1) / B(α, β)      gechurnd na t facturen
  P(T ≥ t) = B(α,   β+t−1) / B(α, β)      nog lopend na t facturen (gecensureerd)
Maximum likelihood over (log α, log β) met L-BFGS-B, analytische gradiënt.

Convergentie (V4), allemaal vereist:
  * drie startpunten komen op hetzelfde optimum: dezelfde log-likelihood (±1e-9 per klant) en
    dezelfde parameters (±0,1%);
  * gradiënt van de log-likelihood per klant (naar log α, log β) kleiner dan 1e-6;
  * Hessiaan (numeriek uit de analytische gradiënt) negatief definiet, dus de covariantie
    positief definiet;
  * niet tegen de grenzen (0,01 en 10.000).
"""

import numpy as np
from scipy.optimize import minimize
from scipy.special import betaln, digamma

LO, HI = np.log(0.01), np.log(10_000.0)
STARTS = [(0.0, 2.0), (-1.0, 3.5), (1.0, 5.0)]   # (log α, log β): α≈1/β≈7, α≈0,4/β≈33, α≈2,7/β≈150


def _ll_grad(x, n, churned, w):
    a, b = np.exp(x)
    ac = np.where(churned, a + 1.0, a)
    bc = b + n - 1.0
    ll = np.sum(w * (betaln(ac, bc) - betaln(a, b)))
    psi_c = digamma(ac + bc)
    da = np.sum(w * (digamma(ac) - psi_c - digamma(a) + digamma(a + b)))
    db = np.sum(w * (digamma(bc) - psi_c - digamma(b) + digamma(a + b)))
    return ll, np.array([da * a, db * b])


def fit(n, churned, w):
    """Schat α, β. Geeft dict met alpha, beta, cov (van log α, log β), loglik, checks."""
    # Vaste invoer, los van de volgorde waarin de rijen binnenkomen: zelfde (n, churn) samenvoegen
    # en sorteren. Zo geeft dezelfde data bit voor bit dezelfde α en β (nodig voor de controle
    # "afgesloten kwartaal ongewijzigd").
    code = np.asarray(n, np.int64) * 2 + np.asarray(churned, np.int64)
    keys, inv = np.unique(code, return_inverse=True)
    w = np.bincount(inv.ravel(), weights=np.asarray(w, float))
    n = (keys // 2).astype(float)
    churned = (keys % 2).astype(bool)
    total = w.sum()
    runs = []
    for x0 in STARTS:
        res = minimize(lambda x: tuple(-v / total for v in _ll_grad(x, n, churned, w)),
                       np.array(x0), jac=True, method="L-BFGS-B", bounds=[(LO, HI), (LO, HI)],
                       options={"ftol": 1e-15, "gtol": 1e-10, "maxiter": 2000})
        runs.append(res)
    best = min(runs, key=lambda r: r.fun)
    x = best.x
    ll, g = _ll_grad(x, n, churned, w)
    eps = 1e-5
    hess = np.zeros((2, 2))
    for i in range(2):
        d = np.zeros(2)
        d[i] = eps
        hess[:, i] = (_ll_grad(x + d, n, churned, w)[1] - _ll_grad(x - d, n, churned, w)[1]) / (2 * eps)
    hess = (hess + hess.T) / 2
    eig = np.linalg.eigvalsh(-hess)
    pd = bool(np.all(eig > 0))
    cov = np.linalg.inv(-hess) if pd else np.full((2, 2), np.nan)
    # Gelijk optimum vanuit alle drie de startpunten. De melding "success" van L-BFGS-B telt niet
    # mee: op het optimum stopt de lijnzoektocht soms met ABNORMAL (rekenprecisie bereikt).
    same = max(abs(r.fun - best.fun) for r in runs) < 1e-9 and \
        max(np.max(np.abs(np.exp(r.x) / np.exp(x) - 1)) for r in runs) < 1e-3
    grad_ok = float(np.max(np.abs(g)) / total) < 1e-6
    bounds_ok = bool(np.all(x > LO + 0.01) and np.all(x < HI - 0.01))
    return {"alpha": float(np.exp(x[0])), "beta": float(np.exp(x[1])), "x": x, "cov": cov,
            "loglik": float(ll), "customers": float(total),
            "grad": float(np.max(np.abs(g)) / total),
            "converged": bool(same and grad_ok and pd and bounds_ok),
            "checks": {"three_starts": same, "gradient": grad_ok, "hessian_pd": pd, "inside_bounds": bounds_ok}}


def segment_key(segmentation, returners, grp, start_plan):
    """Segment van een klantperiode; zelfde regel als ce_private.bz_segment() in SQL.
    0 = terugkeerders (als die apart geschat worden), plan_id = startabonnement, −1 = samen."""
    if returners == "separate" and grp == 2:
        return 0
    if segmentation == "start_plan":
        return start_plan
    return -1


def surv(a, b, n, h):
    """P(T ≥ n+h | T ≥ n): kans dat factuur n+h betaald wordt, gegeven factuur n. Vectoren."""
    n = np.asarray(n, float)
    h = np.asarray(h, float)
    return np.exp(betaln(a, b + n + h - 1.0) - betaln(a, b + n - 1.0))


def churn_prob(a, b, n, j):
    """P(T = n+j | T ≥ n): precies j extra facturen."""
    n = np.asarray(n, float)
    j = np.asarray(j, float)
    return np.exp(betaln(a + 1.0, b + n + j - 1.0) - betaln(a, b + n - 1.0))
