// Netlify serverless function: история запросов пользователя из БД
// GET  /history?action=list        — список (50 последних)
// GET  /history?action=item&id=N   — одна запись
// POST /history?action=save        — сохранить запись

const { checkAuth } = require("./_auth_middleware");
const { getClient } = require("./_db");
const { publicDbError, trackError } = require("./_log");

// Промпт — в пределах UI (design 4000 / reverse 8000).
// Остальные TEXT-поля — защита от гигантских ответов модели, без обрезки нормальных результатов.
const HIST_LIMITS = {
  user_prompt: 8000,
  text_field: 500000,
};

function clipText(val, limit, { allowEmpty = false } = {}) {
  if (val == null) return null;
  const s = String(val);
  if (!s && !allowEmpty) return null;
  return s.length > limit ? s.slice(0, limit) : s;
}

exports.handler = async (event) => {
  // Динамически вычисляем origin для корректной передачи кук бэкендом
  const currentOrigin = event.headers.origin || event.headers.Origin || "*";
  
  // Новый правильный объект CORS заголовков
  const responseHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": currentOrigin,
    "Access-Control-Allow-Credentials": "true", // Обязательно разрешаем фронтенду читать куки ответов
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  // Перехват предзапроса OPTIONS от браузера
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: responseHeaders, body: "" };
  }

  // Вызываем нашу обновленную функцию проверки (она сама распарсит куку)
  const auth = await checkAuth(event);
  if (!auth.ok) {
    return { statusCode: 401, headers: responseHeaders, body: JSON.stringify({ error: auth.error }) };
  }

  const action = (event.queryStringParameters?.action || "list").toLowerCase();

  try {
    if (action === "list" && event.httpMethod === "GET") {
      const client = await getClient();
      try {
        const res = await client.query(
          `SELECT id, tab, dialect, LEFT(user_prompt, 80) AS user_prompt, created_at, tokens_used
           FROM query_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
          [auth.user.sub] // Берем ID пользователя из расшифрованного мидлваром токена
        ); 
        return { statusCode: 200, headers: responseHeaders, body: JSON.stringify(res.rows) };
      } finally { await client.end(); }
    }

    if (action === "item" && event.httpMethod === "GET") {
      const id = parseInt(event.queryStringParameters?.id || "0");
      if (!id) return { statusCode: 400, headers: responseHeaders, body: JSON.stringify({ error: "id не передан" }) };
      const client = await getClient();
      try {
        const res = await client.query(
          "SELECT * FROM query_history WHERE id=$1 AND user_id=$2",
          [id, auth.user.sub]
        );
        if (!res.rows.length) return { statusCode: 404, headers: responseHeaders, body: JSON.stringify({ error: "Не найдено" }) };
        return { statusCode: 200, headers: responseHeaders, body: JSON.stringify(res.rows[0]) };
      } finally { await client.end(); }
    }

    if (action === "save" && event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const client = await getClient();
      try {
        const res = await client.query(
          `INSERT INTO query_history
             (user_id, tab, dialect, user_prompt, sql_result, ddl_result, er_diagram, explanation, audit_result, inserts_result, tokens_used)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            auth.user.sub,
            body.tab || "generate",
            String(body.dialect || "").slice(0, 64),
            clipText(body.user_prompt, HIST_LIMITS.user_prompt, { allowEmpty: true }) || "",
            clipText(body.sql_result, HIST_LIMITS.text_field),
            clipText(body.ddl_result, HIST_LIMITS.text_field),
            clipText(body.er_diagram, HIST_LIMITS.text_field),
            clipText(body.explanation, HIST_LIMITS.text_field),
            clipText(body.audit_result, HIST_LIMITS.text_field),
            clipText(body.inserts_result, HIST_LIMITS.text_field),
            body.tokens_used || null,
          ]
        );
        return { statusCode: 201, headers: responseHeaders, body: JSON.stringify({ id: res.rows[0].id }) };
      } finally { await client.end(); }
    }

    return { statusCode: 400, headers: responseHeaders, body: JSON.stringify({ error: "Неверный action" }) };
  } catch (e) {
    trackError("history", e);
    const pub = publicDbError(e);
    return { statusCode: pub.statusCode, headers: responseHeaders, body: JSON.stringify({ error: pub.error }) };
  }
};
