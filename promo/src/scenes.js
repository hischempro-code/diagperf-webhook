/**
 * Timecodes maîtres (secondes). Source unique : la timeline GSAP, le fond canvas
 * et les marqueurs du lecteur lisent tous ces valeurs — décaler une scène ici
 * décale tout le reste de façon cohérente.
 */
export const SCENES = {
  hook: 0,        // 23:47 — « Le garage est fermé. Pas votre devis. »
  phone: 4.0,     // arrivée du téléphone
  chat: 5.2,      // conversation WhatsApp
  card: 9.3,      // fiche véhicule
  devis: 13.2,    // devis généré
  features: 16.4, // recul + bénéfices
  outro: 22.6,    // transition rouge + logo + CTA
};
export const DURATION = 30;

export const MARKERS = [
  ["Accroche", SCENES.hook],
  ["Chat", SCENES.chat],
  ["Fiche", SCENES.card],
  ["Devis", SCENES.devis],
  ["Bénéfices", SCENES.features],
  ["Outro", SCENES.outro],
];

/**
 * Vitesse du « vent » des lignes de fond : [temps, vitesse]. Les pics coïncident
 * avec les transitions (whip-pan de l'accroche, zoom vers l'outro).
 */
export const SPEED_KEYS = [
  [0, 0.5],
  [3.5, 0.8],
  [3.98, 7.5],
  [4.8, 1.1],
  [SCENES.features - 0.2, 1.1],
  [SCENES.features + 0.3, 3.2],
  [SCENES.features + 1.2, 1.3],
  [SCENES.outro - 0.1, 1.3],
  [SCENES.outro + 0.35, 10],
  [SCENES.outro + 1.4, 0.9],
  [DURATION, 0.9],
];
