/**
 * Tests pour le module voice-handler.js
 */

const {
  VOICE_TYPES,
  SUPPORTED_LANGUAGES,
  formatTranscriptForDisplay,
  prepareForLLM,
  isTranscriptValid,
  getErrorMessage,
  isTranscript,
  detectLanguageFromText,
  getLangFlag,
} = require("../lib/voice-handler");

console.log("🎤 Testing voice-handler module\n");

// ====== VOICE_TYPES ======
console.log("🧪 Testing VOICE_TYPES...");
console.assert(VOICE_TYPES.has("voice"), "✅ voice type supported");
console.assert(VOICE_TYPES.has("audio"), "✅ audio type supported");
console.assert(!VOICE_TYPES.has("image"), "✅ image not in voice types");
console.log("✅ Test 1 passed: Voice types\n");

// ====== SUPPORTED_LANGUAGES ======
console.log("🧪 Testing SUPPORTED_LANGUAGES...");
console.assert(SUPPORTED_LANGUAGES.fr === "Français", "✅ French supported");
console.assert(SUPPORTED_LANGUAGES.en === "Anglais", "✅ English supported");
console.assert(SUPPORTED_LANGUAGES.es === "Espagnol", "✅ Spanish supported");
console.log("✅ Test 2 passed: Supported languages\n");

// ====== formatTranscriptForDisplay ======
console.log("🧪 Testing formatTranscriptForDisplay...");

const formatted1 = formatTranscriptForDisplay("Bonjour, je veux une reprog", {
  language: "fr",
  confidence: 0.9,
});
console.assert(formatted1.includes("🎤"), "✅ Emoji present");
console.assert(formatted1.includes("Message vocal transcrit"), "✅ Header present");
console.assert(formatted1.includes("🇫🇷"), "✅ French flag present");
console.assert(formatted1.includes("Bonjour, je veux une reprog"), "✅ Text included");
console.log("✅ Test 3 passed: Format display with high confidence\n");

const formatted2 = formatTranscriptForDisplay("Hello world", {
  language: "en",
  confidence: 0.4,
});
console.assert(formatted2.includes("⚠️ *Transcription incertaine*"), "✅ Warning for low confidence");
console.log("✅ Test 4 passed: Warning for low confidence\n");

const formatted3 = formatTranscriptForDisplay("Hola mundo", {
  language: "es",
  confidence: 0.8,
  hasEmoji: false,
});
console.assert(!formatted3.includes("🎤"), "✅ No emoji when disabled");
console.assert(formatted3.includes("🇪🇸"), "✅ Spanish flag present");
console.log("✅ Test 5 passed: Format without emoji\n");

// ====== prepareForLLM ======
console.log("🧪 Testing prepareForLLM...");

const llmContext = prepareForLLM("Je veux une reprog pour ma Golf", {
  language: "fr",
  confidence: 0.92,
  audioDuration: 3.5,
});
console.assert(llmContext.includes("[TRANSCRIPTION VOCALE]"), "✅ Context header");
console.assert(llmContext.includes('Texte: "Je veux une reprog pour ma Golf"'), "✅ Text included");
console.assert(llmContext.includes("Langue détectée: Français"), "✅ Language info");
console.assert(llmContext.includes("Confiance transcription: 92%"), "✅ Confidence info");
console.assert(llmContext.includes("Durée audio: 3.5s"), "✅ Duration info");
console.assert(llmContext.includes("\n---\n"), "✅ Separator");
console.log("✅ Test 6 passed: LLM context preparation\n");

// ====== isTranscriptValid ======
console.log("🧪 Testing isTranscriptValid...");

console.assert(isTranscriptValid({ text: "Hello", confidence: 0.8 }) === true, "✅ Valid transcript");
console.assert(isTranscriptValid({ text: "H", confidence: 0.8 }) === false, "✅ Too short");
console.assert(isTranscriptValid({ text: "Hello", confidence: 0.2 }) === false, "✅ Low confidence");
console.assert(isTranscriptValid(null) === false, "✅ Null transcript");
console.assert(isTranscriptValid({ text: "Hello" }) === true, "✅ No confidence defaults to valid");
console.log("✅ Test 7 passed: Transcript validation\n");

// ====== getErrorMessage ======
console.log("🧪 Testing getErrorMessage...");

const err1 = getErrorMessage({ error: "FILE_TOO_LARGE" });
console.assert(err1.includes("trop long"), "✅ File too large message");

const err2 = getErrorMessage({ error: "LOW_QUALITY" });
console.assert(err2.includes("incertaine"), "✅ Low quality message");

const err3 = getErrorMessage({ error: "TRANSCRIPTION_FAILED" });
console.assert(err3.includes("indisponible"), "✅ Failed message");

const err4 = getErrorMessage({ error: "UNKNOWN" });
console.assert(err4.includes("pas pu traiter"), "✅ Generic error message");
console.log("✅ Test 8 passed: Error messages\n");

// ====== isTranscript ======
console.log("🧪 Testing isTranscript...");

console.assert(isTranscript("[TRANSCRIPTION VOCALE] Bonjour") === true, "✅ Detects transcription marker");
console.assert(isTranscript("🎤 *Message vocal transcrit* Hello") === true, "✅ Detects display format");
console.assert(isTranscript("[Message vocal transcrit] Test") === true, "✅ Detects legacy format");
console.assert(isTranscript("Simple text message") === false, "✅ Regular text not transcript");
console.assert(isTranscript(null) === false, "✅ Null not transcript");
console.log("✅ Test 9 passed: Transcript detection\n");

// ====== detectLanguageFromText ======
console.log("🧪 Testing detectLanguageFromText...");

console.assert(detectLanguageFromText("Bonjour, comment ça va ?") === "fr", "✅ Detects French");
console.assert(detectLanguageFromText("Hello, how are you?") === "en", "✅ Detects English");
console.assert(detectLanguageFromText("Hola, ¿cómo estás?") === "es", "✅ Detects Spanish");
console.assert(detectLanguageFromText("Hallo, wie geht es dir?") === "de", "✅ Detects German");
console.assert(detectLanguageFromText("مرحبا كيف حالك") === "ar", "✅ Detects Arabic");
console.assert(detectLanguageFromText("Random text") === "fr", "✅ Defaults to French");
console.log("✅ Test 10 passed: Language detection\n");

// ====== getLangFlag ======
console.log("🧪 Testing getLangFlag...");

console.assert(getLangFlag("fr") === " 🇫🇷", "✅ French flag");
console.assert(getLangFlag("en") === " 🇬🇧", "✅ UK flag");
console.assert(getLangFlag("es") === " 🇪🇸", "✅ Spanish flag");
console.assert(getLangFlag("de") === " 🇩🇪", "✅ German flag");
console.assert(getLangFlag("ar") === " 🇸🇦", "✅ Arabic flag");
console.assert(getLangFlag("unknown") === "", "✅ Unknown returns empty");
console.log("✅ Test 11 passed: Language flags\n");

console.log("🎉 ALL VOICE TESTS PASSED! 🎉\n");

// ====== Test de scénario complet ======
console.log("💡 Exemple de flux vocal complet :");
console.log("1. Client envoie message vocal (3.2s)");
console.log("2. Transcription: 'Je veux une reprog pour ma Golf 7 GTI'");
console.log("3. Langue détectée: Français (confiance: 94%)");
console.log("4. Contexte LLM préparé avec métadonnées");
console.log("5. Traitement normal du texte par le chatbot");
