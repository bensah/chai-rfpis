"""The Python half of the rounding parity check.

`round` is a builtin, so there is nothing to lift and nothing to stub — the answers ARE
Python's answers. What this file owns is the CASE SET, and it is chosen rather than
random for a reason: the bug that prompted it is invisible to random sampling.

A uniform random double almost never lands on, or within an ulp of, a decimal tie, so
four million random values found no disagreement at all between `round(x, 3)` and
`Math.round(x * 1000) / 1000`. The live row that broke check-scoring was
0.34*0.35 + 0.18*1.0 + 0.10*0.325 — a sum of HUNDREDTH weights over quarter-ish factors,
which is exactly the shape that lands on ties. So the generated half of this set is built
the way the real scores are, and 5% of it disagrees.

READ ONLY, and it touches no database.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Named cases, each pinning something specific.
NAMED: list[tuple[float, int]] = [
    # THE ROW THAT BROKE check-scoring. The double is 0.36749999999999999334 — below the
    # tie — so round() gives 0.367 while scaling by 1000 lands on exactly 367.5.
    (0.3675, 3),
    # The dyadic ties at three decimals: (2k+1)/2000 is a double only when 125 divides
    # the numerator, which is these eight and nothing else. Here round() keeps the EVEN
    # candidate and JavaScript's toFixed rounds away from zero, so they are the cases a
    # naive toFixed fix would still get wrong.
    (0.0625, 3), (0.1875, 3), (0.3125, 3), (0.4375, 3),
    (0.5625, 3), (0.6875, 3), (0.8125, 3), (0.9375, 3),
    # Ties at zero decimals, where half-to-even is most visible.
    (0.5, 0), (1.5, 0), (2.5, 0), (3.5, 0), (-0.5, 0), (-1.5, 0), (-2.5, 0),
    # Ties at one decimal that are NOT really ties, because the double is not on them.
    (0.05, 1), (0.15, 1), (0.25, 1), (0.35, 1), (2.675, 2),
    # The alignment score's own range and its exact endpoints.
    (0.0, 1), (30.0, 1), (54.45, 1), (54.44999999999999, 1), (100.0, 1), (91.5, 1),
    # Negatives of the live case, zero, and a wider rounding.
    (-0.3675, 3), (0.0, 3), (-0.0, 3), (123.456789, 4), (1.0005, 3),
    # The classic float-sum surprise. Not carried past 15 decimals: pyRound refuses
    # beyond that rather than let toFixed's own limits produce a silent wrong answer, and
    # nothing in this codebase rounds that far.
    (0.1 + 0.2, 1), (0.1 + 0.2, 15),
]


def generated() -> list[tuple[float, int]]:
    """Values shaped like the things this codebase actually rounds.

    The featured score is `0.34*geo + 0.28*theme + 0.18*funder + 0.10*size + 0.10*urgency`
    and the alignment score is a weighted mean of ninths and hundredths. Both produce the
    sums-of-hundredths that land on ties; uniform noise does not.
    """
    random.seed(11)
    out: list[tuple[float, int]] = []
    for _ in range(4000):
        out.append((
            0.34 * random.choice([0, 0.25, 0.35, 0.5, 0.75, 1.0])
            + 0.28 * random.choice([0, 0.25, 0.5, 0.75, 1.0])
            + 0.18 * random.choice([0, 1.0])
            + 0.10 * random.choice([0, 0.325, 0.5, 1.0])
            + 0.10 * random.choice([0, 0.325, 0.8, 1.0]),
            3))
    for _ in range(2000):
        # The alignment score: a weighted mean over 0 / 0.5 / 1 answers, times 100.
        weights = [0.15, 0.15, 0.15, 0.12, 0.1, 0.1, 0.09, 0.09, 0.05]
        vals = [random.choice([0.0, 0.5, 1.0]) for _ in weights]
        out.append((sum(w * v for w, v in zip(weights, vals)) / sum(weights) * 100, 1))
    for _ in range(2000):
        out.append((random.random(), random.choice([0, 1, 2, 3, 4])))
    return out


def main() -> None:
    sys.stdin.read()
    cases = NAMED + generated()
    print(json.dumps({
        "cases": [{"x": x, "digits": d, "want": round(x, d)} for x, d in cases],
        # How many of them the OLD idiom gets wrong, so the check can say whether the set
        # still exercises the bug at all. A case set that stops disagreeing has stopped
        # testing anything.
        "old_idiom_wrong": sum(
            1 for x, d in cases
            if _js_scale_round(x, d) != round(x, d)),
    }, ensure_ascii=False))


def _js_scale_round(x: float, digits: int) -> float:
    """`Math.round(x * 10**d) / 10**d` as JavaScript computes it — floor(v + 0.5)."""
    import math
    v = x * (10.0 ** digits)
    if not math.isfinite(v):
        return x
    return math.floor(v + 0.5) / (10.0 ** digits)


if __name__ == "__main__":
    main()
