const VALID_ROLES = new Set(["owner", "staff", "advisor", "firm_admin", "platform_admin"]);

/** MFA_REQUIRED_FOR is a comma list of roles; default protects platform admins. */
export function mfaRequiredRoles(): Set<string> {
  const raw = process.env.MFA_REQUIRED_FOR?.trim() ?? "platform_admin";
  if (raw === "" || raw.toLowerCase() === "none") return new Set();
  if (raw.toLowerCase() === "all") return VALID_ROLES;
  return new Set(
    raw
      .split(",")
      .map((role) => role.trim().toLowerCase())
      .filter((role) => VALID_ROLES.has(role)),
  );
}

export function mfaRequiredForActor(input: {
  isPlatformAdmin: boolean;
  roles: string[];
}): boolean {
  const required = mfaRequiredRoles();
  if (input.isPlatformAdmin && required.has("platform_admin")) return true;
  return input.roles.some((role) => required.has(role));
}
