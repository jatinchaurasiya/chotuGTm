/**
 * Draft lane: UTM builder. Tags are appended at copy/publish time:
 *   ?utm_source={platform}&utm_medium=social&utm_campaign={workspace}_{YYYYMMDD}
 */

export interface UtmParams {
  platform: string;
  workspace: string;
  date?: Date | string;
  medium?: string;
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function yyyymmdd(date?: Date | string): string {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** `{workspace}_{YYYYMMDD}` campaign name. */
export function campaignFor(workspace: string, date?: Date | string): string {
  return `${slug(workspace) || "workspace"}_${yyyymmdd(date)}`;
}

/** Raw query string (no leading `?`). */
export function buildUtmQuery(params: UtmParams): string {
  const q = new URLSearchParams({
    utm_source: params.platform.trim().toLowerCase(),
    utm_medium: (params.medium ?? "social").trim().toLowerCase(),
    utm_campaign: campaignFor(params.workspace, params.date),
  });
  return q.toString();
}

/** Append UTM params, preserving existing query + fragment. */
export function appendUtm(rawUrl: string, params: UtmParams): string {
  const u = new URL(rawUrl);
  const extra = new URLSearchParams(buildUtmQuery(params));
  extra.forEach((value, key) => {
    if (!u.searchParams.has(key)) u.searchParams.append(key, value);
  });
  return u.toString();
}
