import { useEffect, useMemo, useState } from "react";
import { api, formatWon, useAuth } from "../auth";
import { StatusChip, formatSeoul } from "../ui";

type Journal = {
  id: string;
  journal_id?: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  status: string;
  decision: string | null;
  decision_ref: string | null;
  rule_id: string | null;
  why: string | null;
  reason: string | null;
  created_at: string;
};

type Entry = {
  id: string;
  journal_id: string;
  account_id: string;
  side: "DEBIT" | "CREDIT";
  amount: number;
  posted: number;
  created_at: string;
};

export function LedgerPage() {
  const auth = useAuth();
  const [journals, setJournals] = useState<Journal[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ journals: Journal[]; entries: Entry[] }>("/api/ledger", auth.headers)
      .then((d) => {
        setJournals(d.journals);
        setEntries(d.entries);
        setSelectedId((cur) => cur ?? d.journals[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  const selected = journals.find((j) => j.id === selectedId) ?? null;
  const pair = useMemo(
    () => entries.filter((e) => e.journal_id === selectedId),
    [entries, selectedId],
  );
  const debit = pair.filter((e) => e.side === "DEBIT").reduce((s, e) => s + Number(e.amount), 0);
  const credit = pair.filter((e) => e.side === "CREDIT").reduce((s, e) => s + Number(e.amount), 0);

  return (
    <div className="grid">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>전표</th>
              <th>출금</th>
              <th>입금</th>
              <th className="num">금액</th>
              <th>상태</th>
              <th>decision_ref</th>
              <th>시각</th>
            </tr>
          </thead>
          <tbody>
            {journals.map((j) => (
              <tr
                key={j.id}
                className={`clickable${j.id === selectedId ? " selected" : ""}`}
                onClick={() => setSelectedId(j.id)}
              >
                <td className="mono" title={j.id}>
                  {j.id.slice(0, 8)}
                </td>
                <td>{j.from_account_id}</td>
                <td>{j.to_account_id}</td>
                <td className="num">{formatWon(j.amount)}</td>
                <td>
                  <StatusChip status={j.status} />
                </td>
                <td className="mono" title={j.decision_ref ?? ""}>
                  {j.decision_ref ?? ""}
                </td>
                <td>{formatSeoul(j.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {error ? <p className="flash">{error}</p> : null}
      </div>
      <div className="panel">
        {selected ? (
          <>
            <h3>분개 · {selected.id.slice(0, 8)}</h3>
            <p className="meta">
              상태 <StatusChip status={selected.status} /> · decision {selected.decision} · rule_id{" "}
              {selected.rule_id}
            </p>
            <p className="meta">why {selected.why ?? selected.reason ?? ""}</p>
            <p className="meta mono">decision_ref {selected.decision_ref}</p>
            <table>
              <thead>
                <tr>
                  <th>계정</th>
                  <th>차변/대변</th>
                  <th className="num">금액</th>
                  <th>posted</th>
                </tr>
              </thead>
              <tbody>
                {pair.map((e) => (
                  <tr key={e.id}>
                    <td>{e.account_id}</td>
                    <td>{e.side}</td>
                    <td className="num">{formatWon(e.amount)}</td>
                    <td>{Number(e.posted) === 1 ? "1" : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              균형 {formatWon(debit)} / {formatWon(credit)}
              {debit === credit ? " · balanced" : " · UNBALANCED"}
            </p>
          </>
        ) : (
          <p className="empty">전표를 선택하세요</p>
        )}
      </div>
    </div>
  );
}
