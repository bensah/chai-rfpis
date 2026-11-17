/**
 * Python's `round(x, n)`, which `Math.round(x * 10**n) / 10**n` is not.
 *
 * FOUND BY check-scoring GOING RED, on a real row: a featured opportunity scored
 * 0.34·0.35 + 0.18·1.0 + 0.10·0.325, which is the double 0.36749999999999999334 — just
 * BELOW the 0.3675 tie. Python rounded it to 0.367. The TypeScript multiplied by 1000
 * first, and that multiplication rounds to exactly 367.5, throwing away the very
 * information the rounding decision turns on; `Math.round` then took the tie upward and
 * answered 0.368.
 *
 * So there are TWO bugs in the scale-and-round idiom, not one, and only the second is the
 * well-known one:
 *
 *   1. THE MULTIPLICATION MOVES THE VALUE. `x * 10**n` is itself rounded to a double, so
 *      a value near a tie can land exactly on it, or cross it. This is the one that fired.
 *   2. THE TIE RULE DIFFERS. Python rounds half to EVEN; `Math.round` rounds half up.
 *
 * `Number(x.toFixed(n))` fixes the first outright — `toFixed` rounds the exact binary
 * value, never a product — and leaves only genuine ties, where it rounds away from zero.
 * A genuine tie at n decimals needs the double to be exactly (2k+1)/(2·10**n), which is
 * dyadic only when 5**n divides 2k+1: at 3 decimals that is 0.0625, 0.1875, 0.3125 and
 * their kin — reachable, since every weight here is a hundredth. So the tie is detected
 * and resolved to even, and the two languages then agree on every finite double.
 *
 * Tie detection reads the exact expansion rather than testing `x * 2·10**n`, which would
 * reintroduce bug 1. `toFixed(n + 18)` is correctly rounded to that many places, and the
 * nearest double to a tie is either exactly the tie or ~1e-17 away at this magnitude —
 * four orders of magnitude more than the 1e-18 the test can confuse, so it cannot report
 * a tie that is not one.
 */

/** `round(x, digits)` as Python does it: on the exact value, ties to even. */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (digits < 0 || digits > 15 || !Number.isInteger(digits)) {
    throw new RangeError(`pyRound: digits must be an integer in 0..15, got ${digits}`);
  }
  // Out of toFixed's plain-decimal range; nothing here reaches it, and a silent
  // exponential string would be read as a wrong answer rather than an error.
  if (Math.abs(x) >= 1e21) return x;

  const away = Number(x.toFixed(digits));          // exact value, ties away from zero
  if (!isTie(x, digits)) return away;

  // A tie: Python keeps the EVEN candidate. `away` is the one further from zero, so the
  // other candidate is one step back toward it.
  const step = Math.sign(x) / 10 ** digits;
  const toward = Number((away - step).toFixed(digits));
  const evenOf = (v: number) => Math.abs(Math.round(v * 10 ** digits)) % 2 === 0;
  return evenOf(away) ? away : toward;
}

/** True when `x` sits exactly on the half-way point between two `digits`-place values. */
function isTie(x: number, digits: number): boolean {
  // 18 extra places: far beyond the gap between a tie and its neighbouring doubles, and
  // within toFixed's 100-place limit for every digits this accepts.
  const s = Math.abs(x).toFixed(digits + 18);
  const dot = s.indexOf(".");
  if (dot < 0) return false;
  const frac = s.slice(dot + 1);
  if (frac.length <= digits) return false;
  const tail = frac.slice(digits);
  return tail[0] === "5" && /^0*$/.test(tail.slice(1));
}
