/** Verifies private S3-compatible storage end to end, including an unsigned public check. */
import { randomUUID } from "node:crypto";
import { S3StorageDriver } from "../src/lib/storage-s3";

async function main() {
  if ((process.env.STORAGE_DRIVER ?? "local").toLowerCase() !== "s3") {
    throw new Error("Set STORAGE_DRIVER=s3 and the S3_* variables first");
  }
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
  }
  const forcePathStyle = (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false";
  const driver = new S3StorageDriver({
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
  });
  const key = `staging-checks/${randomUUID()}.txt`;
  const payload = `ledgerline staging object ${new Date().toISOString()}`;
  await driver.put(key, Buffer.from(payload), "text/plain");
  const read = (await driver.get(key)).toString("utf8");
  if (read !== payload) throw new Error("Object roundtrip mismatch");
  const listed = await driver.list("staging-checks/");
  if (!listed.some((object) => object.key === key)) throw new Error("Uploaded object not listed");

  const base = endpoint?.replace(/\/$/, "") ?? `https://${bucket}.s3.${region}.amazonaws.com`;
  const publicUrl = forcePathStyle || endpoint ? `${base}/${bucket}/${key}` : `${base}/${key}`;
  const publicResponse = await fetch(publicUrl, { method: "GET" }).catch(() => null);
  if (publicResponse?.status === 200) {
    await driver.delete(key);
    throw new Error("Anonymous GET succeeded: the bucket appears public");
  }

  await driver.delete(key);
  const after = await driver.list("staging-checks/");
  if (after.some((object) => object.key === key)) throw new Error("Object was not deleted");
  console.log(
    JSON.stringify({
      status: "ok",
      driver: "s3",
      roundtrip: true,
      anonymousGetStatus: publicResponse?.status ?? "blocked",
      deleted: true,
    }),
  );
}

main().catch((error) => {
  console.error("S3 verification failed:", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
