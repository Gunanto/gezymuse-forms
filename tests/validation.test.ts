import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
let slug = "";
let emailQid = 0;
const PW = "test-val-654";

async function adminReq(path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const pubGet = (s: string) => app.request(`/api/public/forms/${s}`);
const pubSubmit = (s: string, body: unknown, ip = "10.8.0.1") =>
  app.request(`/api/public/forms/${s}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-val-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const f = await adminReq("/api/forms", "POST", { title: "Validasi Email" });
  const form = (await f.json()).form;
  slug = form.slug;
  const q = await adminReq(`/api/forms/${form.id}/questions`, "POST",
    { qtype: "short_text", prompt: "Email", required: true, validation: "email" });
  emailQid = (await q.json()).question.id;
  await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
});

describe("Validasi email pada soal teks singkat", () => {
  test("validation tersimpan & muncul di skema publik", async () => {
    const j = await (await pubGet(slug)).json();
    expect(j.questions[0].validation).toBe("email");
    expect("correct_answer" in j.questions[0]).toBe(false);
  });

  test("email tanpa @ / ada spasi -> 400", async () => {
    let r = await pubSubmit(slug, { answers: { [emailQid]: "joni" } }, "10.8.0.2");
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("email");
    r = await pubSubmit(slug, { answers: { [emailQid]: "joni @x.id" } }, "10.8.0.3");
    expect(r.status).toBe(400);
    r = await pubSubmit(slug, { answers: { [emailQid]: "joni@x" } }, "10.8.0.4");
    expect(r.status).toBe(400);
  });

  test("email valid -> 200", async () => {
    const r = await pubSubmit(slug, { answers: { [emailQid]: "Joni@Sekolah.ID" } }, "10.8.0.5");
    expect(r.status).toBe(200);
  });

  test("validasi email ditolak untuk tipe selain teks singkat", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "V2" });
    const form = (await f.json()).form;
    const r = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "paragraph", prompt: "P", validation: "email" });
    expect(r.status).toBe(400);
  });

  test("soal email opsional boleh dikosongkan", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "V3" });
    const form = (await f.json()).form;
    const q = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Email (opsional)", validation: "email" });
    const qid = (await q.json()).question.id;
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    const r = await pubSubmit(form.slug, { answers: {} }, "10.8.0.6");
    expect(r.status).toBe(200);
    expect(qid).toBeGreaterThan(0);
  });
});

describe("Validasi nama pada soal teks singkat", () => {
  let nslug = "";
  let namaQid = 0;
  let nformId = 0;

  beforeAll(async () => {
    const f = await adminReq("/api/forms", "POST", { title: "Validasi Nama" });
    const form = (await f.json()).form;
    nslug = form.slug;
    nformId = form.id;
    const q = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Nama", required: true, validation: "nama" });
    namaQid = (await q.json()).question.id;
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
  });

  async function storedAnswer(email_ip: string, nama: string) {
    const r = await pubSubmit(nslug, { answers: { [namaQid]: nama } }, email_ip);
    if (r.status !== 200) return { status: r.status, body: await r.text() };
    const list = await (await adminReq(`/api/forms/${nformId}/responses?limit=1`)).json();
    const rid = list.responses[0].id;
    const det = await (await adminReq(`/api/forms/${nformId}/responses/${rid}`)).json();
    return { status: 200, value: det.answers[0].value };
  }

  test("huruf kecil otomatis jadi kapital tiap kata", async () => {
    const r = await storedAnswer("10.8.1.1", "budi santoso");
    expect(r.status).toBe(200);
    expect(r.value).toBe("Budi Santoso");
  });

  test("huruf besar semua dinormalkan; gelar tidak rusak", async () => {
    let r = await storedAnswer("10.8.1.2", "SITI AMINAH");
    expect(r.value).toBe("Siti Aminah");
    r = await storedAnswer("10.8.1.3", "Siti Aminah, S.Pd.");
    expect(r.status).toBe(200);
    expect(r.value).toBe("Siti Aminah, S.Pd.");
    r = await storedAnswer("10.8.1.9", "SITI AMINAH, S.PD.");
    expect(r.status).toBe(200);
    expect(r.value).toBe("Siti Aminah, S.Pd.");
  });

  test("angka/simbol ditolak; lebih dari 30 karakter ditolak", async () => {
    let r = await pubSubmit(nslug, { answers: { [namaQid]: "Budi123" } }, "10.8.1.4");
    expect(r.status).toBe(400);
    r = await pubSubmit(nslug, { answers: { [namaQid]: "Budi@Santoso" } }, "10.8.1.5");
    expect(r.status).toBe(400);
    r = await pubSubmit(nslug, { answers: { [namaQid]: "A".repeat(31) } }, "10.8.1.6");
    expect(r.status).toBe(400);
    r = await pubSubmit(nslug, { answers: { [namaQid]: "A".repeat(30) } }, "10.8.1.7");
    expect(r.status).toBe(200);
  });

  test("petik satu & titik lolos", async () => {
    const r = await storedAnswer("10.8.1.8", "d'angelo pratama");
    expect(r.status).toBe(200);
    expect(r.value).toBe("D'Angelo Pratama");
  });
});
