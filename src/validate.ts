// Validasi input builder (dipakai API admin; dipakai lagi saat submit di Tahap 3).

export const QTYPES = [
  "short_text",
  "paragraph",
  "multiple_choice",
  "checkboxes",
  "dropdown",
  "linear_scale",
] as const;
export type QType = (typeof QTYPES)[number];

export const QTYPE_LABELS: Record<QType, string> = {
  short_text: "Teks singkat",
  paragraph: "Paragraf",
  multiple_choice: "Pilihan ganda",
  checkboxes: "Kotak centang",
  dropdown: "Dropdown",
  linear_scale: "Skala linear",
};

export interface ValidQuestion {
  qtype: QType;
  prompt: string;
  options: string; // JSON siap simpan
  required: boolean;
  points: number;
  correct_answer: string | null; // JSON siap simpan, atau null
  is_identity: boolean;
  validation: string; // '' | 'email' | 'nama'
  order_index: number;
}

type VResult<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateQuestion(body: unknown): VResult<ValidQuestion> {
  if (!isRecord(body)) return fail("Body harus objek JSON");
  const qtype = body.qtype;
  if (typeof qtype !== "string" || !(QTYPES as readonly string[]).includes(qtype))
    return fail(`qtype tidak valid (pilih: ${QTYPES.join(", ")})`);
  const t = qtype as QType;

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return fail("prompt wajib diisi");
  if (prompt.length > 2000) return fail("prompt maks 2000 karakter");

  let optionsJson = "[]";
  if (t === "multiple_choice" || t === "checkboxes" || t === "dropdown") {
    const opts = body.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 20)
      return fail("options untuk tipe pilihan harus array berisi 2–20 item");
    const clean = opts.map((o) => String(o).trim());
    if (clean.some((o) => !o)) return fail("options tidak boleh ada yang kosong");
    if (clean.some((o) => o.length > 200)) return fail("tiap opsi maks 200 karakter");
    if (new Set(clean).size !== clean.length) return fail("options tidak boleh duplikat");
    optionsJson = JSON.stringify(clean);
  } else if (t === "linear_scale") {
    const o = body.options;
    if (!isRecord(o)) return fail("options skala linear harus objek {min, max, minLabel?, maxLabel?}");
    const min = Number(o.min);
    const max = Number(o.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max || max - min < 1 || max - min > 9)
      return fail("skala linear: min & max bilangan bulat, min < max, rentang 2–10");
    const minLabel = typeof o.minLabel === "string" ? o.minLabel.trim().slice(0, 100) : "";
    const maxLabel = typeof o.maxLabel === "string" ? o.maxLabel.trim().slice(0, 100) : "";
    optionsJson = JSON.stringify({ min, max, minLabel, maxLabel });
  }

  const required = body.required === true;
  const is_identity = body.is_identity === true;
  if (is_identity && t !== "short_text")
    return fail("kunci identitas hanya bisa untuk soal teks singkat");
  const validation = body.validation === "email" || body.validation === "nama" ? body.validation : "";
  if (validation && t !== "short_text")
    return fail("validasi email/nama hanya bisa untuk soal teks singkat");
  const points = body.points === undefined || body.points === null ? 0 : Number(body.points);
  if (!Number.isFinite(points) || points < 0 || points > 1000)
    return fail("points harus angka 0–1000");

  let correctJson: string | null = null;
  const ca = body.correct_answer;
  if (ca !== undefined && ca !== null) {
    if (t === "multiple_choice" || t === "dropdown") {
      const opts: string[] = JSON.parse(optionsJson);
      if (typeof ca !== "string" || !opts.includes(ca))
        return fail("correct_answer harus salah satu opsi");
      correctJson = JSON.stringify(ca);
    } else if (t === "checkboxes") {
      const opts: string[] = JSON.parse(optionsJson);
      if (!Array.isArray(ca) || ca.length === 0 || !ca.every((x) => typeof x === "string" && opts.includes(x)))
        return fail("correct_answer harus array berisi subset opsi");
      correctJson = JSON.stringify([...new Set(ca)]);
    } else if (t === "linear_scale") {
      const { min, max } = JSON.parse(optionsJson);
      const n = Number(ca);
      if (!Number.isInteger(n) || n < min || n > max)
        return fail("correct_answer harus bilangan bulat dalam rentang skala");
      correctJson = JSON.stringify(n);
    } else {
      if (typeof ca !== "string" || !ca.trim() || ca.length > 2000)
        return fail("correct_answer teks maks 2000 karakter");
      correctJson = JSON.stringify(ca.trim());
    }
  }

  let order_index = 0;
  if (body.order_index !== undefined && body.order_index !== null) {
    order_index = Number(body.order_index);
    if (!Number.isInteger(order_index) || order_index < 0)
      return fail("order_index harus bilangan bulat >= 0");
  }

  return {
    ok: true,
    value: { qtype: t, prompt, options: optionsJson, required, points, correct_answer: correctJson, is_identity, validation, order_index },
  };
}

export interface FormSettings {
  accept_responses: boolean;
  deadline: string | null;
  max_responses: number | null;
  is_quiz: boolean;
  show_score: boolean;
  allow_edit: boolean;
  shuffle_questions: boolean;
  shuffle_options: boolean;
}

export const SETTING_DEFAULTS: FormSettings = {
  accept_responses: true,
  deadline: null,
  max_responses: null,
  is_quiz: false,
  show_score: true,
  allow_edit: false,
  shuffle_questions: false,
  shuffle_options: false,
};

const BOOL_KEYS = [
  "accept_responses",
  "is_quiz",
  "show_score",
  "allow_edit",
  "shuffle_questions",
  "shuffle_options",
] as const;

export function validateSettings(input: unknown): VResult<string> {
  if (!isRecord(input)) return fail("settings harus objek");
  const out: FormSettings = { ...SETTING_DEFAULTS };
  for (const k of BOOL_KEYS) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== "boolean") return fail(`${k} harus boolean`);
      (out as any)[k] = input[k];
    }
  }
  if (input.deadline !== undefined && input.deadline !== null) {
    if (typeof input.deadline !== "string" || Number.isNaN(Date.parse(input.deadline)))
      return fail("deadline harus string tanggal ISO atau null");
    out.deadline = input.deadline;
  } else if (input.deadline === null) {
    out.deadline = null;
  }
  if (input.max_responses !== undefined && input.max_responses !== null) {
    const n = Number(input.max_responses);
    if (!Number.isInteger(n) || n < 1 || n > 1000000)
      return fail("max_responses harus bilangan bulat 1–1000000 atau null");
    out.max_responses = n;
  } else if (input.max_responses === null) {
    out.max_responses = null;
  }
  return { ok: true, value: JSON.stringify(out) };
}

export function validateFormMeta(body: unknown): VResult<{ title: string; description: string }> {
  if (!isRecord(body)) return fail("Body harus objek JSON");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return fail("title wajib diisi");
  if (title.length > 200) return fail("title maks 200 karakter");
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  return { ok: true, value: { title, description } };
}
