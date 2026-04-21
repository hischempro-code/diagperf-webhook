# 🏆 Template Premium DiagPerf — Guide d'import

## ⏱️ 15 minutes pour un rendu pro

### 1. Importer le JSON dans Creatomate (3 min)

1. Va sur [creatomate.com/dashboard](https://creatomate.com/dashboard)
2. **Templates** → **New Template**
3. Choisis **"Start from scratch"** → format **1080x1920 (Vertical)** → **15 seconds**
4. Une fois dans l'éditeur, en haut à droite cherche l'icône **`< >`** (Source / JSON view)
   - Ou menu **"..."** → **"Edit source"** / **"View source"**
5. Une fenêtre avec du JSON s'ouvre → **supprime tout le contenu**
6. Ouvre le fichier `creatomate-template-premium.json` de ce repo
7. **Copie tout son contenu** et colle-le dans Creatomate
8. Clique **Apply** / **Save**

👉 Tu devrais voir apparaître tous les éléments dans la timeline avec les animations prédéfinies.

---

### 2. Ajouter la vidéo de fond (2 min)

Le JSON n'inclut PAS de vidéo de fond (fond noir pur). Pour ajouter une touche cinématique :

1. Dans l'éditeur, panneau gauche → clic sur **+** → **Video**
2. Upload une vidéo auto premium (voir suggestions Pexels ci-dessous)
3. **IMPORTANT** : une fois ajoutée, dans les propriétés :
   - **Track** : mets `2` (au-dessus du background, sous le gradient doré)
   - **Opacity** : `30-40%` (pour rester subtil et laisser les textes lisibles)
   - **Blend mode** : `overlay` ou `soft light` si disponible
   - **Size** : `100% x 100%`

**Vidéos Pexels recommandées** (télécharge la version 1080p) :
- [Voiture luxe en mouvement](https://www.pexels.com/search/videos/luxury%20car/)
- [Route de nuit](https://www.pexels.com/search/videos/night%20road/)
- [Moteur qui tourne](https://www.pexels.com/search/videos/engine/)
- [Compteur de vitesse](https://www.pexels.com/search/videos/speedometer/)

---

### 3. Ajouter la musique (2 min)

1. Panneau gauche → **+** → **Audio**
2. Creatomate a une banque de sons intégrée → clic sur l'icône music/library
3. Cherche : `cinematic`, `luxury`, `corporate elegant`, `minimal piano`
4. Trim à 15s si nécessaire
5. **Volume** : 50-60% (pour pas couvrir)

**Suggestions de styles** : "Cinematic Orchestral", "Minimal Piano Reveal", "Luxury Ambient"

---

### 4. Ajouter ton logo DiagPerf (optionnel, 2 min)

Si tu as un logo PNG transparent :

1. Panneau gauche → **+** → **Image** → upload ton logo
2. Positionne-le :
   - **Scène 1** : x=50%, y=60%, width=15%, time=0, duration=2.5s
   - **Scène finale** : x=50%, y=75%, width=12%, time=13.5, duration=1.5s
3. Anime avec un simple **fade** de 0.5s

---

### 5. Vérifications finales (2 min)

Dans la liste d'éléments à gauche, assure-toi que ces **noms existent exactement** (c'est critique pour que l'API les remplace) :

✅ `vehicle_name`
✅ `vehicle_engine`
✅ `stage_label`
✅ `hp_before`
✅ `hp_after`
✅ `hp_gain`
✅ `torque_before`
✅ `torque_after`
✅ `torque_gain`
✅ `price_ttc`
✅ `zero_to_hundred`

Si tu les as renommés par erreur, re-renomme-les via le panneau Properties (champ "Name").

---

### 6. Prévisualiser (1 min)

- Bouton **Play** ▶️ dans l'éditeur ou raccourci `Space`
- Tu dois voir les 6 scènes s'enchaîner élégamment sur 15s
- Tweak les valeurs si nécessaire (tu peux ajuster couleurs, tailles, timings directement dans l'éditeur)

---

### 7. Récupérer le nouveau TEMPLATE_ID (1 min)

Une fois satisfait du rendu :

1. **Save** le template
2. Regarde l'URL : `creatomate.com/projects/.../templates/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`
3. Copie l'UUID après `/templates/`

### 8. Mettre à jour Railway (1 min)

Remplace l'ancienne valeur de `CREATOMATE_TEMPLATE_ID` par le nouveau UUID.

Railway redéploie automatiquement → test sur WhatsApp → **admire le résultat** 🏆

---

## 🎨 Ajustements possibles après import

| Élément | Quoi changer | Où |
|---|---|---|
| Couleur or | `#C9A961` → une autre teinte | Rechercher dans JSON et remplacer tout |
| Fond | Noir → dégradé | Ajouter un shape gradient en track 1 |
| Police | Montserrat → autre | Changer `font_family` dans l'éditeur |
| Durée totale | 15s → plus/moins | Modifier `duration` général + timings scènes |
| Transitions | Fade → wipe/glitch | Editeur → onglet Animation de chaque élément |

---

## 🐛 Problèmes courants

**"Les animations ne se lancent pas"** → Vérifie que chaque élément a bien un `time` et `duration` définis et ne se chevauche pas avec la durée totale (15s).

**"L'import JSON ne marche pas"** → Vérifie que tu es bien en mode "Edit Source" et pas juste "View". Parfois il faut double-cliquer ou utiliser le bouton "Import from JSON".

**"Les textes sont coupés"** → Ajuste `font_size` (diminue) ou `width` de l'élément texte.

**"Mon véhicule a un nom trop long (ex: MERCEDES-BENZ CLASSE A)"** → Le code passe le `vehicle_name` tel quel. Tu peux soit réduire le font_size par défaut, soit limiter le nom côté backend.
