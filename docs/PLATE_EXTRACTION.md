# Extraction Intelligente de Plaques d'Immatriculation

## 🎯 Vue d'ensemble

Module d'extraction automatique des plaques d'immatriculation françaises (format SIV) à partir de texte libre, même quand elles sont intégrées dans des phrases complètes.

## 📁 Fichiers

- `lib/plate-extractor.js` — Module principal
- `tests/plate-extractor.test.js` — Tests unitaires
- Intégration dans `server.js` (handler WAITING_PLATE)

## 🔧 Fonctions principales

| Fonction | Description |
|----------|-------------|
| `extractAndValidatePlate(text)` | Extrait et valide la première plaque trouvée |
| `extractPlates(text)` | Extrait toutes les plaques potentielles |
| `extractFirstPlate(text)` | Extrait la première plaque (valid ou non) |
| `hasPlateMention(text)` | Détecte si le texte mentionne une plaque |
| `removePlateFromText(text, plate)` | Supprime la plaque du texte |
| `normalizePlate(raw)` | Normalise au format AA-123-AA |
| `isValidPlate(normalized)` | Vérifie le format SIV |

## 📝 Formats supportés

Le module détecte automatiquement les variations suivantes :

| Format | Exemple | Détecté |
|--------|---------|---------|
| Standard | `AB-123-CD` | ✅ Oui |
| Collé | `AB123CD` | ✅ Oui |
| Espaces | `AB 123 CD` | ✅ Oui |
| Mixte | `AB-123 CD` | ✅ Oui |
| Minuscules | `ab-123-cd` | ✅ Oui |
| Avec contexte | "ma plaque AB-123-CD" | ✅ Oui |

## 💡 Cas d'usage résolu

### Problème initial (capture d'écran)
```
Client: "je veux une reprog moteur, ma plaque c'est dj893kl et je veux une stage 1"
Bot: "Veuillez envoyer votre plaque d'immatriculation" ❌
```

### Solution avec extraction intelligente
```
Client: "je veux une reprog moteur, ma plaque c'est dj893kl et je veux une stage 1"
Bot: Détecte REPROG + DJ-893-KL → Skip étape plaque → Confirmation véhicule ✅
```

### Optimisation du flux
Avant :
```
Client: "reprog pour AB-123-CD"
Bot: "Veuillez envoyer votre plaque" ❌ (demande 2x)
```

Après optimisation (handleNoState) :
```
Client: "reprog pour AB-123-CD"
Bot: Détecte plaque dans message initial → Directement confirmation véhicule ✅
```

## 🔄 Intégration dans le flux

Le handler `WAITING_PLATE` utilise maintenant une approche en deux étapes :

1. **Validation standard** : plaque isolée (comportement existant)
2. **Extraction intelligente** : plaque dans du texte (nouveau)

```javascript
// Essayer d'abord la validation standard
let { valid, plate } = validatePlate(text);

// Si échec, essayer d'extraire la plaque d'une phrase complète
if (!valid && text) {
  const extracted = extractAndValidatePlate(text);
  if (extracted.plate) {
    plate = extracted.plate;
    valid = extracted.valid;
    log.info("WAITING_PLATE → plaque extraite du texte", { plate, valid });
  }
}
```

### Optimisation handleNoState (flow initial)

Quand un utilisateur envoie un message avec **intent + plaque** en une seule fois :

```
"je veux une reprog pour AB-123-CD"
```

Le bot détecte automatiquement la plaque et skip l'étape intermédiaire :

```javascript
// Dans handleNoState() - avant de demander la plaque
const plateExtraction = extractAndValidatePlate(text);
if (plateExtraction.plate && plateExtraction.valid) {
  const vehicle = await lookupVehicleFromPlate(plateExtraction.plate);
  await setConversationState(fromWa, "WAITING_VEHICLE_CONFIRM", detected, {
    plate: plateExtraction.plate,
    vehicle,
  });
  // Va directement à la confirmation du véhicule
  // PAS besoin de demander la plaque !
}
```

**Avant** : Intent détecté → WAITING_PLATE → Demande plaque → User envoie plaque → WAITING_VEHICLE_CONFIRM

**Après** : Intent + plaque détectés → SKIP WAITING_PLATE → WAITING_VEHICLE_CONFIRM directement

## 🧪 Tests

Exécuter les tests :
```bash
node tests/plate-extractor.test.js
```

Tests couverts :
- ✅ Normalisation (formats variés)
- ✅ Validation SIV
- ✅ Extraction simple
- ✅ Extraction multiple
- ✅ Extraction dans phrase (cas utilisateur)
- ✅ Détection mentions "ma plaque", "immat", etc.
- ✅ Suppression plaque du texte
- ✅ Cas limites (espaces multiples, minuscules, etc.)

## 📊 Logs

Les événements suivants sont loggués :

```
# Extraction réussie
[plate] Plate extracted { plate: 'DJ-893-KL', raw: 'dj893kl' }
[plate] Plate extraction { plate: 'DJ-893-KL', valid: true, hasMention: true }

# Dans WAITING_PLATE (fallback)
WAITING_PLATE → plaque extraite du texte { wa_id: '...', plate: 'DJ-893-KL', valid: true, context: 'ma plaque c\'est dj893kl et je veux' }

# Dans handleNoState (optimisation flow initial)
Prestation flow → plaque détectée dans message initial, skip à confirmation { wa_id: '...', intent: 'REPROG', plate: 'DJ-893-KL' }
```

## 🎉 Résultat

Le cas présenté dans la capture d'écran est maintenant **entièrement résolu** !

```
✅ "je veux une reprog moteur, ma plaque c'est dj893kl et je veux une stage 1"
   → Extraction: DJ-893-KL
   → Validation: OK (format SIV)
   → Flow: Continue vers confirmation véhicule
```
