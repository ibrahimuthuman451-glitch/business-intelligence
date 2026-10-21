import { cookies } from "next/headers";

export const SESSION_COOKIE = "bi_session";
export const ACTIVE_ORG_COOKIE = "bi_org";

const baseOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { ...baseOptions, expires: expiresAt });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", { ...baseOptions, expires: new Date(0) });
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setActiveOrgCookie(orgId: string): Promise<void> {
  (await cookies()).set(ACTIVE_ORG_COOKIE, orgId, {
    ...baseOptions,
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function readActiveOrgCookie(): Promise<string | undefined> {
  return (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
}
