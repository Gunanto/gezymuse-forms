import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { getDb } from "./db";

const SESSION_COOKIE = "gezyform_session";
const SESSION_DAYS = 7;

// Rate-limit login: 10x gagal / IP / 10 menit -> 429.
const fails = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

export async function loginHandler(c: Context) {
  const ip = clientIp(c);
  const now = Date.now();
  const rec = fails.get(ip);
  if (rec && now < rec.resetAt && rec.count >= MAX_FAILS) {
    return c.json({ error: "Terlalu banyak percobaan gagal. Coba lagi beberapa menit." }, 429);
  }

  let body: { username?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body request tidak valid" }, 400);
  }

  const db = getDb();
  const user = db
    .query("SELECT id, username, password_hash FROM users WHERE username = ?")
    .get(body.username || "") as { id: number; username: string; password_hash: string } | null;
  const ok = user ? await Bun.password.verify(body.password || "", user.password_hash) : false;

  if (!ok) {
    const r = fails.get(ip);
    if (!r || now >= r.resetAt) fails.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else r.count++;
    return c.json({ error: "Username atau password salah" }, 401);
  }
  fails.delete(ip);

  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    user!.id,
    expires
  );
  db.query("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  const proto = c.req.header("x-forwarded-proto");
  const secure = process.env.COOKIE_SECURE === "1" || proto === "https";
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure,
    maxAge: SESSION_DAYS * 86400,
  });
  return c.json({ ok: true, username: user!.username });
}

export async function logoutHandler(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) getDb().query("DELETE FROM sessions WHERE id = ?").run(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
}

export const requireAuth = createMiddleware(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Belum login" }, 401);
  const row = getDb()
    .query(
      `SELECT u.id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .get(token) as { id: number; username: string } | null;
  if (!row) return c.json({ error: "Sesi tidak valid / kedaluwarsa" }, 401);
  c.set("user", { id: row.id, username: row.username });
  await next();
});
