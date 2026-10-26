/**
 * Outgoing email — a port of core/mailer.py and the parts of core/user_emails.py the API
 * needs. Resend over plain fetch, so the same module runs in Deno and in Node.
 *
 * The identity (product name, short name, From display name, "Powered by", app URL) is
 * resolved from `app_settings`, never hardcoded, for the reason core/user_emails.py gives:
 * RFPIS is multi-tenant and the deploying organisation's name must not live in the source.
 * Same keys, same precedence, so the two apps cannot drift.
 *
 * Not configured is not an error. `send` returns false and the caller carries on — a reset
 * confirmation must read the same whether or not a mail went out, or the form becomes a way
 * to discover who has an account.
 */
import { q, type Db } from "./db.ts";

export type MailEnv = {
  resendApiKey?: string;
  resendFrom?: string;
  appPublicUrl?: string;   // fallback when app_settings has none
};

const RESEND_URL = "https://api.resend.com/emails";
const SETTINGS_TTL_MS = 60_000;

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * `sender` as a named From: header — "Product Name <no-reply@example.org>".
 * A port of mailer._from_header: a sender already in "Name <addr>" form is left alone,
 * and so is anything that is not an address, rather than being rewritten into something
 * the transport will reject.
 */
export function fromHeader(sender: string, display: string): string {
  const s = sender.trim();
  if (!s.includes("@")) return s;
  if (/^[^<]*<[^>]+>$/.test(s)) return s;       // already "Name <addr>"
  const name = display.trim();
  if (!name) return s;
  // The two things email.utils.formataddr does, both of which matter:
  //   * RFC 2047-encode a non-ASCII name — "Zoë Ltd" raw is an invalid header;
  //   * RFC 5322-quote a name containing a special — get the comma wrong and
  //     "Acme, Inc. <a@b.org>" is parsed as TWO addresses.
  if (/[^\x20-\x7e]/.test(name)) {
    const bytes = new TextEncoder().encode(name);
    return `=?utf-8?b?${btoa(String.fromCharCode(...bytes))}?= <${s}>`;
  }
  const quoted = /[(),.:;<>@\[\]\\"]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${quoted} <${s}>`;
}

export function createMailer(db: Db, env: MailEnv) {
  const cache = new Map<string, [number, string]>();

  /** core/settings.get_setting, global store only — the identity keys are not per-tenant. */
  async function setting(key: string): Promise<string> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit[0] < SETTINGS_TTL_MS) return hit[1];
    let val = "";
    try {
      const rows = await db.service.get("app_settings", `select=value&key=eq.${q(key)}&limit=1`);
      val = typeof rows[0]?.value === "string" ? rows[0].value.trim() : "";
    } catch {
      val = "";   // a settings read must never take the email down with it
    }
    cache.set(key, [Date.now(), val]);
    return val;
  }

  // The same keys and the same fallbacks as user_emails._product_name / _short_name, which
  // are deliberately different strings: a deployment can carry a long name in the header and
  // a tight one in the subject line. Python also consults EMAIL_* environment variables
  // between the setting and the literal; the Edge Function is given none of them, so
  // app_settings is the only source here.
  const productName = async () => (await setting("email_product_name")) || "RFP Intelligence System";
  const shortName = async () => (await setting("email_product_short_name")) || "RFPIS";
  /** mailer._from_name: `email_from_name` wins, else the product name already in the header. */
  const fromName = async () => (await setting("email_from_name")) || (await setting("email_product_name"));

  /**
   * Where the links point. The request's own origin wins when it is one we allow, so a
   * reset begun on the React app returns to the React app rather than bouncing the person
   * into Streamlit; otherwise `app_public_url`, as user_emails._app_url does.
   */
  async function appUrl(origin?: string | null, allowed?: string[]): Promise<string> {
    if (origin && allowed?.length && allowed.includes(origin)) return origin.replace(/\/+$/, "");
    const configured = await setting("app_public_url");
    return (configured || env.appPublicUrl || "http://localhost:5180").replace(/\/+$/, "");
  }

  /** user_emails._branded_html, in the CHAI palette the React app uses. */
  async function brandedHtml(recipientName: string, bodyHtml: string, base: string): Promise<string> {
    const poweredBy = await setting("email_powered_by");
    const powered = poweredBy
      ? `<div style="font-size:12px; color:#94a3b8; margin-bottom:20px;">Powered by ${esc(poweredBy)}</div>`
      : "";
    return `<!doctype html>
<html>
  <body style="font-family: 'Fira Sans', 'Trebuchet MS', -apple-system, 'Segoe UI', Roboto, sans-serif; background:#f5f7fa; padding:24px; margin:0;">
    <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; padding:32px 28px; border:1px solid #e0e5ec;">
      <div style="font-size:18px; font-weight:700; color:#003E78; margin-bottom:4px;">${esc(await productName())}</div>
      ${powered}
      <div style="font-size:15px; color:#232c3a; line-height:1.55;">
        <p>Hi <strong>${esc(recipientName || "there")}</strong>,</p>
        ${bodyHtml}
        <p style="margin-top:28px; font-size:13px; color:#4b586c;">
          Log in at <a href="${esc(base)}" style="color:#117996;">${esc(base)}</a>
        </p>
        <p style="font-size:12px; color:#94a3b8; margin-top:24px;">
          This is an automated message. If you didn't expect this email, contact your administrator.
        </p>
      </div>
    </div>
  </body>
</html>`;
  }

  /**
   * user_emails._activation_instructions: the button is the primary route, and the same
   * token appears underneath as a code — two routes to one secret, because a link has ways
   * to fail that are nobody's fault (a client rewriting the URL, a forward to a phone).
   */
  function instructions(base: string, token: string, expiresHint: string): string {
    const page = `${base}/password-reset`;
    const link = `${page}?token=${encodeURIComponent(token)}`;
    return `
        <p style="margin:24px 0;">
          <a href="${esc(link)}" style="background:#003E78; color:#ffffff; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:600; display:inline-block;">Set a new password</a>
        </p>
        <p style="font-size:12px; color:#67748a; word-break:break-all;">
          If the button does not work, paste this into your browser:<br>${esc(link)}
        </p>
        <p style="font-size:13px; color:#4b586c; margin-top:22px;">
          Or, if neither opens, go to <a href="${esc(page)}" style="color:#117996;">${esc(page)}</a>
          and enter this reset code:
        </p>
        <p style="font-family:monospace; font-size:14px; background:#f7f9fb; padding:12px 14px; border-radius:8px; border:1px solid #e0e5ec; word-break:break-all; color:#232c3a;">
          ${esc(token)}
        </p>
        <p style="font-size:13px; color:#4b586c;">
          Either way it works once and expires in ${esc(expiresHint)}. If it expires, ask for a new one.
        </p>`;
  }

  async function send(to: string, subject: string, html: string): Promise<boolean> {
    const key = env.resendApiKey?.trim();
    const sender = env.resendFrom?.trim();
    if (!key || !sender) return false;      // not configured — silent, by design
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromHeader(sender, await fromName()), to: [to], subject, html }),
      });
      if (!res.ok) {
        // The body can carry the address; log the status only.
        console.error("resend send failed", res.status);
        return false;
      }
      return true;
    } catch (e) {
      console.error("resend send error", e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** user_emails.send_password_reset_email, worded for a reset the person asked for. */
  async function sendPasswordReset(opts: {
    toEmail: string; toName: string | null; token: string;
    origin?: string | null; allowedOrigins?: string[]; expiresHint?: string;
  }): Promise<boolean> {
    const base = await appUrl(opts.origin, opts.allowedOrigins);
    const hint = opts.expiresHint ?? "2 hours";
    const short = await shortName();
    const body = `
        <p>You asked to reset the password on your ${esc(short)} account.</p>
        ${instructions(base, opts.token, hint)}
        <p style="font-size:13px; color:#4b586c;">
          If you did NOT ask for this, you can ignore this email. Your existing password still
          works until this code is used, so nothing has changed yet.
        </p>`;
    return send(opts.toEmail, `Change your ${short} password`,
      await brandedHtml(opts.toName ?? "", body, base));
  }

  return { sendPasswordReset, configured: () => !!(env.resendApiKey && env.resendFrom) };
}

export type Mailer = ReturnType<typeof createMailer>;
