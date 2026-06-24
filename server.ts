import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { WebSocketServer } from 'ws';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore';

// Load .env first, then .env.local (local secrets, per README). Neither overrides
// an already-set process.env var, so production injection (AI Studio / Cloud Run)
// still wins.
dotenv.config();
dotenv.config({ path: path.resolve('.env.local') });


// Ensure Gemini Client is only initialized if API KEY is available
let ai: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === 'MY_GEMINI_API_KEY') {
      throw new Error('GEMINI_API_KEY environment variable is not set. Please set it in Settings > Secrets.');
    }
    ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return ai;
}

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
  panic_score?: number;
  is_custom?: boolean;
  study_pack?: StudyPack;
  agent_state?: AgentModeState;
}

// Backend Firebase Initialisation & Helpers
const configPath = path.resolve('firebase-applet-config.json');
let db: any = null;

if (fs.existsSync(configPath)) {
  try {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const firebaseConfig = {
      apiKey: configData.apiKey,
      authDomain: configData.authDomain,
      projectId: configData.projectId,
      storageBucket: configData.storageBucket,
      messagingSenderId: configData.messagingSenderId,
      appId: configData.appId
    };
    const fbApp = initializeApp(firebaseConfig);
    db = getFirestore(fbApp, configData.firestoreDatabaseId || "(default)");
    console.log("Firebase storage initialized seamlessly on backend.");
  } catch (err) {
    console.error("Backend Firebase init error:", err);
  }
}

async function getCommitmentsForRequest(req: express.Request): Promise<Commitment[]> {
  const userId = req.headers['x-user-id'] as string;
  if (userId && db) {
    try {
      const commitmentsCol = collection(db, 'users', userId, 'commitments');
      const qSnap = await getDocs(commitmentsCol);
      let list = qSnap.docs.map(doc => doc.data() as Commitment);

      // New accounts start empty — no demo/seed data is injected.
      return list.map(c => ({
        ...c,
        next_actions: c.next_actions || []
      }));
    } catch (e) {
      console.error("Error reading from Firestore:", e);
      return ensureDataSetup();
    }
  }
  return ensureDataSetup();
}

async function saveCommitmentForRequest(req: express.Request, commitment: Commitment): Promise<void> {
  const userId = req.headers['x-user-id'] as string;
  if (userId && db) {
    try {
      const docRef = doc(db, 'users', userId, 'commitments', commitment.id);
      await setDoc(docRef, commitment);
    } catch (e) {
      console.error("Error writing to Firestore:", e);
    }
  } else {
    const list = ensureDataSetup();
    const index = list.findIndex(c => c.id === commitment.id);
    if (index !== -1) {
      list[index] = commitment;
    } else {
      list.push(commitment);
    }
    saveCommitments(list);
  }
}

async function saveAllCommitmentsForRequest(req: express.Request, list: Commitment[]): Promise<void> {
  const userId = req.headers['x-user-id'] as string;
  if (userId && db) {
    try {
      for (const item of list) {
        const docRef = doc(db, 'users', userId, 'commitments', item.id);
        await setDoc(docRef, item);
      }
    } catch (e) {
      console.error("Error writing many to Firestore:", e);
    }
  } else {
    saveCommitments(list);
  }
}

async function deleteCommitmentForRequest(req: express.Request, id: string): Promise<void> {
  const userId = req.headers['x-user-id'] as string;
  if (userId && db) {
    try {
      const docRef = doc(db, 'users', userId, 'commitments', id);
      await deleteDoc(docRef);
    } catch (e) {
      console.error("Error deleting from Firestore:", e);
    }
  } else {
    const list = ensureDataSetup();
    const filtered = list.filter(c => c.id !== id);
    saveCommitments(filtered);
  }
}


function calculatePanicScore(deadline: string, effort_minutes: number, consequence: 'low' | 'medium' | 'high'): number {
  const now = Date.now();
  const target = new Date(deadline).getTime();
  const days_until_deadline = (target - now) / (1000 * 60 * 60 * 24);

  let urgency = 5;
  if (days_until_deadline <= 0) {
    urgency = 40;
  } else if (days_until_deadline <= 0.5) { // 12h
    urgency = 38;
  } else if (days_until_deadline <= 1) { // 24h
    urgency = 35;
  } else if (days_until_deadline <= 2) { // 48h
    urgency = 30;
  } else if (days_until_deadline <= 3) {
    urgency = 25;
  } else if (days_until_deadline <= 7) {
    urgency = 15;
  }

  let consequenceVal = 10;
  if (consequence === 'high') consequenceVal = 40;
  else if (consequence === 'medium') consequenceVal = 25;

  let effortVal = 5;
  if (effort_minutes >= 240) effortVal = 20;
  else if (effort_minutes >= 120) effortVal = 15;
  else if (effort_minutes >= 30) effortVal = 10;

  return urgency + consequenceVal + effortVal;
}

const DATA_DIR = path.resolve('data');
const DATA_FILE = path.join(DATA_DIR, 'commitments.json');

function ensureDataSetup(): Commitment[] {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  // Local file fallback (used only when no signed-in user id is present).
  // Starts empty — no demo/seed data.
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
    return [];
  }
}

function saveCommitments(list: Commitment[]) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

async function startServer() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const port = 3000;

  ensureDataSetup();

  app.use(express.json({ limit: '10mb' }));

  // API Check Status health
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // GET Commitments
  app.get('/api/commitments', async (req, res) => {
    const list = await getCommitmentsForRequest(req);
    const withScores = list.map(c => ({
      ...c,
      panic_score: calculatePanicScore(c.deadline, c.effort_minutes, c.consequence),
      next_actions: c.next_actions || []
    }));
    withScores.sort((a, b) => (b.panic_score || 0) - (a.panic_score || 0));
    res.json(withScores);
  });

  // RESET Commitments — clears the user's plate (no demo data is re-seeded).
  app.post('/api/commitments/reset', async (req, res) => {
    const existing = await getCommitmentsForRequest(req);
    for (const item of existing) {
      await deleteCommitmentForRequest(req, item.id);
    }
    res.json([]);
  });

  // CREATE Commitment manually
  app.post('/api/commitments', async (req, res) => {
    const { title, deadline, effort_minutes, consequence, source } = req.body;
    if (!title || !deadline) {
      res.status(400).json({ error: 'Title and Deadline are required.' });
      return;
    }

    const newCommitment: Commitment = {
      id: 'custom-' + Date.now().toString(),
      title,
      deadline,
      effort_minutes: Number(effort_minutes) || 30,
      consequence: consequence || 'medium',
      source: source || 'User entry',
      status: 'pending',
      next_actions: [],
      is_custom: true
    };
    newCommitment.panic_score = calculatePanicScore(newCommitment.deadline, newCommitment.effort_minutes, newCommitment.consequence);

    await saveCommitmentForRequest(req, newCommitment);
    res.json(newCommitment);
  });

  // EXTRACT Commitments (with Gemini Vision/Text)
  app.post('/api/commitments/extract', async (req, res) => {
    const { text, imageBase64, imageMime } = req.body;

    if (!text && !imageBase64) {
      res.status(400).json({ error: 'Either text prompt or image upload is required.' });
      return;
    }

    try {
      const client = getGeminiClient();

      const commitmentSchema = {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: "A short, proactive and actionable title (e.g. 'Submit Complex Math Assignment', 'Email Prof. S regarding abstract approval', 'Rent Payment'). Keep it humble, literal, and focused."
          },
          deadline: {
            type: Type.STRING,
            description: "ISO date-time string of the deadline. The current local date is 2026-06-23. Parse relative expressions (like 'next Friday', 'due in 2 days') relative to this date."
          },
          effort_minutes: {
            type: Type.INTEGER,
            description: "Estimated number of minutes needed to complete the task fully. Provide a realistic estimate."
          },
          consequence: {
            type: Type.STRING,
            description: "Level of negative impact of missing this. Must be 'low', 'medium', or 'high'."
          },
          source: {
            type: Type.STRING,
            description: "Brief label of where this came from, e.g., 'WhatsApp screenshot', 'Portal notice', 'Typed notes'."
          }
        },
        required: ["title", "deadline", "effort_minutes", "consequence", "source"]
      };

      const responseSchema = {
        type: Type.ARRAY,
        items: commitmentSchema,
        description: "A list of commitments extracted from the documentation/image."
      };

      const contents: any[] = [];
      let promptText = "You are Clutch, a productivity companion. Analyze the input and extract any commitments, assignments, schedules, bills, or tasks. Resolve dates assuming today is Tuesday, 2026-06-23.";

      if (text) {
        promptText += `\n\nUser text input: "${text}"`;
      }

      if (imageBase64) {
        let cleanBase64 = imageBase64;
        let mimeType = imageMime || 'image/png';
        if (imageBase64.startsWith('data:')) {
          const parts = imageBase64.split(';base64,');
          mimeType = parts[0].substring(5);
          cleanBase64 = parts[1];
        }

        contents.push({
          inlineData: {
            mimeType,
            data: cleanBase64,
          }
        });
        promptText += "\n\nAnalyse the uploaded screenshot/document image and extract the commitments.";
      }

      contents.push({ text: promptText });

      const modelResponse = await client.models.generateContent({
        model: 'gemini-3.5-flash',
        contents,
        config: {
          systemInstruction: "You are an expert scheduler for students, founders, and solo-professionals in India. You specialize in identifying hard-deadlines, bills, college exams, and student assignments from chaotic sources (including Hinglish phrases, Indian colleges, WhatsApp screenshots, UPI alerts). Extrapolate deadlines correctly relative to today: Tuesday, 2026-06-23.",
          responseMimeType: "application/json",
          responseSchema,
        }
      });

      const extractedText = modelResponse.text;
      if (!extractedText) {
        throw new Error("No text returned from Gemini API");
      }

      const extractedCommitments: any[] = JSON.parse(extractedText);

      // Save each extracted commitment to our list
      const newlyAdded: Commitment[] = [];

      for (const item of extractedCommitments) {
        const c: Commitment = {
          id: 'extracted-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
          title: item.title,
          deadline: item.deadline || new Date(Date.now() + 48 * 3600000).toISOString(), // fallback 2 days
          effort_minutes: Number(item.effort_minutes) || 45,
          consequence: item.consequence || 'medium',
          source: item.source || (imageBase64 ? 'Uploaded screenshot' : 'Manual text'),
          status: 'pending',
          next_actions: [],
          is_custom: true
        };
        await saveCommitmentForRequest(req, c);
        newlyAdded.push(c);
      }

      res.json(newlyAdded);

    } catch (error: any) {
      console.error("Gemini Extraction Error:", error);
      res.status(500).json({ error: error.message || 'Failed to extract commitments with Gemini.' });
    }
  });

  // INITIALIZE / DECOMPOSE / FIRST-MOVE generator
  app.post('/api/commitments/:id/initialize', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    try {
      const client = getGeminiClient();

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          next_actions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "3 to 5 atomic checklist items to make initial progress. Format them as short, extremely actionable physical actions (e.g. 'Open slide deck in Google Drive', 'Draft outline of introduction', 'Search CA Number')."
          },
          artifact_type: {
            type: Type.STRING,
            description: "Must be: 'email', 'study', 'upi', or 'general'."
          },
          artifact_title: {
            type: Type.STRING,
            description: "Catchy first action title like 'Draft Email to Prof. Roy' or 'Quick Practice Question Set'."
          },
          artifact_draft: {
            type: Type.STRING,
            description: "The core unblocking content. If email: write a fully-fledged, and polite email containing placeholders or templates. If study: write 3 high-yield questions with a 'First Move Tip' each. If UPI: write CA numbers, expected bill payee details, and 1-click guide instructions. If general: write a structured skeletal outline or intro paragraph. Use clear markdown."
          }
        },
        required: ["next_actions", "artifact_type", "artifact_title", "artifact_draft"]
      };

      const prompt = `You are Clutch, a proactive productivity assistant. The user has a difficult commitment they are procrastinating on:
Title: "${commitment.title}"
Estimated total effort: ${commitment.effort_minutes} minutes
Source/Context: "${commitment.source}"
Consequence: "${commitment.consequence}"
Deadline: ${commitment.deadline} (relative to today, June 23, 2026)

Task initiation fails because chores feel vague, abstract, and painful. Unblock them by doing the hardest first step right now!
Decompose this commitment into 3-5 concrete checkpoint next-actions.
Also, generate a satisfying, useful and high-fidelity 'First Move' artifact (email body, study pack, outline tracker, payment instruction card, setup step) that gives the user immediate momentum. Keep it modern, clean, and helpful. Format using beautiful markdown inside artifact_draft. Do not larp or report system details.`;

      const result = await client.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema
        }
      });

      const extractedText = result.text;
      if (!extractedText) {
        throw new Error("Empty response from Gemini.");
      }

      const generatedData = JSON.parse(extractedText);

      // Map back to our commitment model
      commitment.next_actions = generatedData.next_actions.map((text: string, i: number) => ({
        id: `na-${id}-${i}-${Date.now()}`,
        text,
        completed: false
      }));

      commitment.artifact = {
        type: generatedData.artifact_type as 'email' | 'study' | 'general' | 'upi',
        title: generatedData.artifact_title,
        draft: generatedData.artifact_draft,
        approved: false
      };

      await saveCommitmentForRequest(req, commitment);

      res.json(commitment);

    } catch (error: any) {
      console.error("Gemini Initialize Error:", error);
      res.status(500).json({ error: error.message || 'Failed to initialize commitment actions.' });
    }
  });

  // UPDATE action state
  app.post('/api/commitments/:id/toggle-action', async (req, res) => {
    const { id } = req.params;
    const { actionId } = req.body;

    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];
    if (commitment.next_actions) {
      const aIdx = commitment.next_actions.findIndex(a => a.id === actionId);
      if (aIdx !== -1) {
        commitment.next_actions[aIdx].completed = !commitment.next_actions[aIdx].completed;
      }
    }

    await saveCommitmentForRequest(req, commitment);
    res.json(commitment);
  });

  // APPROVE first move
  app.post('/api/commitments/:id/approve-move', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];
    if (commitment.artifact) {
      commitment.artifact.approved = true;
    }
    commitment.status = 'completed';

    await saveCommitmentForRequest(req, commitment);
    res.json(commitment);
  });

  // GENERATE STUDY PACK (MULTIMODAL NOTES OR SYLLABUS DIRECT PARSING)
  app.post('/api/commitments/:id/generate-study-pack', async (req, res) => {
    const { id } = req.params;
    const { imageBase64, imageMime } = req.body;

    if (!imageBase64) {
      res.status(400).json({ error: 'Notes or syllabus file upload is required.' });
      return;
    }

    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    try {
      const client = getGeminiClient();

      // Output Response format containing 5 questions and 5 flashcards
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                question: { type: Type.STRING },
                answer: { type: Type.STRING }
              },
              required: ["id", "question", "answer"]
            },
            description: "Exactly 5 predictive exam or practice questions derived directly from the uploaded notes/syllabus details. Include deep, comprehensive explanations and breakdown of answers."
          },
          flashcards: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                front: { type: Type.STRING },
                back: { type: Type.STRING }
              },
              required: ["front", "back"]
            },
            description: "Exactly 5 dynamic flashcards targeting key formulae, definitions, concepts, or rules from the documents."
          }
        },
        required: ["questions", "flashcards"]
      };

      const contents: any[] = [];
      let promptText = `Analyze the uploaded notes, syllabus, or lecture slides. Create an interactive study pack containing:
1. Exactly 5 predictive exam-style practice questions with comprehensive answers.
2. Exactly 5 technical flashcards. Front contains the term, equation, or concept. Back contains the brief, clean explanation.

Make sure all content is derived 100% from the uploaded document itself, prioritizing core topics, technical formulae, and high-yield concepts mentioned. Keep answers explanatory and clear!`;

      let cleanBase64 = imageBase64;
      let mimeType = imageMime || 'image/png';
      if (imageBase64.startsWith('data:')) {
        const parts = imageBase64.split(';base64,');
        mimeType = parts[0].substring(5);
        cleanBase64 = parts[1];
      }

      contents.push({
        inlineData: {
          mimeType,
          data: cleanBase64,
        }
      });

      contents.push({ text: promptText });

      const modelResponse = await client.models.generateContent({
        model: 'gemini-3.5-flash',
        contents,
        config: {
          systemInstruction: "You are a professional tutor and academic assessor specializing in distilling complex syllabi, textbooks, and notes into practice questions and interactive memory flashcards.",
          responseMimeType: "application/json",
          responseSchema,
        }
      });

      const textOutput = modelResponse.text;
      if (!textOutput) {
        throw new Error("Gemini returned an empty result.");
      }

      const generatedPack = JSON.parse(textOutput);
      commitment.study_pack = generatedPack;

      await saveCommitmentForRequest(req, commitment);

      res.json(commitment);

    } catch (error: any) {
      console.error("Study Pack Generation Error:", error);
      res.status(500).json({ error: error.message || 'Failed to generate study pack using Gemini API.' });
    }
  });

  // EDIT first move draft
  app.post('/api/commitments/:id/edit-move', async (req, res) => {
    const { id } = req.params;
    const { draft } = req.body;

    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];
    if (commitment.artifact) {
      commitment.artifact.draft = draft;
    }

    await saveCommitmentForRequest(req, commitment);
    res.json(commitment);
  });

  // TOGGLE overall status
  app.post('/api/commitments/:id/toggle-status', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];
    commitment.status = commitment.status === 'pending' ? 'completed' : 'pending';

    await saveCommitmentForRequest(req, commitment);
    res.json(commitment);
  });

  // DELETE Commitment
  app.delete('/api/commitments/:id', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    await deleteCommitmentForRequest(req, id);
    res.json({ success: true, id });
  });

  // GATHER INFO VIA GOOGLE SEARCH GROUNDING
  app.post('/api/commitments/:id/gather-info', async (req, res) => {
    const { id } = req.params;
    const { customQuery } = req.body;

    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    try {
      const client = getGeminiClient();

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          action_title: {
            type: Type.STRING,
            description: "A clear, actionable next step command starting with an active verb including the core portal/tool, e.g. 'Log in and register on PG&E Online Portal' or 'Access Stanford CS101 syllabus portal'."
          },
          link_url: {
            type: Type.STRING,
            description: "The absolute HTTPS URL of the exact page, form, online document, dashboard, portal, or contact sheet found. Must be valid."
          },
          source_title: {
            type: Type.STRING,
            description: "Name/title of the official organization or portal, e.g. 'PG&E Bill-Pay', 'Stanford CS Course Directory'."
          },
          summary_of_findings: {
            type: Type.STRING,
            description: "Concise 1-2 sentence description of findings, office-hours, billing deadlines, fee policies, or required credentials."
          }
        },
        required: ["action_title", "link_url", "source_title", "summary_of_findings"]
      };

      const searchQuery = customQuery || `Official portal url, login, bill-pay page, online form, office hours, schedule, or help center for: "${commitment.title}"`;

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Use the Google Search tool to search and locate the official login portals, web links, PDF forms, billing pages, scheduling calendars, or official contact pages related to this user task:

Task Title: "${commitment.title}"
Task Context: "${commitment.source || ''}"

Goal: Search for "${searchQuery}" and find the correct, direct, official link. Return the structural action details.`,
        config: {
          tools: [{ googleSearch: {} }],
          responseMimeType: "application/json",
          responseSchema,
          systemInstruction: "You are an online researcher and administrative scout. Your job is to locate exact portals, web links, online forms, phone numbers, or dates, and return them as a highly structured next-action."
        }
      });

      const textVal = response.text;
      if (!textVal) {
        throw new Error("No response returned from the Gemini search model.");
      }

      const generatedInfo = JSON.parse(textVal);

      // Create cited next action
      const newAction: NextAction = {
        id: `na-cited-${id}-${Date.now()}`,
        text: generatedInfo.action_title,
        completed: false,
        url: generatedInfo.link_url,
        source_title: generatedInfo.source_title,
        source_snippet: generatedInfo.summary_of_findings,
        is_cited: true
      };

      if (!commitment.next_actions) {
        commitment.next_actions = [];
      }

      // Prepend the gathered unblocking action so it shows up first!
      commitment.next_actions = [newAction, ...commitment.next_actions];

      await saveCommitmentForRequest(req, commitment);

      res.json(commitment);

    } catch (error: any) {
      console.error("Gather Info Error:", error);
      res.status(500).json({ error: error.message || 'Failed to gather info or locate relevant links.' });
    }
  });

  // GATHER INFO / DRAFT PLAN FOR EXTREION AGENT/PLAN MODE
  app.post('/api/commitments/:id/agent/plan', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    try {
      const client = getGeminiClient();

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          plan: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                step_number: { type: Type.INTEGER },
                step_title: { type: Type.STRING },
                tool_choice: { 
                  type: Type.STRING, 
                  description: "Must be: 'search' (Google Search), 'browse' (URL Context), or 'generate' (Code/Draft Generation)." 
                },
                description: { type: Type.STRING }
              },
              required: ["step_number", "step_title", "tool_choice", "description"]
            },
            description: "A 3-5 step plan to research, browse, and generate high-fidelity unblocking solutions."
          }
        },
        required: ["plan"]
      };

      const result = await client.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: `Decompose this commitment into a multi-step research or draft plan:
Task: "${commitment.title}"
Context: "${commitment.source || ''}"
Consequence: "${commitment.consequence}"
Deadline: ${commitment.deadline}

Please draft a 3 to 5 step expert plan. Associate each step with one of: 'search', 'browse', or 'generate'. Ensure the plan starts from research (search), reads sources (browse), and writes a draft (generate) to unblock task initiation anxiety.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema
        }
      });

      const textOutput = result.text;
      if (!textOutput) {
        throw new Error("Gemini returned an empty result.");
      }

      const parsedPlan = JSON.parse(textOutput);
      commitment.agent_state = {
        status: 'planning',
        plan: parsedPlan.plan,
        steps_log: []
      };

      await saveCommitmentForRequest(req, commitment);

      res.json(commitment);

    } catch (error: any) {
      console.error("Agent Plan Error:", error);
      res.status(500).json({ error: error.message || 'Failed to generate agent plan.' });
    }
  });

  // EXECUTE EXPERT AGENT IN REMOTE SANDBOX
  app.post('/api/commitments/:id/agent/execute', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    if (!commitment.agent_state || !commitment.agent_state.plan) {
      res.status(400).json({ error: 'Please generate a plan first.' });
      return;
    }

    // Mark as running
    commitment.agent_state.status = 'running';
    commitment.agent_state.steps_log = [
      {
        type: 'thought',
        title: 'Provisioning Agent Environment',
        text: 'Booting a secure, isolated sandboxed Linux container in Google Cloud...'
      }
    ];
    await saveCommitmentForRequest(req, commitment);

    try {
      const client = getGeminiClient();

      const planStr = commitment.agent_state.plan
        .map(p => `- Step ${p.step_number}: [Tool: ${p.tool_choice}] ${p.step_title} - ${p.description}`)
        .join('\n');

      const prompt = `You are a high-level administrative autonomous agent operating inside a secure sandbox with full bash/python execution, Google Search, URL content reading, and file writes.

Your task is to execute this plan for the user:
Task: "${commitment.title}"
Context: "${commitment.source || ''}"

Plan to execute:
${planStr}

Please behave as a fully autonomous agent:
1. Decompose the request into individual automated actions.
2. For each step, call google search or file management or execute code to gather correct parameters.
3. Observe the outputs and results of each test or query.
4. Continue looping until the tasks are fully complete.
5. Create a professional artifact representing your work.

At the end of your run, serialize your final drafted work and next-step actions as a JSON container strictly in this format:
\`\`\`json
{
  "unblocked_draft": "Your high-fidelity customized markdown formatted artifact or research findings based on actual live information...",
  "unblocked_actions": [
    "Check specific item", "Verify deadline of PROF/PAYEE on official URL", "Complete setup using code info"
  ]
}
\`\`\`
Do not write any text after the JSON container. Ensure the draft resolves procrastination.`;

      const interaction = await client.interactions.create({
        agent: "antigravity-preview-05-2026",
        input: prompt,
        environment: "remote"
      }, { timeout: 300000 });

      // Build step log
      const stepsLog: AgentStepsLog[] = [
        {
          type: 'thought',
          title: 'Container Sandbox Provisioned',
          text: `Container active in secure cloud remote sandbox (Env: ${interaction.environment_id || 'remote'}).`
        }
      ];

      if (interaction.steps) {
        for (const step of interaction.steps) {
          const s = step as any;
          if (step.type === 'thought') {
            const sum = typeof s.thought === 'string' ? s.thought : (s.thought?.summary || s.thought?.text || 'Analyzing next objectives...');
            stepsLog.push({
              type: 'thought',
              title: 'Agent Reason',
              text: sum
            });
          } else if (step.type === 'google_search_call') {
            stepsLog.push({
              type: 'search',
              title: 'Model Google Search Request',
              text: s.google_search_call?.query || 'Initializing web search...'
            });
          } else if (step.type === 'google_search_result') {
            stepsLog.push({
              type: 'search',
              title: 'Model Search Grounding Complete',
              text: 'Retrieved matching web portals, pages, schedules, or login URLs from Google Search Grounding.'
            });
          } else if (step.type === 'code_execution_call') {
            stepsLog.push({
              type: 'code_execution',
              title: 'Executing Python Code in Container',
              text: s.code_execution_call?.code || 'Running script...'
            });
          } else if (step.type === 'code_execution_result') {
            stepsLog.push({
              type: 'code_execution',
              title: 'Python Output Log',
              text: s.code_execution_result?.output || 'Execution complete.'
            });
          } else if (step.type === 'url_context_call') {
            stepsLog.push({
              type: 'browse',
              title: 'Retrieved Document/URL Context',
              text: s.url_context_call?.url || 'Reading content...'
            });
          } else if (step.type === 'model_output') {
            const textContent = s.content?.find((c: any) => c.type === 'text')?.text || '';
            if (textContent) {
              stepsLog.push({
                type: 'output',
                title: 'Agent Progress Observation',
                text: textContent.substring(0, 400) + (textContent.length > 400 ? '...' : '')
              });
            }
          }
        }
      }

      // Collect all text from model_output
      let fullOutput = "";
      for (const step of interaction.steps) {
        if (step.type === 'model_output') {
          const textContent = step.content?.find(c => c.type === 'text');
          if (textContent && textContent.text) {
            fullOutput += textContent.text;
          }
        }
      }

      // Parse JSON from output
      let unblockedDraft = "";
      let unblockedActions: string[] = [];

      const jsonMatch = fullOutput.match(/```json\s*([\s\S]*?)\s*```/) || fullOutput.match(/([\{\[][\s\S]*[\}\]])/);
      if (jsonMatch) {
        try {
          const cleaned = jsonMatch[1].trim();
          const parsed = JSON.parse(cleaned);
          unblockedDraft = parsed.unblocked_draft || "";
          unblockedActions = parsed.unblocked_actions || [];
        } catch (err) {
          console.error("Agent JSON parser failed:", err);
          unblockedDraft = fullOutput;
        }
      } else {
        unblockedDraft = fullOutput;
      }

      // If we didn't specify or parse any actions, fallback
      if (unblockedActions.length === 0) {
        unblockedActions = [
          "Review agent draft and check official resources",
          "Apply findings directly to commitment"
        ];
      }

      commitment.agent_state = {
        status: 'completed',
        plan: commitment.agent_state.plan,
        steps_log: stepsLog,
        proposed_draft: unblockedDraft,
        proposed_actions: unblockedActions
      };

      await saveCommitmentForRequest(req, commitment);

      res.json(commitment);

    } catch (error: any) {
      console.error("Agent Execute Error:", error);
      
      const failedSteps = commitment.agent_state?.steps_log || [];
      failedSteps.push({
        type: 'output',
        title: 'Agent Failed',
        text: `Error raised: ${error.message || 'Unknown network error. Confirm your API key has access to Antigravity agents.'}`
      });

      commitment.agent_state = {
        status: 'failed',
        plan: commitment.agent_state?.plan,
        steps_log: failedSteps
      };

      await saveCommitmentForRequest(req, commitment);

      res.status(500).json({ 
        error: error.message || 'Failed to execute agent mode.',
        commitment
      });
    }
  });

  // USER APPROVES AND MERGES AGENT MODE RESULTS
  app.post('/api/commitments/:id/agent/approve-merge', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];

    if (!commitment.agent_state || !commitment.agent_state.proposed_draft) {
      res.status(400).json({ error: 'No proposed results available to apply.' });
      return;
    }

    // Capture first move artifact
    commitment.artifact = {
      type: commitment.artifact?.type || 'general',
      title: `Expert Agent-Drafted Solution`,
      draft: commitment.agent_state.proposed_draft,
      approved: true
    };

    // Convert proposed actions into list of actions
    if (commitment.agent_state.proposed_actions) {
      const parentId = commitment.id;
      const parsedActions: NextAction[] = commitment.agent_state.proposed_actions.map((text, i) => ({
        id: `na-agent-${parentId}-${Date.now()}-${i}`,
        text: text,
        completed: false,
        is_cited: true,
        source_title: "Expert Agent Run"
      }));

      commitment.next_actions = [...parsedActions, ...(commitment.next_actions || [])];
    }

    // Reset agent state
    commitment.agent_state = undefined;

    await saveCommitmentForRequest(req, commitment);

    res.json(commitment);
  });

  // RESET AGENT STATE
  app.post('/api/commitments/:id/agent/reset', async (req, res) => {
    const { id } = req.params;
    const list = await getCommitmentsForRequest(req);
    const index = list.findIndex(c => c.id === id);

    if (index === -1) {
      res.status(404).json({ error: 'Commitment not found.' });
      return;
    }

    const commitment = list[index];
    commitment.agent_state = undefined;

    await saveCommitmentForRequest(req, commitment);

    res.json(commitment);
  });

  // Vite Integration
  if (!isProd) {
    console.log("Configuring development Vite middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log("Configuring production static file serving...");
    app.use(express.static(path.resolve('dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Clutch Server listening on http://0.0.0.0:${port}`);
  });

  // Attach WebSocket Server for Gemini Live Companion
  const wss = new WebSocketServer({ server, path: '/api/live-body-double' });

  wss.on('connection', async (clientWs, req) => {
    console.log('Gemini Live Voice Companion Client connected via WebSocket.');
    
    // Parse voice preference from query param, default to Zephyr
    let requestedVoice = 'Zephyr';
    if (req.url) {
      try {
        const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const v = urlParams.searchParams.get('voice');
        if (v) requestedVoice = v;
      } catch (e) {
        // Fallback
      }
    }

    let session: any = null;

    try {
      const client = getGeminiClient();
      console.log(`Initiating Gemini Live connected stream with voice: ${requestedVoice}...`);
      
      session = await client.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: ['audio' as any],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: requestedVoice } }
          },
          systemInstruction: "You are a quiet, reassuring, gentle, and utterly non-judgmental 'Body-Double' work/study voice companion. The user has started a focus block. Greet them warmly and extremely briefly, ask what very small bite-sized starting task they will direct their focus towards right now, stay supportive, keep answers short (under 2 sentences) and calm. When they check in, celebrate any progress they have made gently."
        },
        callbacks: {
          onmessage: (message: any) => {
            // Check for audio chunks
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: 'audio', audio }));
            }
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }
          }
        }
      });

      clientWs.send(JSON.stringify({ type: 'status', status: 'ready', message: 'Successfully established Gemini Live link' }));

    } catch (err: any) {
      console.error('Failed to boot Gemini Live link:', err);
      clientWs.send(JSON.stringify({ type: 'error', error: err.message || 'Error triggering Gemini Live connection' }));
      clientWs.close();
      return;
    }

    clientWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio && session) {
          // Send 16kHz PCM audio chunk to Gemini Live stream
          await session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' }
          });
        }
        if (msg.text && session) {
          // Supports user text messaging fallback if mic is blocked!
          await session.sendRealtimeInput({
            text: msg.text
          });
        }
      } catch (err) {
        console.error('Error dealing with incoming client socket chunk:', err);
      }
    });

    clientWs.on('close', () => {
      console.log('Gemini Live Voice Companion Client disconnected.');
      if (session) {
        try {
          session.close();
        } catch (e) {
          // ignore
        }
      }
    });
  });
}

startServer();
