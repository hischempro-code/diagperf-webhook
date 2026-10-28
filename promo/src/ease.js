/**
 * Ressort amorti analytique utilisable comme `ease` GSAP.
 *
 * Résout l'oscillateur harmonique sous-amorti  x'' + 2ζω x' + ω² x = ω²
 * (départ x=0, v=0), normalisé pour que le mouvement soit « posé » à p = 1 :
 * ω est choisi tel que e^(-ζω) = e^(-settle) → l'enveloppe résiduelle vaut ~0.1 %.
 *
 * @param {number} damping  ratio d'amortissement ζ (0.3 = très rebondissant, 0.9 = presque critique)
 * @param {number} settle   « temps de pose » en constantes de temps (plus haut = plus nerveux)
 */
export function spring({ damping = 0.55, settle = 7 } = {}) {
  const z = Math.min(Math.max(damping, 0.05), 0.99);
  const w = settle / z;
  const wd = w * Math.sqrt(1 - z * z);
  const k = (z * w) / wd;
  const raw = (p) => 1 - Math.exp(-z * w * p) * (Math.cos(wd * p) + k * Math.sin(wd * p));
  const end = raw(1); // résidu infime, corrigé linéairement → arrivée exacte à 1
  return (p) => (p >= 1 ? 1 : p <= 0 ? 0 : raw(p) + (1 - end) * p);
}

/** Presets de la vidéo — un « langage de mouvement » cohérent d'une scène à l'autre. */
export const S = {
  phone: spring({ damping: 0.62, settle: 6.5 }),   // arrivée lourde, un seul rebond
  bubble: spring({ damping: 0.5, settle: 7.5 }),   // pop de bulle, léger overshoot
  punch: spring({ damping: 0.38, settle: 7 }),     // impact typographique
  chip: spring({ damping: 0.58, settle: 7 }),
  letter: spring({ damping: 0.45, settle: 8 }),
};

/** Interpolation lisse (Hermite) — utilisée côté canvas, sans allocation. */
export const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
