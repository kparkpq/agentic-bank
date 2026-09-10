import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Bank, defaultDatabasePath, defaultFixturePath } from "./index.js";

const path = defaultDatabasePath();
mkdirSync(dirname(path), { recursive: true });
const bank = new Bank(path);
bank.seed(defaultFixturePath());
const accounts = bank.accounts("operator");
console.log(`seeded ${path}`);
for (const a of accounts) {
  console.log(
    `${a.id}\t${a.product}\tavailable=${a.available}\tpending_out=${a.pending_out}`,
  );
}
bank.close();
