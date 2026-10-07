/* GezyForm — halaman hasil (Tahap 4): ringkasan + respons + ekspor */
const R = { formId: null, form: null, page: 1, limit: 15, tab: "summary" };

async function openResults(id) {
  const { form } = await api(`/api/forms/${id}`);
  R.formId = id;
  R.form = form;
  R.page = 1;
  R.tab = "summary";
  $("resTitle").textContent = "Hasil: " + form.title;
  $("resCount").textContent = `${form.response_count} respons · ${form.question_count} soal`;
  $("btnCsv").href = `/api/forms/${id}/export.csv`;
  $("btnWord").href = `/api/forms/${id}/export/word`;
  $("respDetail").innerHTML = "";
  await renderResultsTab();
  show("resultsView");
  window.scrollTo(0, 0);
}

function setTab(t) {
  R.tab = t;
  $("tabSummary").classList.toggle("active", t === "summary");
  $("tabResponses").classList.toggle("active", t === "responses");
  renderResultsTab();
}

async function renderResultsTab() {
  try {
    if (R.tab === "summary") {
      const j = await api(`/api/forms/${R.formId}/summary`);
      renderSummary(j);
    } else {
      const j = await api(`/api/forms/${R.formId}/responses?page=${R.page}&limit=${R.limit}`);
      renderResponses(j);
    }
    $("resSummary").hidden = R.tab !== "summary";
    $("resResponses").hidden = R.tab !== "responses";
  } catch (e) {
    toast(e.message, true);
  }
}

function barRow(label, count, pct) {
  return `<div class="bar-row">
    <span class="bar-label">${esc(label)}</span>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <span class="bar-num">${count}</span>
  </div>`;
}

function renderSummary(j) {
  const box = $("resSummary");
  if (!j.total_responses) {
    box.innerHTML = `<div class="card"><p class="muted">Belum ada respons masuk. Bagikan link formulir ke responden.</p></div>`;
    return;
  }
  let html = "";
  if (j.score_stats) {
    const s = j.score_stats;
    html += `<div class="card"><h3>📊 Statistik nilai</h3>
      <div class="badges">
        <span class="badge">Rata-rata: ${s.avg}</span>
        <span class="badge">Tertinggi: ${s.max}</span>
        <span class="badge">Terendah: ${s.min}</span>
        <span class="badge">Total poin: ${s.total_points}</span>
        <span class="badge">${s.count} dinilai</span>
      </div></div>`;
  }
  box.innerHTML = html + j.questions
    .map((q, i) => {
      let body = "";
      if (q.kind === "choice") {
        body = q.options.map((o) => barRow(o.option, o.count, o.pct)).join("");
      } else if (q.kind === "scale") {
        body = `<p class="muted">Rata-rata: <strong>${q.avg}</strong> (skala ${q.min}–${q.max})</p>` +
          q.dist.map((d) => barRow(String(d.value), d.count, q.answered ? Math.round((d.count / q.answered) * 100) : 0)).join("");
      } else {
        body = `<p class="muted">${q.count} jawaban teks</p>` +
          (q.samples.length
            ? `<div class="samples">${q.samples.map((s) => `<div class="sample">${esc(s)}</div>`).join("")}</div>`
            : `<p class="muted small">—</p>`);
      }
      const quiz = q.quiz
        ? `<p class="quizline">✅ Kunci: ${q.quiz.correct} benar dari ${q.answered} (${q.quiz.accuracy_pct}%)</p>`
        : "";
      return `<div class="card">
        <h3>${i + 1}. ${esc(q.prompt)}</h3>
        <div class="badges"><span class="badge">${QLABEL[q.qtype] || q.qtype}</span>
        <span class="badge">${q.answered}/${j.total_responses} menjawab</span></div>
        ${quiz}${body}
      </div>`;
    })
    .join("");
}

function renderResponses(j) {
  const isQuiz = R.form.settings.is_quiz;
  const rows = j.responses
    .map(
      (r) => `<tr>
        <td>${esc(r.respondent_name || "—")}</td>
        <td>${esc(r.respondent_class || "—")}</td>
        <td class="small">${esc(r.submitted_at)}</td>
        ${isQuiz ? `<td><strong>${r.score ?? "—"}</strong> <button class="btn small ghost" data-s="${r.id}" data-v="${r.score ?? 0}" title="Koreksi skor manual">ubah</button></td>` : ""}
        <td class="nowrap">
          <button class="btn small ghost" data-v="${r.id}">Lihat</button>
          <button class="btn small ghost" data-d="${r.id}" data-n="${esc(r.respondent_name || "tanpa nama")}">Hapus</button>
        </td>
      </tr>`
    )
    .join("");
  $("respTable").innerHTML = j.total
    ? `<table class="rtable"><thead><tr><th>Nama</th><th>Kelas</th><th>Waktu</th>${isQuiz ? "<th>Skor</th>" : ""}<th>Aksi</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">Belum ada respons.</p>`;
  $("respTable").querySelectorAll("[data-v]").forEach((b) =>
    b.addEventListener("click", () => viewResponse(Number(b.dataset.v)))
  );
  $("respTable").querySelectorAll("[data-d]").forEach((b) =>
    b.addEventListener("click", () => delResponse(Number(b.dataset.d), b.dataset.n))
  );
  $("respTable").querySelectorAll("[data-s]").forEach((b) =>
    b.addEventListener("click", () => editScore(Number(b.dataset.s), Number(b.dataset.v)))
  );
  const pager = $("respPager");
  pager.innerHTML =
    j.pages > 1
      ? `<button class="btn small ghost" id="pgPrev" ${j.page <= 1 ? "disabled" : ""}>← Sebelumnya</button>
         <span class="muted small">Halaman ${j.page} dari ${j.pages} (${j.total} respons)</span>
         <button class="btn small ghost" id="pgNext" ${j.page >= j.pages ? "disabled" : ""}>Berikutnya →</button>`
      : `<span class="muted small">${j.total} respons</span>`;
  const prev = $("pgPrev"), next = $("pgNext");
  if (prev) prev.addEventListener("click", () => { R.page--; renderResultsTab(); });
  if (next) next.addEventListener("click", () => { R.page++; renderResultsTab(); });
}

async function viewResponse(rid) {
  try {
    const { response, answers } = await api(`/api/forms/${R.formId}/responses/${rid}`);
    $("respDetail").innerHTML = `<div class="card">
      <h3>📄 ${esc(response.respondent_name || "Tanpa nama")}${response.respondent_class ? " · " + esc(response.respondent_class) : ""}
      ${R.form.settings.is_quiz ? ` · Skor: <strong>${response.score ?? "—"}</strong>` : ""}</h3>
      <p class="muted small">${esc(response.submitted_at)}</p>
      ${answers.map((a) => `<div class="detail-qa"><div class="muted small">${esc(a.prompt)}</div><div>${esc(fmtVal(a.value)) || "<span class='muted'>—</span>"}</div></div>`).join("")}
      <button class="btn small ghost" id="btnCloseDetail">Tutup</button>
    </div>`;
    $("btnCloseDetail").addEventListener("click", () => ($("respDetail").innerHTML = ""));
    $("respDetail").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    toast(e.message, true);
  }
}

function fmtVal(v) {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? v.join("; ") : String(v);
}

async function editScore(rid, cur) {
  const v = prompt("Skor baru:", String(cur));
  if (v === null) return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) { toast("Skor harus angka >= 0", true); return; }
  try {
    await api(`/api/forms/${R.formId}/responses/${rid}/score`, "PATCH", { score: n });
    toast("Skor diperbarui");
    renderResultsTab();
  } catch (e) {
    toast(e.message, true);
  }
}

async function delResponse(rid, name) {
  if (!confirm(`Hapus respons dari "${name}"?`)) return;
  try {
    await api(`/api/forms/${R.formId}/responses/${rid}`, "DELETE");
    $("respDetail").innerHTML = "";
    toast("Respons dihapus");
    const { form } = await api(`/api/forms/${R.formId}`);
    R.form = form;
    $("resCount").textContent = `${form.response_count} respons · ${form.question_count} soal`;
    renderResultsTab();
  } catch (e) {
    toast(e.message, true);
  }
}

$("btnBack2").addEventListener("click", () => { show("dashView"); loadDashboard(); });
$("tabSummary").addEventListener("click", () => setTab("summary"));
$("tabResponses").addEventListener("click", () => setTab("responses"));
