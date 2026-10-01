(() => {
  "use strict";

  const G = window.GhostShared;
  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("startBtn"), stop: $("stopBtn"), ask: $("askBtn"), pip: $("pipBtn"),
    stage: $("stage"), video: $("video"), idle: $("idle"), idleInterval: $("idleInterval"),
    interrupt: $("interrupt"), interruptText: $("interruptText"), dismiss: $("dismissBtn"),
    status: $("status"), dot: $("dot"), countdown: $("countdown"),
    log: $("log"), count: $("count"), empty: $("empty"), copy: $("copyBtn"), clear: $("clearBtn"),
    settings: $("settings"), directFields: $("directFields"), serverNote: $("serverNote"),
  };

  const FIRST_LOOK_MS = 4000;
  const REQUEST_TIMEOUT_MS = 100000; // A little longer than the proxy's own 90s timeout.

  // ---------- Settings ----------
  const SETTINGS_KEY = "ghost.settings";
  const API_KEY_KEY = "ghost.apiKey";
  const DEFAULTS = {
    mode: "proxy",
    endpoint: G.DEFAULT_ENDPOINT,
    model: G.DEFAULT_MODEL,
    apiKey: "",
    rememberKey: false,
    interval: 20,
    skipUnchanged: true,
    sound: true,
    notify: true,
  };

  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, val) { try { window[area].setItem(key, val); } catch {} },
    del(area, key) { try { window[area].removeItem(key); } catch {} },
  };

  const savedRaw = store.get("localStorage", SETTINGS_KEY);
  const hasSavedSettings = savedRaw !== null;
  const settings = { ...DEFAULTS, ...safeParse(savedRaw) };
  settings.apiKey = store.get("localStorage", API_KEY_KEY) || store.get("sessionStorage", API_KEY_KEY) || "";

  function saveSettings() {
    const { apiKey, ...rest } = settings;
    store.set("localStorage", SETTINGS_KEY, JSON.stringify(rest));
    // The key lives only for this tab unless the user opts in to remembering it.
    if (settings.rememberKey && apiKey) {
      store.set("localStorage", API_KEY_KEY, apiKey);
      store.del("sessionStorage", API_KEY_KEY);
    } else {
      store.del("localStorage", API_KEY_KEY);
      if (apiKey) store.set("sessionStorage", API_KEY_KEY, apiKey);
      else store.del("sessionStorage", API_KEY_KEY);
    }
  }

  function bindSettings() {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      const k = input.dataset.setting;
      if (input.type === "checkbox") input.checked = Boolean(settings[k]);
      else if (input.type === "radio") input.checked = settings[k] === input.value;
      else input.value = settings[k];

      input.addEventListener("change", () => {
        if (input.type === "checkbox") settings[k] = input.checked;
        else if (input.type === "number") {
          settings[k] = Math.min(300, Math.max(5, Math.round(Number(input.value) || DEFAULTS[k])));
          input.value = settings[k];
        } else settings[k] = input.value.trim();
        saveSettings();
        syncSettingsUI();
        if (k === "interval" && state.running) scheduleTicks();
      });
    });
    syncSettingsUI();
  }

  function syncSettingsUI() {
    el.directFields.hidden = settings.mode !== "direct";
    el.idleInterval.textContent = settings.interval;
  }

  function setServerNote(text, kind) {
    el.serverNote.textContent = text;
    el.serverNote.className = `server-note ${kind || ""}`;
  }

  async function probeServer() {
    if (location.protocol === "file:") {
      if (!hasSavedSettings) settings.mode = "direct";
      setServerNote("Opened as a file, so there's no proxy. Use Direct, or run `node server.js`.", "warn");
    } else {
      try {
        const r = await fetch("api/health", { cache: "no-store" });
        const d = await r.json();
        if (d.hasKey) setServerNote(`Proxy ready · ${d.model}`, "ok");
        else setServerNote("The proxy is running, but NVIDIA_API_KEY isn't set on the server.", "warn");
      } catch {
        if (!hasSavedSettings) settings.mode = "direct";
        setServerNote("No proxy found at /api. Use Direct, or run `node server.js`.", "warn");
      }
    }
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === settings.mode));
    syncSettingsUI();
  }

  // ---------- State ----------
  const state = {
    stream: null,
    capture: null,
    running: false,
    inFlight: false,
    session: 0,
    history: [],
    lastSig: null,
    nextAt: 0,
    uiTimer: null,
    firstLook: null,
    audio: null,
    pipWin: null,
    baseTitle: document.title,
  };

  // Worker-driven ticks: background tabs throttle main-thread timers much harder than workers.
  const ticker = (() => {
    const src = "let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(1),e.data)}";
    try {
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = () => tick(false);
      return { set: (ms) => w.postMessage(ms), stop: () => w.postMessage(0) };
    } catch {
      let t;
      return {
        set: (ms) => { clearInterval(t); t = setInterval(() => tick(false), ms); },
        stop: () => clearInterval(t),
      };
    }
  })();

  function scheduleTicks() {
    ticker.set(settings.interval * 1000);
    state.nextAt = Date.now() + settings.interval * 1000;
  }

  // ---------- Start / stop ----------
  async function start() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return setStatus("This browser can't share its screen. Use desktop Chrome, Edge or Firefox.", "error");
    }
    if (settings.mode === "direct" && !settings.apiKey) {
      el.settings.open = true;
      return setStatus("Direct mode needs an API key. Add one in Settings.", "error");
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
    } catch (err) {
      return setStatus(err.name === "NotAllowedError" ? "Screen share cancelled." : `Couldn't share the screen: ${err.message}`, "idle");
    }

    unlockAudio();
    if (settings.notify && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const track = stream.getVideoTracks()[0];
    track.addEventListener("ended", () => stop("Screen share ended."));
    state.stream = stream;
    state.capture = "ImageCapture" in window ? new ImageCapture(track) : null;
    state.running = true;
    state.session++;
    state.lastSig = null;

    el.video.srcObject = stream;
    el.video.play().catch(() => {});
    el.stage.classList.add("live");
    el.idle.hidden = true;
    el.start.hidden = true;
    el.stop.hidden = el.ask.hidden = false;

    setStatus("Watching", "watch");
    scheduleTicks();
    state.firstLook = setTimeout(() => tick(false), FIRST_LOOK_MS);
    state.nextAt = Date.now() + FIRST_LOOK_MS;
    state.uiTimer = setInterval(updateCountdown, 500);
  }

  function stop(message) {
    if (!state.running) return;
    state.running = false;
    state.session++; // Any in-flight reply is ignored.
    ticker.stop();
    clearTimeout(state.firstLook);
    clearInterval(state.uiTimer);
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = state.capture = null;

    el.video.srcObject = null;
    el.stage.classList.remove("live");
    el.idle.hidden = false;
    el.start.hidden = false;
    el.stop.hidden = el.ask.hidden = true;
    el.countdown.textContent = "";
    setStatus(typeof message === "string" ? message : "Stopped", "idle");
  }

  function updateCountdown() {
    if (!state.running) return;
    if (state.inFlight) { el.countdown.textContent = ""; return; }
    const s = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
    el.countdown.textContent = `next look in ${s}s`;
  }

  // ---------- The loop ----------
  async function tick(force) {
    if (!state.running || state.inFlight) return;
    if (!force) state.nextAt = Date.now() + settings.interval * 1000;
    const session = state.session;
    state.inFlight = true;
    let frame;

    try {
      frame = await grabFrame();
      const w = frame.videoWidth || frame.width;
      const h = frame.videoHeight || frame.height;
      const sig = signature(frame);

      if (!force && settings.skipUnchanged && state.lastSig && !hasChanged(sig, state.lastSig)) {
        setStatus("Watching · screen unchanged", "watch");
        return;
      }

      setStatus("Looking…", "busy");
      const image = encodeFrame(frame, w, h);
      const raw = await analyze(image, state.history.slice(-G.HISTORY_LIMIT));
      if (session !== state.session) return;
      state.lastSig = sig;

      const question = G.parseReply(raw);
      if (!question) {
        setStatus(`Silent · last look ${clock()}`, "watch");
      } else if (G.isNearDuplicate(question, state.history)) {
        setStatus(`Silent · held back a repeat at ${clock()}`, "watch");
      } else {
        interrupt(question);
        setStatus(`Interrupted at ${clock()}`, "alert");
      }
    } catch (err) {
      if (session === state.session) setStatus(describeError(err), "error");
    } finally {
      if (frame && typeof frame.close === "function") frame.close();
      state.inFlight = false;
    }
  }

  async function grabFrame() {
    // ImageCapture keeps working when this tab is in the background; the <video> may not repaint there.
    if (state.capture) {
      try { return await state.capture.grabFrame(); } catch {}
    }
    if (!el.video.videoWidth) throw new Error("No frame yet. Will retry next round.");
    return el.video;
  }

  const encodeCanvas = document.createElement("canvas");
  const encodeCtx = encodeCanvas.getContext("2d");

  // Largest, sharpest JPEG that fits the inline-image budget.
  function encodeFrame(src, w, h) {
    let url = "";
    for (const maxDim of [1280, 1024, 800, 640]) {
      const scale = Math.min(1, maxDim / Math.max(w, h));
      encodeCanvas.width = Math.round(w * scale);
      encodeCanvas.height = Math.round(h * scale);
      encodeCtx.drawImage(src, 0, 0, encodeCanvas.width, encodeCanvas.height);
      for (const q of [0.72, 0.55, 0.4]) {
        url = encodeCanvas.toDataURL("image/jpeg", q);
        if (url.length <= G.MAX_IMAGE_CHARS) return url;
      }
    }
    return url;
  }

  // Tiny grayscale thumbnail used to skip model calls when nothing on screen changed.
  const SIG_W = 64, SIG_H = 36;
  const sigCanvas = Object.assign(document.createElement("canvas"), { width: SIG_W, height: SIG_H });
  const sigCtx = sigCanvas.getContext("2d", { willReadFrequently: true });

  function signature(src) {
    sigCtx.drawImage(src, 0, 0, SIG_W, SIG_H);
    const d = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data;
    const out = new Uint8Array(SIG_W * SIG_H);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return out;
  }

  // A blinking cursor touches one or two cells; real edits touch more.
  function hasChanged(a, b) {
    let cells = 0;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 6 && ++cells >= 3) return true;
    }
    return false;
  }

  async function analyze(image, history) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (settings.mode === "proxy") {
        const r = await fetch("api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image, history }),
          signal: ctrl.signal,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Proxy error ${r.status}`);
        return d.text || "";
      }

      let r;
      try {
        r = await fetch(settings.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(G.buildRequest(settings.model, history, image)),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (err.name === "AbortError") throw err;
        throw new Error("The browser couldn't reach the API (usually CORS). Switch to Proxy and run `node server.js`.");
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`API error ${r.status}: ${d?.error?.message || d?.detail || r.statusText}`);
      return d?.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }

  function describeError(err) {
    if (err.name === "AbortError") return "Model took too long. Will try again next round.";
    return err.message || String(err);
  }

  // ---------- The interruption ----------
  function interrupt(question) {
    state.history.push(question);
    addLogEntry(question);
    showCard(el.interrupt, el.interruptText, question);
    if (state.pipWin) {
      const doc = state.pipWin.document;
      doc.querySelector(".pip-idle").hidden = true;
      showCard(doc.querySelector(".interrupt"), doc.querySelector(".interrupt-text"), question);
    }
    if (settings.sound) chime();
    if (document.hidden) {
      document.title = `👻 ${question}`;
      if (!state.pipWin && settings.notify && "Notification" in window && Notification.permission === "granted") {
        const n = new Notification("Ghost Reviewer", { body: question, tag: "ghost-reviewer", renotify: true, requireInteraction: true });
        n.onclick = () => { window.focus(); n.close(); };
      }
    }
  }

  function showCard(card, textEl, question) {
    textEl.textContent = question;
    card.hidden = false;
    card.classList.remove("enter");
    void card.offsetWidth; // Restart the entrance animation.
    card.classList.add("enter");
  }

  function dismiss() {
    el.interrupt.hidden = true;
    if (state.pipWin) {
      const doc = state.pipWin.document;
      doc.querySelector(".interrupt").hidden = true;
      doc.querySelector(".pip-idle").hidden = false;
    }
    if (state.running) setStatus("Watching", "watch");
  }

  function addLogEntry(question) {
    const li = document.createElement("li");
    li.className = "fresh";
    const time = document.createElement("time");
    time.textContent = clock();
    const text = document.createElement("span");
    text.textContent = question;
    li.append(time, text);
    el.log.prepend(li);
    renderLogMeta();
  }

  function renderLogMeta() {
    const n = state.history.length;
    el.count.textContent = n;
    el.empty.hidden = n > 0;
    el.copy.disabled = el.clear.disabled = n === 0;
  }

  // ---------- Status ----------
  function setStatus(text, kind) {
    el.status.textContent = text;
    el.dot.dataset.kind = kind;
    if (state.pipWin) {
      const doc = state.pipWin.document;
      doc.querySelector(".pip-status-text").textContent = text;
      doc.querySelector(".dot").dataset.kind = kind;
    }
  }

  // ---------- Sound ----------
  function unlockAudio() {
    try {
      state.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      state.audio.resume();
    } catch {}
  }

  function chime() {
    const ctx = state.audio;
    if (!ctx) return;
    const t = ctx.currentTime;
    [[740, 0], [494, 0.13]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t + delay);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.72, t + delay + 0.4);
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.5);
    });
  }

  // ---------- Float on top (Document Picture-in-Picture) ----------
  async function togglePip() {
    if (state.pipWin) { state.pipWin.close(); return; }
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: 460, height: 230 });
    } catch (err) {
      return setStatus(`Couldn't open a floating window: ${err.message}`, "error");
    }
    const link = win.document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("styles.css", location.href).href;
    win.document.head.append(link);
    win.document.title = "Ghost Reviewer";
    win.document.body.className = "pip";
    win.document.body.innerHTML = `
      <div class="pip-status"><span class="dot"></span><span class="pip-status-text"></span></div>
      <p class="pip-idle">Silent. Keep working.</p>
      <div class="interrupt" role="alertdialog" aria-live="assertive" hidden>
        <div class="interrupt-label">👻 Ghost Reviewer</div>
        <p class="interrupt-text"></p>
        <button class="btn ghost small">Noted</button>
      </div>`;
    win.document.querySelector("button").addEventListener("click", dismiss);
    win.document.addEventListener("keydown", onKey);
    win.addEventListener("pagehide", () => {
      state.pipWin = null;
      el.pip.textContent = "Float on top";
    });

    state.pipWin = win;
    el.pip.textContent = "Close float";
    setStatus(el.status.textContent, el.dot.dataset.kind);
    if (!el.interrupt.hidden) {
      win.document.querySelector(".pip-idle").hidden = true;
      showCard(win.document.querySelector(".interrupt"), win.document.querySelector(".interrupt-text"), el.interruptText.textContent);
    }
  }

  // ---------- Helpers ----------
  function clock() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function safeParse(s) {
    try { return JSON.parse(s) || {}; } catch { return {}; }
  }

  function onKey(e) {
    if (e.key === "Escape") dismiss();
  }

  // ---------- Wire up ----------
  el.start.addEventListener("click", start);
  el.stop.addEventListener("click", () => stop());
  el.ask.addEventListener("click", () => tick(true));
  el.dismiss.addEventListener("click", dismiss);
  el.pip.addEventListener("click", togglePip);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) document.title = state.baseTitle;
  });

  el.copy.addEventListener("click", async () => {
    const text = state.history.map((q, i) => `${i + 1}. ${q}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      el.copy.textContent = "Copied";
      setTimeout(() => (el.copy.textContent = "Copy"), 1500);
    } catch {
      setStatus("Couldn't copy to the clipboard.", "error");
    }
  });;;

  el.clear.addEventListener("click", () => {
    if (!confirm("Clear all asked questions? Ghost Reviewer may ask them again.")) return;
    state.history = [];
    el.log.replaceChildren();
    renderLogMeta();
  });

  if ("documentPictureInPicture" in window) el.pip.hidden = false;

  bindSettings();
  renderLogMeta();
  probeServer();
})();