const { normalizePlate } = require("./text-helpers");
const { UPSELL_OPTIONS } = require("./vehicle-service");

let _supabase = null;
let _log = null;

function initDevisService({ supabase, log }) {
  _supabase = supabase;
  _log = log;
}

// ====== Generic pricing from tarifs_prestations ======
async function getPrestationTarif(prestationCode) {
  const { data: presta, error: pErr } = await _supabase
    .from("prestations")
    .select("id")
    .eq("code", prestationCode)
    .maybeSingle();

  if (pErr) {
    _log.error("getPrestationTarif: erreur lookup prestation", { prestationCode, error: pErr.message });
    return null;
  }
  if (!presta) {
    _log.warn("getPrestationTarif: prestation inconnue", { prestationCode });
    return null;
  }

  const { data, error } = await _supabase
    .from("tarifs_prestations")
    .select("prix_base_centimes")
    .eq("prestation_id", presta.id)
    .eq("actif", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    _log.error("getPrestationTarif: erreur DB tarif", { prestationCode, error: error.message });
    return null;
  }
  return data; // null = pas de tarif trouvé
}

async function getPrestationLibelle(prestationCode) {
  const { data, error } = await _supabase
    .from("prestations")
    .select("nom")
    .eq("code", prestationCode)
    .maybeSingle();

  if (error || !data) return prestationCode;
  return data.nom;
}

// ====== Generic devis creation ======
// FIX #2 : nouveau paramètre `priceIsTtc` pour distinguer HT vs TTC
async function createDevis({ prestationCode, plate, waId, vehicleYear, priceCentsOverride, priceIsTtc }) {
  if (!plate || typeof plate !== "string" || !plate.trim()) {
    _log.error("createDevis: plaque invalide", { plate });
    throw new Error("INVALID_PLATE");
  }
  if (!prestationCode) {
    _log.error("createDevis: prestationCode manquant");
    throw new Error("INVALID_PRESTATION");
  }

  const tauxTva = 0.20;
  let totalHt, totalTva, totalTtc;

  if (typeof priceCentsOverride === "number" && priceCentsOverride > 0) {
    // FIX #2 : si le prix fourni est déjà TTC, on en déduit le HT
    if (priceIsTtc) {
      totalTtc = priceCentsOverride;
      totalHt  = Math.round(totalTtc / (1 + tauxTva));
      totalTva = totalTtc - totalHt;
    } else {
      totalHt  = priceCentsOverride;
      totalTva = Math.round(totalHt * tauxTva);
      totalTtc = totalHt + totalTva;
    }
  } else if (priceCentsOverride === null) {
    _log.warn("createDevis: prix sur devis personnalisé (override null)", { prestationCode });
    throw new Error("NO_TARIF");
  } else {
    const tarif = await getPrestationTarif(prestationCode);
    if (!tarif || !tarif.prix_base_centimes || tarif.prix_base_centimes <= 0) {
      _log.warn("createDevis: pas de tarif trouvé", { prestationCode });
      throw new Error("NO_TARIF");
    }
    totalHt  = tarif.prix_base_centimes;
    totalTva = Math.round(totalHt * tauxTva);
    totalTtc = totalHt + totalTva;
  }

  const libelle = await getPrestationLibelle(prestationCode);

  const idempotencyKey = `${prestationCode}:${normalizePlate(plate)}:${waId || "anon"}:${totalTtc}`;

  const { data: devis, error: devisErr } = await _supabase
    .from("devis")
    .insert({
      plaque: plate,
      prestation_code: prestationCode,
      wa_id: waId || null,
      total_ht_centimes: totalHt,
      taux_tva: tauxTva,
      total_tva_centimes: totalTva,
      total_ttc_centimes: totalTtc,
      source: "whatsapp",
      statut: "draft",
      idempotency_key: idempotencyKey,
    })
    .select("id, total_ht_centimes, total_ttc_centimes")
    .single();

  if (devisErr) {
    const code = devisErr.code || devisErr.details || String(devisErr.message || "");
    if (String(code).includes("23505") || String(devisErr.message || "").includes("duplicate")) {
      _log.warn("createDevis: doublon détecté, récupération existant", { idempotencyKey });
      const { data: existing, error: selErr } = await _supabase
        .from("devis")
        .select("id, total_ht_centimes, total_ttc_centimes")
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (selErr) throw selErr;
      if (existing.total_ht_centimes !== totalHt || existing.total_ttc_centimes !== totalTtc) {
        _log.warn("createDevis: totaux stale détectés, correction", {
          devisId: existing.id,
          oldHt: existing.total_ht_centimes, newHt: totalHt,
          oldTtc: existing.total_ttc_centimes, newTtc: totalTtc,
        });
        const { data: updated } = await _supabase
          .from("devis")
          .update({ total_ht_centimes: totalHt, total_tva_centimes: totalTva, total_ttc_centimes: totalTtc })
          .eq("id", existing.id)
          .select("id, total_ht_centimes, total_ttc_centimes")
          .single();
        if (updated) return { ...updated, isNew: false };
      }
      return { ...existing, isNew: false };
    }
    throw devisErr;
  }

  const { error: ligneErr } = await _supabase
    .from("devis_lignes")
    .insert({
      devis_id: devis.id,
      prestation_id: null,
      libelle,
      quantite: 1,
      prix_unitaire_ht_centimes: totalHt,
      tva_taux: tauxTva,
      ordre: 1,
    });

  if (ligneErr) throw ligneErr;

  return { ...devis, isNew: true };
}

// ====== Add upsell options to an existing devis ======
async function addUpsellOptionsToDevis(devisId, addedOptionIds, upsellType) {
  if (!devisId || devisId === "N/A") return;

  const tauxTva = 0.20;
  const options = UPSELL_OPTIONS[upsellType] || [];
  const accepted = options.filter(o => addedOptionIds.includes(o.id));

  if (accepted.length === 0) return;

  // Get current max ordre
  const { data: existingLines } = await _supabase
    .from("devis_lignes")
    .select("ordre")
    .eq("devis_id", devisId)
    .order("ordre", { ascending: false })
    .limit(1);

  let nextOrdre = (existingLines?.[0]?.ordre || 1) + 1;
  let additionalTtc = 0;

  for (const opt of accepted) {
    const optTtc = opt.priceCents;
    const optHt = Math.round(optTtc / (1 + tauxTva));

    const { error: ligneErr } = await _supabase.from("devis_lignes").insert({
      devis_id: devisId,
      prestation_id: null,
      libelle: opt.label,
      quantite: 1,
      prix_unitaire_ht_centimes: optHt,
      tva_taux: tauxTva,
      ordre: nextOrdre++,
    });

    if (ligneErr) {
      _log.error("addUpsellOptionsToDevis: insert ligne failed", { devisId, opt: opt.id, error: ligneErr.message });
    }

    additionalTtc += optTtc;
  }

  // Recalculate totals
  const { data: devis, error: fetchErr } = await _supabase
    .from("devis")
    .select("total_ht_centimes, total_tva_centimes, total_ttc_centimes")
    .eq("id", devisId)
    .single();

  if (fetchErr) {
    _log.error("addUpsellOptionsToDevis: fetch devis failed", { devisId, error: fetchErr.message });
    return;
  }

  const newTtc = devis.total_ttc_centimes + additionalTtc;
  const newHt = Math.round(newTtc / (1 + tauxTva));
  const newTva = newTtc - newHt;

  const { error: updateErr } = await _supabase.from("devis").update({
    total_ht_centimes: newHt,
    total_tva_centimes: newTva,
    total_ttc_centimes: newTtc,
  }).eq("id", devisId);

  if (updateErr) {
    _log.error("addUpsellOptionsToDevis: update totals failed", { devisId, error: updateErr.message });
  }

  _log.info("addUpsellOptionsToDevis: options added", { devisId, options: addedOptionIds, additionalTtc, newTtc });
}

module.exports = {
  initDevisService,
  getPrestationTarif,
  getPrestationLibelle,
  createDevis,
  addUpsellOptionsToDevis,
};
