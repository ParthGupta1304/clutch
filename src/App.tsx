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
        '--accent': '#4F46E5',
        '--accent-strong': '#4338CA',
        '--accent-tint': '#EEF2FF',
        '--accent-soft': '#E0E7FF',
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
      setStatusMessage("Momentum locked! Task archived as approved & finalized.");
      
      // Clear auto focus selection so it goes to next highest urgent task
      setSelectedId(null);

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

  return (
    <div
      style={accentStyles}
      className={`min-h-screen flex flex-col font-sans transition-all duration-300 antialiased ${
        isPanicMode
          ? 'bg-[#0B0B12] text-slate-100 selection:bg-rose-500/30 selection:text-white'
          : 'bg-[#E8E3D7] text-[#1C1B19] selection:bg-[var(--accent-soft)] selection:text-[var(--accent-strong)]'
      }`}
    >
      
      {/* Top micro notifications header */}
      <div className="h-[3px] bg-gradient-to-r from-indigo-500 via-rose-500 to-amber-500 w-full" id="brand-indicator"></div>

      {/* Main Bar Navigation */}
      <header className={`border-b border-[#D7D1C2] bg-[#F3EFE6]/90 backdrop-blur-md sticky top-0 z-40 transition-shadow duration-300 shadow-[0_1px_3px_rgba(28,27,25,0.05)] text-[#1C1B19] ${isPanicMode ? 'hidden' : ''}`} id="header-bar">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-[30px] h-[30px] rounded-[9px] bg-[var(--accent)] flex items-center justify-center glow-accent shrink-0" id="logo-block">
              <svg width="12" height="13" viewBox="0 0 12 13" fill="#fff"><path d="M1.5 1.3 11 6.5 1.5 11.7Z"/></svg>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-[#1C1B19] text-lg tracking-tight font-display">Clutch</span>
                <span className="text-[10px] uppercase font-mono tracking-wider font-semibold px-2 py-0.5 bg-[#FCFAF5] border border-[#E6E0D3] rounded text-[#6B675E] shadow-inner">v1.0 Beta</span>
              </div>
              <p className="text-xs text-[#6B675E] font-normal hidden sm:block">"The AI that doesn't remind you — it does the first move."</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* ACCENT SWAPPER PANEL */}
            <div className="flex items-center space-x-1.5 border-r border-[#E6E0D3] pr-3 mr-1">
              <span className="font-mono text-[10px] tracking-wider text-[#9D988C] uppercase hidden md:inline">Accent</span>
              <button 
                onClick={() => {
                  setAccent('indigo');
                  safeSetLocalStorage('clutch_accent', 'indigo');
                }} 
                title="Indigo Theme" 
                className={`w-[26px] h-[26px] rounded-full bg-[#4F46E5] border-none cursor-pointer relative flex items-center justify-center p-0 transition-all ${accent === 'indigo' ? 'ring-2 ring-[#1C1B19] ring-offset-1' : 'opacity-80 hover:opacity-100'}`}
              >
                {accent === 'indigo' && <span className="absolute inset-0 rounded-full border border-white"></span>}
              </button>
              <button 
                onClick={() => {
                  setAccent('teal');
                  safeSetLocalStorage('clutch_accent', 'teal');
                }} 
                title="Teal Theme" 
                className={`w-[26px] h-[26px] rounded-full bg-[#1E7A6C] border-none cursor-pointer relative flex items-center justify-center p-0 transition-all ${accent === 'teal' ? 'ring-2 ring-[#1C1B19] ring-offset-1' : 'opacity-80 hover:opacity-100'}`}
              >
                {accent === 'teal' && <span className="absolute inset-0 rounded-full border border-white"></span>}
              </button>
            </div>

            {/* PANIC MODE TOGGLE */}
            <button
              onClick={() => {
                setIsPanicMode(prev => !prev);
              }}
              className={`text-xs px-3 py-1.5 rounded-md font-bold transition-all duration-300 flex items-center space-x-1.5 shadow-sm cursor-pointer border ${
                isPanicMode
                  ? 'bg-rose-600 hover:bg-rose-500 text-white animate-pulse border-rose-500'
                  : 'bg-[#FCFAF5] hover:bg-[#F6F2E9] text-rose-600 border-[#E6E0D3]'
              }`}
              title="Toggle Big, Distraction-Free Calm Panic View"
              id="btn-panic-mode-toggle"
            >
              <Flame className={`w-3.5 h-3.5 ${isPanicMode ? 'text-amber-300 fill-amber-300' : 'text-rose-600'}`} />
              <span>{isPanicMode ? 'PANIC ACTIVE ON' : 'ENTER PANIC'}</span>
            </button>

            <button
              onClick={resetDemoData}
              className="text-xs text-[#6B675E] hover:text-[#1C1B19] bg-[#FCFAF5] hover:bg-[#F6F2E9] border border-[#E6E0D3] rounded-md px-3 py-1.5 transition-all flex items-center space-x-1.5 font-medium cursor-pointer shadow-sm"
              title="Restore standard trial seed data to start fresh"
              id="btn-restore-samples"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Reset Tutorial Seeds</span>
            </button>

            <a 
              href="#capture-box" 
              className="text-xs bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white font-medium rounded-md px-3 py-1.5 transition-all shadow-sm flex items-center space-x-1.5 cursor-pointer"
              id="btn-go-capture"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Capture New</span>
            </a>

            {currentUser ? (
              <div className="flex items-center space-x-2 border-l border-[#E6E0D3] pl-3">
                {currentUser.photoURL ? (
                  <img
                    src={currentUser.photoURL}
                    alt={currentUser.displayName || 'Me'}
                    className="w-7 h-7 rounded-full border border-[#E6E0D3]"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-[#E6E0D3] flex items-center justify-center text-xs font-bold text-[#1C1B19]">
                    {currentUser.displayName ? currentUser.displayName[0] : 'U'}
                  </div>
                )}
                <div className="hidden lg:block text-left">
                  <p className="text-[10px] font-bold text-[#1C1B19] leading-none">
                    {currentUser.displayName || 'Me'}
                  </p>
                  <p className="text-[9px] text-[#6B675E] font-mono leading-none truncate max-w-[120px]">
                    {currentUser.email}
                  </p>
                </div>
                <button
                  onClick={handleAuthSignOut}
                  className="text-[10px] bg-[#FCFAF5] hover:bg-rose-50 text-rose-600 hover:text-rose-700 border border-[#E6E0D3] rounded px-1.5 py-0.5 transition-all cursor-pointer"
                  title="Sign Out"
                >
                  Logout
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-2 border-l border-[#E6E0D3] pl-3">
                <span className="hidden xl:inline text-[9px] text-[#E8A13C] bg-[#FCFAF5] px-1.5 py-0.5 rounded font-medium border border-[#E6E0D3]">
                  Guest Demo
                </span>
                <button
                  onClick={handleAuthSignIn}
                  className="text-xs bg-[#FCFAF5] hover:bg-[#F6F2E9] text-[#1C1B19] px-3 py-1.5 border border-[#E6E0D3] rounded-md font-medium transition-all shadow-sm flex items-center space-x-1.5 cursor-pointer"
                  title="Sign In with Google to save commitments"
                  id="google-signin-btn"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path
                      fill="#EA4335"
                      d="M12 5.04c1.62 0 3.08.56 4.22 1.66l3.15-3.15C17.45 1.84 14.91 1 12 1 7.24 1 3.2 3.74 1.29 7.72l3.79 2.94C6.01 7.23 8.77 5.04 12 5.04z"
                    />
                    <path
                      fill="#4285F4"
                      d="M23.45 12.3c0-.82-.07-1.61-.21-2.3H12v4.4h6.43c-.28 1.48-1.12 2.74-2.38 3.58l3.7 2.87c2.16-1.99 3.42-4.93 3.42-8.55z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.08 10.66c-.23-.68-.36-1.41-.36-2.16s.13-1.48.36-2.16L1.29 3.4C.47 5.09 0 6.99 0 9s.47 3.91 1.29 5.6l3.79-2.94z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c3.24 0 5.97-1.07 7.96-2.91l-3.7-2.87c-1.03.69-2.34 1.1-3.96 1.1-3.23 0-5.99-2.19-6.97-5.14l-3.79 2.94C3.2 20.26 7.24 23 12 23z"
                    />
                  </svg>
                  <span className="hidden sm:inline">Sign In</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Hero-Alert center if any */}
      {statusMessage && (
        <div className="bg-emerald-950/30 border-b border-emerald-900/40 px-4 py-2.5 text-center text-xs text-emerald-400 font-semibold transition-all shadow-inner" id="notif-success">
          <span className="inline-block mr-1">✓</span> {statusMessage}
        </div>
      )}

      {errorText && (
        <div className="bg-rose-950/30 border-b border-rose-900/40 px-4 py-3 text-center text-xs text-rose-400 font-semibold transition-all flex items-center justify-center space-x-2 shadow-inner" id="notif-error">
          <AlertTriangle className="w-4 h-4 text-rose-500" />
          <span>{errorText}</span>
        </div>
      )}

      {/* Main Full-Scale Canvas */}
      {isPanicMode ? (
        <main className="flex-grow w-full py-8 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto" id="panic-layout">

          {/* Subtle, always-reachable exit (full-screen takeover) */}
          <button
            onClick={() => setIsPanicMode(false)}
            className="fixed top-5 right-5 z-50 text-[11px] font-mono text-slate-400 hover:text-white border border-slate-700/60 hover:border-slate-500 bg-slate-900/40 backdrop-blur-sm rounded-full px-3.5 py-1.5 transition-colors cursor-pointer flex items-center gap-1.5"
            id="panic-exit-top"
          >
            <X className="w-3.5 h-3.5" />
            <span>Exit panic mode</span>
          </button>

          {!highestPanicTask ? (
            /* Calm State: No pending tasks! */
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-8 md:p-16 text-center space-y-6 max-w-2xl mx-auto shadow-xl" id="panic-all-clear">
              <div className="inline-flex p-4 rounded-full bg-emerald-950/30 text-emerald-400 animate-bounce border border-emerald-900/30">
                <Check className="w-10 h-10" />
              </div>
              <div className="space-y-2">
                <h2 className="text-3xl font-extrabold text-white tracking-tight font-display">Breathe Easy.</h2>
                <p className="text-sm text-slate-400 max-w-md mx-auto font-mono">
                  There are absolutely no pending tasks or upcoming deadlines. Your focus arena is completely clear.
                </p>
              </div>
              <button
                onClick={() => setIsPanicMode(false)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs py-2.5 px-6 rounded-lg font-mono transition-all cursor-pointer shadow-[0_0_15px_rgba(99,102,241,0.3)] hover:shadow-[0_0_20px_rgba(99,102,241,0.5)] border border-indigo-500/30"
              >
                Return to Dashboard
              </button>
            </div>
          ) : (
            /* Active Panic Target */
            <div className="space-y-8" id="panic-active-arena">
              
              {/* Calm Banner Header */}
              <div className="bg-rose-950/95 text-rose-100 rounded-2xl py-6 px-6 md:px-8 shadow-xl border border-rose-900 flex flex-col md:flex-row items-center justify-between gap-4 relative overflow-hidden" id="panic-top-status">
                
                {/* Slow ambient pulsing background */}
                <div className="absolute inset-0 bg-gradient-to-r from-rose-900/45 via-red-950/45 to-rose-900/45 pointer-events-none" />

                <div className="space-y-1.5 z-10 text-center md:text-left">
                  <span className="text-[10px] font-bold tracking-widest uppercase text-amber-500 font-mono flex items-center justify-center md:justify-start gap-1.5">
                    <Flame className="w-4 h-4 fill-amber-500 text-amber-500 animate-pulse" />
                    <span>Active Highest-Panic Commitment Focused</span>
                  </span>
                  <h2 className="text-xl md:text-2xl font-extrabold text-white tracking-tight leading-tight select-all">
                    {highestPanicTask.title}
                  </h2>
                  <div className="flex flex-wrap items-center justify-center md:justify-start gap-2.5 text-xs text-rose-200/90 font-mono">
                    <span className="bg-rose-900/65 px-2 text-amber-400 font-mono font-bold border border-rose-800 rounded">
                      🔥 Score: {highestPanicTask.panic_score}
                    </span>
                    <span>•</span>
                    <span>Consequence: <strong className="text-white capitalize">{highestPanicTask.consequence}</strong></span>
                    <span>•</span>
                    <span>Required Effort: {highestPanicTask.effort_minutes}m</span>
                  </div>
                </div>

                {/* Subtile Deadline countdown box */}
                <div className="bg-slate-950/85 border border-rose-900/30 rounded-xl px-5 py-4 text-center min-w-[200px] shadow-inner z-10" id="panic-countdown-box">
                  <div className="text-[10px] uppercase font-bold text-slate-400 font-mono tracking-widest mb-1">
                    COUNTDOWN TO DEADLINE
                  </div>
                  <div className="font-mono text-2xl md:text-3xl font-black text-amber-400 tracking-tight tabular-nums">
                    {getCountdownText(highestPanicTask.deadline, nowLabel)}
                  </div>
                  <div className="text-[9px] text-slate-500 font-mono mt-1">
                    Deadline: {new Date(highestPanicTask.deadline).toLocaleDateString()} at {new Date(highestPanicTask.deadline).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                  </div>
                </div>

              </div>

              {/* Optional Voice Body-Double companion */}
              <BodyDoubleVoice
                activeTaskTitle={highestPanicTask.title}
                activeTaskConsequence={highestPanicTask.consequence}
              />

              {/* CORE FOCUS TARGET (Big, calm, one-button experience) */}
              <div className="bg-slate-900/40 border border-slate-800/80 rounded-3xl p-6 md:p-12 shadow-2xl text-center space-y-8 relative overflow-hidden" id="panic-focus-container">
                
                {isInitializing ? (
                  /* Loading Spinner during automatic generation */
                  <div className="py-12 flex flex-col items-center justify-center space-y-4" id="panic-generating-loader">
                    <RefreshCw className="animate-spin w-10 h-10 text-rose-500" />
                    <div className="space-y-1.5 max-w-sm">
                      <h4 className="font-bold text-slate-200 text-sm font-mono">Formulating Micro-Step Solution...</h4>
                      <p className="text-xs text-slate-400 leading-normal font-mono">
                        Clutch is building the starting actions and drafting the first move artifact to unblock you instantly. Breathe.
                      </p>
                    </div>
                  </div>
                ) : (
                  (() => {
                    const mostImportantAction = highestPanicTask.next_actions?.find(a => !a.completed);
                    
                    if (!mostImportantAction) {
                      /* All actions completed */
                      return (
                        <div className="py-6 space-y-6 max-w-xl mx-auto" id="panic-focus-all-microsteps-done">
                          <div className="inline-flex p-3 rounded-full bg-emerald-950/30 text-emerald-400 border border-emerald-900/30">
                            <CheckCircle2 className="w-12 h-12" />
                          </div>
                          <div className="space-y-2">
                            <h3 className="text-2xl font-extrabold text-white tracking-tight font-display">All Steps Cleared!</h3>
                            <p className="text-xs text-slate-400 leading-relaxed font-mono">
                              You have checked off every unblocking target for this task. Secure the finish line by logging this commitment as fully done.
                            </p>
                          </div>
                          
                          <button
                            onClick={() => handleCompleteTaskInPanic(highestPanicTask.id)}
                            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-base py-4 rounded-2xl shadow-lg hover:shadow-xl transition-all cursor-pointer font-mono flex items-center justify-center gap-3 active:scale-95 duration-150"
                          >
                            <Check className="w-5 h-5 stroke-[3]" />
                            <span>Mark Task Completely Done</span>
                          </button>
                        </div>
                      );
                    }

                    return (
                      <div className="space-y-8" id="panic-active-step-view">
                        
                        {/* CURRENT MICRO-STEP CARD */}
                        <div className="space-y-3 max-w-3xl mx-auto">
                          <span className="text-[11px] font-bold text-rose-400 font-mono tracking-widest uppercase bg-rose-950/40 border border-rose-900/50 px-3 py-1 rounded-full">
                            ✨ Your Single Focus Target
                          </span>
                          <h1 className="text-xl sm:text-2xl md:text-3xl font-extrabold text-white tracking-tight leading-snug font-mono py-2 selection:bg-rose-500/20 select-all">
                            "{mostImportantAction.text}"
                          </h1>
                          <p className="text-xs text-slate-400 font-mono">
                            One goal, zero noise. Ignore the rest, finish this single block.
                          </p>
                        </div>

                        {/* BIG SINGLE ACTION BUTTON */}
                        <div className="flex flex-col items-center justify-center gap-3">
                          <button
                            onClick={() => handleToggleAction(highestPanicTask.id, mostImportantAction.id)}
                            className="group w-full max-w-md bg-rose-600 hover:bg-rose-500 text-white text-base md:text-lg font-bold py-4 px-8 rounded-2xl shadow-[0_12px_24px_rgba(224,36,36,0.15)] hover:shadow-[0_15px_30px_rgba(224,36,36,0.25)] transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 flex items-center justify-center space-x-3 cursor-pointer font-mono"
                          >
                            <CheckCircle2 className="w-5 h-5 stroke-[2.5]" />
                            <span>I Completed This Step!</span>
                          </button>
                          
                          <div className="flex items-center space-x-1.5 text-[10px] text-slate-450 font-mono">
                            <span>Step progress:</span>
                            <strong className="text-white">
                              {highestPanicTask.next_actions?.filter(a => a.completed).length || 0}
                              {' '}/{' '}
                              {highestPanicTask.next_actions?.length || 0}
                            </strong>
                            <span>completed</span>
                          </div>
                        </div>

                        {/* PRE-GENERATED INSTANT ARTIFACT CARD */}
                        {highestPanicTask.artifact && (
                          <div className="border border-slate-800 rounded-2xl bg-slate-950/60 p-6 text-left space-y-4 max-w-4xl mx-auto relative overflow-hidden" id="panic-artifact-box">
                            
                            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                              <div className="space-y-0.5">
                                <span className="text-[10px] font-bold text-amber-500 font-mono uppercase tracking-wider">
                                  PRE-GENERATED ACTION PREVIEW / ARTIFACT
                                </span>
                                <h4 className="text-xs font-bold text-slate-200 font-mono flex items-center gap-1.5 leading-tight">
                                  {highestPanicTask.artifact.type === 'email' ? '✉ Email Draft Preview' : 
                                   highestPanicTask.artifact.type === 'study' ? '📚 Starter Study Kit' : 
                                   highestPanicTask.artifact.type === 'upi' ? '⚡ UPI payment checklist' : '📂 Skeleton Framework'}
                                  : {highestPanicTask.artifact.title}
                                </h4>
                              </div>

                              <button
                                onClick={() => copyToClipboard(highestPanicTask.artifact?.draft || '', 'Action artifact')}
                                className="bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-300 p-1.5 sm:px-3 sm:py-1.5 rounded-lg text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer"
                                title="Copy drafted template to clipboard instantly"
                              >
                                <Copy className="w-3.5 h-3.5 text-slate-400" />
                                <span className="hidden sm:inline">Copy Artifact</span>
                              </button>
                            </div>

                            <div 
                              className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 font-sans text-xs text-slate-300 leading-relaxed overflow-x-auto select-all max-h-72 selection:bg-amber-500/20 prose prose-invert prose-sm max-w-none shadow-inner"
                              dangerouslySetInnerHTML={{ __html: formatMarkdown(highestPanicTask.artifact.draft) }}
                            />

                            {/* Dynamic context fast trigger */}
                            {highestPanicTask.artifact.type === 'email' && (
                              <div className="bg-amber-950/30 border border-amber-900/40 p-4 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-amber-400 font-mono">
                                <span>✉ Authorize Gmail integration below or draft via Mail client in 1 second!</span>
                                <button
                                  onClick={() => setShowGmailModal(true)}
                                  className="self-start sm:self-auto bg-slate-800 hover:bg-slate-700 hover:shadow text-white text-[11px] font-bold py-1.5 px-3.5 rounded transition-all cursor-pointer flex items-center gap-1.5"
                                >
                                  <Mail className="w-3.5 h-3.5 text-amber-400" />
                                  <span>Draft with Gmail</span>
                                </button>
                              </div>
                            )}

                          </div>
                        )}

                      </div>
                    );
                  })()
                )}

              </div>

              {/* Minimal Calm Guidance quotes */}
              <div className="text-center font-mono py-4 text-xs text-slate-400" id="panic-guidance-footer">
                <p>"Bypassing panic is about reducing scale. Do this first step, then evaluate."</p>
                <button
                  onClick={() => setIsPanicMode(false)}
                  className="mt-3 text-[11px] text-slate-500 underline hover:text-slate-900 transition-colors pointer-events-auto cursor-pointer"
                >
                  Return to normal dashboard view
                </button>
              </div>

            </div>
          )}

        </main>
      ) : (
        <div className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-6">
          
          {/* Escalating Nudges Area */}
          {activeNudgeTask && (() => {
            const nextAction = activeNudgeTask.next_actions?.find(a => !a.completed);
            const nextActionText = nextAction ? nextAction.text : "Initialize first-start steps";
            const score = activeNudgeTask.panic_score;

            if (score >= 50 && score < 65) {
              // Level 1: Soft Surfacing
              return (
                <div 
                  className="bg-amber-50/75 border border-amber-200/60 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-[0_2px_10px_-4px_rgba(245,158,11,0.15)] transition-all animate-in fade-in slide-in-from-top duration-300" 
                  id={`nudge-level-1-${activeNudgeTask.id}`}
                >
                  <div className="flex items-center space-x-3">
                    <div className="p-2 rounded-lg bg-amber-100 text-amber-850 flex-shrink-0">
                      <Clock className="w-4 h-4 text-amber-600 animate-pulse" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-amber-950 font-mono tracking-tight">Active Momentum Nudge</h4>
                      <p className="text-xs text-amber-900 mt-0.5">
                        Gently surfacing: Your goal <strong className="font-semibold text-slate-900 select-all">"{activeNudgeTask.title}"</strong> is approaching. Tackle this 2-minute starter option: <span className="font-mono bg-amber-100/50 px-1 py-0.5 rounded text-amber-950 italic">"{nextActionText}"</span>.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                    <button
                      onClick={() => handleNudgeFocus(activeNudgeTask.id)}
                      className="bg-white border border-amber-300 hover:bg-amber-100/30 text-amber-800 text-xs font-bold font-mono px-3 py-1.5 rounded-md shadow-sm transition-colors cursor-pointer w-full sm:w-auto"
                    >
                      Focus Goal
                    </button>
                    <button
                      onClick={() => setDismissedNudgeTaskId(activeNudgeTask.id)}
                      className="p-1.5 hover:bg-amber-100 text-amber-505 hover:text-amber-700 rounded transition-colors cursor-pointer"
                      title="Snooze Nudge"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            } else if (score >= 65 && score < 80) {
              // Level 2: Stronger Nudge (Orange theme)
              return (
                <div 
                  className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-[0_3px_12px_-4px_rgba(234,88,12,0.15)] transition-all animate-in fade-in slide-in-from-top duration-300" 
                  id={`nudge-level-2-${activeNudgeTask.id}`}
                >
                  <div className="flex items-start space-x-3">
                    <div className="p-2 rounded-lg bg-orange-100 text-orange-700 flex-shrink-0 mt-0.5">
                      <AlertOctagon className="w-4 h-4 text-orange-600 animate-bounce" />
                    </div>
                    <div className="space-y-0.5 text-left">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-bold text-orange-955 font-mono uppercase tracking-wider">High Urgency Attention Nudge</h4>
                        <span className="text-[9px] bg-orange-200 text-orange-850 font-bold font-mono px-1.5 py-0.2 rounded uppercase animate-pulse">Actionable</span>
                      </div>
                      <p className="text-xs text-orange-900 leading-relaxed">
                        To avoid consequence <strong className="text-orange-950 font-medium capitalize">"{activeNudgeTask.consequence}"</strong>, start immediately on: <strong className="font-semibold text-slate-800">"{activeNudgeTask.title}"</strong>.
                      </p>
                      <p className="text-[11px] text-orange-850 font-mono">
                        Specific Next Step: <span className="underline decoration-orange-300 font-semibold text-slate-850">"{nextActionText}"</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
                    {nextAction && (
                      <button
                        onClick={() => handleToggleAction(activeNudgeTask.id, nextAction.id)}
                        className="bg-orange-600 hover:bg-orange-550 text-white text-xs font-bold font-mono px-3.5 py-1.5 rounded-md shadow hover:shadow-md transition-all cursor-pointer flex items-center gap-1 w-full sm:w-auto justify-center"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Done</span>
                      </button>
                    )}
                    <button
                      onClick={() => handleNudgeFocus(activeNudgeTask.id)}
                      className="bg-white border border-orange-200 text-orange-800 hover:bg-orange-100/50 text-xs font-bold font-mono px-3 py-1.5 rounded-md shadow-sm transition-colors cursor-pointer w-full sm:w-auto text-center"
                    >
                      Focus
                    </button>
                    <button
                      onClick={() => setDismissedNudgeTaskId(activeNudgeTask.id)}
                      className="p-1.5 hover:bg-orange-100 text-orange-505 hover:text-orange-700 rounded transition-colors cursor-pointer"
                      title="Snooze"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            } else if (score >= 80) {
              // Level 3: Panic Mode Suggestion (Direct action, bold red theme)
              return (
                <div 
                  className="bg-rose-50 border-2 border-rose-500 rounded-xl p-5 flex flex-col md:flex-row items-stretch justify-between gap-5 shadow-[0_4px_20px_-6px_rgba(225,29,72,0.2)] transition-all animate-in zoom-in-95 duration-300 relative overflow-hidden" 
                  id={`nudge-level-3-${activeNudgeTask.id}`}
                >
                  {/* Visual accent left line */}
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-rose-600" />
                  
                  <div className="flex items-start space-x-3.5 z-10 pl-1.5 text-left">
                    <div className="p-2.5 rounded-xl bg-rose-100 text-rose-700 flex-shrink-0 animate-pulse mt-0.5">
                      <Flame className="w-5 h-5 text-rose-600 fill-rose-600" />
                    </div>
                    <div className="space-y-1.5 max-w-xl">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono tracking-widest font-black uppercase text-rose-700">🚨 CRITICAL PROCRASTINATION RISK</span>
                        <span className="text-[9px] bg-rose-650 text-white font-bold font-mono px-1.5 py-0.5 rounded">PASSED THRESHOLD</span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-900 leading-snug">
                        Overcome paralysis on: <strong className="underline decoration-rose-300 font-semibold">"{activeNudgeTask.title}"</strong>
                      </h4>
                      <p className="text-xs text-rose-900 leading-relaxed font-mono">
                        Action required right now: <span className="bg-white/90 border border-rose-200 px-1.5 py-0.5 rounded font-bold text-rose-950 italic">"{nextActionText}"</span>. To avoid cascade consequence of "<span className="capitalize font-bold text-rose-950">{activeNudgeTask.consequence}</span>".
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row md:flex-col lg:flex-row items-stretch sm:items-center md:items-stretch lg:items-center justify-end gap-2.5 min-w-[200px] z-10 pl-1.5">
                    <button
                      onClick={() => {
                        setSelectedId(activeNudgeTask.id);
                        setIsPanicMode(true);
                      }}
                      className="bg-rose-650 hover:bg-rose-550 active:bg-rose-700 text-white text-xs font-mono font-bold px-4 py-2.5 rounded-lg shadow-md hover:shadow-lg transition-all cursor-pointer flex items-center justify-center gap-1.5 uppercase tracking-wider"
                    >
                      <Sparkles className="w-3.5 h-3.5 animate-bounce" />
                      <span>Activate Panic Mode</span>
                    </button>
                    <div className="flex gap-2 w-full">
                      {nextAction && (
                        <button
                          onClick={() => handleToggleAction(activeNudgeTask.id, nextAction.id)}
                          className="bg-white border border-rose-300 hover:bg-rose-100/30 text-rose-800 text-xs font-bold font-mono px-3 py-2 rounded-lg shadow-sm transition-all cursor-pointer flex-grow text-center flex items-center justify-center gap-1"
                        >
                          <Check className="w-3 h-3" />
                          <span>Check Done</span>
                        </button>
                      )}
                      <button
                        onClick={() => setDismissedNudgeTaskId(activeNudgeTask.id)}
                        className="bg-slate-100 hover:bg-slate-200 p-2 text-slate-500 rounded-lg transition-all cursor-pointer flex items-center justify-center"
                        title="Dismiss Nudge"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })()}

          <main className="flex flex-col lg:flex-row gap-8" id="primary-layout">
          
          {/* Left main focus arena (Focused Commitment / Selected Task) */}
        <section className="flex-grow lg:w-3/5 space-y-6" id="focus-arena">
          
          {loading ? (
            <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-12 text-center space-y-3 shadow-xl transition-all flex flex-col items-center justify-center h-80" id="focus-loading">
              <RefreshCw className="animate-spin w-8 h-8 text-amber-500" />
              <p className="text-sm font-medium text-slate-400">Retrieving focused workspace details...</p>
            </div>
          ) : activeTask ? (
            <div className="space-y-6">
              
              {/* Core active card block */}
              <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 md:p-8 shadow-card relative overflow-hidden" id={`focused-card-${activeTask.id}`}>
                
                {/* Urgent glow bar based on score */}
                <div className={`absolute top-0 left-0 right-0 h-[3px] ${
                  (details?.total || 0) >= 75 ? 'bg-rose-500' : (details?.total || 0) >= 50 ? 'bg-amber-500' : 'bg-[#D7D1C2]'
                }`}></div>

                {/* Focus indicator tag */}
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[10px] uppercase font-mono tracking-wider bg-[#FBF1E8] text-[#C26A3E] border border-[#EBD9C9] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#E8A13C] animate-pulse"></span>
                    Active Goal Focus
                  </span>
                  <div className="text-xs text-[#6B675E] font-mono">
                    Src: <span className="text-[#1C1B19] font-medium">{activeTask.source}</span>
                  </div>
                </div>

                {/* Goal Title */}
                <h1 className="text-xl md:text-2xl font-bold text-[#1C1B19] tracking-tight leading-snug font-display select-text animate-fade-in" id="active-task-title">
                  {activeTask.title}
                </h1>

                {/* Scoring metrics & details bar */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-[#E6E0D3]" id="active-task-metrics">
                  
                  {/* Metric: Panic Rating */}
                  <div className="bg-[#F3EFE6] border border-[#E6E0D3] p-3 rounded-lg flex items-center justify-between col-span-2 md:col-span-1" title="Stress calculation based on deadline proximity, estimated effort, and negative consequence levels.">
                    <div>
                      <p className="text-[10px] uppercase font-semibold text-[#6B675E] tracking-wider font-mono">Panic Rating</p>
                      <span className="text-2xl font-black font-mono tracking-tight text-[#1C1B19]">
                        {details?.total}
                        <span className="text-[#6B675E] font-normal text-xs">/100</span>
                      </span>
                    </div>
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold font-mono text-xs ml-2 border ${
                      (details?.total || 0) >= 75 ? 'bg-rose-50 text-rose-600 border-rose-200' : (details?.total || 0) >= 50 ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}>
                      {((details?.total || 0) >= 75) ? 'CRIT' : ((details?.total || 0) >= 50) ? 'WARN' : 'CALM'}
                    </div>
                  </div>

                  {/* Metric: Remaining Time */}
                  <div className="bg-[#F3EFE6] border border-[#E6E0D3] p-3 rounded-lg">
                    <p className="text-[10px] uppercase font-semibold text-[#6B675E] tracking-wider font-mono">Urgency Priority</p>
                    <span className={`text-sm font-semibold truncate block ${formatDeadlineDate(activeTask.deadline).style}`}>
                      {formatDeadlineDate(activeTask.deadline).text}
                    </span>
                    <p className="text-[9px] text-[#6B675E] leading-tight truncate mt-0.5">{details?.urgencyDesc}</p>
                  </div>

                  {/* Metric: Consequence */}
                  <div className="bg-[#F3EFE6] border border-[#E6E0D3] p-3 rounded-lg">
                    <p className="text-[10px] uppercase font-semibold text-[#6B675E] tracking-wider font-mono">Consequence</p>
                    <span className="text-sm font-semibold text-[#1C1B19] capitalize flex items-center gap-1">
                      {activeTask.consequence === 'high' ? (
                        <span className="inline-block w-2 h-2 rounded-full bg-rose-500"></span>
                      ) : activeTask.consequence === 'medium' ? (
                        <span className="inline-block w-2 h-2 rounded-full bg-amber-500"></span>
                      ) : (
                        <span className="inline-block w-2 h-2 rounded-full bg-slate-400"></span>
                      )}
                      {activeTask.consequence} impact
                    </span>
                    <p className="text-[9px] text-[#6B675E] leading-tight mt-0.5">+{details?.consequenceScore} Panic weight</p>
                  </div>

                  {/* Metric: Estimated Effort */}
                  <div className="bg-[#F3EFE6] border border-[#E6E0D3] p-3 rounded-lg">
                    <p className="text-[10px] uppercase font-semibold text-[#6B675E] tracking-wider font-mono">Activation Goal</p>
                    <span className="text-sm font-semibold text-[#1C1B19]">
                      {activeTask.effort_minutes} mins
                    </span>
                    <p className="text-[9px] text-[#6B675E] leading-tight mt-0.5">+{details?.effortScore} Fatigue factor</p>
                  </div>

                </div>

                {/* Score composition drawer explanation */}
                <div className="mt-3 text-[10px] text-[#6B675E] italic text-right font-mono">
                  Panic formulation: Urgency Score ({details?.urgencyScore} pts) + Consequence Severity ({details?.consequenceScore} pts) + Effort Block ({details?.effortScore} pts)
                </div>

              </div>

              {/* Optional Gemini Live Voice Body-Double companion */}
              <BodyDoubleVoice
                activeTaskTitle={activeTask.title}
                activeTaskConsequence={activeTask.consequence}
              />

              {/* SECTION: 3-5 atomic steps next-actions */}
              <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 shadow-card" id="roadmap-segment">
                <div className="flex items-center justify-between mb-4">
                  <div className="space-y-0.5">
                    <h3 className="font-semibold text-[#1C1B19] text-sm tracking-tight font-display">Unblocking Roadmap</h3>
                    <p className="text-xs text-[#6B675E]">Micro-actions mapped to bypass task initiation anxiety.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setShowSearchInput(!showSearchInput);
                        setGatherInfoError(null);
                      }}
                      className="text-xs font-mono font-bold text-[var(--accent-strong)] bg-[var(--accent-soft)] border border-[var(--accent-tint)] hover:opacity-90 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
                      title="Research forms, portals and links with Google Search Grounding"
                    >
                      <Globe className="w-3.5 h-3.5 animate-pulse text-[var(--accent)]" />
                      <span>Gather Info</span>
                    </button>
                    <span className="text-xs font-mono font-medium text-[#6B675E] bg-[#F3EFE6] border border-[#E6E0D3] px-2 py-0.5 rounded">
                      {activeTask.next_actions?.filter(a => a.completed).length || 0} / {activeTask.next_actions?.length || 0} Done
                    </span>
                  </div>
                </div>

                {/* Search input to Gather Info */}
                {showSearchInput && (
                  <div className="bg-[#F3EFE6] border border-[#D7D1C2] rounded-xl p-4 mb-4 space-y-3 font-mono animate-fade-in" id="gather-info-box">
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5">
                        <span className="text-[9px] uppercase font-bold text-[var(--accent-strong)] bg-[var(--accent-soft)] border border-[var(--accent-tint)] px-1.5 py-0.5 rounded leading-none font-mono">
                          Gemini + Google Search Grounding
                        </span>
                        <p className="text-[11px] text-[#6B675E] mt-1 font-sans">
                          Clutch will search the live web to extract portals, forms, schedules, or office-hours directly.
                        </p>
                      </div>
                      <button 
                        onClick={() => setShowSearchInput(false)}
                        className="text-[#6B675E] hover:text-[#1C1B19] p-1 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-[#6B675E] uppercase">Custom Search Query (Optional)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder={`e.g. Find office hours or payment portal for ${activeTask.title}`}
                          value={customSearchQuery}
                          onChange={(e) => setCustomSearchQuery(e.target.value)}
                          className="flex-grow bg-[#FCFAF5] border border-[#E6E0D3] p-2 text-xs rounded font-mono focus:ring-1 focus:ring-[var(--accent)] focus:outline-none text-[#1C1B19]"
                        />
                        <button
                          disabled={isGatheringInfo}
                          onClick={() => handleGatherInfo(activeTask.id)}
                          className="bg-[var(--accent)] hover:bg-[var(--accent-strong)] disabled:bg-[#D7D1C2] text-white font-bold text-xs px-4 rounded-lg flex items-center gap-1.5 transition-all text-center cursor-pointer shadow-sm"
                        >
                          {isGatheringInfo ? (
                            <RefreshCw className="animate-spin w-3.5 h-3.5" />
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5 text-amber-305" />
                              <span>Scout</span>
                            </>
                          )}
                        </button>
                      </div>
                      <p className="text-[9px] text-[#6B675E]">
                        Leave blank to automatically search for official portals matching <strong>"{activeTask.title}"</strong>.
                      </p>
                    </div>

                    {gatherInfoError && (
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5 text-xs text-rose-600 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-600" />
                        <span>{gatherInfoError}</span>
                      </div>
                    )}
                  </div>
                )}

                {isInitializing ? (
                  <div className="py-6 text-center space-y-2" id="roadmap-loading">
                    <RefreshCw className="animate-spin w-5 h-5 text-[var(--accent)] mx-auto" />
                    <p className="text-xs text-[#6B675E] font-medium font-mono">Clutch AI is plotting your micro-actions...</p>
                  </div>
                ) : activeTask.next_actions && activeTask.next_actions.length > 0 ? (
                  <div className="space-y-2.5" id="roadmap-list">
                    {activeTask.next_actions.map((action) => {
                      if (action.is_cited) {
                        return (
                          <div
                            key={action.id}
                            className={`w-full flex flex-col p-4 rounded-xl border transition-all text-left ${
                              action.completed
                                ? 'bg-[#FCFAF5] border-emerald-200 text-[#6B675E]'
                                : 'bg-[#FCFAF5] border-[#E6E0D3] hover:border-[#D7D1C2] text-[#1C1B19]'
                            }`}
                            id={`action-item-${action.id}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3">
                                <button
                                  onClick={() => handleToggleAction(activeTask.id, action.id)}
                                  className="mt-0.5 shrink-0 cursor-pointer"
                                  title="Check action"
                                >
                                  {action.completed ? (
                                    <div className="bg-emerald-550 text-white rounded p-0.5">
                                      <Check className="w-3.5 h-3.5" />
                                    </div>
                                  ) : (
                                    <div className="w-[18px] h-[18px] border-2 border-[var(--accent)] rounded hover:bg-[var(--accent-soft)] transition-all"></div>
                                  )}
                                </button>
                                <div className="space-y-1">
                                  <span className="text-[9px] font-mono tracking-wider text-[var(--accent-strong)] bg-[var(--accent-soft)] border border-[var(--accent-tint)] px-1.5 py-0.5 rounded font-bold uppercase">
                                    🔍 GATHERED INFO CITATION
                                  </span>
                                  <h4 className={`text-xs font-bold leading-relaxed font-mono ${action.completed ? 'line-through text-[#9D988C]' : 'text-[#1C1B19]'}`}>
                                    {action.text}
                                  </h4>
                                </div>
                              </div>

                              {action.url && (
                                <a
                                  href={action.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent-tint)] hover:opacity-90 text-[var(--accent-strong)] transition-all cursor-pointer font-bold font-mono text-[10px] flex items-center gap-1 shrink-0"
                                  id={`link-visit-${action.id}`}
                                >
                                  <span>Portal</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </div>

                            {/* Source and details breakdown */}
                            <div className="mt-2.5 text-xs bg-[#F3EFE6] border border-[#E6E0D3] rounded-lg p-3 space-y-1.5 font-mono">
                              <div className="flex items-center justify-between text-[9px] text-[#6B675E] border-b border-[#E6E0D3] pb-1">
                                <span>Source: <strong className="text-[#1C1B19]">{action.source_title || 'Web Search'}</strong></span>
                                {action.url && <span className="text-[9px] text-[var(--accent-strong)] truncate max-w-[200px]">{action.url}</span>}
                              </div>
                              <p className="text-[11px] text-[#6B675E] leading-relaxed font-medium">
                                {action.source_snippet}
                              </p>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <button
                          key={action.id}
                          onClick={() => handleToggleAction(activeTask.id, action.id)}
                          className={`w-full flex items-start text-left px-4 py-3 rounded-lg border transition-all cursor-pointer ${
                            action.completed
                              ? 'bg-emerald-50/60 border-emerald-200 text-[#6B675E] line-through'
                              : 'bg-[#FCFAF5] border-[#E6E0D3] hover:border-[#D7D1C2] hover:bg-[#F3EFE6] text-[#1C1B19]'
                          }`}
                          id={`action-item-${action.id}`}
                        >
                          <div className="mt-0.5 mr-3 flex-shrink-0">
                            {action.completed ? (
                              <div className="bg-emerald-550 text-white rounded p-0.5">
                                <Check className="w-3.5 h-3.5" />
                              </div>
                            ) : (
                              <div className="w-[18px] h-[18px] border-2 border-[#C2BAA8] hover:border-[#9D988C] rounded transition-all"></div>
                            )}
                          </div>
                          <span className="text-xs font-medium leading-relaxed font-mono">{action.text}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-6 border border-dashed border-slate-800 rounded-lg text-center space-y-3 animate-fade-in" id="roadmap-empty">
                    <p className="text-xs text-slate-400 font-mono">Unblocking steps are not analyzed for this commitment yet.</p>
                    <button
                      onClick={() => triggerDedecompose(activeTask.id)}
                      className="text-xs bg-slate-900 hover:bg-slate-850 text-slate-300 border border-slate-800 rounded px-3 py-1.5 font-medium transition-all inline-flex items-center space-x-1.5 cursor-pointer shadow-sm"
                      id="btn-trigger-roadmap"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span>Analyze with Clutch Agent</span>
                    </button>
                  </div>
                )}
              </div>

              {/* SECTION: First-move Artifact (Core feature) */}
              <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 shadow-card relative overflow-hidden" id="first-move-segment">
                
                <div className="flex items-center justify-between mb-4">
                  <div className="space-y-0.5">
                    <div className="flex items-center space-x-1.5">
                      <h3 className="font-bold text-[#1C1B19] text-sm tracking-tight font-display">The First Move</h3>
                      <span className="text-[9px] uppercase font-mono tracking-wider font-bold bg-[var(--accent-tint)] text-[var(--accent-strong)] border border-[var(--accent-soft)] px-1.5 py-0.5 rounded leading-none">Auto-Initiated</span>
                    </div>
                    <p className="text-xs text-[#6B675E]">Approve this generated boilerplate, email, study template, or outline helper to build starting momentum.</p>
                  </div>

                  {activeTask.artifact && (
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => copyToClipboard(activeTask.artifact?.draft || '', 'Move layout')}
                        className="p-1.5 text-[#6B675E] hover:text-[#1C1B19] bg-[#FCFAF5] border border-[#E6E0D3] hover:bg-[#F3EFE6] rounded-md transition-all cursor-pointer"
                        title="Copy text to clipboard"
                        id="btn-copy-draft"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => {
                          setIsEditingMove(!isEditingMove);
                          setEditDraftValue(activeTask.artifact?.draft || '');
                        }}
                        className={`p-1.5 border rounded-md transition-all text-xs flex items-center space-x-1.5 cursor-pointer ${
                          isEditingMove
                            ? 'bg-rose-50 border-rose-200 text-rose-600 hover:bg-rose-100/60'
                            : 'bg-[#FCFAF5] border-[#E6E0D3] text-[#6B675E] hover:text-[#1C1B19] hover:bg-[#F3EFE6]'
                        }`}
                        title={isEditingMove ? "Cancel draft edits" : "Edit template draft"}
                        id="btn-toggle-edit-draft"
                      >
                        {isEditingMove ? <X className="w-3.5 h-3.5" /> : <Edit2 className="w-3.5 h-3.5" />}
                        <span className="hidden md:inline">{isEditingMove ? 'Cancel' : 'Edit Draft'}</span>
                      </button>
                    </div>
                  )}
                </div>

                {isInitializing ? (
                  <div className="p-12 text-center space-y-3" id="first-move-loading">
                    <RefreshCw className="animate-spin w-6 h-6 text-[var(--accent)] mx-auto" />
                    <p className="text-xs font-mono text-[#6B675E] font-medium">Clutch is drafting your unblocking tool kit...</p>
                    <div className="w-1/2 bg-[#F3EFE6] h-1.5 rounded-full mx-auto overflow-hidden border border-[#E6E0D3]">
                      <div className="bg-[var(--accent)] h-full rounded-full animate-pulse w-3/4"></div>
                    </div>
                  </div>
                ) : activeTask.artifact ? (
                  <div className="space-y-4">
                    
                    {/* Draft Banner Name */}
                    <div className="bg-[#F3EFE6] px-4 py-2.5 border-l-4 border-[var(--accent)] rounded-r-lg border border-[#E6E0D3] border-l-0 flex items-center justify-between shadow-sm">
                      <span className="text-xs font-mono font-bold text-[#1C1B19] flex items-center gap-1.5">
                        {activeTask.artifact.type === 'email' ? '✉ Email Draft' : 
                         activeTask.artifact.type === 'study' ? '📚 Learning Pack' : 
                         activeTask.artifact.type === 'upi' ? '⚡ UPI bill assistant' : '📂 Outline Skeleton'}
                        : {activeTask.artifact.title}
                      </span>
                      {activeTask.artifact.approved && (
                        <span className="text-[10px] font-mono font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                          ✓ Completed & Approved
                        </span>
                      )}
                    </div>

                    {/* Inline Editor or Render Block */}
                    {isEditingMove ? (
                      <div className="space-y-3 bg-[#FBF1E8] border border-[#EBD9C9] p-4 rounded-lg" id="draft-editor-box">
                        <textarea
                          value={editDraftValue}
                          onChange={(e) => setEditDraftValue(e.target.value)}
                          className="w-full h-80 bg-[#FCFAF5] border border-[#E6E0D3] rounded p-3 font-mono text-xs text-[#1C1B19] focus:ring-1 focus:ring-[var(--accent)] focus:outline-none"
                        />
                        <div className="flex justify-end space-x-2">
                          <button
                            onClick={() => setIsEditingMove(false)}
                            className="bg-[#FCFAF5] hover:bg-[#F6F2E9] border border-[#E6E0D3] text-[#6B675E] rounded px-3 py-1.5 text-xs transition-all cursor-pointer"
                          >
                            Discard
                          </button>
                          <button
                            onClick={() => handleSaveDraftEdit(activeTask.id)}
                            className="bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white rounded px-4 py-1.5 text-xs font-semibold shadow transition-all cursor-pointer"
                          >
                            Save Draft
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div id="draft-render-panel">
                        <div 
                          className="bg-[#F3EFE6] border border-[#E6E0D3] rounded-lg p-5 font-sans text-xs text-[#1C1B19] leading-relaxed overflow-x-auto select-all selection:bg-[var(--accent-soft)] selection:text-[var(--accent-strong)] prose prose-sm max-w-none shadow-inner"
                          dangerouslySetInnerHTML={{ __html: formatMarkdown(activeTask.artifact.draft) }}
                        />

                        {/* Approve-first Action Row */}
                        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#F3EFE6] p-4 rounded-lg border border-[#E6E0D3] shadow-sm">
                          <div className="flex items-center space-x-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                            <p className="text-[11px] text-[#6B675E] font-medium">Ready to get started? Review and approve the first move.</p>
                          </div>
                          
                          <button
                            onClick={() => {
                              if (activeTask.artifact?.type === 'email') {
                                  setShowGmailModal(true);
                              } else {
                                  handleApproveMove(activeTask.id);
                              }
                            }}
                            className={`w-full sm:w-auto px-5 py-2 text-xs font-bold font-mono tracking-wide shadow flex items-center justify-center space-x-1.5 rounded transition-all cursor-pointer ${
                              activeTask.status === 'completed'
                                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                                : 'bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white'
                            }`}
                            id="btn-approve-action"
                          >
                            {activeTask.artifact?.type === 'email' ? (
                              <>
                                <Mail className="w-4 h-4 text-white" />
                                <span>Approve & Create Draft</span>
                              </>
                            ) : (
                              <>
                                <CheckCircle2 className="w-4 h-4" />
                                <span>{activeTask.status === 'completed' ? 'Approved (Restore status)' : 'Approve & Mark Done'}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                  </div>
                ) : (
                  <div className="p-6 border border-dashed border-[#E6E0D3] bg-[#FCFAF5] rounded-lg text-center space-y-3" id="first-move-empty">
                    <p className="text-xs text-[#6B675E] font-mono">Unblocking draft is waiting for roadmap analysis.</p>
                    <button
                      onClick={() => triggerDedecompose(activeTask.id)}
                      className="text-xs bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white border border-[var(--accent-tint)] rounded px-4 py-2 font-bold font-mono tracking-wide transition-all inline-flex items-center space-x-1.5 shadow cursor-pointer"
                      id="btn-trigger-firstmove"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                      <span>Draft First Move Blueprint</span>
                    </button>
                  </div>
                )}

              </div>

              {/* SCHEDULE: propose right-sized focus blocks (approve-first) */}
              {activeTask && activeTask.status !== 'completed' && (() => {
                const { blocks, sessionLen } = proposeCalendarBlocks(activeTask);
                if (blocks.length === 0) return null;
                return (
                  <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 shadow-card mt-6" id="schedule-segment">
                    <div className="flex items-start justify-between border-b border-[#E6E0D3] pb-4 mb-4">
                      <div className="space-y-1">
                        <h3 className="font-bold text-[#1C1B19] text-sm tracking-tight font-display flex items-center gap-2">
                          <span className="bg-[var(--accent-tint)] text-[var(--accent-strong)] border border-[var(--accent-soft)] p-1 rounded flex items-center justify-center"><CalendarClock className="w-4 h-4" /></span>
                          <span>Schedule focus blocks</span>
                        </h3>
                        <p className="text-xs text-[#6B675E]">
                          Clutch right-sized {blocks.length} {sessionLen}-min block{blocks.length > 1 ? 's' : ''} before your deadline. Approve any to add it to Google Calendar.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      {blocks.map((b, i) => (
                        <button
                          key={i}
                          onClick={() => openGoogleCalendar(activeTask, b.start, b.end)}
                          className="group flex items-center gap-2 bg-[#F3EFE6] hover:bg-[var(--accent-tint)] border border-[#E6E0D3] hover:border-[var(--accent-soft)] rounded-full pl-3 pr-3.5 py-2 text-xs font-medium text-[#1C1B19] transition-all cursor-pointer shadow-sm"
                          title="Open a pre-filled Google Calendar event"
                        >
                          <CalendarPlus className="w-3.5 h-3.5 text-[var(--accent)]" />
                          <span className="font-mono">{formatBlockLabel(b.start, b.end)}</span>
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-[#9D988C] mt-3 font-mono">
                      Opens a pre-filled Google Calendar event in a new tab — nothing is added until you save it.
                    </p>
                  </div>
                );
              })()}

              {/* STUDY PACK INTERACTIVE PANEL */}
              {activeTask && (activeTask.artifact?.type === 'study' || activeTask.title.toLowerCase().match(/(study|exam|assignment|syllabus|test|quiz|lecture|notes|revision|read)/i)) && (
                <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 shadow-card mt-6 animate-fade-in" id="study-pack-segment">
                  <div className="flex items-start justify-between border-b border-[#E6E0D3] pb-4 mb-4">
                    <div className="space-y-1">
                      <h3 className="font-bold text-[#1C1B19] text-sm tracking-tight font-display flex items-center gap-2">
                        <span className="bg-[var(--accent-tint)] text-[var(--accent-strong)] border border-[var(--accent-soft)] p-1 rounded">📚</span>
                        <span>Interactive Adaptive Study Pack</span>
                      </h3>
                      <p className="text-xs text-[#6B675E]">Practice predictive questions and train memorization via flashcards.</p>
                    </div>
                    {activeTask.study_pack && (
                      <button
                        onClick={() => {
                          if (confirm("Regenerate interactive study pack? This will clear the current questions/cards.")) {
                            setStudyFileBase64(null);
                            setStudyFileName('');
                            setCommitments(prev => prev.map(c => c.id === activeTask.id ? { ...c, study_pack: undefined } : c));
                          }
                        }}
                        className="text-[10px] font-mono hover:underline font-bold text-rose-600 transition-all focus:outline-none cursor-pointer"
                      >
                        Reset / Re-upload
                      </button>
                    )}
                  </div>

                  {studyPackError && (
                    <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-xs text-rose-700 flex items-start gap-2 mb-4">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{studyPackError}</span>
                    </div>
                  )}

                  {!activeTask.study_pack ? (
                    <div className="space-y-4">
                      <p className="text-[11px] text-[#6B675E] leading-relaxed font-mono bg-[#FCFAF5] p-3 rounded-lg border border-[#E6E0D3]">
                        <strong>Self-Study Acceleration:</strong> Upload handwritten notes, presentation slides, or course syllabi (as PNG/JPG or PDF). Clutch will predict the 5 most likely exam/practice questions with explanations, and design 5 flashcards for active recall memorization.
                      </p>

                      {/* Notes/Syllabus file uploader */}
                      <div 
                        onDragOver={(e) => { e.preventDefault(); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                            handleStudyFileSelect(e.dataTransfer.files[0]);
                          }
                        }}
                        onClick={() => studyFileInputRef.current?.click()}
                        className="border-2 border-dashed border-[#DDD6C6] hover:border-[var(--accent)] rounded-xl p-8 text-center cursor-pointer transition-all bg-[#FCFAF5] hover:bg-[#F3EFE6] relative group"
                      >
                        <input 
                          type="file" 
                          ref={studyFileInputRef}
                          onChange={(e) => e.target.files && handleStudyFileSelect(e.target.files[0])}
                          className="hidden"
                          accept="image/*,application/pdf"
                        />
                        <UploadCloud className="w-8 h-8 text-[#6B675E] mx-auto group-hover:text-[var(--accent)] transition-colors mb-2" />
                        {studyFileName ? (
                          <div className="space-y-1">
                            <p className="text-xs font-bold text-[#1C1B19] font-mono break-all">{studyFileName}</p>
                            <p className="text-[10px] text-emerald-600 font-mono font-bold flex items-center justify-center gap-1">
                              <Check className="w-3.5 h-3.5" /> File Selected! Ready to compile.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <span className="text-xs text-[#1C1B19] font-bold font-mono">Drag & Drop notes, slides, or syllabus</span>
                            <p className="text-[10px] text-[#6B675E] font-mono max-w-[320px] mx-auto mt-1">Accepts PNG/JPG screenshots or PDF syllabus modules (Up to 10MB).</p>
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => handleGenerateStudyPack(activeTask.id)}
                        disabled={isGeneratingStudyPack || (!studyFileBase64 && !imageBase64)}
                        className="w-full bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-xs font-semibold py-2.5 rounded-lg font-mono flex items-center justify-center gap-2 hover:shadow transition-colors cursor-pointer disabled:bg-[#DDD6C6] disabled:text-[#9D988C] disabled:cursor-not-allowed"
                      >
                        {isGeneratingStudyPack ? (
                          <>
                            <RefreshCw className="animate-spin w-4 h-4" />
                            <span>Compiling study pack with Gemini ...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4 text-amber-305 animate-pulse" />
                            <span>Compile Multimodal Study Pack</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {/* Tabs selector */}
                      <div className="flex border-b border-[#E6E0D3] pb-[1px] font-mono">
                        <button
                          onClick={() => setActiveStudyTab('questions')}
                          className={`flex-1 pb-2 text-xs font-bold transition-colors cursor-pointer border-b-2 text-center ${
                            activeStudyTab === 'questions' 
                              ? 'border-[var(--accent)] text-[#1C1B19]' 
                              : 'border-transparent text-[#6B675E] hover:text-[#1C1B19]'
                          }`}
                        >
                          📋 Test Questions (5)
                        </button>
                        <button
                          onClick={() => {
                            setActiveStudyTab('flashcards');
                            setIsCardFlipped(false);
                          }}
                          className={`flex-1 pb-2 text-xs font-bold transition-colors cursor-pointer border-b-2 text-center ${
                            activeStudyTab === 'flashcards' 
                              ? 'border-[var(--accent)] text-[#1C1B19]' 
                              : 'border-transparent text-[#6B675E] hover:text-[#1C1B19]'
                          }`}
                        >
                          🎴 Recall Flashcards (5)
                        </button>
                      </div>

                      {activeStudyTab === 'questions' ? (
                        <div className="space-y-4">
                          {activeTask.study_pack.questions.map((q, idx) => (
                            <div key={q.id || idx} className="border border-[#E6E0D3] rounded-lg p-4 bg-[#FCFAF5] hover:bg-[#F3EFE6] transition-colors">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex gap-2">
                                  <span className="text-xs font-bold text-[#6B675E] font-mono mt-0.5">#{idx + 1}</span>
                                  <h4 className="text-xs font-bold text-[#1C1B19] leading-relaxed font-mono">{q.question}</h4>
                                </div>
                                <button
                                  onClick={() => setRevealedQuestionIds(prev => ({ ...prev, [q.id || idx]: !prev[q.id || idx] }))}
                                  className="p-1 rounded text-[#6B675E] hover:text-[#1C1B19] hover:bg-[#E6E0D3]/30 transition-colors flex items-center gap-1 cursor-pointer font-mono text-[10px]"
                                  title="Toggle explanation"
                                >
                                  {revealedQuestionIds[q.id || idx] ? (
                                    <>
                                      <X className="w-3.5 h-3.5 text-rose-500" />
                                      <span className="font-bold text-rose-500">Hide</span>
                                    </>
                                  ) : (
                                    <>
                                      <Eye className="w-3.5 h-3.5 text-[var(--accent)]" />
                                      <span className="font-bold text-[var(--accent)]">Answer</span>
                                    </>
                                  )}
                                </button>
                              </div>

                              {revealedQuestionIds[q.id || idx] && (
                                <div className="mt-3 pt-3 border-t border-[#E6E0D3] text-xs text-[#1C1B19] leading-relaxed bg-[#FBF1E8] p-3.5 rounded border border-[#EBD9C9]">
                                  <div className="text-[10px] font-mono tracking-wider text-[var(--accent-strong)] uppercase font-bold mb-1.5 flex items-center gap-1">
                                    <Check className="w-3 h-3 text-[var(--accent-strong)]" />
                                    <span>Predictive Solution</span>
                                  </div>
                                  <p className="whitespace-pre-line font-medium leading-relaxed text-[#1C1B19] font-mono">{q.answer}</p>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="space-y-4 pt-1">
                          
                          {/* 3D Flipping Card */}
                          <div className="group [perspective:1000px] max-w-md mx-auto w-full">
                            <div 
                              onClick={() => setIsCardFlipped(!isCardFlipped)}
                              className={`relative w-full h-[190px] transition-transform duration-500 [transform-style:preserve-3d] cursor-pointer ${isCardFlipped ? '[transform:rotateY(180deg)]' : ''}`}
                            >
                              {/* Front Side */}
                              <div className="absolute inset-0 w-full h-full bg-[#FCFAF5] border border-[#DDD6C6] rounded-2xl p-5 flex flex-col justify-between [backface-visibility:hidden] shadow-sm select-none">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono tracking-wider text-[#6B675E] uppercase font-bold">Front (Concept Term)</span>
                                  <span className="text-xs font-mono font-bold text-[#1C1B19] bg-[#F3EFE6] border border-[#E6E0D3] px-2 leading-tight py-0.5 rounded-full">Card {currentCardIndex + 1}/5</span>
                                </div>
                                <div className="text-center py-2 flex items-center justify-center grow">
                                  <p className="text-xs font-bold text-[#1C1B19] tracking-tight leading-snug font-mono select-all">{activeTask.study_pack.flashcards[currentCardIndex]?.front}</p>
                                </div>
                                <div className="text-center text-[10px] text-[#6B675E] font-mono flex items-center justify-center gap-1">
                                  <Sparkles className="w-3 h-3 text-[var(--accent)] animate-pulse" />
                                  <span>Click anywhere to flip and reveal</span>
                                </div>
                              </div>

                              {/* Back Side */}
                              <div className="absolute inset-0 w-full h-full bg-[#F3EFE6] border border-[#DDD6C6] rounded-2xl p-5 flex flex-col justify-between [backface-visibility:hidden] [transform:rotateY(180deg)] shadow-sm select-none text-[#1C1B19] animate-fade-in">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-mono tracking-wider text-[#6B675E] uppercase font-bold">Back (Active Recall Detail)</span>
                                  <span className="text-xs font-mono font-bold text-[var(--accent-strong)] bg-[var(--accent-soft)] border border-[var(--accent-tint)] px-2 leading-tight py-0.5 rounded-full font-mono">Definition</span>
                                </div>
                                <div className="text-center py-2 flex items-center justify-center grow overflow-y-auto max-h-[90px] px-1 font-mono">
                                  <p className="text-[11px] text-[#1C1B19] font-medium leading-relaxed">{activeTask.study_pack.flashcards[currentCardIndex]?.back}</p>
                                </div>
                                <div className="text-center text-[10px] text-[#6B675E] font-mono">
                                  <span>Click to flip back</span>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Controls */}
                          <div className="flex items-center justify-between max-w-sm mx-auto mt-4 font-mono">
                            <button
                              disabled={currentCardIndex === 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                setIsCardFlipped(false);
                                setTimeout(() => setCurrentCardIndex(prev => prev - 1), 150);
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-[#1C1B19] bg-[#FCFAF5] border border-[#DDD6C6] hover:bg-[#F3EFE6] rounded disabled:opacity-40 disabled:hover:bg-[#FCFAF5] transition-all cursor-pointer"
                            >
                              ← Prev Card
                            </button>
                            
                            <span className="text-xs text-[#6B675E] font-semibold font-mono">
                              {currentCardIndex + 1} / 5
                            </span>

                            <button
                              disabled={currentCardIndex === 4}
                              onClick={(e) => {
                                e.stopPropagation();
                                setIsCardFlipped(false);
                                setTimeout(() => setCurrentCardIndex(prev => prev + 1), 150);
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-[#1C1B19] bg-[#FCFAF5] border border-[#DDD6C6] hover:bg-[#F3EFE6] rounded disabled:opacity-40 disabled:hover:bg-[#FCFAF5] transition-all cursor-pointer"
                            >
                              Next Card →
                            </button>
                          </div>

                          {/* Progress Dots */}
                          <div className="flex items-center justify-center space-x-1.5 mt-2">
                            {[0, 1, 2, 3, 4].map((dotIdx) => (
                              <button
                                key={dotIdx}
                                onClick={() => {
                                  setIsCardFlipped(false);
                                  setTimeout(() => setCurrentCardIndex(dotIdx), 150);
                                }}
                                className={`w-1.5 h-1.5 rounded-full transition-all cursor-pointer ${
                                  dotIdx === currentCardIndex 
                                    ? 'bg-[var(--accent)] scale-125' 
                                    : 'bg-slate-800'
                                  }`}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* AGENT MODE INTERACTIVE COMPONENT */}
              {activeTask && (
                <div className="bg-[#FCFAF5] border border-[#E6E0D3] rounded-2xl p-6 shadow-card mt-6 animate-fade-in" id="agent-mode-segment">
                  <div className="flex items-start justify-between border-b border-[#E6E0D3] pb-4 mb-4">
                    <div className="space-y-1">
                      <h3 className="font-bold text-[#1C1B19] text-sm tracking-tight font-display flex items-center gap-2">
                        <span className="bg-[var(--accent-tint)] text-[var(--accent-strong)] border border-[var(--accent-soft)] p-1 rounded"><Cpu className="w-4 h-4" /></span>
                        <span>Expert Agent Mode: Sandbox Solver</span>
                      </h3>
                      <p className="text-xs text-[#6B675E]">Run multi-step automated searches, code trials, and site reading inside Google Cloud.</p>
                    </div>
                    {activeTask.agent_state && (
                      <button
                        onClick={() => handleResetAgent(activeTask.id)}
                        className="text-[10px] font-mono hover:underline font-bold text-rose-600 transition-all focus:outline-none cursor-pointer"
                      >
                        Reset / Discard
                      </button>
                    )}
                  </div>

                  {agentError && (
                    <div className="bg-rose-50 border border-rose-100 rounded-lg p-3 text-xs text-rose-700 flex items-start gap-2 mb-4">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{agentError}</span>
                    </div>
                  )}

                  {!activeTask.agent_state || activeTask.agent_state.status === 'idle' ? (
                    <div className="space-y-4">
                      <p className="text-[11px] leading-relaxed font-mono bg-[#FCFAF5] p-3 rounded-lg border border-[#E6E0D3] text-[#6B675E]">
                        <strong>Complex Problem Solving:</strong> Some tasks need real information, link checks, calculations, or portal forms. Let the Expert Agent draft a multi-step plan, research utilizing Google Search Grounding, write Python scripts to test calculations, browse URLs, and format custom solutions.
                      </p>

                      <button
                        onClick={() => handleGenerateAgentPlan(activeTask.id)}
                        disabled={isPlanningAgent}
                        className="w-full bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-xs font-semibold py-2.5 rounded-lg font-mono flex items-center justify-center gap-2 hover:shadow transition-colors cursor-pointer disabled:bg-[#DDD6C6] disabled:text-[#9D988C] disabled:cursor-not-allowed"
                      >
                        {isPlanningAgent ? (
                          <>
                            <RefreshCw className="animate-spin w-4 h-4" />
                            <span>Drafting Expert Action Plan...</span>
                          </>
                        ) : (
                          <>
                            <Wand2 className="w-4 h-4 text-amber-305 animate-pulse" />
                            <span>Draft Multi-Step Agent Plan</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Show current status banner */}
                      <div className="flex items-center justify-between text-xs font-mono border-b border-[#E6E0D3] pb-2">
                        <span className="text-[#6B675E]">Agent Status:</span>
                        <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] uppercase tracking-wide ${
                          activeTask.agent_state.status === 'planning' ? 'bg-amber-100 text-amber-800' :
                          activeTask.agent_state.status === 'running' ? 'bg-[var(--accent-soft)] text-[var(--accent-strong)] animate-pulse' :
                          activeTask.agent_state.status === 'completed' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' :
                          'bg-rose-50 text-rose-800 border border-rose-200'
                        }`}>
                          ● {activeTask.agent_state.status}
                        </span>
                      </div>

                      {/* Display plan if generated or running */}
                      {activeTask.agent_state.plan && activeTask.agent_state.plan.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold font-mono text-[#6B675E] uppercase tracking-widest">Expert Plan Blueprint:</p>
                          <div className="space-y-1.5 bg-[#F3EFE6]/50 p-3 rounded-lg border border-[#E6E0D3] font-mono">
                            {activeTask.agent_state.plan.map((step) => (
                              <div key={step.step_number} className="text-xs text-[#1C1B19] flex items-start gap-2">
                                <span className="text-[10px] font-bold bg-[#E6E0D3] text-[#1C1B19] px-1.5 py-0.5 rounded shrink-0">
                                  Step {step.step_number}
                                </span>
                                <div className="space-y-0.5 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-bold text-[#1C1B19]">{step.step_title}</span>
                                    <span className={`text-[9px] font-bold px-1.5 rounded-full ${
                                      step.tool_choice === 'search' ? 'bg-blue-50 text-blue-700 border border-blue-250' :
                                      step.tool_choice === 'browse' ? 'bg-purple-50 text-purple-700 border border-purple-250' :
                                      'bg-emerald-50 text-emerald-700 border border-emerald-250'
                                    }`}>
                                      {step.tool_choice === 'search' ? '🔍 search grounding' :
                                       step.tool_choice === 'browse' ? '🌐 URL browser' :
                                       '✍️ sandbox generator'}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-[#6B675E] leading-normal">{step.description}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Execution Terminal steps log */}
                      {((activeTask.agent_state.steps_log && activeTask.agent_state.steps_log.length > 0) || activeTask.agent_state.status === 'running') && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold font-mono text-[#6B675E] uppercase tracking-widest">Agent Live Sandbox log:</p>
                          <div className="bg-[#1C1B19] text-[#FCFAF5] font-mono text-[11px] p-4 rounded-xl border border-[#D7D1C2] space-y-2.5 max-h-60 overflow-y-auto shadow-inner leading-normal">
                            
                            {activeTask.agent_state.steps_log?.map((log, idx) => (
                              <div key={idx} className="space-y-1 block border-b border-[#2C2A29] pb-2">
                                <div className="flex items-center gap-1.5">
                                  <span className={`w-2 h-2 rounded-full ring-4 ${
                                    log.type === 'thought' ? 'bg-yellow-400 ring-yellow-950/20' :
                                    log.type === 'search' ? 'bg-blue-500 ring-blue-950/20' :
                                    log.type === 'code_execution' ? 'bg-cyan-400 ring-cyan-950/20' :
                                    log.type === 'browse' ? 'bg-purple-400 ring-purple-950/20' :
                                    'bg-indigo-400 ring-indigo-950/20'
                                  }`} />
                                  <span className="font-bold text-[#9D988C] uppercase text-[9px]">{log.title}</span>
                                </div>
                                <p className="text-[#F3EFE6] pl-3.5 whitespace-pre-wrap leading-relaxed">{log.text}</p>
                              </div>
                            ))}

                            {activeTask.agent_state.status === 'running' && (
                              <div className="flex items-center space-x-2 animate-pulse text-amber-305 font-medium pl-1 mt-1 font-mono">
                                <RefreshCw className="animate-spin w-3.5 h-3.5 shrink-0" />
                                <span>Agent executing step-by-step logic in virtual sandbox...</span>
                              </div>
                            )}

                          </div>
                        </div>
                      )}

                      {/* Trigger Execution Button when in Planning */}
                      {activeTask.agent_state.status === 'planning' && (
                        <div className="pt-2 flex items-center gap-2">
                          <button
                            onClick={() => handleResetAgent(activeTask.id)}
                            className="flex-1 bg-[#FCFAF5] hover:bg-[#F3EFE6] border border-[#DDD6C6] text-[#6B675E] text-xs py-2 rounded font-mono transition-colors cursor-pointer"
                          >
                            Discard Plan
                          </button>
                          
                          <button
                            onClick={() => handleExecuteAgent(activeTask.id)}
                            disabled={isExecutingAgent}
                            className="flex-[2] bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-xs font-semibold py-2 rounded font-mono flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:bg-[#DDD6C6] disabled:text-[#9D988C]"
                          >
                            <Cpu className="w-3.5 h-3.5" />
                            <span>Run Sandbox Agent</span>
                          </button>
                        </div>
                      )}

                      {/* Display proposed output and actions when finished */}
                      {activeTask.agent_state.status === 'completed' && activeTask.agent_state.proposed_draft && (
                        <div className="space-y-3 pt-2 border-t border-[#E6E0D3]">
                          
                          <div className="bg-[#FBF1E8] border border-[#EBD9C9] p-3.5 rounded-lg space-y-1 text-[#1C1B19] font-mono">
                            <span className="text-[10px] font-bold text-[var(--accent-strong)] uppercase tracking-wider">Agent Proposal:</span>
                            <p className="text-xs">The sandbox agent resolved your procrastinated task chunk! Review the proposed high-fidelity draft and checklists below.</p>
                          </div>

                          {/* Proposed actions list */}
                          {activeTask.agent_state.proposed_actions && activeTask.agent_state.proposed_actions.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-[10px] font-bold font-mono text-[#6B675E] uppercase tracking-widest">Proposed Next Actions:</p>
                              <div className="space-y-1 bg-[#FCFAF5] p-3 rounded-lg border border-[#E6E0D3] font-mono text-[#1C1B19]">
                                {activeTask.agent_state.proposed_actions.map((act, i) => (
                                  <div key={i} className="text-xs flex items-start gap-1.5">
                                    <span className="text-[10px] text-emerald-600 font-bold">▶</span>
                                    <span>{act}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Proposed draft markdown preview */}
                          <div className="space-y-1.5">
                            <p className="text-[10px] font-bold font-mono text-[#6B675E] uppercase tracking-widest">Proposed Blueprint Draft:</p>
                            <div 
                              className="bg-[#F3EFE6] border border-[#E6E0D3] rounded-lg p-5 font-sans text-xs text-[#1C1B19] leading-relaxed overflow-x-auto max-h-80 select-all selection:bg-[var(--accent-soft)] selection:text-[var(--accent-strong)] prose prose-sm max-w-none shadow-inner text-[#1C1B19]"
                              dangerouslySetInnerHTML={{ __html: formatMarkdown(activeTask.agent_state.proposed_draft) }}
                            />
                          </div>

                          {/* Approval Confirmation buttons */}
                          <div className="bg-emerald-50 border border-emerald-150 p-4 rounded-lg space-y-2">
                            <p className="text-[11px] text-emerald-800 font-mono leading-relaxed">
                              <strong>User Safety Confirmation REQUIRED:</strong> Applying this proposal will write the draft as your active task blueprint, and prepend the suggested checklist steps. Would you like to commit these change outputs?
                            </p>
                            
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleResetAgent(activeTask.id)}
                                className="flex-1 bg-white hover:bg-rose-50 border border-[#DDD6C6] text-rose-700 font-bold hover:border-rose-350 text-xs py-2 rounded font-mono transition-all cursor-pointer"
                              >
                                Discard Proposal
                              </button>
                              
                              <button
                                onClick={() => handleApproveAgentMerge(activeTask.id)}
                                className="flex-[2] bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2 rounded font-mono flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow hover:shadow-md"
                              >
                                <Check className="w-4 h-4" />
                                <span>Approve & Merge Results</span>
                              </button>
                            </div>
                          </div>

                        </div>
                      )}

                      {/* Display restart buttons if failed */}
                      {activeTask.agent_state.status === 'failed' && (
                        <div className="bg-rose-50 border border-rose-100 rounded-lg p-4 space-y-3 font-mono">
                          <p className="text-xs text-rose-700">Sandbox run failed or context timed out due to API key access capability.</p>
                          <button
                            onClick={() => handleResetAgent(activeTask.id)}
                            className="bg-white hover:bg-rose-100 text-rose-900 border border-rose-300 font-bold text-xs py-2 px-4 rounded transition-colors cursor-pointer"
                          >
                            Reset State & Retry
                          </button>
                        </div>
                      )}

                    </div>
                  )}

                </div>
              )}

            </div>
          ) : (
            /* Empty State for no tasks altogether */
            <div className="bg-white border border-slate-100 rounded-xl p-12 text-center space-y-4 shadow-sm" id="full-empty-container">
              <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-400">
                <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-slate-900 text-base font-mono">Workspace Serene & Safe</h3>
                <p className="text-xs text-slate-500 max-w-sm mx-auto">No pending commitments. Zero procrastination. Try dragging or typing a class notice/whatsapp bill in the capture board to start.</p>
              </div>
              <a 
                href="#capture-box"
                className="bg-slate-900 text-white text-xs px-4 py-2 rounded font-medium inline-block shadow hover:bg-slate-800 transition-all font-mono"
              >
                Capture New Commitment Now
              </a>
            </div>
          )}

        </section>

        {/* Right column: Intake Capture and quiet commitments list */}
        <section className="lg:w-2/5 space-y-6" id="capture-queue-sidebar">
          
          {/* Component: CAPTURE AREA */}
          <div className="bg-white border border-slate-100 rounded-xl p-6 shadow-sm transition-all anchor-section" id="capture-box">
            
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-slate-900 text-sm tracking-tight font-mono">Commitment Capture</h3>
                <p className="text-xs text-slate-500">Multimodal parsing extracts assignments directly.</p>
              </div>
              
              <button
                onClick={() => setShowManualForm(!showManualForm)}
                className="text-[10px] text-slate-500 hover:text-slate-900 underline font-mono font-medium"
                id="btn-toggle-manual-form"
              >
                {showManualForm ? "Switch to Multimodal Capture" : "Add Manually Instead"}
              </button>
            </div>

            {showManualForm ? (
              /* MANUAL ADD FORM */
              <form onSubmit={handleManualAdd} className="space-y-3" id="manual-add-form">
                
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Task / Assignment Title</label>
                  <input
                    type="text"
                    placeholder="E.g. Submit MA 102 Calculus Worksheet"
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 text-xs rounded p-2.5 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Finish Deadline</label>
                    <input
                      type="datetime-local"
                      value={manualDeadline}
                      onChange={(e) => setManualDeadline(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-xs rounded p-2 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono"
                      required
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Est. Duration (Mins)</label>
                    <input
                      type="number"
                      placeholder="E.g., 45"
                      value={manualEffort}
                      onChange={(e) => setManualEffort(Number(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 text-xs rounded p-2 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono"
                      min={1}
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Consequence Level</label>
                    <select
                      value={manualConsequence}
                      onChange={(e: any) => setManualConsequence(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-xs rounded p-2 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono"
                    >
                      <option value="low">Low Impact</option>
                      <option value="medium">Medium Impact</option>
                      <option value="high">High Impact</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Source / Context Note</label>
                    <input
                      type="text"
                      placeholder="E.g. Class portal"
                      value={manualSource}
                      onChange={(e) => setManualSource(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 text-xs rounded p-2 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono"
                    />
                  </div>
                </div>

                <div className="pt-2 flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowManualForm(false)}
                    className="px-3 py-1.5 border border-slate-250 text-slate-600 rounded text-xs hover:bg-slate-50 font-mono"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded text-xs hover:shadow-sm font-mono flex items-center space-x-1"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Store Commitment</span>
                  </button>
                </div>

              </form>
            ) : (
              /* MULTIMODAL INTELLIGENT EXTRACTOR FORM */
              <form onSubmit={handleCommitmentExtraction} className="space-y-3" id="extractor-form">
                
                {/* Drag-and-Drop Dropzone Zone */}
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[140px] ${
                    dragOver
                      ? 'border-amber-500 bg-amber-50/20 shadow-inner'
                      : selectedFileName
                      ? 'border-emerald-200 bg-emerald-50/10'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/30'
                  }`}
                  id="drop-zone-container"
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => e.target.files && handleFileSelect(e.target.files[0])}
                    className="hidden"
                    accept="image/*"
                  />

                  {selectedFileName ? (
                    <div className="space-y-2">
                      <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
                        <Check className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-xs text-slate-800 font-semibold font-mono truncate max-w-[200px] mx-auto">{selectedFileName}</p>
                        <p className="text-[10px] text-slate-400 font-mono">Click to swap screenshot</p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          clearUploadedFile();
                        }}
                        className="text-[10px] font-mono font-bold text-rose-600 hover:underline pt-1 block mx-auto"
                      >
                        Remove Upload
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <UploadCloud className="w-8 h-8 text-slate-400 mx-auto" />
                      <div>
                        <span className="text-xs text-slate-800 font-bold font-mono">Drop syllabus file here</span>
                        <p className="text-[10px] text-slate-400 mt-1 max-w-[280px] mx-auto font-mono">Drag and drop WhatsApp screen-snaps, college portal timetables, or alerts. Or click to select layout file.</p>
                      </div>
                    </div>
                  )}

                </div>

                {/* Additional Text Instructions Context */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between bg-white py-0.5">
                    <label className="text-[10px] font-bold text-slate-450 uppercase font-mono">Hinglish / Text Notes context (Optional)</label>
                    <button
                      type="button"
                      onClick={startSpeechCapture}
                      className={`text-[10px] font-bold font-mono px-2 py-0.5 rounded transition-all cursor-pointer flex items-center gap-1 shadow-sm ${
                        isRecordingMic
                          ? 'bg-rose-600 animate-pulse text-white'
                          : 'bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100'
                      }`}
                      title="Speak commitment notes in English or Hinglish"
                      id="btn-speech-dictate"
                    >
                      <Mic className={`w-3 h-3 ${isRecordingMic ? 'animate-bounce' : ''}`} />
                      <span>{isRecordingMic ? 'Listening...' : 'Speak Draft'}</span>
                    </button>
                  </div>
                  
                  {speechError && (
                    <p className="text-[9px] text-rose-600 font-mono italic leading-tight mb-1">{speechError}</p>
                  )}

                  <textarea
                    placeholder="Type notes or context here: e.g. 'I need to pay BSES bill of 2410 by Saturday' or paste syllabus outline text. (Assume today is June 23, 2026)."
                    value={captureText}
                    onChange={(e) => setCaptureText(e.target.value)}
                    className="w-full h-15 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs rounded p-2 px-3 outline-none focus:bg-white focus:ring-1 focus:ring-amber-500 font-mono transition-all text-slate-700 font-medium"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isExtracting}
                  className={`w-full py-2.5 text-xs font-black font-mono tracking-wide rounded shadow flex items-center justify-center space-x-1.5 transition-all ${
                    isExtracting
                      ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                      : 'bg-slate-900 hover:bg-slate-850 text-white'
                  }`}
                  id="btn-submit-extractor"
                >
                  {isExtracting ? (
                    <>
                      <RefreshCw className="animate-spin w-4 h-4 mr-1.5" />
                      <span>Gemini analysis processing...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-amber-500" />
                      <span>Ingest with Gemini Brain</span>
                    </>
                  )}
                </button>

              </form>
            )}

          </div>

          {/* Component: UPCOMING QUEUE list */}
          <div className="bg-white border border-slate-100 rounded-xl p-6 shadow-sm flex flex-col" id="upcoming-queue">
            
            <div className="flex items-center justify-between mb-4 border-b border-slate-50 pb-3">
              <div className="space-y-0.5">
                <h3 className="font-semibold text-slate-900 text-sm tracking-tight font-mono">Tasks Stack</h3>
                <p className="text-xs text-slate-500">Sorted by dynamic calculated Panic Score.</p>
              </div>
              <span className="text-[10px] font-mono bg-slate-100 px-2 py-0.5 rounded font-black text-slate-600">
                {commitments.filter(c => c.status === 'pending').length} Pending
              </span>
            </div>

            {loading ? (
              <div className="py-12 text-center" id="queue-loader-block">
                <RefreshCw className="animate-spin w-5 h-5 text-amber-500 mx-auto mb-2" />
                <p className="text-xs text-slate-400 font-mono">Fetching stack orders...</p>
              </div>
            ) : commitments.length === 0 ? (
              <div className="py-8 text-center" id="queue-empty-block">
                <p className="text-xs text-slate-400 font-mono">No target goals loaded.</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1" id="commitments-cards-grid">
                
                {/* Pending targets loop */}
                {sortedPending.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono px-1">Focus Queue</p>
                    
                    {sortedPending.map((item) => {
                      const isFocused = activeTask?.id === item.id;
                      const isPrepped = item.artifact;

                      return (
                        <div
                          key={item.id}
                          onClick={() => {
                            setSelectedId(item.id);
                            setIsEditingMove(false);
                          }}
                          className={`p-3.5 rounded-lg border text-left cursor-pointer transition-all hover:bg-slate-50/50 relative overflow-hidden group ${
                            isFocused
                              ? 'bg-slate-50 border-slate-900 shadow-sm'
                              : 'bg-white border-slate-100'
                          }`}
                          id={`queue-card-${item.id}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-1 max-w-[70%]">
                              <h4 className="text-xs font-bold text-slate-900 tracking-tight font-mono leading-tight group-hover:text-slate-950 transition-colors truncate">
                                {item.title}
                              </h4>
                              
                              <div className="flex flex-wrap gap-1.5 items-center text-[10px] text-slate-500 font-mono">
                                <span className={formatDeadlineDate(item.deadline).style}>
                                  {formatDeadlineDate(item.deadline).text}
                                </span>
                                <span>•</span>
                                <span>{item.effort_minutes}m effort</span>
                              </div>
                            </div>

                            {/* Panic score indicator badge layout */}
                            <div className="flex items-center space-x-1.5">
                              {isPrepped && (
                                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex items-center justify-center text-white" title="First move prepared and ready!">
                                  <span className="w-1.5 h-1.5 bg-emerald-100 rounded-full"></span>
                                </span>
                              )}
                              
                              <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded leading-none ${
                                item.breakdown.total >= 75 ? 'bg-rose-50 text-rose-700 border border-rose-100' :
                                item.breakdown.total >= 50 ? 'bg-amber-50 text-amber-700 border border-amber-100' :
                                'bg-slate-50 text-slate-600 border border-slate-100'
                              }`}>
                                {item.breakdown.total}
                              </span>
                            </div>
                          </div>

                          {/* Action row shown on hover inside queue */}
                          <div className="mt-2.5 pt-2.5 border-t border-slate-50 flex items-center justify-between text-[10px] opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <button
                              onClick={(e) => toggleOverallStatus(item.id, e)}
                              className="text-slate-500 hover:text-emerald-700 font-mono font-semibold flex items-center"
                            >
                              <Check className="w-3 h-3 mr-1" /> Finish Task
                            </button>
                            <button
                              onClick={(e) => deleteCommitment(item.id, e)}
                              className="text-slate-400 hover:text-rose-600 font-mono flex items-center"
                              id={`queue-delete-btn-${item.id}`}
                            >
                              <Trash2 className="w-3 h-3 mr-1" /> Discard
                            </button>
                          </div>

                          {isFocused && (
                            <div className="absolute right-0 top-0 bottom-0 w-1 bg-slate-900"></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Completed targets loop */}
                {getSortedCompletedCommitments().length > 0 && (
                  <div className="space-y-2 pt-4">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono px-1">Archived Successes</p>
                    
                    {getSortedCompletedCommitments().map((item) => {
                      const isFocused = activeTask?.id === item.id;
                      return (
                        <div
                          key={item.id}
                          onClick={() => {
                            setSelectedId(item.id);
                            setIsEditingMove(false);
                          }}
                          className={`p-3 rounded-lg border text-left cursor-pointer transition-all bg-[#FAFBFB] text-slate-400 line-through ${
                            isFocused
                              ? 'border-slate-400 shadow-sm'
                              : 'border-slate-100 text-slate-400'
                          }`}
                          id={`queue-completed-${item.id}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium font-mono truncate max-w-[70%]">{item.title}</span>
                            <div className="flex items-center space-x-2">
                              <span className="text-[9px] uppercase font-mono bg-emerald-50 text-emerald-750 px-1.5 py-0.5 rounded border border-emerald-100 leading-none">Done</span>
                              <button
                                onClick={(e) => deleteCommitment(item.id, e)}
                                className="text-slate-350 hover:text-rose-600 transition-colors p-0.5 rounded"
                                title="Discard archive record"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

              </div>
            )}

          </div>

        </section>

      </main>
        </div>
      )}

      {/* Footer Branding Area */}
      <footer className="border-t border-slate-100 bg-white py-8 text-center text-xs text-slate-450" id="footer-branding">
        <div className="max-w-7xl mx-auto px-4 space-y-3">
          <div className="flex items-center justify-center space-x-2 font-mono font-bold text-slate-800">
            <span>Clutch</span>
            <span>•</span>
            <span className="text-[10px] text-slate-400 font-normal">Building Momentum, Bypassing Procrastination</span>
          </div>
          <p className="max-w-md mx-auto text-slate-400 leading-relaxed text-[11px]">
            Designed for solo-founders, and busy students in India. Harnesses server-side <strong>Google AI Studio + Gemini 3.5 Flash</strong> to proactively decompose checklists and execute the custom first-move.
          </p>
          <div className="text-[10px] text-slate-300 font-mono">
            Full-Stack Node server running on Cloud Run sandbox with persistent Firestore support.
          </div>
        </div>
      </footer>

      {/* Google Gmail Integration Modal */}
      {showGmailModal && activeTask && activeTask.artifact && (
        <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto animate-fade-in" id="gmail-modal-wrapper">
          <div className="bg-slate-900/95 border border-slate-800 shadow-2xl rounded-2xl max-w-lg w-full p-6 sm:p-8 space-y-6 text-white" id="gmail-modal-content">
            
            {/* Header */}
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Mail className="w-5 h-5 text-amber-500" />
                  <span>Approve & Create Email Draft</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Save this unblocking draft so it is ready to be finalized and sent.
                </p>
              </div>
              <button 
                onClick={() => {
                  setShowGmailModal(false);
                  setErrorText(null); // Clear errors
                }}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition-all cursor-pointer"
                id="btn-close-gmail-modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Target Details Panel */}
            <div className="bg-slate-950 rounded-lg p-4 border border-slate-850 text-xs text-slate-400 space-y-2">
              <div>
                <span className="font-mono font-bold text-slate-300">Task Name:</span> {activeTask.title}
              </div>
              <div>
                <span className="font-mono font-bold text-slate-300">Parsed Subject:</span> {parseDraftEmail(activeTask.artifact?.draft || "").subject}
              </div>
            </div>

            {/* Error alerts inside the modal */}
            {errorText && (
              <div className="bg-rose-950/30 border border-rose-900/40 rounded-lg p-3 text-xs text-rose-400 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorText}</span>
              </div>
            )}

            {/* Option A: One-click native email client (mailto) */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center space-x-2 border-b border-slate-850 pb-2">
                <span className="text-[10px] font-mono font-bold bg-amber-950/40 text-amber-400 border border-amber-900/30 px-2 py-0.5 rounded">Option 1</span>
                <span className="text-xs font-bold text-slate-200">Instant Pre-filled Client/Webmail (One-Click Fallback)</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Pre-fills the Subject and body into Outlook, Mac Mail, Windows Mail, or your browser's default email handler of choice in 1 second. Safely offline and zero setup.
              </p>
              <button
                onClick={async () => {
                  try {
                    const { subject } = parseDraftEmail(activeTask.artifact?.draft || "");
                    const emailBody = cleanBodyForMailto(activeTask.artifact?.draft || "");
                    
                    // Simple mailto link format
                    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;
                    
                    // Open it first
                    window.open(mailtoUrl, '_blank');
                    
                    // Mark task as approved
                    await handleApproveMove(activeTask.id);
                    setShowGmailModal(false);
                    setStatusMessage("✓ Opened native email app and marked commitment complete!");
                  } catch (err: any) {
                    setErrorText(err.message || "Failed opening mailto client.");
                  }
                }}
                className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold font-mono text-xs py-2.5 rounded-lg border border-indigo-500/30 transition-all shadow-sm cursor-pointer"
                id="btn-mailto-fallback"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>Launch Mail App & Approve</span>
              </button>
            </div>

            {/* Option B: Active Real-time Gmail API drafts folder direct synchronization */}
            <div className="space-y-3 pt-3 border-t border-slate-850">
              <div className="flex items-center space-x-2 border-b border-slate-850 pb-2">
                <span className="text-[10px] font-mono font-bold bg-indigo-950/40 text-indigo-400 border border-indigo-900/30 px-2 py-0.5 rounded">Option 2</span>
                <span className="text-xs font-bold text-slate-200">Directly Create inside Gmail Drafts Folder (API Link)</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Connect Google Account credentials. This securely places a real Draft email in your private Gmail drafts folder. You can review and hit send later!
              </p>

              {gmailToken ? (
                <div className="space-y-3">
                  <div className="bg-emerald-950/30 border border-emerald-900/40 rounded-lg p-3 text-[11px] text-emerald-400 flex items-center justify-between">
                    <span className="font-medium flex items-center gap-1.5 font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      Gmail Connected
                    </span>
                    <button
                      onClick={() => {
                        setGmailToken(null);
                        safeRemoveLocalStorage('gmail_access_token');
                      }}
                      className="text-rose-450 hover:text-rose-450 font-bold hover:underline cursor-pointer"
                    >
                      Disconnect
                    </button>
                  </div>
                  <button
                    onClick={() => handleCreateGmailDraft(activeTask.id, activeTask.artifact?.draft || "")}
                    disabled={isCreatingDraft}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-650 hover:bg-emerald-500 disabled:bg-emerald-400 text-white font-semibold font-mono text-xs py-2.5 rounded-lg transition-all shadow-sm cursor-pointer"
                    id="btn-create-real-gmail-draft"
                  >
                    {isCreatingDraft ? (
                      <>
                        <RefreshCw className="animate-spin w-3.5 h-3.5 animate-spin" />
                        <span>Creating Direct Draft...</span>
                      </>
                    ) : (
                      <>
                        <Mail className="w-3.5 h-3.5" />
                        <span>Create in Gmail Server & Approve</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="space-y-3 p-3 bg-slate-950 rounded-lg border border-slate-850">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-mono uppercase font-bold text-slate-500">Google Client ID</label>
                    <input
                      type="text"
                      placeholder="e.g. 123456-abcdef.apps.googleusercontent.com"
                      value={gmailClientId}
                      onChange={(e) => {
                        setGmailClientId(e.target.value);
                        safeSetLocalStorage('gmail_oauth_client_id', e.target.value);
                      }}
                      className="w-full bg-slate-900 border border-slate-800 text-white text-xs p-2 rounded font-mono focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    />
                    <p className="text-[9px] text-slate-500">
                      Required for sandbox redirect. If you do not have an active credentials client ID, please use the Option 1 instant Mailto fallback above!
                    </p>
                  </div>
                  <button
                    onClick={handleGoogleSignIn}
                    className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold font-mono text-xs py-2 rounded transition-all shadow-sm cursor-pointer"
                    id="btn-oauth-signin"
                  >
                    <span>🔌 Authenticate Google Account</span>
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
