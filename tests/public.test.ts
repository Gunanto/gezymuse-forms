import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
let slug = "";
let quizSlug = "";
const PW = "test-pub-789";

async function adminReq(path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function pubGet(s: string) {
  return app.request(`/api/public/forms/${s}`);
}
async function pubSubmit(s: string, body: unknown, ip = "10.0.0.1") {
  return app.request(`/api/public/forms/${s}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-pub-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];

  // Form survei biasa (dipublish)
  const f = await adminReq("/api/forms", "POST", { title: "Survei" });
  const form = (await f.json()).form;
  slug = form.slug;
  const qs = [
    { qtype: "short_text", prompt: "Nama panggilan", required: true },
    { qtype: "multiple_choice", prompt: "Warna favorit", options: ["Merah", "Biru"], required: true },
    { qtype: "checkboxes", prompt: "Hobi", options: ["Bola", "Musik", "Baca"] },
    { qtype: "linear_scale", prompt: "Puas?", options: { min: 1, max: 5 } },
  ];
  for (const q of qs) await adminReq(`/api/forms/${form.id}/questions`, "POST", q);
  await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });

  // Form kuis (skor otomatis)
  const k = await adminReq("/api/forms", "POST", { title: "Kuis", settings: { is_quiz: true, show_score: true } });
  const kform = (await k.json()).form;
  quizSlug = kform.slug;
  await adminReq(`/api/forms/${kform.id}/questions`, "POST",
    { qtype: "multiple_choice", prompt: "1+1", options: ["1", "2", "3"], points: 10, correct_answer: "2" });
  await adminReq(`/api/forms/${kform.id}/questions`, "POST",
    { qtype: "checkboxes", prompt: "Genap", options: ["2", "3", "4"], points: 20, correct_answer: ["2", "4"] });
  await adminReq(`/api/forms/${kform.id}/questions`, "POST",
    { qtype: "linear_scale", prompt: "Pilih 4", options: { min: 1, max: 5 }, points: 5, correct_answer: 4 });
  await adminReq(`/api/forms/${kform.id}`, "PATCH", { is_published: true });
});

describe("Tahap 3 — API publik responden", () => {
  test("skema publik: tanpa correct_answer", async () => {
    const r = await pubGet(slug);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.form.title).toBe("Survei");
    expect(j.questions).toHaveLength(4);
    for (const q of j.questions) expect("correct_answer" in q).toBe(false);
  });

  test("form draf -> 404", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "Draf" });
    const s = (await f.json()).form.slug;
    const r = await pubGet(s);
    expect(r.status).toBe(404);
  });

  test("submit valid -> 200, tersimpan", async () => {
    const qs = (await (await pubGet(slug)).json()).questions;
    const byPrompt = Object.fromEntries(qs.map((q: any) => [q.prompt, q.id]));
    const r = await pubSubmit(slug, {
      respondent_name: "Budi", respondent_class: "7A",
      answers: {
        [byPrompt["Nama panggilan"]]: "Bud",
        [byPrompt["Warna favorit"]]: "Biru",
        [byPrompt["Hobi"]]: ["Bola", "Musik"],
        [byPrompt["Puas?"]]: 4,
      },
    }, "10.0.0.2");
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  test("tanpa nama (require_name) -> 400; soal wajib kosong -> 400", async () => {
    let r = await pubSubmit(slug, { answers: {} }, "10.0.0.3");
    expect(r.status).toBe(400);
    const qs = (await (await pubGet(slug)).json()).questions;
    const byPrompt = Object.fromEntries(qs.map((q: any) => [q.prompt, q.id]));
    r = await pubSubmit(slug, {
      respondent_name: "Ani",
      answers: { [byPrompt["Nama panggilan"]]: "An" }, // warna favorit (wajib) kosong
    }, "10.0.0.3");
    expect(r.status).toBe(400);
  });

  test("opsi tidak valid & skala di luar rentang -> 400", async () => {
    const qs = (await (await pubGet(slug)).json()).questions;
    const byPrompt = Object.fromEntries(qs.map((q: any) => [q.prompt, q.id]));
    let r = await pubSubmit(slug, {
      respondent_name: "Cici",
      answers: { [byPrompt["Nama panggilan"]]: "Ci", [byPrompt["Warna favorit"]]: "Ungu" },
    }, "10.0.0.4");
    expect(r.status).toBe(400);
    r = await pubSubmit(slug, {
      respondent_name: "Cici",
      answers: { [byPrompt["Nama panggilan"]]: "Ci", [byPrompt["Warna favorit"]]: "Biru", [byPrompt["Puas?"]]: 9 },
    }, "10.0.0.4");
    expect(r.status).toBe(400);
  });

  test("nama ganda -> 409", async () => {
    const qs = (await (await pubGet(slug)).json()).questions;
    const byPrompt = Object.fromEntries(qs.map((q: any) => [q.prompt, q.id]));
    const body = {
      respondent_name: "Budi", respondent_class: "7A",
      answers: { [byPrompt["Nama panggilan"]]: "Bud", [byPrompt["Warna favorit"]]: "Merah" },
    };
    const r = await pubSubmit(slug, body, "10.0.0.5");
    expect(r.status).toBe(409);
  });

  test("kuis: semua benar -> skor penuh; salah -> 0", async () => {
    const qs = (await (await pubGet(quizSlug)).json()).questions;
    const byPrompt = Object.fromEntries(qs.map((q: any) => [q.prompt, q.id]));
    let r = await pubSubmit(quizSlug, {
      respondent_name: "Dedi",
      answers: { [byPrompt["1+1"]]: "2", [byPrompt["Genap"]]: ["2", "4"], [byPrompt["Pilih 4"]]: 4 },
    }, "10.0.0.6");
    expect(r.status).toBe(200);
    let j = await r.json();
    expect(j.score).toBe(35);
    expect(j.total_points).toBe(35);
    // salah sebagian: PG salah, checkbox kurang satu
    r = await pubSubmit(quizSlug, {
      respondent_name: "Eka",
      answers: { [byPrompt["1+1"]]: "3", [byPrompt["Genap"]]: ["2"], [byPrompt["Pilih 4"]]: 4 },
    }, "10.0.0.7");
    j = await r.json();
    expect(j.score).toBe(5);
  });

  test("kuis show_score=false -> skor tidak dikembalikan", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "K2", settings: { is_quiz: true, show_score: false } });
    const form = (await f.json()).form;
    await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Isi", points: 10, correct_answer: "x" });
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    const qs = (await (await pubGet(form.slug)).json()).questions;
    const r = await pubSubmit(form.slug, { respondent_name: "Fajar", answers: { [qs[0].id]: "x" } }, "10.0.0.8");
    const j = await r.json();
    expect(r.status).toBe(200);
    expect("score" in j).toBe(false);
  });

  test("accept_responses=false -> 403; deadline lewat -> 403; max_responses -> 403", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "Batas" });
    const form = (await f.json()).form;
    await adminReq(`/api/forms/${form.id}/questions`, "POST", { qtype: "short_text", prompt: "Isi" });
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true, settings: { accept_responses: false } });
    let r = await pubGet(form.slug);
    expect(r.status).toBe(403);
    await adminReq(`/api/forms/${form.id}`, "PATCH", { settings: { accept_responses: true, deadline: "2020-01-01T00:00:00Z" } });
    r = await pubGet(form.slug);
    expect(r.status).toBe(403);
    await adminReq(`/api/forms/${form.id}`, "PATCH", { settings: { accept_responses: true, deadline: null, max_responses: 1 } });
    r = await pubSubmit(form.slug, { respondent_name: "Gina", answers: {} }, "10.0.0.9");
    expect(r.status).toBe(200);
    r = await pubSubmit(form.slug, { respondent_name: "Hadi", answers: {} }, "10.0.0.10");
    expect(r.status).toBe(403);
  });

  test("rate-limit submit: 20x -> 429", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "RL", settings: { require_name: false } });
    const form = (await f.json()).form;
    await adminReq(`/api/forms/${form.id}/questions`, "POST", { qtype: "short_text", prompt: "Isi" });
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const r = await pubSubmit(form.slug, { answers: { 0: "x" } }, "10.0.0.99");
      last = r.status;
    }
    expect(last).toBe(429);
  }, 30000);
});
