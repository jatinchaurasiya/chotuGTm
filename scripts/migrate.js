// chotu db:migrate — applies migrations/*.sql in filename order.
//
// Honest limitation: Supabase exposes NO DDL over the REST API, so this
// script needs a direct Postgres connection string (SUPABASE_DB_URL).
//   - If SUPABASE_DB_URL is set: runs each SQL file via the `postgres`
//     package (npm i -D postgres) or falls back to `psql` if available.
//   - If not set: prints the file list + manual instructions, exits 0.
//
// Usage: npm run db:migrate  |  node scripts/migrate.js
// Env:   SUPABASE_DB_URL=postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dir = join(root, "migrations");

// Tiny env loader (no dotenv dependency): .env.local first, then .env.
// Real environment always wins (never overwritten here).
for (const name of [".env.local", ".env"]) {
  try {
    const envPath = join(root, name);
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) {
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          process.env[m[1]] = v;
        }
      }
    }
  } catch { /* env file is optional */ }
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.log("[migrate] No migrations/*.sql files found. Nothing to do.");
  process.exit(0);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.log("[migrate] TODO: SUPABASE_DB_URL is not set — no DDL applied.");
  console.log("[migrate] Pending files (in order):");
  for (const f of files) console.log(`  - migrations/${f}`);
  console.log("[migrate] To apply, do ONE of:");
  console.log('  1. psql "$SUPABASE_DB_URL" -f migrations/001_init.sql -f migrations/002_seed.sql');
  console.log("  2. Paste each file into the Supabase Dashboard > SQL Editor and run.");
  console.log("  3. Set SUPABASE_DB_URL in .env and re-run: npm run db:migrate");
  process.exit(0);
}

// Ledger: chotu_migrations(filename PRIMARY KEY) records applied files, so
// re-deploys skip them. Required because 001_init.sql uses plain CREATE
// statements (not IF NOT EXISTS) — re-applying would fail without the ledger.

// Prefer the `postgres` npm package when installed.
let postgres = null;
try {
  ({ default: postgres } = await import("postgres"));
} catch { /* optional dependency; fall back to psql */ }

const q = (s) => `'${s.replace(/'/g, "''")}'`;

if (postgres) {
  const sql = postgres(dbUrl);
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chotu_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    const rows = await sql.unsafe(`SELECT filename FROM chotu_migrations`);
    const done = new Set(rows.map((r) => r.filename));
    for (const f of files) {
      if (done.has(f)) {
        console.log(`[migrate] SKIP (already applied): ${f}`);
        continue;
      }
      const text = readFileSync(join(dir, f), "utf8");
      console.log(`[migrate] Applying migrations/${f} ...`);
      await sql.unsafe(text);
      await sql.unsafe(`INSERT INTO chotu_migrations (filename) VALUES (${q(f)})`);
      console.log(`[migrate] OK: ${f}`);
    }
  } finally {
    await sql.end();
  }
  console.log("[migrate] Done.");
} else {
  // Fallback: psql binary must exist.
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("[migrate] ERROR: SUPABASE_DB_URL is set but neither the `postgres` npm package nor the `psql` binary is available.");
    console.error("[migrate] Fix: npm i -D postgres   OR   install postgresql-client, then re-run.");
    process.exit(1);
  }
  const psqlRun = (args) =>
    execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", ...args], { stdio: "inherit" });
  const psqlQuery = (stmt) =>
    execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", stmt], { encoding: "utf8" });
  psqlRun(["-c", "CREATE TABLE IF NOT EXISTS chotu_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())"]);
  const out = psqlQuery("SELECT filename FROM chotu_migrations");
  const done = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const f of files) {
    if (done.has(f)) {
      console.log(`[migrate] SKIP (already applied): ${f}`);
      continue;
    }
    console.log(`[migrate] Applying migrations/${f} via psql ...`);
    psqlRun(["-f", join(dir, f)]);
    psqlRun(["-c", `INSERT INTO chotu_migrations (filename) VALUES (${q(f)})`]);
    console.log(`[migrate] OK: ${f}`);
  }
  console.log("[migrate] Done.");
}
