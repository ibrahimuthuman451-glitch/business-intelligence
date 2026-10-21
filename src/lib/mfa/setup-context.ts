import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getCurrentActor } from "../current-user";
import { readMfaEnrollCookie } from "../session-cookie";
import { findMfaChallenge } from "./service";

export type MfaSetupContext = {
  userId: string;
  email: string;
  mode: "session" | "enroll";
  challengeId: string | null;
};

/** Authenticates MFA setup either from a normal session or a login enrollment challenge. */
export async function getMfaSetupContext(): Promise<MfaSetupContext | null> {
  const actor = await getCurrentActor();
  if (actor) {
    return { userId: actor.user.id, email: actor.user.email, mode: "session", challengeId: null };
  }
  const token = await readMfaEnrollCookie();
  if (!token) return null;
  const challenge = await findMfaChallenge(getDb(), token, "enroll");
  if (!challenge) return null;
  const [user] = await getDb()
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, challenge.userId))
    .limit(1);
  if (!user) return null;
  return { userId: challenge.userId, email: user.email, mode: "enroll", challengeId: challenge.id };
}
