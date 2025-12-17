import { GoogleGenAI, Type, Schema } from "@google/genai";
import {
  ModelId,
  GenerationMethod,
  Resource,
  TokenUsage,
  RefinementConfig,
  StepConfig,
  Annotation,
  EvaluationCategory,
  GroundingEntry,
} from "../types";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

interface PromptBuilderOptions {
  taskPrompt: string;
  resources: Resource[];
  systemInstruction?: string;
  refinementContext?: {
    originalText: string;
    annotations: Annotation[];
    config: RefinementConfig;
  };
  stepConfig?: StepConfig;
}

interface GenerationResult {
  text: string;
  thoughts?: string[];
  tokenUsage?: TokenUsage;
}

/**
 * Safely extract the full text from a GenerateContentResponse.
 */
const extractTextFromResponse = (response: any): string => {
  if (typeof response.text === "string" && response.text.length > 0) {
    return response.text.trim();
  }

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
};

/**
 * Some models occasionally drop the leading "[[" or misuse /TEXT when
 * closing the THOUGHT block. Normalize those quirks so the parser can recover.
 */
const normalizeStepTags = (input: string): string => {
  let normalized = input || "";

  const ensureBracket = (pattern: RegExp, tag: string) => {
    normalized = normalized.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${tag}`,
    );
  };

  ensureBracket(/(^|[^\[])\s*(THOUGHT\]\])/gi, "[[THOUGHT]]");
  ensureBracket(/(^|[^\[])\s*(\/THOUGHT\]\])/gi, "[[/THOUGHT]]");
  ensureBracket(/(^|[^\[])\s*(TEXT\]\])/gi, "[[TEXT]]");
  ensureBracket(/(^|[^\[])\s*(\/TEXT\]\])/gi, "[[/TEXT]]");

  return normalized;
};

interface ParsedStepSegment {
  thought: string;
  text: string;
}

const parseStepByStepSegments = (
  input: string,
): ParsedStepSegment[] => {
  const normalized = normalizeStepTags(input);
  const tagRegex = /\[\[\s*(\/)?\s*(THOUGHT|TEXT)\s*\]\]/gi;
  const segments: ParsedStepSegment[] = [];

  let currentThought = "";
  let currentText = "";
  let readingThought = false;
  let readingText = false;
  let lastIndex = 0;

  const flushSegment = () => {
    const thought = currentThought.trim();
    const text = currentText.trim();
    if (thought || text) {
      segments.push({ thought, text });
    }
    currentThought = "";
    currentText = "";
    readingThought = false;
    readingText = false;
  };

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(normalized)) !== null) {
    const chunk = normalized.slice(lastIndex, match.index);

    if (readingThought) {
      currentThought += chunk;
    } else if (readingText) {
      currentText += chunk;
    }

    lastIndex = match.index + match[0].length;

    const isClosing = Boolean(match[1]);
    const tagName = (match[2] || "").toUpperCase();

    if (!isClosing) {
      if (tagName === "THOUGHT") {
        if (readingText || currentText.trim()) {
          flushSegment();
        }
        readingThought = true;
        readingText = false;
      } else if (tagName === "TEXT") {
        if (readingText && (currentThought.trim() || currentText.trim())) {
          flushSegment();
        }
        if (readingThought && !currentText.trim()) {
          readingThought = false;
        }
        readingText = true;
      }
    } else {
      if (tagName === "THOUGHT") {
        readingThought = false;
      } else if (tagName === "TEXT") {
        if (readingThought && !readingText && !currentText.trim()) {
          // Some models close THOUGHT blocks with [[/TEXT]].
          readingThought = false;
          continue;
        }
        if (readingText) {
          readingText = false;
          flushSegment();
        } else if (currentThought.trim() || currentText.trim()) {
          flushSegment();
        }
      }
    }
  }

  const remainder = normalized.slice(lastIndex);
  if (readingThought) {
    currentThought += remainder;
  } else if (readingText) {
    currentText += remainder;
  }

  if (currentThought.trim() || currentText.trim()) {
    flushSegment();
  }

  if (segments.length === 0 && normalized.trim()) {
    return [{ thought: "", text: normalized.trim() }];
  }

  return segments;
};

export const buildFullPrompt = (options: PromptBuilderOptions): string => {
  const { taskPrompt, resources, refinementContext, stepConfig } = options;

  let prompt = "";

  // 1. Context Resources
  const activeResources = refinementContext
    ? resources.filter((r) => refinementContext.config.activeResourceIds.includes(r.id))
    : resources.filter((r) => r.enabled);

  if (activeResources.length > 0) {
    prompt += `=== ARCHIVAL CONTEXT & RESOURCES ===\n`;
    prompt += activeResources
      .map((r) => {
        let block = `--- [ID: ${r.id}] ${r.name} ---`;
        if (r.usageInstruction) {
          block += `\n[HOW TO USE]: ${r.usageInstruction}`;
        }
        block += `\n${r.content}`;
        return block;
      })
      .join("\n\n");
    prompt += `\n========================\n\n`;
  }

  // 2. Refinement Data
  if (refinementContext) {
    const { originalText, annotations, config } = refinementContext;

    if (config.includeOriginalText) {
      prompt += `=== ORIGINAL TEXT TO REFINE ===\n${originalText}\n\n`;
    }

    let feedbackBlock = "";

    if (config.includeAiAnnotations) {
      // Accept both interactive AI annotations and evaluator-generated ones from experiment runs
      const aiAnnos = annotations.filter(
        (a) =>
          a.author === "AI" ||
          a.author === "AI_EVALUATOR" ||
          (a.author || "").startsWith("AI")
      );
      if (aiAnnos.length > 0) {
        feedbackBlock += `--- AI CRITIQUE ---\n${aiAnnos
          .map((a) => `[${a.level}] "${a.quote}": ${a.comment}`)
          .join("\n")}\n`;
      }
    }

    if (config.includeHumanAnnotations) {
      const humanAnnos = annotations.filter((a) => a.author !== "AI");
      if (humanAnnos.length > 0) {
        feedbackBlock += `--- HUMAN REVIEWER NOTES ---\n${humanAnnos
          .map(
            (a) =>
              `[${a.level}] ${a.author} says regarding "${a.quote}": ${a.comment}`,
          )
          .join("\n")}\n`;
      }
    }

    if (feedbackBlock) {
      prompt += `=== FEEDBACK & CRITIQUE ===\n${feedbackBlock}\n\n`;
    }
  }

  // 3. Task Instructions
  prompt += `=== INSTRUCTIONS ===\n${taskPrompt}`;

  // 4. Step by step instructions
  if (stepConfig) {
    prompt += `

  [SYSTEM MODE: STEP-BY-STEP GENERATION]
  You are generating a narrative in discrete chunks that will be parsed automatically.
  This is NOT interactive. Do NOT stop after the first segment. Generate all the segment to acheieve the desired target length given the segment size that follow.
  Target Chunk Size: ${stepConfig.stepSize}.

  For EACH segment, follow exactly this format:

  [[THOUGHT]]
  1. Analyze the previous text (if any).
  2. DECISION:
    - "ACTION: CONTINUE" -> If the story is flowing well.
    - "ACTION: REWRITE" -> If the previous chunk had errors, style issues, or drift.
  3. Explain your decision and plan the next segment.
  [[/THOUGHT]]

  [[TEXT]]
  Write the next segment of the story here.
  [[/TEXT]]
  `;

    if (stepConfig.enableSelfCorrection) {
      prompt += `

[SELF-CORRECTION PROTOCOL ACTIVE]:
${stepConfig.selfCorrectionInstruction ||
  "You are explicitly authorized to rewrite history if the coherence drifts. Monitor your own output."}`;
    }
  }

  return prompt;
};

export const buildEvaluationPrompt = (
  text: string,
  resources: Resource[],
  categories: EvaluationCategory[],
  masterPromptTemplate: string,
): string => {
  let prompt = masterPromptTemplate || "";

  const activeResources = resources.filter((r) => r.enabled);
  const contextBlock =
    activeResources.length > 0
      ? activeResources
          .map((r) => `[ID: ${r.id}] ${r.name}:\n${r.content}`)
          .join("\n\n")
      : "No specific resources provided.";

  const criteriaDescription = categories
    .map((c) => `- ${c.name}: ${c.description}`)
    .join("\n");

  prompt = prompt.replace(/{{TEXT}}/g, text || "");
  prompt = prompt.replace(/{{CRITERIA}}/g, criteriaDescription);
  prompt = prompt.replace(/{{CONTEXT}}/g, contextBlock);

  return prompt;
};

export const generateNarrative = async (
  fullPrompt: string,
  systemInstruction: string,
  modelId: string,
  method: GenerationMethod,
): Promise<GenerationResult> => {
  const ai = getAI();

  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: fullPrompt,
      config: {
        systemInstruction,
        temperature: 0.7,
        // give the model room so long passages are less likely to be cut
        maxOutputTokens:  65536,
      },
    });

    // token usage from Gemini
    const usage = response.usageMetadata;
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          promptTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        }
      : undefined;

    // full text from response
    const rawText = extractTextFromResponse(response);

    // Step by step parsing
    if (method === GenerationMethod.STEP_BY_STEP) {
      const segments = parseStepByStepSegments(rawText);
      const thoughts = segments.map((s) => s.thought).filter(Boolean);
      const textSegments = segments.map((s) => s.text).filter(Boolean);

      const cleanedText =
        textSegments.length > 0
          ? textSegments.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()
          : rawText.trim();

      return { text: cleanedText, thoughts, tokenUsage };
    }

    // non step by step modes
    return { text: rawText, thoughts: [], tokenUsage };
  } catch (error) {
    console.error("Generation Error:", error);
    throw error;
  }
};

export const evaluateCoherence = async (
  text: string,
  resources: Resource[],
  categories: EvaluationCategory[],
  modelId: string,
  masterPromptTemplate: string,
): Promise<{ annotations: any[]; scores: any; tokenUsage?: TokenUsage }> => {
  const ai = getAI();

  const prompt = buildEvaluationPrompt(
    text,
    resources,
    categories,
    masterPromptTemplate,
  );

  const scoreProperties: Record<string, any> = {};
  const scoreRequired: string[] = [];

  categories.forEach((cat) => {
    scoreProperties[cat.id] = {
      type: Type.INTEGER,
      description: `Score (0-100) for ${cat.name}`,
    };
    scoreRequired.push(cat.id);
  });

  const categoryNames = categories.map((c) => c.name);

  const analysisSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      scores: {
        type: Type.OBJECT,
        properties: scoreProperties,
        required: scoreRequired,
      },
      annotations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            quote: {
              type: Type.STRING,
              description:
                "The EXACT, verbatim substring from the text being evaluated. Do not paraphrase. Copy directly.",
            },
            level: {
              type: Type.STRING,
              enum: categoryNames,
              description: "The category of the issue or praise.",
            },
            comment: {
              type: Type.STRING,
              description: "Critique, explanation, or confirmation.",
            },
            sourceId: {
              type: Type.STRING,
              description: "ID of the resource supporting this claim.",
            },
            sourceQuote: {
              type: Type.STRING,
              description:
                "Direct quote from the resource that proves or disproves the text.",
            },
          },
          required: ["quote", "level", "comment"],
        },
      },
    },
    required: ["annotations", "scores"],
  };

  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      },
    });

    // usage tokens de l’appel d’évaluation
    const usage = (response as any).usageMetadata;
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          promptTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          totalTokens: usage.totalTokenCount ?? 0,
        }
      : undefined;

    const jsonText = extractTextFromResponse(response) || "{}";
    const parsed = JSON.parse(jsonText);

    return {
      annotations: parsed.annotations ?? [],
      scores: parsed.scores ?? {},
      tokenUsage,
    };
  } catch (e) {
    console.error("Evaluation failed", e);
    return { annotations: [], scores: {}, tokenUsage: undefined };
  }
};

export const performGrounding = async (
  text: string,
  resources: Resource[],
  modelId: string,
  promptTemplate: string,
): Promise<GroundingEntry[]> => {
  const ai = getAI();
  const activeResources = resources.filter((r) => r.enabled);

  let prompt = promptTemplate;
  const contextBlock =
    activeResources.length > 0
      ? activeResources
          .map(
            (r) =>
              `[ID: ${r.id}] ${r.name}:\n${r.content.substring(0, 2000)}...`,
          )
          .join("\n\n")
      : "No specific resources provided.";

  prompt = prompt.replace(/{{TEXT}}/g, text || "");
  prompt = prompt.replace(/{{CONTEXT}}/g, contextBlock);

  const groundingSchema: Schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        quote: {
          type: Type.STRING,
          description:
            "The exact, verbatim substring from the GENERATED TEXT.",
        },
        resourceId: {
          type: Type.STRING,
          description: "The ID of the resource provided in context.",
        },
        resourceQuote: {
          type: Type.STRING,
          description:
            "The specific sentence or passage from the resource that proves the match.",
        },
        confidence: {
          type: Type.NUMBER,
          description: "Confidence score 0-1.",
        },
      },
      required: ["quote", "resourceId", "resourceQuote"],
    },
  };

  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: groundingSchema,
      },
    });

    const jsonText = extractTextFromResponse(response) || "[]";
    const entries = JSON.parse(jsonText);

    return entries.map((e: any) => ({
      ...e,
      id: crypto.randomUUID(),
      resourceName: resources.find((r) => r.id === e.resourceId)?.name || "Unknown Resource",
    }));
  } catch (e) {
    console.error("Grounding failed", e);
    return [];
  }
};
