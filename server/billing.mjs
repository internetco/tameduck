// This edition has no billing: no plans, prices, payments or invoices. These
// are what the rest of the application asks of billing, and each answers that
// it is off.
import { one } from "./store.mjs";
import { companyPlan } from "./company-limits.mjs";

export const billingConfigured = () => false;
export function registerBilling() {}
export function registerBillingWebhook() {}
export function startBillingEngine() {}
export function billingSummary(company, member) {
  const status =
    one("SELECT billing_status FROM companies WHERE id=?", company)
      ?.billing_status || "staging";
  const owner = one(
    "SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND m.role='owner'",
    company,
  );
  return {
    enabled: false,
    mode: "off",
    status,
    blocked: false,
    plan: null,
    next_plan: null,
    trial_ends_at: null,
    period_end: null,
    cancel_at_period_end: false,
    grace_until: null,
    next_attempt_at: null,
    duck_limit: companyPlan(company).plan.ducks,
    trial_eligible: false,
    trial_used: false,
    can_manage: false,
    owner_name: owner?.name || null,
    is_owner: member?.role === "owner",
  };
}
