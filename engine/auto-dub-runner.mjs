import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 4567);
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SPEECH_TEMPO = 1.0;
const TTS_CONCURRENCY = 5;

function normalizeSpeechTempo(rawSpeed) {
  const num = Number(rawSpeed);
  if (!Number.isFinite(num)) return DEFAULT_SPEECH_TEMPO;
  return Number(Math.max(0.7, Math.min(1.4, num)).toFixed(2));
}

const workspaceDir = path.resolve(process.cwd(), 'workspace');
const uploadsDir = path.join(workspaceDir, 'uploads');
const voicesDir = path.join(workspaceDir, 'voices');
const distDir = path.resolve(process.cwd(), 'dist');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(voicesDir, { recursive: true });

const translationCache = new Map();

function toFfmpegPath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

function getBackendOrigin(req) {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/+$/, '');
  }
  const protoHeader = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (hostHeader) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader);
    const scheme = protoHeader || (isLocal ? 'http' : 'https');
    return `${scheme}://${hostHeader}`;
  }
  return `http://localhost:${PORT}`;
}

function cleanupOldWorkspaceFiles(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const dir of [workspaceDir, uploadsDir, voicesDir]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'uploads' || entry === 'voices') continue;
        const full = path.join(dir, entry);
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

setInterval(() => cleanupOldWorkspaceFiles(), 10 * 60 * 1000);

function runCmd(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 512, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || 'Command failed').trim();
        console.error('[KKH CMD ERROR]', msg.slice(-300));
        return reject(new Error(msg));
      }
      resolve({ stdout, stderr });
    });
  });
}

function hasValidAudioFile(filePath, minBytes = 300) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size >= minBytes;
  } catch {
    return false;
  }
}

async function getMediaDurationSec(filePath) {
  const fp = toFfmpegPath(filePath);
  try {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fp}"`;
    const { stdout } = await runCmd(cmd, 15000);
    const val = parseFloat(stdout.trim());
    if (!Number.isNaN(val) && val > 0.05) return val;
  } catch {
    // Fallback
  }
  return 0;
}

async function getVideoDimensions(filePath) {
  const fp = toFfmpegPath(filePath);
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${fp}"`;
    const { stdout } = await runCmd(cmd, 15000);
    const parts = stdout.trim().split('x').map((n) => parseInt(n, 10));
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      return { width: parts[0], height: parts[1] };
    }
  } catch {
    // Fallback
  }
  return { width: 1280, height: 720 };
}

async function getVideoDurationSec(filePath) {
  const d = await getMediaDurationSec(filePath);
  return d > 0 ? d : 10;
}

async function probeMediaStreams(filePath) {
  const info = {
    exists: fs.existsSync(filePath),
    sizeBytes: 0,
    sizeMB: 0,
    durationSec: 0,
    width: 0,
    height: 0,
    hasVideoStream: false,
    hasAudioStream: false,
    videoCodec: '',
    audioCodec: ''
  };
  if (!info.exists) return info;

  const st = fs.statSync(filePath);
  info.sizeBytes = st.size;
  info.sizeMB = Number((st.size / (1024 * 1024)).toFixed(2));
  info.durationSec = Number((await getMediaDurationSec(filePath)).toFixed(2));

  try {
    const fp = toFfmpegPath(filePath);
    const { stdout } = await runCmd(
      `ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -of json "${fp}"`,
      15000
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    for (const s of streams) {
      if (s.codec_type === 'video' && !info.hasVideoStream) {
        info.hasVideoStream = true;
        info.videoCodec = s.codec_name || 'video';
        info.width = Number(s.width || 0);
        info.height = Number(s.height || 0);
      }
      if (s.codec_type === 'audio' && !info.hasAudioStream) {
        info.hasAudioStream = true;
        info.audioCodec = s.codec_name || 'audio';
      }
    }
  } catch {
    // Ignore
  }

  return info;
}

async function translateAnyLanguageToBurmese(text) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  if (/[\u1000-\u109F]/.test(clean)) return clean;

  const sliced = clean.slice(0, 2400);
  if (translationCache.has(sliced)) {
    return translationCache.get(sliced);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=my&dt=t&q=${encodeURIComponent(sliced)}`;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const translated = data[0]
          .map((item) => (Array.isArray(item) && typeof item[0] === 'string' ? item[0] : ''))
          .join('')
          .trim();
        if (translated) {
          translationCache.set(sliced, translated);
          return translated;
        }
      }
    }
  } catch {
    // Fallback
  } finally {
    clearTimeout(timer);
  }
  return clean;
}

function splitLinesForFullCoverage(text, durationSec) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  const defaultLines = [
    'ဇာတ်လမ်းစတင်ပါပြီ။ မြန်မာဘာသာဖြင့် အစအဆုံး တင်ဆက်နေပါသည်။',
    'ဒီအခန်းမှာ ဖြစ်ပျက်နေတဲ့ အကြောင်းအရာကို ဆက်ကြည့်ရအောင်ပါ။',
    'ဒီအပိုင်းမှာတော့ ဇာတ်လမ်းကို အဆုံးသတ်လိုက်ပါပြီ။'
  ];

  const rawSentences = clean
    ? clean
        .split(/(?<=[.!?。！？။၊।])\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultLines;

  const lines = [];
  for (const sentence of rawSentences) {
    if (sentence.length <= 240) {
      lines.push(sentence);
    } else {
      const words = sentence.split(' ');
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > 235 && cur.trim()) {
          lines.push(cur.trim());
          cur = w;
        } else {
          cur = (cur + ' ' + w).trim();
        }
      }
      if (cur.trim()) lines.push(cur.trim());
    }
  }

  const total = Math.max(3, durationSec);
  const count = Math.max(1, lines.length);
  const slotSec = Math.max(1.5, total / count);

  return lines.map((line, idx) => {
    const startSec = Number((idx * slotSec).toFixed(2));
    const endSec = Number(Math.max(startSec + 1.4, (idx + 1) * slotSec).toFixed(2));
    return {
      index: idx,
      startSec,
      endSec,
      availSec: Math.max(1.4, endSec - startSec),
      spokenText: line
    };
  });
}

async function prepareBurmeseLinesForFullCoverage(text, durationSec) {
  const rawInput = (text || '').trim();
  if (!rawInput) return splitLinesForFullCoverage('', durationSec);

  const rawChunks = rawInput
    .split(/(?<=[.!?。！？။၊।\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const mergedChunks = [];
  let bucket = '';
  for (const ch of rawChunks) {
    if ((bucket + ' ' + ch).trim().length > 1600 && bucket.trim()) {
      mergedChunks.push(bucket.trim());
      bucket = ch;
    } else {
      bucket = (bucket + ' ' + ch).trim();
    }
  }
  if (bucket.trim()) mergedChunks.push(bucket.trim());

  const translatedChunks = await runWithConcurrency(mergedChunks, 4, async (chunk) =>
    translateAnyLanguageToBurmese(chunk)
  );

  return splitLinesForFullCoverage(translatedChunks.join(' '), durationSec);
}

async function fetchGoogleBurmeseTtsMp3(text, outMp3Path) {
  const snippet = (text || 'မင်္ဂလာပါ ဇာတ်လမ်းကို နားဆင်ပါ').trim().slice(0, 195);
  const endpoints = [
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=my&client=tw-ob`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=my&client=gtx`
  ];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 300) {
        fs.writeFileSync(outMp3Path, buf);
        return true;
      }
    } catch {
      // Next
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

function buildAtempoChain(tempo) {
  const safe = normalizeSpeechTempo(tempo);
  return `atempo=${safe.toFixed(2)}`;
}

async function synthesizeSingleSegmentWav(seg, voiceId, segDir, speechSpeed) {
  const isMale = voiceId === 'male';
  const safeText = (seg.spokenText || 'ဇာတ်လမ်းကို မြန်မာဘာသာဖြင့် နားဆင်နေပါသည်။')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 600);

  const fittedWav = path.join(segDir, 'fitted.wav');
  const fittedFfmpeg = toFfmpegPath(fittedWav);
  const tempoChain = buildAtempoChain(speechSpeed);

  const gttsMp3 = path.join(segDir, 'google_my.mp3');
  const okGtts = await fetchGoogleBurmeseTtsMp3(safeText, gttsMp3);
  if (okGtts && hasValidAudioFile(gttsMp3, 300)) {
    const gFilter = isMale
      ? `asetrate=44100*0.86,aresample=44100,atempo=1.14,${tempoChain},volume=1.65`
      : `${tempoChain},volume=1.65`;
    await runCmd(
      `ffmpeg -y -i "${toFfmpegPath(gttsMp3)}" -af "${gFilter}" -ar 44100 -ac 2 "${fittedFfmpeg}"`,
      15000
    );
  } else {
    const estSec = Math.max(0.8, Math.min(4.0, Number(seg.availSec) || 1.5));
    await runCmd(
      `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${estSec.toFixed(2)} "${fittedFfmpeg}"`,
      10000
    );
  }

  const durSec = await getMediaDurationSec(fittedWav);
  return { fittedWav, durMs: Math.max(400, Math.round((durSec || 1.2) * 1000)) };
}

async function runWithConcurrency(items, limit, workerFn) {
  const results = new Array(items.length);
  let idx = 0;

  async function next() {
    const current = idx++;
    if (current >= items.length) return;
    results[current] = await workerFn(items[current], current);
    await next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

async function buildSyncedTtsAudioAndSubEvents(
  segments,
  voiceId,
  durationSec,
  tempDir,
  finalMp3Path,
  speechSpeed = DEFAULT_SPEECH_TEMPO
) {
  const totalSec = Math.max(2, Math.ceil(durationSec));
  const segRoot = path.join(tempDir, 'segments');
  fs.mkdirSync(segRoot, { recursive: true });

  const allSegments = segments || [];
  const synthResults = await runWithConcurrency(allSegments, TTS_CONCURRENCY, async (seg, i) => {
    const segDir = path.join(segRoot, `s_${i}`);
    fs.mkdirSync(segDir, { recursive: true });
    return synthesizeSingleSegmentWav(seg, voiceId, segDir, speechSpeed);
  });

  const syncedSubEvents = [];
  const concatEntries = [];
  let cursorMs = 0;

  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    const item = synthResults[i];
    if (!item || !hasValidAudioFile(item.fittedWav, 200)) continue;

    const desiredStartMs = i === 0 ? 100 : Math.max(cursorMs + 100, Math.round(seg.startSec * 1000));
    const gapMs = Math.max(80, desiredStartMs - cursorMs);

    if (gapMs > 20) {
      const gapWav = path.join(segRoot, `gap_${i}.wav`);
      const gapSec = (gapMs / 1000).toFixed(3);
      await runCmd(`ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${gapSec} "${toFfmpegPath(gapWav)}"`, 10000);
      if (hasValidAudioFile(gapWav, 200)) {
        concatEntries.push(gapWav);
        cursorMs += gapMs;
      }
    }

    const startSecVal = Number((cursorMs / 1000).toFixed(2));
    cursorMs += item.durMs;
    const endSecVal = Number(((cursorMs + 100) / 1000).toFixed(2));

    concatEntries.push(item.fittedWav);
    syncedSubEvents.push({
      startSec: startSecVal,
      endSec: endSecVal,
      spokenText: seg.spokenText
    });
  }

  const effectiveTotalSec = Math.max(totalSec, Math.ceil(cursorMs / 1000) + 1);
  const finalMp3Ffmpeg = toFfmpegPath(finalMp3Path);

  if (concatEntries.length > 0) {
    const listPath = path.join(tempDir, 'concat_audio.txt');
    const listContent = concatEntries
      .map((p) => `file '${toFfmpegPath(p).replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent, 'utf-8');

    await runCmd(
      `ffmpeg -y -f concat -safe 0 -i "${toFfmpegPath(listPath)}" -af "apad=whole_dur=${effectiveTotalSec}" -t ${effectiveTotalSec} -c:a libmp3lame -q:a 5 "${finalMp3Ffmpeg}"`,
      120000
    );
    return { syncedSubEvents, effectiveTotalSec };
  }

  await runCmd(
    `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${effectiveTotalSec} -c:a libmp3lame -q:a 5 "${finalMp3Ffmpeg}"`,
    60000
  );
  return {
    syncedSubEvents: allSegments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, spokenText: s.spokenText })),
    effectiveTotalSec
  };
}

function findBurmeseFontFile() {
  const candidates = [
    'C:/Windows/Fonts/Pyidaungsu-2.5.3_Regular.ttf',
    'C:/Windows/Fonts/mmrtext.ttf',
    'C:/Windows/Fonts/NotoSansMyanmar-Regular.ttf',
    'C:/Windows/Fonts/padauk.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansMyanmar-Regular.ttf',
    '/usr/share/fonts/truetype/padauk/Padauk.ttf'
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 10000) return p;
    } catch {
      // Ignore
    }
  }
  return '';
}

function escapeFilterPath(filePath) {
  return toFfmpegPath(filePath).replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

function formatSrtTime(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hours)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

function writeBurmeseSrtFile(syncedSubEvents, srtPath) {
  const blocks = [];
  let idx = 1;
  for (const ev of syncedSubEvents || []) {
    const text = (ev.spokenText || '').replace(/\r?\n/g, ' ').trim();
    if (!text) continue;
    const s = formatSrtTime(ev.startSec);
    const e = formatSrtTime(Math.max((Number(ev.startSec) || 0) + 0.6, Number(ev.endSec) || 1.5));
    blocks.push(`${idx}\n${s} --> ${e}\n${text}\n`);
    idx += 1;
  }
  fs.writeFileSync(srtPath, blocks.join('\n'), 'utf-8');
}

function buildBlurAndBottomSubFilter(
  srtPath,
  videoWidth,
  videoHeight,
  blurOriginalSub,
  blurArea,
  includeSubtitles = true
) {
  const w = Math.max(360, videoWidth || 1280);
  const h = Math.max(360, videoHeight || 720);
  const isPortrait = h > w;
  const rawFont = findBurmeseFontFile();

  const bandH = Math.max(38, Math.round(h * 0.12));
  const bandW = Math.max(180, Math.min(w, Math.round(w * 0.86)));
  const bandX = Math.max(0, Math.round((w - bandW) / 2));
  const bottomY = Math.max(0, Math.min(h - bandH, h - bandH - Math.round(h * 0.02)));
  const topY = Math.max(0, Math.min(h - bandH, Math.round(h * 0.04)));

  const graph = [];
  let curLabel = '[v0]';
  graph.push(`[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2${curLabel}`);

  if (blurOriginalSub) {
    let idx = 0;
    if (blurArea === 'top' || blurArea === 'both') {
      const nextLabel = `[vblur${idx}]`;
      graph.push(
        `${curLabel}split[s${idx}a][s${idx}b];` +
          `[s${idx}b]crop=${bandW}:${bandH}:${bandX}:${topY},boxblur=6:1[bl${idx}];` +
          `[s${idx}a][bl${idx}]overlay=${bandX}:${topY}${nextLabel}`
      );
      curLabel = nextLabel;
      idx += 1;
    }
    if (blurArea === 'bottom' || blurArea === 'both' || !blurArea) {
      const nextLabel = `[vblur${idx}]`;
      graph.push(
        `${curLabel}split[s${idx}a][s${idx}b];` +
          `[s${idx}b]crop=${bandW}:${bandH}:${bandX}:${bottomY},boxblur=6:1[bl${idx}];` +
          `[s${idx}a][bl${idx}]overlay=${bandX}:${bottomY}${nextLabel}`
      );
      curLabel = nextLabel;
      idx += 1;
    }
  }

  const afterBlur = [];
  if (includeSubtitles && srtPath && fs.existsSync(srtPath)) {
    const subFontSize = isPortrait ? Math.max(17, Math.round(h * 0.022)) : Math.max(19, Math.round(h * 0.027));
    const marginV = Math.max(20, Math.round(h * 0.032));
    const escapedSrt = escapeFilterPath(srtPath);
    const fontName = rawFont.toLowerCase().includes('pyidaungsu')
      ? 'Pyidaungsu'
      : rawFont.toLowerCase().includes('mmrtext')
      ? 'Myanmar Text'
      : 'Noto Sans Myanmar';
    afterBlur.push(
      `subtitles='${escapedSrt}':force_style='FontName=${fontName},FontSize=${subFontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${marginV}'`
    );
  }
  afterBlur.push('format=yuv420p[vout]');

  graph.push(`${curLabel}${afterBlur.join(',')}`);
  return graph.join(';');
}

async function ensureGuaranteedAudioFile(voiceMp3, totalDurationSec, outputDir) {
  const dur = Math.max(2, Math.ceil(Number(totalDurationSec) || 10));
  const guaranteedWav = path.join(outputDir, `guaranteed_audio_${Date.now()}.wav`);
  const guaranteedWavFfmpeg = toFfmpegPath(guaranteedWav);

  if (hasValidAudioFile(voiceMp3, 300)) {
    const aDur = await getMediaDurationSec(voiceMp3);
    if (aDur > 0.2) {
      await runCmd(
        `ffmpeg -y -i "${toFfmpegPath(voiceMp3)}" -af "apad=whole_dur=${dur}" -t ${dur} -ar 44100 -ac 2 "${guaranteedWavFfmpeg}"`,
        120000
      );
      if (hasValidAudioFile(guaranteedWav, 600)) return guaranteedWav;
    }
  }

  await runCmd(
    `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${dur} "${guaranteedWavFfmpeg}"`,
    60000
  );
  return guaranteedWav;
}

async function muxPlayableMp4WithBlurAndBottomSub(
  inputPath,
  voiceMp3,
  srtPath,
  width,
  height,
  totalDurationSec,
  blurOriginalSub,
  blurArea,
  outputPath
) {
  const dur = Math.max(1, Number(totalDurationSec) || 10);
  const workSubDir = path.dirname(outputPath);
  const audioSource = await ensureGuaranteedAudioFile(voiceMp3, dur, workSubDir);
  const inFfmpeg = toFfmpegPath(inputPath);
  const audFfmpeg = toFfmpegPath(audioSource);
  const outFfmpeg = toFfmpegPath(outputPath);
  const warnings = [];

  if (!blurOriginalSub) {
    try {
      const cmdCopy = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -map 0:v:0 -map 1:a:0 -t ${dur} -c:v copy -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
      await runCmd(cmdCopy, 180000);
      const checkCopy = await probeMediaStreams(outputPath);
      if (checkCopy.hasVideoStream && checkCopy.hasAudioStream && checkCopy.sizeBytes > 1024) {
        fs.rmSync(audioSource, { force: true });
        return { subBurned: false, blurApplied: false, streamCopied: true, warnings };
      }
    } catch (err) {
      warnings.push(`Copy mux fallback: ${err.message.slice(-120)}`);
    }
  }

  try {
    const fcFull = buildBlurAndBottomSubFilter(
      srtPath,
      width,
      height,
      blurOriginalSub,
      blurArea,
      true
    );
    const cmdFull = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -filter_complex "${fcFull}" -map "[vout]" -map 1:a:0 -t ${dur} -c:v libx264 -preset ultrafast -crf 28 -threads 2 -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
    await runCmd(cmdFull, 240000);
    const check1 = await probeMediaStreams(outputPath);
    if (check1.hasVideoStream && check1.hasAudioStream && check1.sizeBytes > 1024) {
      fs.rmSync(audioSource, { force: true });
      return { subBurned: true, blurApplied: Boolean(blurOriginalSub), streamCopied: false, warnings };
    }
  } catch (err) {
    warnings.push(`Blur+SRT fallback: ${err.message.slice(-140)}`);
  }

  const cmdSafe = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -map 0:v:0 -map 1:a:0 -t ${dur} -c:v copy -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
  await runCmd(cmdSafe, 180000);
  fs.rmSync(audioSource, { force: true });
  return { subBurned: false, blurApplied: false, streamCopied: true, warnings };
}

const server = http.createServer((req, res) => {
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (reqPath === '/health' || reqPath === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, studio: 'KKH AI STUDIO', status: 'READY', speechSpeed: DEFAULT_SPEECH_TEMPO }));
  }

  if (req.method === 'GET' && req.url && (req.url.startsWith('/output/') || req.url.startsWith('/api/output/'))) {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const rawFile = reqUrl.searchParams.get('file') || req.url.replace(/^\/(api\/)?output\//, '');
    const safeName = path.basename(decodeURIComponent(rawFile));
    const filePath = path.join(workspaceDir, safeName);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Output file not found' }));
    }

    const stat = fs.statSync(filePath);
    const asDownload = reqUrl.searchParams.get('download') === '1';
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    };
    if (asDownload) {
      headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
    }

    const range = req.headers.range;
    if (range && !asDownload) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunkSize
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  if (req.method === 'POST' && (reqPath === '/upload-video' || reqPath === '/api/upload-video')) {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || 'uploaded_video.mp4');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(uploadsDir, safeName);
    const writeStream = fs.createWriteStream(destPath);
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_VIDEO_BYTES) {
        aborted = true;
        writeStream.destroy();
        fs.rm(destPath, { force: true }, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Video size 2GB ထက် ကျော်နေပါသည်။' }));
        req.destroy();
        return;
      }
      writeStream.write(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      writeStream.end(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fileName: safeName, sizeMB: Number((totalBytes / (1024 * 1024)).toFixed(2)) }));
      });
    });

    writeStream.on('error', (err) => {
      if (aborted) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (req.method === 'POST' && (reqPath === '/upload-voice' || reqPath === '/api/upload-voice')) {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || 'my_voice.wav');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(voicesDir, safeName);
    const writeStream = fs.createWriteStream(destPath);
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > 100 * 1024 * 1024) {
        aborted = true;
        writeStream.destroy();
        fs.rm(destPath, { force: true }, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Voice file 100MB ထက် ကျော်နေပါသည်။' }));
        req.destroy();
        return;
      }
      writeStream.write(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      writeStream.end(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fileName: safeName, sizeMB: Number((totalBytes / (1024 * 1024)).toFixed(2)) }));
      });
    });

    writeStream.on('error', (err) => {
      if (aborted) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (req.method === 'POST' && (reqPath === '/dub-full-video' || reqPath === '/api/dub-full-video')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const {
          videoFile = 'input.mp4',
          gender = 'male',
          manualText = '',
          customVoiceFile = '',
          blurOriginalSub = false,
          blurArea = 'bottom',
          voiceSpeed = DEFAULT_SPEECH_TEMPO
        } = JSON.parse(body || '{}');

        const safeName = path.basename(videoFile);
        const uploadCandidate = path.join(uploadsDir, safeName);
        const workspaceCandidate = path.join(workspaceDir, safeName);
        const inputPath = fs.existsSync(uploadCandidate) ? uploadCandidate : workspaceCandidate;

        if (!fs.existsSync(inputPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: `Video ဖိုင် မတွေ့ပါ: ${safeName}` }));
        }

        const inputAudit = await probeMediaStreams(inputPath);
        if (inputAudit.sizeBytes > MAX_VIDEO_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Video size 2GB ထက် ကျော်နေပါသည်။' }));
        }
        if (!inputAudit.hasVideoStream || inputAudit.sizeBytes < 512) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'တင်ထားသော Video ဖိုင်ထဲတွင် Video stream မတွေ့ပါ သို့မဟုတ် ဖိုင်ပျက်နေပါသည်။'
          }));
        }

        const appliedTempo = normalizeSpeechTempo(voiceSpeed);
        const customVoiceCandidate = customVoiceFile ? path.join(voicesDir, path.basename(customVoiceFile)) : '';
        const hasCustomVoice = Boolean(customVoiceCandidate && hasValidAudioFile(customVoiceCandidate, 300));
        const videoDur = await getVideoDurationSec(inputPath);
        const customVoiceDur = hasCustomVoice ? await getMediaDurationSec(customVoiceCandidate) : 0;
        const durationSec = Math.max(3, videoDur);

        const { width, height } = await getVideoDimensions(inputPath);
        const tempDir = fs.mkdtempSync(path.join(workspaceDir, 'tmp_dub_'));

        let effectiveInputText = (manualText || '').trim();
        if (!effectiveInputText && hasCustomVoice) {
          effectiveInputText = [
            'ဇာတ်လမ်းကို မြန်မာဘာသာဖြင့် အစအဆုံး တင်ဆက်နေပါသည်။',
            'ဒီအခန်းမှာ ဖြစ်ပျက်နေတဲ့ အကြောင်းအရာကို ဆက်ကြည့်ရအောင်ပါ။',
            'ဒီအပိုင်းမှာတော့ ဇာတ်လမ်းကို အဆုံးသတ်လိုက်ပါပြီ။'
          ].join(' ');
        }

        const timedSegments = await prepareBurmeseLinesForFullCoverage(effectiveInputText, durationSec);
        const voiceMp3 = path.join(tempDir, 'synced_tts_burmese.mp3');
        let syncedSubEvents;
        let finalDurationSec = durationSec;

        if (hasCustomVoice) {
          const normalizedUserWav = path.join(tempDir, 'user_voice_norm.wav');
          const tempoChain = buildAtempoChain(appliedTempo);
          await runCmd(
            `ffmpeg -y -i "${toFfmpegPath(customVoiceCandidate)}" -af "${tempoChain}" -ar 44100 -ac 2 "${toFfmpegPath(normalizedUserWav)}"`,
            120000
          );
          const totalCeil = Math.max(3, Math.ceil(durationSec));
          if (customVoiceDur > 0.2 && customVoiceDur < totalCeil - 0.5) {
            const loopCount = Math.max(1, Math.ceil(totalCeil / Math.max(0.5, customVoiceDur)));
            await runCmd(
              `ffmpeg -y -stream_loop ${loopCount} -i "${toFfmpegPath(normalizedUserWav)}" -t ${totalCeil} -c:a libmp3lame -q:a 5 "${toFfmpegPath(voiceMp3)}"`,
              120000
            );
          } else {
            await runCmd(
              `ffmpeg -y -i "${toFfmpegPath(normalizedUserWav)}" -af "apad=whole_dur=${totalCeil}" -t ${totalCeil} -c:a libmp3lame -q:a 5 "${toFfmpegPath(voiceMp3)}"`,
              120000
            );
          }
          syncedSubEvents = timedSegments.map((s) => ({
            startSec: s.startSec,
            endSec: s.endSec,
            spokenText: s.spokenText
          }));
        } else {
          const built = await buildSyncedTtsAudioAndSubEvents(
            timedSegments,
            gender,
            durationSec,
            tempDir,
            voiceMp3,
            appliedTempo
          );
          syncedSubEvents = built.syncedSubEvents;
          finalDurationSec = Math.max(durationSec, built.effectiveTotalSec);
        }

        const srtPath = path.join(tempDir, 'burmese_subs.srt');
        writeBurmeseSrtFile(syncedSubEvents, srtPath);

        const fullBurmeseScript = syncedSubEvents.map((s) => `[${s.startSec}s-${s.endSec}s] ${s.spokenText}`).join('\n');
        const base = safeName.replace(/\.[^/.]+$/, '');
        const outputFileName = `${base}_KKH_SUB_${gender.toUpperCase()}_${Date.now()}.mp4`;
        const outputPath = path.join(workspaceDir, outputFileName);

        const { subBurned, blurApplied, streamCopied, warnings } = await muxPlayableMp4WithBlurAndBottomSub(
          inputPath,
          voiceMp3,
          srtPath,
          width,
          height,
          finalDurationSec,
          blurOriginalSub,
          blurArea,
          outputPath
        );
        const outAudit = await probeMediaStreams(outputPath);
        fs.rmSync(tempDir, { recursive: true, force: true });

        if (!outAudit.exists || outAudit.sizeBytes < 1024 || !outAudit.hasVideoStream) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'ထွက်လာသော Video ဖိုင် ပျက်နေပါသည်။ ဖိုင်အရွယ်အစား သို့မဟုတ် စာသားကို လျှော့ပြီး ထပ်စမ်းပါ။',
            warnings
          }));
        }

        if (!outAudit.hasAudioStream) {
          warnings.push('Audio stream မတွေ့ပါ။');
        }

        const origin = getBackendOrigin(req);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          ok: true,
          outputFileName,
          hasAudio: outAudit.hasAudioStream,
          subBurned,
          blurApplied,
          streamCopied,
          speechSpeed: appliedTempo,
          streamUrl: `${origin}/output/${encodeURIComponent(outputFileName)}`,
          downloadUrl: `${origin}/output/${encodeURIComponent(outputFileName)}?download=1`,
          burmeseText: fullBurmeseScript,
          segmentsCount: syncedSubEvents.length,
          gender,
          audit: {
            ...outAudit,
            subBurned,
            blurApplied,
            streamCopied,
            speechSpeed: appliedTempo
          },
          warnings
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && fs.existsSync(distDir)) {
    const cleanUrl = (req.url || '/').split('?')[0];
    const relPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
    const candidateFile = path.resolve(distDir, relPath);
    const indexFile = path.join(distDir, 'index.html');
    const targetFile =
      candidateFile.startsWith(distDir) && fs.existsSync(candidateFile) && fs.statSync(candidateFile).isFile()
        ? candidateFile
        : indexFile;

    if (fs.existsSync(targetFile)) {
      const ext = path.extname(targetFile).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.json': 'application/json; charset=utf-8'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      return fs.createReadStream(targetFile).pipe(res);
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[KKH AI STUDIO] Running on http://localhost:${PORT} (30m Turbo Mode)`);
});