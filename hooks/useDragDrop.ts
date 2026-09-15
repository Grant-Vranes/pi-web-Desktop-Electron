"use client";

import { useState, useCallback, useRef } from "react";
import { buildDropPayload, type DropPayload } from "@/lib/dropped-paths";

// Matches lib/dropped-paths.ts so an internal file-explorer drag keeps the
// drop zone active before the drop event fires.
const INTERNAL_FILE_DRAG_TYPE = "application/x-pi-web-file-path";

export function useDragDrop(onDrop: (payload: DropPayload) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  // Quick type-list check used by dragEnter/dragOver so local (non-filesystem)
  // drags do not flash the drop zone. Anything the payload classifier accepts
  // must land here too, including internal file-explorer @mention drags.
  const acceptsDropTypes = useCallback((types: readonly string[]): boolean => {
    return types.includes("Files") || types.includes(INTERNAL_FILE_DRAG_TYPE);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!acceptsDropTypes(e.dataTransfer.types)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, [acceptsDropTypes]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!acceptsDropTypes(e.dataTransfer.types)) return;
    e.preventDefault();
  }, [acceptsDropTypes]);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const payload = buildDropPayload(e.dataTransfer);
    if (payload.imageFiles.length === 0 && !payload.hasNonImageFiles) return;
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    onDrop(payload);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}