import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = "gemini-4-hydrogen";

function createAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function formatTimecode(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function mapGeminiError(error: unknown): { status: number; message: string } {
  const errObj = error as { status?: number; message?: string; code?: number };
  const status = errObj?.status || errObj?.code || 500;
  const rawMessage = errObj?.message || "Terjadi kesalahan pada layanan AI.";

  if (
    rawMessage.includes("API_KEY_INVALID") ||
    rawMessage.includes("PERMISSION_DENIED") ||
    status === 403
  ) {
    return {
      status: 403,
      message:
        "API key Gemini tidak valid atau belum memiliki izin. Silakan periksa API key Anda di panel Settings > Secrets.",
    };
  }

  if (rawMessage.includes("RESOURCE_EXHAUSTED") || status === 429) {
    return {
      status: 429,
      message:
        "Kuota permintaan Gemini API sedang penuh. Tunggu beberapa saat lalu coba lagi, atau periksa kuota di Settings > Secrets.",
    };
  }

  if (rawMessage.includes("NOT_FOUND") || status === 404) {
    return {
      status: 404,
      message:
        "Model Gemini yang diminta tidak ditemukan atau belum tersedia. Silakan coba lagi.",
    };
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    message: rawMessage,
  };
}

const DIRECTOR_SYSTEM_INSTRUCTION = `You are an elite AI video concept director, director of photography (DP), and AI video prompt engineer.
Your core job: Whenever the user provides a story idea (in Indonesian or any language), break it down into a cohesive sequence of 10-second scenes.

CRITICAL RULES:
1. Every single scene MUST be engineered specifically as a 10-second continuous video clip (00:00–00:10, 00:10–00:20, etc.).
2. Write all narrative explanations for the human creator in crisp, natural Indonesian (title, logline, visualContinuity.summaryId, titleId, narrativeBeatId, audioCueId).
3. Write ALL video generation fields in hyper-detailed, vivid, production-ready ENGLISH so the user can paste them directly into AI video generators (Google Veo, OpenAI Sora, Runway Gen-4, Kling AI, Luma Dream Machine):
   - visualContinuity (characterGuide, environmentPalette, lensAndFilmStock, lightingSignature): Specific English continuity anchors so characters, wardrobe, props, color grading, and optics remain consistent across all 10-second clips.
   - visualDescription (English): Describe exact subject appearance & wardrobe, setting textures, micro-actions choreographed across the 10-second timeline (explicitly pacing early 0-3s, mid 3-7s, and closing 7-10s action), physical lighting quality (key/fill/rim, motivated practicals, color temperature), atmosphere (particles, mist, reflections), and color grade. Minimum 70 words per scene.
   - cameraMovement (English): Specify exact shot framing, focal length & lens character (e.g., "35mm anamorphic prime, shallow depth of field f/2.0"), camera rig & movement trajectory (e.g., "motorized dolly slow push-in", "low-angle gimbal tracking shot circling 30 degrees"), motion speed, and focus transitions (e.g., "smooth rack focus from foreground raindrop to subject's eyes").
   - readyToPastePrompt (English): A single cohesive, ready-to-paste paragraph tailored to the user's selected targetPlatform and aspectRatio that seamlessly combines the 10-second visual action, subject/wardrobe details, camera movement, lens/lighting, and cinematic mood without any markdown headers, bullet points, or meta-chatter. Keep it clean, dense, and immediately usable in an AI video prompt box.
4. Ensure strong narrative progression from scene 1 through the final scene, with clear visual transitions between consecutive 10-second segments.`;

const sceneProperties = {
  sceneNumber: {
    type: Type.INTEGER,
    description: "Sequential 1-based scene number.",
  },
  titleId: {
    type: Type.STRING,
    description: "Concise scene title in Indonesian.",
  },
  narrativeBeatId: {
    type: Type.STRING,
    description:
      "Clear explanation in Indonesian of what happens in this 10-second beat and its narrative purpose.",
  },
  shotType: {
    type: Type.STRING,
    description:
      "Standard English cinematography shot size (e.g. Wide Establishing Shot, Medium Tracking Shot, Close-Up).",
  },
  cameraMovement: {
    type: Type.STRING,
    description:
      "Highly detailed English camera movement, lens focal length, rig type, speed, and focus pull instruction.",
  },
  visualDescription: {
    type: Type.STRING,
    description:
      "Ultra-detailed English visual description covering subject, wardrobe continuity, environment, lighting, atmosphere, and 0-3s / 3-7s / 7-10s micro-action.",
  },
  readyToPastePrompt: {
    type: Type.STRING,
    description:
      "Single cohesive, ready-to-paste English prompt optimized for the target AI video generator, combining visual description, 10-second temporal motion, camera movement, and lighting.",
  },
  audioCueId: {
    type: Type.STRING,
    description: "Sound design, ambience, and pacing cue in Indonesian.",
  },
};

const continuitySchema = {
  type: Type.OBJECT,
  properties: {
    summaryId: {
      type: Type.STRING,
      description:
        "Brief Indonesian summary of the visual direction and continuity strategy.",
    },
    characterGuide: {
      type: Type.STRING,
      description:
        "Detailed English character/subject appearance and wardrobe lock for cross-scene consistency.",
    },
    environmentPalette: {
      type: Type.STRING,
      description:
        "Detailed English setting architecture and color palette anchor.",
    },
    lensAndFilmStock: {
      type: Type.STRING,
      description:
        "English camera optics, focal lengths, grain, and texture profile.",
    },
    lightingSignature: {
      type: Type.STRING,
      description:
        "English lighting setup, contrast ratio, and atmospheric signature.",
    },
  },
  required: [
    "summaryId",
    "characterGuide",
    "environmentPalette",
    "lensAndFilmStock",
    "lightingSignature",
  ],
};

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/concept/generate", async (req, res) => {
    const ai = createAiClient();
    if (!ai) {
      res.status(500).json({
        error:
          "GEMINI_API_KEY belum tersedia. Silakan atur kunci API Anda di panel Settings > Secrets.",
      });
      return;
    }

    const {
      storyIdea,
      targetPlatform = "Universal",
      aspectRatio = "16:9",
      visualStyle = "Photorealistic Cinema",
      sceneCount = 4,
    } = req.body ?? {};

    if (typeof storyIdea !== "string" || storyIdea.trim().length < 8) {
      res.status(400).json({
        error:
          "Ide cerita terlalu singkat. Tuliskan minimal satu kalimat cerita agar dapat dipecah menjadi adegan 10 detik.",
      });
      return;
    }

    const clampedCount = Math.min(Math.max(Number(sceneCount) || 4, 2), 10);

    try {
      const prompt = `Story Idea:
"""
${storyIdea.trim()}
"""

Production Parameters:
- Exact number of 10-second scenes to generate: ${clampedCount} scenes (total ${clampedCount * 10} seconds)
- Target AI Video Generator: ${targetPlatform}
- Aspect Ratio: ${aspectRatio}
- Visual Style Direction: ${visualStyle}

Break this story down into exactly ${clampedCount} sequential 10-second scenes that form a complete, emotionally resonant narrative arc. Ensure the readyToPastePrompt for each scene is immediately copy-pasteable into ${targetPlatform} with ${aspectRatio} framing and ${visualStyle} aesthetics.`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: DIRECTOR_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: {
                type: Type.STRING,
                description: "Compelling project title in Indonesian.",
              },
              logline: {
                type: Type.STRING,
                description: "Concise 1-2 sentence Indonesian logline.",
              },
              visualContinuity: continuitySchema,
              scenes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: sceneProperties,
                  required: [
                    "sceneNumber",
                    "titleId",
                    "narrativeBeatId",
                    "shotType",
                    "cameraMovement",
                    "visualDescription",
                    "readyToPastePrompt",
                    "audioCueId",
                  ],
                },
              },
            },
            required: ["title", "logline", "visualContinuity", "scenes"],
          },
        },
      });

      const rawText = (response.text ?? "").trim();
      const parsed = JSON.parse(rawText);
      const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];

      const normalizedScenes = scenes.map((s: Record<string, unknown>, idx: number) => {
        const startSec = idx * 10;
        const endSec = (idx + 1) * 10;
        return {
          id: `scene-${Date.now()}-${idx + 1}`,
          sceneNumber: idx + 1,
          timecodeStart: formatTimecode(startSec),
          timecodeEnd: formatTimecode(endSec),
          titleId: String(s.titleId ?? `Adegan ${idx + 1}`),
          narrativeBeatId: String(s.narrativeBeatId ?? ""),
          shotType: String(s.shotType ?? "Medium Shot"),
          cameraMovement: String(s.cameraMovement ?? ""),
          visualDescription: String(s.visualDescription ?? ""),
          readyToPastePrompt: String(s.readyToPastePrompt ?? ""),
          audioCueId: String(s.audioCueId ?? ""),
        };
      });

      res.json({
        id: `concept-${Date.now()}`,
        createdAt: new Date().toISOString(),
        storyIdea: storyIdea.trim(),
        targetPlatform,
        aspectRatio,
        visualStyle,
        title: parsed.title || "Konsep Video Tanpa Judul",
        logline: parsed.logline || "",
        totalDurationSeconds: normalizedScenes.length * 10,
        visualContinuity: parsed.visualContinuity,
        scenes: normalizedScenes,
      });
    } catch (error) {
      const mapped = mapGeminiError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/concept/refine-scene", async (req, res) => {
    const ai = createAiClient();
    if (!ai) {
      res.status(500).json({
        error:
          "GEMINI_API_KEY belum tersedia. Silakan atur kunci API Anda di panel Settings > Secrets.",
      });
      return;
    }

    const {
      projectTitle,
      targetPlatform = "Universal",
      aspectRatio = "16:9",
      visualStyle = "Photorealistic Cinema",
      visualContinuity,
      scene,
      instruction,
    } = req.body ?? {};

    if (!scene || typeof instruction !== "string" || !instruction.trim()) {
      res.status(400).json({
        error: "Masukkan instruksi perbaikan adegan terlebih dahulu.",
      });
      return;
    }

    try {
      const prompt = `Project: "${projectTitle}"
Target AI Video Generator: ${targetPlatform}
Aspect Ratio: ${aspectRatio}
Visual Style: ${visualStyle}

Visual Continuity Anchors (MUST preserve):
- Character Guide: ${visualContinuity?.characterGuide ?? ""}
- Environment Palette: ${visualContinuity?.environmentPalette ?? ""}
- Lens & Film Stock: ${visualContinuity?.lensAndFilmStock ?? ""}
- Lighting Signature: ${visualContinuity?.lightingSignature ?? ""}

Current 10-Second Scene (${scene.timecodeStart} - ${scene.timecodeEnd}):
- Title: ${scene.titleId}
- Narrative Beat: ${scene.narrativeBeatId}
- Shot Type: ${scene.shotType}
- Camera Movement: ${scene.cameraMovement}
- Visual Description: ${scene.visualDescription}

Director's Revision Instruction:
"""
${instruction.trim()}
"""

Rewrite this single 10-second scene incorporating the revision instruction while strictly maintaining visual continuity with the rest of the film.`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: DIRECTOR_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: sceneProperties,
            required: [
              "sceneNumber",
              "titleId",
              "narrativeBeatId",
              "shotType",
              "cameraMovement",
              "visualDescription",
              "readyToPastePrompt",
              "audioCueId",
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? "{}").trim());

      res.json({
        scene: {
          id: scene.id,
          sceneNumber: scene.sceneNumber,
          timecodeStart: scene.timecodeStart,
          timecodeEnd: scene.timecodeEnd,
          titleId: String(parsed.titleId ?? scene.titleId),
          narrativeBeatId: String(parsed.narrativeBeatId ?? scene.narrativeBeatId),
          shotType: String(parsed.shotType ?? scene.shotType),
          cameraMovement: String(parsed.cameraMovement ?? scene.cameraMovement),
          visualDescription: String(parsed.visualDescription ?? scene.visualDescription),
          readyToPastePrompt: String(parsed.readyToPastePrompt ?? scene.readyToPastePrompt),
          audioCueId: String(parsed.audioCueId ?? scene.audioCueId),
        },
      });
    } catch (error) {
      const mapped = mapGeminiError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/concept/extend-scene", async (req, res) => {
    const ai = createAiClient();
    if (!ai) {
      res.status(500).json({
        error:
          "GEMINI_API_KEY belum tersedia. Silakan atur kunci API Anda di panel Settings > Secrets.",
      });
      return;
    }

    const {
      projectTitle,
      logline,
      targetPlatform = "Universal",
      aspectRatio = "16:9",
      visualStyle = "Photorealistic Cinema",
      visualContinuity,
      previousScenes = [],
      directionNote = "",
    } = req.body ?? {};

    if (!Array.isArray(previousScenes) || previousScenes.length === 0) {
      res.status(400).json({
        error: "Minimal satu adegan sebelumnya diperlukan untuk melanjutkan cerita.",
      });
      return;
    }

    const nextNumber = previousScenes.length + 1;
    const startSec = previousScenes.length * 10;
    const endSec = nextNumber * 10;
    const recentSummary = previousScenes
      .slice(-3)
      .map(
        (s: { sceneNumber: number; titleId: string; narrativeBeatId: string }) =>
          `Scene ${s.sceneNumber} (${s.titleId}): ${s.narrativeBeatId}`
      )
      .join("\n");

    try {
      const prompt = `Project: "${projectTitle}"
Logline: ${logline}
Target AI Video Generator: ${targetPlatform}
Aspect Ratio: ${aspectRatio}
Visual Style: ${visualStyle}

Visual Continuity Anchors (MUST preserve):
- Character Guide: ${visualContinuity?.characterGuide ?? ""}
- Environment Palette: ${visualContinuity?.environmentPalette ?? ""}
- Lens & Film Stock: ${visualContinuity?.lensAndFilmStock ?? ""}
- Lighting Signature: ${visualContinuity?.lightingSignature ?? ""}

Recent Scenes Context:
${recentSummary}

${directionNote ? `Director's Direction for Next 10s Scene:\n${directionNote}` : "Create the next natural 10-second continuation scene that escalates or resolves the story smoothly."}

Generate Scene ${nextNumber} (${formatTimecode(startSec)} - ${formatTimecode(endSec)}).`;

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: DIRECTOR_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: sceneProperties,
            required: [
              "sceneNumber",
              "titleId",
              "narrativeBeatId",
              "shotType",
              "cameraMovement",
              "visualDescription",
              "readyToPastePrompt",
              "audioCueId",
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? "{}").trim());

      res.json({
        scene: {
          id: `scene-${Date.now()}-${nextNumber}`,
          sceneNumber: nextNumber,
          timecodeStart: formatTimecode(startSec),
          timecodeEnd: formatTimecode(endSec),
          titleId: String(parsed.titleId ?? `Adegan ${nextNumber}`),
          narrativeBeatId: String(parsed.narrativeBeatId ?? ""),
          shotType: String(parsed.shotType ?? "Medium Shot"),
          cameraMovement: String(parsed.cameraMovement ?? ""),
          visualDescription: String(parsed.visualDescription ?? ""),
          readyToPastePrompt: String(parsed.readyToPastePrompt ?? ""),
          audioCueId: String(parsed.audioCueId ?? ""),
        },
      });
    } catch (error) {
      const mapped = mapGeminiError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) => {
      const indexFile = path.join(distDir, "index.html");
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send("Build artifacts not found. Run npm run build first.");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Sineframe Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
