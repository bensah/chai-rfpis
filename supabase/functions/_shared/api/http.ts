// Response helpers shared by every route.

/** A failure to show the user as-is (status + message). Anything else becomes a generic 500. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

export function gzipped(req: Request, res: Response): Response {
  const accepts = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  if (!accepts || !res.body || typeof CompressionStream === "undefined") return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.append("Vary", "Accept-Encoding");
  return new Response(res.body.pipeThrough(new CompressionStream("gzip")), { status: res.status, headers });
}

export function corsHeaders(origin: string | null, allowed?: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (!allowed || allowed.length === 0) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function withCors(res: Response, cors: Record<string, string>): Response {
  for (const [k, v] of Object.entries(cors)) {
    if (k === "Vary") res.headers.append(k, v);
    else res.headers.set(k, v);
  }
  return res;
}

/** The request's JSON body as an object, or a 400. */
export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Expected a JSON object in the request body.");
}

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
