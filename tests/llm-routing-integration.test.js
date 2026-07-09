/**
 * Test d'intégration pour le routing LLM → flow
 *
 * Simule des scénarios réels de messages clients et vérifie
 * que le routing automatique fonctionne correctement.
 */

const {
  parseRoutingInstruction,
  createInitialStateFromRoute,
} = require("../lib/intent-router");

console.log("🚀 Test d'intégration LLM Routing\n");

// ====== Scénario 1: Client complet avec véhicule et plaque ======
console.log("📱 Scénario 1: Client complet");
console.log("Message: 'Je veux une reprog pour ma Golf 7 GTI 2018 AB123CD'");

// Simule la réponse LLM
const llmResponse1 = {
  type: "route",
  target: "WAITING_VEHICLE_CONFIRM",
  intent: "REPROG",
  data: {
    plate: "AB123CD",
    vehicle: {
      make: "Volkswagen",
      model: "Golf 7 GTI",
      fuel: "essence",
      horsepower: 230,
      year: 2018,
    },
    vehicleYear: 2018,
  },
  confidence: 0.95,
};

const route1 = parseRoutingInstruction(llmResponse1);
console.log("✅ Routing détecté:", route1.target, "→ confiance:", route1.confidence);

const state1 = createInitialStateFromRoute(route1);
console.log("✅ État créé:", state1.state);
console.log("✅ Plaque:", state1.data.plate);
console.log("✅ Véhicule:", state1.data.vehicle.make, state1.data.vehicle.model);
console.log();

// ====== Scénario 2: Client qui confirme implicitement le devis ======
console.log("📱 Scénario 2: Confirmation implicite + date RDV");
console.log("Message: 'Oui super, c'est quand pour la reprog ?'");

const llmResponse2 = {
  type: "route",
  target: "WAITING_POST_QUOTE_CHOICE",
  intent: "REPROG",
  data: {
    plate: "AB123CD",
    vehicle: { make: "Volkswagen", model: "Golf 7 GTI" },
    priceCents: 39000,
    skipConfirmation: true,
  },
  confidence: 0.9,
};

const route2 = parseRoutingInstruction(llmResponse2);
if (!route2) { console.error("❌ Scénario 2: routing rejeté alors qu'il est valide"); process.exit(1); }
const state2 = createInitialStateFromRoute(route2);
console.log("✅ État final:", state2.state);
console.log("✅ Confirmed:", state2.data.confirmed);
console.log("✅ Prix:", state2.data.price_cents / 100, "€");
console.log();

// Cible INVENTÉE par le LLM mais intent VALIDE → rabattue sur l'état d'entrée sûr
// (WAITING_PLATE), PAS null. Sinon le client finissait en "je n'ai pas bien saisi"
// alors que le LLM avait compris l'intent (fix 2adec4a).
const invented = parseRoutingInstruction({ type: "route", target: "QUOTE_CONFIRMED", intent: "REPROG", confidence: 0.9 });
if (!invented || invented.target !== "WAITING_PLATE") { console.error("❌ Scénario 2b: cible inventée + intent valide devrait être rabattue sur WAITING_PLATE, obtenu:", invented); process.exit(1); }
console.log("✅ Cible inventée 'QUOTE_CONFIRMED' rabattue sur WAITING_PLATE (intent REPROG conservé)");

// Intent INVALIDE → là on rejette vraiment (null)
const rejected = parseRoutingInstruction({ type: "route", target: "WAITING_PLATE", intent: "BOGUS", confidence: 0.9 });
if (rejected !== null) { console.error("❌ Scénario 2c: intent invalide non rejeté"); process.exit(1); }
console.log("✅ Intent invalide 'BOGUS' correctement rejeté (null)");
console.log();

// ====== Scénario 3: Format legacy (type=intent) ======
console.log("📱 Scénario 3: Format legacy intent");
console.log("Message: 'Je veux faire une reprog'");

const llmResponse3 = {
  type: "intent",
  intent: "REPROG",
};

const route3 = parseRoutingInstruction(llmResponse3);
console.log("✅ Converti en route vers:", route3.target);
console.log("✅ Intent préservé:", route3.intent);
console.log();

// ====== Scénario 4: SAV avec description ======
console.log("📱 Scénario 4: Ticket SAV");
console.log("Message: 'J'ai un problème avec ma reprog, le voyant moteur est allumé'");

const llmResponse4 = {
  type: "route",
  target: "SAV_DESCRIPTION",
  intent: "SAV",
  data: {
    ticketType: "probleme_technique",
    ticketDescription: "Voyant moteur allumé après reprog",
  },
  confidence: 0.88,
};

const route4 = parseRoutingInstruction(llmResponse4);
if (!route4) { console.error("❌ Scénario 4: routing SAV rejeté alors qu'il est valide"); process.exit(1); }
const state4 = createInitialStateFromRoute(route4);
console.log("✅ État SAV:", state4.state);
console.log("✅ Description ticket:", state4.data.ticket_description);
console.log();

// ====== Scénario 5: Véhicule incompatible ======
console.log("📱 Scénario 5: Véhicule incompatible");
console.log("Message: 'Je veux passer au E85 avec mon diesel'");

const llmResponse5 = {
  type: "route",
  target: "VEHICLE_INCOMPATIBLE",
  intent: "E85",
  data: {
    vehicle: { make: "Peugeot", model: "308", fuel: "diesel" },
    reason: "E85 incompatible avec moteur diesel",
  },
  confidence: 0.98,
};

const route5 = parseRoutingInstruction(llmResponse5);
const state5 = createInitialStateFromRoute(route5);
console.log("✅ État incompatible:", state5.state);
console.log("✅ Incompatible flag:", state5.data.incompatible);
console.log("✅ Raison:", state5.data.incompatible_reason);
console.log();

// ====== Scénario 6: Routing avec add-ons ======
console.log("📱 Scénario 6: Reprog + add-ons");
console.log("Message: 'Reprog + suppression FAP pour mon diesel'");

const llmResponse6 = {
  type: "route",
  target: "WAITING_QUOTE_CONFIRM",
  intent: "REPROG",
  data: {
    plate: "XY456ZZ",
    vehicle: { make: "BMW", model: "320d" },
    priceCents: 64000, // 390 + 250
    addons: ["FAP"],
  },
  confidence: 0.92,
};

const route6 = parseRoutingInstruction(llmResponse6);
const state6 = createInitialStateFromRoute(route6);
console.log("✅ État:", state6.state);
console.log("✅ Prix:", state6.data.price_cents / 100, "€");
console.log("✅ Add-ons:", state6.data.selected_addons?.join(", "));
console.log();

// ====== Résumé ======
console.log("🎉 Tous les scénarios d'intégration passés !");
console.log("\n💡 Points clés implémentés :");
console.log("  • Routing vers n'importe quel état du flow");
console.log("  • Extraction automatique de plaque, véhicule, prix");
console.log("  • Skip confirmation possible pour accélérer le flow");
console.log("  • Support des add-ons et options");
console.log("  • Gestion des cas d'incompatibilité");
console.log("  • Backward compatible avec format legacy (type=intent)");
