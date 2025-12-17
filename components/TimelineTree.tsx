

import React from 'react';
import { DocumentVersion, GenerationMethod, ModelId } from '../types';
import { ChevronRight, GitCommit, CornerDownRight, FlaskConical } from 'lucide-react';

interface Props {
  documents: DocumentVersion[];
  currentDocId: string | null;
  onSelect: (id: string) => void;
}

// Recursive Tree Node
const TreeNode: React.FC<{
  doc: DocumentVersion;
  allDocs: DocumentVersion[];
  currentDocId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}> = ({ doc, allDocs, currentDocId, onSelect, depth }) => {
  
  const children = allDocs.filter(d => d.parentId === doc.id).sort((a, b) => b.timestamp - a.timestamp);
  const isActive = currentDocId === doc.id;

  // Calculate average score for visual indicator
  let avgScore = 0;
  let scoreCount = 0;
  Object.values(doc.scores).forEach(cat => {
    Object.values(cat).forEach(val => {
      avgScore += val;
      scoreCount++;
    });
  });
  const finalScore = scoreCount > 0 ? Math.round(avgScore / scoreCount) : 0;

  const getMethodColor = (m: GenerationMethod) => {
    switch (m) {
      case GenerationMethod.REFINE_LOOP: return 'bg-venice-gold text-black';
      case GenerationMethod.STEP_BY_STEP: return 'bg-blue-900 text-blue-200 border-blue-700';
      default: return 'bg-zinc-800 text-zinc-400 border-zinc-700';
    }
  };

  return (
    <div className="relative">
      {/* The Node Itself */}
      <div 
        className={`
          relative flex flex-col p-3 rounded-lg cursor-pointer transition-all border mb-2
          ${isActive 
            ? 'bg-zinc-800 border-venice-red shadow-md z-10' 
            : 'bg-[#0f0f11] hover:bg-zinc-900 border-zinc-800 hover:border-zinc-700'}
        `}
        style={{ marginLeft: `${depth * 16}px` }}
        onClick={() => onSelect(doc.id)}
      >
        {/* Connector Line for children visualization context */}
        {depth > 0 && (
            <div className="absolute -left-3 top-4 text-zinc-700">
                <CornerDownRight size={12} />
            </div>
        )}

        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-mono text-zinc-500">{new Date(doc.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
          <div className="flex gap-1">
             {doc.experimentId && (
                 <span className="text-[8px] px-1 py-0.5 rounded bg-purple-900/30 text-purple-300 border border-purple-800 uppercase flex items-center gap-1">
                    <FlaskConical size={8}/> {doc.runLabel || 'Exp'}
                 </span>
             )}
             <span className={`text-[8px] px-1 py-0.5 rounded border uppercase font-bold ${getMethodColor(doc.method)}`}>
                {doc.method === GenerationMethod.REFINE_LOOP ? 'Refine' : doc.method === GenerationMethod.STEP_BY_STEP ? 'Steps' : 'Gen'}
             </span>
          </div>
        </div>

        <div className="text-xs text-zinc-300 font-medium truncate font-serif mb-1">
           {doc.taskPromptSnapshot.split('\n')[0].substring(0, 30) || "Untitled Gen"}...
        </div>

        {/* Score Indicator */}
        <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1 bg-zinc-900 rounded-full overflow-hidden">
                <div 
                    className={`h-full transition-all ${finalScore > 80 ? 'bg-green-500' : finalScore > 50 ? 'bg-venice-gold' : 'bg-red-500'}`} 
                    style={{ width: `${finalScore}%`, opacity: finalScore > 0 ? 1 : 0 }}
                ></div>
            </div>
            <span className="text-[8px] text-zinc-600 font-mono w-4 text-right">{finalScore || '-'}</span>
        </div>
      </div>

      {/* Children */}
      <div className="relative">
        {children.length > 0 && (
             /* Vertical line connector */
            <div className="absolute left-0 bottom-0 w-px bg-zinc-800" style={{ left: `${(depth * 16) + 12}px`, top: '-8px', height: 'calc(100% - 10px)'}}></div>
        )}
        {children.map(child => (
          <TreeNode 
            key={child.id} 
            doc={child} 
            allDocs={allDocs} 
            currentDocId={currentDocId} 
            onSelect={onSelect} 
            depth={depth + 1}
          />
        ))}
      </div>
    </div>
  );
};

export const TimelineTree: React.FC<Props> = ({ documents, currentDocId, onSelect }) => {
  // Roots are docs with no parent OR where the parent isn't in the list (deleted/imported partials)
  const roots = documents.filter(d => !d.parentId || !documents.find(p => p.id === d.parentId))
                         .sort((a, b) => b.timestamp - a.timestamp);

  if (documents.length === 0) {
      return <div className="text-zinc-700 text-xs italic p-4 text-center border border-dashed border-zinc-800 rounded">No documents generated.<br/>Go to Configuration.</div>;
  }

  return (
    <div className="pl-2 relative">
      {roots.map(doc => (
        <TreeNode 
            key={doc.id} 
            doc={doc} 
            allDocs={documents} 
            currentDocId={currentDocId} 
            onSelect={onSelect} 
            depth={0}
        />
      ))}
    </div>
  );
};
