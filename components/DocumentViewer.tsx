
import React, { useMemo, useEffect, useState, useRef } from 'react';
import { Annotation, GroundingEntry } from '../types';
import { calculateDiff, DiffPart } from '../services/diffService';

interface Props {
  content: string;
  annotations: Annotation[];
  groundingEntries?: GroundingEntry[];
  showGroundingHighlights?: boolean;
  
  onTextSelect: (quote: string) => void;
  
  activeAnnotationId?: string | null;
  onSelectAnnotation: (id: string) => void;

  activeGroundingId?: string | null;
  onSelectGrounding?: (id: string) => void;
  
  currentUserId: string;
  
  // Diff Props
  isDiffMode?: boolean;
  parentContent?: string;
}

// Robust "Fuzzy" Finder for Quotes
// This solves issues where the text has Markdown (e.g. "**Doge**") but the quote does not ("Doge").
const findQuoteInText = (fullText: string, searchQuote: string): { start: number, end: number } | null => {
    if (!fullText || !searchQuote) return null;

    // 1. Try Exact Match First (Fastest)
    const exactIdx = fullText.indexOf(searchQuote);
    if (exactIdx !== -1) {
        return { start: exactIdx, end: exactIdx + searchQuote.length };
    }

    // 2. Try Skeleton Match (Robust)
    // We strip non-alphanumeric chars from both, find the match, then map back to original indices.
    
    const createSkeleton = (str: string) => {
        const indices: number[] = [];
        let clean = "";
        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            // Allow letters, numbers. Ignore *, _, [, ], etc.
            if (/[a-zA-Z0-9]/.test(char)) {
                clean += char;
                indices.push(i); // Store original index
            }
        }
        return { clean, indices };
    };

    const textSkel = createSkeleton(fullText);
    const quoteSkel = createSkeleton(searchQuote);

    if (quoteSkel.clean.length === 0) return null; // Search quote was only symbols?

    const matchIdx = textSkel.clean.indexOf(quoteSkel.clean);
    
    if (matchIdx !== -1) {
        // We found the sequence of letters!
        // Map back to real world coordinates.
        // Start index in text is the original index of the first matched character
        const startRealIndex = textSkel.indices[matchIdx];
        
        // End index is the original index of the last matched character + 1 (for slice)
        // The length of the match in clean space is quoteSkel.clean.length
        const endRealIndex = textSkel.indices[matchIdx + quoteSkel.clean.length - 1] + 1;

        return { start: startRealIndex, end: endRealIndex };
    }

    return null;
};

export const DocumentViewer: React.FC<Props> = ({ 
  content, 
  annotations,
  groundingEntries = [],
  showGroundingHighlights = false, 
  onTextSelect,
  activeAnnotationId,
  onSelectAnnotation,
  activeGroundingId,
  onSelectGrounding,
  currentUserId,
  isDiffMode = false,
  parentContent
}) => {
  
  const containerRef = useRef<HTMLDivElement>(null);
  const [diffData, setDiffData] = useState<DiffPart[]>([]);

  // Compute diff only when needed to avoid perf hits on typing
  useEffect(() => {
    if (isDiffMode && parentContent) {
      const d = calculateDiff(parentContent, content);
      setDiffData(d);
    }
  }, [isDiffMode, parentContent, content]);

  // Scroll active annotation into view
  useEffect(() => {
    if (activeAnnotationId && containerRef.current) {
        const el = containerRef.current.querySelector(`[data-annotation-id="${activeAnnotationId}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
  }, [activeAnnotationId]);

  const handleMouseUp = () => {
    if (isDiffMode) return; // Disable selection in diff mode for clarity
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      const text = selection.toString();
      onTextSelect(text);
    }
  };

  // --- DIFF RENDERER ---
  const renderDiff = useMemo(() => {
    if (!diffData.length) return <span>Loading Diff...</span>;

    return diffData.map((part, idx) => {
      if (part.added) {
        return (
          <span key={idx} className="bg-green-900/60 text-green-100 font-semibold decoration-clone px-1 rounded-sm border border-green-800/50" title="Added">
            {part.value}
          </span>
        );
      }
      if (part.removed) {
        return (
          <span key={idx} className="bg-red-900/40 text-red-300/60 line-through decoration-red-500 decoration-2 mx-0.5 select-none" title="Removed">
            {part.value}
          </span>
        );
      }
      return <span key={idx} className="opacity-80">{part.value}</span>;
    });
  }, [diffData]);


  // --- MERGED RENDERER FOR ANNOTATIONS + GROUNDING ---
  const renderContent = useMemo(() => {
    // We need to split the text based on both Annotations and Grounding ranges.
    
    interface Marker {
      index: number;
      type: 'start' | 'end';
      featureId: string;
      featureType: 'annotation' | 'grounding';
      priority: number; // Length of quote to prioritize longer matches
    }

    const markers: Marker[] = [];

    // 1. Map Annotations using Robust Finder
    annotations.forEach(ann => {
       const range = findQuoteInText(content, ann.quote);
       if (range) {
         markers.push({ index: range.start, type: 'start', featureId: ann.id, featureType: 'annotation', priority: ann.quote.length });
         markers.push({ index: range.end, type: 'end', featureId: ann.id, featureType: 'annotation', priority: ann.quote.length });
       }
    });

    // 2. Map Grounding using Robust Finder
    if (showGroundingHighlights) {
        groundingEntries.forEach(g => {
            const range = findQuoteInText(content, g.quote);
            if (range) {
                 markers.push({ index: range.start, type: 'start', featureId: g.id, featureType: 'grounding', priority: g.quote.length });
                 markers.push({ index: range.end, type: 'end', featureId: g.id, featureType: 'grounding', priority: g.quote.length });
            }
        });
    }

    // 3. Sort Markers
    markers.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        return 0; 
    });

    const segments: React.ReactNode[] = [];
    
    // Filter duplicate indices to create unique slice points
    const slicePoints = Array.from(new Set(markers.map(m => m.index))).sort((a,b) => a - b);
    
    // Add start 0 and end length if not present
    if (slicePoints.length === 0 || slicePoints[0] !== 0) slicePoints.unshift(0);
    if (slicePoints[slicePoints.length - 1] !== content.length) slicePoints.push(content.length);

    for (let i = 0; i < slicePoints.length - 1; i++) {
        const start = slicePoints[i];
        const end = slicePoints[i+1];
        const textSegment = content.substring(start, end);
        
        if (!textSegment) continue;

        // Determine active features for this segment
        // Robust check: Does this specific segment fall INSIDE the range of any annotation?
        const coveringAnnos = annotations.filter(a => {
            const range = findQuoteInText(content, a.quote);
            return range && range.start <= start && range.end >= end;
        });

        const coveringGrounding = showGroundingHighlights ? groundingEntries.filter(g => {
             const range = findQuoteInText(content, g.quote);
             return range && range.start <= start && range.end >= end;
        }) : [];

        // Render Segment
        let classes = "";
        let handlers: any = {};
        let title = "";
        let dataAttrs: any = {};

        // Apply Annotation Styles (Backgrounds)
        if (coveringAnnos.length > 0) {
            // Sort by length to put smallest (most specific) on top if needed, 
            // though CSS stacking without nesting elements is hard. 
            // We just take the first one or the active one.
            
            // Prioritize active annotation
            let topAnno = coveringAnnos.find(a => a.id === activeAnnotationId) || coveringAnnos[0];
            
            const isActive = topAnno.id === activeAnnotationId;
            const isRefuted = topAnno.refutations.length > 0;

            if (isRefuted) {
               classes += isActive ? 'bg-zinc-600 text-white ' : 'bg-zinc-800 text-zinc-500 line-through decoration-zinc-500 ';
            } else {
                const level = topAnno.level.toLowerCase();
                if (level.includes('consistency-source')) classes += 'bg-emerald-900/60 text-emerald-100 border border-emerald-800/40 ';
                else if (level.includes('consistency-addition')) classes += 'bg-orange-900/60 text-orange-100 border border-orange-800/40 ';
                else if (level.includes('consistency-diff')) classes += 'bg-red-900/60 text-red-100 border border-red-800/40 ';
                else if (level.includes('grounding')) classes += 'bg-green-900/40 text-green-100 ';
                else if (level.includes('historical')) classes += 'bg-amber-900/40 text-amber-100 ';
                else if (level.includes('story')) classes += 'bg-purple-900/40 text-purple-100 ';
                else classes += 'bg-blue-900/40 text-blue-100 ';
            }
            
            if (isActive) classes += 'ring-2 ring-venice-gold z-10 relative rounded-sm ';
            else classes += 'hover:opacity-100 cursor-pointer ';
            
            handlers.onClick = (e: any) => {
                e.stopPropagation();
                onSelectAnnotation(topAnno.id);
            };
            dataAttrs['data-annotation-id'] = topAnno.id; // Identifier for auto-scrolling
            title += `[${topAnno.level}] ${topAnno.comment}\n`;
            if (topAnno.relatedVariant || topAnno.relatedQuote || topAnno.sourceQuote) {
              const refText = topAnno.relatedQuote || topAnno.sourceQuote || '';
              const refLabel = topAnno.relatedVariant
                ? `Ref ${topAnno.relatedVariant}`
                : 'Ref original event';
              title += `${refLabel}: ${refText}\n`;
            }
        }

        // Apply Grounding Styles (Underlines / Borders)
        if (coveringGrounding.length > 0) {
            let topGround = coveringGrounding.find(g => g.id === activeGroundingId) || coveringGrounding[0];
            const isGroundActive = topGround.id === activeGroundingId;
            
            // Use CSS border-bottom for grounding to coexist with background color of annotations
            classes += "border-b-2 border-cyan-500/70 ";
            if (isGroundActive) {
                classes += "bg-cyan-900/30 shadow-[0_0_8px_rgba(6,182,212,0.3)] text-cyan-50 "; // Add tint if selected
            }
            
            if (!handlers.onClick && onSelectGrounding) {
                classes += "cursor-pointer ";
                handlers.onClick = (e: any) => {
                    e.stopPropagation();
                    onSelectGrounding(topGround.id);
                };
            }
             title += `[Source: ${topGround.resourceName}] ${topGround.resourceQuote}\n`;
        }

        segments.push(
            <span 
                key={`${start}-${end}`} 
                className={classes} 
                title={title}
                {...handlers}
                {...dataAttrs}
            >
                {textSegment}
            </span>
        );
    }

    return segments;
  }, [content, annotations, groundingEntries, activeAnnotationId, activeGroundingId, showGroundingHighlights]);

  return (
    <div 
      ref={containerRef}
      className="prose-research font-serif text-lg text-[#d4d4d8] leading-loose max-w-none selection:bg-venice-gold selection:text-black whitespace-pre-wrap"
      onMouseUp={handleMouseUp}
    >
      {isDiffMode && parentContent ? renderDiff : renderContent}
    </div>
  );
};
