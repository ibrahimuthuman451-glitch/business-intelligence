import { appUrl } from "../request";

export type RenderedEmail = { subject: string; text: string; html: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): RenderedEmail {
  const safeTitle = escapeHtml(title);
  const text = [
    title,
    "",
    ...paragraphs,
    ...(action ? ["", `${action.label}: ${action.url}`] : []),
    "",
    "— Ledgerline",
    "This is an automated message. Do not reply with passwords or government portal credentials.",
  ].join("\n");

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f4ef;padding:24px;color:#101a2b">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2ddd2;border-radius:12px;padding:28px">
    <p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#b85c38;font-weight:700;margin:0 0 8px">Ledgerline</p>
    <h1 style="font-size:22px;margin:0 0 16px">${safeTitle}</h1>
    ${paragraphs.map((paragraph) => `<p style="line-height:1.55;margin:0 0 14px">${escapeHtml(paragraph)}</p>`).join("\n    ")}
    ${action ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#101a2b;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>` : ""}
    <hr style="border:none;border-top:1px solid #e2ddd2;margin:24px 0" />
    <p style="font-size:12px;color:#6b7688;line-height:1.5;margin:0">Ledgerline · automated message. Never share passwords or government portal credentials. If you did not expect this email, you can ignore it.</p>
  </div>
</body></html>`;

  return { subject: title, text, html };
}

export function verificationEmailWithToken(token: string): RenderedEmail & { link: string } {
  const link = `${appUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    ...layout(
      "Verify your email address",
      [
        "Confirm this address to finish setting up your Ledgerline workspace.",
        "This link expires in 24 hours and can be used once.",
      ],
      { label: "Verify email", url: link },
    ),
    link,
  };
}

export function passwordResetEmailWithToken(token: string): RenderedEmail & { link: string } {
  const link = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    ...layout(
      "Reset your Ledgerline password",
      [
        "A password reset was requested for this address.",
        "The link expires in one hour and can be used once. All existing sessions will be signed out when the password changes.",
        "If you did not request this, no action is needed.",
      ],
      { label: "Choose a new password", url: link },
    ),
    link,
  };
}

export function invitationEmailWithToken(input: {
  organizationName: string;
  role: string;
  kind: string;
  token: string;
}): RenderedEmail & { link: string } {
  const link = `${appUrl()}/invite/${encodeURIComponent(input.token)}`;
  const access = input.kind === "advisor" ? "view this business's records" : "join the workspace";
  return {
    ...layout(
      `You are invited to ${input.organizationName}`,
      [
        `You have been invited as ${input.role.replace("_", " ")} to ${access}.`,
        "This invitation expires in 7 days. It only works for this email address.",
      ],
      { label: "Review invitation", url: link },
    ),
    link,
  };
}

export function documentRequestEmail(input: {
  organizationName: string;
  title: string;
  dueDate?: string | null;
  link: string;
}): RenderedEmail {
  return layout(
    `Document requested: ${input.title}`,
    [
      `${input.organizationName} has a document request waiting.`,
      input.dueDate ? `Due date: ${input.dueDate}.` : "No due date was set.",
      "Upload the file in the private document room so your advisor can review it.",
    ],
    { label: "Open document room", url: input.link },
  );
}

export function taskAssignedEmail(input: {
  organizationName: string;
  title: string;
  dueDate?: string | null;
  link: string;
}): RenderedEmail {
  return layout(
    `Task assigned: ${input.title}`,
    [
      `A task was assigned to you in ${input.organizationName}.`,
      input.dueDate ? `Due date: ${input.dueDate}.` : "No due date was set.",
    ],
    { label: "Open task list", url: input.link },
  );
}

export function tenderDeadlineEmail(input: {
  organizationName: string;
  title: string;
  closesAt: string;
  daysLeft: number;
  link: string;
}): RenderedEmail {
  return layout(
    `Tender deadline in ${input.daysLeft} day${input.daysLeft === 1 ? "" : "s"}`,
    [
      `${input.organizationName}: ${input.title}`,
      `The recorded closing date is ${input.closesAt}. Confirm it on the official notice before relying on it.`,
      "Relevance is not eligibility; verify mandatory requirements in the source document.",
    ],
    { label: "Review tender", url: input.link },
  );
}

export function documentReviewedEmail(input: {
  organizationName: string;
  filename: string;
  status: string;
  note?: string | null;
  link: string;
}): RenderedEmail {
  return layout(
    `Document ${input.status.replace("_", " ")}`,
    [
      `${input.filename} was marked ${input.status.replace("_", " ")} in ${input.organizationName}.`,
      input.note ? `Reviewer note: ${input.note}` : "No reviewer note was added.",
    ],
    { label: "Open document room", url: input.link },
  );
}

export function documentFulfilledEmail(input: {
  organizationName: string;
  title: string;
  filename: string;
  link: string;
}): RenderedEmail {
  return layout(
    `Document request fulfilled: ${input.title}`,
    [
      `${input.organizationName} uploaded ${input.filename} against your request.`,
      "Review the file in the private document room and record your findings.",
    ],
    { label: "Review document", url: input.link },
  );
}
