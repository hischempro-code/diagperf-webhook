/**
 * Bug (09/07/2026, captures client) : depuis "Suppression AdBlue non applicable" sur une
 * Audi A4 diesel, cliquer "Reprog moteur" ou "Conversion E85" REDEMANDAIT la plaque
 * (flow relancé à zéro). + on proposait E85 (essence only) à un diesel.
 * Ce test pilote le vrai handler avec des mocks.
 */
const assert = require("assert");
const { createPrestationFlow } = require("../flows/prestation");
const { initVehicleService, validateIntentForVehicle } = require("../lib/vehicle-service");

let passed = 0, failed = 0;
function check(label, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✅ ${label}`); passed++; })
    .catch(e => { console.error(`  ❌ ${label} — ${e.message}`); failed++; });
}

const DIESEL_A4 = { make: "AUDI", model: "A4", fuel: "DIESEL", power_hp: 150, year: 2007 };
const STAGE_ROWS = [{
  stage: "stage1", moteur_slug: "2-0-tdi", puissance_origine: 150, puissance_apres: 190,
  gain_puissance: 40, couple_origine: 320, couple_apres: 400, gain_couple: 80, prix_centimes: null,
}];

// Supabase mock : reprog_moteurs → stages ; autres tables → vide
function mockSupabase() {
  const chain = (terminal) => {
    const q = {};
    ["select", "eq", "neq", "gte", "lte", "or", "ilike"].forEach(m => q[m] = () => q);
    q.order = () => Promise.resolve(terminal);
    q.single = async () => terminal;
    q.maybeSingle = async () => terminal;
    q.then = (res) => res(terminal);
    return q;
  };
  return { from: (t) => t === "reprog_moteurs" ? chain({ data: STAGE_ROWS, error: null }) : chain({ data: [], error: null }) };
}

// Construit le flow avec capture des envois + états
function makeFlow() {
  const sent = [];       // messages texte/boutons envoyés
  const states = [];     // setConversationState({state,intent})
  let menuShown = false;
  const noop = () => {};
  const asyncNoop = async () => {};
  const supa = mockSupabase();
  initVehicleService({ supabase: supa, log: { info: noop, warn: noop, error: noop, debug: noop }, fetchFn: noop });

  const ctx = {
    supabase: supa,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    sendWhatsAppText: async (to, body) => { sent.push(String(body)); },
    sendWhatsAppInteractiveButtons: async (to, body, buttons) => { sent.push(String(body) + " ||BTNS:" + JSON.stringify(buttons)); },
    sendWhatsAppList: async (to, body) => { sent.push(String(body)); },
    sendWhatsAppImage: asyncNoop, sendWhatsAppVideo: asyncNoop, sendWhatsAppLocation: asyncNoop,
    setConversationState: async (waId, state, intent) => { states.push({ state, intent }); },
    clearConversationState: asyncNoop,
    getConversationState: async () => makeFlow._state,
    sendMenuList: async () => { menuShown = true; },
    notifyGarage: asyncNoop, broadcastDashboardEvent: noop,
    respondOrAnswerQuestion: asyncNoop, askLLM: async () => null,
    sendQuotePdf: asyncNoop, buildGainsChartUrl: noop, buildVehicleCardUrl: noop,
    buildPrestationCardUrl: noop, renderStageGainsVideo: asyncNoop, getVehicleImageUrl: noop,
    buildTravelEstimateMessage: asyncNoop, extractAndValidatePlate: () => ({ valid: false }),
    DIAGPERF_LOCATION: {}, sendRdvClientEmail: asyncNoop, sendRdvDiagperfEmail: asyncNoop, sendContactRecapEmail: asyncNoop,
  };
  const { handlePrestationFlow } = createPrestationFlow(ctx);
  return { handlePrestationFlow, sent, states, menu: () => menuShown };
}

const btnMsg = (id, title) => ({ type: "interactive", interactive: { button_reply: { id, title } } });
const hasPlatePrompt = (sent) => sent.some(m => /plaque|immatriculation/i.test(m));

(async () => {
  console.log("🧪 Prémisse du filtre (validateIntentForVehicle)");
  await check("E85 sur diesel → incompatible (objet)", () => assert.ok(validateIntentForVehicle("E85", DIESEL_A4)));
  await check("REPROG sur diesel → compatible (null)", () => assert.strictEqual(validateIntentForVehicle("REPROG", DIESEL_A4), null));

  console.log("🧪 Bascule 'Reprog moteur' depuis AdBlue incompatible");
  {
    const f = makeFlow();
    makeFlow._state = { state: "VEHICLE_INCOMPATIBLE", intent: "ADBLUE", data: { plate: "EX-919-ZD", vehicle: DIESEL_A4, originalIntent: "ADBLUE" } };
    await f.handlePrestationFlow("33600000000", "🏎️ Reprog moteur", btnMsg("vehicle_incompat_reprog", "Reprog moteur"));
    await check("ne redemande PAS la plaque", () => assert.ok(!hasPlatePrompt(f.sent), "un prompt plaque a été envoyé : " + f.sent.join(" | ")));
    await check("passe en WAITING_STAGE_CHOICE / REPROG (véhicule conservé)", () =>
      assert.ok(f.states.some(s => s.state === "WAITING_STAGE_CHOICE" && s.intent === "REPROG"), "états: " + JSON.stringify(f.states)));
    await check("ne retombe pas au menu", () => assert.ok(!f.menu()));
  }

  console.log("🧪 Bascule 'Conversion E85' sur un diesel → re-rejet propre, sans re-saisie plaque");
  {
    const f = makeFlow();
    makeFlow._state = { state: "VEHICLE_INCOMPATIBLE", intent: "ADBLUE", data: { plate: "EX-919-ZD", vehicle: DIESEL_A4, originalIntent: "ADBLUE" } };
    await f.handlePrestationFlow("33600000000", "🌿 Conversion E85", btnMsg("vehicle_incompat_e85", "Conversion E85"));
    await check("ne redemande PAS la plaque", () => assert.ok(!hasPlatePrompt(f.sent), "sent: " + f.sent.join(" | ")));
    await check("E85 re-rejeté (message 'non compatible')", () => assert.ok(f.sent.some(m => /non compatible|non applicable/i.test(m))));
    await check("état repasse VEHICLE_INCOMPATIBLE/E85", () => assert.ok(f.states.some(s => s.state === "VEHICLE_INCOMPATIBLE" && s.intent === "E85")));
  }

  console.log("🧪 Écran incompat AdBlue (diesel) : plus de bouton E85 proposé");
  {
    const f = makeFlow();
    makeFlow._state = { state: "WAITING_VEHICLE_CONFIRM", intent: "ADBLUE", data: { plate: "EX-919-ZD", vehicle: DIESEL_A4 } };
    await f.handlePrestationFlow("33600000000", "oui", btnMsg("confirm_vehicle_yes", "Oui"));
    await check("boutons alternatives sans 'Conversion E85'", () => {
      const incompatMsg = f.sent.find(m => /non applicable|non compatible/i.test(m)) || "";
      assert.ok(!/vehicle_incompat_e85/.test(incompatMsg), "E85 encore proposé à un diesel: " + incompatMsg);
    });
    await check("bascule Reprog toujours proposée", () => {
      const incompatMsg = f.sent.find(m => /non applicable|non compatible/i.test(m)) || "";
      assert.ok(/vehicle_incompat_reprog/.test(incompatMsg));
    });
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
  process.exit(failed === 0 ? 0 : 1);
})();
