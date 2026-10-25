"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Info,
  Keyboard,
  Mic,
  MicOff,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";
import { SelectField } from "@/components/select-field";
import { CategoryIcon } from "@/components/category-chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ExpenseFormDialog, PAYMENT_OPTIONS } from "@/components/expense-form-dialog";
import { CATEGORY_META } from "@/lib/categories";
import { useDefaultWritableSiteId, useFormat, useSession, useWritableSites } from "@/lib/session";
import { writeActiveSiteCookie } from "@/lib/active-site";
import { useOnline, useSlowNotice, useSubmitGuard } from "@/lib/network";
import { removeDraft, saveDraft, updateDraft, useOfflineDrafts, withSyncLock, type OfflineDraft } from "@/lib/offline-drafts";
import { CATEGORIES, type Category, type PaymentMode } from "@/lib/types";
import { parseTranscript } from "@/lib/voice-parser";
import {
  EXAMPLE_TRANSCRIPT,
  SPEECH_LANG,
  blankDraft,
  draftsIssues,
  draftTotalPaise,
  hasErrors,
  toPaise,
  type DraftIssue,
  type VoiceDraft,
  type VoiceLanguage,
} from "@/lib/voice";
import {
  parseVoiceAction,
  recordVoiceConsentAction,
  reviewVoiceAction,
  saveVoiceAction,
  withdrawVoiceConsentAction,
} from "@/server/actions/voice";
import type { VoiceReview, VoiceSetup } from "@/server/data/voice";
import { cn } from "@/lib/utils";

type Phase = "idle" | "listening" | "reading" | "review" | "saved";
type VoiceError = "no-speech" | "blocked" | "network" | "no-mic" | "language" | "app";
type Support = "unknown" | "supported" | "unsupported" | "insecure";

// Minimal typing for the browser Speech API (not in lib.dom for all targets).
type SpeechResults = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { resultIndex: number; results: SpeechResults }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Phones handle `continuous` recognition badly (Chrome on Android repeats earlier words in later
 * results, Safari stops anyway), so there we listen phrase by phrase and restart after each pause.
 */
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** Opened from the home screen (installed app) rather than a browser tab. */
function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

const joinText = (a: string, b: string) => [a, b].filter(Boolean).join(" ");

/**
 * The whole text of one recognition session, final and interim. Rebuilt from every result each
 * time instead of appended from `resultIndex`, because Chrome on Android resends earlier results
 * ("20 bags", then "20 bags cement"): a result that repeats or extends the previous one replaces it.
 */
function resultsText(results: SpeechResults) {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const text = results[i][0]?.transcript.trim();
    if (!text) continue;
    const last = parts[parts.length - 1];
    if (last && text.startsWith(last)) parts[parts.length - 1] = text;
    else parts.push(text);
  }
  return parts.join(" ");
}

const noop = () => () => {};
function detectSupport(): Support {
  if (!window.isSecureContext) return "insecure";
  return recognitionCtor() ? "supported" : "unsupported";
}

const ERROR_COPY: Record<VoiceError, { title: string; body: string }> = {
  "no-speech": { title: "Didn't catch that", body: "No speech was heard. Hold the phone closer, away from mixer noise, and try again." },
  blocked: {
    title: "Microphone permission was denied",
    body: "Allow the microphone for this site in your browser's site settings, then try again. On iPhone, Dictation must also be on (Settings → General → Keyboard). Or type the entry instead.",
  },
  app: {
    title: "Voice isn't available in the installed app on this phone",
    body: "Open Arcadia in Chrome or Safari to use the mic. Or tap Type it and use the microphone key on your keyboard: it types what you say.",
  },
  "no-mic": { title: "No microphone found", body: "Connect a microphone or use your phone. You can type the entry instead." },
  network: {
    title: "Speech service unreachable",
    body: "Your browser needs a data connection to turn speech into text. Type the entry instead; it's read even offline.",
  },
  language: {
    title: "This browser can't recognise that language",
    body: "Switch the language to English, or type the entry instead.",
  },
};

const LANGUAGE_OPTIONS: { value: VoiceLanguage; label: string }[] = [
  { value: "ml", label: "Malayalam (mixed English is fine)" },
  { value: "en", label: "English (India)" },
];

const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label }));
const PAYMENT_LABEL = Object.fromEntries(PAYMENT_OPTIONS.map((o) => [o.value, o.label])) as Record<PaymentMode, string>;

/** Thrown server actions mean the request never completed (offline, server down). */
const offline = () =>
  toast.error("Can't reach the server. Your entries are kept on this screen. Try again when you're back online.");

export function VoiceView({ setup }: { setup: VoiceSetup }) {
  return (
    <>
      <PageHeader
        title="Voice entry"
        description="Pick the site, say what you paid for, check the entries, then confirm to save."
      />
      <VoiceGate setup={setup} />
    </>
  );
}

/** Viewers (or users with only completed sites) get an explanation instead of a recorder. */
function VoiceGate({ setup }: { setup: VoiceSetup }) {
  if (useWritableSites().length === 0) {
    return (
      <EmptyState
        icon={MicOff}
        title="You can't add expenses yet"
        description="Voice entry saves expenses to a site. Ask the site owner to invite you as an engineer on an active site."
      />
    );
  }
  return <VoiceBody setup={setup} />;
}

function VoiceBody({ setup }: { setup: VoiceSetup }) {
  const { settings, today, suppliers, workers, user, org } = useSession();
  const online = useOnline();
  const drafts = useOfflineDrafts(user.id, org.id);
  const guard = useSubmitGuard();
  /** When the current entries were first read; kept with an offline draft and sent on save. */
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const fmt = useFormat();
  const sites = useWritableSites();
  const support = useSyncExternalStore(noop, detectSupport, () => "unknown" as Support);

  const defaultSite = useDefaultWritableSiteId();
  const [siteId, setSiteIdState] = useState(defaultSite);
  // Choosing the site here also makes it the active site across the app.
  const setSiteId = (id: string) => {
    setSiteIdState(id);
    writeActiveSiteCookie(id);
  };
  const [language, setLanguage] = useState<VoiceLanguage>(settings.language === "ml" ? "ml" : "en");
  const [consentedAt, setConsentedAt] = useState(setup.consentedAt);
  const [consentOpen, setConsentOpen] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [spoken, setSpoken] = useState(false);
  const [extractor, setExtractor] = useState<"rules" | "claude" | "manual">("manual");
  const [notice, setNotice] = useState<string | null>(null);
  const [entries, setEntries] = useState<VoiceDraft[]>([]);
  const [readFrom, setReadFrom] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<VoiceReview | null>(null);
  const [acked, setAcked] = useState<Set<number>>(new Set());
  /** What the server stored. `waiting`: an assistant engineer's entries, sent for approval rather than counted. */
  const [saved, setSaved] = useState<{ count: number; total: string; replayed: boolean; waiting: boolean } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);

  const [reading, startReading] = useTransition();
  const [checking, startChecking] = useTransition();
  const [saving, startSaving] = useTransition();
  const [consenting, startConsent] = useTransition();

  const recRef = useRef<Recognition | null>(null);
  /** Everything heard in this recording so far, across phrases (phones restart recognition after each pause). */
  const heardRef = useRef("");
  /** The user tapped stop: don't restart after the current phrase. */
  const stoppedRef = useRef(false);
  /** The microphone was granted through getUserMedia on this page. */
  const primedRef = useRef(false);
  const hasEntriesRef = useRef(false);

  useEffect(() => {
    if (phase !== "listening") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => () => recRef.current?.abort(), []);
  useEffect(() => {
    hasEntriesRef.current = entries.length > 0;
  });

  const ctx = useMemo(() => ({ today, siteIds: sites.map((s) => s.id), workers, suppliers }), [today, sites, workers, suppliers]);
  const issues = useMemo(() => draftsIssues(entries, ctx), [entries, ctx]);
  const blocking = issues.filter(hasErrors).length;
  const total = draftTotalPaise(entries) / 100;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "Unknown site";

  // ---- Reading the transcript ----------------------------------------------

  function read(text: string, fromMic: boolean) {
    const clean = text.trim();
    if (!clean) return;
    // Keep what was heard on screen whatever happens next, so it can be fixed or typed over.
    setTranscript(clean);
    setSpoken(fromMic);
    setPhase("reading");
    setNotice(null);
    setServerErrors({});
    startReading(async () => {
      let drafts: VoiceDraft[] = [];
      let by: "rules" | "claude" = "rules";
      try {
        const res = await parseVoiceAction({ siteId, transcript: clean, language });
        if (!res.ok) {
          toast.error(res.error);
          setPhase("review");
          return;
        }
        drafts = res.data.entries;
        by = res.data.extractor;
        if (res.data.notice) setNotice(res.data.notice);
      } catch {
        // Offline: read it here with the same rules the server uses. Nothing is saved until the server confirms.
        drafts = parseTranscript(clean, { today, sites, defaultSiteId: siteId, workers, suppliers });
        setNotice("You're offline, so this was read on your phone with the basic reader. Saving needs a connection.");
      }
      setExtractor(by);
      setEntries(drafts);
      setReadFrom(clean);
      setDirty(false);
      setClientKey(crypto.randomUUID());
      setCapturedAt(new Date().toISOString());
      setPhase("review");
    });
  }

  // ---- Microphone -----------------------------------------------------------

  function requestMic() {
    setError(null);
    if (!consentedAt) {
      setConsentOpen(true);
      return;
    }
    void startMic();
  }

  async function startMic() {
    // Installed apps (and browsers that refused before) often never show the microphone prompt for
    // speech recognition, so ask for the microphone directly first. The stream is closed at once.
    if (!primedRef.current && (isStandalone() || error === "blocked") && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        primedRef.current = true;
      } catch (err) {
        const name = (err as DOMException).name;
        if (name === "NotAllowedError" || name === "SecurityError") return setError("blocked");
        if (name === "NotFoundError") return setError("no-mic");
      }
    }
    listen();
  }

  function agree() {
    startConsent(async () => {
      try {
        const res = await recordVoiceConsentAction();
        if (!res.ok) return void toast.error(res.error);
        setConsentedAt(res.data.consentedAt);
        setConsentOpen(false);
        void startMic();
      } catch {
        toast.error("Can't reach the server to record your choice. Type the entry for now.");
      }
    });
  }

  function withdraw() {
    startConsent(async () => {
      try {
        const res = await withdrawVoiceConsentAction();
        if (!res.ok) return void toast.error(res.error);
        setConsentedAt(null);
        toast.success("Voice consent withdrawn. You can still type entries.");
      } catch {
        offline();
      }
    });
  }

  const speechError = (code: string): VoiceError =>
    code === "not-allowed" || code === "service-not-allowed"
      ? // The microphone itself was granted, so it's the speech service refusing (iPhone home-screen apps).
        isStandalone() && primedRef.current
        ? "app"
        : "blocked"
      : code === "network"
        ? "network"
        : code === "audio-capture"
          ? "no-mic"
          : code === "language-not-supported"
            ? "language"
            : "no-speech";

  function listen() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    heardRef.current = "";
    stoppedRef.current = false;
    setInterim("");
    setSeconds(0);
    setPhase("listening");
    listenPhrase(Ctor);
  }

  /** Ends the recording and reads what was heard; `failure` is shown only when nothing was. */
  function finish(failure: VoiceError | null) {
    recRef.current = null;
    const heard = heardRef.current.trim();
    setInterim("");
    if (heard) return read(heard, true);
    setError(failure ?? "no-speech");
    setPhase(hasEntriesRef.current ? "review" : "idle");
  }

  function listenPhrase(Ctor: RecognitionCtor) {
    const rec = new Ctor();
    const before = heardRef.current;
    let phrase = "";
    let failure: string | null = null;
    rec.lang = SPEECH_LANG[language];
    rec.interimResults = true;
    rec.continuous = !isMobile();
    rec.onresult = (e) => {
      if (recRef.current !== rec) return;
      phrase = resultsText(e.results);
      // Interim words count too: Chrome on Android often ends without marking the last words final.
      heardRef.current = joinText(before, phrase);
      setInterim(heardRef.current);
    };
    rec.onerror = (e) => {
      failure = e.error;
    };
    rec.onend = () => {
      if (recRef.current !== rec || failure === "aborted") return;
      const fatal = failure && failure !== "no-speech" ? speechError(failure) : null;
      // Keep listening across pauses until the user taps stop; a phrase with nothing in it ends the recording.
      if (!stoppedRef.current && !fatal && phrase) return listenPhrase(Ctor);
      finish(fatal);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      finish("blocked");
    }
  }

  function stop() {
    const rec = recRef.current;
    if (!rec) return;
    stoppedRef.current = true;
    rec.stop();
    // Some phones never fire `end` after stop; don't leave the screen listening.
    setTimeout(() => {
      if (recRef.current !== rec) return;
      rec.abort();
      finish(null);
    }, 2000);
  }

  function typeInstead() {
    recRef.current?.abort();
    recRef.current = null;
    setError(null);
    setSpoken(false);
    setPhase("review");
  }

  function reset() {
    setPhase("idle");
    setError(null);
    setTranscript("");
    setInterim("");
    setEntries([]);
    setReadFrom(null);
    setDirty(false);
    setNotice(null);
    setSaved(null);
    setServerErrors({});
    setClientKey(crypto.randomUUID());
    setCapturedAt(null);
  }

  // ---- Editing --------------------------------------------------------------

  const update = (key: string, patch: Partial<VoiceDraft>) => {
    setDirty(true);
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  };
  const missingPayment = entries.filter((e) => !e.paymentMode).length;
  const setAllPayments = (mode: PaymentMode) => {
    setDirty(true);
    setEntries((list) => list.map((e) => (e.paymentMode ? e : { ...e, paymentMode: mode })));
  };

  // ---- Review and save --------------------------------------------------------

  const payload = () => ({
    transcript: transcript || undefined,
    language,
    extractor: readFrom ? extractor : ("manual" as const),
    spoken,
    entries,
  });

  /**
   * Keeps the reviewed entries on this device as an unsynced draft, with their save key
   * and capture time, then clears the screen. Nothing is claimed as saved.
   */
  function keepOffline(reason: string) {
    try {
      saveDraft({
        clientKey,
        userId: user.id,
        orgId: org.id,
        capturedAt: capturedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "unsynced",
        message: null,
        attempts: 0,
        siteName: siteName(entries[0]?.siteId ?? siteId),
        totalPaise: draftTotalPaise(entries),
        payload: { ...payload(), acknowledgedDuplicates: [...acked] },
      });
    } catch (err) {
      toast.error((err as Error).message);
      return;
    }
    setConfirm(null);
    reset();
    toast.warning("Not saved to the server", { description: `${reason} Kept on this device as an unsynced draft; it will be sent when you're back online.` });
  }

  function check() {
    if (!entries.length || blocking) return;
    if (!online) return keepOffline("You're offline.");
    void guard(
      () =>
        new Promise<void>((done) =>
          startChecking(async () => {
            try {
              const res = await reviewVoiceAction(payload());
              if (!res.ok) return void toast.error(res.error);
              setAcked(new Set());
              setConfirm(res.data);
            } catch {
              keepOffline("The server couldn't be reached to check the entries.");
            } finally {
              done();
            }
          }),
        ),
    );
  }

  function save() {
    if (!confirm) return;
    void guard(
      () =>
        new Promise<void>((done) =>
          startSaving(async () => {
            try {
              const res = await saveVoiceAction({ ...payload(), clientKey, acknowledgedDuplicates: [...acked], capturedAt: capturedAt ?? undefined });
              if (!res.ok) {
                setServerErrors(res.fieldErrors ?? {});
                setConfirm(null);
                if (res.fieldErrors?.clientKey) {
                  // These entries were saved earlier (e.g. from a draft) and have been edited since.
                  toast.error(res.error, {
                    duration: 15000,
                    action: { label: "Save as new", onClick: () => setClientKey(crypto.randomUUID()) },
                    description: "Choose “Save as new” and confirm again to save these as a separate entry. Possible duplicates will be flagged.",
                  });
                } else toast.error(res.error);
                return;
              }
              removeDraft(user.id, org.id, clientKey);
              setConfirm(null);
              const waiting = res.data.expenses.some((e) => e.status !== "approved");
              const n = res.data.expenses.length;
              setSaved({ count: n, total: res.data.total, replayed: res.data.replayed, waiting });
              setPhase("saved");
              toast.success(
                res.data.replayed
                  ? "These entries were already saved. Nothing was added twice."
                  : `${n} ${n === 1 ? "expense" : "expenses"} ${waiting ? "sent for approval" : "saved"}`,
              );
            } catch {
              // It may or may not have reached the server. Keeping it is safe: syncing reuses the same key, so it can't save twice.
              keepOffline("The connection dropped, so we can't tell if it saved.");
            } finally {
              done();
            }
          }),
        ),
    );
  }

  // ---- Unsynced drafts ----------------------------------------------------------

  const [syncing, setSyncing] = useState(false);
  const syncAll = useCallback(async () => {
    const pending = drafts.filter((d) => d.status === "unsynced");
    if (!pending.length || !navigator.onLine) return;
    setSyncing(true);
    try {
      await withSyncLock(async () => {
        for (const d of pending) {
          try {
            const res = await saveVoiceAction({ ...d.payload, clientKey: d.clientKey, capturedAt: d.capturedAt });
            if (res.ok) {
              removeDraft(user.id, org.id, d.clientKey);
              const waiting = res.data.expenses.some((e) => e.status !== "approved");
              toast.success(`Synced ${res.data.expenses.length} ${res.data.expenses.length === 1 ? "expense" : "expenses"}${waiting ? ", sent for approval" : ""}`, {
                description: `Captured ${new Date(d.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}${res.data.replayed ? "; it had already reached the server, so nothing was added twice" : ""}.`,
              });
            } else {
              updateDraft(user.id, org.id, d.clientKey, { status: res.fieldErrors?.clientKey ? "conflict" : "needs_review", message: res.error, attempts: d.attempts + 1 });
            }
          } catch {
            // Still unreachable: leave it unsynced and stop for now.
            updateDraft(user.id, org.id, d.clientKey, { attempts: d.attempts + 1 });
            break;
          }
        }
      });
    } finally {
      setSyncing(false);
    }
  }, [drafts, user.id, org.id]);

  // Send unsynced drafts when the page opens online, and whenever the connection returns.
  const unsyncedCount = drafts.filter((d) => d.status === "unsynced").length;
  const syncRef = useRef(syncAll);
  useEffect(() => {
    syncRef.current = syncAll;
  });
  useEffect(() => {
    if (online && unsyncedCount > 0) void syncRef.current();
  }, [online, unsyncedCount]);

  /** Loads a draft back into the review screen, keeping its save key and capture time. */
  function openDraft(d: OfflineDraft) {
    setEntries(d.payload.entries);
    setTranscript(d.payload.transcript ?? "");
    setReadFrom(d.payload.transcript ?? "");
    setSpoken(d.payload.spoken);
    setExtractor(d.payload.extractor);
    setLanguage(d.payload.language);
    setAcked(new Set(d.payload.acknowledgedDuplicates));
    setClientKey(d.clientKey);
    setCapturedAt(d.capturedAt);
    setDirty(false);
    setNotice(d.message);
    setPhase("review");
  }

  useSlowNotice(saving || checking, "Still saving. The connection is slow; keep this screen open.");
  useSlowNotice(reading, "Still reading. The connection is slow.");

  const listening = phase === "listening";
  const busy = listening || reading || phase === "reading";
  const siteOptions = sites.map((s) => ({ value: s.id, label: s.name }));
  const canListen = support === "supported";

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,400px)_1fr] lg:items-start">
      {/* Recorder */}
      <section aria-label="Recorder" className="surface rounded-xl p-5 lg:sticky lg:top-8">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="voice-site" className="text-sm font-medium">Logging for</Label>
            <SelectField id="voice-site" value={siteId} onChange={setSiteId} options={siteOptions} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="voice-lang" className="text-sm font-medium">Speaking in</Label>
            <SelectField id="voice-lang" value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS} />
          </div>
        </div>

        <div className="flex flex-col items-center py-8">
          <div className="relative grid size-40 place-items-center">
            {listening && (
              <>
                <span className="animate-ring absolute inset-0 rounded-full bg-brand/50" aria-hidden />
                <span className="animate-ring absolute inset-0 rounded-full bg-brand/40 [animation-delay:0.8s]" aria-hidden />
              </>
            )}
            <button
              type="button"
              onClick={listening ? stop : requestMic}
              disabled={!canListen || (busy && !listening) || !siteId}
              aria-label={listening ? "Stop recording" : "Start recording"}
              aria-describedby="voice-status"
              className={cn(
                "relative grid size-32 place-items-center rounded-full transition-transform focus-visible:outline-4 focus-visible:outline-offset-4 active:scale-95 disabled:opacity-50",
                listening ? "bg-emerald-950 text-white dark:bg-white dark:text-emerald-950" : "brand-fill shadow-[0_18px_36px_-14px_rgb(4_120_87/0.85)]",
              )}
            >
              {listening ? <Square className="size-10 fill-current" aria-hidden /> : <Mic className="size-12" aria-hidden />}
            </button>
          </div>

          <div className="mt-5 h-10" aria-hidden>
            {listening ? (
              <div className="flex h-10 items-center gap-1">
                {Array.from({ length: 18 }).map((_, i) => (
                  <span
                    key={i}
                    className="animate-wave h-full w-1.5 rounded-full bg-primary/80"
                    style={{ animationDelay: `${(i * 137) % 900}ms`, animationDuration: `${700 + ((i * 89) % 500)}ms` }}
                  />
                ))}
              </div>
            ) : phase === "reading" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="size-4 animate-pulse" /> Reading the amounts…
              </div>
            ) : null}
          </div>

          <p id="voice-status" className="mt-1 text-center text-sm font-medium" role="status" aria-live="polite">
            {listening
              ? `Listening… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Tap to stop.`
              : phase === "reading"
                ? "Finding expenses in what you said"
                : phase === "review"
                  ? "Check the entries before saving"
                  : phase === "saved"
                    ? "Saved"
                    : canListen
                      ? "Tap the mic and speak"
                      : support === "unknown"
                        ? ""
                        : "Voice isn't available here. Type instead."}
          </p>
        </div>

        {support === "unsupported" && (
          <Notice icon={MicOff} title="This browser can't turn speech into text">
            Use Chrome or Edge on Android or a computer, or Safari on iPhone. You can type the same sentence instead.
          </Notice>
        )}
        {support === "insecure" && (
          <Notice icon={MicOff} title="Microphone needs a secure connection">
            Open the app over https to use voice. You can type the entry instead.
          </Notice>
        )}

        <div className="rounded-xl bg-secondary/70 px-3.5 py-3 text-sm">
          <p className="font-medium">Try saying</p>
          <p className="mt-1 text-muted-foreground">“{EXAMPLE_TRANSCRIPT}”</p>
          <p className="mt-1 text-muted-foreground">“ഇന്നലെ 20 ചാക്ക് സിമന്റ് 8000 രൂപ, എല്ലാം ക്യാഷ്”</p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant={canListen ? "outline" : "default"} className="h-11" onClick={typeInstead} disabled={busy}>
            <Keyboard aria-hidden /> Type it
          </Button>
          <Button variant="outline" className="h-11" onClick={() => setManualOpen(true)} disabled={listening}>
            <Plus aria-hidden /> Use form
          </Button>
        </div>

        <p className="mt-4 flex gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-px size-4 shrink-0" aria-hidden />
          <span>
            Your browser&apos;s speech service turns audio into text; Arcadia never receives or keeps audio.{" "}
            {consentedAt ? (
              <>
                You agreed on {fmt.date(consentedAt.slice(0, 10))}.{" "}
                <button type="button" className="underline underline-offset-2" onClick={withdraw} disabled={consenting}>
                  Withdraw
                </button>
              </>
            ) : (
              <button type="button" className="underline underline-offset-2" onClick={() => setConsentOpen(true)}>
                How voice works
              </button>
            )}
          </span>
        </p>
      </section>

      {/* Transcript and extracted entries */}
      <section aria-label="Entries" className="min-w-0 space-y-4">
        {drafts.length > 0 && (
          <UnsyncedDrafts
            drafts={drafts}
            online={online}
            syncing={syncing}
            onSync={() => void syncAll()}
            onOpen={openDraft}
            onDiscard={(d) => removeDraft(user.id, org.id, d.clientKey)}
            openKey={phase === "review" ? clientKey : null}
          />
        )}
        {error && (
          <div role="alert" className="flex gap-3 surface rounded-xl border-over/40 p-4">
            {error === "blocked" || error === "no-mic" ? (
              <MicOff className="mt-0.5 size-5 shrink-0 text-over" />
            ) : error === "network" ? (
              <WifiOff className="mt-0.5 size-5 shrink-0 text-over" />
            ) : (
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-over" />
            )}
            <div className="flex-1">
              <p className="font-semibold">{ERROR_COPY[error].title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{ERROR_COPY[error].body}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="h-10" onClick={requestMic}><RotateCcw aria-hidden /> Try again</Button>
                <Button variant="outline" className="h-10" onClick={typeInstead}><Keyboard aria-hidden /> Type it</Button>
              </div>
            </div>
          </div>
        )}

        {phase === "idle" && !error && (
          <div className="rounded-xl border border-dashed border-primary/25 bg-[var(--card)] p-6 text-sm text-muted-foreground lg:p-10">
            <p className="font-medium text-foreground">How it works</p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5">
              <li>Pick the site, tap the mic and describe one or more payments, in Malayalam, English or both.</li>
              <li>Check the transcript. Each payment becomes a separate entry with its amount, quantity and who was paid.</li>
              <li>Anything that wasn&apos;t said, like the payment mode, is left for you to fill in. Nothing is guessed.</li>
              <li>Confirm the list and total, and the entries are saved together.</li>
            </ol>
          </div>
        )}

        {(listening || phase === "reading") && (
          <div className="surface rounded-xl p-5">
            <p className="text-sm font-medium text-muted-foreground">Transcript</p>
            <p className="mt-2 min-h-16 text-lg leading-relaxed">
              {interim || transcript || <span className="text-muted-foreground">Waiting for speech…</span>}
              {listening && <span className="ml-0.5 inline-block h-5 w-0.5 translate-y-1 animate-pulse bg-foreground" aria-hidden />}
            </p>
          </div>
        )}

        {phase === "review" && (
          <>
            <div className="surface rounded-xl p-4 sm:p-5">
              <Label htmlFor="transcript" className="text-sm font-medium">
                {spoken ? "What we heard. Fix any words, then read again." : "Type what you paid for"}
              </Label>
              <Textarea
                id="transcript"
                value={transcript}
                autoFocus={!transcript}
                maxLength={4000}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder={`e.g. ${EXAMPLE_TRANSCRIPT}`}
                className="mt-2 min-h-24 text-base"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {!transcript ? (
                  <button type="button" className="text-sm text-muted-foreground underline underline-offset-4" onClick={() => setTranscript(EXAMPLE_TRANSCRIPT)}>
                    Use the example sentence
                  </button>
                ) : (
                  <span />
                )}
                <Button
                  variant="outline"
                  className="h-10"
                  onClick={() => (dirty && entries.length ? setReplaceOpen(true) : read(transcript, spoken))}
                  disabled={!transcript.trim() || reading || transcript.trim() === readFrom}
                >
                  <Sparkles aria-hidden /> {readFrom ? "Read again" : "Find expenses"}
                </Button>
              </div>
            </div>

            {notice && (
              <Notice icon={Info} title="Check carefully">
                {notice}
              </Notice>
            )}

            {missingPayment > 0 && (
              <div className="surface flex flex-col gap-2 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm">
                  <span className="font-medium">Payment mode wasn&apos;t said</span>{" "}
                  <span className="text-muted-foreground">
                    for {missingPayment} {missingPayment === 1 ? "entry" : "entries"}. Set them all to:
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {PAYMENT_OPTIONS.filter((o) => o.value !== "cheque").map((o) => (
                    <Button key={o.value} variant="outline" size="sm" className="h-9" onClick={() => setAllPayments(o.value)}>
                      {o.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {entries.length > 0 ? (
              <ul className="space-y-3">
                {entries.map((e, i) => (
                  <li key={e.key}>
                    <EntryEditor
                      index={i}
                      entry={e}
                      issues={issues[i]}
                      serverError={serverErrors[`entries.${i}.duplicate`]}
                      siteOptions={siteOptions}
                      onChange={(patch) => update(e.key, patch)}
                      onRemove={() => {
                        setDirty(true);
                        setEntries((l) => l.filter((x) => x.key !== e.key));
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : readFrom ? (
              <div className="rounded-xl border border-dashed border-primary/25 bg-[var(--card)] p-5 text-sm text-muted-foreground">
                No payments found in that. Mention what it was for and a number for each one, like “diesel 1,900”, or add a line yourself.
              </div>
            ) : null}

            <div className="flex flex-col gap-3 surface rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div>
                <p className="text-sm text-muted-foreground">
                  {entries.length} {entries.length === 1 ? "entry" : "entries"}
                  {blocking > 0 && <span className="text-warn">, {blocking} need your answer</span>}
                </p>
                <p className="num font-display text-2xl font-bold">{fmt.money(total)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() => {
                    setDirty(true);
                    setEntries((l) => [...l, blankDraft(siteId, today)]);
                  }}
                >
                  <Plus aria-hidden /> Add line
                </Button>
                <Button variant="ghost" className="h-11" onClick={reset}>Discard</Button>
                <Button className="h-11 px-5" onClick={check} disabled={checking || saving || !entries.length || blocking > 0}>
                  {checking ? "Checking…" : online ? "Review and save" : "Keep on this device"}
                </Button>
              </div>
            </div>
          </>
        )}

        {phase === "saved" && saved && (
          <div className="surface rounded-xl p-6 text-center lg:p-10">
            <CheckCircle2 className="mx-auto size-12 text-good" aria-hidden />
            <p className="font-display mt-3 text-2xl font-bold">
              {saved.count} {saved.count === 1 ? "expense" : "expenses"} {saved.waiting ? "sent for approval" : "saved"}
            </p>
            <p className="num mt-1 text-muted-foreground">
              {saved.waiting
                ? `${fmt.money(Number(saved.total))} saved on the server, waiting for a site owner's approval`
                : `${fmt.money(Number(saved.total))} added to site history`}
              {saved.replayed && " (already saved earlier)"}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button className="h-11 px-5" onClick={reset}>
                <Mic aria-hidden /> Log another
              </Button>
              {saved.waiting ? (
                <Link href="/my" className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5")}>
                  My entries
                </Link>
              ) : (
                <Link href={`/sites/${siteId}`} className={cn(buttonVariants({ variant: "outline" }), "h-11 px-5")}>
                  View site
                </Link>
              )}
            </div>
          </div>
        )}
      </section>

      {listening && (
        // On phones the mic scrolls away under the transcript: keep a large Stop within thumb reach.
        // It also shows the words as they're heard, since the transcript card is below the fold.
        <div className="no-print fixed inset-x-3 bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+5.5rem)] z-40 grid gap-2 rounded-2xl surface-raised p-3 lg:hidden">
          <p className="max-h-20 overflow-hidden text-base leading-snug">
            {interim ? (interim.length > 160 ? `…${interim.slice(-160)}` : interim) : <span className="text-muted-foreground">Speak now…</span>}
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="num text-sm font-medium" aria-hidden>
              Listening {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
            <Button className="h-14 min-w-36 rounded-xl text-base" onClick={stop}>
              <Square className="size-5 fill-current" aria-hidden /> Stop
            </Button>
          </div>
        </div>
      )}
      <ConsentDialog open={consentOpen} onOpenChange={setConsentOpen} ai={setup.aiAvailable} busy={consenting} agreed={!!consentedAt} onAgree={agree} />

      <ConfirmDialog
        open={replaceOpen}
        onOpenChange={setReplaceOpen}
        title="Replace your edits?"
        description="Reading the transcript again replaces the entries below, including your changes."
        confirmLabel="Read again"
        onConfirm={() => read(transcript, spoken)}
      />

      <Dialog open={!!confirm} onOpenChange={(o) => !o && !saving && setConfirm(null)}>
        {confirm && (
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-lg font-semibold">
                Save {entries.length} {entries.length === 1 ? "expense" : "expenses"}?
              </DialogTitle>
              <DialogDescription>Check the list. Nothing is saved until you confirm.</DialogDescription>
            </DialogHeader>
            <ul className="divide-y rounded-lg border text-sm">
              {entries.map((e, i) => {
                const dup = confirm.duplicates.find((d) => d.index === i);
                const warnings = confirm.issues[i]?.filter((x) => x.level === "warning") ?? [];
                return (
                  <li key={e.key} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {e.description}
                          {e.worker && ` · ${e.worker}`}
                          {e.labourKind === "advance" && " · Advance"}
                          {e.supplier && ` · ${e.supplier}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[siteName(e.siteId), fmt.date(e.date), e.quantity && `${e.quantity} ${e.unit ?? ""}`, e.paymentMode && PAYMENT_LABEL[e.paymentMode]]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <p className="num shrink-0 font-semibold">{fmt.money(Number(e.amount))}</p>
                    </div>
                    {warnings.map((w) => (
                      <p key={w.message} className="mt-1 text-xs text-muted-foreground">{w.message}</p>
                    ))}
                    {dup && (
                      <label className="mt-2 flex items-start gap-2 rounded-md bg-warn/10 p-2 text-xs">
                        <Checkbox
                          checked={acked.has(i)}
                          onCheckedChange={(c) =>
                            setAcked((s) => {
                              const next = new Set(s);
                              if (c) next.add(i);
                              else next.delete(i);
                              return next;
                            })
                          }
                          className="mt-0.5"
                        />
                        <span>
                          <span className="flex items-center gap-1 font-medium text-warn">
                            <Copy className="size-3.5" aria-hidden /> Possible duplicate
                          </span>
                          {dup.kind === "batch"
                            ? `Same as entry ${dup.otherIndex! + 1} in this list.`
                            : `${dup.enteredBy} already saved “${dup.description}” for ${fmt.money(Number(dup.amount))} on ${fmt.date(dup.date!)}.`}{" "}
                          Tick to save it anyway as a separate payment.
                        </span>
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="num font-display text-2xl font-bold">{fmt.money(Number(confirm.total))}</span>
            </div>
            <DialogFooter>
              <Button variant="outline" className="h-11" onClick={() => setConfirm(null)} disabled={saving}>
                Back to editing
              </Button>
              <Button
                className="h-11 px-5"
                onClick={save}
                disabled={saving || !confirm.ready || confirm.duplicates.some((d) => !acked.has(d.index))}
              >
                {saving ? "Saving…" : "Confirm and save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <ExpenseFormDialog open={manualOpen} onOpenChange={setManualOpen} defaultSiteId={siteId} />
    </div>
  );
}

function Notice({ icon: Icon, title, children }: { icon: typeof Info; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex gap-3 rounded-xl border border-warn/40 bg-warn/5 p-3.5 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function ConsentDialog({
  open,
  onOpenChange,
  ai,
  busy,
  agreed,
  onAgree,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ai: boolean;
  busy: boolean;
  agreed: boolean;
  onAgree: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">Before you use your voice</DialogTitle>
          <DialogDescription>How your speech is handled:</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>
            Your browser&apos;s speech service turns what you say into text. In Chrome and Edge, audio is sent to Google or
            Microsoft for this; Safari may use Apple&apos;s servers. Their privacy terms apply.
          </li>
          <li>Arcadia never receives or keeps the audio, only the text.</li>
          <li>
            The text is sent to Arcadia to find the expenses
            {ai && ", and to Anthropic's Claude AI, which reads it for us under Anthropic's API terms"}.
          </li>
          <li>The text is saved with the expenses you confirm, so the site owner can check them.</li>
          <li>The mic only listens while the button shows a square. You can withdraw this consent any time.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={() => onOpenChange(false)}>
            {agreed ? "Close" : "Not now"}
          </Button>
          {!agreed && (
            <Button className="h-11 px-5" onClick={onAgree} disabled={busy}>
              {busy ? "Saving…" : "I agree, start"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntryEditor({
  index,
  entry,
  issues,
  serverError,
  siteOptions,
  onChange,
  onRemove,
}: {
  index: number;
  entry: VoiceDraft;
  issues: DraftIssue[];
  serverError?: string;
  siteOptions: { value: string; label: string }[];
  onChange: (patch: Partial<VoiceDraft>) => void;
  onRemove: () => void;
}) {
  const { today, workers, suppliers } = useSession();
  const fmt = useFormat();
  const id = (f: string) => `${entry.key}-${f}`;
  const errorOn = (field: DraftIssue["field"]) => issues.some((i) => i.field === field && i.level === "error");
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const labour = entry.category === "labour";

  return (
    <article aria-label={`Entry ${index + 1}`} className={cn("surface rounded-xl p-4", errors.length > 0 && "border-warn/60")}>
      <div className="flex items-start gap-3">
        {entry.category ? <CategoryIcon category={entry.category} /> : <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary text-sm font-semibold">?</span>}
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[1fr_140px]">
          <div className="grid gap-1">
            <Label htmlFor={id("desc")} className="text-xs text-muted-foreground">Description</Label>
            <Input id={id("desc")} className="h-11" aria-invalid={errorOn("description")} value={entry.description} maxLength={200} onChange={(e) => onChange({ description: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("amt")} className="text-xs text-muted-foreground">Amount (₹)</Label>
            <Input
              id={id("amt")}
              inputMode="decimal"
              aria-invalid={errorOn("amount")}
              className="num h-11 text-base font-semibold"
              value={entry.amount ?? ""}
              placeholder="Not said"
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                onChange({ amount: v || null, amountChoices: v ? [] : entry.amountChoices });
              }}
            />
          </div>
        </div>
        <Button variant="ghost" size="icon" className="size-10 shrink-0 text-muted-foreground" aria-label={`Remove entry ${index + 1}`} onClick={onRemove}>
          <Trash2 aria-hidden />
        </Button>
      </div>

      <div className="sm:pl-[52px]">
        {!entry.amount && entry.amountChoices.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Which number is the amount?">
            <span className="text-xs text-muted-foreground">Which is the amount?</span>
            {entry.amountChoices.map((c) => (
              <Button key={c} variant="outline" size="sm" className="num h-9" onClick={() => onChange({ amount: c, amountChoices: [] })}>
                {fmt.money(toPaise(c)! / 100)}
              </Button>
            ))}
          </div>
        )}
        {!entry.category && (
          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Category">
            <span className="text-xs text-muted-foreground">What was it for?</span>
            {CATEGORY_OPTIONS.map((c) => (
              <Button key={c.value} variant="outline" size="sm" className="h-9" onClick={() => onChange({ category: c.value })}>
                {c.label}
              </Button>
            ))}
          </div>
        )}
        {entry.siteHeard && !entry.siteConfirmed && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 p-2.5 text-sm">
            <span>
              You said “{entry.siteHeard}”. Saving to <strong>{siteOptions.find((o) => o.value === entry.siteId)?.label}</strong>?
            </span>
            <Button size="sm" className="h-9" onClick={() => onChange({ siteConfirmed: true })}>Yes, that site</Button>
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor={id("cat")} className="text-xs text-muted-foreground">Category</Label>
            <SelectField id={id("cat")} value={entry.category} placeholder="Not said" onChange={(v: Category) => onChange({ category: v })} options={CATEGORY_OPTIONS} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("site")} className="text-xs text-muted-foreground">Site</Label>
            <SelectField id={id("site")} value={entry.siteId} onChange={(v) => onChange({ siteId: v, siteConfirmed: true })} options={siteOptions} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("pay")} className="text-xs text-muted-foreground">Paid by</Label>
            <SelectField
              id={id("pay")}
              value={entry.paymentMode}
              placeholder="Not said"
              onChange={(v) => onChange({ paymentMode: v })}
              options={PAYMENT_OPTIONS}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("date")} className="text-xs text-muted-foreground">Date{!entry.dateSaid && " (not said, today)"}</Label>
            <Input id={id("date")} type="date" className="h-11" max={today} aria-invalid={errorOn("date")} value={entry.date} onChange={(e) => e.target.value && onChange({ date: e.target.value, dateSaid: true })} />
          </div>
          <div className="grid grid-cols-[1fr_1fr] gap-2">
            <div className="grid gap-1">
              <Label htmlFor={id("qty")} className="text-xs text-muted-foreground">Quantity</Label>
              <Input id={id("qty")} inputMode="decimal" className="h-11" aria-invalid={errorOn("quantity")} value={entry.quantity ?? ""} onChange={(e) => onChange({ quantity: e.target.value.replace(/[^\d.]/g, "") || null })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={id("unit")} className="text-xs text-muted-foreground">Unit</Label>
              <Input id={id("unit")} className="h-11" maxLength={20} placeholder="bags" value={entry.unit ?? ""} onChange={(e) => onChange({ unit: e.target.value || null })} />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={id("who")} className="text-xs text-muted-foreground">{labour ? "Worker" : "Supplier"}</Label>
            <Input
              id={id("who")}
              className="h-11"
              maxLength={120}
              list={labour ? "voice-workers" : "voice-suppliers"}
              placeholder="Not said"
              value={(labour ? entry.worker : entry.supplier) ?? ""}
              onChange={(e) => onChange(labour ? { worker: e.target.value || null } : { supplier: e.target.value || null })}
            />
            <datalist id="voice-workers">{workers.map((w) => <option key={w} value={w} />)}</datalist>
            <datalist id="voice-suppliers">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          {labour && entry.worker && (
            <div className="grid gap-1">
              <Label htmlFor={id("kind")} className="text-xs text-muted-foreground">Payment is</Label>
              <SelectField
                id={id("kind")}
                value={entry.labourKind ?? "wage"}
                onChange={(v) => onChange({ labourKind: v })}
                options={[
                  { value: "wage" as const, label: "Wages for work done" },
                  { value: "advance" as const, label: "Advance" },
                ]}
              />
            </div>
          )}
        </div>

        {entry.heard && <p className="mt-3 text-xs text-muted-foreground">Heard: “{entry.heard}”</p>}
        {(errors.length > 0 || warnings.length > 0 || serverError) && (
          <ul className="mt-2 space-y-0.5 text-xs">
            {errors.map((i) => (
              <li key={i.message} className="font-medium text-warn">{i.message}</li>
            ))}
            {serverError && <li className="font-medium text-warn">{serverError} Remove it if it was already entered.</li>}
            {warnings.map((i) => (
              <li key={i.message} className="text-muted-foreground">{i.message}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

const DRAFT_STATUS: Record<OfflineDraft["status"], { label: string; tone: string }> = {
  unsynced: { label: "Unsynced, on this device only", tone: "border-warn/50 bg-warn/10 text-warn" },
  needs_review: { label: "Not saved: needs your review", tone: "border-over/40 bg-over/10 text-over" },
  conflict: { label: "Not saved: conflicts with a saved entry", tone: "border-over/40 bg-over/10 text-over" },
};

/** Entries kept on this device. Never shown as saved; removed only after the server confirms, or by the user. */
function UnsyncedDrafts({
  drafts,
  online,
  syncing,
  onSync,
  onOpen,
  onDiscard,
  openKey,
}: {
  drafts: OfflineDraft[];
  online: boolean;
  syncing: boolean;
  onSync: () => void;
  onOpen: (d: OfflineDraft) => void;
  onDiscard: (d: OfflineDraft) => void;
  openKey: string | null;
}) {
  const fmt = useFormat();
  const [discarding, setDiscarding] = useState<OfflineDraft | null>(null);
  const unsynced = drafts.filter((d) => d.status === "unsynced").length;
  return (
    <section aria-labelledby="drafts-title" className="surface rounded-xl border-warn/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="drafts-title" className="font-semibold">Unsynced drafts on this device ({drafts.length})</h2>
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {syncing ? "Sending to the server…" : !online ? "You're offline. They'll be sent when you reconnect." : unsynced ? "They'll be sent automatically." : "Open each one to review it."}
          </p>
        </div>
        {unsynced > 0 && (
          <Button variant="outline" className="h-11" onClick={onSync} disabled={!online || syncing}>
            <RotateCcw aria-hidden /> {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>
      <ul className="mt-3 space-y-2">
        {drafts.map((d) => {
          const st = DRAFT_STATUS[d.status];
          return (
            <li key={d.clientKey} className="rounded-lg border border-[var(--line)] bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {d.payload.entries.length} {d.payload.entries.length === 1 ? "entry" : "entries"} · {d.siteName} · <span className="num">{fmt.money(d.totalPaise / 100)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Captured <time dateTime={d.capturedAt}>{new Date(d.capturedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</time>
                    {d.attempts > 0 && ` · ${d.attempts} send ${d.attempts === 1 ? "attempt" : "attempts"}`}
                  </p>
                </div>
                <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", st.tone)}>{st.label}</span>
              </div>
              {d.message && <p className="mt-2 text-sm">{d.message}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-10" onClick={() => onOpen(d)} disabled={openKey === d.clientKey}>
                  {openKey === d.clientKey ? "Open below" : "Open and review"}
                </Button>
                <Button size="sm" variant="ghost" className="h-10 text-over" onClick={() => setDiscarding(d)}>
                  <Trash2 aria-hidden /> Discard
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!discarding}
        onOpenChange={(o) => !o && setDiscarding(null)}
        title="Discard this draft?"
        description="It was never confirmed as saved. Discarding deletes it from this device for good. If an earlier attempt did reach the server, those expenses stay saved; check the site's history."
        confirmLabel="Discard draft"
        onConfirm={() => discarding && onDiscard(discarding)}
      />
    </section>
  );
}
