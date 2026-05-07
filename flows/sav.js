const { extractInteractiveId, validatePlate, validateEmail } = require("../lib/text-helpers");
const { detectIntent } = require("../lib/intent-detector");
const { lookupVehicleFromPlate, buildVehicleOnlyText } = require("../lib/vehicle-service");

/**
 * Factory: creates the SAV flow handler.
 * @param {object} ctx - All dependencies from server.js
 */
function createSavFlow(ctx) {
  const {
    supabase, log,
    sendWhatsAppInteractiveButtons, sendWhatsAppImage,
    setConversationState, clearConversationState, getConversationState,
    notifyGarage, getVehicleImageUrl,
    sendSavClientEmail, sendSavDiagperfEmail,
  } = ctx;

  // ====== SAV flow handler ======
  async function handleSavFlow(fromWa, text, rawMsg) {
    const convState = await getConversationState(fromWa);

    // --- Détection intent SAV (pas d'état en cours) ---
    if (!convState || !convState.state) {
      const intent = detectIntent(text);
      if (intent === "SAV") {
        await setConversationState(fromWa, "SAV_TOPIC", "SAV", {});
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `🛠️ SAV DiagPerf\n\nQuel est le sujet de votre demande ?`,
          [
            { id: "sav_topic_1", title: "Après prestation" },
            { id: "sav_topic_2", title: "Garantie" },
            { id: "sav_topic_3", title: "Autre" },
          ]
        );
        return true;
      }
      return false;
    }

    if (convState.intent !== "SAV") return false;

    const t = String(text || "").trim();

    // --- Étape 1 : Sujet ---
    if (convState.state === "SAV_TOPIC") {
      const buttonId = extractInteractiveId(rawMsg);
      const topicMap = {
        "sav_topic_1": "Problème après prestation",
        "sav_topic_2": "Garantie",
        "sav_topic_3": "Autre",
        "1": "Problème après prestation",
        "2": "Garantie",
        "3": "Autre",
      };
      const topic = topicMap[buttonId] || topicMap[t] || null;

      if (!topic) {
        await sendWhatsAppInteractiveButtons(fromWa, "Veuillez choisir une option dans la liste.", [
          { id: "sav_topic_1", title: "Après prestation" },
          { id: "sav_topic_2", title: "Garantie" },
          { id: "sav_topic_3", title: "Autre" },
        ]);
        return true;
      }
      await setConversationState(fromWa, "SAV_COORDINATES", "SAV", { topic });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Veuillez saisir vos coordonnées en un seul message au format :\n\n*Nom Prénom Email*\n\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "\ud83c\udfe0 Menu" }]
      );
      return true;
    }

    // --- Étape 2 : Coordonnées (Nom + Prénom + Email) ---
    if (convState.state === "SAV_COORDINATES") {
      const parts = t.split(/\s+/);
      const emailPart = parts.find(p => p.includes("@"));
      const email = validateEmail(emailPart);
      const nameParts = parts.filter(p => !p.includes("@"));
      const customerName = nameParts.join(" ") || "";

      if (!email || customerName.length < 2) {
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `Je n'ai pas compris 😅\nVeuillez envoyer au format : *Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        return true;
      }

      await setConversationState(fromWa, "SAV_PLATE", "SAV", {
        ...convState.data,
        customer_name: customerName,
        customer_email: email,
      });
      await sendWhatsAppInteractiveButtons(fromWa, "Veuillez envoyer la plaque d'immatriculation du véhicule concerné (ex: AA 001 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    // --- Étape 3 : Plaque d'immatriculation ---
    if (convState.state === "SAV_PLATE") {
      const { valid, plate } = validatePlate(t);

      if (!valid) {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas reconnu la plaque 😅\nEnvoyez-la au format AA 123 BB (avec ou sans tirets).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      try {
        const vehicle = await lookupVehicleFromPlate(plate);
        await setConversationState(fromWa, "SAV_VEHICLE_CONFIRM", "SAV", { ...convState.data, plate, vehicle });
        // Send vehicle image (best effort, non-blocking)
        getVehicleImageUrl(vehicle).then(savImgUrl => {
          if (savImgUrl) {
            sendWhatsAppImage(fromWa, savImgUrl, `🚘 ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}${vehicle.year ? ` (${vehicle.year})` : ""}`).catch(imgErr => {
              log.debug("SAV vehicle image failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
            });
          }
        }).catch(e => log.debug("SAV vehicle image URL lookup failed", { error: String(e?.message || e) }));
        await sendWhatsAppInteractiveButtons(fromWa, buildVehicleOnlyText(vehicle), [
          { id: "sav_vehicle_yes", title: "✅ Oui, c'est bon" },
          { id: "sav_vehicle_no", title: "❌ Non" },
          { id: "btn_back_menu", title: "🏠 Menu" },
        ]);
        return true;
      } catch (err) {
        log.error("SAV: erreur lookup véhicule", { wa_id: fromWa, error: String(err?.message || err) });
        await setConversationState(fromWa, "SAV_VEHICLE_MANUAL", "SAV", { ...convState.data, plate });
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas trouvé ce véhicule 😕\nVeuillez indiquer : Marque Modèle Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }
    }

    // --- Étape 3b : Confirmation véhicule détecté ---
    if (convState.state === "SAV_VEHICLE_CONFIRM") {
      const buttonId = extractInteractiveId(rawMsg);
      const tLow = t.toLowerCase();

      if (tLow === "oui" || tLow === "o" || tLow === "yes" || buttonId === "sav_vehicle_yes") {
        const vehicle = convState.data?.vehicle || {};
        const vDesc = [vehicle.make, vehicle.model, vehicle.fuel, vehicle.power_hp ? `${vehicle.power_hp}ch` : null, vehicle.year].filter(Boolean).join(" ");
        await setConversationState(fromWa, "SAV_DESCRIPTION", "SAV", {
          ...convState.data,
          vehicle: vDesc || "N/A",
        });
        await sendWhatsAppInteractiveButtons(fromWa, "Décrivez votre problème en quelques lignes :", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      if (tLow === "non" || tLow === "n" || tLow === "no" || buttonId === "sav_vehicle_no") {
        await setConversationState(fromWa, "SAV_VEHICLE_MANUAL", "SAV", { ...convState.data });
        await sendWhatsAppInteractiveButtons(fromWa, "Veuillez indiquer : Marque Modèle Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      await sendWhatsAppInteractiveButtons(fromWa, "Répondez par *oui* si c'est bien votre véhicule, ou *non* dans le cas contraire.", [
        { id: "sav_vehicle_yes", title: "✅ Oui, c'est bon" },
        { id: "sav_vehicle_no", title: "❌ Non" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      return true;
    }

    // --- Étape 3c : Saisie manuelle du véhicule (fallback) ---
    if (convState.state === "SAV_VEHICLE_MANUAL") {
      if (t.length < 2) {
        await sendWhatsAppInteractiveButtons(fromWa, "Merci d'indiquer le véhicule concerné (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }
      await setConversationState(fromWa, "SAV_DESCRIPTION", "SAV", {
        ...convState.data,
        vehicle: t,
      });
      await sendWhatsAppInteractiveButtons(fromWa, "Décrivez votre problème en quelques lignes :", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    // --- Étape 5 : Description → insertion ticket ---
    if (convState.state === "SAV_DESCRIPTION") {
      if (t.length < 5) {
        await sendWhatsAppInteractiveButtons(fromWa, "Merci de décrire le problème un peu plus en détail (au moins quelques mots).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        return true;
      }

      const customerName = convState.data?.customer_name || "";
      const customerEmail = convState.data?.customer_email || "";
      const vehicleDesc = convState.data?.vehicle || "";
      const plate = convState.data?.plate || "";
      const nameParts = customerName.split(/\s+/);
      const savLastName = nameParts[0] || "";
      const savFirstName = nameParts.slice(1).join(" ") || "";

      const ticketData = {
        wa_id: fromWa,
        topic: convState.data?.topic || null,
        customer_name: customerName || null,
        customer_phone: customerEmail || "",
        customer_email: customerEmail || null,
        vehicle: vehicleDesc || null,
        description: t,
        last_message_at: new Date().toISOString(),
      };

      try {
        const { data: ticket, error: ticketErr } = await supabase
          .from("sav_tickets")
          .insert(ticketData)
          .select("id, reference")
          .single();

        if (ticketErr) throw ticketErr;

        await clearConversationState(fromWa);

        const savRef = `SAV-${ticket.id}`;
        const ref = ticket.reference || savRef;
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `✅ Demande SAV enregistrée\n` +
          `Référence : ${ref}\n` +
          `Sujet : ${ticketData.topic}\n\n` +
          `📧 Un récapitulatif a été envoyé à ${customerEmail}.\n` +
          `Notre équipe vous recontactera dans les 24h.`,
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );

        // Emails + notification garage (best effort)
        try {
          await Promise.all([
            sendSavClientEmail({
              to: customerEmail,
              firstName: savFirstName,
              lastName: savLastName,
              savRef,
              topic: ticketData.topic || "N/A",
              vehicleDesc: vehicleDesc || "N/A",
              description: t,
            }),
            sendSavDiagperfEmail({
              firstName: savFirstName,
              lastName: savLastName,
              clientEmail: customerEmail,
              waId: fromWa,
              vehicleDesc: vehicleDesc || "N/A",
              plate: plate || "N/A",
              topic: ticketData.topic || "N/A",
              description: t,
              savRef,
            }),
            notifyGarage(
              `🛠️ NOUVEAU TICKET SAV\n` +
              `Réf : ${ref}\n` +
              `Sujet : ${ticketData.topic || "N/A"}\n` +
              `Client : ${customerName || "N/A"} (${fromWa})\n` +
              `Email : ${customerEmail || "N/A"}\n` +
              `Véhicule : ${vehicleDesc || "N/A"}\n` +
              `Description : ${t || "N/A"}\n` +
              `Date : ${new Date().toISOString()}`
            ),
          ]);
        } catch (emailErr) {
          log.error("SAV: erreur envoi emails/notification", { wa_id: fromWa, error: String(emailErr?.message || emailErr) });
        }
      } catch (err) {
        log.error("Erreur création ticket SAV", { wa_id: fromWa, error: String(err?.message || err) });
        await sendWhatsAppInteractiveButtons(
          fromWa,
          "Désolé, j'ai eu un souci pour enregistrer ta demande 😕\nRéessaie dans quelques instants.",
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
      }
      return true;
    }

    return false;
  }

  return { handleSavFlow };
}

module.exports = { createSavFlow };
