// The name check, against the columns of public sample schemas (R558).
//
// Where a column's values have no shape (a person's name, a postal address, a
// date of birth, a password hash), its name is the only thing that says it is
// personal, and the catalog, the dataset page, share sweeps and quality
// findings all act on that. This holds the name check to real schemas, every
// column of each table listed, instead of to names made up for a test.
//
// Measured before R558, on this same list: 35 of 253 columns judged wrong.
// - 15 missed: every password and token column (`password`, `PasswordHash`,
//   `encrypted_password`, `recovery_token`), and `Fax`, `MiddleName`,
//   `ContactName`, `ca_zip`, `address2`.
// - 4 of the wrong kind: tokens sent to confirm an email or phone change were
//   "email addresses" or "phone numbers"; `c_birth_country` was "dates of birth".
// - 16 marked for what they only point at, time or describe: `address_id` (four
//   tables), `PhoneNumberTypeID`, `CreditCardID`, `email_confirmed_at`,
//   `ca_street_type`.
//
// Over-inclusive where the values settle it: a name with "email" in it stays
// flagged whatever follows (`EmailPromotion`, `EmailAddressID`), because in
// common usage an "email id" IS an address, and an email column's values
// always show an @, so ten values that show none overrule the name.
import { describe, expect, it } from "vitest";

import { piiNameKind } from "@/lib/piiHeuristic";

import { SCHEMAS } from "../fixtures/piiNameCorpus";

const ROWS = Object.entries(SCHEMAS).flatMap(([table, rows]) =>
  rows.map(([column, expected]) => ({ table, column, expected })),
);

describe("the name check on public sample schemas", () => {
  it.each(ROWS)("$column ($table) → $expected", ({ column, expected }) => {
    expect(piiNameKind(column)).toBe(expected);
  });

  it("covers the list the log measured", () => {
    expect(ROWS.length).toBe(253);
  });
});
