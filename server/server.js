const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const xml2js = require('xml2js');
const { v4: uuid } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const APKTOOL_JAR = process.env.APKTOOL_JAR || '/opt/tools/apktool.jar';
const JADX_BIN = process.env.JADX_BIN || '/opt/tools/jadx/bin/jadx';
const WORK_ROOT = process.env.WORK_ROOT || path.join(os.tmpdir(), 'apk-jobs');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '250', 10);
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour, then a job's files (and storage objects) are swept
const APKTOOL_XMX = process.env.APKTOOL_XMX || '384m';
const JADX_XMX = process.env.JADX_XMX || '384m';

// ---------- Optional external storage (Supabase Storage) ----------
// If SUPABASE_URL + SUPABASE_SERVICE_KEY are set, finished zips are uploaded there and
// served via signed URLs instead of staying only on this container's ephemeral disk.
// Without them, the service falls back to streaming zips straight from local disk.
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'apk-decompiles';
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
if (supabase) {
  console.log(`External storage enabled — uploading results to Supabase bucket "${SUPABASE_BUCKET}"`);
} else {
  console.log('External storage not configured — serving downloads from local disk (set SUPABASE_URL + SUPABASE_SERVICE_KEY to enable)');
}

fs.mkdirSync(WORK_ROOT, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- In-memory job store ----------
// jobs: id -> { status, stage, error, dir, apkName, summary, createdAt }
const jobs = new Map();

function sweepExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      if (supabase) {
        supabase.storage.from(SUPABASE_BUCKET)
          .remove([`${id}/full.zip`, `${id}/source.zip`, `${id}/resources.zip`])
          .catch(() => {});
      }
      jobs.delete(id);
    }
  }
}
setInterval(sweepExpiredJobs, 10 * 60 * 1000).unref();

// ---------- Upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId;
      cb(null, jobs.get(jobId).dir);
    },
    filename: (req, file, cb) => cb(null, 'input.apk'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = file.originalname.toLowerCase().endsWith('.apk');
    const okMime = [
      'application/vnd.android.package-archive',
      'application/octet-stream',
      'application/zip',
    ].includes(file.mimetype);
    if (!okExt) return cb(new Error('Only .apk files are accepted.'));
    cb(null, okExt || okMime);
  },
});

app.post('/api/upload', (req, res, next) => {
  const jobId = uuid();
  const dir = path.join(WORK_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  jobs.set(jobId, {
    status: 'uploading',
    stage: 'Receiving file',
    error: null,
    dir,
    apkName: null,
    summary: null,
    downloadUrls: null,
    createdAt: Date.now(),
  });
  req.jobId = jobId;
  next();
}, upload.single('apk'), (req, res) => {
  const job = jobs.get(req.jobId);
  if (!req.file) {
    job.status = 'error';
    job.error = 'No file received.';
    return res.status(400).json({ error: job.error });
  }
  job.apkName = req.file.originalname;
  job.status = 'queued';
  job.stage = 'Queued for decompilation';
  res.json({ jobId: req.jobId });
  runPipeline(req.jobId).catch((err) => {
    const j = jobs.get(req.jobId);
    if (j) {
      j.status = 'error';
      j.error = err.message || String(err);
    }
  });
});

app.use((err, req, res, next) => {
  if (req.jobId && jobs.has(req.jobId)) {
    const job = jobs.get(req.jobId);
    job.status = 'error';
    job.error = err.message || String(err);
  }
  res.status(400).json({ error: err.message || 'Upload failed.' });
});

// ---------- Status ----------
app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json({
    status: job.status,
    stage: job.stage,
    error: job.error,
    apkName: job.apkName,
    summary: job.status === 'done' ? job.summary : null,
  });
});

// ---------- Downloads ----------
app.get('/api/download/:id/:kind', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'Job not ready or expired.' });
  }
  const kind = req.params.kind;
  if (!['full', 'resources', 'source'].includes(kind)) {
    return res.status(400).json({ error: 'Unknown download kind.' });
  }

  // Prefer external storage if this job's results were uploaded there.
  if (job.downloadUrls && job.downloadUrls[kind]) {
    return res.redirect(job.downloadUrls[kind]);
  }

  // Fallback: stream directly from local disk.
  const targets = {
    full: [path.join(job.dir, 'resources'), path.join(job.dir, 'java_source')],
    resources: [path.join(job.dir, 'resources')],
    source: [path.join(job.dir, 'java_source')],
  }[kind];

  const base = (job.apkName || 'app').replace(/\.apk$/i, '');
  res.attachment(`${base}-${kind}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (e) => res.status(500).end(String(e)));
  archive.pipe(res);
  for (const t of targets) {
    if (fs.existsSync(t)) archive.directory(t, path.basename(t));
  }
  archive.finalize();
});

// ---------- Pipeline ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      if (/OutOfMemoryError/.test(stderr)) {
        return reject(new Error(
          'Ran out of memory decompiling this APK. The server instance doesn\'t have ' +
          'enough RAM for a file this size — try a smaller APK, or ask the site owner to ' +
          'upgrade the hosting plan\'s memory.'
        ));
      }
      reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function zipPaths(dirPaths, outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const p of dirPaths) {
      if (fs.existsSync(p)) archive.directory(p, path.basename(p));
    }
    archive.finalize();
  });
}

async function uploadResultsToStorage(jobId, job, resourcesDir, sourceDir) {
  if (!supabase) return;
  const kinds = {
    full: [resourcesDir, sourceDir],
    resources: [resourcesDir],
    source: [sourceDir],
  };
  const urls = {};
  for (const [kind, dirs] of Object.entries(kinds)) {
    const zipPath = path.join(job.dir, `${kind}.zip`);
    try {
      await zipPaths(dirs, zipPath);
      const buffer = await fsp.readFile(zipPath);
      const objectPath = `${jobId}/${kind}.zip`;
      const { error: uploadErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(objectPath, buffer, { contentType: 'application/zip', upsert: true });
      if (uploadErr) throw uploadErr;
      const { data: signedData, error: signErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .createSignedUrl(objectPath, Math.floor(JOB_TTL_MS / 1000));
      if (signErr) throw signErr;
      urls[kind] = signedData.signedUrl;
    } catch (e) {
      console.error(`Supabase upload failed for ${kind}:`, e.message || e);
      // Leave this kind unset — the download route falls back to local disk for it.
    }
  }
  if (Object.keys(urls).length) job.downloadUrls = urls;
}

async function runPipeline(jobId) {
  const job = jobs.get(jobId);
  const apkPath = path.join(job.dir, 'input.apk');
  const resourcesDir = path.join(job.dir, 'resources');
  const sourceDir = path.join(job.dir, 'java_source');

  job.status = 'processing';

  job.stage = 'Unpacking resources & manifest (apktool)';
  await run('java', [`-Xmx${APKTOOL_XMX}`, '-jar', APKTOOL_JAR, 'd', '-f', '-o', resourcesDir, apkPath]);

  job.stage = 'Decompiling Java source (jadx)';
  await run(JADX_BIN, ['-d', sourceDir, '--show-bad-code', apkPath], {
    env: { ...process.env, JADX_OPTS: `-Xmx${JADX_XMX}` },
  }).catch((e) => {
    // jadx returns non-zero on partial-failure classes; still usable output.
    job.partialSourceWarning = e.message;
  });

  job.stage = 'Reading manifest & building summary';
  job.summary = await buildSummary(resourcesDir, apkPath);

  if (supabase) {
    job.stage = 'Uploading results to storage';
    await uploadResultsToStorage(jobId, job, resourcesDir, sourceDir);
    // Once all three zips live in external storage, free the ephemeral disk immediately
    // rather than waiting for the 1-hour sweep.
    if (job.downloadUrls && job.downloadUrls.full && job.downloadUrls.resources && job.downloadUrls.source) {
      fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  job.status = 'done';
  job.stage = 'Complete';
}

async function buildSummary(resourcesDir, apkPath) {
  const manifestPath = path.join(resourcesDir, 'AndroidManifest.xml');
  const summary = {
    package: null,
    versionName: null,
    versionCode: null,
    minSdk: null,
    targetSdk: null,
    permissions: [],
    activities: [],
    services: [],
    receivers: [],
    fileSizeBytes: fs.existsSync(apkPath) ? (await fsp.stat(apkPath)).size : null,
  };

  if (!fs.existsSync(manifestPath)) return summary;
  const xml = await fsp.readFile(manifestPath, 'utf8');
  const parsed = await xml2js.parseStringPromise(xml);
  const manifest = parsed.manifest || {};
  const attrs = manifest.$ || {};

  summary.package = attrs.package || null;
  summary.versionName = attrs['android:versionName'] || null;
  summary.versionCode = attrs['android:versionCode'] || null;

  const usesSdk = (manifest['uses-sdk'] || [])[0];
  if (usesSdk && usesSdk.$) {
    summary.minSdk = usesSdk.$['android:minSdkVersion'] || null;
    summary.targetSdk = usesSdk.$['android:targetSdkVersion'] || null;
  }

  summary.permissions = (manifest['uses-permission'] || [])
    .map((p) => p.$ && p.$['android:name'])
    .filter(Boolean);

  const app = (manifest.application || [])[0] || {};
  const grab = (tag) => (app[tag] || [])
    .map((n) => n.$ && n.$['android:name'])
    .filter(Boolean);

  summary.activities = grab('activity').concat(grab('activity-alias'));
  summary.services = grab('service');
  summary.receivers = grab('receiver');

  return summary;
}

app.listen(process.env.PORT || 8080, () => {
  console.log(`APK decompiler cloud service listening on port ${process.env.PORT || 8080}`);
});
