/** Client-side WebAuthn helpers for app unlock (Face ID / Touch ID / device PIN where supported). */

const STORAGE_ENABLED = "zero_bio_lock_enabled_v1";
const STORAGE_CRED_ID = "zero_bio_lock_cred_v1";
const STORAGE_USER_ID = "zero_bio_lock_user_v1";

function randomChallenge(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

function randomUserId(): Uint8Array {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return buf;
}

export function bioLockIsSupported(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.isSecureContext &&
      window.PublicKeyCredential &&
      typeof navigator?.credentials?.create === "function" &&
      typeof navigator?.credentials?.get === "function",
  );
}

export async function bioLockPlatformAuthenticatorAvailable(): Promise<boolean> {
  try {
    const fn = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof fn !== "function") return bioLockIsSupported();
    return await fn.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

function credentialIdToBase64(id: ArrayBuffer | Uint8Array): string {
  const bytes = id instanceof Uint8Array ? id : new Uint8Array(id);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToCredentialId(b64: string): ArrayBuffer {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const base64 = b64.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bioLockReadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_ENABLED) === "1";
  } catch {
    return false;
  }
}

export function bioLockReadCredentialIdB64(): string | null {
  try {
    const s = localStorage.getItem(STORAGE_CRED_ID);
    return s && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

export function bioLockClear(): void {
  try {
    localStorage.removeItem(STORAGE_ENABLED);
    localStorage.removeItem(STORAGE_CRED_ID);
    localStorage.removeItem(STORAGE_USER_ID);
  } catch {
    // ignore
  }
}

function rpId(): string {
  return window.location.hostname || "localhost";
}

function getOrCreateUserId(): Uint8Array {
  try {
    const existing = localStorage.getItem(STORAGE_USER_ID);
    if (existing) {
      const buf = base64ToCredentialId(existing);
      return new Uint8Array(buf);
    }
  } catch {
    // ignore
  }
  const uid = randomUserId();
  try {
    localStorage.setItem(STORAGE_USER_ID, credentialIdToBase64(uid));
  } catch {
    // ignore
  }
  return uid;
}

export async function bioLockRegister(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!bioLockIsSupported()) {
    return { ok: false, message: "Biometric unlock needs HTTPS and a supported browser." };
  }
  const userId = getOrCreateUserId();
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomChallenge() as BufferSource,
        rp: { name: "Zero", id: rpId() },
        user: {
          id: Uint8Array.from(userId) as BufferSource,
          name: "zero-local",
          displayName: "Zero",
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: {
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 120_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred?.rawId) {
      return { ok: false, message: "Registration was cancelled." };
    }
    const idB64 = credentialIdToBase64(cred.rawId);
    localStorage.setItem(STORAGE_CRED_ID, idB64);
    localStorage.setItem(STORAGE_ENABLED, "1");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Registration failed.";
    return { ok: false, message: msg };
  }
}

export async function bioLockAuthenticate(): Promise<boolean> {
  if (!bioLockIsSupported()) return false;
  const idB64 = bioLockReadCredentialIdB64();
  if (!idB64) return false;
  try {
    const idBuf = base64ToCredentialId(idB64);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomChallenge() as BufferSource,
        allowCredentials: [{ id: new Uint8Array(idBuf) as BufferSource, type: "public-key" }],
        userVerification: "required",
        timeout: 120_000,
      },
    });
    return assertion != null;
  } catch {
    return false;
  }
}
