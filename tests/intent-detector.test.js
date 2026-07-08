/**
 * Tests anti-régression du routage d'intent (lib/intent-detector.js — le VRAI module
 * de prod, pas la copie de helpers.js).
 *
 * Jeu de données étiqueté : chaque cas est une phrase client réaliste + l'intent attendu.
 * Règle d'or anti-overfitting : on ne rajoute PAS un mot-clé/une regex pour faire passer
 * UN cas isolé — un cas ambigu doit retourner null (→ le LLM+RAG décide avec l'historique).
 *
 * Rappel métier :
 *   SAV  = client EXISTANT (problème lié à une prestation DiagPerf déjà réalisée)
 *   DIAG = prospect avec un symptôme/voyant → prestation diagnostic
 *   null = ambigu/question → LLM + RAG
 */

const assert = require("assert");
const { detectIntent } = require("../lib/intent-detector");

let passed = 0;
let failed = 0;

function expectIntent(message, expected, label) {
  const got = detectIntent(message);
  const name = label || `"${message.slice(0, 60)}" → ${expected}`;
  try {
    assert.strictEqual(got, expected);
    passed++;
    console.log(`  ✅ ${name}`);
  } catch {
    failed++;
    console.error(`  ❌ ${name} (obtenu: ${got})`);
  }
}

// ====== BUG PROD (screenshot 2026-07-08) : prospect avec voyant → DIAG, pas SAV ======
console.log("\n🐛 Régression : prospect avec symptôme ≠ SAV");
expectIntent("J'ai un problème avec ma voiture\nJ'ai un voyant moteur allumé", "DIAG", "message exact du screenshot → DIAG");
expectIntent("j'ai un voyant moteur allumé", "DIAG");
expectIntent("voyant moteur allumé depuis ce matin", "DIAG");
expectIntent("bonjour j'ai un problème, le voyant moteur s'est allumé", "DIAG");
expectIntent("check engine allumé sur ma golf", "DIAG");
expectIntent("j'ai un code défaut P0420", "DIAG");
expectIntent("recherche de panne", "DIAG");

// ====== SAV : problème rattaché à une prestation DiagPerf réalisée ======
console.log("\n🛠️ SAV : client existant");
expectIntent("j'ai un problème avec ma reprog", "SAV");
expectIntent("depuis la reprog j'ai un voyant qui s'allume", "SAV");
expectIntent("suite à votre intervention la voiture ne démarre plus", "SAV");
expectIntent("après la conversion e85 j'ai des soucis de démarrage", "SAV");
expectIntent("ma conversion déconne", "SAV");
expectIntent("problème depuis la suppression FAP", "SAV");
expectIntent("je veux faire une réclamation", "SAV");
expectIntent("je ne suis pas satisfait de la prestation", "SAV");
expectIntent("sav", "SAV");

// ====== Plainte générique SANS lien prestation → null (le LLM gère) ======
console.log("\n🤖 Ambigu → null (LLM + RAG décident)");
expectIntent("ma voiture est en panne", null);
expectIntent("j'ai un souci avec ma clio", null);
expectIntent("j'ai un problème avec ma voiture", null);
expectIntent("ça ne marche plus", null);

// ====== Questions → null (jamais de flow lancé sur une question) ======
console.log("\n❓ Questions → null");
expectIntent("la reprog c'est fiable ?", null);
expectIntent("combien coûte une conversion e85", null);
expectIntent("c'est quoi le stage 1 ?", null);
expectIntent("quelle garantie sur le fap ?", null);
expectIntent("le prix d'un diagnostic", null);

// ====== Prestations (prospect, demande claire) ======
console.log("\n🏎️ Prestations");
expectIntent("je veux une reprogrammation", "REPROG");
expectIntent("stage 1 pour ma golf", "REPROG");
expectIntent("conversion e85", "E85");
expectIntent("je veux rouler à l'éthanol", "E85");
expectIntent("suppression fap", "FAP");
expectIntent("le fap est bouché", "FAP");
expectIntent("problème de fap", "FAP", "'problème de fap' (composant, pas prestation réalisée) → FAP");
expectIntent("vanne egr", "EGR");
expectIntent("suppression adblue", "ADBLUE");

// ====== Numéros de menu ======
console.log("\n🔢 Menu 1-8");
expectIntent("1", "REPROG");
expectIntent("2", "E85");
expectIntent("3", "FAP");
expectIntent("4", "EGR");
expectIntent("5", "ADBLUE");
expectIntent("6", "DIAG");
expectIntent("7", "AUTRES");
expectIntent("8", "SAV");

// ====== Le nom du garage ne déclenche pas DIAG ======
console.log("\n🏷️ Marque");
expectIntent("bonjour DiagPerf", null, "'bonjour DiagPerf' ne matche pas le mot-clé 'diag'");
expectIntent("merci diagperf", null);

// ====== Résumé ======
console.log(`\n${"═".repeat(40)}`);
console.log(`Résultat : ${passed} ✅ / ${failed} ❌`);
if (failed > 0) process.exit(1);
console.log("Tous les tests intent-detector passent ✨");
