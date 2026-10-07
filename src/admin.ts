import { Hono } from "hono";
import { getDb, generateSlug } from "./db";
import { requireAuth, requireAdmin } from "./auth";
import { validateQuestion, validateSettings, validateFormMeta } from "./validate";

// Semua route di sini butuh login admin. Dipasang di /api oleh app.ts.
// PENTING: jangan pakai use("*") — setelah di-mount, "*" akan ikut
// mencakup /api/public/* (route publik tanpa login).
const admin = new Hono();
admin.use("/forms", requireAuth);
admin.use("/forms/*", requireAuth);
admin.use("/questions/*", requireAuth);
admin.use("/users", requireAuth);
admin.use("/users/*", requireAuth);
// Catatan: requireAdmin dipasang per-route (bukan use), karena
// PATCH /users/me/password boleh diakses guru untuk passwordnya sendiri.

type CurUser = { id: number; username: string; role: string };
function curUser(c: any): CurUser {
  return c.get("user") as CurUser;
}

// Ambil formulir dengan cek kepemilikan: guru hanya miliknya, admin semua.
// Mengembalikan null bila tidak ada / bukan haknya (disamarkan sebagai 404).
function ownedForm(db: ReturnType<typeof getDb>, id: string | number, u: CurUser) {
  const f = db.query("SELECT * FROM forms WHERE id = ?").get(id) as any;
  if (!f) return null;
  if (u.role !== "admin" && f.owner_id !== u.id) return null;
  return f;
}

function formOut(r: any) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    settings: JSON.parse(r.settings || "{}"),
    is_published: !!r.is_published,
    owner_id: r.owner_id ?? null,
    owner_name: r.owner_name ?? null,
    question_count: r.question_count ?? 0,
    response_count: r.response_count ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function questionOut(r: any) {
  return {
    id: r.id,
    form_id: r.form_id,
    qtype: r.qtype,
    prompt: r.prompt,
    options: JSON.parse(r.options || "[]"),
    required: !!r.required,
    points: r.points,
    correct_answer: r.correct_answer ? JSON.parse(r.correct_answer) : null,
    is_identity: !!r.is_identity,
    order_index: r.order_index,
  };
}

function uniqueSlug(db: ReturnType<typeof getDb>): string {
  for (let i = 0; i < 20; i++) {
    const s = generateSlug();
    if (!db.query("SELECT 1 FROM forms WHERE slug = ?").get(s)) return s;
  }
  throw new Error("gagal membuat slug unik");
}

async function readJson(c: any) {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// ---------- FORMS ----------

admin.get("/forms", (c) => {
  const db = getDb();
  const u = curUser(c);
  const counts = `SELECT f.*,
        (SELECT COUNT(*) FROM questions q WHERE q.form_id = f.id) AS question_count,
        (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count,
        u.username AS owner_name
       FROM forms f LEFT JOIN users u ON u.id = f.owner_id`;
  const rows =
    u.role === "admin"
      ? db.query(`${counts} ORDER BY f.updated_at DESC`).all()
      : db.query(`${counts} WHERE f.owner_id = ? ORDER BY f.updated_at DESC`).all(u.id);
  return c.json({ forms: (rows as any[]).map(formOut) });
});

admin.post("/forms", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  const meta = validateFormMeta(body);
  if (!meta.ok) return c.json({ error: meta.error }, 400);
  const sv = validateSettings(body.settings ?? {});
  if (!sv.ok) return c.json({ error: sv.error }, 400);
  const db = getDb();
  const u = curUser(c);
  const slug = uniqueSlug(db);
  const info = db
    .query("INSERT INTO forms (slug, title, description, settings, owner_id) VALUES (?, ?, ?, ?, ?)")
    .run(slug, meta.value.title, meta.value.description, sv.value, u.id);
  const row = db.query("SELECT * FROM forms WHERE id = ?").get(Number(info.lastInsertRowid));
  return c.json({ form: formOut(row) }, 201);
});

admin.get("/forms/:id", (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = db
    .query(
      `SELECT f.*,
        (SELECT COUNT(*) FROM questions q WHERE q.form_id = f.id) AS question_count,
        (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count,
        u.username AS owner_name
       FROM forms f LEFT JOIN users u ON u.id = f.owner_id WHERE f.id = ?`
    )
    .get(c.req.param("id")) as any;
  if (!form || (u.role !== "admin" && form.owner_id !== u.id))
    return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(form.id) as any[];
  return c.json({ form: formOut(form), questions: questions.map(questionOut) });
});

admin.patch("/forms/:id", async (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = ownedForm(db, c.req.param("id"), u);
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);

  const updates: string[] = [];
  const params: unknown[] = [];
  if (body.title !== undefined || body.description !== undefined) {
    const meta = validateFormMeta({ title: body.title ?? form.title, description: body.description ?? form.description });
    if (!meta.ok) return c.json({ error: meta.error }, 400);
    updates.push("title = ?", "description = ?");
    params.push(meta.value.title, meta.value.description);
  }
  if (body.settings !== undefined) {
    const merged = { ...JSON.parse(form.settings || "{}"), ...body.settings };
    const sv = validateSettings(merged);
    if (!sv.ok) return c.json({ error: sv.error }, 400);
    updates.push("settings = ?");
    params.push(sv.value);
  }
  if (body.is_published !== undefined) {
    if (typeof body.is_published !== "boolean")
      return c.json({ error: "is_published harus boolean" }, 400);
    updates.push("is_published = ?");
    params.push(body.is_published ? 1 : 0);
  }
  if (updates.length === 0) return c.json({ error: "Tidak ada field yang diubah" }, 400);
  updates.push("updated_at = datetime('now')");
  params.push(form.id);
  db.query(`UPDATE forms SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  const row = db.query("SELECT * FROM forms WHERE id = ?").get(form.id);
  return c.json({ form: formOut(row) });
});

admin.delete("/forms/:id", (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = ownedForm(db, c.req.param("id"), u);
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  db.query("DELETE FROM forms WHERE id = ?").run(form.id);
  return c.json({ ok: true });
});

admin.post("/forms/:id/duplicate", (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = ownedForm(db, c.req.param("id"), u);
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(form.id) as any[];

  const slug = uniqueSlug(db);
  const tx = db.transaction(() => {
    const info = db
      .query("INSERT INTO forms (slug, title, description, settings, is_published, owner_id) VALUES (?, ?, ?, ?, 0, ?)")
      .run(slug, `${form.title} (salinan)`, form.description, form.settings, u.id);
    const newId = Number(info.lastInsertRowid);
    const ins = db.query(
      "INSERT INTO questions (form_id, qtype, prompt, options, required, points, correct_answer, is_identity, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const q of questions) {
      ins.run(newId, q.qtype, q.prompt, q.options, q.required, q.points, q.correct_answer, q.is_identity, q.order_index);
    }
    return newId;
  });
  const newId = tx();
  const row = db.query("SELECT * FROM forms WHERE id = ?").get(newId);
  return c.json({ form: formOut(row) }, 201);
});

// ---------- QUESTIONS ----------

admin.post("/forms/:id/questions", async (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = ownedForm(db, c.req.param("id"), u);
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  const v = validateQuestion(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const count = (db.query("SELECT COUNT(*) AS n FROM questions WHERE form_id = ?").get(form.id) as any).n;
  const order_index = body.order_index ?? count;
  const vv = validateQuestion({ ...body, order_index });
  if (!vv.ok) return c.json({ error: vv.error }, 400);
  const q = vv.value;
  const info = db
    .query(
      "INSERT INTO questions (form_id, qtype, prompt, options, required, points, correct_answer, is_identity, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(form.id, q.qtype, q.prompt, q.options, q.required ? 1 : 0, q.points, q.correct_answer, q.is_identity ? 1 : 0, q.order_index);
  if (q.is_identity)
    db.query("UPDATE questions SET is_identity = 0 WHERE form_id = ? AND id != ?").run(form.id, Number(info.lastInsertRowid));
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(form.id);
  const row = db.query("SELECT * FROM questions WHERE id = ?").get(Number(info.lastInsertRowid));
  return c.json({ question: questionOut(row) }, 201);
});

admin.patch("/questions/:qid", async (c) => {
  const db = getDb();
  const u = curUser(c);
  const existing = db.query("SELECT * FROM questions WHERE id = ?").get(c.req.param("qid")) as any;
  if (!existing) return c.json({ error: "Soal tidak ditemukan" }, 404);
  if (!ownedForm(db, existing.form_id, u)) return c.json({ error: "Soal tidak ditemukan" }, 404);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  // PATCH parsial: gabung dengan data lama lalu validasi penuh.
  const merged = {
    qtype: body.qtype ?? existing.qtype,
    prompt: body.prompt ?? existing.prompt,
    options: body.options ?? JSON.parse(existing.options || "[]"),
    required: body.required ?? !!existing.required,
    points: body.points ?? existing.points,
    correct_answer: body.correct_answer !== undefined ? body.correct_answer : existing.correct_answer ? JSON.parse(existing.correct_answer) : null,
    is_identity: body.is_identity ?? !!existing.is_identity,
    order_index: body.order_index ?? existing.order_index,
  };
  const v = validateQuestion(merged);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const q = v.value;
  db.query(
    "UPDATE questions SET qtype = ?, prompt = ?, options = ?, required = ?, points = ?, correct_answer = ?, is_identity = ?, order_index = ? WHERE id = ?"
  ).run(q.qtype, q.prompt, q.options, q.required ? 1 : 0, q.points, q.correct_answer, q.is_identity ? 1 : 0, q.order_index, existing.id);
  if (q.is_identity)
    db.query("UPDATE questions SET is_identity = 0 WHERE form_id = ? AND id != ?").run(existing.form_id, existing.id);
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(existing.form_id);
  const row = db.query("SELECT * FROM questions WHERE id = ?").get(existing.id);
  return c.json({ question: questionOut(row) });
});

admin.delete("/questions/:qid", (c) => {
  const db = getDb();
  const u = curUser(c);
  const q = db.query("SELECT form_id FROM questions WHERE id = ?").get(c.req.param("qid")) as any;
  if (!q) return c.json({ error: "Soal tidak ditemukan" }, 404);
  if (!ownedForm(db, q.form_id, u)) return c.json({ error: "Soal tidak ditemukan" }, 404);
  db.query("DELETE FROM questions WHERE id = ?").run(c.req.param("qid"));
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(q.form_id);
  return c.json({ ok: true });
});

admin.post("/forms/:id/questions/reorder", async (c) => {
  const db = getDb();
  const u = curUser(c);
  const form = ownedForm(db, c.req.param("id"), u);
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const body = await readJson(c);
  if (!body || !Array.isArray(body.order))
    return c.json({ error: "Body harus {order: [id_soal, ...]}" }, 400);
  const existing = (db.query("SELECT id FROM questions WHERE form_id = ?").all(form.id) as any[]).map((r) => r.id);
  const order = body.order.map(Number);
  if (order.length !== existing.length || new Set(order).size !== order.length || !order.every((id) => existing.includes(id)))
    return c.json({ error: "order harus memuat tepat semua id soal milik formulir ini" }, 400);
  const tx = db.transaction(() => {
    const upd = db.query("UPDATE questions SET order_index = ? WHERE id = ?");
    order.forEach((id: number, idx: number) => upd.run(idx, id));
    db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(form.id);
  });
  tx();
  return c.json({ ok: true });
});

// ---------- PENGGUNA (khusus admin) ----------

function userOut(r: any) {
  return { id: r.id, username: r.username, role: r.role, created_at: r.created_at };
}

function validUsername(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(t) ? t : null;
}

admin.get("/users", requireAdmin, (c) => {
  const db = getDb();
  const rows = db
    .query("SELECT id, username, role, created_at FROM users ORDER BY id ASC")
    .all();
  return c.json({ users: (rows as any[]).map(userOut) });
});

admin.post("/users", requireAdmin, async (c) => {
  const db = getDb();
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  const username = validUsername(body.username);
  if (!username) return c.json({ error: "Username 3–32 karakter: huruf, angka, titik, strip, underscore" }, 400);
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6 || password.length > 100)
    return c.json({ error: "Password 6–100 karakter" }, 400);
  const role = body.role === "admin" ? "admin" : "guru";
  const dup = db.query("SELECT 1 FROM users WHERE username = ?").get(username);
  if (dup) return c.json({ error: "Username sudah dipakai" }, 409);
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  const info = db
    .query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
    .run(username, hash, role);
  const row = db.query("SELECT id, username, role, created_at FROM users WHERE id = ?").get(Number(info.lastInsertRowid));
  return c.json({ user: userOut(row) }, 201);
});

admin.patch("/users/me/password", async (c) => {
  const db = getDb();
  const u = curUser(c);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(u.id) as any;
  const okOld = row ? await Bun.password.verify(String(body.old_password || ""), row.password_hash) : false;
  if (!okOld) return c.json({ error: "Password lama salah" }, 400);
  const np = typeof body.new_password === "string" ? body.new_password : "";
  if (np.length < 6 || np.length > 100) return c.json({ error: "Password baru 6–100 karakter" }, 400);
  const hash = await Bun.password.hash(np, { algorithm: "bcrypt", cost: 10 });
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  return c.json({ ok: true });
});

admin.patch("/users/:id", requireAdmin, async (c) => {
  const db = getDb();
  const target = db.query("SELECT id, username, role FROM users WHERE id = ?").get(c.req.param("id")) as any;
  if (!target) return c.json({ error: "Pengguna tidak ditemukan" }, 404);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  if (body.password === undefined) return c.json({ error: "Tidak ada field yang diubah" }, 400);
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6 || password.length > 100)
    return c.json({ error: "Password 6–100 karakter" }, 400);
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, target.id);
  // Paksa keluar semua sesi user tersebut.
  db.query("DELETE FROM sessions WHERE user_id = ?").run(target.id);
  return c.json({ ok: true });
});

admin.delete("/users/:id", requireAdmin, (c) => {
  const db = getDb();
  const u = curUser(c);
  const target = db.query("SELECT id, username, role FROM users WHERE id = ?").get(c.req.param("id")) as any;
  if (!target) return c.json({ error: "Pengguna tidak ditemukan" }, 404);
  if (target.id === u.id) return c.json({ error: "Tidak bisa menghapus akun sendiri" }, 400);
  if (target.role === "admin") {
    const n = (db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as any).n;
    if (n <= 1) return c.json({ error: "Tidak bisa menghapus satu-satunya admin" }, 400);
  }
  // Formulir miliknya ikut terhapus (ON DELETE CASCADE).
  db.query("DELETE FROM users WHERE id = ?").run(target.id);
  return c.json({ ok: true });
});

// Ganti password sendiri (untuk guru maupun admin).
admin.patch("/users/me/password", requireAuth, async (c) => {
  const db = getDb();
  const u = curUser(c);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Body harus JSON valid" }, 400);
  const row = db.query("SELECT password_hash FROM users WHERE id = ?").get(u.id) as any;
  const okOld = row ? await Bun.password.verify(String(body.old_password || ""), row.password_hash) : false;
  if (!okOld) return c.json({ error: "Password lama salah" }, 400);
  const np = typeof body.new_password === "string" ? body.new_password : "";
  if (np.length < 6 || np.length > 100) return c.json({ error: "Password baru 6–100 karakter" }, 400);
  const hash = await Bun.password.hash(np, { algorithm: "bcrypt", cost: 10 });
  db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  return c.json({ ok: true });
});

export default admin;
