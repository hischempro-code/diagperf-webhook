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
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const navy = "#1a237e";
    const red = "#c62828";
    const dark = "#212121";
    const gray = "#616161";
    const lightGray = "#9e9e9e";
    const marginL = 50;
    const marginR = 545;
    const colW = marginR - marginL;

    const logoPath = path.join(__dirname, "..", "assets", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 380, 15, { height: 120 });
    }
    doc.fontSize(24).font("Helvetica-Bold").fillColor(navy).text("DIAGPERF", marginL, 40);
    doc.fontSize(10).font("Helvetica").fillColor(gray).text("Reprogrammation & Diagnostic automobile", marginL, 68);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(dark).text("38 Rue Jean Pierre Plicque, 77124 Villenoy", marginL, 84);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(dark).text("contact@diagperf.com  |  06 75 54 70 85", marginL, 97);

    doc.moveTo(marginL, 118).lineTo(marginR, 118).strokeColor(navy).lineWidth(2.5).stroke();
    doc.moveTo(marginL, 122).lineTo(marginR, 122).strokeColor(red).lineWidth(1).stroke();

    doc.fontSize(20).font("Helvetica-Bold").fillColor(navy).text("DEVIS", marginL, 138);
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(`Référence : ${devisRef}`, 370, 140);
    doc.text(`Date : ${date}`, 370, 158);

    let y = 190;

    if (customerName) {
      doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
      y += 12;
      doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("CLIENT", marginL, y);
      y += 22;
      doc.fontSize(11).font("Helvetica").fillColor(dark);
      doc.text(customerName, marginL, y);
      y += 18;
      if (customerEmail) { doc.text(customerEmail, marginL, y); y += 18; }
      if (customerPhone) { doc.text(customerPhone, marginL, y); y += 18; }
      y += 10;
    }

    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("VÉHICULE", marginL, y);
    y += 22;
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(vehicleDesc, marginL, y);
    y += 18;
    doc.text(`Plaque : ${plate}`, marginL, y);

    y += 35;
    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("PRESTATION", marginL, y);
    y += 22;
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(prestationLabel + (stageLabel ? ` — ${stageLabel}` : ""), marginL, y);
    y += 18;
    if (gainTxt) {
      doc.font("Helvetica-Bold").fillColor(red).text(`Gains : ${gainTxt}`, marginL, y);
      doc.font("Helvetica").fillColor(dark);
      y += 18;
    }
    doc.text("Durée d'intervention : 2h - 4h", marginL, y);

    y += 40;
    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("TARIFICATION", marginL, y);
    y += 25;

    doc.rect(marginL, y, colW, 28).fillAndStroke(navy, navy);
    doc.fontSize(10).font("Helvetica-Bold").fillColor("white");
    doc.text("Désignation", marginL + 12, y + 8, { width: 300 });
    doc.text("Montant", marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    doc.rect(marginL, y, colW, 28).stroke("#dddddd");
    doc.fontSize(10).font("Helvetica").fillColor(dark);
    doc.text("Total HT", marginL + 12, y + 8, { width: 300 });
    doc.text(htTxt, marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    doc.rect(marginL, y, colW, 28).fillAndStroke("#f5f5f5", "#dddddd");
    doc.fontSize(10).font("Helvetica").fillColor(dark);
    doc.text("TVA (20%)", marginL + 12, y + 8, { width: 300 });
    doc.text(tvaTxt, marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    doc.rect(marginL, y, colW, 32).fillAndStroke(navy, navy);
    doc.fontSize(12).font("Helvetica-Bold").fillColor("white");
    doc.text("TOTAL TTC", marginL + 12, y + 9, { width: 300 });
    doc.text(ttcTxt, marginR - 112, y + 9, { width: 100, align: "right" });
    y += 50;

    doc.fontSize(12).font("Helvetica-Bold").fillColor(navy).text("GARANTIE", marginL, y);
    y += 20;
    doc.fontSize(9).font("Helvetica").fillColor(gray);
    doc.text("Se référer à nos conditions d'utilisation sur diagperf.com", marginL, y, { width: colW });
    y += 20;

    doc.fontSize(9).fillColor(lightGray);
    doc.text(
      "Ce devis est valable 30 jours à compter de sa date d'émission. " +
      "Le paiement est dû à la livraison du véhicule. Moyens de paiement acceptés : CB, espèces, virement.",
      marginL, y, { width: colW }
    );

    const footerY = 755;
    doc.moveTo(marginL, footerY).lineTo(marginR, footerY).strokeColor(navy).lineWidth(1).stroke();
    doc.fontSize(8).fillColor(gray);
    doc.text(
      "DiagPerf — 38 Rue Jean Pierre Plicque, 77124 Villenoy — contact@diagperf.com — 06 75 54 70 85",
      marginL, footerY + 8, { width: colW, align: "center" }
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
