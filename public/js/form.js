/* GezyForm — halaman responden (Tahap 3), gaya Google Forms */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const slug = location.pathname.split("/").filter(Boolean).pop() || "";
let schema = null;

function showError(msg) {
  $("loading").hidden = true;
  $("errorMsg").textContent = msg;
  $("errorView").hidden = false;
  document.title = "Formulir tidak tersedia — GezyForm";
}

function inputFor(q) {
  const req = q.required ? `<span class="req">*</span>` : "";
  const head = `<div class="qprompt">${esc(q.prompt)}${req}</div>`;
  const name = `q_${q.id}`;
  if (q.qtype === "short_text")
    return `${head}<input class="gf-text" data-q="${q.id}" data-t="text" placeholder="Jawaban Anda">`;
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
  if (f.settings.require_name) $("identityCard").hidden = false;
  $("qList").innerHTML = schema.questions
    .map((q) => `<div class="gf-card gf-q" data-card="${q.id}">${inputFor(q)}</div>`)
    .join("");
  $("loading").hidden = true;
  $("formView").hidden = false;
}

function collect() {
  const answers = {};
  let firstInvalid = null;
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
    if (!empty) answers[q.id] = val;
  }
  return { answers, firstInvalid };
}

async function submit() {
  const errBox = $("serverErr");
  errBox.hidden = true;
  const { answers, firstInvalid } = collect();
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
    errBox.textContent = "Masih ada pertanyaan wajib yang belum dijawab (ditandai merah).";
    errBox.hidden = false;
    return;
  }
  const btn = $("btnSubmit");
  btn.disabled = true;
  btn.textContent = "Mengirim…";
  try {
    const r = await fetch(`/api/public/forms/${encodeURIComponent(slug)}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        respondent_name: $("rName") ? $("rName").value : "",
        respondent_class: $("rClass") ? $("rClass").value : "",
        answers,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Gagal mengirim (HTTP ${r.status})`);
    $("formView").hidden = true;
    if (j.score !== undefined) {
      $("scoreBox").hidden = false;
      $("scoreText").textContent = `Nilai: ${j.score} dari ${j.total_points}`;
    }
    $("doneView").hidden = false;
    window.scrollTo(0, 0);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
    errBox.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.disabled = false;
    btn.textContent = "Kirim";
  }
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
