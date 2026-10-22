#!/usr/bin/env node
/**
 * One-command Windows setup for Vercel + Supabase.
 *
 * It never writes secrets to Git: values are saved to .env.deploy.local, which is
 * ignored by .gitignore. It never prints secret values.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const ENV_FILE = path.join(root, ".env.deploy.local");

if (args.has("--help") || args.has("-h")) {
  console.log(`Ledgerline Windows setup

Usage:
  powershell -ExecutionPolicy Bypass -File .\\deploy\\windows-setup.ps1
  node scripts/windows-setup.mjs [options]

Options:
  --no-deploy         Prepare/migrate/seed/verify only; print Vercel next steps
  --skip-install      Do not run npm ci
  --skip-seed         Do not reset the demo workspace
  --skip-smtp         Do not send the SMTP verification email
  --skip-build        Do not run the local production build
  -h, --help          Show this help

The script asks for Supabase/Brevo/S3 values locally. It never stores them in Git.
`);
  process.exit(0);
}

const pipedLines = process.stdin.isTTY
  ? null
  : (() => {
      try {
        return readFileSync(0, "utf8").split(/\r?\n/);


      } catch {
        return [];
      }
    })();
let pipedIndex = 0;

function nextPipedLine(promptText) {
  process.stdout.write(promptText);
  return pipedLines[pipedIndex++] ?? "";
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function requireInteractive() {
  if (args.has("--non-interactive")) fail("Interactive setup cannot run with --non-interactive.");
}

function normalise(value) {
  return value.trim();
}

let sharedReadline = null;

function getReadline() {
  if (!sharedReadline) {
    sharedReadline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
  }
  return sharedReadline;
}

async function ask(label, options = {}) {
  const { defaultValue = "", required = true, secret = false } = options;
  if (secret) return askSecret(label, defaultValue);
  const promptText = `${label}${defaultValue ? " [press Enter to keep saved value]" : ""}: `;
  const answer = pipedLines ? nextPipedLine(promptText) : await getReadline().question(promptText);
  const result = normalise(answer) || defaultValue;
  if (required && !result) fail(`${label} is required.`);
  return result;
}

async function askSecret(label, defaultValue = "") {
  const rl = getReadline();
  if (!process.stdin.isTTY) {
    const answer = nextPipedLine(`${label}${defaultValue ? " [Enter keeps saved value]" : ""}: `);
    return normalise(answer) || defaultValue;
  }
  rl.pause();
  return new Promise((resolve, reject) => {
    process.stdout.write(`${label}${defaultValue ? " [Enter keeps saved value]" : ""}: `);
    let value = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.removeListener("data", onData);
      rl.resume();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") { cleanup(); process.stdout.write("\n"); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          const result = value || defaultValue;
          if (!result) { reject(new Error(`${label} is required`)); return; }
          resolve(result);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
          continue;
        }
        if (char >= " ") {
          value += char;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  }).catch((error) => fail(error.message));
}

function readExistingEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const result = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    result[match[1]] = value;
  }
  return result;
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function validateUrl(value, label, protocols) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} is not a valid URL.`); }
  if (!protocols.includes(url.protocol)) fail(`${label} must start with ${protocols.join(" or ")}.`);
  return value;
}

function run(label, command, commandArgs, env, options = {}) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.allowFailure) return result;
    fail(`${label} failed with exit code ${result.status}. Read the output above; no Vercel deploy was started.`);
  }
  return result;
}

async function main() {
  requireInteractive();
  console.log(`Ledgerline setup — Vercel + Supabase\nProject: ${root}\n`);
  console.log("Before continuing, create the free Supabase project, private bucket, S3 keys, and Brevo SMTP key.");
  console.log("Do not paste secrets into chat; this script reads them locally and masks them.\n");

  const existing = readExistingEnv();
  const projectName = await ask("Vercel project name", { defaultValue: existing.VERCEL_PROJECT ?? "ledgerline-demo" });
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(projectName)) fail("Project name must contain lowercase letters, numbers, and hyphens.");
  const appUrl = await ask("Public app URL (use https://<project>.vercel.app for now)", {
    defaultValue: existing.APP_URL ?? `https://${projectName}.vercel.app`,
  });
  validateUrl(appUrl, "APP_URL", ["https:"]);

  const databaseUrl = await ask("Supabase TRANSACTION pooler URL (port 6543, used by Vercel)", {
    defaultValue: existing.DATABASE_URL ?? "", required: true, secret: true,
  });
  validateUrl(databaseUrl, "DATABASE_URL", ["postgres:", "postgresql:"]);
  const migrationUrl = await ask("Supabase SESSION pooler URL (port 5432, used for migrations)", {
    defaultValue: existing.MIGRATION_DATABASE_URL || databaseUrl, required: true, secret: true,
  });
  validateUrl(migrationUrl, "MIGRATION_DATABASE_URL", ["postgres:", "postgresql:"]);

  const s3Bucket = await ask("Supabase private bucket name", { defaultValue: existing.S3_BUCKET ?? "ledgerline-private" });
  const s3Region = await ask("S3 region from Supabase Storage settings", { defaultValue: existing.S3_REGION ?? "" });
  const s3Endpoint = await ask("S3 endpoint from Supabase Storage settings", { defaultValue: existing.S3_ENDPOINT ?? "" });
  validateUrl(s3Endpoint, "S3_ENDPOINT", ["https:"]);
  const s3AccessKey = await ask("S3 access key ID", { defaultValue: existing.S3_ACCESS_KEY_ID ?? "", secret: true });
  const s3SecretKey = await ask("S3 secret access key", { defaultValue: existing.S3_SECRET_ACCESS_KEY ?? "", secret: true });

  const smtpUrl = await ask("SMTP URL (Brevo example: smtp://login:key@smtp-relay.brevo.com:587)", {
    defaultValue: existing.SMTP_URL ?? "", required: true, secret: true,
  });
  validateUrl(smtpUrl, "SMTP_URL", ["smtp:", "smtps:"]);
  const emailFrom = await ask("Verified sender (e.g. Ledgerline <no-reply@your-domain>)", { defaultValue: existing.EMAIL_FROM ?? "" });
  const verifyEmailTo = await ask("Your mailbox for one SMTP verification email (optional)", { defaultValue: existing.VERIFY_EMAIL_TO ?? "", required: false });
  const mfaRequiredFor = await ask("MFA_REQUIRED_FOR policy", { defaultValue: existing.MFA_REQUIRED_FOR ?? "platform_admin" });

  const mfaKey = existing.MFA_ENCRYPTION_KEY || randomBytes(32).toString("base64");
  const jobsSecret = existing.JOBS_SECRET || randomBytes(32).toString("base64url");

  const values = {
    VERCEL_PROJECT: projectName,
    APP_URL: appUrl,
    DATABASE_URL: databaseUrl,
    MIGRATION_DATABASE_URL: migrationUrl,
    DATABASE_PREPARE: "false",
    DATABASE_POOL_MAX: "3",
    STORAGE_DRIVER: "s3",
    S3_BUCKET: s3Bucket,
    S3_REGION: s3Region,
    S3_ENDPOINT: s3Endpoint,
    S3_ACCESS_KEY_ID: s3AccessKey,
    S3_SECRET_ACCESS_KEY: s3SecretKey,
    S3_FORCE_PATH_STYLE: "true",
    EMAIL_TRANSPORT: "smtp",
    SMTP_URL: smtpUrl,
    EMAIL_FROM: emailFrom,
    VERIFY_EMAIL_TO: verifyEmailTo,
    MFA_ENCRYPTION_KEY: mfaKey,
    MFA_REQUIRED_FOR: mfaRequiredFor,
    JOBS_SECRET: jobsSecret,
    AUTH_DEV_EXPOSE_TOKENS: "false",
    MAX_UPLOAD_BYTES: "4194304",
    SEED_DEMO_DATA: "false",
  };

  const envText = Object.entries(values).map(([key, value]) => `${key}=${quoteEnv(value)}`).join("\n") + "\n";
  writeFileSync(ENV_FILE, envText, { mode: 0o600 });
  try { chmodSync(ENV_FILE, 0o600); } catch { /* Windows ACLs apply */ }
  console.log(`\nSaved local deployment values to ${ENV_FILE}`);
  console.log("This file contains secrets and is git-ignored. Do not upload or commit it.");

  const seedEnv = {
    ...values,
    DATABASE_URL: migrationUrl,
    EMAIL_TRANSPORT: "disabled",
    NODE_ENV: "production",
    SEED_DEMO_DATA: "true",
  };

  if (!args.has("--skip-install")) run("Installing dependencies", NPM, ["ci"], {});
  run("Applying database migrations", NPM, ["run", "db:migrate"], {
    MIGRATION_DATABASE_URL: migrationUrl,
    DATABASE_URL: databaseUrl,
  });

  if (!args.has("--skip-seed")) {
    run("Restoring the sample demo workspace", NPM, ["run", "demo:reset"], seedEnv);
  }

  run("Verifying private S3 storage", NPM, ["run", "verify:s3"], values);

  if (!args.has("--skip-smtp") && verifyEmailTo) {
    run("Sending SMTP verification", NPM, ["run", "verify:smtp"], {
      ...values, EMAIL_TRANSPORT: "smtp", VERIFY_EMAIL_TO: verifyEmailTo,
    });
  }

  if (!args.has("--skip-build")) run("Building production application", NPM, ["run", "build"], {});

  if (args.has("--no-deploy")) {
    console.log("\nPreparation complete. Set the variables in Vercel, then run:");
    console.log("  npx vercel link --yes --project " + projectName);
    console.log("  npx vercel deploy --prod --yes");
    console.log("\nThen configure cron-job.org: POST " + appUrl + "/api/jobs/run with Authorization: Bearer <JOBS_SECRET>.");
    return;
  }

  const who = run("Checking Vercel login", NPX, ["--yes", "vercel@latest", "whoami"], {}, { capture: true, allowFailure: true });
  if (who.status !== 0) {
    console.log("\nVercel CLI is not logged in. Run this in a new PowerShell window, complete the browser login, then run this script again:");
    console.log("  npx --yes vercel@latest login");
    console.log("No Vercel deploy was attempted.");
    process.exit(2);
  }

  console.log("\n▶ Creating/linking Vercel project");
  const created = run("  vercel project create", NPX, ["--yes", "vercel@latest", "project", "create", projectName, "--no-color"], {}, { allowFailure: true });
  if (created.status !== 0) console.log("  Project may already exist; continuing to link.");
  run("  vercel link", NPX, ["--yes", "vercel@latest", "link", "--yes", "--project", projectName, "--no-color"], {});

  const vercelEnv = {
    APP_URL: appUrl,
    DATABASE_URL: databaseUrl,
    DATABASE_PREPARE: "false",
    DATABASE_POOL_MAX: "3",
    STORAGE_DRIVER: "s3",
    S3_BUCKET: s3Bucket,
    S3_REGION: s3Region,
    S3_ENDPOINT: s3Endpoint,
    S3_ACCESS_KEY_ID: s3AccessKey,
    S3_SECRET_ACCESS_KEY: s3SecretKey,
    S3_FORCE_PATH_STYLE: "true",
    EMAIL_TRANSPORT: "smtp",
    SMTP_URL: smtpUrl,
    EMAIL_FROM: emailFrom,
    MFA_ENCRYPTION_KEY: mfaKey,
    MFA_REQUIRED_FOR: mfaRequiredFor,
    JOBS_SECRET: jobsSecret,
    AUTH_DEV_EXPOSE_TOKENS: "false",
    MAX_UPLOAD_BYTES: "4194304",
    SEED_DEMO_DATA: "false",
  };

  for (const [name, value] of Object.entries(vercelEnv)) {
    console.log(`› Setting Vercel variable ${name}`);
    const result = spawnSync(
      NPX,
      ["--yes", "vercel@latest", "env", "add", name, "production", "--force", "--yes", "--sensitive", "--no-color"],
      { cwd: root, env: process.env, input: `${value}\n`, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
    if (result.status !== 0) {
      console.error(`Could not set ${name}. Add it manually in Vercel → Settings → Environment Variables.`);
      console.error((result.stderr || result.stdout || "").slice(0, 500));
      process.exit(1);
    }
  }

  run("Deploying to Vercel production", NPX, ["--yes", "vercel@latest", "deploy", "--prod", "--yes", "--no-color"], {});
  console.log("\nDeployment finished. Open the URL printed above; then verify:");
  console.log("  " + appUrl + "/api/health");
  console.log("  login as demo@ledgerline.local / DemoPassword9!");
  console.log("\nCreate the cron-job.org job: POST " + appUrl + "/api/jobs/run with Authorization: Bearer <JOBS_SECRET> every 15 minutes.");
  console.log("If the first URL differs, update APP_URL in Vercel and redeploy.");
}

main()
  .then(() => {
    sharedReadline?.close();
  })
  .catch((error) => {
    sharedReadline?.close();
    console.error("\nSetup stopped:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
