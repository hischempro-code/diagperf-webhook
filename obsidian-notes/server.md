---
path: server.js
tags: [diagperf-webhook, source-code]
---

# server

> `server.js`

## Rôle

Point d'entrée Express du webhook DiagPerf. Bootstrappe Sentry, la config, Supabase, le RAG, les services (LLM, PDF, email, WhatsApp, vidéo Creatomate, relances), branche les routes `/webhook` et `/api/dashboard`, orchestre la boucle de traitement d'un message entrant et démarre le cron des relances.

## Exports

Aucun (script long-running).

## Dépendances internes

- [[sentry]]
- [[config-index]]
- [[rag]]
- [[creatomateVideo]]
- [[diagnostic-helper]]
- [[sentiment-detector]]
- [[conversation-memory]]
- [[intent-router]]
- [[signature]]
- [[dashboard]]
- [[relance-service]]
- [[prestation]]
- [[sav]]
- [[webhook]]
- [[pdf-service]]

## Dépendances externes / stdlib

- `express`
- `@supabase/supabase-js`
- `fs`
- `path`
- `node-fetch`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Sentry est chargé en tout premier pour capter les erreurs des autres `require`.
