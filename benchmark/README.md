# Mini-benchmark V1 vs V2 (RAG) — DiagPerf

Évaluation hors-ligne contrôlée pour le mémoire ING2. Compare l'assistant **avant** RAG (V1)
et **après** (V2), sur exactitude, hallucinations, latence et coût.

## Les 4 conditions

| Condition | Prompt | RAG | Rôle |
|---|---|---|---|
| **A-V1** | historique `git 9ebe5a8` (7 mai 2026, savoir baké) | ❌ | Récit : « Claude à nu » |
| **A-V2** | actuel complet (`lib/llm-service.js`) | ✅ | Récit : système réellement livré |
| **B-noRAG** | dépouillé de tout fait métier | ❌ | Contrôle d'ablation |
| **B-RAG** | dépouillé | ✅ | Traitement d'ablation |

- **(A-V1 vs A-V2)** = comparaison historique réelle V1→V2.
- **(B-noRAG vs B-RAG)** = effet causal *pur* du RAG (toutes choses égales par ailleurs : seul le RAG change).

> Fidélité : la V1 réelle (7 mai) appelait déjà un RAG à embeddings locaux faibles, non rejouable.
> On approxime donc V1 par « prompt seul, sans RAG ». Différences V1→V2 documentées dans `prompts.js`.

## Fichiers

- `prompts.js` — les 3 variantes de prompt (V1 verbatim, V2 actuel, B dépouillé).
- `questions.json` — jeu de questions + vérité-terrain + métadonnées de notation. **Ajoute tes vrais cas (RC01, RC02…).**
- `run-benchmark.js` — exécute, mesure, note (juge LLM + contrôle déterministe), agrège.
- `results/` — sorties horodatées (`raw-*.json` détaillé, `summary-*.csv`).

## Prérequis (`.env`)

`ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
La KB doit être indexée dans Supabase (`node ingest.js`) — vérifié par le préflight au démarrage.

⚠️ Le modèle est lu depuis `LLM_MODEL`. Forcer un modèle valide si besoin :
`LLM_MODEL=claude-haiku-4-5 node benchmark/run-benchmark.js`

## Lancer

```bash
# Run complet (4 conditions, 28 questions, avec juge LLM)
LLM_MODEL=claude-haiku-4-5 node benchmark/run-benchmark.js

# Sous-ensemble de conditions
node benchmark/run-benchmark.js --only A-V1,A-V2

# Validation rapide (1 question, sans juge)
node benchmark/run-benchmark.js --limit 1 --no-judge

# Juge plus strict (modèle supérieur)
JUDGE_MODEL=claude-opus-4-8 node benchmark/run-benchmark.js
```

## Métriques

- **Répond (%)** : le bot répond (`type:answer`) au lieu de lancer un flow par erreur.
- **Déterministe OK (%)** : `required` tous présents ET `forbidden` aucun présent.
- **Exactitude juge** : score moyen 0 / 0,5 / 1 attribué par un juge LLM avec la vérité-terrain.
- **Hallucinations** : nb de réponses où le juge détecte un fait faux (prix/compat/code/info inventée).
- **Latence** : p50 et moyenne (ms) de l'appel Claude.
- **Coût / tokens** : usage Claude × tarif (Haiku 4.5 : 1 $ / 5 $ par MTok in/out ; cache 0,10 $ / 1,25 $).

## Notes de méthode (pour le mémoire)

- Benchmark **hors-ligne contrôlé** : le bot n'est pas encore déployé, pas de métriques terrain.
- Le juge LLM est faillible ; le contrôle déterministe sert de garde-fou croisé. Pour les pièges
  prix/compat, les deux convergent. Un juge plus fort (`claude-opus-4-8`) réduit le bruit.
- `temperature 0.2`, `max_tokens 900` (mêmes réglages que la prod).
