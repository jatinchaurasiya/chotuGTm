import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `[db] Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

/**
 * Server-only Supabase client (service_role, bypasses RLS).
 * NEVER import this in browser/dashboard code — dashboard uses the anon key.
 * Throws if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.
 */
export function createServerClient(): SupabaseClient<Database> {
  const url = requiredEnv("SUPABASE_URL");
  const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false },
  });
}

let singleton: SupabaseClient<Database> | null = null;

/** Lazy singleton around createServerClient(). Still throws if env missing. */
export function serverClient(): SupabaseClient<Database> {
  if (!singleton) singleton = createServerClient();
  return singleton;
}
