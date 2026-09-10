import { useEffect, useState } from "react";
import { api, formatWon, useAuth } from "../auth";
import { formatSeoul } from "../ui";

type Flow = {
  journal_id: string;
  kind_label: string;
  title: string;
  amount: number;
  created_at: string;
  copy: string;
};

type Note = { id: string; title: string; body: string; disclaimer: string };
type Doc = { id: string; label: string; held: boolean; held_label: string };

type Enrollment = {
  id: string;
  product_title: string;
  institution: string;
  kind_label: string;
  copy: string;
  created_at: string;
};

type Books = {
  household: {
    in_total: number;
    out_total: number;
    internal_total: number;
    flows: Flow[];
    empty_copy: string | null;
  };
  enrollments?: Enrollment[];
  tax_notes: Note[];
  documents: Doc[];
};

export function BooksPage() {
  const auth = useAuth();
  const [books, setBooks] = useState<Books | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const data = await api<{ books: Books }>("/api/books", auth.headers);
    setBooks(data.books);
  }

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  async function toggle(doc: Doc) {
    setBusy(doc.id);
    try {
      const data = await api<{ books: Books }>(`/api/books/documents/${doc.id}`, auth.headers, {
        method: "POST",
        body: JSON.stringify({ held: !doc.held }),
      });
      setBooks(data.books);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!books) {
    return (
      <div data-testid="page-books">
        {error ? <p className="flash">{error}</p> : <p className="empty">불러오는 중</p>}
      </div>
    );
  }

  return (
    <div className="customer" data-testid="page-books">
      <p className="lede">
        경리·회계 도우미입니다. 세무사나 세무 대리인이 아니며, 아래 절세 메모는 참고이지 세무 자문이 아닙니다.
      </p>

      <section className="sleeve-card" data-testid="books-household">
        <h3>가계부</h3>
        <p className="meta">
          입금 {formatWon(books.household.in_total)} · 출금 {formatWon(books.household.out_total)} · 내부
          이동 {formatWon(books.household.internal_total)}
        </p>
        {books.household.empty_copy ? <p className="why">{books.household.empty_copy}</p> : null}
        {books.household.flows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>구분</th>
                <th>내용</th>
                <th className="num">금액</th>
                <th>상태</th>
                <th>시각</th>
              </tr>
            </thead>
            <tbody>
              {books.household.flows.map((f) => (
                <tr key={f.journal_id}>
                  <td>{f.kind_label}</td>
                  <td>{f.title}</td>
                  <td className="num">{formatWon(f.amount)}</td>
                  <td>{f.copy}</td>
                  <td>{formatSeoul(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      {(books.enrollments ?? []).length > 0 ? (
        <section className="sleeve-card" data-testid="books-enrollments">
          <h3>가입 기록</h3>
          <p className="meta">샌드박스 가입만 남깁니다. 실제 증권·실제 상품이 아닙니다.</p>
          <ul className="doc-list">
            {(books.enrollments ?? []).map((e) => (
              <li key={e.id} className="doc-row">
                <span>
                  {e.kind_label} · {e.institution} · {e.product_title}
                </span>
                <strong>{e.copy}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="sleeve-card" data-testid="books-tax">
        <h3>절세</h3>
        {books.tax_notes.map((n) => (
          <article key={n.id} className="tax-note">
            <h4>{n.title}</h4>
            <p className="why">{n.body}</p>
            <p className="disclaimer">{n.disclaimer}</p>
          </article>
        ))}
      </section>

      <section className="sleeve-card" data-testid="books-docs">
        <h3>서류</h3>
        <ul className="doc-list">
          {books.documents.map((d) => (
            <li key={d.id} className="doc-row">
              <span>
                {d.label} · <strong>{d.held_label}</strong>
              </span>
              <button
                type="button"
                className="secondary"
                disabled={busy !== null}
                onClick={() => toggle(d)}
              >
                {d.held ? "미챙김으로 되돌리기" : "챙김으로 표시"}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {error ? <p className="flash">{error}</p> : null}
    </div>
  );
}
