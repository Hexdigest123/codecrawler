export type EmailEvent =
  | "welcome"
  | "verify-email"
  | "password-reset"
  | "email-changed"
  | "password-changed"
  | "2fa-enabled"
  | "2fa-disabled"
  | "account-deleted"
  | "team-invite"
  | "invite-accepted"
  | "invite-declined"
  | "member-removed"
  | "member-left"
  | "role-changed"
  | "team-created"
  | "team-deleted"
  | "subscription-started"
  | "subscription-renewing"
  | "subscription-renewed"
  | "subscription-cancelled"
  | "plan-upgraded"
  | "plan-downgraded"
  | "payment-failed"
  | "payment-received"
  | "review-completed"
  | "review-failed"
  | "review-digest"
  | "quota-warning"
  | "quota-exceeded"
  | "app-installed"
  | "app-uninstalled"
  | "connection-broken"
  | "token-expired"
  | "signup-received"
  | "signup-approved"
  | "signup-denied"
  | "signup-pending-admin"
  | "admin-role-granted"
  | "admin-role-revoked"
  | "account-disabled";

// Preference categories matching the columns on notification_settings.
export type NotificationCategory = "reviews" | "teams" | "billing" | "integrations";

// Informational events that respect the user's notification preferences.
// Every event NOT listed here is transactional (account, security, access
// control, billing/payment) and is ALWAYS sent, regardless of preferences —
// a user must never miss a payment-failed or password-changed notice because
// they muted a category. Only the "nice to know" notifications below are
// gated by preferences.
export const INFORMATIONAL_EVENTS: Partial<Record<EmailEvent, NotificationCategory>> = {
  "review-completed": "reviews",
  "review-failed": "reviews",
  "review-digest": "reviews",
  "quota-warning": "reviews",
  "quota-exceeded": "reviews",
  "subscription-renewing": "billing",
  "app-installed": "integrations",
  "app-uninstalled": "integrations",
};
