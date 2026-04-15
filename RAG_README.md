# RAG DiagPerf — Guide de déploiement et maintenance

## Architecture

```
Client WhatsApp
    ↓
server.js (flows existants : prestations, SAV, upsell, DIAG)
    ↓ (aucun flow ne matche)
askLLM() → rag.js : retrieveContext()
              ↓
    Embedding local (all-MiniLM-L6-v2)
              ↓
    Supabase pgvector (table kb_chunks)
              ↓
    Top 5 chunks pertinents
              ↓
    Claude Haiku (réponse contextuelle)
              ↓
    Réponse WhatsApp
```

## Fichiers créés

| Fichier | Rôle |
|---|---|
| `rag.js` | Module de retrieval : embeddings locaux + recherche pgvector |
| `ingest.js` | Pipeline d'ingestion : lit les MD, chunke, génère embeddings, stocke dans Supabase |
| `knowledge_base/` | 16 fichiers Markdown (base de connaissances) |
| `migrations/001_kb_chunks.sql` | Migration SQL pour créer la table `kb_chunks` + fonction `match_kb_chunks` |
| `RAG_README.md` | Ce fichier |

## Déploiement — Étapes

### 1. Exécuter la migration SQL

Dans le **Supabase SQL Editor** (Dashboard → SQL Editor → New query), collez et exécutez le contenu de `migrations/001_kb_chunks.sql`.

Cela crée :
- L'extension `vector` (pgvector)
- La table `kb_chunks` (contenu + embeddings)
- Les index (vectoriel, file_path, category, intent)
- La fonction `match_kb_chunks()` pour la recherche par similarité

### 2. Installer les dépendances

```bash
npm install @xenova/transformers
```

### 3. Lancer l'ingestion

```bash
node ingest.js
```

Le premier lancement télécharge le modèle d'embeddings (~80 MB). Les lancements suivants sont quasi instantanés.

Sortie attendue :
```
🔍 Recherche des fichiers Markdown...
📄 16 fichiers trouvés

🧠 Chargement du modèle d'embeddings (all-MiniLM-L6-v2)...

📝 services/reprogrammation.md
   ✅ Chunk 1/3 (120 tokens)
   ✅ Chunk 2/3 (95 tokens)
   ...
✅ Ingestion terminée : ~40 chunks, ~3500 tokens total
🎉 La base de connaissances est prête !
```

### 4. Variables d'environnement

Assurez-vous que `.env` contient :
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Variable optionnelle :
```
LLM_MODEL=claude-haiku-4-20250414   # modèle Claude (défaut: claude-haiku-4-20250414)
```

### 5. Démarrer le serveur

```bash
node server.js
```

Au démarrage, le modèle d'embeddings est pré-chargé en arrière-plan (~2-5s).

---

## Maintenance — Comment modifier la base de connaissances

### Ajouter un nouveau sujet

1. Créez un fichier `.md` dans le bon sous-dossier de `knowledge_base/` :
   - `services/` — prestations (reprog, E85, FAP, etc.)
   - `faq/` — questions fréquentes
   - `infos/` — infos pratiques (horaires, contact, etc.)
   - `tarifs/` — grille tarifaire

2. Ajoutez le frontmatter YAML en haut du fichier :
```markdown
---
category: services
tags: [mot-clé1, mot-clé2, mot-clé3]
intent: REPROG
---

# Titre du sujet

Contenu...
```

3. Relancez l'ingestion :
```bash
node ingest.js
```

L'ingestion est **idempotente** : elle supprime les anciens chunks d'un fichier avant d'insérer les nouveaux. Vous pouvez la relancer autant de fois que nécessaire.

### Modifier un fichier existant

1. Éditez le fichier `.md` dans `knowledge_base/`
2. Relancez `node ingest.js`

### Supprimer un sujet

1. Supprimez le fichier `.md`
2. Relancez `node ingest.js` (les anciens chunks seront supprimés automatiquement)

### Compléter les placeholders

Certains fichiers contiennent des `[À COMPLÉTER]`. Recherchez-les et remplissez avec vos vraies informations :
- `infos/localisation-horaires.md` — adresse exacte, horaires réels
- `infos/contact.md` — téléphone, site web

---

## Fonctionnement technique

### Flux d'un message client

1. Le message arrive dans le webhook
2. Les **flows existants** sont testés en premier (prestations, SAV) — **inchangés**
3. Si aucun flow ne matche → `askLLM()` est appelé
4. `askLLM()` appelle `retrieveContext()` qui :
   - Génère l'embedding du message client (local, ~50ms)
   - Cherche les 5 chunks les plus similaires dans `kb_chunks` via pgvector
   - Retourne les chunks avec leur score de similarité
5. Les chunks pertinents sont injectés dans le prompt Claude Haiku
6. Claude analyse et retourne :
   - `intent` → re-route vers le bon flow existant
   - `answer` → réponse FAQ envoyée au client
   - `menu` → menu principal

### Budget tokens par appel Claude

| Composant | Tokens estimés |
|---|---|
| System prompt (fixe) | ~350 |
| Contexte RAG (top 3-5 chunks) | ~400-800 |
| Message client | ~20-50 |
| **Total input** | **~800-1200** |
| Réponse Claude | ~100-200 |

Coût estimé : **~$0.0003 par appel** (Claude Haiku).

### Latence

| Étape | Temps |
|---|---|
| Embedding local | ~50-100ms |
| Recherche pgvector | ~20-50ms |
| Appel Claude Haiku | ~1-3s |
| **Total** | **~1.5-3.5s** |

---

## Dépannage

### Le RAG ne retourne aucun résultat

- Vérifiez que l'ingestion a été exécutée : `SELECT COUNT(*) FROM kb_chunks;` dans Supabase SQL Editor
- Vérifiez les logs du serveur pour `RAG retrieval` — si `chunksFound: 0`, le seuil de similarité est peut-être trop élevé

### Le modèle d'embeddings ne se charge pas

- Vérifiez que `@xenova/transformers` est installé : `npm ls @xenova/transformers`
- Le premier chargement nécessite une connexion internet pour télécharger le modèle (~80MB)
- Le modèle est mis en cache dans `~/.cache/huggingface/` après le premier téléchargement

### L'API Claude ne répond pas

- Vérifiez `ANTHROPIC_API_KEY` dans `.env`
- Le bot continue de fonctionner sans le LLM (fallback vers le menu principal)
