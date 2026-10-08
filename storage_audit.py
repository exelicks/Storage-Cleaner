#!/usr/bin/env python3
"""
==============================================================================
STORAGE AUDIT & CLEANER PRO (Python Edition)
File: storage_audit.py

Utilitas Web UI berbasis Python Standard Library untuk audit dan pembersihan storage.
Runtime: Python 3.8+ (modul bawaan: http.server, os, hashlib, json, webbrowser, datetime, subprocess)
DEPENDENSI EKSTERNAL: 0 (Tanpa pip install)
==============================================================================
"""

import http.server
import socketserver
import os
import hashlib
import json
import webbrowser
import sys
import subprocess
import urllib.parse
from datetime import datetime

DEFAULT_PORT = 3000
GIANT_FILE_THRESHOLD_BYTES = 2 * 1024 * 1024  # 2 MB = 2.048 KB = 2.097.152 bytes


def format_bytes(num_bytes, decimals=2):
    if num_bytes == 0:
        return "0 B"
    k = 1024
    sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    i = 0
    val = float(num_bytes)
    while val >= k and i < len(sizes) - 1:
        val /= k
        i += 1
    return f"{round(val, decimals)} {sizes[i]}"


def calculate_file_hash(file_path):
    hasher = hashlib.sha256()
    with open(file_path, 'rb') as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def scan_directory_recursively(dir_path, root_dir, collected_files=None):
    if collected_files is None:
        collected_files = []

    try:
        with os.scandir(dir_path) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        scan_directory_recursively(entry.path, root_dir, collected_files)
                    elif entry.is_file(follow_symlinks=False):
                        stats = entry.stat()
                        is_giant = stats.st_size >= GIANT_FILE_THRESHOLD_BYTES
                        is_tmp = entry.name.lower().endswith('.tmp')
                        mtime_dt = datetime.fromtimestamp(stats.st_mtime)

                        collected_files.append({
                            "name": entry.name,
                            "fullPath": os.path.abspath(entry.path),
                            "relativePath": os.path.relpath(entry.path, root_dir).replace('\\', '/'),
                            "sizeBytes": stats.st_size,
                            "sizeFormatted": format_bytes(stats.st_size),
                            "mtime": stats.st_mtime * 1000,
                            "mtimeFormatted": mtime_dt.strftime('%d %b %Y %H:%M:%S'),
                            "isGiant": is_giant,
                            "isTmp": is_tmp
                        })
                except Exception as e:
                    print(f"[Peringatan] Lewati file {entry.path}: {e}")
    except Exception as e:
        print(f"[Peringatan] Lewati direktori {dir_path}: {e}")

    return collected_files


def audit_storage_folder(target_folder_path):
    resolved_target = os.path.abspath(target_folder_path)

    if not os.path.exists(resolved_target):
        raise ValueError(f'Folder tidak ditemukan: "{target_folder_path}" (Path absolut: {resolved_target})')

    if not os.path.isdir(resolved_target):
        raise ValueError(f'Path bukan direktori: "{target_folder_path}"')

    raw_files = scan_directory_recursively(resolved_target, resolved_target, [])

    for file_item in raw_files:
        try:
            file_item["sha256"] = calculate_file_hash(file_item["fullPath"])
        except Exception:
            file_item["sha256"] = "ERROR_CALCULATING_HASH"

    hash_map = {}
    for file_item in raw_files:
        h = file_item.get("sha256")
        if not h or h == "ERROR_CALCULATING_HASH":
            continue
        if h not in hash_map:
            hash_map[h] = []
        hash_map[h].append(file_item)

    duplicate_groups = []
    total_wasted_duplicate_bytes = 0
    duplicate_paths_set = set()

    for hash_val, files in hash_map.items():
        if len(files) > 1:
            files.sort(key=lambda x: x["mtime"])
            original_file = files[0]
            duplicates_list = files[1:]

            wasted_group = sum(f["sizeBytes"] for f in duplicates_list)
            total_wasted_duplicate_bytes += wasted_group

            for dup in duplicates_list:
                duplicate_paths_set.add(dup["fullPath"])

            duplicate_groups.append({
                "hash": hash_val,
                "fileSize": original_file["sizeBytes"],
                "fileSizeFormatted": format_bytes(original_file["sizeBytes"]),
                "totalCount": len(files),
                "originalFile": original_file,
                "duplicateFiles": duplicates_list,
                "wastedBytes": wasted_group,
                "wastedFormatted": format_bytes(wasted_group)
            })

    giant_files = [f for f in raw_files if f["isGiant"]]
    giant_files.sort(key=lambda x: x["sizeBytes"], reverse=True)
    giant_files_bytes = sum(f["sizeBytes"] for f in giant_files)

    tmp_files = [f for f in raw_files if f["isTmp"]]
    tmp_savings_bytes = sum(f["sizeBytes"] for f in tmp_files if f["fullPath"] not in duplicate_paths_set)

    potential_savings_bytes = total_wasted_duplicate_bytes + tmp_savings_bytes
    total_capacity_bytes = sum(f["sizeBytes"] for f in raw_files)

    return {
        "targetFolder": target_folder_path,
        "resolvedTarget": resolved_target,
        "scanTimestamp": datetime.utcnow().isoformat() + "Z",
        "metrics": {
            "totalFiles": len(raw_files),
            "totalCapacityBytes": total_capacity_bytes,
            "totalCapacityFormatted": format_bytes(total_capacity_bytes),
            "giantFilesCount": len(giant_files),
            "giantFilesBytes": giant_files_bytes,
            "giantFilesFormatted": format_bytes(giant_files_bytes),
            "potentialSavingsBytes": potential_savings_bytes,
            "potentialSavingsFormatted": format_bytes(potential_savings_bytes),
            "duplicateGroupsCount": len(duplicate_groups),
            "duplicateCopiesCount": len(duplicate_paths_set),
            "tmpFilesCount": len(tmp_files),
            "tmpFilesBytes": sum(f["sizeBytes"] for f in tmp_files),
            "tmpFilesFormatted": format_bytes(sum(f["sizeBytes"] for f in tmp_files))
        },
        "giantFiles": giant_files,
        "duplicateGroups": duplicate_groups,
        "tmpFiles": tmp_files,
        "allFiles": raw_files
    }


def clean_duplicates_and_junk(target_folder_path, selected_file_paths=None):
    audit = audit_storage_folder(target_folder_path)
    resolved_target = audit["resolvedTarget"]

    protected_originals = {os.path.abspath(g["originalFile"]["fullPath"]) for g in audit["duplicateGroups"]}

    target_deletion_set = set()
    for g in audit["duplicateGroups"]:
        for d in g["duplicateFiles"]:
            target_deletion_set.add(os.path.abspath(d["fullPath"]))

    for tmp in audit["tmpFiles"]:
        target_deletion_set.add(os.path.abspath(tmp["fullPath"]))

    files_to_delete = list(target_deletion_set)
    if selected_file_paths and isinstance(selected_file_paths, list):
        sel_norm = {os.path.abspath(p) for p in selected_file_paths}
        files_to_delete = [p for p in files_to_delete if p in sel_norm]

    deleted_files = []
    errors = []
    total_freed_bytes = 0

    for file_path in files_to_delete:
        norm_path = os.path.abspath(file_path)

        if norm_path in protected_originals:
            errors.append({"file": norm_path, "error": "DITOLAK: File asli dilindungi!"})
            continue

        rel = os.path.relpath(norm_path, resolved_target)
        if rel.startswith("..") or os.path.isabs(rel):
            errors.append({"file": norm_path, "error": "DITOLAK: File berada di luar direktori target!"})
            continue

        try:
            if os.path.exists(norm_path):
                fsize = os.path.getsize(norm_path)
                os.remove(norm_path)
                total_freed_bytes += fsize
                deleted_files.append({
                    "fullPath": norm_path,
                    "relativePath": rel.replace('\\', '/'),
                    "sizeBytes": fsize,
                    "sizeFormatted": format_bytes(fsize)
                })
        except Exception as e:
            errors.append({"file": norm_path, "error": str(e)})

    return {
        "success": True,
        "deletedCount": len(deleted_files),
        "freedBytes": total_freed_bytes,
        "freedFormatted": format_bytes(total_freed_bytes),
        "deletedFiles": deleted_files,
        "errors": errors
    }


def create_sample_demo_files(target_folder="./Bahan Latihan P12"):
    base = os.path.abspath(target_folder)
    subdirs = [
        base,
        os.path.join(base, "Modul Kuliah"),
        os.path.join(base, "Cadangan Arsip"),
        os.path.join(base, "Draft Proyek")
    ]
    for d in subdirs:
        os.makedirs(d, exist_ok=True)

    giant_data = os.urandom(int(2.6 * 1024 * 1024))
    with open(os.path.join(base, "Modul Kuliah", "modul.pdf"), "wb") as f:
        f.write(giant_data)
    with open(os.path.join(base, "Cadangan Arsip", "modul_BACKUP.pdf"), "wb") as f:
        f.write(giant_data)
    with open(os.path.join(base, "Draft Proyek", "modul_salinan_rev1.pdf"), "wb") as f:
        f.write(giant_data)

    giant_data_2 = os.urandom(int(3.1 * 1024 * 1024))
    with open(os.path.join(base, "Modul Kuliah", "rekaman_kuliah_p12.mp4"), "wb") as f:
        f.write(giant_data_2)

    doc_text = "Laporan Praktikum Sistem Operasi P12 - Storage Audit Experiment File Content".encode('utf-8')
    with open(os.path.join(base, "laporan_p12.docx"), "wb") as f:
        f.write(doc_text)
    with open(os.path.join(base, "Cadangan Arsip", "laporan_p12_COPY.docx"), "wb") as f:
        f.write(doc_text)

    with open(os.path.join(base, "~cache_session.tmp"), "w", encoding="utf-8") as f:
        f.write("temporary cache junk 101")
    with open(os.path.join(base, "Draft Proyek", "render_temp_01.tmp"), "w", encoding="utf-8") as f:
        f.write("temporary render buffer junk 202")
    with open(os.path.join(base, "Modul Kuliah", "catatan_kuliah.txt"), "w", encoding="utf-8") as f:
        f.write("Catatan belajar normal minggu ke-12")


def open_folder_in_system_explorer(folder_path):
    resolved = os.path.abspath(folder_path)
    if sys.platform == "win32":
        os.startfile(resolved)
    elif sys.platform == "darwin":
        subprocess.run(["open", resolved], check=False)
    else:
        subprocess.run(["xdg-open", resolved], check=False)


class StorageAuditHandler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            # Gunakan template HTML dari file storage_audit.js jika ada, atau buat response
            html_content = self.get_html()
            self.wfile.write(html_content.encode("utf-8"))
        else:
            self.send_error(404, "Halaman tidak ditemukan")

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))

        if self.path == "/api/upload-file":
            base_upload_dir = os.path.abspath(os.path.join(os.getcwd(), 'Uploaded_Folders'))
            raw_rel_path = urllib.parse.unquote(self.headers.get('x-relative-path', ''))
            if not raw_rel_path:
                self.send_json_response(400, {"error": "Header x-relative-path wajib disertakan"})
                return

            safe_rel_path = os.path.normpath(raw_rel_path).lstrip('\\/')
            target_file_path = os.path.abspath(os.path.join(base_upload_dir, safe_rel_path))

            if not target_file_path.startswith(base_upload_dir):
                self.send_json_response(403, {"error": "Path traversal tidak diizinkan"})
                return

            os.makedirs(os.path.dirname(target_file_path), exist_ok=True)
            with open(target_file_path, 'wb') as f:
                remaining = content_len
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 65536))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)

            self.send_json_response(200, {"success": True, "relativePath": safe_rel_path})
            return

        post_data = self.rfile.read(content_len).decode("utf-8")
        data = json.loads(post_data) if post_data else {}

        if self.path == "/api/scan":
            folder = data.get("folderPath", "./Bahan Latihan P12")
            try:
                result = audit_storage_folder(folder)
                self.send_json_response(200, result)
            except Exception as e:
                self.send_json_response(400, {"error": str(e)})

        elif self.path == "/api/clean":
            folder = data.get("folderPath", "./Bahan Latihan P12")
            try:
                result = clean_duplicates_and_junk(folder, data.get("filePaths"))
                self.send_json_response(200, result)
            except Exception as e:
                self.send_json_response(400, {"error": str(e)})

        elif self.path == "/api/open-explorer":
            folder = data.get("folderPath", "./Bahan Latihan P12")
            open_folder_in_system_explorer(folder)
            self.send_json_response(200, {"success": True})

        elif self.path == "/api/reset-sample":
            create_sample_demo_files("./Bahan Latihan P12")
            self.send_json_response(200, {"success": True})
        else:
            self.send_json_response(404, {"error": "Endpoint tidak ditemukan"})

    def send_json_response(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def get_html(self):
        # Ambil template HTML yang rapi
        js_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage_audit.js")
        if os.path.exists(js_file):
            try:
                with open(js_file, "r", encoding="utf-8") as f:
                    content = f.read()
                    start_marker = "return `<!DOCTYPE html>"
                    end_marker = "</html>`;"
                    start_pos = content.find(start_marker)
                    end_pos = content.find(end_marker, start_pos)
                    if start_pos != -1 and end_pos != -1:
                        html = content[start_pos + len("return `"): end_pos + len("</html>")]
                        # Sesuaikan label runtime
                        return html.replace("Node.js Native Runtime", "Python Standard Library")
            except Exception:
                pass
        return "<h1>Storage Audit Python Server Siap</h1>"


def run_server(port=DEFAULT_PORT):
    if not os.path.exists("./Bahan Latihan P12"):
        create_sample_demo_files("./Bahan Latihan P12")

    server_address = ("", port)
    try:
        httpd = socketserver.TCPServer(server_address, StorageAuditHandler)
    except OSError:
        print(f"[Info] Port {port} digunakan, mencoba port {port + 1}...")
        run_server(port + 1)
        return

    url = f"http://localhost:{port}"
    print("=" * 68)
    print("  ⚡ STORAGE AUDIT & CLEANER PRO (Python Standard Library Edition)")
    print("=" * 68)
    print(f"  🌐 Dashboard URL : {url}")
    print(f"  📂 Default Target: ./Bahan Latihan P12")
    print(f"  🛡️  Zero Dependency: Modul http.server, os, hashlib bawaan")
    print(f"  🛑 Tekan Ctrl+C untuk menghentikan server")
    print("=" * 68)

    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Info] Server dihentikan oleh pengguna.")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
