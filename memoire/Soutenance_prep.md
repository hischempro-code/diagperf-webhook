# Préparation soutenance — antisèche orale + Q&A

**Format EFREI : 20 min présentation · 20 min questions · 20 min délibération.**
Objectif présentation : raconter une histoire — *« automatiser sans mentir »* — et atterrir sur un **résultat mesuré + une reco actionnable**.

---

## 1. Antisèche orale (slide par slide, ~20 min)

> Règle d'or : **ne lis pas tes slides.** Chaque slide = 2-3 idées que tu développes à l'oral.

| # | Slide | Durée | Ce que tu dis (idées-clés) |
|---|---|---|---|
| 1 | Titre | 0:30 | « Bonjour, Hischem Hammoudi, alternant Data Analyst chez Diagperf. Mon mémoire : concevoir un assistant WhatsApp **fiable** pour une PME auto. » |
| 2 | Contexte | 1:30 | Diagperf = garage reprog/diag, 3 personnes. Demandes par téléphone, répétitives mais à fort conseil. **L'enjeu : automatiser sans jamais donner un prix ou une compat' faux** — sinon perte de confiance. |
| 3 | Problématique + QR | 1:30 | Lis la problématique. « Trois questions : traiter le langage naturel sans casser la conversation ; le RAG réduit-il les hallucinations ; et **où mettre le savoir métier**. » |
| 4 | Plan | 0:20 | « État de l'art → conception en 3 temps → évaluation → discussion. » |
| 5 | État de l'art | 1:30 | Les 5 approches en une phrase chacune. Insiste : règles = rigides ; LLM-prompt = hallucine ; **RAG = ancre les réponses** ; fine-tuning = exige des données ; agents = perspective. |
| 6 | Pourquoi le RAG | 1:00 | « Le RAG **sépare le savoir de la génération**. Ancrage → moins d'hallucinations [Lewis 2020, Shuster 2021]. Et maintenable : un tarif change = j'édite un fichier. » |
| 7 | Pipeline | 1:00 | Architecture **hybride** : flows déterministes pour les actions (devis/RDV), RAG+LLM pour les questions libres. **Sortie JSON** = le LLM répond ou rebascule sur un flow → contrôle des actions sensibles. |
| 8 | Vue client | 0:45 | « Voilà ce que voit le client : accueil + liste des prestations, en **messages interactifs WhatsApp** (boutons/listes). Le produit fonctionne. » |
| 9 | Évolution V0→V1→V2 | 1:00 | « Conception **itérative**, datée par git. Chaque étape corrige une limite de la précédente. » |
| 10-12 | Bugs V1 (×3) | 1:30 | Pour chacune : lis l'échange. « La question libre casse la conversation — 3 cas distincts. **C'est ça qui m'a poussé au RAG.** » Ces captures = ton moment fort, sois concret. |
| 13 | Architecture RAG | 1:30 | Indexation hors-ligne (24 fichiers Q&A → embeddings → pgvector) + interrogation (expansion → recherche hybride → rerank → contexte injecté). |
| 14 | Côté technique | 1:00 | Canal Meta WhatsApp Business (webhook signé HMAC), backend Node sur Render, et **Supabase à double rôle** : état de conversation **+** base vectorielle RAG. |
| 15 | Protocole benchmark | 1:30 | 31 questions, **4 conditions** (prompt baké/dépouillé × RAG oui/non). **L'ablation isole l'effet causal du RAG.** Juge = Opus 4.8 (plus fort que le modèle évalué). |
| 16 | Résultats | 2:00 | **Le moment clé.** « Effet causal : exactitude 0,66 → 0,98. Hallucinations : 9 → 0. Et la V2 est même plus rapide et moins chère grâce au cache. » Laisse le graphe parler. |
| 17 | Le RAG ne règle pas tout | 1:30 | **Ton honnêteté = ta force.** « Baker le savoir dans le prompt peut tromper. Sur les codes OBD, le RAG n'apporte rien. La valeur se concentre sur le **savoir métier qui change**. » |
| 18 | Reco d'ingénierie | 1:00 | « Résultat actionnable : **sortir tous les faits du prompt**, 100 % via le RAG → la meilleure config (0,98 ; 0 hallucination ; moins chère). » |
| 19 | Limites & perspectives | 1:00 | Limites : hors-ligne, juge faillible, qualité des sources. Perspectives : agents (devis/RDV auto), multilingue FR/AR, fine-tuning du ton. |
| 20 | Conclusion + iziA | 1:00 | « Le RAG rend l'assistant fiable ET maintenable pour une PME. Apports : RAG de bout en bout, déploiement, **évaluation rigoureuse** ; conduite de projet en autonomie. » |
| 21 | Merci | 0:10 | « Merci, je suis à votre disposition pour vos questions. » |

**Total ≈ 20 min.** Si tu débordes, raccourcis les slides 5, 9, 14 (factuelles). Ne raccourcis JAMAIS 16-17-18.

---

## 2. Questions anticipées du jury (réponses prêtes)

### Méthode & technique

**Q. Pourquoi le RAG et pas du fine-tuning ?**
Le fine-tuning fige le savoir dans les poids : il faut réentraîner à chaque changement de tarif, et il exige un corpus étiqueté conséquent que Diagperf n'a pas. Le RAG sépare le savoir (éditable, à jour) de la génération. Distinction classique : **RAG pour les faits qui changent, fine-tuning pour le style**. D'ailleurs ma meilleure config n'utilise aucun fine-tuning.

**Q. Pourquoi Claude Haiku 4.5 et pas un modèle plus puissant ?**
Volume modeste, besoin de latence faible et de coût maîtrisé. Surtout : **c'est le RAG qui fournit les faits** — le modèle n'a qu'à les reformuler, pas à les « savoir ». Le goulot d'étranglement, c'est la qualité du retrieval, pas la puissance du générateur. Un modèle plus gros augmenterait coût et latence sans gain d'exactitude. On peut basculer sur Sonnet en une ligne si besoin.

**Q. Votre benchmark est hors-ligne / synthétique. Est-ce représentatif ?**
C'est une limite assumée : le bot n'est pas encore déployé, donc pas de métriques terrain. Mais (1) les 31 questions couvrent les vraies catégories de demandes **+ 3 cas réels** tirés de bugs observés ; (2) le plan d'**ablation contrôlée** isole l'effet du RAG toutes choses égales par ailleurs — ce qu'un test terrain bruité ne permet pas ; (3) c'est une évaluation de **fiabilité** (exactitude/hallucination), pas de satisfaction — le terrain validera l'usage. C'est une démarche responsable : **mesurer avant de déployer**.

**Q. Un LLM (Opus) qui juge un autre LLM (Haiku), n'est-ce pas circulaire ?**
Méthodologie établie (LLM-as-a-judge, Zheng 2023). J'ai limité le biais : (1) juge **plus puissant** que le modèle évalué ; (2) **double mesure** avec un contrôle déterministe (présence/absence de faits) qui converge avec le juge ; (3) vérité-terrain fournie au juge. J'ai même montré que le juge Haiku initial se trompait sur des cas que le juge Opus a corrigés — d'où le choix d'un juge fort.

**Q. Pourquoi des embeddings Google et pas un modèle local ou OpenAI ?**
J'ai commencé en local (all-MiniLM) mais ça accrochait mal sur le **français technique**. Google gemini-embedding-001 est multilingue, performant sur le FR, à coût négligeable. Important : seuls les **embeddings** ont migré — le générateur est resté Claude tout du long.

**Q. « 0 hallucination », vraiment jamais ?**
Non : c'est 0 **sur ce jeu de test**. La garantie n'est pas absolue. Elle vient de deux choses : l'ancrage documentaire, et un prompt qui **force l'abstention** quand le fait n'est pas dans le contexte (« je vérifie / sur devis »). Le risque résiduel existe si le retrieval rate ou si la base contient une erreur — d'où ma limite « qualité bornée par les sources ».

**Q. 31 questions, n=3 pour certaines catégories : l'échantillon est-il suffisant ?**
C'est un **mini-benchmark**, pas une étude statistique — assumé. Mais l'écart est net (0,66 → 0,98), **cohérent sur deux juges** et sur le contrôle déterministe, et par catégorie. Pour publier, on élargirait ; pour décider d'une orientation d'ingénierie, le signal est sans ambiguïté.

**Q. La pondération 0,3 de la recherche hybride, comment l'avez-vous choisie ?**
Réglée empiriquement : priorité au sémantique (vecteur), tout en laissant le lexical rattraper les **termes exacts** (codes défauts, références moteur) que le vecteur peut manquer. C'est un hyperparamètre ajustable ; je ne prétends pas à l'optimum, mais il donne de bons scores de récupération.

**Q. Et si la base de connaissances est incomplète ou fausse ?**
C'est LE point faible du RAG, et je l'assume en limites. Info absente → le prompt force l'abstention (pas d'invention). Info fausse → le bot la répétera : d'où l'importance de la **gouvernance** de la base. Elle est en format Q&A, éditable par l'équipe, traçable par fichier.

### Produit & métier

**Q. Et le RGPD ? Vous traitez des données personnelles.**
Oui : numéro, nom, plaque. Trois principes (section 2.2 du mémoire) : **minimisation** (ne demander que le nécessaire au devis/RDV), **hébergement maîtrisé** (Supabase à accès contrôlé), **non-réutilisation pour entraînement** (API tierce appelée sans rétention à cette fin).

**Q. Quel coût réel en production ?**
À 1-4 demandes/jour, avec Haiku + prompt caching, le coût mensuel est de l'ordre de **quelques euros** — négligeable face au temps humain économisé. Mesuré : ~0,002-0,004 $ par question.

**Q. ~2 s de latence, c'est acceptable ?**
Sur WhatsApp, canal **asynchrone**, 2 s est imperceptible : le client ne s'attend pas à l'instantané. C'est bien mieux qu'attendre un rappel téléphonique.

**Q. Ça se généralise à d'autres PME ?**
Oui : à toute PME dont le savoir est **documentable** et dont les demandes passent par un canal conversationnel. La valeur croît avec le besoin d'exactitude et la fréquence de mise à jour. L'architecture est modulaire — changer la base de connaissances = changer de métier.

**Q. Pourquoi WhatsApp ?**
Canal déjà utilisé par les clients, **asynchrone** (n'interrompt pas l'atelier), **traçable**, et API officielle Meta (intégration propre, messages interactifs). Le téléphone ne laisse pas de trace et perd les appels manqués.

**Q. Que fait le bot s'il ne sait pas répondre ?**
Il **s'abstient** (pas d'invention) : « je vérifie / sur devis » et oriente vers l'équipe. Les cas hors périmètre (boîte auto, électrique) sont déclinés proprement. Une escalade humaine explicite est une perspective.

### Questions « pièges » / critiques

**Q. Votre meilleure config (B-RAG) n'est pas celle déployée. Pourquoi ?**
C'est justement ma **recommandation d'ingénierie** : sortir le savoir du prompt. La V2 livrée garde le savoir baké pour des raisons historiques ; le benchmark démontre qu'il faut migrer vers B-RAG. **C'est un résultat actionnable issu de l'étude, pas un échec.**

**Q. Le bot n'est pas en production, comment savez-vous qu'il marchera ?**
Je ne le garantis pas — je l'assume. Le benchmark valide la **fiabilité** en amont ; la mise en prod (imminente) validera l'**usage**. Mesurer avant de déployer est une démarche responsable, pas une faiblesse.

**Q. Quelle est votre contribution par rapport à des frameworks existants (LangChain…) ?**
Je n'ai **pas** utilisé de framework RAG clé-en-main. Le pipeline (chunking Q&A, recherche hybride, boost par intention, rerank, sortie JSON contrôlée) est construit sur mesure pour le métier. La contribution est aussi **méthodologique** : le protocole d'ablation à 4 conditions et la reco sur le placement du savoir.

### Posture / iziA

**Q. Qu'est-ce que cette mission vous a apporté ?**
Sur le plan technique : un pipeline RAG de bout en bout, le déploiement, et surtout une **démarche d'évaluation rigoureuse**. Sur le plan transverse : conduire un projet en autonomie de la V0 à la mise en production, et traduire un besoin métier flou en spécifications. (Mapping iziA 2.1 analyser → 2.4 exploiter.)

**Q. Si c'était à refaire ?**
Démarrer directement en RAG avec le savoir hors du prompt (éviter le détour V1), et **instrumenter le déploiement** plus tôt pour disposer de métriques terrain, pas seulement d'un benchmark hors-ligne.

---

## 3. Posture & réflexes

- **Assume tes limites** : c'est ce qui te crédibilise. Tu as un benchmark hors-ligne, un échantillon modeste, un bot pas encore déployé — dis-le clairement, ça désamorce les attaques.
- **Ramène toujours au métier** : « pour une PME comme Diagperf… ».
- **Si tu ne sais pas** : « Bonne question, je n'ai pas mesuré ce point précis ; mon intuition est… et je le vérifierais en faisant X. » Ne bluffe pas.
- **Ton point fort à marteler** : *fiabilité mesurée + maintenabilité + une reco concrète*. Pas juste « j'ai fait un chatbot ».
- **Respire, regarde le jury, prends ton temps sur les slides 16-17-18.**

Bonne soutenance ! 🚗
