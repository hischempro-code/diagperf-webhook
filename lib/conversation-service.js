let _log, _supabase;

const CONV_STATE_TTL_MS = 2 * 60 * 60 * 1000; // 2 heures

function initConversationService({ log, supabase }) {
  _log = log;
  _supabase = supabase;
}

async function getConversationState(waId) {
  const { data, error } = await _supabase
    .from("conversation_state")
    .select("*")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  if (data.updated_at) {
    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > CONV_STATE_TTL_MS) {
      _log.info("Conversation state expired (TTL)", { wa_id: waId, state: data.state, ageMin: Math.round(age / 60000) });
      await clearConversationState(waId);
      return null;
    }
  }

  return data;
}

async function setConversationState(waId, state, intent, data) {
  const { error } = await _supabase
    .from("conversation_state")
    .upsert(
      { wa_id: waId, state, intent, data: data || {}, updated_at: new Date().toISOString() },
      { onConflict: "wa_id" }
    );
  if (error) throw error;
}

async function clearConversationState(waId) {
  const { error } = await _supabase.from("conversation_state").delete().eq("wa_id", waId);
  if (error) throw error;
}

async function getRecentMessages(waId, limit = 6) {
  try {
    const { data: conv } = await _supabase
      .from("conversations")
      .select("id")
      .eq("wa_phone", waId)
      .maybeSingle();

    if (!conv?.id) return [];

    const { data: msgs, error } = await _supabase
      .from("messages")
      .select("direction, body, ts")
      .eq("conversation_id", conv.id)
      .order("ts", { ascending: false })
      .limit(limit);

    if (error || !msgs) return [];

    return msgs
      .reverse()
      .filter(m => m.body && m.body.trim())
      .map(m => ({
        role: m.direction === "in" ? "user" : "assistant",
        content: m.body.trim().slice(0, 800),
      }));
  } catch (err) {
    _log.warn("getRecentMessages failed", { wa_id: waId, error: String(err?.message || err) });
    return [];
  }
}

module.exports = {
  initConversationService,
  getConversationState,
  setConversationState,
  clearConversationState,
  getRecentMessages,
};
