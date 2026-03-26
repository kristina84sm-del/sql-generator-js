// Netlify serverless функция: архитектурный аудит ER-диаграммы
// Замена Flask эндпоинта /analyze_architecture

const ALLOWED_MODELS = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
]);

const DEFAULT_MODEL = "gpt-4o-mini";

// Системный промпт — перенесён из app.py
const ANALYZE_SYSTEM_PROMPT = `
Ты архитектор баз данных. У тебя есть ER-диаграмма в Mermaid (тип 'erDiagram').

Верни ТОЛЬКО JSON:
{
  "audit": "Текст аудита на русском (можно markdown). Включи: проверки 1NF/2NF/3NF, наличие циклов зависимостей по FK, рекомендации по индексам. Ясно отметь допущения/ограничения."
}

Требования:
- Восстанови ключи (PK/FK) по Mermaid, если они есть.
- Проверь нормальные формы 1NF/2NF/3NF (если по диаграмме нельзя строго доказать — укажи это).
- Проверь циклические зависимости по направлениям FK (A -> B и B -> A или длиннее).
- Дай рекомендации по индексам под типовые операции JOIN/WHERE, основываясь на связях и ключах.
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
  const sqlText = (body.sql || "").trim();
  const model = validateModel(body.model);
  const temperature = clampTemperature(safeFloat(body.temperature, 0.2));

  const userMessage = `DIALECT: ${dialect}

ERD (Mermaid 'erDiagram'):
${mermaidEr}

OPTIONAL_SQL (может помочь контекстом, но не является источником истины):
${sqlText || "(не передан)"}
`;

  try {
    const parsed = await callOpenAI({
      apiKey,
      model,
      temperature,
      systemPrompt: ANALYZE_SYSTEM_PROMPT,
      userPrompt: userMessage,
    });

    const audit = (parsed.audit || "").trim();
    if (!audit) return { statusCode: 502, headers, body: JSON.stringify({ error: "В ответе нет поля audit." }) };

    return { statusCode: 200, headers, body: JSON.stringify({ audit }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Ошибка аудита: ${e.message}` }) };
  }
};
