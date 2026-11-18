/**
 * What THIS runtime is configured with. `core/env_diag.py`.
 *
 * NOT A PORT OF A PAGE — A SECOND WITNESS. env_diag exists to answer "the published app
 * behaves differently from my machine", and the Streamlit version can only ever describe
 * the Python process it is running in. The Edge Function is a different runtime with its
 * own secrets, and it is the one that serves React: when the two disagree about the data,
 * this is the half Streamlit cannot see, which is exactly the half worth reporting.
 *
 * So the facts are the same facts, in the same shape, deliberately — a fingerprint here
 * and a fingerprint there are directly comparable, and that comparison is the whole
 * diagnostic. check-env-diag pins the three functions that produce them against the
 * Python, because a fingerprint computed differently would read as a MISMATCH between two
 * correctly-configured deployments and send somebody hunting a problem that is not there.
 *
 * NOTHING HERE REVEALS A SECRET. A fingerprint is the first eight hex of a sha256 — it
 * compares and does not reverse. The key's CLASS is read from its prefix, or for a legacy
 * JWT from the `role` claim decoded WITHOUT verification, because the claim is wanted and
 * trust is not. The project ref is not a secret at all: it rides on every request, and it
 * is the single field that tells two deployments apart.
 */

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** `_fingerprint` — first 8 hex of sha256. Comparable across environments, not reversible. */
export async function fingerprint(value: string | null | undefined): Promise<string | null> {
  const v = s(value);
  if (!v) return null;
  try {
    const bytes = new TextEncoder().encode(v);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0"))
      .join("").slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * `key_class` — what kind of Supabase key this is, without revealing it.
 *
 * BOTH FORMATS MATTER. New-style keys are self-describing by prefix; legacy keys are JWTs
 * whose `role` claim says which they are. Getting this wrong in either direction is
 * expensive: a publishable key reported as service-role explains none of the RLS failures
 * it causes, and a service-role key reported as publishable sends somebody looking for a
 * permissions problem that does not exist.
 */
export function keyClass(key: string | null | undefined): {
  label: string; isServiceRole: boolean | null;
} {
  const k = s(key);
  if (!k) return { label: "missing", isServiceRole: null };
  if (k.startsWith("sb_secret_")) {
    return { label: "service-role (sb_secret_...)", isServiceRole: true };
  }
  if (k.startsWith("sb_publishable_")) {
    return {
      label: "publishable/anon (sb_publishable_...) - NOT service-role",
      isServiceRole: false,
    };
  }
  if (k.startsWith("eyJ")) {
    let role: string | null = null;
    try {
      // The claim, not the signature. base64url with the padding the encoder stripped.
      let payload = k.split(".")[1] ?? "";
      payload = payload.replace(/-/g, "+").replace(/_/g, "/");
      payload += "=".repeat((4 - (payload.length % 4)) % 4);
      const claims = JSON.parse(atob(payload)) as Record<string, unknown>;
      role = claims.role === undefined || claims.role === null ? null : s(claims.role);
    } catch {
      role = null;
    }
    if (role) {
      return { label: `legacy JWT key (role=${role})`, isServiceRole: role === "service_role" };
    }
    return { label: "legacy JWT key (role unreadable)", isServiceRole: null };
  }
  return { label: "unrecognised format", isServiceRole: null };
}

/**
 * `project_ref` — the Supabase project from its URL.
 *
 * "https://abc123.supabase.co" → "abc123". THE field that tells two deployments apart
 * when they disagree about the data, and not a secret: it rides on every request.
 */
export function projectRef(url: string | null | undefined): string | null {
  // STRING SURGERY, NOT `new URL`, to match the Python exactly. `URL.hostname` strips the
  // port, so "https://localhost:54321" — a local Supabase, which is precisely the case
  // somebody runs these diagnostics on — comes out as "localhost" here and
  // "localhost:54321" there. The two panels exist to be compared, and a port appearing
  // in one and not the other is a difference that is not a difference.
  //
  // It also does NOT trim: the Python does not, so a value with stray whitespace reads
  // as odd in both rather than clean in one and odd in the other. The whitespace is the
  // finding.
  const u = s(url);
  if (!u) return null;
  const afterScheme = u.includes("://") ? u.slice(u.indexOf("://") + 3) : u;
  const host = afterScheme.split("/")[0];
  return host.split(".")[0] || null;
}

export type SecretRow = {
  name: string;
  present: boolean;
  length: number;
  fingerprint?: string | null;
  project_ref?: string | null;
  kind?: string;
  is_service_role?: boolean | null;
};

/** The three secrets this runtime needs, described and never revealed. */
export async function secretRows(env: {
  supabaseUrl?: string; supabaseKey?: string; jwtSecret?: string;
}): Promise<SecretRow[]> {
  const url = s(env.supabaseUrl);
  const key = s(env.supabaseKey);
  const jwt = s(env.jwtSecret);
  const cls = keyClass(key);
  return [
    {
      name: "SUPABASE_URL",
      present: !!url,
      length: url.length,
      // The URL is not a secret and the ref is clearer, so it carries a ref rather than
      // a fingerprint — the Python drops the fingerprint here for the same reason.
      project_ref: projectRef(url),
    },
    {
      name: "SUPABASE_KEY",
      present: !!key,
      length: key.length,
      fingerprint: await fingerprint(key),
      kind: cls.label,
      is_service_role: cls.isServiceRole,
    },
    {
      name: "SUPABASE_JWT_SECRET",
      present: !!jwt,
      length: jwt.length,
      fingerprint: await fingerprint(jwt),
    },
  ];
}

/**
 * What is wrong, in the order somebody should act on it.
 *
 * `core/env_diag.verdicts` reaches the same conclusions about the Python runtime. These
 * are about THIS one, and the two are meant to be read side by side: a verdict that
 * appears here and not there is the difference between the two environments, which is
 * what somebody opened this panel to find.
 */
export function verdicts(rows: SecretRow[], extras: {
  dispatchConfigured: boolean; mailerConfigured: boolean; adminContact: boolean;
}): { level: "bad" | "warn" | "good"; text: string }[] {
  const out: { level: "bad" | "warn" | "good"; text: string }[] = [];
  const by = (n: string) => rows.find((r) => r.name === n);

  for (const name of ["SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_JWT_SECRET"]) {
    if (!by(name)?.present) {
      out.push({ level: "bad", text: `${name} is not set — this function cannot serve.` });
    }
  }
  const key = by("SUPABASE_KEY");
  if (key?.present && key.is_service_role === false) {
    out.push({
      level: "bad",
      text: "SUPABASE_KEY is a publishable key, not the service role. Reads that should "
        + "cross tenants will come back empty and writes will be refused by RLS — which "
        + "looks like missing data rather than a configuration error.",
    });
  } else if (key?.present && key.is_service_role === null) {
    out.push({
      level: "warn",
      text: `SUPABASE_KEY is in a format this build does not recognise (${key.kind}). It `
        + "may still work; it cannot be checked.",
    });
  }
  if (!extras.dispatchConfigured) {
    // WORDED BY THE OBSERVABLE FACT, not by the cause. This runtime either has a job
    // dispatcher or it does not; in a deployed Edge Function that depends on
    // RFPIS_GH_DISPATCH_TOKEN, and in the local dev server a runner is always wired, so
    // naming only the token would be wrong in one of the two places this panel is read.
    // The symptom is the same either way and is the worst failure this product has:
    // nothing errors, jobs simply sit at "queued" for ever.
    out.push({
      level: "warn",
      text: "No job runner is reachable from this runtime, so background work is queued "
        + "and never runs — scans, exports, invitations and re-scores sit at “queued” "
        + "with no error. In a deployed function this is RFPIS_GH_DISPATCH_TOKEN.",
    });
  }
  if (!extras.mailerConfigured) {
    out.push({
      level: "warn",
      text: "No mailer is configured, so password resets and invitations produce a link "
        + "to pass on by hand rather than an email.",
    });
  }
  if (!extras.adminContact) {
    out.push({
      level: "warn",
      text: "ADMIN_CONTACT_EMAIL is not set, so “ask an administrator” messages have "
        + "nobody to name.",
    });
  }
  if (!out.length) {
    out.push({ level: "good", text: "Everything this function needs is configured." });
  }
  return out;
}
