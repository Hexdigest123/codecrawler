import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64-encoded (32 bytes)");
  }
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes");
  }
  cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 28) {
    throw new Error("decryptSecret: ciphertext is too short");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const encrypted = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function isEncryptedSecret(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const buf = Buffer.from(trimmed, "base64");
    return buf.length >= 28;
  } catch {
    return false;
  }
}
