import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Ciphertext formats
// ------------------
// Legacy (pre-rotation):   base64( IV(12) || ciphertext || GCM-tag(16) )
//                          >= 28 bytes; encrypted under the v0 key.
// Versioned (current):     "v2:" + base64( keyId(1) || IV(12) || ciphertext || GCM-tag(16) )
//                          >= 30 bytes; keyId selects the key from TOKEN_ENCRYPTION_KEYS.
//
// The v0 key is `TOKEN_ENCRYPTION_KEY` (base64 32 bytes). Additional keys for
// rotation are declared in `TOKEN_ENCRYPTION_KEYS` as `id:base64` pairs, e.g.
// `0:AAAA...,1:BBBB...`. The first entry is the active encryption key; the rest
// are accepted only for decryption. To rotate: prepend the new key to the list
// and run the re-encrypt migration; once all rows are migrated, drop the old id.
//
// AAD (additional authenticated data)
// -----------------------------------
// GCM binds the tag to (key, IV, ciphertext, AAD). Callers pass a stable
// category string (e.g. "vcs:access_token") so a blob encrypted for one table
// cannot be replayed against another. Legacy ciphertexts were produced without
// AAD; `decryptSecret` falls back to a no-AAD decrypt when the AAD-bound auth
// check fails, so existing rows keep working until re-encrypted.

const V2_PREFIX = "v2:";
const GCM_TAG_LEN = 16;
const GCM_IV_LEN = 12;
const LEGACY_MIN_LEN = GCM_IV_LEN + GCM_TAG_LEN; // 28
const V2_MIN_LEN = 1 + GCM_IV_LEN + GCM_TAG_LEN; // 29 (keyId + IV + tag)

interface EncKey {
  id: number;
  key: Buffer;
}

let cachedKeys: { active: EncKey; all: Map<number, EncKey> } | null = null;
let cachedLegacyKey: Buffer | null = null;

function decodeBase64Key(raw: string, label: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "base64");
  } catch {
    throw new Error(`${label} must be base64-encoded (32 bytes)`);
  }
  if (key.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

/**
 * Parse the key ring.
 *
 * - `TOKEN_ENCRYPTION_KEY` is always key id 0 (the legacy key) and MUST be set.
 * - `TOKEN_ENCRYPTION_KEYS` (optional) is a comma-separated list of `id:base64`
 *   pairs. id 0 may be redeclared there to override (still must equal the
 *   `TOKEN_ENCRYPTION_KEY` value); other ids add new keys. The first entry in
 *   `TOKEN_ENCRYPTION_KEYS` becomes the active encryption key.
 */
function loadKeys(): { active: EncKey; all: Map<number, EncKey> } {
  if (cachedKeys) return cachedKeys;

  const legacyRaw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!legacyRaw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required");
  }
  const legacyKey: EncKey = { id: 0, key: decodeBase64Key(legacyRaw, "TOKEN_ENCRYPTION_KEY") };

  const all = new Map<number, EncKey>([[0, legacyKey]]);
  let active: EncKey = legacyKey;

  const ringRaw = process.env.TOKEN_ENCRYPTION_KEYS?.trim();
  if (ringRaw) {
    for (const entry of ringRaw.split(",")) {
      const parts = entry.split(":");
      if (parts.length !== 2) {
        throw new Error(`TOKEN_ENCRYPTION_KEYS entry "${entry}" must be "id:base64"`);
      }
      const id = Number.parseInt(parts[0], 10);
      if (!Number.isInteger(id) || id < 0 || id > 255) {
        throw new Error(`TOKEN_ENCRYPTION_KEYS entry "${entry}" has an invalid id (must be 0-255)`);
      }
      const key = decodeBase64Key(parts[1], `TOKEN_ENCRYPTION_KEYS entry "${entry}"`);
      if (id === 0 && key.equals(legacyKey.key) === false) {
        throw new Error("TOKEN_ENCRYPTION_KEYS id 0 must equal TOKEN_ENCRYPTION_KEY");
      }
      all.set(id, { id, key });
    }
    // First entry in TOKEN_ENCRYPTION_KEYS is the active encryption key.
    const firstId = Number.parseInt(ringRaw.split(",")[0].split(":")[0], 10);
    const first = all.get(firstId);
    if (!first) {
      throw new Error("TOKEN_ENCRYPTION_KEYS active key resolution failed");
    }
    active = first;
  }

  cachedKeys = { active, all };
  return cachedKeys;
}

function legacyKey(): Buffer {
  if (cachedLegacyKey) return cachedLegacyKey;
  cachedLegacyKey = decodeBase64Key(process.env.TOKEN_ENCRYPTION_KEY ?? "", "TOKEN_ENCRYPTION_KEY");
  return cachedLegacyKey;
}

export interface SecretOpts {
  /** Bound to the GCM auth tag so the ciphertext can't be replayed in another context. */
  aad?: string;
}

export function encryptSecret(plaintext: string, opts?: SecretOpts): string {
  const { active } = loadKeys();
  const iv = randomBytes(GCM_IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  if (opts?.aad) cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // keyId(1) || IV(12) || ciphertext || tag(16)
  const payload = Buffer.concat([Buffer.from([active.id]), iv, enc, tag]);
  return V2_PREFIX + payload.toString("base64");
}

function decryptWithKey(blob: Buffer, key: Buffer, aad: string | undefined): string {
  const keyId = blob.subarray(0, 1);
  const iv = blob.subarray(1, 1 + GCM_IV_LEN);
  const tag = blob.subarray(blob.length - GCM_TAG_LEN);
  const enc = blob.subarray(1 + GCM_IV_LEN, blob.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  try {
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  } catch (err) {
    throw new Error(
      `decryptSecret: GCM auth failed (keyId=${keyId[0]}, aad=${aad ? "set" : "none"}): ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

function decryptLegacy(raw: string, aad: string | undefined): string {
  // Legacy ciphertexts never carried AAD; honouring `aad` here would always
  // fail, so we ignore it deliberately.
  void aad;
  const buf = Buffer.from(raw, "base64");
  if (buf.length < LEGACY_MIN_LEN) {
    throw new Error("decryptSecret: legacy ciphertext is too short");
  }
  const iv = buf.subarray(0, GCM_IV_LEN);
  const tag = buf.subarray(buf.length - GCM_TAG_LEN);
  const enc = buf.subarray(GCM_IV_LEN, buf.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", legacyKey(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString("utf8");
}

export function decryptSecret(ciphertext: string, opts?: SecretOpts): string {
  const aad = opts?.aad;
  if (typeof ciphertext !== "string" || ciphertext.length === 0) {
    throw new Error("decryptSecret: empty ciphertext");
  }
  // Versioned format.
  if (ciphertext.startsWith(V2_PREFIX)) {
    const buf = Buffer.from(ciphertext.slice(V2_PREFIX.length), "base64");
    if (buf.length < V2_MIN_LEN) {
      throw new Error("decryptSecret: v2 ciphertext is too short");
    }
    const keyId = buf[0];
    const entry = loadKeys().all.get(keyId);
    if (!entry) {
      throw new Error(`decryptSecret: unknown key id ${keyId} (update TOKEN_ENCRYPTION_KEYS)`);
    }
    try {
      return decryptWithKey(buf, entry.key, aad);
    } catch (err) {
      // Maybe the value predates AAD binding. Retry without AAD so legacy
      // rows keep decrypting until they're re-encrypted.
      if (aad) {
        return decryptWithKey(buf, entry.key, undefined);
      }
      throw err;
    }
  }
  // Legacy format (no "v2:" prefix).
  return decryptLegacy(ciphertext, aad);
}

/**
 * True when the value looks like something `encryptSecret` produced. Use to
 * decide whether a stored column still holds plaintext that needs migrating.
 */
export function isEncryptedSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(V2_PREFIX)) {
    try {
      const buf = Buffer.from(trimmed.slice(V2_PREFIX.length), "base64");
      return buf.length >= V2_MIN_LEN;
    } catch {
      return false;
    }
  }
  try {
    const buf = Buffer.from(trimmed, "base64");
    return buf.length >= LEGACY_MIN_LEN;
  } catch {
    return false;
  }
}
