# Pengiriman Paspor Batam

Website formulir pengiriman paspor yang sudah selesai ke alamat rumah bagi pemohon Imigrasi Batam. Pengiriman dikelola melalui Pos Indonesia KCU Batam 29400.

Fitur utama:

- formulir nama, alamat, WhatsApp, dan bukti pembayaran;
- QRIS ongkir + sampul Rp25.000;
- kompresi gambar sebelum unggah;
- validasi berlapis dan Cloudflare Turnstile;
- penerimaan cepat melalui R2 privat dan Cloudflare Queue;
- status sinkronisasi tanpa menampilkan data pribadi;
- Google Apps Script menyimpan gambar ke Drive dan baris + link privat ke Sheets;
- pencegahan kiriman ganda dengan ID pengajuan;
- tampilan responsif, aksesibel, dan nyaman untuk ponsel.

## Menjalankan di komputer

Persyaratan: Node.js 22.13 atau lebih baru.

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`. Tanpa `.dev.vars`, tampilan dapat diuji tetapi pengiriman data akan berhenti aman dengan pesan bahwa penyimpanan belum dikonfigurasi. R2 dan Queue lokal disediakan otomatis oleh lingkungan pengembangan.

Untuk menguji konfigurasi lokal, salin `.dev.vars.example` menjadi `.dev.vars`, lalu isi nilainya. Jangan commit `.dev.vars`.

## Pemeriksaan

```bash
npm test
```

## Publikasi

Ikuti [PANDUAN_SETUP.md](./PANDUAN_SETUP.md) untuk menyiapkan Google Sheets, Drive, Apps Script, GitHub, Cloudflare Workers Builds, Turnstile, dan uji akhir.

## Struktur penting

- `app/` — halaman dan pengalaman formulir;
- `worker/index.ts` — API aman di Cloudflare Worker;
- `vite.config.ts` — binding R2 privat dan Queue sinkronisasi;
- `google-apps-script/Code.gs` — penyimpanan Google Sheets + Drive;
- `public/assets/` — logo resmi dan QRIS;
- `.dev.vars.example` — daftar konfigurasi tanpa rahasia.

## Status pra-rilis

Situs sengaja menggunakan `PUBLIC_INDEXING=false` sampai izin logo, pemilik/pengelola data, kontak pengaduan, kebijakan retensi, dan QRIS atas nama **RIKY JULIADI** sudah dikonfirmasi secara tertulis. Jangan membuka situs untuk publik sebelum checklist pra-rilis pada panduan selesai.
