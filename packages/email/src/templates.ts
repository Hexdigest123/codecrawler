import type { EmailEvent } from "./events";
import {
  codeBox,
  cta,
  escapeHtml,
  paragraph,
  type RenderedEmail,
  shell,
  str,
  webUrl,
} from "./html";

function generic(event: EmailEvent, payload: Record<string, unknown>): RenderedEmail {
  const subject = `CodeCrawler · ${event}`;
  const detail = str(payload, "message") || str(payload, "details");
  const body = [
    paragraph("Here's an update from your CodeCrawler account."),
    detail ? paragraph(detail) : "",
    '<p style="margin:0;font-size:13px;color:#737373;">Event type:</p>',
    `<p style="margin:0;">${escapeHtml(event)}</p>`,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell(event, body) };
}

function renderReviewCompleted(payload: Record<string, unknown>): RenderedEmail {
  const repo = str(payload, "repo") || str(payload, "project");
  const prNumber = str(payload, "prNumber") || str(payload, "number");
  const walkthrough = str(payload, "walkthrough");
  const url = str(payload, "reviewUrl") || str(payload, "url");
  const subject = repo
    ? `CodeCrawler review completed · ${repo}${prNumber ? ` #${prNumber}` : ""}`
    : "CodeCrawler review completed";
  const body = [
    paragraph(
      repo
        ? `Your pull request review for ${repo}${prNumber ? ` #${prNumber}` : ""} is complete.`
        : "Your pull request review is complete.",
    ),
    codeBox(walkthrough),
    cta(url, "View the full review"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Review completed", body) };
}

function renderReviewFailed(payload: Record<string, unknown>): RenderedEmail {
  const repo = str(payload, "repo") || str(payload, "project");
  const prNumber = str(payload, "prNumber") || str(payload, "number");
  const error = str(payload, "error") || str(payload, "message");
  const url = str(payload, "reviewUrl") || str(payload, "url");
  const subject = repo
    ? `CodeCrawler review failed · ${repo}${prNumber ? ` #${prNumber}` : ""}`
    : "CodeCrawler review failed";
  const body = [
    paragraph(
      repo
        ? `A review for ${repo}${prNumber ? ` #${prNumber}` : ""} could not be completed.`
        : "A review could not be completed.",
    ),
    paragraph("The review worker reported the following error:"),
    codeBox(error),
    cta(url, "Open the review"),
    paragraph("You can re-trigger the review from the project page."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Review failed", body) };
}

function renderReviewDigest(payload: Record<string, unknown>): RenderedEmail {
  const period = str(payload, "period") || "this period";
  const count = str(payload, "count");
  const summary = str(payload, "summary");
  const url = str(payload, "digestUrl") || str(payload, "url");
  const subject = `CodeCrawler review digest · ${period}`;
  const body = [
    paragraph(`Here's your CodeCrawler review digest for ${period}.`),
    count ? paragraph(`Reviews completed: ${count}.`) : "",
    codeBox(summary),
    cta(url || webUrl("reviews"), "Open the digest"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Review digest", body) };
}

function renderWelcome(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name") || str(payload, "userName");
  const url = str(payload, "dashboardUrl") || str(payload, "url") || webUrl();
  const subject = "Welcome to CodeCrawler";
  const body = [
    paragraph(name ? `Hi ${name}, welcome to CodeCrawler.` : "Welcome to CodeCrawler."),
    paragraph(
      "Your workspace is ready. Connect a repository, trigger your first AI review, and start shipping safer code.",
    ),
    cta(url, "Go to your dashboard"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Welcome", body) };
}

function renderVerifyEmail(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const verifyUrl = str(payload, "verifyUrl") || str(payload, "url");
  const token = str(payload, "token") || str(payload, "code");
  const subject = "Verify your email address";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, please confirm your email address.`
        : "Please confirm your email address.",
    ),
    paragraph("Verifying your address unlocks notifications, team invites, and password recovery."),
    verifyUrl
      ? cta(verifyUrl, "Verify email")
      : token
        ? paragraph(`Use this verification code: ${token}`)
        : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Verify your email", body) };
}

function renderPasswordReset(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const resetUrl = str(payload, "resetUrl") || str(payload, "url");
  const token = str(payload, "token") || str(payload, "code");
  const subject = "Reset your CodeCrawler password";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, we received a request to reset your password.`
        : "We received a request to reset your password.",
    ),
    paragraph("If you didn't make this request, you can safely ignore this email."),
    resetUrl
      ? cta(resetUrl, "Reset password")
      : token
        ? paragraph(`Use this reset code: ${token}`)
        : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Reset your password", body) };
}

function renderEmailChanged(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const newEmail = str(payload, "newEmail") || str(payload, "email");
  const subject = "Your email address was changed";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, your CodeCrawler email address was updated.`
        : "Your CodeCrawler email address was updated.",
    ),
    newEmail ? paragraph(`New email: ${newEmail}`) : "",
    paragraph("If this wasn't you, reset your password and contact your workspace admin."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Email address changed", body) };
}

function renderPasswordChanged(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const subject = "Your password was changed";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, your CodeCrawler password was changed.`
        : "Your CodeCrawler password was changed.",
    ),
    paragraph("If this wasn't you, reset your password immediately from the sign-in page."),
    cta(webUrl("settings/security"), "Review account security"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Password changed", body) };
}

function render2faEnabled(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const subject = "Two-factor authentication enabled";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, two-factor authentication is now active on your account.`
        : "Two-factor authentication is now active on your account.",
    ),
    paragraph(
      "From now on you'll need a verification code from your authenticator app at sign-in.",
    ),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("2FA enabled", body) };
}

function render2faDisabled(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const subject = "Two-factor authentication disabled";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, two-factor authentication was turned off on your account.`
        : "Two-factor authentication was turned off on your account.",
    ),
    paragraph("Your account is now protected by password only. Re-enable 2FA to keep it secure."),
    cta(webUrl("settings/security"), "Re-enable 2FA"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("2FA disabled", body) };
}

function renderAccountDeleted(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const subject = "Your CodeCrawler account was deleted";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, your CodeCrawler account and associated data have been deleted.`
        : "Your CodeCrawler account and associated data have been deleted.",
    ),
    paragraph("If you didn't request this, reply to this email or contact support immediately."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Account deleted", body) };
}

function renderTeamInvite(payload: Record<string, unknown>): RenderedEmail {
  const inviter = str(payload, "inviterName") || str(payload, "inviter") || "Someone";
  const team = str(payload, "teamName") || str(payload, "team") || "a team";
  const role = str(payload, "role");
  const inviteUrl = str(payload, "inviteUrl") || str(payload, "url");
  const subject = `${inviter} invited you to join ${team} on CodeCrawler`;
  const body = [
    paragraph(
      `${inviter} has invited you to join ${team}${role ? ` as ${role}` : ""} on CodeCrawler.`,
    ),
    paragraph("Accept the invite to start collaborating on reviews."),
    cta(inviteUrl || webUrl("invites"), "Accept invite"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Team invitation", body) };
}

function renderInviteAccepted(payload: Record<string, unknown>): RenderedEmail {
  const invitee = str(payload, "inviteeName") || str(payload, "inviteeEmail") || "A teammate";
  const team = str(payload, "teamName") || str(payload, "team") || "your team";
  const url = str(payload, "teamUrl") || str(payload, "url");
  const subject = `${invitee} accepted your invite to ${team}`;
  const body = [
    paragraph(`${invitee} accepted your invitation and has joined ${team}.`),
    cta(url || webUrl("teams"), "View team"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Invite accepted", body) };
}

function renderInviteDeclined(payload: Record<string, unknown>): RenderedEmail {
  const invitee = str(payload, "inviteeName") || str(payload, "inviteeEmail") || "A teammate";
  const team = str(payload, "teamName") || str(payload, "team") || "your team";
  const subject = `${invitee} declined your invite to ${team}`;
  const body = [
    paragraph(`${invitee} declined the invitation to join ${team}.`),
    paragraph("You can invite another teammate from the team settings."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Invite declined", body) };
}

function renderMemberRemoved(payload: Record<string, unknown>): RenderedEmail {
  const member = str(payload, "memberName") || str(payload, "memberEmail") || "A member";
  const team = str(payload, "teamName") || str(payload, "team") || "the team";
  const actor = str(payload, "actorName") || str(payload, "actor") || "An admin";
  const subject = `${member} was removed from ${team}`;
  const body = [
    paragraph(`${actor} removed ${member} from ${team}.`),
    paragraph("They no longer have access to the team's projects or reviews."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Member removed", body) };
}

function renderMemberLeft(payload: Record<string, unknown>): RenderedEmail {
  const member = str(payload, "memberName") || str(payload, "memberEmail") || "A member";
  const team = str(payload, "teamName") || str(payload, "team") || "the team";
  const subject = `${member} left ${team}`;
  const body = [
    paragraph(`${member} has left ${team}.`),
    paragraph("They no longer have access to the team's projects or reviews."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Member left", body) };
}

function renderRoleChanged(payload: Record<string, unknown>): RenderedEmail {
  const member = str(payload, "memberName") || str(payload, "memberEmail") || "A member";
  const team = str(payload, "teamName") || str(payload, "team") || "the team";
  const role = str(payload, "role") || str(payload, "newRole");
  const previousRole = str(payload, "previousRole") || str(payload, "oldRole");
  const subject = role ? `${member}'s role changed to ${role}` : `${member}'s role was changed`;
  const body = [
    previousRole && role
      ? paragraph(`${member}'s role in ${team} changed from ${previousRole} to ${role}.`)
      : role
        ? paragraph(`${member}'s role in ${team} is now ${role}.`)
        : paragraph(`${member}'s role in ${team} was updated.`),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Role changed", body) };
}

function renderTeamCreated(payload: Record<string, unknown>): RenderedEmail {
  const team = str(payload, "teamName") || str(payload, "team") || "Your new team";
  const creator = str(payload, "creatorName") || str(payload, "creator") || "You";
  const url = str(payload, "teamUrl") || str(payload, "url");
  const subject = `Team created · ${team}`;
  const body = [
    paragraph(`${creator} created a new CodeCrawler team: ${team}.`),
    paragraph("Invite teammates to start collaborating on reviews."),
    cta(url || webUrl("teams"), "Open team"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Team created", body) };
}

function renderTeamDeleted(payload: Record<string, unknown>): RenderedEmail {
  const team = str(payload, "teamName") || str(payload, "team") || "Your team";
  const subject = `Team deleted · ${team}`;
  const body = [
    paragraph(`The CodeCrawler team "${team}" has been deleted.`),
    paragraph("All members lost access, and the team's pending jobs have been cancelled."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Team deleted", body) };
}

function renderSubscriptionStarted(payload: Record<string, unknown>): RenderedEmail {
  const plan = str(payload, "planName") || str(payload, "plan") || "your plan";
  const amount = str(payload, "amount") || str(payload, "price");
  const period = str(payload, "period") || str(payload, "interval");
  const url = str(payload, "invoiceUrl") || str(payload, "url");
  const subject = `Subscription started · ${plan}`;
  const body = [
    paragraph(`Your CodeCrawler ${plan} subscription is now active.`),
    amount && period
      ? paragraph(`Billed ${amount} ${period}.`)
      : amount
        ? paragraph(`Billed ${amount}.`)
        : "",
    cta(url || webUrl("billing"), "View billing details"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Subscription started", body) };
}

function renderSubscriptionRenewing(payload: Record<string, unknown>): RenderedEmail {
  const plan = str(payload, "planName") || str(payload, "plan") || "your plan";
  const amount = str(payload, "amount") || str(payload, "price");
  const renewalDate = str(payload, "renewalDate") || str(payload, "date");
  const url = str(payload, "url");
  const subject = `Subscription renewing soon · ${plan}`;
  const body = [
    paragraph(
      renewalDate
        ? `Your ${plan} subscription renews on ${renewalDate}.`
        : `Your ${plan} subscription renews soon.`,
    ),
    amount ? paragraph(`The next invoice will be ${amount}.`) : "",
    paragraph("You can change or cancel the subscription any time before the renewal date."),
    cta(url || webUrl("billing"), "Manage subscription"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Subscription renewing", body) };
}

function renderSubscriptionRenewed(payload: Record<string, unknown>): RenderedEmail {
  const plan = str(payload, "planName") || str(payload, "plan") || "your plan";
  const amount = str(payload, "amount") || str(payload, "price");
  const url = str(payload, "invoiceUrl") || str(payload, "url");
  const subject = `Subscription renewed · ${plan}`;
  const body = [
    paragraph(`Your CodeCrawler ${plan} subscription was renewed successfully.`),
    amount ? paragraph(`Billed ${amount}.`) : "",
    cta(url || webUrl("billing"), "View invoice"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Subscription renewed", body) };
}

function renderSubscriptionCancelled(payload: Record<string, unknown>): RenderedEmail {
  const plan = str(payload, "planName") || str(payload, "plan") || "your plan";
  const effectiveDate = str(payload, "effectiveDate") || str(payload, "date");
  const url = str(payload, "url");
  const subject = `Subscription cancelled · ${plan}`;
  const body = [
    paragraph(`Your CodeCrawler ${plan} subscription has been cancelled.`),
    effectiveDate ? paragraph(`Access remains active until ${effectiveDate}.`) : "",
    paragraph("You can resubscribe any time from billing settings."),
    cta(url || webUrl("billing"), "Resubscribe"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Subscription cancelled", body) };
}

function renderPlanUpgraded(payload: Record<string, unknown>): RenderedEmail {
  const fromPlan = str(payload, "fromPlan") || str(payload, "previousPlan");
  const toPlan = str(payload, "toPlan") || str(payload, "plan") || "a higher plan";
  const url = str(payload, "url");
  const subject = `Plan upgraded · ${toPlan}`;
  const body = [
    fromPlan
      ? paragraph(`Your CodeCrawler plan was upgraded from ${fromPlan} to ${toPlan}.`)
      : paragraph(`Your CodeCrawler plan was upgraded to ${toPlan}.`),
    paragraph("Additional credits and features are available immediately."),
    cta(url || webUrl("billing"), "View plan"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Plan upgraded", body) };
}

function renderPlanDowngraded(payload: Record<string, unknown>): RenderedEmail {
  const fromPlan = str(payload, "fromPlan") || str(payload, "previousPlan");
  const toPlan = str(payload, "toPlan") || str(payload, "plan") || "a lower plan";
  const effectiveDate = str(payload, "effectiveDate") || str(payload, "date");
  const url = str(payload, "url");
  const subject = `Plan downgraded · ${toPlan}`;
  const body = [
    fromPlan
      ? paragraph(`Your CodeCrawler plan was changed from ${fromPlan} to ${toPlan}.`)
      : paragraph(`Your CodeCrawler plan was changed to ${toPlan}.`),
    effectiveDate ? paragraph(`The new limits take effect on ${effectiveDate}.`) : "",
    cta(url || webUrl("billing"), "View plan"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Plan downgraded", body) };
}

function renderPaymentFailed(payload: Record<string, unknown>): RenderedEmail {
  const amount = str(payload, "amount") || str(payload, "price");
  const url = str(payload, "invoiceUrl") || str(payload, "url");
  const subject = "Payment failed — action required";
  const body = [
    paragraph("We couldn't process your most recent CodeCrawler payment."),
    amount ? paragraph(`Amount due: ${amount}.`) : "",
    paragraph("Update your payment method to avoid an interruption in service."),
    cta(url || webUrl("billing"), "Update payment method"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Payment failed", body) };
}

function renderPaymentReceived(payload: Record<string, unknown>): RenderedEmail {
  const amount = str(payload, "amount") || str(payload, "price");
  const plan = str(payload, "planName") || str(payload, "plan");
  const url = str(payload, "invoiceUrl") || str(payload, "url");
  const subject = amount ? `Payment received · ${amount}` : "Payment received";
  const body = [
    paragraph("Thanks — we received your CodeCrawler payment."),
    amount ? paragraph(`Amount: ${amount}.`) : "",
    plan ? paragraph(`Plan: ${plan}.`) : "",
    cta(url || webUrl("billing"), "View invoice"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Payment received", body) };
}

function renderQuotaWarning(payload: Record<string, unknown>): RenderedEmail {
  const usage = str(payload, "usage");
  const limit = str(payload, "limit");
  const percent = str(payload, "percent") || "80%";
  const plan = str(payload, "planName") || str(payload, "plan");
  const url = str(payload, "url");
  const subject = `Quota heads-up · ${percent} of monthly reviews used`;
  const body = [
    paragraph(
      `You've used ${percent} of your monthly CodeCrawler review quota${plan ? ` on the ${plan} plan` : ""}.`,
    ),
    usage && limit ? paragraph(`${usage} of ${limit} reviews consumed this cycle.`) : "",
    paragraph("Upgrade your plan to avoid running out of reviews mid-cycle."),
    cta(url || webUrl("billing"), "Upgrade plan"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Quota warning", body) };
}

function renderQuotaExceeded(payload: Record<string, unknown>): RenderedEmail {
  const usage = str(payload, "usage");
  const limit = str(payload, "limit");
  const plan = str(payload, "planName") || str(payload, "plan");
  const url = str(payload, "url");
  const subject = "Quota exceeded — reviews paused";
  const body = [
    paragraph(
      `You've reached your monthly CodeCrawler review quota${plan ? ` on the ${plan} plan` : ""}.`,
    ),
    usage && limit
      ? paragraph(
          `${usage} of ${limit} reviews used. New reviews will resume at the start of your next cycle.`,
        )
      : paragraph("New reviews will resume at the start of your next cycle."),
    paragraph("Upgrade now to unblock reviews immediately."),
    cta(url || webUrl("billing"), "Upgrade plan"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Quota exceeded", body) };
}

function renderAppInstalled(payload: Record<string, unknown>): RenderedEmail {
  const account = str(payload, "account") || str(payload, "accountName");
  const provider = str(payload, "provider") || "GitHub";
  const url = str(payload, "url");
  const subject = account ? `${provider} app installed · ${account}` : `${provider} app installed`;
  const body = [
    paragraph(`The CodeCrawler ${provider} app was installed${account ? ` for ${account}` : ""}.`),
    paragraph("Repositories from this account are now available for review."),
    cta(url || webUrl("repositories"), "Connect a repository"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("App installed", body) };
}

function renderAppUninstalled(payload: Record<string, unknown>): RenderedEmail {
  const account = str(payload, "account") || str(payload, "accountName");
  const provider = str(payload, "provider") || "GitHub";
  const url = str(payload, "url");
  const subject = account
    ? `${provider} app uninstalled · ${account}`
    : `${provider} app uninstalled`;
  const body = [
    paragraph(
      `The CodeCrawler ${provider} app was uninstalled${account ? ` from ${account}` : ""}.`,
    ),
    paragraph("Webhooks and scheduled reviews for this account have been disabled."),
    cta(url || webUrl("settings/integrations"), "Reconnect"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("App uninstalled", body) };
}

function renderConnectionBroken(payload: Record<string, unknown>): RenderedEmail {
  const account = str(payload, "account") || str(payload, "accountName");
  const provider = str(payload, "provider") || "GitHub";
  const reason = str(payload, "reason") || str(payload, "message");
  const url = str(payload, "reconnectUrl") || str(payload, "url");
  const subject = account
    ? `Connection broken · ${provider} (${account})`
    : `Connection broken · ${provider}`;
  const body = [
    paragraph(
      `CodeCrawler can no longer reach your ${provider} account${account ? ` ${account}` : ""}.`,
    ),
    reason ? paragraph(`Reason: ${reason}`) : "",
    paragraph("Reconnect the integration to resume reviews."),
    cta(url || webUrl("settings/integrations"), "Reconnect account"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Connection broken", body) };
}

function renderTokenExpired(payload: Record<string, unknown>): RenderedEmail {
  const account = str(payload, "account") || str(payload, "accountName");
  const provider = str(payload, "provider") || "GitHub";
  const expiresAt = str(payload, "expiresAt") || str(payload, "date");
  const url = str(payload, "reconnectUrl") || str(payload, "url");
  const subject = account
    ? `Token expired · ${provider} (${account})`
    : `Token expired · ${provider}`;
  const body = [
    expiresAt
      ? paragraph(
          `The ${provider} access token for ${account || "your account"} expired on ${expiresAt}.`,
        )
      : paragraph(`The ${provider} access token for ${account || "your account"} has expired.`),
    paragraph("Reconnect to resume reviews."),
    cta(url || webUrl("settings/integrations"), "Reconnect account"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Token expired", body) };
}

function renderSignupReceived(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const signInUrl = str(payload, "signInUrl") || str(payload, "url") || webUrl("sign-in");
  const subject = "We received your sign-up request";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, thanks for requesting access to CodeCrawler.`
        : "Thanks for requesting access to CodeCrawler.",
    ),
    paragraph(
      "Your request is now in the approval queue. An administrator will review it shortly — you'll receive an email as soon as it's approved or denied.",
    ),
    paragraph(
      "Until your account is approved, you won't be able to sign in. You can bookmark this page to try again once you receive your approval email.",
    ),
    cta(signInUrl, "Go to the sign-in page"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Sign-up request received", body) };
}

function renderSignupApproved(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const signInUrl = str(payload, "signInUrl") || str(payload, "url") || webUrl("sign-in");
  const subject = "Your CodeCrawler account was approved";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, good news — your CodeCrawler account has been approved.`
        : "Your CodeCrawler account has been approved.",
    ),
    paragraph("You can now sign in and start using CodeCrawler."),
    cta(signInUrl, "Sign in"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Account approved", body) };
}

function renderSignupDenied(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const reason = str(payload, "reason") || str(payload, "denialReason");
  const supportEmail = str(payload, "supportEmail") || str(payload, "adminEmail");
  const subject = "Your CodeCrawler sign-up request was denied";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, we're sorry, but your request to join CodeCrawler was not approved at this time.`
        : "Your request to join CodeCrawler was not approved at this time.",
    ),
    reason ? paragraph(`Reason: ${reason}`) : "",
    supportEmail
      ? paragraph(`If you believe this is a mistake, contact the administrator at ${supportEmail}.`)
      : paragraph("If you believe this is a mistake, contact the instance administrator."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Sign-up request denied", body) };
}

function renderSignupPendingAdmin(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const email = str(payload, "email");
  const dashboardUrl =
    str(payload, "dashboardUrl") || str(payload, "url") || webUrl("admin/signups");
  const subject = "New sign-up request awaiting approval";
  const body = [
    paragraph("A new sign-up request is waiting in the approval queue."),
    name ? paragraph(`Name: ${name}`) : "",
    email ? paragraph(`Email: ${email}`) : "",
    paragraph("Review and approve or deny the request from the Admin dashboard."),
    cta(dashboardUrl, "Open sign-up requests"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("New sign-up request", body) };
}

function renderAdminRoleGranted(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const actor = str(payload, "actorName") || str(payload, "actor") || "An administrator";
  const dashboardUrl = str(payload, "dashboardUrl") || str(payload, "url") || webUrl("admin");
  const subject = "You are now a CodeCrawler administrator";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, ${actor} granted you administrator access to CodeCrawler.`
        : `${actor} granted you administrator access to CodeCrawler.`,
    ),
    paragraph(
      "As an administrator you can manage sign-ups, control payment availability, and oversee users and teams from the Admin dashboard.",
    ),
    cta(dashboardUrl, "Open the Admin dashboard"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Administrator access granted", body) };
}

function renderAdminRoleRevoked(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const actor = str(payload, "actorName") || str(payload, "actor") || "An administrator";
  const subject = "Your administrator access was revoked";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, ${actor} revoked your administrator access on CodeCrawler.`
        : `${actor} revoked your administrator access on CodeCrawler.`,
    ),
    paragraph(
      "Your account remains active — you just no longer have access to the Admin dashboard.",
    ),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Administrator access revoked", body) };
}

function renderAccountDisabled(payload: Record<string, unknown>): RenderedEmail {
  const name = str(payload, "name");
  const reason = str(payload, "reason");
  const supportEmail = str(payload, "supportEmail") || str(payload, "adminEmail");
  const subject = "Your CodeCrawler account was disabled";
  const body = [
    paragraph(
      name
        ? `Hi ${name}, your CodeCrawler account has been disabled by an administrator.`
        : "Your CodeCrawler account has been disabled by an administrator.",
    ),
    reason ? paragraph(`Reason: ${reason}`) : "",
    supportEmail
      ? paragraph(`If you think this is an error, contact ${supportEmail}.`)
      : paragraph("If you think this is an error, contact the instance administrator."),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { subject, html: shell("Account disabled", body) };
}

const TEMPLATES: Partial<Record<EmailEvent, (payload: Record<string, unknown>) => RenderedEmail>> =
  {
    welcome: renderWelcome,
    "verify-email": renderVerifyEmail,
    "password-reset": renderPasswordReset,
    "email-changed": renderEmailChanged,
    "password-changed": renderPasswordChanged,
    "2fa-enabled": render2faEnabled,
    "2fa-disabled": render2faDisabled,
    "account-deleted": renderAccountDeleted,
    "team-invite": renderTeamInvite,
    "invite-accepted": renderInviteAccepted,
    "invite-declined": renderInviteDeclined,
    "member-removed": renderMemberRemoved,
    "member-left": renderMemberLeft,
    "role-changed": renderRoleChanged,
    "team-created": renderTeamCreated,
    "team-deleted": renderTeamDeleted,
    "subscription-started": renderSubscriptionStarted,
    "subscription-renewing": renderSubscriptionRenewing,
    "subscription-renewed": renderSubscriptionRenewed,
    "subscription-cancelled": renderSubscriptionCancelled,
    "plan-upgraded": renderPlanUpgraded,
    "plan-downgraded": renderPlanDowngraded,
    "payment-failed": renderPaymentFailed,
    "payment-received": renderPaymentReceived,
    "review-completed": renderReviewCompleted,
    "review-failed": renderReviewFailed,
    "review-digest": renderReviewDigest,
    "quota-warning": renderQuotaWarning,
    "quota-exceeded": renderQuotaExceeded,
    "app-installed": renderAppInstalled,
    "app-uninstalled": renderAppUninstalled,
    "connection-broken": renderConnectionBroken,
    "token-expired": renderTokenExpired,
    "signup-received": renderSignupReceived,
    "signup-approved": renderSignupApproved,
    "signup-denied": renderSignupDenied,
    "signup-pending-admin": renderSignupPendingAdmin,
    "admin-role-granted": renderAdminRoleGranted,
    "admin-role-revoked": renderAdminRoleRevoked,
    "account-disabled": renderAccountDisabled,
  };

export function renderEmail(event: EmailEvent, payload: Record<string, unknown>): RenderedEmail {
  const template = TEMPLATES[event];
  if (template) {
    return template(payload);
  }
  return generic(event, payload);
}
