/**
 * Backend Google Apps Script untuk Pengiriman Paspor Batam.
 *
 * Script Properties wajib:
 * - INTEGRATION_TOKEN
 * - SPREADSHEET_ID
 * - SHEET_NAME
 * - DRIVE_FOLDER_ID
 */

var HEADERS = [
  "Waktu Server",
  "ID Pengajuan",
  "Nama Penerima",
  "Alamat",
  "WhatsApp",
  "Nominal",
  "Status",
  "URL Bukti",
  "File ID",
  "MIME",
  "Versi Pemberitahuan",
  "Persetujuan Privasi"
];

var MAX_PROOF_BYTES = 2 * 1024 * 1024;

function doGet() {
  return json_({ ok: true, service: "passport-delivery-storage" });
}

function doPost(event) {
  var lock = LockService.getScriptLock();
  var createdFile = null;

  try {
    if (!event || !event.postData || !event.postData.contents) {
      throw new Error("Payload kosong.");
    }

    var payload = JSON.parse(event.postData.contents);
    var properties = PropertiesService.getScriptProperties();
    requireProperties_(properties);

    if (String(payload.integrationToken || "") !== properties.getProperty("INTEGRATION_TOKEN")) {
      return json_({ ok: false, message: "Akses ditolak." });
    }

    var data = validatePayload_(payload);
    lock.waitLock(30000);

    var spreadsheet = SpreadsheetApp.openById(properties.getProperty("SPREADSHEET_ID"));
    var sheetName = properties.getProperty("SHEET_NAME");
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
    ensureHeader_(sheet);

    var duplicateRow = findSubmissionRow_(sheet, data.submissionId);
    if (duplicateRow) {
      return json_({
        ok: true,
        duplicate: true,
        submissionId: data.submissionId,
        message: "Pengajuan sudah tercatat."
      });
    }

    var folder = DriveApp.getFolderById(properties.getProperty("DRIVE_FOLDER_ID"));
    var extension = data.mimeType === "image/jpeg" ? "jpg" : data.mimeType === "image/png" ? "png" : "webp";
    var filename = "bukti_" + data.submissionId + "." + extension;
    var blob = Utilities.newBlob(data.bytes, data.mimeType, filename);
    createdFile = folder.createFile(blob);
    createdFile.setDescription("Bukti pembayaran pengiriman paspor. ID: " + data.submissionId);

    sheet.appendRow([
      new Date(),
      safeCell_(data.submissionId),
      safeCell_(data.fullName),
      safeCell_(data.address),
      "'" + data.whatsapp,
      25000,
      "MENUNGGU VERIFIKASI",
      createdFile.getUrl(),
      createdFile.getId(),
      data.mimeType,
      safeCell_(data.noticeVersion),
      "YA"
    ]);

    var row = sheet.getLastRow();
    sheet.getRange(row, 1).setNumberFormat("dd/MM/yyyy HH:mm:ss");
    sheet.getRange(row, 5).setNumberFormat("@");
    sheet.getRange(row, 6).setNumberFormat('"Rp"#,##0');
    sheet.getRange(row, 7).setBackground("#FFF4CC").setFontWeight("bold");

    return json_({
      ok: true,
      submissionId: data.submissionId,
      message: "Data berhasil disimpan."
    });
  } catch (error) {
    if (createdFile) {
      try {
        createdFile.setTrashed(true);
      } catch (cleanupError) {
        console.error("Gagal membersihkan file yatim: " + cleanupError.message);
      }
    }
    console.error("Penyimpanan pengajuan gagal: " + (error && error.message ? error.message : "unknown"));
    return json_({
      ok: false,
      message: "Data belum dapat disimpan. Periksa konfigurasi atau coba lagi."
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (releaseError) {
      // Lock mungkin belum diperoleh; aman diabaikan.
    }
  }
}

function validatePayload_(payload) {
  var submissionId = String(payload.submissionId || "").trim();
  var fullName = String(payload.fullName || "").trim();
  var address = String(payload.address || "").trim();
  var whatsapp = String(payload.whatsapp || "").trim();
  var noticeVersion = String(payload.noticeVersion || "").trim();
  var proof = payload.proof || {};
  var mimeType = String(proof.mimeType || "").trim();
  var base64 = String(proof.base64 || "").trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    throw new Error("ID pengajuan tidak valid.");
  }
  if (fullName.length < 3 || fullName.length > 100 || /[\u0000-\u001F\u007F]/.test(fullName)) {
    throw new Error("Nama tidak valid.");
  }
  if (address.length < 15 || address.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(address)) {
    throw new Error("Alamat tidak valid.");
  }
  if (!/^628\d{8,12}$/.test(whatsapp)) throw new Error("WhatsApp tidak valid.");
  if (["image/jpeg", "image/png", "image/webp"].indexOf(mimeType) === -1) throw new Error("MIME tidak valid.");
  if (Number(payload.amount) !== 25000) throw new Error("Nominal tidak valid.");
  if (payload.privacyAccepted !== true) throw new Error("Konfirmasi privasi tidak ditemukan.");
  if (!noticeVersion || noticeVersion.length > 50) throw new Error("Versi pemberitahuan tidak valid.");
  if (!base64 || base64.length > 2900000) throw new Error("Bukti pembayaran terlalu besar.");

  var bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (error) {
    throw new Error("Bukti pembayaran tidak dapat dibaca.");
  }

  if (bytes.length < 100 || bytes.length > MAX_PROOF_BYTES) throw new Error("Ukuran bukti pembayaran tidak valid.");
  if (Number(proof.size) !== bytes.length) throw new Error("Ukuran bukti pembayaran tidak cocok.");
  if (!matchesMagicBytes_(bytes, mimeType)) throw new Error("Isi bukti pembayaran tidak valid.");

  return {
    submissionId: submissionId,
    fullName: fullName,
    address: address,
    whatsapp: whatsapp,
    noticeVersion: noticeVersion,
    mimeType: mimeType,
    bytes: bytes
  };
}

function matchesMagicBytes_(bytes, mimeType) {
  function byteAt_(index) {
    return bytes[index] < 0 ? bytes[index] + 256 : bytes[index];
  }

  if (mimeType === "image/jpeg") {
    return byteAt_(0) === 255 && byteAt_(1) === 216 && byteAt_(2) === 255;
  }
  if (mimeType === "image/png") {
    var png = [137, 80, 78, 71, 13, 10, 26, 10];
    return png.every(function(value, index) { return byteAt_(index) === value; });
  }
  if (mimeType === "image/webp") {
    return String.fromCharCode(byteAt_(0), byteAt_(1), byteAt_(2), byteAt_(3)) === "RIFF" &&
      String.fromCharCode(byteAt_(8), byteAt_(9), byteAt_(10), byteAt_(11)) === "WEBP";
  }
  return false;
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setBackground("#07213D")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold");
    sheet.autoResizeColumns(1, HEADERS.length);
  }
}

function findSubmissionRow_(sheet, submissionId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var match = sheet.getRange(2, 2, lastRow - 1, 1)
    .createTextFinder(submissionId)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : 0;
}

function safeCell_(value) {
  var text = String(value == null ? "" : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function requireProperties_(properties) {
  ["INTEGRATION_TOKEN", "SPREADSHEET_ID", "SHEET_NAME", "DRIVE_FOLDER_ID"].forEach(function(key) {
    if (!properties.getProperty(key)) throw new Error("Script Property belum diisi: " + key);
  });
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
