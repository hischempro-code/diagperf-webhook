/**
 * Tests du cloisonnement par client (lib/db.js).
 *
 * C'est LE filet de sécurité du multi-tenant. La clé service_role contourne la RLS :
 * si une requête oublie son filtre tenant_id, le bot d'un commerce répond avec les
 * données d'un autre. Deux niveaux de protection sont testés ici :
 *
 *   1. le wrapper ajoute le filtre / la colonne tout seul, sur toutes les opérations ;
 *   2. un scan du dépôt échoue si un `supabase.from(` réapparaît hors de lib/db.js.
 *
 * Le second test est le plus important des deux : le premier prouve que l'outil marche,
 * le second prouve que personne ne l'a contourné.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createDb, withTenant } = require("../lib/db");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}\n     ${err.message}`); }
}

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

/** Faux client Supabase : enregistre les appels au lieu de parler au réseau. */
function fakeClient() {
  const calls = [];
  const builder = (table) => {
    const chain = {
      _filters: [],
      select(...a) { calls.push({ table, op: "select", args: a, chain }); return chain; },
      insert(rows) { calls.push({ table, op: "insert", rows, chain }); return chain; },
      upsert(rows) { calls.push({ table, op: "upsert", rows, chain }); return chain; },
      update(v) { calls.push({ table, op: "update", values: v, chain }); return chain; },
      delete() { calls.push({ table, op: "delete", chain }); return chain; },
      eq(col, val) { chain._filters.push([col, val]); return chain; },
    };
    return chain;
  };
  return {
    calls,
    from: (t) => builder(t),
    rpc: (fn, params) => { calls.push({ op: "rpc", fn, params }); return Promise.resolve({ data: [] }); },
  };
}

console.log("\n🔒 Le filtre tenant est ajouté automatiquement");
check("select → .eq('tenant_id', …)", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).from("devis").select("*");
  const call = c.calls.at(-1);
  assert.deepStrictEqual(call.chain._filters, [["tenant_id", T1]]);
});
check("update → .eq('tenant_id', …)", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).from("devis").update({ statut: "sent" });
  assert.deepStrictEqual(c.calls.at(-1).chain._filters, [["tenant_id", T1]]);
});
check("delete → .eq('tenant_id', …)", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).from("depenses").delete();
  assert.deepStrictEqual(c.calls.at(-1).chain._filters, [["tenant_id", T1]]);
});
check("insert → tenant_id injecté dans la ligne", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).from("devis").insert({ plaque: "AA-123-BB" });
  assert.deepStrictEqual(c.calls.at(-1).rows, { plaque: "AA-123-BB", tenant_id: T1 });
});
check("insert d'un tableau → tenant_id sur chaque ligne", () => {
  const c = fakeClient();
  createDb(c).tenant(T2).from("devis_lignes").insert([{ libelle: "a" }, { libelle: "b" }]);
  assert.deepStrictEqual(c.calls.at(-1).rows,
    [{ libelle: "a", tenant_id: T2 }, { libelle: "b", tenant_id: T2 }]);
});
check("upsert → tenant_id injecté", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).from("conversation_state").upsert({ wa_id: "336" });
  assert.deepStrictEqual(c.calls.at(-1).rows, { wa_id: "336", tenant_id: T1 });
});
check("rpc → p_tenant_id injecté (filtre du RAG)", () => {
  const c = fakeClient();
  createDb(c).tenant(T1).rpc("match_kb_chunks", { match_count: 8 });
  assert.deepStrictEqual(c.calls.at(-1).params, { p_tenant_id: T1, match_count: 8 });
});

console.log("\n🚫 Ce que le wrapper refuse");
check("db.tenant() sans identifiant → lève", () => {
  const db = createDb(fakeClient());
  assert.throws(() => db.tenant(), /tenantId manquant/);
  assert.throws(() => db.tenant(null), /tenantId manquant/);
  assert.throws(() => db.tenant(""), /tenantId manquant/);
});
check("écrire une ligne portant le tenant_id d'un AUTRE client → lève", () => {
  const db = createDb(fakeClient());
  assert.throws(
    () => db.tenant(T1).from("devis").insert({ plaque: "AA-123-BB", tenant_id: T2 }),
    /refus d'écrire une ligne portant tenant_id/
  );
});
check("réaffirmer le même tenant_id est toléré", () => {
  assert.deepStrictEqual(withTenant({ a: 1, tenant_id: T1 }, T1), { a: 1, tenant_id: T1 });
});
check("cloisonner reprog_moteurs (référentiel partagé) → lève avec la marche à suivre", () => {
  const db = createDb(fakeClient());
  assert.throws(() => db.tenant(T1).from("reprog_moteurs").select("*"), /db\.unscoped/);
});
check("db.unscoped sans raison → lève", () => {
  const db = createDb(fakeClient());
  assert.throws(() => db.unscoped("reprog_moteurs"), /raison explicite est obligatoire/);
  assert.throws(() => db.unscoped("reprog_moteurs", "x"), /raison explicite est obligatoire/);
});
check("db.unscoped avec raison → passe sans filtre", () => {
  const c = fakeClient();
  createDb(c).unscoped("reprog_moteurs", "référentiel automobile mutualisé").select("*");
  assert.deepStrictEqual(c.calls.at(-1).chain._filters, []);
});
check("createDb sans client → lève", () => {
  assert.throws(() => createDb(null), /client Supabase attendu/);
  assert.throws(() => createDb({}), /client Supabase attendu/);
});

console.log("\n🕵️  Personne ne contourne le wrapper");
// Ce test est la vraie protection : il échoue dès qu'un accès direct réapparaît.
// À mesure que les modules migrent vers lib/db.js, on les retire de la liste
// ci-dessous — quand elle est vide, la migration Phase 1 est terminée.
const PAS_ENCORE_MIGRES = new Set([
  "server.js",
  "rag.js",
  "ingest.js",
  "test-rag.js",
  path.join("lib", "conversation-memory.js"),
  path.join("lib", "conversation-service.js"),
  path.join("lib", "devis-service.js"),
  path.join("lib", "event-handlers.js"),
  path.join("lib", "relance-service.js"),
  path.join("lib", "vehicle-service.js"),
  path.join("routes", "dashboard.js"),
  path.join("flows", "prestation.js"),
  path.join("flows", "sav.js"),
]);

function fichiersJs(dir, racine, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "benchmark", "memoire", "Diagperf", "scripts"].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) fichiersJs(abs, racine, acc);
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) acc.push(path.relative(racine, abs));
  }
  return acc;
}

check("aucun `supabase.from(` hors de lib/db.js (hors modules non encore migrés)", () => {
  const racine = path.join(__dirname, "..");
  const coupables = [];
  for (const rel of fichiersJs(racine, racine)) {
    if (rel === path.join("lib", "db.js") || PAS_ENCORE_MIGRES.has(rel)) continue;
    const src = fs.readFileSync(path.join(racine, rel), "utf8");
    if (/\b(?:supabase|_supabase|client)\s*\.\s*from\s*\(/.test(src)) coupables.push(rel);
  }
  assert.deepStrictEqual(coupables, [],
    `accès direct à la base détecté dans :\n       ${coupables.join("\n       ")}\n` +
    `     → passer par db.tenant(tenantId).from(...) (lib/db.js)`);
});

check("la liste des modules non migrés ne contient que des fichiers existants", () => {
  const racine = path.join(__dirname, "..");
  const fantomes = [...PAS_ENCORE_MIGRES].filter((f) => !fs.existsSync(path.join(racine, f)));
  assert.deepStrictEqual(fantomes, [],
    `à retirer de PAS_ENCORE_MIGRES : ${fantomes.join(", ")}`);
});

console.log(`\n${"═".repeat(40)}`);
console.log(`Résultat cloisonnement : ${passed} ✅ / ${failed} ❌`);
console.log(`Modules restant à migrer vers lib/db.js : ${PAS_ENCORE_MIGRES.size}`);
if (failed > 0) process.exit(1);
console.log("Cloisonnement par client : OK ✨");
