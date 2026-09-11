# FlowDeck

Aplikasi desktop multi-akun untuk membuka **Google Flow**, **Dola**, dan **Migoo**
dengan sesi login terpisah per akun, plus pustaka prompt lokal dan simpan video.
Dibangun dengan Electron. Semua data disimpan di komputer Anda — tidak ada server,
tidak ada lisensi, tidak ada auto-update dari pihak luar.

## Fitur

- **Multi-akun**: tiap akun punya sesi login sendiri (partition Electron / profil
  WebView2 terpisah), jadi bisa login banyak akun sekaligus tanpa saling bentrok.
- **Sekali login, semua aplikasi**: satu akun dipakai bersama oleh Google Flow,
  Dola, dan Migoo (sesinya sama). Login Google sekali, lalu di aplikasi lain cukup
  pilih "masuk dengan Google" → akun Google yang sama, tanpa password lagi.
- **Dikelompokkan per aplikasi**: sidebar menampilkan grup Google Flow / Dola /
  Migoo; tombol `+` di tiap grup untuk memakai akun yang sudah ada atau akun baru.
- **Toolbar**: ganti aplikasi untuk akun yang sedang terbuka, kembali/maju, muat
  ulang, zoom tampilan situs, dan sembunyikan sidebar agar situs lebih lebar.
- **Beberapa layanan**: Google Flow, Dola, Migoo. Bisa ditambah di `PROVIDERS`
  (lihat `src/main.js`).
- **Pustaka prompt**: simpan, cari, sematkan, salin, ubah, hapus. Tersimpan lokal.
- **Simpan file**: unduhan dari situs memunculkan dialog "Save As" bawaan Windows.
- Data lokal di `%APPDATA%/FlowDeck` (`accounts.json`, `prompts.json`) dan sesi
  login di folder partition Electron.

## Menjalankan (mode pengembangan)

```bash
npm install
npm start
```

## Membuat installer .exe

```bash
npm run dist
```

Hasilnya ada di folder `dist/`.

## Menambah layanan baru

Edit objek `PROVIDERS` di `src/main.js`:

```js
const PROVIDERS = {
  "google-flow": { label: "Google Flow", url: "https://flow.google" },
  dola: { label: "Dola", url: "https://www.dola.com/chat/" },
  migoo: { label: "Migoo", url: "https://migoo.ai/" },
  // tambah di sini
};
```

Untuk versi Tauri, tambahkan juga di `PROVIDERS` pada `src/renderer/tauri-bridge.js`
dan `provider_url` di `src-tauri/src/webviews.rs`. Ikon/nama pendek di toolbar diatur
di `APP_META` (`src/renderer/app.js`).

## Catatan

- Anda tetap login ke layanan (mis. Google) di dalam aplikasi ini. Sesi tersimpan
  lokal per akun. Gunakan sesuai ketentuan masing-masing layanan.
- Ini kode Anda sendiri, bukan turunan dari aplikasi lain.
