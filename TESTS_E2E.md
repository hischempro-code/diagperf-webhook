# Tests manuels end-to-end WhatsApp

## Prérequis
1. Exécuter les SQL dans Supabase (dans cet ordre) :
   - `sql/create_tarifs_prestations.sql` (tables prestations + tarifs_prestations + seed data)
   - `sql/migrate_devis_generic.sql` (colonnes prestation_code + wa_id sur devis)
   - `sql/add_idempotency_key.sql` (si pas déjà fait)
   - `sql/create_sav_tickets.sql` (si pas déjà fait)
2. `node server.js`
3. Tunnel Cloudflare actif

---

## Scénario 1 : Reprogrammation moteur (branche 1)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `bonjour` | Menu 1-7 |
| 2 | `1` | "Reprogrammation moteur ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule détecté + prix HT + "Confirmer ?" |
| 4 | `oui` | "✅ Devis généré DEV-xxx Prestation : Reprogrammation moteur Total HT / TTC" |
| ✅ Vérif | | Ligne dans `devis` + `devis_lignes` avec `prestation_code = reprogrammation` |

## Scénario 2 : Conversion E85 (branche 2)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `bonjour` | Menu |
| 2 | `2` | "Conversion E85 ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule + prix 299.00€ HT + "Confirmer ?" |
| 4 | `oui` | "✅ Devis généré... Prestation : Conversion E85" |

## Scénario 3 : Suppression FAP (branche 3)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `menu` | Menu |
| 2 | `3` | "Suppression FAP ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule + prix 399.00€ HT |
| 4 | `oui` | Devis généré |

## Scénario 4 : Suppression EGR (branche 4)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `0` | Menu |
| 2 | `4` | "Suppression EGR ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule + prix 249.00€ HT |
| 4 | `oui` | Devis généré |

## Scénario 5 : Diagnostic complet (branche 5)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `bonjour` | Menu |
| 2 | `5` | "Diagnostic complet ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule + prix 89.00€ HT |
| 4 | `oui` | Devis généré |

## Scénario 6 : Autres prestations (branche 6)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `bonjour` | Menu |
| 2 | `6` | "Autres prestations ✅ Envoie-moi ta plaque..." |
| 3 | `AB-123-CD` | Véhicule + prix "sur demande" |
| 4 | `oui` | "Prix sur demande pour Autres prestations 📋 Notre équipe..." |
| ✅ Vérif | | Pas de ligne dans `devis` (NO_TARIF) |

## Scénario 7 : SAV / Réclamation (branche 7)
| Étape | Envoyer | Réponse attendue |
|-------|---------|------------------|
| 1 | `bonjour` | Menu |
| 2 | `7` | "🛠️ SAV DiagPerf... Quel est le sujet ?" |
| 3 | `1` | "Quel est ton nom complet ?" |
| 4 | `Jean Dupont` | "Quel est ton numéro de téléphone ?" |
| 5 | `06 12 34 56 78` | "Quel véhicule est concerné ?" |
| 6 | `Peugeot 308 2016` | "Décris ton problème..." |
| 7 | `Voyant moteur après reprog` | "✅ Demande SAV enregistrée Référence : SAV-000001" |
| ✅ Vérif | | Ligne dans `sav_tickets` avec topic, name, phone, vehicle, description |

---

## Cas d'erreur

### Plaque invalide
| Envoyer | Réponse |
|---------|---------|
| `1` puis `XXXXX` | "Je n'ai pas reconnu la plaque 😅" (reste en WAITING_PLATE) |

### Choix invalide
| Envoyer | Réponse |
|---------|---------|
| `9` | Menu (fallback) |

### Confirmation invalide
| Envoyer | Réponse |
|---------|---------|
| Après véhicule détecté : `peut-être` | "Réponds par oui ou non" |

### Reset en cours de flow
| Envoyer | Réponse |
|---------|---------|
| `1` → `AB-123-CD` → `menu` | Menu (flow réinitialisé) |
| `1` → `AB-123-CD` → `reset` | Menu (flow réinitialisé) |
| `1` → `AB-123-CD` → `annuler` | Menu (flow réinitialisé) |
| `1` → `AB-123-CD` → `bonjour` | Menu (flow réinitialisé) |

### Refus confirmation → nouvelle plaque
| Envoyer | Réponse |
|---------|---------|
| Après véhicule détecté : `non` | "OK 👍 Envoie-moi la bonne plaque..." |

### Double message (idempotence)
| Envoyer | Réponse |
|---------|---------|
| `oui` 2x très vite | 1er → devis créé, 2ème → "Je m'en occupe déjà ✅" |
| ✅ Vérif | Un seul devis en DB (idempotency_key unique) |

### Véhicule non trouvé → fallback manuel
| Envoyer | Réponse |
|---------|---------|
| `1` → `GD-555-FR` (plaque inconnue) | "Je n'ai pas trouvé..." puis "Envoie Marque/Modèle/Année" |
| `Peugeot 308 2016` | Véhicule + prix → confirmation |

### Mot-clé au lieu de chiffre
| Envoyer | Réponse |
|---------|---------|
| `reprogrammation` | Même chose que `1` |
| `e85` | Même chose que `2` |
| `fap` | Même chose que `3` |
| `diagnostic` | Même chose que `5` |
| `sav` | Même chose que `7` |
