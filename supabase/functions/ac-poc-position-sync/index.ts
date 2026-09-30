// ac-poc-position-sync  (STEP 1 of 2; run before ac-account-contact-sync)
// Fills the ActiveCampaign (AC) contact "Job Title" for leads across 4 Supabase
// tables, for contacts that ALREADY have an account link. Contacts with no
// account link are flagged ac_account_needs_update=true and handled by the
// companion function ac-account-contact-sync.
//
// Where "Job Title" lives in AC: AC has no native/custom Job Title field. It is
// the `jobTitle` attribute of the contact<->account link (`accountContacts`). A
// contact with no linked account has nowhere to store a title.
//
// Per-row outcomes:
//   - AC contact not found                         -> skip, leave retryable.
//   - contact has an account link, jobTitle SET    -> job_title_is_manually_set=true (AC untouched).
//   - contact has an account link, jobTitle EMPTY  -> enrich (Apify) + PUT jobTitle; ac_job_title_is_updated_date=now().
//   - contact has NO account link                  -> ac_account_needs_update=true (no Apify; handed to ac-account-contact-sync).
//
// Credit-safe: the AC contact + account link are resolved BEFORE any Apify call.
// Apify runs only when there is an account link with an empty jobTitle to fill.
//
// Idempotency: a Supabase status column is written only AFTER the matching
// external call succeeds. poc_job_title is written once found and reused.
//
// Invoke: POST/GET ?limit=N (default 10, rows across all tables) ?sync=1 (run
// inline & return summary). Default (no sync) -> background task + 202.
// Debug: ?email=<addr> (process only that email, ignore eligibility filter),
//        ?title=<text> (manual title override, skips Apify).
//
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFY_API_TOKEN, AC_API_URL,
//          AC_API_TOKEN; optional APIFY_ACTOR, APIFY_LIMIT.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";
const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN") ?? "";
const APIFY_ACTOR = Deno.env.get("APIFY_ACTOR") ?? "scrapersdelight~decision-maker-email-finder";
const APIFY_LIMIT = parseInt(Deno.env.get("APIFY_LIMIT") ?? "10", 10);

const DEFAULT_LIMIT = 10;
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const APIFY_CALL_RESERVE_MS = parseInt(Deno.env.get("APIFY_CALL_RESERVE_MS") ?? "70000", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface TableCfg {
  table: string;
  firstCol: string;
  lastCol: string;
}
const TABLES: TableCfg[] = [
  { table: "manually_found_leads", firstCol: "first_name", lastCol: "last_name" },
  { table: "ai_scraped_soc_med_leads", firstCol: "first_name", lastCol: "last_name" },
  { table: "manually_found_cold_leads", firstCol: "first_name", lastCol: "last_name" },
  { table: "ai_verified_cold_leads", firstCol: "firstname", lastCol: "lastname" },
];

interface Row {
  id: string | number;
  email: string | null;
  org: string | null;
  poc_job_title: string | null;
  ac_contact_created: string | null;
  first?: string | null;
  last?: string | null;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const domainOf = (email: string): string | null => {
  const m = email.trim().toLowerCase().match(/@([^@\s]+)$/);
  return m ? m[1] : null;
};

// ---- Apify: scan a company domain, return decision-maker records. ----
interface Person {
  first: string;
  last: string;
  title: string | null;
}
async function apifyDomainSearch(domain: string): Promise<Person[] | null> {
  if (!APIFY_API_TOKEN) {
    console.warn("APIFY_API_TOKEN not set -- cannot enrich.");
    return null;
  }
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains: [domain], maxContactsPerDomain: APIFY_LIMIT, maxItems: APIFY_LIMIT, useGoogleFallback: true }),
    });
    if (!res.ok) {
      console.warn(`Apify ${res.status} for ${domain}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const items = await res.json();
    if (!Array.isArray(items)) return [];
    return (items as Record<string, unknown>[]).map((it) => ({
      first: norm(it.firstName ?? ""),
      last: norm(it.lastName ?? ""),
      title: (it.title ?? it.jobTitle ?? it.position ?? it.headline ?? null) as string | null,
    }));
  } catch (err) {
    console.warn(`Apify fetch failed for ${domain}: ${err}`);
    return null;
  }
}

function matchTitle(people: Person[], first: string, last: string): string | null {
  const f = norm(first);
  const l = norm(last);
  if (!f && !l) return null;
  let hit = people.find((p) => p.first === f && p.last === l && !!p.title);
  if (!hit && f && l) hit = people.find((p) => p.last === l && p.first[0] === f[0] && !!p.title);
  const t = hit?.title ? String(hit.title).trim() : "";
  return t || null;
}

// ---- ActiveCampaign helpers ----
const acHeaders = { "Api-Token": AC_API_TOKEN, "Content-Type": "application/json" };

async function acFindContactId(email: string, cachedId: string | null): Promise<string | null> {
  if (cachedId && /^\d+$/.test(cachedId.trim())) return cachedId.trim();
  try {
    const r = await fetch(`${AC_API_URL}/api/3/contacts?email=${encodeURIComponent(email)}`, { headers: acHeaders });
    if (!r.ok) {
      console.warn(`AC contact lookup ${r.status} for ${email}`);
      return null;
    }
    const d = await r.json();
    return Array.isArray(d.contacts) && d.contacts.length > 0 ? String(d.contacts[0].id) : null;
  } catch (err) {
    console.warn(`AC contact lookup failed for ${email}: ${err}`);
    return null;
  }
}

interface AccountLink {
  id: string;
  jobTitle: string | null;
}
async function acGetAccountLinks(contactId: string): Promise<AccountLink[] | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/contacts/${contactId}/accountContacts`, { headers: acHeaders });
    if (!r.ok) {
      console.warn(`AC accountContacts ${r.status} for contact ${contactId}`);
      return null;
    }
    const d = await r.json();
    const list = Array.isArray(d.accountContacts) ? d.accountContacts : [];
    return list.map((a: Record<string, unknown>) => ({ id: String(a.id), jobTitle: (a.jobTitle ?? null) as string | null }));
  } catch (err) {
    console.warn(`AC accountContacts failed for contact ${contactId}: ${err}`);
    return null;
  }
}

async function acSetJobTitle(accountContactId: string, jobTitle: string): Promise<boolean> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/accountContacts/${accountContactId}`, {
      method: "PUT",
      headers: acHeaders,
      body: JSON.stringify({ accountContact: { jobTitle } }),
    });
    if (!r.ok) {
      console.warn(`AC set jobTitle ${r.status} for accountContact ${accountContactId}: ${(await r.text()).slice(0, 160)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`AC set jobTitle failed for accountContact ${accountContactId}: ${err}`);
    return false;
  }
}

type Summary = {
  fn: string;
  limit: number;
  considered: number;
  enriched: number;
  ac_updated: number;
  manually_set: number;
  needs_account: number;
  not_found_in_ac: number;
  no_title_found: number;
  no_domain: number;
  stopped_early: boolean;
  errors: string[];
};

type TitleResult = { kind: "title"; title: string } | { kind: "none" } | { kind: "retry" };
async function resolveTitle(
  db: SupabaseClient,
  cfg: TableCfg,
  row: Row,
  domainCache: Map<string, Person[] | null>,
  runStarted: number,
  s: Summary,
  overrideTitle?: string,
): Promise<TitleResult> {
  const stored = row.poc_job_title?.trim() || null;
  if (stored) return { kind: "title", title: stored };

  if (overrideTitle && overrideTitle.trim()) {
    const title = overrideTitle.trim();
    const { error } = await db.from(cfg.table).update({ poc_job_title: title }).eq("id", row.id);
    if (error) {
      s.errors.push(`${cfg.table}#${row.id} store title: ${error.message}`);
      return { kind: "retry" };
    }
    s.enriched++;
    return { kind: "title", title };
  }

  const domain = domainOf((row.email ?? "").trim());
  if (!domain) {
    s.no_domain++;
    return { kind: "retry" };
  }
  let people = domainCache.get(domain);
  if (people === undefined) {
    if (Date.now() - runStarted > WALL_CLOCK_MS - APIFY_CALL_RESERVE_MS) {
      s.stopped_early = true;
      return { kind: "retry" };
    }
    people = await apifyDomainSearch(domain);
    domainCache.set(domain, people);
    await sleep(500);
  }
  if (people === null) return { kind: "retry" };
  const t = matchTitle(people, row.first ?? "", row.last ?? "");
  if (!t) {
    s.no_title_found++;
    return { kind: "none" };
  }
  const { error } = await db.from(cfg.table).update({ poc_job_title: t }).eq("id", row.id);
  if (error) {
    s.errors.push(`${cfg.table}#${row.id} store title: ${error.message}`);
    return { kind: "retry" };
  }
  s.enriched++;
  return { kind: "title", title: t };
}

async function fillTitle(
  db: SupabaseClient,
  cfg: TableCfg,
  row: Row,
  accountContactId: string,
  domainCache: Map<string, Person[] | null>,
  runStarted: number,
  s: Summary,
  overrideTitle?: string,
): Promise<void> {
  const e = await resolveTitle(db, cfg, row, domainCache, runStarted, s, overrideTitle);
  if (e.kind !== "title") return;
  const ok = await acSetJobTitle(accountContactId, e.title);
  if (!ok) return;
  const { error } = await db.from(cfg.table).update({ ac_job_title_is_updated_date: new Date().toISOString() }).eq("id", row.id);
  if (error) s.errors.push(`${cfg.table}#${row.id} stamp date: ${error.message}`);
  else s.ac_updated++;
}

async function processRow(
  db: SupabaseClient,
  cfg: TableCfg,
  row: Row,
  domainCache: Map<string, Person[] | null>,
  runStarted: number,
  s: Summary,
  overrideTitle?: string,
): Promise<void> {
  const email = (row.email ?? "").trim();
  if (!email) return;

  const contactId = await acFindContactId(email, row.ac_contact_created);
  if (!contactId) {
    s.not_found_in_ac++;
    return;
  }
  const links = await acGetAccountLinks(contactId);
  if (links === null) return;

  if (links.length === 0) {
    // No account link -> hand off to ac-account-contact-sync (no Apify spent here).
    const { error } = await db.from(cfg.table).update({ ac_account_needs_update: true }).eq("id", row.id);
    if (error) s.errors.push(`${cfg.table}#${row.id} needs_account: ${error.message}`);
    else s.needs_account++;
    return;
  }

  const link = links[0];
  const existing = (link.jobTitle ?? "").trim();
  if (existing) {
    const { error } = await db.from(cfg.table).update({ job_title_is_manually_set: true }).eq("id", row.id);
    if (error) s.errors.push(`${cfg.table}#${row.id} manually_set: ${error.message}`);
    else s.manually_set++;
    return;
  }
  await fillTitle(db, cfg, row, link.id, domainCache, runStarted, s, overrideTitle);
}

async function run(limit: number, opts?: { email?: string; title?: string }): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runStarted = Date.now();
  const domainCache = new Map<string, Person[] | null>();
  const targetEmail = opts?.email?.trim() || null;
  const overrideTitle = opts?.title?.trim() || undefined;
  const s: Summary = {
    fn: "ac-poc-position-sync",
    limit,
    considered: 0,
    enriched: 0,
    ac_updated: 0,
    manually_set: 0,
    needs_account: 0,
    not_found_in_ac: 0,
    no_title_found: 0,
    no_domain: 0,
    stopped_early: false,
    errors: [],
  };

  let remaining = limit;
  for (const cfg of TABLES) {
    if (remaining <= 0 || s.stopped_early) break;

    const nameSelect =
      cfg.table === "manually_found_cold_leads"
        ? "first:first_name, alt_first:firstname, last:last_name, alt_last:lastname"
        : `first:${cfg.firstCol}, last:${cfg.lastCol}`;

    let sel = db
      .from(cfg.table)
      .select(`id, email, org, poc_job_title, ac_contact_created, ${nameSelect}`)
      .not("email", "is", null);
    if (targetEmail) {
      sel = sel.eq("email", targetEmail);
    } else {
      sel = sel
        .is("ac_job_title_is_updated_date", null)
        .or("job_title_is_manually_set.is.null,job_title_is_manually_set.eq.false");
    }
    const { data, error } = await sel.order("id", { ascending: true }).limit(remaining);

    if (error) {
      s.errors.push(`select ${cfg.table}: ${error.message}`);
      continue;
    }
    const rows = (data ?? []) as unknown as (Row & { alt_first?: string; alt_last?: string })[];
    for (const r of rows) {
      if (remaining <= 0 || s.stopped_early) break;
      r.first = r.first ?? r.alt_first ?? null;
      r.last = r.last ?? r.alt_last ?? null;
      s.considered++;
      remaining--;
      try {
        await processRow(db, cfg, r, domainCache, runStarted, s, overrideTitle);
      } catch (err) {
        s.errors.push(`${cfg.table}#${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log("ac-poc-position-sync summary:", JSON.stringify(s));
  return s;
}

Deno.serve(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const limitParam = params.get("limit");
  let limit = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  const sync = params.get("sync") === "1" || params.get("sync") === "true";
  const email = params.get("email") ?? undefined;
  const title = params.get("title") ?? undefined;

  if (sync) {
    const summary = await run(limit, { email, title });
    return json({ mode: "sync", ...summary });
  }

  const work = run(limit, { email, title }).catch((e) => console.error("run failed:", e instanceof Error ? e.message : String(e)));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
  return json({ mode: "async", status: "accepted", limit }, 202);
});
