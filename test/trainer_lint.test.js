const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  lintSolutionSql,
  filterSafeTasks,
  extractOuterJoinAliases,
} = require("../netlify/functions/generate_sql_trainer");

const SCHEMA = `
CREATE TABLE "User" (id INT PRIMARY KEY);
CREATE TABLE "Account" (id INT PRIMARY KEY, user_id INT);
CREATE TABLE "Transaction" (id INT PRIMARY KEY, account_id INT, created_at TIMESTAMP);
`;

describe("extractOuterJoinAliases", () => {
  it("picks aliases from LEFT JOIN", () => {
    const sql = `SELECT 1 FROM "User" u LEFT JOIN "Account" a ON u.id = a.user_id LEFT JOIN "Transaction" t ON a.id = t.account_id`;
    const aliases = extractOuterJoinAliases(sql);
    assert.ok(aliases.includes("a"));
    assert.ok(aliases.includes("t"));
  });
});

describe("lintSolutionSql outer join + WHERE", () => {
  it("flags the classic LEFT JOIN + WHERE on right table (trainer shame case)", () => {
    const sql = `
WITH user_activity AS (
  SELECT u.id AS user_id, COUNT(t.id) AS transaction_count
  FROM "User" u
  LEFT JOIN "Account" a ON u.id = a.user_id
  LEFT JOIN "Transaction" t ON a.id = t.account_id
  WHERE t.created_at >= NOW() - INTERVAL '3 months'
  GROUP BY u.id
)
SELECT COUNT(*) AS total_users FROM user_activity`;
    const issues = lintSolutionSql(sql, SCHEMA);
    assert.ok(issues.some(i => i.startsWith("outer_join_where:")), issues.join(","));
  });

  it("allows filter on right table inside ON", () => {
    const sql = `
SELECT u.id, COUNT(t.id)
FROM "User" u
LEFT JOIN "Account" a ON u.id = a.user_id
LEFT JOIN "Transaction" t
  ON a.id = t.account_id
 AND t.created_at >= NOW() - INTERVAL '3 months'
GROUP BY u.id`;
    const issues = lintSolutionSql(sql, SCHEMA);
    assert.equal(issues.length, 0, issues.join(","));
  });

  it("allows WHERE alias.col IS NULL (anti-join)", () => {
    const sql = `
SELECT u.id
FROM "User" u
LEFT JOIN "Account" a ON u.id = a.user_id
WHERE a.id IS NULL`;
    const issues = lintSolutionSql(sql, SCHEMA);
    assert.equal(issues.length, 0, issues.join(","));
  });

  it("flags unknown table", () => {
    const sql = `SELECT * FROM "User" u JOIN ghost g ON g.id = u.id`;
    const issues = lintSolutionSql(sql, SCHEMA);
    assert.ok(issues.some(i => i === "unknown_table:ghost"), issues.join(","));
  });

  it("flags empty sql", () => {
    assert.deepEqual(lintSolutionSql("", SCHEMA), ["empty_sql"]);
  });
});

describe("filterSafeTasks", () => {
  it("drops bad sql эталон and keeps oral + good sql", () => {
    const { kept, dropped } = filterSafeTasks([
      {
        id: 1,
        kind: "sql",
        title: "bad",
        question: "q",
        solution_sql: `SELECT u.id FROM "User" u LEFT JOIN "Transaction" t ON t.account_id = u.id WHERE t.created_at > NOW()`,
      },
      {
        id: 2,
        kind: "sql",
        title: "good",
        question: "q2",
        solution_sql: `SELECT u.id FROM "User" u LEFT JOIN "Transaction" t ON t.account_id = u.id AND t.created_at > NOW()`,
      },
      { id: 3, kind: "oral", title: "talk", question: "how?", solution_sql: "" },
    ], SCHEMA);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].title, "bad");
    assert.ok(kept.some(t => t.title === "good"));
    assert.ok(kept.some(t => t.kind === "oral"));
  });
});
