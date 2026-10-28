/**
 * Prestation « Installation CarPlay » (ajout 28/10/2026) : toujours sur DEVIS PERSONNALISÉ.
 * Le prix dépend de la pièce (module compatible avec le véhicule) + main-d'œuvre, donc le
 * bot ne doit JAMAIS afficher de prix ni créer de devis chiffré — mais il collecte la
 * plaque (le garage en a besoin pour chiffrer), puis les coordonnées, et notifie le garage.
 *
 * Pilote le vrai flow ; seuls WhatsApp, Supabase et l'API plaques sont simulés.
 */
const assert = require("assert");

// Stub de l'API plaques AVANT de charger le flow (il destructure l'export au require).
const vehicleService = require("../lib/vehicle-service");
const PEUGEOT_208 = { make: "PEUGEOT", model: "208", fuel: "ESSENCE", power_hp: 82, year: 2016, engine_cc: 1199 };
const TESLA_3 = { make: "TESLA", model: "MODEL 3", fuel: "ELECTRIQUE", power_hp: 283, year: 2021 };
vehicleService.lookupVehicleFromPlate = async () => PEUGEOT_208;

const { createPrestationFlow } = require("../flows/prestation");

let passed = 0, failed = 0;
function check(label, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✅ ${label}`); passed++; })
    .catch(e => { console.error(`  ❌ ${label} — ${e.message}`); failed++; });
}

function mockSupabase() {
  const chain = (terminal) => {
    const q = {};
    ["select", "eq", "neq", "gte", "lte", "or", "ilike", "insert", "update", "upsert"].forEach(m => q[m] = () => q);
    q.order = () => Promise.resolve(terminal);
    q.single = async () => terminal;
    q.maybeSingle = async () => terminal;
    q.then = (res) => res(terminal);
    return q;
  };
  return { from: () => chain({ data: [], error: null }) };
}

function makeFlow(initialState) {
  const sent = [];
  const states = [];
  const garage = [];
  const recapEmails = [];
  let current = initialState;
  const noop = () => {};
  const asyncNoop = async () => {};
  const supa = mockSupabase();
  vehicleService.initVehicleService({ supabase: supa, log: { info: noop, warn: noop, error: noop, debug: noop }, fetchFn: noop });

  const ctx = {
    supabase: supa,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    sendWhatsAppText: async (to, body) => { sent.push(String(body)); },
    sendWhatsAppInteractiveButtons: async (to, body, buttons) => { sent.push(String(body) + " ||BTNS:" + JSON.stringify(buttons)); },
    sendWhatsAppList: async (to, body) => { sent.push(String(body)); },
    sendWhatsAppImage: asyncNoop, sendWhatsAppVideo: asyncNoop, sendWhatsAppLocation: asyncNoop,
    setConversationState: async (waId, state, intent, data) => {
      states.push({ state, intent, data: data || {} });
      current = { state, intent, data: data || {} };
    },
    clearConversationState: async () => { current = null; },
    getConversationState: async () => current,
    sendMenuList: asyncNoop,
    notifyGarage: async (msg) => { garage.push(String(msg)); },
    broadcastDashboardEvent: noop,
    respondOrAnswerQuestion: async (to, text, prompt) => { sent.push(String(prompt)); return true; },
    askLLM: async () => null,
    sendQuotePdf: asyncNoop, buildGainsChartUrl: noop, buildVehicleCardUrl: noop,
    buildPrestationCardUrl: noop, renderStageGainsVideo: asyncNoop, getVehicleImageUrl: noop,
    buildTravelEstimateMessage: asyncNoop,
    extractAndValidatePlate: (t) => (/AB-?123-?CD/i.test(t) ? { valid: true, plate: "AB-123-CD" } : { valid: false }),
    DIAGPERF_LOCATION: {}, sendRdvClientEmail: asyncNoop, sendRdvDiagperfEmail: asyncNoop,
    sendContactRecapEmail: async (payload) => { recapEmails.push(payload); },
  };
  const { handlePrestationFlow } = createPrestationFlow(ctx);
  const say = (text, rawMsg = {}) => handlePrestationFlow("33600000000", text, rawMsg);
  return { say, sent, states, garage, recapEmails, state: () => current };
}

const btn = (id, title) => ({ type: "interactive", interactive: { button_reply: { id, title } } });
const PRICE_RE = /\d+(?:[.,]\d+)?\s?€/;

(async () => {
  console.log("🧪 Parcours complet CarPlay : menu → plaque → véhicule → devis personnalisé");
  {
    const f = makeFlow(null);

    // 1. Choix « Installation CarPlay » dans la liste (le webhook traduit menu_9 → "9")
    await f.say("9");
    await check("menu 9 → état WAITING_PLATE / CARPLAY", () =>
      assert.deepStrictEqual([f.state().state, f.state().intent], ["WAITING_PLATE", "CARPLAY"]));
    await check("demande la plaque en expliquant pourquoi (module selon le modèle)", () => {
      const m = f.sent.at(-1);
      assert.ok(/Installation CarPlay/.test(m) && /plaque/i.test(m) && /module CarPlay/i.test(m), m);
    });

    // 2. Plaque → fiche véhicule simple (pas la fiche Stage 1 / E85)
    f.sent.length = 0;
    await f.say("AB-123-CD");
    const card = f.sent.find(m => /Est-ce bien votre véhicule/.test(m)) || "";
    await check("véhicule identifié et confirmation demandée", () => assert.ok(/PEUGEOT 208/.test(card), f.sent.join(" | ")));
    await check("fiche SANS argumentaire Stage 1 / E85 / prix", () => {
      assert.ok(!/Stage 1|E85|FAP|€/.test(card), card);
    });
    await check("état WAITING_VEHICLE_CONFIRM / CARPLAY", () =>
      assert.deepStrictEqual([f.state().state, f.state().intent], ["WAITING_VEHICLE_CONFIRM", "CARPLAY"]));

    // 3. Confirmation → devis personnalisé, aucun prix, aucun devis chiffré
    f.sent.length = 0;
    await f.say("✅ Oui, c'est bon", btn("confirm_vehicle_yes", "Oui"));
    const quoteMsg = f.sent.at(-1) || "";
    await check("annonce « Sur devis personnalisé » avec la raison (pièce + main-d'œuvre)", () => {
      assert.ok(/Sur devis personnalisé/.test(quoteMsg), quoteMsg);
      assert.ok(/pièce/.test(quoteMsg) && /main-d'œuvre/.test(quoteMsg), quoteMsg);
    });
    await check("AUCUN prix affiché ni « Devis généré »", () => {
      assert.ok(!f.sent.some(m => /Devis généré/.test(m)), "un devis chiffré a été généré");
      assert.ok(!PRICE_RE.test(quoteMsg), "prix trouvé : " + quoteMsg);
    });
    await check("état WAITING_COORDINATES, véhicule conservé", () => {
      assert.strictEqual(f.state().state, "WAITING_COORDINATES");
      assert.strictEqual(f.state().data.plate, "AB-123-CD");
      assert.strictEqual(f.state().data.vehicle.model, "208");
    });

    // 4. Coordonnées → garage notifié avec tout ce qu'il faut pour chiffrer
    f.sent.length = 0;
    await f.say("Dupont Jean jean.dupont@gmail.com");
    const notif = f.garage.at(-1) || "";
    await check("garage notifié : prestation, véhicule, plaque, contact", () => {
      assert.ok(/Installation CarPlay \(sur devis personnalisé\)/.test(notif), notif);
      assert.ok(/PEUGEOT 208/.test(notif) && /AB-123-CD/.test(notif) && /jean\.dupont@gmail\.com/.test(notif), notif);
    });
    await check("email récap envoyé au garage", () =>
      assert.ok(f.recapEmails.some(e => /Installation CarPlay/.test(e.prestation) && e.plate === "AB-123-CD")));
    await check("client remercié, demande enregistrée", () =>
      assert.ok(/demande de devis personnalisé est enregistrée/.test(f.sent.at(-1) || ""), f.sent.join(" | ")));
    await check("conversation clôturée", () => assert.strictEqual(f.state(), null));
  }

  console.log("🧪 Plaque donnée dès le premier message");
  {
    const f = makeFlow(null);
    await f.say("je voudrais installer un carplay sur ma voiture AB-123-CD");
    await check("saute la demande de plaque → confirmation véhicule", () =>
      assert.deepStrictEqual([f.state().state, f.state().intent], ["WAITING_VEHICLE_CONFIRM", "CARPLAY"]));
  }

  console.log("🧪 Véhicule électrique : CarPlay reste possible (pas de refus « incompatible »)");
  {
    const f = makeFlow({ state: "WAITING_VEHICLE_CONFIRM", intent: "CARPLAY", data: { plate: "AB-123-CD", vehicle: TESLA_3 } });
    await f.say("oui", btn("confirm_vehicle_yes", "Oui"));
    await check("pas de message d'incompatibilité", () =>
      assert.ok(!f.sent.some(m => /non compatible|non applicable/i.test(m)), f.sent.join(" | ")));
    await check("passe en devis personnalisé", () => assert.strictEqual(f.state().state, "WAITING_COORDINATES"));
  }

  console.log("🧪 Bascule vers CarPlay en gardant le véhicule (depuis un refus d'incompatibilité)");
  {
    const f = makeFlow({ state: "VEHICLE_INCOMPATIBLE", intent: "FAP", data: { plate: "AB-123-CD", vehicle: PEUGEOT_208, originalIntent: "FAP" } });
    await f.say("finalement je veux juste le carplay");
    await check("ne redemande PAS la plaque", () =>
      assert.ok(!f.sent.some(m => /envoyez votre plaque|Veuillez envoyer votre plaque/i.test(m)), f.sent.join(" | ")));
    await check("arrive directement en devis personnalisé CarPlay", () =>
      assert.deepStrictEqual([f.state().state, f.state().intent], ["WAITING_COORDINATES", "CARPLAY"]));
  }

  console.log(`\n${"═".repeat(40)}`);
  console.log(`Résultat CarPlay : ${passed} ✅ / ${failed} ❌`);
  if (failed > 0) process.exit(1);
})();
