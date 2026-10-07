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
