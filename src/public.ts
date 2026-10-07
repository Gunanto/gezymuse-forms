import { Hono } from "hono";
import { getDb } from "./db";
import { clientIp } from "./auth";

// Endpoint publik responden. Dipasang di /api/public oleh app.ts.
// Kunci jawaban TIDAK PERNAH dikirim ke publik.
const pub = new Hono();

// Rate-limit submit: 20x / IP / 10 menit -> 429 (anti spam/bot).
const submits = new Map<string, { count: number; resetAt: number }>();
const MAX_SUBMITS = 20;
const WINDOW_MS = 10 * 60 * 1000;

// Rate-limit baca skema publik: 120x / IP / 10 menit -> 429 (anti scraping).
const reads = new Map<string, { count: number; resetAt: number }>();
const MAX_READS = 120;

function hit(map: Map<string, { count: number; resetAt: number }>, ip: string, max: number): boolean {
  const now = Date.now();
  const rec = map.get(ip);
  if (rec && now < rec.resetAt && rec.count >= max) return true;
  if (!rec || now >= rec.resetAt) map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else rec.count++;
  return false;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Availability =
  | { ok: true; form: any; settings: any }
  | { ok: false; status: 404 | 403; error: string };

function checkAvailability(db: ReturnType<typeof getDb>, slug: string): Availability {
  const form = db.query("SELECT * FROM forms WHERE slug = ?").get(slug) as any;
  if (!form || !form.is_published)
    return { ok: false, status: 404, error: "Formulir tidak ditemukan atau belum dipublikasikan." };
  const settings = JSON.parse(form.settings || "{}");
  if (!settings.accept_responses)
    return { ok: false, status: 403, error: "Formulir ini sudah tidak menerima respons." };
  if (settings.deadline && Date.now() > Date.parse(settings.deadline))
    return { ok: false, status: 403, error: "Batas waktu pengisian formulir sudah lewat." };
  if (settings.max_responses) {
    const n = (db.query("SELECT COUNT(*) AS n FROM responses WHERE form_id = ?").get(form.id) as any).n;
    if (n >= settings.max_responses)
      return { ok: false, status: 403, error: "Jumlah respons sudah mencapai batas maksimal." };
  }
  return { ok: true, form, settings };
}

// Skema soal versi publik: tanpa correct_answer.
function publicQuestion(q: any) {
  return {
    id: q.id,
    qtype: q.qtype,
    prompt: q.prompt,
    options: JSON.parse(q.options || "[]"),
    required: !!q.required,
    points: q.points,
  };
}

pub.get("/forms/:slug", (c) => {
  const db = getDb();
  if (hit(reads, clientIp(c), MAX_READS))
    return c.json({ error: "Terlalu banyak permintaan. Coba lagi nanti." }, 429);
  const av = checkAvailability(db, c.req.param("slug"));
  if (!av.ok) return c.json({ error: av.error }, av.status);
  let questions = (
    db.query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC").all(av.form.id) as any[]
  ).map(publicQuestion);
  const s = av.settings;
  if (s.shuffle_questions) questions = shuffle(questions);
  if (s.shuffle_options)
    questions = questions.map((q) => ({
      ...q,
      options: Array.isArray(q.options) ? shuffle(q.options) : q.options,
    }));
  const idRow = db
    .query("SELECT id FROM questions WHERE form_id = ? AND is_identity = 1")
    .get(av.form.id) as any;
  return c.json({
    form: {
      title: av.form.title,
      description: av.form.description,
      settings: {
        is_quiz: !!s.is_quiz,
        show_score: s.show_score !== false,
        // Ubah jawaban otomatis nonaktif untuk kuis (mencegah iterasi nilai setelah kunci terlihat).
        allow_edit: !!s.allow_edit && !s.is_quiz,
        identity_qid: idRow ? idRow.id : null,
        deadline: s.deadline || null,
      },
    },
    questions,
  });
});

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

// Validasi satu jawaban terhadap definisi soal. Mengembalikan {value} atau {error}.
function validateAnswer(q: any, raw: unknown): { value?: unknown; error?: string } {
  const opts = JSON.parse(q.options || "[]");
  const t = q.qtype as string;
  if (t === "short_text" || t === "paragraph") {
    if (typeof raw !== "string") return { error: "jawaban harus teks" };
    const v = raw.trim().slice(0, 2000);
    return { value: v };
  }
  if (t === "multiple_choice" || t === "dropdown") {
    if (typeof raw !== "string" || !opts.includes(raw)) return { error: "pilihan tidak valid" };
    return { value: raw };
  }
  if (t === "checkboxes") {
    if (!Array.isArray(raw) || raw.length === 0) return { error: "jawaban harus array pilihan" };
    const clean = [...new Set(raw.map(String))];
    if (clean.length > opts.length || !clean.every((x) => opts.includes(x)))
      return { error: "pilihan tidak valid" };
    return { value: clean };
  }
  if (t === "linear_scale") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < opts.min || n > opts.max)
      return { error: `jawaban harus bilangan bulat ${opts.min}–${opts.max}` };
    return { value: n };
  }
  return { error: "tipe soal tidak dikenal" };
}

// Benar/salah per soal (khusus is_quiz). null = tidak bisa dinilai otomatis
// (tanpa kunci, atau soal teks yang perlu dinilai manual).
function checkCorrect(q: any, value: unknown): boolean | null {
  const ca = q.correct_answer ? JSON.parse(q.correct_answer) : null;
  if (ca === null || ca === undefined) return null;
  const t = q.qtype as string;
  if (t === "multiple_choice" || t === "dropdown") return value === ca;
  if (t === "checkboxes") {
    const a = [...new Set(value as string[])].sort();
    const b = [...new Set(ca as string[])].sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (t === "linear_scale") return Number(value) === ca;
  return null;
}

// Nilai otomatis (khusus is_quiz). Soal teks tidak dinilai otomatis.
function scoreQuestion(q: any, value: unknown): number {
  if (!checkCorrect(q, value)) return 0;
  return Number(q.points) || 0;
}

// Normalisasi kunci identitas: bandingkan tanpa peduli huruf besar/kecil & spasi.
function normIdentity(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t ? t.slice(0, 200) : null;
}

type Validated = { qid: number; valueJson: string; score: number; correct: boolean | null };

// Validasi semua jawaban terhadap definisi soal. Dipakai POST (baru) & PUT (ubah).
function validateSubmission(
  questions: any[],
  answers: Record<string, unknown>,
  isQuiz: boolean
): { ok: true; validated: Validated[]; score: number; totalPoints: number } | { ok: false; error: string } {
  const validated: Validated[] = [];
  let score = 0;
  let totalPoints = 0;
  for (const q of questions) {
    const raw = answers[String(q.id)] ?? answers[q.id];
    if (isEmpty(raw)) {
      if (q.required)
        return { ok: false, error: `Pertanyaan wajib diisi: "${q.prompt.slice(0, 80)}"` };
      validated.push({ qid: q.id, valueJson: JSON.stringify(null), score: 0, correct: null });
      continue;
    }
    const v = validateAnswer(q, raw);
    if (v.error) return { ok: false, error: `Soal "${q.prompt.slice(0, 80)}": ${v.error}` };
    const correct = isQuiz ? checkCorrect(q, v.value) : null;
    const qs = correct ? Number(q.points) || 0 : 0;
    score += qs;
    if (isQuiz && q.correct_answer) totalPoints += Number(q.points) || 0;
    validated.push({ qid: q.id, valueJson: JSON.stringify(v.value), score: qs, correct });
  }
  return { ok: true, validated, score, totalPoints };
}

function readAnswersBody(body: any): { ok: true; answers: Record<string, unknown> } | { ok: false; error: string } {
  const answers = body?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return { ok: false, error: "answers harus objek {id_soal: jawaban}" };
  return { ok: true, answers };
}

pub.post("/forms/:slug/submit", async (c) => {
  const db = getDb();
  const ip = clientIp(c);
  if (hit(submits, ip, MAX_SUBMITS))
    return c.json({ error: "Terlalu banyak pengiriman. Coba lagi beberapa menit." }, 429);

  const av = checkAvailability(db, c.req.param("slug"));
  if (!av.ok) return c.json({ error: av.error }, av.status);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body harus JSON valid" }, 400);
  }
  const ab = readAnswersBody(body);
  if (!ab.ok) return c.json({ error: ab.error }, 400);

  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(av.form.id) as any[];
  const s = av.settings;
  const isQuiz = !!s.is_quiz;

  const vs = validateSubmission(questions, ab.answers, isQuiz);
  if (!vs.ok) return c.json({ error: vs.error }, 400);
  const { validated, score, totalPoints } = vs;

  // Kunci identitas: satu pengisian per jawaban soal yang ditandai.
  const idQ = questions.find((q) => q.is_identity);
  let identityKey: string | null = null;
  if (idQ) {
    const v = validated.find((a) => a.qid === idQ.id);
    identityKey = normIdentity(v ? JSON.parse(v.valueJson) : null);
  }
  if (identityKey) {
    const dup = db
      .query("SELECT id FROM responses WHERE form_id = ? AND identity_key = ?")
      .get(av.form.id, identityKey) as any;
    if (dup) {
      const canEdit = !!s.allow_edit && !isQuiz;
      return c.json(
        canEdit
          ? { error: "Identitas ini sudah mengisi formulir.", code: "already_submitted" }
          : { error: "Identitas ini sudah mengisi formulir ini." },
        409
      );
    }
  }

  const tx = db.transaction(() => {
    const info = db
      .query("INSERT INTO responses (form_id, identity_key, score) VALUES (?, ?, ?)")
      .run(av.form.id, identityKey, isQuiz ? score : null);
    const rid = Number(info.lastInsertRowid);
    const ins = db.query("INSERT INTO answers (response_id, question_id, value) VALUES (?, ?, ?)");
    for (const a of validated) ins.run(rid, a.qid, a.valueJson);
    return rid;
  });
  tx();

  const out: Record<string, unknown> = { ok: true, message: "Jawaban terkirim. Terima kasih!" };
  if (isQuiz && s.show_score !== false) {
    out.score = score;
    out.total_points = totalPoints;
    // Pembahasan per soal (ala Google Forms): kunci hanya tampil bila
    // show_score aktif — sesuai pengaturan pemilik formulir.
    out.review = questions.map((q, i) => {
      const v = validated[i];
      const pts = Number(q.points) || 0;
      const auto = v.correct !== null;
      return {
        prompt: q.prompt,
        qtype: q.qtype,
        points: pts,
        your_answer: JSON.parse(v.valueJson),
        correct_answer: auto ? JSON.parse(q.correct_answer) : null,
        is_correct: v.correct,
        points_earned: v.score,
        needs_manual: !auto && pts > 0,
      };
    });
  }
  return c.json(out);
});

// Ambil jawaban sendiri untuk diubah (berdasar kunci identitas).
pub.get("/forms/:slug/mine", (c) => {
  const db = getDb();
  if (hit(reads, clientIp(c), MAX_READS))
    return c.json({ error: "Terlalu banyak permintaan. Coba lagi nanti." }, 429);
  const av = checkAvailability(db, c.req.param("slug"));
  if (!av.ok) return c.json({ error: av.error }, av.status);
  const s = av.settings;
  if (!s.allow_edit || s.is_quiz)
    return c.json({ error: "Fitur ubah jawaban tidak aktif untuk formulir ini." }, 403);
  const hasId = db
    .query("SELECT 1 FROM questions WHERE form_id = ? AND is_identity = 1")
    .get(av.form.id);
  if (!hasId) return c.json({ error: "Formulir ini tidak memakai kunci identitas." }, 400);
  const identity = normIdentity(c.req.query("identity"));
  if (!identity) return c.json({ error: "Identitas wajib diisi." }, 400);
  const resp = db
    .query("SELECT id FROM responses WHERE form_id = ? AND identity_key = ?")
    .get(av.form.id, identity) as any;
  if (!resp) return c.json({ error: "Identitas tidak ditemukan." }, 404);
  const rows = db
    .query("SELECT question_id, value FROM answers WHERE response_id = ?")
    .all(resp.id) as any[];
  const answers: Record<string, unknown> = {};
  for (const r of rows) answers[r.question_id] = JSON.parse(r.value);
  return c.json({ answers });
});

// Ubah jawaban yang sudah terkirim (berdasar kunci identitas).
pub.put("/forms/:slug/submit", async (c) => {
  const db = getDb();
  const ip = clientIp(c);
  if (hit(submits, ip, MAX_SUBMITS))
    return c.json({ error: "Terlalu banyak pengiriman. Coba lagi beberapa menit." }, 429);
  const av = checkAvailability(db, c.req.param("slug"));
  if (!av.ok) return c.json({ error: av.error }, av.status);
  const s = av.settings;
  const isQuiz = !!s.is_quiz;
  if (!s.allow_edit || isQuiz)
    return c.json({ error: "Fitur ubah jawaban tidak aktif untuk formulir ini." }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body harus JSON valid" }, 400);
  }
  const ab = readAnswersBody(body);
  if (!ab.ok) return c.json({ error: ab.error }, 400);
  const identity = normIdentity(body?.identity);
  if (!identity) return c.json({ error: "Identitas wajib diisi." }, 400);

  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(av.form.id) as any[];
  const idQ = questions.find((q) => q.is_identity);
  if (!idQ) return c.json({ error: "Formulir ini tidak memakai kunci identitas." }, 400);
  const resp = db
    .query("SELECT id FROM responses WHERE form_id = ? AND identity_key = ?")
    .get(av.form.id, identity) as any;
  if (!resp) return c.json({ error: "Identitas tidak ditemukan." }, 404);

  const vs = validateSubmission(questions, ab.answers, isQuiz);
  if (!vs.ok) return c.json({ error: vs.error }, 400);
  const { validated, score } = vs;

  // Kunci identitas tidak boleh diganti saat mengubah jawaban.
  const idAns = validated.find((a) => a.qid === idQ.id);
  if (normIdentity(idAns ? JSON.parse(idAns.valueJson) : null) !== identity)
    return c.json({ error: "Kunci identitas tidak boleh diubah." }, 400);

  const tx = db.transaction(() => {
    db.query("DELETE FROM answers WHERE response_id = ?").run(resp.id);
    const ins = db.query("INSERT INTO answers (response_id, question_id, value) VALUES (?, ?, ?)");
    for (const a of validated) ins.run(resp.id, a.qid, a.valueJson);
    db.query("UPDATE responses SET score = ?, updated_at = datetime('now') WHERE id = ?").run(
      isQuiz ? score : null,
      resp.id
    );
  });
  tx();
  return c.json({ ok: true, message: "Jawaban diperbarui. Terima kasih!" });
});

export default pub;
