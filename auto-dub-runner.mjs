import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 4567);
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const DEFAULT_SPEECH_TEMPO = 0.94;

function normalizeSpeechTempo(rawSpeed) {
  const num = Number(rawSpeed);
  if (!Number.isFinite(num)) return DEFAULT_SPEECH_TEMPO;
  return Number(Math.max(0.7, Math.min(1.35, num)).toFixed(2));
}

const workspaceDir = path.resolve(process.cwd(), 'workspace');
const uploadsDir = path.join(workspaceDir, 'uploads');
const voicesDir = path.join(workspaceDir, 'voices');
const distDir = path.resolve(process.cwd(), 'dist');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(voicesDir, { recursive: true });

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

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 350 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || 'Command failed').trim();
        console.error('[KKH CMD ERROR]', msg.slice(-500));
        return reject(new Error(msg));
      }
      resolve({ stdout, stderr });
    });
  });
}

function hasValidAudioFile(filePath, minBytes = 400) {
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
    const { stdout } = await runCmd(cmd);
    const val = parseFloat(stdout.trim());
    if (!Number.isNaN(val) && val > 0.05) return val;
  } catch {
    // Fallback
  }
  try {
    const cmd2 = `ffprobe -v error -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${fp}"`;
    const { stdout } = await runCmd(cmd2);
    for (const line of stdout.trim().split(/\r?\n/)) {
      const val = parseFloat(line.trim());
      if (!Number.isNaN(val) && val > 0.05) return val;
    }
  } catch {
    // Fallback
  }
  return 0;
}

async function getVideoDimensions(filePath) {
  const fp = toFfmpegPath(filePath);
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${fp}"`;
    const { stdout } = await runCmd(cmd);
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
      `ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -of json "${fp}"`
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

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=my&dt=t&q=${encodeURIComponent(clean.slice(0, 1500))}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const translated = data[0]
          .map((item) => (Array.isArray(item) && typeof item[0] === 'string' ? item[0] : ''))
          .join('')
          .trim();
        if (translated) return translated;
      }
    }
  } catch {
    // Fallback
  }
  return clean;
}

function splitLinesForFullCoverage(text, durationSec) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  const defaultLines = [
    'ဇာတ်လမ်းစတင်ပါပြီ။ မြန်မာဘာသာဖြင့် အစအဆုံး တင်ဆက်နေပါသည်။',
    'ဒီအခန်းမှာ ဖြစ်ပျက်နေတဲ့ အကြောင်းအရာကို ဆက်ကြည့်ရအောင်ပါ။',
    'ဆက်လက်ပြီး အဓိက အချက်အလက်တွေကို ကြည့်ရှုရမှာပါ။',
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
    if (sentence.length <= 75) {
      lines.push(sentence);
    } else {
      const words = sentence.split(' ');
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length > 72 && cur.trim()) {
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
  const slotSec = Math.max(1.8, total / count);

  return lines.map((line, idx) => {
    const startSec = Number((idx * slotSec).toFixed(2));
    const endSec = Number(Math.max(startSec + 1.6, (idx + 1) * slotSec).toFixed(2));
    return {
      index: idx,
      startSec,
      endSec,
      availSec: Math.max(1.6, endSec - startSec),
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

  const translatedChunks = [];
  for (const chunk of rawChunks) {
    const myChunk = await translateAnyLanguageToBurmese(chunk);
    if (myChunk) translatedChunks.push(myChunk);
  }
  return splitLinesForFullCoverage(translatedChunks.join(' '), durationSec);
}

async function fetchGoogleBurmeseTtsMp3(text, outMp3Path) {
  const snippet = (text || 'မင်္ဂလာပါ ဇာတ်လမ်းကို နားဆင်ပါ').trim().slice(0, 190);
  const endpoints = [
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=my&client=tw-ob`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(snippet)}&tl=my&client=gtx`
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 400) {
        fs.writeFileSync(outMp3Path, buf);
        return true;
      }
    } catch {
      // Next
    }
  }
  return false;
}

async function synthesizeTtsVoiceToWav(text, voiceId, segDir, outWavPath) {
  const isMale = voiceId === 'male';
  const primaryVoice = isMale ? 'my-MM-ThihaNeural' : 'my-MM-NilarNeural';
  const backupVoice = isMale ? 'my-MM-NilarNeural' : 'my-MM-ThihaNeural';

  const safeText = (text || 'ဇာတ်လမ်းကို မြန်မာဘာသာဖြင့် နားဆင်နေပါသည်။')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim()
    .slice(0, 500);

  const rawVoiceWav = path.join(segDir, 'raw_voice.wav');
  const rawVoiceFfmpeg = toFfmpegPath(rawVoiceWav);
  const outWavFfmpeg = toFfmpegPath(outWavPath);
  let synthesized = false;

  const utf8TextFile = path.join(segDir, 'burmese_line.txt');
  fs.writeFileSync(utf8TextFile, safeText, 'utf-8');
  const utf8TextFfmpeg = toFfmpegPath(utf8TextFile);

  for (const pyBin of ['python3', 'python', 'py']) {
    try {
      const mp3Tmp = path.join(segDir, `edge_primary_${pyBin}.mp3`);
      const mp3TmpFfmpeg = toFfmpegPath(mp3Tmp);
      const pitchArg = isMale ? '--pitch="-4Hz" --rate="-4%"' : '--rate="-4%"';
      await runCmd(`${pyBin} -m edge_tts --voice "${primaryVoice}" ${pitchArg} --file "${utf8TextFfmpeg}" --write-media "${mp3TmpFfmpeg}"`);
      if (hasValidAudioFile(mp3Tmp, 500)) {
        const maleEq = isMale
          ? 'bass=g=4:f=140:w=0.6,treble=g=2:f=3200:w=0.6,volume=1.85'
          : 'treble=g=2:f=3500:w=0.6,volume=1.8';
        await runCmd(`ffmpeg -y -i "${mp3TmpFfmpeg}" -af "aresample=44100,${maleEq}" -ar 44100 -ac 2 "${rawVoiceFfmpeg}"`);
        if (hasValidAudioFile(rawVoiceWav, 800)) {
          synthesized = true;
          break;
        }
      }
    } catch {
      // Try next python binary
    }
  }

  if (!synthesized) {
    for (const pyBin of ['python3', 'python', 'py']) {
      try {
        const mp3Backup = path.join(segDir, `edge_backup_${pyBin}.mp3`);
        const mp3BackupFfmpeg = toFfmpegPath(mp3Backup);
        await runCmd(`${pyBin} -m edge_tts --voice "${backupVoice}" --file "${utf8TextFfmpeg}" --write-media "${mp3BackupFfmpeg}"`);
        if (hasValidAudioFile(mp3Backup, 500)) {
          const shapeFilter = isMale
            ? 'asetrate=44100*0.83,aresample=44100,atempo=1.18,bass=g=5:f=130:w=0.6,volume=1.85'
            : 'aresample=44100,volume=1.8';
          await runCmd(`ffmpeg -y -i "${mp3BackupFfmpeg}" -af "${shapeFilter}" -ar 44100 -ac 2 "${rawVoiceFfmpeg}"`);
          if (hasValidAudioFile(rawVoiceWav, 800)) {
            synthesized = true;
            break;
          }
        }
      } catch {
        // Try next
      }
    }
  }

  if (!synthesized) {
    try {
      const gttsMp3 = path.join(segDir, 'google_my.mp3');
      const gttsMp3Ffmpeg = toFfmpegPath(gttsMp3);
      const okGtts = await fetchGoogleBurmeseTtsMp3(safeText, gttsMp3);
      if (okGtts && hasValidAudioFile(gttsMp3, 500)) {
        const shapeFilter = isMale
          ? 'asetrate=44100*0.83,aresample=44100,atempo=1.18,bass=g=5:f=130:w=0.6,volume=1.85'
          : 'aresample=44100,volume=1.8';
        await runCmd(`ffmpeg -y -i "${gttsMp3Ffmpeg}" -af "${shapeFilter}" -ar 44100 -ac 2 "${rawVoiceFfmpeg}"`);
        if (hasValidAudioFile(rawVoiceWav, 800)) {
          synthesized = true;
        }
      }
    } catch {
      // Fallback
    }
  }

  if (!synthesized) {
    const baseFreq = isMale ? 145 : 240;
    await runCmd(
      `ffmpeg -y -f lavfi -i "sine=frequency=${baseFreq}:sample_rate=44100:duration=1.6" -af "afade=t=in:st=0:d=0.2,afade=t=out:st=1.2:d=0.4,lowpass=f=850,volume=0.4" -ar 44100 -ac 2 "${rawVoiceFfmpeg}"`
    );
  }

  try {
    await runCmd(`ffmpeg -y -i "${rawVoiceFfmpeg}" -af "highpass=f=75,lowpass=f=12000,loudnorm=I=-14:TP=-1.0:LRA=11" -ar 44100 -ac 2 "${outWavFfmpeg}"`);
  } catch {
    await runCmd(`ffmpeg -y -i "${rawVoiceFfmpeg}" -ar 44100 -ac 2 "${outWavFfmpeg}"`);
  }
}

function buildAtempoChain(tempo) {
  const safe = normalizeSpeechTempo(tempo);
  if (safe >= 0.5 && safe <= 2.0) {
    return `atempo=${safe.toFixed(2)}`;
  }
  return `atempo=${DEFAULT_SPEECH_TEMPO}`;
}

async function applySpeechSpeed(rawWavPath, fittedWavPath, speed) {
  const tempoChain = buildAtempoChain(speed);
  await runCmd(`ffmpeg -y -i "${toFfmpegPath(rawWavPath)}" -af "${tempoChain},volume=1.65" -ar 44100 -ac 2 "${toFfmpegPath(fittedWavPath)}"`);
}

async function buildSyncedTtsAudioAndSubEvents(segments, voiceId, durationSec, tempDir, finalMp3Path, speechSpeed = DEFAULT_SPEECH_TEMPO) {
  const totalSec = Math.max(2, Math.ceil(durationSec));
  const syncedSubEvents = [];
  const concatEntries = [];
  const segRoot = path.join(tempDir, 'segments');
  fs.mkdirSync(segRoot, { recursive: true });
  let cursorMs = 0;

  const allSegments = (segments || []).slice(0, 120);
  for (let i = 0; i < allSegments.length; i++) {
    const seg = allSegments[i];
    const segDir = path.join(segRoot, `s_${i}`);
    fs.mkdirSync(segDir, { recursive: true });
    const clearWav = path.join(segDir, 'clear.wav');
    const fittedWav = path.join(segDir, 'fitted.wav');
    await synthesizeTtsVoiceToWav(seg.spokenText, voiceId, segDir, clearWav);

    if (hasValidAudioFile(clearWav, 300)) {
      await applySpeechSpeed(clearWav, fittedWav, speechSpeed);
      if (hasValidAudioFile(fittedWav, 300)) {
        const fittedDurSec = await getMediaDurationSec(fittedWav);
        const fittedDurMs = Math.max(400, Math.round(fittedDurSec * 1000));
        const desiredStartMs = i === 0 ? 150 : Math.max(cursorMs + 180, Math.round(seg.startSec * 1000));
        const gapMs = Math.max(120, desiredStartMs - cursorMs);

        if (gapMs > 20) {
          const gapWav = path.join(segDir, 'gap.wav');
          const gapSec = (gapMs / 1000).toFixed(3);
          await runCmd(`ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=stereo" -t ${gapSec} "${toFfmpegPath(gapWav)}"`);
          if (hasValidAudioFile(gapWav, 200)) {
            concatEntries.push(gapWav);
            cursorMs += gapMs;
          }
        }

        const startSecVal = Number((cursorMs / 1000).toFixed(2));
        cursorMs += fittedDurMs;
        const endSecVal = Number(((cursorMs + 150) / 1000).toFixed(2));

        concatEntries.push(fittedWav);
        syncedSubEvents.push({
          startSec: startSecVal,
          endSec: endSecVal,
          spokenText: seg.spokenText
        });
      }
    }
  }

  const effectiveTotalSec = Math.max(totalSec, Math.ceil(cursorMs / 1000) + 1);
  const finalMp3Ffmpeg = toFfmpegPath(finalMp3Path);

  if (concatEntries.length > 0) {
    const listPath = path.join(tempDir, 'concat_audio.txt');
    const listContent = concatEntries
      .map((p) => `file '${toFfmpegPath(p).replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent, 'utf-8');

    try {
      await runCmd(
        `ffmpeg -y -f concat -safe 0 -i "${toFfmpegPath(listPath)}" -af "highpass=f=75,volume=1.6,apad=whole_dur=${effectiveTotalSec}" -t ${effectiveTotalSec} -c:a libmp3lame -q:a 2 "${finalMp3Ffmpeg}"`
      );
      if (hasValidAudioFile(finalMp3Path, 600)) {
        return { syncedSubEvents, effectiveTotalSec };
      }
    } catch {
      // Fallback
    }
  }

  const singleWav = path.join(tempDir, 'direct_tts.wav');
  const singleWavFfmpeg = toFfmpegPath(singleWav);
  const fullText = allSegments.map((s) => s.spokenText).join(' ') || 'မင်္ဂလာပါ ဇာတ်လမ်းကို နားဆင်ပါ။';
  await synthesizeTtsVoiceToWav(fullText, voiceId, tempDir, singleWav);
  const singleDur = await getMediaDurationSec(singleWav);
  const finalDur = Math.max(effectiveTotalSec, Math.ceil(singleDur) + 1);
  await runCmd(
    `ffmpeg -y -i "${singleWavFfmpeg}" -af "apad=whole_dur=${finalDur},loudnorm=I=-14:TP=-1.0:LRA=11" -t ${finalDur} -c:a libmp3lame -q:a 2 "${finalMp3Ffmpeg}"`
  );
  return {
    syncedSubEvents: allSegments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, spokenText: s.spokenText })),
    effectiveTotalSec: finalDur
  };
}

function sanitizeForDrawtext(str) {
  return (str || '')
    .replace(/[\\:'\[\]%\r\n]/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBurmeseFontFile() {
  const candidates = [
    'C:/Windows/Fonts/Pyidaungsu-2.5.3_Regular.ttf',
    'C:/Windows/Fonts/mmrtext.ttf',
    'C:/Windows/Fonts/Pyidaungsu-2.5.3_Bold.ttf',
    'C:/Windows/Fonts/mmrtextb.ttf',
    'C:/Windows/Fonts/mm3.ttf',
    'C:/Windows/Fonts/Myanmar3.ttf',
    'C:/Windows/Fonts/pyidaungsu.ttf',
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
  syncedSubEvents,
  srtPath,
  videoWidth,
  videoHeight,
  totalDurationSec,
  blurOriginalSub,
  blurArea,
  includeSubtitles = true
) {
  const w = Math.max(360, videoWidth || 1280);
  const h = Math.max(360, videoHeight || 720);
  const isPortrait = h > w;
  const dur = Math.max(1, Number(totalDurationSec) || 10);
  const rawFont = findBurmeseFontFile();
  const escapedFont = escapeFilterPath(rawFont);
  const fontParam = rawFont ? `fontfile='${escapedFont}':` : '';

  const tagFontSize = isPortrait ? Math.max(12, Math.round(h * 0.014)) : Math.max(13, Math.round(h * 0.017));
  const tagX = `w-tw-${Math.max(14, Math.round(w * 0.025))}`;
  const tagY = `h-th-${Math.max(10, Math.round(h * 0.014))}`;

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
          `[s${idx}b]crop=${bandW}:${bandH}:${bandX}:${topY},gblur=sigma=12[bl${idx}];` +
          `[s${idx}a][bl${idx}]overlay=${bandX}:${topY}${nextLabel}`
      );
      curLabel = nextLabel;
      idx += 1;
    }
    if (blurArea === 'bottom' || blurArea === 'both' || !blurArea) {
      const nextLabel = `[vblur${idx}]`;
      graph.push(
        `${curLabel}split[s${idx}a][s${idx}b];` +
          `[s${idx}b]crop=${bandW}:${bandH}:${bandX}:${bottomY},gblur=sigma=12[bl${idx}];` +
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
  } else if (includeSubtitles) {
    const subFontSize = isPortrait ? Math.max(18, Math.round(h * 0.022)) : Math.max(20, Math.round(h * 0.028));
    const subY = `h-th-${Math.max(22, Math.round(h * 0.032))}`;
    for (const ev of (syncedSubEvents || []).slice(0, 30)) {
      const s = Math.max(0, Number(ev.startSec) || 0).toFixed(2);
      const e = Math.max(Number(s) + 0.4, Number(ev.endSec) || Number(s) + 1.5).toFixed(2);
      const txt = sanitizeForDrawtext(ev.spokenText).slice(0, 100);
      if (!txt) continue;
      afterBlur.push(
        `drawtext=${fontParam}text='${txt}':fontcolor=white:fontsize=${subFontSize}:borderw=2:bordercolor=black@0.85:x=(w-text_w)/2:y=${subY}:enable='between(t,${s},${e})'`
      );
    }
  }

  afterBlur.push(
    `drawtext=${fontParam}text='KKH TOOL':fontcolor=white@0.4:fontsize=${tagFontSize}:x=${tagX}:y=${tagY}:enable='between(t,0,${dur})'`
  );
  afterBlur.push('format=yuv420p[vout]');

  graph.push(`${curLabel}${afterBlur.join(',')}`);
  return graph.join(';');
}

async function ensureGuaranteedAudioFile(voiceMp3, totalDurationSec, outputDir) {
  const dur = Math.max(2, Math.ceil(Number(totalDurationSec) || 10));
  const guaranteedWav = path.join(outputDir, `guaranteed_audio_${Date.now()}.wav`);
  const guaranteedWavFfmpeg = toFfmpegPath(guaranteedWav);

  if (hasValidAudioFile(voiceMp3, 400)) {
    const aDur = await getMediaDurationSec(voiceMp3);
    if (aDur > 0.2) {
      try {
        await runCmd(
          `ffmpeg -y -i "${toFfmpegPath(voiceMp3)}" -af "apad=whole_dur=${dur},loudnorm=I=-14:TP=-1.0:LRA=11" -t ${dur} -ar 44100 -ac 2 "${guaranteedWavFfmpeg}"`
        );
        if (hasValidAudioFile(guaranteedWav, 800)) return guaranteedWav;
      } catch {
        // Fallback
      }
    }
  }

  await runCmd(
    `ffmpeg -y -f lavfi -i "sine=frequency=220:sample_rate=44100:duration=${dur}" -f lavfi -i "sine=frequency=330:sample_rate=44100:duration=${dur}" -filter_complex "[0:a][1:a]amix=inputs=2:weights=0.6 0.25,lowpass=f=850,volume=0.35,afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, dur - 0.6)}:d=0.5[outa]" -map "[outa]" -ar 44100 -ac 2 "${guaranteedWavFfmpeg}"`
  );
  return guaranteedWav;
}

async function muxPlayableMp4WithBlurAndBottomSub(
  inputPath,
  voiceMp3,
  syncedSubEvents,
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

  try {
    const fcFull = buildBlurAndBottomSubFilter(
      syncedSubEvents,
      srtPath,
      width,
      height,
      dur,
      blurOriginalSub,
      blurArea,
      true
    );
    const cmdFull = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -filter_complex "${fcFull}" -map "[vout]" -map 1:a:0 -t ${dur} -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 192k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
    await runCmd(cmdFull);
    const check1 = await probeMediaStreams(outputPath);
    if (check1.hasVideoStream && check1.hasAudioStream && check1.sizeBytes > 1024) {
      fs.rmSync(audioSource, { force: true });
      return { subBurned: true, blurApplied: Boolean(blurOriginalSub), warnings };
    }
  } catch (err) {
    warnings.push(`Blur+SRT fallback: ${err.message.slice(-140)}`);
  }

  try {
    const fcNoSrt = buildBlurAndBottomSubFilter(
      [],
      '',
      width,
      height,
      dur,
      blurOriginalSub,
      blurArea,
      false
    );
    const cmdNoSrt = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -filter_complex "${fcNoSrt}" -map "[vout]" -map 1:a:0 -t ${dur} -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 192k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
    await runCmd(cmdNoSrt);
    const check2 = await probeMediaStreams(outputPath);
    if (check2.hasVideoStream && check2.hasAudioStream && check2.sizeBytes > 1024) {
      fs.rmSync(audioSource, { force: true });
      return { subBurned: false, blurApplied: Boolean(blurOriginalSub), warnings };
    }
  } catch (err) {
    warnings.push(`Blur+Tag fallback: ${err.message.slice(-140)}`);
  }

  const cmdSafe = `ffmpeg -y -i "${inFfmpeg}" -i "${audFfmpeg}" -map 0:v:0 -map 1:a:0 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p" -t ${dur} -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 192k -ar 44100 -ac 2 -movflags +faststart "${outFfmpeg}"`;
  await runCmd(cmdSafe);
  fs.rmSync(audioSource, { force: true });
  return { subBurned: false, blurApplied: false, warnings };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, studio: 'KKH AI STUDIO', status: 'READY', speechSpeed: DEFAULT_SPEECH_TEMPO }));
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/output/')) {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const fileParam = reqUrl.searchParams.get('file') || req.url.replace('/output/', '');
    const safeName = path.basename(decodeURIComponent(fileParam));
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

  if (req.method === 'POST' && req.url === '/upload-video') {
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
        res.end(JSON.stringify({ ok: false, error: 'Video size 1GB ထက် ကျော်နေပါသည်။' }));
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

  if (req.method === 'POST' && req.url === '/upload-voice') {
    const rawName = decodeURIComponent(req.headers['x-file-name'] || 'my_voice.wav');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = path.join(voicesDir, safeName);
    const writeStream = fs.createWriteStream(destPath);
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > 50 * 1024 * 1024) {
        aborted = true;
        writeStream.destroy();
        fs.rm(destPath, { force: true }, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Voice file 50MB ထက် ကျော်နေပါသည်။' }));
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

  if (req.method === 'POST' && req.url === '/dub-full-video') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const {
          videoFile = 'input.mp4',
          gender = 'male',
          manualText = '',
          customVoiceFile = '',
          blurOriginalSub = true,
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
          return res.end(JSON.stringify({ ok: false, error: 'Video size 1GB ထက် ကျော်နေပါသည်။' }));
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
            'ဆက်လက်ပြီး အဓိက အချက်အလက်တွေကို ကြည့်ရှုရမှာပါ။',
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
            `ffmpeg -y -i "${toFfmpegPath(customVoiceCandidate)}" -af "${tempoChain},highpass=f=80,lowpass=f=12000,loudnorm=I=-14:TP=-1.0:LRA=11" -ar 44100 -ac 2 "${toFfmpegPath(normalizedUserWav)}"`
          );
          const totalCeil = Math.max(3, Math.ceil(durationSec));
          if (customVoiceDur > 0.2 && customVoiceDur < totalCeil - 0.5) {
            const loopCount = Math.max(1, Math.ceil(totalCeil / Math.max(0.5, customVoiceDur)));
            await runCmd(
              `ffmpeg -y -stream_loop ${loopCount} -i "${toFfmpegPath(normalizedUserWav)}" -af "afade=t=in:st=0:d=0.15,loudnorm=I=-14:TP=-1.0:LRA=11" -t ${totalCeil} -c:a libmp3lame -q:a 2 "${toFfmpegPath(voiceMp3)}"`
            );
          } else {
            await runCmd(
              `ffmpeg -y -i "${toFfmpegPath(normalizedUserWav)}" -af "loudnorm=I=-14:TP=-1.0:LRA=11,apad=whole_dur=${totalCeil}" -t ${totalCeil} -c:a libmp3lame -q:a 2 "${toFfmpegPath(voiceMp3)}"`
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

        const { subBurned, blurApplied, warnings } = await muxPlayableMp4WithBlurAndBottomSub(
          inputPath,
          voiceMp3,
          syncedSubEvents,
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
  console.log(`[KKH AI STUDIO] Running on http://localhost:${PORT} (v27: Voice Speed Slider + Removed Unmute Button)`);
});
