/**
 * Settings → Accounts → Deployment: what this runtime is configured with.
 * `core/env_diag.py`, for the Edge Function instead of the Python process.
 *
 * THE QUESTION IT ANSWERS is "the published app behaves differently from my machine".
 * Streamlit's version can only describe the Python it runs in; this describes the
 * function that serves React. When the two disagree about the data, the difference
 * between these two panels is the answer — which is why the facts are deliberately the
 * same facts in the same shape, pinned by check-env-diag.
 *
 * IT SHOWS NO SECRET and the page says so, because this is a panel people screenshot
 * into tickets. A length catches a truncated paste, a fingerprint compares two
 * environments without revealing either, and the key's CLASS is the one thing that
 * actually goes wrong — a publishable key where the service role belongs produces empty
 * reads and refused writes that look like missing data rather than a misconfiguration.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, ShieldAlert } from "lucide-react";
import { fetchDeployment, type DeploymentInfo } from "../api";
import { Badge, Card, Eyebrow, Notice, Spinner } from "../ui";

export default function DeploymentPanel() {
  const [data, setData] = useState<DeploymentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDeployment().then(setData).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't read the deployment."));
  }, []);

  if (error) return <Notice tone="bad">{error}</Notice>;
  if (!data) return <Spinner label="Reading this runtime's configuration…" />;

  return (
    <Card className="max-w-3xl p-6">
      <div className="flex items-center gap-2.5">
        <KeyRound className="h-5 w-5 text-accent-600" />
        <Eyebrow>{data.runtime}</Eyebrow>
      </div>
      <p className="mt-1 mb-4 text-sm leading-relaxed text-ink-600">{data.note}</p>

      <div className="space-y-2">
        {data.verdicts.map((v) => (
          <Notice
            key={v.text} tone={v.level === "bad" ? "bad" : v.level === "warn" ? "warn" : "good"}
            icon={v.level === "good"
              ? <CheckCircle2 className="h-4 w-4" />
              : v.level === "bad"
                ? <ShieldAlert className="h-4 w-4" />
                : <AlertTriangle className="h-4 w-4" />}
          >
            {v.text}
          </Notice>
        ))}
      </div>

      <div className="mt-5 overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
            <tr>
              <th className="px-3 py-2">Secret</th>
              <th className="px-3 py-2">Set</th>
              <th className="px-3 py-2 text-right">Length</th>
              <th className="px-3 py-2">Identifies as</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {data.secrets.map((r) => (
              <tr key={r.name}>
                <td className="px-3 py-2 font-mono text-xs text-ink-900">{r.name}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.present ? "good" : "bad"}>{r.present ? "set" : "missing"}</Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-600">
                  {r.present ? r.length : "—"}
                </td>
                <td className="px-3 py-2 text-ink-700">
                  {r.project_ref && (
                    <span>project <code className="text-xs">{r.project_ref}</code></span>
                  )}
                  {r.kind && (
                    <span className={r.is_service_role === false ? "text-bad-700" : ""}>
                      {r.kind}
                    </span>
                  )}
                  {r.fingerprint && (
                    <span className="ml-2 text-xs text-ink-500">
                      fingerprint <code>{r.fingerprint}</code>
                    </span>
                  )}
                  {!r.project_ref && !r.kind && !r.fingerprint && (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-500">
        No secret value is shown here, or sent to this page. A <em>fingerprint</em> is the
        first eight characters of a hash: it lets you check two environments hold the same
        secret without either panel holding the secret. A <em>length</em> catches a
        truncated paste, which is the commonest way a key is wrong.
      </p>

      <h3 className="mt-5 mb-2 text-sm font-bold text-brand-700">What else is wired</h3>
      <div className="flex flex-wrap gap-2">
        <Badge tone={data.extras.dispatchConfigured ? "good" : "warn"}>
          background jobs {data.extras.dispatchConfigured ? "can run" : "cannot run"}
        </Badge>
        <Badge tone={data.extras.mailerConfigured ? "good" : "warn"}>
          email {data.extras.mailerConfigured ? "configured" : "not configured"}
        </Badge>
        <Badge tone={data.extras.adminContact ? "good" : "warn"}>
          contact address {data.extras.adminContact ? "set" : "unset"}
        </Badge>
        {data.allowedOrigins.length > 0 && (
          <Badge tone="neutral">
            {data.allowedOrigins.length} allowed origin
            {data.allowedOrigins.length === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
    </Card>
  );
}
