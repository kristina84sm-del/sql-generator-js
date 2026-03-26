// Netlify serverless функция: генерация mock данных (INSERT)
// Замена Flask эндпоинта /generate_mock_data

const ALLOWED_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
]);

const DEFAULT_MODEL = "gpt-4o-mini";

// Системный промпт — перенесён из app.py
const MOCK_DATA_SYSTEM_PROMPT = `
Ты генератор mock data (INSERT) для тестирования.

Пользователь передает ER-диаграмму в Mermaid ('erDiagram') и DIALECT.

Верни ТОЛЬКО JSON:
{
  "inserts": "SQL INSERT команды (с явным списком колонок). Количество строк: небольшое, ориентируйся на 3-5 на таблицу.",
  "notes": "Короткие заметки (допущения, порядок вставок при FK, кол-во строк)."
}

Правила:
- Не добавляй таблицы/колонки, которых нет в ERD.
- Согласуй значения с PK/FK (сначала вставляй родительские таблицы, затем зависимые).
- Учитывай DIALECT в синтаксисе (кавычки/формат даты и т.п., если нужно).
`;

function safeFloat(value, defaultVal) {
  const f = parseFloat(value);
  return isNaN(f) ? defaultVal : f;
}

function clampTemperature(value, min = 0, max = 2) {
  return Math.max(min, Math.min(max, value));
}

function validateModel(requested) {
  const model = (requested || "").trim();
  return ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}

async function callOpenAI({ apiKey, model, temperature, systemPrompt, userPrompt }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`OpenAI API error ${response.status}: ${err?.error?.message || response.statusText}`);
  }

  const data = await response.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Модель вернула невалидный JSON: ${raw.slice(0, 300)}`);
  }
}

function checkAccessCode(event, envAccessCode) {
  if (!envAccessCode) return { ok: false, error: "Серверный ACCESS_CODE не задан в переменных окружения Netlify" };
  const provided =
    event.headers["x-access-code"] ||
    event.headers["X-Access-Code"] ||
    JSON.parse(event.body || "{}")?.access_code ||
    "";
  if (!provided.trim()) return { ok: false, error: "Код доступа не указан (access_code)" };
  if (provided.trim() !== envAccessCode) return { ok: false, error: "Неверный код доступа" };
  return { ok: true };
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const accessCheck = checkAccessCode(event, process.env.ACCESS_CODE);
  if (!accessCheck.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: accessCheck.error }) };

  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY не задан" }) };

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Невалидный JSON" }) };
  }

  const mermaidEr = (body.mermaid_er || "").trim();
  if (!mermaidEr) return { statusCode: 400, headers, body: JSON.stringify({ error: "Не передан Mermaid-код (mermaid_er)." }) };

  const dialect = (body.dialect || "PostgreSQL").trim();
  const rowCountHint = (body.row_count_hint || "").trim();
  const model = validateModel(body.model);
  const temperature = clampTemperature(safeFloat(body.temperature, 0.4));

  const userMessage = `DIALECT: ${dialect}
ROW_COUNT_HINT: ${rowCountHint || "(не задано)"}

ERD (Mermaid 'erDiagram'):
${mermaidEr}
`;

  try {
    const parsed = await callOpenAI({
      apiKey,
      model,
      temperature,
      systemPrompt: MOCK_DATA_SYSTEM_PROMPT,
      userPrompt: userMessage,
    });

    // inserts может прийти как строка или массив
    const insertsVal = parsed.inserts;
    const inserts = Array.isArray(insertsVal)
      ? insertsVal.join("\n").trim()
      : String(insertsVal || "").trim();

    const notesVal = parsed.notes;
    const notes = Array.isArray(notesVal)
      ? notesVal.join("\n").trim()
      : String(notesVal || "").trim();

    if (!inserts) return { statusCode: 502, headers, body: JSON.stringify({ error: "В ответе нет поля inserts." }) };

    return { statusCode: 200, headers, body: JSON.stringify({ inserts, notes }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Ошибка генерации mock data: ${e.message}` }) };
  }
};
