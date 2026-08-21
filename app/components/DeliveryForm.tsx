"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";

type FormValues = {
  fullName: string;
  address: string;
  phone: string;
  privacyAccepted: boolean;
  website: string;
};

type ErrorKey = "fullName" | "address" | "phone" | "proof" | "privacy" | "captcha" | "general";
type FormErrors = Partial<Record<ErrorKey, string>>;
type ProofMimeType = "image/jpeg" | "image/png" | "image/webp";
type ProcessedProof = {
  mimeType: ProofMimeType;
  size: number;
  base64: string;
};
type SubmissionState = "processing" | "synced" | "delayed";

type TurnstileApi = {
  render: (
    target: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme: "light";
      size: "flexible";
      action: "passport_submit";
    },
  ) => string;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const EMPTY_FORM: FormValues = {
  fullName: "",
  address: "",
  phone: "",
  privacyAccepted: false,
  website: "",
};

const MAX_SOURCE_FILE = 10 * 1024 * 1024;
const TARGET_PROOF_BYTES = 64 * 1024;
const MAX_CLIENT_PROOF_BYTES = 70 * 1024;
const SUBMISSION_ID_STORAGE_KEY = "passport-delivery-submission-id";
const SUCCESS_ID_STORAGE_KEY = "passport-delivery-success-id";
const ALLOWED_TYPES = new Set<ProofMimeType>(["image/jpeg", "image/png", "image/webp"]);
const COMPRESSION_ATTEMPTS = [
  { maxDimension: 1600, quality: 0.72 },
  { maxDimension: 1600, quality: 0.56 },
  { maxDimension: 1600, quality: 0.42 },
  { maxDimension: 1440, quality: 0.52 },
  { maxDimension: 1440, quality: 0.38 },
  { maxDimension: 1280, quality: 0.48 },
  { maxDimension: 1280, quality: 0.34 },
  { maxDimension: 1120, quality: 0.42 },
  { maxDimension: 1120, quality: 0.3 },
  { maxDimension: 960, quality: 0.36 },
  { maxDimension: 960, quality: 0.26 },
] as const;
let webpEncodingSupported: boolean | null = null;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.floor(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePhone(value: string) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("62")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, 13);
}

function validateForm(
  values: FormValues,
  proof: File | null,
  captchaRequired: boolean,
  captchaToken: string,
) {
  const errors: FormErrors = {};
  const name = values.fullName.trim();
  const address = values.address.trim();
  const phone = normalizePhone(values.phone);

  if (name.length < 3) errors.fullName = "Masukkan nama lengkap penerima.";
  else if (name.length > 100) errors.fullName = "Nama terlalu panjang (maksimal 100 karakter).";
  else if (!/^[\p{L}\p{M} .'-]+$/u.test(name)) errors.fullName = "Nama hanya boleh berisi huruf dan tanda baca nama.";

  if (address.length < 15) errors.address = "Tuliskan alamat tujuan secara lengkap.";
  else if (address.length > 500) errors.address = "Alamat terlalu panjang (maksimal 500 karakter).";

  if (!/^8\d{8,12}$/.test(phone)) errors.phone = "Gunakan nomor Indonesia aktif, misalnya 81234567890.";

  if (!proof) errors.proof = "Unggah bukti pembayaran terlebih dahulu.";
  if (!values.privacyAccepted) errors.privacy = "Konfirmasi bahwa Anda telah membaca pemberitahuan privasi.";
  if (captchaRequired && !captchaToken) errors.captcha = "Selesaikan pemeriksaan keamanan.";

  return errors;
}

async function loadImage(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Gambar tidak dapat dibaca."));
      image.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gambar tidak dapat dibaca."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("Gambar tidak dapat diproses."));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: ProofMimeType, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gambar tidak dapat diproses."))),
      mimeType,
      quality,
    );
  });
}

async function canvasToPreferredBlob(canvas: HTMLCanvasElement, quality: number) {
  if (webpEncodingSupported !== false) {
    try {
      const webp = await canvasToBlob(canvas, "image/webp", quality);
      webpEncodingSupported = webp.type === "image/webp";
      if (webpEncodingSupported) return { blob: webp, mimeType: "image/webp" as const };
    } catch {
      webpEncodingSupported = false;
    }
  }

  const jpeg = await canvasToBlob(canvas, "image/jpeg", quality);
  if (jpeg.type !== "image/jpeg") throw new Error("Perangkat tidak mendukung kompresi gambar yang aman.");
  return { blob: jpeg, mimeType: "image/jpeg" as const };
}

async function toProcessedProof(blob: Blob, mimeType: ProofMimeType): Promise<ProcessedProof> {
  return {
    mimeType,
    size: blob.size,
    base64: await blobToBase64(blob),
  };
}

async function compressProof(file: File): Promise<ProcessedProof> {
  const image = await loadImage(file);
  let output: { blob: Blob; mimeType: "image/jpeg" | "image/webp" } | null = null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Perangkat tidak mendukung pemrosesan gambar.");
  let renderedWidth = 0;
  let renderedHeight = 0;

  for (const attempt of COMPRESSION_ATTEMPTS) {
    const { maxDimension, quality } = attempt;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (width !== renderedWidth || height !== renderedHeight) {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      renderedWidth = width;
      renderedHeight = height;
    }

    const candidate = await canvasToPreferredBlob(canvas, quality);
    if (!output || candidate.blob.size < output.blob.size) output = candidate;
    if (candidate.blob.size <= TARGET_PROOF_BYTES) {
      output = candidate;
      break;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (!output || output.blob.size >= MAX_CLIENT_PROOF_BYTES) {
    throw new Error("Gambar belum dapat diperkecil di bawah 70 KB tanpa mengurangi keterbacaan. Potong area transaksi lalu coba lagi.");
  }

  return toProcessedProof(output.blob, output.mimeType);
}

function createSubmissionId() {
  const existing = sessionStorage.getItem(SUBMISSION_ID_STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(SUBMISSION_ID_STORAGE_KEY, id);
  return id;
}

export function DeliveryForm() {
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  const [proof, setProof] = useState<File | null>(null);
  const [processedProof, setProcessedProof] = useState<ProcessedProof | null>(null);
  const [proofProcessing, setProofProcessing] = useState(false);
  const [proofPreview, setProofPreview] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [successId, setSuccessId] = useState("");
  const [submissionStatus, setSubmissionStatus] = useState<SubmissionState>("processing");
  const [qrOpen, setQrOpen] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const captchaRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef("");
  const qrCloseRef = useRef<HTMLButtonElement>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);
  const proofJobRef = useRef(0);

  useEffect(() => {
    const savedSuccessId = sessionStorage.getItem(SUCCESS_ID_STORAGE_KEY);
    if (savedSuccessId) setSuccessId(savedSuccessId);
  }, []);

  useEffect(() => {
    fetch("/api/config", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((config: { turnstileSiteKey?: string } | null) => {
        if (config?.turnstileSiteKey) setTurnstileSiteKey(config.turnstileSiteKey);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!turnstileSiteKey || !captchaRef.current || widgetIdRef.current) return;
    const target = captchaRef.current;

    const renderWidget = () => {
      if (!window.turnstile || widgetIdRef.current || !target.isConnected) return;
      widgetIdRef.current = window.turnstile.render(target, {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setCaptchaToken(token);
          setErrors((current) => ({ ...current, captcha: undefined }));
        },
        "expired-callback": () => setCaptchaToken(""),
        "error-callback": () => setCaptchaToken(""),
        theme: "light",
        size: "flexible",
        action: "passport_submit",
      });
    };

    if (window.turnstile) {
      renderWidget();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>("script[data-turnstile]");
    if (existingScript) {
      existingScript.addEventListener("load", renderWidget, { once: true });
      return () => existingScript.removeEventListener("load", renderWidget);
    }

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.turnstile = "true";
    script.addEventListener("load", renderWidget, { once: true });
    document.head.appendChild(script);
    return () => script.removeEventListener("load", renderWidget);
  }, [turnstileSiteKey]);

  useEffect(() => {
    if (!successId || submissionStatus === "synced") return;
    const controller = new AbortController();
    let timer = 0;
    let checks = 0;

    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/status/${encodeURIComponent(successId)}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json().catch(() => null)) as {
          ok?: boolean;
          status?: SubmissionState;
        } | null;
        if (response.ok && result?.ok && result.status) {
          setSubmissionStatus(result.status);
          if (result.status === "synced") return;
        } else if (response.status === 404) {
          sessionStorage.removeItem(SUBMISSION_ID_STORAGE_KEY);
          sessionStorage.removeItem(SUCCESS_ID_STORAGE_KEY);
          setSubmissionStatus("processing");
          setSuccessId("");
          return;
        }
      } catch {
        // Pengajuan sudah diterima; gangguan polling tidak membatalkan penyimpanan.
      }

      checks += 1;
      if (checks < 20 && !controller.signal.aborted) {
        timer = window.setTimeout(checkStatus, 1500);
      }
    };

    timer = window.setTimeout(checkStatus, 500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [successId, submissionStatus]);

  useEffect(() => {
    if (!qrOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQrOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    qrCloseRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [qrOpen]);

  useEffect(() => {
    return () => {
      if (proofPreview) URL.revokeObjectURL(proofPreview);
    };
  }, [proofPreview]);

  function updateField<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    const errorField = field === "privacyAccepted" ? "privacy" : field;
    setErrors((current) => ({ ...current, [errorField]: undefined, general: undefined }));
  }

  async function handleProof(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = event.target.files?.[0] ?? null;
    if (!file) return;

    if (!ALLOWED_TYPES.has(file.type as ProofMimeType)) {
      setErrors((current) => ({ ...current, proof: "Gunakan gambar JPG, PNG, atau WEBP." }));
      input.value = "";
      return;
    }
    if (file.size > MAX_SOURCE_FILE) {
      setErrors((current) => ({ ...current, proof: "Ukuran foto maksimal 10 MB." }));
      input.value = "";
      return;
    }

    const jobId = proofJobRef.current + 1;
    proofJobRef.current = jobId;
    if (proofPreview) URL.revokeObjectURL(proofPreview);
    const previewUrl = URL.createObjectURL(file);
    setProof(file);
    setProcessedProof(null);
    setProofProcessing(true);
    setProofPreview(previewUrl);
    setErrors((current) => ({ ...current, proof: undefined, general: undefined }));

    try {
      const optimized = await compressProof(file);
      if (proofJobRef.current !== jobId) return;
      URL.revokeObjectURL(previewUrl);
      setProofPreview(`data:${optimized.mimeType};base64,${optimized.base64}`);
      setProcessedProof(optimized);
    } catch (error) {
      if (proofJobRef.current !== jobId) return;
      setProof(null);
      setProcessedProof(null);
      setProofPreview("");
      input.value = "";
      setErrors((current) => ({
        ...current,
        proof: error instanceof Error ? error.message : "Gambar tidak dapat diproses.",
      }));
    } finally {
      if (proofJobRef.current === jobId) setProofProcessing(false);
    }
  }

  function removeProof() {
    proofJobRef.current += 1;
    if (proofPreview) URL.revokeObjectURL(proofPreview);
    setProof(null);
    setProcessedProof(null);
    setProofProcessing(false);
    setProofPreview("");
    if (proofInputRef.current) proofInputRef.current.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateForm(values, proof, Boolean(turnstileSiteKey), captchaToken);
    if (proofProcessing) nextErrors.proof = "Tunggu sebentar, gambar masih dioptimalkan.";
    else if (proof && !processedProof) nextErrors.proof = "Pilih ulang gambar bukti pembayaran.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !proof || !processedProof) {
      document.querySelector<HTMLElement>("[data-field-error]")?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const submissionId = createSubmissionId();
      const response = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          submissionId,
          fullName: values.fullName.trim(),
          address: values.address.trim(),
          whatsapp: `62${normalizePhone(values.phone)}`,
          proof: processedProof,
          turnstileToken: captchaToken,
          website: values.website,
          noticeVersion: "2026-08-21.v1",
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        submissionId?: string;
        status?: SubmissionState;
      } | null;
      if (!response.ok || !result?.ok) {
        throw new Error(result?.message || "Data belum dapat dikirim. Silakan coba lagi.");
      }

      const acceptedId = result.submissionId || submissionId;
      sessionStorage.setItem(SUCCESS_ID_STORAGE_KEY, acceptedId);
      setSubmissionStatus(result.status || "processing");
      setSuccessId(acceptedId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        general: error instanceof Error ? error.message : "Terjadi kendala. Silakan coba lagi.",
      }));
      if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
      setCaptchaToken("");
    } finally {
      setSubmitting(false);
    }
  }

  if (successId) {
    const isSynced = submissionStatus === "synced";
    const isDelayed = submissionStatus === "delayed";
    return (
      <section className="success-panel" aria-live="polite">
        <span className="success-icon" aria-hidden="true">✓</span>
        <span className="eyebrow">{isSynced ? "Data berhasil tersimpan" : "Data diterima sistem"}</span>
        <h2>
          {isSynced
            ? "Terima kasih, pengajuan Anda menunggu verifikasi."
            : isDelayed
              ? "Data aman, sinkronisasi sedang dilanjutkan."
              : "Data aman dan sedang disimpan otomatis."}
        </h2>
        <p>
          {isSynced
            ? "Bukti pembayaran dan alamat sudah tercatat. Pengiriman diproses setelah pembayaran dinyatakan sesuai."
            : "Anda boleh menutup halaman ini. Sistem akan melanjutkan penyimpanan ke Google Sheets dan Drive di belakang."}
        </p>
        <div className={`sync-status is-${submissionStatus}`} role="status">
          {!isSynced && <span className="inline-spinner" aria-hidden="true" />}
          {isSynced
            ? "Tersimpan · Menunggu verifikasi petugas"
            : isDelayed
              ? "Diterima · Sinkronisasi otomatis dilanjutkan"
              : "Diterima · Sedang menyinkronkan data"}
        </div>
        <div className="reference-box">
          <small>ID pengajuan</small>
          <strong>{successId}</strong>
        </div>
        <p className="success-note">Simpan ID ini jika Anda perlu menghubungi petugas. Halaman ini bukan bukti bahwa pembayaran telah terverifikasi.</p>
        <button
          className="secondary-button"
          type="button"
          onClick={() => {
            sessionStorage.removeItem(SUBMISSION_ID_STORAGE_KEY);
            sessionStorage.removeItem(SUCCESS_ID_STORAGE_KEY);
            setSuccessId("");
            setSubmissionStatus("processing");
            setValues(EMPTY_FORM);
            removeProof();
          }}
        >
          Buat pengajuan baru
        </button>
      </section>
    );
  }

  return (
    <>
      <div className="form-heading">
        <span className="eyebrow">Formulir pengiriman</span>
        <h2>Ke mana paspor dikirim?</h2>
        <p>Pastikan data sesuai dengan penerima di alamat tujuan.</p>
      </div>

      <aside className="form-assistance" aria-label="Kontak bantuan Pos Indonesia">
        <span className="assistance-icon" aria-hidden="true">?</span>
        <p>
          Tidak ada petugas Pos di lokasi Imigrasi Batam. Kendala?{" "}
          <a href="https://wa.me/6281372212002" target="_blank" rel="noopener noreferrer">
            Hubungi Riky Juliadi · 0813-7221-2002
          </a>
        </p>
      </aside>

      <form className="delivery-form" onSubmit={handleSubmit} noValidate>
        <label>
          <span>Nama lengkap penerima <b aria-hidden="true">*</b></span>
          <input
            data-field-error={errors.fullName ? "true" : undefined}
            type="text"
            name="fullName"
            value={values.fullName}
            onChange={(event) => updateField("fullName", event.target.value)}
            placeholder="Contoh: Andi Pratama"
            autoComplete="name"
            maxLength={100}
            aria-invalid={Boolean(errors.fullName)}
            aria-describedby={errors.fullName ? "name-error" : undefined}
          />
          {errors.fullName && <small className="field-error" id="name-error">{errors.fullName}</small>}
        </label>

        <label>
          <span>Alamat penerima <b aria-hidden="true">*</b></span>
          <textarea
            data-field-error={errors.address ? "true" : undefined}
            name="address"
            value={values.address}
            onChange={(event) => updateField("address", event.target.value)}
            placeholder="Nama jalan, nomor rumah, RT/RW, kelurahan, kecamatan, kota, dan kode pos"
            rows={4}
            autoComplete="street-address"
            maxLength={500}
            aria-invalid={Boolean(errors.address)}
            aria-describedby={errors.address ? "address-error" : "address-help"}
          />
          {errors.address ? (
            <small className="field-error" id="address-error">{errors.address}</small>
          ) : (
            <small id="address-help">Alamat lengkap membantu kurir mengantar tanpa kendala.</small>
          )}
        </label>

        <label>
          <span>Nomor HP / WhatsApp aktif <b aria-hidden="true">*</b></span>
          <div className={`phone-field ${errors.phone ? "has-error" : ""}`}>
            <span>+62</span>
            <input
              data-field-error={errors.phone ? "true" : undefined}
              type="tel"
              name="phone"
              value={values.phone}
              onChange={(event) => updateField("phone", normalizePhone(event.target.value))}
              placeholder="812 3456 7890"
              autoComplete="tel"
              inputMode="numeric"
              aria-invalid={Boolean(errors.phone)}
              aria-describedby={errors.phone ? "phone-error" : undefined}
            />
          </div>
          {errors.phone && <small className="field-error" id="phone-error">{errors.phone}</small>}
        </label>

        <section className="payment-card" aria-labelledby="payment-title">
          <div className="payment-copy">
            <span className="eyebrow">Pembayaran QRIS</span>
            <strong id="payment-title">Rp25.000</strong>
            <p>Sudah termasuk ongkir pengiriman dan biaya sampul.</p>
            <span className="merchant-name">Nama QRIS: <b>RIKY JULIADI</b></span>
            <div className="payment-actions">
              <button type="button" onClick={() => setQrOpen(true)}>Perbesar QR</button>
              <a href="/assets/qris-pengiriman-paspor.png" download>Unduh QR</a>
            </div>
          </div>
          <button className="qr-thumbnail" type="button" onClick={() => setQrOpen(true)} aria-label="Perbesar kode QRIS">
            <img src="/assets/qris-pengiriman-paspor.png" alt="QRIS pembayaran ongkir pengiriman paspor" />
          </button>
        </section>

        <aside className="payment-warning">
          <span aria-hidden="true">!</span>
          <p><strong>Sebelum membayar</strong> Gunakan QRIS ini hanya jika tautan diberikan langsung oleh petugas resmi. Jika nama penerima berbeda atau Anda ragu, jangan lanjutkan dan konfirmasikan kepada petugas.</p>
        </aside>

        <label className="upload-field">
          <span>Bukti pembayaran QRIS <b aria-hidden="true">*</b></span>
          {proof ? (
            <span className="proof-preview" aria-live="polite" aria-busy={proofProcessing}>
              <img src={proofPreview} alt="Pratinjau bukti pembayaran yang dipilih" />
              <span>
                <strong>{proof.name}</strong>
                {proofProcessing ? (
                  <small className="proof-status is-processing"><span className="inline-spinner" aria-hidden="true" /> Mengoptimalkan gambar…</small>
                ) : processedProof ? (
                  <small className="proof-status">{formatBytes(proof.size)} → {formatBytes(processedProof.size)} · Siap dikirim</small>
                ) : (
                  <small className="proof-status has-error">Gambar belum siap. Pilih ulang.</small>
                )}
              </span>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  removeProof();
                }}
                aria-label="Hapus foto bukti pembayaran"
              >
                Hapus
              </button>
            </span>
          ) : (
            <span className={`upload-box ${errors.proof ? "has-error" : ""}`}>
              <span className="upload-icon" aria-hidden="true">↑</span>
              <strong>Pilih foto bukti pembayaran</strong>
              <small>JPG, PNG, atau WEBP · Maksimal 10 MB · Hasil di bawah 70 KB</small>
            </span>
          )}
          <input
            ref={proofInputRef}
            data-field-error={errors.proof ? "true" : undefined}
            className="visually-hidden"
            type="file"
            name="paymentProof"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleProof}
            aria-invalid={Boolean(errors.proof)}
            aria-describedby={errors.proof ? "proof-error" : "proof-help"}
          />
          {errors.proof ? (
            <small className="field-error" id="proof-error">{errors.proof}</small>
          ) : (
            <small id="proof-help">Potong gambar agar hanya menampilkan nominal, waktu, status berhasil, merchant, dan referensi. Samarkan saldo serta transaksi lain.</small>
          )}
        </label>

        <details className="privacy-details">
          <summary>Pemberitahuan privasi data</summary>
          <p>
            Nama, alamat, WhatsApp, dan bukti pembayaran digunakan untuk verifikasi pembayaran, pengantaran paspor, pembaruan status, serta penanganan keluhan. Data operasional dan gambar bukti disimpan sampai 90 hari setelah kiriman selesai, lalu dihapus atau dianonimkan; catatan transaksi minimum dapat disimpan lebih lama sesuai kewajiban hukum.
          </p>
        </details>

        <label className="consent-field">
          <input
            data-field-error={errors.privacy ? "true" : undefined}
            type="checkbox"
            checked={values.privacyAccepted}
            onChange={(event) => updateField("privacyAccepted", event.target.checked)}
            aria-invalid={Boolean(errors.privacy)}
            aria-describedby={errors.privacy ? "privacy-error" : undefined}
          />
          <span>Saya telah membaca Pemberitahuan Privasi dan mengonfirmasi data yang diberikan benar untuk pelaksanaan pengiriman paspor.</span>
        </label>
        {errors.privacy && <small className="field-error standalone-error" id="privacy-error">{errors.privacy}</small>}

        <label className="honeypot" aria-hidden="true">
          Website
          <input type="text" name="website" value={values.website} onChange={(event) => updateField("website", event.target.value)} tabIndex={-1} autoComplete="off" />
        </label>

        {turnstileSiteKey && (
          <div className="captcha-section">
            <div ref={captchaRef} />
            {errors.captcha && <small className="field-error">{errors.captcha}</small>}
          </div>
        )}

        {errors.general && <div className="submit-error" role="alert">{errors.general}</div>}

        <button className="submit-button" type="submit" disabled={submitting || proofProcessing}>
          {proofProcessing ? (
            <><span className="spinner" aria-hidden="true" /> Menyiapkan gambar…</>
          ) : submitting ? (
            <><span className="spinner" aria-hidden="true" /> Mengamankan data…</>
          ) : (
            <>Kirim data pengiriman <span aria-hidden="true">→</span></>
          )}
        </button>
        <p className="form-note">Setelah diterima sistem, penyimpanan dilanjutkan otomatis tanpa membuat Anda menunggu. Pengiriman diproses setelah bukti pembayaran diverifikasi petugas.</p>
      </form>

      {qrOpen && (
        <div className="qr-modal" role="dialog" aria-modal="true" aria-label="Kode QRIS pembayaran">
          <div className="qr-modal-card">
            <button ref={qrCloseRef} className="modal-close" type="button" onClick={() => setQrOpen(false)} aria-label="Tutup kode QRIS">×</button>
            <span className="eyebrow">Scan dengan aplikasi pembayaran</span>
            <h3>Ongkir &amp; sampul · Rp25.000</h3>
            <img src="/assets/qris-pengiriman-paspor.png" alt="QRIS pembayaran ongkir dan sampul paspor sebesar Rp25.000, atas nama RIKY JULIADI" />
            <p>Pastikan nama penerima yang tampil adalah <strong>RIKY JULIADI</strong>.</p>
          </div>
        </div>
      )}
    </>
  );
}
