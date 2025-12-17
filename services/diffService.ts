
import { diffWords } from 'diff';
import { DiffStats } from '../types';

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export const calculateDiff = (oldText: string, newText: string): DiffPart[] => {
  if (!oldText && !newText) return [];
  if (!oldText) return [{ value: newText, added: true }];
  if (!newText) return [{ value: oldText, removed: true }];
  
  // Normalize line endings for better comparison
  const nOld = oldText.replace(/\r\n/g, '\n');
  const nNew = newText.replace(/\r\n/g, '\n');
  
  return diffWords(nOld, nNew);
};

export const calculateDiffStats = (oldText: string, newText: string): DiffStats => {
  const parts = calculateDiff(oldText, newText);
  let additions = 0;
  let deletions = 0;
  let addedLength = 0;
  let removedLength = 0;

  parts.forEach(part => {
    if (part.added) {
        additions++;
        addedLength += part.value.length;
    } else if (part.removed) {
        deletions++;
        removedLength += part.value.length;
    }
  });

  const totalLen = newText.length || 1;
  const changeRatio = (addedLength + removedLength) / totalLen;

  return {
    additions,
    deletions,
    addedLength,
    removedLength,
    changeRatio: parseFloat(changeRatio.toFixed(4))
  };
};
