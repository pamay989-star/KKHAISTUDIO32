import React, { useEffect, useMemo, useRef, useState } from "react";

const API = "";

type SubPosition = "bottom" | "top" | "both";
type VoiceId = "thiha" | "nilar";
type VoiceStyleMode = "pro_recap" | "conversational";
type OutputLang = "my" | "en";

const UI_TEXT = {
  my: {
    subtitle: "Pro Recap Voice AI • MY / EN • THIHA / NILAR",
    section1: "01 • Video & Subtitle",
    uploadingVideo: "ဖုန်းမှ Video တင်နေပါသည်...",
    changeVideoHint: "ပြောင်းရန် ထပ်နှိပ်ပါ",
    pickVideoTitle: "+ Video ဖိုင်ရွေးရန် နှိပ်ပါ",
    pickVideoSub: "စာတန်းမထိုးဘူး ပိတ်ထားရင် အမြန်ဆုံးထွက်မည်",
    subToggleLabel: "စာတန်းထိုးမည် / မထိုးဘူး",
    subOnBtn: "စာတန်းထိုးမယ် (ဖွင့်)",
    subOffBtn: "မထိုးဘူး (ပိတ်)",
    blurLabel: "မူလစာ ဝါးပေးမည်",
    blurBottom: "အောက်ခြေ",
    blurTop: "အပေါ်ပိုင်း",
    blurBoth: "နှစ်ဖက်",
    section2: "02 • Voice & Language",
    stylePro: "Pro Recap (ပရော်ဖက်ရှင်နယ်)",
    styleConv: "Conversational (သဘာဝကျကျ)",
    voiceMale: "THIHA (ကျား)",
    voiceFemale: "NILAR (မ)",
    langMy: "မြန်မာ (MY)",
    langEn: "English (EN)",
    pitchLabel: "Pitch (0 = ပုံမှန်)",
    speedLabel: "Speed",
    section3: "03 • Script စာသား",
    scriptPlaceholder:
      "Pro Recap စကားပြောပုံစံနဲ့ ပြန်မယ့် Script စာသားကို ဒီမှာ ထည့်ပါ...",
    generatingBtn: "⚡ ထုတ်နေပါသည်...",
    generateBtn: "⚡ Video နဲ့ အချိန်ကိုက်ထုတ်မည်",
    previewTitle: "Video ပြန်ကြည့်ရန်",
    replayBtn: "↻ အစမှ ပြန်ကြည့်မည်",
    downloadBtn: "⬇ Download MP4",
    scriptSyncTitle: "Script အချိန်ကိုက်ချက်",
    runnerOffline: "Runner မပွင့်သေးပါ။",
    runnerLost: "Runner ချိတ်ဆက်မှု ပြတ်သွားပါသည်။",
    needScript: "Script စာသားကို အရင်ထည့်ပေးပါ။",
    selectedMale: "ယောက်ျားလေးအသံ (THIHA) ရွေးထားပါသည်။ Pitch = 0",
    selectedFemale: "မိန်းကလေးအသံ (NILAR) ရွေးထားပါသည်။ Pitch = 0",
    switchedToEn: "English ဘာသာစကား ပြောင်းထားပါသည်။",
    switchedToMy: "မြန်မာ ဘာသာစကား ပြောင်းထားပါသည်။",
    videoReady: (mb: string) =>
      `Video Ready (${mb} MB)။ Script ထည့်ပြီး ထုတ်မည် ခလုတ်ကို နှိပ်ပါ။`,
    videoUploadFail: "Video တင်မရပါ။",
    generatingStatus: (voice: string, langLabel: string) =>
      `${voice} (${langLabel}) နဲ့ အချိန်ကိုက် ထုတ်နေပါသည်...`,
    doneStatus: "ပြီးပါပြီ။ Video ကို ပြန်ကြည့်ပြီး Download ဆွဲနိုင်ပါပြီ။",
    generateFail: "Video ထုတ်မရပါ။",
  },
  en: {
    subtitle: "Pro Recap Voice AI • MY / EN • THIHA / NILAR",
    section1: "01 • Video & Subtitle",
    uploadingVideo: "Uploading video...",
    changeVideoHint: "Tap again to change video",
    pickVideoTitle: "+ Tap to choose a video file",
    pickVideoSub: "Subtitle OFF gives fastest output",
    subToggleLabel: "Burn Subtitles ON / OFF",
    subOnBtn: "Subtitle ON (Burn)",
    subOffBtn: "Subtitle OFF (No Sub)",
    blurLabel: "Blur Original Text",
    blurBottom: "Bottom",
    blurTop: "Top",
    blurBoth: "Both",
    section2: "02 • Voice & Language",
    stylePro: "Pro Recap (Narrator)",
    styleConv: "Conversational (Natural)",
    voiceMale: "THIHA (Male)",
    voiceFemale: "NILAR (Female)",
    langMy: "Burmese (MY)",
    langEn: "English (EN)",
    pitchLabel: "Pitch (0 = Default)",
    speedLabel: "Speed",
    section3: "03 • Script Text",
    scriptPlaceholder:
      "Enter your recap or narration script here...",
    generatingBtn: "⚡ Generating...",
    generateBtn: "⚡ Generate Synced Video",
    previewTitle: "Video Preview",
    replayBtn: "↻ Replay from Start",
    downloadBtn: "⬇ Download MP4",
    scriptSyncTitle: "Synced Script Timeline",
    runnerOffline: "Runner is not running.",
    runnerLost: "Connection to runner was lost.",
    needScript: "Please enter a script first.",
    selectedMale: "Male voice (THIHA) selected. Pitch = 0",
    selectedFemale: "Female voice (NILAR) selected. Pitch = 0",
    switchedToEn: "Switched to English.",
    switchedToMy: "Switched to Burmese.",
    videoReady: (mb: string) =>
      `Video Ready (${mb} MB). Enter your script and tap Generate.`,
    videoUploadFail: "Failed to upload video.",
    generatingStatus: (voice: string, langLabel: string) =>
      `Generating synced output with ${voice} (${langLabel})...`,
    doneStatus: "Done! You can now preview and download your video.",
    generateFail: "Failed to generate video.",
  },
} as const;

async function parseJsonSafely(res: Response) {
  const raw = await res.text();
  if (!raw || !raw.trim()) {
    return { ok: false, error: `Empty response (HTTP ${res.status})` };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `Invalid JSON (HTTP ${res.status}): ${raw.slice(0, 120)}`,
    };
  }
}

async function fetchWithRouteFallback(
  paths: string[],
  init?: RequestInit
): Promise<{ res: Response; data: any; usedPath: string }> {
  let lastRes: Response | null = null;
  let lastData: any = null;
  let lastPath = paths[0] || "";

  for (const p of paths) {
    lastPath = p;
    const res = await fetch(`${API}${p}`, init);
    const data = await parseJsonSafely(res);
    lastRes = res;
    lastData = data;
    if (res.status !== 404) {
      return { res, data, usedPath: p };
    }
  }

  return {
    res: lastRes!,
    data: lastData,
    usedPath: lastPath,
  };
}

export default function App() {
  const [videoFile, setVideoFile] = useState<string>("");
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(false);
  const [blurEnabled, setBlurEnabled] = useState<boolean>(false);
  const [subPosition, setSubPosition] = useState<SubPosition>("bottom");

  const [selectedVoice, setSelectedVoice] = useState<VoiceId>("thiha");
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyleMode>("pro_recap");
  const [language, setLanguage] = useState<OutputLang>("my");

  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.0);
  const [pitchShift, setPitchShift] = useState<number>(0);
  const [scriptText, setScriptText] = useState<string>("");

  const [statusText, setStatusText] = useState<string>("");
  const [isError, setIsError] = useState<boolean>(false);
  const [runnerOnline, setRunnerOnline] = useState<boolean | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [outputUrl, setOutputUrl] = useState<string>("");
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [subtitleText, setSubtitleText] = useState<string>("");
  const [videoAudit, setVideoAudit] = useState<any>(null);

  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const t = useMemo(() => UI_TEXT[language], [language]);

  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const { res, data } = await fetchWithRouteFallback([
          "/health",
          "/api/health",
        ]);
        if (!active) return;
        if (res.ok && data?.ok) {
          setRunnerOnline(true);
        } else {
          setRunnerOnline(false);
          setIsError(true);
          setStatusText(
            `${UI_TEXT.my.runnerOffline} (${data?.error || `HTTP ${res.status}`})`
          );
        }
      } catch (err: any) {
        if (!active) return;
        setRunnerOnline(false);
        setIsError(true);
        setStatusText(
          `${UI_TEXT.my.runnerOffline} (${err?.message || "Failed to fetch"})`
        );
      }
    };
    checkHealth();
    return () => {
      active = false;
    };
  }, []);

  const handleSelectVoice = (voice: VoiceId) => {
    setSelectedVoice(voice);
    setIsError(false);
    setStatusText(voice === "thiha" ? t.selectedMale : t.selectedFemale);
  };

  const handleSelectLanguage = (lang: OutputLang) => {
    setLanguage(lang);
    setIsError(false);
    setStatusText(
      lang === "en" ? UI_TEXT.en.switchedToEn : UI_TEXT.my.switchedToMy
    );
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setIsError(false);
    setStatusText(t.uploadingVideo);

    try {
      const { res, data: d, usedPath } = await fetchWithRouteFallback(
        ["/upload-video", "/api/upload-video"],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
          },
          body: file,
        }
      );

      if (res.ok && d?.ok) {
        const sizeMb =
          typeof d.sizeMB === "number"
            ? d.sizeMB.toFixed(1)
            : (file.size / (1024 * 1024)).toFixed(1);
        setVideoFile(d.fileName || file.name);
        setRunnerOnline(true);
        setIsError(false);
        setStatusText(t.videoReady(sizeMb));
      } else {
        setIsError(true);
        setStatusText(
          `${d?.error || t.videoUploadFail} [${usedPath} -> HTTP ${res.status}]`
        );
      }
    } catch (err: any) {
      setRunnerOnline(false);
      setIsError(true);
      setStatusText(
        `${t.runnerOffline} (${err?.message || "Failed to fetch"})`
      );
    } finally {
      setIsUploading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleGenerate = async () => {
    if (!scriptText.trim()) {
      setIsError(true);
      setStatusText(t.needScript);
      return;
    }

    setIsGenerating(true);
    setIsError(false);
    setOutputUrl("");
    setDownloadUrl("");
    setSubtitleText("");
    setVideoAudit(null);
    setStatusText(
      t.generatingStatus(
        selectedVoice === "nilar" ? "NILAR" : "THIHA",
        language === "en" ? "English" : "မြန်မာ"
      )
    );

    try {
      const { res, data: d, usedPath } = await fetchWithRouteFallback(
        ["/dub-full-video", "/api/dub-full-video"],
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            videoFile: videoFile || "input.mp4",
            voiceProfile: selectedVoice,
            gender: selectedVoice === "nilar" ? "female" : "male",
            voiceStyle,
            language,
            manualText: scriptText.trim(),
            burnSubtitles,
            blurOriginalSub: blurEnabled,
            blurArea: subPosition,
            voiceSpeed,
            pitchShift,
          }),
        }
      );

      if (res.ok && d?.ok) {
        setRunnerOnline(true);
        setIsError(false);
        setStatusText(t.doneStatus);
        const rawUrl =
          d.streamUrl || d.outputUrl || d.videoUrl || d.audioUrl || "";
        if (rawUrl) {
          setOutputUrl(rawUrl.startsWith("http") ? rawUrl : `${API}${rawUrl}`);
        }
        const rawDl = d.downloadUrl || "";
        if (rawDl) {
          setDownloadUrl(rawDl.startsWith("http") ? rawDl : `${API}${rawDl}`);
        }
        if (d.burmeseText || d.subtitle || d.srt || d.text) {
          setSubtitleText(d.burmeseText || d.subtitle || d.srt || d.text);
        }
        if (d.audit) {
          setVideoAudit(d.audit);
        }
      } else {
        setIsError(true);
        setStatusText(
          `${d?.error || t.generateFail} [${usedPath} -> HTTP ${res.status}]`
        );
      }
    } catch (err: any) {
      setRunnerOnline(false);
      setIsError(true);
      setStatusText(
        `${t.runnerLost} (${err?.message || "Failed to fetch"})`
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReplayFromStart = () => {
    if (!previewVideoRef.current) return;
    previewVideoRef.current.currentTime = 0;
    previewVideoRef.current.play().catch(() => {});
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[radial-gradient(ellipse_at_top,_#34166e_0%,_#120826_52%,_#06020e_100%)] text-[#F7F3FF] px-3.5 py-5 flex justify-center selection:bg-fuchsia-500/30">
      <div className="pointer-events-none fixed -left-24 top-16 w-72 h-72 rounded-full bg-purple-600/25 blur-3xl" />
      <div className="pointer-events-none fixed -right-24 bottom-16 w-72 h-72 rounded-full bg-fuchsia-500/20 blur-3xl" />

      <div className="relative z-10 w-full max-w-[420px] space-y-3.5">
        <header className="rounded-3xl bg-[#1b0e36]/90 border border-purple-400/25 p-4 shadow-[0_14px_36px_-10px_rgba(147,51,234,0.45)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-fuchsia-500 via-purple-600 to-indigo-600 flex items-center justify-center text-white font-black text-base shadow-[0_0_18px_rgba(192,38,211,0.5)]">
                KH
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-extrabold tracking-tight text-white truncate">
                    KKH AI STUDIO
                  </h1>
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      runnerOnline === true
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                        : runnerOnline === false
                        ? "bg-rose-500/15 text-rose-300 border-rose-400/30"
                        : "bg-amber-500/15 text-amber-200 border-amber-400/30"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        runnerOnline === true
                          ? "bg-emerald-400"
                          : runnerOnline === false
                          ? "bg-rose-400"
                          : "bg-amber-300 animate-pulse"
                      }`}
                    />
                    {runnerOnline === true
                      ? "ONLINE"
                      : runnerOnline === false
                      ? "OFFLINE"
                      : "SYNC"}
                  </span>
                </div>
                <p className="text-[11px] text-purple-200/75 truncate">
                  {t.subtitle}
                </p>
              </div>
            </div>

            <div className="shrink-0 rounded-2xl bg-[#27154d] border border-purple-400/25 px-2.5 py-1.5 text-right">
              <div className="text-[10px] uppercase tracking-wider text-purple-300/70">
                Voice
              </div>
              <div className="text-xs font-extrabold text-fuchsia-300">
                {selectedVoice === "nilar" ? "NILAR" : "THIHA"}
              </div>
            </div>
          </div>
        </header>

        <section className="rounded-3xl bg-[#180d30]/90 border border-purple-400/20 p-3.5 space-y-2.5 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-200">
              {t.section1}
            </span>
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg bg-purple-500/20 text-purple-200 border border-purple-400/25">
              {burnSubtitles ? "SUB ON" : "SUB OFF"}
            </span>
          </div>

          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            onChange={handleFilePick}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            disabled={isUploading}
            className="w-full py-3.5 px-4 rounded-2xl bg-[#231344] hover:bg-[#2c1855] border border-dashed border-fuchsia-400/45 disabled:opacity-60 text-left transition cursor-pointer"
          >
            {isUploading ? (
              <div className="text-xs font-bold text-fuchsia-300 animate-pulse">
                {t.uploadingVideo}
              </div>
            ) : videoFile ? (
              <div className="space-y-0.5">
                <div className="text-xs font-extrabold text-emerald-300 truncate">
                  ✓ {videoFile}
                </div>
                <div className="text-[11px] text-purple-300/70">
                  {t.changeVideoHint}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">
                    {t.pickVideoTitle}
                  </div>
                  <div className="text-[11px] text-purple-300/65">
                    {t.pickVideoSub}
                  </div>
                </div>
                <span className="text-xs font-bold px-2.5 py-1 rounded-xl bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/30">
                  MP4
                </span>
              </div>
            )}
          </button>

          <div className="space-y-1.5 pt-1">
            <div className="text-xs font-semibold text-purple-100 px-1">
              {t.subToggleLabel}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setBurnSubtitles(true)}
                className={`py-2 px-2.5 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                  burnSubtitles
                    ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/60 text-white shadow"
                    : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
                }`}
              >
                {t.subOnBtn}
              </button>

              <button
                type="button"
                onClick={() => setBurnSubtitles(false)}
                className={`py-2 px-2.5 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                  !burnSubtitles
                    ? "bg-gradient-to-r from-amber-600 to-orange-600 border-amber-300/60 text-white shadow"
                    : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
                }`}
              >
                {t.subOffBtn}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1 px-1">
            <span className="text-xs font-semibold text-purple-100">
              {t.blurLabel}
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={blurEnabled}
              onClick={() => setBlurEnabled((prev) => !prev)}
              className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                blurEnabled
                  ? "bg-gradient-to-r from-fuchsia-500 to-purple-600"
                  : "bg-slate-700"
              }`}
            >
              <span
                className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  blurEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {blurEnabled && (
            <div className="grid grid-cols-3 gap-1.5 pt-1">
              {(
                [
                  ["bottom", t.blurBottom],
                  ["top", t.blurTop],
                  ["both", t.blurBoth],
                ] as const
              ).map(([pos, label]) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => setSubPosition(pos)}
                  className={`py-1.5 px-2 rounded-xl text-[11px] font-bold border transition cursor-pointer ${
                    subPosition === pos
                      ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/50 text-white"
                      : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl bg-[#180d30]/90 border border-purple-400/20 p-3.5 space-y-3 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-purple-200">
              {t.section2}
            </span>
            <span className="text-[11px] font-bold text-fuchsia-300">
              {selectedVoice === "nilar" ? t.voiceFemale : t.voiceMale} •{" "}
              {language === "en" ? "EN" : "MY"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setVoiceStyle("pro_recap")}
              className={`py-2 px-2.5 rounded-2xl text-[11px] font-bold border transition cursor-pointer ${
                voiceStyle === "pro_recap"
                  ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/50 text-white shadow"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.stylePro}
            </button>

            <button
              type="button"
              onClick={() => setVoiceStyle("conversational")}
              className={`py-2 px-2.5 rounded-2xl text-[11px] font-bold border transition cursor-pointer ${
                voiceStyle === "conversational"
                  ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/50 text-white shadow"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.styleConv}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSelectVoice("thiha")}
              className={`py-2.5 px-2 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                selectedVoice === "thiha"
                  ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/50 text-white shadow-[0_6px_18px_rgba(168,85,247,0.45)]"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.voiceMale}
            </button>

            <button
              type="button"
              onClick={() => handleSelectVoice("nilar")}
              className={`py-2.5 px-2 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                selectedVoice === "nilar"
                  ? "bg-gradient-to-r from-fuchsia-600 to-purple-600 border-fuchsia-300/50 text-white shadow-[0_6px_18px_rgba(168,85,247,0.45)]"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.voiceFemale}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => handleSelectLanguage("my")}
              className={`py-2.5 px-2 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                language === "my"
                  ? "bg-gradient-to-r from-emerald-600 to-teal-600 border-emerald-300/50 text-white shadow-[0_6px_18px_rgba(16,185,129,0.35)]"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.langMy}
            </button>

            <button
              type="button"
              onClick={() => handleSelectLanguage("en")}
              className={`py-2.5 px-2 rounded-2xl text-xs font-bold border transition cursor-pointer ${
                language === "en"
                  ? "bg-gradient-to-r from-emerald-600 to-teal-600 border-emerald-300/50 text-white shadow-[0_6px_18px_rgba(16,185,129,0.35)]"
                  : "bg-[#221242] border-purple-400/20 text-purple-200/75 hover:bg-[#2b1854]"
              }`}
            >
              {t.langEn}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <div className="rounded-2xl bg-[#211140] border border-purple-400/20 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-purple-200/80 font-semibold">
                  {t.pitchLabel}
                </span>
                <span className="text-fuchsia-300 font-bold">
                  {pitchShift > 0 ? `+${pitchShift}` : pitchShift}
                </span>
              </div>
              <input
                type="range"
                min={-12}
                max={12}
                step={1}
                value={pitchShift}
                onChange={(e) => setPitchShift(parseInt(e.target.value, 10))}
                className="w-full accent-fuchsia-400 cursor-pointer"
              />
            </div>

            <div className="rounded-2xl bg-[#211140] border border-purple-400/20 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-purple-200/80 font-semibold">
                  {t.speedLabel}
                </span>
                <span className="text-purple-200 font-bold">
                  {voiceSpeed.toFixed(2)}x
                </span>
              </div>
              <input
                type="range"
                min={0.8}
                max={1.25}
                step={0.01}
                value={voiceSpeed}
                onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
                className="w-full accent-purple-400 cursor-pointer"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-[#180d30]/90 border border-purple-400/20 p-3.5 space-y-2 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-purple-200">
              {t.section3}
            </label>
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg bg-purple-500/20 text-purple-200 border border-purple-400/25">
              {scriptText.length.toLocaleString()}
            </span>
          </div>

          <textarea
            rows={4}
            value={scriptText}
            onChange={(e) => setScriptText(e.target.value)}
            placeholder={t.scriptPlaceholder}
            className="w-full rounded-2xl bg-[#110824] border border-purple-400/25 p-3 text-xs leading-relaxed text-white placeholder:text-purple-300/35 focus:outline-none focus:border-fuchsia-400/70 transition"
          />
        </section>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating || isUploading}
          className="w-full py-3.5 px-5 rounded-2xl bg-gradient-to-r from-fuchsia-600 via-purple-600 to-indigo-600 hover:brightness-110 active:scale-[0.99] disabled:opacity-50 font-extrabold text-xs tracking-wide uppercase text-white shadow-[0_12px_30px_-6px_rgba(168,85,247,0.6)] transition-all cursor-pointer"
        >
          {isGenerating ? t.generatingBtn : t.generateBtn}
        </button>

        {statusText && (
          <div
            className={`rounded-2xl px-3.5 py-2.5 text-xs font-medium border ${
              isError
                ? "bg-rose-950/80 border-rose-500/45 text-rose-200"
                : "bg-emerald-950/70 border-emerald-400/40 text-emerald-200"
            }`}
          >
            {statusText}
          </div>
        )}

        {outputUrl && (
          <section className="rounded-3xl bg-[#180d30]/95 border border-purple-400/30 p-3.5 space-y-2.5 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-purple-200">
                {t.previewTitle}
              </span>
              <button
                type="button"
                onClick={handleReplayFromStart}
                className="text-[11px] font-bold px-2.5 py-1 rounded-xl bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/30 hover:bg-fuchsia-500/30 transition cursor-pointer"
              >
                {t.replayBtn}
              </button>
            </div>

            <video
              ref={previewVideoRef}
              controls
              playsInline
              src={outputUrl}
              className="w-full rounded-2xl border border-purple-400/20 bg-black"
            />

            {videoAudit && (
              <div className="grid grid-cols-2 gap-2 text-[11px] bg-[#110824] rounded-2xl p-2.5 border border-purple-400/15 text-purple-200/85">
                <div>
                  Voice:{" "}
                  <span className="font-bold text-fuchsia-300">
                    {videoAudit.voiceName || "THIHA"}
                  </span>
                </div>
                <div>
                  Sub:{" "}
                  <span className="font-bold text-emerald-300">
                    {videoAudit.subBurned ? "ON" : "OFF"}
                  </span>
                </div>
                <div>
                  Pitch:{" "}
                  <span className="font-bold text-white">
                    {videoAudit.pitchShift ?? 0}
                  </span>
                </div>
                <div>
                  Duration:{" "}
                  <span className="font-bold text-white">
                    {videoAudit.durationSec}s
                  </span>
                </div>
              </div>
            )}

            {downloadUrl && (
              <a
                href={downloadUrl}
                download
                className="block w-full text-center py-2.5 px-4 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:brightness-110 text-xs font-extrabold text-white shadow transition"
              >
                {t.downloadBtn}
              </a>
            )}
          </section>
        )}

        {subtitleText && (
          <section className="rounded-3xl bg-[#180d30]/95 border border-purple-400/25 p-3.5 space-y-2 shadow-lg">
            <div className="text-xs font-bold uppercase tracking-wider text-purple-200">
              {t.scriptSyncTitle}
            </div>
            <pre className="whitespace-pre-wrap text-xs leading-relaxed text-purple-100/90 font-sans bg-[#110824] rounded-2xl p-3 border border-purple-400/15">
              {subtitleText}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}