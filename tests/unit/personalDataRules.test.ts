// What the catalog stores about personal data follows the rules that judge it
// (R559).
//
// FOUND AFTER R558. The catalog stores each column's verdict. A crawl judges
// what it reads; but an unchanged lake file is not read again and its verdict
// from values was kept as it was, so R558's new rules never reached it, and a
// source crawled only by hand kept every verdict of the rules it was crawled
// under: a users table's `password_hash` stayed unmarked, with one hash kept
// as its catalog sample, readable by everyone the source is shared with.
//
// Held here:
// - the rules carry a version, and changing what any column is judged to hold
//   without raising it fails the fingerprint below;
// - a verdict read from values records the rules it was read under, and an
//   unchanged file judged under older ones is read again, once;
// - without values, what the name now says is added where the values could
//   not have said otherwise, and nothing is taken away;
// - a background pass judges every stored asset again under new rules, drops
//   what a newly marked column kept of its values, and stamps the asset;
// - a crawl that writes the asset meanwhile wins.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyColumn, nameFindingWithoutValues, PERSONAL_DATA_RULES } from "@/lib/sensitiveData";

import { SCHEMAS } from "../fixtures/piiNameCorpus";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";

const h = vi.hoisted(() => ({
  db: null as unknown as { from: unknown },
  objects: [] as Array<{ key: string; size: number; last_modified: string }>,
  csv: "",
  sampled: [] as string[],
  failRead: false,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.db;
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/catalog/objectStore.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/catalog/objectStore.server")>()),
  listObjectsCapped: async () => ({ objects: h.objects, capped: false }),
  sampleObject: async (_cfg: unknown, key: string) => {
    h.sampled.push(key);
    if (h.failRead) throw new Error("Access Denied");
    return Buffer.from(h.csv, "utf8");
  },
}));

const { classify, crawlObjectStorage, persistAssets } =
  await import("@/utils/catalog/crawler.server");
const { ASSETS_PER_PASS, judgeCatalogAgain, judgedAgain, sweepCatalogRules } =
  await import("@/utils/catalog/personalDataRules.server");

type Col = Record<string, unknown> & { name: string; type: string };
const col = (cols: readonly Col[], name: string) => cols.find((c) => c.name === name)!;

// ── The version ─────────────────────────────────────────────────────────────

/**
 * Columns whose verdicts, taken together, are the rules: every corpus name
 * judged by name, and columns of values down each path the values can take.
 * Not real data: made-up addresses, numbers that pass or fail their checks.
 */
function verdicts(): Array<[string, string | null]> {
  const byName = Object.values(SCHEMAS)
    .flat()
    .map(([name]): [string, string | null] => [name, classifyColumn(name, [])?.kind ?? null]);
  const n = (k: number, f: (i: number) => unknown) => Array.from({ length: k }, (_, i) => f(i));
  const withValues: Array<[string, unknown[]]> = [
    ["contact", n(12, (i) => `p${i}@example.com`)],
    ["notes", n(12, (i) => (i % 3 ? "call back" : `write to p${i}@example.com`))],
    ["email_campaign_id", n(12, (i) => 7000 + i)],
    ["email", n(4, (i) => 7000 + i)],
    ["phone_opt_in", [true, false, true]],
    ["phone_opt_in_two", [true, false]],
    ["gender", [true, false, true, false]],
    [
      "account",
      ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606"],
    ],
    ["sku", ["GB82WEST12345698765431", "GB00AAAA00000000000000", "DE00370400440532013000"]],
    ["ref", ["4111 1111 1111 1111", "5500 0000 0000 0004", "3400 0000 0000 009"]],
    ["host", ["10.0.0.1", "192.168.1.20", "172.16.4.4"]],
    ["caller", ["(415) 555-2671", "415-555-2671", "+44 7700 900123"]],
    // Built from prefix + body so no secret-shaped literal sits in the file
    // (push protection blocks `sk_live_`); invented, never a credential.
    [
      "key",
      [`sk${"_live_51Hx"}XXXXXXXXXXXXXXXXXXXXXX`, `sk${"_live_51Hy"}XXXXXXXXXXXXXXXXXXXXXX`, "x"],
    ],
    ["tax", ["123-45-6789", "987-65-4320", "234-56-7891"]],
    ["blank", [null, "", null]],
    ["password_hash", n(5, (i) => `$2b$12$abcdefghijklmnopqrstu${i}`)],
  ];
  return [
    ...byName,
    ...withValues.map(([name, values]): [string, string | null] => [
      `${name}*`,
      classifyColumn(name, values)?.kind ?? null,
    ]),
  ];
}

/**
 * The verdicts each version of the rules gives. Raise PERSONAL_DATA_RULES in
 * src/lib/sensitiveData.ts and add a line here when this test fails: the
 * catalog only judges again what was judged under an older version.
 */
const FINGERPRINTS: Record<number, string> = {
  2: "28e429b5a2820a80",
};

describe("the rules' version", () => {
  it("is raised whenever any column is judged differently", () => {
    const now = createHash("sha256").update(JSON.stringify(verdicts())).digest("hex").slice(0, 16);
    expect(
      now,
      `the personal-data rules judge some column differently: raise PERSONAL_DATA_RULES (now ${PERSONAL_DATA_RULES}) and record ${now} for it in FINGERPRINTS`,
    ).toBe(FINGERPRINTS[PERSONAL_DATA_RULES]);
  });

  it("is 2 since R558", () => {
    expect(PERSONAL_DATA_RULES).toBe(2);
  });
});

// ── Without values ──────────────────────────────────────────────────────────

describe("what a name says when the values cannot be read again", () => {
  it("adds what only a name can show", () => {
    expect(nameFindingWithoutValues("password_hash", false)?.kind).toBe("password");
    expect(nameFindingWithoutValues("email_change_token", false)?.kind).toBe("secret");
    expect(nameFindingWithoutValues("Fax", false)?.kind).toBe("phone");
    expect(nameFindingWithoutValues("password_hash", false)?.evidence).toBe(
      "Its name suggests passwords or password hashes.",
    );
  });

  it("leaves to the values what values settle", () => {
    // Values that showed no @ may have overruled the name.
    expect(nameFindingWithoutValues("email", false)).toBeNull();
    expect(nameFindingWithoutValues("ip_address", false)).toBeNull();
    // A column of true and false holds none of it, gender aside.
    expect(nameFindingWithoutValues("password_set", true)).toBeNull();
    expect(nameFindingWithoutValues("gender", true)?.kind).toBe("gender");
    expect(nameFindingWithoutValues("address_id", false)).toBeNull();
  });
});

/** A column judged from its values before R559: no `pii_rules`, so rules 1. */
const old = (c: Col): Col => ({ pii_from_values: true, ...c });

describe("a stored verdict judged again", () => {
  it("is the name's again when the name decided it", () => {
    const { columns } = classify([
      { name: "address_id", type: "number", pii: true, pii_kind: "address", pii_evidence: "x" },
      { name: "Fax", type: "string" },
    ]);
    expect(col(columns, "address_id").pii).toBeUndefined();
    expect(col(columns, "Fax")).toMatchObject({ pii: true, pii_kind: "phone" });
  });

  it("from older values, gains what its name now says", () => {
    const { columns, pii } = classify([
      old({ name: "password_hash", type: "string", sample: "$2b$12$abc" }),
    ]);
    expect(pii).toBe(true);
    expect(col(columns, "password_hash")).toMatchObject({
      pii: true,
      pii_kind: "password",
      pii_evidence: "Its name suggests passwords or password hashes.",
      // Still says its values were read under the old rules: read again when possible.
      pii_from_values: true,
    });
    expect(col(columns, "password_hash").pii_rules).toBeUndefined();
  });

  it("from older values, loses nothing", () => {
    const { columns } = classify([
      old({
        name: "address_id",
        type: "number",
        pii: true,
        pii_kind: "address",
        pii_evidence: "x",
      }),
      old({
        name: "c_birth_country",
        type: "string",
        pii: true,
        pii_kind: "birth_date",
        pii_evidence: "y",
      }),
    ]);
    expect(col(columns, "address_id")).toMatchObject({ pii: true, pii_kind: "address" });
    expect(col(columns, "c_birth_country")).toMatchObject({ pii: true, pii_kind: "birth_date" });
  });

  it("from older values, gains nothing the values settle", () => {
    const { columns } = classify([
      old({ name: "email_campaign_id", type: "number" }),
      old({ name: "password_set", type: "boolean" }),
      old({ name: "PasswordResetRequired", type: "string", sample: "false" }),
    ]);
    for (const c of columns) expect(c.pii).toBeUndefined();
  });

  it("from values under the current rules, stays as it is", () => {
    const { columns } = classify([
      {
        name: "password_hash",
        type: "string",
        pii_from_values: true,
        pii_rules: PERSONAL_DATA_RULES,
      },
    ]);
    expect(col(columns, "password_hash").pii).toBeUndefined();
  });

  it("drops what a newly marked column kept of its values", () => {
    const { columns, pii } = judgedAgain([
      old({
        name: "password_hash",
        type: "string",
        sample: "$2b$12$abc",
        distinct_count: 5,
      }) as never,
      { name: "id", type: "number", sample: "7", min: 1, max: 9 } as never,
    ]);
    expect(pii).toBe(true);
    expect(col(columns as Col[], "password_hash")).not.toHaveProperty("sample");
    expect(col(columns as Col[], "id")).toMatchObject({ sample: "7", min: 1, max: 9 });
  });
});

// ── A lake file ─────────────────────────────────────────────────────────────

const CFG = { provider: "minio", bucket: "lake" } as never;
const OLD = "2026-11-01T00:00:00.000Z";
const SINCE = "2026-11-20T00:00:00.000Z";
const CSV =
  [
    "id,username,password_hash,address_id",
    ...Array.from({ length: 12 }, (_, i) => `${i},u${i},$2b$12$hash${i},${100 + i}`),
  ].join("\n") + "\n";

describe("an unchanged lake file judged under older rules", () => {
  beforeEach(() => {
    h.objects = [{ key: "app/users.csv", size: 2048, last_modified: OLD }];
    h.csv = CSV;
    h.sampled = [];
    h.failRead = false;
  });

  /** What a crawl under R555–R558 stored for it: values read, no rules recorded. */
  const stored = (fqn: string) =>
    new Map([
      [
        fqn,
        {
          columns: [
            old({ name: "id", type: "number" }),
            old({ name: "username", type: "string" }),
            old({ name: "password_hash", type: "string", sample: "$2b$12$hash0" }),
            old({
              name: "address_id",
              type: "number",
              pii: true,
              pii_kind: "address",
              pii_evidence: "Its name suggests postal addresses.",
            }),
          ],
          row_count: 12,
          row_count_estimated: false,
          pii_values_read: true,
        },
      ],
    ]) as never;

  it("is read again, once", async () => {
    const fqn = (await crawlObjectStorage(CFG)).assets[0].fqn;
    h.sampled = [];
    const again = (await crawlObjectStorage(CFG, stored(fqn), SINCE)).assets[0];
    expect(h.sampled).toEqual(["app/users.csv"]);
    expect(col(again.columns as Col[], "password_hash")).toMatchObject({
      pii: true,
      pii_kind: "password",
      pii_rules: PERSONAL_DATA_RULES,
    });
    expect(col(again.columns as Col[], "address_id").pii).toBeUndefined();

    h.sampled = [];
    const prior = new Map([
      [
        fqn,
        {
          columns: again.columns,
          row_count: 12,
          row_count_estimated: false,
          pii_values_read: true,
        },
      ],
    ]);
    const third = (await crawlObjectStorage(CFG, prior, SINCE)).assets[0];
    expect(h.sampled).toEqual([]);
    expect(col(third.columns as Col[], "password_hash")).toMatchObject({ pii: true });
  });

  it("keeps what is held of it when the read fails", async () => {
    const fqn = (await crawlObjectStorage(CFG)).assets[0].fqn;
    h.sampled = [];
    h.failRead = true;
    const again = (await crawlObjectStorage(CFG, stored(fqn), SINCE)).assets[0];
    expect(h.sampled).toEqual(["app/users.csv"]);
    expect(again.columns.map((c) => c.name)).toEqual([
      "id",
      "username",
      "password_hash",
      "address_id",
    ]);
    expect(again.row_count).toBe(12);
    // What its name now says, and nothing taken away until it can be read.
    expect(col(again.columns as Col[], "password_hash")).toMatchObject({
      pii: true,
      pii_kind: "password",
    });
    expect(col(again.columns as Col[], "address_id")).toMatchObject({ pii: true });
    expect(again.metadata).toMatchObject({ pii_values_read: true });
  });
});

// ── Where it is stored ──────────────────────────────────────────────────────

let db: FakeDb;
const T0 = "2026-11-20T10:00:00.000Z";

const asset = (
  id: string,
  columns: Col[],
  metadata: Record<string, unknown> = {},
  pii = false,
) => ({
  id,
  user_id: `owner-${id}`,
  source_id: "src-1",
  fqn: `t_${id}`,
  columns,
  pii,
  metadata,
  last_crawled_at: T0,
});

const row = (id: string) =>
  db.tables.catalog_assets.find((r) => r.id === id)! as Record<string, unknown>;

describe("a crawl", () => {
  it("records the rules its assets were judged under", async () => {
    db = fakePostgrest({ catalog_assets: [], catalog_schema_versions: [] });
    h.db = db.client;
    await persistAssets(
      "owner-1",
      "src-1",
      [
        {
          asset_type: "dataset",
          schema_name: "app",
          name: "users",
          fqn: "app/*.csv",
          columns: [{ name: "id", type: "number" }],
          row_count: 1,
          size_bytes: 1,
          format: "csv",
          file_count: 1,
          pii: false,
          metadata: { pii_values_read: true },
        },
      ],
      [],
    );
    expect(db.tables.catalog_assets[0].metadata).toEqual({
      pii_values_read: true,
      pii_rules: PERSONAL_DATA_RULES,
    });
  });
});

describe("the background pass", () => {
  beforeEach(() => {
    db = fakePostgrest({
      catalog_assets: [
        asset(
          "a1",
          [
            { name: "Fax", type: "string", sample: "+44 20 7946 0958" },
            {
              name: "address_id",
              type: "number",
              pii: true,
              pii_kind: "address",
              pii_evidence: "x",
            },
            old({ name: "password_hash", type: "string", sample: "$2b$12$abc" }),
          ],
          { location: "lake/app" },
          true,
        ),
        asset("a2", [{ name: "Fax", type: "string", sample: "+44" }], {
          pii_rules: PERSONAL_DATA_RULES,
        }),
        asset("a3", [{ name: "id", type: "number", sample: "1" }]),
      ],
    });
    h.db = db.client;
  });

  it("judges every asset judged under older rules, and stamps it", async () => {
    const r = await judgeCatalogAgain();
    expect(r).toEqual({ checked: 2, changed: 1, skipped: 0, failed: 0, more: false });
    const a1 = row("a1");
    const cols = a1.columns as Col[];
    expect(col(cols, "Fax")).toMatchObject({ pii: true, pii_kind: "phone" });
    expect(col(cols, "Fax")).not.toHaveProperty("sample");
    expect(col(cols, "address_id").pii).toBeUndefined();
    expect(col(cols, "password_hash")).toMatchObject({ pii: true, pii_kind: "password" });
    expect(col(cols, "password_hash")).not.toHaveProperty("sample");
    expect(a1.pii).toBe(true);
    expect(a1.metadata).toEqual({ location: "lake/app", pii_rules: PERSONAL_DATA_RULES });
    // Nothing to change: only the stamp.
    expect(row("a3").columns).toEqual([{ name: "id", type: "number", sample: "1" }]);
    expect(row("a3").metadata).toEqual({ pii_rules: PERSONAL_DATA_RULES });
    // Judged under the current rules already: not touched (its Fax keeps its sample).
    expect(row("a2").columns).toEqual([{ name: "Fax", type: "string", sample: "+44" }]);
  });

  it("does nothing the second time", async () => {
    await judgeCatalogAgain();
    const writes = db.log.filter((l) => l.startsWith("update")).length;
    const r = await judgeCatalogAgain();
    expect(r.checked).toBe(0);
    expect(db.log.filter((l) => l.startsWith("update")).length).toBe(writes);
  });

  it("goes a batch at a time and says when there may be more", async () => {
    expect((await judgeCatalogAgain({ limit: 1 })).more).toBe(true);
    expect((await judgeCatalogAgain({ limit: 1 })).more).toBe(true);
    expect(await judgeCatalogAgain({ limit: 1 })).toMatchObject({ checked: 0, more: false });
  });

  it("leaves an asset a crawl wrote meanwhile to the crawl", async () => {
    const LATER = "2026-11-20T10:05:00.000Z";
    const from = db.client.from;
    h.db = {
      from(name: string) {
        const q = from(name) as unknown as Record<string, (...a: unknown[]) => unknown>;
        const update = q.update;
        const eq = q.eq;
        let updating = false;
        q.update = (p: unknown) => {
          updating = true;
          return update(p);
        };
        q.eq = (c: unknown, v: unknown) => {
          if (updating && c === "id" && v === "a1") {
            Object.assign(row("a1"), {
              last_crawled_at: LATER,
              columns: [{ name: "Fax", type: "string", pii: true, pii_kind: "phone" }],
              metadata: { pii_rules: PERSONAL_DATA_RULES },
            });
          }
          return eq(c, v);
        };
        return q;
      },
    };
    const r = await judgeCatalogAgain();
    expect(r).toMatchObject({ checked: 2, skipped: 1, changed: 0 });
    expect(row("a1").columns).toEqual([
      { name: "Fax", type: "string", pii: true, pii_kind: "phone" },
    ]);
  });

  it("runs from the scheduler, a batch a pass while there is more, then every few hours", async () => {
    expect(readFileSync("src/utils/bi/refresh.server.ts", "utf8")).toMatch(
      /"catalog-personal-rules",[\s\S]{0,200}sweepCatalogRules\(force\)/,
    );
    expect(await sweepCatalogRules(true)).toMatchObject({ checked: 2, more: false });
    expect(await sweepCatalogRules()).toBeNull();
    expect(await sweepCatalogRules(true)).toMatchObject({ checked: 0 });

    // A backlog bigger than a batch: the next pass goes on, without waiting
    // for the hours a quiet look waits.
    const many = Array.from({ length: ASSETS_PER_PASS + 1 }, (_, i) =>
      asset(`b${String(i).padStart(4, "0")}`, [{ name: "Fax", type: "string" }]),
    );
    db = fakePostgrest({ catalog_assets: many });
    h.db = db.client;
    expect(await sweepCatalogRules(true)).toMatchObject({ checked: ASSETS_PER_PASS, more: true });
    expect(await sweepCatalogRules()).toMatchObject({ checked: 1, more: false });
    expect(await sweepCatalogRules()).toBeNull();
  });
});
