// Netlify serverless function: аутентификация пользователей
// POST /auth?action=register  — регистрация
// POST /auth?action=login     — вход
// GET  /auth?action=me        — проверка токена

const { Client } = require("pg");
const crypto = require("crypto");

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ─── Простой JWT без зависимостей ──────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function signToken(payload, secret) {
  const header  = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body    = base64url(Buffer.from(JSON.stringify(payload)));
  const sig     = base64url(
    crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
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

// ─── Хеширование паролей ───────────────────────────────────────────────────
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.createHmac("sha256", s).update(password).digest("hex");
  return { hash: h, salt: s };
}

function checkPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return hash === storedHash;
}

// ─── БД: инициализация схемы ───────────────────────────────────────────────
async function getClient() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(64) UNIQUE NOT NULL,
      email       VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(64) NOT NULL,
      salt        VARCHAR(32) NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS request_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint    VARCHAR(64),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ─── Обработчики ───────────────────────────────────────────────────────────
async function handleRegister(body, jwtSecret) {
  const username = (body.username || "").trim();
  const email    = (body.email || "").trim().toLowerCase();
  const password = (body.password || "").trim();

  if (!username || !email || !password)
    return { statusCode: 400, body: { error: "Заполните все поля: username, email, password" } };
  if (username.length < 3 || username.length > 64)
    return { statusCode: 400, body: { error: "Имя пользователя: 3–64 символа" } };
  if (password.length < 6)
    return { statusCode: 400, body: { error: "Пароль должен содержать минимум 6 символов" } };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { statusCode: 400, body: { error: "Некорректный email" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const { hash, salt } = hashPassword(password);
    const res = await client.query(
      "INSERT INTO users (username, email, password_hash, salt) VALUES ($1, $2, $3, $4) RETURNING id, username, email",
      [username, email, hash, salt]
    );
    const user = res.rows[0];
    const token = signToken({ sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, jwtSecret);
    return { statusCode: 201, body: { token, user: { id: user.id, username: user.username, email: user.email } } };
  } catch (e) {
    if (e.code === "23505") {
      const field = e.constraint?.includes("email") ? "Email" : "Имя пользователя";
      return { statusCode: 409, body: { error: `${field} уже занят` } };
    }
    throw e;
  } finally {
    await client.end();
  }
}

async function handleLogin(body, jwtSecret) {
  const login    = (body.login || "").trim().toLowerCase();   // email или username
  const password = (body.password || "").trim();

  if (!login || !password)
    return { statusCode: 400, body: { error: "Введите логин и пароль" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const res = await client.query(
      "SELECT id, username, email, password_hash, salt FROM users WHERE email=$1 OR username=$1",
      [login]
    );
    if (res.rows.length === 0)
      return { statusCode: 401, body: { error: "Неверный логин или пароль" } };

    const user = res.rows[0];
    if (!checkPassword(password, user.password_hash, user.salt))
      return { statusCode: 401, body: { error: "Неверный логин или пароль" } };

    const token = signToken({ sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, jwtSecret);
    return { statusCode: 200, body: { token, user: { id: user.id, username: user.username, email: user.email } } };
  } finally {
    await client.end();
  }
}

async function handleMe(authHeader, jwtSecret) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "");
  if (!token) return { statusCode: 401, body: { error: "Токен не передан" } };
  const payload = verifyToken(token, jwtSecret);
  if (!payload) return { statusCode: 401, body: { error: "Токен недействителен или истёк" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const res = await client.query(
      `SELECT u.id, u.username, u.email, u.created_at,
              COUNT(r.id)::int AS request_count
       FROM users u
       LEFT JOIN request_log r ON r.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [payload.sub]
    );
    if (res.rows.length === 0) return { statusCode: 404, body: { error: "Пользователь не найден" } };
    return { statusCode: 200, body: { user: res.rows[0] } };
  } finally {
    await client.end();
  }
}

// ─── Главный обработчик ────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "JWT_SECRET не задан в переменных окружения" }) };

  if (!process.env.DATABASE_URL)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "DATABASE_URL не задан в переменных окружения" }) };

  const action = (event.queryStringParameters?.action || "").toLowerCase();

  try {
    let result;

    if (action === "register" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      result = await handleRegister(body, jwtSecret);

    } else if (action === "login" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      result = await handleLogin(body, jwtSecret);

    } else if (action === "me" && event.httpMethod === "GET") {
      result = await handleMe(event.headers["authorization"] || event.headers["Authorization"], jwtSecret);

    } else {
      result = { statusCode: 400, body: { error: "Неверный action или метод" } };
    }

    return { statusCode: result.statusCode, headers: CORS, body: JSON.stringify(result.body) };
  } catch (e) {
    console.error("auth error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Внутренняя ошибка сервера" }) };
  }
};
