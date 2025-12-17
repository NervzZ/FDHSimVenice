    import { 
        ExperimentConfig, DocumentVersion, 
        Resource, GenerationMethod, 
        DEFAULT_EVALUATOR_PROMPT, ExperimentType, DiffStats, StepTokenUsage,
        LlmCallUsage,
        TokenUsage,
        ModelId,
        RefinementConfig,
        ConsistencyReport,
        ConsistencyPairMetric,
        AnnotationConsistencyMetric,
        GradeComparison,
        VariantConsistencyStat
    } from "../types";
    import { generateNarrative, evaluateCoherence, buildFullPrompt } from "./geminiService";
    import { calculateDiffStats } from "./diffService";

// Helper to prevent rate limiting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Consistency helpers ---
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);

const jaccard = (a: Set<string>, b: Set<string>): number => {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const unionSize = new Set([...a, ...b]).size || 1;
  return intersection.size / unionSize;
};

const styleSignature = (text: string) => {
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const tokens = tokenize(text);
  const uniqueTokens = new Set(tokens);
  const avgSentenceLen =
    sentences.length > 0
      ? sentences.reduce((acc, s) => acc + tokenize(s).length, 0) / sentences.length
      : 0;
  const typeTokenRatio = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0;
  return { avgSentenceLen, typeTokenRatio };
};

const quoteOverlapScore = (a: string, b: string): number => {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  return jaccard(setA, setB);
};

const commentSimilarityScore = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const clean = (txt: string) =>
    txt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const ca = clean(a);
  const cb = clean(b);
  if (!ca || !cb) return 0;
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return 1;
  const setA = new Set(tokenize(ca));
  const setB = new Set(tokenize(cb));
  return jaccard(setA, setB);
};

const fallbackAnnotationMatches = (
  annsA: { quote: string; comment: string }[],
  annsB: { quote: string; comment: string }[]
) => {
  const matches: {
    aIndex: number;
    bIndex: number;
    reason: string;
    quoteScore: number;
    commentScore: number;
  }[] = [];
  const usedB = new Set<number>();

  annsA.forEach((annA, idxA) => {
    let bestIdx = -1;
    let bestScore = 0;
    let bestQuote = 0;
    let bestComment = 0;
    let bestReason = '';

    annsB.forEach((annB, idxB) => {
      if (usedB.has(idxB)) return;
      const quoteScore = quoteOverlapScore(annA.quote, annB.quote);
      if (quoteScore < 0.35) return;
      const commentScore = commentSimilarityScore(annA.comment, annB.comment);
      const combined = quoteScore * 0.65 + commentScore * 0.35;
      if (combined > bestScore) {
        bestScore = combined;
        bestIdx = idxB;
        bestQuote = quoteScore;
        bestComment = commentScore;
        bestReason = `Quote overlap ${(quoteScore * 100).toFixed(
          0
        )}%, comment similarity ${(commentScore * 100).toFixed(0)}%`;
      }
    });

    if (bestIdx !== -1) {
      usedB.add(bestIdx);
      matches.push({
        aIndex: idxA,
        bIndex: bestIdx,
        reason: bestReason,
        quoteScore: bestQuote,
        commentScore: bestComment
      });
    }
  });

  return matches;
};

const safeJsonParse = (raw: string): any | null => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const match = raw?.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
};

const normalizeScores = (
  categories: ExperimentConfig['evaluationCategories'],
  rawScores: Record<string, any> | undefined
): Record<string, Record<string, number>> => {
  const result: Record<string, Record<string, number>> = {};
  if (!rawScores) return result;

  Object.keys(rawScores).forEach(key => {
    const score = rawScores[key];
    if (typeof score !== 'number' || Number.isNaN(score)) return;
    const catId =
      categories.find(c => c.id === key || c.name === key)?.id || key;
    result[catId] = { ...(result[catId] || {}), AI: score };
  });

  return result;
};

const matchAnnotationsWithGemini = async (
  annsA: any[],
  annsB: any[],
  modelId: ModelId,
  systemPrompt: string,
  onLog?: (msg: string) => void
) => {
  if (!annsA.length || !annsB.length) {
    return { matches: [], note: 'No annotations to compare.' };
  }

  const trim = (str: string) => (str || '').trim().slice(0, 300);
  const listA = annsA
    .map(
      (a, idx) =>
        `${idx}. [${a.level || 'NA'}] Q:"${trim(a.quote)}" C:"${trim(
          a.comment
        )}"`
    )
    .join('\n');
  const listB = annsB
    .map(
      (a, idx) =>
        `${idx}. [${a.level || 'NA'}] Q:"${trim(a.quote)}" C:"${trim(
          a.comment
        )}"`
    )
    .join('\n');

  const prompt = `You are checking whether annotations from two reviewers describe the SAME issue on the SAME highlighted text.
Only match when the highlighted quotes overlap (or one fully contains the other) AND the comments have the same intent.
Return STRICT JSON:
{ "matches": [ { "aIndex": 0, "bIndex": 1, "reason": "brief why they match" } ] }
Use each annotation at most once. Skip weak matches.`;

  try {
    const { text } = await generateNarrative(
      `${prompt}\n\nLIST A:\n${listA}\n\nLIST B:\n${listB}`,
      systemPrompt || 'You are an impartial annotation judge.',
      modelId,
      GenerationMethod.STANDARD
    );
    const parsed = safeJsonParse(text || '') || {};
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const cleaned = matches
      .map((m: any) => ({
        aIndex: Number(m.aIndex),
        bIndex: Number(m.bIndex),
        reason: m.reason || m.note || ''
      }))
      .filter(
        m =>
          Number.isInteger(m.aIndex) &&
          Number.isInteger(m.bIndex) &&
          m.aIndex >= 0 &&
          m.bIndex >= 0 &&
          m.aIndex < annsA.length &&
          m.bIndex < annsB.length
      );
    return { matches: cleaned, note: cleaned[0]?.reason };
  } catch (err) {
    console.error('Annotation match via Gemini failed', err);
    onLog?.('Annotation match via Gemini failed; using fallback matching.');
    return { matches: [], note: 'Gemini comparison failed, fallback used.' };
  }
};

const compareAnnotations = async (
  annsA: any[],
  annsB: any[],
  modelId: ModelId,
  systemPrompt: string,
  onLog?: (msg: string) => void
) => {
  const fallback = fallbackAnnotationMatches(annsA, annsB);
  let matches = fallback;
  let note = fallback[0]?.reason || '';

  const llmResult = await matchAnnotationsWithGemini(
    annsA,
    annsB,
    modelId,
    systemPrompt,
    onLog
  );

  if (llmResult.matches && llmResult.matches.length > 0) {
    matches = llmResult.matches;
    note = llmResult.note || note;
  }

  const matchedB = new Set(matches.map(m => m.bIndex));
  const shared = matches.length;
  const onlyA = Math.max(annsA.length - shared, 0);
  const onlyB = Math.max(annsB.length - matchedB.size, 0);
  const sharedFraction =
    Math.max(annsA.length, annsB.length) > 0
      ? shared / Math.max(annsA.length, annsB.length)
      : 0;

  let totalQuote = 0;
  let totalComment = 0;
  matches.forEach(m => {
    const qScore = quoteOverlapScore(
      annsA[m.aIndex]?.quote || '',
      annsB[m.bIndex]?.quote || ''
    );
    const cScore = commentSimilarityScore(
      annsA[m.aIndex]?.comment || '',
      annsB[m.bIndex]?.comment || ''
    );
    totalQuote += qScore;
    totalComment += cScore;
  });

  const averageQuoteOverlap =
    shared > 0 ? Number((totalQuote / shared).toFixed(3)) : 0;
  const averageCommentSimilarity =
    shared > 0 ? Number((totalComment / shared).toFixed(3)) : 0;

  return {
    shared,
    onlyA,
    onlyB,
    sharedFraction,
    note,
    averageQuoteOverlap,
    averageCommentSimilarity
  };
};

const buildConsistencyReport = async (
  runs: { label: string; doc: DocumentVersion }[],
  baseline: { label: string; doc: DocumentVersion } | undefined,
  options: {
    annotationJudgeModel: ModelId;
    judgeSystemPrompt: string;
    onLog?: (msg: string) => void;
    annotationOnly?: boolean;
  }
): Promise<ConsistencyReport> => {
  const { annotationJudgeModel, judgeSystemPrompt, onLog, annotationOnly } = options;
  const judgeModel = annotationJudgeModel || ModelId.FLASH_2_5;
  const judgePrompt =
    judgeSystemPrompt || 'You are an impartial annotation judge.';
  const textPairs: ConsistencyPairMetric[] = [];
  const annotationPairs: AnnotationConsistencyMetric[] = [];
  const baselineComparisons: ConsistencyPairMetric[] = [];
  const gradeComparisons: GradeComparison[] = [];
  const variantBreakdown: VariantConsistencyStat[] = [];

  const tokenCache: Record<string, Set<string>> = {};

  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i];
      const b = runs[j];
      const pairLabel = `${a.label} vs ${b.label}`;

      if (!annotationOnly) {
        const tokensA = tokenCache[a.label] || tokenize(a.doc.content);
        const tokensB = tokenCache[b.label] || tokenize(b.doc.content);
        const setA = tokenCache[a.label] || new Set(tokensA);
        const setB = tokenCache[b.label] || new Set(tokensB);
        tokenCache[a.label] = setA;
        tokenCache[b.label] = setB;

        const sigA = styleSignature(a.doc.content);
        const sigB = styleSignature(b.doc.content);
        const styleDelta =
          Math.abs(sigA.avgSentenceLen - sigB.avgSentenceLen) +
          Math.abs(sigA.typeTokenRatio - sigB.typeTokenRatio);

        textPairs.push({
          pairLabel,
          overlap: Number(jaccard(setA, setB).toFixed(3)),
          lengthDelta: Math.abs(a.doc.content.length - b.doc.content.length),
          styleDelta: Number(styleDelta.toFixed(3)),
          uniqueA: [...setA].filter(x => !setB.has(x)).length,
          uniqueB: [...setB].filter(x => !setA.has(x)).length
        });
      }

      const annsA = a.doc.annotations || [];
      const annsB = b.doc.annotations || [];

      const annotationComparison = await compareAnnotations(
        annsA,
        annsB,
        judgeModel,
        judgePrompt,
        onLog
      );

      const avgScore = (doc: DocumentVersion) => {
        const scores = doc.scores || {};
        let total = 0;
        let count = 0;
        Object.values(scores).forEach(cat => {
          if (!cat) return;
          const val = (cat as any)['AI'];
          if (typeof val === 'number' && !Number.isNaN(val)) {
            total += val;
            count += 1;
          }
        });
        return count > 0 ? total / count : 0;
      };

      const scoreDelta = Math.abs(avgScore(a.doc) - avgScore(b.doc));

      annotationPairs.push({
        pairLabel,
        shared: annotationComparison.shared,
        onlyA: annotationComparison.onlyA,
        onlyB: annotationComparison.onlyB,
        sharedFraction: Number(
          (annotationComparison.sharedFraction || 0).toFixed(3)
        ),
        avgScoreDelta: Number(scoreDelta.toFixed(2)),
        agreementNote: annotationComparison.note,
        averageQuoteOverlap: annotationComparison.averageQuoteOverlap,
        averageCommentSimilarity: annotationComparison.averageCommentSimilarity
      });

      // Grade deltas by category
      const categories = new Set([
        ...Object.keys(a.doc.scores || {}),
        ...Object.keys(b.doc.scores || {})
      ]);
      const catDeltas = Array.from(categories).map(cat => {
        const aScore = (a.doc.scores?.[cat] || {}).AI as number | undefined;
        const bScore = (b.doc.scores?.[cat] || {}).AI as number | undefined;
        const delta =
          typeof aScore === 'number' && typeof bScore === 'number'
            ? Math.abs(aScore - bScore)
            : undefined;
        return { category: cat, scoreA: aScore, scoreB: bScore, delta };
      });

      gradeComparisons.push({
        pairLabel,
        categories: catDeltas
      });
    }
  }

  if (baseline && !annotationOnly) {
    const baseSet = new Set(tokenize(baseline.doc.content));
    const baseSig = styleSignature(baseline.doc.content);

    runs.forEach(r => {
      if (r.label === baseline.label) return;
      const tokens = tokenize(r.doc.content);
      const setR = new Set(tokens);
      const sigR = styleSignature(r.doc.content);
      const styleDelta =
        Math.abs(baseSig.avgSentenceLen - sigR.avgSentenceLen) +
        Math.abs(baseSig.typeTokenRatio - sigR.typeTokenRatio);

      baselineComparisons.push({
        pairLabel: `${baseline.label} vs ${r.label}`,
        overlap: Number(jaccard(baseSet, setR).toFixed(3)),
        lengthDelta: Math.abs(baseline.doc.content.length - r.doc.content.length),
        styleDelta: Number(styleDelta.toFixed(3)),
        uniqueA: [...baseSet].filter(x => !setR.has(x)).length,
        uniqueB: [...setR].filter(x => !baseSet.has(x)).length
      });
    });
  }

  // Variant-level coverage metrics (token overlap only)
  if (!annotationOnly) {
    runs.forEach((r, idx) => {
      const setV = tokenCache[r.label] || new Set(tokenize(r.doc.content));
      tokenCache[r.label] = setV;
      const otherSets = runs
        .filter((_, jdx) => jdx !== idx)
        .map(o => tokenCache[o.label] || new Set(tokenize(o.doc.content)));

      const unionOthers = new Set<string>();
      otherSets.forEach(s => s.forEach(tok => unionOthers.add(tok)));

      const sharedCount = [...setV].filter(t => unionOthers.has(t)).length;
      const uniqueCount = [...setV].filter(t => !unionOthers.has(t)).length;
      const totalCount = setV.size || 1;

      let avgPairOverlap = 0;
      if (otherSets.length > 0) {
        avgPairOverlap =
          otherSets.reduce((acc, setO) => acc + jaccard(setV, setO), 0) /
          otherSets.length;
      }

      const sharedWithOthers = otherSets.filter(s => jaccard(setV, s) > 0.05).length;
      const sharedWithRatio =
        otherSets.length > 0 ? sharedWithOthers / otherSets.length : 0;

      variantBreakdown.push({
        runLabel: r.label,
        uniqueFraction: Number((uniqueCount / totalCount).toFixed(3)),
        sharedFraction: Number((sharedCount / totalCount).toFixed(3)),
        sharedWithRatio: Number(sharedWithRatio.toFixed(3)),
        averageOverlap: Number(avgPairOverlap.toFixed(3))
      });
    });
  }

  const avgOverlap =
    textPairs.length > 0
      ? Number(
          (
            textPairs.reduce((acc, p) => acc + p.overlap, 0) / textPairs.length
          ).toFixed(3)
        )
      : 0;
  const minOverlap =
    textPairs.length > 0
      ? Math.min(...textPairs.map(p => p.overlap))
      : 0;
  const maxOverlap =
    textPairs.length > 0
      ? Math.max(...textPairs.map(p => p.overlap))
      : 0;
  const avgAnnotationAgreement =
    annotationPairs.length > 0
      ? Number(
          (
            annotationPairs.reduce(
              (acc, p) => acc + (p.sharedFraction ?? 0),
              0
            ) / annotationPairs.length
          ).toFixed(3)
        )
      : 0;
  const avgQuoteOverlap =
    annotationPairs.length > 0
      ? Number(
          (
            annotationPairs.reduce(
              (acc, p) => acc + (p.averageQuoteOverlap ?? 0),
              0
            ) / annotationPairs.length
          ).toFixed(3)
        )
      : 0;
  const avgCommentSim =
    annotationPairs.length > 0
      ? Number(
          (
            annotationPairs.reduce(
              (acc, p) => acc + (p.averageCommentSimilarity ?? 0),
              0
            ) / annotationPairs.length
          ).toFixed(3)
        )
      : 0;

  const summary = annotationOnly
    ? `Annotation agreement: ${avgAnnotationAgreement} (shared fraction); highlight overlap: ${avgQuoteOverlap}; comment alignment: ${avgCommentSim}. Higher is better.`
    : `Average text overlap: ${avgOverlap} (min ${minOverlap.toFixed(
        3
      )}, max ${maxOverlap.toFixed(
        3
      )}). Annotation agreement (Gemini-matched): ${avgAnnotationAgreement}. Lower values indicate greater divergence.`;

  return {
    textPairs,
    annotationPairs,
    baselineLabel: baseline?.label,
    baselineTextLength: baseline?.doc.content.length,
    baselineComparisons,
    gradeComparisons,
    variantBreakdown,
    annotationDetails: runs.map(r => ({
      runLabel: r.label,
      annotations: (r.doc.annotations || []).map(a => ({
        quote: a.quote,
        level: a.level,
        comment: a.comment,
        sourceId: a.sourceId,
        sourceQuote: a.sourceQuote
      }))
    })),
    summary
  };
};

const generateConsistencyCommentary = async (
  report: ConsistencyReport,
  modelId: ModelId,
  systemPrompt: string,
  onLog: (msg: string) => void
): Promise<string | undefined> => {
  if (!report.textPairs.length && !report.annotationPairs.length) return undefined;

  const topTextOverlap =
    report.textPairs.length > 0
      ? Math.max(...report.textPairs.map(p => p.overlap))
      : 'n/a';
  const lowTextOverlap =
    report.textPairs.length > 0
      ? Math.min(...report.textPairs.map(p => p.overlap))
      : 'n/a';

  const avgAnnShared =
    report.annotationPairs.length > 0
      ? Number(
          (
            report.annotationPairs.reduce(
              (acc, p) => acc + (p.sharedFraction || 0),
              0
            ) / report.annotationPairs.length
          ).toFixed(3)
        )
      : 0;

  const summaryLines = [
    `Summary: ${report.summary || ''}`,
    `Top text overlap: ${topTextOverlap}`,
    `Lowest text overlap: ${lowTextOverlap}`,
    `Annotation pairs: ${report.annotationPairs.length} (avg shared: ${avgAnnShared})`
  ];

  const prompt = `You are an analysis assistant. Based on the following consistency metrics, write a concise qualitative comment (3-5 sentences) about similarity/divergence and annotation agreement. Do not restate numbers verbatim; interpret them.

METRICS:
${summaryLines.join('\n')}

Describe: where variants are closest/farthest, whether styles drift, and how aligned the annotations are.`;

  try {
    const { text } = await generateNarrative(
      prompt,
      systemPrompt,
      modelId,
      GenerationMethod.STANDARD
    );
    onLog(`Generated LLM commentary on consistency.`);
    return text;
  } catch (e) {
    console.error('Commentary generation failed', e);
    onLog(`Commentary generation failed: ${e}`);
    return undefined;
  }
};


const buildStepTokenUsage = (
  generatorModelId: ModelId,
  evaluatorModelId: ModelId,
  genUsage?: TokenUsage,
  evalUsage?: TokenUsage,
  meta?: StepTokenUsage['meta']
): StepTokenUsage | undefined => {
  const calls: LlmCallUsage[] = [];

  if (genUsage) {
    calls.push({
      modelId: generatorModelId,
        role: "generator",
        promptTokens: genUsage.promptTokens,
        outputTokens: genUsage.outputTokens,
        totalTokens: genUsage.totalTokens,
        });
    }

    if (evalUsage) {
        calls.push({
        modelId: evaluatorModelId,
        role: "evaluator",
        promptTokens: evalUsage.promptTokens,
        outputTokens: evalUsage.outputTokens,
        totalTokens: evalUsage.totalTokens,
        });
    }

    if (calls.length === 0) {
        return undefined;
    }

  const aggregate = calls.reduce(
    (acc, c) => ({
      promptTokens: acc.promptTokens + c.promptTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      totalTokens: acc.totalTokens + c.totalTokens,
    }),
    { promptTokens: 0, outputTokens: 0, totalTokens: 0 }
  );

  return { calls, aggregate, meta };
};


// --- CORE GENERATION STEP ---
const runGenerationStep = async (
  config: ExperimentConfig,
  runId: string,
  runLabel: string,
  previousStep: DocumentVersion | null,
  resources: Resource[],
  activeResourceIds: string[],
  methodOverride: GenerationMethod | null,
  onLog: (msg: string) => void,
  stepNumber: number,
  iteration: number
): Promise<DocumentVersion> => {
  let method = GenerationMethod.STANDARD;
  let taskPrompt = config.taskPrompt;
  let systemPrompt = config.systemPrompt;

  if (previousStep) {
    method = GenerationMethod.REFINE_LOOP;
    taskPrompt = config.refinePrompt;
  } else if (methodOverride) {
    method = methodOverride;
    if (method === GenerationMethod.STEP_BY_STEP && config.stepPrompt) {
      taskPrompt = config.stepPrompt;
    }
  }


  const refineSettings: RefinementConfig = {
    includeOriginalText: config.refineConfig?.includeOriginalText ?? true,
    includeAiAnnotations: config.refineConfig?.includeAiAnnotations ?? true,
    includeHumanAnnotations: config.refineConfig?.includeHumanAnnotations ?? false,
    activeResourceIds: config.refineConfig?.activeResourceIds ?? activeResourceIds,
  };
  const runResourceIds = refineSettings.activeResourceIds;

  let fullPrompt = "";
  if (method === GenerationMethod.REFINE_LOOP && previousStep) {
    fullPrompt = buildFullPrompt({
      taskPrompt: config.refinePrompt,
      resources,
      systemInstruction: systemPrompt,
      refinementContext: {
        originalText: previousStep.content,
        annotations: previousStep.annotations,
        config: refineSettings,
      },
    });
  } else {
    fullPrompt = buildFullPrompt({
      taskPrompt,
      resources,
      refinementContext: undefined,
      systemInstruction: systemPrompt,
      stepConfig:
        method === GenerationMethod.STEP_BY_STEP
          ? config.stepConfig
          : undefined,
    });
  }

  onLog(`Generating (${method})...`);
  const genResult = await generateNarrative(
    fullPrompt,
    systemPrompt,
    config.generatorModelId,
    method
  );

  await delay(config.delaySeconds * 1000);

  let stats: DiffStats | undefined;
  if (method === GenerationMethod.REFINE_LOOP && previousStep) {
    stats = calculateDiffStats(previousStep.content, genResult.text);
  }

  onLog(`Evaluating...`);
  const evalResult = await evaluateCoherence(
    genResult.text,
    resources.filter((r) => runResourceIds.includes(r.id)),
    config.evaluationCategories,
    config.evaluatorModelId,
    config.evaluatorPrompt || DEFAULT_EVALUATOR_PROMPT
  );

  await delay(config.delaySeconds * 1000);

  // token fusion for this step (generation + evaluation)
  const stepTokenUsage = buildStepTokenUsage(
    config.generatorModelId,
    config.evaluatorModelId,
    genResult.tokenUsage,
    evalResult.tokenUsage,
    {
      runId,
      runLabel,
      stepNumber,
      iteration,
      method,
    }
  );

  if (stepTokenUsage?.aggregate) {
    const agg = stepTokenUsage.aggregate;
    const calls = stepTokenUsage.calls;
    const callsLine = calls
      .map(
        (c) =>
          `${c.role === "generator" ? "gen" : "eval"}: p${c.promptTokens} o${c.outputTokens} t${c.totalTokens}`
      )
      .join(" | ");
    onLog(
      `Tokens step ${stepNumber} (${runLabel}, ${method}): prompt=${agg.promptTokens} output=${agg.outputTokens} total=${agg.totalTokens} [${callsLine}]`
    );
  }

  const newDoc: DocumentVersion = {
    id: crypto.randomUUID(),
    parentId: previousStep?.id,
    timestamp: Date.now(),
    content: genResult.text,
    thoughts: genResult.thoughts,
    modelId: config.generatorModelId,
    method,
    systemPromptSnapshot: systemPrompt,
    taskPromptSnapshot: taskPrompt,
    fullPromptSnapshot: fullPrompt,
    refinementConfig: refineSettings,
    activeResourceIds: runResourceIds,
    stepConfig:
      method === GenerationMethod.STEP_BY_STEP
        ? config.stepConfig
        : undefined,

    // full cost of the step (generation + evaluation)
    tokenUsage: stepTokenUsage,

    experimentId: config.id,
    runId,
    runLabel,
    diffStats: stats,

    annotations: evalResult.annotations.map((a: any) => ({
      id: crypto.randomUUID(),
      quote: a.quote,
      level: a.level,
      comment: a.comment,
      sourceId: a.sourceId,
      sourceQuote: a.sourceQuote,
      author: "AI_EVALUATOR",
      confirmations: [],
      refutations: [],
      timestamp: Date.now(),
    })),
    groundingEntries: [],
    scores: normalizeScores(config.evaluationCategories, evalResult.scores),
  };

  return newDoc;
};



    // --- PROTOCOL RUNNERS ---

const executeRefinementLoop = async (
    config: ExperimentConfig,
    runId: string,
    runLabel: string,
    resources: Resource[],
    activeResourceIds: string[],
    onUpdateRun: (runId: string, step: DocumentVersion) => void,
    onLog: (msg: string) => void
) => {
        let stepNumber = 1;
        let cumulative = { prompt: 0, output: 0, total: 0 };

        let currentStep = await runGenerationStep(
            config, runId, runLabel, null,
            resources, activeResourceIds,
            GenerationMethod.STANDARD,
            onLog,
            stepNumber,
            0
        );

        onUpdateRun(runId, currentStep);
        if (currentStep.tokenUsage?.aggregate) {
            cumulative.prompt += currentStep.tokenUsage.aggregate.promptTokens;
            cumulative.output += currentStep.tokenUsage.aggregate.outputTokens;
            cumulative.total += currentStep.tokenUsage.aggregate.totalTokens;
            onLog(`Cumulative tokens after step ${stepNumber}: prompt=${cumulative.prompt} output=${cumulative.output} total=${cumulative.total}`);
        }

        for (let i = 0; i < config.iterations; i++) {
            onLog(`Refinement Iteration ${i+1}/${config.iterations}`);
            stepNumber += 1;
            currentStep = await runGenerationStep(
                config, runId, runLabel, currentStep,
                resources, activeResourceIds,
                GenerationMethod.REFINE_LOOP,
                onLog,
                stepNumber,
                i + 1
            );
            onUpdateRun(runId, currentStep);
            if (currentStep.tokenUsage?.aggregate) {
                cumulative.prompt += currentStep.tokenUsage.aggregate.promptTokens;
                cumulative.output += currentStep.tokenUsage.aggregate.outputTokens;
                cumulative.total += currentStep.tokenUsage.aggregate.totalTokens;
                onLog(`Cumulative tokens after step ${stepNumber}: prompt=${cumulative.prompt} output=${cumulative.output} total=${cumulative.total}`);
            }
        }
    };

    const executeStepByStep = async (
        config: ExperimentConfig,
        runId: string,
        runLabel: string,
        resources: Resource[],
        activeResourceIds: string[],
        onUpdateRun: (runId: string, step: DocumentVersion) => void,
        onLog: (msg: string) => void
    ) => {
        onLog(`Running Step-by-Step Generation...`);
        const stepDoc = await runGenerationStep(
            config, runId, runLabel, null,
            resources, activeResourceIds,
            GenerationMethod.STEP_BY_STEP,
            onLog,
            1,
            0
        );
        
        onUpdateRun(runId, stepDoc);
        if (stepDoc.tokenUsage?.aggregate) {
            onLog(`Cumulative tokens after step 1: prompt=${stepDoc.tokenUsage.aggregate.promptTokens} output=${stepDoc.tokenUsage.aggregate.outputTokens} total=${stepDoc.tokenUsage.aggregate.totalTokens}`);
        }
    };


    // --- MAIN ENTRY POINT ---

    export const runExperimentLoop = async (
        config: ExperimentConfig,
        allResources: Resource[],
        onUpdateRun: (runId: string, step: DocumentVersion) => void,
        onStatusChange: (runId: string, status: 'running' | 'completed' | 'failed') => void,
        onLog: (msg: string) => void,
        getRunIdByLabel: (label: string, index: number) => string
    ): Promise<ConsistencyReport | undefined> => {
        
        const prepResources = (activeIds: string[]) =>
            allResources.map(r => ({
                ...r,
                enabled: activeIds.includes(r.id)
            }));

        try {
            if (
              config.type === ExperimentType.CONSISTENCY_TEXT ||
              config.type === ExperimentType.CONSISTENCY_ANNOTATION
            ) {
                const variantCount = Math.max(2, config.runCount || 2);
                const outputs: { label: string; runId: string; doc: DocumentVersion }[] = [];
                const resources = prepResources(config.activeResourceIds);

                if (config.type === ExperimentType.CONSISTENCY_ANNOTATION) {
                    // Generate one base document, then evaluate it multiple times
                    const baseRunId = getRunIdByLabel("Variant 1", 0);
                    onStatusChange(baseRunId, 'running');
                    onLog(`=== GENERATING BASE TEXT FOR ANNOTATION CONSISTENCY ===`);
                    const baseDoc = await runGenerationStep(
                        config,
                        baseRunId,
                        "Variant 1",
                        null,
                        resources,
                        config.activeResourceIds,
                        GenerationMethod.STANDARD,
                        onLog,
                        1,
                        0
                    );

                    for (let i = 0; i < variantCount; i++) {
                        const label = `Variant ${i + 1}`;
                        const runId = getRunIdByLabel(label, i);
                        onStatusChange(runId, 'running');
                        onLog(`=== ANNOTATION PASS ${i + 1}/${variantCount} ===`);

                        const evalResult = await evaluateCoherence(
                            baseDoc.content,
                            resources.filter(r => r.enabled),
                            config.evaluationCategories,
                            config.evaluatorModelId,
                            config.evaluatorPrompt || DEFAULT_EVALUATOR_PROMPT
                        );

                        const normalizedScores = normalizeScores(
                          config.evaluationCategories,
                          evalResult.scores
                        );

                        const annDoc: DocumentVersion = {
                            id: crypto.randomUUID(),
                            parentId: baseDoc.id,
                            timestamp: Date.now(),
                            content: baseDoc.content,
                            modelId: config.generatorModelId,
                            method: GenerationMethod.STANDARD,
                            systemPromptSnapshot: config.systemPrompt,
                            taskPromptSnapshot: config.taskPrompt,
                            fullPromptSnapshot: baseDoc.fullPromptSnapshot,
                            activeResourceIds: config.activeResourceIds,
                            annotations: (evalResult.annotations || []).map((a: any) => ({
                                id: crypto.randomUUID(),
                                quote: a.quote,
                                level: a.level,
                                comment: a.comment,
                                sourceId: a.sourceId,
                                sourceQuote: a.sourceQuote,
                                author: "AI_EVALUATOR",
                                confirmations: [],
                                refutations: [],
                                timestamp: Date.now(),
                            })),
                            groundingEntries: [],
                            scores: normalizedScores,
                            tokenUsage: undefined,
                        };

                        outputs.push({ label, runId, doc: annDoc });
                        onUpdateRun(runId, annDoc);
                        onStatusChange(runId, 'completed');
                        await delay(config.delaySeconds * 1000);
                    }

                    const report = await buildConsistencyReport(
                        outputs,
                        { label: "Variant 1", doc: outputs[0].doc },
                        {
                            annotationJudgeModel: config.evaluatorModelId as ModelId,
                            judgeSystemPrompt: 'You are an impartial annotation judge for consistency analysis.',
                            onLog,
                            annotationOnly: true
                        }
                    );
                    report.commentary = await generateConsistencyCommentary(
                        report,
                        config.generatorModelId as ModelId,
                        config.systemPrompt,
                        onLog
                    );
                    onLog(`Consistency report ready. ${report.summary}`);
                    onLog(`All protocols finished.`);
                    return report;
                } else {
                    // Text consistency: generate multiple variants and compare
                    for (let i = 0; i < variantCount; i++) {
                        const label = `Variant ${i + 1}`;
                        const runId = getRunIdByLabel(label, i);
                        onStatusChange(runId, 'running');
                        onLog(`=== STARTING CONSISTENCY VARIANT ${i + 1}/${variantCount} ===`);

                        const doc = await runGenerationStep(
                            config,
                            runId,
                            label,
                            null,
                            resources,
                            config.activeResourceIds,
                            GenerationMethod.STANDARD,
                            onLog,
                            1,
                            0
                        );
                        outputs.push({ label, runId, doc });
                        onStatusChange(runId, 'completed');

                        await delay(config.delaySeconds * 1000);
                    }

                    // Ask LLM to highlight differences/similarities against the original event context
                    const originalEvent =
                      resources
                        .filter(r => r.type === 'primary_source')
                        .map(r => r.content)
                        .join('\n\n') ||
                      resources.map(r => r.content).join('\n\n') ||
                      outputs[0].doc.content;

                    const highlightPrompt = {
                      original: originalEvent,
                      variants: outputs.map(o => ({
                        label: o.label,
                        text: o.doc.content,
                      }))
                    };

                    try {
                      const promptText = `You are running an auto-analysis of narrative consistency.
You will receive an ORIGINAL_EVENT description and several VARIANTS (the competing texts).
For each VARIANT, mark three kinds of spans:
- DIFF: content that conflicts with or drifts away from another variant (cite which variant you compared to).
- ADDITION: invented or unique flourishes not present in other variants or the original event.
- SOURCE: content that is faithful to the ORIGINAL_EVENT or shared verbatim across variants.
Respond with STRICT JSON only:
{
  "variants": [
    {
      "label": "Variant 1",
      "annotations": [
        { "type": "DIFF"|"ADDITION"|"SOURCE", "quote": "...", "comment": "...", "relatedVariant": "Variant 2", "relatedQuote": "...matching or conflicting sentence from Variant 2 or the original event" }
      ]
    }
  ]
}
Prefer short quotes (one sentence or phrase).`;

                      const llmInput = `${promptText}\n\nORIGINAL_EVENT:\n${highlightPrompt.original}\n\nVARIANTS:\n${highlightPrompt.variants.map(v => `[${v.label}]\n${v.text}`).join('\n\n')}`;
                      const { text: analysisRaw } = await generateNarrative(
                        llmInput,
                        config.systemPrompt,
                        config.generatorModelId,
                        GenerationMethod.STANDARD
                      );
                      const parsed = safeJsonParse(analysisRaw || '');
                      if (!parsed?.variants) {
                        onLog('Consistency highlight could not be parsed; skipping annotations.');
                      }
                      const annMap: Record<string, any[]> = {};
                      (parsed?.variants || []).forEach((v: any) => {
                        annMap[v.label] = v.annotations || [];
                      });
                      outputs.forEach(o => {
                        const anns = annMap[o.label] || [];
                        o.doc.annotations = anns
                          .map((a: any) => ({
                            id: crypto.randomUUID(),
                            quote: a.quote || '',
                            level: (a.type || '').toUpperCase() === 'SOURCE'
                              ? 'Consistency-Source'
                              : (a.type || '').toUpperCase() === 'ADDITION'
                                ? 'Consistency-Addition'
                                : 'Consistency-Diff',
                            comment: a.comment ||
                              ((a.type || '').toUpperCase() === 'SOURCE'
                                ? 'Matches the original event or other variants.'
                                : (a.type || '').toUpperCase() === 'ADDITION'
                                  ? 'Unique addition versus other variants.'
                                  : `Diverges from ${a.relatedVariant || 'another variant'}.`),
                            sourceId: undefined,
                            sourceQuote: a.relatedQuote || a.sourceQuote,
                            relatedVariant: a.relatedVariant,
                            relatedQuote: a.relatedQuote || a.sourceQuote,
                            originHint: (a.type || '').toUpperCase() === 'SOURCE' ? 'original' : a.relatedVariant ? 'variant' : undefined,
                            author: 'AI_CONSISTENCY',
                            confirmations: [],
                            refutations: [],
                            timestamp: Date.now()
                          }))
                          .filter((a: any) => a.quote && a.quote.trim().length > 0);
                      });
                    } catch (err) {
                      console.error('Consistency highlight failed', err);
                      onLog(`Highlight generation failed: ${err}`);
                    }

                    // Persist annotated docs
                    outputs.forEach(o => onUpdateRun(o.runId, o.doc));

                    const baseline = outputs[0];
                    const report = await buildConsistencyReport(
                        outputs,
                        baseline,
                        {
                            annotationJudgeModel: config.evaluatorModelId as ModelId,
                            judgeSystemPrompt: 'You are an impartial annotation judge for consistency analysis.',
                            onLog
                        }
                    );
                    report.commentary = await generateConsistencyCommentary(
                        report,
                        config.generatorModelId as ModelId,
                        config.systemPrompt,
                        onLog
                    );
                    onLog(`Consistency report ready. ${report.summary}`);
                    onLog(`All protocols finished.`);
                    return report;
                }
            }
            else if (config.type === ExperimentType.CONVERGENCE) {
                for (let i = 0; i < config.runCount; i++) {
                    const label = "Convergence";
                    const runId = getRunIdByLabel(label, i);
                    onStatusChange(runId, 'running');
                    onLog(`=== STARTING CONVERGENCE RUN ${i+1} ===`);
                    await executeRefinementLoop(config, runId, label, prepResources(config.activeResourceIds), config.activeResourceIds, onUpdateRun, onLog);
                    onStatusChange(runId, 'completed');
                }
            } 
            else if (config.type === ExperimentType.COMPARATIVE) {
                for (let i = 0; i < config.runCount; i++) {
                    const labelA = "Step-by-Step";
                    const idA = getRunIdByLabel(labelA, i);
                    onStatusChange(idA, 'running');
                    onLog(`=== STARTING COMPARISON (SBS) RUN ${i+1} ===`);
                    await executeStepByStep(config, idA, labelA, prepResources(config.activeResourceIds), config.activeResourceIds, onUpdateRun, onLog);
                    onStatusChange(idA, 'completed');

                    const labelB = "Refinement Loop";
                    const idB = getRunIdByLabel(labelB, i);
                    onStatusChange(idB, 'running');
                    onLog(`=== STARTING COMPARISON (LOOP) RUN ${i+1} ===`);
                    await executeRefinementLoop(config, idB, labelB, prepResources(config.activeResourceIds), config.activeResourceIds, onUpdateRun, onLog);
                    onStatusChange(idB, 'completed');
                }
            }
            else if (config.type === ExperimentType.ABLATION) {
                for (let i = 0; i < config.runCount; i++) {
                    const labelFull = "Full Context";
                    const idFull = getRunIdByLabel(labelFull, i);
                    onStatusChange(idFull, 'running');
                    onLog(`=== STARTING ABLATION (FULL) RUN ${i+1} ===`);
                    await executeRefinementLoop(config, idFull, labelFull, prepResources(config.activeResourceIds), config.activeResourceIds, onUpdateRun, onLog);
                    onStatusChange(idFull, 'completed');

                    const labelZero = "Zero Context";
                    const idZero = getRunIdByLabel(labelZero, i);
                    onStatusChange(idZero, 'running');
                    onLog(`=== STARTING ABLATION (ZERO) RUN ${i+1} ===`);
                    await executeRefinementLoop(config, idZero, labelZero, prepResources([]), [], onUpdateRun, onLog);
                    onStatusChange(idZero, 'completed');
                }
            }
            else {
                for (let i = 0; i < config.runCount; i++) {
                    const label = "Custom";
                    const runId = getRunIdByLabel(label, i);
                    onStatusChange(runId, 'running');
                    await executeRefinementLoop(config, runId, label, prepResources(config.activeResourceIds), config.activeResourceIds, onUpdateRun, onLog);
                    onStatusChange(runId, 'completed');
                }
            }

            onLog(`All protocols finished.`);

        } catch (e) {
            console.error(e);
            onLog(`CRITICAL ERROR: ${e}`);
        }
    };
