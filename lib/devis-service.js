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
        // Si le devis a plusieurs lignes, des OPTIONS UPSELL ont été ajoutées : ses totaux
        // sont légitimement plus hauts que le prix de base — ne surtout pas les écraser
        // (sinon devis "sent" à 350€ remis à 260€ alors que les lignes upsell existent toujours).
        const { count: ligneCount } = await _supabase
          .from("devis_lignes")
          .select("id", { count: "exact", head: true })
          .eq("devis_id", existing.id);
        if ((ligneCount || 0) > 1) {
          _log.info("createDevis: doublon avec upsells — totaux existants conservés", { devisId: existing.id, lignes: ligneCount });
          return { ...existing, isNew: false };
        }
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
// ⚠️ Les totaux sont TOUJOURS recalculés comme la SOMME DES LIGNES — jamais par
// addition incrémentale. L'ancienne logique lisait les totaux courants puis ajoutait
// le prix des options : or les totaux avaient déjà été recalculés depuis les lignes
// entre-temps (trigger côté base), donc chaque option était comptée DEUX fois.
// Bug constaté en prod sur TOUS les devis multi-lignes depuis mars 2026
// (ex: DEV-230 facturé 1500€ TTC au lieu de 880€).
async function addUpsellOptionsToDevis(devisId, addedOptionIds, upsellType) {
  if (!devisId || devisId === "N/A") return;

  const tauxTva = 0.20;
  const options = UPSELL_OPTIONS[upsellType] || [];
  const accepted = options.filter(o => addedOptionIds.includes(o.id));

  if (accepted.length === 0) return;

  // Lignes existantes : sert au prochain "ordre" ET à l'idempotence (ne jamais
  // réinsérer une option déjà présente — double tap / traitement concurrent)
  const { data: existingLines, error: existErr } = await _supabase
    .from("devis_lignes")
    .select("libelle, ordre")
    .eq("devis_id", devisId);

  if (existErr) {
    _log.error("addUpsellOptionsToDevis: fetch lignes failed", { devisId, error: existErr.message });
    return;
  }

  const existingLibelles = new Set((existingLines || []).map(l => l.libelle));
  let nextOrdre = Math.max(1, ...(existingLines || []).map(l => l.ordre || 1)) + 1;

  for (const opt of accepted) {
    if (existingLibelles.has(opt.label)) {
      _log.warn("addUpsellOptionsToDevis: option déjà présente, skip", { devisId, opt: opt.id });
      continue;
    }
    const optHt = Math.round(opt.priceCents / (1 + tauxTva));

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
  }

  // Totaux = somme des lignes (source de vérité unique)
  const { data: allLines, error: sumErr } = await _supabase
    .from("devis_lignes")
    .select("prix_unitaire_ht_centimes, quantite")
    .eq("devis_id", devisId);

  if (sumErr) {
    _log.error("addUpsellOptionsToDevis: fetch lignes pour totaux failed", { devisId, error: sumErr.message });
    return;
  }

  const newHt = (allLines || []).reduce((s, l) => s + (l.prix_unitaire_ht_centimes || 0) * (l.quantite || 1), 0);
  const newTva = Math.round(newHt * tauxTva);
  const newTtc = newHt + newTva;

  const { error: updateErr } = await _supabase.from("devis").update({
    total_ht_centimes: newHt,
    total_tva_centimes: newTva,
    total_ttc_centimes: newTtc,
  }).eq("id", devisId);

  if (updateErr) {
    _log.error("addUpsellOptionsToDevis: update totals failed", { devisId, error: updateErr.message });
  }

  _log.info("addUpsellOptionsToDevis: options added", { devisId, options: addedOptionIds, newHt, newTtc });
}

module.exports = {
  initDevisService,
  getPrestationTarif,
  getPrestationLibelle,
  createDevis,
  addUpsellOptionsToDevis,
};
