import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _db: Database | null = null;

// Tabel pelacak migrasi dibuat dulu sebelum dicek.
const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL DEFAULT (datetime('now')))`;

// Migrasi idempoten: tiap entri = satu versi skema.
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'guru',
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS forms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slug TEXT UNIQUE NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     settings TEXT NOT NULL DEFAULT '{}',
     is_published INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     qtype TEXT NOT NULL,
     prompt TEXT NOT NULL,
     options TEXT NOT NULL DEFAULT '[]',
     required INTEGER NOT NULL DEFAULT 0,
     points REAL NOT NULL DEFAULT 0,
     correct_answer TEXT,
     is_identity INTEGER NOT NULL DEFAULT 0,
     validation TEXT NOT NULL DEFAULT '',
     order_index INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_questions_form ON questions(form_id, order_index)`,
  `CREATE TABLE IF NOT EXISTS responses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     identity_key TEXT,
     score REAL,
     submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_form ON responses(form_id)`,
  `CREATE INDEX IF NOT EXISTS idx_responses_identity ON responses(form_id, identity_key)`,
  `CREATE TABLE IF NOT EXISTS answers (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
     question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
     value TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_answers_response ON answers(response_id)`,
];

export function initDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "gezyform.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(BOOTSTRAP);
  // Fixup kolom: HARUS jalan sebelum loop MIGRATIONS, karena sebagian
  // migrasi (mis. CREATE INDEX) mengacu ke kolom-kolom ini.
  // Di instalasi fresh tabel belum ada — lewati fixup bila tabel belum tersedia.
  const hasTable = (table: string) =>
    db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).get();
  const hasCol = (table: string, col: string) =>
    hasTable(table) &&
    db.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${col}'`).get();
  // 2026-10-07: kolom identitas bawaan (respondent_name/respondent_class) dihapus —
  // Nama/Kelas kini dibuat manual sebagai soal oleh admin.
  for (const col of ["respondent_name", "respondent_class"]) {
    if (hasCol("responses", col)) db.exec(`ALTER TABLE responses DROP COLUMN ${col}`);
  }
  // 2026-10-07: kunci identitas (satu pengisian per jawaban) + edit jawaban.
  if (hasTable("questions") && !hasCol("questions", "is_identity"))
    db.exec("ALTER TABLE questions ADD COLUMN is_identity INTEGER NOT NULL DEFAULT 0");
  if (hasTable("questions") && !hasCol("questions", "validation"))
    db.exec("ALTER TABLE questions ADD COLUMN validation TEXT NOT NULL DEFAULT ''");
  if (hasTable("responses") && !hasCol("responses", "identity_key"))
    db.exec("ALTER TABLE responses ADD COLUMN identity_key TEXT");
  if (hasTable("responses") && !hasCol("responses", "updated_at"))
    db.exec("ALTER TABLE responses ADD COLUMN updated_at TEXT");
  if (hasTable("responses"))
    db.exec("CREATE INDEX IF NOT EXISTS idx_responses_identity ON responses(form_id, identity_key)");
  // 2026-10-07: multi-user — peran admin/guru + kepemilikan formulir.
  if (hasTable("users") && !hasCol("users", "role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'guru'");
    db.exec("UPDATE users SET role = 'admin' WHERE username = 'admin'");
  }
  if (hasTable("forms") && !hasCol("forms", "owner_id")) {
    db.exec("ALTER TABLE forms ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
    db.exec("UPDATE forms SET owner_id = (SELECT id FROM users WHERE username = 'admin' LIMIT 1) WHERE owner_id IS NULL");
  }
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const v = i + 1;
    const done = db.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(v);
    if (!done) {
      db.exec(MIGRATIONS[i]);
      db.query("INSERT INTO schema_migrations (version) VALUES (?)").run(v);
    }
  }
  _db = db;
  return db;
}

export function getDb(): Database {
  if (!_db) throw new Error("DB belum diinisialisasi (panggil initDb dulu)");
  return _db;
}

// Slug publik: 8 karakter ramah URL (tanpa huruf yang ambigu).
export function generateSlug(len = 8): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

// Buat akun admin pertama. Password dari env ADMIN_PASSWORD;
// kalau tidak ada, dibuat acak dan ditampilkan sekali di console.
export async function ensureAdmin(): Promise<{ username: string; generatedPassword: string | null }> {
  const db = getDb();
  const existing = db.query("SELECT id FROM users LIMIT 1").get();
  if (existing) return { username: "admin", generatedPassword: null };
  let password = process.env.ADMIN_PASSWORD;
  let generated: string | null = null;
  if (!password) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    password = Buffer.from(bytes).toString("base64url");
    generated = password;
  }
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  db.query("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
  return { username: "admin", generatedPassword: generated };
}
