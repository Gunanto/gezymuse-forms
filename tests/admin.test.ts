import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
const PW = "test-admin-456";

async function req(path: string, method = "GET", body?: unknown, useAuth = true) {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(useAuth && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-admin-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  expect(cookie).toContain("gezyform_session");
});

let formId = 0;
let qIds: number[] = [];

describe("Tahap 2 — builder API", () => {
  test("tanpa login -> 401", async () => {
    const r = await req("/api/forms", "GET", undefined, false);
    expect(r.status).toBe(401);
  });

  test("buat form valid -> 201 + slug", async () => {
    const r = await req("/api/forms", "POST", { title: "Kuis Pecahan", description: "Latihan" });
    expect(r.status).toBe(201);
    const { form } = await r.json();
    expect(form.title).toBe("Kuis Pecahan");
    expect(form.slug).toMatch(/^[a-z2-9]{8}$/);
    expect(form.is_published).toBe(false);
    formId = form.id;
  });

  test("buat form tanpa judul -> 400", async () => {
    const r = await req("/api/forms", "POST", { title: "   " });
    expect(r.status).toBe(400);
  });

  test("buat form settings invalid -> 400", async () => {
    const r = await req("/api/forms", "POST", { title: "X", settings: { max_responses: -5 } });
    expect(r.status).toBe(400);
  });

  test("tambah 6 tipe soal -> 201", async () => {
    const payloads = [
      { qtype: "short_text", prompt: "Siapa nama wali kelasmu?", required: true },
      { qtype: "paragraph", prompt: "Ceritakan pengalaman belajarmu" },
      { qtype: "multiple_choice", prompt: "2/4 + 1/4 =", options: ["1/4", "2/4", "3/4"], required: true, points: 10, correct_answer: "3/4" },
      { qtype: "checkboxes", prompt: "Pilih bilangan prima", options: ["2", "4", "7", "9"], correct_answer: ["2", "7"] },
      { qtype: "dropdown", prompt: "Kelas", options: ["7A", "7B", "7C"] },
      { qtype: "linear_scale", prompt: "Seberapa paham?", options: { min: 1, max: 5, minLabel: "Bingung", maxLabel: "Paham" }, correct_answer: 5 },
    ];
    for (const p of payloads) {
      const r = await req(`/api/forms/${formId}/questions`, "POST", p);
      expect(r.status).toBe(201);
      const { question } = await r.json();
      qIds.push(question.id);
    }
    expect(qIds).toHaveLength(6);
  });

  test("qtype invalid -> 400; opsi < 2 -> 400; kunci di luar opsi -> 400", async () => {
    let r = await req(`/api/forms/${formId}/questions`, "POST", { qtype: "esai", prompt: "x" });
    expect(r.status).toBe(400);
    r = await req(`/api/forms/${formId}/questions`, "POST", { qtype: "multiple_choice", prompt: "x", options: ["satu"] });
    expect(r.status).toBe(400);
    r = await req(`/api/forms/${formId}/questions`, "POST", { qtype: "dropdown", prompt: "x", options: ["a", "b"], correct_answer: "c" });
    expect(r.status).toBe(400);
  });

  test("GET form detail memuat 6 soal urut", async () => {
    const r = await req(`/api/forms/${formId}`);
    expect(r.status).toBe(200);
    const { form, questions } = await r.json();
    expect(questions).toHaveLength(6);
    expect(questions[0].order_index).toBe(0);
    expect(form.question_count).toBe(6);
  });

  test("PATCH soal (ubah prompt + tambah opsi) -> 200", async () => {
    const r = await req(`/api/questions/${qIds[2]}`, "PATCH", { prompt: "3/4 - 1/4 =", options: ["1/4", "2/4", "3/4", "4/4"] });
    expect(r.status).toBe(200);
    expect((await r.json()).question.prompt).toBe("3/4 - 1/4 =");
  });

  test("PATCH soal jadi invalid -> 400", async () => {
    const r = await req(`/api/questions/${qIds[2]}`, "PATCH", { qtype: "bogus" });
    expect(r.status).toBe(400);
  });

  test("reorder soal -> urutan berubah", async () => {
    const rev = [...qIds].reverse();
    const r = await req(`/api/forms/${formId}/questions/reorder`, "POST", { order: rev });
    expect(r.status).toBe(200);
    const d = await req(`/api/forms/${formId}`);
    const ids = (await d.json()).questions.map((q: any) => q.id);
    expect(ids).toEqual(rev);
  });

  test("reorder dengan id asing -> 400", async () => {
    const r = await req(`/api/forms/${formId}/questions/reorder`, "POST", { order: [999999] });
    expect(r.status).toBe(400);
  });

  test("PATCH form: publish + settings kuis -> 200", async () => {
    const r = await req(`/api/forms/${formId}`, "PATCH", {
      is_published: true,
      settings: { is_quiz: true, max_responses: 30, deadline: "2026-12-31T23:59:00+07:00" },
    });
    expect(r.status).toBe(200);
    const { form } = await r.json();
    expect(form.is_published).toBe(true);
    expect(form.settings.is_quiz).toBe(true);
    expect(form.settings.max_responses).toBe(30);
  });

  test("duplikat form -> slug baru + 6 soal", async () => {
    const r = await req(`/api/forms/${formId}/duplicate`, "POST");
    expect(r.status).toBe(201);
    const { form } = await r.json();
    expect(form.title).toContain("(salinan)");
    const d = await req(`/api/forms/${form.id}`);
    expect((await d.json()).questions).toHaveLength(6);
    // duplikat tidak ikut terpublish
    expect(form.is_published).toBe(false);
  });

  test("hapus 1 soal -> 200; hapus form -> 404 setelahnya", async () => {
    let r = await req(`/api/questions/${qIds[0]}`, "DELETE");
    expect(r.status).toBe(200);
    r = await req(`/api/forms/${formId}`, "DELETE");
    expect(r.status).toBe(200);
    r = await req(`/api/forms/${formId}`);
    expect(r.status).toBe(404);
    r = await req(`/api/questions/${qIds[1]}`, "PATCH", { prompt: "x" });
    expect(r.status).toBe(404);
  });
});
