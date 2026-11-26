/**
 * EspOS EspCHAT Cloud/LAN Bridge v3.4.0 - Hardened Security, Anti-OOM, Zero Hardcoded PII & Contract Unification
 * - Autenticacion obligatoria Fail-Closed via header X-EspOS-Key + Rate Limiter anti-fuerza bruta.
 * - Limites estrictos de payload en streaming (leerBodySeguro) contra OOM/DoS (HTTP 413).
 * - Endpoints destructivos convertidos a POST autenticado con confirmacion explicita ({ confirm: true }).
 * - Cero PII hardcodeada, /api/diag saneado, / minimalista sin fugas de sesion ni CORS *.
 * - Sincronizacion en tiempo real, avatares/stickers RGB565 One UI, notas de voz WAV 16kHz y Anti-Delete.
 */
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers, jidNormalizedUser } = require("@whiskeysockets/baileys");
const { execFile } = require("child_process");
const crypto = require("crypto");
const pino = require("pino");
const http = require("http");
const url = require("url");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

let sharp = null;
try { sharp = require("sharp"); console.log("[Sharp] Motor de imagenes cargado correctamente"); } catch (e) { console.log("[Sharp] No disponible aun"); }

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SKIP_WA = process.env.ESPOS_SKIP_WA === "1";
const IS_CLOUD = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.NODE_ENV === "production");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const authFolder = path.join(DATA_DIR, "auth_info_baileys");
const avatarsFolder = path.join(DATA_DIR, "avatars_cache");
const stickersFolder = path.join(DATA_DIR, "stickers_cache");
const photosFolder = path.join(DATA_DIR, "photos_cache");
const audioFolder = path.join(DATA_DIR, "audio_cache");
const storeFile = path.join(DATA_DIR, "espos_store.json");

if (!fs.existsSync(photosFolder)) fs.mkdirSync(photosFolder, { recursive: true });
if (!fs.existsSync(avatarsFolder)) fs.mkdirSync(avatarsFolder, { recursive: true });
if (!fs.existsSync(stickersFolder)) fs.mkdirSync(stickersFolder, { recursive: true });
if (!fs.existsSync(audioFolder)) fs.mkdirSync(audioFolder, { recursive: true });

// Carga Fail-Closed de ESPOS_API_KEY
function cargarApiKey() {
  const fromEnv = process.env.ESPOS_API_KEY ? process.env.ESPOS_API_KEY.trim() : "";
  if (fromEnv) return fromEnv;

  if (IS_CLOUD) {
    console.error("[Auth] ERROR CRITICO: ESPOS_API_KEY no configurada en entorno cloud. Modo Fail-Closed activo (HTTP 503 en /api/*).");
    return "";
  }

  // Entorno local: buscar en .env junto al script o en DATA_DIR/.espos_key
  const envFile = path.join(__dirname, ".env");
  try {
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = trimmed.match(/^ESPOS_API_KEY\s*=\s*(.+)$/);
        if (m) {
          let val = m[1].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1).trim();
          }
          if (val) return val;
        }
      }
    }
  } catch (e) {
    console.warn("[Auth] No se pudo leer .env local:", e.message);
  }

  const keyFile = path.join(DATA_DIR, ".espos_key");
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing) return existing;
    }
  } catch (e) {
    console.warn("[Auth] No se pudo leer .espos_key:", e.message);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(keyFile, generated + "\n", { mode: 0o600 });
    console.log(`[Auth] Clave local generada en ${keyFile} (fingerprint: ${generated.slice(0, 8)}...)`);
  } catch (e) {
    console.error("[Auth] Error escribiendo .espos_key:", e.message);
  }
  return generated;
}

const API_KEY = cargarApiKey();
const EXPECTED_KEY_HASH = API_KEY ? crypto.createHash("sha256").update(API_KEY, "utf8").digest() : null;

function verificarApiKey(req) {
  if (!EXPECTED_KEY_HASH) return false;
  const provided = req.headers["x-espos-key"];
  if (typeof provided !== "string" || !provided) return false;
  const providedHash = crypto.createHash("sha256").update(provided, "utf8").digest();
  if (providedHash.length !== EXPECTED_KEY_HASH.length) return false;
  return crypto.timingSafeEqual(providedHash, EXPECTED_KEY_HASH);
}

// Rate limiter anti-fuerza bruta por IP (10 fallos en 15 min -> bloqueo 15 min)
const MAX_AUTH_FAILS = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_BLOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_IPS = 5000;
const failedAuthByIp = new Map(); // ip -> { count, firstFailAt, blockedUntil }

function obtenerIpCliente(req) {
  if (IS_CLOUD) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      const partes = xff.split(",").map(s => s.trim()).filter(Boolean);
      if (partes.length > 0) return partes[partes.length - 1];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

function estaBloqueadaIp(ip) {
  const entry = failedAuthByIp.get(ip);
  if (!entry) return false;
  const now = Date.now();
  if (entry.blockedUntil) {
    if (now < entry.blockedUntil) return true;
    failedAuthByIp.delete(ip);
    return false;
  }
  if (now - entry.firstFailAt > AUTH_WINDOW_MS) {
    failedAuthByIp.delete(ip);
    return false;
  }
  return false;
}

function registrarFalloAuth(ip) {
  const now = Date.now();
  let entry = failedAuthByIp.get(ip);
  if (!entry || (now - entry.firstFailAt > AUTH_WINDOW_MS && !entry.blockedUntil)) {
    if (!entry && failedAuthByIp.size >= MAX_FAILED_IPS) {
      const oldestKey = failedAuthByIp.keys().next().value;
      if (oldestKey !== undefined) failedAuthByIp.delete(oldestKey);
    }
    entry = { count: 1, firstFailAt: now, blockedUntil: 0 };
    failedAuthByIp.set(ip, entry);
    return;
  }
  entry.count += 1;
  if (entry.count >= MAX_AUTH_FAILS) {
    entry.blockedUntil = now + AUTH_BLOCK_MS;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAuthByIp.entries()) {
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      failedAuthByIp.delete(ip);
    } else if (!entry.blockedUntil && now - entry.firstFailAt > AUTH_WINDOW_MS) {
      failedAuthByIp.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function leerBodySeguro(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      const err = new Error("Payload Too Large");
      err.statusCode = 413;
      req.pause();
      return reject(err);
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        const err = new Error("Payload Too Large");
        err.statusCode = 413;
        req.pause();
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function responderErrorBody(res, req, err) {
  if (err && err.statusCode === 413) {
    res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
    return res.end(JSON.stringify({ ok: false, error: "Payload Too Large" }), () => {
      try { req.destroy(); } catch (_) {}
    });
  }
  res.writeHead(400, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ ok: false, error: err?.message || "Solicitud invalida" }));
}

// Limpieza LRU no destructiva de stickers_cache (maximo 200 stickers = 400 archivos .raw/.webp)
function limpiarCacheStickersLRU(maxStickers = 200, logIfClean = false) {
  try {
    if (!fs.existsSync(stickersFolder)) return;
    const entries = fs.readdirSync(stickersFolder);
    const maxFiles = Math.max(1, Number(maxStickers) || 200) * 2;
    const validFiles = [];
    let malformedRemoved = 0;

    for (const name of entries) {
      const fullPath = path.join(stickersFolder, name);
      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile()) continue;
        if (name.endsWith(".raw") && st.size !== 64 * 64 * 2) {
          try {
            fs.unlinkSync(fullPath);
            malformedRemoved++;
          } catch (_) {}
          continue;
        }
        validFiles.push({ name, fullPath, mtimeMs: st.mtimeMs || st.ctimeMs || 0 });
      } catch (_) {}
    }

    let lruRemoved = 0;
    if (validFiles.length > maxFiles) {
      validFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = validFiles.length - maxFiles;
      for (let i = 0; i < excess; i++) {
        try {
          fs.unlinkSync(validFiles[i].fullPath);
          lruRemoved++;
        } catch (_) {}
      }
    }

    if (malformedRemoved > 0 || lruRemoved > 0) {
      console.log(`[Stickers] Cache LRU limpiado: ${malformedRemoved} .raw malformados eliminados, ${lruRemoved} archivos antiguos purgados (${validFiles.length - lruRemoved} conservados)`);
    } else if (logIfClean) {
      console.log(`[Stickers] Cache LRU verificado al iniciar (${validFiles.length} archivos conservados)`);
    }
  } catch (e) {
    console.warn("[Stickers] Error en limpieza LRU de cache:", e.message);
  }
}
limpiarCacheStickersLRU(200, true);

let ultimaLimpiezaStickersMs = Date.now();
function verificarLimpiezaStickersLRU() {
  const ahora = Date.now();
  if (ahora - ultimaLimpiezaStickersMs < 5 * 60 * 1000) return;
  ultimaLimpiezaStickersMs = ahora;
  limpiarCacheStickersLRU(200, false);
}

const MAX_RAW_MEDIA = 500;
const rawMediaMap = new Map(); // msgId / stickerId -> WAMessage

function registrarMediaEnMapa(key, msg) {
  if (!key || !msg) return;
  if (rawMediaMap.has(key)) rawMediaMap.delete(key);
  rawMediaMap.set(key, msg);
  while (rawMediaMap.size > MAX_RAW_MEDIA) {
    const k = rawMediaMap.keys().next().value;
    rawMediaMap.delete(k);
  }
}

function extraerMensajeInterno(rawMsg) {
  let inner = rawMsg?.message || rawMsg;
  if (inner?.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
  if (inner?.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
  if (inner?.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
  if (inner?.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;
  return inner;
}

function extraerStickerId(stickerMsg, fallbackId = "") {
  try {
    const sha = stickerMsg?.fileSha256;
    if (sha) {
      let buf = null;
      if (Buffer.isBuffer(sha) || sha instanceof Uint8Array || Array.isArray(sha)) {
        buf = Buffer.from(sha);
      } else if (Array.isArray(sha?.data)) {
        buf = Buffer.from(sha.data);
      } else if (typeof sha === "string" && sha.length > 0) {
        buf = Buffer.from(sha, "base64");
      } else if (typeof sha === "object") {
        const numKeys = Object.keys(sha)
          .filter(k => /^\d+$/.test(k))
          .sort((a, b) => Number(a) - Number(b));
        if (numKeys.length > 0) buf = Buffer.from(numKeys.map(k => sha[k]));
      }
      if (buf && buf.length > 0) {
        return buf.toString("hex").substring(0, 32);
      }
    }
  } catch (_) {}
  return fallbackId ? String(fallbackId).replace(/[^a-zA-Z0-9_-]/g, "_") : "";
}

function indexarStickerEnMapa(msg, extraIds = []) {
  if (!msg) return "";
  const inner = extraerMensajeInterno(msg);
  const msgKeyId = msg?.key?.id ? String(msg.key.id) : "";
  const safeKeyId = msgKeyId ? msgKeyId.replace(/[^a-zA-Z0-9_-]/g, "_") : "";
  const sId = inner?.stickerMessage ? extraerStickerId(inner.stickerMessage, msgKeyId) : "";

  if (msgKeyId) registrarMediaEnMapa(msgKeyId, msg);
  if (safeKeyId && safeKeyId !== msgKeyId) registrarMediaEnMapa(safeKeyId, msg);
  if (sId) registrarMediaEnMapa(sId, msg);
  for (const extra of extraIds) {
    if (typeof extra === "string" && extra.trim()) {
      registrarMediaEnMapa(extra.trim(), msg);
    }
  }
  return sId;
}

async function convertirStickerARgb565(mediaBuf) {
  if (!sharp || !mediaBuf) return null;
  const resObj = await sharp(mediaBuf, { page: 0 })
    .resize(64, 64, { fit: "contain", background: { r: 16, g: 24, b: 32, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const data = resObj.data;
  const channels = resObj.info.channels || 4;
  const rgb565 = Buffer.alloc(64 * 64 * 2);
  for (let i = 0; i < 64 * 64; i++) {
    const off = i * channels;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    const a = channels >= 4 ? data[off + 3] : 255;
    if (a < 64) {
      rgb565.writeUInt16LE(0x10C4, i * 2);
    } else {
      let c16 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      if (c16 === 0x10C4) c16 = 0x10E4;
      else if (c16 === 0x0000) c16 = 0x0821;
      else if (c16 === 0x1184) c16 = 0x11A4;
      rgb565.writeUInt16LE(c16, i * 2);
    }
  }
  return rgb565;
}

async function convertirRawAWebp(rawBuf) {
  if (!sharp || !Buffer.isBuffer(rawBuf) || rawBuf.length !== 64 * 64 * 2) return null;
  const rgbaBuf = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    const c16 = rawBuf.readUInt16LE(i * 2);
    if (c16 === 0x10C4 || c16 === 0x0000 || c16 === 0x1184) {
      rgbaBuf[i * 4] = 0;
      rgbaBuf[i * 4 + 1] = 0;
      rgbaBuf[i * 4 + 2] = 0;
      rgbaBuf[i * 4 + 3] = 0;
    } else {
      const r = ((c16 >> 11) & 0x1F) * 255 / 31;
      const g = ((c16 >> 5) & 0x3F) * 255 / 63;
      const b = (c16 & 0x1F) * 255 / 31;
      rgbaBuf[i * 4] = Math.round(r);
      rgbaBuf[i * 4 + 1] = Math.round(g);
      rgbaBuf[i * 4 + 2] = Math.round(b);
      rgbaBuf[i * 4 + 3] = 255;
    }
  }
  return sharp(rgbaBuf, { raw: { width: 64, height: 64, channels: 4 } })
    .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 })
    .toBuffer();
}
const allMessagesMap = new Map(); // msgId -> raw WAMessage
const groupMetaCache = new Map(); // jid -> { announce: boolean, soloAdmins: boolean, ts: number }
const estadosMap = new Map(); // id -> item (declarado antes de cargarStoreDisco para evitar TDZ)

let sock = null;
let isConnected = false;
let myNumber = "";
let myName = "";
let myLid = "";
let currentQR = "";
let rawQR = "";
let chatsCache = new Map();
let messagesCache = new Map();
let agendaMap = new Map();   // JID / LID -> Nombre guardado por el usuario en su agenda
let pushNameMap = new Map(); // JID / LID -> Apodo que el contacto se puso a si mismo
let contactsMap = agendaMap; // Alias de compatibilidad
let lidToJid = new Map();    // LID -> JID
let jidToLid = new Map();    // JID -> LID
let presenceMap = new Map();  // JID -> { status: "available"|"composing"|..., t: number }
let callsList = [];

function obtenerMiJid() {
  if (myNumber) return `${myNumber}@s.whatsapp.net`;
  if (sock?.user?.id) return jidNormalizedUser(sock.user.id);
  return "";
}

function esChatPropio(jid) {
  if (!jid || typeof jid !== "string") return false;
  if (jid.endsWith("@g.us") || jid.endsWith("@newsletter")) return false;
  const norm = jidNormalizedUser(jid);
  const myJid = obtenerMiJid();
  const sockNum = sock?.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0].split(":")[0] : "";
  const activeNum = myNumber || sockNum;
  if (myJid && norm === myJid) return true;
  if (myLid) {
    const myLidBase = myLid.split("@")[0].split(":")[0];
    const jidBase = jid.split("@")[0].split(":")[0];
    if (jid === myLid || norm === myLid || (myLidBase && jidBase === myLidBase && jid.endsWith("@lid"))) {
      return true;
    }
  }
  if (activeNum) {
    const normBase = norm.split("@")[0].split(":")[0];
    if (normBase === activeNum) return true;
  }
  return false;
}

async function obtenerPermisosGrupo(jid) {
  if (!jid || !jid.endsWith("@g.us")) return false;
  const ahora = Date.now();
  if (groupMetaCache.has(jid)) {
    const item = groupMetaCache.get(jid);
    if (ahora - item.ts < 300000) return item.soloAdmins;
  }
  if (!sock) return false;
  try {
    const meta = await sock.groupMetadata(jid);
    const soloAdminsConfig = Boolean(meta.announce);
    if (!soloAdminsConfig) {
      groupMetaCache.set(jid, { announce: false, soloAdmins: false, ts: ahora });
      return false;
    }
    const myJidNorm = obtenerMiJid();
    const myLidNorm = myLid ? jidNormalizedUser(myLid) : "";
    const soyAdmin = (meta.participants || []).some(p => {
      if (!p || !p.id) return false;
      const pJid = jidNormalizedUser(p.id);
      const pNum = p.id.split("@")[0].split(":")[0];
      const coincide = (myJidNorm && pJid === myJidNorm) ||
                       (myLidNorm && pJid === myLidNorm) ||
                       (myNumber && (pNum === myNumber || pJid.includes(myNumber))) ||
                       (myLid && p.id.startsWith(myLid.split("@")[0]));
      return coincide && (p.admin === "admin" || p.admin === "superadmin");
    });
    const restringido = soloAdminsConfig && !soyAdmin;
    groupMetaCache.set(jid, { announce: true, soloAdmins: restringido, ts: ahora });
    return restringido;
  } catch (e) {
    return false;
  }
}

// Persistencia en disco para que reinicios o redeploys nunca borren nombres ni historiales
function cargarStoreDisco() {
  try {
    if (fs.existsSync(storeFile)) {
      const data = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
      if (data.agenda) {
        for (const [k, v] of Object.entries(data.agenda)) agendaMap.set(k, v);
      }
      if (data.pushNames) {
        for (const [k, v] of Object.entries(data.pushNames)) pushNameMap.set(k, v);
      }
      if (data.contacts && agendaMap.size === 0) {
        for (const [k, v] of Object.entries(data.contacts)) agendaMap.set(k, v);
      }
      if (data.lidToJid) {
        for (const [k, v] of Object.entries(data.lidToJid)) lidToJid.set(k, v);
      }
      if (data.jidToLid) {
        for (const [k, v] of Object.entries(data.jidToLid)) jidToLid.set(k, v);
      }
      if (data.chats) {
        for (const [k, v] of Object.entries(data.chats)) chatsCache.set(k, v);
      }
      if (data.messages) {
        for (const [k, v] of Object.entries(data.messages)) {
          if (Array.isArray(v)) {
            const recientes = v.slice(-50);
            if (recientes.length > 0) messagesCache.set(k, recientes);
          }
        }
      }
      if (data.estados) {
        const ahoraSeg = Math.floor(Date.now() / 1000);
        for (const [k, v] of Object.entries(data.estados)) {
          if (ahoraSeg - (Number(v.timestamp) || 0) < 86400) {
            estadosMap.set(k, v);
          }
        }
      }
      if (Array.isArray(data.llamadas)) {
        callsList = data.llamadas.slice(0, 20);
      }
      if (data.rawMedia) {
        for (const [k, v] of Object.entries(data.rawMedia)) {
          registrarMediaEnMapa(k, v);
          const inner = extraerMensajeInterno(v);
          if (inner?.stickerMessage) {
            indexarStickerEnMapa(v, [k]);
          }
        }
      }
      console.log(`[Store] Restaurado desde disco: ${chatsCache.size} chats, ${messagesCache.size} historiales, ${contactsMap.size} contactos.`);
    }
  } catch (e) {
    console.error("[Store] Error cargando store de disco:", e.message);
  }
}
cargarStoreDisco();

let guardarTimer = null;

function formatearUltimaVez(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const ahora = new Date();
    const opcionesHora = { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" };
    const strHora = d.toLocaleTimeString("es-PE", opcionesHora);
    const strFechaMsg = d.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    const strFechaHoy = ahora.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    if (strFechaMsg === strFechaHoy) {
      return `ult. vez hoy a las ${strHora}`;
    }
    const ayer = new Date(ahora.getTime() - 86400000);
    const strFechaAyer = ayer.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    if (strFechaMsg === strFechaAyer) {
      return `ult. vez ayer a las ${strHora}`;
    }
    const strFechaCorta = d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", timeZone: "America/Lima" });
    return `ult. vez el ${strFechaCorta} a las ${strHora}`;
  } catch (e) {
    return "";
  }
}

function programarGuardadoDisco() {
  if (guardarTimer) clearTimeout(guardarTimer);
  guardarTimer = setTimeout(() => {
    try {
      const ahoraSeg = Math.floor(Date.now() / 1000);
      const msgsFrescos = {};
      for (const [k, v] of messagesCache.entries()) {
        if (Array.isArray(v)) {
          const ultimos = v.slice(-50);
          if (ultimos.length > 0) msgsFrescos[k] = ultimos;
        }
      }
      const estadosValidos = {};
      for (const [k, v] of estadosMap.entries()) {
        if (ahoraSeg - (Number(v.timestamp) || 0) < 86400) {
          estadosValidos[k] = v;
        }
      }
      const payload = {
        agenda: Object.fromEntries(agendaMap.entries()),
        pushNames: Object.fromEntries(pushNameMap.entries()),
        contacts: Object.fromEntries(agendaMap.entries()),
        lidToJid: Object.fromEntries(lidToJid.entries()),
        jidToLid: Object.fromEntries(jidToLid.entries()),
        chats: Object.fromEntries(chatsCache.entries()),
        messages: msgsFrescos,
        estados: estadosValidos,
        llamadas: callsList.slice(0, 20),
        rawMedia: Object.fromEntries(Array.from(rawMediaMap.entries()).slice(-100))
      };
      fs.writeFileSync(storeFile, JSON.stringify(payload));
    } catch (e) {
      console.error("[Store] Error guardando store en disco:", e.message);
    }
  }, 2000);
}

async function sincronizarGruposReales() {
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gid, gdata] of Object.entries(groups)) {
      if (gdata.subject) {
        contactsMap.set(gid, gdata.subject);
        if (chatsCache.has(gid)) {
          chatsCache.get(gid).name = gdata.subject;
        } else {
          let gTs = gdata.creation ? Number(gdata.creation) : 0;
          let gLast = "";
          let gTime = "";
          if (messagesCache.has(gid)) {
            const ms = messagesCache.get(gid);
            if (ms.length > 0) {
              const u = ms[ms.length - 1];
              if (u.timestamp) gTs = u.timestamp;
              if (u.text) gLast = u.text;
              if (u.time) gTime = u.time;
            }
          }
          chatsCache.set(gid, {
            id: gid,
            name: gdata.subject,
            lastMsg: gLast,
            time: gTime,
            unread: 0,
            timestamp: gTs
          });
        }
      }
    }
    console.log(`[WhatsApp] ${Object.keys(groups).length} grupos sincronizados con sus nombres reales.`);
    programarGuardadoDisco();
  } catch (ge) {
    console.error("[WhatsApp] Error obteniendo grupos:", ge.message);
  }
}

function formatearHora(ts) {
  if (!ts) return "";
  try {
    const date = new Date(ts * 1000);
    const ahora = new Date();

    const opcionesHora = { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" };
    const opcionesFecha = { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Lima" };
    const opcionesDiaSem = { weekday: "short", timeZone: "America/Lima" };

    const strFechaMsg = date.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    const strFechaHoy = ahora.toLocaleDateString("en-CA", { timeZone: "America/Lima" });

    const dMsg = new Date(strFechaMsg + "T12:00:00Z");
    const dHoy = new Date(strFechaHoy + "T12:00:00Z");
    const diffDias = Math.round((dHoy - dMsg) / (1000 * 60 * 60 * 24));

    if (diffDias === 0) {
      return date.toLocaleTimeString("es-PE", opcionesHora).replace(/\s+/g, " ");
    } else if (diffDias === 1) {
      return "Ayer";
    } else if (diffDias > 1 && diffDias < 7) {
      const dia = date.toLocaleDateString("es-PE", opcionesDiaSem);
      return dia.charAt(0).toUpperCase() + dia.slice(1).replace(".", "");
    } else {
      return date.toLocaleDateString("es-PE", opcionesFecha);
    }
  } catch (e) {
    return "";
  }
}

function formatearHoraMensaje(ts) {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleTimeString("es-PE", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Lima"
    }).replace(/\s+/g, " ");
  } catch (e) {
    return "";
  }
}

function extraerTexto(raw) {
  if (!raw) return "";
  const isViewOnce = Boolean(raw.viewOnceMessage || raw.viewOnceMessageV2);
  let m = raw;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
  if (m.editedMessage?.message?.protocolMessage?.editedMessage) {
    m = m.editedMessage.message.protocolMessage.editedMessage;
  }
  if (!m) return "";
  if (m.conversation && m.conversation.trim()) return m.conversation.trim();
  if (m.extendedTextMessage?.text && m.extendedTextMessage.text.trim()) return m.extendedTextMessage.text.trim();
  if (m.imageMessage?.caption) return m.imageMessage.caption.trim();
  if (m.videoMessage?.caption) return m.videoMessage.caption.trim();
  if (m.imageMessage) return isViewOnce ? "[Foto de 1 sola vez]" : (m.imageMessage.caption?.trim() || "[Foto]");
  if (m.audioMessage) return isViewOnce ? "[Audio de 1 sola vez]" : "[Nota de voz]";
  if (m.videoMessage) return isViewOnce ? "[Video de 1 sola vez]" : (m.videoMessage.caption?.trim() || "[Video]");
  if (m.documentMessage) return "[Documento: " + (m.documentMessage.fileName || "archivo") + "]";
  if (m.stickerMessage) return "[Sticker]";
  if (m.locationMessage) return "[Ubicacin]";
  if (m.contactMessage) return "[Contacto]";
  return "";
}

function resolverNombre(jid, pushName, fromMe) {
  if (!jid) return "Contacto";
  if (esChatPropio(jid)) return "Mensajes Guardados (Tú)";

  const alt = lidToJid.get(jid) || jidToLid.get(jid);

  // 1. PRIORIDAD MAXIMA: Agenda del usuario
  const nomAgenda = agendaMap.get(jid) || (alt ? agendaMap.get(alt) : null);
  if (nomAgenda && nomAgenda !== myName && !nomAgenda.startsWith("Contacto WA") && !nomAgenda.startsWith("Comunidad #") && !nomAgenda.startsWith("+")) {
    return nomAgenda;
  }

  // 2. Si chatsCache ya tiene un nombre guardado de agenda, conservarlo intacto
  if (chatsCache.has(jid)) {
    const cName = chatsCache.get(jid).name;
    if (cName && !cName.startsWith("Contacto WA") && !cName.startsWith("Comunidad #") && !cName.startsWith("+")) {
      return cName;
    }
  }
  if (alt && chatsCache.has(alt)) {
    const cName = chatsCache.get(alt).name;
    if (cName && !cName.startsWith("Contacto WA") && !cName.startsWith("Comunidad #") && !cName.startsWith("+")) {
      return cName;
    }
  }

  // 3. PRIORIDAD SECUNDARIA: Apodo asignado por el emisor (pushName)
  const nomPush = (!fromMe && pushName && pushName !== myName) ? pushName : (pushNameMap.get(jid) || (alt ? pushNameMap.get(alt) : null));
  if (nomPush && nomPush !== myName) {
    pushNameMap.set(jid, nomPush);
    if (alt) pushNameMap.set(alt, nomPush);
    return nomPush;
  }

  // 4. Buscar si en el historial de mensajes el emisor dejo su pushName
  const histMsgs = messagesCache.get(jid) || (alt ? messagesCache.get(alt) : null);
  if (Array.isArray(histMsgs)) {
    for (const m of histMsgs) {
      if (!m.fromMe && m.sender && m.sender !== "Contacto" && m.sender !== myName && !m.sender.startsWith("Contacto WA") && !m.sender.startsWith("+")) {
        pushNameMap.set(jid, m.sender);
        if (alt) pushNameMap.set(alt, m.sender);
        return m.sender;
      }
    }
  }

  // 5. Fallback legible
  const base = jid.split("@")[0];
  if (jid.endsWith("@g.us")) return "Comunidad #" + base.slice(0, 6);
  if (jid.endsWith("@lid") || base.length > 12) return "Contacto WA  " + base.slice(-4);
  return "+" + base;
}

function guardarContacto(c) {
  if (!c) return;
  if (c.id && c.lid) {
    lidToJid.set(c.lid, c.id);
    jidToLid.set(c.id, c.lid);
  }
  if (c.name && c.name !== myName && !c.name.startsWith("+") && !c.name.startsWith("Contacto WA")) {
    if (c.id) agendaMap.set(c.id, c.name);
    if (c.lid) agendaMap.set(c.lid, c.name);
    if (chatsCache.has(c.id)) chatsCache.get(c.id).name = c.name;
    if (c.lid && chatsCache.has(c.lid)) chatsCache.get(c.lid).name = c.name;
    programarGuardadoDisco();
  }
  const apodo = c.notify || c.verifiedName;
  if (apodo && apodo !== myName) {
    if (c.id) pushNameMap.set(c.id, apodo);
    if (c.lid) pushNameMap.set(c.lid, apodo);
    if (c.id && (!agendaMap.has(c.id) || !agendaMap.get(c.id))) {
      if (chatsCache.has(c.id)) {
        const cur = chatsCache.get(c.id).name;
        if (!cur || cur.startsWith("+") || cur.startsWith("Contacto WA")) chatsCache.get(c.id).name = apodo;
      }
    }
    programarGuardadoDisco();
  }
}

function procesarEstado(msg, esEnVivo = true) {
  try {
    if (!msg || !msg.message) return;
    const id = msg.key?.id;
    if (!id) return;

    let innerMsg = msg.message;
    if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
    if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
    if (innerMsg?.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;

    let participant = msg.key?.participant || msg.participant || "";
    const esPropio = Boolean(msg.key?.fromMe);
    if (!participant && esPropio) {
      participant = obtenerMiJid() || "me";
    }
    if (!participant) return;

    const alt = lidToJid.get(participant) || jidToLid.get(participant);
    let autor = esPropio ? "Tú" : (contactsMap.get(participant) || (alt ? contactsMap.get(alt) : null) || resolverNombre(participant, "", false));
    if (!autor || autor === "Desconocido") {
      autor = esPropio ? "Tú" : participant.split("@")[0];
      if (autor.length >= 8 && !esPropio) autor = "+" + autor;
    }

    const rawTs = msg.messageTimestamp?.low || msg.messageTimestamp || Math.floor(Date.now() / 1000);
    const ts = Number(rawTs);

    let tipo = "texto";
    let texto = "";
    let esFoto = false;
    let bgArgb = 0xFF128C7E;

    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (innerMsg.imageMessage) {
      tipo = "foto";
      esFoto = true;
      texto = innerMsg.imageMessage.caption ? "[Foto] " + innerMsg.imageMessage.caption : "[Foto]";
      registrarMediaEnMapa(id, msg);
      if (innerMsg.imageMessage.jpegThumbnail) {
        try {
          const jpgPath = path.join(photosFolder, `${safeId}.jpg`);
          if (!fs.existsSync(jpgPath)) {
            fs.writeFileSync(jpgPath, Buffer.from(innerMsg.imageMessage.jpegThumbnail));
          }
        } catch (_) {}
      }
    } else if (innerMsg.videoMessage) {
      tipo = "video";
      esFoto = true;
      texto = innerMsg.videoMessage.caption ? "[Foto] " + innerMsg.videoMessage.caption : "[Foto con musica]";
      registrarMediaEnMapa(id, msg);
      if (innerMsg.videoMessage.jpegThumbnail) {
        try {
          const jpgPath = path.join(photosFolder, `${safeId}.jpg`);
          if (!fs.existsSync(jpgPath)) {
            fs.writeFileSync(jpgPath, Buffer.from(innerMsg.videoMessage.jpegThumbnail));
          }
        } catch (_) {}
      }
    } else if (innerMsg.extendedTextMessage) {
      tipo = "texto";
      texto = innerMsg.extendedTextMessage.text || "";
      if (innerMsg.extendedTextMessage.backgroundArgb) {
        bgArgb = innerMsg.extendedTextMessage.backgroundArgb;
      }
    } else if (innerMsg.conversation) {
      tipo = "texto";
      texto = innerMsg.conversation;
    }

    if (!texto) return;

    const r = (bgArgb >> 16) & 0xFF;
    const g = (bgArgb >> 8) & 0xFF;
    const b = bgArgb & 0xFF;
    const rgb565 = (((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));

    const item = {
      id: id,
      autor: autor,
      participant: participant,
      tipo: tipo,
      texto: texto.substring(0, 160),
      hora: formatearHora(ts),
      timestamp: ts,
      esFoto: esFoto ? 1 : 0,
      bg565: rgb565
    };

    estadosMap.set(id, item);

    if (estadosMap.size > 50) {
      const oldestKey = estadosMap.keys().next().value;
      estadosMap.delete(oldestKey);
    }

    console.log(`[ESTADO] Capturado estado de ${autor} (${tipo}): ${texto.substring(0, 30)}`);
  } catch (err) {
    console.error("[ESTADO] Error procesando estado:", err);
  }
}

function procesarMensaje(msg, esEnVivo = true) {
  if (!msg || !msg.message) return;
  let jid = msg.key?.remoteJid;
  if (!jid) return;
  if (jid === "status@broadcast") {
    procesarEstado(msg, esEnVivo);
    return;
  }
  if (jid.includes("@broadcast")) return;

  // Unificar chat propio dinamicamente sin JIDs hardcodeados
  const myJid = obtenerMiJid();
  if (esChatPropio(jid) && myJid) {
    jid = myJid;
  }

  let innerMsg = msg.message;
  if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
  if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
  if (innerMsg?.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;
  if (innerMsg?.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

  let sId = "";
  if (msg.key?.id && (innerMsg?.stickerMessage || innerMsg?.audioMessage || innerMsg?.imageMessage || innerMsg?.videoMessage)) {
    if (innerMsg?.stickerMessage) {
      sId = indexarStickerEnMapa(msg);
    } else {
      registrarMediaEnMapa(msg.key.id, msg);
    }
    // Precarga asincrona inmediata de stickers a formato RGB565 One UI (Deduplicacion SHA256)
    if (innerMsg?.stickerMessage && sharp && esEnVivo && sId) {
      const rPath = path.join(stickersFolder, `${sId}.raw`);
      const wPath = path.join(stickersFolder, `${sId}.webp`);
      let faltaRaw = !fs.existsSync(rPath);
      if (!faltaRaw) {
        try { faltaRaw = fs.statSync(rPath).size !== 64 * 64 * 2; } catch (_) { faltaRaw = true; }
      }
      if (faltaRaw) {
        const leerODescargar = fs.existsSync(wPath)
          ? Promise.resolve(fs.readFileSync(wPath))
          : downloadMediaMessage(msg, "buffer", {}, {
              logger: pino({ level: "silent" }),
              reuploadRequest: sock?.updateMediaMessage
            });
        leerODescargar.then(async buf => {
          if (!buf) return;
          if (!fs.existsSync(wPath)) {
            try { fs.writeFileSync(wPath, buf); } catch (_) {}
          }
          const rgb565 = await convertirStickerARgb565(buf);
          if (rgb565 && rgb565.length === 64 * 64 * 2) {
            fs.writeFileSync(rPath, rgb565);
            verificarLimpiezaStickersLRU();
          }
        }).catch(() => {});
      }
    }
  }

  // Escudo Anti-Delete: detectar revocacion SOLO si el tipo es REVOKE (type 0)
  const raw = msg.message;
  const proto = raw.protocolMessage || raw.ephemeralMessage?.message?.protocolMessage;
  if (proto && (proto.type === 0 || proto.type === "REVOKE")) {
    const targetId = proto.key?.id;
    if (targetId && messagesCache.has(jid)) {
      const lista = messagesCache.get(jid);
      for (const item of lista) {
        if (item.id === targetId && !item.deleted) {
          item.deleted = true;
          item.text = "[Eliminado] " + item.text;
          if (chatsCache.has(jid)) chatsCache.get(jid).lastMsg = item.text;
          break;
        }
      }
    }
    return;
  }

  const text = extraerTexto(msg.message);
  if (!text) return;

  const fromMe = Boolean(msg.key?.fromMe);
  const rawTs = msg.messageTimestamp;
  const ts = rawTs ? (typeof rawTs === "number" ? rawTs : Number(rawTs.low || rawTs)) : Math.floor(Date.now() / 1000);
  const timeStr = formatearHoraMensaje(ts);
  const timeRel = formatearHora(ts);

  if (!messagesCache.has(jid)) messagesCache.set(jid, []);
  const lista = messagesCache.get(jid);
  const mStatus = msg.status || (fromMe ? 2 : 0);
  const isRead = Boolean(mStatus === 4 || mStatus === 5);
  let durSec = 0;
  let tipoMsg = "texto";
  const msgItemId = msg.key.id;
  if (innerMsg?.audioMessage?.seconds) {
    durSec = Math.round(Number(innerMsg.audioMessage.seconds));
    tipoMsg = "audio";
  } else if (innerMsg?.stickerMessage) {
    tipoMsg = "sticker";
  } else if (innerMsg?.imageMessage) {
    tipoMsg = "foto";
  } else if (innerMsg?.videoMessage) {
    tipoMsg = "video";
    durSec = Math.round(Number(innerMsg.videoMessage.seconds) || 0);
  }
  const pushedItem = {
    id: msgItemId,
    fromMe,
    sender: msg.pushName || (fromMe ? "T\u00fa" : "Contacto"),
    text,
    tipo: tipoMsg,
    time: timeStr,
    timestamp: ts,
    duration: durSec,
    status: mStatus,
    read: isRead
  };
  if (sId) pushedItem.stickerId = sId;
  lista.push(pushedItem);
  if (lista.length > 30) lista.shift();

  // Actualizar chatsCache
  const name = resolverNombre(jid, msg.pushName, fromMe);
  const prevUnread = chatsCache.has(jid) ? chatsCache.get(jid).unread : 0;
  const unread = fromMe ? 0 : (esEnVivo ? prevUnread + 1 : prevUnread);

  const prev = chatsCache.get(jid);
  if (!prev || ts >= (prev.timestamp || 0)) {
    chatsCache.set(jid, {
      id: jid,
      name,
      lastMsg: text,
      time: timeRel,
      unread,
      timestamp: ts,
      fromMe: fromMe,
      visto: fromMe ? false : true
    });
  } else if (prev && (!prev.name || prev.name.startsWith("Contacto WA") || prev.name.startsWith("+"))) {
    prev.name = name;
  }
  programarGuardadoDisco();
}

async function startWhatsApp() {
  if (SKIP_WA) return;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    let version = [2, 3000, 1015901307];
    try {
      const v = await fetchLatestBaileysVersion();
      if (v && v.version) version = v.version;
    } catch (ve) {
      console.log("[Baileys] Usando version default de WA:", version);
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      browser: ["EspOS microPC", "Chrome", "20.0.04"],
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
      getMessage: async (key) => {
        if (!key?.id) return undefined;
        if (allMessagesMap.has(key.id)) {
          return allMessagesMap.get(key.id);
        }
        if (key.remoteJid && messagesCache.has(key.remoteJid)) {
          const m = messagesCache.get(key.remoteJid).find(x => x.id === key.id);
          if (m) return { conversation: m.text };
        }
        for (const list of messagesCache.values()) {
          const m = list.find(x => x.id === key.id);
          if (m) return { conversation: m.text };
        }
        return undefined;
      }
    });

    // Vinculacion LAN por codigo de emparejamiento via CLI (node server_v340.js <telefono>)
    const pairingDigits = (!SKIP_WA && !state.creds.registered && process.argv[2])
      ? String(process.argv[2]).replace(/\D/g, "")
      : "";
    if (pairingDigits.length >= 8) {
      setTimeout(async () => {
        if (sock && !state.creds.registered) {
          try {
            const code = await sock.requestPairingCode(pairingDigits);
            console.log(`[WhatsApp] Pairing Code LAN: ${code}`);
          } catch (pe) {
            console.error("[WhatsApp] Error solicitando Pairing Code:", pe.message);
          }
        }
      }, 3000);
    }

    // ESCUDO TOTAL CONTRA FUGAS DE PRESENCIA EN LINEA (Baileys PushName Bug Fix)
    const rawSendNode = sock.sendNode.bind(sock);
    sock.sendNode = async (node) => {
      if (node && node.tag === "presence") {
        const pType = node.attrs?.type;
        if (!pType || pType === "available") {
          return;
        }
      }
      return rawSendNode(node);
    };

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const estaVinculado = Boolean(myNumber || (sock && sock.user && sock.user.id));
        if (!estaVinculado) {
          rawQR = qr;
          currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
        } else {
          rawQR = "";
          currentQR = "";
        }
        isConnected = false;
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
        console.log(`[WhatsApp] Conexión cerrada (${statusCode}). Reconectando: ${shouldReconnect}`);
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        } else {
          console.log("[WhatsApp] Sesión cerrada formalmente (loggedOut). Purgando credenciales...");
          try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
          rawQR = "";
          currentQR = "";
          setTimeout(startWhatsApp, 2000);
        }
      } else if (connection === "open") {
        isConnected = true;
        currentQR = "";
        rawQR = "";
        myNumber = sock.user.id.split(":")[0].split("@")[0];
        myName = sock.user.name || "Usuario";
        if (sock.user.lid) {
          myLid = sock.user.lid.split(":")[0].split("@")[0] + "@lid";
        }
        const myJid = `${myNumber}@s.whatsapp.net`;
        if (myLid) {
          lidToJid.set(myLid, myJid);
          jidToLid.set(myJid, myLid);
        }
        console.log(`[WhatsApp] Vinculado exitosamente (${myName})`);
        sincronizarGruposReales();
        try {
          const meName = (myName || sock.user?.name || "Usuario").replace(/@/g, "");
          await rawSendNode({
            tag: "presence",
            attrs: {
              name: meName,
              type: "unavailable"
            }
          });
          console.log("[WhatsApp] Modo silencioso activo: presencia offline ('unavailable') forzada con exito.");
        } catch (pe) {
          console.warn("[WhatsApp] No se pudo enviar presencia inicial:", pe.message);
        }
      }
    });

    if (!global.__presenceWatchdog) {
      global.__presenceWatchdog = setInterval(async () => {
        try {
          if (sock && isConnected) {
            const meName = (myName || sock.user?.name || "Usuario").replace(/@/g, "");
            await rawSendNode({
              tag: "presence",
              attrs: {
                name: meName,
                type: "unavailable"
              }
            });
          }
        } catch (_) {}
      }, 5 * 60 * 1000);
    }

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      if (Array.isArray(contacts)) {
        for (const c of contacts) guardarContacto(c);
      }
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m.key?.id && m.message) {
            allMessagesMap.set(m.key.id, m.message);
            if (allMessagesMap.size > 800) {
              const firstKey = allMessagesMap.keys().next().value;
              allMessagesMap.delete(firstKey);
            }
          }
          procesarMensaje(m, false);
        }
      }
      if (Array.isArray(chats)) {
        for (const c of chats) {
          if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
          const alt = lidToJid.get(c.id) || jidToLid.get(c.id);
          const nom = contactsMap.get(c.id) || (alt ? contactsMap.get(alt) : null) || c.name || resolverNombre(c.id, "", false);
          const rawTs = c.conversationTimestamp?.low || c.conversationTimestamp || c.lastMessageRecvTimestamp || c.lastMsgTimestamp || 0;
          const ts = Number(rawTs);
          if (!chatsCache.has(c.id)) {
            chatsCache.set(c.id, {
              id: c.id,
              name: nom,
              lastMsg: "",
              time: ts ? formatearHora(ts) : "",
              unread: c.unreadCount || 0,
              timestamp: ts
            });
          } else {
            const cur = chatsCache.get(c.id);
            if (nom && !nom.startsWith("Contacto WA") && (!cur.name || cur.name.startsWith("Contacto WA"))) {
              cur.name = nom;
            }
          }
        }
      }
      programarGuardadoDisco();
    });

    const onChatsUpdate = (chatsList) => {
      if (!Array.isArray(chatsList)) return;
      for (const c of chatsList) {
        if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
        const rawTs = c.conversationTimestamp?.low || c.conversationTimestamp || c.lastMessageRecvTimestamp || c.lastMsgTimestamp || 0;
        const ts = Number(rawTs);
        const nom = contactsMap.get(c.id) || (c.lid ? contactsMap.get(c.lid) : null) || c.name || resolverNombre(c.id, "", false);
        const prev = chatsCache.get(c.id);
        if (!prev) {
          chatsCache.set(c.id, {
            id: c.id,
            name: nom,
            lastMsg: "",
            time: ts ? formatearHora(ts) : "",
            unread: c.unreadCount || 0,
            timestamp: ts
          });
        } else {
          if (nom && nom !== prev.name && !nom.startsWith("+") && !nom.startsWith("Contacto")) prev.name = nom;
          if (ts > (prev.timestamp || 0)) {
            prev.timestamp = ts;
            prev.time = formatearHora(ts);
          }
          if (typeof c.unreadCount === "number") prev.unread = c.unreadCount;
        }
      }
    };
    sock.ev.on("chats.upsert", onChatsUpdate);
    sock.ev.on("chats.update", onChatsUpdate);

    const onContacts = (list) => {
      for (const c of list) {
        guardarContacto(c);
        const nom = resolverNombre(c.id, c.notify || c.verifiedName, false);
        if (c && nom && nom !== myName) {
          if (chatsCache.has(c.id)) chatsCache.get(c.id).name = nom;
          if (c.lid && chatsCache.has(c.lid)) chatsCache.get(c.lid).name = nom;
        }
        if (c && c.id) {
          const safeId = c.id.replace(/[^a-zA-Z0-9]/g, "_");
          try { if (fs.existsSync(path.join(avatarsFolder, `${safeId}.raw`))) fs.unlinkSync(path.join(avatarsFolder, `${safeId}.raw`)); } catch (_) {}
          if (c.lid) {
            const safeLid = c.lid.replace(/[^a-zA-Z0-9]/g, "_");
            try { if (fs.existsSync(path.join(avatarsFolder, `${safeLid}.raw`))) fs.unlinkSync(path.join(avatarsFolder, `${safeLid}.raw`)); } catch (_) {}
          }
        }
      }
    };
    sock.ev.on("contacts.upsert", onContacts);
    sock.ev.on("contacts.update", onContacts);

    sock.ev.on("groups.update", async (updates) => {
      for (const u of updates) {
        if (u?.id) {
          groupMetaCache.delete(u.id);
          const safeId = u.id.replace(/[^a-zA-Z0-9]/g, "_");
          try { if (fs.existsSync(path.join(avatarsFolder, `${safeId}.raw`))) fs.unlinkSync(path.join(avatarsFolder, `${safeId}.raw`)); } catch (_) {}
        }
      }
    });
    sock.ev.on("group-participants.update", async (update) => {
      if (update?.id) groupMetaCache.delete(update.id);
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages) {
        if (m.key?.id && m.message) {
          allMessagesMap.set(m.key.id, m.message);
          if (allMessagesMap.size > 800) {
            const firstKey = allMessagesMap.keys().next().value;
            allMessagesMap.delete(firstKey);
          }
        }
        procesarMensaje(m, true);
      }
    });

    sock.ev.on("presence.update", ({ id, presences }) => {
      if (!presences) return;
      for (const [sender, p] of Object.entries(presences)) {
        const j = id || sender;
        const st = p.lastKnownPresence;
        const cur = presenceMap.get(j) || {};
        cur.status = st;
        if (st === "available" || st === "composing" || st === "recording") {
          cur.t = Date.now();
        } else if (st === "unavailable") {
          cur.t = 0;
          if (p.lastSeen) {
            const ls = Number(p.lastSeen);
            cur.lastSeen = ls < 2000000000 ? ls * 1000 : ls;
          } else {
            cur.lastSeen = null;
          }
        }
        presenceMap.set(j, cur);
        const alt = lidToJid.get(j) || jidToLid.get(j);
        if (alt) presenceMap.set(alt, cur);
      }
    });

    sock.ev.on("messages.update", (updates) => {
      for (const u of updates) {
        const jid = u.key?.remoteJid;
        const mid = u.key?.id;
        if (!jid || !mid) continue;
        const st = u.update?.status;
        if (messagesCache.has(jid)) {
          for (const item of messagesCache.get(jid)) {
            if (item.id === mid) {
              if (typeof st === "number") item.status = st;
              if (st === 4 || st === 5) item.read = true;
              break;
            }
          }
        }
        if (chatsCache.has(jid) && (st === 4 || st === 5)) {
          chatsCache.get(jid).visto = true;
        }
      }
    });

    sock.ev.on("call", (calls) => {
      for (const c of calls) {
        const ts = c.date ? Math.floor(new Date(c.date).getTime() / 1000) : Math.floor(Date.now() / 1000);
        const cid = c.chatId || c.from;
        const name = contactsMap.get(cid) || resolverNombre(cid, "", false);
        callsList.unshift({
          id: c.id,
          chatId: cid,
          name,
          time: formatearHora(ts),
          status: c.status,
          isVideo: Boolean(c.isVideo)
        });
        if (callsList.length > 20) callsList.pop();
      }
      if (calls.length > 0) programarGuardadoDisco();
    });
  } catch (err) {
    console.error("[WhatsApp] Error critico en startWhatsApp:", err);
    setTimeout(startWhatsApp, 3000);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || "/";

  // Cabeceras de seguridad obligatorias en todas las respuestas (sin CORS *)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (pathname.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  }

  // Guardia Fail-Closed + Rate Limiter en todos los endpoints /api/*
  if (pathname.startsWith("/api/")) {
    const clientIp = obtenerIpCliente(req);
    if (estaBloqueadaIp(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Too Many Requests" }));
    }
    if (!EXPECTED_KEY_HASH) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Service Unavailable" }));
    }
    if (!verificarApiKey(req)) {
      registrarFalloAuth(clientIp);
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }
    failedAuthByIp.delete(clientIp);
  }

  // Dashboard minimalista sin exposicion de PII, estado de chats ni QR
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml("EspOS Bridge")}</title></head><body style="background:#090d12;color:#e2e8f0;text-align:center;padding:48px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #1e293b;"><h2>${escapeHtml("EspOS Bridge Service — Active")}</h2></div></body></html>`);
  }

  // Renombrar contacto (POST JSON { chat, nombre } o GET query)
  if (pathname === "/api/contacto/renombrar" && (req.method === "POST" || req.method === "GET")) {
    let cJid = "";
    let cNom = "";
    if (req.method === "POST") {
      let bodyBuf;
      try {
        bodyBuf = await leerBodySeguro(req, 32 * 1024);
      } catch (err) {
        return responderErrorBody(res, req, err);
      }
      try {
        const parsed = JSON.parse(bodyBuf.toString("utf8") || "{}");
        cJid = typeof parsed.chat === "string" ? parsed.chat.trim() : "";
        cNom = typeof parsed.nombre === "string" ? parsed.nombre.trim() : "";
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "JSON invalido" }));
      }
    } else {
      cJid = typeof parsedUrl.query.chat === "string" ? parsedUrl.query.chat.trim() : "";
      cNom = typeof parsedUrl.query.nombre === "string" ? parsedUrl.query.nombre.trim() : "";
    }
    if (cJid && cNom) {
      agendaMap.set(cJid, cNom);
      const altJid = lidToJid.get(cJid) || jidToLid.get(cJid);
      if (altJid) agendaMap.set(altJid, cNom);
      if (chatsCache.has(cJid)) chatsCache.get(cJid).name = cNom;
      if (altJid && chatsCache.has(altJid)) chatsCache.get(altJid).name = cNom;
      programarGuardadoDisco();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, jid: cJid, nombre: cNom }));
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Faltan parametros chat y nombre" }));
  }

  if (pathname === "/api/status" && req.method === "GET") {
    const estaVinculado = Boolean(myNumber || (sock && sock.user && sock.user.id));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      vinculado: estaVinculado,
      estado: isConnected ? "conectado" : (estaVinculado ? "reconectando" : "esperando_qr"),
      usuario: myName,
      numero: myNumber,
      miLid: myLid,
      totalChats: chatsCache.size,
      qr: (isConnected || estaVinculado) ? "" : (rawQR || "")
    }));
  }

  // Endpoints destructivos protegidos: solo POST + confirm: true
  if (pathname === "/api/limpiar" || pathname === "/api/vaciar_cache") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }
    let bodyBuf;
    try {
      bodyBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    let body = null;
    try { body = JSON.parse(bodyBuf.toString("utf8") || "{}"); } catch (_) {}
    if (!body || body.confirm !== true) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Se requiere confirm: true" }));
    }
    messagesCache.clear();
    try {
      if (fs.existsSync(stickersFolder)) {
        const files = fs.readdirSync(stickersFolder);
        for (const f of files) {
          try { fs.unlinkSync(path.join(stickersFolder, f)); } catch (_) {}
        }
      }
    } catch (_) {}
    programarGuardadoDisco();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mensaje: "Cache de mensajes y stickers vaciado con exito (solo 30 ultimos activos)" }));
  }

  if (pathname === "/api/reset_auth" || pathname === "/api/reset") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }
    let bodyBuf;
    try {
      bodyBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    let body = null;
    try { body = JSON.parse(bodyBuf.toString("utf8") || "{}"); } catch (_) {}
    if (!body || body.confirm !== true) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Se requiere confirm: true" }));
    }
    try {
      if (sock) {
        try { sock.end(); } catch (_) {}
        sock = null;
      }
      isConnected = false;
      rawQR = "";
      currentQR = "";
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
      }
      if (!SKIP_WA) setTimeout(startWhatsApp, 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, mensaje: "Sesion reiniciada limpiamente. Generando nuevo QR..." }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (pathname === "/api/limpiar_sesiones_e2ee") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }
    let bodyBuf;
    try {
      bodyBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    let body = null;
    try { body = JSON.parse(bodyBuf.toString("utf8") || "{}"); } catch (_) {}
    if (!body || body.confirm !== true) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Se requiere confirm: true" }));
    }
    let eliminados = 0;
    try {
      if (fs.existsSync(authFolder)) {
        const files = fs.readdirSync(authFolder);
        for (const file of files) {
          if (file.startsWith("session-") || file.startsWith("pre-key-")) {
            fs.unlinkSync(path.join(authFolder, file));
            eliminados++;
          }
        }
      }
      if (sock) {
        try { sock.end(); } catch (_) {}
      }
      if (!SKIP_WA) setTimeout(startWhatsApp, 1500);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        archivosEliminados: eliminados,
        mensaje: "Sesiones E2EE limpiadas con exito. creds.json conservado. Reiniciando handshake..."
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // Endpoint de diagnostico saneado (sin PII ni dump de sesiones)
  if (pathname === "/api/diag" && req.method === "GET") {
    let authFiles = [];
    try {
      if (fs.existsSync(authFolder)) {
        authFiles = fs.readdirSync(authFolder);
      }
    } catch (e) {}
    const sessionFiles = authFiles.filter(f => f.startsWith("session-"));
    const prekeyFiles = authFiles.filter(f => f.startsWith("pre-key-"));
    const estaVinculado = Boolean(myNumber || (sock && sock.user && sock.user.id));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      version: "3.4.0",
      uptime: Math.round(process.uptime()),
      connected: isConnected,
      vinculado: estaVinculado,
      authFolderExists: fs.existsSync(authFolder),
      credsExists: fs.existsSync(path.join(authFolder, "creds.json")),
      sessionFilesCount: sessionFiles.length,
      prekeyFilesCount: prekeyFiles.length,
      allMessagesMapSize: allMessagesMap.size,
      groupsCached: groupMetaCache.size
    }));
  }

  // API Estados de WhatsApp (Novedades / Historias)
  if (pathname === "/api/estados" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const list = Array.from(estadosMap.values()).sort((a, b) => b.timestamp - a.timestamp);
    return res.end(JSON.stringify({ ok: true, total: list.length, estados: list }));
  }

  // Publicar estado de texto en WhatsApp (POST /api/estado)
  if (pathname === "/api/estado") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }
    let bodyBuf;
    try {
      bodyBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyBuf.toString("utf8") || "{}");
    } catch (_) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "JSON invalido" }));
    }
    const texto = typeof parsed.texto === "string" ? parsed.texto.trim() : "";
    if (texto.length < 1 || texto.length > 500) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "texto debe tener entre 1 y 500 caracteres" }));
    }
    if (!sock || !isConnected) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "WhatsApp no conectado" }));
    }
    const bgColor = (typeof parsed.color === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.color.trim()))
      ? parsed.color.trim()
      : "#075E54";
    try {
      const sent = await sock.sendMessage("status@broadcast", { text: texto }, { backgroundColor: bgColor, font: 0 });
      const id = sent?.key?.id || ("st_" + Date.now());
      const ts = Math.floor(Date.now() / 1000);
      const hex = bgColor.slice(1);
      const r = parseInt(hex.slice(0, 2), 16) || 7;
      const g = parseInt(hex.slice(2, 4), 16) || 94;
      const b = parseInt(hex.slice(4, 6), 16) || 84;
      const bg565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);

      estadosMap.set(id, {
        id,
        autor: "Tú",
        participant: obtenerMiJid() || "me",
        tipo: "texto",
        texto: texto.substring(0, 160),
        hora: formatearHora(ts),
        timestamp: ts,
        esFoto: 0,
        bg565
      });
      if (estadosMap.size > 50) {
        const oldestKey = estadosMap.keys().next().value;
        estadosMap.delete(oldestKey);
      }
      programarGuardadoDisco();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    for (const [jid, mList] of messagesCache.entries()) {
      if (Array.isArray(mList) && mList.length > 0) {
        const ult = mList[mList.length - 1];
        if (ult) {
          const c = chatsCache.get(jid) || { id: jid, name: contactsMap.get(jid) || resolverNombre(jid, "", false), unread: 0 };
          const ultTs = Number(ult.timestamp) || 0;
          const curTs = Number(c.timestamp) || 0;
          if (ultTs >= curTs || !c.lastMsg) {
            if (ult.text && !ult.text.includes("Conversaci") && !ult.text.includes("Toca para")) {
              c.lastMsg = ult.text;
            }
            if (ult.time) c.time = ult.time;
            if (ultTs > 0) c.timestamp = ultTs;
            c.fromMe = Boolean(ult.fromMe);
          }
          chatsCache.set(jid, c);
        }
      }
    }

    const myJid = obtenerMiJid();
    if (myJid && myLid && myLid !== myJid) {
      if (chatsCache.has(myLid)) {
        const cLid = chatsCache.get(myLid);
        const cJid = chatsCache.get(myJid);
        if (cJid && cLid) {
          if ((Number(cLid.timestamp) || 0) >= (Number(cJid.timestamp) || 0)) {
            cJid.lastMsg = cLid.lastMsg;
            cJid.time = cLid.time;
            cJid.timestamp = cLid.timestamp;
            cJid.fromMe = cLid.fromMe;
          }
        } else if (!cJid && cLid) {
          cLid.id = myJid;
          cLid.name = "Mensajes Guardados (Tú)";
          chatsCache.set(myJid, cLid);
        }
        chatsCache.delete(myLid);
      }
      if (messagesCache.has(myLid)) {
        const msgsLid = messagesCache.get(myLid) || [];
        const msgsJid = messagesCache.get(myJid) || [];
        const ids = new Set(msgsJid.map(m => m.id));
        for (const m of msgsLid) {
          if (!ids.has(m.id)) {
            msgsJid.push(m);
            ids.add(m.id);
          }
        }
        msgsJid.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        while (msgsJid.length > 50) msgsJid.shift();
        messagesCache.set(myJid, msgsJid);
        messagesCache.delete(myLid);
      }
    }
    if (myJid && chatsCache.has(myJid)) {
      chatsCache.get(myJid).name = "Mensajes Guardados (Tú)";
    }

    const vistosJid = new Set();
    const vistaPorNombre = new Map(); // nom -> id
    const sorted = Array.from(chatsCache.values())
      .filter(c => c && c.id)
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

    // Primer paso: auto-asociar pares JID <-> LID que compartan nombre de agenda
    for (const c of sorted) {
      const isPersonal = !c.id.endsWith("@g.us") && !c.id.endsWith("@newsletter");
      const nom = (c.name || "").trim().toLowerCase();
      if (isPersonal && nom.length >= 3 && !nom.startsWith("contacto wa") && !nom.startsWith("+")) {
        for (const c2 of sorted) {
          if (c.id !== c2.id) {
            const nom2 = (c2.name || "").trim().toLowerCase();
            if (nom === nom2) {
              const jidEntry = c.id.endsWith("@s.whatsapp.net") ? c.id : (c2.id.endsWith("@s.whatsapp.net") ? c2.id : null);
              const lidEntry = c.id.endsWith("@lid") ? c.id : (c2.id.endsWith("@lid") ? c2.id : null);
              if (jidEntry && lidEntry) {
                lidToJid.set(lidEntry, jidEntry);
                jidToLid.set(jidEntry, lidEntry);
              }
            }
          }
        }
      }
    }

    const list = [];
    for (const c of sorted) {
      const esLidSinMensajes = c.id.endsWith("@lid") && (!c.lastMsg || c.lastMsg === "") && (!c.name || c.name.startsWith("Contacto WA"));
      if (esLidSinMensajes) continue;
      const alt = lidToJid.get(c.id) || jidToLid.get(c.id);
      const realNom = contactsMap.get(c.id) || (alt ? contactsMap.get(alt) : null);
      if (realNom && !realNom.startsWith("Contacto WA") && !realNom.startsWith("Comunidad #")) {
        c.name = realNom;
      }
      if (c.lastMsg && (c.lastMsg.includes("Toca para abrir") || c.lastMsg.includes("Conversaci"))) {
        c.lastMsg = "";
      }

      if (!c.lastMsg || c.lastMsg === "") {
        const mList = messagesCache.get(c.id) || (alt ? messagesCache.get(alt) : null);
        if (mList && mList.length > 0) {
          const ult = mList[mList.length - 1];
          if (ult && ult.text && !ult.text.includes("Conversaci") && !ult.text.includes("Toca para")) {
            c.lastMsg = ult.text;
            c.time = ult.time || c.time;
            c.timestamp = ult.timestamp || c.timestamp;
            c.fromMe = Boolean(ult.fromMe);
          }
        }
      }

      const peer = lidToJid.get(c.id) || jidToLid.get(c.id) || c.id;
      if (vistosJid.has(peer) || vistosJid.has(c.id)) continue;

      // Deduplicacion estricta por nombre: solo fusionar si uno es @lid y el otro @s.whatsapp.net
      const isPersonal = !c.id.endsWith("@g.us") && !c.id.endsWith("@newsletter");
      const nom = (c.name || "").trim().toLowerCase();
      const esNombreValido = isPersonal && nom.length >= 3 &&
                             !nom.startsWith("contacto wa") &&
                             !nom.startsWith("+") &&
                             !nom.startsWith("comunidad");
      if (esNombreValido && vistaPorNombre.has(nom)) {
        const prevId = vistaPorNombre.get(nom);
        const esParLidJid = (prevId.endsWith("@lid") && c.id.endsWith("@s.whatsapp.net")) ||
                            (prevId.endsWith("@s.whatsapp.net") && c.id.endsWith("@lid"));
        if (esParLidJid) continue;
      }

      vistosJid.add(peer);
      vistosJid.add(c.id);
      if (esNombreValido && !vistaPorNombre.has(nom)) {
        vistaPorNombre.set(nom, c.id);
      }

      if (c.id.endsWith("@newsletter")) {
        c.esCanal = true;
        c.soloAdmins = true;
      }
      if (c.id.endsWith("@g.us")) {
        c.esGrupo = true;
        if (groupMetaCache.has(c.id)) {
          c.soloAdmins = groupMetaCache.get(c.id).soloAdmins;
        } else {
          c.soloAdmins = false;
          obtenerPermisosGrupo(c.id).catch(() => {});
        }
      }
      list.push(c);
      if (list.length >= 50) break;
    }

    const estaVinculado = Boolean(myNumber || (sock && sock.user && sock.user.id));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      vinculado: estaVinculado,
      estado: isConnected ? "conectado" : (estaVinculado ? "reconectando" : "esperando_qr"),
      usuario: myName,
      numero: myNumber,
      miLid: myLid,
      totalChats: chatsCache.size,
      qr: (isConnected || estaVinculado) ? "" : (rawQR || ""),
      chats: list,
      llamadas: callsList
    }));
  }

  if (pathname === "/api/mensajes" && req.method === "GET") {
    let chatJid = typeof parsedUrl.query.chat === "string" ? parsedUrl.query.chat.trim() : "";
    if (!chatJid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Falta parametro chat" }));
    }
    const myJid = obtenerMiJid();
    if (esChatPropio(chatJid) && myJid) {
      chatJid = myJid;
    }
    if (sock && chatJid) {
      sock.presenceSubscribe(chatJid).catch(() => {});
      const altJid = lidToJid.get(chatJid) || jidToLid.get(chatJid);
      if (altJid) sock.presenceSubscribe(altJid).catch(() => {});
    }

    let msgs = [...(messagesCache.get(chatJid) || [])];
    const alt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
    if (msgs.length === 0 && alt && messagesCache.has(alt)) {
      msgs = [...messagesCache.get(alt)];
    }
    if (msgs.length === 0 && chatsCache.has(chatJid)) {
      const cNom = (chatsCache.get(chatJid).name || "").trim().toLowerCase();
      if (cNom.length >= 3 && !cNom.startsWith("contacto wa") && !cNom.startsWith("+")) {
        for (const [otherJid, otherChat] of chatsCache.entries()) {
          if (otherJid !== chatJid && (otherChat.name || "").trim().toLowerCase() === cNom) {
            const esParLidJid = (otherJid.endsWith("@lid") && chatJid.endsWith("@s.whatsapp.net")) ||
                                (otherJid.endsWith("@s.whatsapp.net") && chatJid.endsWith("@lid"));
            if (esParLidJid && messagesCache.has(otherJid) && messagesCache.get(otherJid).length > 0) {
              msgs = [...messagesCache.get(otherJid)];
              lidToJid.set(chatJid, otherJid);
              jidToLid.set(otherJid, chatJid);
              break;
            }
          }
        }
      }
    }
    const info = chatsCache.get(chatJid) || (alt ? chatsCache.get(alt) : null);
    if (info && info.lastMsg && !info.lastMsg.includes("Conversaci") && !info.lastMsg.includes("Toca para")) {
      const lastMsgTs = (msgs.length > 0 && msgs[msgs.length - 1].timestamp) ? Number(msgs[msgs.length - 1].timestamp) : 0;
      const infoTs = Number(info.timestamp || 0);

      if (msgs.length === 0 || (infoTs > 0 && infoTs > lastMsgTs)) {
        const fm = Boolean(info.fromMe);
        msgs.push({
          id: "latest_" + (infoTs || Date.now()),
          fromMe: fm,
          sender: fm ? (myName || "Tú") : (info.name || "Contacto"),
          text: info.lastMsg,
          time: info.time || "",
          timestamp: infoTs || Math.floor(Date.now() / 1000),
          read: true
        });
      }
    }
    if (chatsCache.has(chatJid)) chatsCache.get(chatJid).unread = 0;

    const mapMsg = new Map();
    for (const m of msgs) {
      if (m && m.id) mapMsg.set(m.id, m);
    }
    msgs = Array.from(mapMsg.values()).sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    if (msgs.length > 30) {
      msgs = msgs.slice(-30);
    }

    let presStr = "";
    if (!chatJid.endsWith("@g.us") && !chatJid.endsWith("@newsletter")) {
      const pAlt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
      const pInfo = presenceMap.get(chatJid) || (pAlt ? presenceMap.get(pAlt) : null);
      if (pInfo) {
        if (pInfo.status === "composing") {
          presStr = "Escribiendo...";
        } else if (pInfo.status === "recording") {
          presStr = "Grabando audio...";
        } else if (pInfo.status === "available" && pInfo.t > 0 && (Date.now() - pInfo.t < 35000)) {
          presStr = "En linea";
        } else if (pInfo.lastSeen) {
          presStr = formatearUltimaVez(pInfo.lastSeen);
        }
      }
    }
    let restringido = false;
    if (chatJid.endsWith("@newsletter")) {
      restringido = true;
    } else if (chatJid.endsWith("@g.us")) {
      restringido = await obtenerPermisosGrupo(chatJid);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chat: chatJid, presencia: presStr, soloAdmins: Boolean(restringido), mensajes: msgs }));
  }

  // Endpoint de Avatares Nativo One UI: entrega 42x42 RGB565 (3528 bytes) exactos
  if (pathname === "/api/avatar" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    const forzar = parsedUrl.query.force === "1";
    if (!chatJid || !sock) {
      res.writeHead(400); return res.end();
    }
    try {
      const safeId = chatJid.replace(/[^a-zA-Z0-9]/g, "_");
      const rawPath = path.join(avatarsFolder, `${safeId}.raw`);

      if (!forzar && fs.existsSync(rawPath)) {
        try {
          const st = fs.statSync(rawPath);
          const edadMs = Date.now() - st.mtimeMs;
          if (edadMs < 12 * 3600 * 1000) {
            const rawBuf = fs.readFileSync(rawPath);
            if (rawBuf.length === 42 * 42 * 2) {
              res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": rawBuf.length
              });
              return res.end(rawBuf);
            }
          }
        } catch (_) {}
      }

      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
      ]);
      let ppUrl = await withTimeout(sock.profilePictureUrl(chatJid, "image"), 2500).catch(() => null);
      if (!ppUrl) {
        const alt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
        if (alt) ppUrl = await withTimeout(sock.profilePictureUrl(alt, "image"), 2500).catch(() => null);
      }
      if (!ppUrl) {
        try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (_) {}
        res.writeHead(404); return res.end();
      }

      const imgRes = await fetch(ppUrl);
      if (!imgRes.ok) {
        res.writeHead(404); return res.end();
      }
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

      if (sharp) {
        const { data } = await sharp(imgBuffer)
          .resize(42, 42, { fit: "cover" })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const rgb565Buf = Buffer.alloc(42 * 42 * 2);
        for (let i = 0; i < 42 * 42; i++) {
          const r = data[i * 3];
          const g = data[i * 3 + 1];
          const b = data[i * 3 + 2];
          const c565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
          rgb565Buf.writeUInt16LE(c565, i * 2);
        }

        try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (_) {}
        fs.writeFileSync(rawPath, rgb565Buf);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": rgb565Buf.length
        });
        return res.end(rgb565Buf);
      }

      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(imgBuffer);
    } catch (e) {
      console.log(`[Avatar] Error al procesar ${chatJid}:`, e.message);
      res.writeHead(500); return res.end();
    }
  }

  if (pathname === "/api/sticker" && req.method === "GET") {
    const msgId = typeof parsedUrl.query.id === "string" ? parsedUrl.query.id.trim() : "";
    if (!msgId) { res.writeHead(400); return res.end(); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const rawPath = path.join(stickersFolder, `${safeId}.raw`);
      const webpPath = path.join(stickersFolder, `${safeId}.webp`);
      if (fs.existsSync(rawPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        if (rawBuf.length === 64 * 64 * 2) {
          try { const now = new Date(); fs.utimesSync(rawPath, now, now); } catch (_) {}
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rawBuf.length
          });
          return res.end(rawBuf);
        }
        try { fs.unlinkSync(rawPath); } catch (_) {}
      }

      const rawMsg = rawMediaMap.get(msgId) || rawMediaMap.get(safeId);
      const innerStk = rawMsg ? extraerMensajeInterno(rawMsg)?.stickerMessage : null;
      const canonId = innerStk ? extraerStickerId(innerStk, rawMsg?.key?.id || safeId) : "";

      if (canonId && canonId !== safeId) {
        const canonRawPath = path.join(stickersFolder, `${canonId}.raw`);
        if (fs.existsSync(canonRawPath)) {
          const canonBuf = fs.readFileSync(canonRawPath);
          if (canonBuf.length === 64 * 64 * 2) {
            try { const now = new Date(); fs.utimesSync(canonRawPath, now, now); } catch (_) {}
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": canonBuf.length
            });
            return res.end(canonBuf);
          }
          try { fs.unlinkSync(canonRawPath); } catch (_) {}
        }
      }

      let mediaBuf = null;
      if (fs.existsSync(webpPath)) {
        try {
          const buf = fs.readFileSync(webpPath);
          if (buf.length > 0) mediaBuf = buf;
        } catch (_) {}
      }
      if (!mediaBuf && canonId && canonId !== safeId) {
        const canonWebpPath = path.join(stickersFolder, `${canonId}.webp`);
        if (fs.existsSync(canonWebpPath)) {
          try {
            const buf = fs.readFileSync(canonWebpPath);
            if (buf.length > 0) mediaBuf = buf;
          } catch (_) {}
        }
      }

      if (!mediaBuf) {
        if (!rawMsg) { res.writeHead(404); return res.end("Sticker no en memoria"); }
        if (!sharp) { res.writeHead(503); return res.end("Sharp no disponible"); }
        mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock?.updateMediaMessage
        });
        if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }
        try { fs.writeFileSync(webpPath, mediaBuf); } catch (_) {}
        if (canonId && canonId !== safeId) {
          try { fs.writeFileSync(path.join(stickersFolder, `${canonId}.webp`), mediaBuf); } catch (_) {}
        }
      } else if (!sharp) {
        res.writeHead(503);
        return res.end("Sharp no disponible");
      }

      const rgb565 = await convertirStickerARgb565(mediaBuf);
      if (!rgb565 || rgb565.length !== 64 * 64 * 2) {
        res.writeHead(500);
        return res.end();
      }
      fs.writeFileSync(rawPath, rgb565);
      if (canonId && canonId !== safeId) {
        try { fs.writeFileSync(path.join(stickersFolder, `${canonId}.raw`), rgb565); } catch (_) {}
      }
      verificarLimpiezaStickersLRU();
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": rgb565.length
      });
      return res.end(rgb565);
    } catch (se) {
      console.error("[Sticker] Error procesando sticker:", se.message);
      res.writeHead(500); return res.end();
    }
  }

  // Endpoint de QR para vinculacion nativa en pantalla ESP32
  if (pathname === "/api/qr" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      qr: isConnected ? "" : (rawQR || "")
    }));
  }

  if (pathname === "/api/foto" && req.method === "GET") {
    const msgId = parsedUrl.query.id;
    const modo = parsedUrl.query.modo || "full";
    if (!msgId) { res.writeHead(400); return res.end("Falta id"); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const rawPath = path.join(photosFolder, `${safeId}_${modo}.raw`);
      const jpgPath = path.join(photosFolder, `${safeId}.jpg`);

      if (modo === "jpg" && fs.existsSync(jpgPath)) {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        return fs.createReadStream(jpgPath).pipe(res);
      }

      if (modo === "full" && fs.existsSync(rawPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        if (rawBuf.length === 480 * 320 * 2) {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rawBuf.length
          });
          return res.end(rawBuf);
        }
      }

      let mediaBuf = null;
      if (fs.existsSync(jpgPath)) {
        try { mediaBuf = fs.readFileSync(jpgPath); } catch (_) {}
      }
      const rawMsg = rawMediaMap.get(msgId);
      if (!mediaBuf && !rawMsg) { res.writeHead(404); return res.end("Foto no en memoria ni en disco"); }
      if (!sharp) { res.writeHead(503); return res.end("Sharp no disponible"); }

      let inner = rawMsg.message;
      if (inner?.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
      if (inner?.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
      if (inner?.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
      if (inner?.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;

      if (!mediaBuf && inner?.videoMessage?.jpegThumbnail) {
        mediaBuf = Buffer.from(inner.videoMessage.jpegThumbnail);
      } else if (inner?.imageMessage?.jpegThumbnail && !sock) {
        mediaBuf = Buffer.from(inner.imageMessage.jpegThumbnail);
      } else {
        try {
          mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock?.updateMediaMessage
          });
        } catch (e) {
          if (inner?.videoMessage?.jpegThumbnail) {
            mediaBuf = Buffer.from(inner.videoMessage.jpegThumbnail);
          } else if (inner?.imageMessage?.jpegThumbnail) {
            mediaBuf = Buffer.from(inner.imageMessage.jpegThumbnail);
          }
        }
      }

      if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }

      if (!fs.existsSync(jpgPath) || modo === "jpg") {
        const jpgBuf = await sharp(mediaBuf)
          .resize(480, 320, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85, progressive: false })
          .toBuffer();
        fs.writeFileSync(jpgPath, jpgBuf);
        if (modo === "jpg") {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": jpgBuf.length
          });
          return res.end(jpgBuf);
        }
      }

      const resObj = await sharp(mediaBuf)
        .resize(480, 320, { fit: "contain", background: { r: 9, g: 13, b: 18, alpha: 1 } })
        .flatten({ background: { r: 9, g: 13, b: 18 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const data = resObj.data;
      const channels = resObj.info.channels || 3;
      const rgb565 = Buffer.alloc(480 * 320 * 2);
      for (let i = 0; i < 480 * 320; i++) {
        const r = data[i * channels];
        const g = data[i * channels + 1];
        const b = data[i * channels + 2];
        const c16 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
        rgb565.writeUInt16LE(c16, i * 2);
      }

      fs.writeFileSync(rawPath, rgb565);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": rgb565.length
      });
      return res.end(rgb565);
    } catch (fe) {
      console.log(`[Foto] Error al procesar ${msgId}:`, fe.message);
      res.writeHead(500);
      return res.end();
    }
  }

  // Endpoint de Audios / Notas de Voz: entrega 16 kHz Mono WAV PCM
  if (pathname === "/api/audio" && req.method === "GET") {
    const msgId = parsedUrl.query.id;
    if (!msgId) { res.writeHead(400); return res.end(); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const wavPath = path.join(audioFolder, `${safeId}.wav`);
      if (fs.existsSync(wavPath)) {
        const wavStat = fs.statSync(wavPath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wavStat.size
        });
        const stream = fs.createReadStream(wavPath);
        return stream.pipe(res);
      }
      const rawMsg = rawMediaMap.get(msgId);
      if (!rawMsg) { res.writeHead(404); return res.end("Audio no en memoria"); }

      const mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock?.updateMediaMessage
      });
      if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }

      const oggPath = path.join(audioFolder, `${safeId}.ogg`);
      fs.writeFileSync(oggPath, mediaBuf);

      execFile("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], (err) => {
        try { fs.unlinkSync(oggPath); } catch (e) {}
        if (err || !fs.existsSync(wavPath)) {
          console.error("[Audio] Error transcoding con ffmpeg:", err?.message);
          res.writeHead(500); return res.end("Fallo transcodificacion");
        }
        const wavStat = fs.statSync(wavPath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wavStat.size
        });
        const stream = fs.createReadStream(wavPath);
        stream.pipe(res);
      });
      return;
    } catch (ae) {
      console.error("[Audio] Error procesando audio:", ae.message);
      res.writeHead(500); return res.end();
    }
  }

  // API Enviar mensaje (limite 32 KB streaming)
  if (pathname === "/api/enviar" && req.method === "POST") {
    let bodyBuf;
    try {
      bodyBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    try {
      let { chat, texto } = JSON.parse(bodyBuf.toString("utf8"));
      const myJid = obtenerMiJid();
      if (esChatPropio(chat)) {
        chat = sock?.user?.id ? jidNormalizedUser(sock.user.id) : myJid;
      } else if (chat) {
        chat = jidNormalizedUser(chat);
      }

      if (!chat || !texto || !sock) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "Parametros invalidos o WhatsApp no conectado" }));
      }

      if (chat.endsWith("@g.us")) {
        const restringido = await obtenerPermisosGrupo(chat);
        if (restringido) {
          res.writeHead(403, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "Solo administradores pueden enviar mensajes en este grupo" }));
        }
      }
      let sent;
      let isStk = false;
      let rawStkParam = "";
      let stkId = "";
      const stkMatch = (typeof texto === "string") ? texto.match(/^\[Sticker:(.+)\]$/) : null;
      if (stkMatch) {
        isStk = true;
        rawStkParam = stkMatch[1].trim();
        stkId = rawStkParam.replace(/[^a-zA-Z0-9_-]/g, "_");
        if (stkId) {
          const webpPath = path.join(stickersFolder, `${stkId}.webp`);
          const rawPath = path.join(stickersFolder, `${stkId}.raw`);
          if (fs.existsSync(webpPath)) {
            try {
              const cachedWebp = fs.readFileSync(webpPath);
              if (cachedWebp.length > 0) {
                sent = await sock.sendMessage(chat, { sticker: cachedWebp });
              }
            } catch (_) {}
          }
          if (!sent) {
            const rawMsg = rawMediaMap.get(rawStkParam) || rawMediaMap.get(stkId);
            if (rawMsg) {
              try {
                const mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
                  logger: pino({ level: "silent" }),
                  reuploadRequest: sock?.updateMediaMessage
                });
                if (mediaBuf && mediaBuf.length > 0) {
                  try { fs.writeFileSync(webpPath, mediaBuf); } catch (_) {}
                  sent = await sock.sendMessage(chat, { sticker: mediaBuf });
                }
              } catch (_) {}
            }
          }
          if (!sent && fs.existsSync(rawPath) && sharp) {
            try {
              const rawBuf = fs.readFileSync(rawPath);
              const webpBuf = await convertirRawAWebp(rawBuf);
              if (webpBuf) {
                try { fs.writeFileSync(webpPath, webpBuf); } catch (_) {}
                sent = await sock.sendMessage(chat, { sticker: webpBuf });
              }
            } catch (_) {}
          }
        }
        if (!sent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "Sticker no disponible en servidor" }));
        }
      } else {
        sent = await sock.sendMessage(chat, { text: texto });
      }
      const displayTxt = isStk ? "[Sticker]" : texto;
      const sentMsgId = sent?.key?.id || ((isStk ? "stkmsg_" : "msg_") + Date.now());
      if (sent?.key?.id) {
        allMessagesMap.set(sent.key.id, sent.message || (isStk ? { stickerMessage: {} } : { conversation: texto }));
      }
      if (isStk && sent) {
        const sentSId = indexarStickerEnMapa(sent, rawStkParam ? [rawStkParam, stkId, sentMsgId] : [stkId, sentMsgId]);
        if (sentSId && sentSId !== stkId) {
          const srcWebp = path.join(stickersFolder, `${stkId}.webp`);
          const dstWebp = path.join(stickersFolder, `${sentSId}.webp`);
          if (fs.existsSync(srcWebp) && !fs.existsSync(dstWebp)) {
            try { fs.copyFileSync(srcWebp, dstWebp); } catch (_) {}
          }
        }
        verificarLimpiezaStickersLRU();
      }
      const ts = Math.floor(Date.now() / 1000);
      const timeStr = formatearHoraMensaje(ts);
      const timeRel = formatearHora(ts);

      const newMsgItem = {
        id: sentMsgId,
        fromMe: true,
        sender: myName || "Tú",
        text: displayTxt,
        time: timeStr,
        timestamp: ts,
        status: 2,
        read: false
      };
      if (isStk) {
        newMsgItem.tipo = "sticker";
        newMsgItem.stickerId = stkId;
      }

      if (!messagesCache.has(chat)) messagesCache.set(chat, []);
      messagesCache.get(chat).push(newMsgItem);
      if (messagesCache.get(chat).length > 50) messagesCache.get(chat).shift();

      const alt = lidToJid.get(chat) || jidToLid.get(chat);
      if (alt) {
        if (!messagesCache.has(alt)) messagesCache.set(alt, []);
        messagesCache.get(alt).push(newMsgItem);
        if (messagesCache.get(alt).length > 50) messagesCache.get(alt).shift();
      }

      if (chatsCache.has(chat)) {
        const c = chatsCache.get(chat);
        c.lastMsg = displayTxt;
        c.time = timeRel;
        c.timestamp = ts;
        c.fromMe = true;
        c.unread = 0;
      }

      programarGuardadoDisco();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id: sentMsgId }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // API Enviar Nota de Voz oficial (PTT, limite 2.5 MB streaming)
  if (pathname === "/api/enviar_audio" && req.method === "POST") {
    let audioBuf;
    try {
      audioBuf = await leerBodySeguro(req, 2.5 * 1024 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    const chat = parsedUrl.query.chat;
    if (!chat || !sock) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Falta parametro chat o no conectado" }));
    }
    try {
      if (audioBuf.length < 100) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Audio vacio o corrupto" }));
      }

      const tmpId = Date.now() + "_" + Math.floor(Math.random() * 10000);
      const inWav = path.join(audioFolder, `in_${tmpId}.wav`);
      const outOgg = path.join(audioFolder, `out_${tmpId}.ogg`);
      fs.writeFileSync(inWav, audioBuf);

      const ffmpegBin = (() => {
        try { return require("ffmpeg-static") || "ffmpeg"; } catch (_) { return "ffmpeg"; }
      })();
      const transcodeToOpus = (codec) => new Promise((resolve, reject) => {
        execFile(ffmpegBin, ["-y", "-i", inWav, "-ar", "16000", "-ac", "1", "-c:a", codec, "-b:a", "32k", "-vbr", "on", "-application", "voip", outOgg], (err) => {
          if (err) return reject(err);
          if (!fs.existsSync(outOgg) || fs.statSync(outOgg).size === 0) return reject(new Error("Ogg vacio"));
          resolve(fs.readFileSync(outOgg));
        });
      });

      let oggBuf;
      try {
        oggBuf = await transcodeToOpus("libopus");
      } catch (e1) {
        console.warn("[Audio] Reintentando transcode con codec opus...");
        try {
          oggBuf = await transcodeToOpus("opus");
        } catch (e2) {
          console.error("[Audio] Fallo transcode ffmpeg:", e2.message);
          oggBuf = audioBuf;
        }
      } finally {
        try { if (fs.existsSync(inWav)) fs.unlinkSync(inWav); } catch (_) {}
        try { if (fs.existsSync(outOgg)) fs.unlinkSync(outOgg); } catch (_) {}
      }

      const myJid = obtenerMiJid();
      const targetChat = esChatPropio(chat)
        ? (sock?.user?.id ? jidNormalizedUser(sock.user.id) : myJid)
        : jidNormalizedUser(chat);

      const isOgg = (oggBuf !== audioBuf);
      // Nunca enviar WAV crudo disfrazado de audio/mp4 con ptt:true (WhatsApp lo rechaza como incompatible)
      const sent = await sock.sendMessage(targetChat, isOgg ? {
        audio: oggBuf,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true
      } : {
        audio: oggBuf,
        mimetype: "audio/wav",
        ptt: false
      });
      if (sent?.key?.id) {
        allMessagesMap.set(sent.key.id, sent.message);
      }

      if (sent?.key?.id) {
        const safeAudioId = sent.key.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        try {
          fs.writeFileSync(path.join(audioFolder, `${safeAudioId}.wav`), audioBuf);
        } catch (_) {}
      }

      const ts = Math.floor(Date.now() / 1000);
      const timeStr = formatearHoraMensaje(ts);
      const timeRel = formatearHora(ts);

      const newMsgItem = {
        id: sent.key.id,
        fromMe: true,
        sender: myName || "Tú",
        text: "[Nota de voz]",
        time: timeStr,
        timestamp: ts,
        status: 2,
        read: false
      };

      if (!messagesCache.has(chat)) messagesCache.set(chat, []);
      messagesCache.get(chat).push(newMsgItem);

      if (chatsCache.has(chat)) {
        const c = chatsCache.get(chat);
        c.lastMsg = "[Nota de voz]";
        c.time = timeRel;
        c.timestamp = ts;
        c.fromMe = true;
        c.unread = 0;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id: sent.key.id }));
    } catch (e) {
      console.error("[Audio] Error:", e);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // API Enviar Sticker Nativo One UI (limite 32 KB streaming)
  if (pathname === "/api/enviar_sticker" && req.method === "POST") {
    let rawBuf;
    try {
      rawBuf = await leerBodySeguro(req, 32 * 1024);
    } catch (err) {
      return responderErrorBody(res, req, err);
    }
    const chat = parsedUrl.query.chat;
    const rawQueryId = typeof parsedUrl.query.id === "string" ? parsedUrl.query.id.trim() : "";
    const stkId = (rawQueryId || ("stk_" + Date.now())).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!chat || !sock) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Falta parametro chat o no conectado" }));
    }
    try {
      const webpPath = path.join(stickersFolder, `${stkId}.webp`);
      const rawPath = path.join(stickersFolder, `${stkId}.raw`);
      let webpBuf = null;

      if (rawQueryId && fs.existsSync(webpPath)) {
        const sameRawOnDisk = (rawBuf.length === 64 * 64 * 2 && fs.existsSync(rawPath))
          ? (() => { try { return fs.readFileSync(rawPath).equals(rawBuf); } catch (_) { return false; } })()
          : true;
        if (sameRawOnDisk) {
          try {
            const cachedWebp = fs.readFileSync(webpPath);
            if (cachedWebp.length > 0) webpBuf = cachedWebp;
          } catch (_) {}
          if (rawBuf.length === 64 * 64 * 2 && !fs.existsSync(rawPath)) {
            try { fs.writeFileSync(rawPath, rawBuf); } catch (_) {}
          }
        }
      }

      if (!webpBuf && rawBuf.length === 64 * 64 * 2) {
        if (!sharp) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Sharp no disponible para conversion" }));
        }
        webpBuf = await convertirRawAWebp(rawBuf);
        try { fs.writeFileSync(rawPath, rawBuf); } catch (_) {}
        if (webpBuf) { try { fs.writeFileSync(webpPath, webpBuf); } catch (_) {} }
      } else if (!webpBuf && fs.existsSync(webpPath)) {
        try {
          const cachedWebp = fs.readFileSync(webpPath);
          if (cachedWebp.length > 0) webpBuf = cachedWebp;
        } catch (_) {}
      } else if (!webpBuf && (rawMediaMap.has(rawQueryId) || rawMediaMap.has(stkId))) {
        try {
          const rawMsg = rawMediaMap.get(rawQueryId) || rawMediaMap.get(stkId);
          webpBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock?.updateMediaMessage
          });
          if (webpBuf) { try { fs.writeFileSync(webpPath, webpBuf); } catch (_) {} }
        } catch (_) {}
      } else if (!webpBuf && fs.existsSync(rawPath)) {
        if (!sharp) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Sharp no disponible para conversion" }));
        }
        try {
          const diskRaw = fs.readFileSync(rawPath);
          webpBuf = await convertirRawAWebp(diskRaw);
          if (webpBuf) { try { fs.writeFileSync(webpPath, webpBuf); } catch (_) {} }
        } catch (_) {}
      }

      if (!webpBuf) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Sticker invalido: debe enviar 8192 bytes o id existente" }));
      }

      const myJid = obtenerMiJid();
      const targetChat = esChatPropio(chat)
        ? (sock?.user?.id ? jidNormalizedUser(sock.user.id) : myJid)
        : jidNormalizedUser(chat);

      const sent = await sock.sendMessage(targetChat, {
        sticker: webpBuf
      });

      const msgId = sent?.key?.id || ("stkmsg_" + Date.now());
      if (sent?.key?.id) {
        allMessagesMap.set(sent.key.id, sent.message || { stickerMessage: {} });
      }
      if (sent) {
        const extraIds = rawQueryId ? [rawQueryId, stkId, msgId] : [stkId, msgId];
        const sentSId = indexarStickerEnMapa(sent, extraIds);
        if (sentSId && sentSId !== stkId) {
          const sentWebpPath = path.join(stickersFolder, `${sentSId}.webp`);
          if (!fs.existsSync(sentWebpPath)) {
            try { fs.writeFileSync(sentWebpPath, webpBuf); } catch (_) {}
          }
        }
      }

      const ts = Math.floor(Date.now() / 1000);
      const timeStr = formatearHoraMensaje(ts);
      const timeRel = formatearHora(ts);

      const newMsgItem = {
        id: msgId,
        stickerId: stkId,
        fromMe: true,
        sender: myName || "Tú",
        text: "[Sticker]",
        tipo: "sticker",
        time: timeStr,
        timestamp: ts,
        status: 2,
        read: false
      };

      if (!messagesCache.has(targetChat)) messagesCache.set(targetChat, []);
      messagesCache.get(targetChat).push(newMsgItem);
      if (messagesCache.get(targetChat).length > 50) messagesCache.get(targetChat).shift();

      if (chatsCache.has(targetChat)) {
        const c = chatsCache.get(targetChat);
        c.lastMsg = "[Sticker]";
        c.time = timeRel;
        c.timestamp = ts;
        c.fromMe = true;
        c.unread = 0;
      }

      verificarLimpiezaStickersLRU();
      programarGuardadoDisco();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, id: msgId, stickerId: stkId }));
    } catch (err) {
      console.error("[Sticker] Error enviando sticker:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  res.writeHead(404);
  res.end();
});

// Timeouts HTTP estrictos anti-Slowloris
server.headersTimeout = 10000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 40;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[EspCHAT Bridge v3.4.0] Activo en puerto ${PORT}`);
  if (!SKIP_WA) {
    startWhatsApp();
  }

  // Keep-Alive auto-ping cada 9 minutos solo en entorno Cloud y sin SKIP_WA
  if (IS_CLOUD && !SKIP_WA) {
    setInterval(() => {
      try {
        const sUrl = process.env.RENDER_EXTERNAL_URL || "https://espos-chat-bridge.onrender.com";
        const pingUrl = `${sUrl}/`;
        const mod = pingUrl.startsWith("https") ? require("https") : require("http");
        mod.get(pingUrl, (r) => { r.on("data", () => {}); }).on("error", () => {});
      } catch (e) {}
    }, 9 * 60 * 1000);
  }
});
