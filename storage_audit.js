/**
 * ==============================================================================
 * STORAGE AUDIT & CLEANER PRO
 * File: storage_audit.js
 * 
 * Utilitas Web UI berbasis Node.js Native untuk audit dan pembersihan penyimpanan.
 * Runtime: Node.js (modul bawaan: http, fs, path, crypto, child_process)
 * DEPENDENSI EKSTERNAL: 0 (Tanpa npm install)
 * ==============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const url = require('url');

// Port default server
const DEFAULT_PORT = 3000;
const GIANT_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB = 2.048 KB = 2.097.152 bytes

/**
 * Format bytes ke representasi terbaca (B, KB, MB, GB)
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Menghitung SHA-256 hash file secara streaming
 */
function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Memindai direktori secara rekursif
 */
function scanDirectoryRecursively(dirPath, rootDir, collectedFiles = []) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          scanDirectoryRecursively(fullPath, rootDir, collectedFiles);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          const isGiant = stats.size >= GIANT_FILE_THRESHOLD_BYTES;
          const isTmp = entry.name.toLowerCase().endsWith('.tmp');

          collectedFiles.push({
            name: entry.name,
            fullPath: path.resolve(fullPath),
            relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
            sizeBytes: stats.size,
            sizeFormatted: formatBytes(stats.size),
            mtime: stats.mtimeMs,
            mtimeFormatted: stats.mtime.toLocaleString('id-ID', {
              year: 'numeric',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            }),
            isGiant,
            isTmp
          });
        }
      } catch (fileErr) {
        // Abaikan file yang terkunci atau tidak memiliki izin akses
        console.warn(`[Peringatan] Lewati file: ${fullPath} (${fileErr.message})`);
      }
    }
  } catch (dirErr) {
    console.warn(`[Peringatan] Lewati direktori: ${dirPath} (${dirErr.message})`);
  }
  return collectedFiles;
}

/**
 * Logika inti audit storage
 */
async function auditStorageFolder(targetFolderPath) {
  const resolvedTarget = path.resolve(process.cwd(), targetFolderPath);

  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`Folder tidak ditemukan: "${targetFolderPath}" (Path absolut: ${resolvedTarget})`);
  }

  const stat = fs.statSync(resolvedTarget);
  if (!stat.isDirectory()) {
    throw new Error(`Path bukan merupakan direktori: "${targetFolderPath}"`);
  }

  // 1. Kumpulkan seluruh file secara rekursif
  const rawFiles = scanDirectoryRecursively(resolvedTarget, resolvedTarget, []);

  // 2. Hitung hash SHA-256 untuk tiap file
  for (const file of rawFiles) {
    try {
      file.sha256 = await calculateFileHash(file.fullPath);
    } catch (hErr) {
      file.sha256 = 'ERROR_CALCULATING_HASH';
    }
  }

  // 3. Kelompokkan file berdasarkan hash SHA-256
  const hashMap = {};
  for (const file of rawFiles) {
    if (file.sha256 === 'ERROR_CALCULATING_HASH') continue;
    if (!hashMap[file.sha256]) {
      hashMap[file.sha256] = [];
    }
    hashMap[file.sha256].push(file);
  }

  // 4. Identifikasi grup duplikat
  const duplicateGroups = [];
  let totalWastedDuplicateBytes = 0;
  const duplicateFilePathsSet = new Set();

  for (const [hashVal, files] of Object.entries(hashMap)) {
    if (files.length > 1) {
      // Urutkan file berdasarkan waktu modifikasi tertua sebagai file asli (original)
      files.sort((a, b) => a.mtime - b.mtime);
      const originalFile = files[0];
      const duplicatesList = files.slice(1);

      const wastedForGroup = duplicatesList.reduce((acc, f) => acc + f.sizeBytes, 0);
      totalWastedDuplicateBytes += wastedForGroup;

      duplicatesList.forEach(dup => duplicateFilePathsSet.add(dup.fullPath));

      duplicateGroups.push({
        hash: hashVal,
        fileSize: originalFile.sizeBytes,
        fileSizeFormatted: formatBytes(originalFile.sizeBytes),
        totalCount: files.length,
        originalFile: originalFile,
        duplicateFiles: duplicatesList,
        wastedBytes: wastedForGroup,
        wastedFormatted: formatBytes(wastedForGroup)
      });
    }
  }

  // 5. Identifikasi file raksasa (> 2 MB)
  const giantFiles = rawFiles
    .filter(f => f.isGiant)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const giantFilesCount = giantFiles.length;
  const giantFilesTotalBytes = giantFiles.reduce((acc, f) => acc + f.sizeBytes, 0);

  // 6. Identifikasi file sampah (.tmp)
  const tmpFiles = rawFiles.filter(f => f.isTmp);
  // Hitung potensi hemat dari file .tmp yang belum terhitung dalam duplicate set
  let tmpSavingsBytes = 0;
  for (const tmpFile of tmpFiles) {
    if (!duplicateFilePathsSet.has(tmpFile.fullPath)) {
      tmpSavingsBytes += tmpFile.sizeBytes;
    }
  }

  const potentialSavingsBytes = totalWastedDuplicateBytes + tmpSavingsBytes;
  const totalCapacityBytes = rawFiles.reduce((acc, f) => acc + f.sizeBytes, 0);

  return {
    targetFolder: targetFolderPath,
    resolvedTarget: resolvedTarget,
    scanTimestamp: new Date().toISOString(),
    metrics: {
      totalFiles: rawFiles.length,
      totalCapacityBytes: totalCapacityBytes,
      totalCapacityFormatted: formatBytes(totalCapacityBytes),
      giantFilesCount: giantFilesCount,
      giantFilesBytes: giantFilesTotalBytes,
      giantFilesFormatted: formatBytes(giantFilesTotalBytes),
      potentialSavingsBytes: potentialSavingsBytes,
      potentialSavingsFormatted: formatBytes(potentialSavingsBytes),
      duplicateGroupsCount: duplicateGroups.length,
      duplicateCopiesCount: duplicateFilePathsSet.size,
      tmpFilesCount: tmpFiles.length,
      tmpFilesBytes: tmpFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
      tmpFilesFormatted: formatBytes(tmpFiles.reduce((acc, f) => acc + f.sizeBytes, 0))
    },
    giantFiles: giantFiles,
    duplicateGroups: duplicateGroups,
    tmpFiles: tmpFiles,
    allFiles: rawFiles
  };
}

/**
 * Logika pembersihan in-place
 * Menghapus file duplikat (tetap mempertahankan 1 file asli per grup) dan file .tmp
 */
async function cleanDuplicatesAndJunk(targetFolderPath, selectedFilePaths = null) {
  const audit = await auditStorageFolder(targetFolderPath);
  const resolvedTarget = audit.resolvedTarget;

  // Himpunan file asli yang WAJIB DILINDUNGI
  const protectedOriginals = new Set(audit.duplicateGroups.map(g => path.resolve(g.originalFile.fullPath)));

  // Himpunan file yang ditargetkan untuk dihapus:
  // 1. Semua file duplikat (bukan file asli)
  // 2. Semua file .tmp
  const targetDeletionSet = new Set();

  for (const group of audit.duplicateGroups) {
    for (const dup of group.duplicateFiles) {
      targetDeletionSet.add(path.resolve(dup.fullPath));
    }
  }

  for (const tmp of audit.tmpFiles) {
    targetDeletionSet.add(path.resolve(tmp.fullPath));
  }

  // Jika client mengirim daftar spesifik, lakukan filter
  let filesToDelete = Array.from(targetDeletionSet);
  if (Array.isArray(selectedFilePaths) && selectedFilePaths.length > 0) {
    const selectedNormalized = new Set(selectedFilePaths.map(p => path.resolve(p)));
    filesToDelete = filesToDelete.filter(fp => selectedNormalized.has(fp));
  }

  const deletedFiles = [];
  const errors = [];
  let totalFreedBytes = 0;

  for (const filePath of filesToDelete) {
    const normalizedPath = path.resolve(filePath);

    // KEAMANAN 1: Jangan pernah hapus file asli yang dilindungi!
    if (protectedOriginals.has(normalizedPath)) {
      errors.push({ file: normalizedPath, error: 'DITOLAK: File ini adalah salinan asli yang dilindungi!' });
      continue;
    }

    // KEAMANAN 2: Pastikan file berada di dalam target folder (mencegah traversal path)
    const relative = path.relative(resolvedTarget, normalizedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push({ file: normalizedPath, error: 'DITOLAK: File berada di luar folder target yang dipindai!' });
      continue;
    }

    try {
      if (fs.existsSync(normalizedPath)) {
        const stats = fs.statSync(normalizedPath);
        const fSize = stats.size;
        // Hapus in-place langsung dari folder
        fs.unlinkSync(normalizedPath);
        totalFreedBytes += fSize;
        deletedFiles.push({
          fullPath: normalizedPath,
          relativePath: relative.replace(/\\/g, '/'),
          sizeBytes: fSize,
          sizeFormatted: formatBytes(fSize)
        });
      }
    } catch (delErr) {
      errors.push({ file: normalizedPath, error: delErr.message });
    }
  }

  return {
    success: true,
    deletedCount: deletedFiles.length,
    freedBytes: totalFreedBytes,
    freedFormatted: formatBytes(totalFreedBytes),
    deletedFiles: deletedFiles,
    errors: errors
  };
}

/**
 * Template Web UI Dashboard
 */
function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage Audit & Cleaner Pro</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0b0f19;
      --bg-card: rgba(18, 24, 38, 0.75);
      --bg-card-hover: rgba(28, 38, 59, 0.85);
      --border-color: rgba(255, 255, 255, 0.08);
      --border-focus: #38bdf8;
      
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      
      --accent-blue: #38bdf8;
      --accent-blue-glow: rgba(56, 189, 248, 0.25);
      --accent-purple: #c084fc;
      --accent-purple-glow: rgba(192, 132, 252, 0.25);
      --accent-amber: #fbbf24;
      --accent-amber-glow: rgba(251, 191, 36, 0.25);
      --accent-emerald: #34d399;
      --accent-emerald-glow: rgba(52, 211, 153, 0.25);
      --accent-rose: #f43f5e;
      --accent-rose-glow: rgba(244, 63, 94, 0.25);
      
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 20px;
      --shadow-glass: 0 8px 32px 0 rgba(0, 0, 0, 0.45);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-dark);
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(56, 189, 248, 0.07) 0%, transparent 40%),
        radial-gradient(circle at 85% 25%, rgba(192, 132, 252, 0.07) 0%, transparent 40%),
        radial-gradient(circle at 50% 85%, rgba(52, 211, 153, 0.05) 0%, transparent 45%);
      background-attachment: fixed;
      color: var(--text-main);
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }

    /* Container */
    .app-container {
      max-width: 1320px;
      width: 100%;
      margin: 0 auto;
      padding: 28px 24px 60px;
      flex: 1;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-color);
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand-title {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-logo {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 24px var(--accent-blue-glow);
    }

    .brand-logo svg {
      width: 28px;
      height: 28px;
      fill: #ffffff;
    }

    .brand-text h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-text p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .header-badges {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .badge-runtime {
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--accent-blue);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--accent-emerald);
      box-shadow: 0 0 10px var(--accent-emerald);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }

    /* Search & Scan Control Bar */
    .control-panel {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 22px 24px;
      box-shadow: var(--shadow-glass);
      margin-bottom: 32px;
    }

    .control-panel-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .input-form {
      display: flex;
      gap: 12px;
      align-items: stretch;
      flex-wrap: wrap;
    }

    .input-wrapper {
      position: relative;
      flex: 1;
      min-width: 320px;
    }

    .input-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      pointer-events: none;
      display: flex;
    }

    .folder-input {
      width: 100%;
      height: 52px;
      background: rgba(11, 15, 25, 0.7);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 0 18px 0 48px;
      color: #fff;
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      transition: all 0.2s ease;
    }

    .folder-input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 4px var(--accent-blue-glow);
      background: rgba(15, 23, 42, 0.9);
    }

    .btn {
      height: 52px;
      padding: 0 24px;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      border: none;
      white-space: nowrap;
    }

    .btn:active {
      transform: scale(0.98);
    }

    .btn-primary {
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #ffffff;
      box-shadow: 0 4px 16px rgba(37, 99, 235, 0.35);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #0369a1 0%, #1d4ed8 100%);
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.5);
    }

    .btn-upload {
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      color: #ffffff;
      box-shadow: 0 4px 16px rgba(139, 92, 246, 0.35);
    }

    .btn-upload:hover {
      background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
      box-shadow: 0 6px 20px rgba(139, 92, 246, 0.5);
    }

    .upload-progress-container {
      background: rgba(11, 15, 25, 0.7);
      border-radius: var(--radius-sm);
      overflow: hidden;
      height: 10px;
      margin: 16px 0;
      border: 1px solid var(--border-color);
    }

    .upload-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #8b5cf6, #38bdf8);
      width: 0%;
      transition: width 0.15s ease;
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.5);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-main);
      border: 1px solid var(--border-color);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-danger {
      background: linear-gradient(135deg, #e11d48 0%, #be123c 100%);
      color: #ffffff;
      box-shadow: 0 4px 16px rgba(225, 29, 72, 0.35);
    }

    .btn-danger:hover {
      background: linear-gradient(135deg, #be123c 0%, #9f1239 100%);
      box-shadow: 0 6px 20px rgba(225, 29, 72, 0.5);
    }

    .quick-chips {
      display: flex;
      gap: 10px;
      margin-top: 14px;
      flex-wrap: wrap;
      align-items: center;
    }

    .chip-label {
      font-size: 12px;
      color: var(--text-dim);
    }

    .chip-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      border-radius: 9999px;
      padding: 4px 12px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      transition: all 0.15s;
    }

    .chip-btn:hover {
      background: rgba(56, 189, 248, 0.1);
      color: var(--accent-blue);
      border-color: rgba(56, 189, 248, 0.3);
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }

    .metric-card {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: var(--shadow-glass);
      transition: transform 0.2s, border-color 0.2s;
      position: relative;
      overflow: hidden;
    }

    .metric-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
    }

    .card-cyan::before { background: linear-gradient(90deg, #38bdf8, #0284c7); }
    .card-purple::before { background: linear-gradient(90deg, #c084fc, #9333ea); }
    .card-amber::before { background: linear-gradient(90deg, #fbbf24, #d97706); }
    .card-emerald::before { background: linear-gradient(90deg, #34d399, #059669); }

    .metric-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .metric-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .metric-icon-badge {
      width: 40px;
      height: 40px;
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-cyan .metric-icon-badge { background: rgba(56, 189, 248, 0.1); color: var(--accent-blue); }
    .card-purple .metric-icon-badge { background: rgba(192, 132, 252, 0.1); color: var(--accent-purple); }
    .card-amber .metric-icon-badge { background: rgba(251, 191, 36, 0.1); color: var(--accent-amber); }
    .card-emerald .metric-icon-badge { background: rgba(52, 211, 153, 0.1); color: var(--accent-emerald); }

    .metric-value {
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
      color: #ffffff;
      font-feature-settings: "cv02", "cv03", "cv04", "cv11";
    }

    .metric-subtitle {
      font-size: 12px;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Clean Callout Bar */
    .clean-callout {
      background: linear-gradient(135deg, rgba(244, 63, 94, 0.15) 0%, rgba(192, 132, 252, 0.1) 100%);
      border: 1px solid rgba(244, 63, 94, 0.35);
      border-radius: var(--radius-lg);
      padding: 22px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      box-shadow: 0 8px 30px rgba(244, 63, 94, 0.12);
      flex-wrap: wrap;
      gap: 16px;
    }

    .callout-info h3 {
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .callout-info p {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Tabs */
    .tabs-nav {
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 24px;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .tab-button {
      background: transparent;
      border: none;
      padding: 12px 20px;
      color: var(--text-muted);
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border-radius: var(--radius-md) var(--radius-md) 0 0;
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .tab-button:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.03);
    }

    .tab-button.active {
      color: var(--accent-blue);
    }

    .tab-button.active::after {
      content: '';
      position: absolute;
      bottom: -4px;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--accent-blue);
      border-radius: 4px;
      box-shadow: 0 0 10px var(--accent-blue);
    }

    .tab-count {
      background: rgba(255, 255, 255, 0.08);
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 9999px;
      font-weight: 700;
    }

    .tab-button.active .tab-count {
      background: rgba(56, 189, 248, 0.2);
      color: var(--accent-blue);
    }

    /* Content Panes */
    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Table Styles */
    .table-card {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-glass);
      overflow: hidden;
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }

    thead th {
      background: rgba(11, 15, 25, 0.85);
      padding: 16px 20px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.8px;
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
    }

    tbody td {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text-main);
      vertical-align: middle;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }

    .badge-giant {
      background: rgba(251, 191, 36, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(251, 191, 36, 0.3);
    }

    .badge-original {
      background: rgba(52, 211, 153, 0.15);
      color: #34d399;
      border: 1px solid rgba(52, 211, 153, 0.3);
    }

    .badge-duplicate {
      background: rgba(244, 63, 94, 0.15);
      color: #f43f5e;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .badge-tmp {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }

    .code-pill {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--accent-blue);
      background: rgba(56, 189, 248, 0.08);
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.2);
      display: inline-block;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }

    /* Accordion Duplikat */
    .accordion-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .accordion-item {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-glass);
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .accordion-item:hover {
      border-color: rgba(255, 255, 255, 0.15);
    }

    .accordion-header {
      padding: 18px 24px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(11, 15, 25, 0.4);
      user-select: none;
      flex-wrap: wrap;
      gap: 12px;
    }

    .accordion-header:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .accordion-title-block {
      display: flex;
      align-items: center;
      gap: 14px;
      flex: 1;
      min-width: 280px;
    }

    .accordion-stats-block {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .chevron-icon {
      transition: transform 0.2s ease;
      display: flex;
    }

    .accordion-item.open .chevron-icon {
      transform: rotate(180deg);
    }

    .accordion-body {
      display: none;
      padding: 20px 24px;
      border-top: 1px solid var(--border-color);
      background: rgba(11, 15, 25, 0.6);
    }

    .accordion-item.open .accordion-body {
      display: block;
      animation: fadeIn 0.2s ease;
    }

    .duplicate-file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      margin-bottom: 8px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      gap: 12px;
      flex-wrap: wrap;
    }

    .duplicate-file-row.original {
      border-color: rgba(52, 211, 153, 0.3);
      background: rgba(52, 211, 153, 0.05);
    }

    .duplicate-file-row.duplicate {
      border-color: rgba(244, 63, 94, 0.25);
      background: rgba(244, 63, 94, 0.04);
    }

    .file-main-info {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 260px;
    }

    .file-meta-info {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 12px;
      color: var(--text-dim);
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }

    .modal-backdrop.show {
      display: flex;
      animation: fadeIn 0.2s ease;
    }

    .modal-dialog {
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius-lg);
      max-width: 640px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      overflow: hidden;
      animation: scaleUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes scaleUp {
      from { transform: scale(0.95); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .modal-header {
      padding: 24px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header h3 {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #fff;
    }

    .modal-close-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px;
      border-radius: 4px;
      transition: color 0.15s;
    }

    .modal-close-btn:hover {
      color: #fff;
    }

    .modal-body {
      padding: 24px;
      max-height: 460px;
      overflow-y: auto;
    }

    .modal-summary-box {
      background: rgba(244, 63, 94, 0.08);
      border: 1px solid rgba(244, 63, 94, 0.25);
      border-radius: var(--radius-md);
      padding: 16px 20px;
      margin-bottom: 20px;
    }

    .modal-summary-box ul {
      margin-left: 20px;
      margin-top: 10px;
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .modal-file-list {
      background: rgba(11, 15, 25, 0.6);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 12px;
      max-height: 180px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #cbd5e1;
    }

    .modal-file-item {
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .modal-footer {
      padding: 20px 24px;
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      background: rgba(11, 15, 25, 0.4);
    }

    /* Toast Notifications */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .toast {
      background: #1e293b;
      border: 1px solid var(--border-color);
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      border-radius: var(--radius-md);
      padding: 14px 20px;
      font-size: 13px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
      animation: slideIn 0.2s ease;
      min-width: 280px;
    }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    .toast-success { border-left: 4px solid var(--accent-emerald); }
    .toast-error { border-left: 4px solid var(--accent-rose); }
    .toast-info { border-left: 4px solid var(--accent-blue); }

    /* Empty State */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-dim);
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.7;
    }

    .empty-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .empty-desc {
      font-size: 13px;
      max-width: 440px;
      margin: 0 auto;
    }

    /* Loading overlay */
    .loading-spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Footer */
    footer {
      text-align: center;
      padding: 20px;
      font-size: 12px;
      color: var(--text-dim);
      border-top: 1px solid rgba(255, 255, 255, 0.04);
    }

    @media (max-width: 768px) {
      .input-form {
        flex-direction: column;
      }
      .btn {
        width: 100%;
      }
      .metrics-grid {
        grid-template-columns: 1fr;
      }
      .header-badges {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Header -->
    <header>
      <div class="brand-title">
        <div class="brand-logo">
          <svg viewBox="0 0 24 24">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
          </svg>
        </div>
        <div class="brand-text">
          <h1>Storage Audit & Cleaner Pro</h1>
          <p>Auditor Penyimpanan Cerdas, Deteksi Duplikat SHA-256 & Pembersih In-Place</p>
        </div>
      </div>
      <div class="header-badges">
        <div class="badge-runtime">
          <span class="status-dot"></span>
          Node.js Native Runtime
        </div>
        <div class="badge-runtime" style="color: var(--accent-purple); border-color: rgba(192, 132, 252, 0.3); background: rgba(192, 132, 252, 0.08);">
          Zero Dependency
        </div>
      </div>
    </header>

    <!-- Target Folder Input Control Panel -->
    <section class="control-panel">
      <div class="control-panel-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>
        Konfigurasi Path Folder Target Dinamis
      </div>
      <form id="scanForm" class="input-form" onsubmit="event.preventDefault(); triggerScan();">
        <div class="input-wrapper">
          <span class="input-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          </span>
          <input 
            type="text" 
            id="folderPathInput" 
            class="folder-input" 
            placeholder="Masukkan path folder (contoh: ./Bahan Latihan P12 atau C:/Data)" 
            value="./Bahan Latihan P12"
            spellcheck="false"
            autocomplete="off"
            required
          >
        </div>
        <button type="submit" id="btnScan" class="btn btn-primary">
          <span id="scanSpinner" style="display: none;" class="loading-spinner"></span>
          <svg id="scanIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          Pindai Folder
        </button>
        <button type="button" id="btnUploadFolder" class="btn btn-upload" onclick="triggerFolderUpload()" title="Pilih & upload folder dari komputer untuk diaudit">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Upload Folder
        </button>
        <input type="file" id="folderUploadInput" webkitdirectory directory multiple style="display: none;" onchange="handleFolderSelected(event)">
        <button type="button" id="btnOpenExplorer" class="btn btn-secondary" onclick="openFolderInExplorer()" title="Buka folder ini langsung di Windows Explorer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          Buka Explorer
        </button>
      </form>
      <div class="quick-chips">
        <span class="chip-label">Preset Cepat:</span>
        <button type="button" class="chip-btn" onclick="setFolderPath('./Bahan Latihan P12')">./Bahan Latihan P12 (Default)</button>
        <button type="button" class="chip-btn" onclick="setFolderPath('./')">./ (Root Proyek)</button>
        <button type="button" class="chip-btn" onclick="resetSampleFolder()" style="color: var(--accent-emerald);">+ Buat Ulang File Demo</button>
      </div>
    </section>

    <!-- 4 Storage Metric Cards -->
    <section class="metrics-grid">
      <!-- Card 1: Total File -->
      <div class="metric-card card-cyan">
        <div class="metric-header">
          <span class="metric-title">Total File</span>
          <div class="metric-icon-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalFiles">0</div>
        <div class="metric-subtitle">
          <span id="valTmpSub">0 file sementara (.tmp)</span>
        </div>
      </div>

      <!-- Card 2: Total Kapasitas -->
      <div class="metric-card card-purple">
        <div class="metric-header">
          <span class="metric-title">Total Kapasitas</span>
          <div class="metric-icon-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
              <line x1="6" y1="6" x2="6.01" y2="6"></line>
              <line x1="6" y1="18" x2="6.01" y2="18"></line>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valTotalCapacity">0 B</div>
        <div class="metric-subtitle">
          <span id="valBytesSub">0 bytes terpakai</span>
        </div>
      </div>

      <!-- Card 3: File Raksasa (> 2 MB) -->
      <div class="metric-card card-amber">
        <div class="metric-header">
          <span class="metric-title">File Raksasa (> 2 MB)</span>
          <div class="metric-icon-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valGiantFiles">0</div>
        <div class="metric-subtitle">
          <span id="valGiantBytesSub">Total 0 B (> 2.048 KB)</span>
        </div>
      </div>

      <!-- Card 4: Potensi Hemat -->
      <div class="metric-card card-emerald">
        <div class="metric-header">
          <span class="metric-title">Potensi Hemat</span>
          <div class="metric-icon-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18"></path>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
        </div>
        <div class="metric-value" id="valPotentialSavings" style="color: var(--accent-emerald);">0 B</div>
        <div class="metric-subtitle">
          <span id="valSavingsSub">0 salinan duplikat terdeteksi</span>
        </div>
      </div>
    </section>

    <!-- Clean Action Callout Banner -->
    <div id="cleanCallout" class="clean-callout" style="display: none;">
      <div class="callout-info">
        <h3>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          Peluang Pembebasan Ruang Penyimpanan Ditemukan!
        </h3>
        <p id="cleanCalloutText">Ditemukan file salinan identik dan file sampah sementara yang dapat dibersihkan secara in-place.</p>
      </div>
      <button class="btn btn-danger" onclick="openCleanConfirmationModal()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18"></path>
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
        </svg>
        Bersihkan Duplikat & Sampah
      </button>
    </div>

    <!-- Navigation Tabs -->
    <div class="tabs-nav">
      <button class="tab-button active" onclick="switchTab('tabDuplicates')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Grup Duplikat SHA-256
        <span class="tab-count" id="countTabDuplicates">0</span>
      </button>
      <button class="tab-button" onclick="switchTab('tabGiants')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        Tabel File Raksasa (> 2 MB)
        <span class="tab-count" id="countTabGiants">0</span>
      </button>
      <button class="tab-button" onclick="switchTab('tabTmp')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="9" y1="15" x2="15" y2="15"></line>
        </svg>
        File Sampah (.tmp)
        <span class="tab-count" id="countTabTmp">0</span>
      </button>
      <button class="tab-button" onclick="switchTab('tabAll')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="8" y1="6" x2="21" y2="6"></line>
          <line x1="8" y1="12" x2="21" y2="12"></line>
          <line x1="8" y1="18" x2="21" y2="18"></line>
          <line x1="3" y1="6" x2="3.01" y2="6"></line>
          <line x1="3" y1="12" x2="3.01" y2="12"></line>
          <line x1="3" y1="18" x2="3.01" y2="18"></line>
        </svg>
        Semua File Dipindai
        <span class="tab-count" id="countTabAll">0</span>
      </button>
    </div>

    <!-- TAB 1: Accordion Grup Duplikat -->
    <div id="tabDuplicates" class="tab-pane active">
      <div id="duplicatesContainer" class="accordion-list">
        <!-- Rendered via JS -->
      </div>
    </div>

    <!-- TAB 2: Tabel File Raksasa (> 2 MB) -->
    <div id="tabGiants" class="tab-pane">
      <div class="table-card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Nama File</th>
                <th>Lokasi Relatif</th>
                <th>Ukuran</th>
                <th>Hash SHA-256</th>
                <th>Terakhir Dimodifikasi</th>
              </tr>
            </thead>
            <tbody id="giantsTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 3: File Sampah (.tmp) -->
    <div id="tabTmp" class="tab-pane">
      <div class="table-card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Tipe</th>
                <th>Nama File</th>
                <th>Lokasi Relatif</th>
                <th>Ukuran</th>
                <th>Terakhir Dimodifikasi</th>
              </tr>
            </thead>
            <tbody id="tmpTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 4: Semua File -->
    <div id="tabAll" class="tab-pane">
      <div class="table-card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Nama File</th>
                <th>Kategori</th>
                <th>Lokasi Relatif</th>
                <th>Ukuran</th>
                <th>Hash SHA-256</th>
                <th>Waktu Dimodifikasi</th>
              </tr>
            </thead>
            <tbody id="allFilesTableBody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Interactive Confirmation Modal for In-Place Cleaning -->
  <div id="cleanModal" class="modal-backdrop">
    <div class="modal-dialog">
      <div class="modal-header">
        <h3>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          Konfirmasi Pembersihan In-Place
        </h3>
        <button class="modal-close-btn" onclick="closeCleanModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-summary-box">
          <strong style="color: #f43f5e; font-size: 14px;">PERINGATAN: Tindakan ini akan menghapus file secara permanen di tempat (in-place)!</strong>
          <p style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
            Sistem telah memverifikasi integritas hash SHA-256 dan memastikan:
          </p>
          <ul>
            <li><strong>1 file asli per kelompok duplikat</strong> dipastikan <span style="color: var(--accent-emerald);">TETAP AMAN & DIPERTAHANKAN</span>.</li>
            <li>Hanya salinan kembar tambahan dan file <span class="code-pill">.tmp</span> yang akan dihapus.</li>
            <li>Total <strong id="modalFreedText">0 MB</strong> ruang penyimpanan akan segera dibebaskan.</li>
          </ul>
        </div>
        
        <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;">
          DAFTAR FILE YANG AKAN DIHAPUS (<span id="modalFileCount">0</span> File):
        </div>
        <div class="modal-file-list" id="modalFileList">
          <!-- Rendered dynamically -->
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeCleanModal()">Batal</button>
        <button type="button" id="btnConfirmDelete" class="btn btn-danger" onclick="executeInPlaceClean()">
          <span id="deleteSpinner" style="display: none;" class="loading-spinner"></span>
          <svg id="deleteIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18"></path>
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
          </svg>
          Konfirmasi & Hapus Sekarang
        </button>
      </div>
    </div>
  </div>

  <!-- Upload Progress Modal -->
  <div id="uploadModal" class="modal-backdrop">
    <div class="modal-dialog">
      <div class="modal-header">
        <h3>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Mengunggah Folder ke Sistem Audit
        </h3>
      </div>
      <div class="modal-body">
        <p id="uploadStatusText" style="font-size: 14px; font-weight: 700; color: #fff;">Mempersiapkan berkas...</p>
        <p id="uploadDetailText" style="font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--text-muted); margin-top: 6px; word-break: break-all;">Sedang memproses struktur folder...</p>
        <div class="upload-progress-container">
          <div id="uploadProgressBar" class="upload-progress-bar"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--text-dim); margin-top: 4px;">
          <span id="uploadProgressCount">0 / 0 File</span>
          <span id="uploadProgressPercent" style="color: var(--accent-purple);">0%</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div class="toast-container" id="toastContainer"></div>

  <!-- Footer -->
  <footer>
    Storage Audit & Cleaner Pro &copy; 2026 &bull; Node.js Native HTTP Server &bull; Zero External NPM Dependencies
  </footer>

  <script>
    // State Aplikasi
    let currentAuditData = null;

    // Toast helper
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.innerHTML = '<span>' + message + '</span>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // Ubah Folder Input
    function setFolderPath(newPath) {
      document.getElementById('folderPathInput').value = newPath;
      triggerScan();
    }

    // Salin Teks
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Hash SHA-256 berhasil disalin ke clipboard!', 'success');
      }).catch(() => {
        showToast('Gagal menyalin hash.', 'error');
      });
    }

    // Switch Tabs
    function switchTab(tabId) {
      document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));

      const activeBtn = Array.from(document.querySelectorAll('.tab-button')).find(b => b.getAttribute('onclick').includes(tabId));
      if (activeBtn) activeBtn.classList.add('active');

      const targetPane = document.getElementById(tabId);
      if (targetPane) targetPane.classList.add('active');
    }

    // Toggle Accordion Item
    function toggleAccordion(elem) {
      elem.classList.toggle('open');
    }

    // Buka Folder di Windows Explorer
    async function openFolderInExplorer() {
      const folderPath = document.getElementById('folderPathInput').value.trim();
      if (!folderPath) return;

      try {
        const res = await fetch('/api/open-explorer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Folder dibuka di file explorer.', 'info');
        } else {
          showToast(data.error || 'Gagal membuka explorer.', 'error');
        }
      } catch (err) {
        showToast('Gagal memanggil explorer: ' + err.message, 'error');
      }
    }

    // Reset Sample Folder jika user ingin mencoba lagi
    async function resetSampleFolder() {
      try {
        showToast('Membuat ulang file demo di ./Bahan Latihan P12...', 'info');
        const res = await fetch('/api/reset-sample', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('File demo berhasil dibuat ulang!', 'success');
          document.getElementById('folderPathInput').value = './Bahan Latihan P12';
          triggerScan();
        } else {
          showToast('Gagal membuat sample: ' + data.error, 'error');
        }
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      }
    }

    // Jalankan Audit Pemindaian Folder
    async function triggerScan() {
      const folderPath = document.getElementById('folderPathInput').value.trim();
      if (!folderPath) {
        showToast('Silakan masukkan path folder target.', 'error');
        return;
      }

      const btnScan = document.getElementById('btnScan');
      const scanSpinner = document.getElementById('scanSpinner');
      const scanIcon = document.getElementById('scanIcon');

      btnScan.disabled = true;
      scanSpinner.style.display = 'inline-block';
      scanIcon.style.display = 'none';

      try {
        const response = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });

        const data = await response.json();

        if (!response.ok || data.error) {
          showToast(data.error || 'Gagal memindai folder.', 'error');
          return;
        }

        currentAuditData = data;
        renderDashboard(data);
        showToast('Pemindaian selesai: ' + data.metrics.totalFiles + ' file berhasil diaudit!', 'success');
      } catch (err) {
        showToast('Gagal terhubung ke server: ' + err.message, 'error');
      } finally {
        btnScan.disabled = false;
        scanSpinner.style.display = 'none';
        scanIcon.style.display = 'inline-block';
      }
    }

    // Render Data ke Dashboard
    function renderDashboard(data) {
      const m = data.metrics;

      // 1. Metric Cards
      document.getElementById('valTotalFiles').textContent = m.totalFiles;
      document.getElementById('valTmpSub').textContent = m.tmpFilesCount + ' file sementara (.tmp)';

      document.getElementById('valTotalCapacity').textContent = m.totalCapacityFormatted;
      document.getElementById('valBytesSub').textContent = m.totalCapacityBytes.toLocaleString('id-ID') + ' bytes terpakai';

      document.getElementById('valGiantFiles').textContent = m.giantFilesCount;
      document.getElementById('valGiantBytesSub').textContent = 'Total ' + m.giantFilesFormatted + ' (> 2.048 KB)';

      document.getElementById('valPotentialSavings').textContent = m.potentialSavingsFormatted;
      document.getElementById('valSavingsSub').textContent = m.duplicateCopiesCount + ' salinan kembar dapat dibersihkan';

      // Tab Counts
      document.getElementById('countTabDuplicates').textContent = data.duplicateGroups.length;
      document.getElementById('countTabGiants').textContent = data.giantFiles.length;
      document.getElementById('countTabTmp').textContent = data.tmpFiles.length;
      document.getElementById('countTabAll').textContent = data.allFiles.length;

      // Clean Callout
      const cleanCallout = document.getElementById('cleanCallout');
      if (m.potentialSavingsBytes > 0) {
        cleanCallout.style.display = 'flex';
        document.getElementById('cleanCalloutText').textContent = 
          'Ditemukan ' + m.duplicateCopiesCount + ' salinan duplikat dan ' + m.tmpFilesCount + 
          ' file sampah (.tmp). Bersihkan untuk menghemat ' + m.potentialSavingsFormatted + ' ruang penyimpanan!';
      } else {
        cleanCallout.style.display = 'none';
      }

      // Render Tab 1: Duplikat Accordion
      renderDuplicatesTab(data.duplicateGroups);

      // Render Tab 2: File Raksasa
      renderGiantsTab(data.giantFiles);

      // Render Tab 3: File Tmp
      renderTmpTab(data.tmpFiles);

      // Render Tab 4: Semua File
      renderAllFilesTab(data.allFiles);
    }

    function renderDuplicatesTab(groups) {
      const container = document.getElementById('duplicatesContainer');
      if (!groups || groups.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">🎉</div>
            <div class="empty-title">Tidak Ada File Duplikat Identik</div>
            <p class="empty-desc">Semua file dalam direktori ini memiliki isi hash SHA-256 yang unik. Tidak ditemukan pemborosan ruang dari file kembar.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = groups.map((g, idx) => {
        const shortHash = g.hash.substring(0, 16) + '...';
        return \`
          <div class="accordion-item \${idx === 0 ? 'open' : ''}">
            <div class="accordion-header" onclick="toggleAccordion(this.parentElement)">
              <div class="accordion-title-block">
                <span class="badge badge-duplicate">
                  \${g.totalCount} Salinan Identik
                </span>
                <span class="code-pill" title="Klik untuk salin SHA-256" onclick="event.stopPropagation(); copyText('\${g.hash}')">
                  SHA-256: \${shortHash}
                </span>
              </div>
              <div class="accordion-stats-block">
                <span style="font-size: 13px; color: var(--text-muted);">
                  Ukuran Tiap File: <strong>\${g.fileSizeFormatted}</strong>
                </span>
                <span class="badge" style="background: rgba(244, 63, 94, 0.15); color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.3);">
                  Pemborosan: \${g.wastedFormatted}
                </span>
                <span class="chevron-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </span>
              </div>
            </div>
            <div class="accordion-body">
              <!-- File Asli (Original) -->
              <div class="duplicate-file-row original">
                <div class="file-main-info">
                  <span class="badge badge-original">
                    🛡️ FILE ASLI (DIPERTAHANKAN)
                  </span>
                  <div>
                    <div style="font-weight: 700; color: #fff;">\${escapeHtml(g.originalFile.name)}</div>
                    <div style="font-size: 12px; font-family: monospace; color: var(--text-muted);">\${escapeHtml(g.originalFile.relativePath)}</div>
                  </div>
                </div>
                <div class="file-meta-info">
                  <span>\${g.originalFile.sizeFormatted}</span>
                  <span>Dimodifikasi: \${g.originalFile.mtimeFormatted}</span>
                </div>
              </div>

              <!-- Salinan Duplikat -->
              \${g.duplicateFiles.map(dup => \`
                <div class="duplicate-file-row duplicate">
                  <div class="file-main-info">
                    <span class="badge badge-duplicate">
                      ⚠️ SALINAN KEMBAR (AKAN DIHAPUS)
                    </span>
                    <div>
                      <div style="font-weight: 700; color: #fff;">\${escapeHtml(dup.name)}</div>
                      <div style="font-size: 12px; font-family: monospace; color: var(--text-muted);">\${escapeHtml(dup.relativePath)}</div>
                    </div>
                  </div>
                  <div class="file-meta-info">
                    <span>\${dup.sizeFormatted}</span>
                    <span>Dimodifikasi: \${dup.mtimeFormatted}</span>
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderGiantsTab(giants) {
      const tbody = document.getElementById('giantsTableBody');
      if (!giants || giants.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="6" style="text-align: center; padding: 40px; color: var(--text-dim);">
              Tidak ada file yang melebihi ambang batas 2 MB (2.048 KB).
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = giants.map(f => \`
        <tr>
          <td>
            <span class="badge badge-giant">
              🔥 RAKSASA (> 2 MB)
            </span>
          </td>
          <td style="font-weight: 700; color: #fff;">\${escapeHtml(f.name)}</td>
          <td><span style="font-family: monospace; color: var(--text-muted);">\${escapeHtml(f.relativePath)}</span></td>
          <td style="font-weight: 700; color: var(--accent-amber);">\${f.sizeFormatted}</td>
          <td>
            <span class="code-pill" title="Klik salin hash" onclick="copyText('\${f.sha256}')">
              \${f.sha256 ? f.sha256.substring(0, 16) + '...' : '-'}
            </span>
          </td>
          <td style="color: var(--text-dim);">\${f.mtimeFormatted}</td>
        </tr>
      \`).join('');
    }

    function renderTmpTab(tmps) {
      const tbody = document.getElementById('tmpTableBody');
      if (!tmps || tmps.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="5" style="text-align: center; padding: 40px; color: var(--text-dim);">
              Tidak ada file sampah (.tmp) yang terdeteksi. Direktori bersih!
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = tmps.map(f => \`
        <tr>
          <td>
            <span class="badge badge-tmp">
              FILE SAMPAH (.TMP)
            </span>
          </td>
          <td style="font-weight: 700; color: #fff;">\${escapeHtml(f.name)}</td>
          <td><span style="font-family: monospace; color: var(--text-muted);">\${escapeHtml(f.relativePath)}</span></td>
          <td style="color: var(--accent-purple); font-weight: 600;">\${f.sizeFormatted}</td>
          <td style="color: var(--text-dim);">\${f.mtimeFormatted}</td>
        </tr>
      \`).join('');
    }

    function renderAllFilesTab(files) {
      const tbody = document.getElementById('allFilesTableBody');
      if (!files || files.length === 0) {
        tbody.innerHTML = \`
          <tr>
            <td colspan="6" style="text-align: center; padding: 40px; color: var(--text-dim);">
              Folder kosong atau tidak ada file ditemukan.
            </td>
          </tr>
        \`;
        return;
      }

      tbody.innerHTML = files.map(f => {
        let badgeHtml = '<span class="badge" style="background: rgba(255,255,255,0.06); color: var(--text-muted);">NORMAL</span>';
        if (f.isGiant) {
          badgeHtml = '<span class="badge badge-giant">RAKSASA (>2MB)</span>';
        } else if (f.isTmp) {
          badgeHtml = '<span class="badge badge-tmp">SAMPAH (.TMP)</span>';
        }

        return \`
          <tr>
            <td style="font-weight: 700; color: #fff;">\${escapeHtml(f.name)}</td>
            <td>\${badgeHtml}</td>
            <td><span style="font-family: monospace; color: var(--text-muted);">\${escapeHtml(f.relativePath)}</span></td>
            <td style="font-weight: 600;">\${f.sizeFormatted}</td>
            <td>
              <span class="code-pill" title="Klik salin hash" onclick="copyText('\${f.sha256}')">
                \${f.sha256 ? f.sha256.substring(0, 14) + '...' : '-'}
              </span>
            </td>
            <td style="color: var(--text-dim);">\${f.mtimeFormatted}</td>
          </tr>
        \`;
      }).join('');
    }

    // Modal Konfirmasi In-Place Cleaning
    function openCleanConfirmationModal() {
      if (!currentAuditData) return;

      const modal = document.getElementById('cleanModal');
      const listContainer = document.getElementById('modalFileList');

      // Kumpulkan target file yang akan dihapus:
      // 1. Salinan kembar (bukan file asli)
      // 2. File .tmp
      const targets = [];
      const visited = new Set();

      for (const g of currentAuditData.duplicateGroups) {
        for (const dup of g.duplicateFiles) {
          if (!visited.has(dup.fullPath)) {
            targets.push({ type: 'Salinan Duplikat', ...dup });
            visited.add(dup.fullPath);
          }
        }
      }

      for (const tmp of currentAuditData.tmpFiles) {
        if (!visited.has(tmp.fullPath)) {
          targets.push({ type: 'File Sampah .tmp', ...tmp });
          visited.add(tmp.fullPath);
        }
      }

      document.getElementById('modalFileCount').textContent = targets.length;
      document.getElementById('modalFreedText').textContent = currentAuditData.metrics.potentialSavingsFormatted;

      listContainer.innerHTML = targets.map(t => \`
        <div class="modal-file-item">
          <div>
            <span style="color: \${t.type === 'Salinan Duplikat' ? '#f43f5e' : '#c084fc'}; font-weight: 600;">[\${t.type}]</span>
            <span style="color: #fff;">\${escapeHtml(t.name)}</span>
            <span style="color: var(--text-dim);">(\${escapeHtml(t.relativePath)})</span>
          </div>
          <span style="font-weight: 600;">\${t.sizeFormatted}</span>
        </div>
      \`).join('');

      modal.classList.add('show');
    }

    function closeCleanModal() {
      document.getElementById('cleanModal').classList.remove('show');
    }

    // Eksekusi Pembersihan Langsung di Tempat (In-Place)
    async function executeInPlaceClean() {
      if (!currentAuditData) return;

      const btnConfirm = document.getElementById('btnConfirmDelete');
      const spinner = document.getElementById('deleteSpinner');
      const icon = document.getElementById('deleteIcon');

      btnConfirm.disabled = true;
      spinner.style.display = 'inline-block';
      icon.style.display = 'none';

      try {
        const folderPath = currentAuditData.targetFolder;
        const res = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });

        const result = await res.json();
        closeCleanModal();

        if (result.success) {
          showToast(
            'Pembersihan Berhasil! ' + result.deletedCount + ' file dihapus, membebaskan ' + result.freedFormatted + ' ruang.',
            'success'
          );
          // Pindai ulang secara otomatis untuk memperbarui UI
          await triggerScan();
        } else {
          showToast('Terjadi kesalahan saat pembersihan: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Gagal memproses pembersihan: ' + err.message, 'error');
      } finally {
        btnConfirm.disabled = false;
        spinner.style.display = 'none';
        icon.style.display = 'inline-block';
      }
    }

    // Pemicu input pemilih folder
    function triggerFolderUpload() {
      const input = document.getElementById('folderUploadInput');
      input.value = ''; // reset agar folder yang sama dapat dipilih kembali
      input.click();
    }

    // Tangani proses upload folder yang dipilih
    async function handleFolderSelected(event) {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      const files = Array.from(fileList);
      // Dapatkan nama root folder dari webkitRelativePath
      const sampleRelPath = files[0].webkitRelativePath || files[0].name;
      const rootFolderName = sampleRelPath.split('/')[0] || 'Uploaded_Folder';

      const modal = document.getElementById('uploadModal');
      const statusText = document.getElementById('uploadStatusText');
      const detailText = document.getElementById('uploadDetailText');
      const progressBar = document.getElementById('uploadProgressBar');
      const progressCount = document.getElementById('uploadProgressCount');
      const progressPercent = document.getElementById('uploadProgressPercent');

      modal.classList.add('show');
      statusText.textContent = 'Mengunggah folder "' + rootFolderName + '"...';
      progressBar.style.width = '0%';
      progressPercent.textContent = '0%';
      progressCount.textContent = '0 / ' + files.length + ' File';

      const totalFiles = files.length;
      let completedFiles = 0;
      let hasError = false;

      // Concurrency pool 4 koneksi paralel
      const concurrency = 4;
      let currentIndex = 0;

      async function uploadWorker() {
        while (currentIndex < files.length && !hasError) {
          const fileIndex = currentIndex++;
          const file = files[fileIndex];
          const relPath = file.webkitRelativePath || file.name;

          try {
            detailText.textContent = 'Mengunggah: ' + file.name;
            const res = await fetch('/api/upload-file', {
              method: 'POST',
              headers: {
                'x-folder-name': encodeURIComponent(rootFolderName),
                'x-relative-path': encodeURIComponent(relPath),
                'Content-Type': 'application/octet-stream'
              },
              body: file
            });

            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || ('HTTP ' + res.status));
            }

            completedFiles++;
            const pct = Math.round((completedFiles / totalFiles) * 100);
            progressBar.style.width = pct + '%';
            progressPercent.textContent = pct + '%';
            progressCount.textContent = completedFiles + ' / ' + totalFiles + ' File';
          } catch (err) {
            hasError = true;
            console.error('Upload error:', err);
            showToast('Gagal mengunggah ' + file.name + ': ' + err.message, 'error');
            break;
          }
        }
      }

      const workers = [];
      for (let w = 0; w < Math.min(concurrency, files.length); w++) {
        workers.push(uploadWorker());
      }
      await Promise.all(workers);

      modal.classList.remove('show');

      if (!hasError) {
        const targetPath = './Uploaded_Folders/' + rootFolderName;
        document.getElementById('folderPathInput').value = targetPath;
        showToast('Folder "' + rootFolderName + '" berhasil diunggah (' + completedFiles + ' file)! Memulai audit...', 'success');
        await triggerScan();
      }
    }

    // Escape helper
    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Auto trigger scan on initial load
    window.addEventListener('DOMContentLoaded', () => {
      triggerScan();
    });
  </script>
</body>
</html>`;
}

/**
 * Buat ulang sample data untuk testing demo
 */
function createSampleDemoFiles(targetFolder = './Bahan Latihan P12') {
  const base = path.resolve(process.cwd(), targetFolder);
  const dirs = [
    base,
    path.join(base, 'Modul Kuliah'),
    path.join(base, 'Cadangan Arsip'),
    path.join(base, 'Draft Proyek')
  ];

  dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

  // File Raksasa (2.6 MB > ambang batas 2 MB)
  const giantBuffer = crypto.randomBytes(Math.floor(2.6 * 1024 * 1024));
  fs.writeFileSync(path.join(base, 'Modul Kuliah', 'modul.pdf'), giantBuffer);
  // Salinan persis file raksasa dengan nama berbeda (modul_BACKUP.pdf)
  fs.writeFileSync(path.join(base, 'Cadangan Arsip', 'modul_BACKUP.pdf'), giantBuffer);
  // Salinan ketiga di folder draft
  fs.writeFileSync(path.join(base, 'Draft Proyek', 'modul_salinan_rev1.pdf'), giantBuffer);

  // File raksasa lain (3.1 MB, unik)
  const giantBuffer2 = crypto.randomBytes(Math.floor(3.1 * 1024 * 1024));
  fs.writeFileSync(path.join(base, 'Modul Kuliah', 'rekaman_kuliah_p12.mp4'), giantBuffer2);

  // File dokumen normal dan duplikatnya
  const docText = Buffer.from('Laporan Praktikum Sistem Operasi P12 - Storage Audit Experiment File Content');
  fs.writeFileSync(path.join(base, 'laporan_p12.docx'), docText);
  fs.writeFileSync(path.join(base, 'Cadangan Arsip', 'laporan_p12_COPY.docx'), docText);

  // File sampah sementara (.tmp)
  fs.writeFileSync(path.join(base, '~cache_session.tmp'), 'temporary cache junk 101');
  fs.writeFileSync(path.join(base, 'Draft Proyek', 'render_temp_01.tmp'), 'temporary render buffer junk 202');
  fs.writeFileSync(path.join(base, 'Modul Kuliah', 'catatan_kuliah.txt'), 'Catatan belajar normal minggu ke-12');

  return true;
}

/**
 * Otomatis membuka URL di browser default sistem
 */
function openBrowser(targetUrl) {
  const plat = process.platform;
  let cmd = '';
  if (plat === 'win32') {
    cmd = `start "" "${targetUrl}"`;
  } else if (plat === 'darwin') {
    cmd = `open "${targetUrl}"`;
  } else {
    cmd = `xdg-open "${targetUrl}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.warn(`[Peringatan] Tidak dapat membuka browser secara otomatis: ${err.message}`);
    }
  });
}

/**
 * Buka folder di Windows Explorer / file manager
 */
function openFolderInSystemExplorer(folderPath) {
  const resolved = path.resolve(process.cwd(), folderPath);
  const plat = process.platform;
  let cmd = '';
  if (plat === 'win32') {
    cmd = `explorer.exe "${resolved}"`;
  } else if (plat === 'darwin') {
    cmd = `open "${resolved}"`;
  } else {
    cmd = `xdg-open "${resolved}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.warn(`[Peringatan] Gagal membuka explorer: ${err.message}`);
    }
  });
}

/**
 * Server HTTP Utama
 */
function startServer(port = DEFAULT_PORT) {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const pathname = reqUrl.pathname;
    const method = req.method;

    // Helper kirim JSON
    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    };

    // Helper baca body request
    const getRequestBody = () => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
          if (body.length > 1e6) { // 1MB limit
            req.destroy();
            reject(new Error('Payload too large'));
          }
        });
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });
    };

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    try {
      // 1. GET / -> Tampilkan Dashboard Web UI
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      // 2. POST /api/scan -> Memindai folder target
      if (method === 'POST' && pathname === '/api/scan') {
        const body = await getRequestBody();
        const targetFolder = body.folderPath || './Bahan Latihan P12';
        const result = await auditStorageFolder(targetFolder);
        sendJson(200, result);
        return;
      }

      // 3. POST /api/clean -> Eksekusi pembersihan in-place
      if (method === 'POST' && pathname === '/api/clean') {
        const body = await getRequestBody();
        const targetFolder = body.folderPath || './Bahan Latihan P12';
        const result = await cleanDuplicatesAndJunk(targetFolder, body.filePaths);
        sendJson(200, result);
        return;
      }

      // 4. POST /api/upload-file -> Menerima stream berkas upload folder
      if (method === 'POST' && pathname === '/api/upload-file') {
        const baseUploadDir = path.resolve(process.cwd(), 'Uploaded_Folders');
        const rawRelPath = decodeURIComponent(req.headers['x-relative-path'] || '');
        if (!rawRelPath) {
          sendJson(400, { error: 'Header x-relative-path wajib disertakan' });
          return;
        }

        const safeRelPath = path.normalize(rawRelPath).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
        const targetFilePath = path.join(baseUploadDir, safeRelPath);

        if (!targetFilePath.startsWith(baseUploadDir)) {
          sendJson(403, { error: 'Path traversal tidak diizinkan' });
          return;
        }

        fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
        const fileStream = fs.createWriteStream(targetFilePath);
        req.pipe(fileStream);

        fileStream.on('finish', () => {
          sendJson(200, { success: true, relativePath: safeRelPath });
        });

        fileStream.on('error', (err) => {
          console.error('[Upload Error]', err);
          sendJson(500, { error: err.message });
        });
        return;
      }

      // 5. POST /api/open-explorer -> Buka di Explorer
      if (method === 'POST' && pathname === '/api/open-explorer') {
        const body = await getRequestBody();
        const targetFolder = body.folderPath || './Bahan Latihan P12';
        openFolderInSystemExplorer(targetFolder);
        sendJson(200, { success: true });
        return;
      }

      // 5. POST /api/reset-sample -> Buat ulang data demo jika diperlukan
      if (method === 'POST' && pathname === '/api/reset-sample') {
        createSampleDemoFiles('./Bahan Latihan P12');
        sendJson(200, { success: true });
        return;
      }

      // 404 Not Found
      sendJson(404, { error: 'Endpoint tidak ditemukan' });
    } catch (err) {
      console.error('[Error Request]', err);
      sendJson(500, { error: err.message || 'Terjadi kesalahan pada server' });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Info] Port ${port} sedang digunakan, mencoba port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('[Fatal Server Error]', err);
    }
  });

  server.listen(port, () => {
    const serverUrl = `http://localhost:${port}`;
    console.log('\n' + '='.repeat(68));
    console.log('  ⚡ STORAGE AUDIT & CLEANER PRO (Node.js Native Edition)');
    console.log('='.repeat(68));
    console.log(`  🌐 Dashboard URL : ${serverUrl}`);
    console.log(`  📂 Default Target: ./Bahan Latihan P12`);
    console.log(`  🛡️  Zero Dependency: Modul http, fs, path, crypto native`);
    console.log(`  🛑 Tekan Ctrl+C untuk menghentikan server`);
    console.log('='.repeat(68) + '\n');

    // Otomatis membuka dashboard di browser
    openBrowser(serverUrl);
  });
}

// Pastikan sample folder Bahan Latihan P12 ada sebelum server start
const defaultTarget = path.resolve(process.cwd(), 'Bahan Latihan P12');
if (!fs.existsSync(defaultTarget)) {
  createSampleDemoFiles('Bahan Latihan P12');
}

// Mulai server
startServer(DEFAULT_PORT);
