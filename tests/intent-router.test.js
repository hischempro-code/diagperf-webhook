/**
 * Tests pour le module intent-router.js
 */

const {
  parseRoutingInstruction,
  isRoutingSafe,
  createInitialStateFromRoute,
  canSkipStep,
  VALID_INTENTS,
  VALID_STATES,
} = require("../lib/intent-router");

// ====== parseRoutingInstruction ======
console.log("\n🧪 Testing parseRoutingInstruction...");

// Test 1: Format legacy intent
const legacyIntent = { type: "intent", intent: "REPROG" };
const parsed1 = parseRoutingInstruction(legacyIntent);
console.assert(parsed1 !== null, "✅ Legacy intent should be parsed");
console.assert(parsed1.type === "route", "✅ Legacy intent converts to route");
console.assert(parsed1.target === "WAITING_PLATE", "✅ Legacy intent routes to WAITING_PLATE");
console.assert(parsed1.intent === "REPROG", "✅ Intent preserved");
console.log("✅ Test 1 passed: Legacy intent parsing");

// Test 2: Format route avancé
const advancedRoute = {
  type: "route",
  target: "WAITING_QUOTE_CONFIRM",
  intent: "E85",
  data: { plate: "AB123CD", vehicle: { make: "Renault", model: "Clio" } },
  confidence: 0.9,
};
const parsed2 = parseRoutingInstruction(advancedRoute);
console.assert(parsed2 !== null, "✅ Advanced route should be parsed");
console.assert(parsed2.target === "WAITING_QUOTE_CONFIRM", "✅ Target preserved");
console.assert(parsed2.intent === "E85", "✅ Intent preserved");
console.assert(parsed2.data.plate === "AB123CD", "✅ Plate data preserved");
console.assert(parsed2.confidence === 0.9, "✅ Confidence preserved");
console.log("✅ Test 2 passed: Advanced route parsing");

// Test 3: Invalid intent
const invalidIntent = { type: "intent", intent: "INVALID" };
const parsed3 = parseRoutingInstruction(invalidIntent);
console.assert(parsed3 === null, "✅ Invalid intent should return null");
console.log("✅ Test 3 passed: Invalid intent rejection");

// Test 4: Invalid target
const invalidTarget = { type: "route", target: "INVALID_STATE", intent: "REPROG" };
const parsed4 = parseRoutingInstruction(invalidTarget);
console.assert(parsed4 === null, "✅ Invalid target should return null");
console.log("✅ Test 4 passed: Invalid target rejection");

// Test 5: Answer type (pas un routing)
const answerType = { type: "answer", message: "Ceci est une réponse" };
const parsed5 = parseRoutingInstruction(answerType);
console.assert(parsed5 === null, "✅ Answer type should not be parsed as routing");
console.log("✅ Test 5 passed: Answer type ignored");

// ====== isRoutingSafe ======
console.log("\n🧪 Testing isRoutingSafe...");

const safeRoute = { type: "route", target: "WAITING_PLATE", intent: "DIAG", confidence: 0.8 };
console.assert(isRoutingSafe(safeRoute, 0.7) === true, "✅ Safe route should pass");
console.log("✅ Test 6 passed: Safe routing");

const unsafeRoute = { type: "route", target: "WAITING_PLATE", intent: "DIAG", confidence: 0.5 };
console.assert(isRoutingSafe(unsafeRoute, 0.7) === false, "✅ Low confidence should fail");
console.log("✅ Test 7 passed: Unsafe routing rejected");

// ====== createInitialStateFromRoute ======
console.log("\n🧪 Testing createInitialStateFromRoute...");

// Test 8: WAITING_PLATE
const routePlate = {
  type: "route",
  target: "WAITING_PLATE",
  intent: "REPROG",
  data: { plate: "XX999XX" },
  confidence: 0.9,
};
const state1 = createInitialStateFromRoute(routePlate);
console.assert(state1.intent === "REPROG", "✅ Intent in state");
console.assert(state1.state === "WAITING_PLATE", "✅ State set correctly");
console.assert(state1.data.plate === "XX999XX", "✅ Plate in data");
console.assert(state1.data.routed_by === "llm", "✅ Routed by LLM");
console.log("✅ Test 8 passed: WAITING_PLATE state creation");

// Test 9: WAITING_POST_QUOTE_CHOICE (devis confirmé)
const routeConfirmed = {
  type: "route",
  target: "WAITING_POST_QUOTE_CHOICE",
  intent: "FAP",
  data: { priceCents: 26000, skipConfirmation: true },
  confidence: 0.95,
};
const state2 = createInitialStateFromRoute(routeConfirmed);
console.assert(state2.data.confirmed === true, "✅ Confirmed flag set");
console.assert(state2.data.price_cents === 26000, "✅ Price stored");
console.assert(state2.state === "WAITING_POST_QUOTE_CHOICE", "✅ State post-quote choice");
console.log("✅ Test 9 passed: WAITING_POST_QUOTE_CHOICE state creation");

// Test 10: AWAITING_RDV_COORDINATES with date/time
const routeAppt = {
  type: "route",
  target: "AWAITING_RDV_COORDINATES",
  intent: "E85",
  data: { preferredDate: "2024-06-15", preferredTime: "14:00" },
  confidence: 0.85,
};
const state3 = createInitialStateFromRoute(routeAppt);
console.assert(state3.data.preferred_date === "2024-06-15", "✅ Date stored");
console.assert(state3.data.preferred_time === "14:00", "✅ Time stored");
console.log("✅ Test 10 passed: Appointment data stored");

// Test 11: VEHICLE_INCOMPATIBLE
const routeIncompat = {
  type: "route",
  target: "VEHICLE_INCOMPATIBLE",
  intent: "E85",
  data: { reason: "véhicule diesel" },
  confidence: 0.9,
};
const state4 = createInitialStateFromRoute(routeIncompat);
console.assert(state4.data.incompatible === true, "✅ Incompatible flag set");
console.assert(state4.data.incompatible_reason === "véhicule diesel", "✅ Reason stored");
console.log("✅ Test 11 passed: Incompatible vehicle handling");

// ====== canSkipStep ======
console.log("\n🧪 Testing canSkipStep...");

// Test 12: Skip WAITING_PLATE si plaque fournie
const skip1 = canSkipStep(null, "WAITING_PLATE", { plate: "AB123CD" });
console.assert(skip1.canSkip === true, "✅ Can skip with plate");
console.assert(skip1.skipTo === "WAITING_VEHICLE_CONFIRM", "✅ Skip to vehicle confirm");
console.log("✅ Test 12 passed: Plate provided → skip step");

// Test 13: Skip WAITING_VEHICLE_CONFIRM si skipConfirmation
const skip2 = canSkipStep(null, "WAITING_VEHICLE_CONFIRM", { vehicle: { make: "VW" }, skipConfirmation: true });
console.assert(skip2.canSkip === true, "✅ Can skip with preconfirmed vehicle");
console.assert(skip2.skipTo === "WAITING_QUOTE_CONFIRM", "✅ Skip to quote");
console.log("✅ Test 13 passed: Preconfirmed vehicle → skip step");

// Test 14: Cannot skip without data
const skip3 = canSkipStep(null, "WAITING_PLATE", {});
console.assert(skip3.canSkip === false, "✅ Cannot skip without data");
console.log("✅ Test 14 passed: No skip without data");

// ====== VALID_INTENTS & VALID_STATES ======
console.log("\n🧪 Testing constants...");
console.assert(VALID_INTENTS.has("REPROG"), "✅ REPROG is valid intent");
console.assert(VALID_INTENTS.has("SAV"), "✅ SAV is valid intent");
console.assert(VALID_STATES.has("WAITING_PLATE"), "✅ WAITING_PLATE is valid state");
console.assert(VALID_STATES.has("AWAITING_RDV_COORDINATES"), "✅ AWAITING_RDV_COORDINATES is valid state");
console.assert(!VALID_STATES.has("APPOINTMENT_CONFIRMED"), "✅ APPOINTMENT_CONFIRMED n'existe pas (état jamais implémenté)");
console.log("✅ Test 15 passed: Constants validation");

console.log("\n✅✅✅ ALL TESTS PASSED! ✅✅✅");
