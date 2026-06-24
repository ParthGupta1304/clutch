/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, FormEvent, DragEvent, MouseEvent, CSSProperties } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth, googleProvider, signInWithPopup, signOut } from './firebase';
import {
  Sparkles,
  Clock,
  Trash2,
  Edit2,
  CheckCircle2,
  ChevronRight,
  UploadCloud,
  Copy,
  AlertTriangle,
  FileText,
  Check,
  Plus,
  RefreshCw,
  Eye,
  ArrowRight,
  Settings,
  HelpCircle,
  FileCode,
  Calendar,
  CalendarPlus,
  CalendarClock,
  X,
  Smartphone,
  Mail,
  Globe,
  ExternalLink,
  Cpu,
  Wand2,
  Flame,
  Zap,
  AlertOctagon,
  Mic,
  MicOff
} from 'lucide-react';

import { BodyDoubleVoice } from './components/BodyDoubleVoice';

interface NextAction {
  id: string;
  text: string;
  completed: boolean;
  url?: string;
  source_title?: string;
  source_snippet?: string;
  is_cited?: boolean;
}

interface Artifact {
  type: 'email' | 'study' | 'general' | 'upi';
  title: string;
  draft: string;
  approved: boolean;
}

interface Flashcard {
  front: string;
  back: string;
}

interface PracticeQuestion {
  id: string;
  question: string;
  answer: string;
}

interface StudyPack {
  questions: PracticeQuestion[];
  flashcards: Flashcard[];
}

interface PlanStep {
  step_number: number;
  step_title: string;
  tool_choice: 'search' | 'browse' | 'generate';
  description: string;
}

interface AgentStepsLog {
  type: 'thought' | 'search' | 'code_execution' | 'browse' | 'output';
  title: string;
  text: string;
}

interface AgentModeState {
  status: 'idle' | 'planning' | 'running' | 'completed' | 'failed';
  plan?: PlanStep[];
  steps_log?: AgentStepsLog[];
  proposed_draft?: string;
  proposed_actions?: string[];
  approved?: boolean;
}

// Safe localStorage wrappers to prevent "Script error" or security exceptions inside sandboxed iframes
const safeGetLocalStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn("Storage access restricted:", e);
    return null;
  }
};

const safeSetLocalStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn("Storage setting restricted:", e);
  }
};

const safeRemoveLocalStorage = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn("Storage removal restricted:", e);
  }
};

interface Commitment {
  id: string;
  title: string;
  deadline: string; // ISO String
  effort_minutes: number;
  consequence: 'low' | 'medium' | 'high';
  source: string;
  status: 'pending' | 'completed';
  next_actions: NextAction[];
  artifact?: Artifact;
  panic_score: number;
  is_custom?: boolean;
  study_pack?: StudyPack;
  agent_state?: AgentModeState;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);

  const [accent, setAccent] = useState<'indigo' | 'teal'>(() => {
    const saved = safeGetLocalStorage('clutch_accent');
    return (saved === 'teal' || saved === 'indigo') ? saved : 'indigo';
  });

  const accentStyles = accent === 'teal'
    ? {
        '--accent': '#1E7A6C',
        '--accent-strong': '#155F54',
        '--accent-tint': '#E6F1EE',
        '--accent-soft': '#C7E0D9',
      } as CSSProperties
    : {
        '--accent': '#3E3C8C',
        '--accent-strong': '#2E2C6E',
        '--accent-tint': '#ECEBF6',
        '--accent-soft': '#D9D7EE',
      } as CSSProperties;

  const authFetch = async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (currentUser) {
      headers.set('x-user-id', currentUser.uid);
    }
    return fetch(url, { ...options, headers });
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  // Primary view routing for the design-system layout: 'now' | 'capture' | 'focus'.
  // The task-detail screen shows whenever a commitment is selected; panic is its own overlay.
  const [view, setView] = useState<'now' | 'capture' | 'focus'>('now');
  const [focusSeconds, setFocusSeconds] = useState<number>(25 * 60);
  const [focusRunning, setFocusRunning] = useState<boolean>(true);
  // Session-only snooze: hides a task from the Now hero until the next reload.
  const [snoozedIds, setSnoozedIds] = useState<string[]>([]);
  
  // Create / Capture Form States
  const [captureText, setCaptureText] = useState<string>('');
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string>('image/png');
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  
  // Custom manual add fields
  const [showManualForm, setShowManualForm] = useState<boolean>(false);
  const [manualTitle, setManualTitle] = useState<string>('');
  const [manualDeadline, setManualDeadline] = useState<string>('');
  const [manualEffort, setManualEffort] = useState<number>(30);
  const [manualConsequence, setManualConsequence] = useState<'low' | 'medium' | 'high'>('medium');
  const [manualSource, setManualSource] = useState<string>('Direct addition');

  // Loading for initializing currently focused task
  const [isInitializing, setIsInitializing] = useState<boolean>(false);
  
  // Edit first move state
  const [isEditingMove, setIsEditingMove] = useState<boolean>(false);
  const [editDraftValue, setEditDraftValue] = useState<string>('');

  // Gmail & OAuth integration states
  const [gmailToken, setGmailToken] = useState<string | null>(safeGetLocalStorage('gmail_access_token'));
  const [gmailClientId, setGmailClientId] = useState<string>(safeGetLocalStorage('gmail_oauth_client_id') || '');
  const [isCreatingDraft, setIsCreatingDraft] = useState<boolean>(false);
  const [showGmailModal, setShowGmailModal] = useState<boolean>(false);

  // Parse draft formatted text for subjects & headers
  const parseDraftEmail = (draftText: string) => {
    const subjectRegex = /(?:\*\*Subject:\*\*|\*Subject:\*|Subject:)\s*([^\n]+)/i;
    const match = draftText.match(subjectRegex);
    let subject = "Draft Email from Clutch";
    let body = draftText;

    if (match) {
      subject = match[1].trim();
      body = draftText.replace(/(?:\*\*Subject:\*\*|\*Subject:\*|Subject:)\s*[^\n]+\n*/i, "").trim();
    }

    return { subject, body };
  };

  // Convert markdown body to plain text or standard carriage-return formatted text for mailto
  const cleanBodyForMailto = (draftText: string) => {
    let { body } = parseDraftEmail(draftText);
    body = body.replace(/\*\*/g, "");
    body = body.replace(/^#+\s+/gm, "");
    return body;
  };

  // Info alerts or success highlights
  const [errorText, setErrorText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Speech Capture & Body Double States
  const [isRecordingMic, setIsRecordingMic] = useState<boolean>(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [showBodyDouble, setShowBodyDouble] = useState<boolean>(false);

  // Escalating Nudges - Tracks if a user dismissed a specific nudge to prevent spam
  const [dismissedNudgeTaskId, setDismissedNudgeTaskId] = useState<string | null>(null);

  // Auto-init tracking
  const autoInitRef = useRef<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Study Pack States
  const [isGeneratingStudyPack, setIsGeneratingStudyPack] = useState<boolean>(false);
  const [studyPackError, setStudyPackError] = useState<string | null>(null);
  const [activeStudyTab, setActiveStudyTab] = useState<'questions' | 'flashcards'>('questions');
  const [currentCardIndex, setCurrentCardIndex] = useState<number>(0);
  const [isCardFlipped, setIsCardFlipped] = useState<boolean>(false);
  const [revealedQuestionIds, setRevealedQuestionIds] = useState<Record<string, boolean>>({});
  const [studyFileBase64, setStudyFileBase64] = useState<string | null>(null);
  const [studyFileMime, setStudyFileMime] = useState<string>('image/png');
  const [studyFileName, setStudyFileName] = useState<string>('');
  const studyFileInputRef = useRef<HTMLInputElement>(null);

  // Gather Info (Google Search Grounding) States
  const [isGatheringInfo, setIsGatheringInfo] = useState<boolean>(false);
  const [gatherInfoError, setGatherInfoError] = useState<string | null>(null);
  const [customSearchQuery, setCustomSearchQuery] = useState<string>('');
  const [showSearchInput, setShowSearchInput] = useState<boolean>(false);

  // Agent Mode States
  const [isPlanningAgent, setIsPlanningAgent] = useState<boolean>(false);
  const [isExecutingAgent, setIsExecutingAgent] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Panic Mode States
  const [isPanicMode, setIsPanicMode] = useState<boolean>(false);

  // Fetch all commitments from the API
  const fetchCommitments = async () => {
    try {
      setLoading(true);
      setErrorText(null);
      const res = await authFetch('/api/commitments');
      if (!res.ok) throw new Error('Could not fetch commitments from server.');
      const data = await res.json();
      setCommitments(data);
    } catch (err: any) {
      setErrorText(err.message || 'Unable to connect to Clutch backend.');
    } finally {
      setLoading(false);
    }
  };

  const [nowLabel, setNowLabel] = useState<number>(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNowLabel(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Focus-session countdown (only ticks while the Focus view is active and running)
  useEffect(() => {
    if (view !== 'focus' || !focusRunning) return;
    const t = setInterval(() => {
      setFocusSeconds(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [view, focusRunning]);

  function calculateLivePanicScore(deadline: string, effort_minutes: number, consequence: 'low' | 'medium' | 'high', nowTime: number): number {
    const target = new Date(deadline).getTime();
    const days_until_deadline = (target - nowTime) / (1000 * 60 * 60 * 24);

    // Continuous effort score: minutes / 10, capped at 30
    const effortVal = Math.min(30, effort_minutes / 10);

    // Consequence score: 40 for high, 25 for medium, 10 for low
    let consequenceVal = 10;
    if (consequence === 'high') consequenceVal = 40;
    else if (consequence === 'medium') consequenceVal = 25;

    // Urgency score adapts continuously
    let urgency = 5;
    if (days_until_deadline <= 0) {
      urgency = 45;
    } else {
      // decays smoothly from 40 to 0 over days
      urgency = 40 * Math.exp(-days_until_deadline / 3.0) + 5;
    }

    return Number((urgency + consequenceVal + effortVal).toFixed(2));
  }

  function getCountdownText(deadlineISO: string, nowTime: number): string {
    const target = new Date(deadlineISO).getTime();
    const diff = target - nowTime;
    if (diff <= 0) {
      return "00d : 00h : 00m : 00s (Passed)";
    }
    const secs = Math.floor(diff / 1000) % 60;
    const mins = Math.floor(diff / (1000 * 60)) % 60;
    const hours = Math.floor(diff / (1000 * 60 * 60)) % 24;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    const zeroPad = (num: number) => num.toString().padStart(2, '0');
    return `${zeroPad(days)}d : ${zeroPad(hours)}h : ${zeroPad(mins)}m : ${zeroPad(secs)}s`;
  }

  const handleCompleteTaskInPanic = async (cid: string) => {
    try {
      const res = await authFetch(`/api/commitments/${cid}/toggle-status`, { method: 'POST' });
      if (!res.ok) throw new Error("Could not toggle status.");
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("Outstanding job! Task archived as complete.");
    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  const startSpeechCapture = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechError("Speech dictation is not natively supported by your browser. Please type notes directly.");
      return;
    }

    try {
      setSpeechError(null);
      const rec = new SpeechRecognition();
      rec.continuous = false;
      rec.interimResults = false;
      
      // 'en-IN' is remarkably optimal for capturing combined English & Hindi (Hinglish) with high fidelity.
      rec.lang = 'en-IN';
      
      rec.onstart = () => {
        setIsRecordingMic(true);
      };
      
      rec.onerror = (e: any) => {
        console.error("Speech recognition error:", e);
        setSpeechError(`Capture error: ${e.error || 'Check microphone privileges.'}`);
        setIsRecordingMic(false);
      };
      
      rec.onend = () => {
        setIsRecordingMic(false);
      };
      
      rec.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setCaptureText(prev => prev ? `${prev} ${transcript}` : transcript);
          setStatusMessage(`Speech transcribed: "${transcript}"`);
        }
      };
      
      rec.start();
    } catch (err: any) {
      setSpeechError(err.message || 'Error occurred launching audio processing loop.');
      setIsRecordingMic(false);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    fetchCommitments();
  }, [currentUser]);

  useEffect(() => {
    if (window.location.hash) {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const token = params.get('access_token');
      if (token) {
        setGmailToken(token);
        safeSetLocalStorage('gmail_access_token', token);
        // Clean hash from address bar
        window.history.replaceState(null, '', window.location.pathname);
        setStatusMessage("🔌 Connected to Google Gmail API successfully!");
        setShowGmailModal(true);
      }
    }
  }, []);

  const handleAuthSignIn = async () => {
    try {
      setErrorText(null);
      await signInWithPopup(auth, googleProvider);
      setStatusMessage("Sign-In Successful! Welcome back.");
    } catch (err: any) {
      console.error("Popup Sign-in Error:", err);
      setErrorText(err.message || 'Google Auth Popup closed or blocked.');
    }
  };

  const handleAuthSignOut = async () => {
    try {
      await signOut(auth);
      setStatusMessage("Signed out safely.");
    } catch (err: any) {
      setErrorText(err.message || 'Logout failed.');
    }
  };

  // Determine active target
  // Default to the first pending commitment with the highest Panic Score, or the user's specific selection
  const getSortedPendingCommitments = () => {
    return commitments
      .filter(c => c.status === 'pending')
      .map(c => {
        const score = calculateLivePanicScore(c.deadline, c.effort_minutes, c.consequence, nowLabel);
        return {
          ...c,
          panic_score: score,
          breakdown: getPanicBreakdown(c, nowLabel)
        };
      })
      .sort((a, b) => b.panic_score - a.panic_score);
  };

  const getSortedCompletedCommitments = () => {
    return commitments
      .filter(c => c.status === 'completed')
      .map(c => {
        const score = calculateLivePanicScore(c.deadline, c.effort_minutes, c.consequence, nowLabel);
        return {
          ...c,
          panic_score: score,
          breakdown: getPanicBreakdown(c, nowLabel)
        };
      })
      .sort((a, b) => b.panic_score - a.panic_score);
  };

  const sortedPending = getSortedPendingCommitments();
  const highestPanicTask = sortedPending[0] || null;
  
  // Focused task selection
  const activeTask = (() => {
    if (isPanicMode) {
      return highestPanicTask;
    }
    if (selectedId) {
      const found = commitments.find(c => c.id === selectedId);
      if (found) {
        const score = calculateLivePanicScore(found.deadline, found.effort_minutes, found.consequence, nowLabel);
        return {
          ...found,
          panic_score: score,
          next_actions: found.next_actions || []
        };
      }
    }
    // Default to the highest panic score pending task
    if (sortedPending.length > 0) {
      return sortedPending[0];
    }
    // Otherwise fallback if any completed task
    const completed = getSortedCompletedCommitments();
    if (completed.length > 0) {
      return completed[0];
    }
    return null;
  })();

  // Evaluate the single highest-Panic-Score pending task that stays untouched
  const getEscalatingNudgeTask = () => {
    if (isPanicMode) return null;

    const pending = commitments.filter(c => c.status === 'pending');
    if (pending.length === 0) return null;

    // Filter untouched-enough tasks (no next steps completed yet, or simply has incomplete steps)
    // To strictly define "untouched", we prioritize tasks where ZERO next steps are completed.
    // However, if all tasks have some progress but deadline approaches, we still allow them.
    // Let's first look for completely untouched (0% progress) tasks.
    let candidates = pending.filter(c => {
      if (c.id === dismissedNudgeTaskId) return false;
      const progressCount = c.next_actions?.filter(a => a.completed).length || 0;
      return progressCount === 0;
    });

    // If there are no completely untouched tasks, fallback to any pending task with remaining incomplete next actions
    if (candidates.length === 0) {
      candidates = pending.filter(c => {
        if (c.id === dismissedNudgeTaskId) return false;
        return c.next_actions?.some(a => !a.completed);
      });
    }

    if (candidates.length === 0) return null;

    // Map to live panic score
    const mapped = candidates.map(c => {
      const score = calculateLivePanicScore(c.deadline, c.effort_minutes, c.consequence, nowLabel);
      return {
        ...c,
        panic_score: score
      };
    });

    // Sort by panic score descending
    mapped.sort((a, b) => b.panic_score - a.panic_score);

    const highest = mapped[0];

    // Only nudge if the panic score >= 50
    if (highest.panic_score >= 50) {
      return highest;
    }
    return null;
  };

  const activeNudgeTask = getEscalatingNudgeTask();

  // Handle auto-starting decomposition inside focused tasks if actions are missing
  useEffect(() => {
    if (activeTask && activeTask.status === 'pending' && (!activeTask.next_actions || activeTask.next_actions.length === 0)) {
      if (autoInitRef.current !== activeTask.id) {
        autoInitRef.current = activeTask.id;
        triggerDedecompose(activeTask.id);
      }
    }
  }, [activeTask?.id]);

  // Pre-generate highest panic task next actions and artifact when entering Panic Mode
  useEffect(() => {
    if (isPanicMode && highestPanicTask) {
      const needsInit = !highestPanicTask.next_actions || highestPanicTask.next_actions.length === 0 || !highestPanicTask.artifact;
      if (needsInit && !isInitializing && autoInitRef.current !== highestPanicTask.id) {
        autoInitRef.current = highestPanicTask.id;
        triggerDedecompose(highestPanicTask.id);
      }
    }
  }, [isPanicMode, highestPanicTask?.id, highestPanicTask?.next_actions?.length, highestPanicTask?.artifact]);

  // Toast / Status cleanup
  useEffect(() => {
    if (statusMessage) {
      const t = setTimeout(() => setStatusMessage(null), 5000);
      return () => clearTimeout(t);
    }
  }, [statusMessage]);

  useEffect(() => {
    if (errorText) {
      const t = setTimeout(() => setErrorText(null), 8000);
      return () => clearTimeout(t);
    }
  }, [errorText]);

  // Compute detailed Panic Score breakdown on the client side
  function getPanicBreakdown(c: Commitment, nowTime: number) {
    const hoursRemaining = (new Date(c.deadline).getTime() - nowTime) / (1000 * 60 * 60);
    
    let urgency = 5;
    let urgencyDesc = "Due in over 7 days";
    
    if (hoursRemaining <= 0) {
      urgency = 40;
      urgencyDesc = "Overdue / Immediate action required";
    } else if (hoursRemaining <= 12) {
      urgency = 38;
      urgencyDesc = "Due within 12 hours";
    } else if (hoursRemaining <= 24) {
      urgency = 35;
      urgencyDesc = "Due within 24 hours";
    } else if (hoursRemaining <= 48) {
      urgency = 30;
      urgencyDesc = "Due within 48 hours";
    } else if (hoursRemaining <= 72) {
      urgency = 25;
      urgencyDesc = "Due within 3 days";
    } else if (hoursRemaining <= 168) {
      urgency = 15;
      urgencyDesc = "Due within 7 days";
    }

    let consequenceVal = 10;
    if (c.consequence === 'high') consequenceVal = 40;
    else if (c.consequence === 'medium') consequenceVal = 25;

    let effortVal = 5;
    if (c.effort_minutes >= 240) effortVal = 20;
    else if (c.effort_minutes >= 120) effortVal = 15;
    else if (c.effort_minutes >= 30) effortVal = 10;

    const total = calculateLivePanicScore(c.deadline, c.effort_minutes, c.consequence, nowTime);

    return {
      urgencyScore: urgency,
      urgencyDesc,
      consequenceScore: consequenceVal,
      effortScore: effortVal,
      total,
      hoursRemaining
    };
  }

  // Formatting date output beautifully
  const formatDeadlineDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const hoursRemaining = (d.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursRemaining <= 0) {
        return { text: 'Overdue', style: 'text-rose-600 font-medium' };
      }
      if (hoursRemaining <= 24) {
        return { text: `Today (${Math.round(hoursRemaining)}h left)`, style: 'text-amber-600 font-semibold' };
      }
      if (hoursRemaining <= 48) {
        return { text: `Tomorrow (${Math.round(hoursRemaining)}h left)`, style: 'text-amber-700 font-medium' };
      }

      // general readable date
      const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
      return { text: d.toLocaleDateString('en-IN', options), style: 'text-slate-600' };
    } catch {
      return { text: dateStr, style: 'text-slate-600' };
    }
  };

  // ─── Schedule: propose right-sized focus blocks, then open Google Calendar (approve-first) ───
  const proposeCalendarBlocks = (commitment: Commitment) => {
    const now = Date.now();
    const deadline = new Date(commitment.deadline).getTime();
    const effort = Math.max(10, commitment.effort_minutes || 30);

    // Right-size each session: short tasks stay a single block; longer ones split into ~50-min focus blocks.
    const sessionLen = effort <= 40 ? effort : 50;
    const numSessions = Math.min(4, Math.max(1, Math.round(effort / sessionLen)));

    const hoursUntil = (deadline - now) / 3600000;
    const blocks: { start: Date; end: Date }[] = [];

    if (hoursUntil <= 24) {
      // Crunch mode: stack blocks today, starting ~1h from now, back-to-back with short breathers.
      let cursor = now + 60 * 60 * 1000;
      for (let i = 0; i < numSessions; i++) {
        const start = new Date(cursor);
        const end = new Date(cursor + sessionLen * 60 * 1000);
        if (end.getTime() > deadline) break;
        blocks.push({ start, end });
        cursor = end.getTime() + 15 * 60 * 1000;
      }
      if (blocks.length === 0) {
        const start = new Date(now + 30 * 60 * 1000);
        blocks.push({ start, end: new Date(start.getTime() + sessionLen * 60 * 1000) });
      }
    } else {
      // Spread one block per upcoming morning at 10:00 local, all before the deadline.
      for (let i = 0; i < numSessions; i++) {
        const start = new Date(now);
        start.setDate(start.getDate() + i + 1);
        start.setHours(10, 0, 0, 0);
        const end = new Date(start.getTime() + sessionLen * 60 * 1000);
        if (end.getTime() > deadline) break;
        blocks.push({ start, end });
      }
      if (blocks.length === 0) {
        const start = new Date(now + 60 * 60 * 1000);
        blocks.push({ start, end: new Date(start.getTime() + sessionLen * 60 * 1000) });
      }
    }
    return { blocks, sessionLen };
  };

  const toCalStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const formatBlockLabel = (start: Date, end: Date) => {
    const day = start.toLocaleDateString('en-IN', { weekday: 'short' });
    const s = start.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const e = end.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    return `${day} ${s}–${e}`;
  };

  const openGoogleCalendar = (commitment: Commitment, start: Date, end: Date) => {
    const text = encodeURIComponent(`Clutch focus: ${commitment.title}`);
    const dates = `${toCalStamp(start)}/${toCalStamp(end)}`;
    const details = encodeURIComponent(
      `Focus block proposed by Clutch to build momentum on "${commitment.title}" before its deadline.\n\nDeadline: ${new Date(commitment.deadline).toLocaleString('en-IN')}`
    );
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${dates}&details=${details}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    setStatusMessage('Opened Google Calendar — review and save your focus block.');
  };

  // Drag and Drop files to analyze
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorText("To maintain high accuracy, Clutch analyzes screenshots or documents formatted as PNG/JPG images first.");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setImageBase64(reader.result as string);
      setImageMime(file.type);
      setSelectedFileName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const clearUploadedFile = () => {
    setImageBase64(null);
    setSelectedFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Run the Extraction via Gemini Vision/Text on the Server
  const handleCommitmentExtraction = async (e: FormEvent) => {
    e.preventDefault();
    if (!captureText.trim() && !imageBase64) {
      setErrorText("Provide handwritten directions, a cut-and-paste schedule, or upload an image screenshot.");
      return;
    }

    try {
      setIsExtracting(true);
      setErrorText(null);
      const res = await authFetch('/api/commitments/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: captureText,
          imageBase64: imageBase64,
          imageMime: imageMime
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Server rejected extraction format request.');
      }

      const parsedList = await res.json();
      
      if (parsedList && parsedList.length > 0) {
        setStatusMessage(`Successfully captured ${parsedList.length} commitments using Gemini AI.`);
        setCaptureText('');
        clearUploadedFile();
        fetchCommitments();
        // focus the newly added item with highest priority
        setSelectedId(parsedList[0].id);
      } else {
        setErrorText("Gemini analyzed the input, but found no structural action-items. Try typing the commitment title directly.");
      }

    } catch (err: any) {
      setErrorText(err.message || 'Failed connecting with Clutch Agent. Ensure your API secret is set.');
    } finally {
      setIsExtracting(false);
    }
  };

  // Add manually structured task
  const handleManualAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim() || !manualDeadline) {
      setErrorText("Provide a task nickname and a strict target deadline.");
      return;
    }

    try {
      setLoading(true);
      setErrorText(null);
      
      // format to standard ISO date-time
      const deadlineISO = new Date(manualDeadline).toISOString();

      const res = await authFetch('/api/commitments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: manualTitle,
          deadline: deadlineISO,
          effort_minutes: manualEffort,
          consequence: manualConsequence,
          source: manualSource
        })
      });

      if (!res.ok) throw new Error("Could not record target commitment.");
      const added = await res.json();
      
      setManualTitle('');
      setManualDeadline('');
      setShowManualForm(false);
      setStatusMessage("Commitment stored. Clutch is auto-decompressing next action-items.");
      await fetchCommitments();
      setSelectedId(added.id);

    } catch (err: any) {
      setErrorText(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Call API to trigger Gemini decomposition and first move draft
  const triggerDedecompose = async (cid: string) => {
    try {
      setIsInitializing(true);
      setErrorText(null);
      const res = await authFetch(`/api/commitments/${cid}/initialize`, {
        method: 'POST'
      });

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || 'Failed generating start plan.');
      }

      const updated = await res.json();
      
      // Update commitments array locally
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("Roadmap & First Move drafted successfully!");

    } catch (err: any) {
      setErrorText(err.message || 'Failed running initialization script.');
    } finally {
      setIsInitializing(false);
    }
  };

  // Focus a specific goal from the escalating nudge area and scroll to it
  const handleNudgeFocus = (cid: string) => {
    setSelectedId(cid);
    setTimeout(() => {
      const el = document.getElementById('focus-arena');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 100);
  };

  // Toggle specific checklist step
  const handleToggleAction = async (cid: string, actionId: string) => {
    try {
      const res = await authFetch(`/api/commitments/${cid}/toggle-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId })
      });

      if (!res.ok) throw new Error("Could not check mark roadmap item.");
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));

    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  // Approve first move draft (marks task done for now)
  const handleApproveMove = async (cid: string) => {
    try {
      const res = await authFetch(`/api/commitments/${cid}/approve-move`, {
        method: 'POST'
      });

      if (!res.ok) throw new Error("Unable to record draft approval.");
      const updated = await res.json();
      
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("That was the hard part. Done.");
      // Keep the task selected so the "first move sent" confirmation can show.

    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  // Create direct Gmail draft using API
  const handleCreateGmailDraft = async (cid: string, draftText: string) => {
    setIsCreatingDraft(true);
    setErrorText(null);
    try {
      const token = gmailToken || safeGetLocalStorage('gmail_access_token');
      if (!token) {
        throw new Error("No Google authorization token found. Please sign in under Option 2 first.");
      }

      const { subject, body } = parseDraftEmail(draftText);

      // Create MIME format
      const utf8Subject = `=?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
      const mimeParts = [
        `Subject: ${utf8Subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        body.replace(/\n/g, '<br/>')
      ];
      const rawMessage = mimeParts.join('\r\n');
      const encodedMessage = btoa(unescape(encodeURIComponent(rawMessage)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            raw: encodedMessage
          }
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          setGmailToken(null);
          safeRemoveLocalStorage('gmail_access_token');
          throw new Error("Google access token has expired. Please authorize again.");
        }
        const errRes = await response.json().catch(() => ({}));
        throw new Error(errRes.error?.message || `Gmail API draft creation failed with code ${response.status}`);
      }

      // Record draft approval in backend
      const resApprove = await authFetch(`/api/commitments/${cid}/approve-move`, {
        method: 'POST'
      });
      if (!resApprove.ok) throw new Error("Created draft inside Gmail, but could not finalize backing checklist.");
      const updated = await resApprove.json();

      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("⚡ Real draft created inside Gmail and task archived successfully!");
      setShowGmailModal(false);
      setSelectedId(null);

    } catch (err: any) {
      setErrorText(err.message || 'Gmail draft creation failed.');
    } finally {
      setIsCreatingDraft(false);
    }
  };

  // Trigger Google OAuth implicit grant flow
  const handleGoogleSignIn = () => {
    if (!gmailClientId.trim()) {
      setErrorText("Google OAuth Client ID is required to authorize direct Gmail API draft creation.");
      return;
    }
    safeSetLocalStorage('gmail_oauth_client_id', gmailClientId.trim());
    
    const redirectUri = window.location.origin;
    const scope = "https://www.googleapis.com/auth/gmail.compose";
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(gmailClientId.trim())}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}`;
    
    window.location.href = authUrl;
  };

  // Save modified draft
  const handleSaveDraftEdit = async (cid: string) => {
    try {
      const res = await authFetch(`/api/commitments/${cid}/edit-move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: editDraftValue })
      });

      if (!res.ok) throw new Error("Could not update modified draft.");
      const updated = await res.json();
      
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setIsEditingMove(false);
      setStatusMessage("First Move draft updated.");

    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  // Study File Selector
  const handleStudyFileSelect = (file: File) => {
    if (!(file.type.startsWith('image/') || file.type === 'application/pdf')) {
      setStudyPackError("Requires notes or syllabus formatted as an image (PNG/JPG) or PDF document.");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setStudyFileBase64(reader.result as string);
      setStudyFileMime(file.type);
      setStudyFileName(file.name);
      setStudyPackError(null);
    };
    reader.readAsDataURL(file);
  };

  // Generate study pack from file
  const handleGenerateStudyPack = async (cid: string) => {
    const fileSource = studyFileBase64 || imageBase64;
    const mimeSource = studyFileMime || imageMime;
    if (!fileSource) {
      setStudyPackError("Please select/drag your syllabus or notes file (PDF/Image) to generate a study pack.");
      return;
    }

    try {
      setIsGeneratingStudyPack(true);
      setStudyPackError(null);
      const res = await authFetch(`/api/commitments/${cid}/generate-study-pack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: fileSource,
          imageMime: mimeSource
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate study pack.');
      }

      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      
      // Reset study pack panel state
      setCurrentCardIndex(0);
      setIsCardFlipped(false);
      setRevealedQuestionIds({});
      setStudyFileBase64(null);
      setStudyFileName('');
      
      setStatusMessage("📚 Active recall study pack with 5 practice questions and 5 flashcards generated successfully!");
    } catch (err: any) {
      setStudyPackError(err.message || 'Failed to build study pack with Gemini.');
    } finally {
      setIsGeneratingStudyPack(false);
    }
  };

  // Google Search grounded info gatherer
  const handleGatherInfo = async (cid: string) => {
    try {
      setIsGatheringInfo(true);
      setGatherInfoError(null);
      
      const res = await authFetch(`/api/commitments/${cid}/gather-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customQuery: customSearchQuery.trim() || undefined })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to search online or fetch link.');
      }

      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      
      setCustomSearchQuery('');
      setShowSearchInput(false);
      setStatusMessage("🔍 Found cited portal/info using Live Google Search and attached to unblocking steps!");
    } catch (err: any) {
      setGatherInfoError(err.message || 'Failed to search details with Gemini.');
    } finally {
      setIsGatheringInfo(false);
    }
  };

  // Generate Agent Plan
  const handleGenerateAgentPlan = async (cid: string) => {
    try {
      setIsPlanningAgent(true);
      setAgentError(null);
      const res = await authFetch(`/api/commitments/${cid}/agent/plan`, {
        method: 'POST'
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to generate plan.');
      }
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("📑 Autonomous Agent Mode: Plan drafted! Review and click 'Execute Sandbox Agent' to begin.");
    } catch (err: any) {
      setAgentError(err.message || 'Failed to draft planning steps.');
    } finally {
      setIsPlanningAgent(false);
    }
  };

  // Execute Sandbox Agent
  const handleExecuteAgent = async (cid: string) => {
    try {
      setIsExecutingAgent(true);
      setAgentError(null);
      
      const res = await authFetch(`/api/commitments/${cid}/agent/execute`, {
        method: 'POST'
      });

      if (!res.ok) {
        const errData = await res.json();
        if (errData.commitment) {
          setCommitments(prev => prev.map(c => c.id === cid ? errData.commitment : c));
        }
        throw new Error(errData.error || 'Agent loop failed during run.');
      }

      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("🚀 Expert Agent successfully unblocked task chunk and produced draft artifact!");
    } catch (err: any) {
      setAgentError(err.message || 'Expert Agent run failed.');
    } finally {
      setIsExecutingAgent(false);
    }
  };

  // Approve & Merge Agent Results
  const handleApproveAgentMerge = async (cid: string) => {
    try {
      setAgentError(null);
      const res = await authFetch(`/api/commitments/${cid}/agent/approve-merge`, {
        method: 'POST'
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to merge results.');
      }
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage("✅ Autonomous Agent draft Applied! New microstep checklists and artifacts attached.");
    } catch (err: any) {
      setAgentError(err.message || 'Failed to apply findings.');
    }
  };

  // Reset Agent Mode state
  const handleResetAgent = async (cid: string) => {
    try {
      setAgentError(null);
      const res = await authFetch(`/api/commitments/${cid}/agent/reset`, {
        method: 'POST'
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to reset agent state.');
      }
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
    } catch (err: any) {
      setAgentError(err.message || 'Failed to discard agent draft.');
    }
  };

  // Reset/seed demo dataset
  const resetDemoData = async () => {
    if (!confirm("Restore standard trial mock dataset? Any uploaded assets will clear.")) return;
    try {
      setLoading(true);
      const res = await authFetch('/api/commitments/reset', { method: 'POST' });
      if (!res.ok) throw new Error("Could not clear data storage.");
      const data = await res.json();
      setCommitments(data);
      setSelectedId(null);
      setStatusMessage("Demo commitments populated successfully.");
    } catch (err: any) {
      setErrorText(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Delete commitment
  const deleteCommitment = async (cid: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to discard this task layout?")) return;
    try {
      const res = await authFetch(`/api/commitments/${cid}`, { method: 'DELETE' });
      if (!res.ok) throw new Error("Could not discard task.");
      setCommitments(prev => prev.filter(c => c.id !== cid));
      if (selectedId === cid) setSelectedId(null);
      setStatusMessage("Task discarded cleanly.");
    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  // Toggle general task status between pending and complete
  const toggleOverallStatus = async (cid: string, e: MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await authFetch(`/api/commitments/${cid}/toggle-status`, { method: 'POST' });
      if (!res.ok) throw new Error("Could not toggle status.");
      const updated = await res.json();
      setCommitments(prev => prev.map(c => c.id === cid ? updated : c));
      setStatusMessage(updated.status === 'completed' ? "Task archived as complete!" : "Task re-opened.");
    } catch (err: any) {
      setErrorText(err.message);
    }
  };

  // Copy draft helper
  const copyToClipboard = (text: string, label: string = "Draft details") => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        setStatusMessage(`${label} copied to clip tray!`);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setStatusMessage(`${label} copied to clip tray!`);
      }
    } catch (err: any) {
      console.warn("Clipboard access failed:", err);
      setStatusMessage(`Fallback copy option: please select details manually.`);
    }
  };

  // Custom Markdown translation helper
  function formatMarkdown(text: string) {
    if (!text) return '';
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/^###\s+(.*?)$/gm, '<h4 class="text-white bg-slate-800 text-sm tracking-wide font-medium font-mono uppercase px-3 py-1.5 rounded inline-block mt-4 mb-2">$1</h4>');
    html = html.replace(/^####\s+(.*?)$/gm, '<h5 class="text-slate-800 font-semibold text-sm mt-3 mb-1">$1</h5>');
    html = html.replace(/^##\s+(.*?)$/gm, '<h3 class="text-slate-950 font-bold border-b border-slate-200 pb-1.5 text-base mt-5 mb-3">$1</h3>');
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-slate-900">$1</strong>');
    html = html.replace(/^\*\s+(.*?)$/gm, '<li class="ml-4 list-disc pl-1 py-1 text-slate-700 leading-relaxed">$1</li>');
    html = html.replace(/^-\s+(.*?)$/gm, '<li class="ml-4 list-disc pl-1 py-1 text-slate-700 leading-relaxed">$1</li>');
    html = html.replace(/`(.*?)`/g, '<code class="bg-amber-50 hover:bg-amber-100 text-amber-900 px-1 py-0.5 rounded font-mono text-xs select-all cursor-pointer font-semibold" title="Copy detail" onclick="navigator.clipboard.writeText(\'$1\')">$1</code>');
    html = html.replace(/\$\$(.*?)\$\$/g, '<div class="my-3 px-4 py-3 bg-slate-50 font-mono text-center text-xs text-slate-800 rounded border border-slate-200 overflow-x-auto">$1</div>');
    html = html.replace(/\$(.*?)\$/g, '<code class="font-mono bg-slate-100 px-1 py-0.5 rounded text-slate-800">$1</code>');
    html = html.replace(/\n\n/g, '<p class="mb-4"></p>');
    html = html.replace(/\n/g, '<br />');

    return html;
  }

  // Active task details if present
  const details = activeTask ? getPanicBreakdown(activeTask, nowLabel) : null;

  // ───────────────────────── Design-system view model ─────────────────────────
  const nowHero = sortedPending.find(c => !snoozedIds.includes(c.id)) || highestPanicTask;
  const railItems = sortedPending.filter(c => c.id !== (nowHero ? nowHero.id : ''));
  const taskOpen = !!selectedId && !!activeTask;
  const focusTask = activeTask || highestPanicTask;

  const fmtClock = (secs: number) =>
    `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
  // Panic ring: r=24.5 → circumference 153.9; offset shrinks as score rises.
  const ringOffset = (score: number) => (153.9 * (1 - Math.min(100, Math.max(0, score)) / 100)).toFixed(1);

  const monoLabel = 'font-mono text-[11px] tracking-[0.14em] text-[#9D988C] uppercase';

  const navItem = (
    key: 'now' | 'capture' | 'focus',
    label: string,
    icon: any,
    onClick: () => void,
  ) => {
    const active = !isPanicMode && view === key && (key !== 'now' || !taskOpen);
    return (
      <button
        onClick={onClick}
        className="flex items-center gap-3 px-3 py-2.5 rounded-[11px] mb-1 border-none cursor-pointer text-left w-full transition-colors"
        style={{ background: active ? 'rgba(255,255,255,.7)' : 'transparent' }}
        onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.5)'; }}
        onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      >
        {icon}
        <span className="text-[14.5px]" style={{ fontWeight: active ? 600 : 500, color: active ? '#1C1B19' : '#6B675E' }}>{label}</span>
      </button>
    );
  };

  const renderEmailArtifact = (task: any) => {
    if (!task || !task.artifact) return null;
    const isEmail = task.artifact.type === 'email';
    const { subject, body } = parseDraftEmail(task.artifact.draft);
    return (
      <div className="bg-[#FCFAF5] border border-[#EAE4D7] rounded-[22px] shadow-[0_1px_2px_rgba(28,27,25,.04),0_24px_46px_-30px_rgba(28,27,25,.3)] overflow-hidden animate-clutch-rise">
        <div className="flex items-center gap-2 px-[18px] py-[14px] bg-[var(--accent-tint)] border-b border-[var(--accent-soft)]">
          <div className="w-[18px] h-[18px] rounded-[5px] bg-[var(--accent)] flex items-center justify-center">
            <svg width="8" height="9" viewBox="0 0 12 13" fill="#fff"><path d="M1.5 1.3 11 6.5 1.5 11.7Z" /></svg>
          </div>
          <span className="font-mono text-[10.5px] tracking-[0.12em] text-[var(--accent-strong)] uppercase font-medium">First move · drafted for you</span>
        </div>
        <div className="p-5">
          {isEmail && subject && (
            <div className="flex gap-2.5 pb-[13px] border-b border-[#EFE9DC] mb-[13px]">
              <span className="font-mono text-[12px] text-[#A59E8E] w-[54px] flex-none">Subject</span>
              <span className="text-[13.5px] text-[#3A352C] font-medium">{subject}</span>
            </div>
          )}
          <div
            className="text-[14px] leading-[1.6] text-[#3A352C] prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: formatMarkdown(isEmail ? body : task.artifact.draft) }}
          />
        </div>
        <div className="flex gap-2.5 px-5 pb-5">
          <button
            onClick={() => {
              if (isEmail) {
                const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cleanBodyForMailto(task.artifact!.draft))}`;
                window.open(mailto, '_blank');
              }
              handleApproveMove(task.id);
            }}
            className="flex-1 h-[50px] rounded-[13px] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[15px] font-semibold cursor-pointer flex items-center justify-center gap-2 border-none shadow-[0_8px_18px_-9px_var(--accent-strong)] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.9"><path d="M3 8.2 6.3 11.5 13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {isEmail ? 'Approve & send' : 'Approve'}
          </button>
          <button
            onClick={() => { setEditDraftValue(task.artifact!.draft); setIsEditingMove(true); }}
            className="h-[50px] px-[18px] rounded-[13px] border border-[#E0DACB] hover:border-[#CFC8B8] bg-white text-[#3A352C] text-[15px] font-semibold cursor-pointer transition-colors"
          >
            Edit
          </button>
        </div>
      </div>
    );
  };

  return (
    <div style={accentStyles} className="font-sans antialiased text-[#1C1B19]">

      {/* ============================ APP SHELL ============================ */}
      <div className="flex h-screen w-full overflow-hidden bg-[#F3EFE6]">

        {/* ───────────── Sidebar ───────────── */}
        <div className="w-[236px] flex-none border-r border-[#E2DCCD] px-5 py-[26px] flex flex-col">
          <button
            onClick={() => { setView('now'); setSelectedId(null); }}
            className="flex items-center gap-2.5 mb-[34px] pl-1 bg-transparent border-none cursor-pointer"
          >
            <div className="w-7 h-7 rounded-[8px] bg-[var(--accent)] flex items-center justify-center">
              <svg width="11" height="12" viewBox="0 0 12 13" fill="#fff"><path d="M1.5 1.3 11 6.5 1.5 11.7Z" /></svg>
            </div>
            <span className="text-[18px] font-semibold tracking-[-0.02em]">Clutch</span>
          </button>

          {navItem('now', 'Now',
            <svg width="19" height="19" viewBox="0 0 23 23" fill="none" stroke={(!isPanicMode && view === 'now' && !taskOpen) ? 'var(--accent)' : '#6B675E'} strokeWidth="1.8"><circle cx="11.5" cy="11.5" r="7.5" /><circle cx="11.5" cy="11.5" r="2.3" fill={(!isPanicMode && view === 'now' && !taskOpen) ? 'var(--accent)' : '#6B675E'} stroke="none" /></svg>,
            () => { setView('now'); setSelectedId(null); })}

          {navItem('capture', 'Capture',
            <svg width="19" height="19" viewBox="0 0 23 23" fill="none" stroke={(!isPanicMode && view === 'capture') ? 'var(--accent)' : '#6B675E'} strokeWidth="1.8"><rect x="3.5" y="3.5" width="16" height="16" rx="5" /><path d="M11.5 8v7M8 11.5h7" strokeLinecap="round" /></svg>,
            () => { setView('capture'); setSelectedId(null); })}

          {navItem('focus', 'Focus',
            <svg width="19" height="19" viewBox="0 0 23 23" fill="none" stroke={(!isPanicMode && view === 'focus') ? 'var(--accent)' : '#6B675E'} strokeWidth="1.8"><circle cx="11.5" cy="12.5" r="7.5" /><path d="M11.5 8.5v4l2.5 1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
            () => { setView('focus'); setSelectedId(null); })}

          <button
            onClick={() => setIsPanicMode(true)}
            className="flex items-center gap-2.5 mt-3.5 px-3 py-2.5 rounded-[11px] border border-[#EBD9C9] cursor-pointer text-left w-full bg-[#FBF1E8] hover:bg-[#F8E9DB] transition-colors"
          >
            <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'linear-gradient(135deg,#E8A13C,#DD5A45)' }} />
            <span className="text-[13px] font-medium text-[#C26A3E]">Panic Mode</span>
          </button>

          <div className="mt-auto flex items-center gap-2.5 pl-1">
            <div className="w-[34px] h-[34px] rounded-full bg-[#E4DFD2] flex items-center justify-center text-[13px] font-semibold text-[#6B675E]">S</div>
            <div>
              <div className="text-[13.5px] font-semibold">Sam Ortiz</div>
              <div className="text-[11.5px] text-[#A59E8E]">Student</div>
            </div>
          </div>
        </div>

        {/* ───────────── Main area ───────────── */}
        <div className="flex-1 flex min-w-0 relative">

          {/* ===== NOW (hero) — only when no task is open ===== */}
          {view === 'now' && !taskOpen && (
            <>
              <div className="flex-1 flex items-center justify-center p-10 overflow-y-auto">
                {nowHero ? (
                  <div className="w-full max-w-[540px]">
                    <div className={`${monoLabel} mb-[18px]`}>One thing matters right now</div>
                    <div className="bg-[#FCFAF5] border border-[#EAE4D7] rounded-[26px] p-8 shadow-[0_1px_2px_rgba(28,27,25,.04),0_30px_60px_-36px_rgba(28,27,25,.3)]">
                      <div className="flex justify-between items-start mb-5">
                        <span className="font-mono text-[11px] tracking-[0.14em] text-[var(--accent)] uppercase pt-2">Do this now</span>
                        <div className="relative w-[58px] h-[58px]">
                          <svg width="58" height="58" viewBox="0 0 58 58">
                            <circle cx="29" cy="29" r="24.5" fill="none" stroke="#EBE5D7" strokeWidth="5" />
                            <circle cx="29" cy="29" r="24.5" fill="none" stroke="url(#gnow)" strokeWidth="5" strokeLinecap="round" strokeDasharray="153.9" strokeDashoffset={ringOffset(nowHero.panic_score)} transform="rotate(-90 29 29)" />
                            <defs><linearGradient id="gnow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#E8A13C" /><stop offset="1" stopColor="#DD5A45" /></linearGradient></defs>
                          </svg>
                          <span className="absolute inset-0 flex items-center justify-center font-mono text-[16px] text-[#1C1B19]">{Math.round(nowHero.panic_score)}</span>
                        </div>
                      </div>
                      <h2 className="m-0 mb-4 text-[34px] leading-[1.12] font-semibold tracking-[-0.03em]">{nowHero.title}</h2>
                      <div className="flex items-center gap-[7px] mb-[22px]">
                        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="#DD5A45" strokeWidth="1.5"><circle cx="7.5" cy="7.5" r="6" /><path d="M7.5 4.2V7.5l2.3 1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        <span className="text-[15px] font-medium text-[#DD5A45]">{formatDeadlineDate(nowHero.deadline).text}</span>
                      </div>
                      {nowHero.artifact && (
                        <div className="flex items-center gap-2.5 bg-[var(--accent-tint)] rounded-[14px] px-[15px] py-[13px] mb-[22px]">
                          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent)" strokeWidth="1.7"><path d="M3.5 9.5 7 13l7.5-8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          <span className="text-[14px] text-[var(--accent-strong)]">
                            {nowHero.artifact.type === 'email' ? 'Clutch already drafted your email — just review & send.' : 'Clutch already drafted your first move — just review & approve.'}
                          </span>
                        </div>
                      )}
                      <div className="flex gap-3">
                        <button
                          onClick={() => { setSelectedId(nowHero.id); setView('now'); }}
                          className="flex-1 h-[54px] rounded-[15px] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[16px] font-semibold cursor-pointer border-none shadow-[0_10px_22px_-10px_var(--accent-strong)] transition-colors"
                        >
                          Do the first move
                        </button>
                        <button
                          onClick={() => { setSnoozedIds(prev => [...prev, nowHero.id]); setStatusMessage("Snoozed — I'll resurface this later."); }}
                          className="h-[54px] px-[22px] rounded-[15px] border border-[#E0DACB] hover:border-[#CFC8B8] bg-white text-[#3A352C] text-[15px] font-semibold cursor-pointer transition-colors"
                        >
                          Snooze
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center max-w-[420px]">
                    <div className="w-[52px] h-[52px] rounded-full bg-[var(--accent-tint)] flex items-center justify-center mx-auto mb-4">
                      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="var(--accent)" strokeWidth="2.2"><path d="M6 13.5 11 18.5 20 8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </div>
                    <h2 className="text-[28px] font-semibold tracking-[-0.025em] mb-2">You're all clear.</h2>
                    <p className="text-[15px] text-[#6B675E] leading-[1.4]">Nothing is pressing right now. Capture something new when it lands.</p>
                  </div>
                )}
              </div>

              {/* right rail */}
              {railItems.length > 0 && (
                <div className="w-[312px] flex-none border-l border-[#E2DCCD] px-6 py-[30px] overflow-y-auto">
                  <div className="flex items-baseline justify-between mb-4">
                    <span className={monoLabel}>Also on your plate</span>
                    <span className="text-[12px] text-[#B6A98E]">{railItems.length}</span>
                  </div>
                  <div className="flex flex-col">
                    {railItems.map(item => (
                      <button
                        key={item.id}
                        onClick={() => { setSelectedId(item.id); setView('now'); }}
                        className="flex items-center gap-3 px-0.5 py-[14px] border-t border-[#E6E0D3] bg-transparent hover:bg-white/50 cursor-pointer text-left w-full transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-medium text-[#3A352C] mb-[3px] truncate">{item.title}</div>
                          <div className="text-[12px] text-[#A59E8E]">{formatDeadlineDate(item.deadline).text}</div>
                        </div>
                        <span className="font-mono text-[12.5px] text-[#B6A98E]">{Math.round(item.panic_score)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ===== TASK detail ===== */}
          {view === 'now' && taskOpen && activeTask && (
            <div className="flex-1 flex items-start justify-center p-10 overflow-y-auto">
              <div className="w-full max-w-[600px]">
                <button onClick={() => setSelectedId(null)} className="flex items-center gap-[7px] bg-transparent border-none cursor-pointer text-[13.5px] text-[#6B675E] hover:text-[#1C1B19] pb-4 transition-colors">
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6.5 1.5 1.5 6.5l5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  Now
                </button>
                <h2 className="m-0 mb-3 text-[27px] font-semibold tracking-[-0.025em] leading-[1.15]">{activeTask.title}</h2>
                <div className="flex items-center gap-3.5 mb-7">
                  <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-[#DD5A45]">
                    <svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="#DD5A45" strokeWidth="1.5"><circle cx="7.5" cy="7.5" r="6" /><path d="M7.5 4.2V7.5l2.3 1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    {formatDeadlineDate(activeTask.deadline).text}
                  </span>
                  <span className="font-mono text-[12.5px] text-[#B6A98E]">Panic {Math.round(activeTask.panic_score)}</span>
                </div>

                {activeTask.next_actions && activeTask.next_actions.length > 0 && (
                  <>
                    <div className={`${monoLabel} mb-3`}>Next actions</div>
                    <div className="flex flex-col gap-[3px] mb-7">
                      {activeTask.next_actions.map(item => (
                        <div key={item.id} onClick={() => handleToggleAction(activeTask.id, item.id)} className="flex items-center gap-[13px] px-1 py-[11px] cursor-pointer group">
                          <div className="w-6 h-6 rounded-[8px] border-[1.5px] border-[#D9D2C2] flex-none relative bg-[#FCFAF5]">
                            {item.completed && (
                              <span className="absolute -inset-[1.5px] rounded-[8px] bg-[var(--accent)] flex items-center justify-center">
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="2"><path d="M3 7.2 5.8 10 11 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                              </span>
                            )}
                          </div>
                          <span className={`flex-1 text-[15px] leading-[1.3] ${item.completed ? 'text-[#A59E8E] line-through' : 'text-[#3A352C]'}`}>{item.text}</span>
                          {item.is_cited && <span className="text-[11px] text-[var(--accent)] bg-[var(--accent-tint)] px-[9px] py-[3px] rounded-full font-medium whitespace-nowrap">Found by Clutch</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {isInitializing && (!activeTask.next_actions || activeTask.next_actions.length === 0) ? (
                  <div className="bg-[#FCFAF5] border border-[#EAE4D7] rounded-[22px] p-[22px]">
                    <div className="flex items-center gap-2.5 mb-[18px]">
                      <span className="w-[9px] h-[9px] rounded-full bg-[var(--accent)] animate-clutch-pulse" />
                      <span className="text-[14px] text-[#6B675E]">Clutch is writing the first move…</span>
                    </div>
                    <div className="flex flex-col gap-[9px]">
                      {['45%', '88%', '80%', '62%'].map((w, i) => (
                        <div key={i} className="h-[13px] rounded-[6px] animate-clutch-shimmer" style={{ width: w }} />
                      ))}
                    </div>
                  </div>
                ) : isEditingMove ? (
                  <div className="bg-[#FCFAF5] border border-[#EAE4D7] rounded-[22px] p-5 space-y-3">
                    <textarea
                      value={editDraftValue}
                      onChange={e => setEditDraftValue(e.target.value)}
                      className="w-full h-[280px] bg-white border border-[#E6E0D3] rounded-[12px] p-3.5 font-mono text-[13px] text-[#1C1B19] outline-none focus:border-[var(--accent)] resize-none"
                    />
                    <div className="flex justify-end gap-2.5">
                      <button onClick={() => setIsEditingMove(false)} className="h-[42px] px-4 rounded-[12px] border border-[#E0DACB] hover:border-[#CFC8B8] bg-white text-[#6B675E] text-[14px] font-medium cursor-pointer transition-colors">Discard</button>
                      <button onClick={() => handleSaveDraftEdit(activeTask.id)} className="h-[42px] px-5 rounded-[12px] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[14px] font-semibold cursor-pointer border-none transition-colors">Save draft</button>
                    </div>
                  </div>
                ) : activeTask.artifact && activeTask.artifact.approved ? (
                  <div className="bg-[#FCFAF5] border border-[var(--accent-soft)] rounded-[22px] px-6 py-[30px] text-center animate-clutch-rise">
                    <div className="w-[52px] h-[52px] rounded-full bg-[var(--accent)] flex items-center justify-center mx-auto mb-4">
                      <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="#fff" strokeWidth="2.4"><path d="M6 13.5 11 18.5 20 8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </div>
                    <div className="text-[18px] font-semibold mb-1.5">{activeTask.artifact.type === 'email' ? 'Email ready to send.' : 'First move approved.'}</div>
                    <div className="text-[14px] text-[#6B675E] leading-[1.45]">That was the hard part.</div>
                    <button onClick={() => { setSelectedId(null); setView('now'); }} className="mt-[18px] h-[46px] px-[22px] rounded-[13px] border border-[#E0DACB] hover:border-[#CFC8B8] bg-white text-[#3A352C] text-[14.5px] font-semibold cursor-pointer transition-colors">Back to Now</button>
                  </div>
                ) : activeTask.artifact ? (
                  <>
                    {renderEmailArtifact(activeTask)}
                    {(() => {
                      const { blocks, sessionLen } = proposeCalendarBlocks(activeTask!);
                      if (blocks.length === 0) return null;
                      return (
                        <div className="mt-4">
                          <div className={`${monoLabel} mb-3`}>Schedule it</div>
                          <div className="flex flex-wrap gap-2.5">
                            {blocks.map((b, i) => (
                              <button key={i} onClick={() => openGoogleCalendar(activeTask!, b.start, b.end)} className="flex items-center gap-2 bg-[#FCFAF5] hover:bg-[var(--accent-tint)] border border-[#EAE4D7] hover:border-[var(--accent-soft)] rounded-full pl-3 pr-3.5 py-2 text-[13px] font-medium text-[#3A352C] cursor-pointer transition-colors">
                                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="var(--accent)" strokeWidth="1.6"><rect x="2.5" y="3.5" width="13" height="12" rx="2.5" /><path d="M2.5 7h13M6 1.8v3M12 1.8v3" strokeLinecap="round" /></svg>
                                <span className="font-mono">{formatBlockLabel(b.start, b.end)}</span>
                              </button>
                            ))}
                          </div>
                          <p className="text-[11px] text-[#A59E8E] mt-2.5">{blocks.length} × {sessionLen}-min block{blocks.length > 1 ? 's' : ''} · opens Google Calendar, nothing is booked until you save.</p>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <div className="bg-[#FCFAF5] border border-dashed border-[#E0DACB] rounded-[22px] p-7 text-center">
                    <p className="text-[14px] text-[#6B675E] mb-4">Clutch hasn't drafted the first move yet.</p>
                    <button onClick={() => triggerDedecompose(activeTask.id)} className="h-[48px] px-6 rounded-[14px] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[15px] font-semibold cursor-pointer border-none shadow-[0_10px_22px_-10px_var(--accent-strong)] transition-colors">Draft the first move</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===== CAPTURE ===== */}
          {view === 'capture' && (
            <div className="flex-1 flex items-start justify-center px-10 py-12 overflow-y-auto">
              <div className="w-full max-w-[560px]">
                <div className={`${monoLabel} mb-2`}>Capture</div>
                <h2 className="m-0 mb-1.5 text-[28px] font-semibold tracking-[-0.025em]">Drop it here.</h2>
                <p className="m-0 mb-[26px] text-[15px] text-[#6B675E] leading-[1.4]">Paste, drop a file, or speak. I'll pull out what actually matters.</p>

                {isExtracting ? (
                  <div className="pt-1">
                    <div className="flex items-center gap-2.5 mb-5">
                      <span className="w-[9px] h-[9px] rounded-full bg-[var(--accent)] animate-clutch-pulse" />
                      <span className="text-[14.5px] text-[#6B675E]">Reading it — pulling out commitments…</span>
                    </div>
                    <div className="flex flex-col gap-3">
                      {[1, 0.7, 0.45].map((op, i) => (
                        <div key={i} className="h-[78px] rounded-[18px] animate-clutch-shimmer" style={{ opacity: op }} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleCommitmentExtraction}>
                    <div
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className="bg-[#FCFAF5] border border-[#EAE4D7] rounded-[20px] p-5 shadow-[0_1px_2px_rgba(28,27,25,.04)]"
                      style={dragOver ? { borderColor: 'var(--accent)', background: 'var(--accent-tint)' } : undefined}
                    >
                      {selectedFileName ? (
                        <div className="flex items-center justify-between bg-white border border-[#E6E0D3] rounded-[12px] px-3.5 py-3 mb-3">
                          <span className="text-[13.5px] text-[#3A352C] truncate">{selectedFileName}</span>
                          <button type="button" onClick={clearUploadedFile} className="text-[#9D988C] hover:text-[#6B675E] bg-transparent border-none cursor-pointer text-[18px] leading-none">×</button>
                        </div>
                      ) : null}
                      <textarea
                        value={captureText}
                        onChange={e => setCaptureText(e.target.value)}
                        placeholder="Paste a syllabus, an email thread, or a vague worry…"
                        className="w-full h-[120px] border-none outline-none resize-none bg-transparent text-[15.5px] leading-[1.5] text-[#1C1B19] placeholder:text-[#A59E8E]"
                      />
                      <div className="flex gap-2.5 items-center border-t border-[#EFE9DC] pt-3.5 mt-1">
                        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={e => e.target.files && e.target.files[0] && handleFileSelect(e.target.files[0])} />
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="w-[42px] h-[42px] rounded-[12px] border border-[#E6E0D3] hover:border-[#CFC8B8] bg-white cursor-pointer flex items-center justify-center transition-colors">
                          <svg width="19" height="19" viewBox="0 0 19 19" fill="none" stroke="#6B675E" strokeWidth="1.6"><rect x="2.5" y="2.5" width="14" height="14" rx="3" /><circle cx="6.8" cy="6.8" r="1.4" fill="#6B675E" stroke="none" /><path d="M16.5 11.5 12 8l-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                        <div className="flex-1" />
                        <button type="button" onClick={startSpeechCapture} className="h-[42px] px-4 rounded-[12px] border border-[var(--accent-soft)] bg-[var(--accent-tint)] hover:bg-[var(--accent-soft)] cursor-pointer flex items-center gap-2 text-[var(--accent-strong)] text-[14px] font-medium transition-colors" style={isRecordingMic ? { background: 'var(--accent-soft)' } : undefined}>
                          <svg width="15" height="18" viewBox="0 0 15 18" fill="none" stroke="var(--accent-strong)" strokeWidth="1.6"><rect x="5" y="1.5" width="5" height="9" rx="2.5" /><path d="M2 8a5.5 5.5 0 0 0 11 0M7.5 13.5V16.5" strokeLinecap="round" /></svg>
                          {isRecordingMic ? 'Listening…' : 'Speak'}
                        </button>
                      </div>
                    </div>
                    <button type="submit" className="w-full mt-[22px] h-[54px] rounded-[15px] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-[16px] font-semibold cursor-pointer border-none shadow-[0_10px_22px_-10px_var(--accent-strong)] transition-colors">Capture it</button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* ===== FOCUS ===== */}
          {view === 'focus' && (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
              <div className="inline-flex items-center gap-2.5 mb-[34px]">
                <span className="w-[9px] h-[9px] rounded-full bg-[var(--accent)] animate-clutch-breathe" />
                <span className="text-[14.5px] text-[#6B675E]">Clutch is here with you.</span>
              </div>
              <div className={`${monoLabel} mb-2.5`}>Working on</div>
              <div className="text-[21px] font-semibold tracking-[-0.02em] mb-9">{focusTask ? focusTask.title : 'A focus block'}</div>
              <div className="font-mono text-[86px] font-normal tracking-[-0.02em] leading-none text-[#1C1B19] tabular-nums">{fmtClock(focusSeconds)}</div>
              <div className="text-[13.5px] text-[#A59E8E] mt-3.5 mb-[34px]">25-minute block · no notifications</div>
              <div className="flex gap-[11px]">
                <button onClick={() => setFocusRunning(r => !r)} className="h-[48px] px-7 rounded-[13px] border border-[#E0DACB] hover:border-[#CFC8B8] bg-white text-[#3A352C] text-[15px] font-semibold cursor-pointer transition-colors">{focusRunning ? 'Pause' : 'Resume'}</button>
                <button onClick={() => { setView('now'); setFocusSeconds(25 * 60); setFocusRunning(true); }} className="h-[48px] px-6 rounded-[13px] border-none bg-[var(--accent-tint)] hover:bg-[var(--accent-soft)] text-[var(--accent-strong)] text-[15px] font-semibold cursor-pointer transition-colors">End session</button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ============================ PANIC OVERLAY ============================ */}
      {isPanicMode && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-12 overflow-hidden" style={{ background: 'radial-gradient(120% 90% at 50% 30%,#2A2747 0%,#1A1830 55%,#141225 100%)' }}>
          <div className="absolute left-1/2 top-[42%] w-[420px] h-[420px] rounded-full pointer-events-none animate-clutch-glow" style={{ transform: 'translate(-50%,-50%)', background: 'radial-gradient(circle,rgba(232,161,60,.2),transparent 70%)' }} />
          <button onClick={() => setIsPanicMode(false)} className="absolute top-6 right-6 w-9 h-9 rounded-full border-none cursor-pointer flex items-center justify-center" style={{ background: 'rgba(255,255,255,.08)' }} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,.16)')} onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,.08)')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="rgba(243,239,230,.7)" strokeWidth="1.7"><path d="M2 2 12 12M12 2 2 12" strokeLinecap="round" /></svg>
          </button>
          <div className="relative z-[2] text-center max-w-[520px]">
            {highestPanicTask ? (
              <>
                <div className="text-[14px] mb-5" style={{ color: 'rgba(243,239,230,.55)' }}>Just this. Nothing else.</div>
                <h2 className="m-0 mb-4 text-[40px] leading-[1.12] font-semibold tracking-[-0.03em] text-[#F3EFE6]">{highestPanicTask.title}</h2>
                <p className="m-0 mb-[34px] text-[16.5px] leading-[1.5]" style={{ color: 'rgba(243,239,230,.72)' }}>
                  {highestPanicTask.artifact ? 'Send the first move Clutch already drafted. One click.' : 'Take the very first step. Clutch has your back.'}
                </p>
                <div className="flex items-baseline justify-center gap-2.5 mb-[38px]">
                  <span className="font-mono text-[40px] font-normal text-[#E8A13C] tracking-[-0.01em] tabular-nums">{getCountdownText(highestPanicTask.deadline, nowLabel)}</span>
                </div>
                <button
                  onClick={() => { setSelectedId(highestPanicTask.id); setIsPanicMode(false); setView('now'); }}
                  className="w-[340px] max-w-full h-[58px] rounded-[16px] border-none bg-[#F3EFE6] hover:bg-white text-[#1A1830] text-[17px] font-semibold cursor-pointer flex items-center justify-center gap-2.5 mx-auto shadow-[0_16px_40px_-16px_rgba(0,0,0,.6)] transition-colors"
                >
                  Do it now
                  <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#1A1830" strokeWidth="2"><path d="M3 8.5h10M9 4.5l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button onClick={() => setIsPanicMode(false)} className="block mx-auto mt-[13px] bg-transparent border-none cursor-pointer text-[13.5px] py-1.5" style={{ color: 'rgba(243,239,230,.45)' }} onMouseEnter={e => (e.currentTarget.style.color = 'rgba(243,239,230,.7)')} onMouseLeave={e => (e.currentTarget.style.color = 'rgba(243,239,230,.45)')}>I'm okay for now</button>
              </>
            ) : (
              <>
                <h2 className="m-0 mb-4 text-[36px] font-semibold tracking-[-0.03em] text-[#F3EFE6]">Nothing is on fire.</h2>
                <p className="m-0 mb-8 text-[16px]" style={{ color: 'rgba(243,239,230,.72)' }}>You have no pressing deadlines. Breathe.</p>
                <button onClick={() => setIsPanicMode(false)} className="h-[52px] px-7 rounded-[14px] border-none bg-[#F3EFE6] hover:bg-white text-[#1A1830] text-[15px] font-semibold cursor-pointer mx-auto transition-colors">Back to calm</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============================ TOAST ============================ */}
      {statusMessage && (
        <div className="fixed left-1/2 bottom-[34px] z-[60] flex items-center gap-2.5 bg-[#1C1B19] text-[#F3EFE6] px-[18px] py-3 rounded-[14px] shadow-[0_16px_32px_-14px_rgba(0,0,0,.5)] whitespace-nowrap animate-clutch-toast" style={{ transform: 'translateX(-50%)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.9"><path d="M3 8.2 6.3 11.5 13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="text-[13.5px] font-medium">{statusMessage}</span>
        </div>
      )}
      {errorText && (
        <div className="fixed left-1/2 bottom-[34px] z-[60] flex items-center gap-2.5 bg-[#7A2530] text-[#F8E9E6] px-[18px] py-3 rounded-[14px] shadow-[0_16px_32px_-14px_rgba(0,0,0,.5)] max-w-[520px] animate-clutch-toast" style={{ transform: 'translateX(-50%)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.9"><path d="M8 4.5v4M8 11h.01" strokeLinecap="round" /><circle cx="8" cy="8" r="6.5" /></svg>
          <span className="text-[13.5px] font-medium">{errorText}</span>
        </div>
      )}

    </div>
  );
}
