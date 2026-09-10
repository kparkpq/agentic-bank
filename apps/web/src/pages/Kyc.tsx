import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, useAuth } from "../auth";
import { StatusChip, TransferTimeline, type TransferStep } from "../ui";

type Kyc = {
  customer_id: string;
  status: string;
  status_label: string;
  display_name: string;
  phone: string;
  email: string;
  id_placeholder: string;
  acknowledgements: string[];
  copy: string;
  can_enroll: boolean;
  timeline: TransferStep[];
};

type Ack = { id: string; label: string };

type Defaults = {
  display_name: string;
  phone: string;
  email: string;
  id_placeholder: string;
};

export function KycPage() {
  const auth = useAuth();
  const [kyc, setKyc] = useState<Kyc | null>(null);
  const [acks, setAcks] = useState<Ack[]>([]);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [idReady, setIdReady] = useState(false);
  const [denyDemo, setDenyDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    const data = await api<{ kyc: Kyc; acknowledgements: Ack[]; defaults: Defaults }>("/api/kyc", auth.headers);
    setKyc(data.kyc);
    setAcks(data.acknowledgements);
    setDefaults(data.defaults);
    if (data.kyc.status !== "INCOMPLETE") {
      setChecked(data.kyc.acknowledgements);
      setIdReady(Boolean(data.kyc.id_placeholder));
    }
  }

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  function toggle(id: string) {
    setChecked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function submit() {
    if (!defaults) return;
    setBusy(true);
    try {
      const data = await api<{ result: { copy: string }; kyc: Kyc }>("/api/kyc", auth.headers, {
        method: "POST",
        body: JSON.stringify({
          display_name: defaults.display_name,
          phone: defaults.phone,
          email: defaults.email,
          id_placeholder: idReady ? defaults.id_placeholder : "",
          acknowledgements: checked,
          scenario: denyDemo ? "deny" : "pass",
        }),
      });
      setKyc(data.kyc);
      setFlash(data.result.copy);
    } catch (e) {
      setFlash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!kyc || !defaults) {
    return (
      <div data-testid="page-kyc">
        {error ? <p className="flash">{error}</p> : <p className="empty">불러오는 중</p>}
      </div>
    );
  }

  const locked = kyc.status === "PASSED" || kyc.status === "DENIED";
  const chipStatus =
    kyc.status === "PASSED" ? "POSTED" : kyc.status === "DENIED" ? "DENIED" : kyc.status === "REVIEWING" ? "REVIEWING" : "INCOMPLETE";

  return (
    <div className="customer" data-testid="page-kyc">
      <p className="lede">
        합성 고객 앨리스의 샌드박스 실명 확인입니다. 주민등록번호는 받지 않습니다. 실제 신원 확인·AML이 아니며
        라이선스 은행이 아닙니다.
      </p>

      <section className="sleeve-card" data-testid="kyc-status">
        <div className="proposal-head">
          <p className="sleeve-inst">실명 확인 · syn_alice</p>
          <StatusChip status={chipStatus} />
        </div>
        <h3>{kyc.copy}</h3>
        <TransferTimeline steps={kyc.timeline} />
        <p className="meta">상태는 미완료 → 검토 중 → 완료(또는 거절)입니다. 합성 값만 저장합니다.</p>
      </section>

      <section className="proposal-card kyc-form" data-testid="kyc-form">
        <h3>합성 정보</h3>
        <label className="field">
          <span>이름</span>
          <input type="text" value={defaults.display_name} readOnly disabled />
        </label>
        <label className="field">
          <span>전화 (선택 · syn_*)</span>
          <input type="text" value={defaults.phone} readOnly disabled />
        </label>
        <label className="field">
          <span>이메일 (선택 · syn_*)</span>
          <input type="text" value={defaults.email} readOnly disabled />
        </label>
        <div className="field">
          <span>신분증 자리 표시</span>
          <p className="meta">파일을 올려도 내용은 읽지 않습니다. 저장 값은 {defaults.id_placeholder} 뿐입니다.</p>
          <label className="check">
            <input
              type="file"
              data-testid="kyc-id-upload"
              disabled={locked || busy}
              onChange={() => setIdReady(true)}
            />
            자리 표시 파일
          </label>
          {idReady ? <p className="meta">접수: {defaults.id_placeholder} · 내용 저장 안 함</p> : null}
        </div>
        <p className="meta">확인 사항</p>
        <ul className="doc-list">
          {acks.map((a) => (
            <li key={a.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={checked.includes(a.id)}
                  disabled={locked || busy}
                  onChange={() => toggle(a.id)}
                />
                {a.label}
              </label>
            </li>
          ))}
        </ul>
        <label className="check deny-demo">
          <input
            type="checkbox"
            data-testid="kyc-deny-demo"
            checked={denyDemo}
            disabled={locked || busy}
            onChange={() => setDenyDemo((v) => !v)}
          />
          거절 시나리오 (데모). 켜면 가입이 계속 막힙니다.
        </label>
        {!locked ? (
          <div className="actions">
            <button type="button" data-testid="kyc-submit" disabled={busy} onClick={submit}>
              실명 확인 제출
            </button>
            <Link to="/products" className="hero-cta secondary-link">
              상품으로
            </Link>
          </div>
        ) : (
          <div className="actions">
            {kyc.can_enroll ? (
              <Link to="/products" className="hero-cta" data-testid="kyc-back-enroll">
                상품으로 돌아가 가입 완료하기
              </Link>
            ) : (
              <Link to="/products" className="hero-cta secondary-link">
                상품으로
              </Link>
            )}
          </div>
        )}
      </section>
      {flash ? (
        <div className="flash" data-testid="kyc-flash">
          {flash}
        </div>
      ) : null}
      {error ? <p className="flash">{error}</p> : null}
    </div>
  );
}
