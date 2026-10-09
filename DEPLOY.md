# Hermes-Lite di Prisma Compute

Folder ini adalah target deployment Prisma yang terpisah dari target Python/BotKeep. Prisma Compute menjalankan Node/Bun HTTP services; Telegram terhubung lewat HTTPS webhook, update diletakkan di Prisma Postgres, dan Composer Cron mengambil antrean setiap 10 detik.

## Prasyarat

- Akun dan workspace Prisma Console.
- Node.js 22.18+ dan Bun.
- Token bot Telegram dari `@BotFather`.
- Numeric Telegram account ID dari `@userinfobot`.
- API key, model ID dan URL OpenAI-compatible yang dapat diakses dari Prisma Compute.

## Set environment sebelum deploy pertama

Environment secrets/platform vars harus tersedia di shell yang menjalankan deploy pertama, atau sudah ada di Prisma project environment. Composer akan mengirim value-nya ke environment Prisma, bukan menyimpannya dalam source. Contoh PowerShell untuk mengisi shell tanpa menampilkan token ketika diketik:

```powershell
$env:TELEGRAM_BOT_TOKEN = Read-Host 'BotFather token'
$env:TELEGRAM_WEBHOOK_SECRET = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('+','-').Replace('/','_').TrimEnd('=')
$env:TELEGRAM_ALLOWED_USERS = Read-Host 'Numeric Telegram user ID'
$env:MODEL_BASE_URL = 'https://api.openai.com/v1'
$env:MODEL_NAME = 'gpt-4.1-mini'
$env:MODEL_API_KEY = Read-Host 'Model API key'
$env:BOT_SYSTEM_PROMPT = 'You are Hermes-Lite, a concise personal assistant.'
# Optional, activates web tools:
# $env:TAVILY_API_KEY = Read-Host 'Tavily API key'
```

## Build dan deploy dengan CLI

```powershell
Set-Location C:\Users\2024\hermes-lite-botkeep\prisma-compute
npm install
npx prisma auth login
npm run check
npm run deploy
```

Region default `us-east-1` ditetapkan di `prisma.config.ts`. Deploy membuat Compute services `telegram-bot` dan `telegram-worker`, database `bot-database`, dan scheduler Cron. Service `telegram-bot` mendaftarkan Telegram webhook otomatis waktu boot ke URL publiknya sendiri dengan `TELEGRAM_WEBHOOK_SECRET`. Pengaturan awal dari CLI akan menyimpan variable di project/stage Prisma; service `telegram-worker` menerima salinan secret yang sama untuk mengirim balasan.

## Deploy lewat Prisma Console dan GitHub

Console tidak menerima ZIP sebagai runtime aplikasi. Cara langsung dari UI adalah menghubungkan repo GitHub:

1. Buat **private GitHub repository** dari isi folder `prisma-compute/` ini, sehingga `module.ts`, `package.json`, `package-lock.json`, `prisma.config.ts`, `src/`, dan `.github/` berada di root repo.
2. Di Prisma Console, buat project dan set region `us-east-1`.
3. Dari project di Console, pilih GitHub integration dan hubungkan repository tadi. Prisma akan memasang GitHub App; aktifkan repository tersebut.
4. Jalankan satu deploy pertama dari terminal lokal mengikuti langkah sebelumnya agar Composer mem-provision semua input wajib, secret dan resources database.
5. Jika Console meminta, buat/merge PR workflow dari `.github/workflows/prisma-deploy.yml`.
6. Push commit ke branch default `main`; buka tab GitHub **Actions** untuk hasil build/deploy. Setiap branch deploy menggunakan input/secrets tersendiri pada stage itu.

Workflow juga dapat dipakai manual dari checkout lokal setelah Console workspace siap: `npm run deploy`.

## Tes operasi

1. Di Prisma Console, buka service `telegram-bot`, lihat log `Telegram webhook registered at ...`.
2. DM bot `/start`, lalu kirim `Balas hanya dengan: Hermes online`.
3. Periksa log service `telegram-worker`; job scheduler harus jalan setiap 10 detik.
4. Coba `/new`, `/status`, memory, lalu tanyakan kembali memory.

Webhook menyimpan update di Postgres sebelum membalas Telegram `200`. Worker mengambil satu update per tick supaya pemanggilan model tidak melampaui timeout request Compute 60 detik. Cron scheduler sengaja tetap warm di Compute; layanan webhook dan worker dapat scale-to-zero. `/new` menghapus riwayat percakapan, tetapi memory dan todo tetap persisten di Postgres.

Toolset mencakup memory, todo, dan optional web search/extract jika `TAVILY_API_KEY` diisi. Target Prisma ditulis TypeScript sehingga mempertahankan perilaku Hermes-Lite yang diperlukan bot, bukan mengemas runtime Python upstream secara utuh.
