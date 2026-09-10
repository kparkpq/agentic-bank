import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, formatWon, useAuth } from "../auth";

type Journal = {
  id: string;
  journal_id?: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  rule_id: string | null;
  why: string | null;
  reason: string | null;
  decision: string | null;
  decision_ref: string | null;
  created_by: string | null;
};

type Confirm = { kind: "approve" | "deny"; row: Journal };

export function PendingPage() {
  const auth = useAuth();
  const [rows, setRows] = useState<Journal[]>([]);
  const [flash, setFlash] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const data = await api<{ pending: Journal[] }>("/api/pending", auth.headers);
    setRows(data.pending.filter((j) => j.decision === "DUAL_CONTROL"));
  }

  useEffect(() => {
    load().catch((e: Error) => setFlash(e.message));
  }, [auth.role, auth.customerId]);

  async function act() {
    if (!confirm) return;
    setBusy(true);
    const audit_id = crypto.randomUUID();
    try {
      const data = await api<{ result: { ok: boolean; copy: string; audit_id: string; decision: string } }>(
        `/api/operator/${confirm.kind}`,
        auth.headers,
        {
          method: "POST",
          body: JSON.stringify({ journal_id: confirm.row.id, audit_id }),
        },
      );
      setFlash(`${data.result.copy} · ${data.result.decision} · audit_id=${data.result.audit_id}`);
      setConfirm(null);
      await load();
    } catch (e) {
      setFlash((e as Error).message);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="flash">추가 승인은 <Link to="/trust-demo">신뢰 검증 화면</Link>에서 운영자 데모 세션으로 서명해 진행합니다.</p>
      {rows.length === 0 ? <div className="empty">대기 중인 이체 없음</div> : null}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>전표</th>
                <th>출금</th>
                <th>입금</th>
                <th className="num">금액</th>
                <th>why</th>
                <th>rule_id</th>
                <th>audit_id</th>
                <th>created_by</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id}>
                  <td className="mono" title={j.id}>
                    {j.id.slice(0, 8)}
                  </td>
                  <td>{j.from_account_id}</td>
                  <td>{j.to_account_id}</td>
                  <td className="num">{formatWon(j.amount)}</td>
                  <td>{j.why ?? j.reason ?? ""}</td>
                  <td>{j.rule_id}</td>
                  <td className="mono">{j.decision_ref}</td>
                  <td className="mono">{j.created_by ?? ""}</td>
                  <td className="actions">
                    {j.created_by === "operator" ? (
                      <span className="pill DENIED">본인 건은 승인할 수 없음</span>
                    ) : (
                      <>
                        <button type="button" onClick={() => { window.location.href = "/trust-demo"; }}>
                          승인
                        </button>
                        <button type="button" className="danger" onClick={() => { window.location.href = "/trust-demo"; }}>
                          거절
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {flash ? <div className="flash">{flash}</div> : null}
      {confirm ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>{confirm.kind === "approve" ? "승인 확인" : "거절 확인"}</h3>
            <p>
              {confirm.row.from_account_id} → {confirm.row.to_account_id} · {formatWon(confirm.row.amount)}
            </p>
            <p className="meta">why {confirm.row.why ?? confirm.row.reason}</p>
            <p className="meta">rule_id {confirm.row.rule_id}</p>
            <p className="meta mono">audit_id {confirm.row.decision_ref}</p>
            <div className="actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(null)}>
                취소
              </button>
              <button
                type="button"
                className={confirm.kind === "deny" ? "danger" : ""}
                disabled={busy}
                onClick={() => act().catch((e: Error) => setFlash(e.message))}
              >
                {confirm.kind === "approve" ? "승인" : "거절"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
