let _supabase, _log, _sendWhatsAppText;

const PRESTA_LABELS = {
  reprogrammation: "Reprogrammation moteur",
  conversion_e85: "Conversion E85",
  suppression_fap: "Suppression FAP",
  suppression_egr: "Suppression EGR",
  suppression_adblue: "Suppression AdBlue",
  diagnostic_complet: "Diagnostic auto",
};

function initRelanceService({ supabase, log, sendWhatsAppText }) {
  _supabase = supabase;
  _log = log;
  _sendWhatsAppText = sendWhatsAppText;
}

async function runRelances() {
  try {
    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: devis, error } = await _supabase
      .from("devis")
      .select("id, wa_id, plaque, prestation_code, total_ttc_centimes, customer_name")
      .eq("statut", "draft")
      .lt("created_at", threshold)
      .is("relance_sent_at", null)
      .not("wa_id", "is", null)
      .limit(20);

    if (error) { _log.warn("runRelances: erreur requête", { error: String(error.message) }); return; }
    if (!devis?.length) return;

    _log.info("Relance: devis éligibles", { count: devis.length });

    for (const d of devis) {
      try {
        const tokens = (d.customer_name || "").trim().split(/\s+/);
        const prenom = tokens.length > 1 ? tokens.slice(1).join(" ") : tokens[0];
        const greeting = prenom ? `Bonjour *${prenom}* 👋` : "Bonjour 👋";
        const prestaLabel = PRESTA_LABELS[d.prestation_code] || "votre prestation";
        const prixTxt = typeof d.total_ttc_centimes === "number"
          ? ` (*${(d.total_ttc_centimes / 100).toFixed(0)}€ TTC*)`
          : "";
        const plaqueTxt = d.plaque ? ` pour votre véhicule *${d.plaque}*` : "";

        const msg = [
          greeting,
          "",
          `Votre devis *DEV-${d.id}* pour une *${prestaLabel}*${prixTxt}${plaqueTxt} est toujours disponible. ⏳`,
          "",
          "Des questions avant de vous décider ? Notre équipe est là 🔧",
          "📞 *06 75 54 70 85*",
        ].join("\n");

        await _sendWhatsAppText(d.wa_id, msg);
        await _supabase.from("devis").update({ relance_sent_at: new Date().toISOString() }).eq("id", d.id);
        _log.info("Relance envoyée", { devisId: d.id, wa_id: d.wa_id });

        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        const emsg = String(err?.message || err);
        // Fenêtre 24h WhatsApp fermée (erreur Meta 131047) : un client silencieux depuis
        // >24h ne peut PAS recevoir de texte libre — il faut un template approuvé.
        // Sans ce garde, la relance échouée était retentée toutes les heures pour toujours.
        if (emsg.includes("131047") || /re-?engagement/i.test(emsg)) {
          await _supabase.from("devis").update({ relance_sent_at: new Date().toISOString() }).eq("id", d.id);
          _log.warn("Relance hors fenêtre 24h — abandonnée (nécessite un template Meta approuvé)", { devisId: d.id, wa_id: d.wa_id });
        } else {
          _log.error("Relance échouée", { devisId: d.id, error: emsg });
        }
      }
    }
  } catch (err) {
    _log.error("runRelances crash", { error: String(err?.message || err) });
  }
}

module.exports = { initRelanceService, runRelances };
