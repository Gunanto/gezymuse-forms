import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
let formId = 0;
let qids: number[] = [];
const PW = "test-res-012";

async function adminReq(path: string, method = "GET", body?: unknown, useAuth = true) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...(useAuth && cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
let ipN = 20;
async function submit(body: unknown) {
  ipN++;
  return app.request(`/api/public/forms/PLACEHOLDER`.replace("PLACEHOLDER", slug) + "/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.1.0.${ipN}` },
    body: JSON.stringify(body),
  });
}
let slug = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-res-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];

  const f = await adminReq("/api/forms", "POST", { title: "Survei Hasil" });
  const form = (await f.json()).form;
  formId = form.id;
  slug = form.slug;
  const qs = [
    { qtype: "multiple_choice", prompt: "Warna", options: ["Merah", "Biru"] },
    { qtype: "checkboxes", prompt: "Hobi", options: ["Bola", "Musik"] },
    { qtype: "linear_scale", prompt: "Puas", options: { min: 1, max: 5 } },
    { qtype: "short_text", prompt: "Kesan" },
  ];
  for (const q of qs) {
    const qr = await adminReq(`/api/forms/${formId}/questions`, "POST", q);
    qids.push((await qr.json()).question.id);
  }
  await adminReq(`/api/forms/${formId}`, "PATCH", { is_published: true });

  const [cWarna, cHobi, cPuas, cKesan] = qids;
  await submit({ answers: { [cWarna]: "Merah", [cHobi]: ["Bola"], [cPuas]: 5, [cKesan]: "Seru" } });
  await submit({ answers: { [cWarna]: "Merah", [cHobi]: ["Musik"], [cPuas]: 3, [cKesan]: "Biasa" } });
  await submit({ answers: { [cWarna]: "Biru", [cHobi]: ["Bola", "Musik"], [cPuas]: 4, [cKesan]: 'Luar biasa, "mantap"!' } });
});

describe("Tahap 4 — hasil & ekspor", () => {
  test("tanpa login -> 401", async () => {
    const r = await adminReq(`/api/forms/${formId}/summary`, "GET", undefined, false);
    expect(r.status).toBe(401);
  });

  test("daftar respons + paginasi", async () => {
    const r = await adminReq(`/api/forms/${formId}/responses?page=1&limit=2`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(3);
    expect(j.responses).toHaveLength(2);
    expect(j.pages).toBe(2);
    const r2 = await adminReq(`/api/forms/${formId}/responses?page=2&limit=2`);
    expect((await r2.json()).responses).toHaveLength(1);
  });

  test("detail respons memuat jawaban", async () => {
    const l = await adminReq(`/api/forms/${formId}/responses?limit=10`);
    const rid = (await l.json()).responses[0].id;
    const r = await adminReq(`/api/forms/${formId}/responses/${rid}`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.answers).toHaveLength(4);
    expect(j.answers[0]).toHaveProperty("prompt");
  });

  test("ringkasan: hitungan opsi, rata-rata skala, sampel teks", async () => {
    const r = await adminReq(`/api/forms/${formId}/summary`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total_responses).toBe(3);
    const byPrompt = Object.fromEntries(j.questions.map((q: any) => [q.prompt, q]));
    const warna = byPrompt["Warna"];
    expect(warna.kind).toBe("choice");
    expect(warna.options.find((o: any) => o.option === "Merah").count).toBe(2);
    expect(warna.options.find((o: any) => o.option === "Biru").count).toBe(1);
    const hobi = byPrompt["Hobi"];
    expect(hobi.options.find((o: any) => o.option === "Bola").count).toBe(2);
    const puas = byPrompt["Puas"];
    expect(puas.kind).toBe("scale");
    expect(puas.avg).toBe(4); // (5+3+4)/3
    const kesan = byPrompt["Kesan"];
    expect(kesan.kind).toBe("text");
    expect(kesan.count).toBe(3);
    expect(kesan.samples).toHaveLength(3);
  });

  test("ringkasan kuis: akurasi per soal", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "KZ", settings: { is_quiz: true } });
    const form = (await f.json()).form;
    const q = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "multiple_choice", prompt: "Ibukota", options: ["Jakarta", "Bandung"], points: 10, correct_answer: "Jakarta" });
    const qid = (await q.json()).question.id;
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    const s = (await (await adminReq(`/api/forms/${form.id}`)).json()).form.slug;
    const sub = (ip: string, val: string) =>
      app.request(`/api/public/forms/${s}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ answers: { [qid]: val } }),
      });
    await sub("10.2.0.1", "Jakarta");
    await sub("10.2.0.2", "Bandung");
    const r = await adminReq(`/api/forms/${form.id}/summary`);
    const qq = (await r.json()).questions[0];
    expect(qq.quiz.has_key).toBe(true);
    expect(qq.quiz.correct).toBe(1);
    expect(qq.quiz.accuracy_pct).toBe(50);
  });

  test("ekspor CSV: header, isi, escaping koma/kutip", async () => {
    const r = await adminReq(`/api/forms/${formId}/export.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain(".csv");
    const buf = Buffer.from(await r.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const t = buf.slice(3).toString("utf-8");
    const lines = t.split("\r\n");
    expect(lines[0]).toContain("Waktu Submit");
    expect(lines[0]).toContain("Warna");
    expect(lines.length).toBe(4); // header + 3 respons
    expect(t).toContain('"Luar biasa, ""mantap""!"'); // escaping benar
    expect(t).not.toContain("Caca");
  });

  test("ekspor Word: tabel HTML .doc", async () => {
    const r = await adminReq(`/api/forms/${formId}/export/word`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/msword");
    expect(r.headers.get("content-disposition")).toContain(".doc");
    const t = await r.text();
    expect(t).toContain("<table>");
    expect(t).toContain("Survei Hasil");
    expect(t).toContain("Waktu Submit");
  });

  test("hapus respons -> berkurang; hapus id asing -> 404", async () => {
    const l = await adminReq(`/api/forms/${formId}/responses?limit=10`);
    const rid = (await l.json()).responses[0].id;
    let r = await adminReq(`/api/forms/${formId}/responses/${rid}`, "DELETE");
    expect(r.status).toBe(200);
    r = await adminReq(`/api/forms/${formId}/responses?limit=10`);
    expect((await r.json()).total).toBe(2);
    r = await adminReq(`/api/forms/${formId}/responses/999999`, "DELETE");
    expect(r.status).toBe(404);
    r = await adminReq(`/api/forms/999999/summary`);
    expect(r.status).toBe(404);
  });
});
