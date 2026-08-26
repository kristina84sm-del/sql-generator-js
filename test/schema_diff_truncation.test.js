const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSchemaDiff, extractTableNames } = require("../netlify/functions/_sql_migrate");

describe("buildSchemaDiff truncated CREATE", () => {
  it("does not treat incomplete OLD table as new CREATE", () => {
    const oldDdl = `
CREATE TABLE hotel (hotel_id INT PRIMARY KEY, name VARCHAR(255));
CREATE TABLE internal_task (
    internal_task_id INT PRIMARY KEY,
    hotel_id INT,
    FOREIGN KEY (hotel_id) REFERENCES hotel(hotel_i`;
    const newDdl = `
CREATE TABLE hotel (hotel_id INT PRIMARY KEY, name VARCHAR(255));
CREATE TABLE internal_task (
    internal_task_id INT PRIMARY KEY,
    hotel_id INT,
    assignee_id INT,
    status VARCHAR(255),
    FOREIGN KEY (hotel_id) REFERENCES hotel(hotel_id)
);`;
    assert.ok(extractTableNames(oldDdl).has("internal_task"));
    const diff = buildSchemaDiff(oldDdl, newDdl);
    assert.ok(!diff.addedTables.includes("internal_task"), "must not ask CREATE for truncated OLD table");
    assert.ok(!diff.text.includes("CREATE TABLE internal_task"));
  });
});
