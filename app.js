"use strict";

/* ---------------------------------------------------------------------
 * Fréquences testées
 * Standard : celles d'un audiogramme classique (125 Hz - 8000 Hz)
 * Étendues (EHF) : au-delà de 8000 Hz, jusqu'à 16 000 Hz
 * ------------------------------------------------------------------- */
const STANDARD_FREQS = [125, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000];
const EXTENDED_FREQS = [9000, 10000, 11200, 12500, 14000, 16000];
const ALL_TEMPLATE_FREQS = [...STANDARD_FREQS, ...EXTENDED_FREQS];
const EHF_CUTOFF = 8000;

const HL_MIN = -10;
const HL_MAX = 100;
const NO_RESPONSE_HL = 95;

const EAR_LABELS = { droite: "Oreille droite", gauche: "Oreille gauche" };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function earColor(ear) {
  return ear === "droite" ? cssVar("--right-ear") : cssVar("--left-ear");
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* ---------------------------------------------------------------------
 * Audio engine
 *
 * Important : un navigateur ne peut PAS piloter le volume système/media
 * du telephone (restriction de securite identique sur tous les
 * navigateurs mobiles). Tout est donc exprime en dBFS = un niveau
 * numerique relatif au volume que l'utilisateur a regle lui-meme lors
 * de la calibration, jamais une vraie pression acoustique (dB SPL/HL).
 * ------------------------------------------------------------------- */
let audioCtx = null;
let oscillator = null;
let gainNode = null;
let pannerNode = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  return audioCtx;
}

function dbfsToGain(dbfs) {
  return Math.pow(10, dbfs / 20);
}
function dbfsToHL(dbfs) {
  return Math.round(clamp(dbfs + 70, 0, 90));
}

function startContinuousTone(freq, ear, dbfs) {
  stopTone();
  const ctx = ensureAudioContext();

  oscillator = ctx.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = freq;

  gainNode = ctx.createGain();
  gainNode.gain.value = dbfsToGain(dbfs);

  pannerNode = ctx.createStereoPanner();
  pannerNode.pan.value = ear === "droite" ? 1 : ear === "gauche" ? -1 : 0;

  oscillator.connect(gainNode).connect(pannerNode).connect(ctx.destination);
  oscillator.start();
}

function stopTone() {
  if (oscillator) {
    try { oscillator.stop(); } catch (e) { /* already stopped */ }
    oscillator.disconnect();
    oscillator = null;
  }
  if (gainNode) { gainNode.disconnect(); gainNode = null; }
  if (pannerNode) { pannerNode.disconnect(); pannerNode = null; }
}

// Un "bip" court avec un fondu entree/sortie (evite les clics), pour la
// methode de test par triplets de bips.
function playSingleBeep(freq, ear, dbfs) {
  const ctx = ensureAudioContext();
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const g = ctx.createGain();
  const p = ctx.createStereoPanner();
  p.pan.value = ear === "droite" ? 1 : ear === "gauche" ? -1 : 0;
  osc.connect(g).connect(p).connect(ctx.destination);

  const t0 = ctx.currentTime;
  const dur = BEEP_DURATION_MS / 1000;
  const fade = BEEP_FADE_MS / 1000;
  const gain = dbfsToGain(dbfs);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + fade);
  g.gain.setValueAtTime(gain, t0 + dur - fade);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/* ---------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------- */
const state = {
  ears: ["droite", "gauche"],
  earIndex: 0,
  freqIndex: 0,
  freqList: [],
  results: { droite: {}, gauche: {} },
};

function formatFreq(f) {
  return f >= 1000 ? (f % 1000 === 0 ? f / 1000 : (f / 1000).toFixed(1)) + " kHz" : f + " Hz";
}

/* ---------------------------------------------------------------------
 * DOM refs
 * ------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const calibPlayBtn = $("calibPlayBtn");
const includeStandard = $("includeStandard");
const includeExtended = $("includeExtended");
const startTestBtn = $("startTestBtn");

const setupPanel = $("setup");
const testPanel = $("testArea");
const resultsPanel = $("results");

const progressFill = $("progressFill");
const progressText = $("progressText");
const currentEarLabel = $("currentEarLabel");
const roundStatusEl = $("roundStatus");
const tapButton = $("tapButton");
const tapCounterEl = $("tapCounter");
const skipBtn = $("skipBtn");
const abortBtn = $("abortBtn");

const audiogramContainer = $("audiogramContainer");
const exportPngBtn = $("exportPngBtn");
const exportCsvBtn = $("exportCsvBtn");
const printBtn = $("printBtn");
const restartBtn = $("restartBtn");
const resultsTable = $("resultsTable");

/* ---------------------------------------------------------------------
 * Calibration
 * ------------------------------------------------------------------- */
const CALIBRATION_DBFS = -5; // proche du volume numerique maximal, confortable une fois le volume systeme regle

let calibPlaying = false;
calibPlayBtn.addEventListener("click", () => {
  if (calibPlaying) {
    stopTone();
    calibPlaying = false;
    calibPlayBtn.textContent = "▶ Jouer le son de calibration (1000 Hz)";
  } else {
    startContinuousTone(1000, "centre", CALIBRATION_DBFS);
    calibPlaying = true;
    calibPlayBtn.textContent = "■ Arrêter le son de calibration";
  }
});

/* ---------------------------------------------------------------------
 * Test flow — triplets de bips avec recherche automatique de seuil
 * (méthode adaptative "staircase", proche de ce que fait Apple dans
 * ses réglages d'accessibilité audio : on tape à chaque bip perçu, le
 * niveau se resserre automatiquement autour du seuil d'audibilité).
 * ------------------------------------------------------------------- */
const START_DBFS_STANDARD = -24;
const START_DBFS_EHF = -12;
const STEP_COARSE_DB = 10;
const STEP_FINE_DB = 4;
const REVERSALS_TARGET = 3;
const MAX_ROUNDS = 8;
const DBFS_MIN = -70;
const DBFS_MAX = 0;

const BEEP_DURATION_MS = 380;
const BEEP_FADE_MS = 15;
const GAP_MIN_MS = 700;
const GAP_MAX_MS = 1100;
const LEAD_IN_MS = 300;
const GRACE_AFTER_MS = 900;
const TAP_DEBOUNCE_MS = 280;
const HEARD_THRESHOLD = 2; // sur 3 bips
const SKIP_SENTINEL = -1;

let testAborted = false;
let activeSkipHandler = null;

function buildFreqList() {
  const list = [];
  if (includeStandard.checked) list.push(...STANDARD_FREQS);
  if (includeExtended.checked) list.push(...EXTENDED_FREQS);
  return list;
}

startTestBtn.addEventListener("click", () => {
  if (calibPlaying) { stopTone(); calibPlaying = false; calibPlayBtn.textContent = "▶ Jouer le son de calibration (1000 Hz)"; }

  const freqList = buildFreqList();
  if (freqList.length === 0) {
    alert("Sélectionnez au moins une plage de fréquences avant de commencer.");
    return;
  }

  state.freqList = freqList;
  state.earIndex = 0;
  state.freqIndex = 0;
  state.results = { droite: {}, gauche: {} };

  setupPanel.classList.add("hidden");
  resultsPanel.classList.add("hidden");
  testPanel.classList.remove("hidden");

  runTest();
});

function totalSteps() {
  return state.freqList.length * state.ears.length;
}
function currentStepIndex() {
  return state.earIndex * state.freqList.length + state.freqIndex;
}
function updateProgress() {
  const total = totalSteps();
  const done = currentStepIndex();
  progressFill.style.width = total ? `${(done / total) * 100}%` : "0%";
  progressText.textContent = `${done} / ${total}`;
}

// Joue un triplet de bips à intervalles aléatoires et compte les taps
// reçus sur le bouton pendant la fenêtre de réponse. Le bouton "Passer"
// peut interrompre immédiatement la manche via activeSkipHandler.
function runBeepRound(freq, ear, levelDbfs) {
  return new Promise((resolve) => {
    let tapCount = 0;
    let lastTapTime = -Infinity;
    let listening = true;
    const timeouts = [];

    function onTap() {
      if (!listening) return;
      const now = performance.now();
      if (now - lastTapTime < TAP_DEBOUNCE_MS) return;
      lastTapTime = now;
      tapCount = Math.min(3, tapCount + 1);
      tapCounterEl.textContent = `👆 ${tapCount} bip${tapCount > 1 ? "s" : ""} détecté${tapCount > 1 ? "s" : ""}`;
    }

    function finish(result) {
      if (!listening) return;
      listening = false;
      tapButton.removeEventListener("click", onTap);
      timeouts.forEach(clearTimeout);
      activeSkipHandler = null;
      resolve(result);
    }

    activeSkipHandler = () => finish(SKIP_SENTINEL);
    tapButton.addEventListener("click", onTap);
    tapCounterEl.textContent = "";
    roundStatusEl.textContent = "Écoutez attentivement…";

    let t = LEAD_IN_MS;
    for (let i = 0; i < 3; i++) {
      timeouts.push(setTimeout(() => {
        if (listening) playSingleBeep(freq, ear, levelDbfs);
      }, t));
      t += BEEP_DURATION_MS + (GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
    }
    timeouts.push(setTimeout(() => {
      roundStatusEl.textContent = "";
      finish(tapCount);
    }, t + GRACE_AFTER_MS));
  });
}

// Recherche adaptative du seuil pour une fréquence/oreille donnée :
// on descend le niveau tant que le triplet est entendu (≥2/3), on
// remonte sinon, et on resserre le pas après chaque inversion de sens.
async function runStaircaseForFrequency(freq, ear) {
  let level = freq > EHF_CUTOFF ? START_DBFS_EHF : START_DBFS_STANDARD;
  let step = STEP_COARSE_DB;
  let lastDirection = null;
  const reversalLevels = [];
  let round = 0;

  while (true) {
    if (testAborted) return { hl: 0, noResponse: false };

    round++;
    const tapCount = await runBeepRound(freq, ear, level);
    if (testAborted) return { hl: 0, noResponse: false };
    if (tapCount === SKIP_SENTINEL) {
      return { hl: NO_RESPONSE_HL, noResponse: true };
    }

    const heard = tapCount >= HEARD_THRESHOLD;

    if (!heard && level >= DBFS_MAX) {
      return { hl: NO_RESPONSE_HL, noResponse: true };
    }

    const direction = heard ? "down" : "up";
    if (lastDirection && direction !== lastDirection) {
      reversalLevels.push(level);
      if (reversalLevels.length === 1) step = STEP_FINE_DB;
      if (reversalLevels.length >= REVERSALS_TARGET) {
        const last = reversalLevels.slice(-2);
        const avg = last.reduce((a, b) => a + b, 0) / last.length;
        return { hl: dbfsToHL(avg), noResponse: false };
      }
    }
    lastDirection = direction;

    level = clamp(level + (direction === "down" ? -step : step), DBFS_MIN, DBFS_MAX);

    if (round >= MAX_ROUNDS) {
      return { hl: dbfsToHL(level), noResponse: false };
    }
  }
}

async function runTest() {
  testAborted = false;
  for (state.earIndex = 0; state.earIndex < state.ears.length; state.earIndex++) {
    currentEarLabel.textContent = EAR_LABELS[state.ears[state.earIndex]];
    for (state.freqIndex = 0; state.freqIndex < state.freqList.length; state.freqIndex++) {
      if (testAborted) return;
      const ear = state.ears[state.earIndex];
      const freq = state.freqList[state.freqIndex];
      updateProgress();
      roundStatusEl.textContent = "Préparez-vous…";
      const result = await runStaircaseForFrequency(freq, ear);
      if (testAborted) return;
      state.results[ear][freq] = result;
    }
  }
  finishTest();
}

skipBtn.addEventListener("click", () => {
  if (activeSkipHandler) activeSkipHandler();
});

abortBtn.addEventListener("click", () => {
  testAborted = true;
  if (activeSkipHandler) activeSkipHandler();
  stopTone();
  testPanel.classList.add("hidden");
  setupPanel.classList.remove("hidden");
});

function finishTest() {
  stopTone();
  updateProgress();
  testPanel.classList.add("hidden");
  resultsPanel.classList.remove("hidden");
  drawAudiogram();
  renderResultsTable();
}

restartBtn.addEventListener("click", () => {
  resultsPanel.classList.add("hidden");
  setupPanel.classList.remove("hidden");
});

/* ---------------------------------------------------------------------
 * Audiogramme SVG
 * ------------------------------------------------------------------- */
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { width: 820, height: 480, marginLeft: 70, marginRight: 30, marginTop: 40, marginBottom: 70 };

function freqToX(freq) {
  const { marginLeft, width, marginRight } = CHART;
  const plotWidth = width - marginLeft - marginRight;
  const minLog = Math.log2(ALL_TEMPLATE_FREQS[0]);
  const maxLog = Math.log2(ALL_TEMPLATE_FREQS[ALL_TEMPLATE_FREQS.length - 1]);
  const t = (Math.log2(freq) - minLog) / (maxLog - minLog);
  return marginLeft + t * plotWidth;
}

function hlToY(hl) {
  const { marginTop, height, marginBottom } = CHART;
  const plotHeight = height - marginTop - marginBottom;
  const t = (hl - HL_MIN) / (HL_MAX - HL_MIN);
  return marginTop + t * plotHeight;
}

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawAudiogram() {
  const { width, height, marginLeft, marginRight, marginTop, marginBottom } = CHART;
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, xmlns: SVG_NS, "font-family": "IBM Plex Mono, ui-monospace, monospace" });

  const gridColor = cssVar("--chart-grid") || "#1d2a3a";
  const gridStrong = cssVar("--chart-grid-strong") || "#39506b";
  const textDim = cssVar("--text-dim") || "#9db0c4";
  const textColor = cssVar("--text") || "#e7edf5";
  const accent = cssVar("--accent") || "#4fb0ff";
  const zoneTint = cssVar("--zone-tint") || "rgba(79,176,255,0.07)";

  const plotLeft = marginLeft, plotRight = width - marginRight;
  const plotTop = marginTop, plotBottom = height - marginBottom;

  // Zone hautes fréquences étendues (fond teinté)
  svg.appendChild(svgEl("rect", {
    x: freqToX(EHF_CUTOFF), y: plotTop,
    width: plotRight - freqToX(EHF_CUTOFF), height: plotBottom - plotTop,
    fill: zoneTint
  }));
  svg.appendChild(svgEl("line", {
    x1: freqToX(EHF_CUTOFF), y1: plotTop, x2: freqToX(EHF_CUTOFF), y2: plotBottom,
    stroke: accent, "stroke-width": 1, "stroke-dasharray": "4,4"
  }));
  const ehfLabel = svgEl("text", {
    x: freqToX(EHF_CUTOFF) + 6, y: plotTop + 14, fill: accent, "font-size": 11
  }, "Hautes fréquences étendues >");
  svg.appendChild(ehfLabel);

  // Grille horizontale (dB) + labels
  for (let hl = HL_MIN; hl <= HL_MAX; hl += 10) {
    const y = hlToY(hl);
    svg.appendChild(svgEl("line", {
      x1: plotLeft, y1: y, x2: plotRight, y2: y,
      stroke: hl === 0 ? gridStrong : gridColor, "stroke-width": hl === 0 ? 1.5 : 1
    }));
    svg.appendChild(svgEl("text", {
      x: plotLeft - 10, y: y + 4, fill: textDim, "font-size": 11, "text-anchor": "end"
    }, String(hl)));
  }
  svg.appendChild(svgEl("text", {
    x: 16, y: (plotTop + plotBottom) / 2, fill: textColor, "font-size": 12,
    transform: `rotate(-90 16 ${(plotTop + plotBottom) / 2})`, "text-anchor": "middle"
  }, "Seuil indicatif (dB, non calibré)"));

  // Grille verticale (fréquences) + labels
  ALL_TEMPLATE_FREQS.forEach((f) => {
    const x = freqToX(f);
    svg.appendChild(svgEl("line", {
      x1: x, y1: plotTop, x2: x, y2: plotBottom, stroke: gridColor, "stroke-width": 1
    }));
    const label = svgEl("text", {
      x: x, y: plotBottom + 18, fill: textDim, "font-size": 10, "text-anchor": "middle",
      transform: `rotate(45 ${x} ${plotBottom + 18})`
    }, formatFreq(f));
    svg.appendChild(label);
  });

  // Cadre
  svg.appendChild(svgEl("rect", {
    x: plotLeft, y: plotTop, width: plotRight - plotLeft, height: plotBottom - plotTop,
    fill: "none", stroke: gridStrong, "stroke-width": 1
  }));

  // Tracés par oreille
  state.ears.forEach((ear) => {
    const color = earColor(ear);
    const testedFreqs = ALL_TEMPLATE_FREQS.filter((f) => state.results[ear][f] !== undefined);

    // lignes reliant les points valides (segments coupés aux "aucune réponse")
    let pathPoints = [];
    const flushPath = () => {
      if (pathPoints.length > 1) {
        const d = pathPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
        svg.appendChild(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2 }));
      }
      pathPoints = [];
    };

    testedFreqs.forEach((f) => {
      const r = state.results[ear][f];
      const x = freqToX(f), y = hlToY(r.hl);
      if (r.noResponse) {
        flushPath();
        // flèche vers le bas = pas de réponse même au max
        const arrow = svgEl("path", {
          d: `M ${x - 6} ${y - 8} L ${x + 6} ${y - 8} L ${x} ${y + 6} Z`,
          fill: color, opacity: 0.9
        });
        svg.appendChild(arrow);
      } else {
        pathPoints.push({ x, y });
        if (ear === "droite") {
          svg.appendChild(svgEl("circle", { cx: x, cy: y, r: 6, fill: "none", stroke: color, "stroke-width": 2 }));
        } else {
          const s = 5;
          svg.appendChild(svgEl("line", { x1: x - s, y1: y - s, x2: x + s, y2: y + s, stroke: color, "stroke-width": 2 }));
          svg.appendChild(svgEl("line", { x1: x - s, y1: y + s, x2: x + s, y2: y - s, stroke: color, "stroke-width": 2 }));
        }
      }
    });
    flushPath();
  });

  audiogramContainer.innerHTML = "";
  audiogramContainer.appendChild(svg);
}

/* ---------------------------------------------------------------------
 * Table de résultats
 * ------------------------------------------------------------------- */
function renderResultsTable() {
  const testedFreqs = ALL_TEMPLATE_FREQS.filter(
    (f) => state.results.droite[f] !== undefined || state.results.gauche[f] !== undefined
  );

  let html = "<tr><th>Fréquence</th><th>Oreille droite</th><th>Oreille gauche</th></tr>";
  testedFreqs.forEach((f) => {
    const cls = f > EHF_CUTOFF ? ' class="ehf"' : "";
    const rd = state.results.droite[f];
    const gd = state.results.gauche[f];
    const fmt = (r) => (r === undefined ? "—" : r.noResponse ? "Aucune réponse" : `${r.hl} dB`);
    html += `<tr><td${cls}>${formatFreq(f)}</td><td${cls}>${fmt(rd)}</td><td${cls}>${fmt(gd)}</td></tr>`;
  });
  resultsTable.innerHTML = html;
}

/* ---------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportPngBtn.addEventListener("click", () => {
  const svg = audiogramContainer.querySelector("svg");
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = CHART.width * scale;
    canvas.height = CHART.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = cssVar("--surface-2") || "#0b1119";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => downloadBlob(blob, "audiogramme.png"));
  };
  img.src = url;
});

exportCsvBtn.addEventListener("click", () => {
  const rows = [["Fréquence (Hz)", "Oreille", "Seuil indicatif (dB)", "Aucune réponse"]];
  ALL_TEMPLATE_FREQS.forEach((f) => {
    state.ears.forEach((ear) => {
      const r = state.results[ear][f];
      if (r !== undefined) {
        rows.push([f, EAR_LABELS[ear], r.hl, r.noResponse ? "oui" : "non"]);
      }
    });
  });
  const csv = rows.map((r) => r.join(";")).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "audiogramme.csv");
});

printBtn.addEventListener("click", () => window.print());
