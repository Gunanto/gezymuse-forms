import { Hono } from "hono";
import { getDb } from "./db";
import { requireAuth } from "./auth";

// API hasil (khusus admin). Dipasang di /api oleh app.ts.
// Tidak bentrok dengan admin.ts: route di sini semuanya di bawah
// /forms/:id/responses, /summary, dan /export/*.
const results = new Hono();
results.use("/forms", requireAuth);
results.use("/forms/*", requireAuth);

function escCsv(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function escHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function getForm(db: ReturnType<typeof getDb>, id: string) {
  return db.query("SELECT * FROM forms WHERE id = ?").get(id) as any;
}
function notFound(c: any) {
  return c.json({ error: "Formulir tidak ditemukan" }, 404);
}
function orderedQuestions(db: ReturnType<typeof getDb>, formId: number) {
  return db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(formId) as any[];
}
function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join("; ");
  return String(v);
}

// ---------- daftar & detail respons ----------

results.get("/forms/:id/responses", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const total = (db.query("SELECT COUNT(*) AS n FROM responses WHERE form_id = ?").get(form.id) as any).n;
  const rows = db
    .query(
      "SELECT id, score, submitted_at FROM responses WHERE form_id = ? ORDER BY submitted_at DESC, id DESC LIMIT ? OFFSET ?"
    )
    .all(form.id, limit, (page - 1) * limit);
  return c.json({ responses: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
});

results.get("/forms/:id/responses/:rid", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const r = db
    .query("SELECT id, score, submitted_at FROM responses WHERE id = ? AND form_id = ?")
    .get(c.req.param("rid"), form.id) as any;
  if (!r) return c.json({ error: "Respons tidak ditemukan" }, 404);
  const answers = db
    .query(
      `SELECT a.value, q.id AS qid, q.prompt, q.qtype FROM answers a
       JOIN questions q ON q.id = a.question_id
       WHERE a.response_id = ? ORDER BY q.order_index ASC, q.id ASC`
    )
    .all(r.id) as any[];
  return c.json({
    response: r,
    answers: answers.map((a) => ({ qid: a.qid, prompt: a.prompt, qtype: a.qtype, value: JSON.parse(a.value) })),
  });
});

results.delete("/forms/:id/responses/:rid", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const info = db.query("DELETE FROM responses WHERE id = ? AND form_id = ?").run(c.req.param("rid"), form.id);
  if (!info.changes) return c.json({ error: "Respons tidak ditemukan" }, 404);
  return c.json({ ok: true });
});

// Koreksi skor manual oleh admin (mis. setelah menilai soal teks).
results.patch("/forms/:id/responses/:rid/score", async (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body harus JSON valid" }, 400);
  }
  const score = Number(body?.score);
  if (!Number.isFinite(score) || score < 0)
    return c.json({ error: "score harus angka >= 0" }, 400);
  const questions = orderedQuestions(db, form.id);
  const totalPoints = questions.reduce((a, q) => a + (Number(q.points) || 0), 0);
  if (totalPoints > 0 && score > totalPoints)
    return c.json({ error: `score maks ${totalPoints} (total poin)` }, 400);
  const info = db
    .query("UPDATE responses SET score = ? WHERE id = ? AND form_id = ?")
    .run(score, c.req.param("rid"), form.id);
  if (!info.changes) return c.json({ error: "Respons tidak ditemukan" }, 404);
  return c.json({ ok: true, score });
});

// ---------- ringkasan per soal ----------

function summarizeQuestion(db: ReturnType<typeof getDb>, q: any, isQuiz: boolean) {
  const opts = JSON.parse(q.options || "[]");
  const rows = db.query("SELECT value FROM answers WHERE question_id = ?").all(q.id) as any[];
  const values = rows.map((r) => JSON.parse(r.value)).filter((v) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && v !== "");
  const base = {
    id: q.id,
    qtype: q.qtype,
    prompt: q.prompt,
    required: !!q.required,
    points: q.points,
    answered: values.length,
  };
  const t = q.qtype as string;

  if (t === "multiple_choice" || t === "dropdown" || t === "checkboxes") {
    const flat: string[] = [];
    for (const v of values) flat.push(...(Array.isArray(v) ? v : [v]));
    const options = (opts as string[]).map((o) => {
      const count = flat.filter((x) => x === o).length;
      return { option: o, count, pct: values.length ? Math.round((count / values.length) * 100) : 0 };
    });
    const out: any = { ...base, kind: "choice", options };
    if (isQuiz && q.correct_answer) {
      const ca = JSON.parse(q.correct_answer);
      let correct = 0;
      for (const v of values) {
        if (t === "checkboxes") {
          const a = [...new Set(v as string[])].sort();
          const b = [...new Set(ca as string[])].sort();
          if (a.length === b.length && a.every((x, i) => x === b[i])) correct++;
        } else if (v === ca) correct++;
      }
      out.quiz = { has_key: true, correct, accuracy_pct: values.length ? Math.round((correct / values.length) * 100) : 0 };
    }
    return out;
  }

  if (t === "linear_scale") {
    const nums = values.map(Number).filter((n) => Number.isInteger(n));
    const dist = [];
    for (let n = opts.min; n <= opts.max; n++)
      dist.push({ value: n, count: nums.filter((x) => x === n).length });
    const avg = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;
    const out: any = { ...base, kind: "scale", min: opts.min, max: opts.max, minLabel: opts.minLabel, maxLabel: opts.maxLabel, avg, dist };
    if (isQuiz && q.correct_answer) {
      const ca = Number(JSON.parse(q.correct_answer));
      const correct = nums.filter((n) => n === ca).length;
      out.quiz = { has_key: true, correct, accuracy_pct: nums.length ? Math.round((correct / nums.length) * 100) : 0 };
    }
    return out;
  }

  // teks: hitung + sampel terakhir
  const texts = values.filter((v) => typeof v === "string" && v.trim()) as string[];
  return { ...base, kind: "text", count: texts.length, samples: texts.slice(-20).reverse() };
}

results.get("/forms/:id/summary", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const settings = JSON.parse(form.settings || "{}");
  const questions = orderedQuestions(db, form.id);
  const total = (db.query("SELECT COUNT(*) AS n FROM responses WHERE form_id = ?").get(form.id) as any).n;
  const out: Record<string, unknown> = {
    form: { id: form.id, title: form.title, settings },
    total_responses: total,
    questions: questions.map((q) => summarizeQuestion(db, q, !!settings.is_quiz)),
  };
  if (settings.is_quiz) {
    const scores = (
      db.query("SELECT score FROM responses WHERE form_id = ? AND score IS NOT NULL").all(form.id) as any[]
    ).map((r) => Number(r.score));
    const totalPoints = questions
      .filter((q) => q.correct_answer)
      .reduce((a, q) => a + (Number(q.points) || 0), 0);
    out.score_stats = scores.length
      ? {
          count: scores.length,
          avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
          max: Math.max(...scores),
          min: Math.min(...scores),
          total_points: totalPoints,
        }
      : null;
  }
  return c.json(out);
});

// ---------- ekspor ----------

function exportMatrix(db: ReturnType<typeof getDb>, form: any) {
  const questions = orderedQuestions(db, form.id);
  const settings = JSON.parse(form.settings || "{}");
  const responses = db
    .query("SELECT id, score, submitted_at FROM responses WHERE form_id = ? ORDER BY submitted_at ASC, id ASC")
    .all(form.id) as any[];
  const ansRows = db
    .query("SELECT response_id, question_id, value FROM answers WHERE response_id IN (SELECT id FROM responses WHERE form_id = ?)")
    .all(form.id) as any[];
  const byResp = new Map<number, Map<number, unknown>>();
  for (const a of ansRows) {
    if (!byResp.has(a.response_id)) byResp.set(a.response_id, new Map());
    byResp.get(a.response_id)!.set(a.question_id, JSON.parse(a.value));
  }
  const head = ["No", "Waktu Submit"];
  if (settings.is_quiz) head.push("Skor");
  for (const q of questions) head.push(q.prompt.length > 40 ? q.prompt.slice(0, 40) + "…" : q.prompt);
  const body = responses.map((r, i) => {
    const row: unknown[] = [i + 1, r.submitted_at];
    if (settings.is_quiz) row.push(r.score ?? "");
    const m = byResp.get(r.id);
    for (const q of questions) row.push(fmtValue(m?.get(q.id)));
    return row;
  });
  return { head, body, questions, settings, total: responses.length, form };
}

results.get("/forms/:id/export.csv", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const { head, body } = exportMatrix(db, form);
  const csv = String.fromCharCode(0xfeff) + [head, ...body].map((row) => (row as unknown[]).map(escCsv).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="gezyform-${form.slug}-hasil.csv"`,
    },
  });
});

results.get("/forms/:id/export/word", (c) => {
  const db = getDb();
  const form = getForm(db, c.req.param("id"));
  if (!form) return notFound(c);
  const { head, body, total } = exportMatrix(db, form);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${escHtml(form.title)}</title>
<style>body{font-family:Calibri,Arial}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px;font-size:11pt;vertical-align:top}th{background:#e8eaf6}</style>
</head><body>
<h1>${escHtml(form.title)}</h1>
<p>${escHtml(form.description || "")}</p>
<p>Diekspor: ${new Date().toLocaleString("id-ID")} · ${total} respons</p>
<table><tr>${head.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr>
${(body as unknown[][]).map((row) => `<tr>${row.map((cell) => `<td>${escHtml(cell)}</td>`).join("")}</tr>`).join("")}
</table></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "application/msword; charset=utf-8",
      "Content-Disposition": `attachment; filename="gezyform-${form.slug}-hasil.doc"`,
    },
  });
});

export default results;
