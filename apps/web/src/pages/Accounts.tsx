import { useEffect, useState } from "react";
import { api, formatWon, useAuth } from "../auth";
import { AccountStatusChip } from "../ui";

type Account = {
  id: string;
  customer_id: string | null;
  product: string;
  status?: "OPEN" | "FROZEN" | "CLOSED";
  available: number;
  pending_out: number;
};

type ToolResult = {
  ok: boolean;
  copy: string;
  decision: string;
  rule_id: string;
  audit_id: string;
  journal_id?: string;
  journal_status?: string;
};

export function AccountsPage() {
  const auth = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agent, setAgent] = useState("teller");
  const [fromId, setFromId] = useState("acc_alice_chk");
  const [toId, setToId] = useState("acc_alice_sav");
  const [amount, setAmount] = useState("100000");
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const data = await api<{ accounts: Account[] }>("/api/accounts", auth.headers);
    setAccounts(data.accounts.filter((a) => a.product !== "HOUSE"));
  }

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  async function start() {
    const data = await api<{ session: { id: string; current_agent: string } }>(
      "/api/sessions",
      auth.headers,
      { method: "POST", body: JSON.stringify({ customer_id: auth.customerId }) },
    );
    setSessionId(data.session.id);
    setAgent(data.session.current_agent);
    setFlash(`세션 ${data.session.id.slice(0, 8)} · 텔러`);
  }

  async function call(action: string, args: Record<string, unknown>) {
    if (!sessionId) throw new Error("세션이 필요합니다");
    const data = await api<{ result: ToolResult }>("/api/tools", auth.headers, {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId, action, args }),
    });
    if (action === "handoff") setAgent(String(args.to));
    setFlash(
      `${data.result.copy}\n${data.result.decision} ${data.result.rule_id}\naudit_id=${data.result.audit_id}${data.result.journal_status ? `\n${data.result.journal_status}` : ""}`,
    );
    await refresh();
    return data.result;
  }

  async function setStatus(accountId: string, status: "OPEN" | "FROZEN" | "CLOSED") {
    const data = await api<{ result: ToolResult; account: Account }>(
      `/api/accounts/${accountId}/status`,
      auth.headers,
      { method: "POST", body: JSON.stringify({ status }) },
    );
    setFlash(`${data.result.copy}\n${data.result.decision} ${data.result.rule_id}\naudit_id=${data.result.audit_id}`);
    await refresh();
  }

  const visible = accounts.filter((a) => a.product !== "HOUSE");

  return (
    <div className="grid">
      <div>
        <table>
          <thead>
            <tr>
              <th>계좌</th>
              <th>고객</th>
              <th>상품</th>
              <th className="num">가용</th>
              <th className="num">대기출금</th>
              <th>상태</th>
              {auth.role === "operator" ? <th>처리</th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.customer_id ?? ""}</td>
                <td>{a.product}</td>
                <td className="num">{formatWon(a.available)}</td>
                <td className="num">{formatWon(a.pending_out)}</td>
                <td>
                  <AccountStatusChip status={a.status ?? "OPEN"} />
                </td>
                {auth.role === "operator" ? (
                  <td className="actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={(a.status ?? "OPEN") === "OPEN"}
                      onClick={() => setStatus(a.id, "OPEN").catch((e: Error) => setFlash(e.message))}
                    >
                      정상
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={(a.status ?? "OPEN") === "FROZEN"}
                      onClick={() => setStatus(a.id, "FROZEN").catch((e: Error) => setFlash(e.message))}
                    >
                      동결
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={(a.status ?? "OPEN") === "CLOSED"}
                      onClick={() => setStatus(a.id, "CLOSED").catch((e: Error) => setFlash(e.message))}
                    >
                      해지
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {error ? <p className="flash">{error}</p> : null}
      </div>
      <div className="panel">
        <h3>에이전트 세션 · {agent}</h3>
        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 0 }}>
          기본은 텔러입니다. 이체/분쟁은 핸드오프 후에만 가능합니다. 텔러는 전표를 남기지 않습니다.
        </p>
        <div className="actions" style={{ marginBottom: 12 }}>
          <button type="button" onClick={() => start().catch((e: Error) => setFlash(e.message))}>
            세션 시작
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!sessionId}
            onClick={() => call("handoff", { to: "transfer" }).catch((e: Error) => setFlash(e.message))}
          >
            이체로 핸드오프
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!sessionId}
            onClick={() => call("handoff", { to: "dispute" }).catch((e: Error) => setFlash(e.message))}
          >
            분쟁으로 핸드오프
          </button>
        </div>
        <label htmlFor="from">출금</label>
        <select id="from" className="field" value={fromId} onChange={(e) => setFromId(e.target.value)}>
          {visible.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <label htmlFor="to">입금</label>
        <select id="to" className="field" value={toId} onChange={(e) => setToId(e.target.value)}>
          {visible.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <label htmlFor="amt">금액 (정수 원)</label>
        <input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={!sessionId}
            onClick={() => call("balance", { account_id: fromId }).catch((e: Error) => setFlash(e.message))}
          >
            잔액
          </button>
          <button
            type="button"
            disabled={!sessionId}
            onClick={() =>
              call("transfer", {
                from_account_id: fromId,
                to_account_id: toId,
                amount: Number(amount),
                idempotency_key: `console:${sessionId}:${fromId}:${toId}:${amount}`,
              }).catch((e: Error) => setFlash(e.message))
            }
          >
            이체
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!sessionId}
            onClick={() =>
              call("open_dispute", { account_id: fromId, reason: "sandbox intake" }).catch((e: Error) =>
                setFlash(e.message),
              )
            }
          >
            분쟁 접수
          </button>
        </div>
        {flash ? <div className="flash">{flash}</div> : null}
      </div>
    </div>
  );
}
