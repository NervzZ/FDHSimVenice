

import React, { useMemo, useState } from 'react';
import { DocumentVersion, GenerationMethod, EvaluationCategory, ScoreMap, Annotation } from '../types';
import { GitCommit, BarChart2, Activity, Layers, Filter, TrendingUp } from 'lucide-react';

interface Props {
  documents: DocumentVersion[];
  categories: EvaluationCategory[];
  onSelectDoc: (id: string) => void;
  currentDocId: string | null;
}

export const AnalysisDashboard: React.FC<Props> = ({ documents, categories, onSelectDoc, currentDocId }) => {
  const [view, setView] = useState<'graph' | 'stats'>('graph');
  const [filterMethod, setFilterMethod] = useState<string>('all');

  // --- HELPERS ---
  
  const getMethodColor = (m: GenerationMethod) => {
    switch (m) {
      case GenerationMethod.REFINE_LOOP: return '#d4af37'; // Gold
      case GenerationMethod.STEP_BY_STEP: return '#3b82f6'; // Blue
      default: return '#71717a'; // Zinc
    }
  };

  const calculateAvgScore = (doc: DocumentVersion) => {
    let total = 0;
    let count = 0;
    Object.values(doc.scores).forEach(catScores => {
        Object.values(catScores).forEach(score => {
            total += score;
            count++;
        });
    });
    return count > 0 ? Math.round(total / count) : 0;
  };

  // --- GRAPH DATA PREP ---

  const graphData = useMemo(() => {
    // 1. Determine Depth (Generation #) and Parentage
    const nodes: (DocumentVersion & { depth: number, x: number, y: number })[] = [];
    const edges: { from: string, to: string }[] = [];

    // Sort by time to ensure parents processed first usually
    const sortedDocs = [...documents].sort((a, b) => a.timestamp - b.timestamp);
    
    const idToDepth: Record<string, number> = {};
    const depthCounts: Record<number, number> = {};

    sortedDocs.forEach(doc => {
        const parentDepth = doc.parentId ? (idToDepth[doc.parentId] ?? -1) : -1;
        const myDepth = parentDepth + 1;
        idToDepth[doc.id] = myDepth;
        
        if (!depthCounts[myDepth]) depthCounts[myDepth] = 0;
        
        nodes.push({
            ...doc,
            depth: myDepth,
            x: 50 + (myDepth * 150),
            y: 50 + (depthCounts[myDepth] * 80)
        });
        
        depthCounts[myDepth]++;

        if (doc.parentId) {
            edges.push({ from: doc.parentId, to: doc.id });
        }
    });

    // Center vertically based on max height in column
    const maxRows = Math.max(...Object.values(depthCounts));
    nodes.forEach(n => {
        // Simple adjustment to center sparse columns
        const siblingsInCol = depthCounts[n.depth];
        const offset = ((maxRows - siblingsInCol) * 80) / 2;
        n.y += offset;
    });

    return { nodes, edges, width: Math.max(800, (Math.max(...Object.keys(depthCounts).map(Number)) + 1) * 180), height: Math.max(600, maxRows * 100) };
  }, [documents]);

  // --- STATS DATA PREP ---

  const statsData = useMemo(() => {
    const methods = [GenerationMethod.STANDARD, GenerationMethod.STEP_BY_STEP, GenerationMethod.REFINE_LOOP];
    
    return methods.map(method => {
        const docs = documents.filter(d => d.method === method);
        if (docs.length === 0) return null;

        // Avg Grade
        const avgGrades = docs.map(calculateAvgScore);
        const overallAvg = Math.round(avgGrades.reduce((a, b) => a + b, 0) / docs.length);

        // Feedback Density (Annotations per 100 words)
        // Approx word count = length / 5
        let totalDensity = 0;
        let totalGroundingRatio = 0;
        let totalVolatility = 0;
        let volatilityCount = 0;
        
        docs.forEach(d => {
            const wordCount = d.content.split(/\s+/).length;
            const density = wordCount > 0 ? (d.annotations.length / wordCount) * 100 : 0;
            totalDensity += density;

            const groundingCount = d.annotations.filter(a => a.level.toLowerCase().includes('grounding') || a.sourceId).length;
            const ratio = d.annotations.length > 0 ? (groundingCount / d.annotations.length) * 100 : 0;
            totalGroundingRatio += ratio;

            if (d.diffStats) {
                totalVolatility += d.diffStats.changeRatio;
                volatilityCount++;
            }
        });

        return {
            method,
            count: docs.length,
            avgScore: overallAvg,
            avgDensity: (totalDensity / docs.length).toFixed(1),
            groundingRatio: Math.round(totalGroundingRatio / docs.length),
            volatility: volatilityCount > 0 ? (totalVolatility / volatilityCount * 100).toFixed(1) : '0.0'
        };
    }).filter(Boolean) as { method: GenerationMethod, count: number, avgScore: number, avgDensity: string, groundingRatio: number, volatility: string }[];
  }, [documents]);


  // --- RENDER ---

  return (
    <div className="flex flex-col h-full bg-[#09090b] text-zinc-200 overflow-hidden">
        {/* Toolbar */}
        <div className="h-14 border-b border-zinc-800 flex items-center justify-between px-6 shrink-0 bg-[#0c0c0e]">
            <div className="flex gap-4">
                <button 
                    onClick={() => setView('graph')}
                    className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider px-3 py-2 rounded transition-colors ${view === 'graph' ? 'text-venice-gold bg-venice-gold/10' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    <GitCommit size={16}/> Genealogy Graph
                </button>
                <button 
                    onClick={() => setView('stats')}
                    className={`flex items-center gap-2 text-xs font-bold uppercase tracking-wider px-3 py-2 rounded transition-colors ${view === 'stats' ? 'text-venice-gold bg-venice-gold/10' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    <BarChart2 size={16}/> Project Statistics
                </button>
            </div>
            <div className="flex items-center gap-2">
                <Filter size={14} className="text-zinc-500"/>
                <select 
                    className="bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 rounded p-1 outline-none"
                    value={filterMethod}
                    onChange={(e) => setFilterMethod(e.target.value)}
                >
                    <option value="all">All Methods</option>
                    {Object.values(GenerationMethod).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
            </div>
        </div>

        <div className="flex-1 overflow-auto p-6 relative">
            
            {/* GRAPH VIEW */}
            {view === 'graph' && (
                <div className="min-w-full min-h-full flex items-center justify-center">
                    {documents.length === 0 ? (
                        <div className="text-zinc-600 italic">No documents to visualize.</div>
                    ) : (
                        <svg width={graphData.width + 100} height={graphData.height + 100} className="overflow-visible">
                            <defs>
                                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                                    <polygon points="0 0, 10 3.5, 0 7" fill="#52525b" />
                                </marker>
                            </defs>
                            
                            {/* Edges */}
                            {graphData.edges.map((e, i) => {
                                const fromNode = graphData.nodes.find(n => n.id === e.from);
                                const toNode = graphData.nodes.find(n => n.id === e.to);
                                if (!fromNode || !toNode) return null;
                                // Apply filter logic to dim edges
                                const dim = filterMethod !== 'all' && (fromNode.method !== filterMethod && toNode.method !== filterMethod);
                                
                                return (
                                    <path 
                                        key={i} 
                                        d={`M ${fromNode.x} ${fromNode.y} C ${fromNode.x + 70} ${fromNode.y}, ${toNode.x - 70} ${toNode.y}, ${toNode.x} ${toNode.y}`}
                                        fill="none"
                                        stroke={dim ? "#3f3f46" : "#71717a"}
                                        strokeWidth={dim ? 1 : 2}
                                        markerEnd="url(#arrowhead)"
                                        className="transition-all duration-500"
                                    />
                                );
                            })}

                            {/* Nodes */}
                            {graphData.nodes.map(node => {
                                const isSelected = node.id === currentDocId;
                                const isHidden = filterMethod !== 'all' && node.method !== filterMethod;
                                const score = calculateAvgScore(node);
                                const radius = 20 + (score / 10); // Size based on score
                                
                                return (
                                    <g 
                                        key={node.id} 
                                        transform={`translate(${node.x}, ${node.y})`}
                                        onClick={() => onSelectDoc(node.id)}
                                        className={`cursor-pointer transition-all duration-300 ${isHidden ? 'opacity-20' : 'opacity-100 hover:opacity-90'}`}
                                    >
                                        <circle 
                                            r={radius} 
                                            fill={isSelected ? '#000' : '#18181b'}
                                            stroke={getMethodColor(node.method)}
                                            strokeWidth={isSelected ? 3 : 2}
                                            className="transition-all"
                                        />
                                        {/* Score Badge */}
                                        <text 
                                            textAnchor="middle" 
                                            dy="4" 
                                            className="text-[10px] font-bold font-mono fill-zinc-300 pointer-events-none"
                                        >
                                            {score}
                                        </text>
                                        
                                        {/* Tooltip-ish Label */}
                                        <foreignObject x={-60} y={radius + 5} width={120} height={50}>
                                            <div className="text-center">
                                                <div className="text-[8px] font-bold text-zinc-400 uppercase truncate bg-black/60 rounded px-1">
                                                    {node.modelId.replace('gemini-', '').split('-')[0]}
                                                </div>
                                                <div className="text-[8px] text-zinc-500 truncate">
                                                    {new Date(node.timestamp).toLocaleTimeString()}
                                                </div>
                                                {node.diffStats && (
                                                     <div className="text-[7px] font-mono text-venice-gold mt-0.5 bg-black/80 rounded inline-block px-1 border border-venice-gold/30">
                                                        ~{Math.round(node.diffStats.changeRatio * 100)}%
                                                     </div>
                                                )}
                                            </div>
                                        </foreignObject>
                                    </g>
                                );
                            })}
                        </svg>
                    )}
                </div>
            )}

            {/* STATS VIEW */}
            {view === 'stats' && (
                <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
                    
                    {/* Chart 1: Average Scores */}
                    <div className="bg-zinc-900/50 p-6 rounded border border-zinc-800">
                        <h3 className="text-sm font-bold uppercase text-zinc-400 mb-6 flex items-center gap-2"><Activity size={16}/> Performance by Method</h3>
                        <div className="space-y-6">
                            {statsData.map(stat => (
                                <div key={stat.method} className="relative">
                                    <div className="flex justify-between text-xs mb-1">
                                        <span className="font-bold text-zinc-300">{stat.method}</span>
                                        <span className="font-mono text-venice-gold">{stat.avgScore}/100</span>
                                    </div>
                                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                        <div 
                                            className="h-full rounded-full transition-all duration-1000 ease-out"
                                            style={{ 
                                                width: `${stat.avgScore}%`, 
                                                backgroundColor: getMethodColor(stat.method) 
                                            }}
                                        />
                                    </div>
                                    <div className="text-[9px] text-zinc-600 mt-1 text-right">Based on {stat.count} runs</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Chart 2: Grounding & Density */}
                    <div className="bg-zinc-900/50 p-6 rounded border border-zinc-800">
                        <h3 className="text-sm font-bold uppercase text-zinc-400 mb-6 flex items-center gap-2"><Layers size={16}/> Annotation Analysis</h3>
                        <div className="flex items-end gap-4 h-48 border-b border-zinc-700 pb-2 px-4">
                            {statsData.map(stat => (
                                <div key={stat.method} className="flex-1 flex flex-col justify-end items-center gap-2 h-full group">
                                    <div className="relative w-full flex gap-1 justify-center h-full items-end">
                                        {/* Density Bar */}
                                        <div 
                                            className="w-4 bg-zinc-600 rounded-t transition-all hover:bg-zinc-500"
                                            style={{ height: `${Math.min(Number(stat.avgDensity) * 10, 100)}%` }}
                                            title={`Density: ${stat.avgDensity} annotations / 100 words`}
                                        />
                                        {/* Grounding Bar */}
                                        <div 
                                            className="w-4 bg-green-800 rounded-t transition-all hover:bg-green-600"
                                            style={{ height: `${stat.groundingRatio}%` }}
                                            title={`Grounding Ratio: ${stat.groundingRatio}%`}
                                        />
                                    </div>
                                    <span className="text-[9px] text-zinc-500 uppercase font-bold truncate w-full text-center">
                                        {stat.method.split(' ')[0]}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-4 justify-center mt-4">
                            <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                                <div className="w-3 h-3 bg-zinc-600 rounded-sm"></div> Annotation Density
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                                <div className="w-3 h-3 bg-green-800 rounded-sm"></div> Grounding Ratio
                            </div>
                        </div>
                    </div>

                    {/* Chart 3: Volatility (Diff Stats) */}
                    <div className="bg-zinc-900/50 p-6 rounded border border-zinc-800 md:col-span-2">
                         <h3 className="text-sm font-bold uppercase text-zinc-400 mb-6 flex items-center gap-2"><TrendingUp size={16}/> Volatility & Change Ratio</h3>
                         <div className="grid grid-cols-3 gap-4">
                            {statsData.map(stat => (
                                <div key={stat.method} className="bg-black/40 p-4 rounded border border-zinc-800 flex flex-col items-center justify-center">
                                    <div className="text-3xl font-mono font-bold text-white mb-1">{stat.volatility}%</div>
                                    <div className="text-[9px] uppercase text-zinc-500 tracking-widest mb-2 text-center">{stat.method.split(' ')[0]} Volatility</div>
                                    <div className="w-full h-1 bg-zinc-800 rounded-full">
                                        <div 
                                            className="h-full bg-purple-500 rounded-full" 
                                            style={{width: `${Math.min(Number(stat.volatility), 100)}%`}}
                                        />
                                    </div>
                                    <p className="text-[9px] text-zinc-600 mt-2 text-center">Avg content rewrite percentage per step</p>
                                </div>
                            ))}
                         </div>
                    </div>

                    {/* Summary Cards */}
                    <div className="col-span-1 md:col-span-2 grid grid-cols-4 gap-4">
                         <div className="bg-black/40 p-4 rounded border border-zinc-800 text-center">
                             <div className="text-2xl font-mono font-bold text-white">{documents.length}</div>
                             <div className="text-[9px] uppercase text-zinc-500 tracking-widest">Total Documents</div>
                         </div>
                         <div className="bg-black/40 p-4 rounded border border-zinc-800 text-center">
                             <div className="text-2xl font-mono font-bold text-venice-gold">
                                 {documents.reduce((acc, d) => acc + d.annotations.length, 0)}
                             </div>
                             <div className="text-[9px] uppercase text-zinc-500 tracking-widest">Total Annotations</div>
                         </div>
                         <div className="bg-black/40 p-4 rounded border border-zinc-800 text-center">
                             <div className="text-2xl font-mono font-bold text-blue-400">
                                 {documents.filter(d => d.thoughts && d.thoughts.length > 0).length}
                             </div>
                             <div className="text-[9px] uppercase text-zinc-500 tracking-widest">Reasoning Chains</div>
                         </div>
                         <div className="bg-black/40 p-4 rounded border border-zinc-800 text-center">
                             <div className="text-2xl font-mono font-bold text-green-500">
                                 {Math.round(documents.reduce((acc, d) => acc + calculateAvgScore(d), 0) / (documents.length || 1))}
                             </div>
                             <div className="text-[9px] uppercase text-zinc-500 tracking-widest">Project Average</div>
                         </div>
                    </div>
                </div>
            )}
        </div>
    </div>
  );
};
