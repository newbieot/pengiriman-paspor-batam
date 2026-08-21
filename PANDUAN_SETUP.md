# Panduan Setup Website Pengiriman Paspor Batam

Panduan ini memakai satu **Cloudflare Worker full-stack**: halaman dan API upload berada di domain yang sama. Data lebih dulu diamankan di R2 privat dan Cloudflare Queue agar pengunjung tidak perlu menunggu Google Apps Script. Google Apps Script kemudian menjadi jembatan privat ke Google Sheets dan Google Drive.

## Gambaran alur

```text
Pengunjung
  → website Cloudflare Worker
  → validasi + Turnstile + nominal tetap Rp25.000
  → R2 privat + Queue (halaman langsung menampilkan data diterima)
  → Google Apps Script di belakang (dengan token rahasia)
  → gambar tersimpan privat di Google Drive
  → data + link gambar masuk ke Google Sheets
```

## A. Checklist wajib sebelum situs dibuka ke publik

1. Dapatkan persetujuan tertulis dari Imigrasi Batam dan pejabat berwenang Pos Indonesia untuk nama layanan, domain, penggunaan logo, isi formulir, serta alur pembayaran.
2. QRIS terlampir menampilkan merchant **RIKY JULIADI**, bukan PT Pos Indonesia. Pastikan hubungan, kewenangan, dan rekening penampungnya disetujui tertulis. Jangan terbitkan sebelum ini jelas.
3. Tetapkan siapa pengendali data, petugas yang boleh mengakses, kontak pengaduan/hak data, dan jadwal penghapusan.
4. Tinjau teks retensi 90 hari bersama bagian hukum/DPO dan keuangan. Ubah bila jadwal retensi resmi berbeda.
5. Gunakan akun Google Workspace institusi atau akun khusus layanan, bukan akun pribadi pegawai yang mudah hilang saat mutasi.

Situs dimulai dengan `PUBLIC_INDEXING=false`, jadi mesin pencari diminta tidak mengindeksnya selama tahap persiapan.

## B. Siapkan Google Sheets dan Google Drive

### 1. Buat spreadsheet

1. Buka Google Sheets dan buat spreadsheet bernama `Pengiriman Paspor Batam`.
2. Tidak perlu membuat judul kolom; script akan membuatnya otomatis.
3. Salin **Spreadsheet ID** dari URL. Contoh:

   ```text
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   ```

### 2. Buat folder bukti pembayaran

1. Di Google Drive, buat folder `Bukti Pembayaran Pengiriman Paspor`.
2. Bagikan folder hanya kepada akun petugas yang berwenang. Jangan pilih “Anyone with the link”.
3. Salin **Folder ID** dari URL:

   ```text
   https://drive.google.com/drive/folders/DRIVE_FOLDER_ID
   ```

Link yang dicatat di Sheets hanya dapat dibuka oleh akun yang mempunyai izin Drive.

## C. Pasang Google Apps Script

1. Buka [Google Apps Script](https://script.google.com/) dan pilih **New project**.
2. Beri nama `Backend Pengiriman Paspor Batam`.
3. Hapus isi `Code.gs`, lalu salin seluruh isi file `google-apps-script/Code.gs` dari proyek ini.
4. Simpan.

### 1. Buat token integrasi

Gunakan password manager untuk membuat token acak minimal 32 karakter. Di Windows PowerShell, token aman juga dapat dibuat dengan:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Simpan token ini. Nilai yang sama akan dimasukkan ke Apps Script dan Cloudflare, tetapi tidak boleh dimasukkan ke GitHub.

### 2. Isi Script Properties

Di Apps Script pilih **Project Settings → Script Properties → Add script property**, lalu isi:

| Property | Nilai |
|---|---|
| `INTEGRATION_TOKEN` | token acak yang baru dibuat |
| `SPREADSHEET_ID` | ID spreadsheet |
| `SHEET_NAME` | `Pengajuan` |
| `DRIVE_FOLDER_ID` | ID folder Drive |

### 3. Deploy sebagai Web App

1. Pilih **Deploy → New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Who has access: **Anyone**.
5. Klik **Deploy**, selesaikan izin akses Sheets dan Drive, lalu salin URL yang berakhir `/exec`.

Endpoint boleh dipanggil tanpa login Google karena hanya Cloudflare yang memanggilnya. Token integrasi tetap diperiksa di dalam script. Jangan membagikan URL Apps Script dan token kepada pengunjung.

Jika opsi “Anyone” tidak tersedia pada Google Workspace, minta administrator organisasi mengizinkan web app atau gunakan integrasi Google API yang dikelola administrator.

## D. Unggah proyek ke GitHub

Disarankan membuat repository **Private** sampai seluruh izin pra-rilis selesai.

1. Di GitHub pilih **New repository**.
2. Nama: `pengiriman-paspor-batam`.
3. Jangan menambahkan README atau `.gitignore` dari GitHub karena proyek sudah memilikinya.
4. Di folder proyek jalankan:

```bash
git init -b main
git add .
git commit -m "Website pengiriman paspor Batam"
git remote add origin https://github.com/USERNAME/pengiriman-paspor-batam.git
git push -u origin main
```

Ganti `USERNAME` dengan username GitHub Anda. Alternatif tanpa terminal: tambahkan folder sebagai repository di GitHub Desktop, lalu pilih **Publish repository**.

Pastikan `.dev.vars`, file token, atau screenshot data pelanggan tidak pernah masuk commit.

## E. Hubungkan GitHub ke Cloudflare Workers

Repo ini memakai Cloudflare Workers Builds, bukan Pages statis, karena formulir memerlukan API server yang aman.

1. Masuk ke Cloudflare Dashboard → **Workers & Pages**.
2. Pilih **Create application → Import a repository**.
3. Hubungkan GitHub dan pilih repository `pengiriman-paspor-batam`.
4. Gunakan nama Worker **`pengiriman-paspor-batam`**.
5. Atur build:

| Pengaturan | Nilai |
|---|---|
| Production branch | `main` |
| Root directory | `/` atau kosong |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy --config dist/server/wrangler.json` |
| Non-production deploy | `npx wrangler versions upload --config dist/server/wrangler.json` |

6. Simpan dan biarkan build pertama selesai. URL akan berbentuk `https://pengiriman-paspor-batam.<subdomain-anda>.workers.dev`.

Jangan sebarkan URL dulu. Pengiriman data akan tetap gagal aman sampai konfigurasi runtime diisi.

### Buat penyimpanan sementara dan antrean

Sebelum deployment kode pengiriman cepat, buat tiga resource berikut di akun Cloudflare yang sama:

| Jenis | Nama |
|---|---|
| R2 bucket privat | `pengiriman-paspor-batam-pending` |
| Queue utama | `pengiriman-paspor-batam-submissions` |
| Dead-letter Queue | `pengiriman-paspor-batam-submissions-dlq` |

Cara paling ringkas dari folder proyek:

```bash
npx wrangler login
npx wrangler r2 bucket create pengiriman-paspor-batam-pending
npx wrangler r2 bucket lifecycle add pengiriman-paspor-batam-pending --id expire-temp-after-one-day --expire-days 1
npx wrangler queues create pengiriman-paspor-batam-submissions
npx wrangler queues create pengiriman-paspor-batam-submissions-dlq
npx wrangler queues update pengiriman-paspor-batam-submissions --message-retention-period-secs 86400
npx wrangler queues update pengiriman-paspor-batam-submissions-dlq --message-retention-period-secs 86400
```

Jangan aktifkan `r2.dev` atau custom domain untuk bucket ini. Bukti pembayaran hanya berada di R2 selama menunggu sinkronisasi, lalu dihapus segera setelah Google Drive dan Sheets menyatakan berhasil. Lifecycle satu hari menjadi pengaman untuk data sementara yang gagal atau tertinggal.

## F. Tambahkan konfigurasi runtime Cloudflare

Buka Worker → **Settings → Variables and Secrets**. Ini adalah konfigurasi runtime, bukan “Build variables”. Tambahkan:

| Nama | Tipe | Nilai |
|---|---|---|
| `APPS_SCRIPT_URL` | Secret | URL Apps Script `/exec` |
| `APPS_SCRIPT_TOKEN` | Secret | token yang sama dengan `INTEGRATION_TOKEN` |
| `SITE_URL` | Text | URL lengkap Worker, tanpa garis miring akhir |
| `PUBLIC_INDEXING` | Text | `false` |

Klik **Deploy** untuk menerapkan perubahan.

## G. Aktifkan Cloudflare Turnstile

Turnstile mencegah bot mengirim file berulang kali. Validasi server sudah tersedia di Worker.

1. Di Cloudflare pilih **Turnstile → Add widget**.
2. Nama: `Form Pengiriman Paspor Batam`.
3. Widget mode: **Managed**.
4. Tambahkan hostname Worker, misalnya `pengiriman-paspor-batam.<subdomain-anda>.workers.dev`.
5. Salin Site Key dan Secret Key.
6. Di Worker → **Settings → Variables and Secrets**, tambahkan:

| Nama | Tipe | Nilai |
|---|---|---|
| `TURNSTILE_SITE_KEY` | Text | Site Key |
| `TURNSTILE_SECRET` | Secret | Secret Key |

7. Klik **Deploy** dan muat ulang website. Widget keamanan akan muncul sebelum tombol kirim.

Jangan menjalankan situs publik tanpa `TURNSTILE_SECRET`. Secret tidak boleh berada di kode frontend atau GitHub.

## H. Uji dari awal sampai akhir

Gunakan data uji, bukan data paspor asli.

1. Buka website dari ponsel.
2. Isi nama, alamat uji, dan WhatsApp uji.
3. Unggah gambar bukti uji hingga 10 MB dan pastikan hasil optimasinya di bawah 70 KB.
4. Centang pemberitahuan privasi dan selesaikan Turnstile.
5. Klik **Kirim data pengiriman**.
6. Pastikan halaman segera menampilkan ID pengajuan dan status `Diterima · Sedang menyinkronkan data`.
7. Tunggu status berubah menjadi `Tersimpan · Menunggu verifikasi petugas`.
8. Buka Google Sheets dan pastikan muncul satu baris dengan status `MENUNGGU VERIFIKASI`.
9. Klik URL bukti dari akun petugas berizin. Pastikan akun lain tidak dapat membukanya.
10. Kirim ulang dengan ID yang sama saat menguji retry; script tidak boleh membuat baris/file ganda.
11. Uji file salah, ukuran lebih dari 10 MB, nomor WhatsApp salah, dan Turnstile belum selesai; semuanya harus ditolak.

Upload bukti tidak berarti pembayaran otomatis sah. Petugas tetap harus memeriksa transaksi sebelum mengubah status dan memproses pengiriman.

## I. Domain sendiri (opsional)

1. Di Worker pilih **Settings → Domains & Routes → Add → Custom domain**.
2. Pilih domain yang dikelola Cloudflare.
3. Setelah aktif, ubah `SITE_URL` ke domain baru.
4. Tambahkan domain baru ke daftar hostname Turnstile.
5. Deploy ulang.

Sesudah semua izin tertulis, pemeriksaan keamanan, kebijakan privasi, dan QRIS dinyatakan siap, ubah `PUBLIC_INDEXING` menjadi `true` lalu deploy. Jangan mengaktifkan indexing sebelum persetujuan.

## J. Pemeliharaan

- Jika `Code.gs` berubah: Apps Script → **Deploy → Manage deployments → Edit → New version → Deploy**. URL `/exec` tetap sama.
- Rotasi `INTEGRATION_TOKEN` secara berkala: ganti di Script Properties dan Cloudflare dalam waktu yang sama.
- Jangan mengubah folder Drive menjadi publik. Audit daftar petugas yang punya akses.
- Hapus/anonymkan data operasional dan gambar bukti setelah masa retensi yang disahkan.
- Jangan mencatat alamat, WhatsApp, atau base64 gambar ke log Cloudflare.
- Pantau Queue utama dan dead-letter Queue; pesan Queue hanya berisi ID acak, bukan data pelanggan.
- Ubah status Sheets hanya setelah verifikasi pembayaran.

## Pemecahan masalah

| Pesan/masalah | Penyebab paling umum | Perbaikan |
|---|---|---|
| “Layanan penyimpanan belum dikonfigurasi” | URL/token belum ada di Worker | Periksa `APPS_SCRIPT_URL` dan `APPS_SCRIPT_TOKEN`, lalu Deploy |
| “Pemeriksaan keamanan gagal” | Site Key/Secret tidak sepasang atau hostname belum didaftarkan | Periksa widget Turnstile dan hostname |
| Data tidak masuk ke Sheets | Apps Script belum dideploy sebagai `/exec`, properti salah, atau izin Google belum selesai | Periksa deployment dan Script Properties |
| Status lama di “sedang menyinkronkan” | Apps Script lambat atau Queue sedang retry | Periksa metrik Queue dan dead-letter Queue; jangan menghapus objek R2 secara manual sebelum rekonsiliasi |
| Deploy gagal karena binding R2/Queue | Resource belum dibuat atau namanya berbeda | Buat ketiga resource dengan nama persis seperti tabel di atas |
| Link gambar meminta akses | Ini perilaku yang benar | Masuk dengan akun petugas yang sudah diberi akses folder |
| Build Cloudflare gagal menemukan config | Perintah deploy tidak menunjuk hasil build | Gunakan `--config dist/server/wrangler.json` |
| Build gagal karena nama Worker | Nama Worker tidak sesuai config hasil build | Gunakan nama `pengiriman-paspor-batam` |

## Dokumentasi resmi

- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Cloudflare variables and secrets](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Google Apps Script Web Apps](https://developers.google.com/apps-script/guides/web)
- [Google Apps Script Properties](https://developers.google.com/apps-script/guides/properties)
- [Google Drive Apps Script service](https://developers.google.com/apps-script/reference/drive)
- [Google Sheets Apps Script service](https://developers.google.com/apps-script/reference/spreadsheet/sheet)
- [UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi](https://jdih.komdigi.go.id/produk_hukum/view/id/832/t/undangundang%2Bnomor%2B27%2Btahun%2B2022)
