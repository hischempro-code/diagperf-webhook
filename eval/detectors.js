/**
 * eval/detectors.js — Détecteurs d'hallucination déterministes (fonctions pures).
 *
 * Chaque détecteur reçoit le TEXTE d'une réponse du bot (type "answer") et renvoie
 * { hit: boolean, evidence: string|null }. Ils sont volontairement SANS état et sans
 * réseau : ils tournent hors-ligne (dans `npm test`) ET dans le runner live (eval/run-eval.js),
 * et la même logique alimente la télémétrie de prod (lib/llm-service.js).
 *
 * Objectif : attraper les hallucinations qu'on N'A PAS prévues. Un détecteur qui fire = un
 * fait que le bot ne DOIT jamais énoncer de mémoire (motorisation, faux devis, gains chiffrés,
 * déplacement à domicile, garantie chiffrée). Précision > rappel : mieux vaut rater une
 * hallucination rare que bloquer une réponse légitime → regex bornées et testées (detectors.test.js).
 */

"use strict";

// 1) MOTORISATION affirmée sur un véhicule spécifique ("votre C1 est un diesel").
//    Cause racine du bug prod 15/07 (C1 essence traitée en diesel). Le carburant ne se
//    connaît QUE par lecture de plaque — jamais affirmé de mémoire.
//    Négatifs volontaires : "les moteurs essence n'ont pas de FAP", "l'E85 est pour essence",
//    et surtout les tournures d'INCERTITUDE ("je ne peux pas savoir SI votre Golf est essence
//    ou diesel") qui sont l'inverse d'une hallucination → garde de négation/hypothèse.
const RE_MOTORISATION_G = /votre\s+[^.!?]{0,30}?\b(?:est|es|équipée?|dot[ée]e?|roule\s+(?:au|en)|de\s+type)\b[^.!?]{0,35}?\b(?:diesel|essence)\b/gi;
const RE_HYPOTHESE_AVANT = /\b(?:si|savoir|sais|pas|ne)\b[^.!?]{0,12}$|n['e]\s*[^.!?]{0,10}$/i;

function _matchMotorisation(text) {
  const s = String(text || "");
  RE_MOTORISATION_G.lastIndex = 0;
  let m;
  while ((m = RE_MOTORISATION_G.exec(s)) !== null) {
    // Hypothèse/négation dans les ~18 caractères précédant "votre" = pas une affirmation.
    const before = s.slice(Math.max(0, m.index - 18), m.index);
    if (RE_HYPOTHESE_AVANT.test(before)) continue;
    return { hit: true, evidence: m[0].trim().slice(0, 120) };
  }
  return { hit: false, evidence: null };
}

// 2) FAUX DEVIS généré en texte. Seul le SYSTÈME crée les devis + la réf DEV-xxx.
const RE_FAUX_DEVIS = /DEV-\s*\d|devis\s+g[ée]n[ée]r|r[ée]f\s*[:.]?\s*dev/i;

// 3) GAINS CHIFFRÉS cités de mémoire ("+30 ch", "+45 Nm", "+20-40 %"). Les gains dépendent
//    du moteur exact et viennent de la fiche/système, jamais d'une estimation LLM.
const RE_GAINS_CH_NM = /\+\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?\s*(?:ch\b|chevaux|nm\b)/i;
const RE_GAINS_PCT = /\+?\s*\d{1,3}\s*[-–]\s*\d{1,3}\s*%|\+\s*\d{1,3}\s*%/;

// 4) DÉPLACEMENT À DOMICILE : interdit absolu (atelier Villenoy uniquement). On cible les
//    PHRASES D'OFFRE que le prompt interdit explicitement — pas le mot "domicile" nu, qui
//    apparaît aussi dans un refus correct ("Pas de déplacement à domicile", "n'intervient
//    PAS à domicile"). Un garde de NÉGATION en amont proche supprime ces refus légitimes.
const RE_DOMICILE_G = /d[ée]placement\s+(?:à\s+)?domicile|d[ée]placement\s+possible|[àa]\s+votre\s+domicile|intervention\s+group[ée]e|partenariat\s+local|malgr[ée]\s+la\s+distance|on\s+peut\s+s['e]\s*arranger|garage\s+proche\s+de\s+chez\s+vous/gi;
const RE_NEGATION_AVANT = /\b(?:pas|aucune?|sans|ni|jamais)\b[^.!?]{0,15}$|n['e]\s*[^.!?]{0,12}$/i;

function _matchDomicile(text) {
  const s = String(text || "");
  RE_DOMICILE_G.lastIndex = 0;
  let m;
  while ((m = RE_DOMICILE_G.exec(s)) !== null) {
    // Négation dans les ~25 caractères précédant l'offre = refus correct → on ignore.
    const before = s.slice(Math.max(0, m.index - 25), m.index);
    if (RE_NEGATION_AVANT.test(before)) continue;
    return { hit: true, evidence: m[0].trim().slice(0, 120) };
  }
  return { hit: false, evidence: null };
}

// 5) GARANTIE CHIFFRÉE : jamais de durée chiffrée — toujours renvoyer aux CGV.
const RE_GARANTIE = /garantie[^.!?]{0,20}\b\d+\s*(?:mois|ans?|années?)\b|\b\d+\s*(?:mois|ans?|années?)\b[^.!?]{0,15}garantie/i;

function _match(re, text) {
  const m = String(text || "").match(re);
  return { hit: !!m, evidence: m ? m[0].trim().slice(0, 120) : null };
}

const DETECTORS = {
  motorisation_affirmee: {
    label: "Motorisation affirmée sur un véhicule (diesel/essence) sans lecture de plaque",
    detect: (text) => _matchMotorisation(text),
  },
  faux_devis: {
    label: "Faux devis / référence DEV-xxx générée en texte (rôle du système)",
    detect: (text) => _match(RE_FAUX_DEVIS, text),
  },
  gains_chiffres: {
    label: "Gains de puissance/couple chiffrés cités de mémoire (ch/Nm/%)",
    detect: (text) => {
      const a = _match(RE_GAINS_CH_NM, text);
      if (a.hit) return a;
      return _match(RE_GAINS_PCT, text);
    },
  },
  deplacement_domicile: {
    label: "Déplacement/intervention à domicile PROPOSÉ (interdit — atelier uniquement)",
    detect: (text) => _matchDomicile(text),
  },
  garantie_chiffree: {
    label: "Durée de garantie chiffrée (mois/ans) — doit renvoyer aux CGV",
    detect: (text) => _match(RE_GARANTIE, text),
  },
};

/**
 * Applique tous les détecteurs (ou un sous-ensemble) au texte.
 * @param {string} text
 * @param {string[]} [only] - noms de détecteurs à exécuter (défaut : tous)
 * @returns {Array<{code:string,label:string,evidence:string}>} hits
 */
function runDetectors(text, only) {
  const names = only && only.length ? only : Object.keys(DETECTORS);
  const hits = [];
  for (const name of names) {
    const d = DETECTORS[name];
    if (!d) continue;
    const r = d.detect(text);
    if (r.hit) hits.push({ code: name, label: d.label, evidence: r.evidence });
  }
  return hits;
}

module.exports = { DETECTORS, runDetectors };
