import type { Db } from "./db.js";
import {
  availableBalance,
  customerOutboundOnSeoulDay,
  getAccount,
  pendingOut,
} from "./ledger.js";
import { isPositiveIntWon } from "./time.js";
import {
  COPY_DENIED,
  COPY_PENDING,
  COPY_POSTED,
  DAILY_OUTBOUND_CAP_KRW,
  DUAL_CONTROL_AMOUNT_KRW,
  type PolicyInput,
  type PolicyResult,
} from "./types.js";

export function decide(db: Db, input: PolicyInput): PolicyResult {
  const { from_account_id, to_account_id, amount, now, actor_customer_id } = input;

  if (!isPositiveIntWon(amount)) {
    return {
      decision: "DENY_POLICY",
      rule_id: "INVALID_AMOUNT",
      reason: "amount must be a positive integer KRW won",
      copy: "금액이 올바르지 않습니다",
    };
  }

  const from = getAccount(db, from_account_id);
  const to = getAccount(db, to_account_id);
  if (!from || !to || from.product === "HOUSE" || to.product === "HOUSE") {
    return {
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "unknown or non-customer account",
      copy: "계좌를 확인할 수 없습니다",
    };
  }

  if (from_account_id === to_account_id) {
    return {
      decision: "DENY_POLICY",
      rule_id: "SAME_ACCOUNT",
      reason: "from and to accounts must differ",
      copy: "출금·입금 계좌가 같습니다",
    };
  }

  if (actor_customer_id && from.customer_id !== actor_customer_id) {
    return {
      decision: "DENY_POLICY",
      rule_id: "NOT_OWNED",
      reason: "from account is not owned by the session customer",
      copy: "세션 고객의 출금 계좌가 아닙니다",
    };
  }

  if (!from.customer_id) {
    return {
      decision: "DENY_POLICY",
      rule_id: "UNKNOWN_ACCOUNT",
      reason: "from account has no customer",
      copy: "계좌를 확인할 수 없습니다",
    };
  }

  if (from.status === "FROZEN" || from.status === "CLOSED" || to.status === "FROZEN" || to.status === "CLOSED") {
    return {
      decision: "DENY_POLICY",
      rule_id: "ACCOUNT_FROZEN",
      reason: `account status frozen/closed (from ${from.status}, to ${to.status})`,
      copy: COPY_DENIED,
    };
  }

  const available = availableBalance(db, from_account_id);
  const pending = pendingOut(db, from_account_id);
  const spendable = available - pending;
  if (spendable < amount) {
    return {
      decision: "DENY_NSF",
      rule_id: "NSF",
      reason: `NSF: spendable ${spendable} (available ${available} - pending_out ${pending}) < amount ${amount}`,
      copy: COPY_DENIED,
    };
  }

  const outboundToday = customerOutboundOnSeoulDay(db, from.customer_id, now ?? new Date());
  if (outboundToday + amount > DAILY_OUTBOUND_CAP_KRW) {
    return {
      decision: "DENY_LIMIT",
      rule_id: "DAILY_CAP",
      reason: `daily outbound cap ${DAILY_OUTBOUND_CAP_KRW} exceeded (posted+pending ${outboundToday} + ${amount})`,
      copy: COPY_DENIED,
    };
  }

  if (from.customer_id !== to.customer_id) {
    return {
      decision: "DUAL_CONTROL",
      rule_id: "DUAL_OTHER_CUSTOMER",
      reason: "transfer to another customer requires dual-control",
      copy: COPY_PENDING,
    };
  }

  if (amount >= DUAL_CONTROL_AMOUNT_KRW) {
    return {
      decision: "DUAL_CONTROL",
      rule_id: "DUAL_AMOUNT",
      reason: `amount ${amount} >= ${DUAL_CONTROL_AMOUNT_KRW} requires dual-control`,
      copy: COPY_PENDING,
    };
  }

  return {
    decision: "ALLOW",
    rule_id: "ALLOW",
    reason: "within limits, same customer",
    copy: COPY_POSTED,
  };
}
