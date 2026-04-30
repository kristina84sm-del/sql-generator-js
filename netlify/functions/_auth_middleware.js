// Общий модуль: проверка JWT + логирование запросов в БД
// Используется в generate.js, analyze_architecture.js, generate_mock_data.js

const crypto = require("crypto");
const { Client } = require("pg");

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

/**
 * Проверяет Authorization: Bearer <token>
 * Возвращает { ok, user } или { ok: false, error }
 */
function checkAuth(event) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return { ok: false, error: "JWT_SECRET не задан" };

  const authHeader = event.headers["authorization"] || event.headers["Authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, error: "Требуется авторизация. Войдите в систему." };

  const payload = verifyToken(token, jwtSecret);
  if (!payload) return { ok: false, error: "Токен недействителен или истёк. Войдите снова." };

  return { ok: true, user: payload };
}

/**
 * Записывает запрос в request_log (без бросания ошибки — логирование не блокирует)
 */
async function logRequest(userId, endpoint) {
  if (!process.env.DATABASE_URL) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(
      "INSERT INTO request_log (user_id, endpoint) VALUES ($1, $2)",
      [userId, endpoint]
    );
  } catch (e) {
    console.error("logRequest error:", e.message);
  } finally {
    await client.end();
  }
}

module.exports = { checkAuth, logRequest };
