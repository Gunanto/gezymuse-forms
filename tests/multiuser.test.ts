import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
const PW = "test-mu-321";
let adminCookie = "";
let guruCookie = "";
let adminFormId = 0;
let guruFormId = 0;
let guruId = 0;

async function req(path: string, method = "GET", body?: unknown, cookie = "") {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login(username: string, password: string) {
  const r = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-mu-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
  const a = await login("admin", PW);
  adminCookie = a.cookie;
  expect(a.status).toBe(200);
  // Admin membuat satu formulir miliknya.
  const f = await req("/api/forms", "POST", { title: "Form Admin" }, adminCookie);
  adminFormId = (await f.json()).form.id;
});

describe("Multi-user: admin & guru", () => {
  test("admin membuat akun guru -> 201; validasi username & password", async () => {
    let r = await req("/api/users", "POST", { username: "bu.ani", password: "rahasia1", role: "guru" }, adminCookie);
    expect(r.status).toBe(201);
    const j = await r.json();
    guruId = j.user.id;
    expect(j.user.role).toBe("guru");
    expect("password_hash" in j.user).toBe(false);
    // username jelek & password pendek ditolak
    r = await req("/api/users", "POST", { username: "x", password: "rahasia1" }, adminCookie);
    expect(r.status).toBe(400);
    r = await req("/api/users", "POST", { username: "bu.ani", password: "lain123" }, adminCookie);
    expect(r.status).toBe(409);
    r = await req("/api/users", "POST", { username: "pak.budi", password: "123" }, adminCookie);
    expect(r.status).toBe(400);
  });

  test("guru login & hanya melihat formulir miliknya", async () => {
    const g = await login("bu.ani", "rahasia1");
    expect(g.status).toBe(200);
    guruCookie = g.cookie;
    const me = await (await req("/api/me", "GET", undefined, guruCookie)).json();
    expect(me.user.role).toBe("guru");
    // Guru membuat formulir sendiri.
    const f = await req("/api/forms", "POST", { title: "Form Bu Ani" }, guruCookie);
    expect(f.status).toBe(201);
    guruFormId = (await f.json()).form.id;
    // Daftar: guru hanya lihat 1, admin lihat 2 (+ nama pemilik).
    let list = await (await req("/api/forms", "GET", undefined, guruCookie)).json();
    expect(list.forms).toHaveLength(1);
    expect(list.forms[0].title).toBe("Form Bu Ani");
    list = await (await req("/api/forms", "GET", undefined, adminCookie)).json();
    expect(list.forms).toHaveLength(2);
    expect(list.forms.some((x: any) => x.owner_name === "bu.ani")).toBe(true);
  });

  test("guru tidak bisa mengakses formulir admin (404 tersamar)", async () => {
    let r = await req(`/api/forms/${adminFormId}`, "GET", undefined, guruCookie);
    expect(r.status).toBe(404);
    r = await req(`/api/forms/${adminFormId}`, "DELETE", undefined, guruCookie);
    expect(r.status).toBe(404);
    r = await req(`/api/forms/${adminFormId}/questions`, "POST", { qtype: "short_text", prompt: "X" }, guruCookie);
    expect(r.status).toBe(404);
    r = await req(`/api/forms/${adminFormId}/responses`, "GET", undefined, guruCookie);
    expect(r.status).toBe(404);
    r = await req(`/api/forms/${adminFormId}/summary`, "GET", undefined, guruCookie);
    expect(r.status).toBe(404);
  });

  test("guru tidak bisa membuka /api/users (403)", async () => {
    const r = await req("/api/users", "GET", undefined, guruCookie);
    expect(r.status).toBe(403);
    const r2 = await req("/api/users", "POST", { username: "nakal", password: "rahasia1" }, guruCookie);
    expect(r2.status).toBe(403);
  });

  test("guru bisa mengelola formulirnya sendiri penuh", async () => {
    let r = await req(`/api/forms/${guruFormId}/questions`, "POST",
      { qtype: "short_text", prompt: "Nama" }, guruCookie);
    expect(r.status).toBe(201);
    const qid = (await r.json()).question.id;
    r = await req(`/api/forms/${guruFormId}`, "PATCH", { is_published: true }, guruCookie);
    expect(r.status).toBe(200);
    r = await req(`/api/questions/${qid}`, "DELETE", undefined, guruCookie);
    expect(r.status).toBe(200);
  });

  test("guru ganti password sendiri; password lama salah ditolak", async () => {
    let r = await req("/api/users/me/password", "PATCH",
      { old_password: "salah", new_password: "baru1234" }, guruCookie);
    expect(r.status).toBe(400);
    r = await req("/api/users/me/password", "PATCH",
      { old_password: "rahasia1", new_password: "baru1234" }, guruCookie);
    expect(r.status).toBe(200);
    const g = await login("bu.ani", "baru1234");
    expect(g.status).toBe(200);
    guruCookie = g.cookie;
  });

  test("admin reset password guru -> sesi lama hangus", async () => {
    const r = await req(`/api/users/${guruId}`, "PATCH", { password: "reset999" }, adminCookie);
    expect(r.status).toBe(200);
    // cookie lama guru sudah tidak berlaku
    const me = await req("/api/me", "GET", undefined, guruCookie);
    expect(me.status).toBe(401);
    const g = await login("bu.ani", "reset999");
    expect(g.status).toBe(200);
    guruCookie = g.cookie;
  });

  test("admin tidak bisa hapus diri sendiri / satu-satunya admin", async () => {
    const me = await (await req("/api/me", "GET", undefined, adminCookie)).json();
    let r = await req(`/api/users/${me.user.id}`, "DELETE", undefined, adminCookie);
    expect(r.status).toBe(400);
    // buat admin kedua, hapus dia boleh
    const r2 = await req("/api/users", "POST", { username: "admin2", password: "rahasia1", role: "admin" }, adminCookie);
    const aid2 = (await r2.json()).user.id;
    r = await req(`/api/users/${aid2}`, "DELETE", undefined, adminCookie);
    expect(r.status).toBe(200);
  });

  test("hapus akun guru -> formulirnya ikut terhapus", async () => {
    const r = await req(`/api/users/${guruId}`, "DELETE", undefined, adminCookie);
    expect(r.status).toBe(200);
    const g = await req(`/api/forms/${guruFormId}`, "GET", undefined, adminCookie);
    expect(g.status).toBe(404);
    // formulir admin tetap ada
    const a = await req(`/api/forms/${adminFormId}`, "GET", undefined, adminCookie);
    expect(a.status).toBe(200);
  });
});
