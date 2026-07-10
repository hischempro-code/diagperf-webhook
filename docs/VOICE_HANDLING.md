# Gestion des Messages Vocaux - Documentation

## 🎯 Vue d'ensemble

Le chatbot DiagPerf supporte les messages vocaux WhatsApp avec transcription automatique via **Groq Whisper** (modèle `whisper-large-v3-turbo` sur le tier gratuit).

## 📁 Architecture

```
Message vocal WhatsApp
    ↓
[Webhook server.js] → Détection type voice/audio
    ↓
[voice-handler.js] → Traitement complet
    ├── Téléchargement du média (WhatsApp API)
    ├── Transcription Groq Whisper
    ├── Analyse qualité (confiance, langue)
    └── Formatage contexte LLM
    ↓
[LLM Claude] → Traitement avec contexte vocal
    ↓
Réponse texte au client
```

## 🔧 Module `lib/voice-handler.js`

### Fonctions principales

| Fonction | Description |
|----------|-------------|
| `handleVoiceMessage(msg, token, apiVersion, fetchFn)` | Pipeline complet de traitement vocal |
| `downloadWhatsAppMedia(mediaId, token, apiVersion, fetchFn)` | Télécharge le fichier audio depuis WhatsApp |
| `transcribeWithGroq(buffer, mimeType, language, fetchFn)` | Transcription via API Groq |
| `formatTranscriptForDisplay(text, metadata)` | Formate pour affichage client (optionnel) |
| `prepareForLLM(text, metadata)` | Prépare le contexte pour le LLM |
| `isTranscriptValid(transcript)` | Vérifie la qualité minimale |
| `getErrorMessage(metadata)` | Message d'erreur adapté |

### Configuration

Variables d'environnement :
```bash
GROQ_API_KEY=gsk_...              # Clé API Groq (obligatoire)
GROQ_WHISPER_MODEL=whisper-large-v3-turbo  # Modèle (défaut)
```

Limites :
- Taille max : 20 Mo
- Durée : pas de limite stricte
- Langues : 10+ langues supportées

## 🌍 Langues supportées

| Code | Langue | Détection |
|------|--------|-----------|
| fr | Français | ✅ Auto + mots-clés |
| en | Anglais | ✅ Auto + mots-clés |
| es | Espagnol | ✅ Auto + mots-clés |
| de | Allemand | ✅ Auto + mots-clés |
| it | Italien | ✅ API Groq |
| pt | Portugais | ✅ API Groq |
| ar | Arabe | ✅ Caractères |
| nl, pl, tr | Autres | ✅ API Groq |

## 📝 Format de contexte LLM

Le LLM reçoit les métadonnées vocales :

```
[TRANSCRIPTION VOCALE]
Texte: "Je veux une reprog pour ma Golf"
Langue détectée: Français
Confiance transcription: 92%
Durée audio: 3.5s

---
```

Cela permet au LLM de :
- Savoir que c'est une transcription
- Adapter sa confiance selon la qualité
- Tolérer les erreurs de reconnaissance

## 🔄 Flux de traitement

### 1. Réception du webhook
```javascript
if (VOICE_TYPES.has(msg.type) && GROQ_API_KEY) {
  const voiceResult = await handleVoiceMessage(msg, token, apiVersion, fetchFn);
  // ...
}
```

### 2. Traitement et transcription
Le `voice-handler.js` gère :
- Téléchargement du média (2 appels API WhatsApp)
- Conversion en buffer
- Transcription Groq avec retry implicite
- Validation qualité (confiance > 30%, texte > 2 caractères)

### 3. Gestion des erreurs

| Erreur | Cause | Message client |
|--------|-------|----------------|
| `FILE_TOO_LARGE` | > 20 Mo | "Audio trop long..." |
| `LOW_QUALITY` | Confiance < 30% | "Transcription incertaine..." |
| `TRANSCRIPTION_FAILED` | API Groq indispo | "Transcription indisponible..." |
| `PROCESSING_ERROR` | Exception | "Je n'ai pas pu traiter..." |

### 4. Intégration LLM
```javascript
text = voiceResult.llmContext + voiceResult.rawText;
// Le texte inclut maintenant les métadonnées pour le LLM
```

## 📊 Métriques et logs

Les événements suivants sont loggués :

```
[voice] Downloading media { mediaId }
[voice] Media downloaded { mediaId, sizeMB, mimeType }
[voice] Transcription successful {
  chars: 45,
  language: "fr",
  confidence: "0.94",
  audioDuration: "3.5s",
  processingTime: "1200ms"
}
```

## 🧪 Tests

Exécuter les tests :
```bash
node tests/voice-handler.test.js
```

Tests couverts :
- Types de messages vocaux
- Langues supportées
- Formatage d'affichage
- Préparation contexte LLM
- Validation qualité
- Messages d'erreur
- Détection langue via texte
- Drapeaux langue

## 💡 Bonnes pratiques

### Pour les clients
- Messages vocaux clairs et concis (< 1 min)
- Éviter le bruit de fond
- Mentionner clairement la prestation souhaitée
- Répéter la plaque d'immatriculation si nécessaire

### Pour le développeur
- Toujours vérifier `GROQ_API_KEY` avant d'activer
- Monitorer les taux d'erreur de transcription
- Ajuster `minConfidence` selon les retours utilisateurs
- Ne pas activer l'affichage de la transcription en production (peut être désactivé)

## 🚀 Améliorations futures

- [ ] TTS (Text-to-Speech) pour réponses vocales
- [ ] Confirmation automatique de la transcription
- [ ] Chunking pour fichiers > 20 Mo
- [ ] Détection de langue automatique (sans hint)
- [ ] Fallback vers autres services (OpenAI, AWS)
