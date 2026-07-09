// ====== Salut / reset triggers ======
const EXACT_GREETINGS = ["bonjour", "bonsoir", "salut", "salam", "hello", "yo", "coucou"];

function isGreeting(text) {
  return EXACT_GREETINGS.includes(String(text || "").trim().toLowerCase());
}

function isGreetingOrReset(text) {
  const t = String(text || "").trim().toLowerCase();
  const exactResets = ["menu", "start", "0", "reset", "annuler", "retour", "accueil"];
  if (EXACT_GREETINGS.includes(t) || exactResets.includes(t)) return true;
  // Phrases contenant des mots-clés de retour au menu
  const menuKeywords = ["retour au menu", "revenir au menu", "retourner au menu", "back to menu", "menu principal", "aller au menu"];
  return menuKeywords.some((kw) => t.includes(kw));
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

// ====== Richer confirmation / denial helpers ======
function isConfirmation(text) {
  const raw = String(text || "").trim().toLowerCase();
  const t = raw.replace(/[!.,✅🎉👍]/g, "").trim();
  // Un "?" = question, jamais une confirmation ("oui ?" / "c'est bon ?")
  if (raw.includes("?")) return false;
  if (new Set([
    "oui", "ouais", "o", "yes", "yep", "ok", "okay",
    "d accord", "d'accord", "ça marche", "ca marche",
    "allons y", "allons-y", "go", "bien sur", "bien sûr",
    "confirme", "confirmer", "correct", "exactement",
    "tout a fait", "tout à fait", "1",
    "c est bon", "c'est bon", "parfait", "nickel", "impeccable",
    "c est ça", "c'est ça", "voilà", "voila",
    "c est bien ça", "c'est bien ça", "c est bien", "c'est bien",
    "validé", "valider",
  ]).has(t)) return true;
  // "ouiii" / "ouiiis" — élongations
  if (/^ou+i+s?$/.test(t)) return true;
  // "oui merci", "ok super", "yes parfait" : premier mot affirmatif + message court
  // sans réserve ("mais", "pas", "non") — sinon on laisse le LLM interpréter.
  const first = t.split(/\s+/)[0] || "";
  if (["oui", "ouais", "yes", "yep", "ok", "okay"].includes(first)
      && t.length <= 30
      && !/\b(mais|pas|non|sauf)\b/.test(t)) return true;
  return false;
}

function isDenial(text) {
  const raw = String(text || "").trim().toLowerCase();
  const t = raw.replace(/[!.,❌]/g, "").trim();
  if (raw.includes("?")) return false;
  if (new Set([
    "non", "n", "no", "nope", "annuler", "annule", "cancel",
    "2", "changer", "incorrect", "faux", "pas ça", "pas ca",
  ]).has(t)) return true;
  // "non merci" : premier mot négatif + message court sans nuance ("mais")
  const first = t.split(/\s+/)[0] || "";
  if (["non", "no", "nope"].includes(first)
      && t.length <= 20
      && !/\b(mais)\b/.test(t)) return true;
  return false;
}

// Extract name + email from a message.
// Uses the longest consecutive run of capitalized alphabetic words to find the name,
// avoiding false matches on sentence-starting words like "Je", "Bonjour", etc.
function extractContactFromText(text) {
  const words = String(text || "").trim().split(/\s+/);
  const emailWord = words.find(w => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(w));
  if (!emailWord) return { email: null, name: null };

  const nonEmail = words.filter(w => !w.includes("@"));
  let bestRun = [];
  let cur = [];
  const isCapAlpha = w => /^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇŒÆ]/u.test(w) && /^[a-zA-ZÀ-ÿ\-']+$/u.test(w) && w.length > 1;
  for (const w of nonEmail) {
    if (isCapAlpha(w)) {
      cur.push(w);
    } else {
      if (cur.length > bestRun.length) bestRun = [...cur];
      cur = [];
    }
  }
  if (cur.length > bestRun.length) bestRun = cur;

  return {
    email: emailWord.toLowerCase(),
    name: bestRun.length >= 1 ? bestRun.slice(0, 3).join(" ") : null,
  };
}

module.exports = {
  isGreeting,
  isGreetingOrReset,
  extractInboundText,
  extractInteractiveId,
  normalizePlate,
  validatePlate,
  validateEmail,
  isConfirmation,
  isDenial,
  extractContactFromText,
};
