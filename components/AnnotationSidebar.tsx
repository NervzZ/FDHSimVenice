
import React, { useState, useMemo } from 'react';
import { Annotation, ScoreMap, Resource, EvaluationCategory } from '../types';
import { Trash2, AlertCircle, Bot, CheckCircle2, ThumbsUp, MessageSquarePlus, BarChart2, ListFilter } from 'lucide-react';

interface Props {
  annotations: Annotation[];
  scores: ScoreMap;
  resources: Resource[];
  categories: EvaluationCategory[];
  currentUser: string;
  activeId: string | null;
  onDelete: (id: string) => void;
  onRefute: (id: string, reason: string) => void;
  onConfirm: (id: string) => void;
  onSelect: (id: string) => void;
  onUpdateScore: (categoryId: string, score: number) => void;
  onSaveAnnotation: (ann: Annotation) => void; 
  pendingQuote?: string; 
  onCancelPending: () => void;
}

export const AnnotationSidebar: React.FC<Props> = ({ 
  annotations, 
  scores,
  resources,
  categories,
  currentUser, 
  activeId,
  onDelete, 
  onRefute, 
  onConfirm,
  onSelect, 
  onUpdateScore,
  onSaveAnnotation,
  pendingQuote,
  onCancelPending
}) => {
  
  const [viewMode, setViewMode] = useState<'list' | 'grade'>('list');
  const [filterUser, setFilterUser] = useState<'all' | 'ai' | 'human'>('all');
  const [showRefuted, setShowRefuted] = useState(false);

  // New Annotation State
  const [newAnnLevel, setNewAnnLevel] = useState<string>(categories[0]?.name || 'General');
  const [newAnnComment, setNewAnnComment] = useState('');
  const [newAnnSource, setNewAnnSource] = useState('');

  // Refutation State
  const [refutingId, setRefutingId] = useState<string | null>(null);
  const [refutationReason, setRefutationReason] = useState('');

  // --- Computed Data ---

  const filteredAnnotations = useMemo(() => {
    return annotations.filter(a => {
      if (!showRefuted && a.refutations.length > 0) return false;
      if (filterUser === 'ai' && a.author !== 'AI') return false;
      if (filterUser === 'human' && a.author === 'AI') return false;
      return true;
    }).sort((a, b) => {
        if (a.id === activeId) return -1;
        return b.timestamp - a.timestamp; 
    });
  }, [annotations, showRefuted, filterUser, activeId]);

  const getAverageScore = (categoryId: string) => {
    const catScores = scores[categoryId] || {};
    const values = Object.values(catScores) as number[];
    if (values.length === 0) return 0;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  };

  // Simple hash for consistent colors based on category name
  const getLevelColor = (level: string) => {
    const normalized = level.toLowerCase();
    if (normalized.includes('consistency-source')) {
      return 'text-emerald-300 border-emerald-800 bg-emerald-900/20';
    }
    if (normalized.includes('consistency-addition')) {
      return 'text-orange-300 border-orange-800 bg-orange-900/20';
    }
    if (normalized.includes('consistency-diff')) {
      return 'text-red-300 border-red-800 bg-red-900/20';
    }
    const colors = [
       'text-green-400 border-green-800 bg-green-900/20',
       'text-amber-400 border-amber-800 bg-amber-900/20',
       'text-purple-400 border-purple-800 bg-purple-900/20',
       'text-blue-400 border-blue-800 bg-blue-900/20',
       'text-pink-400 border-pink-800 bg-pink-900/20',
       'text-cyan-400 border-cyan-800 bg-cyan-900/20',
    ];
    let hash = 0;
    for (let i = 0; i < level.length; i++) hash = level.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  // --- Render ---

  if (pendingQuote) {
    return (
      <div className="flex flex-col h-full bg-[#121214] border-l border-zinc-800 w-96 p-6">
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
          <MessageSquarePlus size={16} /> New Annotation
        </h3>
        
        <div className="bg-zinc-900 p-3 rounded border-l-2 border-venice-gold mb-4 italic text-zinc-400 text-xs max-h-32 overflow-y-auto">
          "{pendingQuote}"
        </div>

        <div className="space-y-4 flex-1">
          <div>
            <label className="block text-xs uppercase text-zinc-500 font-bold mb-2">Category</label>
            <select 
              className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white"
              value={newAnnLevel}
              onChange={(e) => setNewAnnLevel(e.target.value)}
            >
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase text-zinc-500 font-bold mb-2">Analysis / Comment</label>
            <textarea 
              className="w-full h-32 bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white resize-none"
              placeholder="Explain the coherence issue or grounding..."
              value={newAnnComment}
              onChange={(e) => setNewAnnComment(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs uppercase text-zinc-500 font-bold mb-2">Supported By (Optional)</label>
            <select 
                className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-sm text-white"
                value={newAnnSource}
                onChange={(e) => setNewAnnSource(e.target.value)}
            >
                <option value="">-- General / None --</option>
                {resources.filter(r => r.enabled).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
                ))}
            </select>
          </div>

          <div className="flex gap-2 pt-4">
             <button 
               onClick={() => {
                 onSaveAnnotation({
                   id: crypto.randomUUID(),
                   quote: pendingQuote,
                   level: newAnnLevel,
                   comment: newAnnComment,
                   sourceId: newAnnSource || undefined,
                   author: currentUser,
                   timestamp: Date.now(),
                   confirmations: [currentUser],
                   refutations: []
                 });
                 setNewAnnComment('');
               }}
               disabled={!newAnnComment}
               className="flex-1 bg-venice-red hover:bg-red-600 text-white text-sm font-bold py-2 rounded disabled:opacity-50"
             >
               Save Annotation
             </button>
             <button onClick={onCancelPending} className="px-4 py-2 border border-zinc-700 hover:bg-zinc-800 text-zinc-400 rounded">
               Cancel
             </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#121214] border-l border-zinc-800 w-96 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-zinc-800 bg-[#18181b]">
         <div className="flex gap-1 bg-zinc-900 p-1 rounded">
           <button 
             onClick={() => setViewMode('list')}
             className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
             title="Annotations List"
           >
             <ListFilter size={16} />
           </button>
           <button 
             onClick={() => setViewMode('grade')}
             className={`p-1.5 rounded ${viewMode === 'grade' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
             title="Grading Matrix"
           >
             <BarChart2 size={16} />
           </button>
         </div>

         {viewMode === 'list' && (
            <div className="flex gap-2 text-xs">
               <button onClick={() => setShowRefuted(!showRefuted)} className={`${showRefuted ? 'text-red-400' : 'text-zinc-500'}`}>
                 {showRefuted ? 'Hide Refuted' : 'Show Refuted'}
               </button>
               <select 
                 className="bg-zinc-900 border-none text-zinc-400 outline-none"
                 value={filterUser}
                 onChange={(e) => setFilterUser(e.target.value as any)}
               >
                 <option value="all">All Sources</option>
                 <option value="ai">AI Only</option>
                 <option value="human">Humans Only</option>
               </select>
            </div>
         )}
      </div>

      {/* LIST VIEW */}
      {viewMode === 'list' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
          {filteredAnnotations.length === 0 && (
            <div className="text-center text-zinc-600 py-10 text-sm">
              No annotations match filters.<br/>Highlight text to add one.
            </div>
          )}
          
          {filteredAnnotations.map(ann => {
             const isRefuted = ann.refutations.length > 0;
             const isConfirmed = ann.confirmations.includes(currentUser);
             const isMine = ann.author === currentUser;
             const isConsistency = ann.level.toLowerCase().includes('consistency');

             return (
              <div 
                key={ann.id}
                onClick={() => onSelect(ann.id)}
                className={`
                  relative rounded-lg border p-3 transition-all cursor-pointer
                  ${ann.id === activeId ? 'ring-1 ring-zinc-500 bg-zinc-800 border-transparent' : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'}
                  ${isRefuted ? 'opacity-60 grayscale' : ''}
                `}
              >
                 <div className="flex justify-between items-start mb-2">
                    <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${getLevelColor(ann.level)}`}>
                      {ann.level}
                    </span>
                    <div className="flex items-center gap-2 text-zinc-500">
                       {ann.author === 'AI' ? <Bot size={14}/> : <span className="text-[10px] font-mono bg-zinc-800 px-1 rounded">{ann.author}</span>}
                    </div>
                 </div>

                 <div className="mb-3 pl-2 border-l-2 border-zinc-700">
                    <p className="text-xs font-serif italic text-zinc-400 line-clamp-2">"{ann.quote}"</p>
                 </div>

                 <p className="text-sm text-zinc-200 mb-3">{ann.comment}</p>

                 {isConsistency && (ann.relatedVariant || ann.relatedQuote || ann.sourceQuote) && (
                   <div className="bg-black/30 p-2 rounded text-xs text-blue-200/80 mb-3 border border-blue-900/30">
                     <strong className="uppercase text-[9px] text-blue-400 block mb-1">Cross-variant evidence</strong>
                     <div className="text-[11px] text-blue-100 mb-1">
                       {ann.relatedVariant ? `vs ${ann.relatedVariant}` : 'From original event'}
                     </div>
                     {ann.relatedQuote && (
                       <div className="italic text-blue-100/80">"{ann.relatedQuote}"</div>
                     )}
                     {!ann.relatedQuote && ann.sourceQuote && (
                       <div className="italic text-blue-100/80">"{ann.sourceQuote}"</div>
                     )}
                   </div>
                 )}

                 {ann.sourceId && (
                   <div className="bg-black/30 p-2 rounded text-xs text-green-400/80 mb-3 border border-green-900/30">
                     <strong className="uppercase text-[9px] text-green-600 block mb-1">Reference Source</strong>
                     {resources.find(r => r.id === ann.sourceId)?.name}
                     {ann.sourceQuote && <div className="italic mt-1 text-green-200/60">"{ann.sourceQuote}"</div>}
                   </div>
                 )}

                 <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <div className="flex gap-2">
                       <div className="flex items-center text-xs text-zinc-500" title={ann.confirmations.join(', ')}>
                          <ThumbsUp size={12} className={`mr-1 ${isConfirmed ? 'text-blue-400 fill-current' : ''}`} />
                          {ann.confirmations.length}
                       </div>
                       <div className="flex items-center text-xs text-zinc-500">
                          <AlertCircle size={12} className={`mr-1 ${isRefuted ? 'text-red-400' : ''}`} />
                          {ann.refutations.length}
                       </div>
                    </div>

                    <div className="flex gap-1">
                       <button 
                         onClick={(e) => { e.stopPropagation(); onConfirm(ann.id); }}
                         className={`p-1 rounded hover:bg-blue-900/30 ${isConfirmed ? 'text-blue-400' : 'text-zinc-600 hover:text-blue-400'}`}
                         title="Confirm / Agree"
                       >
                         <CheckCircle2 size={14} />
                       </button>
                       
                       <button 
                         onClick={(e) => { e.stopPropagation(); setRefutingId(ann.id); }}
                         className="p-1 rounded hover:bg-red-900/30 text-zinc-600 hover:text-red-400"
                         title="Refute / Disagree"
                       >
                         <AlertCircle size={14} />
                       </button>
                       
                       {(isMine || currentUser.includes('Admin')) && (
                         <button 
                           onClick={(e) => { e.stopPropagation(); onDelete(ann.id); }}
                           className="p-1 rounded hover:bg-zinc-800 text-zinc-600 hover:text-zinc-200"
                           title="Delete"
                         >
                           <Trash2 size={14} />
                         </button>
                       )}
                    </div>
                 </div>

                 {refutingId === ann.id && (
                   <div className="mt-3 p-2 bg-red-900/10 border border-red-900/50 rounded" onClick={e => e.stopPropagation()}>
                      <input 
                        className="w-full bg-black/50 text-xs text-white border border-red-900/50 rounded p-1 mb-2"
                        placeholder="Reason for refutation..."
                        value={refutationReason}
                        onChange={(e) => setRefutationReason(e.target.value)}
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setRefutingId(null)} className="text-[10px] text-zinc-400 hover:text-white">Cancel</button>
                        <button 
                          onClick={() => { onRefute(ann.id, refutationReason); setRefutingId(null); setRefutationReason(''); }} 
                          className="text-[10px] bg-red-900 text-red-100 px-2 py-1 rounded"
                        >
                          Refute
                        </button>
                      </div>
                   </div>
                 )}

                 {ann.refutations.length > 0 && (
                   <div className="mt-2 space-y-1">
                     {ann.refutations.map((ref, idx) => (
                       <div key={idx} className="text-[10px] text-red-400 bg-red-900/10 p-1.5 rounded border border-red-900/30">
                         <span className="font-bold mr-1">{ref.userId}:</span> {ref.reason}
                       </div>
                     ))}
                   </div>
                 )}
              </div>
             );
          })}
        </div>
      )}

      {/* GRADING VIEW */}
      {viewMode === 'grade' && (
        <div className="flex-1 p-6 overflow-y-auto">
           <h3 className="text-xs font-bold uppercase text-zinc-500 mb-6 tracking-widest">Coherence Evaluation</h3>
           
           <div className="space-y-8">
              {categories.map(cat => {
                const myScore = scores[cat.id]?.[currentUser] ?? 0;
                const aiScore = scores[cat.id]?.['AI'];
                const avgScore = getAverageScore(cat.id);

                return (
                  <div key={cat.id} className="bg-zinc-900/50 p-4 rounded-lg border border-zinc-800">
                    <div className="flex justify-between items-center mb-1">
                       <span className="text-sm font-bold text-zinc-300">{cat.name}</span>
                       <span className="text-lg font-mono font-bold text-venice-gold">{avgScore}</span>
                    </div>
                    <p className="text-[10px] text-zinc-500 mb-3">{cat.description}</p>

                    {/* AI Score Marker */}
                    {aiScore !== undefined && (
                      <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                         <Bot size={12} /> AI Grade: <span className="text-zinc-300 font-mono">{aiScore}</span>
                      </div>
                    )}

                    {/* User Slider */}
                    <div className="relative pt-2">
                      <label className="text-[10px] uppercase text-zinc-500 mb-1 block">Your Assessment</label>
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        value={myScore}
                        onChange={(e) => onUpdateScore(cat.id, Number(e.target.value))}
                        className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-venice-red"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600 font-mono mt-1">
                         <span>0</span>
                         <span className="text-white font-bold">{myScore}</span>
                         <span>100</span>
                      </div>
                    </div>
                  </div>
                );
              })}
           </div>
        </div>
      )}

    </div>
  );
};
