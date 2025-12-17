
import React, { useState, useMemo } from 'react';
import { generateNarrative, evaluateCoherence, performGrounding, buildFullPrompt, buildEvaluationPrompt } from './services/geminiService';
import { calculateDiffStats } from './services/diffService';
import { 
  ProjectState, DocumentVersion, Annotation, ModelId, 
  GenerationMethod, Resource, RefinementConfig, StepConfig, EvaluationCategory, DiffStats, GroundingEntry,
  ModePrompts, SavedPrompt, ExperimentConfig,
  DEFAULT_SYSTEM_PROMPT, DEFAULT_REFINE_PROMPT, DEFAULT_CATEGORIES, DEFAULT_EVALUATOR_PROMPT, DEFAULT_GROUNDING_PROMPT 
} from './types';
import { AnnotationSidebar } from './components/AnnotationSidebar';
import { GroundingSidebar } from './components/GroundingSidebar';
import { DocumentViewer } from './components/DocumentViewer';
import { TimelineTree } from './components/TimelineTree';
import { AnalysisDashboard } from './components/AnalysisDashboard';
import { ExperimentDashboard } from './components/ExperimentDashboard';
import { 
  Save, Download, Upload, Play, RefreshCw, 
  Settings, FileText, LayoutTemplate, Printer,
  Plus, Trash2, Users, BookOpen, List, Check, File, Activity, Loader, RotateCcw, FlaskConical, Split, Link
} from 'lucide-react';

const INITIAL_PROJECT: ProjectState = {
  id: 'default-research',
  name: 'Venice 1740 Simulation Study',
  currentUser: 'Researcher_1',
  defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultRefinePrompt: DEFAULT_REFINE_PROMPT,
  defaultEvaluatorPrompt: DEFAULT_EVALUATOR_PROMPT,
  defaultGroundingPrompt: DEFAULT_GROUNDING_PROMPT,
  evaluatorModelId: ModelId.FLASH_2_5,
  groundingModelId: ModelId.FLASH_2_5,
  evaluationCategories: DEFAULT_CATEGORIES,
  savedPrompts: [],
  resources: [
    { id: 'r1', name: 'De Brosses: Lettres familières (Excerpt)', type: 'primary_source', content: 'The conservatories of music in Venice are unique. They are maintained at infinite cost by the public...', usageInstruction: 'Use for style and tone.', enabled: true },
    { id: 'r2', name: 'Context: Conclave of 1740', type: 'context', content: 'Following the death of Clement XII, the conclave lasted six months.', usageInstruction: 'Ensure factual accuracy.', enabled: true }
  ],
  documents: [],
  experiments: []
};



const App: React.FC = () => {
  // Global State
  const [project, setProject] = useState<ProjectState>(INITIAL_PROJECT);
  const [currentDocId, setCurrentDocId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'workspace' | 'config' | 'print' | 'analysis' | 'experiment'>('workspace');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isGrounding, setIsGrounding] = useState(false); // NEW
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedGroundingId, setSelectedGroundingId] = useState<string | null>(null); // NEW
  const [pendingQuote, setPendingQuote] = useState<string>('');
  const [configFeedback, setConfigFeedback] = useState<string | null>(null);

  
  // Workspace View State
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [showGroundingPanel, setShowGroundingPanel] = useState(false); // NEW

  // CONFIGURATION STATE
  const [configTab, setConfigTab] = useState<'direct' | 'step' | 'refine' | 'eval' | 'grounding'>('direct');
  const [selectedModel, setSelectedModel] = useState<ModelId>(ModelId.FLASH_2_5);
  const [thinkingBudget, setThinkingBudget] = useState(2048); 
  
  // Separated Prompts
  const [modePrompts, setModePrompts] = useState<ModePrompts>({
    direct: "Describe attending a concert at the Ospedale della Pietà during the Carnival season of 1740.",
    step: "Describe attending a concert at the Ospedale della Pietà during the Carnival season of 1740.",
    refine: DEFAULT_REFINE_PROMPT
  });

  // Step-by-Step Config
  const [stepConfig, setStepConfig] = useState<StepConfig>({ 
    stepSize: '1 paragraph', 
    showThoughts: true,
    enableSelfCorrection: false,
    selfCorrectionInstruction: "Review the previous step. If it lacks coherence, REWRITE it. Otherwise, proceed."
  });

  // Refinement Config
  const [refineConfig, setRefineConfig] = useState<RefinementConfig>({
    includeOriginalText: true,
    includeAiAnnotations: true,
    includeHumanAnnotations: true,
    activeResourceIds: []
  });

  // Resource Management UI State
  const [isAddingResource, setIsAddingResource] = useState(false);
  const [newResource, setNewResource] = useState<Partial<Resource>>({ name: '', content: '', usageInstruction: '' });

  // Saved Prompts State
  const [promptSaveName, setPromptSaveName] = useState('');
  const [activeSavedPromptId, setActiveSavedPromptId] = useState<string | null>(null);
  
  // Computed
  const currentDoc = project.documents.find(d => d.id === currentDocId);
  const parentDoc = currentDoc?.parentId ? project.documents.find(d => d.id === currentDoc.parentId) : null;

  // Determine which annotations to show (Current or Parent if Diff Mode)
  const displayAnnotations = (isDiffMode && parentDoc) ? parentDoc.annotations : (currentDoc?.annotations || []);
  const displayGrounding = (isDiffMode && parentDoc) ? parentDoc.groundingEntries : (currentDoc?.groundingEntries || []);

  const displayScores = (isDiffMode && parentDoc) ? parentDoc.scores : (currentDoc?.scores || {});
  const displayDocId = (isDiffMode && parentDoc) ? parentDoc.id : currentDocId;
  const refineToggles: { key: Exclude<keyof RefinementConfig, 'activeResourceIds'>; label: string; hint: string }[] = [
    { key: 'includeOriginalText', label: 'Previous text', hint: 'Feed the selected document back into the loop.' },
    { key: 'includeAiAnnotations', label: 'AI critique', hint: 'Inject AI/Evaluator notes as feedback.' },
    { key: 'includeHumanAnnotations', label: 'Human notes', hint: 'Include reviewer annotations and comments.' }
  ];
  const formatDocLabel = (doc: DocumentVersion, idx: number) => {
    const order = project.documents.length - idx;
    const methodLabel =
      doc.method === GenerationMethod.REFINE_LOOP
        ? 'Refine'
        : doc.method === GenerationMethod.STEP_BY_STEP
          ? 'Step'
          : 'Direct';
    const preview = doc.content.replace(/\s+/g, ' ').slice(0, 60);
    return `#${order} - ${methodLabel} - ${new Date(doc.timestamp).toLocaleString()} - ${preview}`;
  };
  
  // Helper to get current active prompt text based on tab
  const activeTaskPrompt = useMemo(() => {
    if (configTab === 'refine') return modePrompts.refine;
    if (configTab === 'step') return modePrompts.step;
    return modePrompts.direct;
  }, [configTab, modePrompts]);





  const currentLiveConfig: SavedPrompt = useMemo(
    () => ({
      id: activeSavedPromptId || 'temp_live',
      name: activeSavedPromptId
        ? project.savedPrompts.find(s => s.id === activeSavedPromptId)?.name ||
          'Live Workspace'
        : 'Live Workspace',
      systemPrompt: project.defaultSystemPrompt,
      taskPrompt: modePrompts.direct,
      modePrompts,
      stepConfig,
      refineConfig,
      modelId: selectedModel,
      thinkingBudget,
      defaultRefinePrompt: modePrompts.refine,
      defaultEvaluatorPrompt: project.defaultEvaluatorPrompt,
      defaultGroundingPrompt: project.defaultGroundingPrompt,
      evaluationCategories: project.evaluationCategories,
      resources: project.resources.map(r => ({ ...r })),
      activeResourceIds: project.resources.filter(r => r.enabled).map(r => r.id),
      evaluatorModelId: project.evaluatorModelId,
      groundingModelId: project.groundingModelId
    }),
    [
      activeSavedPromptId,
      project.savedPrompts,
      project.defaultSystemPrompt,
      project.defaultEvaluatorPrompt,
      project.defaultGroundingPrompt,
      project.evaluationCategories,
      project.resources,
      project.evaluatorModelId,
      project.groundingModelId,
      modePrompts,
      stepConfig,
      refineConfig,
      selectedModel,
      thinkingBudget
    ]
  );  

  const updateActivePrompt = (text: string) => {
    setModePrompts(prev => ({
        ...prev,
        [configTab === 'direct' || configTab === 'eval' || configTab === 'grounding' ? 'direct' : configTab]: text
    }));
  };

  // --- Preview Logic ---
  const fullPromptPreview = useMemo(() => {
    if (configTab === 'eval') {
        return buildEvaluationPrompt(
            currentDoc?.content || "[Document Text Will Be Inserted Here]",
            project.resources,
            project.evaluationCategories,
            project.defaultEvaluatorPrompt || DEFAULT_EVALUATOR_PROMPT
        );
    }
      if (configTab === 'grounding') {
          let p = project.defaultGroundingPrompt || DEFAULT_GROUNDING_PROMPT;
         
  
          const activeResources = project.resources.filter(r => r.enabled);

        const contextBlock = activeResources.length > 0 
          ? activeResources
              .map(r => `[ID: ${r.id}] ${r.name}:\n${r.content}`)
              .join('\n\n')
          : 'No specific resources provided.';
          p = p.replace(/{{TEXT}}/g, currentDoc?.content || "[Document Text]");
          p = p.replace(/{{CONTEXT}}/g, contextBlock);
          return p;
      }

      if (configTab === 'refine' && !currentDoc) {
          return 'Refinement mode is ready. Select a document in the Refinement Context panel to preview how it will be injected.';
      }






    const getMethod = () => {
        if (configTab === 'step') return GenerationMethod.STEP_BY_STEP;
        if (configTab === 'refine') return GenerationMethod.REFINE_LOOP;
        return GenerationMethod.STANDARD;
    };
    
    const refineCtx = (configTab === 'refine' && currentDoc) ? {
        originalText: currentDoc.content,
        annotations: currentDoc.annotations,
        config: refineConfig
    } : undefined;

    return buildFullPrompt({
        taskPrompt: activeTaskPrompt,
        resources: project.resources,
        systemInstruction: project.defaultSystemPrompt,
        refinementContext: refineCtx,
        stepConfig: configTab === 'step' ? stepConfig : undefined
    });
  }, [activeTaskPrompt, project.resources, project.defaultSystemPrompt, configTab, refineConfig, stepConfig, currentDoc, project.defaultEvaluatorPrompt, project.defaultGroundingPrompt, project.evaluationCategories]);




  // --- Actions ---

  const handleGenerate = async () => {
    if (!process.env.API_KEY) return alert("Missing API KEY");
    if (configTab === 'refine' && !currentDoc) {
      alert("Select a document to refine or generate a new draft first.");
      return;
    }
    setIsGenerating(true);
    setIsDiffMode(false); // Reset diff mode on new gen
    
    let method = GenerationMethod.STANDARD;
    if (configTab === 'step') method = GenerationMethod.STEP_BY_STEP;
    if (configTab === 'refine') method = GenerationMethod.REFINE_LOOP;

    try {
      const { text, thoughts } = await generateNarrative(
        fullPromptPreview, 
        project.defaultSystemPrompt, 
        selectedModel, 
        method,
      );

      // Calculate Diff Stats if Refining
      let diffStats: DiffStats | undefined;
      if (method === GenerationMethod.REFINE_LOOP && currentDoc) {
        diffStats = calculateDiffStats(currentDoc.content, text);
      }

      const newDoc: DocumentVersion = {
        id: crypto.randomUUID(),
        parentId: (method === GenerationMethod.REFINE_LOOP && currentDoc) ? currentDoc.id : undefined,
        timestamp: Date.now(),
        content: text,
        thoughts: thoughts.length > 0 ? thoughts : undefined,
        modelId: selectedModel,
        method: method,
        systemPromptSnapshot: project.defaultSystemPrompt,
        taskPromptSnapshot: activeTaskPrompt,
        fullPromptSnapshot: fullPromptPreview,
        stepConfig: method === GenerationMethod.STEP_BY_STEP ? stepConfig : undefined,
        refinementConfig: method === GenerationMethod.REFINE_LOOP ? refineConfig : undefined,
        activeResourceIds: method === GenerationMethod.REFINE_LOOP 
          ? refineConfig.activeResourceIds 
          : project.resources.filter(r => r.enabled).map(r => r.id),
        annotations: [],
        groundingEntries: [], // Init empty
        scores: {},
        diffStats: diffStats
      };

      setProject(p => ({ ...p, documents: [newDoc, ...p.documents] }));
      setCurrentDocId(newDoc.id);
      setActiveTab('workspace');
    } catch (e) {
      console.error(e);
      alert("Generation Error - Check Console");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleEvaluate = async () => {
    if (!currentDoc) return;
    setIsGenerating(true);
    setIsEvaluating(true);
    try {
      const result = await evaluateCoherence(
        currentDoc.content, 
        project.resources, 
        project.evaluationCategories,
        project.evaluatorModelId,
        project.defaultEvaluatorPrompt || DEFAULT_EVALUATOR_PROMPT
      );
      
      const newAnnotations: Annotation[] = result.annotations.map((a: any) => ({
        id: crypto.randomUUID(),
        quote: a.quote,
        level: a.level,
        comment: a.comment,
        sourceId: a.sourceId,
        sourceQuote: a.sourceQuote,
        author: 'AI',
        confirmations: [],
        refutations: [],
        timestamp: Date.now()
      }));

      const newScores = { ...currentDoc.scores };
      if (result.scores) {
        Object.keys(result.scores).forEach(key => {
           const catId = project.evaluationCategories.find(c => c.name === key)?.id || key;
           if (!newScores[catId]) newScores[catId] = {};
           newScores[catId]['AI'] = result.scores[key];
        });
      }

      updateDoc(currentDoc.id, { 
        annotations: [...currentDoc.annotations, ...newAnnotations],
        scores: newScores
      });
    } catch (e) {
      console.error(e);
      alert("Evaluation Failed");
    } finally {
      setIsGenerating(false);
      setIsEvaluating(false);
    }
  };

  const handleGrounding = async () => {
    if (!currentDoc) return;
    setIsGenerating(true);
    setIsGrounding(true);
    setShowGroundingPanel(true); // Auto open panel

    try {
        const entries = await performGrounding(
            currentDoc.content,
            project.resources,
            project.groundingModelId || ModelId.FLASH_2_5,
            project.defaultGroundingPrompt || DEFAULT_GROUNDING_PROMPT
        );
        
        updateDoc(currentDoc.id, { groundingEntries: entries });
    } catch (e) {
        console.error(e);
        alert("Grounding Failed");
    } finally {
        setIsGenerating(false);
        setIsGrounding(false);
    }
  };

  const handleRestoreConfig = (doc: DocumentVersion) => {
    // 1. Set Global Params
    setProject(p => ({ ...p, defaultSystemPrompt: doc.systemPromptSnapshot }));
    setSelectedModel(doc.modelId as ModelId);

    // 2. Determine Tab
    let targetTab: 'direct' | 'step' | 'refine' = 'direct';
    if (doc.method === GenerationMethod.STEP_BY_STEP) targetTab = 'step';
    if (doc.method === GenerationMethod.REFINE_LOOP) targetTab = 'refine';
    
    // 3. Set Specific Params & Prompt
    setModePrompts(prev => ({
        ...prev,
        [targetTab]: doc.taskPromptSnapshot
    }));
    
    if (doc.stepConfig) setStepConfig(doc.stepConfig);
    if (doc.refinementConfig) setRefineConfig(doc.refinementConfig);

    // 4. Switch
    setConfigTab(targetTab);
    setActiveTab('config');
  };

  const handlePrepareRefine = () => {
    if (!currentDoc) return;
    setConfigTab('refine');
    setRefineConfig({
        ...refineConfig,
        activeResourceIds: currentDoc.activeResourceIds
    });
    setActiveTab('config');
  };


  const savePromptConfig = () => {
    if (!promptSaveName) {
      alert("Enter a name for this prompt.");
      return;
    }

    const newConfig = {
      id: crypto.randomUUID(),
      name: promptSaveName,
      systemPrompt: project.defaultSystemPrompt,
      modePrompts,          // direct + step + refine prompts
      stepConfig,           // full step config
      refineConfig,         // full refine config
      modelId: selectedModel,
      thinkingBudget,
      defaultRefinePrompt: modePrompts.refine,
      defaultEvaluatorPrompt: project.defaultEvaluatorPrompt,
      defaultGroundingPrompt: project.defaultGroundingPrompt,
      evaluationCategories: project.evaluationCategories.map(c => ({ ...c })),
      resources: project.resources.map(r => ({ ...r })),
      activeResourceIds: project.resources.filter(r => r.enabled).map(r => r.id),
      evaluatorModelId: project.evaluatorModelId,
      groundingModelId: project.groundingModelId
    };

    setProject(p => ({
      ...p,
      savedPrompts: [...p.savedPrompts, newConfig]
    }));

    setPromptSaveName('');
  };


  const loadPromptConfig = (id: string) => {
    const saved = project.savedPrompts.find(s => s.id === id);
    if (!saved) {
      return;
    }

    // remember which config is currently loaded (for the Edit button)
    setActiveSavedPromptId(id);

    // apply global project settings (system/evaluator/grounding/resources/categories)
    setProject(p => {
      const clonedResources = saved.resources
        ? saved.resources.map(r => ({ ...r }))
        : p.resources.map(r =>
            saved.activeResourceIds
              ? { ...r, enabled: saved.activeResourceIds.includes(r.id) }
              : { ...r }
          );

      return {
        ...p,
        defaultSystemPrompt: saved.systemPrompt,
        defaultRefinePrompt:
          saved.defaultRefinePrompt ||
          saved.modePrompts?.refine ||
          p.defaultRefinePrompt,
        defaultEvaluatorPrompt:
          saved.defaultEvaluatorPrompt || p.defaultEvaluatorPrompt,
        defaultGroundingPrompt:
          saved.defaultGroundingPrompt || p.defaultGroundingPrompt,
        evaluationCategories: saved.evaluationCategories
          ? saved.evaluationCategories.map(c => ({ ...c }))
          : p.evaluationCategories,
        evaluatorModelId: saved.evaluatorModelId || p.evaluatorModelId,
        groundingModelId: saved.groundingModelId || p.groundingModelId,
        resources: clonedResources
      };
    });

    // prompts
    if (saved.modePrompts) {
      const syncedModes = { ...saved.modePrompts };
      if (saved.defaultRefinePrompt) {
        syncedModes.refine = saved.defaultRefinePrompt;
      }
      // new rich configs
      setModePrompts(syncedModes);
    } else if (saved.taskPrompt) {
      // legacy configs with only one task prompt
      setModePrompts(prev => ({
        ...prev,
        direct: saved.taskPrompt || prev.direct,
        step: saved.taskPrompt || prev.step,
        refine:
          saved.defaultRefinePrompt ||
          saved.taskPrompt ||
          prev.refine
      }));
    }

    // step and refine config
    if (saved.stepConfig) {
      setStepConfig(saved.stepConfig);
      setConfigTab('step');
    } else {
      setConfigTab('direct');
    }

    if (saved.refineConfig) {
      setRefineConfig(saved.refineConfig);
    }

    // model and budget
    if (saved.modelId) {
      setSelectedModel(saved.modelId);
    }
    if (typeof saved.thinkingBudget === 'number') {
      setThinkingBudget(saved.thinkingBudget);
    }
  };


  const updatePromptConfig = () => {
    if (!activeSavedPromptId) {
      alert("Load a saved config first, then click Edit.");
      return;
    }

    setProject(p => ({
      ...p,
      savedPrompts: p.savedPrompts.map(sp =>
        sp.id === activeSavedPromptId
          ? {
              ...sp,
              systemPrompt: p.defaultSystemPrompt,
              modePrompts,
              stepConfig,
              refineConfig,
              modelId: selectedModel,
              thinkingBudget,
              defaultRefinePrompt: modePrompts.refine,
              defaultEvaluatorPrompt: p.defaultEvaluatorPrompt,
              defaultGroundingPrompt: p.defaultGroundingPrompt,
              evaluationCategories: p.evaluationCategories.map(c => ({ ...c })),
              resources: p.resources.map(r => ({ ...r })),
              activeResourceIds: p.resources.filter(r => r.enabled).map(r => r.id),
              evaluatorModelId: p.evaluatorModelId,
              groundingModelId: p.groundingModelId
            }
          : sp
      )
    }));

    // Feedback visuel rapide
    setConfigFeedback("Config updated");
    setTimeout(() => setConfigFeedback(null), 2000);
  };



  const handleEditExperimentConfig = (config: ExperimentConfig) => {
    const activeIds =
      config.refineConfig?.activeResourceIds || config.activeResourceIds;

    setProject(p => ({
      ...p,
      defaultSystemPrompt: config.systemPrompt,
      defaultRefinePrompt: config.refinePrompt,
      defaultEvaluatorPrompt: config.evaluatorPrompt,
      evaluatorModelId: config.evaluatorModelId,
      evaluationCategories: config.evaluationCategories,
      resources: p.resources.map(r => ({
        ...r,
        enabled: activeIds.includes(r.id)
      }))
    }));

    setModePrompts(prev => ({
      ...prev,
      direct: config.taskPrompt,
      step: config.stepPrompt || config.taskPrompt,
      refine: config.refinePrompt || prev.refine
    }));

    if (config.stepConfig) {
      setStepConfig(config.stepConfig);
    }
    if (config.refineConfig) {
      setRefineConfig(config.refineConfig);
    }

    setSelectedModel(config.generatorModelId);

    setConfigTab('direct');
    setActiveTab('config');
  };



  const updateDoc = (id: string, updates: Partial<DocumentVersion>) => {
    setProject(p => ({
      ...p,
      documents: p.documents.map(d => d.id === id ? { ...d, ...updates } : d)
    }));
  };

  const updateScore = (categoryId: string, value: number) => {
    if (!currentDoc) return;
    const newScores = { ...currentDoc.scores };
    if (!newScores[categoryId]) newScores[categoryId] = {};
    newScores[categoryId][project.currentUser] = value;
    updateDoc(currentDoc.id, { scores: newScores });
  };

  // --- Persistence ---

  const exportProject = () => {
    const data = JSON.stringify(
      {
        ...project,
        _uiConfig: {
          modePrompts,
          stepConfig,
          refineConfig,
          selectedModel,
          thinkingBudget
        }
      },
      null,
      2
    );

    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Venice_Chronos_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };


  const importProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();

    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result as string;
        const data = JSON.parse(raw);

        if (data.id && data.documents) {
          const { _uiConfig, ...projectData } = data;

          setProject({ ...INITIAL_PROJECT, ...projectData });

          if (projectData.documents.length > 0) {
            setCurrentDocId(projectData.documents[0].id);
          }

          // restore ui config if present
          if (_uiConfig) {
            if (_uiConfig.modePrompts) {
              setModePrompts(_uiConfig.modePrompts);
            }
            if (_uiConfig.stepConfig) {
              setStepConfig(_uiConfig.stepConfig);
            }
            if (_uiConfig.refineConfig) {
              setRefineConfig(_uiConfig.refineConfig);
            }
            if (_uiConfig.selectedModel) {
              setSelectedModel(_uiConfig.selectedModel);
            }
            if (typeof _uiConfig.thinkingBudget === 'number') {
              setThinkingBudget(_uiConfig.thinkingBudget);
            }
          }
        } else {
          alert("Invalid Project Format");
        }
      } catch (err) {
        alert("JSON Parse Error");
      }
    };

    reader.readAsText(file);
  };


  // --- Resource Management ---
  
  const handleResourceFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsAddingResource(true);

    setNewResource(prev => ({
        ...prev,
        name: file.name.split('.')[0],
    }));

    const reader = new FileReader();
    reader.onload = (ev) => {
        const content = ev.target?.result as string;
        setNewResource(prev => ({
            ...prev,
            content: content,
            usageInstruction: prev.usageInstruction || "Use as historical context."
        }));
    };
    
    if (file.type.includes('text') || file.name.endsWith('.md') || file.name.endsWith('.json')) {
        reader.readAsText(file);
    } else {
        setNewResource(prev => ({
            ...prev,
            content: "[Content could not be parsed automatically. Please paste text here from your document.]",
            usageInstruction: "Reference this material for accurate details."
        }));
    }
  };

  const addResource = () => {
    if (!newResource.name || !newResource.content) return alert("Name and Content required");
    setProject(p => ({
        ...p,
        resources: [...p.resources, {
            id: crypto.randomUUID(),
            name: newResource.name!,
            content: newResource.content!,
            usageInstruction: newResource.usageInstruction || '',
            type: 'context',
            enabled: true
        }]
    }));
    setIsAddingResource(false);
    setNewResource({name: '', content: '', usageInstruction: ''});
  };

  const calculateDocAverage = (doc: DocumentVersion) => {
    let total = 0;
    let count = 0;
    Object.values(doc.scores).forEach(catScores => {
        Object.values(catScores).forEach(score => {
            total += score;
            count++;
        });
    });
    return count > 0 ? Math.round(total / count) : '-';
  }

  const getReviewerList = (doc: DocumentVersion) => {
    const authors = new Set<string>([project.currentUser]);
    doc.annotations.forEach(a => authors.add(a.author));
    Object.values(doc.scores).forEach(cat => {
        Object.keys(cat).forEach(user => authors.add(user));
    });
    return Array.from(authors).join(', ');
  };

  // Direct Print Function
  const handlePrint = () => {
    // Ensure tab is print before printing to render DOM
    if (activeTab !== 'print') {
        setActiveTab('print');
        // Give React a frame to render
        setTimeout(() => window.print(), 200);
    } else {
        window.print();
    }
  };

  const handleExportHTML = () => {
    if (!currentDoc) return;
    const reportContent = document.getElementById('report-content');
    if (!reportContent) return;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FDHSim Report - ${currentDoc.id}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              paper: '#fdfbf7',
              ink: '#2c2929',
              'venice-red': '#a63c3c',
              'venice-gold': '#d4af37',
            },
            fontFamily: {
              serif: ['Georgia', 'Cambria', 'Times New Roman', 'Times', 'serif'],
              sans: ['Inter', 'system-ui', 'sans-serif'],
              mono: ['Fira Code', 'Courier New', 'monospace'],
            }
          },
        },
      }
    </script>
    <style>
      body { background-color: white; color: black; }
      .prose-research p { margin-bottom: 1.5em; line-height: 1.8; }
    </style>
</head>
<body class="bg-white text-black p-8 max-w-[210mm] mx-auto">
    ${reportContent.innerHTML}
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Venice_Chronos_Report_${currentDoc.id.substring(0,8)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen w-full bg-[#09090b] text-zinc-200 font-sans overflow-hidden selection:bg-venice-gold selection:text-black print:block print:h-auto print:overflow-visible print:bg-white">
      
      {/* 1. Navigation Sidebar */}
      <div className="sidebar w-72 bg-[#09090b] border-r border-zinc-800 flex flex-col shrink-0 print:hidden">
        <div className="p-5 border-b border-zinc-800">
          <h1 className="font-serif text-xl text-zinc-100 font-bold tracking-wide mb-1">FDHSim</h1>
          <p className="text-[10px] text-venice-gold font-bold uppercase tracking-widest">Coherence Engine v3.2</p>
        </div>

        <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
            <div className="flex items-center justify-between px-1 mb-3">
               <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">History Tree</span>
               <div className="flex gap-2">
                 <button onClick={exportProject} title="Export" className="text-zinc-500 hover:text-white"><Download size={14}/></button>
                 <label className="cursor-pointer text-zinc-500 hover:text-white">
                   <Upload size={14}/>
                   <input type="file" className="hidden" onChange={importProject} accept=".json"/>
                 </label>
               </div>
            </div>
            
            <TimelineTree 
                documents={project.documents}
                currentDocId={currentDocId}
                onSelect={(id) => {
                  setCurrentDocId(id);
                  setIsDiffMode(false); // Reset diff when changing doc
                }}
            />
        </div>

        <div className="p-4 border-t border-zinc-800 bg-[#0c0c0e]">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded bg-zinc-800 flex items-center justify-center text-venice-gold font-bold text-xs border border-zinc-700">
               <Users size={14} />
             </div>
             <input 
                className="bg-transparent text-sm font-bold text-white outline-none w-full placeholder-zinc-600"
                value={project.currentUser}
                onChange={(e) => setProject({...project, currentUser: e.target.value})}
                placeholder="Researcher ID..."
             />
          </div>
        </div>
      </div>

      {/* 2. Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <header className="h-14 border-b border-zinc-800 bg-[#0c0c0e] flex items-center justify-between px-6 shrink-0 z-10 print:hidden">
          <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
            <button onClick={() => setActiveTab('workspace')} className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all ${activeTab === 'workspace' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Workspace</button>
            <button onClick={() => setActiveTab('config')} className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all ${activeTab === 'config' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Configuration</button>
            <button onClick={() => setActiveTab('experiment')} className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all ${activeTab === 'experiment' ? 'bg-venice-gold text-black' : 'text-zinc-500 hover:text-zinc-300'}`}>Auto-Analysis</button>
            <button onClick={handlePrint} className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all ${activeTab === 'print' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Report</button>
            <button onClick={() => setActiveTab('analysis')} className={`px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-all ${activeTab === 'analysis' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Stats</button>
          </div>

          <div className="flex items-center gap-3">
             {activeTab === 'workspace' && currentDoc && (
               <>
                 {parentDoc && (
                   <button
                     onClick={() => setIsDiffMode(!isDiffMode)}
                     className={`text-xs font-bold flex items-center gap-2 px-3 py-2 rounded transition-all border ${
                       isDiffMode 
                         ? 'bg-venice-gold/10 text-venice-gold border-venice-gold' 
                         : 'text-zinc-400 hover:text-white hover:bg-zinc-800 border-transparent'
                     }`}
                     title="Compare changes with previous version"
                   >
                     <Split size={14} />
                     {isDiffMode ? 'Exit Diff' : 'Compare Changes'}
                   </button>
                 )}
                 <div className="w-px h-4 bg-zinc-700 mx-1"></div>
                
                {/* NEW: Show Grounding Toggle */}
                <button
                    onClick={() => setShowGroundingPanel(!showGroundingPanel)}
                    className={`text-xs font-bold flex items-center gap-2 px-3 py-2 rounded transition-all border ${
                        showGroundingPanel
                            ? 'bg-cyan-900/30 text-cyan-400 border-cyan-900'
                            : 'text-zinc-400 hover:text-white hover:bg-zinc-800 border-transparent'
                    }`}
                    title="Toggle Source Grounding Panel"
                >
                    <BookOpen size={14} />
                    {showGroundingPanel ? 'Hide Sources' : 'Show Sources'}
                </button>

                <button 
                    onClick={() => handleRestoreConfig(currentDoc)}
                    className="text-xs font-bold text-zinc-500 hover:text-white flex items-center gap-2 px-3 py-2 rounded hover:bg-zinc-800 transition-colors mr-2"
                    title="Restore this document's specific settings and prompt to the configuration tab"
                >
                    <RotateCcw size={14}/> Reuse Config
                </button>
                 <button onClick={handlePrepareRefine} className="text-xs font-bold text-zinc-400 hover:text-venice-gold flex items-center gap-2 px-3 py-2 rounded hover:bg-zinc-800 transition-colors">
                  <RefreshCw size={14}/> Refine
                </button>
                
                {/* Grounding Button */}
                <button 
                    onClick={handleGrounding} 
                    disabled={isGenerating} 
                    className="bg-zinc-800 hover:bg-cyan-900/40 border border-zinc-600 hover:border-cyan-500 text-zinc-200 hover:text-cyan-100 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded flex items-center gap-2 disabled:opacity-50"
                 >
                    {isGrounding ? <Loader className="animate-spin" size={14}/> : <Link size={14}/>}
                    {isGrounding ? 'Check Sources...' : 'Grounding'}
                </button>

                 <button 
                    onClick={handleEvaluate} 
                    disabled={isGenerating} 
                    className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded flex items-center gap-2 disabled:opacity-50"
                 >
                    {isEvaluating ? <Loader className="animate-spin" size={14}/> : <LayoutTemplate size={14}/>}
                    {isEvaluating ? 'Evaluating...' : 'Evaluate'}
                </button>
               </>
             )}
             {activeTab === 'config' && configTab !== 'eval' && configTab !== 'grounding' && (
                <button onClick={handleGenerate} disabled={isGenerating} className="bg-venice-red hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wider px-6 py-2 rounded flex items-center gap-2 shadow-lg shadow-red-900/20 transition-all hover:scale-105">
                {isGenerating ? <Loader className="animate-spin" size={14}/> : <Play size={14} fill="currentColor" />}
                {configTab === 'refine' ? 'Run Refinement' : 'Generate'}
                </button>
             )}
          </div>
        </header>

        <main className="flex-1 overflow-hidden relative bg-[#09090b] print:bg-white print:overflow-visible print:h-auto print:block">
          
          {/* VIEW: CONFIG */}
          {activeTab === 'config' && (
            <div className="absolute inset-0 overflow-y-auto p-6 w-full">
              <div className="max-w-7xl mx-auto grid grid-cols-12 gap-8">
                
                {/* Main Config Column */}
                <div className="col-span-7 space-y-6">
                   
                   {/* Mode Tabs */}
                   <div className="flex border-b border-zinc-800 mb-6">
                      {[
                          { id: 'direct', label: 'Direct', icon: FileText },
                          { id: 'step', label: 'Step-by-Step', icon: List },
                          { id: 'refine', label: 'Refine Loop', icon: RefreshCw },
                          { id: 'eval', label: 'Evaluator', icon: Check },
                          { id: 'grounding', label: 'Grounding', icon: Link }
                      ].map(tab => (
                          <button
                            key={tab.id}
                            onClick={() => setConfigTab(tab.id as any)}
                            className={`flex-1 flex items-center justify-center gap-2 pb-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all
                                ${configTab === tab.id ? 'border-venice-gold text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'}
                            `}
                          >
                            <tab.icon size={14} /> {tab.label}
                          </button>
                      ))}
                   </div>

                   {configTab === 'grounding' ? (
                        <div className="space-y-6 bg-[#0e1c1c] p-6 rounded border border-cyan-900/30">
                            <h3 className="text-sm font-bold text-cyan-100 flex items-center gap-2 mb-4"><Link size={16}/> Grounding Configuration</h3>
                            
                            <div>
                                <label className="block text-[10px] uppercase font-bold text-cyan-600 mb-2">Grounding Model</label>
                                <select 
                                    value={project.groundingModelId} 
                                    onChange={(e) => setProject({...project, groundingModelId: e.target.value as ModelId})}
                                    className="w-full bg-[#0b1616] border border-cyan-900/50 rounded p-2 text-sm text-cyan-100 outline-none focus:border-cyan-500"
                                >
                                    {Object.values(ModelId).map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                                <p className="text-[9px] text-cyan-600 mt-1">Select the model used to verify facts against resources.</p>
                            </div>

                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="block text-[10px] uppercase font-bold text-cyan-600">Grounding Prompt Template</label>
                                    <span className="text-[9px] text-cyan-700">Available: {'{{TEXT}}, {{CONTEXT}}'}</span>
                                </div>
                                <textarea 
                                    className="w-full h-64 bg-[#0b1616] border border-cyan-900/50 rounded p-3 font-mono text-xs text-cyan-100 focus:border-cyan-500 outline-none leading-relaxed resize-y"
                                    value={project.defaultGroundingPrompt || DEFAULT_GROUNDING_PROMPT}
                                    onChange={(e) => setProject({...project, defaultGroundingPrompt: e.target.value})}
                                />
                            </div>
                        </div>
                   ) : configTab === 'eval' ? (
                        <div className="space-y-6 bg-[#121214] p-6 rounded border border-zinc-800">
                            <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-4"><Check size={16}/> Evaluator Configuration</h3>
                            
                            {/* Evaluator Model Selection */}
                            <div>
                                <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">Evaluator Model</label>
                                <select 
                                    value={project.evaluatorModelId} 
                                    onChange={(e) => setProject({...project, evaluatorModelId: e.target.value as ModelId})}
                                    className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white outline-none focus:border-venice-gold"
                                >
                                    {Object.values(ModelId).map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                                <p className="text-[9px] text-zinc-500 mt-1">Choose the model responsible for grading and annotating your text.</p>
                            </div>

                            {/* Master Prompt Editor */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="block text-[10px] uppercase font-bold text-zinc-500">Master Evaluation Prompt</label>
                                    <span className="text-[9px] text-zinc-600">Available: {'{{TEXT}}, {{CRITERIA}}, {{CONTEXT}}'}</span>
                                </div>
                                <textarea 
                                    className="w-full h-64 bg-zinc-900 border border-zinc-700 rounded p-3 font-mono text-xs text-zinc-300 focus:border-venice-gold outline-none leading-relaxed resize-y"
                                    value={project.defaultEvaluatorPrompt || DEFAULT_EVALUATOR_PROMPT}
                                    onChange={(e) => setProject({...project, defaultEvaluatorPrompt: e.target.value})}
                                />
                                <p className="text-[9px] text-zinc-500 mt-2">This prompt orchestrates the AI grader. Ensure the template variables are present so the engine can inject content.</p>
                            </div>

                            <div className="border-t border-zinc-800 pt-6">
                                <h4 className="text-xs font-bold text-zinc-400 mb-4 uppercase">Scoring Categories</h4>
                                <div className="space-y-4">
                                    {project.evaluationCategories.map((cat, idx) => (
                                        <div key={cat.id} className="flex gap-3 items-start bg-black/20 p-3 rounded border border-zinc-800">
                                            <div className="flex-1 space-y-2">
                                                <input 
                                                    className="bg-transparent text-sm font-bold text-white w-full border-b border-zinc-700 focus:border-venice-gold outline-none pb-1"
                                                    value={cat.name}
                                                    onChange={(e) => {
                                                        const newCats = [...project.evaluationCategories];
                                                        newCats[idx].name = e.target.value;
                                                        setProject({...project, evaluationCategories: newCats});
                                                    }}
                                                    placeholder="Category Name"
                                                />
                                                <textarea 
                                                    className="bg-transparent text-xs text-zinc-400 w-full outline-none resize-none h-10"
                                                    value={cat.description}
                                                    onChange={(e) => {
                                                        const newCats = [...project.evaluationCategories];
                                                        newCats[idx].description = e.target.value;
                                                        setProject({...project, evaluationCategories: newCats});
                                                    }}
                                                    placeholder="Description / Criteria"
                                                />
                                            </div>
                                            <button onClick={() => {
                                                setProject({...project, evaluationCategories: project.evaluationCategories.filter(c => c.id !== cat.id)});
                                            }} className="text-zinc-600 hover:text-red-500 p-1"><Trash2 size={14}/></button>
                                        </div>
                                    ))}
                                    <button onClick={() => setProject({...project, evaluationCategories: [...project.evaluationCategories, {id: crypto.randomUUID(), name: 'New Category', description: ''}]})} 
                                        className="w-full py-2 border border-dashed border-zinc-700 text-zinc-500 text-xs rounded hover:bg-zinc-900 hover:text-white">
                                        + Add Category
                                    </button>
                                </div>
                            </div>
                        </div>
                   ) : (
                       <div className="space-y-6">
                            {/* SAVED PROMPTS MANAGER */}
                            <div className="bg-[#121214] p-4 rounded border border-zinc-800 flex justify-between items-center">
                              <div className="flex gap-2 items-center">
                                <Save size={14} className="text-venice-gold" />
                                <input 
                                  className="bg-transparent border-b border-zinc-700 text-xs text-white p-1 w-48 outline-none focus:border-venice-gold"
                                  placeholder="Save current config as..."
                                  value={promptSaveName}
                                  onChange={(e) => setPromptSaveName(e.target.value)}
                                />
                                <button
                                  onClick={savePromptConfig}
                                  className="text-xs bg-zinc-800 px-2 py-1 rounded hover:text-white"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={updatePromptConfig}
                                  disabled={!activeSavedPromptId}
                                  className="text-xs bg-zinc-800 px-2 py-1 rounded hover:text-white disabled:opacity-40"
                                >
                                  Edit
                                </button>
                                {configFeedback && (
                                  <span className="text-[10px] text-venice-gold ml-2">
                                    {configFeedback}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] uppercase text-zinc-500">Load:</span>
                                <select 
                                  className="bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 p-1 rounded w-40"
                                  onChange={(e) => loadPromptConfig(e.target.value)}
                                  value={activeSavedPromptId || ''}
                                >
                                  <option value="" disabled>Select Prompt...</option>
                                  {project.savedPrompts.map(s => (
                                    <option key={s.id} value={s.id}>
                                      {s.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>


                            <div className="bg-[#121214] p-6 rounded border border-zinc-800">
                              <h3 className="text-xs font-bold uppercase text-zinc-400 mb-4 flex items-center gap-2">
                                <Settings size={14}/> Model Settings
                              </h3>
                              <div className="grid grid-cols-2 gap-6">
                                <div>
                                  <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">
                                    Generation Model
                                  </label>
                                  <select 
                                    value={selectedModel} 
                                    onChange={(e) => setSelectedModel(e.target.value as ModelId)}
                                    className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white outline-none focus:border-zinc-500"
                                  >
                                    {Object.values(ModelId).map(m => (
                                      <option key={m} value={m}>{m}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                            </div>


                            {configTab === 'step' && (
                                <div className="bg-blue-900/10 p-6 rounded border border-blue-900/30">
                                    <h3 className="text-xs font-bold uppercase text-blue-400 mb-4">Step-by-Step Control</h3>
                                    <div className="grid grid-cols-1 gap-4">
                                        <div>
                                            <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">Step Size / Quantity</label>
                                            <input 
                                                type="text"
                                                value={stepConfig.stepSize} 
                                                onChange={(e) => setStepConfig({...stepConfig, stepSize: e.target.value})}
                                                className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white outline-none placeholder-zinc-600"
                                                placeholder='e.g. "3 paragraphs", "1 scene", "5 sentences"'
                                            />
                                        </div>
                                        <div className="border-t border-blue-900/30 pt-4 mt-2">
                                            <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer mb-3">
                                                <input 
                                                    type="checkbox"
                                                    checked={stepConfig.enableSelfCorrection}
                                                    onChange={(e) => setStepConfig({...stepConfig, enableSelfCorrection: e.target.checked})}
                                                    className="accent-blue-500" 
                                                />
                                                Enable Self-Correction Loop
                                            </label>
                                            {stepConfig.enableSelfCorrection && (
                                                <div className="pl-6">
                                                    <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">Correction Logic</label>
                                                    <textarea 
                                                        className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-xs text-zinc-300 h-20 resize-none"
                                                        value={stepConfig.selfCorrectionInstruction}
                                                        onChange={(e) => setStepConfig({...stepConfig, selfCorrectionInstruction: e.target.value})}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                              {configTab === 'refine' && (
                                  <div className="bg-venice-red/5 p-6 rounded border border-venice-red/20">
                                      <div className="flex items-start justify-between gap-3">
                                          <h3 className="text-xs font-bold uppercase text-venice-red mb-4">Refinement Context</h3>
                                          <span className="text-[10px] uppercase font-bold text-venice-gold">Saved for auto-runs</span>
                                      </div>
                                      <div className="space-y-4">
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                              <div>
                                                  <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">Refinement source</label>
                                                  <select
                                                      value={currentDocId || ''}
                                                      onChange={(e) => setCurrentDocId(e.target.value || null)}
                                                      className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white outline-none focus:border-venice-red/60"
                                                  >
                                                      <option value="">No document selected</option>
                                                      {project.documents.map((doc, idx) => (
                                                          <option key={doc.id} value={doc.id}>
                                                              {formatDocLabel(doc, idx)}
                                                          </option>
                                                      ))}
                                                  </select>
                                                  <p className="text-[10px] text-zinc-500 mt-2">
                                                      Pick which draft to feed back into the loop. Settings below are saved even without a selection.
                                                  </p>
                                              </div>
                                              <div>
                                                  <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">What to include</label>
                                                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                                      {refineToggles.map(toggle => (
                                                          <label
                                                              key={toggle.key}
                                                              className="block bg-black/20 p-2 rounded border border-zinc-800 text-xs text-zinc-300"
                                                          >
                                                              <div className="flex items-center gap-2">
                                                                  <input
                                                                      type="checkbox"
                                                                      checked={refineConfig[toggle.key]}
                                                                      onChange={(e) => setRefineConfig({ ...refineConfig, [toggle.key]: e.target.checked })}
                                                                      className="accent-venice-red"
                                                                  />
                                                                  <span className="font-semibold">{toggle.label}</span>
                                                              </div>
                                                              <p className="text-[10px] text-zinc-500 mt-1">{toggle.hint}</p>
                                                          </label>
                                                      ))}
                                                  </div>
                                              </div>
                                          </div>
                                          <div>
                                              <div className="flex items-center justify-between mb-2 gap-2">
                                                  <div>
                                                      <label className="block text-[10px] uppercase font-bold text-zinc-500">Active resources for refinement</label>
                                                      <p className="text-[10px] text-zinc-500">Used for the refinement prompt and any automated runs that reuse this config.</p>
                                                  </div>
                                                  <div className="flex gap-2">
                                                      <button
                                                          onClick={() => setRefineConfig({ ...refineConfig, activeResourceIds: project.resources.filter(r => r.enabled).map(r => r.id) })}
                                                          className="text-[10px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:text-white hover:border-venice-red/60"
                                                      >
                                                          Use enabled
                                                      </button>
                                                      <button
                                                          onClick={() => setRefineConfig({ ...refineConfig, activeResourceIds: [] })}
                                                          className="text-[10px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:text-white hover:border-red-500/60"
                                                      >
                                                          Clear
                                                      </button>
                                                  </div>
                                              </div>
                                              <div className="max-h-44 overflow-y-auto bg-zinc-900/50 border border-zinc-800 rounded p-2 space-y-1">
                                                  {project.resources.length === 0 ? (
                                                      <div className="text-xs text-zinc-500 italic">No resources yet. Add some in the Library panel.</div>
                                                  ) : (
                                                      project.resources.map(r => (
                                                          <label key={r.id} className="flex items-center gap-2 text-xs p-1 hover:bg-white/5 rounded cursor-pointer">
                                                              <input 
                                                                  type="checkbox" 
                                                                  checked={refineConfig.activeResourceIds.includes(r.id)}
                                                                  onChange={() => {
                                                                      const ids = refineConfig.activeResourceIds;
                                                                      const newIds = ids.includes(r.id) ? ids.filter(x => x !== r.id) : [...ids, r.id];
                                                                      setRefineConfig({...refineConfig, activeResourceIds: newIds});
                                                                  }}
                                                                  className="accent-venice-red"
                                                              />
                                                              <span className="truncate">{r.name}</span>
                                                          </label>
                                                      ))
                                                  )}
                                              </div>
                                          </div>
                                      </div>
                                  </div>
                              )}

                            <div className="space-y-4">
                                <div>
                                    <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-2">System Prompt (Identity)</label>
                                    <textarea 
                                        value={project.defaultSystemPrompt}
                                        onChange={(e) => setProject({...project, defaultSystemPrompt: e.target.value})}
                                        className="w-full h-32 bg-[#121214] border border-zinc-800 rounded p-4 font-mono text-sm text-zinc-300 focus:border-zinc-600 outline-none resize-none"
                                    />
                                </div>
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <label className="block text-[10px] uppercase font-bold text-zinc-500">
                                            {configTab === 'refine' ? 'Refinement Instructions' : configTab === 'step' ? 'Step Task Prompt' : 'Task Prompt'}
                                        </label>
                                        <span className="text-[10px] text-venice-gold font-bold uppercase">{configTab} Mode</span>
                                    </div>
                                    <textarea 
                                        value={activeTaskPrompt}
                                        onChange={(e) => updateActivePrompt(e.target.value)}
                                        className="w-full h-40 bg-[#121214] border border-zinc-800 rounded p-4 font-mono text-sm text-zinc-300 focus:border-zinc-600 outline-none resize-none"
                                    />
                                </div>
                            </div>
                       </div>
                   )}
                </div>

                {/* Right Column: Resources & Preview */}
                <div className="col-span-5 space-y-6 flex flex-col h-[calc(100vh-120px)]">
                    {/* Resource Manager */}
                    <div className="flex-1 overflow-hidden flex flex-col bg-[#121214] rounded border border-zinc-800">
                         <div className="p-3 border-b border-zinc-800 bg-zinc-900 flex justify-between items-center">
                            <span className="text-xs font-bold uppercase text-zinc-400">Library</span>
                            <button onClick={() => setIsAddingResource(!isAddingResource)} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 bg-zinc-800 px-2 py-1 rounded transition-colors hover:bg-zinc-700">
                                <Plus size={12}/> Add Resource
                            </button>
                         </div>

                         {isAddingResource && (
                             <div className="p-3 bg-zinc-900 border-b border-zinc-800 space-y-3 animate-in fade-in slide-in-from-top-2 overflow-y-auto max-h-[60vh]">
                                 
                                 {/* Upload Zone */}
                                 <div className="border-2 border-dashed border-zinc-700 rounded p-3 text-center hover:border-venice-gold transition-colors">
                                    <label className="cursor-pointer block">
                                        <Upload size={16} className="mx-auto mb-2 text-zinc-500"/>
                                        <span className="text-[10px] text-zinc-400 font-bold uppercase block mb-1">Upload File</span>
                                        <span className="text-[9px] text-zinc-600 block">PDF, Word, TXT, MD, JSON, CSV</span>
                                        <input type="file" className="hidden" onChange={handleResourceFileUpload} accept=".txt,.md,.csv,.json,.pdf,.doc,.docx"/>
                                    </label>
                                 </div>

                                 <div className="space-y-2">
                                     <input className="w-full bg-zinc-800 p-2 text-xs rounded text-white placeholder-zinc-600 border border-zinc-700 focus:border-venice-gold outline-none" placeholder="Resource Name" value={newResource.name} onChange={e => setNewResource({...newResource, name: e.target.value})} />
                                     
                                     <div>
                                        <input className="w-full bg-zinc-800 p-2 text-xs rounded text-white placeholder-zinc-600 border border-zinc-700 focus:border-venice-gold outline-none" placeholder="Usage Instruction for Model" value={newResource.usageInstruction} onChange={e => setNewResource({...newResource, usageInstruction: e.target.value})} />
                                        <p className="text-[9px] text-zinc-500 mt-1 px-1">E.g., "Strictly follow facts", "Use for style only", "Ignore dates".</p>
                                     </div>

                                     <textarea className="w-full bg-zinc-800 p-2 text-xs rounded text-white h-24 placeholder-zinc-600 border border-zinc-700 focus:border-venice-gold outline-none" placeholder="Paste content here if upload fails..." value={newResource.content} onChange={e => setNewResource({...newResource, content: e.target.value})} />
                                 </div>

                                 <div className="flex justify-end gap-2">
                                     <button onClick={() => setIsAddingResource(false)} className="text-xs text-zinc-500 hover:text-white px-2">Cancel</button>
                                     <button onClick={addResource} className="text-xs bg-venice-gold text-black px-3 py-1 rounded font-bold hover:bg-yellow-500">Save Resource</button>
                                 </div>
                             </div>
                         )}

                         <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
                             {project.resources.map((res, idx) => (
                                <div key={res.id} className={`bg-[#09090b] border rounded p-3 group transition-all ${res.enabled ? 'border-venice-gold/30' : 'border-zinc-800 opacity-60'}`}>
                                    <div className="flex items-center gap-3 mb-2">
                                        <input 
                                            type="checkbox" 
                                            checked={res.enabled} 
                                            onChange={() => {
                                                const newRes = [...project.resources];
                                                newRes[idx].enabled = !newRes[idx].enabled;
                                                setProject({...project, resources: newRes});
                                            }}
                                            className="accent-venice-red"
                                        />
                                        <span className="flex-1 text-sm font-bold text-white truncate">{res.name}</span>
                                    </div>
                                    
                                    <div className="mb-2">
                                        <label className="text-[9px] text-zinc-500 uppercase font-bold flex items-center gap-1"><File size={10}/> Usage Guide</label>
                                        <input 
                                            className="w-full bg-zinc-900/50 text-xs text-venice-gold p-1 rounded border-none outline-none placeholder-zinc-700"
                                            value={res.usageInstruction || ''}
                                            placeholder="e.g. Use for tone only..."
                                            onChange={(e) => {
                                                const newRes = [...project.resources];
                                                newRes[idx].usageInstruction = e.target.value;
                                                setProject({...project, resources: newRes});
                                            }}
                                        />
                                    </div>
                                    
                                    <textarea 
                                        className="w-full h-16 bg-zinc-900/50 border-none text-xs text-zinc-400 rounded resize-none p-2 font-serif leading-relaxed"
                                        value={res.content}
                                        onChange={(e) => {
                                            const newRes = [...project.resources];
                                            newRes[idx].content = e.target.value;
                                            setProject({...project, resources: newRes});
                                        }}
                                    />
                                </div>
                             ))}
                         </div>
                    </div>

                    {/* Live Payload Preview */}
                    <div className="flex-1 overflow-hidden flex flex-col bg-[#000000] rounded border border-zinc-800 shadow-2xl">
                        <div className="p-2 border-b border-zinc-800 bg-zinc-900 text-[10px] font-bold uppercase text-zinc-500 flex justify-between">
                            <span>
                                Payload Preview: 
                                <span className="text-venice-gold ml-2">
                                    {configTab === 'eval' ? 'EVALUATOR' : 
                                     configTab === 'grounding' ? 'GROUNDING' :
                                     configTab === 'step' ? 'STEP-BY-STEP' : 
                                     configTab === 'refine' ? 'REFINEMENT' : 'STANDARD'}
                                </span>
                            </span>
                            <span className="text-zinc-600">{fullPromptPreview.length} chars</span>
                        </div>
                        <div className="flex-1 p-4 overflow-auto">
                            <pre className="font-mono text-[10px] text-green-500/90 whitespace-pre-wrap break-all leading-relaxed">
                                {fullPromptPreview}
                            </pre>
                        </div>
                    </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEW: ANALYSIS DASHBOARD */}
          {activeTab === 'analysis' && (
              <AnalysisDashboard 
                documents={project.documents}
                categories={project.evaluationCategories}
                onSelectDoc={(id) => {
                    setCurrentDocId(id);
                    setActiveTab('workspace');
                }}
                currentDocId={currentDocId}
              />
          )}

          {/* VIEW: EXPERIMENT DASHBOARD (NEW) */}

          {activeTab === 'experiment' && (
              <ExperimentDashboard 
                project={project}
                setProject={setProject}
                onEditInConfig={handleEditExperimentConfig}
                currentLiveConfig={currentLiveConfig}
              />
          )}

          {/* VIEW: WORKSPACE */}
          {activeTab === 'workspace' && (
             <div className="flex h-full">
               <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                 {currentDoc ? (
                    <div className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[#09090b] relative scroll-smooth">
                       <div className="max-w-3xl mx-auto">
                          
                          {/* Header Metadata */}
                          <div className="mb-8 border-b border-zinc-800 pb-4 flex justify-between items-end">
                             <div>
                               <h2 className="font-serif text-2xl text-white mb-1">Document Analysis</h2>
                               <div className="flex gap-3 text-xs text-zinc-500 font-mono">
                                  <span>ID: {currentDoc.id.substring(0,8)}</span>
                                  <span>Model: {currentDoc.modelId}</span>
                               </div>
                             </div>
                             <div className="text-right flex flex-col items-end gap-2">
                                {currentDoc.method === GenerationMethod.STEP_BY_STEP && (
                                  <span className="text-[10px] uppercase bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">Step Mode</span>
                                )}
                                {currentDoc.method === GenerationMethod.REFINE_LOOP && (
                                  <span className="text-[10px] uppercase bg-venice-gold text-black font-bold px-2 py-1 rounded border border-venice-gold">Refinement Loop</span>
                                )}
                                {isDiffMode && parentDoc && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase bg-blue-900/30 text-blue-200 font-bold px-2 py-1 rounded border border-blue-800 animate-pulse">
                                      Comparing vs {parentDoc.id.substring(0,8)}
                                    </span>
                                    {currentDoc.diffStats && (
                                      <div className="flex text-[10px] font-mono gap-1 text-zinc-400 border border-zinc-700 rounded px-2 py-1 bg-black">
                                        <span className="text-green-500">+{currentDoc.diffStats.additions}</span>
                                        <span className="text-red-500">-{currentDoc.diffStats.deletions}</span>
                                        <span className="text-zinc-500">| {Math.round(currentDoc.diffStats.changeRatio * 100)}% Change</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                             </div>
                          </div>

                          {/* Thoughts Column */}
                          {currentDoc.method === GenerationMethod.STEP_BY_STEP &&
                          currentDoc.thoughts &&
                          currentDoc.thoughts.length > 0 && (
                            <div className="mb-12 grid gap-4">
                              {/* Step 0 - global plan */}
                              <div className="bg-[#121214] border-l-2 border-venice-gold p-4 rounded-r text-xs font-mono text-zinc-400 shadow-lg">
                                <strong className="block text-[9px] uppercase text-venice-gold mb-2 tracking-widest opacity-70">
                                  Thinking Step 0 - Global plan
                                </strong>
                                {currentDoc.thoughts[0]}
                              </div>

                              {/* Steps 1..N */}
                              {currentDoc.thoughts.slice(1).map((t, i) => (
                                <div
                                  key={i + 1}
                                  className="bg-[#121214] border-l-2 border-zinc-700 p-4 rounded-r text-xs font-mono text-zinc-400 shadow-lg"
                                >
                                  <strong className="block text-[9px] uppercase text-zinc-300 mb-2 tracking-widest opacity-70">
                                    Thinking Step {i + 1}
                                  </strong>
                                  {t}
                                </div>
                              ))}
                            </div>
                          )}


                          {/* Main Document */}
                          <div className={`rounded-lg shadow-2xl border min-h-[800px] p-16 relative mb-20 transition-colors duration-300 ${isDiffMode ? 'bg-[#121214] border-zinc-700' : 'bg-[#1c1c1f] border-zinc-800'}`}>
                             <DocumentViewer 
                               content={currentDoc.content}
                               annotations={displayAnnotations}
                               groundingEntries={displayGrounding} // Pass grounding data
                               showGroundingHighlights={showGroundingPanel} // Pass toggle state
                               
                               onTextSelect={setPendingQuote}
                               
                               activeAnnotationId={selectedAnnotationId}
                               onSelectAnnotation={setSelectedAnnotationId}

                               activeGroundingId={selectedGroundingId}
                               onSelectGrounding={setSelectedGroundingId}

                               currentUserId={project.currentUser}
                               isDiffMode={isDiffMode}
                               parentContent={parentDoc?.content}
                             />
                          </div>
                       </div>
                    </div>
                 ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 gap-4">
                       <BookOpen size={48} className="opacity-20"/>
                       <p>Select a document from the timeline tree or start a new configuration.</p>
                    </div>
                 )}
               </div>

               {/* Right Panels */}
               {currentDoc && (
                 <div className="flex h-full">
                     
                     {/* Standard Annotation Sidebar */}
                     <AnnotationSidebar 
                        annotations={displayAnnotations}
                        scores={displayScores}
                        resources={project.resources}
                        categories={project.evaluationCategories}
                        currentUser={project.currentUser}
                        activeId={selectedAnnotationId}
                        pendingQuote={pendingQuote}
                        onCancelPending={() => setPendingQuote('')}
                        onSelect={setSelectedAnnotationId}
                        onDelete={(id) => updateDoc(displayDocId!, { annotations: displayAnnotations.filter(a => a.id !== id) })}
                        onRefute={(id, r) => {
                            const targetDocId = displayDocId!;
                            const targetAnnos = displayAnnotations;
                            const a = targetAnnos.find(x => x.id === id);
                            if (a) updateDoc(targetDocId, { annotations: targetAnnos.map(x => x.id === id ? {...x, refutations: [...x.refutations, {userId: project.currentUser, reason: r, timestamp: Date.now()}]} : x) })
                        }}
                        onConfirm={(id) => {
                            const targetDocId = displayDocId!;
                            const targetAnnos = displayAnnotations;
                            const a = targetAnnos.find(x => x.id === id);
                            if (a) {
                                const isConfirmed = a.confirmations.includes(project.currentUser);
                                const newConfirmations = isConfirmed 
                                    ? a.confirmations.filter(u => u !== project.currentUser)
                                    : [...a.confirmations, project.currentUser];
                                updateDoc(targetDocId, { annotations: targetAnnos.map(x => x.id === id ? {...x, confirmations: newConfirmations} : x) });
                            }
                        }}
                        onUpdateScore={updateScore}
                        onSaveAnnotation={(ann) => {
                            if (isDiffMode) {
                                alert("Cannot add new annotations in Compare Mode. Switch back to standard view.");
                                return;
                            }
                            updateDoc(currentDoc.id, { annotations: [...currentDoc.annotations, ann] });
                            setPendingQuote('');
                            setSelectedAnnotationId(ann.id);
                        }}
                    />

                    {/* Grounding Sidebar (Conditional) */}
                    {showGroundingPanel && (
                        <GroundingSidebar 
                            entries={displayGrounding}
                            resources={project.resources}
                            activeId={selectedGroundingId}
                            onSelect={setSelectedGroundingId}
                            onClose={() => setShowGroundingPanel(false)}
                        />
                    )}

                 </div>
               )}
             </div>
          )}

          {/* VIEW: PRINT / REPORT */}
          {activeTab === 'print' && currentDoc && (
             <div className="absolute inset-0 bg-white text-black overflow-auto p-12 z-50 print:p-0 print:overflow-visible print:static print-container">
                <div id="report-content" className="max-w-[210mm] mx-auto bg-white min-h-screen print-only-visible">
                   
                   {/* Report Header */}
                   <div className="border-b-2 border-black pb-6 mb-8">
                      <h1 className="text-3xl font-serif font-bold text-black mb-2">FDHSim Evaluation Report</h1>
                      <div className="grid grid-cols-2 gap-y-2 text-sm font-mono text-gray-700">
                         <div className="flex"><span className="w-24 text-gray-500">ID:</span> {currentDoc.id.substring(0, 8)}</div>
                         <div className="flex"><span className="w-24 text-gray-500">Date:</span> {new Date(currentDoc.timestamp).toLocaleDateString()}</div>
                         <div className="flex"><span className="w-24 text-gray-500">Model:</span> {currentDoc.modelId}</div>
                         <div className="flex"><span className="w-24 text-gray-500">Method:</span> {currentDoc.method}</div>
                         <div className="flex"><span className="w-24 text-gray-500">{getReviewerList(currentDoc).includes(',') ? 'Reviewers:' : 'Reviewer:'}</span> <span className="font-bold text-black">{getReviewerList(currentDoc)}</span></div>
                         <div className="flex"><span className="w-24 text-gray-500">Avg Grade:</span> <strong>{calculateDocAverage(currentDoc)}/100</strong></div>
                      </div>
                   </div>

                   {/* Active Resources */}
                   <div className="mb-8 bg-gray-50 p-4 border border-gray-200 rounded">
                       <h4 className="font-bold uppercase text-xs text-gray-500 tracking-wider mb-2">Enabled Resources</h4>
                       <ul className="list-disc list-inside text-sm text-gray-800">
                           {project.resources.filter(r => currentDoc.activeResourceIds.includes(r.id)).map(r => (
                               <li key={r.id}>{r.name} <span className="text-gray-500 text-xs italic">({r.type})</span></li>
                           ))}
                           {project.resources.filter(r => currentDoc.activeResourceIds.includes(r.id)).length === 0 && (
                               <li className="italic text-gray-500">No specific resources active.</li>
                           )}
                       </ul>
                   </div>

                   {/* Content */}
                   <div className="mb-12">
                      <h3 className="font-bold uppercase text-lg text-black mb-4 font-serif decoration-4 decoration-black">Narrative Content</h3>
                      <div className="font-serif text-lg leading-relaxed text-justify whitespace-pre-wrap text-gray-900 p-6 border-l-4 border-gray-300">
                         {currentDoc.content}
                      </div>
                   </div>

                   {/* Evaluation Scores */}
                   <div className="mb-12 break-inside-avoid">
                        <h3 className="font-bold uppercase text-lg mb-4 font-serif border-b pb-2">Category Scoring</h3>
                        <table className="w-full text-sm border-collapse border border-gray-300">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="border p-2 text-left">Category</th>
                                    <th className="border p-2 text-left">Criteria</th>
                                    <th className="border p-2 text-center w-24">AI Score</th>
                                    <th className="border p-2 text-center w-24">Human Score</th>
                                </tr>
                            </thead>
                            <tbody>
                                {project.evaluationCategories.map(cat => {
                                    const aiScore = currentDoc.scores[cat.id]?.['AI'] ?? '-';
                                    const humanScore = currentDoc.scores[cat.id]?.[project.currentUser] ?? '-';
                                    return (
                                        <tr key={cat.id}>
                                            <td className="border p-2 font-bold">{cat.name}</td>
                                            <td className="border p-2 text-gray-600 italic">{cat.description}</td>
                                            <td className="border p-2 text-center font-mono">{aiScore}</td>
                                            <td className="border p-2 text-center font-mono">{humanScore}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                   </div>

                   {/* Annotation Table */}
                   <div className="mb-12 break-inside-avoid">
                        <h3 className="font-bold uppercase text-lg mb-4 font-serif border-b pb-2">Annotation & Grounding Log</h3>
                        <table className="w-full text-xs border-collapse border border-gray-300">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="border p-2 text-left w-1/4">Quote</th>
                                    <th className="border p-2 text-left w-24">Category</th>
                                    <th className="border p-2 text-left">Analysis / Comment</th>
                                    <th className="border p-2 text-left w-1/4">Grounding / Source</th>
                                    <th className="border p-2 text-center w-16">Author</th>
                                </tr>
                            </thead>
                            <tbody>
                                {currentDoc.annotations.length === 0 && <tr><td colSpan={5} className="border p-4 text-center italic text-gray-500">No annotations recorded.</td></tr>}
                                {currentDoc.annotations.map(ann => {
                                    const source = project.resources.find(r => r.id === ann.sourceId);
                                    return (
                                        <tr key={ann.id} className={ann.refutations.length > 0 ? "bg-red-50" : ""}>
                                            <td className="border p-2 italic text-gray-950 font-medium bg-gray-50/50">"{ann.quote}"</td>
                                            <td className="border p-2 font-bold text-gray-900">{ann.level}</td>
                                            <td className="border p-2 text-gray-900">
                                                {ann.comment}
                                                {ann.refutations.length > 0 && (
                                                    <div className="mt-1 text-red-600 font-bold block">[REFUTED]</div>
                                                )}
                                            </td>
                                            <td className="border p-2 text-green-900">
                                                {source ? (
                                                    <>
                                                        <strong className="text-green-950">{source.name}</strong>
                                                        {ann.sourceQuote && <div className="italic mt-1 text-black border-l-2 border-green-600 pl-2">"{ann.sourceQuote}"</div>}
                                                    </>
                                                ) : '-'}
                                            </td>
                                            <td className="border p-2 text-center font-mono text-gray-900">{ann.author}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                   </div>

                   {/* Grounding Table */}
                    {currentDoc.groundingEntries && currentDoc.groundingEntries.length > 0 && (
                        <div className="mb-12 break-inside-avoid">
                            <h3 className="font-bold uppercase text-lg mb-4 font-serif border-b pb-2">Automatic Source Verification (Grounding)</h3>
                            <table className="w-full text-xs border-collapse border border-gray-300">
                                <thead className="bg-cyan-50">
                                    <tr>
                                        <th className="border p-2 text-left w-1/4">Generative Text</th>
                                        <th className="border p-2 text-left">Identified Source Resource</th>
                                        <th className="border p-2 text-left w-1/3">Evidence Quote</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {currentDoc.groundingEntries.map(g => (
                                        <tr key={g.id}>
                                            <td className="border p-2 italic text-gray-900">"{g.quote}"</td>
                                            <td className="border p-2 font-bold text-cyan-900">{g.resourceName}</td>
                                            <td className="border p-2 text-gray-800 bg-gray-50">"{g.resourceQuote}"</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                   {/* Full Prompt Log */}
                   <div className="break-inside-avoid">
                        <h3 className="font-bold uppercase text-lg mb-4 font-serif border-b pb-2">Generation Prompt Log</h3>
                        <div className="bg-gray-50 border border-gray-200 p-4 rounded text-xs font-mono text-gray-700">
                             <details open>
                                 <summary className="cursor-pointer font-bold mb-2 hover:text-black">Full System & Task Prompt Snapshot</summary>
                                 <div className="whitespace-pre-wrap border-t border-gray-300 pt-2 mt-2">
                                     {currentDoc.fullPromptSnapshot}
                                 </div>
                             </details>
                        </div>
                   </div>

                </div>

                <div className="print:hidden fixed bottom-8 right-8 z-50">
                      <button onClick={handleExportHTML} className="bg-venice-gold hover:bg-yellow-600 text-black px-6 py-3 rounded-full font-bold shadow-xl flex items-center gap-2">
                        <Download size={18} /> Export Report (HTML)
                      </button>
                </div>
             </div>
          )}

        </main>
      </div>

    </div>
  );
};

export default App;
