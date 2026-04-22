#!/usr/bin/env node
/**
 * Génère les 3 templates Creatomate (E85/FAP/ADBlue) à partir du template REPROG premium.
 *
 * Structure partagée :
 *  - Scene 1 (0-2.6s) : Brand intro "DIAGPERF" + tagline adaptée
 *  - Scene 2 (2.7-5s) : "VOUS ROULEZ EN" + vehicle_name + vehicle_engine
 *  - Scene 3 (5.1-7s) : "NOUS VOUS PROPOSONS" + prestation_label
 *  - Scene 4 (7.1-10.1s) : Metric 1 (label + valeur AVANT/APRÈS)
 *  - Scene 5 (10.2-12.7s) : Metric 2 (label + valeur AVANT/APRÈS)
 *  - Scene 6 (12.8-15s) : Price + CTA
 *
 * Usage : node scripts/generate-creatomate-templates.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE_PATH = path.join(ROOT, "creatomate-template-premium.json");

if (!fs.existsSync(BASE_PATH)) {
  console.error(`❌ Base template not found: ${BASE_PATH}`);
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(BASE_PATH, "utf8"));

// ====== Config par prestation ======
const PRESTATIONS = {
  e85: {
    tagline: "CONVERSION E85 BIOÉTHANOL",
    presta_label: "CONVERSION E85",
    metric1: {
      label: "ÉCONOMIE CARBURANT",
      before_text: "SP95",
      after_text: "E85",
      before_value: "1,80€",
      after_value: "1,00€",
      before_unit: "/L",
      after_unit: "/L",
      gain_text: "JUSQU'À -40% À LA POMPE",
    },
    metric2: {
      label: "RÉDUCTION CO₂",
      before_text: "ESSENCE",
      after_text: "BIOÉTH.",
      before_value: "100",
      after_value: "30",
      before_unit: "%",
      after_unit: "%",
      gain_text: "-70% ÉMISSIONS CO₂",
    },
    accent_color: "#22c55e", // vert bio
  },
  fap: {
    tagline: "SUPPRESSION FAP PREMIUM",
    presta_label: "SUPPRESSION FAP",
    metric1: {
      label: "COLMATAGE",
      before_text: "RISQUE",
      after_text: "FINI",
      before_value: "100",
      after_value: "0",
      before_unit: "%",
      after_unit: "%",
      gain_text: "FIN DES PANNES FAP",
    },
    metric2: {
      label: "PERFORMANCES",
      before_text: "BRIDÉ",
      after_text: "LIBÉRÉ",
      before_value: "85",
      after_value: "100",
      before_unit: "%",
      after_unit: "%",
      gain_text: "+15% DE RÉPONSE MOTEUR",
    },
    accent_color: "#3b82f6", // bleu
  },
  adblue: {
    tagline: "SUPPRESSION ADBLUE PREMIUM",
    presta_label: "SUPPRESSION ADBLUE",
    metric1: {
      label: "PANNES SCR",
      before_text: "RISQUE",
      after_text: "ZÉRO",
      before_value: "100",
      after_value: "0",
      before_unit: "%",
      after_unit: "%",
      gain_text: "FIN DES VOYANTS ADBLUE",
    },
    metric2: {
      label: "ENTRETIEN ANNUEL",
      before_text: "AVEC",
      after_text: "SANS",
      before_value: "300",
      after_value: "0",
      before_unit: "€",
      after_unit: "€",
      gain_text: "ÉCONOMIES ~300€/AN",
    },
    accent_color: "#8b5cf6", // violet
  },
};

// ====== Mappings noms d'éléments du template REPROG vers nouveaux noms ======
// On garde les mêmes noms pour réutiliser l'animation,
// mais on change le contenu textuel.
//
// REPROG names  →  role dans notre template adapté
//   brand_tagline       → tagline (ex: "CONVERSION E85 BIOÉTHANOL")
//   stage_label         → presta_label (ex: "CONVERSION E85")
//   scene4_label        → metric1 label (ex: "ÉCONOMIE CARBURANT")
//   hp_before_label     → metric1 before_text
//   hp_before           → metric1 before_value
//   hp_unit_before      → metric1 before_unit
//   hp_after_label      → metric1 after_text
//   hp_after            → metric1 after_value
//   hp_unit_after       → metric1 after_unit
//   hp_gain             → metric1 gain_text
//   scene5_label        → metric2 label
//   torque_before       → metric2 before_value
//   torque_unit_before  → metric2 before_unit
//   torque_after        → metric2 after_value
//   torque_unit_after   → metric2 after_unit
//   torque_gain         → metric2 gain_text
//
// NB: Il n'y a pas de "before_label/after_label" pour le couple dans REPROG
// → on les ajoute dynamiquement pour E85/FAP/ADBlue

function buildTemplate(config) {
  // Clone profond
  const tpl = JSON.parse(JSON.stringify(base));

  const GOLD = "#C9A961";
  const accent = config.accent_color || GOLD;

  // ===== Readability fix =====
  // Si l'utilisateur ajoute une vidéo de fond dans Creatomate, les textes en or
  // deviennent peu lisibles sur le ciel / zones claires. On ajoute :
  //   1) Un overlay noir global à 55% pour assombrir la vidéo de fond
  //   2) Un scrim dégradé vertical centré pour renforcer la lisibilité au centre
  // Ces éléments sont placés sur les tracks 1/2 (juste au-dessus du background
  // et de l'accent_vignette, donc SOUS tous les textes).

  const scrimOverlay = {
    name: "scrim_overlay_global",
    type: "shape",
    track: 1,
    x: "50%",
    y: "50%",
    width: "100%",
    height: "100%",
    fill_color: "rgba(10,10,10,0.55)",
    time: 0,
    duration: tpl.duration || 15,
  };

  const scrimCenter = {
    name: "scrim_center_gradient",
    type: "shape",
    track: 2,
    x: "50%",
    y: "50%",
    width: "100%",
    height: "70%",
    fill_color: "rgba(0,0,0,0.35)",
    time: 0,
    duration: tpl.duration || 15,
  };

  // On insère les scrims au début pour qu'ils soient sous tous les textes
  // mais au-dessus de la vidéo/background éventuel(le).
  tpl.elements.unshift(scrimCenter);
  tpl.elements.unshift(scrimOverlay);

  // ===== Text shadow (lisibilité garantie sur tout fond) =====
  const applyTextShadow = (el) => {
    if (el.type !== "text") return;
    el.shadow_color = "rgba(0,0,0,0.85)";
    el.shadow_blur = "1.2 vmin";
    el.shadow_x = "0.3 vmin";
    el.shadow_y = "0.3 vmin";
  };

  // ===== Gold text override (Montserrat 900, 4 vmin) =====
  // Appliqué à TOUS les textes en or pour garantir la lisibilité.
  const isGoldFill = (fill) => {
    if (!fill) return false;
    const f = String(fill).toLowerCase().replace(/\s/g, "");
    return f === "#c9a961" || f.includes("201,169,97");
  };

  const applyGoldStyle = (el) => {
    if (el.type !== "text") return;
    if (!isGoldFill(el.fill_color)) return;
    el.font_family = "Montserrat";
    el.font_weight = "900";
    el.font_style = "normal";
    el.font_size = "4 vmin";
  };

  for (const el of tpl.elements) {
    applyTextShadow(el);
    applyGoldStyle(el);
  }

  for (const el of tpl.elements) {
    switch (el.name) {
      case "brand_tagline":
        el.text = config.tagline;
        break;

      case "stage_label":
        el.text = config.presta_label;
        // Réduire la taille si le texte est long
        if (config.presta_label.length > 10) {
          el.font_size = "11 vmin";
        }
        break;

      // ===== Metric 1 (scène PUISSANCE dans REPROG) =====
      case "scene4_label":
        el.text = config.metric1.label;
        break;
      case "hp_before_label":
        el.text = config.metric1.before_text;
        break;
      case "hp_before":
        el.text = config.metric1.before_value;
        // Si la valeur contient un symbole (€, ,), réduire la taille
        if (config.metric1.before_value.length > 3) {
          el.font_size = "7 vmin";
        }
        break;
      case "hp_unit_before":
        el.text = config.metric1.before_unit;
        break;
      case "hp_after_label":
        el.text = config.metric1.after_text;
        break;
      case "hp_after":
        el.text = config.metric1.after_value;
        if (config.metric1.after_value.length > 3) {
          el.font_size = "9 vmin";
        }
        break;
      case "hp_unit_after":
        el.text = config.metric1.after_unit;
        break;
      case "hp_gain":
        el.text = config.metric1.gain_text;
        break;

      // ===== Metric 2 (scène COUPLE dans REPROG) =====
      case "scene5_label":
        el.text = config.metric2.label;
        break;
      case "torque_before":
        el.text = config.metric2.before_value;
        if (config.metric2.before_value.length > 3) {
          el.font_size = "7 vmin";
        }
        break;
      case "torque_unit_before":
        el.text = config.metric2.before_unit;
        break;
      case "torque_after":
        el.text = config.metric2.after_value;
        if (config.metric2.after_value.length > 3) {
          el.font_size = "9 vmin";
        }
        break;
      case "torque_unit_after":
        el.text = config.metric2.after_unit;
        break;
      case "torque_gain":
        el.text = config.metric2.gain_text;
        break;

      // ===== Scène finale =====
      // price_label, price_ttc, final_cta, final_brand restent identiques
      // (price_ttc est overridé dynamiquement par le backend via modifications)

      // ===== Couleur d'accent =====
      // On NE change PAS la couleur or principale (C9A961) qui fait l'identité premium,
      // mais on peut colorer les "glow" pour nuancer légèrement
      default:
        break;
    }

    // Colorer les glows avec l'accent (20% opacity)
    if (el.name && el.name.startsWith("glow_")) {
      const rgb = hexToRgb(accent);
      if (rgb) {
        el.fill_color = `rgba(${rgb.r},${rgb.g},${rgb.b},0.2)`;
      }
    }
  }

  return tpl;
}

function hexToRgb(hex) {
  const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : null;
}

// ====== Génération ======
const generated = [];
for (const [key, config] of Object.entries(PRESTATIONS)) {
  const tpl = buildTemplate(config);
  const outPath = path.join(ROOT, `creatomate-template-${key}.json`);
  fs.writeFileSync(outPath, JSON.stringify(tpl, null, 2), "utf8");
  generated.push({ key, path: outPath, size: fs.statSync(outPath).size });
  console.log(`✅ Generated: creatomate-template-${key}.json`);
}

console.log(`\n📦 ${generated.length} template(s) générés.\n`);
console.log(`Étapes suivantes :`);
console.log(`  1. Importer chaque JSON dans Creatomate (Create Template → Import)`);
console.log(`  2. Copier les 3 template IDs`);
console.log(`  3. Ajouter sur Railway :`);
console.log(`     CREATOMATE_TEMPLATE_ID_E85=xxx`);
console.log(`     CREATOMATE_TEMPLATE_ID_FAP=xxx`);
console.log(`     CREATOMATE_TEMPLATE_ID_ADBLUE=xxx`);
