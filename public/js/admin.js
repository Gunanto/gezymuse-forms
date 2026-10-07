/* GezyForm Admin — dashboard + builder (Tahap 2) */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const QTYPES = [
  ["short_text", "Teks singkat"],
  ["paragraph", "Paragraf"],
  ["multiple_choice", "Pilihan ganda"],
  ["checkboxes", "Kotak centang"],
  ["dropdown", "Dropdown"],
  ["linear_scale", "Skala linear"],
];
const QLABEL = Object.fromEntries(QTYPES);
const CHOICE_TYPES = ["multiple_choice", "checkboxes", "dropdown"];

const state = { form: null, questions: [], editingQ: null };

async function api(path, method = "GET", body) {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function show(view) {
  for (const v of ["loginCard", "dashView", "editorView", "resultsView"]) $(v).hidden = v !== view;
  $("btnLogout").hidden = view === "loginCard";
  $("mainBrand").hidden = view === "editorView"; // editor punya topbar sendiri
}

function showPane(p) {
  $("paneQ").hidden = p !== "Q";
  $("paneS").hidden = p !== "S";
  $("tabQ").classList.toggle("active", p === "Q");
  $("tabS").classList.toggle("active", p === "S");
  window.scrollTo(0, 0);
}

function updatePublishBtn() {
  const on = !!state.form.is_published;
  const b = $("btnPublishTop");
  b.textContent = on ? "✓ Terpublikasi" : "Publikasikan";
  b.classList.toggle("is-off", on);
  $("pubState").textContent = on ? "Formulir bisa diisi responden." : "Draf — responden belum bisa mengisi.";
}

function updateAnswerBadge() {
  const n = state.form.response_count || 0;
  $("tabABadge").hidden = !n;
  $("tabABadge").textContent = n;
}

/* ---------- auth ---------- */

async function refresh() {
  const r = await fetch("/api/me");
  if (r.ok) {
    show("dashView");
    loadDashboard();
  } else {
    show("loginCard");
  }
}

async function doLogin() {
  $("loginErr").hidden = true;
  try {
    await api("/api/login", "POST", { username: $("username").value, password: $("password").value });
    $("password").value = "";
    show("dashView");
    loadDashboard();
  } catch (e) {
    $("loginErr").textContent = e.message;
    $("loginErr").hidden = false;
  }
}

/* ---------- dashboard ---------- */

async function loadDashboard() {
  try {
    const { forms } = await api("/api/forms");
    const list = $("formList");
    if (!forms.length) {
      list.innerHTML = `<div class="card"><p class="muted">Belum ada formulir. Buat yang pertama di atas 👆</p></div>`;
      return;
    }
    list.innerHTML = forms
      .map(
        (f) => `
      <div class="card formcard">
        <div>
          <h3>${esc(f.title)}</h3>
          <p class="muted">${esc(f.description || "—")}</p>
          <div class="badges">
            <span class="badge ${f.is_published ? "on" : ""}">${f.is_published ? "🟢 Publik" : "⚪ Draf"}</span>
            <span class="badge">${f.question_count} soal</span>
            <span class="badge">${f.response_count} respons</span>
          </div>
          <div class="linkrow"><code>${esc(location.origin + "/f/" + f.slug)}</code></div>
        </div>
        <div class="qactions col">
          <button class="btn small" data-act="edit" data-id="${f.id}">Kelola</button>
          <button class="btn small ghost" data-act="dup" data-id="${f.id}">Duplikat</button>
          <button class="btn small ghost" data-act="del" data-id="${f.id}" data-title="${esc(f.title)}">Hapus</button>
          <button class="btn small ghost" data-act="results" data-id="${f.id}">Hasil</button>
        </div>
      </div>`
      )
      .join("");
    list.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.id;
        if (b.dataset.act === "edit") openEditor(id);
        else if (b.dataset.act === "dup") duplicateForm(id);
        else if (b.dataset.act === "del") deleteForm(id, b.dataset.title);
        else if (b.dataset.act === "results") openResults(Number(id));
      })
    );
  } catch (e) {
    toast(e.message, true);
  }
}

async function duplicateForm(id) {
  try {
    await api(`/api/forms/${id}/duplicate`, "POST");
    toast("Formulir diduplikat");
    loadDashboard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteForm(id, title) {
  if (!confirm(`Hapus formulir "${title}" beserta semua soal & responsnya?`)) return;
  try {
    await api(`/api/forms/${id}`, "DELETE");
    toast("Formulir dihapus");
    loadDashboard();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- editor ---------- */

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openEditor(id) {
  try {
    const { form, questions } = await api(`/api/forms/${id}`);
    state.form = form;
    state.questions = questions;
    state.editingQ = null;
    // meta
    $("fTitle").value = form.title;
    $("fTitleTop").value = form.title;
    $("fDesc").value = form.description || "";
    $("fLink").textContent = location.origin + "/f/" + form.slug;
    $("fOpen").href = "/f/" + form.slug;
    updatePublishBtn();
    updateAnswerBadge();
    showPane("Q");
    // settings
    const s = form.settings || {};
    $("sAccept").checked = s.accept_responses !== false;
    $("sQuiz").checked = !!s.is_quiz;
    $("sShowScore").checked = s.show_score !== false;
    $("sName").checked = s.require_name !== false;
    $("sShQ").checked = !!s.shuffle_questions;
    $("sShO").checked = !!s.shuffle_options;
    $("sDeadline").value = toLocalInput(s.deadline);
    $("sMaxResp").value = s.max_responses ?? "";
    resetQForm();
    renderQuestions();
    show("editorView");
  } catch (e) {
    toast(e.message, true);
  }
}

async function refreshEditor() {
  await openEditorKeepScroll();
}
async function openEditorKeepScroll() {
  const y = window.scrollY;
  await openEditor(state.form.id);
  window.scrollTo(0, y);
}

function renderQuestions() {
  const qs = [...state.questions].sort((a, b) => a.order_index - b.order_index);
  const box = $("qList");
  if (!qs.length) {
    box.innerHTML = `<p class="muted">Belum ada soal. Tambahkan di bawah 👇</p>`;
    return;
  }
  box.innerHTML = qs
    .map(
      (q, i) => `
    <div class="qitem">
      <div class="qnum">${i + 1}</div>
      <div class="qbody">
        <div class="qhead"><strong>${esc(q.prompt)}</strong></div>
        <div class="badges">
          <span class="badge">${QLABEL[q.qtype] || q.qtype}</span>
          ${q.required ? `<span class="badge req">wajib</span>` : ""}
          ${state.form.settings.is_quiz ? `<span class="badge">${q.points} poin</span>` : ""}
        </div>
        <div class="muted small">${esc(qPreview(q))}</div>
      </div>
      <div class="qactions">
        <button class="btn small ghost" data-a="up" data-id="${q.id}" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn small ghost" data-a="down" data-id="${q.id}" ${i === qs.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn small ghost" data-a="edit" data-id="${q.id}">Ubah</button>
        <button class="btn small ghost" data-a="del" data-id="${q.id}">Hapus</button>
      </div>
    </div>`
    )
    .join("");
  box.querySelectorAll("button[data-a]").forEach((b) =>
    b.addEventListener("click", () => qAction(b.dataset.a, Number(b.dataset.id)))
  );
}

function qPreview(q) {
  if (CHOICE_TYPES.includes(q.qtype)) return q.options.join(" · ");
  if (q.qtype === "linear_scale") {
    const o = q.options;
    return `Skala ${o.min}–${o.max}` + (o.minLabel || o.maxLabel ? ` (${o.minLabel || ""} … ${o.maxLabel || ""})` : "");
  }
  return q.qtype === "short_text" ? "Jawaban teks singkat" : "Jawaban paragraf";
}

async function qAction(a, id) {
  try {
    if (a === "del") {
      if (!confirm("Hapus soal ini?")) return;
      await api(`/api/questions/${id}`, "DELETE");
    } else if (a === "up" || a === "down") {
      const qs = [...state.questions].sort((x, y) => x.order_index - y.order_index);
      const i = qs.findIndex((q) => q.id === id);
      const j = i + (a === "up" ? -1 : 1);
      if (j < 0 || j >= qs.length) return;
      [qs[i], qs[j]] = [qs[j], qs[i]];
      await api(`/api/forms/${state.form.id}/questions/reorder`, "POST", { order: qs.map((q) => q.id) });
    } else if (a === "edit") {
      startEdit(id);
      return;
    }
    await refreshEditor();
    toast("Tersimpan");
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- form tambah/ubah soal ---------- */

function initQTypeSelect() {
  $("qType").innerHTML = QTYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}

function renderQFields() {
  const t = $("qType").value;
  const isChoice = CHOICE_TYPES.includes(t);
  $("qOptions").innerHTML = "";
  $("qOptions").dataset.t = t;
  $("qScale").hidden = t !== "linear_scale";
  if (isChoice) {
    $("qOptions").innerHTML = `
      <div id="optList"></div>
      <button type="button" id="btnAddOpt" class="btn small ghost">＋ Tambahkan opsi</button>`;
    const addOpt = (val = "") => {
      const row = document.createElement("div");
      row.className = "optrow";
      row.innerHTML = `<input class="optInput" value="${esc(val)}" placeholder="Tulis opsi…">
        <button type="button" class="btn small ghost optDel">✕</button>`;
      row.querySelector(".optDel").addEventListener("click", () => {
        if (document.querySelectorAll(".optInput").length > 2) row.remove();
        else toast("Minimal 2 opsi", true);
        renderCorrect();
      });
      row.querySelector(".optInput").addEventListener("input", renderCorrect);
      $("optList").appendChild(row);
    };
    $("btnAddOpt").addEventListener("click", () => { addOpt(); renderCorrect(); });
    addOpt();
    addOpt();
  }
  renderCorrect();
}

function currentOptions() {
  return [...document.querySelectorAll(".optInput")].map((i) => i.value.trim()).filter(Boolean);
}

function renderCorrect() {
  const wrap = $("qCorrectWrap");
  const isQuiz = state.form && state.form.settings.is_quiz;
  wrap.hidden = !isQuiz;
  if (!isQuiz) return;
  const t = $("qType").value;
  const box = $("qCorrect");
  const editing = state.editingQ;
  const cur = editing ? editing.correct_answer : null;
  if (t === "multiple_choice" || t === "dropdown") {
    const opts = currentOptions();
    box.innerHTML = `
      <select id="cAnswer">
        <option value="">— tanpa kunci —</option>
        ${opts.map((o) => `<option ${cur === o ? "selected" : ""}>${esc(o)}</option>`).join("")}
      </select>
      <p class="muted small">Pilih jawaban benar, atau kosongkan bila soal ini tanpa nilai.</p>`;
  } else if (t === "checkboxes") {
    const opts = currentOptions();
    const curArr = Array.isArray(cur) ? cur : [];
    box.innerHTML = opts.map((o) => `
      <label class="check"><input type="checkbox" class="cCheck" value="${esc(o)}" ${curArr.includes(o) ? "checked" : ""}> ${esc(o)}</label>
    `).join("") || `<p class="muted">Tambahkan opsi dulu.</p>`;
  } else if (t === "linear_scale") {
    const min = Number($("sMin").value), max = Number($("sMax").value);
    box.innerHTML = `<input type="number" id="cNumber" min="${min}" max="${max}" value="${cur ?? ""}" placeholder="Jawaban benar (${min}–${max})">`;
  } else {
    box.innerHTML = `<input id="cText" value="${esc(typeof cur === "string" ? cur : "")}" placeholder="Jawaban benar (teks)">`;
  }
}

function collectCorrect() {
  const t = $("qType").value;
  if (t === "multiple_choice" || t === "dropdown") {
    const v = $("cAnswer") ? $("cAnswer").value : "";
    return v || null;
  }
  if (t === "checkboxes")
    return [...document.querySelectorAll(".cCheck")].filter((c) => c.checked).map((c) => c.value);
  if (t === "linear_scale") {
    const v = $("cNumber") ? $("cNumber").value : "";
    return v === "" ? null : Number(v);
  }
  const v = $("cText") ? $("cText").value.trim() : "";
  return v || null;
}

function collectQuestion() {
  const qtype = $("qType").value;
  const prompt = $("qPrompt").value.trim();
  let options = [];
  if (CHOICE_TYPES.includes(qtype)) options = currentOptions();
  else if (qtype === "linear_scale")
    options = {
      min: Number($("sMin").value),
      max: Number($("sMax").value),
      minLabel: $("sMinLabel").value.trim(),
      maxLabel: $("sMaxLabel").value.trim(),
    };
  return {
    qtype,
    prompt,
    options,
    required: $("qRequired").checked,
    points: Number($("qPoints").value) || 0,
    correct_answer: collectCorrect(),
  };
}

function resetQForm() {
  state.editingQ = null;
  $("btnCancelQ").hidden = true;
  $("btnDupQ").hidden = true;
  $("btnDelQ").hidden = true;
  $("qFormTitle").textContent = "Pertanyaan baru";
  $("qType").value = "short_text";
  $("qPrompt").value = "";
  $("qRequired").checked = false;
  $("qPoints").value = 0;
  $("sMin").value = 1; $("sMax").value = 5;
  $("sMinLabel").value = ""; $("sMaxLabel").value = "";
  renderQFields();
}

function startEdit(id) {
  const q = state.questions.find((x) => x.id === id);
  if (!q) return;
  state.editingQ = q;
  $("qFormTitle").textContent = "Ubah pertanyaan";
  $("btnCancelQ").hidden = false;
  $("btnDupQ").hidden = false;
  $("btnDelQ").hidden = false;
  $("qType").value = q.qtype;
  $("qPrompt").value = q.prompt;
  $("qRequired").checked = q.required;
  $("qPoints").value = q.points;
  renderQFields();
  if (CHOICE_TYPES.includes(q.qtype)) {
    $("optList").innerHTML = "";
    const addOpt = (val = "") => {
      const row = document.createElement("div");
      row.className = "optrow";
      row.innerHTML = `<input class="optInput" value="${esc(val)}" placeholder="Tulis opsi…">
        <button type="button" class="btn small ghost optDel">✕</button>`;
      row.querySelector(".optDel").addEventListener("click", () => {
        if (document.querySelectorAll(".optInput").length > 2) row.remove();
        else toast("Minimal 2 opsi", true);
        renderCorrect();
      });
      row.querySelector(".optInput").addEventListener("input", renderCorrect);
      $("optList").appendChild(row);
    };
    q.options.forEach((o) => addOpt(o));
    // rebind tambah opsi
    $("btnAddOpt").addEventListener("click", () => { addOpt(); renderCorrect(); });
  } else if (q.qtype === "linear_scale") {
    $("sMin").value = q.options.min;
    $("sMax").value = q.options.max;
    $("sMinLabel").value = q.options.minLabel || "";
    $("sMaxLabel").value = q.options.maxLabel || "";
  }
  renderCorrect();
  $("qEditorCard").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("qPrompt").focus(), 350);
}

async function saveQuestion() {
  const payload = collectQuestion();
  try {
    if (state.editingQ) {
      await api(`/api/questions/${state.editingQ.id}`, "PATCH", payload);
      toast("Soal diubah");
    } else {
      await api(`/api/forms/${state.form.id}/questions`, "POST", payload);
      toast("Soal ditambahkan");
    }
    await refreshEditor();
    resetQForm();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- simpan meta & settings ---------- */

async function saveMeta() {
  try {
    const { form } = await api(`/api/forms/${state.form.id}`, "PATCH", {
      title: $("fTitle").value,
      description: $("fDesc").value,
    });
    const qc = state.form.question_count, rc = state.form.response_count;
    state.form = { ...state.form, ...form, question_count: qc, response_count: rc };
    $("fTitleTop").value = state.form.title;
    toast("Pengaturan tersimpan");
    renderQuestions(); // badge kuis bisa berubah
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveSettings() {
  const dl = $("sDeadline").value;
  const mr = $("sMaxResp").value;
  try {
    const { form } = await api(`/api/forms/${state.form.id}`, "PATCH", {
      settings: {
        accept_responses: $("sAccept").checked,
        is_quiz: $("sQuiz").checked,
        show_score: $("sShowScore").checked,
        require_name: $("sName").checked,
        shuffle_questions: $("sShQ").checked,
        shuffle_options: $("sShO").checked,
        deadline: dl ? new Date(dl).toISOString() : null,
        max_responses: mr === "" ? null : Number(mr),
      },
    });
    state.form = { ...state.form, ...form, question_count: state.form.question_count, response_count: state.form.response_count };
    toast("Opsi tersimpan");
    renderQuestions();
    renderCorrect();
  } catch (e) {
    toast(e.message, true);
  }
}

async function duplicateQuestion() {
  if (!state.editingQ) { toast("Buka soal dulu dengan tombol Ubah", true); return; }
  try {
    await api(`/api/forms/${state.form.id}/questions`, "POST", collectQuestion());
    toast("Soal diduplikat");
    await refreshEditor();
    resetQForm();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- wiring ---------- */

$("btnLogin").addEventListener("click", doLogin);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("btnLogout").addEventListener("click", async () => {
  await api("/api/logout", "POST").catch(() => {});
  refresh();
});
$("btnBack").addEventListener("click", () => { show("dashView"); loadDashboard(); });

$("btnCreate").addEventListener("click", async () => {
  const title = $("newTitle").value.trim();
  if (!title) { toast("Judul wajib diisi", true); return; }
  try {
    const { form } = await api("/api/forms", "POST", { title, description: $("newDesc").value.trim() });
    $("newTitle").value = ""; $("newDesc").value = "";
    toast("Formulir dibuat");
    openEditor(form.id);
  } catch (e) {
    toast(e.message, true);
  }
});

$("btnSaveMeta").addEventListener("click", saveMeta);
$("btnSaveSettings").addEventListener("click", saveSettings);
$("btnSaveQ").addEventListener("click", saveQuestion);
$("btnCancelQ").addEventListener("click", resetQForm);
$("btnDupQ").addEventListener("click", duplicateQuestion);
$("btnDelQ").addEventListener("click", async () => {
  if (!state.editingQ) return;
  if (!confirm("Hapus soal ini?")) return;
  try {
    await api(`/api/questions/${state.editingQ.id}`, "DELETE");
    toast("Soal dihapus");
    await refreshEditor();
    resetQForm();
  } catch (e) { toast(e.message, true); }
});
$("tabQ").addEventListener("click", () => showPane("Q"));
$("tabS").addEventListener("click", () => showPane("S"));
$("tabA").addEventListener("click", async () => {
  if (!state.form) return;
  try { // segarkan jumlah respons sebelum buka tab Jawaban
    const { form } = await api(`/api/forms/${state.form.id}`);
    state.form = form;
    updateAnswerBadge();
  } catch (e) { /* openResults akan menampilkan errornya */ }
  openResults(state.form.id);
});
$("fTitleTop").addEventListener("input", () => { $("fTitle").value = $("fTitleTop").value; });
$("btnPublishTop").addEventListener("click", async () => {
  const next = !state.form.is_published;
  try {
    const { form } = await api(`/api/forms/${state.form.id}`, "PATCH", { is_published: next });
    state.form = { ...state.form, ...form };
    updatePublishBtn();
    toast(next ? "Formulir dipublikasikan — bisa diisi responden" : "Publikasi dibatalkan");
  } catch (e) { toast(e.message, true); }
});
$("tbAdd").addEventListener("click", async () => {
  showPane("Q");
  if (state.editingQ) {
    // Sedang mengedit soal: jangan ganggu draf editan, cukup arahkan ke panel
  } else {
    // Jika ada draf yang diketik, simpan dulu supaya tidak hilang (seperti Google Forms)
    if ($("qPrompt").value.trim()) {
      try {
        await api(`/api/forms/${state.form.id}/questions`, "POST", collectQuestion());
        toast("Soal ditambahkan");
        await refreshEditor();
      } catch (e) { toast(e.message, true); return; }
    }
    resetQForm();
  }
  $("qEditorCard").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => $("qPrompt").focus(), 350);
});
$("tbPreview").addEventListener("click", () => window.open("/f/" + state.form.slug, "_blank"));
$("btnCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("fLink").textContent);
    toast("Link tersalin");
  } catch {
    toast("Gagal menyalin — salin manual dari teks", true);
  }
});

initQTypeSelect();
$("qType").addEventListener("change", renderQFields);
$("sMin").addEventListener("input", renderCorrect);
$("sMax").addEventListener("input", renderCorrect);

refresh();
