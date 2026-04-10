require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios  = require('axios');
const http   = require('http');

// ── Dummy Web Server (Untuk Render / Railway) ────────────────────────────────
// Hosting gratis butuh service untuk bind ke PORT agar dianggap "Berhasil Deploy"
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

// ── Init WhatsApp Client ─────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'finapp-bot' }),
  puppeteer: {
    headless: true,
    // Pakai path dari env var (di-set di Dockerfile), fallback ke Debian path
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    timeout: 60000,
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process', // Penting untuk menghemat RAM di server gratis
      '--disable-gpu',
    ],
  },
});

// ── Helper: Format Rupiah ─────────────────────────────────────────────────────
const formatRp = (n) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(n);

// ── Helper: Konversi singkatan nominal ───────────────────────────────────────
// "50k" → 50000, "2jt" → 2000000, "500rb" → 500000
function parseAmount(raw) {
  const str = raw.toLowerCase().replace(/[.,]/g, '').trim();
  if (/^\d+jt$/.test(str))  return parseInt(str) * 1_000_000;
  if (/^\d+rb$/.test(str))  return parseInt(str) * 1_000;
  if (/^\d+k$/.test(str))   return parseInt(str) * 1_000;
  return parseInt(str) || 0;
}

// ── Helper: Phone number normalization ──────────────────────────────────────
// WA kirim nomor dalam berbagai format:
//   Lama: "628xxx@c.us"   → ambil "628xxx"
//   Baru: "115195334@lid" → harus pakai getContact() untuk nomor asli
function normalizePhone(waId) {
  const num = waId.split('@')[0]; // potong suffix apapun (@c.us, @lid, dll)
  if (/^\d{7,}$/.test(num)) return num; // valid phone digits
  return null; // bukan nomor telepon
}

// Ambil nomor HP asli dari pesan (handle @lid format di WA multi-device)
async function getPhoneFromMsg(msg) {
  try {
    const contact = await msg.getContact();
    if (contact && contact.number) {
      let phone = contact.number.replace(/\D/g, '');
      if (phone.startsWith('0')) phone = '62' + phone.slice(1);
      console.log(`📞  Nomor dari getContact(): ${phone}`);
      return phone;
    }
  } catch (e) {
    console.log('⚠️  getContact() gagal, pakai fallback normalizePhone');
  }
  // Fallback: coba ambil dari msg.from
  const fallback = normalizePhone(msg.from);
  console.log(`📞  Nomor dari msg.from fallback: ${fallback ?? 'GAGAL'} (raw: ${msg.from})`);
  return fallback;
}

// ── Helper: Validasi format tanggal backdate (DD-MM atau DD/MM) ─────────────
// Kembalikan YYYY-MM-DD pakai tahun sekarang (WIB), atau null jika bukan tanggal
function parseDateSuffix(token) {
  const match = token.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const day   = String(match[1]).padStart(2, '0');
  const month = String(match[2]).padStart(2, '0');
  const year  = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCFullYear();
  // Validasi sederhana
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day)   < 1 || Number(day)   > 31) return null;
  return `${year}-${month}-${day}`;
}

// ── Parser pesan transaksi ────────────────────────────────────────────────────
// Format: [out|in] [nominal] [kategori multi kata] [wallet] [DD-MM?]
// Contoh:
//   "out 50k makan gopay"            → cat="makan", wallet="gopay"
//   "in 50jt dikasi orang tua bca"   → cat="dikasi orang tua", wallet="bca"
//   "out 50k makan gopay 08-04"      → cat="makan", wallet="gopay", date="2025-04-08"
function parseTransaction(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length < 3) return null;

  const typeRaw = parts[0];
  if (!['out', 'in', 'keluar', 'masuk'].includes(typeRaw)) return null;

  const type   = ['out', 'keluar'].includes(typeRaw) ? 'expense' : 'income';
  const amount = parseAmount(parts[1]);
  if (!amount || amount <= 0) return null;

  let rest = parts.slice(2); // semua kata setelah nominal

  // Cek apakah kata terakhir adalah tanggal backdate (DD-MM)
  let backdateStr = null;
  if (rest.length > 0) {
    const maybeDateStr = parseDateSuffix(rest[rest.length - 1]);
    if (maybeDateStr) {
      backdateStr = maybeDateStr;
      rest = rest.slice(0, -1); // hapus token tanggal
    }
  }

  if (rest.length === 0) return null; // tidak ada kategori sama sekali

  if (rest.length === 1) {
    // Hanya 1 kata: itu kategori, tidak ada wallet
    return { type, amount, category_query: rest[0], wallet_query: '', date: backdateStr };
  }

  // >= 2 kata: kata terakhir = kandidat wallet, sisanya = kategori (multi-kata)
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
// Contoh: "tf 50k bca gopay" → amount=50000, from="bca", to="gopay"
function parseTransfer(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length < 4) return null;
  if (parts[0] !== 'tf' && parts[0] !== 'transfer') return null;

  const amount = parseAmount(parts[1]);
  if (!amount || amount <= 0) return null;

  const from_query = parts[2];
  const to_query   = parts[3];

  return { amount, from_query, to_query };
}

// ── API Calls ke Next.js ──────────────────────────────────────────────────────
const HEADERS = () => ({ 'x-bot-api-key': BOT_API_KEY });

async function postTransaction(phone, txData) {
  const res = await axios.post(
    `${NEXTJS_URL}/api/bot/transaction`,
    { phone, ...txData },
    { headers: HEADERS(), timeout: 10_000 }
  );
  return res.data;
}

async function getWallets(phone) {
  const res = await axios.get(
    `${NEXTJS_URL}/api/bot/transaction`,
    { params: { phone }, headers: HEADERS(), timeout: 10_000 }
  );
  return res.data;
}

async function getRekap(phone, bulan) {
  const params = bulan ? { phone, bulan } : { phone };
  const res = await axios.get(
    `${NEXTJS_URL}/api/bot/rekap`,
    { params, headers: HEADERS(), timeout: 10_000 }
  );
  return res.data;
}

async function postTransfer(phone, tfData) {
  const res = await axios.post(
    `${NEXTJS_URL}/api/bot/transfer`,
    { phone, ...tfData },
    { headers: HEADERS(), timeout: 10_000 }
  );
  return res.data;
}

// ── Pending Confirmation Map (untuk nominal besar) ────────────────────────────
// Key: phone number, Value: { parsed, expiresAt }
const pendingTx = new Map();
const PENDING_TIMEOUT_MS = 2 * 60 * 1000; // 2 menit
const LARGE_AMOUNT_THRESHOLD = 1_000_000;  // >= 1 juta wajib konfirmasi

// ── Pesan balasan ─────────────────────────────────────────────────────────────
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

// ── Main event handler ──────────────────────────────────────────────────────
client.on('qr', (qr) => {
  console.log('\n📱  Scan QR Code ini dengan WhatsApp di HP kamu:');
  qrcode.generate(qr, { small: true });
  console.log('\n⏳  Menunggu scan QR...\n');
});

client.on('ready', () => {
  const num = client.info.wid.user;
  console.log(`\n✅  Bot aktif! Nomor: +${num}`);
  console.log(`📡  Terhubung ke Next.js: ${NEXTJS_URL}`);
  console.log('💬  Menunggu pesan...\n');
});

client.on('auth_failure', (msg) => {
  console.error('❌  Autentikasi gagal:', msg);
});

client.on('disconnected', (reason) => {
  console.log('⚠️  Bot terputus:', reason);
});

client.on('message', async (msg) => {
  // Abaikan pesan dari grup, dari bot sendiri, atau dari status WA
  if (msg.isGroupMsg || msg.fromMe || msg.from === 'status@broadcast') return;

  const phone = await getPhoneFromMsg(msg);
  if (!phone) {
    console.log(`⚠️  Tidak bisa ambil nomor HP dari: ${msg.from} — pesan diabaikan.`);
    return;
  }

  const text  = msg.body.trim();

  console.log(`📨  Pesan dari ${phone}: "${text}"`);

  try {
    // ── Perintah: !help ──────────────────────────────────────────
    if (text.toLowerCase() === '!help' || text.toLowerCase() === 'help') {
      await msg.reply(HELP_MSG);
      return;
    }

    // ── Perintah: !saldo ─────────────────────────────────────────
    if (text.toLowerCase() === '!saldo' || text.toLowerCase() === 'saldo') {
      try {
        const { wallets } = await getWallets(phone);
        if (!wallets || wallets.length === 0) {
          await msg.reply('💳 Kamu belum punya wallet. Buat di aplikasi FinApp terlebih dahulu.');
          return;
        }
        const total = wallets.reduce((s, w) => s + Number(w.balance), 0);
        const lines = wallets.map((w) =>
          `${w.icon ?? '💳'} *${w.name}*: ${formatRp(Number(w.balance))}`
        );
        const reply = [
          '💰 *Saldo Wallet Kamu:*',
          '',
          ...lines,
          '',
          `📊 *Total: ${formatRp(total)}*`,
        ].join('\n');
        await msg.reply(reply);
      } catch (err) {
        const code = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await msg.reply('⚠️ Nomor WA kamu belum terdaftar. Buka FinApp → Settings → daftarkan nomor HP kamu.');
        } else {
          await msg.reply('❌ Gagal mengambil saldo. Coba lagi nanti.');
        }
      }
      return;
    }

    // ── Perintah: !rekap [bulan?] ────────────────────────────────
    const textLower = text.toLowerCase();
    if (textLower.startsWith('!rekap') || textLower.startsWith('rekap')) {
      try {
        // Ambil parameter bulan opsional: !rekap 2025-03
        const parts    = textLower.split(/\s+/);
        const bulanArg = parts[1] && /^\d{4}-\d{2}$/.test(parts[1]) ? parts[1] : null;
        const data     = await getRekap(phone, bulanArg);

        const rp      = (n) => formatRp(Number(n));
        const netSign = data.net >= 0 ? '+' : '';

        const topLines = (data.top_expenses ?? []).map(([cat, total], i) =>
          `${i + 1}. ${cat}: ${rp(total)}`
        );

        const lines = [
          `📊 *Rekap ${data.month_label}*`,
          '',
          `📥 Pemasukan  : *${rp(data.total_income)}*`,
          `📤 Pengeluaran: *${rp(data.total_expense)}*`,
          `💹 Selisih    : *${netSign}${rp(Math.abs(data.net))}*${data.net >= 0 ? ' 🟢' : ' 🔴'}`,
          '',
          `🔢 Total transaksi: ${data.tx_count}`,
        ];

        if (topLines.length > 0) {
          lines.push('', '🏆 *Top Pengeluaran:*', ...topLines);
        }

        await msg.reply(lines.join('\n'));
      } catch (err) {
        const code = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await msg.reply('⚠️ Nomor WA kamu belum terdaftar. Buka FinApp → Settings → daftarkan nomor HP kamu.');
        } else {
          await msg.reply('❌ Gagal mengambil rekap. Coba lagi nanti.');
        }
      }
      return;
    }

    // ── Perintah: Konfirmasi Transaksi Pending (Y / N) ───────────
    const yesReplies = ['y', 'yes', 'ya', 'iya', 'ok', 'oke', 'confirm'];
    const noReplies  = ['n', 'no', 'tidak', 'gajadi', 'batal', 'cancel'];

    if (pendingTx.has(phone)) {
      const pending = pendingTx.get(phone);

      if (Date.now() > pending.expiresAt) {
        pendingTx.delete(phone);
        await msg.reply('⏰ Waktu konfirmasi habis (2 menit). Transaksi dibatalkan.');
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

          const reply = [
            `${emoji} *${label} berhasil dicatat!*`,
            '',
            `💰 Jumlah    : *${formatRp(result.transaction.amount)}*`,
            `🏷️ Kategori  : ${result.category_name}`,
            `💳 Wallet    : ${result.wallet_name}`,
            `💵 Saldo baru: *${formatRp(result.new_balance)}*`,
            '',
            dateLabel,
          ].join('\n');
          await msg.reply(reply);
          console.log(`✅  Transaksi besar dikonfirmasi: ${result.category_name} ${formatRp(pending.parsed.amount)} (${phone})`);
        } catch (err) {
          const apiMsg = err?.response?.data?.message;
          const code   = err?.response?.data?.code;
          if (code === 'PHONE_NOT_REGISTERED') {
            await msg.reply('⚠️ Nomor WA kamu belum terdaftar di FinApp.');
          } else if (apiMsg) {
            await msg.reply(`❌ ${apiMsg}`);
          } else {
            await msg.reply('❌ Terjadi kesalahan. Coba lagi nanti.');
          }
        }
        return;
      }

      if (noReplies.includes(textLower)) {
        pendingTx.delete(phone);
        await msg.reply('✅ Transaksi dibatalkan.');
        return;
      }
    }

    // ── Perintah: Transfer (tf) ──────────────────────────────────
    const parsedTf = parseTransfer(text);
    if (parsedTf) {
      try {
        const result = await postTransfer(phone, parsedTf);
        const rp = (n) => formatRp(Number(n));
        const feeInfo = result.admin_fee > 0
          ? `\n💸 Admin fee  : ${rp(result.admin_fee)}\n💳 Total potong: ${rp(result.total_deducted)}`
          : '';

        const reply = [
          `🔄 *Transfer berhasil!*`,
          '',
          `💰 Jumlah           : *${rp(result.amount)}*`,
          `📤 Dari  ${result.from_wallet_name}: *${rp(result.from_balance)}*`,
          `📥 Ke    ${result.to_wallet_name}: *${rp(result.to_balance)}*`,
          feeInfo,
        ].filter(Boolean).join('\n');
        await msg.reply(reply);
        console.log(`🔄  Transfer berhasil: ${parsedTf.from_query} → ${parsedTf.to_query} ${formatRp(parsedTf.amount)} (${phone})`);
      } catch (err) {
        const apiMsg = err?.response?.data?.message;
        const code   = err?.response?.data?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          await msg.reply('⚠️ Nomor WA kamu belum terdaftar di FinApp.');
        } else if (apiMsg) {
          await msg.reply(`❌ ${apiMsg}`);
        } else {
          await msg.reply('❌ Gagal transfer. Coba lagi nanti.');
        }
      }
      return;
    }

    // ── Perintah: Catat Transaksi ────────────────────────────────
    const parsed = parseTransaction(text);
    if (!parsed) {
      // Pesan tidak dikenali — kirim hint singkat
      await msg.reply(
        '❓ Perintah tidak dikenali.\n\n' +
        'Ketik *!help* untuk panduan lengkap.\n\n' +
        '_Contoh: out 50k makan bca atau tf 100k bca gopay_'
      );
      return;
    }

    // ── Cek nominal besar → minta konfirmasi dulu ────────────────
    if (parsed.amount >= LARGE_AMOUNT_THRESHOLD) {
      const emoji     = parsed.type === 'expense' ? '📤' : '📥';
      const typeLabel = parsed.type === 'expense' ? 'pengeluaran' : 'pemasukan';
      pendingTx.set(phone, { parsed, expiresAt: Date.now() + PENDING_TIMEOUT_MS });

      await msg.reply(
        `⚠️ *Konfirmasi ${typeLabel} besar:*\n\n` +
        `${emoji} ${formatRp(parsed.amount)} untuk kategori *${parsed.category_query}*\n` +
        `💳 Wallet: ${parsed.wallet_query || '(default)'}\n` +
        (parsed.date ? `📅 Tanggal: ${parsed.date}\n` : '') +
        `\nBalas *Y* untuk lanjutkan, atau *N* untuk batal.\n_(Otomatis dibatalkan dalam 2 menit jika tidak dibalas)_`
      );
      return;
    }

    // ── Langsung eksekusi (nominal normal) ──────────────────────
    const result = await postTransaction(phone, parsed);

    const emoji  = parsed.type === 'expense' ? '📤' : '📥';
    const label  = parsed.type === 'expense' ? 'Pengeluaran' : 'Pemasukan';
    const reply  = [
      `${emoji} *${label} berhasil dicatat!*`,
      '',
      `💰 Jumlah: *${formatRp(result.transaction.amount)}*`,
      `🏷️ Kategori: ${result.category_name}`,
      `💳 Wallet: ${result.wallet_name}`,
      `💵 Saldo sekarang: *${formatRp(result.new_balance)}*`,
      '',
      `_${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}_`,
    ].join('\n');

    await msg.reply(reply);
    console.log(`✅  Transaksi berhasil: ${result.category_name} ${formatRp(parsed.amount)} (${phone})`);

  } catch (err) {
    const apiMsg = err?.response?.data?.message;
    const code   = err?.response?.data?.code;

    if (code === 'PHONE_NOT_REGISTERED') {
      await msg.reply(
        '⚠️ *Nomor WA kamu belum terdaftar di FinApp.*\n\n' +
        'Buka aplikasi FinApp → Settings → masukkan nomor HP kamu.'
      );
    } else if (apiMsg) {
      // Tampilkan pesan dari API langsung — sudah mengandung daftar kategori/wallet yang tersedia
      await msg.reply(`❌ ${apiMsg}`);
    } else {
      console.error('Error:', err?.message);
      await msg.reply('❌ Terjadi kesalahan. Coba lagi nanti.');
    }
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
console.log('🚀  Starting FinApp WA Bot...');
client.initialize();
