import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  APPS_SCRIPT_URL?: string;
  APPS_SCRIPT_TOKEN?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  PENDING_SUBMISSIONS?: R2BucketBinding;
  SUBMISSION_QUEUE?: QueueProducer<SubmissionJob>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface R2ObjectBody {
  text(): Promise<string>;
}

interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: string,
    options?: {
      onlyIf?: { etagDoesNotMatch?: string };
      httpMetadata?: { contentType?: string };
    },
  ): Promise<object | null>;
  delete(key: string): Promise<void>;
}

interface QueueProducer<T> {
  send(message: T): Promise<void>;
}

interface QueueMessage<T> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface QueueBatch<T> {
  messages: readonly QueueMessage<T>[];
}

type SubmissionPayload = {
  submissionId?: unknown;
  fullName?: unknown;
  address?: unknown;
  whatsapp?: unknown;
  proof?: unknown;
  turnstileToken?: unknown;
  website?: unknown;
  noticeVersion?: unknown;
};

type ProofPayload = {
  mimeType?: unknown;
  size?: unknown;
  base64?: unknown;
};

type ValidSubmission = {
  submissionId: string;
  fullName: string;
  address: string;
  whatsapp: string;
  noticeVersion: string;
  proof: {
    mimeType: string;
    size: number;
    base64: string;
  };
};

type PendingSubmission = {
  schemaVersion: 1;
  fingerprint: string;
  acceptedAt: string;
  payload: ValidSubmission & {
    amount: 25000;
    privacyAccepted: true;
  };
};

type SubmissionState = "processing" | "synced" | "delayed";

type SubmissionStatusRecord = {
  schemaVersion: 1;
  submissionId: string;
  fingerprint: string;
  state: SubmissionState;
  acceptedAt: string;
  updatedAt: string;
  attempts?: number;
};

type SubmissionJob = {
  schemaVersion: 1;
  submissionId: string;
};

const MAX_REQUEST_BYTES = 320 * 1024;
const MAX_PROOF_BYTES = 70 * 1024;
const TURNSTILE_ACTION = "passport_submit";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_PATTERN = /^628\d{8,12}$/;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodedSize(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function matchesMagicBytes(mimeType: string, base64: string) {
  try {
    const binary = atob(base64.slice(0, 24));
    const bytes = Array.from(binary, (character) => character.charCodeAt(0));
    if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mimeType === "image/png") {
      return bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
    }
    if (mimeType === "image/webp") {
      return binary.slice(0, 4) === "RIFF" && binary.slice(8, 12) === "WEBP";
    }
    return false;
  } catch {
    return false;
  }
}

function validateSubmission(payload: SubmissionPayload): { error: string } | { value: ValidSubmission } {
  const submissionId = asTrimmedString(payload.submissionId);
  const fullName = asTrimmedString(payload.fullName);
  const address = asTrimmedString(payload.address);
  const whatsapp = asTrimmedString(payload.whatsapp);
  const noticeVersion = asTrimmedString(payload.noticeVersion);
  const proof = (payload.proof && typeof payload.proof === "object" ? payload.proof : {}) as ProofPayload;
  const mimeType = asTrimmedString(proof.mimeType);
  const base64 = asTrimmedString(proof.base64);
  const claimedSize = typeof proof.size === "number" ? proof.size : 0;
  const actualSize = decodedSize(base64);

  if (!UUID_PATTERN.test(submissionId)) return { error: "ID pengajuan tidak valid." };
  if (fullName.length < 3 || fullName.length > 100 || !/^[\p{L}\p{M} .'-]+$/u.test(fullName)) {
    return { error: "Nama penerima tidak valid." };
  }
  if (address.length < 15 || address.length > 500) return { error: "Alamat penerima tidak valid." };
  if (!PHONE_PATTERN.test(whatsapp)) return { error: "Nomor WhatsApp tidak valid." };
  if (!ALLOWED_MIME.has(mimeType)) return { error: "Format bukti pembayaran tidak didukung." };
  if (!Number.isInteger(claimedSize) || claimedSize < 100 || claimedSize >= MAX_PROOF_BYTES) {
    return { error: "Ukuran bukti pembayaran tidak valid." };
  }
  if (actualSize < 100 || actualSize >= MAX_PROOF_BYTES || Math.abs(actualSize - claimedSize) > 2) {
    return { error: "Data bukti pembayaran tidak valid." };
  }
  if (!matchesMagicBytes(mimeType, base64)) return { error: "Isi file bukti pembayaran tidak valid." };

  return {
    value: { submissionId, fullName, address, whatsapp, noticeVersion, proof: { mimeType, size: actualSize, base64 } },
  };
}

async function verifyTurnstile(secret: string, token: string, remoteIp: string, expectedHostname: string) {
  if (!token) return false;
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean; hostname?: string; action?: string };
  return result.success === true && result.hostname === expectedHostname && result.action === TURNSTILE_ACTION;
}

function isAllowedAppsScriptUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" && url.pathname.startsWith("/macros/s/") && url.pathname.endsWith("/exec");
  } catch {
    return false;
  }
}

function pendingObjectKey(submissionId: string) {
  return `pending/${submissionId}.json`;
}

function statusObjectKey(submissionId: string) {
  return `status/${submissionId}.json`;
}

async function readJsonObject<T>(bucket: R2BucketBinding, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as T;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprintSubmission(value: ValidSubmission) {
  return sha256Hex(JSON.stringify(value));
}

function isStatusRecord(value: unknown): value is SubmissionStatusRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SubmissionStatusRecord>;
  return record.schemaVersion === 1 &&
    typeof record.submissionId === "string" &&
    UUID_PATTERN.test(record.submissionId) &&
    typeof record.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(record.fingerprint) &&
    (record.state === "processing" || record.state === "synced" || record.state === "delayed") &&
    typeof record.acceptedAt === "string" &&
    typeof record.updatedAt === "string";
}

function isPendingSubmission(value: unknown): value is PendingSubmission {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingSubmission>;
  return pending.schemaVersion === 1 &&
    typeof pending.fingerprint === "string" &&
    typeof pending.acceptedAt === "string" &&
    Boolean(pending.payload && typeof pending.payload === "object");
}

async function saveStatus(bucket: R2BucketBinding, record: SubmissionStatusRecord, firstWriteOnly = false) {
  return bucket.put(statusObjectKey(record.submissionId), JSON.stringify(record), {
    ...(firstWriteOnly ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
    httpMetadata: { contentType: "application/json" },
  });
}

function statusMessage(state: SubmissionState) {
  if (state === "synced") return "Data sudah tersimpan dan menunggu verifikasi petugas.";
  if (state === "delayed") return "Data sudah diterima. Sinkronisasi sedang dilanjutkan otomatis.";
  return "Data diterima sistem dan sedang diproses.";
}

function publicStatus(record: SubmissionStatusRecord) {
  return {
    ok: true,
    submissionId: record.submissionId,
    status: record.state,
    message: statusMessage(record.state),
    updatedAt: record.updatedAt,
  };
}

async function loadStatus(bucket: R2BucketBinding, submissionId: string) {
  const record = await readJsonObject<unknown>(bucket, statusObjectKey(submissionId));
  if (record === null) return null;
  if (!isStatusRecord(record) || record.submissionId !== submissionId) {
    throw new Error("Invalid submission status");
  }
  return record;
}

async function handleSubmission(request: Request, env: Env) {
  if (request.method !== "POST") return jsonResponse({ ok: false, message: "Metode tidak diizinkan." }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ ok: false, message: "Format permintaan tidak didukung." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_REQUEST_BYTES) return jsonResponse({ ok: false, message: "Foto bukti pembayaran terlalu besar." }, 413);

  let payload: SubmissionPayload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ ok: false, message: "Foto bukti pembayaran terlalu besar." }, 413);
    }
    payload = JSON.parse(rawBody) as SubmissionPayload;
  } catch {
    return jsonResponse({ ok: false, message: "Data formulir tidak dapat dibaca." }, 400);
  }

  if (asTrimmedString(payload.website)) {
    return jsonResponse({ ok: true, submissionId: asTrimmedString(payload.submissionId), message: "Data diterima." });
  }

  const validated = validateSubmission(payload);
  if ("error" in validated) return jsonResponse({ ok: false, message: validated.error }, 400);

  const hasTurnstileSiteKey = Boolean(env.TURNSTILE_SITE_KEY);
  const hasTurnstileSecret = Boolean(env.TURNSTILE_SECRET);
  if (hasTurnstileSiteKey !== hasTurnstileSecret) {
    return jsonResponse({ ok: false, message: "Pemeriksaan keamanan belum dikonfigurasi dengan benar." }, 503);
  }

  if (env.TURNSTILE_SECRET) {
    try {
      const verified = await verifyTurnstile(
        env.TURNSTILE_SECRET,
        asTrimmedString(payload.turnstileToken),
        request.headers.get("CF-Connecting-IP") || "",
        new URL(request.url).hostname,
      );
      if (!verified) return jsonResponse({ ok: false, message: "Pemeriksaan keamanan gagal. Silakan muat ulang halaman." }, 400);
    } catch {
      return jsonResponse({ ok: false, message: "Pemeriksaan keamanan sedang bermasalah. Silakan coba lagi." }, 503);
    }
  }

  if (
    !env.APPS_SCRIPT_URL ||
    !isAllowedAppsScriptUrl(env.APPS_SCRIPT_URL) ||
    !env.APPS_SCRIPT_TOKEN ||
    !env.PENDING_SUBMISSIONS ||
    !env.SUBMISSION_QUEUE
  ) {
    return jsonResponse({ ok: false, message: "Layanan penyimpanan belum dikonfigurasi oleh pengelola." }, 503);
  }

  const bucket = env.PENDING_SUBMISSIONS;
  const submissionId = validated.value.submissionId;
  const fingerprint = await fingerprintSubmission(validated.value);
  const now = new Date().toISOString();

  try {
    const existingStatus = await loadStatus(bucket, submissionId);
    if (existingStatus && existingStatus.fingerprint !== fingerprint) {
      return jsonResponse({ ok: false, message: "ID pengajuan sudah digunakan untuk data yang berbeda. Muat ulang halaman lalu coba lagi." }, 409);
    }
    if (existingStatus?.state === "synced") {
      return jsonResponse(publicStatus(existingStatus));
    }

    const pending: PendingSubmission = {
      schemaVersion: 1,
      fingerprint,
      acceptedAt: existingStatus?.acceptedAt || now,
      payload: {
        ...validated.value,
        amount: 25000,
        privacyAccepted: true,
      },
    };

    const pendingKey = pendingObjectKey(submissionId);
    const createdPending = await bucket.put(pendingKey, JSON.stringify(pending), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });

    if (!createdPending) {
      const existingPending = await readJsonObject<unknown>(bucket, pendingKey);
      if (!isPendingSubmission(existingPending) || existingPending.fingerprint !== fingerprint) {
        return jsonResponse({ ok: false, message: "ID pengajuan sudah digunakan untuk data yang berbeda. Muat ulang halaman lalu coba lagi." }, 409);
      }
    }

    let currentStatus = existingStatus;
    if (!currentStatus) {
      const initialStatus: SubmissionStatusRecord = {
        schemaVersion: 1,
        submissionId,
        fingerprint,
        state: "processing",
        acceptedAt: pending.acceptedAt,
        updatedAt: now,
      };
      const createdStatus = await saveStatus(bucket, initialStatus, true);
      currentStatus = createdStatus ? initialStatus : await loadStatus(bucket, submissionId);
      if (!currentStatus || currentStatus.fingerprint !== fingerprint) {
        return jsonResponse({ ok: false, message: "ID pengajuan sudah digunakan untuk data yang berbeda. Muat ulang halaman lalu coba lagi." }, 409);
      }
    }

    await env.SUBMISSION_QUEUE.send({ schemaVersion: 1, submissionId });

    return jsonResponse(publicStatus(currentStatus), 202);
  } catch (error) {
    console.error("Submission acceptance failed", error instanceof Error ? error.name : "unknown");
    return jsonResponse({ ok: false, message: "Data belum dapat diamankan. Silakan tekan kirim kembali." }, 503);
  }
}

async function syncSubmission(job: SubmissionJob, env: Env) {
  if (job.schemaVersion !== 1 || !UUID_PATTERN.test(job.submissionId)) {
    throw new Error("Invalid queue job");
  }
  if (
    !env.PENDING_SUBMISSIONS ||
    !env.APPS_SCRIPT_URL ||
    !isAllowedAppsScriptUrl(env.APPS_SCRIPT_URL) ||
    !env.APPS_SCRIPT_TOKEN
  ) {
    throw new Error("Storage configuration unavailable");
  }

  const bucket = env.PENDING_SUBMISSIONS;
  const currentStatus = await loadStatus(bucket, job.submissionId);
  if (currentStatus?.state === "synced") {
    await bucket.delete(pendingObjectKey(job.submissionId));
    return;
  }

  const pending = await readJsonObject<unknown>(bucket, pendingObjectKey(job.submissionId));
  if (!isPendingSubmission(pending)) throw new Error("Pending submission unavailable");

  const validated = validateSubmission(pending.payload);
  if ("error" in validated || validated.value.submissionId !== job.submissionId) {
    throw new Error("Pending submission invalid");
  }
  const fingerprint = await fingerprintSubmission(validated.value);
  if (fingerprint !== pending.fingerprint || (currentStatus && currentStatus.fingerprint !== fingerprint)) {
    throw new Error("Pending submission fingerprint mismatch");
  }

  const upstream = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...validated.value,
      integrationToken: env.APPS_SCRIPT_TOKEN,
      amount: 25000,
      privacyAccepted: true,
    }),
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });

  const text = await upstream.text();
  let result: { ok?: boolean; submissionId?: string } | null = null;
  try {
    result = JSON.parse(text) as typeof result;
  } catch {
    result = null;
  }
  if (!upstream.ok || !result?.ok || result.submissionId !== job.submissionId) {
    throw new Error("Google storage rejected submission");
  }

  const syncedAt = new Date().toISOString();
  const syncedStatus: SubmissionStatusRecord = {
    schemaVersion: 1,
    submissionId: job.submissionId,
    fingerprint,
    state: "synced",
    acceptedAt: currentStatus?.acceptedAt || pending.acceptedAt,
    updatedAt: syncedAt,
  };

  await saveStatus(bucket, syncedStatus);
  await bucket.delete(pendingObjectKey(job.submissionId));
}

async function markSubmissionDelayed(job: SubmissionJob, attempts: number, env: Env) {
  if (!env.PENDING_SUBMISSIONS || !UUID_PATTERN.test(job.submissionId)) return;
  const currentStatus = await loadStatus(env.PENDING_SUBMISSIONS, job.submissionId);
  if (!currentStatus || currentStatus.state === "synced") return;
  await saveStatus(env.PENDING_SUBMISSIONS, {
    ...currentStatus,
    state: "delayed",
    attempts,
    updatedAt: new Date().toISOString(),
  });
}

async function handleStatus(request: Request, env: Env, submissionId: string) {
  if (request.method !== "GET") return jsonResponse({ ok: false, message: "Metode tidak diizinkan." }, 405);
  if (!UUID_PATTERN.test(submissionId)) return jsonResponse({ ok: false, message: "ID pengajuan tidak valid." }, 400);
  if (!env.PENDING_SUBMISSIONS) {
    return jsonResponse({ ok: false, message: "Layanan status belum dikonfigurasi oleh pengelola." }, 503);
  }

  try {
    const record = await loadStatus(env.PENDING_SUBMISSIONS, submissionId);
    if (!record) return jsonResponse({ ok: false, message: "Status pengajuan tidak ditemukan." }, 404);
    return jsonResponse(publicStatus(record));
  } catch {
    return jsonResponse({ ok: false, message: "Status pengajuan belum dapat diperiksa." }, 503);
  }
}

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; upgrade-insecure-requests",
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      if (request.method !== "GET") return jsonResponse({ ok: false, message: "Metode tidak diizinkan." }, 405);
      return jsonResponse({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "" });
    }

    if (url.pathname === "/api/submit") return handleSubmission(request, env);

    if (url.pathname.startsWith("/api/status/")) {
      const submissionId = decodeURIComponent(url.pathname.slice("/api/status/".length));
      return handleStatus(request, env, submissionId);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    const response = await handler.fetch(request, env, ctx);
    return withSecurityHeaders(response);
  },

  async queue(batch: QueueBatch<SubmissionJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await syncSubmission(message.body, env);
        message.ack();
      } catch (error) {
        try {
          await markSubmissionDelayed(message.body, message.attempts, env);
        } catch {
          // Status tambahan tidak boleh menghalangi retry penyimpanan utama.
        }
        console.error("Submission sync failed", {
          submissionId: UUID_PATTERN.test(message.body?.submissionId || "") ? message.body.submissionId : "invalid",
          attempts: message.attempts,
          reason: error instanceof Error ? error.name : "unknown",
        });
        message.retry({
          delaySeconds: Math.min(30 * (2 ** Math.max(0, message.attempts - 1)), 900),
        });
      }
    }
  },
};

export default worker;
