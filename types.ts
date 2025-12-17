export enum ModelId { 
  FLASH_2_5 = 'gemini-2.5-flash',
  PRO_3_0 = 'gemini-3-pro-preview',
  FLASH_LITE = 'gemini-flash-lite-latest'
}

export enum GenerationMethod {
  STANDARD = 'Standard Generation',
  STEP_BY_STEP = 'Step-by-Step (Visible Thought)',
  REFINE_LOOP = 'Refinement Loop'
}

// Replaced fixed Enum with a dynamic configuration object
export interface EvaluationCategory {
  id: string;
  name: string;
  description: string;
}

export interface ScoreMap {
  // Category ID -> UserID -> Score
  [categoryId: string]: Record<string, number>;
}

export interface Refutation {
  userId: string;
  reason: string;
  timestamp: number;
}

export interface Annotation {
  id: string;
  quote: string;
  level: string; // Now a string (Category Name/ID)
  comment: string;
  sourceId?: string;
  sourceQuote?: string;
  // Auto-analysis helpers
  relatedVariant?: string;
  relatedQuote?: string;
  originHint?: 'original' | 'variant';

  author: string;
  timestamp: number;

  confirmations: string[];
  refutations: Refutation[];
}

export interface GroundingEntry {
  id: string;
  quote: string; // Text from the narrative
  resourceId: string;
  resourceName: string;
  resourceQuote: string; // Evidence from the source
  confidence?: number;
}

export interface RefinementConfig {
  includeOriginalText: boolean;
  includeAiAnnotations: boolean;
  includeHumanAnnotations: boolean;
  activeResourceIds: string[]; // Specific resources for the refinement pass
}

export interface StepConfig {
  stepSize: string; // e.g., "1 paragraph", "3 sentences", "1 scene"
  showThoughts: boolean;
  enableSelfCorrection: boolean; // "Rewrite last step if bad"
  selfCorrectionInstruction: string;
}

// AFTER
export interface SavedPrompt {
  id: string;
  name: string;
  systemPrompt: string;

  // legacy field kept so old json files still work
  taskPrompt?: string;

  // new fields
  modePrompts?: ModePrompts;
  stepConfig?: StepConfig;
  refineConfig?: RefinementConfig;
  modelId?: ModelId;
  thinkingBudget?: number;
  // extended workspace snapshot fields (all optional for backward compatibility)
  defaultRefinePrompt?: string;
  defaultEvaluatorPrompt?: string;
  defaultGroundingPrompt?: string;
  evaluationCategories?: EvaluationCategory[];
  resources?: Resource[];
  activeResourceIds?: string[];
  evaluatorModelId?: ModelId;
  groundingModelId?: ModelId;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  addedLength: number;
  removedLength: number;
  changeRatio: number; // (added + removed) / total_new_length
}

/**
 * Simple usage pour un seul appel de modèle
 * Gardé pour compat avec les services existants (generateNarrative etc)
 */
export interface SimpleTokenUsage { // NEW
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// Alias pour ne pas casser les imports existants qui utilisent TokenUsage
export type TokenUsage = SimpleTokenUsage; // NEW

/**
 * Usage détaillé par appel de modèle dans une step
 */
export interface LlmCallUsage { // NEW
  modelId: ModelId;
  role: 'generator' | 'evaluator' | 'other';
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Usage total d'une step: détail par appel + agrégat
 */
export interface StepTokenUsage { // NEW
  calls: LlmCallUsage[];
  aggregate: {
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  // Optional metadata so experiments can show richer token traces per loop
  meta?: {
    runId: string;
    runLabel: string;
    stepNumber: number;   // sequential step within a run
    iteration: number;    // 0 = seed generation, 1..N = refinement iterations
    method: GenerationMethod;
  };
}

export interface DocumentVersion {
  id: string;
  parentId?: string;
  timestamp: number;
  content: string;
  thoughts?: string[];

  modelId: string;
  method: GenerationMethod;
  systemPromptSnapshot: string;
  taskPromptSnapshot: string;
  evalPromptSnapshot?: string; // Full prompt or JSON rep of categories
  fullPromptSnapshot?: string;

  refinementConfig?: RefinementConfig;
  stepConfig?: StepConfig;

  activeResourceIds: string[];

  annotations: Annotation[];
  groundingEntries: GroundingEntry[]; // NEW: Separate from annotations
  scores: ScoreMap;

  // CHANGED: avant c'était "tokenUsage?: TokenUsage;"
  tokenUsage?: StepTokenUsage; // CHANGED

  // Diff Analysis
  diffStats?: DiffStats;

  // Linkage for Experiments
  experimentId?: string;
  runId?: string;
  runLabel?: string;
}

export interface Resource {
  id: string;
  name: string;
  content: string;
  usageInstruction?: string; // "Use for inspiration" vs "Follow strictly"
  type: 'primary_source' | 'context' | 'literature';
  enabled: boolean;
}

// --- NEW EXPERIMENT TYPES ---

export enum ExperimentType {
  CONVERGENCE = 'Convergence Loop', // Standard Refinement Loop
  COMPARATIVE = 'Method Comparison', // Step-by-Step vs Refinement Loop
  ABLATION = 'Context Ablation', // All Resources vs No Resources vs Partial
  CONSISTENCY_TEXT = 'Text Consistency Check', // Generate multiple variants, measure divergence
  CONSISTENCY_ANNOTATION = 'Annotation Consistency Check', // Compare AI annotations across variants
  CUSTOM = 'Custom Protocol'
}

export interface ExperimentConfig {
  id: string;
  name: string;
  type: ExperimentType;
  description: string;

  // Run Settings
  iterations: number; // How many feedback loops (for Convergence/Comparative-Refine)
  runCount: number; // How many parallel "branches" to run for stats
  delaySeconds: number; // To prevent rate limiting

  // Models
  generatorModelId: ModelId;
  evaluatorModelId: ModelId; // Can be different to test bias

  // Prompts
  systemPrompt: string;
  taskPrompt: string;
  stepPrompt?: string; // Optional dedicated prompt for Step-by-Step runs
  refinePrompt: string; // The instructions for the refinement step
  evaluatorPrompt: string;
  refineConfig?: RefinementConfig; // What to include when re-running a refinement loop

  // Context
  activeResourceIds: string[];
  evaluationCategories: EvaluationCategory[];

  // Specialized Configs
  stepConfig?: StepConfig; // Used for the "Step-by-Step" branch in Comparative

  // New fields used by ExperimentDashboard and runExperimentLoop
  basePromptId?: string;
  useSameConfigForAllRuns?: boolean;
  runConfigs?: Record<number, string>;
}

export interface ExperimentRun {
  id: string;
  experimentId: string;
  runNumber: number;
  label?: string; // e.g., "Method A", "No Context", "Run 1"
  startTime: number;
  status: 'pending' | 'running' | 'completed' | 'failed';

  // NORMALIZED: Store IDs only. The actual docs live in ProjectState.documents
  stepIds: string[];
}

export interface ExperimentData {
  config: ExperimentConfig;
  runs: ExperimentRun[];
  savedAt?: number;
  // Optional reports generated by specific protocols (e.g., consistency analysis)
  consistencyReport?: ConsistencyReport;
}

// Consistency reporting (used by new auto-analysis protocols)
export interface ConsistencyPairMetric {
  pairLabel: string;
  overlap: number; // Jaccard overlap 0-1
  lengthDelta: number; // Absolute length difference
  styleDelta: number; // Aggregate stylistic divergence
  uniqueA: number; // Tokens only in A
  uniqueB: number; // Tokens only in B
}

export interface AnnotationConsistencyMetric {
  pairLabel: string;
  shared: number;
  onlyA: number;
  onlyB: number;
  avgScoreDelta?: number;
  sharedFraction?: number; // Shared annotations vs the smaller set size
  agreementNote?: string; // Short Gemini justification/sample
  averageQuoteOverlap?: number; // 0-1 average overlap of matched highlights
  averageCommentSimilarity?: number; // 0-1 average similarity of matched comments
}

export interface GradeDelta {
  category: string;
  scoreA?: number;
  scoreB?: number;
  delta?: number;
}

export interface GradeComparison {
  pairLabel: string;
  categories: GradeDelta[];
}

export interface AnnotationDetail {
  runLabel: string;
  annotations: Array<{
    quote: string;
    level: string;
    comment: string;
    sourceId?: string;
    sourceQuote?: string;
  }>;
}

export interface VariantConsistencyStat {
  runLabel: string;
  uniqueFraction: number; // % of text unique vs all other variants (0-1)
  sharedFraction: number; // % of text shared with at least one other variant (0-1)
  sharedWithRatio?: number; // Portion of other variants that share meaningful overlap
  averageOverlap: number; // mean Jaccard overlap with others (0-1)
}

export interface ConsistencyReport {
  textPairs: ConsistencyPairMetric[];
  annotationPairs: AnnotationConsistencyMetric[];
  baselineLabel?: string;
  baselineTextLength?: number;
  summary?: string;
  commentary?: string;
  baselineComparisons?: ConsistencyPairMetric[];
  gradeComparisons?: GradeComparison[];
  annotationDetails?: AnnotationDetail[];
  variantBreakdown?: VariantConsistencyStat[];
}

export interface ProjectState {
  id: string;
  name: string;
  currentUser: string;

  defaultSystemPrompt: string;
  defaultRefinePrompt: string;
  defaultEvaluatorPrompt: string; // NEW: Editable evaluator prompt
  evaluatorModelId: ModelId;

  // Grounding Settings
  defaultGroundingPrompt: string;
  groundingModelId: ModelId;

  // Dynamic Evaluation Categories
  evaluationCategories: EvaluationCategory[];

  savedPrompts: SavedPrompt[];

  resources: Resource[];
  documents: DocumentVersion[];

  // New Experiments Storage
  experiments: ExperimentData[];
}

export interface ModePrompts {
  direct: string;
  step: string;
  refine: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a sophisticated historical simulation engine specializing in 18th-century Europe, specifically Venice around 1740. 
Your goal is to generate narratives that are stylistically consistent with Charles de Brosses' travelogues but enhanced with imaginative yet historically grounded details.
Weave facts into a coherent, immersive narrative. 

IMPORTANT: Write in plain text only. Do NOT use Markdown formatting (like **bold**, *italics*, or headers) within the narrative flow. Do not list information.`;

export const DEFAULT_REFINE_PROMPT = `You are refining a historical simulation based on critique.
Rewrite the narrative to maintain the original style but correct all incoherences, historical errors, and logic gaps identified in the feedback.
Ensure the output remains in plain text without Markdown formatting.`;

export const DEFAULT_EVALUATOR_PROMPT = `Analyze the provided text based on the specific criteria below.

=== CRITERIA ===
{{CRITERIA}}

=== REFERENCE MATERIAL ===
{{CONTEXT}}

=== TEXT TO ANALYZE ===
{{TEXT}}

Provide your analysis in JSON format as requested by the schema.
When citing quotes, extract them EXACTLY as they appear in the text, including any punctuation or oddities.`;

export const DEFAULT_GROUNDING_PROMPT = `You are a historical grounding verification engine. 
Your task is to identify specific segments in the GENERATED TEXT that are directly supported by the provided REFERENCE RESOURCES.

For every match found:
1. Identify the exact substring in the GENERATED TEXT.
2. Identify the specific Resource ID that supports it.
3. Extract the exact quote from the REFERENCE RESOURCE that serves as evidence.

=== REFERENCE RESOURCES ===
{{CONTEXT}}

=== GENERATED TEXT ===
{{TEXT}}

Return the results in the specified JSON format.`;

// Default Categories
export const DEFAULT_CATEGORIES: EvaluationCategory[] = [
  {
    id: 'internal',
    name: 'Internal Coherence',
    description: 'Is the logic within the text consistent? Does it flow naturally?'
  },
  {
    id: 'story',
    name: 'Story Consistency',
    description: 'Are character actions, plot points, and timeline consistent with previous text?'
  },
  {
    id: 'history',
    name: 'Historical Accuracy',
    description: 'Does it align with the 1740 Venice context and Zeitgeist?'
  },
  {
    id: 'grounding',
    name: 'Source Grounding',
    description: 'Is the text supported by the provided reference materials?'
  }
];
