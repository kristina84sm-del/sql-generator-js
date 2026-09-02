// Netlify serverless функция: панель администратора
// Статистика по пользователям, управление лимитами запросов
 
const { Pool } = require("pg");
const { checkAuth } = require("./_auth_middleware");
const { dbConfig } = require("./_db");
 
const pool = new Pool(dbConfig());
// Без этого обработчика обрыв простаивающего соединения с БД
// (даже короткий сетевой сбой) роняет ВЕСЬ процесс функции целиком —
// это особенность EventEmitter в node-postgres, а не баг в вашем коде.
pool.on("error", (err) => {
  console.error("admin_panel: unexpected pool error", err);
});
 
const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
 
// Проверяет что вызывающий пользователь — администратор.
// Решение принимается ТОЛЬКО на основе записи в БД, никогда
// на основе данных, присланных с фронта.
async function requireAdmin(userId) {
  const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [userId]);
  return rows.length > 0 && rows[0].is_admin === true;
}
 
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
 
  let auth;
  try {
    auth = await checkAuth(event);
  } catch (e) {
    console.error("admin_panel checkAuth error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Ошибка авторизации: " + e.message }) };
  }
  if (!auth.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: auth.error }) };
 
  let isAdmin;
  try {
    isAdmin = await requireAdmin(auth.user.sub);
  } catch (e) {
    console.error("admin_panel requireAdmin error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Ошибка проверки прав: " + e.message }) };
  }
  if (!isAdmin) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: "Доступ только для администраторов." }) };
  }
 
  const action = (event.queryStringParameters || {}).action || "";
 
  try {
    // ─── СТАТИСТИКА ПО ВСЕМ ПОЛЬЗОВАТЕЛЯМ ───
    if (action === "stats" && event.httpMethod === "GET") {
      const { rows } = await pool.query(`
        SELECT
          u.id,
          u.username,
          u.email,
          u.is_admin,
          u.daily_request_limit,
          COALESCE(today.cnt, 0)  AS requests_today,
          COALESCE(week.cnt, 0)   AS requests_week,
          COALESCE(total.cnt, 0)  AS requests_total,
          COALESCE(tokens.sum_tokens, 0) AS tokens_total
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS cnt FROM query_history
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY user_id
        ) today ON today.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS cnt FROM query_history
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY user_id
        ) week ON week.user_id = u.id
       LEFT JOIN (
          SELECT user_id, COUNT(*) AS cnt FROM query_history
          GROUP BY user_id
        ) total ON total.user_id = u.id
        LEFT JOIN (
          SELECT user_id, SUM(tokens_used) AS sum_tokens FROM query_history
          GROUP BY user_id
        ) tokens ON tokens.user_id = u.id
        ORDER BY requests_today DESC, requests_week DESC
      `);
 
      // Сводка по всему приложению за сегодня — для общей карточки
      const { rows: summaryRows } = await pool.query(`
        SELECT COUNT(*) AS total_today
        FROM query_history
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `);
 
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          users: rows,
          total_requests_today: parseInt(summaryRows[0]?.total_today || 0, 10),
        }),
      };
    }
 
    // ─── УСТАНОВИТЬ ЛИМИТ ОДНОМУ ИЛИ ВСЕМ ПОЛЬЗОВАТЕЛЯМ ───
    if (action === "set_limit" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const targetUserId = body.user_id;          // конкретный пользователь
      const applyToAll = body.apply_to_all === true; // или массово всем
      let limit = body.limit;                      // число или null (=безлимит)
 
      if (limit !== null && limit !== undefined) {
        limit = parseInt(limit, 10);
        if (isNaN(limit) || limit < 0) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Некорректное значение лимита." }) };
        }
      } else {
        limit = null;
      }
 
      if (applyToAll) {
        await pool.query("UPDATE users SET daily_request_limit = $1", [limit]);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, applied: "all" }) };
      }
 
      if (!targetUserId) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Не передан user_id." }) };
      }
      await pool.query("UPDATE users SET daily_request_limit = $1 WHERE id = $2", [limit, targetUserId]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, applied: targetUserId }) };
    }
 
    // ─── НАЗНАЧИТЬ / СНЯТЬ ПРАВА АДМИНИСТРАТОРА ───
    if (action === "set_admin" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const targetUserId = body.user_id;
      const makeAdmin = body.is_admin === true;
      if (!targetUserId) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Не передан user_id." }) };
      }
      // Защита от случайного самопонижения последнего админа —
      // не даём убрать права у самого себя, если это единственный админ
      if (targetUserId === auth.user.sub && !makeAdmin) {
        const { rows: adminCount } = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE is_admin = TRUE");
        if (parseInt(adminCount[0].cnt, 10) <= 1) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Нельзя снять права с последнего администратора." }) };
        }
      }
      await pool.query("UPDATE users SET is_admin = $1 WHERE id = $2", [makeAdmin, targetUserId]);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }
 
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Неизвестное действие." }) };
  } catch (e) {
    console.error("admin_panel error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Ошибка сервера: " + e.message }) };
  }
};