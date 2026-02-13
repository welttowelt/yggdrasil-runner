/* eslint-disable no-console */

const rowsEl = document.getElementById("rows");
const lastUpdatedEl = document.getElementById("lastUpdated");

function escapeHtml(value) {
  const s = String(value ?? "");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toneClass(tone) {
  if (tone === "good") return "good";
  if (tone === "warn") return "warn";
  if (tone === "sleep") return "sleep";
  if (tone === "bad") return "bad";
  return "muted";
}

function formatAge(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const ageMs = Date.now() - ms;
  if (ageMs < 0) return "—";
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function formatRuns(s) {
  const started = typeof s.runsStarted === "number" ? s.runsStarted : null;
  const ended = typeof s.runsEnded === "number" ? s.runsEnded : null;
  if (started == null && ended == null) return "—";
  if (started != null && ended != null) return `${started}/${ended}`;
  return String(started ?? ended);
}

function renderRow(s) {
  const display = s.username || s.id;
  const statusLabel = s.status?.label || "—";
  const statusTone = toneClass(s.status?.tone);
  const statusTitle = s.notes ? escapeHtml(s.notes) : "";
  const level = s.level ?? "—";
  const best = s.bestLevel ?? "—";
  const runs = formatRuns(s);
  const strk = s.strk?.value ?? (s.address ? "…" : "—");
  const adv = s.adventurerId ?? "—";
  const lastSeen = formatAge(s.lastSeen);
  const addr = s.address && s.address !== "controller" ? s.address : "";

  return `
    <tr>
      <td data-label="Session">
        <div class="session">${escapeHtml(display)}</div>
        <div class="muted">${escapeHtml(s.configFile)}${addr ? ` · ${escapeHtml(addr)}` : ""}</div>
      </td>
      <td data-label="Status">
        <span class="pill status ${statusTone}" title="${statusTitle}">${escapeHtml(statusLabel)}</span>
      </td>
      <td data-label="Level">${escapeHtml(level)}</td>
      <td data-label="Best">${escapeHtml(best)}</td>
      <td data-label="Runs">${escapeHtml(runs)}</td>
      <td data-label="STRK">${escapeHtml(strk)}</td>
      <td data-label="Adventurer">${escapeHtml(adv)}</td>
      <td data-label="Last Seen">${escapeHtml(lastSeen)}</td>
    </tr>
  `.trim();
}

function render(data) {
  const updatedAt = data?.updatedAt;
  if (updatedAt && lastUpdatedEl) {
    const d = new Date(updatedAt);
    lastUpdatedEl.textContent = `Updated ${d.toLocaleString()}`;
  }
  const sessions = Array.isArray(data?.sessions) ? data.sessions.slice() : [];
  sessions.sort((a, b) => {
    const an = (a.username || a.id || "").toLowerCase();
    const bn = (b.username || b.id || "").toLowerCase();
    return an.localeCompare(bn);
  });
  rowsEl.innerHTML = sessions.map(renderRow).join("\n");
}

async function tick() {
  try {
    const res = await fetch("/api/sessions", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (e) {
    console.warn("dashboard poll failed", e);
  }
}

tick();
setInterval(tick, 3000);

