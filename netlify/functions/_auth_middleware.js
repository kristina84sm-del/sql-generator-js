// netlify/functions/_auth_middleware.js
// Проверка JWT + проверка отзыва сессии в БД + логирование запросов
 
const crypto = require("crypto");
const { getClient } = require("./_db");
const { trackError } = require("./_log");
 
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
 
function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = base64url(
      crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest()
    );
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64").toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
 
// Проверяет в БД, не отозвана ли и не истекла ли сессия с данным sid.
// Fail-open: если БД временно недоступна — не блокируем пользователя,
// чтобы сбой инфраструктуры не положил весь сервис целиком.
async function isSessionValid(sid) {
  if (!process.env.DATABASE_URL) return true;
  let client;
  try {
    client = await getClient();
    const { rows } = await client.query(
      "SELECT revoked_at, expires_at FROM auth_sessions WHERE id = $1",
      [sid]
    );
    if (rows.length === 0) return false;
    if (rows[0].revoked_at) return false;
    if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date()) return false;
    return true;
  } catch (e) {
    trackError("isSessionValid", e);
    return true;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
 
async function checkAuth(event) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return { ok: false, error: "JWT_SECRET не задан" };
 
  let token = null;
  const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
  const match = cookieHeader.match(/token=([^;]+)/);
  if (match) token = match[1];
 
  if (!token) {
    const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
    token = authHeader.replace(/^Bearer\s+/i, "").trim();
  }
 
  if (!token) return { ok: false, error: "Требуется авторизация. Войдите в систему." };
 
  const payload = verifyToken(token, jwtSecret);
  if (!payload) return { ok: false, error: "Токен недействителен или истёк. Войдите снова." };
 
  // КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ СТАРОЙ ВЕРСИИ: проверяем, не отозвана ли сессия
  if (payload.sid) {
    const valid = await isSessionValid(payload.sid);
    if (!valid) return { ok: false, error: "Сессия завершена. Войдите снова." };
  }
 
  return { ok: true, user: payload };
}
 
async function logRequest(userId, endpoint, tokensUsed) {
  if (!process.env.DATABASE_URL) return;
  let client;
  try {
    client = await getClient();
    const tokens = tokensUsed == null || tokensUsed === "" ? null : parseInt(tokensUsed, 10);
    const tok = Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
    await client.query(
      `INSERT INTO request_log (user_id, endpoint, tokens_used) VALUES ($1, $2, $3)`,
      [userId, endpoint, tok]
    );
  } catch (e) {
    // Старые БД без колонки tokens_used — fallback без токенов
    if (e && e.code === "42703") {
      try {
        await client.query(
          "INSERT INTO request_log (user_id, endpoint) VALUES ($1, $2)",
          [userId, endpoint]
        );
        return;
      } catch (e2) {
        trackError("logRequest_fallback", e2);
      }
    }
    trackError("logRequest", e);
  } finally {
    if (client) await client.end().catch(() => {});
  }
}
 
module.exports = { checkAuth, logRequest };