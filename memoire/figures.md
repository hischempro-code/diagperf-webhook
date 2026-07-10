# Figures Mermaid — Mémoire ING2 (De l'API au RAG)

> Diagrammes épurés (labels courts) pour rester lisibles en portrait ; le détail technique
> est dans le texte (sections 4.1 à 4.3). Blocs dans l'ordre d'extraction fig1…fig6.
> Rendus en PNG haute résolution puis insérés dans le .docx.

---

## fig1 — Figure 1 : Pipeline global de traitement d'un message (V2)

```mermaid
flowchart TD
    A[Message WhatsApp] --> B{Flow déterministe<br/>actif ?}
    B -->|oui| F[Flow déterministe<br/>devis · RDV · SAV]
    B -->|non · question libre| R[RAG + Claude Haiku 4.5]
    R --> F
    R --> O[Réponse ancrée]
    F --> O
```

---

## fig2 — Figure 3 : Architecture RAG (vue d'ensemble)

```mermaid
flowchart TD
    KB[Base de connaissances<br/>24 fichiers Q&A] --> EMB[Embeddings Google<br/>+ découpage en chunks]
    EMB --> DB[(Supabase pgvector<br/>table kb_chunks)]
    Q[Question client] --> H[Recherche hybride<br/>vecteur + full-text]
    DB -. chunks indexés .-> H
    H --> LLM[Claude Haiku 4.5]
    LLM --> A[Réponse ancrée]
```

---

## fig3 — Figure 4 : Cas d'utilisation (UML)

```mermaid
flowchart LR
    C([Client])
    G([Gérant])
    C --- U1((Demander<br/>un devis))
    C --- U2((Prendre<br/>rendez-vous))
    C --- U3((Question<br/>technique))
    C --- U4((SAV /<br/>garantie))
    G --- U5((Recevoir une<br/>notification))
```

---

## fig4 — Figure 5 : Séquence — du message à la réponse ancrée (UML)

```mermaid
sequenceDiagram
    actor C as Client
    participant WH as Webhook
    participant DB as Supabase
    participant RAG as RAG
    participant LLM as Claude
    C->>WH: Question (signée HMAC)
    WH->>DB: Lecture de l'état
    DB-->>WH: Question libre
    WH->>RAG: retrieveContext()
    RAG->>DB: Recherche hybride
    DB-->>RAG: Chunks pertinents
    RAG-->>WH: Contexte ancré
    WH->>LLM: Prompt + contexte
    LLM-->>WH: JSON (answer)
    WH-->>C: Réponse ancrée
```

---

## fig5 — Figure 2 : Évolution itérative de l'assistant (V0 → V1 → V2)

```mermaid
flowchart TD
    V0["V0 · 15 avril<br/>Arbre de décision<br/>boutons, sans LLM"]
    V1["V1 · 7 mai<br/>LLM par prompt<br/>savoir baké → hallucinations"]
    V2["V2 · 15 mai → 2 juin<br/>RAG hybride<br/>embeddings Google → réponses ancrées"]
    V0 --> V1 --> V2
```

---

## fig6 — Figure 7 : Deux lectures des résultats

```mermaid
flowchart TD
    B0[B sans RAG<br/>exactitude 0,66] -->|+ RAG| B1[B-RAG<br/>exactitude 0,98]
    A0[V1 sans RAG<br/>9 hallucinations] -->|+ RAG| A1[V2 + RAG<br/>1 hallucination]
    B1 ~~~ A0
```

---

## Figure 6 : Résultats du benchmark (graphique matplotlib → figs/fig_resultats.png)

| Condition | Exactitude | Hallucinations | Déterministe |
|---|---|---|---|
| A-V1 — baké, sans RAG | 0,77 | 9/31 | 81 % |
| A-V2 — baké + RAG | 0,97 | 1/31 | 90 % |
| B-noRAG — dépouillé, sans RAG | 0,66 | 0/31 | 48 % |
| B-RAG — dépouillé + RAG | 0,98 | 0/31 | 94 % |
```
