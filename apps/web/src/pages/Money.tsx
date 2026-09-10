import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatWon, useAuth } from "../auth";
import { formatApy } from "../ui";

type Sleeve = {
  account_id: string;
  kind: string;
  label: string;
  institution: string;
  product_name: string;
  kind_label?: string;
  apy_bps: number | null;
  available: number;
  pending_out: number;
};

type Holding = {
  product_id: string;
  kind: string;
  kind_label: string;
  institution: string;
  title: string;
  headline: string;
  available: number;
  status: string;
  copy: string;
  rail_note: string;
};

type Money = {
  customer_id: string;
  display_name: string;
  total_available: number;
  checking: Sleeve | null;
  mmf: Sleeve | null;
  brokerage: {
    equity: Sleeve | null;
    bond: Sleeve | null;
    total: number;
    target_equity_bps: number;
    current_equity_bps: number;
  };
  shop_holdings?: Holding[];
};

export function MoneyPage() {
  const auth = useAuth();
  const [money, setMoney] = useState<Money | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ money: Money }>("/api/money", auth.headers)
      .then((d) => setMoney(d.money))
      .catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  if (!money) {
    return (
      <div data-testid="page-money">
        {error ? <p className="flash">{error}</p> : <p className="empty">불러오는 중</p>}
      </div>
    );
  }

  const idle = money.checking && money.checking.available - money.checking.pending_out > 8_000_000;
  const eqPct = money.brokerage.total > 0 ? Math.round(money.brokerage.current_equity_bps / 100) : 0;
  const bondPct = 100 - eqPct;
  const targetEq = Math.round(money.brokerage.target_equity_bps / 100);

  return (
    <div className="customer" data-testid="page-money">
      <div className="hero">
        <div>
          <p className="kicker">합성 고객 · {money.display_name}</p>
          <h3 className="hero-name">{money.display_name}의 돈</h3>
          <p className="hero-total">{formatWon(money.total_available)}</p>
          <p className="meta">표시 이율은 고정 상수입니다. 시세·실계좌가 아닙니다.</p>
        </div>
        {idle ? (
          <Link to="/proposals" className="hero-cta">
            잠들어 있는 현금이 있습니다 → 제안
          </Link>
        ) : (
          <Link to="/proposals" className="hero-cta secondary-link">
            에이전트 제안 보기
          </Link>
        )}
      </div>

      <div className="sleeve-grid">
        <section className="sleeve-card" data-testid="sleeve-checking">
          <p className="sleeve-inst">
            {money.checking?.kind_label ?? "예금"} · {money.checking?.institution ?? "한빛은행"}
          </p>
          <h3>{money.checking?.label ?? "한빛 입출금통장"}</h3>
          <p className="meta">{money.checking?.product_name ?? "생활비 예금"}</p>
          <p className="sleeve-amt">{formatWon(money.checking?.available ?? 0)}</p>
          <p className="sleeve-yield">{formatApy(money.checking?.apy_bps ?? 10)} · 유휴 현금</p>
          {money.checking && money.checking.pending_out > 0 ? (
            <p className="meta">대기출금 {formatWon(money.checking.pending_out)}</p>
          ) : null}
        </section>
        <section className="sleeve-card yield" data-testid="sleeve-mmf">
          <p className="sleeve-inst">
            {money.mmf?.kind_label ?? "MMF"} · {money.mmf?.institution ?? "한빛은행"}
          </p>
          <h3>{money.mmf?.label ?? "한빛 파킹MMF"}</h3>
          <p className="meta">{money.mmf?.product_name ?? "단기금융 MMF"}</p>
          <p className="sleeve-amt">{formatWon(money.mmf?.available ?? 0)}</p>
          <p className="sleeve-yield">{formatApy(money.mmf?.apy_bps ?? 350)} 표시 이율</p>
        </section>
      </div>

      <section className="sleeve-card brokerage" data-testid="sleeve-brokerage">
        <p className="sleeve-inst">ETF · {money.brokerage.equity?.institution ?? "청운증권"}</p>
        <h3>ETF 슬리브</h3>
        <p className="sleeve-amt">{formatWon(money.brokerage.total)}</p>
        <p className="meta">
          현재 {eqPct}/{bondPct} · 목표 {targetEq}/{100 - targetEq}
        </p>
        <div className="alloc" aria-hidden="true">
          <div className="alloc-eq" style={{ width: `${eqPct}%` }} />
          <div className="alloc-bond" style={{ width: `${bondPct}%` }} />
        </div>
        <div className="holding-row">
          <div>
            <strong>{money.brokerage.equity?.label ?? "청운 코스피200 ETF"}</strong>
            <p className="meta">{money.brokerage.equity?.product_name ?? "합성 주식형 ETF"}</p>
          </div>
          <div className="num">{formatWon(money.brokerage.equity?.available ?? 0)}</div>
        </div>
        <div className="holding-row">
          <div>
            <strong>{money.brokerage.bond?.label ?? "청운 국고채 ETF"}</strong>
            <p className="meta">{money.brokerage.bond?.product_name ?? "합성 채권형 ETF"}</p>
          </div>
          <div className="num">{formatWon(money.brokerage.bond?.available ?? 0)}</div>
        </div>
      </section>

      {(money.shop_holdings ?? []).length > 0 ? (
        <div className="sleeve-grid" data-testid="shop-holdings">
          {(money.shop_holdings ?? []).map((h) => (
            <section key={h.product_id} className="sleeve-card yield" data-testid={`holding-${h.kind}`}>
              <p className="sleeve-inst">
                {h.kind_label} · {h.institution}
              </p>
              <h3>{h.title}</h3>
              <p className="meta">{h.headline}</p>
              <p className="sleeve-amt">{formatWon(h.available)}</p>
              <p className="sleeve-yield">{h.copy} · 샌드박스 가입</p>
              <p className="meta">{h.rail_note}</p>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
