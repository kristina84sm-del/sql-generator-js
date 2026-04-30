// Netlify serverless функция: генерация mock данных (INSERT)
// v2: JWT-авторизация, промпты только на сервере, ограничение длины

const { checkAuth, logRequest } = require("./_auth_middleware");

const ALLOWED_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);
const DEFAULT_MODEL  = "gpt-4o-mini";

const LIMITS = {
  mermaid_er:     6000,
  row_count_hint: 200,
};

// Системный промпт — только на сервере
const MOCK_DATA_SYSTEM_PROMPT = `
Ты генератор mock data (INSERT) для тестирования.

Пользователь передает ER-диаграмму в Mermaid ('erDiagram') и DIALECT.

Верни ТОЛЬКО JSON:
{
  "inserts": "SQL INSERT команды (с явным списком колонок). Количество строк: 3-5 на таблицу.",
  "notes": "Короткие заметки (допущения, порядок вставок при FK, кол-во строк)."
}

Правила:
- Не добавляй таблицы/колонки, которых нет в ERD.
- Согласуй значения с PK/FK (сначала родительские таблицы, потом зависимые).
- Учитывай DIALECT в синтаксисе (кавычки, формат даты и т.п.).
`.trim();

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function safeFloat(v, d) { const f = parseFloat(v); return isNaN(f) ? d : f; }
function clamp(v, min = 0, max = 2) { return Math.max(min, Math.min(max, v)); }
function validateModel(m) { const s = (m || "").trim(); return ALLOWED_MODELS.has(s) ? s : DEFAULT_MODEL; }
function truncate(str, limit) {
  if (!str) return "";
  const s = String(str);
  return s.length > limit ? s.slice(0, limit) + "\n[...обрезано]" : s;
}

async function callOpenAI({ apiKey, model, temperature, systemPrompt, userPrompt }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }
  const data = await response.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim();
  try { return JSON.parse(raw); }
  catch { throw new Error(`Модель вернула невалидный JSON: ${raw.slice(0, 300)}`); }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  const auth = checkAuth(event);
  if (!auth.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: auth.error }) };

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "OPENAI_API_KEY не задан" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Невалидный JSON" }) }; }

  const mermaidEr = truncate((body.mermaid_er || "").trim(), LIMITS.mermaid_er);
  if (!mermaidEr)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Не передан Mermaid-код (mermaid_er)." }) };

  const dialect      = (body.dialect || "PostgreSQL").trim();
  const rowCountHint = truncate((body.row_count_hint || "").trim(), LIMITS.row_count_hint);
  const model        = validateModel(body.model);
  const temperature  = clamp(safeFloat(body.temperature, 0.4));

  const userMessage = `DIALECT: ${dialect}
ROW_COUNT_HINT: ${rowCountHint || "(не задано)"}

ERD (Mermaid 'erDiagram'):
${mermaidEr}`;

  try {
    const parsed = await callOpenAI({ apiKey, model, temperature, systemPrompt: MOCK_DATA_SYSTEM_PROMPT, userPrompt: userMessage });

    const insertsVal = parsed.inserts;
    const inserts = Array.isArray(insertsVal) ? insertsVal.join("\n").trim() : String(insertsVal || "").trim();
    const notesVal = parsed.notes;
    const notes = Array.isArray(notesVal) ? notesVal.join("\n").trim() : String(notesVal || "").trim();

    if (!inserts)
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "В ответе нет поля inserts." }) };

    await logRequest(auth.user.sub, "generate_mock_data");
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ inserts, notes }) };
  } catch (e) {
    console.error("mock_data error:", e);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Ошибка генерации mock data: ${e.message}` }) };
  }
};
