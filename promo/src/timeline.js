/**
 * Timeline cinématique (GSAP, en pause — le temps est imposé de l'extérieur).
 *
 * Contrat de déterminisme : tl.time(t) + frame(t) suffisent à reconstruire la
 * frame t, quel que soit l'ordre de visite (lecture, scrub arrière, export).
 * → aucun tl.call(), aucun onUpdate : les valeurs dérivées (compteurs, points
 *   « écrit… », anneaux du CTA) sont recalculées dans frame(t) depuis des proxies.
 * → règle fromTo : un seul fromTo par élément/propriété (le premier), puis des .to,
 *   sinon l'immediateRender d'un fromTo tardif écraserait l'état initial. Un fromTo
 *   tardif sur un élément déjà animé prend immediateRender:false, pour lire ses
 *   valeurs de départ au moment où la tête de lecture l'atteint (pas au build).
 */
import { gsap } from "gsap";
import { S } from "./ease.js";
import { SCENES as T, DURATION } from "./scenes.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

export function buildTimeline() {
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
  tl.set({}, {}, DURATION); // fixe la durée totale

  // Proxies lus par frame(t)
  const P = { hp: 156, price: 0 };
  const typingWindows = [];

  // ════════ 1. ACCROCHE (0 → 4 s) ════════════════════════════════════════
  // Calée sur la voix off (audio/voiceover.json) : « 23h47 » 0.25 s,
  // « Le garage est fermé » 1.5 s, « Pas votre devis » 2.55 s.
  tl.fromTo(
    "#hook .clock .d",
    { yPercent: 70, autoAlpha: 0, filter: "blur(12px)" },
    { yPercent: 0, autoAlpha: 1, filter: "blur(0px)", duration: 0.8, stagger: 0.09, ease: S.letter },
    0.15
  );
  tl.fromTo("#hook .hook-line .w", { yPercent: 115 }, { yPercent: 0, duration: 0.8, stagger: 0.07, ease: "expo.out" }, 1.4);
  // Impact : la punchline arrive en ressort, la ligne précédente recule, la scène tremble.
  tl.fromTo(
    "#hook .hook-punch",
    { autoAlpha: 0, scale: 1.75, y: 20 },
    { autoAlpha: 1, scale: 1, y: 0, duration: 0.95, ease: S.punch },
    2.5
  );
  tl.to("#hook .hook-line, #hook .clock", { opacity: 0.4, duration: 0.5, ease: "power2.out" }, 2.55);
  tl.fromTo("#hook", { y: 0 }, { keyframes: { y: [0, -16, 11, -6, 3, 0] }, duration: 0.42, ease: "none" }, 2.63);
  // Sortie en whip-pan (synchronisée avec le pic de vitesse du fond, cf. SPEED_KEYS)
  tl.fromTo(
    "#hook",
    { filter: "blur(0px)" },
    { x: -1300, skewX: -16, autoAlpha: 0, filter: "blur(20px)", duration: 0.5, ease: "power4.in", immediateRender: false },
    3.5
  );

  // ════════ 2. TÉLÉPHONE (4 s) ═══════════════════════════════════════════
  const phoneWrap = $("#phoneWrap");
  gsap.set(phoneWrap, { transformPerspective: 1900, transformOrigin: "50% 55%" });
  tl.fromTo(
    phoneWrap,
    { y: 1800, rotationX: 34, rotation: -9 },
    { y: 0, rotationX: 0, rotation: 0, duration: 1.55, ease: S.phone },
    T.phone - 0.3
  );
  tl.fromTo("#captions .kicker", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.7 }, T.phone + 0.35);

  // Captions : chaque phrase entre par le bas du masque, sort par le haut.
  const caps = $$("#captions .cap > span");
  const capIn = [T.chat - 0.35, 7.6, 12.6];
  caps.forEach((c, i) => {
    tl.fromTo(c, { yPercent: 115 }, { yPercent: 0, duration: 0.85, ease: "expo.out" }, capIn[i]);
    const out = i < caps.length - 1 ? capIn[i + 1] - 0.12 : T.features - 0.1;
    tl.to(c, { yPercent: -115, duration: 0.45, ease: "power3.in" }, out);
  });
  tl.to("#captions .kicker", { autoAlpha: 0, y: -24, duration: 0.4, ease: "power2.in" }, T.features - 0.1);

  // ════════ 3. CONVERSATION (5.2 → 16 s) ═════════════════════════════════
  const list = $("#chatList");
  const viewportH = $(".chat").clientHeight;
  const scrollToBottom = (bottom, at, duration = 0.65) =>
    tl.to(list, { y: Math.min(0, viewportH - bottom - 28), duration, ease: "power3.out" }, at);

  gsap.set(list, { y: 0 });
  $$(".msg").forEach((msg) => {
    const at = parseFloat(msg.dataset.at);
    const bubble = msg.querySelector(".bubble");
    const typing = msg.querySelector(".typing");

    if (typing) {
      const typingAt = parseFloat(msg.dataset.typing);
      typingWindows.push([typingAt, at]);
      tl.fromTo(typing, { autoAlpha: 0, scale: 0.5 }, { autoAlpha: 1, scale: 1, duration: 0.45, ease: S.bubble }, typingAt);
      tl.to(typing, { autoAlpha: 0, scale: 0.85, duration: 0.14, ease: "power2.in" }, at - 0.06);
      // Les « … » d'abord, puis on fait de la place pour le vrai message
      scrollToBottom(msg.offsetTop + typing.offsetHeight, typingAt);
    }
    scrollToBottom(msg.offsetTop + msg.offsetHeight, at, msg.offsetHeight > 300 ? 0.95 : 0.65);
    tl.fromTo(bubble, { autoAlpha: 0, scale: 0.55, y: 26 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.8, ease: S.bubble }, at);

    const btns = msg.querySelector(".wa-buttons");
    if (btns) {
      tl.fromTo(
        btns.children,
        { autoAlpha: 0, y: -16, scale: 0.92 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.6, stagger: 0.1, ease: S.bubble },
        at + 0.8
      );
    }
  });

  // Scan laser sur la plaque
  const plateW = $(".plate").offsetWidth;
  tl.fromTo(".laser", { autoAlpha: 0, x: 0 }, { autoAlpha: 1, duration: 0.15 }, 8.2);
  tl.to(".laser", { x: plateW - 10, duration: 0.55, ease: "sine.inOut", repeat: 1, yoyo: true }, 8.2);
  tl.to(".laser", { autoAlpha: 0, duration: 0.2 }, 9.3);

  // Fiche véhicule : compteur de puissance + barre de gain + lignes en cascade
  tl.to(P, { hp: 196, duration: 1.2, ease: "power2.out" }, 10.5);
  tl.fromTo(".bar-gain", { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "expo.out" }, 10.5);
  tl.fromTo(".card .c-row, .card .c-ask", { autoAlpha: 0, x: -18 }, { autoAlpha: 1, x: 0, duration: 0.5, stagger: 0.16 }, 10.9);

  // Devis : le prix « tourne » jusqu'à 390 €, puis pulse
  tl.to(P, { price: 390, duration: 1.0, ease: "power2.out" }, 14.0);
  tl.fromTo("#priceVal", { scale: 1 }, { keyframes: { scale: [1, 1.22, 1] }, duration: 0.5, ease: "power2.out" }, 15.0);

  // ════════ 4. RECUL + BÉNÉFICES (16.4 → 22.6 s) ══════════════════════════
  const F = T.features;
  tl.to(phoneWrap, { x: -212, y: -352, scale: 0.62, rotationY: 20, rotationX: 4, duration: 1.3, ease: "expo.inOut" }, F);
  tl.to(phoneWrap, { rotationY: 12, rotationX: 2, duration: T.outro - F - 1.4, ease: "none" }, F + 1.3); // dérive lente
  tl.fromTo(".sweep", { xPercent: -130 }, { xPercent: 130, duration: 1.2, ease: "power2.inOut" }, F + 1.0);

  gsap.set(".chip", { transformPerspective: 1200, transformOrigin: "0% 50%" });
  tl.fromTo(
    ".chip",
    { autoAlpha: 0, x: 170, rotationY: -40 },
    { autoAlpha: 1, x: 0, rotationY: 0, duration: 1.05, stagger: 0.16, ease: S.chip },
    F + 0.6
  );
  tl.fromTo(".chip .ico", { scale: 0, rotation: -30 }, { scale: 1, rotation: 0, duration: 0.75, stagger: 0.16, ease: S.punch }, F + 0.78);
  tl.fromTo("#headline .mask > span", { yPercent: 115 }, { yPercent: 0, duration: 0.95, stagger: 0.14, ease: "expo.out" }, F + 1.75);

  // ════════ 5. OUTRO (22.6 → 30 s) ═══════════════════════════════════════
  const O = T.outro;
  // Le téléphone « traverse la caméra »
  tl.fromTo(
    phoneWrap,
    { filter: "blur(0px)" },
    { scale: 1.6, autoAlpha: 0, filter: "blur(16px)", duration: 0.55, ease: "power3.in", immediateRender: false },
    O - 0.1
  );
  tl.to(["#chips", "#headline"], { autoAlpha: 0, scale: 1.25, duration: 0.45, ease: "power3.in" }, O - 0.15);

  // Volet rouge circulaire, puis il remonte et découvre l'outro
  tl.fromTo("#wipe", { clipPath: "circle(0% at 50% 55%)" }, { clipPath: "circle(80% at 50% 55%)", duration: 0.6, ease: "power3.inOut" }, O + 0.05);
  tl.fromTo("#outro", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, O + 0.62);
  tl.fromTo("#wipe", { yPercent: 0 }, { yPercent: -100, duration: 0.75, ease: "power4.inOut", immediateRender: false }, O + 0.72);

  tl.fromTo(
    ".o-car",
    { autoAlpha: 0, x: -280, clipPath: "inset(0% 100% 0% 0%)" },
    { autoAlpha: 1, x: 0, clipPath: "inset(0% 0% 0% 0%)", duration: 1.2, ease: "expo.out" },
    O + 0.95
  );
  tl.fromTo(".o-word span", { yPercent: 125, rotation: 10 }, { yPercent: 0, rotation: 0, duration: 0.95, stagger: 0.05, ease: S.letter }, O + 1.15);
  tl.fromTo(".o-line", { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "expo.inOut" }, O + 1.6);
  tl.fromTo([".o-tag", ".o-loc"], { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.12 }, O + 1.95);
  tl.fromTo(".o-cta", { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 1.0, ease: S.punch }, O + 2.45);
  tl.fromTo(".o-phone", { autoAlpha: 0, y: 34 }, { autoAlpha: 1, y: 0, duration: 0.8 }, O + 2.85);
  tl.fromTo(".o-free", { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.7 }, O + 3.05);

  // ════════ Valeurs dérivées, recalculées à chaque frame ══════════════════
  const colon = $("#hook .colon i");
  const status = $(".wa-header .status");
  const hpEl = $("#hpVal");
  const priceEl = $("#priceVal");
  const pill = $(".cta-pill");
  const rings = $$(".ring");
  const dotGroups = $$(".typing").map((g) => Array.from(g.querySelectorAll(".dot")));
  let lastHp = -1;
  let lastPrice = -1;
  let lastTyping = null;
  const ringStart = O + 3.2;

  function frame(t) {
    // « : » de l'horloge qui clignote
    colon.style.opacity = t % 1 < 0.55 ? "1" : "0.2";

    // Statut WhatsApp « écrit… » pendant les fenêtres de frappe
    let typingIdx = -1;
    for (let i = 0; i < typingWindows.length; i++) {
      if (t >= typingWindows[i][0] && t < typingWindows[i][1]) typingIdx = i;
    }
    const isTyping = typingIdx >= 0;
    if (isTyping !== lastTyping) {
      status.textContent = isTyping ? "écrit…" : "en ligne";
      status.classList.toggle("typing-on", isTyping);
      lastTyping = isTyping;
    }
    if (isTyping) {
      const dots = dotGroups[typingIdx];
      for (let i = 0; i < dots.length; i++) {
        const y = -10 * Math.max(0, Math.sin(t * 2.6 * Math.PI * 2 - i * 0.9));
        dots[i].style.transform = `translateY(${y.toFixed(2)}px)`;
      }
    }

    // Compteurs
    const hp = Math.round(P.hp);
    if (hp !== lastHp) { hpEl.textContent = hp; lastHp = hp; }
    const price = Math.round(P.price);
    if (price !== lastPrice) { priceEl.textContent = `${price}.00€`; lastPrice = price; }

    // CTA : anneaux d'onde + respiration
    if (t >= ringStart) {
      const k = t - ringStart;
      for (let i = 0; i < rings.length; i++) {
        const ph = (k * 0.7 + i * 0.5) % 1;
        rings[i].style.opacity = ((1 - ph) * 0.85).toFixed(3);
        rings[i].style.transform = `scale(${(1 + ph * 0.12).toFixed(4)}, ${(1 + ph * 0.65).toFixed(4)})`;
      }
      pill.style.transform = `scale(${(1 + 0.022 * Math.sin(k * 3.4)).toFixed(4)})`;
    } else {
      for (let i = 0; i < rings.length; i++) rings[i].style.opacity = "0";
      pill.style.transform = "";
    }
  }

  return { tl, frame };
}
