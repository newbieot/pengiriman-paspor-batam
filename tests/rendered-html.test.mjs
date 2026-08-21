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
