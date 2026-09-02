require("dotenv").config();
const express = require("express");
const path    = require("path");
const { publicDbError, trackError } = require("./netlify/functions/_log");
const app     = express();
 
app.use(express.json({ limit: "10mb" }));
 
function wrap(mod) {
  return async (req, res) => {
    const event = {
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: req.query,
      body: (req.method === "GET" || req.method === "OPTIONS")
        ? undefined
        : JSON.stringify(req.body || {}),
    };
    try {
      const result = await mod.handler(event);
      if (result.headers) {
        Object.entries(result.headers).forEach(([k,v]) => res.setHeader(k, v));
      }
      res.status(result.statusCode || 200).send(result.body);
    } catch (e) {
      trackError("express.wrap", e);
      const pub = publicDbError(e);
      res.status(pub.statusCode).json({ error: pub.error });
    }
  };
}
 
const routes = {
  "/auth":                require("./netlify/functions/auth.js"),
  "/generate":            require("./netlify/functions/generate.js"),
  "/analyze_architecture":require("./netlify/functions/analyze_architecture.js"),
  "/generate_mock_data":  require("./netlify/functions/generate_mock_data.js"),
  "/generate_sql_tests":  require("./netlify/functions/generate_sql_tests.js"),
  "/generate_migration":  require("./netlify/functions/generate_migration.js"),
  "/generate_sql_trainer":require("./netlify/functions/generate_sql_trainer.js"),
  "/split_service":       require("./netlify/functions/split_service.js"),
  "/history":             require("./netlify/functions/history.js"),
  "/admin_panel":         require("./netlify/functions/admin_panel.js"),
};
Object.entries(routes).forEach(([p, mod]) => app.all(p, wrap(mod)));
 
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
 
app.use(express.static(path.join(__dirname, "public")));
 
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout  = 5 * 60 * 1000 + 1000;
 
const { Pool } = require("pg");
const { dbConfig } = require("./netlify/functions/_db");
const cleanPool = new Pool(dbConfig({ max: 2 }));
async function cleanupSessions() {
  try {
    const r = await cleanPool.query(
      `DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL '90 days'`
    );
    if (r.rowCount) console.log(`Housekeeping: удалено ${r.rowCount} старых сессий`);
  } catch (e) { console.error("Housekeeping error:", e.message); }
}
setInterval(cleanupSessions, 24 * 60 * 60 * 1000);
cleanupSessions();