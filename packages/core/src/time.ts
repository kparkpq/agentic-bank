import { TIMEZONE } from "./types.js";

export function nowUtcIso(now = new Date()): string {
  return now.toISOString();
}

/** YYYY-MM-DD in Asia/Seoul for calendar-day caps. */
export function seoulCalendarDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("failed to format Asia/Seoul calendar day");
  }
  return `${year}-${month}-${day}`;
}

/** Display clock for the operator console. Storage remains UTC ISO. */
export function formatSeoul(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function isPositiveIntWon(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0;
}
