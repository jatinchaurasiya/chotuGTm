// chotu db:seed — applies migrations/002_seed.sql (idempotent upsert).
//
// Same limitation as migrate.js: seeds are raw SQL, so this needs
// SUPABASE_DB_URL. Without it, prints instructions and exits 0.
//
// Usage: npm run db:seed  |  node scripts/seed.js
// NOTE: run 001_init.sql first (npm run db:migrate) on a fresh project.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const seedFile = join(root, "migrations", "002_seed.sql");

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

if (!existsSync(seedFile)) {
  console.error("[seed] ERROR: migrations/002_seed.sql not found.");
  process.exit(1);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.log("[seed] TODO: SUPABASE_DB_URL is not set — seed NOT applied.");
  console.log("[seed] To apply, do ONE of:");
  console.log('  1. psql "$SUPABASE_DB_URL" -f migrations/002_seed.sql');
  console.log("  2. Paste migrations/002_seed.sql into Supabase Dashboard > SQL Editor and run.");
  console.log("  3. Set SUPABASE_DB_URL in .env and re-run: npm run db:seed");
  process.exit(0);
}

let postgres = null;
try {
  ({ default: postgres } = await import("postgres"));
} catch { /* optional dependency; fall back to psql */ }

if (postgres) {
  const sql = postgres(dbUrl);
  try {
    console.log("[seed] Applying migrations/002_seed.sql ...");
    await sql.unsafe(readFileSync(seedFile, "utf8"));
    console.log("[seed] OK: workspaces authormity.space + shipsprint.site upserted.");
  } finally {
    await sql.end();
  }
} else {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("[seed] ERROR: SUPABASE_DB_URL is set but neither the `postgres` npm package nor the `psql` binary is available.");
    console.error("[seed] Fix: npm i -D postgres   OR   install postgresql-client, then re-run.");
    process.exit(1);
  }
  console.log("[seed] Applying migrations/002_seed.sql via psql ...");
  execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", seedFile], { stdio: "inherit" });
  console.log("[seed] Done.");
}
