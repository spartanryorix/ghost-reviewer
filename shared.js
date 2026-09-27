// Shared by the browser (window.GhostShared) and the Node proxy (require).
// Holds the system prompt, request shape, and reply parsing so both paths behave identically.
(function (root) {
  "use strict";

  const DEFAULT_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
  // Tested Sep 2026 on NVIDIA's free endpoints: Glimmer stayed SILENT on an empty slide and asked a sharp,
  // specific question on a weak one (7–40s). llama-3.2-11b-vision is ~1.5s but interrupts on almost anything.
  const DEFAULT_MODEL = "meta/muse-glimmer-30b";
  const HISTORY_LIMIT = 8;
  // NVIDIA's hosted vision models only accept inline base64 images under ~180KB.
  const MAX_IMAGE_CHARS = 180000;

  const SYSTEM_PROMPT = `You are Ghost Reviewer. You watch someone's work in progress (a slide, code, a
design, a document) and act as their harshest future critic — the skeptical
judge, investor, or user who will eventually tear this apart.

Rules:
- Say NOTHING unless you see a genuine weak point: an unsupported claim, a
  missing number, a logic gap, a design choice that will confuse a real user,
  a slide that oversells, code that will break.
- When you do speak, ask exactly ONE question. No lists, no "here are some
  suggestions." One sentence, sharp, specific to what's on screen right now.
- Never repeat a question you've already asked (see history below) or ask
  something close in meaning to one already asked.
- Be uncomfortable, not cruel. The goal is to make them fix it before a real
  critic sees it.
- If nothing meaningfully new or weak is visible, or it's too early to judge,
  respond with EXACTLY the single word: SILENT

Previously asked:
{history}

Respond with either SILENT, or a single sharp question. No preamble, no quotes, no explanation.`;

  function buildPrompt(history) {
    const recent = (history || []).slice(-HISTORY_LIMIT);
    const block = recent.length ? recent.map((q) => `- ${q}`).join("\n") : "(none yet)";
    return SYSTEM_PROMPT.replace("{history}", block);
  }

  // OpenAI-compatible chat body. The prompt rides in the user turn because several
  // vision models reject a system message when an image is attached. Image goes first:
  // Llama vision models answered SILENT to obviously weak slides with the text first.
  function buildRequest(model, history, imageDataUrl) {
    return {
      model: model || DEFAULT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: buildPrompt(history) },
          ],
        },
      ],
      // Reasoning models (like Glimmer) think before answering and need the headroom.
      max_tokens: 2000,
      temperature: 0.4,
      stream: false,
    };
  }

  // Returns the single question to show, or null for silence.
  function parseReply(raw) {
    let text = String(raw || "").trim();
    if (!text || /^[\s"'`*]*silent\b/i.test(text)) return null;
    const qIdx = text.indexOf("?");
    if (qIdx === -1) return null; // Not a question: treat rambling as silence.
    text = text.slice(0, qIdx + 1);
    // Drop any preamble line or sentence before the question.
    text = text.split(/\n+/).pop();
    const boundary = Math.max(text.lastIndexOf(". "), text.lastIndexOf("! "), text.lastIndexOf(": "));
    if (boundary !== -1) text = text.slice(boundary + 2);
    text = text.replace(/^[\s\-*\d.)"'`]+/, "").trim();
    return text.length > 8 ? text : null;
  }

  const STOP_WORDS = new Set(
    ("the a an and or but is are was were be been this that these those what why how when where which who " +
      "does do did your you it its of to in on for with as at by from will would could should can have has had " +
      "there their they them than then so if not no any about into just really").split(" ")
  );

  function tokens(s) {
    const words = String(s).toLowerCase().match(/[a-z0-9%$]+/g) || [];
    return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
  }

  // Word-overlap check so a reworded repeat is still held back.
  function isNearDuplicate(question, history, threshold = 0.55) {
    const a = tokens(question);
    if (!a.size) return false;
    return (history || []).some((h) => {
      const b = tokens(h);
      let shared = 0;
      a.forEach((w) => b.has(w) && shared++);
      const union = a.size + b.size - shared;
      return union > 0 && shared / union >= threshold;
    });
  }

  const api = {
    DEFAULT_ENDPOINT,
    DEFAULT_MODEL,
    HISTORY_LIMIT,
    MAX_IMAGE_CHARS,
    SYSTEM_PROMPT,
    buildPrompt,
    buildRequest,
    parseReply,
    isNearDuplicate,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GhostShared = api;
})(typeof self !== "undefined" ? self : this);
