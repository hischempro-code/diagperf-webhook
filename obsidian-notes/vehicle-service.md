---
path: lib/vehicle-service.js
tags: [diagperf-webhook, source-code]
---

# vehicle-service

> `lib/vehicle-service.js`

## Rôle

Service véhicule central : lookup par plaque (API immatriculation), lookup stages reprog (Shiftech), calcul des prix par prestation, validation de compatibilité intent/véhicule (essence vs diesel, AdBlue SCR, année), options upsell.

## Exports

initVehicleService, lookupVehicleFromPlate, lookupReprogStages, computeReprogPrice/E85/Adblue/Egr/FapPrice, validateIntentForVehicle, getUpsellOptionsForVehicle, buildVehicleOnlyText, UPSELL_OPTIONS, INTENT_VEHICLE_REQUIREMENTS, STAGE1_FIXED_PRICE_CENTS, TTC_INTENTS, CUSTOM_QUOTE_STAGES, _isDieselVehicle, _isEssenceVehicle, _hasAdBlueSystem, formatStageLabel.

## Dépendances internes

- [[text-helpers]]

## Consommateurs (reverse)

- [[devis-service]]
- [[media-builders]]
- [[prestation]]
- [[sav]]
- [[vehicle-card]]
- [[vehicle-incompat-switch.test]]
- [[vehicle-pricing.test]]
