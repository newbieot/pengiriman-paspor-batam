import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

function createBucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async put(key, value, options = {}) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      objects.set(key, String(value));
      return {};
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function createQueue() {
  const messages = [];
  return {
    messages,
    async send(message) {
      messages.push(structuredClone(message));
    },
  };
}

function validSubmission(submissionId = "11111111-1111-4111-8111-111111111111") {
  const bytes = Buffer.alloc(180, 0);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return {
    submissionId,
    fullName: "Andi Pratama",
    address: "Jalan Ahmad Yani Nomor 10, Batam Kota 29400",
    whatsapp: "6281234567890",
    noticeVersion: "2026-08-21.v1",
    proof: {
      mimeType: "image/jpeg",
      size: bytes.length,
      base64: bytes.toString("base64"),
    },
    website: "",
  };
}

function storageEnv(bucket = createBucket(), queue = createQueue()) {
  return {
    ...env,
    PENDING_SUBMISSIONS: bucket,
    SUBMISSION_QUEUE: queue,
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/test-deployment/exec",
    APPS_SCRIPT_TOKEN: "test-integration-token-not-a-secret",
  };
}

async function submit(worker, runtimeEnv, payload) {
  return worker.fetch(
    new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    runtimeEnv,
    context,
  );
}

test("server-renders the passport delivery form", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");

  const html = await response.text();
  assert.match(html, /<html lang="id">/i);
  assert.match(html, /Pengiriman Paspor ke Rumah/);
  assert.match(html, /Paspor selesai/);
  assert.match(html, /Nama lengkap penerima/);
  assert.match(html, /Rp25\.000/);
  assert.match(html, /logo-imigrasi\.png/);
  assert.match(html, /logo-posind\.png/);
  assert.match(html, /Tidak ada petugas Pos(?: Indonesia)? di lokasi Imigrasi Batam/);
  assert.match(html, /Riky Juliadi/);
  assert.match(html, /0813-7221-2002/);
  assert.match(html, /https:\/\/wa\.me\/6281372212002/);
  assert.match(html, /tel:\+6281372212002/);
  assert.ok(
    html.indexOf('aria-label="Formulir pengiriman paspor"') < html.indexOf('class="hero-copy"'),
    "the form should appear before service details in the mobile document order",
  );
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/i);
});

test("exposes only public form configuration", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("http://localhost/api/config"), env, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { turnstileSiteKey: "" });
});

test("rejects malformed submissions before storage", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
    context,
  );
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.ok, false);
});

test("durably accepts a valid submission before Google synchronization", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const queue = createQueue();
  const runtimeEnv = storageEnv(bucket, queue);
  const payload = validSubmission();

  const response = await submit(worker, runtimeEnv, payload);
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.ok, true);
  assert.equal(accepted.submissionId, payload.submissionId);
  assert.equal(accepted.status, "processing");
  assert.equal(accepted.message, "Data diterima sistem dan sedang diproses.");
  assert.match(accepted.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(queue.messages.length, 1);
  assert.deepEqual(queue.messages[0], { schemaVersion: 1, submissionId: payload.submissionId });
  assert.doesNotMatch(JSON.stringify(queue.messages[0]), /Andi|Ahmad Yani|628123|base64|integration/i);
  assert.ok(bucket.objects.has(`pending/${payload.submissionId}.json`));

  const statusResponse = await worker.fetch(
    new Request(`http://localhost/api/status/${payload.submissionId}`),
    runtimeEnv,
    context,
  );
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.status, "processing");
  assert.equal(status.submissionId, payload.submissionId);
  assert.equal("fingerprint" in status, false);
});

test("keeps retries idempotent and rejects reused IDs with different data", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const queue = createQueue();
  const runtimeEnv = storageEnv(bucket, queue);
  const payload = validSubmission("22222222-2222-4222-8222-222222222222");

  assert.equal((await submit(worker, runtimeEnv, payload)).status, 202);
  assert.equal((await submit(worker, runtimeEnv, payload)).status, 202);
  assert.equal(bucket.objects.has(`pending/${payload.submissionId}.json`), true);
  assert.equal(queue.messages.length, 2);

  const conflict = await submit(worker, runtimeEnv, { ...payload, fullName: "Budi Pratama" });
  assert.equal(conflict.status, 409);
});

test("does not claim acceptance when Queue fails and safely accepts the same retry", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const messages = [];
  let sends = 0;
  const queue = {
    messages,
    async send(message) {
      sends += 1;
      if (sends === 1) throw new Error("queue unavailable");
      messages.push(structuredClone(message));
    },
  };
  const runtimeEnv = storageEnv(bucket, queue);
  const payload = validSubmission("55555555-5555-4555-8555-555555555555");
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await submit(worker, runtimeEnv, payload)).status, 503);
    assert.equal((await submit(worker, runtimeEnv, payload)).status, 202);
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.length, 1);
  assert.equal(bucket.objects.has(`pending/${payload.submissionId}.json`), true);
});

test("queue consumer stores to Google, writes a receipt, then deletes temporary PII", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const queue = createQueue();
  const runtimeEnv = storageEnv(bucket, queue);
  const payload = validSubmission("33333333-3333-4333-8333-333333333333");
  assert.equal((await submit(worker, runtimeEnv, payload)).status, 202);

  let acknowledged = false;
  let retried = false;
  const message = {
    body: queue.messages[0],
    attempts: 1,
    ack() { acknowledged = true; },
    retry() { retried = true; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const upstreamPayload = JSON.parse(String(init?.body || "{}"));
    assert.equal(upstreamPayload.submissionId, payload.submissionId);
    assert.equal(upstreamPayload.integrationToken, runtimeEnv.APPS_SCRIPT_TOKEN);
    return Response.json({ ok: true, submissionId: payload.submissionId });
  };
  try {
    await worker.queue({ messages: [message] }, runtimeEnv);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(acknowledged, true);
  assert.equal(retried, false);
  assert.equal(bucket.objects.has(`pending/${payload.submissionId}.json`), false);
  const receipt = JSON.parse(bucket.objects.get(`status/${payload.submissionId}.json`));
  assert.equal(receipt.state, "synced");
});

test("queue consumer retains temporary data and retries when Google is unavailable", async () => {
  const worker = await loadWorker();
  const bucket = createBucket();
  const queue = createQueue();
  const runtimeEnv = storageEnv(bucket, queue);
  const payload = validSubmission("44444444-4444-4444-8444-444444444444");
  assert.equal((await submit(worker, runtimeEnv, payload)).status, 202);

  let acknowledged = false;
  let retryDelay = 0;
  const message = {
    body: queue.messages[0],
    attempts: 1,
    ack() { acknowledged = true; },
    retry(options) { retryDelay = options?.delaySeconds || 0; },
  };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => { throw new TypeError("network unavailable"); };
  console.error = () => undefined;
  try {
    await worker.queue({ messages: [message] }, runtimeEnv);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  assert.equal(acknowledged, false);
  assert.equal(retryDelay, 30);
  assert.equal(bucket.objects.has(`pending/${payload.submissionId}.json`), true);
  const status = JSON.parse(bucket.objects.get(`status/${payload.submissionId}.json`));
  assert.equal(status.state, "delayed");
});

test("keeps required brand and payment assets in the project", async () => {
  const assets = [
    "../public/assets/logo-imigrasi.png",
    "../public/assets/logo-posind.png",
    "../public/assets/qris-pengiriman-paspor.png",
    "../public/og.png",
  ];
  for (const asset of assets) {
    const info = await stat(new URL(asset, import.meta.url));
    assert.ok(info.size > 1000, `${asset} should not be empty`);
  }
});

test("removes starter-only files and keeps private Drive links", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));

  const [packageJson, appsScript, workerSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(appsScript, /MENUNGGU VERIFIKASI/);
  assert.match(appsScript, /createdFile\.getUrl\(\)/);
  assert.doesNotMatch(appsScript, /ANYONE_WITH_LINK/);
  assert.match(workerSource, /amount:\s*25000/);
  assert.match(workerSource, /TURNSTILE_SECRET/);
  assert.match(workerSource, /PENDING_SUBMISSIONS/);
  assert.match(workerSource, /SUBMISSION_QUEUE/);
  assert.match(workerSource, /MAX_PROOF_BYTES\s*=\s*200\s*\*\s*1024/);
  assert.match(workerSource, /Data diterima sistem dan sedang diproses/);
  assert.doesNotMatch(workerSource, /console\.log\([^)]*(address|whatsapp|base64)/i);
});

test("build output contains the private R2 and Queue bindings", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.r2_buckets, [
    { binding: "PENDING_SUBMISSIONS", bucket_name: "pengiriman-paspor-batam-pending" },
  ]);
  assert.deepEqual(config.queues.producers, [
    { binding: "SUBMISSION_QUEUE", queue: "pengiriman-paspor-batam-submissions" },
  ]);
  assert.equal(config.queues.consumers[0].queue, "pengiriman-paspor-batam-submissions");
  assert.equal(config.queues.consumers[0].max_batch_size, 1);
  assert.equal(config.queues.consumers[0].dead_letter_queue, "pengiriman-paspor-batam-submissions-dlq");
  assert.equal(config.keep_vars, true);
});

test("project metadata is no longer the generic starter", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /DeliveryForm/);
  assert.match(layout, /Pengiriman Paspor ke Rumah/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  await access(new URL(".openai/hosting.json", projectRoot));
});

test("prepares a small payment proof before the user submits", async () => {
  const source = await readFile(new URL("../app/components/DeliveryForm.tsx", import.meta.url), "utf8");
  const proofHandler = source.slice(source.indexOf("async function handleProof"), source.indexOf("function removeProof"));
  const submitHandler = source.slice(source.indexOf("async function handleSubmit"), source.indexOf("if (successId)"));

  assert.match(source, /TARGET_PROOF_BYTES\s*=\s*190\s*\*\s*1024/);
  assert.match(source, /MAX_CLIENT_PROOF_BYTES\s*=\s*200\s*\*\s*1024/);
  assert.match(source, /COMPRESSION_ATTEMPTS/);
  assert.match(source, /maxDimension:\s*1600/);
  assert.match(source, /maxDimension:\s*1200/);
  assert.match(source, /canvasToPreferredBlob/);
  assert.match(source, /image\/webp/);
  assert.match(source, /jpeg\.type\s*!==\s*"image\/jpeg"/);
  assert.match(source, /output\.blob\.size\s*>=\s*MAX_CLIENT_PROOF_BYTES/);
  assert.doesNotMatch(source, /file\.size\s*<=\s*TARGET_PROOF_BYTES\)\s*return\s+toProcessedProof\(file/);
  assert.match(proofHandler, /setProofPreview\(`data:\$\{optimized\.mimeType\};base64,/);
  assert.match(proofHandler, /await compressProof\(file\)/);
  assert.doesNotMatch(submitHandler, /compressProof\(/);
  assert.match(submitHandler, /proof:\s*processedProof/);
  assert.match(source, /disabled=\{submitting \|\| proofProcessing\}/);
  assert.match(source, /Mengoptimalkan gambar/);
});
