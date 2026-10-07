import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
let cookie = "";
let slug = "";
let emailQid = 0;
let kelasQid = 0;
const PW = "test-ident-456";

async function adminReq(path: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const pubGet = (s: string) => app.request(`/api/public/forms/${s}`);
const pubSubmit = (s: string, body: unknown, ip = "10.9.0.1", method = "POST") =>
  app.request(`/api/public/forms/${s}/submit`, {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
const pubMine = (s: string, identity: string, ip = "10.9.0.1") =>
  app.request(`/api/public/forms/${s}/mine?identity=${encodeURIComponent(identity)}`, {
    headers: { "x-forwarded-for": ip },
  });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-ident-"));
process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PW }),
  });
cookie = (r.headers.get("set-cookie") || "").split(";")[0];

  const f = await adminReq("/api/forms", "POST", { title: "Survei Identitas" });
  const form = (await f.json()).form;
  slug = form.slug;
  const q1 = await adminReq(`/api/forms/${form.id}/questions`, "POST",
    { qtype: "short_text", prompt: "Email", required: true, is_identity: true });
  emailQid = (await q1.json()).question.id;
  const q2 = await adminReq(`/api/forms/${form.id}/questions`, "POST",
    { qtype: "short_text", prompt: "Kesan" });
  kelasQid = (await q2.json()).question.id;
  await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
});

const ans = (email: string, kesan = "ok") => ({ [emailQid]: email, [kelasQid]: kesan });

describe("Kunci identitas — satu pengisian per jawaban", () => {
  test("is_identity tersimpan & muncul di skema publik", async () => {
    const j = await (await pubGet(slug)).json();
    expect(j.form.settings.identity_qid).toBe(emailQid);
    expect(j.form.settings.allow_edit).toBe(false);
  });

  test("is_identity ditolak untuk tipe selain teks singkat", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "X" });
    const form = (await f.json()).form;
    const r = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "paragraph", prompt: "P", is_identity: true });
    expect(r.status).toBe(400);
  });

  test("hanya satu kunci identitas per formulir", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "Y" });
    const form = (await f.json()).form;
    const a = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "A", is_identity: true });
    const b = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "B", is_identity: true });
    const aid = (await a.json()).question.id;
    const bid = (await b.json()).question.id;
    const det = await (await adminReq(`/api/forms/${form.id}`)).json();
    const byId = Object.fromEntries(det.questions.map((q: any) => [q.id, q]));
    expect(byId[bid].is_identity).toBe(true);
    expect(byId[aid].is_identity).toBe(false);
  });

  test("identitas sama (beda huruf besar) -> 409; beda -> 200", async () => {
    let r = await pubSubmit(slug, { answers: ans("Budi@x.id") }, "10.9.0.2");
    expect(r.status).toBe(200);
    r = await pubSubmit(slug, { answers: ans("budi@X.ID") }, "10.9.0.3");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBeUndefined(); // allow_edit mati -> tanpa kode
    r = await pubSubmit(slug, { answers: ans("cici@x.id") }, "10.9.0.4");
    expect(r.status).toBe(200);
  });

  test("tanpa allow_edit: mine & PUT ditolak", async () => {
    let r = await pubMine(slug, "budi@x.id");
    expect(r.status).toBe(403);
    r = await pubSubmit(slug, { identity: "budi@x.id", answers: ans("budi@x.id", "baru") }, "10.9.0.5", "PUT");
    expect(r.status).toBe(403);
  });
});

describe("Ubah jawaban via kunci identitas", () => {
  test("aktifkan allow_edit -> duplikat mengembalikan code already_submitted", async () => {
    const f = await adminReq("/api/forms", "POST", { title: "Z" });
    const form = (await f.json()).form;
    const q1 = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Email", required: true, is_identity: true });
    const q2 = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Kesan" });
    const eQ = (await q1.json()).question.id;
    const kQ = (await q2.json()).question.id;
    await adminReq(`/api/forms/${form.id}`, "PATCH",
      { is_published: true, settings: { allow_edit: true } });
    const s = form.slug;

    let r = await pubSubmit(s, { answers: { [eQ]: "dedi@x.id", [kQ]: "bagus" } }, "10.9.1.1");
    expect(r.status).toBe(200);
    r = await pubSubmit(s, { answers: { [eQ]: "Dedi@X.id", [kQ]: "biasa" } }, "10.9.1.2");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("already_submitted");

    // mine mengembalikan jawaban lama
    r = await pubMine(s, "dedi@x.id", "10.9.1.3");
    expect(r.status).toBe(200);
    const mj = await r.json();
    expect(mj.answers[eQ]).toBe("dedi@x.id");
    expect(mj.answers[kQ]).toBe("bagus");

    // PUT memperbarui jawaban
    r = await pubSubmit(s,
      { identity: "dedi@x.id", answers: { [eQ]: "dedi@x.id", [kQ]: "luar biasa" } },
      "10.9.1.4", "PUT");
    expect(r.status).toBe(200);
    r = await pubMine(s, "dedi@x.id", "10.9.1.5");
    expect((await r.json()).answers[kQ]).toBe("luar biasa");

    // identitas tak dikenal -> 404
    r = await pubMine(s, "asing@x.id", "10.9.1.6");
    expect(r.status).toBe(404);

    // kunci identitas tidak boleh diganti saat PUT -> 400
    r = await pubSubmit(s,
      { identity: "dedi@x.id", answers: { [eQ]: "lain@x.id", [kQ]: "x" } },
      "10.9.1.7", "PUT");
    expect(r.status).toBe(400);
  });

  test("kuis: allow_edit dipaksa nonaktif di skema & edit ditolak", async () => {
    const f = await adminReq("/api/forms", "POST",
      { title: "KuisEdit", settings: { is_quiz: true, allow_edit: true } });
    const form = (await f.json()).form;
    const q1 = await adminReq(`/api/forms/${form.id}/questions`, "POST",
      { qtype: "short_text", prompt: "Email", required: true, is_identity: true });
    const eQ = (await q1.json()).question.id;
    await adminReq(`/api/forms/${form.id}`, "PATCH", { is_published: true });
    const s = form.slug;

    const j = await (await pubGet(s)).json();
    expect(j.form.settings.allow_edit).toBe(false); // dipaksa mati untuk kuis

    let r = await pubSubmit(s, { answers: { [eQ]: "q@x.id" } }, "10.9.2.1");
    expect(r.status).toBe(200);
    r = await pubSubmit(s, { answers: { [eQ]: "q@x.id" } }, "10.9.2.2");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBeUndefined();
    r = await pubMine(s, "q@x.id", "10.9.2.3");
    expect(r.status).toBe(403);
    r = await pubSubmit(s, { identity: "q@x.id", answers: { [eQ]: "q@x.id" } }, "10.9.2.4", "PUT");
    expect(r.status).toBe(403);
  });
});
