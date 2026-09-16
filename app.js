"use strict";

/* ---------------------------------------------------------------------
 * Fréquences testées
 * Standard : celles d'un audiogramme classique (125 Hz - 8000 Hz)
 * Étendues (EHF) : au-delà de 8000 Hz, par paliers de 500 Hz jusqu'à 14 000 Hz
 * ------------------------------------------------------------------- */
const STANDARD_FREQS = [125, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000];
const EXTENDED_FREQS = [8500, 9000, 9500, 10000, 10500, 11000, 11500, 12000, 12500, 13000, 13500, 14000];
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

/* ---------------------------------------------------------------------
 * Audio engine
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

function sliderToGain(val) {
  // val: 0-100 -> dBFS from -70 (quasi silencieux) to 0 (plein volume)
  const dbfs = -70 + (val / 100) * 70;
  return Math.pow(10, dbfs / 20);
}

function sliderToHL(val) {
  // Mappe linéairement le curseur (0-100) vers une échelle "HL" indicative (0-70)
  return Math.round(val * 0.7);
}

function startTone(freq, ear, sliderVal) {
  stopTone();
  const ctx = ensureAudioContext();

  oscillator = ctx.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = freq;

  gainNode = ctx.createGain();
  gainNode.gain.value = sliderToGain(sliderVal);

  pannerNode = ctx.createStereoPanner();
  pannerNode.pan.value = ear === "droite" ? 1 : ear === "gauche" ? -1 : 0;

  oscillator.connect(gainNode).connect(pannerNode).connect(ctx.destination);
  oscillator.start();
}

function updateToneGain(val) {
  if (gainNode && audioCtx) {
    gainNode.gain.setTargetAtTime(sliderToGain(val), audioCtx.currentTime, 0.01);
  }
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
const currentFreqLabel = $("currentFreqLabel");
const volSlider = $("volSlider");
const validateBtn = $("validateBtn");
const noResponseBtn = $("noResponseBtn");
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
let calibPlaying = false;
calibPlayBtn.addEventListener("click", () => {
  if (calibPlaying) {
    stopTone();
    calibPlaying = false;
    calibPlayBtn.textContent = "▶ Jouer le son de calibration (1000 Hz)";
  } else {
    startTone(1000, "centre", 78.5); // ~0dBFS-ish comfortable reference (slider 78.5 -> ~ -4.5dBFS)
    calibPlaying = true;
    calibPlayBtn.textContent = "■ Arrêter le son de calibration";
  }
});

/* ---------------------------------------------------------------------
 * Test flow
 * ------------------------------------------------------------------- */
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

  loadCurrentStep();
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

function loadCurrentStep() {
  const ear = state.ears[state.earIndex];
  const freq = state.freqList[state.freqIndex];

  volSlider.value = 0;
  currentEarLabel.textContent = EAR_LABELS[ear];
  currentFreqLabel.textContent = formatFreq(freq);
  currentFreqLabel.classList.toggle("ehf", freq > EHF_CUTOFF);
  updateProgress();

  startTone(freq, ear, 0);
}

volSlider.addEventListener("input", () => updateToneGain(volSlider.value));

validateBtn.addEventListener("click", () => {
  const ear = state.ears[state.earIndex];
  const freq = state.freqList[state.freqIndex];
  state.results[ear][freq] = { hl: sliderToHL(volSlider.value), noResponse: false };
  advanceStep();
});

noResponseBtn.addEventListener("click", () => {
  const ear = state.ears[state.earIndex];
  const freq = state.freqList[state.freqIndex];
  state.results[ear][freq] = { hl: NO_RESPONSE_HL, noResponse: true };
  advanceStep();
});

abortBtn.addEventListener("click", () => {
  stopTone();
  testPanel.classList.add("hidden");
  setupPanel.classList.remove("hidden");
});

function advanceStep() {
  state.freqIndex++;
  if (state.freqIndex >= state.freqList.length) {
    state.freqIndex = 0;
    state.earIndex++;
    if (state.earIndex >= state.ears.length) {
      finishTest();
      return;
    }
  }
  loadCurrentStep();
}

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
