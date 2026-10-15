/** Direct cost of the per-write DELETE on entity_index (scan vs index). */

import Database from "better-sqlite3";

for (const rows of [20_000, 100_000, 300_000]) {
  for (const withIndex of [false, true]) {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE entity_index (
        entity TEXT NOT NULL,
        node_id TEXT NOT NULL,
        PRIMARY KEY (entity, node_id)
      );
      CREATE INDEX idx_entity_index_entity ON entity_index(entity);
      ${withIndex ? "CREATE INDEX idx_entity_index_node ON entity_index(node_id);" : ""}
    `);
    const nodeIns = db.prepare("INSERT OR IGNORE INTO nodes (id) VALUES (?)");
    const insert = db.prepare(
      "INSERT INTO entity_index (entity, node_id) VALUES (?, ?)",
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        nodeIns.run(`node-${i}`);
        for (let e = 0; e < 5; e++) {
          insert.run(`entity-${(i * 7 + e) % 5000}`, `node-${i}`);
        }
      }
    });
    tx();
    const del = db.prepare("DELETE FROM entity_index WHERE node_id = ?");
    const t0 = performance.now();
    const dtx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) del.run(`node-${i}`);
    });
    dtx(1000);
    const ms = performance.now() - t0;
    console.log(
      `rows=${rows} node_id_index=${withIndex ? "yes" : "no "}  1000 deletes: ${ms.toFixed(1)}ms (${(ms / 1000).toFixed(3)}ms each)`,
    );
    db.close();
  }
}
