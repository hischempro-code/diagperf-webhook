# Plan de Refactoring Architecture

## Objectif
Réduire `server.js` de 5700+ lignes à ~500 lignes en extrayant la logique métier dans des modules.

## Architecture Cible

```
Diagperf Webhook/
├── config/
│   └── index.js              ✅ Configuration centralisée (créé)
├── lib/
│   ├── logger.js             ✅ Logger structuré (créé)
│   ├── plate-utils.js        ✅ Fonctions plaques (créé)
│   ├── conversation-state.js ✅ Gestion état conversations (créé)
│   ├── whatsapp-api.js       ✅ API WhatsApp (créé)
│   ├── vehicle-api.js        # API Immatriculation (à créer)
│   ├── email-service.js      # Envoi emails (à créer)
│   ├── devis-service.js      # Gestion devis (à créer)
│   ├── intent-detector.js    # Détection intents
│   ├── sentiment-detector.js # Détection sentiment
│   ├── diagnostic-helper.js  # Détection DTC/km
│   ├── conversation-memory.js# Mémoire conversation
│   ├── intent-router.js      # Routing LLM
│   ├── voice-handler.js      # Gestion voix
│   └── plate-extractor.js    # Extraction plaques
├── flows/
│   ├── prestation/
│   │   ├── index.js          # Handler principal prestation
│   │   ├── registry.js       # Registre handlers d'état
│   │   └── states/
│   │       ├── no-state.js       # Détection intent initial
│   │       ├── waiting-plate.js
│   │       ├── waiting-vehicle-confirm.js
│   │       ├── waiting-quote-confirm.js
│   │       ├── waiting-upsell.js
│   │       ├── waiting-appointment.js
│   │       └── ...
│   └── sav/
│       ├── index.js          # Handler principal SAV
│       └── states/           # États SAV
├── routes/
│   ├── index.js            # Regroupement routes
│   ├── webhook.js          # POST /webhook (main handler)
│   ├── dashboard.js        # Routes dashboard API
│   ├── health.js           # Health check & webhook verification
│   └── client-api.js       # API client PWA
├── utils/
│   ├── text-helpers.js     # extractInboundText, etc.
│   ├── validation.js       # validateEmail, etc.
│   └── sse.js              # Server-Sent Events
├── constants/
│   ├── prompts.js          # LLM_SYSTEM_PROMPT
│   └── messages.js         # Messages utilisateur
└── server.js               # ~500 lignes (bootstrap)
```

## Modules Créés ✅

| Module | Description | Lignes extraites |
|--------|-------------|------------------|
| `config/index.js` | Configuration, constants, env vars | ~150 |
| `lib/logger.js` | Logger structuré | ~25 |
| `lib/plate-utils.js` | Normalisation/validation plaques | ~40 |
| `lib/conversation-state.js` | Cache + persistance état | ~150 |
| `lib/whatsapp-api.js` | Tous les appels API WhatsApp | ~200 |

## Modules à Créer 📋

### Phase 1: Core services (estimation: -1500 lignes)
- `lib/vehicle-api.js` - API immatriculation + normalisation
- `lib/email-service.js` - SendGrid emails
- `lib/devis-service.js` - Création/mise à jour devis
- `lib/intent-detector.js` - Détection intents depuis texte

### Phase 2: Routes (estimation: -1000 lignes)
- `routes/dashboard.js` - Toutes les routes /api/dashboard/*
- `routes/webhook.js` - Handler POST /webhook (simplifié)
- `routes/health.js` - GET /webhook, /health

### Phase 3: Flows (estimation: -2000 lignes)
- `flows/prestation/index.js` - Handler principal
- `flows/prestation/states/*.js` - Un fichier par état
- `flows/sav/index.js` - Handler SAV

### Phase 4: Utils (estimation: -500 lignes)
- `utils/text-helpers.js` - Extraction texte, IDs interactifs
- `utils/sse.js` - SSE broadcast
- `constants/prompts.js` - LLM prompts
- `constants/messages.js` - Messages utilisateur

## Réduction Estimée

| Étape | Lignes | Cumul server.js |
|-------|--------|-----------------|
| Actuel | 5700 | 5700 |
| Phase 1 | -1500 | 4200 |
| Phase 2 | -1000 | 3200 |
| Phase 3 | -2000 | 1200 |
| Phase 4 | -700 | 500 |

**Objectif: server.js ~500 lignes**

## Structure du nouveau server.js

```javascript
// 1. Imports (30 lignes)
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const sgMail = require("@sendgrid/mail");
const { config, REQUIRED_ENV } = require("./config");
const { log } = require("./lib/logger");
const routes = require("./routes");
const { startReviewScheduler } = require("./schedulers/review");

// 2. Validation env (10 lignes)
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) { ... }

// 3. Init services (20 lignes)
const supabase = createClient(...);
const app = express();

// 4. Middleware (10 lignes)
app.use(express.json({ verify: (req, res, buf) => req.rawBody = buf }));
app.use(express.static(...));

// 5. Routes (10 lignes)
app.use(routes);

// 6. Démarrage (20 lignes)
const port = config.PORT;
const server = app.listen(port, () => {
  log.info(`Server started on port ${port}`);
  startReviewScheduler();
});

// 7. Graceful shutdown (15 lignes)
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
```

## Avantages

1. **Maintenabilité** - Chaque module a une responsabilité unique
2. **Testabilité** - Modules testables indépendamment
3. **Scalabilité** - Facile d'ajouter de nouveaux flows/états
4. **Lisibilité** - server.js devient un bootstrap simple
5. **Hot-reload** - Possibilité de recharger certains modules sans restart

## Migration Sécurisée

Approche par étapes:
1. Créer les nouveaux modules
2. Dupliquer la logique (ne pas supprimer l'original tout de suite)
3. Tester les nouveaux modules
4. Basculer server.js vers les nouveaux modules
5. Supprimer le code dupliqué quand stable
