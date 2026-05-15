const path = require("path");
const fs = require("fs");

let _log, _uploadWhatsAppMedia, _sendWhatsAppDocument;

function initPdfService({ log, uploadWhatsAppMedia, sendWhatsAppDocument }) {
  _log = log;
  _uploadWhatsAppMedia = uploadWhatsAppMedia;
  _sendWhatsAppDocument = sendWhatsAppDocument;
}

async function generateQuotePdf({ devisRef, date, vehicleDesc, plate, prestationLabel, stageLabel, gainTxt, htTxt, ttcTxt, tvaTxt, customerName, customerEmail, customerPhone }) {
  const PDFDocument = require("pdfkit");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const C = {
      dark:        "#0f172a",
      headerBg:    "#111827",
      blue:        "#1e40af",
      blueDark:    "#1e3a8a",
      accent:      "#3b82f6",
      green:       "#059669",
      greenBg:     "#f0fdf4",
      greenDark:   "#065f46",
      greenLight:  "#d1fae5",
      purple:      "#7c3aed",
      purpleBg:    "#faf5ff",
      text:        "#1e293b",
      muted:       "#64748b",
      faint:       "#94a3b8",
      light:       "#f1f5f9",
      border:      "#e2e8f0",
      white:       "#ffffff",
      teal:        "#0891b2",
      tealBg:      "#f0f9ff",
    };

    const PW = 595.28;
    const ML = 44, MR = 551, CW = MR - ML;

    // ── HEADER BAND ──────────────────────────────────────────────────────────
    doc.rect(0, 0, PW, 135).fill(C.headerBg);
    doc.rect(0, 135, PW, 4).fill(C.accent);

    // Logo (500×500 PNG avec ~30% de padding blanc autour du contenu)
    // On scale à 220px et on décale y=-58 pour clipper le padding haut
    // → la voiture apparaît de y≈8 à y≈120 dans le header
    const logoPath = path.join(__dirname, "..", "assets", "logo.png");
    const hasLogo = fs.existsSync(logoPath);
    const textX = hasLogo ? ML + 195 : ML;
    if (hasLogo) {
      try { doc.image(logoPath, ML, -58, { height: 220 }); } catch {}
    }

    // Reference card (top right inside header)
    const refW = 150, refH = 111;
    const refX = MR - refW;

    const maxTextW = refX - textX - 10;
    doc.fontSize(24).font("Helvetica-Bold").fillColor(C.white).text("DIAGPERF", textX, 22, { lineBreak: false });
    doc.fontSize(9).font("Helvetica").fillColor(C.faint).text("Reprogrammation & Diagnostic automobile", textX, 54, { width: maxTextW, lineBreak: false });
    doc.fontSize(8).fillColor("#cbd5e1").text("38 Rue Jean Pierre Plicque, 77124 Villenoy", textX, 70, { width: maxTextW, lineBreak: false });
    doc.fontSize(8).fillColor("#cbd5e1").text("contact@diagperf.com   |   06 75 54 70 85", textX, 83, { width: maxTextW, lineBreak: false });
    doc.rect(refX, 12, refW, refH).fill(C.blueDark);
    doc.rect(refX, 12, 3, refH).fill(C.accent);
    doc.fontSize(8).font("Helvetica").fillColor("#93c5fd")
      .text("N° DEVIS", refX + 12, 26, { width: refW - 16, align: "center" });
    doc.fontSize(18).font("Helvetica-Bold").fillColor(C.white)
      .text(devisRef, refX + 12, 42, { width: refW - 16, align: "center" });
    doc.moveTo(refX + 14, 72).lineTo(refX + refW - 6, 72).strokeColor(C.accent).lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").fillColor("#93c5fd")
      .text(date, refX + 12, 80, { width: refW - 16, align: "center" });

    let y = 155;

    // ── SECTION HELPER ───────────────────────────────────────────────────────
    const section = (barColor, bgColor, titleColor, title, h, renderFn) => {
      doc.rect(ML, y, 3, h).fill(barColor);
      doc.rect(ML + 3, y, CW - 3, h).fill(bgColor);
      doc.fontSize(9).font("Helvetica-Bold").fillColor(titleColor)
        .text(title, ML + 14, y + 10, { characterSpacing: 0.8 });
      doc.moveTo(ML + 14, y + 25).lineTo(MR - 10, y + 25)
        .strokeColor(C.border).lineWidth(0.5).stroke();
      renderFn(ML + 14, y + 33);
      y += h + 10;
    };

    // ── CLIENT ───────────────────────────────────────────────────────────────
    if (customerName) {
      const extraLines = (customerEmail ? 1 : 0) + (customerPhone ? 1 : 0);
      const h = 58 + extraLines * 16;
      section(C.accent, C.light, C.blue, "CLIENT", h, (x, cy) => {
        doc.fontSize(10).font("Helvetica-Bold").fillColor(C.text).text(customerName, x, cy);
        cy += 18;
        if (customerEmail) {
          doc.fontSize(9).font("Helvetica").fillColor(C.muted).text(customerEmail, x, cy);
          cy += 15;
        }
        if (customerPhone) {
          doc.fontSize(9).font("Helvetica").fillColor(C.muted).text(customerPhone, x, cy);
        }
      });
    }

    // ── VEHICULE ─────────────────────────────────────────────────────────────
    section(C.purple, C.purpleBg, C.purple, "VÉHICULE", 68, (x, cy) => {
      doc.fontSize(10).font("Helvetica-Bold").fillColor(C.text).text(vehicleDesc, x, cy);
      cy += 18;
      // Plate badge
      doc.rect(x, cy - 2, 130, 18).fill("#ede9fe");
      doc.fontSize(9).font("Helvetica-Bold").fillColor(C.purple)
        .text("Immatriculation : " + plate, x + 6, cy + 2);
    });

    // ── PRESTATION ───────────────────────────────────────────────────────────
    const prestH = gainTxt ? 100 : 80;
    section(C.green, C.greenBg, C.green, "PRESTATION", prestH, (x, cy) => {
      const fullLabel = prestationLabel + (stageLabel ? " — " + stageLabel : "");
      doc.fontSize(10).font("Helvetica-Bold").fillColor(C.text)
        .text(fullLabel, x, cy, { width: CW - 28 });
      cy += 18;
      doc.fontSize(9).font("Helvetica").fillColor(C.muted)
        .text("Durée d'intervention estimée : 2h – 4h", x, cy);
      if (gainTxt) {
        cy += 20;
        doc.rect(x - 2, cy - 2, 230, 20).fill(C.greenLight);
        doc.fontSize(9).font("Helvetica-Bold").fillColor(C.greenDark)
          .text("Gains estimés : " + gainTxt, x + 6, cy + 2);
      }
    });

    // ── PRICING TABLE ────────────────────────────────────────────────────────
    y += 8;
    doc.fontSize(10).font("Helvetica-Bold").fillColor(C.blue)
      .text("TARIFICATION", ML, y, { characterSpacing: 0.8 });
    y += 18;

    // Table header row
    doc.rect(ML, y, CW, 30).fill(C.blue);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(C.white);
    doc.text("Désignation", ML + 14, y + 10, { width: CW * 0.62 });
    doc.text("Montant", ML + 14 + CW * 0.62, y + 10, { width: CW * 0.32, align: "right" });
    y += 30;

    const tableRow = (label, value, fill) => {
      doc.rect(ML, y, CW, 27).fillAndStroke(fill, C.border);
      doc.fontSize(9).font("Helvetica").fillColor(C.text)
        .text(label, ML + 14, y + 9, { width: CW * 0.62 });
      doc.font("Helvetica-Bold").fillColor(C.muted)
        .text(value, ML + 14 + CW * 0.62, y + 9, { width: CW * 0.32, align: "right" });
      y += 27;
    };
    tableRow("Montant Hors Taxes (HT)", htTxt, C.white);
    tableRow("TVA (20%)", tvaTxt, C.light);

    // Total TTC
    doc.rect(ML, y, CW, 38).fill(C.dark);
    doc.rect(ML, y, 4, 38).fill(C.green);
    doc.fontSize(12).font("Helvetica-Bold").fillColor(C.white)
      .text("TOTAL TTC", ML + 14, y + 12, { width: CW * 0.62 });
    doc.fontSize(14).fillColor("#34d399")
      .text(ttcTxt, ML + 14 + CW * 0.62, y + 11, { width: CW * 0.32, align: "right" });
    y += 38;

    // ── CONDITIONS ───────────────────────────────────────────────────────────
    y += 20;
    doc.rect(ML, y, CW, 54).fill(C.light);
    doc.rect(ML, y, 3, 54).fill(C.muted);
    doc.fontSize(8).font("Helvetica-Bold").fillColor(C.muted)
      .text("CONDITIONS GÉNÉRALES", ML + 14, y + 9, { characterSpacing: 0.5 });
    doc.fontSize(8).font("Helvetica").fillColor(C.muted)
      .text(
        "Ce devis est valable 30 jours à compter de sa date d'émission. Le paiement est dû à la livraison du véhicule. " +
        "Moyens de paiement acceptés : CB, espèces, virement. Pour toute question, contactez-nous au 06 75 54 70 85.",
        ML + 14, y + 24, { width: CW - 28 }
      );

    // ── FOOTER BAND ──────────────────────────────────────────────────────────
    const footY = 800;
    doc.rect(0, footY, PW, 42).fill(C.headerBg);
    doc.rect(0, footY, PW, 3).fill(C.accent);
    doc.fontSize(8).font("Helvetica").fillColor(C.faint)
      .text(
        "DiagPerf — 38 Rue Jean Pierre Plicque, 77124 Villenoy — contact@diagperf.com — 06 75 54 70 85",
        ML, footY + 16, { width: CW, align: "center" }
      );

    doc.end();
  });
}

async function sendQuotePdf(fromWa, { devisId, plate, vehicle, prestationLabel, stageLabel, gainTxt, devisRow, customerName, customerEmail, customerPhone }) {
  try {
    const vehicleDesc = vehicle
      ? [vehicle.make, vehicle.model, vehicle.version].filter(Boolean).join(" ")
      : "N/A";
    const htCents = devisRow?.total_ht_centimes || 0;
    const ttcCents = devisRow?.total_ttc_centimes || 0;
    const tvaCents = ttcCents - htCents;
    const htTxt = htCents > 0 ? `${(htCents / 100).toFixed(2)} EUR` : "N/A";
    const ttcTxt = ttcCents > 0 ? `${(ttcCents / 100).toFixed(2)} EUR` : "N/A";
    const tvaTxt = tvaCents > 0 ? `${(tvaCents / 100).toFixed(2)} EUR` : "N/A";
    const devisRef = `DEV-${devisId}`;
    const date = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

    const pdfBuffer = await generateQuotePdf({
      devisRef, date, vehicleDesc, plate: plate || "N/A",
      prestationLabel: prestationLabel || "N/A", stageLabel, gainTxt,
      htTxt, ttcTxt, tvaTxt,
      customerName, customerEmail, customerPhone,
    });

    const mediaId = await _uploadWhatsAppMedia(pdfBuffer, `${devisRef}.pdf`, "application/pdf");
    await _sendWhatsAppDocument(fromWa, mediaId, `${devisRef}.pdf`, `📄 Votre devis ${devisRef}`);
    _log.info("sendQuotePdf: PDF envoyé", { wa_id: fromWa, devisRef });
  } catch (err) {
    _log.error("sendQuotePdf: erreur (non-blocking)", { wa_id: fromWa, error: String(err?.message || err) });
  }
}

module.exports = { initPdfService, generateQuotePdf, sendQuotePdf };
