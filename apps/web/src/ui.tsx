export function formatSeoul(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function statusCopy(status: string): string {
  if (status === "PENDING") return "승인 대기";
  if (status === "DENIED") return "거절";
  if (status === "POSTED") return "완료";
  if (status === "KYC_REQUIRED") return "실명 확인이 필요합니다";
  if (status === "REVIEWING" || status === "KYC_REVIEWING") return "검토 중";
  if (status === "INCOMPLETE" || status === "KYC_INCOMPLETE") return "미완료";
  if (status === "PASSED" || status === "KYC_PASSED") return "실명 확인 완료";
  if (status === "KYC_DENIED") return "실명 확인이 거절되었습니다";
  return status;
}

export function accountStatusCopy(status: string): string {
  if (status === "FROZEN") return "동결";
  if (status === "CLOSED") return "해지";
  return "정상";
}

export function StatusChip({ status }: { status: string }) {
  const label = statusCopy(status);
  const cls =
    status === "PENDING"
      ? "PENDING"
      : status === "DENIED"
        ? "DENIED"
        : status === "POSTED"
          ? "POSTED"
          : status === "KYC_REQUIRED" || status === "REVIEWING" || status === "KYC_REVIEWING"
            ? "PENDING"
            : status === "INCOMPLETE" || status === "KYC_INCOMPLETE"
              ? ""
              : status === "KYC_DENIED"
                ? "DENIED"
                : "";
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function AccountStatusChip({ status }: { status: string }) {
  const label = accountStatusCopy(status);
  const cls = status === "FROZEN" ? "FROZEN" : status === "CLOSED" ? "CLOSED" : "OPEN";
  return <span className={`pill ${cls}`}>{label}</span>;
}

export function formatApy(bps: number): string {
  return `연 ${(bps / 100).toFixed(2)}%`;
}

export type TransferStep = {
  id: string;
  label: string;
  state: "done" | "current" | "upcoming";
};

export function TransferTimeline({ steps }: { steps: TransferStep[] }) {
  return (
    <ol className="xfer-steps" data-testid="transfer-timeline">
      {steps.map((step, index) => (
        <li key={step.id} className={`xfer-step ${step.state}`}>
          <span className="xfer-mark">
            <span className="xfer-dot" />
            {index < steps.length - 1 ? <span className="xfer-line" /> : null}
          </span>
          <span className="xfer-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
