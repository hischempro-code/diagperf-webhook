---
path: routes/webhook.js
tags: [diagperf-webhook, source-code]
---

# webhook

> `routes/webhook.js`

## Rôle

Router `/webhook` Meta : verify challenge (GET) + réception (POST). Verrou par `wa_id` (60s) pour éviter les double-traitements sur POST concurrents. Route via LLM (`type=route`), applique les fallbacks intent, dispatch vers les flows prestation/sav.

## Exports

createWebhookHandler.

## Dépendances internes

- [[text-helpers]]
- [[intent-router]]
- [[conversation-memory]]
- [[plate-extractor]]
- [[intent-detector]]

## Consommateurs (reverse)

- [[server]]
