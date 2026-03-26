// Netlify serverless функция: генерация SQL + ER-диаграммы + объяснения
// Замена Flask эндпоинта /generate

const ALLOWED_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
]);

const DEFAULT_MODEL = "gpt-4o-mini";

// Системный промпт — полностью перенесён из app.py
const GENERATION_SYSTEM_PROMPT = `
Ты эксперт по SQL и реляционному проектированию (ER-моделирование).

Верни ТОЛЬКО один JSON-объект (без markdown-ограждений, без текста до или после) со структурой:
{
  "er_diagram": "Mermaid-код блока erDiagram. Должно начинаться строкой 'erDiagram'.",
  "sql": "Итоговый SQL: SELECT/операция или восстановленный/нормализованный SQL, если вход был SQL.",
  "explanation": "Краткое объяснение логики запроса/восстановления по-русски"
}

Правила для er_diagram:
- Используй синтаксис Mermaid 'erDiagram' (первая строка: erDiagram).
- Для сущностей используй блок сущности в формате:
  TABLE_NAME {
    type column_name PK
    type column_name
  }
- Внешние ключи отражай либо через PK/FK в полях, либо через отношения с кардинальностью (||--o{ и т.п.).
- НИЧЕГО не выдумывай:
  - Секции структуры считаются пустыми, если в user-сообщении указано:
    EXISTING_SCHEMA_STATUS=EMPTY и/or INPUT_SQL_STATUS=EMPTY.
  - Если в user-сообщении есть секция EXISTING_SCHEMA (она НЕ пустая) — ВСЕ таблицы, колонки и связи в er_diagram/SQL должны соответствовать ТОЛЬКО ей.
  - Если EXISTING_SCHEMA пустая и в user-сообщении есть секция INPUT_SQL — работай как обратный инжиниринг: извлеки таблицы/колонки/ключи ТОЛЬКО из INPUT_SQL.
  - Если обе секции пустые — проектируй структуру с нуля под задачу пользователя.

Правила для sql:
- SQL должен быть согласован с er_diagram.
- Учитывай DIALECT (диалект SQL) из user-сообщения.

Правила для explanation:
- Кратко поясни, какие предположения сделаны (если исходных данных недостаточно).
`;

// Утилиты
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

// Эвристика: похоже ли содержимое на SQL
function isLikelySql(text) {
  const t = (text || "").trim().toLowerCase();
  if (t.length < 20) return false;
  return /\b(create\s+table|alter\s+table|drop\s+table|insert\s+into|update\s+|delete\s+from|select\s+.+\s+from|with\s+\w+\s+as)\b/.test(t);
}

// Вызов OpenAI API
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

// Проверка access code
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

// Netlify handler
exports.handler = async (event) => {
  // CORS заголовки
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  // Проверка access code
  const accessCheck = checkAccessCode(event, process.env.ACCESS_CODE);
  if (!accessCheck.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: accessCheck.error }) };

  // Проверка API ключа
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "OPENAI_API_KEY не задан в переменных окружения Netlify" }) };

  // Парсим тело запроса
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Невалидный JSON в теле запроса" }) };
  }

  const userPrompt = (body.user_prompt || "").trim();
  if (!userPrompt) return { statusCode: 400, headers, body: JSON.stringify({ error: "Введите текст запроса." }) };

  const temperature = clampTemperature(safeFloat(body.temperature, 0.2));
  const model = validateModel(body.model);
  const dialect = (body.dialect || "PostgreSQL").trim();
  const existingSchema = (body.existing_schema || "").trim();
  const businessRules = (body.business_rules || "").trim();
  const hasExistingSchema = Boolean(existingSchema);

  // Определяем режим reverse engineering
  const userPromptIsSql = isLikelySql(userPrompt);
  const reverseMode = userPromptIsSql && !hasExistingSchema;
  const inputSqlBlock = reverseMode ? userPrompt : "";

  const priority =
    "PRIORITY: " +
    "1) Если EXISTING_SCHEMA НЕ пустая — это единственный источник структуры и нужно строго использовать только таблицы/колонки из нее. " +
    "2) Если EXISTING_SCHEMA пустая и есть INPUT_SQL — работай как reverse engineering по INPUT_SQL. " +
    "3) Если обе секции структуры отсутствуют — проектируй базу с нуля под задачу.";

  const userTaskText = reverseMode
    ? "(Текст вставлен как SQL; источник структуры — INPUT_SQL. USER_TASK здесь используется минимально.)"
    : userPrompt;

  const userMessage = `DIALECT: ${dialect}

${priority}

USER_TASK:
${userTaskText}

EXISTING_SCHEMA_STATUS: ${hasExistingSchema ? "NOT_EMPTY" : "EMPTY"}
EXISTING_SCHEMA (DDL или список таблиц/колонок; если статус EMPTY — не используем как источник структуры):
${existingSchema || ""}

BUSINESS_RULES (опционально, специфические бизнес/логические правила):
${businessRules || "(пусто)"}

INPUT_SQL_STATUS: ${inputSqlBlock ? "NOT_EMPTY" : "EMPTY"}
INPUT_SQL (используется ТОЛЬКО если EXISTING_SCHEMA_STATUS=EMPTY):
${inputSqlBlock || ""}

Сгенерируй Mermaid ERD и итоговый SQL под задачу пользователя, соблюдая правила выше.
`;

  try {
    const parsed = await callOpenAI({
      apiKey,
      model,
      temperature,
      systemPrompt: GENERATION_SYSTEM_PROMPT,
      userPrompt: userMessage,
    });

    const erDiagram = (parsed.er_diagram || "").trim();
    const sqlText = (parsed.sql || "").trim();
    const explanation = (parsed.explanation || "").trim();

    if (!sqlText) return { statusCode: 502, headers, body: JSON.stringify({ error: "В ответе нет поля sql." }) };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ er_diagram: erDiagram, sql: sqlText, explanation }),
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Ошибка генерации: ${e.message}` }) };
  }
};
