# ac_poc_position_sync

Two Supabase edge functions that fill the **ActiveCampaign (AC) contact Job Title** for leads in 4 tables,
and link contacts to their org account when needed. Designed to be called **in sequence from n8n**.

## Where "Job Title" lives in AC
AC has **no** native or custom "Job Title" field. The job title is the `jobTitle` attribute of the
contact<->account link (`accountContacts`), read via `GET /api/3/contacts/{id}/accountContacts` and written
with `PUT /api/3/accountContacts/{acId}` body `{"accountContact":{"jobTitle":"..."}}`. A contact with no
linked account has nowhere to store a title.

## Project / deploy
- Supabase project: **MAGTestProject** (`aivitcomiywiysrfwqxt`).
- Functions (each `supabase/functions/<name>/index.ts`): `ac-poc-position-sync`, `ac-account-contact-sync`.
- Deploy via Supabase MCP `deploy_edge_function`, `verify_jwt:false`. No config.toml/deno.json/import map;
  deps pinned inline. Base URL: `https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/<name>`.
- Secrets (already set, shared with `alternate-lead-finder`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `OPENAI_API_KEY`, `AC_API_URL`, `AC_API_TOKEN`. Optional `OPENAI_MODEL` (default `gpt-4o`; must support the
  Responses API `web_search_preview` tool), `MAX_TITLE_ATTEMPTS` (default 2).

## Title source: OpenAI web-search-grounded (NOT Apify)
Titles come from an OpenAI Responses-API call with the `web_search_preview` tool: it verifies the person's
CURRENT title from public sources and returns null when unsure (never guesses). The source URL is stored in
`poc_job_title_source`. Each definitive "no confident title" bumps `poc_job_title_search_attempts`; once it
reaches `MAX_TITLE_ATTEMPTS` the (paid) lookup is skipped so unresolvable leads don't keep costing money.
Cost ~2-3c per lookup (the web-search tool fee dominates; model choice barely matters).
(History: the original implementation used the Apify `decision-maker-email-finder` actor, which had a 0% hit
rate here because it is domain-scoped, not person-scoped. Replaced with OpenAI grounding.)

## Data (4 tables)
`manually_found_leads`, `ai_scraped_soc_med_leads`, `manually_found_cold_leads`, `ai_verified_cold_leads`.
Columns added by `migration.sql`: `poc_job_title text`, `ac_job_title_is_updated_date timestamptz`,
`job_title_is_manually_set boolean default false`, `ac_account_needs_update boolean default false`,
`ac_acc_linked boolean default false`, `poc_job_title_source text`,
`poc_job_title_search_attempts integer default 0`.

## n8n order: run `ac-poc-position-sync` FIRST, then `ac-account-contact-sync`

### 1) ac-poc-position-sync (title sync for already-linked contacts)
Selects eligible rows: `ac_job_title_is_updated_date IS NULL AND (job_title_is_manually_set IS NULL OR = false)`.
Per row (AC contact resolved before any OpenAI call):
- contact not found in AC -> skip, retryable.
- has account link, jobTitle SET -> `job_title_is_manually_set=true` (never overwrite).
- has account link, jobTitle EMPTY -> enrich (OpenAI) + PUT jobTitle + stamp `ac_job_title_is_updated_date`.
- **no account link -> `ac_account_needs_update=true`** (handed to function 2; no enrichment).

### 2) ac-account-contact-sync (link org account, then fill title)
Selects rows: `ac_account_needs_update = true`. Per row:
- contact not found in AC -> leave flagged, retryable.
- contact already has a link -> clear flag (`ac_account_needs_update=false`, `ac_acc_linked=true`); fill title
  if empty, else `job_title_is_manually_set=true`.
- no `org` / org has no matching AC account -> leave flagged (`no_account_match`).
- org matches an AC account (exact, diacritic-/whitespace-insensitive) -> create the contact<->account link
  (`ac_acc_linked=true`, `ac_account_needs_update=false`), then enrich + PUT jobTitle + stamp date.

Hand-off: if fn2 links but the OpenAI lookup finds no title, the row (now has a link, empty title,
`needs_update=false`) is picked up by **fn1** on the next cycle to fill the title.

## Invoke (both functions share these)
- `?sync=1` run inline + JSON summary; default = 202 + background task.
- `?limit=N` rows per run (default 10).
- `?email=<addr>` process only that email across tables, ignoring the selection filter (targeted reprocessing).
- `?title=<text>` manual title override (skips enrichment; still never overwrites an existing AC title).

Example (curl.exe on Windows; anon key as `apikey`):
```
curl -s -X POST "https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-poc-position-sync?sync=1&limit=20" -H "apikey: <ANON_KEY>"
curl -s -X POST "https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/ac-account-contact-sync?sync=1&limit=20" -H "apikey: <ANON_KEY>"
```

## Notes
- Both functions duplicate the shared helpers inline (house style: no shared import map).
- Title lookup returns null when the person/title can't be verified (guardrail against CRM hallucination) and
  records the source URL in `poc_job_title_source`. Unresolvable rows stop being looked up after
  `MAX_TITLE_ATTEMPTS` (see `poc_job_title_search_attempts`).
- Org->account matching is exact (accent/whitespace-insensitive). Typos/variant names won't auto-link
  (deliberate, to avoid wrong links).
- Deploy tip: the deploy pipeline interprets `\u` escapes -> keep source ASCII and `\u`-free (see the
  `stripDiacritics` codepoint filter in fn2, and the `openaiFindTitle` prompt built with string concatenation).
