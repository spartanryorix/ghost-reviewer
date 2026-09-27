// GET /api/health -> lets the page detect the proxy and whether a key is configured.
const { DEFAULT_MODEL } = require("../shared.js");

module.exports = function handler(req, res) {
  res.status(200).json({
    ok: true,
    hasKey: Boolean(process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY),
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
  });
};
