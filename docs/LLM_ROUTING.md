# Intent Routing Automatique LLM → Flow

## Vue d'ensemble

Cette fonctionnalité permet au LLM (Claude) de router automatiquement vers n'importe quel état d'un flow de conversation avec des données pré-extraites, éliminant ainsi les étapes intermédiaires inutiles.

## 🎯 Objectif

Accélérer le parcours client en permettant au LLM de :
1. **Extraire** automatiquement les informations du message (plaque, véhicule, prix, etc.)
2. **Router** directement vers l'état approprié du flow
3. **Sauter** les étapes déjà résolues implicitement

## 📁 Fichiers modifiés/créés

- `lib/intent-router.js` — Module de routing (NOUVEAU)
- `server.js` — Intégration dans le webhook et prompt LLM
- `tests/intent-router.test.js` — Tests unitaires (NOUVEAU)
- `tests/llm-routing-integration.test.js` — Tests d'intégration (NOUVEAU)

## 🔧 Format de routing

### Format legacy (backward compatible)
```json
{
  "type": "intent",
  "intent": "REPROG"
}
```
→ Route vers `WAITING_PLATE` avec l'intent spécifié

### Format avancé (nouveau)
```json
{
  "type": "route",
  "target": "WAITING_QUOTE_CONFIRM",
  "intent": "REPROG",
  "data": {
    "plate": "AB123CD",
    "vehicle": { "make": "VW", "model": "Golf 7 GTI", "year": 2018 },
    "priceCents": 39000,
    "addons": ["FAP"],
    "skipConfirmation": true
  },
  "confidence": 0.95
}
```

## 🗺️ États disponibles pour routing

| État | Description | Données utiles |
|------|-------------|----------------|
| `WAITING_PLATE` | Demande la plaque | `plate` |
| `WAITING_VEHICLE_CONFIRM` | Attend confirmation véhicule | `vehicle`, `vehicleYear` |
| `WAITING_QUOTE_CONFIRM` | Attend confirmation devis | `priceCents`, `addons` |
| `QUOTE_CONFIRMED` | Devis confirmé → auto-transition RDV | `skipConfirmation` |
| `WAITING_APPOINTMENT` | Demande date/heure RDV | `preferredDate`, `preferredTime` |
| `APPOINTMENT_CONFIRMED` | RDV confirmé | - |
| `WAITING_UPSELL` | Propose add-ons | `addons` |
| `VEHICLE_INCOMPATIBLE` | Véhicule incompatible | `reason` |
| `SAV_*` | États SAV | `ticketType`, `ticketDescription` |

## 💡 Exemples de scénarios

### Scénario 1: Client complet
**Message:** *"Je veux une reprog pour ma Golf 7 GTI 2018 AB123CD"*

**Routing LLM:**
```json
{
  "type": "route",
  "target": "WAITING_VEHICLE_CONFIRM",
  "intent": "REPROG",
  "data": {
    "plate": "AB123CD",
    "vehicle": { "make": "VW", "model": "Golf 7 GTI", "year": 2018 }
  },
  "confidence": 0.95
}
```

**Résultat:** Le client saute l'étape "demande de plaque" et arrive directement à la confirmation du véhicule.

### Scénario 2: Confirmation implicite
**Message:** *"Oui super, c'est quand pour la reprog ?"*

**Routing LLM:**
```json
{
  "type": "route",
  "target": "QUOTE_CONFIRMED",
  "intent": "REPROG",
  "data": {
    "skipConfirmation": true,
    "preferredDate": "2024-06-15"
  },
  "confidence": 0.9
}
```

**Résultat:** Auto-transition vers la prise de rendez-vous car le client a implicitement confirmé.

### Scénario 3: Incompatibilité détectée
**Message:** *"Je veux passer au E85 avec mon diesel"*

**Routing LLM:**
```json
{
  "type": "route",
  "target": "VEHICLE_INCOMPATIBLE",
  "intent": "E85",
  "data": {
    "reason": "E85 incompatible avec moteur diesel"
  },
  "confidence": 0.98
}
```

**Résultat:** Redirection vers l'état d'incompatibilité avec proposition d'alternatives.

## ⚙️ Implémentation technique

### 1. Parsing de l'instruction LLM
```javascript
const routeInstruction = parseRoutingInstruction(llmResult);
if (routeInstruction && routeInstruction.type === "route") {
  // Traitement du routing avancé
}
```

### 2. Création de l'état initial
```javascript
const initialState = createInitialStateFromRoute(routeInstruction);
await setConversationState(fromWa, initialState);
```

### 3. Dispatch vers le flow handler
```javascript
const prestaHandled = await handlePrestationFlow(fromWa, text, msg);
if (prestaHandled) continue;
const savHandled = await handleSavFlow(fromWa, text, msg);
if (savHandled) continue;
```

## ✅ Tests

Les tests sont disponibles dans :
- `tests/intent-router.test.js` — Tests unitaires du parser et fonctions
- `tests/llm-routing-integration.test.js` — Tests d'intégration des scénarios

Pour exécuter :
```bash
node tests/intent-router.test.js
node tests/llm-routing-integration.test.js
```

## 🔒 Sécurité

- **Sanitization** des données de routing (`sanitizeRouteData`)
- **Validation** des intents et états contre des listes autorisées
- **Score de confiance** minimum (0.7 par défaut) via `isRoutingSafe()`
- **Backward compatible** avec le format legacy `type=intent`

## 📊 Logs

Le routing est loggué avec les informations :
```
LLM → routing avancé { wa_id, intent, target, confidence }
LLM → intent détecté, re-routing { wa_id, intent }
```
