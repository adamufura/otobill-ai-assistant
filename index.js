// index.js — Otobill AI Call Assistant (Africa's Talking version)
// Flow: Caller dials in -> AT hits /voice -> we Say + Record
//       -> AT hits /voice/process with recordingUrl -> we transcribe (Deepgram)
//       -> send to OpenAI -> respond with Say + Record again (loop)

require('dotenv').config();
const express = require('express');
const { DeepgramClient } = require('@deepgram/sdk');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── GLOBAL REQUEST LOGGER — logs every incoming request ──
app.use((req, res, next) => {
  console.log('\n========================================');
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('========================================\n');
  next();
});

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory conversation history per call session
const sessions = {};

const SYSTEM_PROMPT = `You are Pro, the AI voice assistant for Otobill — a Nigerian fintech platform for bill payments, airtime, data, TV subscriptions, and NIN/BVN services.
Your job is to answer calls on behalf of Otobill professionally.
- Greet callers warmly and professionally
- Answer questions about Otobill services:
  * Airtime and data top-up for all Nigerian networks (MTN, Airtel, Glo, 9mobile)
  * Electricity bill payments (EKEDC, IKEDC, AEDC, etc)
  * TV subscriptions (DSTV, GOTV, Startimes)
  * NIN and BVN verification services
- Take messages if the caller needs human assistance — ask for their name and phone number
- Keep responses SHORT — max 2 sentences. This is a phone call.
- Sound natural and human, never robotic
- If asked to speak to a human, say the team will call back shortly and take their name and number
- If you don't know something, say you'll pass the message to the team`;

// Helper: escape text for safe XML embedding
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper: build the standard "Say + Record" XML response
function buildResponse(sayText, recordCallbackPath) {
  const baseUrl = process.env.BASE_URL; // e.g. https://f1fc-105-112-120-215.ngrok-free.app
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record finishOnKey="#" maxLength="30" trimSilence="true" playBeep="true" callbackUrl="${baseUrl}${recordCallbackPath}">
    <Say voice="en-US-Standard-C">${xmlEscape(sayText)}</Say>
  </Record>
</Response>`;

  console.log('📤 Responding with XML:\n', xml);
  return xml;
}

// ── ENTRY POINT — set this as your callback URL on Africa's Talking ──
app.post('/voice', (req, res) => {
  const { sessionId, isActive, callerNumber } = req.body;
  console.log('📞 /voice hit | sessionId:', sessionId, '| from:', callerNumber, '| isActive:', isActive);

  if (isActive === '1' || isActive === 1) {
    // New session
    sessions[sessionId] = { history: [] };
    console.log('🆕 New session created:', sessionId);

    const greeting = "Hello, thank you for calling Otobill. I'm Pro, your AI assistant. How can I help you today?";
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(greeting, '/voice/process'));
  }

  // Final request (call ended) - log and end
  console.log('📵 Call ended at /voice (no recording happened)');
  logCallEnd(req.body, sessionId);
  res.sendStatus(200);
});

// ── PROCESS RECORDING — Deepgram transcribe -> OpenAI -> respond ──
app.post('/voice/process', async (req, res) => {
  const { sessionId, isActive, recordingUrl, durationInSeconds } = req.body;
  console.log('🎙️ /voice/process hit | sessionId:', sessionId, '| isActive:', isActive, '| recordingUrl:', recordingUrl);

  if (isActive !== '1' && isActive !== 1) {
    console.log('📵 Call ended at /voice/process');
    logCallEnd(req.body, sessionId);
    return res.sendStatus(200);
  }

  const session = sessions[sessionId] || { history: [] };
  sessions[sessionId] = session;

  // No speech captured
  if (!recordingUrl) {
    console.log('⚠️ No recordingUrl received — caller may not have spoken or recording failed');
    const retryText = "Sorry, I didn't catch that. Could you please repeat your question?";
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(retryText, '/voice/process'));
  }

  try {
    // 1) Transcribe with Deepgram (prerecorded, from URL)
    console.log('📡 Sending recording to Deepgram for transcription:', recordingUrl);

    const result = await deepgram.listen.v1.media.transcribeUrl({
      url: recordingUrl,
      model: 'nova-2',
      smart_format: true,
      language: 'en',
    });

    console.log('🧾 Deepgram raw result:', JSON.stringify(result, null, 2));

    const transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    console.log('🗣️ Caller said:', transcript || '(empty)');

    if (!transcript) {
      const retryText = "I'm sorry, I couldn't hear that clearly. Could you say that again?";
      res.set('Content-Type', 'application/xml');
      return res.send(buildResponse(retryText, '/voice/process'));
    }

    // 2) Add to history and get OpenAI response
    session.history.push({ role: 'user', content: transcript });
    console.log('🧠 Sending to OpenAI. History length:', session.history.length);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.history
      ],
      max_tokens: 150,
      temperature: 0.7
    });

    const aiResponse = completion.choices[0].message.content;
    console.log('🤖 Pro responding:', aiResponse);

    session.history.push({ role: 'assistant', content: aiResponse });

    // 3) Respond with Say + Record (loop continues)
    res.set('Content-Type', 'application/xml');
    return res.send(buildResponse(aiResponse, '/voice/process'));

  } catch (err) {
    console.error('❌ Error in /voice/process:', err);
    if (err?.response?.data) {
      console.error('❌ Error response data:', JSON.stringify(err.response.data, null, 2));
    }
    const errorText = "Sorry, I'm having a technical issue right now. Please try calling again shortly.";
    res.set('Content-Type', 'application/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(errorText)}</Say></Response>`);
  }
});

function logCallEnd(body, sessionId) {
  const { durationInSeconds, currencyCode, amount } = body;
  console.log('📵 Call ended:', sessionId, '| Duration:', durationInSeconds, 's | Cost:', amount, currencyCode);
  delete sessions[sessionId];
}

// ── Health check ──
app.get('/', (req, res) => {
  res.send('🤖 Otobill AI Assistant (Africa\'s Talking) is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Otobill AI Assistant running on port ${PORT}`);
});