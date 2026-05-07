/**
 * logger.js — Logger structuré centralisé
 * Zéro dépendance externe
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || "info"] ?? LOG_LEVELS.info;

const log = {
  _fmt(level, msg, meta) {
    const ts = new Date().toISOString();
    const prefix = meta?.wa_id ? `[${meta.wa_id}]` : "";
    const extra = meta ? ` ${JSON.stringify(meta)}` : "";
    return `${ts} ${level.toUpperCase()} ${prefix} ${msg}${extra}`;
  },
  debug(msg, meta) { if (LOG_LEVEL <= 0) console.debug(this._fmt("debug", msg, meta)); },
  info(msg, meta)  { if (LOG_LEVEL <= 1) console.log(this._fmt("info", msg, meta)); },
  warn(msg, meta)  { if (LOG_LEVEL <= 2) console.warn(this._fmt("warn", msg, meta)); },
  error(msg, meta) { if (LOG_LEVEL <= 3) console.error(this._fmt("error", msg, meta)); },
};

module.exports = { log, LOG_LEVELS };
