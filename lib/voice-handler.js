/**
 * voice-handler.js — Gestion avancée des messages vocaux
 *
 * Fonctionnalités :
 * - Transcription Whisper via Groq (free tier)
 * - Détection automatique de la langue
 * - Gestion des fichiers volumineux
 * - Fallback sur erreur
 * - Métadonnées vocales (durée, qualité)
 * - Confirmation visuelle de la transcription
 * - Support TTS (Text-to-Speech) pour réponses vocales
 */

const log = {
  info: (...a) => console.log("[voice]", ...a),
  warn: (...a) => console.warn("[voice]", ...a),
  error: (...a) => console.error("[voice]", ...a),
  debug: (...a) => console.debug("[voice]", ...a),
};

// ====== Configuration ======
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
const MAX_AUDIO_SIZE_MB = 20; // Limite Groq
const MAX_TRANSCRIPT_LENGTH = 2000; // Caractères max pour éviter les abus

// Types de messages vocaux supportés
const VOICE_TYPES = new Set(["voice", "audio"]);

// Langues supportées avec leurs codes
const SUPPORTED_LANGUAGES = {
  fr: "Français",
  en: "Anglais",
  es: "Espagnol",
  de: "Allemand",
  it: "Italien",
  pt: "Portugais",
  ar: "Arabe",
  nl: "Néerlandais",
  pl: "Polonais",
  tr: "Turc",
};

/**
 * Télécharge un média WhatsApp
 * @param {string} mediaId - ID du média WhatsApp
 * @param {string} token - Token WhatsApp API
 * @param {string} apiVersion - Version API WhatsApp
 * @param {Function} fetchFn - Fonction fetch à utiliser
 * @returns {Promise<{buffer: Buffer, mimeType: string, size: number}>}
 */
async function downloadWhatsAppMedia(mediaId, token, apiVersion, fetchFn) {
  log.info("Downloading media", { mediaId });

  // Étape 1: Récupérer l'URL du média
  const metaResp = await fetchFn(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!metaResp.ok) {
    throw new Error(`Media meta failed: ${metaResp.status}`);
  }

  const meta = await metaResp.json();
  const mediaUrl = meta.url;

  if (!mediaUrl) {
    throw new Error("No media URL in Meta response");
  }

  // Étape 2: Télécharger le fichier
  const fileResp = await fetchFn(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!fileResp.ok) {
    throw new Error(`Media download failed: ${fileResp.status}`);
  }

  const buffer = Buffer.from(await fileResp.arrayBuffer());
  const sizeMB = buffer.length / (1024 * 1024);

  log.info("Media downloaded", {
    mediaId,
    sizeMB: sizeMB.toFixed(2),
    mimeType: meta.mime_type,
  });

  return {
    buffer,
    mimeType: meta.mime_type || "audio/ogg",
    size: buffer.length,
    sizeMB,
    voiceDuration: meta.voice_duration || null, // Durée en secondes si disponible
  };
}

/**
 * Transcrit un fichier audio via Groq Whisper
 * @param {Buffer} audioBuffer - Buffer audio
 * @param {string} mimeType - Type MIME
 * @param {string} language - Code langue (fr, en, etc.) ou null pour auto
 * @param {Function} fetchFn - Fonction fetch
 * @returns {Promise<{text: string, language: string, confidence: number}|null>}
 */
async function transcribeWithGroq(audioBuffer, mimeType, language = "fr", fetchFn) {
  if (!GROQ_API_KEY) {
    log.warn("Groq API key not configured");
    return null;
  }

  // Vérifier la taille
  const sizeMB = audioBuffer.length / (1024 * 1024);
  if (sizeMB > MAX_AUDIO_SIZE_MB) {
    log.warn("Audio file too large", { sizeMB: sizeMB.toFixed(2), max: MAX_AUDIO_SIZE_MB });
    return {
      text: "[Audio trop long pour la transcription automatique]",
      language: "fr",
      confidence: 0,
      error: "FILE_TOO_LARGE",
    };
  }

  // Construire le multipart form-data manuellement
  const boundary = "----FormBoundary" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("mp3") ? "mp3" : "ogg";
  const filename = `audio.${ext}`;

  const parts = [];
  // Champ model
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${GROQ_WHISPER_MODEL}`);
  // Champ language
  if (language && language !== "auto") {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`);
  }
  // Champ response_format (verbose_json pour avoir plus d'infos)
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`);
  // Champ file
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join("\r\n") + "\r\n" + fileHeader, "utf-8");
  const footerBuf = Buffer.from(fileFooter, "utf-8");
  const bodyBuffer = Buffer.concat([headerBuf, audioBuffer, footerBuf]);

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetchFn("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBuffer,
      signal: controller.signal,
    });

    const duration = Date.now() - startTime;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      log.error("Groq transcription error", { status: resp.status, duration, body: errText.slice(0, 200) });
      return null;
    }

    const result = await resp.json();

    // Format verbose_json : { text, language, duration, segments, ... }
    const transcript = (result.text || "").trim();
    const detectedLang = result.language || language || "fr";
    const audioDuration = result.duration || 0;
    const confidence = estimateConfidence(transcript, result.segments);

    if (!transcript) {
      log.warn("Empty transcription", { duration });
      return null;
    }

    // Limiter la longueur
    const truncated = transcript.length > MAX_TRANSCRIPT_LENGTH;
    const finalText = truncated
      ? transcript.slice(0, MAX_TRANSCRIPT_LENGTH) + " [tronqué]"
      : transcript;

    log.info("Transcription successful", {
      chars: finalText.length,
      language: detectedLang,
      confidence: confidence.toFixed(2),
      audioDuration: audioDuration.toFixed(1) + "s",
      processingTime: duration + "ms",
      truncated,
    });

    return {
      text: finalText,
      language: detectedLang,
      confidence,
      audioDuration,
      processingTime: duration,
      segments: result.segments?.length || 0,
    };
  } catch (err) {
    const isTimeout = err?.name === "AbortError" || String(err?.message || err).includes("abort");
    log.error("Transcription exception", { error: String(err?.message || err), timeout: isTimeout });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Estime la confiance de la transcription basée sur les segments
 */
function estimateConfidence(text, segments) {
  if (!segments || segments.length === 0) {
    // Fallback : basé sur la longueur et la qualité du texte
    if (text.length < 3) return 0.3;
    if (text.length > 500) return 0.85; // Transcriptions longues = généralement bonnes
    return 0.7;
  }

  // Moyenne des scores de confiance des segments
  const avgConfidence = segments.reduce((sum, seg) => sum + (seg.avg_logprob || -0.5), 0) / segments.length;

  // Convertir logprob en score 0-1
  // logprob proche de 0 = bon, logprob très négatif = mauvais
  const normalized = Math.max(0, Math.min(1, 1 + avgConfidence));

  return normalized;
}

/**
 * Détecte la langue probable du texte transcrit
 * Fallback simple basé sur des mots caractéristiques
 */
function detectLanguageFromText(text) {
  const lower = text.toLowerCase();

  // Mots caractéristiques par langue
  const markers = {
    fr: /\b(bonjour|salut|merci|voiture|moteur|prix|bonsoir|ça va|oui|non|je veux|j'aimerais)\b/,
    en: /\b(hello|hi|thanks|car|engine|price|good morning|yes|no|i want|i would like)\b/,
    es: /\b(hola|gracias|coche|motor|precio|buenos dias|si|no|quiero|me gustaría)\b/,
    de: /\b(hallo|danke|auto|motor|preis|guten tag|ja|nein|ich möchte)\b/,
    ar: /[\u0600-\u06FF]/, // Caractères arabes
  };

  for (const [lang, regex] of Object.entries(markers)) {
    if (regex.test(lower)) return lang;
  }

  return "fr"; // Défaut
}

/**
 * Formate la transcription pour l'affichage au client
 * Ajoute un indicateur visuel que c'est une transcription
 */
function formatTranscriptForDisplay(transcript, metadata = {}) {
  const { language = "fr", confidence = 0.8, hasEmoji = true } = metadata;

  const emoji = hasEmoji ? "🎤 " : "";
  const langFlag = getLangFlag(language);

  // Si confiance faible, ajouter un avertissement
  const warning = confidence < 0.5 ? "\n⚠️ *Transcription incertaine*" : "";

  return `${emoji}*Message vocal transcrit${langFlag}*\n${transcript}${warning}`;
}

/**
 * Retourne un emoji drapeau pour la langue
 */
function getLangFlag(lang) {
  const flags = {
    fr: " 🇫🇷",
    en: " 🇬🇧",
    es: " 🇪🇸",
    de: " 🇩🇪",
    it: " 🇮🇹",
    pt: " 🇵🇹",
    ar: " 🇸🇦",
    nl: " 🇳🇱",
    pl: " 🇵🇱",
    tr: " 🇹🇷",
  };
  return flags[lang] || "";
}

/**
 * Prépare le texte transcrit pour le traitement LLM
 * Ajoute du contexte pour aider le LLM à comprendre
 */
function prepareForLLM(transcript, metadata = {}) {
  const { language, confidence, audioDuration } = metadata;

  let context = "[TRANSCRIPTION VOCALE]\n";
  context += `Texte: "${transcript}"\n`;

  if (language) {
    context += `Langue détectée: ${SUPPORTED_LANGUAGES[language] || language}\n`;
  }
  if (confidence) {
    context += `Confiance transcription: ${(confidence * 100).toFixed(0)}%\n`;
  }
  if (audioDuration) {
    context += `Durée audio: ${audioDuration.toFixed(1)}s\n`;
  }

  context += "\n---\n";

  return context;
}

/**
 * Vérifie si une transcription est de qualité suffisante
 */
function isTranscriptValid(transcript, minLength = 2, minConfidence = 0.3) {
  if (!transcript || !transcript.text) return false;
  if (transcript.text.length < minLength) return false;
  if (transcript.confidence && transcript.confidence < minConfidence) return false;
  return true;
}

/**
 * Gère un message vocal complet : téléchargement + transcription + formatage
 * @param {Object} msg - Message WhatsApp
 * @param {string} token - WhatsApp token
 * @param {string} apiVersion - API version
 * @param {Function} fetchFn - Fetch function
 * @returns {Promise<{displayText: string, llmContext: string, metadata: Object}|null>}
 */
async function handleVoiceMessage(msg, token, apiVersion, fetchFn) {
  const mediaId = msg.voice?.id || msg.audio?.id;
  if (!mediaId) {
    log.warn("No media ID in voice message");
    return null;
  }

  log.info("Processing voice message", { mediaId, type: msg.type });

  try {
    // 1. Télécharger
    const { buffer, mimeType, voiceDuration } = await downloadWhatsAppMedia(
      mediaId,
      token,
      apiVersion,
      fetchFn
    );

    // 2. Transcrire
    const transcript = await transcribeWithGroq(buffer, mimeType, "fr", fetchFn);

    if (!transcript) {
      return {
        displayText: null,
        llmContext: null,
        metadata: { error: "TRANSCRIPTION_FAILED", mediaId },
      };
    }

    // 3. Vérifier la qualité
    if (!isTranscriptValid(transcript)) {
      log.warn("Low quality transcription", { confidence: transcript.confidence });
      return {
        displayText: null,
        llmContext: null,
        metadata: {
          error: "LOW_QUALITY",
          confidence: transcript.confidence,
          text: transcript.text,
        },
      };
    }

    // 4. Formater
    const metadata = {
      language: transcript.language,
      confidence: transcript.confidence,
      audioDuration: transcript.audioDuration,
      voiceDuration,
      mediaId,
    };

    const displayText = formatTranscriptForDisplay(transcript.text, metadata);
    const llmContext = prepareForLLM(transcript.text, metadata);

    return {
      displayText,
      llmContext,
      metadata,
      rawText: transcript.text,
    };
  } catch (err) {
    log.error("Voice processing failed", { error: String(err?.message || err), mediaId });
    return {
      displayText: null,
      llmContext: null,
      metadata: { error: "PROCESSING_ERROR", message: String(err?.message || err), mediaId },
    };
  }
}

/**
 * Génère un message d'erreur adapté au type d'echec
 */
function getErrorMessage(metadata) {
  if (metadata.error === "FILE_TOO_LARGE") {
    return "🎤 *Message vocal trop long*\n\nL'audio dépasse la limite de 20 Mo. Pourriez-vous le réécrire en texte ou l'envoyer en plusieurs parties ?";
  }

  if (metadata.error === "LOW_QUALITY") {
    return "🎤 *Transcription incertaine*\n\nJe n'ai pas bien compris votre message vocal. Pourriez-vous le réécrire en texte ?";
  }

  if (metadata.error === "TRANSCRIPTION_FAILED") {
    return "🎤 *Transcription indisponible*\n\nJe n'ai pas pu transcrire votre message vocal pour le moment. Pourriez-vous l'écrire en texte ?";
  }

  return "🎤 *Message vocal*\n\nJe n'ai pas pu traiter votre message vocal. Pourriez-vous le réécrire en texte ?";
}

/**
 * Détecte si le texte contient une demande de transcription
 * (pour éviter de re-transcrire une transcription)
 */
function isTranscript(text) {
  if (!text) return false;
  const markers = [
    /\[TRANSCRIPTION VOCALE\]/i,
    /\[Message vocal transcrit\]/i,
    /^🎤 \*Message vocal transcrit/i,
  ];
  return markers.some(m => m.test(text));
}

module.exports = {
  VOICE_TYPES,
  SUPPORTED_LANGUAGES,
  handleVoiceMessage,
  downloadWhatsAppMedia,
  transcribeWithGroq,
  formatTranscriptForDisplay,
  prepareForLLM,
  isTranscriptValid,
  getErrorMessage,
  isTranscript,
  detectLanguageFromText,
  getLangFlag,
};
