// Netlify serverless function: аутентификация пользователей
// POST /auth?action=register  — регистрация
// POST /auth?action=login     — вход
// GET  /auth?action=me        — проверка токена

const crypto = require("crypto");
const { getClient } = require("./_db");
const { publicDbError, trackError } = require("./_log");

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
async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      username        VARCHAR(64) UNIQUE NOT NULL,
      email           VARCHAR(255) UNIQUE NOT NULL,
      password_hash   VARCHAR(64) NOT NULL,
      salt            VARCHAR(32) NOT NULL,
      privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
      consent_date    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS request_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      endpoint    VARCHAR(64),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS query_history (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      tab         VARCHAR(32),
      dialect     VARCHAR(64),
      user_prompt TEXT,
      sql_result  TEXT,
      ddl_result  TEXT,
      er_diagram  TEXT,
      explanation TEXT,
      audit_result TEXT,
      inserts_result TEXT,
      tokens_used INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ,
      user_agent  TEXT,
      ip_address  VARCHAR(64),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_request_limit INTEGER;
    ALTER TABLE query_history ALTER COLUMN dialect TYPE VARCHAR(64);
    ALTER TABLE query_history ADD COLUMN IF NOT EXISTS tokens_used INTEGER;
    ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
    ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64);
  `);
}

// ─── Обработчики ───────────────────────────────────────────────────────────
async function handleRegister(body, jwtSecret, userAgent, ipAddress) {
  const username        = (body.username || "").trim();
  const email           = (body.email || "").trim().toLowerCase();
  const password        = (body.password || "").trim();
  // 1. Забираем флаг согласия, который прилетает с фронтенда
  const privacy_consent = !!body.privacy_consent; 

  if (!username || !email || !password)
    return { statusCode: 400, body: { error: "Заполните все поля: username, email, password" } };
  if (username.length < 3 || username.length > 64)
    return { statusCode: 400, body: { error: "Имя пользователя: 3–64 символа" } };
  if (password.length < 6)
    return { statusCode: 400, body: { error: "Пароль должен содержать минимум 6 символов" } };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { statusCode: 400, body: { error: "Некорректный email" } };
  
  // 2. Проверка согласия: если чекбокс не прожит, бэкенд не пустит запрос дальше
  if (!privacy_consent)
    return { statusCode: 400, body: { error: "Необходимо дать согласие на обработку персональных данных" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const { hash, salt } = hashPassword(password);

    // Первый живой пользователь в БД становится администратором
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM users WHERE deleted_at IS NULL`
    );
    const makeAdmin = (existing[0]?.cnt || 0) === 0;

    const res = await client.query(
      `INSERT INTO users (username, email, password_hash, salt, privacy_consent, consent_date, is_admin) 
       VALUES ($1, $2, $3, $4, $5, NOW(), $6) 
       RETURNING id, username, email, is_admin`,
      [username, email, hash, salt, privacy_consent, makeAdmin]
    );
    
    const user = res.rows[0];
    const sessionRes = await client.query(
      `INSERT INTO auth_sessions (user_id, expires_at, user_agent, ip_address) VALUES ($1, NOW() + INTERVAL '7 days', $2, $3) RETURNING id`,
      [user.id, userAgent, ipAddress]
    );
    const sid = sessionRes.rows[0].id;
    const token = signToken({ sub: user.id, username: user.username, sid, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, jwtSecret);
    return {
      statusCode: 201,
      body: {
        token,
        user: { id: user.id, username: user.username, email: user.email, is_admin: !!user.is_admin }
      }
    };
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
async function handleLogin(body, jwtSecret, userAgent, ipAddress) {
  const login    = (body.login || "").trim().toLowerCase();   // email или username
  const password = (body.password || "").trim();

  if (!login || !password)
    return { statusCode: 400, body: { error: "Введите логин и пароль" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const res = await client.query(
      "SELECT id, username, email, password_hash, salt, is_admin FROM users WHERE (email=$1 OR username=$1) AND deleted_at IS NULL",
      [login]
    );
    if (res.rows.length === 0)
      return { statusCode: 401, body: { error: "Неверный логин или пароль" } };

    const user = res.rows[0];
    if (!checkPassword(password, user.password_hash, user.salt))
      return { statusCode: 401, body: { error: "Неверный логин или пароль" } };

    // Если админов ещё нет — повышаем текущего (например первый пользователь до фикса)
    if (!user.is_admin) {
      const promoted = await client.query(
        `UPDATE users SET is_admin = TRUE
         WHERE id = $1
           AND NOT EXISTS (
             SELECT 1 FROM users WHERE is_admin = TRUE AND deleted_at IS NULL
           )
         RETURNING is_admin`,
        [user.id]
      );
      if (promoted.rows[0]?.is_admin) user.is_admin = true;
    }

    const sessionRes = await client.query(
      `INSERT INTO auth_sessions (user_id, expires_at, user_agent, ip_address) VALUES ($1, NOW() + INTERVAL '7 days', $2, $3) RETURNING id`,
      [user.id, userAgent, ipAddress]
    );
    const sid = sessionRes.rows[0].id;
    const token = signToken({ sub: user.id, username: user.username, sid, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, jwtSecret);
    return {
      statusCode: 200,
      token: token, // Прокидываем наружу для заголовков
      body: { user: { id: user.id, username: user.username, email: user.email, is_admin: !!user.is_admin } }
    };
  } finally {
    await client.end();
  }
}

async function handleMe(token, jwtSecret) {
  // Переменную authHeader переименовываем в token внутри параметров функции
if (!token || token === "undefined") return { statusCode: 401, body: { error: "Токен не передан или пустой" } };
  const payload = verifyToken(token, jwtSecret);
  if (!payload) return { statusCode: 401, body: { error: "Токен недействителен или истёк" } };

  const client = await getClient();
  try {
    await ensureSchema(client);
    const res = await client.query(
      `SELECT u.id, u.username, u.email, u.created_at, u.is_admin,
              COUNT(DISTINCT r.id)::int AS request_count,
              COALESCE(SUM(q.tokens_used), 0)::int AS tokens_total
       FROM users u
       LEFT JOIN request_log r ON r.user_id = u.id
       LEFT JOIN query_history q ON q.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL
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
  // 1. Извлекаем origin динамически (это критически важно для работы кук!)
  const currentOrigin = event.headers.origin || event.headers.Origin || "*";

  // Обработка CORS предзапроса
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": currentOrigin,
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Credentials": "true"
      },
      body: ""
    };
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || !process.env.DATABASE_URL) {
    return { 
      statusCode: 500, 
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": currentOrigin,
        "Access-Control-Allow-Credentials": "true"
      }, 
      body: JSON.stringify({ error: "Переменные окружения не заданы" }) 
    };
  }

  // Идеальный парсинг токена (работает и для одной куки, и для нескольких)
  const cookieHeader = event.headers.cookie || event.headers.Cookie || "";
  const match = cookieHeader.match(/token=([^;]+)/);
  const token = match ? match[1] : (event.headers.authorization ? event.headers.authorization.split(" ")[1] : null);

  const action = (event.queryStringParameters?.action || "").toLowerCase();

  try {
    let result;

    // Маршрутизация экшенов
    if (action === "register" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const ua = event.headers['user-agent'] || event.headers['User-Agent'] || null;
      const ip = (event.headers['x-forwarded-for'] || "").split(',')[0].trim() || null;
      result = await handleRegister(body, jwtSecret, ua, ip);

    } else if (action === "login" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const ua = event.headers['user-agent'] || event.headers['User-Agent'] || null;
      const ip = (event.headers['x-forwarded-for'] || "").split(',')[0].trim() || null;
      result = await handleLogin(body, jwtSecret, ua, ip);

    } else if (action === "me" && event.httpMethod === "GET") {
      // ИСПРАВЛЕНО: Больше не парсим заново куку! Используем готовую переменную token из строки 34
      result = await handleMe(token, jwtSecret);

   
    } else if (action === "logout") {
      if (token) {
        const payload = verifyToken(token, jwtSecret);
        if (payload && payload.sid) {
          const client = await getClient();
          try {
            await client.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1", [payload.sid]);
          } catch (e) {
            console.error("logout revoke error:", e.message);
          } finally {
            await client.end();
          }
        }
      }
      result = { statusCode: 200, body: { success: true } };
    } else if (action === "delete_account" && event.httpMethod === "POST") {
      if (!token) {
        result = { statusCode: 401, body: { error: "Требуется авторизация" } };
      } else {
        const payload = verifyToken(token, jwtSecret);
        if (!payload) {
          result = { statusCode: 401, body: { error: "Токен недействителен или истёк" } };
        } else {
          const body2 = JSON.parse(event.body || "{}");
          const password2 = (body2.password || "").trim();
          if (!password2) {
            result = { statusCode: 400, body: { error: "Введите пароль для подтверждения" } };
          } else {
            const client2 = await getClient();
            try {
              const userRes = await client2.query(
                "SELECT password_hash, salt FROM users WHERE id = $1 AND deleted_at IS NULL",
                [payload.sub]
              );
              if (!userRes.rows.length) {
                result = { statusCode: 404, body: { error: "Пользователь не найден" } };
              } else {
                const { password_hash, salt } = userRes.rows[0];
                if (!checkPassword(password2, password_hash, salt)) {
                  result = { statusCode: 403, body: { error: "Неверный пароль. Удаление отменено." } };
                } else {
                  // Мягкое удаление: анонимизируем ПДн, статистика сохраняется
                  await client2.query(`
                    UPDATE users SET
                      username      = 'deleted_' || id::text,
                      email         = 'deleted_' || id::text || '@deleted.local',
                      password_hash = 'DELETED',
                      salt          = 'DELETED',
                      deleted_at    = NOW()
                    WHERE id = $1
                  `, [payload.sub]);
                  // Сессии удаляем — вход заблокирован
                  await client2.query(
                    "DELETE FROM auth_sessions WHERE user_id = $1",
                    [payload.sub]
                  );
                  // query_history и request_log оставляем — они анонимизированы
                  // (пользователь = 'deleted_N', войти невозможно)
                  result = { statusCode: 200, body: { ok: true } };
                }
              }
            } catch (e) {
              console.error("delete_account error:", e);
              result = { statusCode: 500, body: { error: "Ошибка при удалении: " + e.message } };
            } finally {
              await client2.end();
            }
          }
        }
      }
    } else if (action === "complete_onboarding" && event.httpMethod === "POST") {
      if (!token) {
        result = { statusCode: 401, body: { error: "Нет доступа" } };
      } else {
        const payload = verifyToken(token, jwtSecret);
        if (!payload) {
          result = { statusCode: 401, body: { error: "Неверный токен" } };
        } else {
          const client = await getClient();
          try {
            await client.query("UPDATE users SET is_new_user = FALSE WHERE id = $1", [payload.sub]);
            result = { statusCode: 200, body: { status: "ok" } };
          } finally {
            await client.end();
          }
        }
      }
      
    } else {
      result = { statusCode: 400, body: { error: "Неверный action или метод" } };
    }

    // Базовые CORS заголовки (С динамическим Origin для кук)
    const responseHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": currentOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };

    // Установка куки при успешном входе или регистрации
    // ИСПРАВЛЕНО: Ищем токен и в result.token, и в result.body.token для надежности
    if ((action === "login" || action === "register") && (result.statusCode === 200 || result.statusCode === 201)) {
      const extractedToken = result.token || result.body?.token;
      
      if (extractedToken) {
        // Чистим токен из тела ответа
        if (result.token) delete result.token;
        if (result.body && result.body.token) delete result.body.token;
        
        // ВАЖНО: Убрали флаг Secure! На http://localhost:8888 из-за него браузеры выбрасывали куку.
        // SameSite=Lax обязателен для локальной разработки.
        responseHeaders["Set-Cookie"] = `token=${extractedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
      }
    }

    // Стирание куки при выходе
    if (action === "logout") {
      responseHeaders["Set-Cookie"] = `token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    }

    // Нормализуем отправку body (если там объект — переводим в строку)
    const finalBody = result.body && typeof result.body === "object" ? result.body : result;

    return { 
      statusCode: result.statusCode || 200, 
      headers: responseHeaders, 
      body: JSON.stringify(finalBody.body || finalBody) 
    };

  } catch (e) {
    trackError("auth", e);
    const pub = publicDbError(e);
    return { 
      statusCode: pub.statusCode, 
      headers: { 
        "Content-Type": "application/json", 
        "Access-Control-Allow-Origin": currentOrigin,
        "Access-Control-Allow-Credentials": "true"
      }, 
      body: JSON.stringify({ error: pub.error }) 
    };
  }
};