"""
Bande-son de la promo DiagPerf : voix off + musique + sound design, puis mux MP4.

    python scripts/audio.py            → out/audio/soundtrack.wav + out/diagperf-promo-final.mp4
    python scripts/audio.py --no-mux   → bande-son seule (écoutable dans la prévisualisation)

Tout est généré ici, rien n'est téléchargé hors voix :
  - voix off  : voix neuronale Microsoft via edge-tts (audio/voiceover.json, cache par hash)
  - musique   : synthwave 120 BPM synthétisée (kick, clap, hats, basse, nappes, arpège)
  - sound design calé sur l'image : tic-tac, impact, whoosh, pops de bulles, laser,
    compteurs, « ka-ching », riser, volet, scintillement du logo.
Mix : la musique est baissée (ducking) sous la voix, normalisation finale à -14 LUFS
(standard Instagram / TikTok / YouTube), true peak -1.5 dBTP.

Timecodes : les bulles sont lues dans index.html (data-at) ; les autres repères
reprennent src/scenes.js et src/timeline.js (les modifier ensemble).
"""
import argparse
import asyncio
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt, sosfilt_zi

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = OUT / "audio"
SR = 48000
DUR = 30.0
N = int(SR * DUR)
RNG = np.random.default_rng(20260923)

# ── Repères (miroir de src/scenes.js / src/timeline.js) ─────────────────────
HOOK_PUNCH = 2.5
WHIP = 3.5
BEAT_DROP = 4.0          # le téléphone arrive : la musique démarre
LASER = (8.2, 0.55)      # départ, durée d'un aller (aller-retour)
HP_COUNT = (10.5, 1.2)   # 156 → 196 ch, ease power2.out
PRICE_COUNT = (14.0, 1.0)
PRICE_PULSE = 15.0
BUTTONS = 14.6
FEATURES = 16.4
CHIPS = [FEATURES + 0.6 + i * 0.16 for i in range(4)]
HEADLINE = FEATURES + 1.75
OUTRO = 22.6
WIPE_UP = OUTRO + 0.72
LETTERS = [OUTRO + 1.15 + i * 0.05 for i in range(8)]
CTA = OUTRO + 2.45


# ════════════════════════════ utilitaires ═══════════════════════════════════
def tt(dur):
    return np.arange(int(dur * SR)) / SR


def sos(kind, f, order=2):
    return butter(order, f, btype=kind, fs=SR, output="sos")


def filt(x, kind, f, order=2):
    return sosfilt(sos(kind, f, order), x)


def sweep_filter(x, kind, f0, f1, curve=2.0, block=256):
    """Filtre dont la fréquence glisse de f0 à f1 (traitement par blocs, état conservé)."""
    y = np.zeros_like(x)
    n = len(x)
    s = sos(kind, f0)
    zi = sosfilt_zi(s) * 0.0
    for i in range(0, n, block):
        p = (i / max(n - 1, 1)) ** curve
        f = f0 * (f1 / f0) ** p
        s = sos(kind, f)
        y[i:i + block], zi = sosfilt(s, x[i:i + block], zi=zi)
    return y


def saw(freq_t, phase0=0.0):
    ph = np.cumsum(freq_t) / SR + phase0
    return 2.0 * (ph - np.floor(ph + 0.5))


def sine(freq_t):
    return np.sin(2 * np.pi * np.cumsum(freq_t) / SR)


def env_ad(n, attack, decay_tau):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(t - attack, 0) / decay_tau)


def env_asr(n, attack, release):
    e = np.ones(n)
    na, nr = int(attack * SR), int(release * SR)
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e


def noise(dur):
    return RNG.standard_normal(int(dur * SR))


class Bus:
    """Bus stéréo : place(signal mono, à t, gain, panoramique -1..1)."""

    def __init__(self):
        self.x = np.zeros((N, 2), dtype=np.float64)

    def place(self, sig, at, gain=1.0, pan=0.0):
        i = int(round(at * SR))
        if i >= N or len(sig) == 0:
            return
        j = min(N, i + len(sig))
        s = sig[: j - i] * gain
        a = (pan + 1) * np.pi / 4  # loi de panoramique à puissance constante
        self.x[i:j, 0] += s * np.cos(a)
        self.x[i:j, 1] += s * np.sin(a)


def comb(x, d, g):
    y = x.copy()
    for k in range(d, len(x), d):
        y[k:k + d] += g * y[k - d:k][: len(y[k:k + d])]
    return y


def allpass(x, d, g):
    y = np.zeros_like(x)
    xd = np.concatenate([np.zeros(d), x[:-d]])
    y[:d] = -g * x[:d] + xd[:d]
    for k in range(d, len(x), d):
        e = min(k + d, len(x))
        y[k:e] = -g * x[k:e] + xd[k:e] + g * y[k - d:e - d]
    return y


def reverb(stereo, mix=0.25, size=1.0):
    """Réverbe de Schroeder (4 combs + 2 allpass par canal, décorrélés)."""
    out = np.zeros_like(stereo)
    for c, off in ((0, 0), (1, 23)):
        x = filt(stereo[:, c], "highpass", 200)
        wet = sum(comb(x, int((ms + off * 0.05) * size * SR / 1000), g)
                  for ms, g in ((29.7, 0.80), (37.1, 0.79), (41.1, 0.78), (43.7, 0.77)))
        wet = allpass(allpass(wet * 0.25, int(5.0 * SR / 1000), 0.7), int(1.7 * SR / 1000), 0.7)
        out[:, c] = stereo[:, c] + mix * filt(wet, "lowpass", 6000)
    return out


def db(v):
    return 10 ** (v / 20)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))


# ═════════════════════════════ voix off ═════════════════════════════════════
def decode(path, af=None):
    cmd = ["ffmpeg", "-v", "error", "-i", str(path)]
    if af:
        cmd += ["-af", af]
    cmd += ["-f", "f32le", "-ac", "1", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def trim(x, thr=0.015, pad=0.02):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(pad * SR))
    b = min(len(x), idx[-1] + int(0.12 * SR))  # garde la fin naturelle du souffle
    return x[a:b]


async def synth_lines(cfg):
    import edge_tts
    CACHE.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, line in enumerate(cfg["lines"]):
        rate = line.get("rate", cfg["rate"])
        key = hashlib.sha1(f'{cfg["voice"]}|{rate}|{cfg["pitch"]}|{line["text"]}'.encode()).hexdigest()[:10]
        p = CACHE / f"vo-{i:02d}-{key}.mp3"
        if not p.exists():
            await edge_tts.Communicate(line["text"], cfg["voice"], rate=rate, pitch=cfg["pitch"]).save(str(p))
        paths.append(p)
    return paths


# Chaîne « voix pub » : coupe-bas, présence, compression douce.
VO_CHAIN = "highpass=f=90,equalizer=f=220:t=q:w=1.2:g=1.5,equalizer=f=3200:t=q:w=1:g=2.5,acompressor=threshold=-20dB:ratio=3:attack=4:release=90:makeup=2"


def build_voice():
    cfg = json.loads((ROOT / "audio" / "voiceover.json").read_text(encoding="utf-8"))
    paths = asyncio.run(synth_lines(cfg))
    bus = Bus()
    spans = []
    for line, p in zip(cfg["lines"], paths):
        slot = line["end"] - line["at"]
        x = trim(decode(p, VO_CHAIN))
        dur = len(x) / SR
        tempo = 1.0
        if dur > slot:
            tempo = dur / slot
            if tempo > 1.15:
                sys.exit(f"✖ Réplique trop longue ({dur:.2f}s pour {slot:.2f}s) : « {line['text']} » — raccourcissez-la.")
            x = trim(decode(p, f"atempo={tempo:.4f}," + VO_CHAIN))
        bus.place(x, line["at"], 1.0)
        spans.append((line["at"], line["at"] + len(x) / SR))
        print(f"  voix {line['at']:5.2f}s  {len(x)/SR:4.2f}s/{slot:4.2f}s{'  (×%.2f)' % tempo if tempo > 1 else ''}  {line['text']}")
    peak = np.max(np.abs(bus.x)) or 1.0
    bus.x *= db(-3) / peak
    return bus, spans


# ═══════════════════════════ instruments ════════════════════════════════════
def kick():
    t = tt(0.5)
    f = 46 + 110 * np.exp(-t / 0.032)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.17)
    click = filt(noise(0.5), "highpass", 3000) * np.exp(-t / 0.004) * 0.35
    return np.tanh(1.6 * (body + click))


def clap():
    n = noise(0.3)
    t = tt(0.3)
    e = sum(np.exp(-np.maximum(t - d, 0) / 0.009) * (t >= d) for d in (0, 0.011, 0.022))
    e = e * 0.6 + np.exp(-t / 0.11) * 0.5
    return filt(n, "bandpass", [900, 2600]) * e


def hat(open_=False):
    d = 0.22 if open_ else 0.06
    return filt(noise(d), "highpass", 7500) * np.exp(-tt(d) / (0.07 if open_ else 0.018))


NOTE = {"F2": 87.31, "G2": 98.0, "A2": 110.0, "C3": 130.81, "E3": 164.81,
        "F3": 174.61, "G3": 196.0, "A3": 220.0, "B3": 246.94, "C4": 261.63, "D4": 293.66,
        "E4": 329.63, "F4": 349.23, "G4": 392.0, "A4": 440.0, "B4": 493.88, "C5": 523.25,
        "D5": 587.33, "E5": 659.26, "G5": 783.99, "A5": 880.0}
# Am – F – C – G (1 mesure = 2 s à 120 BPM)
CHORDS = [("A2", ["A3", "C4", "E4"], ["A4", "C5", "E5", "A5"]),
          ("F2", ["F3", "A3", "C4"], ["F4", "A4", "C5", "A5"]),
          ("C3", ["G3", "C4", "E4"], ["E4", "G4", "C5", "E5"]),
          ("G2", ["G3", "B3", "D4"], ["D4", "G4", "B4", "D5"])]


def bass_note(f, dur=0.23, bright=1.0):
    n = int(dur * SR)
    ft = np.full(n, f)
    x = saw(ft) + 0.5 * saw(ft * 1.005)
    lo = filt(x, "lowpass", 420)
    hi = filt(x, "lowpass", 1400 * bright)
    e = env_ad(n, 0.004, 0.11)
    return (lo * 0.8 + hi * 0.45 * e) * env_asr(n, 0.004, 0.03) * (0.55 + 0.45 * e)


def pad_chord(notes, dur, cutoff):
    n = int(dur * SR)
    x = np.zeros(n)
    for name in notes:
        f = NOTE[name]
        for det in (-0.006, 0.0, 0.0065):
            x += saw(np.full(n, f * (1 + det)), RNG.random())
    return filt(x / 9, "lowpass", cutoff) * env_asr(n, 0.35, 0.45)


def pluck(f, dur=0.22):
    t = tt(dur)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) * np.exp(-t / 0.03)
    return x * env_ad(len(t), 0.002, 0.07)


def bell(f, dur=1.2, tau=0.45):
    t = tt(dur)
    return sum(a * np.sin(2 * np.pi * f * r * t) * np.exp(-t / (tau / r ** 0.5))
               for r, a in ((1, 1.0), (2.76, 0.35), (5.4, 0.12))) * env_ad(len(t), 0.002, 9)


def pop(f0, f1, dur=0.09):
    t = tt(dur)
    f = f0 + (f1 - f0) * (1 - np.exp(-t / 0.02))
    return sine(f) * env_ad(len(t), 0.002, 0.03) + filt(noise(dur), "highpass", 4000) * np.exp(-t / 0.002) * 0.15


def tick(f=2200, dur=0.03):
    t = tt(dur)
    return np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006)


def whoosh(dur, f0, f1, peak=0.7):
    n = noise(dur)
    t = np.linspace(0, 1, len(n))
    e = np.where(t < peak, (t / peak) ** 2.2, np.exp(-(t - peak) / 0.12))
    return sweep_filter(n, "lowpass", f0, f1) * e


def riser(dur):
    n = noise(dur)
    t = np.linspace(0, 1, len(n))
    hiss = sweep_filter(n, "highpass", 400, 7000, curve=1.3) * t ** 2.5
    tone = sine(200 * (6 ** t)) * t ** 3 * 0.25
    return hiss + tone


def impact(dur=1.6, sub=55):
    t = tt(dur)
    f = sub * 0.55 + sub * np.exp(-t / 0.12)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.55)
    crack = filt(noise(dur), "lowpass", 3500) * np.exp(-t / 0.08)
    return np.tanh(1.4 * boom) + crack * 0.6


# ═════════════════════════════ musique ══════════════════════════════════════
def build_music():
    drums, bass, pads, arp = Bus(), Bus(), Bus(), Bus()
    K, C, H, HO = kick(), clap(), hat(), hat(True)
    beat = 0.5

    # Intro tendue (0 → 4 s) : nappe sourde en La mineur + bourdon qui monte
    pads.place(pad_chord(["A3", "C4", "E4"], BEAT_DROP + 0.4, 650), 0.0, 0.8)
    t = tt(HOOK_PUNCH)
    pads.place(np.sin(2 * np.pi * 55 * t) * (t / HOOK_PUNCH) ** 2 * 0.9, 0.0, 0.6)

    def groove(start, end, intensity=1.0, arp_on=False, bright=1.0):
        nbeats = int(round((end - start) / beat))
        for b in range(nbeats):
            at = start + b * beat
            drums.place(K, at, 0.95 * intensity)
            if b % 2 == 1:
                drums.place(C, at, 0.55 * intensity, pan=0.05)
            drums.place(H, at + beat / 2, 0.22 * intensity, pan=0.35)
            if b % 4 == 3:
                drums.place(HO, at + beat / 2, 0.12 * intensity, pan=0.35)
        bar0 = start
        while bar0 < end - 1e-6:
            idx = int(round((bar0 - BEAT_DROP) / 2.0)) % 4
            root, chord, arpn = CHORDS[idx]
            bar_len = min(2.0, end - bar0)
            pads.place(pad_chord(chord, bar_len + 0.3, 1500 * bright), bar0, 0.7 * intensity, pan=0.0)
            for k in range(int(bar_len / 0.25)):  # basse en croches
                f = NOTE[root] * (2 if k % 4 == 3 else 1)
                bass.place(bass_note(f, bright=bright), bar0 + k * 0.25, 0.9 * intensity)
            if arp_on:
                for k in range(int(bar_len / 0.125)):  # arpège en doubles-croches, ping-pong
                    f = NOTE[arpn[k % 4]] * (2 if (k // 4) % 2 else 1)
                    arp.place(pluck(f), bar0 + k * 0.125, 0.5, pan=-0.45 if k % 2 else 0.45)
            bar0 += 2.0

    groove(BEAT_DROP, 9.3 + 0.7, 0.85)                    # couplet : le chat démarre
    groove(10.0, FEATURES, 0.95, arp_on=True)             # la fiche, le devis : ça s'emballe
    groove(FEATURES, OUTRO - 0.5, 1.0, arp_on=True, bright=1.5)  # bénéfices : on ouvre le filtre
    # Roulement de kick sur le dernier demi-temps avant l'outro
    for k in range(4):
        drums.place(K, OUTRO - 0.5 + k * 0.125, 0.5 + 0.12 * k)
    # Outro : groove plus léger puis accord final tenu
    groove(OUTRO + 1.4, 28.0, 0.6, arp_on=False)
    pads.place(pad_chord(["A3", "C4", "E4", "A4"], 2.6, 1300), 28.0, 0.9)
    bass.place(bass_note(NOTE["A2"], dur=1.8) * np.exp(-tt(1.8) / 0.9), 28.0, 0.8)

    # Pompage façon sidechain : basse et nappes s'écartent à chaque kick
    pump = np.ones(N)
    tt_ = np.arange(N) / SR
    for start, end in ((BEAT_DROP, OUTRO), (OUTRO + 1.4, 28.0)):
        m = (tt_ >= start) & (tt_ < end)
        pump[m] = 1 - 0.55 * np.exp(-((tt_[m] - start) % beat) / 0.11)
    bass.x *= pump[:, None]
    pads.x *= pump[:, None]

    arp.x = reverb(arp.x, 0.5, 1.2)
    pads.x = reverb(pads.x, 0.35, 1.4)
    music = drums.x * 1.0 + bass.x * 0.55 + pads.x * 0.42 + arp.x * 0.16
    return music


# ═══════════════════════════ sound design ═══════════════════════════════════
def build_sfx():
    fx = Bus()
    # Tic-tac de l'horloge 23:47 (s'arrête net sur l'impact)
    for i, at in enumerate(np.arange(0.0, HOOK_PUNCH - 0.1, 0.5)):
        fx.place(tick(2600 if i % 2 == 0 else 1900, 0.04), at, 0.35, pan=0.15 if i % 2 else -0.15)
    fx.place(impact(1.8, 52), HOOK_PUNCH - 0.02, 0.85)
    fx.place(whoosh(0.6, 300, 6000, peak=0.75), WHIP - 0.1, 0.55)
    fx.place(impact(0.9, 70) * 0.5, BEAT_DROP, 0.5)  # le téléphone « atterrit »

    # Bulles WhatsApp (instants lus dans index.html)
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for kind, at in re.findall(r'class="msg (in|out)"[^>]*data-at="([\d.]+)"', html):
        at = float(at)
        if kind == "out":
            fx.place(pop(900, 1500, 0.08), at, 0.45, pan=0.2)
        else:
            fx.place(pop(520, 820, 0.1), at, 0.5, pan=-0.2)
    fx.place(pop(700, 1000, 0.07), BUTTONS + 0.8, 0.3)

    # Laser qui balaie la plaque (aller-retour, suit l'ease sine.inOut de l'image)
    start, leg = LASER
    t = tt(leg * 2)
    pos = np.where(t < leg, 0.5 - 0.5 * np.cos(np.pi * t / leg), 0.5 + 0.5 * np.cos(np.pi * (t - leg) / leg))
    las = np.tanh(2.5 * sine(1400 + 1600 * pos)) * (1 + 0.3 * np.sin(2 * np.pi * 30 * t)) * env_asr(len(t), 0.03, 0.08)
    fx.place(filt(las, "lowpass", 5000), start, 0.07)

    # Compteurs : un tic par unité franchie (ease power2.out comme l'image)
    def counter(t0, dur, v0, v1, step, f0, f1, gain):
        vals = np.arange(v0 + step, v1 + step / 2, step)
        for v in vals:
            p = (v - v0) / (v1 - v0)
            u = 1 - np.sqrt(1 - p)  # inverse de 1-(1-u)^2
            fx.place(tick(f0 + (f1 - f0) * p, 0.025), t0 + u * dur, gain)
    counter(*HP_COUNT, 156, 196, 2, 1500, 2600, 0.22)
    fx.place(whoosh(1.0, 200, 2500, peak=0.25) * 0.5, HP_COUNT[0], 0.3)
    counter(*PRICE_COUNT, 0, 390, 15, 1700, 2900, 0.18)
    fx.place(bell(1568, 1.4), PRICE_PULSE, 0.3, pan=-0.2)   # « ka-ching »
    fx.place(bell(2093, 1.4), PRICE_PULSE + 0.07, 0.28, pan=0.2)

    # Bénéfices
    fx.place(whoosh(0.9, 200, 3500, peak=0.5), FEATURES - 0.1, 0.45)
    for i, at in enumerate(CHIPS):
        fx.place(pop(600 + 120 * i, 1000 + 150 * i, 0.08), at + 0.12, 0.3, pan=0.35)
    fx.place(impact(0.8, 80) * 0.4, HEADLINE, 0.45)

    # Outro : riser → impact sur le volet → whoosh quand il remonte → scintillement du logo
    fx.place(riser(1.4), OUTRO - 1.35, 0.32)
    fx.place(impact(2.2, 45), OUTRO + 0.05, 1.0)
    fx.place(whoosh(0.7, 400, 7000, peak=0.6), WIPE_UP - 0.05, 0.45)
    for i, at in enumerate(LETTERS):
        fx.place(bell([1318.5, 1568, 1760, 2093, 2349, 2637, 3136, 3520][i], 1.0, 0.35), at, 0.07, pan=-0.6 + i * 0.17)
    fx.place(pop(500, 900, 0.12), CTA, 0.4)
    fx.x = reverb(fx.x, 0.22, 1.0)
    return fx.x


# ═══════════════════════════════ mix ════════════════════════════════════════
def main():
    # Console Windows (cp1252) : sans ça, les accents et symboles des logs plantent le script.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-mux", action="store_true")
    ap.add_argument("--video", default=str(OUT / "diagperf-promo.mp4"))
    ap.add_argument("--out", default=str(OUT / "diagperf-promo-final.mp4"))
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)

    print("◆ Voix off")
    voice, spans = build_voice()
    print("◆ Musique")
    music = build_music()
    print("◆ Sound design")
    sfx = build_sfx()

    # Niveaux : musique ~13 dB sous la voix, puis -7 dB de plus pendant qu'on parle
    vo_rms = rms(np.concatenate([voice.x[int(a * SR):int(b * SR), 0] for a, b in spans]))
    music *= vo_rms * db(-13) / rms(music[int(BEAT_DROP * SR):int(OUTRO * SR)])
    mask = np.zeros(N)
    for a, b in spans:
        mask[int(a * SR):int(b * SR)] = 1.0
    win = np.hanning(int(0.25 * SR))
    duck = 1 - (1 - db(-7)) * np.clip(np.convolve(mask, win / win.sum(), mode="same"), 0, 1)
    music *= duck[:, None]
    sfx *= vo_rms * db(-9) / max(np.max(np.abs(sfx)), 1e-9) * 2.2

    mix = voice.x + music + sfx
    fade = int(0.6 * SR)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
    mix = np.tanh(mix / (np.max(np.abs(mix)) + 1e-9) * 1.25) * 0.8  # limiteur doux

    raw = CACHE / "mix-raw.wav"
    wavfile.write(raw, SR, mix.astype(np.float32))
    final_wav = CACHE / "soundtrack.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw),
                    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), "-c:a", "pcm_s16le", str(final_wav)], check=True)
    print(f"✔ {final_wav.relative_to(ROOT)}")

    if not args.no_mux:
        if not Path(args.video).exists():
            sys.exit(f"✖ Vidéo introuvable : {args.video} — lancez d'abord `npm run render`.")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", args.video, "-i", str(final_wav),
                        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                        "-shortest", "-movflags", "+faststart", args.out], check=True)
        print(f"✔ {Path(args.out).relative_to(ROOT)}")


if __name__ == "__main__":
    main()
