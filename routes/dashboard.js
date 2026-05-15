const express = require("express");

/**
 * Dashboard & Client API routes.
 * @param {{ supabase: import("@supabase/supabase-js").SupabaseClient, log: object, sgMail: object, broadcastDashboardEvent: Function }} deps
 * @returns {{ router: express.Router, broadcastDashboardEvent: Function, sseClients: Set }}
 */
function createDashboardRouter({ supabase, log, sgMail }) {
  const router = express.Router();

  // ====== SSE real-time notifications for dashboard ======
  const sseClients = new Set();

  router.get("/api/dashboard/events", (req, res) => {
    const token = req.query.token;
    if (token !== (process.env.DASHBOARD_TOKEN || "diagperf_admin_2026")) return res.status(401).end();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // keepalive comment
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  function broadcastDashboardEvent(type, data) {
    const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch (_) { sseClients.delete(client); }
    }
  }

  // ====== Dashboard auth middleware ======
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "diagperf_admin_2026";

  function requireDashboardAuth(req, res, next) {
    const token = req.query.token || req.headers["x-dashboard-token"];
    if (token !== DASHBOARD_TOKEN) return res.status(401).json({ error: "Non autorisé" });
    next();
  }

  // ====== Client PWA API (public, auth by wa_id hash) ======
  // Auth helper : vérifie le PIN (client_pins en priorité, fallback 4 derniers chiffres)
  async function checkClientPin(wa, pin) {
    let validPin = wa.replace(/\D/g, "").slice(-4);
    try {
      const { data, error } = await supabase.from("client_pins").select("pin").eq("wa_id", wa).maybeSingle();
      if (error) throw error; // table inexistante → catch → reste sur last-4
      if (data?.pin) validPin = data.pin;
    } catch {}
    return pin === validPin;
  }

  router.get("/api/client/devis", async (req, res) => {
    try {
      const wa = req.query.wa;
      const pin = req.query.pin;
      if (!wa || !pin) return res.status(400).json({ error: "wa et pin requis" });
      if (!(await checkClientPin(wa, pin))) return res.status(401).json({ error: "PIN incorrect" });

      const { data: devis, error } = await supabase
        .from("devis")
        .select("id, plaque, prestation_code, total_ttc_centimes, total_ht_centimes, statut, rdv_date, created_at")
        .eq("wa_id", wa)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;

      res.json({ devis: devis || [] });
    } catch (err) {
      log.error("Client API error", { error: String(err?.message || err) });
      res.status(500).json({ error: "Erreur" });
    }
  });

  router.patch("/api/client/devis/:id", express.json(), async (req, res) => {
    try {
      const wa = req.body.wa;
      const pin = req.body.pin;
      const statut = req.body.statut;
      if (!wa || !pin) return res.status(400).json({ error: "wa et pin requis" });
      if (!(await checkClientPin(wa, pin))) return res.status(401).json({ error: "PIN incorrect" });
      if (!["sent", "refused", "completed"].includes(statut)) return res.status(400).json({ error: "Statut invalide" });

      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "ID invalide" });

      // Verify the devis belongs to this client
      const { data: devis, error: fetchErr } = await supabase
        .from("devis")
        .select("id, wa_id, statut")
        .eq("id", id)
        .eq("wa_id", wa)
        .single();
      if (fetchErr || !devis) return res.status(404).json({ error: "Devis non trouvé" });
      if (devis.statut !== "draft") return res.status(400).json({ error: "Ce devis ne peut plus être modifié" });

      const { error: updateErr } = await supabase.from("devis").update({ statut }).eq("id", id);
      if (updateErr) throw updateErr;

      // Broadcast to admin dashboard
      const eventType = statut === "sent" ? "devis_confirmed" : "devis_refused";
      broadcastDashboardEvent(eventType, { devisId: id, wa_id: wa, plate: devis.plaque || "" });

      log.info("Client devis action", { wa_id: wa, devisId: id, statut });
      res.json({ ok: true });
    } catch (err) {
      log.error("Client patch devis error", { error: String(err?.message || err) });
      res.status(500).json({ error: "Erreur" });
    }
  });

  // ====== Dashboard admin API ======
  router.get("/api/dashboard/stats", requireDashboardAuth, async (_req, res) => {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      // Devis totaux + aujourd'hui + semaine + mois
      const [allDevis, todayDevis, weekDevis, monthDevis] = await Promise.all([
        supabase.from("devis").select("id", { count: "exact", head: true }),
        supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", todayStart),
        supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", weekStart),
        supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", monthStart),
      ]);

      // Chiffre d'affaires (somme TTC)
      const { data: revenueData } = await supabase
        .from("devis")
        .select("total_ttc_centimes, created_at");

      let revenueTotalCents = 0, revenueMonthCents = 0, revenueWeekCents = 0, revenueTodayCents = 0;
      const dailyRevenue = {};
      const dailyDevisCount = {};
      const prestationCounts = {};

      // Devis avec prestation_code pour le breakdown
      const { data: allDevisData } = await supabase
        .from("devis")
        .select("total_ttc_centimes, created_at, prestation_code, statut");

      for (const d of (allDevisData || [])) {
        const ttc = d.total_ttc_centimes || 0;
        revenueTotalCents += ttc;

        const createdAt = d.created_at;
        if (createdAt >= monthStart) revenueMonthCents += ttc;
        if (createdAt >= weekStart) revenueWeekCents += ttc;
        if (createdAt >= todayStart) revenueTodayCents += ttc;

        // Daily aggregation (last 30 days)
        const day = createdAt?.substring(0, 10);
        if (day) {
          dailyRevenue[day] = (dailyRevenue[day] || 0) + ttc;
          dailyDevisCount[day] = (dailyDevisCount[day] || 0) + 1;
        }

        // Prestation breakdown
        const code = d.prestation_code || "autre";
        prestationCounts[code] = (prestationCounts[code] || 0) + 1;
      }

      // Conversations totales
      const { count: totalConversations } = await supabase
        .from("conversations").select("id", { count: "exact", head: true });

      // Messages aujourd'hui
      const { count: todayMessages } = await supabase
        .from("messages").select("id", { count: "exact", head: true }).gte("ts", todayStart);

      // Avis clients
      const { data: reviews } = await supabase
        .from("review_requests").select("rating, sent, responded_at");

      const reviewStats = { total: 0, sent: 0, responded: 0, avgRating: 0, ratings: {} };
      let ratingSum = 0, ratingCount = 0;
      for (const r of (reviews || [])) {
        reviewStats.total++;
        if (r.sent) reviewStats.sent++;
        if (r.responded_at) {
          reviewStats.responded++;
          if (r.rating) {
            ratingSum += r.rating;
            ratingCount++;
            reviewStats.ratings[r.rating] = (reviewStats.ratings[r.rating] || 0) + 1;
          }
        }
      }
      reviewStats.avgRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0;

      // Derniers devis (50 pour Kanban complet)
      const { data: recentDevis } = await supabase
        .from("devis")
        .select("id, plaque, prestation_code, total_ttc_centimes, total_ht_centimes, statut, wa_id, created_at, customer_name, customer_email, rdv_date, admin_notes")
        .order("created_at", { ascending: false })
        .limit(50);

      // Monthly revenue breakdown (last 12 months)
      const monthlyRevenue = {};
      const monthlyDepenses = {};
      for (const d of (allDevisData || [])) {
        const m = d.created_at?.substring(0, 7); // YYYY-MM
        if (m) monthlyRevenue[m] = (monthlyRevenue[m] || 0) + (d.total_ttc_centimes || 0);
      }

      // Depenses
      let depensesData = [];
      let totalDepensesCents = 0;
      let monthDepensesCents = 0;
      try {
        const { data: deps } = await supabase
          .from("depenses")
          .select("*")
          .order("date_depense", { ascending: false });
        depensesData = deps || [];
        for (const dep of depensesData) {
          totalDepensesCents += dep.montant_centimes || 0;
          const depMonth = dep.date_depense?.substring(0, 7);
          if (depMonth) monthlyDepenses[depMonth] = (monthlyDepenses[depMonth] || 0) + (dep.montant_centimes || 0);
          if (dep.date_depense >= monthStart.substring(0, 10)) monthDepensesCents += dep.montant_centimes || 0;
        }
      } catch (depErr) {
        log.debug("Depenses table not yet created", { error: String(depErr?.message || depErr) });
      }

      const confirmedCount = (allDevisData || []).filter(d => d.statut === "sent" || d.statut === "completed").length;
      const totalCount = (allDevisData || []).length;
      const conversionRate = totalCount > 0 ? Math.round((confirmedCount / totalCount) * 100) : 0;

      res.json({
        devis: {
          total: allDevis.count || 0,
          today: todayDevis.count || 0,
          week: weekDevis.count || 0,
          month: monthDevis.count || 0,
          conversionRate,
        },
        revenue: {
          total: revenueTotalCents,
          month: revenueMonthCents,
          week: revenueWeekCents,
          today: revenueTodayCents,
        },
        depenses: {
          total: totalDepensesCents,
          month: monthDepensesCents,
        },
        benefice: {
          total: revenueTotalCents - totalDepensesCents,
          month: revenueMonthCents - monthDepensesCents,
        },
        conversations: totalConversations || 0,
        todayMessages: todayMessages || 0,
        reviews: reviewStats,
        prestationBreakdown: prestationCounts,
        monthlyRevenue,
        monthlyDepenses,
        dailyRevenue,
        dailyDevisCount,
        recentDevis: recentDevis || [],
        recentDepenses: depensesData.slice(0, 20),
      });
    } catch (err) {
      log.error("Dashboard stats API error", { error: String(err?.message || err) });
      res.status(500).json({ error: "Erreur interne" });
    }
  });

  // ── CRUD Devis ──
  router.post("/api/dashboard/devis", requireDashboardAuth, express.json(), async (req, res) => {
    try {
      const { plaque, prestation_code, total_ttc_centimes, statut } = req.body;
      if (!plaque || !total_ttc_centimes) return res.status(400).json({ error: "plaque et total_ttc_centimes requis" });
      const tauxTva = 0.20;
      const ttc = Math.round(Number(total_ttc_centimes));
      const ht = Math.round(ttc / (1 + tauxTva));
      const tva = ttc - ht;
      const { data, error } = await supabase.from("devis").insert({
        plaque: String(plaque).toUpperCase().replace(/\s+/g, "-"),
        prestation_code: prestation_code || "autre",
        total_ht_centimes: ht,
        taux_tva: tauxTva,
        total_tva_centimes: tva,
        total_ttc_centimes: ttc,
        statut: statut || "draft",
        source: "dashboard",
      }).select("id").single();
      if (error) throw error;
      res.json({ ok: true, id: data.id });
    } catch (err) {
      log.error("Dashboard create devis error", { error: String(err?.message || err) });
      res.status(500).json({ error: String(err?.message || "Erreur") });
    }
  });

  router.delete("/api/dashboard/devis/:id", requireDashboardAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "ID invalide" });
      // Delete devis_lignes first
      await supabase.from("devis_lignes").delete().eq("devis_id", id);
      const { error } = await supabase.from("devis").delete().eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      log.error("Dashboard delete devis error", { error: String(err?.message || err) });
      res.status(500).json({ error: String(err?.message || "Erreur") });
    }
  });

  router.patch("/api/dashboard/devis/:id", requireDashboardAuth, express.json(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "ID invalide" });
      const updates = {};
      if (req.body.statut) updates.statut = req.body.statut;
      if (req.body.total_ttc_centimes) {
        const ttc = Math.round(Number(req.body.total_ttc_centimes));
        updates.total_ttc_centimes = ttc;
        updates.total_ht_centimes = Math.round(ttc / 1.20);
        updates.total_tva_centimes = ttc - updates.total_ht_centimes;
      }
      if (req.body.admin_notes !== undefined) updates.admin_notes = req.body.admin_notes || null;
      if (req.body.rdv_date !== undefined) updates.rdv_date = req.body.rdv_date || null;
      if (req.body.customer_name !== undefined) updates.customer_name = req.body.customer_name || null;
      if (req.body.customer_email !== undefined) updates.customer_email = req.body.customer_email || null;
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Rien à modifier" });
      const { error } = await supabase.from("devis").update(updates).eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      log.error("Dashboard patch devis error", { error: String(err?.message || err) });
      res.status(500).json({ error: String(err?.message || "Erreur") });
    }
  });

  // ── CRUD Dépenses ──
  router.post("/api/dashboard/depenses", requireDashboardAuth, express.json(), async (req, res) => {
    try {
      const { libelle, montant_centimes, categorie, date_depense, notes } = req.body;
      if (!libelle || !montant_centimes) return res.status(400).json({ error: "libelle et montant requis" });
      const { data, error } = await supabase.from("depenses").insert({
        libelle,
        montant_centimes: Math.round(Number(montant_centimes)),
        categorie: categorie || "autre",
        date_depense: date_depense || new Date().toISOString().substring(0, 10),
        notes: notes || null,
      }).select("id").single();
      if (error) throw error;
      res.json({ ok: true, id: data.id });
    } catch (err) {
      log.error("Dashboard create depense error", { error: String(err?.message || err) });
      res.status(500).json({ error: String(err?.message || "Erreur") });
    }
  });

  router.delete("/api/dashboard/depenses/:id", requireDashboardAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "ID invalide" });
      const { error } = await supabase.from("depenses").delete().eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      log.error("Dashboard delete depense error", { error: String(err?.message || err) });
      res.status(500).json({ error: String(err?.message || "Erreur") });
    }
  });

  // ====== Test email route ======
  router.get("/test-email", async (req, res) => {
    const to = req.query.to;
    if (!to) {
      return res.status(400).json({ error: "Paramètre ?to=email@example.com requis" });
    }
    if (!process.env.SENDGRID_API_KEY) {
      return res.status(503).json({ error: "SENDGRID_API_KEY non configuré" });
    }

    const msg = {
      to,
      from: process.env.SENDGRID_FROM || "noreply@diagperf.com",
      subject: "DiagPerf - Email test",
      text: "Ceci est un email de test envoyé depuis le serveur DiagPerf.",
      html: "<h2>DiagPerf</h2><p>Ceci est un email de test envoyé depuis le serveur DiagPerf.</p>",
    };

    try {
      const [response] = await sgMail.send(msg);
      log.info("test-email: envoi OK", { to, statusCode: response.statusCode });
      return res.json({ success: true, to, statusCode: response.statusCode });
    } catch (err) {
      const body = err?.response?.body || err.message;
      log.error("test-email: échec envoi", { to, error: body });
      return res.status(500).json({ error: "Échec envoi email", details: body });
    }
  });

  return { router, broadcastDashboardEvent, sseClients };
}

module.exports = { createDashboardRouter };
