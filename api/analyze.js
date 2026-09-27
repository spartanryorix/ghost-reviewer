// POST /api/analyze  { image: "data:image/jpeg;base64,...", history: string[] } -> { text }
// Runs as a Vercel serverless function, and locally through server.js. The key never leaves the server.
const { buildRequest, HISTORY_LIMIT, DEFAULT_ENDPOINT, DEFAULT_MODEL } = require("../shared.js");

const MAX_BODY_IMAGE_CHARS = 1500000;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  // Tolerate keys pasted with a "Bearer " prefix.
  const key = (process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY || "").trim().replace(/^Bearer\s+/i, "");
  if (!key) return res.status(500).json({ error: "Server is missing NVIDIA_API_KEY." });

  const { image, history } = req.body || {};
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return res.status(400).json({ error: "Expected an image data URL." });
  }
  if (image.length > MAX_BODY_IMAGE_CHARS) return res.status(413).json({ error: "Image too large." });

  const recent = Array.isArray(history)
    ? history.filter((q) => typeof q === "string").slice(-HISTORY_LIMIT).map((q) => q.slice(0, 300))
    : [];

  try {
    const upstream = await fetch(process.env.LLM_ENDPOINT || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(buildRequest(process.env.LLM_MODEL || DEFAULT_MODEL, recent, image)),
      signal: AbortSignal.timeout(90000), // Reasoning models can take a while.
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const detail = (data && (data.error?.message || data.detail || data.title)) || "";
      return res.status(502).json({ error: `Model API returned ${upstream.status}${detail ? `: ${detail}` : ""}` });
    }
    return res.status(200).json({ text: data?.choices?.[0]?.message?.content ?? "" });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const cause = err?.cause?.code || err?.cause?.message;
    return res.status(504).json({
      error: timedOut ? "Model API timed out." : `Couldn't reach the model API: ${err.message}${cause ? ` (${cause})` : ""}`,
    });
  }
};
