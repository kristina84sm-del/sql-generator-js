const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { inferTopic, TOPIC_IDS, parseOralHint, normalizeTasks } = require("../netlify/functions/generate_sql_trainer");

describe("inferTopic", () => {
  it("keeps a valid enum topic", () => {
    assert.equal(inferTopic({ topic: "join", question: "x", solution_sql: "SELECT 1" }), "join");
  });

  it("falls back from Russian topic labels using SQL", () => {
    assert.equal(inferTopic({
      topic: "Соединения таблиц",
      question: "Покажи заказы с клиентами",
      solution_sql: "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id",
    }), "join");
  });

  it("detects windows from OVER()", () => {
    assert.equal(inferTopic({
      topic: "окна",
      question: "Ранжируй",
      solution_sql: "SELECT row_number() OVER (PARTITION BY user_id ORDER BY dt) FROM t",
    }), "window");
  });

  it("forces oral kind", () => {
    assert.equal(inferTopic({ kind: "oral", topic: "join", question: "Расскажи" }), "oral");
  });

  it("TOPIC_IDS covers trainer chips", () => {
    assert.ok(TOPIC_IDS.includes("select_where"));
    assert.ok(TOPIC_IDS.includes("oral"));
  });
});

describe("parseOralHint", () => {
  it("does not put the tip text on the button when given a plain string", () => {
    const tip = "определите категории курсов";
    const parsed = parseOralHint(tip, 0);
    assert.equal(parsed.label, "Направление");
    assert.equal(parsed.detail, tip);
    assert.notEqual(parsed.label, parsed.detail);
  });

  it("keeps object label and longer detail", () => {
    const parsed = parseOralHint({
      label: "Как проверить",
      detail: "Сравните средние доходы через AVG(amount) GROUP BY category_id",
    }, 1);
    assert.equal(parsed.label, "Как проверить");
    assert.match(parsed.detail, /AVG/);
  });

  it("if model stuffed the tip into label only, uses role as button", () => {
    const parsed = parseOralHint({ label: "сравните средние доходы" }, 1);
    assert.equal(parsed.label, "Как проверить");
    assert.equal(parsed.detail, "сравните средние доходы");
  });

  it("normalizeTasks maps string hints to label/detail pairs", () => {
    const [task] = normalizeTasks([{
      kind: "oral",
      question: "Как проверишь retention?",
      oral_hints: ["определите категории курсов", "сравните средние доходы"],
    }], "junior");
    assert.equal(task.oral_hints[0].label, "Направление");
    assert.equal(task.oral_hints[0].detail, "определите категории курсов");
    assert.equal(task.oral_hints[1].label, "Как проверить");
  });
});
