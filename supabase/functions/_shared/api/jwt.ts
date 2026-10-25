// HS256 JWTs on WebCrypto, so the same code runs in Deno (Edge Function) and Node (Vite dev).
export type Json = Record<string, unknown>;

const enc = new TextEncoder();
// Node's typings have no global CryptoKey type; derive it so the module typechecks on both hosts.
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hmacKey(raw: Uint8Array | string): Promise<Key> {
  const bytes = typeof raw === "string" ? enc.encode(raw) : raw;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false,
    ["sign", "verify"]);
}

/** A key derived from `secret` for one purpose, so a token minted for that purpose is never
 * valid anywhere the raw secret is trusted (PostgREST). */
export async function derivedKey(secret: string, label: string): Promise<Key> {
  const k = await hmacKey(secret);
  return hmacKey(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(label))));
}

export async function signJwt(payload: Json, key: Key): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function verifyJwt(token: string, key: Key): Promise<Json | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as Json;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** sha256 hex, as core/password_tokens.py::_digest. */
export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
