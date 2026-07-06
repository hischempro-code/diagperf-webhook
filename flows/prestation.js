const { extractInteractiveId, validatePlate, validateEmail, isConfirmation, isDenial, extractContactFromText } = require("../lib/text-helpers");
const { detectIntent, intentToPrestationCode, intentToLabel } = require("../lib/intent-detector");
const { isLikelyQuestion } = require("../lib/llm-service");
const {
  formatStageLabel,
  lookupReprogStages,
  lookupVehicleFromPlate,
  STAGE1_FIXED_PRICE_CENTS,
  TTC_INTENTS,
  CUSTOM_QUOTE_STAGES,
  computeReprogPrice,
  computeE85Price,
  computeAdbluePrice,
  computeEgrPrice,
  computeFapPrice,
  INTENT_VEHICLE_REQUIREMENTS,
  validateIntentForVehicle,
  getUpsellOptionsForVehicle,
  buildUpsellMessage,
  buildVehicleOnlyText,
} = require("../lib/vehicle-service");
const {
  buildVehiclePerformanceCard,
  buildAnalysisStartMessage,
  buildAnalysisProgressMessage,
} = require("../lib/vehicle-card");
const {
  getPrestationTarif,
  createDevis,
  addUpsellOptionsToDevis,
} = require("../lib/devis-service");

// ====== Universal info accumulator ======
// Extracts name/email/plate/stage from any message and merges into state data silently.
// Returns the same object reference if nothing changed (cheap !== check).
function accumulateInfoIntoState(text, stateData, _extractAndValidatePlate) {
  const { email, name } = extractContactFromText(text);
  const prev = stateData || {};
  const next = { ...prev };
  if (email && !next._known_email) next._known_email = email;
  if (name && !next._known_name) next._known_name = name;
  if (!next._known_plate && _extractAndValidatePlate) {
    const ex = _extractAndValidatePlate(text);
    if (ex?.valid && ex?.plate) next._known_plate = ex.plate;
  }
  if (!next._known_stage_num) {
    const stageMatch = String(text || "").match(/\bstage\s*(\d+)\b/i);
    if (stageMatch) next._known_stage_num = parseInt(stageMatch[1], 10);
  }
  const changed = next._known_email !== prev._known_email
    || next._known_name !== prev._known_name
    || next._known_plate !== prev._known_plate
    || next._known_stage_num !== prev._known_stage_num;
  return changed ? next : prev;
}

// Picks only accumulated _known_* fields from state data, for forwarding across transitions.
function pickKnown(data) {
  const d = data || {};
  const k = {};
  if (d._known_email) k._known_email = d._known_email;
  if (d._known_name) k._known_name = d._known_name;
  if (d._known_plate) k._known_plate = d._known_plate;
  if (d._known_stage_num) k._known_stage_num = d._known_stage_num;
  return k;
}

// Builds the "please provide your contact" message asking ONLY for what is still missing.
function buildContactRequestMsg(stateData, prefix) {
  const d = stateData || {};
  const hasName = !!(d._known_name || d.saved_customer_name);
  const hasEmail = !!(validateEmail(d._known_email || "") || validateEmail(d.saved_customer_email || ""));
  const p = prefix !== undefined ? prefix : "Parfait ! 🎉\n\n";
  if (hasName && !hasEmail) return `${p}Pour finaliser, merci d'envoyer votre adresse email :\n(ex: jean.dupont@gmail.com)`;
  if (!hasName && hasEmail) return `${p}Pour finaliser, merci d'indiquer votre nom complet :\n(ex: Dupont Jean)`;
  return `${p}Pour finaliser et recevoir votre devis en PDF, merci d'envoyer vos coordonnées :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`;
}

// Resolves customer name+email from all available sources, merging known fields with current text.
function resolveContactFromState(stateData, text) {
  const d = stateData || {};
  let customerName = d.saved_customer_name || d._known_name || null;
  let customerEmail = (validateEmail(d.saved_customer_email || "") ? d.saved_customer_email : null)
                   || (validateEmail(d._known_email || "") ? d._known_email : null);

  if (!customerName || !customerEmail) {
    const raw = String(text || "").trim();
    const words = raw.split(/[\s\n]+/);
    if (!customerEmail) {
      const emailWord = words.find(w => w.includes("@"));
      if (emailWord) customerEmail = validateEmail(emailWord) ? emailWord.toLowerCase() : null;
    }
    if (!customerName) {
      const { name: parsedName } = extractContactFromText(raw);
      customerName = parsedName || words.filter(w => !w.includes("@")).join(" ").trim() || null;
    }
  }
  return { customerName: customerName || "", customerEmail: customerEmail || "" };
}

// ====== Constants ======
const PRESTATION_INTENTS = new Set(["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES"]);
const MANUAL_QUOTE_INTENTS = new Set(["AUTRES"]);

const DIAG_OPTIONS = [
  { id: "diag_1", title: "Diagnostic simple", description: "Lecture & effacement défauts", detail: "Lecture et effacement des codes défaut", priceTtcCents: 5000, duration: "20 min" },
  { id: "diag_2", title: "Diag approfondi", description: "Interprétation + remise à zéro", detail: "Lecture, interprétation des défauts et remise à zéros des compteurs", priceTtcCents: 8000, duration: "35 min" },
  { id: "diag_3", title: "Recherche de panne", description: "Diag, test, analyse données", detail: "Recherche de panne électrique (diagnostic, test, analyse de données)", priceTtcCents: 13000, duration: "1h" },
];

const STAGE1_PRICE_LABEL = `${STAGE1_FIXED_PRICE_CENTS / 100}€`;
const STAGE1_PRICE_LABEL_TTC = `${STAGE1_FIXED_PRICE_CENTS / 100}€ TTC`;

/**
 * Factory: creates the prestation flow handler.
 * @param {object} ctx - All dependencies from server.js
 */
function createPrestationFlow(ctx) {
  const {
    supabase, log,
    sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppList,
    sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppLocation,
    setConversationState, clearConversationState, getConversationState,
    sendMenuList, notifyGarage, broadcastDashboardEvent,
    respondOrAnswerQuestion, askLLM,
    sendQuotePdf, buildGainsChartUrl, buildVehicleCardUrl,
    buildPrestationCardUrl, renderStageGainsVideo, getVehicleImageUrl,
    buildTravelEstimateMessage, extractAndValidatePlate,
    DIAGPERF_LOCATION,
    sendRdvClientEmail, sendRdvDiagperfEmail, sendContactRecapEmail,
  } = ctx;

  // ====== Shared stage selection builder ======
  async function buildAndSendStageSelection(fromWa, vehicle, plate, stages, intentOverride, prevStateData) {
    const maxDisplay = 4;
    const displayStages = stages.slice(0, maxDisplay);
    const firstRow = displayStages[0];
    const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
    const motorDesc = firstRow.moteur_slug
      ? firstRow.moteur_slug.replace(/-/g, " ").toUpperCase() + ` ${firstRow.puissance_origine}ch | ${firstRow.couple_origine} Nm`
      : `${vehicle.power_hp || "?"}ch`;

    let stageLines = "";
    displayStages.forEach((s, i) => {
      const stageLabel = formatStageLabel(s.stage);
      const prixTxt = CUSTOM_QUOTE_STAGES.has(s.stage)
        ? "Sur devis personnalisé"
        : (s.stage === "stage1" ? STAGE1_PRICE_LABEL_TTC : (typeof s.prix_centimes === "number" ? `${(s.prix_centimes / 100).toFixed(0)}€ TTC` : "Sur devis personnalisé"));
      stageLines +=
        `\n*${i + 1})* ${stageLabel} — ${prixTxt}\n` +
        `   ⚡ Puissance : ${s.puissance_origine} → ${s.puissance_apres} ch (+${s.gain_puissance} ch)\n` +
        `   🔧 Couple : ${s.couple_origine} → ${s.couple_apres} Nm (+${s.gain_couple} Nm)\n`;
    });

    const stageButtons = displayStages.slice(0, 3).map((s, i) => {
      const btnLabel = formatStageLabel(s.stage);
      const btnPrix = CUSTOM_QUOTE_STAGES.has(s.stage)
        ? "Devis"
        : (s.stage === "stage1" ? STAGE1_PRICE_LABEL : (typeof s.prix_centimes === "number" ? `${(s.prix_centimes / 100).toFixed(0)}€` : "Devis"));
      return { id: `stage_choice_${i + 1}`, title: `${btnLabel} — ${btnPrix}`.slice(0, 20) };
    });

    if (stageButtons.length < 3) {
      stageButtons.push({ id: "btn_back_menu", title: "🏠 Menu" });
    }

    let msg =
      `🏎️ *Reprogrammation moteur — ${vehicleName}*\n` +
      `Moteur : ${motorDesc}\n\n` +
      `Stages disponibles :\n` +
      stageLines;

    if (displayStages.length > 3) {
      msg += `\nPour d'autres options, tapez le numéro du stage.`;
    }
    if (msg.length > 4000) {
      log.warn("Stage message too long, truncating", { len: msg.length, stages: displayStages.length });
      msg = msg.slice(0, 3950) + (displayStages.length > 3 ? `\n\n… Pour d'autres options, tapez le numéro.` : "");
    }

    const intent = intentOverride || "REPROG";
    await setConversationState(fromWa, "WAITING_STAGE_CHOICE", intent, { ...pickKnown(prevStateData), plate, vehicle, stages: displayStages });
    await sendWhatsAppInteractiveButtons(fromWa, msg, stageButtons);
    return displayStages;
  }

  // ====== State Handler Registry ======
  const PRESTATION_STATE_HANDLERS = {};
  function registerPrestationState(stateName, handlerFn) {
    PRESTATION_STATE_HANDLERS[stateName] = handlerFn;
  }

  async function dispatchPrestationState(fromWa, text, rawMsg, convState, intent, buttonId) {
    const handler = PRESTATION_STATE_HANDLERS[convState.state];
    if (!handler) {
      log.warn("No handler registered for state", { state: convState.state, wa_id: fromWa });
      return false;
    }
    return handler(fromWa, text, rawMsg, convState, intent, buttonId);
  }

  // ====== Handler: No state (intent detection) ======
  async function handleNoState(fromWa, text, rawMsg, convState, intent, buttonId) {
    const detected = detectIntent(text);
    if (!detected || !PRESTATION_INTENTS.has(detected)) return false;

    // Si un keyword de prestation est détecté MAIS que le message est une question
    // (ex: "la reprog c'est fiable ?", "je veux savoir si le stage 1 est adapté"),
    // on laisse le LLM répondre plutôt que de lancer le flow.
    if (isLikelyQuestion(text)) return false;

    const label = intentToLabel(detected);

    if (detected === "DIAG") {
      await setConversationState(fromWa, "DIAG_CHOOSE", "DIAG", {});
      await sendWhatsAppList(
        fromWa,
        "🔍 Diagnostic complet\n\nChoisissez le type de diagnostic souhaité :",
        "🔍 Voir les options",
        [{ title: "Nos diagnostics", rows: DIAG_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: `${opt.description} — ${(opt.priceTtcCents / 100).toFixed(0)}€ TTC` })) }]
      );
      log.info("DIAG flow → sous-menu affiché", { wa_id: fromWa });
      return true;
    }

    if (MANUAL_QUOTE_INTENTS.has(detected)) {
      await setConversationState(fromWa, "WAITING_CONTACT_MANUAL", detected, {});
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `${label} ✅\n\nCette prestation nécessite une étude personnalisée.\nVeuillez envoyer votre email pour être recontacté (ex: prenom@mail.com).`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Prestation flow → devis personnalisé direct", { wa_id: fromWa, intent: detected });
      return true;
    }

    const plateExtraction = extractAndValidatePlate(text);
    if (plateExtraction.plate && plateExtraction.valid) {
      try {
        const vehicle = await lookupVehicleFromPlate(plateExtraction.plate);

        const initContact = extractContactFromText(text);

        // Si REPROG et stage mentionné dans le message initial → skip direct au devis
        if (detected === "REPROG") {
          const stageMatch = text.match(/stage\s*(\d+)/i);
          if (stageMatch) {
            try {
              const incompat = validateIntentForVehicle(detected, vehicle);
              if (!incompat) {
                const stages = await lookupReprogStages(vehicle);
                const stageNum = parseInt(stageMatch[1], 10);
                if (stages.length > 0 && stageNum >= 1 && stageNum <= stages.length) {
                  const initKnown = {
                    plate: plateExtraction.plate, vehicle, stages, _known_stage_num: stageNum,
                    ...(initContact.email ? { _known_email: initContact.email } : {}),
                    ...(initContact.name ? { _known_name: initContact.name } : {}),
                  };
                  log.info("Prestation flow → plaque + stage détectés, skip direct au devis", { wa_id: fromWa, intent: detected, plate: plateExtraction.plate, stage: stageNum });
                  const fakeConvState = { state: "WAITING_STAGE_CHOICE", intent: detected, data: initKnown };
                  await setConversationState(fromWa, "WAITING_STAGE_CHOICE", detected, initKnown);
                  return handleLegacyPrestationStates(fromWa, String(stageNum), rawMsg, fakeConvState, detected, null);
                }
              }
            } catch (stageErr) {
              log.warn("Stage skip échoué, fallback confirmation véhicule", { wa_id: fromWa, error: String(stageErr?.message || stageErr) });
            }
          }
        }

        const initData = { plate: plateExtraction.plate, vehicle,
          ...(initContact.email ? { _known_email: initContact.email } : {}),
          ...(initContact.name ? { _known_name: initContact.name } : {}),
        };
        await setConversationState(fromWa, "WAITING_VEHICLE_CONFIRM", detected, initData);
        log.info("Prestation flow → plaque détectée dans message initial, skip à confirmation", { wa_id: fromWa, intent: detected, plate: plateExtraction.plate });
        await sendWhatsAppInteractiveButtons(fromWa, buildVehicleOnlyText(vehicle), [
          { id: "confirm_vehicle_yes", title: "✅ Oui, c'est bon" },
          { id: "confirm_vehicle_no", title: "❌ Non" },
          { id: "btn_back_menu", title: "🏠 Menu" },
        ]);
        return true;
      } catch (vehicleErr) {
        log.warn("Lookup véhicule échoué, fallback WAITING_PLATE", { wa_id: fromWa, plate: plateExtraction.plate, error: String(vehicleErr?.message || vehicleErr) });
      }
    }

    const initContact2 = extractContactFromText(text);
    const initData2 = {
      ...(initContact2.email ? { _known_email: initContact2.email } : {}),
      ...(initContact2.name ? { _known_name: initContact2.name } : {}),
    };
    await setConversationState(fromWa, "WAITING_PLATE", detected, initData2);
    await sendWhatsAppInteractiveButtons(fromWa, `${label} ✅\nVeuillez envoyer votre plaque d'immatriculation (ex: AA 123 BB).`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
    log.info("Prestation flow started", { wa_id: fromWa, intent: detected });
    return true;
  }

  // ====== Handler: VEHICLE_INCOMPATIBLE ======
  async function handleVehicleIncompatible(fromWa, text, rawMsg, convState, intent, buttonId) {
    const stateData = convState.data || {};
    const origIntent = stateData.originalIntent || intent;

    if (buttonId === "vehicle_incompat_reprog") {
      await clearConversationState(fromWa);
      log.info("Véhicule incompat → bascule vers REPROG", { wa_id: fromWa, from: origIntent });
      return handlePrestationFlow(fromWa, "1", rawMsg);
    }
    if (buttonId === "vehicle_incompat_e85") {
      await clearConversationState(fromWa);
      log.info("Véhicule incompat → bascule vers E85", { wa_id: fromWa, from: origIntent });
      return handlePrestationFlow(fromWa, "2", rawMsg);
    }
    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }
    const detected = detectIntent(text);
    if (detected) {
      await clearConversationState(fromWa);
      const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
      return handlePrestationFlow(fromWa, menuMap[detected] || text, rawMsg);
    }
    const req = INTENT_VEHICLE_REQUIREMENTS[origIntent];
    const alternatives = req?.alternatives || [
      { id: "vehicle_incompat_reprog", title: "🏎️ Reprog moteur" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ];
    return respondOrAnswerQuestion(fromWa, text, `Souhaitez-vous opter pour une autre prestation adaptée à votre véhicule ?`, alternatives, rawMsg);
  }
  registerPrestationState("VEHICLE_INCOMPATIBLE", handleVehicleIncompatible);

  // ====== Handler: WAITING_PLATE ======
  async function handleWaitingPlate(fromWa, text, rawMsg, convState, intent, buttonId) {
    // Don't send plate error for empty or placeholder text
    if (!text || /^\[.+\]$/.test(text)) return false;

    let { valid, plate } = validatePlate(text);
    if (!valid && text) {
      const extracted = extractAndValidatePlate(text);
      if (extracted.plate) { plate = extracted.plate; valid = extracted.valid; log.info("WAITING_PLATE → plaque extraite du texte", { wa_id: fromWa, plate, valid, context: extracted.context?.slice(0, 50) }); }
    }

    if (!valid && convState.data?._known_plate) {
      plate = convState.data._known_plate;
      valid = true;
      log.info("WAITING_PLATE → using previously accumulated plate", { wa_id: fromWa, plate });
    }

    if (!valid) {
      const t = String(text || "").trim().toLowerCase();
      const newIntent = detectIntent(t);
      if (newIntent && newIntent !== intent) {
        await clearConversationState(fromWa);
        log.info("WAITING_PLATE → changement d'intent", { wa_id: fromWa, from: intent, to: newIntent });
        const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
        return handlePrestationFlow(fromWa, menuMap[newIntent] || t, rawMsg);
      }
      if (t.length > 10) {
        try {
          const llmResult = await askLLM(text, fromWa);
          if (llmResult) {
            if (llmResult.type === "intent" && llmResult.intent) {
              await clearConversationState(fromWa);
              const menuMap2 = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
              const mapped = menuMap2[llmResult.intent];
              if (mapped) { log.info("WAITING_PLATE → LLM intent redirect", { wa_id: fromWa, intent: llmResult.intent }); return handlePrestationFlow(fromWa, mapped, rawMsg); }
            }
            if (llmResult.type === "answer" && llmResult.message) {
              log.info("WAITING_PLATE → LLM answer", { wa_id: fromWa, msgLen: llmResult.message.length });
              await sendWhatsAppText(fromWa, llmResult.message);
              // Re-demander la plaque pour ne pas laisser le client bloqué dans cet état
              await sendWhatsAppInteractiveButtons(fromWa, "Pour continuer, envoyez votre plaque d'immatriculation (ex: AA 123 BB) :", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
              return true;
            }
          }
        } catch (llmErr) { log.warn("WAITING_PLATE LLM fallback error", { error: String(llmErr?.message || llmErr) }); }
      }
      await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas reconnu la plaque 😅\nEnvoyez-la au format AA 123 BB (avec ou sans tirets).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    // ── Effet "analyse en temps réel" : message immédiat avant la lookup ──
    await sendWhatsAppText(fromWa, buildAnalysisStartMessage(plate));

    try {
      const vehicle = await lookupVehicleFromPlate(plate);
      await setConversationState(fromWa, "WAITING_VEHICLE_CONFIRM", intent, { ...pickKnown(convState.data), plate, vehicle });

      // ── Message intermédiaire : "Véhicule identifié" ──
      await sendWhatsAppText(fromWa, buildAnalysisProgressMessage(vehicle));
      await new Promise(r => setTimeout(r, 700));

      // ── Fiche performance complète ──
      const performanceCard = buildVehiclePerformanceCard(vehicle) || buildVehicleOnlyText(vehicle);
      await sendWhatsAppInteractiveButtons(fromWa, performanceCard, [
        { id: "confirm_vehicle_yes", title: "✅ Oui, c'est bon" },
        { id: "confirm_vehicle_no", title: "❌ Non" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      return true;
    } catch (err) {
      const emsg = String(err?.message || err || "");
      log.error("Erreur lookup véhicule", { wa_id: fromWa, intent, error: emsg });
      if (emsg.includes("VEHICLE_NOT_FOUND")) {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas trouvé ce véhicule 😕\nVeuillez vérifier la plaque et la renvoyer (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      } else if (emsg.includes("OUT_OF_CREDIT") || emsg.includes("IMMATRICULATION_API_FAILED") || emsg.includes("NOT_CONFIGURED") || emsg.includes("INVALID_TOKEN") || emsg.includes("IMMATRICULATION_API_NETWORK")) {
        await setConversationState(fromWa, "WAITING_VEHICLE_MANUAL", intent, { plate });
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'arrive pas à identifier le véhicule automatiquement 😕\nVeuillez indiquer : Marque / Modèle / Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      } else {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas pu récupérer les infos du véhicule 😕\nVeuillez vérifier votre plaque et réessayer (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      }
      return true;
    }
  }
  registerPrestationState("WAITING_PLATE", handleWaitingPlate);



  // ====== Main Prestation Flow Handler ======
  async function handlePrestationFlow(fromWa, text, rawMsg) {
    const convState = await getConversationState(fromWa);
    const intent = convState?.intent;
    const buttonId = extractInteractiveId(rawMsg);

    if (!convState || !convState.state) return handleNoState(fromWa, text, rawMsg, convState, intent, buttonId);
    if (!PRESTATION_INTENTS.has(intent)) return false;

    // Accumulate any info from this message (name, email, plate) into state — silently, non-blocking
    const enrichedData = accumulateInfoIntoState(text, convState.data, extractAndValidatePlate);
    if (enrichedData !== convState.data) {
      convState.data = enrichedData;
      setConversationState(fromWa, convState.state, convState.intent, enrichedData).catch(() => {});
    }

    const handled = await dispatchPrestationState(fromWa, text, rawMsg, convState, intent, buttonId);
    if (handled !== false) return handled;

    return handleLegacyPrestationStates(fromWa, text, rawMsg, convState, intent, buttonId);
  }

  // ====== Legacy handlers ======
  async function handleLegacyPrestationStates(fromWa, text, rawMsg, convState, intent, buttonId) {
    const prestationCode = intentToPrestationCode(intent);
    const label = intentToLabel(intent);

    // --- WAITING_VEHICLE_CONFIRM ---
    if (convState.state === "WAITING_VEHICLE_CONFIRM") {
      const t = String(text || "").trim().toLowerCase();
      const stateData = convState.data || {};
      const plate = stateData.plate;
      const vehicle = stateData.vehicle || {};

      if (buttonId === "confirm_vehicle_yes" || isConfirmation(t)) {
        const incompat = validateIntentForVehicle(intent, vehicle);
        if (incompat) {
          await setConversationState(fromWa, "VEHICLE_INCOMPATIBLE", intent, { plate, vehicle, originalIntent: intent });
          await sendWhatsAppInteractiveButtons(fromWa, `❌ ${incompat.title}\n\n${incompat.explain(vehicle)}`, incompat.alternatives);
          log.info("Intent refusé: véhicule incompatible", { wa_id: fromWa, intent, fuel: vehicle.fuel, plate });
          return true;
        }

        if (intent === "REPROG") {
          try {
            const stages = await lookupReprogStages(vehicle);
            if (stages.length > 0) {
              // Si le client a déjà mentionné un stage, sauter directement au devis
              if (stateData._known_stage_num) {
                const knownIdx = stateData._known_stage_num - 1;
                if (knownIdx >= 0 && knownIdx < stages.length) {
                  log.info("WAITING_VEHICLE_CONFIRM → stage déjà connu, skip sélection", { wa_id: fromWa, stageNum: stateData._known_stage_num });
                  const fakeConvState = { state: "WAITING_STAGE_CHOICE", intent, data: { ...pickKnown(stateData), plate, vehicle, stages } };
                  await setConversationState(fromWa, "WAITING_STAGE_CHOICE", intent, { ...pickKnown(stateData), plate, vehicle, stages });
                  return handleLegacyPrestationStates(fromWa, String(stateData._known_stage_num), rawMsg, fakeConvState, intent, null);
                }
              }
              const displayStages = await buildAndSendStageSelection(fromWa, vehicle, plate, stages, intent, stateData);
              log.info("Reprog stages trouvés", { wa_id: fromWa, count: displayStages.length, total: stages.length });
              return true;
            }
          } catch (err) { log.error("lookupReprogStages failed", { error: String(err?.message || err) }); }
        }

        let priceCents;
        if (intent === "REPROG") priceCents = computeReprogPrice(vehicle);
        else if (intent === "E85") priceCents = computeE85Price(vehicle);
        else if (intent === "ADBLUE") priceCents = computeAdbluePrice(vehicle);
        else if (intent === "FAP") priceCents = computeFapPrice(vehicle);
        else if (intent === "EGR") priceCents = computeEgrPrice(vehicle);
        else { const tarif = await getPrestationTarif(prestationCode); priceCents = tarif?.prix_base_centimes || null; }

        if (priceCents === null) {
          await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle });
          await sendWhatsAppInteractiveButtons(fromWa, `Prestation : ${label}\nPrix : Sur devis personnalisé\n\nMerci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
          return true;
        }

        try {
          const isTtc = TTC_INTENTS.has(intent);
          const devisRow = await createDevis({ prestationCode, plate, waId: fromWa, vehicleYear: vehicle?.year || null, priceCentsOverride: priceCents, priceIsTtc: isTtc });
          const devisId = devisRow?.id ?? "N/A";
          const htTxt = typeof devisRow?.total_ht_centimes === "number" ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€` : "N/A";
          const ttcTxt = typeof devisRow?.total_ttc_centimes === "number" ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€` : "N/A";
          const displayLabel = intent === "REPROG" ? `${label} — STAGE 1` : label;

          await setConversationState(fromWa, "WAITING_QUOTE_CONFIRM", intent, { ...pickKnown(stateData), plate, vehicle, priceCents, devisId, htTxt, ttcTxt, prestationLabel: displayLabel });

          if (["E85", "FAP", "ADBLUE", "EGR"].includes(intent)) {
            const cardUrl = buildPrestationCardUrl({ vehicle, intent, prestationLabel: displayLabel, priceTtc: ttcTxt });
            if (cardUrl) sendWhatsAppImage(fromWa, cardUrl, `📋 Fiche technique — ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}`).catch(() => {});
          }

          await sendWhatsAppInteractiveButtons(fromWa, `✅ Devis généré\nRéf : DEV-${devisId}\nPrestation : ${displayLabel}\nTotal TTC : ${ttcTxt}\n\nEst-ce que ce devis vous convient ?`, [
            { id: "confirm_quote_yes", title: "✅ Oui" }, { id: "confirm_quote_no", title: "❌ Non" }, { id: "btn_back_menu", title: "🏠 Menu" }
          ]);

          sendWhatsAppText(fromWa, `📜 Veuillez consulter nos conditions générales de vente :\nhttps://www.diagperf.com/conditions-generales-de-vente/`).catch(() => {});

          if (devisRow.isNew) {
            broadcastDashboardEvent("new_devis", { devisId, plate: plate || "", wa_id: fromWa, prestation: label, ttc: ttcTxt });
            await notifyGarage(`📋 NOUVEAU DEVIS\nRéf : DEV-${devisId}\nPrestation : ${label}\nPlaque : ${plate || "N/A"}\nClient : ${fromWa}\nTTC : ${ttcTxt}`);
          }
        } catch (err) {
          log.error("Erreur création devis", { error: String(err?.message || err) });
          await sendWhatsAppInteractiveButtons(fromWa, "Désolé, j'ai eu un souci 😕\nVeuillez réessayer.", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        }
        return true;
      }

      if (buttonId === "confirm_vehicle_no" || isDenial(t)) {
        await setConversationState(fromWa, "WAITING_PLATE", intent, {});
        await sendWhatsAppInteractiveButtons(fromWa, "Pas de souci ! Veuillez renvoyer votre plaque (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      // Client a envoyé ses coordonnées trop tôt → on les sauvegarde et on repose la question
      if (String(text || "").includes("@")) {
        const words = String(text || "").trim().split(/\s+/);
        const emailWord = words.find(w => w.includes("@"));
        const nameParts = words.filter(w => !w.includes("@") && w.length > 1);
        if (emailWord && nameParts.length > 0) {
          const savedName = nameParts.join(" ");
          const savedEmail = emailWord.toLowerCase();
          await setConversationState(fromWa, "WAITING_VEHICLE_CONFIRM", intent, { ...stateData, saved_customer_name: savedName, saved_customer_email: savedEmail });
          const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
          await sendWhatsAppInteractiveButtons(fromWa,
            `Merci ${nameParts[0]} ! 👍 J'ai bien noté vos coordonnées pour la suite.\n\nMais d'abord, confirmez-vous ce véhicule ?\n🚗 *${vehicleName}* — ${vehicle.fuel || ""} — ${vehicle.year || ""}`,
            [{ id: "confirm_vehicle_yes", title: "✅ Oui" }, { id: "confirm_vehicle_no", title: "❌ Non" }, { id: "btn_back_menu", title: "🏠 Menu" }]
          );
          return true;
        }
      }

      return respondOrAnswerQuestion(fromWa, text, "Est-ce bien votre véhicule ? Répondez *oui* ou *non*.", [
        { id: "confirm_vehicle_yes", title: "✅ Oui" }, { id: "confirm_vehicle_no", title: "❌ Non" }, { id: "btn_back_menu", title: "🏠 Menu" }
      ], rawMsg);
    }

    // --- WAITING_STAGE_CHOICE ---
    if (convState.state === "WAITING_STAGE_CHOICE") {
      const stateData = convState.data || {};
      const plate = stateData.plate;
      const vehicle = stateData.vehicle || {};
      const stages = stateData.stages || [];

      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      let selectedIdx = -1;
      const txtLower = String(text || "").trim().toLowerCase();
      if (buttonId && buttonId.startsWith("stage_choice_")) {
        selectedIdx = parseInt(buttonId.replace("stage_choice_", ""), 10) - 1;
      } else {
        const num = parseInt(txtLower, 10);
        if (num >= 1 && num <= stages.length) { selectedIdx = num - 1; }
        else { const stageMatch = txtLower.match(/stage\s*(\d+)/i); if (stageMatch) { const stageNum = parseInt(stageMatch[1], 10); if (stageNum >= 1 && stageNum <= stages.length) selectedIdx = stageNum - 1; } }
      }

      if (selectedIdx < 0 || selectedIdx >= stages.length) {
        const retryButtons = stages.slice(0, 3).map((s, i) => {
          const btnLabel = formatStageLabel(s.stage);
          const btnPrix = CUSTOM_QUOTE_STAGES.has(s.stage) ? "Devis" : (s.stage === "stage1" ? STAGE1_PRICE_LABEL : (typeof s.prix_centimes === "number" ? `${(s.prix_centimes / 100).toFixed(0)}€` : "Devis"));
          return { id: `stage_choice_${i + 1}`, title: `${btnLabel} — ${btnPrix}`.slice(0, 20) };
        });
        if (retryButtons.length < 3) retryButtons.push({ id: "btn_back_menu", title: "🏠 Menu" });
        return respondOrAnswerQuestion(fromWa, text, "Merci de choisir un des stages proposés 👇", retryButtons, rawMsg);
      }

      const selectedStage = stages[selectedIdx];
      const stageLabel = formatStageLabel(selectedStage.stage);
      log.info("Stage selected", { wa_id: fromWa, stage: selectedStage.stage, idx: selectedIdx });

      const isE85Stage = /e85/i.test(selectedStage.stage);
      let priceCents = null;
      if (selectedStage.stage === "stage1") priceCents = STAGE1_FIXED_PRICE_CENTS;
      else if (typeof selectedStage.prix_centimes === "number" && !CUSTOM_QUOTE_STAGES.has(selectedStage.stage)) priceCents = selectedStage.prix_centimes;

      if (priceCents === null) {
        await setConversationState(fromWa, "WAITING_COORDINATES", intent, { ...pickKnown(stateData), plate, vehicle, stageLabel });
        await sendWhatsAppInteractiveButtons(fromWa, `Prestation : Reprogrammation ${stageLabel}\nPrix : Sur devis personnalisé\n\nCe stage nécessite une étude personnalisée 🔍\nMerci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      try {
        const isTtc = TTC_INTENTS.has(intent);
        const devisRow = await createDevis({ prestationCode: intentToPrestationCode(intent), plate, waId: fromWa, vehicleYear: vehicle?.year || null, priceCentsOverride: priceCents, priceIsTtc: isTtc });
        const devisId = devisRow?.id ?? "N/A";
        const htTxt = typeof devisRow?.total_ht_centimes === "number" ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€` : "(non dispo)";
        const ttcTxt = typeof devisRow?.total_ttc_centimes === "number" ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€` : "(non dispo)";
        const gainTxt = (!isE85Stage && selectedStage.gain_puissance) ? `\n⚡ +${selectedStage.gain_puissance}ch / +${selectedStage.gain_couple}Nm` : "";
        const stageGainTxtShort = (!isE85Stage && selectedStage.gain_puissance) ? `+${selectedStage.gain_puissance}ch / +${selectedStage.gain_couple}Nm` : null;

        await setConversationState(fromWa, "WAITING_QUOTE_CONFIRM", intent, { ...pickKnown(stateData), plate, vehicle, priceCents, devisId, htTxt, ttcTxt, stageLabel, prestationLabel: `Reprogrammation ${stageLabel}`, gainTxt: stageGainTxtShort });

        await sendWhatsAppInteractiveButtons(fromWa, `✅ Devis généré\nRéférence : DEV-${devisId}\nPrestation : Reprogrammation ${stageLabel}${gainTxt}\nDurée d'intervention : 1h30 à 2h\nTotal HT : ${htTxt}\nTotal TTC : ${ttcTxt}\n\nEst-ce que ce devis vous convient ?`, [
          { id: "confirm_quote_yes", title: "✅ Oui" }, { id: "confirm_quote_no", title: "❌ Non" }, { id: "btn_back_menu", title: "🏠 Menu" },
        ]);

        sendWhatsAppText(fromWa, `📜 Veuillez consulter nos conditions générales de vente :\nhttps://www.diagperf.com/conditions-generales-de-vente/`).catch(() => {});

        const waDigits = fromWa.replace(/\D/g, "");
        let clientPin = waDigits.slice(-4);
        try {
          const { data: pinRow, error: pinSelectErr } = await supabase.from("client_pins").select("pin").eq("wa_id", fromWa).maybeSingle();
          if (pinSelectErr) throw pinSelectErr; // table inexistante → catch → garde last-4
          if (pinRow?.pin) {
            clientPin = pinRow.pin;
          } else {
            const newPin = String(Math.floor(1000 + Math.random() * 9000));
            const { error: upsertErr } = await supabase.from("client_pins").upsert({ wa_id: fromWa, pin: newPin }, { onConflict: "wa_id" });
            if (!upsertErr) clientPin = newPin; // n'utilise le nouveau PIN que s'il a été stocké
          }
        } catch { /* table client_pins pas encore créée, on garde last-4 */ }
        const pwaUrl = `https://webhook.diagperf.com/app.html?wa=${encodeURIComponent(fromWa)}&pin=${clientPin}`;
        sendWhatsAppText(fromWa, [
          `━━━━━━━━━━━━━━━━━━━━━`,
          `🚀 *VOTRE ESPACE CLIENT DIAGPERF*`,
          `━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `📊 Suivez vos devis en temps réel`,
          `✅ Validez directement depuis votre téléphone`,
          `🔔 Notifications de mise à jour instantanées`,
          ``,
          `👉 *Accédez à votre espace :*`,
          pwaUrl,
          ``,
          `💡 _Astuce : ajoutez cette page à votre écran d'accueil pour un accès en 1 clic !_`,
          `━━━━━━━━━━━━━━━━━━━━━`,
        ].join("\n"), { preview_url: true }).catch(e => { log.debug("PWA link send failed", { error: String(e?.message || e) }); });

        if (devisRow.isNew) {
          broadcastDashboardEvent("new_devis", { devisId, plate: plate || "", wa_id: fromWa, prestation: `Reprogrammation ${stageLabel}`, ttc: ttcTxt });
          await notifyGarage(`📋 NOUVEAU DEVIS\nRéf : DEV-${devisId}\nPrestation : Reprogrammation ${stageLabel}\nPlaque : ${plate || "N/A"}\nClient : ${fromWa}\nHT : ${htTxt} | TTC : ${ttcTxt}\nDate : ${new Date().toISOString()}`);
        }
        log.info("Devis créé (stage choice)", { wa_id: fromWa, intent, devisId, stage: selectedStage.stage });
      } catch (err) {
        const emsg = String(err?.message || err || "");
        log.error("Erreur création devis (stage)", { wa_id: fromWa, error: emsg });
        if (emsg.includes("NO_TARIF")) {
          await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle, stageLabel });
          await sendWhatsAppInteractiveButtons(fromWa, `Prestation : Reprogrammation ${stageLabel}\nPrix : Sur devis personnalisé\n\nMerci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        } else {
          await sendWhatsAppInteractiveButtons(fromWa, "Désolé, j'ai eu un souci pour générer le devis 😕\nVeuillez réessayer dans quelques instants.", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        }
      }
      return true;
    }

    // --- WAITING_QUOTE_CONFIRM ---
    if (convState.state === "WAITING_QUOTE_CONFIRM") {
      const t = String(text || "").trim().toLowerCase();
      const stateData = convState.data || {};
      const plate = stateData.plate;
      const vehicle = stateData.vehicle || {};

      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      if (buttonId === "confirm_quote_yes" || isConfirmation(t)) {
        if (stateData.devisId) {
          supabase.from("devis").update({ statut: "sent" }).eq("id", stateData.devisId).then(({ error }) => {
            if (error) log.error("Failed to update devis status", { devisId: stateData.devisId, error: String(error.message) });
            else { log.info("Devis confirmed by client", { devisId: stateData.devisId, wa_id: fromWa }); broadcastDashboardEvent("devis_confirmed", { devisId: stateData.devisId, wa_id: fromWa, plate: stateData.plate || "" }); }
          });
        }

        const upsellOptions = getUpsellOptionsForVehicle(intent, vehicle);
        if (upsellOptions.length > 0) {
          const firstOpt = upsellOptions[0];
          await setConversationState(fromWa, "WAITING_UPSELL", intent, { ...stateData, upsellType: intent, upsellStep: 0, addedOptions: [], baseTtcCents: stateData.priceCents, devisRef: `DEV-${stateData.devisId}`, lastUpsellAction: "confirm" });
          await sendWhatsAppInteractiveButtons(fromWa, buildUpsellMessage(firstOpt, vehicle, "confirm"), [
            { id: "upsell_add", title: firstOpt.addBtnLabel }, { id: "upsell_skip", title: firstOpt.skipBtnLabel }, { id: "btn_back_menu", title: "🏠 Menu" },
          ]);
          log.info("Quote confirmed → upsell started", { wa_id: fromWa, intent, upsellType: intent });
          return true;
        }

        await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, stateData);

        // Si les coordonnées sont déjà connues, ne pas redemander — traiter directement
        if ((stateData._known_name || stateData.saved_customer_name) &&
            (stateData._known_email || stateData.saved_customer_email) &&
            validateEmail(stateData._known_email || stateData.saved_customer_email)) {
          log.info("Quote confirmed → contact déjà connu, skip WAITING_DEVIS_CONTACT", { wa_id: fromWa });
          const fakeConvState = { state: "WAITING_DEVIS_CONTACT", intent, data: stateData };
          return handleLegacyPrestationStates(fromWa, "", rawMsg, fakeConvState, intent, null);
        }

        await sendWhatsAppInteractiveButtons(fromWa, buildContactRequestMsg(stateData), [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        log.info("Quote confirmed → asking for customer contact info", { wa_id: fromWa, intent });
        return true;
      }

      if (buttonId === "confirm_quote_no" || isDenial(t)) {
        if (stateData.devisId) {
          supabase.from("devis").update({ statut: "refused" }).eq("id", stateData.devisId).then(({ error }) => {
            if (error) log.error("Failed to update devis status", { devisId: stateData.devisId, error: String(error.message) });
            else { log.info("Devis refused by client", { devisId: stateData.devisId, wa_id: fromWa }); broadcastDashboardEvent("devis_refused", { devisId: stateData.devisId, wa_id: fromWa, plate: stateData.plate || "" }); }
          });
        }
        await setConversationState(fromWa, "WAITING_POST_QUOTE_CHOICE", intent, { plate, vehicle });
        await sendWhatsAppInteractiveButtons(fromWa, "Nous comprenons. Comment pouvons-nous vous aider ?", [
          { id: "post_quote_technicien", title: "Contacter technicien" }, { id: "post_quote_accueil", title: "Retour accueil" },
        ]);
        return true;
      }

      return respondOrAnswerQuestion(fromWa, text, "Répondez par *oui* si le devis vous convient, ou *non* dans le cas contraire.", [
        { id: "confirm_quote_yes", title: "✅ Oui" }, { id: "confirm_quote_no", title: "❌ Non" }, { id: "btn_back_menu", title: "🏠 Menu" },
      ], rawMsg);
    }

    // --- WAITING_UPSELL ---
    if (convState.state === "WAITING_UPSELL") {
      const stateData = convState.data || {};
      const upsellType = stateData.upsellType || intent;
      const options = getUpsellOptionsForVehicle(upsellType, stateData.vehicle);
      const step = stateData.upsellStep || 0;
      const addedOptions = [...(stateData.addedOptions || [])];

      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      if (buttonId === "upsell_add") { const currentOpt = options[step]; if (currentOpt) addedOptions.push(currentOpt.id); log.info("Upsell accepted", { wa_id: fromWa, option: currentOpt?.id, step }); }
      else if (buttonId === "upsell_skip") { log.info("Upsell skipped", { wa_id: fromWa, option: options[step]?.id, step }); }
      else {
        const currentOpt = options[step];
        if (currentOpt) return respondOrAnswerQuestion(fromWa, text, buildUpsellMessage(currentOpt, stateData.vehicle, null), [
          { id: "upsell_add", title: currentOpt.addBtnLabel }, { id: "upsell_skip", title: currentOpt.skipBtnLabel }, { id: "btn_back_menu", title: "🏠 Menu" },
        ], rawMsg);
        return true;
      }

      const nextStep = step + 1;
      if (nextStep < options.length) {
        const nextOpt = options[nextStep];
        const prevAction = buttonId === "upsell_add" ? "add" : "skip";
        await setConversationState(fromWa, "WAITING_UPSELL", intent, { ...stateData, upsellStep: nextStep, addedOptions, lastUpsellAction: prevAction });
        await sendWhatsAppInteractiveButtons(fromWa, buildUpsellMessage(nextOpt, stateData.vehicle, prevAction), [
          { id: "upsell_add", title: nextOpt.addBtnLabel }, { id: "upsell_skip", title: nextOpt.skipBtnLabel }, { id: "btn_back_menu", title: "🏠 Menu" },
        ]);
        log.info("Upsell next proposal", { wa_id: fromWa, intent, step: nextStep });
      } else {
        const baseLabel = intentToLabel(upsellType);
        const baseTtcCents = stateData.priceCents;
        const baseTtcTxt = typeof baseTtcCents === "number" ? `${(baseTtcCents / 100).toFixed(0)}€ TTC` : (stateData.ttcTxt || "N/A");
        const devisId = stateData.devisId || "N/A";
        const devisRef = `DEV-${devisId}`;
        let lines = `✅ ${baseLabel} : ${baseTtcTxt}\n`;
        let totalAddedTtc = 0;
        for (const opt of options) {
          if (addedOptions.includes(opt.id)) { lines += `✅ ${opt.label} : +${(opt.priceCents / 100).toFixed(0)}€ TTC\n`; totalAddedTtc += opt.priceCents; }
          else lines += `❌ ${opt.label} : non retenu\n`;
        }
        const tauxTva = 0.20;
        const newTtc = (typeof baseTtcCents === "number" ? baseTtcCents : 0) + totalAddedTtc;
        const newHt = Math.round(newTtc / (1 + tauxTva));
        const htTxt = `${(newHt / 100).toFixed(2)}€`;
        const ttcTxt = `${(newTtc / 100).toFixed(0)}€`;
        const msg = `📋 *Récapitulatif de votre devis :*\n\nRéférence : ${devisRef}\n${lines}\nDurée d'intervention : 2h-4h\nTotal HT : ${htTxt}\nTotal TTC : ${ttcTxt}\n\nCe devis vous convient-il ?`;

        await setConversationState(fromWa, "WAITING_UPSELL_CONFIRM", intent, { ...stateData, addedOptions, newTtcCents: newTtc, newHtCents: newHt, newHtTxt: htTxt, newTtcTxt: ttcTxt });
        await sendWhatsAppInteractiveButtons(fromWa, msg, [
          { id: "upsell_confirm_yes", title: "✅ Confirmer" }, { id: "upsell_confirm_no", title: "❌ Annuler" }, { id: "btn_back_menu", title: "🏠 Menu" },
        ]);
        log.info("Upsell recap shown", { wa_id: fromWa, intent, addedOptions, totalAddedTtc, newTtc });
      }
      return true;
    }

    // --- WAITING_DEVIS_CONTACT ---
    if (convState.state === "WAITING_DEVIS_CONTACT") {
      const stateData = convState.data || {};
      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      // Coordonnées — merge: sources connues + compléter depuis le message actuel
      const { customerName, customerEmail } = resolveContactFromState(stateData, text);
      log.info("WAITING_DEVIS_CONTACT: contact resolved", { wa_id: fromWa, customerName, hasEmail: !!validateEmail(customerEmail) });

      if (!customerName || customerName.length < 2) {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas pu identifier votre nom 😅\nMerci d'envoyer votre nom complet :\n(ex: Dupont Jean)", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }
      if (!customerEmail || !validateEmail(customerEmail)) {
        await sendWhatsAppInteractiveButtons(fromWa, "L'adresse email ne semble pas valide 😕\nMerci d'envoyer votre adresse email :\n(ex: jean.dupont@gmail.com)", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      let devisRow = null;
      if (stateData.devisId) {
        try { const { data } = await supabase.from("devis").select("id, total_ht_centimes, total_ttc_centimes").eq("id", stateData.devisId).single(); devisRow = data; }
        catch (e) { log.warn("WAITING_DEVIS_CONTACT: devis fetch failed", { error: String(e?.message || e) }); }
      }

      const vehicle = stateData.vehicle || {};
      const plate = stateData.plate || "N/A";
      const devisId = stateData.devisId || "N/A";
      const devisRef = `DEV-${devisId}`;
      const htTxt = typeof devisRow?.total_ht_centimes === "number" ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€` : (stateData.htTxt || "N/A");
      const ttcTxt = typeof devisRow?.total_ttc_centimes === "number" ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€` : (stateData.ttcTxt || "N/A");
      const vNameParts = [vehicle.make, vehicle.model].filter(Boolean);
      const motorisation = [vehicle.fuel, vehicle.engine_cc ? `${vehicle.engine_cc}cc` : null, vehicle.power_hp ? `${vehicle.power_hp}ch` : null].filter(Boolean).join(" ");
      const yearTxt = vehicle.year ? `${vehicle.year}` : "";
      const vehicleDesc = [vNameParts.join(" "), motorisation, yearTxt].filter(Boolean).join(" — ");
      const engineCode = vehicle.engine_code || "Non disponible";
      const emailPrestationLabel = stateData.prestationLabel || stateData.stageLabel
        ? (stateData.stageLabel ? `Reprogrammation moteur — ${stateData.stageLabel}` : stateData.prestationLabel)
        : (label || intentToLabel(intent));

      const nameTokens = customerName.split(/\s+/);
      const lastName = nameTokens[0] || "";
      const firstName = nameTokens.slice(1).join(" ") || "";

      let pdfBuffer = null;
      if (stateData.devisId) {
        try { pdfBuffer = await sendQuotePdf(fromWa, { devisId: stateData.devisId, plate: stateData.plate, vehicle: stateData.vehicle, prestationLabel: stateData.prestationLabel || intentToLabel(intent), stageLabel: stateData.stageLabel, gainTxt: stateData.gainTxt, devisRow, customerName, customerEmail, customerPhone: fromWa }); }
        catch (err) { log.error("sendQuotePdf error (non-blocking)", { wa_id: fromWa, error: String(err?.message || err) }); }
      }

      const [clientEmailRes] = await Promise.allSettled([
        sendRdvClientEmail({ to: customerEmail, firstName, lastName, vehicleDesc, prestationLabel: emailPrestationLabel, devisRef, htTxt, ttcTxt, contactReason: "devis", pdfBuffer }),
        sendRdvDiagperfEmail({ firstName, lastName, clientEmail: customerEmail, waId: fromWa, vehicleDesc, engineCode, plate, prestationLabel: emailPrestationLabel, devisRef, htTxt, ttcTxt, contactReason: "devis" }),
      ]);
      const clientEmailSent = clientEmailRes.status === "fulfilled" && clientEmailRes.value === true;
      if (!clientEmailSent) log.warn("Client email failed or Brevo not configured", { wa_id: fromWa, customerEmail });

      notifyGarage(`👤 COORDONNÉES CLIENT REÇUES\nDevis : ${devisRef}\nClient : ${customerName}\nEmail : ${customerEmail}\nWhatsApp : ${fromWa}\nVéhicule : ${vehicleDesc}\nPlaque : ${plate}\nPrestation : ${emailPrestationLabel}\nHT : ${htTxt} | TTC : ${ttcTxt}`).catch(() => {});

      // Sauvegarder nom + email sur le devis pour le dashboard
      if (stateData.devisId) {
        supabase.from("devis").update({ customer_name: customerName, customer_email: customerEmail }).eq("id", stateData.devisId).then(() => {}).catch(() => {});
      }

      const nextData = { ...stateData, customerName, customerEmail, firstName, lastName };
      await setConversationState(fromWa, "WAITING_POST_QUOTE_CHOICE", intent, nextData);
      const emailConfirmLine = clientEmailSent
        ? `📧 Un récapitulatif a également été envoyé à ${customerEmail}.\n`
        : `📧 Vous pouvez aussi nous écrire à Diag.perf.pro@gmail.com\n`;
      await sendWhatsAppInteractiveButtons(fromWa, `Merci pour votre confiance ${customerName} ! ✅\n\n📄 Votre devis PDF vient de vous être envoyé.\n${emailConfirmLine}\nQue souhaitez-vous faire ensuite ?`, [
        { id: "post_quote_rdv", title: "Prendre RDV" }, { id: "post_quote_technicien", title: "Question technicien" }, { id: "post_quote_accueil", title: "Retour accueil" },
      ]);
      log.info("Customer contact collected → PDF + emails sent → post-quote choice", { wa_id: fromWa, intent, customerName, customerEmail });
      return true;
    }

    // --- WAITING_UPSELL_CONFIRM ---
    if (convState.state === "WAITING_UPSELL_CONFIRM") {
      const t = String(text || "").trim().toLowerCase();
      const stateData = convState.data || {};
      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      if (t === "oui" || t === "confirmer" || buttonId === "upsell_confirm_yes") {
        const addedOptions = stateData.addedOptions || [];
        if (addedOptions.length > 0) {
          try { await addUpsellOptionsToDevis(stateData.devisId, addedOptions, stateData.upsellType || intent); }
          catch (err) { log.error("Failed to add upsell options to devis", { wa_id: fromWa, error: String(err?.message || err) }); }
        }
        const updatedData = { ...stateData, htTxt: stateData.newHtTxt || stateData.htTxt, ttcTxt: stateData.newTtcTxt || stateData.ttcTxt };
        await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, updatedData);
        if ((updatedData._known_name || updatedData.saved_customer_name) &&
            (updatedData._known_email || updatedData.saved_customer_email) &&
            validateEmail(updatedData._known_email || updatedData.saved_customer_email)) {
          log.info("Upsell confirmed → contact déjà connu, skip WAITING_DEVIS_CONTACT", { wa_id: fromWa });
          const fakeConvState = { state: "WAITING_DEVIS_CONTACT", intent, data: updatedData };
          return handleLegacyPrestationStates(fromWa, "", rawMsg, fakeConvState, intent, null);
        }
        await sendWhatsAppInteractiveButtons(fromWa, buildContactRequestMsg(updatedData), [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        log.info("Upsell confirmed → asking for customer contact info", { wa_id: fromWa, intent, addedOptions: stateData.addedOptions });
        return true;
      }

      if (t === "non" || t === "annuler" || buttonId === "upsell_confirm_no") {
        await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, stateData);
        if ((stateData._known_name || stateData.saved_customer_name) &&
            (stateData._known_email || stateData.saved_customer_email) &&
            validateEmail(stateData._known_email || stateData.saved_customer_email)) {
          const fakeConvState = { state: "WAITING_DEVIS_CONTACT", intent, data: stateData };
          return handleLegacyPrestationStates(fromWa, "", rawMsg, fakeConvState, intent, null);
        }
        await sendWhatsAppInteractiveButtons(fromWa, buildContactRequestMsg(stateData, "Pas de souci ! 🙂\n\n"), [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      return respondOrAnswerQuestion(fromWa, text, "Merci de choisir une des options proposées.", [
        { id: "upsell_confirm_yes", title: "✅ Confirmer" }, { id: "upsell_confirm_no", title: "❌ Annuler" }, { id: "btn_back_menu", title: "🏠 Menu" },
      ], rawMsg);
    }

    // --- WAITING_POST_QUOTE_CHOICE ---
    if (convState.state === "WAITING_POST_QUOTE_CHOICE") {
      const btnId = extractInteractiveId(rawMsg);
      const t = String(text || "").trim().toLowerCase();

      if (btnId === "post_quote_rdv" || t === "prendre rdv" || t === "rendez-vous" || t === "rdv") {
        const stateData = convState.data || {};
        if (stateData.customerEmail && stateData.customerName) {
          notifyGarage(`📅 DEMANDE RDV\nClient : ${stateData.customerName} (${stateData.customerEmail})\nDevis : DEV-${stateData.devisId || "N/A"}\nWhatsApp : ${fromWa}`).catch(() => {});
          await setConversationState(fromWa, "AWAITING_CITY_FOR_TRAVEL", intent, { ...stateData, contactReason: "rdv" });
          await sendWhatsAppInteractiveButtons(fromWa, `Excellent choix ${stateData.customerName} ! 🎉\n\nNotre équipe vous recontactera dans les 24h pour fixer un créneau.\n\n� Vous pouvez aussi joindre directement *Youcef* au *06 75 54 70 85*\n\n�️ En attendant, indiquez votre *ville ou code postal* et je vous donnerai le temps de trajet estimé jusqu'à DiagPerf !`, [
            { id: "skip_travel", title: "⏭️ Passer" }, { id: "btn_back_menu", title: "🏠 Menu" },
          ]);
          log.info("Post-quote RDV (coords already known) → travel estimate", { wa_id: fromWa, intent });
          return true;
        }
        await setConversationState(fromWa, "AWAITING_RDV_COORDINATES", intent, { ...stateData, contactReason: "rdv" });
        await sendWhatsAppInteractiveButtons(fromWa, `Excellent choix ! 🎉 Pour finaliser votre prise en charge, merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        log.info("Post-quote choice: RDV → collecte coordonnées", { wa_id: fromWa, intent });
        return true;
      }

      if (btnId === "post_quote_technicien" || t === "question technicien" || t === "contacter technicien" || t === "technicien") {
        const stateData = convState.data || {};
        if (stateData.customerEmail && stateData.customerName) {
          notifyGarage(`🔧 DEMANDE TECHNICIEN\nClient : ${stateData.customerName} (${stateData.customerEmail})\nDevis : DEV-${stateData.devisId || "N/A"}\nWhatsApp : ${fromWa}`).catch(() => {});
          await clearConversationState(fromWa);
          await sendWhatsAppInteractiveButtons(fromWa, `Très bien ${stateData.customerName} ! 👨‍🔧\n\nNotre technicien vous recontactera dans les 24h pour répondre à vos questions.`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
          log.info("Post-quote technicien (coords already known) → notified", { wa_id: fromWa, intent });
          return true;
        }
        await setConversationState(fromWa, "AWAITING_RDV_COORDINATES", intent, { ...stateData, contactReason: "technicien" });
        await sendWhatsAppInteractiveButtons(fromWa, `Très bien ! Pour que notre technicien puisse vous recontacter, merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        log.info("Post-quote choice: technicien → collecte coordonnées", { wa_id: fromWa, intent });
        return true;
      }

      if (btnId === "post_quote_accueil" || t === "retour accueil" || t === "accueil" || t === "menu") {
        await clearConversationState(fromWa); await sendMenuList(fromWa);
        log.info("Post-quote choice: retour accueil", { wa_id: fromWa, intent });
        return true;
      }

      return respondOrAnswerQuestion(fromWa, text, "Merci de choisir une des options proposées 👇", [
        { id: "post_quote_rdv", title: "Prendre RDV" }, { id: "post_quote_technicien", title: "Question technicien" }, { id: "post_quote_accueil", title: "Retour accueil" },
      ], rawMsg);
    }

    // --- AWAITING_RDV_COORDINATES ---
    if (convState.state === "AWAITING_RDV_COORDINATES") {
      const parts = String(text || "").trim().split(/\s+/);
      const emailPart = parts.find(p => p.includes("@"));
      const email = validateEmail(emailPart);
      const nameParts2 = parts.filter(p => !p.includes("@"));
      const lastName = nameParts2[0] || "";
      const firstName = nameParts2.slice(1).join(" ") || "";

      if (!email || nameParts2.length < 1) {
        await sendWhatsAppInteractiveButtons(fromWa, `Je n'ai pas compris 😅\nVeuillez envoyer vos coordonnées au format : *Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      const stateData = convState.data || {};
      const plate = stateData.plate || "N/A";
      const vehicle = stateData.vehicle || {};
      const devisId = stateData.devisId || "N/A";
      const devisRef = `DEV-${devisId}`;
      const htTxt = stateData.htTxt || "N/A";
      const ttcTxt = stateData.ttcTxt || "N/A";
      const contactReason = stateData.contactReason || "rdv";
      const vNameParts = [vehicle.make, vehicle.model].filter(Boolean);
      const motorisation = [vehicle.fuel, vehicle.engine_cc ? `${vehicle.engine_cc}cc` : null, vehicle.power_hp ? `${vehicle.power_hp}ch` : null].filter(Boolean).join(" ");
      const yearTxt = vehicle.year ? `${vehicle.year}` : "";
      const vehicleDesc = [vNameParts.join(" "), motorisation, yearTxt].filter(Boolean).join(" — ");
      const engineCode = vehicle.engine_code || "Non disponible";
      const emailPrestationLabel = stateData.stageLabel ? `Reprogrammation moteur — ${stateData.stageLabel}` : label;

      const [rdvClientEmailRes] = await Promise.allSettled([
        sendRdvClientEmail({ to: email, firstName, lastName, vehicleDesc, prestationLabel: emailPrestationLabel, devisRef, htTxt, ttcTxt, contactReason }),
        sendRdvDiagperfEmail({ firstName, lastName, clientEmail: email, waId: fromWa, vehicleDesc, engineCode, plate, prestationLabel: emailPrestationLabel, devisRef, htTxt, ttcTxt, contactReason }),
      ]);
      const rdvEmailSent = rdvClientEmailRes.status === "fulfilled" && rdvClientEmailRes.value === true;
      if (!rdvEmailSent) log.warn("RDV client email failed or SendGrid not configured", { wa_id: fromWa, email });

      const rdvEmailLine = rdvEmailSent
        ? `📧 Un récapitulatif de votre devis a été envoyé à ${email}.\n`
        : `📧 Vous pouvez aussi nous écrire à Diag.perf.pro@gmail.com\n`;
      await sendWhatsAppInteractiveButtons(fromWa, `Merci pour votre confiance ! ✅\n\n${rdvEmailLine}Notre équipe vous recontactera dans les 24h pour répondre à vos questions.\n\n📞 Vous pouvez aussi joindre directement *Youcef* au *06 75 54 70 85*`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);

      await setConversationState(fromWa, "AWAITING_CITY_FOR_TRAVEL", intent, {});
      await sendWhatsAppInteractiveButtons(fromWa, `🗺️ Pour vous aider à planifier votre venue, indiquez votre *ville ou code postal* et je vous donnerai le temps de trajet estimé !`, [
        { id: "skip_travel", title: "⏭️ Passer" }, { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      log.info("RDV/technicien flow → travel estimate proposed", { wa_id: fromWa, intent, contactReason, email, devisRef });
      return true;
    }

    // --- AWAITING_CITY_FOR_TRAVEL ---
    if (convState.state === "AWAITING_CITY_FOR_TRAVEL") {
      if (buttonId === "btn_back_menu") { await clearConversationState(fromWa); await sendMenuList(fromWa); return true; }

      if (buttonId === "skip_travel" || text.toLowerCase() === "passer") {
        sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => { log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) }); });
        await sendWhatsAppInteractiveButtons(fromWa, `📍 Voici notre adresse ! À très bientôt chez DiagPerf 🚗`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        await clearConversationState(fromWa);
        log.info("Travel estimate skipped", { wa_id: fromWa });
        return true;
      }

      const travelMsg = await buildTravelEstimateMessage(text);
      if (travelMsg) {
        await sendWhatsAppInteractiveButtons(fromWa, travelMsg, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => { log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) }); });
        log.info("Travel estimate sent", { wa_id: fromWa, query: text });
      } else {
        sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => { log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) }); });
        await sendWhatsAppInteractiveButtons(fromWa, `Je n'ai pas trouvé cette localisation 😅\nMais voici notre adresse ! À très bientôt chez DiagPerf 🚗`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        log.info("Travel estimate failed, location sent", { wa_id: fromWa, query: text });
      }
      await clearConversationState(fromWa);
      return true;
    }

    // ====== DIAG sub-flow ======

    // --- DIAG_CHOOSE ---
    if (convState.state === "DIAG_CHOOSE" && intent === "DIAG") {
      const listId = rawMsg?.interactive?.list_reply?.id || null;
      const textLower = text.toLowerCase();
      const selected = DIAG_OPTIONS.find(opt =>
        listId === opt.id ||
        text === opt.id ||
        text === opt.title ||
        // Match exact mot entier — évite les faux positifs sur phrases négatives
        new RegExp(`(^|\\s)${opt.title.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(textLower)
      );

      if (!selected) {
        // Le LLM r\u00e9pond avec l'historique complet \u2014 jamais de menu en fallback
        try {
          const llmResult = await askLLM(text, fromWa);
          if (llmResult?.type === "answer" && llmResult?.message) {
            await sendWhatsAppText(fromWa, llmResult.message);
            return true;
          }
          if (llmResult?.type === "intent" && llmResult?.intent) {
            if (llmResult.intent === "DIAG") {
              // Client veut vraiment un diagnostic \u2192 re-afficher la liste
              await sendWhatsAppList(
                fromWa,
                "\ud83d\udd0d Diagnostic complet\n\nChoisissez le type de diagnostic souhait\u00e9 :",
                "\ud83d\udd0d Voir les options",
                [{ title: "Nos diagnostics", rows: DIAG_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: `${opt.description} \u2014 ${(opt.priceTtcCents / 100).toFixed(0)}\u20ac TTC` })) }]
              );
              return true;
            }
            // Le client change de prestation \u2192 rediriger proprement
            await clearConversationState(fromWa);
            const _menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
            const _mapped = _menuMap[llmResult.intent];
            if (_mapped) {
              const _handled = await handlePrestationFlow(fromWa, _mapped, rawMsg);
              if (_handled) return true;
            }
          }
        } catch (llmErr) {
          log.warn("LLM fallback failed in DIAG_CHOOSE", { wa_id: fromWa, error: String(llmErr?.message || llmErr) });
        }
        await sendWhatsAppText(fromWa, "Je n'ai pas bien saisi votre demande \ud83e\udd14 Pourriez-vous pr\u00e9ciser ?");
        return true;
      }

      await setConversationState(fromWa, "DIAG_DESCRIBE", "DIAG", { diagOption: selected.id, diagTitle: selected.title, diagDetail: selected.detail, diagPriceTtcCents: selected.priceTtcCents, diagDuration: selected.duration });
      const priceTxt = `${(selected.priceTtcCents / 100).toFixed(0)}€ TTC`;
      await sendWhatsAppInteractiveButtons(fromWa, `${selected.title} — ${priceTxt} (durée : ${selected.duration}) ✅\n\nPouvez-vous décrire votre problème en quelques lignes ? 📝\n(ex: voyant moteur allumé, le véhicule ne démarre plus, bruit anormal...)`, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      log.info("DIAG flow → option choisie, attente description", { wa_id: fromWa, option: selected.id });
      return true;
    }

    // --- DIAG_DESCRIBE ---
    if (convState.state === "DIAG_DESCRIBE" && intent === "DIAG") {
      const description = String(text || "").trim();

      if (description.length < 10) {
        await sendWhatsAppInteractiveButtons(fromWa,
          "Merci de décrire votre problème en quelques mots 📝\n(ex: voyant moteur allumé, perte de puissance, code défaut...)",
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        return true;
      }

      if (isLikelyQuestion(description)) {
        const fallback = await respondOrAnswerQuestion(fromWa, description,
          "Pouvez-vous décrire votre problème en quelques lignes ?",
          [{ id: "btn_back_menu", title: "🏠 Menu" }],
          rawMsg
        );
        if (fallback) return true;
      }

      const data = convState.data;
      // If a plate is embedded in the description (or already known), skip DIAG_PLATE
      let knownPlate = data._known_plate;
      if (!knownPlate) {
        const ex = extractAndValidatePlate?.(description);
        if (ex?.valid && ex?.plate) knownPlate = ex.plate;
      }

      if (knownPlate) {
        let vehicle = null;
        try { vehicle = await lookupVehicleFromPlate(knownPlate); } catch { /* non-blocking */ }
        const newData = { ...data, problemDescription: description, plate: knownPlate, vehicle, _known_plate: knownPlate };
        await setConversationState(fromWa, "DIAG_CONFIRM", "DIAG", newData);
        const priceTxt = `${(data.diagPriceTtcCents / 100).toFixed(0)}€ TTC`;
        const vehicleTxt = vehicle ? `${vehicle.make || ""} ${vehicle.model || ""}`.trim() : null;
        await sendWhatsAppInteractiveButtons(fromWa,
          `📋 *Récapitulatif de votre demande :*\n\n` +
          `🔍 Prestation : *${data.diagTitle}*\n` +
          `💰 Prix : *${priceTxt}* (durée : ${data.diagDuration})\n` +
          (vehicleTxt ? `🚗 Véhicule : ${vehicleTxt}\n` : "") +
          `🪪 Plaque : ${knownPlate}\n\n` +
          `📝 Votre problème :\n${description}\n\n` +
          `Souhaitez-vous confirmer cette demande ?`,
          [{ id: "diag_confirm_yes", title: "✅ Confirmer" }, { id: "diag_confirm_no", title: "❌ Annuler" }]
        );
        log.info("DIAG flow → plaque dans description, skip DIAG_PLATE", { wa_id: fromWa, plate: knownPlate });
      } else {
        await setConversationState(fromWa, "DIAG_PLATE", "DIAG", { ...data, problemDescription: description });
        await sendWhatsAppInteractiveButtons(fromWa,
          "Merci ! 👍\n\nQuelle est la plaque d'immatriculation de votre véhicule ?\n(ex: AB 123 CD)",
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        log.info("DIAG flow → description reçue, attente plaque", { wa_id: fromWa, descLen: description.length });
      }
      return true;
    }

    // --- DIAG_PLATE ---
    if (convState.state === "DIAG_PLATE" && intent === "DIAG") {
      let { valid, plate } = validatePlate(text);
      if (!valid && text) {
        const extracted = extractAndValidatePlate?.(text);
        if (extracted?.plate) { plate = extracted.plate; valid = extracted.valid; }
      }

      if (!valid && convState.data?._known_plate) {
        plate = convState.data._known_plate;
        valid = true;
        log.info("DIAG_PLATE → using previously accumulated plate", { wa_id: fromWa, plate });
      }

      if (!valid) {
        await sendWhatsAppInteractiveButtons(fromWa,
          "Je n'ai pas reconnu la plaque 😅\nEnvoyez-la au format AA 123 BB (avec ou sans tirets).",
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        return true;
      }

      let vehicle = null;
      try { vehicle = await lookupVehicleFromPlate(plate); } catch { /* non-bloquant */ }

      const data = convState.data;
      const priceTxt = `${(data.diagPriceTtcCents / 100).toFixed(0)}€ TTC`;
      const vehicleTxt = vehicle ? `${vehicle.make || ""} ${vehicle.model || ""}`.trim() : null;

      await setConversationState(fromWa, "DIAG_CONFIRM", "DIAG", { ...data, plate, vehicle });
      await sendWhatsAppInteractiveButtons(fromWa,
        `📋 *Récapitulatif de votre demande :*\n\n` +
        `🔍 Prestation : *${data.diagTitle}*\n` +
        `💰 Prix : *${priceTxt}* (durée : ${data.diagDuration})\n` +
        (vehicleTxt ? `🚗 Véhicule : ${vehicleTxt}\n` : "") +
        `🪪 Plaque : ${plate}\n\n` +
        `📝 Votre problème :\n${data.problemDescription}\n\n` +
        `Souhaitez-vous confirmer cette demande ?`,
        [
          { id: "diag_confirm_yes", title: "✅ Confirmer" },
          { id: "diag_confirm_no",  title: "❌ Annuler" },
        ]
      );
      log.info("DIAG flow → plaque enregistrée, attente confirmation", { wa_id: fromWa, plate });
      return true;
    }

    // --- DIAG_CONFIRM ---
    if (convState.state === "DIAG_CONFIRM" && intent === "DIAG") {
      const t = String(text || "").trim().toLowerCase();
      const isYes = buttonId === "diag_confirm_yes" || isConfirmation(t);
      const isNo = buttonId === "diag_confirm_no" || isDenial(t);

      if (isNo) { await clearConversationState(fromWa); await sendWhatsAppText(fromWa, "Demande annulée. N'hésitez pas à revenir ! 🙂"); return true; }
      if (!isYes) {
        return respondOrAnswerQuestion(fromWa, text, "Merci de confirmer ou annuler votre demande :", [
          { id: "diag_confirm_yes", title: "\u2705 Confirmer" }, { id: "diag_confirm_no", title: "\u274c Annuler" },
        ], rawMsg);
      }

      await setConversationState(fromWa, "DIAG_EMAIL", "DIAG", convState.data);

      // Si les coordonnées sont déjà connues, skip DIAG_EMAIL
      if (convState.data?._known_name && convState.data?._known_email && validateEmail(convState.data._known_email)) {
        log.info("DIAG_CONFIRM → contact déjà connu, skip DIAG_EMAIL", { wa_id: fromWa });
        const fakeConvState = { state: "DIAG_EMAIL", intent: "DIAG", data: convState.data };
        return handleLegacyPrestationStates(fromWa, "", rawMsg, fakeConvState, "DIAG", null);
      }

      await sendWhatsAppText(fromWa, buildContactRequestMsg(convState.data, "Parfait ! ✅\n\n"));
      log.info("DIAG flow → confirmé, attente coordonnées", { wa_id: fromWa });
      return true;
    }

    // --- DIAG_EMAIL ---
    if (convState.state === "DIAG_EMAIL" && intent === "DIAG") {
      const diagData = convState.data || {};
      const { customerName, customerEmail } = resolveContactFromState(diagData, text);
      log.info("DIAG_EMAIL: contact resolved", { wa_id: fromWa, customerName, hasEmail: !!validateEmail(customerEmail) });

      if (!customerName || customerName.length < 2) { await sendWhatsAppText(fromWa, "Je n'ai pas pu identifier votre nom 😅\nMerci d'envoyer votre nom complet :\n(ex: Dupont Jean)"); return true; }
      if (!customerEmail || !validateEmail(customerEmail)) { await sendWhatsAppText(fromWa, "L'adresse email ne semble pas valide 😅\nMerci d'envoyer votre adresse email :\n(ex: jean@mail.com)"); return true; }

      const data = convState.data;
      const priceTxt = `${(data.diagPriceTtcCents / 100).toFixed(0)}€ TTC`;
      const v = data.vehicle || {};
      const vehicleTxt = `${v.make || ""} ${v.model || ""}`.trim();
      const vehicleDetails = [v.trim, v.fuel, v.year ? `${v.year}` : ""].filter(Boolean).join(" | ");

      let devisId = "N/A";
      let devisRow = null;
      let htTxt = priceTxt;
      let ttcTxt = priceTxt;
      try {
        devisRow = await createDevis({ prestationCode: "diagnostic_complet", plate: data.plate, waId: fromWa, vehicleYear: v?.year || null, priceCentsOverride: data.diagPriceTtcCents, priceIsTtc: true });
        devisId = devisRow?.id ?? "N/A";
        htTxt = typeof devisRow?.total_ht_centimes === "number" ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€` : priceTxt;
        ttcTxt = typeof devisRow?.total_ttc_centimes === "number" ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€` : priceTxt;
        log.info("DIAG devis created", { wa_id: fromWa, devisId, option: data.diagOption });
      } catch (devisErr) { log.error("DIAG createDevis failed (non-blocking)", { wa_id: fromWa, error: String(devisErr?.message || devisErr) }); }

      await sendWhatsAppInteractiveButtons(fromWa,
        `✅ Demande de diagnostic enregistrée !\n\n📋 *Récapitulatif :*\n` +
        (devisId !== "N/A" ? `• Référence : DEV-${devisId}\n` : "") +
        `• Prestation : ${data.diagTitle}\n• Détail : ${data.diagDetail}\n• Prix : ${priceTxt}\n• Durée estimée : ${data.diagDuration}\n` +
        `• Véhicule : ${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""}\n• Plaque : ${data.plate}\n• Problème : ${data.problemDescription}\n\n` +
        `👤 *Vos coordonnées :*\n• Nom : ${customerName}\n• Email : ${customerEmail}\n\nNotre équipe vous recontactera très rapidement pour fixer un créneau. 📞`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );

      if (devisRow?.isNew) broadcastDashboardEvent("new_devis", { devisId, plate: data.plate || "", wa_id: fromWa, prestation: data.diagTitle, ttc: ttcTxt });
      if (devisId !== "N/A") sendQuotePdf(fromWa, { devisId, plate: data.plate, vehicle: v, prestationLabel: data.diagTitle, devisRow, customerName, customerEmail, customerPhone: fromWa }).catch(() => {});

      const diagNameParts = customerName.split(/\s+/);
      const diagLastName = diagNameParts[0] || "";
      const diagFirstName = diagNameParts.slice(1).join(" ") || "";
      const diagDevisRef = devisId !== "N/A" ? `DEV-${devisId}` : "—";
      const diagVehicleDesc = `${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""}`;

      try {
        await sendContactRecapEmail({ lastName: diagLastName, firstName: diagFirstName, contact: customerEmail || fromWa, prestation: `${data.diagTitle} (${priceTxt} — ${data.diagDuration})`, plate: data.plate, vehicleDesc: `${diagVehicleDesc} — Problème : ${data.problemDescription}` });
      } catch (emailErr) { log.error("Erreur envoi email notif diagnostic (garage)", { wa_id: fromWa, error: String(emailErr?.message || emailErr) }); }

      try {
        await sendRdvClientEmail({ to: customerEmail, firstName: diagFirstName, lastName: diagLastName, vehicleDesc: diagVehicleDesc, prestationLabel: `${data.diagTitle} — ${data.diagDuration}`, devisRef: diagDevisRef, htTxt, ttcTxt, contactReason: "devis" });
      } catch (emailErr) { log.error("Erreur envoi email confirmation client diagnostic", { wa_id: fromWa, error: String(emailErr?.message || emailErr) }); }

      try {
        await notifyGarage(
          `🔍 NOUVELLE DEMANDE DIAGNOSTIC\nPrestation : ${data.diagTitle}\nPrix : ${priceTxt}\nDurée : ${data.diagDuration}\n` +
          `Véhicule : ${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""}\nPlaque : ${data.plate}\nProblème : ${data.problemDescription}\n\n` +
          `Client : ${customerName}\nEmail : ${customerEmail}\nWhatsApp : ${fromWa}\nDate : ${new Date().toISOString()}`
        );
      } catch (notifErr) { log.error("Erreur notif garage diagnostic", { wa_id: fromWa, error: String(notifErr?.message || notifErr) }); }

      await clearConversationState(fromWa);
      log.info("DIAG flow → terminé", { wa_id: fromWa, option: data.diagOption, customerName });
      return true;
    }

    return false;
  }

  return { handlePrestationFlow, PRESTATION_INTENTS };
}

module.exports = { createPrestationFlow };

