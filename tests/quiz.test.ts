import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
let formId = 0;
let slug = "";
let qids: number[] = [];
const PW = "test-quiz-345";

async function adminReq(path: string, method = "GET", body?: unknown, useAuth = true) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(useAuth && cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
let ipN = 50;
async function pubSubmit(s: string, body: unknown) {
  ipN++;
  return app.request(`/api/public/forms/${s}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.3.0.${ipN}` },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-quiz-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];

  const f = await adminReq("/api/forms", "POST", { title: "Kuis IPA", settings: { is_quiz: true, show_score: true } });
  const form = (await f.json()).form;
  formId = form.id;
  slug = form.slug;
  const qs = [
    { qtype: "multiple_choice", prompt: "Fotosintesis", options: ["Daun", "Akar"], points: 10, correct_answer: "Daun" },
    { qtype: "short_text", prompt: "Jelaskan", points: 5, correct_answer: "bebas" },
    { qtype: "linear_scale", prompt: "Pilih 3", options: { min: 1, max: 5 }, points: 5, correct_answer: 3 },
  ];
  for (const q of qs) {
    const qr = await adminReq(`/api/forms/${formId}/questions`, "POST", q);
    expect(qr.status).toBe(201);
    qids.push((await qr.json()).question.id);
  }
  await adminReq(`/api/forms/${formId}`, "PATCH", { is_published: true });
});

describe("Tahap 5 — mode kuis", () => {
  test("submit: review berisi benar/salah + kunci + manual", async () => {
    const [pg, teks, skala] = qids;
    const r = await pubSubmit(slug, {
      respondent_name: "Q1",
      answers: { [pg]: "Daun", [teks]: "karena cahaya", [skala]: 2 },
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.score).toBe(10);
    expect(j.total_points).toBe(20); // teks: kunci ada sbg acuan manual (5 poin)
    expect(j.review).toHaveLength(3);
    const [rPg, rTeks, rSkala] = j.review;
    expect(rPg.is_correct).toBe(true);
    expect(rPg.correct_answer).toBe("Daun");
    expect(rPg.points_earned).toBe(10);
    expect(rTeks.is_correct).toBe(null);
    expect(rTeks.needs_manual).toBe(true);
    expect(rTeks.correct_answer).toBe(null); // kunci teks tak dibocorkan
    expect(rSkala.is_correct).toBe(false);
    expect(rSkala.correct_answer).toBe(3);
  });

  test("tanpa show_score -> tanpa review & tanpa skor", async () => {
    await adminReq(`/api/forms/${formId}`, "PATCH", { settings: { is_quiz: true, show_score: false } });
    const [pg] = qids;
    const r = await pubSubmit(slug, { respondent_name: "Q2", answers: { [pg]: "Daun" } });
    const j = await r.json();
    expect(r.status).toBe(200);
    expect("score" in j).toBe(false);
    expect("review" in j).toBe(false);
    await adminReq(`/api/forms/${formId}`, "PATCH", { settings: { is_quiz: true, show_score: true } });
  });

  test("bukan kuis -> tanpa review", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "NonKuis" });
    const form = (await f.json()).form;
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    const r = await pubSubmit(form.slug, { respondent_name: "Q3", answers: {} });
    expect("review" in await r.json()).toBe(false);
  });

  test("summary: score_stats rata-rata/maks/min", async () => {
    const r = await adminReq(`/api/forms/${formId}/summary`);
    const j = await r.json();
    expect(j.score_stats.count).toBe(2); // Q1 & Q2
    expect(j.score_stats.max).toBe(10);
    expect(j.score_stats.min).toBe(10); // Q2: PG benar (teks manual=0)
    expect(j.score_stats.total_points).toBe(20);
    expect(j.score_stats.avg).toBe(10);
  });

  test("koreksi skor manual: valid, >total ditolak, 404", async () => {
    const l = await adminReq(`/api/forms/${formId}/responses?limit=10`);
    const rid = (await l.json()).responses[0].id;
    let r = await adminReq(`/api/forms/${formId}/responses/${rid}/score`, "PATCH", { score: 13 });
    expect(r.status).toBe(200);
    expect((await r.json()).score).toBe(13);
    const d = await adminReq(`/api/forms/${formId}/responses/${rid}`);
    expect((await d.json()).response.score).toBe(13);
    r = await adminReq(`/api/forms/${formId}/responses/${rid}/score`, "PATCH", { score: 999 });
    expect(r.status).toBe(400);
    r = await adminReq(`/api/forms/${formId}/responses/${rid}/score`, "PATCH", { score: -1 });
    expect(r.status).toBe(400);
    r = await adminReq(`/api/forms/999999/responses/${rid}/score`, "PATCH", { score: 5 });
    expect(r.status).toBe(404);
    r = await adminReq(`/api/forms/${formId}/responses/${rid}/score`, "GET");
    expect(r.status).toBe(404); // method salah -> 404 Hono
  });

  test("skema publik tetap tanpa correct_answer (kuis)", async () => {
    const r = await app.request(`/api/public/forms/${slug}`);
    const j = await r.json();
    for (const q of j.questions) expect("correct_answer" in q).toBe(false);
    // tapi points terlihat (lencana poin di UI)
    expect(j.questions[0].points).toBe(10);
  });
});
