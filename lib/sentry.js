/**
 * lib/sentry.js — Init Sentry conditionnel (no-op si SENTRY_DSN absent).
 *
 * Sentry v10 auto-capture uncaughtException + unhandledRejection dès l'init.
 * À importer/initier le plus tôt possible dans server.js pour profiter de
 * l'auto-instrumentation.
 */

let _enabled = false;
let _Sentry = null;

function initSentry({ log } = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (log) log.info("Sentry désactivé (SENTRY_DSN absent)");
    return { enabled: false };
  }

  try {
    _Sentry = require("@sentry/node");
    _Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "production",
      release: process.env.RENDER_GIT_COMMIT || undefined,
      tracesSampleRate: 0,        // pas de perf APM (gratuit-friendly)
      sendDefaultPii: false,
    });
    _enabled = true;
    if (log) log.info("Sentry initialisé", { environment: process.env.NODE_ENV || "production" });
    return { enabled: true, Sentry: _Sentry };
  } catch (err) {
    if (log) log.warn("Sentry init failed", { error: String(err?.message || err) });
    return { enabled: false };
  }
}

function captureException(err, context) {
  if (!_enabled || !_Sentry) return;
  try {
    if (context) _Sentry.captureException(err, { extra: context });
    else _Sentry.captureException(err);
  } catch (_) {}
}

function setupExpressErrorHandler(app) {
  if (!_enabled || !_Sentry) return;
  try {
    if (typeof _Sentry.setupExpressErrorHandler === "function") {
      _Sentry.setupExpressErrorHandler(app);
    }
  } catch (_) {}
}

module.exports = { initSentry, captureException, setupExpressErrorHandler };
