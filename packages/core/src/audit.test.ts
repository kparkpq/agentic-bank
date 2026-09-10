import { describe, expect, it } from "vitest";
import { redactArgs, writeAudit } from "./audit.js";
import { Bank } from "./bank.js";

describe("audit redact / why / blast_radius", () => {
  it("redacts secret-like keys and stores why + blast_radius", () => {
    expect(redactArgs({ token: "abc", amount: 1 })).toEqual({ token: "[redacted]", amount: 1 });
    const bank = new Bank(":memory:");
    bank.seed();
    const row = writeAudit(bank.db, {
      actor: "agent",
      action: "transfer",
      args: { password: "secret", from_account_id: "acc_alice_chk", to_account_id: "acc_alice_sav" },
      decision: "ALLOW",
      rule_id: "ALLOW",
      reason: "within limits, same customer",
    });
    expect(row.why).toBe("within limits, same customer");
    expect(row.blast_radius).toBe("low");
    expect((row.args as { password: string }).password).toBe("[redacted]");
    bank.close();
  });

  it("redacts email, phone, and rrn keys and synthetic values (never store live PII)", () => {
    expect(
      redactArgs({
        email: "syn_alice@example.test",
        phone: "010-1234-5678",
        rrn: "900101-1234567",
        nested: { mobile: "+82-10-9876-5432", note: "ok" },
        contact: "syn.bob@sandbox.test",
        amount: 100_000,
        from_account_id: "acc_alice_chk",
      }),
    ).toEqual({
      email: "[redacted]",
      phone: "[redacted]",
      rrn: "[redacted]",
      nested: { mobile: "[redacted]", note: "ok" },
      contact: "[redacted]",
      amount: 100_000,
      from_account_id: "acc_alice_chk",
    });
  });

  it("AGENT_TOOL_DENIED writes a non-empty audit_id and stores the row", () => {
    const bank = new Bank(":memory:");
    bank.seed();
    const session = bank.startSession("syn_alice");
    const denied = bank.tool(session.id, "transfer", {
      from_account_id: "acc_alice_chk",
      to_account_id: "acc_alice_sav",
      amount: 100_000,
      email: "syn_alice@example.test",
    });
    expect(denied.ok).toBe(false);
    expect(denied.rule_id).toBe("AGENT_TOOL_DENIED");
    expect(denied.audit_id.length).toBeGreaterThan(0);
    expect(denied.audit_id).not.toBe("");
    expect(denied.journal_id ?? null).toBeNull();
    const row = bank.audit().find((a) => a.audit_id === denied.audit_id);
    expect(row).toBeTruthy();
    expect(row?.decision).toBe("DENY_POLICY");
    expect((row?.args as { email?: string }).email).toBe("[redacted]");
    const traces = bank.traces(session.id) as { args_json: string }[];
    expect(traces.some((t) => t.args_json.includes("syn_alice@example.test"))).toBe(false);
    expect(JSON.parse(traces[0]!.args_json).email).toBe("[redacted]");
    bank.close();
  });
});
