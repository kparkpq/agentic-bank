import { useEffect, useState } from "react";
import { api, useAuth } from "../auth";
import { formatSeoul } from "../ui";

type Row = {
  audit_id: string;
  timestamp: string;
  actor: string;
  action: string;
  decision: string;
  rule_id: string;
  why: string;
  reason: string;
  blast_radius?: string;
  journal_id: string | null;
  idempotency_key: string | null;
};

export function AuditPage() {
  const auth = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ audit: Row[] }>("/api/audit", auth.headers)
      .then((d) => setRows(d.audit))
      .catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>audit_id</th>
            <th>시각</th>
            <th>행위자</th>
            <th>동작</th>
            <th>결정</th>
            <th>why</th>
            <th>blast_radius</th>
            <th>rule_id</th>
            <th>journal_id</th>
            <th>idempotency_key</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.audit_id}>
              <td className="mono" title={r.audit_id}>
                {r.audit_id}
              </td>
              <td>{formatSeoul(r.timestamp)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td className={r.decision}>{r.decision}</td>
              <td>{r.why ?? r.reason}</td>
              <td className="mono">{r.blast_radius ?? ""}</td>
              <td>{r.rule_id}</td>
              <td className="mono">{r.journal_id ?? ""}</td>
              <td className="mono">{r.idempotency_key ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="flash">{error}</p> : null}
    </div>
  );
}
