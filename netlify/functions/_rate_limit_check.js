// Общий хелпер лимита запросов (дневной на пользователя + почасовой потолок).
// Используется во всех функциях, которые тратят токены OpenAI.

const { Pool } = require("pg");
const { trackError, isTransientDbError } = require("./_log");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000),
});
pool.on("error", (err) => {
  trackError("rate_limit_pool", err);
});

/**
 * @param {string} userId - ID пользователя из JWT (auth.user.sub)
 * @returns {Promise<{ok: boolean, error?: string, remaining?: number}>}
 */
async function checkRateLimit(userId) {
  try {
    const hourlyCap = Number(process.env.RATE_HOURLY_LIMIT);
    const hourly = Number.isFinite(hourlyCap) ? hourlyCap : 25;
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
      "SELECT daily_request_limit FROM users WHERE id = $1",
      [userId]
    );
    const limit = rows[0]?.daily_request_limit;

    if (limit === null || limit === undefined) {
      return { ok: true };
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM query_history
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId]
    );
    const used = parseInt(countRows[0]?.cnt || 0, 10);

    if (used >= limit) {
      return {
        ok: false,
        error: `Превышен дневной лимит запросов (${limit}/день). Лимит обновится через 24 часа от первого запроса в текущем окне, либо обратитесь к администратору.`,
      };
    }
    return { ok: true, remaining: limit - used };
  } catch (e) {
    trackError("checkRateLimit", e);
    if (isTransientDbError(e)) return { ok: true };
    return { ok: true };
  }
}

module.exports = { checkRateLimit };
