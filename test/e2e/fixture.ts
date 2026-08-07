import { Database } from "bun:sqlite";

export const E2E_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
    done BOOLEAN NOT NULL DEFAULT 0,
    metadata JSON,
    generated_label TEXT GENERATED ALWAYS AS (title || '!') STORED,
    UNIQUE (project_id, title)
  );

  CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE done = 0;

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
  );

  CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    visible BOOLEAN NOT NULL DEFAULT 1,
    PRIMARY KEY (task_id, tag_id)
  );

  CREATE TABLE representations (
    id INTEGER PRIMARY KEY,
    unsafe_integer INTEGER,
    enabled BOOLEAN,
    payload JSON,
    bytes BLOB
  );

  CREATE TABLE disposable (
    id INTEGER PRIMARY KEY
  );

  INSERT INTO projects VALUES
    (10, 'REST 0.1'),
    (11, 'Private project');

  INSERT INTO tasks (id, project_id, title, priority, done, metadata) VALUES
    (1, 10, 'Write contract', 3, 0, NULL),
    (2, 10, 'Review contract', 2, 0, NULL),
    (3, 11, 'Private task', 9, 1, '{"private":true}');

  INSERT INTO tags VALUES
    (20, 'docs'),
    (21, 'hidden');

  INSERT INTO task_tags VALUES
    (1, 20, 1),
    (1, 21, 0);

  INSERT INTO representations VALUES
    (1, 9007199254740992, 1, '{"ok":true}', X'00A5FF');

  INSERT INTO disposable VALUES (1), (2);
`;

/** Creates the on-disk database used by one isolated black-box server. */
export function createE2EDatabase(databasePath: string): void {
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.run(E2E_SCHEMA);
  } finally {
    database.close();
  }
}
