/**
 * lib/db.js — Accès base cloisonné par client (multi-tenant).
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * L'application se connecte à Supabase avec la clé `service_role`, qui CONTOURNE la RLS
 * par conception. Écrire des politiques RLS ne protégerait donc rien tant que le bot
 * utilise cette clé : ce serait une illusion de sécurité, ce qui est pire que rien.
 *
 * La vraie frontière entre deux clients, c'est ce module. Toute requête passe par
 * `db.tenant(tenantId)`, qui :
 *   - ajoute `.eq('tenant_id', …)` à chaque select / update / delete ;
 *   - injecte `tenant_id` dans chaque insert / upsert.
 *
 * Un `.eq('tenant_id', …)` oublié à un seul endroit, et le bot d'un commerce répond avec
 * les données d'un autre. Ce module rend l'oubli impossible — et
 * `tests/db-scoping.test.js` échoue si un `supabase.from(` réapparaît ailleurs dans le code.
 *
 * USAGE
 *
 *   const { createDb } = require("./lib/db");
 *   const db = createDb(supabaseClient);          // une fois au démarrage
 *
 *   await db.tenant(t).from("devis").select("*");            // -> ... where tenant_id = t
 *   await db.tenant(t).from("devis").insert({ plaque })      // -> tenant_id ajouté
 *   await db.unscoped("reprog_moteurs", "référentiel mutualisé").select("*");
 */
"use strict";

const TENANT_COLUMN = "tenant_id";

/**
 * Tables qui n'ont PAS de colonne tenant_id — les scoper produirait une erreur SQL.
 *  - reprog_moteurs : 24 693 lignes de référentiel automobile, mutualisé entre tous
 *    les clients. C'est un actif produit, pas une fuite.
 *  - tenants : la table des clients elle-même ; sa clé est `id`, pas `tenant_id`.
 */
const TABLES_SANS_TENANT = new Set(["reprog_moteurs", "tenants"]);

/**
 * Ajoute tenant_id à une ligne ou un tableau de lignes.
 * Lève si une ligne porte déjà un AUTRE tenant_id : c'est toujours un bug de
 * copier-coller, jamais une intention.
 */
function withTenant(rows, tenantId) {
  const apply = (row) => {
    if (!row || typeof row !== "object") {
      throw new Error("db: ligne invalide passée à insert/upsert");
    }
    const existing = row[TENANT_COLUMN];
    if (existing !== undefined && existing !== null && existing !== tenantId) {
      throw new Error(
        `db: refus d'écrire une ligne portant tenant_id=${existing} dans le contexte du client ${tenantId}`
      );
    }
    return { ...row, [TENANT_COLUMN]: tenantId };
  };
  return Array.isArray(rows) ? rows.map(apply) : apply(rows);
}

/**
 * Enveloppe le query builder de Supabase pour une table et un client donnés.
 */
function scopedTable(client, table, tenantId) {
  if (TABLES_SANS_TENANT.has(table)) {
    throw new Error(
      `db: la table « ${table} » n'a pas de colonne ${TENANT_COLUMN}. ` +
      `Utiliser db.unscoped("${table}", "<raison>") si l'accès non cloisonné est voulu.`
    );
  }

  const real = client.from(table);

  return {
    select(...args) {
      return real.select(...args).eq(TENANT_COLUMN, tenantId);
    },
    update(values, options) {
      // On ne réécrit pas tenant_id sur un update : une ligne ne change jamais de
      // propriétaire. Le filtre suffit, et il est obligatoire.
      return real.update(values, options).eq(TENANT_COLUMN, tenantId);
    },
    delete(options) {
      return real.delete(options).eq(TENANT_COLUMN, tenantId);
    },
    insert(rows, options) {
      return real.insert(withTenant(rows, tenantId), options);
    },
    upsert(rows, options) {
      return real.upsert(withTenant(rows, tenantId), options);
    },
  };
}

/**
 * @param {object} client - client Supabase (createClient(...))
 * @returns {{ tenant: Function, unscoped: Function, rpc: Function, raw: object }}
 */
function createDb(client) {
  if (!client || typeof client.from !== "function") {
    throw new Error("createDb: client Supabase attendu");
  }

  return {
    /**
     * Contexte cloisonné sur un client. C'est la porte d'entrée normale.
     * @param {string} tenantId
     */
    tenant(tenantId) {
      if (!tenantId || typeof tenantId !== "string") {
        throw new Error("db.tenant(): tenantId manquant — aucune requête ne peut être cloisonnée");
      }
      return {
        tenantId,
        from: (table) => scopedTable(client, table, tenantId),
        /**
         * Appel de fonction Postgres, avec p_tenant_id injecté automatiquement.
         * Sert surtout le RAG (match_kb_chunks), où l'oubli du filtre ferait
         * répondre le bot d'un commerce avec la base de connaissances d'un autre.
         */
        rpc: (fn, params = {}) => client.rpc(fn, { p_tenant_id: tenantId, ...params }),
      };
    },

    /**
     * Échappatoire explicite, pour les tables sans cloisonnement (référentiel partagé)
     * et pour les requêtes de plateforme qui s'exécutent AVANT de connaître le client
     * (résolution du numéro entrant, par exemple).
     *
     * La raison est obligatoire : elle est lue en revue de code, et rend chaque
     * contournement visible par un simple grep.
     *
     * @param {string} table
     * @param {string} raison
     */
    unscoped(table, raison) {
      if (!raison || typeof raison !== "string" || raison.trim().length < 5) {
        throw new Error(
          `db.unscoped("${table}"): une raison explicite est obligatoire ` +
          `(ex: "résolution du tenant depuis phone_number_id")`
        );
      }
      return client.from(table);
    },

    /** RPC de plateforme, hors contexte client. */
    rpc: (fn, params) => client.rpc(fn, params),

    /**
     * Client brut. Réservé aux migrations et aux scripts d'administration.
     * Ne jamais l'utiliser dans le chemin d'une requête entrante.
     */
    raw: client,
  };
}

module.exports = { createDb, withTenant, TENANT_COLUMN, TABLES_SANS_TENANT };
