import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatWon, useAuth } from "../auth";
import { StatusChip, TransferTimeline, type TransferStep } from "../ui";

type Proposal = {
  id: "treasury-idle" | "rebalance";
  title: string;
  why: string;
  from_account_id: string;
  to_account_id: string;
  from_label: string;
  to_label: string;
  amount: number;
  amount_label: string;
  idempotency_key: string;
  legs: { from_account_id: string; to_account_id: string; amount: number; label: string }[];
  journal_id: string | null;
  journal_status: string | null;
  copy: string | null;
  timeline: TransferStep[] | null;
  rail_note: string;
};

type ToolResult = {
  ok: boolean;
  copy: string;
  decision: string;
  rule_id: string;
  audit_id: string;
  journal_id?: string | null;
  journal_status?: string;
  reason?: string;
};

export function ProposalsPage() {
  const auth = useAuth();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const data = await api<{ proposals: Proposal[] }>("/api/proposals", auth.headers);
    setProposals(data.proposals);
  }

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  async function execute(id: string) {
    setBusy(id);
    try {
      const data = await api<{ result: ToolResult; proposals: Proposal[] }>(
        `/api/proposals/${id}/execute`,
        auth.headers,
        { method: "POST", body: JSON.stringify({}) },
      );
      setProposals(data.proposals);
      setFlash(data.result.copy);
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function skip(id: string) {
    setBusy(id);
    try {
      const data = await api<{ proposals: Proposal[] }>(`/api/proposals/${id}/dismiss`, auth.headers, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setProposals(data.proposals);
      setFlash("제안을 건너뛰었습니다. 원장은 바뀌지 않습니다.");
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="customer" data-testid="page-proposals">
      <p className="flash">거래 실행은 <Link to="/trust-demo">신뢰 검증 화면</Link>에서 서명 후 진행합니다. 현재 시제품은 입출금 계좌에서 한 계좌로 보내는 단일 이체를 지원합니다. 다중 자산 리밸런싱 서명은 후속 범위입니다.</p>
      <p className="lede">
        규칙은 유휴 현금 버퍼와 70/30 목표입니다. 실행하면 기존 원장·정책이 전표를 남깁니다. 생성형 모델이 아닙니다.
      </p>
      {proposals.length === 0 ? <p className="empty">지금 실행할 제안이 없습니다.</p> : null}
      <div className="proposal-list">
        {proposals.map((p) => (
          <section key={p.id} className="proposal-card" data-testid={`proposal-${p.id}`}>
            <div className="proposal-head">
              <h3>{p.title}</h3>
              {p.journal_status ? <StatusChip status={p.journal_status} /> : null}
            </div>
            <p className="proposal-amt">{p.amount_label || formatWon(p.amount)}</p>
            <p className="route">
              <span>{p.from_label}</span>
              <span className="route-arrow" aria-hidden="true">
                →
              </span>
              <span>{p.to_label}</span>
            </p>
            <p className="why">{p.why}</p>
            <ul className="legs">
              {p.legs.map((leg) => (
                <li key={`${leg.from_account_id}-${leg.to_account_id}`}>
                  {leg.label} · {formatWon(leg.amount)}
                </li>
              ))}
            </ul>
            {p.timeline ? <TransferTimeline steps={p.timeline} /> : null}
            <p className="meta">{p.rail_note}</p>
            {p.journal_id ? (
              <p className="meta">
                이미 실행됨 · {p.copy} · <Link to="/activity">실행 기록</Link>
              </p>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  data-testid={`execute-${p.id}`}
                  disabled={busy !== null}
                  onClick={() => { window.location.href = "/trust-demo"; }}
                >
                  신뢰 검증으로 이동
                </button>
                <button
                  type="button"
                  className="secondary"
                  data-testid={`skip-${p.id}`}
                  disabled={busy !== null}
                  onClick={() => skip(p.id)}
                >
                  건너뛰기
                </button>
              </div>
            )}
          </section>
        ))}
      </div>
      {flash ? (
        <div className="flash" data-testid="proposal-flash">
          {flash}
        </div>
      ) : null}
      {error ? <p className="flash">{error}</p> : null}
    </div>
  );
}
