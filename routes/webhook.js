const { extractInboundText, extractInteractiveId, isGreetingOrReset } = require("../lib/text-helpers");
const { parseRoutingInstruction, createInitialStateFromRoute, isRoutingSafe } = require("../lib/intent-router");
const { extractProfileSignals, updateClientProfile } = require("../lib/conversation-memory");

/**
 * Factory: creates the webhook POST route handler.
 * @param {object} ctx - All dependencies from server.js
 * @returns {Function} Express route handler for POST /webhook
 */
function createWebhookHandler(ctx) {
  const {
    supabase, log,
    verifyMetaSignature,
    // WhatsApp send functions
    sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppLocation,
    markAsRead, sendTypingIndicator,
    // Conversation helpers
    getConversationState, setConversationState, clearConversationState,
    getOrCreateConversation, insertInboundMessage, resetConversationContext,
    // Menu & notifications
    sendMenuList, DIAGPERF_LOCATION,
    // Voice
    handleVoiceMessage, VOICE_TYPES, getErrorMessage, GROQ_API_KEY,
    WA_API_VERSION, fetchFn,
    // Non-text
    NON_TEXT_TYPES, NON_TEXT_COOLDOWN_MS, getNonTextCooldown, setNonTextCooldown,
    // Handlers
    handleGarageDoneCommand, handleReviewRating,
    handleEscalationButtons, handleFrustrationEscalation,
    handlePrestationFlow, handleSavFlow,
    // LLM
    askLLM,
  } = ctx;

  return async function webhookPostHandler(req, res) {
    // ✅ répondre vite pour Meta
    res.sendStatus(200);
    log.info("🔥 WEBHOOK HIT", { hasBody: !!req.body });

    const verifyOn =
      (process.env.VERIFY_SIGNATURE || "false").toLowerCase() === "true";
    const sig = verifyMetaSignature(req);

    if (verifyOn && !sig.ok) {
      log.warn("Signature invalide", { reason: sig.reason });
      return;
    }

    try {
      const body = req.body;
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      if (!value) return;

      // 1) Messages entrants
      const messages = value.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        for (const msg of messages) {
          const fromWa = msg.from;
          const waMessageId = msg.id;
          const timestamp = msg.timestamp;
          let text = extractInboundText(msg);

          // ✅ Mark message as read (blue ticks) + typing indicator
          markAsRead(waMessageId).catch(() => {});
          sendTypingIndicator(fromWa).catch(() => {});

          // Map interactive list menu selections to menu numbers for detectIntent
          const listId = msg.interactive?.list_reply?.id || null;
          if (listId) {
            const listIdToMenu = {
              "menu_1": "1", "menu_2": "2", "menu_3": "3", "menu_4": "4",
              "menu_5": "5", "menu_6": "6", "menu_7": "7", "menu_8": "8",
            };
            if (listIdToMenu[listId]) {
              text = listIdToMenu[listId];
            }
          }

          // ====== Voice/audio messages → transcription Whisper (via voice-handler) ======
          if (VOICE_TYPES.has(msg.type) && GROQ_API_KEY) {
            try {
              const voiceResult = await handleVoiceMessage(
                msg,
                process.env.WHATSAPP_TOKEN,
                WA_API_VERSION,
                fetchFn
              );

              if (voiceResult && voiceResult.rawText) {
                log.info("Voice processed successfully", {
                  wa_id: fromWa,
                  chars: voiceResult.rawText.length,
                  confidence: voiceResult.metadata.confidence,
                  language: voiceResult.metadata.language,
                });
                text = voiceResult.llmContext + voiceResult.rawText;
              } else {
                const errorMsg = getErrorMessage(voiceResult?.metadata || { error: "UNKNOWN" });
                log.warn("Voice transcription failed", {
                  wa_id: fromWa,
                  error: voiceResult?.metadata?.error,
                });
                await sendWhatsAppInteractiveButtons(fromWa, errorMsg, [
                  { id: "btn_back_menu", title: "🏠 Menu" },
                ]);
                continue;
              }
            } catch (voiceErr) {
              log.error("Voice processing exception", {
                wa_id: fromWa,
                error: String(voiceErr?.message || voiceErr),
              });
              await sendWhatsAppInteractiveButtons(
                fromWa,
                "🎤 *Message vocal*\n\nJe n'ai pas pu traiter votre message vocal. Pourriez-vous le réécrire en texte ?",
                [{ id: "btn_back_menu", title: "🏠 Menu" }]
              );
              continue;
            }
          }

          // ====== Non-text messages (appels manqués, médias, etc.) ======
          if (NON_TEXT_TYPES.has(msg.type)) {
            const convState = await getConversationState(fromWa);
            if (!convState || !convState.state) {
              const now = Date.now();
              const lastReply = await getNonTextCooldown(fromWa);
              if (now - lastReply < NON_TEXT_COOLDOWN_MS) {
                log.debug("Non-text auto-reply cooldown active, skip", { wa_id: fromWa, type: msg.type });
                continue;
              }
              await setNonTextCooldown(fromWa);
              await sendWhatsAppText(
                fromWa,
                `Toutes nos excuses, nous sommes actuellement indisponibles. 🙏\n\n` +
                `Pour prendre rendez-vous ou obtenir un devis instantané, vous pouvez utiliser notre assistant automatique ci-dessous.\n\n` +
                `Nous vous recontacterons dans les plus brefs délais si nécessaire.`
              );
              await sendMenuList(fromWa, { showLogo: true });
              log.info("Non-text auto-reply sent", { wa_id: fromWa, type: msg.type });
            } else {
              log.debug("Non-text message ignored (flow in progress)", { wa_id: fromWa, type: msg.type, state: convState.state });
            }
            continue;
          }

          // Skip messages with no usable text (e.g. empty text body when user sends nothing)
          if (!text) {
            log.debug("Skipping message with empty text", { wa_id: fromWa, type: msg.type });
            continue;
          }

          const conversationId = await getOrCreateConversation(fromWa);

          const ins = await insertInboundMessage({
            conversationId,
            waMessageId,
            text,
            timestamp,
            raw: body,
          });
          if (!ins.inserted) continue;

          // ✅ Hook : mise à jour profil client (best-effort, non bloquant)
          (async () => {
            try {
              if (!text) return;
              const cs = await getConversationState(fromWa).catch(() => null);
              const patch = extractProfileSignals(text, null, {
                vehicleFromState: cs?.data?.vehicle || null,
                plateFromState: cs?.data?.plate || null,
                customerName: cs?.data?.customer_name || null,
                customerEmail: cs?.data?.customer_email || null,
              });
              await updateClientProfile(supabase, fromWa, patch);
            } catch (err) {
              log.debug("updateClientProfile hook failed", { wa_id: fromWa, error: String(err?.message || err) });
            }
          })();

          // ✅ Bouton "Menu" global
          const btnId = msg.interactive?.button_reply?.id || null;
          if (btnId === "btn_back_menu") {
            await resetConversationContext(conversationId);
            await clearConversationState(fromWa);
            await sendMenuList(fromWa);
            continue;
          }

          // ✅ reset/menu (clear both conversation contexts)
          if (isGreetingOrReset(text)) {
            await resetConversationContext(conversationId);
            await clearConversationState(fromWa);
            await sendMenuList(fromWa, { showLogo: true });
            continue;
          }

          // ✅ Commande garage "DONE [plaque]" → créer demande d'avis
          const doneHandled = await handleGarageDoneCommand(fromWa, text);
          if (doneHandled) continue;

          // ✅ Flow avis client (réponse à la demande de notation)
          const reviewHandled = await handleReviewRating(fromWa, text, msg);
          if (reviewHandled) continue;

          // ✅ Boutons d'escalade humaine (callback / continuer)
          const escalateBtnHandled = await handleEscalationButtons(fromWa, text, msg);
          if (escalateBtnHandled) continue;

          // ✅ Détection frustration / urgence → escalade humaine
          const frustrationHandled = await handleFrustrationEscalation(fromWa, text, msg);
          if (frustrationHandled) continue;

          // ✅ Flow prestations 1-7 (conversation_state table)
          const prestaHandled = await handlePrestationFlow(fromWa, text, msg);
          if (prestaHandled) continue;

          // ✅ Flow SAV 8 (conversation_state table)
          const savHandled = await handleSavFlow(fromWa, text, msg);
          if (savHandled) continue;

          // ✅ LLM fallback : interprétation intelligente — toujours actif
          try {
            const llmResult = await askLLM(text, fromWa);
            if (llmResult) {
              // Cas 1 & 4 : intent ou routing avancé détecté → re-router vers le bon flow
              let routeInstruction = parseRoutingInstruction(llmResult);
              if (routeInstruction) {
                // Safety: only apply advanced routing when LLM is confident enough.
                // Threshold configurable via env LLM_ROUTING_MIN_CONF (default 0.9).
                const minRoutingConf = parseFloat(process.env.LLM_ROUTING_MIN_CONF || "0.9");
                if (routeInstruction.type === "route" && !isRoutingSafe(routeInstruction, minRoutingConf)) {
                  log.warn("LLM routing ignored due to low confidence", { wa_id: fromWa, intent: routeInstruction.intent, target: routeInstruction.target, confidence: routeInstruction.confidence, threshold: minRoutingConf });
                  // ignore advanced routing instruction so we fall back to safer branches
                  routeInstruction = null;
                }
                // Si c'est un routing avancé avec état cible et data → créer l'état directement
                if (routeInstruction && routeInstruction.type === "route" && routeInstruction.target) {
                  const initialState = createInitialStateFromRoute(routeInstruction);
                  await setConversationState(fromWa, initialState);
                  log.info("LLM → routing avancé", { wa_id: fromWa, intent: routeInstruction.intent, target: routeInstruction.target, confidence: routeInstruction.confidence });

                  // Dispatcher vers le bon handler selon l'intent
                  const prestaRetry = await handlePrestationFlow(fromWa, text, msg);
                  if (prestaRetry) continue;
                  const savRetry = await handleSavFlow(fromWa, text, msg);
                  if (savRetry) continue;
                }

                // Fallback: routing legacy (type=intent) → mapping menu
                if (llmResult.type === "intent" && llmResult.intent) {
                  const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
                  const mappedText = menuMap[llmResult.intent];
                  if (mappedText) {
                    log.info("LLM → intent détecté, re-routing", { wa_id: fromWa, intent: llmResult.intent });
                    const prestaRetry = await handlePrestationFlow(fromWa, mappedText, msg);
                    if (prestaRetry) continue;
                    const savRetry = await handleSavFlow(fromWa, mappedText, msg);
                    if (savRetry) continue;
                  }
                }
              }

              // Cas 2 : question → texte simple, conversation libre sans bouton Menu
              if (llmResult.type === "answer" && llmResult.message) {
                log.info("LLM → réponse FAQ", { wa_id: fromWa, msgLen: llmResult.message.length });
                await sendWhatsAppText(fromWa, llmResult.message);
                if (llmResult.sendLocation) {
                  // Envoyer le lien Google Maps cliquable si absent du message LLM
                  const mapsUrl = `https://maps.google.com/?q=${DIAGPERF_LOCATION.latitude},${DIAGPERF_LOCATION.longitude}`;
                  if (!llmResult.message.includes("maps.google.com")) {
                    await sendWhatsAppText(fromWa, `📍 *Google Maps :* ${mapsUrl}`);
                  }
                  sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => {
                    log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) });
                  });
                }
                continue;
              }
            }
          } catch (llmErr) {
            log.error("LLM fallback error", { wa_id: fromWa, error: String(llmErr?.message || llmErr) });
          }

          // fallback final → le LLM a échoué (erreur réseau, parse, rate limit) → clarification sans menu
          await sendWhatsAppText(
            fromWa,
            "Je n'ai pas bien saisi votre message 🤔 Pourriez-vous me donner un peu plus de détails ? Par exemple, s'agit-il d'un problème sur votre véhicule, d'un tarif, ou d'autre chose ?"
          );
        }
        return;
      }

      // 2) Statuts
      const statuses = value.statuses;
      if (Array.isArray(statuses) && statuses.length > 0) {
        for (const st of statuses) {
          log.debug("Status reçu", { id: st.id, status: st.status, recipient_id: st.recipient_id });
        }
        return;
      }
    } catch (err) {
      log.error("Erreur traitement webhook", { error: String(err?.message || err), stack: err?.stack });
    }
  };
}

module.exports = { createWebhookHandler };
