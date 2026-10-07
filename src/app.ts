import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { initDb, ensureAdmin } from "./db";
import { loginHandler, logoutHandler, requireAuth } from "./auth";
import adminRoutes from "./admin";

// bootApp: siapkan DB + admin, kembalikan aplikasi Hono (tanpa listen,
// supaya bisa dipakai langsung oleh bun test via app.request()).
export async function bootApp(dataDir: string) {
  initDb(dataDir);
  const admin = await ensureAdmin();
  if (admin.generatedPassword) {
    console.log("==============================================");
    console.log(" Akun admin dibuat otomatis:");
    console.log(`   username : ${admin.username}`);
    console.log(`   password : ${admin.generatedPassword}`);
    console.log(" (hanya tampil sekali — simpan baik-baik,");
    console.log("  atau set ADMIN_PASSWORD di environment)");
    console.log("==============================================");
  }

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "SAMEORIGIN");
    c.header("Referrer-Policy", "no-referrer-when-downgrade");
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, app: "gezymuse-forms", version: "0.1.0" })
  );
  app.post("/api/login", loginHandler);
  app.post("/api/logout", logoutHandler);
  app.get("/api/me", requireAuth, (c) => c.json({ user: c.get("user") }));

  // API Tahap 2 (builder admin). Tahap 3 (publik) & Tahap 4 (hasil) menyusul.
  app.route("/api", adminRoutes);

  app.get("/admin", (c) => c.redirect("/admin.html"));

  // Halaman responden publik: /f/:slug (diisi penuh di Tahap 3)
  app.get("/f/:slug", async (c) => {
    const f = Bun.file("public/form.html");
    if (!(await f.exists())) return c.text("Halaman formulir belum tersedia", 404);
    return new Response(f, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  app.use("/*", serveStatic({ root: "./public" }));
  app.notFound((c) => c.text("404 — tidak ditemukan", 404));

  return app;
}
