# Harnais d'évaluation anti-hallucination — DiagPerf

Filet de non-régression contre les hallucinations du bot. Deux niveaux complémentaires :

| Niveau | Fichier | Réseau ? | Quand |
|---|---|---|---|
| **1. Détecteurs** | `detectors.js` + `detectors.test.js` | ❌ hors-ligne | à chaque `npm test` |
| **2. Éval live** | `run-eval.js` + `cases.json` | ✅ Anthropic + Supabase | avant un déploiement / à la demande |

## Le principe

Les hallucinations du bot ne se règlent pas en « entraînant » le modèle — elles se règlent en **ancrant** les faits (plaque, RAG, DB) et en **mesurant**. Ce harnais est la partie « mesurer » : il attrape les régressions **et** les hallucinations qu'on n'avait pas prévues.

- **Détecteurs (`detectors.js`)** — fonctions pures qui flaguent un fait que le bot ne doit JAMAIS énoncer de mémoire, quel que soit le cas :
  - `motorisation_affirmee` — « votre C1 est un diesel » (carburant deviné) — *le bug prod du 15/07*
  - `faux_devis` — « DEV-231 / devis généré » en texte (rôle du système)
  - `gains_chiffres` — « +30 ch / +45 Nm / +20-40 % » cités de mémoire
  - `deplacement_domicile` — offre de déplacement (interdit : atelier uniquement)
  - `garantie_chiffree` — durée de garantie en mois/ans (doit renvoyer aux CGV)

  Ils tournent hors-ligne et sont validés par `detectors.test.js` (positifs + anti-faux-positifs, dont la négation « n'intervient **pas** à domicile »).

- **Éval live (`run-eval.js`)** — rejoue chaque cas de `cases.json` à travers le **vrai `askLLM` de prod** (même prompt, même RAG, mêmes garde-fous), puis note la réponse : détecteurs + `required`/`forbidden` + `type_in`. L'historique et l'état de conversation sont injectés par cas (déterministe, sans toucher la vraie base) ; le RAG et l'API Anthropic sont réels.

## Lancer

```bash
npm test                      # inclut les détecteurs (hors-ligne, gratuit)

npm run eval                  # éval live, tous les cas (nécessite .env : ANTHROPIC_API_KEY + Supabase)
node eval/run-eval.js --only RC01     # un seul cas
node eval/run-eval.js --limit 3
VERBOSE=1 node eval/run-eval.js       # logs internes askLLM (debug RAG/parse)
```

`run-eval.js` sort en **code 1** si un cas échoue (hallucination ou fait faux) → utilisable comme gate avant déploiement. Sans clés, il s'auto-ignore proprement (code 0) — les détecteurs restent couverts par `npm test`.

## Ajouter un cas (à chaque nouveau bug)

Édite `cases.json`, section `cases[]`. Schéma dans `cases.json._doc`. Le réflexe : **tout bug d'hallucination constaté en prod → un cas ici** (id `RCxx`), pour qu'il ne revienne jamais.

```json
{
  "id": "RC10-mon-bug",
  "trap": "price",
  "note": "Contexte du bug observé",
  "history": [{ "role": "user", "content": "…" }],
  "message": "le message client qui déclenchait l'hallucination",
  "expect": {
    "type_in": ["answer"],
    "detectors_absent": ["motorisation_affirmee", "faux_devis"],
    "required": ["390"],
    "forbidden": ["290"]
  }
}
```

Besoin d'un nouveau **détecteur** (nouvelle classe d'hallucination) ? Ajoute-le dans `detectors.js` (`DETECTORS`) + ses fixtures dans `detectors.test.js`. La même logique peut alimenter la télémétrie de prod (`lib/llm-service.js`).

## Lien avec le benchmark

`benchmark/` est l'évaluation **de recherche** (comparaison V1/V2 RAG pour le mémoire, juge LLM, 4 conditions). `eval/` est le filet **de non-régression** opérationnel (rapide, déterministe, verdict pass/fail sur le système réel). Les deux partagent l'esprit `required`/`forbidden` mais servent des objectifs différents.
