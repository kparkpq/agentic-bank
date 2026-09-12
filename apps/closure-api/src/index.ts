import { serve } from "@hono/node-server";
import { Bank } from "@sapiensq/core";
import { createClosureApp } from "./app.js";
import { ExecutionClosureService } from "./service.js";

const port = Number(process.env.CLOSURE_PORT ?? 3010);
const bank = new Bank(process.env.CLOSURE_DATABASE_PATH ?? ":memory:");
bank.seed();

const service = new ExecutionClosureService(bank);
const app = createClosureApp(service);

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`closure-api listening on http://127.0.0.1:${info.port}\n`);
});
