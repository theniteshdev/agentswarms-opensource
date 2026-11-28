// The catalog's stored personal-data verdicts, judged again when the rules
// change (R559).
//
// A crawl judges every column it lists (crawler.server.ts). Between crawls,
// and for ever on a source crawled only by hand, the catalog kept the verdicts
// of the rules it was last crawled under. After R558 found password hashes by
// their names, a users table crawled before still kept one hash as its column's
// catalog sample, readable by everyone its catalog source is shared with, until
// its owner happened to crawl it again.
//
// This pass judges again every stored asset whose columns were judged under
// older rules, as far as that can be done without reading the data: crawl's
// own `classify` with no values. A column judged by its name is judged by its
// name again; one judged from its values keeps that verdict and gains only
// what its name now says where those values could not have said otherwise
// (nameFindingWithoutValues). The database drops what a newly marked column
// kept of its values (R556's trigger, and keepableColumn here), and the asset
// records the rules, so it is not judged again until they change. Values
// judged under older rules are read again by the next crawl that can.
//
// Tenant-safe with the service role: each row is written from its own content
// and nothing else, so no owner's data reaches another's.
import { parseAssetMetadata } from "@/lib/catalogAssetMetadata";
import { keepableColumn } from "@/lib/catalogColumnValues";
import { PERSONAL_DATA_RULES } from "@/lib/sensitiveData";
import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classify, type CatalogColumn } from "@/utils/catalog/crawler.server";

/** Assets judged in one pass. A larger catalog takes several passes, one after another. */
export const ASSETS_PER_PASS = 200;
/** How long a pass that found nothing more to do waits before looking again. */
const IDLE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type JudgeAgainResult = {
  /** Assets looked at. */
  checked: number;
  /** Of those, assets whose verdicts changed. */
  changed: number;
  /** Assets a crawl wrote while this pass judged them; the crawl's verdicts stand. */
  skipped: number;
  /** Assets that could not be written. */
  failed: number;
  /** A full batch: more may be waiting. */
  more: boolean;
};

/** What a column's verdict and kept values are, for telling whether anything changed. */
const verdictOf = (c: CatalogColumn) => [
  c.name,
  !!c.pii,
  c.pii_kind ?? null,
  c.pii_evidence ?? null,
  c.sample ?? null,
  c.min ?? null,
  c.max ?? null,
];

/** The stored columns, judged again by the current rules without reading the data. */
export function judgedAgain(stored: readonly CatalogColumn[]): {
  columns: CatalogColumn[];
  pii: boolean;
} {
  const { columns } = classify(stored);
  const kept = columns.map(keepableColumn);
  return { columns: kept, pii: kept.some((c) => c.pii) };
}

/**
 * One batch of stored assets not yet judged under the current rules, judged
 * again. A crawl that writes an asset meanwhile wins: the write here is made
 * only if the asset was not crawled since it was read.
 */
export async function judgeCatalogAgain(opts: { limit?: number } = {}): Promise<JudgeAgainResult> {
  const limit = opts.limit ?? ASSETS_PER_PASS;
  const { data, error } = await supabaseAdmin
    .from("catalog_assets")
    .select("id, columns, pii, metadata, last_crawled_at")
    .not("metadata", "cs", JSON.stringify({ pii_rules: PERSONAL_DATA_RULES }))
    .order("id")
    .limit(limit);
  if (error) throw new Error(`could not list catalog assets: ${error.message}`);
  const rows = data ?? [];
  const out: JudgeAgainResult = {
    checked: rows.length,
    changed: 0,
    skipped: 0,
    failed: 0,
    more: rows.length >= limit,
  };
  for (const row of rows) {
    const stored = (Array.isArray(row.columns) ? row.columns : []) as CatalogColumn[];
    const { columns, pii } = judgedAgain(stored);
    const changed =
      pii !== row.pii ||
      JSON.stringify(columns.map(verdictOf)) !== JSON.stringify(stored.map(verdictOf));
    const metadata = { ...parseAssetMetadata(row.metadata), pii_rules: PERSONAL_DATA_RULES };
    const { data: written, error: writeErr } = await supabaseAdmin
      .from("catalog_assets")
      .update({
        ...(changed ? { columns: columns as unknown as Json, pii } : {}),
        metadata: metadata as unknown as Json,
      })
      .eq("id", row.id)
      .eq("last_crawled_at", row.last_crawled_at)
      .select("id");
    if (writeErr) {
      out.failed++;
      console.warn(`[catalog] could not judge asset ${row.id} again: ${writeErr.message}`);
    } else if (!written?.length) out.skipped++;
    else if (changed) out.changed++;
  }
  return out;
}

let lastIdle = 0;

/**
 * The scheduler's step: a batch each pass while there is a backlog (after the
 * rules change, the first pass of the new build), then a look every few hours
 * for assets written by something other than a crawl.
 */
export async function sweepCatalogRules(force = false): Promise<JudgeAgainResult | null> {
  if (!force && Date.now() - lastIdle < IDLE_INTERVAL_MS) return null;
  const r = await judgeCatalogAgain();
  // A full batch: the next pass takes the next one, however recently the
  // last look found nothing.
  lastIdle = r.more ? 0 : Date.now();
  if (r.changed || r.failed) {
    console.log(
      `[catalog] personal data judged again under rules ${PERSONAL_DATA_RULES}: ${r.checked} asset(s), ${r.changed} changed, ${r.skipped} crawled meanwhile, ${r.failed} failed`,
    );
  }
  return r;
}
