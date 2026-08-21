import { DeliveryForm } from "./components/DeliveryForm";

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand-lockup" href="#top" aria-label="Kembali ke atas">
          <span className="agency-logos" aria-hidden="true">
            <img className="logo-imigrasi" src="/assets/logo-imigrasi.png" alt="" />
            <span />
            <img className="logo-posind" src="/assets/logo-posind.png" alt="" />
          </span>
          <span className="brand-title">
            <strong>Pengiriman Paspor</strong>
            <small>Batam · 29400</small>
          </span>
        </a>
        <a className="help-link" href="#bantuan">Butuh bantuan?</a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="service-label">
            <span className="service-dot" aria-hidden="true" />
            Layanan pengiriman ke alamat rumah
          </div>
          <h1>Paspor selesai.<br />Biar kami yang antar.</h1>
          <p className="hero-lead">
            Untuk pemohon Imigrasi Batam: isi data penerima, bayar ongkir, lalu unggah buktinya. Prosesnya hanya beberapa menit.
          </p>

          <div className="service-partners" aria-label="Mitra penyelenggara layanan">
            <div className="partner">
              <img src="/assets/logo-imigrasi.png" alt="Logo Direktorat Jenderal Imigrasi" />
              <span><small>Layanan pemohon</small><strong>Imigrasi Batam</strong></span>
            </div>
            <div className="partner-divider" aria-hidden="true" />
            <div className="partner partner-pos">
              <img src="/assets/logo-posind.png" alt="Logo PosIND Logistik Indonesia" />
              <span><small>Pengiriman oleh</small><strong>Pos Indonesia KCU Batam 29400</strong></span>
            </div>
          </div>

          <ol className="steps" aria-label="Tahapan pengajuan">
            <li><span>1</span><div><strong>Isi data</strong><small>Data penerima paket</small></div></li>
            <li><span>2</span><div><strong>Bayar ongkir</strong><small>QRIS Rp25.000</small></div></li>
            <li><span>3</span><div><strong>Kirim formulir</strong><small>Tunggu verifikasi petugas</small></div></li>
          </ol>

          <aside className="scope-note">
            <span aria-hidden="true">i</span>
            <p>Formulir ini khusus untuk pengiriman paspor yang sudah selesai, bukan untuk permohonan atau penerbitan paspor.</p>
          </aside>
        </div>

        <section className="form-shell" aria-label="Formulir pengiriman paspor">
          <DeliveryForm />
        </section>
      </section>

      <section className="support-section" id="bantuan">
        <div>
          <span className="eyebrow">Bantuan layanan</span>
          <h2>Ada kendala saat mengisi?</h2>
        </div>
        <p>Jangan mengirim PIN, OTP, foto paspor, NIK, atau nomor rekening penuh. Untuk bantuan, hubungi petugas Pos Indonesia di lokasi layanan Imigrasi Batam.</p>
      </section>

      <footer>
        <div>
          <strong>Pengiriman Paspor Batam</strong>
          <p>Dikelola untuk layanan pengiriman paspor oleh Pos Indonesia KCU Batam 29400.</p>
        </div>
        <p>© 2026 · Pemberitahuan privasi tersedia pada formulir.</p>
      </footer>
    </main>
  );
}
