# 🎬 Setup Creatomate — Vidéo personnalisée Stage Reprog

## 1. Créer le compte

1. Va sur [creatomate.com](https://creatomate.com) → **Sign up** (email, pas de CB)
2. Tu arrives sur le **Dashboard**
3. Plan gratuit = **50 crédits/mois** (1 vidéo HD ≈ 1 crédit)

## 2. Récupérer la clé API

1. Dashboard → **API Keys** (menu gauche)
2. Clique **Create API Key**
3. Copie la clé (format : `abcdef1234567890...`)

## 3. Créer le template vidéo

### Option rapide : partir d'un template existant
1. Dashboard → **Templates** → **Browse Templates**
2. Cherche "car", "automotive", ou "product reveal"
3. Clique sur un template qui te plaît → **Duplicate**

### Option custom (recommandée pour effet wow)
1. Dashboard → **Templates** → **Create new template**
2. Format : **1080x1080 px (Square)** ou **1080x1920 (Vertical)** — mieux pour partage Instagram
3. Durée : **12-15 secondes**

### Structure conseillée de la vidéo

**Scène 1 — Intro (0-2s)**
- Logo DiagPerf qui apparaît en fade-in
- Texte : "DIAGPERF présente" (petit)
- Fond dégradé bleu marine → rouge (charte DiagPerf)

**Scène 2 — Véhicule (2-4s)**
- Texte BIG : `{{vehicle_name}}` (ex: "CITROEN C3")
- Sous-titre : `{{vehicle_engine}}` (ex: "1.4 HDi 68ch")
- Optionnel : image de voiture générique ou silhouette

**Scène 3 — Stage dramatique (4-5s)**
- Texte géant animé : `{{stage_label}}` (ex: "STAGE 1")
- Effet shake/flash/glitch pour l'impact

**Scène 4 — Gains puissance (5-8s)**
- 2 colonnes :
  - AVANT : `{{hp_before}} ch` (gris)
  - APRÈS : `{{hp_after}} ch` (rouge/vert, gros)
- Gain animé : `{{hp_gain}}` qui apparaît en explosion

**Scène 5 — Gains couple (8-10s)**
- Même structure pour le couple :
  - `{{torque_before}} Nm` → `{{torque_after}} Nm`
  - Gain : `{{torque_gain}}`

**Scène 6 — Bonus 0-100 (10-11s)** (optionnel)
- "Gain 0-100 km/h : `{{zero_to_hundred}}`" (si disponible)

**Scène 7 — CTA final (11-15s)**
- Prix : `{{price_ttc}}`
- Texte : "Réservez maintenant"
- Logo DiagPerf + infos contact

### ⚠️ IMPORTANT : nommer les placeholders EXACTEMENT

Dans l'éditeur Creatomate, chaque élément texte doit avoir son **Element Name** défini (dans le panneau de droite, champ "Name"). Les noms DOIVENT correspondre **exactement** à ces placeholders (case-sensitive). Le code les référencera via `name.text`, mais toi tu n'as qu'à donner le nom de base :

| Element Name | Exemple de valeur |
|---|---|
| `vehicle_name` | `CITROEN C3` |
| `vehicle_engine` | `1.4 HDi 68ch` |
| `stage_label` | `STAGE 1` |
| `hp_before` | `68` |
| `hp_after` | `100` |
| `hp_gain` | `+32` |
| `torque_before` | `160` |
| `torque_after` | `230` |
| `torque_gain` | `+70` |
| `zero_to_hundred` | `-2.4s` |
| `price_ttc` | `390€ TTC` |

**Comment renommer un élément** : clique sur un texte dans le canvas → panneau droit → champ "Name" (pas "Text" !).

## 4. Récupérer le Template ID

1. Une fois ton template créé, clique **Save**
2. Regarde l'URL du navigateur : elle contient l'ID du template
   - Format : `https://creatomate.com/projects/.../templates/abcd-1234-ef56-7890`
   - Copie la partie `abcd-1234-ef56-7890`

Alternative :
1. Dashboard → **Templates** → sélectionne ton template
2. Bouton "..." → **Copy Template ID**

## 5. Configurer Railway

Dans Railway → ton projet → **Variables** → ajoute :

```
CREATOMATE_API_KEY=abcdef1234567890...
CREATOMATE_TEMPLATE_ID=abcd-1234-ef56-7890
```

Railway redéploie automatiquement après ajout des variables.

## 6. Tester

1. Sur WhatsApp, envoie une plaque → choisis un stage
2. Tu dois voir :
   - 📋 Fiche technique (image)
   - 🎬 "Préparation de votre animation personnalisée..."
   - 🏎️ La vidéo personnalisée (5-30s plus tard)
   - ✅ Devis généré

## 7. Debug

Si la vidéo n'arrive pas, regarde les logs Railway :
- `[creatomate] Submitting render` → appel API OK
- `[creatomate] Render ready immediately` → vidéo envoyée
- `[creatomate] API error` → vérifie API_KEY
- `[creatomate] not configured` → vérifie les env vars

## 8. Monitoring crédits

Dashboard Creatomate → **Usage** → voir le nombre de renders consommés dans le mois.

Si tu dépasses 50/mois, upgrade → **$29/mois pour 500 renders** (vs 0.04€/render à l'unité).
