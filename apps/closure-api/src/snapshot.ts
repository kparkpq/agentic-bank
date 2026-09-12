import {
  availableBalance,
  customerOutboundOnSeoulDay,
  getAccount,
  pendingOut,
  type Bank,
} from "@sapiensq/core";

export type LiveAccountSnapshot = {
  from_account_status: "OPEN" | "FROZEN" | "CLOSED";
  to_account_status: "OPEN" | "FROZEN" | "CLOSED";
  from_owner_customer_id: string;
  to_owner_customer_id: string;
  spendable_funds: string;
  daily_spent: string;
};

function integerString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("snapshot amount is outside the safe integer range");
  }
  return String(value);
}

export function extractLiveAccountSnapshot(
  bank: Bank,
  fromAccountId: string,
  toAccountId: string,
  now = new Date(),
): LiveAccountSnapshot | undefined {
  const from = getAccount(bank.db, fromAccountId);
  const to = getAccount(bank.db, toAccountId);
  if (!from || !to || !from.customer_id || !to.customer_id) return undefined;
  const spendable = availableBalance(bank.db, fromAccountId) - pendingOut(bank.db, fromAccountId);
  const dailySpent = customerOutboundOnSeoulDay(bank.db, from.customer_id, now);
  return {
    from_account_status: from.status,
    to_account_status: to.status,
    from_owner_customer_id: from.customer_id,
    to_owner_customer_id: to.customer_id,
    spendable_funds: integerString(Math.max(0, spendable)),
    daily_spent: integerString(dailySpent),
  };
}
