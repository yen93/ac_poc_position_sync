-- ac_poc_position_sync — schema migration
-- Adds the job-title-sync columns to the 4 lead tables. Idempotent.
-- Applied to MAGTestProject (aivitcomiywiysrfwqxt) via Supabase MCP apply_migration
-- across three migrations: "add_poc_job_title_sync_columns" (first 4 columns),
-- "add_ac_acc_linked_column" (ac_acc_linked), and "add_title_source_and_attempts"
-- (poc_job_title_source, poc_job_title_search_attempts).

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
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS ac_acc_linked boolean DEFAULT false', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS poc_job_title_source text', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS poc_job_title_search_attempts integer DEFAULT 0', t);
  END LOOP;
END $$;
