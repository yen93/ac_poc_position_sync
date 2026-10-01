// ac-account-contact-sync  (STEP 1 of 2; run BEFORE ac-poc-position-sync)
// Selects leads whose AC contact has NO linked account -- detected by LEFT JOINing
// the local activecampaign_contacts mirror on email and keeping rows where
// b.orgid = '0' -- OR that were explicitly flagged ac_account_needs_update=true.
// For each: if the row's `org` matches an existing AC account, link the account to
// the contact, then fill the Job Title. (Rows we have already linked -- ac_acc_linked
// = true -- are skipped here and left to ac-poc-position-sync.)
//
// Where "Job Title" lives in AC: it is the `jobTitle` attribute of the
// contact<->account link (`accountContacts`). A contact with no linked account has
// nowhere to store a title -- so we create the link first, then fill.
//
// TITLE SOURCE: an OpenAI web-search-grounded lookup (Responses API +
// web_search_preview). It verifies the person's CURRENT title from public sources
// and returns null when unsure (never guesses). The source URL is stored in
// poc_job_title_source; each definitive miss bumps poc_job_title_search_attempts,
// and the lookup is skipped once it reaches MAX_TITLE_ATTEMPTS.
//
// Row selection (per table): email NOT NULL AND ac_acc_linked not true, then kept
//   when activecampaign_contacts.orgid = '0' (no account on the AC contact) OR
//   ac_account_needs_update = true. The email join is case-insensitive.
//   ?email=<addr> ignores this filter entirely (targeted reprocessing).
// Per-row outcomes:
//   - AC contact not found                 -> leave flagged, retryable.
//   - contact already has an account link  -> clear the flag; fill title (empty) or
//                                             mark job_title_is_manually_set (already set).
//   - no org on the row                    -> leave flagged (no_account_match).
//   - org has no matching AC account       -> leave flagged (no_account_match).
//   - org matches an AC account            -> create link (ac_acc_linked=true,
//         ac_account_needs_update=false), then enrich (OpenAI) + PUT jobTitle +
//         stamp ac_job_title_is_updated_date.
//
// Org->account matching is EXACT but diacritic-/whitespace-insensitive (so "Nestle"
// with an accent matches the AC account "Nestle"); typos/variant names do NOT link.
//
// Credit-safe: contact + account resolution happens BEFORE any OpenAI call.
//
// Invoke: POST/GET ?limit=N (default 10) ?sync=1 (inline + summary). Default -> 202.
// Debug: ?email=<addr> (process only that email, ignore the flag filter),
//        ?title=<text> (manual title override, skips enrichment).
//
// Deploy: Supabase MCP deploy_edge_function, verify_jwt:false.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, AC_API_URL,
//          AC_API_TOKEN; optional OPENAI_MODEL, MAX_TITLE_ATTEMPTS.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AC_API_URL = (Deno.env.get("AC_API_URL") ?? "").replace(/\/+$/, "");
const AC_API_TOKEN = Deno.env.get("AC_API_TOKEN") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const MAX_TITLE_ATTEMPTS = parseInt(Deno.env.get("MAX_TITLE_ATTEMPTS") ?? "2", 10);

const DEFAULT_LIMIT = 10;
const WALL_CLOCK_MS = parseInt(Deno.env.get("WALL_CLOCK_MS") ?? "150000", 10);
const OPENAI_CALL_RESERVE_MS = parseInt(Deno.env.get("OPENAI_CALL_RESERVE_MS") ?? "25000", 10);

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
  poc_job_title_search_attempts: number | null;
  ac_contact_created: string | null;
  ac_account_needs_update?: boolean | null;
  first?: string | null;
  last?: string | null;
}

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

// Looks up orgid for each lead email in the local activecampaign_contacts mirror
// (the "b" side of the LEFT JOIN a.email = b.email). The join is case-insensitive:
// we query both the original and lowercased spellings and key the result by lower().
// Returns Map<lower(email) -> orgid>; an email with no mirror row is simply absent.
async function fetchOrgids(db: SupabaseClient, emails: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const variants = new Set<string>();
  for (const e of emails) {
    const t = e.trim();
    if (!t) continue;
    variants.add(t);
    variants.add(t.toLowerCase());
  }
  const list = Array.from(variants);
  const CHUNK = 200;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const { data, error } = await db.from("activecampaign_contacts").select("email, orgid").in("email", slice);
    if (error) {
      console.warn(`activecampaign_contacts orgid lookup: ${error.message}`);
      continue;
    }
    for (const a of (data ?? []) as { email: string | null; orgid: string | null }[]) {
      if (a.email) map.set(a.email.trim().toLowerCase(), (a.orgid ?? "").trim());
    }
  }
  return map;
}

// ---- OpenAI web-search-grounded title lookup ----
interface TitleHit { title: string | null; source: string | null; confidence: string; }

function openaiExtractText(d: unknown): string {
  const doc = d as { output_text?: unknown; output?: unknown };
  if (typeof doc?.output_text === "string" && doc.output_text.trim()) return doc.output_text;
  const parts: string[] = [];
  const out = Array.isArray(doc?.output) ? doc.output : [];
  for (const item of out as Record<string, unknown>[]) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content as Record<string, unknown>[]) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

function parseTitleJson(text: string): TitleHit {
  const fail: TitleHit = { title: null, source: null, confidence: "low" };
  if (!text) return fail;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return fail;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      title: o.title ? String(o.title).trim() : null,
      source: o.source_url ? String(o.source_url).trim() : null,
      confidence: o.confidence ? String(o.confidence).toLowerCase() : "low",
    };
  } catch {
    return fail;
  }
}

async function openaiFindTitle(
  first: string,
  last: string,
  org: string,
  domain: string | null,
): Promise<TitleHit | "retry"> {
  if (!OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY not set -- cannot enrich.");
    return "retry";
  }
  const who = `${first} ${last}`.trim();
  const companyBits = [org, domain ? `(${domain})` : ""].filter(Boolean).join(" ");
  const input =
    `You are verifying a person's CURRENT job title using web search. Only answer if ` +
    `you can verify it from a reputable public source (LinkedIn, the company's own ` +
    `website, a press release, a conference/event bio). If you cannot confidently ` +
    `identify this exact person or their current title, return null for the title -- ` +
    `never guess or infer.\n\n` +
    `Person: ${who || "(unknown)"}\n` +
    `Company: ${companyBits || "(unknown)"}\n\n` +
    `Search the web, then respond with ONLY a compact JSON object and nothing else:\n` +
    `{"title": <string or null>, "source_url": <string or null>, "confidence": "high"|"medium"|"low"}`;
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OPENAI_MODEL, tools: [{ type: "web_search_preview" }], input }),
    });
    if (!r.ok) {
      console.warn(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return "retry";
    }
    const d = await r.json();
    return parseTitleJson(openaiExtractText(d));
  } catch (err) {
    console.warn(`OpenAI fetch failed: ${err}`);
    return "retry";
  }
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
  exhausted: number;
  no_identifiers: number;
  stopped_early: boolean;
  errors: string[];
};

type TitleResult = { kind: "title"; title: string } | { kind: "none" } | { kind: "retry" };
async function resolveTitle(
  db: SupabaseClient,
  cfg: TableCfg,
  row: Row,
  runStarted: number,
  s: Summary,
  overrideTitle?: string,
): Promise<TitleResult> {
  const stored = row.poc_job_title?.trim() || null;
  if (stored) return { kind: "title", title: stored };

  if (overrideTitle && overrideTitle.trim()) {
    const title = overrideTitle.trim();
    const { error } = await db.from(cfg.table).update({ poc_job_title: title, poc_job_title_source: "manual" }).eq("id", row.id);
    if (error) {
      s.errors.push(`${cfg.table}#${row.id} store title: ${error.message}`);
      return { kind: "retry" };
    }
    s.enriched++;
    return { kind: "title", title };
  }

  const org = (row.org ?? "").trim();
  const domain = domainOf((row.email ?? "").trim());
  if (!org && !domain) {
    s.no_identifiers++;
    return { kind: "retry" };
  }
  const attempts = row.poc_job_title_search_attempts ?? 0;
  if (attempts >= MAX_TITLE_ATTEMPTS) {
    s.exhausted++;
    return { kind: "none" };
  }
  if (Date.now() - runStarted > WALL_CLOCK_MS - OPENAI_CALL_RESERVE_MS) {
    s.stopped_early = true;
    return { kind: "retry" };
  }

  const hit = await openaiFindTitle(row.first ?? "", row.last ?? "", org, domain);
  await sleep(300);
  if (hit === "retry") return { kind: "retry" };
  if (!hit.title || hit.confidence === "low") {
    await db.from(cfg.table).update({ poc_job_title_search_attempts: attempts + 1 }).eq("id", row.id);
    s.no_title_found++;
    return { kind: "none" };
  }
  const { error } = await db
    .from(cfg.table)
    .update({ poc_job_title: hit.title, poc_job_title_source: hit.source ?? OPENAI_MODEL })
    .eq("id", row.id);
  if (error) {
    s.errors.push(`${cfg.table}#${row.id} store title: ${error.message}`);
    return { kind: "retry" };
  }
  s.enriched++;
  return { kind: "title", title: hit.title };
}

async function fillTitle(
  db: SupabaseClient,
  cfg: TableCfg,
  row: Row,
  accountContactId: string,
  runStarted: number,
  s: Summary,
  overrideTitle?: string,
): Promise<void> {
  const e = await resolveTitle(db, cfg, row, runStarted, s, overrideTitle);
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
    await fillTitle(db, cfg, row, link.id, runStarted, s, overrideTitle);
    return;
  }

  // No link -> try to match the org to an existing AC account.
  const org = (row.org ?? "").trim();
  if (!org) {
    s.no_account_match++;
    return;
  }
  const account = await acFindAccountByName(org);
  if (!account) {
    s.no_account_match++;
    return;
  }
  const newLinkId = await acCreateAccountContact(contactId, account.id);
  if (!newLinkId) return; // retryable (still flagged)
  const { error: linkErr } = await db
    .from(cfg.table)
    .update({ ac_acc_linked: true, ac_account_needs_update: false })
    .eq("id", row.id);
  if (linkErr) s.errors.push(`${cfg.table}#${row.id} ac_acc_linked: ${linkErr.message}`);
  else s.ac_linked++;
  await fillTitle(db, cfg, row, newLinkId, runStarted, s, overrideTitle);
}

async function run(limit: number, opts?: { email?: string; title?: string }): Promise<Summary> {
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runStarted = Date.now();
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
    exhausted: 0,
    no_identifiers: 0,
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

    // Pull candidate rows: those we have not already linked. The orgid='0' side of
    // the selection lives in activecampaign_contacts, so it is applied in JS below.
    let sel = db
      .from(cfg.table)
      .select(`id, email, org, poc_job_title, poc_job_title_search_attempts, ac_contact_created, ac_account_needs_update, ${nameSelect}`)
      .not("email", "is", null);
    if (targetEmail) {
      sel = sel.eq("email", targetEmail); // targeted reprocessing, ignore the join filter
    } else {
      sel = sel.or("ac_acc_linked.is.null,ac_acc_linked.eq.false");
    }
    const { data, error } = await sel.order("id", { ascending: true });

    if (error) {
      s.errors.push(`select ${cfg.table}: ${error.message}`);
      continue;
    }
    let rows = (data ?? []) as unknown as (Row & { alt_first?: string; alt_last?: string })[];

    // LEFT JOIN activecampaign_contacts b ON lower(a.email)=lower(b.email):
    // keep rows where b.orgid='0' (contact has no AC account) OR ac_account_needs_update=true.
    if (!targetEmail) {
      const emails = rows.map((r) => (r.email ?? "").trim()).filter(Boolean);
      const orgidByEmail = await fetchOrgids(db, emails);
      rows = rows.filter((r) => {
        const orgid = orgidByEmail.get((r.email ?? "").trim().toLowerCase());
        return orgid === "0" || r.ac_account_needs_update === true;
      });
    }

    for (const r of rows) {
      if (remaining <= 0 || s.stopped_early) break;
      r.first = r.first ?? r.alt_first ?? null;
      r.last = r.last ?? r.alt_last ?? null;
      s.considered++;
      remaining--;
      try {
        await processRow(db, cfg, r, runStarted, s, overrideTitle);
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
