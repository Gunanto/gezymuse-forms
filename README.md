# GezyForm 📝

Aplikasi formulir ala Google Forms — buat formulir, bagikan link publik,
kumpulkan jawaban, lihat ringkasan & ekspor. Mode kuis dengan penilaian
otomatis.

**Stack:** Bun + Hono + `bun:sqlite` (tanpa server database terpisah).

## Mulai cepat (lokal)

```bash
bun install
bun run src/index.ts
# buka http://localhost:3022/admin
```

Variabel environment (lihat `deploy/.env.example`):
`PORT` (default 3022), `DATA_DIR` (default `./data`),
`ADMIN_PASSWORD`, `COOKIE_SECURE`.

## Struktur

```
src/
  index.ts   # entrypoint (listen port)
  app.ts     # bootApp(): rakit Hono app (dipakai juga oleh test)
  db.ts      # bun:sqlite, migrasi idempoten, slug, seed admin
  auth.ts    # login/logout/sesi + rate-limit + middleware requireAuth
public/
  admin.html # panel admin (login + dashboard; builder = Tahap 2)
  form.html  # halaman responden /f/:slug (penuh = Tahap 3)
  css/       # style bersama
tests/
  app.test.ts
deploy/
  gezyform.service, nginx.conf, backup.sh, .env.example, DEPLOY.md
```

## API (Tahap 1)

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | /api/health | — | cek hidup |
| POST | /api/login | — | `{username, password}` → cookie sesi (rate-limit 10x/IP/10 mnt) |
| POST | /api/logout | — | hapus sesi |
| GET | /api/me | sesi | info user login |
| GET | /f/:slug | — | halaman responden publik |

## Tahapan

1. ✅ Fondasi: server + DB + auth + health + file deploy
2. Builder: CRUD form & soal (6 tipe MVP), admin UI
3. Responden: render `/f/:slug`, validasi server-side, cegah ganda
4. Hasil: tabel respons, grafik ringkasan, ekspor CSV/Word
5. Kuis: kunci jawaban, skor otomatis server-side
6. Hardening: rate-limit submit, backup, uji penuh

## Deploy

Lihat `deploy/DEPLOY.md` (systemd port 3022 + nginx + backup harian).
