import { useEffect, useState } from "react";
import { api, useAuth } from "../auth";
import { formatSeoul } from "../ui";

type Session = { id: string; customer_id: string; current_agent: string; created_at: string };
type Trace = {
  id: string;
  session_id: string;
  seq: number;
  agent: string;
  action: string;
  args_json: string;
  result_json: string;
};

export function TracesPage() {
  const auth = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ sessions: Session[]; traces: Trace[] }>("/api/traces", auth.headers)
      .then((d) => {
        setSessions(d.sessions);
        setTraces(d.traces);
      })
      .catch((e: Error) => setError(e.message));
  }, [auth.role, auth.customerId]);

  return (
    <div className="grid">
      <div>
        <table>
          <thead>
            <tr>
              <th>세션</th>
              <th>고객</th>
              <th>에이전트</th>
              <th>시작</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id.slice(0, 8)}</td>
                <td>{s.customer_id}</td>
                <td>{s.current_agent}</td>
                <td>{formatSeoul(s.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>에이전트</th>
              <th>도구</th>
              <th>인자</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id}>
                <td>{t.seq}</td>
                <td>{t.agent}</td>
                <td>{t.action}</td>
                <td>{t.args_json}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {error ? <p className="flash">{error}</p> : null}
      </div>
    </div>
  );
}
