"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export function usePanelResize() {
  const [treeWidth, setTreeWidth] = useState(320);
  const [chatWidth, setChatWidth] = useState(640);
  const [isResizing, setIsResizing] = useState(false);
  const dragging = useRef<"tree" | "chat" | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const startDrag = useCallback(
    (panel: "tree" | "chat") => (e: ReactMouseEvent) => {
      e.preventDefault();
      dragging.current = panel;
      dragStartX.current = e.clientX;
      dragStartWidth.current = panel === "tree" ? treeWidth : chatWidth;
      setIsResizing(true);
    },
    [treeWidth, chatWidth]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - dragStartX.current;
      if (dragging.current === "tree") {
        setTreeWidth(Math.max(150, Math.min(480, dragStartWidth.current + delta)));
      } else {
        setChatWidth(Math.max(280, Math.min(720, dragStartWidth.current - delta)));
      }
    };
    const onUp = () => {
      dragging.current = null;
      setIsResizing(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  return { treeWidth, chatWidth, isResizing, startDrag };
}
