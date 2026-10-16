import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/genai';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

async function getAIResponse(promptText) {
  try {
    const result = await geminiModel.generateContent(promptText);
    const text = result.response.text();
    if (text) return text;
  } catch (geminiError) {
    console.warn('⚠️ Gemini failed, trying Groq...');
  }

  try {
    if (!GROQ_API_KEY) throw new Error('Groq key missing');
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: promptText }] })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Thanks for contacting ZK-Tech Digital! We will reply soon.";
  } catch (err) {
    return "Hi! Welcome to ZK-Tech Digital. We received your message.";
  }
}

let sock;
let currentQrBase64 = null;
let currentPairingCode = null;
let connectionStatus = 'Disconnected';

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = 'Waiting for Scan/Pairing';
      currentQrBase64 = await QRCode.toDataURL(qr);
    }
    if (connection === 'connecting') connectionStatus = 'Authenticating...';
    if (connection === 'open') {
      connectionStatus = 'Connected ✅';
      currentQrBase64 = null;
      currentPairingCode = null;
    }
    if (connection === 'close') {
      connectionStatus = 'Disconnected';
      if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsApp, 3000);
      }
    }
  });
}

startWhatsApp();

app.post('/api/whatsapp/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    let cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.startsWith('0')) cleanNum = '92' + cleanNum.slice(1);

    if (sock && !sock.authState.creds.registered) {
      await new Promise(r => setTimeout(r, 1000));
      const code = await sock.requestPairingCode(cleanNum);
      currentPairingCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      return res.json({ success: true, pairingCode: currentPairingCode });
    }
    res.status(400).json({ error: 'Already connected or initializing.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  res.json({ status: connectionStatus, qrCode: currentQrBase64, pairingCode: currentPairingCode, isConnected: connectionStatus === 'Connected ✅' });
});

app.post('/api/whatsapp/send-ai-message', async (req, res) => {
  try {
    const { clientPhoneNumber, clientMessage, projectDetails } = req.body;
    const prompt = `You are a sales assistant for ZK-Tech Digital. Client said: "${clientMessage}". Context: "${projectDetails}". Keep response under 3 sentences.`;
    const aiReply = await getAIResponse(prompt);

    let cleanNum = clientPhoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.startsWith('0')) cleanNum = '92' + cleanNum.slice(1);

    await sock.sendMessage(`${cleanNum}@s.whatsapp.net`, { text: aiReply });
    res.json({ success: true, aiReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ZK-Tech Digital Server running on port ${PORT}`));
