// Copies runtime assets that libraries load by URL (pdf.js fonts/cmaps/wasm,
// the form-scripting sandbox, and the OCR engine) into public/vendor so the
// app is fully self-hosted. Runs before `dev` and `build`.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "vendor");

function copy(from, to) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.warn(`[vendor] missing ${from}, skipped`);
    return;
  }
  const dest = join(out, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

mkdirSync(out, { recursive: true });
copy("pdfjs-dist/cmaps", "pdfjs/cmaps");
copy("pdfjs-dist/standard_fonts", "pdfjs/standard_fonts");
copy("pdfjs-dist/wasm", "pdfjs/wasm");
copy("pdfjs-dist/iccs", "pdfjs/iccs");
// As .js, which every server (and the phone apps) sends as JavaScript.
copy("pdfjs-dist/legacy/build/pdf.sandbox.min.mjs", "pdfjs/pdf.sandbox.min.js");
copy("pdfjs-dist/web/images", "pdfjs/images");

// OCR: worker + the LSTM-only cores (the engine picks the fastest one the
// browser supports). Language data is fetched on demand; English ships locally.
copy("tesseract.js/dist/worker.min.js", "tesseract/worker.min.js");
for (const f of readdirSync(join(nm, "tesseract.js-core"))) {
  if (/^tesseract-core-(relaxedsimd-|simd-)?lstm\.wasm\.js$/.test(f)) {
    copy(`tesseract.js-core/${f}`, `tesseract/core/${f}`);
  }
}
// Not gzipped: Android's packaging doesn't keep .gz files under their own name (the app couldn't
// find it). The packages compress it anyway.
const eng = join(nm, "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz");
if (existsSync(eng)) {
  mkdirSync(join(out, "tesseract", "lang"), { recursive: true });
  writeFileSync(join(out, "tesseract", "lang", "eng.traineddata"), gunzipSync(readFileSync(eng)));
  rmSync(join(out, "tesseract", "lang", "eng.traineddata.gz"), { force: true });
} else console.warn("[vendor] missing English OCR data, skipped");
console.log("[vendor] assets ready in public/vendor");
