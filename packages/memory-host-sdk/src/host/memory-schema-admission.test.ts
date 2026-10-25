import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import {
  prepareSqliteDatabaseCleanClose,
  revokeSqliteDatabaseAdmissions,
} from "../../../../src/infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../../../../src/infra/sqlite-integrity.js";
import { admitSqliteSchema } from "../../../../src/infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../../../src/state/openclaw-agent-schema.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const schemaSql =
  /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:main\.)?(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu;

function ftsMatches(db: DatabaseSync, word: string) {
  return db
    .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
    .all(word);
}

function insertChunk(db: DatabaseSync, id: string, text = "body") {
  db.prepare(`INSERT INTO memory_index_chunks
    (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
    VALUES (?, 'notes.md', 'memory', 1, 1, 'hash', 'model', ?, X'', 17)`).run(id, text);
}

function ensure(db: DatabaseSync) {
  return ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
}

function expectSchema(db: DatabaseSync) {
  expect(ensure(db)).toEqual({ ftsAvailable: true });
}

function observe(before?: Parameters<typeof observeHostDataSql>[0]) {
  const observed = observeHostDataSql(before);
  return {
    expectAdmission(db: DatabaseSync, reused = true) {
      observed.queries.length = 0;
      expectSchema(db);
      const schema = observed.queries.filter((sql) => schemaSql.test(sql));
      expect(schema.length > 0).toBe(!reused);
    },
    [Symbol.dispose]: observed.restore,
  };
}

it.each(["clean", "missing seal"])("reopens after %s without losing schema repair", (close) => {
  const filename = path.join(tempDirs.make("memory-admission-seal-"), "memory.sqlite");
  {
    using db = openNodeSqliteDatabase(filename);
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    admitSqliteSchema(db);
    runSqliteImmediateTransactionSync(db, () => expectSchema(db));
    insertChunk(db, "retained", "searchable body");
    assertSqliteIntegrity(db, "memory index");
    using seal = prepareSqliteDatabaseCleanClose(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(seal.publish()).toBe(true);
  }
  if (close === "missing seal") {
    fs.unlinkSync(`${filename}.seal`);
  }
  using db = openNodeSqliteDatabase(filename);
  admitSqliteSchema(db);
  using observed = observe();
  observed.expectAdmission(db, close === "clean");
  db.exec("DROP INDEX idx_memory_index_chunks_source");
  ensure(db);
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
      .get("idx_memory_index_chunks_source")?.name,
  ).toBe("idx_memory_index_chunks_source");
  expect(ftsMatches(db, "searchable")).toEqual([{ id: "retained" }]);
});

it.each(["commit", "rollback", "later DDL", "revocation"])(
  "publishes only final committed initialization after %s",
  (outcome) => {
    const filename = path.join(tempDirs.make("memory-admission-transaction-"), "memory.sqlite");
    using db = openNodeSqliteDatabase(filename);
    admitSqliteSchema(db);
    using peer = openNodeSqliteDatabase(filename);
    const transact = () =>
      runSqliteImmediateTransactionSync(db, () => {
        ensure(db);
        if (outcome === "rollback") {
          throw new Error("synthetic initialization rollback");
        }
        if (outcome === "later DDL") {
          db.exec("DROP TABLE memory_index_sources");
        }
        if (outcome === "revocation") {
          revokeSqliteDatabaseAdmissions(peer);
        }
      });
    if (outcome === "rollback") {
      expect(transact).toThrow("synthetic initialization rollback");
    } else {
      transact();
    }
    using observed = observe();
    observed.expectAdmission(db, outcome === "commit");
    expect(db.prepare("SELECT path FROM memory_index_sources").all()).toEqual([]);
  },
);

it("admits a fresh shadow and backfills later imports across handles", () => {
  const filename = path.join(tempDirs.make("memory-admission-"), "memory.sqlite");
  using sibling = openNodeSqliteDatabase(filename);
  admitSqliteSchema(sibling);
  using observed = observe();
  expect(
    ensureMemoryIndexSchema({ db: sibling, cacheEnabled: true, ftsEnabled: true, fresh: true }),
  ).toEqual({ ftsAvailable: true });
  using db = openNodeSqliteDatabase(filename);
  observed.expectAdmission(db);
  insertChunk(db, "import");
  db.exec(`
          INSERT OR IGNORE INTO memory_index_sources (path, source, hash, mtime, size)
            VALUES ('notes.md', 'memory', 'hash', 1, 1);
          DELETE FROM memory_index_chunks_fts;
          DELETE FROM memory_index_paths_fts;
        `);
  observed.expectAdmission(db);
  const provenance = db.prepare(
    "SELECT origin_class FROM memory_index_chunk_provenance WHERE chunk_id = ?",
  );
  expect(provenance.get("import")).toEqual({ origin_class: "untrusted" });
  expect(ftsMatches(db, "body")).toHaveLength(1);
  const paths = db.prepare("SELECT path FROM memory_index_paths_fts").all();
  expect(paths).toEqual([{ path: "notes.md" }]);
});

it("retries transient FTS initialization failure on a later handle", () => {
  const filename = path.join(tempDirs.make("memory-admission-retry-"), "memory.sqlite");
  let failFts = true;
  using _ = observe((sql) => {
    if (failFts && /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(sql)) {
      failFts = false;
      throw Object.assign(new Error("database is locked"), { errcode: 5 });
    }
  });
  {
    using db = openNodeSqliteDatabase(filename);
    expect(ensure(db)).toEqual({
      ftsAvailable: false,
      ftsError: expect.stringContaining("database is locked"),
    });
    insertChunk(db, "retry", "recovered body");
  }
  using db = openNodeSqliteDatabase(filename);
  expectSchema(db);
  expect(ftsMatches(db, "recovered")).toEqual([{ id: "retry" }]);
});
