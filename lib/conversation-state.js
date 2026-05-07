/**
 * conversation-state.js — Gestion de l'état des conversations
 * Utilise Supabase pour persister les états
 */

const { log } = require("./logger");

// Cache in-memory simple (wa_id → state)
const _stateCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function _getKey(waId) {
  return `conv:${waId}`;
}

/**
 * Récupère ou crée une conversation
 */
async function getOrCreateConversation(supabase, waPhone) {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("wa_phone", waPhone)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ wa_phone: waPhone, contexte_json: {} })
    .select("id")
    .single();

  if (error) throw error;
  return created.id;
}

/**
 * Réinitialise le contexte d'une conversation
 */
async function resetConversationContext(supabase, conversationId) {
  const { error } = await supabase
    .from("conversations")
    .update({ contexte_json: {} })
    .eq("id", conversationId);
  if (error) throw error;
}

/**
 * Récupère l'état de conversation depuis le cache ou Supabase
 */
async function getConversationState(supabase, waId) {
  const key = _getKey(waId);
  const cached = _stateCache.get(key);
  
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.state;
  }

  try {
    const { data } = await supabase
      .from("conversation_state")
      .select("state, intent, data, updated_at")
      .eq("wa_id", waId)
      .maybeSingle();

    const state = data || { state: null, intent: null, data: {} };
    _stateCache.set(key, { state, ts: Date.now() });
    return state;
  } catch (err) {
    log.error("getConversationState failed", { wa_id: waId, error: String(err?.message || err) });
    return { state: null, intent: null, data: {} };
  }
}

/**
 * Met à jour l'état de conversation (cache + DB)
 */
async function setConversationState(supabase, waId, stateOrName, intent = null, data = null) {
  let stateName, stateIntent, stateData;

  if (typeof stateOrName === "object") {
    // Mode objet: { state, intent, data }
    stateName = stateOrName.state;
    stateIntent = stateOrName.intent;
    stateData = stateOrName.data || {};
  } else {
    // Mode legacy: (waId, "STATE_NAME", "intent", {...data})
    stateName = stateOrName;
    stateIntent = intent;
    stateData = data || {};
  }

  const payload = {
    wa_id: waId,
    state: stateName,
    intent: stateIntent,
    data: stateData,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("conversation_state")
    .upsert(payload, { onConflict: "wa_id" });

  if (error) {
    log.error("setConversationState failed", { wa_id: waId, error: String(error?.message || error) });
    throw error;
  }

  // Update cache
  const key = _getKey(waId);
  _stateCache.set(key, { state: payload, ts: Date.now() });
}

/**
 * Efface l'état de conversation
 */
async function clearConversationState(supabase, waId) {
  const { error } = await supabase
    .from("conversation_state")
    .delete()
    .eq("wa_id", waId);

  if (error) {
    log.error("clearConversationState failed", { wa_id: waId, error: String(error?.message || error) });
  }

  // Clear cache
  const key = _getKey(waId);
  _stateCache.delete(key);
}

/**
 * Anti-spam pour messages non-texte (cooldown persistant)
 */
async function getNonTextCooldown(supabase, waId) {
  try {
    const convId = await getOrCreateConversation(supabase, waId);
    const { data } = await supabase
      .from("conversations")
      .select("contexte_json")
      .eq("id", convId)
      .single();
    return data?.contexte_json?.last_non_text_reply_at || 0;
  } catch { 
    return 0; 
  }
}

async function setNonTextCooldown(supabase, waId) {
  try {
    const convId = await getOrCreateConversation(supabase, waId);
    const { data } = await supabase
      .from("conversations")
      .select("contexte_json")
      .eq("id", convId)
      .single();
    const ctx = data?.contexte_json || {};
    ctx.last_non_text_reply_at = Date.now();
    await supabase.from("conversations").update({ contexte_json: ctx }).eq("id", convId);
  } catch (err) {
    log.warn("setNonTextCooldown failed", { wa_id: waId, error: String(err?.message || err) });
  }
}

module.exports = {
  getOrCreateConversation,
  resetConversationContext,
  getConversationState,
  setConversationState,
  clearConversationState,
  getNonTextCooldown,
  setNonTextCooldown,
};
