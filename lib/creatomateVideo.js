// ====== Creatomate — Stage Gains Video Rendering ======
// Renders a personalized video showcasing power/torque gains for a specific stage
// Docs : https://creatomate.com/docs/api/rest-api/introduction
//
// Required env vars :
//   CREATOMATE_API_KEY  (https://creatomate.com/dashboard/api-keys)
//   CREATOMATE_TEMPLATE_ID  (the template UUID, from the template editor URL)
//
// Template placeholder names expected (case-sensitive, must match exactly in Creatomate) :
//   vehicle_name        → "CITROEN C3"
//   vehicle_engine      → "1.4 HDi 68ch"
//   stage_label         → "STAGE 1"
//   hp_before           → "68"
//   hp_after            → "100"
//   hp_gain             → "+32"
//   torque_before       → "160"
//   torque_after        → "230"
//   torque_gain         → "+70"
//   zero_to_hundred     → "-2.4s" (optional, computed)
//   price_ttc           → "390€ TTC"

"use strict";

const log = {
  info: (...a) => console.log("[creatomate]", ...a),
  warn: (...a) => console.warn("[creatomate]", ...a),
  error: (...a) => console.error("[creatomate]", ...a),
};

/**
 * Estime le gain de 0-100 km/h en secondes (ratio puissance/poids).
 * Formule simplifiée : t ≈ k * poids^0.5 / puissance
 * Retourne un texte "-1.8s" ou null si données insuffisantes.
 */
function estimateZeroToHundredGain(hpBefore, hpAfter, weightKg = 1200) {
  if (!hpBefore || !hpAfter || hpBefore <= 0 || hpAfter <= 0) return null;
  const k = 0.65;
  const tBefore = k * Math.sqrt(weightKg) / Math.sqrt(hpBefore) * 3.4;
  const tAfter = k * Math.sqrt(weightKg) / Math.sqrt(hpAfter) * 3.4;
  const gain = tBefore - tAfter;
  if (gain <= 0) return null;
  return `-${gain.toFixed(1)}s`;
}

/**
 * Appelle l'API Creatomate pour générer la vidéo.
 * @returns {Promise<string|null>} URL du MP4 rendu, ou null si échec
 */
async function renderStageGainsVideo({ vehicle, stage, stageLabel, priceTtc }) {
  const apiKey = process.env.CREATOMATE_API_KEY;
  const templateId = process.env.CREATOMATE_TEMPLATE_ID;

  if (!apiKey || !templateId) {
    log.warn("Creatomate not configured (missing CREATOMATE_API_KEY or CREATOMATE_TEMPLATE_ID)");
    return null;
  }
  if (!vehicle || !stage) {
    log.warn("renderStageGainsVideo: missing vehicle or stage");
    return null;
  }

  const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ").toUpperCase();
  const engineTxt = [
    vehicle.engine_cc ? `${(vehicle.engine_cc / 1000).toFixed(1)}L` : null,
    vehicle.fuel,
    stage.puissance_origine ? `${stage.puissance_origine}ch` : null,
  ].filter(Boolean).join(" ");

  const hpBefore = stage.puissance_origine || 0;
  const hpAfter = stage.puissance_apres || 0;
  const hpGain = stage.gain_puissance || (hpAfter - hpBefore);
  const torqueBefore = stage.couple_origine || 0;
  const torqueAfter = stage.couple_apres || 0;
  const torqueGain = stage.gain_couple || (torqueAfter - torqueBefore);

  const zeroToHundredTxt = estimateZeroToHundredGain(hpBefore, hpAfter) || "";

  // Creatomate modification format: "ElementName.property"
  // We target .text for text elements. Element names in the template must match exactly.
  const modifications = {
    "vehicle_name.text": vehicleName || "VOTRE VÉHICULE",
    "vehicle_engine.text": engineTxt || "",
    "stage_label.text": (stageLabel || "STAGE 1").toUpperCase(),
    "hp_before.text": String(hpBefore),
    "hp_after.text": String(hpAfter),
    "hp_gain.text": `+${hpGain}`,
    "torque_before.text": String(torqueBefore),
    "torque_after.text": String(torqueAfter),
    "torque_gain.text": `+${torqueGain}`,
    "zero_to_hundred.text": zeroToHundredTxt,
    "price_ttc.text": priceTtc || "",
  };

  try {
    log.info("Submitting render", { vehicleName, stageLabel, hpBefore, hpAfter });

    const resp = await fetch("https://api.creatomate.com/v2/renders", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template_id: templateId,
        modifications,
        // Creatomate synchronously waits up to 30s. If longer, returns "planned" + we poll.
      }),
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      log.error("API error", { status: resp.status, body: errTxt.slice(0, 300) });
      return null;
    }

    const json = await resp.json();
    // API returns array or single object depending on count
    const render = Array.isArray(json) ? json[0] : json;
    if (!render) {
      log.error("Empty response");
      return null;
    }

    // If immediately ready
    if (render.status === "succeeded" && render.url) {
      log.info("Render ready immediately", { id: render.id });
      return render.url;
    }

    // Otherwise poll (max 45s)
    if (render.id) {
      const url = await pollRenderStatus(apiKey, render.id, 45000);
      if (url) return url;
    }

    log.warn("Render did not complete in time", { status: render.status, id: render.id });
    return null;
  } catch (err) {
    log.error("Unexpected error", { error: String(err?.message || err) });
    return null;
  }
}

/**
 * Poll jusqu'à ce que le render soit terminé ou timeout.
 */
async function pollRenderStatus(apiKey, renderId, timeoutMs = 45000) {
  const start = Date.now();
  const intervalMs = 2500;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const resp = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
        // Note: status polling still uses v1 (per Creatomate docs)
        headers: { "Authorization": `Bearer ${apiKey}` },
      });
      if (!resp.ok) continue;
      const render = await resp.json();
      if (render.status === "succeeded" && render.url) {
        log.info("Render completed", { id: renderId, elapsedMs: Date.now() - start });
        return render.url;
      }
      if (render.status === "failed") {
        log.error("Render failed", { id: renderId, error: render.error_message });
        return null;
      }
    } catch (err) {
      log.warn("Poll error (continuing)", { error: String(err?.message || err) });
    }
  }
  return null;
}

module.exports = { renderStageGainsVideo };
