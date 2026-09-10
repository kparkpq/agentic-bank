import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, useAuth } from "../auth";
import { StatusChip } from "../ui";

type Doc = { id: string; label: string };

type Product = {
  id: string;
  kind: string;
  kind_label: string;
  institution: string;
  title: string;
  headline: string;
  why: string;
  documents: Doc[];
  attempt_id: string | null;
  attempt_status: string | null;
  attempt_copy: string | null;
  kyc_status: string;
  can_complete: boolean;
};

type EnrollResult = {
  ok: boolean;
  copy: string;
  rule_id: string;
};

type Kyc = {
  status: string;
  copy: string;
  can_enroll: boolean;
};

export function ProductsPage() {
  const auth = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [kyc, setKyc] = useState<Kyc | null>(null);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const data = await api<{ products: Product[]; kyc: Kyc }>("/api/products", auth.headers);
    setProducts(data.products);
    setKyc(data.kyc);
  }

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  function toggle(productId: string, docId: string) {
    setChecked((cur) => {
      const have = new Set(cur[productId] ?? []);
      if (have.has(docId)) have.delete(docId);
      else have.add(docId);
      return { ...cur, [productId]: [...have] };
    });
  }

  async function enroll(id: string, docs: string[]) {
    setBusy(id);
    try {
      const data = await api<{ result: EnrollResult; products: Product[] }>(
        `/api/products/${id}/enroll`,
        auth.headers,
        { method: "POST", body: JSON.stringify({ checked_documents: docs }) },
      );
      setProducts(data.products);
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
      const data = await api<{ products: Product[] }>(`/api/products/${id}/dismiss`, auth.headers, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setProducts(data.products);
      setFlash("이 상품 비교를 건너뛰었습니다. 원장은 바뀌지 않습니다.");
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="customer" data-testid="page-products">
      <p className="lede">
        지금 들고 있는 예금·보험·대출보다 나은 비교안입니다. 기관을 하나로 묶지 않습니다. 서류를 확인한 뒤
        샌드박스 실명 확인을 마치면 데모 가입을 완료할 수 있습니다. 실제 상품·실제 자금이 아닙니다.
      </p>
      {kyc ? (
        <p className="meta" data-testid="products-kyc-line">
          실명 확인: {kyc.copy} · <Link to="/kyc">샌드박스 실명 확인</Link>
        </p>
      ) : null}
      {products.length === 0 ? <p className="empty">지금 비교할 상품이 없습니다.</p> : null}
      <div className="proposal-list">
        {products.map((p) => {
          const posted = p.attempt_status === "POSTED";
          const denied = p.attempt_status === "KYC_DENIED" || kyc?.status === "DENIED";
          const stopped = Boolean(p.attempt_id) && !posted;
          const selected = new Set(checked[p.id] ?? []);
          const allDocs = p.documents.map((d) => d.id);
          const chip = posted
            ? "POSTED"
            : denied
              ? "DENIED"
              : stopped
                ? "KYC_REQUIRED"
                : null;
          return (
            <section key={p.id} className="proposal-card" data-testid={`product-${p.kind}`}>
              <div className="proposal-head">
                <p className="sleeve-inst">
                  {p.kind_label} · {p.institution}
                </p>
                {chip ? <StatusChip status={chip} /> : null}
              </div>
              <h3>{p.title}</h3>
              <p className="proposal-amt">{p.headline}</p>
              <p className="why">{p.why}</p>
              <p className="meta">가입에 필요한 서류</p>
              <ul className="doc-list">
                {p.documents.map((d) => (
                  <li key={d.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={stopped || posted || selected.has(d.id)}
                        disabled={stopped || posted || busy !== null}
                        onChange={() => toggle(p.id, d.id)}
                      />
                      {d.label}
                    </label>
                  </li>
                ))}
              </ul>
              {posted ? (
                <div className="kyc-done" data-testid={`enrolled-${p.kind}`}>
                  <strong>가입이 완료되었습니다.</strong>
                  <p>
                    샌드박스 원장에 가입 기록만 남겼습니다. 실제 상품이 아니며 라이선스 은행이 아닙니다. 잔액은
                    옮기지 않았습니다.
                  </p>
                  <p className="meta">
                    <Link to="/money">내 돈에서 보기</Link>
                    {" · "}
                    <Link to="/activity">실행 기록에서 보기</Link>
                    {" · "}
                    <Link to="/books">장부에서 보기</Link>
                  </p>
                </div>
              ) : denied ? (
                <div className="kyc-stop" data-testid={`kyc-denied-${p.kind}`}>
                  <strong>실명 확인이 거절되었습니다.</strong>
                  <p>샌드박스 거절 시나리오입니다. 가입은 완료되지 않았고 원장은 바뀌지 않습니다.</p>
                </div>
              ) : stopped && p.can_complete ? (
                <div className="kyc-done" data-testid={`kyc-ready-${p.kind}`}>
                  <strong>실명 확인이 완료되었습니다.</strong>
                  <p>이제 데모 가입을 마칠 수 있습니다. 실제 상품·실제 자금이 아닙니다.</p>
                  <div className="actions">
                    <button
                      type="button"
                      data-testid={`complete-${p.kind}`}
                      disabled={busy !== null}
                      onClick={() => enroll(p.id, allDocs)}
                    >
                      가입 완료하기
                    </button>
                  </div>
                </div>
              ) : stopped ? (
                <div className="kyc-stop" data-testid={`kyc-stop-${p.kind}`}>
                  <strong>실명 확인이 필요합니다.</strong>
                  <p>
                    서류는 확인했습니다. 샌드박스 실명 확인을 마치면 데모 가입을 계속할 수 있습니다. 원장은 아직
                    그대로입니다.
                  </p>
                  <div className="actions">
                    <Link to="/kyc" className="hero-cta" data-testid={`kyc-start-${p.kind}`}>
                      실명 확인 시작
                    </Link>
                    <Link to="/activity" className="hero-cta secondary-link">
                      실행 기록에서 보기
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    data-testid={`enroll-${p.kind}`}
                    disabled={busy !== null}
                    onClick={() => enroll(p.id, checked[p.id] ?? [])}
                  >
                    가입 진행
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => skip(p.id)}
                  >
                    건너뛰기
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {flash ? (
        <div className="flash" data-testid="product-flash">
          {flash}
        </div>
      ) : null}
      {error ? <p className="flash">{error}</p> : null}
    </div>
  );
}
