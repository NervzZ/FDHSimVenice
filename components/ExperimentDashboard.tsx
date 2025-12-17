import React, { useState, useEffect } from 'react';
import {
  ProjectState,
  ExperimentConfig,
  ExperimentData,
  ExperimentRun,
  ExperimentType,
  ModelId,
  DocumentVersion,
  SavedPrompt,
  ConsistencyReport
} from '../types';
import { runExperimentLoop } from '../services/automationService';
import {
  Play,
  Trash2,
  Save,
  Settings,
  RefreshCw,
  GitBranch,
  Layers,
  FlaskConical,
  Edit3,
  Activity
} from 'lucide-react';

interface Props {
  project: ProjectState;
  setProject: React.Dispatch<React.SetStateAction<ProjectState>>;
  onEditInConfig: (config: ExperimentConfig) => void;
  currentLiveConfig: SavedPrompt;
}

export const ExperimentDashboard: React.FC<Props> = ({
  project,
  setProject,
  onEditInConfig,
  currentLiveConfig
}) => {
  const [activeExpId, setActiveExpId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [editConfig, setEditConfig] = useState<ExperimentConfig | null>(null);

  const activeExperiment = project.experiments.find(
    e => e.config.id === activeExpId
  );

  useEffect(() => {
    if (
      editConfig &&
      !editConfig.basePromptId &&
      editConfig.taskPrompt !== currentLiveConfig.taskPrompt
    ) {
      // hook reserved for live sync if desired
    }
  }, [currentLiveConfig, editConfig]);

  const getDocsForRun = (run: ExperimentRun): DocumentVersion[] => {
    return run.stepIds
      .map(id => project.documents.find(d => d.id === id))
      .filter((d): d is DocumentVersion => Boolean(d));
  };

  const calculateAvgScore = (doc: DocumentVersion) => {
    const scores = doc.scores || {};

    let total = 0;
    let count = 0;

    Object.values(scores).forEach(catScores => {
      if (!catScores) return;

      Object.values(catScores).forEach(score => {
        if (typeof score === 'number' && !Number.isNaN(score)) {
          total += score;
          count += 1;
        }
      });
    });

    return count > 0 ? Math.round(total / count) : 0;
  };

  const calculateTokenStats = (docs: DocumentVersion[]) => {
    return docs.reduce(
      (acc, d) => {
        const usage = d.tokenUsage?.aggregate;
        if (!usage) {
          return acc;
        }

        return {
          prompt: acc.prompt + usage.promptTokens,
          output: acc.output + usage.outputTokens,
          total: acc.total + usage.totalTokens
        };
      },
      { prompt: 0, output: 0, total: 0 }
    );
  };


  const getMethodColor = (type: ExperimentType) => {
    switch (type) {
      case ExperimentType.COMPARATIVE:
        return 'text-blue-400';
      case ExperimentType.ABLATION:
        return 'text-green-400';
      case ExperimentType.CONSISTENCY_TEXT:
        return 'text-venice-gold';
      case ExperimentType.CONSISTENCY_ANNOTATION:
        return 'text-blue-300';
      default:
        return 'text-venice-gold';
    }
  };

  const initializeConfigFromLive = (baseConfig: ExperimentConfig): ExperimentConfig => {
    const liveResources = (currentLiveConfig.resources || project.resources).map(r => ({ ...r }));
    const liveActiveResourceIds =
      currentLiveConfig.activeResourceIds ||
      liveResources.filter(r => r.enabled).map(r => r.id);
    const liveStepPrompt =
      currentLiveConfig.modePrompts?.step || currentLiveConfig.taskPrompt;

    return {
      ...baseConfig,
      basePromptId: undefined,
      systemPrompt: currentLiveConfig.systemPrompt,
      stepPrompt: liveStepPrompt,
      taskPrompt: currentLiveConfig.taskPrompt,
      stepConfig: currentLiveConfig.stepConfig || baseConfig.stepConfig,
      refinePrompt:
        currentLiveConfig.defaultRefinePrompt ||
        currentLiveConfig.modePrompts?.refine ||
        project.defaultRefinePrompt,
      refineConfig:
        currentLiveConfig.refineConfig || {
          includeOriginalText: true,
          includeAiAnnotations: true,
          includeHumanAnnotations: true,
          activeResourceIds: liveActiveResourceIds
        },
      evaluatorPrompt:
        currentLiveConfig.defaultEvaluatorPrompt ||
        project.defaultEvaluatorPrompt ||
        '',
      evaluatorModelId:
        currentLiveConfig.evaluatorModelId || project.evaluatorModelId,
      generatorModelId: currentLiveConfig.modelId,
      evaluationCategories:
        currentLiveConfig.evaluationCategories || project.evaluationCategories,
      activeResourceIds: liveActiveResourceIds,
      runConfigs: baseConfig.runConfigs || {},
      useSameConfigForAllRuns:
        typeof baseConfig.useSameConfigForAllRuns === 'boolean'
          ? baseConfig.useSameConfigForAllRuns
          : true
    };
  };

  const applySavedPromptToConfig = (
    cfg: ExperimentConfig,
    promptId: string
  ): ExperimentConfig => {
    const saved = project.savedPrompts.find(s => s.id === promptId);
    if (!saved) return cfg;

    const activeResourceIds =
      saved.activeResourceIds ||
      saved.resources?.filter(r => r.enabled).map(r => r.id) ||
      cfg.activeResourceIds;
    const savedStepPrompt =
      saved.modePrompts?.step ||
      saved.taskPrompt ||
      cfg.stepPrompt ||
      cfg.taskPrompt;

    return {
      ...cfg,
      basePromptId: promptId,
      systemPrompt: saved.systemPrompt,
      taskPrompt:
        saved.taskPrompt || saved.modePrompts?.direct || cfg.taskPrompt,
      stepPrompt: savedStepPrompt,
      stepConfig: saved.stepConfig || cfg.stepConfig,
        refinePrompt:
          saved.defaultRefinePrompt ||
          saved.modePrompts?.refine ||
          cfg.refinePrompt,
        refineConfig: saved.refineConfig || cfg.refineConfig,
        evaluatorPrompt:
          saved.defaultEvaluatorPrompt || cfg.evaluatorPrompt || '',
        evaluationCategories:
          saved.evaluationCategories || cfg.evaluationCategories,
        activeResourceIds,
      generatorModelId:
        (saved.modelId as ModelId | undefined) || cfg.generatorModelId,
      evaluatorModelId:
        saved.evaluatorModelId || cfg.evaluatorModelId
    };
  };
  const handleCreateExperiment = (
    type: ExperimentType = ExperimentType.CONVERGENCE
  ) => {
    const liveResources = (currentLiveConfig.resources || project.resources).map(
      r => ({ ...r })
    );
    const activeResourceIds =
      currentLiveConfig.activeResourceIds ||
      liveResources.filter(r => r.enabled).map(r => r.id);

    const defaultIterations =
      type === ExperimentType.CONVERGENCE ? 8 : 3;
    const defaultRunCount =
      type === ExperimentType.CONSISTENCY_TEXT ||
      type === ExperimentType.CONSISTENCY_ANNOTATION
        ? 3
        : 1;

    const newConfig: ExperimentConfig = {
      id: crypto.randomUUID(),
      name: `New ${type} Experiment`,
      description: 'Describe your research hypothesis here...',
      type,
      iterations: defaultIterations,
      runCount: defaultRunCount,
      delaySeconds: 10,
      generatorModelId: currentLiveConfig.modelId as ModelId,
      evaluatorModelId:
        currentLiveConfig.evaluatorModelId || project.evaluatorModelId,
      systemPrompt: currentLiveConfig.systemPrompt,
      taskPrompt: currentLiveConfig.taskPrompt,
      stepPrompt:
        currentLiveConfig.modePrompts?.step || currentLiveConfig.taskPrompt,
      refinePrompt:
        currentLiveConfig.defaultRefinePrompt ||
        currentLiveConfig.modePrompts?.refine ||
        project.defaultRefinePrompt,
      refineConfig:
        currentLiveConfig.refineConfig || {
          includeOriginalText: true,
          includeAiAnnotations: true,
          includeHumanAnnotations: true,
          activeResourceIds
        },
      evaluatorPrompt:
        currentLiveConfig.defaultEvaluatorPrompt ||
        project.defaultEvaluatorPrompt,
      activeResourceIds,
      evaluationCategories:
        currentLiveConfig.evaluationCategories || project.evaluationCategories,
      stepConfig:
        currentLiveConfig.stepConfig || {
          stepSize: '1 paragraph',
          showThoughts: true,
          enableSelfCorrection: false,
          selfCorrectionInstruction: ''
        },
      basePromptId:
        currentLiveConfig.id !== 'temp_live'
          ? currentLiveConfig.id
          : undefined,
      useSameConfigForAllRuns: true,
      runConfigs: {}
    };

    const newExperiment: ExperimentData = {
      config: newConfig,
      runs: [],
      savedAt: Date.now()
    };

    setProject(p => ({
      ...p,
      experiments: [...p.experiments, newExperiment]
    }));
    setActiveExpId(newConfig.id);
    setEditConfig(newConfig);
  };

    const handleRun = async () => {
    if (!activeExperiment) return;

    setIsRunning(true);
    setLogs([]);

    const logWrapper = (msg: string) => {
        setLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${msg}`
        ]);
    };

    logWrapper(`Initializing ${activeExperiment.config.type} protocol...`);

    const newRuns: ExperimentRun[] = [];

    if (activeExperiment.config.type === ExperimentType.COMPARATIVE) {
        for (let i = 0; i < activeExperiment.config.runCount; i += 1) {
        newRuns.push(
            {
            id: crypto.randomUUID(),
            experimentId: activeExperiment.config.id,
            runNumber: i + 1,
            label: 'Step-by-Step',
            startTime: Date.now(),
            status: 'pending',
            stepIds: []
            },
            {
            id: crypto.randomUUID(),
            experimentId: activeExperiment.config.id,
            runNumber: i + 1,
            label: 'Refinement Loop',
            startTime: Date.now(),
            status: 'pending',
            stepIds: []
            }
        );
        }
    } else if (activeExperiment.config.type === ExperimentType.ABLATION) {
        for (let i = 0; i < activeExperiment.config.runCount; i += 1) {
        newRuns.push(
            {
            id: crypto.randomUUID(),
            experimentId: activeExperiment.config.id,
            runNumber: i + 1,
            label: 'Full Context',
            startTime: Date.now(),
            status: 'pending',
            stepIds: []
            },
            {
            id: crypto.randomUUID(),
            experimentId: activeExperiment.config.id,
            runNumber: i + 1,
            label: 'Zero Context',
            startTime: Date.now(),
            status: 'pending',
            stepIds: []
            }
        );
        }
    } else if (
      activeExperiment.config.type === ExperimentType.CONSISTENCY_TEXT ||
      activeExperiment.config.type === ExperimentType.CONSISTENCY_ANNOTATION
    ) {
      const variantCount = Math.max(2, activeExperiment.config.runCount);
      for (let i = 0; i < variantCount; i += 1) {
        newRuns.push({
          id: crypto.randomUUID(),
          experimentId: activeExperiment.config.id,
          runNumber: i + 1,
          label: `Variant ${i + 1}`,
          startTime: Date.now(),
          status: 'pending',
          stepIds: []
        });
      }
    } else {
      for (let i = 0; i < activeExperiment.config.runCount; i += 1) {
        newRuns.push({
          id: crypto.randomUUID(),
          experimentId: activeExperiment.config.id,
          runNumber: i + 1,
          label: 'Convergence',
          startTime: Date.now(),
          status: 'pending',
          stepIds: []
        });
      }
    }

    setProject(p => ({
        ...p,
        experiments: p.experiments.map(e =>
        e.config.id === activeExperiment.config.id ? { ...e, runs: newRuns } : e
        )
    }));

    const getRunIdByLabel = (label: string, index: number): string => {
        const matches = newRuns.filter(r => r.label === label);
        return matches[index]?.id || crypto.randomUUID();
    };

    const updateRunStep = (runId: string, step: DocumentVersion) => {
        setProject(current => {
        const newDocuments = [step, ...current.documents];

        const expIndex = current.experiments.findIndex(
            e => e.config.id === activeExperiment.config.id
        );
        if (expIndex === -1) return current;

        const newExps = [...current.experiments];
        const runs = [...newExps[expIndex].runs];
        const runIdx = runs.findIndex(r => r.id === runId);

        if (runIdx !== -1) {
            runs[runIdx] = {
            ...runs[runIdx],
            stepIds: [...runs[runIdx].stepIds, step.id]
            };
            newExps[expIndex].runs = runs;
        }

        return {
            ...current,
            documents: newDocuments,
            experiments: newExps
        };
        });
    };

    const updateStatus = (
        runId: string,
        status: 'running' | 'completed' | 'failed'
    ) => {
        setProject(current => {
        const expIndex = current.experiments.findIndex(
            e => e.config.id === activeExperiment.config.id
        );
        if (expIndex === -1) return current;

        const newExps = [...current.experiments];
        const runs = [...newExps[expIndex].runs];
        const idx = runs.findIndex(r => r.id === runId);

        if (idx !== -1) {
            runs[idx] = { ...runs[idx], status };
            newExps[expIndex].runs = runs;
        }

        return { ...current, experiments: newExps };
        });
    };

    try {
        const report = await runExperimentLoop(
        activeExperiment.config,
        project.resources,
        updateRunStep,
        updateStatus,
        logWrapper,
        getRunIdByLabel
        );
        if (report) {
          setProject(current => ({
            ...current,
            experiments: current.experiments.map(e =>
              e.config.id === activeExperiment.config.id
                ? { ...e, consistencyReport: report }
                : e
            )
          }));
        }
    } catch (err) {
        console.error(err);
        logWrapper('Experiment failed, check console for details');
    } finally {
        setIsRunning(false);
    }
    };


  const ComparativeBarChart = ({ runs }: { runs: ExperimentRun[] }) => {
    const runPairs: Record<
      number,
      { sbs?: ExperimentRun; loop?: ExperimentRun }
    > = {};

    runs.forEach(r => {
      if (!runPairs[r.runNumber]) runPairs[r.runNumber] = {};
      if (r.label === 'Step-by-Step') runPairs[r.runNumber].sbs = r;
      if (r.label === 'Refinement Loop') runPairs[r.runNumber].loop = r;
    });

    const pairs = Object.values(runPairs);
    if (pairs.length === 0) {
      return (
        <div className="text-center text-zinc-600 text-xs py-10">
          No results yet
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-8">
          {pairs.map((pair, idx) => {
            const sbsDocs = pair.sbs ? getDocsForRun(pair.sbs) : [];
            const loopDocs = pair.loop ? getDocsForRun(pair.loop) : [];

            const sbsScore =
              sbsDocs.length > 0
                ? calculateAvgScore(sbsDocs[sbsDocs.length - 1])
                : 0;
            const loopScore =
              loopDocs.length > 0
                ? calculateAvgScore(loopDocs[loopDocs.length - 1])
                : 0;

            const sbsStats = calculateTokenStats(sbsDocs);
            const loopStats = calculateTokenStats(loopDocs);

            const totalTokens = sbsStats.total + loopStats.total || 1;
            const sbsWidth = (sbsStats.total / totalTokens) * 100;
            const loopWidth = (loopStats.total / totalTokens) * 100;

            return (
              <div
                key={idx}
                className="bg-black/30 p-4 rounded border border-zinc-800"
              >
                <h5 className="text-[10px] font-bold uppercase text-zinc-500 mb-4 flex justify-between">
                  <span>Run set {idx + 1}</span>
                  <span>Token efficiency</span>
                </h5>

                <div className="space-y-4">
                  <div className="flex items-center gap-4 border-b border-zinc-800 pb-2">
                    <div className="flex-1 text-right">
                      <div className="text-lg font-bold text-blue-400">
                        {sbsScore}
                      </div>
                      <div className="text-[9px] uppercase text-zinc-500">
                        Step-by-Step score
                      </div>
                    </div>
                    <div className="text-zinc-600 font-mono text-xs">vs</div>
                    <div className="flex-1">
                      <div className="text-lg font-bold text-venice-gold">
                        {loopScore}
                      </div>
                      <div className="text-[9px] uppercase text-zinc-500">
                        Refine loop score
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div className="text-right">
                      <div className="mb-1 text-blue-400 font-bold">
                        Step-by-Step
                      </div>
                      <div className="flex justify-between text-[9px] text-zinc-500">
                        <span>Prompt in:</span>
                        <span>{sbsStats.prompt}</span>
                      </div>
                      <div className="flex justify-between text-[9px] text-zinc-500">
                        <span>Out:</span>
                        <span>{sbsStats.output}</span>
                      </div>
                      <div className="flex justify-between font-mono text-white mt-1 border-t border-zinc-800 pt-1">
                        <span>Total:</span>
                        <span>{sbsStats.total}</span>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-venice-gold font-bold">
                        Refinement
                      </div>
                      <div className="flex justify-between text-[9px] text-zinc-500">
                        <span>Prompt in:</span>
                        <span>{loopStats.prompt}</span>
                      </div>
                      <div className="flex justify-between text-[9px] text-zinc-500">
                        <span>Out:</span>
                        <span>{loopStats.output}</span>
                      </div>
                      <div className="flex justify-between font-mono text-white mt-1 border-t border-zinc-800 pt-1">
                        <span>Total:</span>
                        <span>{loopStats.total}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-blue-400"
                      style={{ width: `${sbsWidth}%` }}
                    />
                    <div
                      className="bg-venice-gold"
                      style={{ width: `${loopWidth}%` }}
                    />
                  </div>

                  <div className="text-center bg-zinc-900/50 p-2 rounded">
                    <div className="text-[10px] text-zinc-500">
                      Tokens spent per quality point
                    </div>
                    <div className="flex justify-center gap-4 mt-1 text-[9px] font-mono">
                      <span className="text-blue-400">
                        SbS:{' '}
                        {sbsScore > 0
                          ? (sbsStats.total / sbsScore).toFixed(0)
                          : '-'}
                      </span>
                      <span className="text-venice-gold">
                        Loop:{' '}
                        {loopScore > 0
                          ? (loopStats.total / loopScore).toFixed(0)
                          : '-'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const AblationChart = ({ runs }: { runs: ExperimentRun[] }) => {
    const fullContextRuns = runs.filter(r => r.label === 'Full Context');
    const zeroContextRuns = runs.filter(r => r.label === 'Zero Context');

    const getFinalScores = (rList: ExperimentRun[]) =>
      rList
        .map(r => {
          const steps = getDocsForRun(r);
          return steps.length > 0
            ? calculateAvgScore(steps[steps.length - 1])
            : 0;
        })
        .filter(s => s > 0);

    const fullScores = getFinalScores(fullContextRuns);
    const zeroScores = getFinalScores(zeroContextRuns);

    if (fullScores.length === 0 || zeroScores.length === 0) {
      return (
        <div className="text-center text-zinc-600 text-xs py-10">
          Waiting for ablation data...
        </div>
      );
    }

    const avgFull = Math.round(
      fullScores.reduce((a, b) => a + b, 0) / fullScores.length
    );
    const avgZero = Math.round(
      zeroScores.reduce((a, b) => a + b, 0) / zeroScores.length
    );

    const diff = avgFull - avgZero;

    return (
      <div className="flex flex-col gap-6 p-8">
        <div className="flex items-center justify-center gap-12">
          <div className="text-center">
            <div className="text-3xl font-bold text-white mb-1">
              {avgFull}
            </div>
            <div className="text-[10px] uppercase text-green-500">
              Full context
            </div>
          </div>

          <div className="flex flex-col items-center">
            <div className="h-px w-24 bg-zinc-700 mb-2 relative">
              <div
                className={`absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold ${
                  diff > 0 ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {diff > 0 ? '+' : ''}
                {diff} pts
              </div>
            </div>
            <span className="text-[9px] text-zinc-600 uppercase">
              Impact
            </span>
          </div>

          <div className="text-center">
            <div className="text-3xl font-bold text-zinc-400 mb-1">
              {avgZero}
            </div>
            <div className="text-[10px] uppercase text-red-500">
              Zero context
            </div>
          </div>
        </div>

        <div className="bg-zinc-900/50 p-4 rounded text-center border border-zinc-800">
          <h5 className="text-[10px] font-bold text-zinc-500 uppercase mb-2">
            Active context configuration for full branch
          </h5>

          <div className="flex flex-wrap gap-2 justify-center mb-4">
            {activeExperiment?.config.activeResourceIds?.map(rid => {
              const r = project.resources.find(res => res.id === rid);
              return r ? (
                <span
                  key={rid}
                  className="text-[9px] bg-zinc-800 px-2 py-1 rounded text-zinc-300 border border-zinc-700"
                >
                  {r.name}
                </span>
              ) : null;
            })}
            {(!activeExperiment?.config.activeResourceIds ||
              activeExperiment.config.activeResourceIds.length === 0) && (
              <span className="text-[9px] italic text-zinc-600">
                None selected
              </span>
            )}
          </div>

          <p className="text-[10px] text-zinc-500 border-t border-zinc-800 pt-2">
            This experiment compares the performance of the model using
            <strong> all above resources</strong> versus
            <strong> no resources</strong>.
          </p>
        </div>
      </div>
    );
  };

  const ConsistencyReportView = ({
    report,
    label
  }: {
    report?: ConsistencyReport;
    label: string;
  }) => {
    if (!report || (!report.textPairs.length && !report.annotationPairs.length)) {
      return (
        <div className="text-center text-zinc-600 p-10">
          <Activity size={32} className="mx-auto mb-2 opacity-50" />
          <p>No consistency report yet. Execute the protocol to generate one.</p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
          <h4 className="text-xs font-bold uppercase text-zinc-400 mb-2">
            {label}
          </h4>
          <p className="text-[10px] text-zinc-500">{report.summary}</p>
          {report.commentary && (
            <p className="text-[11px] text-zinc-300 mt-2 italic">
              {report.commentary}
            </p>
          )}
          {report.baselineLabel && (
            <p className="text-[10px] text-zinc-500 mt-1">
              Baseline: {report.baselineLabel} ({report.baselineTextLength} chars)
            </p>
          )}
        </div>

        {report.variantBreakdown && report.variantBreakdown.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Per-variant overlap metrics
            </h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
              {report.variantBreakdown.map((v, idx) => (
                <div
                  key={idx}
                  className="bg-black/15 border border-zinc-800 rounded p-3 space-y-1"
                >
                  <div className="text-xs font-semibold text-zinc-100">{v.runLabel}</div>
                  <div className="flex justify-between text-[10px] text-zinc-400">
                    <span>Unique vs others</span>
                    <span className="text-orange-300 font-mono">{Math.round(v.uniqueFraction * 100)}%</span>
                  </div>
                  <div className="flex justify-between text-[10px] text-zinc-400">
                    <span>Shared with others</span>
                    <span className="text-blue-300 font-mono flex items-center gap-1">
                      {Math.round(v.sharedFraction * 100)}%
                      <span className="text-[9px] text-zinc-500">
                        {typeof v.sharedWithRatio === 'number'
                          ? `(${Math.round((v.sharedWithRatio || 0) * 100)}% of variants)`
                          : ''}
                      </span>
                    </span>
                  </div>
                  <div className="flex justify-between text-[10px] text-zinc-400">
                    <span>Avg overlap (Jaccard)</span>
                    <span className="text-venice-gold font-mono">{v.averageOverlap}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.textPairs.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Text overlap & style
            </h5>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {report.textPairs.map((p, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-5 gap-2 text-[11px] bg-black/10 border border-zinc-800 rounded p-2"
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-zinc-200">
                      {p.pairLabel}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Unique A: {p.uniqueA} • Unique B: {p.uniqueB}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-venice-gold">
                      {p.overlap}
                    </div>
                    <div className="text-[10px] text-zinc-500">Overlap</div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-zinc-100">
                      {p.lengthDelta}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Length delta
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-blue-300">
                      {p.styleDelta}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Style divergence
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.annotationPairs.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Annotation consistency (AI)
            </h5>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {report.annotationPairs.map((p, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-4 gap-2 text-[11px] bg-black/10 border border-zinc-800 rounded p-2"
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-zinc-200">
                      {p.pairLabel}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Shared (Gemini): {p.shared}{' '}
                      <span className="text-blue-300">
                        ({Math.round((p.sharedFraction || 0) * 100)}%)
                      </span>{' '}
                      | Only A: {p.onlyA} | Only B: {p.onlyB}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Highlight overlap: {p.averageQuoteOverlap ?? 0} · Comment alignment: {p.averageCommentSimilarity ?? 0}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-venice-gold">
                      {p.avgScoreDelta ?? 0}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Score delta
                    </div>
                  </div>
                  <div className="col-span-1 text-[10px] text-zinc-500 flex items-center justify-end text-right">
                    {p.agreementNote
                      ? `Gemini: ${p.agreementNote}`
                      : 'Gemini judged overlap of highlighted comments.'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.gradeComparisons && report.gradeComparisons.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Grade deltas by category
            </h5>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {report.gradeComparisons.map((g, idx) => (
                <div
                  key={idx}
                  className="bg-black/10 border border-zinc-800 rounded p-2"
                >
                  <div className="text-xs font-semibold text-zinc-200 mb-1">
                    {g.pairLabel}
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-[10px] text-zinc-400">
                    {g.categories.map((c, cidx) => (
                      <div key={cidx} className="bg-black/20 p-2 rounded border border-zinc-800">
                        <div className="text-venice-gold font-semibold text-[11px]">
                          {c.category}
                        </div>
                        <div className="flex justify-between">
                          <span>A: {c.scoreA ?? '-'}</span>
                          <span>B: {c.scoreB ?? '-'}</span>
                        </div>
                        <div className="text-[10px] text-blue-300">
                          Δ {c.delta ?? '-'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.annotationDetails && report.annotationDetails.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Annotation samples (per variant)
            </h5>
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {report.annotationDetails.map((detail, idx) => (
                <div key={idx} className="bg-black/10 border border-zinc-800 rounded p-2">
                  <div className="text-xs font-semibold text-zinc-200 mb-2">
                    {detail.runLabel}
                  </div>
                  {detail.annotations.length === 0 ? (
                    <div className="text-[10px] text-zinc-500 italic">No annotations.</div>
                  ) : (
                    <div className="space-y-2">
                      {detail.annotations.map((a, aidx) => (
                        <div key={aidx} className="bg-black/20 p-2 rounded border border-zinc-800 text-[11px] text-zinc-300">
                          <div className="font-bold text-venice-gold">{a.level}</div>
                          <div className="text-zinc-100 mt-1">“{a.quote}”</div>
                          <div className="text-[10px] text-zinc-500 mt-1">{a.comment}</div>
                          {a.sourceQuote && (
                            <div className="text-[10px] text-blue-300 mt-1">
                              Source: {a.sourceQuote}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {report.baselineComparisons && report.baselineComparisons.length > 0 && (
          <div className="bg-[#121214] border border-zinc-800 p-4 rounded">
            <h5 className="text-[10px] uppercase font-bold text-zinc-400 mb-3">
              Baseline vs variants
            </h5>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {report.baselineComparisons.map((p, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-4 gap-2 text-[11px] bg-black/10 border border-zinc-800 rounded p-2"
                >
                  <div className="col-span-2">
                    <div className="font-semibold text-zinc-200">
                      {p.pairLabel}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Unique baseline: {p.uniqueA} • Unique variant: {p.uniqueB}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-venice-gold">
                      {p.overlap}
                    </div>
                    <div className="text-[10px] text-zinc-500">Overlap</div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-bold text-blue-300">
                      {p.styleDelta}
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      Style divergence
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full bg-[#09090b] text-zinc-200 overflow-hidden font-sans">
      <div className="w-64 border-r border-zinc-800 flex flex-col bg-[#0c0c0e]">
        <div className="p-4 border-b border-zinc-800">
          <h2 className="text-sm font-bold uppercase text-zinc-400 mb-4">
            Protocols
          </h2>
          <div className="grid grid-cols-1 gap-2">
            <button
              onClick={() =>
                handleCreateExperiment(ExperimentType.CONVERGENCE)
              }
              className="flex items-center gap-2 p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded text-xs text-zinc-300 transition-all"
            >
              <RefreshCw size={14} className="text-venice-gold" /> Convergence
              loop
            </button>
            <button
              onClick={() =>
                handleCreateExperiment(ExperimentType.COMPARATIVE)
              }
              className="flex items-center gap-2 p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded text-xs text-zinc-300 transition-all"
            >
              <GitBranch size={14} className="text-blue-400" /> Compare
              methods
            </button>
            <button
              onClick={() => handleCreateExperiment(ExperimentType.ABLATION)}
              className="flex items-center gap-2 p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded text-xs text-zinc-300 transition-all"
            >
              <Layers size={14} className="text-green-400" /> Context
              ablation
            </button>
            <button
              onClick={() =>
                handleCreateExperiment(ExperimentType.CONSISTENCY_TEXT)
              }
              className="flex items-center gap-2 p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded text-xs text-zinc-300 transition-all"
            >
              <Activity size={14} className="text-venice-gold" /> Text consistency
            </button>
            <button
              onClick={() =>
                handleCreateExperiment(ExperimentType.CONSISTENCY_ANNOTATION)
              }
              className="flex items-center gap-2 p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded text-xs text-zinc-300 transition-all"
            >
              <Activity size={14} className="text-blue-300" /> Annotation consistency
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {project.experiments.map(exp => (
            <div
              key={exp.config.id}
              onClick={() => {
                setActiveExpId(exp.config.id);
                setEditConfig(exp.config);
              }}
              className={`p-3 border-b border-zinc-800 cursor-pointer transition-colors hover:bg-zinc-900 ${
                activeExpId === exp.config.id
                  ? 'bg-zinc-800 border-l-2 border-l-venice-gold'
                  : ''
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="text-xs font-bold text-zinc-200 truncate max-w-[120px]">
                  {exp.config.name}
                </span>
                <span className="text-[9px] text-zinc-500">
                  {exp.savedAt
                    ? new Date(exp.savedAt).toLocaleDateString()
                    : ''}
                </span>
              </div>
              <div
                className={`text-[9px] uppercase font-bold ${getMethodColor(
                  exp.config.type
                )}`}
              >
                {exp.config.type}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {!activeExperiment ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 gap-4">
            <FlaskConical size={48} className="opacity-20" />
            <p>Select or create a protocol to begin.</p>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="h-14 border-b border-zinc-800 bg-[#0c0c0e] px-6 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-4">
                <h2 className="font-bold text-white">
                  {activeExperiment.config.name}
                </h2>
                <div
                  className={`text-[10px] px-2 py-0.5 border rounded uppercase ${getMethodColor(
                    activeExperiment.config.type
                  )} border-zinc-700 bg-black`}
                >
                  {activeExperiment.config.type}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isRunning ? (
                  <span className="text-venice-gold text-xs animate-pulse font-bold flex items-center gap-2">
                    <RefreshCw size={12} className="animate-spin" /> Processing...
                  </span>
                ) : (
                  <>
                    <button
                      onClick={handleRun}
                      className="bg-venice-gold hover:bg-yellow-600 text-black px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 shadow-lg shadow-yellow-900/20"
                    >
                      <Play size={12} fill="black" /> Execute protocol
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Delete this experiment?')) {
                          setProject(p => ({
                            ...p,
                            experiments: p.experiments.filter(
                              e => e.config.id !== activeExpId
                            )
                          }));
                          setActiveExpId(null);
                          setEditConfig(null);
                        }
                      }}
                      className="p-2 hover:bg-red-900/20 hover:text-red-500 rounded text-zinc-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
              <div className="w-96 border-r border-zinc-800 bg-[#121214] p-5 overflow-y-auto scrollbar-thin">
                <h3 className="text-xs font-bold uppercase text-zinc-500 mb-4 flex items-center gap-2">
                  <Settings size={14} /> Protocol settings
                </h3>

                {editConfig && (
                  <div className="space-y-5">
                    <div className="bg-zinc-900 border border-zinc-800 p-3 rounded">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] uppercase font-bold text-zinc-500">
                          Base configuration
                        </span>
                      </div>
                      <select
                        className="w-full bg-black text-xs text-white border border-zinc-700 rounded p-1 mb-2"
                        value={editConfig.basePromptId || ''}
                        onChange={e => {
                          const val = e.target.value;
                          let updated: ExperimentConfig;
                          if (val === '') {
                            updated = initializeConfigFromLive(editConfig);
                          } else {
                            updated = applySavedPromptToConfig(
                              editConfig,
                              val
                            );
                          }
                          setEditConfig(updated);
                          setProject(p => ({
                            ...p,
                            experiments: p.experiments.map(ex =>
                              ex.config.id === activeExpId
                                ? { ...ex, config: updated }
                                : ex
                            )
                          }));
                        }}
                      >
                        <option value="">
                          Current workspace state (live)
                        </option>
                        {project.savedPrompts.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>

                      <div className="text-[10px] text-zinc-500 italic mb-2">
                        {editConfig.basePromptId
                          ? `Using saved prompt "${project.savedPrompts.find(
                              s => s.id === editConfig.basePromptId
                            )?.name || 'Unknown'}"`
                          : 'Using the current prompt settings from the workspace.'}
                      </div>

                      <button
                        onClick={() => onEditInConfig(editConfig)}
                        className="w-full py-2 bg-transparent border border-venice-gold/30 hover:bg-venice-gold/10 text-venice-gold rounded text-xs font-bold flex items-center justify-center gap-2"
                      >
                        <Edit3 size={12} /> Edit in config tab
                      </button>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">
                        Experiment name
                      </label>
                      <input
                        className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-white"
                        value={editConfig.name}
                        onChange={e =>
                          setEditConfig({
                            ...editConfig,
                            name: e.target.value
                          })
                        }
                        onBlur={() =>
                          setProject(p => ({
                            ...p,
                            experiments: p.experiments.map(e =>
                              e.config.id === activeExpId
                                ? { ...e, config: editConfig }
                                : e
                            )
                          }))
                        }
                      />
                    </div>

                    {activeExperiment.config.type ===
                      ExperimentType.ABLATION && (
                      <div className="bg-green-900/10 p-3 rounded border border-green-900/30">
                        <label className="block text-[10px] uppercase font-bold text-green-500 mb-2">
                          Context for full branch
                        </label>
                        <div className="space-y-1 max-h-32 overflow-y-auto">
                          {project.resources.map(r => (
                            <label
                              key={r.id}
                              className="flex items-center gap-2 text-[10px] text-zinc-400"
                            >
                              <input
                                type="checkbox"
                                checked={editConfig.activeResourceIds.includes(
                                  r.id
                                )}
                                onChange={() => {
                                  const ids =
                                    editConfig.activeResourceIds || [];
                                  const newIds = ids.includes(r.id)
                                    ? ids.filter(x => x !== r.id)
                                    : [...ids, r.id];
                                  const updated: ExperimentConfig = {
                                    ...editConfig,
                                    activeResourceIds: newIds
                                  };
                                  setEditConfig(updated);
                                  setProject(p => ({
                                    ...p,
                                    experiments: p.experiments.map(ex =>
                                      ex.config.id === activeExpId
                                        ? { ...ex, config: updated }
                                        : ex
                                    )
                                  }));
                                }}
                                className="accent-green-500"
                              />
                              <span className="truncate">{r.name}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-[9px] text-zinc-500 mt-2">
                          Protocol will run
                          <strong> full context</strong> (selected above) vs
                          <strong> zero context</strong>.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">
                          {activeExperiment.config.type ===
                          ExperimentType.CONSISTENCY_TEXT ||
                          activeExperiment.config.type ===
                            ExperimentType.CONSISTENCY_ANNOTATION
                            ? 'Variants (min 2)'
                            : 'Runs (sets)'}
                        </label>
                        <input
                          type="number"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs"
                          value={editConfig.runCount}
                          onChange={e =>
                            setEditConfig({
                              ...editConfig,
                              runCount: Math.max(1, Number(e.target.value))
                            })
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">
                          Delay (sec)
                        </label>
                        <input
                          type="number"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs"
                          value={editConfig.delaySeconds}
                          onChange={e =>
                            setEditConfig({
                              ...editConfig,
                              delaySeconds: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="border-t border-zinc-800 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] uppercase font-bold text-zinc-500">
                          Run configuration
                        </label>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-zinc-600">
                            Unified
                          </span>
                          <input
                            type="checkbox"
                            checked={editConfig.useSameConfigForAllRuns}
                            onChange={e => {
                              const updated: ExperimentConfig = {
                                ...editConfig,
                                useSameConfigForAllRuns: e.target.checked
                              };
                              setEditConfig(updated);
                              setProject(p => ({
                                ...p,
                                experiments: p.experiments.map(ex =>
                                  ex.config.id === activeExpId
                                    ? { ...ex, config: updated }
                                    : ex
                                )
                              }));
                            }}
                            className="accent-venice-gold"
                          />
                        </div>
                      </div>

                      {!editConfig.useSameConfigForAllRuns ? (
                        <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                          {Array.from({
                            length: editConfig.runCount
                          }).map((_, idx) => (
                            <div
                              key={idx}
                              className="flex items-center gap-2"
                            >
                              <span className="text-[9px] font-mono text-zinc-500 w-8">
                                Run {idx + 1}
                              </span>
                              <select
                                className="flex-1 bg-zinc-900 border border-zinc-800 rounded text-[10px] text-zinc-300 p-1"
                                value={
                                  editConfig.runConfigs?.[idx] ||
                                  editConfig.basePromptId ||
                                  ''
                                }
                                onChange={e => {
                                  const newRunConfigs = {
                                    ...(editConfig.runConfigs || {})
                                  };
                                  newRunConfigs[idx] = e.target.value;
                                  const updated: ExperimentConfig = {
                                    ...editConfig,
                                    runConfigs: newRunConfigs
                                  };
                                  setEditConfig(updated);
                                  setProject(p => ({
                                    ...p,
                                    experiments: p.experiments.map(ex =>
                                      ex.config.id === activeExpId
                                        ? { ...ex, config: updated }
                                        : ex
                                    )
                                  }));
                                }}
                              >
                                <option value="">
                                  Inherit base config
                                </option>
                                {project.savedPrompts.map(s => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[9px] text-zinc-500 italic p-2 bg-black/20 rounded border border-zinc-800">
                          All runs will use the base configuration selected
                          above.
                        </div>
                      )}
                    </div>

                      {activeExperiment.config.type !==
                        ExperimentType.ABLATION &&
                        activeExperiment.config.type !==
                          ExperimentType.CONSISTENCY_TEXT &&
                        activeExperiment.config.type !==
                          ExperimentType.CONSISTENCY_ANNOTATION && (
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">
                          Refinement loops
                        </label>
                        <input
                          type="number"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs"
                          value={editConfig.iterations}
                          onChange={e =>
                            setEditConfig({
                              ...editConfig,
                              iterations: Number(e.target.value)
                            })
                          }
                        />
                        <p className="text-[9px] text-zinc-500 mt-1">
                          Number of feedback then rewrite cycles.
                        </p>
                      </div>
                    )}

                    <button
                      onClick={() =>
                        setProject(p => ({
                          ...p,
                          experiments: p.experiments.map(e =>
                            e.config.id === activeExpId
                              ? { ...e, config: editConfig }
                              : e
                          )
                        }))
                      }
                      className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold flex items-center justify-center gap-2 mb-2"
                    >
                      <Save size={12} /> Save settings
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
                <div className="flex-1 overflow-y-auto p-6">
                  <div className="mb-8">
                    {activeExperiment.config.type ===
                      ExperimentType.CONVERGENCE && (
                      <div className="text-center text-zinc-600 p-10">
                        <Activity
                          size={32}
                          className="mx-auto mb-2 opacity-50"
                        />
                        <p>
                          Convergence data is available in the timeline tree.
                        </p>
                      </div>
                    )}

                    {activeExperiment.config.type ===
                      ExperimentType.COMPARATIVE && (
                      <div className="bg-[#121214] border border-zinc-800 p-6 rounded">
                        <h4 className="text-xs font-bold uppercase text-zinc-400 mb-6 text-center">
                          Step-by-Step vs refinement loop
                        </h4>
                        <ComparativeBarChart runs={activeExperiment.runs} />
                      </div>
                    )}

                    {activeExperiment.config.type ===
                      ExperimentType.ABLATION && (
                      <div className="bg-[#121214] border border-zinc-800 rounded">
                        <AblationChart runs={activeExperiment.runs} />
                      </div>
                    )}

                    {(activeExperiment.config.type ===
                      ExperimentType.CONSISTENCY_TEXT ||
                      activeExperiment.config.type ===
                        ExperimentType.CONSISTENCY_ANNOTATION) && (
                      <div className="bg-[#121214] border border-zinc-800 rounded p-4">
                        <ConsistencyReportView
                          report={activeExperiment.consistencyReport}
                          label={
                            activeExperiment.config.type ===
                            ExperimentType.CONSISTENCY_TEXT
                              ? 'Text consistency'
                              : 'Annotation consistency'
                          }
                        />
                      </div>
                    )}
                  </div>

                  <div className="border border-zinc-800 rounded overflow-hidden">
                    <div className="bg-[#121214] p-2 border-b border-zinc-800 text-[10px] font-bold uppercase text-zinc-500 flex justify-between">
                      <span>Live execution log</span>
                      <span>{logs.length} lines</span>
                    </div>
                    <div className="bg-black p-4 h-48 overflow-y-auto font-mono text-[10px] space-y-1">
                      {logs.length === 0 && (
                        <div className="text-zinc-700 italic">
                          Ready to start...
                        </div>
                      )}
                      {logs.map((l, i) => (
                        <div key={i} className="text-green-500/80">
                          {l}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
