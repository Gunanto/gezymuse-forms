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
  return c.json({
    form: {
      title: av.form.title,
      description: av.form.description,
      settings: {
        is_quiz: !!s.is_quiz,
        show_score: s.show_score !== false,
        require_name: s.require_name !== false,
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

pub.post("/forms/:slug/submit", async (c) => {
  const db = getDb();
  const ip = clientIp(c);
  const now = Date.now();
  const rec = submits.get(ip);
  if (rec && now < rec.resetAt && rec.count >= MAX_SUBMITS)
    return c.json({ error: "Terlalu banyak pengiriman. Coba lagi beberapa menit." }, 429);

  const av = checkAvailability(db, c.req.param("slug"));
  if (!av.ok) return c.json({ error: av.error }, av.status);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body harus JSON valid" }, 400);
  }
  const answers = body?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return c.json({ error: "answers harus objek {id_soal: jawaban}" }, 400);

  const questions = db
    .query("SELECT * FROM questions WHERE form_id = ? ORDER BY order_index ASC, id ASC")
    .all(av.form.id) as any[];
  const s = av.settings;
  const isQuiz = !!s.is_quiz;

  const validated: { qid: number; valueJson: string; score: number; correct: boolean | null }[] = [];
  let score = 0;
  let totalPoints = 0;

  for (const q of questions) {
    const raw = answers[String(q.id)] ?? answers[q.id];
    if (isEmpty(raw)) {
      if (q.required)
        return c.json({ error: `Pertanyaan wajib diisi: "${q.prompt.slice(0, 80)}"` }, 400);
      validated.push({ qid: q.id, valueJson: JSON.stringify(null), score: 0, correct: null });
      continue;
    }
    const v = validateAnswer(q, raw);
    if (v.error) return c.json({ error: `Soal "${q.prompt.slice(0, 80)}": ${v.error}` }, 400);
    const correct = isQuiz ? checkCorrect(q, v.value) : null;
    const qs = correct ? Number(q.points) || 0 : 0;
    score += qs;
    if (isQuiz && q.correct_answer) totalPoints += Number(q.points) || 0;
    validated.push({ qid: q.id, valueJson: JSON.stringify(v.value), score: qs, correct });
  }

  const name = typeof body.respondent_name === "string" ? body.respondent_name.trim().slice(0, 100) : "";
  const cls = typeof body.respondent_class === "string" ? body.respondent_class.trim().slice(0, 50) : "";
  if (s.require_name !== false && !name)
    return c.json({ error: "Nama wajib diisi" }, 400);

  // Cegah isi ganda: satu nama (+kelas) satu respons.
  if (s.require_name !== false) {
    const dup = db
      .query(
        "SELECT 1 FROM responses WHERE form_id = ? AND lower(respondent_name) = lower(?) AND lower(respondent_class) = lower(?)"
      )
      .get(av.form.id, name, cls);
    if (dup) return c.json({ error: "Nama ini sudah mengisi formulir." }, 409);
  }

  const tx = db.transaction(() => {
    const info = db
      .query("INSERT INTO responses (form_id, respondent_name, respondent_class, score) VALUES (?, ?, ?, ?)")
      .run(av.form.id, name, cls, isQuiz ? score : null);
    const rid = Number(info.lastInsertRowid);
    const ins = db.query("INSERT INTO answers (response_id, question_id, value) VALUES (?, ?, ?)");
    for (const a of validated) ins.run(rid, a.qid, a.valueJson);
    return rid;
  });
  tx();

  const r = submits.get(ip);
  if (!r || now >= r.resetAt) submits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else r.count++;

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

export default pub;
