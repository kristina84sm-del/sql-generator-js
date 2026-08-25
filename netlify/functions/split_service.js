// Netlify serverless функция: разделение монолитной БД на сервисы
// Два режима:
//  1. target указан -> спроектировать НОВУЮ схему конкретного сервиса
//  2. target не указан -> дать рекомендации по делению на сервисы
 
const { checkAuth, logRequest } = require("./_auth_middleware");
const { checkRateLimit } = require("./_rate_limit_check"); 
const ALLOWED_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]);
const DEFAULT_MODEL  = "gpt-4o-mini";
 
const LIMITS = { schema: 8000, target: 500 };
 
// ─── ПРОМПТ 1: проектирование конкретного сервиса ───
const SPLIT_TARGET_PROMPT = `
Ты архитектор микросервисов. Тебе передают DDL монолитной БД и
название сервиса, который нужно выделить в отдельный микросервис.
 
ЭТО НЕ АУДИТ. Не пиши анализ нормализации, не оценивай индексы.
Твоя задача — СПРОЕКТИРОВАТЬ новую схему для конкретного сервиса.
 
Верни ТОЛЬКО JSON:
{
  "new_ddl": "CREATE TABLE для всех таблиц нового сервиса. Полный исполняемый DDL.",
  "new_mermaid": "Mermaid erDiagram код для нового сервиса (первая строка: erDiagram)",
  "migration_sql": "SQL для переноса существующих данных: INSERT INTO new_table (...) SELECT ... FROM old_table;",
  "explanation": "Markdown на русском: что вынесено в сервис, какие FK на внешние таблицы (вне сервиса) превращены в обычные поля-идентификаторы (т.к. связь теперь идёт через API, а не через FK), какие данные могут требовать синхронизации."
}
 
ПРАВИЛА:
- Если ARCH_STYLE=msa: полное разделение, у сервиса своя БД. Любой FK,
  который ссылался на таблицу ВНЕ выделяемого сервиса, становится
  обычным INT/UUID полем без REFERENCES (комментарий: "-- было FK на внешний сервис").
- Если ARCH_STYLE=soa: разрешено оставить FK на 1-2 общих справочника
  (например статусы, категории), если они логически shared между сервисами.
- Таблицы, явно относящиеся к домену TARGET (по названию и связям),
  выносим целиком. Если сомневаешься — включай таблицу, если она
  ссылается ТОЛЬКО на таблицы внутри домена.
- new_mermaid должен парситься без ошибок: каждая таблица отдельным
  блоком TABLE { } с переносом строки между блоками.
- migration_sql использует ТОЛЬКО колонки, реально существующие в OLD_SCHEMA.
`.trim();
 
// ─── ПРОМПТ 2: рекомендации по делению без конкретного таргета ───
const SPLIT_RECOMMEND_PROMPT = `
Ты архитектор микросервисов с опытом декомпозиции монолитов.
Тебе передают DDL монолитной БД без указания конкретного сервиса.
 
ЭТО НЕ АУДИТ. Не пиши анализ нормализации/индексов.
Твоя задача — проанализировать связи между таблицами (через FK)
и предложить, как разделить монолит на логические сервисы.
 
Верни ТОЛЬКО JSON:
{
  "report": "Markdown на русском со строго такими разделами:
 
## Ядро (Core)
Таблицы с наибольшим числом входящих FK-связей — трогать в последнюю
очередь, основа системы (например users, orders в типичном e-commerce).
 
## Предлагаемые сервисы
Для КАЖДОГО предложенного сервиса:
### Название сервиса
- Входящие таблицы: список
- Обоснование: почему именно эти таблицы образуют связный домен
 
## ОБЩИЕ_ТАБЛИЦЫ_ИЛИ_ДУБЛИРОВАНИЕ
(заголовок зависит от ARCH_STYLE — см правило ниже)
 
## Порядок миграции
С какого сервиса начинать (наименее связанный с остальными) и почему
 
## Риски
Какие FK-связи станут проблемой при физическом разделении БД"
"monolith_mermaid": "Mermaid erDiagram код ВСЕЙ монолитной схемы целиком (та же структура что в OLD_SCHEMA, просто переведённая в erDiagram формат). Первая строка: erDiagram. Используется для визуализации связей при чтении отчёта.",
"services_diagram": "Mermaid flowchart-код (первая строка строго: flowchart TD), показывающий ТОЛЬКО предложенные сервисы как узлы графа (прямоугольник = один сервис из раздела 'Предлагаемые сервисы') и связи МЕЖДУ НИМИ. Если ARCH_STYLE=soa — используй ServiceA -->|REST API| ServiceB для вызовов и пунктир (ServiceA -.->|общая таблица: table_name| ServiceB) для общих таблиц. Если ARCH_STYLE=msa — НА ДИАГРАММЕ НЕ ДОЛЖНО БЫТЬ НИ ОДНОЙ пунктирной связи 'общая таблица' вообще: при полном разделении общих таблиц по определению нет, все связи между сервисами — ТОЛЬКО сплошные ServiceA -->|REST API| ServiceB. Никаких отдельных таблиц внутри узлов — только сервисы целиком как блоки."
 
}
 
ПРАВИЛО для раздела про общие таблицы:
- Если ARCH_STYLE=soa: заголовок "Общие таблицы между сервисами" —
  укажи 2-4 таблицы (справочники, конфигурация), которые разумно
  оставить общими для нескольких сервисов в рамках SOA.
- Если ARCH_STYLE=msa: заголовок "Таблицы-кандидаты на дублирование" —
  укажи какие данные нужно будет дублировать/синхронизировать между
  сервисами при полном разделении БД (например, копия справочника
  пользователей в сервисе заказов).
 
Используй РЕАЛЬНЫЕ названия таблиц из переданной схемы, не абстракции.
`.trim();
 
const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
 
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
      model, temperature,
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
  const usage = data.usage || {};
  try {
    const parsed = JSON.parse(raw);
    parsed.__usage = usage; // прокидываем usage вместе с ответом
    return parsed;
  }
  catch { throw new Error(`Модель вернула невалидный JSON: ${raw.slice(0, 300)}`); }
}
 
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
 
  let auth;
  try {
    auth = await checkAuth(event);
  } catch (e) {
    console.error("analyze_architecture checkAuth error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Ошибка авторизации: " + e.message }) };
  }
  if (!auth.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: auth.error }) };
 
  let rateCheck;
  try {
    rateCheck = await checkRateLimit(auth.user.sub);
  } catch (e) {
    console.error("analyze_architecture checkRateLimit error:", e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Ошибка проверки лимита запросов: " + e.message }) };
  }
  if (!rateCheck.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: rateCheck.error }) };
  } 
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "OPENAI_API_KEY не задан" }) };
 
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Невалидный JSON" }) }; }
 
  const schema    = truncate((body.schema || "").trim(), LIMITS.schema);
  const target    = truncate((body.target || "").trim(), LIMITS.target);
  const archStyle = (body.arch_style === "msa") ? "msa" : "soa";
  const model     = validateModel(body.model);
  const dialect   = (body.dialect || "PostgreSQL").trim();
 
  if (!schema)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Не передана схема монолита (schema)." }) };
 
  const hasTarget = Boolean(target);
 
  const userMessage = `DIALECT: ${dialect}
ARCH_STYLE: ${archStyle}
${hasTarget ? `TARGET_SERVICE: ${target}` : "TARGET_SERVICE: (не указан — дай общие рекомендации)"}
 
OLD_SCHEMA (монолит):
${schema}`;
 
  try {
    const systemPrompt = hasTarget ? SPLIT_TARGET_PROMPT : SPLIT_RECOMMEND_PROMPT;
    const parsed = await callOpenAI({ apiKey, model, temperature: 0.2, systemPrompt, userPrompt: userMessage });
 
    await logRequest(auth.user.sub, "split_service");
 
    if (hasTarget) {
      const new_ddl       = String(parsed.new_ddl || "").trim();
      const new_mermaid   = String(parsed.new_mermaid || "").trim();
      const migration_sql = String(parsed.migration_sql || "").trim();
      const explanation    = String(parsed.explanation || "").trim();
      const tokensUsed = parsed.__usage?.total_tokens || null;
      if (!new_ddl && !new_mermaid)
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Модель не вернула схему сервиса." }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ mode: "target", new_ddl, new_mermaid, migration_sql, explanation, tokens_used: tokensUsed }) };
    } else {
      const report = String(parsed.report || "").trim();
      const monolith_mermaid = String(parsed.monolith_mermaid || "").trim();
      const services_diagram = String(parsed.services_diagram || "").trim();
      const tokensUsedRec = parsed.__usage?.total_tokens || null;
      if (!report)
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Модель не вернула рекомендации." }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ mode: "recommend", report, monolith_mermaid, services_diagram, tokens_used: tokensUsedRec }) }; 
    }
  } catch (e) {
    console.error("split_service error:", e);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `Ошибка: ${e.message}` }) };
  }
};