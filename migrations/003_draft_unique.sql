-- Concurrent double-fire guard for drafts: one variant per platform per opportunity.
-- Re-runnable: no-op if constraint already exists (deploy re-runs never fail).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'drafts_opportunity_platform_unique'
  ) THEN
    ALTER TABLE public.drafts
      ADD CONSTRAINT drafts_opportunity_platform_unique UNIQUE (opportunity_id, platform);
  END IF;
END
$$;
