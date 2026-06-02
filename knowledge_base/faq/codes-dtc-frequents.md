---
category: faq
tags: [dtc, obd, code defaut, panne, voyant moteur, diagnostic, p0, p1, p2, u0, c0]
intent: DIAG
---

# Codes défauts OBD-II fréquents — Explication et solutions DiagPerf

## Codes FAP (Filtre à Particules)

### P2002 / P2003 — FAP efficacité insuffisante
Le filtre à particules est encrassé ou saturé. Le calculateur détecte que la régénération ne se fait plus correctement. Symptômes : voyant moteur, perte de puissance, mode dégradé possible. Solution : suppression logicielle FAP (260€ avant 2019, 300€ après) ou diagnostic préalable (50€).

### P242F / P2459 / P244A / P244B — FAP bouché / pression différentielle FAP
La pression en amont du FAP est trop élevée : le filtre est obstrué. Régénération impossible ou trop fréquente. Diagnostic d'abord pour confirmer, puis suppression FAP si nécessaire.

### P2458 — Durée de régénération FAP excessive
Le moteur tente de régénérer le FAP sans succès. Souvent lié à des trajets urbains courts qui empêchent la montée en température. Suppression logicielle FAP recommandée si le filtre est définitivement saturé.

### P20E8 / P20EF — Régénération FAP non complète
Régénération interrompue avant la fin. Peut venir d'une conduite trop courte ou d'un FAP dégradé. Diagnostic pour confirmer.

---

## Codes EGR (Vanne de Recirculation des Gaz)

### P0400 / P0401 / P0402 — Débit EGR insuffisant ou excessif
La vanne EGR est encrassée ou défaillante. P0401 = débit trop faible (vanne coincée fermée). P0402 = débit trop élevé (vanne coincée ouverte). Symptômes : à-coups, fumée noire, voyant moteur. Solution : suppression logicielle EGR (190€ TTC diesel).

### P0403 / P0404 / P0405 / P0406 — Capteur ou circuit EGR défaillant
Défaut électrique sur le circuit de la vanne EGR (capteur position, alimentation). Diagnostic approfondi (80€) pour localiser le composant défaillant, ou suppression logicielle.

### P0409 — Capteur EGR circuit A
Défaut sur le capteur de position de la vanne EGR. Peut déclencher le mode dégradé sur diesel. Diagnostic ou suppression EGR.

---

## Codes AdBlue / SCR (Dépollution NOx Diesel)

### P20EE / P204F — Efficacité catalyseur SCR insuffisante
Le système AdBlue ne réduit pas suffisamment les émissions de NOx. Peut venir d'un doseur défaillant, d'une pompe, ou d'un capteur NOx. Suppression logicielle AdBlue (260€ BlueHDi / 300€ autres diesel).

### P2BAD / P2201 / P2202 — Capteur NOx défaillant
Le capteur de NOx (amont ou aval) donne une lecture anormale. Le système entre en mode comptage vers l'immobilisation. Intervention urgente recommandée : suppression AdBlue ou remplacement capteur.

### P207F — Qualité réducteur AdBlue insuffisante
L'AdBlue est contaminé, dilué ou absent. Remplir avec de l'AdBlue certifié, ou supprimer logiciellement le système si les pannes sont récurrentes.

### P2048 / P20BD — Doseur AdBlue défaillant
Le doseur/injecteur d'AdBlue est en panne. Pièce coûteuse à remplacer : la suppression logicielle est souvent plus économique (260–300€).

---

## Codes Catalyseur

### P0420 / P0421 — Efficacité catalyseur inférieure au seuil (banc 1)
Le catalyseur est vieilli ou dégradé, les sondes lambda détectent une combustion incomplète. Fréquent sur les véhicules de plus de 150 000 km. Diagnostic approfondi (80€) recommandé pour confirmer avant toute décision.

### P0430 / P0431 — Efficacité catalyseur inférieure au seuil (banc 2)
Identique à P0420 mais sur le deuxième banc (moteurs V6/V8 ou bi-turbo). Diagnostic complet requis.

---

## Codes Calage Arbre à Cames / VVT (Distribution Variable)

### P0011 — Calage arbre à cames admission trop avancé (banc 1)
Le système de calage variable (VVT) maintient l'arbre à cames dans une position trop avancée. Causes : huile encrassée, actuateur VVT défaillant, déphaseur usé. Diagnostic complet (130€) recommandé.

### P0012 — Calage arbre à cames admission trop retardé (banc 1)
Le calage VVT est bloqué en position retardée. Mêmes causes que P0011. Vidange et diagnostic.

### P0013 — Circuit commande arbre à cames échappement (banc 1)
Défaut électrique sur l'électrovanne de commande du VVT côté échappement. Souvent une électrovanne encrassée ou défaillante.

### P0014 — Calage arbre à cames échappement trop avancé (banc 1)
Le déphaseur d'arbre à cames (côté échappement) est bloqué en position avancée. Causes fréquentes : huile de mauvaise qualité, circuit d'huile encrassé, déphaseur usé. Symptômes : démarrage difficile, consommation accrue, voyant moteur. Diagnostic complet (130€) pour confirmer avant remplacement du déphaseur.

### P0015 — Calage arbre à cames échappement trop retardé (banc 1)
Même problème que P0014 mais en position retardée. Peut venir d'un filtre à huile colmaté ou d'une pression d'huile insuffisante.

### P0016 / P0017 / P0018 / P0019 — Corrélation arbre à cames / vilebrequin
Désynchronisation entre la position du vilebrequin et celle de l'arbre à cames. Peut indiquer une chaîne de distribution étirée ou un déphaseur défaillant. Diagnostic urgent recommandé.

---

## Codes Sonde Lambda / Richesse Mélange

### P0171 / P0174 — Mélange trop pauvre (banc 1 / banc 2)
Le moteur reçoit trop d'air par rapport à l'essence injectée. Causes : fuite admission, injecteur bouché, sonde lambda vieille, débit massique air défaillant. Diagnostic approfondi (80€).

### P0172 / P0175 — Mélange trop riche (banc 1 / banc 2)
Trop de carburant par rapport à l'air. Causes : injecteur qui fuit, pression carburant excessive, sonde lambda dérivée. Diagnostic approfondi.

### P0130 / P0136 / P0140 / P0141 — Sonde lambda défaillante
Sonde lambda amont ou aval hors gamme ou non chauffée. Entraîne une consommation accrue et des ratés de combustion. Remplacement de sonde ou diagnostic pour identifier la cause.

---

## Codes Turbo / Suralimentation

### P0234 — Surpression turbo dépassée
La pression de suralimentation dépasse les valeurs maximales. Causes : wastegate bloquée fermée, électrovanne de régulation défaillante, cartographie agressive. Diagnostic complet (130€) avant toute reprogrammation.

### P0299 — Sous-pression turbo (pression insuffisante)
Le turbo ne monte pas suffisamment en pression. Causes : fuite sur le circuit d'admission, turbo usé, wastegate bloquée ouverte. Diagnostic complet recommandé — la reprogrammation n'est envisageable qu'après confirmation que le turbo est sain.

### P0243 / P0245 — Électrovanne wastegate défaillante
La vanne de régulation du turbo (wastegate) ne répond pas correctement. Diagnostic électrique et mécanique.

---

## Codes Carburant / Pression

### P0087 — Pression carburant insuffisante
La pression dans le rail d'injection est trop basse. Causes : pompe carburant en fin de vie, filtre à carburant colmaté, régulateur de pression défaillant. Diagnostic complet (130€).

### P0088 — Pression carburant excessive
Pression trop élevée dans le circuit. Régulateur de pression défaillant. Diagnostic impératif avant toute intervention.

### P0191 / P0192 / P0193 — Capteur pression rail carburant
Le capteur de pression du rail d'injection donne une valeur anormale. Diagnostic pour distinguer un défaut capteur d'un vrai problème de pression.

---

## Codes Ratés d'Allumage

### P0300 — Ratés d'allumage aléatoires (tous cylindres)
Des ratés de combustion sont détectés sans cylindre spécifique identifié. Causes : bougies usées, bobines défaillantes, injecteurs encrassés, fuite de compression. Diagnostic urgent — les ratés endommagent le catalyseur.

### P0301 / P0302 / P0303 / P0304 — Ratés cylindre 1 / 2 / 3 / 4
Raté localisé sur un cylindre précis. Souvent une bougie ou une bobine d'allumage. Diagnostic simple (50€) suffit pour localiser. Pour les véhicules convertis E85 : des bougies adaptées (+170€) résolvent souvent les ratés à froid.

---

## Codes Boîte de Vitesses (non traités chez DiagPerf)

### P0700 / P0730 / P0731 — Défauts boîte automatique
Ces codes indiquent un problème sur la boîte de vitesses automatique ou le convertisseur. DiagPerf ne traite pas les boîtes auto — nous vous orientons vers un spécialiste BVA.

---

## Codes Réseau CAN / Constructeur

### U0001 / U0100 / U0101 — Perte de communication réseau CAN
Le bus CAN (réseau des calculateurs) présente une rupture de communication. Souvent électrique (batterie déchargée, faisceau endommagé). Diagnostic complet (130€) pour identifier l'origine.

### P1xxx — Codes constructeur spécifiques
Les codes commençant par P1 sont propres à chaque marque. Ils nécessitent un diagnostic avec valise compatib le au constructeur. DiagPerf dispose des outils adaptés pour les principales marques (Peugeot, Renault, Citroën, BMW, Mercedes, Audi, VW, Ford, Opel, Toyota).

---

## Que faire face à un code défaut ?

1. **Ne pas ignorer le voyant moteur** — même si le véhicule roule encore normalement, le problème peut s'aggraver.
2. **Diagnostic simple (50€)** — lecture et effacement des codes, 20 minutes. Idéal pour identifier rapidement le problème.
3. **Diagnostic approfondi (80€)** — interprétation des codes, tests en conditions réelles, remise à zéro des compteurs.
4. **Recherche de panne (130€)** — diagnostic électrique complet, tests en temps réel, analyse de données. Pour les pannes complexes ou intermittentes.

Envoyez votre plaque d'immatriculation pour que nous identifions votre véhicule et vous proposions la solution adaptée.
