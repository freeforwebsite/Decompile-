# APKtrace — Cloud APK Decompiler

Upload an `.apk`, get back the decoded manifest, permissions, activities/services/receivers,
resources, and full Java source (via jadx) reconstructed from the bytecode. Single Docker
service — frontend and backend together, no separate deploy needed.

Tested end-to-end locally with apktool 3.0.2 + jadx 1.5.6 against a real sample APK.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render dashboard → **New +** → **Web Service** → connect the repo.
3. Environment: **Docker** (Render auto-detects the `Dockerfile`, no build/start command needed).
4. Instance type: pick at least **Standard** (1GB+ RAM) — apktool + jadx need real memory for
   anything bigger than a toy APK. The free tier will OOM on real-world apps.
5. No environment variables are required — the Dockerfile already sets `APKTOOL_JAR`,
   `JADX_BIN`, and `WORK_ROOT`. Optionally set `MAX_UPLOAD_MB` (default 250).
6. Deploy. Render builds the image (downloads apktool + jadx during build, ~1-2 min extra),
   then serves the site on your `*.onrender.com` URL — same one for UI and API.

## How it works

- `POST /api/upload` — accepts the APK, kicks off a background job, returns a `jobId`.
- `GET /api/status/:jobId` — poll this; returns stage progress and, once done, the manifest
  summary (package, version, SDK range, permissions, components).
- `GET /api/download/:jobId/full|source|resources` — streams a zip of the requested output.
- Jobs and their files are swept from disk after 1 hour.

## Local development

```bash
npm install
export APKTOOL_JAR=/path/to/apktool.jar
export JADX_BIN=/path/to/jadx/bin/jadx
npm start
```

Requires a JDK on PATH (`java`) since both apktool and jadx are JVM tools.

## Notes

- This decompiles bytecode you already have a right to inspect (your own apps, or
  reverse-engineering for interoperability/security research). It doesn't defeat DRM or
  code obfuscation beyond what apktool/jadx do out of the box.
- jadx can't perfectly decompile 100% of every app — some methods may show as bytecode
  comments where reconstruction isn't possible. That's normal, not a bug in this service.
