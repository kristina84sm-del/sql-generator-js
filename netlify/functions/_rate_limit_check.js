// Лимиты: почасовой по числу запросов + дневной по токенам OpenAI (дефолт 100k).
// Используется во всех функциях, которые тратят токены OpenAI.

const { Pool } = require("pg");
const { trackError, isTransientDbError } = require("./_log");
const { dbConfig } = require("./_db");

const pool = new Pool(dbConfig());
pool.on("error", (err) => {
  trackError("rate_limit_pool", err);
});

/** Глобальный дефолт: 100_000 токенов / 24ч. Env DAILY_TOKEN_LIMIT (0 = выключить). */
function defaultDailyTokenLimit() {
  const fromEnv = Number(process.env.DAILY_TOKEN_LIMIT);
  if (Number.isFinite(fromEnv)) return Math.max(0, Math.floor(fromEnv));
  return 100000;
}

/**
 * Персональный лимит токенов.
 * NULL/undefined → дефолт; 0 → безлимит; >0 → своё значение.
 */
function resolveDailyTokenLimit(userLimit) {
  if (userLimit === null || userLimit === undefined) return defaultDailyTokenLimit();
  const n = Number(userLimit);
  if (!Number.isFinite(n) || n < 0) return defaultDailyTokenLimit();
  return Math.floor(n);
}

/**
 * Токены за 24ч: если в request_log уже есть записи с tokens_used > 0 — берём их
 * (серверный учёт после деплоя лимита). Иначе — query_history (как раньше считали в UI).
 * Так не показываем 0 при реальном расходе из истории.
 */
async function getTokensUsed24h(userId, db) {
  const q = db && typeof db.query === "function" ? db : pool;
  try {
    const { rows: rl } = await q.query(
      `SELECT COALESCE(SUM(tokens_used), 0)::bigint AS sum_tokens,
              COUNT(*) FILTER (WHERE tokens_used IS NOT NULL AND tokens_used > 0)::int AS with_tok
       FROM request_log
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    if (parseInt(rl[0]?.with_tok || 0, 10) > 0) {
      return parseInt(rl[0].sum_tokens || 0, 10);
    }
  } catch (e) {
    if (!e || e.code !== "42703") throw e;
  }

  const { rows: qh } = await q.query(
    `SELECT COALESCE(SUM(tokens_used), 0)::bigint AS sum_tokens
     FROM query_history
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return parseInt(qh[0]?.sum_tokens || 0, 10);
}

/**
 * @param {string} userId - ID пользователя из JWT (auth.user.sub)
 * @returns {Promise<{ok: boolean, error?: string, remaining?: number, tokens_used_24h?: number, token_limit?: number}>}
 */
async function checkRateLimit(userId) {
  try {
    // Почасовой потолок по request_log (все OpenAI-эндпоинты в одном бакете).
    const hourlyCap = Number(process.env.RATE_HOURLY_LIMIT);
    const hourly = Number.isFinite(hourlyCap) ? hourlyCap : 20;
    if (hourly > 0) {
      const { rows: hourRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM request_log
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [userId]
      );
      const usedHour = parseInt(hourRows[0]?.cnt || 0, 10);
      if (usedHour >= hourly) {
        return {
          ok: false,
          error: `Превышен лимит запросов (${hourly}/час). Подождите или обратитесь к администратору.`,
        };
      }
    }

    const { rows } = await pool.query(
      "SELECT daily_request_limit, daily_token_limit FROM users WHERE id = $1",
      [userId]
    );
    const row = rows[0] || {};
    const reqLimit = row.daily_request_limit;

    // Дневной лимит запросов (если задан админом) — как раньше
    if (reqLimit !== null && reqLimit !== undefined) {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM query_history
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId]
      );
      const used = parseInt(countRows[0]?.cnt || 0, 10);
      if (used >= reqLimit) {
        return {
          ok: false,
          error: `Превышен дневной лимит запросов (${reqLimit}/день). Лимит обновится через 24 часа, либо обратитесь к администратору.`,
        };
      }
    }

    // Дневной лимит токенов (по умолчанию 100k для всех)
    const tokenLimit = resolveDailyTokenLimit(row.daily_token_limit);
    if (tokenLimit > 0) {
      const usedTokens = await getTokensUsed24h(userId);

      if (usedTokens >= tokenLimit) {
        return {
          ok: false,
          error: `Превышен дневной лимит токенов (${tokenLimit.toLocaleString("ru")} / 24ч). Уже использовано ${usedTokens.toLocaleString("ru")}. Подождите или обратитесь к администратору.`,
          tokens_used_24h: usedTokens,
          token_limit: tokenLimit,
        };
      }
      return {
        ok: true,
        remaining: tokenLimit - usedTokens,
        tokens_used_24h: usedTokens,
        token_limit: tokenLimit,
      };
    }

    return { ok: true };
  } catch (e) {
    trackError("checkRateLimit", e);
    if (isTransientDbError(e)) return { ok: true };
    // Если нет колонки daily_token_limit — не валим сервис
    if (e && e.code === "42703") return { ok: true };
    return { ok: true };
  }
}

module.exports = {
  checkRateLimit,
  defaultDailyTokenLimit,
  resolveDailyTokenLimit,
  getTokensUsed24h,
};
