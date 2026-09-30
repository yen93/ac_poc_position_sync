// ac-account-contact-sync  (STEP 2 of 2; run AFTER ac-poc-position-sync)
// Processes leads flagged ac_account_needs_update=true (contacts that exist in AC
// but have no account link). For each: if the row's `org` matches an existing AC
// account, link the account to the contact, then fill the Job Title.
//
// Where "Job Title" lives in AC: it is the `jobTitle` attribute of the
// contact<->account link (`accountContacts`). A contact with no linked account has
// nowhere to store a title -- so we create the link first, then fill.
//
// Per-row outcomes (rows selected by ac_account_needs_update=true):
//   - AC contact not found                 -> leave flagged, retryable (no Apify).
//   - contact already has an account link  -> clear the flag; fill title (empty) or
//                                             mark job_title_is_manually_set (already set).
//   - no org on the row                    -> leave flagged (no_account_match).
//   - org has no matching AC account       -> leave flagged (no_account_match).
//   - org matches an AC account            -> create link (ac_acc_linked=true,
//         ac_account_needs_update=false), then enrich (Apify) + PUT jobTitle +
//         stamp ac_job_title_is_updated_date.
//
// Org->account matching is EXACT but diacritic-/whitespace-insensitive (so "Nestle"
// with an accent matches the AC account "Nestle"); typos/variant names do NOT link,
// to avoid linking a contact to the wrong company.
//
// Credit-safe: contact + account resolution happens BEFORE any Apify call.
//
// Invoke: POST/GET ?limit=N (default 10) ?sync=1 (inline + summary). Default -> 202.
// Debug: ?email=<addr> (process only that email, ignore the flag filter),
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
// Strip combining diacritical marks (U+0300..U+036F) without a \u regex literal.
const stripDiacritics = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x300 || c > 0x36f) out += ch;
  }
  return out;
};
// Account-name key: diacritic-/whitespace-insensitive, EXACT comparison.
const normName = (s: unknown) =>
  stripDiacritics(String(s ?? "").normalize("NFD")).trim().toLowerCase().replace(/\s+/g, " ");
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

// Find an existing AC account whose name EXACTLY matches (diacritic-/whitespace-
// insensitive). Returns null when none matches (or on error).
async function acFindAccountByName(name: string): Promise<{ id: string; name: string } | null> {
  const target = normName(name);
  if (!target) return null;
  try {
    const r = await fetch(`${AC_API_URL}/api/3/accounts?search=${encodeURIComponent(name.trim())}`, { headers: acHeaders });
    if (!r.ok) {
      console.warn(`AC account search ${r.status} for "${name}"`);
      return null;
    }
    const d = await r.json();
    const accts = Array.isArray(d.accounts) ? d.accounts : [];
    const exact = accts.find((a: Record<string, unknown>) => normName(a.name) === target);
    return exact ? { id: String(exact.id), name: String(exact.name) } : null;
  } catch (err) {
    console.warn(`AC account search failed for "${name}": ${err}`);
    return null;
  }
}

// Create a contact<->account link. Returns the new accountContact id, or null.
async function acCreateAccountContact(contactId: string, accountId: string): Promise<string | null> {
  try {
    const r = await fetch(`${AC_API_URL}/api/3/accountContacts`, {
      method: "POST",
      headers: acHeaders,
      body: JSON.stringify({ accountContact: { contact: contactId, account: accountId } }),
    });
    if (!r.ok) {
      console.warn(`AC create accountContact ${r.status} (contact ${contactId} account ${accountId}): ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    const d = await r.json();
    return d.accountContact?.id ? String(d.accountContact.id) : null;
  } catch (err) {
    console.warn(`AC create accountContact failed (contact ${contactId} account ${accountId}): ${err}`);
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
  ac_linked: number;
  ac_updated: number;
  enriched: number;
  manually_set: number;
  no_account_match: number;
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
    return; // leave flagged, retryable
  }
  const links = await acGetAccountLinks(contactId);
  if (links === null) return;

  // Already linked (e.g. linked meanwhile) -> clear the flag and handle the title.
  if (links.length > 0) {
    const link = links[0];
    const existing = (link.jobTitle ?? "").trim();
    const { error } = await db.from(cfg.table).update({ ac_account_needs_update: false, ac_acc_linked: true }).eq("id", row.id);
    if (error) s.errors.push(`${cfg.table}#${row.id} clear flag: ${error.message}`);
    if (existing) {
      const { error: e2 } = await db.from(cfg.table).update({ job_title_is_manually_set: true }).eq("id", row.id);
      if (e2) s.errors.push(`${cfg.table}#${row.id} manually_set: ${e2.message}`);
      else s.manually_set++;
      return;
    }
    await fillTitle(db, cfg, row, link.id, domainCache, runStarted, s, overrideTitle);
    return;
  }

  // No link -> try to match the org to an existing AC account.
  const org = (row.org ?? "").trim();
  if (!org) {
    s.no_account_match++;
    return; // leave flagged
  }
  const account = await acFindAccountByName(org);
  if (!account) {
    s.no_account_match++;
    return; // leave flagged; org has no matching AC account
  }
  const newLinkId = await acCreateAccountContact(contactId, account.id);
  if (!newLinkId) return; // link creation failed -> retryable (still flagged)
  const { error: linkErr } = await db
    .from(cfg.table)
    .update({ ac_acc_linked: true, ac_account_needs_update: false })
    .eq("id", row.id);
  if (linkErr) s.errors.push(`${cfg.table}#${row.id} ac_acc_linked: ${linkErr.message}`);
  else s.ac_linked++;
  await fillTitle(db, cfg, row, newLinkId, domainCache, runStarted, s, overrideTitle);
}

async function run(limit: number, opts?: { email?: string; title?: string }): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runStarted = Date.now();
  const domainCache = new Map<string, Person[] | null>();
  const targetEmail = opts?.email?.trim() || null;
  const overrideTitle = opts?.title?.trim() || undefined;
  const s: Summary = {
    fn: "ac-account-contact-sync",
    limit,
    considered: 0,
    ac_linked: 0,
    ac_updated: 0,
    enriched: 0,
    manually_set: 0,
    no_account_match: 0,
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
      sel = sel.eq("email", targetEmail); // targeted reprocessing, ignore the flag filter
    } else {
      sel = sel.eq("ac_account_needs_update", true);
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

  console.log("ac-account-contact-sync summary:", JSON.stringify(s));
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
