import { env } from "@codecrawler/shared";

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : String(value);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function shell(title: string, bodyHtml: string): string {
  const logoUrl = webUrl("logo.webp");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="light only" />',
    '<meta name="supported-color-schemes" content="light only" />',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background:#f4f4f5;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">',
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;overflow:hidden;">',
    '<tr><td style="padding:28px 40px 0 40px;">',
    `<img src="${escapeHtml(logoUrl)}" alt="CodeCrawler" width="120" height="88" style="display:block;width:120px;max-width:120px;height:auto;border:0;outline:none;text-decoration:none;" />`,
    "</td></tr>",
    `<tr><td style="padding:24px 40px 0 40px;font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:#18181b;">${escapeHtml(title)}</td></tr>`,
    `<tr><td style="padding:16px 40px 32px 40px;font-size:15px;line-height:1.6;color:#3f3f46;">${bodyHtml}</td></tr>`,
    '<tr><td style="padding:0 40px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #f4f4f5;font-size:0;line-height:0;">&nbsp;</td></tr></table>',
    "</td></tr>",
    '<tr><td style="padding:20px 40px 28px 40px;font-size:12px;line-height:1.5;color:#a1a1aa;">',
    `Sent by CodeCrawler.&nbsp;&nbsp;<a href="${escapeHtml(webUrl("account/notifications"))}" style="color:#a1a1aa;text-decoration:underline;">Notification preferences</a>`,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 14px 0;">${escapeHtml(text)}</p>`;
}

export function cta(href: string, label: string): string {
  if (!href) {
    return "";
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px 0;"><tr><td style="border-radius:10px;background:#4f46e5;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;font-family:inherit;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a></td></tr></table>`;
}

export function codeBox(text: string): string {
  if (!text) {
    return "";
  }
  return `<pre style="white-space:pre-wrap;word-break:break-word;background:#fafafa;border:1px solid #f4f4f5;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.5;margin:0 0 16px 0;color:#3f3f46;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(text)}</pre>`;
}

export function webUrl(path = ""): string {
  const base = env.PUBLIC_WEB_URL;
  if (!path) {
    return base;
  }
  return path.startsWith("http") ? path : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
