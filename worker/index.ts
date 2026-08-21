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
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
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

const MAX_REQUEST_BYTES = 3_250_000;
const MAX_PROOF_BYTES = 2 * 1024 * 1024;
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

function validateSubmission(payload: SubmissionPayload) {
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
  if (!Number.isInteger(claimedSize) || claimedSize < 100 || claimedSize > MAX_PROOF_BYTES) {
    return { error: "Ukuran bukti pembayaran tidak valid." };
  }
  if (actualSize < 100 || actualSize > MAX_PROOF_BYTES || Math.abs(actualSize - claimedSize) > 2) {
    return { error: "Data bukti pembayaran tidak valid." };
  }
  if (!matchesMagicBytes(mimeType, base64)) return { error: "Isi file bukti pembayaran tidak valid." };

  return {
    value: { submissionId, fullName, address, whatsapp, noticeVersion, proof: { mimeType, size: actualSize, base64 } },
  };
}

async function verifyTurnstile(secret: string, token: string, remoteIp: string) {
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
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

function isAllowedAppsScriptUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "script.google.com" && url.pathname.startsWith("/macros/s/") && url.pathname.endsWith("/exec");
  } catch {
    return false;
  }
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
    payload = (await request.json()) as SubmissionPayload;
  } catch {
    return jsonResponse({ ok: false, message: "Data formulir tidak dapat dibaca." }, 400);
  }

  if (asTrimmedString(payload.website)) {
    return jsonResponse({ ok: true, submissionId: asTrimmedString(payload.submissionId), message: "Data diterima." });
  }

  const validated = validateSubmission(payload);
  if ("error" in validated) return jsonResponse({ ok: false, message: validated.error }, 400);

  if (env.TURNSTILE_SECRET) {
    try {
      const verified = await verifyTurnstile(
        env.TURNSTILE_SECRET,
        asTrimmedString(payload.turnstileToken),
        request.headers.get("CF-Connecting-IP") || "",
      );
      if (!verified) return jsonResponse({ ok: false, message: "Pemeriksaan keamanan gagal. Silakan muat ulang halaman." }, 400);
    } catch {
      return jsonResponse({ ok: false, message: "Pemeriksaan keamanan sedang bermasalah. Silakan coba lagi." }, 503);
    }
  }

  if (!env.APPS_SCRIPT_URL || !isAllowedAppsScriptUrl(env.APPS_SCRIPT_URL) || !env.APPS_SCRIPT_TOKEN) {
    return jsonResponse({ ok: false, message: "Layanan penyimpanan belum dikonfigurasi oleh pengelola." }, 503);
  }

  try {
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
    let result: { ok?: boolean; message?: string; submissionId?: string } | null = null;
    try {
      result = JSON.parse(text) as typeof result;
    } catch {
      result = null;
    }

    if (!upstream.ok || !result?.ok) {
      return jsonResponse({ ok: false, message: result?.message || "Penyimpanan data sedang bermasalah. Silakan coba lagi." }, 502);
    }

    return jsonResponse({
      ok: true,
      submissionId: result.submissionId || validated.value.submissionId,
      message: "Data berhasil diterima dan menunggu verifikasi.",
    });
  } catch (error) {
    console.error("Submission upstream request failed", error instanceof Error ? error.name : "unknown");
    return jsonResponse({ ok: false, message: "Koneksi ke penyimpanan sedang bermasalah. Silakan coba lagi." }, 504);
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
};

export default worker;
