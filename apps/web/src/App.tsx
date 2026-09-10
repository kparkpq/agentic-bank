import { TrustPage } from "./pages/Trust";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth";
import { AccountsPage } from "./pages/Accounts";
import { ActivityPage } from "./pages/Activity";
import { AuditPage } from "./pages/Audit";
import { LedgerPage } from "./pages/Ledger";
import { MoneyPage } from "./pages/Money";
import { PendingPage } from "./pages/Pending";
import { KycPage } from "./pages/Kyc";
import { ProductsPage } from "./pages/Products";
import { ProposalsPage } from "./pages/Proposals";
import { BooksPage } from "./pages/Books";
import { TracesPage } from "./pages/Traces";

const CUSTOMER_NAV = [
  { to: "/trust-demo", ko: "신뢰 검증" },
  { to: "/money", ko: "내 돈" },
  { to: "/proposals", ko: "제안" },
  { to: "/products", ko: "상품" },
  { to: "/books", ko: "장부" },
  { to: "/activity", ko: "실행 기록" },
];

const OPERATOR_NAV = [
  { to: "/accounts", ko: "계좌" },
  { to: "/ledger", ko: "원장" },
  { to: "/pending", ko: "승인 대기" },
  { to: "/traces", ko: "트레이스" },
  { to: "/audit", ko: "감사 로그" },
];

function OperatorOnly({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.role !== "operator") return <Navigate to="/money" replace />;
  return <>{children}</>;
}

function titleFor(path: string): { h2: string; p: string } {
  if (path.startsWith("/trust-demo")) return {h2:"신뢰 검증",p:"승인 · 위임 · 실행 증적"};
  if (path.startsWith("/money")) {
    return { h2: "내 돈", p: "한 사람의 중립 자금 레이어입니다. 은행 앱이 아닙니다." };
  }
  if (path.startsWith("/proposals")) {
    return { h2: "제안", p: "에이전트가 규칙으로 만든 이동안입니다. 실행하면 원장이 움직입니다." };
  }
  if (path.startsWith("/kyc")) {
    return { h2: "실명 확인", p: "샌드박스 실명 확인입니다. 실제 신원 확인이 아니며 주민등록번호는 받지 않습니다." };
  }
  if (path.startsWith("/products")) {
    return { h2: "상품", p: "더 나은 예금·보험·대출 비교안입니다. 샌드박스 실명 확인 후 데모 가입을 마칠 수 있습니다." };
  }
  if (path.startsWith("/books")) {
    return { h2: "장부", p: "경리 도우미입니다. 세무 자문이 아니며 참고만 제공합니다." };
  }
  if (path.startsWith("/activity")) {
    return { h2: "실행 기록", p: "접수 → 진행 → 완료, 또는 승인 대기. 샌드박스 가입과 실명 확인 상태를 함께 봅니다." };
  }
  if (path.startsWith("/audit")) {
    return { h2: "감사 로그", p: "정책이 왜 그렇게 결정했는지. 고객은 자기 전표만 봅니다." };
  }
  return { h2: "통제 콘솔", p: "운영자가 통제면 루프를 감시합니다. 시각은 Asia/Seoul." };
}

export function App() {
  const auth = useAuth();
  const location = useLocation();
  const title = titleFor(location.pathname);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <h1>SapiensQ</h1>
          <p>중립 자금 레이어 · 샌드박스</p>
        </div>
        <nav>
          <p className="nav-label">고객 데모</p>
          {CUSTOMER_NAV.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "active" : "")}>
              <strong>{l.ko}</strong>
            </NavLink>
          ))}
          {auth.role === "operator" ? (
            <>
              <p className="nav-label">운영자</p>
              {OPERATOR_NAV.map((l) => (
                <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? "active" : "")}>
                  <strong>{l.ko}</strong>
                </NavLink>
              ))}
            </>
          ) : (
            <p className="nav-hint">운영자 화면은 역할을 운영자로 바꾸세요.</p>
          )}
        </nav>
      </aside>
      <div className="main">
        <div className="banner">SANDBOX · KRW · 실제 자금 아님 · 라이선스 은행 아님</div>
        <div className="top">
          <div>
            <h2>{title.h2}</h2>
            <p>{title.p}</p>
          </div>
          <div className="role">
            <label htmlFor="role">역할</label>
            <select
              id="role"
              value={auth.role}
              onChange={(e) => auth.setRole(e.target.value as "operator" | "customer")}
            >
              <option value="customer">고객</option>
              <option value="operator">운영자</option>
            </select>
            <select
              value={auth.customerId}
              onChange={(e) => auth.setCustomerId(e.target.value as "syn_alice" | "syn_bob")}
            >
              <option value="syn_alice">앨리스</option>
              <option value="syn_bob">밥</option>
            </select>
          </div>
        </div>
        <Routes>
          <Route path="/" element={<Navigate to="/money" replace />} />
          <Route path="/trust-demo" element={<TrustPage />} />
          <Route path="/money" element={<MoneyPage />} />
          <Route path="/proposals" element={<ProposalsPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/kyc" element={<KycPage />} />
          <Route path="/books" element={<BooksPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/ledger" element={<LedgerPage />} />
          <Route
            path="/pending"
            element={
              <OperatorOnly>
                <PendingPage />
              </OperatorOnly>
            }
          />
          <Route
            path="/traces"
            element={
              <OperatorOnly>
                <TracesPage />
              </OperatorOnly>
            }
          />
          <Route path="/audit" element={<AuditPage />} />
        </Routes>
      </div>
    </div>
  );
}
