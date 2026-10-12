/**
 * Discover lane: Scrapling fetch bridge.
 *
 * Spawns `python3 -c` running Scrapling's `Fetcher` and returns page HTML.
 * Skip-on-block contract: on 403 / login-wall / 429 we return
 * `{ skipped: true, reason }` and NEVER escalate (no stealth fetchers, no
 * retries against policy, no login-wall defeats). Callers log + skip.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ScraplingResult =
  | { skipped: true; url: string; reason: string; status?: number }
  | { skipped: false; url: string; finalUrl: string; status: number; html: string };

export interface ScraplingOptions {
  timeoutMs?: number;
  /** Rewrite reddit.com threads to old.reddit.com (lighter, fewer blocks). Default true. */
  preferOldReddit?: boolean;
  maxHtmlChars?: number;
  pythonBin?: string;
}

/** Non-retryable block statuses: log + skip, never escalate. */
const BLOCK_STATUSES = new Set([401, 403, 429]);

const LOGIN_WALL_MARKERS = [
  "login.reddit.com",
  "reddit.com/login",
  "you must log in",
  "log in to continue",
  "sign in to continue",
  "sign in to confirm",
  "please log in",
  "cf-challenge",
  "challenge-platform",
  "attention required! | cloudflare",
  "are you a robot",
  "unusual traffic",
  "verify you are human",
  "access denied",
  "request blocked",
];

/** Python bridge: argv[1]=url, argv[2]=max_chars, argv[3]=timeout_s. Prints one JSON line. */
const BRIDGE_SCRIPT = [
  "import sys, json",
  "url = sys.argv[1]",
  "max_chars = int(sys.argv[2]) if len(sys.argv) > 2 else 500000",
  "timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 30",
  "try:",
  "    from scrapling import Fetcher",
  "except Exception as e:",
  '    print(json.dumps({"ok": False, "reason": "scrapling-unavailable", "detail": str(e)[:500]}))',
  "    sys.exit(2)",
  "try:",
  "    page = Fetcher.get(url, timeout=timeout)",
  "    status = int(getattr(page, 'status', 0) or 0)",
  "    final_url = str(getattr(page, 'url', url) or url)",
  "    html = getattr(page, 'html_content', '') or ''",
  "    if not isinstance(html, str):",
  "        html = str(html)",
  '    print(json.dumps({"ok": True, "status": status, "final_url": final_url, "html": html[:max_chars]}))',
  "except Exception as e:",
  "    msg = str(e)",
  '    print(json.dumps({"ok": False, "reason": "fetch-error", "detail": msg[:500]}))',
  "    sys.exit(3)",
].join("\n");

interface BridgeOk {
  ok: true;
  status: number;
  final_url: string;
  html: string;
}

interface BridgeFail {
  ok: false;
  reason: string;
  detail?: string;
}

/** Prefer the lightweight old UI for single Reddit thread URLs. */
export function toFetchableUrl(raw: string, preferOldReddit = true): string {
  const url = raw.trim();
  if (!preferOldReddit) return url;
  try {
    const u = new URL(url);
    if ((u.hostname === "www.reddit.com" || u.hostname === "reddit.com") && u.pathname.includes("/comments/")) {
      u.hostname = "old.reddit.com";
      return u.toString();
    }
  } catch {
    // fall through with the raw url
  }
  return url;
}

/** Returns a skip reason when the response smells like a login wall / block, else null. */
export function looksLikeLoginWall(status: number, html: string, finalUrl: string): string | null {
  if (BLOCK_STATUSES.has(status)) {
    return status === 429 ? "rate-limited-429" : `http-${status}-block`;
  }
  const lowerFinal = finalUrl.toLowerCase();
  if (lowerFinal.includes("login.reddit.com") || lowerFinal.includes("reddit.com/login")) {
    return "login-wall-redirect";
  }
  const lower = html.toLowerCase();
  for (const marker of LOGIN_WALL_MARKERS) {
    if (lower.includes(marker)) return `login-wall-marker:${marker}`;
  }
  return null;
}

export async function fetchWithScrapling(rawUrl: string, opts: ScraplingOptions = {}): Promise<ScraplingResult> {
  const url = toFetchableUrl(rawUrl, opts.preferOldReddit ?? true);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxHtmlChars = opts.maxHtmlChars ?? 500_000;
  const pythonBin = opts.pythonBin ?? process.env.SCRAPLING_PYTHON ?? "python3";

  let stdout: string;
  try {
    const out = await execFileAsync(
      pythonBin,
      ["-c", BRIDGE_SCRIPT, url, String(maxHtmlChars), String(Math.max(1, Math.ceil(timeoutMs / 1000)))],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    stdout = out.stdout.trim();
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string; stdout?: string };
    // Bridge exit 2/3 carries a JSON reason on stdout; surface it as a skip.
    const maybeJson = (e.stdout ?? "").trim().split("\n").pop() ?? "";
    try {
      const parsed = JSON.parse(maybeJson) as BridgeFail;
      if (parsed && parsed.ok === false) {
        return { skipped: true, url, reason: parsed.reason, status: undefined };
      }
    } catch {
      // not JSON — fall through to generic mapping
    }
    if (e.code === "ENOENT") return { skipped: true, url, reason: "scrapling-unavailable" };
    if ((e as { killed?: boolean }).killed) return { skipped: true, url, reason: "fetch-timeout" };
    return { skipped: true, url, reason: "spawn-error" };
  }

  let parsed: BridgeOk | BridgeFail;
  try {
    parsed = JSON.parse(stdout.split("\n").pop() ?? "") as BridgeOk | BridgeFail;
  } catch {
    return { skipped: true, url, reason: "bridge-bad-output" };
  }
  if (!parsed.ok) return { skipped: true, url, reason: parsed.reason };

  const status = parsed.status || 200;
  const html = parsed.html || "";
  const wallReason = looksLikeLoginWall(status, html, parsed.final_url);
  if (wallReason) return { skipped: true, url, reason: wallReason, status };
  if (!html) return { skipped: true, url, reason: "empty-body", status };
  return { skipped: false, url, finalUrl: parsed.final_url, status, html };
}
