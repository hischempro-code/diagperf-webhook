// ====== Conversation Memory ======
// Gère la mémoire long-terme par client :
//   - Profil client (véhicules, prestations discutées, objections, ton)
//   - Résumé condensé des conversations longues
//
// Stockage : `conversations.contexte_json` (JSONB) — pas de nouvelle table.
// Structure :
//   {
//     profile: {
//       first_name, last_name, email, phone,
//       vehicles: [ { make, model, year, fuel, plate, first_seen } ],
//       prestations_discussed: ["REPROG","FAP",...],
//       prestations_completed: ["REPROG"],
//       objections_raised: ["prix","garantie",...],
//       preferred_tone: "tu" | "vous",
//       first_contact_at, last_contact_at,
//       total_user_messages,
//     },
//     summary: {
//       text: "Le client a demandé...",
//       covers_until_ts: 1234567,
//       generated_at: "ISO",
//     }
//   }
//
// Toutes les fonctions sont best-effort (n'échouent jamais en cascade).

"use strict";

// ====== Helpers internes ======

const KNOWN_PRESTATIONS = ["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES", "SAV"];

const PRESTATION_KEYWORDS = [
  { code: "REPROG", re: /\b(reprog|reprogramm|stage\s*[1234]|cartograph|optimisation\s*moteur|gain\s*de\s*puissance)\b/i },
  { code: "E85",    re: /\b(e85|[ée]thanol|flexfuel|bio[ée]thanol|conversion\s*[ée]thanol)\b/i },
  { code: "FAP",    re: /\b(fap|filtre\s*[aà]\s*particules|suppression\s*fap)\b/i },
  { code: "EGR",    re: /\b(egr|vanne\s*egr|recirculation\s*gaz)\b/i },
  { code: "ADBLUE", re: /\b(adblue|ad\s*blue|scr|nox)\b/i },
  { code: "DIAG",   re: /\b(diagnostic|diag(\s|$)|recherche\s*panne|valise|obd|code\s*d[ée]faut)\b/i },
];

const OBJECTION_PATTERNS = [
  { type: "prix",      re: /\b(c'?est\s*cher|trop\s*cher|prix\s*[ée]lev[ée]|hors\s*budget|pas\s*les\s*moyens|n[ée]gocier|moins\s*cher|moins\s*chez)\b/i },
  { type: "garantie",  re: /\b(garantie|garanti|s'?il\s*casse|si\s*[çc]a\s*p[èe]te|si\s*[çc]a\s*foire|et\s*si\s*[çc]a)\b/i },
  { type: "fiabilite", re: /\b(fiable|risqu[ée]?|abimer?\s*le\s*moteur|abime\s*le\s*moteur|durera|tient\s*combien|c'?est\s*s[ûu]r|pas\s*s[ûu]r)\b/i },
  { type: "legal",     re: /\b(l[ée]gal|ill[ée]gal|carte\s*grise|contr[ôo]le\s*technique|\bct\b|assurance|d[ée]clarer)\b/i },
  { type: "delai",     re: /\b(d[ée]lai|combien\s*de\s*temps|quand\s*(je\s*peux|est-ce|pourrai-je)|disponibilit[ée]|cr[ée]neau|rdv\s*quand)\b/i },
  { type: "qualite",   re: /\b(qualit[ée]|s[ée]rieux|pro|professionnel|amateur|bricol)\b/i },
];

// Tutoiement vs vouvoiement (heuristique simple)
const TU_RE = /\b(tu|t'|toi|ton|ta|tes|te\s+|fais-tu|veux-tu|peux-tu)\b/i;
const VOUS_RE = /\b(vous|votre|vos|monsieur|madame|m'sieur)\b/i;

// ====== Profil : lecture / écriture ======

/**
 * Récupère le profil client depuis conversations.contexte_json.
 * Retourne un profil vide si pas trouvé.
 *
 * @param {object} supabase - client Supabase
 * @param {string} waId - WhatsApp ID (= wa_phone)
 * @returns {Promise<object>}
 */
async function getClientProfile(supabase, waId) {
  try {
    const { data } = await supabase
      .from("conversations")
      .select("contexte_json")
      .eq("wa_phone", waId)
      .maybeSingle();

    const ctx = data?.contexte_json || {};
    return {
      profile: ctx.profile || {},
      summary: ctx.summary || null,
    };
  } catch {
    return { profile: {}, summary: null };
  }
}

/**
 * Merge partiel dans le profil client.
 * @param {object} supabase
 * @param {string} waId
 * @param {object} partial - patch à merger dans contexte_json.profile
 */
async function updateClientProfile(supabase, waId, partial) {
  try {
    const { data } = await supabase
      .from("conversations")
      .select("id, contexte_json")
      .eq("wa_phone", waId)
      .maybeSingle();

    const id = data?.id;
    if (!id) return; // Pas encore de conversation, on ne crée rien ici

    const ctx = data.contexte_json || {};
    const prev = ctx.profile || {};
    const merged = mergeProfile(prev, partial);

    await supabase
      .from("conversations")
      .update({ contexte_json: { ...ctx, profile: merged } })
      .eq("id", id);
  } catch {
    /* best-effort */
  }
}

/**
 * Merge intelligent : array unique, dates conservées, compteur incrémenté.
 */
function mergeProfile(prev, patch) {
  const out = { ...prev };

  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val == null) continue;

    if (Array.isArray(val) && Array.isArray(out[key])) {
      // Union sans doublons (par valeur scalaire ou par "plate" pour vehicles)
      if (key === "vehicles") {
        const map = new Map();
        for (const v of [...(out[key] || []), ...val]) {
          const k = (v.plate || `${v.make || ""}_${v.model || ""}_${v.year || ""}`).toLowerCase();
          if (!map.has(k)) map.set(k, v);
        }
        out[key] = Array.from(map.values());
      } else {
        out[key] = Array.from(new Set([...(out[key] || []), ...val]));
      }
    } else if (key === "total_user_messages" && typeof val === "number") {
      out[key] = (out[key] || 0) + val;
    } else {
      out[key] = val;
    }
  }

  // Toujours mettre à jour last_contact_at si modification
  out.last_contact_at = new Date().toISOString();
  if (!out.first_contact_at) out.first_contact_at = out.last_contact_at;

  return out;
}

// ====== Extraction de signaux depuis un message ======

/**
 * Analyse un message client et retourne les signaux à merger dans le profil.
 * @param {string} text - Message reçu
 * @param {object} [prevProfile]
 * @param {object} [opts] - { vehicleFromState, customerName, customerEmail, plateFromState }
 * @returns {object} patch à passer à updateClientProfile
 */
function extractProfileSignals(text, prevProfile = {}, opts = {}) {
  const t = String(text || "");
  const patch = { total_user_messages: 1 };

  // Tutoiement vs vouvoiement
  if (TU_RE.test(t)) patch.preferred_tone = "tu";
  else if (VOUS_RE.test(t)) patch.preferred_tone = "vous";

  // Prestations mentionnées
  const presta = [];
  for (const p of PRESTATION_KEYWORDS) {
    if (p.re.test(t)) presta.push(p.code);
  }
  if (presta.length > 0) patch.prestations_discussed = presta;

  // Objections soulevées
  const objections = [];
  for (const o of OBJECTION_PATTERNS) {
    if (o.re.test(t)) objections.push(o.type);
  }
  if (objections.length > 0) patch.objections_raised = objections;

  // Véhicule depuis le state actif (si fourni par l'appelant)
  if (opts.vehicleFromState) {
    const v = opts.vehicleFromState;
    const veh = {
      make: v.make || null,
      model: v.model || null,
      year: v.year || null,
      fuel: v.fuel || null,
      plate: opts.plateFromState || v.plate || null,
      first_seen: new Date().toISOString(),
    };
    if (veh.make || veh.model || veh.plate) {
      patch.vehicles = [veh];
    }
  }

  // Coordonnées (depuis flow)
  if (opts.customerName) {
    const parts = String(opts.customerName).trim().split(/\s+/);
    if (parts.length >= 2) {
      patch.last_name = parts[0];
      patch.first_name = parts.slice(1).join(" ");
    } else if (parts[0]) {
      patch.first_name = parts[0];
    }
  }
  if (opts.customerEmail) patch.email = opts.customerEmail;

  return patch;
}

// ====== Construction du contexte LLM ======

/**
 * Construit le bloc texte à injecter dans le system prompt.
 * Retourne "" si rien d'intéressant à dire.
 */
function buildMemoryContext({ profile, summary }) {
  if (!profile && !summary) return "";

  const lines = [];
  const hasProfileInfo =
    profile && (
      profile.first_name ||
      profile.email ||
      (Array.isArray(profile.vehicles) && profile.vehicles.length > 0) ||
      (Array.isArray(profile.prestations_discussed) && profile.prestations_discussed.length > 0) ||
      (Array.isArray(profile.objections_raised) && profile.objections_raised.length > 0) ||
      profile.preferred_tone
    );

  if (hasProfileInfo) {
    lines.push("PROFIL CLIENT (utilise ces infos pour personnaliser ta réponse) :");
    if (profile.first_name) {
      lines.push(`• Prénom : ${profile.first_name}${profile.last_name ? " " + profile.last_name : ""}`);
    }
    if (profile.email) lines.push(`• Email connu : ${profile.email}`);
    if (profile.preferred_tone === "vous") {
      lines.push(`• Ton préféré : VOUVOIEMENT (le client préfère le vouvoiement)`);
    }
    if (Array.isArray(profile.vehicles) && profile.vehicles.length > 0) {
      lines.push("• Véhicule(s) connu(s) :");
      for (const v of profile.vehicles.slice(0, 3)) {
        const desc = [v.make, v.model, v.year, v.fuel].filter(Boolean).join(" ");
        lines.push(`  - ${desc || "véhicule"}${v.plate ? ` (plaque ${v.plate})` : ""}`);
      }
    }
    if (Array.isArray(profile.prestations_discussed) && profile.prestations_discussed.length > 0) {
      lines.push(`• Déjà discuté : ${profile.prestations_discussed.join(", ")}`);
    }
    if (Array.isArray(profile.prestations_completed) && profile.prestations_completed.length > 0) {
      lines.push(`• Prestations RÉALISÉES : ${profile.prestations_completed.join(", ")} (client existant !)`);
    }
    if (Array.isArray(profile.objections_raised) && profile.objections_raised.length > 0) {
      lines.push(`• Objections déjà soulevées : ${profile.objections_raised.join(", ")} (anticipe-les ou évite de les rouvrir inutilement)`);
    }
    if (typeof profile.total_user_messages === "number" && profile.total_user_messages >= 10) {
      lines.push(`• Client connu : ${profile.total_user_messages} messages échangés`);
    }
  }

  if (summary && summary.text) {
    if (lines.length > 0) lines.push("");
    lines.push("RÉSUMÉ DES ÉCHANGES PRÉCÉDENTS :");
    lines.push(summary.text.trim());
  }

  return lines.join("\n");
}

// ====== Résumé automatique (LLM) ======

/**
 * Décide s'il faut générer/régénérer un résumé.
 * On résume si :
 *   - le client a > N messages totaux
 *   - et soit pas de résumé, soit le résumé date de >7j ou >15 nouveaux messages
 */
function shouldSummarize({ profile, summary }, totalMessages) {
  if (!totalMessages || totalMessages < 20) return false;
  if (!summary || !summary.text) return true;

  const ageMs = Date.now() - new Date(summary.generated_at || 0).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) return true;

  const newMsgs = totalMessages - (summary.covers_until_message_count || 0);
  if (newMsgs >= 15) return true;

  return false;
}

/**
 * Génère un résumé via Claude (Haiku, court, économique) et le stocke.
 *
 * @param {object} deps - { supabase, fetchFn, anthropicKey, model, log }
 * @param {string} waId
 * @param {Array} messages - liste { role, content } chronologique
 */
async function summarizeAndStore(deps, waId, messages) {
  const { supabase, fetchFn, anthropicKey, model, log } = deps;
  if (!anthropicKey || !messages || messages.length < 5) return;

  // Garder la conversation au format Claude
  const transcript = messages
    .map(m => `${m.role === "user" ? "Client" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(0, 12000); // protection taille

  const systemPrompt = `Tu es un assistant qui résume de façon factuelle et concise (3-5 phrases max) une conversation WhatsApp entre un client et le bot du garage DiagPerf. Mentionne UNIQUEMENT :
- les prestations discutées et leur état (devis fait ? RDV pris ?)
- le véhicule du client si mentionné
- les objections ou inquiétudes du client
- les engagements pris par le bot
N'invente RIEN. Sois factuel. Pas de salutations, pas de meta-commentaires.`;

  try {
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || "claude-haiku-4-5-20251001",
        system: systemPrompt,
        messages: [{ role: "user", content: `Résume cette conversation :\n\n${transcript}` }],
        temperature: 0.2,
        max_tokens: 300,
      }),
    });

    if (!resp.ok) {
      log?.warn?.("summarizeAndStore: API non-200", { status: resp.status });
      return;
    }

    const json = await resp.json();
    const text = json?.content?.[0]?.text?.trim();
    if (!text) return;

    // Stocker dans contexte_json.summary
    const { data } = await supabase
      .from("conversations")
      .select("id, contexte_json")
      .eq("wa_phone", waId)
      .maybeSingle();

    if (!data?.id) return;

    const ctx = data.contexte_json || {};
    await supabase
      .from("conversations")
      .update({
        contexte_json: {
          ...ctx,
          summary: {
            text,
            generated_at: new Date().toISOString(),
            covers_until_message_count: messages.length,
          },
        },
      })
      .eq("id", data.id);

    log?.info?.("Conversation résumée", { wa_id: waId, msgCount: messages.length, summaryLen: text.length });
  } catch (err) {
    log?.warn?.("summarizeAndStore failed", { wa_id: waId, error: String(err?.message || err) });
  }
}

module.exports = {
  getClientProfile,
  updateClientProfile,
  extractProfileSignals,
  buildMemoryContext,
  shouldSummarize,
  summarizeAndStore,
  // exposé pour tests
  PRESTATION_KEYWORDS,
  OBJECTION_PATTERNS,
};
