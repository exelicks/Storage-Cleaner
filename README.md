# ⚡ Storage Audit & Cleaner Pro

Aplikasi utilitas Web UI modern dan sistem audit penyimpanan (*storage auditor*) berbasis runtime **Node.js Native** (dan opsi **Python Standard Library**), dibangun khusus untuk memindai folder komputer secara dinamis, mengelompokkan file kembar berdasarkan hash kriptografi **SHA-256**, mendeteksi file raksasa (> 2 MB), serta melakukan pembersihan aman langsung di tempat (*in-place cleanup*) tanpa dependensi eksternal apa pun (**Zero Dependency / Tanpa `npm install`**).

---

## 🌟 Fitur Utama (Sesuai Spesifikasi Sistem)

1. **Input Path Folder Target Dinamis & Tombol Upload Folder (Web UI)**
   - Mendukung input path folder apa pun secara dinamis langsung dari antarmuka Web (default: `./Bahan Latihan P12`).
   - Tidak ada *hardcoded path*; mendukung path relatif maupun path absolut Windows (misal: `C:\Users\...`).
   - **Tombol Upload Folder**: Berada tepat di samping tombol *Pindai Folder*. Memungkinkan pengguna memilih dan mengunggah folder dari komputer secara langsung via browser (`webkitdirectory`), menampilkan *progress bar* real-time, menyimpan struktur hierarki folder ke `./Uploaded_Folders/`, dan otomatis menjalankan audit seketika setelah upload selesai.
   - Tombol shortcut untuk membuka direktori target langsung di **Windows Explorer**.

2. **Pemindaian Rekursif & Hash SHA-256**
   - Menelusuri seluruh folder dan subfolder secara rekursif.
   - Mengumpulkan metadata lengkap: nama file, path absolut, path relatif, ukuran byte, format ukuran manusiawi (KB/MB), waktu modifikasi, dan hash SHA-256 yang dihitung secara *streaming* hemat memori.

3. **Pengelompokan File Duplikat Berdasarkan SHA-256**
   - Mendeteksi file kembar dengan isi biner identik meskipun nama filenya berbeda (contoh: `modul.pdf` dan `modul_BACKUP.pdf`).
   - Menghitung akumulasi pemborosan ruang penyimpanan untuk tiap kluster duplikat.
   - Menandai secara cerdas 1 file tertua sebagai **File Asli (Original)** dan sisanya sebagai **Salinan Duplikat**.

4. **Deteksi File Raksasa (> 2 MB / 2.048 KB)**
   - Mendeteksi dan menandai semua file yang ukurannya melebihi ambang batas 2 MB (2.097.152 bytes) dengan badge **File Raksasa**.

5. **Dashboard Visual Web UI Responsif & Modern**
   - **4 Kartu Metrik Storage**:
     - *Total File*: Jumlah file yang diaudit beserta indikator file sementara.
     - *Total Kapasitas*: Akumulasi kapasitas ruang penyimpanan terpakai.
     - *File Raksasa*: Jumlah dan total ukuran file yang melebihi 2 MB.
     - *Potensi Hemat*: Estimasi kapasitas disk yang dapat dibebaskan dari salinan kembar dan file `.tmp`.
   - **Accordion Grup Duplikat**: Tampilan interaktif per hash SHA-256 dengan pemisahan jelas antara file asli dan salinan kembar.
   - **Tabel File Raksasa**: Menampilkan detail lokasi, ukuran, hash, dan tanggal modifikasi.
   - **Tabel File Sampah (`.tmp`)**: Monitoring file sementara yang siap dibersihkan.
   - **Tabel Semua File**: Eksplorasi seluruh file dalam folder.

6. **Pembersihan Langsung di Tempat (*In-Place Safe Cleaning*)**
   - Tombol **"Bersihkan Duplikat & Sampah"** memicu **Modal Konfirmasi Interaktif**.
   - **Prinsip Keamanan Mutlak**:
     - **In-Place**: Menghapus salinan langsung di tempat tanpa memindahkan atau menduplikasi file ke folder baru.
     - **Proteksi File Asli**: Sistem secara ketat melindungi dan **mempertahankan 1 file asli per kelompok duplikat**.
     - **Pembersihan Sampah**: Menghapus file sementara berekstensi `.tmp`.
     - **Sandbox Boundary**: Mencegah *path traversal* di luar folder target yang dipindai.
   - Otomatis memindai ulang setelah pembersihan dan memperbarui dashboard secara *real-time*.

7. **Otomatis Buka Browser Default**
   - Saat server dinyalakan, dashboard di `http://localhost:3000` akan otomatis terbuka di browser sistem.

---

## 🚀 Cara Menjalankan

### Opsi 1: Menggunakan Node.js (Rekomendasi Utama)
*Menggunakan modul native bawaan Node.js (`http`, `fs`, `path`, `crypto`, `child_process`). Tidak memerlukan `npm install` sama sekali.*

```bash
# Jalankan langsung dengan node
node storage_audit.js

# Atau melalui npm script
npm start
```

### Opsi 2: Menggunakan Python (Alternatif)
*Jika komputer memiliki Python, skrip `storage_audit.py` menggunakan library standar (`http.server`, `os`, `hashlib`, `json`, `webbrowser`) tanpa memerlukan `pip install`.*

```bash
python storage_audit.py
```

---

## 📂 Struktur Direktori Demo Latihan (`./Bahan Latihan P12`)

Aplikasi secara otomatis menyediakan atau dapat membuat ulang folder demo `./Bahan Latihan P12` dengan skenario audit nyata:
- `Modul Kuliah/modul.pdf` (2.6 MB, File Raksasa)
- `Cadangan Arsip/modul_BACKUP.pdf` (2.6 MB, Duplikat identik dari modul.pdf)
- `Draft Proyek/modul_salinan_rev1.pdf` (2.6 MB, Duplikat identik dari modul.pdf)
- `Modul Kuliah/rekaman_kuliah_p12.mp4` (3.1 MB, File Raksasa unik)
- `laporan_p12.docx` (File dokumen normal)
- `Cadangan Arsip/laporan_p12_COPY.docx` (Duplikat identik)
- `~cache_session.tmp` (File sampah sementara)
- `Draft Proyek/render_temp_01.tmp` (File sampah sementara)
- `Modul Kuliah/catatan_kuliah.txt` (File teks normal unik)

---

## 🛡️ Kebijakan Pembersihan (*Cleaning Policy*)

| Kategori | Tindakan Pembersihan | Keterangan |
| :--- | :--- | :--- |
| **File Asli (Original)** | 🛡️ **DIPERTAHANKAN** | File pertama/tertua dalam grup duplikat SHA-256 dijamin aman 100%. |
| **Salinan Kembar** | 🗑️ **DIHAPUS IN-PLACE** | Salinan ke-2, ke-3, dst. yang memiliki isi persis sama dihapus langsung dari foldernya. |
| **File Sampah (`.tmp`)** | 🗑️ **DIHAPUS IN-PLACE** | File sementara dihapus untuk membebaskan ruang. |
| **File Unik Lainnya** | 🛡️ **DIPERTAHANKAN** | File reguler dan file raksasa non-duplikat tidak disentuh sama sekali. |

---

## 💻 Lisensi
MIT - Dibangun untuk efisiensi sistem dan audit penyimpanan lokal berkecepatan tinggi.