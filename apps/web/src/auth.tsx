import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Role = "operator" | "customer";

export type AuthState = {
  role: Role;
  customerId: "syn_alice" | "syn_bob";
  setRole: (role: Role) => void;
  setCustomerId: (id: "syn_alice" | "syn_bob") => void;
  headers: Record<string, string>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>(() => {
    try {
      return sessionStorage.getItem("sapiensq.role") === "operator" ? "operator" : "customer";
    } catch {
      return "customer";
    }
  });
  const [customerId, setCustomerIdState] = useState<"syn_alice" | "syn_bob">(() => {
    try {
      return sessionStorage.getItem("sapiensq.customer") === "syn_bob" ? "syn_bob" : "syn_alice";
    } catch {
      return "syn_alice";
    }
  });
  function setRole(next: Role) {
    setRoleState(next);
    try {
      sessionStorage.setItem("sapiensq.role", next);
    } catch {
      /* ignore */
    }
  }
  function setCustomerId(id: "syn_alice" | "syn_bob") {
    setCustomerIdState(id);
    try {
      sessionStorage.setItem("sapiensq.customer", id);
    } catch {
      /* ignore */
    }
  }
  const value = useMemo<AuthState>(
    () => ({
      role,
      customerId,
      setRole,
      setCustomerId,
      headers: {
        "Content-Type": "application/json",
        "X-Role": role,
        "X-Customer-Id": customerId,
      },
    }),
    [role, customerId],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider required");
  return ctx;
}

export async function api<T>(path: string, headers: Record<string, string>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `${res.status} ${path}`);
  }
  return body;
}

export function formatWon(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toLocaleString("ko-KR")}원`;
}
