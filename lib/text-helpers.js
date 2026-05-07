// ====== Salut / reset triggers ======
function isGreetingOrReset(text) {
  const t = String(text || "").trim().toLowerCase();
  const greetings = [
    "bonjour",
    "bonsoir",
    "salut",
    "salam",
    "hello",
    "yo",
    "coucou",
  ];
  return greetings.includes(t) || t === "menu" || t === "start" || t === "0" || t === "reset" || t === "annuler" || t === "retour" || t === "accueil";
}

// ====== Extract inbound text (text/button/interactive) ======
function extractInboundText(msg) {
  const type = msg?.type;
  if (type === "text") return msg.text?.body || "";
  if (type === "button") return msg.button?.text || "";
  if (type === "interactive") {
    const btnTitle = msg.interactive?.button_reply?.title;
    const listTitle = msg.interactive?.list_reply?.title;
    return btnTitle || listTitle || "[interactive]";
  }
  return `[${type || "unknown"}]`;
}

function extractInteractiveId(msg) {
  if (msg?.type !== "interactive") return null;
  return msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
}

// ====== Plaque helpers ======
function normalizePlate(input) {
  // Remove spaces, hyphens, underscores and convert to uppercase
  const cleaned = String(input || "")
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
  
  // Validate French SIV format: 2 letters + 3 digits + 2 letters
  const sivPattern = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (sivPattern.test(cleaned)) {
    // Format as AA-123-BB for storage/display
    return cleaned.slice(0, 2) + "-" + cleaned.slice(2, 5) + "-" + cleaned.slice(5);
  }
  
  // If not valid, return cleaned version for error handling
  return cleaned;
}

// ====== Plate validation (strict FR format) ======
function validatePlate(input) {
  const normalized = normalizePlate(input);
  // Check if the normalized format matches AA-123-BB
  const sivFormat = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
  if (sivFormat.test(normalized)) {
    return { valid: true, plate: normalized };
  }
  return { valid: false, plate: normalized };
}

// ====== Email validation ======
function validateEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return re.test(email) ? email : null;
}

module.exports = {
  isGreetingOrReset,
  extractInboundText,
  extractInteractiveId,
  normalizePlate,
  validatePlate,
  validateEmail,
};
