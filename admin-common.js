// Helpers shared by the admin modules: image upload, CSV, form utilities.
import { sb } from './api.js';
import { compressImage, uuid } from './util.js';

// Uploads to the public "media" bucket. Storage RLS allows only the owner to write.
export async function uploadImage(file, folder, maxSide = 900) {
  if (!file) return null;
  if (!/^image\/(jpeg|png|webp|svg\+xml)$/.test(file.type)) throw new Error('نوع الملف غير مدعوم (JPG أو PNG أو WebP فقط)');
  if (file.size > 12 * 1024 * 1024) throw new Error('حجم الصورة كبير جدا');
  const blob = await compressImage(file, maxSide);
  const type = blob.type || file.type;
  const ext = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : type === 'image/svg+xml' ? 'svg' : 'jpg';
  const path = `${folder}/${uuid()}.${ext}`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: type, cacheControl: '31536000' });
  if (error) throw error;
  return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
}

export const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
export const strOrNull = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };

// ---- CSV ----
export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function toCSV(rows, cols) {
  const e = (v) => { const s = v == null ? '' : String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // Formula-injection guard for spreadsheet apps
  const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v);
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => e(safe(r[c]))).join(','))].join('\r\n');
}

export function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export const UNITS = ['قطعة', 'كجم', 'جرام', 'لتر', 'عبوة', 'كرتونة', 'علبة', 'كيس', 'زجاجة', 'دستة'];
