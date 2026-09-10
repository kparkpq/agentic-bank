import { useEffect, useState } from "react";
import { api, formatWon, useAuth } from "../auth";
import { StatusChip, TransferTimeline, formatSeoul, type TransferStep } from "../ui";

type Execution = {
  id: string;
  kind: string;
  title: string;
  counterparty: string;
  from_label?: string;
  to_label?: string;
  amount: number;
  amount_label?: string;
  status: string;
  copy: string;
  why: string;
  created_at: string;
  timeline?: TransferStep[];
  rail_note?: string;
};

export function ActivityPage() {
  const auth = useAuth();
  const [rows, setRows] = useState<Execution[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ executions: Execution[] }>("/api/activity", auth.headers)
      .then((d) => {
        setRows(d.executions);
        setOpenId((cur) => cur ?? d.executions[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  const selected = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="customer activity-layout" data-testid="page-activity">
      <div className="table-wrap">
        {rows.length === 0 ? <p className="empty">아직 실행한 기록이 없습니다.</p> : null}
        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>내용</th>
                <th>출금 → 입금</th>
                <th className="num">금액</th>
                <th>상태</th>
                <th>시각</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`clickable${r.id === openId ? " selected" : ""}`}
                  onClick={() => setOpenId(r.id)}
                >
                  <td>{r.title}</td>
                  <td>{r.counterparty}</td>
                  <td className="num">
                    {r.kind === "enrollment" ? "—" : r.amount_label || formatWon(r.amount)}
                  </td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td>{formatSeoul(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {error ? <p className="flash">{error}</p> : null}
      </div>
      <div className="panel" data-testid="audit-why">
        {selected ? (
          <>
            <h3>실행 상세</h3>
            <p>
              <StatusChip status={selected.status} />
            </p>
            <p className="why">{selected.title}</p>
            {selected.kind === "transfer" ? (
              <p className="route">
                <span>{selected.from_label || selected.counterparty}</span>
                {selected.to_label ? (
                  <>
                    <span className="route-arrow" aria-hidden="true">
                      →
                    </span>
                    <span>{selected.to_label}</span>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="meta">{selected.counterparty}</p>
            )}
            {selected.kind === "transfer" ? (
              <p className="proposal-amt">{selected.amount_label || formatWon(selected.amount)}</p>
            ) : null}
            {selected.timeline && selected.timeline.length > 0 ? (
              <TransferTimeline steps={selected.timeline} />
            ) : null}
            <p className="why">{selected.why}</p>
            <p className="meta">
              {selected.rail_note ?? "정책이 이 이유를 남겼습니다. 가입 시도는 원장을 바꾸지 않습니다."}
            </p>
          </>
        ) : (
          <p className="empty">실행 행을 선택하면 이유가 열립니다.</p>
        )}
      </div>
    </div>
  );
}
