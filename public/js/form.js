/* GezyForm — halaman responden (Tahap 3), gaya Google Forms */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const slug = location.pathname.split("/").filter(Boolean).pop() || "";
let schema = null;
let editMode = false;

function showError(msg) {
  $("loading").hidden = true;
  $("errorMsg").textContent = msg;
  $("errorView").hidden = false;
  document.title = "Formulir tidak tersedia — GezyForm";
}

function inputFor(q, showPoints) {
  const req = q.required ? `<span class="req">*</span>` : "";
  const pts = showPoints && q.points > 0 ? ` <span class="pts">${q.points} poin</span>` : "";
  const head = `<div class="qprompt">${esc(q.prompt)}${req}${pts}</div>`;
  const name = `q_${q.id}`;
  if (q.qtype === "short_text") {
    const emailAttrs = q.validation === "email" ? ` type="email" inputmode="email"` : "";
    const namaAttrs = q.validation === "nama" ? ` maxlength="30"` : "";
    return `${head}<input class="gf-text" data-q="${q.id}" data-t="text"${emailAttrs}${namaAttrs} placeholder="Jawaban Anda">`;
  }
  if (q.qtype === "paragraph")
    return `${head}<textarea class="gf-text" data-q="${q.id}" data-t="text" rows="2" placeholder="Jawaban Anda"></textarea>`;
  if (q.qtype === "multiple_choice")
    return (
      head +
      q.options.map((o) => `<label class="gf-opt"><input type="radio" name="${name}" value="${esc(o)}" data-q="${q.id}" data-t="choice"><span>${esc(o)}</span></label>`).join("")
    );
  if (q.qtype === "checkboxes")
    return (
      head +
      q.options.map((o) => `<label class="gf-opt"><input type="checkbox" value="${esc(o)}" data-q="${q.id}" data-t="checks"><span>${esc(o)}</span></label>`).join("")
    );
  if (q.qtype === "dropdown")
    return `${head}<select class="gf-select" data-q="${q.id}" data-t="choice">
      <option value="">— Pilih —</option>
      ${q.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
  if (q.qtype === "linear_scale") {
    const o = q.options;
    const nums = [];
    for (let n = o.min; n <= o.max; n++) nums.push(n);
    return `${head}<div class="gf-scale">
      <span class="slabel">${esc(o.minLabel || o.min)}</span>
      <span class="svals">${nums.map((n) => `<label><span>${n}</span><input type="radio" name="${name}" value="${n}" data-q="${q.id}" data-t="scale"></label>`).join("")}</span>
      <span class="slabel">${esc(o.maxLabel || o.max)}</span>
    </div>`;
  }
  return head;
}

function render() {
  const f = schema.form;
  document.title = f.title + " — GezyForm";
  $("fTitle").textContent = f.title;
  $("fDesc").textContent = f.description || "";
  const showPoints = !!f.settings.is_quiz;
  $("qList").innerHTML = schema.questions
    .map((q) => `<div class="gf-card gf-q" data-card="${q.id}">${inputFor(q, showPoints)}</div>`)
    .join("");
  $("loading").hidden = true;
  $("formView").hidden = false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAMA_RE = /^[\p{L} .',]+$/u;

function collect() {
  const answers = {};
  let firstInvalid = null;
  let badEmail = false;
  let badNama = false;
  for (const q of schema.questions) {
    const card = document.querySelector(`[data-card="${q.id}"]`);
    let val;
    if (q.qtype === "short_text" || q.qtype === "paragraph") {
      val = card.querySelector("[data-t=text]").value.trim();
    } else if (q.qtype === "multiple_choice" || q.qtype === "linear_scale") {
      const sel = card.querySelector("input:checked");
      val = sel ? (q.qtype === "linear_scale" ? Number(sel.value) : sel.value) : "";
    } else if (q.qtype === "checkboxes") {
      val = [...card.querySelectorAll("input:checked")].map((i) => i.value);
    } else if (q.qtype === "dropdown") {
      val = card.querySelector("select").value;
    }
    const empty = val === "" || val === undefined || (Array.isArray(val) && !val.length);
    card.classList.remove("invalid");
    if (empty && q.required) {
      card.classList.add("invalid");
      if (!firstInvalid) firstInvalid = card;
      continue;
    }
    if (!empty && q.validation === "email" && !EMAIL_RE.test(val)) {
      card.classList.add("invalid");
      if (!firstInvalid) firstInvalid = card;
      badEmail = true;
      continue;
    }
    if (!empty && q.validation === "nama") {
      const clean = val.replace(/\s+/g, " ");
      if (clean.length > 30 || !NAMA_RE.test(clean)) {
        card.classList.add("invalid");
        if (!firstInvalid) firstInvalid = card;
        badNama = true;
        continue;
      }
    }
    if (!empty) answers[q.id] = val;
  }
  return { answers, firstInvalid, badEmail, badNama };
}

function identityValue() {
  const qid = schema.form.settings.identity_qid;
  if (!qid) return "";
  const card = document.querySelector(`[data-card="${qid}"]`);
  const inp = card && card.querySelector("[data-t=text]");
  return inp ? inp.value.trim() : "";
}

async function submit() {
  const errBox = $("serverErr");
  errBox.hidden = true;
  const { answers, firstInvalid, badEmail, badNama } = collect();
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    errBox.textContent = badEmail
      ? "Ada alamat email yang formatnya salah (ditandai merah). Contoh: nama@sekolah.id"
      : badNama
        ? "Ada isian nama yang tidak valid (ditandai merah): maks 30 karakter, hanya huruf, spasi, titik, koma, dan petik satu."
        : "Masih ada pertanyaan wajib yang belum dijawab (ditandai merah).";
    errBox.hidden = false;
    return;
  }
  const btn = $("btnSubmit");
  btn.disabled = true;
  btn.textContent = editMode ? "Memperbarui…" : "Mengirim…";
  try {
    const payload = editMode ? { identity: identityValue(), answers } : { answers };
    const r = await fetch(`/api/public/forms/${encodeURIComponent(slug)}/submit`, {
      method: editMode ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Identitas sudah mengisi & boleh ubah: tawarkan memuat jawaban lama.
      if (r.status === 409 && j.code === "already_submitted" && !editMode) {
        $("dupBox").hidden = false;
        $("dupBox").scrollIntoView({ behavior: "smooth", block: "center" });
        btn.disabled = false;
        btn.textContent = "Kirim";
        return;
      }
      throw new Error(j.error || `Gagal mengirim (HTTP ${r.status})`);
    }
    $("formView").hidden = true;
    if (editMode) $("doneTitle").textContent = "Jawaban diperbarui ✓";
    if (j.score !== undefined) {
      $("scoreBox").hidden = false;
      $("scoreText").textContent = `Nilai: ${j.score} dari ${j.total_points}`;
    }
    if (j.review) renderReview(j.review);
    $("doneView").hidden = false;
    window.scrollTo(0, 0);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
    errBox.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.disabled = false;
    btn.textContent = editMode ? "Perbarui jawaban" : "Kirim";
  }
}

function fillForm(answers) {
  for (const q of schema.questions) {
    const card = document.querySelector(`[data-card="${q.id}"]`);
    if (!card) continue;
    const v = answers[String(q.id)] ?? answers[q.id];
    if (v === null || v === undefined) continue;
    if (q.qtype === "short_text" || q.qtype === "paragraph") {
      card.querySelector("[data-t=text]").value = v;
    } else if (q.qtype === "multiple_choice" || q.qtype === "linear_scale") {
      const target = String(v);
      card.querySelectorAll("input").forEach((i) => { i.checked = i.value === target; });
    } else if (q.qtype === "checkboxes") {
      const set = new Set((Array.isArray(v) ? v : []).map(String));
      card.querySelectorAll("input").forEach((i) => { i.checked = set.has(i.value); });
    } else if (q.qtype === "dropdown") {
      card.querySelector("select").value = v;
    }
  }
}

function enterEditMode() {
  editMode = true;
  $("dupBox").hidden = true;
  $("editBar").hidden = false;
  const qid = schema.form.settings.identity_qid;
  if (qid) {
    const card = document.querySelector(`[data-card="${qid}"]`);
    const inp = card && card.querySelector("[data-t=text]");
    if (inp) {
      inp.disabled = true;
      const note = document.createElement("div");
      note.className = "gf-lock";
      note.textContent = "🔒 Kunci identitas tidak bisa diubah.";
      card.appendChild(note);
    }
  }
  $("btnSubmit").textContent = "Perbarui jawaban";
  window.scrollTo(0, 0);
}

async function loadMine() {
  const idv = identityValue();
  if (!idv) {
    $("serverErr").textContent = "Isi dulu kunci identitas (mis. email) pada formulir, lalu klik “Ubah jawaban saya”.";
    $("serverErr").hidden = false;
    return;
  }
  const btn = $("btnEditMine");
  btn.disabled = true;
  btn.textContent = "Memuat…";
  try {
    const r = await fetch(
      `/api/public/forms/${encodeURIComponent(slug)}/mine?identity=${encodeURIComponent(idv)}`
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Gagal memuat jawaban.");
    fillForm(j.answers);
    enterEditMode();
  } catch (e) {
    $("serverErr").textContent = e.message;
    $("serverErr").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Ubah jawaban saya";
  }
}

function fmtAns(v) {
  if (v === null || v === undefined || v === "") return "—";
  return Array.isArray(v) ? v.join("; ") : String(v);
}

function renderReview(review) {
  const box = $("reviewList");
  box.innerHTML = `<div class="gf-card"><h3 class="rv-title">Pembahasan</h3>` +
    review.map((r, i) => {
      let status;
      if (r.is_correct === true) status = `<span class="rv-ok">✓ Benar (+${r.points_earned})</span>`;
      else if (r.is_correct === false) status = `<span class="rv-bad">✗ Kurang tepat (+${r.points_earned})</span>`;
      else if (r.needs_manual) status = `<span class="rv-man">⏳ Dinilai manual oleh guru</span>`;
      else status = `<span class="muted">Tidak dinilai</span>`;
      const key = r.correct_answer !== null && r.correct_answer !== undefined
        ? `<div class="rv-key">Kunci: <b>${esc(fmtAns(r.correct_answer))}</b></div>` : "";
      return `<div class="rv-item">
        <div class="qprompt">${i + 1}. ${esc(r.prompt)} <span class="rv-pts">${r.points} poin</span></div>
        <div>Jawaban Anda: <b>${esc(fmtAns(r.your_answer))}</b> ${status}</div>
        ${key}
      </div>`;
    }).join("") + `</div>`;
}

(async function init() {
  try {
    const r = await fetch(`/api/public/forms/${encodeURIComponent(slug)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Formulir tidak tersedia.");
    schema = j;
    if (!schema.questions.length) throw new Error("Formulir ini belum memiliki soal.");
    render();
  } catch (e) {
    showError(e.message);
  }
})();

$("btnSubmit").addEventListener("click", submit);
$("btnEditMine").addEventListener("click", loadMine);
$("btnDupClose").addEventListener("click", () => { $("dupBox").hidden = true; });
