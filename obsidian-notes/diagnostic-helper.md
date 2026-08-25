---
path: lib/diagnostic-helper.js
tags: [diagperf-webhook, source-code]
---

# diagnostic-helper

> `lib/diagnostic-helper.js`

## Rôle

Pré-analyse un message client : extrait les codes défauts OBD-II (DTC), le kilométrage et les symptômes courants (voyant moteur, fumée, perte puissance…). Mappe chaque famille DTC vers la prestation DiagPerf appropriée.

## Exports

buildDiagnosticContext, detectDtcCodes, detectMileage, detectSymptoms.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[llm-service]]
- [[server]]

## Notes

Injecte un contexte structuré dans le system prompt (`askLLM` — cf. [[llm-service]]).
