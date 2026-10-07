import { Hono } from "hono";
import { getDb, generateSlug } from "./db";
import { requireAuth } from "./auth";
import { validateQuestion, validateSettings, validateFormMeta } from "./validate";

// Semua route di sini butuh login admin. Dipasang di /api oleh app.ts.
// PENTING: jangan pakai use("*") — setelah di-mount, "*" akan ikut
// mencakup /api/public/* (route publik tanpa login).
const admin = new Hono();
admin.use("/forms", requireAuth);
admin.use("/forms/*", requireAuth);
admin.use("/questions/*", requireAuth);

function formOut(r: any) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    settings: JSON.parse(r.settings || "{}"),
    is_published: !!r.is_published,
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
  const rows = db
    .query(
      `SELECT f.*,
        (SELECT COUNT(*) FROM questions q WHERE q.form_id = f.id) AS question_count,
        (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count
       FROM forms f ORDER BY f.updated_at DESC`
    )
    .all();
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
  const slug = uniqueSlug(db);
  const info = db
    .query("INSERT INTO forms (slug, title, description, settings) VALUES (?, ?, ?, ?)")
    .run(slug, meta.value.title, meta.value.description, sv.value);
  const row = db.query("SELECT * FROM forms WHERE id = ?").get(Number(info.lastInsertRowid));
  return c.json({ form: formOut(row) }, 201);
});

admin.get("/forms/:id", (c) => {
  const db = getDb();
  const form = db
    .query(
      `SELECT f.*,
        (SELECT COUNT(*) FROM questions q WHERE q.form_id = f.id) AS question_count,
        (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count
       FROM forms f WHERE f.id = ?`
    )
    .get(c.req.param("id")) as any;
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(form.id) as any[];
  return c.json({ form: formOut(form), questions: questions.map(questionOut) });
});

admin.patch("/forms/:id", async (c) => {
  const db = getDb();
  const form = db.query("SELECT * FROM forms WHERE id = ?").get(c.req.param("id")) as any;
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
  const info = db.query("DELETE FROM forms WHERE id = ?").run(c.req.param("id"));
  if (info.changes === 0) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  return c.json({ ok: true });
});

admin.post("/forms/:id/duplicate", (c) => {
  const db = getDb();
  const form = db.query("SELECT * FROM forms WHERE id = ?").get(c.req.param("id")) as any;
  if (!form) return c.json({ error: "Formulir tidak ditemukan" }, 404);
  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(form.id) as any[];

  const slug = uniqueSlug(db);
  const tx = db.transaction(() => {
    const info = db
      .query("INSERT INTO forms (slug, title, description, settings, is_published) VALUES (?, ?, ?, ?, 0)")
      .run(slug, `${form.title} (salinan)`, form.description, form.settings);
    const newId = Number(info.lastInsertRowid);
    const ins = db.query(
      "INSERT INTO questions (form_id, qtype, prompt, options, required, points, correct_answer, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const q of questions) {
      ins.run(newId, q.qtype, q.prompt, q.options, q.required, q.points, q.correct_answer, q.order_index);
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
  const form = db.query("SELECT id FROM forms WHERE id = ?").get(c.req.param("id")) as any;
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
      "INSERT INTO questions (form_id, qtype, prompt, options, required, points, correct_answer, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(form.id, q.qtype, q.prompt, q.options, q.required ? 1 : 0, q.points, q.correct_answer, q.order_index);
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(form.id);
  const row = db.query("SELECT * FROM questions WHERE id = ?").get(Number(info.lastInsertRowid));
  return c.json({ question: questionOut(row) }, 201);
});

admin.patch("/questions/:qid", async (c) => {
  const db = getDb();
  const existing = db.query("SELECT * FROM questions WHERE id = ?").get(c.req.param("qid")) as any;
  if (!existing) return c.json({ error: "Soal tidak ditemukan" }, 404);
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
    order_index: body.order_index ?? existing.order_index,
  };
  const v = validateQuestion(merged);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const q = v.value;
  db.query(
    "UPDATE questions SET qtype = ?, prompt = ?, options = ?, required = ?, points = ?, correct_answer = ?, order_index = ? WHERE id = ?"
  ).run(q.qtype, q.prompt, q.options, q.required ? 1 : 0, q.points, q.correct_answer, q.order_index, existing.id);
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(existing.form_id);
  const row = db.query("SELECT * FROM questions WHERE id = ?").get(existing.id);
  return c.json({ question: questionOut(row) });
});

admin.delete("/questions/:qid", (c) => {
  const db = getDb();
  const q = db.query("SELECT form_id FROM questions WHERE id = ?").get(c.req.param("qid")) as any;
  if (!q) return c.json({ error: "Soal tidak ditemukan" }, 404);
  db.query("DELETE FROM questions WHERE id = ?").run(c.req.param("qid"));
  db.query("UPDATE forms SET updated_at = datetime('now') WHERE id = ?").run(q.form_id);
  return c.json({ ok: true });
});

admin.post("/forms/:id/questions/reorder", async (c) => {
  const db = getDb();
  const form = db.query("SELECT id FROM forms WHERE id = ?").get(c.req.param("id")) as any;
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

export default admin;
