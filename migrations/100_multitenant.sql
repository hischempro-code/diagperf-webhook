-- ============================================================================
-- Migration 100 — Passage multi-tenant
--
-- ⚠️  NE PAS EXÉCUTER D'UN SEUL BLOC EN PRODUCTION.
--
--     Étapes 1 à 4 : ADDITIVES. Le bot actuel continue de tourner sans rien voir
--                    (nouvelles tables, nouvelles colonnes nullables puis remplies,
--                    aucune contrainte existante modifiée). On peut s'arrêter ici
--                    pendant des jours.
--
--     Étapes 5 à 7 : elles changent des contraintes que le code LIT. À jouer dans
--                    la même fenêtre que le déploiement du code adapté, jamais avant.
--
--     Étape 8      : après 48 h de production stable seulement.
--
-- Écrit contre le schéma réel du projet Supabase `bot diagperf` (Postgres 17.6),
-- inspecté le 17/09/2026 — pas contre les fichiers sql/ du dépôt, qui sont périmés.
-- Justification détaillée de chaque verrou : ../MIGRATION-PHASE1.md (dossier SaaS-Chatbot).
-- ============================================================================


-- ============================================================================
-- ÉTAPE 1 — Les tables de la plateforme                            [ADDITIVE]
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists tenants (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  nom_commercial      text not null,
  secteur             text not null default 'autre',
  email_contact       text,
  statut              text not null default 'onboarding'
                      check (statut in ('onboarding','actif','suspendu','resilie')),
  plan                text not null default 'essentiel'
                      check (plan in ('essentiel','pro','atelier')),
  quota_conversations int  not null default 100,
  created_at          timestamptz not null default now(),
  activated_at        timestamptz
);

-- Table de routage : phone_number_id -> tenant. Lue à chaque webhook entrant.
create table if not exists tenant_numbers (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  provider        text not null default 'bsp',
  phone_number_id text not null unique,
  waba_id         text,
  display_number  text,
  statut          text not null default 'pending'
                  check (statut in ('pending','verifying','actif','suspendu')),
  created_at      timestamptz not null default now(),
  primary key (tenant_id, phone_number_id)
);

-- Secrets par client. Chiffrés AES-256-GCM côté Node (lib/crypto.js) ;
-- la clé maîtresse (TENANT_SECRET_KEY) ne vit QUE dans l'environnement Render.
create table if not exists tenant_secrets (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  cle             text not null,
  valeur_chiffree text not null,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, cle)
);

-- Ce qui remplace la partie « métier » de config/index.js, par client.
create table if not exists tenant_config (
  tenant_id       uuid primary key references tenants(id) on delete cascade,
  adresse         jsonb not null default '{}'::jsonb,   -- remplace DIAGPERF_LOCATION
  horaires        jsonb not null default '{}'::jsonb,
  prompt_identite text,                                  -- bloc « IDENTITÉ & TON »
  menu            jsonb not null default '{}'::jsonb,    -- MENU_MAP + INTENT_LABELS
  branding        jsonb not null default '{}'::jsonb,    -- couleurs PDF, logo, CGV
  updated_at      timestamptz not null default now()
);

-- Compteurs d'usage. Nécessaires dès le jour 1 : depuis le 01/10/2026, les messages
-- de service WhatsApp sont facturés au-delà de 1 000 par numéro et par mois.
create table if not exists usage_counters (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  periode           date not null,                       -- 1er du mois
  conversations     int not null default 0,
  messages_sortants int not null default 0,
  appels_llm        int not null default 0,
  primary key (tenant_id, periode)
);

create table if not exists subscriptions (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan                   text,
  statut                 text,
  current_period_end     timestamptz
);

-- Numérotation par client : sert les devis ET les tickets SAV (étape 6).
create table if not exists tenant_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  nom       text not null,                               -- 'devis' | 'sav'
  valeur    bigint not null default 0,
  primary key (tenant_id, nom)
);

-- Verrous de conversation. Remplacent la Map en mémoire de routes/webhook.js,
-- qui ne survit pas à une deuxième instance Render (symptôme constaté en prod :
-- double PDF + double email).
create table if not exists conversation_locks (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  wa_id      text not null,
  locked_at  timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '60 seconds'),
  primary key (tenant_id, wa_id)
);
create index if not exists idx_conversation_locks_expiry on conversation_locks (expires_at);

alter table tenants            enable row level security;
alter table tenant_numbers     enable row level security;
alter table tenant_secrets     enable row level security;
alter table tenant_config      enable row level security;
alter table usage_counters     enable row level security;
alter table subscriptions      enable row level security;
alter table tenant_counters    enable row level security;
alter table conversation_locks enable row level security;

-- Aucune policy : comme les 14 tables existantes, ces tables restent accessibles
-- au seul service_role. L'isolation réelle est assurée par lib/db.js côté application
-- (la clé service_role contourne la RLS par conception — voir ROADMAP §1.3).


-- ============================================================================
-- ÉTAPE 2 — Créer le client n°1 (Diagperf)                         [ADDITIVE]
-- ============================================================================

insert into tenants (slug, nom_commercial, secteur, email_contact, statut, plan,
                     quota_conversations, activated_at)
values ('diagperf', 'DiagPerf', 'garage', 'diag.perf.pro@gmail.com', 'actif', 'atelier',
        1000000, now())
on conflict (slug) do nothing;

insert into tenant_config (tenant_id, adresse, branding)
select id,
       jsonb_build_object('latitude', 48.9583, 'longitude', 2.8789,
                          'name',    'DiagPerf – Reprogrammation & Diagnostic',
                          'address', '38 Rue Jean Pierre Plicque, 77124 Villenoy'),
       jsonb_build_object('cgv_url', 'https://www.diagperf.com/conditions-generales-de-vente/')
from tenants where slug = 'diagperf'
on conflict (tenant_id) do nothing;

-- Continuité de numérotation : Diagperf reprend à son maximum actuel, donc les
-- références DEV-xxx déjà envoyées aux clients restent valides. Tout nouveau
-- client démarre à 1.
insert into tenant_counters (tenant_id, nom, valeur)
select t.id, 'devis', coalesce((select max(id) from devis), 0)
from tenants t where t.slug = 'diagperf'
on conflict (tenant_id, nom) do nothing;

insert into tenant_counters (tenant_id, nom, valeur)
select t.id, 'sav', coalesce((select last_value from sav_reference_seq), 0)
from tenants t where t.slug = 'diagperf'
on conflict (tenant_id, nom) do nothing;


-- ============================================================================
-- ÉTAPE 3 — Ajouter tenant_id partout (nullable)                   [ADDITIVE]
-- ============================================================================

alter table conversations      add column if not exists tenant_id uuid references tenants(id);
alter table messages           add column if not exists tenant_id uuid references tenants(id);
alter table conversation_state add column if not exists tenant_id uuid references tenants(id);
alter table devis              add column if not exists tenant_id uuid references tenants(id);
alter table devis_lignes       add column if not exists tenant_id uuid references tenants(id);
alter table prestations        add column if not exists tenant_id uuid references tenants(id);
alter table tarifs_prestations add column if not exists tenant_id uuid references tenants(id);
alter table sav_tickets        add column if not exists tenant_id uuid references tenants(id);
alter table review_requests    add column if not exists tenant_id uuid references tenants(id);
alter table client_pins        add column if not exists tenant_id uuid references tenants(id);
alter table depenses           add column if not exists tenant_id uuid references tenants(id);
alter table kb_chunks          add column if not exists tenant_id uuid references tenants(id);
alter table "véhicules"        add column if not exists tenant_id uuid references tenants(id);

-- reprog_moteurs : PAS de tenant_id. 24 693 lignes de référentiel automobile,
-- mutualisé entre tous les clients. C'est un actif produit, pas une dette.


-- ============================================================================
-- ÉTAPE 4 — Backfill sur Diagperf, puis NOT NULL                   [ADDITIVE]
-- ============================================================================

do $$
declare t uuid;
begin
  select id into strict t from tenants where slug = 'diagperf';

  update conversations      set tenant_id = t where tenant_id is null;
  update messages           set tenant_id = t where tenant_id is null;
  update conversation_state set tenant_id = t where tenant_id is null;
  update devis              set tenant_id = t where tenant_id is null;
  update devis_lignes       set tenant_id = t where tenant_id is null;
  update prestations        set tenant_id = t where tenant_id is null;
  update tarifs_prestations set tenant_id = t where tenant_id is null;
  update sav_tickets        set tenant_id = t where tenant_id is null;
  update review_requests    set tenant_id = t where tenant_id is null;
  update client_pins        set tenant_id = t where tenant_id is null;
  update depenses           set tenant_id = t where tenant_id is null;
  update kb_chunks          set tenant_id = t where tenant_id is null;
  update "véhicules"        set tenant_id = t where tenant_id is null;
end $$;

alter table conversations      alter column tenant_id set not null;
alter table messages           alter column tenant_id set not null;
alter table conversation_state alter column tenant_id set not null;
alter table devis              alter column tenant_id set not null;
alter table devis_lignes       alter column tenant_id set not null;
alter table prestations        alter column tenant_id set not null;
alter table tarifs_prestations alter column tenant_id set not null;
alter table sav_tickets        alter column tenant_id set not null;
alter table review_requests    alter column tenant_id set not null;
alter table client_pins        alter column tenant_id set not null;
alter table depenses           alter column tenant_id set not null;
alter table kb_chunks          alter column tenant_id set not null;
alter table "véhicules"        alter column tenant_id set not null;

-- ⛔ POINT D'ARRÊT. Tout ce qui précède est réversible et invisible pour le bot.
--    Ce qui suit change des contraintes que le code lit : à jouer avec le déploiement.


-- ============================================================================
-- ÉTAPE 5 — Reposer les sept verrous globaux              [BASCULE — AVEC LE CODE]
-- ============================================================================

-- 1. 🔴 conversations : UNIQUE (wa_phone) globale.
--    Sans ce changement, un client qui écrit à deux commerces ne peut avoir qu'une
--    seule conversation — getOrCreateConversation retrouverait celle de l'autre.
alter table conversations drop constraint if exists conversations_wa_phone_unique;
alter table conversations add  constraint conversations_tenant_wa_phone_unique
  unique (tenant_id, wa_phone);
drop index if exists idx_conversations_wa_phone;
create index if not exists idx_conversations_tenant_wa_phone
  on conversations (tenant_id, wa_phone);

-- 2. 🔴 prestations : UNIQUE (code) globale.
--    Deux commerces ne peuvent pas avoir une prestation portant le même code.
alter table prestations drop constraint if exists prestations_code_key;
alter table prestations add  constraint prestations_tenant_code_key unique (tenant_id, code);

-- 3. 🔴 devis : UNIQUE (idempotency_key) globale, et la clé construite en
--    lib/devis-service.js ne contient pas le tenant. Sur collision, le code de
--    rattrapage sert le devis d'un AUTRE commerce. Fuite réelle.
drop index if exists idx_devis_idempotency_key;
create unique index if not exists idx_devis_tenant_idempotency
  on devis (tenant_id, idempotency_key) where idempotency_key is not null;

-- 4. 🟠 conversation_state : PK (wa_id) -> PK composite.
alter table conversation_state drop constraint if exists conversation_state_pkey;
alter table conversation_state add  primary key (tenant_id, wa_id);

-- 5. 🟠 client_pins : PK (wa_id) -> PK composite.
alter table client_pins drop constraint if exists client_pins_pkey;
alter table client_pins add  primary key (tenant_id, wa_id);

-- 6. 🟠 review_requests.
drop index if exists idx_review_requests_unique;
create unique index if not exists idx_review_requests_tenant_unique
  on review_requests (tenant_id, wa_id, devis_id) where devis_id is not null;
drop index if exists idx_review_requests_pending;
create index if not exists idx_review_requests_tenant_pending
  on review_requests (tenant_id, send_at) where sent = false;

-- 7. 🟠 véhicules : UNIQUE (plaque) globale — deux commerces ne pourraient pas
--    voir le même véhicule. (véhicules_conversation_unique reste valide : une
--    conversation appartient déjà à un seul tenant.)
alter table "véhicules" drop constraint if exists "véhicules_plaque_key";
alter table "véhicules" add  constraint "véhicules_tenant_plaque_key" unique (tenant_id, plaque);

-- ✅ messages_wa_message_id_uidx reste GLOBALE : les identifiants de message Meta
--    sont uniques au niveau mondial, et cette contrainte porte l'idempotence de
--    insertInboundMessage. La scoper n'apporterait rien et affaiblirait le garde-fou.

-- Index de service, tenant_id en première colonne.
create index if not exists idx_messages_tenant_created   on messages (tenant_id, created_at desc);
create index if not exists idx_devis_tenant_created      on devis (tenant_id, created_at desc);
create index if not exists idx_devis_tenant_wa_id        on devis (tenant_id, wa_id);
create index if not exists idx_sav_tickets_tenant_status on sav_tickets (tenant_id, status);
create index if not exists idx_devis_lignes_tenant       on devis_lignes (tenant_id, devis_id);
create index if not exists idx_tarifs_tenant_actif       on tarifs_prestations (tenant_id, prestation_id)
  where actif;


-- ============================================================================
-- ÉTAPE 6 — Numérotation par client                       [BASCULE — AVEC LE CODE]
-- ============================================================================

create or replace function next_tenant_counter(p_tenant uuid, p_nom text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into tenant_counters (tenant_id, nom, valeur) values (p_tenant, p_nom, 1)
  on conflict (tenant_id, nom) do update set valeur = tenant_counters.valeur + 1
  returning valeur into v;
  return v;
end $$;

-- devis.numero : référence lisible par client, indépendante de la séquence partagée
-- devis_id_seq. Sans elle, le premier devis d'un nouveau client s'appellerait DEV-103,
-- ce qui révèle ton volume total à chacun de tes clients.
alter table devis add column if not exists numero bigint;
update devis set numero = id where numero is null;   -- continuité : DEV-230 reste DEV-230
create unique index if not exists idx_devis_tenant_numero on devis (tenant_id, numero);

-- sav_tickets : le trigger cesse d'utiliser la séquence globale sav_reference_seq.
create or replace function generate_sav_reference()
returns trigger language plpgsql as $$
begin
  if new.reference is null then
    new.reference := 'SAV-' || lpad(next_tenant_counter(new.tenant_id, 'sav')::text, 6, '0');
  end if;
  return new;
end $$;


-- ============================================================================
-- ÉTAPE 7 — Le RAG : kb_chunks et les fonctions de recherche
--                                                         [BASCULE — AVEC LE CODE]
--
-- Le point le plus sensible de toute la migration : sans filtre par client, le RAG
-- d'un commerce répond avec les tarifs d'un autre.
-- ============================================================================

-- L'index ivfflat (lists=10) était dimensionné pour un corpus unique de 182 chunks.
-- Il doit être reconstruit ; le filtre par client se fait dans le WHERE en amont.
drop index if exists kb_chunks_embedding_idx;
create index kb_chunks_embedding_idx on kb_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 50);

create index if not exists kb_chunks_tenant_idx on kb_chunks (tenant_id);
drop index if exists kb_chunks_file_path_idx;
create index if not exists kb_chunks_tenant_file_path_idx on kb_chunks (tenant_id, file_path);

-- ⚠️ NOUVELLE SIGNATURE, l'ancienne n'est PAS remplacée : sinon le bot en production
--    casse à la seconde où la migration passe, avant même que le code soit déployé.
--    L'ancienne est supprimée à l'étape 8, après bascule.
create or replace function match_kb_chunks(
  p_tenant_id     uuid,
  query_embedding vector(384),
  match_threshold float default 0.3,
  match_count     int   default 5
)
returns table (id bigint, file_path text, category text, tags text[], intent text,
               content text, similarity float)
language sql stable as $$
  select kb.id, kb.file_path, kb.category, kb.tags, kb.intent, kb.content,
         1 - (kb.embedding <=> query_embedding) as similarity
  from kb_chunks kb
  where kb.tenant_id = p_tenant_id
    and 1 - (kb.embedding <=> query_embedding) > match_threshold
  order by kb.embedding <=> query_embedding
  limit match_count;
$$;

-- match_kb_chunks_hybrid : même traitement (p_tenant_id en premier paramètre,
-- filtre ajouté aux deux branches, vectorielle et fts_content). Sa définition
-- actuelle combine un score vectoriel et un score plein-texte pondéré par
-- keyword_weight : elle sera reprise ligne à ligne depuis la base plutôt que
-- réécrite de mémoire, au moment d'adapter rag.js.
-- TODO(étape 7b) — à écrire avec rag.js.


-- ============================================================================
-- ÉTAPE 8 — Nettoyage, après 48 h de production stable
-- ============================================================================

-- drop function if exists match_kb_chunks(vector, float, int);
-- drop function if exists match_kb_chunks_hybrid(vector, text, float, float, float);
-- drop sequence if exists sav_reference_seq;
