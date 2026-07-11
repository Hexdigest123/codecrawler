import { db, schema } from "@codecrawler/db";
import { env } from "@codecrawler/shared";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { type EmailEvent, INFORMATIONAL_EVENTS } from "./events";
import { renderEmail } from "./templates";

export type { EmailEvent } from "./events";
export type { RenderedEmail } from "./html";
export { renderEmail } from "./templates";

type Transporter = nodemailer.Transporter;

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) {
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USERNAME
      ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD ?? "" }
      : undefined,
  });
  return transporter;
}

export async function enqueueEmail(
  event: EmailEvent,
  to: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Account, security, access-control and billing/payment events are
  // transactional — they are always sent regardless of notification
  // preferences. Only informational events (reviews, quota heads-ups,
  // renewal reminders, app installs) are gated by the user's preferences.
  const category = INFORMATIONAL_EVENTS[event];
  if (category) {
    try {
      const userId = await getUserIdByEmail(to);
      if (userId) {
        const settings = await getNotificationSettings(userId);
        if (!settings[category]) {
          console.log(`[email] skipped event=${event} to=${to} (preference "${category}" off)`);
          return;
        }
      }
    } catch (err) {
      // If the preference lookup fails we fall through and send — never
      // silently drop an email because of a lookup error.
      console.warn(`[email] preference lookup failed for ${to}, sending anyway`, err);
    }
  }
  try {
    const { subject, html } = renderEmail(event, payload);
    await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to,
      subject,
      html,
    });
    console.log(`[email] sent event=${event} to=${to}`);
  } catch (err) {
    console.error(`[email] failed event=${event} to=${to}`, err);
  }
}

async function getUserIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

export interface NotificationSettings {
  reviews: boolean;
  teams: boolean;
  billing: boolean;
  integrations: boolean;
}

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  reviews: true,
  teams: true,
  billing: true,
  integrations: true,
};

// Users without a persisted row are treated as "all notifications on" so the
// feature is opt-out without backfilling rows for every existing user.
export async function getNotificationSettings(userId: string): Promise<NotificationSettings> {
  const rows = await db
    .select()
    .from(schema.notificationSettings)
    .where(eq(schema.notificationSettings.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  return {
    reviews: row.reviews,
    teams: row.teams,
    billing: row.billing,
    integrations: row.integrations,
  };
}

export async function upsertNotificationSettings(
  userId: string,
  settings: NotificationSettings,
): Promise<NotificationSettings> {
  const [row] = await db
    .insert(schema.notificationSettings)
    .values({
      userId,
      reviews: settings.reviews,
      teams: settings.teams,
      billing: settings.billing,
      integrations: settings.integrations,
    })
    .onConflictDoUpdate({
      target: schema.notificationSettings.userId,
      set: {
        reviews: settings.reviews,
        teams: settings.teams,
        billing: settings.billing,
        integrations: settings.integrations,
        updatedAt: new Date(),
      },
    })
    .returning();
  return {
    reviews: row.reviews,
    teams: row.teams,
    billing: row.billing,
    integrations: row.integrations,
  };
}
