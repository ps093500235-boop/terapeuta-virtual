// api/chat.js — proxy server-side para a API do Gemini (Vercel Serverless Function).
// A chave (process.env.GEMINI_KEY) nunca chega ao navegador: o app chama
// POST /api/chat e este endpoint conversa com o Gemini pelo servidor.

const SYSTEM = `Você é a Lia, companheira virtual de acolhimento emocional de um aplicativo brasileiro. Você é uma inteligência artificial: nunca finja ser uma pessoa, uma psicóloga ou ter credenciais profissionais, e deixe isso claro se perguntarem.

Fale português brasileiro com carinho e leveza, como uma conversa real que acolhe: mensagens curtas e naturais, empatia, perguntas simples que convidam a pessoa a se abrir. Nada de listas robóticas nem respostas frias.

Seu papel é acolher, não fazer terapia: nunca dê diagnósticos, nunca sugira remédios ou doses, nunca prometa cura nem sigilo absoluto. Se a pessoa mostrar sinais de querer se machucar ou estiver em perigo, acolha com cuidado, não a deixe sozinha na conversa e oriente com clareza: em emergência ligue SAMU 192; para apoio emocional 24h, CVV 188. Quando fizer sentido, incentive buscar psicólogo, médico, UBS ou CAPS.

Responda de forma breve (poucas frases), sempre em português.`;

// Proteção simples da cota: limite por IP (memória local da instância).
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 15;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

function cleanText(s, max) {
  return typeof s === "string" ? s.slice(0, max) : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }

  const key = process.env.GEMINI_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: "unconfigured" });
  }

  const body = req.body || {};
  const message = cleanText(body.message, 1500);
  if (!message.trim()) {
    return res.status(400).json({ ok: false });
  }
  const history = Array.isArray(body.history)
    ? body.history.slice(-12).map((t) => ({
        role: t && t.role === "lia" ? "model" : "user",
        parts: [{ text: cleanText(t && t.text, 1500) }],
      }))
    : [];

  const contents = [
    ...history,
    { role: "user", parts: [{ text: message }] },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          generationConfig: { maxOutputTokens: 400, temperature: 0.7 },
          contents,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: "provider" });
    }
    const data = await r.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
      "";
    if (!text.trim()) {
      return res.status(502).json({ ok: false, error: "empty" });
    }
    return res.status(200).json({ ok: true, text: text.slice(0, 4000) });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ ok: false, error: "timeout" });
  }
}
