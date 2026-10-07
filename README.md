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
| GET | /api/forms | sesi | daftar formulir (+ jumlah soal & respons) |
| POST | /api/forms | sesi | buat formulir `{title, description?, settings?}` → slug otomatis |
| GET | /api/forms/:id | sesi | detail formulir + daftar soal |
| PATCH | /api/forms/:id | sesi | ubah judul/deskripsi/publish/settings |
| DELETE | /api/forms/:id | sesi | hapus formulir (cascade) |
| POST | /api/forms/:id/duplicate | sesi | duplikat formulir + soal (slug baru, status draf) |
| POST | /api/forms/:id/questions | sesi | tambah soal (6 tipe, tervalidasi) |
| PATCH | /api/questions/:qid | sesi | ubah soal (parsial, validasi penuh) |
| DELETE | /api/questions/:qid | sesi | hapus soal |
| POST | /api/forms/:id/questions/reorder | sesi | susun ulang soal `{order: [id...]}` |
| GET | /f/:slug | — | halaman responden publik |
| GET | /api/public/forms/:slug | — | skema soal publik (tanpa kunci jawaban; hormati acak/publish/deadline/batas) |
| POST | /api/public/forms/:slug/submit | — | kirim jawaban `{respondent_name?, respondent_class?, answers}` → validasi server-side, cegah ganda, skor otomatis bila kuis (rate-limit 20x/IP/10 mnt) |
| GET | /api/forms/:id/responses | sesi | daftar respons (paginasi `?page&limit`) |
| GET | /api/forms/:id/responses/:rid | sesi | detail satu respons + jawabannya |
| DELETE | /api/forms/:id/responses/:rid | sesi | hapus satu respons |
| GET | /api/forms/:id/summary | sesi | ringkasan per soal (hitungan opsi, rata-rata skala, sampel teks, akurasi kuis) |
| GET | /api/forms/:id/export.csv | sesi | unduh CSV (BOM, escaping benar) |
| GET | /api/forms/:id/export/word | sesi | unduh Word (.doc tabel) |
| PATCH | /api/forms/:id/responses/:rid/score | sesi | koreksi skor manual (0–total poin) |

## Tahapan

1. ✅ Fondasi: server + DB + auth + health + file deploy
2. ✅ Builder: CRUD form & soal (6 tipe MVP), admin UI
3. ✅ Responden: halaman /f/:slug ala Google Forms + submit tervalidasi
4. ✅ Hasil: tabel respons, grafik ringkasan, ekspor CSV/Word
5. ✅ Kuis: nilai + pembahasan per soal, statistik nilai, koreksi manual
6. Hardening: rate-limit submit, backup, uji penuh + restyle builder ala Google Forms

## Deploy

Lihat `deploy/DEPLOY.md` (systemd port 3022 + nginx + backup harian).
