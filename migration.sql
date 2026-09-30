-- ac_poc_position_sync — schema migration
-- Adds the job-title-sync columns to the 4 lead tables. Idempotent.
-- Applied to MAGTestProject (aivitcomiywiysrfwqxt) via Supabase MCP apply_migration
-- as migration "add_poc_job_title_sync_columns".

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'manually_found_leads',
    'ai_scraped_soc_med_leads',
    'manually_found_cold_leads',
    'ai_verified_cold_leads'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS poc_job_title text', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS ac_job_title_is_updated_date timestamptz DEFAULT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS job_title_is_manually_set boolean DEFAULT false', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS ac_account_needs_update boolean DEFAULT false', t);
  END LOOP;
END $$;
