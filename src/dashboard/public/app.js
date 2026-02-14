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
  const lastActionType = s.lastAction?.type ?? "—";
  const lastActionReason = s.lastAction?.reason ? escapeHtml(s.lastAction.reason) : "";
  const lastActionAge = formatAge(s.lastAction?.at);
  const level = s.level ?? "—";
  const best = s.bestLevel ?? "—";
  const runs = formatRuns(s);
  const strk = s.strk?.value ?? (s.address ? "…" : "—");
  const adv = s.adventurerId ?? "—";
  const lastSeen = formatAge(s.lastSeen);
  const addr = s.address && s.address !== "controller" ? s.address : "";
  const hpPct = typeof s.coach?.hpPct === "number" && Number.isFinite(s.coach.hpPct) ? Math.round(s.coach.hpPct * 100) : null;
  const gold = typeof s.coach?.gold === "number" && Number.isFinite(s.coach.gold) ? s.coach.gold : null;
  const actionCount = typeof s.coach?.actionCount === "number" && Number.isFinite(s.coach.actionCount) ? s.coach.actionCount : null;
  const coachLine = hpPct != null || gold != null || actionCount != null
    ? `HP ${hpPct ?? "?"}% · Gold ${gold ?? "?"} · AC ${actionCount ?? "?"}`
    : "";

  return `
    <tr>
      <td data-label="Session">
        <div class="session">${escapeHtml(display)}</div>
        <div class="muted">${escapeHtml(s.configFile)}${addr ? ` · ${escapeHtml(addr)}` : ""}</div>
        ${coachLine ? `<div class="muted">${escapeHtml(coachLine)}</div>` : ""}
      </td>
      <td data-label="Status">
        <span class="pill status ${statusTone}" title="${statusTitle}">${escapeHtml(statusLabel)}</span>
      </td>
      <td data-label="Last Action">
        <div class="session">${escapeHtml(lastActionType)}</div>
        <div class="muted" title="${lastActionReason}">${escapeHtml(lastActionAge)}</div>
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

  const statusRank = {
    active: 0,
    short_break: 1,
    idle: 2,
    sleep_break: 3,
    stalled: 4,
    unknown: 5,
  };

  function levelValue(s) {
    return typeof s?.level === "number" && Number.isFinite(s.level) ? s.level : -1;
  }

  function bestLevelValue(s) {
    if (typeof s?.bestLevel === "number" && Number.isFinite(s.bestLevel)) return s.bestLevel;
    return levelValue(s);
  }

  function seenMs(s) {
    if (!s?.lastSeen) return 0;
    const ms = Date.parse(s.lastSeen);
    return Number.isFinite(ms) ? ms : 0;
  }

  sessions.sort((a, b) => {
    // Primary sort: highest current level first.
    const dl = levelValue(b) - levelValue(a);
    if (dl) return dl;

    // Tie-break: best seen level.
    const db = bestLevelValue(b) - bestLevelValue(a);
    if (db) return db;

    // Tie-break: show more active sessions first.
    const ak = a?.status?.kind || "unknown";
    const bk = b?.status?.kind || "unknown";
    const ar = statusRank[ak] ?? statusRank.unknown;
    const br = statusRank[bk] ?? statusRank.unknown;
    if (ar !== br) return ar - br;

    // Tie-break: last seen (most recent first).
    const ds = seenMs(b) - seenMs(a);
    if (ds) return ds;

    // Stable final tie-break: name.
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
