
import React from 'react';
import { GroundingEntry, Resource } from '../types';
import { Link, BookOpen, X, ExternalLink } from 'lucide-react';

interface Props {
  entries: GroundingEntry[];
  resources: Resource[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const GroundingSidebar: React.FC<Props> = ({
  entries,
  activeId,
  onSelect,
  onClose
}) => {
  return (
    <div className="flex flex-col h-full bg-[#0c1c1c] border-l border-cyan-900/30 w-96 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-cyan-900/30 bg-[#0f2222]">
        <div className="flex items-center gap-2 text-cyan-400">
          <BookOpen size={16} />
          <span className="text-sm font-bold uppercase tracking-wider">Source Grounding</span>
        </div>
        <button onClick={onClose} className="text-cyan-700 hover:text-cyan-300 p-1">
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {entries.length === 0 && (
          <div className="text-center text-cyan-800 py-10 text-sm">
            No grounding data found.<br/>Run the Grounding Engine to analyze sources.
          </div>
        )}

        {entries.map(entry => {
           const isActive = entry.id === activeId;
           
           return (
             <div 
               key={entry.id}
               onClick={() => onSelect(entry.id)}
               className={`
                 relative rounded-lg border p-3 transition-all cursor-pointer group
                 ${isActive 
                    ? 'bg-cyan-900/30 border-cyan-500 ring-1 ring-cyan-500 shadow-[0_0_10px_rgba(34,211,238,0.1)]' 
                    : 'bg-[#0e2a2a]/50 border-cyan-900/30 hover:border-cyan-700'}
               `}
             >
               <div className="mb-2 pl-2 border-l-2 border-cyan-700">
                  <p className="text-xs font-serif text-cyan-100/80 line-clamp-3 italic">"{entry.quote}"</p>
               </div>

               <div className="mt-3 pt-2 border-t border-cyan-900/30">
                 <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] uppercase font-bold text-cyan-600 flex items-center gap-1">
                        <Link size={10} /> Evidence from Source
                    </div>
                    <span className="text-[9px] text-cyan-800 border border-cyan-900/50 px-1 rounded">
                        ID: {entry.resourceId}
                    </span>
                 </div>
                 <div className="text-xs font-bold text-cyan-200 mb-1 truncate">
                    {entry.resourceName}
                 </div>
                 <div className="text-[11px] text-cyan-400/70 leading-relaxed bg-black/20 p-2 rounded">
                    "{entry.resourceQuote}"
                 </div>
               </div>
             </div>
           );
        })}
      </div>
      
      <div className="p-2 text-center text-[9px] text-cyan-900 uppercase font-bold bg-[#0f2222] border-t border-cyan-900/30">
          {entries.length} Grounded Segments Identified
      </div>
    </div>
  );
};
