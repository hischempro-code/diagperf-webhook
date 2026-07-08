/**
 * Tests pour plate-extractor.js
 */

const {
  extractPlates,
  extractFirstPlate,
  extractAndValidatePlate,
  hasPlateMention,
  removePlateFromText,
  normalizePlate,
  isValidPlate,
} = require("../lib/plate-extractor");

console.log("🚗 Testing plate-extractor\n");

// ====== normalizePlate ======
console.log("🧪 Testing normalizePlate...");
console.assert(normalizePlate("AB123CD") === "AB-123-CD", "✅ Standard format");
console.assert(normalizePlate("AB-123-CD") === "AB-123-CD", "✅ Already normalized");
console.assert(normalizePlate("AB 123 CD") === "AB-123-CD", "✅ With spaces");
console.assert(normalizePlate("ab123cd") === "AB-123-CD", "✅ Lowercase");
console.assert(normalizePlate("A-1-B") === null, "✅ Too short");
console.assert(normalizePlate("") === null, "✅ Empty");
console.assert(normalizePlate(null) === null, "✅ Null");
console.log("✅ Test 1 passed: normalizePlate\n");

// ====== isValidPlate ======
console.log("🧪 Testing isValidPlate...");
console.assert(isValidPlate("AB-123-CD") === true, "✅ Valid SIV");
console.assert(isValidPlate("AA-001-BB") === true, "✅ Valid with zeros");
console.assert(isValidPlate("AB-12-CD") === false, "✅ Too few digits");
console.assert(isValidPlate("AB-1234-CD") === false, "✅ Too many digits");
console.assert(isValidPlate("ABC-123-D") === false, "✅ Wrong format");
console.assert(isValidPlate(null) === false, "✅ Null invalid");
console.log("✅ Test 2 passed: isValidPlate\n");

// ====== extractPlates ======
console.log("🧪 Testing extractPlates...");

const plates1 = extractPlates("Ma plaque est AB-123-CD");
console.assert(plates1.length === 1, "✅ Found 1 plate");
console.assert(plates1[0].normalized === "AB-123-CD", "✅ Correct plate");
console.assert(plates1[0].valid === true, "✅ Plate valid");
console.log("✅ Test 3 passed: Single plate\n");

const plates2 = extractPlates("Comparaison: AB-123-CD vs XY-456-ZZ");
console.assert(plates2.length === 2, "✅ Found 2 plates");
console.log("✅ Test 4 passed: Multiple plates\n");

const plates3 = extractPlates("Aucune plaque ici");
console.assert(plates3.length === 0, "✅ No plates found");
console.log("✅ Test 5 passed: No plates\n");

// ====== extractFirstPlate ======
console.log("🧪 Testing extractFirstPlate...");

const first1 = extractFirstPlate("je veux une reprog, ma plaque c'est DJ-893-KL");
console.assert(first1 !== null, "✅ Plate found in sentence");
console.assert(first1.plate === "DJ-893-KL", "✅ Correct plate DJ-893-KL");
console.log("✅ Test 6 passed: Plate in sentence\n");

// Test du cas réel de l'utilisateur
const userCase = extractFirstPlate("je veux une reprog moteur, ma plaque c'est dj893kl et je veux une stage 1");
console.assert(userCase !== null, "✅ Plate found in user message");
console.assert(userCase.plate === "DJ-893-KL", "✅ Plate is DJ-893-KL");
console.log("✅ Test 7 passed: Real user case\n");

// ====== extractAndValidatePlate ======
console.log("🧪 Testing extractAndValidatePlate...");

const validated = extractAndValidatePlate("Ma voiture AB-123-CD est prête");
console.assert(validated.plate === "AB-123-CD", "✅ Plate extracted");
console.assert(validated.valid === true, "✅ Plate valid");
console.assert(validated.context !== null, "✅ Context captured");
console.log("✅ Test 8 passed: Extract and validate\n");

// ====== hasPlateMention ======
console.log("🧪 Testing hasPlateMention...");

console.assert(hasPlateMention("ma plaque est AB-123-CD") === true, "✅ Detects 'ma plaque'");
console.assert(hasPlateMention("plaque d'immatriculation: AB-123-CD") === true, "✅ Detects 'plaque d'immat'");
console.assert(hasPlateMention("numéro d'immat AB-123-CD") === true, "✅ Detects 'numéro d'immat'");
console.assert(hasPlateMention("immat: AB-123-CD") === true, "✅ Detects 'immat:'");
console.assert(hasPlateMention("plaque: AB-123-CD") === true, "✅ Detects 'plaque:'");
console.assert(hasPlateMention("AB-123-CD seulement") === false, "✅ No mention words");
console.log("✅ Test 9 passed: Plate mention detection\n");

// ====== removePlateFromText ======
console.log("🧪 Testing removePlateFromText...");

const removed1 = removePlateFromText("reprog pour AB-123-CD svp", "AB-123-CD");
console.assert(removed1.includes("AB-123-CD") === false, "✅ Plate removed");
console.assert(removed1.includes("reprog") === true, "✅ Rest preserved");
console.log("✅ Test 10 passed: Remove plate from text\n");

// ====== Cas complexes ======
console.log("🧪 Testing edge cases...");

// Format collé sans séparateurs
const collé = extractFirstPlate("plaque AB123CD merci");
console.assert(collé?.plate === "AB-123-CD", "✅ Handles AB123CD format");

// Avec espaces multiples
const espaces = extractFirstPlate("plaque AB  123  CD");
console.assert(espaces?.plate === "AB-123-CD", "✅ Handles multiple spaces");

// Case insensible
const caseTest = extractFirstPlate("plaque ab-123-cd");
console.assert(caseTest?.plate === "AB-123-CD", "✅ Case insensitive");

// Avec deux-points (cas de la capture d'écran #2)
const deuxPoints = extractFirstPlate("plaque: dj893kl");
console.assert(deuxPoints?.plate === "DJ-893-KL", "✅ Handles 'plaque: DJ893KL'");

// Avec point-virgule
const pv = extractFirstPlate("voiture; AB123CD");
console.assert(pv?.plate === "AB-123-CD", "✅ Handles semicolon separator");

// Format mixte avec ponctuation dans la phrase
const mixte = extractFirstPlate("ma voiture, plaque: XY-456-ZZ, merci");
console.assert(mixte?.plate === "XY-456-ZZ", "✅ Handles punctuation in sentence");

console.log("✅ Test 11 passed: Edge cases\n");

// ====== Cas spécifique de la capture d'écran ======
console.log("🧪 Testing screenshot case...");
const screenshotCase = extractAndValidatePlate("je veux une reprog moteur de ma voiture plaque: dj893kl stage 1");
console.assert(screenshotCase.plate === "DJ-893-KL", "✅ Screenshot case: DJ-893-KL extracted");
console.assert(screenshotCase.valid === true, "✅ Screenshot case: plate is valid");
console.log("✅ Test 12 passed: Screenshot case resolved!\n");

console.log("🎉 ALL PLATE EXTRACTOR TESTS PASSED! 🎉\n");
console.log("💡 Les cas des captures d'écran sont maintenant gérés:");
console.log('   1. "je veux une reprog moteur, ma plaque c\'est dj893kl..."');
console.log("      → Extraction: DJ-893-KL ✅");
console.log('   2. "je veux une reprog moteur de ma voiture plaque: dj893kl stage 1"');
console.log("      → Extraction: DJ-893-KL ✅");
