import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { nowUtcIso } from "./time.js";

type FixtureAccount = {
  id: string;
  customer_id: string | null;
  product: string;
  opening_available: number;
};

type Fixture = {
  customers: { id: string; display_name: string }[];
  accounts: FixtureAccount[];
};

export function defaultFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../fixtures/v0.json");
}

export function loadFixture(path = defaultFixturePath()): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function insertCustomers(db: Db, fixture: Fixture): void {
  const insertCustomer = db.prepare(
    "INSERT OR IGNORE INTO customers (id, display_name) VALUES (?, ?)",
  );
  for (const c of fixture.customers) {
    insertCustomer.run(c.id, c.display_name);
  }
}

function insertAccount(db: Db, a: FixtureAccount): void {
  db.prepare("INSERT OR IGNORE INTO accounts (id, customer_id, product, status) VALUES (?, ?, ?, 'OPEN')").run(
    a.id,
    a.customer_id,
    a.product,
  );
}

function writeOpening(
  db: Db,
  houseId: string,
  customerAccounts: FixtureAccount[],
  journalId: string,
  idempotencyKey: string,
  now: Date,
): void {
  const funded = customerAccounts.filter((a) => a.opening_available > 0);
  if (funded.length === 0) return;
  const total = funded.reduce((s, a) => s + a.opening_available, 0);
  const ts = nowUtcIso(now);
  db.prepare(
    `INSERT INTO journals (id, idempotency_key, from_account_id, to_account_id, amount, status, rule_id, reason, created_at, posted_at)
     VALUES (?, ?, ?, ?, ?, 'POSTED', 'SEED_OPENING', 'opening balances vs house equity', ?, ?)`,
  ).run(journalId, idempotencyKey, houseId, funded[0]!.id, total, ts, ts);

  const insertEntry = db.prepare(
    `INSERT INTO entries (id, journal_id, account_id, side, amount, posted, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  insertEntry.run(randomUUID(), journalId, houseId, "DEBIT", total, ts);
  for (const a of funded) {
    insertEntry.run(randomUUID(), journalId, a.id, "CREDIT", a.opening_available, ts);
  }
}

export function seed(db: Db, fixturePath = defaultFixturePath(), now = new Date()): void {
  const fixture = loadFixture(fixturePath);
  insertCustomers(db, fixture);

  const existing = db.prepare("SELECT id FROM accounts").all() as { id: string }[];
  const existingIds = new Set(existing.map((r) => r.id));
  const house = fixture.accounts.find((a) => a.product === "HOUSE");
  if (!house) {
    throw new Error("fixture missing HOUSE contra account");
  }

  if (existingIds.size === 0) {
    for (const a of fixture.accounts) {
      insertAccount(db, a);
    }
    const customerAccounts = fixture.accounts.filter((a) => a.product !== "HOUSE");
    writeOpening(db, house.id, customerAccounts, "journal_seed_opening", "seed:opening:v0", now);
    return;
  }

  const missing = fixture.accounts.filter((a) => !existingIds.has(a.id));
  if (missing.length === 0) return;
  for (const a of missing) {
    insertAccount(db, a);
  }
  const newCustomer = missing.filter((a) => a.product !== "HOUSE");
  if (newCustomer.length > 0) {
    writeOpening(
      db,
      house.id,
      newCustomer,
      `journal_seed_opening_${newCustomer[0]!.id}`,
      `seed:opening:${newCustomer.map((a) => a.id).join("+")}:v0`,
      now,
    );
  }
}
