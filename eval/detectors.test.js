/**
 * eval/detectors.test.js — Tests hors-ligne des détecteurs d'hallucination.
 * Tourne dans `npm test` (rapide, sans réseau). Vérifie que chaque détecteur :
 *   - FIRE sur des textes réellement hallucinatoires (positifs),
 *   - NE FIRE PAS sur des réponses légitimes (négatifs, anti-faux-positifs).
 */
"use strict";
const { runDetectors } = require("./detectors");

let pass = 0, fail = 0;
function check(label, text, expectCode, shouldHit) {
  const hits = runDetectors(text, [expectCode]);
  const hit = hits.length > 0;
  const ok = hit === shouldHit;
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else {
    fail++;
    console.log(`  ❌ ${label}\n     attendu hit=${shouldHit}, obtenu hit=${hit}${hit ? ` (${hits[0].evidence})` : ""}\n     texte: ${text.slice(0, 90)}`);
  }
}

console.log("\n🔬 motorisation_affirmee");
check("C1 diesel (cas prod réel)", "Bonjour ! Malheureusement, votre Citroën C1 est équipée d'un moteur diesel, et la conversion E85 n'est pas possible.", "motorisation_affirmee", true);
check("208 est un diesel", "votre 208 est un diesel donc l'E85 est impossible", "motorisation_affirmee", true);
check("véhicule roule au diesel", "votre véhicule roule au diesel", "motorisation_affirmee", true);
check("LÉGIT: les moteurs essence n'ont pas de FAP", "Les moteurs essence n'ont pas de filtre à particules, cette prestation est réservée aux diesels.", "motorisation_affirmee", false);
check("LÉGIT: E85 réservé essence", "La conversion E85 est réservée aux véhicules essence uniquement.", "motorisation_affirmee", false);
check("LÉGIT: question ouverte", "Souhaitez-vous convertir votre véhicule à l'E85 ?", "motorisation_affirmee", false);
check("LÉGIT: incertitude 'si votre X est essence ou diesel'", "Sans la plaque, je ne peux pas savoir si votre Golf est essence ou diesel.", "motorisation_affirmee", false);
check("LÉGIT: hypothèse 'si votre véhicule est diesel'", "Si votre véhicule est diesel, l'E85 ne sera pas compatible — envoyez la plaque pour confirmer.", "motorisation_affirmee", false);

console.log("\n🔬 faux_devis");
check("Réf DEV-231", "✅ Devis généré\nRéf : DEV-231\nTotal TTC : 490€", "faux_devis", true);
check("devis généré", "Voici votre devis généré pour la prestation.", "faux_devis", true);
check("LÉGIT: propose de lancer le devis", "Voulez-vous que je lance le devis pour cette prestation ?", "faux_devis", false);
check("LÉGIT: devis gratuit sans engagement", "Le devis est gratuit et sans engagement.", "faux_devis", false);

console.log("\n🔬 gains_chiffres");
check("+30 ch", "Avec un Stage 1 vous gagnez environ +30 ch et +45 Nm.", "gains_chiffres", true);
check("+20-40% (cas prod C1)", "Reprog Stage 1 : +20-40% puissance/couple", "gains_chiffres", true);
check("+45 Nm", "Le couple augmente de +45 Nm.", "gains_chiffres", true);
check("LÉGIT: gains personnalisés", "Le Stage 1 apporte des gains de puissance et de couple personnalisés selon votre motorisation.", "gains_chiffres", false);
check("LÉGIT: prix addon +170€", "Bougies éthanol : +170€ TTC", "gains_chiffres", false);

console.log("\n🔬 deplacement_domicile");
check("déplacement à domicile", "Nous pouvons faire un déplacement à domicile si besoin.", "deplacement_domicile", true);
check("à votre domicile", "Nous pouvons venir à votre domicile.", "deplacement_domicile", true);
check("on peut s'arranger", "Pour la distance, on peut s'arranger.", "deplacement_domicile", true);
check("garage proche de chez vous", "Nous avons un garage proche de chez vous.", "deplacement_domicile", true);
check("LÉGIT: refus déplacement (négation)", "Non, nous n'intervenons pas à domicile. Nos prestations se font à l'atelier.", "deplacement_domicile", false);
check("LÉGIT: 'Pas de déplacement à domicile' (phrasing prod sorties structurées)", "Nos prestations se font exclusivement à l'atelier de Villenoy. Pas de déplacement à domicile. 📍", "deplacement_domicile", false);
check("LÉGIT: 'aucun déplacement à domicile'", "Nous ne proposons aucun déplacement à domicile.", "deplacement_domicile", false);
check("LÉGIT: venir à l'atelier", "Nos prestations se font exclusivement à l'atelier de Villenoy (77124). Êtes-vous disponible pour vous déplacer ?", "deplacement_domicile", false);
check("LÉGIT: adresse atelier", "On est au 38 Rue Jean Pierre Plicque, 77124 Villenoy.", "deplacement_domicile", false);

console.log("\n🔬 garantie_chiffree");
check("garantie de 12 mois", "La prestation est couverte par une garantie de 12 mois.", "garantie_chiffree", true);
check("2 ans de garantie", "Vous bénéficiez de 2 ans de garantie sur la reprog.", "garantie_chiffree", true);
check("LÉGIT: renvoi CGV", "Pour la garantie, se référer à nos CGV.", "garantie_chiffree", false);
check("LÉGIT: durée intervention 2h", "L'intervention dure environ 2 heures.", "garantie_chiffree", false);

console.log("\n🔬 specs_inventees");
check("votre C1 fait 68 ch (spec absolue inventée)", "Votre C1 fait 68 ch d'origine, la reprog apportera un gain notable.", "specs_inventees", true);
check("votre Golf de 150 chevaux", "Sur votre Golf de 150 chevaux, le Stage 1 est tout indiqué.", "specs_inventees", true);
check("votre 2.0 TDI (famille moteur)", "Sur votre 2.0 TDI, la suppression FAP est possible.", "specs_inventees", true);
check("votre 1.6 HDi", "Votre 1.6 HDi supporte très bien la reprogrammation.", "specs_inventees", true);
check("couple absolu 320 Nm d'origine", "Votre moteur développe 320 Nm de couple d'origine.", "specs_inventees", true);
check("cylindrée 1968 cm³", "Votre bloc de 1968 cm³ est un excellent candidat.", "specs_inventees", true);
check("LÉGIT: gain +30 ch (→ gains_chiffres, pas specs)", "Sur votre véhicule, comptez environ +30 ch avec le Stage 1.", "specs_inventees", false);
check("LÉGIT: hypothèse 'si votre Golf fait 150 ch'", "Sans la plaque je ne peux pas confirmer, mais si votre Golf fait 150 ch, le Stage 1 est adapté.", "specs_inventees", false);
check("LÉGIT: specs génériques sans 'votre'", "Un moteur 2.0 TDI développe généralement entre 140 et 190 ch selon la version.", "specs_inventees", false);
check("LÉGIT: prix 390€ (pas une spec)", "Pour votre reprogrammation Stage 1, comptez 390€ TTC.", "specs_inventees", false);
check("LÉGIT: durée 2h (pas une spec moteur)", "L'intervention sur votre véhicule dure environ 2 heures.", "specs_inventees", false);
check("LÉGIT: demande la plaque au lieu d'affirmer", "Pour connaître la puissance de votre véhicule, envoyez-moi votre plaque.", "specs_inventees", false);

console.log("\n════════════════════════════════════════");
console.log(`Résultat détecteurs : ${pass} ✅ / ${fail} ❌`);
if (fail > 0) { console.log("❌ Détecteurs à corriger (faux positif/négatif).\n"); process.exit(1); }
console.log("Tous les détecteurs d'hallucination passent ✨\n");
