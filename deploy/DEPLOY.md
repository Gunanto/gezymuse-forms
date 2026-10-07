# DEPLOY.md — GezyForm di VPS

Panduan untuk Pak Gun. Aplikasi: Bun + Hono + SQLite, port **3022**.

## 1. Persiapan awal (sekali saja)

```bash
sudo mkdir -p /opt/gezyform/data /opt/gezyform/backup
sudo chown -R $USER:$USER /opt/gezyform
cd /opt/gezyform
git clone git@github-gezymuse-forms:Gunanto/gezymuse-forms.git
# (atau: git clone https://github.com/Gunanto/gezymuse-forms.git)
cd gezymuse-forms
bun install
```

## 2. Environment

```bash
cp deploy/.env.example .env
nano .env   # isi ADMIN_PASSWORD yang kuat, pastikan COOKIE_SECURE=1
```

## 3. Systemd

```bash
sudo cp deploy/gezyform.service /etc/systemd/system/
sudo nano /etc/systemd/system/gezyform.service  # ganti USER_VPS
# (password admin TIDAK perlu diset di file service — cukup di .env, langkah 2)
sudo systemctl daemon-reload
sudo systemctl enable --now gezyform
sudo systemctl status gezyform   # pastikan active (running)
```

Password admin pertama: kalau `ADMIN_PASSWORD` dikosongkan,
password acak tampil sekali di `sudo journalctl -u gezyform`.

## 4. Nginx

Tempel isi `deploy/nginx.conf` ke blok `server` domain yang dipakai
(mis. `forms.gezytech.web.id`), lalu:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Pastikan domain sudah HTTPS (certbot) agar cookie sesi aman.

## 5. Backup harian

```bash
chmod +x deploy/backup.sh
crontab -e
# tambah baris:
0 2 * * * /opt/gezyform/gezymuse-forms/deploy/backup.sh >> /opt/gezyform/backup/backup.log 2>&1
```

## 6. Update (rutin)

```bash
cd /opt/gezyform/gezymuse-forms
git pull
bun install
sudo systemctl restart gezyform
```

Migrasi database otomatis & idempoten — aman dijalankan ulang.
