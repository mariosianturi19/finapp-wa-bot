require('dotenv').config();
const makeWASocket   = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const qrcode    = require('qrcode-terminal');
const axios     = require('axios');
const http      = require('http');
const path      = require('path');
const pino      = require('pino');

// ── Dummy Web Server (Untuk Render / Railway) ────────────────────────────────
const PORT = process.env.PORT || 3001;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FinApp WA Bot is running! 🚀\n');
}).listen(PORT, () => console.log(`🌐 Server berjalan di port ${PORT}`));

// ── Config ───────────────────────────────────────────────────────────────────
const NEXTJS_URL  = process.env.NEXTJS_URL  ?? 'http://localhost:3000';
const BOT_API_KEY = process.env.BOT_API_KEY ?? '';

if (!BOT_API_KEY) {
  console.error('❌  BOT_API_KEY kosong! Isi file .env terlebih dahulu.');
  process.exit(1);
}

// ── Helper: Format Rupiah ─────────────────────────────────────────────────────
const formatRp = (n) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);

// ── Helper: Konversi singkatan nominal ───────────────────────────────────────
function parseAmount(raw) {
  const str = raw.toLowerCase().replace(/[.,]/g, '').trim();
  if (/^\d+jt$/.test(str))  return parseInt(str) * 1_000_000;
  if (/^\d+rb$/.test(str))  return parseInt(str) * 1_000;
  if (/^\d+k$/.test(str))   return parseInt(str) * 1_000;
  return parseInt(str) || 0;
}

// ── Helper: Validasi format tanggal backdate (DD-MM atau DD/MM) ─────────────
function parseDateSuffix(token) {
  const match = token.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const day   = String(match[1]).padStart(2, '0');
  const month = String(match[2]).padStart(2, '0');
  const year  = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCFullYear();
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day)   < 1 || Number(day)   > 31) return null;
  return `${year}-${month}-${day}`;
}

// ── Parser pesan transaksi ────────────────────────────────────────────────────
// Format: [out|in] [nominal] [kategori multi kata] [wallet] [DD-MM?]
function parseTransaction(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length < 3) return null;

  const typeRaw = parts[0];
  if (!['out', 'in', 'keluar', 'masuk'].includes(typeRaw)) return null;

  const type   = ['out', 'keluar'].includes(typeRaw) ? 'expense' : 'income';
  const amount = parseAmount(parts[1]);
  if (!amount || amount <= 0) return null;

  let rest = parts.slice(2);

  // Cek apakah kata terakhir adalah tanggal backdate (DD-MM)
  let backdateStr = null;
  if (rest.length > 0) {
    const maybeDateStr = parseDateSuffix(rest[rest.length - 1]);
    if (maybeDateStr) {
      backdateStr = maybeDateStr;
      rest = rest.slice(0, -1);
    }
  }

  if (rest.length === 0) return null;

  if (rest.length === 1) {
    return { type, amount, category_query: rest[0], wallet_query: '', date: backdateStr };
  }

  return {
    type,
    amount,
    category_query: rest.slice(0, -1).join(' '),
    wallet_query:   rest[rest.length - 1],
    date:           backdateStr,
  };
}

// ── Parser pesan transfer ─────────────────────────────────────────────────────
// Format: tf [nominal] [sumber] [tujuan]
function parseTransfer(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length < 4) return null;
  if (parts[0] !== 'tf' && parts[0] !== 'transfer') return null;

  const amount = parseAmount(parts[1]);
  if (!amount || amount <= 0) return null;

  return { amount, from_query: parts[2], to_query: parts[3] };
}

// ── API Calls ke Next.js ──────────────────────────────────────────────────────
const HEADERS = () => ({ 'x-bot-api-key': BOT_API_KEY });

async function postTransaction(phone, txData) {
  const res = await axios.post(`${NEXTJS_URL}/api/bot/transaction`, { phone, ...txData }, { headers: HEADERS(), timeout: 15_000 });
  return res.data;
}

async function getWallets(phone) {
  const res = await axios.get(`${NEXTJS_URL}/api/bot/transaction`, { params: { phone }, headers: HEADERS(), timeout: 15_000 });
  return res.data;
}

async function getRekap(phone, bulan) {
  const params = bulan ? { phone, bulan } : { phone };
  const res = await axios.get(`${NEXTJS_URL}/api/bot/rekap`, { params, headers: HEADERS(), timeout: 15_000 });
  return res.data;
}

async function postTransfer(phone, tfData) {
  const res = await axios.post(`${NEXTJS_URL}/api/bot/transfer`, { phone, ...tfData }, { headers: HEADERS(), timeout: 15_000 });
  return res.data;
}

// ── Pending Confirmation Map ──────────────────────────────────────────────────
const pendingTx = new Map();
const PENDING_TIMEOUT_MS      = 2 * 60 * 1000;
const LARGE_AMOUNT_THRESHOLD  = 1_000_000;

// ── Help Message ─────────────────────────────────────────────────────────────
const HELP_MSG = `
🤖 *FinApp Bot — Panduan Perintah*

*📝 Catat Transaksi*
\`out [nominal] [kategori] [wallet]\`
\`in [nominal] [kategori] [wallet]\`

*Contoh:*
• \`out 50k makan gopay\` → Pengeluaran Rp50.000 dari GoPay
• \`out 25rb jajan bca\` → Pengeluaran Rp25.000 dari BCA
• \`in 50jt dikasi orang tua bca\` → Kategori nama panjang pun bisa!
• \`out 30k jajan bca 08-04\` → Transaksi untuk tanggal 8 April

*🔄 Transfer Wallet*
\`tf [nominal] [sumber] [tujuan]\`
• \`tf 100k bca gopay\` → Transfer Rp100.000 dari BCA ke GoPay

*💰 Singkatan Nominal*
• \`k\` = ribu (50k = 50.000)
• \`rb\` = ribu (500rb = 500.000)
• \`jt\` = juta (2jt = 2.000.000)

*📊 Perintah Lain*
• \`!saldo\` → Lihat saldo semua wallet
• \`!rekap\` → Rekap transaksi bulan ini
• \`!rekap 2025-03\` → Rekap bulan tertentu
• \`!kategori\` → Lihat daftar kategori
• \`!help\` → Tampilkan panduan ini

⚠️ *Catatan:* wallet wajib disebut di setiap transaksi. Nominal ≥ Rp1jt akan minta konfirmasi terlebih dahulu.
`.trim();

// ── Kirim pesan (helper Baileys) ──────────────────────────────────────────────
let sock;
async function sendMsg(jid, text) {
  await sock.sendMessage(jid, { text });
}

// ── Handler Pesan ─────────────────────────────────────────────────────────────
async function handleMessage(jid, phone, text) {
  const textLower = text.toLowerCase().trim();
  console.log(`📨  Pesan dari ${phone}: "${text}"`);

  try {
    // !help
    if (textLower === '!help' || textLower === 'help') {
      await sendMsg(jid, HELP_MSG);
      return;
    }

    // !saldo
    if (textLower === '!saldo' || textLower === 'saldo') {
      try {
        const { wallets } = await getWallets(phone);
        if (!wallets || wallets.length === 0) {
          await sendMsg(jid, '💳 Kamu belum punya wallet. Buat di aplikasi FinApp terlebih dahulu.');
          return;
        }
        const total = wallets.reduce((s, w) => s + Number(w.balance), 0);
        const lines = wallets.map((w) => `${w.icon ?? '💳'} *${w.name}*: ${formatRp(Number(w.balance))}`);
        await sendMsg(jid, ['💰 *Saldo Wallet Kamu:*', '', ...lines, '', `📊 *Total: ${formatRp(total)}*`].join('\n'));
      } catch (err) {
        const code = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await sendMsg(jid, '⚠️ Nomor WA kamu belum terdaftar. Buka FinApp → Settings → daftarkan nomor HP kamu.');
        } else {
          await sendMsg(jid, '❌ Gagal mengambil saldo. Coba lagi nanti.');
        }
      }
      return;
    }

    // !rekap
    if (textLower.startsWith('!rekap') || textLower.startsWith('rekap')) {
      try {
        const parts    = textLower.split(/\s+/);
        const bulanArg = parts[1] && /^\d{4}-\d{2}$/.test(parts[1]) ? parts[1] : null;
        const data     = await getRekap(phone, bulanArg);
        const rp       = (n) => formatRp(Number(n));
        const netSign  = data.net >= 0 ? '+' : '';
        const topLines = (data.top_expenses ?? []).map(([cat, total], i) => `${i + 1}. ${cat}: ${rp(total)}`);
        const lines = [
          `📊 *Rekap ${data.month_label}*`, '',
          `📥 Pemasukan  : *${rp(data.total_income)}*`,
          `📤 Pengeluaran: *${rp(data.total_expense)}*`,
          `💹 Selisih    : *${netSign}${rp(Math.abs(data.net))}*${data.net >= 0 ? ' 🟢' : ' 🔴'}`, '',
          `🔢 Total transaksi: ${data.tx_count}`,
        ];
        if (topLines.length > 0) lines.push('', '🏆 *Top Pengeluaran:*', ...topLines);
        await sendMsg(jid, lines.join('\n'));
      } catch (err) {
        const code = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await sendMsg(jid, '⚠️ Nomor WA kamu belum terdaftar. Buka FinApp → Settings → daftarkan nomor HP kamu.');
        } else {
          await sendMsg(jid, '❌ Gagal mengambil rekap. Coba lagi nanti.');
        }
      }
      return;
    }

    // Konfirmasi pending tx (Y/N)
    const yesReplies = ['y', 'yes', 'ya', 'iya', 'ok', 'oke', 'confirm'];
    const noReplies  = ['n', 'no', 'tidak', 'gajadi', 'batal', 'cancel'];

    if (pendingTx.has(phone)) {
      const pending = pendingTx.get(phone);
      if (Date.now() > pending.expiresAt) {
        pendingTx.delete(phone);
        await sendMsg(jid, '⏰ Waktu konfirmasi habis (2 menit). Transaksi dibatalkan.');
        return;
      }
      if (yesReplies.includes(textLower)) {
        pendingTx.delete(phone);
        try {
          const result = await postTransaction(phone, pending.parsed);
          const emoji  = pending.parsed.type === 'expense' ? '📤' : '📥';
          const label  = pending.parsed.type === 'expense' ? 'Pengeluaran' : 'Pemasukan';
          const dateLabel = pending.parsed.date
            ? `📅 Tanggal: ${pending.parsed.date}`
            : `_${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}_`;
          await sendMsg(jid, [
            `${emoji} *${label} berhasil dicatat!*`, '',
            `💰 Jumlah    : *${formatRp(result.transaction.amount)}*`,
            `🏷️ Kategori  : ${result.category_name}`,
            `💳 Wallet    : ${result.wallet_name}`,
            `💵 Saldo baru: *${formatRp(result.new_balance)}*`, '',
            dateLabel,
          ].join('\n'));
        } catch (err) {
          const apiMsg = err?.response?.data?.message;
          const code   = err?.response?.data?.code;
          if (code === 'PHONE_NOT_REGISTERED') {
            await sendMsg(jid, '⚠️ Nomor WA kamu belum terdaftar di FinApp.');
          } else {
            await sendMsg(jid, `❌ ${apiMsg ?? 'Terjadi kesalahan. Coba lagi nanti.'}`);
          }
        }
        return;
      }
      if (noReplies.includes(textLower)) {
        pendingTx.delete(phone);
        await sendMsg(jid, '✅ Transaksi dibatalkan.');
        return;
      }
    }

    // Transfer (tf)
    const parsedTf = parseTransfer(text);
    if (parsedTf) {
      try {
        const result  = await postTransfer(phone, parsedTf);
        const rp      = (n) => formatRp(Number(n));
        const feeInfo = result.admin_fee > 0
          ? `\n💸 Admin fee  : ${rp(result.admin_fee)}\n💳 Total potong: ${rp(result.total_deducted)}`
          : '';
        await sendMsg(jid, [
          `🔄 *Transfer berhasil!*`, '',
          `💰 Jumlah           : *${rp(result.amount)}*`,
          `📤 Dari  ${result.from_wallet_name}: *${rp(result.from_balance)}*`,
          `📥 Ke    ${result.to_wallet_name}: *${rp(result.to_balance)}*`,
          feeInfo,
        ].filter(Boolean).join('\n'));
      } catch (err) {
        const apiMsg = err?.response?.data?.message;
        const code   = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await sendMsg(jid, '⚠️ Nomor WA kamu belum terdaftar di FinApp.');
        } else {
          await sendMsg(jid, `❌ ${apiMsg ?? 'Gagal transfer. Coba lagi nanti.'}`);
        }
      }
      return;
    }

    // Catat Transaksi
    const parsed = parseTransaction(text);
    if (!parsed) {
      await sendMsg(jid,
        '❓ Perintah tidak dikenali.\n\n' +
        'Ketik *!help* untuk panduan lengkap.\n\n' +
        '_Contoh: out 50k makan bca atau tf 100k bca gopay_'
      );
      return;
    }

    // Nominal besar → konfirmasi dulu
    if (parsed.amount >= LARGE_AMOUNT_THRESHOLD) {
      const emoji     = parsed.type === 'expense' ? '📤' : '📥';
      const typeLabel = parsed.type === 'expense' ? 'pengeluaran' : 'pemasukan';
      pendingTx.set(phone, { parsed, expiresAt: Date.now() + PENDING_TIMEOUT_MS });
      await sendMsg(jid,
        `⚠️ *Konfirmasi ${typeLabel} besar:*\n\n` +
        `${emoji} ${formatRp(parsed.amount)} untuk kategori *${parsed.category_query}*\n` +
        `💳 Wallet: ${parsed.wallet_query || '(default)'}\n` +
        (parsed.date ? `📅 Tanggal: ${parsed.date}\n` : '') +
        `\nBalas *Y* untuk lanjutkan, atau *N* untuk batal.\n_(Otomatis dibatalkan dalam 2 menit jika tidak dibalas)_`
      );
      return;
    }

    // Eksekusi transaksi normal
    const result = await postTransaction(phone, parsed);
    const emoji  = parsed.type === 'expense' ? '📤' : '📥';
    const label  = parsed.type === 'expense' ? 'Pengeluaran' : 'Pemasukan';
    await sendMsg(jid, [
      `${emoji} *${label} berhasil dicatat!*`, '',
      `💰 Jumlah: *${formatRp(result.transaction.amount)}*`,
      `🏷️ Kategori: ${result.category_name}`,
      `💳 Wallet: ${result.wallet_name}`,
      `💵 Saldo sekarang: *${formatRp(result.new_balance)}*`, '',
      `_${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_`,
    ].join('\n'));
    console.log(`✅  Transaksi berhasil: ${result.category_name} ${formatRp(parsed.amount)} (${phone})`);

  } catch (err) {
    const apiMsg = err?.response?.data?.message;
    const code   = err?.response?.data?.code;
    if (code === 'PHONE_NOT_REGISTERED') {
      await sendMsg(jid,
        '⚠️ *Nomor WA kamu belum terdaftar di FinApp.*\n\n' +
        'Buka aplikasi FinApp → Settings → masukkan nomor HP kamu.'
      );
    } else if (apiMsg) {
      await sendMsg(jid, `❌ ${apiMsg}`);
    } else {
      console.error('Error:', err?.message);
      await sendMsg(jid, '❌ Terjadi kesalahan. Coba lagi nanti.');
    }
  }
}

// ── Connect ke WhatsApp ───────────────────────────────────────────────────────
async function connectToWA() {
  const AUTH_DIR = path.join(__dirname, '.wwebjs_auth', 'baileys');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // kita handle manual biar tampil lebih besar
    logger: pino({ level: 'silent' }),
    browser: ['FinApp Bot', 'Chrome', '1.0.0'],
  });

  // Simpan credentials saat update
  sock.ev.on('creds.update', saveCreds);

  // Handle koneksi
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱  Scan QR Code ini dengan WhatsApp di HP kamu:');
      qrcode.generate(qr, { small: true });
      console.log('\n⏳  Menunggu scan QR...\n');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️  Koneksi terputus (code: ${statusCode}). ${shouldReconnect ? 'Reconnecting...' : 'Sudah logout.'}`);
      if (shouldReconnect) {
        setTimeout(connectToWA, 3000); // Reconnect setelah 3 detik
      }
    } else if (connection === 'open') {
      const num = sock.user?.id?.split(':')[0] ?? '?';
      console.log(`\n✅  Bot aktif! Nomor: +${num}`);
      console.log(`📡  Terhubung ke Next.js: ${NEXTJS_URL}`);
      console.log('💬  Menunggu pesan...\n');
    }
  });

  // Handle pesan masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Abaikan: pesan dari bot sendiri, grup, status broadcast
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue; // grup

      // Ambil teks pesan
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
      ).trim();

      if (!text) continue;

      // Ambil nomor HP pengirim (format: 628xxx@s.whatsapp.net)
      const jid   = msg.key.remoteJid;
      let phone   = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (phone.startsWith('0')) phone = '62' + phone.slice(1);

      await handleMessage(jid, phone, text);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('🚀  Starting FinApp WA Bot (Baileys — tanpa browser)...');
connectToWA();
