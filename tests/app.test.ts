import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootApp } from "../src/app";

let app: Awaited<ReturnType<typeof bootApp>>;
const PW = "test-gezyform-123";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gezyform-test-"));
  process.env.ADMIN_PASSWORD = PW;
  app = await bootApp(dir);
});

async function login(ip: string, password: string) {
  return app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ username: "admin", password }),
  });
}

describe("Tahap 1 — fondasi", () => {
  test("GET /api/health -> 200 ok", async () => {
    const r = await app.request("/api/health");
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  test("GET /api/me tanpa login -> 401", async () => {
    const r = await app.request("/api/me");
    expect(r.status).toBe(401);
  });

  test("login benar -> cookie sesi + /api/me 200", async () => {
    const r = await login("1.1.1.1", PW);
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") || "";
    expect(setCookie).toContain("gezyform_session");
    expect(setCookie).toContain("HttpOnly");
    const me = await app.request("/api/me", {
      headers: { cookie: setCookie.split(";")[0] },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe("admin");
  });

  test("login salah -> 401", async () => {
    const r = await login("2.2.2.2", "salah");
    expect(r.status).toBe(401);
  });

  test("logout menghapus sesi", async () => {
    const r = await login("3.3.3.3", PW);
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    const lo = await app.request("/api/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(lo.status).toBe(200);
    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  test("rate-limit: 10x gagal dari 1 IP -> 429", async () => {
    for (let i = 0; i < 10; i++) await login("9.9.9.9", "salah");
    const r = await login("9.9.9.9", "salah");
    expect(r.status).toBe(429);
  });

  test("GET /f/abc1234 menyajikan form.html", async () => {
    const r = await app.request("/f/abc1234");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });
});
