const { normalizePlate } = require("./text-helpers");

let _supabase = null;
let _log = null;
let _fetchFn = null;

function initVehicleService({ supabase, log, fetchFn }) {
  _supabase = supabase;
  _log = log;
  _fetchFn = fetchFn;
}

// ====== Helpers: parsing ======
function parseNumberFromString(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseYearFromDateFR(dateFr) {
  if (!dateFr) return null;
  const m = String(dateFr).match(/(\d{4})$/);
  return m ? Number(m[1]) : null;
}

// ====== Reprog Shiftech: helpers ======
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapFuelToCarburant(fuel) {
  const f = String(fuel || "").toUpperCase();
  if (["DIESEL", "GAZOLE", "GO"].some((k) => f.includes(k))) return "diesel";
  if (["ES", "ESSENCE", "PETROL"].some((k) => f.includes(k))) return "petrol";
  return null;
}

async function lookupReprogStages(vehicle) {
  const marque = slugify(vehicle?.make);
  const carburant = mapFuelToCarburant(vehicle?.fuel);
  const hp = vehicle?.power_hp;
  const year = vehicle?.year;

  if (!marque || !carburant || typeof hp !== "number" || hp <= 0) return [];

  const hpMin = hp - 5;
  const hpMax = hp + 5;

  // Extract first significant word from model for ilike filter
  const modelSlug = slugify(
    String(vehicle?.model || "").split(/[\s\/]+/).find((w) => w.length >= 1) || ""
  );

  // Extract cylindre from model or trim (e.g. "2.0" from "GOLF VI 2.0 TDI")
  const cylMatch = String(vehicle?.model || "").match(/(\d+\.\d+)/)
    || String(vehicle?.trim || "").match(/(\d+\.\d+)/);
  const cylindree = cylMatch ? cylMatch[1] : null;

  // Build version year patterns for ilike (year ±1)
  const versionYears = [];
  if (typeof year === "number" && year > 1990) {
    versionYears.push(String(year));
    versionYears.push(String(year - 1));
    versionYears.push(String(year + 1));
  }

  // Helper: run a single Supabase query with given filters
  async function queryStages({ useModel, useVersion, useCylindree }) {
    let q = _supabase
      .from("reprog_moteurs")
      .select("*")
      .eq("marque", marque)
      .eq("carburant", carburant)
      .gte("puissance_origine", hpMin)
      .lte("puissance_origine", hpMax)
      .neq("stage", "gearbox");

    if (useModel && modelSlug) {
      q = q.ilike("modele", `%${modelSlug}%`);
    }

    if (useVersion && versionYears.length > 0) {
      q = q.or(versionYears.map((y) => `version.ilike.${y}%`).join(","));
    }

    if (useCylindree && cylindree) {
      q = q.ilike("moteur_slug", `%${cylindree.replace(".", "-")}%`);
    }

    const { data, error } = await q.order("prix_centimes", { ascending: true });
    if (error) {
      _log.error("lookupReprogStages: erreur Supabase", {
        error: error.message, marque, modelSlug, carburant, hp,
        useModel, useVersion, useCylindree,
      });
      return null;
    }
    return data && data.length > 0 ? data : null;
  }

  // Tiered matching: most precise first, stop at first hit
  let rows = null;
  let matchTier = null;

  // Tier 1: marque + modèle + version(year±1) + carburant + cylindre + puissance±5
  if (modelSlug && versionYears.length > 0 && cylindree) {
    rows = await queryStages({ useModel: true, useVersion: true, useCylindree: true });
    if (rows) matchTier = "tier1:model+version+cyl";
  }

  // Tier 2: marque + modèle + version(year±1) + carburant + puissance±5
  if (!rows && modelSlug && versionYears.length > 0) {
    rows = await queryStages({ useModel: true, useVersion: true, useCylindree: false });
    if (rows) matchTier = "tier2:model+version";
  }

  // Tier 3: marque + modèle + carburant + puissance±5 (previous fallback)
  if (!rows && modelSlug) {
    rows = await queryStages({ useModel: true, useVersion: false, useCylindree: false });
    if (rows) matchTier = "tier3:model";
  }

  // Tier 4: marque + carburant + puissance±5 (last resort)
  if (!rows) {
    rows = await queryStages({ useModel: false, useVersion: false, useCylindree: false });
    if (rows) matchTier = "tier4:marque-only";
  }

  if (!rows || rows.length === 0) return [];

  // Group by moteur_slug and pick the motor whose puissance_origine is closest to hp
  const byMotor = new Map();
  for (const row of rows) {
    const key = row.moteur_slug || "__unknown__";
    if (!byMotor.has(key)) byMotor.set(key, []);
    byMotor.get(key).push(row);
  }

  let bestMotor = null;
  let bestDiff = Infinity;
  for (const [key, motorRows] of byMotor) {
    const refHp = motorRows[0].puissance_origine;
    const diff = Math.abs(refHp - hp);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMotor = key;
    }
  }

  const result = bestMotor ? byMotor.get(bestMotor) : [];
  if (result.length > 0) {
    const matched = result[0];
    _log.info("lookupReprogStages: moteur match", {
      matchTier,
      moteur_slug: matched.moteur_slug,
      version: matched.version,
      puissance_origine: matched.puissance_origine,
      marque, modelSlug, cylindree, year: year || null, hp,
    });
    // Exposer la précision du match à l'affichage : tier4 = marque seule (SANS modèle)
    // → les gains peuvent venir d'un autre modèle de la marque. L'UI doit le dire au
    // client plutôt que présenter ces chiffres avec la même confiance qu'un match exact.
    for (const r of result) r._match_tier = matchTier;
  }

  return result;
}

function formatStageLabel(stage) {
  const map = { stage1: "STAGE 1", stage2: "STAGE 2", e85: "E85", e85plus: "E85+" };
  return map[stage] || stage.toUpperCase();
}

// ====== VEHICLE API (apiplaqueimmatriculation.com) ======
async function fetchVehicleFromPlate(plate) {
  const baseUrl = process.env.IMMATRICULATION_API_URL;
  const token = process.env.IMMATRICULATION_API_TOKEN;
  const country = process.env.IMMATRICULATION_API_COUNTRY || "FR";

  if (!baseUrl || !token) {
    throw new Error("IMMATRICULATION_API_NOT_CONFIGURED");
  }

  const normalized = normalizePlate(plate).replace(/-/g, "");

  const url =
    `${baseUrl}/plaque?immatriculation=${encodeURIComponent(normalized)}` +
    `&token=${encodeURIComponent(token)}` +
    `&pays=${encodeURIComponent(country)}`;

  // Retry sur échec réseau UNIQUEMENT (fetch failed / timeout) : la panne observée en prod
  // est intermittente (marche puis échoue sans aucun changement). Le webhook a déjà répondu
  // 200 à Meta (routes/webhook.js) AVANT ce traitement, donc le temps passé ici ne provoque
  // pas de re-livraison Meta. Timeout court/tentative pour ne pas trop faire attendre le client.
  // On loggue err.cause.code pour identifier la panne (ETIMEDOUT / ENOTFOUND / cert...).
  const PER_ATTEMPT_TIMEOUT_MS = 8000;
  const NET_RETRY_BACKOFF_MS = [600, 1500]; // → 3 tentatives au total
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
      try {
        resp = await _fetchFn(url, { method: "POST", signal: controller.signal });
      } finally {
        clearTimeout(t);
      }
      break; // réponse reçue (les erreurs HTTP token/not-found sont gérées plus bas, sans retry)
    } catch (netErr) {
      const cause = netErr?.cause;
      const code = cause?.code || netErr?.code
        || (netErr?.name === "AbortError" ? `TIMEOUT_${PER_ATTEMPT_TIMEOUT_MS}MS` : null);
      const isLast = attempt >= NET_RETRY_BACKOFF_MS.length;
      _log.warn("Immatriculation API: échec réseau (fetch)", {
        plaque: normalized,
        attempt: attempt + 1,
        willRetry: !isLast,
        message: String(netErr?.message || netErr),
        code,
        cause: cause ? String(cause.message || cause) : null,
      });
      if (isLast) throw new Error("IMMATRICULATION_API_NETWORK");
      await new Promise((r) => setTimeout(r, NET_RETRY_BACKOFF_MS[attempt]));
    }
  }
  const body = await resp.text();

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    _log.error("Immatriculation API: rponse non-JSON", { body: body.slice(0, 300) });
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      _log.warn("Immatriculation API: token expir/quota (401) - fallback manuel", { status: resp.status, code_erreur: json.code_erreur });
      throw new Error("IMMATRICULATION_API_INVALID_TOKEN");
    }
    _log.error("Immatriculation API HTTP error", { status: resp.status, code_erreur: json.code_erreur, message: json.message, erreur: json.data?.erreur });
    if (resp.status === 403) {
      throw new Error("IMMATRICULATION_API_INVALID_TOKEN");
    }
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  if (json.code_erreur !== 200) {
    _log.error("Immatriculation API code_erreur", { code_erreur: json.code_erreur, message: json.message, erreur: json.data?.erreur });
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  const data = json.data;

  if (!data) {
    _log.warn("VEHICLE_NOT_FOUND: data absente", { plaque: normalized });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  if (data.erreur) {
    _log.warn("VEHICLE_NOT_FOUND: data.erreur", { plaque: normalized, erreur: data.erreur });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  if (!data.marque || typeof data.marque !== "string" || !data.marque.trim()) {
    _log.warn("VEHICLE_NOT_FOUND: marque absente", { plaque: normalized, marque: data.marque });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  if (!data.modele || typeof data.modele !== "string" || !data.modele.trim()) {
    _log.warn("VEHICLE_NOT_FOUND: modele absent", { plaque: normalized, modele: data.modele });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  return json;
}

// Normalisation vers format interne
function standardizeVehicleData(raw, plate) {
  const data = raw?.data || {};

  return {
    plate: normalizePlate(plate),
    make: data.marque || null,
    model: data.modele || null,
    trim: data.version || data.sra_commercial || null,
    year: parseYearFromDateFR(data.date1erCir_fr),
    fuel: data.energieNGC || data.type_moteur || null,
    transmission: data.boite_vitesse || null,
    engine_cc: parseNumberFromString(data.ccm),
    power_hp: parseNumberFromString(data.puisFiscReelCH),
    power_kw: parseNumberFromString(data.puisFiscReelKW),
    vin: data.vin || null,
    engine_code: data.code_moteur || null,
    color: data.couleur || null,
    raw,
    source: "apiplaqueimmatriculation",
  };
}

// ====== Vehicle lookup (shared by both flows) ======
async function lookupVehicleFromPlate(plate) {
  const raw = await fetchVehicleFromPlate(plate);
  return standardizeVehicleData(raw, plate);
}

// ====== Stage 1 fixed price constant ======
const STAGE1_FIXED_PRICE_CENTS = 39000; // 390€ TTC

// ====== FIX #1 : Intents dont le prix calculé est déjà TTC ======
const TTC_INTENTS = new Set(["REPROG", "E85", "FAP", "ADBLUE", "EGR", "DIAG"]);

// ====== Stages that require custom quotes (prix sur devis) ======
const CUSTOM_QUOTE_STAGES = new Set(["stage2", "stage3", "stage4"]);

// ====== Reprog pricing rule ======
function computeReprogPrice(vehicle) {
  const hp = vehicle?.power_hp;
  const year = vehicle?.year;
  if (typeof hp === "number" && hp > 0 && typeof year === "number" && hp < 400 && year < 2018) {
    return STAGE1_FIXED_PRICE_CENTS;
  }
  return null;
}

// ====== E85 pricing rule ======
function computeE85Price(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2020) {
    return 49000;
  }
  return null;
}

// ====== ADBlue pricing rule ======
function computeAdbluePrice(vehicle) {
  const fields = [
    vehicle?.engine, vehicle?.model, vehicle?.fuel,
    vehicle?.trim, vehicle?.version,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/blue[\s-]?hdi/i.test(fields)) {
    return 26000;
  }
  return 30000;
}

// ====== EGR pricing rule ======
function computeEgrPrice(vehicle) {
  const fuel = String(vehicle?.fuel || "").toLowerCase();
  const isDiesel = /diesel|gazole|hdi|tdi|dci|cdi|bluehdi|d4d|crdi/i.test(fuel);
  if (isDiesel) return 19000;
  return null;
}

// ====== FAP pricing rule ======
function computeFapPrice(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2019) {
    return 26000;
  }
  return 30000;
}

// ====== Helpers compatibilité véhicule pour filtrer upsells ======
function _vehicleFuelText(vehicle) {
  return String(vehicle?.fuel || "").toLowerCase();
}
function _isDieselVehicle(vehicle) {
  return /diesel|gazole|hdi|tdi|dci|cdi|bluehdi|d4d|crdi|go\b/i.test(_vehicleFuelText(vehicle));
}
function _isEssenceVehicle(vehicle) {
  return /essence|gazoline|petrol|super|sp95|sp98|flex|hybride|gpl/i.test(_vehicleFuelText(vehicle));
}
function _hasAdBlueSystem(vehicle) {
  const fields = [vehicle?.engine, vehicle?.model, vehicle?.fuel, vehicle?.trim, vehicle?.version]
    .filter(Boolean).join(" ").toLowerCase();
  if (/blue[\s-]?hdi|\bscr\b|ad[\s-]?blue/i.test(fields)) return true;
  if (_isDieselVehicle(vehicle) && (vehicle?.year || 0) >= 2015) return true;
  return false;
}

// ====== Table centrale des prérequis véhicule par intent ======
const INTENT_VEHICLE_REQUIREMENTS = {
  FAP: {
    check: _isDieselVehicle,
    title: "Suppression FAP non applicable",
    explain: (v) => `Votre véhicule est un *${v.make} ${v.model}* motorisation *${v.fuel || "non diesel"}*.\n\n` +
      `Les moteurs *essence* n'ont pas de filtre à particules (FAP). Cette prestation est réservée aux véhicules *diesel*.\n\n` +
      `💡 Pour un véhicule essence, je peux vous proposer une *reprogrammation moteur* (plus de puissance) ou une *conversion E85* (économies carburant) !`,
    alternatives: [
      { id: "vehicle_incompat_reprog", title: "🏎️ Reprog moteur" },
      { id: "vehicle_incompat_e85", title: "🌿 Conversion E85" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ],
  },
  EGR: {
    check: _isDieselVehicle,
    title: "Suppression EGR non recommandée",
    explain: (v) => `Votre véhicule est un *${v.make} ${v.model}* motorisation *${v.fuel || "non diesel"}*.\n\n` +
      `La suppression EGR est pertinente uniquement sur les moteurs *diesel* (vanne EGR encrassée par les particules). ` +
      `Sur les motorisations essence/hybride, cette intervention n'apporte pas les mêmes bénéfices.\n\n` +
      `💡 Nous pouvons vous proposer une *reprogrammation moteur* ou une *conversion E85* pour optimiser votre véhicule !`,
    alternatives: [
      { id: "vehicle_incompat_reprog", title: "🏎️ Reprog moteur" },
      { id: "vehicle_incompat_e85", title: "🌿 Conversion E85" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ],
  },
  E85: {
    check: (v) => !_isDieselVehicle(v),
    title: "Conversion E85 non compatible",
    explain: (v) => `Votre véhicule est un *${v.make} ${v.model}* motorisation *${v.fuel}*.\n\n` +
      `La conversion E85 (bioéthanol) est réservée uniquement aux véhicules *essence*. ` +
      `Les moteurs diesel ne sont pas compatibles avec le bioéthanol.\n\n` +
      `💡 En revanche, nous pouvons vous proposer une *reprogrammation moteur* pour optimiser les performances de votre diesel !`,
    alternatives: [
      { id: "vehicle_incompat_reprog", title: "🏎️ Reprog moteur" },
      { id: "btn_back_menu", title: "🏠 Menu principal" },
    ],
  },
  ADBLUE: {
    check: _hasAdBlueSystem,
    title: "Suppression AdBlue non applicable",
    explain: (v) => `Votre véhicule est un *${v.make} ${v.model}* motorisation *${v.fuel || "non diesel"}*.\n\n` +
      `La suppression AdBlue concerne uniquement les véhicules *diesel équipés du système SCR* (BlueHDi PSA, diesel Euro 6+, etc.).\n\n` +
      `💡 Pour votre véhicule, je peux vous proposer d'autres prestations.`,
    alternatives: [
      { id: "vehicle_incompat_reprog", title: "🏎️ Reprog moteur" },
      { id: "vehicle_incompat_e85", title: "🌿 Conversion E85" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ],
  },
};

function validateIntentForVehicle(intent, vehicle) {
  const req = INTENT_VEHICLE_REQUIREMENTS[intent];
  if (!req) return null;
  if (req.check(vehicle)) return null;
  return req;
}

const UPSELL_OPTIONS = {
  FAP: [
    {
      id: "fap_meca", label: "Suppression mécanique FAP", priceCents: 25000, prestationCode: "suppression_mecanique_fap",
      message:
        `💡 Nous vous recommandons la *suppression mécanique du FAP*.\n\n` +
        `En plus de la suppression logicielle, le retrait physique du filtre à particules permet d'éliminer tout risque de colmatage futur et d'améliorer le flux d'échappement.\n\n` +
        `➕ Suppression mécanique FAP : +250€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+250€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "egr", label: "Suppression EGR", priceCents: 9000, prestationCode: "suppression_egr",
      condition: _isDieselVehicle,
      message:
        `💡 Nous vous recommandons également la *suppression EGR* pour optimiser pleinement votre moteur.\n\n` +
        `La vanne EGR encrassée peut réduire les performances et augmenter la consommation. En la combinant avec la suppression FAP, vous obtenez un résultat optimal.\n\n` +
        `➕ Suppression EGR : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "adblue", label: "Suppression AdBlue", priceCents: 9000, prestationCode: "suppression_adblue",
      condition: _hasAdBlueSystem,
      message: (vehicle) => {
        const fields = [vehicle?.engine, vehicle?.model, vehicle?.trim, vehicle?.version]
          .filter(Boolean).join(" ").toLowerCase();
        const isBlueHdi = /blue[\s-]?hdi/i.test(fields);
        const intro = isBlueHdi
          ? `💡 Votre *BlueHDi* est équipé du système *AdBlue (SCR)*.`
          : `💡 Votre véhicule diesel est équipé du système *AdBlue (SCR)*.`;
        return `${intro} Sa suppression permet d'éviter les pannes liées au SCR et les coûts d'entretien associés (recharges AdBlue, capteurs NOx).\n\n` +
          `➕ Suppression AdBlue : +90€ TTC\n\n` +
          `Souhaitez-vous ajouter cette option ?`;
      },
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "reprog", label: "Reprogrammation Stage 1", priceCents: 28000, prestationCode: "reprogrammation",
      message:
        `💡 Pour aller encore plus loin, nous proposons la *reprogrammation moteur Stage 1*.\n\n` +
        `Après suppression du FAP (et EGR si ajout), la reprog permet de libérer tout le potentiel de votre moteur : plus de puissance, plus de couple, et une meilleure réponse à l'accélération.\n\n` +
        `➕ Reprogrammation Stage 1 : +280€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+280€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
  ADBLUE: [
    {
      id: "fap", label: "Suppression FAP", priceCents: 9000, prestationCode: "suppression_fap",
      condition: _isDieselVehicle,
      message:
        `💡 Nous vous recommandons également la *suppression FAP* pour un fonctionnement optimal de votre moteur.\n\n` +
        `En combinant la suppression AdBlue et FAP, vous éliminez les deux principales sources de problèmes sur les moteurs diesel modernes.\n\n` +
        `➕ Suppression FAP : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "egr", label: "Suppression EGR", priceCents: 9000, prestationCode: "suppression_egr",
      condition: _isDieselVehicle,
      message:
        `💡 Pour compléter le traitement, nous proposons la *suppression EGR*.\n\n` +
        `La vanne EGR est souvent responsable de l'encrassement du moteur. Sa suppression améliore la fiabilité et les performances.\n\n` +
        `➕ Suppression EGR : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "reprog", label: "Reprogrammation Stage 1", priceCents: 28000, prestationCode: "reprogrammation",
      message:
        `💡 Pour libérer tout le potentiel de votre moteur, nous proposons la *reprogrammation moteur Stage 1*.\n\n` +
        `➕ Reprogrammation Stage 1 : +280€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+280€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
  E85: [
    {
      id: "e85_bougies",
      label: "Bougies d'allumage éthanol",
      priceCents: 17000,
      condition: _isEssenceVehicle,
      message:
        `💡 Nous préconisons fortement le changement des *bougies d'allumage classiques* par des *bougies d'allumage adaptées à l'éthanol*.\n\n` +
        `Les bougies standard ne sont pas optimisées pour le bioéthanol. Des bougies adaptées garantissent un meilleur démarrage, une combustion optimale et une durée de vie prolongée du moteur.\n\n` +
        `➕ Bougies d'allumage éthanol : +170€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+170€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
  REPROG: [
    {
      id: "reprog_bougies",
      label: "Bougies d'allumage haute performance",
      priceCents: 17000,
      prestationCode: "bougies_performance",
      condition: _isEssenceVehicle,
      message:
        `💡 Pour accompagner votre reprogrammation, nous préconisons le remplacement des *bougies d'allumage* par des *bougies haute performance*.\n\n` +
        `Après une reprog, la combustion est plus intense. Des bougies adaptées garantissent une combustion optimale, un meilleur démarrage et prolongent la durée de vie de votre moteur.\n\n` +
        `➕ Bougies d'allumage haute performance : +170€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+170€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
};

// ====== Filter upsell options based on vehicle (some options are conditional e.g. essence only) ======
function getUpsellOptionsForVehicle(intent, vehicle) {
  const options = UPSELL_OPTIONS[intent] || [];
  return options.filter((opt) => typeof opt.condition !== "function" || opt.condition(vehicle));
}

// ====== Build upsell message body (message peut être string ou fonction (vehicle) => string) ======
function _upsellMessageBody(opt, vehicle) {
  return typeof opt.message === "function" ? opt.message(vehicle) : opt.message;
}

function _upsellGreeting(prevAction) {
  if (prevAction === "confirm") return `Excellente décision ! 🎉\n\n`;
  if (prevAction === "add") return `Parfait ! 🎉\n\n`;
  if (prevAction === "skip") return `Pas de souci 👍\n\n`;
  return "";
}

function buildUpsellMessage(opt, vehicle, prevAction) {
  return _upsellGreeting(prevAction) + _upsellMessageBody(opt, vehicle);
}

// ====== Intents that have upsells ======
const UPSELL_INTENTS = new Set(["FAP", "ADBLUE", "E85", "REPROG"]);

function buildVehicleOnlyText(vehicle) {
  const nameParts = [vehicle.make, vehicle.model, vehicle.trim].filter(Boolean);
  const name = nameParts.length ? nameParts.join(" ") : "Véhicule";

  const detailParts = [];
  if (vehicle.fuel) detailParts.push(vehicle.fuel);
  if (vehicle.engine_cc) detailParts.push(`${vehicle.engine_cc}cc`);
  if (vehicle.power_hp) detailParts.push(`${vehicle.power_hp}ch`);
  else if (vehicle.power_kw) detailParts.push(`${vehicle.power_kw}kW`);
  const details = detailParts.length ? ` (${detailParts.join(" | ")})` : "";

  const yearTxt = vehicle.year ? ` - ${vehicle.year}` : "";

  return (
    `Véhicule détecté :\n` +
    `🚘 ${name}${details}${yearTxt}\n` +
    `🔧 Code moteur : ${vehicle.engine_code || "Non disponible"}\n\n` +
    `Est-ce bien votre véhicule ?`
  );
}

module.exports = {
  initVehicleService,
  parseNumberFromString,
  parseYearFromDateFR,
  slugify,
  mapFuelToCarburant,
  lookupReprogStages,
  formatStageLabel,
  fetchVehicleFromPlate,
  standardizeVehicleData,
  lookupVehicleFromPlate,
  STAGE1_FIXED_PRICE_CENTS,
  TTC_INTENTS,
  CUSTOM_QUOTE_STAGES,
  computeReprogPrice,
  computeE85Price,
  computeAdbluePrice,
  computeEgrPrice,
  computeFapPrice,
  _isDieselVehicle,
  _isEssenceVehicle,
  _hasAdBlueSystem,
  INTENT_VEHICLE_REQUIREMENTS,
  validateIntentForVehicle,
  UPSELL_OPTIONS,
  getUpsellOptionsForVehicle,
  buildUpsellMessage,
  UPSELL_INTENTS,
  buildVehicleOnlyText,
};
