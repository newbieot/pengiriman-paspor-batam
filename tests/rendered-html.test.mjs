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
  assert.doesNotMatch(workerSource, /console\.log\([^)]*(address|whatsapp|base64)/i);
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
  assert.match(proofHandler, /setProofPreview\(`data:\$\{optimized\.mimeType\};base64,/);
  assert.match(proofHandler, /await compressProof\(file\)/);
  assert.doesNotMatch(submitHandler, /compressProof\(/);
  assert.match(submitHandler, /proof:\s*processedProof/);
  assert.match(source, /disabled=\{submitting \|\| proofProcessing\}/);
  assert.match(source, /Mengoptimalkan gambar/);
});
